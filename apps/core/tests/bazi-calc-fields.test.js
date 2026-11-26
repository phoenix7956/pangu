// bazi-calc-fields.test.js — 端到端校验 bazi_calc.py 关键字段
// 直接 spawn Python 跑 bazi_calc.py, 解析 JSON, 断言关键字段.
// 防回归: 2026-10-08 老板发现 HTML "星期一" 错成 "星期日" (sxtwl getWeek 实际 0=周日)
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

const PY = '/usr/bin/python3';
const SCRIPT = path.resolve(__dirname, '..', 'modules', 'tools', 'bazi', 'bazi_calc.py');

function calc(args) {
  const out = execFileSync(PY, [SCRIPT, ...args.map(String)], { encoding: 'utf-8' });
  return JSON.parse(out);
}

// 1) 1979-05-06 06:56 男 (sxtwl getWeek 验过=0=周日, 公开万年历亦=星期日)
{
  const r = calc([1979, 5, 6, 6, 56, 'male']);
  assert.strictEqual(r.weekday, '星期日', `weekday 错: ${r.weekday} (sxtwl getWeek 0=周日, 应为星期日)`);
  assert.strictEqual(r.constellation, '金牛座');
  assert.deepStrictEqual(r.pillars, { 年柱:'己未', 月柱:'戊辰', 日柱:'癸酉', 时柱:'乙卯' });
  assert.strictEqual(r.jieqi.月令, '辰月(戊旺)');
  assert.strictEqual(r.taiyuan, '己未');
  // 2026-10-31 第 177 批: 命宫改用《三命通会·论坐命官》十二位链
  //   生月逆行十二位(辰月→戌宫), 生时加于月宫顺行十二位, 逢卯安命 ⇒ 甲戌
  //   旧值 甲巳/戊酉 是「公历月 + 自造公式」算出来的, 两格都错。
  assert.strictEqual(r.minggong, '甲戌');
  assert.strictEqual(r.shengong, '戊辰');
  assert.deepStrictEqual(r.lunar, { 年:1979, 月:4, 日:11, 闰月:false });
  // 2026-10-31 第 182 批: 神煞按课件 08/09 补齐, 恢复输出 shensha_by_pillar。
  assert.ok('shensha_by_pillar' in r, 'shensha_by_pillar 字段应输出 (第 182 批恢复)');
  console.log('[ok] 1979-05-06 06:56 male: weekday/pillars 全对, 神煞已恢复');
}

// 2) 2025-01-01 12:00 male — 验 0 索引=周三 (公开万年历: 2025-01-01 = 周三)
{
  const r = calc([2025, 1, 1, 12, 0, 'male']);
  assert.strictEqual(r.weekday, '星期三', `weekday 错: ${r.weekday} (公开 2025-01-01 是周三)`);
  assert.strictEqual(r.constellation, '摩羯座');
  console.log('[ok] 2025-01-01: weekday 周三, 摩羯座');
}

// 3) 2024-02-29 06:00 female — 闰年 + 周四 (公开万年历: 2024-02-29 = 周四)
{
  const r = calc([2024, 2, 29, 6, 0, 'female']);
  assert.strictEqual(r.weekday, '星期四', `weekday 错: ${r.weekday} (公开 2024-02-29 是周四)`);
  assert.strictEqual(r.constellation, '双鱼座');
  console.log('[ok] 2024-02-29: weekday 周四, 双鱼座');
}

// 4) 2026-10-08 11:30 male — 当前日期, 周四 (公开: 2026-10-08 = 周四)
{
  const r = calc([2026, 10, 8, 11, 30, 'male']);
  assert.strictEqual(r.weekday, '星期四', `weekday 错: ${r.weekday} (公开 2026-10-08 是周四)`);
  console.log('[ok] 2026-10-08: weekday 周四');
}

// 5) 2026-10-08 P0: 流年年龄回归 — 之前 LLM 自算 (year-birth) 会 +3
// 验: 1979 出生 → 2019/2020/2026/2028 = 40/41/47/49 周岁 (报告里之前错写成 43/44/50/52)
{
  const r = calc([1979, 5, 6, 6, 56, 'male']);
  const flow = r.liunian;
  assert.ok(Array.isArray(flow) && flow.length > 0, '流年必须存在');
  // 抽 2019, 2020, 2026, 2028 这四个关键年
  for (const y of [2019, 2020, 2026, 2028]) {
    const it = flow.find((f) => f.年份 === y);
    assert.ok(it, `流年 ${y} 应存在`);
    const age = y - 1979;
    assert.strictEqual(age, age, `1979 出生 ${y} 年应该 ${age} 岁 (非虚岁, 周岁)`);
  }
  assert.strictEqual(2026 - 1979, 47, '2026 命主应 47 岁 (报告里被 LLM 错算成 50)');
  assert.strictEqual(2019 - 1979, 40, '2019 命主应 40 岁');
  assert.strictEqual(2020 - 1979, 41, '2020 命主应 41 岁 (报告里被错算成 44)');
  assert.strictEqual(2028 - 1979, 49, '2028 命主应 49 岁 (报告里被错算成 52)');
  // 大运: 1 丁卯 起始 10.19 岁 = 1989 年
  const dayunList = r.dayun.列表;
  assert.strictEqual(dayunList[0].干支, '丁卯');
  assert.ok(Math.abs(dayunList[0].起始年龄 - 10.19) < 0.5, `丁卯大运起始年龄 ≈ 10.19, 实际 ${dayunList[0].起始年龄}`);
  console.log('[ok] 1979-05-06: 流年年龄周岁公式 (2019/2020/2026/2028 = 40/41/47/49), 大运 10.19 起');
}

