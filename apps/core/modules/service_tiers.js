// 2026-08-16 P3: TAS/AAAS/RAS 服务分级 (新政 #6 按结果计费, 告别按 token 粗放计费)
// TAS  = Task-as-a-Service: 一次性任务调用, 按 task_done 次数计费
// AAAS = Agent-as-a-Service:  长会话多 round, 按 wall-time 计费
// RAS  = Result-as-a-Service: 按交付 artifact + outcome 计费 (新政 #1 闭环 + 新政 #6 按结果)
'use strict';

const TIERS = {
  tas: {
    name: 'TAS',
    full: 'Task-as-a-Service',
    description: '一次性任务调用, 按 task_done 次数计费',
    billing_metric: 'task_done_count',
    default_budget: { max_rounds: 5, max_tokens: 20000, max_wall_ms: 60000, max_tool_calls: 10 },
    suitable_for: ['短查询', '翻译', '简单代码生成', '问答'],
  },
  aaas: {
    name: 'AAAS',
    full: 'Agent-as-a-Service',
    description: '长会话多 round, 按 wall-time 计费 (银河算郎)',
    billing_metric: 'wall_time_minutes',
    default_budget: { max_rounds: 30, max_tokens: 200000, max_wall_ms: 1800000, max_tool_calls: 100 },
    suitable_for: ['复杂编程', '多步调试', '跨系统操作', '长会话协作'],
  },
  ras: {
    name: 'RAS',
    full: 'Result-as-a-Service',
    description: '按交付 artifact + outcome 计费 (新政 #1 闭环 + 新政 #6 按结果)',
    billing_metric: 'artifact_count + outcome_status',
    default_budget: { max_rounds: 50, max_tokens: 500000, max_wall_ms: 3600000, max_tool_calls: 200 },
    suitable_for: ['批处理', 'ETL', '自动化报告', '批量 artifact 生成'],
  },
};

// per-session tier override (env > tier default)
const _overrides = new Map();

function getTierConfig(tierName, sessionId) {
  const base = TIERS[tierName] || TIERS.aaas;
  if (sessionId && _overrides.has(sessionId)) {
    return { ...base, default_budget: { ...base.default_budget, ..._overrides.get(sessionId) } };
  }
  return base;
}

function setOverride(sessionId, budgetOverride) {
  _overrides.set(sessionId, budgetOverride);
}

function clearOverride(sessionId) { _overrides.delete(sessionId); }

function listTiers() {
  return Object.entries(TIERS).map(([k, v]) => ({ id: k, ...v }));
}

module.exports = { TIERS, getTierConfig, setOverride, clearOverride, listTiers };
