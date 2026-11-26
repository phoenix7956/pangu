/**
 * tests/tool-result-adjacency-20261025.test.js
 * 第 85 批 —— 修「本地守门提示插进 tool_calls 和 tool result 中间」导致的上游 400。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 现场 (会话 probe84-fixed, 刀2 = 综合分析那把刀)
 *   ~/.pangu-data/sessions/probe84-fixed_sub-2-li.json 索引 26-30 逐条取证:
 *     26 assistant  tool_calls=[exec_command×2]
 *     27 system     [DUPLICATE-CALL-BLOCKED]   ← 盘古自己的守门提示
 *     28 system     [HARD] / [HARD-LOOP]       ← 盘古自己的守门提示
 *     29 tool       (exec_command 的结果)
 *     30 tool       (exec_command 的结果)
 *
 * 上游契约 (OpenAI / MiniMax 都一样): tool 结果必须**紧跟**发起它的那条 assistant。
 * 中间夹一条 system ⇒ 上游直接:
 *   HTTP 400 invalid params, tool call result does not follow tool call (2013)
 * ⇒ 那一刀的 summary 调用死了 ⇒ runtimeStatus=partial ⇒ 主人收到 partial,
 *   哪怕那一刀**已经把活干完了** (刀2 交卷 5671/11016 字的完整分析)。
 *
 * 这跟第 83-84 批修的那三个守卫是**同一个病**:
 *   盘古自己插进去的东西, 破坏了自己要遵守的契约。
 *
 * 本文件钉三件事:
 *   A. 纯函数 enforceToolResultAdjacency: 把夹在中间的消息挪到结果之后, 且**不丢不重**
 *   B. 边界兜底: llm_caller 的 _adaptOpenAIMessages 每次发请求前都过这一关
 *   C. 根修: j2_agent_loop 的守门提示**不再直接** push 进 messages
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CORE = path.join(__dirname, '..');
const { enforceToolResultAdjacency } = require(path.join(CORE, 'modules', 'tool_pairing'));
const { _adaptOpenAIMessages } = require(path.join(CORE, 'modules', 'llm_caller'));

// ═════════════════════════════════════════════════════════════════════════════
// A. 纯函数
// ═════════════════════════════════════════════════════════════════════════════

// 现场那 5 条消息 (逐字照抄会话文件里的形状)
function fieldShape() {
  return [
    { role: 'assistant', content: '', tool_calls: [
      { id: 'call_a', function: { name: 'exec_command', arguments: '{}' } },
      { id: 'call_b', function: { name: 'exec_command', arguments: '{}' } },
    ] },
    { role: 'system', content: '[DUPLICATE-CALL-BLOCKED] 你刚调的工具 exec_command 因为和前面完全同参同工具, 被本地守门直接拦下了' },
    { role: 'system', content: '[HARD-LOOP] exec_command 已被调用 3 次同参数. 强制熔断' },
    { role: 'tool', tool_call_id: 'call_a', content: '{"ok":true}' },
    { role: 'tool', tool_call_id: 'call_b', content: '{"ok":false}' },
  ];
}

test('A1 现场那个形态: tool 结果不再紧跟 assistant ⇒ 整形后必须紧跟', () => {
  const { messages, moved } = enforceToolResultAdjacency(fieldShape());
  assert.equal(moved, 2, '两条 system 提示应该被挪走');
  assert.equal(messages.length, 5, '整形不许丢消息也不许多消息');
  // tool 结果必须**紧跟** assistant —— 上游契约就在这一条上
  assert.equal(messages[1].role, 'tool');
  assert.equal(messages[1].tool_call_id, 'call_a');
  assert.equal(messages[2].role, 'tool');
  assert.equal(messages[2].tool_call_id, 'call_b');
  // 被挪走的两条 system 落到结果之后, 内容一字不改
  assert.equal(messages[3].role, 'system');
  assert.match(messages[3].content, /DUPLICATE-CALL-BLOCKED/);
  assert.equal(messages[4].role, 'system');
  assert.match(messages[4].content, /HARD-LOOP/);
});

test('A2 本来就配对好的序列不许被改动 (整形是兜底, 不是重排)', () => {
  const good = [
    { role: 'user', content: '干活' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'assistant', content: '干完了' },
  ];
  const { messages, moved } = enforceToolResultAdjacency(good);
  assert.equal(moved, 0, '配对好的序列被挪了 ⇒ 整形误伤');
  assert.deepEqual(messages, good, '配对好的序列内容/顺序变了');
});

test('A3 结果没凑齐时原位保留 (不许把语义搅乱)', () => {
  // assistant 发了两个调用, 只回来一个结果 —— 这段本来就残缺。
  // 挪它没有任何好处 (上游照样拒), 只可能把别的消息顺序搅乱 ⇒ 不挪。
  const partial = [
    { role: 'assistant', content: '', tool_calls: [
      { id: 'c1', function: { name: 'read_file', arguments: '{}' } },
      { id: 'c2', function: { name: 'read_file', arguments: '{}' } },
    ] },
    { role: 'system', content: '[HARD] read_file 已失败 2 次' },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'assistant', content: '收尾' },
  ];
  const { messages, moved } = enforceToolResultAdjacency(partial);
  assert.equal(moved, 0, '结果没凑齐还去挪 ⇒ 把残缺段搅乱了');
  assert.deepEqual(messages, partial);
});

test('A4 多段 assistant 各自配对, 互不串味', () => {
  const many = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'a1', function: { name: 'x', arguments: '{}' } }] },
    { role: 'system', content: '守门话 1' },
    { role: 'tool', tool_call_id: 'a1', content: 'r1' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'b1', function: { name: 'y', arguments: '{}' } }] },
    { role: 'system', content: '守门话 2' },
    { role: 'tool', tool_call_id: 'b1', content: 'r2' },
    { role: 'assistant', content: '收工' },
  ];
  const { messages, moved } = enforceToolResultAdjacency(many);
  assert.equal(moved, 2);
  assert.equal(messages.length, 7, '整形不许丢消息');
  // 第一段: assistant → 它的结果
  assert.equal(messages[1].tool_call_id, 'a1');
  // 第二段: 找 b1 那一段, 它的结果必须紧跟它的 assistant
  const bIdx = messages.findIndex(m => m.role === 'assistant' && m.tool_calls && m.tool_calls[0].id === 'b1');
  assert.equal(messages[bIdx + 1].role, 'tool');
  assert.equal(messages[bIdx + 1].tool_call_id, 'b1');
  // 两条守门话各自落在**自己那批**结果之后 (不是全堆到最末尾)
  const s1 = messages.findIndex(m => m.role === 'system' && /守门话 1/.test(m.content || ''));
  const s2 = messages.findIndex(m => m.role === 'system' && /守门话 2/.test(m.content || ''));
  assert.ok(s1 > 1 && messages[s1 - 1].role === 'tool', '守门话 1 必须在它那批结果之后');
  assert.ok(s2 > bIdx && messages[s2 - 1].role === 'tool', '守门话 2 必须在它那批结果之后');
  // 收尾那句话仍然在最后 (语义顺序没乱)
  assert.equal(messages[messages.length - 1].content, '收工');
});

// ═════════════════════════════════════════════════════════════════════════════
// B. 边界兜底 —— llm_caller 每次发请求前都过这一关
// ═════════════════════════════════════════════════════════════════════════════

test('B1 适配层必须把「夹在中间」的消息挪走 (不然请求发出去就是 400)', () => {
  const adapted = _adaptOpenAIMessages(fieldShape(), { id: 'test-model' });
  assert.equal(adapted.length, 5);
  assert.equal(adapted[1].role, 'tool', 'tool 结果没紧跟 assistant ⇒ 请求发出去必 400');
  assert.equal(adapted[1].tool_call_id, 'call_a');
  assert.equal(adapted[2].tool_call_id, 'call_b');
  assert.equal(adapted[3].role, 'system');
});

test('B2 适配层不许把 tool_calls / tool_call_id 弄丢 (那会撞另一种 400)', () => {
  const adapted = _adaptOpenAIMessages(fieldShape(), { id: 'test-model' });
  assert.ok(Array.isArray(adapted[0].tool_calls) && adapted[0].tool_calls.length === 2,
    'assistant 的 tool_calls 丢了 ⇒ 上游 400「tool id not found」');
  assert.equal(adapted[1].tool_call_id, 'call_a');
  assert.equal(adapted[2].tool_call_id, 'call_b');
});

// ═════════════════════════════════════════════════════════════════════════════
// C. 根修 —— j2_agent_loop 的守门提示不再直接 push 进 messages
// ═════════════════════════════════════════════════════════════════════════════

test('C1 native 路径里守门提示不许直接 push 进 messages (会插在 tool_calls 和结果中间)', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'j2_agent_loop.js'), 'utf8');
  // 只看 native 工具执行那一段 (从 _j2GuardMsgs 的声明到反幻觉钩子那一段)
  const start = src.indexOf('const _j2GuardMsgs = [];');
  assert.ok(start > 0, '找不到 _j2GuardMsgs 声明 —— 根修被拆了?');
  // 段的终点 = 守门提示的 flush 点。flush 之后的那条 (反幻觉钩子) 是**合法的** ——
  //   它落在 tool 结果回灌之后, 不会插进 assistant 和结果中间。
  const end = src.indexOf('for (const _gm of _j2GuardMsgs) {', start);
  assert.ok(end > start, '找不到 native 段的收尾');
  const seg = src.slice(start, end);
  // 这段里凡是往 messages 里塞 system 的, 都必须先经过 _j2GuardMsgs
  const direct = seg.match(/messages\.push\(\{\s*role: 'system'/g);
  assert.equal(direct, null,
    'native 段里还有直接 messages.push({role:\'system\'…}) ⇒ 守门提示又会插在 '
    + 'assistant(tool_calls) 和它的结果中间 ⇒ 上游 400');
});

test('C2 守门提示必须在 tool 结果回灌**之后**才 push (顺序钉死)', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'j2_agent_loop.js'), 'utf8');
  const flushIdx = src.indexOf('for (const _gm of _j2GuardMsgs) {');
  assert.ok(flushIdx > 0, '找不到守门提示的 flush 点');
  const resultIdx = src.indexOf("messages.push({ role: 'tool', tool_call_id: tc.id", flushIdx - 4000);
  assert.ok(resultIdx > 0 && resultIdx < flushIdx,
    'flush 点在 tool 结果回灌之前 ⇒ 守门提示还是插在中间 ⇒ 上游 400');
});

// ═════════════════════════════════════════════════════════════════════════════
// D. 现场语料 —— 从落盘会话里取, 不手抄
// ═════════════════════════════════════════════════════════════════════════════

test('D1 现场刀2 的那段消息 (索引 26-30) 整形后必须变成合法序列', () => {
  // 2026-10-28 (第 134 批): 夹具改读仓内 (原来读生产盘, 生产盘一清这条就静默跳过)。
  const f = path.join(process.env.PANGU_CORPUS_DIR || path.join(__dirname, 'fixtures', 'sessions'),
    'probe84-fixed_sub-2-li.json');
  if (!fs.existsSync(f)) {
    assert.ok(true, '现场会话不存在, 跳过 (A1 已用逐字同形复现覆盖)');
    return;
  }
  const msgs = (JSON.parse(fs.readFileSync(f, 'utf8')).messages || []);
  const seg = msgs.slice(26, 31);
  assert.equal(seg.length, 5, '现场取证样本形状变了');
  assert.equal(seg[0].role, 'assistant');
  assert.ok(Array.isArray(seg[0].tool_calls) && seg[0].tool_calls.length === 2);
  assert.equal(seg[1].role, 'system');
  assert.equal(seg[2].role, 'system');
  assert.equal(seg[3].role, 'tool');
  assert.equal(seg[4].role, 'tool');

  const { messages, moved } = enforceToolResultAdjacency(seg);
  assert.equal(moved, 2, '现场那两条 system 提示没被挪走');
  assert.equal(messages[1].role, 'tool', '整形后 tool 结果仍不紧跟 assistant');
  assert.equal(messages[1].tool_call_id, seg[0].tool_calls[0].id);
  assert.equal(messages[2].tool_call_id, seg[0].tool_calls[1].id);
});

