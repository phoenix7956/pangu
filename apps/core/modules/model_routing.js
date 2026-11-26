'use strict';
// modules/model_routing.js — 延迟感知的认知模型路由 (第 111 批)
//
// 为什么有它 —— 2026-10-26 在这台 Mac 上实测:
//   主控 MacBook 是共享屏主机: Screen Sharing 常驻 ~27% CPU, WindowServer ~29%,
//   本机 LM Studio 的 27B 在这个负载下: 首字 2.2s~6.5s, 长 prompt 更慢
//   (实测端到端 21.8s, 负载高峰直接 90s 超时);
//   同一时刻云端: minimax-m3 首字 498ms / 总 1.0s, agnes-3.0-flash 628ms, k3 1061ms。
//   ⇒ 结论不是"叫老板关共享屏"(那是老板的工作环境), 而是主路径不该押在本机 GPU 上。
//
// 机制 (配置驱动, 不写死任何厂商):
//   llm.routing.policy = 'off' | 'manual' | 'auto'
//     off    —— 完全不探针。认知模型只由用户显式选择决定 (开源默认值 = 零意外)
//     manual —— 探针只用来报告慢, 不自动换
//     auto   —— 探针 + 选主路径: 质量档优先, 档内按速度; 上档不可用才降档
//   质量档用模型条目已有的 quality_score (没有就当未知档), 不另造打分表。
//
// 三条硬规矩:
//   1. 用户显式切过的模型, auto 不动它 (routing.manual_pinned) —— 除非它连不上。
//      否则「老板刚点了个模型, 盘古转头又换掉」比慢更烦人。
//   2. 探针结果带 TTL 缓存 (~/.pangu/routing-state.json) —— 不烧额度, 不拖慢启动。
//   3. 拿 key 只走 api_key_resolver —— 探针和运行时同一条链, 不许自己读明文。

const fs = require('fs');
const path = require('path');
const os = require('os');

const apiKeyResolver = require('./api_key_resolver');
const modelTransport = require('./model_transport');

const STATE_DIR = path.join(os.homedir(), '.pangu');
const STATE_FILE = path.join(STATE_DIR, 'routing-state.json');

// 探针默认参数 (配置可覆盖)
const DEFAULTS = {
  maxFirstTokenMs: 2500,
  probeTimeoutMs: 10000,
  cacheTtlMs: 6 * 3600 * 1000,
  probePrompt: '说一个字',
  // 2026-10-26: 探针必须**按 token 量**发, 不能只发一个字 ——
  //   本地 27B 慢就慢在 prefill (16K token 的真实提示词), 一个字的 prompt 测不出来
  //   (实测: 一字 prompt 本地首字 1.7s, 真跑 16K token 的对话直接 21.8s+)。
  //   2K token 的探针既能压出 prefill 成本, 又不至于把额度烧穿。
  probePromptTokens: 2000,
  maxTokens: 64,
};

// 按目标 token 数拼一段填充提示 (中文 ≈ 1 字 1 token, 够用)。
// 刻意不重复整句: 全一样的重复串会命中各家 provider 的 prompt cache,
// 测出来的是"缓存命中速度", 不是真实 prefill 成本。
const _FILLER = '这是一段用于测速的填充内容, 目的是让预填充成本真实可见。';
function _buildProbePrompt(targetTokens) {
  const n = Math.max(1, Math.floor(Number(targetTokens) || 0));
  if (n <= 8) return '说一个字';
  const per = _FILLER.length;
  const reps = Math.ceil(n / per);
  let s = '';
  for (let i = 0; i < reps; i++) s += _FILLER + (i % 7) + ' ';
  return s.slice(0, n * 2);
}

function routingCfg(config) {
  const r = (config && config.llm && config.llm.routing) || {};
  const pol = String(r.policy || '').trim().toLowerCase();
  const policy = ['off', 'manual', 'auto'].includes(pol) ? pol : 'manual';
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    policy,
    maxFirstTokenMs: num(r.max_first_token_ms, DEFAULTS.maxFirstTokenMs),
    probeTimeoutMs: num(r.probe_timeout_ms, DEFAULTS.probeTimeoutMs),
    cacheTtlMs: num(r.cache_ttl_ms, DEFAULTS.cacheTtlMs),
    probePrompt: String(r.probe_prompt || DEFAULTS.probePrompt),
    probePromptTokens: num(r.probe_prompt_tokens, DEFAULTS.probePromptTokens),
    maxTokens: num(r.probe_max_tokens, DEFAULTS.maxTokens),
    manualPinned: !!r.manual_pinned,
    pinnedModelId: String(r.pinned_model_id || ''),
  };
}

