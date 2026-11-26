'use strict';

// 2026-10-27 (第 123 批): 八字排盘 —— 五行 + 喜忌 三档配色
//
// 老板原话: 「都用五行喜忌的颜色, 更明显」(配图是四柱表 + 五行与喜忌)
//
// 改之前: 表里只有**五行色**(己戊未辰=土红 / 癸=水蓝 / 乙卯=木绿),
//         看不出哪个是喜用、哪个是忌神 —— 喜忌只在下面那个 chips 行里。
// 改之后: 一套三档语言贯穿四柱表 / 五行条 / 喜忌 chips:
//     xi  喜用 → 实心五行色 (字用 --on-xxx, 实心底上的字色另有保证)
//     cai 财星 → 实心五行色 + 1px 实线框
//     ji  忌神 → 实心五行色 + 1px 虚线框
//
// 为什么忌神/财神不填色 —— 实测出来的硬约束, 不是审美偏好:
// 五行 ink 档只保证**对卡片底** ≥ 4.5:1 (第 121 批 121w-2),
// 同一个 ink 字放到 12% 淡底上, 浅色主题实测 木 4.01 / 火 3.72 / 金 4.35 / 水 4.12
// ⇒ 全掉到 4.5 以下。所以 ink 字只许放卡片底。
//
// 2026-10-27 (第 125 批) —— 上面那条「财星/忌神不填色」的规则**是我自己定的**,
// 老板没要求, 而且它就是「火和土分不清」的病根:
//   木金水成了色块、火土退回字色 ⇒ 五行身份一半靠块一半靠字, 红-family 贴脸
//   (深色主题 火 #FF6A57 vs 土 #BE7C52, ΔE 只 13)
// ⇒ 第 125 批改成: **五行身份一律色块 (课件原色), 喜忌档位一律边框**。
//   档位只许动边框, 一动色相火土立刻贴脸 (守卫见 bazi-wuxing-solid-20261027)。
//
// 2026-10-27 (第 126 批) —— 上面那条「五行身份一律色块 (课件原色)」的前提变了:
//   老板: 「其实都按照大运流年的颜色就可以」⇒ 五行**只有一个颜色**,
//   色块底色和文字色共用同一个 --wx (页面上下同一个五行必须是同一个颜色)。
//
// 2026-10-27 (第 128 批) —— 「色块」这条路整个走不通, 现在**五行 = 字色, 一个框都没有**:
//   老板原话 (四句连着说的):
//     「这颜色很清楚, 但是感觉有点怪」  ← 满屏饱和色块像荧光贴纸
//     「块乱了」                        ← 块一多就乱, 看不出结构
//     「不用块直接用颜色的字」          ← 五行色就是字色
//     「不要用框, 实线虚线都不要」      ← 喜忌档位也不许用框表示
//   ⇒ 课件《喜用忌必查詢表》正文本来就是**粗体彩字 + 白底** (表头才是色块);
//     老板要的就是正文那一套。
//   ⇒ 下面 123w-3/4/5 三条被**推翻重写**:
//     123w-3 旧: 喜用档 = 实心色块 + on 色字
//     123w-4 旧: 财星/忌神档 = 实心色块
//     123w-5 旧: 忌神档必须有虚线框
//     123w-3/4/5 新: .bz-role-* 在 CSS 里**一条规则都没有**; 五行元素一律不许有底色。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', 'web', 'app');
const PILLARS = path.join(ROOT, 'lib', 'bazi', 'pillars.mjs');
const BAZI_CSS = path.join(ROOT, 'views', 'bazi.css');
const BAZI_MJS = path.join(ROOT, 'views', 'bazi.mjs');

const CHART = {
  pillars: { '年柱': '己未', '月柱': '戊辰', '日柱': '癸酉', '时柱': '乙卯' },
  day_master: '癸', day_master_wuxing: '水', day_master_yinyang: '阴',
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
  nayin_4: {
    '年柱': '天上火', '月柱': '大林木', '日柱': '剑锋金', '时柱': '大溪水',
  },
  // 老板那张截图上的盘: 喜用 金木水, 忌神 土, 财星 火
  xi_yong: ['金', '木', '水'],
  ji_shell: ['土'],
  cai_xing: ['火'],
};

