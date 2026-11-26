// 2026-08-16 P0-1: 盘古 agent loop 断点续跑 (新政 #2 驾驭层 = 护城河)
// 落盘位置: ~/.pangu/state/checkpoints/<sessionId>_<round>.json
// 触发: j2_agent_loop.js 每个 round 结束后调 saveCheckpoint (try/catch 吞错, 不影响主流程)
// 恢复: 新请求进来同 sessionId 时, 若有最近 checkpoint (≤ 30min), 自动 load 注入 messages
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
// 2026-10-25 (第 92 批): session id → 落盘文件名的唯一真源。
//   本文件五处清洗各自抄了一份 ⇒ 同一个 sid 在五处落到同一文件名 (自洽),
//   但「不同 sid 清洗后撞同一个文件」这个病五处都有 (实测 '!!!' 与 '@@@' 都落 ___ )。
//   resolveSessionKeyPrefix = 纯清洗 (存量零改名) + 真撞名时才换指纹名。
const { resolveSessionKeyPrefix, sessionKeyCandidates } = require('./session_key');

const DEFAULT_PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
const CHECKPOINT_DIR = process.env.PANGU_CHECKPOINT_DIR
  || path.join(DEFAULT_PANGU_HOME, 'state', 'checkpoints');
const CHECKPOINT_MAX_AGE_MS = parseInt(process.env.PANGU_CHECKPOINT_MAX_AGE_MS || String(4 * 60 * 60 * 1000), 10); // §0.59 (爹接棒): 默认 4h (老板午休/下午回来也能续); env 覆盖
const CHECKPOINT_KEEP_LAST = 5; // 每个 session 最多保留最近 5 个 checkpoint

function ensureDir() {
  try { fs.mkdirSync(CHECKPOINT_DIR, { recursive: true }); }
  catch (e) { console.warn('[checkpoint] mkdir failed:', e.message); }
}

function checkpointPath(sessionId, round) {
  // sessionId 已经被 store 验过, 这里再保险: 限 ascii
  // 2026-10-25 (第 92 批): 清洗规则收成 modules/session_key.js 唯一真源。
  //   本文件五处 (写/读最新/列举/清理/裁剪) 全部用同一个 resolveSessionKeyPrefix,
  //   ⇒ 写 `xxx_r3.json` 与读前缀 `xxx_r` 自洽。
  const safe = resolveSessionKeyPrefix(CHECKPOINT_DIR, sessionId, { sep: '_r' });
  const r = Number.isFinite(round) ? round : 0;
  return path.join(CHECKPOINT_DIR, `${safe}_r${r}.json`);
}

/**
 * 找出这个 session 的 checkpoint 文件 (按前缀族)
 *
 * @param {string} safe 文件名主干 (resolveSessionKeyPrefix 算出来的)
 * @returns {string[]} 匹配到的文件名
 */
function _matchCheckpointFiles(safe) {
  const all = fs.readdirSync(CHECKPOINT_DIR);
  return all.filter(f => f.startsWith(safe + '_r') && f.endsWith('.json'));
}

/**
 * 保存 checkpoint — 每个 round 调一次
 * @param {string} sessionId
 * @param {object} state { round, messages, lastToolCall, planId, planState, taskInput, ts }
 */
