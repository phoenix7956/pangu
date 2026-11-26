'use strict';
/**
 * tests/grid-scroll-card-collapse-20261029.test.js
 *
 * 第 142 批守卫 —— 「可滚动网格里的卡片不许塌成一条线」
 *
 * ── 起因 (实测, 不是理论) ────────────────────────────────────
 *   「工具集」整页 37 张 skill 卡全塌成 2px 横条, 看着像一堆没加载出来的占位。
 *   根因是**两个 CSS 特性叠在一起**:
 *
 *   ① .pg-card 有 `overflow: hidden`
 *      ⇒ 它作为 grid item 时, automatic minimum size (min-height: auto) 被算成 **0**;
 *   ② .pg-mp-grid 自己是 `overflow-y: auto` 的滚动容器
 *      ⇒ 给 auto 轨道分配的可用空间是 **0**
 *      ⇒ 轨道停在 base size (0 + 卡片 margin-bottom) ⇒ 卡片被压成 0 高。
 *
 *   实测对照 (同一张卡): overflow: visible ⇒ 154.78px 正常;
   overflow: hidden + 默认 auto 轨道 ⇒ 10.05px (塌)。
 *
 * ── 判据 (机器判据, 不看注释) ────────────────────────────────
 *   CSS 里任何「display:grid + overflow(-y):auto」的滚动容器,
 *   都必须显式声明 `grid-auto-rows`, 且值不是 auto ——
 *   否则它的卡片就会按上面的机制塌掉。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'web', 'app');

function cssFiles(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) out.push(...cssFiles(p));
    else if (f.name.endsWith('.css')) out.push(p);
  }
  return out;
}

// 判据只看声明, 不看注释 —— 注释里常写着「不许 xxx」, 全文匹配会咬自己一口。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

test('142-1: 可滚动网格必须显式声明 grid-auto-rows (否则卡片塌成 2px)', () => {
  const bad = [];
  for (const file of cssFiles(APP)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const blocks = src.split('}');
    for (const raw of blocks) {
      const block = raw.trim();
      if (!block) continue;
      const isGrid = /(^|[\s;{])display\s*:\s*grid[\s;]/.test(block + '}');
      const isScroll = /overflow(-y)?\s*:\s*auto/.test(block);
      if (!isGrid || !isScroll) continue;
      const rows = block.match(/grid-auto-rows\s*:\s*([^;]+)/);
      if (!rows) {
        bad.push(path.relative(APP, file) + ' :: ' + block.split('\n')[0].slice(0, 60));
        continue;
      }
      const val = rows[1].trim().toLowerCase();
      if (val === 'auto' || val === 'min-content' || val === 'fit-content') {
        bad.push(path.relative(APP, file) + ' :: grid-auto-rows: ' + val + ' (轨道还是会塌)');
      }
    }
  }
  assert.deepStrictEqual(bad, [], '这些可滚动网格没给行尺寸, 卡片会塌: ' + bad.join(' | '));
});

test('142-2: 工具集是**单列清单** (第 147 批: 37 张卡塌成两列卡片墙, 改成一列)', () => {
  // 判据跟着画法走: 第 142 批治的是「可滚动网格里卡片塌成 2px」,
 //   第 147 批把工具集整个从网格改成**一列清单** (`.pg-mp-list`) ——
 //   网格的塌陷机制 (min-height:auto 被 overflow:hidden 算成 0) 压根不存在了。
  //   所以这里改成钉住新事实: 工具集不许再是多列网格。
  const css = stripComments(fs.readFileSync(path.join(APP, 'views.css'), 'utf8'));
  assert.ok(/\.pg-mp-list\b/.test(css), '找不到 .pg-mp-list (工具集清单容器)');
  assert.doesNotMatch(css, /\.pg-mp-grid\b/,
    '工具集不许再有多列卡片墙 (.pg-mp-grid) —— 一行一条才是清单');
});

test('142-3: 清单行不叠 margin-bottom (间距靠行分隔线)', () => {
  // 原 bug 是「37 张卡塌成 2px 横条」—— 今天虽然换成了清单,
  //   但同一个病根还在: 行本身没有内容高度 (min-height:auto 被算成 0)。
  //   ⇒ 行必须有上下内边距, 且行距只靠发丝线, 不许再叠 margin。
  const css = stripComments(fs.readFileSync(path.join(APP, 'design-system.css'), 'utf8'));
  const m = css.match(/\.pg-list-row\s*\{([^}]*)\}/);
  assert.ok(m, '找不到 .pg-list-row');
  assert.match(m[1], /padding\s*:\s*[^;]*\d/, '.pg-list-row 必须有上下内边距 (否则行会塌成一条线)');
  assert.doesNotMatch(m[1], /margin-bottom/, '.pg-list-row 不许叠 margin-bottom (行距靠 border-bottom)');
});

