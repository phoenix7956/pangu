'use strict';

// 2026-10-28 (第 138 批): 工作台「界面收尾」守卫
//
// ─────────────────────────────────────────────────────────────────────────
// 老板原话: 「我想让盘古的ui再好看点，现在的不上档次」+「都解决啊，另外还有界面问题」
//
// 这一批修的都是**看得见**的问题:
//   ① 界面里到处漏后端英文枚举 (done / openai / single_free / online …)
//   ② 设置页那条 sticky「保存」条浮在内容上面, 把卡片最后两行盖掉
//   ③ 工具集页标题重复 (顶栏一个 h1, 页面又一个 h1)
//   ④ 历史档案页副标题贴到视口左沿
//   ⑤ 将灵表末列被视口切掉
//
// 守则: **注释 ≠ 隔离**。上面五条每一条都要有机器判据, 不能靠"我改过了"。
// 本守卫就是那五条的判据; 负例自检 (G6) 保证它不是恒真的摆设。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const APP = path.join(CORE, 'web', 'app');
// 注释剥除器共享 (2026-10-29): emoji 守卫原来只剥行注释, 块注释里
// 「以前这里印的是几个 emoji」的历史说明被当成真 emoji 报了红。
const { stripComments } = require('./helpers/strip-comments.js');

function read(rel) {
  return fs.readFileSync(path.join(APP, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(APP, rel));
}

// 判据只认**代码**, 不认注释 —— 注释里写 "原来是 position: sticky" 不该算违规,
// 但也不能因此把判据放宽到"源码里随便写 sticky 也行"。
function stripCssComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

// 逐行去掉 // 整行注释 (不做字符串解析, 只认**整行**都是注释的那些)。
function stripLineComments(s) {
  return s.split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}


// padding 简写里取**水平**那一档: '0 18px' ⇒ 18px; '18px' ⇒ 18px; '0 18px 0' ⇒ 18px
function horizPad(rule) {
  const m = rule.match(/padding(?:-inline)?:\s*([^;]+);/);
  if (!m) return null;
  const parts = m[1].trim().split(/\s+/);
  const horiz = parts.length === 1 ? parts[0] : parts[1];
  return parseFloat(horiz);
}

// ── G1 · 枚举中文化: 单一真源 + 各页不许再自己拼英文 ─────────────
test('G1: 枚举中文化有单一真源 lib/labels.mjs, 且覆盖了漏出来的那些枚举', () => {
  assert.ok(exists('lib/labels.mjs'), 'lib/labels.mjs 不存在 —— 枚举中文化没有单一真源');
  const src = read('lib/labels.mjs');
  for (const k of ['SUBAGENT_RUN_STATE', 'NODE_ROLE', 'NODE_STATUS', 'PROTOCOL', 'MODE', 'PLAN', 'CAPABILITY', 'DEGRADATION']) {
    assert.ok(src.includes(k), 'labels.mjs 里没有 ' + k + ' 这张表');
  }
  for (const v of ['done', 'start', 'primary', 'online', 'openai', 'single_free', 'personal', 'normal']) {
    assert.ok(src.includes(v), 'labels.mjs 里没有 ' + v + ' 这个原值 —— 会漏回界面');
  }
});

test('G2: 界面里不许出现后端英文枚举的裸值 (除非经过 label())', () => {
  // 这些字符串必须**只**出现在 labels.mjs 里; 视图里再写一遍就是又漏回界面了。
  const LEAKS = [
    ['views/status.mjs', "'single_free'"],
    ['views/status.mjs', "'openai'"],
    ['views/settings/connect.mjs', "'single_free'"],
    ['views/settings/connect.mjs', "'personal'"],
    ['views/subagents.mjs', "'done'"],
    ['app.mjs', "'single_free'"],
  ];
  for (const [file, needle] of LEAKS) {
    const src = stripLineComments(read(file));
    assert.ok(!src.includes(needle),
      file + ' 里直接写了 ' + needle + ' —— 界面会漏出后端英文枚举, 必须走 label()');
  }
});

// ── G3 · 设置页「保存」条不许浮在内容上面 ─────────────────────────
test('G3: 保存操作栏住在页头动作区, 不是 sticky 浮在滚动区里', () => {
  // 第 170 批: 操作栏从「页脚槽右下角」改成**页头右上角** (页头吸顶) ——
  //   右下角一个孤零零的浮条, 离内容很远, 一眼像后台系统的悬浮操作条。
  //   主流 agent (ChatGPT / Linear / Vercel) 都把页面级动作放页头。
  const css = stripCssComments(read('settings.css'));
  const block = css.match(/\.pg-actionbar\s*\{[^}]*\}/);
  assert.ok(block, 'settings.css 里找不到 .pg-actionbar');
  assert.ok(!/position\s*:\s*sticky/.test(block[0]),
    '.pg-actionbar 还是 position: sticky —— 它会浮在内容上面盖住表格最后几行');
  assert.ok(!/position\s*:\s*fixed/.test(block[0]),
    '.pg-actionbar 改成了 fixed —— 一样会脱离滚动流盖住内容');

  // 页头动作槽必须真的存在 (壳里开出这一层 + 交接模块)
  assert.ok(exists('lib/page-actions.mjs'), 'lib/page-actions.mjs 不存在 —— 页头动作区没有交接模块');
  const shell = read('views/settings.mjs');
  assert.ok(/setPageActionHost/.test(shell), 'views/settings.mjs 里没把页头动作槽交出来');
  assert.ok(/pg-page-head-actions/.test(shell), 'views/settings.mjs 里页头没有动作区');
  // 页头吸顶 ⇒ 动作永远看得见
  assert.ok(/\.pg-page-head\s*\{[^}]*position\s*:\s*sticky/.test(css),
    '设置页页头不吸顶 —— 内容一长, 保存按钮就滚不见了');
});

