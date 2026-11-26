/**
 * Pangu · 64i Layer
 * bagua_annotations/jingfang_bagong.js
 *
 * 京房八宫 64 卦表 —— 卦层(占筮结构层)
 *
 * ═══════════════════════════════════════════════════════════════
 * 这张表为什么落在这儿, 以及为什么它**不是**「多写一份数据」
 * ═══════════════════════════════════════════════════════════════
 * 2026-10-22 查清了三件事, 这张表是其中第一件的落地:
 *
 * ① repo 现有的 `bagong` 字段**不是京房八宫** —— 程序验证 64/64:
 *      bagong === 上卦所属纯卦 (上卦分组)
 *    也就是说, repo 现在说的「乾宫/坎宫」, 实际是「上卦是乾/坎」,
 *    **跟占筮用的京房八宫完全是两码事**。名字撞了, 口径不同。
 *
 * ② repo 的 `elements`(卦五行) = **上卦五行**(= bagong 那个口径)。
 *    跟京房**宫五行**在 **32/64** 上不一致 ——
 *    例: 蒙卦, repo 说土(上卦艮), 京房说火(离宫四世);
 *        讼卦, repo 说金(上卦乾), 京房说火(离宫游魂)。
 *    六亲是拿「卦五行 vs 爻位五行」算的, 所以现有一半卦的六亲
 *    建在错的「我」上 —— 这条口径变更单独立一批, 不夹带。
 *
 * ③ repo 的纳甲存表 = **先天序 60 甲子循环**(乾甲子…节癸亥, 中孚甲子重新起),
 *    卦级气数, 不是爻级装卦。跟京房纳甲首爻配对 3/64 —— 不能拿京房去「补」它。
 *
 * ═══════════════════════════════════════════════════════════════
 * 双源交叉: 这张表**不是**从一处抄来的, 是两处独立来源对上了
 * ═══════════════════════════════════════════════════════════════
 * 来源 A (文本真源): /Users/you/Desktop/course-source§三「八宫归属(京房八宫卦序)」
 *                    与 /Users/you/Desktop/course-source§7.1 —— 两处内容一致。
 * 来源 B (机械推导): 只用京房变爻规则算, 不查任何表:
 *      本宫 = 纯卦(上下同卦)
 *      一世 = 变初爻 / 二世 = 再变二爻 / 三世 = 再变三爻
 *      四世 = 再变四爻 / 五世 = 再变五爻
 *      游魂 = 五世卦把第四爻变回本宫
 *      归魂 = 游魂卦把下卦三爻(初/二/三)变回本宫
 *    推导自带**双射校验**(64 卦一一覆盖 / 8宫×8位=64 组合无缺失无重复)。
 *
 * 两者**逐格比对 64/64 零冲突** (见 assertJingfangTable())。
 * 一个来源是人抄的, 一个来源是程序算的 —— 对上了才敢落进代码。
 *
 * ⚠️ 真源内部**也有**一张错的表: digest/<course-source> §5,
 *    兑宫那行混进了艮宫的「中孚」、且游魂/归魂整列错位(乾宫游魂写成「剥」)。
 *    —— 同一批资料里的三张表, 两张对一张错, 所以**必须**交叉验证, 不能只抄一张。
 *
 * ═══════════════════════════════════════════════════════════════
 * 世应爻位: 世爻机械推, 应爻隔三位 —— 8/8 行全有值(第 35 批改)
 * ═══════════════════════════════════════════════════════════════
 * 世爻 = 本宫→本卦位**变卦链上最后一次变动的爻位**(1 基):
 *      本宫 无变动 → 取上爻(6)
 *      一世 变初爻 → 1 / 二世 变二爻 → 2 / 三世 变三爻 → 3
 *      四世 变四爻 → 4 / 五世 变五爻 → 5
 *      游魂 变回四爻 → 4 / 归魂 变回下三爻 → 3
 *    —— 一条规则出全部 8 行, 不是 8 个背下来的数。
 *    跟通行京房世爻表(本宫6/一世1/二世2/三世3/四世4/五世5/游魂4/归魂3)逐格一致。
 *
 * 应爻 = 与世爻**隔三位**(初↔四 / 二↔五 / 三↔上) —— 8 行同一条规则, **无例外**。
 *
 * ⚠️ 第 35 批更正: 此前本宫那一行(世在上爻)的应爻留 **null**, 理由写的是
 *   「隔三位给出三爻, 经典另说初爻, 两说冲突, 真源未收录, 不编」。
 *   这条理由站不住, 三个理由:
 *      ① 代码**自己**的配对表 {1:4, 2:5, 3:6, 4:1, 5:2, 6:3} 就含 6:3 ——
 *         特例跟本文件自己的规则**互相矛盾**;
 *      ② 「经典另说初爻」在真源里**查无出处**: /Users/you/Desktop/course-source 全树搜「世应|应爻|世爻」
 *         只有 2 处命中(覆盖表那句「八宫世应爻位 | 部分 | ⚠️ 需核对」+
 *         三命通会的八字神障语「世应希」), 都没有这条;
 *      ③ 隔三位是**定义式**规则(应爻与世爻在卦中相隔三位), 不是逐卦的查表数据 ——
 *         其余 56 行早就在用它, 没理由给本宫行单开一个例外。
 *   另加**外部交叉校验**(checkShiYingCrossCheck): 用真纳甲地支 × 真源六冲表,
 *   乾、坤两个本宫卦的候选应爻**唯一** = 三爻(世6戌 ↔ 应3辰 冲; 若应1则戌/子 不冲)
 *   ⇒ 把这一格钉死, 且不靠"印象"。
 *
 * 纳甲(六爻装卦干支): 真源**部分**有 —— 八卦天干 8/8, 乾/坤六爻地支有
 *    (详见 najia.js 与本文件 NAJIA_STATUS)。其余 60 卦的地支真源没有, 不补。
 *
 * ═══════════════════════════════════════════════════════════════
 * 层归属 (跟 modules/yao_layer_boundary.js 的层表对齐)
 * ═══════════════════════════════════════════════════════════════
 * 本表在**卦层**: 八宫宫位/宫五行/世应是**卦的结构**, 不涉及爻动,
 *   也不做生克强弱判定(那是五行层的活)。所以本文件里:
 *   - 没有爻值 6/7/8/9
 *   - 没有「爻动生克」
 *   - 世应爻位是**卦级**位置, 不是「这一爻动没动」
 */