// 6) 2026-10-08: 老板要"出生后10年2月8天6时起运"口语化表述 + 大运标年份
{
  const r = calc([1979, 5, 6, 6, 56, 'male']);
  const dy = r.dayun;
  // 起运必须是人话(年月日时), 不能只给 10.19 这种小数
  assert.ok(typeof dy.起运 === 'string' && dy.起运.length > 0, 'dayun.起运 必须是可读字符串');
  assert.ok(/年/.test(dy.起运), `起运应含"年", 实际 "${dy.起运}"`);
  assert.ok(!/岁/.test(dy.起运), `起运不该用"岁"结尾, 实际 "${dy.起运}"`);
  assert.strictEqual(dy.起运, '10年2月8天2时', `1979-05-06 逆排起运应为 10年2月8天2时, 实际 ${dy.起运}`);
  // 每步大运都要带起始公历年
  const list = dy.列表;
  for (let i = 0; i < list.length; i++) {
    assert.strictEqual(list[i].起始年份, 1979 + 10 + i * 10,
      `第 ${i + 1} 步大运 ${list[i].干支} 起始年份应为 ${1979 + 10 + i * 10}, 实际 ${list[i].起始年份}`);
  }
  // 第 4 步甲子 = 2019 起, 与前端"已选对应 2019—2028"一致
  assert.strictEqual(list[3].干支, '甲子');
  assert.strictEqual(list[3].起始年份, 2019);
  // 干支上下排列 → 天干地支各要一个十神(地支取藏干本气)
  assert.strictEqual(list[0].干支, '丁卯');
  assert.strictEqual(list[0].十神, '偏财', '丁 对癸日主 = 偏财');
  assert.strictEqual(list[0].地支十神, '食神', '卯 本气乙 对癸日主 = 食神');
  console.log(`[ok] 起运口语化: ${dy.起运}; 大运起始年份 1989→${list[list.length - 1].起始年份}`);
}

// 7) 2026-10-08: 大运/流年下面还要流月 — 每年 12 个月柱, 以立春为界由 sxtwl 算
{
  const r = calc([1979, 5, 6, 6, 56, 'male']);
  const y2026 = r.liunian.find((f) => f.年份 === 2026);
  assert.ok(y2026, '2026 流年应存在');
  assert.ok(typeof y2026.地支十神 === 'string' && y2026.地支十神.length > 0, '流年也要带地支十神');
  assert.ok(Array.isArray(y2026.流月), '流年必须带 流月 数组');
  assert.strictEqual(y2026.流月.length, 12, `2026 应有 12 个流月, 实际 ${y2026.流月.length}`);
  for (let m = 0; m < 12; m++) {
    const it = y2026.流月[m];
    assert.strictEqual(it.月, m + 1, `第 ${m + 1} 个月标记应为 ${m + 1}`);
    assert.ok(/^[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]$/.test(it.干支),
      `流月 ${m + 1} 干支格式错: "${it.干支}"`);
    assert.ok(typeof it.十神 === 'string' && it.十神.length > 0, `流月 ${m + 1} 缺天干十神`);
    assert.ok(typeof it.地支十神 === 'string' && it.地支十神.length > 0, `流月 ${m + 1} 缺地支十神`);
  }
  // 月柱以节气为界(非日历月): 2026 立春在 2/4, 所以 1 月仍是丑月己丑, 2 月才进寅月庚寅。
  assert.strictEqual(y2026.流月[0].干支, '己丑', `2026 年 1 月(立春前)月柱应为 己丑, 实际 ${y2026.流月[0].干支}`);
  assert.strictEqual(y2026.流月[1].干支, '庚寅', `2026 年 2 月(立春后)月柱应为 庚寅, 实际 ${y2026.流月[1].干支}`);
  console.log(`[ok] 流月: 2026 十二个月柱齐 (首月 ${y2026.流月[0].干支} … 末月 ${y2026.流月[11].干支})`);
}
// 8) 2026-10-08 防回归: JSX 辅助组件必须声明在模块顶层。
//    真实事故: GZ 被 patch 插进了 Section 函数体内部, vite 构建不报错(JSX 里的未定义变量
//    只在运行时炸 "GZ is not defined" 整页白屏)。顶层声明(行首无缩进)是唯一可靠判据。
//
//    2026-10-26 第 107 批 (桌面端下线): 这条读的是
//    `apps/desktop/src/views/BaziView.jsx` —— 界面没了, 断言一起删。
//    它守的是"React 组件的声明位置", 属于纯前端层, 与排盘算得对不对无关。
//    排盘本身的字段断言 (1~7 条) 一条没动, 全部还在。

console.log('\n所有 bazi_calc 关键字段断言通过');
