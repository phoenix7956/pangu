'use strict';
// 2026-10-13 子 agent 的角色工具白名单算了、打日志了, 但**一个工具都没发给上游**
//
// 线上现场 (resume-live-1791876482, 子 agent 诚实回答「当前会话没有可调用的工具」):
//   [sub-agent] analyzer → minimax_m3.1-flash-preview (tier=large, temp=0)
//   [sub-agent-tools] minimax_m3.1-flash-preview role whitelist=18 [read_file, file_grep, search_files, ...]
//   [agent-llm] model: minimax_m3.1-flash-preview ... tools: 0 msgs: 10
//
// 白名单 18 个, 实际发上去 **0 个**。子 agent 于是只能靠 buildToolPrompt 把工具说明
// 塞进提示词, 让模型手写 <tool> 标记 —— 而 MiniMax 这类模型 j2-detect 已探到
// probeOk=true (原生支持 tool_calls), 让它手写标记既慢又不可靠。
// 结果就是 analyzer 之类需要动手的活直接回「我没有工具」。
//
// 修法: 按白名单把 TOOLS_SCHEMA 翻译成原生 tools 挂进请求, 并解析响应里的原生
// tool_calls 喂进既有执行循环。模型不吐原生调用时**原样走旧的文本协议**, 零回归。
//
// 本测试刻意起一个真的本地端点看**发出去的 body** —— 原 bug 是「只打日志不发」,
// 正则守卫守不住这种 (日志行一直在), 必须看线上字节。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');

const sa = require('../agents/sub-agent');

function serveOnce(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const cfg = (port) => ({
  id: 'test-model', name: 'test-model', provider: 'openai-compatible',
  endpoint: 'http://127.0.0.1:' + port + '/v1', api_key: 'sk-test',
});

test('真发出去的 body 必须带 tools —— 原 bug 是白名单只打日志, body 里 tools 都没有', async (t) => {
  let got = null;
  const { srv, port } = await serveOnce((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      got = JSON.parse(b);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '好' } }] }));
    });
  });
  t.after(() => srv.close());

  await sa.callLLM([{ role: 'user', content: '读一下 /tmp/x' }], cfg(port), ['read_file', 'exec_command']);

  assert.ok(Array.isArray(got.tools), '请求体里必须有 tools 字段 (原来压根没有)');
  const names = got.tools.map(x => x.function.name).sort();
  assert.deepEqual(names, ['exec_command', 'read_file'], '只发白名单里的工具, 不多发');
  assert.equal(got.tool_choice, 'auto');
  assert.ok(got.tools[0].function.parameters, '每个工具必须带 parameters, 否则模型没法填参数');
});

test('白名单为空数组 = 明确不给工具 (总结轮只读轮就是这么调的)', async (t) => {
  let got = null;
  const { srv, port } = await serveOnce((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      got = JSON.parse(b);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '总结' } }] }));
    });
  });
  t.after(() => srv.close());

  await sa.callLLM([{ role: 'user', content: '总结一下' }], cfg(port), []);

  const n = (got.tools || []).length;
  assert.equal(n, 0, '空数组必须发 0 个工具 —— 写成 allowedTools.length 会把 [] 判成「全部」, 只读总结轮突然又能调工具');
});

test('响应里的原生 tool_calls 必须被解析出来 (原来 message.tool_calls 被直接丢掉)', async (t) => {
  const { srv, port } = await serveOnce((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: {
          content: null,
          tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"/tmp/x"}' } },
            { id: 'call_b', type: 'function', function: { name: 'exec_command', arguments: '坏 JSON' } },
          ],
        }}],
      }));
    });
  });
  t.after(() => srv.close());

  const r = await sa.callLLM([{ role: 'user', content: '干活' }], cfg(port), ['read_file', 'exec_command']);

  assert.equal(r.nativeCalls.length, 2, '两条原生调用都必须拿到');
  assert.deepEqual(r.nativeCalls[0], { name: 'read_file', args: { path: '/tmp/x' }, id: 'call_a' });
  assert.deepEqual(r.nativeCalls[1].args, {}, '参数坏掉时必须退成空对象, 不能让整个子 agent 崩掉');
});