test('G4: 用到操作栏的三个设置子页都把条交给页头动作区, 不是塞回滚动区', () => {
  for (const f of ['views/settings/connect.mjs', 'views/settings/ui.mjs', 'views/settings/agent.mjs']) {
    const src = read(f);
    assert.ok(!/getFooterHost\(\)/.test(src),
      f + ' 还在用 getFooterHost() —— 第 170 批起操作栏归页头动作区');
    assert.ok(!/host\.appendChild\(bar\)/.test(src),
      f + ' 还在把操作栏塞回滚动区 (host.appendChild(bar))');
  }
  // 动作条自己找家: 组件层统一放进页头动作槽
  const widgets = read('components/settings-widgets.mjs');
  assert.ok(/getPageActionHost/.test(widgets),
    'actionBar 不会自己找家 —— 子页各写各的, 动作又散回页面里');
});

// ── G5 · 标题不重复 / 副标题不贴边 / 表不被视口切 ───────────────
test('G5: 工具集页不重复画 h1 (顶栏已经是标题真源)', () => {
  const mp = read('views/marketplace.mjs');
  assert.ok(!/el\('h1',\s*\{\},\s*'工具集'\)/.test(mp),
    "marketplace.mjs 里又画了一个 <h1>工具集</h1> —— 跟顶栏重复");
  assert.ok(!/el\('h1',\s*\{\},\s*'内部工具/.test(mp),
    'marketplace.mjs 里又画了一个 <h1>内部工具…</h1> —— 跟 tab 重复');
});

test('G6: 页面说明挂在顶栏 (不贴视口左沿, 也不浮在正文上方)', () => {
  const html = read('index.html');
  const app = read('app.mjs');
  const css = stripCssComments(read('styles.css'));

  // ① 顶栏有副标题位, 且在标题块里
  assert.ok(html.includes('pangu-topbar-sub'), 'index.html 里没有 .pangu-topbar-sub —— 副标题没地方放');
  assert.ok(html.includes('id="view-sub"'), 'index.html 里没有 #view-sub');
  const titleBlock = html.slice(html.indexOf('pangu-topbar-title'), html.indexOf('pangu-health'));
  assert.ok(titleBlock.includes('view-sub'), '副标题不在顶栏标题块里');

  // ② app.mjs 真的把副标题写进去
  assert.ok(app.includes("$('#view-sub')"), 'app.mjs 必须给 #view-sub 写内容');
  assert.ok(!/el\('div',\s*\{\s*class:\s*'pangu-page-heading'\s*\}\)/.test(app),
    'app.mjs 不许再往正文里插一行孤零零的副标题');

  // ③ 顶栏文字不贴视口左沿 (水平内边距 > 0)
  const bar = css.match(/\.pangu-topbar\s*\{[^}]*\}/);
  assert.ok(bar, 'styles.css 里找不到 .pangu-topbar');
  const px = horizPad(bar[0]);
  assert.ok(px !== null && Number.isFinite(px) && px > 0,
    '.pangu-topbar 的水平内边距是 ' + px + ' —— 标题会贴视口左沿');
});

