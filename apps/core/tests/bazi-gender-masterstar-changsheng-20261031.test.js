'use strict';
// 2026-10-31 (第 176 批): 老板截图圈了两处 —— 「性别:男」但日柱主星写「元女」
//
// 根因一 —— 日柱主星「元男/元女」跟错了对象:
//   旧实现 (lib/bazi/pillars.mjs 的 yuanZi) 按 **日元阴阳** 判:
//     阳日元 → 元男, 阴日元 → 元女
//   ⇒ 男命里凡阴日干 (乙丁己辛癸) 全标「元女」, 女命里凡阳日干全标「元男」
//   ⇒ **一半的盘是错的**。本盘 1986-12-17 4:20 上海宝山区男, 日主乙木(阴) → 显示「元女」。
//
//   正确口径: 「元男/元女」跟的是**命主性别**, 不是日元阴阳。
//   依据 (老板自己给的参考表, 不用推测):
//     ~/Documents/Codex/2026-10-27/pangu-process-docs/BAZI-ROUTE-119-2026-10-27.md:286
//       主星  正官  伤官  元女  偏财
//       天干  乙    辛    戊    壬
//       地支  丑    巳    辰    子
//     日柱 **戊辰** —— 戊是**阳干**, 却标「元女」。
//     ⇒ 按日元阴阳判, 阳干必标「元男」, 与原表矛盾;
//       只有「这是女命」才解释得通 ⇒ 元男/元女 = 命主性别。
//
// 根因二 —— 十二长生(星运)算错:
//   旧实现 (tools/bazi/bazi_calc.py 的 changsheng) 「阳干寅起顺行 / 阴干午起顺行」:
//     · 长生位全错 (甲长生在亥不在寅; 乙长生在午但要**逆行**)
//     · 阴干顺逆全反
//   ⇒ 阴日主的盘**四格全错**; 甲/庚/壬/丁/己/辛/癸 起点也错。
//
//   正确规则 (真源 桌面<course-source>/<course-file>:
//     · L1517 十二宫次序: 长生、沐浴、冠带、临官、帝旺、衰、病、死、墓、绝、胎、养
//     · L1156 「阳生阴死, 阳死阴生, 循环逆顺」⇒ **阳干顺行、阴干逆行**
//     · L1250-1259 阳干长生位 (甲亥 丙寅 庚巳 壬申 戊寅) + 顺行走向
//     · L1162 甲长生于亥 / L1214 庚长生于巳 / L1224 辛长生于子 / L1330 乙长生在午
//     · L1210 己土生于酉 (阴干, 逆行)
//
// 这两条都属于「取值错了不抛异常, 只是安静地返回另一个东西」那一族 ——
// 盘古这一族坑全是同一个形状 (见 2026-10-22 大运顺逆那条同族记录)。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('fs');
const { pathToFileURL } = require('node:url');

const CORE = path.join(__dirname, '..');
const PILLARS = path.join(CORE, 'web', 'app', 'lib', 'bazi', 'pillars.mjs');
const PY = path.join(CORE, 'modules', 'tools', 'bazi', 'bazi_calc.py');

// 老板截图那个盘: 1986-12-17 4:20 上海宝山区, **男**, 真太阳时
const REAL = { year: 1986, month: 12, day: 17, hour: 4, minute: 20, gender: 'male', city: '上海', district: '宝山区' };

async function calc(params) {
  const { TOOLS } = require(path.join(CORE, 'modules', 'tools'));
  const r = await TOOLS.bazi_calc({ params });
  assert.ok(r && r.ok, 'bazi_calc 调用失败: ' + JSON.stringify(r).slice(0, 300));
  return (r.data && r.data.pillars) || {};
}

// ═══════════════════════════════════════════════════════════════
// 根因一: 日柱主星 = 命主性别, 不是日元阴阳
// ═══════════════════════════════════════════════════════════════

test('176-1: 男命(阴日干) 日柱主星必须是「元男」, 不是「元女」', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  // 本盘日主乙木 = 阴。旧口径在这里会输出「元女」。
  const chart = {
    pillars: { '年柱': '丙寅', '月柱': '庚子', '日柱': '乙未', '时柱': '戊寅' },
    day_master: '乙', day_master_wuxing: '木', day_master_yinyang: '阴',
    gender: 'male',
  };
  assert.strictEqual(m.yuanZi(chart), '元男', '男命必须是元男');
  assert.strictEqual(m.masterStar(chart, '日柱'), '元男');
});

