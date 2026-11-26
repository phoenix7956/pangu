'use strict';

// 2026-10-27 (第 119 批补修二): 四柱显示不对
//
// 老板原话: 「四柱显示也不对」
// 真 bug: 天干行和地支行**都打印了整柱**「己未」——
//   老代码 slice(0,1)/slice(1,2) 只用来取五行颜色, 打印时用的还是整串 c.pillars[col]。
//   「己 -> 七杀」这种合成串也整串印出来了。
//
// 取字逻辑原来藏在 render() 里没法测 ⇒ 抽成 lib/bazi/pillars.mjs 纯函数,
// 本文件直接盯住「一个字」这件事, 免得下次又抄回去。

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PILLARS = path.join(__dirname, '..', 'web', 'app', 'lib', 'bazi', 'pillars.mjs');

const CHART = {
  pillars: { '年柱': '己未', '月柱': '戊辰', '日柱': '癸酉', '时柱': '乙卯' },
  day_master: '癸', day_master_wuxing: '水', day_master_yinyang: '阴',
  // 2026-10-31 第 176 批: 性别是**命主性别**, 不是日元阴阳。
  // 这个盘是坤造 (女) ⇒ 日柱主星「元女」。
  gender: 'female',
  shishen_tiangan: {
    '年柱干': '己 -> 七杀', '月柱干': '戊 -> 正官',
    '日柱干': '癸 -> 比肩', '时柱干': '乙 -> 食神',
  },
  shishen_dizhi: {
    '年柱支': [{ '干': '己', '十神': '七杀' }, { '干': '丁', '十神': '偏财' }],
    '月柱支': [{ '干': '戊', '十神': '正官' }],
    '日柱支': [{ '干': '辛', '十神': '偏印' }],
    '时柱支': [{ '干': '乙', '十神': '食神' }],
  },
  cang_gan: {
    '年柱': [
      { '干': '己', '五行': '土', '十神': '七杀' },
      { '干': '丁', '五行': '火', '十神': '偏财' },
      { '干': '乙', '五行': '木', '十神': '食神' },
    ],
    '月柱': [
      { '干': '戊', '五行': '土', '十神': '正官' },
      { '干': '乙', '五行': '木', '十神': '食神' },
      { '干': '癸', '五行': '水', '十神': '比肩' },
    ],
    '日柱': [{ '干': '辛', '五行': '金', '十神': '偏印' }],
    '时柱': [{ '干': '乙', '五行': '木', '十神': '食神' }],
  },
  changsheng_4: { '年柱': '沐浴', '月柱': '胎', '日柱': '临官', '时柱': '绝' },
  nayin_4: { '年柱': '天上火', '月柱': '大林木', '日柱': '剑锋金', '时柱': '大溪水' },
  // 第 176 批新增的三行 (后端已给, 前端 fixture 跟上):
  //   自坐 = 每柱天干坐自己地支的十二长生位
  //   空亡 = 每柱按自己所在旬算 (不是全盘一个值)
  zichuan_4: { '年柱': '长生', '月柱': '死', '日柱': '养', '时柱': '绝' },
  xunkong_4: { '年柱': '戌亥', '月柱': '辰巳', '日柱': '辰巳', '时柱': '午未' },
};

test('119p-1: 一柱「己未」要能拆成天干和地支', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  assert.strictEqual(m.ganOf('己未'), '己');
  assert.strictEqual(m.zhiOf('己未'), '未');
  assert.strictEqual(m.ganOf(''), '');
  assert.strictEqual(m.zhiOf(undefined), '');
});

test('119p-2: 十神要的是十神那一半, 不是「己 -> 七杀」整串', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  assert.strictEqual(m.ganShishen(CHART, '年柱'), '七杀');
  assert.strictEqual(m.ganShishen(CHART, '日柱'), '比肩');
  // 地支十神取本气(藏干表第一条)
  assert.strictEqual(m.zhiShishen(CHART, '年柱'), '七杀');
  assert.strictEqual(m.zhiShishen(CHART, '日柱'), '偏印');
  // 缺数据不许崩, 也不许印 undefined
  assert.strictEqual(m.ganShishen({}, '年柱'), '-');
  assert.strictEqual(m.zhiShishen({}, '年柱'), '-');
});

test('119p-3: 四柱表「干支」行的干/支**各只有一个字** (2026-11-04 两行合并)', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  const rows = m.pillarRows(CHART);
  // 2026-11-04 (UI 重写 · 样稿终版): 天干/地支两行合并成一行「干支」,
  // 每柱干上支下竖排 (bz-gzstack)。取字逻辑不变 —— 还是各一个字。
  const gz = rows.find((r) => r.label === '干支');
  assert.ok(gz, '缺「干支」行');
  assert.ok(!rows.find((r) => r.label === '天干'), '不该再有单独的「天干」行');
  assert.ok(!rows.find((r) => r.label === '地支'), '不该再有单独的「地支」行');

  const pick = (cell, cls) => (cell.match(new RegExp('<span class="' + cls + '[^"]*"[^>]*>([^<]+)<')) || [])[1] || '';
  assert.deepStrictEqual(gz.cells.map((h) => pick(h, 'bz-gan')), ['己', '戊', '癸', '乙'],
    '每柱的天干必须是一个字');
  assert.deepStrictEqual(gz.cells.map((h) => pick(h, 'bz-zhi')), ['未', '辰', '酉', '卯'],
    '每柱的地支必须是一个字');

  // 整行里不许出现整柱串 —— 这就是老板看到「己未己未」的那个 bug
  for (const row of rows) {
    for (const cell of row.cells) {
      assert.ok(!cell.includes('己未'), '「干支」行里混进了整柱: ' + cell);
    }
  }
});

