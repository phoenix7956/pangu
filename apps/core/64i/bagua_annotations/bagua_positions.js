/**
 * Pangu · 64i Layer
 * bagua_annotations/bagua_positions.js
 *
 * 先天八卦 / 后天八卦方位注解
 * 方位：南1东3西7北2东南4东北8西南6西北5中0
 * 先天数：乾一兑二离三震四巽五坎六艮七坤八
 *
 * ⚠️ 2026-10-22 第 42 批: 先天数原来是「乾1兑2离3巽4震5艮6坎7坤8」——
 *   **震/巽 与 坎/艮 两对都错位了**, 而且跟本文件自己的「先天方位」自相矛盾
 *   (震东北、巽西南、艮西北、坎西 —— 按先天圆图走一圈必须是 震4巽5坎6艮7)。
 *   出处: 64i/sources/course_bagua_fundamental.txt
 *     「八卦的顺序是乾一、兑二、离三、震四、巽五、坎六、艮七、坤八。」
 */

'use strict';

// ============================================================
// 先天八卦方位（伏羲八卦方位）
// 口诀：乾南坤北离东坎西兑东南震东北艮西北巽西南
// 先天序：一乾、二兑、三离、四震、五巽、六坎、七艮、八坤
// ============================================================

const XIAN_TIAN_BAGUA = {
  乾: { guaId: 1,  name: '乾', direction: '南', number: 1 },
  兑: { guaId: 58, name: '兑', direction: '东南', number: 2 },
  离: { guaId: 30, name: '离', direction: '东', number: 3 },
  震: { guaId: 51, name: '震', direction: '东北', number: 4 },
  巽: { guaId: 57, name: '巽', direction: '西南', number: 5 },
  坎: { guaId: 29, name: '坎', direction: '西', number: 6 },
  艮: { guaId: 52, name: '艮', direction: '西北', number: 7 },
  坤: { guaId: 2,  name: '坤', direction: '北', number: 8 },
};

const XIAN_TIAN_SEQ = [
  { guaId: 1,  name: '乾', position: 1 },
  { guaId: 58, name: '兑', position: 2 },
  { guaId: 30, name: '离', position: 3 },
  { guaId: 51, name: '震', position: 4 },
  { guaId: 57, name: '巽', position: 5 },
  { guaId: 29, name: '坎', position: 6 },
  { guaId: 52, name: '艮', position: 7 },
  { guaId: 2,  name: '坤', position: 8 },
];

// ============================================================
// 后天八卦方位（文王八卦方位）
// 方位排列：南9离 / 北1坎 / 东3震 / 西7兑
//          东南4巽 / 东北8艮 / 西南6坤 / 西北5乾
// 后天序：一坎、二坤、三震、四巽、五乾、六兑、七艮、八离
// ============================================================

const HOU_TIAN_BAGUA = {
  坎: { guaId: 29, name: '坎', direction: '正北', number: 1 },
  坤: { guaId: 2,  name: '坤', direction: '西南', number: 2 },
  震: { guaId: 51, name: '震', direction: '正东', number: 3 },
  巽: { guaId: 57, name: '巽', direction: '东南', number: 4 },
  乾: { guaId: 1,  name: '乾', direction: '西北', number: 5 },
  兑: { guaId: 58, name: '兑', direction: '正西', number: 6 },
  艮: { guaId: 52, name: '艮', direction: '东北', number: 7 },
  离: { guaId: 30, name: '离', direction: '正南', number: 8 },
};

const HOU_TIAN_SEQ = [
  { guaId: 29, name: '坎', position: 1 },
  { guaId: 2,  name: '坤', position: 2 },
  { guaId: 51, name: '震', position: 3 },
  { guaId: 57, name: '巽', position: 4 },
  { guaId: 1,  name: '乾', position: 5 },
  { guaId: 58, name: '兑', position: 6 },
  { guaId: 52, name: '艮', position: 7 },
  { guaId: 30, name: '离', position: 8 },
];

/**
 * 获取某卦先天八卦方位
 * @param {number} guaId
 * @returns {object|null}
 */
function getXiantian(guaId) {
  const entry = XIAN_TIAN_64[guaId];
  if (!entry) return null;
  return { guaId, name: entry.bagong, position: entry.position, direction: entry.direction, system: '先天' };
}

/**
 * 获取某卦后天八卦方位
 * @param {number} guaId
 * @returns {object|null}
 */
function getHoutian(guaId) {
  const entry = HOU_TIAN_64[guaId];
  if (!entry) return null;
  return { guaId, name: entry.bagong, position: entry.position, direction: entry.direction, system: '后天' };
}

