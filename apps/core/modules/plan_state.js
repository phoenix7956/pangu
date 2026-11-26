// 2026-09-12 新增 (老板 PANGU_SCAN_REPORT_20260912 §6 L4+L5): Plan schema + 状态机
// 跟 SOP v0.3 (大单拆小单/每步 DoD/派活 5 要素) 对齐 — 让 LLM 真正"会拆任务"
//
// 落地:
// ① 结构化 Plan schema (planner 输出强制 JSON 落盘)
// ② Plan 状态机驱动主循环 — 每轮注入当前 step + 全局进度, 模型必须按 ID 报告
// ③ 自动续跑 — maxRounds 到达时, 若 plan 还有 pending 步骤, 自动 compact + 续跑
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
const PLAN_DIR = process.env.PANGU_PLAN_DIR || path.join(DEFAULT_PANGU_HOME, 'state', 'plans');
const PLAN_STALE_MS = parseInt(process.env.PANGU_PLAN_STALE_MS || String(7 * 24 * 60 * 60 * 1000), 10);

function ensureDir() { try { fs.mkdirSync(PLAN_DIR, { recursive: true }); } catch (_) {} }

// 2026-10-25 (第 92 批): session id → 落盘文件名的唯一真源收成 modules/session_key.js。
//   原来这里有自己一份 _safeSid 拷贝, 各账各写一份 ⇒ 同一个 sid 在不同账里
//   落到不同文件名; 且清洗后不含字母数字的 sid ('!!!' / '@@@') 全落同一个文件,
//   两个不同 session 互相覆盖。
//   resolveSessionKey = 纯清洗 (存量零改名) + 真撞名时才换指纹名 (不覆盖别人的账)。
const { resolveSessionKey } = require('./session_key');

function planFile(sessionId) {
  return path.join(PLAN_DIR, resolveSessionKey(PLAN_DIR, sessionId) + '.json');
}

/**
 * 创建/替换 plan
 * @param {string} sessionId
 * @param {object} plan { goal, steps: [{id, title, dod, status}] }
 */
function setPlan(sessionId, plan) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  if (!plan || !plan.goal || !Array.isArray(plan.steps)) return { ok: false, error: 'INVALID_PLAN' };
  try {
    ensureDir();
    const file = planFile(sessionId);
    // 规范化 steps
    const steps = plan.steps.map((s, i) => ({
      id: String(s.id || ('s' + (i + 1))),
      title: String(s.title || '').slice(0, 200),
      dod: String(s.dod || '').slice(0, 500),
      status: ['pending', 'doing', 'done', 'failed'].includes(s.status) ? s.status : 'pending',
      evidence: String(s.evidence || '').slice(0, 1000),
      updated_at: new Date().toISOString(),
    }));
    const payload = {
      session_id: sessionId,
      goal: String(plan.goal).slice(0, 500),
      steps,
      current_step: plan.current_step || steps.find(s => s.status === 'doing')?.id || steps[0]?.id,
      ts: Date.now(),
      schema: 1,
    };
    const tmp = file + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, path: file, steps_total: steps.length };
  } catch (e) {
    console.warn('[plan-state] set failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * 标记某步骤 done / failed / doing
 */
function updateStep(sessionId, stepId, update) {
  try {
    const file = planFile(sessionId);
    if (!fs.existsSync(file)) return { ok: false, error: 'NO_PLAN' };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const step = (data.steps || []).find(s => s.id === stepId);
    if (!step) return { ok: false, error: 'NO_SUCH_STEP', step_id: stepId };
    if (update.status && ['pending', 'doing', 'done', 'failed'].includes(update.status)) {
      step.status = update.status;
    }
    if (update.evidence) step.evidence = String(update.evidence).slice(0, 1000);
    step.updated_at = new Date().toISOString();
    // 2026-09-12 修 (PANGU_RESCAN O2): step 标 done/failed 后 current_step 自动推进到下一个 pending,
    // 否则渲染注入的"当前步骤"永远滞后, LLM 会重复做已完成的步骤
    if (step.status === 'done' || step.status === 'failed') {
      const _next = (data.steps || []).find(s => s.status === 'pending' || s.status === 'doing');
      data.current_step = _next ? _next.id : stepId;
    } else {
      data.current_step = stepId;
    }
    data.ts = Date.now();
    const tmp = file + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, step };
  } catch (e) { return { ok: false, error: e.message }; }
}

/**
 * 加载 plan
 */
function loadPlan(sessionId) {
  try {
    const file = planFile(sessionId);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - (data.ts || 0) > PLAN_STALE_MS) return null;
    return data;
  } catch (_) { return null; }
}

/**
 * 渲染 plan 用于注入 LLM context
 * @returns {string|null}
 */
function renderPlanForSession(sessionId) {
  const p = loadPlan(sessionId);
  if (!p) return null;
  const done = (p.steps || []).filter(s => s.status === 'done').length;
  const failed = (p.steps || []).filter(s => s.status === 'failed').length;
  const total = (p.steps || []).length;
  const lines = [
    '# Plan 状态机 (跨 turn 持久)',
    '',
    '**目标**: ' + p.goal,
    '**进度**: ' + done + '/' + total + ' done' + (failed > 0 ? (' (' + failed + ' failed)') : ''),
    '**当前步骤**: ' + (p.current_step || '(none)'),
    '',
    '**步骤清单**:',
  ];
  for (const s of (p.steps || [])) {
    const statusIcon = s.status === 'done' ? '✅' : s.status === 'failed' ? '❌' : s.status === 'doing' ? '🔄' : '⏳';
    lines.push('- ' + statusIcon + ' **' + s.id + '**: ' + s.title + (s.dod ? ' [DoD: ' + s.dod + ']' : '') + (s.evidence ? ' [证据: ' + s.evidence.slice(0, 100) + ']' : ''));
  }
  lines.push('');
  lines.push('**运用规则**:');
  lines.push('- 无 plan 时长任务开工先调 plan_create({goal, steps:[{id,title,dod}]})');
  lines.push('- 每轮必须推进 current_step 或切下一个 pending');
  lines.push('- 完成时调 plan_step_done({step_id, evidence=文件/测试路径}) — DoD 必须可验证');
  lines.push('- 失败时调 plan_step_failed({step_id, reason})');
  lines.push('- 全部步骤 done 后正常 task_done 收口 (plan 即视为完成, 无单独 complete 工具)');
  return lines.join('\n');
}

function listActivePlans() {
  try {
    ensureDir();
    const files = fs.readdirSync(PLAN_DIR).filter(f => f.endsWith('.json'));
    const out = [];
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(PLAN_DIR, f), 'utf8'));
        const done = (data.steps || []).filter(s => s.status === 'done').length;
        if (done < (data.steps || []).length && Date.now() - (data.ts || 0) < PLAN_STALE_MS) {
          out.push({ ...data, _file: f });
        }
      } catch (_) {}
    }
    return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  } catch (_) { return []; }
}

function clearPlan(sessionId) {
  try { fs.unlinkSync(planFile(sessionId)); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

module.exports = {
  setPlan, updateStep, loadPlan, renderPlanForSession, listActivePlans, clearPlan,
  _paths: { PLAN_DIR, PLAN_STALE_MS },
};
