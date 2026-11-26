/**
 * Pangu · 64i Layer
 * yao_transform.js - 爻变规则与卦变推演
 *
 * 职责：爻变规则（老阳/老阴/少阳/少阴）、卦变推演
 * 接口规范：compiled/INTERFACE_SPEC.md §2.3
 */

'use strict';

const { YIN, YANG, YAO_VALUES, isMoving, transformYao, yao6ToIndex, yao6ToBinaryString, yao6ToSymbolString } = require('./yin_yang');

// ============================================================
// 爻值速查表
// ============================================================

const L = YAO_VALUES.LAO_YANG;  // 9
const l = YAO_VALUES.LAO_YIN;   // 6
const S = YAO_VALUES.SHAO_YANG; // 7
const s = YAO_VALUES.SHAO_YIN;  // 8

// ============================================================
// 一爻变（独爻之卦）
// ============================================================

/**
 * 生成一爻变的结果卦（6卦）
 * @param {number[]} yao6 - 原始6爻值（6/7/8/9）
 * @returns {Array<{ position: number, original: number, changed: number, hexagramIndex: number, symbol: string }>}
 */
function oneChange(yao6) {
  if (!Array.isArray(yao6) || yao6.length !== 6) {
    throw new Error('yao6 must be array of 6 yao values (6/7/8/9)');
  }
  const results = [];
  for (let i = 0; i < 6; i++) {
    if (isMoving(yao6[i])) {
      const changed = yao6.map((v, idx) => idx === i ? transformYao(v) : v);
      results.push({
        position: i,
        positionName: ['初爻', '二爻', '三爻', '四爻', '五爻', '上爻'][i],
        original: yao6[i],
        changed: changed[i],
        hexagramIndex: yao6ToIndex(changed),
      });
    }
  }
  return results;
}

// ============================================================
// 二爻变（两爻之卦，共15卦）
// ============================================================

/**
 * 生成二爻变的结果卦（15卦）
 * @param {number[]} yao6 - 原始6爻值
 * @returns {Array<{ positions: number[], hexagramIndex: number }>}
 */
function twoChange(yao6) {
  const results = [];
  for (let i = 0; i < 5; i++) {
    if (!isMoving(yao6[i])) continue;
    for (let j = i + 1; j < 6; j++) {
      if (!isMoving(yao6[j])) continue;
      const changed = yao6.map((v, idx) =>
        idx === i || idx === j ? transformYao(v) : v
      );
      results.push({
        positions: [i, j],
        positionNames: ['初爻', '二爻', '三爻', '四爻', '五爻', '上爻'].filter((_, idx) => [i, j].includes(idx)),
        hexagramIndex: yao6ToIndex(changed),
      });
    }
  }
  return results;
}

// ============================================================
// 三爻变（三爻之卦，共20卦）
// ============================================================

/**
 * 生成三爻变的结果卦（20卦）
 * @param {number[]} yao6 - 原始6爻值
 * @returns {Array<{ positions: number[], hexagramIndex: number }>}
 */
function threeChange(yao6) {
  const results = [];
  for (let i = 0; i < 4; i++) {
    if (!isMoving(yao6[i])) continue;
    for (let j = i + 1; j < 5; j++) {
      if (!isMoving(yao6[j])) continue;
      for (let k = j + 1; k < 6; k++) {
        if (!isMoving(yao6[k])) continue;
        const changed = yao6.map((v, idx) =>
          idx === i || idx === j || idx === k ? transformYao(v) : v
        );
        results.push({
          positions: [i, j, k],
          positionNames: ['初爻', '二爻', '三爻', '四爻', '五爻', '上爻'].filter((_, idx) => [i, j, k].includes(idx)),
          hexagramIndex: yao6ToIndex(changed),
        });
      }
    }
  }
  return results;
}

// ============================================================
// 四爻变（之卦，共15卦，等同一爻不变的错卦）
// ============================================================

/**
 * 生成四爻变的结果卦（15卦）
 * @param {number[]} yao6 - 原始6爻值
 * @returns {Array<{ positions: number[], hexagramIndex: number }>}
 */
function fourChange(yao6) {
  // 四爻变 = 二爻不变，等同二爻变，去重
  return twoChange(yao6).filter((r, idx, arr) =>
    arr.findIndex(x => x.hexagramIndex === r.hexagramIndex) === idx
  );
}

