// apps/core/modules/llm_capabilities_selfreport.js — 2026-08-22
// 老板拍: 模型能力都应该从模型拿才对 — 让模型自己回答 vision/reasoning/tool/ctx
// 不依赖规则库/外部数据库, 模型是真源, 模型永远最新
// 流程: 发能力自报 prompt → 解析 JSON → 写回 config (与 probe 视觉探测双保险)

const https = require('https');
const http = require('http');
const { URL } = require('url');

// 能力自报 prompt — 让模型回答 JSON (只 JSON, 不要其他)
// 中英双语确保国产模型理解
const SELF_REPORT_PROMPT = `你是模型自身, 请如实回答你的能力。只返回 JSON, 不要任何其他文字:

{
  "vision": <true/false: 你能直接处理图片/视频/音频输入吗?>,
  "reasoning": <true/false: 你支持多步推理 (thinking / reasoning_effort / extended_thinking)?>,
  "tool": <true/false: 你支持 function calling / 工具调用?>,
  "context_length": <数字: 你的最大上下文窗口 (tokens)?>,
  "name": "<你的官方名字>",
  "version": "<版本号>"
}

注意: 只返回 JSON, 不要 markdown 代码块, 不要解释.`;

const SELF_REPORT_PROMPT_EN = `You are the model itself. Answer your own capabilities. Return ONLY valid JSON, no markdown, no explanation:

{
  "vision": <true/false: can you process image/video/audio input?>,
  "reasoning": <true/false: do you support multi-step thinking / reasoning_effort?>,
  "tool": <true/false: do you support function calling / tool use?>,
  "context_length": <number: max context window tokens?>,
  "name": "<your official name>",
  "version": "<your version>"
}`;

// 从模型回复里抠 JSON — 模型经常把 JSON 包在 ```json ... ``` 里或加前缀
function _extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  // 去 markdown 围栏
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  // 找第一个 { 和最后一个 } 的中间
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) {
    // 尝试宽松: 找 {"vision"
    const m = t.match(/\{\s*"vision"\s*:/i);
    if (m) {
      const s = t.indexOf('{', m.index);
      const e = t.lastIndexOf('}');
      if (s !== -1 && e !== -1 && e > s) {
        try { return JSON.parse(t.slice(s, e + 1)); } catch (_) {}
      }
    }
    return null;
  }
  try { return JSON.parse(t.slice(first, last + 1)); } catch (_) {}
  // 二次尝试: 用 JSON5-ish 修复 (去尾逗号, 单引号)
  let candidate = t.slice(first, last + 1);
  candidate = candidate.replace(/,\s*([}\]])/g, '$1');
  candidate = candidate.replace(/'/g, '"');
  try { return JSON.parse(candidate); } catch (_) {}
  return null;
}

// 把模型自报的值归一化成 boolean
function _toBool(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', 'yes', 'y', '√', '支持', '能', '可以', '是', 'on', '1'].includes(s)) return true;
    if (['false', 'no', 'n', '×', '不支持', '不能', '不可以', '否', 'off', '0'].includes(s)) return false;
  }
  if (typeof v === 'number') return v !== 0;
  return null;
}
function _toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    // 抠数字 (支持 "262144 tokens" / "1M" / "262K")
    const lower = v.trim().toLowerCase();
    if (/^\d+$/.test(lower)) return parseInt(lower, 10);
    const m = lower.match(/([\d.]+)\s*(k|m|千|万)?/);
    if (m) {
      let n = parseFloat(m[1]);
      if (m[2] === 'k') n *= 1000;
      else if (m[2] === 'm') n *= 1000000;
      else if (m[2] === '万') n *= 10000;
      else if (m[2] === '千') n *= 1000;
      return Math.round(n);
    }
  }
  return null;
}

// 构造发给模型的 request body
function _buildRequestBody(model, prompt) {
  if (model.protocol === 'anthropic' || /anthropic|claude/i.test(model.endpoint || '')) {
    return {
      model: model.id,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    };
  }
  // OpenAI 兼容
  return {
    model: model.id,
    max_tokens: 600,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  };
}

function _buildRequestHeaders(model) {
  const headers = { 'Content-Type': 'application/json' };
  // 2026-10-26 (第 110 批): 走统一解析链 —— 明文已收编进凭证库,
  //   直接读 model.api_key 会拿到空串 ⇒ 自报请求不带鉴权 ⇒ 厂商答 401。
  const apiKey = require('./api_key_resolver').resolveApiKey(model);
  if (apiKey) {
    if (model.protocol === 'anthropic' || /anthropic|claude/i.test(model.endpoint || '')) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = 'Bearer ' + apiKey;
    }
  }
  return headers;
}