const css = fs.readFileSync(BAZI_CSS, 'utf8');
const mjs = fs.readFileSync(BAZI_MJS, 'utf8');

/** 取 CSS 里某个选择器的规则块正文 (没有就返回空串)。 */
function ruleBody(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(?:^|[}\\s])' + esc + '\\s*\\{([^}]*)\\}', 'm');
  const m = css.match(re);
  return m ? m[1] : '';
}

test('123w-1: 五行喜忌档 wuxingRole(): 喜用 > 财星 > 忌神, 没档位返回空', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  assert.strictEqual(m.wuxingRole('木', CHART), 'xi', '木是喜用');
  assert.strictEqual(m.wuxingRole('火', CHART), 'cai', '火是财星');
  assert.strictEqual(m.wuxingRole('土', CHART), 'ji', '土是忌神');
  assert.strictEqual(m.wuxingRole('水', CHART), 'xi');
  assert.strictEqual(m.wuxingRole('金', CHART), 'xi');
  assert.strictEqual(m.wuxingRole('土', { xi_yong: ['土'], ji_shell: ['土'] }), 'xi',
    '同时在喜用和忌神里时以喜用为准');
  assert.strictEqual(m.wuxingRole('火', {}), '', '没有任何档位就返回空串');
  assert.strictEqual(m.wuxingRole('', CHART), '');
});

