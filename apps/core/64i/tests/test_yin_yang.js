/**
 * Pangu · 64i Layer
 * tests/test_yin_yang.js - 阴阳爻模块的 movement flag 单测
 *
 * 覆盖：
 *   - getMovement(7) → 'static'     (少阳静)
 *   - getMovement(8) → 'static'     (少阴静)
 *   - getMovement(9) → 'dynamic'    (老阳动)
 *   - getMovement(6) → 'dynamic'    (老阴动)
 *   - yaoToMovementBit() 辅助函数
 *   - MOVEMENT_TYPES 常量
 *   - isMoving() 旧 API 仍然保留
 *
 * 运行：node tests/test_yin_yang.js
 */

'use strict';

const path = require('path');
const assert = require('assert');
const yy = require('../yin_yang');

// ============================================================
// 简单测试框架
// ============================================================

let passed = 0;
let failed = 0;
const failures = [];

function it(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failures.push({ name, message: err.message });
    failed++;
  }
}

function describe(groupName, fn) {
  console.log(`\n[${groupName}]`);
  fn();
}

function summary() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`${'='.repeat(60)}`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f.name}: ${f.message}`));
    process.exit(1);
  }
  process.exit(0);
}

// ============================================================
// 测试用例
// ============================================================

describe('MOVEMENT_TYPES 常量', () => {
  it('MOVEMENT_TYPES.STATIC === "static"', () => {
    assert.strictEqual(yy.MOVEMENT_TYPES.STATIC, 'static');
  });
  it('MOVEMENT_TYPES.DYNAMIC === "dynamic"', () => {
    assert.strictEqual(yy.MOVEMENT_TYPES.DYNAMIC, 'dynamic');
  });
});

describe('getMovement() 静爻', () => {
  it('test_movement_static_shaoyang() - 少阳(7)=static', () => {
    assert.strictEqual(yy.getMovement(7), 'static');
  });
  it('test_movement_static_shaoyin() - 少阴(8)=static', () => {
    assert.strictEqual(yy.getMovement(8), 'static');
  });
});

describe('getMovement() 动爻', () => {
  it('test_movement_dynamic_laoyang() - 老阳(9)=dynamic', () => {
    assert.strictEqual(yy.getMovement(9), 'dynamic');
  });
  it('test_movement_dynamic_laoyin() - 老阴(6)=dynamic', () => {
    assert.strictEqual(yy.getMovement(6), 'dynamic');
  });
});

describe('yaoToMovementBit() 8 维向量辅助', () => {
  it('少阳(7) → 0 (静)', () => {
    assert.strictEqual(yy.yaoToMovementBit(7), 0);
  });
  it('少阴(8) → 0 (静)', () => {
    assert.strictEqual(yy.yaoToMovementBit(8), 0);
  });
  it('老阳(9) → 1 (动)', () => {
    assert.strictEqual(yy.yaoToMovementBit(9), 1);
  });
  it('老阴(6) → 1 (动)', () => {
    assert.strictEqual(yy.yaoToMovementBit(6), 1);
  });
  it('返回值类型为 number (0|1)', () => {
    assert.strictEqual(typeof yy.yaoToMovementBit(9), 'number');
  });
});

describe('回归测试 · 现有 API', () => {
  it('isMoving() 仍然存在且工作正常', () => {
    assert.strictEqual(typeof yy.isMoving, 'function');
    assert.strictEqual(yy.isMoving(9), true);
    assert.strictEqual(yy.isMoving(6), true);
    assert.strictEqual(yy.isMoving(7), false);
    assert.strictEqual(yy.isMoving(8), false);
  });
  it('YIN/YANG 常量未变', () => {
    assert.strictEqual(yy.YIN, 0);
    assert.strictEqual(yy.YANG, 1);
  });
  it('yaoToBinary() 未变', () => {
    assert.strictEqual(yy.yaoToBinary('YIN'), 0);
    assert.strictEqual(yy.yaoToBinary(9), 1);
    assert.strictEqual(yy.yaoToBinary(7), 1);
    assert.strictEqual(yy.yaoToBinary(8), 0);
    assert.strictEqual(yy.yaoToBinary(6), 0);
  });
  it('buildTransformedHexagram() 动爻索引仍然正确', () => {
    const r = yy.buildTransformedHexagram([7, 8, 9, 6, 7, 8]);
    assert.deepStrictEqual(r.moving, [2, 3]); // 位置 2(9) 和 位置 3(6) 是动爻
  });
});

describe('集成 · 8 维向量第 2 维 movement', () => {
  it('对 6 爻数组生成 movement flags', () => {
    const yao6 = [7, 9, 8, 6, 7, 8]; // 含 2 个动爻 (位置 1, 3)
    const flags = yao6.map(v => yy.yaoToMovementBit(v));
    assert.deepStrictEqual(flags, [0, 1, 0, 1, 0, 0]);
  });
  it('getMovement 与 isMoving 一致', () => {
    for (const v of [6, 7, 8, 9]) {
      const expected = yy.isMoving(v) ? 'dynamic' : 'static';
      assert.strictEqual(yy.getMovement(v), expected);
    }
  });
});

// ============================================================

summary();
// 2026-11-24: 互/综/错 位运算 64/64 对拍
test('互卦: 否互=渐 泰互=归妹 乾互=乾 (位运算)', () => {
  const yt = require('../yao_transform');
  const h = require('../hexagrams');
  const byName = {};
  for (const g of h.HEXAGRAMS) byName[g.name] = g;
  assert.equal(yt.mutualGua(byName['否']).name, '渐');
  assert.equal(yt.mutualGua(byName['泰']).name, '归妹');
  assert.equal(yt.mutualGua(byName['乾']).name, '乾');
});

test('综卦: 屯综=蒙 否综=泰 (反转6位)', () => {
  const yt = require('../yao_transform');
  const h = require('../hexagrams');
  const byName = {};
  for (const g of h.HEXAGRAMS) byName[g.name] = g;
  assert.equal(yt.converseGua(byName['屯']).name, '蒙');
  assert.equal(yt.converseGua(byName['否']).name, '泰');
});

test('错卦: 否错=泰 乾错=坤 (XOR 111111)', () => {
  const yt = require('../yao_transform');
  const h = require('../hexagrams');
  const byName = {};
  for (const g of h.HEXAGRAMS) byName[g.name] = g;
  assert.equal(yt.opposedGua(byName['否']).name, '泰');
  assert.equal(yt.opposedGua(byName['乾']).name, '坤');
});

test('64卦全量位运算表: 互/综/错 各 64 条, 零幻觉', () => {
  const yt = require('../yao_transform');
  const tbl = yt.buildGuaTransformTable();
  assert.equal(Object.keys(tbl).length, 64);
  for (const [name, t] of Object.entries(tbl)) {
    assert.ok(t.binary, name + ' binary');
    assert.ok(t['互卦'], name + ' 互卦');
    assert.ok(t['综卦'], name + ' 综卦');
    assert.ok(t['错卦'], name + ' 错卦');
  }
});
