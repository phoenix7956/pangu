/**
 * Pangu · 64i Layer
 * tests/test_hexagram_vector.js - Pangu 8 维向量聚合器 单测
 *
 * 覆盖范围：
 *   1. 单爻 8 维向量（基础字段、阴/阳爻、爻位五行）
 *   2. 一卦 6 爻向量（nature 全覆盖）
 *   3. 全 384 爻（长度、字段完备、ID 覆盖）
 *   4. 边界与非法输入（null 返回）
 *   5. Sanity check（与 wuxing_axioms / liu_qin 验证过的数据对照）
 *   6. 批量与多卦
 *
 * 运行：node tests/test_hexagram_vector.js
 */

'use strict';

const path = require('path');
const assert = require('assert');
const hv = require('../hexagram_vector');
const wuxingAxioms = require('../bagua_annotations/wuxing_axioms');
const liuQinMod = require('../bagua_annotations/liu_qin');

// ============================================================
// 简单测试框架
// ============================================================

let passed = 0;
let failed = 0;
const failures = [];

function it(name, fn) {
  try {
    fn();
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
  console.log('✅ ALL TESTS PASSED');
  process.exit(0);
}

// ============================================================
// 工具函数：检查 8 维向量核心字段
// ============================================================

const CORE_FIELDS = [
  'guaId', 'yaoPosition', 'yinYang', 'movement', 'yaoValue',
  'upperBagua', 'lowerBagua',
  'guaWuxing', 'yaoWuxing', 'wuxingRel',
  'yaoName', 'positionNature', 'liuQin', 'yaoCi',
  'changedGuaId', 'changedYao',
];

function assertHasCoreFields(v) {
  for (const f of CORE_FIELDS) {
    assert.ok(f in v, `missing field: ${f}`);
  }
}

// ============================================================
// 测试用例
// ============================================================

describe('1. 单爻 · getYaoVector() 基础', () => {
  it('getYaoVector(1, 0) 返回对象', () => {
    const v = hv.getYaoVector(1, 0);
    assert.strictEqual(typeof v, 'object');
    assert.notStrictEqual(v, null);
  });
  it('guaId === 1', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).guaId, 1);
  });
  it('yaoPosition === 0', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).yaoPosition, 0);
  });
  it('yaoWuxing === "水" (初爻=水)', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).yaoWuxing, '水');
  });
  it('guaWuxing === "金" (乾=金)', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).guaWuxing, '金');
  });
  it('wuxingRel 是 "金生水" (金 vs 水 = sheng)', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).wuxingRel, '金生水');
  });
  it('wuxingRel 含关系标签', () => {
    const r = hv.getYaoVector(1, 0).wuxingRel;
    assert.ok(r.includes('生') || r.includes('克') || r.includes('同'),
      `wuxingRel="${r}" 应含 "生" / "克" / "同"`);
  });
  it('liuQin 是 5 个之一', () => {
    const lq = hv.getYaoVector(1, 0).liuQin;
    assert.ok(hv.VALID_LIU_QIN.includes(lq), `liuQin="${lq}" not in ${hv.VALID_LIU_QIN}`);
  });
  it('yaoCi 是非空字符串', () => {
    const c = hv.getYaoVector(1, 0).yaoCi;
    assert.strictEqual(typeof c, 'string');
    assert.ok(c.length > 0);
  });
  it('yaoCi 包含 "潜龙勿用"', () => {
    assert.ok(hv.getYaoVector(1, 0).yaoCi.includes('潜龙勿用'));
  });
  it('yaoValue === 7 (阳爻默认少阳静)', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).yaoValue, 7);
  });
  it('movement === "static" (默认静)', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).movement, 'static');
  });
  it('yinYang === 1 (乾初爻=阳)', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).yinYang, 1);
  });
  it('upperBagua.name === "乾"', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).upperBagua.name, '乾');
  });
  it('upperBagua.symbol === "☰"', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).upperBagua.symbol, '☰');
  });
  it('upperBagua.wuxing === "金"', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).upperBagua.wuxing, '金');
  });
  it('lowerBagua.name === "乾"', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).lowerBagua.name, '乾');
  });
  it('lowerBagua.symbol === "☰"', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).lowerBagua.symbol, '☰');
  });
  it('lowerBagua.wuxing === "金"', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).lowerBagua.wuxing, '金');
  });
  it('yaoName === "初九" (阳爻)', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).yaoName, '初九');
  });
  it('positionNature === "根元"', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).positionNature, '根元');
  });
  it('changedGuaId === null (扩展位)', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).changedGuaId, null);
  });
  it('changedYao === null (扩展位)', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).changedYao, null);
  });
});

