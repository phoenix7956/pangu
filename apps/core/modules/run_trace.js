// modules/run_trace.js — Codex 式运行溯源 (2026-10-14)
//
// 为什么有这个模块: 逆向 codex-cli 26.1007 (Mach-O arm64, 25339 符号) 的结论 ——
// codex 没有任何"答案文本对齐"关卡, 它的反幻觉靠三层:
//   ① 提示层: Do not hallucinate completion / Do not present unverified
//      memory-derived facts as confirmed-current
//   ② 工具结果落库: 每个 tool_result 带 tool_result_source / original_bytes /
//      max_bytes / omitted_calls / _codex_executed_tool_call_truncated
//   ③ Guardian 的"动作"风险闸门 (core/src/guardian/), 管命令审批不管答案对错
//
// 盘古三样都没有:
//   - 工具结果 `.slice(0, 3000)` 静默截断, 模型不知道被截了 → 从半截数据下结论
//   - 全仓 14 处计时字段全是 durationMs, ttft / firstTokenMs / responseMs 根本不存在
//   - 守卫(answer_alignment 等)不留痕, 拒答了没人知道谁按什么依据拒的
//
// 本模块补 ②③ 两层, 并且让 ① 可验证: 每个断言都能追到 tool_result_id。
// 落盘 ~/.pangu/state/harness/runs/<ts>-<sid>.jsonl, 复用已有的 harness 目录。
'use strict';

const fs = require('fs');
// 2026-10-25 (第 92 批): session id 的清洗走唯一真源。
//   trace 文件名是**组合名** (<时间戳>-<agent>-<session 片段>.jsonl), 不是按 session 分账,
//   所以它不受「同一个 sid 落同一个文件」那个病影响;
//   但 session id 那一段仍然用唯一真源算, 免得又多一份清洗规则。
const { sessionKey } = require('./session_key');
// 2026-10-26 第 100 批: 运行轨迹目录走唯一真源 (modules/state_paths.js)
//   沙箱导出 PANGU_RUN_TRACE_DIR ⇒ 测试链不再往生产 ~/.pangu/state/harness/runs 写
//   (实测每跑一次链 72 个 trace 文件进生产, 全是 r24-* / j2-gate-* 之类测试会话)。
const statePaths = require('./state_paths');
const path = require('path');
const os = require('os');

const RUNS_DIR = () => statePaths.runTraceDir();
// 单条 trace 最多记多少事件 — 防长任务把 jsonl 撑爆 (长任务本身要靠 token 预算收,
// 这里只防 trace 自身变成第二个长任务)。
const MAX_EVENTS = 4000;
// 这些事件必须当场落盘 —— 它们是"子 agent 有没有接上上文 / 调了什么工具 /
// 烧了多少 token"的唯一证据, 丢了就等于没跑过。
const DURABLE_EVENTS = new Set([
  'context_inherited', 'tool_result', 'tokens', 'estimated', 'claim',
  'result', 'guard', 'truncation', 'budget',
]);
// ── 工具结果进 prompt 的额度 —— 单一真源 ──────────────────────────────
//
// 2026-10-21 (E2E 实跑第 9 轮, 老板拍「那你干吧」那条线):
//   这一行原来是 `const DEFAULT_MAX_BYTES = 3000`, 注释写的是
//   「与旧码 .slice(0, 3000) 同值, 但这次是可观测的」。
//   **可观测不等于够用** —— 它把旧码那个"小得离谱"的值原样继承了,
//   而且因为它是 run_trace 的默认值, **子 agent 路径上没有任何别的兜底**:
//   j2_agent_loop 那 24,000 字符的额度只作用于主循环, 子 agent 的
//   `_trace.toolResult()` 直接把这个结果拼进 messages 就送出去了。
//
//   实测现场 (1990-7-22 14:00 女, 单条 bazi_calc):
//     工具结果总长        15,208 字节
//     子 agent 实际喂给模型  3,000 字节 (被静默砍掉 80%)
//     四柱所在位置         第 3,592 字节  ← 正好落在砍口外面
//   模型**如实报告**了这件事: 「bazi_calc 返回内容较长被截断, 约 15208 字节仅见前 3000」。
//   然后它做了一件很自然的事: 手上只剩五行统计, 就拿五行反推时柱 ——
//   推出 壬子 (真值 己未), 月柱也一并写成 己未 (真值 癸未)。
//
//   教训: 「可观测的截断」解决的是**静默**, 不解决**截太狠**。
//   砍掉的量本身就是错的答案来源 —— 边界必须在砍之前就定对。
//
// 现在: 额度与主循环的字符预算对齐 (同一把 env 旋钮),
// 并按**字节**换算 —— 中文 1 字符 = 3 字节, 不换算的话中文结果天生少拿三分之二,
// 而排盘/卦辞这类结果恰恰全是中文。
const TOOL_RESULT_MAX_CHARS = Math.max(4000, parseInt(process.env.PANGU_TOOL_RESULT_MAX_CHARS || '24000', 10));
const DEFAULT_MAX_BYTES = Math.max(
  8000,
  parseInt(process.env.PANGU_TOOL_RESULT_MAX_BYTES || String(TOOL_RESULT_MAX_CHARS * 3), 10)
);
// 失败也写盘 —— 崩了的 run 恰恰是最需要复盘的
let _enabled = process.env.PANGU_TRACE !== '0';

