// 2026-10-16 子 agent 流式 + 活性上报
//
// 老板原话: "盘古调用模型, 没问题了, 但不是流式输出, 调用有没有用工具, 完全不知道,
// 跟死了一样"。
//
// 旧码是**非流式阻塞**: http.request 攒完整个响应才 resolve。代价两层:
//   ① 观感 — 模型思考/生成的几分钟里屏幕上只有 heartbeat, 分不清在干活还是卡死
//   ② 实害 — req.setTimeout 是空闲超时, 但不流式时中间没有任何数据回来,
//      本地 27B 思考 300 秒不吐字 → 必被墙砍 → "Planner failed: LLM timeout"
//
// 这些测试用**真的本地 SSE 服务端**测, 不用 mock: 这段代码的坑全在字节层
// (Content-Length / 半行 data: / chunk 边界), mock 出来的响应根本碰不到。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('fs');

const M = (p) => require(path.join(__dirname, '..', p));
const subAgent = M('agents/sub-agent.js');

function sseLine(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }
function delta(content, extra) {
  return sseLine(Object.assign({
    choices: [{ index: 0, delta: Object.assign({ content }, extra || {}) }],
  }));
}

/** 起一个按脚本回话的本地端点, 返回 { url, close, seen } */
async function startServer(handler) {
  const seen = { bodies: [], count: 0 };
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      seen.count += 1;
      try { seen.bodies.push(JSON.parse(b)); } catch (_) { seen.bodies.push(b); }
      handler(req, res, seen.count);
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + srv.address().port, close: () => new Promise(r => srv.close(r)), seen };
}

function localModel(url, extra) {
  return Object.assign({
    id: 'fake-stream', name: 'fake-stream', provider: 'lmstudio',
    endpoint: url, protocol: 'openai', context_length: 65536,
  }, extra || {});
}

// ===== 1. 请求形状: 必须真的开流式 =====

test('T1 OpenAI 路径必须带 stream:true + include_usage (否则拿不到真实 usage)', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(delta('你好'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    await subAgent.callLLM([{ role: 'user', content: '嗨' }], localModel(s.url), []);
  } finally { await s.close(); }
  assert.strictEqual(s.seen.count, 1);
  assert.strictEqual(s.seen.bodies[0].stream, true, '没开流式 = 白改');
  assert.ok(s.seen.bodies[0].stream_options && s.seen.bodies[0].stream_options.include_usage,
    '没有 include_usage, token 账本只能估算');
});

test('T2 Anthropic 路径不许带 stream (事件格式是另一套, 硬套装不出内容)', async () => {
  let body = null;
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: '好' }] }));
  });
  try {
    const m = localModel(s.url, { protocol: 'anthropic', provider: 'custom' });
    const r = await subAgent.callLLM([{ role: 'user', content: '嗨' }], m, []);
    assert.strictEqual(r.text, '好', 'Anthropic 非流式仍要能正常装配');
    body = s.seen.bodies[0];
  } finally { await s.close(); }
  assert.strictEqual(body.stream, undefined, 'Anthropic 分支不许开流式');
});

// ===== 2. SSE 装配: 唯一真源, 不许分叉 =====

test('T3 SSE 体要装配出 content + tool_calls + usage (碎片到达也不能丢)', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(delta('读回 '));
    res.write(delta('b.txt'));
    res.write(sseLine({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":' } }] } }],
    }));
    res.write(sseLine({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"b.txt"}' } }] } }],
    }));
    res.write(sseLine({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
    res.write(sseLine({ usage: { prompt_tokens: 111, completion_tokens: 22, total_tokens: 133 } }));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  let r;
  try { r = await subAgent.callLLM([{ role: 'user', content: '读回 b.txt' }], localModel(s.url), []); }
  finally { await s.close(); }
  assert.strictEqual(r.text, '读回 b.txt', '分片 content 没拼起来');
  assert.strictEqual(r.nativeCalls.length, 1, '工具调用没装配出来');
  assert.strictEqual(r.nativeCalls[0].name, 'read_file');
  assert.deepStrictEqual(r.nativeCalls[0].args, { path: 'b.txt' }, '分片 arguments 没拼成合法 JSON');
  assert.ok(r.usage && r.usage.total_tokens === 133,
    'usage 必须原样带出去 (丢了就 100% 落进估算分支), 实测 ' + JSON.stringify(r.usage));
});

test('T4 一行 data: 被 chunk 边界劈成两半也不能坏 (真会这么发生)', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const full = delta('半行测试');
    res.write(full.slice(0, 12));   // 故意从中间劈开
    setTimeout(() => { res.write(full.slice(12)); res.write('data: [DONE]\n\n'); res.end(); }, 15);
  });
  let r;
  try { r = await subAgent.callLLM([{ role: 'user', content: 'x' }], localModel(s.url), []); }
  finally { await s.close(); }
  assert.strictEqual(r.text, '半行测试', '半行没扛住 —— 这正是 _parseSSEBody 注释里记过的坑');
});

