// apps/core/agents/refine.js
// 盘古 · 连续改进 / Continual Harness (Prime Agent 对位)
// P0-A: 装上 "/refine" 能力 —— 审 trajectory 提取 lesson, 写到 supplemental harness state, snapshot 存档, 可 rollback
// P0-2 独立性: 路径走 PANGU_HOME/state/harness (default ~/.pangu/state/harness), 不依赖任何外部 agent 框架
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
// 2026-10-26 第 100 批: harness 目录走唯一真源 (modules/state_paths.js)
const statePaths = require('../modules/state_paths');
const HARNESS_DIR = () => statePaths.harnessDir();
const HARNESS_FILE = () => path.join(HARNESS_DIR(), 'global.json');
const SNAPSHOT_DIR = () => path.join(HARNESS_DIR(), 'snapshots');
const MAX_ENTRIES = 50;
const MAX_SNAPSHOTS = 30;

function ensureDirs() {
  try { fs.mkdirSync(HARNESS_DIR(), { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(SNAPSHOT_DIR(), { recursive: true }); } catch (_) {}
}

function _atomicWrite(file, content) {
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function loadHarness() {
  try {
    if (!fs.existsSync(HARNESS_FILE())) return { entries: [], updated_at: null };
    const data = JSON.parse(fs.readFileSync(HARNESS_FILE(), 'utf8'));
    return { entries: Array.isArray(data.entries) ? data.entries : [], updated_at: data.updated_at || null };
  } catch (_) {
    return { entries: [], updated_at: null };
  }
}

function saveHarness(state) {
  ensureDirs();
  if (state.entries.length > MAX_ENTRIES) {
    state.entries = state.entries.slice(-MAX_ENTRIES);
  }
  state.updated_at = new Date().toISOString();
  _atomicWrite(HARNESS_FILE(), JSON.stringify(state, null, 2));
}

function _newSnapshotId() {
  return new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
}

function createSnapshot(reason) {
  ensureDirs();
  const state = loadHarness();
  const id = _newSnapshotId();
  const snap = {
    id,
    ts: new Date().toISOString(),
    reason: reason || 'manual',
    harness: state,
  };
  _atomicWrite(path.join(SNAPSHOT_DIR(), id + '.json'), JSON.stringify(snap, null, 2));
  _enforceSnapshotCap();
  return snap;
}

function _enforceSnapshotCap() {
  try {
    const files = fs.readdirSync(SNAPSHOT_DIR()).filter(f => f.endsWith('.json')).map(f => {
      const full = path.join(SNAPSHOT_DIR(), f);
      return { f, mtime: fs.statSync(full).mtimeMs };
    }).sort((a, b) => a.mtime - b.mtime);
    while (files.length > MAX_SNAPSHOTS) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(SNAPSHOT_DIR(), oldest.f)); } catch (_) {}
    }
  } catch (_) {}
}

function listSnapshots() {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR())) return [];
    const out = [];
    for (const f of fs.readdirSync(SNAPSHOT_DIR()).filter(x => x.endsWith('.json'))) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR(), f), 'utf8'));
        out.push({
          id: d.id,
          ts: d.ts,
          reason: d.reason,
          entries_count: d.harness && d.harness.entries ? d.harness.entries.length : 0,
        });
      } catch (_) {}
    }
    return out.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  } catch (_) { return []; }
}

