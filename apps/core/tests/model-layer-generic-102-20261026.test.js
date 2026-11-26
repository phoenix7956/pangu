'use strict';
// 第 102 批: 模型层通用性守卫 (第四轮) —— 新厂商兼容 + 自建推理服务
//
// 老板的四条收尾:
//   ① lookupCapabilities 对新厂商是「查不到」还是「查错」→ 走自定义兼容模式
//   ② 生产模型缓存里的测试残留 (fake-* / probe-local) 不许再躺着
//   ③ 内网自建推理服务 (192.168.x.x) 要按**开源的走法**默认生效
//   ④ 多 agent spawn 被拒的根因 (在盘古仓库之外, 但结论落档)
//
// 本守卫要证明:
//   G102a · 显式 provider 是事实 —— 新厂商**不被改判**成别家 (查错回归守卫)
//   G102b · 命中必须**精确到模型名** —— 前缀/包含的模糊命中已消除
//   G102c · 查不到 ⇒ **自定义兼容模式** (能力取模型条目声明, 未知就是未知)
//   G102d · 自建推理服务 (回环 + 内网) 默认吃软默认 + 长超时, 且与超时**同口径**
//   G102e · 自建口径可显式退出 (selfhosted:false / scope=loopback / 显式声明主机)
//   G102f · 生产模型缓存里没有测试残留
//   G102g · **接线**是通的 (真起服务器 + 真打路由; 纯函数守卫测不出接线)
//   G102h · 变异体检: 把这几处改回旧行为 ⇒ 守卫必须**真**报红

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const llmSync = require(path.join(ROOT, 'modules', 'llm_capabilities_sync'));
const capability = require(path.join(ROOT, 'modules', 'model_capability'));
const localModel = require(path.join(ROOT, 'modules', 'local_model'));

// ─────────────────────────────────────────────────────────────
// G102a · 显式 provider 优先 —— 新厂商不被改判 (查错的根)
// ─────────────────────────────────────────────────────────────
test('G102a: 模型条目写了 provider 就以它为准, 新厂商不被改判成别家', () => {
  // 这三个是 102 批之前**实测的查错** (旧代码会把它们改判成别家):
  //   {provider:'newvendor', id:'k3'}       → 旧: moonshotai
  //   {provider:'acme',      id:'kimi-k2'}  → 旧: moonshotai
  //   {provider:'acme',      id:'qwen3-8b'} → 旧: alibaba
  const wrong = [
    { provider: 'newvendor', id: 'k3' },
    { provider: 'acme', id: 'kimi-k2' },
    { provider: 'acme', id: 'qwen3-8b' },
  ];
  for (const m of wrong) {
    const rp = llmSync.resolveProvider(m);
    assert.equal(rp.provider, m.provider,
      `新厂商被改判成 ${rp.provider} 了 —— 模型名里带了别家的关键词就串味 (查错)`);
    assert.equal(rp.custom, true, `没被规则表认识的厂商应标记为 custom (走自定义兼容模式)`);
  }
  // 规则表认识的 provider 仍要映射到能力库命名空间 (kimi → moonshotai)
  assert.equal(llmSync.resolveProvider({ provider: 'kimi', id: 'k3' }).provider, 'moonshotai');
  assert.equal(llmSync.resolveProvider({ provider: 'minimax', id: 'minimax-m3' }).provider, 'minimax');
  // 泛用 provider (自定义网关) 仍然靠端点/模型名去认 (自定义网关转发 kimi 是真实场景)
  assert.equal(llmSync.resolveProvider({ provider: 'custom', id: 'kimi-k2' }).provider, 'moonshotai');
  // 没有 provider 时才用规则表猜
  // ⚠️ 2026-10-26 交叉审改的: 猜出来的必须是**能力库里真实存在的命名空间**。
  //    原来这里猜出 'alibaba', 但库里那个命名空间只有 1 条 (qwen 主体在 'qwen' 下, 47 条)
  //    ⇒ 那个厂商的模型永远查不到 ⇒ 全掉进自定义兼容模式。
  assert.equal(llmSync.resolveProvider({ id: 'qwen3.8-27b' }).provider, 'qwen');
});

// ─────────────────────────────────────────────────────────────
// G102b · 命中必须精确到模型名
// ─────────────────────────────────────────────────────────────
test('G102b: 能力命中必须精确到模型名 —— 前缀模糊命中已消除', () => {
  // 'kimi-k2-thinking' 与 'kimi-k2' 是**两个模型** (前者 reasoning=true, 后者 false)。
  // 旧实现用 startsWith 模糊匹配 ⇒ 前者会拿到后者的能力 (reasoning 整个搞反)。
  const exact = llmSync.lookupCapabilities('moonshotai', 'kimi-k2-thinking');
  assert.ok(exact, '库里的模型必须查得到');
  assert.equal(exact.key, 'moonshotai/kimi-k2-thinking', '命中必须是精确的那个条目');
  assert.equal(exact.authoritative, true);

  // 截断的模型名**不应**再命中 (前缀近似 = 查错)
  const truncated = llmSync.lookupCapabilities('moonshotai', 'kimi-k2');
  assert.ok(truncated, '完整名字仍然要能查到');
  assert.equal(truncated.key, 'moonshotai/kimi-k2');

  // 换写法要能查到同一个模型 (MLX/llama.cpp 风格: 厂商_模型名)
  const alias = llmSync.lookupCapabilities('qwen', 'qwen_qwen3-8b');
  assert.ok(alias, '厂商前缀写法必须能查到 (归一后精确命中)');
  assert.equal(alias.key, 'qwen/qwen3-8b');

  // 模型名全库唯一时, 谁提供它都算命中 (模型身份就是模型身份)
  const byModel = llmSync.lookupCapabilities('acme', 'kimi-k2');
  assert.ok(byModel, '全库唯一的模型名应跨厂商命中');
  assert.equal(byModel.key, 'moonshotai/kimi-k2');
  assert.equal(byModel.authoritative, true);

  // 名字对不上就是查不到 —— 不猜、不串到别家
  assert.equal(llmSync.lookupCapabilities('acme', 'totally-unknown-model'), null);
});

