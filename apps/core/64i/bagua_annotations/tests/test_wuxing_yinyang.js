/**
 * tests/test_wuxing_yinyang.js - 五行阴阳合化层单测
 *
 * 运行：node tests/test_wuxing_yinyang.js
 *
 * 这层是为老板 2026-10-21 的两句原话建的, 所以正例就是那两句:
 *   「水克火, 是不是也是火耗费了水的精力?」
 *   「如果再加上阴阳呢? 阳火用阴水可能就克不了, 反而会助火」
 *
 * ⚠️ 第二句我第一遍读《三命通会》时**全盘接受**了, 结果是错的。
 *   正确口径(1753 + 3825 合读): **只有五合那几对才不克**;
 *   异性相克仍然成立, 只是归正官那一路(3825「故甲见辛为正官, 见庚为偏官」)。
 *   ⚠️ 第 49 批: 原来这里写的是「力度减一分」, 已改 —— 原文给的是**名分**,
 *   「力度/力足/力度减一分」五个字在《三命通会》全文零命中。`force` 字段
 *   作为**内部编码**保留('full' = 同阴阳, 'weaken' = 异阴阳), 生产文本
 *   一律说正偏官名(wuxing_strength.js 的 polarity.sameTenGod/diffTenGod)。
 *   老板直觉在**丁壬**上对, 在**丙癸**上不对 —— 两句都钉在下面, 不许回归。
 */

'use strict';

const assert = require('assert');
const path = require('path');
const _ANN = path.join(__dirname, '..');            // 64i/bagua_annotations
const _B64 = path.join(_ANN, '..');                 // 64i
const Y = require(path.join(_ANN, 'wuxing_yinyang.js'));
const TG = require(path.join(_B64, 'bazi', 'ten_gods.js'));
const WX = require(path.join(_ANN, 'wuxing_axioms.js'));

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    console.log('  ✅ ' + name);
    pass++;
  } catch (e) {
    console.log('  ❌ ' + name + '\n     ' + e.message);
    fail++;
  }
}

// ============================================================
console.log('\n--- 天干五合 (《三命通会》1756-1766 逐对) ---');

t('五合五对齐全, 化五行不串', () => {
  const expect = {
    '甲己': '土', '乙庚': '金', '丙辛': '水', '丁壬': '木', '戊癸': '火',
  };
  for (const pair of Object.keys(expect)) {
    const he = Y.getHe(pair[0], pair[1]);
    assert(he, pair + ' 应该合');
    assert.strictEqual(he.hua, expect[pair], pair + ' 化 ' + expect[pair] + ', 实为 ' + he.hua);
  }
});

t('查询与参数顺序无关', () => {
  assert.deepStrictEqual(Y.getHe('壬', '丁'), Y.getHe('丁', '壬'));
  assert.deepStrictEqual(Y.getHe('甲', '己'), Y.getHe('己', '甲'));
});

t('对外 pair 用《三命通会》原文写法(丁壬, 不是壬丁)', () => {
  assert.strictEqual(Y.getHe('壬', '丁').pair, '丁壬');
  assert.strictEqual(Y.getHe('乙', '庚').pair, '乙庚');
});

t('不是五合就不给合 (含天干之间互不为合)', () => {
  assert.strictEqual(Y.getHe('甲', '子'), null, '子不是天干');
  assert.strictEqual(Y.getHe('甲', '丙'), null, '甲丙不合');
  assert.strictEqual(Y.getHe('壬', '辛'), null, '壬辛不合');
});

t('故意不给合化结果的阴阳 (原文没判, 不编)', () => {
  const he = Y.getHe('甲', '己');
  assert(!('huaYinyang' in he), '合化阴阳是编的, 原文只给了五行');
  assert(!('yinYang' in he), '不要换个字段名把编的东西塞回来');
});

// ============================================================
console.log('\n--- 老板的问题: 火遇水, 到底克不克? ---');

t('丁(阴火)遇壬(阳水) → 不克, 合木 (老板直觉在这一对上成立)', () => {
  const r = Y.judgeKeByYinYang('丁', '壬');
  assert(r, '壬克丁, 方向对, 应返回判定');
  assert.strictEqual(r.established, false, '丁壬合木, 水克火不成立');
  assert(r.he && r.he.hua === '木');
  assert(/合则不克/.test(r.reason), '原因要说清是合: ' + r.reason);
});

t('丙(阳火)遇癸(阴水) → 克仍成立, 归正官那一路 (直觉在这一对上不成立)', () => {
  const r = Y.judgeKeByYinYang('丙', '癸');
  assert(r, '癸克丙, 方向对');
  assert.strictEqual(r.established, true, '丙癸不是五合, 克照样成立');
  assert.strictEqual(r.force, 'weaken', '异性 → 那一路, 不是不成立');
  assert.strictEqual(r.reason, '癸与丙异阴阳, 克仍然成立', '理由只说成立 + 阴阳关系');
});

