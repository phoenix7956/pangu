/**
 * Pangu · 64i Layer
 * yin_yang.js - 阴阳爻基础定义与运算
 *
 * 职责：阴阳爻的定义、二进制表示、运算规则
 * 接口规范：compiled/INTERFACE_SPEC.md §2.1
 *
 * 简化模型（Pangu 8 维向量）：
 *   - 第 1 维 yin_yang  : 二元对错 0/1（YIN=0, YANG=1）
 *   - 第 2 维 movement  : 独立 flag，静/动（static/dynamic）
 *                         老阳(9)/老阴(6) = dynamic，少阳(7)/少阴(8) = static
 *   - 两维独立：yin_yang 看阴阳，movement 单独表达动爻状态
 */

'use strict';

// ============================================================
// 常量定义
// ============================================================

/** 阴爻 */
const YIN = 0;

/** 阳爻 */
const YANG = 1;

/** 阴爻符号 */
const YIN_SYMBOL = '⚋';

/** 阳爻符号 */
const YANG_SYMBOL = '⚊';

/** 爻值常量 */
const YAO_VALUES = {
  /** 老阳（动）*/
  LAO_YANG: 9,
  /** 老阴（动）*/
  LAO_YIN: 6,
  /** 少阳（静）*/
  SHAO_YANG: 7,
  /** 少阴（静）*/
  SHAO_YIN: 8,
};

/** 爻类型名称 */
const YAO_TYPE_NAMES = {
  9: 'LAO_YANG',
  6: 'LAO_YIN',
  7: 'SHAO_YANG',
  8: 'SHAO_YIN',
};

/**
 * 动爻状态枚举（Pangu 8 维向量 · 第 2 维 movement）
 * - STATIC  (静) : 少阳(7) / 少阴(8)，不变化
 * - DYNAMIC (动) : 老阳(9) / 老阴(6)，会变化
 */
const MOVEMENT_TYPES = {
  STATIC: 'static',
  DYNAMIC: 'dynamic',
};

// ============================================================
// 基础转换
// ============================================================

/**
 * 将任意形式转换为二进制值（0=阴，1=阳）
 * @param {string|number} yao - 输入值（'YIN'/'YANG'/0/1/'⚋'/'⚊'）
 * @returns {number} 0 或 1
 */
function yaoToBinary(yao) {
  // 0/1 直接返回
  if (yao === YIN || yao === 0) return YIN;
  if (yao === YANG || yao === 1) return YANG;
  // 6/7/8/9 爻值直接返回对应阴阳
  if (yao === YAO_VALUES.LAO_YANG || yao === 9) return YANG;
  if (yao === YAO_VALUES.LAO_YIN || yao === 6) return YIN;
  if (yao === YAO_VALUES.SHAO_YANG || yao === 7) return YANG;
  if (yao === YAO_VALUES.SHAO_YIN || yao === 8) return YIN;
  // 字符串形式
  if (yao === 'YIN' || yao === '⚋') return YIN;
  if (yao === 'YANG' || yao === '⚊') return YANG;
  throw new Error(`Invalid yao value: ${yao}`);
}

/**
 * 二进制值转为爻名称
 * @param {number} b - 0 或 1
 * @returns {'YIN'|'YANG'}
 */
function binaryToYao(b) {
  return b === YIN ? 'YIN' : 'YANG';
}

/**
 * 爻值转为符号
 * @param {string|number} yao
 * @returns {'⚋'|'⚊'}
 */
function yaoToSymbol(yao) {
  const b = yaoToBinary(yao);
  return b === YIN ? YIN_SYMBOL : YANG_SYMBOL;
}

/**
 * 检验是否为有效爻值
 * @param {*} v
 * @returns {boolean}
 */
function isValidYao(v) {
  if (v === YIN || v === YANG || v === 'YIN' || v === 'YANG' || v === '⚋' || v === '⚊') return true;
  if (typeof v === 'number' && (v === 0 || v === 1)) return true;
  return false;
}

/**
 * 获取阴阳相对应（相变）
 * @param {string|number} yao
 * @returns {YIN|YANG} 相反的爻
 */
function getOpposite(yao) {
  const b = yaoToBinary(yao);
  return b === YIN ? YANG : YIN;
}

// ============================================================
// 爻类型判断
// ============================================================

/**
 * 获取爻值类型
 * @param {number} yaoValue - 6/7/8/9
 * @returns {'LAO_YANG'|'LAO_YIN'|'SHAO_YANG'|'SHAO_YIN'}
 */
function getYaoType(yaoValue) {
  return YAO_TYPE_NAMES[yaoValue] || null;
}

/**
 * 判断是否为动爻（老阳或老阴）
 * @param {number} yaoValue - 6/7/8/9
 * @returns {boolean}
 */
function isMoving(yaoValue) {
  return yaoValue === YAO_VALUES.LAO_YANG || yaoValue === YAO_VALUES.LAO_YIN;
}

/**
 * 获取爻的动静状态（Pangu 8 维向量 · 第 2 维 movement）
 * @param {number} yaoValue - 6/7/8/9
 * @returns {'static'|'dynamic'} 少阳/少阴='static'，老阳/老阴='dynamic'
 */
function getMovement(yaoValue) {
  return isMoving(yaoValue) ? MOVEMENT_TYPES.DYNAMIC : MOVEMENT_TYPES.STATIC;
}

