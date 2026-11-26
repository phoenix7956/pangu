'use strict';
// 唯一真源: 「这个模型 / 这个端点算不算本地」
//
// 2026-10-23 第 71 批。收口之前, 这个判断在主体里有 5 份实现、4 份 provider 名单:
//   api_key_resolver / llm_caller / j2_loop_shared / model_transport / model_cost
// 同一个模型在两个模块能算出**相反**的答案 —— 见下面 CUSTOM_PROVIDER 那段注释。
//
// 三种语义必须分开, 不能一刀切:
//   回环 (127/8 + ::1 + localhost + 0.0.0.0) —— 「就在这台机器上」
//   内网 (10./172.16-31./192.168./169.254./fc00::/7/.local) —— 「在公司网里」
//   provider 名单 —— 「这个运行器就是本地的」
// 超时口径看「回环 or 明确本地 provider」; 计费口径还要把内网算进来 (内网 ollama 也不按云端 token 计钱)。
//
// ── 2026-10-26 第 102 批: 加了第四个语义「自建」 ──────────────
//
// 「本地」这个词在代码里曾经有三套口径, 现在拆成两个**互不重叠**的概念:
//
//   回环 (loopback)   —— 就在这台机器上
//       用途: 免 API key (api_key_resolver.js 用这个口径)
//   自建 (self-hosted) —— 回环 **or 内网** (10./172.16-31./192.168./169.254./fc00::/7/.local)
//       + 用户显式声明的主机
//       用途: 输出软默认 (8192) + 长超时 (300s)
//
// 为什么「自建」要含内网 (**开源走法**):
//   开源推理服务 (ollama / vllm / llama.cpp / mlx / sglang / triton) 在现实里的
//   部署形态就是「一台机器 + 一个 OpenAI 兼容端点」, 而那台机器**经常不在本机** ——
//   家里的 NAS、机房里的 vLLM、公司内网的推理机, 地址都是 192.168.x.x。
//   所以「内网端点 = 自建推理服务」是开源生态的**默认事实**,
//   不该要求用户在模型条目上手写 local_output_tokens: 8192。
//
// ⚠️ 「免 API key」**仍然只认回环** —— 内网网关未必不要 key (api_key_resolver.js)。
//    这两个口径别混, 混了就等于「公司网里的东西一律免 key」。

// 明确是本地运行器的 provider。
// ⚠️ 'custom' **不在这里** —— custom 只说明「自建端点」, 本地与否完全由端点决定。
//    把 custom 当成本地, 云端自建端点 (agnes) 会拿到 300s 轮次超时, 失败检测被拖慢 5 倍。
const LOCAL_PROVIDERS = new Set([
  'lmstudio', 'lm-studio', 'lmstudio-community', 'lmstudio_local',
  'ollama', 'llamacpp', 'llama.cpp', 'llama-cpp',
  'vllm', 'mlx', 'mlx-serve', 'omlx',
]);

function endpointOf(model) {
  if (!model || typeof model !== 'object') return '';
  return String(model.endpoint || model.api_base || model.base_url || '').trim();
}

function hostOf(url) {
  try {
    // IPv6 的 hostname 带方括号 "[::1]" —— 去掉才能跟 '::1' 比。
    return new URL(String(url || '')).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch (_) { return ''; }
}

// 回环: 就在这台机器上。
function isLoopbackEndpoint(url) {
  const host = hostOf(url);
  if (!host) return false;
  if (host === '::1' || host === '0.0.0.0' || host === 'localhost') return true;
  // 整个 127.0.0.0/8 都是回环, 不只 127.0.0.1 (127.0.0.2 也是本机)。
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

// 内网: 在公司网/局域网里, 但不是本机。
function isPrivateEndpoint(url) {
  const host = hostOf(url);
  if (!host) return false;
  if (host.endsWith('.local')) return true;                       // mDNS
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;     // 链路本地
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;               // fc00::/7 唯一本地 IPv6
  return false;
}

// 回环 or 内网 —— 「不是公网」。
function isLocalEndpoint(url) {
  return isLoopbackEndpoint(url) || isPrivateEndpoint(url);
}

// 自建推理服务 (self-hosted) —— **开源走法**的口径。
//
// opts:
//   scope : 'private' (默认) —— 回环 + 内网都算自建
//           'loopback'        —— 只算回环 (给「内网里全是网关」的人收紧用)
//   hosts : 额外声明的主机名/IP (既不在回环也不在内网的自己的机器, 例如公网 IP 的自家机)
function isSelfHostedEndpoint(url, opts) {
  const o = opts || {};
  const rawScope = String(o.scope || 'private').trim().toLowerCase();
  const scope = rawScope === 'loopback' ? 'loopback' : 'private';
  const host = hostOf(url);
  if (!host) return false;
  if (isLoopbackEndpoint(url)) return true;
  // 用户显式声明的自建主机 (优先于 scope —— 声明是最新的事实)
  const hosts = Array.isArray(o.hosts) ? o.hosts : [];
  for (const h of hosts) {
    const t = String(h || '').trim().toLowerCase();
    if (!t) continue;
    if (t === host) return true;
    if (host.endsWith('.' + t)) return true;   // 子域也算
  }
  if (scope === 'loopback') return false;
  return isPrivateEndpoint(url);
}

function isLocalProvider(provider) {
  return LOCAL_PROVIDERS.has(String(provider || '').toLowerCase());
}

// 「这个模型是本地的」—— 超时/推理预算/并发闸门用这个口径。
// provider 明确是本地运行时, 或者端点在回环段。
// ⚠️ custom provider 的本地性**只看端点**: 生产池里 agnes-3.0-flash 就是
//    provider=custom + https://api.agnes-ai.cn/v1 (云端)。
//    收口之前 j2_loop_shared 把 custom 一律当本地 ⇒ 轮次超时 300s;
//    而 model_transport 判它是云端 ⇒ 60s。同一模型两个答案, 挂住时一个等 5 分钟一个等 1 分钟。
function isLocalModel(model) {
  if (!model || typeof model !== 'object') return false;
  if (isLocalProvider(model.provider)) return true;
  return isLoopbackEndpoint(endpointOf(model));
}

// 「本地 or 内网」—— 计费口径用: 内网跑的 ollama 也不按云端 token 计价。
function isLocalOrPrivateModel(model) {
  if (!model || typeof model !== 'object') return false;
  if (isLocalProvider(model.provider)) return true;
  return isLocalEndpoint(endpointOf(model));
}

module.exports = {
  LOCAL_PROVIDERS,
  endpointOf,
  hostOf,
  isLoopbackEndpoint,
  isPrivateEndpoint,
  isLocalEndpoint,
  isSelfHostedEndpoint,
  isLocalProvider,
  isLocalModel,
  isLocalOrPrivateModel,
};
