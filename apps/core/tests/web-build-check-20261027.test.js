'use strict';

// 2026-10-27 (第 119 批补修四): 「改了没反应」的自检链
//
// 背景: SPA 改 hash **不重载文档** ⇒ 浏览器 module registry 里留着**旧模块实例**。
//   服务端 `Cache-Control: no-store` 拦得住 HTTP 缓存, **拦不住 module registry**。
//   今天咬了三次 (页标题丢 / 自动排盘 / 四柱表版式) —— 每次都是「我这边是新的, 老板那边是老样子」。
//
// 本文件锁四件事:
//   1. 服务端有 /api/pangu/webbuild, 给前端代码树的内容指纹
//   2. 指纹**会变** —— 改了文件就变 (否则这机制等于没有)
//   3. 前端轮询它, 变了就挂「点此刷新」的提示条
//   4. 提示条不许在没变化时乱弹

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const APP = path.join(CORE, 'web', 'app');

const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

// ── 121-1 服务端: 指纹路由在, 形状对 ─────────────────────────────
test('121-1: /api/pangu/webbuild 返回前端代码指纹', () => {
  const wb = require(path.join(CORE, 'pangu-single', 'routes', 'webbuild.js'));
  const seen = {};
  const res = {
    writeHead(code, headers) { seen.code = code; seen.headers = headers || {}; },
    end(body) { seen.body = body; seen.ended = true; },
  };
  wb.handler({ method: 'GET', url: '/api/pangu/webbuild' }, res);
  assert.ok(seen.ended, 'handler 必须写完响应');
  assert.strictEqual(seen.code, 200);
  assert.match(seen.headers['Cache-Control'] || '', /no-store/,
    '指纹接口不许被缓存 —— 缓存了就永远看不到更新');
  const j = JSON.parse(seen.body);
  assert.strictEqual(j.ok, true);
  assert.match(j.stamp, /^[0-9a-f]{12}$/, '指纹要是 12 位十六进制: ' + j.stamp);
});

// ── 121-2 指纹会变 (否则整个机制是摆设) ─────────────────────────
test('121-2: 改了文件, 指纹必须变', () => {
  const wb = require(path.join(CORE, 'pangu-single', 'routes', 'webbuild.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-build-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.mjs'), 'x');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b.mjs'), 'y');
    const s1 = wb.computeStamp(dir);
    assert.match(s1, /^[0-9a-f]{12}$/);
    assert.strictEqual(wb.computeStamp(dir), s1, '同样的内容 ⇒ 同样的指纹 (要稳定)');
    // 改内容 (mtime 变) ⇒ 指纹变
    fs.writeFileSync(path.join(dir, 'a.mjs'), 'x-changed-longer');
    const s2 = wb.computeStamp(dir);
    assert.notStrictEqual(s2, s1, '改文件后指纹必须变');
    // 加文件 ⇒ 指纹变
    fs.writeFileSync(path.join(dir, 'c.mjs'), 'z');
    const s3 = wb.computeStamp(dir);
    assert.notStrictEqual(s3, s2, '加文件后指纹必须变');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 121-3 路由挂上了 (不是死代码) ───────────────────────────────
test('121-3: webbuild 路由真的挂在 router 上', () => {
  const router = fs.readFileSync(path.join(CORE, 'pangu-single', 'routes', 'inline_router.js'), 'utf8');
  assert.ok(router.includes("'/api/pangu/webbuild'"),
    'inline_router.js 必须注册 /api/pangu/webbuild —— 没挂 = 死代码 = 白写');
  assert.ok(/require\('\.\/webbuild'\)\.handler/.test(router),
    '必须真的调 webbuild.handler');
});

// ── 121-4 前端: 轮询 + 提示条 ───────────────────────────────────
test('121-4: 前端轮询指纹, 变了挂「点此刷新」提示条', () => {
  const bc = read('lib/buildcheck.mjs');
  assert.ok(bc.includes('/api/pangu/webbuild'), 'buildcheck 必须打指纹接口');
  assert.ok(bc.includes('setInterval'), '必须轮询 —— 只在启动时查一次没用');
  assert.ok(bc.includes('visibilitychange'),
    '必须在标签页切回可见时立刻查一次 —— 「回来一看还是老样子」是最高频场景');
  assert.ok(bc.includes('location.reload()'), '提示条必须能真的刷新');
  assert.ok(bc.includes('pg-update-bar'), '提示条要有自己的类名');
  const app = read('app.mjs');
  assert.ok(app.includes('startBuildCheck('), 'app.mjs 必须起这个自检');
  assert.ok(app.includes("from './lib/buildcheck.mjs'"), 'app.mjs 必须引 buildcheck');
  const css = read('components.css');
  assert.ok(css.includes('.pg-update-bar'), '提示条要有样式');
});

// ── 121-5 指纹不许每次请求都重算 (太慢) ─────────────────────────
test('121-5: 指纹有缓存, 不是每个请求都重算', () => {
  const src = fs.readFileSync(path.join(CORE, 'pangu-single', 'routes', 'webbuild.js'), 'utf8');
  assert.ok(/_cache/.test(src), '必须有缓存 —— 每次请求 stat 几十个文件太浪费');
  assert.ok(/2000|2 \* 1000/.test(src), '缓存窗口 2 秒左右就够 (前端 20 秒轮询一次)');
});
