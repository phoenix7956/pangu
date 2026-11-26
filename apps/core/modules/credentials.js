// ~/.pangu/modules/credentials.js
// Proxy 模式凭证管理
// 凭证文件: ~/.pangu/credentials.json (chmod 600, owner-only)
// 安全铁律: value 不返给 LLM, 仅 tool 内部用 — proxy 模式
// 凭证可选地通过环境变量覆盖 (env > credentials_file)

const fs = require('fs');
const path = require('path');
const os = require('os');

const CRED_FILE = path.join(os.homedir(), '.pangu', 'credentials.json');
const MAX_CACHE_TTL_MS = 30000;  // 30s reload,避免每次读盘
let _cache = null;
let _cacheTs = 0;

function _load() {
  const now = Date.now();
  if (_cache && (now - _cacheTs) < MAX_CACHE_TTL_MS) return _cache;
  try {
    if (!fs.existsSync(CRED_FILE)) {
      _cache = {};
      _cacheTs = now;
      return _cache;
    }
    const raw = fs.readFileSync(CRED_FILE, 'utf8');
    _cache = JSON.parse(raw);
    _cacheTs = now;
    return _cache;
  } catch (e) {
    console.error('[credentials] load failed:', e.message);
    _cache = {};
    _cacheTs = now;
    return _cache;
  }
}

function _reload() {
  _cache = null;
  _cacheTs = 0;
  return _load();
}

function _save(c) {
  // 2026-10-26 (第 110 批): 首次安装时 ~/.pangu/ 可能还不存在 ——
  //   直接 writeFileSync 会 ENOENT 抛出去, 于是「存凭证」这条路在干净机器上是坏的。
  try { fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true, mode: 0o700 }); } catch (_) {}
  fs.writeFileSync(CRED_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CRED_FILE, 0o600); } catch (_) {}
  _reload();
}

/**
 * 内部 use — tool 内部读取凭证 value (不返给 LLM, 不进 log)
 * 优先级: env (PANGU_CRED_<name>) > credentials_file > null
 */
function get(name) {
  // env 优先 (PANGU_CRED_<NAME> 大写)
  const envKey = 'PANGU_CRED_' + name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  if (process.env[envKey]) return process.env[envKey];
  const c = _load();
  const entry = c[name];
  if (!entry) return null;
  if (entry.enabled === false) return null;
  return entry.value || null;
}

/**
 * 内部 use — 给 tool 调用注入 HTTP header
 * 自动判断格式: sk-X → Bearer, ghp_XXX/ghs_XXX → token, 其他 → Bearer (默认)
 */
function injectHeader(name, headerName = 'Authorization') {
  const v = get(name);
  if (!v) return null;
  let headerValue = v;
  if (typeof v === 'string') {
    if (v.startsWith('sk-') || v.startsWith('sk_') || v.startsWith('sk-cp-')) {
      headerValue = `Bearer ${v}`;
    } else if (v.startsWith('ghp_') || v.startsWith('ghs_') || v.startsWith('github_pat_')) {
      headerValue = `token ${v}`;
    } else if (v.startsWith('xoxb-') || v.startsWith('xoxp-')) {
      headerValue = `Bearer ${v}`;
    } else if (v.startsWith('Basic ')) {
      headerValue = v;  // 已带 Basic 前缀
    } else {
      headerValue = `Bearer ${v}`;
    }
  }
  return { [headerName]: headerValue };
}

/**
 * 内部 use — Basic Auth (user + pass)
 * 用于 SMTP / FTP / 老式 API
 */
function injectBasicAuth(name) {
  const c = _load();
  const entry = c[name];
  if (!entry || entry.enabled === false) return null;
  if (!entry.user || !entry.pass) return null;
  const cred = Buffer.from(`${entry.user}:${entry.pass}`).toString('base64');
  return { 'Authorization': `Basic ${cred}` };
}

/**
 * 用户用 (UI 列出) — 列出所有凭证,不带 value
 */
function listPublic() {
  const c = _load();
  return Object.keys(c).sort().map(name => {
    const e = c[name];
    return {
      name,
      enabled: e.enabled !== false,
      note: e.note || '',
      hasUser: !!e.user,
      createdAt: e.createdAt || null,
      updatedAt: e.updatedAt || null,
      lastUsedAt: e.lastUsedAt || null,
      hasValue: !!e.value || !!e.pass,
    };
  });
}

/**
 * 用户用 (UI 录入/更新) — 加或更新凭证
 */
function set(name, value, opts = {}) {
  if (!name || typeof name !== 'string') {
    return { ok: false, error: 'INVALID_NAME' };
  }
  if (!value && !opts.user) {
    return { ok: false, error: 'MISSING_VALUE' };
  }
  const c = _load();
  const existing = c[name] || {};
  c[name] = {
    ...existing,
    ...opts,
    value: value !== undefined ? value : existing.value,
    enabled: opts.enabled !== false,
    updatedAt: new Date().toISOString(),
    createdAt: existing.createdAt || new Date().toISOString(),
  };
  _save(c);
  return { ok: true, name };
}

/**
 * 用户用 (UI 删除) — 删凭证
 */
function remove(name) {
  const c = _load();
  if (!c[name]) return { ok: false, error: 'NOT_FOUND' };
  delete c[name];
  _save(c);
  return { ok: true, name };
}

/**
 * 用户用 (UI 启停) — 启用/禁用凭证 (不删, 可恢复)
 */
function toggle(name, enabled) {
  const c = _load();
  if (!c[name]) return { ok: false, error: 'NOT_FOUND' };
  c[name].enabled = !!enabled;
  c[name].updatedAt = new Date().toISOString();
  _save(c);
  return { ok: true, name, enabled: !!enabled };
}

/**
 * 内部 use — touch lastUsedAt (用于审计 + UI 显示)
 */
function touch(name) {
  const c = _load();
  if (!c[name]) return;
  c[name].lastUsedAt = new Date().toISOString();
  _save(c);
}

/**
 * 内部 use — audit-safe 列出 (永远不带 value)
 * 给任何 log / SSE event / evolution record 用
 */
function safeList() {
  return listPublic();
}

module.exports = {
  // 内部 (tool 用) — 返 value, 不进 LLM
  get,
  injectHeader,
  injectBasicAuth,
  touch,
  // 用户用 (UI) — 不返 value
  listPublic,
  set,
  remove,
  toggle,
  // audit-safe
  safeList,
  // meta
  reload: _reload,
  CRED_FILE,
};
