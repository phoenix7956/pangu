// 2026-08-16 P3: housekeeping — 自动清理老 session / 老 issue / 老 ck / 大 outcomes
// 新政 #10 理性落地: 系统自治, 不留冗余
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
const SESSIONS_DIR = process.env.PANGU_SESSIONS_DIR || path.join(os.homedir(), '.pangu-data', 'sessions');
const ISSUES_ARCHIVED_DIR = path.join(DEFAULT_PANGU_HOME, '..', 'pangu', 'issues', 'archived');
const CHECKPOINT_DIR = process.env.PANGU_CHECKPOINT_DIR || path.join(DEFAULT_PANGU_HOME, 'state', 'checkpoints');
const OUTCOMES_DIR = process.env.PANGU_OUTCOMES_DIR || path.join(DEFAULT_PANGU_HOME, 'state', 'outcomes');
const REPO_ROOT = process.env.PANGU_REPO_ROOT || path.join(__dirname, '..', '..', '..');

// 默认阈值
const DEFAULTS = {
  session_max_age_days: 90,      // 超过 90 天没更新的 session 删
  session_max_total: 100,        // 超过 100 个就按 mtime 删最老
  issue_archived_max_age_days: 90, // archived issues 超过 90 天删
  checkpoint_max_age_days: 7,    // ck 超 7 天删 (P0-1 30min 是 fresh, 7d 是 housekeeping)
  outcome_max_age_days: 90,      // outcomes 90 天删
  outcome_max_file_mb: 10,       // 单 jsonl 超 10MB 滚动
};

/**
 * 跑全量 housekeeping, 返回每项清理结果
 */
async function runAll(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const results = [];

  // 1. sessions: 按 age + count 双重清理
  results.push({
    name: 'sessions',
    ..._cleanupSessions(cfg),
  });

  // 2. archived issues
  results.push({
    name: 'issues_archived',
    ..._cleanupIssues(cfg),
  });

  // 3. checkpoints
  results.push({
    name: 'checkpoints',
    ..._cleanupCheckpoints(cfg),
  });

  // 4. outcomes
  results.push({
    name: 'outcomes',
    ..._cleanupOutcomes(cfg),
  });

  // 5. repair queue: archived + 清空 pending (>30d)
  results.push({
    name: 'repair_queue',
    ..._cleanupRepair(cfg),
  });

  const total_removed = results.reduce((s, r) => s + (r.removed || 0), 0);
  return { ok: true, ts: Date.now(), total_removed, results };
}

function _cleanupSessions(cfg) {
  if (!fs.existsSync(SESSIONS_DIR)) return { ok: true, removed: 0, reason: 'no sessions dir' };
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  const now = Date.now();
  const maxAgeMs = cfg.session_max_age_days * 86400 * 1000;
  let removed = 0;
  const fileStats = [];
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(SESSIONS_DIR, f));
      fileStats.push({ f, mtime: st.mtimeMs, size: st.size });
    } catch (_) {}
  }
  // 先按 age 删
  for (const item of fileStats.slice()) {
    if (now - item.mtime > maxAgeMs) {
      try { fs.unlinkSync(path.join(SESSIONS_DIR, item.f)); removed++; fileStats.splice(fileStats.indexOf(item), 1); } catch (_) {}
    }
  }
  // 再按 count 删 (保留最新 N 个)
  fileStats.sort((a, b) => b.mtime - a.mtime);
  const toRemove = fileStats.slice(cfg.session_max_total);
  for (const item of toRemove) {
    try { fs.unlinkSync(path.join(SESSIONS_DIR, item.f)); removed++; } catch (_) {}
  }
  return { ok: true, removed, before: files.length, after: files.length - removed };
}

function _cleanupIssues(cfg) {
  // 找 repo root 的 issues/archived (用户盘古代码)
  const candidates = [
    path.join(REPO_ROOT, 'issues', 'archived'),
    path.join(DEFAULT_PANGU_HOME, '..', 'pangu', 'issues', 'archived'),
  ];
  let dir = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) { dir = c; break; }
  }
  if (!dir) return { ok: true, removed: 0, reason: 'no archived dir' };
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  const now = Date.now();
  const maxAgeMs = cfg.issue_archived_max_age_days * 86400 * 1000;
  let removed = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(dir, f));
      if (now - st.mtimeMs > maxAgeMs) {
        fs.unlinkSync(path.join(dir, f));
        removed++;
      }
    } catch (_) {}
  }
  return { ok: true, removed, before: files.length, after: files.length - removed, dir };
}