test('119p-4: 天干十神行不许印「己 -> 七杀」', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  const rows = m.pillarRows(CHART);
  for (const row of rows) {
    for (const cell of row.cells) {
      assert.ok(!cell.includes('->'), '十神行里混进了合成串: ' + cell);
    }
  }
  const html = m.pillarTableHtml(CHART);
  assert.ok(!html.includes('->'), '整表里混进了「->」合成串');
});

test('119p-5: 整表结构按老排盘表: 主星/天干/地支/藏干/副星', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  const html = m.pillarTableHtml(CHART);
  for (const col of m.PILLAR_COLS) {
    assert.ok(html.includes('>' + col + '<'), '表头缺 ' + col);
  }
  // 老板给的标准版式 (传统命书《判断日元强弱条例》那张):
  //   主星 / 天干 / 地支 / 藏干 / 副星  (+ 星运 / 纳音 附加)
  //
  // 2026-10-31 第 176 批: 老板拿上课 app 的盘来对, app 的行序是
  //   主星 / 天干 / 地支 / 藏干 / 藏干十神 / **星运 / 自坐 / 纳音 / 空亡**
  // ⇒ 这两行 (自坐/空亡) 是按 app 的盘面补的, 行序也跟着 app 对齐。
  // ⚠ 第 179 批撤下 (老板: 神煞不全, 那还不如先不做),
  //   第 182 批神煞表按课件 08/09 补齐后**恢复**, 行序在空亡之后 (表尾)。
  // 2026-11-04 (UI 重写 · 样稿终版): 天干/地支两行合并成一行「干支」,
  //   每柱干上支下竖排 —— 行序其余不动。
  const labels = m.pillarRows(CHART).map((r) => r.label);
  assert.deepStrictEqual(labels, [
    '主星', '干支', '藏干', '副星', '星运', '自坐', '纳音', '空亡', '神煞',
  ]);
  assert.ok(html.includes('沐浴'), '星运行没渲染');
  assert.ok(html.includes('天上火'), '纳音行没渲染');
  assert.ok(html.includes('长生'), '自坐行没渲染');
  assert.ok(html.includes('戌亥'), '空亡行没渲染');
  // 表头角标
  assert.ok(html.includes('>日期<'), '表头角标应该是「日期」');
});

test('119p-5b: 主星 = 天干十神, 日柱那格显示日元本人 (元男/元女)', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  assert.strictEqual(m.yuanZi(CHART), '元女', '坤造 ⇒ 元女');
  assert.strictEqual(m.masterStar(CHART, '年柱'), '七杀');
  assert.strictEqual(m.masterStar(CHART, '日柱'), '元女', '日柱主星是日元本人, 不是比肩');
  // 老排盘表里日柱不写「比肩」, 写元男/元女
  const row = m.pillarRows(CHART).find((r) => r.label === '主星');
  const texts = row.cells.map((h) => h.replace(/<[^>]+>/g, ''));
  assert.deepStrictEqual(texts, ['七杀', '正官', '元女', '食神']);
});

test('119p-5c: 副星跟藏干逐行对齐 —— 藏干几条, 副星就几条', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  const rows = m.pillarRows(CHART);
  const cang = rows.find((r) => r.label === '藏干');
  const fu = rows.find((r) => r.label === '副星');
  const count = (html) => (html.match(/bz-cang/g) || []).length;
  for (let i = 0; i < m.PILLAR_COLS.length; i++) {
    assert.strictEqual(count(fu.cells[i]), count(cang.cells[i]),
      m.PILLAR_COLS[i] + '柱: 副星条数必须跟藏干一样 (逐行对齐)');
  }
  // 副星的值就是藏干各自的十神
  const fuTexts = fu.cells[0].replace(/<[^>]+>/g, ' ').trim().split(/\s+/);
  assert.deepStrictEqual(fuTexts, ['七杀', '偏财', '食神']);
});

test('119p-5d: 藏干写成「己土」这种干+五行, 并带五行色', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  const rows = m.pillarRows(CHART);
  const cang = rows.find((r) => r.label === '藏干');
  const html = cang.cells[0];
  assert.ok(html.includes('己土'), '藏干要写成干+五行: ' + html);
  assert.ok(html.includes('丁火'), '藏干要写成干+五行: ' + html);
  // 类名顺序无关 (第 125 批给五行身份加了 bz-wxb 色块类, 插在 bz-cang 和 bz-wx-* 中间) ——
  // 断的是**字面顺序**, 不是颜色: 浏览器实测藏干底色确实是五行色。
  assert.ok(/bz-cang[^"]*bz-wx-土/.test(html), '藏干要带五行色: ' + html);
  assert.ok(/bz-cang[^"]*bz-wx-火/.test(html), '藏干要带五行色: ' + html);
});

test('119p-6: 五行取色 —— 天干按天干算, 地支按地支算', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  assert.strictEqual(m.GAN_WX['己'], '土');
  assert.strictEqual(m.ZHI_WX['未'], '土');
  assert.strictEqual(m.GAN_WX['癸'], '水');
  assert.strictEqual(m.ZHI_WX['酉'], '金');
  const html = m.pillarTableHtml(CHART);
  assert.ok(/bz-gan[^"]*bz-wx-土/.test(html), '天干行缺土色');
  assert.ok(/bz-zhi[^"]*bz-wx-金/.test(html), '地支行缺金色');
});
