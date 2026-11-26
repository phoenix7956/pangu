'use strict';
// 2026-10-16 现场 (clean-base2-20261016, 3 刀 analyzer 全部没交出总结):
//
//   本地 27B 冷 prefill 13.7k token 实测 45~90s 才吐第一个字, 而 LM Studio 是
//   **响应头秒回、数据 90s 后才到**。原来的空闲计时器在响应头到达那一刻就起跑,
//   于是一个健康生成被判成死连接:
//
//     STREAM_IDLE_TIMEOUT_90s → destroy → legacy J2 XML fallback
//       → 同轮重试撞 ECONNRESET → _isInfraError 判成「端点不可用」
//         → _pickCheapestModel → 本地只剩一个 27B → 公平切**云端** k3-256k
//           (按量计费) → INFRA fast-fail → assistant 空 / 误导文案「检查网络/DNS」
//
//   一次**纯本地**的请求, 被自己的超时带着烧了云端的钱。
//
// 这里钉的是两段预算这个不变量, 以及"本地端点先原地重试 (免费) 再考虑切模型 (烧钱)"。
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const path = require('path');

const M = (p) => require(path.join(__dirname, '..', p));
const llmCaller = M('modules/llm_caller.js');
const shared = M('modules/j2_loop_shared.js');
const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

llmCaller.init({
  _config: { llm: { models: [], openai_base_url: '', temperature: 0.3 } },
  fs, path, os: require('os'), https: require('https'), http,
  PRESETS: {}, PANGU_SYSTEM_PROMPT: '你是测试用的最小身份。',
});

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
registry.setContextLength('fake-prefill', 65536, 'test');

function sseLine(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }
function delta(content) { return sseLine({ choices: [{ index: 0, delta: { content } }] }); }

async function startServer(handler) {
  const open = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { open.push(res); handler(req, res); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return {
    url: 'http://127.0.0.1:' + srv.address().port,
    close: () => new Promise(r => {
      for (const res of open) { try { res.destroy(); } catch (_) {} }
      srv.close(r);
    }),
  };
}

function localModel(url) {
  return {
    id: 'fake-prefill', name: 'fake-prefill', provider: 'lmstudio',
    endpoint: url, protocol: 'openai', context_length: 65536,
  };
}

async function drain(gen) {
  let text = '';
  for await (const d of gen) text += String(d || '');
  return text;
}

// 摆两个预算, 跑完复原
function withBudgets({ idle, prefill, total }, fn) {
  const keys = { idle: 'PANGU_STREAM_IDLE_MS', prefill: 'PANGU_PREFILL_MS', total: 'PANGU_STREAM_TOTAL_MS' };
  const prev = {};
  for (const [k, name] of Object.entries(keys)) {
    prev[k] = process.env[name];
    if (k === 'total') delete process.env[name];          // total 故意留空, 让它自己算
    else if (k === 'idle') process.env[name] = String(idle);
    else process.env[name] = String(prefill);
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, name] of Object.entries(keys)) {
      if (prev[k] === undefined) delete process.env[name];
      else process.env[name] = prev[k];
    }
  });
}

// ===== 1. 预算不变量 =====