test('176-2: 阳日干女命必须是「元女」(旧口径会输出「元男」)', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  const chart = {
    pillars: { '年柱': '乙丑', '月柱': '辛巳', '日柱': '戊辰', '时柱': '壬子' },
    day_master: '戊', day_master_wuxing: '土', day_master_yinyang: '阳',
    gender: 'female',
  };
  // 老板给的参考表就是这个盘 (BAZI-ROUTE-119-2026-10-27.md:286) —— 日柱标「元女」
  assert.strictEqual(m.yuanZi(chart), '元女', '女命必须是元女');
});

test('176-3: 元男/元女只跟性别走 —— 同一个盘换性别必须换字', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  const base = { day_master: '癸', day_master_wuxing: '水', day_master_yinyang: '阴' };
  assert.strictEqual(m.yuanZi({ ...base, gender: 'male' }), '元男');
  assert.strictEqual(m.yuanZi({ ...base, gender: 'female' }), '元女');
  // 日元阴阳**完全不影响**这个字
  const yang = { day_master: '戊', day_master_yinyang: '阳' };
  assert.strictEqual(m.yuanZi({ ...yang, gender: 'male' }), '元男');
  assert.strictEqual(m.yuanZi({ ...yang, gender: 'female' }), '元女');
});

test('176-4: 性别认不出来时显示「-」, 不许拿日元阴阳顶替', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  assert.strictEqual(m.yuanZi({ day_master: '癸', day_master_yinyang: '阴' }), '-');
  assert.strictEqual(m.yuanZi({ day_master: '戊', day_master_yinyang: '阳' }), '-');
  assert.strictEqual(m.yuanZi({}), '-');
});

test('176-5: 性别值认人话 —— 男/男命/乾/M 都算男', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  for (const g of ['男', '男性', '男命', '乾', 'male', 'M', 'Male']) {
    assert.strictEqual(m.yuanZi({ gender: g }), '元男', '性别值「' + g + '」应识别为男');
  }
  for (const g of ['女', '女性', '女命', '坤', 'female', 'F']) {
    assert.strictEqual(m.yuanZi({ gender: g }), '元女', '性别值「' + g + '」应识别为女');
  }
});

test('176-6: 后端 gender 必须归一化 —— 传「男」不许在摘要里显示成「女」', async () => {
  const { TOOLS } = require(path.join(CORE, 'modules', 'tools'));
  const r = await TOOLS.bazi_calc({ params: { ...REAL, gender: '男' } });
  assert.ok(r && r.ok, 'bazi_calc 调用失败');
  assert.strictEqual(r.data.input.gender, 'male', '外层 input.gender 必须是归一化后的 male');
  const p = r.data.pillars;
  assert.strictEqual(p.gender, 'male', '顶层 gender 必须是归一化后的 male');
});

// ═══════════════════════════════════════════════════════════════
// 根因二: 十二长生 = 阳干顺行 / 阴干逆行 + 各干长生位不同
// ═══════════════════════════════════════════════════════════════

// 真源: 三命通会 L1156「阳生阴死, 阳死阴生, 循环逆顺」
//       + L1250-1259 阳干长生位 + L1162/1210/1214/1224/1330 阴干长生位
const CS_EXPECT = {
  // 甲: 长生亥, 顺行 ⇒ 亥长生 子沐浴 丑冠带 寅临官 卯帝旺 辰衰 巳病 午死 未墓 申绝 酉胎 戌养
  '甲': { 亥: '长生', 寅: '临官', 卯: '帝旺', 午: '死', 未: '墓' },
  // 乙: 长生午, 逆行 ⇒ 午长生 巳沐浴 辰冠带 卯临官 寅帝旺 丑衰 子病 亥死 戌墓 酉绝 申胎 未养
  '乙': { 午: '长生', 寅: '帝旺', 子: '病', 未: '养', 辰: '冠带' },
  // 丙戊: 长生寅, 顺行 ⇒ 寅长生 卯沐浴 辰冠带 巳临官 午帝旺 未衰 申病 酉死 戌墓 亥绝 子胎 丑养
  '丙': { 寅: '长生', 巳: '临官', 午: '帝旺', 酉: '死' },
  '戊': { 寅: '长生', 巳: '临官', 午: '帝旺', 酉: '死' },
  // 丁己: 长生酉, 逆行 ⇒ 酉长生 申沐浴 未冠带 午临官 巳帝旺 辰衰 卯病 寅死 丑墓 子绝 亥胎 戌养
  '丁': { 酉: '长生', 巳: '帝旺', 申: '沐浴' },
  '己': { 酉: '长生', 巳: '帝旺', 申: '沐浴' },
  // 庚: 长生巳, 顺行 ⇒ 巳长生 午沐浴 未冠带 申临官 酉帝旺 戌衰 亥病 子死 丑墓 寅绝 卯胎 辰养
  '庚': { 巳: '长生', 申: '临官', 酉: '帝旺', 子: '死' },
  // 辛: 长生子, 逆行 ⇒ 子长生 亥沐浴 戌冠带 酉临官 申帝旺 未衰 午病 巳死 辰墓 卯绝 寅胎 丑养
  '辛': { 子: '长生', 申: '帝旺', 亥: '沐浴' },
  // 壬: 长生申, 顺行 ⇒ 申长生 酉沐浴 戌冠带 亥临官 子帝旺 丑衰 寅病 卯死 辰墓 巳绝 午胎 未养
  '壬': { 申: '长生', 亥: '临官', 子: '帝旺', 卯: '死' },
  // 癸: 长生卯, 逆行 ⇒ 卯长生 寅沐浴 丑冠带 子临官 亥帝旺 戌衰 酉病 申死 未墓 午绝 巳胎 辰养
  '癸': { 卯: '长生', 亥: '帝旺', 寅: '沐浴' },
};

