// web_static.js —— 静态页出口 (工作台 + API 索引页)
//
// ── 为什么在核心里留一个静态出口 ─────────────────────────────────
//   第 108 批把**桌面端**彻底剥离了 (React/Vite/Tauri 那一整套), core 不再伺服
//   任何前端**构建产物** —— 那条规矩仍然成立, 本模块一行构建产物都不碰。
//   但「构建产物」跟「手写的独立静态页」是两回事:
//     · 桌面端是 Electron/Tauri 外壳 + 打包产物 + 主题/设置/市场/命令面板等一堆
//       与核心无关的壳子 ⇒ 剥离是对的;
//     · 八字排盘页是**一页静态文件** (html/css/js, 零依赖零构建), 直接调核心的
//       HTTP API ⇒ 它是核心的**一个客户端**, 不是核心的一部分。
//   2026-10-27 老板拍: AI 解读挪到最下面 + 批语逐项分次请求 + 预算不再走 6500
//   ⇒ 这一页必须有个能长期用的落点, 不能只活在浏览器内存里。
//
// 边界 (硬规矩):
//   · 只伺服 `apps/core/web/` 下**登记过的子目录** (app), 一个字节都不出去;
//   · 路径归一化后必须仍在该目录内 (`..` 一律拒绝);
//   · 只认白名单里的扩展名;
//   · 别的路径一律 return false, 落回 router。
//
// 2026-10-27 (第 119 批): 八字排盘从独立静态页 (/bazi/) 搬进工作台 ⇒ 变成 #/bazi。
//   老链接 (/bazi, /bazi/) 不删, 301 到 /app/#/bazi —— 老书签、老文档、老群里的链接
//   点了还能用, 不会变成 404。**只重定向, 不再伺服那个目录** (目录已删)。
//
// 2026-10-28 (第 139 批): 根路径 `/` 不再是那张「裸 API 索引页」。
//   以前 `/` 是一张只有表格的 API 清单 —— 那是第 108 批剥离桌面端时的「诚实回答」,
//   当时确实没有界面, 说清楚比装糊涂好。但盘古现在**自带工作台**了, 根路径还停在那张
//   表上 ⇒ 开源用户 clone 完跑起来, 打开地址看到的是一张文档表, 不是产品。
//   ⇒ API 索引页挪到 `/api`, 按工作台那套令牌重做。
//   ⇒ 老的 `modules/api_index.js` (纯内联 HTML 的根路径页) 一并删除, 静态页只有
//     这一个出口 —— 免得 core 里有两个「伺服页面」的地方, 将来各改各的。
//
// 2026-10-28 (第 140 批): 地址里不再带 `/app`, 也不再带 `#`。
//   产品级的地址应该是 `http://127.0.0.1:18901/bazi` —— 一段路径, 干净。
//   ⇒ `/` 直接回工作台的 index.html (不再 302 绕一圈);
//   ⇒ 登记过的视图路径 (`/bazi` `/settings/permission` …) 也回 index.html
//     —— **白名单, 不是通配**: 不登记的路径一律落回 router (真 API 路由不受影响);
//   ⇒ `/app` `/app/` 老地址 301 到 `/` (浏览器会带上原 fragment, 老书签照样进)。
//
// 2026-10-28 (第 141 批): **全站地址改成相对路径** (老板: 「**必须相对路径**」)。
//   为什么要相对: 开源用户 clone 完可能把盘古挂在 nginx 的 `/pangu/` 这种**子路径**
//   下面, 或者挂在域名根上。前端只要写死一个前导斜杠 (`/api/xxx`), 挂到子路径下
//   就全废 —— 浏览器会去找 `http://host/api/xxx`, 漏掉了前缀。
//   ⇒ 前端所有 URL 一律相对 (无前导斜杠), 由浏览器按**当前文档基址**解析;
//   ⇒ 静态资源挂到**应用基址根** (`/` ⇒ web/app), 相对路径才解析得到;
//   ⇒ 路由**全部单段** (`/bazi` `/settings?tab=agent`) —— 多段路径 (/settings/agent)
//     会让相对路径解析到子目录去 (`/settings/themes.css`), 这是硬约束;
//   ⇒ 服务端支持 `X-Forwarded-Prefix` (反代前缀) ⇒ 前缀由服务端摘掉再路由,
//     所以前端不必知道前缀, 前端也不用写绝对路径。
//   ⇒ 静态资源挂载改成「**文件不存在就落回 router**」—— 否则 `/api/version`
//     会被当成「目录里没这个文件」吃掉, 真 API 路由全废 (第 139 批踩过)。

