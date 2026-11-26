/**
 * Session Compaction Module
 * Session自动摘要模块 - 定期压缩会话历史，减少token消耗
 */

const crypto = require('crypto');

// 摘要正文封顶 (字符)。单一真源: 折进 summary 时 slice、随摘要对象带给下游、
// 以及连续多轮压缩时靠它判断摘要有没有失控增长, 都读这一个数。
const SUMMARY_CAP = 60000;

// 压缩产物里保留多少条注入的系统提示。去重只压得住**逐字相同**的那些, 而盘古注入的
// 续跑/熔断提示每轮带不同计数 (#1/#2/#3), 去重压不住 → 逐轮累积 (实测 47→62→66)。
// 头几条是身份/角色/环境规则 (注入在 messages 头部), 末尾几条是最新一轮的控制指令,
// 中间的都已服务完自己那一轮。
const MAX_KEPT_SYSTEM_MESSAGES = 8;
const KEEP_SYSTEM_HEAD = 2;
const KEEP_SYSTEM_TAIL = 6;

// 默认配置
// 2026-09-17 全修: PANGU_COMPACT_MSG_THRESHOLD / PANGU_COMPACT_TOK_THRESHOLD 环境变量进默认配置
// 老板 plist 120000 是 launchd env, 但 module 直接 require 时 (测试/CLI) 拿不到 — 默认值兜底跟 plist 对齐
const DEFAULT_CONFIG = {
  // 触发压缩的消息数量阈值 (plist: PANGU_COMPACT_MSG_THRESHOLD=90)
  messageThreshold: Number(process.env.PANGU_COMPACT_MSG_THRESHOLD) || 90,

  // 触发压缩的 token 数阈值 (plist: PANGU_COMPACT_TOK_THRESHOLD=120000)
  tokenThreshold: Number(process.env.PANGU_COMPACT_TOK_THRESHOLD) || 120000,

  // 触发压缩的时间阈值 (毫秒), 0 表示不启用 — 2026-08-30 §0.33: 默认 10min, 不再 0 关闭
  timeThreshold: 10 * 60 * 1000,

  // §0.33: 空闲自动压缩 — session 超过此 ms 没新 round, 后台 watchdog 强制压缩
  idleCompactMs: 15 * 60 * 1000,
  
  // 摘要生成策略: 'latest' | 'full' | 'smart'
  strategy: 'smart',
  
  // 摘要保留的消息比例 (0-1)
  retentionRatio: 0.3,
  
  // 最大保留消息数
  maxRetainedMessages: 20,
  
  // 是否保留系统消息
  keepSystemMessages: true,
  
  // 是否在压缩前调用回调
  beforeCompact: null,
  
  // 是否在压缩后调用回调
  afterCompact: null
};

// 2026-10-13: 压缩丢证据。真实子会话里 tool 正文 4295 字符 + 工具调用参数 2807 字符,
// 而旧 createPageSummary 对每条 tool 只写 `T: <工具名>` (≈12 字符), assistant 那批 tool_calls
// 因为 content 是空串直接被 continue 掉 —— 每次压缩蒸发 98.6% 的干活证据。
// 模型压缩完只知道「我调过 write_file」, 不知道 b1.txt 里写的是 b1 还是 b, 续跑只能重做。
//
// 头尾都留: 工具输出的结论 (exit code / 报错 / 命中行) 经常在**末尾**, 只截头会把结论切掉。
function _headTailText(s, cap) {
  const t = String(s == null ? '' : s);
  if (cap <= 0) return '';
  if (t.length <= cap) return t;
  const headLen = Math.ceil(cap * 0.6);
  const tailLen = Math.max(0, cap - headLen);
  const gap = t.length - headLen - tailLen;
  return t.slice(0, headLen) + '…[省略 ' + gap + ' 字]…' + (tailLen ? t.slice(t.length - tailLen) : '');
}

