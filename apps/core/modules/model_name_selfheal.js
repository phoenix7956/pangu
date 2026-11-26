'use strict';

// 本地模型端点 (oMLX / LM Studio / mlx-serve / Ollama) 的模型 id 会随
// "下载哪个版本" 变: 同��个权重, 上游给的可能是
// "mlx-community/Qwen3.8-27B-4bit", 端点只认 "Qwen3.8-27B-4bit"。
//
// 盘古之前的行为: 撞 404 直接把 "HTTP 404: Model ... not found. Available
// models: Qwen3.8-27B-4bit" 抛上去, 整轮失败, 而且**信息明明在错误正文里**
// —— 模型看得见正确答案却用不上。
//
// 这里做两件事:
//   1. 先从 404 正文里正则捞 "Available models: [...]", 省一次往返。
//   2. 捞不到再打端点的 /v1/models (llm_provider_catalog.modelsUrl 已处理
//      裸 host:port 补 /v1), 取真名。
//
// 匹配用规范化比较: 小写 + 非字母数字折叠, 所以
// "mlx-community_qwen3.8-27b-4bit" 和 "Qwen3.8-27B-4bit" 归一后一致。

const HTTP_TIMEOUT_MS = 8000;

// 只在明确"模型不存在/未加载"时自愈。401/403 是 key 问题, 重试没有意义;
// 404 也可能是 URL 路径写错, 所以正文必须同时含模型语义的证据。
const MODEL_MISSING_RE = /(model[^\n]{0,40}not\s*found|not\s*found[^\n]{0,40}model|no\s*default\s*model|unknown\s*model|invalid\s*model|no\s*models?\s+loaded|model[^\n]{0,20}(is\s+)?not\s+available)/i;
const AVAILABLE_RE = /available\s+models?\s*:\s*([^\n"\\]+)/i;
// 名字不对 -> registry 必然没有它 -> getModelContextLength 直接 fail-loud。
// 所以"registry miss"是同一个根因的另一个出口: 必须在抛错之前就自愈,
// 否则请求连端点都发不出去, 永远拿不到端点告诉我们的正确名字。
const REGISTRY_MISS_RE = /model context not discoverable[\s\S]*:\s*(\S+)/i;

function normalizeModelId(id) {
  return String(id || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function looksLikeModelMissing(err) {
  const msg = String((err && err.message) || err || '');
  if (REGISTRY_MISS_RE.test(msg)) return true;
  // 404 = 名字不对; 400 = LM Studio "No models loaded"; 503 = mlx-serve
  // "No default model configured" (端点活着但没挂模型, 换名字也没用, 但仍要
  // 走自愈去问一次端点 —— 有些端点 503 时正文里正好列着可用的).
  if (!/HTTP\s+(404|400|503)\b/.test(msg)) return false;
  return MODEL_MISSING_RE.test(msg);
}

function parseAvailableFromError(err) {
  const msg = String((err && err.message) || err || '');
  const m = msg.match(AVAILABLE_RE);
  if (!m) return [];
  return m[1]
    .split(/[,;]/)
    .map((s) => s.trim().replace(/^['"`]|['"`\.]$/g, ''))
    .filter(Boolean);
}

function pickCorrectName(wanted, candidates) {
  const want = normalizeModelId(wanted);
  if (!want || !Array.isArray(candidates) || candidates.length === 0) return null;
  // 精确 (规范化后) 命中
  for (const c of candidates) {
    if (normalizeModelId(c) === want) return c;
  }
  // 盘古存的是 "Qwen3.8-27B-4bit", 端点列的是 "mlx-community/Qwen3.8-27B-4bit"
  // 或反之 —— 一方是另一方加路径前缀, 取短的那个 (端点通常用短名)。
  for (const c of candidates) {
    const nc = normalizeModelId(c);
    if (nc && (nc.endsWith(want) || want.endsWith(nc))) {
      return c.length <= wanted.length ? c : candidates.find((x) => normalizeModelId(x).length <= normalizeModelId(c).length) || c;
    }
  }
  // 只剩一个候选 → 端点只挂了一个模型, 它就是答案
  if (candidates.length === 1) return candidates[0];
  return null;
}

async function fetchUpstreamIds(endpoint, apiKey) {
  const catalog = require('./llm_provider_catalog');
  const url = catalog.modelsUrl(endpoint);
  const lib = url.startsWith('https:') ? require('https') : require('http');
  return new Promise((resolve) => {
    const u = new URL(url);
    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + (u.search || ''),
        method: 'GET',
        headers,
        timeout: HTTP_TIMEOUT_MS,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          if (data.length < 512 * 1024) data += c;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve([]);
          try {
            resolve(catalog.extractModels(JSON.parse(data)));
          } catch (_) {
            resolve([]);
          }
        });
      }
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      try { req.destroy(); } catch (_) {}
      resolve([]);
    });
    req.end();
  });
}

// 返回修正后的 modelConfig, 或者 null 表示"救不了, 让原错误继续往上抛"。
async function healModelConfig(err, modelConfig, resolveContext) {
  if (!looksLikeModelMissing(err)) return null;
  const ctx = typeof resolveContext === 'function' ? resolveContext(modelConfig) : null;
  if (!ctx || !ctx.useModel) return null;

  const wanted = modelTransportName(ctx.useModel);
  // 1) 先看错误正文里有没有现成的答案
  let hit = pickCorrectName(wanted, parseAvailableFromError(err));
  // 2) 没有再问端点
  if (!hit) {
    const ids = await fetchUpstreamIds(ctx.useModel.endpoint || ctx.useModel.api_base, ctx.apiKey);
    hit = pickCorrectName(wanted, ids);
  }
  if (!hit || hit === wanted) return null;

  // 3) 换名之后还得有 ctx, 否则第二轮照样撞 registry miss。
  //    优先用端点自报的 context_length, 没有就老实跑一次 L3 probe。
  await _ensureContextLength(hit, ctx);

  const healed = { ...ctx.useModel, id: hit, api_model: hit };
  console.warn(
    '[model-name-selfheal] ' + JSON.stringify(wanted) + ' -> ' + JSON.stringify(hit) +
    ' (endpoint=' + (ctx.useModel.endpoint || ctx.useModel.api_base) + ')'
  );
  return healed;
}

async function _ensureContextLength(modelId, ctx) {
  try {
    const registry = require('./model_registry');
    if (registry.getContextLength(modelId)) return;
    // 端点常在 /v1/models 里自报窗口 (oMLX / LM Studio / mlx-serve 都会)
    const catalog = require('./llm_provider_catalog');
    const url = catalog.modelsUrl(ctx.useModel.endpoint || ctx.useModel.api_base);
    const lib = url.startsWith('https:') ? require('https') : require('http');
    const entries = await new Promise((resolve) => {
      const u = new URL(url);
      const headers = { Accept: 'application/json' };
      if (ctx.apiKey) headers.Authorization = 'Bearer ' + ctx.apiKey;
      const req = lib.request(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + (u.search || ''),
          method: 'GET',
          headers,
          timeout: HTTP_TIMEOUT_MS,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => {
            if (data.length < 512 * 1024) data += c;
          });
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) return resolve([]);
            try {
              resolve(catalog.extractModelEntries(JSON.parse(data)));
            } catch (_) {
              resolve([]);
            }
          });
        }
      );
      req.on('error', () => resolve([]));
      req.on('timeout', () => {
        try { req.destroy(); } catch (_) {}
        resolve([]);
      });
      req.end();
    });
    const hit = entries.find((e) => normalizeModelId(e.id) === normalizeModelId(modelId));
    if (hit && hit.context_length > 0) {
      registry.setContextLength(modelId, hit.context_length, 'upstream-models-api');
      return;
    }
    // 端点没自报 → 跑 probe (跟"加入模型池"同一条路)
    const probe = require('./model_probe');
    const r = await probe.probeContextLength({
      ...ctx.useModel,
      id: modelId,
      api_model: modelId,
      api_key: ctx.apiKey,
    });
    if (r && r.context_length > 0) registry.setContextLength(modelId, r.context_length, r.source || 'selfheal-probe');
  } catch (e) {
    console.warn('[model-name-selfheal] ctx 补齐失败(不阻断): ' + (e.message || e));
  }
}

// id 是盘古池里的名字, api_model 才是真正发给端点的名字 —— 要对后者自愈。
function modelTransportName(model) {
  return String((model && (model.api_model || model.id)) || '');
}

module.exports = {
  looksLikeModelMissing,
  parseAvailableFromError,
  pickCorrectName,
  normalizeModelId,
  fetchUpstreamIds,
  healModelConfig,
};
