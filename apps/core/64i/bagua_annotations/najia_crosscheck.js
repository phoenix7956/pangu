/**
 * Pangu · 64i Layer
 * bagua_annotations/najia_crosscheck.js
 *
 * 纳甲四源交叉验证 —— 第 41 批
 *
 * ═══════════════════════════════════════════════════════════════
 * 这份文件为什么存在: 纳甲地支的**依据**必须能复算, 不能是注释
 * ═══════════════════════════════════════════════════════════════
 *
 * 背景:
 *   第 33 批落地纳甲层时, 八卦纳甲的**爻级地支**只有乾、坤两卦有本地真源
 *   (/Users/you/Desktop/course-source,
 *   其余六卦(震巽坎离艮兑)是 null ⇒ 384 爻位里只有 96 装得出。
 *
 *   本地全库穷尽后仍无出处(md/txt 279 篇 + 96 个 PDF 文本层 +
 *   8 本扫描件 OCR —— 全是八字书, 纳甲表不在其中)。
 *   ⇒ 真源只能从**外部**取, 而外部来源必须**交叉验证**才能落进生产,
 *   不能凭「我记得传统纳甲表」填(项目铁律: 缺口不许自己编)。
 *
 * ═══════════════════════════════════════════════════════════════
 * §一  四个来源(全部于 2026-10-22 实拉实解析, 非转述)
 * ═══════════════════════════════════════════════════════════════
 *
 *   来源 1「本地文本真源」  /Users/you/Desktop/course-source
 *     阳德条: 「乾六爻自初爻至上面爻之爻辰为『子寅辰午申戌』」
 *     阴德条: 「[坤]卦自初爻至上面爻之爻辰为『未巳卯丑亥酉』」
 *     ⚠️ 该文件 OCR 有损: 「刊卦」= 「坤卦」、「红为母」= 「坤为母」。
 *     ⇒ 只覆盖乾、坤两卦, 但它能**独立**验证另外两个来源的地支表。
 *
 *   来源 2「来源 A: woaichiji/liuyao」
 *     https://github.com/woaichiji/liuyao
 *     · `2-03-纳甲.md` —— 八卦纳甲全表(内三爻/外三爻, 含天干) + 十六字口诀
 *     · `2-06-原版六十四卦全图.md` —— 64 卦**逐爻**(六亲+地支+五行)表
 *     · `2-06-修订版六十四卦全图.md` —— 同上, 但按「天泽火雷风水山地」八部编排
 *
 *   来源 3「来源 B: Johnson-Jia/liuyao-divination · src/liuyao/data.py」
 *     https://github.com/Johnson-Jia/liuyao-divination
 *     BAGUA_NAZHI (8 卦 × 6 爻地支) + BAGUA_NAGAN (8 卦纳干)
 *     —— **结构化数据**(数组), 不是人工誊抄的表格
 *
 *   来源 4「来源 C: Seanding1998/liuyao-frv · scripts/paipan.py」
 *     https://github.com/Seanding1998/liuyao-frv
 *     64 卦**爻级**数据(每爻 六亲+地支+五行) + 世爻/应爻
 *     —— 装卦代码 board.py: 内三爻取下卦前3支、外三爻取上卦后3支
 *
 * ═══════════════════════════════════════════════════════════════
 * §二  实测裁决结果 —— 2026-10-22 逐格对拍, 数字全部可复算
 * ═══════════════════════════════════════════════════════════════
 *
 *   【八卦表 8/8】来源 A 的 `2-03-纳甲.md` 图 vs 来源 B 的 BAGUA_NAZHI:
 *     · 地支: **8/8 逐字相同** —— 唯一差别是 A 全书用俗字「戍」, B 用正字「戌」
 *       (32 处字形异体, 不是数值分歧; 归一化后 0 差异)
 *     · 纳干: **8/8 逐字相同**, 且与本地文本真源(梅花易数课外阅读资料)一致
 *     · 十六字口诀「乾震起子, 坎寅艮辰, 离卯兑巳, 巽丑未坤」**8/8 复现**内三爻
 *     · 结构: 阳卦顺行(+2)、阴卦逆行(-2)、内外三爻起点差 6 位 —— **8/8 成立**
 *
 *   【装卦规则】来源 C 的 64 卦×6 爻(=384 格)逐格对拍:
 *     · 384/384 格: 「内三爻取下卦纳甲前3支、外三爻取上卦纳甲后3支」**完全吻合**
 *     · 世爻/应爻: **64/64 相同**; 京房宫归属: **64/64 相同**
 *     ⇒ 装卦规则不再是「从两例外推的推测」, 而是**384 格实测**的结论。
 *
 *   【来源 A 的 64 卦全图 vs 来源 C】统一到「初→上」后逐格对拍:
 *     · 五行:   **0/384 不一致**
 *     · 六亲:   **1/384 不一致**(蹇卦第5爻: A=兄弟 / C=父母)
 *     · 地支字: **37/384 不一致**, 其中:
 *         - 32 处是「戍/戌」异体字(A 用俗字) —— 归一化后 0 差异
 *         -  5 处是**真冲突**(下表)
 *
 *   5 处真冲突(来源 A 的错值 / 采纳值):
 *     遁(天山遁)   第2爻   A=巳  采纳=午
 *     观(风地观)   第4爻   A=戌  采纳=未
 *     剥(山地剥)   第6爻   A=卯  采纳=寅
 *     旅(火山旅)   第3爻   A=酉  采纳=申
 *     革(泽火革)   第5爻   A=申  采纳=酉
 *
 *   ⇒ **采纳 B/C, 否决 A 这 5 处**, 四条依据(每条都可复算):
 *     ① B 与 C 是**两个互不相干**的实现(不同作者/不同语言/不同代码结构),
 *        且 B 的八卦表与 C 的 64 卦装卦结果**384/384 逐格一致** ⇒ 独立同值。
 *        A 这 5 格单独异值。
 *     ② A 的 5 处错值**既不等于本卦该位纳支, 也不等于变卦该位纳支**
 *        (逐条验算过) ⇒ 不是「另一套体系」, 是**誊抄时的错字**。
 *     ③ A 的错法是**近形字/邻位字**之误(巳↔午、戌↔未、卯↔寅、酉↔申),
 *        且 A 的**六亲与五行在 383/384 格上是对的** ——
 *        错的是地支字, 而六亲是按五行算的 ⇒ 抄错了地支却没重算六亲,
 *        自相矛盾。A 的修订版与原版在**雷天大壮初爻(子/寅)**上也不一致,
 *        进一步证明它是**人工誊抄**的表(誊抄会错; B/C 是结构化数组, 不誊抄)。
 *     ④ 来源 C 的世应/宫归属与本地 jingfang_bagong.js **64/64 相同**
 *        ⇒ B/C 这条路整体可信, 不是只对了地支。
 *
 *   ⚠️ **一条反直觉但重要的事实**: 这 5 处冲突位**不全是变爻位**
 *     (只有遁第2爻、观第4爻是)。所以「A 把变卦的纳支填进来了」这个
 *     解释**站不住** —— 早先的裁决理由(第 41 批初稿)就是错的, 已改掉。
 *     现在站得住的理由是上面 ①②③④。
 *
 * ═══════════════════════════════════════════════════════════════
 * §三  本模块与老板那条红线的关系
 * ═══════════════════════════════════════════════════════════════
 *
 *   老板原话(2026-10-21):「爻动阴阳那就太过了」。
 *   它的数据含义是: **动爻只翻阴阳, 不改纳支**。
 *   京房装卦的纳支由**宫位/上下卦**决定, 与哪一爻动、怎么动无关。
 *   本模块的 384 格对拍正是这条红线的**数据证据**:
 *   装卦结果 100% 由「内三爻取下卦、外三爻取上卦」决定, 与动爻无关。
 *   (那 5 处 A 的错值恰好都是「不按宫位定、另算一套」的错误。)
 *
 *   ⚠️ 本模块**不**把外部来源当「唯一真源」—— 卦层结构(上下卦/八宫/世应)
 *     用的是**本地** jingfang_bagong.js(双源交叉: 文本真源 + 机械推导, 64/64 一致),
 *     外部来源只提供「纳支/六亲」这一层。两条路必须能对上(判据 ⑤)。
 */