// 把一条消息折成 {full, short} 两种预算下的摘要行。
// short 是保底版 (每条先拿到一点, 免得整段消息直接蒸发), full 是加码版。
function _foldEntry(m, caps) {
  if (!m || typeof m !== 'object') return null;
  const role = m.role;
  if (role === 'user') {
    const t = String(m.content || '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return { full: 'Q: ' + _headTailText(t, caps.q), short: 'Q: ' + t.slice(0, caps.floor) };
  }
  if (role === 'assistant') {
    const parts = [];
    const t = String(m.content || '').replace(/\s+/g, ' ').trim();
    if (t) parts.push('A: ' + _headTailText(t, caps.a));
    // 工具调用参数必须留 —— 模型压缩后最需要知道的是「我刚跑的是什么命令」。
    // 旧代码这里因为 content 是空串而整条 continue, 参数一个都不剩。
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    for (const tc of calls.slice(0, caps.maxCalls)) {
      const fn = (tc && tc.function) || {};
      const name = String(fn.name || '?');
      const args = String(fn.arguments || '').replace(/\s+/g, ' ').trim();
      parts.push('→ ' + name + (args ? '(' + _headTailText(args, caps.args) + ')' : '()'));
    }
    if (!parts.length) return null;
    const full = parts.join(' ');
    return { full, short: full.slice(0, caps.floor) };
  }
  if (role === 'tool') {
    const name = String(m.tool_name || m.name || '?');
    const body = String(m.content || '').replace(/\s+/g, ' ').trim();
    if (!body) return { full: 'T(' + name + '): (空)', short: 'T(' + name + ')' };
    return {
      full: 'T(' + name + '): ' + _headTailText(body, caps.tool),
      short: 'T(' + name + '): ' + body.slice(0, caps.floor),
    };
  }
  return null;
}

class SessionCompaction {
  constructor(options = {}) {
    this.config = { ...DEFAULT_CONFIG, ...options };
    this.sessions = new Map();
  }

  /**
   * 估算消息数组的 token 数 (粗估: chars / 4, 跟 LLM tokenizer 接近)
   * R49 小修 7/27 11:30: 让 shouldCompact 看 token 数, 不只 messageCount
   */
  _estimateTokens(messages) {
    if (!Array.isArray(messages)) return 0;
    let total = 0;
    for (const m of messages) {
      if (m && typeof m.content === 'string') total += m.content.length;
      else if (m && Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part.text === 'string') total += part.text.length;
        }
      }
    }
    return Math.ceil(total / 4);
  }

  /**
   * 注册或更新会话
   * @param {string} sessionId - 会话ID
   * @param {Array} messages - 消息数组
   */
  register(sessionId, messages = []) {
    // P0-#6 修 (verify-2026-07-25): 保留 lastCompact / compactCount
    // 原因: 每 round 都 register, 老代码硬写 lastCompact: Date.now() + compactCount: 0
    //       → shouldCompact() 的 timePassed 永远 false, compactCount 永远 0
    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      messages: [...messages],
      lastCompact: existing ? existing.lastCompact : Date.now(),
      compactCount: existing ? existing.compactCount : 0,
      totalMessages: messages.length,
      tokenCount: this._estimateTokens(messages),
    });
  }

  /**
   * 获取会话当前状态
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId) {
    return this.sessions.delete(sessionId);
  }

  /**
   * 添加消息到会话
   */
  addMessage(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.register(sessionId, [message]);
      return;
    }
    session.messages.push(message);
    session.totalMessages++;
    session.tokenCount = this._estimateTokens(session.messages);
  }

  /**
   * 检查是否需要压缩
   * §0.34 (2026-08-30): 支持按 model context_length 动态算 token 阈值
   * @param {string} sessionId
   * @param {Object} [opts]
   * @param {number} [opts.modelContextLength] - 当前模型 context window (e.g. 65536 / 524288 / 1048576)
   * @param {number} [opts.tokenRatio=0.6]      - 阈值 = context × ratio (默认 60%)
   */
  shouldCompact(sessionId, opts = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const { messageThreshold, tokenThreshold, timeThreshold } = this.config;
    const messageCount = session.messages.length;
    const tokenCount = session.tokenCount || this._estimateTokens(session.messages);
    const timePassed = timeThreshold > 0
      ? Date.now() - session.lastCompact > timeThreshold
      : false;

    // §0.34: 按 model context_length × ratio 动态算阈值
    //   大模型 (1M ctx, ratio 0.6) → 600K tokens 触发, 充分利用 context
    //   小模型 (8K ctx, ratio 0.6)  → 5K tokens 触发, 及时压缩防溢出
    //   不再加绝对下限 (修小模型被 50K 拖死的 bug)
    let effectiveTokenTh = tokenThreshold;
    if (opts.modelContextLength && Number.isFinite(opts.modelContextLength)) {
      // 2026-09-16 老板拍: 默认 ratio 0.6 → 0.3, 不写死绝对预算, 按窗口动态算
      const ratio = Number.isFinite(opts.tokenRatio) ? opts.tokenRatio : 0.8;  // 2026-09-17 老板拍: 只在 ~80% 才压, 不主动 30% 早压
      effectiveTokenTh = Math.max(1000, Math.floor(opts.modelContextLength * ratio));
    }
    return messageCount >= messageThreshold || tokenCount >= effectiveTokenTh || timePassed;
  }

  /**
   * 执行会话压缩
   * 2026-09-16 老板拍: ratio 0.3 之后, 阈值 = 窗口×0.3 (M3 1M → 288K)。
   * 但 1M 窗口会话的真实消息数远超 20 条 — 单页摘要会漏掉中间 90% 内容, 下轮 auto-resume 再塞回 = 越压越胖。
   * 修: 多页摘要 — 超出保留窗口的消息按页 (PAGE=60 条) 生成摘要, 旧页摘要滚动合并成新摘要, 不丢内容。
   */
  async compact(sessionId, customSummary = null, opts = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // 调用压缩前回调
    if (this.config.beforeCompact) {
      await this.config.beforeCompact(sessionId, session.messages);
    }

    // 2026-09-16: 多页摘要 — 旧摘要 + 旧消息页 → 新摘要 (滚动合并, 不膨胀)
    const PAGE = 60;
    const KEEP = 20;
    const nonSys = session.messages.filter(m => m.role !== 'system' || !m.isCompactionSummary);
    if (nonSys.length > KEEP + PAGE) {
      const head = session.messages.filter(m => m.isCompactionSummary)[0];
      // 2026-10-13 现场: head.content 是 `【会话摘要】${JSON.stringify(summary)}`。旧代码把它
      // 整条当**文本**折进新摘要的 summary 字段, 于是新摘要里嵌着整份旧摘要的 JSON,
      // 下一轮再嵌一层, JSON 转义的反斜杠还一轮翻一倍 —— 线上落盘 compaction_summary
      // 119392 字符, 而 _summaryCap 字段明明写着 60000 (全代码库没有任何地方读它)。
      // 这里剥掉外壳取内层 summary 正文当纯文本折进来, 摘要就不会自己套自己。
      let oldSummary = head ? String(head.content || '') : '';
      if (/^【会话摘要】/.test(oldSummary)) {
        try {
          const _prev = JSON.parse(oldSummary.replace(/^【会话摘要】/, ''));
          if (_prev && typeof _prev.summary === 'string') oldSummary = _prev.summary;
        } catch (_) { /* 不是合法 JSON 就按原样折进去 */ }
      }
      const toFold = session.messages.slice(0, session.messages.length - KEEP);
      let pageSummaries = oldSummary ? [oldSummary] : [];
      for (let i = 0; i < toFold.length; i += PAGE) {
        pageSummaries.push(this.createPageSummary(toFold.slice(i, i + PAGE)));
      }
      const merged = pageSummaries.join('\n\n');
      if (merged.trim()) {
        customSummary = {
          type: 'fold',
          timestamp: Date.now(),
          summary: merged.slice(0, SUMMARY_CAP),
          // 上限真被读: 旧代码把 60000 写进 _summaryCap 然后**谁也不读**, 封顶形同虚设。
          _summaryCap: SUMMARY_CAP,
          folded_count: toFold.length,
          // 2026-09-16 二期: fold 摘要已含旧内容 → 不再保留 20 条旧消息 (保留=重复, 越压越胖的根因)
          foldKeepRecent: false,
        };
        console.log('[session-compaction] ' + sessionId + ': multi-page fold ' + toFold.length + ' msgs → summary ' + merged.length + ' chars');
      }
    }

    // 2026-10-13: 旧摘要是**压缩产物, 不是会话内容**。上面 fold 分支已经把它读出来折进
    // 新摘要了; 再把整条原样喂回 generateSummary, 等于让新摘要再套一层旧摘要的 JSON。
    // 两个 generate* 调用点都要用这份滤过的输入。
    const _contentMessages = session.messages.filter(m => !m.isCompactionSummary);

    let summary;
    if (customSummary) {
      // 使用提供的摘要
      summary = customSummary;
    } else {
      // 根据策略生成摘要
      summary = this.generateSummary(_contentMessages);
    }

    // 根据摘要构建压缩后的消息
    // 索引必须和 generateSmartSummary 收到的是**同一份数组**, 否则 importantMessages.idx
    // 整体错位 (实测: 第 2 轮 idx=0 取回旧摘要消息, 一条摘要变两条)。
    let compactedMessages = this.buildCompactedMessages(_contentMessages, summary);

    // 2026-08-02 硬不变量 (老板 20:52 实案: 压缩把当前问题弄丢 → MiniMax 400 'chat content is empty'
    // + LLM 只剩摘要自由发挥 → 问"出图了没"复读八字报告):
    // 压缩结果必须 ①含 ≥1 条非 system 消息 ②保留最近一条 user 消息 (当前问题)。
    // 违反 = 压缩有 bug, 不许带病上岗 — 回退: 摘要 + 最近 10 条原样保留。
    const _nonSystem = compactedMessages.filter(m => m.role !== 'system');
    const _lastUser = [...session.messages].reverse().find(m => m.role === 'user');
    const _lastUserKept = !_lastUser || compactedMessages.some(m => m.role === 'user' && m.content === _lastUser.content);
    if (_nonSystem.length === 0 || !_lastUserKept) {
      console.warn('[session-compaction] INVARIANT VIOLATION nonSystem=' + _nonSystem.length + ' lastUserKept=' + _lastUserKept + ' → 回退保留最近 10 条原样');
      summary = this.generateLatestSummary(_contentMessages);
      compactedMessages = this.buildCompactedMessages(_contentMessages, summary);
    }

    // 2026-10-13 现场 (resume-live-1791875186#sub-0-executor, 探针跑到 18 分钟不收尾):
    //   [j2-auto-resume] compact ...: 16 -> 14 msgs (resume #3/3)
    //   [j2-auto-resume] compact ...: 16 -> 14 msgs (resume #1/3)   ← 计数归零, 重新开始
    //   [j2-auto-resume] compact ...: 16 -> 14 msgs (resume #2/3)
    //   [j2-budget]     force-compact ...: 16 -> 14 msgs
    // 压缩活锁: 产物的下限是「1 条摘要 + ≤8 条注入 system + maxRetainedMessages(20) + 最后一条 user」,
    // **可以大于触发阈值**; 而 shouldCompact 判的是 `messageCount >= messageThreshold`,
    // 于是压完正好卡在阈值上 = 立刻又满足触发条件, 下一轮再压一次, 永远压不下去。
    // 阈值 14 (我为测压缩临时压的) 时数学上必然不收敛; 阈值一旦被调到 ~30 以下就会踩到。
    // 定式: 压缩必须**保证**产物严格小于触发阈值, 而不是「尽量压」。
    compactedMessages = this._clampBelowThreshold(compactedMessages, session.messages);

    // 更新会话
    // 2026-09-14 修: 原逻辑 totalMessages += compacted.length 是 double-count
    // (addMessage 已逐条计, 压缩是把 N 条换成 M 条不是新增) → originalCount 虚高
    const _origCount = session.messages.length;
    session.messages = compactedMessages;
    session.lastCompact = Date.now();
    session.compactCount++;
    session.tokenCount = this._estimateTokens(compactedMessages);

    // 调用压缩后回调
    if (this.config.afterCompact) {
      await this.config.afterCompact(sessionId, compactedMessages, summary);
    }

    return {
      summary,
      compactedMessages,  // TL-6: 加返 compactedMessages (j2_agent_loop 用来替换 messages)
      compactedCount: session.messages.length,
      originalCount: _origCount,
      compactRatio: (session.messages.length / session.totalMessages).toFixed(2),
    };
  }

  /**
   * 根据策略生成摘要
   */
  generateSummary(messages) {
    const { strategy } = this.config;

    switch (strategy) {
      case 'latest':
        return this.generateLatestSummary(messages);
      case 'full':
        return this.generateFullSummary(messages);
      case 'smart':
      default:
        return this.generateSmartSummary(messages);
    }
  }

  /**
   * 只保留最新消息的摘要策略
   */
  generateLatestSummary(messages) {
    const recentMessages = messages.slice(-10);
    // 2026-09-13 (老板 00:30 实案): invariant 回退的壳摘要只有 keyTopics/messageCount 元数据,
    // 零语义内容 — 压缩后模型丢掉已核实事实 (实案: "真素材池在 extracted/" 被丢,
    // 续跑回头信过期 v2 地图的 raw/01~05 幻觉路径, 13 次 ls 全空)。带上文本摘要 +
    // 最近一条 user/assistant 原文片段, 让核实过的事实活过压缩。
    const _lastUserMsg = [...messages].reverse().find(m => m.role === 'user' && m.content);
    const _lastAsstMsg = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
    return {
      type: 'latest',
      timestamp: Date.now(),
      keyTopics: this.extractTopics(recentMessages),
      textSummary: this.createTextSummary(recentMessages),
      lastUser: _lastUserMsg ? this.truncate(String(_lastUserMsg.content), 300) : null,
      lastAssistant: _lastAsstMsg ? this.truncate(_lastAsstMsg.content, 600) : null,
      messageCount: messages.length,
      timeRange: {
        start: messages[0]?.timestamp || null,
        end: messages[messages.length - 1]?.timestamp || null
      }
    };
  }

  /**
   * 完整摘要策略 - 包含所有关键信息
   */
  generateFullSummary(messages) {
    const userMessages = messages.filter(m => m.role === 'user');
    const assistantMessages = messages.filter(m => m.role === 'assistant');
    const systemMessages = messages.filter(m => m.role === 'system');

    return {
      type: 'full',
      timestamp: Date.now(),
      stats: {
        total: messages.length,
        user: userMessages.length,
        assistant: assistantMessages.length,
        system: systemMessages.length
      },
      keyTopics: this.extractTopics(messages),
      keyDecisions: this.extractDecisions(messages),
      importantContext: this.extractImportantContext(messages),
      timeRange: {
        start: messages[0]?.timestamp || null,
        end: messages[messages.length - 1]?.timestamp || null
      }
    };
  }

  /**
   * 2026-09-16: 单页摘要 (无 LLM, 纯提取) — 用于多页滚动压缩, 每页 ≤ 60 条
   * 提取 user 问题全文 + assistant 关键结论 (每轮 ≤300 chars) + tool 调用名 (不存参数/结果)
   */
  // 两遍分配预算 (2026-10-13 重写):
  //   第一遍按时间顺序给每条**保底**额度 —— 免得预算被前面几条吃光, 后面的整段蒸发;
  //   第二遍从**最新往回**加码 —— 离现在越近的越该拿到完整额度。
  // 总量仍受 PAGE_CAP 约束, 所以「留住证据」不等于「体积失控」。
  createPageSummary(pageMessages) {
    const msgs = (Array.isArray(pageMessages) ? pageMessages : []).filter(Boolean);
    if (!msgs.length) return '';
    const PAGE_CAP = 6000;
    const CAPS = { q: 400, a: 300, args: 240, tool: 700, floor: 120, maxCalls: 4 };
    const entries = [];
    for (const m of msgs) {
      const e = _foldEntry(m, CAPS);
      if (e) entries.push(e);
    }
    if (!entries.length) return '';
    const out = [];
    let used = 0;
    for (const e of entries) {
      const fits = (used + e.short.length + 1) <= PAGE_CAP;
      const line = fits ? e.short : '';
      if (fits) used += e.short.length + 1;
      out.push({ full: e.full, line });
    }
    for (let i = out.length - 1; i >= 0; i--) {
      const extra = out[i].full.length - out[i].line.length;
      if (extra <= 0) continue;
      if ((used + extra) > PAGE_CAP) continue;
      out[i].line = out[i].full;
      used += extra;
    }
    return out.map(o => o.line).filter(Boolean).join('\n');
  }

  /**
   * 智能摘要策略 - 平衡信息保留和压缩率
   */
  generateSmartSummary(messages) {
    const { retentionRatio, maxRetainedMessages } = this.config;
    
    // 分析消息重要性
    const scoredMessages = this.scoreMessages(messages);

    // 2026-10-15: 排名池必须**先把 system 消息排除**, 否则保留名额会被注入提示吃光。
    // scoreMessages 给每条 system 固定 +10, 注入块还因超长再 +2 —— 而 user 只有 +3、
    // assistant +2。也就是说盘古注入的 system 提示永远是得分最高的一批, slice(N)
    // 取前 N 名时基本全被它们占满, 真正的对话一条都留不下。
    // 线上实测 (真实 session garfix-1015#sub-0-analyzer): 17 条压完只剩摘要 + user,
    // 6 条 assistant/tool 干活证据全没了 —— 续跑只能重做, 这正是长任务收不了尾的病根。
    // 这些 system 消息并不是被"丢掉", 而是由 buildCompactedMessages 的
    // keepSystemMessages 分支统一去重后保留, 不该在这里再抢一遍名额。
    const _rankPool = this.config.keepSystemMessages
      ? scoredMessages.filter(s => s.message.role !== 'system')
      : scoredMessages;
    
    // 选择最重要的消息
    const importantMessages = _rankPool
      .sort((a, b) => b.importance - a.importance)
      // 2026-08-02 修: 消息少时 length*ratio < 1 → slice(0, 0.x) = 空数组 → 0 保留 → 全 system 400
      .slice(0, Math.max(1, Math.floor(Math.min(messages.length * retentionRatio, maxRetainedMessages))))
      .map(m => m.message);

    return {
      type: 'smart',
      timestamp: Date.now(),
      summary: this.createTextSummary(importantMessages),
      keyTopics: this.extractTopics(importantMessages),
      importantMessages: importantMessages.map(m => ({
        role: m.role,
        preview: this.truncate(m.content, 200),
        idx: messages.indexOf(m),  // 2026-08-02: 用索引做主匹配, preview 字符串匹配只是兜底 (重复/空 preview 会全灭)
        importance: scoredMessages.find(s => s.message === m)?.importance || 0
      })),
      messageCount: messages.length,
      timeRange: {
        start: messages[0]?.timestamp || null,
        end: messages[messages.length - 1]?.timestamp || null
      }
    };
  }

  /**
   * 为消息打分（用于智能摘要）
   */
  scoreMessages(messages) {
    return messages.map((message, index) => {
      let importance = 0;
      
      // 系统消息高优先级
      if (message.role === 'system') {
        importance += 10;
      }
      
      // 用户消息比助手消息更重要
      if (message.role === 'user') {
        importance += 3;
      } else if (message.role === 'assistant') {
        importance += 2;
      }

      // 包含代码的消息
      if (message.content && message.content.includes('```')) {
        importance += 3;
      }

      // 包含决策或结论的消息
      if (message.content && /^(完成|结果|结论|决定|总结)/.test(message.content)) {
        importance += 5;
      }

      // 开头和结尾的消息略微重要
      if (index < 3 || index >= messages.length - 3) {
        importance += 2;
      }

      // 长消息通常更重要
      if (message.content && message.content.length > 500) {
        importance += 2;
      }

      return { message, importance };
    });
  }

  /**
   * 提取主题
   */
  extractTopics(messages) {
    const topics = new Set();
    const topicKeywords = [
      'bug', 'fix', 'feature', 'api', 'database', 'config',
      'error', 'issue', 'problem', 'solution', 'implement',
      'test', 'deploy', 'build', 'update', 'delete', 'create'
    ];

    messages.forEach(msg => {
      if (!msg.content) return;
      const lowerContent = msg.content.toLowerCase();
      topicKeywords.forEach(keyword => {
        if (lowerContent.includes(keyword)) {
          topics.add(keyword);
        }
      });
    });

    return Array.from(topics);
  }

  /**
   * 提取决策
   */
  extractDecisions(messages) {
    const decisions = [];
    const decisionPatterns = [
      /决定(.+)/,
      /选择(.+)/,
      /采用(.+)/,
      /使用(.+)/,
      /安排(.+)/,
      /确认(.+)/
    ];

    messages.forEach(msg => {
      if (!msg.content) return;
      decisionPatterns.forEach(pattern => {
        const match = msg.content.match(pattern);
        if (match) {
          decisions.push(match[0]);
        }
      });
    });

    return decisions.slice(-10); // 保留最近10条决策
  }

  /**
   * 提取重要上下文
   */
  extractImportantContext(messages) {
    const context = [];
    const contextPatterns = [
      /项目[是为]?(.+)/,
      /目标是?(.+)/,
      /需要(.+)/,
      /要求(.+)/,
      /当前(.+)/
    ];

    messages.forEach(msg => {
      if (!msg.content) return;
      contextPatterns.forEach(pattern => {
        const match = msg.content.match(pattern);
        if (match && match[1]) {
          context.push(match[1].trim());
        }
      });
    });

    return [...new Set(context)].slice(-5); // 去重，保留最近5条
  }

  /**
   * 创建文本摘要
   */
  createTextSummary(messages) {
    if (messages.length === 0) return '';
    
    const userMsgs = messages.filter(m => m.role === 'user');
    const assistantMsgs = messages.filter(m => m.role === 'assistant');
    
    const parts = [];
    
    if (userMsgs.length > 0) {
      parts.push(`用户进行了 ${userMsgs.length} 次提问`);
    }
    
    if (assistantMsgs.length > 0) {
      parts.push(`助手进行了 ${assistantMsgs.length} 次回复`);
    }

    // 添加主要讨论内容
    const mainContent = messages
      .filter(m => m.content && m.content.length > 50)
      .map(m => this.truncate(m.content, 150))
      .slice(0, 3);

    if (mainContent.length > 0) {
      parts.push('主要讨论: ' + mainContent.join(' | '));
    }

    return parts.join('；');
  }

  /**
   * 构建压缩后的消息数组
   */
  /**
   * 保证压缩产物严格小于触发阈值 (2026-10-13 压缩活锁修复)。
   *
   * shouldCompact 判的是 `>=`, 所以「压到正好等于阈值」等于没压 —— 下一轮立刻又触发,
   * 而 budget 续命会把轮次预算清零, 于是变成无限循环。宁可多丢几条旧的, 也要留出余量。
   *
   * 不变量优先: 压缩摘要、最后一条 user (主人当前问的问题)、至少一条非 system 消息
   * 永远不丢; 必留项本身就已经 >= 阈值时原样返回, 不为了凑数字破坏不变量。
   */
  _clampBelowThreshold(compacted, originalMessages) {
    const th = Number(this.config && this.config.messageThreshold);
    if (!Number.isFinite(th) || th <= 0) return compacted;
    if (!Array.isArray(compacted) || compacted.length < th) return compacted;

    let lastUserContent = null;
    for (let i = (originalMessages || []).length - 1; i >= 0; i--) {
      const m = originalMessages[i];
      if (m && m.role === 'user') { lastUserContent = m.content; break; }
    }

    const mustKeep = new Set();
    compacted.forEach((m, i) => {
      if (!m) return;
      if (m.isCompactionSummary) mustKeep.add(i);
      else if (lastUserContent != null && m.role === 'user' && m.content === lastUserContent) mustKeep.add(i);
    });
    for (let i = compacted.length - 1; i >= 0; i--) {
      const m = compacted[i];
      if (m && m.role !== 'system') { mustKeep.add(i); break; }   // INVARIANT: ≥1 条非 system
    }
    if (mustKeep.size >= th) return compacted;   // 必留项自己就超阈值, 不变量优先

    const keep = new Set(mustKeep);
    for (let i = compacted.length - 1; i >= 0 && keep.size < th; i--) keep.add(i);
    // 必须严格小于, 所以再把最旧的可丢项踢掉, 直到真的低于阈值
    while (keep.size >= th) {
      let victim = -1;
      for (const i of Array.from(keep).sort((a, b) => a - b)) {
        if (!mustKeep.has(i)) { victim = i; break; }
      }
      if (victim < 0) break;
      keep.delete(victim);
    }
    const out = compacted.filter((_, i) => keep.has(i));
    if (out.length >= compacted.length) return compacted;
    console.log('[session-compaction] clamp-below-threshold: ' + compacted.length + ' -> ' + out.length +
      ' msgs (阈值 ' + th + ', 压缩产物原本压不下去 → 会活锁)');
    return out;
  }

  buildCompactedMessages(originalMessages, summary) {
    const { keepSystemMessages } = this.config;
    const compacted = [];

    // 添加摘要作为系统消息
    compacted.push({
      role: 'system',
      content: `【会话摘要】${JSON.stringify(summary, null, 2)}`,
      timestamp: Date.now(),
      isCompactionSummary: true
    });

    // 保留系统消息, 但**按内容去重**。
    // 2026-10-13 现场 (子 agent sub-0): 124 条消息里 122 条是注入的 system 提示
    // (53 份环境提示 + 24 份角色提示 + 42 份续跑 + 3 份账本), 这 122 条精确去重后只剩 6 条。
    // 同一段系统指令重复 53 遍不带任何新信息, 却让压缩彻底压不动 ——
    // 实测压前 127 条 → 压后 130 条 (ratio 1.02), 线上日志直接打到 1.03。
    // 同 key 保留最后一次注入 (它是最新的指令版本), 顺序按首次出现的位置保持。
    if (keepSystemMessages) {
      const _sysByContent = new Map();
      for (const m of originalMessages) {
        if (!m || m.role !== 'system' || m.isCompactionSummary) continue;
        _sysByContent.set(String(m.content || ''), m);
      }
      const _sysKept = Array.from(_sysByContent.values());
      compacted.push(...( _sysKept.length > MAX_KEPT_SYSTEM_MESSAGES
        ? _sysKept.slice(0, KEEP_SYSTEM_HEAD).concat(_sysKept.slice(-KEEP_SYSTEM_TAIL))
        : _sysKept ));
    }

    // 根据摘要类型决定如何处理
    // 2026-09-16: 'fold' (多页滚动摘要) 走 recent 分支 — 摘要本身已是滚动合并结果, 保留最近 KEEP 条即可
    if (summary.type === 'smart' && summary.importantMessages) {
      // 智能策略：保留重要消息
      // 2026-10-15: 这里原来无条件把 importantMessages 逐条 push 回去, 于是**绕过了上面
      // keepSystemMessages 分支刚做过的内容去重**。而 scoreMessages 给每条 system 消息
      // 固定 +10 (line ~484), 注入块又因为 15168 字符再 +2 —— 盘古注入的 system 提示
      // 永远是得分最高的那一批, importantMessages 基本被它们占满。
      // 线上实测 (session garfix-1015#sub-0-analyzer, 17 条消息):
      //   压前 3 份 [运行环境 — 路径铁律] (逐字相同, 15168 字符)
      //   压后 4 份 —— 压缩把重复**放大**了, 不是修好
      // 而「运行环境 — 路径铁律」这份 5317 token, 本地 27B prefill ~285 tok/s,
      // 多一份就是白等 ~18s, 而且之后每一轮工具调用都要重付。
      // 修: keepSystemMessages 生效时, 普通 system 消息由去重分支独家负责,
      // 这里只放非 system 消息 (压缩摘要本身由 compacted[0] 提供)。
      const _skipSys = !!keepSystemMessages;
      summary.importantMessages.forEach(imp => {
        if (_skipSys && imp && imp.role === 'system') return;
        // 2026-08-02 修 (老板 20:52 实案: 复读八字报告): 索引主匹配, preview 字符串匹配兜底 —
        // 旧代码只靠 preview 字符串 find, 重复消息 ('继续'/'修') 和空 content 会匹配错/匹配不到 →
        // 压缩后 0 条非 system → MiniMax 400 'chat content is empty' + 当前问题丢失 → LLM 拿摘要自由发挥
        let original = (typeof imp.idx === 'number' && imp.idx >= 0) ? originalMessages[imp.idx] : null;
        if (!original || original.role !== imp.role) {
          original = originalMessages.find(
            m => m.role === imp.role && this.truncate(m.content, 200) === imp.preview
          );
        }
        if (original) {
          compacted.push({
            ...original,
            timestamp: original.timestamp || Date.now()
          });
        }
      });
    } else {
      // 其他策略：保留最近的消息
      // 2026-09-16 二期: fold 摘要已含全部旧内容 → 不保留旧消息 (保留=重复, 越压越胖)
      // 只留最近几条 + 最后一条 user (当前问题), 让压缩真的把会话变短
      const _foldMode = summary && summary.type === 'fold' && summary.foldKeepRecent === false;
      const recentMessages = originalMessages
        // 2026-10-15: 原来这里放行**所有**非摘要 system 消息, 而上面 keepSystemMessages
        // 分支 (默认 true) 已经把去重后的 system 消息发出去了 —— 同一个 system 提示
        // 每压缩一次就多一份。实测 [gar-resume] before_compact=1 after_compact=2,
        // 再压一次 3 份, 而「运行环境 — 路径铁律」那份是 6604 token,
        // 本地 27B prefill ~285 tok/s, 多一份就是白等 ~23s。
        // 修: keepSystemMessages 生效时, 普通 system 消息由上面那一份负责, 这里只留
        // 压缩摘要 (isCompactionSummary) 和非 system 消息;
        // keepSystemMessages 为 false 时保持原样, 不吞掉注入提示。
        .filter(m => m.role !== 'system' || m.isCompactionSummary || !keepSystemMessages)
        .slice(_foldMode ? -6 : -this.config.maxRetainedMessages);
      compacted.push(...recentMessages);
    }

    // 2026-09-14 (老板拍 "按顺序解决" #2 传染源): 源头钉住硬不变量, 不再靠 fallback 兜底 —
    // 压缩产物必须永远含 ①最后一条 user 消息 (主人的当前问题, 短确认 "A/继续" 分低会被打分挤掉,
    //   58 次 INVARIANT VIOLATION 全是这个) ②≥1 条非 system 消息。
    // 打分挑选可以丢历史, 但永远不许丢"主人正在问什么"。
    const _lastUserMsg = [...originalMessages].reverse().find(m => m.role === 'user');
    if (_lastUserMsg && !compacted.some(m => m.role === 'user' && m.content === _lastUserMsg.content)) {
      compacted.push(_lastUserMsg);
    }
    if (!compacted.some(m => m.role !== 'system')) {
      const _lastNonSys = [...originalMessages].reverse().find(m => m.role !== 'system');
      if (_lastNonSys) compacted.push(_lastNonSys);
    }

    // 2026-09-12 (老板 20:43 实案): 切片/重要消息挑选都不感知 OpenAI tool_call 配对 —
    // 压缩结果里出现"孤儿 tool result" (父 assistant tool_calls 被切掉) → MiniMax 400
    // "tool result's tool id not found" → 整轮被迫降级 legacy 重跑。压缩产物必须过配对清洗。
    return this._sanitizeToolPairing(compacted);
  }

  /**
   * OpenAI tool_call 配对清洗 (2026-09-12):
   * ① 丢掉没有父 assistant tool_calls 的孤儿 tool result (API 400 真凶)
   * ② assistant 的 tool_calls 只保留有对应 tool result 的; 全没配对的剥掉 tool_calls 字段
   *    (空 content 的整条约掉) — 防"有调用没结果"的反向不配对
   */
  _sanitizeToolPairing(messages) {
    // 2026-10-13: 实现搬进 modules/tool_pairing.js —— 子 agent 的上下文截断撞上同一类
    // 400 (孤儿 tool result), 同一套解法只留一份, 免得两处各修各的漂成两套语义。
    const { messages: out, stats } = require('./tool_pairing').sanitizeToolPairing(messages);
    if (stats.droppedTool || stats.stripped || stats.droppedAssistant) {
      console.warn('[session-compaction] tool-pairing sanitize: \u4e22\u5b64\u513f tool result=' + stats.droppedTool
        + ', \u5265/\u88c1 assistant tool_calls=' + stats.stripped
        + ', \u4e22\u7a7a\u8c03\u7528 assistant=' + stats.droppedAssistant);
    }
    return out;
  }

  /**
   * 截断文本
   */
  truncate(text, maxLength) {
    if (!text) return '';
    // 2026-08-02 修: content 可能是数组 (多模态 blocks), length/substring 语义全错
    if (typeof text !== 'string') text = JSON.stringify(text) || '';
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  /**
   * 批量压缩所有需要压缩的会话
   */
  async compactAll() {
    const results = [];
    for (const sessionId of this.sessions.keys()) {
      if (this.shouldCompact(sessionId)) {
        const result = await this.compact(sessionId);
        if (result) {
          results.push({ sessionId, ...result });
        }
      }
    }
    return results;
  }

  /**
   * 获取会话统计信息
   */
  getStats(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return {
      messageCount: session.messages.length,
      totalMessages: session.totalMessages,
      compactCount: session.compactCount,
      lastCompact: session.lastCompact,
      age: Date.now() - (session.messages[0]?.timestamp || session.lastCompact)
    };
  }

  /**
   * 清除所有会话
   */
  clearAll() {
    this.sessions.clear();
  }

  /**
   * 生成会话ID的哈希
   */
  hashSessionId(sessionId) {
    return crypto.createHash('sha256').update(sessionId).digest('hex').substring(0, 16);
  }
}

