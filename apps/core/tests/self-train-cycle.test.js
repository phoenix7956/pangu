'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { metrics, splitSamples, evaluate, promote } = require('../scripts/self_train_cycle');
function sample(task, reward, labels) { return { task, reward, eligible_for_positive_training: labels.eligible, labels: { succeeded: labels.success, has_tools: labels.tools, alignment_blocked: labels.alignment, fake_tool_lock: labels.lock, plan_only: labels.plan } }; }
test('self-training split is deterministic and metrics expose safety rates', () => {
  const samples = [sample('a', 1, { eligible: true, success: true, tools: true, alignment: false, lock: false, plan: false }), sample('b', -1, { eligible: false, success: false, tools: false, alignment: true, lock: false, plan: true })];
  assert.deepEqual(splitSamples(samples), splitSamples(samples)); assert.equal(metrics(samples).alignment_block_rate, 0.5);
});
test('evaluation rejects safety regression and approval requires exact token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-self-train-')); const baseline = path.join(dir, 'base.json'); const candidate = path.join(dir, 'candidate.json'); const output = path.join(dir, 'eval.json');
  const good = Array.from({ length: 20 }, (_, i) => sample(String(i), 1, { eligible: true, success: true, tools: true, alignment: false, lock: false, plan: false }));
  const bad = Array.from({ length: 20 }, (_, i) => sample(String(i), 2, { eligible: true, success: true, tools: true, alignment: i === 0, lock: false, plan: false }));
  fs.writeFileSync(baseline, JSON.stringify({ metrics: { evaluation: metrics(good) }, evaluation: good })); fs.writeFileSync(candidate, JSON.stringify({ metrics: { evaluation: metrics(bad) }, evaluation: bad }));
  assert.equal(evaluate({ baseline, candidate, output, minEval: 20 }).status, 'rejected');
  const evalFile = path.join(dir, 'good-eval.json'); fs.writeFileSync(evalFile, JSON.stringify({ status: 'promotable' })); const approval = path.join(dir, 'approval.txt'); fs.writeFileSync(approval, 'APPROVE PANGU SELF-TRAIN v1');
  const promoted = promote({ evaluation: evalFile, approval, output });
  assert.equal(promoted.status, 'approved_for_local_policy');
  assert.equal(promoted.deployment.model_weights_changed, false);
});
