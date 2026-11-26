/**
 * Pangu · 64i Layer
 * bagua_annotations/yao_axioms.js
 *
 * Pangu 8 维向量的爻位公理层
 * 6 爻位 = 事物发展时间轴的 6 个采样点
 *
 * 字段说明（公理 = 不可变底层属性）：
 *   position       爻位 0-5 (0=初爻, 5=上爻)
 *   yaoName_yang   阳爻名 (初九/九二/.../上九)
 *   yaoName_yin    阴爻名 (初六/六二/.../上六)
 *   nature         性质 (根元/身本/动用/变机/德成/极终)
 *   description    详细描述
 *   human_relations 人伦 (shi/meaning)
 *   time_phase     时间维度
 *   space_phase    空间维度
 *   social_phase   社会维度
 *   keywords       关键词数组
 *
 * ═══════════════════════════════════════════════════════════════
 * ⚠️ 2026-10-22 第 36 批: 本表**不再有** `wuxing` 字段(原「爻位固定五行」)
 * ═══════════════════════════════════════════════════════════════
 *
 *   原字段是 初水/二木/三火/四金/五土/上火。撤它有三条理由, 每条都实算过:
 *
 *   ① **查无出处** —— /Users/you/Desktop/course-source 全树搜「爻位五行」「初爻…水」「二爻…木」,
 *      只命中无关文本。术数数据要么程序算(可自校验)要么从真源取, 每条带出处,
 *      不凭印象(项目铁律)。这张表没有出处。
 *
 *   ② **与真纳甲冲突 20/24** —— 拿 `najia.js` 的真纳甲地支当**异源尺子**量它:
 *      4 个能装卦(乾/坤/泰/否)共 24 个爻位, 只对上 4 个(乾、泰的前两爻, 纯巧合),
 *      坤卦 6 个爻位**全错**。
 *
 *   ③ **结构上不可能是京房六亲** —— 固定爻位表 ⇒ 六亲的「他」侧不随卦变 ⇒
 *      同宫 8 卦六亲完全相同, 64 卦六亲塌成 5 种形态。真京房六亲的「他」侧
 *      必然随卦变(各卦纳甲不同)。
 *
 *   ⇒ 爻的五行现在**只有一个来源**: 该卦该爻的**纳甲地支五行**(`najia.js`, 卦层)。
 *      这正是老板那条「爻动阴阳那就太过了」在数据上的落地 ——
 *      爻位公理层**根本不带五行**, 也就没有「五行随动爻变」这种东西可发生。
 *
 *   机器判据在 `modules/yao_layer_boundary.js` 的 `checkYaoPositionWuxingIsStatic`:
 *   本表任何一条爻位公理一旦又长出 `wuxing` 字段, 启动自检即炸。
 *   (注释会被人吃掉, 判据不会 —— 这是「注释 ≠ 隔离」的正面用法。)
 */

'use strict';

// ============================================================
// 6 爻位公理表
// ============================================================

const YAO_POSITION_AXIOMS = [
  {
    position: 0,
    yaoName_yang: '初九',
    yaoName_yin: '初六',
    nature: '根元',
    description: '事物萌芽，根基未定。最底层、初始状态。',
    human_relations: { shi: '元士(百姓)', meaning: '草根/初出/潜隐' },
    time_phase: '萌芽期',
    space_phase: '地下',
    social_phase: '草根',
    keywords: ['萌芽', '根基', '初出', '潜隐'],
  },
  {
    position: 1,
    yaoName_yang: '九二',
    yaoName_yin: '六二',
    nature: '身本',
    description: '事物形成，开始显现。中坚、骨干位置。',
    human_relations: { shi: '大夫', meaning: '中层/承重/中坚' },
    time_phase: '形成期',
    space_phase: '地面',
    social_phase: '中层',
    keywords: ['形成', '显现', '中坚', '承重'],
  },
  {
    position: 2,
    yaoName_yang: '九三',
    yaoName_yin: '六三',
    nature: '动用',
    description: '事物发展，行动展开。上下交界，变革位。',
    human_relations: { shi: '公卿(诸侯)', meaning: '上层/行动/转折' },
    time_phase: '发展期',
    space_phase: '地上',
    social_phase: '上层',
    keywords: ['发展', '行动', '变革', '上下之交'],
  },
  {
    position: 3,
    yaoName_yang: '九四',
    yaoName_yin: '六四',
    nature: '变机',
    description: '事物转折，变化将至。由下卦入上卦，进入新阶段。',
    human_relations: { shi: '诸侯', meaning: '近君/转折/承上启下' },
    time_phase: '转折期',
    space_phase: '天上',
    social_phase: '转折',
    keywords: ['转折', '变化', '承上启下', '关键'],
  },
  {
    position: 4,
    yaoName_yang: '九五',
    yaoName_yin: '六五',
    nature: '德成',
    description: '事物鼎盛，德行圆满。至尊位、最佳状态。',
    human_relations: { shi: '天子(君)', meaning: '君王/鼎盛/至尊' },
    time_phase: '鼎盛期',
    space_phase: '帝位',
    social_phase: '君王',
    keywords: ['鼎盛', '德成', '至尊', '圆满'],
  },
  {
    position: 5,
    yaoName_yang: '上九',
    yaoName_yin: '上六',
    nature: '极终',
    description: '事物终极，盛极必反。物极必反、变卦起点。',
    human_relations: { shi: '太上(宗庙)', meaning: '太上/宗庙/终极' },
    time_phase: '终末期',
    space_phase: '天外',
    social_phase: '太上',
    keywords: ['终极', '盛极必反', '物极必反', '太上'],
  },
];

// ============================================================
// 索引表（构建期一次性生成，O(1) 查询）
// ============================================================

const _BY_POSITION = {};
const _BY_NATURE = {};

for (const axiom of YAO_POSITION_AXIOMS) {
  _BY_POSITION[axiom.position] = axiom;

  if (!_BY_NATURE[axiom.nature]) _BY_NATURE[axiom.nature] = [];
  _BY_NATURE[axiom.nature].push(axiom);
}

// ============================================================
// 查询函数
// ============================================================

/**
 * 按爻位 0-5 获取爻位公理
 * @param {number} position - 0-5 (0=初爻, 5=上爻)
 * @returns {object|null}
 */
function getYaoPositionAxiom(position) {
  if (typeof position !== 'number') return null;
  if (position < 0 || position > 5 || !Number.isInteger(position)) return null;
  return _BY_POSITION[position] || null;
}

/**
 * 按性质查找爻位（每个性质唯一对应一个爻位）
 * @param {string} nature - 根元/身本/动用/变机/德成/极终
 * @returns {object[]} 匹配数组（通常长度为 1）
 */
function getYaoPositionsByNature(nature) {
  if (typeof nature !== 'string') return [];
  return _BY_NATURE[nature] || [];
}

module.exports = {
  YAO_POSITION_AXIOMS,
  getYaoPositionAxiom,
  getYaoPositionsByNature,
};
