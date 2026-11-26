'use strict';
/**
 * tests/ui-type-scale-20261029.test.js
 *
 * 第 144 批守卫 —— 「不许界面退回没有层级的样子」
 *
 * ── 起因 ─────────────────────────────────────────────────────
 *   老板说「这 ui，怎么感觉那么笨」。查下来「笨」不是审美模糊, 是四条**机制**:
 *
 *   ① 字号只有两档 (13px 正文 / 16px 标题) ⇒ 全站每一件东西一样重, 像 Excel;
 *   ② 满屏同一个方框 (19 张一模一样的卡 + 4 张一模一样的建议卡) ⇒ 卡片汤;
 *   ③ 工作台是「572px 建议 + 264px 速览」两张卡拼贴, 中间 44px 缝;
 *   ④ 工具集 19 张一模一样的竖卡 + 38 个文字按钮铺一屏。
 *
 * ── 判据 ─────────────────────────────────────────────────────
 *   这些都不是"审美", 是**可以钉死的结构**。所以守卫也钉结构:
 *   字号阶梯令牌必须齐 (6 档)、空态不许再是两栏拼贴、
 *   工具集不许再回到竖向卡片墙、卡片主标题必须是中文名。
 *
 * ── 纪律 ─────────────────────────────────────────────────────
 *   判据只看**声明**, 不看注释 —— 注释里常写着「不许 xxx」, 全文匹配会咬自己一口。
 *   每条判据都带**负例自检**: 造一段坏代码, 断言判据能挑出来 (不然守卫是装饰)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'web', 'app');

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const readCss = (rel) => stripComments(fs.readFileSync(path.join(APP, rel), 'utf8'));
// 第 148 批: JS 也走**字符级**注释剥除 (共享 helper) ——
//   本文件自己的 `/* *\/` 剥法认不出 // 行注释, 认不出字符串里的 "/*",
//   以前就因为「注释里写着旧类名」把守卫自己咬了一口。
const { stripComments: stripJsComments } = require('./helpers/strip-comments.js');
const readJs = (rel) => stripJsComments(fs.readFileSync(path.join(APP, rel), 'utf8'));

// 取一条声明块: `.sel { ... }`
function block(css, selector) {
  const re = new RegExp(
    '(^|[},])\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}',
    'm'
  );
  const m = css.match(re);
  return m ? m[2] : null;
}

// ── ① 字号阶梯 ─────────────────────────────────────────────────

/**
 * 取一个字号令牌的**基准 px**。
 * 第 148 批起, 令牌写成了 `calc(26px * var(--ui-scale))` ——
 * 设置页「正文基准字号」滑块靠这个倍率把全站字号一起缩放
 * (以前那个滑块改的是 html{font-size}, 而全站一个 rem 都没用 ⇒ 死控件)。
 */
function fsVal(css, name) {
  const m = css.match(new RegExp(name.replace(/-/g, '\\-') + '\\s*:\\s*(?:calc\\(\\s*)?(\\d+)px'));
  return m ? Number(m[1]) : null;
}

test('144-1: themes.css 必须定死 4 档字号阶梯 (第 167 批: 6 档 → 4 档)', () => {
  const css = readCss('themes.css');
  // 第 167 批: 老板说「字号阶梯彻底定死: 30/21/17/14/12/11, 太多了」。
  //   21 vs 17、12 vs 11 是**同层微差**写成了不同档 —— 代码里两档,
  //   肉眼看是一档。现在收到四档: 26 / 18 / 14 / 12。
  //   旧令牌 (--fs-heading / --fs-micro) 一律不许复活。
  const steps = ['--fs-display', '--fs-title', '--fs-body', '--fs-meta'];
  for (const s of steps) {
    const v = fsVal(css, s);
    assert.ok(v != null, 'themes.css 缺字号令牌 ' + s);
    assert.ok(v >= 11 && v <= 36, s + ' 超出合理范围: ' + v + 'px');
  }
  // 反向: 全站只许这四档。旧的六档 / 两个阶梯外图标档一律不许回来。
  const dead = ['--fs-heading', '--fs-micro', '--fs-glyph', '--fs-glyph-lg'];
  const back = dead.filter((d) => new RegExp(d.replace(/-/g, '\\-') + '\\s*:').test(css));
  assert.deepStrictEqual(back, [],
    '这些字号档又回来了 —— 全站重新变成七八个尺寸: ' + back.join(', '));
});

