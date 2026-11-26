/**
 * Pangu · 64i Layer
 * yao_transitions.js - 384 爻状态转移矩阵 (2026-11-24 老板拍: 384爻 = 状态转移)
 *
 * 职责: 把「哪一爻动 → 下一态」抽成独立数据层。
 *   64 态 (6-bit 卦码) × 6 爻位 = 384 行, 每行一条**确定性位运算转移**:
 *     from.binary 翻 第 pos 位 → to.binary (老阳→阴, 老阴→阳, 跟 gua_engine 动爻翻转同位同向)
 *   加上 64 条静态转移 (无动爻 → 自持), 共 448 行, 把 384 爻状态转移做成**可查表**的数据层,
 *   跟 yao_transform.js 的互/综/错 同构 —— 纯位运算, 零幻觉, 跟查表同速。
 *
 * 为什么独立成层 (2026-11-24):
 *   之前 384 爻的位翻转逻辑**内嵌**在 gua_inference.infer / gua_engine.castGua 里,
 *   抽不出来 —— 状态机要「每爻动→下一态」的完整转移表, 得单独一层数据,
 *   推理内核 (infer) 与起卦引擎 (castGua) 都从这层取转移, 不再各写一份翻转。
 *
 * 口径 (跟 yin_yang.js 对齐):
 *   - binary 位序: char0 = 初爻, char5 = 上爻 (自下而上), 跟 hexagrams.js 一致
 *   - 爻值: 阳爻(1)=老阳9(动), 阴爻(0)=老阴6(动); 翻转 1↔0
 *   - pos: 1-6 (1-based, 跟 infer 的 movingYao 同基数), 位下标 = pos-1
 *
 * 自检 (require 时跑): 384 行 from→to 全对 + 无重复 (from,pos) + 64 静态自持全对。
 */
'use strict';

const hexagrams = require('./hexagrams');

// 位翻转: 翻 binary 第 pos-1 位 (1-based pos)
function flipBit(binary, pos) {
  const chars = binary.split('');
  chars[pos - 1] = chars[pos - 1] === '1' ? '0' : '1';
  return chars.join('');
}

// binary → 卦对象 (64 态, 0..63 全空间, 跟 hexagrams 的 BY_BINARY 同构)
const _BYBIN = {};
for (const g of hexagrams.HEXAGRAMS) _BYBIN[g.binary] = g;

/**
 * 单条转移: 某态 某爻动 → 下一态
 * @param {string} binary 6-bit from
 * @param {number} pos 1-6 动爻位 (1-based)
 * @returns {{ok,from:{binary,name,id},pos,yao_value,yao_pos,flip,to:{binary,name,id},x}}
 *   yao_value = 本卦该位阴阳 (1=阳老阳9 / 0=阴老阴6), flip = 翻成 (1-本位)
 */
function transition(binary, pos) {
  if (!binary || binary.length !== 6 || !/^[01]{6}$/.test(binary)) {
    return { ok: false, error: 'binary 必须是 6-bit 0/1 串' };
  }
  if (!Number.isInteger(pos) || pos < 1 || pos > 6) {
    return { ok: false, error: 'pos 必须是 1-6 (1-based, 初爻=1 上爻=6)' };
  }
  const from = _BYBIN[binary];
  const toBin = flipBit(binary, pos);
  const to = _BYBIN[toBin];
  if (!from || !to) return { ok: false, error: '未找到 64 态: ' + (from ? toBin : binary) };
  const bit = parseInt(binary[pos - 1], 10);
  return {
    ok: true,
    from: { binary, name: from.name, id: from.id },
    pos,
    yao_pos_name: ['初爻','二爻','三爻','四爻','五爻','上爻'][pos - 1],
    yao_value: bit === 1 ? 9 : 6,          // 本位阴阳 → 爻值 (阳=老阳9 / 阴=老阴6)
    yao_name: bit === 1 ? '老阳' : '老阴',   // 动爻必为老爻
    flip: 1 - bit,                            // 翻成
    to: { binary: toBin, name: to.name, id: to.id },
    x: bit,                                   // 本位值 (1/0)
  };
}

/**
 * 384 爻转移矩阵 (64 × 6, 全动爻)
 * @returns {Array} 384 行, 每行 {from:{binary,name}, pos, yao_name, to:{binary,name}}
 */
function buildYaoTransitionTable() {
  const rows = [];
  for (const g of hexagrams.HEXAGRAMS) {
    for (let pos = 1; pos <= 6; pos++) {
      const t = transition(g.binary, pos);
      if (!t.ok) throw new Error('transition 失败: ' + g.binary + ' pos' + pos + ' ' + t.error);
      rows.push({
        from: t.from.binary, from_name: t.from.name,
        pos, yao_name: t.yao_name,
        to: t.to.binary, to_name: t.to.name,
      });
    }
  }
  _assertCoverage(rows);
  return rows;
}

/**
 * 静态转移 (64 行, 无动爻 → 自持)
 * @returns {Array} 每行 {from, to: 同卦, pos: 0}
 */
function buildStaticTable() {
  return hexagrams.HEXAGRAMS.map(g => ({
    from: g.binary, from_name: g.name, pos: 0, yao_name: '静', to: g.binary, to_name: g.name,
  }));
}

// 自检: 384 行 (from,pos) 无重复 + from→to 翻转自洽 + 64 静态自持
function _assertCoverage(rows) {
  const seen = new Set();
  for (const r of rows) {
    const key = r.from + ':' + r.pos;
    if (seen.has(key)) throw new Error('384 爻转移重复: ' + key);
    seen.add(key);
    const t = transition(r.from, r.pos);
    if (t.to.binary !== r.to) throw new Error('转移自洽校验失败: ' + key + ' ' + r.to + ' != ' + t.to.binary);
  }
  if (rows.length !== 384) throw new Error('384 爻转移矩阵应 384 行, 实为 ' + rows.length);
}

module.exports = { transition, buildYaoTransitionTable, buildStaticTable, flipBit };
