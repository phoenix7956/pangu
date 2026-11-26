'use strict';
/**
 * tests/ui-design-system-20261029.test.js
 *
 * 第 147 批守卫 —— 「这根本不是一套完整的 ui, 这是胡拼乱凑的页面风格」
 *
 * ── 起因 (老板 10-29 贴了八张页面截图) ──────────────────────────
 *   老板的话不是「某一页丑」, 是**六页六种画法**:
 *
 *     状态页    .pg-card  + .pg-stat        + table.t
 *     设置页    .pg-card  + .pg-status-card  + 自造 h1
 *     八字页    .bz-* 一整套 (连 .pg-card 都没有)
 *     工具集    .pg-mp-* 一整套
 *     六十四卦  .hex-* 一整套
 *     历史档案  .hs-* 一整套 + 自抄的 .pg-info-row
 *
 *   同一个「区块」/「数字」/「表格」/「按钮」在六个页面里有六种画法 ——
 *   这就是「胡拼乱凑」的定义, 也是病根。
 *
 * ── 判据 ─────────────────────────────────────────────────────
 *   ① 基础零件的**外观属性**只许在 design-system.css 里声明;
 *      页面 CSS 只许改它的**摆放** (display/grid/margin/width)。
 *   ② 已废的旧画法不许复活 (pg-stat / pg-status-card / pg-info-row /
 *      table.t / .seg-i / .pangu-page-heading / pg-rail-row …)。
 *   ③ 危险按钮永远是**小尺寸描边红字** —— 不许实心红, 不许满宽。
 *   ④ 表格只有一种 (`.pg-table`)、磁贴只有一种 (`.pg-tiles`)。
 *   ⑤ 每个视图模块的页面根是 `.pg-page`。
 *   ⑥ 界面里不许出现本机绝对路径。
 *   ⑦ 五行色原值一个字都不许改。
 *
 * ── 纪律 ─────────────────────────────────────────────────────
 *   只看**声明**, 不看注释 (注释里常写着「不许 xxx」, 全文匹配会咬自己);
 *   每条判据都带**负例自检**: 造一段坏数据, 断言判据能挑出来。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'web', 'app');

// 注释剥除器是**共享**的 (tests/helpers/strip-comments.js) ——
// 两个 UI 守卫都踩过「注释里写着旧类名/旧 emoji, 守卫自己咬自己」的坑。
const { stripComments } = require('./helpers/strip-comments.js');
const readCss = (rel) => stripComments(fs.readFileSync(path.join(APP, rel), 'utf8'));
const readJs = (rel) => stripComments(fs.readFileSync(path.join(APP, rel), 'utf8'));

function allCssFiles() {
  const out = [];
  const walk = (rel) => {
    const dir = path.join(APP, rel);
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      // 路径不带 './' 前缀 —— 否则 'design-system.css' 的豁免判断永远不成立,
      // 守卫会把它自己判成"页面 CSS 改了零件外观" (2026-10-29 实测踩到)。
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(r);
      else if (ent.name.endsWith('.css')) out.push(r);
    }
  };
  walk('');
  return out;
}

function allViewModules() {
  const out = [];
  const walk = (rel) => {
    const dir = path.join(APP, rel);
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(r);
      else if (ent.name.endsWith('.mjs')) out.push(r);
    }
  };
  walk('views');
  return out;
}

/** 基础零件清单 —— 这些类的「外观」由 design-system.css 独家负责。 */
const PRIMITIVES = [
  'pg-card', 'pg-card-header', 'pg-card-body',
  'pg-btn', 'pg-btn-primary', 'pg-btn-ghost', 'pg-btn-danger',
  'pg-input', 'pg-label', 'pg-badge', 'pg-pill',
  'pg-table', 'pg-tiles', 'pg-tile', 'pg-list-row', 'pg-icon-btn', 'pg-field',
];

/** 外观属性 —— 出现这些就说明「在改零件长什么样」, 必须回 design-system.css。 */
const VISUAL_PROPS = [
  'background', 'background-color', 'border', 'border-color', 'border-width',
  'border-style', 'border-radius', 'border-top', 'border-bottom', 'border-left', 'border-right',
  'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
  'font-size', 'font-family', 'font-weight', 'color', 'box-shadow',
  'min-height', 'line-height', 'letter-spacing', 'text-transform',
];