function saveCheckpoint(sessionId, state = {}) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  ensureDir();
  const file = checkpointPath(sessionId, state.round);
  const payload = {
    session_id: sessionId,
    round: state.round || 0,
    messages: Array.isArray(state.messages) ? state.messages : [],
    last_tool_call: state.lastToolCall || null,
    plan_id: state.planId || null,
    plan_state: state.planState || null,
    task_input: state.taskInput || null,
    ts: Date.now(),
    schema: 1,
  };
  try {
    // atomic write: tmp + rename
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, file);
    _pruneOld(sessionId);
    return { ok: true, path: file, round: payload.round };
  } catch (e) {
    console.warn('[checkpoint] save failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * 读取某 session 最新有效 checkpoint (≤ CHECKPOINT_MAX_AGE_MS)
 * @returns {object|null}
 */
function loadLatestCheckpoint(sessionId) {
  if (!sessionId) return null;
  ensureDir();
  const safe = resolveSessionKeyPrefix(CHECKPOINT_DIR, sessionId, { sep: '_r' });
  let files;
  try {
    files = _matchCheckpointFiles(safe);
  } catch (e) { return null; }
  if (files.length === 0) return null;
  // Try newest rounds first, but fall back when the newest file is truncated
  // or otherwise corrupt. A single bad latest checkpoint must not hide a valid
  // previous resume point.
  const ordered = files.map(f => {
    const m = f.match(/_r(\d+)\.json$/);
    return { f, r: m ? parseInt(m[1], 10) : -1 };
  }).filter(x => x.r >= 0).sort((a, b) => b.r - a.r);
  for (const item of ordered) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(CHECKPOINT_DIR, item.f), 'utf8'));
      if (Date.now() - (data.ts || 0) > CHECKPOINT_MAX_AGE_MS) {
        return { stale: true, ...data, _path: item.f };
      }
      return { fresh: true, ...data, _path: item.f };
    } catch (e) {
      console.warn('[checkpoint] load failed, trying previous:', item.f, e.message);
    }
  }
  return null;
}

/**
 * 列出某 session 的所有 checkpoint (按 round 倒序)
 */
function listCheckpoints(sessionId, limit = 20) {
  if (!sessionId) return [];
  ensureDir();
  const safe = resolveSessionKeyPrefix(CHECKPOINT_DIR, sessionId, { sep: '_r' });
  let files;
  try {
    files = _matchCheckpointFiles(safe);
  } catch (e) { return []; }
  const out = [];
  const ordered = files.map(f => {
    const m = f.match(/_r(\d+)\.json$/);
    return { f, r: m ? parseInt(m[1], 10) : -1 };
  }).filter(x => x.r >= 0).sort((a, b) => b.r - a.r).slice(0, Math.max(1, Number(limit) || 20));
  for (const item of ordered) {
    const f = item.f;
    const m = f.match(/_r(\d+)\.json$/);
    if (!m) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(CHECKPOINT_DIR, f), 'utf8'));
      out.push({ session_id: d.session_id, round: d.round, ts: d.ts, file: f, messages_count: (d.messages || []).length });
    } catch (_) {}
  }
  return out.sort((a, b) => b.round - a.round);
}

/**
 * 清理某 session 的所有 checkpoint
 */
function clearCheckpoints(sessionId) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  ensureDir();
  const safe = resolveSessionKeyPrefix(CHECKPOINT_DIR, sessionId, { sep: '_r' });
  let removed = 0;
  try {
    for (const f of fs.readdirSync(CHECKPOINT_DIR)) {
      // 两个候选名都清 —— 否则另一个名下的残留 checkpoint 清不掉。
      const hitNew = f.startsWith(safe + '_r') && f.endsWith('.json');
      const hitOld = sessionKeyCandidates(sessionId).some(
        c => c !== safe && f.startsWith(c + '_r') && f.endsWith('.json'),
      );
      if (hitNew || hitOld) {
        try { fs.unlinkSync(path.join(CHECKPOINT_DIR, f)); removed++; } catch (_) {}
      }
    }
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, removed };
}

function _pruneOld(sessionId) {
  // 保留最近 CHECKPOINT_KEEP_LAST 个, 删旧的
  try {
    const safe = resolveSessionKeyPrefix(CHECKPOINT_DIR, sessionId, { sep: '_r' });
    const all = fs.readdirSync(CHECKPOINT_DIR)
      .filter(f => (f.startsWith(safe + '_r')
        || sessionKeyCandidates(sessionId).some(c => c !== safe && f.startsWith(c + '_r')))
        && f.endsWith('.json'))
      .map(f => {
        const m = f.match(/_r(\d+)\.json$/);
        return { f, r: m ? parseInt(m[1], 10) : -1 };
      })
      .sort((a, b) => b.r - a.r);
    for (const item of all.slice(CHECKPOINT_KEEP_LAST)) {
      try { fs.unlinkSync(path.join(CHECKPOINT_DIR, item.f)); } catch (_) {}
    }
  } catch (_) { /* ignore */ }
}

module.exports = {
  saveCheckpoint,
  loadLatestCheckpoint,
  listCheckpoints,
  clearCheckpoints,
  CHECKPOINT_DIR,
  CHECKPOINT_MAX_AGE_MS,
};
