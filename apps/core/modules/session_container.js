// W3 (2026-09-04 B 路线): Session Container — 集中托管所有 session-scoped 状态
// 之前: _forceCompactQueue / _sessionLastRoundAt / _sessionCompactTickAt / _state.activeAbort 全裸 Map 散在主循环
// 问题:
//   1. R80 BUG #12: 裸 Map 无 GC, idle session 累积 → 喷泉
//   2. §0.57 activeAbort 漏合并到统一容器, race condition 风险
//   3. watchdog / GC / 监控 没法集中
// 修: SessionContainer 类 + 单例 getContainer() — per-session 隔离 + 自动 GC + 监控 stats
// _j2SessionStates (j2_loop_shared.js) 暂不合并, 它的 500 自动淘汰已够用
'use strict';

const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const DEFAULT_THROTTLE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_GC_MAX_AGE_MS = 4 * 60 * 60 * 1000;  // 4h 不活动 → 销毁

// ===== 连续上下文配额 (2026-10-14) =====
// Codex 靠单一长对话天然连续, 它的 compact 是 token 到阈值才触发。
// 盘古是 N 个将灵共享一条上下文, 同一个阈值会 N 倍超支, 所以这里按字符封顶而不是按 token。
const CTX_MAX_TURNS = 8;          // 最多回溯几轮
const CTX_TURN_CHARS = 1200;      // 单轮上限
const CTX_MAX_CHARS = 6000;       // 历史块总上限
const FINDINGS_MAX = 12;          // 最多带几条将灵产出
const FINDING_CHARS = 700;        // 单条产出上限
const FINDINGS_MAX_CHARS = 5000;  // 产出块总上限

// ===== 分工上下文配额 (2026-10-16) =====
//
// 为什么要单独一套配额: 连续上下文 (2026-10-14) 是**无条件**把最近 8 轮对话 + 12 条
// 兄弟产出灌给每一个将灵。实测一次子 agent 调用的继承块最坏 11000 字符, 而它真正的
// 作业常常只有一百来字。代价不是只有 token, 是三样:
//   ① 预填充变慢 —— 每个兄弟都替别人的活付一次 prefill, N 个兄弟就是 N 倍
//   ② 跑偏 —— 模型在 turns 里读到主人的宽问题, 就去答整个问题, 而不是分给自己的那一刀
//   ③ 重复 —— 同一件事在 turns / taskText / findings 三处以三种形状各出现一次,
//      模型把重复当强调, 于是越重复越当真, 越当真越容易把摘要当新指令执行
//
// 正解跟人带新人干活一样: 给背景, 但只给跟这一刀有关的背景。
// 硬约束 (不能省的): 最近 2 轮 + 最近 1 条产出永远保留 —— 那是"上一手做到哪了"。
// 砍掉它就是让人凭空开工, 那才是真断链, 比慢更糟。
const SCOPED_MAX_TURNS = 6;
const SCOPED_MAX_CHARS = 3200;
const SCOPED_FINDINGS_MAX = 5;
const SCOPED_FINDINGS_CHARS = 2600;
const CONTEXT_FLOOR_TURNS = 2;    // 最近几轮无条件保留 (连续性底线)
const CONTEXT_FLOOR_FINDINGS = 1; // 最近一条产出无条件保留 (交接底线)

// ===== 汇报契约 (2026-10-16) =====
//
// 分工要成立, 光"分下去"不够, 还得"报上来"。旧码只要求"给一段非空的总结文字",
// 于是模型交上来的是散文: 该说的没说, 不该说的写满, 下一个兄弟读完还得自己从散文里
// 刨事实 —— 分工省下的 token 在交接处原样还回去, 甚至更亏。
// 契约锁死四件事, 按行写, 不许写成段落:
//   ① 完成: 这一刀做成了什么 (一句话)
//   ② 证据: 工具名 + 关键返回 (没有就写"无" —— 不许用"应该/已处理"冒充)
//   ③ 未做: 没做到的、跳过的、有疑问的
//   ④ 交接: 下一个接手的人必须知道的一件事 (没有就写"无")
// ②③ 是这个契约的重点: 断链条和假装做完, 都是从这两行被抹掉开始的。
// ①④ 是给下游省时间: 有结论就不用重查, 有坑就不会重踩。
const REPORT_CONTRACT = ''
  + '\n\n【汇报契约 — 按这四行交, 不要写成段落】'
  + '\n① 完成: <这一刀做成了什么, 一句话>'
  + '\n② 证据: <工具名 + 关键返回; 没有就写"无">'
  + '\n③ 未做: <没做到/跳过/存疑的部分; 没有就写"无">'
  + '\n④ 交接: <下一个接手的人必须知道的一件事; 没有就写"无">'
  + '\n证据不足就继续调用工具去取, 不许在没拿到证据时下结论; 全部做完再收尾。';