test('123w-2: 四柱表的天干/地支/藏干必须按喜忌带档位类 (老板: 都用喜忌颜色)', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  const rows = m.pillarRows(CHART);
  const byLabel = (l) => rows.find((r) => r.label === l);
  // 2026-11-04 (UI 重写): 天干/地支合并成「干支」行, bz-gan/bz-zhi 类还在各字上
  const gan = byLabel('干支').cells.join('');
  const zhi = gan;
  const cang = byLabel('藏干').cells.join('');
  assert.ok(/bz-gan [^"]*bz-wx-土 bz-role-ji/.test(gan), '年柱天干己(土) 必须是忌神档: ' + gan);
  assert.ok(/bz-gan [^"]*bz-wx-水 bz-role-xi/.test(gan), '日柱天干癸(水) 必须是喜用档: ' + gan);
  assert.ok(/bz-zhi [^"]*bz-wx-金 bz-role-xi/.test(zhi), '日柱地支酉(金) 必须是喜用档: ' + zhi);
  assert.ok(/bz-cang [^"]*bz-wx-火 bz-role-cai/.test(cang), '藏干丁(火) 必须是财星档: ' + cang);
  assert.ok(/bz-cang [^"]*bz-wx-木 bz-role-xi/.test(cang), '藏干乙(木) 必须是喜用档: ' + cang);
});

test('123w-3: .bz-role-* 在 CSS 里**零规则** (老板: 不要用框, 实线虚线都不要)', () => {
  const rules = css.match(/\.bz-role-[a-z]+[^{}]*\{[^}]*\}/g) || [];
  assert.strictEqual(rules.length, 0,
    '喜忌档位不许再有任何样式规则 (底色/框/线全不许): ' + JSON.stringify(rules));
  // 类名还挂在元素上 (数据/测试要用), 但不许有规则去画它
  for (const sel of ['.bz-role-xi', '.bz-role-cai', '.bz-role-ji']) {
    assert.strictEqual(ruleBody(sel), '', sel + ' 必须没有任何规则正文: ' + ruleBody(sel));
  }
});

test('123w-4: 五行元素一律**字色**, 不许有底色 (老板: 不用块直接用颜色的字)', () => {
  const five = ['木', '火', '土', '金', '水'];
  const en = { 木: 'wood', 火: 'fire', 土: 'earth', 金: 'metal', 水: 'water' };
  for (const w of five) {
    const body = ruleBody('.bz-wx-' + w);
    assert.ok(body, '.bz-wx-' + w + ' 规则没了');
    assert.ok(new RegExp('color:\\s*var\\(--' + en[w] + '-ink\\)').test(body),
      '.bz-wx-' + w + ' 字色必须走 --' + en[w] + '-ink: ' + body);
    assert.ok(!/background/.test(body),
      '.bz-wx-' + w + ' 不许有底色 (五行是字色不是块): ' + body);
  }
  // bz-wxb = 五行身份标记, 只许加粗, 不许铺块
  const wxb = ruleBody('.bz-wxb');
  assert.ok(wxb, '.bz-wxb 规则没了');
  assert.ok(!/background/.test(wxb), '.bz-wxb 不许有底色: ' + wxb);
  // 五行条每段同理
  for (const w of five) {
    const body = ruleBody('.bz-g-' + w);
    assert.ok(body, '.bz-g-' + w + ' 规则没了');
    assert.ok(!/background/.test(body), '.bz-g-' + w + ' 不许有底色: ' + body);
  }
});

test('123w-5: 全表不许再有实线/虚线框来标五行或喜忌', () => {
  assert.ok(!/outline[^:]*:\s*1px\s+(solid|dashed)/.test(css),
    'bazi.css 不许再有 outline 实线/虚线框');
  // 唯一允许的虚线是 AI 批语锚点下划线 (不是五行/喜忌标记)
  const dashedRules = (css.match(/[^{}]*\{[^}]*dashed[^}]*\}/g) || [])
    .filter((r) => !/bz-anchor-link/.test(r));
  assert.strictEqual(dashedRules.length, 0,
    '虚线只许留给锚点下划线, 不许拿来标五行/喜忌: ' + JSON.stringify(dashedRules));
});

test('123w-6: 喜用/忌神/财星 chip 用同一套档位类 (两处长得一样才读得懂)', () => {
  assert.ok(/chip\(c\.xi_yong,\s*'xi'\)/.test(mjs), '喜用 chip 必须走 xi 档');
  assert.ok(/chip\(c\.ji_shell,\s*'ji'\)/.test(mjs), '忌神 chip 必须走 ji 档');
  assert.ok(/chip\(c\.cai_xing,\s*'cai'\)/.test(mjs), '财星 chip 必须走 cai 档');
  assert.ok(/bz-chip/.test(mjs), 'chip 要有 bz-chip 类');
});

test('123w-7: 纳音只染五行色, 不套喜忌档 (纳音是「纳」不是「用」)', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  const rows = m.pillarRows(CHART);
  const ny = rows.find((r) => r.label === '纳音').cells.join('');
  assert.ok(/bz-nayin [^"]*bz-wx-火/.test(ny), '天上火 要染火色: ' + ny);
  assert.ok(/bz-nayin [^"]*bz-wx-金/.test(ny), '剑锋金 要染金色: ' + ny);
  assert.ok(!/bz-nayin[^"]*bz-role-/.test(ny), '纳音不许套喜忌档: ' + ny);
});

test('123w-8: 五行条每段都要挂 bz-wx-<五行> (否则 --wx 取不到 ⇒ 背景透明)', () => {
  assert.ok(/bz-g-'\s*\+\s*w\s*\+\s*'\s+bz-wxb/.test(mjs),
    '五行条每段必须同时挂 bz-g-<五行> 和 bz-wxb (五行身份=色块)');
  assert.ok(/bz-g-'\s*\+\s*w\s*\+\s*'\s+bz-wxb\s+bz-wx-/.test(mjs),
    '五行条每段必须同时挂 bz-wx-<五行> (否则 --wx 取不到 ⇒ 背景透明)');
  assert.ok(!/\.bz-bar \.bz-role-(cai|ji)\s*\{/.test(css),
    '五行条里不许再按档位改填充 —— 五段都该是课件原色块');
});

test('123w-9: 五行条窄段也要标出五行名 (只有 <4% 宽才留白)', () => {
  assert.ok(/pct\s*>\s*8\s*\?\s*w\s*\+\s*'\s'\s*\+\s*v\s*:\s*\(pct\s*>=\s*4\s*\?\s*w\s*:/.test(mjs),
    '五行条的小段不许空着 —— 老板一眼看不出那是金还是火');
});