describe('2. 单爻 · 阴爻 (坤 guaId=2)', () => {
  it('guaId=2 yaoPosition=0 返回对象', () => {
    const v = hv.getYaoVector(2, 0);
    assert.notStrictEqual(v, null);
  });
  it('yinYang === 0 (坤初爻=阴)', () => {
    assert.strictEqual(hv.getYaoVector(2, 0).yinYang, 0);
  });
  it('yaoValue === 8 (阴爻默认少阴静)', () => {
    assert.strictEqual(hv.getYaoVector(2, 0).yaoValue, 8);
  });
  it('movement === "static"', () => {
    assert.strictEqual(hv.getYaoVector(2, 0).movement, 'static');
  });
  it('yaoName === "初六" (阴爻)', () => {
    assert.strictEqual(hv.getYaoVector(2, 0).yaoName, '初六');
  });
  // 注: wuxing_map.js 的 guaId=2 现在是 '土'（与上卦口径 64/64 吻合）。
  //   这条注释原来写「标为 '金', 实际应为 '土'」—— 数据早就修成 '土' 了，
  //   2026-10-22 第 42 批把过期描述一并改掉，别让后来人以为还有偏差。
  it('guaWuxing 来自 wuxing_map (guaId=2 现行值: "土")', () => {
    const v = hv.getYaoVector(2, 0);
    assert.strictEqual(typeof v.guaWuxing, 'string');
    assert.ok(['金', '木', '水', '火', '土'].includes(v.guaWuxing));
  });
  it('yaoCi 包含 "履霜"', () => {
    assert.ok(hv.getYaoVector(2, 0).yaoCi.includes('履霜'));
  });
  it('upperBagua.name === "坤" 与 lowerBagua.name === "坤"', () => {
    const v = hv.getYaoVector(2, 0);
    assert.strictEqual(v.upperBagua.name, '坤');
    assert.strictEqual(v.lowerBagua.name, '坤');
  });
});

describe('3. 一卦 6 爻 · getGuaVector()', () => {
  it('getGuaVector(1) 返回 6 元素数组', () => {
    const v = hv.getGuaVector(1);
    assert.ok(Array.isArray(v));
    assert.strictEqual(v.length, 6);
  });
  it('position 0 (初爻) nature === "根元"', () => {
    assert.strictEqual(hv.getGuaVector(1)[0].positionNature, '根元');
  });
  it('position 1 (二爻) nature === "身本"', () => {
    assert.strictEqual(hv.getGuaVector(1)[1].positionNature, '身本');
  });
  it('position 2 (三爻) nature === "动用"', () => {
    assert.strictEqual(hv.getGuaVector(1)[2].positionNature, '动用');
  });
  it('position 3 (四爻) nature === "变机"', () => {
    assert.strictEqual(hv.getGuaVector(1)[3].positionNature, '变机');
  });
  it('position 4 (五爻) nature === "德成"', () => {
    assert.strictEqual(hv.getGuaVector(1)[4].positionNature, '德成');
  });
  it('position 5 (上爻) nature === "极终"', () => {
    assert.strictEqual(hv.getGuaVector(1)[5].positionNature, '极终');
  });
  it('6 爻 yaoPosition 顺序 0-5', () => {
    const v = hv.getGuaVector(1);
    for (let i = 0; i < 6; i++) {
      assert.strictEqual(v[i].yaoPosition, i);
    }
  });
  it('6 爻 guaId 一致 (===1)', () => {
    const v = hv.getGuaVector(1);
    for (const y of v) {
      assert.strictEqual(y.guaId, 1);
    }
  });
  it('6 爻都含核心字段', () => {
    const v = hv.getGuaVector(1);
    for (const y of v) assertHasCoreFields(y);
  });
});