// G6 的负例自检: 把顶栏内边距去掉, 判据必须真报红 (别让守卫恒真)
test('G6-负例: 顶栏内边距归零后, G6 必须报红', () => {
  const css = stripCssComments(read('styles.css'));
  const bad = css.replace(/\.pangu-topbar\s*\{[^}]*\}/, '.pangu-topbar { padding: 0;');
  const bar = bad.match(/\.pangu-topbar\s*\{[^}]*\}/);
  const px = horizPad(bar[0]);
  assert.ok(!(px !== null && Number.isFinite(px) && px > 0),
    '负例自检失败: 内边距归零后 G6 竟然还判通过 —— 那 G6 是摆设');
});

test('G7: 将灵表用 table-layout:fixed (末列不被视口切掉)', () => {
  const css = read('views.css');
  // 第 147 批: 表格并进设计系统 —— `.pg-table.is-fixed` 是全站唯一一种
   // 定宽表 (末列拿剩余宽度, 省略号落在卡片里而不是视口外)。
  const ds = read('design-system.css');
  assert.ok(/\.pg-table\.is-fixed[^{]*\{[^}]*table-layout:\s*fixed/.test(ds),
    'design-system.css 里 .pg-table.is-fixed 没有 table-layout:fixed —— 末列会被视口切掉');
  const sub = read('views/subagents.mjs');
  assert.ok(/pg-table is-fixed/.test(sub), 'subagents.mjs 没用 .pg-table is-fixed');
});

// ── G8 · 负例自检: 上面几条真能抓出坏状态 (别让守卫恒真) ─────────
test('G8: 负例自检 —— 把操作栏改回 sticky, 守卫必须真报红', () => {
  const good = read('settings.css');
  const bad = good.replace(/\.pg-actionbar\s*\{/, '.pg-actionbar {\n  position: sticky;');
  assert.ok(/position\s*:\s*sticky/.test(bad), '负例构造失败: 没把 sticky 塞进去');
  const block = bad.match(/\.pg-actionbar\s*\{[^}]*\}/);
  assert.ok(/position\s*:\s*sticky/.test(block[0]),
    '负例自检失败: G3 的判据对 sticky 竟然不报警 —— 那 G3 是摆设');
});

// ── G9 · 界面源码里不许再有 emoji ────────────────────────────────
test('G9: 工作台界面源码里没有 emoji (字形各平台不一样, 也不跟主题走)', () => {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.mjs')) files.push(p);
    }
  })(APP);
  // \p{Extended_Pictographic} 命中 emoji, 但**不**命中八卦卦符 (☰☱☲☳☴☵☶☷) ——
//   卦符是盘古的正文符号, 不是装饰 emoji, 必须留着。
  const EMOJI = /\p{Extended_Pictographic}/gu;
  const bad = [];
  for (const f of files) {
    stripComments(fs.readFileSync(f, 'utf8')).split('\n').forEach((code, i) => {
      const hits = code.match(EMOJI);
      if (hits) bad.push(path.relative(APP, f) + ':' + (i + 1) + ' [' + [...new Set(hits)].join('') + ']');
    });
  }
  assert.deepStrictEqual(bad, [],
    '界面源码里还有 emoji: ' + bad.join(' | ') + ' —— 换成 lib/icons.mjs 里的矢量图标');
});