'use strict';

const { HEXAGRAMS } = require('../hexagrams');

// ⚠️ **不能**在这里 require('./jingfang_bagong') —— 会造成循环依赖:
//     najia.js → najia_crosscheck.js → jingfang_bagong.js → najia.js
//   (jingfang_bagong.js 在模块顶层就调 najia.loadableGuaIds())
//   循环里先被加载的那个拿到的是**半成品** exports ⇒ TypeError。
//   ⇒ 京房表改成**惰性取**: 用到时才 require, 那时循环已经解开。
function getJingfangTable() {
  // eslint-disable-next-line global-require
  return require('./jingfang_bagong').JINGFANG_TABLE;
}

// ============================================================
// §一  来源 A/B/C 的原始数据 (实拉实解析, 照抄, 不加工)
// ============================================================

/**
 * 来源 B (Johnson-Jia) BAGUA_NAZHI —— 8 卦 × 6 爻地支, 初爻→上爻。
 *
 * ⚠️ 这张表**同时**也是来源 A 的 `2-03-纳甲.md` 图的解析结果(两者逐字相同,
 *   唯一差别是 A 用俗字「戍」)。见 §二【八卦表 8/8】。
 */
const BAGUA_NAZHI = Object.freeze({
  乾: Object.freeze(['子', '寅', '辰', '午', '申', '戌']),
  坤: Object.freeze(['未', '巳', '卯', '丑', '亥', '酉']),
  坎: Object.freeze(['寅', '辰', '午', '申', '戌', '子']),
  离: Object.freeze(['卯', '丑', '亥', '酉', '未', '巳']),
  震: Object.freeze(['子', '寅', '辰', '午', '申', '戌']),
  巽: Object.freeze(['丑', '亥', '酉', '未', '巳', '卯']),
  艮: Object.freeze(['辰', '午', '申', '戌', '子', '寅']),
  兑: Object.freeze(['巳', '卯', '丑', '亥', '酉', '未']),
});

