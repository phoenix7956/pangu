// 2026-10-16 收口 (综合答案) 那一次调用的时间账
//
// 现场 v2-032551: 主人的活是"建 2 个文本文件"。盘古跑完 8 分 43 秒:
//   planner 数分钟 → executor 30s 写出文件 → checker 复核 → **收口 4 分 46 秒**
// 那 4 分 46 秒里: 盘古进程 0% CPU 睡着, LM Studio 推理进程 2.7% CPU (= 空闲),
// TCP 连接还 ESTABLISHED, 一个字节都不发。**上游已经死了, 而盘古在等它。**
//
// 为什么拖满 300s: 收口走的是非流式 `_callLLMForAgent` —— 拿到响应头之后,
// "上游死了"和"还在慢慢生成"在协议上完全一样, 没有任何信号能提前判, 只能等
// `req.setTimeout` 的 300s 空闲墙。实测本机 headers 0.00s、首字节 ~1s
// (探到 48K 字上下文仍 ~0.8s), 所以那 300s 里 99% 是白等的。
//
// 修法: 收口也走流式 (llm_caller 的流式路径自带 90s 无数据判死 + 300s 总时长),
// 并且那个"多久没数据算死"要可配, 否则既调不动、也没法在测试里复现这个故障。
//
// 这些测试用**真的本地 SSE 服务端**跑, 不用 mock —— 故障恰恰发生在
// "头到了、正文不来"这个字节层, mock 出来的响应碰不到。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('fs');

const M = (p) => require(path.join(__dirname, '..', p));
const llmCaller = M('modules/llm_caller.js');
const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// llm_caller 靠 init() 注入的模块句柄发请求 (fs/path/http/...), 单测里自己喂一份最小的。
// 这也说明为什么这段以前没人写单测: 它不是"一个函数", 是整个注入点。
llmCaller.init({
  _config: { llm: { models: [], openai_base_url: '', temperature: 0.3 } },
  fs, path, os: require('os'), https: require('https'), http,
  PRESETS: {}, PANGU_SYSTEM_PROMPT: '你是测试用的最小身份。',
});

// 上下文长度在 R88 之后只有一个真源: model_registry (探测写回)。所以测流式必须先
// 给假模型登记一个 ctx, 否则 getModelContextLength 直接 fail-loud。
// 真源是主人机器上的 ~/.pangu 文件 —— 测完原样还回去, 不留垃圾。
const registry = M('modules/model_registry.js');
const REG_PATH = registry.registryPath();
const REG_SNAPSHOT = fs.existsSync(REG_PATH) ? fs.readFileSync(REG_PATH, 'utf8') : null;
test.after(() => {
  registry._reset();
  try {
    if (REG_SNAPSHOT === null) { if (fs.existsSync(REG_PATH)) fs.unlinkSync(REG_PATH); }
    else fs.writeFileSync(REG_PATH, REG_SNAPSHOT);
  } catch (_) {}
  registry._reset();
});
registry.setContextLength('fake-synth', 65536, 'test');

function sseLine(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }
function delta(content) {
  return sseLine({ choices: [{ index: 0, delta: { content } }] });
}