/**
 * 爻值转 movement flag 位（Pangu 8 维向量辅助）
 * @param {number} yaoValue - 6/7/8/9
 * @returns {0|1} 静=0，动=1
 */
function yaoToMovementBit(yaoValue) {
  return isMoving(yaoValue) ? 1 : 0;
}

// ============================================================
// 六爻构建与卦生成
// ============================================================

/**
 * 6爻数组转二进制字符串（从上爻到初爻，方便索引）
 * @param {number[]} yao6 - [初爻, 二爻, 三爻, 四爻, 五爻, 上爻]
 * @returns {string} 二进制串，如 '111111'
 */
function yao6ToBinaryString(yao6) {
  if (!Array.isArray(yao6) || yao6.length !== 6) {
    throw new Error('yao6 must be an array of 6 elements');
  }
  return yao6.map(b => yaoToBinary(b)).join('');
}

/**
 * 6爻数组转卦象符号串
 * @param {number[]} yao6 - [初爻, 二爻, 三爻, 四爻, 五爻, 上爻]
 * @returns {string} 如 '☰☰☰☰☰☰'
 */
function yao6ToSymbolString(yao6) {
  if (!Array.isArray(yao6) || yao6.length !== 6) {
    throw new Error('yao6 must be an array of 6 elements');
  }
  return yao6.map(v => yaoToSymbol(v)).join('');
}

/**
 * 爻变后得到新爻值（老阳→少阴，老阴→少阳，少阳少阴不变）
 * @param {number} yaoValue - 6/7/8/9
 * @returns {number} 变换后的值
 */
function transformYao(yaoValue) {
  if (yaoValue === YAO_VALUES.LAO_YANG) return YAO_VALUES.SHAO_YIN;
  if (yaoValue === YAO_VALUES.LAO_YIN) return YAO_VALUES.SHAO_YANG;
  return yaoValue; // 少阳少阴不变
}

/**
 * 6爻数组计算卦的二进制索引（0-63）
 * 下卦（下卦三位）+ 上卦（上卦三位）× 8
 * @param {number[]} yao6 - [初爻, 二爻, 三爻, 四爻, 五爻, 上爻]
 * @returns {number} 0-63 的卦索引
 */
function yao6ToIndex(yao6) {
  if (!Array.isArray(yao6) || yao6.length !== 6) {
    throw new Error('yao6 must be an array of 6 elements');
  }
  // yao6 = [初爻, 二爻, 三爻, 四爻, 五爻, 上爻]
  // 初爻在位置0，最上位在位置5
  let lower = 0, upper = 0;
  for (let i = 0; i < 3; i++) {
    lower = (lower << 1) | yaoToBinary(yao6[i]);
  }
  for (let i = 3; i < 6; i++) {
    upper = (upper << 1) | yaoToBinary(yao6[i]);
  }
  return upper * 8 + lower;
}

/**
 * 二进制索引转6爻数组
 * @param {number} index - 0-63
 * @returns {number[]} [初爻, 二爻, 三爻, 四爻, 五爻, 上爻]（二进制值 0/1）
 */
function indexToYao6(index) {
  if (index < 0 || index > 63 || !Number.isInteger(index)) {
    throw new Error('index must be integer 0-63');
  }
  const upper = Math.floor(index / 8);
  const lower = index % 8;
  const yao6 = [];
  for (let i = 2; i >= 0; i--) {
    yao6.push((lower >> i) & 1);
  }
  for (let i = 2; i >= 0; i--) {
    yao6.push((upper >> i) & 1);
  }
  return yao6;
}

// ============================================================
// 爻位置名称
// ============================================================

/** 六爻位置名称 */
const YAO_POSITION_NAMES = ['初爻', '二爻', '三爻', '四爻', '五爻', '上爻'];

/**
 * 获取爻位置名称
 * @param {number} index - 0-5
 * @returns {string}
 */
function getYaoPositionName(index) {
  return YAO_POSITION_NAMES[index] || null;
}

// ============================================================
// 动卦（本卦→之卦）
// ============================================================

/**
 * 生成动卦结果
 * @param {number[]} yao6 - 原卦6爻值（6/7/8/9）
 * @returns {{ original: number[], originalIndex: number, moving: number[], changed: number[], changedIndex: number }}
 */
function buildTransformedHexagram(yao6) {
  const moving = [];
  const changed = [];
  const original = [];

  for (let i = 0; i < 6; i++) {
    original.push(yao6[i]);
    changed.push(transformYao(yao6[i]));
    if (isMoving(yao6[i])) {
      moving.push(i);
    }
  }

  return {
    original: original,
    originalIndex: yao6ToIndex(original),
    moving: moving, // 动爻位置索引
    changed: changed,
    changedIndex: yao6ToIndex(changed),
  };
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  // 常量
  YIN,
  YANG,
  YIN_SYMBOL,
  YANG_SYMBOL,
  YAO_VALUES,
  YAO_TYPE_NAMES,
  MOVEMENT_TYPES,
  YAO_POSITION_NAMES,

  // 基础转换
  yaoToBinary,
  binaryToYao,
  yaoToSymbol,
  isValidYao,
  getOpposite,

  // 爻类型
  getYaoType,
  isMoving,
  getMovement,
  yaoToMovementBit,
  transformYao,

  // 六爻工具
  yao6ToBinaryString,
  yao6ToSymbolString,
  yao6ToIndex,
  indexToYao6,

  // 位置
  getYaoPositionName,

  // 动卦
  buildTransformedHexagram,
};