function _cleanupCheckpoints(cfg) {
  if (!fs.existsSync(CHECKPOINT_DIR)) return { ok: true, removed: 0, reason: 'no ck dir' };
  const files = fs.readdirSync(CHECKPOINT_DIR).filter(f => f.endsWith('.json'));
  const now = Date.now();
  const maxAgeMs = cfg.checkpoint_max_age_days * 86400 * 1000;
  let removed = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(CHECKPOINT_DIR, f));
      if (now - st.mtimeMs > maxAgeMs) {
        fs.unlinkSync(path.join(CHECKPOINT_DIR, f));
        removed++;
      }
    } catch (_) {}
  }
  return { ok: true, removed, before: files.length, after: files.length - removed };
}

function _cleanupOutcomes(cfg) {
  if (!fs.existsSync(OUTCOMES_DIR)) return { ok: true, removed: 0, reason: 'no outcomes dir' };
  const files = fs.readdirSync(OUTCOMES_DIR).filter(f => f.endsWith('.jsonl'));
  const now = Date.now();
  const maxAgeMs = cfg.outcome_max_age_days * 86400 * 1000;
  const maxBytes = cfg.outcome_max_file_mb * 1024 * 1024;
  let removed = 0, truncated = 0;
  for (const f of files) {
    const fp = path.join(OUTCOMES_DIR, f);
    try {
      const st = fs.statSync(fp);
      // 按 age 删
      if (now - st.mtimeMs > maxAgeMs) { fs.unlinkSync(fp); removed++; continue; }
      // 按 size 滚动 (保留后半段)
      if (st.size > maxBytes) {
        const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
        const keep = Math.floor(lines.length / 2);
        const kept = lines.slice(-keep).join('\n') + '\n';
        fs.writeFileSync(fp, kept);
        truncated++;
      }
    } catch (_) {}
  }
  return { ok: true, removed, truncated, total_files: files.length };
}

function _cleanupRepair(cfg) {
  const repairDir = path.join(REPO_ROOT, 'repair');
  if (!fs.existsSync(repairDir)) return { ok: true, removed: 0, reason: 'no repair dir' };
  const files = fs.readdirSync(repairDir).filter(f => f.endsWith('.json'));
  const now = Date.now();
  const maxAgeMs = 30 * 86400 * 1000;
  let removed = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(repairDir, f));
      if (now - st.mtimeMs > maxAgeMs) {
        fs.unlinkSync(path.join(repairDir, f));
        removed++;
      }
    } catch (_) {}
  }
  return { ok: true, removed, before: files.length, after: files.length - removed };
}

/**
 * 当前状态统计 (dry-run, 不删)
 */
function stats() {
  const s = {};
  // sessions
  try {
    const sf = fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')) : [];
    s.sessions = { count: sf.length };
  } catch (e) { s.sessions = { error: e.message }; }
  // issues
  for (const c of [path.join(REPO_ROOT, 'issues', 'archived'), path.join(DEFAULT_PANGU_HOME, '..', 'pangu', 'issues', 'archived')]) {
    if (fs.existsSync(c)) {
      const f = fs.readdirSync(c).filter(x => x.endsWith('.md'));
      s.issues_archived = { count: f.length, dir: c };
      break;
    }
  }
  // checkpoints
  try {
    const cf = fs.existsSync(CHECKPOINT_DIR) ? fs.readdirSync(CHECKPOINT_DIR).filter(f => f.endsWith('.json')) : [];
    s.checkpoints = { count: cf.length };
  } catch (e) { s.checkpoints = { error: e.message }; }
  // outcomes
  try {
    const of = fs.existsSync(OUTCOMES_DIR) ? fs.readdirSync(OUTCOMES_DIR).filter(f => f.endsWith('.jsonl')) : [];
    let totalBytes = 0;
    for (const f of of) { try { totalBytes += fs.statSync(path.join(OUTCOMES_DIR, f)).size; } catch (_) {} }
    s.outcomes = { count: of.length, total_mb: Math.round(totalBytes / 1024 / 1024 * 100) / 100 };
  } catch (e) { s.outcomes = { error: e.message }; }
  // repair
  try {
    const rf = fs.existsSync(path.join(REPO_ROOT, 'repair')) ? fs.readdirSync(path.join(REPO_ROOT, 'repair')).filter(f => f.endsWith('.json')) : [];
    s.repair_queue = { count: rf.length };
  } catch (e) { s.repair_queue = { error: e.message }; }
  return s;
}

module.exports = { runAll, stats, DEFAULTS, SESSIONS_DIR, ISSUES_ARCHIVED_DIR, CHECKPOINT_DIR, OUTCOMES_DIR };