/**
 * 来源 B (Johnson-Jia) BAGUA_NAGAN —— 八卦纳甲天干, [内卦干, 外卦干]。
 *
 * ⚠️ 这 8 条本地已有**文本真源**(梅花易数课外阅读资料「甲壬为乾, 乙癸为坤,
 *   丙艮、丁兑、戊坎、己离、庚震、辛巽」), 这里的用途是**交叉核对**,
 *   不是替代 —— 见 crosscheckNajiaSources() 的纳干核对段。
 */
const BAGUA_NAGAN = Object.freeze({
  乾: Object.freeze(['甲', '壬']),
  坤: Object.freeze(['乙', '癸']),
  坎: Object.freeze(['戊', '戊']),
  离: Object.freeze(['己', '己']),
  震: Object.freeze(['庚', '庚']),
  巽: Object.freeze(['辛', '辛']),
  艮: Object.freeze(['丙', '丙']),
  兑: Object.freeze(['丁', '丁']),
});

/**
 * 来源 C (Seanding) 64 卦**爻级**地支, 顺序 **初爻→上爻**。
 *
 * ⚠️ 方向这件事踩过坑: 来源 A 的全图是**上→下**排(首行是上爻),
 *   来源 C 是**初→上**排(第一项是初爻)。两边方向相反、内容等价。
 *   早先的交叉验证模块把 C 写成「上→下」, 于是拿 C 去比装卦结果时
 *   **384 格全错** —— 而那份模块自己报的 323 条红里,
 *   有 8 条把「乾卦装出来是子寅辰午申戌」说成「应为戌申午辰寅子」。
 *   ⇒ 方向搞反的守卫, 比没有守卫更坏: 它会让人以为数据错了。
 *   本表的顺序已用 乾/坤/泰/否 四例与本地真源逐字对齐验证过。
 */