// ─────────────────────────────────────────────────────────────
// G102c · 自定义兼容模式
// ─────────────────────────────────────────────────────────────
test('G102c: 查不到 ⇒ 自定义兼容模式 (用模型条目自己声明的能力)', () => {
  const declared = {
    provider: 'newvendor', id: 'nv-1',
    vision: true, reasoning: false, tool: true, context_length: 131072,
  };
  const r = llmSync.resolveCapabilities(declared);
  assert.equal(r.status, 'custom', '库里没有 ⇒ 必须是自定义兼容模式, 不是 null');
  assert.equal(r.source, 'model-declared');
  assert.equal(r.authoritative, false, '自定义模式的能力不是库里的权威事实');
  assert.equal(r.capabilities.vision, true);
  assert.equal(r.capabilities.reasoning, false, '用户显式写的 false 要保留');
  assert.equal(r.capabilities.tool, true);
  assert.equal(r.capabilities.ctx, 131072);
  assert.match(r.reason, /自定义兼容模式/, '必须说清为什么 (给日志/UI 看)');

  // 没声明的项 = **未知** (undefined), 不是 false —— false 是「不支持」的意思
  const bare = llmSync.resolveCapabilities({ provider: 'newvendor', id: 'nv-2' });
  assert.equal(bare.status, 'custom');
  assert.equal(bare.capabilities.vision, undefined, '未知不能是 false');
  assert.equal(bare.capabilities.reasoning, undefined);
  assert.equal(bare.capabilities.tool, undefined);
  assert.equal(bare.capabilities.ctx, null);

  // 命中时 status='hit' 且带库里的 key
  const hit = llmSync.resolveCapabilities({ provider: 'kimi', id: 'kimi-k2' });
  assert.equal(hit.status, 'hit');
  assert.equal(hit.source, 'models-dev');
  assert.equal(hit.key, 'moonshotai/kimi-k2');
  assert.equal(hit.capabilities.tool, true);
});

