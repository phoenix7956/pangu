'use strict';
/**
 * tests/ui-page-grammar-20261030.test.js
 *
 * 第 170 批守卫 —— 「十页十种画法」
 *
 * 老板 10-30: 「你既然要修补, 那就全量, 要么就重新重做全部页面 ui」。
 * 体检十页截图后的结论: 每一页都自己发明了一套版式 ——
 *   轴宽 880 / 1040 / 1180 / 满屏 不等;
 *   有的页是发丝线区块, 有的页是卡片墙;
 *   梅花/八字整块浮在一片死白里;
 *   设置页顶部横排 12 个分类 (窄屏一条横滚条), 保存按钮浮在窗口右下角;
 *   工具集每一行的按钮都是 primary (九个 primary 抢注意力)。
 *
 * 这些不是「某一页丑」, 是**没有统一语法**。所以这批判据不盯好不好看,
 * 盯**结构**: 轴、颜色、圆角、区块壳、primary 密度。
 *
 * 口径 (契约: ui-contract-170.md):
 *   ① 轴唯一: 页面根 .pg-page 的宽度只由 design-system.css 决定;
 *   ② 页面层 CSS 不许出现 hex 颜色;
 *   ③ 页面层 CSS 的圆角只许走令牌;
 *   ④ 区块只有两种 (.pg-section 发丝线 / .pg-card 有框):
 *      页面 JS 不许手搓区块壳, 也不许自造第三个区块壳 (登记制);
 *   ⑤ primary 是稀缺资源: 全页 primary ≤ 3 个。
 *
 * 每条判据都带负例自检 —— 造一段坏数据, 断言判据能挑出来。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'web', 'app');
const { stripComments } = require('./helpers/strip-comments.js');
const readCss = (rel) => stripComments(fs.readFileSync(path.join(APP, rel), 'utf8'));
const readJs = (rel) => stripComments(fs.readFileSync(path.join(APP, rel), 'utf8'));

/** 页面层 CSS —— 这些文件只许改摆放, 不许自己造外观。 */
const PAGE_CSS = [
  'views.css', 'components.css', 'settings.css',
  'views/bazi.css', 'views/meihua.css', 'views/hexagrams.css',
  'views/qimen.css',
  'views/bazhai.css',
  'views/liuren.css', 'views/mianxiang.css',
];

/** 页面层 JS —— 十页。 */
const PAGE_JS = [
  'views/chat.mjs', 'views/team.mjs', 'views/meihua.mjs', 'views/bazi.mjs',
  'views/hexagrams.mjs', 'views/history.mjs', 'views/marketplace.mjs',
  'views/subagents.mjs', 'views/status.mjs', 'views/settings.mjs',
  'views/qimen.mjs',
  'views/bazhai.mjs',
  'views/liuren.mjs', 'views/mianxiang.mjs',
];

/**
 * 自造区块壳白名单 —— 登记制: 想新造一个「卡片/盒子/面板」, 得先在这里
 * 写一句人话。登记本身是解释, 改表的人会看见自己在干什么。
 */
const SHELL_ALLOW = [
  'pg-card', 'pg-card-body',
  'pg-gua-card',
  'pg-modal-box',
  'pg-note-box', 'pg-warn-box', 'pg-err-line', 'pg-empty-box',
  'pg-permission-panel',
  'pg-subagent-detailbox',
  'pg-todo-box',
  'pg-edit-box',
  'errbox',                              // 旧版错误提示盒 (提示类, 不是区块)
  'spinbox',                             // 数字微调框 (输入控件, 不是区块)
  'sugg-card',                           // 工作台首页三张功能卡 (design-system.css .sugg 网格里的展示项, 不是区块壳)
];