async function startServer(handler) {
  const seen = { count: 0, bodies: [] };
  const open = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => {
      seen.count += 1;
      try { seen.bodies.push(JSON.parse(b)); } catch (_) { seen.bodies.push(b); }
      open.push(res);
      handler(req, res, seen.count);
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return {
    url: 'http://127.0.0.1:' + srv.address().port,
    seen,
    close: () => new Promise(r => {
      for (const res of open) { try { res.destroy(); } catch (_) {} }
      srv.close(r);
    }),
  };
}

function localModel(url, extra) {
  return Object.assign({
    id: 'fake-synth', name: 'fake-synth', provider: 'lmstudio',
    endpoint: url, protocol: 'openai', context_length: 65536,
  }, extra || {});
}

async function drain(gen) {
  let text = '';
  for await (const d of gen) text += String(d || '');
  return text;
}

// ===== 1. 实况复现: 头到了、正文不来 =====

test('T1 上游半路死掉 (头到了就静默) → 空闲判死, 绝不能烧满 300s 空闲墙', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(delta('开个头'));
    res.write(delta('再两个字'));
    // 关键: 连接留着, 什么都不再发, 也不 end() —— 这就是现场那 4 分 46 秒的形状
  });
  const prev = process.env.PANGU_STREAM_IDLE_MS;
  process.env.PANGU_STREAM_IDLE_MS = '1200';
  const t0 = Date.now();
  try {
    let err = null;
    try {
      await drain(llmCaller._callLLMForAgentStream(
        [{ role: 'user', content: '综合一下' }], localModel(s.url), []));
    } catch (e) { err = e; }
    const waited = Date.now() - t0;
    assert.ok(err, '上游死了必须报错, 不能当成正常收工');
    assert.match(err.message, /STREAM_IDLE_TIMEOUT_1s/,
      `应报空闲判死 (拿到的是: ${err && err.message})`);
    assert.ok(waited < 15000, `空闲判死应该 1.2s 左右就发生, 实际等了 ${waited}ms`);
  } finally {
    if (prev === undefined) delete process.env.PANGU_STREAM_IDLE_MS;
    else process.env.PANGU_STREAM_IDLE_MS = prev;
    await s.close();
  }
});

test('T2 收口必须真的开流式 (不流式就回到"死与慢不可分辨"的老路)', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (let i = 0; i < 3; i++) res.write(delta('段' + i));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const text = await drain(llmCaller._callLLMForAgentStream(
      [{ role: 'user', content: '综合一下' }], localModel(s.url), []));
    assert.strictEqual(text, '段0段1段2', '流式增量应按序拼成完整答案');
    assert.strictEqual(s.seen.bodies[0].stream, true, '收口没开流式 = 白改');
  } finally { await s.close(); }
});

test('T3 上游只发 [DONE] 不给内容 → 流层返回空串, 收口助手必须自己挡住空答案', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    let err = null;
    let text = null;
    try {
      text = await drain(llmCaller._callLLMForAgentStream(
        [{ role: 'user', content: '综合一下' }], localModel(s.url), []));
    } catch (e) { err = e; }
    // 实况: [DONE] 直接 return, 所以流层的 STREAM_ENDED_WITH_ZERO_CONTENT 这条分支
    // 在"上游正常收尾但一个字没给"时**不可达**。这里把真实行为钉住, 别让人以为
    // 流层已经挡住了空答案 —— 收口那条防线在助手自己身上。
    assert.strictEqual(err, null, `[DONE] 正常收尾不该报错: ${err && err.message}`);
    assert.strictEqual(text, '');
    const src = SRC('modules/j2_dispatcher.js');
    assert.ok(/if \(!text\.trim\(\)\) throw new Error\('SYNTHESIS_STREAM_ZERO_CONTENT'\)/.test(src),
      '收口助手必须有零内容守卫 —— 否则空流会交一份空答案给主人');
  } finally { await s.close(); }
});

// ===== 2. 资源清理: 每次 read 的空闲 guard 必须清掉 =====

test('T4 一个正常的长流跑完, 不能攒下一堆挂着的空闲定时器', async () => {
  const CHUNKS = 60;
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // 分多次 flush, 确保真的产生多次 read 循环迭代 (一次 read 拿到全部就测不到)
    let i = 0;
    const tick = () => {
      while (i < CHUNKS) { res.write(delta('x')); i++; }
      if (i >= CHUNKS) { res.write('data: [DONE]\n\n'); res.end(); return; }
      setTimeout(tick, 1);
    };
    tick();
  });

  const created = [];
  const _st = global.setTimeout, _ct = global.clearTimeout;
  global.setTimeout = function (...a) { const t = _st.apply(this, a); created.push(t); return t; };
  global.clearTimeout = function (t) { return _ct.apply(this, arguments); };
  try {
    await drain(llmCaller._callLLMForAgentStream(
      [{ role: 'user', content: '综合一下' }], localModel(s.url), []));
  } finally {
    global.setTimeout = _st;
    global.clearTimeout = _ct;
    await s.close();
  }
  // 只统计调用期间新建、且此刻仍未销毁的定时器
  const leaked = created.filter(t => t && !t._destroyed);
  assert.ok(leaked.length <= 1,
    `流跑完后还挂着 ${leaked.length} 个定时器 (每次 read 的空闲 guard 没清干净)`);
});

