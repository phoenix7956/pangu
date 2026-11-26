'use strict';

// 2026-10-27 (第 115 批): 工作台「设置」层 —— 旧桌面端那层设置搬回来
//
// ─────────────────────────────────────────────────────────────────────────
// 起因: 老板问「原来的ui都没了?」—— 查实了:
//   · 旧桌面端 (Electron/Tauri + React/Vite, 75 文件 / 18,596 行) 在 2026-10-26
//     第 106 批 (commit 110661d) 被**整个删掉**, git 里能完整取回;
//   · 但它依赖的**每一个后端接口都还活着** (模型/凭证/MCP/技能/权限 全在 core 里)。
//   ⇒ 所以不是「UI 没了就没了」, 是「外壳删了, 能力还在」—— 搬回来即可。
//
// 本文件锁六件事:
//   1. 五个档 (模型/凭证/MCP/技能/权限) 都在, 视图能 import 且导出 render
//   2. 页面**不许渲染密钥真值** —— 列表接口只给 hasValue, 真值永远读不出来
//   3. 危险动作 (删凭证 / 卸载技能 / 切权限) 必须先 confirm
//   4. 页面用到的每个端点都必须**是真路由** (不许拿假端点糊弄人)
//   5. 不许把桌面端那套构建产物/框架带回来 (跟第 114 批同一条线)
//   6. 侧栏要有「设置」入口, 且路由表里登记了它

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const CORE = path.join(__dirname, '..');
const APP = path.join(CORE, 'web', 'app');
const VIEW = path.join(APP, 'views', 'settings.mjs');

const src = fs.readFileSync(VIEW, 'utf8');
const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(APP, 'app.mjs'), 'utf8');

// 第 117 批起, 设置层从「单文件 5 个 tab」改成「壳 + views/settings/ 下 12 个子页」。
// 守卫跟到新结构, 但**守住的不变量不变**: 不漏档 / 不泄密钥 / 危险动作先确认 /
// 端点是真的 / 不复活桌面端。
const SUBPAGES = [
  'connect.mjs', 'model.mjs', 'agent.mjs', 'tools.mjs', 'mcp.mjs', 'permission.mjs',
  'ui.mjs', 'storage.mjs', 'credentials.mjs', 'self-repair.mjs', 'voice.mjs', 'update.mjs',
];
const SET_DIR = path.join(APP, 'views', 'settings');

function subSrc(name) {
  return fs.readFileSync(path.join(SET_DIR, name), 'utf8');
}
function allSubSrc() {
  return SUBPAGES.map(subSrc).join('\n');
}

// 去掉注释再看 —— 注释里可以谈论 react / api_key, 代码里不许碰
function stripComments(t) {
  return t
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
}
const code = stripComments(allSubSrc());

test('115-1: 设置壳 + 十二个子页都在, 视图能 import 且导出 render', async () => {
  const mod = await import(pathToFileURL(VIEW).href);
  assert.strictEqual(typeof mod.render, 'function', 'settings 壳没导出 render');
  assert.ok(src.includes('PAN_LORE.settings'), '设置壳必须从 PAN_LORE.settings 取子导航项');

  for (const f of SUBPAGES) {
    assert.ok(fs.existsSync(path.join(SET_DIR, f)), '设置子页缺 ' + f);
    const m = await import(pathToFileURL(path.join(SET_DIR, f)).href);
    assert.strictEqual(typeof m.render, 'function', f + ' 没导出 render');
  }

  // 原版五个档 (模型/凭证/MCP/技能/权限) 必须还在这套子页里
  for (const label of ['模型', '凭证', 'MCP', '技能', '权限']) {
    assert.ok(allSubSrc().includes(label) || src.includes(label), '缺档位: ' + label);
  }
});

