/**
 * Pangu · 64i Layer
 * fengshui/zhai_gua.js
 *
 * 宅卦层 —— 「这房子是哪一宅」 (2026-10-23 第 68 批)
 *
 * ═══════════════════════════════════════════════════════════════
 * §一、二十四向山 → 八卦(逐字出处)
 * ═══════════════════════════════════════════════════════════════
 *
 *   出处: `64i/sources/course_env_lijidingxiang.txt`
 *     「正北坎：壬子癸」
 *     「东北艮：丑艮寅」
 *     「正东震：甲卯乙」
 *     「东南巽：辰巽巳」
 *     「正南离：丙午丁」
 *     「西南坤：未坤申」
 *     「正西兑：庚酉辛」
 *     「西北乾：戌乾亥」
 *
 *   同一份讲义还给了它的**用途**:
 *     「用于确定坐山和朝向，即利用罗盘上标注的二十四向山找到屋宅对应的
 *       方位，从而确定宅卦。」
 *     「人立于立极点，面朝纳气口为『向』，背后为『坐』（山）。」
 *
 * ═══════════════════════════════════════════════════════════════
 * §二、宅卦 = 坐山所属卦(这一条是「解读」, 不是逐字原文)
 * ═══════════════════════════════════════════════════════════════
 *
 *   查法资料里「八宅坐向」那节是**图片**, 文字层只有标题行 ⇒
 *   拿不到逐字原文。本模块采的口径是:
 *     **宅卦 = 坐山所在的那一卦**
 *     (坎宅 = 坐北向南 ⇒ 坐山 ∈ 壬子癸; 离宅 = 坐南向北 ⇒ 坐山 ∈ 丙午丁)
 *   这条与上面那张二十四向山表**自洽**(每一卦管三个山, 坐山落在哪卦就是哪宅),
 *   但因为逐字出处取不到, 出处层把它登记为 `interpretive`, **不冒充原文**。
 *
 *   ⚠️ 与「命卦」的命星数字**不是一套号**:
 *     命卦数字(坎1 坤2 震3 巽4 乾6 兑7 艮8 离9) vs 后天八卦数(乾1 兑2 离3 …)
 *     —— 本模块只用**卦名**做键, 不混数字。
 */

'use strict';

const { HOU_TIAN_BAGUA } = require('../bagua_annotations/bagua_positions');

const SOURCE_ID = 'course_env_lijidingxiang';

/**
 * 二十四向山 → 八卦。键是山名, 值是卦名。
 * (出处见文件头 §一, 逐字可核)
 */
const MOUNTAIN_TO_GUA = Object.freeze({
  壬: '坎', 子: '坎', 癸: '坎',
  丑: '艮', 艮: '艮', 寅: '艮',
  甲: '震', 卯: '震', 乙: '震',
  辰: '巽', 巽: '巽', 巳: '巽',
  丙: '离', 午: '离', 丁: '离',
  未: '坤', 坤: '坤', 申: '坤',
  庚: '兑', 酉: '兑', 辛: '兑',
  戌: '乾', 乾: '乾', 亥: '乾',
});

/** 八宅的宅卦分组(东西四宅)。 */
const GUA_GROUP = Object.freeze({
  坎: '东四宅', 震: '东四宅', 巽: '东四宅', 离: '东四宅',
  乾: '西四宅', 兑: '西四宅', 艮: '西四宅', 坤: '西四宅',
});

/**
 * 坐山 → 宅卦。
 *
 * @param {string} sittingMountain 坐山(壬子癸丑艮寅… 24 山之一)
 */
function zhaiGua(sittingMountain) {
  const key = String(sittingMountain || '').trim();
  const gua = MOUNTAIN_TO_GUA[key];
  if (!gua) {
    return {
      ok: false,
      input: key,
      reason: '不是二十四向山之一(壬子癸丑艮寅甲卯乙辰巽巳丙午丁未坤申庚酉辛戌乾亥)',
      known: Object.keys(MOUNTAIN_TO_GUA).join(''),
    };
  }
  const dir = HOU_TIAN_BAGUA[gua];
  return {
    ok: true,
    input: key,
    gua,
    group: GUA_GROUP[gua],
    direction: dir ? dir.direction : null,
    /** 对宫(向): 与坐山隔 180° 的那三山里, 正对的那一山。 */
    oppositeMountains: oppositeOf(gua),
  };
}