'use strict';

const hexagrams = require('../hexagrams');
// 2026-10-22 第 33 批: 纳甲状态里的「几卦装得出」**从纳甲层实算**, 不手写。
//   手写过一次(2), 跟表算出来的不一致(4) —— 写死的数字会跟表漂, 而且没人发现。
const _najia = require('./najia.js');
// 2026-10-22 第 35 批: 世应爻位的**外部交叉校验**要用真源六冲表。
//   这不是"卦层在判生克" —— 六冲是地支的固定对冲关系(表), 不是五行生克强弱。
const _ZR = require('../bazi/zhis_relations.js');

// ============================================================
// 八卦二进制 (下卦三位 ‖ 上卦三位, 自下而上)
// 与 64i/hexagrams.js 的 binary 同一约定: bits[0] = 初爻
// ============================================================

const TRIGRAM_BITS = Object.freeze({
  '乾': '111', '兑': '110', '离': '101', '震': '100',
  '巽': '011', '坎': '010', '艮': '001', '坤': '000',
});

/** 八宫顺序 */
const GONGS = Object.freeze(['乾', '坎', '艮', '震', '巽', '离', '坤', '兑']);

/** 宫五行 —— 京房八宫各宫的五行(与卦上卦五行是两套) */
const GONG_WUXING = Object.freeze({
  '乾': '金', '坎': '水', '艮': '土', '震': '木',
  '巽': '木', '离': '火', '坤': '土', '兑': '金',
});

/** 宫内 8 个位置(卦位) */
const WEI_NAMES = Object.freeze(['本宫', '一世', '二世', '三世', '四世', '五世', '游魂', '归魂']);

/**
 * ★ 来源 A: 文本真源的京房八宫 64 卦表(卦名)
 *
 * 出处:
 *   /Users/you/Desktop/course-source§三「八宫归属(京房八宫卦序)」
 *   /Users/you/Desktop/course-source§7.1「八宫归属(京房八宫卦序 · 占卜家用)」
 * 两处内容一致; 第三处(digest/<course-source> §5)是错的, 未采信。
 *
 * 这张表**只存卦名** —— 卦序(id)/binary 一律从 64i/hexagrams.js 按 binary 反查,
 * 不在这里重复存一份。理由: 存名不存号, 名字错了程序会当场发现(见 assertJingfangTable),
 * 存了号就会出现「两张表 id 对不上」的静默分叉。
 */
const SOURCE_TABLE = Object.freeze({
  '乾': ['乾', '姤', '遁', '否', '观', '剥', '晋', '大有'],
  '坎': ['坎', '节', '屯', '既济', '革', '丰', '明夷', '师'],
  '艮': ['艮', '贲', '大畜', '损', '睽', '履', '中孚', '渐'],
  '震': ['震', '豫', '解', '恒', '升', '井', '大过', '随'],
  '巽': ['巽', '小畜', '家人', '益', '无妄', '噬嗑', '颐', '蛊'],
  '离': ['离', '旅', '鼎', '未济', '蒙', '涣', '讼', '同人'],
  '坤': ['坤', '复', '临', '泰', '大壮', '夬', '需', '比'],
  '兑': ['兑', '困', '萃', '咸', '蹇', '谦', '小过', '归妹'],
});

// ============================================================
// 来源 B: 机械推导(只按变爻规则, 不查表)
// ============================================================

/** 翻转指定爻位(0 基) */
function _flip(binary, positions) {
  const bits = binary.split('');
  for (const p of positions) bits[p] = bits[p] === '1' ? '0' : '1';
  return bits.join('');
}

/**
 * 本宫 → 各卦位的**变爻链**(每一步翻了哪些爻位)
 * 世爻 = 最后一步翻动的最高爻位(1 基); 本宫无变动 → 取上爻。
 */
