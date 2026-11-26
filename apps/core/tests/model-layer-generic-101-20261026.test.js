'use strict';
// 第 101 批: 模型层通用性守卫 (第三轮) —— 通用型收口
//
// 老板原话: 「不要局限到个别云端或者本地, 应该是通用型的」。
// 98/99 批把厂商怪癖收进了档案层, 但**还有五处**按品牌名/按名字判能力的地方 ——
// 换厂商 / 换本地运行时就得改代码, 这不叫通用型:
//   ① model_capability  · 本地软默认按 provider 名建档 (lmstudio/ollama/vllm/llamacpp)
//      ⇒ 档案还排在端点事实**前面** ⇒ provider 写着本地名字但端点在云端时,
//        输出预算按本地 8192 算、超时按云端 120s 算 ⇒ 同一模型两个口径。
//   ② media_gen         · key 只认 minimax + MINIMAX_API_KEY (新厂商查不到 key)
//   ③ media_gen         · 协议只认 minimax / comfyui 两个 if (新厂商判错协议)
//   ④ model_probe       · L2 原生探针是两个各写各的函数 (加运行时 = 复制一遍)
//   ⑤ llm_capabilities_sync · guessProvider 16 个硬编 if (加厂商 = 改代码)
//   ⑥ provider_detect   · 按域名后缀判本地 (host.ollama.ai 是**云端**, 却判成本地)
//      ⇒ 与 model_transport.protocolOf 判成两套协议 (同一端点两个答案)。
//
// 本守卫要证明:
//   G101a · 六个文件里没有按品牌名的分支 (双向匹配; 数据表不算违规)
//   G101b · 本地软默认按**端点事实** (换本地运行时 = 0 改代码)
//   G101c · 协议判定只有一个口径 (按 URL 形状, 不按域名后缀)
//   G101d · 原生探针是**策略表** (加运行时 = 加一行)
//   G101e · 厂商猜测是**规则表** (加厂商 = 加一行)
//   G101f · 多模态新厂商**端到端**跑通 (真发请求, 数请求数)
//   G101g · 变异体检: 把这几处改回品牌硬判 ⇒ 守卫必须**真**报红

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const capability = require(path.join(ROOT, 'modules', 'model_capability'));
const providerDetect = require(path.join(ROOT, 'modules', 'provider_detect'));
const llmSync = require(path.join(ROOT, 'modules', 'llm_capabilities_sync'));
const probe = require(path.join(ROOT, 'modules', 'model_probe'));

// ─────────────────────────────────────────────────────────────
// G101a · 品牌扫描 (双向; 数据表里的品牌名不算违规)
// ─────────────────────────────────────────────────────────────
test('G101a: 模型层六个文件里没有按品牌名的分支', () => {
  // ⚠️ 必须**双向**匹配 (99 批 G9 的教训: 只做正向漏过一次真违规):
  //   正向: provider 在前  —— `if (m.provider === 'x')`
  //   反向: 品牌在前      —— `['minimax','kimi'].includes(m.provider)`
  const BRANDS = 'kimi|minimax|agnes|lmstudio|lm-studio|ollama|vllm|llamacpp|comfyui|deepseek|zhipu|qwen';
  const CMP_FWD = new RegExp(`provider\\s*(===|!==|==|!=)\\s*['"](${BRANDS})['"]`);
  const CMP_REV = new RegExp(`['"](${BRANDS})['"]\\s*(===|!==|==|!=)\\s*[^;\\n]{0,60}\\bprovider\\b`);
  const IN_COND = new RegExp(`\\b(if|else\\s+if|switch|case|while)\\s*\\(?[^;\\n]{0,60}['"](${BRANDS})['"]`);
  const IN_LIST = new RegExp(`\\[[^\\]\\n]{0,120}['"](${BRANDS})['"][^\\]\\n]{0,120}\\]`);

  const FILES = [
    'modules/model_capability.js',
    'modules/provider_detect.js',
    'modules/llm_capabilities_sync.js',
    'modules/model_probe.js',
    'modules/tools/media_gen.js',
  ];
  const bad = [];
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      const t = line.trim();
      // 注释不算 (注释里的品牌名是说明, 不是判定)
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#')) return;
      // 数据表行 (形如 `{ provider: 'x', ... }` / `minimax: 'minimax'`) 是**档案**, 不是分支
      const isDataRow = /^[\[{]/.test(t) && !/===|!==|==|!=/.test(t);
      if (isDataRow) return;
      if (CMP_FWD.test(t) || CMP_REV.test(t) || IN_COND.test(t) || IN_LIST.test(t)) {
        bad.push(`${f}:${i + 1}: ${t.slice(0, 100)}`);
      }
    });
  }
  assert.deepEqual(bad, [], '还有按品牌名的分支:\n' + bad.join('\n'));
});

