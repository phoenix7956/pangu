/**
 * Pangu · 64i Layer
 * bagua_annotations/wuxing_map.js
 *
 * 64卦五行归类注解 - 2026-06-20 W4-A.3 老板拍板: 统一用周文王序
 *
 * 每个卦对应：wuxing / element / polarity / bagong
 *
 * ⚠️ 五行由上卦（外卦）决定 —— 这是**上卦口径**, 不是京房。
 *   (2026-10-22 改掉过度声称: 原注释写「（京房纳甲体系）」—— 京房纳甲是**干支**那一套,
 *    跟「卦的五行由上卦决定」没有同一个出处; 京房体系里卦的五行是**宫五行**,
 *    而宫五行跟本文件的五行在 **32/64** 卦上不一致 —— 蒙卦这里说土(上卦艮),
 *    京房说火(离宫四世); 讼卦这里说金(上卦乾), 京房说火(离宫游魂)。)
 *
 *   这里的 `bagong` 字段同理: = **上卦所属纯卦(上卦分组)**, 不是京房八宫的宫。
 *   京房宫用 `jingfang_bagong.getJingfangGong(guaId)`。
 *
 * 五行由上卦（外卦）决定：
 *   乾☰/兑☱ → 金、离☲ → 火、震☳/巽☴ → 木、坎☵ → 水、艮☶/坤☷ → 土
 * 阴阳由上卦决定：乾☰/震☳/坎☵/艮☶ → 阳，坤☷/兑☱/离☲/巽☴ → 阴
 *
 * 周文王序（King Wen sequence）= 《易经》原文卦序：
 *   1=乾, 2=坤, 3=屯, 4=蒙, ..., 64=未济
 *   64 卦 = 32 对「非覆即变」（相邻奇偶对，讲一个故事）
 *
 * 选周文王序的理由（老板 6/20 拍板）：
 *   - 64 卦 = 32 对变卦结构（编程判断的核心）
 *   - 爻辞直接对齐（hexagrams.js 已是周文王序）
 *   - 几千年传统易学解读都建在这上面
 *   - 初→上叙事顺序自然
 */

'use strict';

// ============================================================
// 五行归类（基于上卦五行 / 京房纳甲 / 周文王序）
// guaId = 周文王序 1-64
// ============================================================

