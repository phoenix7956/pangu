/**
 * Pangu · 64i Layer
 * bagua_annotations/tests/test_yao_axioms.js
 *
 * Pangu 爻位公理层测试
 */

'use strict';

const path = require('path');
const y = require(path.join(__dirname, '..', 'yao_axioms'));

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ✓', msg);
  } else {
    failed++;
    failures.push(msg);
    console.log('  ✗', msg);
  }
}

console.log('============================================================');
console.log('Pangu yao_axioms.js 测试');
console.log('============================================================');

// --- 测试组 1: 6 爻位都能查到 ---
console.log('\n[1] 6 个 position (0-5) 都能查到');
for (let pos = 0; pos <= 5; pos++) {
  const ax = y.getYaoPositionAxiom(pos);
  assert(ax !== null, `getYaoPositionAxiom(${pos}) 返回非 null`);
  if (ax) {
    assert(ax.position === pos, `  position 字段 = ${pos}`);
  }
}

// --- 测试组 2: 阳爻名 (6 个) ---
console.log('\n[2] 阳爻名 (初九/九二/.../上九)');
const yangNames = ['初九', '九二', '九三', '九四', '九五', '上九'];
for (let pos = 0; pos <= 5; pos++) {
  const ax = y.getYaoPositionAxiom(pos);
  assert(ax.yaoName_yang === yangNames[pos], `pos=${pos} 阳爻名 = ${yangNames[pos]}`);
}

// --- 测试组 3: 阴爻名 (6 个) ---
console.log('\n[3] 阴爻名 (初六/六二/.../上六)');
const yinNames = ['初六', '六二', '六三', '六四', '六五', '上六'];
for (let pos = 0; pos <= 5; pos++) {
  const ax = y.getYaoPositionAxiom(pos);
  assert(ax.yaoName_yin === yinNames[pos], `pos=${pos} 阴爻名 = ${yinNames[pos]}`);
}

// --- 测试组 4: 爻位**不带**五行 (2026-10-22 第 36 批) ---
// 原来这里是「五行分布: 水木火金土火」。那张表已撤, 理由三条(都有实算):
//   ① /Users/you/Desktop/course-source 全树**查无出处**
//   ② 拿真纳甲地支当异源尺子量它: 六爻齐全的 4 卦共 24 个爻位只对上 4 个, 坤卦全错
//   ③ 固定表使六亲的「他」侧不随卦变 ⇒ 同宫 8 卦六亲完全相同 ⇒ 64 卦塌成 5 种形态
// ⇒ 爻的五行只有一个来源: 该爻的**纳甲地支五行**(najia.js, 卦层)。
// 这条断言现在反过来守: 假表**不许回来**。
console.log('\n[4] 爻位公理层不再带五行 (假表不许回来)');
for (let pos = 0; pos <= 5; pos++) {
  const ax = y.getYaoPositionAxiom(pos);
  assert(!('wuxing' in ax), `pos=${pos} 又长出了 wuxing="${ax.wuxing}" —— 查无出处的假表`);
}

// --- 测试组 5: 6 nature 不重复 ---
console.log('\n[5] 6 nature 不重复 (根元/身本/动用/变机/德成/极终)');
const expectedNatures = ['根元', '身本', '动用', '变机', '德成', '极终'];
const allNatures = y.YAO_POSITION_AXIOMS.map(ax => ax.nature);
const uniqueNatures = new Set(allNatures);
assert(uniqueNatures.size === 6, `6 个 nature 不重复 (实际: ${uniqueNatures.size})`);
for (let pos = 0; pos <= 5; pos++) {
  const ax = y.getYaoPositionAxiom(pos);
  assert(ax.nature === expectedNatures[pos], `pos=${pos} nature = ${expectedNatures[pos]}`);
}

