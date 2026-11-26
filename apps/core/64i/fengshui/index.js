/**
 * Pangu · 64i Layer
 * fengshui/index.js
 *
 * 风水层聚合入口 (2026-10-23 第 68 批)
 *
 *   这一层是**术数六门里「风水」那一门的第一版**, 由五块组成:
 *     ming_gua.js      命卦(人)   —— 出生年 + 性别 → 卦/东西四命
 *     zhai_gua.js      宅卦(房)   —— 坐山 → 卦/东西四宅
 *     dayun_geometry.js 大游年(方位) —— 宅卦/命卦 → 八方吉凶星
 *     siyao.js         阳宅四要     —— 门/主卧/灶/厕 的方位清单
 *     jiuyun.js        三元九运     —— 年份 → 第几运
 *
 *   五块**互不依赖**(除 dayun 依赖 bagua_positions 的后天方位),
 *   串起来的那一步在 `fengshuiProfile()` 里, 每一步都标出它用了哪块。
 *
 * ⚠️ 边界(直说):
 *   · **不给整体吉凶评级** —— 只给方位清单与相配/不相配。
 *   · **大象辞仍空** —— 那是 64 卦侧的老缺口, 与本层无关。
 *   · **奇门/姓名两门仍是 0 文件**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 第 69 批: 接进生产
 * ═══════════════════════════════════════════════════════════════
 *
 *   第 68 批这一层是「内核里很完整、模型看不见」——
 *   第 69 批把它接到 `fengshui_calc` 工具上, 并进了 LAYERS.fengshui。
 *
 *   ⚠️ 但**接进生产不等于可以当经典讲**:
 *     这一层里有三类来源不同的东西(原文 / 课上图片拿不到原文 / 盘古推导),
 *     所以它带**两个**身份标签(见文件下半部分 FENGSHUI_TAG / FENGSHUI_INTERPRETIVE_TAG)。
 *     只标一个的话, 要么模型不敢用, 要么主人一问出处就露馅。
 */

'use strict';

const mingGua = require('./ming_gua');
const zhaiGua = require('./zhai_gua');
const dayunGeometry = require('./dayun_geometry');
const siyao = require('./siyao');
const jiuyun = require('./jiuyun');

// ============================================================
// 身份标签 (第 69 批: 风水层接进生产时用)
// ============================================================
//
// ⚠️ 为什么风水层要**两个**标签, 不是一个:
//
//   这一层里混着**三种来源不同**的东西:
//     ① 有逐字原文的 —— 二十四向山表、大游年歌诀、阳宅四要四条、三元九运锚点
//     ② 课上是**图片**、拿不到逐字原文的 —— 「宅卦 = 坐山所属卦」、四吉四凶分组
//     ③ 盘古自己的**推导** —— 「一运 20 年 ⇒ 1864 起」、坐山/向的对宫
//
//   只有一个标签的话, 模型会把①也当成"盘古自己编的" (那它就不敢用了),
//   或者把②③当成经典原话 (那主人一问「易经里真这么说吗」就露馅)。
//
//   ⇒ 两个标签分工:
//     FENGSHUI_TAG            —— 整段风水平盘的**身份** ("这一层是什么")
//     FENGSHUI_INTERPRETIVE_TAG —— 段内**哪几条是解读/推导**(不是原文)
//
//   落在**哪一层的哪几条**由渲染点标, 内核只提供标签字面量 —— 标签只有一份。

/**
 * 风水层整体身份标签。
 * 「风水 / 八宅」是这一门在课程资料里的名字, 不是《易经》原文 ⇒ 必须标身份。
 */
const FENGSHUI_TAG = '〔风水层为课程口径, 非《易经》原文〕';

/**
 * 段内**解读/推导**条目的身份标签。
 * 用于「宅卦 = 坐山所属卦」「四吉四凶分组」「对宫」「1864 起」这些
 * **不是逐字原文**的条目 —— 标了, 模型才知道哪几行不能当经典引出去。
 */
const FENGSHUI_INTERPRETIVE_TAG = '〔此条为盘古推导, 非查法原文〕';

/** 出处标签: 这一层的真源是哪几份课件。 */
const FENGSHUI_SOURCE_LABEL = '风水查法资料 (课程资料, 不随公开版)';

/**
 * 把五块串成一次「一个人 + 一套房 + 一个年份」的完整排盘。
 *
 * @param {object} input
 * @param {number} input.year       出生年(公历)
 * @param {'m'|'f'} input.gender    性别
 * @param {string} [input.sittingMountain] 坐山(壬子癸…24 山之一), 给了才算宅卦
 * @param {string} [input.sitting] 坐山的**自由写法** —— 「坐北向南」「子山午向」「坎」都行
 *        (走 `zhaiGua.parseSitting` 解析; `sittingMountain` 是它的严格版)
 * @param {number} [input.houseYear] 房屋建造/入伙年, 用来定宅运
 */
