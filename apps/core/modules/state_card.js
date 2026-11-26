// modules/state_card.js — 2026-09-16 一期 ① 状态卡片自动注入
// 老板: "不这么问它也不知道怎么回答" → 每个会话启动 / 每轮主动带上进度账, 不用喂提示。
//
// 数据源全部是既有真源, 不新造:
//   - plan_state.listActivePlans() / loadPlan()  跨会话的活跃任务 + 本会话 plan
//   - task_ledger.loadLedger()                   本会话真账 (已读/已写/上次死因)
//   - task_ledger.last_run                        上次运行状态
//
// 设计: 紧凑 (≤ ~400 字), 只放"决策级"信息 — 已完成/剩余/卡点/下一步选项。
//       不灌工具结果正文 (那是 ③ 截断层管的事)。
'use strict';

const path = require('path');
const fs = require('fs');

let _planState = null;
let _taskLedger = null;
function _ps() { if (!_planState) _planState = require('./plan_state'); return _planState; }
function _tl() { if (!_taskLedger) _taskLedger = require('./task_ledger'); return _taskLedger; }

// 跨会话活跃任务 (最近 N 个), 按最近活跃排序
function _recentActivePlans(limit = 3) {
  try {
    const all = _ps().listActivePlans() || [];
    return all.slice(0, limit);
  } catch (_) { return []; }
}

// 本会话 ledger 摘要 (目标/上次死因/已写文件数), 一行级
function _ledgerDigest(sessionId) {
  try {
    const l = _tl().loadLedger(sessionId);
    if (!l) return null;
    const bits = [];
    if (l.goal) bits.push('目标: ' + String(l.goal).slice(0, 80));
    if (l.last_run && l.last_run.status) bits.push('上次: ' + l.last_run.status + (l.last_run.note ? ' (' + String(l.last_run.note).slice(0, 40) + ')' : ''));
    const written = (l.facts && l.facts.files_written || []).length;
    const read = (l.facts && l.facts.files_read || []).length;
    if (written || read) bits.push('已读' + read + ' 已写' + written);
    return bits.length ? bits.join(' | ') : null;
  } catch (_) { return null; }
}

// 单个 plan 的状态行
function _planLine(p) {
  const steps = p.steps || [];
  const done = steps.filter(s => s.status === 'done').length;
  const total = steps.length;
  const cur = p.current_step ? (steps.find(s => s.id === p.current_step) || {}) : {};
  const pending = steps.filter(s => s.status === 'pending').length;
  const failed = steps.filter(s => s.status === 'failed').length;
  const sess = p.session_id && p.session_id !== 'default' ? ' [' + String(p.session_id).slice(0, 20) + ']' : '';
  let line = '▸ ' + String(p.goal || '(无目标)').slice(0, 50) + ' — ' + done + '/' + total + ' 完成';
  if (cur.title) line += ', 当前: ' + String(cur.title).slice(0, 30);
  if (pending) line += ', 剩 ' + pending;
  if (failed) line += ', 失败 ' + failed;
  return line + sess;
}

// 下一步选项: 从当前 doing/pending 步骤里取前 3 个可执行动作
function _nextOptions(p, limit = 3) {
  const steps = p.steps || [];
  const actionable = steps.filter(s => s.status === 'doing' || s.status === 'pending');
  const opts = actionable.slice(0, limit).map(s => s.title || s.id).map(t => String(t).slice(0, 24));
  if (actionable.length > limit) opts.push('…共 ' + actionable.length + ' 步');
  return opts;
}

/**
 * 渲染状态卡片 (system 注入用)。
 * @returns {string|null} 无活跃状态 → null (不注入, 省 token)
 */
function render(sessionId, opts = {}) {
  const lines = [];

  // 本会话 plan (最相关, 放最前)
  let localPlan = null;
  try { localPlan = _ps().loadPlan(sessionId); } catch (_) {}
  if (localPlan && (localPlan.steps || []).length) {
    lines.push('# 当前任务进度卡 (本会话, 真账自动注入 — 不用主人提示就知道聊到哪)');
    lines.push(_planLine(localPlan));
    const optsList = _nextOptions(localPlan);
    if (optsList.length) lines.push('下一步可选: ' + optsList.join(' / '));
  }

  // 本会话 ledger 摘要 (即使没 plan 也有)
  const digest = _ledgerDigest(sessionId);
  if (digest) {
    if (!lines.length) lines.push('# 当前任务进度卡 (本会话)');
    lines.push(digest);
  }

  // 跨会话任务不能注入主对话: 它们不是当前用户问题, 会诱发模型串任务。
  // 需要查看全局任务时由 dashboard/专门状态接口提供, 不混进 LLM 上下文。
  const recent = opts.includeCrossSession === true
    ? _recentActivePlans(3).filter(p => p.session_id !== sessionId || !localPlan)
    : [];
  if (recent.length) {
    lines.push('# 其他活跃任务 (跨会话, 最近 3)');
    for (const p of recent) lines.push(_planLine(p));
  }

  if (!lines.length) return null;
  return lines.join('\n');
}

module.exports = { render, _nextOptions, _planLine, _recentActivePlans, _ledgerDigest };