/**
 * 从一段文本里抽"判断是否在谈同一件事"的键。
 * 不引分词器: 路径/标识符按整词抽 (路径是分工最强的信号 —— 不同切片基本不同路径),
 * 中文按双字切 (双字已经足够判"是不是同一个话题", 再细的粒度只会引入噪声)。
 */
function ctxKeys(text) {
  const s = String(text || '').toLowerCase();
  const keys = new Set();
  const lat = /[a-z0-9_][a-z0-9_.\-\/]*/g;
  let m;
  while ((m = lat.exec(s)) !== null) {
    const w = m[0].replace(/[.\-\/]+$/, '');
    if (w.length >= 3) keys.add(w);
    // 路径必须能**按段对上**。踩过的坑: 任务里写 `去 /tmp/x/f1.txt 确认`, 兄弟产出里写
    // `已在 /tmp/x 建好`, 而正则把整条路径吞成一个键 —— 两边交集为空, 明明在说同一个
    // 目录却被判成无关, 相关产出被砍掉。分工砍错东西比不砍更危险, 所以路径拆段必做。
    if (w.indexOf('/') >= 0) {
      const segs = w.split('/');
      for (let i = 1; i < segs.length; i++) keys.add(segs.slice(0, i).join('/'));  // 各级祖先目录
      const base = segs[segs.length - 1];
      if (base.length >= 3) keys.add(base);                                        // 文件名/目录名本身
      const dot = base.lastIndexOf('.');
      if (dot > 0 && dot < base.length - 1) keys.add(base.slice(0, dot));          // 去扩展名
      for (let i = 0; i < segs.length - 1; i++) {
        if (segs[i].length >= 3) keys.add(segs[i]);                                 // 单段目录名
      }
    }
  }
  const cjk = /[\u4e00-\u9fff]{2,}/g;
  while ((m = cjk.exec(s)) !== null) {
    const run = m[0];
    for (let i = 0; i + 1 < run.length; i++) keys.add(run.slice(i, i + 2));
  }
  return keys;
}

/**
 * 命中率归一化。原始交集会被 taskText 的长度带偏 (任务越短, 同样的交集分数越高),
 * 除以 sqrt(作业键数) 把这个偏差压掉 —— 只用于**排序**, 不用于判生死,
 * 筛选判据是"有没有命中", 宁可多留不可错砍。
 */
function ctxRelevance(hayKeys, taskKeys) {
  if (!taskKeys.size || !hayKeys.size) return 0;
  let hit = 0;
  for (const k of taskKeys) if (hayKeys.has(k)) hit++;
  return hit / Math.sqrt(taskKeys.size);
}

/**
 * 汇报内容归一化: 兄弟产出常带 markdown 表格和加粗, 管道符和星号在 700 字预算里
 * 吃掉一大截, 而真正的结论只占其中两三行。这里剥掉装饰、保留文字,
 * 让"交接给下一个兄弟"的预算花在结论上, 不花在表格边框上。
 */