test('176-7: 十二长生: 各干长生位 + 阳顺阴逆 (逐干逐格对照三命通会)', async () => {
  const { TOOLS } = require(path.join(CORE, 'modules', 'tools'));
  // 直接调 python 里的 changsheng, 不绕工具层 —— 这一条只验算法本身。
  const { execFileSync } = require('node:child_process');
  const py = `
import sys, json
sys.path.insert(0, ${JSON.stringify(path.dirname(PY))})
import importlib.util
spec = importlib.util.spec_from_file_location('bc', ${JSON.stringify(PY)})
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)
out = {}
for gan, table in ${JSON.stringify(CS_EXPECT)}.items():
    out[gan] = {z: bc.changsheng(gan, z) for z in table}
print(json.dumps(out, ensure_ascii=False))
`;
  const raw = execFileSync('/usr/bin/python3', ['-c', py], { encoding: 'utf-8' });
  const got = JSON.parse(raw.trim());
  for (const gan of Object.keys(CS_EXPECT)) {
    for (const [zhi, want] of Object.entries(CS_EXPECT[gan])) {
      assert.strictEqual(got[gan][zhi], want,
        gan + ' 在' + zhi + ' 应为「' + want + '」, 实为「' + got[gan][zhi] + '」');
    }
  }
});

test('176-8: 本盘星运必须是 帝旺/病/养/帝旺 (旧口径给的是 墓/病/沐浴/墓)', async () => {
  const p = await calc(REAL);
  assert.deepStrictEqual(p.pillars,
    { '年柱': '丙寅', '月柱': '庚子', '日柱': '乙未', '时柱': '戊寅' },
    '四柱不该变 (改的只是星运)');
  assert.strictEqual(p.day_master, '乙');
  // 乙长生在午、阴干逆行 ⇒ 寅帝旺 / 子病 / 未养 / 寅帝旺
  assert.deepStrictEqual(p.changsheng_4,
    { '年柱': '帝旺', '月柱': '病', '日柱': '养', '时柱': '帝旺' },
    '星运算错了 —— 乙木逆行: 寅帝旺 子病 未养');
});

test('176-9: 阴日主的盘不能四格全错 —— 旧实现阴干也顺行', async () => {
  // 乙木(阴) 日主: 旧实现 pos=午 但**顺行** ⇒ 寅算成「墓」。
  // 现在阴干必须逆行。
  const p = await calc({ year: 1986, month: 12, day: 17, hour: 4, minute: 20, gender: 'male', city: '上海', district: '宝山区' });
  assert.notStrictEqual(p.changsheng_4['年柱'], '墓', '阴干顺行 ⇒ 寅被算成墓, 这是旧 bug');
  assert.strictEqual(p.changsheng_4['年柱'], '帝旺');
});

test('176-10: 星运那行不许静默消失 —— 认不出的干给「-」而不是编一个', async () => {
  const { execFileSync } = require('node:child_process');
  const py = `
import importlib.util
spec = importlib.util.spec_from_file_location('bc', ${JSON.stringify(PY)})
bc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bc)
print(bc.changsheng('X', '子'), bc.changsheng('甲', 'X'))
`;
  const out = execFileSync('/usr/bin/python3', ['-c', py], { encoding: 'utf-8' }).trim();
  assert.strictEqual(out, '- -', '认不出的干/支必须给「-」, 不许猜');
});

