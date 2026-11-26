/**
 * Pangu · 64i Layer
 * bagua_annotations/najia.js
 *
 * 纳甲层 —— 卦/爻接干支的那座桥 (2026-10-22 第三十三批)
 *
 * ═══════════════════════════════════════════════════════════════
 * 先说这个模块存在的理由: 它是「64卦+6爻」那一层**唯一缺的零件**
 * ═══════════════════════════════════════════════════════════════
 *
 *   老板问过: 「什么时候用阴阳五行八卦, 什么时候 64卦+6爻, 什么时候串起来用？」
 *   串起来的那一下, 就是**纳甲**: 纳甲把卦/爻接到干支五行上,
 *   干支五行才有得令失令、生克强弱, 六亲才立得起来。
 *
 *   而 2026-10-22 实查发现: 六爻层此前**一根干支都没有**。
 *   `64i/hexagrams.js` 里那个 `najia` 字段(名字像纳甲)其实**不是纳甲表** ——
 *   详见下面「§三、旧 najia 字段审计」。它在生产输出里被当成纳甲讲给用户。
 *
 * ═══════════════════════════════════════════════════════════════
 * §一、装卦纳甲的**规则**(规则本身也要有出处, 不能凭印象)
 * ═══════════════════════════════════════════════════════════════
 *
 *   ① 八宫纳甲天干: 每个卦(八卦)纳一到两个天干
 *      出处: /Users/you/Desktop/course-source
 *        「天干卦象（八卦 甲壬为乾，乙癸为坤，丙艮、丁兑、戊坎、己离、
 *          庚震、辛巽 纳甲）」
 *        —— 乾坤各两个(甲内壬外 / 乙内癸外), 其余六卦各一个(内外同干)。
 *
 *   ② 爻级地支: **8/8 卦齐全** (第 41 批补齐)
 *      本地文本真源只给了乾、坤两卦:
 *        出处: /Users/you/Desktop/course-source
 *          阳德条: 「阳德是乾卦六爻的纳甲，乾六爻自初爻至上面爻之爻辰为
 *                    『子寅辰午申戌』」
 *          阴德条: 「阴德是[坤]卦六爻之纳甲，[坤]卦自初爻至上面爻之爻辰为
 *                    『未巳卯丑亥酉』」
 *        ⚠️ 该文件 OCR 有损: 「刊卦」= 「坤卦」、「红为母」= 「坤为母」。
 *          干支序列本身清晰可读, 不受影响; 但引用时要说明。
 *
 *      其余六卦(震巽坎离艮兑)本地全库无出处(md/txt 279 篇 + 96 个 PDF
 *      文本层 + 8 本扫描件 OCR —— 全是八字书, 纳甲表不在其中),
 *      ⇒ 第 41 批从**外部**取, 走**四源交叉验证**
 *      (详见同目录 `najia_crosscheck.js`, 判据全部可复算):
 *        · 八卦表 8/8: 来源 A 的纳甲图 vs 来源 B 的 BAGUA_NAZHI —— 逐字相同
 *          (唯一差别: A 用俗字「戍」, 归一化后 0 差异)
 *        · 装卦规则: 来源 C 的 64 卦×6 爻 = **384/384 格**逐格吻合
 *          「内三爻取下卦纳甲前3支、外三爻取上卦纳甲后3支」
 *        · 世应/宫归属: 与本地 jingfang_bagong.js **64/64 相同**
 *        · 来源 A 的 64 卦全图有 **5 处**个别格抄错(已按 B/C 裁决并留档)
 *
 *   ③ 装卦拼装规则: 内三爻取**下卦**的纳甲, 外三爻取**上卦**的纳甲
 *      这条**不是抄来的**, 是从上面两条真源**验出来**的:
 *        乾卦(乾下乾上) → 甲+子寅辰 / 壬+午申戌
 *        坤卦(坤下坤上) → 乙+未巳卯 / 癸+丑亥酉
 *      两例都与真源六爻地支逐字对得上, 且天干内外分明(乾甲壬/坤乙癸)。
 *      ⇒ 规则成立, 且在**仅有两例可验**的情况下两例全中。
 *
 * ═══════════════════════════════════════════════════════════════
 * §二、覆盖范围 —— 说清楚, 不含混 (第 41 批起)
 * ═══════════════════════════════════════════════════════════════
 *
 *   天干: 8/8 卦齐全 ✓
 *   地支: **8/8 卦齐全** ✓ (第 41 批补齐, 四源交叉验证)
 *   ⇒ 完整装卦(64卦×6爻) **全部 384 个爻位都能装出来**
 *   ⇒ 六亲层的覆盖率也随之从 96/384 → **384/384**
 *
 * ═══════════════════════════════════════════════════════════════
 * §三、旧 `najia` 字段审计 —— 它**不是**纳甲表
 * ═══════════════════════════════════════════════════════════════
 *
 *   `64i/hexagrams.js` 每卦有个 `najia: {tiangan, dianzhi}`。实测:
 *
 *     · 它是**天干按 10 循环 × 地支按 12 循环**的 60 甲子机械序列, 按 id 排
 *       (乾甲子 坤乙丑 屯丙寅 蒙丁卯 …), 64 卦只有 60 种, id1 与 id61 完全相同
 *     · **同下卦组内首爻全部 8 组都不唯一** —— 而京房装卦纳甲的**必要条件**
 *       就是「初爻干支只由下卦决定」(内三爻取下卦的纳甲)
 *       ⇒ 8/8 组违反 ⇒ **结构上不可能是京房纳甲**
 *     · 真源树里**没有** 64 卦纳甲表 ⇒ 没有出处
 *
 *   而它在生产里被当纳甲讲:
 *     · `modules/gua_answer_gate.js` 64卦事实卡: 「…，纳甲 甲子(本表只有纳甲首爻一柱…)」
 *       —— 这行紧跟着「卦序/爻辞一律以上面 64i 为准, 禁止凭记忆另写」,
 *         模型会当**权威真值**采信
 *     · `modules/skill_runtime.js` 「京房：天干+地支」
 *
 *   ⇒ 本模块把真相做成**可查的数据 + 自检**, 不靠注释。
 */

