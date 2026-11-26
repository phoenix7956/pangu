'use strict';
/**
 * modules/weixin_channel.js
 * 盘古 · 微信通道 (iLink / ilinkai.weixin.qq.com)
 *
 * 2026-10-30 (第 172 批): 老板要「盘古能接微信」。
 * 原来盘古里的 send_wechat 是**空壳** —— 只往 ~/.pangu/weixin_queue/ 写文件,
 * 没有消费者, 所以工具直接返回 WECHAT_NOT_IMPLEMENTED (怕 LLM 假装成功)。
 *
 * 真正的微信通道一直挂在老 openclaw 桌面端里 (腾讯官方插件
 * @tencent-weixin/openclaw-weixin), 账号 `308231fa95df-im-bot` 已绑好。
 * 那个插件的 dist **依赖 openclaw 宿主** (logger 里 import 'openclaw/plugin-sdk/infra-runtime'),
 * 盘古用不了 —— 所以这里按同一套 iLink 协议自己实现一份**自足的**客户端:
 *   · 不依赖 openclaw 宿主, 盘古可以独立跑
 *   · 账号/令牌落在 PANGU_HOME/weixin/ (盘古自己 owns, openclaw 退场也不影响)
 *   · 收发走同一个 bot token, 不经任何中间网关
 *
 * 协议要点 (对着官方插件的 dist 核过, 别凭记忆改):
 *   · 端点   POST {baseUrl}/ilink/bot/{getupdates|sendmessage|getconfig}
 *   · 头     AuthorizationType: ilink_bot_token
 *            Authorization: Bearer <bot_token>
 *            iLink-App-Id: bot
 *            iLink-App-ClientVersion: uint32 = major<<16|minor<<8|patch
 *            X-WECHAT-UIN: base64(随机 uint32 的十进制字符串)
 *   · 每次请求带 base_info {channel_version, bot_agent}
 *   · context_token **每条入站消息都会换**, 回复必须用**最新那条**的 token
 *     (旧 token 会被服务端拒: ret=-2 "prepare failed")
 *
 * 真事证据 (2026-10-30): 用这套 header + 同一份凭据直发微信**成功**。
 * 老 openclaw 自己发不出去 (ret=-2) 是它网关投递路径的问题, 不是协议坏了。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const ILINK_APP_ID = 'bot';
const CHANNEL_VERSION = '1.0.0';
const BOT_AGENT = 'Pangu';

// iLink-App-ClientVersion: 0x00MMNNPP (major<<16 | minor<<8 | patch)
function buildClientVersion(version) {
  const parts = String(version || '0.0.0').split('.').map((p) => parseInt(p, 10) || 0);
  return ((parts[0] & 0xff) << 16) | ((parts[1] & 0xff) << 8) | (parts[2] & 0xff);
}

function configDir() {
  const home = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
  return path.join(home, 'weixin');
}

function _paths() {
  const dir = configDir();
  return {
    dir,
    account: path.join(dir, 'account.json'),
    tokens: path.join(dir, 'context-tokens.json'),
    sync: path.join(dir, 'sync.json'),
    inbox: path.join(dir, 'inbox.jsonl'),
    log: path.join(dir, 'log.jsonl'),
  };
}

function _ensureDir() {
  const p = _paths();
  try { fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 }); } catch (_) {}
  return p;
}

function _readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function _writeJson(file, obj) {
  _ensureDir();
  const tmp = file + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function logEvent(kind, detail) {
  const p = _ensureDir();
  try {
    fs.appendFileSync(p.log, JSON.stringify({
      ts: new Date().toISOString(), kind, detail: detail || {},
    }) + '\n', { mode: 0o600 });
  } catch (_) {}
}

// ---------------------------------------------------------------- 账号 / 令牌

/**
 * 载入账号。盘古自己 owns 一份 (account.json), 不去读 openclaw 的目录 ——
 * 老桌面端随时可能整个退场, 盘古不能依赖它活着。
 */
function loadAccount() {
  const p = _paths();
  const acc = _readJson(p.account, null);
  if (!acc || !acc.token) return null;
  return {
    accountId: acc.accountId || 'pangu',
    token: String(acc.token),
    baseUrl: acc.baseUrl || DEFAULT_BASE_URL,
    userId: acc.userId || '',
    savedAt: acc.savedAt || null,
  };
}

function saveAccount(acc) {
  _ensureDir();
  _writeJson(_paths().account, {
    accountId: acc.accountId || 'pangu',
    token: acc.token,
    baseUrl: acc.baseUrl || DEFAULT_BASE_URL,
    userId: acc.userId || '',
    savedAt: new Date().toISOString(),
  });
  return true;
}

function loadTokens() {
  return _readJson(_paths().tokens, {});
}