// 2026-10-14 现场 (session=jl-verify-1): 一条 subagent trace 只剩 1 行 start,
// 后面 context_inherited / tokens / tool_result 全没了 —— 看着跟"从没跑过"一样。
// 原因: 事件先进内存, 只有 finish() 才落盘; 子 agent 中途被腰斩, finish 永远不到。
// 于是"长任务为什么死了"这件事本身查无实据, 只能靠猜。
// 修法两条: ① 关键事件当场落盘 (不等 200 条阈值); ② 进程退出时把还活着的 trace
// 兜底刷出去 (unhandledRejection / SIGTERM / 正常退出都覆盖)。
const _live = new Set();
let _exitHooked = false;

function _flushAllLive(reason) {
  for (const t of Array.from(_live)) {
    try { t._flushLive(reason); } catch (_) { /* 兜底刷盘不许自己再炸 */ }
  }
}

function _hookExit() {
  if (_exitHooked) return;
  _exitHooked = true;
  // 只挂 'exit', 不挂 uncaughtException / unhandledRejection / SIGTERM。
  // 原因: 一旦挂了 uncaughtException, Node 就不再按默认那样崩掉了 —— 那是拿
  // "服务崩溃语义"换一个"日志好看", 不值。而且 Node 在未捕获异常、unhandled
  // rejection、SIGTERM/SIGINT 默认处理之后都会走到 'exit', 这里刷盘是同步的
  // (fs.writeSync), 在 'exit' 里完全来得及。挂一个就够, 副作用为零。
  process.on('exit', () => _flushAllLive('exit'));
}

function _ensureDir() {
  try {
    if (!fs.existsSync(RUNS_DIR())) fs.mkdirSync(RUNS_DIR(), { recursive: true });
    return true;
  } catch (_) { return false; }
}

function _safeName(s) {
  return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_.:#-]/g, '_').slice(0, 80) || 'x';
}

function _byteLen(s) {
  return Buffer.byteLength(String(s == null ? '' : s), 'utf8');
}

/**
 * 开一条 trace。
 * @param {object} o
 * @param {string} o.sessionId  会话 id (子 agent 用自己的合成 sid)
 * @param {string} [o.agent]    将灵 code / 'main'
 * @param {string} [o.kind]     'subagent' | 'main' | 'synthesis'
 * @param {string} [o.parent]   父 run id, 用来把一条对话里的所有 run 串起来
 * @param {string} [o.root]     本次请求的根 id (跨轮共享, 让"同一个任务的多轮"能归组)
 */
