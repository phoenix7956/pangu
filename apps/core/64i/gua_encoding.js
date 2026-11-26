/**
 * Pangu · 64i Layer
 * gua_encoding.js - 万物→64态 编码规则 (2026-11-24 老板拍: 64卦384爻推演万物)
 *
 * 职责: 把现实问题 (事件/人物/时间/方位/物品) 编码成 64 态 (6-bit 卦码)。
 * 这是「推演万物」的**入口** — 没有编码, 位运算内核就是空转。
 *
 * 编码规则 (全网共识 + 梅花易数 数字卦 法):
 *   ① 时间起卦: 年支+月+日 = 上卦, 加时辰 = 下卦, 总数%6 = 动爻
 *   ② 数字卦: 报 2~3 个数, 第1%8=上卦, 第2%8=下卦, 第3%6=动爻 (或 1+2+时支%6)
 *   ③ 物象卦: 取物之象 (天=乾 地=坤 雷=震 风=巽 水=坎 火=离 山=艮 泽=兑)
 *   ④ 方位卦: 先天 (乾南/坤北/震东北/巽西南/坎西/离东/艮西北/兑东南)
 *              后天 (乾西北/坤西南/震东/巽东南/坎北/离南/艮东北/兑西)
 *
 * 输出: { upper: 1-8, lower: 1-8, moving: 1-6, binary: 'xxx xxx', guaId, guaName }
 * 纯确定性, 零幻觉, 跟查表同构 (不 LLM 推演)。
 *
 * ⚠️ 八卦序 (1-8) 跟 hexagrams.js 的 binary 约定对齐:
 *   乾1 兑2 离3 震4 巽5 坎6 艮7 坤8 (先天序)
 *   binary 下卦码在左3位, 上卦码在右3位 (yao6ToIndex 约定)
 *   八卦码: 乾111 兑110 离101 震100 巽011 坎010 艮001 坤000
 */
'use strict';

// 八卦码 (1-8 → 3-bit, 初爻在右/最低位)
// 先天序: 乾1 兑2 离3 震4 巽5 坎6 艮7 坤8
const BAGUA_CODE = {
  1: '111', // 乾
  2: '110', // 兑
  3: '101', // 离
  4: '100', // 震
  5: '011', // 巽
  6: '010', // 坎
  7: '001', // 艮
  8: '000', // 坤
};

// 八卦码 → 卦 id (从 hexagrams.js 反查 binary)
const CODE_TO_ID = {};
for (const g of require('./hexagrams').HEXAGRAMS) {
  // binary = 下卦码‖上卦码, 但单卦码需要按 上=111 下=000 这种纯卦反查
  // 直接用 8 纯卦的 binary 反查
}

// 8 纯卦 binary (下卦码‖上卦码, 纯卦上下相同)
const PURE_GUA_BINARY = {
  1: '111' + '111', // 乾
  2: '110' + '110', // 兑
  3: '101' + '101', // 离
  4: '100' + '100', // 震
  5: '011' + '011', // 巽
  6: '010' + '010', // 坎
  7: '001' + '001', // 艮
  8: '000' + '000', // 坤
};
// 反查 binary → id
const hexagrams = require('./hexagrams');
const BY_BINARY = {};
for (const g of hexagrams.HEXAGRAMS) BY_BINARY[g.binary] = g;

/**
 * 上下卦码 → 64卦 binary + id + 名
 * @param {number} upper 1-8 (上卦先天序)
 * @param {number} lower 1-8 (下卦先天序)
 * @returns {binary: string, id: number, name: string, full: string}
 */
function toHexagram(upper, lower) {
  const uCode = BAGUA_CODE[upper];
  const lCode = BAGUA_CODE[lower];
  if (!uCode || !lCode) return null;
  // binary = 下卦码(左3)‖上卦码(右3)
  const binary = lCode + uCode;
  const gua = BY_BINARY[binary];
  if (!gua) return null;
  return {
    binary: binary,
    id: gua.id,
    name: gua.name,
    symbol: gua.symbol,
    gua_ci: gua.gua_ci || '',
    upper: upper,
    lower: lower,
    upper_name: hexagrams.xiangNameOf ? undefined : undefined,
  };
}