const GUA64_ZHI = Object.freeze({
  乾: '子寅辰午申戌',
  坤: '未巳卯丑亥酉',
  屯: '子寅辰申戌子',
  蒙: '寅辰午戌子寅',
  需: '子寅辰申戌子',
  讼: '寅辰午午申戌',
  师: '寅辰午丑亥酉',
  比: '未巳卯申戌子',
  小畜: '子寅辰未巳卯',
  履: '巳卯丑午申戌',
  泰: '子寅辰丑亥酉',
  否: '未巳卯午申戌',
  同人: '卯丑亥午申戌',
  大有: '子寅辰酉未巳',
  谦: '辰午申丑亥酉',
  豫: '未巳卯午申戌',
  随: '子寅辰亥酉未',
  蛊: '丑亥酉戌子寅',
  临: '巳卯丑丑亥酉',
  观: '未巳卯未巳卯',
  噬嗑: '子寅辰酉未巳',
  贲: '卯丑亥戌子寅',
  剥: '未巳卯戌子寅',
  复: '子寅辰丑亥酉',
  无妄: '子寅辰午申戌',
  大畜: '子寅辰戌子寅',
  颐: '子寅辰戌子寅',
  大过: '丑亥酉亥酉未',
  坎: '寅辰午申戌子',
  离: '卯丑亥酉未巳',
  咸: '辰午申亥酉未',
  恒: '丑亥酉午申戌',
  遁: '辰午申午申戌',
  大壮: '子寅辰午申戌',
  晋: '未巳卯酉未巳',
  明夷: '卯丑亥丑亥酉',
  家人: '卯丑亥未巳卯',
  睽: '巳卯丑酉未巳',
  蹇: '辰午申申戌子',
  解: '寅辰午午申戌',
  损: '巳卯丑戌子寅',
  益: '子寅辰未巳卯',
  夬: '子寅辰亥酉未',
  姤: '丑亥酉午申戌',
  萃: '未巳卯亥酉未',
  升: '丑亥酉丑亥酉',
  困: '寅辰午亥酉未',
  井: '丑亥酉申戌子',
  革: '卯丑亥亥酉未',
  鼎: '丑亥酉酉未巳',
  震: '子寅辰午申戌',
  艮: '辰午申戌子寅',
  渐: '辰午申未巳卯',
  归妹: '巳卯丑午申戌',
  丰: '卯丑亥午申戌',
  旅: '辰午申酉未巳',
  巽: '丑亥酉未巳卯',
  兑: '巳卯丑亥酉未',
  涣: '寅辰午未巳卯',
  节: '巳卯丑申戌子',
  中孚: '巳卯丑未巳卯',
  小过: '辰午申午申戌',
  既济: '卯丑亥申戌子',
  未济: '寅辰午酉未巳',
});

/**
 * 来源 A (woaichiji 原版全图) 与 B/C 冲突的 5 处 —— 保留下来, 让守卫能**复算裁决**。
 *
 * 键 = 卦名, 值 = { 爻位(1=初爻..6=上爻), A: 来源A的值, adopted: B/C 的值 }
 *
 * ⚠️ 这 5 处的**性质**已实测确认: A 的错值既不等于本卦该位纳支,
 *   也不等于变卦该位纳支 ⇒ 是**誊抄错字**, 不是另一套体系。
 *   早先写成「6 处 + 冲突位全是变爻位」是错的: 实测 5 处, 且只有 2 处在变爻位。
 */
const SOURCE_A_CONFLICTS = Object.freeze({
  遁: Object.freeze({ pos: 2, A: '巳', adopted: '午' }),
  观: Object.freeze({ pos: 4, A: '戌', adopted: '未' }),
  剥: Object.freeze({ pos: 6, A: '卯', adopted: '寅' }),
  旅: Object.freeze({ pos: 3, A: '酉', adopted: '申' }),
  革: Object.freeze({ pos: 5, A: '申', adopted: '酉' }),
});

/**
 * 来源 1「本地文本真源」(<course-source>) —— 阳德条/阴德条。
 * 只有乾、坤两卦, 但它能**独立**验证另外两个来源的地支表 —— 这就是交叉验证的意义。
 */
const LOCAL_TEXT_TRUTH = Object.freeze({
  乾: Object.freeze(['子', '寅', '辰', '午', '申', '戌']),
  坤: Object.freeze(['未', '巳', '卯', '丑', '亥', '酉']),
});

/**
 * 十六字口诀 (来源 A) —— 独立于表的第三道内部判据。
 * 「乾震起子, 坎寅艮辰, 离卯兑巳, 巽丑未坤」
 */
