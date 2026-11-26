'use strict';
const assert = require('assert');
const { shouldResumeTaskCheckpoint } = require('../modules/task_checkpoint');

const now = Date.now();
const active = { status: 'active', ts: now - 1000, goal: '旧任务' };

assert.strictEqual(shouldResumeTaskCheckpoint(active, '/goal 新任务', now), false,
  'a new request must not inherit an unrelated active checkpoint');
assert.strictEqual(shouldResumeTaskCheckpoint(active, '继续执行【续跑约束】', now), true,
  'an explicit continuation should resume a fresh active checkpoint');
assert.strictEqual(shouldResumeTaskCheckpoint({ ...active, status: 'done' }, '继续【续跑约束】', now), false,
  'completed checkpoints must not resume');
assert.strictEqual(shouldResumeTaskCheckpoint({ ...active, ts: now - 31 * 60 * 1000 }, '继续【续跑约束】', now), false,
  'stale checkpoints must not resume');

const schemaText = require('fs').readFileSync(require('path').join(__dirname, '..', 'modules', 'llm_caller.js'), 'utf8');
assert.ok(schemaText.includes("'task_done', 'goal_set', 'goal_progress', 'goal_complete'"),
  'goal tools must be visible to the main LLM tool whitelist');

console.log('task checkpoint resume tests OK');