function normalizeFindingSummary(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(l => l.replace(/^\s*\|/, '').replace(/\|/g, ' ').replace(/\*\*?/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' / ')
    .slice(0, FINDING_CHARS);
}

class SessionContainer {
  constructor(opts = {}) {
    this._opts = {
      idleMs: opts.idleMs || DEFAULT_IDLE_MS,
      throttleMs: opts.throttleMs || DEFAULT_THROTTLE_MS,
      maxAttempts: opts.maxAttempts || DEFAULT_MAX_ATTEMPTS,
      gcMaxAgeMs: opts.gcMaxAgeMs || DEFAULT_GC_MAX_AGE_MS,
    };
    this._states = new Map();        // sessionId → state (j2 复用 — planState / fountain / nudges)
    this._activeRound = new Map();   // sessionId → AbortController (§0.57 per-session lock)
    this._lastRoundAt = new Map();   // sessionId → ts ms (watchdog 用)
    this._compactTickAt = new Map(); // sessionId → { ts, attempts }
    this._compactQueue = new Set();  // sessionId 待强制压缩
  }

  // ===== state (跟 _j2SessionStates 平行, §0.63 接管 §0.57 状态) =====
  getOrCreateState(sessionId) {
    if (!sessionId) return null;
    if (!this._states.has(sessionId)) {
      this._states.set(sessionId, {
        sessionId,
        planState: null,
        fountainHistory: null,
        lastToolCall: null,
        nudges: { emptyPlan: 0, thinkOnly: 0, promise: 0, unverified: 0, reasoning: 0 },
        createdAt: Date.now(),
        // 2026-10-14: 连续上下文的两个真源 (之前这个 state 一条消息都不存)
        turns: [],      // [{role:'user'|'assistant', content, ts}] 真实对话轮次
        findings: [],   // [{agent, task, summary, tools, toolEvidence, ok, ts}] 将灵产出
        rootId: null,   // 同一次任务跨轮共享的根 id → trace 能归组算总耗时
        lastTraceId: null,
      });
    }
    return this._states.get(sessionId);
  }
  getState(sessionId) { return this._states.get(sessionId); }

  // ===== 连续上下文 (2026-10-14) =====

  /**
   * 记一轮对话。dispatcher 在拿到 userInput 和最终答案后各调一次。
   * 同一段内容不重复记 (前端会把历史一起发过来, 判重靠归一化文本)。
   */
  appendTurn(sessionId, role, content) {
    const st = this.getOrCreateState(sessionId);
    if (!st) return false;
    const text = String(content == null ? '' : content).trim();
    if (!text) return false;
    if (role !== 'user' && role !== 'assistant') return false;
    const norm = text.replace(/\s+/g, ' ').trim();
    const last = st.turns[st.turns.length - 1];
    if (last && last.role === role && last.content.replace(/\s+/g, ' ').trim() === norm) return false;
    st.turns.push({ role, content: text, ts: Date.now() });
    // 环形裁剪: 留够 CTX_MAX_TURNS 的余量, 免得每次 append 都重算
    const cap = CTX_MAX_TURNS * 3;
    if (st.turns.length > cap) st.turns.splice(0, st.turns.length - cap);
    st.updatedAt = Date.now();
    return true;
  }

  /**
   * 记一条将灵产出。下游将灵和下一轮主人提问都能看到 —— 这才是"分工不丢成果"。
   * @param {string} sessionId
   * @param {object} f {agent, task, summary, tools, toolEvidence, ok}
   */
  appendFinding(sessionId, f) {
    const st = this.getOrCreateState(sessionId);
    if (!st || !f) return false;
    const agent = String(f.agent || 'agent');
    // 同一将灵同一条 task 反复跑 (纠错复核) → 替换成最新版, 不堆重复
    const taskKey = String(f.task || '').slice(0, 200);
    const dup = st.findings.findIndex(x => x.agent === agent && x.taskKey === taskKey);
    const rec = {
      agent,
      task: String(f.task || '').slice(0, 200),
      taskKey,
      summary: String(f.summary || '').slice(0, FINDING_CHARS),
      tools: Array.isArray(f.tools) ? f.tools.slice(0, 20) : [],
      toolEvidence: String(f.toolEvidence || '').slice(0, 1200),
      ok: f.ok === undefined ? true : !!f.ok,
      ts: Date.now(),
    };
    if (dup >= 0) st.findings[dup] = rec; else st.findings.push(rec);
    if (st.findings.length > FINDINGS_MAX) st.findings.splice(0, st.findings.length - FINDINGS_MAX);
    st.updatedAt = Date.now();
    return true;
  }

  /**
   * 给子 agent 构造继承上下文。
   *
   * 返回两段, 刻意分开:
   *   turns        — 真实 user/assistant 轮次, 直接接进子 agent 的 messages,
   *                 模型当成同一条对话的自然延续 (这才是 codex 的连续性语义)
   *   findingsBlock — 将灵产出, 走 system 通道并标清"这是同一条任务里其他将灵的结论",
   *                 因为它是工作记忆不是对话, 混进 user/assistant 会让模型误判成主人在说话
   */
  buildSubagentContext(sessionId, opts = {}) {
    const st = this.getOrCreateState(sessionId);
    const empty = { turns: [], findingsBlock: '', rootId: st ? st.rootId : null, findingsCount: 0 };
    if (!st) return empty;

    // 显式 0 要能生效 (调用方可能只想要 findings), 不能用 || (0 falsy 会退回默认值)
    const maxTurns = typeof opts.maxTurns === 'number' ? opts.maxTurns : CTX_MAX_TURNS;
    const maxChars = opts.maxChars || CTX_MAX_CHARS;
    const turns = [];
    let used = 0;
    for (let i = st.turns.length - 1; i >= 0 && turns.length < maxTurns; i--) {
      const t = st.turns[i];
      let content = String(t.content || '');
      if (content.length > CTX_TURN_CHARS) content = content.slice(0, CTX_TURN_CHARS) + '…';
      if (used + content.length > maxChars) break;
      turns.unshift({ role: t.role, content });
      used += content.length;
    }

    let findingsBlock = '';
    if (opts.includeFindings !== false && st.findings.length) {
      const lines = [];
      let fUsed = 0;
      for (let i = st.findings.length - 1; i >= 0; i--) {
        const f = st.findings[i];
        const tools = f.tools && f.tools.length ? (' | 调用工具: ' + f.tools.join(', ')) : '';
        const ev = f.toolEvidence ? ('\n  工具证据: ' + f.toolEvidence) : '';
        const line = '[' + f.agent + (f.ok ? '' : ' 失败') + '] ' + String(f.task || '').slice(0, 120) + tools
          + '\n  结论: ' + (f.summary || '(空)') + ev;
        if (fUsed + line.length > FINDINGS_MAX_CHARS) break;
        lines.unshift(line);
        fUsed += line.length;
      }
      if (lines.length) {
        findingsBlock = '【同一条任务里其他将灵已经查到的 — 别重复劳动, 也别推翻: '
          + '他们的结论若有错, 用你自己的工具证据反驳, 不许只凭"我觉得"改口】\n'
          + lines.join('\n---\n');
      }
    }
    return { turns, findingsBlock, rootId: st.rootId, findingsCount: st.findings.length };
  }

  /**
   * 给子 agent 构造**分工作用域内**的继承上下文 (2026-06-16 分工重构)。
   *
   * 与 buildSubagentContext 的关系: 前者是"全量" (连续上下文), 这个是"按作业选"。
   * 两者并存是有意的 —— buildSubagentContext 保留全量语义给需要整段对话的调用方,
   * 而每一个子 agent 调用点都改走这里, 因为子 agent 的活是**一刀**, 不是整件事。
   *
   * 选法三条:
   *   ① 最近 CONTEXT_FLOOR_TURNS 轮无条件留 —— 连续性底线, 保证"上一手做到哪"看得见
   *   ② 其余轮次只在"与本次作业谈同一件事"时留 (路径/标识符/中文双字命中)
   *   ③ 与作业无关的轮次不删出历史, 只是不下发给这一个子 agent —— 下一个子 agent
   *      仍然看得到它。主人的连续性不因为分工而丢, 丢的只是"每个兄弟都得重读全史"。
   *
   * findingsBlock 同理, 外加一条去重: taskText 已经把某条产出的结论原样带下来了,
   * 再整段贴一遍就是纯浪费 (而且模型会把重复当强调), 这时只留一行指针。
   */
  buildScopedContext(sessionId, opts = {}) {
    const st = this.getOrCreateState(sessionId);
    if (!st) return { turns: [], findingsBlock: '', rootId: null, scope: null };

    const taskText = String(opts.taskText || '');
    const taskKeys = ctxKeys(taskText);
    // 没有作业文本可比 (例如 inline 路径 taskText 已含整段历史) → 不做筛选,
    // 老实退回全量配额。这条兜底比"假装筛过"安全。
    const scoped = taskKeys.size > 0;

    // upToTurns: 只看前 N 条 (调用方在 append 本轮之前记下的轮数)。
    // 不做这个截断的话, 本轮主人的提问会同时出现在 turns 和 taskText 里 —— 同一句话
    // 灌两遍, 既白烧预填充, 又让模型把"上文"当成新指令再执行一遍。
    const pool = (typeof opts.upToTurns === 'number' && opts.upToTurns >= 0)
      ? st.turns.slice(0, opts.upToTurns)
      : st.turns;
    const maxTurns = typeof opts.maxTurns === 'number' ? opts.maxTurns : (scoped ? SCOPED_MAX_TURNS : CTX_MAX_TURNS);
    const maxChars = opts.maxChars || (scoped ? SCOPED_MAX_CHARS : CTX_MAX_CHARS);
    // 2026-10-17 (现场 lt3-1792176406069#sub-0-analyzer, 子会话落盘逐条核对):
    //   主人原话「分别分析这三个文件…: 1) j2_loop_shared.js 2) model_cost.js 3) checkpoint.js」
    //   拆成三刀, sub-0 被派 j2_loop_shared.js。它收到的消息列表是:
    //     [2] user 485字 = **主人原话全文, 三个绝对路径都在** (继承来的上一手)
    //     [3] user 683字 = 它自己那刀 "只做这一项: j2_loop_shared.js"
    //   同一轮里两句指令打架, 模型照**前**那句把三个文件全干了:
    //     exec_command(wc -l 三个文件) + read_file(自己的, 24071字) + read_file ×3(11057/6195/6229)
    //   自己那份 24071 字读了两遍, 兄弟两个文件白读 12424 字, 6 轮才收工。
    //
    // 为什么相关性筛选没挡住: 日志写得很清楚 ——
    //   [dispatch] 分工上下文 task: 作业键=200 轮次 1(相关 0/砍无关 0) 下发 485 字符
    // 相关 0 = 判定"跟我这一刀无关"; 砍无关 0 = 它还是被发了。差别在
    // CONTEXT_FLOOR_TURNS: 最近 2 轮无条件保留, **绕过**相关性判定 (见下面 isFloor)。
    // 底线本身是对的 (治"上一手干过别的活, 别撞车"), 但一条**点了兄弟刀名字**的轮次
    // 不是"别撞车"的提醒, 是一条**竞争性指令** —— 它比收窄后的 taskText 更像"主人的要求",
    // 模型优先照它走。底线豁免不能拿来护住它。
    //
    // 所以: 命中兄弟路径的轮次**无条件砍掉**, 不吃底线豁免。只砍"点名兄弟"的,
    // 连续性该留的轮次一条不动 (见 tests/sibling-scope-turn-drop-20261017.test.js)。
    const siblingPaths = (Array.isArray(opts.excludeScopePaths) ? opts.excludeScopePaths : [])
      .map((p) => String(p || '').trim())
      .filter(Boolean);
    const turns = [];
    let used = 0;
    let keptRelevant = 0;
    let dropped = 0;
    let droppedSibling = 0;
    for (let i = pool.length - 1; i >= 0 && turns.length < maxTurns; i--) {
      const t = pool[i];
      let content = String(t.content || '');
      if (content.length > CTX_TURN_CHARS) content = content.slice(0, CTX_TURN_CHARS) + '…';
      if (siblingPaths.length && siblingPaths.some((p) => content.includes(p))) {
        droppedSibling++;
        continue;
      }
      const isFloor = turns.length < CONTEXT_FLOOR_TURNS;
      if (scoped && !isFloor) {
        const rel = ctxRelevance(ctxKeys(content), taskKeys);
        if (rel <= 0) { dropped++; continue; }
        keptRelevant++;
      }
      if (used + content.length > maxChars) {
        // 底线轮次必须进 (哪怕超预算), 否则等于把"上一手"砍掉 —— 宁可超封顶。
        if (!isFloor) break;
      } else {
        used += content.length;
      }
      turns.unshift({ role: t.role, content });
    }

    let findingsBlock = '';
    const fMax = scoped ? SCOPED_FINDINGS_MAX : FINDINGS_MAX;
    const fChars = scoped ? SCOPED_FINDINGS_CHARS : FINDINGS_MAX_CHARS;
    let fDropped = 0;
    if (opts.includeFindings !== false && st.findings.length) {
      const lines = [];
      let fUsed = 0;
      for (let i = st.findings.length - 1; i >= 0 && lines.length < fMax; i--) {
        const f = st.findings[i];
        const isFloor = lines.length < CONTEXT_FLOOR_FINDINGS;
        const summary = normalizeFindingSummary(f.summary);
        const tools = f.tools && f.tools.length ? (' | 调用工具: ' + f.tools.join(', ')) : '';
        let line;
        // 底线的那一条, 如果与本次作业无关, **只留指针不留正文**。
        // 底线的意义是"知道有一手刚干过别的活, 别撞车", 不是"把别人的结论读一遍"。
        // 实测过整段放的后果: 一个文件校验收尾的子 agent, 因为上一手是性能分析,
        // 硬吃进 700 字 prefill 结论 —— 既拖慢预填充, 又诱导它去答性能问题而不是读文件。
        if (isFloor && scoped && ctxRelevance(ctxKeys([f.task, f.summary, summary].join(' ')), taskKeys) <= 0) {
          line = '[' + f.agent + (f.ok ? '' : ' 失败') + '] 刚做完(与你这刀无关, 只告知别撞车): '
            + String(f.task || '').slice(0, 100);
          fUsed += line.length;
          lines.unshift(line);
          continue;
        }
        if (scoped && !isFloor) {
          const rel = ctxRelevance(
            ctxKeys([f.task, f.summary, summary, (f.toolEvidence || '')].join(' ')),
            taskKeys,
          );
          if (rel <= 0) { fDropped++; continue; }
          // taskText 已经把这条结论带下来了 → 只留指针, 不重复贴正文
          const probe = summary.slice(0, 48);
          if (probe.length >= 12 && taskText.includes(probe)) {
            line = '[' + f.agent + (f.ok ? '' : ' 失败') + '] ' + String(f.task || '').slice(0, 120)
              + tools + '\n  结论: (已在你收到的任务里, 不重复贴 —— 用工具结果复核, 别照抄)';
          } else {
            const ev = f.toolEvidence ? ('\n  工具证据: ' + f.toolEvidence) : '';
            line = '[' + f.agent + (f.ok ? '' : ' 失败') + '] ' + String(f.task || '').slice(0, 120) + tools
              + '\n  结论: ' + (summary || '(空)') + ev;
          }
        } else {
          const ev = f.toolEvidence ? ('\n  工具证据: ' + f.toolEvidence) : '';
          line = '[' + f.agent + (f.ok ? '' : ' 失败') + '] ' + String(f.task || '').slice(0, 120) + tools
            + '\n  结论: ' + (summary || '(空)') + ev;
        }
        if (fUsed + line.length > fChars && !isFloor) break;
        fUsed += line.length;
        lines.unshift(line);
      }
      if (lines.length) {
        findingsBlock = '【同一件活里其他将灵已经查到的 — 别重复劳动, 也别推翻: '
          + '他们的结论若有错, 用你自己的工具证据反驳, 不许只凭"我觉得"改口】\n'
          + lines.join('\n---\n');
      }
    }

    return {
      turns,
      findingsBlock,
      rootId: st.rootId,
      findingsCount: st.findings.length,
      // 可观测性: 下发了多少 / 砍了多少。分工是否真的生效, 看这个数, 不看感觉。
      scope: {
        on: scoped,
        task_keys: taskKeys.size,
        turns_kept: turns.length,
        turns_dropped_irrelevant: dropped,
        // 点名兄弟刀的行数。>0 就说明"主人的全量清单"正在漏进子 agent ——
        // 这个数必须是 0, 漏进来就是上一段那 6 轮 + 24k 字重填。
        turns_dropped_sibling: droppedSibling,
        turns_kept_relevant: keptRelevant,
        findings_kept: findingsBlock ? (findingsBlock.match(/^\[/gm) || []).length : 0,
        findings_dropped_irrelevant: fDropped,
        chars: turns.reduce((n, t) => n + t.content.length, 0) + findingsBlock.length,
      },
    };
  }

  /** 一次任务 (跨多轮) 共享一个 root id, trace 才能归组算总耗时 */
  ensureRoot(sessionId, rootId) {
    const st = this.getOrCreateState(sessionId);
    if (!st) return null;
    if (!st.rootId) st.rootId = rootId || (Date.now() + '-' + Math.random().toString(16).slice(2, 8));
    return st.rootId;
  }

  // ===== active round (§0.57 per-session lock) =====
  getActiveAbort(sessionId) { return this._activeRound.get(sessionId); }
  setActiveAbort(sessionId, ctrl) {
    const prev = this._activeRound.get(sessionId);
    this._activeRound.set(sessionId, ctrl);
    return prev;
  }
  clearActiveAbort(sessionId, expectedCtrl) {
    if (expectedCtrl && this._activeRound.get(sessionId) !== expectedCtrl) return false;
    if (this._activeRound.has(sessionId)) this._activeRound.delete(sessionId);
    return true;
  }

  // ===== round activity (watchdog 用) =====
  markRoundActivity(sessionId) { if (sessionId) this._lastRoundAt.set(sessionId, Date.now()); }
  getLastRoundAt(sessionId) { return this._lastRoundAt.get(sessionId); }

  // ===== force compact (watchdog 触发 + 外部调用) =====
  requestForceCompact(sessionId) {
    if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
    if (this._compactQueue.has(sessionId)) return { ok: true, queued: false, reason: 'deduped' };
    const last = this._compactTickAt.get(sessionId) || { ts: 0, attempts: 0 };
    if (Date.now() - last.ts < this._opts.throttleMs) return { ok: true, queued: false, reason: 'throttled' };
    if (last.attempts >= this._opts.maxAttempts) {
      console.warn('[session-container] ' + sessionId + ' 累计 ' + last.attempts + ' 次入队超上限, 停止');
      return { ok: true, queued: false, reason: 'maxed' };
    }
    this._compactQueue.add(sessionId);
    this._compactTickAt.set(sessionId, { ts: Date.now(), attempts: last.attempts + 1 });
    return { ok: true, queued: true, attempts: last.attempts + 1 };
  }
  dequeueCompact(sessionId) { this._compactQueue.delete(sessionId); }
  listCompactQueue() { return Array.from(this._compactQueue); }

  // ===== watchdog (主循环 setInterval 调用) =====
  // 返回 idle sessionId 数组 (>= idleMs 未活动), 供主循环决定是否入队 force-compact
  watchdogTick(idleMs) {
    const ms = typeof idleMs === 'number' ? idleMs : this._opts.idleMs;
    const now = Date.now();
    const idle = [];
    for (const [sid, lastTs] of this._lastRoundAt.entries()) {
      if (now - lastTs >= ms) idle.push(sid);
    }
    return idle;
  }

  // 注: 0 不能用 || (0 falsy), 必须显式判断

  // ===== GC (定期调用) =====
  gc(maxAgeMs) {
    const ms = typeof maxAgeMs === 'number' ? maxAgeMs : this._opts.gcMaxAgeMs;
    const now = Date.now();
    let cleaned = 0;
    for (const [sid, lastTs] of this._lastRoundAt.entries()) {
      if (now - lastTs > ms) { this.destroy(sid); cleaned++; }
    }
    return cleaned;
  }

  destroy(sessionId) {
    this._states.delete(sessionId);
    this._activeRound.delete(sessionId);
    this._lastRoundAt.delete(sessionId);
    this._compactTickAt.delete(sessionId);
    this._compactQueue.delete(sessionId);
  }

  // ===== 监控 =====
  stats() {
    return {
      sessions: this._states.size,
      activeRounds: this._activeRound.size,
      compactQueue: this._compactQueue.size,
      compactTicks: this._compactTickAt.size,
      lastRoundAt: this._lastRoundAt.size,
      opts: { ...this._opts },
    };
  }
}

// 单例
let _instance = null;
function getContainer() {
  if (!_instance) _instance = new SessionContainer();
  return _instance;
}
// 重置 (测试用)
function _resetContainer() { _instance = null; }

module.exports = {
  SessionContainer,
  getContainer,
  _resetContainer,
  // 汇报契约与分工上下文配额: 单一下发点。fixed_flow 与 DAG 两条子 agent 路径都必须
  // 吃同一份, 否则交接格式会分叉成两套, 下一个兄弟就得同时认两种写法。
  REPORT_CONTRACT,
  SCOPED_LIMITS: {
    maxTurns: SCOPED_MAX_TURNS,
    maxChars: SCOPED_MAX_CHARS,
    findingsMax: SCOPED_FINDINGS_MAX,
    findingsChars: SCOPED_FINDINGS_CHARS,
    floorTurns: CONTEXT_FLOOR_TURNS,
    floorFindings: CONTEXT_FLOOR_FINDINGS,
  },
};