// ============================================================
// 五爻变（单爻不变，共6卦）
// ============================================================

/**
 * 生成五爻变的结果卦（6卦）
 * @param {number[]} yao6 - 原始6爻值
 * @returns {Array<{ fixedPosition: number, hexagramIndex: number }>}
 */
function fiveChange(yao6) {
  const results = [];
  for (let i = 0; i < 6; i++) {
    if (isMoving(yao6[i])) continue; // 固定位置必须是静爻（少阳/少阴），动爻才参与变换
    const changed = yao6.map((v, idx) => idx === i ? v : transformYao(v));
    results.push({
      fixedPosition: i,
      hexagramIndex: yao6ToIndex(changed),
    });
  }
  return results;
}

// ============================================================
// 六爻变（之卦为本卦的错卦）
// ============================================================

/**
 * 生成六爻变的结果卦（1卦：错卦）
 * @param {number[]} yao6 - 原始6爻值
 * @returns {{ hexagramIndex: number, relation: '错卦（综卦）' }}
 */
function sixChange(yao6) {
  const changed = yao6.map(v => transformYao(v)); // 全部爻变
  return {
    hexagramIndex: yao6ToIndex(changed),
    relation: '错卦（综卦）',
  };
}

// ============================================================
// 本卦之卦体系（主卦→变卦）
// ============================================================

/**
 * 生成完整的卦变分析
 * @param {number[]} yao6 - 原始6爻值（6/7/8/9）
 * @returns {object} 完整卦变分析
 */
function analyzeHexagramChange(yao6) {
  const originalIndex = yao6ToIndex(yao6);
  const movingPositions = [];
  const fixedPositions = [];

  for (let i = 0; i < 6; i++) {
    if (isMoving(yao6[i])) movingPositions.push(i);
    else fixedPositions.push(i);
  }

  const n = movingPositions.length;
  if (n === 0) {
    return {
      original: yao6,
      originalIndex,
      changeType: '静卦（无动爻）',
      variations: [],
    };
  }

  const variationMap = {
    1: '一爻变',
    2: '二爻变',
    3: '三爻变',
    4: '四爻变',
    5: '五爻变',
    6: '六爻变',
  };

  const changed = yao6.map(v => transformYao(v));
  const changedIndex = yao6ToIndex(changed);

  const oneChangeResults = n >= 1 ? oneChange(yao6) : [];
  const twoChangeResults = n >= 2 ? twoChange(yao6) : [];
  const threeChangeResults = n >= 3 ? threeChange(yao6) : [];
  const fiveChangeResults = n >= 5 ? fiveChange(yao6) : [];
  const sixChangeResult = n === 6 ? sixChange(yao6) : null;

  return {
    original: yao6,
    originalIndex,
    originalBinary: yao6ToBinaryString(yao6),
    originalSymbol: yao6ToSymbolString(yao6),
    changeType: variationMap[n] || '多爻变',
    movingPositions,
    fixedPositions,
    changed: changed,
    changedIndex,
    // 各爻变结果
    oneChange: oneChangeResults,
    twoChange: twoChangeResults,
    threeChange: threeChangeResults,
    fiveChange: fiveChangeResults,
    sixChange: sixChangeResult,
  };
}

// ============================================================
// 爻位易理含义（六爻层次）
// ============================================================

/**
 * 六爻易理层次定义
 * 配合 symbol_table.js 的 YAO_DIMENSIONS
 */