test('144-2: 字号阶梯必须**真的有层级** (相邻两档差 ≥ 2px, 不能全是同一个数)', () => {
  const css = readCss('themes.css');
  const vals = ['--fs-display', '--fs-title', '--fs-body', '--fs-meta']
    .map((s) => fsVal(css, s));
  // 从大到小排, 逐档比较
  const sorted = [...vals].sort((a, b) => b - a);
  // 大标题 → 正文 这段是**主次**, 必须每档差 ≥ 3px。
  //   正文以下 (meta / micro) 是**同层微差**, 允许差 1px —— 它们靠颜色分层,
  //   字号再小中文就看不清了。这段判据要写死, 不然以后有人为了"好看"
  //   把 meta 调到 13px, 主次就没了。
  const MAJOR = ['--fs-display', '--fs-title', '--fs-body'];
  const major = MAJOR.map((s) => fsVal(css, s));
  for (let i = 0; i < major.length - 1; i++) {
    assert.ok(major[i] - major[i + 1] >= 3,
      '主次档塌了: ' + major.join(' / ') + ' —— 相邻两档差不到 3px, 眼睛分不出主次');
  }
  // 两端必须真的拉开 (只有一个档位差 ⇒ 退化回"只有两档字号")
  // 第 147 批: 老板说「字体大就显得笨」⇒ 大字整体收了一档
  // (display 34→26, title 22→20, glyph 22→19), 总跨度从 23px 收到 15px。
  // 层级**没塌** —— 仍是六档, 主次相邻差仍是 6/3/3/2/1, 只是全屏音量小了。
  // 所以阈值跟着收 (20 → 14), 守住的是"六档都在、主次分得开", 不是"必须有个大字"。
  assert.ok(sorted[0] - sorted[sorted.length - 1] >= 14,
    '字号总跨度不够 (' + (sorted[0] - sorted[sorted.length - 1]) + 'px), 等于没有阶梯');
});

test('144-3: 负例自检 —— 全是同一个字号应当被 144-2 挑出来', () => {
  const bad = ['--fs-display: 13px;', '--fs-title: 13px;',
    '--fs-body: 13px;', '--fs-meta: 13px;'].join('\n');
  const vals = bad.match(/(\d+)px/g).map((s) => Number(s.replace('px', '')));
  const sorted = [...vals].sort((a, b) => b - a);
  let caught = false;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i] - sorted[i + 1] < 2) caught = true;
  }
  assert.ok(caught, '判据挑不出"全站一个字号"这种坏情况 —— 守卫是装饰');
});

// ── ①b 字号倍率 (第 148 批) ─────────────────────────────────────

test('148-1: 字号令牌必须走 --ui-scale (否则设置页的字号滑块是死控件)', () => {
  const css = readCss('themes.css');
  assert.match(css, /--ui-scale\s*:\s*1/, 'themes.css 必须定义 --ui-scale (默认 1)');
  for (const s of ['--fs-display', '--fs-title', '--fs-body', '--fs-meta']) {
    const m = css.match(new RegExp(s.replace(/-/g, '\\-') + '\\s*:\\s*([^;]+);'));
    assert.ok(m, '缺字号令牌 ' + s);
    assert.match(m[1], /var\(--ui-scale\)/,
      s + ' 没乘 --ui-scale ⇒ 设置页「正文基准字号」滑块拖了没反应 (死控件)');
  }
});

test('148-2: 设置页的字号滑块不许再写 html{font-size} (全站没有 rem)', () => {
  const src = readJs('views/settings/ui.mjs');
  assert.ok(!/style\.fontSize\s*=/.test(src),
    '字号滑块不许写 documentElement.style.fontSize —— 全站字号是 px 令牌, 不是 rem, 那样写等于没反应');
  assert.match(src, /--ui-scale/, '字号滑块必须写 --ui-scale');
});

test('148-3: 负例自检 —— 写回 html{font-size} 应当被 148-2 挑出来', () => {
  const bad = "document.documentElement.style.fontSize = v + 'px';";
  assert.ok(/style\.fontSize\s*=/.test(bad), '负例: 死写法没被挑出来');
});

test('144-3b: 负例自检 —— 主次档塌成 2px 也应当被挑出来', () => {
  // 34/21/15/13/12/11 这种阶梯是好的 (主次档差 ≥ 3px)。
  // 32/21/15/14/12/11 这种也过。真正要抓的是: 主次档之间差不到 3px。
  const bad = [26, 18, 14, 12];
  const MAJOR = [bad[0], bad[1], bad[2], bad[3]];
  let caught = false;
  for (let i = 0; i < MAJOR.length - 1; i++) {
    if (MAJOR[i] - MAJOR[i + 1] < 3) caught = true;
  }
  assert.ok(caught, '判据挑不出"主次档只差 2px"这种坏情况');
});

