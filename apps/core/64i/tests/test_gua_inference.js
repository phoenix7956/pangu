'use strict';
const test = require('node:test');
const assert = require('node:assert');
const inf = require('../gua_inference');
const enc = require('../gua_encoding');
const h = require('../hexagrams');

test('推理内核: 讼 010111 动爻3 → 5卦位串 + 决策', () => {
  const r = inf.infer('010111', 3);
  assert.equal(r.ok, true);
  assert.equal(r.本卦.binary, '010111');
  assert.equal(r.之卦.name, '姤');
  assert.equal(r.互卦.name, '家人');
  assert.equal(r.综卦.name, '需');
  assert.equal(r.错卦.name, '明夷');
  assert.equal(r.阳爻数, 4);
  assert.equal(r.动爻位, 3);
  assert.ok(['进','守','固','争','避'].includes(r.决策));
});

test('编码规则: 数字卦 9,6,3 → 讼 (跟 gua_engine 对齐)', () => {
  const r = enc.castByNumbers([9, 6, 3]);
  assert.equal(r.name, '讼');
  assert.equal(r.binary, '010111');
});

test('编码规则: 64 纯卦 + 全 64 态 可编码 (完备性)', () => {
  // 8 纯卦 (上下同)
  for (let n = 1; n <= 8; n++) {
    const r = enc.toHexagram(n, n);
    assert.ok(r, '纯卦 ' + n);
  }
  // 全 64 态 (上1-8 × 下1-8) 全可编码
  let count = 0;
  for (let u = 1; u <= 8; u++) for (let l = 1; l <= 8; l++) {
    const r = enc.toHexagram(u, l);
    assert.ok(r, `态 ${u},${l}`);
    assert.equal(r.binary.length, 6);
    count++;
  }
  assert.equal(count, 64);
});

test('推理内核: 64 卦全量位运算 不崩 (完备性)', () => {
  for (const g of h.HEXAGRAMS) {
    const r = inf.infer(g.binary, 3);
    assert.equal(r.ok, true, g.name + ' 推理不崩');
    assert.equal(r.互卦.name, require('../yao_transform').mutualGua(g).name, g.name + ' 互卦一致');
    assert.equal(r.综卦.name, require('../yao_transform').converseGua(g).name, g.name + ' 综卦一致');
    assert.equal(r.错卦.name, require('../yao_transform').opposedGua(g).name, g.name + ' 错卦一致');
  }
});

test('推演链: 讼 010111 动爻3 → 5卦时序 + 每步 XOR 量', () => {
  const c = inf.chainInfer('010111', 3);
  assert.equal(c.ok, true);
  assert.equal(c.链.length, 5);
  assert.deepEqual(c.链.map(s => s.name), ['讼', '姤', '家人', '需', '明夷']);
  // 每步 XOR 量 = 相邻两位串的翻转位 (0 = 未变, 1 = 翻了)
  for (let i = 1; i < c.链.length; i++) {
    assert.equal(c.链[i].位变, _xor6(c.链[i - 1].binary, c.链[i].binary), c.链[i].name + ' XOR 量对得上');
  }
  // 体用轨迹: 本卦金生水 → 之卦金克木
  assert.equal(c.体用轨迹.本卦.关系, '生');
  assert.equal(c.体用轨迹.之卦.关系, '克');
});

test('推演链: 64 卦全量 chainInfer 不崩 (完备性)', () => {
  for (const g of h.HEXAGRAMS) {
    const c = inf.chainInfer(g.binary, 3);
    assert.equal(c.ok, true, g.name + ' 推演链不崩');
    assert.equal(c.链.length, 5, g.name + ' 链长 5');
    assert.equal(c.链[0].binary, g.binary, g.name + ' 链首=本卦');
  }
});

test('推演校验: 模型自推全对 → 0 偏 (讼 010111 动爻3)', () => {
  const r = inf.infer('010111', 3);
  const v = inf.verifyInference('010111', 3, {
    本卦: '010111', 之卦: '011111', 互卦: '101011', 综卦: '111010', 错卦: '101000',
    阳爻数: r.阳爻数, 决策: r.决策,
  });
  assert.equal(v.ok, true);
  assert.equal(v.偏了.length, 0, '全对不该有偏: ' + JSON.stringify(v.偏了));
  assert.equal(v.对上了.length, 7, '本/之/互/综/错/阳爻数/决策 全对');
});

test('推演校验: 模型读串偏 1 位 → 当场炸 (之卦报成 011110)', () => {
  const v = inf.verifyInference('010111', 3, { 之卦: '011110' });
  assert.equal(v.ok, true);
  assert.equal(v.偏了.length, 1, '只偏了之卦 1 项');
  assert.equal(v.偏了[0].位串, '之卦');
  assert.equal(v.偏了[0].内核, '011111');
  assert.equal(v.偏了[0].模型报, '011110');
  assert.ok(/偏 1 项/.test(v.结论));
});

function _xor6(a, b) {
  return a.split('').map((c, i) => (c === b[i] ? '0' : '1')).join('');
}
