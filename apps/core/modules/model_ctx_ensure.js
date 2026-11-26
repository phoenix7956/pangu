'use strict';
// modules/model_ctx_ensure.js — 保证池内模型的 ctx 在 registry 里有条目 (第 111 批)
//
// 事故背景 (2026-10-26 实测线上):
//   池里多了一个新模型 id (MiniMax-M3.1-Flash), registry 里没有它的条目
//   ⇒ getModelContextLength 抛 ⇒ llm_caller 算 max_tokens 时抛
//   ⇒ **POST /api/chat 每次都 500**, 盘古整个不可用。
//   模型是好的, 端点是通的, 只是"没人把窗口大小告诉盘古"。
//
// 这条链的分工:
//   registry 层 (model_registry): 真值存储, 仍然 fail-loud —— 没探到就是没探到。
//   保证层 (本模块): 进池 / 被选中 / 启动时, 发现 registry 没条目就补。
//   运行时热路径 (pangu_helpers.getModelContextLengthSafe): 补不上就退到保守值,
//     **不许**因为"不知道窗口多大"把整轮对话打死。

const modelRegistry = require('./model_registry');
const modelTransport = require('./model_transport');
const apiKeyResolver = require('./api_key_resolver');

function _aliases(model) {
  const out = [];
  const push = (v) => { if (v && !out.includes(v)) out.push(String(v)); };
  push(model && model.id);
  push(model && model.api_model);
  push(model && model.model_name);
  push(model && model.name);
  return out;
}

/** registry 里有没有这个模型的 ctx (含别名)。 */
function registryHit(model) {
  for (const id of _aliases(model)) {
    const ctx = modelRegistry.getContextLength(id);
    if (ctx) return { ctx, id };
  }
  return null;
}

/** 厂商账号 /models 接口里的官方窗口 (快, 可信源 provider-models-api)。 */
async function _fromProviderModels(model, opts) {
  try {
    const provider = String(model.provider || '').trim().toLowerCase();
    if (!provider) return null;
    const catalog = require('./llm_provider_catalog');
    const key = apiKeyResolver.resolveApiKey(model);
    if (!key) return null;
    const seed = {
      id: model.id,
      provider,
      protocol: modelTransport.normalizeProtocol(model),
      endpoint: modelTransport.endpointOf(model),
    };
    const result = await catalog.listAccountModels(seed, () => key, {});
    if (!result || !result.ok) return null;
    const names = new Set(_aliases(model).map(s => s.toLowerCase()));
    const entry = catalog.extractModelEntries(result.data)
      .find(e => names.has(String(e.id || '').toLowerCase()) || names.has(String(e.name || '').toLowerCase()));
    const ctx = entry && Number(entry.context_length);
    if (ctx > 0) {
      modelRegistry.setContextLength(model.id, ctx, 'provider-models-api', { provider: model.provider });
      return { ctx, source: 'provider-models-api' };
    }
  } catch (_) { /* 探不到就算了, 走下一档 */ }
  return null;
}

/** 输入上限真值探测 (慢, 但拿到的是厂商自己数的 token 数)。 */
async function _fromInputProbe(model, opts) {
  try {
    const probe = require('./ctx_input_probe');
    const r = await probe.probeInputLimit(model, {
      timeoutMs: opts.probeTimeoutMs || 90000,
      maxRounds: opts.maxRounds || 7,
    });
    if (r && r.context_length > 0) {
      modelRegistry.setContextLength(model.id, r.context_length, r.source || 'L3-input-probe', {
        measure: r.measure || 'v2-tokens',
        lower_bound: !!r.lower_bound,
      });
      return { ctx: r.context_length, source: r.source || 'L3-input-probe' };
    }
  } catch (e) {
    console.warn('[ctx-ensure] 输入上限探测失败:', model && model.id, e.message);
  }
  return null;
}

/**
 * 保证这个模型在 registry 里有 ctx 条目。
 * @returns {{ok:boolean, ctx:number|null, source:string}}
 */
async function ensureCtx(model, opts = {}) {
  if (!model || !model.id) return { ok: false, ctx: null, source: 'no-model' };
  const hit = registryHit(model);
  if (hit) return { ok: true, ctx: hit.ctx, source: 'registry' };

  if (opts.allowProvider !== false) {
    const p = await _fromProviderModels(model, opts);
    if (p) return { ok: true, ctx: p.ctx, source: p.source };
  }
  if (opts.allowProbe !== false) {
    const pr = await _fromInputProbe(model, opts);
    if (pr) return { ok: true, ctx: pr.ctx, source: pr.source };
  }
  return { ok: false, ctx: null, source: 'unknown' };
}

/**
 * 启动时扫一遍池子, 把缺 ctx 的补上。
 * 串行 (别把上游打爆), 而且**不阻塞启动** —— 调用方放后台跑。
 */
async function sweepMissingCtx(config, opts = {}) {
  const models = ((config && config.llm && config.llm.models) || []).filter(m => m && m.enabled !== false);
  const out = [];
  for (const m of models) {
    if (registryHit(m)) { out.push({ id: m.id, ok: true, source: 'registry' }); continue; }
    const r = await ensureCtx(m, opts);
    out.push({ id: m.id, ok: r.ok, ctx: r.ctx, source: r.source });
    if (!r.ok) {
      console.warn('[ctx-ensure] 拿不到 ctx, 热路径将退到保守值:', m.id);
    }
  }
  return out;
}

module.exports = { ensureCtx, sweepMissingCtx, registryHit };
