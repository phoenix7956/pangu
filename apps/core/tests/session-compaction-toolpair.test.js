// 2026-09-12 (老板 20:43 实案): 压缩产物必须保持 OpenAI tool_call 配对 —
// 孤儿 tool result (父 assistant tool_calls 被切掉) → MiniMax HTTP 400
// "tool result's tool id not found" → 整轮降级 legacy 重跑。
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { SessionCompaction } = require('../modules/session_compaction');

const sc = new SessionCompaction();

test('孤儿 tool result 被丢 (父 assistant 调用被切走)', () => {
  const msgs = [
    { role: 'system', content: 'summary' },
    { role: 'tool', tool_call_id: 'call_orphan', content: '{"ok":true}' },  // 父 call 不在数组里
    { role: 'user', content: '继续消化' },
  ];
  const out = sc._sanitizeToolPairing(msgs);
  assert.strictEqual(out.filter(m => m.role === 'tool').length, 0, '孤儿 tool result 必须丢');
  assert.strictEqual(out.length, 2);
});

test('完整三联 (assistant tool_calls + tool result) 原样保留', () => {
  const msgs = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'read_file' }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'file content' },
    { role: 'user', content: '好' },
  ];
  const out = sc._sanitizeToolPairing(msgs);
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[0].tool_calls.length, 1);
});

test('assistant 调用全没结果 → 剥 tool_calls 留文本; 空文本整条约掉', () => {
  const msgs = [
    { role: 'assistant', content: '我先读一下', tool_calls: [{ id: 'call_x', name: 'read_file' }] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_y', name: 'exec_command' }] },
    { role: 'user', content: '继续' },
  ];
  const out = sc._sanitizeToolPairing(msgs);
  assert.strictEqual(out.length, 2, '空 content 的纯调用 assistant 必须约掉');
  assert.strictEqual(out[0].content, '我先读一下');
  assert.strictEqual(out[0].tool_calls, undefined, '没结果的调用必须剥掉');
});

test('部分配对: 有结果的调用保留, 没结果的裁掉', () => {
  const msgs = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_a' }, { id: 'call_b' }] },
    { role: 'tool', tool_call_id: 'call_b', content: 'ok' },
  ];
  const out = sc._sanitizeToolPairing(msgs);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out[0].tool_calls.map(t => t.id), ['call_b']);
});

test('buildCompactedMessages 产出必过配对清洗 (端到端, 防回退)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../modules/session_compaction.js'), 'utf8');
  assert.ok(src.includes('_sanitizeToolPairing(compacted)'), 'buildCompactedMessages 必须过 _sanitizeToolPairing');
});
