/**
 * modules/metrics.js
 * 盘古 · Token 计数 / Metrics (P0-#36)
 *
 * 3 个函数 (借 #34 session_store 持久化):
 * - recordTokenUsage: 每次 LLM 调记录 input/output/cache (写到 ~/.pangu-data/metrics/)
 * - getMetrics: 返 session 累计 + by_tool + by_round
 * - metricsDashboard: 返 dashboard 用的数据 (累计/当 session/工具分布)
 *
 * 持久化目录: ~/.pangu-data/metrics/ (Pangu repo 外, 跟 session_store 修的同 symlink bug)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// 2026-10-28 (现场 ~/.pangu-data/metrics 攒了 6901 个目录, 全是测试链跑出来的):
//   生产路径写死 ⇒ **测试跑一次就在生产盘上留一窝**。
//   跟 session_store / agentdb 一样给个环境变量出口 —— 隔离要靠**机制**, 不靠注释。
const METRICS_DIR = path.resolve(
  process.env.PANGU_METRICS_DIR || path.join(os.homedir(), '.pangu-data', 'metrics')
);

function _ensureDir() {
  try { fs.mkdirSync(METRICS_DIR, { recursive: true }); } catch (_) {}
}

function _filePath(sessionId) {
  // 路径穿越修: 同 session_store, id 拼进文件名前必须白名单校验
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error('非法 session id: ' + JSON.stringify(sessionId));
  }
  return path.join(METRICS_DIR, `session_${sessionId}.json`);
}

function _readMetrics(sessionId) {
  try { return JSON.parse(fs.readFileSync(_filePath(sessionId), 'utf8')); } catch (_) { return { session_id: sessionId, records: [] }; }
}

function _writeMetrics(sessionId, data) {
  _ensureDir();
  const tmp = _filePath(sessionId) + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, _filePath(sessionId));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

// === recordTokenUsage ===
// { session_id, round, tool_name, model, input_tokens, output_tokens, cache_hit_tokens?, ts } → 持久化
async function recordTokenUsage(args = {}) {
  const sessionId = args.session_id || 'default';
  if (!args.tool_name) return { ok: false, error: { code: 'NO_TOOL_NAME', message: 'tool_name required' } };
  try {
    const data = _readMetrics(sessionId);
    const record = {
      ts: args.ts || Date.now(),
      round: args.round || 0,
      tool_name: args.tool_name,
      model: args.model || 'unknown',
      input_tokens: args.input_tokens || 0,
      output_tokens: args.output_tokens || 0,
      cache_hit_tokens: args.cache_hit_tokens || 0,
    };
    data.records.push(record);
    _writeMetrics(sessionId, data);
    return { ok: true, result: { session_id: sessionId, record_count: data.records.length, ...record } };
  } catch (e) {
    return { ok: false, error: { code: 'WRITE_FAILED', message: e.message } };
  }
}

// === getMetrics ===
// { session_id, scope: 'session'|'tool' } → 返累计 + by_tool + by_round
async function getMetrics(args = {}) {
  const sessionId = args.session_id || 'default';
  const scope = args.scope || 'session';
  const data = _readMetrics(sessionId);
  const records = data.records || [];
  // 累计
  const total = records.reduce((acc, r) => {
    acc.input += r.input_tokens || 0;
    acc.output += r.output_tokens || 0;
    acc.cache += r.cache_hit_tokens || 0;
    return acc;
  }, { input: 0, output: 0, cache: 0 });
  // by_tool
  const byTool = {};
  for (const r of records) {
    if (!byTool[r.tool_name]) byTool[r.tool_name] = { input: 0, output: 0, calls: 0 };
    byTool[r.tool_name].input += r.input_tokens || 0;
    byTool[r.tool_name].output += r.output_tokens || 0;
    byTool[r.tool_name].calls += 1;
  }
  // by_round (group by round)
  const byRound = {};
  for (const r of records) {
    const k = r.round;
    if (!byRound[k]) byRound[k] = { input: 0, output: 0, ts: r.ts };
    byRound[k].input += r.input_tokens || 0;
    byRound[k].output += r.output_tokens || 0;
    byRound[k].ts = r.ts;
  }
  const byRoundArr = Object.keys(byRound).sort((a, b) => Number(a) - Number(b)).map(k => ({ round: Number(k), ...byRound[k] }));
  return { ok: true, result: { session_id: sessionId, scope, total_input: total.input, total_output: total.output, total_cache_hit: total.cache, record_count: records.length, by_tool: byTool, by_round: byRoundArr } };
}

// === metricsDashboard ===
// { session_id? } → 返 dashboard data (总 + 当 session + 工具分布 + 最近 10 调)
async function metricsDashboard(args = {}) {
  const sessionId = args.session_id || 'default';
  const r = await getMetrics({ session_id: sessionId });
  if (!r.ok) return r;
  // 加最近 10 调 + 工具 top-5
  const data = _readMetrics(sessionId);
  const records = data.records || [];
  const recent = records.slice(-10).reverse();
  // 工具 top-5 by total tokens (input+output)
  const toolStats = {};
  for (const rec of records) {
    if (!toolStats[rec.tool_name]) toolStats[rec.tool_name] = { tool_name: rec.tool_name, total_tokens: 0, calls: 0 };
    toolStats[rec.tool_name].total_tokens += (rec.input_tokens || 0) + (rec.output_tokens || 0);
    toolStats[rec.tool_name].calls += 1;
  }
  const topTools = Object.values(toolStats).sort((a, b) => b.total_tokens - a.total_tokens).slice(0, 5);
  return { ok: true, result: Object.assign({}, r.result, { recent, top_tools: topTools }) };
}

module.exports = {
  recordTokenUsage,
  getMetrics,
  metricsDashboard,
  METRICS_DIR,
};