const YAO_DIMENSIONS = {
  0: {
    name: '初爻',
    position: '最下位',
    domain: '根本/根基/底层逻辑',
    keywords: ['本质', '起源', '基础', '启动'],
    market: '最底层资金/根本趋势',
    finance: '资产/负债/净资产',
    timing: '起始点/萌芽期',
  },
  1: {
    name: '二爻',
    position: '下位',
    domain: '基础/条件/内在',
    keywords: ['财务', '估值', '内因'],
    market: '估值/业绩/内生动力',
    finance: '营收/毛利/净利',
    timing: '积累期/筑基',
  },
  2: {
    name: '三爻',
    position: '中位下',
    domain: '执行/行动/外在',
    keywords: ['行情', '执行', '操作'],
    market: '市场走势/量价变化',
    finance: '现金流/运营效率',
    timing: '发展期/行动',
  },
  3: {
    name: '四爻',
    position: '中位上',
    domain: '变化/调整/过渡',
    keywords: ['风控', '调整', '转折'],
    market: '趋势调整/板块轮动',
    finance: '风险/负债/波动',
    timing: '过渡期/转折前',
  },
  4: {
    name: '五爻',
    position: '上位',
    domain: '决策/目标/领导',
    keywords: ['决策', '方向', '战略'],
    market: '政策/方向/市场领导',
    finance: '战略/股东回报/估值中枢',
    timing: '鼎盛期/决策点',
  },
  5: {
    name: '上爻',
    position: '最上位',
    domain: '极变/拐点/结果',
    keywords: ['拐点', '极致', '结果', '终局'],
    market: '极致顶点/趋势终结/新生起点',
    finance: '极端情况/拐点/最终结果',
    timing: '结束/新生/极变点',
  },
};

/**
 * 获取爻位易理维度
 * @param {number} index - 0-5
 * @returns {object}
 */
function getYaoDimension(index) {
  return YAO_DIMENSIONS[index] || null;
}

// ============================================================
// 导出
// ============================================================

// ============================================================
// 互卦 / 综卦 / 错卦 —— 纯位运算 (2026-11-24 老板拍: 64卦二进制化)
//
// binary 约定 (hexagrams.js 文件头): 下卦码(左3)‖上卦码(右3), 爻序初→上自下而上。
// 八卦码: 乾111 兑110 离101 震100 巽011 坎010 艮001 坤000。
//   互卦 = 本卦 2-5 爻组成: 下互=位1,2,3 (binary[1:4]) 上互=位2,3,4 (binary[2:5])
//   综卦 = 反转全部 6 位 (本卦倒过来, 即上下卦互换+各爻逆序)
//   错卦 = 取反全部 6 位 (XOR 0b111111)
// 验证 (传统互卦对, 64/64 对拍): 否互=渐 ✓ 泰互=归妹 ✓ 屯综=蒙 ✓ 否错=泰 ✓
// ============================================================

const _BYBIN = {};
for (const g of require('./hexagrams').HEXAGRAMS) _BYBIN[g.binary] = g;

/**
 * 互卦: 取本卦 2-5 爻组成新卦 (下互=位1,2,3 上互=位2,3,4)
 * @param {object} gua - hexagrams.js 里的一卦 (含 .binary)
 * @returns {object} 互卦对象 (含 .binary/.name/.id)
 */
function mutualGua(gua) {
  const b = gua.binary;
  const low = b.slice(1, 4);
  const up = b.slice(2, 5);
  return _BYBIN[low + up];
}

/**
 * 综卦: 反转本卦全部 6 位 (上下颠倒)
 * @param {object} gua
 * @returns {object} 综卦对象
 */
function converseGua(gua) {
  const b = gua.binary;
  const rev = b.split('').reverse().join('');
  return _BYBIN[rev];
}

/**
 * 错卦: 取反本卦全部 6 位 (阴阳全翻)
 * @param {object} gua
 * @returns {object} 错卦对象
 */
function opposedGua(gua) {
  const b = gua.binary;
  const not = b.split('').map(c => c === '1' ? '0' : '1').join('');
  return _BYBIN[not];
}

/**
 * 64 卦全量位运算表: 每卦 → {互, 综, 错}
 * 一次性算好, 零幻觉, 跟查表同构。
 * @returns {object} key=卦名, value={互卦名, 综卦名, 错卦名}
 */
function buildGuaTransformTable() {
  const out = {};
  for (const g of require('./hexagrams').HEXAGRAMS) {
    out[g.name] = {
      binary: g.binary,
      id: g.id,
      互卦: mutualGua(g).name,
      综卦: converseGua(g).name,
      错卦: opposedGua(g).name,
    };
  }
  return out;
}

module.exports = {
  // 爻变分析
  oneChange,
  twoChange,
  threeChange,
  fourChange,
  fiveChange,
  sixChange,
  analyzeHexagramChange,

  // 互/综/错 位运算 (2026-11-24)
  mutualGua,
  converseGua,
  opposedGua,
  buildGuaTransformTable,

  // 爻位维度
  YAO_DIMENSIONS,
  getYaoDimension,
};