const CHANGE_CHAIN = Object.freeze([
  [],                         // 本宫
  [[0]],                      // 一世: 变初爻
  [[0], [1]],                 // 二世: 再变二爻
  [[0], [1], [2]],            // 三世: 再变三爻
  [[0], [1], [2], [3]],       // 四世: 再变四爻
  [[0], [1], [2], [3], [4]],  // 五世: 再变五爻
  [[0], [1], [2], [3], [4], [3]],              // 游魂: 把第四爻变回本宫
  [[0], [1], [2], [3], [4], [3], [0, 1, 2]],   // 归魂: 下卦三爻变回本宫
]);

/** 走一遍变爻链, 得到该卦位的 binary */
function _deriveBinary(gong, weiIndex) {
  const pure = TRIGRAM_BITS[gong] + TRIGRAM_BITS[gong];
  let bin = pure;
  for (const step of CHANGE_CHAIN[weiIndex]) bin = _flip(bin, step);
  return bin;
}

/** 世爻(1 基): 变爻链最后一步变动的最高爻位; 本宫无变动 → 上爻(6) */
function _deriveShiYao(weiIndex) {
  const chain = CHANGE_CHAIN[weiIndex];
  if (!chain.length) return 6;
  const last = chain[chain.length - 1];
  return Math.max.apply(null, last) + 1;
}

/**
 * 应爻(1 基): 与世爻隔三位(初↔四 / 二↔五 / 三↔上) —— **一条规则, 无例外**。
 *
 * ⚠️ 第 35 批改: 原来这里对世在上爻(本宫)那行 `return null`, 理由是
 *   「隔三位给三爻, 经典另说初爻, 两说冲突, 真源没收录, 不编」。
 *   那条理由站不住, 已删:
 *     ① 本文件自己的配对表**就含 6:3** —— 特例跟自己的规则互相矛盾;
 *     ② 「经典另说初爻」全语料**查无出处**(见文件头);
 *     ③ 隔三位是**定义式**规则, 其余 56 行早就在用, 本宫行没理由例外。
 *   正确性另由 checkShiYingCrossCheck 用**外部数据**(真纳甲地支 × 真源六冲表)钉住。
 */
function _deriveYingYao(shiYao) {
  const pair = { 1: 4, 2: 5, 3: 6, 4: 1, 5: 2, 6: 3 };
  return pair[shiYao];
}

// ============================================================
// 装配
// ============================================================

const _HEX_BY_BINARY = new Map();
for (const h of hexagrams.HEXAGRAMS || []) _HEX_BY_BINARY.set(h.binary, h);

/** 卦位 → 本宫链上的 binary */
const _DERIVED_BINARY = {};
for (const gong of GONGS) {
  _DERIVED_BINARY[gong] = WEI_NAMES.map((_, i) => _deriveBinary(gong, i));
}

/**
 * 京房八宫完整表: 64 条
 * 每条 = { gong, gong_wuxing, wei, wei_index, gua_id, gua_name, gua_binary,
 *           shi, ying }
 *
 * ⚠️ 第 35 批: `ying_null_reason` 字段**已删**。
 *   它原来只在 8 个本宫卦上有值(理由: "两说冲突, 不编"), 现在 8/8 行都有应爻,
 *   这个字段恒为 null ⇒ 留着就是**僵尸字段**: 生产输出会带着一个永远不会出现的分支。
 *   僵尸字段比没有字段更坏 —— 它让人以为"这里还有缺口"。
 */
const JINGFANG_TABLE = (() => {
  const rows = [];
  for (const gong of GONGS) {
    WEI_NAMES.forEach((weiName, i) => {
      const binary = _DERIVED_BINARY[gong][i];
      const hex = _HEX_BY_BINARY.get(binary);
      const shi = _deriveShiYao(i);
      const ying = _deriveYingYao(shi);
      rows.push({
        gong,
        gong_wuxing: GONG_WUXING[gong],
        wei: weiName,
        wei_index: i,
        gua_id: hex ? hex.id : null,
        gua_name: hex ? hex.name : null,
        gua_binary: binary,
        shi,
        ying,
      });
    });
  }
  return Object.freeze(rows);
})();

const _BY_ID = new Map();
for (const row of JINGFANG_TABLE) {
  if (row.gua_id !== null) _BY_ID.set(row.gua_id, row);
}

const _BY_GONG = new Map();
for (const gong of GONGS) {
  _BY_GONG.set(gong, JINGFANG_TABLE.filter(r => r.gong === gong));
}

// ============================================================
// 自校验: 双源交叉 + 双射
// ============================================================