function createTrace(o = {}) {
  const t0 = Date.now();
  const traceId = t0 + '-' + Math.random().toString(16).slice(2, 8);
  const rootId = o.root || String(o.sessionId || 'noses');
  const events = [];
  const counters = { tools: 0, tools_failed: 0, guards_block: 0, guards_pass: 0, guards_rewrite: 0, truncations: 0 };
  // 2026-10-14: 估算用量单列, 不混进 input/output。
  // 混进去的后果: summary 里 tokens 看起来有值, 实际是估的, 与真实账单对不上时
  // 没人分得清哪些是真数据。单列之后 "input=0 但 estimated=12000" 一眼就是
  // "这家 provider 不回 usage", 而不是"这次没花钱"。
  const tokenLedger = { input: 0, output: 0, calls: 0, estimated: 0, estimated_calls: 0 };
  let dropped = 0;
  let flushed = 0;
  let file = null;
  let inFlush = false;

  function _emit(evt) {
    if (events.length >= MAX_EVENTS) { dropped += 1; return; }
    events.push(Object.assign({ ts: Date.now(), rel_ms: Date.now() - t0 }, evt));
    // 关键事件当场落盘。
    // 放在 _emit 而不是 event(): 因为 toolResult/tokens/claim 这些是直接调 _emit 的,
    // 绕过了 event(), 挂在那里等于漏掉了最关键的"工具到底调了什么"。
    // inFlush 守卫: _flush() 自己也会 _emit 一条 summary, 没有守卫就是无限递归。
    if (!inFlush && DURABLE_EVENTS.has(evt.type) && events.length > flushed) _flush(null);
  }

  function _flush(final) {
    if (!_enabled) return false;
    if (!_ensureDir()) return false;
    if (inFlush) return false;
    inFlush = true;
    try {
      const fname = _safeName(t0) + '-' + _safeName(o.agent || 'main') + '-' + sessionKey(String(o.sessionId || '')).slice(0, 24) + '.jsonl';
      const full = path.join(RUNS_DIR(), fname);
      if (!file) file = fs.openSync(full, 'a');
      const lines = events.slice(flushed).map(e => JSON.stringify(e)).join('\n');
      flushed = events.length;
      if (lines) fs.writeSync(file, lines + '\n');
      if (final) {
        // aborted / abort_reason 必须一起带出来: 事后翻 trace 时, "跑完了" 和
        // "中途被砍" 全靠这两个字段区分 —— 光看事件齐全与否是分不出来的。
        _emit({
          type: 'summary', final: true, duration_ms: Date.now() - t0,
          counters, tokens: tokenLedger, dropped_events: dropped,
          status: final.status || 'done',
          aborted: !!final.aborted,
          abort_reason: final.aborted ? (final.abort_reason || 'unknown') : null,
        });
        const tail = events.slice(flushed).map(e => JSON.stringify(e)).join('\n');
        if (tail) fs.writeSync(file, tail + '\n');
        flushed = events.length;
        try { fs.closeSync(file); } catch (_) {}
        file = null;
      }
      return true;
    } catch (_) { return false; }
    finally { inFlush = false; }
  }

  const trace = {
    id: traceId,
    rootId,
    sessionId: o.sessionId || null,
    agent: o.agent || 'main',
    kind: o.kind || 'main',

    /** 记一个事件 */
    event(type, data) {
      _emit(Object.assign({ type }, data || {}));
      // 关键事件的当场落盘在 _emit 里统一做 (toolResult 等直接调 _emit, 绕过了这里)。
      if (events.length - flushed >= 200) _flush(null);
      return trace;
    },

    /** 退出兜底: 进程要没了, 把这条 trace 标成"中途被砍"并落盘。 */
    _flushLive(reason) {
      // 无条件补一条终局 summary, 即使事件都已落盘。
      // 关键事件当场落盘之后, 被腰斩的 trace 看着和有结论的一模一样 (事件齐全,
      // 就是没有 summary) —— 那还是分不出"跑完了"和"被砍了"。这条 summary 就是
      // 唯一的区分标志: 有它且 done = 正常结束, 有它且 aborted = 中途没了。
      _flush({ status: 'incomplete', aborted: true, abort_reason: reason || 'unknown' });
    },

    /** 包住一段异步工作, 记录耗时。ttft 记在第一个 phase 上。 */
    async phase(name, fn) {
      const s = Date.now();
      try {
        const r = await fn();
        trace.event('phase', { phase: name, ms: Date.now() - s, ok: true });
        return r;
      } catch (e) {
        trace.event('phase', { phase: name, ms: Date.now() - s, ok: false, error: String(e && e.message || e).slice(0, 300) });
        throw e;
      }
    },

    /** LLM 首 token 时间 —— codex 的 reminder/compact 体系靠的就是这个量纲 */
    ttft(ms) {
      trace.event('ttft', { ms: Math.max(0, Math.round(ms)) });
      return trace;
    },

    /**
     * 记一次 LLM 调用的 token 用量。
     * codex 没有任何"工具调用次数墙", 预算完全是 token 导向的
     * (RolloutBudgetConfigToml.limit_tokens + reminder_at_remaining_tokens
     *  + model_auto_compact_token_limit), 另加 job_max_runtime_seconds 管墙钟。
     * 盘古必须把 token 记全, 才可能照这个范式换掉 max_tool_iterations。
     */
    tokens(usage, phase) {
      if (!usage) return trace;
      const i = Number(usage.prompt_tokens || usage.input_tokens || usage.promptTokens || 0) || 0;
      const o = Number(usage.completion_tokens || usage.output_tokens || usage.completionTokens || 0) || 0;
      tokenLedger.input += i; tokenLedger.output += o; tokenLedger.calls += 1;
      trace.event('tokens', { phase: phase || null, input: i, output: o, total_in_ledger: tokenLedger.input + tokenLedger.output });
      return trace;
    },

    tokenTotal() { return tokenLedger.input + tokenLedger.output; },
    tokenLedger() { return Object.assign({}, tokenLedger); },

    /**
     * 记一次**估算**用量 (上游不回 usage 时)。
     * minimax/doubao 的流式响应不带 usage (llm_caller 注释里已写明), 云端调用
     * 如果只在有 usage 时记账, 就会整条从账本上消失 —— 这正是 2026-10-14 现场
     * 看到的"tokens 事件 0 个 / 估算 306 个"。两条都要记, 只是分开记。
     */
    estimated(est, phase, detail) {
      const n = Number(est) || 0;
      tokenLedger.estimated += n;
      tokenLedger.estimated_calls += 1;
      trace.event('usage_estimated', Object.assign({ phase: phase || null, est: n }, detail || {}));
      return trace;
    },

    /**
     * 工具结果落库 —— 对齐 codex 的 tool_result_source / original_bytes /
     * max_bytes / omitted_calls / 截断标记。
     *
     * 返回**要喂给模型的内容**, 截断时把截断事实明说进内容里:
     * 旧码 `.slice(0, 3000)` 是静默的, 模型以为拿到的是全部, 会从半截数据下结论。
     *
     * @param {string} name 工具名
     * @param {object} res  {ok, result, error}
     * @param {object} opts {source, maxBytes, round, omitted}
     */
    toolResult(name, res, opts = {}) {
      const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES;
      const ok = !!(res && res.ok);
      let raw;
      if (ok) {
        try { raw = typeof res.result === 'string' ? res.result : JSON.stringify(res.result); }
        catch (_) { raw = String(res.result); }
      } else {
        raw = 'ERROR: ' + String((res && res.error) || 'unknown error');
      }
      const originalBytes = _byteLen(raw);
      let content = raw;
      let truncated = false;
      if (originalBytes > maxBytes) {
        // 按字节切但保证不切碎 UTF-8 (Buffer 切片后再兜一层替换字符)
        const buf = Buffer.from(raw, 'utf8');
        content = buf.slice(0, maxBytes).toString('utf8').replace(/�+$/, '');
        truncated = true;
        counters.truncations += 1;
      }
      const keptBytes = _byteLen(content);
      const toolResultId = 'tr_' + traceId + '_' + (counters.tools + 1);
      if (ok) counters.tools += 1; else counters.tools_failed += 1;

      _emit({
        type: 'tool_result',
        tool_result_id: toolResultId,
        name,
        ok,
        source: opts.source || 'tool_exec',
        round: opts.round == null ? null : opts.round,
        original_bytes: originalBytes,
        max_bytes: maxBytes,
        kept_bytes: keptBytes,
        truncated,
        omitted_bytes: truncated ? Math.max(0, originalBytes - keptBytes) : 0,
        omitted_calls: Number(opts.omitted) || 0,
        error: ok ? null : String((res && res.error) || '').slice(0, 300),
      });

      if (truncated) {
        // 明说被截了 —— codex 的 _codex_executed_tool_call_truncated 是同一个用意
        content += '\n\n[TRUNCATED] 本结果原始 ' + originalBytes + ' 字节, 只给了前 ' + keptBytes
          + ' 字节 (省略 ' + (originalBytes - keptBytes) + ' 字节)。以上**不是完整结果**: '
          + '禁止据缺失部分下结论 (如"共 N 个"/"全部都是"), 需要完整数据请收窄查询范围后重调。';
      }
      return { content, toolResultId, truncated, originalBytes, keptBytes };
    },

    /**
     * 守卫记账 —— 谁拦的、按哪条依据、后果是什么。
     * 盘古的 answer_alignment 拒答过去不留任何痕迹, 现场只能靠猜。
     * @param {object} g {guard, action:'block'|'rewrite'|'pass'|'drop', reason, detail}
     */
    guard(g) {
      const action = (g && g.action) || 'pass';
      if (action === 'block' || action === 'drop') counters.guards_block += 1;
      else if (action === 'rewrite') counters.guards_rewrite += 1;
      else counters.guards_pass += 1;
      _emit({
        type: 'guard',
        guard: String((g && g.guard) || 'unknown'),
        action,
        reason: String((g && g.reason) || '').slice(0, 300),
        detail: g && g.detail != null ? String(g.detail).slice(0, 300) : null,
        user_input_head: g && g.userInput ? String(g.userInput).slice(0, 120) : null,
      });
      return trace;
    },

    /** 断预算记账: 是撞 token 墙、轮次墙还是工具次数墙 */
    budget(b) {
      _emit({
        type: 'budget',
        kind: (b && b.kind) || 'unknown',           // token | rounds | tool_calls | wallclock
        used: b && b.used != null ? b.used : null,
        limit: b && b.limit != null ? b.limit : null,
        resumed: !!(b && b.resumed),
        progress: b && b.progress != null ? b.progress : null,
      });
      return trace;
    },

    /** 把断言挂到证据上 —— 盘古"不许编造"从文本检查升级成可证伪 */
    claim(c) {
      _emit({
        type: 'claim',
        text: String((c && c.text) || '').slice(0, 300),
        grounded: !!(c && c.grounded),
        tool_result_id: (c && c.toolResultId) || null,
        kind: (c && c.kind) || 'factual',
      });
      return trace;
    },

    counters() { return Object.assign({}, counters, { dropped_events: dropped }); },
    flush(status) { _flush(status || null); },
    /** 结算并返回摘要, 供上层直接上 SSE / 写 metrics */
    finish(status, extra) {
      const dur = Date.now() - t0;
      _flush(Object.assign({ status: status || 'done' }, extra || {}));
      // 已结算 = 有结论了, 不再需要退出兜底代劳。
      _live.delete(trace);
      return {
        trace_id: traceId, root_id: rootId, session_id: o.sessionId || null,
        agent: o.agent || 'main', kind: o.kind || 'main',
        duration_ms: dur, counters: trace.counters(), tokens: trace.tokenLedger(),
      };
    },
  };

  _emit({ type: 'start', trace_id: traceId, root_id: rootId, session_id: o.sessionId || null, agent: o.agent || 'main', kind: o.kind || 'main', parent: o.parent || null });
  _flush(null);
  if (_enabled) { _hookExit(); _live.add(trace); }
  return trace;
}

