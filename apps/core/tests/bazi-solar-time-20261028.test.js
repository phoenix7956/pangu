// tests/bazi-solar-time-20261028.test.js — 真太阳时的**跨日**与**经度出处**守卫
//
// 为什么有这条守卫 (第 131 批, 2026-10-28):
//   消费面审计发现两处**静默**的错:
//
//   ① 跨日不翻页: 真太阳时减到前一天时(乌鲁木齐 00:30 → 22:20),
//      日柱仍按公历当天排、时柱却挂前一天 ⇒ **一张盘里混两个日子**,
//      而且不报错、不告警, 输出看起来跟正确盘一模一样。
//
//   ② 经度表覆盖 8%: 前端能选 369 个市, 后端经度表只有 41 个手写城市,
//      其余 331 个 (89.7%) **静默**退回东八区中心 120°E。
//      喀什差 176 分钟、和田差 160 分钟 —— 2~3 小时真太阳时差, 足以排错时柱,
//      而页面上最多给一句提示, 走工具/agent 那条路**连提示都没有**。
//
// 这条守卫钉的是**行为**: 跨日要翻页、经度表要全覆盖、查不到要**说**。

'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PY = '/usr/bin/python3';
const SCRIPT = path.resolve(__dirname, '..', 'modules', 'tools', 'bazi', 'bazi_calc.py');
const LONG_JSON = path.resolve(__dirname, '..', 'modules', 'tools', 'bazi', 'city_long.json');

function calc(args) {
  const out = execFileSync(PY, [SCRIPT, ...args.map(String)], { encoding: 'utf-8', maxBuffer: 1e8 });
  return JSON.parse(out);
}

let pass = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  FAIL ' + name + '\n       ' + (e && e.message));
    process.exitCode = 1;
  }
}

console.log('\n--- 跨日: 真太阳时减到前一天, 日柱必须跟着翻 ---');

t('乌鲁木齐 1975-02-08 00:30 → 真太阳时 2/7 22:20, 日柱/时柱都用 2/7', () => {
  const r = calc([1975, 2, 8, 0, 30, 'male', '--city', '乌鲁木齐']);
  assert.strictEqual(r.solar_date_shift_days, -1);
  assert.ok(r.solar_date.startsWith('1975年2月7日'), '有效日期没翻过去: ' + r.solar_date);
  assert.strictEqual(r.pillars['日柱'], '甲申', '日柱应属 2/7');
  assert.strictEqual(r.pillars['时柱'], '乙亥', '时柱应属 2/7');
});

t('上海 1975-02-08 23:55 → 真太阳时 2/9 00:01, 往前翻', () => {
  const r = calc([1975, 2, 8, 23, 55, 'male', '--city', '上海']);
  //
  // 2026-10-31 第 176 批: 真太阳时**加了均时差** (老板上课 app 对照证实)。
  //   2 月初均时差约 **-14.45 分** ⇒ 上海 23:55 + 6.00(经度) − 14.45(均时差)
  //   = 23:46.55 ⇒ **不再跨日**(旧口径只有经度修正, 23:55+6 = 2/9 00:01 才跨)。
  //   均时差最大 ±16 分, 足以让 23:55 这种临界盘翻页 ⇒ 这不是小数点问题。
  assert.strictEqual(r.solar_date_shift_days, 0);
  assert.ok(r.solar_date.startsWith('1975年2月8日'), '不该翻页: ' + r.solar_date);
  assert.strictEqual(r.pillars['日柱'], '乙酉');
  assert.strictEqual(r.pillars['时柱'], '戊子');
});

t('乌鲁木齐 1975-01-01 00:30 → 跨月跨年, 年柱要退到 1974', () => {
  const r = calc([1975, 1, 1, 0, 30, 'male', '--city', '乌鲁木齐']);
  assert.strictEqual(r.solar_date_shift_days, -1);
  assert.ok(r.solar_date.startsWith('1974年12月31日'), '有效日期没翻过去: ' + r.solar_date);
  assert.strictEqual(r.pillars['年柱'], '甲寅', '年柱应退到 1974');
});

t('不跨日的盘不许被改 (成都 10:05 = 老板那张盘)', () => {
  const r = calc([1975, 2, 8, 10, 5, 'male', '--city', '成都']);
  assert.strictEqual(r.solar_date_shift_days, 0);
  //
  // 2026-10-31 第 176 批: 加均时差后, 成都 10:05 的真太阳时是 **08:46**
  //   (经度修正 -63.60 + 均时差 -14.45), 落在**辰时** ⇒ 时柱 庚辰 (原来 巳时 辛巳)。
  //   这条改的是**真太阳时口径**, 不是把盘改坏:
  //   老板上课 app 对照 (上海 1986-12-17 16:20 → 真太阳时 16:29) 只有**加上均时差**
  //   才分毫不差 —— 不加就是 16:26。
  assert.deepStrictEqual(r.pillars, { 年柱: '乙卯', 月柱: '戊寅', 日柱: '乙酉', 时柱: '庚辰' });
});