// ------------------------------------------------------------
// ★ 第 35 批新增: 世应爻位的**外部交叉校验**
// ------------------------------------------------------------
/**
 * 世应爻位的外部交叉校验 —— 用**真纳甲地支** × **真源六冲表**反查。
 *
 * 为什么需要它(这是本批的全部意义):
 *   前面所有自检(双源交叉/双射/世应自洽)用的都是**同一份规则的尺子** ——
 *   拿"隔三位配对"这条规则去量"按隔三位配对推出来的表", 恒真, 咬不动人。
 *   (踩坑日志第 27 批那条: 尺子与被测对象同源 = 恒真守卫。)
 *   所以必须有**一把跟被测对象不同源**的尺子。
 *
 * 这把尺子是什么:
 *   京房八宫里, 纳甲地支的排布有一个可验的性质 ——
 *   **同一个卦里, 内卦三爻与外卦三爻的纳甲地支逐位相冲**。
 *   乾卦: 内 子寅辰 / 外 午申戌 → 子午冲, 寅申冲, 辰戌冲 ✓
 *   坤卦: 内 未巳卯 / 外 丑亥酉 → 丑未冲, 巳亥冲, 卯酉冲 ✓
 *   这不是巧合, 是纳甲本身的结构(内外卦地支相对冲)。
 *
 *   而本宫卦(纯卦)世在上爻(6)、应在三爻(3)时, 世应两爻正好落在
 *   「内卦第三爻 ↔ 外卦第三爻」这一对相冲位上 ⇒ **世应地支必冲**。
 *   于是: 世6 的应爻若取 3 → 戌/辰、酉/卯, **冲** ✓
 *         世6 的应爻若取 1 → 戌/子、酉/未, **不冲** ✗
 *   ⇒ 「应=3」和「应=1」被机器区分开了, 不靠印象。
 *
 * ⚠️ 覆盖边界(**必须**跟数据一起说清, 否则就是拿 2 个样本冒充 64 行):
 *   本函数只查 8 个本宫卦(wei_index===0), 并**显式报出 coverage**, 不夸大。
 *   第 41 批八卦地支补齐后 8/8 全部验得上; 补齐之前只有乾、坤 2 个能验,
 *   当时这条校验的定位是「在本宫卦这一格上排除掉另一个候选」而非「证明全部 8 行」。
 *   ⇒ 所以 coverage 必须**跟着数据算**, 不许写死某一句「有几个缺口」——
 *     写死的那句话在数据补齐后会开始骗人(踩坑日志: 注释也会骗人)。
 *
 * ⚠️ 判据只对**本宫卦(世在上爻)**成立:
 *   世3应6 的两组(泰/否)实算 辰/酉、卯/戌 **不冲** ⇒ 「世应必冲」不是通则,
 *   只在本宫纯卦这一族成立。所以本函数只查 wei_index===0 的行, 其它行不碰。
 *
 * @param {object} [opts]
 *   table: 注入坏表(负例用)
 *   najia: 注入纳甲层(负例用 —— 第 41 批补齐后真实数据没有缺口,
 *     「一条都验不上时必须报警」这条性质在真数据上**走不到**了,
 *     只能自己造一个缺口来验, 见测试)
 * @returns {object} { ok, checked, coverage, violations, detail }
 */