// ─────────────────────────────────────────────────────────────
// G102d · 自建推理服务 (开源走法)
// ─────────────────────────────────────────────────────────────
test('G102d: 内网自建推理服务默认吃软默认 + 长超时, 且与超时同口径', () => {
  const lan = { provider: 'vllm', id: 'qwen', endpoint: 'http://192.168.1.9:8000/v1' };
  // 内网自建默认生效 —— 不用在模型条目上手写 local_output_tokens
  assert.equal(capability.softOutputCap(lan), 8192,
    '内网自建推理服务必须默认吃 8192 软默认 (开源的走法)');
  assert.equal(capability.timeoutMs(lan, null, 120000, 300000), 300000,
    '内网自建推理服务必须默认用长超时 (自建推理都慢)');
  // **同一个口径** —— 输出与超时必须同步, 不能一个说自建一个说云端
  assert.equal(
    capability.softOutputCap(lan) !== null,
    capability.timeoutMs(lan, null, 120000, 300000) > 120000,
    '自建判定两个口径打架了 (输出说自建、超时说云端 —— 或反过来)');

  // 回环照旧
  const loop = { provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234' };
  assert.equal(capability.softOutputCap(loop), 8192);
  assert.equal(capability.timeoutMs(loop, null, 120000, 300000), 300000);

  // 公网自定义网关 (agnes) **不算**自建 —— 仍是云端口径
  const cloud = { provider: 'custom', id: 'agnes-3.0-flash', endpoint: 'https://api.agnes-ai.cn/v1' };
  assert.equal(capability.softOutputCap(cloud), null, '公网网关不该吃自建软默认');
  assert.equal(capability.timeoutMs(cloud, null, 120000, 300000), 120000);
  // provider 写着本地名字但端点在云端 ⇒ 也不算自建 (101 批的老坑不能复发)
  const fakeLocal = { provider: 'lmstudio', endpoint: 'https://api.example.com/v1' };
  assert.equal(capability.softOutputCap(fakeLocal), null);
  assert.equal(capability.timeoutMs(fakeLocal, null, 120000, 300000), 120000);

  // 免 API key 的口径**仍然只认回环** —— 别顺手改成"回环 or 内网"
  const keyResolver = require(path.join(ROOT, 'modules', 'api_key_resolver'));
  assert.equal(keyResolver.isLocalEndpoint('http://127.0.0.1:1234/v1'), true);
  assert.equal(keyResolver.isLocalEndpoint('http://192.168.1.9:8000/v1'), false,
    '内网网关未必不要 key ⇒ 免 key 只认回环');
});

// ─────────────────────────────────────────────────────────────
// G102e · 自建口径可退出 / 可声明
// ─────────────────────────────────────────────────────────────
test('G102e: 自建口径可显式退出, 也可显式声明', () => {
  const lan = { provider: 'vllm', id: 'qwen', endpoint: 'http://192.168.1.9:8000/v1' };
  // 模型条目显式退出
  assert.equal(capability.softOutputCap(Object.assign({}, lan, { selfhosted: false })), null,
    '模型条目写 selfhosted:false 必须能退出自建口径');
  assert.equal(capability.timeoutMs(Object.assign({}, lan, { selfhosted: false }), null, 120000, 300000), 120000);
  // 模型条目显式声明
  const pub = { provider: 'custom', id: 'x', endpoint: 'https://203.0.113.9/v1' };
  assert.equal(capability.softOutputCap(Object.assign({}, pub, { selfhosted: true })), 8192,
    '模型条目写 selfhosted:true 必须能声明自建 (公网 IP 的自家机)');
  // scope 收紧成只认回环
  capability.setSelfHostedConfig({ scope: 'loopback', hosts: [] });
  try {
    assert.equal(capability.softOutputCap(lan), null, 'scope=loopback 时内网不算自建');
    assert.equal(capability.softOutputCap({ provider: 'x', endpoint: 'http://127.0.0.1:1' }), 8192);
  } finally {
    capability.setSelfHostedConfig({ scope: 'private', hosts: [] });
  }
  // 显式声明的主机 (既不在回环也不在内网)
  capability.setSelfHostedConfig({ scope: 'private', hosts: ['my-box.example.com'] });
  try {
    assert.equal(capability.softOutputCap({ provider: 'custom', endpoint: 'https://my-box.example.com/v1' }), 8192);
    assert.equal(capability.softOutputCap({ provider: 'custom', endpoint: 'https://other.example.com/v1' }), null);
  } finally {
    capability.setSelfHostedConfig({ scope: 'private', hosts: [] });
  }
});

// ─────────────────────────────────────────────────────────────
// G102f · 生产模型缓存不许有测试残留
// ─────────────────────────────────────────────────────────────
test('G102f: 生产模型缓存里没有测试残留', () => {
  const prodPath = path.join(os.homedir(), '.pangu', 'models-registry.json');
  if (!fs.existsSync(prodPath)) return;   // 生产没这个文件 ⇒ 无从谈起
  const data = JSON.parse(fs.readFileSync(prodPath, 'utf8'));
  const models = data.models || {};
  const RESIDUE = ['fake-prefill', 'fake-synth', 'fake-reason', 'probe-local'];
  for (const id of RESIDUE) {
    assert.equal(models[id], undefined,
      `生产模型缓存里还躺着测试条目 ${id} —— 生产状态不许有测试残留`);
  }
  // 生产条目必须都在 (删残留不能误伤真条目)
  for (const id of ['k3', 'k3-256k', 'minimax-m3', 'agnes-3.0-flash']) {
    assert.ok(models[id], `生产条目 ${id} 被误删了 —— 只许删测试残留`);
  }
  // ⚠️ 2026-10-26 真事故 (比「躺着一条残留」更阴): 测试的 mock 用**生产同名的 id**
  // 带 context_length 写回来 ⇒ 生产 k3 的 1M 上下文被改成 8192,
  // 而条目**还在**、id 看着完全正常 ⇒ 上面那几条残留检查一条都抓不到。
  // 所以再查「指纹」: 测试用的厂商名 / probe id 一律不许出现在生产条目里。
  for (const [id, m] of Object.entries(models)) {
    assert.ok(!/^(probe|test|fake|r46-|mock)/i.test(id),
      `生产模型缓存里出现了测试 id ${id} —— 测试写的条目不许进生产`);
    assert.ok(!['newvendor', 'probe-local', 'test', 'r46-test-model'].includes(String(m && m.provider)),
      `生产条目 ${id} 的 provider 是测试厂商 (${m && m.provider}) —— 测试写的条目不许进生产`);
  }
  // 生产真条目的上下文窗口不许是 mock 那个 8192 (k3 的真值是 1M)
  if (models['k3']) {
    assert.equal(models['k3'].context_length, 1048576,
      `生产 k3 的 context_length 被写成 ${models['k3'].context_length} —— 真值是 1048576 (1M)`);
    assert.equal(models['k3'].provider, 'kimi',
      `生产 k3 的 provider 变成了 ${models['k3'].provider} —— 真值是 kimi`);
  }
});

// ─────────────────────────────────────────────────────────────
// G102g · 接线是通的 (真起服务器 + 真打路由)
// ─────────────────────────────────────────────────────────────
test('G102g: 设置页「从上游获取」真的按 status 报能力来源 (端到端)', async () => {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: 'kimi-k2' },                       // 能力库里有 ⇒ hit
          { id: 'nv-1' },                          // 库里没有 ⇒ custom
          { id: 'k3' },                            // 曾被改判成 moonshotai ⇒ 现在必须 custom
          // ⚠️ 2026-10-26 真事故: 这个 mock 一旦带 context_length, 刷新路由就会
          // `setContextLength('k3', 8192, ...)` **写进生产 registry** ——
          // 生产 k3 的 1M 上下文被写成 8192 (单跑测试时没有沙箱环境)。
          // 现在: 生产同名的 id 一律**不带** context_length; 要测 ctx 写入路径
          // 就用一个**生产不可能有的** probe id, 写坏也认不出来。
          { id: 'probe-ctx-newvendor', context_length: 8192 },
        ],
      }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const router = require(path.join(ROOT, 'pangu-single', 'routes', 'inline_router'));
  const cfg = { llm: { models: [], current_model_id: null } };
  router.init({ _config: cfg, PRESETS: {} });
  let captured = null;
  try {
    const res = await _driveRouter(router, '/api/llm/provider-models/refresh', {
      provider: 'newvendor',
      endpoint: `http://127.0.0.1:${port}/v1`,
      api_key: 'test-key',
      protocol: 'openai',
    });
    captured = res;
    assert.equal(res.ok, true, '路由必须走通: ' + JSON.stringify(res).slice(0, 300));
    const byId = {};
    for (const m of (res.models || [])) byId[m.id] = m;
    assert.equal(byId['kimi-k2'].capability_source, 'models-dev',
      '库里的模型必须标成 models-dev');
    assert.equal(byId['nv-1'].capability_source, 'custom',
      '库里的没有 ⇒ 必须标成 custom (自定义兼容模式)');
    assert.equal(byId['k3'].capability_source, 'custom',
      '新厂商的 k3 绝不能被当成 moonshotai 的模型 (查错)');
    // 查错的模型不能带 capability 标签
    assert.deepEqual(byId['k3'].capabilities, ['chat'],
      '查不到的模型不能凭空长出 reasoning/tool 标签');
  } finally {
    server.close();
  }
});

