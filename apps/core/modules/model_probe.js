// modules/model_probe.js — R88-generic (round 2: 补老板点的 2 个洞)
// 真通用 = L3/L4 trial-and-error 是骨架, 任何 model 通用
// 任何 model (现在/未来/本地/fine-tune/小米/腾讯) 给 endpoint + chat-scope key 就跑
// 不依赖事先训过这个 model
//
// Round 2 老板点的 2 个洞 (修):
//   洞 1: L3/L4 不验证响应, 看 status 200 就当"过" (API silent truncate 假阳性)
//   修: 查 usage.prompt_tokens ≥ sizeChars × 0.9 + finish_reason != 'length'
//   洞 2: L5 config-hint 跟 R88-generic 哲学冲突, 读了 m.context_length 等于 config 硬编码
//   修: 必须显式 m._user_override_context_length = true 才返, 否则 null (fail-loud)
//
// 架构:
//   - registerProbe({ name, fn, priority })  任何 fn 都能挂
//   - 默认注册: L3-chat + L4-messages (骨架, vendor-agnostic, 永远跑)
//   - 按需注册: L1-models-field / L2-lmstudio / L2-ollama / L5-user-override (优化, 我(墨)写, 不知道就不写)
//   - probeContextLength(m) 并发跑所有 fn, 第一个非空胜出, 写 cache
//   - 全 null → throw, 不 silently 32K
//   - CANDIDATES 扩到 16K-16M 覆盖 Llama 4 Scout (10M) 那种怪兽 model

'use strict';
const http = require('http');
const https = require('https');
const modelRegistry = require('./model_registry');
const { detectProvider } = require('./provider_detect');
const { resolveApiKey, isLocalEndpoint } = require('./api_key_resolver');
const {
  canonicalModelName,
  isAnthropic,
  authHeaders,
} = require('./model_transport');

// Context-length probing tri-state:
//   true  = candidate accepted
//   false = explicit context-exceeded error (search smaller)
//   null  = inconclusive (auth / network / 404 / parse failure): abort probe,
//           never guess a smaller window from non-context failures.
const CTX_EXCEEDED_RE = /context_length_exceeded|context window (exceeds|limit|too|overflow)|maximum context length|prompt is too long|reduce the length|context length|too many tokens|exceeds the (maximum )?context/i;

function _probeKey(m) {
  if (!m || !m.endpoint) return null;
  const key = resolveApiKey(m);
  if (typeof key !== 'string') return null;
  if (key === '' && !isLocalEndpoint(m.endpoint)) return null;
  return key;
}

const PROBE_TIMEOUT_MS = 60000;
// 候选覆盖 16K ~ 16M (从 16K 起步覆盖 32K-1M 主流, 加 4M/16M 覆盖 Llama 4 Scout 10M 这种)
const CANDIDATES = [16384, 65536, 262144, 1048576, 4194304, 16777216];

// Endpoint contract: config may store a provider base (/v1), a full OpenAI
// chat-completions URL, or an Anthropic messages URL. Probes must normalize
// these forms before appending paths; otherwise every cloud model can probe a
// duplicated path such as /chat/completions/chat/completions.
function _endpointParts(endpoint) {
  const raw = String(endpoint || '').replace(/\/$/, '');
  let u;
  try { u = new URL(raw); } catch (_) { return null; }
  const path = u.pathname.replace(/\/+$/, '');
  const origin = u.origin;
  const isOpenAIChat = /\/chat\/completions$/.test(path);
  const isAnthropicMessages = /\/messages$/.test(path);
  const basePath = path.replace(/\/chat\/completions$|\/messages$/, '');
  const base = origin + (basePath || '');
  const v1Base = basePath.endsWith('/v1') ? base : base + '/v1';
  return {
    chat: isOpenAIChat ? raw : v1Base + '/chat/completions',
    messages: isAnthropicMessages ? raw : v1Base + '/messages',
    models: v1Base + '/models',
    origin,
  };
}

function _apiModelId(m) {
  return String((m && (m.api_model || m.model_name || m.name)) || (m && m.id) || '');
}

// ===== 通用 probe registry =====
const _probes = [];