test('G101a2: 内置档案表仍是数据 (加厂商 = 加一行, 不是加分支)', () => {
  // 档案层允许品牌名 —— 但必须是**表**, 且能用配置覆盖。
  assert.ok(Array.isArray(llmSync.DEFAULT_PROVIDER_GUESS_RULES), '厂商猜测规则必须是表');
  assert.ok(llmSync.DEFAULT_PROVIDER_GUESS_RULES.length >= 16, '内置规则表不该少于 16 条');
  assert.ok(Array.isArray(capability.VENDOR_PROFILES), '厂商档案必须是表');
});

// ─────────────────────────────────────────────────────────────
// G101b · 本地软默认按端点事实
// ─────────────────────────────────────────────────────────────
test('G101b: 本地软默认看端点事实, 不看 provider 名字 (换本地运行时 = 0 改代码)', () => {
  // 任何回环端点都自动吃到本地软默认 —— provider 叫什么无所谓。
  assert.equal(capability.softOutputCap({ provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234' }), 8192);
  assert.equal(capability.softOutputCap({ provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }), 8192);
  assert.equal(capability.softOutputCap({ provider: 'brand-new-runtime', endpoint: 'http://127.0.0.1:9999/v1' }), 8192);
  assert.equal(capability.softOutputCap({ provider: 'custom', endpoint: 'http://[::1]:1234/v1' }), 8192);
  // provider 写着本地名字, 端点在云端 ⇒ **不吃**本地软默认 (这正是两口径的病根)
  assert.equal(capability.softOutputCap({ provider: 'lmstudio', endpoint: 'https://api.example.com/v1' }), null);
  assert.equal(capability.softOutputCap({ provider: 'ollama', endpoint: 'https://host.ollama.ai/v1' }), null);
  // 输出预算与超时必须**同一个口径** (本地软默认 <=> 本地超时)
  const localModel = { provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234' };
  const cloudModel = { provider: 'lmstudio', endpoint: 'https://api.example.com/v1' };
  assert.equal(capability.softOutputCap(localModel) !== null, capability.timeoutMs(localModel, null, 60000, 300000) > 60000,
    '本地判定两个口径打架了 (输出预算说本地, 超时说云端 —— 或反过来)');
  assert.equal(capability.softOutputCap(cloudModel) !== null, capability.timeoutMs(cloudModel, null, 60000, 300000) > 60000,
    '本地判定两个口径打架了 (输出预算说云端, 超时说本地 —— 或反过来)');
  // 云端端点的输出预算不能被本地 8192 砍掉
  assert.equal(capability.maxOutputTokens(cloudModel, 32768), 32768);
  // 用户显式声明仍然最大
  assert.equal(capability.softOutputCap({ provider: 'x', endpoint: 'http://127.0.0.1:1', local_output_tokens: 1234 }), 1234);
});

test('G101b2: 配置里不再有「本地运行时品牌」档案', () => {
  // 节点配置由 config/node_config.js 解析: 真配置不在(别人的机器/CI)时
  // 退回脱敏示例 —— 不然这条守卫在全新 clone 上会「文件不存在」假红。
  const cfgFiles = new Set([
    require(path.join(ROOT, 'config', 'node_config')).resolveNodeConfigPathOrExample(),
    path.join(ROOT, 'config', 'nodes', 'example-node.json'),
  ]);
  for (const cfgPath of cfgFiles) {
    if (!fs.existsSync(cfgPath)) continue;
    const cfgFile = path.basename(cfgPath);
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'nodes', cfgFile), 'utf8'));
    const profiles = (cfg.llm && cfg.llm.vendor_profiles) || [];
    const LOCAL_BRAND = new Set(['lmstudio', 'ollama', 'vllm', 'llamacpp']);
    for (const p of profiles) {
      if (!p || !LOCAL_BRAND.has(String(p.provider || '').toLowerCase())) continue;
      assert.equal(p.local_output_tokens, undefined,
        `${cfgFile}: ${p.provider} 是本地运行时品牌名 —— 本地软默认应由端点事实推导, 不该按品牌写在配置里`);
    }
    // 有硬上限的必须有 match_id (网关转发时上限不能丢)
    for (const p of profiles) {
      if (!p || typeof p.max_output_tokens !== 'number') continue;
      assert.ok(p.match_id, `${cfgFile}: ${p.provider} 有硬上限却没写 match_id`);
    }
  }
});

// ─────────────────────────────────────────────────────────────
// G101c · 协议判定只有一个口径
// ─────────────────────────────────────────────────────────────
test('G101c: 端点形状决定协议 (与 model_transport 一个口径)', () => {
  const d = (e) => providerDetect.detectProvider({ endpoint: e });
  // 原生运行时: 端口 或 路径特征 —— 带 /v1 的标准写法也要认出来
  assert.equal(d('http://127.0.0.1:1234').provider, 'lmstudio');
  assert.equal(d('http://127.0.0.1:1234/v1').provider, 'lmstudio', '带 /v1 的 LM Studio 端点必须认得出来');
  assert.equal(d('http://127.0.0.1:11434').provider, 'ollama');
  assert.equal(d('http://127.0.0.1:11434/v1').provider, 'ollama', '带 /v1 的 Ollama 端点必须认得出来');
  assert.equal(d('http://192.168.1.50:1234/v1').provider, 'lmstudio', '内网运行时按端口认');
  // 云端 Ollama **不是**本地 (旧实现按域名后缀 endsWith(ollama.ai) 判成本地)
  assert.equal(d('https://host.ollama.ai/v1').provider, 'openai-compatible');
  // 未知端口的回环 ⇒ local
  assert.equal(d('http://127.0.0.1:8080/v1').provider, 'local');
  // Anthropic 族判定保留
  assert.equal(d('https://api.anthropic.com/v1').provider, 'anthropic');
  assert.equal(d('https://api.anthropic.com/v1/messages').provider, 'anthropic');
  // 兜底
  assert.equal(d('https://gw.example.com/v1').provider, 'openai-compatible');
  assert.equal(d('').provider, 'unknown');
});

// ─────────────────────────────────────────────────────────────
// G101d · 原生探针是策略表
// ─────────────────────────────────────────────────────────────
test('G101d: L2 原生探针由策略表驱动 (加运行时 = 加一行)', () => {
  assert.ok(probe.L2_RUNTIME_PROBES && typeof probe.L2_RUNTIME_PROBES === 'object', 'L2 必须有策略表');
  const names = Object.keys(probe.L2_RUNTIME_PROBES);
  assert.ok(names.length >= 2, '策略表至少要有 ollama / lmstudio 两条');
  for (const n of names) {
    const s = probe.L2_RUNTIME_PROBES[n];
    assert.equal(s.runtime, n, `策略表 ${n} 的 runtime 字段要对得上`);
    assert.equal(typeof s.probe, 'function', `策略表 ${n} 缺 probe 实现`);
    // 表里每一条都必须被注册成探针 (否则加了一行也不生效)
    assert.ok(probe.listProbes().some(p => p.name === 'L2-' + n), `策略表里的 ${n} 没注册成探针`);
  }
  // 兼容导出不能丢 (tests/model-probe-compat.test.js 依赖)
  assert.equal(typeof probe._probeL2LMStudio, 'function');
  assert.equal(typeof probe._probeL2Ollama, 'function');
});

test('G101d2: L2 探针有门卫 (不是本地运行时就不该发请求)', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits += 1; res.writeHead(200); res.end('{}'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    // 随机端口 + 无 LM Studio 特征 ⇒ 不该触发探针
    const r = await probe._probeL2LMStudio({ id: 'x', endpoint: `http://127.0.0.1:${port}/v1` });
    assert.equal(r, null, '不是 LM Studio 端点就不该返回 ctx');
    assert.equal(hits, 0, `门卫失效了: 不该发的请求发了 ${hits} 次`);
  } finally {
    server.close();
  }
});

