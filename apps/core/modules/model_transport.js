'use strict';

// Provider-neutral transport facts. Model IDs are Pangu-internal; providers
// receive the canonical name configured by the user (api_model/model_name/name).
function modelName(model) {
  if (!model) return '';
  return String(model.api_model || model.model_name || model.name || model.id || '').trim();
}

// Stable names used by newer callers; keep modelName as the legacy export.
const canonicalModelName = modelName;

function protocolOf(model) {
  if (!model) return 'openai';
  const explicit = String(model.protocol || model.api_protocol || '').trim().toLowerCase();
  if (explicit === 'anthropic-messages' || explicit === 'messages') return 'anthropic';
  if (explicit === 'ollama-native') return 'ollama';
  if (explicit === 'lmstudio' || explicit === 'lm-studio' || explicit === 'openai-chat' || explicit === 'openai-compatible' || explicit === 'chat-completions' || explicit === 'custom') return 'openai';
  if (explicit) return explicit;
  const provider = String(model.provider || '').toLowerCase();
  const endpoint = endpointOf(model).toLowerCase();
  if (provider === 'anthropic' || provider === 'claude' || /anthropic\.com|\/messages(?:\?|$)/.test(endpoint)) return 'anthropic';
  if (provider === 'ollama' || /(^|:)11434(?:\/|$)|\/api\/chat(?:\?|$)/.test(endpoint)) return 'ollama';
  return 'openai';
}

const normalizeProtocol = protocolOf;

function isAnthropic(model) {
  return protocolOf(model) === 'anthropic';
}

function authHeaders(model, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  const key = String(apiKey || '').trim();
  if (isAnthropic(model)) {
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

function endpointOf(model, fallback = '') {
  return String((model && (model.endpoint || model.api_base || model.base_url)) || fallback || '').trim();
}

function normalizeEndpoint(baseUrl, protocol = 'openai') {
  if (!baseUrl) return baseUrl;
  const clean = String(baseUrl).replace(/\/+$/, '');
  const proto = String(protocol || 'openai').toLowerCase();
  if (proto === 'ollama' || proto === 'ollama-native') {
    // Ollama exposes a native /api/chat endpoint, but Pangu's shared caller
    // and stream parser use the OpenAI-compatible contract. Keep runtime and
    // context probing on the same stable /v1/chat/completions path.
    if (/\/api\/chat(?:\?.*)?$/.test(clean)) {
      return clean.replace(/\/api\/chat(?:\?.*)?$/, '/v1/chat/completions');
    }
    if (/\/chat\/completions(?:\?.*)?$/.test(clean)) return clean;
    return clean.replace(/\/v\d+$/, '') + '/v1/chat/completions';
  }
  if (/\/(chat\/completions|messages|api\/chat)(\?.*)?$/.test(clean)) return clean;
  if (/\/v\d+$/.test(clean)) return clean + (proto === 'anthropic' ? '/messages' : '/chat/completions');
  if (proto === 'anthropic') return clean + '/v1/messages';
  // OpenAI-compatible is the common contract for LM Studio, Ollama, vLLM,
  // llama.cpp, gateways and cloud relays. A bare host gets /v1/chat/completions.
  return clean + '/v1/chat/completions';
}

function outputTokenCap(model, fallback = 32768) {
  // 2026-10-25 第 98 批: 原来这里是**第二份** provider cap 表 (只列 minimax/agnes),
  // 而 llm_caller.js 里还有第三份 (多列 lmstudio/ollama/vllm/llamacpp) —— 两份表已经在漂移:
  // 同一个模型在两条路径上算出**不同的**输出上限。
  // 现在统一走 model_capability 真源: 显式 max_output_tokens / max_tokens > 厂商档案 > 默认。
  try {
    const cap = require('./model_capability').maxOutputTokens(model, fallback);
    if (Number.isFinite(cap) && cap > 0) return Math.floor(cap);
  } catch (_) { /* 能力模块不可用 ⇒ 用调用方给的兜底 */ }
  return fallback;
}

// 2026-10-14 修 (本地 mlx-serve 120s socket timeout 打挂长任务 -> 盘古降级云端):
// socket timeout 以前只看 provider==='lmstudio'; 本地 mlx-serve 是 provider:'custom'+127.0.0.1 ->
// 漏判 -> 120s 熔断 -> 盘古 fallback 到云端 agnes 出答案, 用户以为"本地根本不能用" (LLM timeout 120.1s)。
// 判定改成"端点是不是 loopback/内网"优先: 本地端点给长超时; 云端自定义端点 (agnes 等
// https + provider custom) 不能误判本地, 否则失败检测被拖慢。provider 只作次要信号。
// 2026-10-23 第 71 批: 这份正则和这份 provider 名单收进 local_model 唯一真源。
// 旧正则自己抄了一份 (回环 + 内网 + .local), 跟 api_key_resolver / j2_loop_shared /
// model_cost 那几份各判各的 —— 现在统一走真源, 语义不变: 回环 or 内网 = 本地。
function isLocalEndpoint(ep) {
  try { return require('./local_model').isLocalEndpoint(ep); } catch (_) { return false; }
}
function isLocalModel(model) {
  try { return require('./local_model').isLocalOrPrivateModel(model); } catch (_) { return false; }
}
// 本地模型大 prompt + thinking 一轮常 >120s, 云端 60-120s 够用。model.timeout_ms 可显式覆盖。
function resolveRequestTimeoutMs(model, cloudMs, localMs) {
  // 2026-10-25 第 98 批: 原来用 isLocalModel (provider 名单**优先**于端点),
  // 而 llm_caller 的超时走的是新口径 (端点事实优先) —— 同一个模型两条路径两个答案。
  // 统一走 model_capability 的 timeoutMs (端点可解析就端点说了算),
  // 并保留调用方给的 cloud/local 兜底口径 (不同调用方默认值不同: 60s / 120s)。
  try {
    return require('./model_capability').timeoutMs(model, null, cloudMs, localMs);
  } catch (_) { /* 能力模块不可用 ⇒ 走老逻辑 */ }
  const configured = Number(model && model.timeout_ms);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return isLocalModel(model) ? localMs : cloudMs;
}

module.exports = {
  modelName,
  canonicalModelName,
  protocolOf,
  normalizeProtocol,
  isAnthropic,
  authHeaders,
  endpointOf,
  normalizeEndpoint,
  outputTokenCap,
  isLocalEndpoint,
  isLocalModel,
  resolveRequestTimeoutMs,
};