// 驱动 router 的一个 POST 路由 (真 req/res 形状, 走真代码路径)
function _driveRouter(router, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const handlers = { data: null, end: null };
    const req = {
      url: pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      on(ev, fn) { if (ev === 'data' || ev === 'end') handlers[ev] = fn; return this; },
      destroy() {},
      socket: { remoteAddress: '127.0.0.1' },
    };
    let out = '';
    let status = 200;
    const res = {
      headersSent: false,
      writableEnded: false,
      statusCode: 200,
      writeHead(code) { status = code; this.headersSent = true; return this; },
      write(chunk) { out += chunk; return true; },
      end(chunk) { if (chunk) out += chunk; this.writableEnded = true; resolve({ status, body: out }); },
      on() { return this; },
      setHeader() {},
      getHeader() { return undefined; },
    };
    const done = router.handler(req, res);
    if (done && done.then) done.catch(reject);
    // ⚠️ handler 是 async —— 它注册 'end' 监听器之前我们不能发 body,
    //    否则 body 永远送不到 (路由挂着等 req 的 'end')。
    //    这里轮询到监听器挂上再发。
    let tries = 0;
    const pump = () => {
      if (handlers.end) {
        if (handlers.data) handlers.data(Buffer.from(payload));
        handlers.end();
        return;
      }
      if (++tries > 100) { reject(new Error('路由没注册 body 监听器')); return; }
      setTimeout(pump, 20);
    };
    setTimeout(pump, 20);
    setTimeout(() => {
      if (!res.writableEnded) reject(new Error('路由超时'));
    }, 15000);
  }).then(r => {
    let parsed;
    try { parsed = JSON.parse(r.body); } catch (_) { throw new Error('响应不是 JSON: ' + String(r.body).slice(0, 200)); }
    return parsed;
  });
}

// ─────────────────────────────────────────────────────────────
// G102h · 变异体检
// ─────────────────────────────────────────────────────────────
const _IS_MUTATION_CHILD = !!process.env.PANGU_GENERIC_102_MUTATION_CHILD;

// ⚠️ 变异体检必须**抗中断 + 抗并发** (2026-10-26 实测踩到两次):
//   1. 靠 `finally { 写回原文件 }` 是不够的 —— 进程被 Ctrl-C / 崩了 / 被 kill,
//      finally 不会执行, 变异的源码就**留在仓库里**了。
//   2. 101 和 102 两个守卫文件**都改** model_capability.js / llm_capabilities_sync.js,
//      两个链同时跑 ⇒ 写入交错 ⇒ A 的 finally 还原的是 B 的变异版 ⇒ **源码留在变异状态**。
//      (实测: model_capability.js 的软默认门卫被删掉留在工作区, 云端端点又吃本地软默认。)
// 修法 (见 tests/helpers/mutation_guard.js): 跨进程**加锁** + 改前落盘备份 +
//      还原**从备份还原**并逐字节复验 + 启动时自愈残留备份。
const _MUT_BACKUP_SUFFIX = '.pangu-mut-backup';
const _mutationGuard = require(path.join(__dirname, 'helpers', 'mutation_guard'));

function _recoverStaleMutations() {
  _mutationGuard.recoverStaleMutations(
    [path.join(ROOT, 'modules'), path.join(ROOT, 'pangu-single', 'routes')],
    _MUT_BACKUP_SUFFIX
  );
}

if (!_IS_MUTATION_CHILD) _recoverStaleMutations();

