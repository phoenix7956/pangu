// apps/core/modules/goal.js
// 盘古 · 持久目标 / Persistent Goal (Prime Agent /goal 对位, 新政 #2 驾驭层)
// /goal: set / pause / clear / complete / addProgress — 跨 turn 跟踪直到完成
// 注入 _buildSystemMessages, LLM 每轮收到 reminder
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
const GOAL_DIR = path.join(DEFAULT_PANGU_HOME, 'state', 'goals');

const VALID_STATUS = new Set(['active', 'paused', 'completed', 'cleared']);

function ensureDir() { try { fs.mkdirSync(GOAL_DIR, { recursive: true }); } catch (_) {} }

function _atomicWrite(file, content) {
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

// 2026-10-25 (第 92 批): session id → 落盘文件名的唯一真源收成 modules/session_key.js。
//
// 原来这里**不是**跟另外三份一样的拷贝 —— 它多一道正则:
//   '!!!' 这类清洗后不含字母数字的 sid ⇒ 整条塌成 'default'
// 而 'default' 本身是个**真实存在的 session id**。实测 (PANGU_HOME 指到临时目录):
//   setGoal('default', '目标A') → setGoal('!!!', '目标B')
//   之后 getGoal('default') 读出来的是 **'目标B'** ⇒ 两个会话互相顶账。
// goal 会被注入 system 消息 ⇒ 这不是账目问题, 是**给主人看了别人的目标**。
//
// 现在统一走 session_key: 正常 id 文件名逐字不变 (存量零迁移),
// 会被清洗的 id **真撞了别人** 才加原 id 指纹 ⇒ 不覆盖别人的账, 也不跟 default 撞。
const { resolveSessionKey } = require('./session_key');

function _goalFile(sessionId) {
  return path.join(GOAL_DIR, resolveSessionKey(GOAL_DIR, sessionId) + '.json');
}

function _readGoal(sessionId) {
  try {
    const f = _goalFile(sessionId);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) { return null; }
}

function _writeGoal(sessionId, goal) {
  ensureDir();
  _atomicWrite(_goalFile(sessionId), JSON.stringify(goal, null, 2));
}

function setGoal(sessionId, text, opts = {}) {
  if (!text || !String(text).trim()) return { ok: false, error: 'text required' };
  const now = new Date().toISOString();
  const goal = {
    session_id: sessionId || 'default',
    text: String(text).slice(0, 1000),
    status: 'active',
    created_at: now,
    updated_at: now,
    completed_at: null,
    progress: [],
    priority: opts.priority || 'normal',
  };
  _writeGoal(sessionId || 'default', goal);
  return { ok: true, goal };
}

function getGoal(sessionId) {
  return _readGoal(sessionId || 'default');
}

function pauseGoal(sessionId, reason) {
  const g = _readGoal(sessionId || 'default');
  if (!g) return { ok: false, error: 'no goal for this session' };
  g.status = 'paused';
  g.updated_at = new Date().toISOString();
  g.pause_reason = reason || '';
  _writeGoal(sessionId || 'default', g);
  return { ok: true, goal: g };
}

function clearGoal(sessionId) {
  const sid = sessionId || 'default';
  try {
    const f = _goalFile(sid);
    if (fs.existsSync(f)) fs.unlinkSync(f);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function completeGoal(sessionId, summary) {
  const sid = sessionId || 'default';
  const g = _readGoal(sid);
  if (!g) return { ok: false, error: 'no goal for this session' };
  g.status = 'completed';
  g.completed_at = new Date().toISOString();
  g.updated_at = g.completed_at;
  g.completion_summary = summary || '';
  _writeGoal(sid, g);
  return { ok: true, goal: g };
}

function addProgress(sessionId, note) {
  const sid = sessionId || 'default';
  const g = _readGoal(sid);
  if (!g) return { ok: false, error: 'no goal for this session' };
  g.progress.push({ ts: new Date().toISOString(), note: String(note || '').slice(0, 500) });
  // 进度上限 50 条
  if (g.progress.length > 50) g.progress = g.progress.slice(-50);
  g.updated_at = new Date().toISOString();
  _writeGoal(sid, g);
  return { ok: true, goal: g };
}

function listGoals() {
  try {
    if (!fs.existsSync(GOAL_DIR)) return [];
    const out = [];
    for (const f of fs.readdirSync(GOAL_DIR).filter(x => x.endsWith('.json') && !x.startsWith('_'))) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(GOAL_DIR, f), 'utf8'));
        out.push({
          session_id: d.session_id,
          text: d.text,
          status: d.status,
          priority: d.priority,
          created_at: d.created_at,
          updated_at: d.updated_at,
          completed_at: d.completed_at,
          progress_count: (d.progress || []).length,
        });
      } catch (_) {}
    }
    return out.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  } catch (_) { return []; }
}

// 给 _buildSystemMessages 用: 返回 system msg 内容 (或 null)
function renderGoalForSession(sessionId) {
  const g = _readGoal(sessionId || 'default');
  if (!g) return null;
  if (g.status !== 'active') return null; // 只注入 active 的
  const lines = [
    '# 持久目标 (Persistent Goal) — 跨 turn 跟踪, 直到主人 complete / pause / clear',
    '',
    '**目标**: ' + g.text,
    '',
    '**状态**: active (创建于 ' + g.created_at + ')',
    g.priority && g.priority !== 'normal' ? '**优先级**: ' + g.priority + '\n' : '',
    '**进度** (' + (g.progress || []).length + ' 条):',
  ];
  // 最近 5 条进度
  const recent = (g.progress || []).slice(-5);
  if (recent.length === 0) {
    lines.push('(尚无进度记录, 通过 addProgress 或 owner 直接调 goal.addProgress 上报)');
  } else {
    for (const p of recent) lines.push('- [' + p.ts + '] ' + p.note);
  }
  lines.push('');
  lines.push('**运用规则**:');
  lines.push('- 每轮都要在响应里体现对目标的推进 (避免跑偏去无关任务)');
  lines.push('- 遇到阻塞 / 完成 / 切换意图, 通过 goal.addProgress 上报 + 调对应 goal API');
  lines.push('- 完成后通过 goal.complete(summary=...) 收尾');
  lines.push('- 主人改主意 / 暂停 / 取消, 调 goal.pause / clear');
  return lines.filter(x => x !== '').join('\n');
}

module.exports = {
  setGoal, getGoal, pauseGoal, clearGoal, completeGoal, addProgress,
  listGoals, renderGoalForSession,
  _paths: { GOAL_DIR },
};