'use strict';

const path = require('path');

const HEXAGRAMS = require(path.join(__dirname, '..', 'hexagrams.js')).HEXAGRAMS;
// 地支五行/阴阳 —— 复用八字层那一份, **不重抄**(铁律: 一份东西抄四遍 = 迟早只改其中一份)
const _ZHI = require(path.join(__dirname, '..', 'bazi', 'zhis_relations.js'));
const ZHI_WUXING = _ZHI.WUXING;
const ZHI_YINYANG = _ZHI.YIN_YANG;
// 第 41 批: 纳甲四源交叉验证(判据全部可复算, 见同目录 najia_crosscheck.js)
const _crosscheck = require(path.join(__dirname, 'najia_crosscheck.js'));

// ============================================================
// §一  八宫纳甲天干 (8/8, 真源)
// ============================================================

/**
 * 每个卦纳的天干。`inner` = 内卦(下三爻)用, `outer` = 外卦(上三爻)用。
 *
 * 真源: 梅花易数课外阅读资料(白话解释).txt
 *   「甲壬为乾，乙癸为坤，丙艮、丁兑、戊坎、己离、庚震、辛巽」
 *
 * 乾坤各两个天干(甲内壬外 / 乙内癸外), 其余六卦各一个 —— 那个卦内外同干。
 */
const JINGFANG_TIANGAN = Object.freeze({
  乾: Object.freeze({ inner: '甲', outer: '壬' }),
  坤: Object.freeze({ inner: '乙', outer: '癸' }),
  艮: Object.freeze({ inner: '丙', outer: '丙' }),
  兑: Object.freeze({ inner: '丁', outer: '丁' }),
  坎: Object.freeze({ inner: '戊', outer: '戊' }),
  离: Object.freeze({ inner: '己', outer: '己' }),
  震: Object.freeze({ inner: '庚', outer: '庚' }),
  巽: Object.freeze({ inner: '辛', outer: '辛' }),
});

// ============================================================
// §一  爻级地支 (8/8 —— 第 41 批补齐)
// ============================================================

/**
 * 每个卦六爻的地支(初爻→上爻)。
 *
 * 依据分两档, 都要说清:
 *   · 乾、坤: **本地文本真源**(<course-source> 阳德条/阴德条) —— 原文直给
 *   · 震巽坎离艮兑: **外部四源交叉验证**(第 41 批) ——
 *     本地全库无出处, 从三个互不相干的外部实现交叉验证而来,
 *     判据与裁决过程见同目录 `najia_crosscheck.js`(全部可复算)
 *
 * ⚠️ 这张表**不许**再改坏: 它是六亲、旺衰、用神的共同地基。
 *   改动的判据在 `assertNajia()` 里(启动即炸), 交叉验证在 `najia_crosscheck.js`。
 */
const JINGFANG_DIZHI = Object.freeze({
  乾: Object.freeze(['子', '寅', '辰', '午', '申', '戌']),
  坤: Object.freeze(['未', '巳', '卯', '丑', '亥', '酉']),
  震: Object.freeze(['子', '寅', '辰', '午', '申', '戌']),
  巽: Object.freeze(['丑', '亥', '酉', '未', '巳', '卯']),
  坎: Object.freeze(['寅', '辰', '午', '申', '戌', '子']),
  离: Object.freeze(['卯', '丑', '亥', '酉', '未', '巳']),
  艮: Object.freeze(['辰', '午', '申', '戌', '子', '寅']),
  兑: Object.freeze(['巳', '卯', '丑', '亥', '酉', '未']),
});

/**
 * 八个卦各自的地支**出处** —— 逐个说清, 别只写一句「有」。
 *
 * ⚠️ 为什么要按卦标出处: 术数数据最容易出的事是「填了但说不出哪来的」。
 *   哪天这张表被改坏, 出处能告诉人「这个值是哪来的、该找谁核对」。
 *
 * ⚠️ 名字沿用 `DIZHI_MISSING_REASON` 是**历史包袱**(第 33 批它是「缺失原因」,
 *   第 41 批补齐后它装的是「出处」)。改名会砸既有调用方, 所以留着,
 *   但语义已变 —— 新代码请用 `DIZHI_SOURCE`。
 */