// ===== 3. 接线: 参数存在 ≠ 那条路真的用了它 =====

test('T5 4 处收口全部走流式助手, 且流式依赖真的注入了 dispatcher', () => {
  const src = SRC('modules/j2_dispatcher.js');
  const calls = src.match(/_synthesizeStreamText\(summaryMessages/g) || [];
  // 2026-10-23(第 65 批): 四条综合路(2 关键词兜底 + fixed_flow + 主路径)现在共用
  //   `_synthesizeAndFinalize` —— 流式助手的调用点从 4 处收成 1 处。
  //   **意图一个字没变**: 每条综合路都得走流式助手, 不许有收口留在非流式。
  //   新量法: 出口账本 —— 3 条综合出口都必须经那个统一实现走到流式助手;
  //   唯一不走流式的是直答那条(它本来就不流正文)。
  assert.strictEqual(calls.length, 2,
    `应为 1 处统一调用 + 1 处定义, 实际 ${calls.length} —— 有收口还留在非流式`);
  const { finalizeCoverage } = require('./helpers/dispatcher_exits');
  const _cov = finalizeCoverage();
  assert.ok(_cov.covered('_synthesizeStreamText').length >= 3,
    '综合出口应至少 3 个(关键词兜底/fixed_flow/主路径), 实际 '
    + _cov.covered('_synthesizeStreamText').length);
  // 2026-10-24 (第 77 批): 不走流式助手的从 1 条变成 2 条 —— 直答那条 + 澄清那条
  //   (澄清 = 主 agent 判指代不明, 把反问直接交回主人, 它本来就没有综合可流)。
  // 名单在 helpers/dispatcher_exits (唯一真源), 三个「覆盖/份数」判据共用一份。
  const { isDirectDelivery } = require('./helpers/dispatcher_exits');
  const _uncStream = _cov.uncovered('_synthesizeStreamText');
  assert.strictEqual(_uncStream.length, 2,
    '只有直答/澄清两条不走流式助手, 实际未覆盖: '
    + _uncStream.map((e) => 'L' + e.line).join(', '));
  for (const e of _uncStream) {
    assert.ok(isDirectDelivery(e),
      'L' + e.line + ' 是综合路, 却不走流式助手: ' + e.text.slice(0, 140));
  }
  const hStart = src.indexOf('async function _synthesizeStreamText');
  const hEnd = src.indexOf('if (typeof safeResWrite', hStart);
  const helper = src.slice(hStart, hEnd);
  const outside = src.slice(0, hStart) + src.slice(hEnd);
  assert.ok(/await _callLLMForAgent\(summaryMessages/.test(helper),
    '助手内部必须保留非流式兜底 (依赖没注入时行为不变)');
  assert.ok(!/await _callLLMForAgent\(summaryMessages/.test(outside),
    '助手之外不该再有非流式收口调用');
  // 依赖没注入就静默退回非流式 = 修了等于没修, 这条必须钉死
  const main = SRC('pangu-single.js');
  const init = main.slice(main.indexOf('j2Dispatcher.init('), main.indexOf('j2Dispatcher.init(') + 1200);
  assert.ok(/^\s*_callLLMForAgentStream,/m.test(init),
    'pangu-single 没把 _callLLMForAgentStream 注入 dispatcher —— 助手会退回非流式');
});

test('T6 空闲判死可配且默认 90s (别把本地长思考误杀成短任务)', () => {
  const src = SRC('modules/llm_caller.js');
  assert.ok(/PANGU_STREAM_IDLE_MS/.test(src), '空闲判死必须可配, 否则测不了也调不动');
  assert.ok(/Number\.isFinite\(n\) && n > 0\) \? n : 90000/.test(src),
    '默认值必须仍是 90000 (实测本地首字节 ~1s, 90s 判死是安全的)');
});
