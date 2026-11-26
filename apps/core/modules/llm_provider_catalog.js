'use strict';

// Lists the models an account is entitled to use. This is deliberately
// separate from models.dev: the provider answers availability, while the
// public catalog enriches capability metadata.
const http = require('http');
const https = require('https');

function modelsUrl(endpoint) {
  const url = new URL(endpoint);
  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/(chat\/completions|responses|completions|messages|api\/chat)$/i, '');
  // 裸 host:port (设置页里人只填 "http://127.0.0.1:12345" / "http://localhost:11434")
  // 之前拼成 "/models" -> 404。LM Studio / mlx-serve / Ollama / vLLM 全部把
  // 模型清单挂在 "/v1/models", 所以无路径时补 /v1。
  url.pathname = (pathname || '/v1') + '/models';
  url.search = '';
  return url.toString();
}

function requestJson(urlString, apiKey, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const url = new URL(urlString);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'pangu-provider-catalog/1.0',
        ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 2 * 1024 * 1024) chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return resolve({ ok: false, status: res.statusCode, error: 'HTTP_' + res.statusCode });
        }
        try { resolve({ ok: true, data: JSON.parse(text) }); }
        catch (_) { resolve({ ok: false, status: res.statusCode, error: 'INVALID_JSON' }); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('TIMEOUT')));
    req.on('error', (error) => resolve({ ok: false, error: error.message || 'REQUEST_FAILED' }));
    req.end();
  });
}

function isRemoteOpenAICompatible(model) {
  if (!model || !model.endpoint || model.protocol === 'anthropic') return false;
  const endpoint = String(model.endpoint).toLowerCase();
  if (!/^https?:\/\//.test(endpoint)) return false;
  return !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(endpoint);
}

function extractModels(payload) {
  const list = Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models
      : Array.isArray(payload) ? payload : [];
  return [...new Set(list.map((item) => typeof item === 'string' ? item : item?.id).filter(Boolean))].sort();
}

// Preserve provider metadata as well as ids. Some compatible /models APIs
// expose the real context window on each entry.
function extractModelEntries(payload) {
  const list = Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models
      : Array.isArray(payload) ? payload : [];
  return list.map((item) => {
    if (typeof item === 'string') return { id: item };
    if (!item || !item.id) return null;
    const context_length = Number(item.context_length || item.context_window || item.max_context_length || item.max_model_len || item.loaded_context_length || 0);
    return { ...item, ...(context_length > 0 ? { context_length } : {}) };
  }).filter(Boolean);
}

// opts.allowLocal: 调用方 (设置页"从上游获取") 显式给了 endpoint, 说明人明确要打这个地址,
// 此时 localhost/127.0.0.1 是合法目标 (LM Studio / mlx-serve / Ollama 都有 /v1/models)。
// 只在这条显式路径上放开; 走 provider 名字猜seed 的老路径仍然只认远端。
async function listAccountModels(seedModel, resolveApiKey, opts = {}) {
const target = seedModel || {};
if (!opts.allowLocal && !isRemoteOpenAICompatible(target)) {
return { ok: false, error: 'UNSUPPORTED_PROVIDER_CATALOG' };
}
if (!target.endpoint) return { ok: false, error: 'MISSING_ENDPOINT' };
const apiKey = typeof resolveApiKey === 'function' ? resolveApiKey(target) : target.api_key;
// 本地服务一般不校验 key, 别因为没填 key 就把localhost 路径堵死
if (!apiKey && !opts.allowLocal) return { ok: false, error: 'MISSING_API_KEY' };
const endpoint = modelsUrl(target.endpoint);
  const response = await requestJson(endpoint, apiKey);
  if (!response.ok) return { ok: false, endpoint, status: response.status, error: response.error };
  return { ok: true, endpoint, ids: extractModels(response.data), data: response.data };
}

module.exports = { modelsUrl, extractModels, extractModelEntries, isRemoteOpenAICompatible, listAccountModels };