const WUXING_MAP = {
   1: { wuxing: '金', element: '金', polarity: '阳', bagong: '乾' },  // 乾 ☰☰
   2: { wuxing: '土', element: '土', polarity: '阴', bagong: '坤' },  // 坤 ☷☷
   3: { wuxing: '水', element: '水', polarity: '阳', bagong: '坎' },  // 屯 ☵☳
   4: { wuxing: '土', element: '土', polarity: '阳', bagong: '艮' },  // 蒙 ☶☵
   5: { wuxing: '水', element: '水', polarity: '阳', bagong: '坎' },  // 需 ☵☰
   6: { wuxing: '金', element: '金', polarity: '阳', bagong: '乾' },  // 讼 ☰☵
   7: { wuxing: '土', element: '土', polarity: '阴', bagong: '坤' },  // 师 ☷☵
   8: { wuxing: '水', element: '水', polarity: '阳', bagong: '坎' },  // 比 ☵☷
   9: { wuxing: '木', element: '木', polarity: '阴', bagong: '巽' },  // 小畜 ☴☰
  10: { wuxing: '金', element: '金', polarity: '阳', bagong: '乾' },  // 履 ☰☱
  11: { wuxing: '土', element: '土', polarity: '阴', bagong: '坤' },  // 泰 ☷☰
  12: { wuxing: '金', element: '金', polarity: '阳', bagong: '乾' },  // 否 ☰☷
  13: { wuxing: '金', element: '金', polarity: '阳', bagong: '乾' },  // 同人 ☰☲
  14: { wuxing: '火', element: '火', polarity: '阴', bagong: '离' },  // 大有 ☲☰
  15: { wuxing: '土', element: '土', polarity: '阴', bagong: '坤' },  // 谦 ☷☶
  16: { wuxing: '木', element: '木', polarity: '阳', bagong: '震' },  // 豫 ☳☷
  17: { wuxing: '金', element: '金', polarity: '阴', bagong: '兑' },  // 随 ☱☳
  18: { wuxing: '土', element: '土', polarity: '阳', bagong: '艮' },  // 蛊 ☶☴
  19: { wuxing: '土', element: '土', polarity: '阴', bagong: '坤' },  // 临 ☷☱
  20: { wuxing: '木', element: '木', polarity: '阴', bagong: '巽' },  // 观 ☴☷
  21: { wuxing: '火', element: '火', polarity: '阴', bagong: '离' },  // 噬嗑 ☲☳
  22: { wuxing: '土', element: '土', polarity: '阳', bagong: '艮' },  // 贲 ☶☲
  23: { wuxing: '土', element: '土', polarity: '阳', bagong: '艮' },  // 剥 ☶☷
  24: { wuxing: '土', element: '土', polarity: '阴', bagong: '坤' },  // 复 ☷☳
  25: { wuxing: '金', element: '金', polarity: '阳', bagong: '乾' },  // 无妄 ☰☳
  26: { wuxing: '土', element: '土', polarity: '阳', bagong: '艮' },  // 大畜 ☶☰
  27: { wuxing: '土', element: '土', polarity: '阳', bagong: '艮' },  // 颐 ☶☳
  28: { wuxing: '金', element: '金', polarity: '阴', bagong: '兑' },  // 大过 ☱☴
  29: { wuxing: '水', element: '水', polarity: '阳', bagong: '坎' },  // 坎 ☵☵
  30: { wuxing: '火', element: '火', polarity: '阴', bagong: '离' },  // 离 ☲☲
  31: { wuxing: '金', element: '金', polarity: '阴', bagong: '兑' },  // 咸 ☱☶
  32: { wuxing: '木', element: '木', polarity: '阳', bagong: '震' },  // 恒 ☳☴
  33: { wuxing: '金', element: '金', polarity: '阳', bagong: '乾' },  // 遁 ☰☶
  34: { wuxing: '木', element: '木', polarity: '阳', bagong: '震' },  // 大壮 ☳☰
  35: { wuxing: '火', element: '火', polarity: '阴', bagong: '离' },  // 晋 ☲☷
  36: { wuxing: '土', element: '土', polarity: '阴', bagong: '坤' },  // 明夷 ☷☲
  37: { wuxing: '木', element: '木', polarity: '阴', bagong: '巽' },  // 家人 ☴☲
  38: { wuxing: '火', element: '火', polarity: '阴', bagong: '离' },  // 睽 ☲☱
  39: { wuxing: '水', element: '水', polarity: '阳', bagong: '坎' },  // 蹇 ☵☶
  40: { wuxing: '木', element: '木', polarity: '阳', bagong: '震' },  // 解 ☳☵
  41: { wuxing: '土', element: '土', polarity: '阳', bagong: '艮' },  // 损 ☶☱
  42: { wuxing: '木', element: '木', polarity: '阴', bagong: '巽' },  // 益 ☴☳
  43: { wuxing: '金', element: '金', polarity: '阴', bagong: '兑' },  // 夬 ☱☰
  44: { wuxing: '金', element: '金', polarity: '阳', bagong: '乾' },  // 姤 ☰☴
  45: { wuxing: '金', element: '金', polarity: '阴', bagong: '兑' },  // 萃 ☱☷
  46: { wuxing: '土', element: '土', polarity: '阴', bagong: '坤' },  // 升 ☷☴
  47: { wuxing: '金', element: '金', polarity: '阴', bagong: '兑' },  // 困 ☱☵
  48: { wuxing: '水', element: '水', polarity: '阳', bagong: '坎' },  // 井 ☵☴
  49: { wuxing: '金', element: '金', polarity: '阴', bagong: '兑' },  // 革 ☱☲
  50: { wuxing: '火', element: '火', polarity: '阴', bagong: '离' },  // 鼎 ☲☴
  51: { wuxing: '木', element: '木', polarity: '阳', bagong: '震' },  // 震 ☳☳
  52: { wuxing: '土', element: '土', polarity: '阳', bagong: '艮' },  // 艮 ☶☶
  53: { wuxing: '木', element: '木', polarity: '阴', bagong: '巽' },  // 渐 ☴☶
  54: { wuxing: '木', element: '木', polarity: '阳', bagong: '震' },  // 归妹 ☳☱
  55: { wuxing: '木', element: '木', polarity: '阳', bagong: '震' },  // 丰 ☳☲
  56: { wuxing: '火', element: '火', polarity: '阴', bagong: '离' },  // 旅 ☲☶
  57: { wuxing: '木', element: '木', polarity: '阴', bagong: '巽' },  // 巽 ☴☴
  58: { wuxing: '金', element: '金', polarity: '阴', bagong: '兑' },  // 兑 ☱☱
  59: { wuxing: '木', element: '木', polarity: '阴', bagong: '巽' },  // 涣 ☴☵
  60: { wuxing: '水', element: '水', polarity: '阳', bagong: '坎' },  // 节 ☵☱
  61: { wuxing: '木', element: '木', polarity: '阴', bagong: '巽' },  // 中孚 ☴☱
  62: { wuxing: '木', element: '木', polarity: '阳', bagong: '震' },  // 小过 ☳☶
  63: { wuxing: '水', element: '水', polarity: '阳', bagong: '坎' },  // 既济 ☵☲
  64: { wuxing: '火', element: '火', polarity: '阴', bagong: '离' },  // 未济 ☲☵
};

// ============================================================
// 五行生克关系
// ============================================================

const SHENG = { 木: '火', 火: '土', 土: '金', 金: '水', 水: '木' };
const KE = { 木: '土', 土: '水', 水: '火', 火: '金', 金: '木' };

/**
 * 获取卦五行注解
 * @param {number} guaId - 卦序号（1-64，伏羲序）
 * @returns {object}
 */
function getWuxing(guaId) {
  return WUXING_MAP[guaId] || { wuxing: '土', element: '土', polarity: '中', bagong: '未知' };
}

/**
 * 获取两行之间的生克关系
 * @param {string} w1 - 被生者（五行）
 * @param {string} w2 - 生者（五行）
 * @returns {string} '相生' | '相克' | '同'
 */
function getRelation(w1, w2) {
  if (w1 === w2) return '同';
  if (SHENG[w1] === w2) return '相生';
  if (KE[w1] === w2) return '相克';
  return '无关系';
}

/**
 * 获取两卦之间的五行关系
 * @param {number} guaId1
 * @param {number} guaId2
 * @returns {string}
 */
function getRelationBetween(guaId1, guaId2) {
  const w1 = getWuxing(guaId1).wuxing;
  const w2 = getWuxing(guaId2).wuxing;
  return getRelation(w1, w2);
}

module.exports = { WUXING_MAP, getWuxing, getRelation, getRelationBetween };
