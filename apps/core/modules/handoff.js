// modules/handoff.js — 2026-09-16 一期 ② 长会话自动交接
// 老板: "一个会话能装下的东西太少" → 治本不是让单会话无限长, 是让它能不断档地交接下去。
//
// 触发: 单会话 rounds >= HANDOFF_ROUNDS(200) 或 累计输入 token >= HANDOFF_TOKENS(800K)。
// 动作: 把当前 plan / ledger / 关键结论 写成交接卡落盘 (按 session), 发 SSE 提示主人开新会话;
//       新会话启动时 ① state_card 会自动把它当"跨会话活跃任务"带进来, 秒接上 — 不重发旧历史。
//
// 交接卡 = 自包含的状态快照, 新会话只读这几百字, 不把 384 轮历史灌进去。
'use strict';

const path = require('path');
const fs = require('fs');
// 2026-10-25 (第 92 批): session id → 落盘文件名的唯一真源。
//   原来这里自己抄了一份清洗 ⇒ '!!!' 与 '@@@' 落同一个文件, 两个会话互相覆盖。
//   resolveSessionKey = 纯清洗 (存量零改名) + 真撞名时才换指纹名 (不覆盖别人的账)。
const { resolveSessionKey } = require('./session_key');

const HANDOFF_DIR = process.env.PANGU_HANDOFF_DIR || path.join(process.env.HOME || '.', '.pangu', 'state', 'handoff');
const HANDOFF_ROUNDS = parseInt(process.env.PANGU_HANDOFF_ROUNDS || '200', 10);
const HANDOFF_TOKENS = parseInt(process.env.PANGU_HANDOFF_TOKENS || '800000', 10);
// 2026-09-16 二期: rounds 会被压缩续命反复归零 → 触发不了。改用消息数 (会话真实长度, 不被重置)
const HANDOFF_MSGS = parseInt(process.env.PANGU_HANDOFF_MSGS || '200', 10);
const HANDOFF_STALE_MS = 24 * 60 * 60 * 1000; // 24h 内有效, 过期不再带

function _ensureDir() { try { fs.mkdirSync(HANDOFF_DIR, { recursive: true }); } catch (_) {} }
function _file(sessionId) {
  const safe = resolveSessionKey(HANDOFF_DIR, sessionId);
  return path.join(HANDOFF_DIR, safe + '.json');
}

/**
 * 写交接卡。
 * @returns {{ok:boolean, path?:string, card?:string}}
 */
function writeHandoff(sessionId, { rounds = 0, inputTokens = 0, reason = 'auto' } = {}) {
  _ensureDir();
  let plan = null, ledger = null, taskCp = null;
  try { plan = require('./plan_state').loadPlan(sessionId); } catch (_) {}
  try { ledger = require('./task_ledger').loadLedger(sessionId); } catch (_) {}
  try { taskCp = require('./task_checkpoint').loadTaskCheckpoint(sessionId); } catch (_) {}

  const steps = (plan && plan.steps) || [];
  const done = steps.filter(s => s.status === 'done');
  const pending = steps.filter(s => s.status === 'pending' || s.status === 'doing');

  const card = {
    session_id: sessionId,
    created_at: Date.now(),
    reason,
    rounds,
    input_tokens: inputTokens,
    goal: (plan && plan.goal) || (taskCp && taskCp.goal) || (ledger && ledger.goal) || null,
    current_step: (plan && plan.current_step) || null,
    progress: plan ? (done.length + '/' + steps.length) : null,
    // 剩余要做 (决策级, 不灌正文)
    remaining: pending.map(s => ({ id: s.id, title: s.title, dod: s.dod })),
    // 已完成 (证据路径, 新会话知道哪几块不用重做)
    completed: done.map(s => ({ id: s.id, title: s.title, evidence: s.evidence })),
    // 真账摘要
    facts: ledger ? {
      files_written: ((ledger.facts && ledger.facts.files_written) || []).map(w => w.path).slice(-20),
      last_run: ledger.last_run || null,
      lessons: (ledger.lessons || []).slice(-5),
    } : null,
    // 断点 (task_checkpoint 存的真进度)
    checkpoint: taskCp || null,
  };

  const file = _file(sessionId);
  try {
    fs.writeFileSync(file, JSON.stringify(card, null, 2));
    return { ok: true, path: file, card };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 渲染成 system 注入的紧凑文本 (新会话 / 本会话续跑用)
function renderForSession(sessionId) {
  try {
    const file = _file(sessionId);
    if (!fs.existsSync(file)) return null;
    const card = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - (card.created_at || 0) > HANDOFF_STALE_MS) return null;
    const lines = ['# 交接卡 (来自 ' + (card.session_id || '?') + ', ' + card.reason + ', ' + card.rounds + ' 轮)'];
    if (card.goal) lines.push('目标: ' + String(card.goal).slice(0, 100));
    if (card.progress) lines.push('进度: ' + card.progress + (card.current_step ? ', 卡在 ' + card.current_step : ''));
    if ((card.remaining || []).length) {
      lines.push('剩余 (' + card.remaining.length + '):');
      for (const r of card.remaining.slice(0, 6)) lines.push('  - ' + (r.title || r.id) + (r.dod ? ' [DoD: ' + String(r.dod).slice(0, 40) + ']' : ''));
    }
    if ((card.completed || []).length) {
      lines.push('已完成 (勿重做):');
      for (const c of card.completed.slice(0, 6)) lines.push('  - ' + (c.title || c.id) + (c.evidence ? ' ← ' + String(c.evidence).slice(0, 50) : ''));
    }
    if (card.facts && (card.facts.files_written || []).length) {
      lines.push('已写文件 (真账): ' + card.facts.files_written.slice(-6).join(', '));
    }
    lines.push('【铁律】基于本卡继续, 不要重做已完成步骤; 需要细节按 evidence/文件路径 read_file 取。');
    return lines.join('\n');
  } catch (_) { return null; }
}

// 跨会话: 最近 N 张未过期交接卡 (给 state_card 当"其他活跃任务"用)
function listRecent(limit = 3) {
  _ensureDir();
  try {
    const now = Date.now();
    const out = [];
    for (const f of fs.readdirSync(HANDOFF_DIR).filter(x => x.endsWith('.json'))) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(HANDOFF_DIR, f), 'utf8'));
        if (now - (c.created_at || 0) <= HANDOFF_STALE_MS) out.push(c);
      } catch (_) {}
    }
    return out.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, limit);
  } catch (_) { return []; }
}

// 是否该触发交接 (本会话)
function shouldHandoff(sessionId, { rounds = 0, inputTokens = 0, msgCount = 0 } = {}) {
  // 2026-09-16 二期: 消息数是会话真实长度 (压缩不重置), 主判据; rounds 会被续命归零只做辅助
  if (msgCount >= HANDOFF_MSGS) return { yes: true, reason: 'msgs>=' + HANDOFF_MSGS };
  if (rounds >= HANDOFF_ROUNDS) return { yes: true, reason: 'rounds>=' + HANDOFF_ROUNDS };
  if (inputTokens >= HANDOFF_TOKENS) return { yes: true, reason: 'tokens>=' + (HANDOFF_TOKENS / 1000) + 'K' };
  return { yes: false };
}

module.exports = { writeHandoff, renderForSession, listRecent, shouldHandoff, HANDOFF_ROUNDS, HANDOFF_TOKENS, HANDOFF_MSGS };
