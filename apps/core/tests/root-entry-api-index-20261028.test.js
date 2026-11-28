'use strict';
/**
 * tests/root-entry-api-index-20261028.test.js
 *
 * 根路径 + API 索引页 —— 第 139 批守卫
 *
 * ── 起因 ──────────────────────────────────────────────────────
 *   第 108 批把桌面端剥离后, 18901 的根路径 `/` 回的是一张**裸 API 索引页**
 *   (纯内联 HTML, 一张端点表)。当时没有界面, 说清楚比装糊涂好。
 *   但盘古现在自带工作台了, 根路径还停在那张表上 ⇒ 开源用户 clone 完跑起来,
 *   打开地址看到的是一张文档表, 不是产品 —— 老板问「**为什么还有这个?**」。
 *   ⇒ API 索引页挪到 `/api`, 按工作台令牌重做。
 *
 * ── 第 140 批再问一次: 「**为什么非要带上 app? 或者 #?**」 ──────
 *   第 139 批的落点是 `/` → 302 → `/app/` —— 老板的意思不是「跳过去」, 是
 *   「**地址里不许有 /app, 也不许有 #**」。产品级的地址应该是
 *   `http://127.0.0.1:18901/hexagrams`。
 *   ⇒ `/` **直接**回工作台 (200, 不绕); 视图路径 (`/hexagrams` `/settings/permission`)
 *     回工作台 (白名单); 老前缀 `/app` 301 到 `/`; 静态资源仍从 `/app/` 出。
 *
 * ── 本文件锁七件事 (机器判据, 不是注释) ──────────────────────
 *   1. `GET /` 必须 200 回工作台本体 (不许再回一张裸表, 也不许绕 /app)
 *   2. `GET /api` 必须 200 + text/html + 真有内容
 *   3. 索引页里列的端点必须是**真的路由** (不许拿假端点糊弄人)
 *   4. 索引页**零外部资源** (不许 http(s):// 外链 / CDN / webfont)
 *   5. 索引页的色值必须走 themes.css 令牌 (不许复制一份十六进制色, 五行原值尤其)
 *   6. 桌面端那套静态服务器遗产不许复活 (frontend_static / api_index 都不许回来)
 *   7. 静态出口只伺服登记过的目录/整页; `/api/*` 的真路由不许被它吃掉
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const WEB = path.join(CORE, 'web');
const API_PAGE = path.join(WEB, 'api', 'index.html');
const PAGE_SRC = fs.readFileSync(API_PAGE, 'utf8');

function _serve(url, method) {
  const mod = require(path.join(CORE, 'pangu-single', 'routes', 'web_static'));
  const res = {
    _status: 0, _headers: {}, _body: '',
    writeHead(s, h) { this._status = s; this._headers = h || {}; },
    setHeader(k, v) { this._headers[k] = v; },
    end(b) { if (b) this._body = String(b); },
    write(b) { this._body += String(b); },
  };
  const handled = mod.handler({ method: method || 'GET', url }, res);
  return { handled, res };
}

// ── 1. 根路径 ⇒ 工作台本体 ─────────────────────────────────────
test('140-1: GET / 必须 200 直接回工作台 (不许绕 /app, 也不许再是裸 API 表)', () => {
  const { handled, res } = _serve('/');
  assert.strictEqual(handled, true, '"/" 必须有人处理 (不该落回 404)');
  assert.strictEqual(res._status, 200, '根路径必须 200, 实际 ' + res._status);
  assert.match(res._headers['Content-Type'] || '', /text\/html/, '根路径必须是 HTML');
  assert.ok(res._body.length > 800, '根路径不能是空的');
  assert.match(res._body, /盘古/, '根路径要说明这是盘古');
  // 关键: 根路径回的**就是工作台本体**, 不是那张裸 API 表
  assert.ok(res._body.includes('pangu-app'), '根路径必须回工作台本体 (不是 API 索引页)');
  assert.ok(!res._body.includes('pgapi-'), '根路径不许再吐 API 索引页');
});

test('140-1b: 老前缀 /app 301 到 / (浏览器保留 fragment ⇒ 老书签照样进)', () => {
  for (const url of ['/app', '/app/']) {
    const { handled, res } = _serve(url);
    assert.strictEqual(handled, true, url + ' 必须被处理');
    assert.strictEqual(res._status, 301, url + ' 必须 301');
    assert.strictEqual(res._headers.Location, '/', url + ' 必须指向 /');
  }
});

test('140-1c: 工作台的视图路径回工作台 (白名单, 不是通配)', () => {
  for (const url of ['/hexagrams', '/settings']) {
    const { handled, res } = _serve(url);
    assert.strictEqual(handled, true, url + ' 必须被处理');
    assert.strictEqual(res._status, 200, url + ' 必须 200 (不是 404)');
    assert.match(res._headers['Content-Type'] || '', /text\/html/, url + ' 必须是 HTML');
  }
  // 第 141 批: 设置的子页改成查询参数 (路由必须单段) ⇒ 老的多段地址 301 过去
  const sub = _serve('/settings/permission');
  assert.strictEqual(sub.res._status, 301, '/settings/permission 必须 301');
  assert.strictEqual(sub.res._headers.Location, '/settings?tab=permission');
  // 没登记的路径不许被静态出口吃掉 (真 API 路由 / 404 不受影响)
  for (const url of ['/api/version', '/api/config', '/nope', '/settingsx']) {
    const { handled } = _serve(url);
    assert.strictEqual(handled, false, url + ' 不该被静态出口吃掉');
  }
});

test('140-1d: 服务端的视图白名单必须跟前端 VIEWS 一致 (两份清单迟早漂)', () => {
  const mod = require(path.join(CORE, 'pangu-single', 'routes', 'web_static'));
  const appSrc = fs.readFileSync(path.join(WEB, 'app', 'app.mjs'), 'utf8');
  const block = appSrc.slice(appSrc.indexOf('const VIEWS = {'), appSrc.indexOf('const TITLES = {'));
  const views = [...block.matchAll(/^\s*([a-z]+):\s*\(\)\s*=>/gm)].map(m => m[1]);
  assert.ok(views.length >= 9, '前端 VIEWS 解析出来太少了: ' + views.length);
  // 第 156 批: chat 也在白名单里 (/chat 回 index.html, 前端路由落到 chat 视图;
  // 以前 /chat 直接 404 吐 JSON)。白名单 = 前端 VIEWS 全部视图名, 逐字对齐。
  const expected = views.slice().sort();
  assert.deepStrictEqual([...mod.SPA_VIEWS].sort(), expected,
    '服务端 SPA_VIEWS 跟前端 VIEWS 不一致 —— 两边各写一份 = 迟早漂');
});

// ── 2. API 索引页在 /api ───────────────────────────────────────
test('139-2: GET /api 必须 200 + text/html + 真有内容', () => {
  const { handled, res } = _serve('/api');
  assert.strictEqual(handled, true, '/api 必须由静态出口处理');
  assert.strictEqual(res._status, 200, '/api 状态码必须是 200');
  assert.match(res._headers['Content-Type'] || '', /text\/html/, '/api 必须是 text/html');
  assert.ok(res._body.length > 800, '/api 页面不能是空的');
  assert.match(res._body, /盘古/, '/api 页面要说明这是盘古');
  // 第 141 批: 尾斜杠 301 到无斜杠 (相对路径解析要求单段)
  const slash = _serve('/api/');
  assert.strictEqual(slash.res._status, 301, '/api/ 必须 301');
  assert.strictEqual(slash.res._headers.Location, '/api');
});

// ── 3. 索引页列的端点必须是真路由 ──────────────────────────────
test('139-3: 索引页里列的端点必须是真的路由 (不许拿假端点糊弄人)', () => {
  const paths = [...PAGE_SRC.matchAll(/<code>(\/[a-z0-9\/_-]+)<\/code>/g)].map(m => m[1]);
  assert.ok(paths.length >= 10, '索引页至少列 10 个端点, 实际 ' + paths.length);

  const routerSrc = [
    fs.readFileSync(path.join(CORE, 'pangu-single', 'routes', 'inline_router.js'), 'utf8'),
    fs.readFileSync(path.join(CORE, 'pangu-single', 'routes', 'web_static.js'), 'utf8'),
    fs.readFileSync(path.join(CORE, 'pangu-single.js'), 'utf8'),
    fs.readFileSync(path.join(CORE, 'modules', 'pangu_agent_stream.js'), 'utf8'),
  ].join('\n');
  const known = new Set(
    (routerSrc.match(/['"](\/[a-z0-9\/_-]+)['"]/g) || [])
      .map(s => '/' + s.replace(/['"]/g, '').slice(1)),
  );
  // 第 140 批: 工作台的视图路径 (/hexagrams 等) 也是真路由 —— 服务端的白名单
  const mod = require(path.join(CORE, 'pangu-single', 'routes', 'web_static'));
  for (const v of mod.SPA_VIEWS) known.add('/' + v);
  const unknown = paths.filter(p => !known.has(p));
  assert.deepStrictEqual(unknown, [],
    '索引页列了路由里不存在的端点: ' + unknown.join(', '));
});

// ── 4. 零外部资源 ──────────────────────────────────────────────
test('139-4: 索引页零外部资源 (不许外链样式 / CDN / webfont)', () => {
  const withoutComments = PAGE_SRC.replace(/<!--[\s\S]*?-->/g, '');
  // 页面里可以出现 http://127.0.0.1:18901/... (curl 接入示例里的本机地址),
  // 但**不许**出现指向别处的地址 —— 那是外链资源。
  const urls = [...withoutComments.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map(m => m[0]);
  const remote = urls.filter(u => !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(u));
  assert.deepStrictEqual(remote, [],
    '索引页不许出现指向外部的地址: ' + remote.join(', '));
  assert.ok(!/\/\/cdn\./.test(withoutComments), '索引页不许引 CDN');
  assert.ok(!/@import/.test(withoutComments), '索引页不许 @import 外部样式');
  // 资源加载 (src / <link href>) 只许指本仓; 普通 <a href> 只许站内相对路径。
  const resources = [
    ...[...PAGE_SRC.matchAll(/<link[^>]+href="([^"]+)"/g)].map(m => m[1]),
    ...[...PAGE_SRC.matchAll(/\ssrc="([^"]+)"/g)].map(m => m[1]),
  ];
  // 第 141 批: 资源一律**相对** (themes.css) —— 只许同仓相对地址
  const external = resources.filter(u => /^(https?:)?\/\//i.test(u) || u.startsWith('/'));
  assert.deepStrictEqual(external, [],
    '索引页只许引本仓的样式, 这些不是: ' + external.join(', '));
  const links = [...PAGE_SRC.matchAll(/<a[^>]+href="([^"]+)"/g)].map(m => m[1]);
  const offsite = links.filter(u => /^(https?:)?\/\//i.test(u));
  assert.deepStrictEqual(offsite, [], '索引页的链接只许指站内: ' + offsite.join(', '));
});

// ── 5. 色值走令牌 (不复制一份) ─────────────────────────────────
test('139-5: 索引页不许硬编码色值 —— 色值唯一真源是 themes.css', () => {
  const css = PAGE_SRC.slice(PAGE_SRC.indexOf('<style>'), PAGE_SRC.indexOf('</style>'));
  const hex = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]);
  assert.deepStrictEqual(hex, [],
    '索引页里不许出现十六进制色值 (换主题会漂): ' + hex.join(', '));
  // 五行原值一个都不许被复制到这一页 (页面用 var(--wood) 等令牌)
  for (const wuxing of ['00FF1D', 'FF0000', 'B28C21', 'FFEE00', '0E70F2']) {
    assert.ok(!PAGE_SRC.toUpperCase().includes(wuxing),
      '五行原值 ' + wuxing + ' 被复制进索引页了 —— 只许走 var(--xxx) 令牌');
  }
  assert.ok(PAGE_SRC.includes('href="themes.css"'),
    '索引页必须引工作台的主题文件 (令牌单一真源)');
});

// ── 6. 桌面端遗产不许复活 ─────────────────────────────────────
test('139-6: 桌面端的静态服务器半边不许复活 (frontend_static / api_index 都不许回来)', () => {
  assert.ok(!fs.existsSync(path.join(CORE, 'modules', 'frontend_static.js')),
    'modules/frontend_static.js 又回来了');
  assert.ok(!fs.existsSync(path.join(CORE, 'modules', 'api_index.js')),
    'modules/api_index.js 又回来了 —— 根路径与 API 页归静态出口管, core 里只留一个伺服页面的地方');
  const panguSingle = fs.readFileSync(path.join(CORE, 'pangu-single.js'), 'utf8');
  assert.ok(!/frontend_static/.test(panguSingle), 'pangu-single.js 还在 require frontend_static');
  const panguCode = panguSingle.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/api_index/.test(panguCode), 'pangu-single.js 还在 require api_index');
  const ws = fs.readFileSync(path.join(CORE, 'pangu-single', 'routes', 'web_static.js'), 'utf8');
  const code = ws.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/desktop/i.test(code), 'web_static.js 的代码里还有 desktop 引用');
});

// ── 7. 静态出口的白名单 ────────────────────────────────────────
test('139-7: 静态出口只伺服登记过的目录/整页, 不许偷偷当静态服务器', () => {
  const mod = require(path.join(CORE, 'pangu-single', 'routes', 'web_static'));
  assert.deepStrictEqual(Object.keys(mod.MOUNTS), ['/'],
    '目录挂载只该有基址根 (第 141 批: 相对地址要解析得到)');
  assert.ok(mod.PAGES['/api'], '整页登记里必须有 /api');
  for (const url of ['/api/version', '/api/config', '/assets/index.js', '/some/spa/route']) {
    const { handled } = _serve(url);
    assert.strictEqual(handled, false, url + ' 被静态出口吃掉了 —— 它只该处理登记过的路径');
  }
});

test('139-7b: 越界路径一律拒 (不许从 web/ 逃出去)', () => {
  const mod = require(path.join(CORE, 'pangu-single', 'routes', 'web_static'));
  assert.ok(mod.WEB_ROOT.startsWith(WEB), '静态根必须在 web/ 下');
  for (const url of ['/app/../../package.json', '/app/../pangu-single.js']) {
    const { handled } = _serve(url);
    assert.strictEqual(handled, false, url + ' 越界路径必须被拒');
  }
});
