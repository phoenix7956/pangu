/**
 * Pangu · 64i Layer
 * gua_inference.js - 位运算推理内核 (2026-11-24 老板拍: 64卦384爻推演万物)
 *
 * 职责: 把 64 态 (6-bit 卦码) + 384 爻 (状态转移) 做成**确定性位运算推理引擎**。
 * 不是查断语表, 是位运算直接驱动 → 输出「该做什么」的确定性结论。
 *
 * 核心理论 (全网共识, 落进盘古本体):
 *   ① 64 卦 = 2^6 完备状态枚举 (跟 6-bit 整数同构, 0-63 全空间)
 *   ② 384 爻 = 64×6 状态转移 (哪一爻动 → 怎么变, 跟有限状态机转移函数同构)
 *   ③ 体用 + 感通: 卦=体(静), 爻动=用(动), 体用交感=推演
 *   ④ 信息论: 64 态编码万物, 384 转移推演变化 → 位运算 = 推演
 *
 * 推理链 (全位运算, 零 LLM):
 *   本卦 → 之卦 (XOR 动爻) → 互卦 (位1-4‖2-5) → 综卦 (NOT) → 错卦 (XOR 111111)
 *   每步 6-bit 位运算, 5 个位串一次出齐, 模型认位串不认中文。
 *
 * 决策输出 (确定性, 不查表):
 *   - 吉凶位: 本卦 binary 的「阳爻数」(1 的个数) → 多阳=进/少阳=守
 *   - 动爻位: 动爻在第几爻 → 初爻=根/二爻=身/三爻=内/四爻=外/五爻=君/上爻=极
 *   - 体用关系: 上卦(体)五行 vs 下卦(用)五行 → 生/克/同 → 吉凶
 *   - 变卦方向: 之卦 binary 的阴阳翻转 → 往哪走
 */
'use strict';

const yt = require('./yao_transform');
const hexagrams = require('./hexagrams');
const wuxingMap = require('./bagua_annotations/wuxing_map');
const BAGUA_WUXING = {
  // 上卦口径 (跟 hexagrams.js elements 一致)
  1: '金', 2: '金', 3: '火', 4: '木', 5: '木', 6: '水', 7: '土', 8: '土',
};

/**
 * 位运算推理: 输入 6-bit 卦码 + 动爻位, 输出 5 卦位串 + 确定性决策
 * @param {string} binary - 6-bit 卦码 (下卦码‖上卦码)
 * @param {number} movingYao - 1-6 动爻位 (1-based, 初爻=1)
 * @returns {object} { 本卦/之卦/互卦/综卦/错卦 (各带 binary+name), 阳爻数, 动爻位, 体用关系, 决策 }
 */
function infer(binary, movingYao) {
  if (!binary || binary.length !== 6) return { ok: false, error: 'binary 必须是 6-bit' };
  const gua = hexagrams.HEXAGRAMS.find(g => g.binary === binary);
  if (!gua) return { ok: false, error: '未找到卦: ' + binary };

  // 5 卦位串 (全位运算)
  const yy = require('./yin_yang');
  const yao6 = _binaryToYao6(binary, movingYao);
  // 翻转动爻位 (位序: 位0=初爻 ... 位5=上爻, 动爻 movingYao 是 1-based → 位 movingYao-1)
  const changedYao6 = yao6.map((v, i) => (i + 1 === movingYao) ? yy.transformYao(v) : v);
  const zhiBinary = yy.yao6ToBinaryString(changedYao6);
  const mutual = yt.mutualGua(gua);
  const converse = yt.converseGua(gua);
  const opposed = yt.opposedGua(gua);

  // 阳爻数 (1 的个数) → 多阳=进/少阳=守
  const yangCount = binary.split('').filter(c => c === '1').length;
  const yinCount = 6 - yangCount;

  // 体用关系: 上卦五行 vs 下卦五行
  const upperWx = BAGUA_WUXING[upperNumOf(binary)];
  const lowerWx = BAGUA_WUXING[lowerNumOf(binary)];
  const rel = _wuxingRelation(upperWx, lowerWx);

  // 动爻位 → 爻位性质
  const posNature = ['根元', '身本', '内明', '外察', '君位', '极位'][movingYao - 1] || '';

  // 决策 (确定性, 不查表):
  //   多阳(≥4) + 上生下 = 进 (进取/开创)
  //   多阳(≥4) + 上克下 = 争 (竞争/破局)
  //   少阳(≤3) + 上生下 = 守 (守成/蓄力)
  //   少阳(≤3) + 上克下 = 避 (退避/待时)
  //   体同 (上下同五行) = 固 (固守/不迁)
  let verdict;
  if (upperWx === lowerWx) {
    verdict = '固';
  } else if (yangCount >= 4) {
    verdict = rel === '生' ? '进' : (rel === '克' ? '争' : '进');
  } else {
    verdict = rel === '生' ? '守' : (rel === '克' ? '避' : '守');
  }

  return {
    ok: true,
    本卦: { binary, id: gua.id, name: gua.name, symbol: gua.symbol },
    之卦: { binary: zhiBinary, name: hexagrams.getHexagramByBinary ? undefined : _byBinary(zhiBinary) },
    互卦: { binary: mutual.binary, name: mutual.name },
    综卦: { binary: converse.binary, name: converse.name },
    错卦: { binary: opposed.binary, name: opposed.name },
    阳爻数: yangCount,
    阴爻数: yinCount,
    动爻位: movingYao,
    爻位性质: posNature,
    体用: { 体: upperWx, 用: lowerWx, 关系: rel },
    决策: verdict,
    决策依据: verdict === '固'
      ? '上下同五行(体同), 固守不迁'
      : (yangCount >= 4 ? '多阳(≥4), ' : '少阳(≤3), ') + '上' + upperWx + _relLabel(rel) + '下' + lowerWx,
  };
}