// ============================================================
// 64卦先天八卦方位（伏羲八卦方位）
// 规律：64卦方位由内卦（下卦）决定
// 口诀：乾南1、兑东南2、离东3、震东北4、巽西南5、坎西6、艮西北7、坤北8
// 伏羲序：guaId = 上卦×8 + 下卦（1-indexed）
// trigram index: 乾1、兑2、离3、震4、巽5、坎6、艮7、坤8
// ============================================================
const XIAN_TIAN_64 = {
  // 上卦=1（乾宫），内卦1-8
  1:  { position: 1, direction: '南',    bagong: '乾' },
  2:  { position: 2, direction: '东南',  bagong: '兑' },
  3:  { position: 3, direction: '东',    bagong: '离' },
  4:  { position: 5, direction: '西南',  bagong: '巽' },
  5:  { position: 4, direction: '东北',  bagong: '震' },
  6:  { position: 7, direction: '西北',  bagong: '艮' },
  7:  { position: 6, direction: '西',    bagong: '坎' },
  8:  { position: 8, direction: '北',    bagong: '坤' },
  // 上卦=2（兑宫），内卦1-8
  9:  { position: 1, direction: '南',    bagong: '乾' },
  10: { position: 2, direction: '东南',  bagong: '兑' },
  11: { position: 3, direction: '东',    bagong: '离' },
  12: { position: 5, direction: '西南',  bagong: '巽' },
  13: { position: 4, direction: '东北',  bagong: '震' },
  14: { position: 7, direction: '西北',  bagong: '艮' },
  15: { position: 6, direction: '西',    bagong: '坎' },
  16: { position: 8, direction: '北',    bagong: '坤' },
  // 上卦=3（离宫），内卦1-8
  17: { position: 1, direction: '南',    bagong: '乾' },
  18: { position: 2, direction: '东南',  bagong: '兑' },
  19: { position: 3, direction: '东',    bagong: '离' },
  20: { position: 5, direction: '西南',  bagong: '巽' },
  21: { position: 4, direction: '东北',  bagong: '震' },
  22: { position: 7, direction: '西北',  bagong: '艮' },
  23: { position: 6, direction: '西',    bagong: '坎' },
  24: { position: 8, direction: '北',    bagong: '坤' },
  // 上卦=4（巽宫），内卦1-8
  25: { position: 1, direction: '南',    bagong: '乾' },
  26: { position: 2, direction: '东南',  bagong: '兑' },
  27: { position: 3, direction: '东',    bagong: '离' },
  28: { position: 5, direction: '西南',  bagong: '巽' },
  29: { position: 4, direction: '东北',  bagong: '震' },
  30: { position: 7, direction: '西北',  bagong: '艮' },
  31: { position: 6, direction: '西',    bagong: '坎' },
  32: { position: 8, direction: '北',    bagong: '坤' },
  // 上卦=5（震宫），内卦1-8
  33: { position: 1, direction: '南',    bagong: '乾' },
  34: { position: 2, direction: '东南',  bagong: '兑' },
  35: { position: 3, direction: '东',    bagong: '离' },
  36: { position: 5, direction: '西南',  bagong: '巽' },
  37: { position: 4, direction: '东北',  bagong: '震' },
  38: { position: 7, direction: '西北',  bagong: '艮' },
  39: { position: 6, direction: '西',    bagong: '坎' },
  40: { position: 8, direction: '北',    bagong: '坤' },
  // 上卦=6（艮宫），内卦1-8
  41: { position: 1, direction: '南',    bagong: '乾' },
  42: { position: 2, direction: '东南',  bagong: '兑' },
  43: { position: 3, direction: '东',    bagong: '离' },
  44: { position: 5, direction: '西南',  bagong: '巽' },
  45: { position: 4, direction: '东北',  bagong: '震' },
  46: { position: 7, direction: '西北',  bagong: '艮' },
  47: { position: 6, direction: '西',    bagong: '坎' },
  48: { position: 8, direction: '北',    bagong: '坤' },
  // 上卦=7（坎宫），内卦1-8
  49: { position: 1, direction: '南',    bagong: '乾' },
  50: { position: 2, direction: '东南',  bagong: '兑' },
  51: { position: 3, direction: '东',    bagong: '离' },
  52: { position: 5, direction: '西南',  bagong: '巽' },
  53: { position: 4, direction: '东北',  bagong: '震' },
  54: { position: 7, direction: '西北',  bagong: '艮' },
  55: { position: 6, direction: '西',    bagong: '坎' },
  56: { position: 8, direction: '北',    bagong: '坤' },
  // 上卦=8（坤宫），内卦1-8
  57: { position: 1, direction: '南',    bagong: '乾' },
  58: { position: 2, direction: '东南',  bagong: '兑' },
  59: { position: 3, direction: '东',    bagong: '离' },
  60: { position: 5, direction: '西南',  bagong: '巽' },
  61: { position: 4, direction: '东北',  bagong: '震' },
  62: { position: 7, direction: '西北',  bagong: '艮' },
  63: { position: 6, direction: '西',    bagong: '坎' },
  64: { position: 8, direction: '北',    bagong: '坤' },
};

