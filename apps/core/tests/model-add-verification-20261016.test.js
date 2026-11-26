'use strict';
// 2026-10-16 (老板: "关键是盘古的模型配置项, 选本地连模型还是云端的",
//              "omlx 这个算是自定义模型, 所以核心问题是盘古的模型配置的问题")
//
// 这条测试钉的是一个**已经咬过人的**洞, 不是假想:
//   前端 Model.jsx 的 onAddManual 加完一律弹 "✓ 已加", 后端 /api/llm/models 的
//   action:'add' 只查重, 不看端点、不探活。于是用户看到的是"挂载成功了"。
//   真正爆的地方有两个:
//     ① 端点留空 → endpointOf() 回落到全局 llm.openai_base_url
//        → "为 oMLX 配的模型静默连到了 LM Studio"。端点通、模型名对不上、
//          一切看着正常, 只是答非所问。这正是"mlxserver 自己能用, 盘古调不了"。
//     ② 模型名填错 → 本地 server 只加载了别的模型时会忽略你发的名字照答,
//          同样 HTTP 200, 探针看不出来 (实测 LM Studio: 要 dalcu_...-4bit,
//          回的 model 字段是 qwen3.8-27b-mlx)。
// 所以"加进去了"和"能用"必须分开报, 而且要报得能直接照着改。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROUTER = require('../pangu-single/routes/inline_router');
const validate = ROUTER._validateModelForAdd;
const probe = ROUTER._probeModelReachable;
const SRC = fs.readFileSync(path.join(__dirname, '..', 'pangu-single', 'routes', 'inline_router.js'), 'utf8');

const VALID_LOCAL = {
  id: 'my-local',
  api_model: 'qwen3.8-27b-mlx',
  endpoint: 'http://127.0.0.1:1234',
  provider: 'lmstudio',
  protocol: 'openai',
};
const VALID_CLOUD = {
  id: 'k3',
  api_model: 'k3',
  endpoint: 'https://api.kimi.com/coding/v1',
  provider: 'kimi',
  protocol: 'openai',
  api_key: 'sk-test',
};

test('本地和云端两种合法配置都要通过 (别把合法的挡在外面)', () => {
  assert.equal(validate(VALID_LOCAL), null, '本地配置被误拒');
  assert.equal(validate(VALID_CLOUD), null, '云端配置被误拒');
});

test('端点为空必须拒绝 —— 这是"静默连到别的服务器"的根源', () => {
  const e = validate({ id: 'x', api_model: 'x', endpoint: '' });
  assert.ok(e, '端点为空却被收下了');
  assert.match(e, /MISSING_ENDPOINT/);
  // 报错文案要能让人知道为什么, 而不是只丢一个错误码
  assert.match(e, /回落|静默|默认端点/, '错误提示没说明后果: ' + e);
});

test('缺 id / 端点不是 URL / 非 http 协议 / 缺 api_model, 都要挡下来并说清原因', () => {
  assert.match(validate({ api_model: 'x', endpoint: 'http://127.0.0.1:1234' }), /MISSING_ID/);
  assert.match(validate({ id: 'x', api_model: 'x', endpoint: '不是URL' }), /INVALID_ENDPOINT/);
  assert.match(validate({ id: 'x', api_model: 'x', endpoint: 'ftp://127.0.0.1:21' }), /UNSUPPORTED_SCHEME/);
  // 缺 api_model: 本地 server 是按这个名字选模型的, 缺了等于没配
  assert.match(validate({ id: 'x', endpoint: 'http://127.0.0.1:1234' }), /MISSING_API_MODEL/);
  // name 也能当 api_model 用 (前端手动加时两个都填)
  assert.equal(validate({ id: 'x', name: 'foo', endpoint: 'http://127.0.0.1:1234' }), null);
});

test('base_url / api_base 是 endpoint 的合法别名 (别把它们判成缺端点)', () => {
  assert.equal(validate({ id: 'x', api_model: 'x', base_url: 'http://127.0.0.1:1234' }), null);
  assert.equal(validate({ id: 'x', api_model: 'x', api_base: 'http://127.0.0.1:1234' }), null);
});

test('探不通时必须给出可照着改的原因, 而不是干巴巴一句 fetch failed', async () => {
  // 找一个确定没人监听的本地端口 (先占再放, 拿到一个刚空出来的端口号)
  const free = await new Promise((resolve) => {
    const net = require('net');
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
  const r = await probe(
    { ...VALID_LOCAL, id: 'probe', api_model: 'x', endpoint: 'http://127.0.0.1:' + free },
    { timeoutMs: 3000 });
  assert.equal(r.ok, false, '没人监听的端口竟然探通了');
  assert.equal(r.reason, 'unreachable');
  // "fetch failed" 对用户等于没说 —— 必须挖到 ECONNREFUSED 这一层
  assert.notEqual(r.error, 'fetch failed', '没挖出底层错误码');
  assert.match(String(r.error), /ECONNREFUSED/);
  assert.ok(r.error_hint, '缺人话提示');
  assert.match(r.error_hint, /端口|server|启动/);
});

test('模型名对不上要单独报 —— 端点通 ≠ 调的就是你要的那个模型', () => {
  // 不去真连网, 只钉**结构**: 探针必须带上这几个字段,
  // 否则前端拿不到"端点通但模型不对"这个信号 (这正是老代码看不见的那类错)。
  const i = SRC.indexOf('async function _probeModelReachable');
  const j = SRC.indexOf('\n}', i);
  assert.ok(i > 0 && j > i, '找不到 _probeModelReachable');
  const body = SRC.slice(i, j);
  for (const f of ['asked_model', 'served_as', 'model_mismatch', 'model_mismatch_hint', 'error_hint']) {
    assert.ok(body.includes(f), '探针没有回报 ' + f + ' —— 前端就显示不出来');
  }
});

test('加模型这条路上, 校验和探针必须都在, 结论必须回到响应体', () => {
  const i = SRC.indexOf("} else if (action === 'add') {");
  assert.ok(i > 0, '找不到 action:add 分支');
  const j = SRC.indexOf("} else if (action === 'update') {", i);
  const branch = SRC.slice(i, j);
  assert.ok(branch.includes('_validateModelForAdd'), 'add 分支没做校验');
  assert.ok(branch.includes('_probeModelReachable'), 'add 分支没探活');
  assert.ok(branch.includes('reachable:'), '响应里没有 reachable');
  assert.ok(branch.includes('model_mismatch:'), '响应里没有 model_mismatch');
  assert.ok(branch.includes('warning:'), '响应里没有 warning');
});

test('"测试连接"和"加模型"必须用同一个探针 (两套标准 = 测试说通但调不通)', () => {
  const i = SRC.indexOf("/api/llm/test-connection");
  const j = SRC.indexOf("pathname === '/api/test/evo-write'", i);
  const handler = SRC.slice(i, j);
  assert.ok(handler.includes('_probeModelReachable'),
    'test-connection 自己拼了一套请求 —— 跟真正发请求那条链不同源');
  // 旧写法: 自己 fetch + 手写 Authorization 头, 与 authHeaders 不同源。
  // 只看代码行 —— 上面那段解释里就写着 "Bearer", 连注释一起判会永远红。
  const code = handler.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/Bearer/.test(code), 'test-connection 里还有手写的鉴权头');
  assert.ok(!/\bfetch\(/.test(code), 'test-connection 里还在自己发 fetch, 没走共用探针');
});