// ===== 3. 活性上报: 主人得知道它在动 =====

test('T5 onTick 必须报 first_byte / thinking / progress / done 四种活性', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // 先只吐思考, 再吐正文 —— 这段"屏幕上什么都没有"的时间正是老板说的"跟死了一样"
    res.write(sseLine({ choices: [{ index: 0, delta: { reasoning_content: '在想…' } }] }));
    res.write(delta('开始干活'));
    res.write(sseLine({ usage: { prompt_tokens: 5, completion_tokens: 6 } }));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const ticks = [];
  try {
    await subAgent.callLLM([{ role: 'user', content: '干活' }], localModel(s.url), [],
      { mode: 'kun', onTick: (e) => ticks.push(e) });
  } finally { await s.close(); }
  const stages = ticks.map(t => t.stage);
  assert.ok(stages.includes('sub_first_byte'), '首字节必须报 —— 这是"连上了"的证据');
  assert.ok(stages.includes('sub_thinking'), '思考期必须单独报, 实测 ' + stages.join(','));
  assert.ok(stages.includes('sub_done'), '收口必须报');
  const done = ticks.find(t => t.stage === 'sub_done');
  assert.strictEqual(done.streamed, true, '收口要如实说这条是不是流式拿到的');
  assert.ok(done.tools && Array.isArray(done.tools), '收口要带工具名 —— "有没有用工具"是老板的原话');
  assert.strictEqual(done.agent, 'kun', '活性事件必须带角色, 否则前端分不清是谁在动');
});

test('T6 onTick 抛错绝不能影响这一轮 (进度回调不是主链路)', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(delta('内容'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  let r;
  try {
    r = await subAgent.callLLM([{ role: 'user', content: 'x' }], localModel(s.url), [], {
      mode: 'kun',
      onTick: () => { throw new Error('前端炸了'); },
    });
  } finally { await s.close(); }
  assert.strictEqual(r.text, '内容', '进度回调抛错不许把这一轮带走');
});

test('T7 stream:false 时必须退回非流式 (给不接流式的端点留退路)', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: '非流式答复' } }],
    }));
  });
  let r;
  try {
    r = await subAgent.callLLM([{ role: 'user', content: 'x' }], localModel(s.url), [], { stream: false });
  } finally { await s.close(); }
  assert.strictEqual(s.seen.bodies[0].stream, undefined);
  assert.strictEqual(r.text, '非流式答复');
});

// ===== 4. 上游不认流式时退回一次, 不是一直重试 =====

test('T8 上游对流式返 4xx → 退回非流式重试**一次** (重试两次就是烧钱)', async () => {
  const s = await startServer((req, res, n) => {
    if (n === 1) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'stream not supported' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ index: 0, message: { role: 'assistant', content: '退回成功' } }],
    }));
  });
  let r;
  try { r = await subAgent.callLLM([{ role: 'user', content: 'x' }], localModel(s.url), []); }
  finally { await s.close(); }
  assert.strictEqual(r.text, '退回成功', '退回路径没走通');
  assert.strictEqual(s.seen.count, 2, '必须**恰好**重试一次, 实测 ' + s.seen.count + ' 次');
  assert.strictEqual(s.seen.bodies[0].stream, true, '第一次该带流式');
  assert.strictEqual(s.seen.bodies[1].stream, undefined, '退回那次必须摘掉 stream');
});

