'use strict';

// 2026-10-27 (第 116 批): 把「原来的 UI」搬进浏览器工作台
//
// ─────────────────────────────────────────────────────────────────────────
// 老板原话 (按时间顺序):
//   1. 「原来的ui都没了？」   → 第 108 批把桌面端整套装删了, 只剩 API。
//   2. 「原来的ui全变了」     → 先试复活 React 那套, 老板下一句否决:
//   3. 「都说了桌面端不要了」 → **不许复活桌面端**。
//
// 所以本批的正解不是把 Electron/React 搬回来, 而是:
//   **把原版的壳 / 配色 / 视图 / 内容搬进浏览器零依赖工作台。**
//   原版真源在 git: 110661d^ (删桌面端那一批的父提交)。
//     · src/styles/themes.css  → themes.css  (light / gold / dark 三套令牌)
//     · src/App.jsx 的 Sidebar → index.html  (侧栏分组 / 路径 / 品牌标)
//     · src/App.jsx 的顶栏     → index.html  (健康灯 / 主题键 / 刷新 / 令符)
//     · src/components/CommandPalette → app.mjs (⌘K 令符)
//
// 本文件锁七件事:
//   1. 三套主题令牌齐全, 且跟原版同源 (原版有的 token 一个不许少)
//   2. 侧栏分组 + 路径跟原版一致
//   3. 顶栏三件套在位 (健康灯 / 主题键 / 令符 / 刷新)
//   4. ⌘K 令符真的能调出 (keydown + 面板节点)
//   5. 九个视图都在, 且每个都导出 render
//   6. 零依赖零构建: 不许 react / vite / node_modules / CDN 外链 / 裸 import
//   7. 危险动作必须先 confirm

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CORE = path.join(__dirname, '..');
const APP = path.join(CORE, 'web', 'app');
const REPO = path.join(CORE, '..', '..');
// 2026-11-26: 开源导出树把 7 轨 (梅花/奇门/八宅/合婚/紫微/小六壬/面相) 视图全剥,
//   这些「视图齐全」的 UI 守卫是**私有树不变量**。开源模式下剔除 7 轨视图名,
//   公版视图 (chat/team/hexagrams/history/marketplace/status/settings) 照验。
const IS_OPEN_SOURCE = fs.existsSync(path.join(CORE, '64i', '.pangu-open-source'));
const TRACK_VIEWS = new Set(['meihua', 'qimen', 'bazhai', 'liuren', 'hehun', 'ziwei', 'mianxiang']);

const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(APP, 'app.mjs'), 'utf8');
const themes = fs.readFileSync(path.join(APP, 'themes.css'), 'utf8');

function appFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  })(APP);
  return out;
}

const ALL = appFiles();