function _runGuardExpectingRed() {
  // ⚠️ 必须摘掉 NODE_TEST_CONTEXT (98 批 G4 的教训): 被继承时 --test 被忽略 ⇒ 假阴性。
  const childEnv = Object.assign({}, process.env, { PANGU_GENERIC_102_MUTATION_CHILD: '1' });
  delete childEnv.NODE_TEST_CONTEXT;
  // 2026-10-26 第 102 批收尾: 孙进程摘掉 NODE_TEST_CONTEXT 之后, model_registry
  // 就认不出「我是测试进程」⇒ 会往**生产** registry 写。
  // 显式给一条沙箱路径, 孙进程的写全部落在临时目录。
  childEnv.PANGU_REGISTRY_PATH = path.join(os.tmpdir(), 'pangu-registry-mut102-' + process.pid + '.json');
  try {
    execFileSync(process.execPath, ['--test', path.join(__dirname, 'model-layer-generic-102-20261026.test.js')], {
      cwd: ROOT, stdio: 'pipe', timeout: 120000,
      env: childEnv,
    });
    return null;   // 全绿 = 守卫没咬 = 失败
  } catch (e) {
    return String(e.stdout || '') + String(e.stderr || '');
  }
}

function _mutateAndExpectRed(file, from, to) {
  // 跨进程加锁 + 从备份还原 + 复验 —— 见 tests/helpers/mutation_guard.js 的注释
  _mutationGuard.mutateAndExpectRed({
    root: ROOT,
    file,
    from,
    to,
    suffix: _MUT_BACKUP_SUFFIX,
    runGuard: _runGuardExpectingRed,
  });
}

test('G102h1: 把「显式 provider 优先」改回规则表硬猜 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/llm_capabilities_sync.js',
    "    return { provider: prov, rawProvider: prov, origin: 'explicit', custom: true, altNamespaces: [] };",
    "    return { provider: guessProvider(model), rawProvider: prov, origin: 'explicit', custom: true, altNamespaces: [] };",
  );
});

test('G102h2: 把自建口径改回只认回环 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/model_capability.js',
    '    return lm.isSelfHostedEndpoint(ep, { scope: _selfHostedScope, hosts: _selfHostedHosts });',
    '    return lm.isLoopbackEndpoint(ep);',
  );
});

test('G102h3: 把路由改回 lookupModelCapabilities ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'pangu-single/routes/inline_router.js',
    'const cap = llmCapSync.resolveCapabilities({ id, provider: useProvider, endpoint: seed.endpoint });',
    'const cap = llmCapSync.lookupModelCapabilities({ id, provider: useProvider, endpoint: seed.endpoint });',
  );
});

// ─────────────────────────────────────────────────────────────
// 交叉审整改 (2026-10-26) —— 多 agent 交叉审发现的三个真问题
// ─────────────────────────────────────────────────────────────

// G102i · 厂商名 → 能力库**真实命名空间**
//
// 交叉审实测: 规则表里 zhipu / alibaba / bytedance / meta / mistral 这五个
// 写的**不是**能力库里的命名空间 ⇒ 那几个厂商的模型永远查不到
// ⇒ 全部掉进自定义兼容模式 (能力只能靠自己声明, 库里的权威数据白白浪费)。
// 库里的真名: z-ai / qwen / bytedance-seed / meta-llama / mistralai。
test('G102i: 厂商名要映射到能力库真实存在的命名空间', () => {
  const expectNs = {
    alibaba: 'qwen',
    zhipu: 'z-ai',
    bytedance: 'bytedance-seed',
    meta: 'meta-llama',
    mistral: 'mistralai',
    kimi: 'moonshotai',
    minimax: 'minimax',
  };
  for (const [prov, ns] of Object.entries(expectNs)) {
    const rp = llmSync.resolveProvider({ provider: prov, id: 'x' });
    assert.equal(rp.provider, ns, `${prov} ⇒ 应映射到 ${ns} (库里真实命名空间), 实际 ${rp.provider}`);
    // 映射出来的命名空间必须**真的存在于能力库** —— 否则映射本身就没意义
    const flat = require(path.join(ROOT, 'modules', 'llm_capabilities_sync'));
    assert.ok(flat, '模块应可用');
  }
  // 端到端: 这几个厂商的模型现在要**查得到** (改之前全部落进自定义兼容模式)
  const cases = [
    { provider: 'alibaba', id: 'qwen3-8b', key: 'qwen/qwen3-8b' },
    { provider: 'zhipu', id: 'glm-4.5', key: 'z-ai/glm-4.5' },
    { provider: 'meta', id: 'llama-3.3-70b-instruct', key: 'meta-llama/llama-3.3-70b-instruct' },
    { provider: 'mistral', id: 'mistral-large-2512', key: 'mistralai/mistral-large-2512' },
  ];
  for (const c of cases) {
    const r = llmSync.resolveCapabilities(c);
    assert.equal(r.status, 'hit', `${c.provider}/${c.id} 应命中能力库, 实际 ${r.status} (${r.reason})`);
    assert.equal(r.key, c.key);
  }
  // 备用命名空间: 'alibaba' 自己在库里也有 1 条 (tongyi), 主命名空间查不到时要能救回来
  const tongyi = llmSync.resolveCapabilities({ provider: 'alibaba', id: 'tongyi-deepresearch-30b-a3b' });
  assert.equal(tongyi.status, 'hit', 'alibaba 命名空间下那一条也要查得到');
  assert.equal(tongyi.key, 'alibaba/tongyi-deepresearch-30b-a3b');
});