function _byBinary(b) {
  const g = hexagrams.HEXAGRAMS.find(x => x.binary === b);
  return g ? g.name : '?';
}

function upperNumOf(binary) {
  // binary = 下卦码(左3)‖上卦码(右3), 初→上
  const up = binary.slice(3, 6);
  // 八卦码反查
  const MAP = { '111': 1, '110': 2, '101': 3, '100': 4, '011': 5, '010': 6, '001': 7, '000': 8 };
  return MAP[up] || 1;
}
function lowerNumOf(binary) {
  const lo = binary.slice(0, 3);
  const MAP = { '111': 1, '110': 2, '101': 3, '100': 4, '011': 5, '010': 6, '001': 7, '000': 8 };
  return MAP[lo] || 8;
}

function _wuxingRelation(a, b) {
  const SHENG = { '木': '火', '火': '土', '土': '金', '金': '水', '水': '木' };
  const KE = { '木': '土', '土': '水', '水': '火', '火': '金', '金': '木' };
  if (a === b) return '同';
  if (SHENG[a] === b) return '生';
  if (KE[a] === b) return '克';
  if (SHENG[b] === a) return '被生';
  if (KE[b] === a) return '被克';
  return '同';
}
function _relLabel(r) {
  return { '生': '生', '克': '克', '同': '同', '被生': '泄', '被克': '耗' }[r] || r;
}

function _binaryToYao6(binary, movingYao) {
  // binary 6位 → 6爻值数组 (6/7/8/9), 动爻位 = 老阳/老阴 (动), 其余 = 少阳/少阴 (静)
  const yao6 = binary.split('').map(c => {
    const isYao = (movingYao && parseInt(c) === 1) ? 9 : (movingYao && parseInt(c) === 0) ? 6 : (parseInt(c) === 1 ? 7 : 8);
    // 动爻位: 阳=老阳(9) 阴=老阴(6); 静爻: 阳=少阳(7) 阴=少阴(8)
    return isYao;
  });
  return yao6;
}
function _yao6ToBinary(yao6) {
  return yao6.map(v => (v === 9 || v === 7) ? '1' : '0').join('');
}

// ============================================================
// 推演链 (2026-11-24): 让模型「自己推」— 不是给 进/守 标签, 是给 5 卦位串的
// 时序轨迹 + 每步的确定性关系 (生/克/同), 模型拿位串自己读出推演。
// 古人「脑内推」, 盘古「位串推」— 位串是确定性输入, 推理是模型的动作。
// ============================================================

/**
 * 推演链: 本卦 → 之卦 → 互卦 → 综卦 → 错卦, 每步带 5-bit 变化量 (XOR 量)
 * @param {string} binary 6-bit 本卦码
 * @param {number} movingYao 1-6 动爻位
 * @returns {object} { 链: [{卦名, binary, 位变, 关系}], 动爻轨迹, 体用轨迹 }
 */
