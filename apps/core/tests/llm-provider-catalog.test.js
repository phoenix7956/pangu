'use strict';

const assert = require('assert');
const { test } = require('node:test');
const catalog = require('../modules/llm_provider_catalog');

test('provider catalog derives the OpenAI-compatible models endpoint', () => {
  assert.strictEqual(catalog.modelsUrl('https://api.minimaxi.com/v1/chat/completions'), 'https://api.minimaxi.com/v1/models');
  assert.strictEqual(catalog.modelsUrl('https://api.kimi.com/coding/v1/chat/completions'), 'https://api.kimi.com/coding/v1/models');
  assert.strictEqual(catalog.modelsUrl('https://example.com/v1/messages'), 'https://example.com/v1/models');

  // 2026-10-14: 老板填裸 host:port 打本地模型, 拼成 /models -> 404,
  // 于是以为"还是打云端"实际上打到了本地但没拿到清单。无路径时补 /v1。
  assert.strictEqual(catalog.modelsUrl('http://127.0.0.1:12345'), 'http://127.0.0.1:12345/v1/models');
  assert.strictEqual(catalog.modelsUrl('http://127.0.0.1:12345/'), 'http://127.0.0.1:12345/v1/models');
  assert.strictEqual(catalog.modelsUrl('http://localhost:11434'), 'http://localhost:11434/v1/models');
  // 已带路径的不能被二次加 /v1
  assert.strictEqual(catalog.modelsUrl('http://127.0.0.1:12345/v1'), 'http://127.0.0.1:12345/v1/models');
  assert.strictEqual(catalog.modelsUrl('https://api.agnes-ai.cn/v1'), 'https://api.agnes-ai.cn/v1/models');
});

test('provider catalog accepts common model list response shapes', () => {
  assert.deepStrictEqual(catalog.extractModels({ data: [{ id: 'm2' }, { id: 'm1' }, { id: 'm2' }] }), ['m1', 'm2']);
  assert.deepStrictEqual(catalog.extractModels({ models: ['m2', 'm1'] }), ['m1', 'm2']);
});

test('provider catalog skips local and Anthropic endpoints', () => {
  assert.strictEqual(catalog.isRemoteOpenAICompatible({ endpoint: 'http://127.0.0.1:1234/v1/chat/completions' }), false);
  assert.strictEqual(catalog.isRemoteOpenAICompatible({ endpoint: 'https://api.anthropic.com/v1/messages', protocol: 'anthropic' }), false);
  assert.strictEqual(catalog.isRemoteOpenAICompatible({ endpoint: 'https://api.example.com/v1/chat/completions', protocol: 'openai' }), true);
});

// 2026-10-13: 设置页"从上游获取"显式给了base URL 时, localhost 是合法目标。
// 老行为 (只发 provider, 后端猜 seed) 仍然拒本地 —— 两条路径不能混。
test('allowLocal opts admits a local endpoint and tolerates a missing api key', async () => {
const http = require('node:http');
const server = http.createServer((req, res) => {
if (req.url === '/v1/models') {
res.writeHead(200, { 'Content-Type': 'application/json' });
res.end(JSON.stringify({ data: [{ id: 'ddalcu/Qwen3.8-27B-MLX-Serve-4bit', context_length: 262144 }] }));
} else { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
try {
const denied = await catalog.listAccountModels({ endpoint, protocol: 'openai' }, () => '');
assert.strictEqual(denied.ok, false);
assert.strictEqual(denied.error, 'UNSUPPORTED_PROVIDER_CATALOG');

const allowed = await catalog.listAccountModels(
{ endpoint, protocol: 'openai' }, () => '', { allowLocal: true });
assert.strictEqual(allowed.ok, true);
assert.deepStrictEqual(catalog.extractModels(allowed.data), ['ddalcu/Qwen3.8-27B-MLX-Serve-4bit']);
} finally {
server.close();
}
});

// 本地端点必须跳过 L0/L3/L4 —— 它们发 1-5MB padding, 把 mlx-serve 打成堆损坏。
test('PADDING_PROBES covers exactly the probes that flood the endpoint', () => {
const { PADDING_PROBES, listProbes } = require('../modules/model_probe');
assert.deepStrictEqual([...PADDING_PROBES].sort(), ['L0-gateway-upper', 'L3-chat-probe', 'L4-messages-probe']);
for (const p of listProbes()) {
// 反向保护: 新注册的探针若没列入PADDING_PROBES, 默认仍会打本地 (保守=不漏)
assert.ok(typeof p.name === 'string' && p.name.length > 0);
}
});