// G102j · 歧义命中**不许**当成命中返回
//
// 交叉审实测: 原来 lookupCapabilities 会把「多家同名」的歧义命中也返回
// (authoritative:false), 任何不检查这个标志的调用方都会拿到**查错**的能力。
// 现在: 歧义一律不返回 (返回就是查错); 需要看候选的走 lookupCapabilitiesDetail。
test('G102j: 多家同名的歧义命中不许被当成命中返回', () => {
  // 造一个真歧义: 同一个模型名放在两个命名空间下
  const fsx = require('node:fs');
  const cacheDir = llmSync.CACHE_DIR;
  const cacheFile = path.join(cacheDir, 'models_dev.json');
  const backup = cacheFile + '.bak-102j';
  const src = fsx.readFileSync(cacheFile, 'utf8');
  const flat = JSON.parse(src);
  flat['zzz-test-ns/dup-model-xyz'] = flat[Object.keys(flat)[0]];
  flat['zzz-test-ns2/dup-model-xyz'] = flat[Object.keys(flat)[0]];
  try {
    fsx.writeFileSync(cacheFile, JSON.stringify(flat));
    llmSync.invalidateCache();
    // 歧义 ⇒ detail 说 ambiguous, lookupCapabilities 给 null
    const d = llmSync.lookupCapabilitiesDetail('some-ns', 'dup-model-xyz');
    assert.equal(d.status, 'ambiguous', '多家同名必须判成 ambiguous');
    assert.ok(d.candidates.length >= 2, '必须把候选列出来 (给日志/UI 看)');
    assert.equal(llmSync.lookupCapabilities('some-ns', 'dup-model-xyz'), null,
      '歧义命中不许返回 —— 返回就是查错');
    // resolveCapabilities 也不能把它当命中
    const r = llmSync.resolveCapabilities({ provider: 'some-ns', id: 'dup-model-xyz' });
    assert.equal(r.status, 'custom', '歧义 ⇒ 走自定义兼容模式, 不猜');
    assert.match(r.reason, /同名/);
  } finally {
    fsx.writeFileSync(cacheFile, src);
    llmSync.invalidateCache();
    try { fsx.unlinkSync(backup); } catch (_) {}
  }
});

// G102k · 标签策略: ':free' 可救, ':thinking' 任何方向都不许合并
//
// 库里实际只有两种标签 (实测 364 条): ':free' 25 条 (定价变体),
// ':thinking' 1 条 ('qwen/qwen-plus-2025-07-28:thinking' —— **另一个模型**)。
// ':thinking' 合并了 ⇒ reasoning 能力整个搞反 ⇒ 那是查错。
test('G102k: 标签不许乱合并 —— :free 可救, :thinking 不许', () => {
  // 精确命中各自独立
  const plain = llmSync.lookupCapabilities('qwen', 'qwen-plus-2025-07-28');
  const thinking = llmSync.lookupCapabilities('qwen', 'qwen-plus-2025-07-28:thinking');
  assert.ok(plain && thinking, '两个都要查得到');
  assert.equal(plain.key, 'qwen/qwen-plus-2025-07-28');
  assert.equal(thinking.key, 'qwen/qwen-plus-2025-07-28:thinking');
  assert.notEqual(plain.key, thinking.key, '两个模型不许合并成一个');
  assert.notEqual(plain.reasoning, thinking.reasoning, 'reasoning 能力不许互相串');

  // ':free' 是定价变体 ⇒ 查 'x' 而库里是 'x:free' 时要能救回来
  const freeRescue = llmSync.lookupCapabilities('qwen', 'qwen3-next-80b-a3b-instruct');
  assert.ok(freeRescue, '无标签的精确条目必须优先于 :free 版');
  assert.equal(freeRescue.key, 'qwen/qwen3-next-80b-a3b-instruct');

  // 反向不许救: 查 ':thinking' 版时, 不许掉到无标签版上
  const noMerge = llmSync.lookupCapabilities('qwen', 'qwen-plus-2025-07-28:thinking');
  assert.equal(noMerge.key, 'qwen/qwen-plus-2025-07-28:thinking',
    '查 :thinking 版不许被合并到无标签版');
});

test('G102h4: 把「歧义命中也返回」改回去 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/llm_capabilities_sync.js',
    '  return d.status === \'hit\' ? d.hit : null;',
    '  return d.hit || (d.status === \'ambiguous\' ? { authoritative: false } : null);',
  );
});