function checkShiYingCrossCheck(opts = {}) {
  const table = opts.table || JINGFANG_TABLE;
  const _nj = opts.najia || _najia;
  const violations = [];
  const detail = [];

  // 六冲对: **直接查真源六冲表**(LIU_CHONG), 不用地支序数差 6 自己推。
  //   ⚠️ 为什么不用「序数差 6」: 那是在**表外**另立一条规则 —— 注释写的是"真源六冲表",
  //   代码跑的却是"我算的差 6", 两套话。真源表就在手边, 直接查它,
  //   尺子才配得上"异源"这两个字(顺带: 若真源表哪天少一对/多一对, 这里会立刻失配,
  //   而不是悄悄按序数继续判)。
  const chongOf = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    return _ZR.LIU_CHONG.some(pair => pair.pair.includes(a) && pair.pair.includes(b));
  };

  // 只查本宫卦(纯卦): 那一族才成立「世应地支相冲」
  const benGongRows = table.filter(r => r.wei_index === 0);
  let checked = 0;
  // 2026-10-22 第 35 批补: **可验但没验上**, 必须报出来。
  //   原来这里有个洞: 某一行坏了(gua_id 改成 999 / shi 改成 0 / ying 改成 null),
  //   getYaoGanzhi 装不出干支 ⇒ 这行被静默标成 'unverifiable' 跳过 ⇒
  //   而 checked===0 那条兜底**不会触发**(还有别的行验上了) ⇒ **整个校验报 ok=true**。
  //   换句话说: 守卫在, 但坏数据能让它**闭嘴**。
  //
  //   修法: 两条**异源**判据, 都不手写数字:
  //     (i) 本宫卦的 id 有确定答案 —— 就是「本宫的纯卦」, 那个 id 可以从
  //         变爻规则实算出来(_deriveBinary(gong,0) → 反查卦序)。
  //         行里的 gua_id 跟它不一致 ⇒ 这一行被改坏了, 必须报。
  //     (ii) 该 id 若落在纳甲层的「可完整装卦」集合里(loadableGuaIds, 真源驱动),
  //         那它**本该验上**(纳甲地支有真源); 验不上 = 表坏了或纳甲被清空 ⇒ 必须报。
  //   为什么用 loadableGuaIds 而不是硬写 {乾:1, 坤:2}: 手写的数字是负债 ——
  //   哪天纳甲真源补了震卦, 硬写的那张表不会跟着变, 守卫就会开始骗人。
  const _LOADABLE = new Set(_nj.loadableGuaIds());

  for (const row of benGongRows) {
    // (i) 本宫卦的 id 必须是「本宫的纯卦」那个 id
    const pureBin = _deriveBinary(row.gong, 0);
    const pureHex = _HEX_BY_BINARY.get(pureBin);
    const expectId = pureHex ? pureHex.id : null;
    if (expectId !== null && row.gua_id !== expectId) {
      violations.push(
        '[世应交叉] ' + row.gong + '宫本宫卦的 id 应是「' + pureHex.name + '」(id=' + expectId +
        ', 由本宫变爻规则实算), 实为 ' + row.gua_id + ' —— 这一行被改坏了'
      );
    }

    const s = _nj.getYaoGanzhi(row.gua_id, row.shi);
    const y = _nj.getYaoGanzhi(row.gua_id, row.ying);

    // 装不出干支(纳甲地支真源缺失) → **验不了**, 不算通过, 也不算失败
    if (!s.ok || !y.ok) {
      // (ii) 本该验上的卦却没验上 ⇒ 表坏了(gua_id 被改 / 爻位被改)或纳甲被清空
      if (expectId !== null && _LOADABLE.has(expectId)) {
        violations.push(
          '[世应交叉] ' + row.gong + '宫本宫卦验不上 —— 这一宫的本宫卦应当是 id=' + expectId +
          '(纳甲地支有真源, 本该验上), 实际 id=' + row.gua_id +
          ' 世' + row.shi + '/应' + row.ying + ': ' + (!s.ok ? s.error.message : y.error.message) +
          ' —— 数据被改坏或纳甲真源被清空, 不许静默跳过'
        );
      }
      detail.push({
        gua_id: row.gua_id, gua_name: row.gua_name, gong: row.gong,
        status: 'unverifiable',
        reason: !s.ok ? s.error.message : y.error.message,
      });
      continue;
    }

    checked++;
    const isChong = chongOf(s.dianzhi, y.dianzhi);
    detail.push({
      gua_id: row.gua_id, gua_name: row.gua_name, gong: row.gong,
      status: isChong ? 'ok' : 'violation',
      shi_zhi: s.dianzhi, ying_zhi: y.dianzhi,
    });
    if (!isChong) {
      violations.push(
        '[世应交叉] ' + row.gong + '宫本宫卦(' + row.gua_name + '): 世' + row.shi + '爻=' +
        s.dianzhi + ' 应' + row.ying + '爻=' + y.dianzhi + ' 不相冲 —— 本宫纯卦的世应' +
        '应落在内外卦相冲位上(内外卦纳甲地支逐位相冲)'
      );
    }
  }

  // ⚠️ 反向守卫: **一条都没验上** ⇒ 这个校验形同虚设, 必须报出来。
  //   否则哪天真纳甲地支被清空, 校验会「全绿」而实际什么都没检查。
  if (checked === 0) {
    violations.push(
      '[世应交叉] 一个本宫卦都没验上 —— 交叉校验形同虚设(真纳甲地支是不是被清空了?)'
    );
  }

  return {
    ok: violations.length === 0,
    checked,
    // ⚠️ 措辞跟数据走: 全验上了就不能再说「其余因真源缺失验不到」(第 41 批)。
    //   写死一句「有缺口」的话, 数据补齐后它就在骗人 —— 与其留一句可能变假的解释,
    //   不如让数字自己说话, 缺了再补原因。
    coverage: checked + '/' + benGongRows.length + ' 个本宫卦可验'
      + (checked < benGongRows.length ? '(其余因纳甲地支真源缺失验不到)' : '(全部验上, 无缺口)'),
    violations,
    detail,
  };
}

/**
 * 校验这张表 —— 装时自检用, 越界即抛。
 *
 * 四条:
 *   ① **双源交叉**: 机械推导出的卦名 == 文本真源表里的卦名, 64/64
 *   ② **双射**: 64 卦一一覆盖(无重无漏), 且 8宫×8位 = 64 组合无缺失
 *   ③ **宫五行**: 宫五行的卦(本宫卦)五行 == 该宫五行
 *   ④ **世爻自洽**: 世爻在 1..6; 世≠应的隔三位配对成立(本宫行除外)
 *   ⑤ **世应外部交叉**(第 35 批): 真纳甲地支 × 真源六冲表, 见 checkShiYingCrossCheck
 *
 * ⚠️ 为什么这必须是**装时自检**而不是测试:
 *   这张表一旦跟真源漂了, 盘古会**安静地**按错的宫/世应断卦 ——
 *   不报错, 只是答案全错(和「传男被当女命」同族)。
 *   测试是「跑的时候才看」, 装时自检是「起来就炸」。
 *
 * ⚠️ ④ 是**同源尺子**(拿"隔三位"量"按隔三位推的表"), 恒真, 抓不到规则本身的错;
 *   ⑤ 才是**异源尺子**(拿真纳甲地支 + 真源六冲表反查), 能真的否掉一个候选。
 *   两个都得留: ④ 查表内一致性, ⑤ 查规则对不对。
 *
 * @param {object} [opts] - 注入点(负例用, 与 yao_layer_boundary 的分项导出同一做法)
 *   sourceTable: 换成「坏掉的真源表」→ 双源交叉必须当场炸
 *   table:       换成「坏掉的推导表」→ 双射/宫五行/世应自检必须当场炸
 *   没有注入点就只能靠「改真源文件」来测负例 —— 那是**共享文件**,
 *   node --test 并行时隔壁文件会读到被改坏的版本, 报出看着像真 bug 的错(2026-10-22 踩过)。
 */
