const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// ===========================================================================
// 非流式响应解析器被 SSE 响应体硬失败 (现场 /tmp/pangu-single.err, 8 次):
//   [j2-native] LLM call failed: 解析响应失败: Unexpected token 'd', "data: {"ty"...
//   [j2-native] fallback to legacy J2 XML path
//   [j2] SILENT_FAILURE: 我跑了 2 轮没调 task_done ... 已做工具: 0 (无)
//
// 后果链 (ar2-0009 实测): 子 agent sub-0 撞上它 → 整轮 0 工具 → planner 第一轮全废
//   → checker 判 FAIL → 触发 2 轮补救重做 → 长任务第一步就夭折, 白烧轮次预算。
//
// 诚实说明: 我**没能复现**这 8 次 (连续 2 次现场复现均未触发)。已排除的假设:
//   端点主动对 stream:false 返回 SSE —— minimax / kimi / agnes 三个端点实测全部返回标准 JSON;
//   模型配置强制流式 —— nodes 配置里没有任何 stream 字段, _buildOpenAIPayload 也只在
//   stream 参数为 true 时才设 payload.stream。
// 剩余最可能: Node 19+ globalAgent 默认 keepAlive, 上游连接复用时把上一条 SSE 响应
//   的残留字节串进了下一个响应 —— 间歇性, 与"复现不出来"一致。
//
// 所以本次不宣称找到根因, 只做防御: 让非流式解析器能吃下 SSE 响应体。
//   正常 JSON 路径行为完全不变; SSE 路径从"整轮失败"变成"成功解析"。
// ===========================================================================
const SRC = fs.readFileSync(require.resolve('../modules/llm_caller.js'), 'utf8');

test('_handlePlainResponse 必须对 SSE 响应体容错, 而不是硬失败', () => {
  assert.match(SRC, /function _handlePlainResponse[\s\S]{0,2600}?SSE|sse/i,
    '非流式解析器必须识别并处理 SSE 响应体');
});