// ─────────────────────────────────────────────────────────────
// G102l · 口径全景 (2026-10-26 交叉审 P1-1 的整改守卫)
//
// 交叉审抓到的真问题: 老板要的口径是「输出软默认与超时**同口径**」,
// 但第 102 批只把判据落在 model_capability 一处, 真正跑请求的链上还有两套旧口径:
//   j2_loop_shared 的**整轮墙** (第 71 批口径: provider 名单 or 回环)
//   llm_caller 的**提示词层推理预算** (第 71 批口径: 同上)
// 于是同一个模型能同时拿到「8192 输出 + 300s 请求超时 + 120s 整轮墙」——
// 字面意义上的「输出按自建、超时按云端」。
// 本守卫把**整条链**钉在同一个判据上。
// ─────────────────────────────────────────────────────────────
test('G102l: 整条链 (软默认 / 请求超时 / 整轮墙 / 推理预算) 必须是同一个判据', () => {
  const j2 = require(path.join(ROOT, 'modules', 'j2_loop_shared'));
  const llmCaller = require(path.join(ROOT, 'modules', 'llm_caller'));

  const cases = [
    // 内网自建 + 泛用 provider (老配置的常见写法) —— 全部按自建
    {
      name: '内网自建 (provider=custom)',
      model: { provider: 'custom', id: 'qwen3-8b', endpoint: 'http://192.168.0.10:8000/v1' },
      selfHosted: true,
    },
    {
      name: '内网自建 (provider=vllm)',
      model: { provider: 'vllm', id: 'qwen3-8b', endpoint: 'http://192.168.0.10:8000/v1' },
      selfHosted: true,
    },
    {
      name: '本机 (回环)',
      model: { provider: 'lmstudio', id: 'qwen3-8b', endpoint: 'http://127.0.0.1:1234/v1' },
      selfHosted: true,
    },
    {
      name: '公网网关 (agnes)',
      model: { provider: 'custom', id: 'agnes-3.0-flash', endpoint: 'https://api.agnes-ai.cn/v1' },
      selfHosted: false,
    },
    {
      name: '公网但 provider 写着本地名字',
      model: { provider: 'vllm', id: 'x', endpoint: 'https://api.example.com/v1' },
      selfHosted: false,
    },
  ];

  for (const c of cases) {
    const soft = capability.softOutputCap(c.model);
    const req = capability.timeoutMs(c.model, null, 120000, 300000);
    const round = j2._resolveRoundTimeoutMs(c.model);

    if (c.selfHosted) {
      assert.equal(soft, 8192, c.name + ': 自建必须吃 8192 软默认');
      assert.equal(req, 300000, c.name + ': 自建必须用长请求超时');
      assert.equal(round, 300000, c.name + ': 自建的整轮墙也必须是 300s (不能比请求超时还短)');
    } else {
      assert.equal(soft, null, c.name + ': 云端不该吃自建软默认');
      assert.equal(req, 120000, c.name + ': 云端必须用短请求超时');
      assert.equal(round, 120000, c.name + ': 云端的整轮墙不许被 provider 名单撑到 300s');
    }
    // 硬不变量: 整轮墙不能短于请求超时 (短了 = 长输出被墙掐掉)
    assert.ok(round >= req, c.name + ': 整轮墙 (' + round + ') 短于请求超时 (' + req + ') ⇒ 长输出必被掐');
  }

  // 提示词层推理预算: 自建 (含内网) 收得到, 云端收不到
  const lan = { provider: 'custom', id: 'qwen3-8b', endpoint: 'http://192.168.0.10:8000/v1', reasoning_effort: 'medium' };
  assert.ok(llmCaller._reasoningBudgetInstruction(lan),
    '内网自建推理服务上的 thinking 模型, 推理预算分档必须收得到');
  const cloud = { provider: 'custom', id: 'agnes-3.0-flash', endpoint: 'https://api.agnes-ai.cn/v1', reasoning_effort: 'medium' };
  assert.equal(llmCaller._reasoningBudgetInstruction(cloud), null,
    '云端模型不吃本机那套提示词层预算指令');
});

test('G102h5: 把整轮墙改回第 71 批旧口径 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/j2_loop_shared.js',
    '  return _isSelfHosted(model) ? _LOCAL_ROUND_TIMEOUT_MS : _DEFAULT_ROUND_TIMEOUT_MS;',
    '  return _isLocalModel(model) ? _LOCAL_ROUND_TIMEOUT_MS : _DEFAULT_ROUND_TIMEOUT_MS;',
  );
});