function rollback(snapshotId) {
  if (!snapshotId) return { ok: false, error: 'snapshot_id required' };
  const file = path.join(SNAPSHOT_DIR(), snapshotId + '.json');
  if (!fs.existsSync(file)) return { ok: false, error: 'snapshot not found: ' + snapshotId };
  try {
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!snap.harness || !Array.isArray(snap.harness.entries)) return { ok: false, error: 'snapshot corrupt' };
    const currentSnap = createSnapshot('pre-rollback-' + snapshotId);
    saveHarness(snap.harness);
    return { ok: true, restored_snapshot: snapshotId, pre_rollback_snapshot: currentSnap.id, entries_count: snap.harness.entries.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function _buildRefinePrompt(trajectory) {
  const trajStr = typeof trajectory === 'string' ? trajectory : JSON.stringify(trajectory).slice(0, 12000);
  return [
    '你是盘古的连续改进引擎 (参考 Prime Agent 的 /refine)。任务: 从以下 trajectory 中提取"在未来任务中要避免的错误"和"要继承的有效策略"。',
    '',
    '## 输出要求 (严格 JSON)',
    '返回一个 JSON 数组, 每项包含 kind + content:',
    '- kind: "lesson" (避免错误) | "policy" (行为准则) | "skill_hint" (能力提示)',
    '- content: 一句话描述, 带场景',
    '',
    '## 限制',
    '- 最多 5 条',
    '- 严禁复制 trajectory 原文',
    '- 只记录能在未来任务重复利用的经验',
    '',
    '## Trajectory',
    trajStr,
  ].join('\n');
}

function _parseLessons(content) {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    const arr = Array.isArray(parsed) ? parsed : (parsed.lessons || parsed.entries || []);
    return arr.filter(x => x && x.content).slice(0, 5).map(x => ({ kind: x.kind || 'lesson', content: String(x.content).slice(0, 500) }));
  } catch (_) {
    return [];
  }
}

async function refine(opts) {
  const trajectory = (opts && opts.trajectory);
  const source = (opts && opts.source) || 'refine';
  if (!trajectory) return { ok: false, error: 'trajectory required' };
  ensureDirs();
  const preSnap = createSnapshot('pre-refine');
  let lessons = [];
  try {
    const llm = require('../modules/llm_caller').callLLM;
    const prompt = _buildRefinePrompt(trajectory);
    const result = await llm([{ role: 'user', content: prompt }]);
    const content = (result && (result.content || (result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content))) || '';
    lessons = _parseLessons(content);
  } catch (e) {
    console.warn('[refine] LLM call failed:', e.message && e.message.slice(0, 200));
  }
  if (lessons.length === 0) {
    return { ok: false, error: 'LLM 未返回有效 lesson (请检查 trajectory 是否包含足够信息)', pre_snapshot: preSnap.id };
  }
  const state = loadHarness();
  const ts = new Date().toISOString();
  for (const l of lessons) {
    state.entries.push({
      kind: l.kind || 'lesson',
      content: l.content,
      ts,
      source,
      snapshot_id: preSnap.id,
    });
  }
  saveHarness(state);
  return {
    ok: true,
    lessons_added: lessons.length,
    entries_total: state.entries.length,
    pre_refine_snapshot: preSnap.id,
  };
}

async function applyHarnessDelta(options) {
  options = options || {};
  const sinceMs = options.sinceMs || 7 * 86400 * 1000;
  const outDir = process.env.PANGU_OUTCOMES_DIR || path.join(DEFAULT_PANGU_HOME, 'state', 'outcomes');
  if (!fs.existsSync(outDir)) return { ok: true, applied: 0, message: 'no outcomes' };
  const sinceTs = Date.now() - sinceMs;
  const failures = [];
  for (const f of fs.readdirSync(outDir).filter(x => x.endsWith('.jsonl'))) {
    try {
      for (const line of fs.readFileSync(path.join(outDir, f), 'utf8').split('\n').filter(Boolean)) {
        const d = JSON.parse(line);
        if (d.ts >= sinceTs && (d.status === 'failed' || d.status === 'partial')) {
          failures.push(d);
        }
      }
    } catch (_) {}
  }
  if (failures.length === 0) return { ok: true, applied: 0, message: 'no recent failures' };
  const trajectory = {
    source: 'auto-improve',
    window_days: Math.round(sinceMs / 86400000),
    failure_count: failures.length,
    cases: failures.slice(0, 8).map(f => ({
      session_id: f.session_id,
      status: f.status,
      rounds: f.metrics && f.metrics.rounds,
      artifacts_count: f.artifacts_count,
      summary: f.summary || (f.metrics && f.metrics.summary),
    })),
  };
  const result = await refine({ trajectory, source: 'auto-improve' });
  return { ok: result.ok, applied: result.lessons_added || 0, pre_snapshot: result.pre_refine_snapshot, error: result.error };
}

module.exports = {
  loadHarness,
  saveHarness,
  createSnapshot,
  listSnapshots,
  rollback,
  refine,
  applyHarnessDelta,
  _paths: { HARNESS_FILE, SNAPSHOT_DIR, HARNESS_DIR },
};
