'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { runAgentLoop } = require('../agents/sub-agent');

const toolCall = (name, args) => `<tool name="${name}">${JSON.stringify(args)}</tool>`;

const BASE = {
  taskText: 'regression',
  mode: 'executor',
  model: {},
  cfg: {},
  toolsAllowed: ['probe_missing'],
};

const RC = (max) => ({ max_tool_iterations: max, parallel_tools: false, memory_enabled: false });

function makeLLM(plan, seen) {
  let n = 0;
  return async (messages) => {
    n += 1;
    for (const m of messages) {
      if (m && typeof m.content === 'string') seen.push(m.content);
    }
    return { text: (plan[n] === undefined) ? 'wrap-up summary' : plan[n] };
  };
}

function workingPlan(rounds) {
  const p = {};
  for (let i = 1; i <= rounds; i++) p[i] = toolCall('probe_missing', { i });
  return p;
}

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = String(vars[k]);
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(prev)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    });
}

const BUDGET_MSG = '工具调用预算';

// S1 撞满工具预算 + 有实质进展 -> 自动续窗, 子 agent 从没被告知预算用完
// 长任务撞死的不是轮次墙 (轮次有 auto_resume), 是 max_tool_iterations 这道工具预算墙。
test('S1 撞满工具预算但有实质进展 = 自动续窗, 长任务不被腰斩 (2026-10-14)', async () => {
  const seen = [];
  const stages = [];
  // 预算只给 5 次, 活要干 12 轮 -- 旧码第 5 轮就判死。
  await withEnv({ PANGU_SUBAGENT_AUTO_RESUME_MAX: 3, PANGU_SUBAGENT_HARD_MAX_ROUNDS: undefined }, async () => {
    const r = await runAgentLoop({
      ...BASE,
      roleCfg: RC(5),
      callLLMFn: makeLLM(workingPlan(12), seen),
      onProgress: (e) => stages.push(e.stage),
    });
    assert.equal(r.toolsUsed.length, 12, `12 轮的工具都该真执行过, 实际 ${r.toolsUsed.length} -- 撞预算后被腰斩`);
    assert.equal(r.summary, 'wrap-up summary');
  });
  assert.ok(stages.includes('sub_budget_resume'),
    `撞满预算后必须上报 sub_budget_resume, 实际阶段: ${JSON.stringify(stages)}`);
  assert.ok(!seen.some((t) => t.includes(BUDGET_MSG)),
    '有实质进展时子 agent 不该被告知预算用完 -- 那正是长任务被腰斩的现场');
});

// S2 没开 auto_resume -> 旧行为逐字不变 (回归锁)
test('S2 没开 auto_resume = 撞满预算即收, 旧行为不变 (2026-10-14)', async () => {
  const seen = [];
  const stages = [];
  await withEnv({ PANGU_SUBAGENT_AUTO_RESUME_MAX: undefined }, async () => {
    const r = await runAgentLoop({
      ...BASE,
      roleCfg: RC(5),
      callLLMFn: makeLLM(workingPlan(12), seen),
      onProgress: (e) => stages.push(e.stage),
    });
    assert.equal(r.summary, 'wrap-up summary');
  });
  assert.ok(seen.some((t) => t.includes(BUDGET_MSG)),
    '没开续跑时必须照旧告知预算用完, 否则就是拿新行为冒充旧行为');
  assert.ok(!stages.includes('sub_budget_resume'), '没开续跑就不该有续窗');
});

// S3 不设工具预算 -> 永远不会被预算腰斩
test('S3 不设工具预算 = 永远不会被预算腰斩 (2026-10-14)', async () => {
  const seen = [];
  const stages = [];
  await withEnv({ PANGU_SUBAGENT_AUTO_RESUME_MAX: 0 }, async () => {
    const r = await runAgentLoop({
      ...BASE,
      roleCfg: RC(0),
      callLLMFn: makeLLM(workingPlan(12), seen),
      onProgress: (e) => stages.push(e.stage),
    });
    assert.equal(r.toolsUsed.length, 12, `12 轮都该跑完, 实际 ${r.toolsUsed.length}`);
  });
  assert.ok(!seen.some((t) => t.includes(BUDGET_MSG)), '没设预算就不该出现预算耗尽提示');
  assert.ok(!stages.includes('sub_budget_resume'), '没预算就没得续');
});

// S4 绝对天花板兜底: 续窗再多次也必须收场
test('S4 绝对天花板兜底, 续窗再多次也必须收场 (2026-10-14)', async () => {
  let rounds = 0;
  const fake = async () => {
    rounds += 1;
    return { text: toolCall('probe_missing', { i: rounds }) };
  };
  await withEnv({
    PANGU_SUBAGENT_AUTO_RESUME_MAX: 999,
    PANGU_SUBAGENT_HARD_MAX_ROUNDS: 8,
  }, async () => {
    const r = await runAgentLoop({ ...BASE, roleCfg: RC(2), callLLMFn: fake });
    assert.ok(r.summary.length > 0, '到天花板后仍要给出一段总结');
  });
  assert.ok(rounds <= 12, `绝对天花板必须兜住, 实际空转了 ${rounds} 轮`);
});

// S5 续窗判据只看真实工具调用 + _budgetOut 必须可改写
test('S5 续窗判据只看真实工具调用, 且预算墙必须可改写 (2026-10-14)', () => {
  const src = fs.readFileSync(require.resolve('../agents/sub-agent.js'), 'utf8');
  assert.match(src,
    /toolHistory\.filter\(t => t && !String\(t\.name \|\| ''\)\.startsWith\('_'\)\)\.length/,
    '续窗必须复用真实工具调用判据 (排除 _ 前缀内部记账工具), 否则假进展能骗到无限预算');
  assert.match(src, /let _budgetOut =/,
    '_budgetOut 必须可被续窗改写 (let) -- const 就退回成硬墙, 这正是长任务撞死的那道墙');
});