test('T1 本地模型的 prefill 预算必须显著大于 idle 预算 (两段预算是这次修复的全部要害)', () => {
  const lm = { provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234' };
  const idle = llmCaller._streamIdleMs();
  const pre = llmCaller._prefillMs(lm);
  assert.ok(pre >= idle * 2,
    `prefill 预算(${pre}ms) 必须 >= idle 预算(${idle}ms) 的 2 倍 —— `
    + '写成同一个值等于把「本地大 prompt 冷 prefill 被判死」这个 bug 请回来');
});

test('T2 总时长熔断必须宽于 prefill 预算, 否则流式比非流式更容易超时 (倒挂)', () => {
  const lm = { provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234' };
  const total = llmCaller._streamTotalMs(lm);
  assert.ok(total > llmCaller._prefillMs(lm),
    `总墙(${total}ms) 必须宽于 prefill 预算(${llmCaller._prefillMs(lm)}ms)`);
});

// ===== 2. 实况差分: 头秒回、首字节慢 =====

test('T3 头到了但首字节比 idle 预算慢 (本地 prefill 的真实形状) → 必须活下来, 不许判死', async () => {
  // 上游形状 = 现场: writeHead 立刻返回, 然后什么都不发 1.2s 才吐第一个字。
  // 旧的单一 300ms 空闲墙在这个形状上必然炸 (STREAM_IDLE_TIMEOUT_0s),
  // 两段预算下 prefill=2.5s 给了它活路。
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // flushHeaders 不能省: Node 里光 writeHead() **不发头**, 要等第一次 write 才发 ——
    // 那样 fetch 自己就被堵住了, 根本进不到 prefill 阶段, 这个测试会变成"测了个寂寞"。
    // 真实 LM Studio 是响应头秒回、之后才慢慢 prefill, 所以必须显式把头推出去。
    res.flushHeaders();
    setTimeout(() => {
      res.write(delta('慢但是活的'));
      res.write('data: [DONE]\n\n');
      res.end();
    }, 1200);
  });
  await withBudgets({ idle: 300, prefill: 2500 }, async () => {
    let err = null, text = '';
    try {
      text = await drain(llmCaller._callLLMForAgentStream(
        [{ role: 'user', content: '你好' }], localModel(s.url), []));
    } catch (e) { err = e; }
    assert.ok(!err,
      `prefill 预算内的慢首字节不是死连接, 不该报错 (拿到: ${err && err.message})`);
    assert.match(text, /慢但是活的/, '活下来就该拿到正文');
  });
  await s.close();
});

test('T4 首字节连 prefill 预算都超了 → 报 STREAM_PREFILL_TIMEOUT (名字必须能指方向)', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();   // 头先出去, 才算真的进了 prefill 阶段 (同 T3 的理由)
    setTimeout(() => { res.write(delta('太晚了')); res.end(); }, 1800);
  });
  await withBudgets({ idle: 300, prefill: 500 }, async () => {
    let err = null;
    try {
      await drain(llmCaller._callLLMForAgentStream(
        [{ role: 'user', content: '你好' }], localModel(s.url), []));
    } catch (e) { err = e; }
    assert.ok(err, '超了 prefill 预算必须判死');
    assert.match(err.message, /STREAM_PREFILL_TIMEOUT/,
      `报错名要能区分"没开始算"和"算到一半停了" (拿到: ${err && err.message})`);
    assert.ok(!/STREAM_IDLE_TIMEOUT/.test(err.message),
      'prefill 阶段超预算不该自称 idle 超时 —— 运维看到 idle 会去查上游挂没挂');
  });
  await s.close();
});

test('T5 吐过字之后再静默 → 仍走 90s 语义判死 (两段预算不能把真死放过去)', async () => {
  // 回归护栏: 分段不是为了把熔断放宽, 是为了把判死**挪到正确的阶段**。
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(delta('开个头'));
    // 之后连接留着, 什么都不再发, 也不 end() —— 现场 4 分 46 秒的形状
  });
  await withBudgets({ idle: 400, prefill: 5000 }, async () => {
    let err = null;
    try {
      await drain(llmCaller._callLLMForAgentStream(
        [{ role: 'user', content: '你好' }], localModel(s.url), []));
    } catch (e) { err = e; }
    assert.ok(err, '已经开始吐字又静默 = 上游真死, 必须判死');
    assert.match(err.message, /STREAM_IDLE_TIMEOUT/,
      `吐过字之后的静默应该报 idle 超时 (拿到: ${err && err.message})`);
  });
  await s.close();
});

// ===== 3. 别烧云端的钱 =====