// ---------------------------------------------------------------- 探针

// SSE / JSON 里"模型开始吐字"的判据。
// 注意: 别用正则扫全文找 content —— 本地那类 thinking 模型先来的是
//       reasoning_content, 扫 content 会把"开始思考"误判成"还没开口"。
function _deltaText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const chs = Array.isArray(obj.choices) ? obj.choices : [];
  let out = '';
  for (const ch of chs) {
    const d = ch && (ch.delta || ch.message);
    if (!d) continue;
    if (typeof d.content === 'string') out += d.content;
    else if (Array.isArray(d.content)) {
      for (const p of d.content) if (p && typeof p.text === 'string') out += p.text;
    }
    if (typeof d.reasoning_content === 'string') out += d.reasoning_content;
    if (typeof d.reasoning === 'string') out += d.reasoning;
  }
  // Anthropic 流式
  if (obj.type === 'content_block_delta' && obj.delta && typeof obj.delta.text === 'string') out += obj.delta.text;
  return out;
}

function _parseSseLine(line) {
  const s = String(line || '').trim();
  if (!s || s.startsWith(':')) return null;
  const payload = s.startsWith('data:') ? s.slice(5).trim() : s;
  if (!payload || payload === '[DONE]') return null;
  try { return JSON.parse(payload); } catch (_) { return null; }
}

