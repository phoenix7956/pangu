'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scoreRecord, main } = require('../scripts/agent_lightning_rollouts');

const good = scoreRecord({ success: true, tool_calls_total: 2, final_text: '已修改并完成构建验证。' });
assert.strictEqual(good.eligible, true);
assert.ok(good.reward > 0);

const bad = scoreRecord({ success: true, tool_calls_total: 0, final_text: '工具锁了，不调任何工具。下一步等你拍。' });
assert.strictEqual(bad.eligible, false);
assert.strictEqual(bad.labels.fake_tool_lock, true);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-agl-'));
const source = path.join(root, 'evolution.jsonl');
const output = path.join(root, 'out', 'rollouts.jsonl');
fs.writeFileSync(source, [
  JSON.stringify({ ts: '2026-09-09T00:00:00Z', input: '修复聊天', final_text: '已修改并构建通过。', success: true, tool_calls_total: 1, tool_names: ['file_edit'] }),
  JSON.stringify({ ts: '2026-09-09T00:01:00Z', input: '继续', final_text: '我没有拿到与原问题对齐的答案。', success: false, tool_calls_total: 0 }),
].join('\n') + '\n');
const result = main(['--source', source, '--output', output]);
assert.strictEqual(result.stats.total, 2);
assert.strictEqual(result.stats.positive, 1);
assert.strictEqual(fs.readFileSync(output, 'utf8').trim().split('\n').length, 2);
console.log('agent lightning rollout tests: ok');
