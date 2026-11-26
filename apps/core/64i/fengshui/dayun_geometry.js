/**
 * Pangu · 64i Layer
 * fengshui/dayun_geometry.js
 *
 * 大游年层 —— 「八方各是什么星」 (2026-10-23 第 68 批)
 *
 * ═══════════════════════════════════════════════════════════════
 * §一、大游年歌诀八条(逐字出处, 一字不改)
 * ═══════════════════════════════════════════════════════════════
 *
 *   出处: `64i/sources/course_env_shijianli.txt`
 *     「大游年歌诀首字以伏位为起点，其余七字为七星星名缩写，
 *       然后从伏位开始，按照八卦方位顺序顺时针排列。」
 *     「震——伏延生祸绝五天六，巽——伏天五六祸生绝延，
 *       离——伏六五绝延祸生天，坤——伏天延绝生祸五六，
 *       兑——伏生祸延绝六五天，乾——伏六天五祸绝延生，
 *       坎——伏五天生延绝祸六，艮——伏六绝祸生延天五。」
 *
 * ═══════════════════════════════════════════════════════════════
 * §二、为什么这一层比「抄下八条歌诀」值钱得多
 * ═══════════════════════════════════════════════════════════════
 *
 *   歌诀本身是**冗余**的: 它给的是「从伏位起、按八卦方位顺时针」排出来的一串。
 *   而那串的第一位永远是伏位 ⇒ **光看歌诀, 排不出它自己** ——
 *   必须先知道八卦的物理方位顺序(顺时针: 震→巽→离→坤→兑→乾→坎→艮)。
 *
 *   本模块把这个冗余**变成守卫**:
 *     `checkSongsAgainstRule()` —— 对每个卦,
 *       用「伏位起 + 顺时针」从**抄下来的歌诀**重新排一遍, 看能不能排回自己。
 *     抄错一个字(比如把「六」写成「八」), 不动点立刻破 ⇒ 守卫报红。
 *   ⇒ 这比「我抄对了」强一个量级: **它证明抄的东西自洽**, 而不是相信我。
 *
 *   方位顺序不手抄: 从 `bagua_positions.js` 的**后天八卦方位**按角度算出来
 *   (北 0° → 东北 45° → 东 90° → …), 所以「顺时针」是算出来的, 不是背下来的。
 *
 * ═══════════════════════════════════════════════════════════════
 * §三、四吉四凶(这一条是「解读」, 不是逐字原文)
 * ═══════════════════════════════════════════════════════════════
 *
 *   课的「四吉方属性 / 四凶方属性」在八宅 PDF 第 6 页, 是**图片**, 文字层取不到。
 *   本模块采的口径(登记为 interpretive, 不冒充原文):
 *     四吉: 伏位、延年、生气、天医
 *     四凶: 祸害、绝命、五鬼、六煞
 *   ⚠️ 这个分组的**可验证性**靠的是另一件事: 每一宅排出来的八方里,
 *     吉星必须恰好 4 个、凶星恰好 4 个 —— 歌诀保证了这一点(见 §四)。
 */

'use strict';

const { HOU_TIAN_BAGUA } = require('../bagua_annotations/bagua_positions');

const SOURCE_ID = 'course_env_shijianli';

/** 大游年歌诀八条 —— 逐字抄录, 一字不改(出处见文件头 §一)。 */
const DAYUN_SONGS = Object.freeze({
  震: '伏延生祸绝五天六',
  巽: '伏天五六祸生绝延',
  离: '伏六五绝延祸生天',
  坤: '伏天延绝生祸五六',
  兑: '伏生祸延绝六五天',
  乾: '伏六天五祸绝延生',
  坎: '伏五天生延绝祸六',
  艮: '伏六绝祸生延天五',
});

/** 歌诀里的单字缩写 → 星名全称。 */
const STAR_FULL_NAME = Object.freeze({
  伏: '伏位',
  延: '延年',
  生: '生气',
  祸: '祸害',
  绝: '绝命',
  五: '五鬼',
  天: '天医',
  六: '六煞',
});