describe('4. 全 384 爻 · getAll384YaoVectors()', () => {
  it('返回长度 === 384', () => {
    const all = hv.getAll384YaoVectors();
    assert.strictEqual(all.length, 384);
  });
  it('每个元素都是对象', () => {
    const all = hv.getAll384YaoVectors();
    for (const y of all) assert.strictEqual(typeof y, 'object');
  });
  it('每个元素都含核心 8 维字段', () => {
    const all = hv.getAll384YaoVectors();
    for (const y of all) assertHasCoreFields(y);
  });
  it('64 个 guaId 全覆盖', () => {
    const all = hv.getAll384YaoVectors();
    const ids = new Set(all.map(y => y.guaId));
    assert.strictEqual(ids.size, 64);
    for (let g = 1; g <= 64; g++) {
      assert.ok(ids.has(g), `missing guaId=${g}`);
    }
  });
  it('每个 guaId 恰好 6 个 yaoPosition', () => {
    const all = hv.getAll384YaoVectors();
    const counts = {};
    for (const y of all) {
      counts[y.guaId] = (counts[y.guaId] || 0) + 1;
    }
    for (let g = 1; g <= 64; g++) {
      assert.strictEqual(counts[g], 6, `guaId=${g} 应有 6 爻，实际 ${counts[g]}`);
    }
  });
  it('yaoPosition 范围 0-5 全覆盖', () => {
    const all = hv.getAll384YaoVectors();
    const positions = new Set(all.map(y => y.yaoPosition));
    assert.strictEqual(positions.size, 6);
    for (let p = 0; p < 6; p++) {
      assert.ok(positions.has(p), `missing position=${p}`);
    }
  });
});

describe('5. 边界 · getYaoVector() 非法输入', () => {
  it('getYaoVector(0, 0) === null (guaId 下界)', () => {
    assert.strictEqual(hv.getYaoVector(0, 0), null);
  });
  it('getYaoVector(65, 0) === null (guaId 上界)', () => {
    assert.strictEqual(hv.getYaoVector(65, 0), null);
  });
  it('getYaoVector(-1, 0) === null', () => {
    assert.strictEqual(hv.getYaoVector(-1, 0), null);
  });
  it('getYaoVector(1, -1) === null (yaoPosition 下界)', () => {
    assert.strictEqual(hv.getYaoVector(1, -1), null);
  });
  it('getYaoVector(1, 6) === null (yaoPosition 上界)', () => {
    assert.strictEqual(hv.getYaoVector(1, 6), null);
  });
  it('getYaoVector(1, 100) === null', () => {
    assert.strictEqual(hv.getYaoVector(1, 100), null);
  });
  it('getYaoVector("1", 0) === null (字符串)', () => {
    assert.strictEqual(hv.getYaoVector('1', 0), null);
  });
  it('getYaoVector(null, 0) === null', () => {
    assert.strictEqual(hv.getYaoVector(null, 0), null);
  });
  it('getYaoVector(undefined, 0) === null', () => {
    assert.strictEqual(hv.getYaoVector(undefined, 0), null);
  });
  it('getYaoVector(1, null) === null', () => {
    assert.strictEqual(hv.getYaoVector(1, null), null);
  });
  it('getYaoVector(1.5, 0) === null (非整数)', () => {
    assert.strictEqual(hv.getYaoVector(1.5, 0), null);
  });
  it('getYaoVector(1, 1.5) === null (非整数)', () => {
    assert.strictEqual(hv.getYaoVector(1, 1.5), null);
  });
  it('getGuaVector(0) === null', () => {
    assert.strictEqual(hv.getGuaVector(0), null);
  });
  it('getGuaVector(65) === null', () => {
    assert.strictEqual(hv.getGuaVector(65), null);
  });
});

