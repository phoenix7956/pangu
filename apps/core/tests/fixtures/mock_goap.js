'use strict';

// Mock GOAP module for j2 integration test
// Stub planAStar + formatGoal + planToMarkdown

async function formatGoal(text, ctx, opts) {
  return {
    goal: text.slice(0, 50),
    success_criteria: ['mock_criterion'],
    constraints: [],
    prerequisites: [],
    scope: 'short_term',
    estimated_effort: 'medium',
    risks: [],
  };
}

function planAStar(initialState, goalState, opts) {
  return {
    success: true,
    plan: [
      { action: 'mock_step_1', description: 'mock step 1', step: 1, effects: ['x'], rollback: 'none', from_state: '{}', to_state: '{"x":true}' },
      { action: 'mock_step_2', description: 'mock step 2', step: 2, effects: ['y'], rollback: 'none', from_state: '{"x":true}', to_state: '{"x":true,"y":true}' },
    ],
    cost: 5,
    iterations: 3,
  };
}

function planToMarkdown(plan, goal, opts) {
  return `## 🧭 GOAP Plan (mock)\ngoal: ${goal.goal}\n\n### Plan tree (${plan.plan.length} steps, total cost ${plan.cost})\n1. ☐ mock_step_1 — mock step 1\n2. ☐ mock_step_2 — mock step 2`;
}

module.exports = { formatGoal, planAStar, planToMarkdown };
