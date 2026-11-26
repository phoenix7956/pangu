'use strict';
// 2026-10-31 (第 177 批): 老板拿上课 app 的盘对盘 —— 盘古「命宫」跟 app 不一样
//
// app (1986-12-17 16:20 上海宝山区 男) 的「本命虚空藏菩萨」块写: **命宫丁酉**
// 盘古旧实现算出来是「辛巳」—— 错。
//
// 根因 —— 旧实现 `(14 - 出生**公历**月 - 时支序 - 1) % 12` 两处都错:
//   ① 把**公历月**当生月。生月是**节气月**(寅=正月 … 丑=十二月),
//      1986-12-17 落在子月(十一月), 公历月 12 跟它根本不是一回事。
//   ② 公式不是《三命通会》那套, 是自造的。
//   ⇒ 命宫/身宫两格静默算错, 不抛异常 —— 跟第 176 批那四个同族。
//
// 真源 (桌面<course-source>/<course-file>「○论坐命官」):
//   「先将所生之月从子上起正月, 亥止上二月, 戌三 … **逆行十二位**,
//     次将所生之时加于所生之月, **顺行十二位**, **逢卯即安命宫**」
//   书里的例: 甲子年三月生戌时 ⇒ 月宫在戌, 戌时加戌上, 顺行到卯时落卯 ⇒ 命坐卯宫;
//             干随年干起「甲己之年丙作首」 ⇒ 丁卯宫。
//   ⇒ 闭式:
//     月宫 = (2 - 月支序) % 12                  # 正月在子, 二月在亥 … 逆行十二位
//     命宫 = (月宫 + (卯序 - 时支序)) % 12      # 生时加于月宫, 顺行十二位, 逢卯安命
//     干:   年干五虎遁起寅宫, 从寅宫顺数到命宫支
//
// 本守卫把书里那个例子直接当断言 —— 公式只要歪一点, 例子立刻红。

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

test('177-1: 《三命通会》书里的例子必须原样复现 —— 甲子年三月戌时 → 命坐卯宫(丁卯)', async () => {
  // 1984 = 甲子年; 辰月 = 农历三月(节气月支辰); 20:00 = 戌时
  const p = await calc({ year: 1984, month: 4, day: 20, hour: 20, minute: 0, gender: 'male' });
  assert.strictEqual(p.pillars['年柱'], '甲子', '测试盘年柱不对');
  assert.strictEqual(p.pillars['月柱'][1], '辰', '测试盘月支不对(必须是节气月支辰)');
  assert.strictEqual(p.pillars['时柱'][1], '戌', '测试盘时支不对');
  assert.strictEqual(p.minggong, '丁卯',
    '命宫必须是丁卯 —— 书上原文「甲己之年丙作首, 乃丁卯宫也」');
});

test('177-2: 老板 app 的盘 —— 命宫丁酉, 胎元辛卯, 一个字不差', async () => {
  const p = await calc({ year: 1986, month: 12, day: 17, hour: 16, minute: 20, gender: 'male', city: '上海', district: '宝山区' });
  assert.deepStrictEqual(p.pillars, { 年柱: '丙寅', 月柱: '庚子', 日柱: '乙未', 时柱: '甲申' });
  assert.strictEqual(p.taiyuan, '辛卯', '胎元不对(app: 辛卯)');
  assert.strictEqual(p.minggong, '丁酉', '命宫不对(app: 丁酉)');
});

test('177-3: 命宫**不吃公历月**, 只吃节气月支 —— 同一节气月内公历月变了, 命宫不许变', async () => {
  // 1986-12-17 与 1986-12-20 同在子月(大雪 12/7 之后), 公历月都是 12
  const a = await calc({ year: 1986, month: 12, day: 17, hour: 16, minute: 20, gender: 'male', city: '上海', district: '宝山区' });
  const b = await calc({ year: 1986, month: 12, day: 20, hour: 16, minute: 20, gender: 'male', city: '上海', district: '宝山区' });
  assert.strictEqual(a.minggong, b.minggong, '同节气月内命宫不该变');
  // 跨节气: 12/6 还在亥月(立冬后), 12/8 已进子月 ⇒ 命宫必须换宫
  const c = await calc({ year: 1986, month: 12, day: 6, hour: 16, minute: 20, gender: 'male', city: '上海', district: '宝山区' });
  assert.notStrictEqual(c.minggong, a.minggong, '跨了节气(亥月→子月)命宫还是没换, 说明还在吃公历月');
});

test('177-4: 命宫干随年干「五虎遁」起寅宫 —— 换年干, 干要跟着换', async () => {
  // 同一时辰, 年干不同 ⇒ 命宫支相同、干不同
  const p1 = await calc({ year: 1984, month: 4, day: 20, hour: 20, minute: 0, gender: 'male' }); // 甲子年
  const p2 = await calc({ year: 1994, month: 4, day: 20, hour: 20, minute: 0, gender: 'male' }); // 甲戌年
  const p3 = await calc({ year: 1985, month: 4, day: 20, hour: 20, minute: 0, gender: 'male' }); // 乙丑年
  assert.strictEqual(p1.minggong[1], p2.minggong[1], '同旬内命宫支不该变');
  assert.strictEqual(p3.minggong[1], p1.minggong[1], '月时没变, 命宫支不该变');
  // 甲/己 → 寅宫丙; 乙 → 寅宫戊 ⇒ 干必须不同
  assert.notStrictEqual(p1.minggong[0], p3.minggong[0], '年干变了(甲→乙), 命宫干必须跟着变');
  assert.strictEqual(p1.minggong, '丁卯');
  assert.strictEqual(p3.minggong, '己卯', '乙年寅宫戊 ⇒ 卯宫己');
});

test('177-5: 身宫同链逢酉 —— 与命宫相对(卯酉相冲), 本机无原文, 已标注', async () => {
  const p = await calc({ year: 1986, month: 12, day: 17, hour: 16, minute: 20, gender: 'male', city: '上海', district: '宝山区' });
  assert.strictEqual(p.minggong, '丁酉');
  assert.strictEqual(p.shengong, '辛卯', '身宫 = 命宫对宫(卯) ⇒ 辛卯');
});