function registerProbe({ name, fn, priority = 100 }) {
  if (typeof fn !== 'function') throw new Error('registerProbe: fn must be function');
  const idx = _probes.findIndex(p => p.name === name);
  if (idx >= 0) _probes.splice(idx, 1);
  _probes.push({ name, fn, priority });
  _probes.sort((a, b) => a.priority - b.priority);
  console.log('[probe-registry] registered', name, 'priority=' + priority);
}

function listProbes() { return _probes.map(p => ({ name: p.name, priority: p.priority })); }

// ===== HTTP helper =====
function _httpReq(method, url, body, extraHeaders) {
  return new Promise((resolve) => {
    let u, lib, opts;
    try {
      u = new URL(url);
      lib = u.protocol === 'https:' ? https : http;
      opts = {
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method,
        headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
        timeout: PROBE_TIMEOUT_MS,
      };
    } catch (_) { return resolve({ status: 0, body: '' }); }
    if (body !== undefined) {
      const bs = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(bs);
    }
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ status: 0, body: '' }); });
    if (body !== undefined) {
      const bs = typeof body === 'string' ? body : JSON.stringify(body);
      req.write(bs);
    }
    req.end();
  });
}

// ===== 响应验证 (老板点穿的洞 1) =====
// R88-generic 关键修复: 不能只看 status 200
// 1) status 200/201 才算 API 接受
// 2) 如果服务返回 usage, 只记录它; 不能把 token 数和输入字符数比较。
//    重复的 ASCII 字符会被 tokenizer 高度压缩, prompt_tokens 远小于 sizeChars 是正常现象。
// 3) finish_reason != 'length' → 响应没被 ctx 不够截断
// 4) OpenAI / Anthropic 协议两者字段名不同, 都要查
function _validateResponse(r, sizeChars) {
  if (r.status !== 200 && r.status !== 201) return { ok: false, reason: 'http-' + r.status };
  let body; try { body = JSON.parse(r.body); } catch (_) { return { ok: false, reason: 'parse-fail' }; }
  // OpenAI-compatible: usage.prompt_tokens
  // Anthropic: usage.input_tokens
  // 一些自定义: usage.tokens.input
  const usage = body.usage || {};
  // finish_reason: 'stop' (正常) / 'length' (ctx 截断) / 'tool_calls' / 'content_filter'
  const finishReason = body.choices?.[0]?.finish_reason
    || body.stop_reason   // Anthropic 协议
    || body.choices?.[0]?.stop_reason
    || 'unknown';
  // 1) HTTP 2xx + 可解析响应即表示模型接受了该输入。
  // usage 缺失也不能判失败: LM Studio/Ollama/部分云端兼容层不会返回 usage。
  // `max_tokens: 1` is intentional for probing. Providers commonly report
  // finish_reason=length/max_tokens when that output cap is reached; it does
  // not mean the input exceeded the model context. HTTP 2xx already proves the
  // candidate input was accepted, so keep these responses successful.
  return { ok: true, promptTokens: usage.prompt_tokens || usage.input_tokens || null, sizeChars, finishReason };
}

// ============================================================
// 骨架 probe (L3/L4) — vendor-agnostic, 永远注册
// 任何 model 任何 vendor 任何协议, 给 chat-scope key 就能试
// 这是 R88 真正的"agent 最基本的能力"
// Round 2: 加 _validateResponse, 防 silent truncate 假阳性
// ============================================================

// ===== 三值判定 (verdict) =====
// pass         — 模型接受该输入 (2xx + 可解析)
// fail-ctx     — 明确上下文超限 (二分往小)
// inconclusive — 认证/网络/404/超时: 与上下文无关, 停止探测
// promptTokens  — pass 时模型实际消化的 token 数 (usage 实测).
//   候选是"字符数", 但注册表必须存"token 数": 'x'×4.2M 字符只约 524K token,
//   把字符数当 token 写 registry 会虚报 4096K (官方 1M 的 M3 就曾被这样误报).

