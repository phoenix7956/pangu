'use strict';

// 2026-10-23 第 71 批 —— 「本地模型判定」收成唯一真源
//
// 起因 (实跑逮到的, 不是审出来的):
//   生产池里的 agnes-3.0-flash 是 provider=custom + https://api.agnes-ai.cn/v1 (云端)。
//   收口之前, 同一个模型在同一个进程里算出**两个相反的答案**:
//     j2_loop_shared 的判定 → true  ⇒ 轮次超时 300000ms、idle 超时 300000ms
//     model_transport 的判定 → false ⇒ 请求超时 60000ms
//   也就是说它挂住时, 一处等 5 分钟, 另一处等 1 分钟。
//   根因: j2_loop_shared 那份 provider 名单里**多一个 'custom'** ——
//   而 custom 只说明「自建端点」, 本地与否完全由端点决定。
//
// 这批做的事: 把 5 份实现 / 4 份 provider 名单收进 local_model 一个真源,
// 并且把「回环」「内网」「provider 名单」三种语义分开, 不再一刀切。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const M = (p) => require(path.join(__dirname, '..', p));
const LM = M('modules/local_model.js');
const SHARED = M('modules/j2_loop_shared.js');
const MT = M('modules/model_transport.js');
const MC = M('modules/router/model_cost.js');
const AKR = M('modules/api_key_resolver.js');
const LC = M('modules/llm_caller.js');

// 2026-10-28 (第 137 批, 开源): 原来 B1/B2 直接读**生产池**里那条 agnes-3.0-flash。
//   那文件 (modules/router/models.json) 现在是**运行时缓存, 不入库** —— 干净克隆里
//   压根没有, 而且它装的是维护者机器的模型池 ⇒ 守卫依赖机器状态 = 别人机器上必红。
//   守卫要验的是「五处对同一个云端 custom 模型必须算出同一个答案」, 不是
//   「某个特定模型存在」⇒ 改成自带夹具。
const CLOUD_CUSTOM_FIXTURE = {
  id: 'fixture-cloud-custom',
  provider: 'custom',
  api_base: 'https://api.fixture-cloud.invalid/v1',   // 公网 https ⇒ 不是本地/内网
  endpoint: 'https://api.fixture-cloud.invalid/v1',
};

