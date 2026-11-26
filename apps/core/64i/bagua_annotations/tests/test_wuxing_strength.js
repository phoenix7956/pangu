// test_wuxing_strength.js — 五行旺衰判断层
//
// 判据出处 (原始课件, 逐条对回):
//   /Users/you/Desktop/course-source
//     「生我者为生 / 同我者为比 / 克我者为克 / 我生者为泄 / 我克者为耗
//       *此处"我"为日主」
//     「得令: 月令生我【"我"就是日元】或与我同五行 ... ✅」
//     「不得令: 月令克我【"我"就是日元】、泄我或耗我。 ❌」
//   /Users/you/Desktop/course-source
//     「相生就是为对方付出, 对对方好; 相克就是对对方不好, 克制对方, 要害对方。」
//
// 这层不碰 wuxing_axioms.js 的 5×5 矩阵 —— 那是基础关系层, 251 项测试锁着它。
// 本层只回答「关系成立与否 + 强弱」。

const assert = require('assert');
const path = require('path');

const S = require(path.join(__dirname, '..', 'wuxing_strength.js'));
const { STRENGTH, relationFromSelf, judgeDeLing, judgeRelation, judgeSixCells } = S;

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

console.log('=== 五行旺衰判断层 ===\n');

// ------------------------------------------------------------
// 1. 五格命名 (逐条对回课件)
// ------------------------------------------------------------
console.log('--- 五格命名 (我=木) ---');
t('水 生我 → sheng', () => {
  assert.strictEqual(relationFromSelf('木', '水'), 'sheng');
});
t('木 同我 → bi', () => {
  assert.strictEqual(relationFromSelf('木', '木'), 'bi');
});
t('金 克我 → ke', () => {
  assert.strictEqual(relationFromSelf('木', '金'), 'ke');
});
t('火 我生 → xie', () => {
  assert.strictEqual(relationFromSelf('木', '火'), 'xie');
});
t('土 我克 → hao', () => {
  assert.strictEqual(relationFromSelf('木', '土'), 'hao');
});
t('非法五行 → null', () => {
  assert.strictEqual(relationFromSelf('木', '风'), null);
  assert.strictEqual(relationFromSelf(null, '木'), null);
});

// ------------------------------------------------------------
// 2. 得令判断 (逐条对回课件原文)
// ------------------------------------------------------------
console.log('\n--- 得令判断 ---');
t('月令生我 → 得令 ✅', () => {
  const r = judgeDeLing('木', '水');   // 水生木
  assert.strictEqual(r.deLing, true);
  assert.ok(r.reason.includes('得令'));
});
t('月令同我 → 得令 ✅', () => {
  const r = judgeDeLing('木', '木');
  assert.strictEqual(r.deLing, true);
  assert.strictEqual(r.relation, 'bi');
});
t('月令克我 → 不得令 ❌', () => {
  const r = judgeDeLing('木', '金');   // 金克木
  assert.strictEqual(r.deLing, false);
  assert.ok(r.reason.includes('克我'));
});
t('月令泄我 → 不得令 ❌', () => {
  const r = judgeDeLing('木', '火');   // 木生火, 火泄木
  assert.strictEqual(r.deLing, false);
  assert.ok(r.reason.includes('泄我'));
});
t('月令耗我 → 不得令 ❌', () => {
  const r = judgeDeLing('木', '土');   // 木克土, 木耗土
  assert.strictEqual(r.deLing, false);
  assert.ok(r.reason.includes('耗我'));
});