function assertJingfangTable(opts = {}) {
  const sourceTable = opts.sourceTable || SOURCE_TABLE;
  const table = opts.table || JINGFANG_TABLE;
  const violations = [];

  // ① 双源交叉
  let crossChecked = 0;
  for (const gong of GONGS) {
    WEI_NAMES.forEach((weiName, i) => {
      const derived = table.find(r => r.gong === gong && r.wei_index === i);
      const sourceName = (sourceTable[gong] || [])[i];
      if (!derived || !sourceName) {
        violations.push('[双源交叉] ' + gong + '宫' + weiName + ' 缺条目');
        return;
      }
      if (derived.gua_name !== sourceName) {
        violations.push(
          '[双源交叉] ' + gong + '宫' + weiName + ': 机械推导="' + derived.gua_name +
          '" vs 文本真源="' + sourceName + '"'
        );
      }
      crossChecked++;
    });
  }
  if (crossChecked !== 64) violations.push('[双源交叉] 应交叉 64 格, 实为 ' + crossChecked);

  // ② 双射
  const ids = table.map(r => r.gua_id);
  if (ids.some(id => id === null)) violations.push('[双射] 有条目反查不到卦(id=null)');
  const uniq = new Set(ids);
  if (uniq.size !== 64) {
    violations.push('[双射] 64 卦应一一覆盖, 实为 ' + uniq.size + ' 个不同 id');
  }
  // ②b **id 必须在 1..64, 且 id 指向的卦必须跟这一行自述的一致**
  //   ⚠️ 第 35 批发现: 原来只查了「id 不重复」—— 把某行的 gua_id 改成 999,
  //   id 依然是唯一的、双射照样通过, 而这一行从此指向一个**不存在的卦**。
  //   后果: 查卦工具按 id 查不到 ⇒ 静默返回 null; 更糟的是它**没人报错**。
  //   这就是「守卫在但不咬人」—— 断言写了, 但它不拦这类坏数据。
  //   判据: gua_id ∈ 1..64, 且 HEX[gua_id].name === row.gua_name,
  //        且 HEX[gua_id].binary === row.gua_binary(三者必须指向同一个卦)。
  const _HEX_BY_ID = new Map();
  for (const h of hexagrams.HEXAGRAMS || []) _HEX_BY_ID.set(h.id, h);
  for (const row of table) {
    const id = row.gua_id;
    if (!Number.isInteger(id) || id < 1 || id > 64) {
      violations.push(
        '[双射] ' + row.gong + '宫' + row.wei + ' 的 gua_id 越界: ' + id +
        ' (必须是 1..64 的卦序)'
      );
      continue;
    }
    const hex = _HEX_BY_ID.get(id);
    if (!hex) {
      violations.push('[双射] ' + row.gong + '宫' + row.wei + ' 的 gua_id=' + id + ' 查不到卦');
      continue;
    }
    if (hex.name !== row.gua_name) {
      violations.push(
        '[双射] ' + row.gong + '宫' + row.wei + ' 的 gua_id=' + id + ' 指向「' + hex.name +
        '」, 但这一行自称「' + row.gua_name + '」'
      );
    }
    if (hex.binary !== row.gua_binary) {
      violations.push(
        '[双射] ' + row.gong + '宫' + row.wei + ' 的 gua_id=' + id + '(' + hex.name +
        ') 的 binary 是「' + hex.binary + '」, 但这一行写的是「' + row.gua_binary + '」'
      );
    }
  }
  for (const gong of GONGS) {
    const rows = table.filter(r => r.gong === gong);
    if (rows.length !== 8) violations.push('[双射] ' + gong + '宫 应 8 个卦位, 实为 ' + rows.length);
    const ws = rows.map(r => r.wei_index).sort((a, b) => a - b).join(',');
    if (ws !== '0,1,2,3,4,5,6,7') violations.push('[双射] ' + gong + '宫 卦位不齐: ' + ws);
  }

  // ③ 宫五行 == 本宫卦的卦五行
  for (const gong of GONGS) {
    const ben = table.find(r => r.gong === gong && r.wei_index === 0);
    if (!ben) {
      violations.push('[宫五行] ' + gong + '宫 缺本宫卦');
      continue;
    }
    const hex = _HEX_BY_BINARY.get(ben.gua_binary);
    if (!hex) {
      violations.push('[宫五行] ' + gong + '宫 本宫卦 binary 反查不到卦: ' + ben.gua_binary);
    } else if (hex.elements !== GONG_WUXING[gong]) {
      violations.push(
        '[宫五行] ' + gong + '宫 本宫卦(' + hex.name + ')卦五行="' + hex.elements +
        '" ≠ 宫五行="' + GONG_WUXING[gong] + '"'
      );
    }
  }

  // ④ 世应自洽(同源尺子: 只查表内一致性)
  for (const row of table) {
    if (!(row.shi >= 1 && row.shi <= 6)) {
      violations.push('[世应] ' + row.gong + '宫' + row.wei + ' 世爻越界: ' + row.shi);
    }
    if (!(row.ying >= 1 && row.ying <= 6)) {
      violations.push('[世应] ' + row.gong + '宫' + row.wei + ' 应爻越界: ' + row.ying);
    }
    const expect = _deriveYingYao(row.shi);
    if (row.ying !== expect) {
      violations.push(
        '[世应] ' + row.gong + '宫' + row.wei + ' 应爻=' + row.ying + ', 隔三位配对应为 ' + expect
      );
    }
  }

  // ⑤ 世应外部交叉(异源尺子: 真纳甲地支 × 真源六冲表)
  const cross = checkShiYingCrossCheck({ table });
  for (const v of cross.violations) violations.push(v);

  if (violations.length) {
    throw new Error(
      '[jingfang-bagong] 京房八宫表自检不通过 —— 卦层(占筮结构层)的数据不可信。\n' +
      '  命中:\n  ' + violations.join('\n  ')
    );
  }
  return { ok: true, checked: 64, violations, cross_check: cross };
}