// ===== 读侧: 供 /api 与测试取用 =====

function listRuns(opts = {}) {
  try {
    if (!_ensureDir()) return [];
    let files = fs.readdirSync(RUNS_DIR()).filter(f => f.endsWith('.jsonl')).sort().reverse();
    if (opts.limit) files = files.slice(0, opts.limit);
    const out = [];
    for (const f of files) {
      try {
        const lines = fs.readFileSync(path.join(RUNS_DIR(), f), 'utf8').split('\n').filter(Boolean);
        const evs = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
        const start = evs.find(e => e.type === 'start') || {};
        const summary = evs.filter(e => e.type === 'summary').pop() || null;
        out.push({ file: f, trace_id: start.trace_id, root_id: start.root_id, session_id: start.session_id, agent: start.agent, kind: start.kind, started_at: start.ts, events: evs.length, summary });
      } catch (_) {}
    }
    return out;
  } catch (_) { return []; }
}

// ===== 每日账本模式 (2026-10-14) =====
//
// 现场统计: 206 个 trace 文件里 101 个是 guard —— 守卫每拦一次就开一个文件。
// 守卫事件是低频高价值的"谁拦了/按什么依据", 不需要一条一个文件; 单条 trace
// 适合"一次运行的生命周期", 每日账本适合"跨运行的事件流"。
const GUARD_LEDGER = () => path.join(RUNS_DIR(), '..', 'guards-' + new Date().toISOString().slice(0, 10) + '.jsonl');

