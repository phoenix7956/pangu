// pangu-single/routes/webbuild.js —— 工作台前端「代码版本号」
//
// 为什么要有这个 (2026-10-27):
//   SPA 改 hash **不重载文档** ⇒ 浏览器 module registry 里存着**旧模块实例**。
//   服务端 `Cache-Control: no-store` 拦得住 HTTP 缓存, **拦不住 module registry**。
//   结果就是: 我改了代码、curl 也确实拿到了新文件, 但老板的标签页**还显示老样子** ——
//   这个坑今天咬了三次 (页标题丢 / 自动排盘 / 四柱表版式)。
//
//   修法: 服务端给前端一个「前端代码树的内容指纹」, 前端定时比对。
//   指纹变了 ⇒ 标签页里跑的是旧代码 ⇒ 弹一条「服务端有更新, 点此刷新」。
//   这样「改了没反应」从「靠人记得手动刷新」变成「页面自己说」。
//
// 指纹怎么算: web/app 目录下每个文件的 (相对路径, mtimeMs, size) 排序后取 sha1。
//   · 不算内容 —— 一次要读完几十个文件, 每 20 秒一次太浪费;
//   · 改任何文件 ⇒ 它的 mtime/size 变 ⇒ 指纹必变 (macOS mtime 精度 1ms, 够用)。

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WEB_APP = path.resolve(__dirname, '..', '..', 'web', 'app');

// 缓存 2 秒 —— 前端 20 秒轮询一次, 缓存只是为了挡住手贱的连打。
let _cache = { at: 0, stamp: null };

function computeStamp(root) {
  const base = root || WEB_APP;
  const parts = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(abs, r); continue; }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(abs);
        parts.push(r + ':' + st.mtimeMs + ':' + st.size);
      } catch (_) { /* 文件刚好被删/被改, 跳过 */ }
    }
  };
  walk(base, '');
  parts.sort();
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 12);
}

function stamp() {
  const now = Date.now();
  if (_cache.stamp && (now - _cache.at) < 2000) return _cache.stamp;
  try {
    _cache = { at: now, stamp: computeStamp() };
  } catch (e) {
    // 算不出来也别把前端打挂 —— 保留上次的结果 (或 null) 让前端跳过比对
    if (!_cache.stamp) _cache = { at: now, stamp: null };
  }
  return _cache.stamp;
}

function handler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0, must-revalidate',
  });
  return res.end(JSON.stringify({ ok: true, stamp: stamp() }));
}

module.exports = { handler, stamp, computeStamp };