test('170-1: 页面根 .pg-page 的宽度只由 design-system.css 决定', () => {
  const ds = readCss('design-system.css');
  const m = /\.pg-page:not\(\.is-wide\):not\(\.is-chat\)\s*\{([^}]*)\}/.exec(ds);
  assert.ok(m, 'design-system.css 少了默认轴的声明 —— 页面宽度就没人管了');
  assert.match(m[1], /max-width:\s*var\(--col\)/,
    '默认轴必须是 var(--col), 不许写死数字');
  const wide = /\.pg-page\.is-wide\s*\{([^}]*)\}/.exec(ds);
  assert.ok(wide && /max-width:\s*var\(--col-wide\)/.test(wide[1]),
    '宽轴必须是 var(--col-wide)');
  for (const rel of PAGE_CSS) {
    const css = readCss(rel);
    // `\.pg-page` 后面**不许跟字母/连字符** —— 否则 .pg-page-head-actions
    // 这种「以 .pg-page 开头的另一个类」会被误判成页面根。
    assert.ok(!/\.pg-page(?![-\w])[^{]*\{[^}]*max-width/.test(css),
      rel + ' 又自己给页面根写了 max-width —— 轴只能有一个真源');
  }
});

test('170-1b: 负例自检 —— 页面层写死 max-width 得被挑出来', () => {
  const bad = '.pg-page { max-width: 1180px; }';
  assert.ok(/\.pg-page[^{]*\{[^}]*max-width/.test(bad),
    '判据挑不出页面层写死的轴');
});

test('170-2: 页面层 CSS 不许出现 hex 颜色 (颜色只走令牌)', () => {
  const bad = [];
  for (const rel of PAGE_CSS) {
    const css = readCss(rel);
    for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      bad.push(rel + ' :: ' + m[0]);
    }
  }
  assert.deepStrictEqual(bad, [],
    '页面层藏了色值 —— 换主题时它不跟着变, 于是同一个界面三种颜色: '
    + bad.join(' | '));
});