/** 四吉 / 四凶(出处层登记为 interpretive, 见文件头 §三)。 */
const LUCKY_STARS = Object.freeze(['伏位', '延年', '生气', '天医']);
const UNLUCKY_STARS = Object.freeze(['祸害', '绝命', '五鬼', '六煞']);

/** 方位 → 角度(北 0°, 顺时针)。用来**算**顺时针次序, 不背。 */
const BEARING = Object.freeze({
  正北: 0, 东北: 45, 正东: 90, 东南: 135,
  正南: 180, 西南: 225, 正西: 270, 西北: 315,
});

/**
 * 后天八卦的**顺时针**次序(从正北起)。
 * 例: 震(正东 90°) → 巽(135) → 离(180) → 坤(225) → 兑(270) → 乾(315) → 坎(0) → 艮(45)
 */
function clockwiseOrder() {
  return Object.keys(HOU_TIAN_BAGUA)
    .map((g) => ({ gua: g, bearing: BEARING[HOU_TIAN_BAGUA[g].direction] }))
    .sort((a, b) => a.bearing - b.bearing)
    .map((x) => x.gua);
}

/** 从某卦起, 顺时针取 n 个卦(不重复)。 */
function rotateFrom(gua, n = 8) {
  const order = clockwiseOrder();
  const i = order.indexOf(gua);
  if (i < 0) throw new Error('不在后天八卦里的卦: ' + gua);
  const out = [];
  for (let k = 0; k < n; k++) out.push(order[(i + k) % order.length]);
  return out;
}

/**
 * 排一宅的大游年盘。
 *
 * @param {string} gua 宅卦或命卦的卦名(坎/坤/震/巽/乾/兑/艮/离)
 */
function dayunPlate(gua) {
  const song = DAYUN_SONGS[gua];
  if (!song) {
    return { ok: false, input: gua, reason: '没有这一卦的大游年歌诀' };
  }
  const positions = rotateFrom(gua);
  const entries = positions.map((g, i) => {
    const abbr = song[i];
    const star = STAR_FULL_NAME[abbr];
    // ⚠️ 三态, 不是两态: 吉 / 凶 / **未知**。
    //   早先这里只查 LUCKY_STARS, 「不是吉就算凶」——
    //   于是 UNLUCKY_STARS 那张表**根本没被读**: 把它删掉一颗凶星, 结果一模一样,
    //   变异 M9 打空枪才把这件事逼出来。
    //   现在两边都查: 一颗星若既不在吉表也不在凶表, 显式落成「未知」,
    //   由判据当场报红 —— 宁可报「不知道」, 不许默默当成凶。
    const luck = LUCKY_STARS.indexOf(star) >= 0 ? '吉'
      : (UNLUCKY_STARS.indexOf(star) >= 0 ? '凶' : '未知');
    return {
      gua: g,
      direction: HOU_TIAN_BAGUA[g].direction,
      star_abbr: abbr,
      star,
      luck,
    };
  });
  const lucky = entries.filter((e) => e.luck === '吉');
  const unlucky = entries.filter((e) => e.luck === '凶');
  const unknown = entries.filter((e) => e.luck === '未知');
  return {
    ok: true,
    gua,
    song,
    entries,
    lucky,
    unlucky,
    unknown,
    /** 伏位永远是自己这一卦 —— 歌诀第一字就是伏位。 */
    fu_wei: entries[0],
  };
}

/**
 * 不动点检查: 用「伏位起 + 顺时针」从**抄下来的歌诀**重排一遍,
 * 看能不能排回自己。抄错一个字 ⇒ 这里立刻破。
 */