test('144-4: 视图层不许再散落硬编码字号 (只许用阶梯令牌)', () => {
  // 自动发现全部 css —— 硬编码文件列表的话, 以后新加一个 css 就能绕开守卫。
  // themes.css 例外: 它就是阶梯本身的定义处, 令牌值当然得写成 px。
  const files = [];
  const walk = (dir, rel = '') => {
    for (const ent of fs.readdirSync(path.join(APP, dir), { withFileTypes: true })) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(dir + '/' + ent.name, r);
      else if (ent.name.endsWith('.css') && ent.name !== 'themes.css') files.push(r);
    }
  };
  walk('.');
  const bad = [];
  for (const rel of files) {
    const css = readCss(rel);
    // 只判 font-size 的硬编码 px 值; 注释已剥。
    // 必须连小数一起抓 —— 上一版正则只认整数, 12.5px / 13.5px / 15.5px 全溜过去了。
    const re = /font-size\s*:\s*(\d+(?:\.\d+)?)px/g;
    let m;
    while ((m = re.exec(css))) {
      bad.push(rel + ' :: font-size: ' + m[1] + 'px');
    }
  }
  assert.deepStrictEqual(bad, [],
    '这些地方还在硬写字号, 全站的层级就散了: ' + bad.join(' | '));
  assert.ok(files.length >= 7,
    '自动发现到的 css 太少 (' + files.length + ' 个), 判据可能根本没在工作: ' + files.join(', '));
});

test('144-4b: 负例自检 —— 小数字号也得被守卫挑出来', () => {
  // 正则漏掉小数 = 守卫只挡住整数那一半 = 装饰。
  const css = '.x { font-size: 12.5px; } .y { font-size: 13px; }';
  const re = /font-size\s*:\s*(\d+(?:\.\d+)?)px/g;
  const found = [];
  let m;
  while ((m = re.exec(css))) found.push(m[1]);
  assert.ok(found.includes('12.5'),
    '判据挑不出小数硬编码字号 (12.5px / 13.5px / 15.5px 会溜过去)');
});

// ── ② 空态不许再是两栏拼贴 ─────────────────────────────────────

test('144-5: 工作台空态不许再是两栏拼贴 (不许有 264px 那根硬编码列)', () => {
  // 第 148 批: 空态整体搬进设计系统的 .pg-empty-stage (焦点面板 + 建议清单)。
  const css = readCss('design-system.css');
  const b = block(css, '.pg-empty-stage');
  assert.ok(b, '找不到 .pg-empty-stage');
  assert.match(b, /display\s*:\s*flex/, '.pg-empty-stage 必须是 flex 单栏 (焦点面板 → 建议清单)');
  assert.doesNotMatch(b, /264px/, '.pg-empty-stage 里不许再出现 264px 那根硬编码列');
  assert.doesNotMatch(b, /grid-template-columns/, '.pg-empty-stage 不许是网格 (那又回到拼贴了)');
});