t('关掉真太阳时 ⇒ 不翻日, 修正量 0', () => {
  const r = calc([1975, 2, 8, 0, 30, 'male', '--city', '乌鲁木齐', '--no-solar-time']);
  assert.strictEqual(r.solar_date_shift_days, 0);
  assert.strictEqual(r.time_correction_minutes, 0);
});

console.log('\n--- 经度表: 覆盖 + 出处可见 ---');

const LONG = JSON.parse(fs.readFileSync(LONG_JSON, 'utf-8'));

t('经度表覆盖前端下拉的**全部**城市 (不许再静默退回 120°E)', async () => {
  const regions = await import(path.resolve(__dirname, '..', 'web', 'app', 'lib', 'bazi', 'regions.mjs'));
  const wanted = Object.values(regions.PROVINCES).flat();
  const missing = wanted.filter((c) => LONG.cities[c] == null);
  assert.strictEqual(missing.length, 0,
    '经度表缺 ' + missing.length + ' 个市: ' + missing.slice(0, 10).join('、'));
  assert.ok(wanted.length >= 360, '前端城市清单异常: ' + wanted.length);
});

t('每个城市的经度都落在中国的经度范围内 (73~135°E)', () => {
  for (const [k, v] of Object.entries(LONG.cities)) {
    assert.ok(v > 73 && v < 135, k + ' 经度离谱: ' + v);
  }
});

t('喀什这类西部城市必须命中真实经度 (不再是 120°E 兜底)', () => {
  const r = calc([1975, 2, 8, 10, 5, 'male', '--city', '喀什']);
  assert.strictEqual(r.solar_time_source['层级'], '市');
  assert.strictEqual(r.solar_time_source['近似值'], false);
  //
  // 2026-10-31 第 176 批: 修正量 = 经度修正(-176) + 均时差(-14.45) ≈ -190.5。
  //   经度那一半仍必须命中真实经度 —— 拆开看:
  assert.ok(Math.abs(r.solar_time_source['经度修正(分钟)'] + 176) < 2,
    '喀什经度修正应约 -176 分, 实为 ' + r.solar_time_source['经度修正(分钟)']);
  assert.ok(Math.abs(r.solar_time_source['均时差(分钟)'] + 14.45) < 0.5,
    '2 月初均时差应约 -14.45 分, 实为 ' + r.solar_time_source['均时差(分钟)']);
  assert.ok(Math.abs(r.time_correction_minutes + 190.5) < 2,
    '喀什合计修正量应约 -190.5 分, 实为 ' + r.time_correction_minutes);
});

t('选了区县就用区县的经度 (比市更细)', () => {
  const r = calc([1975, 2, 8, 10, 5, 'male', '--city', '北京', '--district', '东城区']);
  assert.strictEqual(r.solar_time_source['层级'], '区县');
});

t('查不到经度时必须**标出来**(近似值 + 说明), 不许静默', () => {
  const r = calc([1975, 2, 8, 10, 5, 'male', '--city', '不存在的市']);
  assert.strictEqual(r.solar_time_source['近似值'], true);
  assert.ok(/未查到|120/.test(r.solar_time_source['说明']),
    '没查到经度要说清楚: ' + r.solar_time_source['说明']);
});

t('数据源未收录的城市(新星/白杨)必须带近似标记', () => {
  const r = calc([1975, 2, 8, 10, 5, 'male', '--city', '新星']);
  assert.strictEqual(r.solar_time_source['近似值'], true);
  assert.ok(String(r.solar_time_source['说明']).length > 0);
});

console.log('\n--- 晚子时口径 ---');

t('23 时出生: 讲明是早子时派(时干用次日日干, 日柱不变)', () => {
  // 用上海(+6 分钟): 真太阳时仍在 23 时 ⇒ 晚子时。
  // 成都 -64 分钟会把 23:30 拉到 22:26(亥时), 那就不是晚子时了 —— 不能混。
  const r = calc([1975, 2, 8, 23, 30, 'male', '--city', '上海']);
  assert.strictEqual(r.hour_pillar_next_day_stem, true);
  assert.ok(/早子时派/.test(r.zishi_convention), '口径没写明: ' + r.zishi_convention);
  assert.notStrictEqual(r.pillars['日柱'][0], r.pillars['时柱'][0],
    '早子时派: 时干应与日干不同(时干按次日日干推)');
});

t('非 23 时: 不许挂晚子时标记', () => {
  const r = calc([1975, 2, 8, 10, 5, 'male', '--city', '成都']);
  assert.strictEqual(r.hour_pillar_next_day_stem, false);
});

console.log('\n太阳时守卫: ' + pass + ' 项通过'
  + (process.exitCode ? ' —— 有失败项' : ' —— 全绿'));