const DIZHI_SOURCE = Object.freeze({
  乾: '本地文本真源: <course-source>.txt 阳德条「乾六爻自初爻至上面爻之爻辰为『子寅辰午申戌』」'
    + '(OCR 有损: 「刊卦」=「坤卦」; 干支序列本身清晰)',
  坤: '本地文本真源: <course-source>.txt 阴德条「[坤]卦自初爻至上面爻之爻辰为『未巳卯丑亥酉』」'
    + '(OCR 有损: 「红为母」=「坤为母」; 干支序列本身清晰)',
  震: '外部四源交叉验证(第 41 批): 来源A 纳甲图 + 来源B BAGUA_NAZHI + 来源C 64卦装卦 + '
    + '十六字口诀「乾震起子」; 本地文本真源未收录震卦六爻地支',
  巽: '外部四源交叉验证(第 41 批): 来源A 纳甲图 + 来源B BAGUA_NAZHI + 来源C 64卦装卦 + '
    + '十六字口诀「巽丑未坤」; 本地文本真源未收录巽卦六爻地支',
  坎: '外部四源交叉验证(第 41 批): 来源A 纳甲图 + 来源B BAGUA_NAZHI + 来源C 64卦装卦 + '
    + '十六字口诀「坎寅艮辰」; 本地文本真源未收录坎卦六爻地支',
  离: '外部四源交叉验证(第 41 批): 来源A 纳甲图 + 来源B BAGUA_NAZHI + 来源C 64卦装卦 + '
    + '十六字口诀「离卯兑巳」; 本地文本真源未收录离卦六爻地支',
  艮: '外部四源交叉验证(第 41 批): 来源A 纳甲图 + 来源B BAGUA_NAZHI + 来源C 64卦装卦 + '
    + '十六字口诀「坎寅艮辰」; 本地文本真源未收录艮卦六爻地支',
  兑: '外部四源交叉验证(第 41 批): 来源A 纳甲图 + 来源B BAGUA_NAZHI + 来源C 64卦装卦 + '
    + '十六字口诀「离卯兑巳」; 本地文本真源未收录兑卦六爻地支',
});

/** 别名: 旧名保留(语义已变成「出处」, 见上面的说明) */
const DIZHI_MISSING_REASON = DIZHI_SOURCE;

// ============================================================
// §一  口径常量 —— 跟着数据一起出参
// ============================================================

const NAJIA_BASIS = Object.freeze({
  layer: '卦层(纳甲) → 六爻层(干支)',
  tiangan_source: '梅花易数课外阅读资料(白话解释).txt「甲壬为乾, 乙癸为坤, 丙艮、丁兑、戊坎、己离、庚震、辛巽」',
  dizhi_source: '乾、坤: 本地文本真源(<course-source>.txt 阳德条/阴德条); '
    + '震巽坎离艮兑: 外部四源交叉验证(第 41 批, 见 najia_crosscheck.js)',
  zhi_wuxing_source: '64i/bazi/zhis_relations.js(复用, 不重抄)',
  tiangan_covered: 8,        // 八卦纳甲天干 8/8
  dizhi_covered: 8,          // 爻级地支 8/8 (第 41 批补齐)
  // 交叉验证的实测结论 —— 数字不是手写的, 每次都由 crosscheck 现算
  get crosscheck_cells() { return _crosscheck ? _crosscheck.cells : null; },
  get crosscheck_bian() { return _crosscheck ? _crosscheck.bian_checked : null; },
  get crosscheck_ok() { return _crosscheck ? _crosscheck.ok : null; },
  get crosscheck_summary() { return _crosscheck ? _crosscheck.summary : null; },
  // 来源 A 的 5 处冲突 —— 留档, 免得以后又有人拿 A 的值来「纠正」
  source_a_conflicts: '遁2爻(巳/午)、观4爻(戌/未)、剥6爻(卯/寅)、旅3爻(酉/申)、革5爻(申/酉) —— 采纳 B/C',
  source_a_conflict_count: 5,
  // ⚠️ 下面两个数**不写死** —— 从表算。
  //   写死过一次: 当时手写「2 = 乾、坤」, 跟表算出来的不一致 ——
  //   泰(上坤下乾)、否(上乾下坤) 的上下卦都是乾/坤, 地支全有真源, 装得出来,
  //   真正的可装卦集合是 {乾, 泰, 否, 坤} 4 个。
  //   教训跟六亲那次一样: **写死的数字会跟表漂, 而且没人发现**。
  //   用 getter 是为了在模块初始化之后再算 —— 表还没建好时算不了。
  get hexagram_fully_loadable() { return loadableGuaIds().length; },
  get hexagram_loadable_list() {
    return loadableGuaIds().map(id => id + ' ' + (BY_ID.get(id) ? BY_ID.get(id).name : '?'));
  },
  hexagram_total: 64,
  // 装卦拼装规则 —— **这是规则, 不是真源原句**。
  //   规则: 内三爻(初/二/三)取**下卦**纳甲(内天干 + 该卦地支的前三支);
  //         外三爻(四/五/上)取**上卦**纳甲(外天干 + 该卦地支的后三支)。
  //   依据: ①「甲壬为乾」表明同一卦有**内、外两个天干**(乾内甲外壬);
  //        ② 乾坤两卦的六爻地支串(子寅辰午申戌 / 未巳卯丑亥酉)都是
  //           「前三支配内干、后三支配外干」的结构;
  //        ③ 京房装卦通则「内卦纳甲、外卦纳甲」。
  //   ⚠️ 真源里**没有**逐字写出这条通则 —— 纯卦例(乾/坤)里内外同卦, 推不出来;
  //     跨卦的泰/否 两例是**按规则外推**的, 不是真源直给。标出来, 别混着说。
  zhuanggua_rule: '内三爻取下卦纳甲(内天干+该卦地支前三支), 外三爻取上卦纳甲(外天干+该卦地支后三支)',
  zhuanggua_rule_is_explicit_in_source: false,
  zhuanggua_rule_basis: '「甲壬为乾/乙癸为坤」给出内外天干之分 + 乾坤六爻地支串的 3+3 结构 + 京房装卦通则',
  // ★ 旧字段的真相 —— 生产输出曾把它当纳甲讲
  legacy_field: '64i/hexagrams.js 的 najia',
  legacy_field_is_najia: false,
  legacy_field_kind: 'ganzhi_60_cycle_by_gua_order',
  legacy_field_note: '它是天干10循环×地支12循环的60甲子机械序列, 按 id(文王序)排, 与卦的'
    + '上下卦/八宫/阴阳全无关; 8/8 个同下卦组内首爻都不唯一, 违反京房装卦纳甲的必要条件, '
    + '且真源无出处 ⇒ **不是纳甲表**, 别当纳甲讲',
  reject_as_najia: [
    '64i/hexagrams.js 的 najia 字段 —— 不是纳甲表(见 legacy_field_note)',
    '三命通会 的「纳音与《易》纳甲同法」 —— 讲的是六十甲子纳音, 不是装卦纳甲',
    '梅花易数 八卦纳支法一/法二 —— 起卦用的纳支, 不是装卦纳甲',
  ],
});