// ─────────────────────────────────────────────────────────────
// G101e · 厂商猜测是规则表
// ─────────────────────────────────────────────────────────────
test('G101e: 厂商猜测走规则表 (加厂商 = 加一行, 不用改代码)', () => {
  // 内置表的关键映射必须保持 (返回值是**能力库里真实存在的命名空间**, 改了查不到能力库)
  //
  // ⚠️ 2026-10-26 交叉审改的: 原来这里钉的是 'alibaba' / 'meta' ——
  //    但能力库里根本没这两个命名空间 (库里叫 'qwen' 47 条 / 'meta-llama' 14 条;
  //    'alibaba' / 'bytedance' 各只有 1 条)。
  //    钉错的代价: 那两个厂商的模型**永远查不到** ⇒ 全掉进自定义兼容模式。
  assert.equal(llmSync.guessProvider({ provider: 'kimi', id: 'k3' }), 'moonshotai');
  assert.equal(llmSync.guessProvider({ provider: 'minimax', id: 'minimax-m3' }), 'minimax');
  assert.equal(llmSync.guessProvider({ id: 'qwen3.8-27b' }), 'qwen');
  assert.equal(llmSync.guessProvider({ id: 'llama-3.3-70b' }), 'meta-llama');
  assert.equal(llmSync.guessProvider({ provider: 'zhipu', id: 'glm-4.5' }), 'z-ai');
  assert.equal(llmSync.guessProvider({ provider: 'mistral', id: 'mistral-large-2512' }), 'mistralai');
  assert.equal(llmSync.guessProvider({ id: 'some-unknown-model', endpoint: 'http://127.0.0.1:1234/v1' }), null);
  // 配置注入: 加一个厂商 = 加一行
  llmSync.setProviderGuessRules([
    { provider: 'newvendor', prov: 'newvendor', ep: '/newvendor/', id: 'nv-' },
  ]);
  try {
    assert.equal(llmSync.guessProvider({ provider: 'newvendor', id: 'nv-1' }), 'newvendor');
    assert.equal(llmSync.guessProvider({ endpoint: 'https://api.newvendor.com/v1', id: 'x' }), 'newvendor');
    // 注入规则是**叠加**在内置表之前, 不是替换 —— 加一个厂商不该弄丢其余 16 条
    assert.equal(llmSync.guessProvider({ provider: 'kimi', id: 'k3' }), 'moonshotai');
    assert.equal(llmSync.guessProvider({ id: 'qwen3.8-27b' }), 'qwen');
    assert.equal(llmSync.guessProvider({ id: 'llama-3.3-70b' }), 'meta-llama');
    // 配置规则**排在内置表之前** ⇒ 用户改判据, 内置的让位
    llmSync.setProviderGuessRules([{ provider: 'myco', prov: 'kimi' }]);
    assert.equal(llmSync.guessProvider({ provider: 'kimi', id: 'k3' }), 'myco',
      '配置规则必须先于内置表生效 (用户的最新事实压过内置)');
  } finally {
    llmSync.setProviderGuessRules(null);
  }
  // 还原后回到内置表
  assert.equal(llmSync.guessProvider({ provider: 'newvendor', id: 'nv-1' }), null);
});