/**
 * 往当日守卫账本追加一条 (不建独立文件)。
 * @param {object} g {guard, action, reason, detail, userInput, sessionId}
 */
function appendGuard(g) {
  if (!_enabled) return false;
  if (!_ensureDir()) return false;
  try {
    const dir = path.dirname(GUARD_LEDGER());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(GUARD_LEDGER(), JSON.stringify({
      ts: Date.now(),
      type: 'guard',
      guard: String((g && g.guard) || 'unknown'),
      action: String((g && g.action) || 'pass'),
      reason: String((g && g.reason) || '').slice(0, 300),
      detail: g && g.detail != null ? String(g.detail).slice(0, 300) : null,
      user_input_head: g && g.userInput ? String(g.userInput).slice(0, 120) : null,
      session_id: (g && g.sessionId) || null,
    }) + '\n');
    return true;
  } catch (_) { return false; }
}

/** 读当日 (或指定日) 的守卫账本 */
function readGuards(day) {
  try {
    const d = day || new Date().toISOString().slice(0, 10);
    const f = path.join(RUNS_DIR(), '..', 'guards-' + d + '.jsonl');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

// ===== 每会话主 trace 注册表 (2026-10-14) =====
//
// 现场: llm_phase 每次 LLM 调用开一个文件 (43 个), 一次对话散成一堆碎片,
// 事后没法"这一轮总共多久/总共多少 token"。改成一次请求一条 trace,
// 每次调用往里追加 llm_timing 事件 —— 跟将灵 trace 同一套语义。
const _bySession = new Map();
function registerSessionTrace(sessionId, trace) {
  if (sessionId && trace) _bySession.set(String(sessionId), trace);
  return trace;
}
function getSessionTrace(sessionId) {
  return sessionId ? (_bySession.get(String(sessionId)) || null) : null;
}
function unregisterSessionTrace(sessionId) {
  if (sessionId) _bySession.delete(String(sessionId));
}
/** 防内存泄漏: 注册表跟着 session 容器一起被 GC */
function _gcSessionTraces(liveIds) {
  const keep = new Set((liveIds || []).map(String));
  for (const k of Array.from(_bySession.keys())) if (!keep.has(k)) _bySession.delete(k);
}

function readRun(file) {
  try {
    return fs.readFileSync(path.join(RUNS_DIR(), _safeName(file)), 'utf8')
      .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

/** 聚合: 一个 root 下各 run 的耗时/token/守卫 —— 用来回答"为什么慢"和"谁拦的" */
function aggregateRoot(rootId) {
  const runs = listRuns({ limit: 400 }).filter(r => r.root_id === rootId);
  const totals = { runs: runs.length, duration_ms: 0, input: 0, output: 0, guards_block: 0, guards_rewrite: 0, truncations: 0, tools: 0, tools_failed: 0 };
  for (const r of runs) {
    const s = r.summary; if (!s) continue;
    totals.duration_ms += s.duration_ms || 0;
    totals.input += (s.tokens && s.tokens.input) || 0;
    totals.output += (s.tokens && s.tokens.output) || 0;
    const c = s.counters || {};
    totals.guards_block += c.guards_block || 0;
    totals.guards_rewrite += c.guards_rewrite || 0;
    totals.truncations += c.truncations || 0;
    totals.tools += c.tools || 0;
    totals.tools_failed += c.tools_failed || 0;
  }
  return Object.assign({ root_id: rootId }, totals);
}

function _resetForTest() { _enabled = process.env.PANGU_TRACE !== '0'; }
function setEnabled(v) { _enabled = !!v; }

module.exports = {
  createTrace, listRuns, readRun, aggregateRoot, setEnabled, _resetForTest,
  appendGuard, readGuards,
  registerSessionTrace, getSessionTrace, unregisterSessionTrace, _gcSessionTraces,
  DEFAULT_MAX_BYTES, TOOL_RESULT_MAX_CHARS, RUNS_DIR,
};