// ============================================================
// 装卦
// ============================================================

/** 卦 id → 卦对象 */
const BY_ID = new Map(HEXAGRAMS.map(h => [h.id, h]));

/**
 * 某一爻的装卦干支。
 *
 * 规则: 内三爻(初/二/三)取**下卦**的纳甲(内天干 + 该卦地支的前三支);
 *       外三爻(四/五/上)取**上卦**的纳甲(外天干 + 该卦地支的后三支)。
 *
 * @param {number} guaId 1..64
 * @param {number} pos 1..6 (初爻=1)
 * @returns {{ok:true, ganzhi:string, tiangan:string, dianzhi:string,
 *            wuxing:string, yin_yang:string, pos:number}
 *          |{ok:false, error:{code:string, message:string}}}
 */
function getYaoGanzhi(guaId, pos) {
  return getYaoGanzhiWithTable(JINGFANG_DIZHI, guaId, pos);
}

/**
 * 装卦的**纯函数**版本 —— 地支表可注入。
 *
 * ⚠️ 为什么要留这个口子 (2026-10-22 第 41 批):
 *   第 41 批把八卦地支补齐后, 真实数据**没有缺口**了 ⇒ 「装不出时必须
 *   显式 null + 带原因」这条性质, 在真实数据上**再也走不到**。
 *   如果只靠真实数据测它, 这条性质会在补齐的那一刻**静默失效**,
 *   哪天表被改坏, 没人发现(踩坑日志: 旧负例会静默失效)。
 *   ⇒ 把「表」变成参数, 测试就能造出缺口来验那条路径。
 *
 *   生产入口 `getYaoGanzhi()` 走的就是它, 传的是同一张表 —— 行为完全一致。
 *
 * @param {Object} dizhiTable 八卦 → 六爻地支
 * @param {number} guaId 1..64
 * @param {number} pos 1..6 (初爻=1)
 */
function getYaoGanzhiWithTable(dizhiTable, guaId, pos) {
  const h = BY_ID.get(guaId);
  if (!h) {
    return { ok: false, error: { code: 'NO_GUA', message: '没有这个卦序: ' + guaId } };
  }
  const p = Number(pos);
  if (!Number.isInteger(p) || p < 1 || p > 6) {
    return { ok: false, error: { code: 'BAD_POS', message: '爻位应为 1..6, 实为 ' + pos } };
  }
  const lower = h.trigrams.lower_name;
  const upper = h.trigrams.upper_name;
  const isInner = p <= 3;
  const trigram = isInner ? lower : upper;
  const tg = JINGFANG_TIANGAN[trigram];
  const dz = dizhiTable[trigram];
  if (!tg) {
    return {
      ok: false,
      error: {
        code: 'NO_TIANGAN',
        message: '「' + trigram + '」的纳甲天干没有 —— 表里没有八卦纳甲天干',
      },
    };
  }
  if (!dz) {
    return {
      ok: false,
      error: {
        code: 'NO_DIZHI',
        message: '「' + trigram + '」的六爻地支没有真源: '
          + (DIZHI_SOURCE[trigram] || '真源未收录')
          + ' ⇒ 装不出干支, 别自己推',
      },
    };
  }
  const branch = isInner ? dz[p - 1] : dz[p - 1];
  const stem = isInner ? tg.inner : tg.outer;
  return {
    ok: true,
    pos: p,
    ganzhi: stem + branch,
    tiangan: stem,
    dianzhi: branch,
    wuxing: ZHI_WUXING[branch] || null,
    yin_yang: ZHI_YINYANG[branch] || null,
  };
}

