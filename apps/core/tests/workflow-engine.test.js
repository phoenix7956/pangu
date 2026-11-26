'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-workflow-test-'));
process.env.PANGU_HOME = path.join(root, 'home');
process.env.PANGU_TASK_QUEUE_DB = path.join(root, 'state', 'queue', 'task_queue.db');

const workflow = require('../modules/workflow_engine');
const queue = require('../modules/task_queue');
const { TOOLS } = require('../modules/tools');

async function drain(limit = 12) {
  for (let i = 0; i < limit; i++) await workflow.runOne();
}

(async () => {
  const created = workflow.createWorkflow({
    session_id: 'workflow_test',
    title: 'dependency and review test',
    steps: [
      { id: 'time', title: 'read time', tool_name: 'current_time', params: { timezone: 'UTC' } },
      { id: 'review', title: 'human review', kind: 'review', depends_on: ['time'] },
      { id: 'time_again', title: 'read time again', tool_name: 'current_time', depends_on: ['review'] }
    ]
  });
  assert.strictEqual(created.ok, true);
  const id = created.workflow.id;

  await drain(2);
  let current = workflow.getWorkflow(id);
  assert.strictEqual(current.status, 'waiting_review');
  assert.strictEqual(current.steps[0].status, 'completed');
  assert.strictEqual(current.steps[1].status, 'waiting_review');
  assert.ok(current.steps[0].result.data.utc);

  assert.strictEqual(workflow.approveReview(id, true, 'approved').ok, true);
  await drain(3);
  current = workflow.getWorkflow(id);
  assert.strictEqual(current.status, 'completed');
  assert.strictEqual(current.steps[2].status, 'completed');
  assert.strictEqual(current.result.workflow_id, id);
  assert.strictEqual(current.result.steps.length, 3);
  const legacyPoll = await TOOLS.task_output({ params: { task_id: id } });
  assert.strictEqual(legacyPoll.ok, true);
  assert.strictEqual(legacyPoll.data.is_final, true);
  assert.strictEqual(legacyPoll.data.result.workflow_id, id);
  assert.ok(workflow.listEvents(id).some(event => event.type === 'review_approved'));

  const bad = workflow.createWorkflow({
    title: 'invalid dependency',
    steps: [{ id: 'first', tool_name: 'current_time', depends_on: ['missing'] }]
  });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /dependency/);

  const restart = workflow.createWorkflow({
    title: 'recover running state',
    steps: [{ id: 'one', tool_name: 'current_time' }]
  });
  const d = queue.getDb();
  d.prepare("UPDATE workflows SET status='running' WHERE id=?").run(restart.workflow.id);
  d.prepare("UPDATE workflow_steps SET status='running' WHERE workflow_id=?").run(restart.workflow.id);
  assert.strictEqual(workflow.recoverInterrupted().recovered, 1);
  current = workflow.getWorkflow(restart.workflow.id);
  assert.strictEqual(current.status, 'queued');
  assert.strictEqual(current.steps[0].status, 'pending');

  console.log('workflow-engine tests: ok');
})().finally(() => fs.rmSync(root, { recursive: true, force: true }));