// ============================================================
// 64卦后天八卦方位（文王八卦方位）
// 八宫方位：坎正北1 / 坤西南2 / 震正东3 / 巽东南4 / 乾西北5 / 兑正西6 / 艮东北7 / 离正南8
// ============================================================
const HOU_TIAN_64 = {
  1: { position: 5, direction: '西北', bagong: '乾' },
  2: { position: 2, direction: '西南', bagong: '坤' },
  3: { position: 1, direction: '正北', bagong: '坎' },
  4: { position: 7, direction: '东北', bagong: '艮' },
  5: { position: 1, direction: '正北', bagong: '坎' },
  6: { position: 5, direction: '西北', bagong: '乾' },
  7: { position: 2, direction: '西南', bagong: '坤' },
  8: { position: 1, direction: '正北', bagong: '坎' },
  9: { position: 4, direction: '东南', bagong: '巽' },
  10: { position: 5, direction: '西北', bagong: '乾' },
  11: { position: 2, direction: '西南', bagong: '坤' },
  12: { position: 5, direction: '西北', bagong: '乾' },
  13: { position: 5, direction: '西北', bagong: '乾' },
  14: { position: 8, direction: '正南', bagong: '离' },
  15: { position: 2, direction: '西南', bagong: '坤' },
  16: { position: 3, direction: '正东', bagong: '震' },
  17: { position: 6, direction: '正西', bagong: '兑' },
  18: { position: 7, direction: '东北', bagong: '艮' },
  19: { position: 2, direction: '西南', bagong: '坤' },
  20: { position: 4, direction: '东南', bagong: '巽' },
  21: { position: 8, direction: '正南', bagong: '离' },
  22: { position: 7, direction: '东北', bagong: '艮' },
  23: { position: 7, direction: '东北', bagong: '艮' },
  24: { position: 2, direction: '西南', bagong: '坤' },
  25: { position: 5, direction: '西北', bagong: '乾' },
  26: { position: 7, direction: '东北', bagong: '艮' },
  27: { position: 7, direction: '东北', bagong: '艮' },
  28: { position: 6, direction: '正西', bagong: '兑' },
  29: { position: 1, direction: '正北', bagong: '坎' },
  30: { position: 8, direction: '正南', bagong: '离' },
  31: { position: 6, direction: '正西', bagong: '兑' },
  32: { position: 3, direction: '正东', bagong: '震' },
  33: { position: 5, direction: '西北', bagong: '乾' },
  34: { position: 3, direction: '正东', bagong: '震' },
  35: { position: 8, direction: '正南', bagong: '离' },
  36: { position: 2, direction: '西南', bagong: '坤' },
  37: { position: 4, direction: '东南', bagong: '巽' },
  38: { position: 8, direction: '正南', bagong: '离' },
  39: { position: 1, direction: '正北', bagong: '坎' },
  40: { position: 3, direction: '正东', bagong: '震' },
  41: { position: 7, direction: '东北', bagong: '艮' },
  42: { position: 4, direction: '东南', bagong: '巽' },
  43: { position: 6, direction: '正西', bagong: '兑' },
  44: { position: 5, direction: '西北', bagong: '乾' },
  45: { position: 6, direction: '正西', bagong: '兑' },
  46: { position: 2, direction: '西南', bagong: '坤' },
  47: { position: 6, direction: '正西', bagong: '兑' },
  48: { position: 1, direction: '正北', bagong: '坎' },
  49: { position: 6, direction: '正西', bagong: '兑' },
  50: { position: 8, direction: '正南', bagong: '离' },
  51: { position: 3, direction: '正东', bagong: '震' },
  52: { position: 7, direction: '东北', bagong: '艮' },
  53: { position: 4, direction: '东南', bagong: '巽' },
  54: { position: 3, direction: '正东', bagong: '震' },
  55: { position: 3, direction: '正东', bagong: '震' },
  56: { position: 8, direction: '正南', bagong: '离' },
  57: { position: 4, direction: '东南', bagong: '巽' },
  58: { position: 6, direction: '正西', bagong: '兑' },
  59: { position: 4, direction: '东南', bagong: '巽' },
  60: { position: 1, direction: '正北', bagong: '坎' },
  61: { position: 4, direction: '东南', bagong: '巽' },
  62: { position: 3, direction: '正东', bagong: '震' },
  63: { position: 1, direction: '正北', bagong: '坎' },
  64: { position: 8, direction: '正南', bagong: '离' },
};

/**
 * 获取某卦先天八卦方位（64卦完整版）
 * @param {number} guaId
 * @returns {object|null}
 */
function getXiantian64(guaId) {
  const entry = XIAN_TIAN_64[guaId];
  if (!entry) return null;
  return { guaId, ...entry, system: '先天' };
}

/**
 * 获取某卦后天八卦方位（64卦完整版）
 * @param {number} guaId
 * @returns {object|null}
 */
function getHoutian64(guaId) {
  const entry = HOU_TIAN_64[guaId];
  if (!entry) return null;
  return { guaId, ...entry, system: '后天' };
}

module.exports = {
  XIAN_TIAN_BAGUA,
  XIAN_TIAN_SEQ,
  HOU_TIAN_BAGUA,
  HOU_TIAN_SEQ,
  XIAN_TIAN_64,
  HOU_TIAN_64,
  getXiantian,
  getHoutian,
  getXiantian64,
  getHoutian64,
};
