/**
 * Pangu · 64i Layer
 * bagua_annotations/yao_positions.js
 *
 * 384爻位注解层
 * 职责：每个卦的6个爻位注解（爻位阴阳/爻位动静/爻位性质）
 *
 * ⚠️ 2026-10-22 第 36 批: 爻位五行**从这里也撤了**, 而且这张表改为
 *   **从 `yao_axioms.js` 派生**, 不再自己抄一份。
 *
 *   为什么合并: 本文件原来把「爻位表」整个抄了一遍(位置/五行/性质/描述)。
 *   铁律「一份东西抄两遍 = 迟早只改其中一份」—— 第 36 批撤五行时,
 *   如果只改 `yao_axioms.js`, 这里会**继续吐着一张假表**给调用方,
 *   而且没有任何守卫会响(两份数据各说各话, 校验的又是其中一份)。
 *   ⇒ 现在 YAO_POSITIONS 由 yao_axioms 的公理派生, 只有一份真源。
 *
 *   同理, 本层**不提供**爻位五行: 爻的五行来自该卦该爻的**纳甲地支五行**
 *   (`najia.js`, 卦层)。本层只管「这一爻是阳是阴、动不动、什么性质」。
 */

'use strict';

const { HEXAGRAMS, getHexagram } = require('../hexagrams');
const yaoAxioms = require('./yao_axioms');
// 爻题规则的真源 —— 2026-10-26 第 107 批。
//   原来这里**自己**判阴阳: `yaoCi.includes('九')` —— 扫**爻辞正文**找「九」字。
//   震卦六二「六二：震来厉，亿丧贝，跻于九陵，勿逐七日得」正文里有个「九」,
//   于是这条**阴爻被判成阳爻** (全库 1/384 处, 正好是这一处)。
//   ⇒ 同一个 bug 桌面端在 2026-10-22 第 48 批修过它自己那份, core 这份**原封不动**。
//   ⇒ 现在改成读**爻题**(数据自带), 爻题缺失时按 binary 推 —— 与 64i/yao_title.js 同一份判据。
const { parseYao, yaoYinYang } = require('../yao_title');

/** 爻位的口语名(初爻/二爻/…/上爻) —— 1:1 于 0..5 下标, 单独存一张很短的表 */
const POSITION_NAMES = ['初爻', '二爻', '三爻', '四爻', '五爻', '上爻'];

/**
 * 六爻位注解 —— **从 yao_axioms 派生**, 不另打一份。
 *
 * ⚠️ 派生而不是重抄的另一个好处: 爻位公理层哪天加了/改了字段,
 *   这里自动跟上; 而重抄的版本会静默停在旧值上, 且没人会发现。
 */
const YAO_POSITIONS = yaoAxioms.YAO_POSITION_AXIOMS.map((ax) => ({
  position: ax.position,
  name: POSITION_NAMES[ax.position],
  nature: ax.nature,
  description: ax.description,
}));

/**
 * 获取某卦某爻位的注解
 * @param {number} guaId - 卦序号（1-64）
 * @param {number} position - 爻位（0-5，初爻为0）
 * @returns {object}
 */
function getYaoPosition(guaId, position) {
  if (position < 0 || position > 5) return null;
  const base = YAO_POSITIONS[position];
  const hexagram = getHexagram(guaId);
  if (!hexagram) return null;
  const yaoCi = hexagram.yao_ci[position];
  const { title } = parseYao(yaoCi);
  const isYang = title ? title.includes('九') : !!yaoYinYang(hexagram.binary, position);
  return {
    ...base,
    guaId,
    guaName: hexagram.name,
    yaoCi,
    // ⚠ **动静不由爻辞文本判** —— 爻辞里根本没有动静信息。
    //   老判据 `includes('九') && (includes('初')||includes('上')||includes('六')===false)`
    //   是在拿爻题的字面凑一个「动」, 结果毫无意义(初九/上九/九二全被判「动」)。
    //   动静的真源是**爻值**(6 老阴 / 9 老阳 才是动) —— 那是起卦的结果, 不在爻辞里。
    //   ⇒ 没给爻值就**不知道**, 如实给 null + 理由, 不编一个假的。
    isMoving: null,
    movingBasis: '爻辞不含动静信息; 动静由爻值 6/9 决定, 本层不猜。',
    isYang,
    polarity: isYang ? '阳' : '阴',
  };
}

/**
 * 获取某卦全部6爻注解
 * @param {number} guaId - 卦序号（1-64）
 * @returns {Array}
 */
function getYaoPositions(guaId) {
  const hexagram = getHexagram(guaId);
  if (!hexagram) return [];
  return hexagram.yao_ci.map((yaoCi, i) => {
    const base = YAO_POSITIONS[i];
    const { title } = parseYao(yaoCi);
    const isYang = title ? title.includes('九') : !!yaoYinYang(hexagram.binary, i);
    return {
      ...base,
      guaId,
      guaName: hexagram.name,
      yaoCi,
      isYang,
      polarity: isYang ? '阳' : '阴',
      isMoving: null,
      movingBasis: '爻辞不含动静信息; 动静由爻值 6/9 决定, 本层不猜。',
    };
  });
}

module.exports = { YAO_POSITIONS, POSITION_NAMES, getYaoPosition, getYaoPositions };
