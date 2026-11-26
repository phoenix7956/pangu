// sse.mjs —— 盘古主 agent 流式对话的 SSE 客户端。
//
// 事件名 (现场实测 :18901, 2026-10-27):
//   status / thinking / stream_delta / tool_call / tool_result / agent_progress /
//   execution_path / final / done / error / gua (梅花起卦的附带事件)
// data 一律是 JSON。

/**
 * 解析一整块 SSE 文本 (可能含多帧) → 事件数组。
 * 帧分隔是空行; 服务端 (sse-utils.js / inline_router.js) 用的是纯 LF。
 */
export function parseEvents(raw) {
  if (!raw) return [];
  const out = [];
  for (const frame of String(raw).split(/\r?\n\r?\n/)) {
    let event = 'message';
    const data = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) continue;
    const body = data.join('\n');
    let payload = body;
    try { payload = JSON.parse(body); } catch (e) { /* 不是 JSON 就按原文给 */ }
    out.push({ event, data: payload });
  }
  return out;
}

/** 单帧语义: 取第一帧。给的是多帧就只认第一帧 (别把最后一帧当答案)。 */
export function parseEvent(raw) {
  const all = parseEvents(raw);
  return all.length ? all[0] : null;
}

/**
 * 跑一轮流式对话。
 * @param {string} url
 * @param {object} body
 * @param {(ev:{event:string,data:any})=>void} onEvent
 * @param {{signal?: AbortSignal}} [opts]
 */
export async function streamSSE(url, body, onEvent, opts) {
  const o = opts || {};
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: o.signal,
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  if (!res.body) throw new Error('这个端点没有流式返回');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const ev of parseEvents(raw)) onEvent(ev);
    }
  }
  if (buf.trim()) {
    const ev = parseEvent(buf);
    if (ev) onEvent(ev);
  }
}
