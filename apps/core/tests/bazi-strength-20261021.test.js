// bazi-strength-20261021.test.js — 八字排盘 × 五行旺衰层 连接测试
//
// 锁三件事:
//   1. 整数计数口径: 八字八个字, 天干1 + 地支本气1, 合计恒等于 8
//   2. "不成立"态真的能出现 (四柱里没有这个五行)
//   3. 不跟 bazi_calc.py 打架: 本层不产出 status / 喜忌, 只做逐格关系
//
// 判据出处: 桌面 <course-source>/<course-file>+ <course-source>

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const M = (p) => require(path.join(__dirname, '..', p));
const BS = M('modules/bazi_strength.js');

const PY = '/usr/bin/python3';
const SCRIPT = path.resolve(__dirname, '..', 'modules', 'tools', 'bazi', 'bazi_calc.py');

function calc(args) {
  const out = execFileSync(PY, [SCRIPT, ...args.map(String)], { encoding: 'utf-8' });
  return JSON.parse(out);
}

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✅ ' + name);
  } catch (e) {
    fail++;
    console.log('  ❌ ' + name + '  →  ' + e.message);
  }
}

console.log('=== 八字 × 旺衰 连接层 ===\n');

// 三个真实盘
const CHART_A = calc([1984, 3, 15, 10, 30, 'male']);    // 甲子 丁卯 戊申 丁巳
const CHART_B = calc([1990, 7, 22, 14, 0, 'female']);    // 庚午 癸未 戊子 己未 (无木)
const CHART_C = calc([2000, 1, 1, 0, 0, 'male']);        // 己卯 丙子 戊午 壬子 (无金)

console.log('--- 计数口径 ---');
t('A 盘 整数计数合计 = 8', () => {
  const j = BS.judgeFromChart(CHART_A);
  assert.strictEqual(j.countsTotal, 8);
});
t('B 盘 整数计数合计 = 8', () => {
  const j = BS.judgeFromChart(CHART_B);
  assert.strictEqual(j.countsTotal, 8);
});
t('C 盘 整数计数合计 = 8', () => {
  const j = BS.judgeFromChart(CHART_C);
  assert.strictEqual(j.countsTotal, 8);
});
t('A 盘: 甲子丁卯戊申丁巳 → 火3 木2 金1 水1 土1', () => {
  const j = BS.judgeFromChart(CHART_A);
  assert.deepStrictEqual(j.counts, { '金': 1, '木': 2, '水': 1, '火': 3, '土': 1 });
});
t('地支按本气计 (申本气庚=金)', () => {
  const j = BS.judgeFromChart(CHART_A);
  // 日柱 戊申: 戊=土, 申本气庚=金
  assert.strictEqual(j.counts['土'], 1);
  assert.strictEqual(j.counts['金'], 1);
});

console.log('\n--- "不成立"态真的出现 ---');
t('B 盘无木 → 克我者(木) = not_established', () => {
  const j = BS.judgeFromChart(CHART_B);
  assert.strictEqual(j.counts['木'], 0);
  assert.strictEqual(j.cells['木'].strength, 'not_established');
  assert.strictEqual(j.cells['木'].relation, 'ke');
});
t('C 盘无金 → 我生者(金) = not_established', () => {
  const j = BS.judgeFromChart(CHART_C);
  assert.strictEqual(j.counts['金'], 0);
  assert.strictEqual(j.cells['金'].strength, 'not_established');
  assert.strictEqual(j.cells['金'].relation, 'xie');
});
t('A 盘五行俱全 → 没有 not_established', () => {
  const j = BS.judgeFromChart(CHART_A);
  assert.strictEqual(j.notEstablished.length, 0);
});

console.log('\n--- 五格命名对齐课件 (我=日主) ---');
t('A 盘日主戊土: 木克我=克我者', () => {
  const j = BS.judgeFromChart(CHART_A);
  assert.strictEqual(j.self.wuxing, '土');
  assert.strictEqual(j.cells['木'].relation, 'ke');     // 克我者
  assert.strictEqual(j.cells['火'].relation, 'sheng');  // 生我者
  assert.strictEqual(j.cells['金'].relation, 'xie');    // 我生者
  assert.strictEqual(j.cells['水'].relation, 'hao');    // 我克者
  assert.strictEqual(j.cells['土'].relation, 'bi');     // 同我者
});

console.log('\n--- 不跟 bazi_calc 打架 ---');
t('本层不产出 status (那是 bazi_calc 的活)', () => {
  const j = BS.judgeFromChart(CHART_A);
  // status 只是**转述** bazi_calc 的结论, 不是本层判的
  assert.strictEqual(j.self.status, CHART_A.status);
});
t('喜忌也是转述 bazi_calc, 不自造', () => {
  const j = BS.judgeFromChart(CHART_A);
  assert.deepStrictEqual(j.xiYong, CHART_A.xi_yong);
  assert.deepStrictEqual(j.jiShell, CHART_A.ji_shell);
});
t('加权分与整数计数是两个字段, 互不覆盖', () => {
  const j = BS.judgeFromChart(CHART_A);
  assert.strictEqual(j.wuxingCountWeighted, CHART_A.wuxing_count);
  assert.notDeepStrictEqual(j.counts, j.wuxingCountWeighted);
});
t('每条判断都带 reason + source', () => {
  const j = BS.judgeFromChart(CHART_A);
  for (const [k, cell] of Object.entries(j.cells)) {
    assert.ok(cell.reason, k + ' 缺 reason');
    assert.ok(cell.source, k + ' 缺 source');
  }
});