describe('6. Sanity check · 与 wuxing_axioms / liu_qin 验证过的数据对照', () => {
  // ⚠️ 第 36 批: 爻五行不再取「爻位固定五行表」(初水二木三火四金五土上火) ——
  //   那张表查无出处, 且与真纳甲地支在可验爻位上大幅冲突, 已撤。
  //   现在取**该爻的纳甲地支五行**。真源(<course-source>·八字神煞大全 阳德条):
  //     「乾六爻自初爻至上面爻之爻辰为『子寅辰午申戌』」
  //   ⇒ 子水 寅木 辰土 午火 申金 戌土
  // 京房乾宫属金 ⇒ 六亲 = 子孙/妻财/父母/官鬼/兄弟/父母
  //   (与旧表算出来的子孙/妻财/官鬼/兄弟/父母/官鬼 **差 4 个爻**)
  it('乾 pos=4 liuQin === "兄弟" (申金与乾宫同为金)', () => {
    const v = hv.getYaoVector(1, 4);
    assert.strictEqual(v.liuQin, '兄弟');
    assert.strictEqual(v.yaoWuxing, '金');
  });
  it('乾 pos=4 wuxingRel === "金同金" (卦金 vs 爻申金)', () => {
    const v = hv.getYaoVector(1, 4);
    assert.strictEqual(v.wuxingRel, '金同金');
  });
  it('乾 pos=3 liuQin === "官鬼" (午火克金)', () => {
    const v = hv.getYaoVector(1, 3);
    assert.strictEqual(v.liuQin, '官鬼');
    assert.strictEqual(v.yaoWuxing, '火');
  });
  it('乾 pos=3 wuxingRel === "金耗火" (卦金 vs 爻午火)', () => {
    assert.strictEqual(hv.getYaoVector(1, 3).wuxingRel, '金耗火');
  });
  it('乾 pos=0 wuxingRel === "金生水"', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).wuxingRel, '金生水');
  });
  it('乾 pos=0 liuQin === "子孙" (金 sheng 水 → 我生对方)', () => {
    assert.strictEqual(hv.getYaoVector(1, 0).liuQin, '子孙');
  });
  it('乾 pos=1 liuQin === "妻财" (金 ke 木)', () => {
    assert.strictEqual(hv.getYaoVector(1, 1).liuQin, '妻财');
  });
  it('乾 pos=2 liuQin === "父母" (辰土生金)', () => {
    assert.strictEqual(hv.getYaoVector(1, 2).liuQin, '父母');
    assert.strictEqual(hv.getYaoVector(1, 2).wuxingRel, '金泄土');
  });
  it('乾 pos=5 liuQin === "父母" (戌土生金)', () => {
    assert.strictEqual(hv.getYaoVector(1, 5).liuQin, '父母');
    assert.strictEqual(hv.getYaoVector(1, 5).yaoWuxing, '土');
  });
  // 与 liu_qin.computeLiuQin 直接对比 (1 卦全 6 爻)
  it('与 liu_qin.computeLiuQin(guaId, pos) 结果一致', () => {
    for (let p = 0; p < 6; p++) {
      const expected = liuQinMod.computeLiuQin(1, p);
      const actual = hv.getYaoVector(1, p).liuQin;
      assert.strictEqual(actual, expected, `pos=${p}: expected=${expected}, actual=${actual}`);
    }
  });
});

describe('7. 多卦 / 批量 API', () => {
  it('getVectorsForGuas([1]) 长度 === 6', () => {
    assert.strictEqual(hv.getVectorsForGuas([1]).length, 6);
  });
  it('getVectorsForGuas([1, 2]) 长度 === 12', () => {
    assert.strictEqual(hv.getVectorsForGuas([1, 2]).length, 12);
  });
  it('getVectorsForGuas([1, 2, 3]) 长度 === 18', () => {
    assert.strictEqual(hv.getVectorsForGuas([1, 2, 3]).length, 18);
  });
  it('getVectorsForGuas([]) 长度 === 0', () => {
    assert.strictEqual(hv.getVectorsForGuas([]).length, 0);
  });
  it('getVectorsForGuas(null) 返回 [] (非数组安全)', () => {
    assert.deepStrictEqual(hv.getVectorsForGuas(null), []);
  });
  it('getVectorsForGuas("xxx") 返回 []', () => {
    assert.deepStrictEqual(hv.getVectorsForGuas('xxx'), []);
  });
  it('getVectorsForGuas([1, 999, 2]) 跳过非法 guaId, 长度 === 12', () => {
    // 999 非法 → 跳过; 1 + 2 合法 → 6+6 = 12
    assert.strictEqual(hv.getVectorsForGuas([1, 999, 2]).length, 12);
  });
  it('getVectorsForGuas 返回数组每项都含 guaId', () => {
    const arr = hv.getVectorsForGuas([1, 64]);
    assert.strictEqual(arr.length, 12);
    assert.strictEqual(arr[0].guaId, 1);
    assert.strictEqual(arr[6].guaId, 64);
  });
});

