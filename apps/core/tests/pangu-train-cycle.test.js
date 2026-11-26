'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { score, run } = require('../scripts/pangu_train_cycle');

test('training score counts only eligible samples and feedback', () => {
  const samples = [
    { eligible_for_positive_training: true },
    { eligible_for_positive_training: false },
  ];
  const result = score(samples, [{ label: 'positive' }, { label: 'negative' }]);
  assert.equal(result.eligible, 1);
  assert.equal(result.base_rate, 0.5);
  assert.equal(result.feedback_rate, 0.5);
});

test('training cycle refuses to accept too-small corpus', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-train-'));
  process.env.PANGU_HOME = home;
  const source = path.join(home, 'evolution');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, '2026-09-09.jsonl'), JSON.stringify({ success: true, tool_calls_total: 1, final_text: 'ok', input: 'x' }) + '\n');
  const result = run(['--source', source, '--output', path.join(home, 'state', 'training', 'corpus.jsonl')]);
  assert.equal(result.candidate.accepted, false);
  assert.equal(result.candidate.reason, 'need_at_least_5_samples');
  delete process.env.PANGU_HOME;
});
