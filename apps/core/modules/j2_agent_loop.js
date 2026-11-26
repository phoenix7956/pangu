// modules/j2_agent_loop.js — N5 refactor batch B3-Phase 3
// J2 Agent Loop 主循环 — Model-Agnostic, 探测到 native tool_call 支持走 native 路径
// 否则降级到 XML <tool> 文本协议 (legacy path)
// 依赖注入: init({ _config, _deps._recordSessionToMemory, _deps._callLLMForAgent, _deps._callLLMForAgentStream, _deps.safeResWrite,
                    //  _deps._detectToolCallSupport, _deps._j2ExecuteToolCalls, _deps._j2AppendToolResults, _toolCallSupportCache,
                    //  _deps._hasUnclosedToolBlock, path, MAX_BODY_BYTES })

let _deps = null;
function init(deps) { _deps = deps; }
// 2026-08-24 修 (重构事故): _j2BatchCounter 模块级声明被 N5/R16 重构弄丢,
// 762 行 ++_j2BatchCounter → ReferenceError, native 路径每轮必炸 (老版 j2_agent_loop.js:218 有声明)
let _j2BatchCounter = 0;  // Bug A 修: batch_id 跨 round 全局递增, 不每次重置
// 2026-10-15 (本地 27B 现场): 提到模块级 — 原 _PROMISE_RE 声明在 indent 12 的嵌套块里,
// 而"强逼工具"分支在 indent 10, 引用不到 (ReferenceError)。这里给强逼判定用同一套信号。
const _J2_PROMISE_TEXT_RE = /让我|我来|我先|我会|接下来|继续深入|继续读|继续看|继续调|系统性|全部读|读完|全读|搜一下|先调(?:工具|子)?|立即补上|这就去|马上调|下面调|现在调|动手调|先查|先并发|先拉|摸清|探针|再补/;
// §0.31: 跨 session 上下文缓存 (每个 sessionId 只查一次 checkpoint dir)
let _priorCtxCache = null;

// 工具 → 将灵 code。**从 ROLES[].tools 反查, 全文件共用一份** (2026-10-18 身份统一)。
//
// 这张表在这个文件里被手抄过两遍, 值都是英文, 而两个下游都只认拼音:
//   ① 进度条 current_gua: `_CODE_TO_GUA['dispatcher']` → undefined → "哪一卦在推"全灭
//   ② active_agent 事件: 前端 findGua(agent) 匹配不上 → "哪个将灵在干活"从来不亮
// 手抄的表必然漂移 —— 角色改名它就死, 改白名单它就过期, 两边都不报错。
// "谁的白名单里有这个工具"这个问题, 真源就是白名单本身, 所以这里懒加载 + 记忆化。
let _toolAgentMapCache = null;
function _guaToolToAgent(tool) {
  if (!_toolAgentMapCache) {
    const m = {};
    try {
      const _ROLES = require('../agents/sub-agent').ROLES || {};
      for (const [code, def] of Object.entries(_ROLES)) {
        for (const t of (def.tools || [])) {
          if (!m[t]) m[t] = code;   // 一个工具归一个将灵: 先到先得 (ROLES 声明序)
        }
      }
    } catch (_) { /* registry 没就绪: 反查为空, 指示条不亮, 不阻断主流程 */ }
    _toolAgentMapCache = m;
  }
  return _toolAgentMapCache[tool] || null;
}
// §0.32: 手动压缩队列 (HTTP /api/pangu/admin/compact 触发, 下轮 round 优先执行)
// §0.63 (爹接棒 W3): SessionContainer 接管所有 session-scoped 状态 (替代裸 Map)
const { getContainer: _getSC } = require('./session_container');
const _sessionContainer = _getSC();
const { guardAnswer: _guardAnswerAlignment, isOrchestrationLeak: _isOrchestrationLeak, alignmentQuestion: _alignmentQuestion } = require('./answer_alignment');
const { isHeavyDigestTask: _isHeavyDigestTask } = require('./answer_alignment'); // 2026-09-12 铁律23 三次: 大体量任务共享谓词
const { hasArtifactEvidence: _hasArtifactEvidence } = require('./answer_alignment'); // 2026-09-12 七次: 证据锚点主判
// 2026-10-28: 连续性容器记主人原话, 不记注入块拼过的版本。
// 否则容器跟请求永远对不上, 每一轮都把上一轮再塞一遍进 messages。
// 口径真源在 j2_loop_shared (turnText / lastUserRaw), 别在这儿再抄一份。
const { turnText: _turnText, lastUserRaw: _lastUserRaw } = require('./j2_loop_shared');
const { isAnthropic: _isAnthropicModel } = require('./model_transport');
const _forceCompactQueue = _sessionContainer._compactQueue;
const _sessionLastRoundAt = _sessionContainer._lastRoundAt;
const _sessionCompactTickAt = _sessionContainer._compactTickAt;
const _sessionCompactMaxAttempts = _sessionContainer._opts.maxAttempts;
// §0.33 逻辑已迁到 session_container (去重/限频/上限由 container.requestForceCompact 统一处理)
function _markRoundActivity(sessionId) { if (sessionId) _sessionLastRoundAt.set(sessionId, Date.now()); }
// 2026-09-16 一期②: 本 session 累计输入 token (交接触发用), 从共享 session state 读
// 2026-09-16: 估算消息数组的 input token (中文字≈2/char, 英文≈4/char 混合取 3), 供 metrics 无 usage 时回填
function _estimateInputTokens(msgs) {
  if (!Array.isArray(msgs)) return 0;
  let chars = 0;
  for (const m of msgs) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) for (const b of m.content) if (typeof b.text === 'string') chars += b.text.length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 3);
}

function _getSessionInputTokens(sessionId) {
  try {
    const _ss = _j2SessionStates.get(sessionId);
    return (_ss && _ss.inputTokensAccum) || 0;
  } catch (_) { return 0; }
}
function _autoCompactWatchdogTick() {
  // §0.63: container 接管去重/限频/上限, watchdog 只负责调度
  const idleMs = parseInt(process.env.PANGU_COMPACT_IDLE_MS || String(15 * 60 * 1000), 10);
  const idleSids = _sessionContainer.watchdogTick(idleMs);
  for (const sid of idleSids) {
    const r = _sessionContainer.requestForceCompact(sid);
    if (r.queued) {
      try { require('./budget').resetRoundsAfterCompaction(sid); } catch (_) {}
      console.warn('[j2-auto-compact] §0.33 idle, queued force-compact for', sid, '(attempts=' + r.attempts + '/3)');
    }
  }
  const cleaned = _sessionContainer.gc();
  if (cleaned > 0) console.log('[j2-gc] §0.63 cleaned', cleaned, 'idle sessions');
}
// watchdog 默认 60s 扫一次 (env PANGU_AUTO_COMPACT_INTERVAL_MS 可调)
const _autoCompactTimer = setInterval(_autoCompactWatchdogTick, parseInt(process.env.PANGU_AUTO_COMPACT_INTERVAL_MS || '60000', 10));
if (typeof _autoCompactTimer.unref === 'function') _autoCompactTimer.unref();
function requestForceCompact(sessionId) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  // §0.63: container 处理去重/限频/上限, 主循环只 wrap 一下 + reset budget
  const r = _sessionContainer.requestForceCompact(sessionId);
  let bReset = null;
  if (r.queued) {
    try {
      const budget = require('./budget');
      if (budget && typeof budget.resetRoundsAfterCompaction === 'function') {
        bReset = budget.resetRoundsAfterCompaction(sessionId);
      }
    } catch (_) { /* budget 模块缺时忽略 */ }
  }
  return { ok: true, queued: r.queued, reason: r.reason || null, session_id: sessionId, budget_reset: bReset };
}
// 2026-10-15: 手动强制压缩改成**当场做**, 不再只是往队列里塞一个条目。
//
// 现场 (实测, 2026-10-15 21:4x):
//   POST /api/pangu/admin/compact {"session_id":"fctest-1"}
//     → {"ok":true,"queued":true,"budget_reset":{"ok":true,"resets":1}}
//   再给这个 session 连发两条消息 → 队列条目纹丝不动, session 文件也没变。
//
// 根因: 队列唯一的消费者在主循环内 (本文件 §0.32 那段), 而**主循环只对子 session 跑**
//   —— 实测 `fctest-1` 走 dispatcher, 自己 spawn 的是 `fctest-1#sub-0-analyzer`,
//   真正进那个循环的 `_sessionId` 永远是子 id。UI 上照抄的主 session id 入队之后
//   永远不会被消费, 而接口还回了 ok:true, 外加白白 reset 了一次 round budget
//   (为一个永远不会发生的压缩发额度, 这本身就是个额度漏洞)。
//
// 修: 磁盘上有这个 session 就当场压 + 落盘, 回真实的 before/after;
//   只有磁盘上没有 (纯内存会话) 才退回排队, 并**如实说明**是排队不是已执行。
//   空闲自动压缩那条路不用动 —— watchdog 和消费者用的是同一批 _sessionId (都是子 session),
//   实测两者本来就对得上。
async function forceCompactSessionNow(sessionId) {
  const store = require('./session_store');
  let sr = null;
  try { sr = await store.sessionLoad({ session_id: sessionId }); } catch (_) { sr = null; }
  if (!sr || !sr.ok || !sr.result) return { ok: false, reason: 'not_persisted' };
  const rec = sr.result;
  const msgs = Array.isArray(rec.messages) ? rec.messages : [];
  if (msgs.length < 2) return { ok: false, reason: 'too_short', from: msgs.length, to: msgs.length };
  let r = null;
  try {
    _compactor.register(sessionId, msgs);
    r = await _compactor.compact(sessionId);
  } catch (e) {
    return { ok: false, reason: 'compact_failed', error: e.message, from: msgs.length, to: msgs.length };
  }
  const out = r && r.compactedMessages;
  if (!Array.isArray(out) || out.length === 0) {
    return { ok: false, reason: 'compact_produced_nothing', from: msgs.length, to: msgs.length };
  }
  try {
    // spread 整个已落盘记录再只换 messages —— serializeSession 是从 args 逐字段取的,
    // 只传 {session_id, messages} 会把 plan_state / state / compaction_summary 全抹成默认值,
    // 断点续跑和 checkpoint 就跟着废了。
    await store.sessionSave(Object.assign({}, rec, {
      session_id: sessionId,
      messages: out,
      compaction_summary: (r.summary && typeof r.summary === 'string') ? r.summary : (rec.compaction_summary || ''),
    }));
  } catch (e) {
    return { ok: false, reason: 'persist_failed', error: e.message, from: msgs.length, to: msgs.length };
  }
  return { ok: true, mode: 'inline', from: msgs.length, to: out.length, ratio: r.compactRatio };
}

// 对外入口 (HTTP /api/pangu/admin/compact 走这个)。先试当场压, 压不了才排队。
async function forceCompactSession(sessionId) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  let bReset = null;
  const _resetBudget = () => {
    try {
      const budget = require('./budget');
      if (budget && typeof budget.resetRoundsAfterCompaction === 'function') {
        bReset = budget.resetRoundsAfterCompaction(sessionId);
      }
    } catch (_) { /* budget 模块缺时忽略 */ }
  };
  const inline = await forceCompactSessionNow(sessionId);
  if (inline.ok) {
    _resetBudget();
    return Object.assign({ session_id: sessionId, budget_reset: bReset }, inline);
  }
  // 当场压不了, 只有**容器里确实认识这个 session** 时才值得排队 —— 排队是给
  // "它下一次进主循环时顺手压掉" 用的。一个压根不存在的 session id 排进队列,
  // 永远不会有人来消费, 白占一个 Set 条目, 还会白拿一份 round budget。
  // (实测踩过: POST 一个乱写的 session_id → {"ok":true,"queued":true} + budget_reset,
  //  之后它就永远躺在 /api/pangu/admin/compact-queue 里。)
  let _known = false;
  try {
    _known = !!(typeof _sessionContainer.getLastRoundAt === 'function' && _sessionContainer.getLastRoundAt(sessionId))
      || (Array.isArray(_sessionContainer.listCompactQueue()) && _sessionContainer.listCompactQueue().includes(sessionId));
  } catch (_) { _known = false; }
  if (!_known) {
    return {
      ok: false,
      session_id: sessionId,
      queued: false,
      mode: 'rejected',
      reason: inline.reason || 'unknown_session',
      note: '磁盘上没有这个 session, 容器也不认识它 —— 无从压缩, 不入队也不发预算。请确认 session_id 是否写错。',
      budget_reset: null,
    };
  }
  // 磁盘上没有 → 退回排队。必须说清楚这是「排队」, 不是「已压缩」。
  const r = _sessionContainer.requestForceCompact(sessionId);
  if (r.queued) _resetBudget();
  return {
    ok: false,
    session_id: sessionId,
    queued: r.queued,
    mode: 'queued',
    reason: r.reason || inline.reason || null,
    note: inline.reason === 'not_persisted'
      ? '该 session 不在磁盘上, 无法当场压缩; 已排队等它下一次进主循环 (主 session 走 dispatcher, 不会进那个循环)'
      : ('当场压缩未成功 (' + inline.reason + '), 已退回排队'),
    budget_reset: bReset,
  };
}
function listForceCompactQueue() { return Array.from(_forceCompactQueue); }
// 2026-08-23 R16 修: STATUS_FOUNTAIN_GUARD 触发 → 实时把哑火 model push 进 _recordRecentFail
// 进程内 LRU 黑名单, 下次 route() 自动降权, 跨请求立即生效
let _smartRouter = null;
try { _smartRouter = require('./router/smart_router'); } catch (_) {}
function _recordModelFailure(modelId) {
  try { if (_smartRouter && _smartRouter._recordRecentFail) _smartRouter._recordRecentFail(modelId); } catch (_) {}
}
// 2026-09-07 主人拍: "关了自动选择, 现在还不成熟, 等以后再说"
// 默认关闭；模型池成熟后通过环境变量显式开启。
const { isSilentFailFallbackEnabled, isRouterDemoteEnabled } = require('./j2_model_policy');
const j2Helpers = require('./j2_helpers');
// 2026-08-12 §R131-Phase3: L3 自适应 prompt 注入 (读 L2 当日聚合, 按天缓存于 l2-miner)
// 2026-09-03 修 #R80-sysinject (老板报"盘古突然换问题转不过来"): require 包 try/catch —
// 任一 require 失败 / getGlobalRules 内部 os.userInfo() 在某些 sandbox 抛 EACCES →
// 整段 system 注入抛错 → SSE 流挂掉, 客户端收到空回复/换问题。
let _getL2Hint;
try { ({ getL2Hint: _getL2Hint } = require('../scripts/l2-miner.js')); }
catch (_) { _getL2Hint = () => ''; /* l2-miner 缺失时静默返空 */ }
const panguHelpers = require('./pangu_helpers');
// #5 全局 prompt 约束: 注入到 native + legacy 两路径 system 顶部
// 2026-09-03 修 #R80-sysinject: 同样 try/catch — getGlobalRules 内部 os.userInfo() sandbox 下抛 EACCES 会带挂整段
let _getGlobalRules;
try { ({ getGlobalRules: _getGlobalRules } = require('./global_agent_rules')); }
catch (_) { _getGlobalRules = () => '[你是 Pangu — 全局规则模块暂不可用, 以最小可用 system 继续]\n'; }

// 2026-10-15: 全局铁律注入必须**幂等**。
// 模型链 fallback (silent_failure → 换模型重试) 会带着已经注入过的 messages 递归调本函数
// (见下面 _runAgentLoopLegacyStream 里的 chain-switch), 而那次只剥空调 assistant 消息,
// 注入块留在数组里 → 再前置一份。实测一次请求叠到 3 份, 每份 5302 token,
// 占 28560 token 提示词的 56%, 而且逐份重复喂给本地模型 (每份 ≈ 18s prefill)。
const _GAR_MARK = '[运行环境 — 路径铁律]';
// 2026-10-16: 原来不管什么角色, 开头一律写死 "你是 Pangu" —— 于是子 agent 读到的是
// "你是 Pangu, 内部 127 个工具, 有 64 卦内核, 能改自己的代码", 而它实际是 executor,
// 手上只有 17 个工具、只该干被派的那一件事。这和"提示词说有 127 个工具而 schema 只给
// 17 个"是同一类错: 提示词在描述一个**它不是**的身份。worker 直接点名角色。
function _identityLineFor(scope, role, modeSuffix) {
  if (scope === 'worker' && role && role !== 'main') {
    return `你是 Pangu 的子 agent · ${role}。你只负责被派给你的这一件事, `
      + `完成或失败都要如实上报, 不代表主人, 不做你没被派的活。\n`;
  }
  // 2026-10-25 (第 82 批): **planner 不注入身份行**。
  //   拆解轮的身份是 dispatcher **自己那条** system 消息给的:
  //     「你是 Pangu 的主 agent (乾), 这一轮**只**负责一件事: 把主人的任务拆成 2~6 个…」
  //   再补一句「你是 Pangu」是**冲突**而不是补充 —— 那条 dispatcher 消息还带着
  //   ①-⑦ 七条铁律 (只能调 dispatch_subagents / 每刀自足 / 路径逐字照抄 /
  //   拆不动就别调工具…)。身份补一句不改行为, 只是多一层噪音。
  if (scope === 'planner') return '';
  return modeSuffix ? '你是 Pangu (' + modeSuffix + ')' : '你是 Pangu';
}
function _hasGlobalRulesIn(messages) {
  for (const m of messages || []) {
    if (m && typeof m.content === 'string' && m.content.indexOf(_GAR_MARK) === 0) return true;
  }
  return false;
}
function _injectGlobalRulesOnce(messages, idx, priorCtx, buildTail, scope, role) {
  // 判定粒度是**整个数组**, 不是目标那一条: 模型链 fallback / auto-resume 之后,
  // "最后一条 system" 可能已经变成新 push 进来的 WARNING, 逐条判定就会把同一段
  // 全局铁律塞进另一条消息, 变成第 2 份、第 3 份 (实测 at[7,8,11], 每份 6544 token)。
  if (_hasGlobalRulesIn(messages)) return false;
  const cur = String((messages[idx] && messages[idx].content) || '');
  // 2026-10-16: scope 决定下发哪一档。子 agent 拿 worker 档(铁律 3680→1577 tk,
  // 且不再注入 64i/digest/痛觉日志), 主 agent 一个字都不少。
  // 2026-10-25 (第 82 批): 三档。planner 用 **worker 档铁律**。
  //   理由: 全局铁律那 27 条分档的依据是"这条约束的是谁" ——
  //     worker 留的是诚实与工具纪律 (失败要明说 / 不能嘴上说 / 未完成禁止说完成),
  //     主 agent 独占的是"盘古怎么面对主人"+"盘古怎么管自己"
  //     (自我修改授权 / 卦先于推理 / 对话风格 / 按顺序一个来 / 大体量任务自拆)。
  //   拆解轮**既不面对主人也不管自己** —— 它只判"拆不拆、拆几刀、每刀干什么"。
  //   「大体量任务必须自拆」那条尤其不能给它: 拆解轮**就是**拆解器,
  //   再让它去自拆 = 让它自己当 dispatcher 派活, 双层调度。
  const _scope = (scope === 'worker' || scope === 'planner') ? scope : 'main';
  // 2026-10-16 实机取证 (executor 画像 msgs=7): worker 身份行原来只接在下面两个
  // unshift 兜底分支上, 而实机走的是**本函数**这条 (messages 里已经有 system 消息),
  // 于是 worker 全程只看到「你是盘古 (Pangu)」+「你是 Pangu 的 Executor」——
  // 从没被告知"你是子 agent, 只做被派的那一件事, 做完如实上报"。
  // 只给 worker 补: main 的身份本来就由 soul 块首行声明, 给 main 也补一遍会改动
  // 主 agent 的提示词 (回归风险, 没有对应收益)。
  const _idLine = (_scope === 'worker' || _scope === 'planner') ? _identityLineFor(_scope, role, '') : '';
  // 2026-10-25 (第 82 批): **planner 档不注入 priorCtx**。
  //   priorCtx 是**跨会话**的上下文 (最近 3 个会话的 checkpoint) ——
  //   里面装的是别的主人对别的活说的话, 甚至包含**上一轮的拆解轮 prompt**。
  //   拆解轮的活恰恰是**把任务切小**: 喂它上一轮的切法原文, 它只会照抄。
  //   主人这一轮的话 dispatcher 已经原样送进来了 (_planTask = _historyBlock + userInput),
  //   当前会话的历史在 _historyBlock 里 —— 那些才是它该看的。
  //
  //   ⚠ 判据必须落在**这里** (注入机制), 不能只靠取值处短路 ——
  //     _injectGlobalRulesOnce 有 4 个调用点 (legacy/native × 注入/兜底 unshift),
  //     少改一个就漏。作用域判断放在注入函数里, 一处管全部。
  //
  //   main 档照旧拿 —— 跨会话连续性是**主对话**的价值 (老板 2026-09-03 报的
  //   "没办法引用上一条 Session"), 一段都不能少。
  const _prior = (_scope === 'planner') ? '' : (priorCtx || '');
  messages[idx] = { ...messages[idx], content: _getGlobalRules(_scope) + _readSelfKnowledge(_scope) + _readMemorySnapshot(_scope) + _idLine + cur + _prior + buildTail };
  return true;
}
// 2026-09-17 全修: 自我认知注入 — 盘古必须知道自己有什么 (64i 真源 + digest 已有账本), 不许从零推算
let _getSelfKnowledge;
try {
  _getSelfKnowledge = () => {
    const fs = require('fs');
    const path = require('path');
    let parts = [];
    // 1. 64i 真源 (仓库内, 每次启动读目录树 + 关键数据摘要)
    try {
      const hex = require('./64i/hexagrams');
      const list = hex.HEXAGRAMS || hex;
      const sample = list.slice(0, 3).map(h => h.name + '(' + h.nature + ')').join('/');
      parts.push('[本体 64i 真源 — 你有这些数据, 消化/整理/对比 64 卦任务先查这里, 不许从 extracted/ 或记忆推算]\n' +
        '  apps/core/64i/hexagrams.js: ' + list.length + ' 卦完整定义 (卦辞/爻辞/八宫/纳甲/五行/nature) — 例: ' + sample + '\n' +
        '  前端 #/hexagrams 页面直接渲染此数据 — 改 64i = 改前端, 不是两份独立数据\n' +
        '  其他: hexagram_vector.js (二进制映射) / symbol_table.js (卦象符号) / yao_models.js (爻模型) / bagua_annotations.js (八卦万物类象)\n');
    } catch (_) {}
    // 1b. 位运算推理内核 (64卦二进制 → 确定性决策, 2026-11-24 老板拍)
    try {
      const inf = require('./64i/gua_inference');
      const enc = require('./64i/gua_encoding');
      parts.push('[本体 64i 推理内核 — 64卦=2^6完备态, 384爻=状态转移, 位运算驱动决策]\n' +
        '  64i/gua_inference.js: infer(binary, 动爻位) → 5卦位串(本/之/互/综/错) + 确定性决策(进/守/固/争/避)\n' +
        '  64i/gua_encoding.js: 万物→64态 编码 (时间/数字/物象/方位 四法)\n' +
        '  64i/yao_transform.js: 互/综/错 纯位运算 (互=位1-4‖2-5, 综=NOT, 错=XOR 111111)\n' +
        '  64i/yao_transitions.js: 384 爻状态转移矩阵 (哪爻动→下一态, 64×6=384行 + 64静态自持)\n' +
        '  用法: 起卦得 binary → infer → 拿 5 位串 + 决策做推理, 不查断语表 (零幻觉)\n');
    } catch (_) {}
    // 2. digest 已有账本 (易经仓库, 读 _STATUS 文件如果存在)
    try {
      // 语料库不在仓里 ⇒ 路径由 PANGU_CORPUS_ROOT 指向, 没配就不读 (不猜路径)。
      const _corpusRoot = (process.env.PANGU_CORPUS_ROOT || '').trim();
      const statusFile = _corpusRoot
        ? path.join(_corpusRoot, '易经', 'digest', '_STATUS_消化现状_20260917.md')
        : '';
      if (statusFile && fs.existsSync(statusFile)) {
        const head = fs.readFileSync(statusFile, 'utf8').split('\n').slice(0, 12).join('\n');
        parts.push('[digest 已有账本 — 动手前先看, 已有的不重写]\n' + head + '\n');
      }
    } catch (_) {}
    // 3. 痛觉日志 (最近 3 条)
    try {
      const painFile = path.join(require('os').homedir(), '.pangu/pain_log.md');
      if (fs.existsSync(painFile)) {
        const lines = fs.readFileSync(painFile, 'utf8').trim().split('\n');
        const recent = lines.slice(-6).join('\n');
        parts.push('[痛觉日志 — 最近的教训]\n' + recent + '\n');
      }
    } catch (_) {}
    return parts.length ? '\n' + parts.join('\n') : '';
  };
} catch (_) { _getSelfKnowledge = () => ''; }
// Defensive compatibility for sessions/processes that loaded the pre-2026-09
// variant where this value was accidentally initialized to a string.
const _readSelfKnowledge = (scope) => {
  // 2026-10-16 (老板: "子 agent 只做自己相关的"): **只给主 agent**。
  // 这三样是盘古的"家底", 不是 worker 的:
  //   [本体 64i 真源]     64 卦数据 —— worker 不做 64 卦任务, 也不该知道盘古有这些文件
  //   [digest 已有账本]   某次消化任务的现状 —— 与 worker 手上的活无关, 而且是**别人那次的快照**
  //   [痛觉日志]          主 agent 被老板骂后的教训
  // 实测这一块 ~800 token, 每个子 agent 每轮白背。worker 的纪律由 GLOBAL_AGENT_RULES
  // 的 worker 档负责(见 global_agent_rules.js 顶部的分档说明)。
  // 2026-10-25 (第 82 批): planner 同样返回空。
  //   自我认知那三样是盘古的"家底": 64i 卦表 / digest 已有账本 / 痛觉日志。
  //   拆解轮不查 64i (那是主对话和术数支线的事), 也不读 digest ——
  //   它这一轮唯一要判断的是"这活能不能切成 2~6 刀"。
  //   实测现场 39268686: 拆解轮那一轮自我认知占 6964 字 (占 in=15366 的 15%)。
  if (scope === 'worker' || scope === 'planner') return '';
  try {
    return typeof _getSelfKnowledge === 'function'
      ? _getSelfKnowledge()
      : (typeof _getSelfKnowledge === 'string' ? _getSelfKnowledge : '');
  } catch (_) {
    return '';
  }
};
// 2026-10-30 (第 173 批): 记忆快照注入 —— 盘古版的「开局自动 recall」。
//
// 老 openclaw 靠 `local.mo-memory-auto-recall` (每 30min) + `hooks.internal.bootstrap-extra-files`
// 把记忆当常驻文件注入每次会话。那条链退役了 (每 30min 拉起 597MB 运行时, 而唯一
// 消费者是已死的 gateway), 但**能力本身不能丢** —— 盘古这边 grep 不到任何等价的注入点。
//
// 口径跟 _readSelfKnowledge 一致: **只给主 agent** (worker/planner 档不注入)。
//   理由跟自我认知一样 —— 子 agent 每轮白背一段没有上下文的记忆是纯浪费
//   (实测: 自我认知那块 ~800 token, 每个子 agent 每轮都在付这个钱)。
// 全程 try/catch: 记忆不可用不许影响主流程 (注入抛错 ⇒ SSE 挂 ⇒ 客户端空回复)。
const _buildMemorySnapshot = (() => {
  try {
    const { buildMemorySnapshot } = require('./memory_snapshot');
    return () => buildMemorySnapshot();
  } catch (_) { return () => ''; }
})();
const _readMemorySnapshot = (scope) => {
  if (scope === 'worker' || scope === 'planner') return '';
  try {
    const s = _buildMemorySnapshot();
    return s ? '\n' + s + '\n' : '';
  } catch (_) {
    return '';
  }
};
// 2026-08-02 路标 (盘古自排查盲点): 64 卦注入不在本文件装配 —
// 在 HTTP 入口 pangu_agent_stream.js: 非闲聊输入先经 gua_engine.castGua 起卦,
// _formatGuaFirstBlock 把卦象/真爻辞前缀进用户消息开头, 再流进本 loop。
// 另: dispatcher 子任务卦行在 j2_dispatcher.js _guaLine。grep "卦/gua" 请到那两处。
// TL-2 §3: 8 个 ErrorCode enum + Fallback hint registry (TL-2 必修 — 接进生产路径)
const { ErrorCode, wrapToolResult, wrapToolResultWithHooks, isRetryable, getFallbackHint } = require('./error_codes');
// 2026-08-16 P0-1: 断点续跑 — 每 round 落 checkpoint, 30min 内同 sessionId 自动恢复
const { saveCheckpoint, loadLatestCheckpoint } = require('./checkpoint');
// §0.61 (爹接棒 W2.1-2): 中间件框架 — silent-fail + think-strip (checkpoint/evo 框架就绪, 待 W2.5 接入避免双写)
const { MiddlewareChain, createSilentFailMiddleware, createThinkStripMiddleware } = require('./j2_middleware');
// 2026-08-30 §0.31: 跨 session 上下文注入 (新 session 自动读最近 1-3 个其他 session 的摘要)
const { loadRecentSessionContext, buildPriorContextPrompt } = (() => {
  try { return require('./prior_session'); } catch (_) { return { loadRecentSessionContext: () => [], buildPriorContextPrompt: () => '' }; }
})();
// 2026-08-16 P1-2: 危险操作人工审批 (新政 #7 安全治理)
const { requirePermission } = (() => { try { return require('./permission'); } catch (_) { return { requirePermission: null }; } })();
// 2026-08-16 P3: 算力 budget (新政 #8 全要素兜底: 银河算郎对位)
const budget = (() => { try { return require('./budget'); } catch (_) { return { recordRound: () => ({ok:true}), recordToolCall: () => ({ok:true}), snapshot: () => ({}), getBudget: () => null }; } })();
// TL-5 子项 A: Plan Mode (生成 plan, emit SSE event: plan)
const { PlanMode } = require('./plan_mode');
const _planMode = new PlanMode({ plansDir: '.plans/' });
// TL-6: Session Compaction (第 3 个 dead module 接入)
const { SessionCompaction, createCompactor, summarizeMessages } = require('./session_compaction');
// 用 factory 拿默认 config (messageThreshold=50, timeThreshold=0 — v1 改 20 + 30min)
// callLLM 必须 lazy 求值 (init() 之后 _deps 才存在, 用 thunk 函数延迟)
// §0.33 (2026-08-30): 自动压缩阈值全部 env 可调, 默认激进
//   PANGU_COMPACT_MSG_THRESHOLD  默认 50  (message count)
//   PANGU_COMPACT_TOK_THRESHOLD  默认 50000 (chars/4)
//   PANGU_COMPACT_TIME_THRESHOLD 默认 600000 (10min)
//   PANGU_COMPACT_IDLE_MS        默认 900000 (15min idle → 后台 watchdog 自动压)
const _compactor = createCompactor({
  messageThreshold: parseInt(process.env.PANGU_COMPACT_MSG_THRESHOLD || '50', 10),
  tokenThreshold: parseInt(process.env.PANGU_COMPACT_TOK_THRESHOLD || '50000', 10),
  timeThreshold: parseInt(process.env.PANGU_COMPACT_TIME_THRESHOLD || String(10 * 60 * 1000), 10),
  summarizeMessages: (msgs) => {
    const llm = _deps && _deps._callLLMForAgent;  // lazy 求值, 调时 _deps 已就绪
    return summarizeMessages(msgs, { callLLM: llm ? (m, opts) => llm(m, opts && opts.model, []) : null });
  },
});
// ============================================================
// L2 拆分 (2026-08-23): loop 公共件抽到 ./j2_loop_shared
// 主循环函数体保持原样, 只换 import 来源 — 行为零变化
// (公开导出 _looksLikeEmptyPlan / _resolveRoundTimeoutMs 等经由此处 re-export, 对外 API 不变)
// ============================================================
// W1.1 (爹接棒): 抽 inline guard 到 SM
const { createPlanGate } = require('./j2_plan_gate');
const _lcfModule = require('./longctx_fallback');
const _summaryCompletion = require('./summary_completion');
// 2026-10-23 (第 64 批): 超时这一族错误的分类 + 抢救 + 措辞, 唯一真源。
//   详见 modules/timeout_policy.js 的立库注释 (现场: b63-guagate3 撞 STREAM_TOTAL_TIMEOUT_390s,
//   而这一族错误原先**一种都不算基础设施错误**, 于是掉进一句根本不存在的「legacy 降级」)。
const _timeoutPolicy = require('./timeout_policy');

const {
  FOUNTAIN_REPEAT_THRESHOLD,
  WITHIN_TURN_DELTA_REPEAT,
  WITHIN_TURN_DELTA_MIN_LEN,
  WITHIN_TURN_TAIL_LOOP_LEN,
  WITHIN_TURN_TAIL_LOOP_HITS,
  WITHIN_TURN_TAIL_MIN_TOTAL,
  EMPTY_PLAN_MAX_NUDGES,
  _looksLikeEmptyPlan,
  _DANGEROUS_TOOL_NAMES,
  _isDangerousTool,
  TOOL_SELECTION_GUIDE,
  _DEFAULT_ROUND_TIMEOUT_MS,
  _LOCAL_ROUND_TIMEOUT_MS,
  _LOCAL_PROVIDERS,
  _isLocalModel,
  _resolveRoundTimeoutMs,
  _isQuotaError,
  _isInfraError,
  // 2026-10-23 (第 64 批): 超时与瞬断必须分开判 (见 modules/timeout_policy.js)。
  isTimeoutError: _isTimeoutError,
  _preferSameLocalRetry,
  _infraFailText,
  _quotaFailText,
  _j2SessionStates,
  _getOrCreateSessionState,
  PLAN_STATE_TTL_MS,
  _planStateIsStale,
  sanitizeRecalledContent,
  _formatRelevantMemories,
  _logSonaTrajectory,
  _persistSession,
  _injectSonaPatterns,
  _injectGoapPlan,
  _injectRelevantMemories,
  _emitStreamDelta,
  _startPrefillProgress,
  _emitThinkingEnd,
  _emitFinal,
  _j2DetectFountain,
  _stableStringify,
  wantsDirectAnswer,
  buildRoleToolFilter: _buildRoleToolFilter,
} = require('./j2_loop_shared');

// 2026-10-14: 把一次 LLM 调用的耗时/首 token 记进 trace。
// 单独抽出来是因为它有两个调用点 (成功 + 超时/异常) 要共用同一套记账。
function _recordLLMPhaseTiming(opts, tStart, ttft) {
  try {
    const sid = opts && opts.sessionId;
    if (!sid) return;
    // 2026-10-14: 不再每次调用开一个 llm_phase 文件 (现场散成 43 个碎片),
    // 改成往"本次请求"那条 trace 里追加 —— 一次对话一条, 事后能按 root 汇总。
    const rt = require('./run_trace');
    const tr = rt.getSessionTrace(sid);
    if (!tr) return;
    tr.event('llm_timing', {
      total_ms: Date.now() - tStart,
      ttft_ms: ttft == null ? null : ttft,
      round: opts && opts.round != null ? opts.round : null,
      role: (opts && opts.role) || 'main',
    });
  } catch (_) {}
}

async function _callLLMWithTimeout(messages, model, toolsSchema, opts) {
  const _llm = _deps._callLLMForAgent;
  const _roundTimeoutMs = _resolveRoundTimeoutMs(model);
  // 2026-10-14 分段计时: 截图里"agent 自报 11.9s 但 UI 显示 42s, 响应栏空白"这个现象
  // 一直没法归因, 因为**全仓 14 处计时字段全是 durationMs, ttft / firstTokenMs /
  // responseMs 这三个指标根本不存在** —— 不是没记上, 是这个度量从来没被采集过。
  // 在 LLM 调用这一层埋点: 首 token 时间 (onText 第一次触发) + 本次调用总耗时,
  // 以后 UI 那个 42s 就能拆成"真耗时"还是"中间空转"。
  const _tStart = Date.now();
  let _ttft = null;
  const _probe = (opts && typeof opts.onText === 'function')
    ? function () {
        if (_ttft === null) _ttft = Date.now() - _tStart;
        return opts.onText.apply(this, arguments);
      }
    : null;
  const _optsProbed = _probe ? Object.assign({}, opts, { onText: _probe }) : opts;
  const _callPromise = _llm(messages, model, toolsSchema, _optsProbed);  // 2026-08-02: opts 透传 (onText 流式)
  let _timer;
  const _timeoutPromise = new Promise((_, reject) => {
    _timer = setTimeout(() => reject(new Error('LLM_ROUND_TIMEOUT')), _roundTimeoutMs);
  });
  try {
    const _result = await Promise.race([_callPromise, _timeoutPromise]);
    clearTimeout(_timer);
    _recordLLMPhaseTiming(opts, _tStart, _ttft);
    return _result;
  } catch (e) {
    clearTimeout(_timer);
    _recordLLMPhaseTiming(opts, _tStart, _ttft);
    if (e.message === 'LLM_ROUND_TIMEOUT') {
      console.warn(`[j2] §0.31 LLM round 超时 (${_roundTimeoutMs}ms), 可能模型 tool calling 慢或决策卡住`);
      try {
        const _res = opts && opts.res;
        if (_res) _res.write('event: warning\ndata: ' + JSON.stringify({ warning: `LLM round 超时 (${_roundTimeoutMs}ms), 可能模型 tool calling 慢或决策卡住`, session_id: opts && opts.sessionId, ts: Date.now() }) + '\n\n');
      } catch (_) {}
      throw e;
    }
    throw e;
  }
}



// 2026-09-16 老板拍 "开源其他人说话也不和我一样": task_done summary 是否 partial 不靠固定词法 (任何话术都可能不命中) —
// 模型自判: 让模型对照剩余计划 + 本次 summary, 输出固定 JSON {completed, remaining}, 结果写 task_ledger 供下轮断点。
// 词法仅 fallback (模型判定不可用/失败时), 且只覆盖通用进度词 (剩余/TODO/pending/未完成), 不绑特定话术。
// 额度 P0: 只用当前 model 调一次, 不切模型不重试, 任何异常都回退词法, 不阻塞主流程。
async function _judgeSummaryCompletion({ summary, model, _deps, planSteps, _sessionId, soulScope }) {
  const _sc = require('./summary_completion');
  const _fallback = _sc.lexicalProgressShape(summary);
  const _steps = Array.isArray(planSteps) ? planSteps : [];
  // 2026-10-17: 去掉 `|| _steps.length === 0`。这一条让**分析类子 agent 的判官从未被调用过**
  // (它们没有 plan 步) —— 实际决定 partial 与否的一直是词法, 于是 10-16 那次
  // "「③ 未做」不当认罪书"的修复 (改的是下面那段判官提示词的划界规则) 修在了死路上,
  // 线上轮数纹丝不动。现场 ledger sub-0-analyzer lessons=[] steps=[] 即是铁证。
  // 判官不依赖 plan 步; 剩下的计划为空, 恰恰是最该问"这一刀该做的做完了没有"的场合。
  // 成本: 判官一次 2.6~5.5s, 换掉一个必然误判、每轮 10~25s 的白跑续跑轮。
  // (summary_completion.js 里那份拷贝同步改了 —— 两份不同步就等于只修了一半。)
  if (!_deps || !_deps._callLLMForAgent) return _fallback;
  // 2026-10-16 (现场 lt3: 5 步长任务 2190s, 这一处独自吃掉 300s = 全程 13.7%):
  //   PARTIAL_JUDGE_LLM_FAIL, fallback 词法: LLM_SOCKET_TIMEOUT_300s
  // 它做的事有多小? 把一段总结对着剩余计划判一下"全做完了没", 然后吐个 JSON。
  // 它却和真正干活的调用共用一条 300s 的墙 —— 本地 27B 思考一次就能把那 300s 吃干,
  // 然后回退词法, **净收益为零**: 300 秒换一个跟一开始直接用词法一样的结果。
  //
  // 关键在于它**已经有词法兜底** (_lex), 所以这里给个自己的小预算, 超时直接用兜底。
  // 不是砍掉模型判断 —— 正常情况下它几秒就回, 判得比词法准; 只是不再让它有能力
  // 把主人 5 分钟的等待花在一个"判一下完没完"的旁枝上。
  const _JUDGE_BUDGET_MS = 25 * 1000;
  try {
    // 2026-10-16 (现场 lt-after-222442 / 222442 一刀一文件改造的连带修正):
    //   判官原话只有「全部完成 vs 部分完成(还有剩余未做项)」, 而汇报契约
    //   (session_container.REPORT_CONTRACT) **强制**每个子 agent 写一栏「③ 未做」。
    //   于是每个划清了分工边界的离, 都在自己那份「未读兄弟的文件(按指令不扩展)」上
    //   被判成"还有剩余未做项" → completed:false → task_done 被判 partial →
    //   `_tryAutoResume('partial_task_done')` 接管 → 白烧 3~4 轮, 每轮一次 LLM 约 20s。
    //   现场 stderr 里 `[j2-auto-resume] … (done 0→0, files 0→0)` 连着出现 7 次,
    //   分析类任务一格盘都不写, 进展判据结构性地永远是 0。
    //
    // 病根跟收口那层一模一样, 只是更深一层: **契约强制写的那一栏, 被当成了认罪书**。
    // 修法不是放宽判官 (那会把真缺口也放过去), 是把"分工范围"这条判据交给判官:
    // 本刀该做而没做的 = 缺口; 兄弟刀的活 / 明说不扩展的那部分 = 正确划界, 不算。
    // 2026-10-23 (第 59 批): 判官**搬进 summary_completion.js**, 这里只留传输层。
    //   之前这里是一份**内联拷贝** —— 两份的划界规则词表已经漂了
    //   (一份有「本刀范围/已交/未修改」, 一份没有; 一份有「验收结论 PASS/FAIL」,
    //   一份没有)。「两份同义文本各改各的」= 盘古 2026-10-21 亲自踩过的坑。
    //   判官现在问的是**六格条目**而不是布尔: 让模型只列条目(取数),
    //   结论由 64i 的 task_judge.judgeProgress 内核算(判据) ——
    //   与盘古其它地方用六格的方式完全一致。
    const _prompt = _sc.buildProgressJudgePrompt(summary, _steps);
    // 2026-10-16: 这是一次纯 JSON 分类 (toolsSchema 为空, 提示词就三行指令),
    // 却要背 9918 的 soul —— 其中 4291 的工具清单对它更是纯噪音 (它压根不给工具)。
    // soulScope 由调用方按当前 loop 的角色带下来, 见 _runAgentLoopLegacyStream 的传参。
    // 直接判定, 不许 deliberation —— 本地模型的 thinking 在这种分类题上纯烧墙。
    const _prompt2 = _prompt + '\n(这是分类题, 直接给 JSON, 不要分析。)';
    const _call = _deps._callLLMForAgent([{ role: 'user', content: _prompt2 }], model, [], {
      soulScope,
      // 2026-10-24 (第 80 批): 判官压根不给工具 (toolsSchema=[]), 而工具清单原来
      // 还按角色档给它一份 (main 38 个 / 旧 worker 127 个) —— 纯噪音, 还教它去调墙。
      // 「传了但是空」= 这一轮调不到任何工具 ⇒ 清单整块不出。
      callableTools: [],
      // 2026-10-17 时间账: 这个标签让 [llm-cost] 能把"判官烧掉的秒数"从
      // "真正干活的秒数"里分出来。现场 (lt3 一刀一文件) 里判官 22 次全部撞 25s
      // 预算 = 550s 纯烧墙, 而它在时间账里此前完全不显形 —— 混在总时长里看不出来。
      perfTag: 'partial_judge',
    });
    let _timedOut = false;
    const _result = await Promise.race([
      _call,
      new Promise((_, rej) => setTimeout(() => { _timedOut = true; rej(new Error('PARTIAL_JUDGE_BUDGET_' + _JUDGE_BUDGET_MS + 'ms')); }, _JUDGE_BUDGET_MS)),
    ]).catch(e => {
      // 说清楚这一刀真做到了什么: 主循环**不再等**它 (省的是主人那 300 秒),
      // 但摘不掉那个已经在飞的 HTTP 请求 —— _callLLMForAgent 的 AbortController 是它
      // 内部自建的, 没有往外暴露 signal。所以那个请求自己会跑到死或者被端点掐掉,
      // 只是没人再看它的结果。别把这条读成"请求被取消了"。
      if (_timedOut) { try { _call.catch(() => {}); } catch (_) {} }
      throw e;
    });
    const _text = String((!_result) ? '' : (_result.choices ? _result.choices[0].message.content : _result.content) || '').trim();
    const _shape = _sc.parseProgressJudgeText(_text);
    const _judged = _sc.judgeProgressShape(_shape, '这一刀');
    if (!_judged.ok) {
      // 判官没给出可解析的形状, 或六格判局判不出来(条目全空) ⇒ 走词法兜底。
      // 这条纪律与六格内核同款: **宁可不给结论, 也不拿空数据当结论**。
      try {
        require('./task_ledger').recordLesson(_sessionId, 'PROGRESS_JUDGE',
          '判不出(' + ((_judged.error && _judged.error.code) || 'NO_SHAPE') + '), 走词法兜底');
      } catch (_) {}
      return _fallback;
    }
    try {
      require('./task_ledger').recordLesson(_sessionId, 'PROGRESS_JUDGE',
        _judged.verdict_label + ' (' + _judged.source + '/' + (_judged.rule_key || '-') + '): '
        + String(_judged.reason || '').slice(0, 200));
    } catch (_) {}
    return _judged;
  } catch (e) {
    console.warn('[j2-native] PARTIAL_JUDGE_LLM_FAIL, fallback 词法:', e.message);
    return _fallback;
  }
}

// 2026-10-12 (老板报"会话 78325678 一开始还正常, 后续就不对劲", 实锤):
// 工具结果被 `slice(0, 6000)` **静默**截断。bazi_calc 实返 50,874 字符 —— 模型只看到
// 11.8%, 其中 liunian(流年+流月) 占 48,061 字符(94%), 模型只见到 7%。截断点正好切在
// 流月数组中间, 模型收到的是**非法 JSON**(Unexpected end of JSON input), 而且没有任何
// 截断标记 → 它不知道数据没了, 于是凭印象补: "1986 辛酉"(真值庚申)、"2026 乙丑"、
// "2026 甲子"、"2026 庚辰", 三轮自相矛盾。
//
// 修法 (三件事一起, 缺一件都不够):
//   a) 额度从 6000 提到 24000 (env 可调), 并按"同一工具重复调用"递减, 防 5 次 × 大结果打爆上下文;
//   b) 截断**必须留标记**, 绝不再静默;
//   c) 预算不够时按结构裁: 砍掉体积最大的数组字段后重新序列化, 保证模型收到的仍是**合法 JSON**,
//      并在 _truncated 里点名丢了哪些字段, 让模型能说"流月数据没拿到"而不是硬编。
// 2026-10-21: 额度真源收到 run_trace —— 这里原来自己抄了一份。
//   两份常量已经漂过一次: 子 agent 那条路走 run_trace.toolResult(), 它的上限
//   被写成 3000 **字节**; 主循环这份是 24000 **字符**。同一个"工具结果预算"
//   在两个模块里差 24 倍, 而且子 agent 那边没人在旁边看着, 漂了很久没被发现。
//   真源统一到 run_trace (那边两条路径都已经 require 了)。
const TOOL_RESULT_MAX_CHARS = require('./run_trace').TOOL_RESULT_MAX_CHARS;
// 2026-10-17 (现场 q-1792192247770#sub-0-analyzer, 21 轮 / 80 秒空转):
//   角色策略拒掉的调用, 三道按"工具名|参数"分桶的闸门 (self_correct /
//   DUPLICATE_TOOL_CALL / _CROSS_ROUND_FAIL_LIMIT) 一道都不响 —— 因为模型的
//   重试姿势是**每次换参数** (grep 换了又换), 桶永远不同。而旧文案只说
//   "你不能做", 从不说"你可以用这个做同样的事", 于是模型只能一路试到第 14 轮
//   才自己改用 read_file, 中间还花了好几轮 `grep -rn "analyzer"` 调查自己为什么被拦。
//
// 这里只做两件事, 都是纯逻辑 (便于单测):
//   ① 按**工具名**记账 —— 参数怎么换都不影响计数 (这正是现有闸门漏掉的那一维)
//   ② 第一次就点名替代方案, 第二次明确叫停
// 不新造第四套刹车: 被拒调用照旧 blocked:true, 只是把"该怎么换路"讲清楚。
/**
 * 2026-10-23 (第 73 批): 这一句正文是不是"旁白"(打算怎么做), 而不是结论?
 *
 * 现场 (2026-10-23, 会话 b63-guagate, main 角色, 真实用户轮):
 *   「主人给了生辰，这是「长期状态 + 此刻时机」两层题。我先把八字盘排出来，再给今天这个动作起一卦定方向。」
 *   模型调完 bazi_calc + risk_assessment 后说这一句 → 下一轮**原样再说一遍**(0 工具调用)
 *   → 这一句被当最终答复 → 答复门拦下 → 用户拿 ⚠️ 模板 (拿不到答案)。
 *
 * 两条信号 (一条结构, 一条词形, 互补):
 *   'repeat'  —— 与之前某轮 assistant 正文**归一化后完全相同**。
 *                复读是零误伤信号: 同一句"打算"说第二遍 = 卡住, 不是结论。
 *   'promise' —— 承诺句式 (先…再… / 我先…就…)  → guard_patterns.isNarrationText
 *
 * @param {string} text      本轮正文
 * @param {Array}  messages  当前 messages (只查**之前**的 assistant 正文 —— 本轮还没 push)
 * @returns {'repeat'|'promise'|null}
 */
function _isNarrationAfterTools(text, messages) {
  const t = String(text || '');
  if (!t.trim()) return null;
  const norm = (s) => String(s || '').replace(/\s+/g, '').trim();
  const n = norm(t);
  if (n.length >= 12) {
    for (const m of (messages || [])) {
      if (!m || m.role !== 'assistant' || typeof m.content !== 'string') continue;
      if (norm(m.content) === n) return 'repeat';
    }
  }
  try {
    if (require('./guard_patterns').isNarrationText(t)) return 'promise';
  } catch (_) {}
  return null;
}

/**
 * 2026-10-23 (第 73 批): 「调了工具但只嘴说」的收口动作 ——
 * 让模型基于**已返回的工具结果**出一段实做报告。
 *
 * 抽成函数是因为它有两个调用点 (旁白守卫用尽时 / R80 那道闸门), 抄两份必然又岔开。
 *
 * ⚠️ 原来 R80 那道闸门里写的是 `_stripSpecialTokensForFinal(...)` —— **全库没有这个函数**
 * (只有那一个调用点, 没有定义)。它当时够不到所以没炸; 一旦复活就是 ReferenceError 打断整轮。
 * 真正在用的是 j2_helpers._stripSpecialTokens (见本文件 1198 行的同款用法)。
 *
 * @returns {Promise<string|null>} 总结文本; 拿不到就 null (调用方决定怎么诚实收口)
 */
async function _forceToolSummaryReport(ctx) {
  const { messages, model, res, opts, roleScope, isAnthropic } = ctx;
  try {
    const _s = await _callLLMWithTimeout(messages, model, [], {
      res, sessionId: opts.sessionId,
      soulScope: roleScope,
      callableTools: [],   // 第 80 批: tools=[] ⇒ 这一轮调不到任何工具 ⇒ 清单整块不出
    });
    const raw = isAnthropic
      ? ((_s.content || []).filter(b => b.type === 'text').map(b => b.text).join(''))
      : (_s.choices?.[0]?.message?.content || '');
    const clean = require('./j2_helpers')._stripSpecialTokens(
      String(raw || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/<think>[\s\S]*$/g, ''),
    ).trim();
    if (clean && clean.length >= 10) return clean;
  } catch (_) {}
  return null;
}

function _makeRoleDenyGuard(opts) {
  const o = opts || {};
  const stopAt = o.stopAt || 2;
  const alternatives = o.alternatives || ['read_file', 'file_grep', 'search_files', 'list_directory'];
  const altText = alternatives.join(' / ');
  const counts = new Map();
  return {
    // 返回 { count, message, exhausted } —— message 就是要回灌给模型的那段话
    note(role, toolName) {
      const count = (counts.get(toolName) || 0) + 1;
      counts.set(toolName, count);
      const message = count < stopAt
        ? (role + ' 是只读角色, 不能用 ' + toolName + '。'
          + '**不要再换命令重试这个工具** —— 查代码/看配置请改用: ' + altText + '。')
        : (toolName + ' 已经被角色策略连续拒绝 ' + count + ' 次, 不要再调它, 换参数重试也一样被拒。'
          + '立刻改用 ' + altText + ' 取同样的证据; 如果只读工具也拿不到, '
          + '就用 task_done 说明卡在哪个证据上, 别在这里空转。');
      return { count, message, exhausted: count >= stopAt, alternatives };
    },
    // 单测/诊断用: 某工具被拒了几次
    countOf: (toolName) => (counts.get(toolName) || 0),
    total: () => Array.from(counts.values()).reduce((a, b) => a + b, 0),
  };
}

function _fitToolResult(execResult, maxChars) {
  if (typeof execResult === 'string') {
    const cap = maxChars || TOOL_RESULT_MAX_CHARS;
    if (execResult.length <= cap) return execResult;
    return execResult.slice(0, cap)
      + '\n\n...[已截断] 原始长度 ' + execResult.length + ' 字符, 这里只给了前 ' + cap
      + ' 字符 —— 后面还有内容你没看到, 别把没看到的部分当成不存在。';
  }
  const cap = maxChars || TOOL_RESULT_MAX_CHARS;
  let text;
  try { text = JSON.stringify(execResult); }
  catch (_) { return String(execResult); }
  if (text.length <= cap) return text;

  // 结构化裁剪: 按字段体积从大到小砍数组, 砍到能装下为止, 保持 JSON 合法
  try {
    let clone = JSON.parse(text);
    const dropped = [];
    const sizeOf = (v) => { try { return JSON.stringify(v).length; } catch (_) { return 0; } };
    for (let guard = 0; guard < 40; guard++) {
      let s = JSON.stringify(clone);
      if (s.length <= cap) break;
      // 找 data 下最大的数组字段 (排盘类结果都挂在 data.pillars 下)
      const bags = [clone, clone.data, clone.data && clone.data.pillars].filter(Boolean);
      let best = null;
      for (const bag of bags) {
        for (const k of Object.keys(bag)) {
          const v = bag[k];
          if (!Array.isArray(v) || v.length < 2) continue;
          const sz = sizeOf(v);
          if (!best || sz > best.sz) best = { bag, k, v, sz };
        }
      }
      if (!best) break;
      const half = Math.max(1, Math.floor(best.v.length / 2));
      const kept = best.v.slice(0, half);
      dropped.push(best.k + ' (' + best.v.length + ' → ' + half + ' 条, 已丢 ' + (best.v.length - half) + ' 条)');
      best.bag[best.k] = kept;
    }
    let finalText = JSON.stringify(clone);
    if (finalText.length <= cap) {
      clone._truncated = '为塞进 ' + cap + " 字符预算, 以下字段已砍半甚至丢弃: " + dropped.join('; ')
        + ' —— 这些数据你没看到, 回答涉及它们时必须说"未获取", 禁止凭印象补。';
      finalText = JSON.stringify(clone);
      if (finalText.length > cap) { // 标记本身超预算就退回硬截, 但仍留标记
        finalText = finalText.slice(0, cap) + '\n...[已截断]';
      }
      return finalText;
    }
  } catch (_) { /* 落到硬截 */ }
  return text.slice(0, cap)
    + '\n\n...[已截断] 原始长度 ' + text.length + ' 字符, 这里只给了前 ' + cap
    + ' 字符 —— 后面还有内容你没看到, 别把没看到的部分当成不存在。';
}

async function _runAgentLoopLegacyStream(messages, model, req, res, opts) {
  // 2026-10-17 (老板拍: 「乾就应该把任务拆了, 分下去」): 把本函数注册给
  // dispatch_subagents_exec —— 主 agent 调 dispatch_subagents 时, 由那个执行器
  // in-process 回调**这个** loop 去跑每一刀。不能在那儿直接 require 本模块 (自循环),
  // 也不能另写一份子 agent loop (那就是"同一份东西抄两遍 = 迟早只改其中一份")。
  try {
    require('./dispatch_subagents_exec').registerLoop({ _runAgentLoopLegacyStream });
  } catch (_) {}
  // J2 主循环 — 设计文档 docs/J2-design.md
  // W1.1 (爹接棒): per-request State Machine — 避免 module 单例串扰 + res leak
  const _planGate = createPlanGate({ maxNudges: EMPTY_PLAN_MAX_NUDGES });
 // 真正能用 — 探测到 model 支持 native tool_calls 时走 native 路径
  //   legacy XML 路径保留作 fallback (model 不支持 function calling 时降级)
  // §0.56 修: session-scoped state, 跨调用隔离 (替换顶层 _state.planState / _j2LastRoundText / _j2FountainRepeat)
  const _sessionId = opts.sessionId || (opts.reqBody && opts.reqBody.session_id) || 'default';
  const userInput = opts.userInput || '';

  // 2026-10-24 (第 75 批): 回灌腰斩 → 答复开头丢失 / 正文重复。
  //   现场 desktop-verify74-1792774960: r1 是一份 2064 字的**完整**答复,
  //   守卫 (0 工具 + 系统状态断言) 命中后, 回灌只把 `textContent.slice(0, 300)`
  //   塞回上下文 ⇒ 模型看不到自己后面写的 1764 字 ⇒ 下一轮从断点续写,
  //   final 只发后半段 ⇒ **开头 300 字永久消失**。
  //   _replayRecord 记住"上一轮被腰斩的完整正文 + 腰斩位置",
  //   终稿出口据此把被砍掉的头**确定性地**接回去 (模块 answer_continuity)。
  let _replayRecord = null;
  let _continuityMerged = false;
  // 2026-10-24 (第 75 批 b): 答复里被剥掉过内部标记 ⇒ final 必须带 replace 位。
  //   原因: 洗干净的稿子比流式**短**, 前端「流式更长就不换」那条规则会把洗干净的稿丢掉,
  //   留下带标记的脏流式 —— 修了反而更糟。
  let _internalMarkerStripped = false;
  const _continuity = require('./answer_continuity');
  // 内部标记剥除的**单一真源** (判据 + 白名单见 modules/internal_markers.js)。
  const _internal = require('./internal_markers');
  /**
   * 统一回灌入口 —— 全部 14 处腰斩回灌都走这里。
   *   kind  : 哪个守卫在回灌 (只进日志, 便于事后定位)
   *   text  : 本轮模型原文
   *   limit : 回灌时给的字符上限
   * 一条保证: assistant 轮的内容与旧行为**逐字一致** (复读检测依赖它的前 100 字)。
   *   ⚠️ 这里**不许**再往上下文里塞我们自己的标记 ——
   *   实跑 (verify75c-1792780764, 2026-10-24) 证过: 模型会把紧挨 assistant 片段的
   *   system 标记**整段抄进答复** (142 字一字不差), 用户气泡尾巴上就挂着一段
   *   「[CONTINUITY] 上一条 assistant 消息是…」。概率层(标记)还压根没起作用 ——
   *   模型照样从断点续写。**既没生效又漏给用户看的机制不能上生产** ⇒ 只留保证层。
   */
  const _pushReplay = (kind, text, limit, prefix) => {
    const raw = String(text == null ? '' : text);
    const lim = Math.max(0, Number(limit) || 0);
    // 腰斩位置要记在**think 剥掉后**的坐标上, 否则还原时接缝会错位
    const clean = _continuity._stripThink(raw);
    // 链式还原: 本轮原文自己可能已经是上一段被腰斩后的续写, 先把更早断点接回去
    const restored = _continuity.reconstruct(raw, _replayRecord);
    _replayRecord = { full: restored.text, cut: Math.min(lim, restored.text.length) };
    messages.push({ role: 'assistant', content: (prefix ? prefix : '') + raw.slice(0, lim) });
    return { cut: _replayRecord.cut, clean: clean };
  };
  /**
   * 答复连续性还原 (确定性)。
   *   守卫腰斩回灌后, 模型可能从断点续写, 交出的是**从半句开始**的正文。
   *   这里把被砍掉的开头接回去 —— 提示词只能压低概率, 这里才是保证。
   *   幂等: 已经接过头的文本再走一次不会二次拼接。
   *   顺带剥掉我们自己的内部标记 —— 实跑见过模型把 [CONTINUITY] 整段抄进答复。
   *   剥**两道**: 还原前 (对齐判据要跑在干净文本上) + 还原后 (接回来的那半截
   *   也可能带标记)。幂等, 剥两次结果一样。
   */
  const _applyContinuity = (text) => {
    const _raw = String(text == null ? '' : text);
    const _s1 = _internal.stripInternalMarkerLines(_raw);
    const _rec = _continuity.reconstruct(_s1.text, _replayRecord);
    if (_rec.merged) {
      _continuityMerged = true;
      console.warn('[j2] ANSWER_CONTINUITY: 答复从腰斩断点续写, 已接回被截掉的开头 (重叠 ' + _rec.overlap + ' 字)');
    }
    const _s2 = _internal.stripInternalMarkerLines(_rec.text);
    // 剥过东西 ⇒ 洗干净的稿子比屏上流出来的**短** ⇒ 前端「流式更长就不换」那条规则
    //   会把洗干净的稿整个丢掉, 留下脏的流式。所以这里必须记一笔, 让 final 带 replace。
    //   ⚠️ 判据必须精确到「**标记**被剥掉了」, 不能用「输出 != 输入」——
    //     reconstruct 会顺手剥 think 标签, 那样会把「没剥过标记」也误判成剥过,
    //     于是 final 白白多带一个 replace 位 (行为漂移)。
    if (_s1.stripped || _s2.stripped) _internalMarkerStripped = true;
    return _s2.text;
  };
  // A model id supplied by the picker is an explicit user choice. Automatic
  // cost/long-context failover must not silently replace it mid-request.
  const _manualModelSelection = Boolean(opts && opts.reqBody && opts.reqBody.model);
  // 只有明确续跑才允许旧任务状态进入本轮; 新问题必须建立自己的上下文边界。
  const _isExplicitContinuation = String(userInput || '').includes('【续跑约束】');
  // 工具/计划守卫只服务于明确的执行型请求; 普通问答不应被强行包装成任务。
  const _isTaskExecutionRequest = _isExplicitContinuation
    || _isHeavyDigestTask(userInput)
    || /(排查|修复|修改|实现|写入|读取|查看文件|运行|测试|检查|分析文件|生成|创建|删除|提交|部署|安装|搜索|查找|打开|截图|执行|做完|全部做|按顺序)/.test(String(userInput || ''));
  // 2026-09-16: _roleForThisLoop 提前算 (后面工具白名单要用)
  const _roleForThisLoop = (opts && opts.role) || 'main';
  // 2026-10-16: 同一个 loop 里, 全局铁律和"盘古家底"按角色分档下发。
  // 与 soulScope 是同一件事的两半 —— soulScope 管 llm_caller 那几块 soul,
  // _soulScope 管这里拼的 [运行环境 — 路径铁律] + 自我认知。两个都要按角色走,
  // 少一个就等于子 agent 还在白背主 agent 的上下文。
  //
  // 2026-10-25 (第 82 批): **soulTier 独立通道**。
  //   以前 soulScope 是从 role 推出来的 (role==='main' ? 'main' : 'worker'),
  //   也就是**只有两档**。但拆解轮 (dispatcher 让主 agent 派活的那一轮)
  //   走的是 role='main' —— 它既不是主对话, 也不是子 agent。
  //
  //   为什么必须分出来 (现场 39268686 实测, 不是推演):
  //     拆解轮那一轮 in=15366 token, 而它真能调的只有 **2 个工具**
  //     (dispatch_subagents + task_done), 产出上限是"拆不拆 / 拆几刀"。
  //     它拿的是**完整 main 档 soul**: 主人长期记忆 / 工具清单 / 自我进化 /
  //     源码地图 / 关键路径速查 / Continual Harness / 持久目标,
  //     外加 6358 字的全局铁律 + 自我认知 + **跨会话上下文**。
  //     那段跨会话上下文实测灌进来的是**兄弟刀的 prompt** (带主人全量路径清单),
  //     而拆解轮的活恰恰是**把任务切小** —— 喂它上一刀的原文, 它只会照抄上一轮的切法。
  //
  //   ⚠ **opts.role 一个字都不动** —— role 决定 API schema / 工具白名单 /
  //     只读边界 (gua-identity 的 isReadOnlyRole)。拆解轮必须继续用 role='main',
  //     否则 buildRoleToolFilter 的 enforceToolFilter 就不认它, 它能自己动手干活。
  //     soulTier 是**另一条通道**: 只管"提示词发哪几档"。
  const _soulTier = (opts && opts.soulTier)
    || (_roleForThisLoop === 'main' ? 'main' : 'worker');
  const _soulScope = _soulTier;
  const _state = _getOrCreateSessionState(_sessionId);
  // 2026-10-14: 主对话也开一条"每次请求一条"的 trace。
  // 旧做法是 _callLLMWithTimeout 每次调用各开一个 llm_phase 文件 (现场 43 个),
  // 一次对话散成一堆碎片, 事后没法回答"这一轮总共多久/总共烧了多少 token"。
  // 改成: 入口开一条, 每次调用往里追加 llm_timing, 收尾结算 —— 与将灵 trace 同一套语义。
  let _mainTrace = null;
  if (_roleForThisLoop === 'main') {
    try {
      const _rt2 = require('./run_trace');
      _mainTrace = _rt2.createTrace({ sessionId: _sessionId, agent: 'main', kind: 'main', root: _sessionId });
      _rt2.registerSessionTrace(_sessionId, _mainTrace);
    } catch (_) { _mainTrace = null; }
  }
  const _mainT0 = Date.now();
  // 2026-10-14 (现场取证): 将灵级 trace 必须开在**这里**, 不能只开在 sub-agent.js。
  // 现场日志: `[dispatcher] 将灵上场: executor` + `[j2-role-tools] role=executor ...`
  // 说明 planner 拆出来的子任务走的是 j2 主循环 (opts.role=executor), **不经过 sub-agent.js**
  // —— 而那是最常见的一条路径 (analyzer/executor/checker 三个将灵实测全走它)。
  // 结果: 三个将灵真跑了, harness 里一个 subagent trace 都没有, token/工具结果/上下文继承
  // 全部统计不到。trace 跟着 LLM 调用走, 不跟着角色名走。
  let _roleTrace = null;
  const _roleT0 = Date.now();
  if (opts && opts.role && opts.role !== 'main') {
    try {
      _roleTrace = require('./run_trace').createTrace({
        sessionId: _sessionId, agent: opts.role, kind: 'subagent',
        root: (opts.continuityRoot) || _sessionId,
      });
      const _ci = opts.continuityInfo || {};
      _roleTrace.event('context_inherited', {
        turns: Number(_ci.turns || 0),
        has_findings: !!_ci.has_findings,
        own_session: _sessionId,
        task_head: String(userInput || '').slice(0, 120),
      });
    } catch (_) { _roleTrace = null; }
  }
  // ===== 连续上下文接线 (2026-10-14, 老板: "盘古一样需要连续上下文") =====
  //
  // 这是最重要的一处。现场实测 (2026-10-14): 简单对话根本**不进 dispatcher**,
  // 走的是 [j2-path] j2-native —— 主循环自己就是对话。而主循环的 messages 完全来自
  // 本次请求体, 客户端不重发历史就没有历史。于是:
  //   第1轮 "我的代号是青龙七十七号" → 模型调 memory_write 记下
  //   第2轮 "它是什么"              → 模型看到空上下文, 只能去调 current_time, 答了时间
  // 同一个模型下盘古不像 codex 的最大病根就在这里: **codex 的 rollout 是服务端持久的**
  // (每条 session 的完整消息链存在服务端), 盘古以前每个请求都从零重建。
  // 现在把 session 容器变成服务端真源: 请求没带历史就从容器补, 带了就用请求的,
  // 两边都记进容器, 于是连续性不再依赖前端行为。
  if (!opts || opts.continuityInjected !== true) {
    try {
      const _sc = require('./session_container').getContainer();
      _sc.ensureRoot(_sessionId);
      const _st = _sc.getState(_sessionId);
      const _incoming = Array.isArray(messages) ? messages : [];
      const _incomingTurns = _incoming.filter(m => m && (m.role === 'user' || m.role === 'assistant') && !m.type && !m.tool_calls);
      // 首次见到这个 session: 用请求带来的 messages 播种 (前端重发的情况)
      // 2026-10-14 (现场取证): 容器空 + 磁盘有 → 从磁盘水合一次。
      // 为什么必须放这儿而不是留在路由层: 盘古的磁盘恢复原本写在
      // pangu_agent_stream.js 的 [prior-turns] 块里, 但**桌面 UI 和我的实测走的都是
      // /api/message/stream** (inline_router.js:2699 → message-stream.js), 根本不经过
      // pangu_agent_stream —— 那套恢复对真实用户路径从来没生效过 (实测: 重启服务后
      // 问"我喝的什么", 盘古答"记忆库里没有你喝过什么的记录", 而磁盘里明明记着)。
      // 放主循环入口: 所有路由 (message-stream / agent-stream / dispatcher / 子 agent)
      // 自动覆盖, 不用逐个路由补, 以后新增路由也不会漏。
      // 顺序很关键: 必须**先水合磁盘, 再播种本轮请求**。
      // (第一版把播种写在水合前面, 而播种条件是 "容器还没 seeded", 水合条件是 "容器为空" ——
      //  播种一执行 turns.length 就变成 1, 水合永远被跳过。现场表现: 重启后问"我喝的什么",
      //  盘古靠 checkpoint 续跑蒙对了, 但容器里其实空的, 水合日志一次没打。)
      if (_st && !_st.hydrated) {
        try {
          const _sr = await require('./session_store').sessionLoad({ session_id: _sessionId }).catch(() => null);
          if (_sr && _sr.ok && _sr.result) {
            const _pt = require('./j2_loop_shared')._extractPriorTurns(_sr.result.messages);
            if (_pt && _pt.length) {
              for (const _t of _pt) _sc.appendTurn(_sessionId, _t.role, _t.content);
              console.log('[j2-continuity] 磁盘水合 ' + _pt.length + ' 轮 (sid=' + _sessionId + ', 进程重启后首次)');
            }
            _st.hydrated = true;
          } else {
            _st.hydrated = true;  // 磁盘也没有, 别每轮重试
          }
        } catch (_) { /* 水合失败不阻断主流程 */ }
      }
      if (_st && !_st.seeded && _incomingTurns.length) {
        _st.seeded = true;
        for (const _m of _incomingTurns) _sc.appendTurn(_sessionId, _m.role, _turnText(_m));
      }
      // 记本轮主人输入 (appendTurn 内部按归一化文本去重)
      if (userInput) {
        // 2026-10-28: 容器里记**主人原话**, 不记注入块拼过的版本。
        //   容器跟请求比对时按原话比 —— 否则每一轮都判成「请求里没有这一轮」,
        //   把上一轮又塞一遍进 messages (实跑 [j2-msgs] 抓到过)。
        _sc.appendTurn(_sessionId, 'user', _lastUserRaw(_incomingTurns) || userInput);
      }
      // 本轮请求自带的历史里, 已经在容器里的部分不再重复注入
      const _ctx = _sc.buildSubagentContext(_sessionId);
      const _have = new Set();
      for (const _m of _incomingTurns) {
        _have.add(String(_m.content || '').replace(/\s+/g, ' ').trim());
        // 2026-10-28: 原话也要算「请求已带」 —— 容器里存的是原话。
        const _t = _turnText(_m);
        if (_t) _have.add(String(_t).replace(/\s+/g, ' ').trim());
      }
      const _missing = (_ctx.turns || []).filter(t => !_have.has(String(t.content || '').replace(/\s+/g, ' ').trim()));
      if (process.env.PANGU_DEBUG_MSGS === '1') {
        console.log('[j2-continuity-dbg] 容器=' + JSON.stringify((_ctx.turns || []).map(t => ({
          r: t.role, l: String(t.content || '').length, h: String(t.content || '').slice(0, 34),
        }))) + ' 请求自带=' + JSON.stringify(_incomingTurns.map(m => ({
          r: m.role, l: String(m.content || '').length, raw: m.raw ? String(m.raw).slice(0, 34) : null,
        }))) + ' 缺=' + JSON.stringify(_missing.map(t => String(t.content || '').slice(0, 34))));
      }
      if (_missing.length && !opts.role) {
        // 只对主对话注入 (子 agent 由 dispatcher 各自注入, 免得两处都塞)
        const _sys = messages && messages[0] && messages[0].role === 'system' ? messages[0] : null;
        const _rest = _sys ? messages.slice(1) : (Array.isArray(messages) ? messages.slice() : []);
        // 去掉本轮主人输入本身 (它已经在最后, 不用在历史里再出现一次)
        const _curNorm = String(userInput || '').replace(/\s+/g, ' ').trim();
        const _filtered = [];
        let _curMsgObj = null;
        for (let _i = 0; _i < _rest.length; _i++) {
          const _m = _rest[_i];
          const _norm = String((_m && _m.content) || '').replace(/\s+/g, ' ').trim();
          if (_m && _m.role === 'user' && _norm === _curNorm) {
            // 2026-10-28: 本轮消息对象要留着 —— 重新塞回去时**不能丢 images**。
            //   原来 push 的是裸的 {role,content}, 带图那一轮的图就没了 (模型看不见图)。
            if (!_curMsgObj) _curMsgObj = _m;
            continue;
          }
          _filtered.push(_m);
        }
        messages = (_sys ? [_sys] : []).concat(_missing, _filtered);
        // 2026-10-23 (第 67 批, B67-8 撞出来的真 bug): **本轮主人输入必须留在消息里**。
        //   上面那句过滤把本轮输入从 _rest 里去掉了, 理由是「它已经在最后, 不用在历史里再出现一次」——
        //   那个假设只在**请求自带历史**时成立 (那种情况下 _missing 为空, 这段根本不跑)。
        //   请求**没带历史**时 (API 客户端只发 input / 桌面端没重发): _missing 里没有本轮输入
        //   (它已经在 _have 里被判为「请求自带」), _filtered 里又被删掉 ⇒
        //   **本轮的问题整段消失** —— 模型看不见主人刚问什么, 答的是上一轮的事,
        //   盘上落盘的历史里也查不到主人这一句。
        //   现场: 第 67 批写「第二轮不许把第一轮抹掉」的判据时撞出来的。
        const _curStillThere = _filtered.some(m => m && m.role === 'user'
          && String(m.content || '').replace(/\s+/g, ' ').trim() === _curNorm);
        if (!_curStillThere && userInput) {
          messages.push(_curMsgObj || { role: 'user', content: userInput });
        }
        console.log('[j2-continuity] 注入上文 ' + _missing.length + ' 轮 (请求自带 ' + _incomingTurns.length + ' 轮) sid=' + _sessionId);
      }
    } catch (_) { /* 连续性是增强, 不能让它打断主流程 */ }
  }
  // §0.57 (爹接棒, 2026-09-04): 问题边界 — 同 session 来新 user request 时, 旧 round 必须立刻 abort,
  // 否则旧 round 还在往自己的 res 喷, 新 round 又开新 res → 用户体感「还在答上面的问题」
  if (_state.activeAbort) {
    console.warn('[j2-boundary] §0.57 同 session 新请求, 旧 round abort sid=' + _sessionId);
    try { _state.activeAbort.abort('user_switched'); } catch (_) {}
  }
  const _sessionAbort = new AbortController();
  _state.activeAbort = _sessionAbort;
  _sessionAbort.signal.addEventListener('abort', () => {
    if (_state.activeAbort === _sessionAbort) _state.activeAbort = null;
  });
  // §0.61: per-request middleware chain — silent-fail + think-strip 双轨 (主循环响应仍走旧 inline, W2.6 合并)
  const _middleware = new MiddlewareChain();
  _middleware.use(createSilentFailMiddleware());
  _middleware.use(createThinkStripMiddleware());
  // §0.58 (爹接棒): 状态灯心跳 — 每 5s 推 SSE heartbeat, 用户能感知「还在活」不靠猜
  let _heartbeat = setInterval(() => {
    try {
      res.write('event: heartbeat\ndata: ' + JSON.stringify({
        sid: _sessionId,
        round: typeof rounds === 'number' ? rounds : 0,
        tool_calls: Array.isArray(toolsUsed) ? toolsUsed.length : 0,
        phase: 'active',
        ts: Date.now(),
      }) + '\n\n');
    } catch (_) { /* res 已关, 跳过 */ }
  }, 5000);
  const _clearHeartbeat = () => { if (_heartbeat) { clearInterval(_heartbeat); _heartbeat = null; } };
  _sessionAbort.signal.addEventListener('abort', _clearHeartbeat);

  // 2026-08-16 P0-1: 断点续跑 — opts.resumeCheckpoint=true 且有 fresh checkpoint (< 30min) 时, 恢复 messages
  // 默认 opts.resumeCheckpoint 行为由上层 (pangu_agent_stream.js) 控; 这里只负责读
  if (opts.resumeCheckpoint) {
    try {
      const ck = loadLatestCheckpoint(_sessionId);
      if (ck && ck.fresh && Array.isArray(ck.messages) && ck.messages.length > 0) {
        console.log(`[j2-checkpoint] resuming session=${_sessionId} from round=${ck.round} messages=${ck.messages.length}`);
        // 2026-10-24 (第 75 批 b): 恢复时**按 role 区分**地洗一遍。
        //   assistant 轮: 洗 —— 泄漏的标记就是模型自己抄进答复的那一份, 留着它
        //     = 续跑时模型看着自己上轮抄的标记, 照着再抄一遍 (自循环)。
        //   system / user 轮: **原样** —— 那些是我们自己发的合法提示词
        //     ([会话续跑] / [REVERIFY_FIRST] / [SYSTEM WARNING] …),
        //     洗掉它们 = 续跑直接退化 (模型不再知道要先核验断点)。
        messages = ck.messages.map((m) => {
          if (!m || m.role !== 'assistant' || typeof m.content !== 'string') return m;
          const _cleaned = _internal.stripInternalMarkers(m.content);
          if (_cleaned === m.content) return m;
          console.warn('[j2-checkpoint] 剥掉 assistant 轮里的内部标记 (' + (m.content.length - _cleaned.length) + ' 字)');
          return Object.assign({}, m, { content: _cleaned });
        });
        // §0.59 (爹接棒): 续跑时给模型一条 system 提示 — 不要重新寒暄/重新理解, 直接接着干
        const _idleMin = Math.round((Date.now() - ck.ts) / 60000);
        messages.unshift({ role: 'system', content: '[会话续跑] 上一轮在 round ' + ck.round + ' / 共 ' + ck.messages.length + ' 条消息时中断 (空闲约 ' + _idleMin + ' 分钟)。直接基于已有上下文接着干 — 不要重新寒暄、不要重读已读过的文件、不要重做已完成的工具调用。\n[REVERIFY_FIRST] 中断意味着最后一轮没有干净收口: 续跑第一动作必须先用工具核验断点处的真实状态 (重读文件/重排盘/重查账本), 再用本轮 tool_result 证据接着干。禁止凭上一轮叙述直接续写结论。' });
        // Keep the user's newest acknowledgement/instruction. Previously the
        // checkpoint replaced the request history wholesale, so “继续” never
        // reached the model and it could restart or ask again instead.
        if (userInput && (!messages.length || messages[messages.length - 1].role !== 'user' || messages[messages.length - 1].content !== userInput)) {
          messages.push({ role: 'user', content: userInput });
        }
        try { res.write('event: checkpoint_resumed\ndata: ' + JSON.stringify({ session_id: _sessionId, round: ck.round, ts: ck.ts, messages_count: ck.messages.length, idle_min: _idleMin, resumed: true }) + '\n\n'); } catch (_) {}
      } else if (ck && ck.stale) {
        try { res.write('event: checkpoint_stale\ndata: ' + JSON.stringify({ session_id: _sessionId, round: ck.round, age_ms: Date.now() - ck.ts }) + '\n\n'); } catch (_) {}
      }
    } catch (e) { console.warn('[j2-checkpoint] resume failed:', e.message); }
  }
  // Plan state 30 min 过期清理 (跟 SessionCompaction 对齐)
  if (_planStateIsStale(_state)) {
    if (_state.planState) console.log('[j2] §0.31 stale plan state cleared for', _sessionId);
    _state.planState = null;
  }
  // Recall is best-effort; it must never delay or block the first model round.
  try {
    await _injectRelevantMemories(messages, userInput, _deps && _deps._sessionRecall);
    await _injectSonaPatterns(messages, userInput);
    await _injectGoapPlan(messages, userInput);
    // 2026-09-12 修 (老板 PANGU_SCAN_REPORT_20260912 B4): goal.js 模块在但未注入 — LLM 跨轮忘目标,
    // 长任务失去锚点 → 调 goal.renderGoalForSession, 有 active goal 时注入 system reminder。
    try {
      const goal = require('./goal');
      const _goalText = goal.renderGoalForSession(_sessionId);
      if (_isExplicitContinuation && _goalText) {
        messages.push({ role: 'system', content: _goalText });
        console.log('[j2-goal] active goal injected for session=' + _sessionId);
      }
    } catch (_) { /* goal 模块未就绪不阻塞 */ }
    // 任务级检查点只给明确续跑请求注入。会话可长期复用；新问题不应被旧 active checkpoint 改写成续跑。
    try {
      const tc = require('./task_checkpoint');
      const _tc = tc.loadTaskCheckpoint(_sessionId);
      if (tc.shouldResumeTaskCheckpoint(_tc, userInput)) {
        // 只在 30min 内 (避免 stale 计划污染新上下文)
        const _tcSummary = [
          '# 任务检查点续跑 (30min 内)',
          '',
          '**目标**: ' + (_tc.goal || '(无)'),
          '**状态**: ' + (_tc.status || 'unknown'),
          '**已用工具**: ' + ((_tc.tools_used || []).slice(-10).join(', ') || '(无)'),
          '**已写文件**: ' + ((_tc.files_touched || []).slice(-5).join(', ') || '(无)'),
          '**下一步**: ' + (_tc.next_action || '继续按目标推进'),
          '',
          '**运用**: 压缩 / 中断后自动恢复, 不要重复已完成的步骤',
        ].filter(Boolean).join('\n');
        messages.push({ role: 'system', content: _tcSummary });
        console.log('[j2-task-cp] resumed task checkpoint for session=' + _sessionId + ' last_round=' + (_tc.last_round || '?'));
      } else if (_tc && _tc.status === 'active' && !_isExplicitContinuation) {
        console.log('[j2-task-cp] skip unrelated active checkpoint for new request session=' + _sessionId);
      }
    } catch (_) { /* task_checkpoint 模块未就绪不阻塞 */ }
    // 2026-09-13 (老板 00:30 实案 "还是不行, 必须我提醒"): auto_resumes 计数写在会话 checkpoint 里
    // 永不重置 — 长会话烧满 3 次后 _tryAutoResume 永远返回 false, 之后每个长任务都要人肉"继续"。
    // 每个新用户请求 = 新的续跑预算 (请求内续跑不走这里, 不受影响)。
    try {
      const _tcReset = require('./task_checkpoint');
      const _cpPrev = _tcReset.loadTaskCheckpoint(_sessionId);
      if (_cpPrev && (_cpPrev.auto_resumes || 0) > 0) {
        _tcReset.saveTaskCheckpoint(_sessionId, Object.assign({}, _cpPrev, { auto_resumes: 0 }));
        console.warn('[j2-auto-resume] 新用户请求, 重置续跑预算 (was ' + _cpPrev.auto_resumes + ')');
      }
    } catch (_) { /* 重置失败不阻塞主流程 */ }
    // 2026-09-13 任务账本注入 (老板拍板 "解决问题, 不是打补丁"):
    // 已核实事实 (tool_result 记的账: 真读/真写/不存在路径/上次死因) 每请求注入 —
    // 治模型失忆 (压缩切不掉, system 消息随压缩存活) 与假路径幻觉 (账上没有的路径先核实)。
    // 先剥掉旧账本快照再注入新的, 防多请求累积。
    try {
      const _ledger = require('./task_ledger');
      _ledger.recordGoal(_sessionId, userInput);
      messages = messages.filter(m => !(m && m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('# 任务账本')));
      const _ledgerText = _isExplicitContinuation ? _ledger.renderLedgerForSession(_sessionId) : null;
      if (_ledgerText) {
        messages.push({ role: 'system', content: _ledgerText });
        console.log('[j2-ledger] task ledger injected for session=' + _sessionId);
      }
    } catch (_) { /* 账本未就绪不阻塞 */ }
    // 2026-09-22 修 (session 44008568 实案): 上一轮断连/失败 (ledger last_run 非 completed + 有中断痕迹) →
    // 本轮开干前强制先工具核验 (重新读图/重排盘), 不许凭记忆续写。断连轮没跑工具, 记忆里没有证据,
    // 模型纯靠上一轮自己的叙述续写 = 幻觉重灾区。
    try {
      const _lg = require('./task_ledger');
      const _led = _lg.loadLedger(_sessionId);
      const _lastRun = _led && _led.last_run;
      if (_isExplicitContinuation && _lastRun && _lastRun.status !== 'completed' && _lastRun.note && /中断|断连|empty|error|failed/i.test(_lastRun.status + ' ' + _lastRun.note)) {
        messages.push({ role: 'system', content: '[REVERIFY_FIRST] 任务账本显示上一轮没有干净完成 (上次结局: ' + _lastRun.status + ' — ' + _lastRun.note + ')。本轮第一动作必须是工具核验 (重读原图/重排盘/重读文件), 用本轮真 tool_result 建立证据后再下结论。禁止凭上一轮的记忆或叙述直接续写。' });
        console.log('[j2-reverify] forced tool-verify injected for session=' + _sessionId);
      }
    } catch (_) {}
    // 2026-09-12 新增 (老板 PANGU_SCAN_REPORT_20260912 §6 L4+L5): Plan 状态机注入 — LLM 看到当前进度
    try {
      const plan = require('./plan_state');
      const _planText = _isExplicitContinuation ? plan.renderPlanForSession(_sessionId) : null;
      if (_planText) {
        messages.push({ role: 'system', content: _planText });
        console.log('[j2-plan] active plan injected for session=' + _sessionId);
      }
    } catch (_) { /* plan_state 模块未就绪不阻塞 */ }
    // 2026-09-16 一期① 状态卡片: 每请求主动带进度账 (本会话 plan+ledger, 跨会话活跃任务),
    // 治 "不这么问它也不知道" — 模型第一眼就知道聊到哪, 不用主人喂提示
    try {
      const _sc = require('./state_card');
      const _scText = _isExplicitContinuation ? _sc.render(_sessionId, { includeCrossSession: false }) : null;
      if (_scText) {
        messages = messages.filter(m => !(m && m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('# 当前任务进度卡')));
        messages.push({ role: 'system', content: _scText });
        console.log('[j2-state-card] state card injected for session=' + _sessionId + ' (' + _scText.length + ' chars)');
      }
    } catch (_) { /* 状态卡未就绪不阻塞 */ }
  } catch (error) {
    console.warn('[j2-memory] preflight recall failed:', error.message);
  }
  // 2026-08-02 修 (老板实证: 3 轮太浅 — round1 探索 round2 重读 round3 被迫收口, 总结都写不出来):
  // 默认回 5 轮, PANGU_MAX_ROUNDS 仍可覆盖; 承诺轮 nudge 上限 2 + summary 兜底, 不怕烧 token
  const maxRounds = parseInt(process.env.PANGU_MAX_ROUNDS || '8', 10);
  const toolsUsed = [];
  // 2026-10-14 溯源链: finally 里的结算要用"答案里的数字能不能在工具结果里找到"来判,
  // 但 native / legacy 两条路径的 toolResults 都是块级 const, finally 根本看不见。
  // 所以这里挂一个函数级累加器, 两条路径各自往里塞, 结算时统一取。
  // 限量: 工具结果可以很大, 全留会把内存吃光, 只留最近若干条 + 总字符上限。
  const _groundingEvidence = [];
  const _GROUNDING_MAX_RESULTS = 24;
  const _GROUNDING_MAX_CHARS = 60000;
  const _collectEvidence = (results) => {
    for (const tr of (results || [])) {
      if (!tr) continue;
      // native 路径塞的是 {tc, execResult}, legacy 路径塞的是 {ok, result} —— 两种形状都要收。
      const src = tr.tc ? (tr.execResult || {}) : tr;
      if (!src || src.ok === false) continue;      // 失败结果不算证据
      let body = '';
      // 盘古工具的成功载荷字段是 **data** (不是 result):
      //   return { ok: true, data: { task_id, status, ... } }
      // 只认 result 的话, 证据永远是空的 —— 接上了、事件也发了, 但
      // evidence_chars 恒为 0, 等于整套校验在空转 (现场 gc-verify-2 踩过)。
      if (typeof src.data === 'string') body = src.data;
      else if (src.data !== undefined) { try { body = JSON.stringify(src.data); } catch (_) { body = String(src.data); } }
      if (!body && typeof src.result === 'string') body = src.result;
      else if (!body && src.result !== undefined) { try { body = JSON.stringify(src.result); } catch (_) { body = String(src.result); } }
      if (!body) body = String(src.text || src.content || '');
      if (!body) continue;
      _groundingEvidence.push({ ok: true, result: body });
    }
    while (_groundingEvidence.length > _GROUNDING_MAX_RESULTS) _groundingEvidence.shift();
    let total = 0;
    for (const e of _groundingEvidence) total += String(e.result || '').length;
    while (total > _GROUNDING_MAX_CHARS && _groundingEvidence.length > 1) {
      total -= String(_groundingEvidence.shift().result || '').length;
    }
  };
  // 把"答案里的数字能不能在工具结果里找到"这条判定写进 trace。
  // 只留痕不改答案: 文本级判定一定有误差, 拿它拦答案会把真结论判死, 守卫撒谎就没人再信。
  const _emitGrounding = (trace, text) => {
    if (!trace || typeof trace.event !== 'function') return;
    try {
      const _g = require('./grounding_check').check(String(text || ''), _groundingEvidence);
      if (_g.total > 0) {
        for (const _c of _g.ungrounded.slice(0, 30)) {
          trace.claim({ text: '未接地断言: ' + _c.raw, kind: _c.kind, grounded: false });
        }
        trace.event('grounding', {
          total_claims: _g.total,
          grounded: _g.grounded,
          ungrounded: _g.ungrounded_count,
          grounded_ratio: Number(_g.grounded_ratio.toFixed(3)),
          evidence_chars: _g.evidence_chars,
          has_evidence: _g.evidence_chars > 0,
          fabricated_signal: _g.evidence_chars === 0 && _g.total > 0,
        });
      }
    } catch (_) { /* 接地核查异常不阻断结算 */ }
  };
  const toolHistory = []; // BugE 引入但漏定义 — 记录 {name, args} 供 evolution 日志使用
  // 排盘证据 (2026-10-21, 第六批): 出门核验门要拿 sxtwl 权威四柱当核验基准, 而
  // toolHistory **只有 {name, args}, 没有结果** —— 参数里没有盘, 盘在 execResult 里。
  // 循环内的 toolResults 是块级 const, 出循环就没了, 所以这里单独留一份。
  // 只收 bazi_calc: 别的工具都有 content 字符串可读, 只有排盘需要结构化字段;
  // 收窄也让这份数组不会随长任务无限长。
  const _chartEvidence = [];
  const _recordChartEvidence = (name, result) => {
    if (name !== 'bazi_calc' || !result || typeof result !== 'object') return;
    _chartEvidence.push({ name, ok: result.ok === true, result });
  };
  const recordEvolution = _deps && _deps._recordEvolution;
  let finalText = '';
  // 2026-09-13 (16:28/16:39 实案): 全请求最长实质正文 — 模型常把真答案写在前面轮次的
  // 正文里, task_done 轮只有一句摘要。final 替换气泡时若摘要是元引用, 用这个兜底交付。
  let _longestRoundPlain = '';
  // 2026-09-12 五次: 声明提前到 guardFinalText/体量预检之前 — 否则 TDZ (Cannot access before initialization)
  let _taskDonePartialOk = false; // 大体量任务 (体量预检命中) — 部分进度 summary 允许交验, 对齐门放宽
  let _taskDoneStatusText = ''; // task_done summary 原文, partial 交付收口用
  // 2026-09-12 体量预检 (全局铁律 23): 任务文本是"大体量消化/总结类"时, 进 loop 前注入
  // system 指令逼模型先拆轮再动手 — 预防单轮超载被 guard 切。只做静态嗅探, 不扫盘、不阻塞。
  // 09-12 三次修: 短确认词 (对/继续) 经 resolveTaskInput 拼成「完整任务 + 续跑约束」传入,
  // 用共享谓词 _isHeavyDigestTask 判 — 确认词本身不带路径也能命中; 命中即 partial 交付放行。
  // 2026-10-16 (实机 session=modelswitch-t1#sub-0-analyzer, 卦象题切片被磨成 partial):
  //   [j2-volume] 大体量任务预检命中: input=【卦·节䷻ 六四动→兑】「六四：安节，亨」…
  //   [j2-volume] plan 骨架已生成 (分母兜底): session=modelswitch-t1#sub-0-analyzer
  //   [j2-native] TASK_DONE_GATE: plan 还有 1 步未完成, 拒收 task_done   ← ×4
  //   [j2-auto-resume] 上限到达且无实质进展 (4/3, done=0, files=0), 收口
  //   [j2-taxonomy] SILENT_FAIL_PARTIAL: 诚实收口文案走 partial 收口
  //
  // 根因是**给子 agent 建了一个它无法满足的分母**:
  //   骨架那一步的 dod 写的是「全部子块落盘 + 每步 plan_step_done 附证据后才允许
  //   task_done(completed)」, 而子 agent 的 prompt 里 (切片 + 汇报契约 + scope guard)
  //   **从头到尾没告诉它要调 plan_step_done** —— 它按契约交完就被门拒, 4 次全拒,
  //   auto-resume 烧完上限, 一道算卦题最后以 Silent Failure 收场。
  //
  // 而且体量预检本来就**不该作用在切片上**: 它的用途是"用户扔来一个超大任务 → 逼它
  // 自拆成轮", 而子 agent 的切片按定义已经是拆好的一刀, 再逼它拆是二次拆解。
  // 顺带也修了谓词过宽: `volume` 光凭 `/Users/` 一个路径就算"大体量", 于是
  // 「读取 /home/you/a.md 并总结」这种普通单文件总结也会命中 (已加回归测试)。
  //
  // 子 agent sid 的判据跟 task_ledger 一致: 含 `#` 就是子会话
  // (j2_dispatcher 恒用 parentId + '#sub-' + n + '-' + role)。
  const _isSubAgentSession = String(_sessionId || '').split('#')[0] !== String(_sessionId || '');
  if (userInput && !opts._volumeChecked && !_isSubAgentSession && _isHeavyDigestTask(userInput)) {
    let _note = '[体量预检·铁律23] 本任务是大批量资料消化/总结, 先拆轮: ' // 2026-09-14 修: 原 const → += 拼接直接 TypeError 崩整个 loop (易经 B/C 任务实案)
      + '本轮先完成 1 个子块 (读 1-3 份源 txt + 对应主题写进 总结.md), task_done 交验, 剩余子块下轮补。'
      + ' 禁止一口气吞完再写长总结 (会被 STATUS_FOUNTAIN_GUARD 切 → Silent Failure), 也禁止失败后原样重试。'
      + ' 交验 summary 必须报「本轮完成什么 + 剩余清单」, 禁止说「全部完成/已完成」。'
      + ' 动手前先 plan_create({goal, steps}) 把子块落盘成计划 (e2e 实战: 模型习惯性用 todo_write, 但 todo 不落盘、'
      + '跨轮/压缩/重启即丢; plan_state 才驱动自动续跑与断点恢复), 每完成一步 plan_step_done 附证据。';
    if (userInput.includes('【续跑约束】') || require('./guard_patterns').RESUME_ACK_RE.test(String(userInput).trim().split('\n')[0])) {
      _note += ' 【续跑】主人已确认自动继续 — 这一轮必须真调工具 (read_file/exec_command 读源 txt + write_file 落盘 总结.md 对应小节), 只宣布不干活 = 失败, 会被拒收。';
    }
    messages.push({ role: 'system', content: _note });
    try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '体量预检命中 (铁律23), 已注入自拆 + 真动手指令.' }) + '\n\n'); } catch (_) {}
    console.warn('[j2-volume] 大体量任务预检命中: input=' + String(userInput).slice(0, 60));
    _taskDonePartialOk = true; // 部分进度 + 剩余清单 = 合法交付, 对齐门放宽
    // 2026-09-13 P1b (老板: 为什么模型不记得? 盘古要起作用): 自动生成 plan 骨架 —
    // 不等模型自觉 plan_create (MiniMax 惯犯不建 plan → TASK_DONE_GATE 无分母可守)。
    // 骨架落盘即激活: 每轮注入进度 + task_done 守门拒收 + 自动续跑有断点。
    // 模型可以 plan_create 细化/替换 (骨架只是兜底分母, 不锁死拆法)。
    try {
      const _ps = require('./plan_state');
      const _existing = _ps.loadPlan(_sessionId);
      const _hasActive = _existing && (_existing.steps || []).some(s => s.status === 'pending' || s.status === 'doing');
      if (!_hasActive) {
        const _sk = _ps.setPlan(_sessionId, {
          goal: String(userInput).replace(/\s+/g, ' ').slice(0, 120),
          steps: [{
            id: 's1',
            title: '拆块执行: 每块真读真写后 plan_step_done 销账 (附证据), 建议先 plan_create 把子块细化',
            dod: '全部子块落盘 + 每步 plan_step_done 附证据后, 才允许 task_done(completed)',
            status: 'doing',
          }],
        });
        if (_sk && _sk.ok) {
          console.warn('[j2-volume] plan 骨架已生成 (分母兜底): session=' + _sessionId);
          const _skText = _ps.renderPlanForSession(_sessionId);
          if (_skText) messages.push({ role: 'system', content: _skText });
        }
      }
    } catch (_) { /* 骨架失败不阻塞 — 体量预检指令已注入 */ }
  }

  let finalAlignmentBlocked = false;
  let _lastBlockedFinal = '';  // 2026-09-12: 存被拦原文 — 0 工具对话轮兜底交付用 (老板 19:22 实案)
  // 2026-09-12 七次: 验收改"证据驱动主链" — 有真产出证据 (写了文件 + 锚定 tool_result 真数字) 就信,
  // 词法对齐只作 0 工具时的嘴炮兜底。治"做对的事被 5 道词法门误杀" (易经营案 Round 3/4 真根因)。
  const _evidenceText = () => messages.map(m => typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '')).join('\n');
  const _hasWriteProof = () => toolsUsed.includes('write_file') || toolsUsed.includes('file_edit') || toolsUsed.includes('apply_patch');
  const _artifactAligned = (text) => _hasWriteProof() && _hasArtifactEvidence(text, _evidenceText());
  const guardFinalText = (text, isFinal = true) => {
    const _clean = String(text || '').trim();
    // 证据主判: 答案锚定真实产出证据 → 直接对齐, 跳过词法 (防把真报告判跑题)
    if (_clean && _artifactAligned(_clean)) {
      finalAlignmentBlocked = false;
      return _clean;
    }
    // 2026-10-01 修 (实锤): guardAnswer(question, answer, fallback, evidenceText) 第 3 参是 fallback。
    // 旧调用只传 3 个 → _evidenceText() 落进 fallback 槽, evidenceText 恒为 ''。两个后果:
    // (1) hasArtifactEvidence(answer, '') 开头就 return false → "有真证据就放行"的通道在本主路径全死;
    // (2) 整份 transcript (含 raw tool_result/OCR 原文) 变成 fallback 候选 → 答非所问时会把原始
    //     工具输出当答案返回, 正是本函数下方注释写的 "must never become the chat answer"。
    // j2_dispatcher.js:37 的 4 参调用一直是对的, 只有 agent loop 这条主路径错位。
    // 修法: fallback 传空 (拦下交给 ALIGNMENT_RETRY / _noSummaryFallback), 证据串走第 4 参。
    // 2026-10-01: question 走 alignmentQuestion() 剥掉 resolveTaskInput 拼进去的【…】指令措辞,
    // 保留"上轮答案开头"等真实上下文载荷。否则 terms() 拿"禁止重复上轮全文"当问题词去匹配答案。
    const guarded = _guardAnswerAlignment(_alignmentQuestion(userInput), _clean, '', _evidenceText());
    if (guarded.blocked) {
      if (isFinal) { finalAlignmentBlocked = true; _lastBlockedFinal = _clean; }
      // Alignment rejection is an internal control signal, never a user-facing answer.
      return '';
    }
    return guarded.text;
  };
  let finalEmitted = false;
  // 2026-10-23 (第 67 批): 屏上**真正发出去**的那段文字。
  //   为什么单独记一份: 落盘必须与屏上**逐字一致**, 而 finalText 在发出去之后还会被改
  //   (summary 重写 / 守卫改写 / task_done 文案), 拿 finalText 落盘就等于存了另一段话。
  //   现场: b66-bridge-live-1792743482848 屏上 415 字符、盘上 723 字符 —— 两个版本。
  //   这份「屏上原文」是落盘内容的**唯一**来源: 屏上发什么, 盘上就存什么。
  let emittedFinalText = '';
  const emitFinalOnce = (t) => {
    if (finalEmitted || !t) return;
    finalEmitted = true;
    // 2026-10-24 (第 75 批): 答复连续性还原 —— 守卫腰斩回灌后, 模型可能从断点续写,
    //   交出的是一份**从半句开始**的正文 (现场 desktop-verify74-1792774960: r1 完整
    //   2062 字, 回灌只给 300 字, r2 从第 300 码位接着写, final 只发 r2 ⇒ 开头消失)。
    //   这里做**确定性**还原: 新答复若与「被砍掉的紧后面」有足够重叠, 判定为续写,
    //   把被砍掉的开头接回去。提示词只能压低概率, 这里才是保证。
    const clean = j2Helpers._stripSpecialTokens(String(_applyContinuity(t)).replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/<think>[\s\S]*$/g, '')).trim();
    // Never fall back to the raw value: a think-only completion must not leak
    // hidden reasoning into the user-facing final event.
    if (clean) {
      emittedFinalText = clean;   // ← 屏上发什么, 盘上就存什么
      // 2026-10-24 (第 75 批): replace = 「这是权威稿, 覆盖你看到的流式原文」。
      //   只在**还原过**的时候置位 —— 那时流式里躺着的是被守卫否掉的那一段,
      //   屏上留着它就是"同一段话出现两次" (前端还有一条"流式更长就不换"的规则,
      //   还原后的权威稿反而比流式短, 不带这个位就会被丢掉)。
      //   其余路径行为一点不变 (不带这个位 = 走前端原有判定)。
      // 2026-10-24 (第 75 批 b): 剥过内部标记时同样要置位 —— 理由一模一样:
      //   洗干净的稿比流式短, 不带 replace 就会被前端丢掉, 留下带标记的脏流式。
      _emitFinal(res, clean, { replace: _continuityMerged || _internalMarkerStripped });
      // 2026-10-14 连续上下文回写: 主循环的最终答复必须记进 session 容器,
      // 否则容器里只有主人问过什么、没有盘古答过什么 —— 下一轮"那现在呢"接不上。
      // 挂在 emitFinalOnce 而不是各个收口点: 它是主循环唯一的答复出口 (全请求只发一次),
      // 挂这里 native/legacy/续跑/模型切换全路径都覆盖, 不会漏。
      // 守卫拦下的答案 (block 话术) 同样记 —— 那也是盘古实际说出口的话,
      // 下一轮模型看到才知道"上轮我没答上来", 不会假装已经答过。
      try {
        const _sc = require('./session_container').getContainer();
        _sc.appendTurn(_sessionId, 'assistant', clean);
      } catch (_) {}
      // 注: 这里**不**往 messages 里 push 最终答复。落盘由 finally 块统一负责
      // (在 _persistSession 之前 push) —— emitFinalOnce 的调用点有的在循环内、有的在
      // finally 之后, 两处都 push 会在落盘文件里留下重复的 assistant 轮,
      // 恢复时模型看到"自己连说两遍同一句"反而更困惑。
      // 为什么必须落在 finally: finally 里的 _persistSession 早于多数 emitFinalOnce 调用点,
      // 只在 emitFinalOnce push 的话, 落盘时答复还没进 messages (实测蒸发)。
    }
  };
  let totalChars = 0;
  let rounds = 0;
  const agentStartTime = Date.now();
  let evoSuccess = true;
  let evoError = null;
  let taskDoneCalled = false;
  let taskDoneStatus = null;
  let taskDoneAccepted = false;
  // 2026-10-23 (第 67 批): 主循环体**正常跑完**的标记。
  //   用途: finally 里的兜底落盘只在「主循环抛异常 / 中断」时才写 ——
  //   正常路径的落盘挪到**答案定稿之后** (函数末尾), 那时才拿得到「屏上那段」。
  //   详见 _persistFinalAnswer 的注释。
  let _loopBodyCompleted = false;

  /**
   * 2026-10-23 (第 67 批): 最终答复落盘 —— **屏上发什么, 盘上就存什么**。
   *
   * ## 现场 (b66-bridge-live-1792743482848)
   *   屏上 final 415 字符, 落盘文件里 723 字符 —— 两个不同的文本。
   *   根因是**顺序**, 不是数量:
   *     · 落盘点在 finally 块里 (答案定稿**之前**)
   *     · 而 summary 重写 / 守卫改写 / task_done 文案都发生在 finally **之后**
   *   ⇒ 改完的 finalText 只进了 SSE, 没进盘; 盘上留的是重写**前**那一版。
   *
   * ## 修法 (两条都做, 缺一不可)
   *   ① 内容取 **emittedFinalText** (屏上真正发出去的那段, 已剥 think / 特殊 token),
   *      不取 finalText —— finalText 在发出去之后还会被改, 拿它落盘就是存了另一段话。
   *   ② 时机挪到**答案定稿之后** (函数末尾), finally 里那份降级成异常兜底。
   *
   * ## 为什么末尾是「改写最后一条 assistant」而不是「追加一条」
   *   追加会让盘上出现「自己连说两遍」, 恢复时模型看到同一句两遍反而更困惑。
   *   但带 tool_calls 的 assistant 轮不能改写 (那是工具调用轮), 那种情况才追加。
   */
  const _persistFinalAnswer = async () => {
    try {
      const _diskText = String(emittedFinalText || finalText || '').trim();
      if (_diskText && Array.isArray(messages)) {
        const _lm = messages[messages.length - 1];
        if (_lm && _lm.role === 'assistant' && !_lm.tool_calls && !_lm.function_call) {
          _lm.content = _diskText;
        } else {
          messages.push({ role: 'assistant', content: _diskText });
        }
      }
      // 2026-10-14 (现场铁证): _persistSession 是**整份覆盖**。一旦某轮的 messages
      // 因为恢复失败而缺了历史, 这一落盘就把磁盘上的旧历史**永久抹掉** ——
      // 实测 h6: 第一轮 (乌龙茶) 好好落着, 第二轮容器空 → 覆盖后文件里只剩第二轮,
      // 第一轮从此消失, 而且再也回不来。历史只有一份, 覆盖写没有兜底。
      // 兜法: 落盘前若本轮 messages 明显偏少 (没有任何 user/assistant 对话轮),
      // 先把磁盘上更长的历史并回来再写 —— 宁可多存, 不许静默丢历史。
      try {
        const _diskTurns = require('./j2_loop_shared')._extractPriorTurns(messages);
        if (_diskTurns.length <= 1) {
          const _sr2 = await require('./session_store').sessionLoad({ session_id: _sessionId }).catch(() => null);
          const _old = require('./j2_loop_shared')._extractPriorTurns(
            _sr2 && _sr2.ok && _sr2.result ? _sr2.result.messages : null);
          if (_old.length > _diskTurns.length) {
            const _curNorm = String(userInput || '').replace(/\s+/g, ' ').trim();
            const _oldKept = _old.filter(t => !(t.role === 'user' && String(t.content || '').replace(/\s+/g, ' ').trim() === _curNorm));
            // 旧历史在前, 本轮在最后 —— 保持时间顺序
            messages = [messages[0]].concat(_oldKept, messages.slice(1));
            console.warn('[j2-persist-guard] 本轮历史偏少, 并回磁盘旧历史 ' + _oldKept.length
              + ' 轮 (sid=' + _sessionId + ') —— 否则整份覆盖会永久抹掉它');
          }
        }
      } catch (_) {}
      await _persistSession(_sessionId, messages, {
        round: rounds,
        state: userAborted ? 'aborted' : (taskDoneAccepted ? 'completed' : 'active'),
        task_input: userInput,
        plan_state: _state.planState || null,
        final: true,
      });
    } catch (e) {
      console.warn('[j2-persist] final persist failed:', e && e.message && e.message.slice(0, 200));
    }
  };
  // 2026-10-09 P0: userAborted 之前从未声明, 但 L2865 §0.56 清理和 finally 收口都在读它 —
  // 两处都套在 catch(_){} 里, ReferenceError 被静默吞掉, 表现是"状态清理从不发生"。
  // 这里正式声明, 在 abortFromClient 里置位。
  let userAborted = false;
  // R16 修: rounds 双计防御 — legacy 循环用独立计数
  let _legacyRounds = 0;
  let _emptyPlanNudges = 0;  // R80 BUG #1: 空计划模板 nudge 计数 (上限 EMPTY_PLAN_MAX_NUDGES)
  let _promiseNudges = 0;    // 2026-08-02: 0 工具承诺轮 nudge 计数 (上限 2, 防死循环)
  let _unverifiedNudges = 0; // 2026-08-02: 反幻觉钩子③ 未验证系统状态断言 nudge 计数 (上限 1)
  let _fakeOutNudges = 0;    // 2026-08-03: 假产出收口拦截 nudge 计数 (上限 1)
  let _lipServiceNudges = 0; // 2026-09-11: task_done 光喊计划没动手 (lip-service) 拒收 nudge 计数 (上限 2)
  // 2026-10-25 (第 88 批): 「只回思考」nudge 计数 —— **原来根本没声明**。
  //   兄弟计数器 (_promiseNudges / _emptyPlanNudges / _lipServiceNudges …) 全都是
  //   在这儿声明的, 唯独它漏了。
  //
  //   漏声明的后果不是「计数器不准」, 是**整轮炸掉**:
  //     3160 行 `if (_hasReasoningOnly && round < maxRounds - 1 && _reasoningOnlyNudges < 3)`
  //     第三个条件要**读**这个变量 —— 读一个未声明的标识符, 无论 sloppy 还是 strict,
  //     都是 **ReferenceError** (sloppy 只允许「赋值」时建隐式全局, 「读」照样抛)。
  //     ⇒ 只要模型在**非最后一轮**只回思考, 整个主循环当场抛异常,
  //       那一轮的所有产出全丢, 主人收到的是收口异常而不是答案。
  //     ⇒ 这条「只回思考 ⇒ nudge 再问一次」的守卫**从来没生效过** ——
  //       它每次都是在要读那个变量的那一刻就炸了。
  //   (2026-10-25 实测复现: `evaluate(true, 0, 6)` → ReferenceError;
  //    `evaluate(false, 0, 6)` / `evaluate(true, 5, 6)` 短路, 不读, 不炸。)
  let _reasoningOnlyNudges = 0; // 只回思考 nudge 计数 (上限 3, 防死循环)
  // 2026-10-23 (第 73 批): 调过工具却只输出旁白 (复读 / 承诺句) 的 nudge 计数 (上限 2)
  let _lipAfterToolsNudges = 0;
  let _emptyContentRounds = 0; // 2026-09-13: MiniMax 连续空内容轮计数 (≥2 诚实熔断, 老板 12:51 实案)
  // 2026-10-23 (第 64 批): 超时恢复的三个状态。
  //   _timeoutResumeCount —— 已经续想了几次 (上限 1: 续想一次仍超时 ⇒ 认账收口, 不无限烧)。
  //     为什么要续想: 现场 b63-guagate3 模型把 reasoning 推了 2980 字才撞 390s 墙,
  //     原来的重试是**同 prompt 原样重来** (msgs 12 / inputTokens 16186 逐字节同大小)
  //     ⇒ 已想的 2980 字全作废, 而且必然再撞同一堵墙。
  //     续想 = 把已想的留在上下文 + 催它「先动一步」, 下一轮**预算收紧**。
  //   _nextRoundStreamScale —— 下一轮流式总预算的缩放 (续想时收紧到 0.35)。
  //     「走一步判断一步」的机械实现: 不给它无限想下去的时间, 它必须交出东西。
  //   _timeoutSalvaged —— 本轮是用抢救出来的 partial 继续的 (不是正常返回)。
  let _timeoutResumeCount = 0;
  let _nextRoundStreamScale = 1;
  let _timeoutSalvaged = false;
  let _confirmNudges = 0; // 2026-09-13: 主人已拍板模型仍"等你指令/主人拍" nudge 计数 (上限 1, 老板 14:06 实案)
  let _deliveryRejectRetries = 0; // 2026-09-14 (老板 13:42 实案): 终局对账纠假回灌计数 (上限 2) — 抓假必须纠假
  let _alignNudges = 0;      // 2026-09-11: 对齐门拒收 → 证据重答/overclaim 改实数 共享计数 (上限 2)
  // 2026-09-11 OVERCLAIM_SENTINEL (09-11 16:08 实案: 只写了 1 篇总结, summary 却称 "排查+消化已完成")
  const OVERCLAIM_RE = require('./guard_patterns').OVERCLAIM_RE; // 2026-09-14: 守卫模式单一真源, 可单测
  // 2026-09-11 fix: task_done 只按'对齐'验收, 不验收'真干活了'。0 真工具 + 计划/承诺型 summary
  // (收到/开盘/开做/先...再.../定个顺序) 会被当成 completed。命中下列措辞且全程 0 真工具 → 拒收 task_done。
  const LIP_SERVICE_SUMMARY_RE = require('./guard_patterns').LIP_SERVICE_SUMMARY_RE; // 守卫模式单一真源
  // 2026-09-11: 嘴炮检测统一入口 — task_done 验收与 text-only final 收口共用 (≥30 字防误伤短闲聊)
  const _isLipServiceText = require('./guard_patterns').isLipServiceText;
  const isAnthropic = _isAnthropicModel(model);
  // 2026-07-27 P0 修 (Bug #2): 跨 round tool+args 失败累加 (key=toolName|stableJson(params), value=count)
  const _crossRoundToolFails = new Map();
  const _CROSS_ROUND_FAIL_LIMIT = 2;  // 同 (tool,args) 失败 2 次 -> 强制改 args / 换工具 / task_done
  // Legacy models may repeat an XML tool call verbatim after seeing its output.
  // Deduplicate before execution; the existing result remains in messages and
  // is enough for the next round to summarize or choose a different action.
  const _crossRoundToolCalls = new Map();
  const _CROSS_ROUND_CALL_LIMIT = 1;
  // 2026-10-17: 重复调用告警的去重账 (见下面 _pushWarnOnce 处的现场数据)。
  // 跨轮存活是刻意的 —— messages 是累积的, 同一句告警推第二遍就是纯浪费。
  const _j2RepeatWarnedKeys = new Set();
  // 同理: "别用正文写工具调用" 这条告警一辈子只推一次 (见 PSEUDO_TOOLCALL_SALVAGE 处)。
  let _j2PseudoWarned = false;
  // 2026-10-17 (现场 q-1792192247770, "跟死了一样"的**真机制**):
  //   sub-0-analyzer 跑了 **21 轮 / 80 秒**, 前 14 轮全在拿 exec_command 撞墙:
  //     {"ok":false,"blocked":true,"_role_denied":true,
  //      "error":"ROLE_READ_ONLY: analyzer 是只读角色, 命令会改状态: 内联解释器代码 = 任意写权限"}
  //   任务本身只是"读配置文件取证", 模型用 grep/sed 找模型池是**最自然**的做法,
  //   但 analyzer 是只读角色 → 被拒 → 它换个命令再试 → 又被拒 → …→ 第 14 轮才改用
  //   read_file。中间它甚至花了好几轮 `grep -rn "analyzer"` —— **拿预算调查自己为什么被拦**。
  //
  // 为什么既有的三道闸门一道都没拦住:
  //   - self_correct: 2026-10-15 那刀把 blocked 排除在外了(对的, 防重复守门不该罚模型两次)
  //   - DUPLICATE_TOOL_CALL: 按 `工具名|参数` 分桶, 而模型**每次换参数**(grep 换了又换),
  //     桶永远不同 → 守门从不触发
  //   - _CROSS_ROUND_FAIL_LIMIT: 同上, 按 (tool,args) 累加 → 同上
  // 三道闸门全都以"工具+参数"为键, 而这一刀的症状恰恰是**换参数重试**。
  //
  // 修法 (沿用 2026-10-15 既定纪律「不新造第四套机制」): 给角色拦截补一本
// **按工具名**的账, 并且第一次拦就点名替代方案 ——
  // 旧文案只说"你不能做", 从不说"你可以用这个做同样的事", 模型只能靠试。
  // 计数与文案收在工厂函数 _makeRoleDenyGuard 里 (纯逻辑, 可单测), 这里只留一个实例 ——
  // 状态按 session 走, 而"第几次被拒该怎么说"是纯函数, 拆开才测得动。
  const _roleDeny = _makeRoleDenyGuard();
  // 2026-10-16 (现场 session request-1792124456972-8cekw6#sub-0-analyzer):
  // 同一 session 里 read_file 用**完全相同的参数**调了两次
  // (日志 79783 行与 79907 行 params 一字不差), 中间隔着一轮 ~214s 的 LLM。
  // 之所以放行, 是因为 _READONLY_REPEAT_OK 把只读工具整个豁免了 ——
  // 而豁免的理由是"压缩会触发重读", 这个理由只对**一半**情况成立:
  //
  //   结果还在上下文里 → 重读返回一模一样的字节, 纯浪费一整轮 (现场就是这种)
  //   结果被压缩掉了 → 重读确实是模型把内容拿回来的唯一办法
  //
  // 两种情况的正确解都不是"再读一次盘", 而是**把已经拿到的结果回放给它**:
  // 还在上下文里 → 白省一轮; 被压缩掉了 → 等于把内容还给模型, 比重读还快。
  // 所以这里记一份只读结果缓存, 同参数重读直接回放, 一个字节都不重读。
  // 写/执行类工具不缓存 —— 它们要么被防重复守门拦死, 要么本来就该重跑。
  // (刻意不写那个错误的英文常量名: B8/B9 靠 indexOf 那个字面量定位记账代码,
  //  注释里写一次就会把锚点抢走 —— 踩坑日志第 2 条, 今天又犯了一次。)
  const _j2ReadCache = new Map();

  // 2026-10-09 (老板截图): 模型空转 — 连续探测 system_info/network_check/process_list,
  // 参数每次都不同, 所以 _CROSS_ROUND_CALL_LIMIT(按 工具名|参数 判重) 拦不住。
  // 这里按"工具名"维度再记一次: 同一探测类工具在本 session 反复调、且没有任何
  // 写盘/验收进展时, 回灌一条 system 指令让它停止试探、直接回答或收口。
  //
  // 2026-10-23 (第 73 批, 实跑现场): 上面这段逻辑原本**只装在 legacy 分支**,
  // native 分支 (实测主路) 一行都没有 —— 实跑「1990年3月15日生男…给个决断」时,
  // 模型拿 exec_command 连试三次 (node -e require('sxtwl') → find → 再试),
  // 200 秒不出 final, 空转守门一声没响。
  // 现在收成唯一真源: 判定逻辑在 tool_spin_guard.js, native / legacy 两条路共用,
  // 以后改阈值只改一处, 不会再出现"主路上没有这道闸门"。
  // (守门实例在 useNative 判定之后建 —— R3 的解禁口径两条路不同, 见下面的注释。)

  // R15 修 (plan-mode-tool-selection spec 2nd pass): 按 main 角色过滤 toolsSchema (不再喂全部 110)
  // 老板 2026-07-25 12:42 截图: LLM 选 list_pangu_agents / current_time / 不会选 risk_assessment
  // 根因: toolsSchema = Object.values(TOOLS_SCHEMA) 全喂, LLM 看到 110 工具全可选 → 优先级混乱
  // 解: 按 role=main 过滤成 15 工具 (主对话只看到 main 集)
  const { TOOLS_SCHEMA, MAIN_GENERAL_TOOLS_FOR_LLM } = require('./tools_schema');
  const _mainTools = new Set(MAIN_GENERAL_TOOLS_FOR_LLM);
  // R18 修 (老板 7/25 13:27 截图 + v3 原则 'agent 动手 + 老板整合'): 不加 file_find / file_grep
  // 老板场景复现: "我是原告,被上诉方,怎么应对" → LLM 选了 file_find ×2 不是 risk_assessment
  // 根因: R15 手动加了 file_find/file_grep → gemma-4-26b 4-bit 弱模型字面 + R15 强加, 选 file_find (字面接近"扫描文件夹")
  // 修: main 集不加 file_find/file_grep (executor 类), 法律问题只看到 analyzer 工具 (risk_assessment/critical_point_analysis)
  // 老板真要查文件 → main 集有 read_file (单文件读), 不该调 file_find (扫整个目录)
  // 2026-07-27 修: tools_schema MAIN_GENERAL_TOOLS_FOR_LLM typo 修完, 不用再 hack
  // 老代码: ['read_file'].forEach(n => _mainTools.add(n)); (因 file_read typo 漂移加的)
  // 2026-09-14 (老板拍 #6: marketplace 对内重组): toolsSchema 顺序过 tool_layout —
  // 老板在工具箱「内部」tab 调的顺序 = LLM 看到的工具顺序 (越靠前越优先选), 真实生效不是死配置
  const _toolLayout = require('./tool_layout');
  // 2026-09-16 老板拍: 子 agent 按职能配工具 — 职能工具名单由 dispatcher 注入 opts.toolsAllowed
  // (来源 sub-agent.js ROLES.tools, 与 prompt 角色白名单同源), 不再给全量工具让角色自己选
  // 非 main 角色 (dispatcher 传的 role=executor 等) 且无 toolsAllowed → 仍用全量 (向后兼容旧调用)
  // 2026-10-13 (soak-live-1791878818): 计算搬进 j2_loop_shared.buildRoleToolFilter ——
  // 非 main 角色一律补 task_done 收口信号, 否则子 agent 干完了也调不到那个工具,
  // 烧完 3 次自动续跑退出为 partial (现场答案「无法实际调用 task_done」)。
  const _roleToolFilter = _buildRoleToolFilter(_roleForThisLoop, opts && opts.toolsAllowed,
    Boolean(opts && opts.enforceToolFilter));
  if (_roleToolFilter) {
    console.log('[j2-role-tools] role=' + _roleForThisLoop + ' 职能白名单 ' + _roleToolFilter.size
      + ' 工具 (含收口工具 task_done)');
  }
  // 2026-10-17: 这一段原来**自己**判 `_roleForThisLoop === 'main' ? _mainTools : ...`,
  // 于是即便 buildRoleToolFilter 真给 main 算出了白名单, 喂给模型的工具集仍然是全套 ——
  // 白名单"算了但没接线", 而 LLM 那边什么异常都看不到。判据只能有一处:
  // 先算出**有效工具集** (_effectiveTools), 后面一律用它。
  const _effectiveTools = _roleToolFilter || (_roleForThisLoop === 'main' ? _mainTools : null);
  const toolsSchema = _toolLayout.orderSchemas(_effectiveTools
    ? Object.values(TOOLS_SCHEMA).filter(Boolean).filter(s => _effectiveTools.has(s.function && s.function.name))
    : Object.values(TOOLS_SCHEMA).filter(Boolean));
  //
  // 2026-10-24 (第 80 批): 把「这一轮真能调的集」**连同名字**带下去, 让提示词里的
  // 工具清单跟 API schema 对齐。
  //
  // 现场 (probe79-mcp 日志实测): 拆解轮 (role='main' + toolsAllowed=['dispatch_subagents'])
  // 的 API schema 只有 **2 个**工具 (dispatch_subagents + task_done),
  // 而 llm_caller 的工具清单按角色档给了它 main 的 **38 个** ——
  // 它一个都调不到, 却白背 6042 字符 ≈ 2115 token, 整刀 **183.7 秒**。
  //
  // 这跟第 79 批修的是**同一个病** (清单比 schema 多 ⇒ 模型看得见调不到),
  // 只是那次修的是「角色档 vs 全量」, 这次是「toolsAllowed 收窄 vs 角色档」。
  // ⇒ 口径统一成一句话: **清单 = 这一轮真能调的集**, 而 API schema 用的是哪个集合,
  // 清单就用同一个 —— 不许两处各算一份。
  const _callableToolNames = _effectiveTools
    ? Array.from(_effectiveTools).filter(n => TOOLS_SCHEMA[n])
    : null;
  // 2026-10-24 (第 79 批): **MCP 工具要进 API schema —— 但只给 worker, 不给 main**。
  //
  // 现场: 提示词里明明写着「MCP 工具 (44 个) … 跟内部工具一样直接用」, 而 TOOLS_SCHEMA 里
  // `mcp__` 开头的工具是 **0 个** ⇒ 模型看得见这 44 个工具的名字, 却一个都签不出来。
  // 执行层是通的 (pangu-single 的 executeToolCalls 有 `mcp__` 前缀路由 → mcp_adapter),
  // 断的是**签名** —— 而签名这件事只有 API schema 说了算。
  //
  // 为什么**不给 main** (实测踩到的真回归, 别改回去):
  //   第一版给 main 也接了 ⇒ 一轮 82 个工具 (38 内部 + 44 MCP)。
  //   实跑对照 (同一句「现在几点了?」, 同一模型, 唯一差别是这 44 个):
  //     · HEAD 版 (38 个工具): 调了 current_time + task_done ⇒ success:true, 84.8s
  //     · 给了 MCP 版 (82 个): **一个工具都没调** ⇒ success:false, 100.7s
  //   原因不是 current_time 不在 schema 里 (它在, 位置 20/38), 是**选择噪声** ——
  //   44 个用不上的工具挤在 38 个内部工具后面, 把模型的选择淹了。
  //   这跟 2026-07-25 老板拍的那条是同一个病 (「LLM 看到 110 工具全可选 → 优先级混乱」),
  //   当年把 main 收窄到 38 个, 现在不能又加回来。
  //
  // 那 MCP 工具给谁? 给 **worker** —— 查 GitHub / 读文件这类活本来就是子 agent 干的
  // (kun 18 / li 21 / dui 19 / xun 11 各自的白名单)。main 走 dispatch_subagents 派活即可。
  // worker 的工具位本来就是"这一档要用的", 多 44 个不构成噪声 (它们全都可能用)。
  //
  // 体积: 44 个精简版 (parameters 空, 参数说明在 description) ≈ 2200 token。
  // 完整版是 11527 —— 那会让 prefill 从 19.3k 涨到 30.8k, 正好是本批要治的病。
  // 见 llm_caller._mcpSchemasForLLM 的注释。
  let _mcpSchemas = [];
  if (_roleForThisLoop !== 'main') {
    try {
      const _lc = require('./llm_caller');
      if (_lc && typeof _lc._mcpSchemasForLLM === 'function') {
        // 传角色进去: 只读角色只拿只读的 MCP 工具 (判据在 llm_caller 那一处,
        // 别在这里再写一份 —— 两处名单迟早漂, 而漂了就是"只读角色看得见写盘工具")。
        _mcpSchemas = _lc._mcpSchemasForLLM(_roleForThisLoop) || [];
      }
    } catch (e) { /* MCP 没起来不该拖垮主路 */ }
  }
  if (_mcpSchemas.length) {
    // MCP 工具名不跟内部工具重名 (mcp__ 前缀), 直接拼在后面即可。
    toolsSchema.push(..._mcpSchemas);
  }
  const { TOOLS } = require('./tools');
  const { checkToolCall } = require('./sandbox');
  // 2026-10-24 (第 79 批): MCP 工具的**唯一执行入口**。
  //   native 路径以前直接 `TOOLS[tc.name](...)`, 而 TOOLS 表里 `mcp__` 开头的工具
  //   是 0 个 ⇒ 模型按修好的 schema 签得出调用, 一调就炸 "is not a function"。
  //   legacy 那条 (pangu-single 的 _j2ExecuteToolCalls) 有 mcp__ 路由, native 没有,
  //   而本地模型 (LM Studio) 走的就是 native ⇒ 两路必须走同一份。
  const { isMcpToolName: _isMcpToolName, execMcpTool: _execMcpTool } = require('./mcp_tool_exec');

  // 探测 model 是否支持 native tool_calls (探测后缓存, 不每次重跑)
  let nativeToolCallSupported;
  try { nativeToolCallSupported = await _deps._detectToolCallSupport(model); }
  catch (_) { nativeToolCallSupported = false; }
  // R17 修 (P0-A 防御性): !== false 在 nativeToolCallSupported 返回 undefined/null/0 时仍 true, 收窄到 === true
  // 当前 detection (j2_helpers._detectToolCallSupport) 必返回 boolean, 但未来重构若破坏契约, 防御更稳
  const useNative = nativeToolCallSupported === true;
  const executionPath = useNative ? 'j2-native' : 'j2-legacy';
  // 2026-10-23 (第 73 批): 「工具空转」守门实例。
  //   判定逻辑全在 tool_spin_guard.js (唯一真源), 这里只决定**两条路的口径差异**:
  //   native 的工具轮 assistant content 经常是空的 (模型把话放进 reasoning 通道),
  //   "这一轮说过话"在 native 上没有信息量 ⇒ R3 改用"手上有没有证据"当解禁条件,
  //   否则合法的多文件阅读会在第 3 次就被喊停 (提前收口 = 活没干完就交差)。
  //   legacy 的模型会在工具轮里写说明, "说过话"在那里有信息量 ⇒ 口径保持原样。
  const _spinGuard = require('./tool_spin_guard').createToolSpinGuard({
    domainRuleNeedsEvidence: useNative,
  });
  console.log('[j2-path]', JSON.stringify({ model: model.id, provider: model.provider || null, path: executionPath }));
  try {
    res.write('event: execution_path\ndata: ' + JSON.stringify({
      model: model.id,
      provider: model.provider || null,
      path: executionPath,
      tool_call_support: !!nativeToolCallSupported,
    }) + '\n\n');
  } catch (_) {}

  // 2026-09-03 修 #R80-priorctx-legacy (老板报'没办法引用上一条 Session'):
  // 原本 _priorCtx 算在 native 分支里 (line ~308), legacy 路径彻底漏掉 — 非 native tool_call 的模型切/开新 session 时
  // 跨会话上下文全丢, 老板说"上一条那个 X 怎么修" 盘古接不上。
  // 修: 提到 useNative 分支前, legacy + native 两条路径都用。
  //
  // 2026-10-25 (第 82 批): **planner 档整段不拿 priorCtx**。
  //   上面那个"家族前缀排除兄弟"的修复只解决了**同一父会话**的兄弟刀
  //   (desktop-1792838641545#sub-0-li 那一类)。但 priorCtx 装的是
  //   **最近 3 个会话**的 checkpoint —— 里面绝大多数是**别的父会话**的刀。
  //
  //   实跑证据 (2026-10-25 02:00, probe82-cannot-split 的 #main-plan 落盘):
  //     msg0 里那段 priorCtx 装的是
  //       [soak-live-1791888078#sub-2-executor] 根据 checker 在 …
  //       [soak-live-1791896265#sub-1-checker] 对 /tmp/pangu_soak_… 下的 8 份文件 …
  //       [probe-1792370454#main-plan] 拆不动。 这是一件事：读 apps/core/modules/pangu_dogfood.js …
  //     cs-5 / cs-4 / cs-3 三条 Prior session
  //   最后那条是**上一轮的拆解轮 prompt** ——
  //   拆解轮的活恰恰是**把任务切小**, 喂它上一轮的切法原文, 它只会照抄。
  //
  //   为什么 planner 根本不需要这段:
  //     · 主人这一轮的话, dispatcher 已经**原样**送进来了
  //       (_planTask = _historyBlock + userInput, 见 j2_dispatcher.js:1837);
  //     · **当前会话**的历史在 _historyBlock 里, 那是它该看的;
  //     · 跨**会话**的 checkpoint 是别的主人对别的活说的 —— 对"切几刀"零贡献。
  //   跨会话连续性是**主对话**的价值 (老板 2026-09-03 报的"引用上一条 Session"),
  //   那是 main 档的事, main 档照旧拿, 一段都不少。
  //
  //   ⚠ 这里**不碰 _priorCtxCache** —— 那是模块级单槽缓存, 主会话和拆解轮
  //     共用。拆解轮往里写空值会把主会话已缓存的 priorCtx 冲掉,
  //     下轮主 agent 得重算一遍 (而且算出来的可能已经不是同一段了)。
  //     所以只在**取值**处短路, 缓存一个字都不动。
  const _priorCtx = (_soulScope === 'planner')
    ? ''
    : ((_priorCtxCache && _priorCtxCache.sessionId === _sessionId)
    ? _priorCtxCache.prompt
    : (() => {
        try {
          // 2026-10-16: 子 agent 必须把**兄弟**也排除掉, 不只是自己。
          // 子 agent 的 sid 恒为 `父会话#sub-N-role` —— 同一轮派出去的兄弟恰好就是
          // "最近 3 个会话", 于是它们的原始 prompt 转录被当上文整份灌进系统提示。
          // 实测 sub-2-analyzer 系统块 12639 字 (上一轮同代码路径 9889 字), 多出的
          // 约 7.3k 字是三份逐字重复的兄弟刀 prompt, 里面带着**主人的全量路径清单**,
          // 它因此去读了兄弟的文件 (工具结果 35.8k 字, 而它只被派了一个)。
          // 兄弟产出有正规通道 (_ctxForSubagent 的 findingsBlock, 按相关性筛过、摘要过),
          // 这里只需要"上一手真实对话", 不该要同一轮兄弟的原始 prompt。
          // 主 agent (sid 里没有 #sub-) 行为不变 —— 跨会话连续性照旧。
          //
          // 2026-10-25 (第 82 批): **拆解轮 (#main-plan) 也要算家族前缀**。
          //   原来只认 '#sub-' —— 所以拆解轮 (sid = `父会话#main-plan`) 的
          //   familyPrefix 是 null, 于是它把**同一轮兄弟刀的 checkpoint**
          //   当"最近 3 个会话"整份灌了进来。
          //   现场 39268686 实测: 拆解轮 msg0 里那段「跨会话上下文」2390 字,
          //   三条全是兄弟会话 —— desktop-1792838641545 / #sub-0-li(r21) / #sub-0-li(r20),
          //   而 desktop-1792838641545 在整段里出现 **7 次**。
          //   那些是**别的会话**的兄弟刀 prompt (带主人全量路径清单)。
          //
          //   ⚠ 判据为什么是"兄弟"而不是"自己": checkpoint 文件名把非
          //     [A-Za-z0-9_-] 换成 '_', 所以 '#sub-0-li' 落盘成 '_sub-0-li'。
          //     而 excludeSessionPrefix 是**文件名前缀**匹配 ⇒ 要排除兄弟,
          //     前缀必须取 '#' 之前的**父会话 id**。
          //   这里改成取第一个 '#' 之前那段 —— 对 '#sub-' 和 '#main-plan' 一视同仁。
          const _sid = String(_sessionId || '');
          const _hashAt = _sid.indexOf('#');
          const _familyPrefix = _hashAt > 0 ? _sid.slice(0, _hashAt) : null;
          const items = loadRecentSessionContext({
            excludeSessionId: _sessionId,
            excludeSessionPrefix: _familyPrefix,
            limit: 3,
          });
          const prompt = buildPriorContextPrompt(items);
          _priorCtxCache = { sessionId: _sessionId, prompt };
          return prompt || '';
        } catch (_) { return ''; /* prior_session 抛错不致命, 静默降级 */ }
      })());

  // 加入 legacy prompt 仅在 native 不可用时 (native 路径用 system prompt 即可)
  if (!useNative) {
    const hasLegacyPrompt = messages.some(m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[Legacy Tool Mode - J2]'));
    if (!hasLegacyPrompt) {
      // R15 修 (plan-mode-tool-selection spec 2nd pass): TOOL_SELECTION_GUIDE 提到最前, 在工具列表之前
      // 老板 2026-07-25 12:42 截图: R14 fix 装饰 — LLM 还是选 list_directory × 4
      // 根因: TOOL_SELECTION_GUIDE 在 prompt 末尾, LLM (gemma-4-26b) 已按 priority 顺序读 tool 列表
      // 解: TOOL_SELECTION_GUIDE 提前到工具列表之前, 并强制带 ROLE=main 标签 (j2_helpers 按角色过滤工具集)
      const _l2Hint = _getL2Hint();
      // 2026-10-25 (第 82 批): planner 拿**极简**尾巴。
      //   原来这三样一起塞给它:
      //     ① TOOL_SELECTION_GUIDE (R18, 1229 字) —— 教它"法律问题调 risk_assessment、
      //        读文件调 read_file、查状态调 http_check", 而它的 API schema 里
      //        **只有 dispatch_subagents + task_done** 两个工具。
      //     ② buildAgentLegacyPrompt({role:'main'}) —— 列的是 **main 的 38 个工具**。
      //     ③ L2 hint —— 主 agent 的今日异常聚合。
      //   三样都在描述"一个它不是的身份 + 一套它调不到的工具" ——
      //   跟第 79 批修的「工具清单比 schema 多」是同一个病, 只是搬到了 legacy 尾巴上。
      const _isPlanTier = (_soulScope === 'planner');
      const j2Prompt = _isPlanTier
        ? '[拆解轮模式] 你只准调 dispatch_subagents 一个工具, 不许调别的, 不许自己动手做。'
        : ((_l2Hint ? _l2Hint + '\n\n' : '') + TOOL_SELECTION_GUIDE + '\n\n' + j2Helpers.buildAgentLegacyPrompt({ role: 'main' }));
      let attached = false;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'system') {
 // #5 全局铁律 + Legacy Tool Mode 提示 + 跨会话上下文 都注入 system message
          // 2026-09-03 修 #R80-priorctx-legacy: legacy 路径也加 _priorCtx, 不然切/开新 session 上下文全丢
          _injectGlobalRulesOnce(messages, i, _priorCtx, j2Prompt, _soulScope, _roleForThisLoop);
          attached = true;
          break;
        }
      }
      if (!attached) {
        if (!_hasGlobalRulesIn(messages)) {
          // planner 档不注入 priorCtx —— 判据见 _injectGlobalRulesOnce 里那段说明。
          // 这里两条兜底 unshift 也必须认 (它们是"messages 里没有 system 消息"时的退路),
          // 口径跟注入函数保持一致, 不各写一份。
          messages.unshift({ role: 'system', content: _getGlobalRules(_soulScope) + _readSelfKnowledge(_soulScope) + _readMemorySnapshot(_soulScope) + ((_soulScope === 'planner') ? '' : (_priorCtx || '')) + _identityLineFor(_soulScope, _roleForThisLoop, 'Legacy Tool Mode') + j2Prompt });
        }
      }
    }
  } else {
    // Native path: 简短的 system prompt — 强调必须 tool_call
    // R15 修 (plan-mode-tool-selection spec 2nd pass): 置顶 HARD RULE + TOOL_SELECTION_GUIDE
    // 2026-10-12 (老板现场证据 probe-ctx-20261012-1): 主人明说"只回答这两个, 不要调用任何工具",
    // 盘古照样调 system_info ×2 —— 因为下面这条"≥1 工具"是无条件注入的, 压过了主人的话。
    // 长会话里每一句短的"直接答"都要多烧两次工具调用, 这正是"持续工作"变贵的来源之一。
    // 收窄: 只有主人**显式**说了不要工具/直接答, 才把硬规则换成直答模式; 其余一律照旧。
    const _wantsDirectAnswer = wantsDirectAnswer(userInput);
    const _directHint = '\n\n[主人明确要求直答] 本轮主人说了只要答案、不要工具 —— **禁止调用任何工具**, 直接用你已有的上下文回答。回答完即结束。\n\n';
    const _nativeHardRule = _wantsDirectAnswer
      ? _directHint
      : `\n\n[!!! HARD RULE — 必须先选对工具才回答 !!!]\n老板问 "怎么应对 / 法律 / 策略 / 评估 / 风险" 等问题 → 你**必须**调用 \`risk_assessment\` 或 \`critical_point_analysis\` 工具.\n**禁止**只调 \`current_time\` + \`task_done\` 收手. 老板看到会拍桌子.\n先调工具拿结果 → 根据工具结果回答 → 才能 \`task_done\`.\n\n[Native Tool Mode] 你支持原生 function calling. 请用 tool_call 形式调用 ≥1 工具完成任务, 不要只用自然语言回答.\n\n`;
    const _l2Hint = _getL2Hint();
    //
    // 2026-10-25 (第 82 批): planner 拿**极简** native 尾巴。
    //   现场 39268686 实测: 拆解轮 msg0 末尾就是这段 —
    //     [!!! HARD RULE — 必须先选对工具才回答 !!!]  ← 要求调 risk_assessment /
    //       critical_point_analysis, 而拆解轮的 schema 里**这两个都没有**
    //     [Native Tool Mode]  ← "调用 ≥1 工具完成任务, 不要只用自然语言回答"
    //     R18 TOOL_SELECTION_GUIDE (1229 字)  ← 教它按场景选 38 个工具
    //
    //   三处都是**跟拆解轮直接冲突**的:
    //     · HARD RULE 说"必须调 risk_assessment" —— 调不到, 模型要么违规试调
    //       (被 enforceToolFilter 拦掉, 白烧一轮), 要么无视这条硬规则
    //       (那这条硬规则就等于没下发, 秩序被破坏)。
    //     · R18 教的是"收到问题先挑对工具" —— 而拆解轮的工具**已经定死**了。
    //     · "不要只用自然语言回答" 跟 dispatcher 的铁律⑤"拆不动就直接说拆不动"
    //       **正面冲突** —— 拆不动的题恰恰要求它只说一句自然语言。
    //
    //   所以 planner 这一档换成一句话: 你只准调 dispatch_subagents。
    const nativeHint = (_soulScope === 'planner')
      ? '\n\n[拆解轮模式] 你只准调 dispatch_subagents 一个工具, 不许调别的, 不许自己动手做。拆不动就直接说「拆不动」, 不要调工具。\n\n'
      : (_nativeHardRule + (_l2Hint ? '\n' + _l2Hint + '\n' : '') + TOOL_SELECTION_GUIDE);
    const sysIdx = messages.findIndex(m => m.role === 'system');
 // §0.31 跨会话上下文 (新 session 才注入; 同 session 内部 round 不重复注入)
    // 2026-09-03 修 #R80-priorctx-legacy: _priorCtx 已提到外面 (line ~265), 这里直接复用, 不重复算
 // #5 全局铁律追加到 native system prompt
    // 2026-09-03 修 #R80-sysinject: IIFE 兜底 _getGlobalRules() 抛错
    if (sysIdx >= 0) _injectGlobalRulesOnce(messages, sysIdx, _priorCtx, nativeHint, _soulScope, _roleForThisLoop);
    else if (!_hasGlobalRulesIn(messages)) {
      // planner 档不注入 priorCtx (同上面的兜底路径, 口径一致)
      messages.unshift({ role: 'system', content: _getGlobalRules(_soulScope) + _readSelfKnowledge(_soulScope) + _readMemorySnapshot(_soulScope) + ((_soulScope === 'planner') ? '' : (_priorCtx || '')) + _identityLineFor(_soulScope, _roleForThisLoop, '') + nativeHint });
    }
  }

  // 2026-09-12 e2e 实战修: 自动续跑抽成共享函数 — 两个触发点:
  // ① maxRounds 耗尽且 task_done 未被验收 (长任务被轮次切)
  // ② task_done 被"部分放行"验收 (_taskDonePartialOk + 剩余清单) — 体量预检设计是"剩余下轮补",
  //    auto-resume 让"下轮"自动化, 不等主人人肉"继续" (e2e 实案: 6 文件消化做 1 个就带 success 收场)
  // 返回 true = 已压缩+重置, 调用方应 round=-1; continue
  const _autoResumeMax = parseInt(process.env.PANGU_AUTO_RESUME_MAX || '0', 10);
  const _tryAutoResume = async (reason) => {
    if (_autoResumeMax <= 0) { console.warn('[j2-auto-resume] skip: AUTO_RESUME_MAX<=0 reason=' + reason); return false; }
    try {
      // 2026-10-22 (老板「加强停顿, 走一步判断一步」· 过程侧那一半):
      //   六格判局判出「停」时, 这里**不续跑**。
      //
      //   为什么这道闸要开在续跑的最前面, 而不是判据里:
      //   判据 (六格) 在模型的轮次里跑, 续跑在**模型不接话**的时刻跑。
      //   两者不在同一个时间点上, 所以「判过了」这件事必须落到模型之外 ——
      //   那正是 `stop_point.js` 干的事 (判完写进 task checkpoint)。
      //
      //   ⚠️ 顺序敏感: 这道闸在 `_autoResumeMax<=0` 之后、`_objectiveWorkRemaining`
      //   之前。早了会让「自动续跑整个没开」的任务也去读盘 (白开销 + 误导日志);
      //   晚了会让已经判定「客观无剩余工作」的任务被停点拦一次 (结论一样, 但日志
      //   会把「停点拦的」误报成「无剩余工作」—— 而这两个是完全不同的收口原因)。
      const _sp = (() => {
        try {
          const _consult = require('./stop_point').consultForResume(
            _sessionId, String(userInput || '').slice(0, 500));
          return _consult.stop ? _consult : null;
        } catch (_) { return null; }
      })();
      if (_sp) {
        console.warn('[j2-auto-resume] 六格判局判「停」, 不自动续跑 reason=' + reason
          + ' | ' + String(_sp.stop_reason || '').slice(0, 120));
        // 停点要**给用户看见**, 不只是进日志: 盘古不说为什么停, 用户只看到
        // 它忽然不干了 —— 那是静默失败的老毛病, 换个马甲。
        // 所以把停点原文追加进给用户的收口消息 (走 finalText → emitFinalOnce)。
        const _spNote = '\n\n【六格判局 · 停】' + (String(_sp.verdict_label || '停'))
          + '\n' + String(_sp.stop_reason || '')
          + '\n下一步: ' + String(_sp.next_step || '')
          + '\n(想继续就说「继续」—— 停的是我自动往下冲, 不是不许你推我。'
          + '判据来自 ' + String(_sp.source || '六格判局') + ', '
          + String(_sp.disclaimer || '') + ')';
        if (!_state._stopPointNoted) {
          _state._stopPointNoted = true;
          try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '六格判局判「停」: ' + String(_sp.stop_reason || '').slice(0, 200) + ' (自动续跑已停, 说「继续」可恢复)' }) + '\n\n'); } catch (_) {}
        }
        // 追加而不是覆盖: 保留模型自己这一轮的收口内容。
        finalText = (finalText && String(finalText).trim())
          ? (String(finalText).replace(/\s+$/, '') + _spNote)
          : ('【六格判局 · 停】' + String(_sp.stop_reason || '') + '\n下一步: '
            + String(_sp.next_step || '') + '\n(想继续就说「继续」。'
            + String(_sp.disclaimer || '') + ')');
        totalChars = String(finalText).length;
        return false;
      }
      const plan = require('./plan_state');
      const _plan = plan.loadPlan(_sessionId);
      const _tc = require('./task_checkpoint');
      const _prev = _tc.loadTaskCheckpoint(_sessionId) || {};
      // 不传 opts: 这里要的是**原语义** (心跳 active 就是"上次没干完") ——
      // partial_task_done / task_done_rejected / 崩溃恢复三条路径都靠它, 一个字不改。
      // 2026-10-17 曾在这里传 invocationStartedAt, 结果砍掉了长任务的续跑 (S2/S4 红了), 已撤回。
      const _obj = _objectiveWorkRemaining(_sessionId);
      const _pendingCount = _obj.pending;
      const _hasActiveTask = _obj.hasActiveTask;
      if (!_obj.remaining) {
        console.warn('[j2-auto-resume] skip: 客观已无未完成工作 (pending=' + _pendingCount + ', checkpoint status=' + (_prev.status || 'null') + ') reason=' + reason);
        return false;
      }
      let _resumes = (_prev.auto_resumes || 0) + 1;
      // 2026-10-16 (现场取证 session request-1792124456972-8cekw6#sub-0-analyzer):
      // 无进展检查原来只在 `_resumes > _autoResumeMax` **之后**才跑, 于是前 3 次续跑
      // 无论有没有进展一律照烧。那轮现场账单: pending=0、plan 一个 pending 步骤都没有,
      // 子 agent 已经 task_done 交卷, 但 checkpoint 还挂着 status=active + goal,
      // `hasActiveTask` 就一直为真 → 续跑 3 次, 每次重读**同一个**内容不变的文件,
      // 每次一轮 LLM 约 214s, 白烧 10 分钟以上, 交回的还是同一份答案。
      //
      // 下面这段把同一个双信号 (plan done 步数 / 不同文件数) 提前到**每次**续跑前判。
      // 它读写的基线字段 (done_at_last_resume / files_at_last_resume) 与 1281 行那段
      // 完全是同一对 —— 不新增状态, 只把判定时机提前, 避免"同一判据抄两遍迟早只改一处"。
      // 第 1 次续跑 (_resumes === 1) 没有上一次基线可比, 照旧放行。
      if (_resumes > 1) {
        const _donePre = _plan ? (_plan.steps || []).filter(s => s.status === 'done').length : 0;
        const _doneAtPre = (typeof _prev.done_at_last_resume === 'number') ? _prev.done_at_last_resume : -1;
        const _filesPre = (typeof _prev.files_touched_count === 'number') ? _prev.files_touched_count : 0;
        const _filesAtPre = (typeof _prev.files_at_last_resume === 'number') ? _prev.files_at_last_resume : -1;
        // 基线缺失 (-1) 说明上一次续跑没存下可比数字 —— 不猜, 照旧放行这一轮。
        if (_doneAtPre >= 0 || _filesAtPre >= 0) {
          const _planProgressPre = _donePre > _doneAtPre && _donePre > 0;
          const _fileProgressPre = _filesPre > _filesAtPre && _filesPre > 0;
          if (!_planProgressPre && !_fileProgressPre) {
            console.warn('[j2-auto-resume] 上一轮续跑无实质进展 (done ' + _doneAtPre + '→' + _donePre
              + ', files ' + _filesAtPre + '→' + _filesPre + '), 不再空转, 直接收口 reason=' + reason);
            _tc.saveTaskCheckpoint(_sessionId, Object.assign({}, _prev, { auto_resumes: _resumes - 1 }));
            return false;
          }
        }
      }
      if (_resumes > _autoResumeMax) {
        // 2026-09-14 (老板拍 #1 长任务等指示): 预算防的是原地打转, 不是惩罚有进展的长任务 —
        // 上限到达先看进展。进展 = 双信号 (10:46 三命通会实战: 模型写 3 份 digest 但不调 plan_step_done,
        // 单看 plan 误判无进展收口):
        //   ① plan done 步数比上次续跑时多
        //   ② 真写盘文件数 (checkpoint files_touched_count) 比上次续跑时多 — 有产出就是有进展
        const _doneNow = _plan ? (_plan.steps || []).filter(s => s.status === 'done').length : 0;
        const _doneAtLast = (typeof _prev.done_at_last_resume === 'number') ? _prev.done_at_last_resume : -1;
        // 2026-10-13: 原来这里数的是写盘**事件数**, 反复重写同一批文件就能灌水 ——
        // 现场 done 0→0 而 files 12→130, 每轮都判成有进展, 预算反复重置,
        // 子 agent 锁死在重复循环里收不了尾。
        // 灌水的**源头在写入端**: 那个字段现在由 countDistinctFilesTouched 赋值 (不同文件数),
        // 所以这里照旧读同一个字段、照旧把基线存回同一个字段 —— 接线形态一个字没动,
        // 变的只是这个字段装的数不再是「动作次数」。接线一致性由 budget-compact-progress 钉住。
        const _filesNow = (typeof _prev.files_touched_count === 'number') ? _prev.files_touched_count : 0;
        const _filesAtLast = (typeof _prev.files_at_last_resume === 'number') ? _prev.files_at_last_resume : -1;
        const _planProgress = _doneNow > _doneAtLast && _doneNow > 0;
        const _fileProgress = _filesNow > _filesAtLast && _filesNow > 0;
        if (_planProgress || _fileProgress) {
          console.warn('[j2-auto-resume] 上限到达但有实质进展 (done ' + _doneAtLast + '→' + _doneNow + ', files ' + _filesAtLast + '→' + _filesNow + '), 预算重置续跑 reason=' + reason);
          _resumes = 1;
        } else {
          console.warn('[j2-auto-resume] 上限到达且无实质进展 (' + _resumes + '/' + _autoResumeMax + ', done=' + _doneNow + ', files=' + _filesNow + '), 收口 reason=' + reason);
          _tc.saveTaskCheckpoint(_sessionId, Object.assign({}, _prev, { auto_resumes: _resumes }));
          return false;
        }
      }
      try { _compactor.register(_sessionId, messages); } catch (_) {}
      // 2026-09-12 e2e 实战修: 压缩不是续跑的前置条件 — 旧逻辑 if(!compactedMessages) return false,
      // 小会话 (消息少, shouldCompact=false) 不产出 compactedMessages → 续跑永远不放行 (e2e 实案:
      // 10 条消息的会话 maxRounds 耗尽, 无需压缩也就不续跑)。能压则压, 压不了直接续。
      const _cRes = await _compactor.compact(_sessionId);
      let _before = messages.length;
      if (_cRes && _cRes.compactedMessages) {
        messages = _cRes.compactedMessages;
      }
      console.log('[j2-auto-resume] compact ' + _sessionId + ': ' + _before + ' -> ' + messages.length + ' msgs (reason=' + reason + ', pending=' + _pendingCount + ', checkpoint_task=' + !!_hasActiveTask + ', resume #' + _resumes + '/' + _autoResumeMax + ')');
      try { res.write('event: auto_resume\ndata: ' + JSON.stringify({ reason, pending_steps: _pendingCount, resume: _resumes, max_resumes: _autoResumeMax, from: _before, to: messages.length }) + '\n\n'); } catch (_) {}
      // 2026-09-13 P2b (老板: 模型失忆, 盘古要起作用): 续跑 = 压缩后的新起点,
      // 压缩可能切掉开工时注入的账本快照 — 这里剥旧账注重注最新账 (已读/已写/假路径/教训),
      // 模型续跑后第一眼就是真账, 不靠印象接着干。
      try {
        messages = messages.filter(m => !(m && m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('# 任务账本')));
        const _resumeLedgerText = require('./task_ledger').renderLedgerForSession(_sessionId);
        if (_resumeLedgerText) messages.push({ role: 'system', content: _resumeLedgerText });
      } catch (_) {}
      if (_pendingCount > 0) {
        messages.push({ role: 'system', content: '[自动续跑] ' + reason + ', plan 还有 ' + _pendingCount + ' 个 pending 步骤 — 已自动压缩 + 续跑 (第 ' + _resumes + '/' + _autoResumeMax + ' 次). 当前步骤: ' + (_plan.current_step || '?') + '. 不要重复已完成的步骤。' });
      } else {
        messages.push({ role: 'system', content: '[自动续跑] ' + reason + ', 任务「' + String(_prev.goal || '').slice(0, 100) + '」尚未全部完成 — 已自动压缩 + 续跑 (第 ' + _resumes + '/' + _autoResumeMax + ' 次). 继续推进剩余工作, 不要重复已完成部分, 全部完成时调 task_done。' });
      }
      // 2026-10-22 (老板「走一步判断一步」· 换向那一档):
      //   判「停」在上面拦住了; 判「换向」**不能拦** —— 阻力压顶不等于活干完了,
      //   恰恰是「该接着干、但别再堆料」。所以放行, 但要把换向内容带进来,
      //   否则这一档就白判了: 续跑指令还在说「继续推进剩余工作」,
      //   模型只会**继续堆料** —— 而它上一轮刚判出「阻力压着、还没产出」。
      //
      //   这里刻意只**追加一条**, 不替换原指令: 换向是给原指令加的方向修正,
      //   不是另起一套任务。判「续」与没判过 → 一条都不加 (零影响)。
      try {
        const _spNow = require('./stop_point').readStopPoint(
          _sessionId, String(userInput || '').slice(0, 500));
        if (_spNow.hit && _spNow.verdict === 'redirect') {
          console.log('[j2-auto-resume] 六格判局判「换向」, 续跑但带换向指令 (reason=' + reason + ')');
          messages.push({ role: 'system', content: '[六格判局 · 换向] ' + String(_spNow.stop_reason || '')
            + '\n下一步: ' + String(_spNow.next_step || '')
            + '\n这一轮别再往我生者(产出)上堆料 —— 先解克我者(阻力), 解开一个再回头推产出。'
            + '解完阻力重新调 wuxing_judge 判一次六格, 别沿用这一档的结论。' });
        }
      } catch (_) {}
      const _doneNow2 = _plan ? (_plan.steps || []).filter(s => s.status === 'done').length : 0;
      _tc.saveTaskCheckpoint(_sessionId, Object.assign({}, _prev, {
        auto_resumes: _resumes,
        done_at_last_resume: _doneNow2,
        // 2026-09-14 (#1b): 文件产出基线 — 下次续跑拿 _prev.files_touched_count 跟它比
        files_at_last_resume: (typeof _prev.files_touched_count === 'number') ? _prev.files_touched_count : 0,
      }));
      return true;
    } catch (e) { console.warn('[j2-auto-resume] failed:', e.message); return false; }
  };

  // R16 修 (P2-A): try/finally 兜底 — 即使 throw 也能记录 loop ended 状态
  try {
  for (let round = 0; useNative && round < maxRounds; round++) {
    // 2026-10-22 (老板「走一步判断一步」· 机制本体):
    //   每轮开头清掉上一轮的停点。
    //
    //   为什么是「轮首清」而不是「读的时候消费」:
    //   `_tryAutoResume` 的六个调用点是**顺序 if, 不是 else-if** —— 同一轮可能
    //   连着调多个 (实测: objective_incomplete 放行后紧跟 text_final_continue_intent)。
    //   「读一次消费」会让第二个调用点看不到停点, 「停」就被绕过去了 ——
    //   而且绕得悄无声息, 因为第一个调用点确实拦住了, 日志上看不出来。
    //
    //   所以顺序是: 轮 N 清 → 模型本轮判六格(写停点) → 轮末续跑决策读新鲜的
    //             轮 N+1 清 → 模型必须**重新判一次**才拦得住。
    //
    //   这就是「走一步判断一步」的机制形态: 不是记住上一步结论一直用,
    //   而是每一步都要重新看一眼。
    //
    //   ⚠️ 两条路径都要挂 —— 现场核实: native 路径每轮写 checkpoint (L1966 那一处),
    //   **legacy 路径一处都没有**。所以不能指望「顺手被 checkpoint 写覆盖掉」。
    try { require('./stop_point').clearStopPoint(_sessionId); } catch (_) {}
    // 2026-10-15: 重复注入报警 —— 只在出现多于一份时才打, 平时静默。
    // 这块 5302 token, 多一份就是本地 27B 白等 ~18s prefill; 曾经一次请求叠到 3 份
    // (占 24538 token 提示词的 40%)。留着报警是为了下次有人改压缩逻辑时能立刻看见回归。
    try {
      let _n = 0;
      for (const _m of messages) if (_m && typeof _m.content === 'string' && _m.content.indexOf(_GAR_MARK) === 0) _n++;
      if (_n > 1) console.warn('[j2-native] GAR_DUP_WARNING: 全局铁律在 messages 里重复 ' + _n + ' 份, 提示词白白变大');
    } catch (_) {}
    // 2026-10-14: 连续上下文的现场取证开关 (PANGU_DEBUG_MSGS=1 时打印实际发给模型的消息骨架)。
    // 为什么需要它: 2026-10-14 首次实测时, 注入日志明明打了"注入上文 2 轮", 但模型答的还是
    // 时间 —— 光看注入日志无法区分"注入没生效"和"注入生效了但中途被改写", 必须看实际消息。
    if (round === 0 && process.env.PANGU_DEBUG_MSGS === '1') {
      try {
        console.log('[j2-msgs] roles=' + messages.map(m => m && m.role).join(','));
        for (const _m of messages) {
          if (_m && _m.role !== 'system') {
            console.log('[j2-msgs] ' + _m.role + ': ' + String(_m.content || '').replace(/\s+/g, ' ').slice(0, 90));
          }
        }
      } catch (_) {}
    }
    rounds++;
    _markRoundActivity(_sessionId);  // §0.33: 喂 watchdog, 让 idle 自动压缩能准确判定
    // 2026-09-16 一期② 长会话自动交接: 到 200 轮 / 80 万 token 写交接卡 + 提示主人开新会话
    // (不强制切, 保守模式 — 老板拍: 先提示, 跑稳了再自动续)
    try {
      if (rounds % 10 === 1) {  // 节流: 每 10 轮检查一次, 不每轮算
        const _ho = require('./handoff');
        const _io = _getSessionInputTokens(_sessionId);
        // 2026-09-16 二期: 交接触发用消息数 (会话真实长度, 压缩不重置) 做主判据
        let _msgCount = 0;
        try { const _sc = require('./session_compaction'); const _ss = _compactor.sessions.get(_sessionId); _msgCount = _ss ? _ss.messages.length : 0; } catch (_) {}
        const _chk = _ho.shouldHandoff(_sessionId, { rounds, inputTokens: _io, msgCount: _msgCount });
        if (_chk.yes && !_state.handoffNotified) {
          const _wr = _ho.writeHandoff(_sessionId, { rounds, inputTokens: _io, reason: _chk.reason });
          if (_wr.ok) {
            _state.handoffNotified = true;  // 本 session 只提示一次
            console.log('[j2-handoff] ' + _sessionId + ': 交接卡已写 (' + _chk.reason + ', ' + rounds + ' 轮, input~' + _io + ')');
            try { res.write('event: handoff_ready\ndata: ' + JSON.stringify({ session_id: _sessionId, reason: _chk.reason, rounds, input_tokens: _io, card: _wr.path, hint: '本会话已长到 ' + rounds + ' 轮, 进度已写成交接卡 — 开新对话秒接上, 不用重发旧历史' }) + '\n\n'); } catch (_) {}
          }
        }
      }
    } catch (_) { /* 交接失败不阻塞主循环 */ }
    // 2026-08-16 P3: 算力 budget 检查 (round 开始时, 超额直接熔断退出 loop)
    const _budgetCheck = budget.recordRound(_sessionId, 0);
    if (!_budgetCheck || !_budgetCheck.ok) {
      // 2026-08-24 老板拍 (08:59 实案: rounds=21>20 会话被掐死, "居然不会自动压缩会话"):
      // 预算耗尽不再硬断 — 先强制压缩会话 + 重置 rounds 计数, 续命继续跑。
      // 底线: 每 session 最多续 MAX_COMPACT_RESETS 次 (budget.js), 其他维度仍超限照样熔断。
      let _rescued = false;
      if (typeof budget.resetRoundsAfterCompaction === 'function') {
        try {
          _compactor.register(_sessionId, messages);
          const _cRes = await _compactor.compact(_sessionId);
          if (_cRes && _cRes.compactedMessages) {
            const _beforeCompact = messages.length;
            messages = _cRes.compactedMessages;
            console.log('[j2-budget] force-compact ' + _sessionId + ': ' + _beforeCompact + ' -> ' + messages.length + ' msgs');
            try { res.write('event: compaction\ndata: ' + JSON.stringify({ from: _beforeCompact, to: messages.length, reason: 'budget_exceeded' }) + '\n\n'); } catch (_) {}
          }
          // 2026-10-13: 压不下去就不能算「续命成功」。原来不管压没压动都调
          // resetRoundsAfterCompaction 把轮次预算清零, 于是 16->14->16->14 无限循环,
          // 子 agent 原地转 18 分钟收不了尾 (现场 resume-live-1791875186#sub-0-executor)。
          // 现在压完仍 >= 阈值 = 这次压缩没解决问题, 不给续命额度, 让预算如实熔断。
          let _converged = true;
          try {
            const _th = (Number(_compactor && _compactor.config && _compactor.config.messageThreshold)) || 90;
            _converged = messages.length < _th;
            if (!_converged) {
              console.warn('[j2-budget] force-compact ' + _sessionId + ': 压到 ' + messages.length +
                ' 条仍 >= 阈值 ' + _th + ', 本次不计续命 (否则会无限循环)');
            }
          } catch (_) { _converged = true; }
          const _reset = _converged
            ? budget.resetRoundsAfterCompaction(_sessionId)
            : { ok: false, reason: 'compaction_not_converged' };
          if (_reset && _reset.ok) {
            _rescued = true;
            console.warn('[j2-budget] 自动压缩续命 #' + _reset.resets + '/' + _reset.max + ' for session ' + _sessionId);
            try { _emitStreamDelta(res, '\n\n🗜️ 轮次预算用完，自动压缩历史续命 (第 ' + _reset.resets + '/' + _reset.max + ' 次)，继续…\n', '', 0); } catch (_) {}
            // 2026-09-16 一期②: 预算耗尽续命时顺带写交接卡 + 提示开新会话 — 长会话不必硬扛到 10 次续命上限
            try {
              const _ho = require('./handoff');
              if (!_state.handoffNotified) {
                const _wr = _ho.writeHandoff(_sessionId, { rounds, inputTokens: _getSessionInputTokens(_sessionId), reason: 'budget_' + _reset.resets });
                if (_wr.ok) {
                  _state.handoffNotified = true;
                  try { res.write('event: handoff_ready\ndata: ' + JSON.stringify({ session_id: _sessionId, reason: 'budget-exhausted', hint: '本会话已长, 进度已写交接卡 — 开新对话秒接上, 不用重发旧历史' }) + '\n\n'); } catch (_) {}
                }
              }
            } catch (_) { /* 交接卡失败不阻塞续命 */ }
          } else {
            console.warn('[j2-budget] 压缩续命被拒:', _reset && _reset.reason, _reset && _reset.exceeded || '');
          }
        } catch (e) { console.warn('[j2-budget] compact-rescue failed:', e.message); }
      }
      if (!_rescued) {
        console.warn('[j2-budget] exceeded for session', _sessionId, ':', _budgetCheck && _budgetCheck.exceeded);
        try { res.write('event: budget_exceeded\ndata: ' + JSON.stringify({ session_id: _sessionId, reason: _budgetCheck && _budgetCheck.exceeded }) + '\n\n'); } catch (_) {}
        finalText = `[算力预算耗尽] session=${_sessionId} ${_budgetCheck && _budgetCheck.exceeded}. 已自动压缩续命达上限 (或其他维度仍超限), 请新建 session 或扩大预算.`;
        // 2026-09-12 修 (老板 PANGU_SCAN_REPORT_20260912 C3): 熔断文案不再拼接污染正文 —
        // 旧逻辑把 finalText 设熔断文案后 break, messages 数组残留最后一轮 assistant textContent,
        // 后续 _logSonaTrajectory 把熔断文案 + textContent 一起落盘, 污染会话记录与压缩摘要。
        // 修: 清掉最后一条 assistant (textContent), 用熔断 assistant 替换, 让会话记录与摘要干净。
        for (let _i = messages.length - 1; _i >= 0; _i--) {
          if (messages[_i] && messages[_i].role === 'assistant') { messages.splice(_i, 1); break; }
        }
        messages.push({ role: 'assistant', content: finalText });
        break;
      }
    }
    // §0.32: 手动压缩队列 — 如果 HTTP /api/pangu/admin/compact 标记了本 session, 立刻强制压缩
    if (_forceCompactQueue.has(_sessionId)) {
      _forceCompactQueue.delete(_sessionId);
      try {
        const _before = messages.length;
        const _result = await _compactor.compact(_sessionId);
        if (_result && _result.compactedMessages) {
          messages = _result.compactedMessages;
          console.log('[j2-force-compact] §0.32 ' + _sessionId + ': ' + _before + ' -> ' + messages.length + ' msgs (manual)');
          try { res.write('event: force_compact\ndata: ' + JSON.stringify({ from: _before, to: messages.length, reason: 'manual' }) + '\n\n'); } catch (_) {}
        }
      } catch (e) { console.warn('[j2-force-compact] failed:', e.message); }
    }
  // TL-6: 每 round 前 shouldCompact (早压缩早省 token, 防 §0.31 silent failure)
    // §0.56 修: 复用顶部 _state 替代 _scSessionId 取 sessionId (去重)
    const _scSessionId = _sessionId;
    // 每 round 都 register (legacy + native path 都覆盖)
    try { _compactor.register(_scSessionId, messages); } catch (_) {}
    // §0.34: 按 model context_length × ratio 动态算 token 阈值
    // 2026-09-16 老板拍: 默认 ratio 从 0.8 降到 0.3 — M3 1M 窗口不再能塞就塞, 用到 300K 才压
    // 小模型 (8K ctx, ratio 0.3) → 2.4K 就压, 及时压缩防溢出; 大模型 (1M ctx, ratio 0.3) → 300K 才压
    const _compactTokenRatio = parseFloat(process.env.PANGU_COMPACT_TOKEN_RATIO || '0.8');  // 2026-09-17 老板拍: 只在上下文 ~80% 时才压, 不主动 30% 压
    let _modelCtxLength = null;
    try {
      const _m = (opts && opts.model) || (_deps && typeof _deps.getCurrentModel === 'function' ? _deps.getCurrentModel() : null);
      if (_m && Number.isFinite(_m.context_length)) _modelCtxLength = _m.context_length;
      else if (_deps && typeof _deps.getModelContextLength === 'function') {
        const _mid = _m && _m.id;
        if (_mid) _modelCtxLength = _deps.getModelContextLength(_m || { id: _mid });
      }
    } catch (_) {}
    // 2026-09-17 老板拍: 80% 是硬压缩线 — 用户设 30% 只定"平时早压"节奏,
    // 到 80% 不管用户设什么都必须压 (防真溢出, 溢出=整轮白烧)。
    // shouldCompact 按用户 ratio 判"该早压了", 这里再叠一条: tokenCount >= ctx*0.8 强制压。
    const _hardCompactHit = _modelCtxLength && _compactor.sessions.get(_scSessionId)
      && ((_compactor.sessions.get(_scSessionId).tokenCount || 0) >= Math.floor(_modelCtxLength * 0.8));
    if ((rounds > 1 || _forceCompactQueue.size === 0) && (_compactor.shouldCompact(_scSessionId, { modelContextLength: _modelCtxLength, tokenRatio: _compactTokenRatio }) || _hardCompactHit) && messages.length > 10) {
      try {
        // 2026-08-02 修: 光判断不调用 — result/before 从未定义, compact 永远走 catch (result is not defined)
        const before = messages.length;
        const result = await _compactor.compact(_scSessionId);
        if (result && result.compactedMessages) {
          messages = result.compactedMessages;
          console.log(`[session-compaction] ${_scSessionId}: ${before} -> ${messages.length} msgs, ratio ${result.compactRatio}`);
          try { res.write('event: compaction\ndata: ' + JSON.stringify({
            from: before,
            to: messages.length,
            summary_chars: (result.summary && typeof result.summary === 'string') ? result.summary.length : (result.summary ? JSON.stringify(result.summary).length : 0),
          }) + '\n\n'); } catch (_) {}
        }
      } catch (e) { console.warn('[session-compaction] compact failed:', e.message); }
    }
    try {
      if (useNative) {
// ================ NATIVE TOOL_CALL PATH ================
        let llmResult;
        // Native responses may start with planning chatter and only later
        // contain tool_calls. Buffer it until the complete response is parsed;
        // streaming it immediately leaks orchestration text into ChatRoom.
        let streamedText = '';
        let _llmT0 = null;
        let _llmTtft = null;
        let _lastReasonT0 = 0;  // 2026-10-15: thinking 事件节流 (本地模型每秒几十个 delta)
        // 2026-10-15: prefill 死寂窗。
        // 实测 (LM Studio 2026-10-15.log, 21:14 起连续 16 次请求): execution_path 之后
        // 到第一个 reasoning delta 之间中位 8~12s, 极端一次 23.5s —— 这段时间模型在
        // prefill 一万四千 token 的 prompt, 一个字节都吐不出来。onReasoning 没东西可发,
        // 于是前端从 stream-open 到第一条 thinking 之间是纯黑屏 (只有心跳),
        // 老板看到的仍然是"跟死了一样"。心跳证明连接活着, 但界面不显示任何东西。
        // 解: 请求**发出前**先点一次 thinking:on(chars:0)。
        //   - chars=0 时 ThinkingBar 不显示字数也不报 stalled (见 ChatRoom.jsx:490
        //     `stalled = chars > 0 && sameCount >= 4`), 只是让"思考中"立刻亮起来;
        //   - 语义上也成立: 模型确实在处理这个 prompt, 只是还没轮到吐字;
        //   - _closeReasonIfOpen 兜底关灯, 保证不会留下一个永远转圈的思考条
        //     (模型直接出 tool_call 不走 reasoning、或中途抛异常时尤其重要)。
        let _reasonOpen = false;
        let _reasonChars = 0;
        // 2026-10-18 实测更正 (说明放在函数体**外面**: S8 那条测试按 `slice(def, def+700)`
        // 取窗口找 `event: thinking`, 塞在函数体开头会把真正的发射逻辑挤出窗口):
        //   这里原来有一行 `if (typeof on === 'string') _pfStop();`, 注释写的是
        //   "推理增量 (首参是字符串)" —— **但首参从来不是字符串**。llm_caller.js:1825/1830/1838
        //   只发 `onReasoning(true, chars)` / `(false, chars)`, 实机复核确认这道门从未通过,
        //   是一段死代码。
        //
        //   删掉它不影响任何行为: prefill 的收口本来就由 onText 负责 —— llm_caller 推
        //   reasoning 时走的是 `opts.onText(delta.reasoning_content)` (1827), 第一个推理
        //   增量照样落到 onText 里的 _pfStop()。
        //
        //   为什么只删不加而不是"顺手修好": 想给 reasoning 阶段加提示的直觉做法是切一个
        //   中间态, 但 **那一段界面并不黑** —— reasoning 期间 `thinking` 事件一直在发且
        //   chars 在涨, 前端 ThinkingBar 有东西可显示 (实机复核过)。再加一个 phase 只会
        //   和 ThinkingBar 讲同一件事。留这段说明是防止下一个人再在这行上做一次"接线"。
        const _emitReason = (on, chars) => {
          try {
            const now = Date.now();
            if (on) {
              if (now - (_lastReasonT0 || 0) < 250) return;
              _lastReasonT0 = now;
              _reasonOpen = true;
            } else {
              _reasonOpen = false;
            }
            if (typeof chars === 'number') _reasonChars = chars;
            res.write('event: thinking\ndata: ' + JSON.stringify({
              phase: on ? 'on' : 'off', chars: _reasonChars, ts: now,
            }) + '\n\n');
          } catch (_) {}
        };
        const _closeReasonIfOpen = () => { if (_reasonOpen) _emitReason(false, _reasonChars); };
        // 2026-10-16 生产实测 (session e2e-prefill, qwen3.8-27b-mlx @ lmstudio):
        //   第一个正文 delta 在 **92,274ms**, 期间界面只有 thinking / heartbeat,
        //   没有任何"正在读上下文"的提示 —— 主人看到的就是黑屏三分钟。
        //
        // 关键: 这一段是 **j2-native** 路径 (日志 [j2-path] path=j2-native), 不是 legacy。
        // 第一版只接在 legacy 流式分支上, 单元测试也只驱动 legacy, 全绿 —— 但生产一次都没走到。
        // 这就是"接线在、行为没变"的又一次: 必须按**实机日志量出来的路径**接线, 不能按想当然的路径。
        // native 的两条分支 (流式 / 超时熔断) 都在发 _emitReason(true, 0) 这同一个"死寂窗"锚点,
        // 所以两条都用它起进度, 用下面这一个 stop 收口 (成功/抛错/断连都收得到)。
        const _pfState = { stop: null };
        const _pfStart = (m) => {
          if (_pfState.stop) return;
          try {
            _pfState.stop = _startPrefillProgress(res, {
              input_tokens: _estimateInputTokens(messages),
              model: (m && m.id) || (model && model.id) || null,
            });
          } catch (_) { /* 进度是锦上添花, 起不来不许影响主流程 */ }
        };
        const _pfStop = () => {
          if (!_pfState.stop) return;
          try { _pfState.stop(); } catch (_) {}
          _pfState.stop = null;
        };
        // 收口点为什么分散在两处, 而不是把 onReasoning 包一层:
        //   ① onText 首 token —— 出现在 _emitReason 定义之前, 包一层就要改 onText 的写法。
        //      **这一处同时覆盖 reasoning**: llm_caller 推 reasoning 时走的是
        //      `opts.onText(delta.reasoning_content)` (llm_caller.js:1827), 第一个推理
        //      增量照样落到 onText 的 _pfStop()。
        //   ② 两个分支汇合处兜底 —— 上游一个 token 都不给就返回时, ①不会触发
        // 少任何一处, 进度就会漏到下一轮去 (每 3 秒一条, 永远挂着)。
        try {
          // TL-6: 注册 session (compactor 跟踪消息数, trigger compact)
          try { _compactor.register(_sessionId, messages); } catch (_) {}
          // 2026-07-26 老板拍 "不是流式输出": native 路径逐 token 流式 (anthropic 保持一次性 + 30s 熔断)
          if (!isAnthropic) {
            // 2026-09-16 开源默认=省钱: 长历史 (msgs>=80) 本轮自动切池里最省模型扛最贵场景。
            // 已降级过的模型记进 session, 防横跳; 历史压回阈值下 (下一轮 msgs<80) 自动切回主模型 —
            // 质量影响只限"最贵的滚雪球那一段", 平时短会话永远走老板选的模型。
            let _activeModel = model;
            try {
              const _lcf = require('./longctx_fallback');
              const _cfg = (_deps && _deps._config) || {};
              const _resolved = _manualModelSelection
                ? { model, downgraded: false, reason: 'manual-model-selection' }
                : _lcf.resolveModel(_cfg, model, messages.length, _state.longctxDowngraded || [], _estimateInputTokens(messages));
              if (_resolved.downgraded) {
                _state.longctxDowngraded = _state.longctxDowngraded || [];
                if (!_state.longctxDowngraded.includes(_resolved.model.id)) _state.longctxDowngraded.push(_resolved.model.id);
                _activeModel = _resolved.model;
                console.log('[j2-longctx] 本轮 ' + model.id + ' → ' + _activeModel.id + ' (msgs=' + messages.length + ')');
                try { res.write('event: model_switch\ndata: ' + JSON.stringify({ from: model.id, to: _activeModel.id, reason: _resolved.reason }) + '\n\n'); } catch (_) {}
              } else {
                // 没降级 (msgs<80 或全都试过了) → 清掉降级记忆, 切回主模型
                if (_state.longctxDowngraded && _state.longctxDowngraded.length) _state.longctxDowngraded = [];
              }
            } catch (_) { /* 降级逻辑挂了不影响主流程 */ }
            _llmT0 = Date.now();
            _emitReason(true, 0);  // prefill 死寂窗 — 见上方 _emitReason 定义
            _pfStart(_activeModel);
            llmResult = await _deps._callLLMForAgent(messages, _activeModel, toolsSchema, {
              // 2026-10-17 时间账: 主干每轮打角色标签, 于是"main 慢"和"子 agent 慢"
              // 在同一张 [llm-cost] 账单上能直接分开, 不用再靠总时长反推。
              perfTag: 'loop:' + String(_roleForThisLoop || 'main'),
              // 2026-10-23 (第 64 批): 本轮流式总预算的缩放。
              //   续想那一轮收紧 (0.35) —— 「走一步判断一步」的机械实现:
              //   模型想得太久, 就**别再给它无限想的时间**, 它必须交出工具或结论。
              //   1 = 不缩放 (默认)。
              streamTotalMsScale: _nextRoundStreamScale,
              onText: (d) => {
                _pfStop();  // 首 token = prefill 结束, 立刻把界面交还给正文
                // 2026-10-14: 首 token 打点 (此前全仓没有这个量纲, "慢在首 token 还是慢在工具"
                // 根本分不出来)。流式分支才拿得到, 非流式分支交给 _callLLMWithTimeout 那侧记。
                if (_llmT0 !== null && _llmTtft === null) _llmTtft = Date.now() - _llmT0;
                streamedText += d;
                // 2026-10-15 (老板: "不是流式输出, 有没有用工具完全不知道, 跟死了一样"):
                // 之前 onText 只把 token 攒进 streamedText 这个**本地变量**, res.write 一次都没有
                // —— 模型逐 token 吐出来的东西, 一个都没到界面。而 llm_caller 那侧其实
                // 早就在流式推 (还把 reasoning_content 包成 <think> 转进来, 见 L1394-1397),
                // 断点就在这个回调这里。
                // LM Studio 服务端日志实证: 21 个完整请求, 平均 77.4s / 最长 300s, 期间界面零输出。
                //
                // 为什么当初 buffer: 注释说怕 "orchestration text 泄漏进 ChatRoom"。
                // 这个顾虑是对的, 但代价是整轮静默 —— 泄漏顶多是多几行旁白, 静默是老板以为盘古死了。
                // 折中: 增量推出去 (前端 appendDelta 本来就清洗 think 标签和内心独白),
                // 编排泄漏仍由轮末 :1506 的 _isOrchestrationLeak 判定 + final 事件覆盖兜底。
                // 跟 summary 路径 (:3483) 同一套写法 —— 累积 + _emitStreamDelta 游标去重。
                _emitStreamDelta(res, d, streamedText, Math.ceil(streamedText.length / 1.5));
              },
              // 2026-10-15: 思考相位 (本地 27B 的"死寂"就是缺这个)。
              // _emitStreamDelta 会把 <think> 整段剥掉 (对的 —— 思考不该进气泡),
              // 于是本地模型那 30~300 秒的思考期里前端**一条 SSE 都收不到**。
              // 光把 onText 接通不够: 必须单独告诉前端"我在思考, 而且在变长"。
              // 节流: 每个 delta 都发太吵 (本地模型一秒能吐几十个 delta), 按 250ms 发。
              // 首个 reasoning token 同样代表 prefill 结束 —— 收口逻辑在 _emitReason 内部,
              // 这里保持 `onReasoning: _emitReason` 原样 (S8 钉的就是这一行)。
              onReasoning: _emitReason,
              // 2026-10-16: 子 agent 只带 worker 档 soul (角色提示 + 推理预算 + 当前时间)。
              // 实测一个只跑 `df -h` 的 executor, 角色提示 242 token, 主 agent 的 soul
              // 却有 9918 —— 40 倍。其中工具清单那 4291 更是**错的**: schema 已按角色
              // 收窄到 17 个, 提示词却说有 127 个, 等于教模型去调它调不到的工具。
              // 见 llm_caller._buildSystemMessages 的 soulScope 说明。
              soulScope: _soulScope,
              // 第 80 批: 清单跟 API schema 对齐 (同一轮真能调的集)。
              callableTools: _callableToolNames,
            });
            _closeReasonIfOpen();
            // 2026-10-23 (第 64 批): 缩放只作用于**这一轮** —— 用掉就复位,
            // 免得下一轮超时又继承上一轮的收紧预算 (那会让预算一路往下缩到 0)。
            _nextRoundStreamScale = 1;
          } else {
            // R13 修: 用 _callLLMWithTimeout 替代 _deps._callLLMForAgent (30s 超时熔断 + SSE warning)
            // 2026-10-14: 这里**必须传 onText**, 否则首 token 探针挂不上 → ttft 恒为 null。
            // 现场审计: 生产 trace 里 ttft 记了 27 次, 值全是 0/null —— 因为这一路
            // (非流式/超时熔断路径) 压根没给探针一个能触发的入口。TTFT 是判断
            // "慢在首 token 还是慢在工具" 的唯一量纲, 记不到就等于没有。
            _llmT0 = Date.now();
            _emitReason(true, 0);  // 同一处死寂窗 — 非流式路径同样会静默等一整轮
            _pfStart(model);
            llmResult = await _callLLMWithTimeout(messages, model, toolsSchema, {
              res, sessionId: opts.sessionId, round,
              onText: (d) => {
                _pfStop();
                if (_llmT0 !== null && _llmTtft === null) _llmTtft = Date.now() - _llmT0;
                streamedText += d;
              },
              soulScope: _soulScope,   // 同上, 非流式分支也要带
              callableTools: _callableToolNames,                          // 第 80 批: 清单跟 schema 对齐
            });
            _closeReasonIfOpen();
          }
          // 兜底: 上游一个 token 都没给就正常返回 (空响应 / 只有 usage) 时 onText/onReasoning
          // 都不会触发, 不在这里收口就会一直报到下一轮去。
          _pfStop();
          // P0-#36: recordTokenUsage (fire-and-forget, 不阻塞 round)
          try {
            const _usage = (llmResult && (llmResult.usage || (llmResult.choices && llmResult.choices[0] && llmResult.choices[0].usage))) || null;
            // 2026-10-14: 分段计时 + token 记账在这里**统一收口**。
            // 之前只在 _callLLMWithTimeout 那侧记, 可生产走的是流式分支
            // (直接 _deps._callLLMForAgent + onText), 绕开了埋点 —— 现场表现为
            // trace 只有 start/result/summary 三条, llm_timing 和 token 全是 0。
            // 两个分支在这里合流, 收在这里才不会再漏。
            const _inTok = _usage ? (_usage.prompt_tokens || _usage.input_tokens || 0) : _estimateInputTokens(messages);
            const _outTok = _usage ? (_usage.completion_tokens || _usage.output_tokens || 0) : Math.ceil((streamedText || '').length / 1.5);
            const _activeTrace = _roleTrace || _mainTrace;
            if (_activeTrace) {
              _activeTrace.event('llm_timing', {
                round: rounds,
                total_ms: _llmT0 === null ? null : Date.now() - _llmT0,
                ttft_ms: _llmTtft,
                role: _roleForThisLoop,
                model: (model && (model.id || model)) || 'unknown',
              });
              if (_usage) _activeTrace.tokens({ prompt_tokens: _inTok, completion_tokens: _outTok }, 'round' + rounds);
              else _activeTrace.estimated(_inTok + _outTok, 'round' + rounds, { round: rounds });
            }
            _llmT0 = null; _llmTtft = null;
            // 2026-07-26 修 (老板: "用的 minimax 但显示底层 LLM 全是 qwen3.6"):
            // 1) session_id 之前写死 opts.sessionId || 'default' → 全部 session 的调用都归到 default 桶,
            //    "本 session 累计" 其实是 daemon 全程累计 → 改用 _sessionId (含 reqBody.session_id 兜底链)
            // 2) 只在有 usage 时才记录 → lmstudio 流式默认带 usage, minimax/doubao 不带 (没传 include_usage)
            //    → 云端模型的调用整条消失, 看起来"全是 qwen" → 无 usage 时用估算值兜底记录, 保证模型出现
            const { recordTokenUsage } = require('./metrics');
            recordTokenUsage({
              session_id: _sessionId,
              round: rounds,
              tool_name: 'llm_call',
              model: (model && (model.id || model)) || 'unknown',
              // 2026-09-16 老板拍 "补齐 metrics": 无 usage (minimax 流式没传 include_usage) 时用估算值回填,
              // 不再是 0 — 否则 UI 看不到真实账单 (之前 input_tokens 恒 0, 烧穿了才知道)
              input_tokens: _usage ? (_usage.prompt_tokens || _usage.input_tokens || 0) : _estimateInputTokens(messages),
              output_tokens: _usage ? (_usage.completion_tokens || _usage.output_tokens || 0) : Math.ceil((streamedText || '').length / 1.5),
              cache_hit_tokens: _usage ? (_usage.cache_read_input_tokens || _usage.cached_tokens || 0) : 0,
              estimated: !_usage,
              ts: Date.now(),
            }).catch(e => console.warn('[metrics] record failed:', e.message.slice(0, 200)));
            // 2026-09-12 修 (老板 PANGU_SCAN_REPORT_20260912 C1): 把真实 token 累加进 budget —
            // recordRound(sid, 0) 是死代码, token 维度熔断永不触发。改走 recordTokens (只更新 tokens 不递增 rounds)。
            try {
              const _total = _usage
                ? (_usage.total_tokens || ((_usage.prompt_tokens || 0) + (_usage.completion_tokens || 0)))
                : Math.ceil((streamedText || '').length / 1.5);
              budget.recordTokens(_sessionId, _total);
              // 2026-09-16 一期②: 本 session 累计输入 token (交接触发用) — 只加 input 维度
              try {
                const _inTok = _usage ? (_usage.prompt_tokens || _usage.input_tokens || 0) : 0;
                if (_inTok > 0) _state.inputTokensAccum = (_state.inputTokensAccum || 0) + _inTok;
              } catch (_) {}
            } catch (e) { console.warn('[j2-budget] recordTokens failed:', e.message); }
          } catch (_) {}
          // P0-#34 + R39: 每 round 后自动 sessionSave (fire-and-forget, 不阻塞 round)
          // R39 抽出 _persistSession 显式包装, 老板场景 Pangu 真把对话写到 AgentDB
          try { _persistSession(_sessionId, messages, {
            plan_id: _state.planState && _state.planState.pendingPlan ? _state.planState.pendingPlan.plan_id : null,
            state: 'active',
            plan_state: _state.planState || null,
          }); _logSonaTrajectory(_sessionId, userInput, messages, { model }); } catch (_) {}
          // 2026-09-12 新增 (老板 PANGU_SCAN_REPORT_20260912 §5 L2): 任务级检查点 — 每 round 后保存进度
          // → 续跑 / 压缩 / 中断后能恢复 task 上下文 (跟文件级 checkpoint.js 互补, 那个存 messages)
          try {
            const tc = require('./task_checkpoint');
            // 2026-10-13: 走账本真源 (含 exec_command 重定向), 不再用内联工具名白名单
            const _filesEvents = tc.countFilesTouched(_sessionId, toolsUsed);
            // 2026-10-13: files_touched_count 的语义改成「碰过多少个**不同**文件」。
            // 这个字段的名字本来就这么读, 但旧代码写进去的是**写盘事件数**, 于是
            // 子 agent 把同一批文件重写 100 多次 → 字段从 12 涨到 130 而 plan done
            // 一直 0→0 → 每轮都判成「有实质进展」→ 预算反复重置 → 重复循环收不了尾。
            // 事件数另存到 files_touched_events, 只作观测。
            const _files = tc.countDistinctFilesTouched(_sessionId, toolsUsed);
            tc.saveTaskCheckpoint(_sessionId, {
              goal: String(userInput || '').slice(0, 500),
              status: 'active',
              last_round: rounds,
              messages_count: messages.length,
              tools_used: toolsUsed.slice(-10),
              files_touched_count: _files,
              // 2026-10-13: 事件数只作观测, 进展判据一律用不同文件数 (见 budget.js 同名注释)
              files_touched_events: _filesEvents,
              next_action: '继续按目标推进 (剩余 ' + (maxRounds - rounds - 1) + ' rounds)',
              updated_at: new Date().toISOString(),
            });
          } catch (_) { /* task_checkpoint 不阻塞主流程 */ }
        } catch (e) {
          // 关灯: 模型直接出 tool_call 不走 reasoning、或中途抛异常时, 思考条会永远转圈
          _closeReasonIfOpen();
          console.warn('[j2-native] LLM call failed:', e.message.slice(0, 200));
          // ═══════════════════════════════════════════════════════════════
          // 2026-10-23 (第 64 批): **超时必须排在所有 _isInfraError 分支的最前面**。
          //
          // 为什么: 超时 ≠ 瞬断。端点是通的, 只是这一轮算不完。
          // 排在后面 ⇒ 超时被当成「瞬断」原地重试**同一个 prompt**
          // (现场 b63-guagate3: 重试的 msgs 12 / inputTokens 16186 与第一次逐字节同大小)
          // ⇒ **必然再撞同一堵 390s 的墙**; 切云端也未必更快, 还按量烧钱。
          //
          // 超时的处置 = 认账 + 抢救 + 逼它动一步:
          //   · 工具调用已成型 → 拼成 llmResult 继续往下走, 工具照常执行 (不重试)
          //   · 已有正文       → 当本轮答复收口 (照常走定稿流水线)
          //   · 只有思考       → 已想的留在上下文 + 催它「先动一步」, 下一轮**预算收紧**
          //   · 什么都没有     → 认账收口, 说清「没算完」, 不拿半成品充数
          // ═══════════════════════════════════════════════════════════════
          if (_isTimeoutError(e.message)) {
            const _tp = _timeoutPolicy.collectPartial(e, streamedText);
            const _pTc = _tp.toolCalls || [];
            if (_pTc.length > 0) {
              llmResult = {
                choices: [{ index: 0, message: { role: 'assistant', content: _tp.content || '', tool_calls: _pTc } }],
              };
              _timeoutSalvaged = true;
              console.warn('[j2-native] 超时但工具调用已成型 (' + _pTc.length + ' 个: '
                + _pTc.map(t => (t.function && t.function.name) || '?').join(',') + ') → 照常执行, 不重试');
            } else if (_tp.content) {
              llmResult = { choices: [{ index: 0, message: { role: 'assistant', content: _tp.content } }] };
              _timeoutSalvaged = true;
              console.warn('[j2-native] 超时但正文已成型 (' + _tp.content.length + ' 字) → 收口');
            } else if (_tp.reasoning && _timeoutResumeCount < 1) {
              // 只有思考 → 续想一次: 已想的别作废, 但**必须逼它动一步**。
              _timeoutResumeCount++;
              const _nudge = _timeoutPolicy.continueNudgeText({
                attempt: _timeoutResumeCount, reasonChars: _tp.reasonChars,
              });
              messages.push({ role: 'assistant', content: '<think>' + _tp.reasoning + '</think>' });
              messages.push({ role: 'user', content: _nudge });
              _nextRoundStreamScale = 0.35;
              console.warn('[j2-native] 超时(只有思考 ' + _tp.reasonChars + ' 字) → 续想第 ' + _timeoutResumeCount
                + ' 次, 下一轮流式预算收紧到 35%');
              continue;
            } else {
              finalText = _timeoutPolicy.timeoutNoticeText({
                kind: '这一轮', seconds: _timeoutPolicy.timeoutSeconds(e.message),
              });
              evoSuccess = false;
              evoError = 'LLM_TIMEOUT';
              try {
                res.write('event: warning\ndata: ' + JSON.stringify({
                  warning: '超时收口: ' + String(e.message || '').slice(0, 160),
                }) + '\n\n');
              } catch (_) {}
              break;
            }
          } else {
            // 2026-10-16 (现场 clean-base2-20261016): 本地端点先原地重试, 原地失败过才准去
            // "挑个便宜的模型切过来"。127.0.0.1 原地重试不烧配额, 切云端按量计费 ——
            // 原来的顺序里, 我们自己因超时 destroy 引发的 ECONNRESET 会被直接判成
            // 「端点不可用」→ 公平切云端 k3-256k, 一次纯本地请求烧了云端的钱。
            // 2026-10-23 (第 64 批): `!_isTimeoutError` 这道排除**不能省**。
            //   超时是「这一轮算不完」, 不是「连接断了」; 原地重试是**同一个 prompt 再来一次**
            //   ⇒ 必然再撞同一堵墙 (现场 b63-guagate3: msgs 12 / inputTokens 16186 两次同大小)。
            //   只靠「超时分支排在前面」来保证是不够的 —— 哪天有人把分支挪下去,
            //   顺序变了而行为没变, 没人会发现。这道排除是**行为层**的保证。
            if (_isInfraError(e.message) && !_isTimeoutError(e.message) && _preferSameLocalRetry(model, _state)) {
              console.warn('[j2-native] 本地端点瞬断 → 原地重试本轮 (不切模型, 不烧配额): '
                + e.message.slice(0, 80));
              messages = messages.filter(m => !(m && m.role === 'assistant' && !m.content && !m.tool_calls));
              continue;
            }
            // 2026-09-16 开源默认=省钱: 云模型 (非本地) 网络/端点瞬断 → 立即切本地免费模型重跑本轮,
            // 不直接 fast-fail (旧逻辑 agnes 抖一下整个任务就死, 烧的钱全白费)
            // 2026-09-16 老板拍 "所有模型公平, 不分本地/云": 端点瞬断 → 按 cost 公平选下一个可用模型, 不强制本地
            if (_isInfraError(e.message) && !_state.infraSwitched && !_manualModelSelection) {
              const _lcfX = require('./longctx_fallback');
              const _alt = _lcfX._pickCheapestModel((_deps && _deps._config && _deps._config.llm && _deps._config.llm.models) || [], model.id, [model.id], _estimateInputTokens(messages));
              if (_alt && _alt.id !== model.id) {
                _state.infraSwitched = _alt.id;
                console.warn('[j2-native] 模型 ' + model.id + ' 端点瞬断 → 公平切 ' + _alt.id + ' 重跑本轮 (不 fast-fail)');
                try { res.write('event: model_switch\ndata: ' + JSON.stringify({ from: model.id, to: _alt.id, reason: 'infra-fallback' }) + '\n\n'); } catch (_) {}
                const _clean = messages.filter(m => !(m && m.role === 'assistant' && !m.content && !m.tool_calls));
                messages = _clean;
                continue;
              }
            }
            // 配额/网络错误 (本地模型也挂了 or 没本地模型) → 直接说真原因收口
            if (_isInfraError(e.message)) {
              console.warn('[j2-native] INFRA fast-fail, 不再烧轮次');
              try { res.write('event: error\ndata: ' + JSON.stringify({ error: '模型端点不可用' }) + '\n\n'); } catch (_) {}
              finalText = _infraFailText(e.message, model);
              evoSuccess = false; evoError = 'QUOTA_EXCEEDED';
              break;
            }
            // 非基础设施错误 (流被截断 / 解析失败 / …) → 收口。
            // 2026-10-23 (第 64 批): 原来这里写的是「fallback to legacy J2 XML path」
            // + `nativeToolCallSupported = false` —— **那是个假的承诺**:
            // useNative 是 const (本文件 1335 行), 改 nativeToolCallSupported 没人读,
            // legacy 循环的守卫 `!useNative` 恒假 ⇒ 那条路根本不存在。
            // 注释写着「降级」而代码是「静默死掉」—— 注释 ≠ 隔离。
            // 现在老实收口: 说清这一轮怎么结束的, 不假装能换条路。
            console.warn('[j2-native] 非基础设施错误, 收口: ' + e.message.slice(0, 120));
            evoSuccess = false;
            evoError = String(e.message || 'LLM_CALL_FAILED').slice(0, 80);
            if (!finalText) {
              finalText = _timeoutPolicy.timeoutNoticeText({
                kind: '这一轮', seconds: _timeoutPolicy.timeoutSeconds(e.message),
              });
            }
            break;
          }
        }
        // 解析 OpenAI / Anthropic tool_calls
        let toolCalls = [];
        let textContent = '';
        // 2026-08-24 修 (重构事故): _hasReasoningOnly 提到 round 作用域 —
        // 此前 const 声明在 else 块内, 562 行块外引用 → ReferenceError 每轮必炸,
        // 且原声明引用尚未声明的 tcs (TDZ, content 为空时必炸)。两个雷一起拆。
        let _hasReasoningOnly = false;
        if (isAnthropic) {
          textContent = (llmResult.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
          const toolUses = (llmResult.content || []).filter(b => b.type === 'tool_use');
          for (const tu of toolUses) {
            toolCalls.push({
              id: tu.id,
              name: tu.name,
              params: tu.input || {},
              raw: tu
            });
          }
          // stop_reason: tool_use → 跑 tool; end_turn → 总结跳出
        } else {
          // §2026-08-17 fix: Kimi k3 / Qwen 推理模型 — content 为空, 实际响应在 reasoning_content
          // (没这个 fallback → j2 loop 永远 0 字符, 6 轮后 Silent Failure 冤案)
          const _msg0 = llmResult.choices?.[0]?.message || {};
          const tcs = _msg0.tool_calls || [];
          _hasReasoningOnly = !_msg0.content && !!_msg0.reasoning_content && tcs.length === 0;
          textContent = _msg0.content || _msg0.reasoning_content || '';
          for (const tc of tcs) {
            const fn = tc.function || {};
            let params = {};
            try { params = JSON.parse(fn.arguments || '{}'); } catch (_) {}
            toolCalls.push({
              id: tc.id,
              name: fn.name,
              params,
              raw: tc
            });
          }
        }
        // 2026-09-14 (老板 05:24 实案 "更废了"): MiniMax-M3 把工具调用写成正文伪标记
        // ([调用工具: exec_command][<command>..</command>]</invoke>]</tool_call>]), 原生 tool_calls=0
        // → 0 真工具 → nudge → FOUNTAIN 连切 5 次 → 伪标记原样漏上屏。
        // 打捞: 伪调用当真调用执行 + 正文剥离标记 + 警告模型下轮用原生 tool_calls
        if (!isAnthropic && toolCalls.length === 0 && textContent && /调用工具\s*[:：]|<\/?(invoke|tool_call|command)>/.test(textContent)) {
          const _salv = j2Helpers._extractToolCallsFromText(textContent);
          // 打捞不到也要剥 — 未闭合/残缺伪标记不许漏上屏 (05:25 冒烟实案: 裸 <tool_call>{json} 截断漏出)
          textContent = j2Helpers._stripPseudoToolMarkup(textContent);
          if (_salv.length > 0) {
            toolCalls = _salv;
            // 伪调用补成 OpenAI tool_calls 形状 — 下游 1384/1391 assistant push 直接带, minimax 配对不炸
            try { llmResult.choices[0].message.tool_calls = _salv.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.params || {}) } })); } catch (_) {}
            console.warn('[j2-native] PSEUDO_TOOLCALL_SALVAGE: 打捞 ' + _salv.length + ' 个伪工具调用 (' + _salv.map(c => c.name).join(',') + ')');
            // 2026-10-17: 这条告警原来**每轮**都推一遍。模型一旦改不掉这个毛病,
            // 就会在上下文里堆成 N 条一模一样的 system 消息 (现场 r21 的 53 条消息里
            // 有 4 条 SYSTEM WARNING)。同一条规矩说一次就够, 重复只会挤占 prefill。
            if (!_j2PseudoWarned) {
              _j2PseudoWarned = true;
              messages.push({ role: 'system', content: '[SYSTEM WARNING] 你刚才把工具调用写成了正文伪标记 (已被系统打捞执行)。下轮必须用原生 tool_calls 机制发起调用, 禁止在正文里写 [调用工具:..] / <invoke> / <tool_call> 这类文本。' });
            }
          }
        }
        // Only direct answers can enter the user bubble. Text accompanying a
        // tool call is internal reasoning/prologue and remains buffered.
        if (textContent) {
          if (toolCalls.length === 0 && !_isOrchestrationLeak(textContent)) {
            _emitStreamDelta(res, textContent, textContent, Math.ceil(textContent.length / 1.5));
          } else if (toolCalls.length > 0 && streamedText) {
            // 2026-09-13 (老板 16:39 拍 "我要的一直都是流式输出"): 随 tool_call 的正文
            // 不能一刀切当旁白 — 100 字 "好的我先查" 是旁白, 10563 字完整答案 (16:28 实案)
            // 是交付本体, buffer 不流 = 真答案对用户不可见。≥280 字实质正文实时流出;
            // 短旁白维持旧行为 (buffer, 不进气泡)。final 替换与 META_SUMMARY_SWAP 兜底不变。
            const _preToolPlain = String(textContent).replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/<think>[\s\S]*$/g, '').trim();
            if (_preToolPlain.length >= 280 && !_isOrchestrationLeak(_preToolPlain)) {
              console.log('[j2-native] streamed substantive pre-tool text:', _preToolPlain.length, 'chars (旧规则会 buffer 不流)');
              _emitStreamDelta(res, _preToolPlain, _preToolPlain, Math.ceil(_preToolPlain.length / 1.5));
            } else {
              console.log('[j2-native] buffered pre-tool text:', streamedText.length, 'chars');
            }
          } else if (_isOrchestrationLeak(textContent)) {
            console.warn('[j2-native] orchestration text suppressed before final guard');
          }
          finalText = textContent;
          totalChars = textContent.length;
          const _roundPlainNow = String(textContent).replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/<think>[\s\S]*$/g, '').trim();
          if (_roundPlainNow.length > _longestRoundPlain.length) _longestRoundPlain = _roundPlainNow;
        }
        // §0.56 修: state fountain hard-stop (B2 真 enforce)
        // 老代码: _j2DetectFountain 函数定义, 但没调用方 — 等于没拦
        // 现在: 每轮 textContent 后立刻 detect + SSE error + 写 messages
        const _fountainRes = _j2DetectFountain(textContent || '', _state);
        if (_fountainRes.repeat) {
          console.warn(`[j2] §0.31 fountain detected (${_fountainRes.count} repeats), session=${_sessionId}, aborting round`);
          try { res.write('event: error\ndata: ' + JSON.stringify({
            error: _fountainRes.code, code: _fountainRes.code,
            message: _fountainRes.message, session_id: _sessionId,
            repeats: _fountainRes.count,
          }) + '\n\n'); } catch (_) {}
          messages.push({ role: 'assistant', content: textContent || '' });
          messages.push({ role: 'user', content: '[SYSTEM_GUARD] ' + _fountainRes.message + ' (repeat ' + _fountainRes.count + ') — 请用不同方法回答' });
          // 2026-09-14 (老板 14:12 实案 agnes 复读 9 次): 纯文本复读 = 真卡死 —
          // 旧逻辑只 abort round 不 break, 复读 N 轮每轮烧 token, 直接烧穿 500k 预算杀会话。
          // 纯文本复读 (本轮无工具) 直接熔断收口止损; 带工具的复读放行 (工具在真干活, 文本复读不致命)。
          // 2026-10-16 (现场 lt4, 5 步长任务, 同一道题第一次跑就有): "带工具 = 在真干活"
          // 这条假设被实机证伪 —— 模型把**同一个 exec_command 原样再发一遍**, 连续 8 次:
          //   [j2-native] 拦截重复工具调用: 1 个 ( exec_command )
          //   [j2] §0.31 fountain detected (5 repeats) … (6) … (7) … (8 repeats)
          // 防重复守门每次都拦下了 (一次都没真执行), 但 fountain 分支只问
          // "这轮有没有工具", 于是 8 次全部放行 —— 8 个整轮 LLM (本地 27B ~33s/轮 = 4 分钟)
          // 全烧在原地打转上, 而这一刀一个文件都没多写。
          //
          // 判据收紧成: 放行的前提是"这轮有**前面轮次没出现过**的工具调用"。
          // 新的工具调用才叫干活; 原样重发只是打转, 跟纯文本复读没有本质区别。
          const _fpAnyNewTool = (Array.isArray(toolCalls) ? toolCalls : []).some(tc =>
            ((_crossRoundToolCalls
              && _crossRoundToolCalls.get(tc.name + '|' + _stableStringify(tc.params || {}))) || 0) === 0);
          if (toolCalls.length === 0 || !_fpAnyNewTool) {
            try { require('./task_ledger').recordLesson(_sessionId, 'FOUNTAIN', '连续 ' + _fountainRes.count + ' 轮字节级复读被熔断, 换方法或换模型'); } catch (_) {}
            const _why = toolCalls.length === 0
              ? '输出完全相同的内容'
              : '把同一个工具调用 (' + toolCalls.map(t => t.name).filter(Boolean).slice(0, 3).join('、') + ') 原样重发了一遍又一遍';
            finalText = '⚠️ [盘古 FOUNTAIN 熔断] 模型 (' + (model && model.id) + ') 连续 ' + _fountainRes.count + ' 轮' + _why + ', 已卡死复读, 熔断止损 (不再烧算力)。\n建议: 换个说法重发指令, 或切其他模型 (该模型在此任务上反复复读)。';
            totalChars = finalText.length;
            evoSuccess = false;
            break;
          }
        }
        // P0-#1: shouldGeneratePlan() — 触发条件 (spec §3): 工具≥3 或 含 git_commit/file_edit_batch/exec_command/bash 或 改文件≥2
        // 改文件数: param.path 唯一值 ≥ 2
        function _shouldGeneratePlan(toolCalls) {
          if (!Array.isArray(toolCalls) || toolCalls.length === 0) return false;
          const triggers = ['git_commit', 'file_edit_batch', 'exec_command', 'bash'];
          if (toolCalls.some(tc => triggers.includes(tc.name))) return true;
          // R19 修 (老板 7/25 13:36 截图 + v3 原则): ≥3 → ≥2 (老板场景 LLM 调 2 个 tool risk_assessment + critical_point_analysis 不出 plan)
          if (toolCalls.length >= 2) return true;
          // R19 加: 含 analyzer/planner 类 tool 也触发 (法律/策略问题即使 1 个 tool 也要 plan)
          const analyzerTools = ['risk_assessment', 'critical_point_analysis', 'situation_check', 'momentum_assessment', 'trend_judgment'];
          if (toolCalls.some(tc => analyzerTools.includes(tc.name))) return true;
          const paths = new Set();
          for (const tc of toolCalls) {
            const p = (tc.params && (tc.params.path || tc.params.file)) || null;
            if (p) paths.add(p);
          }
          if (paths.size >= 2) return true;
          return false;
        }

        // P0-#1: Plan mode state (session-scoped, _planPending 待老板 approve/reject)
        if (!_state.planState) _state.planState = { pendingPlan: null, lastPlan: null, approved: false, rejected: false, plan_failed: false, startedAt: Date.now() };
        // Gate: 拦"非 plan_approve/reject" 的 tool (这 2 个永远放行, 让 Pangu 能 unlock gate)
        const _nonGateCalls = toolCalls.filter(tc => tc.name !== 'plan_approve' && tc.name !== 'plan_reject');
        // 先处理 plan_approve / plan_reject (line 241+), 设 _state.planState.approved=true
        // 再 check gate: 如果本 round 已 approved, 整轮都放行
        for (const tc of toolCalls) {
          if (tc.name === 'plan_approve' || tc.name === 'plan_reject') {
            const execResult = await wrapToolResultWithHooks(tc.name, tc.params, async (params) => TOOLS[tc.name]({ context: { user: 'feng', sessionId: _sessionId }, params }), { sessionId: _sessionId }); // 2026-09-17 全修#3: write_file 真写自动记 ledger, 治 FAKE 误熔断
            if (tc.name === 'plan_approve' && execResult.ok) {
              _state.planState.approved = true;
              _state.planState.pendingPlan = null;
              console.log('[plan-mode] approved → 解锁 gate');
              _emitStreamDelta(res, '\n\n✅ Plan 已批准, 继续执行其他工具', '', 0);  // 2026-07-26: 统一 stream_delta 通道
              // P0-#3: plan → todo 联动 (approved 后自动 todo_write, 老板能看到 todo 列表)
              try {
                const { _planToTodos } = require('./plan_mode');
                const todos = _planToTodos(_state.planState.lastPlan || {});
                if (todos.length > 0) {
                  const r2 = await wrapToolResultWithHooks('todo_write', { op: 'add', items: todos.map((t, i) => ({ id: 't' + (i + 1), content: t, activeForm: t })) }, async (params) => TOOLS['todo_write']({ context: { user: 'feng', sessionId: _sessionId }, params }));
                  if (r2 && r2.ok) {
                    const todoState = (r2.data && r2.data.todos) || todos.map((t, i) => ({ id: 't' + (i + 1), content: t, status: 'pending' }));
                    try { res.write('event: todo\ndata: ' + JSON.stringify({ type: 'todo', todos: todoState, ts: Date.now() }) + '\n\n'); } catch (e) {}
                    console.log('[todo] plan → todo 联动 ' + todoState.length + ' 项');
                  }
                }
              } catch (e) { console.warn('[todo] plan→todo failed:', e.message.slice(0, 200)); }
            } else if (tc.name === 'plan_reject' && execResult.ok) {
              _state.planState.rejected = true;
              _state.planState.pendingPlan = null;
              const reason = (tc.params && tc.params.reason) || 'no reason';
              console.log('[plan-mode] rejected reason=' + reason.slice(0, 80));
              _emitStreamDelta(res, '\n\n❌ Plan 已拒绝, 理由: ' + reason + '. 请跟我说下一步怎么办.', '', 0);  // 2026-07-26: 统一 stream_delta 通道
            }
          }
        }
        // R21 修 (老板 7/25 14:04 截图 + v3 原则 + §0.51 紧急 fix): 删 Plan Mode gate, 让 LLM 自己跑 tool
// 老板场景实证: Plan 显示后 Pangu 卡死等老板手动 plan_approve, 老板看不到"要点 Approve" 提示, Pangu 死锁
// R20 gate auto-approve 写错 (只在新一轮 tool_call 进入时检查, Pangu 卡死时不产生新 tool_call, gate 永远不触发)
// 解: 彻底删 gate — analyzer/planner tool 是 read-only 分析, 老板想停可以调 plan_reject 或发新指令
//     executor 类危险 tool (exec_command / write_file / git_commit) 仍走 sandbox check (permission_apply), 不需要 gate
if (_state.planState.pendingPlan && !_state.planState.approved && !_state.planState.rejected && _state.planState.plan_failed && _nonGateCalls.length > 0) {
          // 老板原拍 7/25 13:55 + 14:04: 删 gate, 让 Pangu 自己跑
          try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'PLAN_FAILED: 上一 round self_correct 失败, 本轮工具被 gate 拦一次, 已自动放行 (auto-approve).' }) + '\n\n'); } catch (e) {}
          console.log('[j2] plan_failed gate: pending plan ' + _state.planState.pendingPlan.plan_id + ', 跳过 ' + _nonGateCalls.length + ' tool → auto-approve (MiniMax 不会自己调 plan_approve, 死锁实证 2026-08-01)');
          // 只拦一轮: 自动 approve, 下轮工具正常执行; 否则弱模型永远不调 plan_approve → 3 轮白烧 → Silent Failure
          _state.planState.approved = true;
          _state.planState.plan_failed = false;
          _state.planState.pendingPlan = null;
          messages.push({ role: 'system', content: '[GATE_AUTO_APPROVE] 上一轮工具执行失败触发了保护性拦截, 系统已自动放行。下一轮请换用不同工具/参数继续完成任务 (提示: 命令某一段失败会导致整体 exit!=0, 建议拆开执行)。' });
          continue;  // 跳过本轮 tool 执行
        }

        // TL-5 子项 A: Plan Mode 提取 (有 plan steps → emit SSE event: plan, 老板看)
        if (textContent && !toolCalls.length) {
          // 只有没 tool_call 时才查 plan (避免跟 tool_call 流冲突)
          const planSteps = _planMode.extractPlanSteps(textContent);
          if (planSteps.length >= 2) {
            const plan = _planMode.generatePlan('user task', planSteps);
            try { res.write('event: plan\ndata: ' + JSON.stringify(plan) + '\n\n'); } catch (e) {}
          }
        }
        // P0-#1: 新 trigger — tool_calls ≥3 或 含危险 tool → 自动生成 plan
        if (_shouldGeneratePlan(toolCalls) && !_state.planState.pendingPlan) {
          // P0-#1 修 (verify-2026-07-25): steps 改 PlanStep[] 对象数组, 不再 string[]
          // 原因: 前端 PlanViewer.tsx PlanStep 类型要求 {step_id, tool, args, risk},
          //       string[] 进去全字段 undefined → 显示 "(no tool) LOW" × N
          const plan = _planMode.generatePlan('auto plan: ' + toolCalls.map(tc => tc.name).join(','),
            toolCalls.map((tc, i) => ({
              step_id: i + 1,
              tool: tc.name,
              args: tc.params || {},
              risk: _isDangerousTool(tc.name) ? 'high' : 'low'
            })));
          _state.planState.pendingPlan = plan;
          _state.planState.lastPlan = plan;  // P0-#3: 存 lastPlan 给 plan→todo 联动用
          try { res.write('event: plan\ndata: ' + JSON.stringify(plan) + '\n\n'); } catch (e) {}
          // 2026-08-02 修 (老板: 防御越狠出事越大): plan 只作 UI 展示, 不再 continue 跳过本轮工具执行
          // 旧逻辑实证: 每次 ≥3 工具就造 plan + 丢一轮 → 一个会话 4 个废 plan, 工具被反复推迟
          console.log('[plan-mode] generated plan_id=' + plan.plan_id + ' ' + toolCalls.length + ' steps (展示用, 不拦执行)');
        }

        // task_done 优先跳出
        const taskDoneCall = toolCalls.find(tc => tc.name === 'task_done');
        if (taskDoneCall) {
          taskDoneCalled = true;
          taskDoneStatus = (taskDoneCall.params && taskDoneCall.params.status) || 'completed';
          let execResult;
          try {
            execResult = await wrapToolResultWithHooks('task_done', taskDoneCall.params || {}, async (params) => TOOLS['task_done']({ context: { user: 'feng', sessionId: _sessionId }, params }), { sessionId: _sessionId }); // 2026-09-17 全修#3
          } catch (e) { execResult = { ok: false, error: e.message }; }
          try { res.write('event: tool_result\ndata: ' + JSON.stringify({ name: 'task_done', ok: !!(execResult && execResult.ok), result: execResult, id: taskDoneCall.id }) + '\n\n'); } catch (e) {}
          toolsUsed.push('task_done');
          const summary = (taskDoneCall.params && taskDoneCall.params.summary) || '';
          // 2026-09-11: lip-service gate — 全程 0 真工具 + summary 是计划/承诺措辞 → 拒收, 逼模型真调工具
          const _realToolsThisTask = toolsUsed.filter(n => n !== 'task_done');
          const _summaryLipService = _realToolsThisTask.length === 0 && LIP_SERVICE_SUMMARY_RE.test(summary);
          // 2026-09-11 OVERCLAIM_SENTINEL: 真工具干过活但 summary 是全集断言且无部分措辞 → 拒收, 逼改成实数
          // (只写了 1 篇总结却说 "排查+消化已完成" — 对齐门抓不了 "已完成" 有真文件背书, 需词法哨兵拦夸大)
          const _summaryOverclaim = _realToolsThisTask.length > 0 && OVERCLAIM_RE.test(summary) && !/(未完成|未做|未消化|缺|剩余|尚未|未开始)/.test(summary);
          // 2026-09-12 铁律23 (易经营案): 大体量任务按子块交验 — summary 报「本轮完成 X + 剩余清单」
          // 是合法交付 (部分措辞命中), 不再触发 OVERCLAIM 拒收逼说全集; 真全集断言仍拦。
          // 2026-09-16 老板拍 "开源别人说话不都一样": 不靠词法判 partial (任何话术都可能不命中) —
          // 模型自判: 让模型对照剩余计划 + 本次产出, 用固定 JSON {completed, remaining} 判定, 结果写 ledger 供下轮断点;
          // 词法仅作 fallback (模型判定不可用时), 且只覆盖通用进度词 (剩余/TODO/pending/未完成), 不绑特定话术。
          // (判定逻辑见 _judgeSummaryCompletion: 模型自判 + 词法 fallback, 判定结果写 task_ledger 供下轮断点)




          const _progressJudged = await _judgeSummaryCompletion({
            // 判官: 模型只列六格条目, 结论由 64i 的 task_judge.judgeProgress 内核算;
            // 判官不可用/判不出时自动回退词法判定 (见 _judgeSummaryCompletion)
            summary, model, _deps,
            planSteps: (_state.planState.pendingPlan || (function(){ try { return require("./plan_state").loadPlan(_sessionId) || {}; } catch (_) { return {}; } })()).steps || [],
            _sessionId,
            soulScope: _soulScope,
          });
          // 2026-10-23 (第 59 批): 判官现在给**结构化结论**(六格 cells + 档位 + 判据),
          // 不再只是一个布尔。布尔那一份由它派生, 下游 4 处用法一个字没改。
          const _summaryPartial = !!_progressJudged.isPartial;
          // 2026-09-12 e2e 实战修: 意图型进度汇报也是 partial — "第 1 份已落盘,继续追加第 2 份"
          // 这种 summary 不含"未完成/剩余"字样, 绕过 partial 判定被当全集验收 → success 收场但活只干一半
          // (e2e 实案 resume7)。凡是"还要继续"的措辞, 一律按 partial 处理走自动续跑。
          // 2026-09-16 老板再拍 "开源其他人说话也不和我一样": _isPartialSummary 直接取 _judgeSummaryCompletion 结果 (模型自判优先, 词法 fallback), 不叠词法 continue-intent。
          const _isPartialSummary = _summaryPartial;
          // 2026-10-23 (第 59 批): 把六格判局的结论**送到模型眼前**。
          //
          // 为什么: 老板 10-21 原话「加强停顿, 走一步判断一步」——
          //   光有判据不够, 模型得**看见**上一步判成什么样, 才知道下一步该干什么。
          //   而此前六格判局在长任务上从不发生 (实测 7940 个会话账本里 3 个提到
          //   wuxing_judge, 运行日志 0 次) ⇒ 「走一步判断一步」是空的。
          //   现在它挂在 task_done 上, 每次交卷都判一次。
          //
          // 零影响: 只在**判出了结论**且**还有活**时注入一条;
          //   判不出 / 已收口 ⇒ 一条都不加 (跟 stop_point 同一纪律: 停点是加法不是减法)。
          // 注入全交给 summary_completion.injectProgressJudge (第 59 批)。
          // 为什么连「送不送」都不在这里判断: 调用点自己写那句 if 的话,
          //   没有测试能验它 —— 变异体检实测: 注入内容抽成纯函数之后,
          //   调用点那句 if 仍是空枪。所以内容、措辞、三道门全归真源。
          _summaryCompletion.injectProgressJudge(messages, _progressJudged, _summaryPartial);

          // 2026-09-12 七次: partial 一等公民 — 有真写文件证据 + 锚定 tool_result 真数字 = 合法交付。
          // 证据主判优先: _artifactAligned(summary) 为真时, 不管措辞是否 partial 都 accepted (做对的事不再被词法误杀)。
          const _summaryArtifactOk = _hasWriteProof() && _hasArtifactEvidence(summary, _evidenceText());
          // 2026-09-12 铁律23: 部分进度 + 剩余清单 = 合法交付; 全集断言仍拦 (无证据时)
          const _summaryOk = !_summaryLipService && _summaryArtifactOk || (! _summaryLipService && !_summaryOverclaim || (_taskDonePartialOk && _summaryPartial && _summaryArtifactOk));
          _taskDoneStatusText = summary; // 2026-09-12: 保留 summary 供 partial 交付收口
          // 2026-09-13 task_done 守门 (对照核查 L1 实证): plan 状态机还有 pending/doing
          // 步骤时 status=completed 拒收 — 堵"跑 1-2 步就交卷, 老板人肉提醒"。只拦 completed
          // (partial/failed 放行); 无 plan (MiniMax 惯犯不建 plan) 不拦, 由体量预检/partial 续跑兜底。
          let _taskDonePlanBlocked = [];
          try {
            if (taskDoneStatus === 'completed') {
              const _planData = require('./plan_state').loadPlan(_sessionId);
              _taskDonePlanBlocked = ((_planData && _planData.steps) || []).filter(s => s && (s.status === 'pending' || s.status === 'doing'));
            }
          } catch (_) {}
          // 2026-09-13 P1a (老板: 对账制, 不是打补丁): task_done 声称的写盘必须账上有据。
          // summary 含"落盘/写入/保存/生成/交付"类声称 + 具体文件路径, 但账本 files_written 查无此路径
          // → 拒收。堵"嘴上说写了, 实际没写"的假交付 (账 = tool_result ground truth, 骗不了)。
          // 2026-10-16 (现场 session=live-030634, 2 份产物): 这道门当时是**另写的一份**对账 ——
          //   loadLedger(_sessionId) 只查自己那本账。可 dispatch 路径的父会话根本不经过本 loop,
          //   没有自己的账本文件, 写盘全在 <parent>_sub-N-role 各一本里 (见 task_ledger 10-13 注释)。
          //   结果主 agent 汇报**子 agent 真写好的**产出 (m.txt/n.txt 账上在、磁盘上也在) 被判"无据",
          //   白烧一个补救轮次, 逼主 agent 把子任务的交付从汇报里删掉 —— 汇报被系统性抹掉,
          //   正是 10-13 修过的坑从这条没合并的旁路漏出来第二次。
          //   修法跟 10-13 同一个原则: 单一真源, 走 checkDeliveryClaims (父 ∪ 子 账本 + mtime 兜底),
          //   不再在这里自己比对一遍。拒收/回灌/记 lesson 的行为一字不改。
          let _taskDoneLedgerMiss = [];
          try {
            if (taskDoneStatus === 'completed' && summary) {
              const _dc = require('./task_ledger').checkDeliveryClaims(_sessionId, summary, { toolsThisRun: _realToolsThisTask.length });
              if (_dc && _dc.missed && _dc.missed.length) _taskDoneLedgerMiss = _dc.missed;
            }
          } catch (_) {}
          if (summary && _summaryOk && _taskDonePlanBlocked.length === 0 && _taskDoneLedgerMiss.length === 0) {
            const alignedSummary = guardFinalText(summary, false);
            if (alignedSummary) {
              taskDoneAccepted = true;
              // 2026-09-13 (老板 16:28 实案 "流式输出没了"): 模型把完整答案 (10563 字) 写进
              // 本轮正文, task_done summary 只留一句元引用 "详细答案已在流式输出中完整给出"。
              // 但正文随 tool_call 被当旁白 buffer (不流式), final 又整体替换气泡 —
              // 主人最终只看到那句元引用, 真答案两头都丢。summary 是元引用 + 本轮正文更实在
              // → 用正文 (剥 think) 作最终交付, 元引用摘要丢弃。
              const _META_REF_RE = /(流式输出|正文|上文|上述|如上|见上|前文|上面|已.{0,8}(给出|呈现|展示|输出|交付|写完|写好)|完整给出)/;
              const _deliver = (_META_REF_RE.test(alignedSummary) && _longestRoundPlain.length > alignedSummary.length) ? _longestRoundPlain : alignedSummary;
              if (_deliver !== alignedSummary) console.warn('[j2-native] META_SUMMARY_SWAP: summary 是正文元引用 (' + alignedSummary.length + ' chars), 改用全请求最长正文交付 (' + _longestRoundPlain.length + ' chars)');
              finalText = _deliver; totalChars = _deliver.length;
              // 2026-09-12 e2e 实战修: 部分放行 (剩余清单) 时先不发 final —
              // emitFinalOnce 全请求只发一次, 若自动续跑成功, final 必须留给真收尾,
              // 否则用户永远看不到最终交付 (只看到第 1 轮的 partial)。
              const _isPartialDelivery = _taskDonePartialOk && _isPartialSummary;
              if (!(_isPartialDelivery && _autoResumeMax > 0)) emitFinalOnce(_deliver);
            }
          }
          // 把 task_done 也回灌到 messages (按 OpenAI format)
          if (!isAnthropic) {
            const assistantMsg = llmResult.choices?.[0]?.message;
            messages.push({ role: 'assistant', content: assistantMsg.content || '', tool_calls: assistantMsg.tool_calls });
            messages.push({ role: 'tool', tool_call_id: taskDoneCall.id, content: JSON.stringify(execResult) });
          } else {
            // Anthropic format: content blocks
            const newUserContent = `工具 task_done 已执行. 结果: ${JSON.stringify(execResult).slice(0, 800)}`;
            messages.push({ role: 'user', content: newUserContent });
          }
          if (_summaryLipService && _lipServiceNudges < 4 && round < maxRounds - 1) {
            _lipServiceNudges++;
            console.warn('[j2-native] LIP_SERVICE_TASK_DONE: task_done 但 0 真工具 + 计划型 summary, 拒收 nudge #' + _lipServiceNudges);
            try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'LIP_SERVICE: 你只喊了计划/要开工但一个真工具都没调, task_done 被拒. 立即调用工具真执行.' }) + '\n\n'); } catch (e) {}
            messages.push({ role: 'system', content: '[LIP_SERVICE_BLOCKED] 你的 task_done summary 只是计划/承诺 (收到/开盘/开做/先...再.../定个顺序), 但你全程 0 次真工具调用。这是光说不做。立即调用工具 (read_file/list_directory/exec_command) 真的动手, 拿到真实结果后再 task_done。不要再复述计划或写待办。' });
            continue;
          }
          if (_summaryOverclaim && !_taskDonePartialOk && !_summaryArtifactOk && _alignNudges < 1 && round < maxRounds - 1) {
            _alignNudges++;
            console.warn('[j2-native] OVERCLAIM_TASK_DONE: summary 全集断言, 拒收逼改实数 #' + _alignNudges);
            try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'OVERCLAIM: summary 全集断言 (已完成/全部) 但证据未覆盖全集, 逼改实数.' }) + '\n\n'); } catch (e) {}
            messages.push({ role: 'system', content: '[OVERCLAIM_BLOCKED] 你的 task_done summary 是全集断言 ("已完成/全部..."), 但你的证据没有覆盖全集 — 这是夸大。改写: 只报核实过的项 + 实数 (例: "7 主题: 01/02/04 有总结, 03/05/06/07 未做"), 未做项明确写 "未做"。再 task_done。' });
            continue;
          }
          if (_taskDonePlanBlocked.length > 0 && round < maxRounds - 1) {
            console.warn('[j2-native] TASK_DONE_GATE: plan 还有 ' + _taskDonePlanBlocked.length + ' 步未完成, 拒收 task_done');
            // Rejected task_done is a proposal, not a completed task. Clear
            // its bookkeeping before continuing so the next scripted/model
            // round can execute the remaining plan steps instead of replaying
            // the rejected completion state.
            taskDoneCalled = false;
            taskDoneStatus = null;
            taskDoneAccepted = false;
            if (toolsUsed[toolsUsed.length - 1] === 'task_done') toolsUsed.pop();
            try { require('./task_ledger').recordLesson(_sessionId, 'PLAN_INCOMPLETE', 'task_done 被拒: plan 还有 ' + _taskDonePlanBlocked.length + ' 步未完成 (' + _taskDonePlanBlocked.map(s => s.id).join(',') + ') — 全部做完再交验'); } catch (_) {}
            try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'task_done 被拒: plan 还有 ' + _taskDonePlanBlocked.length + ' 步未完成, 继续执行剩余步骤.' }) + '\n\n'); } catch (e) {}
            messages.push({ role: 'system', content: '[TASK_DONE_BLOCKED] 你的 plan 还有未完成步骤: ' + _taskDonePlanBlocked.map(s => (s.id || '?') + '.' + (s.title || '')).join('; ') + '。继续执行剩余步骤, 每完成一步调 plan_step_done 附证据, 全部完成后再 task_done; 若 plan 已过时先 plan_step_done/plan_create 更新。' });
            continue;
          }
          if (_taskDoneLedgerMiss.length > 0 && round < maxRounds - 1) {
            // 同上 10-16: 父/子任一方都可能是真产出持有者, 日志也得看合并账, 不然打出来是"(无)"
            const _lw = (require('./task_ledger').collectWrittenFiles(_sessionId) || []).map(w => (w && w.path) || String(w));
            console.warn('[j2-native] TASK_DONE_LEDGER_REJECT: summary 声称写盘但账上无据: ' + _taskDoneLedgerMiss.join(', '));
            try { require('./task_ledger').recordLesson(_sessionId, 'LEDGER_MISS', 'task_done 被拒: 声称写盘 ' + _taskDoneLedgerMiss.join(', ') + ' 但账上无记录 — 声称的产出必须真写 (write_file 或 exec 重定向均可记账)'); } catch (_) {}
            try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'task_done 被拒: 你声称写盘的文件账上无据 (' + _taskDoneLedgerMiss.length + ' 份), 先真写再交验.' }) + '\n\n'); } catch (e) {}
            messages.push({ role: 'system', content: '[LEDGER_REJECT] 账本对账失败 — 你 summary 声称本轮写入/生成了这些文件, 但账上没有对应写盘记录: ' + _taskDoneLedgerMiss.join('; ') + '。这些文件可能本来就存在或只是被读取, 不能把源文件/已有文件说成本轮新产出。优先改写 summary: 只报账上确认的本轮产出, 其余明确写"已存在/已读取, 本轮未写"。只有用户明确要求创建新文件时才调用 write_file 或 exec_command 重定向。' });
            continue;
          }

          if (!taskDoneAccepted && round < maxRounds - 1) {
           // 2026-09-16 老板拍 "FINAL_REWRITE_REQUIRED 强制禁止再调工具 无法实际推进":
           // 旧 bug — task_done 被拒后一律 FINAL_REWRITE (禁工具), 模型只能嘴上汇报, 任务真活 (读剩余卷/写 digest) 卡死。
           // 现在: 如果 summary 已带剩余清单 (partial) 或真写盘证据 (artifact), 直接交 partial final 收口, 把剩余交给下轮断点续跑 — 不再 FINAL_REWRITE 卡死。
           // 只有 summary 既不是 partial 也没证据 (纯全集断言/假交卷) 才走 FINAL_REWRITE 逼改实数。
          const _canPartialDeliver = (_isPartialSummary || _summaryArtifactOk) && _realToolsThisTask.length > 0;

            if (_canPartialDeliver) {
              console.warn('[j2-native] PARTIAL_DELIVER_FINAL: summary 带剩余清单/写盘证据, 直接交 partial final, 不 FINAL_REWRITE 卡死');
              taskDoneAccepted = true;
              finalText = summary || '';
              totalChars = finalText.length;
              // 触发自动续跑 — 剩余清单下轮接着干, 不等 FINAL_REWRITE 死循环
              try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'task_done 部分交付收口: 剩余清单已报, 下轮断点续跑 (不再 FINAL_REWRITE).' }) + '\n\n'); } catch (_) {}
              break;
            }
            const _partialHint = (typeof _realToolsThisTask !== 'undefined' && _realToolsThisTask.length > 0)
              ? '活还没干完 (真工具已跑 ' + _realToolsThisTask.length + ' 次, 还有剩余步骤/缺失产出): 先继续调工具把剩余步骤做完、缺失产出补齐, 全部完成后重新 task_done; 只有确认活已全部干完、纯粹是 summary 措辞夸大/没对齐时, 才不用调工具直接重写总结。'
              : '不要再调工具，不要写卦象、计划、待确认或过程旁白；只根据已返回的工具结果，用 2-5 句直接回答原问题，然后再次 task_done。';
            messages.push({ role: 'system', content: '[FINAL_REWRITE_REQUIRED] 你刚才的 task_done 总结未通过对齐守门。' + _partialHint });
            // 2026-09-16 老板拍 "强制禁止再调工具" 无法实际推进: 活没干完 (真工具跑过但还有剩余步骤) 就交卷,
            // 不该被逼着只用嘴重写总结 — 允许继续调工具把活干完; 只有活已全干完、纯措辞夸大部分才禁工具重写。
            continue;
          }
          // 2026-09-12 e2e 实战修: 部分放行 (taskDoneAccepted + 剩余清单) ≠ 完成 —
          // 体量预检设计的"剩余下轮补"由自动续跑接管, 不等人肉"继续"。
          // 续跑成功 → 清验收态继续跑; 续跑上限/无 pending → 补发 partial final 后正常收口。
          // 2026-09-12 (老板 22:24 实案 "仍要我中间激活"): 摘掉 _taskDonePartialOk 前置 —
          // 它只在体量预检命中时置位, 确认词续轮 ("继续") 拼出的任务文本不含消化关键词就漏检,
          // 模型 summary 明说"待主人拍"也原地停。summary 有剩余/待办标记 + checkpoint active
          // (续跑函数自验) 就该续; 真完成的 summary 不带这些标记, 误续也会被 checkpoint=done 挡回。
          if (taskDoneAccepted && _isPartialSummary) {
            const _resumed = await _tryAutoResume('partial_task_done');
            if (_resumed) { round = -1; taskDoneAccepted = false; finalText = ''; continue; }
            if (finalText) emitFinalOnce(finalText);
          }
          // 2026-09-12 e2e 实战修: 最后一轮 task_done 被拒不能直接 break —
          // 此分支的 break 会跳过轮末续跑块 (e2e 实案: round 2 交意图型 summary 被拒 → break →
          // status failed, 续跑块永远够不到)。被拒说明活儿没干完, 正是该续跑的场景。
          if (!taskDoneAccepted && round === maxRounds - 1) {
            const _resumed = await _tryAutoResume('task_done_rejected_last_round');
            if (_resumed) { round = -1; continue; }
          }
          break;
        }

        if (toolCalls.length === 0) {
          // 2026-09-13 (老板 12:51 实案 "工具调用出问题"): MiniMax 连续空内容轮 — API 200 但
          // content 空 + 0 tool_calls, 旧路径静默走底部 nudge (无任何日志), 4 轮空转后第 5 轮
          // 叙事文本被对齐门拦 → 老板只见 ⚠️+✗, 死后连模型说了什么都查不到。
          // 空轮必须可见: 记日志 + SSE 警告; 连续 2 轮空 = 模型卡顿, 诚实熔断不再烧轮次。
          if (!textContent || !textContent.trim()) {
            _emptyContentRounds++;
            console.warn('[j2-native] EMPTY_CONTENT_ROUND: 模型返回空内容 0 tool_calls, round=' + round + ', 连续空轮 #' + _emptyContentRounds);
            try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '模型第 ' + _emptyContentRounds + ' 次返回空内容 (卡顿), ' + (_emptyContentRounds >= 2 ? '已熔断' : '重试中') + '.' }) + '\n\n'); } catch (e) {}
            if (_emptyContentRounds >= 2) {
              try { require('./task_ledger').recordLesson(_sessionId, 'EMPTY_CONTENT_ROUND', '模型连续 ' + _emptyContentRounds + ' 轮返回空内容 (卡顿), 已熔断; 重发同指令即可, 断点还在'); } catch (_) {}
              finalText = '⚠️ [盘古 EMPTY-ROUND 熔断] 模型连续 ' + _emptyContentRounds + ' 轮返回空内容 (0 正文 0 工具调用) — 这是模型卡顿/异常, 不是任务本身失败。\n建议: 直接重发同一指令 (断点还在), 或换模型。';
              totalChars = finalText.length;
              evoSuccess = false;
              break;
            }
            // 不 push 空 assistant 消息 — MiniMax 会 400 'chat content is empty'
            messages.push({ role: 'user', content: '[SYSTEM] 你上一轮返回了空内容 (0 正文 0 工具调用) — 这是异常。直接完成任务: 调工具执行, 或用文字给出完整答案。禁止空响应。' });
            continue;
          }
          _emptyContentRounds = 0; // 非空轮重置连空计数
          // W1.1 双轨: SM 前置 + 决策对比 (native 路径) — SM 接管 nudge/break;pass 则放行旧 inline
          // W1.4 FOUNTAIN + W1.6 REASONING 借助 _fountainRes (line 584) / _hasReasoningOnly 触发
          const _smN = _isTaskExecutionRequest
            ? _planGate.check({ textContent, toolsUsed, round, maxRounds, emit: res.write.bind(res), fountainRes: _fountainRes, hasReasoningOnly: _hasReasoningOnly })
            : { action: 'pass' };
          const _legacyN = _looksLikeEmptyPlan(textContent) && toolsUsed.filter(n => n !== 'task_done').length === 0 && _emptyPlanNudges < EMPTY_PLAN_MAX_NUDGES && round < maxRounds - 1;
          if ((_smN.action === 'nudge') !== _legacyN) console.warn('[j2-native] W1.1 SM对比: sm=' + (_smN.action === 'nudge' ? 'nudge' : 'pass') + ' legacy=' + (_legacyN ? 'nudge' : 'pass'));
          if (_smN.action === 'break') {
            console.warn('[j2-native] W1.x SM接管 break #' + _smN.rule);
            // FOUNTAIN 场景: 已有 line 584 算过 _fountainRes, 这里只发 final + 收口
            try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: _smN.message }) + '\n\n'); } catch (_) {}
            finalText = '[SYSTEM_GUARD] ' + _smN.message;
            totalChars = finalText.length;
            evoSuccess = false;
            break;
          }
          if (_smN.action === 'nudge') {
            console.warn('[j2-native] W1.x SM接管 nudge #' + _smN.rule + ' #' + _smN.count);
            _emptyPlanNudges++;
            messages.push({ role: 'assistant', content: textContent || '' });
            messages.push({ role: 'system', content: _smN.message });
            continue;
          }
// R80 修 (BUG #1): native 路径空计划模板熔断 — 计划文本 + 0 工具 = 不收, nudge 逼执行
          if (_isTaskExecutionRequest && _looksLikeEmptyPlan(textContent) && toolsUsed.filter(n => n !== 'task_done').length === 0 && _emptyPlanNudges < EMPTY_PLAN_MAX_NUDGES && round < maxRounds - 1) {
            _emptyPlanNudges++;
            console.warn('[j2-native] R80 EMPTY_PLAN_GUARD: plan-only output, 0 tool calls, nudge', _emptyPlanNudges);
            try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'R80: 检测到空计划模板 (0 工具调用), 已要求直接执行.' }) + '\n\n'); } catch (e) {}
            messages.push({ role: 'assistant', content: textContent || '' });
            messages.push({ role: 'system', content: '[SYSTEM WARNING] 你刚才只输出了计划模板 (第N步...), 一个工具都没调。主人已经拍板让你动手 — 禁止再列步骤, 下一轮必须直接 tool_call 真执行 (read_file / exec_command / write_file 等)。再输出空计划 = 任务失败。' });
            continue;
          }
// #12 #13 状态喷泉熔断: native 路径也加检测
          if (textContent && textContent.trim().length > 0) {
            // 2026-08-02 修: native 路径 think-only 轮 — MiniMax-M3 把 <think> 内联进 content,
            // 思考烧完预算就停 → 旧逻辑把纯思考收为 finalText, think-strip 后 0 字 → Silent Failure 冤案
            const _nativeAnswerOnly = textContent.replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/<think>[\s\S]*$/g, '').trim();
            if (!_nativeAnswerOnly && textContent.includes('<think>') && round < maxRounds - 1) {
              console.warn('[j2-native] THINK_ONLY_ROUND: 整轮只有 <think>, 0 正文 0 工具, nudge');
              try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '模型这轮只思考没输出正文, 已要求压缩思考直接给答案.' }) + '\n\n'); } catch (e) {}
              _pushReplay('THINK_ONLY', textContent, 500);
              messages.push({ role: 'system', content: '[SYSTEM WARNING] 你上一轮的输出只有 <think> 思考, 正文一个字都没有 (思考太长烧完了输出预算)。下一轮: 思考压到 3 行以内, 直接输出正文答案或调用工具。' });
              continue;
            }
            // §2026-08-17 fix: Kimi k3-256k 等推理模型 — content+tool_calls 都空, reasoning_content 是思考
            // (没 <think> 标签, 走 reasoning_content 字段, 现有 THINK_ONLY_ROUND 抓不到)
            // 推理模型思考多轮是正常的, 但不应无限轮 — 上限 3 次 nudge 后强制收口
            if (_hasReasoningOnly && round < maxRounds - 1 && _reasoningOnlyNudges < 3) {
              _reasoningOnlyNudges++;
              console.warn('[j2-native] REASONING_ONLY_ROUND: 推理模型只思考没动作, nudge #' + _reasoningOnlyNudges);
              try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '推理模型这轮只思考没动作, 已要求: 要么直接给答案, 要么调工具. 思考压到 3 行以内.' }) + '\n\n'); } catch (e) {}
              _pushReplay('REASONING_ONLY', textContent, 500, '[reasoning only] ');
              messages.push({ role: 'system', content: '[SYSTEM WARNING] 你上一轮只有 reasoning 思考, content 字段是空的, 也没调任何工具 — 这对 Kimi k3 / DeepSeek R1 等推理模型是思考阶段。下一轮必须二选一: (1) 直接给出完整正文答案 (content 字段非空); (2) 调用工具 (tool_calls 非空)。思考压到 3 行以内, 禁止只思考不行动。' });
              continue;
            }
            // 第 88 批 (2026-10-25): nudge 用尽 (或已经是最后一轮) 仍然是「只回思考」
            //   ⇒ **模型的思考不是答案**, 不许原样当最终答复交给主人。
            //
            //   为什么这必须显式处理: 上面那个 nudge 只是「再问一次」,
            //   它不保证模型这回会给正文 —— 上游端点/模型摆烂时, 3 次 nudge 全是思考。
            //   而 2680 行那行 `textContent = _msg0.content || _msg0.reasoning_content || ''`
            //   把思考放进了 textContent ⇒ 再往下走, 思考就会在 3433/3458/3471
            //   变成 finalText ⇒ **主人收到模型的内心戏**, 而盘古显示 completed。
            //
            //   这跟第 86 批在综合层修的是同一个病 (综合层那半边已经修完:
            //   「只回思考 ⇒ 重试一次 ⇒ 再兜底」)。这一半是**子 agent / 直答轮**这半边。
            //
            //   ⚠ 诚实优先于「给点什么」: 2026-07-28 那条 compat (只回 reasoning_content 的模型
            //   交思考强于交空) 是为了**不让流直接全废**, 不是为了把思考当答案交上去。
            //   这里保留 compat (思考仍进 messages 历史, 模型下一轮看得见自己想过什么),
            //   但**不许它成为交付物**。
            if (_hasReasoningOnly) {
              console.warn('[j2-native] REASONING_ONLY_EXHAUSTED: nudge ' + _reasoningOnlyNudges
                + ' 次仍是只回思考 → 交诚实说明, 不把思考当答案 (思考仍留在历史里)');
              try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '模型连续只回思考没给正文, 已如实停下 (不拿模型的思考冒充答案).' }) + '\n\n'); } catch (e) {}
              finalText = '⚠️ [只回思考] 模型连续 ' + _reasoningOnlyNudges + ' 次只回思考、没有给出正文答案, 也没有调用任何工具。'
                + '我如实停下 —— 不拿模型的思考冒充答案交给你。\n'
                + '建议: 换个模型 / 检查端点 (这类故障多半是上游只回 reasoning_content 通道)。';
              totalChars = finalText.length;
              evoSuccess = false;
              break;
            }
            // 2026-08-02 修 (老板截图: 同一问题问 3 次, 3 次只收到 "让我把核心文件全读完/让我系统性地分析" 承诺气泡)
            // native 路径 round>=1 无条件把本轮文本当 finalText → 0 工具承诺轮直接收口, 老板永远等不到真答案
            // 修: 0 工具 + 短承诺旁白永不进 finalText — nudge 逼调工具, 上限 2 次防死循环
            const _PROMISE_RE = /让我|我来|我先|我会|接下来|继续深入|继续读|继续看|继续调|系统性|全部读|读完|全读|搜一下|先调(?:工具|子)?|立即补上|这就去|马上调|下面调|现在调|动手调|先查|先并发|先拉|摸清|探针|再补/;
            if (toolsUsed.length === 0 && textContent && textContent.trim().length < 120 && _PROMISE_RE.test(textContent) && _promiseNudges < 2 && round < maxRounds - 1) {
              _promiseNudges++;
              console.warn('[j2-native] PROMISE_ZERO_TOOLS: 0 工具 + 承诺旁白, nudge #' + _promiseNudges);
              try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '模型光说不做 (0 工具调用), 已要求立即调工具拿真数据.' }) + '\n\n'); } catch (e) {}
              _pushReplay('PROMISE', textContent, 300);
              messages.push({ role: 'system', content: '[SYSTEM WARNING] 你上一轮只说 "让我/我来/继续..." 但一个工具都没调 — 这是光说不做。禁止再输出承诺/计划/旁白, 下一轮必须直接调用工具 (read_file / list_directory / exec_command) 拿真数据, 或者直接给出完整答案。' });
              continue;
            }
            // 2026-10-23 (第 73 批, 实跑 b63-guagate): 调过工具却只输出旁白 → 旁白被当最终答复。
            // 现场原文 (main 角色, 真实用户轮):
            //   「主人给了生辰, 这是「长期状态 + 此刻时机」两层题。我先把八字盘排出来, 再给今天这个动作起一卦定方向。」
            //   模型调完 bazi_calc + risk_assessment 后说这一句 → 下一轮**原样再说一遍**, 0 工具调用
            //   → 下面那道复读检测直接 break, finalText = 这句旁白 → 答复门拦下 → 用户拿 ⚠️ 模板。
            //
            // 为什么既有闸门全漏 (结构层, 不是词表问题):
            //   ① 0 工具的 lip-service 守门要求 toolsUsed.length === 0 —— "调过工具再嘴说"根本没人管
            //   ② R80 LIP_SERVICE_AFTER_TOOLS 那段写在 finalText=textContent; break; **之后**
            //      ⇒ 结构性够不到 (实测从没响过: 要够到它必须 round===0 且正文 <120 字,
            //        而 round 0 的 toolsUsed 必为空 —— 两个条件互斥)
            //      ⇒ 而且它调的 _stripSpecialTokensForFinal 全库**没有定义**(见上面那个函数的注释),
            //        真跑起来会 ReferenceError 打断整轮 —— 所以这里是**重写**, 不是把旧的挪上来。
            //   ③ 复读检测 (下面那道) 只会 **break 并把旁白当 finalText** —— 它拦住了"复读",
            //      但没拦住"旁白当答案", 于是答案还是那句旁白, 还是被答复门拦。
            //
            // 这里补的是**动作**: 复读/承诺 ≠ 直接收口, 而是回灌要求给结论。
            //   判据是结构信号 (复读 / 承诺句式), 收口分两步:
            //   ① 先给它机会自己把结论说出来 (上限 2 次) —— 主人要的是决断, 不是"本轮干了啥"的报告
            //   ② 还是嘴说 → 基于已返回的工具结果出实做报告 (诚实收口, 至少不给 ⚠️ 模板)
            const _narKind = (toolsUsed.length > 0 && textContent && textContent.trim())
              ? _isNarrationAfterTools(textContent, messages) : null;
            if (_narKind) {
              if (_lipAfterToolsNudges < 2 && round < maxRounds - 1) {
                _lipAfterToolsNudges++;
                console.warn('[j2-native] LIP_SERVICE_AFTER_TOOLS: 调了 ' + toolsUsed.length
                  + ' 个工具但只输出旁白 (' + _narKind + '), 回灌逼给结论 #' + _lipAfterToolsNudges);
                try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '调了工具但只输出旁白, 已要求基于工具结果直接给结论.' }) + '\n\n'); } catch (e) {}
                _pushReplay('LIP_SERVICE_AFTER_TOOLS', textContent, 300);
                messages.push({ role: 'system', content: '[LIP_SERVICE_AFTER_TOOLS] 你已经调过工具 (' + toolsUsed.length + ' 次), 但这一轮输出的还是"打算怎么做"的旁白, 不是结论。现在直接给结论: 用**已经拿到的工具结果**说清楚「结论是什么 + 依据是哪一条工具结果 + 该做什么 / 不该做什么」。不要再复述计划, 不要再出现"我先…再…"这种句子。' });
                continue;
              }
              // ② nudge 用尽还是旁白 → 基于工具结果出实做报告 (别给 ⚠️ 模板)
              console.warn('[j2-native] LIP_SERVICE_AFTER_TOOLS: nudge 用尽, 走实做报告收口');
              if (_alignNudges < 1) {
                _alignNudges++;
                messages.push({ role: 'system', content: '[LIP_SERVICE_SUMMARY] 你刚调了工具但只输出嘴说旁白。基于已返回的工具结果, 用 3-6 句报「本轮实际做了什么 (读/写了哪些文件, 多少行/字节) + 剩余什么没做」, 不新调工具, 不夸大全集。这段即最终收口。' });
                const _sum = await _forceToolSummaryReport({
                  messages, model, res, opts,
                  roleScope: _roleForThisLoop === 'main' ? 'main' : 'worker',
                  isAnthropic,
                });
                if (_sum) {
                  finalText = _sum; totalChars = finalText.length; break;
                }
              }
              const _n = toolsUsed.filter(x => x !== 'task_done').length;
              finalText = '本轮已真调 ' + _n + ' 个工具 (工具卡片可查), 但模型只输出了旁白, 没有给出可核验的结论。下一轮基于已有进度继续。';
              totalChars = finalText.length; evoSuccess = true;
              break;
            }
            // 检测是否和上一轮重复 (semantic similarity 简化版: 长度 + 前 100 字符)
            const prevText = messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
            const isRepeat = prevText.length > 0 && textContent.length > 0 &&
              prevText.slice(0, 100) === textContent.slice(0, 100);
            if (isRepeat && round >= 1) {
              console.warn('[j2-native] STATUS_FOUNTAIN_GUARD: repeat detected, breaking');
              try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '检测到重复输出, 已熔断. 请简化任务或换模型.' }) + '\n\n'); } catch (e) {}
              _recordModelFailure(model && model.id);  // 2026-08-23 R16 修: 实时 push 进程内黑名单
              finalText = textContent;
              break;
            }
            // 2026-07-26 修 (老板 15:53 截图: MiniMax 6 分钟绕圈, 气泡只剩旁白):
            // round 0 纯文本被拒 → nudge "不要只回答文本" → 模型道歉+乱调 current_time/metrics_dashboard
            // → 每轮都被 nudge/工具牵着走, 烧光 maxRounds。认知类问题首轮完整答复直接收口;
            // 短文本 (<120 字符, 如 "好的"/一句话旁白) 仍视为没答 → 走 nudge
            // 2026-08-02 反幻觉钩子③ (RTF 11:24 实案: 0 工具轮直接收口 "沙箱关了/权限开不了" — 全是编的):
            // 0 工具 + 系统状态断言 = 高危幻觉, 不收口, nudge 逼举证 (上限 1 次, 防误伤正常问答)
            const _UNVERIFIED_CLAIM_RE = require('./guard_patterns').UNVERIFIED_CLAIM_RE; // 守卫模式单一真源
            if (toolsUsed.length === 0 && _UNVERIFIED_CLAIM_RE.test(_nativeAnswerOnly) && _unverifiedNudges < 1 && round < maxRounds - 1) {
              _unverifiedNudges++;
              console.warn('[j2-native] UNVERIFIED_CLAIM_GUARD: 0 工具 + 系统状态断言, nudge 逼举证');
              try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '检测到未验证的系统状态断言 (0 工具调用), 已要求先查证再下结论.' }) + '\n\n'); } catch (e) {}
              _pushReplay('UNVERIFIED_CLAIM', textContent, 300);
              messages.push({ role: 'system', content: '[SYSTEM WARNING] 你刚才的回答包含关于系统状态的断言 (沙箱/权限/文件不存在/未安装/连不上), 但你这一轮一个工具都没调 — 这些结论没有证据。下一轮二选一: 1) 调工具 (exec_command / read_file) 验证后再下结论, 注明出处; 2) 如果这些断言只是用户问题里的假设/案情内容而非你自己系统的状态, 忽略本警告, 直接给出完整答案。禁止再凭空断言系统状态。' });
              continue;
            }
            // 2026-08-03 假产出收口拦截 (老板 8/3 上午实案: 6 次声称"已出图/已写入 X KB", 磁盘零文件,
            // write_file 根本没调, 字节数纯编 — 钩子③ 只管系统状态断言, 没管"产出谎称"):
            // final 声称文件产出但本轮无写类工具成功 → nudge 逼真写 + ls 举证, 上限 1 次
            const _WRITE_TOOLS = require('./guard_patterns').WRITE_TOOLS;
            const _FAKE_OUT_RE = require('./guard_patterns').FAKE_OUT_RE;
            // 2026-08-03 扩 (老板 8/3 下午实案: 自我迭代任务 0 写工具, 文本报"改完 _trimOutput / buildClaimAudit 已挂",
            // git 零提交工作区干净): 改码声称同样纳入拦截。动词限定两字以上, 避开"挂了(=死了)"歧义
            const _FAKE_EDIT_RE = require('./guard_patterns').FAKE_EDIT_RE;
            const _hasWriteTool = toolsUsed.some(n => _WRITE_TOOLS.indexOf(n) >= 0);
            // 2026-10-17 (现场 lt3-1792177128350_sub-2-analyzer, 子会话 messages[9] 逐字读的):
            // analyzer 读完 checkpoint.js (166 行, 1 轮就读完) 后交出**完整正确**的分析,
            // 里面有一句「时机在于 checkpoint 已落盘、随时可接棒」——
            //   那是在**描述被分析的代码模块干了什么**, 不是声称它本轮写了文件。
            // 但 FAKE_OUT_RE 的 "已落盘" 分支照样命中, 于是这份正确报告被整个换成
            //   「⚠️ [盘古 FAKE-OUTPUT 熔断] 我刚才把结果说成了本轮已落盘…」
            // 一份对的交付被自己的护栏杀掉, 还白烧两轮 (nudge + 熔断)。
            //
            // 根因: 这条护栏把**描述代码行为**和**声称自己产出**当成同一件事。
            // 对"读完就讲解"的角色, 报告里必然出现 落盘/写入/保存/生成 这些词 ——
            // 讲一个落盘模块就要说落盘。角色不对, 词就不该当证据。
            //
            // 闸门: **默认拦**, 只在能明确认出"这一刀是纯读"时才解除。
            // 反过来判 (认读 → 才放行) 而不是反过来 (认写 → 才拦), 因为今天已经栽过一次:
            //   第一版闸门用"任务里有没有写类动词"来决定拦不拦, 动词表是照想象写的,
            //   结果老板 2026-08-03 的真案「把今天的会议图**出 6 张**」没命中表 → 真案被放过。
            // 判据词表永远补不齐 (见踩坑日志: 词表只能靠抓真实语料长), 所以方向必须选
            // "认不出来就拦" —— 误伤最多多一轮, 漏放是真假产出出门。
            //
            // 另外先剥掉所有【】方块再判: userInput 里带着服务端拼的边界块
            // (卦块/路径锚/收口纪律), 里面就有"禁止替别的步骤**产出**文件"这种字样 ——
            // 不剥的话, 任何一把刀都会被自己那段边界文案判成"要产出", 闸门等于没加。
            const _taskCore = String(userInput || '').replace(/【[^】]*】/g, ' ');
            const _taskIsReadOnly = /(分析|讲解|解释|说明|总结|梳理|读|查看|核对|对比|列出|盘点|介绍)/.test(_taskCore)
              && !/(写|生成|创建|新建|修改|改|修复|实现|重构|替换|提交|部署|安装|打包|保存|落盘|导出|删除|更新)/.test(_taskCore);
            const _anyToolUsed = toolsUsed.length > 0;
            // 解除武装的两个条件, 少一条都仍然拦:
            //   ① 任务明确是纯读 (剥掉边界块之后仍认得出);
            //   ② 本轮真调过工具 —— 手里有证据才谈得上"只是在描述代码"。
            // 0 工具的纯文本声称产出, 无论任务怎么写都拦。
            const _guardArmed = !(_taskIsReadOnly && _anyToolUsed);
            if (!_hasWriteTool && _guardArmed
              && (_FAKE_OUT_RE.test(_nativeAnswerOnly) || _FAKE_EDIT_RE.test(_nativeAnswerOnly))) {
              if (_fakeOutNudges < 1 && round < maxRounds - 1) {
              _fakeOutNudges++;
              console.warn('[j2-native] FAKE_OUTPUT_GUARD: 0 写工具 + 产出/改码声称, nudge 逼真写+举证');
              try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '检测到未真做的产出/改码声称 (0 写类工具), 已要求真做并 ls/git diff 举证.' }) + '\n\n'); } catch (e) {}
              _pushReplay('FAKE_OUTPUT', textContent, 300);
              messages.push({ role: 'system', content: '[SYSTEM WARNING] 你刚才声称已经产出文件或改完代码 (出图/写入/保存/已修改/已修复/已实装), 但本轮没有任何写类工具成功执行 — 这只能证明你没有本轮写入凭据, 不能把已有源文件说成本轮新产出。下一轮二选一: 1) 用户明确要求创建/修改时, 真调工具 (file_edit / write_file / draw_layout / exec_command), 然后必须再调 exec_command 跑 `ls -lh <路径>` 或 `git diff --stat` 举证; 2) 如果只是读取/核对已有文件, 改写为"已存在/已读取, 本轮未写"。禁止再口头汇报路径、字节数、"已改完"。' });
              continue;
              }
              // 2026-09-12 (老板 20:26 实案): nudge 后仍 0 写工具嘴报进度 ("总结.md 1010→1106 行"
              // 纯编, 磁盘实证 647→784 是下一轮真做的) — 旧逻辑 nudge 1 次后放行, 假进度交付给主人。
              // 熔断: 诚实承认没做, 绝不让编造的落盘声称出门。
              console.warn('[j2-native] FAKE_OUTPUT_GUARD: nudge 后仍假产出声称, 熔断');
              try { require('./task_ledger').recordLesson(_sessionId, 'FAKE_OUTPUT', '0 写工具嘴报落盘/进度, nudge 后仍编 — 产出必须真写 + ls/git 举证, 禁止口头汇报路径字节数'); } catch (_) {}
              try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'FAKE_OUTPUT: 模型声称已落盘但全程 0 写类工具调用, 已熔断 (那些进度是编的).' }) + '\n\n'); } catch (e) {}
              finalText = '⚠️ [盘古 FAKE-OUTPUT 熔断] 我刚才把结果说成了本轮已落盘/已写入, 但本轮没有真实写类工具凭据，不能证明是本轮新产出。已有文件可能仍然存在。\n建议: 继续时只区分"已存在/已读取"和"本轮新写入"；需要新产出时再真调 write_file 并用 ls 举证。';
              totalChars = finalText.length;
              evoSuccess = false;
              break;
            }
            // 2026-09-11 LIP-SERVICE text-only 护栏 (09-11 11:02 实案: "先列出每个主题的具体文件名 + 大小" 0 真工具直进 finalText):
            // 旧护栏缝隙 — _looksLikeEmptyPlan 只抓"第N步"模板 / PROMISE 只抓 <120 字 / LIP_SERVICE 只守 task_done
            // 现在: 0 真工具 + 嘴炮措辞 → nudge 逼动手 (与 task_done lip 拒收共享上限 2), 耗尽诚实失败熔断
            if (toolsUsed.length === 0 && _isLipServiceText(textContent) && round < maxRounds - 1) {
              if (_lipServiceNudges < 4) {
                _lipServiceNudges++;
                console.warn('[j2-native] LIP_SERVICE_TEXT_ONLY: 0 真工具 + 计划型文本, nudge #' + _lipServiceNudges);
                try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'LIP_SERVICE: 0 工具调用 + 承诺型输出, 不收, 已要求立即动手.' }) + '\n\n'); } catch (e) {}
                _pushReplay('LIP_SERVICE_TEXT_ONLY', textContent, 300);
                messages.push({ role: 'system', content: '[LIP_SERVICE_BLOCKED] 你上一轮只输出计划/承诺 (定个顺序/先列出/开做/开读/现在直接.../接下来...), 全程 0 次真工具调用 — 这是光说不做。立即调用工具 (read_file / list_directory / exec_command) 真执行, 拿到真实结果后再 task_done 收口; 做不了就 task_done({status:"failed", reason:"..."}) 老实承认。不要再复述计划或写待办。' });
                continue;
              }
              console.warn('[j2-native] LIP_SERVICE_TEXT_ONLY: nudges exhausted, honest fail');
              try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'LIP_SERVICE: 模型反复输出计划/承诺不调工具, 已熔断.' }) + '\n\n'); } catch (e) {}
              finalText = '[LIP-SERVICE 熔断] 我连续 ' + _lipServiceNudges + ' 轮只说"开干/先列/接下来"却 0 真工具, 没收口, 但方向已理解 — 断点续跑即可, 不用重发整个任务。\n怎么继续: 直接说「继续」接上, 或拆单步指令 (例: "先 ls <语料库目录>/课程资料").';
              totalChars = finalText.length;
              evoSuccess = false;
              break;
            }
            // 2026-09-12 (老板 19:33 实案 "工具挂了"): 模型把 "(调用工具: memory_search)" 写成
            // 正文文本 — 假工具调用, 0 真执行, 前端却渲染成工具卡永远转圈。21 字太短,
            // ≥30 字的 lip-service 护栏和"第N步"空计划模板都抓不到 → 单独守卫, 共享 nudge 上限。
            const _FAKE_TC_TEXT_RE = require('./guard_patterns').FAKE_TC_TEXT_RE; // 守卫模式单一真源
            if (toolsUsed.length === 0 && _FAKE_TC_TEXT_RE.test(textContent.trim())) {
              if (_lipServiceNudges < 4 && round < maxRounds - 1) {
                _lipServiceNudges++;
                console.warn('[j2-native] FAKE_TOOLCALL_TEXT: 工具调用被写成正文文本, nudge 逼真 tool_call #' + _lipServiceNudges);
                try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '模型把工具调用写成了文字 (没有真执行), 已要求发真 tool_call.' }) + '\n\n'); } catch (e) {}
                _pushReplay('FAKE_TOOLCALL_TEXT', textContent, 300);
                messages.push({ role: 'system', content: '[SYSTEM WARNING] 你上一轮输出的 "(调用工具: ...)" 只是正文文字 — 工具没有执行, 这不是真的工具调用。你必须通过原生 tool_call 机制发起调用 (你有完整 tools 列表可用)。下一轮直接发真 tool_call, 禁止再用文字描述调用动作; 不调工具就直接用文字回答问题, 不要写 "(调用工具: ...)" 这种假动作。' });
                continue;
              }
              console.warn('[j2-native] FAKE_TOOLCALL_TEXT: nudges exhausted / last round, honest fail');
              try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'FAKE_TOOLCALL: 模型反复把工具调用写成文字, 已熔断.' }) + '\n\n'); } catch (e) {}
              finalText = '⚠️ [盘古 FAKE-TOOLCALL 熔断] 我反复把 "(调用工具: ...)" 写成文字而没有发起真 tool_call, 工具实际没有执行。\n建议: 重发指令 (例: "用 memory_search 查 X"), 或换原生工具调用更稳的模型。';
              totalChars = finalText.length;
              evoSuccess = false;
              break;
            }
            // 2026-09-13 (老板 14:06 实案 "还是等指示"): 主人已拍板 ("继续/全部做了/去干/数字选项"),
            // 模型 0 工具回 "等你指令就接着干/主人拍?" — 等指示病, 全部守卫都漏 (措辞不含承诺词)。
            // nudge 一次逼直接执行; 再犯放行收口, 由 verdict 诚实判失败。
            const _WAIT_INSTRUCTION_RE = /(等你?指令|给指令|听指令|待指令|主人拍|等你拍|等主人拍|待主人拍|拍板|主人定|看主人|你拍)/;
            const _CONTINUATION_INPUT_RE = /^\s*(继续|全部做了|全部做完|接着|那就去干|去干|干|做|好|嗯|对|可以|行|ok|\d{1,2})[\s,，。!！]*/i;
            if (toolsUsed.length === 0 && _confirmNudges < 1 && round < maxRounds - 1
                && _CONTINUATION_INPUT_RE.test(String(userInput || '').trim())
                && _WAIT_INSTRUCTION_RE.test(textContent)) {
              _confirmNudges++;
              console.warn('[j2-native] WAIT_INSTRUCTION_NUDGE: 主人已拍板模型仍等指示, nudge 逼直接执行');
              try { require('./task_ledger').recordLesson(_sessionId, 'WAIT_INSTRUCTION', '主人已拍板仍输出"等你指令/主人拍" — 禁止要确认, 自己的方案直接执行'); } catch (_) {}
              try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '你已拍板继续, 模型仍在等指示, 已要求直接执行.' }) + '\n\n'); } catch (e) {}
              _pushReplay('WAIT_INSTRUCTION', textContent, 300);
              messages.push({ role: 'system', content: '[WAIT_INSTRUCTION_BLOCKED] 主人已经明确拍板 ("' + String(userInput || '').slice(0, 30) + '") — 禁止再要指令/要确认/等拍板/等指示。你自己的方案就是定论, 下一轮直接调工具执行 (read_file / exec_command / write_file), 干完调 task_done 汇报。再输出"等你指令/主人拍" = 任务失败。' });
              continue;
            }
            if (round >= 1 || textContent.trim().length >= 120) {
              // 2026-09-12 e2e 实战修: 末轮纯文本收口前试续跑 — 所有 nudge 守卫带 round < maxRounds-1
              // 条件, 末轮全放行 → 意图型文本 ("继续读第 2 份") 在这直接 finalText+break, 永远够不到
              // 轮末续跑块 (e2e 实案: 读 1 份文件后末轮甩一句"继续读"就 failed 收场)。
              // 限 toolsUsed>0 (干活中的任务才续), 纯问答对话文本收口不打扰。
              if (round === maxRounds - 1 && !taskDoneAccepted && toolsUsed.length > 0) {
                const _resumed = await _tryAutoResume('last_round_text_final');
                if (_resumed) { round = -1; continue; }
              }
              // 2026-09-13 (老板 14:07 实案): 干活中的任务, 模型中途甩 "本轮交付 + 我建议/主人拍?"
              // 文本就 break — 不到 maxRounds 也没 task_done, 所有续跑触发点全够不到 → 老板必须再说"继续"。
              // 有真工具 + 文本含续作/待拍措辞 → 先续跑, 续跑不动 (无 checkpoint/plan) 才放行收口。
              // 2026-10-13 现场统计 (600 个真实会话): plan 确有 pending/doing 的会话 4 个,
              // 其中 4 个的末条答案都不含任何续作关键词 → **全部直接收口, 0 个被续上**。
              // 反过来, 主日志里 48 次 text_final_continue_intent 放行时, 客观状态**每一次**
              // 都是 pending=1 或 checkpoint active —— 没有一次是"模型说继续但客观上做完了"。
              // 也就是说 _TEXT_CONTINUE_RE 是个**多余且不可靠的前置筛选**: 它只决定"要不要问",
              // 真正拍板的是 _tryAutoResume 里的客观检查。
              // 所以这里反过来: 客观没干完就先问, 模型说了什么不决定续不续。
              // 这跟 Codex 的做法一致 (codex_goal_extension): 续不续跑由目标状态说了算,
              // 模型只能把目标标 complete/blocked, 不能自己喊一句"继续"就决定续不续。
              const _objGate = _objectiveWorkRemaining(_sessionId, { invocationStartedAt: agentStartTime });
              if (!taskDoneAccepted && toolsUsed.filter(n => n !== 'task_done').length > 0
                  && _objectiveGateOpen(_objGate) && round < maxRounds - 1) {
                const _resumed = await _tryAutoResume('objective_incomplete');
                if (_resumed) { round = -1; continue; }
              }
              const _TEXT_CONTINUE_RE = /(下一步|下轮|还剩|剩余|待做|待补|继续|主人拍|等你拍|等主人拍|待主人|我建议|建议.*拍|未做|未完成|还没动|等你?指令)/;
              // 2026-10-17: 这道门也接上同一个客观闸门 (_objectiveGateOpen), 兑现上面那段注释。
              // 注释说"真正拍板的是客观检查" —— 但那个客观检查对**无 plan 的子 agent**一直是由
              // 自己刚写的 status='active' 心跳撑着的 (即 _objectiveWorkRemaining 的恒真分支),
              // 所以"客观"其实只是把模型的措辞又确认了一遍。objective_incomplete 那边修好之后,
              // 这里不接上就等于留了个后门: 前门关了, 后门照旧按模型措辞续跑。
              // 现场 (q-1792198449369, 4 个子 agent): objective_incomplete 归零后, 3 次续跑
              // 全部 reason=text_final_continue_intent, 三次都是 checker, pending=0/plan=null
              // —— 跟修之前是同一笔白烧, 只是换了个 reason。
              // 有 plan 的长任务不受影响 (_objectiveGateOpen 里 hasPlan 直接放行, S2/S4 仍绿)。
              if (!taskDoneAccepted && toolsUsed.filter(n => n !== 'task_done').length > 0
                  && _TEXT_CONTINUE_RE.test(textContent) && _objectiveGateOpen(_objGate)
                  && round < maxRounds - 1) {
                const _resumed = await _tryAutoResume('text_final_continue_intent');
                if (_resumed) { round = -1; continue; }
              }
              // 2026-09-14 (老板 13:42 实案 "这才是问题"): 终局对账只抓假不纠假 —
              // 模型编交付被拦回合照样收口报死, 主人必须重发指令激活。纠假回灌:
              // 拦截结论直接回灌 loop 再跑, 逼它真做 (write_file) 或老实说没做, 上限 2 次防死循环。
              if (!taskDoneAccepted && _deliveryRejectRetries < 2 && textContent) {
                try {
                  const _dcEarly = require('./task_ledger').checkDeliveryClaims(_sessionId, textContent, { toolsThisRun: toolsUsed.filter(n => n !== 'task_done').length });
                  if (_dcEarly && _dcEarly.missed && _dcEarly.missed.length) {
                    _deliveryRejectRetries++;
                    console.warn('[j2-native] LEDGER_DELIVERY_RETRY #' + _deliveryRejectRetries + ': 终局文本编交付 (' + _dcEarly.missed.slice(0, 2).join(',') + '), 回灌纠假不收口');
                    try { require('./task_ledger').recordLesson(_sessionId, 'FAKE_DELIVERY', '终局编交付被拦并回灌纠假: ' + _dcEarly.missed.join(',').slice(0, 120)); } catch (_) {}
                    try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '对账拦截: 交付声称的文件账上无据, 已自动回灌要求真做 (纠假 ' + _deliveryRejectRetries + '/2).' }) + '\n\n'); } catch (_) {}
                    _pushReplay('LEDGER_REJECT', textContent, 300);
                    messages.push({ role: 'system', content: '[LEDGER_REJECT] 你刚才声称本轮落盘/生成了文件 (' + _dcEarly.missed.slice(0, 3).join('、') + '), 但任务账本没有对应写盘记录。文件可能本来就存在或只是被读取, 不要把源文件/已有文件说成本轮新产出。优先改写答复: 只报真实写入的文件, 其余写"已存在/已读取, 本轮未写"。只有用户明确要求创建新文件时才继续调用 write_file / exec_command 重定向。' });
                    continue;
                  }
                } catch (_) {}
              }
              finalText = textContent;
              break;
            }
          }
 // BugA: legacy 路径也加重复检测
          if (textContent.length > 200 && round >= 1) {
            const prevAssistant = messages.filter(function(m) { return m.role === 'assistant'; }).pop();
            const prevText = prevAssistant ? (prevAssistant.content || '') : '';
            if (prevText && textContent === prevText) {
              console.warn('[j2-stream] STATUS_FOUNTAIN_GUARD: identical output detected, breaking');
              _recordModelFailure(model && model.id);  // 2026-08-23 R16 修: 实时 push 进程内黑名单
              textContent = '[SYSTEM: Duplicate output detected, circuit breaker triggered.]';
              break;
            }
          }
          // 2026-10-23 (第 73 批): 原来这里有一段 R80 LIP_SERVICE_AFTER_TOOLS, 已**删除**。
          //   删的理由 (三条, 都是实测/结构级, 不是"看着不顺"):
          //   ① 它写在 finalText=textContent; break; **之后** ⇒ 结构性够不到
          //      (要够到它必须 round===0 且正文 <120 字, 而 round 0 的 toolsUsed 必为空 —— 两条件互斥),
          //      实测从没响过。
          //   ② 它调的 _stripSpecialTokensForFinal **全库没有定义** ⇒ 一旦复活就是 ReferenceError 打断整轮。
          //   ③ 它的词表 (再补/摸清/到手/先查) 在真实答复里很常见, 真复活会误伤正常结论。
          //   替代品在**上面** (finalText=textContent; break; 之前): 结构信号 (复读 / 承诺句式) →
          //   先 nudge 要结论, nudge 用尽再基于工具结果出实做报告。
          if (round === maxRounds - 1) {
            finalText = textContent || finalText;
            break;
          }
          // 2026-10-15 (本地 27B / LM Studio 现场): 这道闸门把 2 秒的正确答案变成 4 分钟卡死。
          // 实测: 模型第 0 轮就答对了 ("跑在本机、以64卦为内核的谋断AI。"), 但因为
          // `round >= 1 || len >= 120` 不成立而落到这里 → 答复被丢弃 → 追问"请调用一个工具"
          // → 模型调了个毫不相干的 current_time → 下一轮 23.6k token 提示词 prefill 83s 空转。
          // 修法: 只有"像在承诺去干活"的文本才值得逼工具 (_J2_PROMISE_TEXT_RE, 与 PROMISE_ZERO_TOOLS
          // 守卫同一套已验证信号); 干净的直接回答就当答案收下。不新造任务分类器。
          if (round === 0 && !taskDoneAccepted && toolsUsed.length === 0
              && textContent && textContent.trim()
              && !_J2_PROMISE_TEXT_RE.test(textContent)) {
            console.log('[j2-native] ROUND0_ANSWER_ACCEPTED: 第 0 轮直接给了答案 (非承诺文本), 不再强逼工具');
            finalText = textContent;
            break;
          }
          // 强逼 LLM 调工具
          if (!isAnthropic) messages.push({ role: 'assistant', content: textContent || '', tool_calls: llmResult.choices?.[0]?.message?.tool_calls });
          messages.push({ role: 'user', content: '请调用一个工具完成任务 (e.g. current_time / system_info / list_pangu_agents / task_done). 不要只回答文本。' });
          continue;
        }

        // 真执行 tool_calls (TL-1 改造: depends_on 拓扑 + parallel batch + TL-2 unified schema)
        if (textContent) _emitThinkingEnd(res);  // 2026-07-26: 本轮文本是旁白 → 前端挪进 thinking 折叠区
        messages.push({ role: 'assistant', content: textContent || '', tool_calls: !isAnthropic ? llmResult.choices?.[0]?.message?.tool_calls : undefined });
        // 2026-08-11 R131+ 老板拍: tool_call 独立 emit (前端 ToolCall 卡片用, 不塞进 stream_delta 文本)
        try {
          res.write('event: tool_call\ndata: ' + JSON.stringify({
            calls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, params: tc.params }))
          }) + '\n\n');
        } catch (e) { console.warn('[j2-stream] tool_call sse_write error:', e.message); }
        const toolResults = [];
        let permissionGranted = false; // verify-after-allow 标记
        // TL-1: 收集所有 tool result 供后续 for 循环消费 (depend_on 拓扑 + parallel batch)
        const _j2ExecResults = new Map();
        // 2026-10-17: 同一份结果再落一份 tool_call_id 索引。
        // _j2ExecResults 的 key 是 _j2Ukey(tc) = "<name>#<序号>", 序号由**调用时刻**的
        // _j2NameSeq 分配 —— 回灌阶段再拿 tc 去算 _j2Ukey 是不可靠的: 消费循环 break 之后,
        // 有些 tc 压根没进过执行阶段, 此时调 _j2Ukey 会给它新分配一个序号, 而那个序号
        // 可能已经被别的 tc 用掉了 → 静默拿到别人的结果。
        // (护栏 R3 就是这么撞出真 bug 的: call_B 拿到了 call_A 的 HTTP_403。)
        // 回灌要回答的问题是"这个 tool_call_id 的结果是什么", 就该按 id 存, 不该猜。
        const _j2ResultByCallId = new Map();
        const _j2SetExecResult = (tc, result) => {
          _j2ExecResults.set(_j2Ukey(tc), result);
          if (tc && tc.id != null) _j2ResultByCallId.set(tc.id, result);
        };
        // 2026-08-01 修: 同名工具批量调用结果互相覆盖 (Map 按 name 做 key, 2 个 exec_command 只剩第 2 个)
        // 实证: 老板截图 '第一个命令的结果被截断/丢失了,只回来第二个'
        const _j2NameSeq = {};
        const _j2Ukey = (tc) => {
          if (!tc._ukey) {
            _j2NameSeq[tc.name] = (_j2NameSeq[tc.name] || 0) + 1;
            tc._ukey = tc.name + '#' + _j2NameSeq[tc.name];
          }
          return tc._ukey;
        };
        const _j2HasResult = (name) => _j2ExecResults.has(name) || [..._j2ExecResults.keys()].some(k => k.startsWith(name + '#'));
        const _j2BatchSize = 5;
        // 2026-08-16 P0 fix: _execToolWithPermission 之前 apply_patch 失败, 函数没真接上
        // → j2 batch 路径所有 tool call 都被 try/catch 兜成 {ok:false, error:'_execToolWithPermission is not defined'}
        // P1-2 高危 op 审批 + P3 budget.recordToolCall 全失效, 一并补齐
        // 2026-08-16 P0: 危险 op 是否 ask 主人改由 permission.shouldAsk() 决定 (level-based, 不是 hardcoded 列表)
        //   - bypassPermissions / dontAsk → 不 ask
        //   - acceptEdits / auto / plan → 危险工具 ask
        //   - default → 不 ask (但实际 sandbox checkToolCall 会拦)
        let _permShouldAsk = null;
        try {
          const _permissionMod = require('./permission');
          _permShouldAsk = _permissionMod.shouldAsk || null;
        } catch (_) {}
        async function _execToolWithPermission(tc, sessionId, _res) {
          // P3 算力 budget (新政 #8 全要素兜底) — 每次 tool call 计数
          try {
            const _bCheck = budget.recordToolCall(sessionId);
            if (!_bCheck || !_bCheck.ok) {
              try { _res.write('event: budget_exceeded\ndata: ' + JSON.stringify({ session_id: sessionId, exceeded: _bCheck && _bCheck.exceeded, ts: Date.now() }) + '\n\n'); } catch (_) {}
              return { ok: false, _budget_denied: true, error: '[budget] 算力预算耗尽: ' + (_bCheck && _bCheck.exceeded || 'unknown') };
            }
          } catch (_) { /* budget 模块异常不阻断执行 */ }
          // 2026-10-17 (实跑 q-1792249178899 的教训): dispatch_subagents 必须在这里拦,
          // 拦在 legacy 那份 (:4150) **不够** —— native 路径根本不经过那儿。
          //
          // 实跑形状: 主 agent (role=main, 工具笼已关成 2 个) 老实调了
          // dispatch_subagents, 但调用是从 native 轮 (:3003 → 本函数) 下去的,
          // 撞上 `TOOLS[tc.name](...)` —— dispatch_subagents 按设计**不在 TOOLS 表里**
          // (那边 ctx 只有 {user, sessionId}, 拿不到 res/model/configPath),
          // 于是 "TOOLS[tc.name] is not a function", 主 agent 拿到的是工具崩溃而不是拆解结果。
          //
          // 为什么之前没发现: 假 loop 打的是 legacy 分支, native 分支根本没被覆盖到。
          // 所以这里放**两个**拦截点不是重复 —— native / legacy 是两条互不相交的路,
          // 少任何一个都会出现「配了但不生效」且**不报错**的静默失败。
          if (tc.name === 'dispatch_subagents') {
            try {
              // ⚠️ 本块**不许**写裸 path.join —— path 在本文件里是**块级**局部 require
              // (:260 自我认知注入块 / :3870 task_done 块), 不是模块级, 落到本块作用域外
              // 就是 ReferenceError ("path is not defined"), 派活链路当场断掉。
              // 实跑 q-1792249305xxx 就是这么炸的。
              // 节点配置路径现在走 config/node_config.js 解析 (第 109 批), 这里压根不用拼路径。
              try { _res.write('event: status\ndata: ' + JSON.stringify({
                stage: 'dispatching',
                message: '主 agent 拆成 ' + ((tc.params && tc.params.tasks && tc.params.tasks.length) || '?')
                  + ' 刀, 派给将灵并行执行...',
                ts: Date.now(),
              }) + '\n\n'); } catch (_) {}
              return await require('./dispatch_subagents_exec').runDispatchSubagents({
                params: tc.params,
                model,
                req,
                res: _res,
                sessionId,
                opts: opts || {},
                userInput,
                planOnly: Boolean(opts && opts.planOnlyDispatch),
                onPlanned: opts && opts.onPlanned,
                configPath: (_deps && _deps.CONFIG_PATH)
                  || require('../config/node_config').resolveNodeConfigPathOrEmpty(),
              });
            } catch (e) {
              return {
                ok: false,
                error: 'DISPATCH_EXCEPTION: ' + String((e && e.message) || e).slice(0, 300),
              };
            }
          }
          // 2026-10-16 (现场取证 session request-1792124456972-8cekw6#sub-0-analyzer):
          // analyzer 是只读角色, prompt 里写着「只读角色跑写命令会被直接拒 (ROLE_READ_ONLY),
          // 不弹审批也没有例外」—— 但**那句话当时是假的**。
          //   2026-10-14 那道闸门只加在 sub-agent.js 的执行器里, 而 planner 拆出来的子任务
          //   走的是本文件 (_roleForThisLoop = 'analyzer'/'checker'/...),
          //   j2_agent_loop.js:634 注释自己就写着「不经过 sub-agent.js」。
          //   现场后果: analyzer 用 `cat > /tmp/... <<EOF` 真的写出了文件, 一次没被拦。
          // 这是「注释 ≠ 隔离」那条铁律的原样复发 —— 规则写在 prompt 里, 执行层没接线。
          // 放在 budget 之后 / shouldAsk 之前: 只读边界**不受**沙箱开关和审批级别影响,
          // 跟 sub-agent.js:872 的纪律保持一致 (老板关掉 sandbox 是信任主循环, 不是授权删文件)。
          // 判定自身出错时按拒绝处理 (fail-closed) —— 与 action_policy.checkRoleAction 同源语义。
          // 判定和副作用**刻意分开**: try 只包住 checkRoleAction 这一次调用, 判定自身
          // 出错就立刻 fail-closed 返回; 记账/留痕/扣预算这些副作用放在守卫外面。
          // (早先把副作用也塞在 try 里, 一来 fail-closed 的语义被稀释 —— 万一副作用
          //  自己抛错, 错误信息会被记到"权限判定出错"名下; 二来守卫越堆越长,
          //  role-gate-wiring 的 W4 锚在"判定调用 + catch"这一段上, 加长了就得跟着放宽窗口。)
          let _roleAction = null;
          let _roleActionErr = null;
          try {
            _roleAction = require('./action_policy').checkRoleAction(_roleForThisLoop, tc.name, tc.params || {});
          } catch (_e) {
            _roleActionErr = _e;
          }
          if (_roleActionErr || (_roleAction && !_roleAction.ok)) {
            const _reason = _roleActionErr
              ? '权限判定自身出错, 按拒绝处理 (fail-closed): ' + String((_roleActionErr && _roleActionErr.message) || _roleActionErr)
              : _roleAction.reason;
            console.warn('[action_policy] BLOCK ' + _roleForThisLoop + ' → ' + tc.name + ': ' + _reason);
            // 按**工具名**记账 (不是 工具名|参数), 见 _makeRoleDenyGuard 上方那段。
            const _deny = _roleDeny.note(_roleForThisLoop, tc.name);
            // 预算照扣: 否则被拒的调用对 budget 完全隐身, 可以无限重试。
            try { require('./budget').recordToolCall(sessionId); } catch (_) {}
            try {
              require('./run_trace').appendGuard({
                guard: 'action_policy', action: 'block',
                reason: (_roleActionErr ? 'ROLE_READ_ONLY' : _roleAction.code) + ': ' + _reason
                  + (_deny.exhausted ? ' [已连续拒绝 ' + _deny.count + ' 次, 换路提示已下达]' : ''),
                userInput: sessionId || _roleForThisLoop,
              });
            } catch (_) { /* 留痕失败不许影响拦截 */ }
            // blocked: true —— 让后面的 self-check / 空转检测知道这是"被策略拒了",
            // 而不是工具真失败 (不然会逼模型反复换姿势重试同一刀)。
            // 刻意**不**触发 self_correct: 那是盘古本地守门造成的"拒", 不是工具故障,
            // 罚模型两次是 2026-10-15 已经修过的错 (一句话的活跑 13 轮 / 168 秒)。
            // 这里改用更直接的两段式文案: 第一次点名替代方案, 第二次明确叫停。
            return {
              ok: false, blocked: true, _role_denied: true, data: {},
              error: 'ROLE_READ_ONLY: ' + _reason,
              message: _deny.message,
              _role_denied_count: _deny.count,
            };
          }
          // 2026-10-28 (第 136 批 P3): 权限**档位**的执行层闸门。
          //   「只读」档以前只是设置页的一句标签 —— permission.js 写着 allowWrite:false,
          //   但 PermissionEngine.can() 全仓没人调 ⇒ 切到只读照样写盘、照样联网。
          //   这里补上真正接线的那一刀: 只读档禁写禁网, 规划档只准写白名单路径。
          //
          //   位置: action_policy (角色边界) 之后 / shouldAsk (要不要问) 之前。
          //   · 角色边界管"这个将灵能不能干这事", 档位管"这个会话能不能干这事", 两件事不重叠。
          //   · 档位闸在审批闸之前: 只读档是**禁止**, 不是"问一下主人" —— 弹审批没意义,
          //     主人自己刚把档位调到只读。
          //   · 判定自身出错时按"拒绝写/网"处理 (fail-closed), 放行只读类调用 ——
          //     闸门坏了最多是"写不动", 不是"整个盘古瘫掉"。
          let _permGuardVerdict = null;
          let _permGuardErr = null;
          try {
            _permGuardVerdict = require('./permission_guard')
              .checkToolPermission(tc.name, tc.params || {}, { sessionId });
          } catch (_e) {
            _permGuardErr = _e;
          }
          if (_permGuardVerdict && _permGuardVerdict.allowed === false) {
            const _gReason = _permGuardVerdict.reason || ('权限档位 ' + (_permGuardVerdict.level || '?') + ' 不许这次调用');
            console.warn('[permission_guard] BLOCK ' + tc.name + ' (level=' + _permGuardVerdict.level + '): ' + _gReason);
            try {
              require('./run_trace').appendGuard({
                guard: 'permission_guard', action: 'block',
                reason: 'PERMISSION_LEVEL_BLOCKED: ' + _gReason,
                userInput: sessionId,
              });
            } catch (_) { /* 留痕失败不许影响拦截 */ }
            return {
              ok: false, blocked: true, _permission_denied: true, data: {},
              error: 'PERMISSION_LEVEL_BLOCKED: ' + _gReason,
              message: _gReason,
            };
          }
          if (_permGuardErr) {
            // 闸门自身出错 ⇒ 只把"会写/会联网"的调用按拒绝处理 (fail-closed),
            // 其余调用照常放行 —— 宁可写不动, 也不要整个盘古瘫掉。
            let _gAction = 'write';
            try { _gAction = require('./permission_guard').classifyAction(tc.name, tc.params || {}); }
            catch (_) { _gAction = 'write'; }
            if (_gAction === 'write' || _gAction === 'network') {
              const _gReason = '权限判定自身出错, 按拒绝处理 (fail-closed): '
                + String((_permGuardErr && _permGuardErr.message) || _permGuardErr);
              try {
                require('./run_trace').appendGuard({
                  guard: 'permission_guard', action: 'block',
                  reason: 'PERMISSION_LEVEL_BLOCKED: ' + _gReason,
                  userInput: sessionId,
                });
              } catch (_) { /* 留痕失败不许影响拦截 */ }
              return {
                ok: false, blocked: true, _permission_denied: true, data: {},
                error: 'PERMISSION_LEVEL_BLOCKED: ' + _gReason,
                message: _gReason,
              };
            }
          }
          // P1-2 高危 op 人工审批 (新政 #7 安全治理) — 由 current permission level 决定
          // permission.shouldAsk 返回 { ask: bool, reason: string }
          if (requirePermission && _permShouldAsk) {
            try {
              // 2026-08-17: 传 sessionId 让 permission 用 session override (不传 = global)
              const _ask = _permShouldAsk(tc.name, tc.params || {}, { sessionId });
              if (_ask && _ask.ask) {
                const r = await requirePermission(tc.name, tc.params || {}, { sessionId, res: _res, timeoutMs: 60000 });
                if (!r || !r.approved) return { ok: false, blocked: true, _permission_denied: true, error: (r && r.reason) || '主人拒绝' };
              }
            } catch (_) { /* shouldAsk 异常放行, 不阻断 */ }
          }
          // 2026-10-24 (第 79 批): MCP 工具必须走 mcp_tool_exec.execMcpTool ——
          //   TOOLS 表里 `mcp__` 开头的工具是 0 个, 直接 `TOOLS[tc.name](...)` 一调就炸。
          //   legacy 那条 (_j2ExecuteToolCalls) 有 mcp__ 路由, native 这条以前没有,
          //   而本地模型走 native —— 只修签名不修这里 = 模型签得出来却调不动。
          //   放在**外面**分支 (不改内部工具那行的形状): 账本那条静态守卫
          //   (tests/task-ledger.test.js) 钉的就是"主执行路径把 sessionId 传进账本",
          //   顺手改形状会逼它改判据 —— 判据没错, 是我动了它盯着的那块代码。
          if (_isMcpToolName(tc.name)) {
            return await wrapToolResultWithHooks(tc.name, tc.params || {},
              async (params) => await _execMcpTool(tc.name, params), { sessionId });
          }
          // 走标准 tool 包装 (含 hooks + error_codes); 2026-09-13: 传 sessionId 给任务账本记账
          return await wrapToolResultWithHooks(tc.name, tc.params || {}, async (params) => TOOLS[tc.name]({ context: { user: 'feng', sessionId }, params }), { sessionId });
        }
        // 防重复调用硬守门 (2026-10-13 补: native 路径原来只有警告, 重复的写/执行类调用
        // 照跑 33 次把子 agent 锁死)。拦下的调用把结果预置进 _j2ExecResults,
        // 后面的循环照样给它发一条 tool 消息 —— 缺了就成孤儿 tool_calls, 上游直接 400。
        const { fresh: _j2FreshAll, duplicates: _j2DupCalls } =
          _partitionFreshCalls(toolCalls, _crossRoundToolCalls, _CROSS_ROUND_CALL_LIMIT);
        // 2026-10-16: 只读同参数重读 → 回放缓存, 不重跑 (见 _j2ReadCache 处注释)。
        // 缓存命中就把原结果原样发回去, 并附一句说明让模型知道"这份你已经拿到了"。
        // 拿不到缓存 (例如压缩把结果连同计数一起清了) 才放它真跑一次。
        // 刻意**不改** _partitionFreshCalls 的分桶契约 —— native-dup-guard-20261013
        // 钉死了「只读重读必须落在 fresh 里、不得被拦」。本刀不拦它, 只是把其中
        // 已有缓存的那几条从执行队列里取出来改走回放, 所以判定放在调用点做。
        const _j2CacheHits = [];
        const _j2FreshCalls = [];
        for (const tc of _j2FreshAll) {
          const _key = tc.name + '|' + _stableStringify(tc.params || {});
          const _seen = (_crossRoundToolCalls.get(_key) || 0);
          if (_seen >= _CROSS_ROUND_CALL_LIMIT && _READONLY_REPEAT_OK.has(tc.name)) {
            _j2CacheHits.push({ tc, key: _key, seen: _seen });
          } else {
            _j2FreshCalls.push(tc);
          }
        }
        const _j2Replayed = [];
        for (const { tc, key } of _j2CacheHits) {
          const _cached = _j2ReadCache.get(key);
          if (!_cached) continue;
          _j2SetExecResult(tc, {
            ok: true,
            data: _cached.data,
            _read_replayed: true,
            message: '(这份结果你上一轮已经拿到了, 这里原样回放, 没有重新读盘。直接用它继续。)',
          });
          _j2Replayed.push(key);
          try { res.write('event: tool_result\ndata: ' + JSON.stringify({
            name: tc.name, ok: true, replayed: true, id: tc.id,
          }) + '\n\n'); } catch (e) {}
        }
        // 2026-10-25 (第 85 批): 本轮所有**本地守门提示**先攒在这儿, 不直接 push 进 messages。
        //
        // 为什么: 上游契约要求 tool 结果**紧跟**发起它的那条 assistant 消息。
        //   守门提示 (DUPLICATE-CALL-BLOCKED / [HARD-LOOP] / [SYSTEM WARNING] /
        //   TOOL_SPIN_GUARD / [SELF_CORRECT_FAIL] / [PERMISSION_VERIFIED]) 全是
        //   system 消息, 而这一批 tool 结果要等下面那段回灌循环才 push ——
        //   守门提示要是当场 push, 就会**夹在** assistant(tool_calls) 和它的结果中间,
        //   上游直接 400: "tool call result does not follow tool call (2013)"
        //   ⇒ 整轮作废 ⇒ 那一刀死 ⇒ 主人收到 partial。
        // 现场取证: ~/.pangu-data/sessions/probe84-fixed_sub-2-li.json 索引 26-30
        //   (assistant tool_calls → system → system → tool → tool)。
        //
        // 修法: 攒着, 等 tool 结果回灌完再一起 push 到**结果后面**。
        //   语义反而更对: 模型先看到结果, 再看守门的话。
        const _j2GuardMsgs = [];
        // 回放过的也要计数 +1, 否则下一轮它又落回"没跑过"分支。
        for (const key of _j2Replayed) {
          _crossRoundToolCalls.set(key, (_crossRoundToolCalls.get(key) || 0) + 1);
        }
        // 缓存没命中的 (压缩把结果清掉了) 放回 fresh 真跑一次 —— 那时重读是模型
        // 把内容拿回来的唯一办法, 必须放行。
        if (_j2CacheHits.length > 0) {
          const _replayedSet = new Set(_j2Replayed);
          for (const { tc } of _j2CacheHits) {
            if (_replayedSet.has(tc.name + '|' + _stableStringify(tc.params || {}))) continue;
            _j2FreshCalls.push(tc);
          }
        }
        if (_j2DupCalls.length > 0) {
          for (const { tc } of _j2DupCalls) {
            _j2SetExecResult(tc, {
              ok: false,
              blocked: true,
              data: {},
              error: 'DUPLICATE_TOOL_CALL',
              // 2026-09-16 老板实案: 这是盘古本地防重复守门, 不是上游熔断 — 文案必须诚实区分,
              // 否则模型会当成上游死锁, 直接放弃剩下的活。
              message: '同一工具和参数已经原样执行过了 (本地防重复守门, 非上游熔断), 不会再执行第二遍。'
                + '基于已有结果继续总结, 或换参数/换工具推进, 实在卡住就 task_done 说明卡在哪。',
            });
          }
          // 2026-10-15: 被守门拦下的重复调用必须**照样记账**, 否则它对三个刹车全都隐身:
          //   - _crossRoundToolCalls / _crossRoundToolFails 只在下面遍历 toolResults 时 +1 (:2738/:2743),
          //     而拦下的调用结果只进了 _j2ExecResults, 压根不在 toolResults 里 → 计数永远停在 1,
          //     [HARD-LOOP] (count>=2) 和 [HARD] (fail>=2) 两条告警**永远不会响**;
          //   - budget.recordToolCall 只在 _execToolWithPermission 里 (:2395), 拦下的调用走不到那 → 算力预算不扣。
          // 三个刹车同时失效 = 模型可以无限重试同一个被拦的工具。
          // 实测 (fix 1 摘掉 self_correct 这道假刹之后立刻现形): list_pangu_agents 被拦 3 次,
          // 每轮本地推理 ~40s, 200s 还没收尾, 前端全程转圈。
          // 这里把拦截补记进三本账, 让既有的告警和预算真正生效 —— 不新造第四套机制。
          for (const d of _j2DupCalls) {
            _crossRoundToolCalls.set(d.key, (_crossRoundToolCalls.get(d.key) || 0) + 1);
            _crossRoundToolFails.set(d.key, (_crossRoundToolFails.get(d.key) || 0) + 1);
            try { budget.recordToolCall(_sessionId); } catch (_) {}
          }
          console.warn('[j2-native] 拦截重复工具调用:', _j2DupCalls.length, '个 (',
            _j2DupCalls.map(d => d.tc.name).join(','), ')');
          try {
            res.write('event: tool_loop_alarm\ndata: ' + JSON.stringify({
              warning: '拦截重复工具调用',
              count: _j2DupCalls.length,
              tools: _j2DupCalls.map(d => d.tc.name),
              ts: Date.now(),
            }) + '\n\n');
          } catch (_) {}
          // 不等下一轮才说教 —— 实测模型会连着调 3~4 次同一个工具才停,
          // 每一次都是一整轮本地推理。当场把话递到它面前。
          try {
            // 第 85 批: 攒着, 等 tool 结果回灌完再 push (见 _j2GuardMsgs 的注释)
            _j2GuardMsgs.push({
              role: 'system',
              content: '[DUPLICATE-CALL-BLOCKED] 你刚调的工具 '
                + _j2DupCalls.map(d => d.tc.name).join('、')
                + ' 因为和前面完全同参同工具, 被本地守门直接拦下了 —— 这次调用根本没执行, '
                + '所以再原样调一次还是同一个结果, 纯烧一轮推理。'
                + '现在只能三选一: (1) 换工具 (2) 改参数 (3) task_done 说明卡在哪。'
                + '不要重复第 ' + (_j2DupCalls.length + 1) + ' 次。',
            });
          } catch (_) {}
        }
        const _j2Pending = _j2FreshCalls.slice();
        let _j2Round = 0;
        const _J2_MAX_ROUNDS = 10;
        while (_j2Pending.length > 0 && _j2Round < _J2_MAX_ROUNDS) {
          _j2Round++;
          const _j2Ready = [];
          const _j2Still = [];
          for (const tc of _j2Pending) {
            const deps = Array.isArray(tc.params && tc.params.depends_on) ? tc.params.depends_on : [];
            if (deps.length === 0 || deps.every(d => _j2HasResult(d))) {
              _j2Ready.push(tc);
            } else {
              _j2Still.push(tc);
            }
          }
          if (_j2Ready.length === 0) {
            for (const tc of _j2Still) {
              const err = { ok: false, error: { code: ErrorCode.INVALID_ARGS, message: `[${tc.name}] depends_on cannot be resolved`, retryable: false, fallback_hint: getFallbackHint(ErrorCode.INVALID_ARGS) }, execution_ms: 0 };
              _j2SetExecResult(tc, err);
            }
            break;
          }
          for (let i = 0; i < _j2Ready.length; i += _j2BatchSize) {
            const _j2Batch = _j2Ready.slice(i, i + _j2BatchSize);
            const _j2Promises = _j2Batch.map(async (tc) => {
              let execResult;
              try {
                const sandboxCheck = checkToolCall(tc.name, tc.params);
                if (sandboxCheck && !sandboxCheck.ok) {
                  execResult = { ok: false, error: 'SANDBOX_BLOCKED: ' + (sandboxCheck.reason || sandboxCheck.message || 'sandbox denied') };
                }
                if (!execResult) {
                  execResult = await _execToolWithPermission(tc, _sessionId, res);
                }
              } catch (e) { execResult = { ok: false, error: e.message }; }
              return { tc, execResult };
            });
            const _j2BatchResults = await Promise.all(_j2Promises);
            for (const { tc, execResult } of _j2BatchResults) {
              _j2SetExecResult(tc, execResult);
            }
            // TL-1 §9: emit batch_complete SSE event (SOP 验证 3 要求)
            // Bug A 修 (2026-07-23 18:46): batch_id 全局递增, 跨多 round 不会都 batch=1
            const _j2BatchId = ++_j2BatchCounter;
            try {
              res.write('event: batch_complete\ndata: ' + JSON.stringify({
                round: _j2Round,
                batch: Math.floor(i / _j2BatchSize) + 1,
                batch_id: _j2BatchId,  // 全局递增 (Bug A 修)
                total: Math.ceil(_j2Ready.length / _j2BatchSize),
                completed: _j2BatchResults.length,
                mode: 'depends_on_aware',
                tool_names: _j2Batch.map(tc => tc.name),
              }) + '\n\n');
            } catch (e) {}
            // TL-1 SOP 验证 4: tool 启动时间戳 (SOP 期望 <50ms delta = 真 parallel)
            // Bug A 修: log 也带 batch_id 方便 grep
            for (const { tc } of _j2BatchResults) {
              const startTs = Date.now();
              console.log('[j2-batch] tool_start:', tc.name, 'ts=' + startTs, 'round=' + _j2Round, 'batch=' + (Math.floor(i / _j2BatchSize) + 1), 'batch_id=' + _j2BatchId);
            }
          }
          _j2Pending.length = 0;
          _j2Pending.push(..._j2Still);
        }
        // 保持原 for 循环顺序 (toolResults / permission_apply / res.write / exec_command auto-extract 等副作用)
        for (const tc of toolCalls) {
          const execResult = _j2ExecResults.get(_j2Ukey(tc));
          if (!execResult) continue;
          // #7: 不学教训 — exec_command 成功后自动提取发现到短期 memory hint (TL-1 改造后保留)
          if (tc.name === 'exec_command' && execResult && execResult.ok) {
            try {
              const mem = require('./memory').getInstance();
              if (mem) {
                const cmd = (tc.params && tc.params.command) || '';
                const stdout = (execResult.data && execResult.data.stdout) || '';
                // 提取 PATH / 绝对路径 / 版本信息
                const pathMatch = stdout.match(/(\/[^\s]+\/bin\/\w+)/);
                const versionMatch = stdout.match(/(\w+ version [\d.]+)/);
                if (pathMatch || versionMatch) {
                  const hint = { cmd: cmd.slice(0, 200), path: pathMatch ? pathMatch[1] : null, version: versionMatch ? versionMatch[1] : null, ts: Date.now() };
                  const key = 'hint_' + (pathMatch ? pathMatch[1].split('/').pop() : 'exec');
                  const _mw = mem.write(key, hint, { tags: ['hint', 'auto'] });  // 2026-08-02 修: memory.write 是同步的, 无 Promise 可 catch
                  if (_mw && typeof _mw.catch === 'function') _mw.catch(() => {});
                  console.log('[j2-native] auto memory hint:', key);
                }
              }
            } catch (e) { console.warn('[j2-native] auto memory hint failed:', e.message); }
          }
          // P0-#7: tool 返回后触发 self_correct (error 或可疑输出 → 标 plan_failed + SSE event:self_correct)
          // 2026-08-02: 只读探索工具 (read_file/list_directory/file_find/memory_search/session_recall)
          // 的 NOT_FOUND/空结果是"信息"不是"失败" — 触发 self_correct→plan_failed gate 是过度防御 (老板: 防御越狠出事越大)
          const _READONLY_TOOLS = ['read_file', 'list_directory', 'file_find', 'file_grep', 'memory_search', 'session_recall', 'search_files'];
          // 2026-08-02 修 (老板: 防御越狠出事越大): exec_command 真实跑完但 exit!=0 (ls 不存在的目录/find 没命中)
          // 是"信息"不是"失败" — 旧逻辑每次 exit 1 都 self_correct → plan_failed → gate → 重新规划, 一个会话造 4 个废 plan
          const _genuineExec = execResult && execResult.data && typeof execResult.data.exit !== 'undefined';
          // 2026-10-15: blocked=true 是**盘古自己的防重复守门** (:2397 DUPLICATE_TOOL_CALL),
          // 不是工具失败、也不是上游报错。现场 (实测 /message/stream): 模型重复调同一个工具
          // → 被守门拦下 → 这里判 incorrect → plan_failed → 工具被 gate 拦一次 →
          // 回灌 [SELF_CORRECT_FAIL] 逼模型重规划。一句话的活因此跑了 13 轮 / 168 秒,
          // 而且失败理由写成 "错误码 undefined" (见 tools/index.js self_correct)。
          // 本地守门的自我约束不该被当成工具故障再罚一次模型。
          const _shouldSelfCheck = execResult && (execResult.ok === false || (execResult.error || execResult.warning)) && !execResult.blocked && !_READONLY_TOOLS.includes(tc.name) && !_genuineExec;
          if (_shouldSelfCheck && tc.name !== 'self_correct' && tc.name !== 'plan_approve' && tc.name !== 'plan_reject' && tc.name !== 'task_done') {
            try {
              const scResult = await wrapToolResultWithHooks('self_correct', { tool_name: tc.name, original_result: execResult, plan_id: _state.planState && _state.planState.lastPlan ? _state.planState.lastPlan.plan_id : null }, async (params) => TOOLS['self_correct']({ context: { user: 'feng', sessionId: _sessionId }, params }));
              if (scResult && scResult.ok) {
                const verdict = scResult.result && scResult.result.verdict;
                const reason = scResult.result && scResult.result.reason;
                try { res.write('event: self_correct\ndata: ' + JSON.stringify({ tool: tc.name, verdict, reason, ts: Date.now() }) + '\n\n'); } catch (e) {}
                console.log('[self_correct] ' + tc.name + ' verdict=' + verdict + ' reason=' + (reason || '').slice(0, 80));
                if (verdict === 'incorrect') {
                  // 标 plan_failed (P0-#1 _state.planState 加 plan_failed flag)
                  _state.planState.plan_failed = true;
                  // 2026-07-27 P0 修 (Bug #3): self_correct 失败时强制给 LLM 明确指令, 别再循环
                  const _lastPlanId = (_state.planState.lastPlan && _state.planState.lastPlan.plan_id) || (_state.planState.pendingPlan && _state.planState.pendingPlan.plan_id) || 'unknown';
                  // 第 85 批: 攒着, 等 tool 结果回灌完再 push (见 _j2GuardMsgs 的注释)
                  _j2GuardMsgs.push({
                    role: 'system',
                    content: '[SELF_CORRECT_FAIL] tool=' + tc.name + ' verdict=incorrect reason=' + ((reason || '').slice(0, 200)) + '\n你现在必须立即做以下其中之一:\n  (a) 调 plan_approve({plan_id: "' + _lastPlanId + '"}) 接受当前 plan 继续\n  (b) 调 plan_reject({plan_id, reason: "..."}) 重新规划\n  (c) 改用其他工具 (同工具同参数再调一定失败, 系统会直接熔断)\n  (d) 调 task_done({status: "failed", reason: "..."}) 老实承认失败, 别再循环'
                  });
                  // 2026-07-26 老板拍: 内部诊断不再写进气泡 (下面 progress_failed 已在状态区显示)
                  // P0-#30: emit progress_failed
                  // 2026-09-17: severity 区分 — 真 plan 失败 = high, 正常 tool 失败 (NO_PATH 等) = low (不盖红警告)
                  const _severity = /NO_PATH|FILE_NOT_FOUND|MISSING_/.test(String(reason || '')) ? 'low' : 'high';
                  try { res.write('event: progress_failed\ndata: ' + JSON.stringify({ type: 'progress_failed', failed_step: tc.name, reason: reason || 'self_correct incorrect', severity: _severity, ts: Date.now() }) + '\n\n'); } catch (e) {}
                  break;  // 中断本 round tool 执行
                }
              }
            } catch (e) { console.warn('[self_correct] failed:', e.message.slice(0, 200)); }
          }
          toolsUsed.push(tc.name);
          toolHistory.push({ name: tc.name, args: tc.params });
          toolResults.push({ tc, execResult });
          _recordChartEvidence(tc.name, execResult);
          // 2026-10-16: 只读工具的成功结果存一份, 供同参数重读回放 (见 _j2ReadCache 处注释)。
          // 只存成功的 —— 失败结果重读一次是有意义的 (文件可能刚被创建/删掉)。
          if (execResult && execResult.ok && _READONLY_REPEAT_OK.has(tc.name) && !execResult._read_replayed) {
            try {
              _j2ReadCache.set(tc.name + '|' + _stableStringify(tc.params || {}), {
                data: execResult.data,
                at: Date.now(),
              });
            } catch (_) { /* 缓存失败不许影响主流程 */ }
          }
          _collectEvidence([{ tc, execResult }]);
          // P0-#30: emit progress (plan 触发后 N/M + ETA)
          if (_state.planState && _state.planState.lastPlan && Array.isArray(_state.planState.lastPlan.steps)) {
            try {
              const _total = _state.planState.lastPlan.steps.length;
              // 2026-08-05 修 (老板截图实证 "Progress 10/4 (100%)" 荒谬):
              // 旧逻辑 _current=toolsUsed.length (全部工具调用数) vs _total=计划步数,
              // 一步多次调用/计划外工具都会让分子超分母。正确语义: 已完成的计划步数,
              // 按工具名逐步核销 (min(计划该工具步数, 已调次数)), 天然封顶 total,
              // 重复工具步 (如 write_file×2) 也能正确计数。
              const _planned = {};
              for (const _s of _state.planState.lastPlan.steps) { const _t = _s && _s.tool; if (_t) _planned[_t] = (_planned[_t] || 0) + 1; }
              // 2026-09-17 老板拍: 把"第 N/M 步"从纯工具步升级成"哪一卦在推": 查当前 tool 对应的将灵(卦)
              const _CODE_TO_GUA = (() => { try { return require('./subagent_runs').CODE_TO_GUA; } catch (_) { return {}; } })();
              const _agentForTool = _guaToolToAgent;   // 本块内的旧叫法, 指向同一份反查
              const _guaForTool = (tool) => { const c = _agentForTool(tool); return c ? (_CODE_TO_GUA[c] || null) : null; };
              const _usedCnt = {};
              for (const _t of toolsUsed) _usedCnt[_t] = (_usedCnt[_t] || 0) + 1;
              let _current = 0;
              for (const _t of Object.keys(_planned)) _current += Math.min(_planned[_t], _usedCnt[_t] || 0);
              const _percent = _total > 0 ? Math.min(100, Math.round((_current / _total) * 100)) : 0;
              // ETA: 算已完成 tool 平均耗时, 估剩余
              const _avgMs = _current > 0 ? (Date.now() - _state.planState.startedAt) / _current : 1000;
              const _etaMs = Math.max(0, Math.round((_total - _current) * _avgMs));
              // 2026-09-17 全修: progress 100% 但本轮还有剩余步骤 (plan 未完成) → 显示 "部分完成" 而非 "done"
              // 旧 bug: _percent=100 就 emit progress_done → 前端盖 ✅ 100%, 但 model 下一段还在说 "下一步待你拍"
              const _planRemaining = _total > _current ? (_total - _current) : 0;
              res.write('event: progress\ndata: ' + JSON.stringify({
                type: 'progress',
                current: _current,
                total: _total,
                calls: toolsUsed.length,
                percent: _percent,
                eta_ms: _etaMs,
                current_step: tc.name,
                current_agent: _agentForTool(tc.name),
                current_gua: _guaForTool(tc.name),
                remaining: _planRemaining,
                ts: Date.now(),
              }) + '\n\n');
              if (_percent >= 100 && _planRemaining === 0) {
                res.write('event: progress_done\ndata: ' + JSON.stringify({ type: 'progress_done', total_duration_ms: Date.now() - _state.planState.startedAt, ts: Date.now() }) + '\n\n');
              }
            } catch (e) { console.warn('[progress] emit failed:', e.message.slice(0, 200)); }
          }
          try { res.write('event: tool_result\ndata: ' + JSON.stringify({ name: tc.name, params: tc.params, ok: !!(execResult && execResult.ok), result: execResult, id: tc.id }) + '\n\n'); } catch (e) {}
          // 2026-09-22: 主循环直接跑时也挂出"哪个将灵在干活" — 工具结果出来即映射到职能角色
          // (无 plan 的普通请求也看得到"正在读/正在写/正在验"), 治截图里黑箱体验
          try {
            const _CODE2GUA2 = (() => { try { return require('./subagent_runs').CODE_TO_GUA || {}; } catch (_) { return {}; } })();
            // 与上面共用同一份反查 (2026-10-18)。这张表以前是**第二份手抄**, 值还是英文 ——
            // 前端拿 agent 字段去 findGua 匹配将灵卡片, 英文一律匹配不上, 于是
            // "哪个将灵在干活"这个指示**从来不亮**。
            const _agentCode = _guaToolToAgent(tc.name);
            if (_agentCode) {
              res.write('event: active_agent\ndata: ' + JSON.stringify({
                agent: _agentCode,
                gua: _CODE2GUA2[_agentCode] || null,
                tool: tc.name,
                ok: !!(execResult && execResult.ok),
                ts: Date.now(),
              }) + '\n\n');
            }
          } catch (_) {}
          // P0-#29: file_edit / file_edit_batch → emit SSE event:diff / event:diff_batch
          // 即使 sandbox 拦截 (ok=false), 也 emit diff 让前端看到拦截信息
          if (tc.name === 'file_edit') {
            const d = (execResult && execResult.data) || {};
            try { res.write('event: diff\ndata: ' + JSON.stringify({
              file: d.file || d.path || (tc.params && tc.params.path) || '',
              diff: d.diff || (execResult && execResult.ok === false ? '⚠️ Edit failed: ' + (execResult.error?.message || '') : ''),
              before: d.before || '',
              after: d.after || '',
              changes: d.changes || 0,
              ok: !!(execResult && execResult.ok),
              ts: Date.now(),
            }) + '\n\n'); } catch (e) {}
            if (execResult && execResult.ok) console.log('[diff] file:', d.file || d.path, 'changes:', d.changes || 1);
            else console.log('[diff] file_edit failed:', (execResult && execResult.error && execResult.error.message) || '');
          }
          if (tc.name === 'file_edit_batch' && execResult && execResult.ok && execResult.data && Array.isArray(execResult.data.diffs)) {
            const diffs = execResult.data.diffs;
            try { res.write('event: diff_batch\ndata: ' + JSON.stringify({
              files_changed: diffs.map(x => x.file),
              diffs: diffs.map(x => ({ file: x.file, diff: x.diff, before: x.before, after: x.after, changes: x.changes })),
            }) + '\n\n'); } catch (e) {}
            console.log('[diff_batch]', diffs.length, 'files');
          }
          // P0-#29: file_edit_batch 拦截 → emit warning diff_batch
          else if (tc.name === 'file_edit_batch' && execResult && execResult.ok === false) {
            try { res.write('event: diff_batch\ndata: ' + JSON.stringify({
              files_changed: [],
              diffs: [],
              ok: false,
              warning: '⚠️ file_edit_batch failed: ' + (execResult.error?.message || 'unknown'),
            }) + '\n\n'); } catch (e) {}
          }
          // P0-#29: git_diff tool → emit SSE event:diff
          if (tc.name === 'git_diff' && execResult && execResult.ok && execResult.result) {
            const d = execResult.result;
            try { res.write('event: diff\ndata: ' + JSON.stringify({
              file: d.files && d.files[0] ? d.files[0].path : 'git_diff',
              diff: d.diff || '',
              before: '',
              after: '',
              changes: d.files_changed || 0,
              ts: Date.now(),
            }) + '\n\n'); } catch (e) {}
            console.log('[diff] git_diff files_changed:', d.files_changed || 0);
          }
          // #14: permission_apply 成功 → 标记待 verify
          if (tc.name === 'permission_apply' && execResult && execResult.ok) {
            permissionGranted = true;
          }
        }

 // #14: verify-after-allow — permission_apply 成功后自动调一次 take_photo 验证
        if (permissionGranted && !toolsUsed.includes('take_photo')) {
          try {
            const verifyResult = await wrapToolResultWithHooks('take_photo', {}, async (params) => TOOLS['take_photo']({ context: { user: 'feng', sessionId: _sessionId }, params }));
            toolsUsed.push('take_photo');
            toolResults.push({ tc: { name: 'take_photo', id: 'verify_' + Date.now() }, execResult: verifyResult });
          _collectEvidence([{ tc: { name: 'take_photo' }, execResult: verifyResult }]);
            try { res.write('event: tool_result\ndata: ' + JSON.stringify({ name: 'take_photo', ok: !!(verifyResult && verifyResult.ok), result: verifyResult, id: 'verify' }) + '\n\n'); } catch (e) {}
            if (verifyResult && verifyResult.ok) {
              // 2026-10-17: 这里原来推的是 { role:'tool', tool_call_id:'verify' } ——
              // 同一个 P0 的第二处。'verify' 根本不在 assistant.tool_calls 里, 而上游是按
              // tool_call_id 一一配对校验的: 模型发了 N 个 tool_call, 收到 N 条 tool 消息之后
              // 又来第 N+1 条、id 还是个不存在的 'verify' → 同样会撞
              // "tool call and result not match" (2013), 整轮作废。
              // 而且这条 take_photo 是**盘古自己**在 permission_apply 之后发起的, 模型压根没要求过,
              // 它不占任何 tool_call 槽位 —— 所以正确做法根本不是"回灌 tool 结果",
              // 而是当一条普通通知告诉模型"权限已生效, 我已验证过"。
              // 结果本身已经通过 SSE tool_result 发给前端, 也进了 _collectEvidence, 不丢信息。
              if (!isAnthropic) {
                // 第 85 批: 攒着, 等 tool 结果回灌完再 push (见 _j2GuardMsgs 的注释)
                _j2GuardMsgs.push({
                  role: 'system',
                  content: '[PERMISSION_VERIFIED] permission_apply 已生效, 盘古自动执行了一次 take_photo 验证并成功。'
                    + '后续命令可以直接跑, 不需要再申请权限。'
                });
              }
            }
          } catch (e) { console.warn('[j2-native] verify-after-allow take_photo failed:', e.message); }
        }

 // BugA: 连续失败检测 — 同一工具连续失败 2 次 → 注入 system warning
        const toolFailureCount = {};
        // 2026-07-27 P0 修 (Bug #2): 跨 round (tool+args) 去重, 失败 2+ 次强制熔断
        for (const { tc, execResult } of toolResults) {
          const ok = execResult && execResult.ok !== false;
          if (!ok) {
            const _key = tc.name + '|' + _stableStringify(tc.params || {});
            const _prev = _crossRoundToolFails.get(_key) || 0;
            _crossRoundToolFails.set(_key, _prev + 1);
          }
          // §1.2 fix: 全调用计数 (不论成败)
          const _callKey = tc.name + '|' + _stableStringify(tc.params || {});
          const _callPrev = _crossRoundToolCalls.get(_callKey) || 0;
          _crossRoundToolCalls.set(_callKey, _callPrev + 1);
        }
        const _crossRepeatWarnings = [];
        // 2026-10-17 (现场 q-1792192247770#sub-0-analyzer, 21 轮 / 80 秒):
        //   这段原来**每轮**给每个 count>=2 的 key 推一条新的 system 消息 ——
        //   count=2 推"已被调用 2 次"、count=3 再推"已被调用 3 次"…… 累积下来,
        //   r21 的 53 条消息里塞了 **11 条** [READONLY-LOOP], 占 21%。
        //   两条害处, 都比"啰嗦"严重:
        //     ① 上下文被同一条告警灌满, 每轮 prefill 都为它付钱 (本地 27B 尤其致命)
        //     ② 旧文案是**反收敛**的 —— "这不是死循环…别放弃, 换个 offset 继续读",
        //        每一轮都在催模型接着读。模型于是从 r3 读到 r21 才收手。
        //   修法: 每个 key 有上限地推 (2/4 两级, 各一次), 且话术改成**收敛**方向。
        //   2026-09-16 那条"压缩会导致合法重读"的理由仍然成立, 放进新文案的后半句。
        const _j2RepeatWarned = _j2RepeatWarnedKeys;
        const _pushWarnOnce = (key, level, text) => {
          const wk = key + '@' + level;
          if (_j2RepeatWarned.has(wk)) return false;
          _j2RepeatWarned.add(wk);
          _crossRepeatWarnings.push(text);
          return true;
        };
        for (const [key, count] of _crossRoundToolFails.entries()) {
          if (count >= _CROSS_ROUND_FAIL_LIMIT) {
            const _toolName = key.split('|')[0];
            _pushWarnOnce(key, count, '[HARD] ' + _toolName + ' 已失败 ' + count + ' 次 (跨 round, 同参数). 必须立即: 1) 改 args 2) 换工具 3) task_done 报错. 不再允许调 ' + _toolName + ' 同 args.');
          }
        }
        // §1.2 fix: 同 (tool,args) 全调用 > 3 次也熔断 (上游拒收但本地 ok 的场景, 体感断流)
        // 2026-09-12 修 (e2e 实战): 警告阈值 1→2 — 硬阻断 (_CROSS_ROUND_CALL_LIMIT=1) 管 verbatim 重复执行,
        // 但警告在首次调用后就吼"已被调用 1 次同参数·强制熔断", 不同参数的探索性调用也天天挨吼,
        // 模型被吓得提前收尾 (e2e 实案: 3 次 exec_command 探索后放弃)。只在真重复 (≥2) 时警告。
        for (const [key, count] of _crossRoundToolCalls.entries()) {
          if (count >= 2) {
            const _toolName = key.split('|')[0];
            // 2026-09-16 老板实案: 只读类工具 (read_file/list_directory) 重读同路径常因压缩/换 offset 触发,
            // 这不是死循环, 不该被当成要人接管的强制熔断 — 文案降级为提示, 允许换个 offset 继续读。
            const _isReadonlyLoop = ['read_file','list_directory','file_find','file_grep','memory_search','session_recall','search_files'].includes(_toolName);
            if (_isReadonlyLoop) {
              // 收敛话术: 先劝"用已经拿到的内容收尾", 把"确实需要再读"的例外留给压缩场景。
              // 旧文案反过来 ("别放弃, 继续读") —— 现场 21 轮就是这么被它催出来的。
              const _level = count >= 4 ? 2 : 1;
              _pushWarnOnce(key, _level, '[READONLY-LOOP] ' + _toolName + ' 这份内容你已经读到过 '
                + count + ' 次了。**先别再读, 用已经拿到的内容把答案收尾。**'
                + (count >= 4
                  ? ' 已重复多次仍不收口 —— 现在就给结论, 缺的证据在答案里写明"未获取", '
                    + '不许继续摸文件 (只有当上一份内容被上下文压缩挤掉了, 才值得再读一次)。'
                  : ' 只有当上一份内容已被压缩挤出上下文时, 才需要再读一次。'));
            } else {
              _pushWarnOnce(key, count, '[HARD-LOOP] ' + _toolName + ' 已被调用 ' + count + ' 次同参数. 强制熔断: 1) 必须改 args (即使上次返回了内容, 这次再调也是重复) 2) 或换工具 3) 或 task_done 告知用户「这条命令已重试过多, 请人工介入」. 再调一次上游必 2013.');
            }
          }
        }
        if (_crossRepeatWarnings.length > 0) {
          // 第 85 批: 攒着, 等 tool 结果回灌完再 push (见 _j2GuardMsgs 的注释)
          _j2GuardMsgs.push({ role: 'system', content: _crossRepeatWarnings.join('\n') });
          try { res.write('event: tool_loop_alarm\ndata: ' + JSON.stringify({ warnings: _crossRepeatWarnings, ts: Date.now() }) + '\n\n'); } catch (_) {}
        }
        for (const { tc, execResult } of toolResults) {
          const ok = execResult && execResult.ok !== false;
          if (!ok) {
            const name = tc?.name || 'unknown';
            toolFailureCount[name] = (toolFailureCount[name] || 0) + 1;
          }
        }
        for (const [toolName, count] of Object.entries(toolFailureCount)) {
          if (count >= 2) {
            // 第 85 批: 攒着, 等 tool 结果回灌完再 push (见 _j2GuardMsgs 的注释)
            _j2GuardMsgs.push({
              role: 'system',
              content: '[SYSTEM WARNING] Tool ' + toolName + ' failed ' + count + ' time(s) in this batch. Do not retry the same tool. Switch to a different approach or inform the user.'
            });
          }
        }
        // 2026-10-23 (第 73 批, 实跑现场 request-1792769303516-b1fe3a):
        //   native 路径 (实测主路) 此前**没有**这道空转守门 —— 它只装在 legacy 分支。
        //   实跑「1990年3月15日生男，今天适不适合把手上这个项目的第一步做掉？给个决断。」:
        //     exec_command → node -e "require('sxtwl')" → MODULE_NOT_FOUND (sxtwl 是 Python 包)
        //     exec_command → find sxtwl → 空输出
        //     exec_command → 再试一次
        //   200 秒不出 final, nativeRounds=5 才收口。
        //   既有三道闸门都拦不住: DUPLICATE_TOOL_CALL / _CROSS_ROUND_FAIL_LIMIT 都按
        //   "工具名|参数" 分桶, 而模型**每次换参数** —— 桶永远不同, 永远不触发。
        //   唯一按工具名记的那道 (legacy 的) 又不在本路上。
        //
        //   判定逻辑已收成唯一真源 (tool_spin_guard.js), 与 legacy 共用同一份阈值和文案。
        //   这里只做接线: 记账 → 判定 → 回灌停止指令 → 清零 (清零是"这一轮已经喊过了",
        //   避免每一轮都推同一句)。写盘/编辑/验收有进展时不触发 (合法多调用不误伤)。
        //
        //   记账要把**结果**一起给守门 (note(calls, results)): 新增的 R2 规则
        //   (同一个工具连吃两个空 = 这条路走不通) 只看调用次数是分不出来的 ——
        //   读 5 个文件也是"5 次", 但每个都有内容, 那不是空转。
        try {
          _spinGuard.note(
            toolCalls.map((tc) => (tc && tc.name) ? { name: tc.name } : null).filter(Boolean),
            toolResults,
          );
          const _saidAnythingNow = messages.some((m) => m && m.role === 'assistant'
            && typeof m.content === 'string' && m.content.trim().length > 0);
          const _spin = _spinGuard.check({ saidAnything: _saidAnythingNow, toolsUsed });
          if (_spin) {
            console.warn('[j2-native] TOOL_SPIN_GUARD: 工具空转 (' + _spin.spammed.join('、')
              + '), 已回灌停止指令');
            // 第 85 批: 攒着, 等 tool 结果回灌完再 push (见 _j2GuardMsgs 的注释)
            _j2GuardMsgs.push({ role: 'system', content: _spin.message });
            try {
              res.write('event: tool_loop_alarm\ndata: ' + JSON.stringify({
                warning: '工具空转, 已回灌停止指令', tools: _spin.spammed, ts: Date.now(),
              }) + '\n\n');
            } catch (_) {}
            _spinGuard.reset(_spin.spammed);
          }
        } catch (_) {}

        // 回灌 messages (下一轮 LLM 看结果)
        //
        // 2026-10-17 P0 (现场 session stk-1792179831955#sub-0-analyzer, 主线 bug 不是"工具调不到"):
        //   问「查一下英伟达现在的股价」→ 16.5s 零工具的假象, 真相是:
        //     [smoke-hook-Post] web_fetch ok=true   ← stooq 那条**真拿到了行情**
        //     [self_correct]  web_fetch verdict=incorrect (Yahoo 403 那条被判失败)
        //     break;                                ← 消费循环当场中断
        //   → 后面那几条 tool **根本没进 toolResults**, 而回灌循环遍历的是 toolResults,
        //     于是推了 0 条 tool 消息, messages 停在 assistant(tool_calls:[2 个]),
        //     上游 OpenAI 兼容校验直接拒: HTTP 400 invalid params,
        //     tool call and result not match (2013) → 整轮作废 → finalText len: 0
        //   → 外面看到的就是"本轮查询工具未执行, 不能编价格" — 工具明明跑过了, 是回灌把它吃了。
        //
        // 根因: 回灌的**驱动源**选错了。契约在 assistant.tool_calls 上 (上游按 tool_call_id 一一配对),
        // 不在 toolResults 上。toolResults 只是"哪些结果已经处理完"的中间集合, 它可以被 break /
        // continue / 熔断截断, 不能当驱动源。
        //
        // 修法: 以 toolCalls 为准逐条回灌, toolResults 只提供内容。缺的那条补一条显式的
        // "未执行"结果 (带原因) —— 既保住上游契约, 又让模型知道这条是被自家闸门掐掉的,
        // 而不是"这条不存在", 免得它重发同一条调用再撞一次。
        //
        // 判据来自现场, 不是想象: 上面的 SELF_CORRECT_FAIL 分支明确 `break` 中断本 round,
        // 但回灌侧没有任何补偿 —— 这条路径 100% 必现 (Yahoo 403 + stooq 成功 = 必现组合)。
        const _j2FinalResult = new Map();   // tool_call_id → 最终回灌内容 (消费过的 + 补位的, 唯一真源)
        const _j2Backfill = [];
        // 先收消费循环已经处理完的
        for (const { tc, execResult } of toolResults) {
          if (tc && tc.id != null && !_j2FinalResult.has(tc.id)) _j2FinalResult.set(tc.id, execResult);
        }
        // 再按 toolCalls 逐条补齐缺口 —— 这是修复的核心: 驱动源是 toolCalls, 不是 toolResults
        for (const tc of toolCalls) {
          if (!tc || tc.id == null || _j2FinalResult.has(tc.id)) continue;
          // 按 tool_call_id 取, 不按 _j2Ukey 推算 (见 _j2ResultByCallId 处的注释:
          // 序号在回灌阶段重新分配会撞名, 静默拿到别人的结果)。
          const _execResult = _j2ResultByCallId.get(tc.id);
          if (_execResult != null) {
            // 执行过、只是消费循环没轮到 (break 截断) —— 结果原样给它, 不浪费一次真调用。
            _j2FinalResult.set(tc.id, _execResult);
            toolResults.push({ tc, execResult: _execResult });
            _recordChartEvidence(tc.name, _execResult);
            // toolsUsed 在消费循环里累加, break 之后那几条不会被计上 → 指标少报、
            // 跨轮去重也漏记。回灌既然补回来了, 记账也得跟上, 否则 ledger 和实际调用对不上。
            if (!toolsUsed.includes(tc.name)) toolsUsed.push(tc.name);
            toolHistory.push({ name: tc.name, args: tc.params });
          } else {
            // 真没执行 (被熔断 / 权限拒 / 预算拒, 或 break 发生在它之前且它压根没跑)。
            // 说清是哪一类, 否则模型只会觉得"工具不存在", 转头重发同一条。
            _j2FinalResult.set(tc.id, {
              ok: false,
              error: {
                code: 'TOOL_RESULT_MISSING',
                message: tc.name + ' 本轮未执行: 同一批里有别的工具触发了熔断/自我纠错, 本条被连带中断, '
                  + '不是这条工具不存在。别重复发同一条调用 —— 先按上面 SYSTEM WARNING 的要求处理, 或者换一条路拿数据。'
              }
            });
            // 只补 toolResults (模型要看到"这条没了"), **不**补 toolsUsed ——
            // 它压根没执行, 计进 toolsUsed 会虚报 real_tool_calls_total, 而那个数字
            // 正是用来判"模型到底调没调工具"的, 虚报就把真问题盖住了。
            toolResults.push({ tc, execResult: _j2FinalResult.get(tc.id) });
            _j2Backfill.push(tc.name);
          }
        }
        if (_j2Backfill.length > 0) {
          console.warn('[j2-native] TOOL_RESULT_MISSING: 本批 ' + toolCalls.length + ' 个 tool_call 里 '
            + _j2Backfill.length + ' 条没有结果 (熔断/权限/预算连带中断), 已补占位结果保住上游配对契约'
            + ' — ' + _j2Backfill.join(','));
        }
        if (!isAnthropic) {
          // OpenAI format: assistant message 上面 push 过了, 这里 push 每个 tool result。
          // 2026-10-17: 严格按 toolCalls 顺序遍历 (不是 toolResults 顺序) —— 上游按 tool_call_id
          // 配对, 顺序虽然不是硬要求, 但保持与 assistant.tool_calls 一致最省心, 也好复现。
          for (const tc of toolCalls) {
            if (!tc || tc.id == null || !_j2FinalResult.has(tc.id)) continue;
            const _er = _j2FinalResult.get(tc.id);
            messages.push({ role: 'tool', tool_call_id: tc.id, content: typeof _er === 'string' ? _er : _fitToolResult(_er) });
          }
        } else {
          // Anthropic: tool_result content blocks in user message
          const blocks = toolCalls
            .filter(tc => tc && tc.id != null && _j2FinalResult.has(tc.id))
            .map(tc => ({
              type: 'tool_result',
              tool_use_id: tc.id,
              content: (() => { const _er = _j2FinalResult.get(tc.id); return typeof _er === 'string' ? _er : _fitToolResult(_er); })()
            }));
          messages.push({ role: 'user', content: blocks });
        }
        // 2026-10-25 (第 85 批): tool 结果回灌完了, 现在才把本轮的守门提示补上 ——
        // 位置在**结果之后**, 上游契约才成立 (tool 结果必须紧跟它的 assistant)。
        // 顺序语义也更好: 模型先看到结果, 再看守门的话。
        for (const _gm of _j2GuardMsgs) {
          messages.push(_gm);
        }
        // 2026-08-02 反幻觉钩子② (RTF 11:24 实案: exec_command 失败后盘古不读 stdout 原文,
        // 凭印象编 "沙箱关了/权限没开" — 真根因是 cwd 套娃, 跟沙箱零关系):
        // 本批有失败/空结果 → 钉死: 只许引用原始输出, 禁止推测原因
        try {
          const _badResults = toolResults.filter(({ execResult }) => {
            if (!execResult) return true;
            if (execResult.ok === false) return true;
            const _s = typeof execResult === 'string' ? execResult : JSON.stringify(execResult);
            return !_s || _s === '{}' || _s === 'null' || _s === '""';
          });
          if (_badResults.length > 0) {
            const _names = _badResults.map(({ tc }) => (tc && tc.name) || 'unknown').join(', ');
            messages.push({ role: 'system', content: '[SYSTEM WARNING] 刚才 ' + _badResults.length + ' 个工具失败或空输出 (' + _names + ')。反幻觉铁律: 分析原因时只允许引用工具返回的原始 error/stdout/stderr 文本, 禁止推测 "沙箱/权限/网络/路径/不存在" 等原因 — 除非原始输出里明说了。原始输出没说 = 原因未知, 继续换方法查证, 不许编。' });
          }
        } catch (_) {}
        // A user can send a continuation while this round is still working.
        // Persist the assistant tool call and its returned results together so
        // the next request resumes from evidence, rather than guessing what
        // was completed before the abort.
        try {
          const last = toolResults[toolResults.length - 1];
          _persistSession(_sessionId, messages, {
            round: round + 1,
            state: 'active',
            task_input: userInput,
            plan_state: _state.planState || null,
            lastToolCall: last && last.tc ? { name: last.tc.name, params: last.tc.params || {} } : null,
          });
        } catch (_) {}
        // 2026-09-12 e2e 实战修: native 末轮工具执行完直接 continue → round++ 越界静默出循环,
        // 永远够不到任何续跑检查 (e2e 实案 resume10: 3 轮 6 工具全干完, 没 task_done,
        // Silent Failure 收场, auto_resume 0 次)。legacy 轮末有 maxRounds_reached 续跑块 (L2088),
        // native 没有 — 补上对称检查。
        if (round === maxRounds - 1 && !taskDoneAccepted) {
          const _resumed = await _tryAutoResume('native_maxRounds_reached');
          if (_resumed) { round = -1; continue; }
        }
        // 持续下一轮
        continue;
      }
      // ================ LEGACY XML PATH (fallback — Pangu 老 J2 模型不支持 native tool calls) ================
    } catch (e) {
      // R17 修 (P0-A): native 主循环 throw — 必须 break, 否则同 exception 每轮静默重试烧 maxRounds
      // (2026-08-23 Node 模拟: 5 rounds 持续 throw 全部进入此 catch, 沉默烧完)
      // 注: 'try 块结束 for 循环必然结束' 是错的 — try/catch 完成 ≠ for 循环结束, 必须显式 break
      // (其他 3 处 catch — inner LLM L647 / stream L1535 / legacy L1706 — 都正确使用 break)
      console.error('[j2-native] loop error:', e.message, 'phase: native-loop');
      evoError = e.message; evoSuccess = false;  // 与 legacy catch (L1706) 对齐, 下游 observability
      break;
    }
  }

  // 2026-07-26 修 (同上 6 分钟绕圈): legacy 循环之前无条件紧跟 native 循环跑 —
  // native 已 break 收口后 legacy 又烧 5 轮 (MiniMax 每轮 ~50s + 空 stream) → 加 !useNative 守卫
  for (let round = 0; !useNative && round < maxRounds; round++) {
    _legacyRounds++;
    // 2026-10-22: 轮首清停点 —— 与 native 路径 (上方) 同一机制。
    //   legacy 不能省: native 每轮写 checkpoint 会顺手覆盖, legacy 一轮都不写。
    try { require('./stop_point').clearStopPoint(_sessionId); } catch (_) {}
    // TL-6: 每 round 前 shouldCompact (早压缩早省 token, 防 §0.31 silent failure)
    const _scSessionId = opts.sessionId || (opts.reqBody && opts.reqBody.session_id) || 'default';
    // 每 round 都 register (legacy + native path 都覆盖)
    try { _compactor.register(_scSessionId, messages); } catch (_) {}
    // 2026-09-17 老板拍: 80% 硬压缩线 (legacy 路径同 native) — 尽量拿 model ctx, 拿不到用 80% × 默认 128K 兜底
    let _modelCtxL = null;
    try {
      const _mL = (opts && opts.model) || (_deps && typeof _deps.getCurrentModel === 'function' ? _deps.getCurrentModel() : null);
      if (_mL && Number.isFinite(_mL.context_length)) _modelCtxL = _mL.context_length;
      else if (_deps && typeof _deps.getModelContextLength === 'function' && _mL) _modelCtxL = _deps.getModelContextLength(_mL);
    } catch (_) {}
    const _hardCtxL = _modelCtxL || 128000;
    const _hardCompactHitL = _compactor.sessions.get(_scSessionId)
      && ((_compactor.sessions.get(_scSessionId).tokenCount || 0) >= Math.floor(_hardCtxL * 0.8));
    if (rounds > 1 && (_compactor.shouldCompact(_scSessionId) || _hardCompactHitL) && messages.length > 10) {
      try {
        // 2026-08-02 修: 光判断不调用 — result/before 从未定义, compact 永远走 catch (result is not defined)
        const before = messages.length;
        const result = await _compactor.compact(_scSessionId);
        if (result && result.compactedMessages) {
          messages = result.compactedMessages;
          console.log(`[session-compaction] ${_scSessionId}: ${before} -> ${messages.length} msgs, ratio ${result.compactRatio}`);
          try { res.write('event: compaction\ndata: ' + JSON.stringify({
            from: before,
            to: messages.length,
            summary_chars: (result.summary && typeof result.summary === 'string') ? result.summary.length : (result.summary ? JSON.stringify(result.summary).length : 0),
          }) + '\n\n'); } catch (_) {}
        }
      } catch (e) { console.warn('[session-compaction] compact failed:', e.message); }
    }
    try {
 // J2 优化 2 : 真流式输出 — 实时 yield chunk, 工具块提前 break
      let textContent = '';
      let yieldedLen = 0;
      let inToolBlock = false;
      let toolBlockCompleted = false;
      // 第 88 批 (2026-10-25): legacy 路**从来没有**「只回思考」检测 ——
      //   native 路有 (_hasReasoningOnly, 2680 行), legacy 路一路没有。
      //   而 llm_caller 的流层在「整条流零 content」时会把 reasoning 缓冲**当正文 yield 出来**
      //   (2026-07-28 的 compat, 为了不让只回 reasoning_content 的模型流直接全废),
      //   于是 legacy 路的思考直接进了 textContent ⇒ **可以变成最终答复**。
      //   ⇒ 这里接上 llm_caller 早就有的 `opts.onReasoningOnly(chars)` 契约 (第 86 批加的),
      //     把这个事实如实接住 —— 不靠「文本像不像思考」猜 (那是第 83-85 批一路在治的病)。
      let _streamReasoningOnly = false;
      let _streamReasoningChars = 0;
      let sseStartTime = Date.now();
      let firstChunkSentAt = null;
      try {
        let j2StreamAttempts = 0;
        const MAX_J2_STREAM_ATTEMPTS = 2;
    // #1 状态喷泉根因修复 (接 b4eb1b8 cosmetic fix 之后)
 // 实测 任务: LLM 幻觉"我正在..."时, 单 round textContent 跑出 7882+ 字符
        // 硬护栏: 单 round 文本超过 MAX_NO_TOOL_STREAM_CHARS 且未出现 <tool> → 切断流, 发 STATUS_FOUNTAIN 警告
        const MAX_NO_TOOL_STREAM_CHARS = 4000;
        let _fountainWarnSent = false;
        // R16 修 (Bug D — stream 路径裸奔, 老板 7/25 11:23 截图 45.8s 卡住的直接元凶):
        // 加 AbortController + req.close 监听, stream 超时熔断
        const _streamAbort = new AbortController();
        // §0.57: session abort 联动 stream abort — 新问题触发 _sessionAbort 时, 同步 abort 本轮 stream
        if (_sessionAbort && _sessionAbort.signal) {
          if (_sessionAbort.signal.aborted) {
            _streamAbort.abort('user_switched');
          } else {
            _sessionAbort.signal.addEventListener('abort', () => {
              console.warn('[j2-boundary] §0.57 session abort → stream abort sid=' + _sessionId);
              try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '问题边界: 新问题已到达, 旧 round 中断.' }) + '\n\n'); } catch (_) {}
              _streamAbort.abort('user_switched');
            });
          }
        }
        // §1.3 fix (Prime Agent 风格: 闲置超时而非总超时): 模型慢但还在吐 chunk 不该被砍
        // R18 30s 总超时太短, minimax-m3 慢模型首 chunk 60s+ 经常误杀
        // 改: 闲置超时 (idle) = round timeout, 总超时 = round timeout × 4 (兜底)
        const _idleTimeoutMs = _resolveRoundTimeoutMs(model);  // 单次 chunk 间隔上限 (默认 30s 云 / 120s 本地)
        const _totalTimeoutMs = _idleTimeoutMs * 4;             // 整轮总上限兜底
        let _idleTimer = null;
        const _totalTimer = setTimeout(() => {
          console.warn('[j2-stream] §R18-total timeout after ' + _totalTimeoutMs + 'ms, abort');
          try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'R18-total: 整轮 ' + _totalTimeoutMs + 'ms 超时, abort.' }) + '\n\n'); } catch (e) {}
          if (_idleTimer) clearTimeout(_idleTimer);
          _streamAbort.abort();
        }, _totalTimeoutMs);
        const _armIdle = () => {
          if (_idleTimer) clearTimeout(_idleTimer);
          _idleTimer = setTimeout(() => {
            console.warn('[j2-stream] §R18-idle timeout after ' + _idleTimeoutMs + 'ms 无 chunk, abort');
            try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'R18-idle: 闲置 ' + _idleTimeoutMs + 'ms 无 chunk, abort. 可能模型卡住.' }) + '\n\n'); } catch (e) {}
            clearTimeout(_totalTimer);
            _streamAbort.abort();
          }, _idleTimeoutMs);
        };
        _armIdle();  // 启动时 arm 一次
        if (req && typeof req.on === 'function') {
          // IncomingMessage `close` can fire when the request body lifecycle
          // completes; it is not proof that the browser abandoned the SSE
          // response. Abort only on the explicit aborted signal, and keep a
          // guarded close listener for runtimes that expose `aborted` late.
          const abortFromClient = () => {
            userAborted = true;
            console.log('[j2-stream] §R16 req aborted by client, abort');
            if (_idleTimer) clearTimeout(_idleTimer);
            clearTimeout(_totalTimer);
            _streamAbort.abort('client_aborted');
          };
          req.on('aborted', abortFromClient);
          req.on('close', () => { if (req.aborted === true) abortFromClient(); });
        }
        while (j2StreamAttempts <= MAX_J2_STREAM_ATTEMPTS) {
          j2StreamAttempts++;
          // textContent 用 outer (line 1361), 不再 shadow  ← 2026-08-23 R16 根因修
          let yieldedLen = 0;
          let inToolBlock = false;
          let toolBlockCompleted = false;
          let sseStartTime = Date.now();
          let firstChunkSentAt = null;
          let streamError = null;
          // prefill 进度条 (2026-10-16): 首个 delta 之前上游一个字节都不给, 实测
          // 一句话问题要死寂 41 秒 (11,000 token ÷ ~285 tok/s)。注释行 keepalive 保得住
          // 连接但界面全黑, 这一层发的是**渲染得出来**的进度事件。
          // 声明在 while 之外: 重试换模型时上一轮的定时器必须先被 finally 停掉。
          let _prefillStop = null;
          // 2026-08-22: 单回合内 delta 死循环守卫状态
          let _deltaRepeatCount = 0;
          let _deltaRepeatLast = '';
          let _deltaRepeatWarnSent = false;
          // 2026-08-23 R16 根因修: 删掉 inner let textContent (覆盖 outer, stream delta 累积后被销毁)
          // 现在累积到 outer textContent, fallback 路径 textContent 也能拿到值
          try {
            // 2026-09-16 开源默认=省钱: 流式路径同样接长上下文降级
            let _activeModel2 = model;
            try {
              const _lcf2 = require('./longctx_fallback');
              const _resolved2 = _manualModelSelection
                ? { model, downgraded: false, reason: 'manual-model-selection' }
                : _lcf2.resolveModel((_deps && _deps._config) || {}, model, messages.length, _state.longctxDowngraded || [], _estimateInputTokens(messages));
              if (_resolved2.downgraded) {
                _state.longctxDowngraded = _state.longctxDowngraded || [];
                if (!_state.longctxDowngraded.includes(_resolved2.model.id)) _state.longctxDowngraded.push(_resolved2.model.id);
                _activeModel2 = _resolved2.model;
                try { res.write('event: model_switch\ndata: ' + JSON.stringify({ from: model.id, to: _activeModel2.id, reason: _resolved2.reason }) + '\n\n'); } catch (_) {}
              } else if (_state.longctxDowngraded && _state.longctxDowngraded.length) {
                _state.longctxDowngraded = [];
              }
            } catch (_) {}
            _prefillStop = _startPrefillProgress(res, {
              input_tokens: _estimateInputTokens(messages),
              model: _activeModel2 && _activeModel2.id,
            });
            for await (const delta of _deps._callLLMForAgentStream(messages, _activeModel2, toolsSchema, {
              signal: _streamAbort.signal,
              sessionId: _sessionId,
              // 2026-10-24 (第 80 批): **流式路径从来没传过 soulScope** ⇒
              //   子 agent 在流式下拿的是 **main 档 soul** (9918 token),
              //   而不是 worker 档 (242 token) —— 2026-10-16 那次「子 agent 只带 worker 档 soul」
              //   只在**非流式**分支接上了, 流式 (生产主路径) 漏了。
              //   实测印证 (probe79-mcp 日志): kun 的 in=6978 —— 远大于 worker 档该有的量级。
              soulScope: _soulScope,
              callableTools: _callableToolNames,   // 第 80 批: 清单跟 schema 对齐
              // 第 88 批: 接住「整条流零正文」这个事实 (llm_caller 只在这种情况调一次)
              onReasoningOnly: (n) => {
                _streamReasoningOnly = true;
                _streamReasoningChars = Number(n) || 0;
              },
            })) {
              textContent += delta;
              // 2026-08-22: WITHIN_TURN_DELTA_REPEAT 守卫 (单回合内同 delta 连发 / 尾部重复 → 切断)
              if (!_deltaRepeatWarnSent && delta && delta.length >= WITHIN_TURN_DELTA_MIN_LEN) {
                if (delta === _deltaRepeatLast) {
                  _deltaRepeatCount++;
                } else {
                  _deltaRepeatCount = 1;
                  _deltaRepeatLast = delta;
                }
                // (a) 同 delta 连发 N 次
                if (_deltaRepeatCount >= WITHIN_TURN_DELTA_REPEAT) {
                  _deltaRepeatWarnSent = true;
                  console.warn('[j2-stream] WITHIN_TURN_DELTA_REPEAT: same delta repeated', _deltaRepeatCount, 'times, length', delta.length, '- truncating');
                  try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'WITHIN_TURN_DELTA_REPEAT: 同一 delta 连续重复 ' + _deltaRepeatCount + ' 次, 怀疑模型死循环, 已切断流. 当前 textContent 长度 ' + textContent.length + ' 字符.' }) + '\n\n'); } catch (e) {}
                  _streamAbort.abort();
                  break;
                }
                // (b) 尾部 substring 出现在更早位置 (尾循环)
                if (textContent.length >= WITHIN_TURN_TAIL_MIN_TOTAL) {
                  const tail = textContent.slice(-WITHIN_TURN_TAIL_LOOP_LEN);
                  const searchRegion = textContent.slice(0, -WITHIN_TURN_TAIL_LOOP_LEN);
                  let _hits = 0;
                  let _from = 0;
                  while ((_from = searchRegion.indexOf(tail, _from)) !== -1) {
                    _hits++;
                    _from += tail.length;
                    if (_hits >= WITHIN_TURN_TAIL_LOOP_HITS) break;
                  }
                  if (_hits >= WITHIN_TURN_TAIL_LOOP_HITS) {
                    _deltaRepeatWarnSent = true;
                    console.warn('[j2-stream] WITHIN_TURN_TAIL_LOOP: tail', WITHIN_TURN_TAIL_LOOP_LEN, 'chars appeared', _hits, 'times earlier, length', textContent.length, '- truncating');
                    try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'WITHIN_TURN_TAIL_LOOP: 尾部 ' + WITHIN_TURN_TAIL_LOOP_LEN + ' 字在历史中出现 ' + _hits + ' 次, 怀疑模型尾循环, 已切断流.' }) + '\n\n'); } catch (e) {}
                    _streamAbort.abort();
                    break;
                  }
                }
              }
              _armIdle();  // §1.3 fix: chunk 来了就重置闲置计时器 (Prime Agent 风格)
              if (!firstChunkSentAt) firstChunkSentAt = Date.now();
              if (_prefillStop) { _prefillStop(); _prefillStop = null; }
              // R16 修 (Bug D): 每 chunk 检查 req 是否关闭
              if (req && req.aborted === true) {
                console.warn('[j2-stream] §R16 req aborted mid-stream, breaking');
                _streamAbort.abort();
                if (_idleTimer) clearTimeout(_idleTimer);  // §1.3 fix: 出口清理
                clearTimeout(_totalTimer);
                break;
              }
              // 检测 <tool... 进入 (不 yield)
              if (!inToolBlock && textContent.slice(yieldedLen).includes('<tool')) {
                const openIdx = textContent.indexOf('<tool', yieldedLen);
                if (openIdx > yieldedLen) {
                  const before = textContent.slice(yieldedLen, openIdx);
                  // P0-#28: emit stream_delta (含 accumulated + token_count) + chunk (向后兼容)
                  _emitStreamDelta(res, before, textContent.slice(0, openIdx), Math.ceil(before.length / 1.5));
                }
                yieldedLen = openIdx;
                inToolBlock = true;
              }
 // #1 状态喷泉守卫: 累积超 MAX_NO_TOOL_STREAM_CHARS 还没 <tool> 就截断
              // 2026-09-03 R80 BUG #12 修: 原条件 !textContent.includes('<tool') 太宽松 — LLM 在 plain text 里也能输出
              // '执行中...<tool>...' 这种字面字符串, guard 直接失守, finalText 实测 62131 字符都没截
              // 修: 严格判断 — 必须有完整 <tool name=...>...</tool> 块才算真 tool call, 单 <tool 子串不算
              const _hasRealToolCall = /<tool[\s>][^<]*?<\/tool>/.test(textContent);
              if (!_fountainWarnSent && !inToolBlock && textContent.length > MAX_NO_TOOL_STREAM_CHARS && !_hasRealToolCall) {
                _fountainWarnSent = true;
                console.warn('[j2-stream] STATUS_FOUNTAIN_GUARD:', textContent.length, 'chars no <tool>, truncating');
                try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'STATUS_FOUNTAIN_GUARD: LLM 流式输出未检测到 <tool> 调用, 已切断防 token 雪崩. 当前 ' + textContent.length + ' 字符, 怀疑状态喷泉幻觉.' }) + '\n\n'); } catch (e) { console.warn('[j2-stream] res.write error:', e.message); }
                _recordModelFailure(model && model.id);  // 2026-08-23 R16 修: 实时 push 进程内黑名单
                break;
              }
              // 检测 </tool> 完成 — break 流
              if (inToolBlock && textContent.includes('</tool>', yieldedLen)) {
                const closeIdx = textContent.indexOf('</tool>', yieldedLen) + '</tool>'.length;
                yieldedLen = closeIdx;
                inToolBlock = false;
                toolBlockCompleted = true;
                // 继续接收后续可能的内容(如 task_done summary)
              }
              // 普通文本实时 yield (不在 tool 块内)
              if (!inToolBlock && !toolBlockCompleted) {
                const lenAfterYield = textContent.length;
                if (lenAfterYield > yieldedLen) {
                  // Do not stream orchestration transcript fragments into the
                  // user bubble. The final guard runs at close, but streaming
                  // them first made a later replacement too late for ChatRoom.
                  const pendingText = textContent.slice(yieldedLen);
                  if (_isOrchestrationLeak(textContent)) {
                    console.warn('[j2-stream] orchestration leak detected; suppressing text delta');
                    yieldedLen = lenAfterYield;
                    continue;
                  }
                  // P0-#28: emit stream_delta (含 accumulated + token_count) + chunk (向后兼容)
                  _emitStreamDelta(res, pendingText, textContent.slice(0, lenAfterYield), Math.ceil(lenAfterYield / 1.5));
                  yieldedLen = lenAfterYield;
                }
              }
            }
            break; // 流成功完成,退出重试
          } catch (streamErr) {
            streamError = streamErr;
            console.warn('[j2-stream] attempt', j2StreamAttempts, 'failed:', streamErr.message);
            if (j2StreamAttempts >= MAX_J2_STREAM_ATTEMPTS) throw streamErr;  // M9: off-by-one — MAX=2 应恰好 2 次尝试
            // 如果已有部分文本,保留;下轮会追加新文本(但这里简单重试:清空重来)
            textContent = '';
            yieldedLen = 0;
            inToolBlock = false;
            toolBlockCompleted = false;
            await new Promise(r => setTimeout(r, 500 * j2StreamAttempts));
          } finally {
            // 成功 / 失败 / 抛错 / break 四条出口共用这一个清理点。
            // 少一条 = 每 3 秒往一个可能已经关闭的响应上写一次。
            if (_prefillStop) { _prefillStop(); _prefillStop = null; }
          }
        }
        // 第 88 批 (2026-10-25): legacy 路的「只回思考」处置。
        //   native 路早就有这个检测 (_hasReasoningOnly), legacy 路一路没有 ——
        //   而 llm_caller 的流层在「整条流零 content」时会把 reasoning 缓冲**当正文 yield 出来**
        //   (2026-07-28 的 compat), 于是 legacy 路的思考直接进了 textContent
        //   ⇒ 再往下走就能变成 finalText ⇒ **主人收到模型的内心戏**。
        //   ⇒ 这里靠 llm_caller 的 `onReasoningOnly` 契约把这个**事实**接住 (不靠猜文本形态),
        //     思考进历史、但**不进答案**。
        if (_streamReasoningOnly) {
          const _thinking = String(textContent || '');
          console.warn('[j2-stream] REASONING_ONLY_ROUND: 整条流零正文 (' + _streamReasoningChars
            + ' 字思考被当正文 yield 出来), 思考不当答案');
          messages.push({ role: 'assistant', content: _thinking });
          messages.push({ role: 'system', content: '[SYSTEM WARNING] 你上一轮只回思考: content 通道是空的 (上游给了 '
            + _streamReasoningChars + ' 字 reasoning, 0 字正文), 也没调工具。**思考不是答案** —— '
            + '下一轮必须二选一: (1) 直接给出完整正文答案 (content 字段非空); (2) 调用工具 (tool_calls 非空)。'
            + '思考压到 3 行以内, 禁止只思考不行动。' });
          textContent = '';
          yieldedLen = 0;
          if (_reasoningOnlyNudges < 3 && round < maxRounds - 1) {
            _reasoningOnlyNudges++;
            try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '模型这轮只回思考没给正文, 已要求直接给答案或调工具.' }) + '\n\n'); } catch (e) {}
            continue;
          }
          finalText = '⚠️ [只回思考] 模型连续 ' + _reasoningOnlyNudges + ' 次只回思考、没有给出正文答案, 也没有调用任何工具。'
            + '我如实停下 —— 不拿模型的思考冒充答案交给你。\n'
            + '建议: 换个模型 / 检查端点 (这类故障多半是上游只回 reasoning_content 通道)。';
          totalChars = finalText.length;
          evoSuccess = false;
          break;
        }
      } catch (streamErr) {
        // 2026-10-23 (第 64 批): 超时**排在最前** —— 与 native 路径同一个道理。
        //   超时 ≠ 瞬断: 「原地改非流式重试」是**同一个 prompt 再来一次**,
        //   必然再撞同一堵墙 (现场 b63-guagate3: msgs 12 / inputTokens 16186 两次逐字节同大小)。
        //   而云端也未必更快, 还按量烧钱 ⇒ 超时只能认账收口。
        if (_isTimeoutError(streamErr.message)) {
          console.warn('[j2-stream] 超时收口 (不切非流式重试): ' + streamErr.message.slice(0, 100));
          finalText = _timeoutPolicy.timeoutNoticeText({
            kind: '这一轮',
            seconds: _timeoutPolicy.timeoutSeconds(streamErr.message),
            partialText: String(textContent || '').trim() ? String(textContent).trim().slice(0, 2000) : '',
          });
          evoSuccess = false;
          evoError = 'LLM_TIMEOUT';
          try {
            res.write('event: warning\ndata: ' + JSON.stringify({
              warning: '超时收口: ' + String(streamErr.message || '').slice(0, 160),
            }) + '\n\n');
          } catch (e) {}
          break;
        }
        // 流式中断: fallback 到非流式
        console.warn('[j2-stream] fallback to non-stream:', streamErr.message);
        // 2026-10-16: 同 native 路径 —— 本地端点原地改非流式重试 (免费) 优先于切云端。
        // 见 _preferSameLocalRetry 注释: 一次纯本地请求被自己引发的 ECONNRESET
        // 带着切到按量计费的云端, 这就是"预算墙"的来历。
        // 2026-10-23 (第 64 批): `!_isTimeoutError` 这道排除**不能省** —— 与 native 路径同款。
        //   超时是「这一轮算不完」, 不是「连接断了」。原地改非流式重试是**同一个 prompt 再来一次**
        //   ⇒ 必然再撞同一堵墙 (现场 b63-guagate3: msgs 12 / inputTokens 16186 两次逐字节同大小)。
        //   上面的超时分支排在前面只是**当前**顺序恰好对; 哪天有人把分支挪下去,
        //   顺序变了而行为悄悄变了, 没人会发现。这道排除是**行为层**的保证。
        const _streamRetrySameLocal = _isInfraError(streamErr.message)
          && !_isTimeoutError(streamErr.message)
          && _preferSameLocalRetry(model, _state);
        if (_streamRetrySameLocal) {
          console.warn('[j2-stream] 本地端点流式瞬断 → 原地改非流式重试 (不切模型, 不烧配额): '
            + streamErr.message.slice(0, 80));
        }
        // 2026-08-02: 配额错误不 fallback 不重试 — 直接说真原因收口
        // 2026-09-16 老板拍 "所有模型公平, 不分本地/云": 端点瞬断 → 按 cost 公平选下一个可用模型, 不强制本地
        if (!_streamRetrySameLocal && _isInfraError(streamErr.message) && !_state.infraSwitched && !_manualModelSelection) {
          const _lcfX = require('./longctx_fallback');
          const _alt = _lcfX._pickCheapestModel((_deps && _deps._config && _deps._config.llm && _deps._config.llm.models) || [], model.id, [model.id], _estimateInputTokens(messages));
          if (_alt && _alt.id !== model.id) {
            _state.infraSwitched = _alt.id;
            console.warn('[j2-stream] 模型 ' + model.id + ' 流式瞬断 → 公平切 ' + _alt.id + ' 重跑 (不 fast-fail)');
            try { res.write('event: model_switch\ndata: ' + JSON.stringify({ from: model.id, to: _alt.id, reason: 'infra-fallback' }) + '\n\n'); } catch (_) {}
            model = _alt;  // 后续 fallback 非流式调用用该模型
          }
        }
        if (!_streamRetrySameLocal && _isInfraError(streamErr.message) && !_state.infraSwitched) {
          // 没有别的可切模型 → fast-fail 说真话
          console.warn('[j2-stream] INFRA fast-fail');
          try { res.write('event: error\ndata: ' + JSON.stringify({ error: '模型端点不可用' }) + '\n\n'); } catch (_) {}
          finalText = _infraFailText(streamErr.message, model);
          evoSuccess = false; evoError = 'QUOTA_EXCEEDED';
          break;
        }
        try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '模型流式输出被截断，已切换到非流式重试: ' + streamErr.message }) + '\n\n'); } catch (e) {}
        // R13 修: 用 _callLLMWithTimeout (fallback 路径也走超时熔断)
        const result = await _callLLMWithTimeout(messages, model, toolsSchema, {
          res, sessionId: opts.sessionId,
          soulScope: _soulScope,
          callableTools: _callableToolNames,   // 第 80 批: 清单跟 schema 对齐 (同一轮真能调的集)
        });
        if (isAnthropic) {
          textContent = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        } else {
          // §2026-08-17 fix: reasoning_content fallback (跟 native path 对齐)
          const _msg0b = result.choices?.[0]?.message || {};
          textContent = _msg0b.content || _msg0b.reasoning_content || '';
        }
        const textWithoutTools = textContent.replace(/<tool[\s\S]*?<\/tool>/g, '').trim();
        if (textWithoutTools) {
          // P0-#28: emit stream_delta (含 accumulated + token_count) + chunk (向后兼容)
          _emitStreamDelta(res, textWithoutTools, textWithoutTools, Math.ceil(textWithoutTools.length / 1.5));
        }
      }
      console.log('[j2-stream] first_chunk_ms:', firstChunkSentAt ? firstChunkSentAt - sseStartTime : 'N/A', 'text_len:', textContent.length);
      // R16 修 (Bug D): 清 stream timer
      try { clearTimeout(_streamTimer); } catch (_) {}
        // P0-#28: emit stream_done event (spec §3)
        try {
          res.write('event: stream_done\ndata: ' + JSON.stringify({ type: 'stream_done', total_tokens: Math.ceil(textContent.length / 1.5), duration_ms: Date.now() - sseStartTime, ts: Date.now() }) + '\n\n');
        } catch (e) { console.warn('[j2-stream] res.write stream_done error:', e.message); }
      if (!textContent) { break; }
      // 2026-09-13 (16:39 实案): legacy 路径同样累计全请求最长实质正文 (元引用摘要兜底用)
      const _legacyPlainNow = String(textContent).replace(/<tool[\s\S]*?<\/tool>/g, '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/<think>[\s\S]*$/g, '').trim();
      if (_legacyPlainNow.length > _longestRoundPlain.length) _longestRoundPlain = _legacyPlainNow;

      const toolCalls = j2Helpers._extractToolCallsFromText(textContent);  // 2026-08-02 修: 模块内从未 import, legacy 流式一进来就 ReferenceError

      const taskDoneCall = toolCalls.find(tc => tc.name === 'task_done');
      if (taskDoneCall) {
        taskDoneCalled = true;
        taskDoneStatus = (taskDoneCall.params && taskDoneCall.params.status) || 'completed';
        try { res.write('event: tool_call\ndata: ' + JSON.stringify({ calls: [{ name: 'task_done', params: taskDoneCall.params }] }) + '\n\n'); } catch (e) { console.warn('[j2-stream] res.write error:', e.message); }
        const path = require('path');
        const { TOOLS } = require('./tools');
        let execResult = { ok: false, error: 'tool not found' };
        try {
          execResult = await wrapToolResultWithHooks('task_done', taskDoneCall.params, async (params) => TOOLS['task_done']({ context: { user: 'feng', sessionId: _sessionId }, params }), { sessionId: _sessionId }); // 2026-09-17 全修#3
        } catch (e) { execResult = { ok: false, error: e.message }; }
        try { res.write('event: tool_result\ndata: ' + JSON.stringify({ name: 'task_done', ok: !!(execResult && execResult.ok), result: execResult }) + '\n\n'); } catch (e) { console.warn('[j2-stream] res.write error:', e.message); }
        toolsUsed.push('task_done');
        const summary = (taskDoneCall.params && taskDoneCall.params.summary) || '';
        // 2026-09-11 OVERCLAIM_SENTINEL (legacy 路径, 与 native 同口径)
        const _legacyRealTools = toolsUsed.filter(n => n !== 'task_done');
        const _legacyOverclaim = _legacyRealTools.length > 0 && OVERCLAIM_RE.test(summary) && !/(未完成|未做|未消化|缺|剩余|尚未|未开始)/.test(summary);
        if (summary && !_legacyOverclaim) {
          const alignedSummary = guardFinalText(summary, false);
          // 2026-07-26 老板拍: final 事件整体替换气泡 — 旁白进 thinking 折叠区, 气泡只剩最终答复
          // (取代 11:57 的 _isRepeat 跳过去重: 跳过的副作用是 summary 走 appendDelta 被 hash 窗口咬成乱码)
          if (alignedSummary) {
            taskDoneAccepted = true;
            // 2026-09-13 (16:28 实案, 与 native 同口径): summary 是"答案已在流式输出给出"
            // 的元引用 + 本轮正文更实在 → 用正文交付, 防真答案被旁白 buffer + final 替换两头丢。
            const _META_REF_RE_L = /(流式输出|正文|上文|上述|如上|见上|前文|上面|已.{0,8}(给出|呈现|展示|输出|交付|写完|写好)|完整给出)/;
            const _deliverL = (_META_REF_RE_L.test(alignedSummary) && _longestRoundPlain.length > alignedSummary.length) ? _longestRoundPlain : alignedSummary;
            if (_deliverL !== alignedSummary) console.warn('[j2-stream] META_SUMMARY_SWAP: summary 是正文元引用, 改用全请求最长正文交付 (' + _longestRoundPlain.length + ' chars)');
            emitFinalOnce(_deliverL);
            finalText = _deliverL; totalChars = _deliverL.length;
          }
        }
        if (_legacyOverclaim && _alignNudges < 1 && round < maxRounds - 1) {
          _alignNudges++;
          console.warn('[j2-stream] OVERCLAIM_TASK_DONE: summary 全集断言, 拒收逼改实数 #' + _alignNudges);
          try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'OVERCLAIM: summary 全集断言 (已完成/全部) 但证据未覆盖全集, 逼改实数.' }) + '\n\n'); } catch (e) {}
          messages.push({ role: 'system', content: '[OVERCLAIM_BLOCKED] 你的 task_done summary 是全集断言 ("已完成/全部..."), 但你的证据没有覆盖全集 — 这是夸大。改写: 只报核实过的项 + 实数, 未做项明确写 "未做"。再 task_done。' });
          continue;
        }
        if (!taskDoneAccepted && round < maxRounds - 1) {
          const _partialHint = (typeof _realToolsThisTask !== 'undefined' && _realToolsThisTask.length > 0)
              ? '活还没干完 (真工具已跑 ' + _realToolsThisTask.length + ' 次, 还有剩余步骤/缺失产出): 先继续调工具把剩余步骤做完、缺失产出补齐, 全部完成后重新 task_done; 只有确认活已全部干完、纯粹是 summary 措辞夸大/没对齐时, 才不用调工具直接重写总结。'
              : '不要再调工具，不要写卦象、计划、待确认或过程旁白；只根据已返回的工具结果，用 2-5 句直接回答原问题，然后再次 task_done。';
            messages.push({ role: 'system', content: '[FINAL_REWRITE_REQUIRED] 你刚才的 task_done 总结未通过对齐守门。' + _partialHint });
          continue;
        }
        break; // 修复：task_done 后退出循环
      }

      if (toolCalls.length === 0) {
// 2026-08-01 修: think-only 轮 — MiniMax-M3 把 <think> 内联进 content, 思考烧完 max_tokens 就停
// 整轮 0 正文 0 工具, 还白占一轮 maxRounds → nudge 让模型压缩思考直接给答案 (不计为有效答复)
        const _answerOnly = textContent.replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/<think>[\s\S]*$/g, '').trim();
        if (!_answerOnly && textContent.includes('<think>') && round < maxRounds - 1) {
          console.warn('[j2-stream] THINK_ONLY_ROUND: 整轮只有 <think>, 0 正文 0 工具, nudge');
          try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '模型这轮只思考没输出正文, 已要求压缩思考直接给答案.' }) + '\n\n'); } catch (e) {}
          _pushReplay('THINK_ONLY', textContent, 500);
          messages.push({ role: 'system', content: '[SYSTEM WARNING] 你上一轮的输出只有 <think> 思考, 正文一个字都没有 (思考太长烧完了输出预算)。下一轮: 思考压到 3 行以内, 直接输出正文答案或调用工具。' });
          continue;
        }
// R80 修 (BUG #1 死循环空承诺): legacy 路径空计划模板熔断
        // 老板 7/30 实证: "动手/自动修正" → 模型复读 "第一步...第二步..." 6+ 轮 0 工具调用
        // 修: 空计划 + 0 工具 ≠ finalText; 先 nudge (≤2 次), 仍不改 → 诚实失败, 不假装在做
        // W1.1 双轨: SM 前置 + 决策对比 (legacy 路径)
        const _smL = _isTaskExecutionRequest
          ? _planGate.check({ textContent, toolsUsed, round, maxRounds, emit: res.write.bind(res), hasReasoningOnly: _hasReasoningOnly })
          : { action: 'pass' };
        const _legacyL = _looksLikeEmptyPlan(textContent) && toolsUsed.filter(n => n !== 'task_done').length === 0;
        if ((_smL.action === 'nudge') !== _legacyL) console.warn('[j2-legacy] W1.1 SM对比: sm=' + (_smL.action === 'nudge' ? 'nudge' : 'pass') + ' legacyWouldEnter=' + (_legacyL ? 'yes' : 'no'));
        if (_smL.action === 'break') {
          console.warn('[j2-legacy] W1.x SM接管 break #' + _smL.rule);
          try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: _smL.message }) + '\n\n'); } catch (_) {}
          finalText = '[SYSTEM_GUARD] ' + _smL.message;
          totalChars = finalText.length;
          evoSuccess = false;
          break;
        }
        if (_smL.action === 'nudge') {
          if (_emptyPlanNudges < EMPTY_PLAN_MAX_NUDGES && round < maxRounds - 1) {
            console.warn('[j2-legacy] W1.1 SM接管 nudge #' + _smL.count);
            _emptyPlanNudges++;
            messages.push({ role: 'assistant', content: textContent });
            messages.push({ role: 'system', content: _smL.message });
            continue;
          }
          console.warn('[j2-legacy] W1.1 SM熔断: nudges exhausted, honest fail');
          try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'R80: 模型反复输出空计划不调工具, 已熔断.' }) + '\n\n'); } catch (e) {}
          finalText = '⚠️ [盘古 R80 空计划熔断] 模型连续 ' + (_emptyPlanNudges + 1) + ' 轮只输出计划模板 (第N步...) 但 0 工具调用, 我没有真动手。\n建议: 换更强模型, 或把任务拆成单步指令 (例: "读 X 文件").';
          totalChars = finalText.length;
          evoSuccess = false;
          break;
        }
        if (_isTaskExecutionRequest && _looksLikeEmptyPlan(textContent) && toolsUsed.filter(n => n !== 'task_done').length === 0) {
          if (_emptyPlanNudges < EMPTY_PLAN_MAX_NUDGES && round < maxRounds - 1) {
            console.warn('[j2-stream] R80 EMPTY_PLAN_GUARD: plan-only output, 0 tool calls, nudge', _emptyPlanNudges);
            try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'R80: 检测到空计划模板 (0 工具调用), 已要求直接执行.' }) + '\n\n'); } catch (e) {}
            messages.push({ role: 'assistant', content: textContent });
            messages.push({ role: 'system', content: '[SYSTEM WARNING] 你刚才只输出了计划模板 (第N步...), 一个工具都没调。主人已经拍板让你动手 — 禁止再列步骤, 下一轮必须直接调用工具 (read_file / exec_command / write_file 等) 真执行。再输出空计划 = 任务失败。' });
            continue;
          }
          console.warn('[j2-stream] R80 EMPTY_PLAN_GUARD: nudges exhausted, honest fail');
          try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'R80: 模型反复输出空计划不调工具, 已熔断.' }) + '\n\n'); } catch (e) {}
          finalText = '⚠️ [盘古 R80 空计划熔断] 模型连续 ' + (_emptyPlanNudges + 1) + ' 轮只输出计划模板 (第N步...) 但 0 工具调用, 我没有真动手。\n建议: 换更强模型, 或把任务拆成单步指令 (例: "读 X 文件").';
          totalChars = finalText.length;
          evoSuccess = false;
          break;
        }
// BugA: legacy 路径重复输出检测
        if (_answerOnly && _isOrchestrationLeak(_answerOnly)) {
          console.warn('[j2-stream] orchestration leak detected in visible answer; rejecting as final');
          finalText = '';
          break;
        }
        if (textContent.length > 200 && round >= 1) {
          const prevAssistant = messages.filter(m => m.role === 'assistant').pop()?.content || '';
          if (prevAssistant && textContent === prevAssistant) {
            console.warn('[j2-stream] STATUS_FOUNTAIN_GUARD: identical output detected, breaking');
            textContent = '[⚠️ 检测到重复输出，已熔断。请简化任务或换工具。]';
            try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '检测到重复输出, 已熔断.' }) + '\n\n'); } catch (e) {}
            finalText = textContent; totalChars = finalText.length;
            break;
          }
        }
        if (round === 0 && !textContent.trim()) {
          // LLM 返回空内容，可能是没理解必须调用工具；强制提醒并重试
          messages.push({ role: 'assistant', content: textContent });
          messages.push({ role: 'user', content: '[系统: 主人要求执行具体操作（如创建文件夹），你必须调用一个工具完成，不能返回空内容。请立即调用 exec_command / write_file 等合适工具。]' });
          continue;
        }
        // R80-ext 修 (BUG #6 调工具后嘴说型空响应, 老板 2026-08-01 14:24 实证)
        // 现象: tool_calls_total=6 但 finalText=392 字符 "先调工具拿真实数据", 6 个工具结果全丢
        // 根因: LLM 调了工具但最后一轮忘记生成总结, 走 L1237 把嘴说当 finalText
        // 修: 调过工具 + 文本短 + 含承诺词 → 不收 finalText, 走 summary 路径 (L1319+)
        // 2026-08-02 修 (老板 RTF 实证): 关于盘古自身的问题 (64卦/工具/架构/源码), 0 工具凭印象答 = 可能造谣
        // 前科: 凭印象否认真实存在的 apps/core/64i 二进制映射层
        const _SELF_REF_RE = /你(自己|的(工具|架构|源码|能力|推理|记忆|设计|系统|prompt|子\s*agent))|盘古.*(工具|架构|源码|能力|推理|设计)|子\s*agent|64\s*卦|六十四卦/i;
        if (toolsUsed.filter(n => n !== 'task_done').length === 0 && _SELF_REF_RE.test(userInput) && round < maxRounds - 1) {
          console.warn('[j2-stream] SELF_REF_ZERO_TOOLS: 自身问题 0 工具凭印象答, nudge 逼查证');
          try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '关于盘古自身的问题必须先查证 (读源码/查记忆), 禁止凭印象回答.' }) + '\n\n'); } catch (e) {}
          _pushReplay('SELF_REF_ZERO_TOOLS', textContent, 500);
          messages.push({ role: 'system', content: '[SYSTEM WARNING] 主人在问关于你自己的事实, 你上一轮凭印象回答且 0 工具调用 — 这可能是造谣 (你有前科: 否认过真实存在的 64i 二进制映射层)。下一轮必须先用工具查证: list_directory / read_file 读 <repo>/apps/core/64i/ 和 <repo>/apps/core/modules/tools/ (repo = 盘古仓根), 或 memory_search 查记忆。查不到就直说"查了, 没找到", 禁止凭印象承认或否认。' });
          continue;
        }
        // 2026-08-02 修: 0 工具 + 纯承诺旁白 ("老板,现在要我干吗?" / "我先并发 6 个探针")
        // toolsUsed=0 时旧 lip-service 检查直接跳过 → 承诺被当 final 发出, 老板看到"断了"
        // 2026-09-11 LIP-SERVICE text-only 护栏 (legacy 路径, 09-11 11:05 实案同款):
        // 旧版无上限 + 窄 regex; 现在并入 LIP_SERVICE_SUMMARY_RE 措辞 + 与 native 共享上限 2 + 耗尽诚实失败熔断
        if (toolsUsed.length === 0 && textContent && round < maxRounds - 1) {
          const _lipZero = /探针|再补|继续深挖|摸清|到手|先查|先并发|拿(?:量化|真|真实)?数据|先调(?:工具|子)?|马上调|这就去/.test(textContent) || _isLipServiceText(textContent);
          if (_lipZero) {
            if (_lipServiceNudges < 4) {
              _lipServiceNudges++;
              console.warn('[j2-stream] LIP_SERVICE_ZERO_TOOLS: 0 工具 + 嘴说, nudge #' + _lipServiceNudges);
              try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '模型光说不做 (0 工具调用), 已要求立即调工具拿真数据.' }) + '\n\n'); } catch (e) {}
              _pushReplay('LIP_SERVICE_ZERO_TOOLS', textContent, 500);
              messages.push({ role: 'system', content: '[SYSTEM WARNING] 你上一轮全是承诺/计划 ("我要调 X" / "数据到手" / "先列出...再..."), 但一个工具都没调。禁止复述计划, 禁止问"要我干吗", 下一轮必须直接调用工具拿真数据回答; 做不了就 task_done({status:"failed", reason:"..."}) 老实承认。' });
              continue;
            }
            console.warn('[j2-stream] LIP_SERVICE_ZERO_TOOLS: nudges exhausted, honest fail');
            try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'LIP_SERVICE: 模型反复输出计划/承诺不调工具, 已熔断.' }) + '\n\n'); } catch (e) {}
            finalText = '[LIP-SERVICE 熔断] 我连续 ' + _lipServiceNudges + ' 轮只说"开干/先列/接下来"却 0 真工具, 没收口, 但方向已理解 — 断点续跑即可, 不用重发整个任务。\n怎么继续: 直接说「继续」接上, 或拆单步指令 (例: "先 ls <语料库目录>/课程资料").';
            totalChars = finalText.length;
            evoSuccess = false;
            break;
          }
        }
        const _LIP_SERVICE_RE = /先调(?:工具|子)?|立即补上|会调|嘴说|不靠嘴|马上调|这就去|下面调|现在调|动手调|立即执行|调工具拿(?:真实|真)?数据|探针|再补|继续深挖|继续排查|摸清|到手|先查|先并发|先发|先拉|拿(?:量化|真|真实)?数据/;  // 2026-08-02 扩: 老板实证 '再补 2 个探针/数据全到手' 绕过旧 regex
        if (toolsUsed.length > 0 && textContent && _LIP_SERVICE_RE.test(textContent)) {
          console.warn('[j2-stream] R80 LIP_SERVICE_AFTER_TOOLS: 调了 ' + toolsUsed.length + ' 工具 (' + toolsUsed.join(',') + ') 但嘴说, 触发 summary 重试');
          try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'R80: 调了 ' + toolsUsed.length + ' 工具但 LLM 嘴说, 自动让 LLM 总结工具结果.' }) + '\n\n'); } catch (e) {}
          finalText = ''; totalChars = 0;  // 清掉, 让 L1319 summary 路径接管
          break;
        }
        // 2026-09-12 e2e 实战修: legacy 文本轮收口 break 也走自动续跑 —
        // 实案: 末轮模型只回文本 (本轮 0 工具, 此前轮调过工具), 在此 break 收口,
        // 永远够不到循环末尾的 maxRounds_reached 续跑块 → 长任务带"final"悄悄截断。
        if (round === maxRounds - 1 && !taskDoneAccepted && toolsUsed.length > 0) {
          const _resumed = await _tryAutoResume('legacy_last_round_text_final');
          if (_resumed) { round = -1; continue; }
        }
        // 2026-09-14 (老板 13:42 实案): legacy 路径同样纠假回灌 — 编交付被对账抓到不收口,
        // 拦截结论回灌 loop 逼真做或老实说没做 (上限 2 次, 与 native 路径同款)。
        if (!taskDoneAccepted && _deliveryRejectRetries < 2 && textContent) {
          try {
            const _dcEarlyL = require('./task_ledger').checkDeliveryClaims(_sessionId, textContent, { toolsThisRun: toolsUsed.filter(n => n !== 'task_done').length });
            if (_dcEarlyL && _dcEarlyL.missed && _dcEarlyL.missed.length) {
              _deliveryRejectRetries++;
              console.warn('[j2-stream] LEDGER_DELIVERY_RETRY #' + _deliveryRejectRetries + ': 编交付回灌纠假不收口');
              try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '对账拦截: 交付声称的文件账上无据, 已自动回灌要求真做 (纠假 ' + _deliveryRejectRetries + '/2).' }) + '\n\n'); } catch (_) {}
              _pushReplay('LEDGER_REJECT', textContent, 300);
              messages.push({ role: 'system', content: '[LEDGER_REJECT] 你刚才声称本轮落盘/生成了文件 (' + _dcEarlyL.missed.slice(0, 3).join('、') + '), 但任务账本没有对应写盘记录。文件可能本来就存在或只是被读取, 不要把源文件/已有文件说成本轮新产出。优先改写答复: 只报真实写入的文件, 其余写"已存在/已读取, 本轮未写"。只有用户明确要求创建新文件时才继续调用 write_file / exec_command 重定向。' });
              continue;
            }
          } catch (_) {}
        }
        finalText = _answerOnly || textContent; totalChars = finalText.length;
        break;
      }

      try {
        if (textContent) _emitThinkingEnd(res);  // 2026-07-26: 本轮文本是旁白 → 前端挪进 thinking 折叠区
        // 2026-08-11 R131+ 老板拍: tool_call 加 id (前端按 id 匹配 tool_result, 实时更新卡片)
        // 原 payload 是 {calls: [{name, params}]}, 加 id 后变为 {calls: [{id, name, params}]}
        res.write('event: tool_call\ndata: ' + JSON.stringify({ calls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, params: tc.params })) }) + '\n\n');
      } catch (e) { console.warn('[j2-stream] res.write error:', e.message); }

      messages.push({ role: 'assistant', content: textContent });
      for (const tc of toolCalls) {
        toolsUsed.push(tc.name);
        toolHistory.push({ name: tc.name, args: tc.params });
      }

      const freshToolCalls = [];
      const duplicateToolResults = [];
      for (const tc of toolCalls) {
        const key = tc.name + '|' + _stableStringify(tc.params || {});
        const seen = _crossRoundToolCalls.get(key) || 0;
        if (seen >= _CROSS_ROUND_CALL_LIMIT) {
          duplicateToolResults.push({
            name: tc.name,
            ok: false,
            blocked: true,
            content: JSON.stringify({
              ok: false,
              error: 'DUPLICATE_TOOL_CALL',
              // 2026-09-16 老板实案: 这是盘古本地防重复调用守门, 不是上游熔断 — 文案必须诚实区分,
              // 否则模型会把它当成上游死锁, 直接放弃重读/继续读剩余块, 任务真活卡死。
              message: '同一工具和参数本轮已执行过 (本地防重复守门, 非上游熔断): 只读类工具 (read_file/list_directory 等) 重读同路径是合法的, 换个 offset/limit 或换不同文件继续读; 写/执行类工具别再原样重发, 基于已有结果总结或改用不同参数/工具。',
            }),
          });
          continue;
        }
        _crossRoundToolCalls.set(key, seen + 1);
        freshToolCalls.push(tc);
      }
      // 2026-10-09: 探测类工具空转检测 — 参数变了的重复调用上面那关拦不住, 这里补。
      // 2026-10-12 (老板报"会话 78325678 一开始还正常, 后续就不对劲"): _PROBE_TOOLS 只装了
      // system_info/process_list 那几个系统探测工具, **域工具的空转没人管**。实案: bazi_calc 被
      // 连调 5 次, 每次换一套瞎猜的出生日期 (1978-8-26 → 8-13 → 8-6 → 7-14 → 7-14@11时),
      // 五轮零文本输出 —— 模型在拿工具试错, 不是在查数据。_CROSS_ROUND_CALL_LIMIT 按
      // 工具名|参数 判重也拦不住, 因为每次参数都不同。
      // 关键判据 = "整轮没有任何一句人话输出": 工具调用很多但从不说结论, 就是空转。
      // 合法的多调用(读 8 个文件 / 给 3 个人排盘)会有写盘验收或文本进展, 不受影响。
      //
      // 2026-10-23 (第 73 批): 这里只**记账** (按工具名, 参数怎么换都记同一个桶),
      // 判定挪到工具执行之后 —— 因为新增的 R2 规则 (同一个工具连吃两个空 = 这条路走不通)
      // 必须看到**结果**才判得出来。读 5 个文件也是"5 次", 但每个都有内容, 那不是空转。
      try {
        // 2026-10-23 (第 73 批): 这段判定收成唯一真源 tool_spin_guard.js ——
        //   与 native 路径共用同一份阈值/文案。原先这里是本文件里的一份抄本,
        //   而 native 那份**整个缺失** ⇒ 主路上没有这道闸门 (实跑 200 秒空转)。
        _spinGuard.note(freshToolCalls.map((tc) => (tc && tc.name) ? { name: tc.name } : null).filter(Boolean));
      } catch (_) {}
      if (duplicateToolResults.length > 0) {
        try { res.write('event: tool_loop_alarm\ndata: ' + JSON.stringify({ warning: '拦截重复工具调用', count: duplicateToolResults.length, ts: Date.now() }) + '\n\n'); } catch (_) {}
      }
      // 2026-10-17 (老板拍: 「乾就应该把任务拆了, 分下去」):
      // dispatch_subagents **不**走 _j2ExecuteToolCalls —— 那边按 name 去 TOOLS 里查,
      // 而这个工具的执行需要 res / model / configPath (子 agent 要建卡、要继承主模型、
      // 要角色白名单), tools 的 ctx 一个都没有。所以在主循环这里就地拦下来跑。
      //
      // 为什么要这个工具: 主 agent 原本**没有任何编排能力** (MAIN 集里既没 plan_create
      // 也没派活工具), 于是"该不该派活"完全由 j2_dispatcher 里四个正则说了算, 主循环
      // 只是最后兜底。长任务里主 agent 只能单线程硬啃: 没人拆、没人并行、没人汇报 ——
      // 老板说的"跟死了一样"。
      //
      // 结果作为 tool result 回灌, 主 agent 拿着各刀的汇报继续自己的 loop 综合 ——
      // 这就是 Codex 的模式, 也是"乾编排、将灵执行"落地的样子。
      const _dispatchCalls = [];
      const _normalCalls = [];
      for (const tc of freshToolCalls) {
        if (tc.name === 'dispatch_subagents') _dispatchCalls.push(tc);
        else _normalCalls.push(tc);
      }
      const _dispatchResults = [];
      for (const dc of _dispatchCalls) {
        try {
          // 同 native 那份的理由: path 是块级局部 require, 这两处拦截都在其作用域之外。
          // legacy 这条路至今没被实跑走到过 (native 是实测主路), 所以这里的
          // ReferenceError 一直藏着 —— 跟 native 那条一起修, 免得哪天模型走 legacy 又断一次。
          // (第 109 批: 节点配置改走 config/node_config.js 解析, 这里已经不需要拼路径。)
          try { res.write('event: status\ndata: ' + JSON.stringify({
            stage: 'dispatching',
            message: '主 agent 拆成 ' + ((dc.params && dc.params.tasks && dc.params.tasks.length) || '?')
              + ' 刀, 派给将灵并行执行...',
            ts: Date.now(),
          }) + '\n\n'); } catch (_) {}
          _dispatchResults.push(await require('./dispatch_subagents_exec').runDispatchSubagents({
            params: dc.params,
            model,
            // 透传 req: 子 loop 靠它接"主人关掉页面", 不传的话关页面后子 agent 烧到跑完
            req,
            res,
            sessionId: _sessionId,
            opts: opts || {},
            userInput,
            // 2026-10-17: planOnlyDispatch 是 j2_dispatcher 的「先问主 agent 拆不拆」
            // 那条路专用 —— 主 agent 这轮只交方案, 刀由 dispatcher 拿 subTasks 后自己
            // 按老路径跑 (DAG 调度/并发闸门/合成/对账/验收闭环都在那边, 一个字没动)。
            // 不透传的话这里会替 dispatcher 把刀真跑一遍, onPlanned 永不触发,
            // 主 agent 白拆一遍还把收口权抢了 (首次实跑 0 刀就是这个形状的 bug)。
            planOnly: Boolean(opts && opts.planOnlyDispatch),
            onPlanned: opts && opts.onPlanned,
            // 跟 j2_dispatcher 取法一致 (同一份节点配置, 角色档位/模型解析都从它读)
            configPath: (_deps && _deps.CONFIG_PATH)
              || require('../config/node_config').resolveNodeConfigPathOrEmpty(),
          }));
        } catch (e) {
          _dispatchResults.push({
            name: 'dispatch_subagents', ok: false,
            content: 'DISPATCH_EXCEPTION: ' + String(e && e.message || e).slice(0, 300),
          });
          try { res.write('event: error\ndata: ' + JSON.stringify({ error: 'dispatch_subagents: ' + e.message, ts: Date.now() }) + '\n\n'); } catch (_) {}
        }
      }
      const toolResults = [
        ..._dispatchResults,
        ...(_normalCalls.length ? await _deps._j2ExecuteToolCalls(_normalCalls, res, {
          sessionId: _sessionId,
          toolsAllowed: opts && opts.toolsAllowed,
          // 排盘结果要真身: executor 返回的 content 是被截断过的字符串, 反解不出盘
          onResult: _recordChartEvidence,
        }) : []),
        ...duplicateToolResults,
      ];
      _collectEvidence(toolResults);
      // 2026-10-23 (第 73 批): 空转判定挪到这里 (工具执行之后) ——
      //   R2 (同一个工具连吃两个空 = 这条路走不通, 换参数再试就是瞎试) 必须看到结果才判得出来。
      //   实跑现场 request-1792769303516-b1fe3a:
      //     exec_command #1 → ok:false (Cannot find module 'sxtwl')
      //     exec_command #2 → ok:true 但 stdout/stderr 全空
      //     ⇒ 第 2 次就该喊停, 而不是等第 3 次 (本地 27B 一轮 ≈70s)。
      //   legacy 口径保持原样 ("这一轮说过话"在 legacy 上有信息量; native 那边的差异见守门创建处注释)。
      try {
        _spinGuard.note([], toolResults);
        const _saidAnything = messages.some(m => m && m.role === 'assistant'
          && typeof m.content === 'string' && m.content.trim().length > 0);
        const _spin = _spinGuard.check({ saidAnything: _saidAnything, toolsUsed });
        if (_spin) {
          console.warn('[j2-stream] TOOL_SPIN_GUARD: 工具空转 (' + _spin.spammed.join('、')
            + '), 已回灌停止指令');
          messages.push({ role: 'system', content: _spin.message });
          try { res.write('event: tool_loop_alarm\ndata: ' + JSON.stringify({ warning: '工具空转, 已回灌停止指令', tools: _spin.spammed, ts: Date.now() }) + '\n\n'); } catch (_) {}
          _spinGuard.reset(_spin.spammed);  // 回灌后清零, 避免每轮都喊
        }
      } catch (_) {}
 // BugA: legacy 路径连续失败检测
      const legacyToolFailureCount = {};
      for (const tr of (toolResults || [])) {
        const ok = tr && tr.ok !== false;
        if (!ok) {
          const name = tr.name || 'unknown';
          legacyToolFailureCount[name] = (legacyToolFailureCount[name] || 0) + 1;
        }
      }
      for (const [toolName, count] of Object.entries(legacyToolFailureCount)) {
        if (count >= 2) {
          messages.push({
            role: 'system',
            content: '[SYSTEM WARNING] Tool ' + toolName + ' failed ' + count + ' time(s) in this batch. Do not retry the same tool. Switch to a different approach or inform the user.'
          });
        }
      }
      _deps._j2AppendToolResults(messages, toolResults);
      // Legacy/XML models are the common path for MiniMax in this deployment.
      // Save after results are appended, not only before the model call, so an
      // interrupted multi-step task has a coherent continuation checkpoint.
      try {
        const last = toolCalls[toolCalls.length - 1];
        _persistSession(_sessionId, messages, {
          round: round + 1,
          state: 'active',
          task_input: userInput,
          plan_state: _state.planState || null,
          lastToolCall: last ? { name: last.name, params: last.params || {} } : null,
        });
      } catch (_) {}
    } catch (e) {
      console.error('[j2] loop error:', e.message);
      evoError = e.message; evoSuccess = false;
      // 2026-08-02: 配额错误给真原因, 不走 Silent Failure 那套 "任务太复杂" 说辞
      if (_isQuotaError(e.message) && !finalText) finalText = _infraFailText(e.message, model);
      try { res.write('event: error\ndata: ' + JSON.stringify({ error: e.message }) + '\n\n'); } catch (e) { console.error('[loop-error-write-fail]', e.message); }
      break;
    }
    // R16 修 (Bug J — legacy path 无 maxRounds 兜底): for 循环最后一轮主动收口
    // 2026-09-12 新增 (老板 PANGU_SCAN_REPORT_20260912 §5 L2): 自动续跑 — maxRounds 到达时,
    // 若 plan_state 还有 pending 步骤 + PANGU_AUTO_RESUME_MAX > 0, 自动 compact + 续跑 (不等人肉"继续")。
    // 默认 0 (关闭), 老板拍全干 14:08 启用 — 设 PANGU_AUTO_RESUME_MAX=3 上限 3 次自动续跑。
    // 2026-09-12 e2e 实战修: 闸门从 !finalText 改为 !taskDoneAccepted —
    // 旧条件几乎永远不可达: 模型最后一轮随便输出一句文本 (如"步1 完成") finalText 就非空,
    // auto-resume 被跳过, R16 也只在 finalText 空时才留警告 → 长任务带着"success"悄悄截断 (实案:
    // 3 步任务只做 1 步, status=done success)。真正的判据是"任务没被验收", 不是"有没有话可说"。
    // 2026-09-12 e2e 实战修: 闸门从 !finalText 改为 !taskDoneAccepted —
    // 旧条件几乎永远不可达: 模型最后一轮随便输出一句文本 (如"步1 完成") finalText 就非空,
    // auto-resume 被跳过, R16 也只在 finalText 空时才留警告 → 长任务带着"success"悄悄截断 (实案:
    // 3 步任务只做 1 步, status=done success)。真正的判据是"任务没被验收", 不是"有没有话可说"。
    if (round === maxRounds - 1 && !taskDoneAccepted) {
      const _resumed = await _tryAutoResume('maxRounds_reached');
      if (_resumed) { round = -1; continue; }
    }
    if (round === maxRounds - 1) {
      console.warn('[j2] R16 maxRounds=' + maxRounds + ' reached, breaking loop');
      try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: 'R16: maxRounds=' + maxRounds + ' 到达上限, 已收口.' }) + '\n\n'); } catch (e) {}
      // 如果最后一轮没调工具且 finalText 为空, 留个错误信
      if (!finalText) {
        finalText = '[⚠️ maxRounds=' + maxRounds + ' 到达上限但未完成任务. 请简化任务或拆步骤]';
        _emitStreamDelta(res, '\n\n' + finalText, '', 0);  // 2026-07-26: 统一 stream_delta 通道
      }
      break;
    }
  }
  // 2026-10-23 (第 67 批): 主循环体正常跑完 (break 也算) —— 末尾那份权威落盘会接手,
  //   finally 里那份兜底就不用写了 (少写一次 = 少一次「旧版盖新版」的机会)。
  _loopBodyCompleted = true;

  } finally {
    // R16 修 (P2-A): finally 收口 — throw / break / 正常退出 都会跑
    console.log('[j2] loop ended, nativeRounds:', rounds, 'legacyRounds:', _legacyRounds, 'taskDoneCalled:', taskDoneCalled, 'finalText len:', (finalText || '').length,
      // 2026-10-23 (第 64 批): 超时抢救痕迹 —— 这一轮是不是靠 partial 续上的,
      //   以及续想了几次。排查「为什么这轮这么久」先看这两个数。
      'timeoutSalvaged:', _timeoutSalvaged, 'timeoutResumes:', _timeoutResumeCount);
    // 2026-10-14: 将灵 trace 结算 (把灵跑完 = 这条 trace 的终点)。
    // 放在 finally: 抛异常/abort/maxRounds 撞顶都要留痕, 半截的运行恰恰最需要复盘。
    if (_roleTrace) {
      try {
        _emitGrounding(_roleTrace, finalText);
        _roleTrace.event('result', {
          runtime_status: taskDoneCalled ? 'done' : 'incomplete',
          rounds: rounds,
          chars: String(finalText || '').length,
          tools: toolsUsed,
          duration_ms: Date.now() - _roleT0,
        });
        _roleTrace.finish(taskDoneCalled ? 'done' : 'incomplete');
      } catch (_) {}
    }
    if (_mainTrace) {
      try {
        _emitGrounding(_mainTrace, finalText);
        _mainTrace.event('result', {
          rounds: rounds,
          chars: String(finalText || '').length,
          tools: toolsUsed,
          duration_ms: Date.now() - _mainT0,
          task_done: taskDoneCalled,
        });
        _mainTrace.finish(taskDoneCalled ? 'done' : 'incomplete');
        require('./run_trace').unregisterSessionTrace(_sessionId);
      } catch (_) {}
    }
    // 2026-10-09 P0 (老板报"会话 61554610 排查"): 主会话从来没落盘过。
    // 根因: 两个 _persistSession 调用点都在循环体内 — legacy 在每轮后 (L1017),
    // native 只在"执行完工具"之后 (L2184)。对话以纯文本收尾(没工具调用)时两个点都不经过,
    // finally 只记日志不落盘 → 整轮对话在磁盘上不存在, 刷新/重启即丢。
    // 实测: 2026-10-08 的 desktop-1791461554610 对话跑了 26 分钟子 agent, 主会话文件不存在,
    // ~/.pangu-data/sessions/ 里最新文件停在 10-02。子 agent 账本照写, 只有主会话丢。
    //
    // 2026-10-23 (第 67 批): 这份落盘降级成**异常兜底**。
    //   它原来跑在**答案定稿之前** ⇒ 盘上存的是重写前那一版
    //   (现场 b66-bridge-live-1792743482848: 屏上 415 字符、盘上 723 字符, 两个版本)。
    //   现在: 正常路径的落盘挪到函数末尾 (答案定稿之后, 那里才有「屏上那段」);
    //   这里只在**主循环抛异常 / 中断**时才写 —— 那种情况下末尾那段根本走不到,
    //   不写就等于整轮对话蒸发 (2026-10-09 P0 那个老事故就是这么丢的)。
    if (!_loopBodyCompleted) {
      await _persistFinalAnswer();
    }
    // R17 修: silent failure 实时信号 → router reliability 维度 (LM Studio 本地模型返 200 + 空 content 真信号)
    // 触发条件: (1) taskDoneCalled=false (没标完成) (2) finalText 空 (3) 至少跑过 1 轮 (排除"用户立刻 abort"等无 round 边缘 case)
    // 与 STATUS_FOUNTAIN_GUARD 互补 (状态喷泉是重复输出, silent fail 是空输出)
    // R18 修 (Kimi K3 legacy 路径输出 2622 字符没 task_done — "非空不收口"也是 silent fail):
    // finalText 非空但没 task_done → 同样记录 silent fail (legacy 路径纯文本回答没收口)
    // 2026-09-07: ENABLE_ROUTER_DEMOTE 守门 — 主人关闭时不写降权, 避免把已挂模型彻底打死
    if (isRouterDemoteEnabled() && !taskDoneCalled && (rounds > 0 || _legacyRounds > 0)) {
      const _isSilent = !finalText || finalText.length === 0;
      const _isOrphan = finalText && finalText.length > 0 && !taskDoneCalled;  // R18: 非空没 task_done
      if (_isSilent || _isOrphan) {
        try {
          if (_smartRouter && _smartRouter._recordSilentFail) {
            _smartRouter._recordSilentFail(model && model.id);
            console.warn('[j2] R17/R18 silent-fail detected, recorded model:', model && model.id, 'silent=' + _isSilent, 'orphan=' + _isOrphan, 'finalText=' + ((finalText||'').length));
          }
        } catch (_) {}
      }
    }
  }

// 2026-10-23 (第 67 批): 「答案定稿区」整段包进 try —— 这段里有 summary 重写、
//   守卫改写、对齐重答、最终 emit, 它们**都在 finally 之后**, 也就是在
//   「答案定稿」这个时刻。落盘点必须落在它们**后面**, 落的内容必须是**屏上那段**。
//   这一段没有重新缩进 —— 缩进变了 600 行 diff 就没法看了, 而 JS 不在乎缩进。
//   末尾那个 catch 是兜底: 这段里任何一处抛异常, 落盘也不能跟着丢。
try {
// §0.56 修: task_done / abort 后清 _state (防 Map 内存累积, 老 session 不污染新 request)
try {
  if (taskDoneCalled || userAborted) {
    if (_j2SessionStates.has(_sessionId)) {
      _j2SessionStates.delete(_sessionId);
      console.log('[j2] §0.56 cleared session state for', _sessionId);
    }
  }
} catch (_) {}

// R16 修 (Bug A): plan_failed / approved / rejected 永不重置 → 任务不干净进入下一轮
// task_done / abort / maxRounds 收口 / fountain detect 后都 reset planState flag
// 保留 planState 对象但所有 flag 清零, 下一轮走全新路径
function _resetPlanFlags(state) {
  if (!state || !state.planState) return;
  state.planState.pendingPlan = null;
  state.planState.approved = false;
  state.planState.rejected = false;
  state.planState.plan_failed = false;
  state.planState.startedAt = Date.now();
}
try {
  // task_done / abort / fountain / maxRounds 4 处都调
  _resetPlanFlags(_state);
  console.log('[j2] R16 reset plan flags for', _sessionId);
} catch (_) {}

 // 修: 如果 loop 结束但没有任何 finalText,但已经执行了工具,强制追加一程总结
  // §0.62 W2.2: think-strip middleware 双轨决策对比 (mw 仅日志对比, 实际 strip 仍由旧 inline 处理 — 避免双 strip)
  const _tsCtx = { finalText, allowThinkFallback: false };
  _middleware.run('pre-finalize', _tsCtx);
  const _tsWouldStrip = finalText && finalText.includes('<think>');
  const _tsMwStripped = !!_tsCtx.thinkStripped;
  if (_tsMwStripped !== _tsWouldStrip) console.warn('[j2-mw] W2.2 think-strip 决策不一致: mwStripped=' + _tsMwStripped + ' legacyWouldStrip=' + _tsWouldStrip + ' mwFinalLen=' + (_tsCtx.finalText || '').length);
  // think 标签污染 finalText 时先剥离 (MiniMax-M3 末轮只输出 <think> 会把思考当答案, 绕过 lip-service 检查)
  if (finalText && finalText.includes('<think>')) {
    const _stripped = finalText.replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/<think>[\s\S]*$/g, '').trim();
    // 2026-08-02 修: MiniMax-M3 整轮输出全是 <think> (思考即全部) 时 strip → 0 字 → Silent Failure 冤案
    // 老板标准: 有真内容就给主人看, 不判失败 — strip 空了就用 think 内文兜底
    let _final = _stripped;
    if (!_final && finalText.trim()) {
      _final = finalText.replace(/<\/?think>/g, '').trim();
      console.warn('[j2] finalText think-only fallback:', finalText.length, '->', _final.length);
    }
    if (_final !== finalText) { console.warn('[j2] finalText think-strip:', finalText.length, '->', _final.length); finalText = _final; totalChars = _final.length; }
  }
  // Recovery for streaming models: a valid post-tool answer can be present in
  // the last assistant message even when the stream parser suppressed its
  // delta (for example after a tool block or orchestration-leak guard). Do not
  // convert that real answer into a false silent failure.
  if (!finalText && toolsUsed.some(n => n !== 'task_done')) {
    const candidates = messages.filter(m => m && m.role === 'assistant' && typeof m.content === 'string')
      .map(m => m.content.replace(/<tool[\s\S]*?<\/tool>/g, '').trim())
      .filter(Boolean)
      .reverse();
    for (const candidate of candidates) {
      if (_isOrchestrationLeak(candidate)) continue;
      const recovered = guardFinalText(candidate);
      if (recovered) {
        finalText = recovered;
        totalChars = recovered.length;
        console.warn('[j2] recovered post-tool answer from assistant message:', recovered.length);
        break;
      }
    }
  }
 // 2026-08-02 修 (老板 04:12 实证): maxRounds 收口时 finalText 是 13 字旁白 ("两个文件读到了空内容,重读")
 // — !finalText 条件漏掉短旁白 → 总结不触发, 老板拿到 13 字垃圾当答案
 // 修: 调过工具但 final 短于 120 字 → 也走 summary (总结 LLM 基于真工具数据重答, 短真答案不受影响)
 const _SUMMARY_LIP_RE = /先调(?:工具|子)?|立即补上|会调|嘴说|不靠嘴|马上调|这就去|下面调|现在调|动手调|立即执行|调工具拿(?:真实|真)?数据|探针|再补|继续深挖|继续排查|摸清|到手|先查|先并发|先发|先拉|拿(?:量化|真|真实)?数据/;
 // Tool results are evidence, not a user-facing completion. Older runs could
 // leak the fallback string "工具已执行，以下是原始结果" into finalText;
 // treat that (and equivalent raw JSON/file listings) as unfinished so the
 // mandatory summary pass gets a chance to produce the actual answer.
 const _RAW_EVIDENCE_RE = /工具已执行[，,。 ]*以下是原始结果|原始结果[：:]|"(?:name|path|type)"\s*:/i;
 const _needsSummary = !finalText || finalText.length < 10 || _looksLikeEmptyPlan(finalText) || _SUMMARY_LIP_RE.test(finalText) || _RAW_EVIDENCE_RE.test(finalText);
 if (toolsUsed.length > 0 && _needsSummary) {
    try {
      // R80-ext: 强化 summary prompt, 治嘴说型
      // 老板 14:24 实证: LLM 调了 6 工具但又嘴说 "先调工具", summary LLM 也会学
      // 修: 强制列已调工具 + 强调嘴说就是失败 + 禁止再调工具
      const _usedNames = toolsUsed.filter(n => n !== 'task_done').join(', ') || '(无)';
      // 2026-10-23 (第 67 批): 这条「已调工具…」是**内部脚手架**, 不是主人说的话。
      //   它只给这一次 summary 调用看, **不进 messages** ——
      //   进了的话落盘文件里会留下一段主人从没说过的话, 下一轮恢复时模型会以为主人催过它,
      //   而那一段也从来不是屏上说过的话 (第 67 批另一半修的就是「屏上/盘上不是同一段」)。
      const _sumMessages = messages.concat([{ role: 'user', content: '已调工具: ' + _usedNames + ' (共 ' + toolsUsed.length + ' 次)。\n\n请直接基于以上工具的返回结果,给主人一个简洁、完整的最终答案。\n**禁止**输出"先调工具/立即补上/嘴说没用"等承诺型空话 — 必须给真数据。\n**禁止**再调用任何工具 — 只输出最终总结文本。' }]);
      // R13 修: 用 _callLLMWithTimeout (summary 路径也走超时)
      // 2026-08-02 修 (老板: 不管什么模型都必须流式): summary 轮也走 onText 流式 — 长总结不再整段弹出
      // final 事件仍会发 (前端替换 + 复述守卫), 不会重复
      let _sumStreamed = '';
      const result = await _callLLMWithTimeout(_sumMessages, model, [], {
        res, sessionId: opts.sessionId,
        onText: (d) => { _sumStreamed += d; _emitStreamDelta(res, d, _sumStreamed, Math.ceil(_sumStreamed.length / 1.5)); },
        soulScope: _soulScope,
        callableTools: [],   // 第 80 批: 收口调用一个工具都调不到 ⇒ 清单整块不出
      });
      const isAnthropic = _isAnthropicModel(model);
      const summary = isAnthropic
        ? (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
        : (result.choices?.[0]?.message?.content || '');
      if (!summary) console.warn('[j2] SUMMARY_EMPTY raw:', JSON.stringify(result).slice(0, 800));
      if (summary) {
        finalText = guardFinalText(summary);
        totalChars = finalText.length;
        // 2026-07-26: 走 final 事件 (前端替换 + 复述守卫), 不再 chunk append
        emitFinalOnce(finalText);
      }
    } catch (e) {
      console.error('[j2] final summary failed:', e.message);
      evoError = e.message; evoSuccess = false;
    }
  }

 // §0.61 W2.1: silent-fail middleware 检测 (双轨 — 与旧 inline 决策对比日志)
  const _mwCtx = { finalText, toolsUsed, taskDoneCalled, rounds, maxRounds, looksLikeEmptyPlan: _looksLikeEmptyPlan };
  _middleware.run('post-round', _mwCtx);
  const _legacySilent = !taskDoneCalled && (!finalText || finalText.length <= 20 || (_looksLikeEmptyPlan(finalText) && toolsUsed.every(n => n === 'task_done')));
  if ((!!_mwCtx.silentFail) !== _legacySilent) console.warn('[j2-mw] W2.1 silent-fail 对比: mw=' + !!_mwCtx.silentFail + ' legacy=' + _legacySilent + ' reason=' + (_mwCtx.silentFail && _mwCtx.silentFail.reason));
  // §0.64 (W4): silent-fail 触发时按 taxonomy 拿 hint 给前端 (诚实失败 + 友好提示)
  if (_mwCtx.silentFail) {
    try {
      const { AGENT_ERROR_CODES, getAgentStrategy } = require('./error_codes');
      const _strat = getAgentStrategy(AGENT_ERROR_CODES.SILENT_FAILURE);
      console.warn('[j2-taxonomy] §0.64 silent-fail strategy: fallback=' + _strat.fallback + ' maxAttempts=' + _strat.maxAttempts + ' hint=' + _strat.hint);
    } catch (_) { /* error_codes 没就跳过 */ }
  }
 // #5 Silent Failure: loop 跑完但什么真东西都没干, 明确告诉用户"我搞不定"
  // 旧版缺陷: maxRounds 用完 → break → 设置 evoSuccess=false → 但用户只看到 event: done, 不知道 Pangu 实际没干活
  // 修法: 检测 (!taskDoneCalled && 几乎无 finalText) → emit SSE warning + 设 finalText 为可读的失败消息 + evoSuccess=false
  // R80 修: finalText 是空计划模板 + 0 真实工具 = 同样按 Silent Failure 处理 (不许把计划当成果)
  // `toolHistory` is appended immediately after a tool result is executed;
  // `toolsUsed` is a presentation/evolution list and can lag on a native
  // round that exits while processing the result. Use both so successful
  // tools cannot be reported as zero.
  const realToolsCalled = toolsUsed.filter(n => n !== 'task_done');
  const effectiveRealToolsCalled = realToolsCalled.length > 0
    ? realToolsCalled
    : toolHistory.filter(t => t && t.name && t.name !== 'task_done').map(t => t.name);
  // 普通短问答不需要 task_done, 也不应被包装成“任务未收口”。只有确实执行过工具、
  // 明确续跑或命中重任务时, 才进入 silent-failure 任务态收口。
  const _shouldReportSilentFailure = _isTaskExecutionRequest
    || realToolsCalled.length > 0
    || _isHeavyDigestTask(userInput)
    // No model content at all is a transport/model failure even for a short
    // conversational input; otherwise a dead endpoint quietly emits only done.
    || (rounds === 0 && !taskDoneCalled && !String(finalText || '').trim());
  // A real tool execution is already evidence that the turn did work. Some
  // models (notably MiniMax M3.1) omit the bookkeeping-only task_done call
  // after returning tool results. Do not turn that successful execution into
  // a user-facing Silent Failure. Keep the warning reserved for turns that
  // produced neither a completion signal nor a real tool call.
  if (_shouldReportSilentFailure && !taskDoneCalled && effectiveRealToolsCalled.length > 0
    && (!finalText || finalText.length <= 20 || (_looksLikeEmptyPlan(finalText) && toolsUsed.every(n => n === 'task_done')))) {
    finalText = finalText && finalText.length > 0
      ? finalText
      : '本轮已执行 ' + effectiveRealToolsCalled.length + ' 个工具，但模型没有生成收尾总结。工具结果已保留，可继续基于本轮结果处理。';
    totalChars = finalText.length;
    evoSuccess = true;
  }
  if (_shouldReportSilentFailure && !taskDoneCalled && effectiveRealToolsCalled.length === 0 && (!finalText || finalText.length <= 20 || (_looksLikeEmptyPlan(finalText) && toolsUsed.every(n => n === 'task_done')))) {
    // R16 修 (Bug K): legacy path finalText 兜底 — 加 reset plan_failed 标志
    try { _resetPlanFlags(_state); } catch (_) {}

    // 2026-08-24 老板拍: "自动判断 = 哑火就自动切, 本地死了切云端"
    // 请求内 fallback 链 — 当前模型 silent fail (超时/空输出) 时, 不再直接认输,
    // 按 router 给的 ranked 顺序切下一个模型重跑 (最多 2 次切换, 防链式烧 token)。
    // 触发点天然覆盖: STREAM_TOTAL_TIMEOUT / native→legacy 双失败 / 空计划模板。
    // 失败模型已被上方 finally 的 _recordSilentFail 记录 → router 30min 内降权, 下一请求不再选它。
    // 2026-09-07 主人拍: "关了自动选择, 现在还不成熟, 等以后再说"
    // ENABLE_SILENT_FAIL_FALLBACK 守门 — 主人翻 false 时, 哑火直接走下方 #5 Silent Failure 显式报失败, 不再切链。
    const _chain = Array.isArray(opts._modelChain) ? opts._modelChain : [];
    const _depth = opts._chainDepth || 0;
    // 2026-10-17 改判据 (老板: 「池里本地模型只剩一个 27B 不够分」→ 主模型一哑火整轮死):
    //
    // 原来这里第一道是 isSilentFailFallbackEnabled(), 而它在 j2_model_policy.js 里被硬编码
    // `return false` —— 于是本分支 100% 不可达。加上 message-stream 传的是字面量 `_modelChain: []`
    // (全仓唯一生产注入点), 这段 chain-switch 是**双重死代码**, 连测试都测不到:
    // r24-chain-switch.test.js 直接调 `_runAgentLoopLegacyStream` 并手工塞链, 两道门全绕开。
    // 后果与模型池大小无关: 主模型哑火 = 整轮直接死, 你配了几个模型都不起作用;
    // 而 model_config_guard 每次启动还在校验并"修好" llm.fallback_chain —— 维护着一份没人读的
    // 配置, 这是「注释 ≠ 隔离」的又一例。
    //
    // 换掉的**只是这一道**, 产品决定没动:
    //   · 自动选模型 (autoModelSelection) 仍硬关 —— 2026-09-07「关了自动选择」依然有效,
    //     主模型永远是你选的那个, 这里只在他**已经哑火之后**才换下一个。
    //   · 没配 fallback_chain → _chain 为空 → 本分支不进, 行为与今天逐字节一致。
    //   · 配了 → 链非空 = 主人显式表达过"哑了就用这些", 于是这段代码第一次真的能跑。
    // 闸门 = env 没关 **且** 链非空。两个条件缺一不可, 但**都必须是活的**:
    //   · 链非空 = 主人显式配过兜底 (第一个条件, 没配就一个模型都不换)
    //   · env     = 运行时逃生阀 (PANGU_SILENT_FAIL_FALLBACK=0 立刻全关, 不必发版)
    //
    if (isSilentFailFallbackEnabled() && _chain.length > 0 && _depth < 2) {
      const _next = _chain[0];
      console.warn('[j2] model-chain switch: ' + (model && model.id) + ' 哑火 → 切 ' + _next.id + ' (剩余链 ' + (_chain.length - 1) + ', depth ' + (_depth + 1) + ')');
      _clearHeartbeat();  // §0.58: 切模型前清旧 timer, 否则递归会泄漏
      // 失败 attempt 也写一条 evo 记录 (success=false), 保持 L1 成功率统计诚实
      try {
        const _chainRecord = {
          ts: new Date().toISOString(), endpoint: '/api/pangu/agent/stream', mode: 'j2-chain-switch',
          session_id: _sessionId,
          input: String(userInput || '').slice(0, 500),
          provider: String(model.provider || 'openai'), model: String(model.id),
          tool_calls_total: toolsUsed.length, tool_names: toolsUsed.slice(0, 10),
          total_chars: 0, rounds, success: false, runtime_status: 'failed',
          real_tool_calls_total: toolsUsed.filter(n => n !== 'task_done').length,
          duration_ms: Date.now() - agentStartTime, error: 'SILENT_FAIL_CHAIN_SWITCH_TO_' + _next.id,
          final_text: '',
        };
        if (typeof recordEvolution === 'function') recordEvolution(_chainRecord);
        else require('./evolution_record')._recordEvolution(_chainRecord);
      } catch (_) {}
      try { res.write('event: model_switch\ndata: ' + JSON.stringify({ from: model && model.id, to: _next.id, reason: 'silent_failure', attempt: _depth + 1 }) + '\n\n'); } catch (_) {}
      try { _emitStreamDelta(res, '\n\n🔄 ' + (model && model.id) + ' 无响应, 自动切换 ' + _next.id + ' 重试…\n', '', 0); } catch (_) {}
      // 剥掉本轮可能残留的空调 assistant 消息, 避免污染下一次尝试的上下文
      const _clean = messages.filter(m => !(m && m.role === 'assistant' && !m.content && !m.tool_calls));
      return _runAgentLoopLegacyStream(_clean, _next, req, res, { ...opts, _modelChain: _chain.slice(1), _chainDepth: _depth + 1, resumeCheckpoint: false });
    }

    // 2026-09-16 老板拍: 文案改诚实 — 不是"我无法完成"(吓人死路), 是"本轮没收口, 进度已落盘, 继续可断点续跑"。
    // 有 step 分母 (③ 拆解状态机) 时明确说哪步卡住, 让主人知道该说"继续"而不是重发整个任务。
    let _planSnapshot = null;
    try { _planSnapshot = require('./plan_state').loadPlan(_sessionId); } catch (_) {}
    const _sf = _buildSilentFailureMsg(rounds, effectiveRealToolsCalled, _planSnapshot);
    const failureMsg = _sf.msg;
    console.warn('[j2] SILENT_FAILURE:', failureMsg.slice(0, 200));
    try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: failureMsg }) + '\n\n'); } catch (e) { console.warn('[j2-stream] res.write error:', e.message); }
    if (!finalText) { finalText = failureMsg; totalChars = failureMsg.length; }
    evoSuccess = false;
    // 2026-09-12 验收补: silent failure 也落 task checkpoint, 让用户能看 silent fail 真状态
    try {
      const tc = require('./task_checkpoint');
      tc.saveTaskCheckpoint(_sessionId, {
        goal: String(userInput || '').slice(0, 500),
        status: 'failed',
        last_round: rounds,
        messages_count: messages.length,
        tools_used: toolsUsed.slice(-10),
        next_action: 'silent_failure: ' + failureMsg.slice(0, 200),
        updated_at: new Date().toISOString(),
      });
    } catch (_) { /* silent fail 不阻塞 */ }
    // 2026-09-16: silent failure 也写交接卡 — 文案说“开新对话秒接上”才真成立
    try {
      const _ho = require('./handoff');
      if (!_state.handoffNotified) {
        const _wr = _ho.writeHandoff(_sessionId, { rounds, inputTokens: _getSessionInputTokens(_sessionId), reason: 'silent_fail' });
        if (_wr.ok) _state.handoffNotified = true;
      }
    } catch (_) { /* 交接卡失败不阻塞 */ }
  }

  // 2026-09-12 e2e 修: 成功路径收尾 task checkpoint — 每轮都存 status='active',
  // 但成功时不标 done → 僵尸 active 任务堆积, listActiveTasks/重启恢复会误捞已完成任务。
  if (taskDoneAccepted) {
    try {
      const tc = require('./task_checkpoint');
      tc.saveTaskCheckpoint(_sessionId, { status: 'done', next_action: '', updated_at: new Date().toISOString() });
    } catch (_) { /* 收尾不阻塞 */ }
  }

  // §0.57: 正常完成 / 失败都清 _state.activeAbort (避免新 round 误接管)
  if (_state.activeAbort === _sessionAbort) _state.activeAbort = null;
  _clearHeartbeat();  // §0.58: 正常路径也要清 timer
  const durationMs = Date.now() - agentStartTime;
  // Final text is accepted only after alignment; task_done is a request, not proof.
  // 2026-09-12 五次修: 有产出文件的大体量任务 — partial 交付直接收口, 不走词法对齐门
  // (旧 bug: finalText 被 guardFinalText 清空 → 掉 noSummaryFallback → "没有通过核验")
  // 2026-09-12 七次: 证据主判收口 — 真产出证据 + 锚定 tool_result → 用模型自己的 summary 收口 (带剩余清单)
  const _earlyArtifact = _hasArtifactEvidence(_taskDoneStatusText || String(finalText), _evidenceText());
  // 2026-09-13 (老板 16:08 实案): 系统自产熔断/守卫文案 (⚠️ [盘古 ...] / [SYSTEM_GUARD] ...)
  // 不过对齐门 — 它们不是模型答案, 是系统抓到的诚实死因。再拦一遍会把真话灭口:
  // 实案 = FAKE-OUTPUT 熔断文案因引用"已落盘/已写入"字样命中 _FAKE_DELIVERY_RE,
  // 被替换成无信息模板 "我的结论未通过证据核验", 主人连死因都看不到 ("这就是你说的好了")。
  const _SYS_GUARD_TEXT_RE = /^(⚠️\s*\[盘古|⚠️\s*我的结论|\[SYSTEM_GUARD\])/;
  // 2026-10-24 (第 74 批): 拆解轮身份标记 —— 提到**函数作用域**, 因为两处都要用:
  //   ① 终局 (下面那个 else-if): 拆解轮**压根不调** guardFinalText (词法对齐门)
  //   ② ALIGNMENT_RETRY while 之前 (更下面): 兜底清 finalAlignmentBlocked
  // 声明写在 ① 那个分支的块**里面**会让 ② 拿不到 (块作用域) ⇒ 运行时 ReferenceError。
  // 判据用 planOnlyDispatch, 不复用 suppressOutcomeRecord: 后者子 agent 也带,
  // 而子 agent 的产出**要**进 synthesis, 必须照审。
  const _isPlanOnlyTurn = Boolean(opts && opts.planOnlyDispatch);
  // 2026-09-17 全修 (#1/#2 配套): SILENT_FAILURE 收口文案 (⚠️ [本轮未收口] … 进度已落盘) 是诚实 partial 交付,
  // 不是对齐失败 — 旧路径把它并进对齐拦桶 (finalAlignmentBlocked=true), verdict 判 partial→前端盖 ✗。
  // 现在: 识别后清对齐标志 + 标 evoSuccess=false (本轮没收口, L1 诚实记 partial), 走 partial 收口。
  const _silentFailText = _mwCtx.silentFail || (!taskDoneCalled && /^⚠️\s*\[本轮未收口\]/.test(String(finalText || '').trim()));
  if (_silentFailText) {
    finalText = String(finalText).trim();
    totalChars = finalText.length;
    finalAlignmentBlocked = false;
    evoSuccess = false;
    console.warn('[j2] SILENT_FAIL_PARTIAL: 诚实收口文案走 partial 收口, 不盖 ✗');
  } else if (finalText && _SYS_GUARD_TEXT_RE.test(String(finalText).trim())) {
    finalText = String(finalText).trim();
    totalChars = finalText.length;
  } else if (finalText && _earlyArtifact) {
    finalText = _taskDoneStatusText || String(finalText).trim();
    totalChars = finalText.length;
  } else if (taskDoneAccepted && _taskDoneStatusText) {
    // 2026-10-01 修 (S1 实锤): task_done 已被验收 = 本轮交付已确认, 收口文本应取 task_done 的 summary,
    // 而不是模型最后那句零碎话。旧行为: 模型最后只说「交付。」(3 字, 过不了对齐门) → finalText 被清空
    // → 掉 _noSummaryFallback → 明明 task_done 通过、final 事件也已把 summary 发给主人, 内部却收成 ⚠️ 模板。
    // 危害: 该 ⚠️ 文本在 runtime_verdict 里被判 completed/success=true (16/16 污染 success 桶)。
    finalText = _taskDoneStatusText;
    totalChars = finalText.length;
  } else if (finalText) {
    // 2026-10-24 (第 74 批, 实跑取证): **拆解轮 (planOnlyDispatch) 不判词法对齐门**。
    //
    // 现场 (真实前端会话, alignment-blocked.jsonl 里 20 条 desktop-* 全是它):
    //   desktop-1792407402764#main-plan  "已拆 2 刀并行取证（架构真源 + 运行时状态）…"
    //   desktop-1792418689788#main-plan  "已派 2 刀并行（li 排盘解读 / kun 独立核对…）"
    //   desktop-1792419356913#main-plan  "已派出 3 刀（大运+取用 / 流年断事 / 独立核验）…"
    //   → 每一条都被判 "no_summary_fallback" + "no_summary_fallback_best_spoken_also_blocked"
    //     **各记一笔** (同一次执行记两笔账), 而主人实际看到的是拆解轮输出**根本没进主气泡**
    //     (它写进 _makeSinkRes sink, j2_dispatcher.js:1812)。
    //
    // 为什么那道门不该审它 (机制层):
    //   拆解轮的唯一工具是 dispatch_subagents, llm-cost 里 tools=0 ——
    //   那个工具产出的**就是这份拆解本身** ⇒ 拆解轮**结构上不可能有"工具证据"**。
    //   门判它"结论没过证据核验"是审错了对象。
    //
    // ⚠️ 为什么 2026-10-18 那次修**没修好** (本批现场挖出来的):
    //   那一版把跳过逻辑放在**终局 guardFinalText 之后**:
    //     5153  finalText = guardFinalText(finalText)   ← 在这里被拦 → finalText = ''
    //     5186  if (_isPlanOnlyTurn && finalAlignmentBlocked) → 只清**标志**, 没还原**文本**
    //     5258  if (realToolsUsed.length > 0 && !finalText) → 甩 ⚠️ 模板
    //   ⇒ 顺序反了: 跳过逻辑执行时, finalText **已经被清空了**, 它清的那个标志救不回任何东西。
    //   这就是"代码里明明写了跳过, 现场还是被拦"的真原因 —— 逻辑在, 但够不到。
    //
    // 修法: 判据提前到**终局判对齐之前**, 拆解轮**压根不调** guardFinalText。
    //   拆解轮的文本留着 (它进 sink, 不给主人看, 但要留在 messages/账本里供 dispatcher 读拆解)。
    if (_isPlanOnlyTurn) {
      console.warn('[j2] ALIGNMENT_SKIP: 拆解轮 (planOnlyDispatch) 不判词法对齐门 — '
        + '它的产出是拆解不是结论 (唯一工具 dispatch_subagents 的产出就是这份拆解), '
        + '且写进 sink 不给主人看');
      finalAlignmentBlocked = false;
    } else {
      finalText = guardFinalText(finalText);
    }
    totalChars = finalText.length;
  }
  const realToolsUsed = effectiveRealToolsCalled;
  // 2026-09-12 铁律23 (易经营案): 大体量任务 partial 交付 — 落了产出文件 (write_file/file_edit) 且
  // 体量预检命中时, 部分进度 + 剩余清单 = 有效交付, 不再逼 ALIGNMENT_RETRY 重答全集。
  const _wroteArtifact = toolsUsed.includes('write_file') || toolsUsed.includes('file_edit') || toolsUsed.includes('apply_patch');
  // 2026-09-12 七次: 降级对齐目标 — 有真产出证据 (写了文件 + 锚定 tool_result 真数字) 即合法交付。
  // 不再要求 _taskDonePartialOk 前置: 证据本身就该是判据, 不该靠"任务类型嗅探"放行 (治 Round 3/4 真因)。
  const _hasArtifactDelivery = _wroteArtifact && realToolsUsed.length > 0
    && (_hasArtifactEvidence(_taskDoneStatusText || finalText, _evidenceText()) || _taskDonePartialOk);
  const _partialDeliveryOk = _hasArtifactDelivery;

  // 2026-09-11 ALIGNMENT_RETRY (09-11 16:09 实案: 老板问 "全部都消化完了?", 模型 "是" 被对齐门拦,
  // 之后没人基于证据重答, 直接掉模板文案收工 — 门做对了, 收口烂了):
  // 终局结论被证据核验拦下 + task_done 未 accepted → 逼 LLM 基于证据重答 (共享上限 2, 防烧 token);
  // 重试仍被拦 → 落下方诚实 fallback, 不再假装完成
  // 2026-09-12 (老板 19:22 实案): 0 工具纯对话轮跳过重答 — 没有工具证据可"基于",
  // 重答 2 轮只会再被词法门拦一遍, 白烧 2 次 LLM 调用后照样甩 ⚠️ 模板。
  //
  // 2026-10-18 (现场 verify-mm-run2-20261018, 与 desktop-1792306846566 同款):
  // 这道门去审了**拆解轮** (j2_dispatcher 的 planOnlyDispatch)。那轮的输出是
  // "已派出 3 刀并行取证…" —— 一份**拆解**, 不是结论, 而且写进 sink res 就扔了,
  // 主人一个字都看不见。
  //
  // 但门不知道这件事, 于是判它"结论没过证据核验", 逼它基于工具证据重答两次。
  // 而拆解轮**结构上就不可能有证据**: 它的 toolsAllowed 只有 dispatch_subagents
  // 一个工具 (llm-cost 里 tools=0), 那个工具产出的就是那份拆解本身。
  // 于是两次重答注定再被拦 —— 稳定烧掉两次 LLM 往返 (各 ~17k 输入) 换零收益,
  // 界面上还多出两行 ⚠️ 警告, 看起来像"盘古出问题了", 其实它只是被审错了对象。
  //
  // 判据用 planOnlyDispatch, 不复用 suppressOutcomeRecord: 后者子 agent 也带
  // (子 agent 的产出**要**进 synthesis, 得审), 只有拆解轮是不该被审的。
  //
  // 2026-10-24 (第 74 批): `_isPlanOnlyTurn` 已提前到终局 guardFinalText **之前**声明
  // (见上面那个 else-if 分支) —— 因为 2026-10-18 那版把跳过逻辑放在**之后**,
  // 执行时 finalText 早被清空了, 清标志救不回任何东西 (现场 20 条 desktop-* 全被拦)。
  // 这里保留的是**兜底**: 4912(恢复) / 4957(summary) 两条路径也可能置位
  // finalAlignmentBlocked, 拆解轮同样不该被它们带进 honest fallback。
  if (_isPlanOnlyTurn && finalAlignmentBlocked) {
    console.warn('[j2] ALIGNMENT_SKIP: 拆解轮 (planOnlyDispatch) 不判对齐 — '
      + '它的产出是拆解不是结论, 且写进 sink 不给主人看');
    finalAlignmentBlocked = false;
  }
  while (!_isPlanOnlyTurn && _alignNudges < 2 && finalAlignmentBlocked && !finalText && !taskDoneAccepted && !_partialDeliveryOk && realToolsUsed.length > 0) {
    _alignNudges++;
    console.warn('[j2] ALIGNMENT_RETRY: final 被证据核验拦, 逼基于证据重答 #' + _alignNudges);
    // 2026-10-18 (老板截图): 这条 warning 在界面上**一字不差地出现两次**,
    // 时间戳也一样 —— 主人分不清"重试了两次"还是"界面自己画重了"。
    // 其实这是 while (_alignNudges < 2) 的两次合法重试, 服务端 console 里明明打了
    // #1 / #2, 但**没把次数发给前端**。把次数带上去, 两行才读得出区别:
    // 两行一样的文案本身就是 bug —— 它把信息变成了噪声。
    try {
      res.write('event: warning\ndata: ' + JSON.stringify({
        warning: '最终结论未通过证据核验, 已要求基于工具证据重答 (第 ' + _alignNudges + ' 次).',
        attempt: _alignNudges, maxAttempts: 2,
      }) + '\n\n');
    } catch (e) {}
    // 2026-10-23 (第 67 批): 同 summary 那条一样 —— 这条 system 是**内部脚手架**,
    //   只给这一次重答看, 不进 messages (落盘文件里不该出现主人/系统从没说过的话)。
    const _alignMessages = messages.concat([{ role: 'system', content: '[ALIGNMENT_RETRY] 你上一条最终结论未通过证据核验 (断言与工具/会话证据不一致, 例: 夸大 "全部/已完成")。重答: (1) 只报核实过的事实, 给实数 (例: "7 主题中仅 1 篇有总结"); (2) 未核实项明确写 "未核实"; (3) 禁止重复原结论, 禁止新增未核实断言。' }]);
    let _retryText = '';
    let _retryResult = null;
    try {
      _retryResult = await _callLLMWithTimeout(_alignMessages, model, [], {
        res, sessionId: opts.sessionId,
        soulScope: _soulScope,
        callableTools: [],   // 第 80 批: 收口调用一个工具都调不到 ⇒ 清单整块不出
      });
      _retryText = isAnthropic
        ? ((_retryResult.content || []).filter(b => b.type === 'text').map(b => b.text).join(''))
        : (_retryResult.choices?.[0]?.message?.content || '');
    } catch (e) { console.warn('[j2] ALIGNMENT_RETRY call failed:', e.message); }
    // 2026-10-01 修: 重答调用原来完全不进 metrics — recordTokenUsage 只写在主循环体里,
    // 这两次烧的 token 在面板上不可见 (9/30 那轮就少算了)。补记, 与主循环同口径。
    try {
      if (_retryResult) {
        const _ru = (_retryResult.usage || (_retryResult.choices && _retryResult.choices[0] && _retryResult.choices[0].usage)) || null;
        require('./metrics').recordTokenUsage({
          session_id: _sessionId, round: rounds, tool_name: 'llm_call',
          model: (model && model.id) || 'unknown',
          input_tokens: _ru ? (_ru.prompt_tokens || _ru.input_tokens || 0) : _estimateInputTokens(messages),
          output_tokens: _ru ? (_ru.completion_tokens || _ru.output_tokens || 0) : Math.ceil(String(_retryText || '').length / 1.5),
          cache_hit_tokens: _ru ? (_ru.cache_read_input_tokens || _ru.cached_tokens || 0) : 0,
          ts: Date.now(),
        });
      }
    } catch (_) {}
    if (_retryText) {
      const _recoveredAligned = guardFinalText(_retryText, true);
      // 2026-09-12 修 (老板 18:50 实案: 答复完整交付却 ✗ 任务执行失败):
      // 重答通过核验即解锁 finalAlignmentBlocked — 旧逻辑只收文本不解锁,
      // 下游 verdict aligned=false → status=failed, 好答案背失败标记。
      if (_recoveredAligned) { finalText = _recoveredAligned; totalChars = finalText.length; finalAlignmentBlocked = false; }
    }
  }
  // Tool results remain visible in the tool cards, but must never become the
  // chat answer. Raw JSON, OCR text, and command stdout are evidence for a
  // synthesis pass, not a user-facing fallback.
  const _toolEvidenceMessages = messages.filter(m => m && (m.role === 'tool' || (Array.isArray(m.content) && m.content.some(b => b && b.type === 'tool_result'))));
  const _userPaths = (userInput.match(/\/Users\/[A-Za-z0-9_\-]+(?:\/[\w\u4e00-\u9fff.\-]+){1,4}/g) || []).map(p => p.trim());
  const _toolCallText = toolHistory.map(t => JSON.stringify(t.args || {})).join('\n');
  const _userPathMissed = _userPaths.length > 0 && _userPaths.every(p => !(_toolCallText.includes(p) || _toolCallText.includes(p.split('/').pop())));
  // 2026-10-01 修 (9/30 实锤): 被门吃掉的答案原先**一点痕迹都不留** — finalText 被清空,
  // evolution 只记到那句 ⚠️ 模板, checkpoint 只到 r24, session md 只存模板句 →
  // 那 496 tokens 的原文永久查不到, 事后连"到底命中哪条规则"都无法证明。
  // 修: 把被拦下的原文 + 当时的输入/对齐问题/工具/轮次落 ~/.pangu/alignment-blocked.jsonl。
  const _auditBlocked = (reason) => {
    try {
      const _fs = require('fs'), _os = require('os'), _path = require('path');
      // 2026-10-26 第 100 批: 路径走唯一真源 (modules/state_paths.js)
      //   沙箱导出 PANGU_ALIGNMENT_AUDIT_FILE ⇒ 测试链不再往生产 ~/.pangu 根目录写审计文件。
      const _auditFile = require('./state_paths').alignmentAuditFile();
      const _dir = _path.dirname(_auditFile);
      if (!_fs.existsSync(_dir)) _fs.mkdirSync(_dir, { recursive: true });
      _fs.appendFileSync(_auditFile, JSON.stringify({
        ts: new Date().toISOString(), session_id: _sessionId, reason: String(reason || ''),
        rounds, tools_used: realToolsUsed, model: (model && model.id) || 'unknown',
        user_input: String(userInput || '').slice(0, 1000),
        alignment_question: _alignmentQuestion(userInput),
        blocked_final: String(_lastBlockedFinal || '').slice(0, 4000),
        align_nudges: _alignNudges, task_done_accepted: !!taskDoneAccepted,
      }) + String.fromCharCode(10));
      console.warn('[j2] ALIGNMENT_BLOCKED_AUDIT: blocked final -> ' + _auditFile + ' (len='
        + String(_lastBlockedFinal || '').length + ')');
    } catch (_) {}
  };
  // 2026-10-24 (第 74 批): reason 改成**参数** —— 同一次执行只能记一笔账。
  //
  // 现场 (真实前端会话, alignment-blocked.jsonl 里 desktop-* 20 条**每条都出现两次**):
  //   desktop-1792407402764#main-plan  reason=no_summary_fallback_best_spoken_also_blocked
  //   desktop-1792407402764#main-plan  reason=no_summary_fallback            ← 同一次执行
  // 原因: _bestSpoken 分支先调 _auditBlocked('no_summary_fallback_best_spoken_also_blocked'),
  //       然后调 _noSummaryFallback(), 而 _noSummaryFallback 内部**又**调了一次
  //       _auditBlocked('no_summary_fallback') ⇒ 一次执行, 两笔账。
  //
  // 为什么这个要修 (不只是"账本难看"):
  //   这份账本是我**唯一**的"哪一轮被拦了"索引 (§12.2: grep 命中 ≠ 证据,
  //   得按 session_id + reason 归因)。一次执行记两笔 ⇒ 按 reason 统计会**翻倍**,
  //   真实被拦次数被高估一倍, 而"被拦了多少"正是判断"答复门是不是在误杀"的唯一依据。
  const _noSummaryFallback = (reason) => {
    _auditBlocked(reason || 'no_summary_fallback');
    const scope = _userPathMissed
      ? '未确认工具是否访问了你指定的路径：' + _userPaths.join(', ') + '。'
      : '已执行相关工具，但最终总结没有通过核验。';
    return '⚠️ ' + scope + '\n原始命令和 OCR 结果已保留在工具记录中，不会当作聊天答复。请重新执行该任务以生成可核验的总结。';
  };
  // 2026-10-01 修 (9/30 实锤): 纯对话轮被"强逼 LLM 调工具"注入劫持 — 那个分支直接 continue,
  // 从不把模型这一轮的文本写进 finalText。实案链: 主人发"字幕製作人Zither Harp" (只是句备注, 不是任务)
  // → 模型第 1 轮给出 81 字**正常答复** (被丢弃) → 注入"请调用一个工具完成任务" → 模型调了毫不相干的
  // list_pangu_agents → realToolsUsed=1 → 收口条件成立 → 第 3 轮答案被对齐门拦 → 甩 ⚠️ 模板。
  // 净效果: 比不注入还差 —— 明明第 1 轮就答对了。
  // 修 (不动强逼逻辑本身, 只加安全网): 收口落空时, 回看 messages 里模型本轮已经说过的实质文本,
  // 拿它再过一次对齐门; 过了就用, 不再甩模板。9/30 那轮靠这条能救回第 1 轮的正常答复。
  const _bestSpoken = messages
    .filter(m => m && m.role === 'assistant' && typeof m.content === 'string')
    .map(m => String(m.content).trim())
    .filter(t => t.length >= 20 && !/^\[SYSTEM/.test(t) && !/^⚠️/.test(t) && !t.startsWith('本轮已真调'))
    .sort((a, b) => b.length - a.length)[0] || '';
  if (realToolsUsed.length > 0 && !finalText) {
    if (_partialDeliveryOk && _taskDoneStatusText) {
      // 大体量 partial 交付 — 落盘产出为准, 用模型自己的 summary 收口 (带剩余清单), 不再甩"重新执行"
      finalText = _taskDoneStatusText;
      totalChars = finalText.length;
    } else if (_bestSpoken) {
      const _recovered = guardFinalText(_bestSpoken, true);
      if (_recovered) {
        console.warn('[j2] BEST_SPOKEN_RECOVERY: 收口落空, 复用本轮模型已说过的实质答复 (len=' + _recovered.length + ')');
        finalText = _recovered;
      } else {
        // 2026-10-24 (第 74 批): reason 走参数, 一次执行只记一笔账 (原来记两笔)。
        finalText = _noSummaryFallback('no_summary_fallback_best_spoken_also_blocked');
      }
      totalChars = finalText.length;
    } else {
      finalText = _noSummaryFallback();
      totalChars = finalText.length;
    }
    finalAlignmentBlocked = false;
  }
  // 2026-09-12 (老板 20:26 实案): verdict 判定挪到下方所有终局决议 (CONVERSATIONAL_UNBLOCK /
  // noSummaryFallback / FAKE_TOOLCALL_FINAL) 之后 — 旧顺序在解锁交付前就判定,
  // 好文本被交付但 status 已盖 failed, 主人看到"好答案 + ✗"。

  let _contextLimit = null;
  try { _contextLimit = panguHelpers.getModelContextLength(model); } catch (_) {
    // Context metadata is telemetry, not a prerequisite for returning the
    // completed answer. Synthetic/custom models may not be in the registry.
  }
  const donePayload = JSON.stringify({
    rounds,
    tools_used: effectiveRealToolsCalled.concat(taskDoneCalled ? ['task_done'] : []),
    total_chars: totalChars ? Number(totalChars) : (finalText ? finalText.length : 0),
    model_used: model.id,
    device: (model.endpoint || '').includes('127.0.0.1') ? 'local' : 'cloud',
 // 状态栏用 context 字段
    context_used: panguHelpers.estimateMessagesTokens ? panguHelpers.estimateMessagesTokens(messages) : 0,
    context_limit: _contextLimit,
    elapsed_ms: durationMs
  });
  // 2026-09-12 (老板 19:22 实案): 0 工具纯对话轮 (纠正/确认/闲聊) 被核验门硬拦后,
  // 不再甩 ⚠️ 模板灭口 — 直接交付被拦原文。危险情形 (系统状态断言/自身问题凭印象答)
  // 由轮内 UNVERIFIED_CLAIM / SELF_REF 守卫负责 nudge, 终局只拦工具任务的嘴炮。
  // 2026-09-12 (老板 20:26 实案) 补: 假落盘/假改码声称不在解锁之列 —
  // "总结.md 1010→1106 行"全程 0 写工具纯编, 这种文本交付出去比 ⚠️ 更害人。
  const _FAKE_DELIVERY_RE = /(已(经)?(出|生成|画好|写好|保存|存好|落盘|写入|复制到|交付)(了|好|完成)?|文件.{0,8}(已|已经)(生成|写入|保存|落盘|就位)|已(经)?(修改|改完|改好|修复|实装|挂载|接入|替换|重构|优化)(了|成|到)?|(落盘|写入|产出|交付)\s*[:：])/;
  if (!finalText && finalAlignmentBlocked && realToolsUsed.length === 0 && _lastBlockedFinal && !_FAKE_DELIVERY_RE.test(_lastBlockedFinal)) {
    console.warn('[j2] CONVERSATIONAL_UNBLOCK: 0 工具对话轮, 交付被拦原文 (' + _lastBlockedFinal.length + ' chars)');
    finalText = _lastBlockedFinal;
    totalChars = finalText.length;
    finalAlignmentBlocked = false;
  }
  if (!finalText && (finalAlignmentBlocked || realToolsUsed.length > 0)) {
    // 2026-09-13 (老板 12:51 实案): 交付 ⚠️ 模板前必须留下被拦原文证据 — 否则死后排查
    // 连模型到底说了什么都查不到 (12:51 轮 5 轮 0 工具, 被拦叙事文本无处可查)。
    if (finalAlignmentBlocked) console.warn('[j2] ALIGNMENT_BLOCKED_DELIVERED: 0 工具终局交付 ⚠️ 模板, 被拦原文 (' + String(_lastBlockedFinal || '').length + ' chars): ' + String(_lastBlockedFinal || '').slice(0, 400));
    finalText = realToolsUsed.length > 0
      ? _noSummaryFallback()
      : '⚠️ 我的结论未通过证据核验（本轮 0 工具调用，没有证据支撑断言）。';
    totalChars = finalText.length;
    finalAlignmentBlocked = false;
  }
  // 2026-09-12 (老板 19:33 实案) 终局保险丝: 假工具调用文本 "(调用工具: X)" 无论走哪条
  // 路径漏到这里, 0 真工具执行就绝不交付 — 前端会把它渲染成工具卡永远转圈, 比 ⚠️ 更误导。
  if (finalText && realToolsUsed.length === 0 && /^[（(【\[]?\s*调用工具\s*[:：]/.test(finalText.trim())) {
    console.warn('[j2] FAKE_TOOLCALL_FINAL: 假工具调用文本在终局被拦, 未交付');
    finalText = '⚠️ [盘古 FAKE-TOOLCALL 熔断] 我把 "(调用工具: ...)" 写成了文字而没有发起真 tool_call, 工具实际没有执行。\n建议: 重发指令 (例: "用 memory_search 查 X"), 或换原生工具调用更稳的模型。';
    totalChars = finalText.length;
    evoSuccess = false;
  }
  // 2026-09-13 (21:55 实案): MiniMax 把 task_done 写成 <tool_call><invoke> XML 文本漏进 final —
  // 气泡直接显示原始 markup。剥壳: 有 <summary> 取 summary 正文, 否则剥净所有标签;
  // 剥完不足 10 字 → 诚实提示, 绝不交付原始 XML。
  if (finalText && /<tool_call>|<invoke[\s=]|<\/tool>/.test(finalText)) {
    const _sm = String(finalText).match(/<summary>([\s\S]*?)<\/summary>/);
    const _clean = (_sm ? _sm[1] : String(finalText).replace(/<\/?[a-zA-Z_][^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    console.warn('[j2] TOOLCALL_XML_LEAK: final 含工具调用 markup, 剥壳 ' + finalText.length + ' -> ' + _clean.length + ' chars');
    finalText = _clean.length >= 10 ? _clean : '⚠️ [盘古 XML 泄漏拦截] 模型把工具调用标记写进了答复正文, 已剥除。';
    totalChars = finalText.length;
  }
  // 2026-10-24 (第 75 批): 答复连续性还原**放在核验门之前** ——
  //   门看到的是**完整**的答复 (腰斩断点接回去之后), 不是从半句开始的残篇。
  //   放在门之后的话, 门会拿半句去判"有没有证据", 判出来的东西没意义。
  if (finalText && _replayRecord) {
    const _recPre = _applyContinuity(finalText);
    if (_recPre !== finalText) {
      finalText = _recPre;
      totalChars = finalText.length;
    }
  }
  // 2026-10-12 (老板拍"你没有修好" — 首轮纯图做题, 文字里没四柱, 事实块注不进来,
  // 第一稿十神标注仍是模型凭记忆算, 实测把 戊=伤官 写成食神): 出门核验门 ——
  // 本地查表核验十神/五行/旺衰断言 (基准优先用本轮 bazi_calc 的 sxtwl 权威盘,
  // 拿不到才退回从答案自己抽 —— 原来只有后者, 等于拿答案验答案) →
  // 有硬伤带事实块+硬伤清单强制重修一轮; 重修仍有硬伤附诚实标注。答对零开销。
  if (finalText && !_SYS_GUARD_TEXT_RE.test(String(finalText).trim())) {
    try {
      // 2026-10-23 第 60 批: 卦象门 + 命盘门**两份内联拷贝收成一份**
      // (modules/answer_gates.js)。原先这里各抄了一段, 与 j2_dispatcher._factGate
      // 已经漂开: 日志条件一个看 repaired、一个看 repaired||矛盾。
      // 「查出来有硬伤但重修没改掉」这种最该被看见的情况, 在只认 repaired 的那份里静悄悄。
      const _gates = require('./answer_gates');
      const _ask = _gates.buildAskFn(_deps._callLLMForAgent, model, {
        soulScope: _soulScope,
      });
      const _gated = await _gates.runAnswerGates(finalText, _ask, {
        chartEvidence: _chartEvidence,
        logPrefix: '[j2]',
      });
      if (_gated.text !== finalText) {
        finalText = _gated.text;
        totalChars = finalText.length;
      }
    } catch (_) { /* 核验门异常不阻断交付 */ }
  }
  // 2026-09-13 (老板 21:40 实案 "说不上来的问题"): 终局交付对账 — 对账制不只守 task_done。
  // 三道实案 (21:36): 0 工具编造 "落盘 149 行/5.6KB" / "10 案例落盘完成" / "横切对照表落盘",
  // 全走普通正文出门, task_done 对账门够不到。现在: 任何出门文本声称写盘 + 账上无据 = 拦下换真话。
  // 系统自产熔断文案 (⚠️[盘古...) 豁免 — 它们引用"落盘"是转述死因, 不是声称产出。
  if (finalText && !_SYS_GUARD_TEXT_RE.test(String(finalText).trim())) {
    try {
      const _dc = require('./task_ledger').checkDeliveryClaims(_sessionId, finalText, { toolsThisRun: realToolsUsed.length });
      if (_dc && _dc.missed.length) {
        console.warn('[j2] LEDGER_DELIVERY_REJECT: 终局文本声称写盘但账上无据: ' + _dc.missed.join(', ').slice(0, 200));
        try { require('./task_ledger').recordLesson(_sessionId, 'FAKE_DELIVERY', '终局文本声称写盘账上无据被拦: ' + _dc.missed.join(',').slice(0, 120)); } catch (_) {}
        try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '对账拦截: 答复声称的文件在账上无据, 编造内容未交付.' }) + '\n\n'); } catch (_) {}
        finalText = '⚠️ [盘古 对账拦截] 本轮答复把这些文件说成了新生成/已落盘 (' + _dc.missed.slice(0, 3).join('、') + '), 但任务账本没有对应的本轮写盘凭据。文件可能本来就存在或只是被读取, 不能据此声称本轮产出。账上真实写盘: ' + (_dc.written.length ? _dc.written.slice(-5).join('、') : '(无)') + '。\n建议: 继续时只汇报账上确认的写入; 对已有源文件写"已存在/已读取, 本轮未写"。';
        totalChars = finalText.length;
        evoSuccess = false;
      }
    } catch (_) {}
  }
  // 2026-09-12 (老板 20:26 实案): verdict 必须在所有终局决议之后计算 —
  // 此时 finalText / finalAlignmentBlocked / evoSuccess 都是最终态, 判定才不会与交付物打架。
  const { classifyRuntimeVerdict } = require('./runtime_verdict');
  // 2026-09-17 全修 (#5): 把主人原话(userInput)传给 verdict, 识别"按顺序全做完/不用问"指令
  // → autoComplete 豁免: 这种轮次"停下来等你拍"不判 failed
  const verdict = classifyRuntimeVerdict({
    real_tool_calls_total: realToolsUsed.length,
    final_text: finalText,
    user_input: userInput,
    alignment_blocked: finalAlignmentBlocked && !finalText,  // 2026-09-12: 已有实质交付文本时, 历史拦截标志不毒化 verdict
    task_done_status: taskDoneStatus,
    // No task_done call means there is no accepted completion signal. Passing
    // true here for ordinary text-only rounds let the verdict promote a
    // zero-tool promise/plan into success via acceptedTaskDone.
    task_done_accepted: taskDoneCalled && taskDoneAccepted,
  });
  const runtimeCompleted = verdict.success;
  const runtimeStatus = verdict.status;
  // 2026-09-13 任务账本: 结局入账 — 下次开工先读"上次怎么死的" (进化闭环的失败侧)
  // 2026-09-22 (session 44008568): 断片轮识别 — 全程 0 真工具 + 正文 <60 字 + 非 completed = 上游断了,
  // 记 interrupted (而不是 failed/empty), 下轮 REVERIFY_FIRST 据此强制先工具核验
  let _runEndNote = String(finalText || '').replace(/\s+/g, ' ').slice(0, 120);
  let _runEndStatus = runtimeStatus;
  if (!runtimeCompleted && realToolsUsed.length === 0 && String(finalText || '').length < 60) {
    _runEndStatus = 'interrupted';
    _runEndNote = '上游断连: 0 工具调用 + 正文 ' + String(finalText || '').length + ' 字 (MiniMax 4-token 断片), 下轮须先工具核验';
  }
  try { require('./task_ledger').recordRunEnd(_sessionId, _runEndStatus, _runEndNote); } catch (_) {}
  const evoRec = JSON.stringify({
    ts: new Date().toISOString(),
    endpoint: '/api/pangu/agent/stream',
    mode: executionPath,
    session_id: _sessionId,
    input: String(userInput || '').slice(0, 500),
    provider: String(model.provider || 'openai'),
    model: String(model.id),
    tool_calls_total: effectiveRealToolsCalled.length + (taskDoneCalled ? 1 : 0),
    tool_names: effectiveRealToolsCalled.concat(taskDoneCalled ? ['task_done'] : []),
    image_count: (Array.isArray(messages) ? messages : []).reduce((n, m) => n + (m && Array.isArray(m.images) ? m.images.length : 0), 0),
    total_chars: totalChars || (finalText ? finalText.length : 0),
    rounds,
    success: runtimeCompleted,
    runtime_status: runtimeStatus,
    real_tool_calls_total: realToolsUsed.length,
 // #13: Evolution 失真 — success 判定收紧 (2026-09-09 加: 0 工具 + 1 轮 final_text 不再判成功)
    // 修法: 加 `0 工具 + <2 轮 → false` 防御层, 修 L1 数据 15:04/15:06/21:43/22:25/22:57 5 条污染
 // #14: Evolution 漏字段 — 加 tool_args/tool_results 记录
    tool_args: toolsUsed.map(n => {
      const tr = toolHistory.find(t => t.name === n);
      return tr ? { name: n, args: tr.args || {} } : { name: n, args: {} };
    }).slice(0, 10),
    duration_ms: Number(durationMs) || 0,
    error: evoError || null,
    final_text: String(finalText || '').slice(0, 1000)
  });
  // 2026-09-12 九次: 注入 writer 缺 (desktop 走 initAgentStream 未传 _recordEvolution) → 直接 require 兜底,
  // 保证 evolution 一定写 (旧逻辑: dep 缺 → throw → 被 catch 吞 → 静默不写 → 日志断档, 没观测到新代码效果)
  try {
    const _rec = (typeof recordEvolution === 'function')
      ? recordEvolution
      : require('./evolution_record')._recordEvolution;
    _rec(JSON.parse(evoRec));
  } catch (e) { console.warn('[evo-record-hook-fail]', e.message); }
  // 兜底: 模型直答 (无 task_done) 时 finalText 从未 emit → 补发 final, 否则前端气泡空/只剩旁白
  if (finalText) emitFinalOnce(finalText);
  // §0.60 (爹接棒): 收口 status 事件 — 前端按钮能感知 done / failed / aborted 三态, 不靠猜 done 事件
  const _statusObj = {
    status: runtimeStatus === 'failed' ? 'failed' : 'done',
    reason: evoError || null,
    duration_ms: Date.now() - agentStartTime,
    rounds,
    tool_calls_total: toolsUsed.length,
    success: runtimeCompleted,
    ts: Date.now(),
  };
  if (_sessionAbort && _sessionAbort.signal && _sessionAbort.signal.aborted) {
    _statusObj.status = 'aborted';
    _statusObj.reason = String(_sessionAbort.signal.reason || 'user_switched');
    _statusObj.success = false;
  }
  try { if (!res.writableEnded) res.write('event: status\ndata: ' + JSON.stringify(_statusObj) + '\n\n'); } catch (e) { console.warn('[j2-status] write fail:', e.message); }
  try { if (!res.writableEnded) res.write('event: done\ndata: ' + donePayload + '\n\n'); } catch (e) { console.error('[safe-write] done event fail:', e.message); }
  // Dispatcher workers contribute evidence to their parent, but are not user
  // tasks themselves. Recording them as independent outcomes inflated task
  // totals and could contradict the dispatcher's terminal verdict.
  if (!opts.suppressOutcomeRecord) try {
    const { recordOutcome } = require('./outcome_tracker');
    recordOutcome(_sessionId, { status: runtimeStatus, artifacts: [], metrics: { rounds, tool_calls_total: toolsUsed.length, real_tool_calls_total: realToolsUsed.length, alignment_blocked: finalAlignmentBlocked, task_done_requested: taskDoneCalled, task_done_accepted: taskDoneAccepted }, ts: Date.now() });
  } catch (_) {}
  _deps._recordSessionToMemory(opts.reqBody || {}, finalText, model.id).catch(() => {});
  try {
    if (typeof res?.end === 'function' && !res.writableEnded) res.end();
  } catch (e) { console.error('[safe-end]', e.message); }
  // 2026-09-16 上下文传递层: 从 task_ledger 账本拉本 session 真写盘 artifact 路径,
  // 供 dispatcher 子任务回传 — 下游引用路径按需读, 不再重读全文
  let _artifacts = [];
  try {
    const _ledger = require('./task_ledger').loadLedger(_sessionId);
    _artifacts = ((_ledger && _ledger.facts && _ledger.facts.files_written) || [])
      .map(w => ({ path: w.path, bytes: w.bytes, tool: w.tool }));
  } catch (_) {}
  // 2026-10-23 (第 67 批): **权威落盘** —— 屏上发什么, 盘上就存什么。
  //   位置: 答案定稿之后 (summary 重写 / 守卫改写 / 对齐重答 / 最终 emit 全走完)。
  //   内容: emittedFinalText —— 屏上真正发出去的那段, 逐字一致。
  //   这是本轮**唯一**的最终落盘点 (正常路径); finally 里那份只在主循环抛异常时兜底。
  await _persistFinalAnswer();
  // 2026-08-02: 返回结果给 dispatcher 子任务路径 (以前 return undefined → 综合阶段拿不到任何真内容)
  return {
    finalText,
    toolsUsed,
    rounds,
    totalChars: Number(totalChars) || (finalText ? finalText.length : 0),
    modelUsed: model && model.id ? model.id : null,
    runtimeStatus,
    completed: runtimeCompleted,
    artifacts: _artifacts,
  };
 } catch (e) {
  // 定稿区抛异常 ⇒ 答复还没落盘就等于这一轮没了 (2026-10-09 P0 丢整轮对话的老坑)。
  //   先落盘再把异常抛出去 —— 抛是为了让上游知道这轮真出事了, 不是为了把这一轮丢掉。
  console.warn('[j2-finalize] 定稿区异常, 先落盘再抛:', e && e.message && e.message.slice(0, 200));
  await _persistFinalAnswer();
  throw e;
 }
}

// 2026-10-13 (现场 /tmp/pangu-single.err: SILENT_FAILURE 16 次全部 0 工具且全部无 plan):
// 这个文案里无条件断言全是假的 ——
//   ①「但进度已落盘」      : 0 工具 + 无 plan 时什么都没写
//   ②「接在卡住那步上」  : 没有 plan 就没有步可接
//   ③「交接卡已写」        : 交接卡只在 200 轮/80万 token 的另一条路径写,
//                                                    SILENT_FAILURE 这条路径根本不写 —— 16/16 次都是假的
// 提出成纯函数: 文案里混着“继续怎么办”的建议, 又要看 plan 快照 与工具记录,
// 内联在一个上千行的循环里根本测不了 —— 这里改成可直接单测的形式。
function _buildSilentFailureMsg(rounds, toolsUsed, planSnapshot) {
  const pSteps = (planSnapshot && planSnapshot.steps) || [];
  const pDone = pSteps.filter(x => x.status === 'done').length;
  const pTotal = pSteps.length;
  const stuckStep = pSteps.find(x => x.status === 'doing' || x.status === 'pending') || null;
  const tools = toolsUsed;  // 调用点始终传数组 (effectiveRealToolsCalled), 不要多一道承不到的兜底
  const hasProgress = tools.length > 0 || (pTotal > 0 && pDone > 0);

  const msg = '⚠️ [Silent Failure / 本轮未收口] 我跑了 ' + rounds + ' 轮没调 task_done'
    + (hasProgress
      ? ', 但进度已落盘 — 不是任务死了, 是这一轮到顶了。\n'
      : ' —— 这一轮**什么都没产出**(没调任何工具, 也没有 plan 进度), 不是任务做不完。\n')
    + (pTotal ? '进度: ' + pDone + '/' + pTotal + ' 步完成' + (stuckStep ? ', 卡在「' + stuckStep.title + '」' : '') + '\n' : '')
    + '已做工具: ' + tools.length + ' (' + (tools.slice(0, 6).join(', ') || '无') + ')\n\n'
    + (hasProgress
      ? '怎么继续 (别重发整个任务, 会从头烧):\n' +
        '  · 直接说「继续」/「继续消化」— 自动断点续跑, 接在卡住那步上\n' +
        '  · 或开新对话 — 本轮断点已写进会话 checkpoint(返回后紧跟着保存), 不用重发旧历史'
      : '怎么继续 (这一轮没产出, 重发不会丢任何进度):\n' +
        '  · 把任务原话重发一遍即可 — 没有产出待保留\n' +
        '  · 若反复如此 — 多半是模型这轮没给出任何动作, 可在「设置」换个模型再试');
  return { msg, hasProgress };
}

// 2026-10-13 (逆向 Codex CLI 0.144.4 的 codex_goal_extension 后的修):
// 续不续跑由**客观状态**决定, 不由模型自述决定。
// 放模块级是为了可测 —— 闭包里的函数只能靠跑整个 loop 才碰得到, 那不叫测试。
// 单一真源: _tryAutoResume 和收口调用点都必须用它, 各判一次必然漂移。
//
// ⚠️ 2026-10-17 修正过一次改错位置的版本 (留下这段, 免得再犯):
//   当时把 `selfAuthored` 直接塞进 hasActiveTask, 结果打红 guard_e2e_scenarios 的 S2/S4
//   —— 那两个是 2026-09-14 三命通会现场的回归锁, 钉的是"plan 全 done 但模型还没 task_done
//   交验时, 必须再给一轮"。它们的证据**也是**本次调用自己写的心跳, 于是"本次写的就不算
//   证据"这条一刀切把长任务续跑一起砍了。旧码 6/6 → 新码 4/6, 当场对照才抓出来。
//   真正的分界不是"谁写的", 是**有没有 plan**: 有 plan 时活没干完由 plan 说; 没 plan 时
//   心跳才是唯一线索, 而本次调用自己写的心跳信息量为零。
//   → 分界落在 _objectiveGateOpen (只服务 objective_incomplete 这一道门), 不动这里。
//     这里保持原语义: partial_task_done / task_done_rejected / 崩溃恢复全都靠它, 一个字不改。
//
// selfAuthored / hasPlan 是**只读旁挂信息**, 不参与本函数的判定, 供 _objectiveGateOpen 用。
function _objectiveWorkRemaining(sid, opts) {
  const invocationStartedAt = Number((opts && opts.invocationStartedAt) || 0);
  let pending = [];
  let hasPlan = false;
  try {
    const pl = require('./plan_state').loadPlan(sid);
    const steps = pl ? (pl.steps || []) : [];
    hasPlan = steps.length > 0;
    pending = steps.filter(s => s.status === 'pending' || s.status === 'doing');
  } catch (_) {}
  let cp = {};
  try { cp = require('./task_checkpoint').loadTaskCheckpoint(sid) || {}; } catch (_) {}
  let selfAuthored = false;
  try {
    const cpAt = cp && cp.updated_at ? Date.parse(cp.updated_at) : 0;
    selfAuthored = !!(invocationStartedAt && cpAt && cpAt >= invocationStartedAt);
  } catch (_) { selfAuthored = false; }
  // 用 !! 收口: cp.goal 是字符串, && 链会把它原样透传出去, 于是 hasActiveTask
  // 有时是 '' 有时是 true —— 字段说是布尔就必须是布尔, 调用方不该替它做类型判断。
  const hasActiveTask = !!(pending.length === 0 && cp.status === 'active' && cp.goal);
  return {
    pending: pending.length, hasActiveTask,
    remaining: pending.length > 0 || hasActiveTask,
    selfAuthored, hasPlan,
  };
}

// objective_incomplete 这道门专用的闸 (2026-10-17, 现场 q-1792197270649 + 725 个子 agent checkpoint 实测)。
//
// 这道门问的是"**客观**上还有活没干完, 值得再给模型一轮吗"。
// 对**没有 plan 的 session** —— 也就是每一个子 agent (实测 sid 形如 `q-…#sub-2-checker`,
// loadPlan 返回 null) —— pending 恒为 0, 于是上面的 hasActiveTask 退化成
// "status==='active' && goal 非空"。而 status:'active' 是**循环自己每轮写的**心跳
// (j2_agent_loop.js:1896, 注释自陈是"崩溃恢复"用), 拿它当判据就是**循环在给自己打分**
// → 这道门对每个子 agent 恒为真 → 模型第一遍没调 task_done 就必定触发一次空烧的续跑。
//
// 这次续跑有用吗? 725 个子 agent checkpoint 实测收口率:
//   auto_resumes=0  (505 个): 168 收口 → 33%
//   auto_resumes=1  (145 个):  54 收口 → 37%   ← 续一次与"能不能收口"零相关
//   auto_resumes>=2 ( 75 个):  12 收口 → 16%   ← 越续越不成
// 所以第一次续跑纯属白烧一整轮 LLM 往返 + 一次 compact。
//
// 三种情况放行 (都是真证据):
//   ① pending>0          → plan 说还有活
//   ② hasPlan            → plan 全 done 也不等于收口, 还要一轮让模型 task_done 交验
//                          (guard_e2e_scenarios S2/S4 钉的就是这条, 别动)
//   ③ !selfAuthored       → 上次没干完留下的心跳 = 崩溃恢复, 行为一字不变
// 落空的是: 没 plan + 心跳是本次调用自己写的 → 没有客观证据, 不触发。
//
// 放模块级是因为它得被单测直接钉住 —— 这道门是纯布尔判定, 不该只能靠跑整个 loop 才碰得到。
function _objectiveGateOpen(obj) {
  if (!obj || !obj.remaining) return false;
  return !!(obj.pending > 0 || obj.hasPlan || !obj.selfAuthored);
}


// 2026-10-13 (现场 objw-live-1791859404#sub-1-executor, 探针跑 10 分钟不结束):
// 子 agent 把**同一条** `mkdir -p ... && printf ... > b1/b2/b3` 原样执行了 33 次,
// 活其实第一遍就干完了 (盘上 3 个文件内容正确), 而 files_touched_count 被重复触碰
// 同一个文件灌水 → 「有实质进展」永远为真 → 预算永远重置 → 收不了尾。
//
// 根因: 防重复调用的**硬守门** (`seen >= _CROSS_ROUND_CALL_LIMIT` → DUPLICATE_TOOL_CALL)
// 只写在 legacy 路径 (2838 行), 而生产跑的是 native 路径 —— native 那边只有
// _crossRoundToolCalls 计数和 [HARD-LOOP] 警告, 喊完照跑。同一份代码两条路径两种行为。
//
// 只读类工具同参数重读是合法的 (压缩/换 offset 常触发), 代码里 _isReadonlyLoop 早就
// 认定「不该被当成要人接管的强制熔断」—— 所以判重时尊重这个既有判断。
// legacy 路径维持原样 (它连只读也拦), 不在这里顺手改它 —— 那是另一次行为变更。
const _READONLY_REPEAT_OK = new Set([
  'read_file', 'list_directory', 'file_find', 'file_grep',
  'memory_search', 'session_recall', 'search_files',
]);

function _partitionFreshCalls(toolCalls, counters, limit) {
  const fresh = [];
  const duplicates = [];
  for (const tc of (Array.isArray(toolCalls) ? toolCalls : [])) {
    const key = tc.name + '|' + _stableStringify(tc.params || {});
    const seen = (counters && typeof counters.get === 'function' ? counters.get(key) : 0) || 0;
    if (seen >= limit && !_READONLY_REPEAT_OK.has(tc.name)) {
      duplicates.push({ tc, key, seen });
    } else {
      fresh.push(tc);
    }
  }
  return { fresh, duplicates };
}

module.exports = {
  _partitionFreshCalls,
  // 2026-10-23 (第 73 批): 「旁白 vs 结论」的判据导出 —— 它是纯函数, 判据要能真跑它,
  // 不能只做正则静态断言 (字段写了没被用掉, 今天栽过)。
  _isNarrationAfterTools,
  // 2026-10-17: 角色拦截的计数与换路文案, 导出是为了护栏能真跑这个纯逻辑 ——
  // 它是"换参数重试逃过三道按参数分桶的闸门"那 21 轮空转的唯一防线,
  // 只做正则静态断言守不住 (字段写了没被用掉, 今天栽过)。
  _makeRoleDenyGuard,
  _injectGlobalRulesOnce,
  _GAR_MARK,
  init,
  _objectiveWorkRemaining,
  _objectiveGateOpen,
  _looksLikeEmptyPlan,
  _buildSilentFailureMsg,
  _resolveRoundTimeoutMs,
  _isLocalModel,
  _injectRelevantMemories,
  _injectSonaPatterns,
  _injectGoapPlan,
  _persistSession,
  _formatRelevantMemories,
  // 2026-10-15: 给 LM Studio 缓存守卫用 —— 它必须知道"现在有没有请求在飞",
  // 否则可能在主人正在对话时把模型卸了。数据来自既有的 session_container,
  // 这里只是开个出口, 不新增任何状态。
  _sessionStats: () => _sessionContainer.stats(),
  _runAgentLoopLegacyStream: async function (messages, model, req, res, opts) {
    return _runAgentLoopLegacyStream(messages, model, req, res, opts);
  },
  // §0.32: 手动压缩 (HTTP /api/pangu/admin/compact 调用)
  forceCompactSession,
  forceCompactSessionNow,
  requestForceCompact,
  listForceCompactQueue,
};
