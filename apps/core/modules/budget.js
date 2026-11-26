// 2026-08-16 P3: 算力 budget (新政 #8 全要素兜底: 银河算郎对位)
// 每个 session 有 max_rounds + max_tokens + max_wall_ms, 超额熔断
// 2026-09-12 Pangu 扫描报告 §C1+C2: recordRound 传真实 tokens + budget 持久化 (atomic write + 启动 reload)
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
const BUDGET_DIR = process.env.PANGU_BUDGET_DIR || path.join(DEFAULT_PANGU_HOME, 'state', 'budget');
const BUDGET_STALE_MS = 4 * 60 * 60 * 1000; // 4h 没活动视为 stale

const DEFAULTS = {
  max_rounds: parseInt(process.env.PANGU_BUDGET_MAX_ROUNDS || '20', 10),
  max_tokens: parseInt(process.env.PANGU_BUDGET_MAX_TOKENS || '100000', 10),
  max_wall_ms: parseInt(process.env.PANGU_BUDGET_MAX_WALL_MS || '300000', 10),
  // 2026-09-17 老板拍: 不限制工具调用次数 — 长任务读写文件次数无法预知上限, 写死的数字早晚又顶格, 导致"压缩完立刻又断、工具白干".
  // tool_calls 保留计数(用于监控/统计), 但不进 _checkLimits 熔断维度. 只保留 token/rounds/wall-time 这三个真正衡量"烧了多少"的维度.
  idle_gap_ms: parseInt(process.env.PANGU_BUDGET_IDLE_GAP_MS || '60000', 10),
};

const _active = new Map();

function ensureDir() { try { fs.mkdirSync(BUDGET_DIR, { recursive: true }); } catch (_) {} }

// 2026-10-25 (第 92 批): session id → 落盘文件名的唯一真源收成 modules/session_key.js。
//   原来这里有自己一份 _safeSid 拷贝, 各账各写一份 ⇒ 同一个 sid 在不同账里
//   落到不同文件名; 且清洗后不含字母数字的 sid ('!!!' / '@@@') 全落同一个文件,
//   两个不同 session 互相覆盖 (实测: goal.js 那一版还会跟真 default 会话串味)。
//   resolveSessionKey = 纯清洗 (存量零改名) + 真撞名时才换指纹名 (不覆盖别人的账)。
const { resolveSessionKey } = require('./session_key');

function _budgetFile(sid) {
  return path.join(BUDGET_DIR, resolveSessionKey(BUDGET_DIR, sid) + '.json');
}

function _persistBudget(b) {
  if (!b || !b.sessionId) return;
  try {
    ensureDir();
    const file = _budgetFile(b.sessionId);
    const payload = {
      // 2026-10-25 (第 96 批): 落盘字段名统一成 wire 规范名 `session_id`。
      //   实测 (21:45 扫真实账本): budget 是**唯一**用 `sessionId` 落盘的账本 ——
      //     budget 1373 个文件全用 sessionId / tasks 1361 + plans 404 + goals 20
      //     + handoff 191 + ledger 9554 + sessions 全部用 session_id。
      //   之前一直没人发现, 因为读方 (`j.session_id || j.sessionId`) 是**容错**的。
      //   内部内存对象仍用 `sessionId` (JS 规范名) —— 边界转换只在这一处做。
      session_id: b.sessionId,
      firstSeenTs: b.firstSeenTs,
      accumulatedActiveMs: b.accumulatedActiveMs || 0,
      rounds: b.rounds || 0,
      tokens: b.tokens || 0,
      toolCalls: b.toolCalls || 0,
      compactResets: b.compactResets || 0,
      filesAtCompactReset: b.filesAtCompactReset,
      exceeded: b.exceeded || false,
      ts: Date.now(),
    };
    const tmp = file + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, file);
  } catch (_) { /* fire-and-forget */ }
}

function _loadBudget(sessionId) {
  try {
    const file = _budgetFile(sessionId);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - (data.ts || 0) > BUDGET_STALE_MS) return null;
    return {
      firstSeenTs: data.firstSeenTs,
      accumulatedActiveMs: data.accumulatedActiveMs || 0,
      rounds: data.rounds || 0,
      tokens: data.tokens || 0,
      toolCalls: data.toolCalls || 0,
      compactResets: data.compactResets || 0,
      filesAtCompactReset: data.filesAtCompactReset,
      exceeded: data.exceeded || false,
    };
  } catch (_) { return null; }
}

