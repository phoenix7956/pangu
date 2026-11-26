// modules/provider_detect.js — R88-generic / 第 101 批 (2026-10-26) 重写
//
// 按 endpoint URL **形状**识别协议与运行时 (host / port / path 三个维度),
// 不认品牌名, 不写死 model id, 不写死 key —— 任何 model 进来都识别。
//
// 2026-10-26 重写的原因 (旧版是正则拼的, 有三处真错):
//   1. 本地判定要求 URL **末尾没有路径** (`^https?://127.0.0.1(:\d+)?$`)
//      ⇒ `http://127.0.0.1:1234/v1` (OpenAI 兼容的标准写法) 判成云端
//      ⇒ LM Studio / Ollama 的原生探针在这种端点下**永远不触发**。
//   2. `host.endsWith('ollama.ai')` 把**云端** Ollama (host.ollama.ai) 判成本地。
//   3. 与 model_transport.protocolOf 判成两套协议 (同一端点两个答案)。
//
// 新口径:
//   「本地」= 回环端点 (local_model.isLoopbackEndpoint)
//   ⚠️ 2026-10-26 第 102 批补注: 这一份**故意只认回环**, 不是
//      model_capability.isSelfHostedByEndpoint (自建 = 回环 + 内网 + 显式声明)。
//      两个是**不同的语义**: 这份判的是「这个探针打得到吗」(内网探针也打得通,
//      但本地运行时的原探针与云端网关探针形状不同, 不能混), 那份判的是
//      「这个模型算不算自建推理服务」(超时 / 输出软默认用)。
//      之前这里写「与 isLocalByEndpoint 同一口径」—— 102 之后那句话开始骗人, 现在改掉。
//   「运行时」= 端点形状 (端口 / 路径特征) —— 加一个新运行时 = 加一行签名
//   「云端」= 兜底 OpenAI 兼容

'use strict';

// 回环判定**不复写**: local_model.js 是「本地与否」的唯一真源 (99/100 批定的规矩)。
// 在这里再抄一份正则, 就是同一个概念两套定义 —— 那正是本批要消灭的病。
let _isLoopbackEndpoint = null;
try {
  _isLoopbackEndpoint = require('./local_model').isLoopbackEndpoint;
} catch (_) { _isLoopbackEndpoint = null; }

function _isLoopback(url) {
  if (_isLoopbackEndpoint) {
    try { return !!_isLoopbackEndpoint(url); } catch (_) { /* 落到下面的兜底 */ }
  }
  // 兜底 (local_model 拿不到时): 与 local_model.isLoopbackEndpoint 同一口径
  let host = '';
  try { host = new URL(String(url || '')).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch (_) { return false; }
  if (!host) return false;
  if (host === '::1' || host === '0.0.0.0' || host === 'localhost') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

// 运行时签名表 —— **数据**, 不是判定分支。
// ports: 默认端口 (强信号) / paths: 原生 API 路径特征 (强信号)。
// 加一个本地运行时 = 加一行, 判定逻辑不动。
const RUNTIME_SIGNATURES = [
  {
    runtime: 'ollama',
    protocol: 'ollama',
    ports: [11434],
    paths: [/\/api\/(show|chat|tags|generate)\/?$/],
  },
  {
    runtime: 'lmstudio',
    protocol: 'lmstudio',
    ports: [1234],
    paths: [/\/api\/v0\/models\/?$/],
  },
];

function _parseEndpoint(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (_) { return null; }
  if (!u.hostname) return null;
  // hostname 对 IPv6 带方括号 ("[::1]"), 去掉才能跟 '::1' 比
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = u.port ? parseInt(u.port, 10) : 0;
  const path = String(u.pathname || '').toLowerCase();
  return { host, port, path, raw: String(raw) };
}

function detectProvider(model) {
  if (!model || !model.endpoint) return { provider: 'unknown', protocol: 'unknown' };
  const ep = _parseEndpoint(model.endpoint);
  if (!ep) return { provider: 'unknown', protocol: 'unknown' };
  const epLower = ep.raw.toLowerCase();

  // Anthropic 系列 (官方 + 第三方 Claude-compatible)
  if (/anthropic\.com$|claude/.test(ep.host) || /\/v1\/messages$/.test(epLower)) {
    return { provider: 'anthropic', protocol: 'anthropic-messages' };
  }

  // 运行时指纹: 端口 或 原生 API 路径 —— 与「本地/云端」正交。
  // (局域网里的 Ollama 也是 ollama; 云端 Ollama 也按形状判, 不按域名后缀判。)
  for (const sig of RUNTIME_SIGNATURES) {
    if (ep.port && sig.ports && sig.ports.includes(ep.port)) {
      return { provider: sig.runtime, protocol: sig.protocol };
    }
    if (sig.paths && sig.paths.some(re => re.test(ep.path))) {
      return { provider: sig.runtime, protocol: sig.protocol };
    }
  }

  // 回环 ⇒ 本机上的自建运行时 (具体是谁认不出)
  if (_isLoopback(ep.raw)) return { provider: 'local', protocol: 'openai-compatible' };

  // OpenAI-compatible 云端 (兜底最大类)
  return { provider: 'openai-compatible', protocol: 'openai-chat' };
}

module.exports = { detectProvider, RUNTIME_SIGNATURES };