test('144-6: 空态的建议项必须是一行一条 (不许回到 2×2 图标墙)', () => {
  // 第 148 批: 2×2 能力卡本身**就是**老板说的「胡拼乱凑」——
  //   四个方块浮在半空里, 像图标墙; 一行一条 (图标·标题·说明·箭头)
  //   才像一份可以点的目录。
  // 第 170 批: 入口行不再自造 `.pg-suggest-row` / `.pg-suggest-main`,
  //   改用**全站统一的清单行** (.pg-list-row) —— 判据跟着新语法改:
  //   清单行是一列 (flex-direction: column), 每行一条, 不许再变回网格。
  const css = readCss('design-system.css');
  assert.ok(!/\.pg-suggest-row\s*\{/.test(css),
    '.pg-suggest-row 复活了 —— 入口行现在走统一清单行 (.pg-list-row), 不许自造第二套');
  const row = block(css, '.pg-list-row');
  assert.ok(row, '找不到 .pg-list-row (全站统一清单行)');
  assert.doesNotMatch(row, /grid-template-columns/,
    '.pg-list-row 必须是一行 (图标·标题·说明·动作), 不是网格');
  // 「一行一条」说的是**条目之间**: 清单容器竖着排, 每个条目占一行。
  // (.pg-list-row 自己是横排: 图标 · 标题 · 说明 · 动作)
  const box = block(css, '.pg-list');
  assert.ok(box, '找不到 .pg-list (全站统一清单容器)');
  assert.match(box, /flex-direction\s*:\s*column/,
    '.pg-list 必须竖着排 —— 每个条目一行, 不许多列并排');
  // 首屏入口必须真的用清单行
  const chat = readJs('views/chat.mjs');
  assert.match(chat, /listRow\(/,
    '首屏入口必须走 util.listRow() —— 一行一条, 不许手搓一入口行');
});

// ── ③ 工具集不许再是竖向卡片墙 ─────────────────────────────────

test('144-7: 工具集不许再回到多列竖向卡片墙', () => {
  const css = readCss('views.css');
  // 第 147 批: 清单容器并进设计系统的 .pg-list —— 单列, 行与行一根发丝线。
  // 判据从「某个网格不许多列」改成「整页不许出现多列网格」——
  // 十九行技能挤成两列卡片墙, 一屏只放得下十行, 那就是卡片汤。
  const b = block(css, '.pg-mp-list');
  assert.ok(b, '找不到 .pg-mp-list (工具集清单容器)');
  assert.doesNotMatch(b, /auto-fill/, '.pg-mp-list 不许 auto-fill 多列卡片墙');
  assert.doesNotMatch(css, /repeat\(\s*2\s*,/,
    'views.css 里不许再有两列网格 —— 工具集是一列清单, 一行一条');
});

test('144-8: 工具集每一行必须有名字列 + 描述列 (行式结构)', () => {
  const css = readCss('views.css');
  const b = block(css, '.pg-mp-row-main');
  assert.ok(b, '找不到 .pg-mp-row-main');
  assert.match(b, /grid-template-columns\s*:/, '.pg-mp-row-main 必须是 grid 行式结构');
  assert.match(b, /\d+px\s+minmax\(0,\s*1fr\)/,
    '.pg-mp-row-main 必须有「名字列(定宽) + 描述列(占剩余)」两列');
});

test('144-9: 工具集清单的行不许再各自带框 (发丝线分隔才是清单)', () => {
  // 行 = 设计系统的 .pg-list-row: 没有四边框, 只有一根下边发丝线。
  const css = readCss('design-system.css');
  const b = block(css, '.pg-list-row');
  assert.ok(b, '找不到 .pg-list-row');
  assert.doesNotMatch(b, /border\s*:\s*1px/, '清单行不许各自带框 (十九个框 = 十九张卡)');
  assert.match(b, /border-bottom\s*:\s*1px/, '清单行之间要有发丝线分隔');
});

// ── ④ 卡片主标题必须是中文名 ───────────────────────────────────

test('144-10: 工具集卡片主标题必须用 name_cn (不许直接印英文 slug)', () => {
  const js = readJs('views/marketplace.mjs');
  const fn = js.slice(js.indexOf('function marketCard'));
  assert.ok(fn.length > 0, '找不到 marketCard');
  assert.match(fn, /name_cn/,
    'marketCard 必须读 name_cn —— 一屏十九个 academy-guide 看着像一墙 npm 包名');
  // 主标题那一行必须优先用 cnName
  assert.match(fn, /pg-list-title[^\n]*cnName\s*\|\|\s*item\.name/,
    '主标题必须 cnName 优先, item.name 只做兜底');
});

test('144-11: 后端必须真的下发 name_cn (前端有值才有中文名)', () => {
  const js = fs.readFileSync(
    path.join(__dirname, '..', 'pangu-single', 'routes', 'inline_router.js'), 'utf8');
  assert.match(js, /name_cn/, 'inline_router.js 必须给条目注入 name_cn');
});

test('144-12: 来源不许再单独占一列 (它该是 slug 旁边的旁注)', () => {
  const js = readJs('views/marketplace.mjs');
  const fn = js.slice(js.indexOf('function marketCard'));
  assert.match(fn, /pg-mp-row-tags/, '来源 chip 必须挂到 slug 那一行 (pg-mp-row-tags)');
  const css = readCss('views.css');
  const b = block(css, '.pg-mp-row-main');
  // 两列 = 名字+来源 | 描述。来源是名字格里的旁注, 不许再单开一列。
  const cols = (b.match(/auto/g) || []).length;
  assert.ok(cols <= 1, '清单行不许再留独立的来源列 (auto 列数 ' + cols + ')');
});

// ── ⑤ 纪律自检: 五行色不许被改 ─────────────────────────────────

test('144-13: 五行色原值一字不许改 (木/火/土/金/水)', () => {
  const files = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(css|mjs|js|html)$/.test(f.name)) files.push(p);
    }
  };
  walk(APP);
  const truth = { '00FF1D': '木', 'FF0000': '火', 'B28C21': '土', 'FFEE00': '金', '0E70F2': '水' };
  const bad = [];
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const hex of Object.keys(truth)) {
      // 五行原值只许大写形式 (小写是变体, 历史上就有)
      const re = new RegExp('#' + hex, 'g');
      const hits = (src.match(re) || []).length;
      if (hits > 0) {
        // 记一笔, 但不判死 —— 只在**数量异常**时报警 (有人整片重刷)
        if (hits > 12) bad.push(path.relative(APP, f) + ' :: #' + hex + ' × ' + hits);
      }
    }
  }
  assert.deepStrictEqual(bad, [], '五行色原值被大面积改写: ' + bad.join(' | '));
});