function _loadAllBudgets() {
  try {
    ensureDir();
    const files = fs.readdirSync(BUDGET_DIR).filter(f => f.endsWith('.json')).slice(0, 100);
    let n = 0;
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(BUDGET_DIR, f), 'utf8'));
        if (Date.now() - (data.ts || 0) > BUDGET_STALE_MS) continue;
        // 存量兼容: 旧账本写的是 `sessionId` (1373 个文件), 新写的是 `session_id`。
        //   两个都读 ⇒ **存量文件零改名、零迁移** (跟第 92 批「存量零改名」同一条纪律)。
        const sid = data.session_id || data.sessionId;
        if (!sid || _active.has(sid)) continue;
        _active.set(sid, _makeBudget(data, sid));
        n++;
      } catch (_) {}
    }
    if (n > 0) console.log('[budget] C2 reload: ' + n + ' sessions restored from ' + BUDGET_DIR);
  } catch (_) {}
}

function _makeBudget(init, sid) {
  // 第 96 批: sid 显式传进来 —— 因为磁盘字段名从 `sessionId` 变成了 `session_id`,
  //   光看 init.sessionId 拿不到了 (存量文件还是 sessionId, 新文件是 session_id)。
  const s = sid || (init && (init.sessionId || init.session_id)) || null;
  const now = Date.now();
  const b = Object.assign({
    firstSeenTs: s ? ((init && init.firstSeenTs) || now) : now,
    lastActivityTs: now,
    accumulatedActiveMs: 0,
    rounds: 0,
    tokens: 0,
    toolCalls: 0,
    compactResets: 0,
    limits: { ...DEFAULTS },
    warnings: [],
    exceeded: false,
  }, init || {});
  // 内部只保留 `sessionId` 一个键 —— 磁盘字段名不往内存对象上漏。
  delete b.session_id;
  b.sessionId = s;
  return b;
}

function getBudget(sessionId) {
  if (!_active.has(sessionId)) {
    const loaded = _loadBudget(sessionId);
    const now = Date.now();
    const b = _makeBudget(Object.assign({ sessionId, firstSeenTs: now }, loaded || {}));
    b.lastActivityTs = now; // reload 不继承老的 lastActivityTs, 避免触发 idle gap 误判
    _active.set(sessionId, b);
  }
  return _active.get(sessionId);
}

function _tick(b) {
  const now = Date.now();
  const idleGap = now - b.lastActivityTs;
  if (idleGap > 0 && idleGap < b.limits.idle_gap_ms) {
    b.accumulatedActiveMs += idleGap;
  }
  b.lastActivityTs = now;
}

/**
 * 记录一次 round (LLM 调用)
 */
function recordRound(sessionId, tokens = 0) {
  const b = getBudget(sessionId);
  _tick(b);
  b.rounds++;
  b.tokens += tokens;
  _persistBudget(b);
  return _checkLimits(b);
}

/**
 * 2026-09-12 新增: 只更新 tokens, 不递增 rounds — 给 LLM 真实 usage 调用
 */
function recordTokens(sessionId, tokens = 0) {
  if (tokens <= 0) return { ok: true };
  const b = getBudget(sessionId);
  _tick(b);
  b.tokens += tokens;
  _persistBudget(b);
  return _checkLimits(b);
}

function recordToolCall(sessionId) {
  const b = getBudget(sessionId);
  _tick(b);
  b.toolCalls++;
  _persistBudget(b);
  // 2026-09-17: 只计数不熔断 — tool_calls 维度已摘出 _checkLimits, 此处仅做持久化, 不会因工具次数拒发.
  return _checkLimits(b);  // 仍返回 rounds/tokens/wall 维度的判定结果, 兼容调用方
}