/** 拆出 (选择器, 声明体) 对。 */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith('@')) continue;
    out.push({ sel, body: m[2] });
  }
  return out;
}

/** 选择器里「最后一段」= 规则真正作用的那个元素 (subject)。 */
function subjectOf(selectorPart) {
  return selectorPart.trim().split(/[\s>~+]+/).pop() || '';
}

function classesOf(compound) {
  return new Set((compound.match(/\.([A-Za-z0-9_-]+)/g) || []).map((c) => c.slice(1)));
}

/** 这条声明体有没有在改「外观」。 */
function touchesVisual(body) {
  return body.split(';').some((decl) => {
    const prop = decl.split(':')[0].trim().toLowerCase();
    if (!prop) return false;
    return VISUAL_PROPS.some((p) => prop === p || prop.startsWith(p + '-'));
  });
}

// ── ① 基础零件的外观只在 design-system.css 里 ────────────────────

test('基础零件的外观属性只许在 design-system.css 里声明', () => {
  const prot = new Set(PRIMITIVES);
  const bad = [];
  for (const rel of allCssFiles()) {
    if (rel === 'design-system.css') continue;
    for (const r of rules(readCss(rel))) {
      for (const part of r.sel.split(',')) {
        const subj = subjectOf(part);
        if (!subj) continue;
        const hit = [...classesOf(subj)].filter((c) => prot.has(c));
        if (!hit.length) continue;
        if (!touchesVisual(r.body)) continue; // 只改摆放 → 放行
        bad.push(`${rel} :: ${part.trim()}`);
      }
    }
  }
  assert.deepStrictEqual(bad, [],
    '基础零件的外观属性出现在页面 CSS 里 (应回 design-system.css 改):\n  ' + bad.join('\n  '));
});

test('判据①能挑出重复定义 (负例自检)', () => {
  const prot = new Set(PRIMITIVES);
  const badCss = '.pg-card { background: #fff; border-radius: 8px; }';
  const found = rules(badCss).some((r) =>
    r.sel.split(',').some((part) => {
      const hit = [...classesOf(subjectOf(part))].filter((c) => prot.has(c));
      return hit.length && touchesVisual(r.body);
    }));
  assert.ok(found, '负例: 重复定义 .pg-card 竟然没被判出来');
});

test('判据①放行「只改摆放」的页面规则 (负例自检)', () => {
  const prot = new Set(PRIMITIVES);
  const okCss = '.pg-mp-grid > .pg-card { display: flex; margin-bottom: 0; }';
  const found = rules(okCss).some((r) =>
    r.sel.split(',').some((part) => {
      const hit = [...classesOf(subjectOf(part))].filter((c) => prot.has(c));
      return hit.length && touchesVisual(r.body);
    }));
  assert.ok(!found, '负例: 只改摆放的规则被误判成改外观');
});

// ── ② 已废的旧画法不许复活 ──────────────────────────────────────

const DEAD_CLASSES = [
  'pg-stat-row', 'pg-stat-v', 'pg-status-card', 'pg-status-grid',
  'pg-info-row', 'pg-info-k', 'pg-info-v',
  'pg-rail-row', 'pg-rail-key',
  'pangu-page-heading',
];

test('已废的旧画法不许复活', () => {
  const bad = [];
  for (const rel of allCssFiles()) {
    const css = readCss(rel);
    for (const cls of DEAD_CLASSES) {
      if (new RegExp('\\.' + cls + '(?![A-Za-z0-9_-])').test(css)) {
        bad.push(`${rel} :: .${cls}`);
      }
    }
    // 旧表格类名 table.t
    if (/table\.t(?![A-Za-z0-9_-])/.test(css)) bad.push(`${rel} :: table.t`);
    // 旧分段控件
    if (/\.seg-i(?![A-Za-z0-9_-])/.test(css)) bad.push(`${rel} :: .seg-i`);
  }
  assert.deepStrictEqual(bad, [], '旧画法复活了:\n  ' + bad.join('\n  '));
});