const path = require('path');
const fs = require('fs');

const WEB_ROOT = path.resolve(__dirname, '..', '..', 'web');

// 登记制: URL 前缀 ⇒ 目录名。新页面要在这里登记一行, 不登记的一律不伺服。
//   第 141 批: 挂载点是**应用基址根** (`/`), 不是 `/app` —— 前端的相对 URL
//   (themes.css / app.mjs / api/xxx) 要能在**任何**基址下解析, 资源就必须
//   跟界面本体待在同一个基址里。
const MOUNTS = {
  '/': 'app',        // 工作台本体 + 它的静态资源 (对话 / 六十四卦 / 梅花起卦 / 历史 / 工具 / 状态)
};

// 登记制 (精确路径): URL ⇒ 文件。跟 MOUNTS 分开是因为这些是**整页**不是目录 ——
//   用前缀挂载会跟 `/api/*` 的真路由撞车 (`/api/version` 会被当成目录里的文件,
//   结果 404 把真端点吃掉)。所以这里只认**完全相等**的路径。
const PAGES = {
  '/api': 'api/index.html',       // API 索引页 (开发者看的: 端点清单 + 接入示例)
};

// 登记制: 工作台的视图路径 ⇒ 回 index.html (前端自己认路由)。
//   白名单 —— 少登记一个, 那一页就 404; 多登记一个, 未知路径就变成 200。
//   这份清单必须跟前端 app.mjs 的 VIEWS 一致 (守卫逐条比对, 见 tests/)。
const SPA_VIEWS = new Set([
  'team', 'hexagrams', 'history', 
  'marketplace', 'subagents', 'status', 'settings',
  
  // 第 176 批: 进化页 (自进化账本的逐日趋势) —— 漏登 /evolution 就 404
  'evolution',
  // chat = 根路径的视图, 但 /chat 也该回 index.html (前端路由: /chat 认得出,
  // 落到 chat 视图)。第 156 批: 以前 /chat 直接 404, 老板截图里那个 JSON 黑框
  // 就是这个 —— 跟 "整个 UI 太烂" 一样糟观感, 顺手修了。
  'chat',
]);