function _checkLimits(b) {
  if (b.exceeded) return { ok: false, exceeded: b.exceeded };
  const elapsed = b.accumulatedActiveMs;
  const violations = [];
  if (b.rounds > b.limits.max_rounds) violations.push(`rounds=${b.rounds} > max_rounds=${b.limits.max_rounds}`);
  if (b.tokens > b.limits.max_tokens) violations.push(`tokens=${b.tokens} > max_tokens=${b.limits.max_tokens}`);
  if (elapsed > b.limits.max_wall_ms) violations.push(`elapsed=${elapsed}ms > max_wall_ms=${b.limits.max_wall_ms}`);
  // 2026-09-17: tool_calls 维度不熔断 — 计数仍保留在 b.toolCalls (snapshot 可读), 但不再参与超限判定.
  if (violations.length > 0) {
    b.exceeded = violations.join('; ');
    return { ok: false, exceeded: b.exceeded };
  }
  const warnings = [];
  if (b.rounds >= b.limits.max_rounds * 0.8) warnings.push('rounds 接近上限');
  if (b.tokens >= b.limits.max_tokens * 0.8) warnings.push('tokens 接近上限');
  if (elapsed >= b.limits.max_wall_ms * 0.8) warnings.push('wall time 接近上限');
  if (warnings.length > 0 && b.warnings.length < warnings.length) b.warnings = warnings;
  return { ok: true, warnings: b.warnings };
}

function snapshot(sessionId) {
  const b = getBudget(sessionId);
  const now = Date.now();
  const lastIdleGapMs = now - b.lastActivityTs;
  const elapsed = b.accumulatedActiveMs;
  return {
    session_id: sessionId,
    rounds: b.rounds, tokens: b.tokens, tool_calls: b.toolCalls,
    elapsed_ms: elapsed, first_seen_ts: b.firstSeenTs, last_idle_gap_ms: lastIdleGapMs,
    limits: b.limits,
    usage_pct: {
      rounds: Math.round(b.rounds / b.limits.max_rounds * 1000) / 10,
      tokens: Math.round(b.tokens / b.limits.max_tokens * 1000) / 10,
      wall: Math.round(elapsed / b.limits.max_wall_ms * 1000) / 10,
      tool_calls: Math.round(b.toolCalls / b.limits.max_tool_calls * 1000) / 10,
    },
    exceeded: b.exceeded || null,
    warnings: b.warnings,
  };
}

function clear(sessionId) {
  _active.delete(sessionId);
  try { fs.unlinkSync(_budgetFile(sessionId)); } catch (_) {}
}

const MAX_COMPACT_RESETS = parseInt(process.env.PANGU_BUDGET_MAX_COMPACT_RESETS || '3', 10);