// ── 116-1 三套主题 ────────────────────────────────────────────────
test('116-1: light / gold / dark 三套主题令牌齐全, 且跟原版同源', () => {
  for (const id of ['light', 'gold', 'dark']) {
    assert.ok(
      themes.includes('[data-theme="' + id + '"]'),
      'themes.css 必须有 [data-theme="' + id + '"] 这一块'
    );
  }
  assert.match(html, /<html[^>]*data-theme=/, 'index.html 的 <html> 必须带 data-theme');
  assert.match(appSrc, /setAttribute\('data-theme'/, 'app.mjs 必须真的写 data-theme');

  // 原版真源 (git 里的旧 themes.css) —— 导出开源包时没有 .git, 这段降级为只查内部一致
  let original = null;
  try {
    original = execFileSync(
      'git', ['show', '110661d^:apps/desktop/src/styles/themes.css'],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch (e) {
    original = null;
  }

  if (original) {
    const lightBlock = original.slice(
      original.indexOf(':root,'),
      original.indexOf('[data-theme="dark"]')
    );
    const origTokens = new Set(lightBlock.match(/--[a-z0-9-]+(?=\s*:)/gi) || []);
    //
    // ⚠ 2026-10-31 第 180 批: 这段原来切的是 `slice(light, dark)` ——
    //   而 themes.css 的主题块顺序在第 166 批 (界面重写) 改成了 **dark / light / gold**,
    //   dark 在 light **前面** ⇒ slice(280, 162) 切出的是**空串**
    //   ⇒ newTokens = 空集 ⇒ 原版每一个 token 都报「新版少了」——
    //   一条假红盖住了整张色板。(这条守卫从第 166 批起一直红着, 只是被
    //   test:chain 的 && 短路挡在第 301 段之后, 没人看见。)
    // ⇒ 改成「从 light 块切到**下一个** [data-theme= 块」, 再把 :root 的共享令牌并进来
    //   (第 166 批把五行色 --wood 等搬到 :root 一处, 主题继承)。
    const lightFrom = themes.indexOf('[data-theme="light"]');
    const nextTheme = themes.indexOf('[data-theme="', lightFrom + 10);
    const lightNew = themes.slice(lightFrom, nextTheme > 0 ? nextTheme : undefined);
    const rootFrom = themes.indexOf(':root {');
    const rootTo = themes.indexOf('[data-theme="');
    const rootNew = rootFrom >= 0 ? themes.slice(rootFrom, rootTo > 0 ? rootTo : undefined) : '';
    const newTokens = new Set(((rootNew + lightNew).match(/--[a-z0-9-]+(?=\s*:)/gi) || []));
    const missing = [...origTokens].filter((t) => !newTokens.has(t));
    assert.deepStrictEqual(missing, [], '原版有的主题 token, 新版少了: ' + missing.join(', '));
    assert.ok(origTokens.size >= 30, '原版 light 块 token 少于 30 个? 原版取错了');
  } else {
    for (const id of ['light', 'gold', 'dark']) {
      const from = themes.indexOf('[data-theme="' + id + '"]');
      const to = themes.indexOf('[data-theme="', from + 10);
      const block = themes.slice(from, to > 0 ? to : undefined);
      const n = (block.match(/--[a-z0-9-]+(?=\s*:)/gi) || []).length;
      assert.ok(n >= 20, id + ' 主题块只有 ' + n + ' 个 token, 太少');
    }
  }
});

// ── 116-2 侧栏分组 + 路径 ─────────────────────────────────────────
test('116-2: 侧栏分组和路径跟原版一致', () => {
  // ⚠ 2026-10-31 第 180 批: 侧栏分组在**第 159 批**就有意改过了
  //   (index.html 自己的注释写着: 以前四组平铺, 密度跟内容区不匹配, 像后台导航
  //    ⇒ 收成 工作 / 推演 两组 + 底部「系统」区)。
  //   这条守卫还停在第 116 批的旧分组名 ⇒ 从第 159 批起一直红着
  //   (同样被 && 短路掩盖着)。⇒ 改成盯**现行**分组与入口。
  for (const g of ['工作', '系统']) {
    assert.ok(html.includes('>' + g + '<'), '侧栏必须有分组「' + g + '」');
  }
  assert.ok(html.includes('本地节点'), '侧栏底部必须有「本地节点」');

  // 第 140 批: 路由是真路径 (/bazi), 不再有 # 碎片, 也不再有 /app 前缀
  // 第 141 批: 链接一律**相对** (工作台本身住在基址根, 相对地址才跟得住前缀)
  const _ITEMS = [
    ['工作台', './'],
    ['自动化', 'team'],
    ['梅花起卦', 'meihua'],    // 开源树无 meihua 视图, 下面 ITEMS 过滤剔除
    // (八字排盘已拆离)
    ['六十四卦', 'hexagrams'],
    ['历史档案', 'history'],
    ['工具集', 'marketplace'],
    ['系统设置', 'settings'],
  ];
  const ITEMS = _ITEMS.filter(([, h]) => !(IS_OPEN_SOURCE && TRACK_VIEWS.has(h)));
  for (const [label, href] of ITEMS) {
    assert.ok(html.includes('href="' + href + '"'),
      '侧栏项「' + label + '」的 href 必须是 ' + href);
    assert.ok(html.includes('>' + label + '<'), '侧栏必须有「' + label + '」');
  }

  // 品牌标: 六爻分割 (原版是 6 个 <i>, 第 3 个带 is-split)
  const mark = html.slice(html.indexOf('pangu-brand-mark'), html.indexOf('pangu-brand-copy'));
  assert.strictEqual((mark.match(/<i[ >]/g) || []).length, 6, '品牌标必须是六爻');
  assert.ok(mark.includes('is-split'), '品牌标第三爻必须带 is-split (原版口径)');
});

// ── 116-3 顶栏三件套 ─────────────────────────────────────────────
test('116-3: 顶栏有健康灯 / 主题键 / 刷新键 / 令符', () => {
  assert.ok(html.includes('pangu-health'), '顶栏必须有健康灯');
  assert.ok(html.includes('id="health-text"'), '健康灯必须有文字 (原版有状态文案)');
  assert.ok(html.includes('id="theme-btn"'), '顶栏必须有主题键');
  assert.ok(html.includes('id="refresh-btn"'), '顶栏必须有刷新键');
  assert.ok(html.includes('pangu-command-trigger'), '顶栏必须有令符触发器');
  assert.ok(html.includes('⌘ K'), '令符触发器必须显示 ⌘ K 提示');
  assert.ok(html.includes('id="palette"'), '必须有令符面板节点');
  assert.ok(html.includes('id="palette-input"'), '令符面板必须有输入框');
  assert.ok(html.includes('id="palette-list"'), '令符面板必须有列表');
});

// ── 116-4 ⌘K ─────────────────────────────────────────────────────
test('116-4: ⌘K / Ctrl+K 能调出令符, 方向键 + Enter + Esc 都在', () => {
  assert.match(appSrc, /addEventListener\('keydown'/, 'app.mjs 必须监听 keydown');
  assert.match(appSrc, /metaKey \|\| e\.ctrlKey/, '必须同时支持 ⌘K 和 Ctrl+K');
  assert.ok(appSrc.includes("'k'"), '必须匹配 k 键');
  assert.ok(appSrc.includes('ArrowDown') && appSrc.includes('ArrowUp'), '令符必须有上下选择');
  assert.ok(appSrc.includes("'Enter'"), '令符必须能回车执行');
  assert.ok(appSrc.includes("'Escape'"), '令符必须能 Esc 关闭');

  const cmds = appSrc.slice(
    appSrc.indexOf('const COMMANDS'),
    appSrc.indexOf('];', appSrc.indexOf('const COMMANDS'))
  );
  const NAMES = ['工作台', '自动化', '六十四卦',
    '历史档案', '工具集', '将灵', '状态', '系统设置'];
  // 开源树剥了 meihua 视图 ⇒ 令符清单里没有「梅花起卦」, 该项只验私有树
  const _NAMES = NAMES.filter((n) => !(IS_OPEN_SOURCE && TRACK_VIEWS.has(n === '梅花起卦' ? 'meihua' : n)));
  for (const name of _NAMES) {
    assert.ok(cmds.includes("'" + name + "'"), '令符清单缺「' + name + '」');
  }
  assert.ok(cmds.includes("act: 'theme'"), '令符必须有切主题');
  assert.ok(cmds.includes("act: 'health'"), '令符必须有刷新连接');
});

// ── 116-5 九个视图 ───────────────────────────────────────────────
test('116-5: 九个视图都在路由表里, 且每个都导出 render', () => {
  const _VIEWS = ['chat', 'team', 'meihua', 'hexagrams', 'history',
    'marketplace', 'subagents', 'status', 'settings'];
  const VIEWS = _VIEWS.filter((v) => !(IS_OPEN_SOURCE && TRACK_VIEWS.has(v)));
  for (const v of VIEWS) {
    assert.ok(
      appSrc.includes(v + ": () => import('./views/" + v + ".mjs')"),
      '路由表必须登记视图 ' + v
    );
    const f = path.join(APP, 'views', v + '.mjs');
    assert.ok(fs.existsSync(f), 'views/' + v + '.mjs 必须存在');
    const src = fs.readFileSync(f, 'utf8');
    assert.match(src, /export\s+(async\s+)?function\s+render/, v + '.mjs 必须导出 render');
  }
  const imports = [...appSrc.matchAll(/import\('\.\/views\/([^']+)'\)/g)].map((m) => m[1]);
  for (const i of imports) {
    assert.ok(fs.existsSync(path.join(APP, 'views', i)), '路由指向了不存在的视图 ' + i);
  }
});

// ── 116-6 零依赖零构建 ───────────────────────────────────────────
test('116-6: 工作台不许带框架 / 构建产物 / 外链 / 裸 import', () => {
  for (const f of ALL) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(APP, f);
    assert.ok(!/from\s+['"]react/i.test(src), rel + ' 不许 import react');
    assert.ok(!/require\(\s*['"]react/i.test(src), rel + ' 不许 require react');
    assert.ok(!/node_modules/.test(src), rel + ' 不许出现 node_modules');
    assert.ok(!/<script[^>]+src=["']https?:/i.test(src), rel + ' 不许外链 script');
    assert.ok(!/<link[^>]+href=["']https?:/i.test(src), rel + ' 不许外链 css');
    for (const m of src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      assert.ok(
        spec.startsWith('./') || spec.startsWith('../'),
        rel + ' 出现裸 import: ' + spec
      );
    }
  }
  assert.ok(!fs.existsSync(path.join(APP, 'dist')), '工作台不许带 dist');
  assert.ok(!fs.existsSync(path.join(APP, 'node_modules')), '工作台不许带 node_modules');
});

// ── 116-7 危险动作先确认 ─────────────────────────────────────────
test('116-7: 危险动作必须先 confirm', () => {
  // 写调用点 —— 走 api 层 (api.xxx) 或裸 send 都算; 视图从第 117 批起改用 api 层
  const CASES = [
    ['views/marketplace.mjs', /api\.marketplaceUninstall\(|send\(\s*['"]\/api\/marketplace\/uninstall/],
    ['views/settings/credentials.mjs', /api\.credentialsRemove\(|send\(\s*['"]\/api\/credentials\/remove/],
    ['views/settings/permission.mjs', /api\.permissionSet\(|send\(\s*['"]\/api\/pangu\/permission\/level/],
    ['views/team.mjs', /send\(\s*['"]api\/teamflow\/tasks\//],
  ];
  for (const [file, re] of CASES) {
    const src = fs.readFileSync(path.join(APP, file), 'utf8');
    const m = re.exec(src);
    assert.ok(m, file + ' 必须调 ' + re);
    const before = src.slice(Math.max(0, m.index - 1000), m.index);
    assert.ok(/confirm\(/.test(before) || /confirmBox/.test(before),
      file + ' 的 ' + re + ' 写操作前面必须有确认');
  }
});

test('116-8: 移动端抽屉不许被遮罩挡住, 且要点侧栏项自动收起', () => {
  const styles = fs.readFileSync(path.join(APP, 'styles.css'), 'utf8');
  const at = styles.indexOf('@media (max-width: 640px)');
  assert.ok(at > 0, 'styles.css 必须有 ≤640px 的媒体查询');
  const m640 = styles.slice(at);

  const scrimAt = m640.indexOf('.pangu-nav-scrim');
  assert.ok(scrimAt > 0, '≤640px 必须管 .pangu-nav-scrim');
  const scrimRule = m640.slice(scrimAt, m640.indexOf('}', scrimAt));
  assert.match(scrimRule, /display:\s*none/,
    '遮罩默认必须 display:none —— 无条件 block 会盖住整页, 连汉堡都点不到');
  assert.match(m640, /(?:#sidebar|\.pangu-sidebar)\.is-open\s*~\s*\.pangu-nav-scrim[^{]*\{[^}]*display:\s*block/,
    '遮罩只能靠「抽屉打开」这个状态显示');

  // 920px 那套「只留图标」在抽屉里必须还原 (原版口径)
  assert.match(m640, /\.pangu-nav-label[^{]*\{[^}]*display:\s*flex/,
    '抽屉里必须把文字标签放回来');

  // 点侧栏任一项 ⇒ 收起抽屉
  assert.match(appSrc, /querySelectorAll\('\.pangu-nav-item'\)[\s\S]{0,300}?classList\.remove\('is-open'\)/,
    '点侧栏项必须收起移动端抽屉');
});