// ═══════════════════════════════════════════════════════════════
// 防回归: 页面不许再出现「性别男 + 元女」这种自相矛盾
// ═══════════════════════════════════════════════════════════════

test('176-11: 四柱表主星行不许再跟日元阴阳绑定', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  const src = fs.readFileSync(PILLARS, 'utf-8');
  // yuanZi 里不许再出现 day_master_yinyang
  const fn = src.slice(src.indexOf('export function yuanZi'), src.indexOf('export function masterStar'));
  assert.ok(!fn.includes('day_master_yinyang'),
    'yuanZi 又开始拿日元阴阳判元男/元女了 —— 口径是命主性别');
});

test('176-12: 性别摘要在 unknown 时不许显示「女」', () => {
  const src = fs.readFileSync(path.join(CORE, 'web', 'app', 'views', 'bazi.mjs'), 'utf-8');
  assert.ok(!/性别 ' \+ \(inp\.gender === 'male' \? '男' : '女'\)/.test(src),
    "摘要里的性别仍是二元判断 —— unknown 会被显示成「女」");
});

// ═══════════════════════════════════════════════════════════════
// 根因三: 年岁按**虚岁**、按**立春**分界 (老板 2026-10-31 明说)
// ═══════════════════════════════════════════════════════════════
//
// 老板给了上课 app 的盘当参照 (1986-12-17 16:20 上海宝山 男):
//   app  大运: 1993 辛丑 / 2003 壬寅 / 2013 癸卯 / ... 虚岁 8/18/28/...
//   app  流年: 1993 癸酉 8岁 ... 2002 壬午 17岁
//   app  起运: 出生后6年6月3天16时
//
// 旧实现的两个错:
//   1. 起始年份 = 出生年 + 整年 (丢月份) ⇒ 1992, 应为 **1993**
//   2. 虚岁 = floor(起运岁数) ⇒ 6岁, 应为 **8岁**
//      (6.51 岁是在 1993 年 6 月, 那年虚岁 8)
//
// 参照来源: 老板上课 app 截图 (2026-10-31 发的五张图)
test('176-13: 大运起始年 = 起运时刻落在的那一年 (不是 出生年+整年)', async () => {
  const p = await calc(REAL);
  const list = p.dayun['列表'];
  assert.ok(list && list.length === 10, '大运没排出来');
  // 起运 6年6月 ⇒ 1993 年 6 月 ⇒ 起始年 1993
  assert.strictEqual(list[0]['起始年份'], 1993, '第一步大运起始年应是 1993');
  assert.strictEqual(list[1]['起始年份'], 2003);
  assert.strictEqual(list[9]['起始年份'], 2083);
});

test('176-14: 虚岁按「起始年 − 出生年 + 1」算, 不许截断起运小数', async () => {
  const p = await calc(REAL);
  const list = p.dayun['列表'];
  // 老板 app: 1993 → 8岁, 2003 → 18岁, 2083 → 98岁
  assert.deepStrictEqual(list.map((d) => d['起始虚岁']),
    [8, 18, 28, 38, 48, 58, 68, 78, 88, 98],
    '虚岁与老板 app 不一致');
  // 旧口径的错: floor(6.51) = 6
  assert.notStrictEqual(Math.floor(list[0]['起始年龄']), list[0]['起始虚岁'],
    '虚岁不能是起运岁数截断来的');
});

test('176-15: 立春前出生 ⇒ 虚岁基准年减一 (与年柱同一把尺子)', async () => {
  // 1986-12-17 出生 → 已过 1986 立春 ⇒ 基准年 1986 ⇒ 1993 年虚岁 8
  const p = await calc(REAL);
  assert.strictEqual(p.birth_lichun_year, 1986, '1986-12-17 已过立春, 基准年应是 1986');
  // 1 月初出生 ⇒ 未过立春 ⇒ 基准年减一
  const p2 = await calc({ year: 1986, month: 1, day: 5, hour: 10, minute: 0, gender: 'male', city: '上海', district: '宝山区' });
  assert.strictEqual(p2.birth_lichun_year, 1985, '1 月初出生未过立春, 基准年应是 1985');
});