test('170-2b: 负例自检 —— 页面层 hex 得被挑出来', () => {
  const css = '.pg-thing { color: #A15C2B; }';
  assert.strictEqual((css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length, 1);
});

test('170-3: 页面层 CSS 的圆角只许走令牌', () => {
  const bad = [];
  for (const rel of PAGE_CSS) {
    const css = readCss(rel);
    for (const m of css.matchAll(/border-radius:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      const ok = /^var\(--r-[a-z]+\)$/.test(v)
        || v === '0' || v === '50%' || v === 'inherit' || v === '999px'
        || /^0 var\(--r-[a-z]+\) var\(--r-[a-z]+\) 0$/.test(v)
        || /^0 0 var\(--r-[a-z]+\) var\(--r-[a-z]+\)$/.test(v);
      if (!ok) bad.push(rel + ' :: border-radius: ' + v);
    }
  }
  assert.deepStrictEqual(bad, [],
    '页面层自己写圆角 —— 圆角是令牌层的事: ' + bad.join(' | '));
});

test('170-4: 页面 JS 不许手搓区块壳 (必须走 util 工厂)', () => {
  // 只盯**外壳本身** (`pg-section` / `pg-card` 整词)。
  // 子零件 (pg-section-hint / pg-card-header / pg-card-body) 是设计系统的
  // 零件, 页面**可以引用**它们 (比如往区块头里塞一个计数、给卡头加个修饰类);
  // 真正要禁的是「自己造一个新壳」 —— 那是 170-5 的登记制在管。
  const bad = [];
  for (const rel of PAGE_JS) {
    const src = readJs(rel);
    for (const m of src.matchAll(/['"][^'"]*\bpg-(section|card)\b(?![-\w])[^'"]*['"]/g)) {
      bad.push(rel + ' :: ' + m[0]);
    }
  }
  assert.deepStrictEqual(bad, [],
    '页面里手搓了区块壳 —— 区块只有两种, 手搓就等于第三种: '
    + bad.join(' | '));
});

test('170-4b: 负例自检 —— 手搓外壳得被挑出来, 子零件不算', () => {
  assert.ok(/['"][^'"]*\bpg-(section|card)\b(?![-\w])[^'"]*['"]/.test("'pg-card'"),
    '判据挑不出手搓的区块外壳');
  assert.ok(!/['"][^'"]*\bpg-(section|card)\b(?![-\w])[^'"]*['"]/.test("'pg-card-body'"),
    '判据把设计系统的子零件也当成手搓外壳了');
});

test('170-5: 页面 JS 不许自造第三种区块壳 (card/box/panel 必须在册)', () => {
  const bad = [];
  for (const rel of PAGE_JS) {
    const src = readJs(rel);
    for (const m of src.matchAll(/class:\s*'([^']+)'/g)) {
      for (const tok of m[1].split(/\s+/)) {
        // 只抓「区块壳」味的类名: 以 card/panel 结尾, 或 -box 结尾。
        // errbox / spinbox 是控件不是区块, 已在册。
        if (!/(card|panel)$|-box$/.test(tok)) continue;
        if (SHELL_ALLOW.includes(tok)) continue;
        bad.push(rel + ' :: ' + tok);
      }
    }
  }
  assert.deepStrictEqual([...new Set(bad)], [],
    '这些是自造的卡片/盒子/面板 —— 要么登记进 SHELL_ALLOW 并说清理由, '
    + '要么改用 .pg-section / .pg-card: ' + [...new Set(bad)].join(' | '));
});

test('170-6: primary 按钮是稀缺资源 (页面级 ≤ 3, 每个弹窗再准一个)', () => {
  // 口径: primary = 「这一屏的主要行动」。全屏只许一个, 每个弹窗里的
  // 「确认」可以再有一个 —— 弹窗是另一个屏幕。
  // 页面级额度 3 是给「列表行里也放 primary」这种错误留的余量:
  // 一旦有人在清单行里挂主按钮, 计数立刻超, 判红。
  const bad = [];
  for (const rel of PAGE_JS) {
    const src = readJs(rel);
    const n = (src.match(/pg-btn-primary/g) || []).length;
    const modals = (src.match(/modalShell\(/g) || []).length;
    const allow = 3 + modals;
    if (n > allow) bad.push(rel + ' :: ' + n + ' 个 (额度 ' + allow + ')');
  }
  assert.deepStrictEqual(bad, [],
    'primary 超过额度 ⇒ 一屏好几个主行动, 等于没有主行动 '
    + '(清单行里挂主按钮就会撞线): '
    + bad.join(' | '));
});

test('170-6b: 负例自检 —— 超量的 primary 得被挑出来', () => {
  const src = Array.from({ length: 5 }, () => "'pg-btn pg-btn-primary'").join(',');
  assert.ok((src.match(/pg-btn-primary/g) || []).length > 3);
});

test('170-7: 守卫本身得在工作 (扫到的文件不能太少)', () => {
  assert.ok(PAGE_CSS.length >= 6, '页面 CSS 清单太短: ' + PAGE_CSS.join(', '));
  assert.ok(PAGE_JS.length >= 10, '页面 JS 清单太短: ' + PAGE_JS.join(', '));
  for (const rel of PAGE_CSS) {
    assert.ok(fs.existsSync(path.join(APP, rel)), '找不到 ' + rel);
  }
  for (const rel of PAGE_JS) {
    assert.ok(fs.existsSync(path.join(APP, rel)), '找不到 ' + rel);
  }
});
// 第 225 批: 视图 .mjs 语法守卫 —— 222 批「需四柱」卡多打一个右括号, bazhai.mjs
// import 时报 Unexpected token ')', 老板截图「此页未通」就是这个。node --check 兜底。
test('视图 .mjs 全过 node --check (语法守卫, 第 225 批)', () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const views = path.resolve(__dirname, '../web/app/views');
  const files = fs.readdirSync(views).filter((f) => f.endsWith('.mjs'));
  for (const f of files) {
    execFileSync('node', ['--check', path.join(views, f)], { stdio: 'pipe' });
  }
  assert.ok(files.length >= 4, 'views 目录应有 .mjs 视图文件');
});