// 设置的子项 (第 141 批: 子页改查询参数 ⇒ 路由保持单段)
//   `/settings/agent` ⇒ 301 到 `/settings?tab=agent` (老链接照样进)
const SETTINGS_TABS = new Set([
  'connect', 'model', 'agent', 'tools', 'mcp', 'permission',
  'ui', 'storage', 'credentials', 'selfrepair', 'voice', 'update',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * @returns {boolean} true = 已处理 (响应已写完)
 */
function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch (e) {
    return false;
  }
  if (pathname === '') pathname = '/';
  // 反代前缀 (X-Forwarded-Prefix): 前端全用相对路径 ⇒ 前缀由服务端摘掉。
  //   nginx 写法: proxy_set_header X-Forwarded-Prefix /pangu;
  const prefix = (req && req._panguPrefix) || '';

  // 老地址 ⇒ 现在的地址 (301)。浏览器会保留原 fragment ⇒ 老书签 #/bazi 照样进。
  //   第 140 批: 八字排盘的老链接 (/bazi) 现在**直接就是工作台的路由** (/bazi 回 index.html),
  //   不需要再 301 绕一圈; '/app' 这种老前缀才需要搬家 (→ '/')。
  if (pathname === '/app' || pathname.startsWith('/app/')) {
    return _redirect(res, prefix + '/');
  }

  // 登记过的整页 (精确匹配, 不吃前缀)
  const page = PAGES[pathname];
  if (page) {
    return _sendFile(req, res, path.join(WEB_ROOT, page));
  }

  // 尾斜杠: 单段路由**不许**带尾斜杠。
  //   浏览器把相对路径按「最后一段」解析: 页面在 `/bazi/` 时, 相对 `themes.css`
  //   会被解析成 `/bazi/themes.css` ⇒ 样式全丢。所以一律 301 到不带斜杠的地址。
  if (pathname.length > 1 && pathname.endsWith('/')) {
    const trimmed = pathname.replace(/\/+$/, '');
    if (PAGES[trimmed] || SPA_VIEWS.has(trimmed.replace(/^\/+/, ''))) {
      return _redirect(res, prefix + trimmed);
    }
  }

  // 老的多段设置路径 ⇒ 单段 + 查询参数 (第 141 批)。
  //   `/settings/agent` → `/settings?tab=agent`; `/settings/agent/qian` → `?tab=agent&code=qian`
  const legacy = /^\/settings\/([a-z-]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(pathname);
  if (legacy) {
    const tab = SETTINGS_TABS.has(legacy[1]) ? legacy[1] : 'connect';
    const qs = legacy[2] ? '?tab=' + tab + '&code=' + legacy[2] : '?tab=' + tab;
    return _redirect(res, prefix + '/settings' + qs);
  }

  // 工作台的视图路径 (/bazi, /settings?tab=agent, …) ⇒ 回 index.html。
  // 白名单: 只认登记过的视图名; 别的一律落回 router (真 API 路由 / 404 不受影响)。
  const seg = pathname.replace(/^\/+|\/+$/g, '');
  if (seg && !seg.includes('/') && SPA_VIEWS.has(seg)) {
    return _sendFile(req, res, path.join(WEB_ROOT, 'app', 'index.html'));
  }

  // 静态资源: 挂在应用基址根 (web/app)。
  //   **文件不存在就落回 router** —— 挂载点是根, `/api/version` `/config` 这些真 API
  //   路由在 web/app 里没有同名文件, 必须让它们回 router, 不许被吃掉变 404。
  const ROOT = path.join(WEB_ROOT, MOUNTS['/']);
  let rel = seg || 'index.html';

  const target = path.resolve(ROOT, rel);
  // 越界检查: 归一化后必须还在 ROOT 里面
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    return _send(res, 403, 'text/plain; charset=utf-8', 'FORBIDDEN');
  }
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (e) {
    return false;   // 没有这个文件 ⇒ 落回 router (真 API 路由 / 404 归它管)
  }
  if (!stat.isFile()) {
    return false;
  }
  const ext = path.extname(target).toLowerCase();
  if (!MIME[ext]) {
    return _send(res, 404, 'text/plain; charset=utf-8', 'NOT_FOUND');
  }
  const buf = fs.readFileSync(target);
  res.writeHead(200, {
    'Content-Type': MIME[ext],
    'Content-Length': buf.length,
    // 开发期不缓存: 改一行就要刷新能看到, 不然会像旧桌面端那样「内存里的旧页面」
    // 跟磁盘上的新代码各说各话。
    'Cache-Control': 'no-store, max-age=0, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  res.end(buf);
  return true;
}

function _redirect(res, location) {
  res.writeHead(301, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
  return true;
}

function _send(res, code, type, text) {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length });
  res.end(buf);
  return true;
}

/**
 * 伺服一个登记过的静态文件 (只给 PAGES 用)。越界检查 + 扩展名白名单跟目录挂载
 * 走同一套规矩 —— 页面白名单是**单独一张表**, 不是「目录随便进」。
 */
function _sendFile(req, res, target) {
  const resolved = path.resolve(target);
  if (resolved !== WEB_ROOT && !resolved.startsWith(WEB_ROOT + path.sep)) {
    return _send(res, 403, 'text/plain; charset=utf-8', 'FORBIDDEN');
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!MIME[ext]) {
    return _send(res, 404, 'text/plain; charset=utf-8', 'NOT_FOUND');
  }
  let buf;
  try {
    buf = fs.readFileSync(resolved);
  } catch (e) {
    return _send(res, 404, 'text/plain; charset=utf-8', 'NOT_FOUND');
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext],
    'Content-Length': buf.length,
    'Cache-Control': 'no-store, max-age=0, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  res.end(buf);
  return true;
}

module.exports = { handler, WEB_ROOT, MOUNTS, PAGES, SPA_VIEWS, SETTINGS_TABS, MIME };
