'use strict';
/**
 * modules/weixin_bridge.js
 * 盘古 · 微信 ↔ 盘古 agent 的桥
 *
 * 微信消息进来 → 交给盘古自己的 agent loop 跑一轮 → 把答案发回微信。
 * agent loop 走的是**同一个** HTTP 入口 (/api/chat, run_j2=true) ——
 * 也就是网页版工作台那条路。不另开一条执行路径 (两套执行路径必然漂移)。
 *
 * 会话连续性: 微信侧用固定 session_id (`weixin`), 所以老板在微信里连着问
 * 是同一段上下文; 网页工作台的会话不受影响。
 */

const http = require('http');
const channel = require('./weixin_channel');

const DEFAULT_PORT = parseInt(process.env.PANGU_PORT || '18901', 10);
const DEFAULT_HOST = '127.0.0.1';
const SESSION_ID = process.env.PANGU_WECHAT_SESSION || 'weixin';
const REPLY_TIMEOUT_MS = parseInt(process.env.PANGU_WECHAT_TIMEOUT_MS || '240000', 10);
// 盘古自己重启/崩了的那 2-3 秒里, 微信消息照样会到。
// 2026-10-30 实测: 重启窗口里进来的一条消息, agent 直接 "socket hang up" ⇒ 老板在微信那头
// 只收到一句报错, 白等一场 ⇒ 这里对**连接层**失败重试几次。
const CONNECT_RETRY = 2;
const CONNECT_RETRY_WAIT_MS = 4000;

function _isConnectError(e) {
  const msg = String((e && e.message) || e || '');
  return /socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|连接失败/i.test(msg);
}

function _postJson(host, port, pathname, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request({
      host, port, path: pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); }
        catch (e) { reject(new Error('盘古 /api/chat 返回非 JSON (HTTP ' + res.statusCode + '): ' + raw.slice(0, 200))); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('盘古 /api/chat 超时 (' + timeoutMs + 'ms)')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 跑一轮盘古 agent, 拿回给微信的正文。 */
async function askAgent(text, opts = {}) {
  const port = opts.port || DEFAULT_PORT;
  const host = opts.host || DEFAULT_HOST;
  const payload = {
    messages: [{ role: 'user', content: text }],
    run_j2: true,
    session_id: opts.sessionId || SESSION_ID,
  };
  const timeoutMs = opts.timeoutMs || REPLY_TIMEOUT_MS;
  let res = null;
  let lastErr = null;
  for (let attempt = 0; attempt <= CONNECT_RETRY; attempt++) {
    try {
      res = await _postJson(host, port, '/api/chat', payload, timeoutMs);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      // 只有**连接层**失败才重试 (盘古还没起 / 刚重启); agent 本身跑失败不该重跑 ——
      // 重跑一轮 agent 要两分钟, 代价远大于把失败如实告诉老板。
      if (attempt >= CONNECT_RETRY || !_isConnectError(e)) throw e;
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_WAIT_MS));
    }
  }
  if (lastErr) throw lastErr;
  const json = res.json || {};
  if (!json.ok) throw new Error('盘古 /api/chat 报错: ' + (json.error || ('HTTP ' + res.status)));
  const content = json.choices && json.choices[0] && json.choices[0].message
    ? json.choices[0].message.content : '';
  const textOut = String(content || '').trim();
  if (!textOut) {
    const why = json.agent_error || ('agent_status=' + (json.agent_status || '?'));
    throw new Error('盘古这一轮没给出正文 (' + why + ')');
  }
  return { text: textOut, agentStatus: json.agent_status || null };
}

/**
 * 一条入站消息的完整处理: 问 agent → 回微信。
 * 失败也要回一句 (老板在微信那头等着, 静默 = 又一次"感觉它坏了")。
 */
async function handleMessage(item, opts = {}) {
  channel.logEvent('bridge_handle', { from: item.from, chars: (item.text || '').length });
  let reply;
  try {
    const ans = await askAgent(item.text, opts);
    reply = ans.text;
    channel.logEvent('bridge_answered', { from: item.from, chars: reply.length, agentStatus: ans.agentStatus });
  } catch (e) {
    reply = '⚠️ 这一轮我没能答上来: ' + String(e.message || e).slice(0, 200);
    channel.logEvent('bridge_failed', { from: item.from, error: String(e.message || e) });
  }
  const sent = await channel.sendText({
    to: item.from,
    text: reply,
    contextToken: item.contextToken,
  });
  if (!sent.ok) {
    channel.logEvent('bridge_send_failed', { from: item.from, error: sent.error, message: sent.message });
  }
  return { reply, sent };
}

/** 起桥: 长轮询 + 处理。返回 {stop}。 */
function start(opts = {}) {
  const poller = channel.startPolling({
    account: opts.account,
    onMessage: (item) => handleMessage(item, opts),
  });
  return poller;
}

module.exports = {
  SESSION_ID,
  askAgent,
  handleMessage,
  start,
  _postJson,
};