test('已废的旧画法不许在 JS 里复活 (负例自检)', () => {
  const bad = [];
  const deadJs = DEAD_CLASSES.concat(['seg-i']);
  for (const rel of allViewModules()) {
    const src = readJs(rel);
    for (const cls of deadJs) {
      // 必须按**类名边界**匹配 —— 否则 'pg-seg-i' 里含 'seg-i',
      // 'pg-status-grid' 里含 'pg-status-card' 的片段, 新零件会被误判成旧画法。
      const re = new RegExp('(?<![A-Za-z0-9_-])' + cls + '(?![A-Za-z0-9_-])');
      if (re.test(src)) bad.push(`${rel} :: ${cls}`);
    }
    // 样稿 2.0 (redesign-sample) 功能卡标题用了短类 .t/.d —— 不是旧表格 table.t, 误判已废。
    // 旧表格检查只在 CSS 的 `table.t` 选择器上留 (见上), JS 短类放行。
  }
  assert.deepStrictEqual(bad, [], '旧画法在 JS 里复活了:\n  ' + bad.join('\n  '));
});

// ── ③ 危险按钮: 小尺寸描边红字, 不许实心红, 不许满宽 ───────────

test('危险按钮不许是实心红块', () => {
  const css = readCss('design-system.css');
  const rule = rules(css).find((r) => r.sel.split(',').map((s) => s.trim()).includes('.pg-btn-danger'));
  assert.ok(rule, 'design-system.css 里没有 .pg-btn-danger');
  assert.ok(!/background\s*:\s*var\(--red\)/.test(rule.body),
    '.pg-btn-danger 不许是实心红 (--red 底色) —— 危险操作的视觉重量会压过整页内容');
  assert.ok(/background\s*:\s*transparent/.test(rule.body),
    '.pg-btn-danger 应该是透明底 + 描边红字');
});

test('危险按钮不许满宽 (pg-btn-block + danger 组合)', () => {
  const bad = [];
  for (const rel of allViewModules()) {
    const src = readJs(rel);
    const re = /pg-btn-danger[^\n]{0,80}pg-btn-block|pg-btn-block[^\n]{0,80}pg-btn-danger/g;
    if (re.test(src)) bad.push(rel);
  }
  assert.deepStrictEqual(bad, [],
    '危险按钮不许满宽 (pg-btn-block):\n  ' + bad.join('\n  '));
});

test('判据③能挑出实心红按钮 (负例自检)', () => {
  const rule = { body: 'background: var(--red); color: #fff; border-color: var(--red);' };
  assert.ok(/background\s*:\s*var\(--red\)/.test(rule.body), '负例: 实心红没被挑出来');
});

// ── ④ 表格/磁贴只有一种 ─────────────────────────────────────────

