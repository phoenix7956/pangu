/**
 * Pangu · 64i Layer
 * bagua_annotations/tests/test_wuxing_axioms.js
 *
 * wuxing_axioms.js 单元测试
 * 10 个测试组：元素完整性 / 公理查询 / 字段完整性 / 经典属性 / 生循环 /
 *            克循环 / tong 自指 / sheng+ke 互斥 / 边界与错误处理 / 常量与矩阵
 *
 * 运行：node bagua_annotations/tests/test_wuxing_axioms.js
 */

'use strict';

const path = require('path');
const {
  WUXING_AXIOMS,
  RELATIONS,
  WUXING_RELATION_MATRIX,
  getWuxingAxiom,
  getRelation,
  shengOf,
  keOf,
} = require(path.join(__dirname, '..', 'wuxing_axioms'));

// ============================================================
// 测试工具
// ============================================================

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n【${name}】`);
}

// ============================================================
// 主测试流程
// ============================================================

function run() {
  console.log('='.repeat(60));
  console.log('Pangu · wuxing_axioms 单元测试 (10 组)');
  console.log('='.repeat(60));

  const ELEMENTS = ['金', '木', '水', '火', '土'];

  // ---- 1. 元素完整性 ----
  section('1. WUXING_AXIOMS 数组 - 5 元素齐全');
  assert(Array.isArray(WUXING_AXIOMS), 'WUXING_AXIOMS 是数组');
  assert(WUXING_AXIOMS.length === 5, `WUXING_AXIOMS.length === 5（实际：${WUXING_AXIOMS.length}）`);
  for (const name of ELEMENTS) {
    const found = WUXING_AXIOMS.some(a => a.name === name);
    assert(found, `WUXING_AXIOMS 包含 "${name}"`);
  }
  // 元素名唯一
  const axiomNames = WUXING_AXIOMS.map(a => a.name);
  assert(new Set(axiomNames).size === 5, `元素名唯一（实际：${new Set(axiomNames).size}）`);

  // ---- 2. getWuxingAxiom 查询 ----
  section('2. getWuxingAxiom(name) - 5 元素都能查到');
  for (const name of ELEMENTS) {
    const axiom = getWuxingAxiom(name);
    assert(axiom !== null, `name="${name}" 返回非 null`);
    assert(axiom && axiom.name === name, `name="${name}" 的 axiom.name === "${name}"`);
  }
  // 边界
  assert(getWuxingAxiom('unknown') === null, 'name="unknown" 返回 null');
  assert(getWuxingAxiom(null) === null, 'name=null 返回 null');
  assert(getWuxingAxiom(undefined) === null, 'name=undefined 返回 null');
  assert(getWuxingAxiom(123) === null, 'name=123 (number) 返回 null');

  // ---- 3. 字段完整性 ----
  section('3. 10 字段完整性 + 类型校验');
  const REQUIRED = ['name', 'english', 'symbol', 'color', 'direction', 'season', 'nature', 'yin_yang', 'organ', 'keywords'];
  for (const axiom of WUXING_AXIOMS) {
    for (const field of REQUIRED) {
      assert(field in axiom, `${axiom.name} 有字段 ${field}`);
    }
    assert(typeof axiom.name === 'string', `${axiom.name}.name 是 string`);
    assert(typeof axiom.english === 'string', `${axiom.name}.english 是 string`);
    assert(typeof axiom.symbol === 'string' && axiom.symbol.length > 0, `${axiom.name}.symbol 是非空 string`);
    assert(typeof axiom.color === 'string', `${axiom.name}.color 是 string`);
    assert(typeof axiom.direction === 'string', `${axiom.name}.direction 是 string`);
    assert(typeof axiom.season === 'string', `${axiom.name}.season 是 string`);
    assert(typeof axiom.nature === 'string', `${axiom.name}.nature 是 string`);
    assert(axiom.yin_yang === '阳' || axiom.yin_yang === '阴', `${axiom.name}.yin_yang 是 阳/阴`);
    assert(typeof axiom.organ === 'string', `${axiom.name}.organ 是 string`);
    assert(Array.isArray(axiom.keywords) && axiom.keywords.length >= 3, `${axiom.name}.keywords 是 ≥3 项数组`);
  }

  // ---- 4. 经典属性验证（色/方位/季节）----
  section('4. 经典属性: 五色 / 五方 / 五季');
  assert(getWuxingAxiom('金').color === '白', `金 → 色白`);
  assert(getWuxingAxiom('木').color === '青', `木 → 色青`);
  assert(getWuxingAxiom('水').color === '黑', `水 → 色黑`);
  assert(getWuxingAxiom('火').color === '赤', `火 → 色赤`);
  assert(getWuxingAxiom('土').color === '黄', `土 → 色黄`);

  assert(getWuxingAxiom('金').direction === '西', `金 → 西`);
  assert(getWuxingAxiom('木').direction === '东', `木 → 东`);
  assert(getWuxingAxiom('水').direction === '北', `水 → 北`);
  assert(getWuxingAxiom('火').direction === '南', `火 → 南`);
  assert(getWuxingAxiom('土').direction === '中', `土 → 中`);

  assert(getWuxingAxiom('金').season === '秋', `金 → 秋`);
  assert(getWuxingAxiom('木').season === '春', `木 → 春`);
  assert(getWuxingAxiom('水').season === '冬', `水 → 冬`);
  assert(getWuxingAxiom('火').season === '夏', `火 → 夏`);
  assert(getWuxingAxiom('土').season === '长夏', `土 → 长夏`);

  // ---- 5. 相生循环 ----
  section('5. 相生循环: 金→水→木→火→土→金 (顺时针成环)');
  const SHENG_CHAIN = ['金', '水', '木', '火', '土', '金'];
  for (let i = 0; i < SHENG_CHAIN.length - 1; i++) {
    const w1 = SHENG_CHAIN[i];
    const w2 = SHENG_CHAIN[i + 1];
    const rel = getRelation(w1, w2);
    assert(rel === RELATIONS.SHENG, `${w1} 生 ${w2} → getRelation = 'sheng'（实际：${rel}）`);
  }
  // 顺时针成环：从金开始沿 sheng 走 5 步回到金
  let cursor = '金';
  for (let step = 0; step < 5; step++) {
    cursor = shengOf(cursor);
  }
  assert(cursor === '金', `沿 sheng 走 5 步回到 '金'（实际终点：${cursor}）`);

  // ---- 6. 相克循环 ----
  section('6. 相克循环: 金→木→土→水→火→金 (顺时针成环)');
  const KE_CHAIN = ['金', '木', '土', '水', '火', '金'];
  for (let i = 0; i < KE_CHAIN.length - 1; i++) {
    const w1 = KE_CHAIN[i];
    const w2 = KE_CHAIN[i + 1];
    const rel = getRelation(w1, w2);
    assert(rel === RELATIONS.KE, `${w1} 克 ${w2} → getRelation = 'ke'（实际：${rel}）`);
  }
  // 顺时针成环：从金开始沿 ke 走 5 步回到金
  cursor = '金';
  for (let step = 0; step < 5; step++) {
    cursor = keOf(cursor);
  }
  assert(cursor === '金', `沿 ke 走 5 步回到 '金'（实际终点：${cursor}）`);

  // ---- 7. tong 关系（自己对自己）----
  section('7. tong 关系: 自己对自己永远是 tong');
  for (const name of ELEMENTS) {
    const rel = getRelation(name, name);
    assert(rel === RELATIONS.TONG, `${name} 同 ${name} → getRelation = 'tong'（实际：${rel}）`);
  }

  // ---- 8. sheng + ke 互斥 ----
  section('8. sheng + ke 互斥: w1 生 w2 必不克 w2');
  // 收集 sheng 和 ke 位置
  const shengPositions = [];
  const kePositions = [];
  for (const w1 of ELEMENTS) {
    for (const w2 of ELEMENTS) {
      if (w1 === w2) continue;
      const rel = getRelation(w1, w2);
      if (rel === RELATIONS.SHENG) shengPositions.push([w1, w2]);
      if (rel === RELATIONS.KE) kePositions.push([w1, w2]);
    }
  }
  assert(shengPositions.length === 5, `sheng 位置数 === 5（实际：${shengPositions.length}）`);
  assert(kePositions.length === 5, `ke 位置数 === 5（实际：${kePositions.length}）`);
  // sheng 和 ke 位置不重叠
  for (const [w1, w2] of shengPositions) {
    const isKe = kePositions.some(([a, b]) => a === w1 && b === w2);
    assert(!isKe, `[${w1},${w2}] 是 sheng，验证不是 ke`);
  }
  for (const [w1, w2] of kePositions) {
    const isSheng = shengPositions.some(([a, b]) => a === w1 && b === w2);
    assert(!isSheng, `[${w1},${w2}] 是 ke，验证不是 sheng`);
  }
  // 反向不生/不克
  for (const w1 of ELEMENTS) {
    const shengTarget = shengOf(w1);
    if (shengTarget) {
      const reverseRel = getRelation(shengTarget, w1);
      assert(
        reverseRel !== RELATIONS.SHENG,
        `反向不生：${w1} 生 ${shengTarget}，${shengTarget} 不生 ${w1}（实际：${reverseRel}）`
      );
    }
    const keTarget = keOf(w1);
    if (keTarget) {
      const reverseRel = getRelation(keTarget, w1);
      assert(
        reverseRel !== RELATIONS.KE,
        `反向不克：${w1} 克 ${keTarget}，${keTarget} 不克 ${w1}（实际：${reverseRel}）`
      );
    }
  }

  // ---- 9. 边界与错误处理 ----
  section('9. getRelation/shengOf/keOf 边界与错误处理');
  assert(getRelation('金', 'invalid') === 'unknown', `getRelation('金', 'invalid') === 'unknown'`);
  assert(getRelation('invalid', '金') === 'unknown', `getRelation('invalid', '金') === 'unknown'`);
  assert(getRelation('invalid', 'invalid') === 'unknown', `getRelation('invalid', 'invalid') === 'unknown'`);
  assert(getRelation(null, '金') === 'unknown', `getRelation(null, '金') === 'unknown'`);
  assert(getRelation('金', null) === 'unknown', `getRelation('金', null) === 'unknown'`);
  assert(getRelation(undefined, '金') === 'unknown', `getRelation(undefined, '金') === 'unknown'`);
  assert(getRelation('金', undefined) === 'unknown', `getRelation('金', undefined) === 'unknown'`);
  assert(getRelation(123, '金') === 'unknown', `getRelation(123, '金') === 'unknown'`);
  assert(getRelation('金', 123) === 'unknown', `getRelation('金', 123) === 'unknown'`);
  assert(getRelation() === 'unknown', `getRelation() (无参数) === 'unknown'`);
  assert(shengOf('invalid') === null, `shengOf('invalid') === null`);
  assert(shengOf(null) === null, `shengOf(null) === null`);
  assert(shengOf(undefined) === null, `shengOf(undefined) === null`);
  assert(keOf('invalid') === null, `keOf('invalid') === null`);
  assert(keOf(null) === null, `keOf(null) === null`);
  assert(keOf(undefined) === null, `keOf(undefined) === null`);

  // ---- 10. 常量与矩阵结构 ----
  section('10. RELATIONS 常量 + WUXING_RELATION_MATRIX 结构');
  assert(typeof RELATIONS === 'object' && RELATIONS !== null, 'RELATIONS 是对象');
  assert(RELATIONS.SHENG === 'sheng', `RELATIONS.SHENG === 'sheng'`);
  assert(RELATIONS.BEI_SHENG === 'bei_sheng', `RELATIONS.BEI_SHENG === 'bei_sheng'`);
  assert(RELATIONS.KE === 'ke', `RELATIONS.KE === 'ke'`);
  assert(RELATIONS.BEI_KE === 'bei_ke', `RELATIONS.BEI_KE === 'bei_ke'`);
  assert(RELATIONS.CHONG === 'chong', `RELATIONS.CHONG === 'chong'`);
  assert(RELATIONS.XING === 'xing', `RELATIONS.XING === 'xing'`);
  assert(RELATIONS.HAI === 'hai', `RELATIONS.HAI === 'hai'`);
  assert(RELATIONS.TONG === 'tong', `RELATIONS.TONG === 'tong'`);
  // 矩阵结构
  assert(typeof WUXING_RELATION_MATRIX === 'object', 'WUXING_RELATION_MATRIX 是对象');
  for (const row of ELEMENTS) {
    assert(row in WUXING_RELATION_MATRIX, `矩阵有行 "${row}"`);
    for (const col of ELEMENTS) {
      assert(col in WUXING_RELATION_MATRIX[row], `矩阵 [${row}][${col}] 存在`);
    }
  }
  // 各值数量（2026-06-22 修 wuxingRel bug: 加 bei_sheng/bei_ke 填满 25 格, unknown 应为 0）
  const valueCount = { tong: 0, sheng: 0, bei_sheng: 0, ke: 0, bei_ke: 0, unknown: 0 };
  for (const row of ELEMENTS) {
    for (const col of ELEMENTS) {
      const v = WUXING_RELATION_MATRIX[row][col];
      if (v in valueCount) valueCount[v]++;
    }
  }
  assert(valueCount.tong === 5, `tong 单元格 === 5（实际：${valueCount.tong}）`);
  assert(valueCount.sheng === 5, `sheng 单元格 === 5（实际：${valueCount.sheng}）`);
  assert(valueCount.bei_sheng === 5, `bei_sheng 单元格 === 5（实际：${valueCount.bei_sheng}）`);
  assert(valueCount.ke === 5, `ke 单元格 === 5（实际：${valueCount.ke}）`);
  assert(valueCount.bei_ke === 5, `bei_ke 单元格 === 5（实际：${valueCount.bei_ke}）`);
  assert(valueCount.unknown === 0, `unknown 单元格 === 0（实际：${valueCount.unknown}）`);
  assert(valueCount.tong + valueCount.sheng + valueCount.bei_sheng + valueCount.ke + valueCount.bei_ke === 25, `总和 === 25（实际：${valueCount.tong + valueCount.sheng + valueCount.bei_sheng + valueCount.ke + valueCount.bei_ke}）`);

  // ---- 11. bei_sheng / bei_ke 位置验证 ----
  // 验证 bei_sheng 与 sheng 互为反向
  section('11. bei_sheng / bei_ke 与 sheng / ke 互为反向');
  let beiShengMatched = 0;
  let beiKeMatched = 0;
  for (const w1 of ELEMENTS) {
    for (const w2 of ELEMENTS) {
      if (w1 === w2) continue;
      const rel12 = getRelation(w1, w2);
      const rel21 = getRelation(w2, w1);
      if (rel12 === RELATIONS.SHENG) {
        assert(rel21 === RELATIONS.BEI_SHENG, `${w1} sheng ${w2} → ${w2} 对 ${w1} 应为 bei_sheng（实际：${rel21}）`);
        beiShengMatched++;
      }
      if (rel12 === RELATIONS.KE) {
        assert(rel21 === RELATIONS.BEI_KE, `${w1} ke ${w2} → ${w2} 对 ${w1} 应为 bei_ke（实际：${rel21}）`);
        beiKeMatched++;
      }
    }
  }
  assert(beiShengMatched === 5, `sheng↔bei_sheng 互为反向的 5 组全验证（实际：${beiShengMatched}）`);
  assert(beiKeMatched === 5, `ke↔bei_ke 互为反向的 5 组全验证（实际：${beiKeMatched}）`);

  // ---- 汇总 ----
  console.log('\n' + '='.repeat(60));
  console.log(`测试结果：✅ ${passed} 项通过  ❌ ${failed} 项失败`);
  console.log('='.repeat(60));

  if (failed === 0) {
    console.log('\n🎯 10 组测试全部通过！wuxing_axioms.js 验证完毕。');
    process.exit(0);
  } else {
    console.log(`\n⚠️  有 ${failed} 项失败，请检查 wuxing_axioms.js。`);
    process.exit(1);
  }
}

run();
