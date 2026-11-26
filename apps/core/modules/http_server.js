// modules/http_server.js — N5 refactor batch B4-Phase 1
// HTTP server 包装: 抽 http.createServer 回调本体到独立模块
// 依赖注入: init({ deps }) — deps 是 pangu-single.js 中所有 handler 闭包可用的引用
// 设计: 接收整个路由回调 (function (req, res)), 由 pangu-single.js 提供

let _handler = null;

function init({ requestHandler }) {
  _handler = requestHandler;
}

// CORS 修: 原来是 Access-Control-Allow-Origin: * — 任意恶意网页都能从浏览器
// fetch 127.0.0.1:18901 调 exec_command。改为白名单反射 Origin。
// 无 Origin 头的请求 (curl / 同源 / 桌面客户端) 不受影响。
//
// 2026-10-26 第 107 批 (桌面端下线): 白名单里那两条 5173/4173 是**给已下线的
// Vite dev server 开的** —— dev server 没了, 这两条只剩"给浏览器放行打本地 API
// 的口子", 属于白拿的攻击面, 删掉。
//
// 通用型做法 (老板 2026-10-26:「不要局限到个别云端或者本地」):
//   白名单**不写死任何厂商/端口**, 需要跨源时用环境变量自己加:
//     PANGU_ALLOWED_ORIGINS="https://a.example,https://b.example"
//   逗号分隔; '*' 明确不许 (那等于回到 Access-Control-Allow-Origin: *)。
const ALLOWED_ORIGINS = new Set([
  'http://localhost:18901', 'http://127.0.0.1:18901',
]);

// 环境变量追加 (跨源接入用)。'*' 一律忽略 —— 宁可拒, 不给"万能开"。
for (const _o of String(process.env.PANGU_ALLOWED_ORIGINS || '').split(',')) {
  const _s = _o.trim();
  if (!_s) continue;
  if (_s === '*') {
    console.warn('[http_server] PANGU_ALLOWED_ORIGINS 里的 "*" 已忽略 —— 不许放开全源 CORS');
    continue;
  }
  ALLOWED_ORIGINS.add(_s);
}

// 可选 token 鉴权: 设了 PANGU_TOKEN 环境变量后, 写方法 (POST/PATCH/DELETE)
// 必须带 Authorization: Bearer <token>; 未设置则保持现状 (绑定 127.0.0.1 兜底)
const AUTH_TOKEN = process.env.PANGU_TOKEN || null;
let _warnedNoToken = false;

// 2026-10-27 第 118 批: 跨源**写**请求直接拒。
//
// 背景: 上面那段 CORS 只管**响应头** —— 白名单外的 Origin 不给 ACAO。但
//   「简单请求」(Content-Type: text/plain) 不走预检 ⇒ 浏览器照样把请求发出去,
//   服务端照样执行 ⇒ 恶意网页能让盘古跑任意工具 (CSRF)。
//   ACAO 是「读」的闸门, 挡不住「写」。
//
// 判据 (三条同时成立才拒):
//   ① 请求带 Origin 头 (没有 Origin = curl / CLI / 本机脚本, 不受影响)
//   ② 是写方法 (POST / PUT / PATCH / DELETE)
//   ③ Origin 既不在白名单里, 也**不是同源**
// 同源 = Origin 的 host:port == 请求的 Host 头 —— 这样内网用 IP 访问
// (http://192.168.x.x:18901) 照样是同源, 不会被这条误伤。
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

function isSameOrigin(origin, host) {
  try {
    const o = new URL(origin);
    const h = String(host || '').trim();
    if (!h) return false;
    if (o.host === h) return true;                       // host:port 完全一致
    return o.hostname === h.replace(/:\d+$/, '');       // 端口不同但主机名一致
  } catch (_) {
    return false;
  }
}

function createServer(requestHandler) {
  if (typeof requestHandler === 'function') _handler = requestHandler;
  const http = require('http');
  return http.createServer(async (req, res) => {
    // 把 res 绑到 req, 让 data guard 能写 413
    req._panguRes = res;
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      return res.end();
    }

    // 跨源写请求 ⇒ 403 (见上面注释)
    if (origin && WRITE_METHODS.includes(req.method)
        && !ALLOWED_ORIGINS.has(origin)
        && !isSameOrigin(origin, req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: false,
        error: 'cross-origin write rejected: ' + origin
          + ' (要跨源写, 在 PANGU_ALLOWED_ORIGINS 里显式加这个源)',
      }));
    }

    if (AUTH_TOKEN && ['POST', 'PATCH', 'DELETE'].includes(req.method)) {
      const auth = req.headers.authorization || '';
      if (auth !== 'Bearer ' + AUTH_TOKEN) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'unauthorized: 需要 Bearer token (PANGU_TOKEN)' }));
      }
    } else if (!AUTH_TOKEN && !_warnedNoToken) {
      _warnedNoToken = true;
      console.warn('[http_server] 未设置 PANGU_TOKEN, 写接口无鉴权 (仅绑 127.0.0.1 兜底)');
    }

    try {
      if (_handler) {
        await _handler(req, res);
      } else {
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ok: false, error: 'http_server not initialized'}));
      }
    } catch (e) {
      console.error('[http_server] uncaught error:', e.message);
      if (!res.headersSent) {
        try {
          res.writeHead(500, {'Content-Type': 'application/json'});
          res.end(JSON.stringify({ok: false, error: e.message}));
        } catch (_) {}
      }
    }
  });
}

module.exports = { init, createServer };