test('176-16: 前端虚岁不许用 floor(起始年龄) 当虚岁', () => {
  const src = fs.readFileSync(path.join(CORE, 'web', 'app', 'views', 'bazi.mjs'), 'utf-8');
  assert.ok(!/Math\.floor\(Number\(d\['起始年龄'\] \|\| 0\)\) \+ '岁'/.test(src),
    "大运虚岁还是 floor(起始年龄) —— 那是把 6.51 岁截成 6 岁");
  assert.ok(/起始虚岁/.test(src), '前端没用后端算好的「起始虚岁」');
});

// ═══════════════════════════════════════════════════════════════
// 根因四: 真太阳时**漏了均时差**
// ═══════════════════════════════════════════════════════════════
//
// 老板 app 对照: 上海宝山 1986-12-17 16:20 → 真太阳时 **16:29**
//   经度修正 (121.49-120)*4 = +5.96 分 ⇒ 16:25.96 ⇒ **16:26** (对不上)
//   加均时差 (12/17 约 +3.25 分) ⇒ +9.21 ⇒ **16:29** ✓ 分毫不差
// 均时差最大 ±16 分 ⇒ 足以跨时辰边界把时柱排错。
test('176-17: 真太阳时必须含均时差 (老板 app 16:29 对照)', async () => {
  const p = await calc({ year: 1986, month: 12, day: 17, hour: 16, minute: 20, gender: 'male', city: '上海', district: '宝山区' });
  const st = p.solar_time_source;
  assert.ok(Math.abs(st['均时差(分钟)'] - 3.25) < 0.5,
    '12 月 17 日均时差应约 +3.25 分, 实为 ' + st['均时差(分钟)']);
  assert.ok(Math.abs(st['经度修正(分钟)'] - 6.0) < 0.5,
    '上海经度修正应约 +6 分, 实为 ' + st['经度修正(分钟)']);
  // 合计修正后: 16:20 + 9.21 分 = 16:29
  assert.strictEqual(p.adjusted_hour, 16);
  assert.strictEqual(p.adjusted_minute, 29, '真太阳时应是 16:29, 与老板 app 一致');
});

test('176-18: 均时差要拆开给 —— 不许只给一个总修正分钟数', async () => {
  const p = await calc(REAL);
  const st = p.solar_time_source;
  for (const k of ['均时差(分钟)', '经度修正(分钟)', '合计修正(分钟)']) {
    assert.ok(st[k] !== undefined, '缺少字段: ' + k);
  }
  assert.ok(Math.abs((st['均时差(分钟)'] + st['经度修正(分钟)']) - st['合计修正(分钟)']) < 0.05,
    '均时差 + 经度修正 应等于合计修正');
});

// ═══════════════════════════════════════════════════════════════
// 全盘对照: 老板上课 app 的盘 (1986-12-17 16:20 上海宝山 男)
// ═══════════════════════════════════════════════════════════════
test('176-19: 整盘对照老板上课 app —— 四柱/星运/大运/虚岁 全部对齐', async () => {
  const p = await calc({ year: 1986, month: 12, day: 17, hour: 16, minute: 20, gender: 'male', city: '上海', district: '宝山区' });
  // 四柱
  assert.deepStrictEqual(p.pillars,
    { '年柱': '丙寅', '月柱': '庚子', '日柱': '乙未', '时柱': '甲申' },
    '四柱与老板 app 不一致');
  assert.strictEqual(p.day_master, '乙');
  // 星运 (app: 帝旺 病 养 胎) —— 乙木长生在午、阴干逆行
  assert.deepStrictEqual(p.changsheng_4,
    { '年柱': '帝旺', '月柱': '病', '日柱': '养', '时柱': '胎' },
    '星运与老板 app 不一致');
  // 大运: 顺排, 辛丑起, 1993 起, 8虚岁
  const list = p.dayun['列表'];
  assert.strictEqual(p.dayun['排法'], '顺排');
  assert.deepStrictEqual(list.map((d) => d['干支']),
    ['辛丑', '壬寅', '癸卯', '甲辰', '乙巳', '丙午', '丁未', '戊申', '己酉', '庚戌'],
    '大运干支与老板 app 不一致');
  assert.deepStrictEqual(list.map((d) => d['起始年份']),
    [1993, 2003, 2013, 2023, 2033, 2043, 2053, 2063, 2073, 2083]);
  assert.deepStrictEqual(list.map((d) => d['起始虚岁']),
    [8, 18, 28, 38, 48, 58, 68, 78, 88, 98]);
});

test('176-20: 流年干支以立春为界 (老板 app: 1993 癸酉)', async () => {
  const p = await calc(REAL);
  const y1993 = (p.liunian || []).find((y) => Number(y['年份']) === 1993);
  assert.ok(y1993, '没有 1993 年');
  assert.strictEqual(y1993['干支'], '癸酉', '1993 年干支应是以立春为界的癸酉');
});