// 创建默认实例
const defaultCompactor = new SessionCompaction();

/**
 * 快捷压缩函数
 */
async function compact(sessionId, messages, options) {
  const compactor = new SessionCompaction(options);
  compactor.register(sessionId, messages);
  return compactor.compact(sessionId);
}

/**
 * 创建自定义压缩器
 */
function createCompactor(options) {
  return new SessionCompaction(options);
}

/**
 * 2026-08-24 (老板 09:21 实案: gemma 生成摘要崩坏, 输出 'Summary: Summary: ...' 无限复读,
 * 垃圾摘要写进【会话摘要】污染后续对话) — LLM 摘要产出做重复检测, 崩坏则降级 rule-based
 */
function _isRepetitiveGarbage(text) {
  if (!text || text.length < 40) return false;
  // 同一非空行出现 ≥5 次 → 复读崩坏
  const freq = {};
  for (const l of text.split('\n')) {
    const t = l.trim();
    if (!t) continue;
    freq[t] = (freq[t] || 0) + 1;
    if (freq[t] >= 5) return true;
  }
  // 同一 ≥3 字的片段出现 ≥8 次 (单行内复读: 'Summary: Summary: ...')
  const probe = text.slice(0, 12).trim();
  if (probe.length >= 3 && text.split(probe).length - 1 >= 8) return true;
  return false;
}