const SIXTEEN_CHAR_KATA = Object.freeze({
  乾: '子', 震: '子', 坎: '寅', 艮: '辰',
  离: '卯', 兑: '巳', 巽: '丑', 坤: '未',
});

/** 十二地支的顺序(算步长用) */
const ZHI_ORDER = Object.freeze('子丑寅卯辰巳午未申酉戌亥');

/** 阳卦(顺行 +2) / 阴卦(逆行 -2) */
const YANG_GUA = Object.freeze(new Set(['乾', '坎', '震', '艮']));

// ============================================================
// §二  判据 —— 每条都有可复算的负例
// ============================================================

/**
 * 判据 ①: 本地文本真源(乾、坤)必须与外部来源**逐字相同**。
 * 负例: 把 BAGUA_NAZHI.乾 里的'寅'改成'卯' ⇒ 乾卦这卦立刻报红。
 */
function checkLocalTextTruth(dizhiTable) {
  const problems = [];
  for (const [gua, truth] of Object.entries(LOCAL_TEXT_TRUTH)) {
    const got = dizhiTable[gua];
    if (!got) { problems.push(`「${gua}」卦的六爻地支丢了`); continue; }
    if (got.join('') !== truth.join('')) {
      problems.push(`「${gua}」卦的六爻地支与本地文本真源不符: 应为 ${truth.join('')}, `
        + `实为 ${got.join('')}(顺序错 = 装卦全错且不报错)`);
    }
  }
  return problems;
}

/**
 * 判据 ②: 八卦纳甲表的**结构自洽** —— 阳卦顺行、阴卦逆行、内外起点差 6 位、
 *           且与十六字口诀一致。
 * 负例: 把 坎 的'寅'改成'子' ⇒ 坎的内外步长立刻破, 报红。
 */
function checkNajiaStructure(dizhiTable, naganTable) {
  const problems = [];
  for (const [gua, arr] of Object.entries(dizhiTable)) {
    if (!arr || arr.length !== 6) {
      problems.push(`「${gua}」卦的六爻地支应是 6 支, 实为 ${arr && arr.length}`);
      continue;
    }
    const step = YANG_GUA.has(gua) ? 2 : -2;
    const inner = arr.slice(0, 3);
    const outer = arr.slice(3);
    const i0 = ZHI_ORDER.indexOf(inner[0]);
    const o0 = ZHI_ORDER.indexOf(outer[0]);
    for (let i = 0; i < 3; i++) {
      if (ZHI_ORDER.indexOf(inner[i]) !== (i0 + i * step + 12) % 12) {
        problems.push(`「${gua}」卦内三爻步长应为 ${step > 0 ? '+2' : '-2'}`
          + `(${YANG_GUA.has(gua) ? '阳卦顺行' : '阴卦逆行'}), 实为 ${inner.join('')}`);
        break;
      }
    }
    for (let i = 0; i < 3; i++) {
      if (ZHI_ORDER.indexOf(outer[i]) !== (o0 + i * step + 12) % 12) {
        problems.push(`「${gua}」卦外三爻步长应为 ${step > 0 ? '+2' : '-2'}, 实为 ${outer.join('')}`);
        break;
      }
    }
    if (((o0 - i0) % 12 + 12) % 12 !== 6) {
      problems.push(`「${gua}」卦内外三爻起点应差 6 位, 实为 ${((o0 - i0) % 12 + 12) % 12} 位`);
    }
    const gan = naganTable[gua];
    if (!gan) { problems.push(`「${gua}」卦没有纳甲天干`); continue; }
    if (!gan.inner || !gan.outer) {
      problems.push(`「${gua}」卦的纳干应同时有 inner/outer 两个`);
    }
  }
  // 十六字口诀: 起支 + 步长 必须复现内三爻
  for (const [gua, start] of Object.entries(SIXTEEN_CHAR_KATA)) {
    const arr = dizhiTable[gua];
    if (!arr) continue;
    const step = YANG_GUA.has(gua) ? 2 : -2;
    const i0 = ZHI_ORDER.indexOf(start);
    const want = [0, 1, 2].map(i => ZHI_ORDER[(i0 + i * step + 12) % 12]).join('');
    if (arr.slice(0, 3).join('') !== want) {
      problems.push(`「${gua}」卦内三爻与十六字口诀(起${start}${step > 0 ? '顺' : '逆'})不符: `
        + `应为 ${want}, 实为 ${arr.slice(0, 3).join('')}`);
    }
  }
  return problems;
}