/** 记住某个会话**最新**的 context_token —— 回复必须用这个, 旧的会被服务端拒。 */
function saveContextToken(userId, token) {
  if (!userId || !token) return false;
  _ensureDir();
  const all = loadTokens();
  all[userId] = token;
  _writeJson(_paths().tokens, all);
  return true;
}

function loadContextToken(userId) {
  const all = loadTokens();
  return all[userId] || null;
}

function loadSync() {
  return _readJson(_paths().sync, { get_updates_buf: '' });
}

function saveSync(buf) {
  _writeJson(_paths().sync, { get_updates_buf: buf || '', updatedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------- HTTP 底座

function _headers(token) {
  const uin = Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
  const h = {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': uin,
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(buildClientVersion(CHANNEL_VERSION)),
  };
  if (token && String(token).trim()) h.Authorization = 'Bearer ' + String(token).trim();
  return h;
}

function _baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

async function _post(endpoint, body, opts = {}) {
  const base = String(opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = base + '/' + String(endpoint).replace(/^\/+/, '');
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs || 15000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: _headers(opts.token),
      body: JSON.stringify({ ...body, base_info: _baseInfo() }),
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error('iLink ' + endpoint + ' HTTP ' + res.status + ': ' + raw.slice(0, 200));
    let json;
    try { json = JSON.parse(raw); } catch (_) { throw new Error('iLink ' + endpoint + ' 返回非 JSON: ' + raw.slice(0, 200)); }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 对外接口

/**
 * 发一条文本消息。
 * to 省略时发给账号绑定的默认会话 (老板本人)。
 */
async function sendText(opts = {}) {
  const acc = opts.account || loadAccount();
  if (!acc) return { ok: false, error: 'WECHAT_NOT_CONFIGURED', message: '盘古还没绑微信账号 (缺 ~/.pangu/weixin/account.json)' };
  const to = opts.to || acc.userId;
  if (!to) return { ok: false, error: 'WECHAT_NO_RECIPIENT', message: '没有收件人 —— 账号里也没记默认会话' };
  const text = String(opts.text == null ? '' : opts.text);
  if (!text.trim()) return { ok: false, error: 'WECHAT_EMPTY_TEXT', message: '消息正文是空的' };

  const contextToken = opts.contextToken || loadContextToken(to);
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: (opts.clientId || ('pangu-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'))),
      message_type: 2,   // BOT
      message_state: 2, // FINISH
      item_list: [{ type: 1, text_item: { text } }], // 1 = TEXT
      ...(contextToken ? { context_token: contextToken } : {}),
    },
  };
  try {
    const resp = await _post('ilink/bot/sendmessage', body, {
      baseUrl: acc.baseUrl, token: acc.token, timeoutMs: opts.timeoutMs || 15000,
    });
    if (resp && resp.ret && resp.ret !== 0) {
      const err = new Error('sendMessage ret=' + resp.ret + ' errmsg=' + (resp.errmsg || '(none)'));
      err.code = 'WECHAT_SEND_REJECTED';
      err.ret = resp.ret;
      throw err;
    }
    logEvent('send', { to, chars: text.length, withToken: !!contextToken });
    return { ok: true, to, chars: text.length, ret: (resp && resp.ret) || 0 };
  } catch (e) {
    logEvent('send_failed', { to, error: String(e.message || e) });
    return { ok: false, error: e.code || 'WECHAT_SEND_FAILED', message: String(e.message || e) };
  }
}

/** 取对方的会话配置 (能通 ⇒ 凭证/会话还活着)。 */
async function getConfig(opts = {}) {
  const acc = opts.account || loadAccount();
  if (!acc) return { ok: false, error: 'WECHAT_NOT_CONFIGURED' };
  const to = opts.to || acc.userId;
  try {
    const resp = await _post('ilink/bot/getconfig', {
      ilink_user_id: to,
      context_token: opts.contextToken || loadContextToken(to) || undefined,
    }, { baseUrl: acc.baseUrl, token: acc.token, timeoutMs: opts.timeoutMs || 10000 });
    return { ok: !(resp && resp.ret), ret: resp && resp.ret, raw: resp };
  } catch (e) {
    return { ok: false, error: 'WECHAT_CONFIG_FAILED', message: String(e.message || e) };
  }
}

/** 拉一批新消息 (长轮询)。返回 {ok, msgs, buf}。 */
async function pollOnce(opts = {}) {
  const acc = opts.account || loadAccount();
  if (!acc) return { ok: false, error: 'WECHAT_NOT_CONFIGURED' };
  const buf = opts.buf != null ? opts.buf : (loadSync().get_updates_buf || '');
  try {
    const resp = await _post('ilink/bot/getupdates', { get_updates_buf: buf }, {
      baseUrl: acc.baseUrl, token: acc.token, timeoutMs: opts.timeoutMs || 35000,
    });
    if (resp && resp.ret && resp.ret !== 0) {
      return { ok: false, error: 'WECHAT_POLL_REJECTED', ret: resp.ret, errmsg: resp.errmsg };
    }
    const msgs = Array.isArray(resp && resp.msgs) ? resp.msgs : [];
    return { ok: true, msgs, buf: (resp && resp.get_updates_buf) || buf };
  } catch (e) {
    const msg = String(e.message || e);
    // 长轮询超时是正常控制流 (没有新消息), 不是故障。
    if (/abort|timed out|timeout/i.test(msg)) return { ok: true, msgs: [], buf, timeout: true };
    return { ok: false, error: 'WECHAT_POLL_FAILED', message: msg };
  }
}

/** 从一条微信消息里取纯文本 (语音走 text 字段)。 */
function extractText(msg) {
  const items = (msg && msg.item_list) || [];
  const parts = [];
  for (const item of items) {
    if (item && item.type === 1 && item.text_item && item.text_item.text != null) {
      parts.push(String(item.text_item.text));
    } else if (item && item.type === 3 && item.voice_item && item.voice_item.text) {
      parts.push(String(item.voice_item.text));
    }
  }
  return parts.join('\n').trim();
}

/** 把一批消息拆成 [{from, text, contextToken, createTime}]。 */
function parseMessages(msgs) {
  const out = [];
  for (const m of msgs || []) {
    const msg = (m && m.msg) || m;
    if (!msg) continue;
    const text = extractText(msg);
    const from = msg.from_user_id || '';
    if (msg.context_token && from) saveContextToken(from, msg.context_token);
    if (!text) continue;
    out.push({
      from,
      text,
      contextToken: msg.context_token || loadContextToken(from),
      createTime: msg.create_time_ms || null,
    });
  }
  return out;
}

function appendInbox(entry) {
  const p = _ensureDir();
  try { fs.appendFileSync(p.inbox, JSON.stringify(entry) + '\n', { mode: 0o600 }); } catch (_) {}
}

/**
 * 长轮询循环。onMessage 每条文本消息调一次 (异步, 串行, 不并发)。
 * 返回 {stop, state, promise} —— 调用方负责在进程退出时 stop()。
 */
function startPolling(opts = {}) {
  const onMessage = typeof opts.onMessage === 'function' ? opts.onMessage : async () => {};
  const acc = opts.account || loadAccount();
  const state = { stopped: false, running: false, lastError: null, lastAt: null, count: 0 };

  const loop = async () => {
    state.running = true;
    while (!state.stopped) {
      let res;
      try {
        res = await pollOnce({ account: acc });
      } catch (e) {
        res = { ok: false, error: 'WECHAT_POLL_FAILED', message: String(e.message || e) };
      }
      if (state.stopped) break;
      state.lastAt = new Date().toISOString();
      if (!res.ok) {
        state.lastError = res.error || 'unknown';
        logEvent('poll_failed', { error: state.lastError, message: res.message });
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      state.lastError = null;
      if (res.buf != null) saveSync(res.buf);
      const items = parseMessages(res.msgs);
      for (const item of items) {
        if (state.stopped) break;
        state.count += 1;
        appendInbox({ ts: new Date().toISOString(), from: item.from, text: item.text });
        logEvent('inbound', { from: item.from, chars: item.text.length });
        try {
          await onMessage(item);
        } catch (e) {
          logEvent('inbound_handler_failed', { error: String(e.message || e) });
        }
      }
    }
    state.running = false;
  };

  const promise = loop();
  return {
    state,
    promise,
    stop() { state.stopped = true; },
  };
}

function status() {
  const acc = loadAccount();
  const p = _paths();
  let lastInbound = null;
  try {
    const lines = fs.readFileSync(p.inbox, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length) lastInbound = JSON.parse(lines[lines.length - 1]).ts;
  } catch (_) {}
  return {
    configured: !!acc,
    accountId: acc ? acc.accountId : null,
    userId: acc ? acc.userId : null,
    tokenPresent: !!(acc && acc.token),
    defaultRecipientPresent: !!(acc && acc.userId),
    contextTokens: Object.keys(loadTokens()).length,
    lastInboundAt: lastInbound,
    dir: p.dir,
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  BOT_AGENT,
  configDir,
  loadAccount,
  saveAccount,
  loadTokens,
  saveContextToken,
  loadContextToken,
  loadSync,
  saveSync,
  sendText,
  getConfig,
  pollOnce,
  parseMessages,
  extractText,
  startPolling,
  status,
  logEvent,
  _paths,
  _buildClientVersion: buildClientVersion,
};