/**
 * **按卦**算宅卦 —— 给「已经知道坐山落在哪一卦」的场合用。
 *
 * ⚠️ 为什么必须另开一个函数, 不能拿 `zhaiGua(gua)` 顶着:
 *   `zhaiGua()` 的键是**山名**(壬子癸…), 它拿卦名去查表必然查不到 ⇒ 返回
 *   `{ok:false}` 或 `gua: undefined`。第 69 批踩过这个坑:
 *   `parseSitting()` 已经把「子山午向」解析成卦「坎」, 再喂给 `zhaiGua('坎')`
 *   就得到 `gua: undefined` —— 而**不报错**, 后面照常往下走, 输出一份
 *   「undefined宅(undefined)」的盘。**这种错最难查**: 不崩、不红, 只是内容是假的。
 *
 * @param {string} gua 卦名(坎/坤/震/巽/乾/兑/艮/离)
 */
function zhaiGuaByGua(gua) {
  const key = String(gua || '').trim();
  const group = GUA_GROUP[key];
  if (!group) {
    return {
      ok: false,
      input: key,
      reason: '不是八卦之一(坎/坤/震/巽/乾/兑/艮/离)',
    };
  }
  const dir = HOU_TIAN_BAGUA[key];
  return {
    ok: true,
    input: key,
    gua: key,
    group,
    direction: dir ? dir.direction : null,
    /** 对宫(向): 与坐山隔 180° 的那三山里, 正对的那一山。 */
    oppositeMountains: oppositeOf(key),
  };
}

/** 每一卦的**对宫**三山(隔 180°)。后天文王八卦里四组对宫是固定的。 */
const OPPOSITE_PAIR = Object.freeze({
  坎: '离', 离: '坎',
  艮: '乾', 乾: '艮',
  震: '兑', 兑: '震',
  巽: '坤', 坤: '巽',
});

function oppositeOf(gua) {
  const other = OPPOSITE_PAIR[gua];
  return Object.keys(MOUNTAIN_TO_GUA).filter((m) => MOUNTAIN_TO_GUA[m] === other);
}

/**
 * 坐山输入解析 —— 主人不会拿着罗盘说话, 所以认四种写法。
 *
 *   ① 二十四向山名: 子 / 午 / 壬 / 癸 …
 *   ② 卦名: 坎 / 坤 / 震 / 巽 / 乾 / 兑 / 艮 / 离
 *   ③ 「X山」: 子山午向 / 壬山 → 坐山 = X
 *   ④ 方位: 坐北向南 / 坐北 / 北 / 朝南 / 坐南朝北
 *      · 「坐X」⇒ X 是坐山那一侧
 *      · 「朝X」/「X向」⇒ X 是**朝向**, 坐山取对宫
 *      · 光给一个方位 ⇒ 按**坐山那一侧**处理(并在返回值里标出来)
 *
 * ⚠️ 为什么要这么宽: 真实对话里主人会说「我家坐北朝南」「子山午向」「坐北」——
 *   让工具只认山名, 等于逼模型先去查罗盘, 它多半会**自己编一个山名**。
 *   与其让模型编, 不如内核认得宽一点, 但**每一处都标清楚是怎么解出来的**
 *   (`how` 字段), 免得模型把「我按朝向反推的」当成「罗盘读的」。
 *
 * @param {string} input 坐山/坐向/方位的自由文本
 */