test('115-2: 页面不许渲染密钥真值', () => {
  assert.ok(!/hasValue\s*\|\|\s*['"]/.test(code), '别拿 hasValue 当值显示');

  // 凭证列表页: 只显示「有没有值」, 绝不显示 value 真值
  const credCode = stripComments(subSrc('credentials.mjs'));
  assert.ok(!/\bc\.value\b/.test(credCode), '凭证页不许渲染 value 真值');
  assert.ok(!/\bvalue\s*\|\|\s*['"]/.test(credCode), '凭证页不许拿 value 当值显示');
  assert.ok(subSrc('credentials.mjs').includes("'有值'") && subSrc('credentials.mjs').includes("'没值'"),
    '凭证表要显示「有值/没值」');

  // 用户自己填 key 的输入框必须掩码 (model 页的 openai_api_key)
  const modelSrc = subSrc('model.mjs');
  const pwAt = modelSrc.indexOf("type: 'password'");
  assert.ok(pwAt >= 0, 'model 页没有掩码输入框');
  assert.ok(modelSrc.slice(pwAt, pwAt + 600).includes('openai_api_key'),
    'model 页的 openai_api_key 输入框必须是 password (掩码)');
});

test('115-3: 危险动作必须先确认', () => {
  // 写调用点 —— 走 api 层 (api.credentialsRemove) 或裸 send 都算
  const CASES = [
    ['views/settings/credentials.mjs', /api\.credentialsRemove\(/],
    ['views/settings/permission.mjs', /api\.permissionSet\(/],
    ['views/marketplace.mjs', /api\.deletePanguSkill\(/],
  ];
  for (const [file, re] of CASES) {
    const s2 = fs.readFileSync(path.join(APP, file), 'utf8');
    const m = re.exec(s2);
    assert.ok(m, file + ' 必须调 ' + re);
    const before = s2.slice(Math.max(0, m.index - 1200), m.index);
    assert.ok(/confirm\(/.test(before) || /confirmBox/.test(before),
      file + ' 的 ' + re + ' 是危险动作, 写它之前必须有确认');
  }
});

test('115-4: 用到的端点必须都是真路由', () => {
  // 子页走 api 层 (api.xxx), 所以端点要从 lib/api.mjs 里把方法解析出来
  const apiSrc = fs.readFileSync(path.join(APP, 'lib', 'api.mjs'), 'utf8');
  const used = new Set();
  for (const m of allSubSrc().matchAll(/\bapi\.([A-Za-z0-9_]+)\s*\(/g)) {
    const name = m[1];
    const at = apiSrc.indexOf(name + ':');
    assert.ok(at >= 0, 'api 层没有这个方法: ' + name);
    const body = apiSrc.slice(at, at + 400);
    // 第 141 批: 端点写成**相对**路径 (api/xxx) —— 这里补回前导斜杠再跟真路由比
    const ep = body.match(/['"](api\/[a-z0-9\/_-]+)['"]/);
    if (ep) used.add('/' + ep[1]);
  }
  assert.ok(used.size >= 10, '端点太少: ' + used.size);

  const routerSrc = [
    fs.readFileSync(path.join(CORE, 'pangu-single', 'routes', 'inline_router.js'), 'utf8'),
    fs.readFileSync(path.join(CORE, 'pangu-single', 'routes', 'web_static.js'), 'utf8'),
    fs.readFileSync(path.join(CORE, 'pangu-single', 'routes', 'pangu-meta.js'), 'utf8'),
    fs.readFileSync(path.join(CORE, 'pangu-single.js'), 'utf8'),
    fs.readFileSync(path.join(CORE, 'modules', 'pangu_agent_stream.js'), 'utf8'),
  ].join('\n');
  const known = new Set(
    (routerSrc.match(/['"](\/[a-z0-9\/_-]+)['"]/g) || [])
      .map((s3) => '/' + s3.replace(/['"]/g, '').slice(1)),
  );
  // 后端用 startsWith / includes 动态匹配的路由, 静态 grep 找不到 (同第 117 批那条)
  const DYNAMIC_OK = [
    '/api/llm/', '/api/mcp/', '/api/credentials/', '/api/voice/',
    '/api/pangu/', '/api/marketplace/', '/api/teamflow/', '/api/tools/',
  ];
  const unknown = [...used].filter((p2) => !known.has(p2)
    && !DYNAMIC_OK.some((ok) => p2 === ok || p2.startsWith(ok)));
  assert.deepStrictEqual(unknown, [], '设置页引用了不存在的端点: ' + unknown.join(', '));
});

test('115-5: 不许把桌面端那套构建产物/框架带回来', () => {
  // 注释里可以谈论「原版是 React」—— 只查代码
  const all = stripComments(src + '\n' + allSubSrc());
  assert.ok(!/\breact\b/i.test(all), 'settings 里出现 react');
  assert.ok(!/\bvite\b/i.test(all), 'settings 里出现 vite');
  // 「自给自足」管的是**真去加载外部资源**, 不是文本里出现 URL
  // (placeholder 里的示例地址、协议名 'http' 都不是加载)
  const LOADS = [
    /<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)\s*=\s*["']https?:/i,
    /@import\s+(?:url\()?\s*["']?https?:/i,
    /url\(\s*["']?https?:/i,
    /\bimport\s[^;\n]*\bfrom\s*["']https?:/i,
    /\bfetch\(\s*["']https?:/i,
    /new\s+URL\(\s*["']https?:/i,
  ];
  for (const re of LOADS) {
    assert.ok(!re.test(all), 'settings 引了外部资源: ' + re);
  }
  assert.ok(!/from ['"]node_modules/.test(all), 'settings 引了 node_modules');
});

test('115-6: 侧栏有「设置」入口, 路由表里登记了它', () => {
  assert.ok(/data-view="settings"/.test(html), '侧栏缺「设置」入口');
  assert.ok(/settings:\s*\(\)\s*=>\s*import\('\.\/views\/settings\.mjs'\)/.test(appSrc),
    '路由表里没登记 settings 视图');
  assert.ok(/settings:\s*\[/.test(appSrc), '路由表里没给 settings 起标题');
});
