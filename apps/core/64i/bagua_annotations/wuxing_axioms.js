/**
 * Pangu · 64i Layer
 * bagua_annotations/wuxing_axioms.js
 *
 * Pangu 8 维向量的五行公理层 - 2026-06-18 老板拍板建立
 *
 * 5 元素公理表 + 5×5 关系矩阵
 * 关系本质 = 两件事物之间的相互作用类型（不是元素字典）
 *
 * 字段说明（公理 = 不可变底层属性）：
 *   name        元素名（金/木/水/火/土）
 *   english     英文名
 *   symbol      Unicode 符号（采用汉字本体，最具识别度）
 *   color       关联色（中医五色）
 *   direction   主方位（后天方位）
 *   season      主季节
 *   nature      物理/化学属性简述
 *   yin_yang    **本气**阴阳归属（阳/阴）—— ⚠️ 见下方警告，它不是全貌
 *   organ       中医对应脏腑
 *   keywords    关键词数组
 *
 * ⚠️ `yin_yang` 是**单值**, 因为每一行只代表一个五行, 而每个五行**阴阳各一**:
 *   木有甲(阳木)也有乙(阴木), 火有丙(阳火)也有丁(阴火), 金水土同理。
 *   全貌是 **五行 × 阴阳 = 十天干** (甲丙戊庚壬=阳, 乙丁己辛癸=阴),
 *   真源在 `64i/bazi/ten_gods.js` 的 `YIN_YANG`。
 *
 *   为什么这个字段还留着: 它记的是**本气/纳甲**那一层(单个五行的基调阴阳),
 *   不是天干层的阴阳, 两者不是一回事, 不能互相替代。
 *   但它是个**陷阱** —— 照它推会得出「火是阳, 所以只有阳火, 丁火不算」这种错结论。
 *   2026-10-21 实查: 全仓库**无人消费**本字段(只有 `getRelation` 被用),
 *   留着的唯一风险就是将来有人开始读它。
 *   处置: `bagua_annotations/wuxing_yinyang.js` 装时自检 ③ 专门堵这个坑,
 *   任何一层要判"这一行的阴阳", 必须去 `ten_gods.js` 取十天干真源。
 *
 * ⚠️ 关于 冲/刑/害 在五行层面的传统定义：
 *   冲/刑/害 起源于 12 地支（子丑寅卯辰巳午未申酉戌亥）的相互关系，
 *   而非 5 行本身。五行只有 相生 (sheng) / 相克 (ke) / 同 (tong) 三种
 *   严格定义的关系。把 12 地支的 冲/刑/害 强行映射到 5×5 = 25 格矩阵
 *   会出现以下问题：
 *     (a) 多对一冲突：一对地支可同时是冲和刑（如寅申既是冲又是三刑成员）
 *     (b) 同元素映射不一致：丑未冲 → 土，但土对土在五行是 tong
 *     (c) 不同流派对映射规则分歧大（命理/风水/中医/奇门各不相同）
 *   因此本表对 10 个非 sheng/ke/tong 单元格统一标 'unknown'，
 *   留待未来有权威来源后再细化。
 *
 * 6 种关系 (RELATIONS)：
 *   sheng   生  推动/促进
 *   ke      克  抑制/约束
 *   chong   冲  对立/矛盾（地支六冲，需 12 地支语境才能定义）
 *   xing    刑  伤害/惩罚（地支三刑，需 12 地支语境才能定义）
 *   hai     害  暗损（六害，需 12 地支语境才能定义）
 *   tong    同  一致
 *
 * 相生循环：金→水→木→火→土→金
 * 相克循环：金→木→土→水→火→金
 */

'use strict';

// ============================================================
// 5 元素公理表
// 顺序：依相生循环相邻排序（金→水→木→火→土）
// ============================================================

const WUXING_AXIOMS = [
  {
    name: '金',
    english: 'metal',
    symbol: '金',
    color: '白',
    direction: '西',
    season: '秋',
    nature: '沉降/收敛/肃杀/坚硬',
    yin_yang: '阴',
    organ: '肺/大肠',
    keywords: ['沉降', '收敛', '肃杀', '坚硬', '变革'],
  },
  {
    name: '木',
    english: 'wood',
    symbol: '木',
    color: '青',
    direction: '东',
    season: '春',
    nature: '生发/条达/曲直',
    yin_yang: '阳',
    organ: '肝/胆',
    keywords: ['生发', '条达', '曲直', '生长', '仁'],
  },
  {
    name: '水',
    english: 'water',
    symbol: '水',
    color: '黑',
    direction: '北',
    season: '冬',
    nature: '寒凉/滋润/下行',
    yin_yang: '阴',
    organ: '肾/膀胱',
    keywords: ['寒凉', '滋润', '下行', '寒藏', '智'],
  },
  {
    name: '火',
    english: 'fire',
    symbol: '火',
    color: '赤',
    direction: '南',
    season: '夏',
    nature: '炎热/向上/光明',
    yin_yang: '阳',
    organ: '心/小肠',
    keywords: ['炎热', '向上', '光明', '温热', '礼'],
  },
  {
    name: '土',
    english: 'earth',
    symbol: '土',
    color: '黄',
    direction: '中',
    season: '长夏',
    nature: '化生/承载/中和',
    yin_yang: '阳',
    organ: '脾/胃',
    keywords: ['化生', '承载', '中和', '厚重', '信'],
  },
];