/**
 * 某卦能不能完整装出六爻干支。
 * @returns {{loadable:boolean, missing:Array<string>, reason:string|null}}
 */
function getGuaNajiaCoverage(guaId) {
  return getGuaNajiaCoverageWithTable(JINGFANG_DIZHI, guaId);
}

/**
 * 覆盖率判定的**纯函数**版本 —— 地支表可注入(同 getYaoGanzhiWithTable 的理由:
 * 真实数据补齐后, 「缺口」这条路径在真实数据上走不到, 负例会静默失效)。
 */
function getGuaNajiaCoverageWithTable(dizhiTable, guaId) {
  const h = BY_ID.get(guaId);
  if (!h) return { loadable: false, missing: [], reason: '没有这个卦序: ' + guaId };
  const need = [h.trigrams.lower_name, h.trigrams.upper_name];
  const missing = [];
  for (const t of need) {
    if (!dizhiTable[t]) missing.push(t);
  }
  const uniq = Array.from(new Set(missing));
  return {
    loadable: uniq.length === 0,
    missing: uniq,
    reason: uniq.length
      ? '这些卦的六爻地支没有出处: ' + uniq.join('、') + ' ⇒ 装不出完整六爻干支'
      : null,
  };
}

/**
 * 哪些卦能完整装出六爻干支 —— **从表算, 不写死**。
 *
 * 判据: 上下卦的地支都有出处 ⇒ 卦的上下卦都落在「有地支的卦」里。
 * 第 41 批起八卦全有地支 ⇒ **64 卦全部能装**。
 *
 * ⚠️ 为什么不能手写这个集合: 手写过「2 = 乾、坤」, 跟表算出来的不一致 ——
 *   泰、否 的装卦只用到乾/坤的纳甲, 地支全有真源, 装得出来。
 *   写死的数字跟表漂了没人发现, 所以这里一律从表算。
 */
function loadableGuaIds() {
  const ids = [];
  for (const h of HEXAGRAMS) {
    if (getGuaNajiaCoverage(h.id).loadable) ids.push(h.id);
  }
  return ids;
}

/**
 * 装卦覆盖统计 —— **逐爻**统计, 从表算, 不写死。
 *
 * ⚠️ 为什么必须逐爻、不能按整卦 (2026-10-22 第 36 批当场撞出来的):
 *   纳甲是**内三爻取下卦、外三爻取上卦** —— 只要卦的**一半**有地支,
 *   那一半的三爻就**有据可查**。按整卦统计会把半边能装的卦**整个**
 *   记成「没有」—— 缺口被夸大一倍, 比缺口本身更危险。
 *
 *   第 41 批补齐八卦地支后: 覆盖 **384/384 爻位, 64/64 卦六爻齐全**。
 *   逐爻统计仍然保留 —— 口径不因为「现在满了」就改成按卦算,
 *   万一哪天又有缺口, 逐爻的数才说得出真话。
 *
 * 这条统计是六亲覆盖率的唯一口径来源(`liu_qin.js` 的 LIU_QIN_BASIS.coverage
 * 从这里取), 不许各处手写 —— 写死的数会跟表漂, 而且没人发现。
 *
 * @returns {{yao_total:number, yao_loadable:number, gua_total:number,
 *            gua_full:number[], gua_partial:number[], gua_none:number[],
 *            summary:string}}
 */
function getCoverageStats() {
  const gua_full = [];
  const gua_partial = [];
  const gua_none = [];
  let yao_loadable = 0;
  let yao_total = 0;
  for (const h of HEXAGRAMS) {
    let n = 0;
    for (let p = 1; p <= 6; p++) {
      yao_total++;
      if (getYaoGanzhi(h.id, p).ok) { yao_loadable++; n++; }
    }
    if (n === 6) gua_full.push(h.id);
    else if (n > 0) gua_partial.push(h.id);
    else gua_none.push(h.id);
  }
  return {
    yao_total,
    yao_loadable,
    gua_total: HEXAGRAMS.length,
    gua_full,
    gua_partial,
    gua_none,
    summary: `装得出纳甲的爻位 **${yao_loadable}/${yao_total}**; `
      + `其中 ${gua_full.length}/${HEXAGRAMS.length} 卦六爻齐全`
      + (gua_partial.length
        ? `, ${gua_partial.length} 卦半边能装(内三爻取下卦、外三爻取上卦), `
        : ', ')
      + (gua_none.length
        ? `${gua_none.length} 卦一爻都装不出`
        : '无装不出的卦')
      + (gua_none.length === 0 && gua_partial.length === 0
        ? '(八卦纳甲地支已全, 四源交叉验证通过)'
        : ''),
  };
}

// ============================================================
// §三  旧 najia 字段审计
// ============================================================

/**
 * 审计 `64i/hexagrams.js` 的旧 `najia` 字段 —— 三条机械判据, 全部**不依赖外部表**。
 *
 *   ① 60 循环性: 干支是否严格由 id 决定(天干10循环×地支12循环)?
 *      —— 确认「它是什么」
 *   ② 京房必要条件: 同一**下卦**的卦, 初爻干支必须相同
 *      (内三爻取下卦的纳甲 ⇒ 初爻只由下卦决定) ⇒ 违反即**不可能是京房纳甲**
 *   ③ 与卦结构无关: 干支跟八宫/上下卦/阴阳都没有对应关系
 */