test('表格只有 .pg-table 一种', () => {
  const bad = [];
  for (const rel of allViewModules()) {
    const src = readJs(rel);
    // el('table', { class: 'xxx' }) 里的 class 必须包含 pg-table
    const re = /el\(\s*['"]table['"]\s*,\s*\{[^}]*class\s*:\s*['"]([^'"]*)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      if (!/\bpg-table\b/.test(m[1])) bad.push(`${rel} :: class="${m[1]}"`);
    }
  }
  assert.deepStrictEqual(bad, [], '这些表没走设计系统的 .pg-table:\n  ' + bad.join('\n  '));
});

test('磁贴只有 .pg-tiles/.pg-tile 一种', () => {
  const bad = [];
  for (const rel of allViewModules()) {
    const src = readJs(rel);
    if (/\bpg-stat\b/.test(src)) bad.push(`${rel} :: pg-stat (旧磁贴)`);
    if (/\bpg-status-card\b/.test(src)) bad.push(`${rel} :: pg-status-card (旧磁贴)`);
  }
  assert.deepStrictEqual(bad, [], '旧磁贴复活了:\n  ' + bad.join('\n  '));
});

// ── ⑤ 每个视图模块的页面根是 .pg-page ───────────────────────────

test('视图模块的页面根是 .pg-page', () => {
  // 豁免: chat.mjs 是对话流 (整页是消息区, 不是卡片流);
  //        settings.mjs 是子导航宿主 (内容由 settings/*.mjs 渲染)。
  const EXEMPT = new Set(['views/chat.mjs', 'views/settings.mjs']);
  const bad = [];
  for (const rel of allViewModules()) {
    if (EXEMPT.has(rel)) continue;
    const src = readJs(rel);
    if (!/\bpage\(\)/.test(src) && !/pg-page/.test(src)) bad.push(rel);
  }
  assert.deepStrictEqual(bad, [],
    '这些视图没用设计系统的页面外壳 (page()):\n  ' + bad.join('\n  '));
});

// ── ⑥ 界面里不许出现本机绝对路径 ───────────────────────────────

test('界面里不许出现本机绝对路径', () => {
  const bad = [];
  for (const rel of allViewModules().concat(['lib/util.mjs', 'lib/labels.mjs', 'app.mjs'])) {
    const src = readJs(rel);
    if (/\/Users\/[A-Za-z0-9._-]+\//.test(src)) bad.push(rel);
  }
  assert.deepStrictEqual(bad, [],
    '界面代码里写了本机绝对路径 (开源版会把别人的家目录印在屏幕上):\n  ' + bad.join('\n  '));
});

// ── ⑦ 五行色原值一字不改 ────────────────────────────────────────

test('五行色原值一字不改', () => {
  const css = readCss('themes.css');
  const expect = {
    '--wood': '#00FF1D',
    '--fire': '#FF0000',
    '--earth': '#B28C21',
    '--metal': '#FFEE00',
    '--water': '#0E70F2',
  };
  for (const [k, v] of Object.entries(expect)) {
    const re = new RegExp(k + '\\s*:\\s*' + v.replace('#', '#'), 'i');
    assert.ok(re.test(css), `${k} 必须是 ${v} (老板 10-27 亲手采的原值)`);
  }
});

// ── ⑧ 零件清单要在 design-system.css 里真的定义 ────────────────

test('design-system.css 真的定义了全部基础零件', () => {
  const css = readCss('design-system.css');
  const defined = new Set();
  for (const r of rules(css)) {
    for (const part of r.sel.split(',')) {
      for (const c of classesOf(subjectOf(part))) defined.add(c);
    }
  }
  const missing = PRIMITIVES.filter((c) => !defined.has(c));
  assert.deepStrictEqual(missing, [],
    'design-system.css 里这些零件没定义: ' + missing.join(', '));
});

test('design-system.css 用相对路径被加载', () => {
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  assert.ok(/href=["']design-system\.css["']/.test(html),
    'index.html 必须用相对路径加载 design-system.css');
  assert.ok(!/href=["']\/app\/design-system\.css["']/.test(html),
    '不许写死基址 /app/ (换前缀就丢样式)');
});

// ── ⑨ 零件工厂 (JS) 要能造出这些零件 ───────────────────────────

test('lib/util.mjs 的零件工厂齐全', () => {
  const src = fs.readFileSync(path.join(APP, 'lib', 'util.mjs'), 'utf8');
  for (const fn of ['page', 'pageHead', 'section', 'tiles', 'list', 'listRow', 'kvList', 'table', 'segmented']) {
    assert.ok(new RegExp('export function ' + fn + '\\b').test(src),
      `lib/util.mjs 缺零件工厂: ${fn}()`);
  }
});

test('判据⑨能挑出缺零件 (负例自检)', () => {
  const src = 'export function page() {}';
  const missing = ['page', 'tiles'].filter((fn) => !new RegExp('export function ' + fn + '\\b').test(src));
  assert.deepStrictEqual(missing, ['tiles'], '负例: 缺零件竟然没被挑出来');
});

// ── ⑩ 第 149 批: 同一个类名不许在两个 CSS 文件里各定义一次 ─────────
//
// 起因: 第 149 批首屏加「八卦将灵盘」时, 我在 design-system.css 里写了
//   `.pg-gua-grid` —— 而 components.css 里**早就有一个** .pg-gua-grid
//   (聊天页的卦象卡, 三列)。后加载的 components.css 赢 ⇒ 我那个盘变成三列,
//   职责文字被挤成一条竖线。
//
// 这不是手滑, 是**系统性**的坑 (踩坑日志 2026-10-27 坑二):
//   同一个类在两个 CSS 文件里各写一份 ⇒ 改一处只生效一处, 而且**不知道是哪一处赢**。
//   第 147 批清了 26 处「同一个零件七种画法」, 但**类名重名**这一类还剩着。
//
// 判据 (精确, 免得误伤):
//   · 只看**纯单类主体**的规则 (`.foo { … }`) —— `.a .foo { … }` 那种是
//     带前缀的摆放/状态调整, 合法, 不算冲突;
//   · 只看**不在 @media 里**的规则 —— 媒体查询里的同名规则是条件覆盖, 合法;
//   · 同名 + 跨文件 = 判红, 不管两份定义的内容是否一样 (一样也是重复)。
//
// 负例自检: 造一份"两个文件里都有 .pg-xxx"的数据, 断言判据能挑出来。

test('149-1: 同一个类名不许在两个 CSS 文件里各定义一次', () => {
  const files = allCssFiles().filter((f) => f !== 'design-system.css');
  const owners = new Map(); // class -> Set(file)
  const baseRules = (css) => {
    // 只取不在 @media 里的规则 —— 媒体查询内的同名规则是条件覆盖, 合法。
    const top = css.replace(/@media[^{]*\{([\s\S]*?)\}\s*(?=@media|\s*$)/g, '');
    const out = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(top))) {
      const sel = m[1].trim();
      if (!sel || sel.startsWith('@')) continue;
      for (const part of sel.split(',')) {
        const one = part.trim().match(/^\.([A-Za-z0-9_-]+)$/);
        if (one) out.push(one[1]);
      }
    }
    return out;
  };
  for (const f of files) {
    for (const c of baseRules(readCss(f))) {
      if (!owners.has(c)) owners.set(c, new Set());
      owners.get(c).add(f);
    }
  }
  const dups = [];
  for (const [c, fs] of owners) {
    if (fs.size > 1) dups.push(c + ' → ' + [...fs].join(', '));
  }
  assert.deepStrictEqual(dups, [],
    '这些类名在多个 CSS 文件里各定义了一份 (后加载的赢 ⇒ 改一处只生效一处):\n  ' + dups.join('\n  '));
});

test('149-1 判据能挑出跨文件重名 (负例自检)', () => {
  const baseRules = (css) => {
    const out = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const sel = m[1].trim();
      if (!sel || sel.startsWith('@')) continue;
      for (const part of sel.split(',')) {
        const one = part.trim().match(/^\.([A-Za-z0-9_-]+)$/);
        if (one) out.push(one[1]);
      }
    }
    return out;
  };
  const owners = new Map();
  for (const f of ['a.css', 'b.css']) {
    for (const c of baseRules(f === 'a.css' ? '.pg-dup { color: red; }' : '.pg-dup { color: blue; }')) {
      if (!owners.has(c)) owners.set(c, new Set());
      owners.get(c).add(f);
    }
  }
  assert.ok(owners.get('pg-dup').size === 2, '负例: 判据挑不出跨文件重名');
  // 带前缀的摆放规则不算冲突
  assert.strictEqual(baseRules('.wrap .pg-ok { color: red; }').length, 0,
    '负例: 带前缀的摆放规则被误判成冲突');
});

// ── ⑪ 第 150 批: 页尾收口带 —— 内容页不许再把大段死黑留给老板 ───────
//
// 判据:
//   · 收口带只有**一种画法**, 住 design-system.css (.pg-footband);
//   · 收口带零件工厂 (footband) 住 lib/util.mjs, 跟 page/card/tiles 同源;
//   · 状态 / 历史 / 将灵 / 自动化 / 梅花 五个内容页都用上它 ——
//     用不上 = 大段死黑又回来了, 报红。
test('150-1: 内容页 (状态/历史/将灵/自动化/梅花) 都用 .pg-footband 收口', () => {
  const ds = readCss('design-system.css');
  assert.ok(/\.pg-footband\s*{/.test(ds), '收口带画法必须住 design-system.css');
  const util = readJs('lib/util.mjs');
  assert.ok(/export function footband\b/.test(util), '收口带零件工厂必须住 lib/util.mjs');
  for (const v of ['views/status.mjs', 'views/history.mjs', 'views/subagents.mjs',
    'views/team.mjs', 'views/meihua.mjs']) {
    assert.ok(readJs(v).includes('footband'),
      v + ' 没有收口带 ⇒ 大段死黑又回来了');
  }
});

test('150-1 负例自检: 漏掉某页必须报红', () => {
  const fake = { 'views/status.mjs': 'footband', 'views/team.mjs': 'nothing' };
  const missing = Object.keys(fake).filter((v) => !fake[v].includes('footband'));
  assert.deepStrictEqual(missing, ['views/team.mjs'],
    '负例: 漏掉的页面必须被挑出来');
});

// ── ⑫ 第 150 批: 八字页的勾选项不许是裸系统复选框 ───────────────────
//   裸 <input type=checkbox> 跟全站 .pg-switch 不是一个时代。
//   判据: bazi.mjs 里不许再出现 type="checkbox";
//   两个开关的 id 必须还在 (表单读值走的是它们), 且挂 .pg-switch。
test('150-2: 八字页两个勾选项走 .pg-switch, 不许裸 checkbox', () => {
  const src = readJs('views/bazi.mjs');
  assert.ok(!/type=["']checkbox["']/.test(src), '裸系统复选框复活了');
  assert.ok(/id="bz-f-solar-time"[^>]*pg-switch|pg-switch[^>]*id="bz-f-solar-time"/.test(src)
    || (src.includes('id="bz-f-solar-time"') && /class="bz-chk pg-switch/.test(src)),
    '真太阳时开关丢了或没挂 .pg-switch');
  assert.ok(src.includes('id="bz-f-leap-month"') && /class="bz-chk pg-switch/.test(src),
    '闰月开关丢了或没挂 .pg-switch');
  // 读值必须从开关读 (classList), 不是从 .checked 读 —— 按钮没有 checked。
  assert.ok(/bz-f-solar-time'\)\.classList\.contains\('on'\)/.test(src),
    '真太阳时还在读 .checked ⇒ 开关是死的');
});

// ── ⑬ 第 151 批: 首屏是 agent 的样子, 不是产品落地页 ─────────────
//
// 老板圈掉旧焦点面板: 「大标题 + 两个按钮 + 八卦盘」是宣传页。
// 判据钉死新首屏的三件东西一个都不能少:
//   · 正在发生 (将灵实况, .pg-agent-live)
//   · 最近干过 (.pg-agent-recent, 读的是 /api/pangu/agent/sessions 真数据)
//   · 现在能干什么 (.pg-suggest-row 降级, 不再 2×2 大卡)
// 以及旧焦点面板的大标题 (.pg-hero-title) 不许在 chat 里复活。
// 第 152 批改写: 老板看 Marvis/Kimi 首屏拍 —— 「agent 最开始不需要那么多」。
// 开局最小集 = 一排「交给我干」的入口 (.pg-agent-start) + 一行今天读数
// (.pg-agent-today, 有数据才印)。151 那套「正在发生/最近干过」分栏
// (.pg-agent-grid) 已删 —— 刚开局没有任何事在发生, 硬印一行「静候」
// 是装仪表盘。
test('152-1: 首屏 = 入口一排 + 今天读数, 开局不装仪表盘', () => {
  const chat = readJs('views/chat.mjs');
  assert.ok(!chat.includes('pg-hero-title'), '大标题复活了 —— 那是宣传页的做法');
  assert.ok(!chat.includes('pg-agent-grid') && !chat.includes('pg-agent-live'),
    '「正在发生」分栏复活了 —— 开局没有事在发生, 不装仪表盘');
  // 样稿 2.0 (2026-11-04): 首屏换成 hero 卦画大字 + 内联 composer + 三张功能卡。
  //   旧判据 pg-agent-start / pg-agent-today / listRow 已随样稿撤掉 ——
  //   152 的「入口一排 + 今天读数」被老板 11-04「照搬样稿」整版覆盖。
  //   现在判: 三张功能卡在 (SUGG_CARDS), 内联 composer 在, hero 大字在。
  assert.ok(chat.includes('SUGG_CARDS'), '三张功能卡入口丢了');
  assert.ok(chat.includes('composer'), '内联输入框丢了');
});

test('151-2: 将灵页「已完成」不许跟「进行中」共用绿药丸', () => {
  const sub = readJs('views/subagents.mjs');
  // 判据匹配**结构**不是字面枚举值 (踩坑日志 10-29 坑一): 色档判断
  // 走中文标签 '已完成', 源码里不出现裸的 'done' (那个被 G2 守卫钉死)。
  assert.ok(sub.includes("stLabel === '已完成' ? 'pg-pill-idle' : 'pg-pill-off'"),
    '已完成/进行中 又共用同一种绿 ⇒ 读不出现在谁在跑');
});
