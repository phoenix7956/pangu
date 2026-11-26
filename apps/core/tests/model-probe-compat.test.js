'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const probe = require('../modules/model_probe');

function serverOnce(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('OpenAI-compatible probe uses canonical model and bearer auth', async () => {
  let seen;
  const server = await serverOnce((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen = { path: req.url, headers: req.headers, body: JSON.parse(body) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
  });
  try {
    const port = server.address().port;
    const result = await probe._testChat({
      id: 'internal_model',
      name: 'vendor/model-name',
      provider: 'custom',
      endpoint: `http://127.0.0.1:${port}/v1`,
      api_key: 'sk-test',
      protocol: 'openai',
    }, 16);
    assert.equal(result.verdict, 'pass');
    assert.equal(seen.path, '/v1/chat/completions');
    assert.equal(seen.body.model, 'vendor/model-name');
    assert.equal(seen.headers.authorization, 'Bearer sk-test');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Anthropic probe uses Messages path, canonical model, and x-api-key', async () => {
  let seen;
  const server = await serverOnce((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen = { path: req.url, headers: req.headers, body: JSON.parse(body) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }));
    });
  });
  try {
    const port = server.address().port;
    const result = await probe._testMessages({
      id: 'internal_claude',
      name: 'claude-sonnet-test',
      provider: 'anthropic',
      endpoint: `http://127.0.0.1:${port}/v1/messages`,
      api_key: 'sk-ant-test',
      protocol: 'anthropic',
    }, 16);
    assert.equal(result.verdict, 'pass');
    assert.equal(seen.path, '/v1/messages');
    assert.equal(seen.body.model, 'claude-sonnet-test');
    assert.equal(seen.headers['x-api-key'], 'sk-ant-test');
    assert.equal(seen.headers.authorization, undefined);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Messages probe does not send Anthropic payloads to OpenAI models', async () => {
  const result = await probe._testMessages({
    id: 'openai-model',
    name: 'openai-model',
    endpoint: 'http://127.0.0.1:1/v1',
    protocol: 'openai',
  }, 16);
  assert.equal(result, null);
});

// 2026-10-14 现场: LM Studio 的 /api/v0/models 列的是"下载到本地库的全部模型",
// 含 state=not-loaded。旧实现把那种条目的 max_context_length 当已验证真源
// (标 _ctx_source_label: 本地真源), 于是没加载的模型也拿到了 262144,
// 盘古据此排上下文/算 max_tokens, 真调用时端点回 "No models loaded"。
// ctx 是从一份并不存在的运行实例上读来的, 结论必然是错的。
//
// 为什么换掉 provider_detect: model_probe.js 顶层就 destructured 了
// detectProvider, 事后 monkey patch 模块.exports 不生效。而 detectProvider 只按
// endpoint 形状判 provider (127.0.0.1:1234 → lmstudio), 不看 entry.provider 字段,
// 于是随机端口的测试服务器会被判成 'local', probe 在发请求前就 return null ——
// 那个"通过"是假的, 什么也没证明。所以这里在 require model_probe **之前**
// 就把 provider_detect 塞进 require.cache, 让它稳定返回 lmstudio。
function loadProbeAsLMStudio() {
  const pdPath = require.resolve('../modules/provider_detect');
  const mpPath = require.resolve('../modules/model_probe');
  const real = require.cache[pdPath];
  require.cache[pdPath] = {
    id: pdPath,
    filename: pdPath,
    loaded: true,
    exports: { detectProvider: () => ({ provider: 'lmstudio', protocol: 'lmstudio' }) },
  };
  delete require.cache[mpPath];
  const fresh = require(mpPath);
  if (real) require.cache[pdPath] = real; else delete require.cache[pdPath];
  delete require.cache[mpPath];
  require(mpPath); // 恢复默认那份给后续用例用
  return fresh;
}

test('L2-lmstudio refuses ctx from a model LM Studio has not loaded', async () => {
  const lmsProbe = loadProbeAsLMStudio();
  let sawRequest = false;
  const server = await serverOnce((req, res) => {
    sawRequest = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: [{
        id: 'qwen3.8-27b-mlx-serve',
        state: 'not-loaded',
        max_context_length: 262144,
        loaded_context_length: null,
      }],
    }));
  });
  try {
    const result = await lmsProbe._probeL2LMStudio({
      id: 'qwen3.8-27b-mlx-serve',
      name: 'qwen3.8-27b-mlx-serve',
      endpoint: 'http://127.0.0.1:' + server.address().port,
    });
    assert.equal(sawRequest, true, '必须真的打到了 /api/v0/models (否则 null 是假象)');
    assert.equal(result, null, '没加载的模型必须拿不到 ctx (宁可 fail-loud, 不给假值)');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('L2-lmstudio still trusts loaded_context_length when the model really is loaded', async () => {
  const lmsProbe = loadProbeAsLMStudio();
  let sawRequest = false;
  const server = await serverOnce((req, res) => {
    sawRequest = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: [{
        id: 'qwen3.8-27b-mlx-serve',
        state: 'loaded',
        max_context_length: 262144,
        loaded_context_length: 8192,
      }],
    }));
  });
  try {
    const result = await lmsProbe._probeL2LMStudio({
      id: 'qwen3.8-27b-mlx-serve',
      name: 'qwen3.8-27b-mlx-serve',
      endpoint: 'http://127.0.0.1:' + server.address().port,
    });
    assert.equal(sawRequest, true, '必须真的打到了 /api/v0/models');
    // 正在跑的实例才是真窗口 (分批加载时 loaded < max 是正常的)
    assert.equal(result, 8192, '已加载模型要取 loaded_context_length, 不是标称 max');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
