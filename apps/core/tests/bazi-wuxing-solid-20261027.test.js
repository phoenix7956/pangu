'use strict';

// 2026-10-27 (第 128 批): 八字排盘 —— 五行是**字色**, 不铺色块、不用框
//
// 老板 10-27 连着三句:
//   「这颜色很清楚, 但是感觉有点怪」   ← 满屏饱和色块像荧光贴纸
//   「块乱了」 + 「不用块直接用颜色的字」← 块一多就乱, 要字色
//   「不要用框, 实线虚线都不要」        ← 喜忌档位的框也不要了
//
// **课件原件就是这么画的** (已核对):
//   《喜用忌必查詢表》表头 = 色块; **正文 = 粗体彩字, 白底, 不铺块**
//   《排盘样例》: 天干/地支/藏干/纳音全是**彩字 + 同色材质图标**, 一个框都没有
//
// 本批口径 (老板最后拍板版):
//   --xxx     五行色 = 老板在课件上采的五原值 (唯一真源, 一个字都不许改)
//   --xxx-ink **字色** = **同一组五原值**, 三套主题完全一致。
//              老板 10-27 把字色打回过两次, 最后原话:
//              「木 #00FF1D / 火 #FF0000 / 土 #B28C21 / 金 #FFEE00 / 水 #0E70F2。
//               全都按这个, 别搞了」
//              ⇒ 我自己发明的变体 (压暗的 #0F9E38/#7A4A1E/#B8860B、
//                课件实测的 #12E23D/#846E0B/#E49411) 全部作废。
//              ⚠ 浅色卡底上木 1.33:1 / 金 1.17:1 —— 老板知情拍板,
//                课件《喜用忌必查詢表》《排盘样例》自己就这么画 (艳色压浅底)。
//   五行元素: 文字色 = --xxx-ink, **背景必须透明** (不许再有色块)
//   喜忌档位: **不用框** —— 课件排盘表里也没有, 档位信息留在「五行与喜忌」那行
//
// 实测 (老板原值): 五行两两 ΔE 最小 50.0 (土-金) —— 土金只差 12° 色相,
//   靠明度分开 (土 #B28C21 暗 / 金 #FFEE00 亮), 一眼分得开。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const H = require('./helpers/wuxing_color.js');

const PILLARS = path.join(H.WEB, 'lib', 'bazi', 'pillars.mjs');
const BAZI_MJS = path.join(H.WEB, 'views', 'bazi.mjs');

const css = fs.readFileSync(H.BAZI_CSS, 'utf8');
const themes = fs.readFileSync(H.THEMES, 'utf8');
const mjs = fs.readFileSync(BAZI_MJS, 'utf8');

test('128w-1: 三套主题的五行色板 = 老板采的五原值 (不许悄悄漂)', () => {
  const sets = H.themeWxVars(themes);
  assert.ok(sets.length >= 3, '至少要认出三套主题, 实际 ' + sets.length);
  for (const set of sets) {
    for (const w of H.NAMES) {
      assert.strictEqual(set[w].toUpperCase(), H.BOSS[w].toUpperCase(),
        '主题 ' + set.__theme + ' 的 ' + w + ' 是 ' + set[w]
        + ', 老板在课件上采的是 ' + H.BOSS[w]);
    }
  }
});

test('128w-2: 字色档 (--xxx-ink) 必须存在, 且跟本色同色系', () => {
  for (const set of H.themeWxVars(themes)) {
    for (const w of H.NAMES) {
      assert.ok(set.__ink[w], '主题 ' + set.__theme + ' 缺 --' + H.WX_VAR[w] + '-ink');
      // 同色系: 色相差 ≤ 18°。土/金老板那两色只差 12°, 分不开; 课件自己也是靠
      // 明度分的 (土 #7C6B12 深 / 金 #DE9728 亮), 顺带把色相挪十几度当「土的褐」。
      // 真正的「分得开」由 ΔE 那两条守 (土金 ≥ 30)。
      const dh = Math.abs(H.hue(set.__ink[w]) - H.hue(set[w]));
      const dh2 = Math.min(dh, 360 - dh);
      assert.ok(dh2 <= 18,
        '主题 ' + set.__theme + ': ' + w + ' 的字色 ' + set.__ink[w]
        + ' 跟本色 ' + set[w] + ' 色相差了 ' + dh2.toFixed(1) + '° (≤ 18° 才算同一个色)');
    }
  }
});

