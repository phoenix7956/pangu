// 2026-08-16 P1-1: outcome 跟踪 (新政 #1 闭环交付 + 新政 #6 按结果计费对位)
// 数据: ~/.pangu/state/outcomes/<sessionId>.jsonl (append-only)
// 每个 task_done 触发 recordOutcome, 追加一行 JSON
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
// 2026-10-25 (第 92 批): session id → 落盘文件名的唯一真源。
//   原来这里自己抄了一份清洗 ⇒ '!!!' 与 '@@@' 落同一个文件, 两个会话互相覆盖。
//   resolveSessionKey = 纯清洗 (存量零改名) + 真撞名时才换指纹名 (不覆盖别人的账)。
const { resolveSessionKey } = require('./session_key');

const DEFAULT_PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
const OUTCOMES_DIR = process.env.PANGU_OUTCOMES_DIR
  || path.join(DEFAULT_PANGU_HOME, 'state', 'outcomes');

function ensureDir() { try { fs.mkdirSync(OUTCOMES_DIR, { recursive: true }); } catch (_) {} }

function _filePath(sessionId) {
  const safe = resolveSessionKey(OUTCOMES_DIR, sessionId, { ext: '.jsonl' });
  return path.join(OUTCOMES_DIR, `${safe}.jsonl`);
}

/**
 * 追加一条 outcome (fire-and-forget, 不阻塞 task_done)
 * @param {string} sessionId
 * @param {object} outcome { status, artifacts, metrics, ts }
 */
function recordOutcome(sessionId, outcome = {}) {
  if (!sessionId) return;
  ensureDir();
  const file = _filePath(sessionId);
  const line = JSON.stringify({
    session_id: sessionId,
    status: outcome.status || 'completed',
    artifacts_count: Array.isArray(outcome.artifacts) ? outcome.artifacts.length : 0,
    artifacts: Array.isArray(outcome.artifacts) ? outcome.artifacts.slice(0, 20) : [],
    metrics: outcome.metrics || {},
    ts: outcome.ts || Date.now(),
  }) + '\n';
  try {
    fs.appendFileSync(file, line, 'utf8');
  } catch (e) { /* swallow */ }
}

/**
 * 读某 session 的所有 outcome (按时间倒序)
 */
function listOutcomes(sessionId, limit = 100) {
  if (!sessionId) return [];
  const file = _filePath(sessionId);
  if (!fs.existsSync(file)) return [];
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const line of lines.slice(-limit).reverse()) {
      try { out.push(JSON.parse(line)); } catch (_) {}
    }
    return out;
  } catch (e) { return []; }
}

/**
 * 全局统计 (新政 #1 闭环交付 ROI): completed/partial/failed 比例 + artifacts 总量
 */
function globalStats(options = {}) {
  const sinceTs = Number(options.sinceTs || 0);
  const untilTs = Number(options.untilTs || Infinity);
  ensureDir();
  let completed = 0, partial = 0, failed = 0, artifacts_total = 0;
  let sessions_with_outcomes = 0, total_rounds = 0;
  let files;
  try { files = fs.readdirSync(OUTCOMES_DIR).filter(f => f.endsWith('.jsonl')); } catch (e) { return _empty(); }
  for (const f of files) {
    try {
      const lines = fs.readFileSync(path.join(OUTCOMES_DIR, f), 'utf8').split('\n').filter(Boolean);
      if (lines.length === 0) continue;
      sessions_with_outcomes++;
      for (const line of lines) {
        try {
          const d = JSON.parse(line);
          const ts = Number(d.ts || 0);
          if (ts < sinceTs || ts > untilTs) continue;
          if (d.status === 'completed') completed++;
          else if (d.status === 'partial') partial++;
          else if (d.status === 'failed') failed++;
          artifacts_total += d.artifacts_count || 0;
          if (d.metrics && typeof d.metrics.rounds === 'number') total_rounds += d.metrics.rounds;
        } catch (_) {}
      }
    } catch (_) {}
  }
  const total = completed + partial + failed;
  return {
    sessions_with_outcomes,
    tasks_total: total,
    completed,
    partial,
    failed,
    completed_rate: total > 0 ? Math.round(completed / total * 1000) / 1000 : 0,
    artifacts_total,
    total_rounds,
    dir: OUTCOMES_DIR,
  };
}

function _empty() {
  return { sessions_with_outcomes: 0, tasks_total: 0, completed: 0, partial: 0, failed: 0, completed_rate: 0, artifacts_total: 0, total_rounds: 0, dir: OUTCOMES_DIR };
}

module.exports = { recordOutcome, listOutcomes, globalStats, OUTCOMES_DIR };
