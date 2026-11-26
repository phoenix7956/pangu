'use strict';
/**
 * tests/ui-typography-20261029.test.js
 *
 * 第 146 批守卫 —— 「界面不许再混字体 / 混字号 / 混字重 / 混字距」
 *
 * ── 起因 ─────────────────────────────────────────────────────
 *   老板说「页面太乱了，字体风格好几种？」+「字体大小也是乱七八糟」。
 *
 *   上第 144 批只收了**字号令牌** (6 档), 结果老板还是看见乱 —— 因为
 *   「乱」的四条机制里, 只治了一条:
 *
 *   ① **字体 6+ 套**: --font-ui / --font-script / --font-display /
 *      --font-mono + 六处硬编码等宽栈 + `var(--mono, monospace)`
 *      (--mono 这个令牌**压根不存在** ⇒ 落到浏览器默认等宽)。
 *      最阴的是 --font-display: 它跟 --font-script 只差一个 "Times New Roman",
 *      ⇒ 同一个标题里**中文是宋体、英文数字却是新罗马**。
 *   ② **字号 3 套机制并存**: var(--fs-*) + 一处 .9em + **浏览器默认字号**
 *      (<h1> 2em / <h3> 1.17em / <small> .83em —— 这些数在 6 档阶梯里
 *      一个都不存在)。
 *   ③ **字重 5 档**: 600 / 500 / 400 / **650** / 700。
 *      650 是 SF Pro 专有的可变字重, 宋体黑体上不存在 ⇒ 渲染结果随机。
 *   ④ **字距 10 档**, 而且**清一色套在中文标签上**:
 *      `text-transform: uppercase` 对汉字是**死代码**, 而 letter-spacing
 *      把满格的汉字撑出缝隙 —— 这套是从英文界面模板抄来的, 在中国字上全错。
 *
 * ── 判据 ─────────────────────────────────────────────────────
 *   字体只有三个角色 (无衬线正文 / 宋体身份字 / 等宽代码);
 *   字号只许令牌 (或 1em 继承); 字重只许 400/500/600; 字距只许两个令牌;
 *   裸标签必须被 reset 兜住; 全站不许 uppercase;
 *   梅花页的选择器只许在 views/meihua.css 里定义 (唯一真源)。
 *
 * ── 纪律 ─────────────────────────────────────────────────────
 *   只看**声明**, 不看注释 (注释里常写着「不许 xxx」, 全文匹配会咬自己);
 *   每条判据都带**负例自检**: 造一段坏 CSS, 断言判据能挑出来。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'web', 'app');

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const readCss = (rel) => stripComments(fs.readFileSync(path.join(APP, rel), 'utf8'));

// 自动发现全部 css (themes.css 是令牌定义处, 单独判)
function allCssFiles() {
  const out = [];
  const walk = (rel) => {
    const dir = path.join(APP, rel);
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(r);
      else if (ent.name.endsWith('.css')) out.push(r);
    }
  };
  walk('.');
  return out;
}

const CSS_FILES = allCssFiles();
const VIEW_FILES = CSS_FILES.filter((f) => f !== 'themes.css');

// 收集某个属性的全部声明值 (值 → 出现位置)
function decls(prop, files) {
  const out = [];
  const re = new RegExp(prop + '\\s*:\\s*([^;}]+)', 'g');
  for (const rel of files) {
    const css = readCss(rel);
    let m;
    while ((m = re.exec(css))) out.push({ file: rel, value: m[1].trim() });
  }
  return out;
}

// ── ① 字体: 只有三个角色 ───────────────────────────────────────

test('146-1: 字体只许三个角色令牌 (不许硬编码字体栈)', () => {
  const allowed = new Set(['var(--font-ui)', 'var(--font-script)', 'var(--font-mono)']);
  const bad = [];
  for (const d of decls('font-family', VIEW_FILES)) {
    if (!allowed.has(d.value)) bad.push(d.file + ' :: font-family: ' + d.value);
  }
  assert.deepStrictEqual(bad, [],
    '这些地方写死了字体栈 —— 全站的字体风格会越走越多: ' + bad.join(' | '));
});

test('146-1b: 负例自检 —— 硬编码字体栈得被挑出来', () => {
  const re = /font-family\s*:\s*([^;}]+)/g;
  const allowed = new Set(['var(--font-ui)', 'var(--font-script)', 'var(--font-mono)']);
  const css = '.a { font-family: "Songti SC", serif; } .b { font-family: var(--font-ui); }';
  const found = [];
  let m;
  while ((m = re.exec(css))) found.push(m[1].trim());
  assert.ok(found.some((v) => !allowed.has(v)),
    '判据挑不出硬编码字体栈 (Songti SC / Menlo / ui-monospace 全会溜过去)');
});

test('146-2: --font-display 必须被删掉 (它跟 --font-script 只差一个 Times New Roman)', () => {
  const css = readCss('themes.css');
  assert.doesNotMatch(css, /--font-display\s*:/,
    '--font-display 又回来了 —— 它会让同一个标题里中文是宋体、英文数字是新罗马');
  assert.match(css, /--font-script\s*:/, 'themes.css 少了 --font-script (经文字)');
  assert.match(css, /--font-mono\s*:/, 'themes.css 少了 --font-mono');
  assert.match(css, /--font-ui\s*:/, 'themes.css 少了 --font-ui');
});

test('146-3: 不许引用不存在的字体令牌 (var(--mono, monospace) 那种)', () => {
  const themes = readCss('themes.css');
  const declared = new Set();
  let m;
  const re = /(--[a-z0-9-]+)\s*:/gi;
  while ((m = re.exec(themes))) declared.add(m[1]);
  const bad = [];
  for (const d of decls('font-family', VIEW_FILES)) {
    const vm = /var\((--[a-z0-9-]+)/.exec(d.value);
    if (vm && !declared.has(vm[1])) {
      bad.push(d.file + ' :: ' + d.value + '  (' + vm[1] + ' 没定义)');
    }
  }
  assert.deepStrictEqual(bad, [],
    '引用了不存在的字体令牌 ⇒ 落到浏览器默认值, 渲染不受控: ' + bad.join(' | '));
});

// ── ② 字号: 只有令牌 + 继承 ────────────────────────────────────

test('146-4: 字号只许 var(--fs-*) 或 1em (继承)', () => {
  const bad = [];
  for (const d of decls('font-size', VIEW_FILES)) {
    const v = d.value;
    if (/^var\(--fs-[a-z0-9-]+\)$/.test(v)) continue;
    if (v === '1em') continue;
    bad.push(d.file + ' :: font-size: ' + v);
  }
  assert.deepStrictEqual(bad, [],
    '这些字号没走阶梯 (rem / % / .9em / 魔数 px 都不许): ' + bad.join(' | '));
});

test('146-5: 裸标签必须被 reset 兜住 (h1/h2/h3/small/code/b/strong)', () => {
  const css = readCss('styles.css');
  const need = [
    ['h1', /h1\s*\{[^}]*font-size\s*:\s*var\(--fs-/],
    ['h2,h3', /h2\s*,\s*h3\s*\{[^}]*font-size\s*:\s*var\(--fs-/],
    ['h4~h6', /h4\s*,\s*h5\s*,\s*h6\s*\{[^}]*font-size\s*:\s*var\(--fs-/],
    ['small', /small\s*\{[^}]*font-size\s*:\s*var\(--fs-/],
    ['code/kbd/samp/pre', /code\s*,\s*kbd\s*,\s*samp\s*,\s*pre\s*\{[^}]*font-family\s*:\s*var\(--font-mono\)/],
    ['b/strong', /b\s*,\s*strong\s*\{[^}]*font-weight\s*:\s*600/],
  ];
  const missing = need.filter(([, re]) => !re.test(css)).map(([n]) => n);
  assert.deepStrictEqual(missing, [],
    '这些裸标签没被 reset 兜住 ⇒ 浏览器默认字号 (h1=32px/h3=18.72px/small=11.62px) '
    + '会直接漏进页面, 而这些数在 6 档阶梯里一个都不存在');
});

// ── ③ 字重: 只有三档 ───────────────────────────────────────────

test('146-6: 字重只许 400 / 500 / 600', () => {
  const allowed = new Set(['400', '500', '600']);
  const bad = [];
  for (const d of decls('font-weight', VIEW_FILES)) {
    if (!allowed.has(d.value)) bad.push(d.file + ' :: font-weight: ' + d.value);
  }
  assert.deepStrictEqual(bad, [],
    '字重出了三档 —— 650 是 SF Pro 专有可变字重 (宋体黑体上会合成), '
    + '700 让"强调"变成两种粗细: ' + bad.join(' | '));
});

test('146-6b: 负例自检 —— 650 / 700 得被挑出来', () => {
  const allowed = new Set(['400', '500', '600']);
  const css = '.a { font-weight: 650; } .b { font-weight: 700; } .c { font-weight: 600; }';
  const re = /font-weight\s*:\s*([^;}]+)/g;
  const found = [];
  let m;
  while ((m = re.exec(css))) found.push(m[1].trim());
  assert.ok(found.filter((v) => !allowed.has(v)).length === 2,
    '判据挑不出 650 / 700 这两个越界字重');
});

// ── ④ 字距: 只有两个令牌, 且不许 uppercase ─────────────────────

test('146-7: 字距只许 --ls-normal / --ls-label 两个令牌', () => {
  const allowed = new Set(['var(--ls-normal)', 'var(--ls-label)']);
  const bad = [];
  for (const d of decls('letter-spacing', VIEW_FILES)) {
    if (!allowed.has(d.value)) bad.push(d.file + ' :: letter-spacing: ' + d.value);
  }
  assert.deepStrictEqual(bad, [],
    '字距散着自定义值 ⇒ 同样是标签, 这处撑开那处不撑: ' + bad.join(' | '));
});

test('146-8: 全站不许 text-transform: uppercase (对汉字是死代码, 对中文是灾难)', () => {
  const bad = [];
  for (const d of decls('text-transform', VIEW_FILES)) {
    if (d.value === 'uppercase') bad.push(d.file + ' :: text-transform: uppercase');
  }
  assert.deepStrictEqual(bad, [],
    'uppercase 对汉字完全无效 (死代码), 而配合 letter-spacing 会把满格的汉字'
    + '撑出缝隙 —— 这套是从英文模板抄来的: ' + bad.join(' | '));
});

test('146-8b: 负例自检 —— uppercase 得被挑出来', () => {
  const css = '.a { text-transform: uppercase; } .b { text-transform: lowercase; }';
  const re = /text-transform\s*:\s*([^;}]+)/g;
  const found = [];
  let m;
  while ((m = re.exec(css))) found.push(m[1].trim());
  assert.ok(found.includes('uppercase'), '判据挑不出 uppercase');
});

test('146-9: 拉丁内容也不许 uppercase —— 全站现在一处都不需要', () => {
  // .pg-hist-turn-who 的内容是中文 ("用户"/"盘古"), 不是 USER/ASSISTANT
  // ⇒ 它当年挂 uppercase 是从模板抄来的, 现在整条规则都要归零。
  const css = readCss('views.css');
  const b = (css.match(/\.pg-hist-turn-who\s*\{[^}]*\}/) || [''])[0];
  assert.doesNotMatch(b, /uppercase/, '.pg-hist-turn-who 内容是中文, 不该有 uppercase');
});

// ── ⑤ 同一组件类不许在两个文件里各定义一次 ─────────────────────

test('146-10: 梅花页的选择器只许在 views/meihua.css 里定义 (唯一真源)', () => {
  const bad = [];
  for (const d of decls('font-family', ['views.css'])) {
    if (/\.pg-mh/.test(d.value)) bad.push('views.css :: ' + d.value);
  }
  // 更强: views.css 里根本不许出现 .pg-mh- 开头的选择器
  const css = readCss('views.css');
  const hits = [];
  const re = /\.pg-mh[-a-zA-Z0-9_]*(?=[,\s{])/g;
  let m;
  while ((m = re.exec(css))) hits.push(m[0]);
  assert.deepStrictEqual([...new Set(hits)], [],
    '梅花页的样式在 views.css 里又冒出来了 —— 梅花页的唯一真源是 views/meihua.css, '
    + '两处各写一遍 = 改一处不生效 (第 144 批就是这么把 .pg-mh-ty-level 写废的)');
});

test('146-11: 负例自检 —— 跨文件重复定义要能挑出来', () => {
  const dup = (a, b) => {
    const sa = new Set((a.match(/\.[a-zA-Z0-9_-]+/g) || []));
    return (b.match(/\.[a-zA-Z0-9_-]+/g) || []).filter((x) => sa.has(x));
  };
  assert.ok(dup('.x { color: red; }', '.x { color: blue; }').length === 1,
    '判据挑不出跨文件重复定义的选择器');
});

// ── ⑥ 令牌本身必须齐 ───────────────────────────────────────────

test('146-12: themes.css 必须定死 4 档字号 + 3 个字体 + 2 个字距 (第 167 批)', () => {
  const css = readCss('themes.css');
  // 第 167 批: 字号阶梯从六档收到四档 (26/18/14/12) —— 老板说「太多了」。
  for (const t of ['--fs-display', '--fs-title', '--fs-body',
    '--fs-meta', '--font-ui', '--font-script', '--font-mono',
    '--ls-normal', '--ls-label']) {
    assert.ok(new RegExp(t.replace(/[-]/g, '\\-') + '\\s*:').test(css),
      'themes.css 少了令牌 ' + t);
  }
});

test('146-13: 守卫本身得在工作 (自动发现的 css 不能太少)', () => {
  assert.ok(CSS_FILES.length >= 8,
    '自动发现到的 css 太少 (' + CSS_FILES.length + ' 个), 判据可能根本没在工作: '
    + CSS_FILES.join(', '));
  assert.ok(VIEW_FILES.length >= 7, '视图层 css 太少: ' + VIEW_FILES.join(', '));
});