test('128w-3: 五行字色 = 老板采的五原值 (老板: 全都按这个, 别搞了)', () => {
  for (const set of H.themeWxVars(themes)) {
    for (const w of H.NAMES) {
      // ⚠ 这一条原来是「字色对卡底 ≥ 3:1」—— 老板 10-27 把字色打回过两次,
      //   最后拍板: 「木 #00FF1D / 火 #FF0000 / 土 #B28C21 / 金 #FFEE00 / 水 #0E70F2。
      //   **全都按这个, 别搞了**」。
      //   浅色卡底上木 1.33:1 / 金 1.17:1 —— 老板知情拍板 (课件自己就这么画:
      //   艳色压浅底, 大号粗体字)。**不许再自作主张压暗/提亮**。
      assert.strictEqual(set.__ink[w].toUpperCase(), H.BOSS[w].toUpperCase(),
        '主题 ' + set.__theme + ': ' + w + ' 字色 ' + set.__ink[w]
        + ' 必须等于老板采的 ' + H.BOSS[w]);
    }
  }
});

test('128w-4: **不许再有五行色块** —— 五行元素不许铺五行色底', () => {
  // 结构上的证明: bazi.css 里五行底色一条都不许有。
  for (const w of H.NAMES) {
    const v = H.WX_VAR[w];
    assert.ok(!new RegExp('background:\\s*var\\(--' + v + '\\)').test(css),
      'bazi.css 里不许再出现 background: var(--' + v + ') —— 五行改成字色了, 不铺块');
    assert.ok(!new RegExp('background:\\s*var\\(--wx\\)').test(css),
      'bazi.css 里不许再出现 background: var(--wx) —— 五行改成字色了, 不铺块');
  }
  const block = H.ruleBody(css, '.bz-wxb');
  assert.ok(!/background/.test(block), '.bz-wxb 不许有底色: ' + block);
});

test('128w-5: 五行字色走 --xxx-ink (字色那一档), 不是 --on-xxx (块上字色)', () => {
  for (const w of H.NAMES) {
    const body = H.ruleBody(css, '.bz-wx-' + w);
    assert.ok(body, '缺 .bz-wx-' + w);
    assert.ok(new RegExp('--wx-ink:\\s*var\\(--' + H.WX_VAR[w] + '-ink\\)').test(body),
      '.bz-wx-' + w + ' 必须定义 --wx-ink 指向 --' + H.WX_VAR[w] + '-ink: ' + body);
    assert.ok(new RegExp('color:\\s*var\\(--' + H.WX_VAR[w] + '-ink\\)').test(body),
      '.bz-wx-' + w + ' 的字色必须走 --' + H.WX_VAR[w] + '-ink: ' + body);
  }
});

test('128w-6: 喜忌档位**不用框** (老板: 不要用框, 实线虚线都不要)', () => {
  // 档位类还挂在元素上, 但**一条样式都不给** —— 连 border-radius 都不给。
  const roleRules = css.match(/\.bz-role-[a-z]+[^{]*\{[^}]*\}/g) || [];
  assert.strictEqual(roleRules.length, 0,
    '.bz-role-* 不许有任何规则 (框/线/底色都不要): ' + roleRules.join(' | '));
  for (const sel of ['.bz-role-xi', '.bz-role-cai', '.bz-role-ji']) {
    assert.strictEqual(H.ruleBody(css, sel), '', sel + ' 不该有规则');
  }
});

test('128w-7: 五行条不许铺色块 (段底必须是中性轨)', () => {
  const bar = H.ruleBody(css, '.bz-bar span');
  assert.ok(bar, '.bz-bar span 规则没了');
  assert.ok(/background:\s*var\(--surface-hover\)/.test(bar),
    '五行条每段底色走中性轨 (--surface-hover), 不许铺五行色: ' + bar);
  for (const w of H.NAMES) {
    const body = H.ruleBody(css, '.bz-g-' + w);
    assert.ok(body, '.bz-g-' + w + ' 规则没了');
    assert.ok(!/background/.test(body), '.bz-g-' + w + ' 不许有底色: ' + body);
    assert.ok(new RegExp('color:\\s*var\\(--' + H.WX_VAR[w] + '-ink\\)').test(body),
      '.bz-g-' + w + ' 的字色必须走 --' + H.WX_VAR[w] + '-ink: ' + body);
  }
});