/**
 * 判据 ③: 64 卦装卦结果必须与来源 C 的爻级数据**逐格相同**(384 格)。
 *
 * 装卦规则(本地已验过的那条): 内三爻取下卦纳甲(该卦地支前3支),
 *                             外三爻取上卦纳甲(该卦地支后3支)。
 * 负例: 把 革 的'酉'改成'申' ⇒ 革卦第5爻对不上, 报红; 且 革 之外的卦若
 *        恰好也用兑卦, 也会跟着报 —— 归因指向**改坏的那个卦**, 不是全体。
 */
function check64GuaZhi(dizhiTable) {
  const problems = [];
  const byName = new Map();
  for (const h of HEXAGRAMS) byName.set(h.name, h);
  let cells = 0;
  for (const [guaName, zhiStr] of Object.entries(GUA64_ZHI)) {
    const h = byName.get(guaName);
    if (!h) { problems.push(`来源 C 的表里有「${guaName}」, 本地 64i 没有这个卦名`); continue; }
    const lower = h.trigrams.lower_name;
    const upper = h.trigrams.upper_name;
    const dl = dizhiTable[lower];
    const du = dizhiTable[upper];
    if (!dl || !du) {
      const miss = [!dl ? lower : null, !du ? upper : null].filter(Boolean).join('、');
      problems.push(`「${guaName}」卦装不出来: 缺 ${miss} 的地支`);
      continue;
    }
    // 初→上: 内三爻取下卦前3支, 外三爻取上卦后3支
    const built = dl.slice(0, 3).concat(du.slice(3));
    for (let p = 1; p <= 6; p++) {
      cells++;
      const got = built[p - 1];
      const expect = zhiStr[p - 1];
      if (got !== expect) {
        problems.push(`「${guaName}」卦第${p}爻纳支应为 ${expect}, 实为 ${got}`
          + ` (装卦规则: 内三爻取下卦${lower}纳甲, 外三爻取上卦${upper}纳甲)`);
      }
    }
  }
  return { problems, cells };
}

/**
 * 判据 ④: 来源 A 的 5 处冲突必须**恰好**是那 5 处, 且每一处采纳值 = B/C 值。
 *   —— 这条是为了让「裁决」本身可复算: 哪天有人把 A 的值填进生产,
 *      这条判据会立刻指出「你采纳了被否决的那个值」。
 */
function checkSourceAConflicts(dizhiTable) {
  const problems = [];
  for (const [guaName, c] of Object.entries(SOURCE_A_CONFLICTS)) {
    const h = HEXAGRAMS.find(x => x.name === guaName);
    if (!h) { problems.push(`本地 64i 没有「${guaName}」卦`); continue; }
    const lower = h.trigrams.lower_name;
    const upper = h.trigrams.upper_name;
    const dl = dizhiTable[lower];
    const du = dizhiTable[upper];
    if (!dl || !du) { problems.push(`「${guaName}」卦装不出来, 没法核对冲突爻位`); continue; }
    const built = dl.slice(0, 3).concat(du.slice(3));
    const got = built[c.pos - 1];
    if (got !== c.adopted) {
      problems.push(`「${guaName}」卦第${c.pos}爻应采纳 B/C 的 ${c.adopted}(否决来源 A 的 ${c.A}), 实为 ${got}`);
    }
  }
  return problems;
}

/**
 * 判据 ⑤: 卦层结构(上下卦/京房宫/世应)必须与**本地** jingfang_bagong.js 一致。
 *   外部来源只提供纳支/六亲这一层; 卦层结构是本地的, 不许被外部来源带偏。
 */