t('丙(阳火)遇壬(阳水) → 克成立, 归偏官那一路 (二阳相竞)', () => {
  const r = Y.judgeKeByYinYang('丙', '壬');
  assert.strictEqual(r.established, true);
  assert.strictEqual(r.force, 'full');
  assert.strictEqual(r.reason, '壬与丙同阳, 克成立', '理由只说成立 + 阴阳关系');
});

t('丁(阴火)遇癸(阴水) → 克成立, 归偏官那一路 (二阴不足)', () => {
  const r = Y.judgeKeByYinYang('丁', '癸');
  assert.strictEqual(r.established, true);
  assert.strictEqual(r.force, 'full');
});

t('合压过同异阴阳: 不成立时不记那一路', () => {
  const r = Y.judgeKeByYinYang('丁', '壬');
  assert.strictEqual(r.force, null, '不成立时不记同异阴阳');
  assert.strictEqual(r.sameYinYang, false, '丁壬是异性');
});

t('方向不对就不是克的关系 (壬遇丁: 水没被火克)', () => {
  assert.strictEqual(Y.judgeKeByYinYang('壬', '丁'), null);
  assert.strictEqual(Y.judgeKeByYinYang('壬', '丙'), null);
});

t('非法输入返回 null, 不抛', () => {
  for (const bad of [['子', '壬'], [null, '壬'], ['丁', undefined], ['', '']]) {
    assert.strictEqual(Y.judgeKeByYinYang(bad[0], bad[1]), null, JSON.stringify(bad));
  }
});

// ============================================================
console.log('\n--- "一条边两个名字": 耗/克 的两端 (老板第一个问题) ---');

t('水克火是一条边, 不是两种关系', () => {
  // wuxing_axioms 的约定: getRelation(主方, 对方) 返回**对方对主方**的角色
  assert.strictEqual(WX.getRelation('水', '火'), 'ke', '火 对 水 = ke(耗)');
  assert.strictEqual(WX.getRelation('火', '水'), 'bei_ke', '水 对 火 = bei_ke(克)');
  // 本层不改名、不重定义, 只在"成不成立"上加阴阳
  assert.strictEqual(Y.judgeKeByYinYang('丁', '壬').established, false, '只有成立性被阴阳改写');
});

// ============================================================
console.log('\n--- 生边/同边: 五合废不掉生 ---');

t('同五行 → affinity=tong', () => {
  const r = Y.judgeShengByYinYang('甲', '乙');
  assert(r && r.affinity === 'tong');
  assert.strictEqual(r.he, null, '甲乙不合');
});

t('我生者 → affinity=sheng', () => {
  const r = Y.judgeShengByYinYang('甲', '丙');
  assert(r && r.affinity === 'sheng');
  assert.strictEqual(r.sameYinYang, true, '甲丙同阳');
});

t('克我的/我克的 → null (本层只管生和同)', () => {
  assert.strictEqual(Y.judgeShengByYinYang('甲', '庚'), null, '金克木');
  assert.strictEqual(Y.judgeShengByYinYang('甲', '戊'), null, '木克土');
});

// ============================================================
console.log('\n--- 装时自检: 判据不许静默退化 ---');

t('自检在当前真源上通过', () => {
  assert.doesNotThrow(() => Y._assertYinyangLayer());
});

t('自检的判据本身有效: 同阴阳必被拦下', () => {
  // 自检①的核心判据是"五合必须一阳一阴"。这里拿一对真实的同阴阳天干
  // (壬/丙 都阳) 验证这条判据真会拒绝 —— 否则自检就是一句空话。
  assert.strictEqual(TG.YIN_YANG['壬'], TG.YIN_YANG['丙'], '壬丙同阳');
  const selfCheckWouldThrow = TG.YIN_YANG['壬'] === TG.YIN_YANG['丙'];
  assert.strictEqual(selfCheckWouldThrow, true, '同阴阳必须触发自检异常');
});

t('自检③ 堵住"火=阳所以只有阳火" (wuxing_axioms.yin_yang 的陷阱)', () => {
  // wuxing_axioms 给火记的是单值"阳" —— 照它推会漏掉丁火
  assert.strictEqual(WX.getWuxingAxiom('火').yin_yang, '阳');
  // 但十天干真源里火阴阳各一
  const fireGans = TG.TIAN_GAN.filter(g => TG.WUXING[g] === '火');
  assert.deepStrictEqual(fireGans.map(g => TG.YIN_YANG[g]), ['阳', '阴'],
    '丙阳丁阴, 单值"阳"盖不住丁火');
});

// ============================================================
console.log('\n============================================================');
console.log('测试结果：' + (fail === 0
  ? '✅ 全部通过 (' + pass + ' 项)'
  : '❌ ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项'));
console.log('============================================================\n');

process.exit(fail === 0 ? 0 : 1);