const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// 剥掉注释再扫 —— 注释里提到一个模块名不等于代码里 require 了它。
// (判据自己踩过一次: 扫全文时, 真源注释里那句"这五个模块各抄一份"被当成了依赖。)
const codeOnly = (p) => src(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

// ---------- A 组: 真源本身 ----------

test('A1 真源导出齐全', () => {
  for (const k of ['LOCAL_PROVIDERS', 'endpointOf', 'hostOf', 'isLoopbackEndpoint',
    'isPrivateEndpoint', 'isLocalEndpoint', 'isLocalProvider', 'isLocalModel', 'isLocalOrPrivateModel']) {
    assert.ok(LM[k] !== undefined, '真源必须导出 ' + k);
  }
});

test('A2 回环段全认: 127/8 每一段 + IPv6 + localhost + 0.0.0.0', () => {
  for (const u of [
    'http://127.0.0.1:1234/v1',
    'http://127.0.0.2:1234/v1',
    'http://127.0.0.5:1234/v1',
    'http://127.255.255.254:1234/v1',
    'http://[::1]:1234/v1',
    'http://localhost:1234/v1',
    'http://0.0.0.0:1234/v1',
  ]) {
    assert.strictEqual(LM.isLoopbackEndpoint(u), true, u + ' 是回环');
  }
});

test('A3 云端不许被误判成本地 (主机名里带 127 但不是本机)', () => {
  for (const u of [
    'https://api.kimi.com/coding/v1',
    'https://api.minimaxi.com/v1/chat/completions',
    'https://127.0.0.1.evil.com/v1',
    'https://notlocalhost.com/v1',
  ]) {
    assert.strictEqual(LM.isLoopbackEndpoint(u), false, u + ' 不是回环');
    assert.strictEqual(LM.isPrivateEndpoint(u), false, u + ' 不是内网');
  }
});

test('A4 内网与回环是两回事, 不能混', () => {
  for (const u of [
    'http://10.0.0.5:11434/v1',
    'http://192.168.0.192:7893/v1',
    'http://172.16.0.1/v1',
    'http://172.20.5.5/v1',
    'http://172.31.255.1/v1',
    'http://169.254.1.1/v1',
    'http://myserver.local:8080/v1',
  ]) {
    assert.strictEqual(LM.isPrivateEndpoint(u), true, u + ' 是内网');
    assert.strictEqual(LM.isLoopbackEndpoint(u), false, u + ' 不是回环');
    assert.strictEqual(LM.isLocalEndpoint(u), true, u + ' 不是公网');
  }
});

test('A5 内网段边界: 172.15 / 172.32 不是内网 (老正则按 1[6-9]|2\\d|3[01] 判)', () => {
  assert.strictEqual(LM.isPrivateEndpoint('http://172.15.0.1/v1'), false);
  assert.strictEqual(LM.isPrivateEndpoint('http://172.32.0.1/v1'), false);
});

test('A6 provider 名单里不许有 custom —— custom 的本地性只看端点', () => {
  assert.strictEqual(LM.LOCAL_PROVIDERS.has('custom'), false,
    'custom 只说明「自建端点」, 放进名单就等于把云端自建端点判成本地');
});

test('A7 垃圾输入不许崩', () => {
  for (const bad of ['', null, undefined, 'not a url', {}, 123]) {
    assert.strictEqual(LM.isLoopbackEndpoint(bad), false, String(bad));
    assert.strictEqual(LM.isPrivateEndpoint(bad), false, String(bad));
    assert.strictEqual(LM.isLocalModel(bad), false, String(bad));
    assert.strictEqual(LM.isLocalOrPrivateModel(bad), false, String(bad));
  }
});

// ---------- B 组: 五处必须算出同一个答案 (本批的核心) ----------

test('B1 同一个云端 custom 模型, 五处判定必须一致 —— 收口前它们算出两个相反的答案', () => {
  const agnes = CLOUD_CUSTOM_FIXTURE;
  assert.strictEqual(String(agnes.provider), 'custom');
  assert.ok(/^https:\/\//.test(String(agnes.api_base)), '它的端点必须是 https 公网');
  const shape = Object.assign({}, agnes, { endpoint: agnes.api_base });

  assert.strictEqual(SHARED._isLocalModel(shape), false, '共享判定不许把云端 custom 判成本地');
  assert.strictEqual(MT.isLocalModel(shape), false, '传输层判定');
  assert.strictEqual(MC.isLocalModel(shape), false, '计费判定');
  assert.strictEqual(LM.isLocalModel(shape), false, '真源');
  assert.strictEqual(AKR.isLocalEndpoint(agnes.api_base), false, '免 key 判定');
});

test('B2 云端 custom 模型的轮次超时必须是 120s —— 修前是 300s (判成本地)', () => {
  const agnes = CLOUD_CUSTOM_FIXTURE;
  const shape = Object.assign({}, agnes, { endpoint: agnes.api_base });
  assert.strictEqual(SHARED._resolveRoundTimeoutMs(shape), 120000,
    '云端 custom 拿 300s 轮次超时 = 它挂住时主人要干等 5 分钟');
});

test('B3 真本地模型五处一致为 true', () => {
  for (const m of [{ provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234/v1' },
    { provider: 'ollama', endpoint: 'http://127.0.0.1:11434/v1' },
    { provider: 'openai', endpoint: 'http://127.0.0.1:1234/v1/chat/completions' }]) {
    assert.strictEqual(SHARED._isLocalModel(m), true, JSON.stringify(m));
    assert.strictEqual(MT.isLocalModel(m), true, JSON.stringify(m));
    assert.strictEqual(MC.isLocalModel(m), true, JSON.stringify(m));
    assert.strictEqual(LM.isLocalModel(m), true, JSON.stringify(m));
  }
  // 只写 api_base 不写 endpoint 的写法(池子里就有这种)也要认出来
  assert.strictEqual(SHARED._isLocalModel({ provider: 'custom', api_base: 'http://127.0.0.1:1234/v1' }), true,
    '端点字段名有两种, 只认一种 = 漏判一半');
  assert.strictEqual(LM.isLocalModel({ provider: 'custom', api_base: 'http://127.0.0.1:1234/v1' }), true);
});

test('B4 custom provider + 回环端点 = 本地 (custom 只看端点, 不看 provider)', () => {
  const m = { provider: 'custom', endpoint: 'http://127.0.0.1:1234/v1' };
  assert.strictEqual(LM.isLocalModel(m), true);
  assert.strictEqual(SHARED._isLocalModel(m), true);
});

test('B5 127/8 其余地址在所有口径下都算本地 (旧实现只认 127.0.0.1)', () => {
  const m = { provider: 'custom', endpoint: 'http://127.0.0.5:1234/v1' };
  assert.strictEqual(SHARED._isLocalModel(m), true);
  assert.strictEqual(AKR.isLocalEndpoint(m.endpoint), true);
  assert.strictEqual(SHARED._resolveRoundTimeoutMs(m), 300000);
});

test('B6 计费口径保留内网 (内网 ollama 不按云端 token 计价), 超时口径不含内网', () => {
  const lan = { provider: 'custom', endpoint: 'http://192.168.0.10:11434/v1' };
  assert.strictEqual(MC.isLocalModel(lan), true, '计费: 内网算本地');
  assert.strictEqual(MT.isLocalModel(lan), true, '传输层: 内网端点也算本地');
  assert.strictEqual(LM.isLocalModel(lan), false, '超时口径: 内网不算本机');
  assert.strictEqual(LM.isLocalOrPrivateModel(lan), true);
});

// ---------- C 组: 不许再有第二份实现 ----------

test('C1 五个调用点必须引用真源符号, 不许自己再抄一份', () => {
  const sites = [
    ['modules/api_key_resolver.js', 'isLoopbackEndpoint'],
    ['modules/llm_caller.js', 'isLocalModel'],
    ['modules/j2_loop_shared.js', 'isLocalModel'],
    ['modules/model_transport.js', 'isLocalEndpoint'],
    ['modules/router/model_cost.js', 'isLocalOrPrivateModel'],
  ];
  for (const [file, fn] of sites) {
    const s = src(file);
    assert.ok(/require\('\.\.?(?:\/|\.)?local_model'\)/.test(s) || /require\('\.\.\/local_model'\)/.test(s),
      file + ' 必须 require 真源, 不许自己抄一份判定');
    assert.ok(s.includes(fn), file + ' 必须调用真源的 ' + fn);
  }
});

test('C2 provider 名单字面量只许在真源里出现一次', () => {
  const files = ['modules/api_key_resolver.js', 'modules/llm_caller.js', 'modules/j2_loop_shared.js',
    'modules/model_transport.js', 'modules/router/model_cost.js'];
  for (const f of files) {
    const s = codeOnly(f);
    // 只看**数组字面量** —— 对象字面量 {lmstudio: 8192, ...} 是输出上限表, 不是本地名单
    for (const m of s.matchAll(/\[[^\[\]]*\]/g)) {
      const lit = m[0];
      const hasLm = /['"]lmstudio['"]/.test(lit);
      const hasOllama = /['"]ollama['"]/.test(lit);
      assert.ok(!(hasLm && hasOllama),
        f + ' 里还留着 provider 名单字面量 —— 名单只能有一份: ' + lit.slice(0, 120));
    }
  }
});

test('C3 导出的 _LOCAL_PROVIDERS 必须等于真源那份', () => {
  assert.deepStrictEqual(
    SHARED._LOCAL_PROVIDERS.slice().sort(),
    Array.from(LM.LOCAL_PROVIDERS).sort(),
    '共享层导出的名单必须跟真源一致');
});

test('C4 真源不许反过来依赖被它收口的那些模块 (不许循环)', () => {
  // 只查 require 的目标 —— 注释里提到这些名字是说明文字, 不是依赖
  const s = codeOnly('modules/local_model.js');
  for (const dep of ['api_key_resolver', 'llm_caller', 'j2_loop_shared', 'model_transport', 'model_cost']) {
    assert.ok(!new RegExp("require\\(\\s*['\"][^'\"]*" + dep).test(s),
      '真源不许 require ' + dep + ' —— 会成循环依赖');
  }
});

// ---------- D 组: 既有判据不许被放松 ----------

test('D1 免 key 判据那四条仍然成立 (纯回环语义不许被改成"回环 or 内网")', () => {
  assert.strictEqual(AKR.isLocalEndpoint('http://127.0.0.1:1234/v1'), true);
  assert.strictEqual(AKR.isLocalEndpoint('http://[::1]:1234/v1'), true);
  assert.strictEqual(AKR.isLocalEndpoint('http://0.0.0.0:1234'), true);
  assert.strictEqual(AKR.isLocalEndpoint('https://api.kimi.com/coding/v1'), false);
  assert.strictEqual(AKR.isLocalEndpoint('https://127.0.0.1.evil.com/v1'), false);
  assert.strictEqual(AKR.isLocalEndpoint('not a url'), false);
  assert.strictEqual(AKR.isLocalEndpoint('http://192.168.0.10:11434/v1'), false,
    '免 key 口径是**纯回环** —— 内网自建代理未必不要 key, 不许顺手放宽');
});

test('D2 共享层导出的超时口径没变 (本地 300s / 云端 120s / env 强制覆盖)', () => {
  assert.strictEqual(SHARED._resolveRoundTimeoutMs({ provider: 'lmstudio' }), 300000);
  assert.strictEqual(SHARED._resolveRoundTimeoutMs({ provider: 'ollama' }), 300000);
  assert.strictEqual(SHARED._resolveRoundTimeoutMs({ provider: 'minimax', endpoint: 'https://api.minimaxi.com/v1' }), 120000);
  assert.strictEqual(SHARED._resolveRoundTimeoutMs({ provider: 'openai', endpoint: 'http://127.0.0.1:1234/v1' }), 300000);
});
