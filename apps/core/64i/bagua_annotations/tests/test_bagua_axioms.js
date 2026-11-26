/**
 * Pangu · 64i Layer
 * bagua_annotations/tests/test_bagua_axioms.js
 *
 * bagua_axioms.js 单元测试
 * 8 个测试组：索引查询 / 卦名查询 / 位数查询 / 极性分布 / 五行分布 /
 *           公理总数 / 序号唯一性 / 字段完整性
 *
 * 运行：node bagua_annotations/tests/test_bagua_axioms.js
 */

'use strict';

const path = require('path');
const {
  BAGUA_AXIOMS,
  getBaguaAxioms,
  getBaguaByName,
  getBaguaByBits,
} = require(path.join(__dirname, '..', 'bagua_axioms'));

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
  console.log('Pangu · bagua_axioms 单元测试 (8 组)');
  console.log('='.repeat(60));

  // ---- 1. 按 trigramIndex 查询（1-8 都能查到）----
  section('1. getBaguaAxioms(index) - 8 个序号都能查到');
  for (let i = 1; i <= 8; i++) {
    const axiom = getBaguaAxioms(i);
    assert(axiom !== null, `index=${i} 返回非 null`);
    assert(axiom && axiom.trigramIndex === i, `index=${i} 的 axiom.trigramIndex === ${i}`);
  }
  assert(getBaguaAxioms(0) === null, 'index=0 返回 null');
  assert(getBaguaAxioms(9) === null, 'index=9 返回 null');
  assert(getBaguaAxioms('1') === null, 'index="1" (字符串) 返回 null');

  // ---- 2. 按 name 查询 ----
  section('2. getBaguaByName(name) - 8 个卦名都能查到');
  const NAMES = ['乾', '兑', '离', '巽', '震', '艮', '坎', '坤'];
  for (const name of NAMES) {
    const axiom = getBaguaByName(name);
    assert(axiom !== null, `name="${name}" 返回非 null`);
    assert(axiom && axiom.name === name, `name="${name}" 的 axiom.name === "${name}"`);
  }
  assert(getBaguaByName('unknown') === null, 'name="unknown" 返回 null');
  assert(getBaguaByName(null) === null, 'name=null 返回 null');

  // ---- 3. 按 bits 查询 ----
  section('3. getBaguaByBits(bits) - 8 个二进制编码都能查到');
  const BITS = ['111', '110', '101', '011', '100', '001', '010', '000'];
  for (const bits of BITS) {
    const axiom = getBaguaByBits(bits);
    assert(axiom !== null, `bits="${bits}" 返回非 null`);
    assert(axiom && axiom.bits === bits, `bits="${bits}" 的 axiom.bits === "${bits}"`);
  }
  assert(getBaguaByBits('999') === null, 'bits="999" 返回 null');
  assert(getBaguaByBits('') === null, 'bits="" 返回 null');

  // ---- 4. 极性分布 ----
  section('4. 极性分布 - 阳 4 (乾震坎艮) + 阴 4 (兑离巽坤)');
  const yangList = BAGUA_AXIOMS.filter(a => a.polarity === '阳').map(a => a.name);
  const yinList = BAGUA_AXIOMS.filter(a => a.polarity === '阴').map(a => a.name);
  assert(yangList.length === 4, `阳卦数量 === 4（实际：${yangList.length}）`);
  assert(yinList.length === 4, `阴卦数量 === 4（实际：${yinList.length}）`);
  assert(
    yangList.includes('乾') && yangList.includes('震') && yangList.includes('坎') && yangList.includes('艮'),
    `阳卦包含 乾震坎艮（实际：${yangList.join(',')}）`
  );
  assert(
    yinList.includes('兑') && yinList.includes('离') && yinList.includes('巽') && yinList.includes('坤'),
    `阴卦包含 兑离巽坤（实际：${yinList.join(',')}）`
  );

  // ---- 5. 五行分布 ----
  section('5. 五行分布 - 金2/木2/水1/火1/土2');
  const wuxingCount = {};
  for (const a of BAGUA_AXIOMS) {
    wuxingCount[a.wuxing] = (wuxingCount[a.wuxing] || 0) + 1;
  }
  assert(wuxingCount['金'] === 2, `金 === 2（实际：${wuxingCount['金'] || 0}）`);
  assert(wuxingCount['木'] === 2, `木 === 2（实际：${wuxingCount['木'] || 0}）`);
  assert(wuxingCount['水'] === 1, `水 === 1（实际：${wuxingCount['水'] || 0}）`);
  assert(wuxingCount['火'] === 1, `火 === 1（实际：${wuxingCount['火'] || 0}）`);
  assert(wuxingCount['土'] === 2, `土 === 2（实际：${wuxingCount['土'] || 0}）`);

  // 五行-卦名对应
  const jin = BAGUA_AXIOMS.filter(a => a.wuxing === '金').map(a => a.name).sort().join(',');
  const mu = BAGUA_AXIOMS.filter(a => a.wuxing === '木').map(a => a.name).sort().join(',');
  const shui = BAGUA_AXIOMS.filter(a => a.wuxing === '水').map(a => a.name).sort().join(',');
  const huo = BAGUA_AXIOMS.filter(a => a.wuxing === '火').map(a => a.name).sort().join(',');
  const tu = BAGUA_AXIOMS.filter(a => a.wuxing === '土').map(a => a.name).sort().join(',');
  assert(jin === '乾,兑', `金 → 乾,兑（实际：${jin}）`);
  assert(mu === '巽,震', `木 → 巽,震（实际：${mu}）`);
  assert(shui === '坎', `水 → 坎（实际：${shui}）`);
  assert(huo === '离', `火 → 离（实际：${huo}）`);
  assert(tu === '坤,艮', `土 → 坤,艮（实际：${tu}）`);

  // ---- 6. 公理总数 ----
  section('6. BAGUA_AXIOMS 数组完整性');
  assert(Array.isArray(BAGUA_AXIOMS), 'BAGUA_AXIOMS 是数组');
  assert(BAGUA_AXIOMS.length === 8, `BAGUA_AXIOMS.length === 8（实际：${BAGUA_AXIOMS.length}）`);

  // ---- 7. 序号/卦名/位数唯一性 ----
  section('7. 序号/卦名/位数 唯一性');
  const indices = BAGUA_AXIOMS.map(a => a.trigramIndex);
  const uniqueIndices = new Set(indices);
  assert(uniqueIndices.size === 8, `trigramIndex 唯一（实际：${uniqueIndices.size}）`);

  const names = BAGUA_AXIOMS.map(a => a.name);
  const uniqueNames = new Set(names);
  assert(uniqueNames.size === 8, `name 唯一（实际：${uniqueNames.size}）`);

  const bitsList = BAGUA_AXIOMS.map(a => a.bits);
  const uniqueBits = new Set(bitsList);
  assert(uniqueBits.size === 8, `bits 唯一（实际：${uniqueBits.size}）`);

  // ---- 8. 字段完整性 ----
  section('8. 12 字段完整性 + 类型校验');
  const REQUIRED = ['name', 'symbol', 'bits', 'trigramIndex', 'polarity', 'wuxing', 'family', 'nature', 'season', 'direction', 'attribute', 'keywords'];
  for (const axiom of BAGUA_AXIOMS) {
    for (const field of REQUIRED) {
      assert(field in axiom, `${axiom.name} 有字段 ${field}`);
    }
    assert(typeof axiom.name === 'string', `${axiom.name}.name 是 string`);
    assert(typeof axiom.symbol === 'string', `${axiom.name}.symbol 是 string`);
    assert(typeof axiom.bits === 'string' && axiom.bits.length === 3, `${axiom.name}.bits 是 3 位 string`);
    assert(typeof axiom.trigramIndex === 'number', `${axiom.name}.trigramIndex 是 number`);
    assert(axiom.polarity === '阳' || axiom.polarity === '阴', `${axiom.name}.polarity 是 阳/阴`);
    assert(['金', '木', '水', '火', '土'].includes(axiom.wuxing), `${axiom.name}.wuxing 是五行之一`);
    assert(Array.isArray(axiom.keywords) && axiom.keywords.length > 0, `${axiom.name}.keywords 是非空数组`);
  }

  // 符号校验
  // ⚠️ 2026-10-22 第 42 批: 原来这里写死的是 ['☰','☱','☲','☴','☳','☶','☵','☷']
  //   (乾兑离**巽震艮坎**坤) —— 那正是「先天序错位」那个 bug 的形状, 测试把 bug 锁住了。
  //   出处(64i/sources/course_bagua_fundamental.txt):
  //     「八卦的顺序是乾一、兑二、离三、震四、巽五、坎六、艮七、坤八。」
  //   现在改成**按卦名对符号**(不依赖数组位置), 另有一条单独锁先天序。
  const WANT_SYMBOL = { 乾: '☰', 兑: '☱', 离: '☲', 震: '☳', 巽: '☴', 坎: '☵', 艮: '☶', 坤: '☷' };
  for (const a of BAGUA_AXIOMS) {
    assert(a.symbol === WANT_SYMBOL[a.name], `${a.name} 的符号是 ${WANT_SYMBOL[a.name]}（实际 ${a.symbol}）`);
  }
  const XIAN_TIAN_ORDER = ['乾', '兑', '离', '震', '巽', '坎', '艮', '坤'];
  const byIndex = BAGUA_AXIOMS.slice().sort((x, y) => x.trigramIndex - y.trigramIndex).map(a => a.name);
  assert(
    byIndex.join('') === XIAN_TIAN_ORDER.join(''),
    `先天序是 乾一兑二离三震四巽五坎六艮七坤八（实际 ${byIndex.join('')}）`
  );

  // ---- 12. bits ↔ trigramIndex 是同一个编码的两种读法(2026-10-23 第 52 批) ----
  //
  // 起因: 老板一句提问顶掉了我之前一整段说法 ——
  //   「乾=111=7 兑=110=6 … 坤=000=0, 你这么考虑是不是就不存在三套顺序的问题了?」
  // 实测 8/8 全中。**他说得对。** 我此前说「爻位序/二进制序/后天序三套并存」是错的:
  //   只有一个编码 bits(爻画自下而上, 阴0阳1);
  //   先天数 = 8 − parseInt(bits,2), 8/8 成立 ⇒ 它是 bits 的**读法**, 不是独立的序。
  //   真正独立的只有后天序(洛书方位), 它跟 bits 无关, 非单调, 只能查表。
  //
  // ⚠️ 为什么这条必须写成断言:
  //   第 7 节只验「bits 唯一」, 上面那条只验「先天序名字顺序对」,
  //   **两者之间的关系没人管**。于是把 trigramIndex 改成 bits 的数(震 4→5),
  //   只要 bits 不动, 测试照样全绿 —— 那正是"三套序"这个错觉能活下来的原因。
  section('12. 先天数 ≡ 8 − bits 的值(不存在"三套序"的证据)');
  for (const a of BAGUA_AXIOMS) {
    const v = parseInt(a.bits, 2);
    assert(a.trigramIndex === 8 - v,
      `${a.name} bits=${a.bits}(=${v}) ⇒ 先天数应为 ${8 - v}, 表里是 ${a.trigramIndex}`);
  }
  // 反过来: 按 bits 的值排序, 先天数必须**严格递减** —— 单调性也是关系的一部分。
  const byValue = BAGUA_AXIOMS.slice().sort((x, y) => parseInt(x.bits, 2) - parseInt(y.bits, 2));
  const idxSeq = byValue.map(a => a.trigramIndex);
  assert(idxSeq.join(',') === '8,7,6,5,4,3,2,1',
    `按 bits 升序, 先天数应严格递减 8..1（实际：${idxSeq.join(',')}）`);

  // ---- 汇总 ----
  console.log('\n' + '='.repeat(60));
  console.log(`测试结果：✅ ${passed} 项通过  ❌ ${failed} 项失败`);
  console.log('='.repeat(60));

  if (failed === 0) {
    console.log('\n🎯 8 组测试全部通过！bagua_axioms.js 验证完毕。');
    process.exit(0);
  } else {
    console.log(`\n⚠️  有 ${failed} 项失败，请检查 bagua_axioms.js。`);
    process.exit(1);
  }
}

run();