test('128w-8: 土跟金必须分得开 (课件里就是靠明度分的)', () => {
  for (const set of H.themeWxVars(themes)) {
    const d = H.deltaE(set.__ink.土, set.__ink.金);
    assert.ok(d >= 30,
      '主题 ' + set.__theme + ': 土字色 ' + set.__ink.土 + ' 与 金字色 ' + set.__ink.金
      + ' 的 ΔE 只有 ' + d.toFixed(1) + ' (要 ≥ 30)');
    // 火也要跟土分开 (老板点名过)。
    const dt = H.deltaE(set.__ink.火, set.__ink.土);
    assert.ok(dt >= 30,
      '主题 ' + set.__theme + ': 火字色 ' + set.__ink.火 + ' 与 土字色 ' + set.__ink.土
      + ' 的 ΔE 只有 ' + dt.toFixed(1) + ' (要 ≥ 30)');
  }
});

test('128w-9: 五个五行字色两两都分得开 (ΔE ≥ 25)', () => {
  for (const set of H.themeWxVars(themes)) {
    for (let i = 0; i < H.NAMES.length; i++) {
      for (let j = i + 1; j < H.NAMES.length; j++) {
        const a = H.NAMES[i], b = H.NAMES[j];
        const d = H.deltaE(set.__ink[a], set.__ink[b]);
        assert.ok(d >= 25,
          '主题 ' + set.__theme + ': ' + a + '(' + set.__ink[a] + ') 与 ' + b + '(' + set.__ink[b]
          + ') ΔE 只有 ' + d.toFixed(1) + ' (要 ≥ 25)');
      }
    }
  }
});

test('128w-10: 表里所有五行身份元素都要挂 bz-wxb + bz-wx-<五行>', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  const rows = m.pillarRows(CHART);
  // 2026-11-04 (UI 重写): 天干/地支合并成「干支」行 (bz-gan/bz-zhi 各带 bz-wxb + bz-wx-*)
  for (const label of ['干支', '藏干', '纳音']) {
    const row = rows.find((r) => r.label === label);
    assert.ok(row, '缺行 ' + label);
    for (const cell of row.cells) {
      assert.ok(/bz-wxb/.test(cell), label + ' 少了 bz-wxb: ' + cell);
      assert.ok(/bz-wx-/.test(cell), label + ' 少了 bz-wx-<五行>: ' + cell);
    }
  }
});

test('128w-11: 五行条 / chips / 大运流年 都得是五行字色', () => {
  assert.ok(/bz-g-'\s*\+\s*w\s*\+\s*'\s+bz-wxb/.test(mjs), '五行条每段必须挂 bz-wxb');
  assert.ok(/bz-chip bz-wxb bz-wx-/.test(mjs), 'chips 必须挂 bz-wxb + bz-wx-<五行>');
  assert.ok(/bz-gz-ch bz-wxb/.test(mjs), '大运/流年/流月干支必须挂 bz-wxb');
  // ⚠ 2026-10-31 第 179 批: 神煞整块撤下, 「神煞干支上色」这条断言随 gzWxHtml 一起删了
  //   —— 那段函数是给神煞标签块用的, 标签块没了, 函数也没了。
  //   将来神煞重新放出来时, 这条断言要跟着加回去。
});

test('128w-12: 材质图标跟着字的五行色走 (currentColor)', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  const html = m.wxIconHtml('木');
  assert.ok(html.includes('currentColor'), '材质图标必须用 currentColor 跟着五行色走: ' + html);
});

test('128w-13: 冲合刑害不许占五行色 (一色两义 = 老板说的「分不清」)', () => {
  for (const cls of ['chong', 'he', 'hai', 'xing', 'po']) {
    const body = H.ruleBody(css, '.bz-rels .bz-rel.' + cls);
    assert.strictEqual(body, '',
      '.bz-rel.' + cls + ' 不该有五行色规则 —— 冲合刑害不是五行: ' + body);
  }
});

const CHART = {
  pillars: { '年柱': '己未', '月柱': '戊辰', '日柱': '癸酉', '时柱': '乙卯' },
  day_master: '癸', day_master_wuxing: '水', day_master_yinyang: '阴',
  cang_gan: {
    '年柱': [{ '干': '己', '五行': '土', '十神': '七杀' }],
    '月柱': [{ '干': '戊', '五行': '土', '十神': '正官' }],
    '日柱': [{ '干': '辛', '五行': '金', '十神': '偏印' }],
    '时柱': [{ '干': '乙', '五行': '木', '十神': '食神' }],
  },
  nayin_4: { '年柱': '天上火', '月柱': '大林木', '日柱': '剑锋金', '时柱': '大溪水' },
  xi_yong: ['金', '木', '水'], ji_shell: ['土'], cai_xing: ['火'],
};