async function _probeOne(model, opts) {
  const id = String((model && model.id) || '');
  const timeoutMs = opts.timeoutMs || DEFAULTS.probeTimeoutMs;
  const t0 = Date.now();
  const res0 = { id, ok: false, ms_first: null, ms_text: null, ms_total: null, error: '', skipped: false, ts: Date.now() };

  const endpoint = modelTransport.normalizeEndpoint(
    modelTransport.endpointOf(model),
    modelTransport.normalizeProtocol(model),
  );
  if (!endpoint) return { ...res0, error: 'no-endpoint' };

  const key = apiKeyResolver.resolveApiKey(model);
  const local = apiKeyResolver.isLocalEndpoint(endpoint);
  if (!key && !local) return { ...res0, skipped: true, error: 'no-credentials' };

  const protocol = modelTransport.normalizeProtocol(model);
  const name = modelTransport.canonicalModelName(model) || id;
  const prompt = opts.prompt || DEFAULTS.probePrompt;
  const maxTokens = opts.maxTokens || DEFAULTS.maxTokens;
  const payload = protocol === 'anthropic'
    ? { model: name, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], stream: true }
    : { model: name, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, stream: true };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: modelTransport.authHeaders(model, key),
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { ...res0, ms_total: Date.now() - t0, error: 'HTTP ' + r.status + ' ' + String(body).slice(0, 120) };
    }

    const ct = String(r.headers.get('content-type') || '');
    let msFirst = null;
    let msText = null;
    let any = false;

    if (ct.includes('text/event-stream') && r.body && typeof r.body.getReader === 'function') {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const obj = _parseSseLine(line);
          if (!obj) continue;
          any = true;
          const txt = _deltaText(obj);
          if (txt && msFirst === null) msFirst = Date.now() - t0;
          const chs = Array.isArray(obj.choices) ? obj.choices : [];
          const visible = chs.some(ch => ch && ch.delta && typeof ch.delta.content === 'string' && ch.delta.content.length > 0);
          if (visible && msText === null) msText = Date.now() - t0;
        }
        if (msText !== null) break;
        if (buf.length > 1 << 20) break;
      }
      try { await reader.cancel(); } catch (_) { /* 已经断了 */ }
    } else {
      const j = await r.json().catch(() => null);
      any = !!j;
      if (j) {
        const txt = _deltaText(j);
        if (txt) msFirst = Date.now() - t0;
        const chs = Array.isArray(j.choices) ? j.choices : [];
        if (chs.some(ch => ch && ch.message && typeof ch.message.content === 'string' && ch.message.content.length > 0)) msText = msFirst;
      }
    }

    const msTotal = Date.now() - t0;
    if (!any) return { ...res0, ms_total: msTotal, error: 'empty-response' };
    if (msFirst === null) return { ...res0, ms_total: msTotal, error: 'no-delta' };
    return { ...res0, ok: true, ms_first: msFirst, ms_text: msText === null ? msFirst : msText, ms_total: msTotal };
  } catch (e) {
    const msg = String((e && e.message) || e || '');
    return { ...res0, ms_total: Date.now() - t0, error: msg.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeAll(config, opts = {}) {
  const models = ((config && config.llm && config.llm.models) || []).filter(m => m && m.enabled !== false);
  const cfg = routingCfg(config);
  const o = {
    timeoutMs: opts.timeoutMs || cfg.probeTimeoutMs,
    prompt: opts.prompt || (cfg.probePromptTokens > 8 ? _buildProbePrompt(cfg.probePromptTokens) : cfg.probePrompt),
    maxTokens: opts.maxTokens || cfg.maxTokens,
  };
  const out = await Promise.all(models.map(m => _probeOne(m, o).catch(e => ({
    id: m.id, ok: false, ms_first: null, ms_text: null, ms_total: null,
    error: String((e && e.message) || e || '').slice(0, 120), skipped: false, ts: Date.now(),
  }))));
  return out;
}

// ---------------------------------------------------------------- 决策

function _quality(model) {
  const q = Number(model && model.quality_score);
  if (Number.isFinite(q) && q > 0) return q;
  return null;
}

function _latency(r) {
  const v = Number(r && (r.ms_first != null ? r.ms_first : r.ms_total));
  return Number.isFinite(v) && v >= 0 ? v : Infinity;
}

/**
 * 按「质量档优先, 档内按速度」挑主路径。
 * 档的定义: 可用模型里的最高质量分 maxQ, 档 = q >= maxQ - tolerance。
 * 上档全挂了才逐级放宽 (0.02 → 0.15 → 0.30 → 全量)。
 */
function pickCandidate(results, opts = {}) {
  const usable = (results || []).filter(r => r && r.ok);
  if (!usable.length) return null;
  const withQ = usable.map(r => ({ r, q: opts.qualityById ? opts.qualityById[r.id] : null }));
  const known = withQ.filter(x => x.q !== null && x.q !== undefined);
  const maxQ = known.length ? Math.max(...known.map(x => x.q)) : null;
  const tolerances = [0.02, 0.15, 0.3, Infinity];
  for (const tol of tolerances) {
    let band = withQ;
    if (maxQ !== null && tol !== Infinity) {
      band = withQ.filter(x => x.q === null || x.q === undefined || x.q >= maxQ - tol);
      const knownBand = band.filter(x => x.q !== null && x.q !== undefined);
      if (knownBand.length) band = knownBand;
    }
    if (!band.length) continue;
    const sorted = band.slice().sort((a, b) => {
      const la = _latency(a.r), lb = _latency(b.r);
      if (la !== lb) return la - lb;
      return String(a.r.id).localeCompare(String(b.r.id));
    });
    return { id: sorted[0].r.id, quality: sorted[0].q, tier: tol, latency: _latency(sorted[0].r) };
  }
  return null;
}

function decide(config, results, opts = {}) {
  const cfg = opts.cfg || routingCfg(config);
  const current = String((config && config.llm && config.llm.current_model_id) || '');
  const curRes = (results || []).find(r => r && r.id === current) || null;
  const qualityById = opts.qualityById || {};
  const cand = pickCandidate(results, { qualityById });

  if (!cand) {
    return { action: 'keep', from: current, to: current, reason: 'no-usable-model', candidate: null };
  }
  if (!curRes || !curRes.ok) {
    return { action: 'switch', from: current, to: cand.id, reason: 'current-unreachable', candidate: cand };
  }
  if (cfg.manualPinned && cfg.pinnedModelId === current) {
    return { action: 'keep', from: current, to: current, reason: 'manual-pin', candidate: cand };
  }
  const curMs = _latency(curRes);
  if (curMs > cfg.maxFirstTokenMs && cand.id !== current) {
    return { action: 'switch', from: current, to: cand.id, reason: `slow:${Math.round(curMs)}ms>${cfg.maxFirstTokenMs}ms`, candidate: cand };
  }
  return { action: 'keep', from: current, to: current, reason: 'current-fast-enough', candidate: cand };
}

// ---------------------------------------------------------------- 状态

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') return j;
  } catch (_) { /* 没有状态文件 = 没探过 */ }
  return { probed_at: 0, results: [], decision: null };
}