// ------------------------------------------------------------
// 3. 三档强度
// ------------------------------------------------------------
console.log('\n--- 三档强度 ---');
t('得令 → strong', () => {
  const r = judgeRelation('木', '土', { counts: { '土': 3 } });  // 土 3 个 → 过强
  assert.strictEqual(r.strength, STRENGTH.STRONG);
  assert.strictEqual(r.relation, 'hao');   // 我克者=耗
});
t('计数 1-2 个 → weak', () => {
  const r = judgeRelation('木', '土', { counts: { '土': 2 } });
  assert.strictEqual(r.strength, STRENGTH.WEAK);
  assert.strictEqual(r.relation, 'hao');
});
t('计数 0 个 → not_established (课件: 四柱里没有这个五行)', () => {
  const r = judgeRelation('木', '金', { counts: { '金': 0 } });
  assert.strictEqual(r.strength, STRENGTH.NOT_ESTABLISHED);
  assert.ok(r.reason.includes('没有这个五行'));
});
t('缺计数 → undetermined', () => {
  const r = judgeRelation('木', '土');
  assert.strictEqual(r.strength, STRENGTH.UNDETERMINED);
});
t('每条结果都带 source 出处', () => {
  const r = judgeRelation('木', '土', { counts: { '土': 1 } });
  assert.ok(r.source && r.source.length > 0);
  assert.ok(r.reason && r.reason.length > 0);
});
t('阈值边界: 恰好 3 个算 strong (课件「3个及以上」)', () => {
  assert.strictEqual(judgeRelation('木', '土', { counts: { '土': 3 } }).strength, STRENGTH.STRONG);
  assert.strictEqual(judgeRelation('木', '土', { counts: { '土': 2 } }).strength, STRENGTH.WEAK);
});
t('阈值边界: 恰好 0 个算 not_established', () => {
  assert.strictEqual(judgeRelation('木', '土', { counts: { '土': 0 } }).strength, STRENGTH.NOT_ESTABLISHED);
});

// ------------------------------------------------------------
// 3b. 阴阳细分 (五行有阴阳: 甲乙木、丙丁火…)
// ------------------------------------------------------------
console.log('\n--- 阴阳细分 ---');
t('日主戊(阳): 克我者木 → 甲与日主同阴阳 → 七杀', () => {
  const r = judgeRelation('土', '木', { counts: { '木': 1 }, selfGan: '戊' });
  assert.ok(r.polarity, '缺 polarity');
  assert.strictEqual(r.polarity.sample, '甲');
  assert.strictEqual(r.polarity.tenGod, '七杀');
});
t('日主戊(阳): 我生者金 → 庚同阴阳 → 食神', () => {
  const r = judgeRelation('土', '金', { counts: { '金': 1 }, selfGan: '戊' });
  assert.strictEqual(r.polarity.sample, '庚');
  assert.strictEqual(r.polarity.tenGod, '食神');
});
t('日主戊(阳): 我克者水 → 壬同阴阳 → 偏财', () => {
  const r = judgeRelation('土', '水', { counts: { '水': 1 }, selfGan: '戊' });
  assert.strictEqual(r.polarity.tenGod, '偏财');
});
t('日主戊(阳): 生我者火 → 丙同阴阳 → 偏印', () => {
  const r = judgeRelation('土', '火', { counts: { '火': 1 }, selfGan: '戊' });
  assert.strictEqual(r.polarity.tenGod, '偏印');
});
t('日主戊(阳): 同我者土 → 比肩 (getTenGod 对同我返回 null, 走另一条路)', () => {
  const r = judgeRelation('土', '土', { counts: { '土': 1 }, selfGan: '戊' });
  assert.strictEqual(r.polarity.tenGod, null);   // 底层确实是 null
  assert.strictEqual(r.relation, 'bi');
});
t('日主甲(阳): 克我者金 → 庚同阴阳 → 七杀', () => {
  const r = judgeRelation('木', '金', { counts: { '金': 1 }, selfGan: '甲' });
  assert.strictEqual(r.polarity.sample, '庚');
  assert.strictEqual(r.polarity.tenGod, '七杀');
});
t('日主甲(阳): 克我者若取辛(异阴阳) → 正官 (十神层正偏核对)', () => {
  // 交叉验证 ten_gods.js 的正偏规则: 同阴阳=七杀, 异阴阳=正官
  const TG = require(path.join(__dirname, '..', '..', 'bazi', 'ten_gods.js'));
  assert.strictEqual(TG.getTenGod('甲', '庚'), '七杀');
  assert.strictEqual(TG.getTenGod('甲', '辛'), '正官');
  assert.strictEqual(TG.getTenGod('乙', '辛'), '七杀');
});
t('日主乙(阴): 克我者金 → 辛同阴阳 → 七杀', () => {
  const r = judgeRelation('木', '金', { counts: { '金': 1 }, selfGan: '乙' });
  assert.strictEqual(r.polarity.tenGod, '七杀');
});
t('不给日主天干 → 不出 polarity (不瞎编)', () => {
  const r = judgeRelation('土', '木', { counts: { '木': 1 } });
  assert.strictEqual(r.polarity, null);
});
t('阴阳细分不改变 strength (两件事分开)', () => {
  const a = judgeRelation('土', '木', { counts: { '木': 1 } });
  const b = judgeRelation('土', '木', { counts: { '木': 1 }, selfGan: '戊' });
  assert.strictEqual(a.strength, b.strength);
});
t('爻动阴阳不参与 (本层只有静态五行阴阳)', () => {
  // 爻位/动爻在本层没有入口 —— 传任何多余参数都不影响结果
  const a = judgeRelation('土', '木', { counts: { '木': 1 }, selfGan: '戊' });
  const b = judgeRelation('土', '木', { counts: { '木': 1 }, selfGan: '戊', movingYao: 3, yaoYinYang: '阴' });
  assert.deepStrictEqual(a, b);
});

