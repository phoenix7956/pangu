'use strict';

const assert = require('assert');
const path = require('path');
const { test } = require('node:test');

// Set GOAP path to mock before require
const MOCK_PATH = path.join(__dirname, 'fixtures', 'mock_goap.js');
process.env.PANGU_GOAP_PATH = MOCK_PATH;

const J2 = require('../modules/j2_agent_loop');

test('R44 j2 接入: _injectGoapPlan 调用真 GOAP plan 注入 system msg', async () => {
  // 2026-08-23 修: 老板 2026-08-02 拍板 GOAP 默认关 (PANGU_GOAP_ENABLED=1 才开),
  // 旧测试没设 env 导致永远 skip — 测试跟上拍板行为, 显式打开
  process.env.PANGU_GOAP_ENABLED = '1';
  const messages = [{ role: 'system', content: 'init' }];
  await J2._injectGoapPlan(messages, '帮我修一下 R42 松绑, 1-2h 干完');
  delete process.env.PANGU_GOAP_ENABLED;
  // 末尾应该是 GOAP system msg
  const last = messages[messages.length - 1];
  assert.strictEqual(last.role, 'system');
  assert.ok(last.content.includes('🧭 GOAP Plan'), `should inject GOAP plan markdown, got: ${last.content.slice(0, 200)}`);
  assert.ok(last.content.includes('mock_step_1'), 'should include mock step 1');
  assert.ok(last.content.includes('参考这个自动规划'), 'should include guiding suffix');
});

test('R44 j2 接入: 输入太短 (< 5 char) skip GOAP', async () => {
  const messages = [{ role: 'system', content: 'init' }];
  await J2._injectGoapPlan(messages, 'hi');
  // 不应该加新 msg
  assert.strictEqual(messages.length, 1, 'short input should not trigger GOAP');
});

test('R44 j2 接入: PANGU_GOAP_ENABLED=0 强制 skip', async () => {
  process.env.PANGU_GOAP_ENABLED = '0';
  const messages = [{ role: 'system', content: 'init' }];
  await J2._injectGoapPlan(messages, '老板下一句指令测试');
  assert.strictEqual(messages.length, 1, 'env-disabled should skip GOAP');
  delete process.env.PANGU_GOAP_ENABLED;
});

test('R44 j2 接入: GOAP require 失败 skip (不阻塞)', async () => {
  const origPath = process.env.PANGU_GOAP_PATH;
  process.env.PANGU_GOAP_PATH = '/nonexistent/path/to/goap';
  // Clear require cache for j2_agent_loop's internal lazy require (still references original path)
  // But _injectGoapPlan reads env each call, so this should fail
  const messages = [{ role: 'system', content: 'init' }];
  await J2._injectGoapPlan(messages, '老板下一句指令测试');
  assert.strictEqual(messages.length, 1, 'GOAP require fail should skip');
  process.env.PANGU_GOAP_PATH = origPath;
});

test('R44 j2 接入: planToMarkdown 输出超 800 字 截断', async () => {
  // Make mock return long plan
  delete require.cache[MOCK_PATH];
  const longMock = path.join(__dirname, 'fixtures', 'mock_goap_long.js');
  require('fs').writeFileSync(longMock, `
    'use strict';
    async function formatGoal(t, c, o) { return { goal: t, success_criteria: ['x'], constraints: [], prerequisites: [], scope: 'short_term', estimated_effort: 'medium', risks: [] }; }
    function planAStar(s, g, o) { return { success: true, plan: Array.from({length: 50}, (_, i) => ({ action: 's'+i, description: 'step '.repeat(20), step: i+1, effects: ['e'+i], rollback: 'none', from_state: '{}', to_state: '{}' })), cost: 100, iterations: 50 }; }
    function planToMarkdown(p, g, o) { return '## 🧭 GOAP Plan (mock)\\ngoal: ' + g.goal + '\\n\\n' + 'x'.repeat(2000); }
    module.exports = { formatGoal, planAStar, planToMarkdown };
  `);
  const origPath = process.env.PANGU_GOAP_PATH;
  process.env.PANGU_GOAP_PATH = longMock;
  process.env.PANGU_GOAP_ENABLED = '1';  // 2026-08-23 修: GOAP 默认关 (老板拍板), 截断用例需显式打开
  // Bust cache
  delete require.cache[require.resolve('../modules/j2_agent_loop')];
  const J2Fresh = require('../modules/j2_agent_loop');
  const messages = [{ role: 'system', content: 'init' }];
  await J2Fresh._injectGoapPlan(messages, '老板下一句长指令');
  const last = messages[messages.length - 1];
  assert.ok(last.content.includes('_(truncated)_'), `long plan should be truncated, got len=${last.content.length}`);
  assert.ok(last.content.length < 1500, `truncated content should be < 1500 chars (not full 2000+), got ${last.content.length}`);
  process.env.PANGU_GOAP_PATH = origPath;
  delete process.env.PANGU_GOAP_ENABLED;
  require('fs').unlinkSync(longMock);
});