test('Anthropic 形态: tools 用 input_schema, 响应认 tool_use', () => {
  const calls = sa._nativeCallsFrom({ content: [
    { type: 'text', text: '我读一下' },
    { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: '/tmp/y' } },
  ]}, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
  assert.deepEqual(calls[0].args, { path: '/tmp/y' });
  assert.equal(calls[0].id, 'tu_1');
});

test('配对不变量: assistant.tool_calls 的每个 id 都必须能在 role:tool 消息里找到', () => {
  const calls = [{ name: 'read_file', args: { path: '/a' }, id: 'call_1' },
                 { name: 'exec_command', args: {}, id: null }];
  const am = sa._assistantMessage('我去读', calls, true);
  assert.equal(am.role, 'assistant');
  assert.equal(am.tool_calls.length, 2);
  assert.ok(am.tool_calls[0].id && am.tool_calls[1].id, '没有上游 id 的调用必须自己补一个, 否则 tool 结果配不上 → 上游 400');
  // runAgentLoop 回灌时用同一个表达式生成 tool_call_id, 两者必须能对上
  const toolMsgId = (tc, i) => tc.id || ('call_' + tc.name + '_' + i);
  const ids = new Set(am.tool_calls.map(t => t.id));
  assert.ok(ids.has(toolMsgId(calls[0], 0)) && ids.has(toolMsgId(calls[1], 1)),
    '回灌用的 id 生成规则必须与 assistant.tool_calls 一致');
});

test('文本协议保持原样: 没吐原生调用时 assistant 消息不得带 tool_calls', () => {
  const am = sa._assistantMessage('我用 <tool>read_file</tool>', [{ name: 'read_file', args: {} }], false);
  assert.equal(am.tool_calls, undefined, '文本协议下带 tool_calls 会让上游期待 tool 结果, 反而 400');
  assert.equal(am.content, '我用 <tool>read_file</tool>');
});

// 端到端: 假上游第一轮回原生 tool_calls, 第二轮回纯文本。
// 看**第二次请求的消息** —— assistant.tool_calls 与 role:'tool' 必须配得上对,
// 否则上游 400 "tool result's tool id not found", 子 agent 直接废掉。
test('端到端: 原生调用必须被真执行, 且结果按 tool_call_id 配对回灌', async (t) => {
  const os = require('os');
  const tmpFile = path.join(os.tmpdir(), 'pangu-native-tools-probe.txt');
  fs.writeFileSync(tmpFile, '原生工具真的读到了\n');
  t.after(() => { try { fs.unlinkSync(tmpFile); } catch (_) {} });

  const bodies = [];
  const { srv, port } = await serveOnce((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      bodies.push(JSON.parse(b));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (bodies.length === 1) {
        res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
          { id: 'call_native_1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: tmpFile }) } },
        ] } }] }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: '读完了, 内容是「原生工具真的读到了」。' } }] }));
      }
    });
  });
  t.after(() => srv.close());

  const fakeRes = { write() {}, end() {}, headersSent: false };
  const out = await sa.runAgentLoop({
    taskText: '读一下 ' + tmpFile,
    mode: 'executor',
    model: cfg(port),
    cfg: {}, configPath: null,
    toolsAllowed: ['read_file'],
    res: fakeRes, sessionId: 'native-tools-probe',
    callLLMFn: (messages, model, allowed) => sa.callLLM(messages, model, allowed),
  });

  assert.equal(bodies.length, 2, '应该打了两轮上游 (第一轮调工具, 第二轮收尾)');
  assert.deepEqual(out.toolsUsed, ['read_file'], '原生调用必须被真执行 (原来 tool_calls 被丢掉, 一次都执行不了)');

  const msgs = bodies[1].messages;
  const asst = msgs.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
  assert.ok(asst, '第二次请求里必须有带 tool_calls 的 assistant 消息');
  const toolMsg = msgs.find(m => m.role === 'tool');
  assert.ok(toolMsg, '结果必须以 role:tool 回灌, 不能塞成 user 的 <tool_result> 文本');
  assert.equal(toolMsg.tool_call_id, asst.tool_calls[0].id,
    'tool_call_id 必须指回 assistant.tool_calls —— 对不上上游直接 400, 子 agent 整个废掉');
  assert.match(String(toolMsg.content), /原生工具真的读到了/,
    '工具真结果必须回到上下文里, 模型才知道自己读到了什么');
});