// ─────────────────────────────────────────────────────────────
// G101f · 多模态新厂商端到端 (真发请求, 数请求数)
// ─────────────────────────────────────────────────────────────
function _loadMediaGen(configPath) {
  const prev = process.env.PANGU_MEDIA_CONFIG;
  process.env.PANGU_MEDIA_CONFIG = configPath;
  const p = require.resolve(path.join(ROOT, 'modules', 'tools', 'media_gen'));
  delete require.cache[p];
  const mod = require(p);
  delete require.cache[p];
  if (prev === undefined) delete process.env.PANGU_MEDIA_CONFIG;
  else process.env.PANGU_MEDIA_CONFIG = prev;
  return mod;
}

function _startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('G101f: 多模态新厂商端到端跑通 (协议 + key 都从通用链来)', async () => {
  const requests = [];
  const server = await _startServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      requests.push({
        path: req.url,
        auth: req.headers.authorization,
        body: (Buffer.concat(chunks).toString('utf8') || '{}'),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      // minimax 私有协议: data.image_base64
      res.end(JSON.stringify({ data: { image_base64: [Buffer.from('fake-png-bytes').toString('base64')] } }));
    });
  });
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-101-media-'));
  const cfgPath = path.join(tmp, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    llm: {
      models: [{
        id: 'acme-img',
        provider: 'acme',
        capabilities: ['image'],
        endpoint: `http://127.0.0.1:${port}/v1`,
        enabled: true,
      }],
      // 通用型关键: 协议家族由**配置提示表**决定, 代码里没有 acme 这个名字
      media_protocol_hints: { acme: 'minimax' },
    },
  }), 'utf8');

  const prevKey = process.env.ACME_API_KEY;
  process.env.ACME_API_KEY = 'acme-secret-key-0001';
  const prevEndpointEnv = process.env.PANGU_MEDIA_IMAGE_ENDPOINT;
  delete process.env.PANGU_MEDIA_IMAGE_ENDPOINT;
  const mediaGen = _loadMediaGen(cfgPath);
  try {
    const res = await mediaGen({
      params: { modality: 'image', prompt: 'a red fox', model_id: 'acme-img', output_dir: tmp },
    });
    assert.equal(res.ok, true, '新厂商多模态必须能跑通: ' + JSON.stringify(res.error || {}));
    assert.equal(requests.length, 1, `必须真发一次请求 (实发 ${requests.length} 次)`);
    // 协议家族来自配置提示表 ⇒ 走 minimax 私有协议的路径与报文
    assert.equal(requests[0].path, '/v1/image_generation',
      `协议没按配置提示表选对 (实际路径 ${requests[0].path}) —— 默认应是 openai 的 /v1/images/generations`);
    const body = JSON.parse(requests[0].body);
    assert.equal(body.response_format, 'base64', '报文体不是 minimax 家族形状 ⇒ 协议判错了');
    // key 来自共享解析链的**命名约定** (<PROVIDER>_API_KEY), 不是写死 minimax
    assert.equal(requests[0].auth, 'Bearer acme-secret-key-0001',
      'key 没走共享解析链 (新厂商查不到 key)');
    // 落盘
    assert.equal(res.data.count, 1);
    assert.equal(res.data.protocol, 'minimax');
    assert.ok(fs.existsSync(res.data.files[0]), '产物必须真的落盘');
  } finally {
    if (prevKey === undefined) delete process.env.ACME_API_KEY; else process.env.ACME_API_KEY = prevKey;
    if (prevEndpointEnv !== undefined) process.env.PANGU_MEDIA_IMAGE_ENDPOINT = prevEndpointEnv;
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('G101f2: 没有提示表的新厂商落到默认协议 (openai 兼容)', async () => {
  const requests = [];
  const server = await _startServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      requests.push({ path: req.url, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('fake').toString('base64') }] }));
    });
  });
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-101-media2-'));
  const cfgPath = path.join(tmp, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    llm: {
      models: [{
        id: 'acme-img2', provider: 'acme2', capabilities: ['image'],
        endpoint: `http://127.0.0.1:${port}/v1`, enabled: true,
      }],
    },
  }), 'utf8');
  const mediaGen = _loadMediaGen(cfgPath);
  const prevKey2 = process.env.ACME2_API_KEY;
  process.env.ACME2_API_KEY = 'acme2-secret-key-002';
  try {
    const res = await mediaGen({
      params: { modality: 'image', prompt: 'a blue whale', model_id: 'acme-img2', output_dir: tmp },
    });
    assert.equal(res.ok, true, '默认协议也要能跑: ' + JSON.stringify(res.error || {}));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/v1/images/generations', '默认协议应是 openai 兼容');
    const body = JSON.parse(requests[0].body);
    assert.ok(body.size && body.n, 'openai 家族报文体不对');
  } finally {
    if (prevKey2 === undefined) delete process.env.ACME2_API_KEY; else process.env.ACME2_API_KEY = prevKey2;
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────
// G101h · 测试不许污染生产模型缓存
// ─────────────────────────────────────────────────────────────
test('G101h: 沙箱把模型上下文缓存也导走了 (测试条目不许进生产)', () => {
  // 2026-10-26 实测: 链里三个测试 (stream-prefill-budget /
  // stream-reasoning-not-content / synthesis-stream-idle) 直接写进了**生产**
  // ~/.pangu/models-registry.json —— 生产模型层里至今躺着 fake-prefill /
  // fake-synth / fake-reason / probe-local 这些测试条目。
  // 根因: modules/model_registry.js 认专用开关 PANGU_REGISTRY_PATH,
  // 但 bin/run-tests.sh 的沙箱只导了 8 个状态目录, 漏了它。
  const sh = fs.readFileSync(path.join(ROOT, 'bin', 'run-tests.sh'), 'utf8');
  assert.match(sh, /export\s+PANGU_REGISTRY_PATH=/,
    '沙箱必须导出 PANGU_REGISTRY_PATH —— 否则链里的测试把测试条目写进生产模型缓存');
  assert.match(sh, /models-registry\.json/,
    '沙箱必须给模型缓存准备落点');
  // 开关必须指向沙箱 (不能是生产路径)
  const m = sh.match(/export\s+PANGU_REGISTRY_PATH="([^"]+)"/);
  assert.ok(m, 'PANGU_REGISTRY_PATH 的值没找到');
  assert.match(m[1], /SANDBOX/, 'PANGU_REGISTRY_PATH 必须落在沙箱目录里, 不能指向生产');
  // 行为: 带开关跑一个曾经泄漏的测试, 生产文件必须原封不动
  const prodPath = path.join(os.homedir(), '.pangu', 'models-registry.json');
  if (!fs.existsSync(prodPath)) return;   // 生产没这个文件 ⇒ 无从污染
  const before = fs.readFileSync(prodPath, 'utf8');
  const tmpReg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-101-reg-')), 'models-registry.json');
  fs.writeFileSync(tmpReg, before, 'utf8');
  const childEnv = Object.assign({}, process.env, { PANGU_REGISTRY_PATH: tmpReg });
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    execFileSync(process.execPath, ['--test', path.join(__dirname, 'stream-prefill-budget-20261016.test.js')], {
      cwd: ROOT, stdio: 'pipe', timeout: 60000, env: childEnv,
    });
  } catch (_) { /* 该测试本身失败不影响本断言 —— 只看生产文件有没有被动 */ }
  const after = fs.readFileSync(prodPath, 'utf8');
  assert.equal(after, before, '生产模型缓存被测试改了 —— 沙箱开关没生效');
});