test('必须提供可单测的 SSE→JSON 归并函数', () => {
  const m = SRC.match(/function\s+(_?\w*SSE\w*|_?parse\w*SSE\w*|_?merge\w*SSE\w*)\s*\(/);
  assert.ok(m, '应能找到 SSE 解析/归并函数');
  // 从 SSE chunk 里应能拼出完整 message
  assert.match(SRC, /delta[\s\S]{0,300}?content/,
    'SSE 归并必须处理 delta.content');
  assert.match(SRC, /tool_calls[\s\S]{0,400}?function/,
    'SSE 归并必须处理 delta.tool_calls 增量');
});

test('SSE 归并不得把 [DONE] 当成数据', () => {
  assert.match(SRC, /\[DONE\]/,
    '必须识别 SSE 结束标记 [DONE], 不能当 JSON 解析');
});

test('正常 JSON 响应路径不受影响 (容错只做兜底, 不改主路径)', () => {
  // 主路径仍应是直接 JSON.parse(data)
  const m = SRC.match(/function _handlePlainResponse[\s\S]{0,1200}/);
  assert.ok(m);
  assert.match(m[0], /JSON\.parse\(data\)/,
    '主路径必须仍是 JSON.parse(data)');
  assert.match(m[0], /catch[\s\S]{0,600}?SSE|_parseSSE|_mergeSSE/i,
    '解析失败时才走 SSE 兜底');
});

// 纯函数级: 验证归并语义
test('SSE chunk 归并出完整 message (纯函数级)', () => {
  const lines = [
    'data: {"choices":[{"delta":{"role":"assistant"}}]}',
    'data: {"choices":[{"delta":{"content":"你"}}]}',
    'data: {"choices":[{"delta":{"content":"好"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"exec_","arguments":"{\\"a\\""}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"command","arguments":":1}"}}]}}]}',
    'data: [DONE]',
  ].join('\n\n');
  let content = ''; const tc = new Map();
  for (const raw of lines.split('\n\n')) {
    if (!raw.startsWith('data: ')) continue;
    const p = raw.slice(6).trim();
    if (p === '[DONE]') break;
    let j; try { j = JSON.parse(p); } catch (_) { continue; }
    const d = j.choices && j.choices[0] && j.choices[0].delta;
    if (!d) continue;
    if (d.content) content += d.content;
    for (const t of (d.tool_calls || [])) {
      const a = tc.get(t.index) || { id: undefined, function: { name: '', arguments: '' } };
      if (t.id) a.id = t.id;
      if (t.function) {
        if (t.function.name) a.function.name += t.function.name;
        if (t.function.arguments) a.function.arguments += t.function.arguments;
      }
      tc.set(t.index, a);
    }
  }
  assert.equal(content, '你好', '文本增量应拼成完整内容');
  assert.equal(tc.get(0).function.name, 'exec_command', '工具名增量应拼完整');
  assert.equal(tc.get(0).function.arguments, '{"a":1}', '参数增量应拼完整');
});

// ===========================================================================
// 2026-10-13 二次现场: 上面那个防御本身有个更糟的问题 —— 它把响亮的失败
// 换成了静默的空答案。
//
// /tmp/pangu-single.err 里 3f6fafb 落地之后新增的 5 行:
//   [llm-sse-fallback] 非流式路径收到 SSE 响应体, 已就地归并 (content=0字, tools=0)
//   ... 共 5 次, 每次都是 0 字 0 工具。
//
// 修之前: JSON.parse 抛错 → 整轮失败 → `fallback to legacy J2 XML path` → 有恢复路径。
// 修之后: 归并"成功"返回一个空 message → 调用方拿到空内容 → 不再降级 → 白烧一轮轮次预算。
//
// 也就是说, 这个防御把"响亮失败 + 有恢复"换成了"静默空转 + 无恢复"。
//
// 空归并必须退回 null (交回原错误路径), 而不是伪装成一个合法响应。
// ===========================================================================
const LC = require('../modules/llm_caller');

test('SSE 体归并不出任何内容和工具时必须返回 null, 不能伪装成空答案', () => {
  // 现场真实形状: body 以 "data: {"ty..." 开头, 但里面没有 OpenAI 风格的
  // choices/delta —— 归并得到 0 字 0 工具。
  const body = [
    'data: {"type":"ping"}',
    'data: {"type":"heartbeat","ts":1}',
    'data: [DONE]',
  ].join('\n\n');
  assert.equal(LC._parseSSEBody(body), null,
    '归不出内容/工具就不该返回对象 — 否则调用方拿到空 message, 白烧一轮');
});

test('只有正文没有 finish_reason 的正常流仍要能归并出来 (别修过头)', () => {
  const body = [
    'data: {"choices":[{"delta":{"role":"assistant"}}]}',
    'data: {"choices":[{"delta":{"content":"好"}}]}',
    'data: [DONE]',
  ].join('\n\n');
  const r = LC._parseSSEBody(body);
  assert.ok(r, '正常 SSE 流必须照常归并');
  assert.equal(r.choices[0].message.content, '好');
});

test('只有工具调用没有正文的流也要能归并 (空正文但有工具 ≠ 空)', () => {
  const body = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"p\\":\\"/a\\"}"}}]}}]}',
    'data: [DONE]',
  ].join('\n\n');
  const r = LC._parseSSEBody(body);
  assert.ok(r, '有工具调用的流必须照常归并');
  assert.equal(r.choices[0].message.tool_calls[0].function.name, 'read_file');
});

test('非 SSE 体一律返回 null (交回原 JSON 错误路径)', () => {
  assert.equal(LC._parseSSEBody('<html>502 Bad Gateway</html>'), null);
  assert.equal(LC._parseSSEBody(''), null);
});

test('一个 data 行都没有的 SSE 壳也必须返回 null (与 sawChunk 分支的覆盖关系钉住)', () => {
  // 只有 event: 行 / 空 data 行 —— sawChunk 为假。
  // 注意: 这条与"变异3(sawChunk 为假也返回空对象)"无关, 因为空归并守卫已经先一步
  // 把它盖住了(content 必空、toolCalls 必空)。这里钉的是这个覆盖关系本身。
  assert.equal(LC._parseSSEBody('event: ping\n\ndata: \n\n'), null);
  assert.equal(LC._parseSSEBody('event: message_start\n\ndata: {"broken":\n\n'), null);
});
