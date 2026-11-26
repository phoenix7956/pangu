'use strict';
/**
 * tests/relative-urls-20261028.test.js
 *
 * 第 141 批守卫 —— 站内地址必须**相对** (老板: 「**必须相对路径**」)
 *
 * ── 起因 ──────────────────────────────────────────────────────
 *   前两批把地址里的 `/app` 前缀和 `#` 碎片去掉了 (地址成了 `/bazi` 这种真路径)。
 *   老板紧接着说「必须相对路径」—— 说的是**另一层**: 前端不许写死基址。
 *   开源用户可能把盘古挂在 nginx 的 `/pangu/` 这种**子路径**下 (或者域名根下)。
 *   只要前端有一个 `href="/api/xxx"` / `fetch('/health')`, 挂到子路径下就全废:
 *   浏览器会去找 `http://host/api/xxx`, 把前缀丢了。
 *   ⇒ 所有站内地址一律**相对** (不带前导斜杠), 由浏览器按当前文档基址解析。
 *
 * ── 为什么路由必须**单段** (硬约束, 不是风格) ─────────────────
 *   浏览器把相对路径按「最后一段」解析: 页面在 `/settings/agent` 时,
 *   相对 `themes.css` 会解析成 `/settings/themes.css` ⇒ 样式全丢。
 *   ⇒ 路由全部单段: `/bazi` `/settings?tab=agent` (子页改查询参数)。
 *
 * ── 本文件锁七件事 (机器判据, 不是注释) ──────────────────────
 *   1. 客户端 JS 里不许出现绝对站内路径字面量 ('/api/x' '/health' …)
 *   2. HTML 里不许出现 href="/ 或 src="/ (资源与链接一律相对)
 *   3. 路由必须单段 (前端导航值 + 服务端白名单都不许带 '/')
 *   4. 静态资源挂在**基址根**且真的取得到; 真 API 路由不许被它吃掉
 *   5. 尾斜杠一律 301 到无斜杠 (相对解析的硬要求)
 *   6. 老的多段地址 301 到新单段地址
 *   7. 反代前缀 (X-Forwarded-Prefix) 生效 —— 前端不必知道前缀
 *   8. 相对解析的**行为**自检: 逐个视图路径模拟浏览器解析, 断言落在基址根
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const WEB = path.join(CORE, 'web');
const APP = path.join(WEB, 'app');
const ROUTE = path.join(CORE, 'pangu-single', 'routes', 'web_static.js');

// 判据只看代码, 不看注释 (注释里经常正写着「不许 xxx」, 全文匹配会咬自己一口)。
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join('\n');

/** 取源码里的字符串字面量 (只认成对的单/双引号)。 */
function stringLiterals(src) {
  const out = [];
  const re = /(['"])((?:\\.|(?!\1)[^\\\r\n])*)\1/g;
  let m;
  while ((m = re.exec(src))) out.push(m[2]);
  return out;
}

/** 是不是「绝对站内路径」字面量 (以单个 '/' 开头的路径)。 */
function isAbsoluteSitePath(s) {
  if (typeof s !== 'string') return false;
  if (!s.startsWith('/')) return false;
  if (s.startsWith('//')) return false;          // 协议相对地址 (//host) —— 那是外链
  return /^(\/[A-Za-z0-9._~%\-]+)+(\/[A-Za-z0-9._~%\-]*)*$/.test(s);
}

// 站内的**命名空间** —— 这几个是盘古后端的顶层路径。凡是它们出现在源码里,
//   不管在什么位置, 都是「写死了基址」⇒ 违规 (兜底网, 防止有人先存成变量再用)。
const NAMESPACES = ['api', 'health', 'config', 'modules', 'nodes',
  'cleanup', 'skills', 'hexagrams', 'hexagram', 'sessions'];

// **URL 位置** —— 这些地方出现绝对路径, 浏览器就会拿它去请求 origin 根。
//   判据只看「引号紧跟在这些调用/属性后面」, 所以 '/convert-to-mcp' 这种
//   拼接出来的路径片段、'/path/to/script.sh' 这种给用户填的占位符, 都不会被误判。
const URL_POS = [
  /\bfetch\(\s*(['"])(\/[^'"]*)\1/g,
  /\bEventSource\(\s*(['"])(\/[^'"]*)\1/g,
  /\bjson\(\s*(['"])(\/[^'"]*)\1/g,
  /\bsend\(\s*(['"])(\/[^'"]*)\1/g,
  /\bstreamSSE\(\s*(['"])(\/[^'"]*)\1/g,
  /\bcall\(\s*(['"][A-Za-z]+['"])\s*,\s*(['"])(\/[^'"]*)\2/g,
  /\bnavigate\(\s*(['"])(\/[^'"]*)\1/g,
  /\bgo:\s*(['"])(\/[^'"]*)\1/g,
  /\bhref:\s*(['"])(\/[^'"]*)\1/g,
  /\bsrc:\s*(['"])(\/[^'"]*)\1/g,
  /\blocation\.href\s*=\s*(['"])(\/[^'"]*)\1/g,
];

function walk(dir, out) {
  const files = out || [];
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function _serve(url, headers) {
  const mod = require(ROUTE);
  const res = {
    _status: 0, _headers: {}, _body: '',
    writeHead(s, h) { this._status = s; this._headers = h || {}; },
    setHeader(k, v) { this._headers[k] = v; },
    end(b) { if (b) this._body = Buffer.isBuffer(b) ? b.toString('utf8') : String(b); },
  };
  const req = { method: 'GET', url, headers: headers || {} };
  const handled = mod.handler(req, res);
  return { handled, res };
}

// ── 1. 客户端 JS: 零绝对站内路径 ───────────────────────────────
test('141-1: 客户端不许出现绝对站内路径字面量 (一律相对)', () => {
  const files = walk(APP).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length >= 20, '前端文件太少: ' + files.length);
  const bad = [];
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    const rel = path.relative(APP, f);
    // ① URL 位置上的绝对路径
    for (const re of URL_POS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const lit = m[2] || m[3] || '';
        if (lit && isAbsoluteSitePath(lit)) bad.push(rel + ' → ' + JSON.stringify(lit));
      }
    }
    // ② 兜底网: 顶层命名空间出现在任何地方都不许
    for (const lit of stringLiterals(src)) {
      if (!isAbsoluteSitePath(lit)) continue;
      const head = lit.replace(/^\/+/, '').split('/')[0];
      if (NAMESPACES.includes(head)) bad.push(rel + ' → ' + JSON.stringify(lit));
    }
  }
  assert.deepStrictEqual(bad, [],
    '客户端有绝对站内路径 (写死基址 ⇒ 挂到子路径下全废):\n' + bad.join('\n'));
});

test('141-1b: 负例自检 —— 判据本身要能判红 (不然是装饰)', () => {
  assert.ok(isAbsoluteSitePath('/api/version'), '判据该认 /api/version');
  assert.ok(isAbsoluteSitePath('/health'), '判据该认 /health');
  assert.ok(!isAbsoluteSitePath('api/version'), '相对路径不该被判红');
  assert.ok(!isAbsoluteSitePath('http://127.0.0.1:18901/health'), '绝对地址不该被判红');
  assert.ok(!isAbsoluteSitePath('//cdn.example.com/x.js'), '协议相对地址不该被判红');
  assert.ok(!isAbsoluteSitePath('settings?tab=agent'), '带查询参数的相对路由不该被判红');
  // 判据要真的能从源码里挑出来 (自检: 造一段坏代码)
  const fake = "const x = '/api/version';";
  const found = stringLiterals(stripComments(fake)).filter(isAbsoluteSitePath);
  assert.deepStrictEqual(found, ['/api/version'], '判据在假代码上没挑出来');
});

// ── 2. HTML: 资源与链接一律相对 ───────────────────────────────
test('141-2: HTML 里不许有 href="/ 或 src="/ (资源与链接必须相对)', () => {
  const htmls = [path.join(APP, 'index.html'), path.join(WEB, 'api', 'index.html')];
  for (const f of htmls) {
    const src = fs.readFileSync(f, 'utf8');
    const abs = [...src.matchAll(/\b(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(abs, [],
      path.basename(f) + ' 里有绝对站内地址: ' + abs.join(', '));
  }
});

test('141-3: 相对资源必须真的存在 (相对 ≠ 写错)', () => {
  // 逐个把 index.html 里的相对 href/src 解析成 URL, 再回到 web/app 里找文件
  const pages = [
    { file: path.join(APP, 'index.html'), base: '/' },
    { file: path.join(WEB, 'api', 'index.html'), base: '/api' },
  ];
  for (const p of pages) {
    const src = fs.readFileSync(p.file, 'utf8');
    const refs = [
      ...[...src.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]),
      ...[...src.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]),
    ].filter((u) => u && !u.startsWith('#') && !/^[a-z]+:/i.test(u));
    assert.ok(refs.length >= 1, path.basename(p.file) + ' 没有相对资源可查');
    if (p.base === '/') {
      assert.ok(refs.length >= 5, '工作台本体的相对资源太少: ' + refs.length);
    }
    for (const ref of refs) {
      const url = new URL(ref, 'http://h' + p.base);
      const rel = url.pathname.replace(/^\/+/, '');
      const target = path.join(APP, rel);
      assert.ok(fs.existsSync(target),
        path.basename(p.file) + ' 的相对资源 ' + ref + ' 解析到 ' + rel + ' —— 文件不存在');
    }
  }
});

// ── 4. 路由必须单段 ───────────────────────────────────────────
test('141-4: 路由必须单段 (多段会让相对资源解析到子目录)', () => {
  const mod = require(ROUTE);
  for (const v of mod.SPA_VIEWS) {
    assert.ok(!v.includes('/'), '视图路径不许多段: ' + v);
  }
  // 前端: 令符的 go: / 侧栏 href 一律单段 (子页走 ?tab=)
  const appSrc = stripComments(fs.readFileSync(path.join(APP, 'app.mjs'), 'utf8'));
  const gos = [...appSrc.matchAll(/go:\s*'([^']*)'/g)].map((m) => m[1]);
  assert.ok(gos.length >= 10, '令符项太少: ' + gos.length);
  for (const g of gos) {
    assert.ok(!g.startsWith('/'), '令符地址必须相对: ' + g);
    if (g === './') continue;                     // 根路径: 单段
    const head = g.split(/[?#]/)[0];
    assert.ok(!head.includes('/'), '令符地址必须单段: ' + g);
  }
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  const hrefs = [...html.matchAll(/<a[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  for (const h of hrefs) {
    if (h === './') continue;                      // 根路径: 单段
    const head = h.split(/[?#]/)[0];
    assert.ok(!head.includes('/'), '侧栏链接必须单段: ' + h);
  }
});

// ── 5. 服务端: 资源挂在基址根, 真 API 路由不被吃掉 ────────────
test('141-5: 静态资源挂在基址根, 且真 API 路由不许被吃掉', () => {
  for (const u of ['/themes.css', '/styles.css', '/app.mjs', '/lib/util.mjs', '/views/bazi.css']) {
    const { handled, res } = _serve(u);
    assert.strictEqual(handled, true, u + ' 必须被静态出口处理 (资源要挂在基址根)');
    assert.strictEqual(res._status, 200, u + ' 必须 200, 实际 ' + res._status);
  }
  for (const u of ['/api/version', '/api/config', '/config', '/health', '/nope', '/settingsx']) {
    const { handled } = _serve(u);
    assert.strictEqual(handled, false, u + ' 不该被静态出口吃掉 (真路由归 router)');
  }
});

test('141-6: 尾斜杠一律 301 到无斜杠 (相对解析的硬要求)', () => {
  const cases = { '/bazi/': '/bazi', '/settings/': '/settings', '/api/': '/api' };
  for (const [from, to] of Object.entries(cases)) {
    const { handled, res } = _serve(from);
    assert.strictEqual(handled, true, from + ' 必须被处理');
    assert.strictEqual(res._status, 301, from + ' 必须 301');
    assert.strictEqual(res._headers.Location, to, from + ' 必须指向 ' + to);
  }
});

test('141-7: 老的多段地址 301 到单段 (老书签照样进)', () => {
  const cases = {
    '/settings/agent': '/settings?tab=agent',
    '/settings/permission': '/settings?tab=permission',
    '/settings/model': '/settings?tab=model',
    '/settings/agent/qian': '/settings?tab=agent&code=qian',
  };
  for (const [from, to] of Object.entries(cases)) {
    const { handled, res } = _serve(from);
    assert.strictEqual(handled, true, from + ' 必须被处理');
    assert.strictEqual(res._status, 301, from + ' 必须 301');
    assert.strictEqual(res._headers.Location, to, from + ' 必须指向 ' + to);
  }
  // 不认识的设置子项 ⇒ 回默认页, 不许 404
  const unk = _serve('/settings/nope');
  assert.strictEqual(unk.res._status, 301);
  assert.strictEqual(unk.res._headers.Location, '/settings?tab=connect');
});

// ── 6. 反代前缀 (前端不必知道前缀) ─────────────────────────────
test('141-8: X-Forwarded-Prefix 生效 (盘古挂到 /pangu/ 下也能跑)', () => {
  const basePrefix = require(path.join(CORE, 'pangu-single', 'routes', 'base_prefix.js'));
  const mk = (url) => {
    const req = { method: 'GET', url, headers: { 'x-forwarded-prefix': '/pangu' } };
    basePrefix.strip(req);
    return req;
  };
  const mod = require(ROUTE);
  const res = {
    _status: 0, _headers: {}, _body: '',
    writeHead(s, h) { this._status = s; this._headers = h || {}; },
    setHeader(k, v) { this._headers[k] = v; },
    end(b) { if (b) this._body = String(b); },
  };
  const req = mk('/pangu/bazi');
  assert.strictEqual(req.url, '/bazi', '前缀没被摘掉: ' + req.url);
  const handled = mod.handler(req, res);
  assert.strictEqual(handled, true, '/pangu/bazi 必须被处理');
  assert.strictEqual(res._status, 200);
  assert.ok(res._body.includes('pangu-app'), '前缀下要回工作台本体');

  // 重定向要把前缀加回去 (否则浏览器跳出 /pangu/)
  const r2 = {
    _status: 0, _headers: {},
    writeHead(s, h) { this._status = s; this._headers = h || {}; },
    end() {},
  };
  mod.handler(mk('/pangu/settings/agent'), r2);
  assert.strictEqual(r2._status, 301);
  assert.strictEqual(r2._headers.Location, '/pangu/settings?tab=agent');

  // 畸形前缀不许把路由带沟里
  assert.strictEqual(basePrefix.normalize('/../etc'), '', '路径穿越式前缀必须被拒');
  assert.strictEqual(basePrefix.normalize('pangu'), '', '不带斜杠的前缀必须被拒');
});

// ── 7. 相对解析的**行为**自检 (模拟浏览器) ─────────────────────
test('141-9: 逐个视图路径模拟浏览器解析相对地址, 断言落在基址根', () => {
  const mod = require(ROUTE);
  const views = ['', ...mod.SPA_VIEWS];
  for (const v of views) {
    for (const prefix of ['', '/pangu']) {
      const docUrl = 'http://h' + prefix + (v ? '/' + v : '/');
      const css = new URL('themes.css', docUrl).pathname;
      const api = new URL('api/version', docUrl).pathname;
      assert.strictEqual(css, prefix + '/themes.css',
        '视图 ' + (v || '(根)') + ' 下的相对样式解析错位: ' + css);
      assert.strictEqual(api, prefix + '/api/version',
        '视图 ' + (v || '(根)') + ' 下的相对端点解析错位: ' + api);
    }
  }
  // 带查询参数的子页也一样 (查询串不参与相对解析)
  const sub = new URL('themes.css', 'http://h/settings?tab=agent').pathname;
  assert.strictEqual(sub, '/themes.css', '设置子页的相对样式解析错位: ' + sub);
});
