'use strict';
// 2026-10-27 (第 119 批补修五): 五行色不对 + 不带材质
//
// 老板原话: 「你觉得颜色对吗？, 为什么不带上材质？」
//
// 真问题两条:
//   1. 金/土 的色反了 —— 老主题里 金=灰白 (#C2BFC2)、土=金黄 (#D9BA70),
//      传统命理是 土=橄榄褐、金=琥珀金。而且整套是莫兰迪低饱和,
//      老板那张标准四柱表 (传统命书) 用的是高饱和原色, 认不出五行。
//   2. 没有材质符号 —— 老排盘表里天干/地支的字旁边跟一个材质小图标:
//      木=树、火=火焰、土=土山、金=金锭、水=水滴。
//      光靠颜色, 尤其浅色主题下金跟土都是黄系, 分不出。
//
// 本文件把两条都钉死:
//   色 —— 五个五行的色相 / 明度关系必须是传统命理那一套 (金 != 土、不许反)
//   材质 —— 五个五行都有图标, 天干格 / 地支格里都带着, 且跟着该字的五行色
//
// 2026-10-27 (第 121 批) 老板两条:
//   「土和金颜色没区分」 + 「颜色区分其实都不明显」
//     ⇒ 土改成**深赭褐**, 金改成**藤黄**, 并按 CIELAB ΔE 排过:
//        任意两个五行的 ΔE ≥ 25, 且对卡片底色对比 ≥ 4.5:1 (旧口径下土/金 ΔE 只有 15~21)。
//   「最后图形不要内部镂空」
//     ⇒ 五个材质图标全改成**实心剪影** (fill=currentColor, stroke=none),
//        13px 下描边图标内部是空的, 缩小就糊成一团线。
//
// 2026-10-27 (第 126 批): 颜色口径换成了「**一个五行一个颜色**」——
//   老板: 「其实都按照大运流年的颜色就可以, 就是土和火的颜色要注意」。
//   以前是「实心色 (色块) / ink 色 (文字)」两档 ⇒ 页面上下的同一个五行两个颜色。
//   现在合成一档, 色板和守卫都挪到 tests/helpers/wuxing_color.js (唯一真源)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const H = require('./helpers/wuxing_color.js');
const WEB = path.join(__dirname, '..', 'web', 'app');
const PILLARS = path.join(WEB, 'lib', 'bazi', 'pillars.mjs');
const ICONS = path.join(WEB, 'lib', 'icons.mjs');
const THEMES = path.join(WEB, 'themes.css');
const BAZI_CSS = path.join(WEB, 'views', 'bazi.css');
// 五行 → CSS 变量名 (themes.css 里的 --xxx / --xxx-ink / --on-xxx)
const WX_VAR = H.WX_VAR;
const CHART = {
  pillars: { '年柱': '己未', '月柱': '戊辰', '日柱': '癸酉', '时柱': '乙卯' },
  day_master: '癸', day_master_wuxing: '水', day_master_yinyang: '阴',
  cang_gan: {
    '年柱': [{ '干': '己', '五行': '土', '十神': '七杀' }],
    '月柱': [{ '干': '戊', '五行': '土', '十神': '正官' }],
    '日柱': [{ '干': '辛', '五行': '金', '十神': '偏印' }],
    '时柱': [{ '干': '乙', '五行': '木', '十神': '食神' }],
  },
};
// 颜色计算 (对比度 / CIELAB ΔE) 和主题令牌解析 —— 唯一真源在 helpers/wuxing_color.js。
// 第 126 批把色板一起搬过去了: 三个守卫文件各抄一份色板, 改一次漏一处就会静悄悄放行。
const { hexToRgb, relLum, contrastRatio, hexToLab, deltaE, hue, themeWxVars } = H;
test('119w-1: 三套主题都有五行色, 且五个色互不相同', () => {
  const css = fs.readFileSync(THEMES, 'utf8');
  const sets = themeWxVars(css);
  assert.ok(sets.length >= 3, '至少要能认出三套主题的五行色, 实际 ' + sets.length);
  for (const set of sets) {
    const vals = ['木', '火', '土', '金', '水'].map((w) => set[w]);
    assert.strictEqual(new Set(vals).size, 5, '五个五行色不能有重复: ' + JSON.stringify(set));
  }
});
test('119w-2: 金不许是灰白 —— 老主题把金做成 #C2BFC2 那种中性灰, 必须换掉', () => {
  const css = fs.readFileSync(THEMES, 'utf8');
  for (const set of themeWxVars(css)) {
    assert.notStrictEqual(hue(set.金), -1, '金色是灰的(无色相): ' + set.金);
    assert.notStrictEqual(hue(set.土), -1, '土色是灰的(无色相): ' + set.土);
  }
});
test('119w-3: 土=赭褐、金=藤黄 —— 金比土亮 (老主题把这两个反了)', () => {
  const css = fs.readFileSync(THEMES, 'utf8');
  for (const set of themeWxVars(css)) {
    assert.ok(relLum(set.金) > relLum(set.土),
      '金必须比土亮 (传统: 金=藤黄, 土=赭褐), 实际 金=' + set.金 + ' 土=' + set.土);
  }
});
test('119w-4: 五行色相归属对 —— 木绿、火红、水蓝, 金偏黄、土偏赭金', () => {
  const css = fs.readFileSync(THEMES, 'utf8');
  for (const set of themeWxVars(css)) {
    const h = (w) => hue(set[w]);
    assert.ok(h('木') > 80 && h('木') < 175, '木要绿: ' + set.木 + ' hue=' + h('木'));
    assert.ok(h('火') < 30 || h('火') > 330, '火要红: ' + set.火 + ' hue=' + h('火'));
    assert.ok(h('水') > 190 && h('水') < 265, '水要蓝: ' + set.水 + ' hue=' + h('水'));
    assert.ok(h('金') > 36 && h('金') < 62, '金要藤黄(黄, 别跟土同色系): ' + set.金 + ' hue=' + h('金'));
    // 第 127 批: 老板在课件《喜用忌必查詢表》正文采的土是**赭金** #B28C21 (hue 44),
    //   跟金 #FFEE00 (hue 56) **同在黄区** —— 旧规则 (土不许进黄区) 是照着第 122 批
    //   那套深赭红定的, 现在不成立了, 但「土跟金要分得开」的本意还在 ⇒ 改由 ΔE 守。
    //   这条现在守的是反面: 土不许滑成红色系 (那就跟火贴脸了, 老板点名过)。
    assert.ok(h('土') > 25 && h('土') < 62,
      '土要赭金(不许滑进火的红区, 也不许跑出黄区): ' + set.土 + ' hue=' + h('土'));
  }
});
test('119w-5: 五个五行都有材质图标, 且图标在 ICONS 里真的存在', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  const icons = await import(pathToFileURL(ICONS).href);
  assert.deepStrictEqual(Object.keys(m.WX_ICON).sort(), ['土', '木', '水', '火', '金'],
    '五个五行都得有材质图标');
  for (const [wx, name] of Object.entries(m.WX_ICON)) {
    assert.ok(icons.ICONS[name], wx + ' 的材质图标没在 ICONS 里定义: ' + name);
    const html = m.wxIconHtml(wx);
    assert.ok(html.includes('<svg'), wx + ' 的材质图标没渲染成 svg');
    assert.ok(html.includes('currentColor'), wx + ' 的材质图标必须用 currentColor 跟着五行色走');
  }
  assert.strictEqual(m.wxIconHtml('不存在'), '', '没有映射的五行不许瞎画图标');
});
test('119w-6: 干/支格都带着材质图标, 且图标跟该字同一五行色 (2026-11-04 合并「干支」行)', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  const rows = m.pillarRows(CHART);
  // 2026-11-04 (UI 重写 · 样稿终版): 天干/地支合并成一行「干支」, 每格干上支下。
  const gz = rows.find((r) => r.label === '干支');
  assert.ok(gz, '缺「干支」行');
  const expect = { '年柱': '土', '月柱': '土', '日柱': '水', '时柱': '木' };
  m.PILLAR_COLS.forEach((col, i) => {
    const cell = gz.cells[i];
    const wx = expect[col];
    assert.ok(cell.includes('bz-wx-' + wx), col + ' 天干五行色不对: ' + cell);
    assert.ok(cell.includes('data-ico="' + m.WX_ICON[wx] + '"'), col + ' 天干缺材质图标: ' + cell);
    assert.ok(cell.includes('data-wx="' + wx + '"'), col + ' 材质图标五行对不上: ' + cell);
    assert.ok(cell.includes('bz-ico'), col + ' 天干缺材质图标容器: ' + cell);
  });
  const zhiExpect = { '年柱': '土', '月柱': '土', '日柱': '金', '时柱': '木' };
  m.PILLAR_COLS.forEach((col, i) => {
    const cell = gz.cells[i];
    const wx = zhiExpect[col];
    assert.ok(cell.includes('bz-wx-' + wx), col + ' 地支五行色不对: ' + cell);
    assert.ok(cell.includes('data-ico="' + m.WX_ICON[wx] + '"'), col + ' 地支缺材质图标: ' + cell);
    assert.ok(cell.includes('data-wx="' + wx + '"'), col + ' 材质图标五行对不上: ' + cell);
  });
});
test('119w-7: 材质图标不改变字本身的取值 (天干地支还是一个字)', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  const rows = m.pillarRows(CHART);
  // 2026-11-04: 「干支」行每格剥掉标签后是干+支两个字 (干上支下)
  const textOf = (row) => row.cells.map((h) => h.replace(/<[^>]+>/g, ''));
  assert.deepStrictEqual(textOf(rows.find((r) => r.label === '干支')),
    ['己未', '戊辰', '癸酉', '乙卯']);
});
test('119w-8: bazi.css 里有 .bz-ico 样式, 五行条字色不许写死白字', () => {
  const css = fs.readFileSync(BAZI_CSS, 'utf8');
  assert.ok(/\.bz-ico\s*\{/.test(css), '缺 .bz-ico 样式');
  // 第 122 批: 五行条五格底色一深一浅 ⇒ 不再用「白字 + 阴影」那套,
  // 改成逐五行的 --on-xxx 字色 (对比 ≥ 4.5:1)。写死 #fff 的老写法不许复活。
  const bar = (css.match(/\.bz-bar span\s*\{[^}]*\}/) || [''])[0];
  assert.ok(!/color:\s*(#fff|#FFF|white)\b/.test(bar),
    '五行条不许写死白字 —— 亮黄底上白字读不出来: ' + bar);
});

// ── 第 121 批: 老板「土和金颜色没区分 / 颜色区分其实都不明显」 ──────
test('121w-1: 五个五行色两两分得开 (CIELAB ΔE ≥ 25)', () => {
  const css = fs.readFileSync(THEMES, 'utf8');
  const names = ['木', '火', '土', '金', '水'];
  for (const set of themeWxVars(css)) {
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = names[i], b = names[j];
        const d = deltaE(set[a], set[b]);
        assert.ok(d >= 25,
          '主题 ' + set.__theme + ': ' + a + '(' + set[a] + ') 与 ' + b + '(' + set[b]
          + ') ΔE 只有 ' + d.toFixed(1) + ' —— 分不出来 (要 ≥ 25)');
      }
    }
  }
});
test('121w-2: 五行**文字色**(ink 档) = 老板采的五原值 (第 128 批: 全都按这个, 别搞了)', () => {
  const css = fs.readFileSync(THEMES, 'utf8');
  for (const set of themeWxVars(css)) {
    assert.ok(set.__card, '主题 ' + set.__theme + ' 没解析出 --card 底色');
    for (const w of ['木', '火', '土', '金', '水']) {
      const ink = set.__ink[w];
      assert.ok(ink, '主题 ' + set.__theme + ' 缺 ' + w + ' 的 --' + WX_VAR[w] + '-ink 文字色档');
      // 第 128 批: 老板把字色打回过一次, 最后拍板「全都按这个, 别搞了」——
      //   **三套主题的字色一律 = 老板在课件上采的五原值**, 不许按主题另调一版,
      //   也不许自作主张压暗/提亮 (前两版都被打回)。
      //   (浅色卡底上木 1.33:1 / 金 1.17:1 —— 老板知情拍板, 课件自己就这么画。)
      assert.strictEqual(ink.toUpperCase(), H.BOSS[w].toUpperCase(),
        '主题 ' + set.__theme + ': ' + w + ' 的字色 ' + ink
        + ' 必须等于老板采的 ' + H.BOSS[w] + ' —— 不许有变体');
    }
  }
});
test('121w-3: 土跟金必须明显分开 (老板: 「土和金颜色没区分」)', () => {
  const css = fs.readFileSync(THEMES, 'utf8');
  for (const set of themeWxVars(css)) {
    const d = deltaE(set.土, set.金);
    assert.ok(d >= 30,
      '主题 ' + set.__theme + ': 土 ' + set.土 + ' 与 金 ' + set.金 + ' 的 ΔE 只有 '
      + d.toFixed(1) + ' —— 这一对必须比别的更分得开 (要 ≥ 30)');
  }
});
test('121w-4: 五行材质图标必须是实心, 不许内部镂空', async () => {
  const icons = await import(pathToFileURL(ICONS).href);
  const m = await import(pathToFileURL(PILLARS).href);
  assert.ok(icons.FILLED instanceof Set, 'icons.mjs 必须导出 FILLED (哪些图标是实心)');
  for (const [wx, name] of Object.entries(m.WX_ICON)) {
    assert.ok(icons.FILLED.has(name),
      wx + ' 的材质图标 ' + name + ' 必须进 FILLED (老板: 图形不要内部镂空)');
    const html = icons.iconHTML(name, 13);
    assert.ok(html.includes('fill="currentColor"'),
      wx + ' 的材质图标必须实心填充 (fill="currentColor"): ' + html);
    assert.ok(/stroke="none"/.test(html),
      wx + ' 的材质图标不许留描边 (stroke="none"): ' + html);
  }
});
test('121w-5: 五行条上的字**逐五行**换色 (不能一个 --wx-bar-fg 一刀切)', () => {
  const css = fs.readFileSync(THEMES, 'utf8');
  const bazi = fs.readFileSync(BAZI_CSS, 'utf8');
  for (const set of themeWxVars(css)) {
    for (const w of ['木', '火', '土', '金', '水']) {
      const on = set.__on[w];
      assert.ok(on, '主题 ' + set.__theme + ' 缺 --on-' + WX_VAR[w] + ' (五行条上的字色)');
      const c = contrastRatio(on, set[w]);
      assert.ok(c >= 4.5,
        '主题 ' + set.__theme + ': 五行条 ' + w + ' 底色 ' + set[w] + ' 上字色 ' + on
        + ' 只有 ' + c.toFixed(2) + ':1 (要 ≥ 4.5)');
      assert.ok(new RegExp('\\.bz-g-' + w + '\\s*\\{[^}]*color:\\s*var\\(--' + WX_VAR[w] + '-ink\\)').test(bazi),
        '五行条 ' + w + ' 的字色没走 --' + WX_VAR[w] + '-ink (bazi.css 里必须有 .bz-g-' + w + ')');
    }
  }
  assert.ok(!/--wx-bar-fg\s*:/.test(css) && !/var\(\s*--wx-bar-fg/.test(bazi),
    '一刀切的 --wx-bar-fg 必须删掉 —— 亮黄上白字、深赭红上黑字都读不出来');
});

// ── 第 122 批: 老板「用下面这个颜色就行了」(课件《五行取象方位》那套) ──
// 第 126 批: 这条规则**被老板推翻了** —— 「用下面这个颜色就行了」(课件原色)
//   当时定的是「色块用原色」, 结果页面上下一档不统一, 老板 10-27 又说
//   「其实都按照大运流年的颜色就可以」。
//   ⇒ 现在浅色主题的五行色 = 第 126 批色板 (helpers/wuxing_color.js 里那一份),
//     课件原色退成「色相参考」: 色相还是那个色相, 明度为了可读性调过。
test('122w-1: 浅色主题五行色 = 老板在课件上采的五原值 (一个字都不许改)', () => {
  const css = fs.readFileSync(THEMES, 'utf8');
  const light = themeWxVars(css).find((s) => s.__theme === 'light');
  assert.ok(light, '没解析出浅色主题');
  for (const w of ['木', '火', '土', '金', '水']) {
    assert.strictEqual(light[w].toUpperCase(), H.BOSS[w].toUpperCase(),
      '浅色主题 ' + w + ' 必须用老板采的 ' + H.BOSS[w] + ', 实际 ' + light[w]);
  }
  // 色相不能跑偏: 木绿 / 火红 / 土赭金 / 金黄 / 水蓝
  const wantHue = { 木: [90, 160], 火: [0, 20], 土: [25, 62], 金: [45, 62], 水: [190, 230] };
  for (const w of ['木', '火', '土', '金', '水']) {
    const h = hue(light[w]);
    const [lo, hi] = wantHue[w];
    const ok = lo <= hi ? (h >= lo && h <= hi) : (h >= lo || h <= hi);
    assert.ok(ok, w + ' 色相跑偏了: ' + light[w] + ' (hue ' + h.toFixed(0) + ')');
  }
});
test('122w-2: 三套主题每个五行都给齐三档 (实心色 / ink 文字色 / on 色块上的字色)', () => {
  const css = fs.readFileSync(THEMES, 'utf8');
  const sets = themeWxVars(css);
  assert.ok(sets.length >= 3, '至少三套主题, 实际 ' + sets.length);
  for (const set of sets) {
    for (const w of ['木', '火', '土', '金', '水']) {
      assert.ok(set[w], '主题 ' + set.__theme + ' 缺 ' + w + ' 实心色');
      assert.ok(set.__ink[w], '主题 ' + set.__theme + ' 缺 ' + w + ' 的 --' + WX_VAR[w] + '-ink');
      assert.ok(set.__on[w], '主题 ' + set.__theme + ' 缺 ' + w + ' 的 --on-' + WX_VAR[w]);
    }
  }
});
test('122w-3: 三个主题里五行两两 ΔE ≥ 25, 且土/金 ΔE ≥ 30 (老板: 分不清)', () => {
  const css = fs.readFileSync(THEMES, 'utf8');
  const names = ['木', '火', '土', '金', '水'];
  for (const set of themeWxVars(css)) {
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const d = deltaE(set[names[i]], set[names[j]]);
        assert.ok(d >= 25,
          '主题 ' + set.__theme + ': ' + names[i] + '(' + set[names[i]] + ') 与 ' + names[j]
          + '(' + set[names[j]] + ') ΔE 只有 ' + d.toFixed(1) + ' (要 ≥ 25)');
      }
    }
    const dtk = deltaE(set.土, set.金);
    assert.ok(dtk >= 30,
      '主题 ' + set.__theme + ': 土 ' + set.土 + ' 与 金 ' + set.金 + ' ΔE 只有 '
      + dtk.toFixed(1) + ' (要 ≥ 30)');
  }
});
// 第 126 批: 文字色不再走 --xxx-ink 档, 而是走 --wx —— 也就是**色块用的那个变量**。
//   这样「上面的块」和「下面的字」必然同色, 老板的「上下不统一」从结构上没了。
test('122w-4: 五行字色走 --xxx-ink (第 128 批: 五行是字色, 不铺块)', () => {
  const bazi = fs.readFileSync(BAZI_CSS, 'utf8');
  for (const w of ['木', '火', '土', '金', '水']) {
    assert.ok(new RegExp('\\.bz-wx-' + w + '\\s*\\{[^}]*color:\\s*var\\(--' + WX_VAR[w] + '-ink\\)').test(bazi),
      '.bz-wx-' + w + ' 的字色必须走 --' + WX_VAR[w] + '-ink');
  }
  // 第 128 批: 五行一律是**彩字**, 不许再铺底色。
  const block = (bazi.match(/\.bz-wxb\s*\{[^}]*\}/) || [''])[0];
  assert.ok(!/background/.test(block),
    '五行不许再有底色 (老板: 不用块直接用颜色的字): ' + block);
});

