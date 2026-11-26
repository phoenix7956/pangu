/**
 * Pangu · 64i Layer
 * fengshui/siyao.js
 *
 * 阳宅四要层 —— 门 / 主卧 / 灶 / 厕 (2026-10-23 第 68 批)
 *
 * ═══════════════════════════════════════════════════════════════
 * §一、四条规则(逐字出处)
 * ═══════════════════════════════════════════════════════════════
 *
 *   出处: `64i/sources/course_env_sizhaoyaou.txt`
 *     「1、门要开在四吉方」
 *     「2、主人房要设在吉方」
 *     「3、灶坐四凶方向四吉方」
 *     「4、厕所设在四凶方以凶制凶」
 *
 *   查法资料对「四要」各自的意义也给了原话:
 *     「『门』纳气：通过大门，将外界的『气』引人室内。」
 *     「『主』得吉气：让这股气最先滋养家宅最重要的空间-主卧室，让主人受益。」
 *     「『灶』化能量：通过厨房的『火』，将食物(能量)转化滋养家庭成员的身体与财运。」
 *     「『厕』排废浊：将使用过的、污浊的、衰败的气，通过厕所这个出口排出体外，
 *       完成一个新陈代谢的循环。」
 *
 * ═══════════════════════════════════════════════════════════════
 * §二、这一层**只做「定位」不做「结论」**
 * ═══════════════════════════════════════════════════════════════
 *
 *   它的产出是:「门该在哪个方位 / 厕该在哪个方位」这类**方位清单**。
 *   它**不**产出:「这套房子大吉」这种整体评价 —— 那需要宅卦、命卦、
 *   大游年盘、宅运全齐了才能谈, 而且查法资料本身也没给这种评级的算式。
 *   宁可少说, 不可乱说。
 */

'use strict';

const { dayunPlate, LUCKY_STARS, UNLUCKY_STARS } = require('./dayun_geometry');

const SOURCE_ID = 'course_env_sizhaoyaou';

/** 四要各自的规则原文 —— 逐字抄, 出处见文件头 §一。 */
const SIYAO_RULES = Object.freeze({
  门: { rule: '门要开在四吉方', basis: '吉方纳气' },
  主: { rule: '主人房要设在吉方', basis: '主卧得吉气' },
  灶: { rule: '灶坐四凶方向四吉方', basis: '灶坐凶方、向吉方' },
  厕: { rule: '厕所设在四凶方以凶制凶', basis: '以凶制凶, 排废浊' },
});

/**
 * 卧室落在四凶位时的化解法(查法资料给了四个凶位各一条)。
 *
 *   出处: `64i/sources/course_env_sizhaoyaou.txt`
 *     「卧室在六煞位化解：1、开光貔貅。2、安忍水。」
 *     「卧室在五鬼位化解：1、天然的藤长葫芦。2、铜制品葫芦。」
 *     「卧室在绝命位化解：1、黑曜石翡翠貔貅。放置在房间窗户，头朝外。」
 *     「卧室在祸害位化解：1、卧室挂金属风铃，铜制品较佳。」
 */
const BEDROOM_REMEDY = Object.freeze({
  六煞: ['开光貔貅', '安忍水'],
  五鬼: ['天然的藤长葫芦', '铜制品葫芦'],
  绝命: ['黑曜石翡翠貔貅，放置在房间窗户，头朝外'],
  祸害: ['卧室挂金属风铃，铜制品较佳'],
});

/**
 * 灶的朝向按所求不同(查法资料给了五条)。
 *
 *   出处: `64i/sources/course_env_sizhaoyaou.txt`
 *     「求子：灶压本命凶方，向本命生气方最佳」
 *     「求财：灶压本命凶方，向本命延年方最佳」
 *     「去病：灶压本命凶方，向本命天医方最佳」
 *     「亲人久不归家：灶压当事人本命绝方，向本命生气方」
 *     「留不住员工：灶压老板本命五鬼方，向本命生气方。」
 */
const STOVE_WISHES = Object.freeze({
  求子: { sit: '本命凶方', face: '本命生气方' },
  求财: { sit: '本命凶方', face: '本命延年方' },
  去病: { sit: '本命凶方', face: '本命天医方' },
  亲人久不归家: { sit: '当事人本命绝方', face: '本命生气方' },
  留不住员工: { sit: '老板本命五鬼方', face: '本命生气方' },
});

/**
 * 按四要给出**方位清单**。
 *
 * @param {string} gua 宅卦(或命卦)的卦名
 * @returns {{ok:boolean, plate:object, siYao:object}}
 */
function siYao(gua) {
  const plate = dayunPlate(gua);
  if (!plate.ok) return { ok: false, reason: plate.reason, input: gua };

  const lucky = plate.lucky.map((e) => ({ gua: e.gua, direction: e.direction, star: e.star }));
  const unlucky = plate.unlucky.map((e) => ({ gua: e.gua, direction: e.direction, star: e.star }));

  return {
    ok: true,
    gua,
    plate,
    siYao: {
      门: {
        rule: SIYAO_RULES.门.rule,
        need: '吉方',
        positions: lucky,
      },
      主: {
        rule: SIYAO_RULES.主.rule,
        need: '吉方',
        positions: lucky,
      },
      灶: {
        rule: SIYAO_RULES.灶.rule,
        need: '坐凶方、向吉方',
        sit_positions: unlucky,
        face_positions: lucky,
        by_wish: STOVE_WISHES,
      },
      厕: {
        rule: SIYAO_RULES.厕.rule,
        need: '凶方(以凶制凶)',
        positions: unlucky,
      },
    },
    /** 卧室落在某个凶位时, 该位的化解法(查法资料给了四个凶位)。 */
    bedroom_remedy: BEDROOM_REMEDY,
  };
}

module.exports = {
  SOURCE_ID,
  SIYAO_RULES,
  BEDROOM_REMEDY,
  STOVE_WISHES,
  siYao,
  LUCKY_STARS,
  UNLUCKY_STARS,
};
