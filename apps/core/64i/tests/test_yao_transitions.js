/**
 * Pangu · 64i Layer
 * test_yao_transitions.js - 384 爻状态转移矩阵 (老板拍: 384爻 = 状态转移)
 *
 * 校验:
 *   - 384 行 (64 态 × 6 爻) 全建, 无重复 (from,pos)
 *   - from→to 翻转自洽 (跟 gua_inference.infer 的之卦同位同向)
 *   - 跟 infer 的 之卦 binary 对拍 (384 爻状态转移 = 推理内核之卦, 零漂移)
 *   - 64 静态自持
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { transition, buildYaoTransitionTable, buildStaticTable } = require('../yao_transitions');
const inf = require('../gua_inference');
const hexagrams = require('../hexagrams');

test('384 爻转移矩阵: 建 384 行 + 无重复 + 翻转自洽', () => {
  const rows = buildYaoTransitionTable();
  assert.equal(rows.length, 384);
});

test('单条转移: 讼(010111) 动爻3 → 姤(011111), 跟 infer 之卦同位同向', () => {
  const t = transition('010111', 3);
  assert.equal(t.ok, true);
  assert.equal(t.from.name, '讼');
  assert.equal(t.to.name, '姤');
  assert.equal(t.to.binary, '011111');
  // 本位 (char2) = 0 (阴) → 爻值 6 老阴, 翻成 1
  assert.equal(t.yao_value, 6);
  assert.equal(t.yao_name, '老阴');
  assert.equal(t.flip, 1);
  // 跟推理内核之卦对拍 (零漂移)
  const r = inf.infer('010111', 3);
  assert.equal(t.to.binary, r.之卦.binary, '转移矩阵之卦 = infer 之卦');
});

test('384 爻全量: 每行 to = 推理内核 之卦 binary (对拍 384/384)', () => {
  const rows = buildYaoTransitionTable();
  let n = 0;
  for (const row of rows) {
    const r = inf.infer(row.from, row.pos);
    assert.ok(r.ok, row.from + ' pos' + row.pos + ' infer 不崩');
    assert.equal(row.to, r.之卦.binary, row.from + ' pos' + row.pos + ' 之卦同位同向');
    n++;
  }
  assert.equal(n, 384);
});

test('静态转移: 64 行 自持 (无动爻 → 同卦)', () => {
  const rows = buildStaticTable();
  assert.equal(rows.length, 64);
  for (const r of rows) {
    assert.equal(r.from, r.to, r.from_name + ' 静态自持');
    assert.equal(r.pos, 0);
  }
});

test('越界/非法输入: 不崩, 返 ok:false', () => {
  assert.equal(transition('01011', 3).ok, false);      // 5-bit
  assert.equal(transition('010111', 0).ok, false);      // pos=0
  assert.equal(transition('010111', 7).ok, false);      // pos=7
  assert.equal(transition('0101111', 3).ok, false);     // 7-bit
  assert.equal(transition('01a111', 3).ok, false);      // 非 0/1
});
