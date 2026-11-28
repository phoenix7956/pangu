'use strict';

// 2026-10-27 (第 114 批): 盘古工作台 (浏览器 UI)
//
// ─────────────────────────────────────────────────────────────────────────
// 老板原话: 「现在可以, minimax也比原来快的很多, **但是没有ui了**」。
//
// 事实: 第 108 批把桌面端 (Electron/Tauri + React/Vite 那一整套) 剥离干净了,
//   core 变成纯 API —— 结果**一个能点的界面都没有了**, 盘古只能 curl 驱动。
//
// 本批的做法: 沿用第 113 批的路子 —— **手写静态页, 零依赖零构建**, 挂在 core 上。
//   · 桌面端不复活: 没有构建产物、没有打包、没有外壳 ⇒ 开源导出依旧干净;
//   · 工作台只是 core 的**客户端**: 全程打 HTTP API, 不碰内核内部;
//   · 静态出口登记制: 只伺服 web/ 下登记过的目录 (/bazi 八字, /app 工作台)。
//
// 本文件锁五件事:
//   1. /app 与 /bazi 都要 301 到带尾斜杠 (否则相对路径全丢), 且静态出口只伺服登记过的目录
//   2. 越界一律拒 (两个前缀都要测)
//   3. 工作台不许把桌面端那套构建产物/框架带回来 (react / vite / node_modules)
//   4. 六个视图都在, 且都导出 render
//   5. SSE 解析能吃盘古真发的事件 (event 名 + JSON data)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const CORE = path.join(__dirname, '..');
const APP = path.join(CORE, 'web', 'app');
const ROUTE = path.join(CORE, 'pangu-single', 'routes', 'web_static.js');

const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(APP, 'app.mjs'), 'utf8');

function _res() {
  return {
    _status: 0, _headers: {}, _body: '',
    writeHead(s, h) { this._status = s; this._headers = h || {}; },
    end(b) { if (b) this._body = Buffer.isBuffer(b) ? b.toString('utf8') : String(b); },
  };
}

function _serve(url) {
  const mod = require(ROUTE);
  const res = _res();
  const handled = mod.handler({ method: 'GET', url }, res);
  return { handled, res };
}

test('114-1: 根路径回工作台; /app 301 到 /; /bazi 直接就是工作台路由 (第 140 批)', () => {
  // 第 140 批: 工作台就在根路径 —— '/' 直接回界面本体, 不绕 /app
  const root = _serve('/');
  assert.strictEqual(root.handled, true, '/ 必须被处理');
  assert.strictEqual(root.res._status, 200);
  assert.match(root.res._headers['Content-Type'] || '', /text\/html/);

  // 老前缀 ⇒ 301 到 / (浏览器保留 fragment ⇒ 老书签 #/bazi 照样进)
  for (const url of ['/app', '/app/']) {
    const r = _serve(url);
    assert.strictEqual(r.res._status, 301, url + ' 必须 301');
    assert.strictEqual(r.res._headers.Location, '/', url + ' 必须指向 /');
  }
  // 第 141 批: 静态资源搬到**基址根** (相对地址要解析得到) ⇒ 老前缀 /app/* 301 到 /
  const ok = _serve('/app/index.html');
  assert.strictEqual(ok.handled, true, '/app/index.html 必须被处理');
  assert.strictEqual(ok.res._status, 301, '/app/index.html 必须 301');
  assert.strictEqual(ok.res._headers.Location, '/');

  // 资源从基址根出
  const css = _serve('/themes.css');
  assert.strictEqual(css.handled, true, '/themes.css 必须被处理');
  assert.strictEqual(css.res._status, 200);
  assert.match(css.res._headers['Content-Type'] || '', /text\/css/);

  // 八字排盘是工作台的路由 ⇒ 老链接直接回工作台 (不再 301 到 /app/#/bazi)
  for (const url of ['/bazi']) {
    const b = _serve(url);
    assert.strictEqual(b.res._status, 200, url + ' 必须 200 (不是 404)');
    assert.match(b.res._headers['Content-Type'] || '', /text\/html/);
  }
  // 没登记的前缀一律不碰
  for (const p of ['/foo/', '/assets/x.js', '/api/chat']) {
    const r = _serve(p);
    assert.strictEqual(r.handled, false, p + ' 不该被静态出口吃掉');
  }
  // 尾斜杠 301 到无斜杠 (相对路径解析的硬要求)
  const slash = _serve('/bazi/');
  assert.strictEqual(slash.res._status, 301, '/bazi/ 必须 301');
  assert.strictEqual(slash.res._headers.Location, '/bazi');

  // 登记制是白名单, 不是前缀通配
  const mod = require(ROUTE);
  assert.deepStrictEqual(Object.keys(mod.MOUNTS).sort(), ['/']);
});

test('114-2: 两个前缀的越界一律拒', () => {
  for (const p of ['/app/../package.json', '/bazi/../package.json',
    '/app/%2e%2e%2f%2e%2e%2fpackage.json', '/app/../../pangu-single.js']) {
    const r = _serve(p);
    assert.ok(r.handled === false || r.res._status === 403 || r.res._status === 404
      || r.res._status === 301,
      p + ' 越界没被挡住 (handled=' + r.handled + ' 状态 ' + r.res._status + ')');
    assert.ok(!/package\.json|"name"/.test(r.res._body), p + ' 泄漏了仓库文件');
  }
});

