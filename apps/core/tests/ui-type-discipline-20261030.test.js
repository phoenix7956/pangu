'use strict';
/**
 * tests/ui-type-discipline-20261030.test.js
 *
 * 第 167 批守卫 —— 「别再多一档字号 / 别再多一张脸」
 *
 * ── 起因 ─────────────────────────────────────────────────────
 *   老板说「字号阶梯彻底定死: 30/21/17/14/12/11, 太多了」+「字体也太多了」。
 *   查下来全站并存**八个**尺寸 (六档阶梯 + 两个阶梯外的图标档 20/26),
 *   三个字体家族每屏同时出现, 而且中文读数被塞进等宽字体 ——
 *   SF Mono 没有汉字 ⇒ 一行里字宽参差, 看着就是「字体乱套」。
 *
 *   所以这一批不是加令牌, 是**减法**:
 *     字号 6 档 → 4 档 (26 / 18 / 14 / 12)
 *     字体 3 家族 → 每屏最多两张脸
 *       · sans  = 正文 / UI
 *       · serif = 卦名 / 爻辞 / 干支 (盘古的身份字)
 *       · mono  = **只许**真技术位 (代码 / diff / 路径 / 参数 / 版本号)
 *
 * ── 判据 ─────────────────────────────────────────────────────
 *   ① 全站 font-size: Npx 的字面值必须 ⊆ {26, 18, 14, 12}
 *      —— 这条直接抓住「又多了一档」。
 *   ② 等宽字体只许出现在**白名单**的技术位选择器上。
 *      白名单外的位置用等宽 ⇒ 判死 (中文回退参差就是这么来的)。
 *
 * ── 纪律 ─────────────────────────────────────────────────────
 *   判据只看**声明**, 不看注释; 每条都带负例自检。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'web', 'app');
const { stripComments } = require('./helpers/strip-comments.js');

function allCssFiles() {
  const out = [];
  const walk = (rel) => {
    const dir = path.join(APP, rel);
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(rel + '/' + ent.name, r);
      else if (ent.name.endsWith('.css')) out.push(r);
    }
  };
  walk('.');
  return out;
}

const CSS_FILES = allCssFiles();
const VIEW_FILES = CSS_FILES.filter((f) => f !== 'themes.css');
const readCss = (rel) => stripComments(fs.readFileSync(path.join(APP, rel), 'utf8'));

// themes.css 里定义阶梯本身, 令牌值当然得写成 px —— 它是**唯一**豁免。
const ALLOWED_PX = new Set([26, 18, 14, 12]);

test('167-1: 全站字号字面值必须 ⊆ {26, 18, 14, 12} (不许再多一档)', () => {
  const bad = [];
  for (const rel of CSS_FILES) {
    const css = readCss(rel);
    const re = /font-size\s*:\s*(\d+(?:\.\d+)?)px/g;
    let m;
    while ((m = re.exec(css))) {
      const v = Number(m[1]);
      if (!ALLOWED_PX.has(v)) bad.push(rel + ' :: font-size: ' + m[1] + 'px');
    }
  }
  assert.deepStrictEqual(bad, [],
    '这些字号不在四档阶梯里 —— 全站又变回七八个尺寸: ' + bad.join(' | '));
});

test('167-1c: 四档字号在 themes.css 里必须真的定义了 (不许有死档)', () => {
  const css = readCss('themes.css');
  for (const v of ALLOWED_PX) {
    assert.ok(new RegExp('--fs-[a-z-]+\\s*:\\s*calc\\(' + v + 'px').test(css),
      'themes.css 里没有 ' + v + 'px 这一档 —— 阶梯表和实际用值对不上');
  }
});

test('167-1b: 负例自检 —— 第 5 档字号得被 167-1 挑出来', () => {
  const css = '.a { font-size: 15px; } .b { font-size: 26px; }';
  const re = /font-size\s*:\s*(\d+(?:\.\d+)?)px/g;
  const found = [];
  let m;
  while ((m = re.exec(css))) found.push(Number(m[1]));
  assert.ok(found.some((v) => !ALLOWED_PX.has(v)),
    '判据挑不出「又多一档 15px」这种坏情况');
});

// ── 等宽字体的白名单 (第 167 批) ─────────────────────────────────

/**
 * 等宽只许出现在这些**真技术位**。
 * 判据是**白名单制**而不是黑名单制: 默认禁, 要用等宽必须在这里显式登记。
 * 登记本身是一句人话 (代码块 / diff / 路径 / 参数 / 版本号),
 * 下次有人想把等宽铺到中文读数上, 得先改这张表 —— 改表的人会看见理由。
 */