function parseSitting(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return { ok: false, input: raw, reason: '没给坐山/坐向', need: '给一个: 山名(子/午…)、卦名(坎/离…)、或方位(如 坐北向南)' };
  }

  // ① 二十四向山名(单字, 精确匹配)
  if (MOUNTAIN_TO_GUA[raw]) {
    return { ok: true, input: raw, gua: MOUNTAIN_TO_GUA[raw], mountain: raw, how: 'mountain_name' };
  }
  // ② 卦名
  if (GUA_GROUP[raw]) {
    return { ok: true, input: raw, gua: raw, mountain: null, how: 'gua_name' };
  }

  // ③ 「X山」—— 坐山 = X
  const shanM = /([一-龥])山/.exec(raw);
  if (shanM) {
    const m = shanM[1];
    if (MOUNTAIN_TO_GUA[m]) {
      return { ok: true, input: raw, gua: MOUNTAIN_TO_GUA[m], mountain: m, how: 'mountain_with_suffix' };
    }
  }

  // ④ 方位
  const DIRECTION_GUA = {
    北: '坎', 东北: '艮', 东: '震', 东南: '巽',
    南: '离', 西南: '坤', 西: '兑', 西北: '乾',
  };
  const OPPOSITE_DIRECTION = {
    北: '南', 南: '北', 东: '西', 西: '东',
    东北: '西南', 西南: '东北', 东南: '西北', 西北: '东南',
  };

  // 光给一个方位(「北」)⇒ 按**坐山那一侧**处理, 但 how 要诚实地标出来:
  //   主人没说这是坐还是朝, 是**盘古替他定的** —— 模型必须知道这一点。
  //   ⚠️ 这条要在「坐X」分支**之前**判, 不然「坐北」也会走这条(how 就标错了)。
  for (const d of ['东北', '东南', '西南', '西北', '北', '东', '南', '西']) {
    if (raw === d) {
      return {
        ok: true, input: raw, gua: DIRECTION_GUA[d], mountain: null,
        how: 'bare_direction_as_sitting',
        note: '只给了「' + d + '」, 按坐山在这一侧处理',
      };
    }
  }

  // 「坐X」/「坐X朝Y」⇒ X 是坐山那一侧
  //
  // ⚠️ 这里的正则不能只抓「坐」后两个字:
  //   「坐北向南」抓到的是「北向」——「北向」不在方位表里, 于是会掉到下面的
  //   「朝/向」分支, 被当成「朝向北」⇒ 卦取对宫(变成离), 而正确的是坎。
  //   **卦算对了但 how 标错了** —— 更坏: how 是模型判断「这是罗盘读的」
  //   还是「我反推的」的唯一依据, 标错就是在骗模型。
  // ⇒ 所以先切掉「朝…向…」那半截, 只在**坐山那一侧**里取方位。
  const zuoPart = raw.replace(/[朝向][^坐]*/, ' ').replace(/坐/, ' ');
  const zuoM = /([一-龥]{1,2})/.exec(zuoPart);
  if (zuoM) {
    const d = zuoM[1];
    if (DIRECTION_GUA[d]) {
      return {
        ok: true, input: raw, gua: DIRECTION_GUA[d], mountain: null,
        how: 'sitting_direction',
        note: '按「坐' + d + '」取坐山所在的那一卦',
      };
    }
    if (MOUNTAIN_TO_GUA[d]) {
      return { ok: true, input: raw, gua: MOUNTAIN_TO_GUA[d], mountain: d, how: 'sitting_mountain' };
    }
  }
  // 「朝X」/「X向」⇒ X 是朝向, 坐山取对宫
  const chaoM = /(?:朝|向)\s*([一-龥]{1,2})/.exec(raw);
  if (chaoM) {
    const d = chaoM[1];
    if (DIRECTION_GUA[d]) {
      const back = OPPOSITE_DIRECTION[d];
      return {
        ok: true, input: raw, gua: DIRECTION_GUA[back], mountain: null,
        how: 'facing_direction_inverted',
        note: '朝向是' + d + ', 坐山取对宫' + back,
      };
    }
  }
  return {
    ok: false,
    input: raw,
    reason: '认不出坐山/坐向',
    need: '给山名(子/午/壬/癸…24 个之一)、卦名(坎/坤/震/巽/乾/兑/艮/离)、或方位(如 坐北向南)',
  };
}

module.exports = {
  SOURCE_ID,
  MOUNTAIN_TO_GUA,
  GUA_GROUP,
  OPPOSITE_PAIR,
  zhaiGua,
  zhaiGuaByGua,
  oppositeOf,
  parseSitting,
};