/**
 * TL-6 v1: 用 LLM 摘要 messages (调小模型 gemma-4-26b, 不跟主对话抢 token)
 *
 * @param {Array} messages - 完整 messages 数组
 * @param {object} [opts] - { model, callLLM, maxChars }
 * @returns {Promise<string>} 200 字内摘要
 */
async function summarizeMessages(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const model = opts.model || 'google_gemma-4-26b-a4b-qat';  // 小模型, 不跟主对话抢 token
  const callLLM = opts.callLLM;  // 调用方传 callLLM fn (避免循环依赖)
  const maxChars = opts.maxChars || 600;  // 2026-09-17: 200→600, 交接备忘录要装得下 7 项
  // 1. 拼 prompt
  // 2026-09-17 全修: 摘要 prompt 升级 — 旧版 200 字太短, 大任务压完 LLM 失忆 (老板实案 "压缩后丢已核实事实/进度漂移")。
  // 新 prompt 强制保留: 任务目标/已完成清单(带证据)/当前进度/未做部分/关键事实与数字/用户偏好与指令。
  const dialog = messages
    .filter(m => m && m.role && typeof m.content === 'string')
    .map(m => `${m.role}: ${m.content.slice(0, 500)}`)  // 截断单条 500 字, 避免 prompt 过长
    .join('\n');
  const prompt = `你是会话压缩器。把以下对话压成一份"交接备忘录", 让接手者无需旧对话就能继续工作。必须包含 (缺项=压缩失败):
1. 任务目标: 用户到底要做什么 (原话摘录)
2. 已完成: 做完了哪些, 每项带真证据 (文件路径/数字/测试结果)
3. 当前进度: 做到哪一步, 卡在哪 (如有)
4. 未做: 还差什么, 下一步具体动作
5. 关键事实: 已核实的数据/结论/配置 (原数字, 不许模糊成"大约/一些")
6. 用户偏好与指令: 用户明确说过的规矩 (如 "不需要再问我" / "按顺序全做完" / 禁止项)
7. 失败教训: 本轮失败过什么 (错误码/死锁原因), 接手者别再踩
中文, 总长 ≤${maxChars * 3} 字, 用分节列表, 不许复述对话原文。

${dialog}

交接备忘录:`;
  // 2. 调 LLM (callLLM 由 j2_agent_loop 注入)
  if (callLLM && typeof callLLM === 'function') {
    try {
      const r = await callLLM([{ role: 'user', content: prompt }], { model });
      const text = (r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '';
      const trimmed = text.trim();
      if (_isRepetitiveGarbage(trimmed)) {
        console.warn('[session-compaction] LLM 摘要复读崩坏, 降级 rule-based:', trimmed.slice(0, 60));
      } else if (trimmed) {
        return trimmed.slice(0, maxChars * 3);  // 安全截断 (备忘录上限 1800 字)
      }
    } catch (e) {
      console.warn('[session-compaction] summarizeMessages LLM call failed:', e.message);
    }
  }
  // 3. fallback: 提取 topics (旧 generateSmartSummary) — 不调 LLM 也能用
  const tmp = new SessionCompaction();
  return JSON.stringify(tmp.generateSmartSummary(messages)).slice(0, maxChars * 3);
}

module.exports = {
  SessionCompaction,
  compact,
  createCompactor,
  summarizeMessages,  // TL-6 v1 新加
  DEFAULT_CONFIG
};