function auditLegacyNajia(hexagrams) {
  const list = hexagrams || HEXAGRAMS;
  const GAN = '甲乙丙丁戊己庚辛壬癸';
  const ZHI = '子丑寅卯辰巳午未申酉戌亥';

  // ① 60 循环性
  let cycleOk = true;
  let firstMismatch = null;
  for (let i = 0; i < list.length; i++) {
    const h = list[i];
    const want = { t: GAN[i % 10], z: ZHI[i % 12] };
    if (!h.najia || h.najia.tiangan !== want.t || h.najia.dianzhi !== want.z) {
      cycleOk = false;
      if (firstMismatch === null) firstMismatch = i + 1;
    }
  }

  // ② 京房必要条件: 同下卦组内初爻是否唯一
  const groups = new Map();
  for (const h of list) {
    const k = h.trigrams.lower_name;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(h);
  }
  const groupViolations = [];
  for (const [k, g] of groups) {
    const vals = new Set(g.map(h => h.najia.tiangan + h.najia.dianzhi));
    if (vals.size > 1) {
      groupViolations.push({ lower: k, count: g.length, distinct: vals.size, values: Array.from(vals) });
    }
  }

  // ③ 与卦结构无关: 干支跟八宫有没有对应(京房纳甲至少跟八宫/上下卦有确定关系)
  const distinctPairs = new Set(list.map(h => h.najia.tiangan + h.najia.dianzhi));

  return {
    is_60_cycle: cycleOk,
    first_mismatch: firstMismatch,
    lower_groups: groups.size,
    jingfang_violations: groupViolations,
    jingfang_necessary_property_holds: groupViolations.length === 0,
    distinct_pairs: distinctPairs.size,
    verdict: groupViolations.length === 0
      ? '同下卦组内初爻唯一 —— 符合京房装卦纳甲的必要条件(需另行核出处)'
      : '同下卦组内初爻不唯一(' + groupViolations.length + '/' + groups.size
        + ' 组) ⇒ 结构上不可能是京房装卦纳甲',
  };
}

// ============================================================
// 自检 —— 越界即抛, 接进启动链
// ============================================================

/**
 * 这道自检要咬三件事:
 *
 *   ① **天干表与真源逐条对得上** —— 8 条, 少一条/多一条都报
 *   ② **地支表与真源逐条对得上** —— 乾、坤各 6 支, 顺序也不能错
 *      (顺序错 = 装卦全错, 而且**不会报错**, 只是静默给出另一卦)
 *   ③ **装卦拼装结果与真源六爻地支一致** —— 拿乾、坤两个卦跑一遍,
 *      装出来的六爻干支必须与真源原文**逐字相同**
 *
 * ⚠️ 另加一条**反向**判据: 旧 najia 字段**必须**不满足京房必要条件。
 *   为什么要有这条反向的: 万一哪天有人把真京房纳甲表灌进 `hexagrams.js`,
 *   那时 `najia` 就**真的**是纳甲了 —— 口径标记(`legacy_field_is_najia: false`)
 *   必须跟着改, 而且要有人记得改。这条自检就是那个"有人记得"的机制。
 */
