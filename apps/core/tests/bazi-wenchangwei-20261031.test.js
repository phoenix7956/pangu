'use strict';
// 2026-10-31 (第 178 批): app「本命虚空藏菩萨」块里有一格「文昌位」, 盘古没有
//
// app (1986-12-17 16:20 上海宝山区 男) 写: **文昌位西南**
//
// 真源 (桌面<course-source>/<course-file>「如何确定孩子个人文昌位」):
//   「尾数一字年1981、1991年正北方
//     尾数二字年1982、1992年东北方
//     尾数三字年1983、1993年正东方
//     尾数四字年1984、1994年东南方
//     尾数五字年1985、1995年正南方
//     尾数六字年1986、1996年西南方
//     尾数七字年1987、1997年正西方
//     尾数八字年1988、1998年西南方
//     尾数九字年1989、1999年正西方
//     尾数零字年1990、2000年西北方」
// => 查**公历出生年尾数** -> 方位。
//
// 注意别跟四柱神煞里的「文昌贵人」混:
//   文昌贵人 = 按**日干**查**地支** (甲乙巳午 丙戊申 丁己酉 庚猪辛鼠 壬虎癸卯),
//              是柱上神煞; app 的「虚空藏菩萨」块那一格说的是**方位**(书桌朝向)。
//   两条同名不同物, 各归各位。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const CORE = path.join(__dirname, '..');

async function calc(params) {
  const { TOOLS } = require(path.join(CORE, 'modules', 'tools'));
  const r = await TOOLS.bazi_calc({ params });
  assert.ok(r && r.ok, 'bazi_calc 调用失败: ' + JSON.stringify(r).slice(0, 300));
  return (r.data && r.data.pillars) || {};
}

test('178-1: 老板 app 的盘 —— 文昌位西南, 一字不差', async () => {
  const p = await calc({ year: 1986, month: 12, day: 17, hour: 16, minute: 20, gender: 'male', city: '上海', district: '宝山区' });
  assert.strictEqual(p.wenchang_wei, '西南', '文昌位不对(app: 西南)');
});

test('178-2: 顺口溜整表 —— 尾数 0~9 十格一个不差', async () => {
  const table = {
    1981: '正北', 1982: '东北', 1983: '正东', 1984: '东南', 1985: '正南',
    1986: '西南', 1987: '正西', 1988: '西南', 1989: '正西', 1990: '西北',
    1991: '正北', 1992: '东北', 1993: '正东', 1994: '东南', 1995: '正南',
    1996: '西南', 1997: '正西', 1998: '西南', 1999: '正西', 2000: '西北',
  };
  for (const [y, want] of Object.entries(table)) {
    const p = await calc({ year: Number(y), month: 6, day: 15, hour: 12, minute: 0, gender: 'male' });
    assert.strictEqual(p.wenchang_wei, want, y + ' 年文昌位应为 ' + want);
  }
});

test('178-3: 文昌位只跟**公历出生年尾数**有关 —— 同年不同月同时辰, 值不许变', async () => {
  const a = await calc({ year: 1993, month: 1, day: 3, hour: 3, minute: 0, gender: 'male' });
  const b = await calc({ year: 1993, month: 11, day: 27, hour: 21, minute: 0, gender: 'male' });
  assert.strictEqual(a.wenchang_wei, '正东');
  assert.strictEqual(a.wenchang_wei, b.wenchang_wei, '同年不该变');
});

test('178-4: 文昌位 != 文昌贵人 —— 别把方位跟地支混成一格', async () => {
  // 1986-12-17 日干乙 => 文昌贵人地支在巳午 (逐柱神煞里), 跟「西南」是两个东西
  const p = await calc({ year: 1986, month: 12, day: 17, hour: 16, minute: 20, gender: 'male', city: '上海', district: '宝山区' });
  assert.strictEqual(p.wenchang_wei, '西南');
  assert.ok(!/[子丑寅卯辰巳午未申酉戌亥]/.test(String(p.wenchang_wei)),
    '文昌位不该是地支 —— 那是「文昌贵人」, 另一个东西');
});