describe('8. 多卦一致性 · 八卦拆解', () => {
  it('guaId=3 (屯): upper=坎 lower=震', () => {
    const v = hv.getYaoVector(3, 0);
    assert.strictEqual(v.upperBagua.name, '坎');
    assert.strictEqual(v.lowerBagua.name, '震');
  });
  it('guaId=2 (坤): upper=坤 lower=坤 (上下一致)', () => {
    const v = hv.getYaoVector(2, 0);
    assert.strictEqual(v.upperBagua.name, '坤');
    assert.strictEqual(v.lowerBagua.name, '坤');
  });
  it('guaId=64 (未济): upper=离 lower=坎', () => {
    const v = hv.getYaoVector(64, 0);
    assert.strictEqual(v.upperBagua.name, '离');
    assert.strictEqual(v.lowerBagua.name, '坎');
  });
  it('guaId=18 (蛊): upper=艮 lower=巽', () => {
    const v = hv.getYaoVector(18, 0);
    assert.strictEqual(v.upperBagua.name, '艮');
    assert.strictEqual(v.lowerBagua.name, '巽');
  });
});

describe('9. 爻辞完整性', () => {
  it('乾 6 爻爻辞全包含关键字', () => {
    const v = hv.getGuaVector(1);
    assert.ok(v[0].yaoCi.includes('潜龙勿用'));
    assert.ok(v[1].yaoCi.includes('见龙在田'));
    assert.ok(v[2].yaoCi.includes('君子终日乾乾'));
    assert.ok(v[3].yaoCi.includes('或跃在渊'));
    assert.ok(v[4].yaoCi.includes('飞龙在天'));
    assert.ok(v[5].yaoCi.includes('亢龙有悔'));
  });
  it('坤 6 爻爻辞全包含关键字', () => {
    const v = hv.getGuaVector(2);
    assert.ok(v[0].yaoCi.includes('履霜'));
    assert.ok(v[1].yaoCi.includes('直方大'));
    assert.ok(v[5].yaoCi.includes('龙战'));
  });
});

describe('10. 导出常量 sanity', () => {
  it('VALID_RELATIONS 包含 sheng/ke/tong', () => {
    assert.ok(hv.VALID_RELATIONS.includes('sheng'));
    assert.ok(hv.VALID_RELATIONS.includes('ke'));
    assert.ok(hv.VALID_RELATIONS.includes('tong'));
  });
  it('VALID_LIU_QIN 包含 5 个标准六亲', () => {
    assert.strictEqual(hv.VALID_LIU_QIN.length, 5);
    assert.ok(hv.VALID_LIU_QIN.includes('父母'));
    assert.ok(hv.VALID_LIU_QIN.includes('兄弟'));
    assert.ok(hv.VALID_LIU_QIN.includes('子孙'));
    assert.ok(hv.VALID_LIU_QIN.includes('妻财'));
    assert.ok(hv.VALID_LIU_QIN.includes('官鬼'));
  });
  it('RELATION_CN 中文标签正确', () => {
    assert.strictEqual(hv.RELATION_CN.sheng, '生');
    assert.strictEqual(hv.RELATION_CN.ke, '克');
    assert.strictEqual(hv.RELATION_CN.tong, '同');
  });
  it('DEFAULT_YAO_VALUE.YANG === 7', () => {
    assert.strictEqual(hv.DEFAULT_YAO_VALUE.YANG, 7);
  });
  it('DEFAULT_YAO_VALUE.YIN === 8', () => {
    assert.strictEqual(hv.DEFAULT_YAO_VALUE.YIN, 8);
  });
});

// ============================================================

summary();
