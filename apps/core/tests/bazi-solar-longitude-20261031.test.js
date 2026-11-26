'use strict';
// 2026-10-31 (第 181 批): 真太阳时的**经度层级**守卫
//
// 起因 —— 老板 10-31 澄清了一句:
//   「不是没有修正, 是没有给区, 那是为了做题」
//
// 我当时下的推断是「若 app 对成都没做经度修正 ⇒ 盘古的经度口径要对 app 让步」。
// 老板纠正: app **是做了修正**的, 那道题只是**没填到区**, 经度精度只到市级。
// ⇒ 结论: **不许拿没给区的那道题当口径基准**。
//
// 但「没给区」这件事本身, 盘古这边得钉死三件事, 否则又是静默退化:
//   ① 给了区, 就必须用**区级**经度 (不许悄悄退回市级/手写表);
//   ② 只给市, 就必须用**市级**经度 (不许悄悄退回东八区中心 120°E);
//   ③ 查不到就得**说** (层级=默认 + 近似值标记), 不许装作没事。
//
// 另: 均时差必须真的在算 —— 少了它, 成都那张盘会退回 9:01/巳时,
//   而老板 app 的上海盘会差 3 分钟。这条钉死两个可验的点。

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const PY = '/usr/bin/python3';
const SCRIPT = path.join(CORE, 'modules', 'tools', 'bazi', 'bazi_calc.py');

function calc(args) {
  const out = execFileSync(PY, [SCRIPT, ...args.map(String)], { encoding: 'utf-8', maxBuffer: 1e8 });
  return JSON.parse(out);
}

test('181-1: 上海宝山区 1986-12-17 16:20 → 真太阳时 16:29, 与老板上课 app 分毫不差', () => {
  const r = calc([1986, 12, 17, 16, 20, 'male', '--city', '上海', '--district', '宝山区']);
  // app 截图写: 真太阳时 1986-12-17 16:29
  //   = 经度修正(+5.88, 宝山 121.47°E) + 均时差(+3.25, 12/17) = +9.13 分
  assert.ok(r.solar_date.includes('16时29'), '真太阳时不是 16:29: ' + r.solar_date);
  assert.strictEqual(r.solar_time_source['均时差(分钟)'], 3.25, '均时差不对(12/17 应约 +3.25 分)');
  assert.strictEqual(r.solar_time_source['层级'], '区县', '给了区就必须用区级经度');
});

test('181-2: 成都 1975-02-08 10:05 → 8:46, 辰时 ⇒ 时柱庚辰 (给区/不给区都一样)', () => {
  const cityOnly = calc([1975, 2, 8, 10, 5, 'male', '--city', '成都']);
  const withDist = calc([1975, 2, 8, 10, 5, 'male', '--city', '成都', '--district', '锦江区']);
  for (const [tag, r] of [['只给市', cityOnly], ['给区', withDist]]) {
    assert.ok(r.solar_date.includes('8时46'), tag + ': 真太阳时不是 8:46: ' + r.solar_date);
    assert.strictEqual(r.pillars['时柱'], '庚辰', tag + ': 时柱应是庚辰(辰时)');
    // 关键: 经度修正必须**非 0** —— 退回东八区中心 120°E 的话
    //   10:05 - 14.45(均时差) = 9:51 ⇒ 巳时 ⇒ 辛巳, 整张盘错一个时辰。
    assert.notStrictEqual(r.solar_time_source['经度修正(分钟)'], 0,
      tag + ': 经度修正是 0 —— 静默退回东八区中心了');
  }
  // 成都各区经度都在 103.9~104.3 之间, 给不给区差不到 1.5 分 ⇒ 时辰不变
  assert.strictEqual(cityOnly.pillars['时柱'], withDist.pillars['时柱']);
});

test('181-3: 查不到出生地必须**说** —— 层级=默认 + 近似值标记, 不许装作没事', () => {
  const r = calc([1990, 6, 15, 12, 0, 'male', '--city', '不存在的城市名XYZ']);
  const src = r.solar_time_source || {};
  assert.ok(src['层级'], '没给经度层级');
  if (src['层级'] === '默认') {
    assert.strictEqual(src['近似值'], true, '退回默认了却没标近似值 —— 等于骗人');
    assert.ok(src['说明'], '退回默认必须说明');
  }
  // 不管命中哪层, 均时差必须单独列出来 (别让人以为只有经度修正)
  assert.ok('均时差(分钟)' in src, '没给均时差');
});

test('181-4: 均时差在极端日期上要真的起作用 (2 月负 / 11 月正)', () => {
  // 2 月中旬: 均时差约 -14 分; 11 月中旬: 约 +16 分
  const feb = calc([1986, 2, 10, 12, 0, 'male', '--city', '上海', '--district', '宝山区']);
  const nov = calc([1986, 11, 10, 12, 0, 'male', '--city', '上海', '--district', '宝山区']);
  assert.ok(feb.solar_time_source['均时差(分钟)'] < -10,
    '2 月均时差应约 -14 分, 实得 ' + feb.solar_time_source['均时差(分钟)']);
  assert.ok(nov.solar_time_source['均时差(分钟)'] > 10,
    '11 月均时差应约 +16 分, 实得 ' + nov.solar_time_source['均时差(分钟)']);
});

