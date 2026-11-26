/**
 * Pangu · 64i Layer
 * yao_models.js - 三百八十四爻完整数据
 *
 * 数据来源：桌面《周易六十四卦 三百八十四爻 完整版》
 * 职责：64卦 × 6爻 = 384爻爻辞 + 二进制卦码 + 卦象方位
 */

'use strict';

// 数据源：从 hexagrams.js 获取64卦完整数据
const { HEXAGRAMS } = require('./hexagrams');
const YAOSOURCE = HEXAGRAMS;

// ============================================================
// 爻位定义
// ============================================================

const YAO_POSITIONS = ['初九', '九二', '九三', '九四', '九五', '上九'];
const YAO_NAMES = { 1: '初九', 2: '九二', 3: '九三', 4: '九四', 5: '九五', 6: '上九' };

// ============================================================
// 二进制卦码 → 卦数据 映射
// ============================================================

const HEXAGON_MAP = YAOSOURCE.reduce((acc, h) => { acc[h.id] = h; return acc; }, {});

// ============================================================
// API
// ============================================================

/**
 * 获取某卦的完整爻辞
 * @param {number} guaId - 卦ID (1-64)
 * @returns {string[]} 6爻爻辞数组
 */
function getYao(guaId) {
  const h = HEXAGON_MAP[guaId];
  return h ? (h.yao_ci || h.yao) : null;
}

/**
 * 获取某卦特定爻的爻辞
 * @param {number} guaId - 卦ID (1-64)
 * @param {number} position - 爻位 (1-6, 1=初九)
 * @returns {string|null}
 */
function getYaoByPosition(guaId, position) {
  const yao = getYao(guaId);
  if (!yao || position < 1 || position > 6) return null;
  return yao[position - 1];
}

/**
 * 获取某卦的二进制卦码
 * @param {number} guaId
 * @returns {string|null}
 */
function getBinary(guaId) {
  const h = HEXAGON_MAP[guaId];
  return h ? h.binary : null;
}

/**
 * 根据二进制卦码找卦ID
 * @param {string} binary - 6位二进制如 "111111"
 * @returns {number|null}
 */
function getGuaIdByBinary(binary) {
  const entry = Object.values(HEXAGON_MAP).find(h => h.binary === binary);
  return entry ? entry.id : null;
}

/**
 * 获取某卦的卦辞
 * @param {number} guaId
 * @returns {string|null}
 */
function getGuaCi(guaId) {
  const h = HEXAGON_MAP[guaId];
  return h ? h.gua_ci : null;
}

/**
 * 获取某卦的大象辞(象曰)
 *
 * 2026-10-23 第 70 批新增。大象辞 = 卦的整体取象("天行健, 君子以自强不息"),
 * 是卦辞/爻辞之外的第三层原文。以前 hexagrams.js 的 xiang 字段是空的,
 * 这一层就一直缺着 —— 模型讲卦只能讲卦辞+爻辞, 少了「整体取象」那一层。
 *
 * 取不到就返回 null, 不返回空串 —— 调用方要能区分「这卦没大象辞」和「没取到」。
 *
 * @param {number} guaId
 * @returns {string|null}
 */
function getGuaXiang(guaId) {
  const h = HEXAGON_MAP[guaId];
  return h && h.xiang ? h.xiang : null;
}

/**
 * 变爻：翻转某一位二进制位后的卦ID
 * @param {number} guaId - 原卦ID
 * @param {number} position - 动爻位置 (1-6)
 * @returns {number|null} 变后卦ID
 */
function getChangedGuaId(guaId, position) {
  const h = HEXAGON_MAP[guaId];
  if (!h) return null;
  const bits = h.binary.split('');
  const idx = position - 1; // 0-based: 1=初九(LSD) ... 6=上九(MSD)
  bits[idx] = bits[idx] === '0' ? '1' : '0';
  return getGuaIdByBinary(bits.join(''));
}

/**
 * 获取完整的64卦爻数据
 * @returns {object[]} 64条，每条含 id, name, symbol, upDown, binary, guaCi, yao[]
 */
function getAllYaoData() {
  return YAOSOURCE.map(h => ({
    id: h.id,
    name: h.name,
    symbol: h.symbol,
    upDown: h.upDown,
    binary: h.binary,
    guaCi: h.guaCi,
    yao: h.yao,
  }));
}

module.exports = {
  YAO_POSITIONS,
  YAO_NAMES,
  getYao,
  getYaoByPosition,
  getBinary,
  getGuaIdByBinary,
  getGuaCi,
  getGuaXiang,
  getChangedGuaId,
  getAllYaoData,
};