// ─────────────────────────────────────────────────────────────
// G101g · 变异体检 —— 改回品牌硬判, 守卫必须**真**报红
// ─────────────────────────────────────────────────────────────
const _IS_MUTATION_CHILD = !!process.env.PANGU_GENERIC_101_MUTATION_CHILD;
// 变异守卫的共享实现 (跨进程加锁 + 从备份还原 + 复验)。
// 后缀与 102 守卫**故意不同**: 两个守卫文件改同一批源码, 备份文件不能互相认领。
const _MUT_BACKUP_SUFFIX = '.pangu-mut-backup-101';
const _mutationGuard = require(path.join(__dirname, 'helpers', 'mutation_guard'));

function _runGuardExpectingRed() {
  // ⚠️ 必须摘掉 NODE_TEST_CONTEXT (98 批 G4 的教训):
  // Node 的 test runner 给子进程设 NODE_TEST_CONTEXT=child-v8, 被继承到孙进程时,
  // 孙进程认为"我已经在 test runner 里" ⇒ --test 被忽略 ⇒ 根本不跑测试
  // ⇒ 静默 exit 0 ⇒ 守卫看起来"没报红"。这是假阴性最隐蔽的一种。
  const childEnv = Object.assign({}, process.env, { PANGU_GENERIC_101_MUTATION_CHILD: '1' });
  delete childEnv.NODE_TEST_CONTEXT;
  // 2026-10-26 第 102 批收尾: 孙进程摘掉 NODE_TEST_CONTEXT 之后, model_registry
  // 就认不出「我是测试进程」⇒ 会往**生产** registry 写。
  // 显式给一条沙箱路径, 孙进程的写全部落在临时目录。
  childEnv.PANGU_REGISTRY_PATH = path.join(os.tmpdir(), 'pangu-registry-mut101-' + process.pid + '.json');
  try {
    execFileSync(process.execPath, ['--test', path.join(__dirname, 'model-layer-generic-101-20261026.test.js')], {
      cwd: ROOT, stdio: 'pipe', timeout: 120000,
      env: childEnv,
    });
    return null;   // 全绿 = 守卫没咬 = 失败
  } catch (e) {
    return String(e.stdout || '') + String(e.stderr || '');
  }
}