function fengshuiProfile(input) {
  const src = input || {};
  const out = { ok: true, steps: [] };

  // ⚠️ 年**和性别**都要在, 才排命卦。
  //   只看 year 的话, 缺性别会把 mingGua 推进去 → 它现在会抛错(第 69 批修的),
  //   整次调用挂掉 ⇒ 主人连坐山/宅运那部分也拿不到。
  //   ⇒ 缺性别就**跳过命卦这一项**, 别的照出(缺料不编, 也不因为缺一项就全盘报废)。
  if (src.year !== undefined && src.year !== null && src.gender) {
    const ming = mingGua.mingGua(src.year, src.gender);
    out.ming_gua = ming;
    out.steps.push('ming_gua: ' + ming.label + '(' + ming.group + ')');
  } else {
    out.ming_gua = null;
    out.steps.push('ming_gua: 缺出生年, 跳过');
  }

  // 坐山: 优先用自由写法 `sitting`, 退化到严格版 `sittingMountain`。
  //   ⚠️ 为什么要两种: 主人不会拿着罗盘说话 —— 「我家坐北朝南」比「壬山」常见得多。
  //   而 `sittingMountain` 留着, 是因为**查法资料的对账**走的是严格山名那条路。
  const sittingInput = src.sitting || src.sittingMountain;
  if (sittingInput) {
    const parsed = zhaiGua.parseSitting(sittingInput);
    if (!parsed.ok) {
      out.zhai_gua = { ok: false, input: parsed.input, reason: parsed.reason, need: parsed.need };
      out.steps.push('zhai_gua: ' + parsed.reason);
    } else {
      // ⚠️ 用 zhaiGuaByGua, **不是** zhaiGua(parsed.gua):
      //   zhaiGua() 的键是山名, 拿卦名去查必然查不到 ⇒ gua: undefined,
      //   而且**不报错** —— 后面照常往下走, 输出一份「undefined宅(undefined)」的盘。
      //   这种错不崩不红, 只是内容是假的 ⇒ 最难查的一类。
      const zhai = zhaiGua.zhaiGuaByGua(parsed.gua);
      // 把「怎么解出来的」带出去 —— 模型必须知道这是「按朝向反推的」还是「山名对上的」。
      zhai.how = parsed.how;
      zhai.note = parsed.note || null;
      zhai.mountain = parsed.mountain;
      out.zhai_gua = zhai;
      out.steps.push('zhai_gua: ' + parsed.input + ' → ' + zhai.gua
        + '宅(' + zhai.group + ') [' + parsed.how + ']');
    }
  } else {
    out.zhai_gua = null;
    out.steps.push('zhai_gua: 缺坐山, 跳过');
  }

  // 大游年: 宅卦优先, 没有宅卦就用命卦(查法资料两套都能起盘)
  const plateGua = (out.zhai_gua && out.zhai_gua.ok) ? out.zhai_gua.gua
    : (out.ming_gua ? out.ming_gua.gua : null);
  if (plateGua) {
    out.dayun = dayunGeometry.dayunPlate(plateGua);
    out.steps.push('dayun: 以' + (out.zhai_gua && out.zhai_gua.ok ? '宅卦' : '命卦')
      + plateGua + '起盘');
    out.siYao = siyao.siYao(plateGua);
  } else {
    out.dayun = null;
    out.siYao = null;
    out.steps.push('dayun: 没有可用卦, 跳过');
  }

  // 宅命相配
  if (out.ming_gua && out.zhai_gua && out.zhai_gua.ok) {
    out.match = dayunGeometry.matchGua(out.ming_gua.group, out.zhai_gua.group);
    out.steps.push('match: ' + out.ming_gua.group + ' × ' + out.zhai_gua.group
      + ' → ' + out.match.verdict);
  } else {
    out.match = null;
    out.steps.push('match: 缺命卦或宅卦, 跳过');
  }

  if (src.houseYear !== undefined && src.houseYear !== null) {
    out.house_yun = jiuyun.yunOf(src.houseYear);
    out.steps.push('house_yun: ' + (out.house_yun.ok ? out.house_yun.label : out.house_yun.reason));
  } else {
    out.house_yun = null;
  }

  return out;
}

module.exports = {
  ming_gua: mingGua,
  zhai_gua: zhaiGua,
  dayun_geometry: dayunGeometry,
  siyao: siyao,
  jiuyun: jiuyun,
  fengshuiProfile,
  FENGSHUI_TAG,
  FENGSHUI_INTERPRETIVE_TAG,
  FENGSHUI_SOURCE_LABEL,
};