// ── 第 128 批: 五行字色**照抄老板在课件上采的五原值** ──
//   老板 10-27 一连三句:
//     「第一张浅色的字体颜色不对, 第二张黑色字体颜色对」
//     「木 #00FF1D / 火 #FF0000 / 土 #B28C21 / 金 #FFEE00 / 水 #0E70F2」
//     「全都按这个, 别搞了」
//   ⇒ 我自己发明的两版 (压暗的 #0F9E38/#7A4A1E/#B8860B、课件实测的
//     #12E23D/#846E0B/#E49411) **全部作废**; 三套主题字色一律 = 老板原值。
test('128w-1: 三套主题五行**字色** = 老板采的五原值 (一个字都不许改, 不许按主题分版)', () => {
  const css = fs.readFileSync(THEMES, 'utf8');
  const sets = themeWxVars(css);
  assert.ok(sets.length >= 3, '至少三套主题, 实际 ' + sets.length);
  for (const set of sets) {
    for (const w of ['木', '火', '土', '金', '水']) {
      assert.strictEqual(set.__ink[w].toUpperCase(), H.BOSS[w].toUpperCase(),
        '主题 ' + set.__theme + ': ' + w + ' 的字色必须照抄老板采的 ' + H.BOSS[w]
        + ', 实际 ' + set.__ink[w]);
    }
  }
});
test('128w-2: 土/金在**字色档**上也要分得开 (老板: 看土和金是不是分不清楚)', () => {
  const css = fs.readFileSync(THEMES, 'utf8');
  for (const set of themeWxVars(css)) {
    const d = deltaE(set.__ink.土, set.__ink.金);
    assert.ok(d >= 30,
      '主题 ' + set.__theme + ': 字色 土 ' + set.__ink.土 + ' 与 金 ' + set.__ink.金
      + ' ΔE 只有 ' + d.toFixed(1) + ' —— 土金只差 12° 色相, 必须靠明度分开 (要 ≥ 30)');
  }
});