// ============================================================
// 6 种关系常量
// ============================================================

const RELATIONS = {
  SHENG: 'sheng',     // 生 - 我生对方 (推动/促进)
  BEI_SHENG: 'bei_sheng', // 泄 - 对方生我 (我被泄/被生)
  KE: 'ke',           // 克 - 我克对方 (抑制/约束)
  BEI_KE: 'bei_ke',   // 耗 - 对方克我 (我被耗/被克)
  CHONG: 'chong',     // 冲 - 对立/矛盾（地支六冲，需 12 地支语境才能定义）
  XING: 'xing',       // 刑 - 伤害/惩罚（地支三刑，需 12 地支语境才能定义）
  HAI: 'hai',         // 害 - 暗损（六害，需 12 地支语境才能定义）
  TONG: 'tong',       // 同 - 一致
};

// ============================================================
// 5×5 关系矩阵
// 行 = 主方, 列 = 对方
// ============================================================

/**
 * 相生循环: 主方生谁
 *   金生水, 水生木, 木生火, 火生土, 土生金
 * （依《尚书·洪范》"水曰润下，火曰炎上，木曰曲直，金曰从革，土爰稼穑"
 *  + 中医/命理共通的生克循环）
 */
const _SHENG_OF = Object.freeze({
  '金': '水',
  '水': '木',
  '木': '火',
  '火': '土',
  '土': '金',
});

/**
 * 相克循环: 主方克谁
 *   金克木, 木克土, 土克水, 水克火, 火克金
 * （五行相克，方向固定，循环成环）
 */
const _KE_OF = Object.freeze({
  '金': '木',
  '木': '土',
  '土': '水',
  '水': '火',
  '火': '金',
});

const _ELEMENTS = ['金', '木', '水', '火', '土'];

/**
 * 构建 5×5 关系矩阵
 *   - tong       主方 = 对方（5 格，对角线）
 *   - sheng      主方生对方（5 格）
 *   - ke         主方克对方（5 格）
 *   - bei_sheng  对方生主方（5 格，即主方被泄/被生）
 *   - bei_ke     对方克主方（5 格，即主方被耗/被克）
 *   - 'unknown'  只在意外情况出现（五行只 tong/sheng/ke/bei_sheng/bei_ke 五类应填满 25 格）
 */
const WUXING_RELATION_MATRIX = Object.freeze((function buildMatrix() {
  const matrix = {};
  for (const row of _ELEMENTS) {
    const rowObj = {};
    for (const col of _ELEMENTS) {
      if (row === col) {
        rowObj[col] = RELATIONS.TONG;
      } else if (_SHENG_OF[row] === col) {
        rowObj[col] = RELATIONS.SHENG;        // 我生对方
      } else if (_KE_OF[row] === col) {
        rowObj[col] = RELATIONS.KE;           // 我克对方
      } else if (_SHENG_OF[col] === row) {
        rowObj[col] = RELATIONS.BEI_SHENG;    // 对方生我 (我被泄)
      } else if (_KE_OF[col] === row) {
        rowObj[col] = RELATIONS.BEI_KE;       // 对方克我 (我被耗)
      } else {
        // 五行 5 类关系应填满 25 格，此分支为防御性兜底
        rowObj[col] = 'unknown';
      }
    }
    matrix[row] = Object.freeze(rowObj);
  }
  return matrix;
})());

// ============================================================
// 索引表（构建期一次性生成，O(1) 查询）
// ============================================================

const _BY_NAME = {};
for (const axiom of WUXING_AXIOMS) {
  _BY_NAME[axiom.name] = axiom;
}

// ============================================================
// 查询函数
// ============================================================

/**
 * 按五行名获取元素公理
 * @param {string} name - 五行名（金/木/水/火/土）
 * @returns {object|null} 元素公理对象，未找到返回 null
 */
function getWuxingAxiom(name) {
  if (typeof name !== 'string') return null;
  return _BY_NAME[name] || null;
}

/**
 * 查询两元素之间的关系（主方对对方）
 * @param {string} w1 - 主方五行
 * @param {string} w2 - 对方五行
 * @returns {string} 'sheng' / 'ke' / 'tong' / 'unknown'
 *                  （参数错误或该单元格无标准定义时返回 'unknown'）
 */
function getRelation(w1, w2) {
  if (typeof w1 !== 'string' || typeof w2 !== 'string') return 'unknown';
  if (!(w1 in WUXING_RELATION_MATRIX)) return 'unknown';
  if (!(w2 in WUXING_RELATION_MATRIX[w1])) return 'unknown';
  return WUXING_RELATION_MATRIX[w1][w2];
}

/**
 * 主方生谁
 * @param {string} name - 主方五行
 * @returns {string|null} 对方五行（金/木/水/火/土），无效输入返回 null
 */
function shengOf(name) {
  if (typeof name !== 'string') return null;
  if (!(name in _SHENG_OF)) return null;
  return _SHENG_OF[name];
}

/**
 * 主方克谁
 * @param {string} name - 主方五行
 * @returns {string|null} 对方五行（金/木/水/火/土），无效输入返回 null
 */
function keOf(name) {
  if (typeof name !== 'string') return null;
  if (!(name in _KE_OF)) return null;
  return _KE_OF[name];
}

module.exports = {
  WUXING_AXIOMS,
  RELATIONS,
  WUXING_RELATION_MATRIX,
  getWuxingAxiom,
  getRelation,
  shengOf,
  keOf,
};