// 解析 response (OpenAI 兼容)
function _extractContentOpenAI(j) {
  return (j.choices?.[0]?.message?.content || '') + ' ' + (j.choices?.[0]?.message?.reasoning_content || '');
}
function _extractContentAnthropic(j) {
  if (!Array.isArray(j.content)) return '';
  return j.content.filter(b => b.type === 'text').map(b => b.text).join(' ');
}

// 发请求到模型 API, 带 30s timeout
function _fetch(prompt, model) {
  return new Promise((resolve) => {
    let endpoint = model.endpoint || '';
    if (!/\/(chat\/completions|messages)(\?|$)/.test(endpoint)) {
      // 2026-09-14 修: /v1 结尾只补路径不再叠 /v1 (旧逻辑拼出 /v1/v1/chat/completions → 404 误报)
      endpoint = endpoint.replace(/\/+$/, '');
      if (/\/v\d+$/.test(endpoint)) endpoint += model.protocol === 'anthropic' ? '/messages' : '/chat/completions';
      else endpoint += model.protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
    }
    const u = new URL(endpoint);
    const isHttps = u.protocol === 'https:';
    const body = JSON.stringify(_buildRequestBody(model, prompt));
    const headers = _buildRequestHeaders(model);
    headers['Content-Length'] = Buffer.byteLength(body);
    const opts = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + (u.search || ''),
      headers,
    };
    const lib = isHttps ? https : http;
    const ctrl = setTimeout(() => { try { req.destroy(); } catch (_) {} resolve({ ok: false, error: 'TIMEOUT' }); }, 30000);
    const req = lib.request(opts, (resp) => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => {
        clearTimeout(ctrl);
        const text = Buffer.concat(chunks).toString('utf8');
        if (resp.statusCode !== 200) return resolve({ ok: false, error: 'HTTP_' + resp.statusCode, body: text.slice(0, 500) });
        let j; try { j = JSON.parse(text); } catch (e) { return resolve({ ok: false, error: 'PARSE_FAIL', body: text.slice(0, 500) }); }
        const isAnthropic = /anthropic/i.test(endpoint) || model.protocol === 'anthropic';
        const content = isAnthropic ? _extractContentAnthropic(j) : _extractContentOpenAI(j);
        resolve({ ok: true, content, raw: j });
      });
    });
    req.on('error', (e) => { clearTimeout(ctrl); resolve({ ok: false, error: e.message }); });
req.setHeader('Content-Length', Buffer.byteLength(body)); // 2026-10-14: mlx-serve 不吃 chunked
    req.write(body);
    req.end();
  });
}

// 主函数: 让模型自己回答能力
// options: { promptLang: 'cn' | 'en' | 'both' (default both) }
// 返回: { ok, capabilities: { vision, reasoning, tool, ctx, name, version }, raw_response, model_replied_id, prompt_used }
async function selfReportCapabilities(model, opts = {}) {
  if (!model || !model.endpoint) return { ok: false, error: 'NO_ENDPOINT' };
  const lang = opts.promptLang || 'both';
  const prompts = [];
  if (lang === 'cn' || lang === 'both') prompts.push({ text: SELF_REPORT_PROMPT, lang: 'cn' });
  if (lang === 'en' || lang === 'both') prompts.push({ text: SELF_REPORT_PROMPT_EN, lang: 'en' });
  let lastErr = null;
  for (const p of prompts) {
    const r = await _fetch(p.text, model);
    if (!r.ok) { lastErr = r; continue; }
    const json = _extractJson(r.content);
    if (!json) { lastErr = { ok: false, error: 'NO_JSON_IN_RESPONSE', content: r.content?.slice(0, 500) }; continue; }
    // 校验 response.model (防 LM Studio 模型名错配)
    const repliedModel = r.raw?.model || '';
    let modelMismatch = false;
    if (repliedModel && model.id && repliedModel !== model.id && !repliedModel.includes(model.id) && !model.id.includes(repliedModel)) {
      modelMismatch = true;
    }
    const capabilities = {
      vision: _toBool(json.vision),
      reasoning: _toBool(json.reasoning),
      tool: _toBool(json.tool),
      ctx: _toNum(json.context_length),
      name: typeof json.name === 'string' ? json.name.trim() : null,
      version: typeof json.version === 'string' ? json.version.trim() : null,
    };
    return {
      ok: true,
      capabilities,
      raw_response: r.content?.slice(0, 1500),
      prompt_used: p.lang,
      model_replied_id: repliedModel,
      model_mismatch: modelMismatch,
      parsed_json: json,
    };
  }
  return { ok: false, error: lastErr?.error || 'UNKNOWN', detail: lastErr };
}

module.exports = {
  selfReportCapabilities,
  _extractJson,  // 导出供测试
  SELF_REPORT_PROMPT,
  SELF_REPORT_PROMPT_EN,
};
