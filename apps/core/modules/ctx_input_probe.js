'use strict';
// modules/ctx_input_probe.js — 输入上限探测 (第 111 批)
//
// 为什么要有它:
//   ctx 拿不到 ⇒ 运行时热路径拿不到窗口大小 ⇒ 要么整轮 500, 要么退到保守值瞎猜。
//   老的 L3 padding 探针靠"把超长 prompt 喂进去"测边界, 对 1M 级上下文的模型
//   要真跑一遍 prefill (实测 MiniMax-M3.1-Flash 喂 60 万字 = 21s), 而且还得二分很多轮。
//
// 这儿的做法: **用厂商自己的 token 计数做二分**。
//   1) 校准 —— 发一小段 prompt, 从响应 usage 里读回它算成多少 input token;
//   2) 二分 —— 用校准比例把 token 数换算成字符数, 再发一条 max_tokens=1 的请求:
//      200 = 装得下 (顺便拿到这一次的真实 prompt_tokens), 400 = 装不下;
//   3) 收敛 —— 最大的"装得下"就是窗口边界 (ctx ≈ 接受的 prompt_tokens + 1)。
//   被拒的请求不做生成 (只 tokenize), 比 padding 探针快一个量级。
//
// 拿到的是**厂商自己数的 token 数**, 不是我们估的字符数 ⇒ measure=v2-tokens,
// 和 L1/L2 真值同档, 可以进 registry 当真值用。

const modelTransport = require('./model_transport');
const apiKeyResolver = require('./api_key_resolver');

function _isAnthropic(model) {
  return modelTransport.normalizeProtocol(model) === 'anthropic';
}

function _endpointOf(model) {
  return modelTransport.normalizeEndpoint(
    modelTransport.endpointOf(model),
    modelTransport.normalizeProtocol(model),
  );
}

// 发一条 max_tokens=1 的请求, 只为拿 "装不装得下" 和 usage 里的 token 数。
async function _send(model, endpoint, key, prompt, timeoutMs) {
  const isAnth = _isAnthropic(model);
  const name = modelTransport.canonicalModelName(model) || model.id;
  const body = isAnth
    ? { model: name, max_tokens: 1, messages: [{ role: 'user', content: prompt }] }
    : { model: name, max_tokens: 1, messages: [{ role: 'user', content: prompt }] };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: modelTransport.authHeaders(model, key),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text().catch(() => '');
    if (!r.ok) {
      // 装不下: 上游的错误正文里通常带着真上限 (minimax: "does not support max tokens > 524288")
      const capMatch = String(text).match(/max tokens\s*>\s*(\d+)/i);
      return {
        ok: false,
        status: r.status,
        error: String(text).slice(0, 200),
        output_cap: capMatch ? Number(capMatch[1]) : null,
        ms: Date.now() - t0,
      };
    }
    let usage = null;
    try { usage = JSON.parse(text).usage || null; } catch (_) { usage = null; }
    const inTok = usage && (usage.prompt_tokens || usage.input_tokens || null);
    return { ok: true, status: r.status, prompt_tokens: inTok ? Number(inTok) : null, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e).slice(0, 120), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探这个模型的输入窗口上限。
 * @returns {{context_length:number, source:string, measure:string, steps:Array}|null}
 */
async function probeInputLimit(model, opts = {}) {
  if (!model || !model.id) return null;
  const endpoint = _endpointOf(model);
  if (!endpoint) return null;
  const key = apiKeyResolver.resolveApiKey(model);
  if (!key && !apiKeyResolver.isLocalEndpoint(endpoint)) return null;

  const timeoutMs = opts.timeoutMs || 60000;
  const maxRounds = opts.maxRounds || 8;
  const steps = [];

  // 1) 校准: 1000 个汉字, 看上游算成多少 input token
  const calChars = 1000;
  const cal = await _send(model, endpoint, key, '测'.repeat(calChars), timeoutMs);
  steps.push({ phase: 'calibrate', ok: cal.ok, prompt_tokens: cal.prompt_tokens, ms: cal.ms });
  if (!cal.ok) {
    // 连校准都过不去 (端点不通 / 没鉴权 / 模型名不对) ⇒ 这次探针没结论
    return null;
  }
  const ratio = (cal.prompt_tokens || calChars) / calChars; // token / 字符
  if (!(ratio > 0)) return null;

  // 2) 二分: lo = 已确认装得下的 token 数, hi = 已确认装不下的 token 数
  let lo = cal.prompt_tokens || calChars;
  let hi = Math.max(lo * 8, 2_000_000);
  let hiRejected = false;

  for (let i = 0; i < maxRounds; i++) {
    const mid = Math.floor((lo + hi) / 2);
    if (mid <= lo) break;
    const chars = Math.max(calChars, Math.floor(mid / ratio));
    const res = await _send(model, endpoint, key, '测'.repeat(chars), timeoutMs);
    steps.push({ phase: 'probe', tokens: mid, ok: res.ok, prompt_tokens: res.prompt_tokens, ms: res.ms, error: res.error && res.error.slice(0, 80) });
    if (res.ok) {
      // 上游自己数的 token 更准 ⇒ 用它做新的下界
      lo = res.prompt_tokens || mid;
    } else {
      hi = mid;
      hiRejected = true;
      // 有些厂商直接在错误里给出上限 (输出上限 + 输入上限合并的窗口)
      if (res.output_cap && res.output_cap > lo) {
        // 输出上限不是输入上限, 不能直接当 ctx ⇒ 只记着, 不采用
        steps.push({ phase: 'note', output_cap: res.output_cap });
      }
    }
    if (hi - lo < Math.max(1024, Math.floor(lo * 0.01))) break;
  }

  if (!hiRejected) {
    // 一路都没被拒过 ⇒ 只知道"至少这么多", 不给假上限
    return { context_length: lo, source: 'L3-input-probe', measure: 'v2-tokens', lower_bound: true, steps };
  }
  // ctx ≈ 装得下的最大 input token + 1 (我们发的是 max_tokens=1)
  return { context_length: lo + 1, source: 'L3-input-probe', measure: 'v2-tokens', lower_bound: false, steps };
}

module.exports = { probeInputLimit };