// --- 测试组 6: 4 维字段 (human/time/space/social) 都有值 ---
console.log('\n[6] 4 维字段 (human_relations/time_phase/space_phase/social_phase) 都有值');
for (let pos = 0; pos <= 5; pos++) {
  const ax = y.getYaoPositionAxiom(pos);
  assert(typeof ax.human_relations === 'object' && ax.human_relations.shi && ax.human_relations.meaning,
    `pos=${pos} human_relations 有 shi + meaning`);
  assert(typeof ax.time_phase === 'string' && ax.time_phase.length > 0,
    `pos=${pos} time_phase 非空`);
  assert(typeof ax.space_phase === 'string' && ax.space_phase.length > 0,
    `pos=${pos} space_phase 非空`);
  assert(typeof ax.social_phase === 'string' && ax.social_phase.length > 0,
    `pos=${pos} social_phase 非空`);
}

// --- 测试组 7: 按五行反查爻位的接口已撤 (2026-10-22 第 36 批) ---
// 爻位公理层没有五行了, 「按五行找哪几个爻位」这个问题**不再成立** ——
// 留着这个接口, 下一个人就会用它去回答「三爻属什么」, 而那答案的真源
// 是**纳甲地支**, 随卦变。⇒ 接口撤掉, 并把「撤了」本身钉成断言。
console.log('\n[7] getYaoPositionsByWuxing 已随假表一起撤掉');
assert(typeof y.getYaoPositionsByWuxing === 'undefined',
  '按五行反查爻位的接口还在 —— 爻位没有五行, 这个接口只会引出假答案');

// --- 测试组 8: getYaoPositionsByNature ---
console.log('\n[8] getYaoPositionsByNature 边界测试');
const rootResults = y.getYaoPositionsByNature('根元');
assert(rootResults.length === 1, `'根元' 匹配 1 个`);
assert(rootResults[0].position === 0, `'根元' 匹配 pos=0 (初爻)`);
const peakResults = y.getYaoPositionsByNature('德成');
assert(peakResults.length === 1, `'德成' 匹配 1 个`);
assert(peakResults[0].position === 4, `'德成' 匹配 pos=4 (五爻)`);
const unknownNature = y.getYaoPositionsByNature('不存在的性质');
assert(unknownNature.length === 0, `未知性质返回空数组`);

// --- 测试组 9: 边界值/类型错误 ---
console.log('\n[9] 边界值/类型错误');
assert(y.getYaoPositionAxiom(-1) === null, `pos=-1 返回 null`);
assert(y.getYaoPositionAxiom(6) === null, `pos=6 返回 null`);
assert(y.getYaoPositionAxiom(1.5) === null, `pos=1.5 (非整数) 返回 null`);
assert(y.getYaoPositionAxiom('0') === null, `pos='0' (字符串) 返回 null`);
assert(y.getYaoPositionAxiom(null) === null, `pos=null 返回 null`);
// 接口已撤, 这里只验剩下的接口不崩(负数/非整数/字符串/null)
for (const bad of [-1, 6, 1.5, '0', null, undefined, {}]) {
  assert(y.getYaoPositionAxiom(bad) === null, `pos=${JSON.stringify(bad)} 返回 null`);
}

// --- 测试组 10: keywords 都是非空数组 ---
console.log('\n[10] keywords 都是非空数组 (3-5 关键词)');
for (let pos = 0; pos <= 5; pos++) {
  const ax = y.getYaoPositionAxiom(pos);
  assert(Array.isArray(ax.keywords) && ax.keywords.length >= 3,
    `pos=${pos} keywords 是 ≥3 元素数组 (实际: ${ax.keywords.length})`);
}

// ============================================================
console.log('\n============================================================');
console.log(`测试结果：✅ ${passed} 项通过  ❌ ${failed} 项失败`);
console.log('============================================================');
if (failures.length > 0) {
  console.log('\n失败项:');
  failures.forEach(f => console.log('  -', f));
  process.exit(1);
} else {
  console.log('\n🎯 所有测试通过！yao_axioms.js 验证完毕。');
  process.exit(0);
}