const MONO_ALLOW = [
  // 代码 / 预格式
  'code', 'kbd', 'samp', 'pre', '.md-pre', '.md-root code', '.pre',
  // diff (逐行对齐必须等宽)
  '.pg-diff-line', '.pg-diff-head',
  // 工具调用参数 (JSON)
  '.pg-toolcall-params', '.pg-toolcall-title', '.pg-plan-tool',
  // 行内命令 / 模型 id / 节点地址
  '.pg-mp-row-cmd', '.pg-model-item-endpoint', '.pg-node-addr',
  // 显式标记成技术位的元素 (调用方自己声明的)
  '.mono', '.pg-mono', '.pg-table td.mono', '.pg-kv-v.mono',
];

/** 取一条声明块所在的**选择器**。 */
function selectorsWith(css, needle) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[2].includes(needle)) {
      for (const sel of m[1].split(',')) {
        const s = sel.trim();
        if (s && !s.startsWith('@')) out.push(s);
      }
    }
  }
  return out;
}

test('167-2: 等宽字体只许出现在真技术位 (白名单制)', () => {
  const bad = [];
  for (const rel of CSS_FILES) {
    const css = readCss(rel);
    for (const sel of selectorsWith(css, 'font-family: var(--font-mono)')) {
      const ok = MONO_ALLOW.some((w) => sel.includes(w));
      if (!ok) bad.push(rel + ' :: ' + sel);
    }
  }
  assert.deepStrictEqual(bad, [],
    '等宽字体用在了非技术位 —— 中文没有等宽字形, 回退后一行里字宽参差: '
    + bad.join(' | '));
});

test('167-2b: 负例自检 —— 中文读数位用等宽得被 167-2 挑出来', () => {
  const css = '.pg-open-rail-v { font-family: var(--font-mono); }';
  const sels = selectorsWith(css, 'font-family: var(--font-mono)');
  assert.ok(sels.length === 1, '判据连选择器都没抓到');
  const ok = MONO_ALLOW.some((w) => sels[0].includes(w));
  assert.ok(!ok, '判据挑不出「中文读数位用等宽」这种坏情况');
});

test('167-3: 三个字体令牌必须齐 (界面字 / 经文字 / 技术字), 不许多第四个', () => {
  const css = readCss('themes.css');
  for (const t of ['--font-ui', '--font-script', '--font-mono']) {
    assert.ok(new RegExp(t.replace(/-/g, '\\-') + '\\s*:').test(css),
      'themes.css 少了字体令牌 ' + t);
  }
  const declared = [...css.matchAll(/(--font-[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
  const extra = [...new Set(declared)]
    .filter((d) => !['--font-ui', '--font-script', '--font-mono'].includes(d));
  assert.deepStrictEqual(extra, [],
    '多出了第四张脸 —— 全站的字体风格会越走越多: ' + extra.join(', '));
});

test('167-4: 守卫本身得在工作 (自动发现的 css 不能太少)', () => {
  assert.ok(CSS_FILES.length >= 8,
    '自动发现到的 css 太少 (' + CSS_FILES.length + ' 个): ' + CSS_FILES.join(', '));
  assert.ok(VIEW_FILES.length >= 7, '视图层 css 太少: ' + VIEW_FILES.join(', '));
});