function _mutateAndExpectRed(file, from, to) {
  // ⚠️ 2026-10-26: 这套「原地改源码 ⇒ 跑守卫 ⇒ 改回来」必须**加锁**。
  //   101 和 102 两个守卫文件改的是同一批源码 (model_capability.js /
  //   llm_capabilities_sync.js), 两个链同时跑 ⇒ 写入交错 ⇒
  //   一边的 finally 还原的是**对方的变异版** ⇒ 变异留在工作区的生产代码里。
  //   实测踩到过: 软默认门卫被删掉留在 model_capability.js 里。
  //   详见 tests/helpers/mutation_guard.js。
  _mutationGuard.mutateAndExpectRed({
    root: ROOT,
    file,
    from,
    to,
    suffix: _MUT_BACKUP_SUFFIX,
    runGuard: _runGuardExpectingRed,
  });
}

test('G101g1: 把本地软默认的端点事实门卫删掉 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/model_capability.js',
    // 2026-10-26 第 102 批: 判据从 isLocalByEndpoint 改名为 isSelfHostedByEndpoint
    // (口径从「回环」放宽到「回环 + 内网 = 自建」, 名字跟着概念走)。
    '  if (!isSelfHostedByEndpoint(model)) return null;',
    '  // 变异: 门卫被删掉 ⇒ 云端端点又吃本地软默认'
  );
});

test('G101g2: 把 media_gen 的 key 改回只认模型条目 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/tools/media_gen.js',
    '  const key = resolveApiKey(model);',
    '  const key = model.api_key || null;   // 变异: 退回写死单条路径'
  );
});

test('G101g3: 把协议提示表层删掉 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/tools/media_gen.js',
    '    const hinted = hints[provider];',
    '    const hinted = null;   // 变异: 不读配置提示表'
  );
});

test('G101g4: 把端点端口指纹弄坏 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/provider_detect.js',
    '    if (ep.port && sig.ports && sig.ports.includes(ep.port)) {',
    '    if (false && ep.port && sig.ports && sig.ports.includes(ep.port)) {   // 变异: 端口指纹坏掉'
  );
});

test('G101g5: 把厂商猜测改回单条硬编 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/llm_capabilities_sync.js',
    '    if (rule.prov && prov === rule.prov) return rule.provider;',
    '    if (false) return rule.provider;   // 变异: 显式 provider 不再认'
  );
});

test('G101g6: 把 L2 探针门卫弄坏 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/model_probe.js',
    '  if (detectProvider(m).provider !== runtime) return null;',
    '  if (false) return null;   // 变异: 门卫失效, 谁都发请求'
  );
});