// ═══════════════════════════════════════════════════════════════
// 根因三 (第二版) —— 大运起始年必须按**真实日历**加年月, 不许粗判
//
// 起因: 176-13~176-20 写完第一版时, 起始年用的是
//   `year + _qy_years + (1 if (_qy_months or _qy_days) else 0)`
//   —— 「只要有月有日就+1年」。
//   这个粗判在老板 app 那个盘 (1986-12-17 起运 6年6月) 恰好对:
//     12月 + 6个月 ⇒ 1993-06 ⇒ 确实跨年了。
//   但它**不成立**: 1978-07-14 起运 8年1月1天 ⇒ 1986-08-14, 仍在 1986 年内,
//   粗判却把它推成 1987 ⇒ 把 tool-result-fidelity-20261012 的
//   ①A-5 断言 (1978-07-14 那盘大运首运起始年 = 1986) 打挂了。
//
// 正确做法: 把 (年, 月, 天) 加到出生日期上, 取那一天的年份。
//   老板 app 对照: 1986-12-17 + 6年6月 = 1993-06 ⇒ 起始年 1993 ✓
//   1978-07-14 + 8年1月 = 1986-08 ⇒ 起始年 1986 ✓
// ═══════════════════════════════════════════════════════════════
test('176-21: 大运起始年按真实日历加年月 —— 跨年才 +1, 不跨年不许乱加', async () => {
  // 1978-07-14 男: 起运 8年1月1天 ⇒ 1986-08-14 ⇒ 起始年 **1986** (不是 1987)
  const p78 = await calc({ year: 1978, month: 7, day: 14, hour: 23, minute: 0, gender: 'male' });
  assert.strictEqual(p78.dayun['列表'][0]['起始年份'], 1986,
    '1978-07-14 起运 8年1月 ⇒ 起始年应是 1986, 粗判会错成 1987');
  assert.strictEqual(p78.dayun['列表'][0]['干支'], '庚申');

  // 老板 app 对照: 1986-12-17 起运 6年6月 ⇒ 1993-06 ⇒ 起始年 **1993**
  const p86 = await calc({ year: 1986, month: 12, day: 17, hour: 16, minute: 20, gender: 'male', city: '上海', district: '宝山区' });
  assert.strictEqual(p86.dayun['列表'][0]['起始年份'], 1993,
    '1986-12-17 起运 6年6月 ⇒ 起始年应是 1993');

  // 源头不许再出现「有月就+1年」这种粗判
  const py = fs.readFileSync(PY, 'utf8');
  assert.ok(!/1\s*if\s*\(\s*_qy_months/.test(py),
    'bazi_calc.py 里还有「有月份就 +1 年」的粗判 —— 起始年会跨年算错');
  assert.ok(/_add_years_months_days/.test(py),
    'bazi_calc.py 没按真实日历加年月 —— 起始年会跨年算错');
});

test('176-22: 大运起始日期要能给出来 —— 起运时刻是具体一天, 不只是年份', async () => {
  const p = await calc({ year: 1986, month: 12, day: 17, hour: 16, minute: 20, gender: 'male', city: '上海', district: '宝山区' });
  assert.strictEqual(p.dayun['列表'][0]['起始日期'], '1993-06-21',
    '1986-12-17 + 6年6月4天 ⇒ 1993-06-21');
  assert.strictEqual(p.dayun['列表'][9]['起始日期'], '2083-06-21');
});

// ═══════════════════════════════════════════════════════════════
// 根因四 —— 真太阳时在页面上被藏起来了
//
// 旧写法 (`views/bazi.mjs` 的 solarHint):
//   只在「近似值 / 没命中城市」时才显示。
//   ⇒ 命中**精确区县经度**时 (上海宝山区) 反而**不显示**。
// 但真太阳时恰恰是**时柱的依据** ——
//   钟表 16:20 → 真太阳时 16:29, 差 9 分钟就可能跨时辰边界, 时柱整个换掉。
//   老板要拿自己上课 app 的盘跟盘古对 ⇒ 这个数不许藏。
// ═══════════════════════════════════════════════════════════════
test('176-23: 真太阳时必须一直显示 —— 命中精确经度时也不许藏', () => {
  const v = fs.readFileSync(path.join(CORE, 'web', 'app', 'views', 'bazi.mjs'), 'utf8');
  assert.ok(/真太阳时:/.test(v), '页面没有「真太阳时」字样');
  // 旧写法是 `if (inp.use_solar_time && (_st['近似值'] || ...))` —— 精确命中就不显示
  assert.ok(!/use_solar_time\s*&&\s*\(\s*_st\['近似值'\]/.test(v),
    '真太阳时又退回「只在近似值时显示」了 —— 精确命中时老板看不见时柱依据');
  assert.ok(/solar_date/.test(v), '页面没拿 solar_date —— 显示的还是钟表时, 不是真太阳时');
});


// ═══════════════════════════════════════════════════════════════
// 第 176 批第二批 —— 跟老板上课 app 的盘面结构对齐
//
// 老板 2026-10-31 补发了上课 app 的五张排盘截图 (1986-12-17 16:20 上海宝山区 男)
// 当参照, 说「这是我上课的app给的命盘, 有差异」。
// app 的盘面比盘古多四样, 全部照 app 补齐:
//
//   ① 自坐行  长生/死/养/绝
//      查法: **每柱天干坐自己地支**的十二长生位 (跟「星运」完全是两回事:
//             星运 = 日主在四柱地支上的位置)
//      真源: 十二长生表 (三命通会 L1156 阳顺阴逆) + 老板 app 交叉验证 4/4
//   ② 空亡行  戌亥/辰巳/辰巳/午未
//      查法: **每柱按自己所在旬**算, 不是全盘一个值
//      真源: 老板上课课件《08 命局神煞详解》p14「空亡查法」
//   ③ 逐柱神煞  (11 条命中, 零漏零错)
//      模型跟旧版不同: 旧版是「一个神煞 → 全盘哪些支」, app 是**逐柱**:
//      每一柱列它自己命中的神煞。依据(年干/日干/年支/日支)与落点(哪根柱)是两件事。
//      真源: 老板上课课件《09 命局神煞详解及调理方案(下)》p1/p3/p5/p10/p11/p14/p15
//   ④ 交运  逢癸、戊年, 芒种后15天交大运
//      = 交运日(1993-06-21) 的日干支是**癸酉** (逢癸日) + 从芒种(06-06)算第15天
// ═══════════════════════════════════════════════════════════════

const APP_SHENSHA = {
  '年柱': ['羊刃', '秀贵人', '亡神'],
  '月柱': ['天乙贵人', '太极贵人', '吊客', '桃花', '灾煞'],
  '日柱': ['华盖', '童子煞'],
  '时柱': ['天乙贵人', '文昌贵人', '天德合', '秀贵人', '驿马', '劫煞'],
};
// ⚠ 2026-10-31 第 179 批: 神煞整体撤下, 这张表**只作参照留着** ——
//   补齐秀贵人/童子煞/天德合/吊客四条的查法后, 拿它当「app 完整口径」再一次性放出来。

test('176-24: 自坐行 = 每柱天干坐自己地支 (老板 app: 长生/死/养/绝)', async () => {
  const p = await calc({ year: 1986, month: 12, day: 17, hour: 16, minute: 20, gender: 'male', city: '上海', district: '宝山区' });
  assert.deepStrictEqual(p.zichuan_4,
    { '年柱': '长生', '月柱': '死', '日柱': '养', '时柱': '绝' },
    '自坐行与老板 app 不一致');
  // 自坐跟星运必须是**两回事**: 乙日主在寅是帝旺, 但丙寅柱自坐是长生
  assert.strictEqual(p.changsheng_4['年柱'], '帝旺');
  assert.strictEqual(p.zichuan_4['年柱'], '长生',
    '自坐混进星运了 —— 自坐是本柱天干坐本柱地支');
});

test('176-25: 空亡行 = 每柱按自己所在旬 (老板 app: 戌亥/辰巳/辰巳/午未)', async () => {
  const p = await calc({ year: 1986, month: 12, day: 17, hour: 16, minute: 20, gender: 'male', city: '上海', district: '宝山区' });
  assert.deepStrictEqual(p.xunkong_4,
    { '年柱': '戌亥', '月柱': '辰巳', '日柱': '辰巳', '时柱': '午未' },
    '空亡行与老板 app 不一致');
  // 关键: 四柱**不能**同一个值 (丙寅甲子旬 / 庚子甲午旬 / 乙未甲午旬 / 甲申甲申旬)
  const vals = Object.values(p.xunkong_4);
  assert.ok(new Set(vals).size > 1, '四柱空亡全一样 —— 算成了「全盘一个值」');
});

test('176-26: 逐柱神煞输出 —— 179 批撤下, 182 批按课件补齐后恢复', async () => {
  // 2026-10-31 第 179 批: 老板「神煞部分你不全, 那还不如先不做」⇒ 整块撤下。
  // 第 182 批: 神煞表按课件 08/09 全量补齐 (老板盘 16 条逐字校验过), 恢复输出。
  //   这条改钉「字段在, 且逐柱结构对」, 不再钉「字段不存在」。
  const p = await calc({ year: 1986, month: 12, day: 17, hour: 16, minute: 20, gender: 'male', city: '上海', district: '宝山区' });
  assert.ok('shensha_by_pillar' in p, 'shensha_by_pillar 应该输出 (182 批恢复)');
  // 键序按 pillar_shensha 的 _PILLAR_NAMES 原序 (年/月/日/时), 不许拿 sort 掩盖顺序错位
  assert.deepStrictEqual(Object.keys(p.shensha_by_pillar), ['年柱', '月柱', '日柱', '时柱']);
  assert.ok(!('shensha' in p), '老键 shensha (按神煞列支那张表) 仍不该再输出');
});

test('176-28: 交运日 = 起运时刻那天, 日干支与节气都要给 (app: 逢癸、戊年, 芒种后15天)', async () => {
  const p = await calc({ year: 1986, month: 12, day: 17, hour: 16, minute: 20, gender: 'male', city: '上海', district: '宝山区' });
  assert.strictEqual(p.dayun['交运日期'], '1993-06-21', '交运日不对');
  assert.strictEqual(p.dayun['交运日干支'], '癸酉',
    '交运日干支应是癸酉 —— app 说「逢癸、戊年」正是指交运日的日干');
  assert.ok(p.dayun['交运节气'], '没给交运节气');
  // 交运日必须跟第一步大运的起始日期一致
  assert.strictEqual(p.dayun['列表'][0]['起始日期'], '1993-06-21');
});

test('176-29: 羊刃口径统一到课件 —— 阴干不许再用「阴刃」那套 (神煞已撤, 口径留着备将来)', async () => {
  // 课件 p14: 甲卯 乙寅 丙戊午 丁己巳 庚酉 辛申 壬子 癸亥
  // 旧盘古表混着两把尺子(阳干一套 + 阴刃一套), 乙日算不出寅 ⇒ app 的年柱羊刃对不上
  // ⚠ 第 179 批神煞整体撤下 ⇒ 这个断言改成钉「字段不存在」,
  //   羊刃表的查法知识留在 bazi_calc.py 的 SHENSHA 注释里, 补齐时直接复用。
  const p = await calc({ year: 1979, month: 5, day: 6, hour: 6, minute: 56, gender: 'male' });
  assert.ok(!('shensha' in p), '神煞已撤, 不该再有 shensha 字段');
});

test('176-30: 四柱表要有自坐/空亡两行, 行序按 app (神煞行 182 批恢复, 排在空亡后)', async () => {
  const m = await import(pathToFileURL(PILLARS).href);
  const labels = m.pillarRows({ pillars: {}, day_master: '乙' }).map((r) => r.label);
  // 2026-11-04 (UI 重写 · 样稿终版): 天干/地支两行合并成一行「干支」, 行序其余不动
  assert.deepStrictEqual(labels,
    ['主星', '干支', '藏干', '副星', '星运', '自坐', '纳音', '空亡', '神煞'],
    '四柱表行序不对 —— app 的顺序是 星运/自坐/纳音/空亡, 神煞行 (182 批恢复) 在最后');
});

test('176-31: 大运表的「性运」= 日主坐大运地支的十二长生 (不是大运干坐自己支)', async () => {
  // 老板 app 1986-12-17 盘 (乙日) 的大运性运:
  //   辛丑衰 壬寅帝旺 癸卯临官 甲辰冠带 乙巳沐浴
  //   丙午长生 丁未养   戊申胎   己酉绝   庚戌墓
  const p = await calc({ year: 1986, month: 12, day: 17, hour: 16, minute: 20, gender: 'male', city: '上海', district: '宝山区' });
  const list = p.dayun['列表'];
  assert.deepStrictEqual(list.map((d) => d['性运']),
    ['衰', '帝旺', '临官', '冠带', '沐浴', '长生', '养', '胎', '绝', '墓'],
    '大运性运跟 app 不一致');
  // 反例: 若误用「大运干坐自己地支」(自坐), 第一步辛丑应该是「养」而不是「衰」
  assert.notStrictEqual(list[0]['性运'], '养', '性运算成了大运干坐自己地支(自坐)');
});