test('接线守卫: 执行循环必须合并原生调用, 且结果走 role:tool 而不是 <tool_result> 文本', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');   // 剥注释, 别被注释里的字样骗过
  assert.match(src, /_useNative \? _nativeCalls : extractToolCalls\(/,
    '执行循环必须原生优先、文本兜底 —— 只解析文本等于白接线');
  assert.match(src, /role: 'tool',\s*\n\s*tool_call_id:/,
    '原生协议下结果必须走 role:tool + tool_call_id, 否则和 assistant.tool_calls 配不上对');
  assert.match(src, /_assistantMessage\(text, toolCalls, _useNative\)/,
    'assistant 消息必须按协议给不同形状');
});

// 2026-10-13 第二轮现场 (接着孤儿 tool result 那条查出来的):
//   ① 模型只吐 tool_calls 时 content 是空的 —— llm_caller 的 R26b 实测 minimax 对
//      "空 content + tool_calls" 报 400 'tool call and result not match (2013)'。
//      子 agent 接上原生工具后第一轮必然是这个形状。
//   ② Anthropic 分支把 messages 压成 {role, content}, 带不走 tool_calls —— 那里发 tools
//      等于宣告支持原生工具却发不出合法形状, 所以必须不发。
test('assistant 空 content + tool_calls 必须补占位 —— 否则 MiniMax 400', async (t) => {
  let got = null;
  const { srv, port } = await serveOnce((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      got = JSON.parse(b);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '好的' } }] }));
    });
  });
  t.after(() => srv.close());

  await sa.callLLM([
    { role: 'system', content: 's' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'assistant', content: '', tool_calls: [] },   // 空数组: 多数上游也拒
  ], cfg(port), ['read_file']);

  const asst = got.messages.filter(m => m.role === 'assistant');
  assert.match(asst[0].content, /\(调用工具: read_file\)/,
    '只吐 tool_calls 的那一轮 content 为空 → MiniMax 直接 400, 子 agent 第一轮就死');
  assert.equal(asst[1].tool_calls, undefined, '空 tool_calls 数组要抹掉 (llm_caller 同款)');
  const tmsg = got.messages.find(m => m.role === 'tool');
  assert.equal(tmsg.tool_call_id, 'c1', 'tool_call_id 必须原样透传, 丢了就是 400');
});

test('Anthropic 路径不许发原生工具 —— 那条路带不走 tool_calls, 发了必 400', async (t) => {
  let got = null;
  const { srv, port } = await serveOnce((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      got = JSON.parse(b);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }));
    });
  });
  t.after(() => srv.close());

  await sa.callLLM([{ role: 'user', content: 'u' }],
    { ...cfg(port), protocol: 'anthropic' }, ['read_file']);

  assert.equal(got.tools, undefined,
    'Anthropic 分支把 messages 压成 {role, content}, 带不走 tool_calls —— 发 tools 等于说谎');
});

test('配对清洗: 孤儿 tool result 与「有调用没结果」的 assistant 都得清掉', () => {
  const out = sa._sanitizePairs([
    { role: 'user', content: 'u' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'zzz', content: '孤儿结果' },
    { role: 'tool', tool_call_id: 'a1', content: '真结果' },
    { role: 'assistant', content: '总结完了', tool_calls: [{ id: 'b1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
  ]);
  const ids = out.filter(m => m.role === 'tool').map(m => m.tool_call_id);
  assert.deepEqual(ids, ['a1'], '父 assistant 没了的 tool result 必须丢 (上游 400 真凶)');
  const last = out[out.length - 1];
  assert.equal(last.tool_calls, undefined, '没有结果的 tool_calls 要剥掉 (反向 400)');
  assert.equal(last.content, '总结完了', '有文字的 assistant 保留文字, 别整条丢');
});