test('T6 本地端点瞬断: 先原地重试 (免费), 原地失败过才轮到切模型 (烧钱)', () => {
  const local = { id: 'lmx', provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234' };
  const cloud = { id: 'k3-256k', provider: 'kimi', endpoint: 'https://api.kimi.com/v1' };

  const st = {};
  assert.strictEqual(shared._preferSameLocalRetry(local, st), true,
    '本地端点第一次瞬断必须原地重试 —— 127.0.0.1 重试不烧配额, 切云端按量计费');
  assert.strictEqual(shared._preferSameLocalRetry(local, st), false,
    '原地重试只给一次机会, 否则死循环');
  assert.strictEqual(shared._preferSameLocalRetry(cloud, {}), false,
    '云端模型不适用这条 (云端本来就烧钱, 切不切是另一回事)');
});

test('T7 超时文案不许把人引去查 DNS (端点其实是通的)', () => {
  const t = shared._infraFailText('STREAM_PREFILL_TIMEOUT_300s', { id: 'qwen3.8-27b-mlx' });
  assert.ok(!/DNS/.test(t), `超时不是网络故障, 文案不该喊检查 DNS (拿到: ${t})`);
  assert.ok(!/网络\/DNS/.test(t), `超时文案不该说"端点连不上" (拿到: ${t})`);
  assert.match(t, /端点是通的/, '要说清端点是通的, 只是慢');
  // 真的网络类错误仍然保留原来的说法 (别把有用信息一起删了)
  assert.match(shared._infraFailText('ECONNREFUSED', { id: 'x' }), /DNS/,
    'ECONNREFUSED 仍然是网络问题, 原文案要留着');
});

test('T8 dispatcher 的死因正则认得新报错名 (漏了就等于把空刀当有产出)', () => {
  // 2026-10-20: 正则在 2026-10-19 (4d12b8b) 搬到了 modules/slice_death.js,
  // 这条测试还在 j2_dispatcher.js 里 grep 定义 —— grep 不到就一直红着, 红的是测试不是代码。
  // 直接 require 导出的正则: 测行为, 不测源码长相 (以后再搬一次也不会假红)。
  const { SLICE_DEAD_RE } = M('modules/slice_death.js');
  assert.ok(SLICE_DEAD_RE, 'slice_death 必须导出 SLICE_DEAD_RE');
  const re = SLICE_DEAD_RE;
  assert.ok(re.test('STREAM_PREFILL_TIMEOUT_300s'),
    'slice 死因正则必须认 STREAM_PREFILL_TIMEOUT');
  assert.ok(re.test('STREAM_IDLE_TIMEOUT_90s'),
    'slice 死因正则必须继续认 STREAM_IDLE_TIMEOUT');
});

// ===== 4. 内联牙齿: 光有上面的函数测试不够, 线路也得真的在用 =====

test('T9 内联检查: 两处流式线路都真的用了分段预算, 不是写死的常量', () => {
  const src = SRC('modules/llm_caller.js');
  // http.request 路径: resetIdle 必须按 _gotByte 分支
  assert.ok(/_gotByte\s*\?\s*_streamIdleMs\(\)\s*:\s*_prefillMs\(/.test(src),
    'http.request 路径的 resetIdle 必须按是否吐过字节选预算');
  // fetch 读循环路径: 同样必须按 _gotByteFetch 分支
  assert.ok(/_gotByteFetch\s*\?\s*_streamIdleMs\(\)\s*:\s*_prefillMs\(/.test(src),
    'fetch 路径的 read 竞速必须按是否吐过字节选预算');
  // 两段预算都要真的把 _gotByte 置真 (只声明不置真 = 永远停在 prefill 预算)
  assert.ok((src.match(/_gotByte\s*=\s*true/g) || []).length >= 1,
    'http.request 路径必须把 _gotByte 置真, 否则永远用 prefill 预算 (熔断等于没加)');
  assert.ok((src.match(/_gotByteFetch\s*=\s*true/g) || []).length >= 1,
    'fetch 路径必须把 _gotByteFetch 置真, 否则永远用 prefill 预算');
  // 不许再有裸的 setTimeout(..., _streamIdleMs()) 形式
  assert.ok(!/setTimeout\(\s*\(\)\s*=>\s*rej\(new Error\('STREAM_IDLE_TIMEOUT_[^)]*\)\s*,\s*_streamIdleMs\(\)/.test(src),
    '不许再有"裸 idle 预算 + 固定 idle 报错名"的旧写法');
});

test('T10 内联检查: 两条 catch 都要先问"原地重试", 再去挑模型', () => {
  const src = SRC('modules/j2_agent_loop.js');
  const uses = (src.match(/_preferSameLocalRetry\(/g) || []).length;
  assert.ok(uses >= 2,
    `native 与 stream 两条 catch 都得先过 _preferSameLocalRetry (只接了 ${uses} 处)`);
  // 切模型的 if 必须被同一个本地重试判定挡住, 否则守卫形同虚设
  assert.ok(/_preferSameLocalRetry\(model, _state\)[\s\S]{0,400}?if \(!_streamRetrySameLocal && _isInfraError/.test(src),
    'stream 路径切模型前必须先看 _streamRetrySameLocal');
});