function resetRoundsAfterCompaction(sessionId) {
  const b = getBudget(sessionId);
  // 2026-09-14 (老板 14:17 实案 "还有这个问题, 超限了"): tokens 累计从不重置 —
  // 易经消化会话真干活两天烧 50 万 tokens, 3 次压缩续命只清 rounds/时长/工具数,
  // tokens 一碰 500k 终身封顶, 会话永久死 ("请新建 session") = 惩罚有进展的长任务。
  // 修 ①: 压缩续命连 tokens 一起清 (压缩后上下文已小, 预算语义 = 每个活跃窗口的燃烧, 不是终身累计)
  b.tokens = 0;
  // 修 ②: 续命次数进展制 (#1b 同哲学) — checkpoint 显示自上次续命后有真写盘进展,
  // 这次续命不消耗额度; 原地打转才消耗, 额度耗尽才真熔断。
  let _progress = false;
  try {
    // 2026-10-13: 这里原来直接读父会话 checkpoint 里的 files_touched_count,
    // 但走 dispatcher 的父会话**自己没有 checkpoint 文件** (实测 4 个真实长任务会话全是
    // 父 0 个 / 子 4~7 个) —— 原先那读法恒为 undefined → filesNow 恒 0 → _progress 恒 false
    // → 每次压缩都扣额度 → 扣满 MAX_COMPACT_RESETS 会话永久死, 正是上面注释自己写的
    // "惩罚有进展的长任务"。改走 countFilesTouched (父 + 子账本一起算, ee2bf33/4ddc373 已修)。
    // 2026-10-13 两个数据源的并集, 不是二选一 (现场打了三轮才定下来):
    // ① checkpoint.files_touched_count —— 单 agent / j2 循环自己的会话有这份 (它每轮写, j2 同函数 1128 行)
    // ② countFilesTouched (账本真源) —— 走 dispatcher 的**父会话堆堆没有 checkpoint 文件**
    //    (实测 4 个真实长任务会话全是 父 0 个 / 子 4~7 个), 原来只读 ① 恒得 undefined → 0
    //    → _progress 结构性恒 false → 每次压缩都扣额度 → 扣满 MAX_COMPACT_RESETS 会话永久死,
    //    正是这段注释自己写的"惩罚有进展的长任务"。
    // 两边量的是同一件事 (本会话累计真写盘数), 都单调不减, 取 max 即并集。
    // 教训: 曾把 j2 那处也一起改成"活读账本", 被 guard_e2e 打脸 —— j2 的 checkpoint 是它自己写的投影,
    // 不是脏数据。详见 j2 侧三条回归锁。
    // 2026-10-13 现场 (resume-live-1791876482): 原来这里数的是**写盘事件数**,
    // 子 agent 把同一批文件重写 100 多次 → files 12→130 而 plan done 一直 0→0,
    // 于是每轮都判成「有实质进展」→ 预算反复重置 → 锁死在重复循环里收不了尾。
    // 改数**不同文件数**: 反复重写同一批文件不再算进展。
    // 两个数据源仍取并集 (沿用上面三轮才定下来的教训): ① 账本去重路径 ② checkpoint 投影。
    // 两个读数仍然取并集 (checkpoint 读数 + 账本读数, 两种真会话形态都在生产里,
    // 见 budget-compact-progress.test.js 的两条接线守卫), 只是**账本那一路换了投影**:
    // countDistinctFilesTouched 与 countFilesTouched 同读 task_ledger 真源 (ee2bf33/4ddc373),
    // 前者取去重后的路径数, 后者取写盘事件总数。
    // 老 checkpoint 里 files_touched_count 装的是事件数 —— 读到时按老语义算, 下一轮
    // checkpoint 被覆写后自动归正。方向是安全的: 宁可漏判一次让会话诚实收口, 也不误判成无限续命。
    const _tc = require('./task_checkpoint');
    const _cp = _tc.loadTaskCheckpoint(sessionId);
    const _cpFiles = (_cp && typeof _cp.files_touched_count === 'number') ? _cp.files_touched_count : 0;
    const filesNow = Math.max(_cpFiles, _tc.countDistinctFilesTouched(sessionId, []) || 0);
    const eventsNow = _tc.countFilesTouched(sessionId, []) || 0;   // 只作观测, 不参与判定
    const filesAtLast = (typeof b.filesAtCompactReset === 'number') ? b.filesAtCompactReset : -1;
    _progress = filesNow > filesAtLast && filesNow > 0;
    b.filesAtCompactReset = filesNow;
    if (_progress) console.warn('[budget] 有实质进展 (不同文件 ' + filesAtLast + '→' + filesNow +
      ', 写盘事件 ' + eventsNow + '), 压缩续命不耗额度');
  } catch (_) {}
  const usedResets = b.compactResets || 0;
  if (usedResets >= MAX_COMPACT_RESETS && !_progress) {
    return { ok: false, reason: 'compact_resets_exhausted', resets: usedResets, max: MAX_COMPACT_RESETS, exceeded: b.exceeded };
  }
  b.compactResets = _progress ? usedResets : usedResets + 1;
  b.rounds = 0;
  b.accumulatedActiveMs = 0;
  b.toolCalls = 0;  // 压缩续命清零计数 (仅统计用, 不熔断)
  b.lastActivityTs = Date.now();
  b.exceeded = false;
  const recheck = _checkLimits(b);
  _persistBudget(b);
  if (!recheck.ok) {
    return { ok: false, reason: 'other_limits_still_exceeded', resets: b.compactResets, max: MAX_COMPACT_RESETS, exceeded: recheck.exceeded };
  }
  b.warnings = [];
  return { ok: true, resets: b.compactResets, max: MAX_COMPACT_RESETS, progress: _progress };
}

function globalStats() {
  const out = { active_sessions: _active.size, sessions: [] };
  for (const [id] of _active.entries()) {
    out.sessions.push(snapshot(id));
  }
  return out;
}

// 2026-09-12 C2: 启动时批量 reload 所有 budget (治进程重启全清零)
_loadAllBudgets();

module.exports = { getBudget, recordRound, recordTokens, recordToolCall, resetRoundsAfterCompaction, snapshot, clear, globalStats, DEFAULTS, BUDGET_DIR, MAX_COMPACT_RESETS };
