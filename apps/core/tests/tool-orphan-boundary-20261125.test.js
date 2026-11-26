'use strict';

// 2026-11-25: 发请求边界 (llm_caller) 必须剥掉孤儿 tool 消息 —— 上游 400
//   "tool result's tool id not found" 的最后防线。
//
// 现场 (2026-11-25, 老板持仓查询会话, MiniMax-M3.1-Flash):
//   主 agent 的某轮 assistant.tool_calls (call_ca3e30ff...) 被上下文截断/压缩切掉,
//   它对应的 role:'tool' 结果还留在历史里 ⇒ 发给上游时:
//   HTTP 400: invalid params, tool result's tool id(call_ca3e30ff...) not found
//   整轮作废, 且坏 JSON 被兜底直接漏给老板看 (SSE 里那坨 `[\<command>...]` 乱码)。
//
// 病灶: llm_caller 发请求前只过了 enforceToolResultAdjacency (挪位「结果没紧跟」),
//   孤儿形状 (父没了、结果还在) 它**原位保留** ⇒ 400。
// 修法: 边界上 enforce 之后再加 sanitizeToolPairing (孤儿结果 / 无结果 tool_calls 成对剥)。

const test = require('node:test');
const assert = require('node:assert');
const { sanitizeToolPairing, enforceToolResultAdjacency } = require('../modules/tool_pairing');

// ① 孤儿 tool result (父 assistant 被切掉) ⇒ 必须剥
test('孤儿 tool result 在发请求边界被剥 (400 现场复现)', () => {
  const msgs = [
    { role: 'user', content: '查股票' },
    { role: 'tool', tool_call_id: 'call_ca3e30ff_orphan', content: '{...结果...}' },
    { role: 'user', content: '再查一次' },
  ];
  const adj = enforceToolResultAdjacency(msgs);
  assert.equal(adj.moved, 0, '孤儿不挪位 (enforce 的既有行为)');
  assert.equal(adj.messages.length, 3, 'enforce 之后孤儿还在原位 ⇒ 400 照样发出去');

  const clean = sanitizeToolPairing(adj.messages);
  assert.equal(clean.messages.length, 2, 'sanitize 把孤儿剥了');
  assert.equal(clean.stats.droppedTool, 1);
  assert.ok(!clean.messages.some((m) => m.role === 'tool'), '历史里不该再有 tool 消息');
});

// ② 反向孤儿: assistant 带 tool_calls 但结果全没了 ⇒ 剥 tool_calls (有文字) / 整条 (无文字)
test('无结果的 assistant tool_calls 成对剥', () => {
  const clean = sanitizeToolPairing([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_x', function: { name: 't', arguments: '{}' } }] },
    { role: 'user', content: 'next' },
  ]);
  assert.equal(clean.messages.length, 2, '无文字无结果的 assistant 整条剥');

  const clean2 = sanitizeToolPairing([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '我先想了一下', tool_calls: [{ id: 'call_y', function: { name: 't', arguments: '{}' } }] },
    { role: 'user', content: 'next' },
  ]);
  const m = clean2.messages.find((x) => x.role === 'assistant');
  assert.ok(m, '有文字的 assistant 保留');
  assert.equal(m.tool_calls, undefined, '但 tool_calls 被剥掉 (留着也 400)');
});

// ③ 正常配对不误伤
test('配对完整的 tool 序列原样保留', () => {
  const clean = sanitizeToolPairing([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_ok', function: { name: 't', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_ok', content: 'result' },
  ]);
  assert.equal(clean.messages.length, 3);
  assert.deepEqual(clean.stats, { droppedTool: 0, stripped: 0, droppedAssistant: 0 });
});

// ④ 接线: llm_caller 发请求前必须真的过这道 sanitize (防止以后有人把边界清洗删了)
test('接线: llm_caller.js 发请求边界调用了 sanitizeToolPairing', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'llm_caller.js'), 'utf8');
  assert.ok(src.includes("_sanitizeToolPairing(_adj.messages)"),
    'llm_caller 发请求前必须对 enforce 后的序列跑 sanitize (孤儿防线)');
  assert.ok(src.includes('_clean.messages.map'),
    'sanitize 返回 {messages,stats} 对象, 必须取 .messages 再 map (直接 .map 会崩)');
});