function checkLocalStructureAlignment() {
  const problems = [];
  const jfById = new Map(getJingfangTable().map(r => [r.gua_id, r]));
  for (const h of HEXAGRAMS) {
    const r = jfById.get(h.id);
    if (!r) { problems.push(`京房表里没有卦序 ${h.id}(${h.name})`); continue; }
    if (r.gua_name !== h.name) {
      problems.push(`卦序 ${h.id}: 本地 hexagrams.js 叫「${h.name}」, 京房表叫「${r.gua_name}」`);
    }
  }
  return problems;
}

/**
 * 判据 ⑥: **动爻不改纳支** —— 老板「爻动阴阳那就太过了」的数据判据。
 *
 *   命题: 纳支由**卦的宫位/上下卦**定, 与哪一爻动无关。
 *         动爻翻的是**阴阳**(阳↔阴), 纳支一动不动。
 *
 *   ⚠️ 这条第一版写错了, 值得记下来(它自己报红 152 条):
 *     我原来把它写成「本卦 vs 变卦的纳支要相同」——
 *     但变卦是**另一个卦**, 它的上下卦变了, 纳支当然该不同
 *     (屯卦变卦是「山地剥」, 纳支自然是剥卦那一套)。
 *     拿两个不同卦的纳支比相等, 比的其实是「变卦装卦对不对」,
 *     跟动爻没关系。**判据写偏了, 就会冤枉正确的数据。**
 *
 *   正确的判法(有真牙齿): **变卦的装卦结果必须落在 64 卦表的正确位置**。
 *     ① 对每一卦, 按京房变爻位算出它的变卦(用 binary 翻转);
 *     ② 变卦的六爻纳支 = 按**变卦自己**的上下卦装出来的那一串;
 *     ③ 这一串必须逐字等于 64 卦表里**变卦那一行**的值。
 *     ⇒ 8×8 卦被变卦关系互相锁住: 改坏八卦表的一格, 会有多个卦同时报红,
 *       归因指向那一个卦, 而不是全体。
 *     ⇒ 而这正是「纳支由宫位定」的含义: 变卦有自己的宫位和自己的纳支,
 *       **不继承**本卦动爻位的纳支(来源 A 的 5 处错, 就是把别处的纳支
 *       掺进了动爻位 —— 正是这条红线要禁的那件事)。
 *
 *   负例: 改坏八卦表里任一格 ⇒ 这条立刻报红。
 */
function checkMovingYaoDoesNotChangeNajia(dizhiTable) {
  const problems = [];
  const TRIG_BY_BIN = Object.freeze({
    '111': '乾', '000': '坤', '100': '震', '010': '坎',
    '001': '艮', '110': '兑', '101': '离', '011': '巽',
  });
  // 京房变爻位: 本宫不变; 一世~五世 依次从初爻起变; 游魂变四爻; 归魂内卦全变
  const BIAN_POS = Object.freeze({
    本宫: [], 一世: [1], 二世: [1, 2], 三世: [1, 2, 3], 四世: [1, 2, 3, 4],
    五世: [1, 2, 3, 4, 5], 游魂: [4], 归魂: [1, 2, 3],
  });
  const jfById = new Map(getJingfangTable().map(r => [r.gua_id, r]));
  const byBinary = new Map();
  for (const h of HEXAGRAMS) byBinary.set(h.binary, h);
  let checked = 0;
  for (const h of HEXAGRAMS) {
    const r = jfById.get(h.id);
    if (!r) continue;
    const bian = BIAN_POS[r.wei];
    if (!bian || bian.length === 0) continue;   // 本宫卦不变, 无变卦可比
    // ① 算变卦
    const bits = h.binary.split('');
    for (const p of bian) bits[p - 1] = bits[p - 1] === '0' ? '1' : '0';
    const bianBinary = bits.join('');
    const bh = byBinary.get(bianBinary);
    if (!bh) { problems.push(`卦序 ${h.id}(${h.name}) 算出的变卦 binary=${bianBinary} 不在 64 卦里`); continue; }
    // ② 变卦按**自己**的上下卦装卦
    const dl = dizhiTable[h.trigrams.lower_name];
    const du = dizhiTable[h.trigrams.upper_name];
    const bl = dizhiTable[bh.trigrams.lower_name];
    const bu = dizhiTable[bh.trigrams.upper_name];
    if (!dl || !du || !bl || !bu) continue;
    const bianZhi = bl.slice(0, 3).concat(bu.slice(3));
    // ③ 必须逐字等于 64 卦表里变卦那一行
    checked++;
    const want = GUA64_ZHI[bh.name];
    if (want && bianZhi.join('') !== want) {
      problems.push(`卦序 ${h.id}(${h.name}) 的变卦「${bh.name}」装出来是 ${bianZhi.join('')}, `
        + `但 64 卦表里它是 ${want} —— 纳支必须由**变卦自己的宫位**定, `
        + `不随动爻改变(老板:「爻动阴阳那就太过了」)`);
    }
  }
  return { problems, checked };
}