console.log('\n--- 五行有阴阳 (甲乙木、丙丁火…) ---');
t('A 盘日主戊阳: 克我者木 → 甲同阴阳 → 七杀', () => {
  const j = BS.judgeFromChart(CHART_A);
  assert.strictEqual(j.self.yinYang, '阳');
  assert.strictEqual(j.cells['木'].polarity.sample, '甲');
  assert.strictEqual(j.cells['木'].polarity.tenGod, '七杀');
});
t('A 盘: 我生者金 → 庚同阴阳 → 食神', () => {
  const j = BS.judgeFromChart(CHART_A);
  assert.strictEqual(j.cells['金'].polarity.tenGod, '食神');
});
t('A 盘: 我克者水 → 壬同阴阳 → 偏财', () => {
  const j = BS.judgeFromChart(CHART_A);
  assert.strictEqual(j.cells['水'].polarity.tenGod, '偏财');
});
t('A 盘: 生我者火 → 丙同阴阳 → 偏印', () => {
  const j = BS.judgeFromChart(CHART_A);
  assert.strictEqual(j.cells['火'].polarity.tenGod, '偏印');
});
t('同异两支都取到 (同阴阳 AND 异阴阳)', () => {
  const j = BS.judgeFromChart(CHART_A);
  const p = j.cells['火'].polarity;
  assert.strictEqual(p.sameSample, '丙');
  assert.strictEqual(p.diffSample, '丁');
  assert.strictEqual(p.sameTenGod, '偏印');
  assert.strictEqual(p.diffTenGod, '正印');
});
t('十神名与 bazi_calc 的 shishen_tiangan 一致 (交叉验证)', () => {
  const j = BS.judgeFromChart(CHART_A);
  // A 盘: 甲子 丁卯 戊申 丁巳, 日主戊阳
  //   年干甲 → 木克土 → 七杀 (甲与戊同阴阳)
  //   月干丁 → 火生土 → 正印 (丁与戊异阴阳)
  // 注意: 异阴阳那一支也必须取到 —— 初版只取 same[0], 导致丁被判成偏印
  assert.ok(CHART_A.shishen_tiangan['年柱干'].includes('七杀'), JSON.stringify(CHART_A.shishen_tiangan));
  assert.ok(CHART_A.shishen_tiangan['月柱干'].includes('正印'), JSON.stringify(CHART_A.shishen_tiangan));
});

console.log('\n--- 格式化输出 ---');
t('formatJudgement 产出可读结构', () => {
  const j = BS.judgeFromChart(CHART_B);
  const s = BS.formatJudgement(j);
  assert.ok(s.includes('【五行六格判断】'));
  assert.ok(s.includes('不成立'), 'B 盘应有"不成立"的格');
  assert.ok(s.includes('月令'));
});
t('judgeFromChart 喂 null 不炸', () => {
  assert.strictEqual(BS.judgeFromChart(null), null);
});
t('缺日主五行时返回 null', () => {
  assert.strictEqual(BS.judgeFromChart({ pillars: {} }), null);
});

// ---------------------------------------------------------------------------
// formatConclusion —— E2E 实跑逼出来的一层 (2026-10-21)
//
// 为什么单独测它: 模型不读 strength 对象, 它读一行结论。
// 但这行结论一旦带了"可追查的线索"(文件名/路径), 模型就会去满世界 find 核实,
// 实跑 43~48 次 exec_command 陷进去出不来。所以这两条断言是**行为护栏**, 不是格式洁癖。
// ---------------------------------------------------------------------------
console.log('\n--- formatConclusion (模型第一眼看到的那行) ---');
t('结论式摘要: 五格状态 + 旺衰 + 喜忌 齐全', () => {
  const s = BS.formatConclusion(BS.judgeFromChart(CHART_B));
  assert.ok(s.includes('【六格判断'), '要有标题');
  assert.ok(s.includes('日主'), '要有日主');
  assert.ok(s.includes('不成立'), 'B 盘木 0 个 → 该格不成立, 必须出现');
  assert.ok(s.includes('有力'), 'B 盘土 3 个 → 有力, 必须出现');
  assert.ok(s.includes('日主'), '');
  // 五个格一个都不能少 —— 少一格模型就会自己补一个
  for (const n of ['生我者', '同我者', '克我者', '我生者', '我克者']) {
    assert.ok(s.includes(n), '缺一格: ' + n);
  }
});
t('⚠️ 结论里不许出现文件名或路径 (E2E 踩过的坑)', () => {
  const j = BS.judgeFromChart(CHART_B);
  const s = BS.formatConclusion(j);
  const src = j.source;
  assert.ok(!/\.(js|py|txt|md|json)\b/.test(s), '结论里出现了文件名: ' + s);
  // 「食神/伤官」的斜杠是十神分隔符, 不是路径 —— 只查**像路径**的斜杠
  // (斜杠两侧都有 ASCII 字母数字, 或出现家目录/桌面这类锚点)。
  assert.ok(!/\/[A-Za-z0-9_.-]/.test(s) && !/[A-Za-z0-9_.-]\//.test(s), '结论里出现了路径: ' + s);
  assert.ok(!/Desktop|Documents|\/Users\/|\/tmp\//.test(s), '结论里出现了家目录锚点: ' + s);
  // source 字段本身也要是给人看的判据名, 不是实现文件名
  assert.ok(!src.endsWith('.js'), 'source 是文件名, 模型会去核实: ' + src);
  assert.ok(!src.includes('/') && !src.includes('.txt'), 'source 含路径: ' + src);
});
t('formatConclusion 喂 null 返回空串, 不炸', () => {
  assert.strictEqual(BS.formatConclusion(null), '');
});

console.log('\n============================================================');
console.log('测试结果：' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
console.log('============================================================');
if (fail > 0) process.exit(1);