function checkSongsAgainstRule() {
  const problems = [];
  const guas = Object.keys(DAYUN_SONGS);

  /** 宅卦 X 的盘里, 方位 Y 拿到的是哪个星。 */
  const starAt = (plateGua, targetGua) => {
    const pos = rotateFrom(plateGua);
    const i = pos.indexOf(targetGua);
    return DAYUN_SONGS[plateGua][i];
  };

  // ① 歌诀首字必须是伏位, 长度必须 8
  for (const gua of Object.keys(DAYUN_SONGS)) {
    const song = DAYUN_SONGS[gua];
    if (song.length !== 8) {
      problems.push({ gua, song, reason: '歌诀长度不是 8' });
    }
    if (song[0] !== '伏') {
      problems.push({ gua, song, reason: '歌诀首字不是伏位' });
    }
    const seen = new Set(song.split(''));
    if (seen.size !== 8) {
      problems.push({ gua, song, reason: '歌诀里八个星名不是各出现一次' });
    }
    for (const ch of song.split('')) {
      if (!STAR_FULL_NAME[ch]) {
        problems.push({ gua, song, reason: '歌诀里有不认识的星缩写: ' + ch });
      }
    }
  }

  // ② 对称性: X 的盘里 Y 拿到什么星, Y 的盘里 X 也必须拿到同一个星。
  //    (这是「伏位起 + 顺时针」这条规则的**必然推论** ⇒ 抄错一个字必破)
  for (const x of guas) {
    for (const y of guas) {
      if (x === y) continue;
      const fromX = starAt(x, y);
      const fromY = starAt(y, x);
      if (fromX !== fromY) {
        problems.push({
          gua: x,
          other: y,
          reason: '盘不对称: ' + x + ' 宅给 ' + y + ' 是「' + fromX
            + '」, ' + y + ' 宅给 ' + x + ' 却是「' + fromY + '」',
        });
      }
    }
  }

  // ③ 每宅的八方: 吉星恰好 4 个、凶星恰好 4 个
  for (const gua of guas) {
    const plate = dayunPlate(gua);
    if (!plate.ok) {
      problems.push({ gua, reason: plate.reason });
      continue;
    }
    if (plate.lucky.length !== 4 || plate.unlucky.length !== 4) {
      problems.push({
        gua,
        reason: '吉凶不是 4:4 —— 吉 ' + plate.lucky.length + ' / 凶 ' + plate.unlucky.length,
      });
    }
    if (plate.unknown.length) {
      problems.push({
        gua,
        reason: '有星既不在吉表也不在凶表: '
          + plate.unknown.map((e) => e.star).join(','),
      });
    }
  }

  return { checked: guas.length, problems };
}

/**
 * 宅命相配: 东四命配东四宅, 西四命配西四宅。
 *
 *   出处: `64i/sources/course_env_bazhai.txt`
 *     「宅命相配：东四命配东四宅，西四命配西四宅」
 *
 * ⚠️ 命侧叫「东四**命**」、宅侧叫「东四**宅**」—— 字面比不相等,
 *   但课的原话就是「东四命配东四宅」⇒ 比的是**组**(东四/西四), 不是整串。
 *   这个坑很实在: 直接比字符串会让**每一对都判成不配**, 而且不报错。
 */
function matchGua(mingGroup, zhaiGroup) {
  const cls = (s) => String(s || '').replace(/[命宅]$/, '');
  const ok = cls(mingGroup) === cls(zhaiGroup);
  return {
    ok,
    ming_group: mingGroup,
    zhai_group: zhaiGroup,
    verdict: ok ? '相配' : '不配',
    advice: ok
      ? '宅命同组, 不用在这一层动。'
      : '宅命不同组(东四命住西四宅或反之), 查法资料的处理是「调」——具体怎么调要连宅卦与大游年盘一起看。',
  };
}

module.exports = {
  SOURCE_ID,
  DAYUN_SONGS,
  STAR_FULL_NAME,
  LUCKY_STARS,
  UNLUCKY_STARS,
  BEARING,
  clockwiseOrder,
  rotateFrom,
  dayunPlate,
  checkSongsAgainstRule,
  matchGua,
};