test('114-3: 工作台不许把桌面端那套构建产物/框架带回来', () => {
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else files.push(full);
    }
  })(APP);
  assert.ok(files.length >= 8, '工作台文件太少: ' + files.length);
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    // vendor/ 里是**第三方成品库** (plotly 等): 它内部的 `plotly_react` /
    //   `t.react=n.react` 是库的属性名, 不是「桌面端 React 回流」。
    //   框架回流判据只核**自写代码** (web/app 下非 vendor 部分)。
    const isVendored = f.replace(/\\/g, '/').includes('/vendor/');
    // 2026-10-27 (第 116 批): 扫**代码**, 不扫注释 ——
    //   「原版用 lucide-react」这种说明性注释被判成「框架回流」是假红。
    //   (前导 (^|\s) 保证 http:// 里的 // 不被当注释切掉)
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    if (!isVendored) {
      // Plotly.react() 是图表库的原地更新方法 (不是 React 框架), 排除误报
      const srcNoPlotlyReact = src.replace(/\bPlotly\.react\b/g, '');
      assert.ok(!/\breact\b/i.test(srcNoPlotlyReact), path.basename(f) + ' 里出现 react ⇒ 桌面端那套回来了');
      assert.ok(!/\bvite\b/i.test(src), path.basename(f) + ' 里出现 vite ⇒ 桌面端那套回来了');
      assert.ok(!/from ['"]node_modules/.test(src), path.basename(f) + ' 引了 node_modules');
    }
    // 「自给自足」管的是**真去加载外部资源**, 不是文本里出现 URL:
    //   · w3.org 的 XML 命名空间 (createElementNS 用) —— 不发请求
    //   · 输入框 placeholder 里的示例地址 (如 api.openai.com/v1) —— 是给用户看的
    // 所以只查「会发起加载」的那几处: script/link 的 src|href、CSS @import|url()、
    // ES import、fetch、new URL。
    const LOADS = [
      /<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)\s*=\s*["']https?:/i,
      /@import\s+(?:url\()?\s*["']?https?:/i,
      /url\(\s*["']?https?:/i,
      /\bimport\s[^;\n]*\bfrom\s*["']https?:/i,
      /\bfetch\(\s*["']https?:/i,
      /new\s+URL\(\s*["']https?:/i,
    ];
    for (const re of LOADS) {
      assert.ok(!re.test(src),
        path.basename(f) + ' 引了外部资源 (静态页必须自给自足): ' + re);
    }
  }
});

test('114-4: 各视图都在, 且都导出 render', async () => {
  // 2026-10-27 (第 116 批): 视图集变了 —— sessions/tools 拆成 history/marketplace,
  //   又加了 team(自动化) / subagents(将灵) / settings(系统设置)。
  //   「六个视图」是第 114 批的旧口径, 这里改成跟着实际视图目录走。
  const views = fs.readdirSync(path.join(APP, 'views'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.replace(/\.mjs$/, ''));
  assert.ok(views.length >= 6, '视图太少: ' + views.length);
  for (const v of views) {
    const file = path.join(APP, 'views', v + '.mjs');
    assert.ok(fs.existsSync(file), '缺视图: ' + v);
    const mod = await import(pathToFileURL(file).href);
    assert.strictEqual(typeof mod.render, 'function', v + ' 没导出 render');
  }
  // 侧栏入口 (含八字排盘外链)
  const nav = [...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
  for (const v of views.filter((v) => v !== 'settings').concat(['bazi'])) {
    assert.ok(nav.includes(v), '侧栏缺入口: ' + v);
  }
  // 视图不许各写各的 fetch 包装 ⇒ 都走 lib/util.mjs
  for (const v of views) {
    const src = fs.readFileSync(path.join(APP, 'views', v + '.mjs'), 'utf8');
    assert.ok(/lib\/util\.mjs/.test(src), v + ' 没走 lib/util.mjs');
  }
});

test('114-5: SSE 解析能吃盘古真发的事件 (现场实测的 event 名 + JSON data)', async () => {
  const sse = await import(pathToFileURL(path.join(APP, 'lib', 'sse.mjs')).href);
  const raw = [
    'event: thinking',
    'data: {"phase":"on","chars":0}',
    '',
    'event: stream_delta',
    'data: {"delta":"我是","accumulated":"我是"}',
    '',
    'event: final',
    'data: {"text":"我是盘古"}',
    '',
  ].join('\n');
  const ev = sse.parseEvent(raw);
  assert.strictEqual(ev.event, 'thinking');
  assert.strictEqual(ev.data.phase, 'on');
  const ev2 = sse.parseEvent('event: final\ndata: {"text":"x"}');
  assert.strictEqual(ev2.event, 'final');
  assert.strictEqual(ev2.data.text, 'x');
  // 非 JSON 的 data 也得能过 (别把整轮对话搞崩)
  const ev3 = sse.parseEvent('event: info\ndata: 纯文本');
  assert.strictEqual(ev3.event, 'info');
  assert.strictEqual(ev3.data, '纯文本');
});

test('114-6: API 索引页要挂出工作台入口', () => {
  // 2026-10-28 (第 139 批): 索引页从根路径挪到 /api, 文件从内联模块变成静态页
  // 2026-10-28 (第 140 批): 入口是根路径 —— 地址里不许再出现 /app 前缀
  const idx = fs.readFileSync(path.join(CORE, 'web', 'api', 'index.html'), 'utf8');
  assert.ok(idx.includes('href="./"'), 'API 索引页里没有工作台入口 (href="./")');
  // 页面链接不许指向 /app (静态资源 href="/app/themes.css" 不算 —— 那是样式表)
  assert.ok(!/<a[^>]+href="\/app/.test(idx), '索引页不许再指向 /app (工作台就在 /)');
});