/**
 * ① 时间起卦: 年支+月+日 = 上卦, 加时辰 = 下卦, 总数%6 = 动爻
 * @param {{yearZhi: number, month: number, day: number, hourZhi: number}} t
 *   yearZhi 1-12 (子=1丑=2寅=3...亥=12), month 1-12 (农历月), day 1-30, hourZhi 1-12
 */
function castByTime(t) {
  const { yearZhi, month, day, hourZhi } = t;
  if (!yearZhi || !month || !day || !hourZhi) return null;
  const upper = ((yearZhi + month + day) % 8) || 8;
  const lower = ((yearZhi + month + day + hourZhi) % 8) || 8;
  const total = yearZhi + month + day + hourZhi;
  const moving = (total % 6) || 6;
  const hexa = toHexagram(upper, lower);
  return hexa ? { ...hexa, method: '时间起卦', moving, moving_name: _movingName(moving) } : null;
}

/**
 * ② 数字卦: 报 2~3 个数, 第1%8=上卦, 第2%8=下卦, 第3%6=动爻 (或 1+2+时支%6)
 * @param {number[]} nums - [a, b, c?]
 * @param {number} [hourZhi] - 无第三数时用时支兜底
 */
function castByNumbers(nums, hourZhi) {
  if (!Array.isArray(nums) || nums.length < 2) return null;
  const a = Number(nums[0]);
  const b = Number(nums[1]);
  const c = nums.length >= 3 ? Number(nums[2]) : null;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  const upper = ((a % 8) || 8);
  const lower = ((b % 8) || 8);
  const moving = c != null && Number.isFinite(c) && c > 0
    ? ((c % 6) || 6)
    : (((a + b + (hourZhi || 0)) % 6) || 6);
  const hexa = toHexagram(upper, lower);
  return hexa ? { ...hexa, method: '数字卦', moving, moving_name: _movingName(moving) } : null;
}

/**
 * ③ 物象卦: 取物之象 (天=1 地=8 雷=4 风=5 水=6 火=3 山=7 泽=2)
 * @param {string} obj - 物象名 (天/地/雷/风/水/火/山/泽) 或 八卦名
 */
function castByObject(obj) {
  const OBJ_MAP = {
    '天': 1, '乾': 1, '地': 8, '坤': 8, '雷': 4, '震': 4,
    '风': 5, '巽': 5, '水': 6, '坎': 6, '火': 3, '离': 3,
    '山': 7, '艮': 7, '泽': 2, '兑': 2,
  };
  const upper = OBJ_MAP[obj];
  if (!upper) return null;
  // 物象单取 = 纯卦 (上下同)
  return toHexagram(upper, upper);
}

/**
 * ④ 方位卦: 先天 (乾南/坤北/震东北/巽西南/坎西/离东/艮西北/兑东南)
 * @param {string} dir - 方位名 (南/北/东/西/东南/东北/西南/西北)
 * @param {'先天'|'后天'} [system='先天']
 */
function castByDirection(dir, system = '先天') {
  const PRE_MAP = { '南': 1, '北': 8, '东北': 4, '西南': 5, '西': 6, '东': 3, '西北': 7, '东南': 2 };
  const POST_MAP = { '西北': 1, '西南': 8, '东': 4, '东南': 5, '北': 6, '南': 3, '东北': 7, '西': 2 };
  const m = system === '后天' ? POST_MAP : PRE_MAP;
  const upper = m[dir];
  if (!upper) return null;
  return toHexagram(upper, upper);
}

function _movingName(n) {
  return ['初爻', '二爻', '三爻', '四爻', '五爻', '上爻'][n - 1] || '';
}

module.exports = {
  BAGUA_CODE,
  toHexagram,
  castByTime,
  castByNumbers,
  castByObject,
  castByDirection,
};