// ============================================================
// 口径说明(给模型看的, 也给下一个人看的)
// ============================================================

/**
 * 世应状态(第 35 批更新)
 *
 * ⚠️ 原来这里写「已定 7/8 行」+「本宫那行留 null, 经典说初爻, 两说冲突」——
 *   那条「经典说初爻」全语料查无出处, 且跟本文件自己的配对表矛盾, 已撤。
 *   现在 8/8 行统一按隔三位, 并有外部交叉校验兜着。
 */
const SHI_YING_STATUS = Object.freeze({
  shi: '已定 —— 世爻 = 本宫→本卦位变卦链上最后一次变动的爻位(1基); 本宫卦无变动取上爻',
  ying: '已定 8/8 行 —— 应爻与世爻隔三位(初↔四/二↔五/三↔上), 本宫卦(世在上爻)应三爻',
  ying_basis: '应爻=隔三位配对(世1→应4, 世2→应5, 世3→应6, 世4→应1, 世5→应2, 世6→应3); ' +
    '本宫纯卦的世应落在内外卦纳甲地支相冲位上, 已用真纳甲地支×真源六冲表交叉校验' +
    '(第 41 批补齐八卦地支后 8/8 本宫卦全部验上)',
  source: '真源未收录世应爻位(/Users/you/Desktop/course-source§覆盖表: 「八宫世应爻位 | 部分 | ⚠️ 需核对」)',
});

/**
 * 纳甲状态 (2026-10-22 第三十三批更新)
 *
 * ⚠️ 原来这里写的是「缺 · 六爻完整装卦纳甲真源未收录」—— 现在**部分**有了,
 *   继续写「缺」就跟事实对不上, 而对不上的口径会直接进模型上下文。
 *
 *   现在的真值(第 41 批): 8/8 卦的**纳甲天干**有真源(梅花易数资料);
 *   **乾、坤两卦的六爻地支**有本地文本真源(<course-source> 阳德/阴德条);
 *   震巽坎离艮兑六卦本地全库无出处 ⇒ 从**外部四源交叉验证**取(见 najia_crosscheck.js)
 *   ⇒ 能完整装出六爻干支的卦 = **64/64**, 无缺口。
 *   (原先这里写死过「2/64 只有乾、坤」, 后来又写死「4/64 乾泰否坤」——
 *    两次都是**手写死的数字**, 都会跟表漂。现在这个数改成**从表算**, 不再手写。)
 *   真纳甲在 `bagua_annotations/najia.js`, 那边带自检。
 */
