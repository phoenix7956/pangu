'use strict';
/**
 * tests/evolution-view-plotly-20261125.test.js
 *
 * 第 176 批守卫 —— 「进化」页 (自进化账本 + 图表)
 *
 * 这一批引进了 plotly.js (MIT)。它打破了几条老规矩, 所以要有守卫盯着:
 *   1. vendor/ 里的文件必须**真的在仓库里** (不许退回 CDN —— 断了网就白屏,
 *      而且用户的浏览行为会发到第三方);
 *   2. 许可声明必须跟着文件走 (MIT 要求保留版权声明);
 *   3. 前端不许出现绝对站内路径 (相对地址那条铁律);
 *   4. 前端不许引外链脚本 (零外部资源);
 *   5. 服务端的逐日序列端点必须真的算出逐日数字 (不是返回空壳);
 *   6. 账本目录必须走唯一真源 (PANGU_EVO_DIR 沙箱开关要能把它导走 ——
 *      否则测试读的是生产数据, 结论全是假的)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const APP = path.join(CORE, 'web', 'app');
const VENDOR = path.join(APP, 'vendor');
const ROUTE = path.join(CORE, 'pangu-single', 'routes', 'pangu-meta.js');
const STATIC = path.join(CORE, 'pangu-single', 'routes', 'web_static.js');

const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join('\n');

async function serve(url, env) {
  const saved = {};
  for (const k of Object.keys(env || {})) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try {
    delete require.cache[require.resolve(ROUTE)];
    const mod = require(ROUTE);
    const res = {
      _status: 0, _headers: {}, _body: '',
      // pangu-meta 的 json() 走 res.statusCode (不经过 writeHead) —— mock 得跟上
      get statusCode() { return this._status; },
      set statusCode(v) { this._status = v; },
      writeHead(s, h) { this._status = s; this._headers = h || {}; },
      setHeader(k, v) { this._headers[k] = v; },
      end(b) { if (b) this._body = Buffer.isBuffer(b) ? b.toString('utf8') : String(b); },
    };
    const req = { method: 'GET', url, headers: {} };
    const out = await mod.handler(req, res, new URL(url, 'http://x').pathname);
    return { handled: out && out.consumed !== false, res };
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve(ROUTE)];
  }
}

// ── 1. vendor: 文件在仓里, 且不是空壳 ─────────────────────────
test('176-1: vendor/plotly-basic.min.js 必须在仓库里 (不许退回 CDN)', () => {
  const bundle = path.join(VENDOR, 'plotly-basic.min.js');
  assert.ok(fs.existsSync(bundle), 'vendor/plotly-basic.min.js 不存在 —— 图表页会白屏');
  const size = fs.statSync(bundle).size;
  assert.ok(size > 500 * 1024, 'basic 分包才 ' + size + ' 字节, 不像 plotly');
  const head = fs.readFileSync(bundle, 'utf8').slice(0, 400);
  assert.match(head, /plotly\.js/i, '文件头必须标明它是什么');
  assert.match(head, /MIT license/i, '文件头必须保留 MIT 声明 (MIT 要求)');
});

test('176-2: 许可声明必须跟着文件走', () => {
  for (const f of ['plotly-basic.min.js.LICENSE.txt', 'plotly-LICENSE.txt']) {
    const p = path.join(VENDOR, f);
    assert.ok(fs.existsSync(p), f + ' 不存在 —— 分发时必须带上许可声明');
    const txt = fs.readFileSync(p, 'utf8');
    assert.match(txt, /MIT License/i, f + ' 里必须有 MIT 全文');
  }
  const main = fs.readFileSync(path.join(VENDOR, 'plotly-LICENSE.txt'), 'utf8');
  assert.match(main, /Plotly/, 'plotly-LICENSE.txt 里必须有著作权声明');
  const notice = fs.readFileSync(path.join(CORE, '..', '..', 'NOTICE'), 'utf8');
  assert.match(notice, /plotly/i, 'NOTICE 里必须声明 plotly');
  assert.match(notice, /MIT License/, 'NOTICE 里必须抄 plotly 的 MIT 全文');
});

// ── 2. 前端: 相对地址 + 零外链 ───────────────────────────────
test('176-3: 进化页不许引外链脚本, 只许引本仓 vendor', () => {
  const src = fs.readFileSync(path.join(APP, 'views', 'evolution.mjs'), 'utf8');
  const code = stripComments(src);
  const urls = [...code.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0]);
  assert.deepStrictEqual(urls, [], '进化页里有外链: ' + urls.join(', '));
  assert.match(code, /vendor\/plotly-basic\.min\.js/, '必须引本仓的 vendor 文件');
  assert.doesNotMatch(code, /['"]\/[A-Za-z]/, '不许出现绝对站内路径 (要相对)');
});

test('176-4: 视图名两边必须一致 (前端 VIEWS / 服务端 SPA_VIEWS / 侧栏)', () => {
  const appSrc = fs.readFileSync(path.join(APP, 'app.mjs'), 'utf8');
  const block = appSrc.slice(appSrc.indexOf('const VIEWS = {'), appSrc.indexOf('const TITLES = {'));
  const views = [...block.matchAll(/^\s*([a-z]+):\s*\(\)\s*=>/gm)].map((m) => m[1]);
  assert.ok(views.includes('evolution'), '前端 VIEWS 里没有 evolution');
  const mod = require(STATIC);
  assert.ok(mod.SPA_VIEWS.has('evolution'), '服务端 SPA_VIEWS 里没有 evolution (会 404)');
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  assert.match(html, /data-view="evolution"/, '侧栏没有进化入口');
  assert.match(html, /views\/evolution\.css/, 'index.html 没引进化页的样式');
  assert.ok(fs.existsSync(path.join(APP, 'views', 'evolution.css')), 'views/evolution.css 不存在');
  assert.ok(fs.existsSync(path.join(APP, 'views', 'evolution.mjs')), 'views/evolution.mjs 不存在');
});

test('176-5: 客户端 api 走相对路径', () => {
  const src = stripComments(fs.readFileSync(path.join(APP, 'lib', 'api.mjs'), 'utf8'));
  const re = /evolutionSeries:\s*\(\)\s*=>\s*call\('GET',\s*'api\/pangu\/evolution\/series'\)/;
  assert.match(src, re, 'api.mjs 里没有 evolutionSeries (或者写成了绝对路径)');
});

// ── 3. 后端: 逐日序列真的算得出来 ───────────────────────────
test('176-6: /api/pangu/evolution/series 必须逐日算账 (沙箱账本)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-evo-'));
  try {
    const day = (d, recs) => fs.writeFileSync(
      path.join(dir, d + '.jsonl'),
      recs.map((r) => JSON.stringify(r)).join('\n') + '\n'
    );
    day('2026-11-20', [
      { ts: '2026-11-20T01:00:00Z', success: true, duration_ms: 1000, rounds: 2, tool_calls_total: 3, model: 'm-a', tool_names: ['x'] },
      { ts: '2026-11-20T02:00:00Z', success: false, duration_ms: 3000, rounds: 4, tool_calls_total: 1, model: 'm-b', error: 'boom' },
    ]);
    day('2026-11-21', [
      { ts: '2026-11-21T01:00:00Z', success: true, duration_ms: 500, rounds: 1, tool_calls_total: 5, model: 'm-a' },
    ]);

    const { res } = await serve('/api/pangu/evolution/series', { PANGU_EVO_DIR: dir });
    assert.strictEqual(res._status, 200, '端点必须 200');
    const body = JSON.parse(res._body);
    assert.ok(body.ok, '必须返回 ok');
    assert.strictEqual(body.data.days.length, 2, '两天就该有两行');
    const d0 = body.data.days[0];
    assert.strictEqual(d0.date, '2026-11-20');
    assert.strictEqual(d0.total, 2);
    assert.strictEqual(d0.success, 1);
    assert.strictEqual(d0.failed, 1);
    assert.strictEqual(d0.success_rate, 50);
    assert.strictEqual(d0.avg_duration_ms, 2000);
    assert.strictEqual(d0.tool_calls, 4);
    assert.strictEqual(d0.errors, 1);
    assert.strictEqual(d0.avg_rounds, 3);
    assert.strictEqual(body.data.grand_total, 3);
    const m = body.data.models;
    assert.strictEqual(m[0].model, 'm-a');
    assert.strictEqual(m[0].count, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('176-7: 账本目录走唯一真源 (PANGU_EVO_DIR 能把账本导走)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-evo-empty-'));
  try {
    const { res } = await serve('/api/pangu/evolution/series', { PANGU_EVO_DIR: dir });
    assert.strictEqual(res._status, 200);
    const body = JSON.parse(res._body);
    assert.deepStrictEqual(body.data.days, [], '空账本该返回空序列, 不是读生产数据');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('176-8: 静态出口要能伺服 vendor 文件 (而且不许越界)', () => {
  const mod = require(STATIC);
  const mk = () => ({
    _status: 0, _headers: {}, _body: '',
    writeHead(s, h) { this._status = s; this._headers = h || {}; },
    setHeader(k, v) { this._headers[k] = v; },
    end(b) { if (b) this._body = Buffer.isBuffer(b) ? b.toString('utf8') : String(b); },
  });
  const res = mk();
  const handled = mod.handler({ method: 'GET', url: '/vendor/plotly-basic.min.js', headers: {} }, res);
  assert.strictEqual(handled, true, 'vendor 文件必须能取到');
  assert.strictEqual(res._status, 200);
  assert.match(res._headers['Content-Type'] || '', /javascript/, 'MIME 必须是 js');
  assert.ok(res._body.length > 500 * 1024, '文件内容不完整');

  const bad = mk();
  const ok = mod.handler({ method: 'GET', url: '/vendor/../../package.json', headers: {} }, bad);
  assert.notStrictEqual(ok, true, '不许跳出 web/ 目录');
});