// ===== 5. 结构不变量: 防被改回非流式 =====

test('W1 子 agent 链路必须走同一个 SSE 装配器 (两套装配迟早分叉成静默空)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');
  assert.ok(src.includes("require('../modules/llm_caller')._parseSSEBody"),
    '装配必须走 llm_caller._parseSSEBody 唯一真源');
  assert.ok(src.includes('_p.stream = true'), '必须开流式');
  assert.ok(src.includes('stream_options'), '必须带 include_usage');
  assert.ok(src.includes('res.resume()'), '退回前必须消费掉响应, 否则 socket 泄漏');
  assert.ok(!/req\.write\(body\);\s*\n\s*req\.end\(\);\s*\n\s*\}\);\s*\n\s*try \{/.test(src),
    '旧的裸 req.write(body) 写法不该复活');
});

test('W2 runAgentLoop 必须把 onTick 接进 onProgress (不然活性事件出不去)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');
  assert.ok(/_callLLM\(messages, model, _tools, \{[\s\S]{0,200}onTick/.test(src),
    '主调用点必须传 onTick');
  assert.ok(/onTick: \(e\) => \{ if \(onProgress\) onProgress\(e\); \}/.test(src),
    'onTick 必须转成 onProgress 事件往上报');
});

test('W3 dispatcher 每个子 agent 调用点都必须报活性 (漏一个就有几分钟白屏)', () => {
  // 现场踩过: planner 那次调用压根没传 onProgress —— 子 agent 侧流式做得再对,
  // 事件也发不出去。而 planner 恰恰是唯一会被 300s 墙砍掉的那条路。
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_dispatcher.js'), 'utf8');
  const idxs = [];
  let p = 0;
  while ((p = src.indexOf('subAgent.run({', p)) !== -1) { idxs.push(p); p += 5; }
  assert.ok(idxs.length >= 5, '子 agent 调用点应 ≥5, 实测 ' + idxs.length);
  const missing = idxs.filter((ix, k) => {
    const end = idxs[k + 1] !== undefined ? idxs[k + 1] : Math.min(src.length, ix + 1400);
    return !/onProgress/.test(src.slice(ix, end));
  });
  assert.strictEqual(missing.length, 0,
    '这些调用点没接 onProgress (行 ' + missing.map(ix => src.slice(0, ix).split('\n').length).join(',') + ')');
  // planner 尤其不能漏: 它超时最频繁, 也是主人唯一看不见的那几分钟
  // 2026-10-18 拼音统一: 角色名 planner → kan, 字面量跟着换, 意图不变。
  const plannerIdx = src.indexOf("mode: 'kan'");
  assert.ok(plannerIdx > 0 && /onProgress/.test(src.slice(plannerIdx, plannerIdx + 600)),
    'planner 必须报活性');
});

test('W4 runPlanner 也必须开流式 (它不走 runAgentLoop, 接错地方等于没接)', () => {
  // 现场踩过: 主调用点接了 onTick, dispatcher 也传了 onProgress, 全绿 ——
  // 但 planner 根本不走 runAgentLoop, 它有独立的 runPlanner(), 里面的 callLLM
  // 没传第 4 个参数。于是 planner 仍是非流式, 仍被 300s 砍, 仍然一片死寂。
  // **"接上了"必须验到实际生效的那一次调用**, 不是验到参数存在。
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');
  const body = src.slice(src.indexOf('async function runPlanner'), src.indexOf('async function run({'));
  assert.ok(body.length > 0, '找不到 runPlanner');
  const call = /const response = await callLLM\(([\s\S]*?)\);/.exec(body);
  assert.ok(call, 'runPlanner 里找不到 callLLM');
  assert.ok(/,\s*\{[\s\S]*onTick/.test(call[0]),
    'runPlanner 的 callLLM 必须传 llmOpts { onTick }, 现状: ' + call[0].replace(/\s+/g, ' ').slice(0, 120));
  assert.ok(/mode: 'kan'/.test(call[0]), '必须标明是 planner, 否则活性事件认不出是谁在动');
});