// 2026-09-15 agens 实案: 部分网关 (agnes-ai.cn) 在 400 里直接报真上限:
//   "The input (524362 tokens) is longer than the model's context length (524288 tokens)."
// 提取出 contextUpper, 精化阶段直接用, 不再二分瞎猜.
function _extractCtxLimit(body) {
  if (typeof body !== 'string') return null;
  let m = body.match(/context length \((\d+)\s*tokens/i);
  if (m) return parseInt(m[1], 10);
  m = body.match(/longer than [^(]*context[^\)]*\((\d+)/i);
  if (m) return parseInt(m[1], 10);
  m = body.match(/(?:max(?:imum)? context length|max context window|context window limit)(?: is| of| =)?\s*(\d{4,7})/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

function _testChat(m, sizeChars) {
  const probeKey = _probeKey(m);
  if (probeKey === null) return Promise.resolve(null);
  const parts = _endpointParts(m.endpoint);
  if (!parts) return Promise.resolve(null);
  const url = parts.chat;
  const body = { model: canonicalModelName(m), messages: [{ role: 'user', content: 'x'.repeat(sizeChars) }], max_tokens: 1 };
  const headers = authHeaders(m, probeKey);
  return _httpReq('POST', url, body, headers)
    .then(r => {
      if (r.status === 400 && CTX_EXCEEDED_RE.test(r.body)) return { verdict: 'fail-ctx', promptTokens: null, sizeChars, contextUpper: _extractCtxLimit(r.body) };
      if (r.status === 0 || r.status === 401 || r.status === 403 || r.status === 404) return { verdict: 'inconclusive', promptTokens: null, sizeChars };
      const v = _validateResponse(r, sizeChars);
      return v.ok
        ? { verdict: 'pass', promptTokens: v.promptTokens, sizeChars }
        : { verdict: 'inconclusive', promptTokens: null, sizeChars };
    });
}

function _testMessages(m, sizeChars) {
  if (!isAnthropic(m)) return Promise.resolve(null);
  const probeKey = _probeKey(m);
  if (probeKey === null) return Promise.resolve(null);
  const parts = _endpointParts(m.endpoint);
  if (!parts) return Promise.resolve(null);
  const url = parts.messages;
  const body = { model: canonicalModelName(m), max_tokens: 1, messages: [{ role: 'user', content: 'x'.repeat(sizeChars) }] };
  return _httpReq('POST', url, body, authHeaders(m, probeKey)).then(r => {
    if (r.status === 400 && CTX_EXCEEDED_RE.test(r.body)) return { verdict: 'fail-ctx', promptTokens: null, sizeChars, contextUpper: _extractCtxLimit(r.body) };
    if (r.status === 0 || r.status === 401 || r.status === 403 || r.status === 404) return { verdict: 'inconclusive', promptTokens: null, sizeChars };
    const v = _validateResponse(r, sizeChars);
    return v.ok
      ? { verdict: 'pass', promptTokens: v.promptTokens, sizeChars }
      : { verdict: 'inconclusive', promptTokens: null, sizeChars };
  });
}

// 精化: 在 [最后成功, 首个失败] 的字符区间做 log2 二分 (最多 4 次),
// 让实测 prompt_tokens 尽量贴近真实窗口 (M3: 4.19M 字符→524K 太粗,
// 精化到 7.8M 字符≈983K, 几何插值后 ≈1M, 与官方一致).
async function _refineWindow(test, passEntry, failChars, entry = passEntry) {
  if (failChars == null) return passEntry;
  let a = passEntry.chars, b = failChars;
  let measured = passEntry.promptTokens;
  if (typeof failChars === 'number' && failChars > 0) measured = entry.contextUpper != null ? entry.contextUpper : measured;
  if (passEntry.contextUpper != null) {
    // 网关报了真上限: 一次确认即可 (上限下方 99.8% 档 pass)
    const confirm = await test(Math.floor(passEntry.contextUpper * 16 * 0.998 / 16 * 16));
    return { chars: passEntry.chars, promptTokens: measured, failChars: passEntry.contextUpper * 16, contextUpper: passEntry.contextUpper };
  }
  let la = Math.log2(a), lb = Math.log2(b);
  for (let i = 0; i < 4; i++) {
    const lm = (la + lb) / 2;
    const mid = Math.round(Math.pow(2, lm));
    if (mid <= a || mid >= b) break;
    let r = await test(mid);
    if (!r) break;
    if (r.verdict === 'inconclusive') {
      await new Promise(r2 => setTimeout(r2, 3000));
      r = await test(mid);
      if (!r || r.verdict === 'inconclusive') break;
    }
    if (r.verdict === 'pass') { a = mid; la = lm; if (r.promptTokens != null) measured = r.promptTokens; }
    else { b = mid; lb = lm; }
  }
  return { chars: a, promptTokens: measured, failChars: b };
}

// 注册表存 token 域数值: 网关报错里报了真上限 (contextUpper) 直接采纳;
// 否则优先 usage 实测; 有失败上界时几何插值取中; 无 usage 时 4 字符/token 保守折算.
function _estimateWindowTokens(entry) {
  if (!entry) return null;
  if (typeof entry.contextUpper === 'number' && entry.contextUpper > 0) return entry.contextUpper;
  if (entry.promptTokens != null) {
    let v = entry.promptTokens;
    if (entry.failChars != null && entry.failChars > entry.chars) {
      const upper = v * (entry.failChars / entry.chars);
      v = Math.round(Math.sqrt(v * upper));
    }
    return v;
  }
  if (entry.chars != null) return Math.round(entry.chars / 4);
  return null;
}

// 通用骨架二分: 粗扫 CANDIDATES → 精化 → token 估算
async function _binarySearchWindow(test, m) {
  const probeKey = _probeKey(m);
  if (probeKey === null) return null;
  let lastPass = null, lastFail = null;
  let _lastFailUpper = null;
  let lo = 0, hi = CANDIDATES.length - 1;
  while (lo <= hi) {
    const size = CANDIDATES[Math.floor((lo + hi) / 2)];
    const r = await test(m, size);
    if (!r) break;
    if (r.verdict === 'pass') { lastPass = { chars: size, promptTokens: r.promptTokens }; lo = Math.floor((lo + hi) / 2) + 1; }
    else if (r.verdict === 'fail-ctx') {
      lastFail = size; hi = Math.floor((lo + hi) / 2) - 1;
      if (typeof r.contextUpper === 'number') _lastFailUpper = r.contextUpper;
    }
    else {
      // 不可判定 (认证/网络/404/超时/瞬时 4xx): 重试一次再下结论 —
      // 云端 API 偶发 400/500 会误杀精化, 一次短延迟重试可以保住区间
      await new Promise(r2 => setTimeout(r2, 3000));
      const r2 = await test(m, size);
      if (!r2 || r2.verdict === 'inconclusive') break;
      if (r2.verdict === 'pass') { lastPass = { chars: size, promptTokens: r2.promptTokens }; lo = Math.floor((lo + hi) / 2) + 1; }
      else { lastFail = size; hi = Math.floor((lo + hi) / 2) - 1; if (typeof r2.contextUpper === 'number') _lastFailUpper = r2.contextUpper; }
    }
  }
  if (!lastPass) {
    // 全 fail 但网关报了上限 (agens 实案: 仅 4194304 字符档 fail, 400 里报 524288)
    if (_lastFailUpper) return _lastFailUpper;
    return null;
  }
  const entry = { ...lastPass };
  if (_lastFailUpper) entry.contextUpper = _lastFailUpper;
  const refined = await _refineWindow(sz => test(m, sz), entry, lastFail, entry);
  return _estimateWindowTokens(refined);
}

async function _probeL3Chat(m) {
  return _binarySearchWindow(_testChat, m);
}

async function _probeL4Messages(m) {
  return _binarySearchWindow(_testMessages, m);
}

// ============================================================
// 优化 probe (L1/L2/L5) — vendor-specific, 按需注册
// 知道的 vendor 就写, 不知道就不写
// ============================================================

// L1: 标准 /v1/models 字段
async function _probeL1ModelsField(m) {
  const probeKey = _probeKey(m);
  if (probeKey === null) return null;
  const parts = _endpointParts(m.endpoint);
  if (!parts) return null;
  const url = parts.models;
  const r = await _httpReq('GET', url, undefined, authHeaders(m, probeKey));
  if (r.status !== 200) return null;
  let data; try { data = JSON.parse(r.body); } catch (_) { return null; }
  const list = Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : []);
  const apiId = _apiModelId(m);
  const hit = list.find(x => x && (x.id === m.id || x.id === apiId || x.id === m.name)) || null;
  if (!hit) return null;
// context_length 排最前: mlx-serve /v1/models 报的就是这个字段 (2026-10-13 实测),
// 漏了它 → ddalcu_qwen3.8-27b-mlx-serve-4bit 永远 registry miss, 报"model context not discoverable"。
// 字段集与 llm_provider_catalog.extractModelEntries 保持一致, 两边认同一批名字。
const v = hit.context_length || hit.context_window || hit.max_model_len || hit.max_context_length || hit.loaded_context_length || null;
  return (typeof v === 'number' && v > 0) ? v : null;
}

// L2 原生运行时探针策略表 -- **数据**, 不是散落的 if。
//
// 2026-10-26 第 101 批: 原来 L2a (Ollama) / L2b (LM Studio) 是两个各写各的
// 函数, 门卫和干活逻辑缠在一起 -- 再加一个本地运行时 (llamafile / sglang /
// triton) 就要把「判端点 / 发请求 / 解析 ctx」三段式复制一遍。
// 现在拆成: 策略表 (怎么问) + 通用包装 (门卫 + 调度)。
// 加一个运行时探针 = 表里加一行 + 注册一个探针函数, 包装层不动。
//
// 门卫**必须**在函数体内调 detectProvider (不能在模块加载时算好):
// tests/model-probe-compat.test.js 靠替换 require.cache 里的 provider_detect
// 来稳定复现一个随机端口的 LM Studio; 门卫若提前算, 那个用例就假绿。
const L2_RUNTIME_PROBES = {
  ollama: {
    runtime: 'ollama',
    async probe(m, parts) {
      const url = parts.origin + '/api/show';
      const r = await _httpReq('POST', url, { name: m.id }, {});
      if (r.status !== 200) return null;
      let data; try { data = JSON.parse(r.body); } catch (_) { return null; }
      const mi = data.model_info || {};
      return mi['llama.context_length'] || mi.context_length || null;
    },
  },
  lmstudio: {
    runtime: 'lmstudio',
    async probe(m, parts) {
      const url = parts.origin + '/api/v0/models';
      const r = await _httpReq('GET', url, undefined, {});
      if (r.status !== 200) return null;
      let data; try { data = JSON.parse(r.body); } catch (_) { return null; }
      const list = Array.isArray(data.data) ? data.data : [];
      const hit = list.find(x => x && (x.id === m.id || x.id === m.name)) || null;
      if (!hit) return null;
      // 2026-10-14 修: 只认**真的加载着**的模型。
      // /api/v0/models 列的是下载到本地库的全部模型, 含 state=not-loaded 的;
      // 它的 max_context_length 是磁盘上那份权重的标称值, 跟端点当前能不能服务它
      // 完全无关 -- LM Studio 甚至会照着这个字段报 No LM Runtime found for model
      // format safetensors。
      // 之前把 max_context_length 当已验证真源 (标 _ctx_source_label: 本地真源),
      // 于是没加载的模型也拿到了 262144, 盘古据此排上下文/算 max_tokens,
      // 然后真去调用时端点回 No models loaded -- ctx 是假的, 结论是错的。
      if (hit.state && hit.state !== 'loaded') return null;
      // loaded_context_length 才是此刻真跑着的窗口; 只有它才可信。
      const v = hit.loaded_context_length;
      return (typeof v === 'number' && v > 0) ? v : null;
    },
  },
};

// 通用 L2 包装: 门卫 = detectProvider 判出的运行时, 干活 = 策略表。
async function _probeL2Runtime(runtime, m) {
  if (!m.endpoint) return null;
  if (detectProvider(m).provider !== runtime) return null;
  const strat = L2_RUNTIME_PROBES[runtime];
  if (!strat) return null;
  const parts = _endpointParts(m.endpoint);
  if (!parts) return null;
  return strat.probe(m, parts);
}

// L2a: Ollama
async function _probeL2Ollama(m) { return _probeL2Runtime('ollama', m); }

// L2b: LM Studio
async function _probeL2LMStudio(m) { return _probeL2Runtime('lmstudio', m); }

// L5: user-override opt-in (老板点的洞 2)
// R88-generic 关键修复: 不读 m.context_length 隐式 fallback, 必须显式 opt-in
// 防止"假通用" — your-mac.json 里手填的 32K 不能再当通用 ctx 假装被 L5 探到
// 用法: 用户 (老板) 显式设 m._user_override_context_length = true 才生效
async function _probeL5UserOverride(m) {
  // Round 2: 必须显式 opt-in, 否则 null (fail-loud, 让 L3/L4 去探)
  if (m._user_override_context_length === true
      && typeof m.context_length === 'number'
      && m.context_length > 0) {
    return m.context_length;
  }
  return null;
}

// L0: 网关 400 报错真上限 (MiniMax/agnes 实案: 厂商 models API 不报 context 字段,
// 但 agnes 网关 400 里明确报 "context length (524288 tokens)" → 直接读真值, 比二分估算准.
// MiniMax 网关 400 报 "context window exceeds limit (2013)" 不带数字 → L0 读不到, 自动落 L3 估算.
// 发送 5.24M 字符 (≈655K token), 顶穿 512K 档上限; 只读 400 里的 contextUpper, 2xx → null (走 L3 二分).
async function _probeL0GatewayUpper(m) {
  const probeKey = _probeKey(m);
  if (probeKey === null) return null;
  const parts = _endpointParts(m.endpoint);
  if (!parts) return null;
  const useMessages = isAnthropic(m);
  const test = useMessages ? _testMessages : _testChat;
  const r = await test(m, 5242880);
  if (r && r.verdict === 'fail-ctx' && typeof r.contextUpper === 'number' && r.contextUpper > 0) {
    return r.contextUpper;
  }
  return null;  // MiniMax 类网关 400 不带数字 → L3 二分兜底
}

// ============================================================
// 默认注册
//   L3/L4 骨架 (永远在, vendor-agnostic)
//   L1/L2/L5 优化 (按需)
//   L0 网关 400 真上限 (厂商 API 不报 context 字段时, 读网关报错真值)
// ============================================================
// 优先级: 厂商 models API (L1=10) > 网关 400 真上限 (L0=25) > LM Studio/Ollama (L2=20 本地真值) >
//          二分估算 (L3/L4) > 模型自报显式 override (L5=60, 会答错, 垫底)
registerProbe({ name: 'L3-chat-probe',      fn: _probeL3Chat,        priority: 30 });
registerProbe({ name: 'L4-messages-probe',  fn: _probeL4Messages,    priority: 40 });
registerProbe({ name: 'L1-models-field',    fn: _probeL1ModelsField, priority: 10 });
// L2 原生运行时探针**从策略表自动注册** (2026-10-26 第 101 批):
// 表里加一行 = 多一个探针, 这里不用动。探针名保持 L2-<runtime> (与
// probeContextLength 的 trustedSources 白名单对齐)。
for (const _runtime of Object.keys(L2_RUNTIME_PROBES)) {
  registerProbe({
    name: 'L2-' + _runtime,
    fn: (m) => _probeL2Runtime(_runtime, m),
    priority: 20,
  });
}
registerProbe({ name: 'L0-gateway-upper',   fn: _probeL0GatewayUpper, priority: 25 });
registerProbe({ name: 'L5-user-override',   fn: _probeL5UserOverride, priority: 60 });

// 2026-10-13: 本地端点不跑 padding 探针。L0/L3/L4 靠发 1-5MB 重复字符 padding 二分出 ctx,
// 单请求 50s+ (本机 mlx-serve 实测 48-67s), 而本地服务并发槽通常只有 1。后果有两条:
//   1) 占满槽位, 正常聊天请求全排队;
//   2) 触发 mlx-serve 26.9.4 的堆损坏 —— 2026-10-13 21:44 崩在 tokenizer.bpeMerge、
//      21:54 崩在 jinja::parser, 两次都是 BUG IN CLIENT OF LIBMALLOC (渐进式越界, 落点随机)。
// 本地服务 (LM Studio / mlx-serve / Ollama) 的 /models 一般自带 context_length, 走 L1/L2 就够;
// 真探不到就回退 stale registry, 而不是拿 MB 级 padding 硬探。
const PADDING_PROBES = new Set(['L0-gateway-upper', 'L3-chat-probe', 'L4-messages-probe']);

// ============================================================
// 主入口: 并发跑所有注册的 probe, 第一个非空胜出, 写 cache, 返
// 任何 model (现在/未来/本地/fine-tune/小米/腾讯) 走同一套
// ============================================================
async function probeContextLength(m) {
  if (!m || !m.id) throw new Error('model_probe: model.id required');

  // 0) cache 先 (只信 token 域测量: 带 v2-tokens 标记, 或来自原生 token 接口的 L1/L2/L5.
//    旧版 L3/L4 把"接受的输入字符数"当 context_length 存, 必须重探.)
  const cached = modelRegistry.getContextLength(m.id);
  const cachedInfo = modelRegistry.getModelInfo(m.id);
  // 可信来源: L1 厂商 models API / L2 本地真值 / L0 网关400真上限 / provider-models-api 官方值.
  // L5 (模型自报) 会答错 → 不单独可信, 只在没有任何可信值时兜底.
  const trustedSources = ['L1-models-field', 'L2-lmstudio', 'L2-ollama', 'L0-gateway-upper', 'provider-models-api', 'cache'];
  const cachedTrusted = cached && cachedInfo && (cachedInfo.measure === 'v2-tokens' || trustedSources.includes(cachedInfo.source));
  if (cachedTrusted) {
    return { context_length: cached, source: 'cache' };
  }
  // 2026-09-16 老板拍 "上下文从模型处自己拿": 自报只在无可信值时兜底 (自报会答错, 不能盖 L0/L1/L2 真值)
  const selfCtx = (m._self_report && typeof m._self_report.ctx === 'number' && m._self_report.ctx > 0) ? m._self_report.ctx : null;
  if (selfCtx !== null) {
    modelRegistry.setContextLength(m.id, selfCtx, 'L5-user-override', { measure: 'v2-tokens' });
    console.log('[ctx-autodetect]', m.id, '→', selfCtx, '(self-report 兜底, 无更可信值)');
    return { context_length: selfCtx, source: 'self-report' };
  }

// 1) 并发跑所有注册的 probe (本地端点剔除 padding 探针, 见 PADDING_PROBES 注释)
const probes = isLocalEndpoint(m.endpoint) ? _probes.filter(p => !PADDING_PROBES.has(p.name)) : _probes;
if (probes.length !== _probes.length) {
console.log('[ctx-autodetect] local endpoint ' + m.endpoint + ' — skip '
+ _probes.filter(p => PADDING_PROBES.has(p.name)).map(p => p.name).join(', ')
+ ', use [' + probes.map(p => p.name).join(', ') + ']');
}
const results = await Promise.allSettled(probes.map(p => p.fn(m)));
for (let i = 0; i < results.length; i++) {
const r = results[i];
const name = probes[i].name;
    if (r.status === 'fulfilled' && typeof r.value === 'number' && r.value > 0) {
      const v = r.value;
      // L1/L2/L5 值本来就是 token 域 (厂商接口/用户显式声明), L3/L4 是新测得的 token 估算
      modelRegistry.setContextLength(m.id, v, name, { measure: 'v2-tokens' });
      return { context_length: v, source: name };
    }
  }

  // 2) 全 fail → 先回退 stale registry 值, 没有再 throw
  const staleContext = modelRegistry.getContextLength(m.id);
  if (staleContext) {
    console.warn('[model-probe] all live probes failed for ' + m.id + '; using stale registry value ' + staleContext);
    return { context_length: staleContext, source: 'cache-stale' };
  }
const reasons = results.map((r, i) => `${probes[i].name}=${r.status === 'fulfilled' ? (r.value === null ? 'no-data' : r.value) : r.reason?.message || 'err'}`).join(', ');
  throw new Error(`all probes failed for ${m.id} (${reasons})`);
}

module.exports = {
  probeContextLength,
  registerProbe,
PADDING_PROBES,
  listProbes,
  _probeL3Chat, _probeL4Messages, _probeL1ModelsField, _probeL2LMStudio, _probeL2Ollama, _probeL5UserOverride,
  L2_RUNTIME_PROBES,
  _validateResponse,
  _testChat,
  _testMessages,
  _endpointParts,
  _apiModelId,
  CANDIDATES,
};