// ------------------------------------------------------------
// 4. 六格全景
// ------------------------------------------------------------
console.log('\n--- 六格全景 ---');
t('5 格齐全', () => {
  const s = judgeSixCells('木', { '金': 1, '木': 1, '水': 1, '火': 1, '土': 4 });
  assert.strictEqual(Object.keys(s.cells).length, 5);
  assert.strictEqual(s.self, '木');
});
t('全 1-2 个 → 无 strong 无 not_established', () => {
  const s = judgeSixCells('木', { '金': 1, '木': 2, '水': 1, '火': 1, '土': 2 });
  assert.strictEqual(s.strong.length, 0);
  assert.strictEqual(s.weak.length, 5);
  assert.strictEqual(s.notEstablished.length, 0);
});
t('0 个的那个 → not_established', () => {
  const s = judgeSixCells('木', { '金': 0, '木': 1, '水': 1, '火': 1, '土': 2 });
  assert.ok(s.notEstablished.includes('金'), 'notEstablished=' + JSON.stringify(s.notEstablished));
  assert.strictEqual(s.weak.length, 4);
});
t('3 个以上的那个 → strong', () => {
  const s = judgeSixCells('木', { '金': 1, '木': 1, '水': 1, '火': 3, '土': 2 });
  assert.ok(s.strong.includes('火'), 'strong=' + JSON.stringify(s.strong));
});

// ------------------------------------------------------------
// 5. 与基础关系层一致 (不冲突)
// ------------------------------------------------------------
console.log('\n--- 与 wuxing_axioms 不冲突 ---');
t('本层不修改 5×5 矩阵', () => {
  const AX = require(path.join(__dirname, '..', 'wuxing_axioms.js'));
  assert.strictEqual(AX.getRelation('木', '火'), 'sheng');   // 我生对方
  assert.strictEqual(AX.getRelation('火', '木'), 'bei_sheng');
  assert.strictEqual(AX.getRelation('木', '土'), 'ke');
  assert.strictEqual(AX.getRelation('土', '木'), 'bei_ke');
});
t('两层的"我生"方向一致 (本层 xie == 基础层 sheng)', () => {
  const AX = require(path.join(__dirname, '..', 'wuxing_axioms.js'));
  assert.strictEqual(relationFromSelf('木', '火'), 'xie');
  assert.strictEqual(AX.getRelation('木', '火'), 'sheng');
});
t('两层的"我克"方向一致 (本层 hao == 基础层 ke)', () => {
  const AX = require(path.join(__dirname, '..', 'wuxing_axioms.js'));
  assert.strictEqual(relationFromSelf('木', '土'), 'hao');
  assert.strictEqual(AX.getRelation('木', '土'), 'ke');
});

console.log('\n============================================================');
console.log('测试结果：' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
console.log('============================================================');
if (fail > 0) process.exit(1);