const NAJIA_STATUS = Object.freeze({
  status: _najia.loadableGuaIds().length >= 64
    ? '齐全(' + _najia.loadableGuaIds().length + '/64 卦可完整装卦)'
    : '部分(' + _najia.loadableGuaIds().length + '/64 卦可完整装卦)',
  detail: '六爻装卦纳甲: 八卦纳甲天干 8/8 齐全; 爻级地支 **8/8 卦齐全** ' +
    '(乾、坤来自本地文本真源: <course-source>.txt 阳德条/阴德条; ' +
    '震巽坎离艮兑来自**外部四源交叉验证**, 判据与裁决见 najia_crosscheck.js, 全部可复算) ' +
    '⇒ 64 卦 × 6 爻 = **384/384 爻位全部装得出干支**, 无缺口。' +
    '⚠️ 装卦规则(内三爻取下卦纳甲、外三爻取上卦纳甲)是**验出来的**, ' +
    '与来源 C 的 64 卦装卦数据 384/384 格逐格吻合; 它同时说明——' +
    '**动爻只翻阴阳, 不改纳支**(老板 10-21 原话「爻动阴阳那就太过了」)。' +
    '若哪天真出现装不出的爻位, 返回 null + 原因, 不推算填。' +
    '⚠️ 64i/hexagrams.js 的 najia 字段**不是纳甲表**(它是 60 甲子按卦序的机械循环, ' +
    '8/8 个同下卦组内初爻都不唯一, 违反京房必要条件, 且真源无出处), 两者不能混用。',
  searched: '/Users/you/Desktop/course-source 全树扫描: 0 个文件命中「六爻」; 85 个 PDF 全文本扫过, 无装卦纳甲表; ' +
    '梅花易数资料.pdf 里的「纳甲」是纳甲数(天地数), 不是装卦干支。' +
    '2026-10-22 复扫: 命中「八卦纳甲天干」(梅花易数资料) 与「乾/坤六爻纳甲地支」' +
    '(<course-source> 阳德/阴德条) —— 这两处是**真纳甲**; ' +
    '震巽坎离艮兑六卦的地支全树无命中。' +
    '第 41 批: 震巽坎离艮兑六卦的地支**本地确实没有**, 已从外部三源' +
    '(github.com/woaichiji/liuyao、Johnson-Jia/liuyao-divination、Seanding1998/liuyao-frv) ' +
    '交叉验证取得, 判据见 najia_crosscheck.js —— 所以「全树无命中」现在只说明' +
    '**本地**没有, 不代表没有真值。' +
    '⚠️ 该结论只覆盖**文本层**: 主要课件 PDF(如 学习宝典.pdf)的正文是**图片**, ' +
    '文本层只有 14KB ⇒ 扫描件里的装卦表还没验过(需 OCR, 见 decision.md 第 33 批)。',
});

/** repo 里 bagong 字段到底是什么(它不是京房八宫) */
const REPO_BAGONG_NOTE = Object.freeze(
  '64i/hexagrams.js 与 wuxing_map.js 里的 bagong 字段 = **上卦所属纯卦(上卦分组)**, ' +
  '不是京房八宫的宫。两者名字撞了, 口径不同: 京房宫用 jingfang_bagong.getJingfangGong()。'
);

// ============================================================
// API
// ============================================================

/**
 * 查某卦的京房八宫归属
 * @param {number} guaId - 卦序 1..64(文王序)
 * @returns {object|null}
 */
function getJingfang(guaId) {
  const row = _BY_ID.get(guaId);
  if (!row) return null;
  return {
    gong: row.gong,
    gong_wuxing: row.gong_wuxing,
    wei: row.wei,
    gua_id: row.gua_id,
    gua_name: row.gua_name,
    shi: row.shi,
    ying: row.ying,
  };
}

/**
 * 某卦的京房宫名
 * @param {number} guaId
 * @returns {string|null} 乾/坎/艮/震/巽/离/坤/兑
 */
function getJingfangGong(guaId) {
  const row = _BY_ID.get(guaId);
  return row ? row.gong : null;
}

/**
 * 某宫的 8 个卦(按卦位)
 * @param {string} gong
 * @returns {object[]}
 */
function getJingfangByGong(gong) {
  const rows = _BY_GONG.get(gong);
  if (!rows) return [];
  return rows.map(r => ({
    gong: r.gong,
    gong_wuxing: r.gong_wuxing,
    wei: r.wei,
    gua_id: r.gua_id,
    gua_name: r.gua_name,
    shi: r.shi,
    ying: r.ying,
  }));
}

/**
 * 某卦位在某宫的卦
 * @param {string} gong
 * @param {string|number} wei - 卦位名(本宫/一世/…)或序号 0..7
 */
function getGuaByGongWei(gong, wei) {
  const rows = _BY_GONG.get(gong);
  if (!rows) return null;
  const idx = typeof wei === 'number' ? wei : WEI_NAMES.indexOf(wei);
  if (idx < 0 || idx > 7) return null;
  const r = rows[idx];
  return { gua_id: r.gua_id, gua_name: r.gua_name, wei: r.wei, shi: r.shi, ying: r.ying };
}

/** 整张表(64 条) */
function listJingfang() {
  return JINGFANG_TABLE.map(r => ({
    gong: r.gong,
    gong_wuxing: r.gong_wuxing,
    wei: r.wei,
    gua_id: r.gua_id,
    gua_name: r.gua_name,
    shi: r.shi,
    ying: r.ying,
  }));
}

module.exports = {
  GONGS,
  GONG_WUXING,
  WEI_NAMES,
  SOURCE_TABLE,
  JINGFANG_TABLE,
  SHI_YING_STATUS,
  NAJIA_STATUS,
  REPO_BAGONG_NOTE,
  getJingfang,
  getJingfangGong,
  getJingfangByGong,
  getGuaByGongWei,
  listJingfang,
  assertJingfangTable,
  checkShiYingCrossCheck,
  _deriveBinary,
  _deriveShiYao,
  _deriveYingYao,
};