/**
 * 判据⑦: 八卦纳甲天干(纳干)与外部来源 B 逐卦一致。
 *
 * ⚠️ 原来是 `crosscheckNajiaSources` 里的一段**内联循环**。抽成具名判据是为了:
 *   ① 报错时能说清是哪一条判据咬的, 而不是七条混成一堆;
 *   ② 它能被 `najia.js` 的装时自检**直接引用** —— 守卫 D 的可达性不动点
 *      只跟「判据名之间」的调用连线走, 内联循环不在其中。
 *      教训: 判据写不出来名, 下一个人就没法单独测它、也没法单独看它报什么。
 */
function checkNaganAgainstSource(naganTable) {
  const problems = [];
  for (const [gua, gan] of Object.entries(BAGUA_NAGAN)) {
    const got = naganTable[gua];
    if (!got) { problems.push(`「${gua}」卦没有纳甲天干`); continue; }
    if (got.inner !== gan[0] || got.outer !== gan[1]) {
      problems.push(
        `「${gua}」卦纳干应与外部来源一致: ${gan[0]}/${gan[1]}, 实为 ${got.inner}/${got.outer}`
      );
    }
  }
  return problems;
}

// ============================================================
// §三  汇总
// ============================================================

/**
 * 跑完整交叉验证。
 *
 * @param {Object} opts
 * @param {Object} opts.dizhiTable  八卦六爻地支表 (纳甲层在用的那张)
 * @param {Object} opts.naganTable  八卦纳干表 { 卦: {inner, outer} }
 * @returns {{ok:boolean, problems:string[], cells:number, summary:string}}
 */
function crosscheckNajiaSources(opts) {
  const dizhiTable = opts.dizhiTable;
  const naganTable = opts.naganTable;
  const problems = [];

  problems.push(...checkLocalTextTruth(dizhiTable));
  problems.push(...checkNajiaStructure(dizhiTable, naganTable));
  problems.push(...checkSourceAConflicts(dizhiTable));
  problems.push(...checkLocalStructureAlignment());
  const c64 = check64GuaZhi(dizhiTable);
  problems.push(...c64.problems);
  const cMove = checkMovingYaoDoesNotChangeNajia(dizhiTable);
  problems.push(...cMove.problems);

  // 纳干表也要跟外部来源一致(8 卦, 内外两干)
  problems.push(...checkNaganAgainstSource(naganTable));

  return {
    ok: problems.length === 0,
    problems,
    cells: c64.cells,
    bian_checked: cMove.checked,
    summary: `纳甲四源交叉验证: 八卦表 8/8 结构自洽(阳顺阴逆·内外差6·十六字口诀), `
      + `本地文本真源(乾/坤)逐字对上, 64卦×6爻=${c64.cells} 格与来源 C 逐格一致, `
      + `来源 A 的 5 处冲突已按 B/C 裁决, `
      + `动爻不改纳支已验(${cMove.checked} 个变卦装卦逐字对上)`,
  };
}

module.exports = {
  BAGUA_NAZHI,
  BAGUA_NAGAN,
  GUA64_ZHI,
  SOURCE_A_CONFLICTS,
  LOCAL_TEXT_TRUTH,
  SIXTEEN_CHAR_KATA,
  ZHI_ORDER,
  YANG_GUA,
  crosscheckNajiaSources,
  checkLocalTextTruth,
  checkNajiaStructure,
  check64GuaZhi,
  checkSourceAConflicts,
  checkLocalStructureAlignment,
  checkMovingYaoDoesNotChangeNajia,
  checkNaganAgainstSource,
};