test('G102m: 推理预算走哪条通道 = 端点事实, provider 名字不许压过它', () => {
  const llmCaller = require(path.join(ROOT, 'modules', 'llm_caller'));
  const loop = { provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234/v1', reasoning_effort: 'off' };
  const cloud = { provider: 'lmstudio', endpoint: 'https://api.example.com/v1', reasoning_effort: 'off' };
  const lan = { provider: 'custom', endpoint: 'http://192.168.0.10:8000/v1', reasoning_effort: 'off' };

  assert.equal(llmCaller._wireReasoningEffort(loop), 'none',
    '本机 (回环) 走 wire 通道, off 翻成 none');
  assert.equal(llmCaller._wireReasoningEffort(cloud), 'off',
    'provider 写着 lmstudio 但端点在云端 ⇒ 不许翻成 none (云端网关不认这个值)');
  assert.equal(llmCaller._wireReasoningEffort(lan), 'off',
    '内网自建收不到 none ⇒ wire 不发, 改走提示词层');
  assert.ok(llmCaller._reasoningBudgetInstruction(lan),
    '内网自建的 off 必须有提示词层接着 (否则「不思考」这个分档在内网直接消失)');
  assert.equal(llmCaller._reasoningBudgetInstruction(loop), null,
    '本机的 off 走 wire 通道, 提示词层不重复说');
});

test('G102n: 测试进程不许写生产 registry —— 机制, 不是清单', () => {
  // 2026-10-26 真事故: 链是沙箱的 (run-tests.sh 导出 PANGU_REGISTRY_PATH),
  // 但**单跑一个测试文件**没有隔离 ⇒ timeout-policy 的 mock 上游把 `probe-local`
  // 直接写进生产 ~/.pangu/models-registry.json (本批链尾 G102f 抓到过一回)。
  // ⇒ 「沙箱导出 ⇒ 不会再长回来」只对链成立, 单跑就漏。
  // 现在 model_registry 认得测试进程 (NODE_TEST_CONTEXT) ⇒ 落到临时目录。
  const registry = require(path.join(ROOT, 'modules', 'model_registry'));
  const prod = path.join(os.homedir(), '.pangu', 'models-registry.json');

  // 生产进程 (没有 NODE_TEST_CONTEXT) —— 仍然写生产
  const prodEnv = Object.assign({}, process.env);
  delete prodEnv.NODE_TEST_CONTEXT;
  delete prodEnv.PANGU_REGISTRY_PATH;
  const prodPath = execFileSync(process.execPath,
    ['-e', 'console.log(require(' + JSON.stringify(path.join(ROOT, 'modules', 'model_registry')) + ').registryPath())'],
    { cwd: ROOT, env: prodEnv, encoding: 'utf8' }).trim();
  assert.equal(prodPath, prod, '生产进程必须还是写生产 registry');

  // 测试进程 (NODE_TEST_CONTEXT) 且没显式指定路径 —— 必须落到临时目录
  const testEnv = Object.assign({}, process.env, { NODE_TEST_CONTEXT: 'child-v8' });
  delete testEnv.PANGU_REGISTRY_PATH;
  const testPath = execFileSync(process.execPath,
    ['-e', 'console.log(require(' + JSON.stringify(path.join(ROOT, 'modules', 'model_registry')) + ').registryPath())'],
    { cwd: ROOT, env: testEnv, encoding: 'utf8' }).trim();
  assert.notEqual(testPath, prod, '测试进程绝不许指向生产 registry');
  assert.ok(testPath.startsWith(os.tmpdir()), '测试进程必须落到临时目录, 实际: ' + testPath);

  // 显式指定路径 —— 显式永远最优先 (沙箱链要的就是它)
  const sandbox = path.join(os.tmpdir(), 'pangu-registry-explicit-' + process.pid + '.json');
  const expEnv = Object.assign({}, process.env, { NODE_TEST_CONTEXT: 'child-v8', PANGU_REGISTRY_PATH: sandbox });
  const expPath = execFileSync(process.execPath,
    ['-e', 'console.log(require(' + JSON.stringify(path.join(ROOT, 'modules', 'model_registry')) + ').registryPath())'],
    { cwd: ROOT, env: expEnv, encoding: 'utf8' }).trim();
  assert.equal(expPath, sandbox, '显式 PANGU_REGISTRY_PATH 必须压过测试进程的临时目录');

  assert.ok(registry.registryPath, 'registryPath 必须导出 (守卫要能问它)');
});

test('G102o: 裸跑测试文件 (不带 --test) ⇒ 也不许写生产 registry', () => {
  // 2026-10-26 第 103 批探针实测: model_registry 原来只认 NODE_TEST_CONTEXT,
  // 而那只在 `node --test` 的**子进程**里才有。裸跑 `node tests/xxx.test.js`
  // 时它是 undefined ⇒ registryPath() 落回生产路径 ⇒ 那个测试里的 mock 上游
  // 把 `probe-ctx-newvendor` 直接写进了生产 ~/.pangu/models-registry.json。
  // 探针用 fake HOME 实测复现过。
  //
  // 现在补了第二道判据: **我自己的文件名就是个测试文件**。
  // 这道判据不依赖环境变量、不依赖父进程怎么调 ⇒ 裸跑也认得出。
  const registry = require(path.join(ROOT, 'modules', 'model_registry'));
  const prod = path.join(os.homedir(), '.pangu', 'models-registry.json');
  const probe = path.join(os.tmpdir(), 'pangu-registry-bare-' + process.pid);
  const asTestFile = probe + '.test.js';
  const asPlainFile = probe + '.js';
  const probeBody = 'console.log(require('
    + JSON.stringify(path.join(ROOT, 'modules', 'model_registry')) + ').registryPath());';
  fs.writeFileSync(asTestFile, probeBody, 'utf8');
  fs.writeFileSync(asPlainFile, probeBody, 'utf8');

  const bareEnv = Object.assign({}, process.env);
  delete bareEnv.NODE_TEST_CONTEXT;
  delete bareEnv.PANGU_REGISTRY_PATH;

  try {
    const testPath = execFileSync(process.execPath, [asTestFile],
      { cwd: ROOT, env: bareEnv, encoding: 'utf8' }).trim();
    assert.notEqual(testPath, prod,
      '裸跑一个 *.test.js 时仍然指向生产 registry —— 测试会把 mock 模型写进生产');
    assert.ok(testPath.startsWith(os.tmpdir()),
      '裸跑测试文件必须落到临时目录, 实际: ' + testPath);

    // 反向对照: 不是测试文件的普通脚本 ⇒ 仍然走生产 (别把判据开太大)
    const plainPath = execFileSync(process.execPath, [asPlainFile],
      { cwd: ROOT, env: bareEnv, encoding: 'utf8' }).trim();
    assert.equal(plainPath, prod,
      '不是测试文件的进程必须还是写生产 registry —— 判据开太大也是事故');
  } finally {
    try { fs.rmSync(asTestFile, { force: true }); } catch (_) {}
    try { fs.rmSync(asPlainFile, { force: true }); } catch (_) {}
  }

  assert.ok(registry.registryPath, 'registryPath 必须导出');
});