function writeState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
    return true;
  } catch (e) {
    console.warn('[routing] 状态落盘失败:', e.message);
    return false;
  }
}

function _qualityMap(config) {
  const map = {};
  for (const m of ((config && config.llm && config.llm.models) || [])) {
    if (!m) continue;
    const q = _quality(m);
    if (q !== null) map[m.id] = q;
  }
  return map;
}

/**
 * 主入口: 探针 → 决策 → 决策结果 (不自己改 config, 改不改由调用方决定)。
 */
async function applyRouting(config, opts = {}) {
  const cfg = routingCfg(config);
  const current = (config && config.llm && config.llm.current_model_id) || '';
  if (cfg.policy === 'off') {
    return { action: 'off', from: current, to: current, reason: 'policy-off', results: [], candidate: null, probed: false };
  }

  const now = Date.now();
  let state = readState();
  let results = null;
  let probed = false;

  const fresh = state && state.probed_at && (now - state.probed_at) < cfg.cacheTtlMs
    && Array.isArray(state.results) && state.results.length
    // 探针口径变了 (提示词 token 量) ⇒ 旧结果作废, 不许拿旧口径的数做决策
    && (!state.probe_profile || Number(state.probe_profile.tokens) === Number(cfg.probePromptTokens));
  if (!opts.force && fresh) {
    results = state.results;
  } else {
    results = await probeAll(config, { timeoutMs: opts.timeoutMs });
    probed = true;
    state = { probed_at: now, probe_profile: { tokens: cfg.probePromptTokens }, results, decision: null };
  }

  const qualityById = _qualityMap(config);
  const decision = decide(config, results, { cfg, qualityById });
  state.decision = Object.assign({}, decision, { at: now });
  writeState(state);

  return Object.assign({}, decision, { results, probed, policy: cfg.policy });
}

/** 给 UI/CLI 看的报告 (不触发探针)。 */
function report(config) {
  const cfg = routingCfg(config);
  const state = readState();
  const age = state && state.probed_at ? Date.now() - state.probed_at : Infinity;
  return {
    policy: cfg.policy,
    max_first_token_ms: cfg.maxFirstTokenMs,
    manual_pinned: cfg.manualPinned,
    pinned_model_id: cfg.pinnedModelId,
    current_model_id: (config && config.llm && config.llm.current_model_id) || '',
    probed_at: state.probed_at || 0,
    probe_age_ms: Number.isFinite(age) ? age : null,
    stale: !(age < cfg.cacheTtlMs),
    results: state.results || [],
    decision: state.decision || null,
  };
}

/** 用户显式切模型 ⇒ 记一个"手动钉住", auto 就不再跟用户抢。 */
function markManualPin(config, modelId) {
  if (!config.llm) config.llm = {};
  if (!config.llm.routing) config.llm.routing = {};
  config.llm.routing.manual_pinned = true;
  config.llm.routing.pinned_model_id = String(modelId || '');
  return config.llm.routing;
}

module.exports = {
  routingCfg,
  probeAll,
  probeModel: (model, opts = {}) => _probeOne(model, {
    timeoutMs: opts.timeoutMs,
    prompt: opts.prompt || _buildProbePrompt(opts.promptTokens || routingCfg({ llm: { routing: opts.routing } }).probePromptTokens),
    maxTokens: opts.maxTokens,
  }),
  decide,
  pickCandidate,
  applyRouting,
  report,
  readState,
  writeState,
  markManualPin,
  STATE_FILE,
};