function assertNajia(opts = {}) {
  const problems = [];

  // ① 天干表
  const TIANGAN_TRUTH = {
    乾: { inner: '甲', outer: '壬' }, 坤: { inner: '乙', outer: '癸' },
    艮: { inner: '丙', outer: '丙' }, 兑: { inner: '丁', outer: '丁' },
    坎: { inner: '戊', outer: '戊' }, 离: { inner: '己', outer: '己' },
    震: { inner: '庚', outer: '庚' }, 巽: { inner: '辛', outer: '辛' },
  };
  const tgKeys = Object.keys(JINGFANG_TIANGAN).sort();
  const truthKeys = Object.keys(TIANGAN_TRUTH).sort();
  if (tgKeys.join(',') !== truthKeys.join(',')) {
    problems.push('八卦纳甲天干表应覆盖 8 卦, 实为 ' + tgKeys.length + ' 卦: ' + tgKeys.join(','));
  }
  for (const k of truthKeys) {
    const got = JINGFANG_TIANGAN[k];
    if (!got || got.inner !== TIANGAN_TRUTH[k].inner || got.outer !== TIANGAN_TRUTH[k].outer) {
      problems.push('「' + k + '」的纳甲天干与真源不符: 应为 '
        + TIANGAN_TRUTH[k].inner + '/' + TIANGAN_TRUTH[k].outer
        + ', 实为 ' + (got ? got.inner + '/' + got.outer : '无'));
    }
  }

  // ② 地支表
  const DIZHI_TRUTH = {
    乾: ['子', '寅', '辰', '午', '申', '戌'],
    坤: ['未', '巳', '卯', '丑', '亥', '酉'],
  };
  for (const k of Object.keys(DIZHI_TRUTH)) {
    const got = JINGFANG_DIZHI[k];
    if (!got) { problems.push('「' + k + '」的六爻地支丢了'); continue; }
    if (got.join('') !== DIZHI_TRUTH[k].join('')) {
      problems.push('「' + k + '」的六爻地支与真源不符: 应为 ' + DIZHI_TRUTH[k].join('')
        + ', 实为 ' + got.join('') + '(顺序错 = 装卦全错且不报错)');
    }
  }
  // ②b 八卦地支 8/8 齐全, 且每个卦都要有**出处**。
  //   ⚠️ 第 41 批之前这里断言「震巽坎离艮兑必须是 null」——
  //     现在六卦都有外部交叉验证的出处, 那条断言反了, 改成「必须 8/8 且各有出处」。
  //   为什么仍要逐卦标出处: 术数数据最容易出的事是「填了但说不出哪来的」。
  const ALL_GUA = ['乾', '坤', '震', '巽', '坎', '离', '艮', '兑'];
  for (const k of ALL_GUA) {
    const got = JINGFANG_DIZHI[k];
    if (!got || got.length !== 6) {
      problems.push('「' + k + '」的六爻地支应齐全(6 支), 实为: '
        + (got ? got.length + ' 支' : 'null'));
      continue;
    }
    if (!DIZHI_SOURCE[k] || DIZHI_SOURCE[k].length < 10) {
      problems.push('「' + k + '」的地支没有出处 —— 数据要能说出是哪来的, 不许只写 null');
    }
  }
  // ②c 地支表与**外部来源**逐字一致(四源交叉验证)。
  //   这是最硬的那道闸: 本地表若被改坏, 这里立刻报红; 而且报红时
  //   会指出「哪一格、和哪个来源对不上」。
  const cc = _crosscheck.crosscheckNajiaSources({
    dizhiTable: JINGFANG_DIZHI,
    naganTable: JINGFANG_TIANGAN,
  });
  // ⚠️ 七条判据**逐条**点名跑, 每条的问题各自带判据名。
  //   两个原因, 都不是为了好看:
  //     ① 报错要能说清「哪一条判据咬的」—— 混成一堆的报错, 下一个人
  //        只能从头读一遍才知道是数据错还是规则错。
  //     ② 守卫 D(判据不许有孤岛)的可达性不动点**只跟判据名之间的调用连线走**:
  //        只经 `crosscheckNajiaSources` 一层间接调用, 在守卫眼里等于没人调。
  //        这里在生产自检里逐个点名, 才是真的接在生产数据路上。
  //   `crosscheckNajiaSources` 仍保留 —— 它是汇总口径(cells / summary / 纳干对账)。
  const CC_CHECKS = [
    ['本地文本真源(乾/坤)', () => _crosscheck.checkLocalTextTruth(JINGFANG_DIZHI)],
    ['八卦表结构自洽', () => _crosscheck.checkNajiaStructure(JINGFANG_DIZHI, JINGFANG_TIANGAN)],
    ['64卦×6爻 vs 来源C', () => _crosscheck.check64GuaZhi(JINGFANG_DIZHI).problems],
    ['来源A 冲突已裁决', () => _crosscheck.checkSourceAConflicts(JINGFANG_DIZHI)],
    ['本地结构(卦名/世应/宫)对齐', () => _crosscheck.checkLocalStructureAlignment()],
    ['动爻不改纳支', () => _crosscheck.checkMovingYaoDoesNotChangeNajia(JINGFANG_DIZHI).problems],
    ['纳干 vs 外部来源', () => _crosscheck.checkNaganAgainstSource(JINGFANG_TIANGAN)],
  ];
  const crosscheck_detail = {};
  for (const [label, run] of CC_CHECKS) {
    let found;
    try {
      found = run() || [];
    } catch (e) {
      found = ['判据本身抛异常: ' + (e && e.message)];
    }
    crosscheck_detail[label] = found.length;
    for (const p of found) problems.push('[四源交叉验证·' + label + '] ' + p);
  }

  // ③ 装卦结果与真源六爻地支逐字一致
  for (const [id, name] of [[1, '乾'], [2, '坤']]) {
    const built = [];
    for (let p = 1; p <= 6; p++) {
      const r = getYaoGanzhi(id, p);
      if (!r.ok) { problems.push(name + '卦第' + p + '爻装不出来: ' + r.error.message); break; }
      built.push(r.dianzhi);
    }
    if (built.length === 6) {
      const want = DIZHI_TRUTH[name].join('');
      if (built.join('') !== want) {
        problems.push(name + '卦装出来的六爻地支是 ' + built.join('') + ', 真源是 ' + want);
      }
    }
  }

  // ③b 跨卦的泰、否两例 —— 装卦**规则**外推的结果。
  //   这两个不是真源直给, 是按「内取下卦、外取上卦」推出来的。
  //   断言用**手写的期望值**, 不用函数自己算的 —— 否则是尺子和被测对象同源, 恒真。
  const RULE_CASES = [
    [11, '泰(上坤下乾)', '甲子甲寅甲辰癸丑癸亥癸酉'],
    [12, '否(上乾下坤)', '乙未乙巳乙卯壬午壬申壬戌'],
  ];
  for (const [id, name, want] of RULE_CASES) {
    const built = [];
    for (let p = 1; p <= 6; p++) {
      const r = getYaoGanzhi(id, p);
      if (!r.ok) { problems.push(name + '第' + p + '爻装不出来: ' + r.error.message); break; }
      built.push(r.ganzhi);
    }
    if (built.length === 6 && built.join('') !== want) {
      problems.push(name + '装出来的六爻干支是 ' + built.join('') + ', 应为 ' + want);
    }
  }

  // ③c 「能装卦的到底是哪几个卦」—— **不许手写, 必须跟表一致**。
  //   ⚠️ 第 41 批: 八卦地支补齐后, 64 卦**全部**能装 ⇒ 期望值是 1..64。
  //   但这不代表这条判据没用了 —— 它防的是「哪天有人删掉一卦的地支」或
  //   「多填一卦」: 任何一边动了, 期望值与实算立刻对不上。
  const EXPECT_LOADABLE = [];
  for (let i = 1; i <= 64; i++) EXPECT_LOADABLE.push(i);
  const byTable = loadableGuaIds();
  if (byTable.join(',') !== EXPECT_LOADABLE.join(',')) {
    problems.push('能完整装卦的卦集合应从表算出 1..64(八卦地支已全), 实为 ['
      + byTable.join(',') + ']');
  }
  const trigramsWithDizhi = Object.keys(JINGFANG_DIZHI).filter(k => JINGFANG_DIZHI[k]);
  if (trigramsWithDizhi.sort().join(',') !== ALL_GUA.slice().sort().join(',')) {
    problems.push('有六爻地支的卦应正好是八卦 8 个, 实为: ' + trigramsWithDizhi.join(','));
  }
  // ③d 装卦覆盖**逐爻**统计 —— 两条路算出来要对得上。
  //   (i) 数据侧: getCoverageStats 走 getYaoGanzhi 逐爻数。
  //   (ii) 结构侧: 纳甲是「内三爻取下卦、外三爻取上卦」, 而 64 卦的上下卦
  //        构成一个完整的 8×8 组合(每个卦都出现一次)⇒ 每个卦作为下卦恰好 8 次、
  //        作为上卦恰好 8 次 ⇒ 有地支的 N 个卦贡献 N×8×3×2 个爻位。
  //        八卦全有 ⇒ 8×8×3×2 = **384**。
  //   (ii) **不碰 JINGFANG_DIZHI**, 只用组合结构 —— 跟 (i) 是两条独立的路。
  //   两边对不上就报: 往多了说明有人填了新地支(必须带出处), 往少了说明表坏了。
  const stats = getCoverageStats();
  const trigramsWithDizhiCount = trigramsWithDizhi.length;
  const structural = trigramsWithDizhiCount * 8 * 3 * 2;   // 见上面 (ii)
  if (stats.yao_loadable !== structural) {
    problems.push(
      '装得出纳甲的爻位, 数据侧算 ' + stats.yao_loadable + ', 结构侧算 ' + structural
      + '(' + trigramsWithDizhiCount + ' 个卦有地支 × 8 次作下卦 × 3 爻, 加作上卦同样多)'
      + ' —— 新填的地支必须带出处, 或表被改坏了'
    );
  }
  if (stats.yao_total !== 64 * 6) {
    problems.push('爻位总数应为 384, 实为 ' + stats.yao_total);
  }
  // ④ 口径里的数必须跟表一致(防 getter 跟函数各算各的)
  if (NAJIA_BASIS.hexagram_fully_loadable !== byTable.length) {
    problems.push('口径里的可装卦数 ' + NAJIA_BASIS.hexagram_fully_loadable
      + ' 跟实算的 ' + byTable.length + ' 对不上');
  }

  // ⑤ 反向: 旧 najia 字段必须**不**满足京房必要条件(它确实不满足)
  const audit = auditLegacyNajia(opts.hexagrams);
  if (audit.jingfang_necessary_property_holds) {
    problems.push(
      '旧 najia 字段现在**满足**京房装卦纳甲的必要条件(同下卦组内初爻唯一) —— '
      + '那它可能已经换成了真纳甲表! 口径标记 legacy_field_is_najia / '
      + 'legacy_field_kind 必须跟着改, 且要补真源出处。'
    );
  }
  if (!audit.is_60_cycle) {
    problems.push('旧 najia 字段已经不是「60甲子按卦序机械循环」了 —— '
      + 'legacy_field_kind 的描述过期了, 要改');
  }

  if (problems.length) {
    throw new Error(
      '[najia] 纳甲层自检不通过:\n  ' + problems.join('\n  ')
    );
  }
  return {
    ok: true,
    tiangan_covered: tgKeys.length,
    dizhi_covered: trigramsWithDizhi.length,
    hexagram_loadable: byTable.length,
    hexagram_loadable_ids: byTable,
    crosscheck: {
      ok: cc.ok,
      cells: cc.cells,
      bian_checked: cc.bian_checked,
      summary: cc.summary,
      // 每条判据各报几条 —— 「七条都跑过」和「七条都干净」是两件事,
      // 混在一个 ok 里就看不出是哪一条在扛。
      per_check: crosscheck_detail,
    },
    legacy_audit: audit,
  };
}

module.exports = {
  NAJIA_BASIS,
  JINGFANG_TIANGAN,
  JINGFANG_DIZHI,
  DIZHI_SOURCE,
  DIZHI_MISSING_REASON,
  getYaoGanzhi,
  getYaoGanzhiWithTable,
  getGuaNajiaCoverage,
  getGuaNajiaCoverageWithTable,
  loadableGuaIds,
  getCoverageStats,
  auditLegacyNajia,
  assertNajia,
};