function chainInfer(binary, movingYao) {
  const r = infer(binary, movingYao)
  if (!r.ok) return { ok: false, error: r.error }
  const yy = require('./yin_yang')
  const byBin = {}
  for (const g of require('./hexagrams').HEXAGRAMS) byBin[g.binary] = g
  // 5 卦位串
  const steps = [
    { name: r.本卦.name, binary: r.本卦.binary, 位变: '000000' },
    { name: r.之卦.name, binary: r.之卦.binary, 位变: _xor6(r.本卦.binary, r.之卦.binary) },
    { name: r.互卦.name, binary: r.互卦.binary, 位变: _xor6(r.之卦.binary, r.互卦.binary) },
    { name: r.综卦.name, binary: r.综卦.binary, 位变: _xor6(r.互卦.binary, r.综卦.binary) },
    { name: r.错卦.name, binary: r.错卦.binary, 位变: _xor6(r.综卦.binary, r.错卦.binary) },
  ]
  // 动爻轨迹 (本卦动爻 → 之卦的动爻位 = 翻转后的位)
  const yao6 = _binaryToYao6(binary, movingYao)
  const changed = yao6.map((v, i) => (i + 1 === movingYao) ? yy.transformYao(v) : v)
  const zhiYao6 = changed
  // 体用轨迹 (本卦体用 → 之卦体用)
  const upperWx = BAGUA_WUXING[upperNumOf(binary)]
  const lowerWx = BAGUA_WUXING[lowerNumOf(binary)]
  const zhiUpper = BAGUA_WUXING[upperNumOf(r.之卦.binary)]
  const zhiLower = BAGUA_WUXING[lowerNumOf(r.之卦.binary)]
  return {
    ok: true,
    链: steps,
    动爻轨迹: { 本卦动爻: movingYao, 本卦阳爻数: r.阳爻数, 之卦阳爻数: r.之卦 && _countYang(r.之卦.binary) },
    体用轨迹: {
      本卦: { 体: upperWx, 用: lowerWx, 关系: _wuxingRelation(upperWx, lowerWx) },
      之卦: { 体: zhiUpper, 用: zhiLower, 关系: _wuxingRelation(zhiUpper, zhiLower) },
    },
    // 模型「自己推」的确定性输入: 5 位串 + 每步 XOR 量 + 体用生克链
    // 模型读这些 → 推出「往哪走/吉凶/应期」, 不查断语表
    推演提示: '拿 5 卦位串 + 每步 XOR 量 + 体用生克链, 自己推出时序吉凶 (往哪走/何时变/终局)',
  }
}

function _xor6(a, b) {
  return a.split('').map((c, i) => (c === b[i] ? '0' : '1')).join('')
}
function _countYang(b) {
  return b.split('').filter(c => c === '1').length
}

// ============================================================
// 推演校验 (2026-11-24): 模型「自己推」完, 拿它给的 5 位串 / 决策 / 链回传,
// 跟确定性内核对拍 —— 偏了一位 / 读串读错, 当场炸, 不静默放过。
// 这是「盘古拿位串自己推 → 推完我验」的闭环: 位串是确定性输入, 推理是模型的动作,
// 验证是回写对账, 三件事各归各位, 不让模型自证清白。
// ============================================================

/**
 * 校验模型自推结果: 给 6-bit 本卦 + 动爻位 + 模型报的 5 位串/决策, 跟 infer 对拍。
 * @param {string} binary 本卦 6-bit
 * @param {number} movingYao 1-6
 * @param {object} claimed 模型自推结果 {本卦,之卦,互卦,综卦,错卦 (各 binary 或 name), 决策, 阳爻数}
 * @returns {object} { ok, 对上了[], 偏了[], 结论 }
 */
function verifyInference(binary, movingYao, claimed) {
  const r = infer(binary, movingYao);
  if (!r.ok) return { ok: false, error: r.error };
  const c = claimed || {};
  const mismatches = [];
  const matches = [];
  const pairs = [
    ['本卦', r.本卦.binary, c.本卦 && (c.本卦.binary || c.本卦)],
    ['之卦', r.之卦.binary, c.之卦 && (c.之卦.binary || c.之卦)],
    ['互卦', r.互卦.binary, c.互卦 && (c.互卦.binary || c.互卦)],
    ['综卦', r.综卦.binary, c.综卦 && (c.综卦.binary || c.综卦)],
    ['错卦', r.错卦.binary, c.错卦 && (c.错卦.binary || c.错卦)],
  ];
  for (const [label, truth, got] of pairs) {
    if (got == null) continue; // 模型没报这个, 不判错
    const truthName = (label === '本卦' ? r.本卦 : (label === '之卦' ? r.之卦 : (label === '互卦' ? r.互卦 : (label === '综卦' ? r.综卦 : r.错卦)))).name;
    const norm = String(got);
    const hit = norm === truth || norm === truthName;
    if (hit) matches.push(label);
    else mismatches.push({ 位串: label, 内核: truth, 内核名: truthName, 模型报: norm });
  }
  if (c.阳爻数 != null) {
    if (String(c.阳爻数) === String(r.阳爻数)) matches.push('阳爻数');
    else mismatches.push({ 位串: '阳爻数', 内核: r.阳爻数, 模型报: c.阳爻数 });
  }
  if (c.决策 != null) {
    if (String(c.决策).replace(/["「」"]/g, '') === r.决策) matches.push('决策');
    else mismatches.push({ 位串: '决策', 内核: r.决策, 依据: r.决策依据, 模型报: c.决策 });
  }
  return {
    ok: true,
    本卦: r.本卦, 动爻位: movingYao,
    对上了: matches,
    偏了: mismatches,
    结论: mismatches.length === 0
      ? '模型自推与位串内核完全一致 (' + matches.length + ' 项全对)'
      : '模型自推偏 ' + mismatches.length + ' 项: ' + mismatches.map(m => m.位串 + '(' + m.内核 + '→报' + (m.模型报 || '?') + ')').join(' / '),
  };
}

module.exports = { infer, chainInfer, verifyInference, BAGUA_WUXING };
