'use strict';
/**
 * tests/ui-type-system-20261030.test.js
 *
 * 第 169 批守卫 —— 「盘古的中文用哪两个字」
 *
 * ── 起因 ─────────────────────────────────────────────────────
 *   老板连说三遍「我说的字体，字体！」(10-30)。前两批 (166/168) 我一直在改
 *   **布局**, 字体一个字节没动 —— 他说的不是字号、不是字重, 是**字族本身**。
 *
 *   查下来真正的问题不是「字体太多」(167 批已经把家族收到三个角色了), 而是:
 *
 *   ① **宋体 (Songti SC) 当了身份字**, 于是每个卦格里都是「宋体卦名 + 黑体
 *      序号/五行」两种中文字体撞在一起; 而且宋体在 18–26px 屏上又薄又旧气 ——
 *      这是「不上档次」的真正来源。
 *   ② 角色没分开: **名字** (卦名/干支/盘古) 和 **经文** (卦辞/爻辞) 用了同一套
 *      宋体, 于是「标签」和「文章」分不开。
 *
 * ── 口径 (三个角色, 两个中文字) ───────────────────────────────
 *   界面字 --font-ui    苹方: 一切界面字、标签、**卦名**、干支、数字、表格。
 *                       名字是标签, 不是文章 ⇒ 用界面字 + 600 字重立住。
 *   经文字 --font-script 楷体: 只出现在**盘古说话的地方** —— 成段经文
 *                       (卦辞/象辞/爻辞) 和盘古自己的名字 (品牌/首屏大字)。
 *   技术字 --font-mono  等宽: 代码 / 路径 / 参数 / 命令。
 *
 * ── 判据 ─────────────────────────────────────────────────────
 *   ① 三个令牌齐, 不许多第四个;
 *   ② 界面字栈里**不许**混进任何宋体/楷体/明朝 (界面字必须纯黑体系);
 *   ③ 经文字栈的**首选**字族不许是宋体 (宋体只配当兜底, 不配当主角);
 *   ④ 经文字**白名单制**: var(--font-script) 只许出现在登记过的位置上 ——
 *      这条是角色分界的**机制**, 不是注释。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'web', 'app');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const readCss = (rel) => stripComments(fs.readFileSync(path.join(APP, rel), 'utf8'));

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

/** 取 themes.css 里某个字体令牌的值 (一段字体栈)。 */
function fontStack(token) {
  const css = readCss('themes.css');
  const m = new RegExp(token.replace(/[-]/g, '\\-') + '\\s*:\\s*([^;]+);').exec(css);
  return m ? m[1].trim() : '';
}

test('169-1: 三个字体令牌必须齐 (界面字 / 经文字 / 技术字)', () => {
  for (const t of ['--font-ui', '--font-script', '--font-mono']) {
    assert.match(readCss('themes.css'), new RegExp(t.replace(/[-]/g, '\\-') + '\\s*:'),
      'themes.css 少了字体令牌 ' + t);
  }
});

test('169-1b: 全站不许引用未定义的字体令牌 (--font-serif / --font-display 等)',
  () => {
    // 机制: 令牌只有三个, 谁引用了第四个 = 引用了一个**不存在**的变量
    // ⇒ 浏览器静默回退到系统默认字体 ⇒ 那一块的字体就"又不一样了"。
    // 这正是老板骂「字体还是乱」的机制来源, 所以钉死。
    const WEB = path.join(__dirname, '..', 'web');
    const files = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/\.(css|html|mjs|js)$/.test(ent.name)) files.push(p);
      }
    };
    walk(WEB);
    const allowed = new Set(['--font-ui', '--font-script', '--font-mono']);
    const bad = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/var\(\s*(--font-[a-z0-9-]+)/gi)) {
        if (!allowed.has(m[1])) {
          bad.push(path.relative(WEB, f) + ' :: ' + m[1]);
        }
      }
    }
    assert.deepStrictEqual([...new Set(bad)], [],
      '引用了不存在的字体令牌 ⇒ 那块字静默回退成系统默认字体, '
      + '页面里就会「突然冒出另一种字体」: ' + bad.join(' | '));
  });

test('169-2: 界面字栈里不许混进宋体/楷体/明朝 (界面字必须纯黑体系)', () => {
  const stack = fontStack('--font-ui');
  const banned = ['Songti', 'STSong', 'Kaiti', 'STKaiti', 'KaiTi', 'Mincho', 'SimSun', '楷体'];
  const hit = banned.filter((b) => stack.includes(b));
  assert.deepStrictEqual(hit, [],
    '界面字栈里混进了 ' + hit.join(', ') + ' —— 界面字跟经文字撞脸, '
    + '「同一个格子里两种中文字体」就是这么来的: ' + stack);
});

test('169-3: 经文字的首选字族不许是宋体 (宋体只配当兜底)', () => {
  const stack = fontStack('--font-script');
  const first = stack.split(',')[0].replace(/["']/g, '').trim();
  assert.ok(first && !/Songti|STSong|SimSun/i.test(first),
    '经文字的首选字族是宋体 (' + first + ') —— 宋体薄、旧气, 当主角就是「不上档次」: ' + stack);
  assert.ok(/Kai/i.test(first),
    '经文字首选字族不是楷体 (' + first + ') —— 经文没有手写的温度: ' + stack);
});

/**
 * 经文字白名单 —— 想让某个位置变成「经文」, 得先在这里登记一句人话。
 * 登记本身是解释, 改表的人会看见自己在干什么。
 */
const SCRIPT_ALLOW = [
  // 盘古自己的名字
  '.pg-open-word b',          // 首屏大字「推演从一言始」
  '.pangu-brand-copy strong', // 侧栏品牌「盘古」
  // 成段经文
  '.pg-hex-ci',               // 卦辞
  '.pg-hex-xiang',            // 象辞
  '.pg-hex-yao-sec',          // 爻辞表
  '.pg-hex-d-mark',           // 五行印章 (一枚真印)
  '.mh-ci',                   // 梅花卦辞
  '.mh-moving-ci',            // 梅花动爻辞
];

test('169-4: 经文字只许出现在白名单位置 (白名单制)', () => {
  const bad = [];
  for (const rel of CSS_FILES) {
    const css = readCss(rel);
    for (const sel of selectorsWith(css, 'font-family: var(--font-script)')) {
      const ok = SCRIPT_ALLOW.some((w) => sel.includes(w));
      if (!ok) bad.push(rel + ' :: ' + sel);
    }
  }
  assert.deepStrictEqual(bad, [],
    '这些位置挂了经文字 —— 经文只能出现在「盘古说话的地方」: ' + bad.join(' | '));
});

test('169-4b: 负例自检 —— 白名单外挂经文字得被挑出来', () => {
  const sels = selectorsWith('.pg-hex-nm { font-family: var(--font-script); }',
    'font-family: var(--font-script)');
  assert.strictEqual(sels.length, 1);
  const ok = SCRIPT_ALLOW.some((w) => sels[0].includes(w));
  assert.ok(!ok, '判据挑不出「卦名挂经文字」这种坏情况');
});

test('169-5: 卦名这类「名字」必须走界面字 (不许挂经文字)', () => {
  const css = readCss('views/hexagrams.css');
  // 只认「真的声明了 font-family 的那条 .pg-hex-nm 规则」
  const nm = (css.match(/\.pg-hex-nm\s*\{[^}]*font-family[^}]*\}/) || [''])[0];
  assert.match(nm, /font-family:\s*var\(--font-ui\)/,
    '卦名 (盘上 64 个字) 必须走界面字 —— 名字是标签, 靠 600 字重立住, 不靠换字体');
  assert.match(nm, /font-weight:\s*600/,
    '卦名必须 600 —— 苹方 400 在 18px 上立不住, 卦名会退回「配角」');
});

test('169-6: 守卫本身得在工作 (自动发现的 css 不能太少)', () => {
  assert.ok(CSS_FILES.length >= 8, '自动发现到的 css 太少: ' + CSS_FILES.join(', '));
  assert.ok(VIEW_FILES.length >= 7, '视图层 css 太少: ' + VIEW_FILES.join(', '));
});
