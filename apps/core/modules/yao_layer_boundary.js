/**
 * 爻层边界守卫 —— 把老板 2026-10-21 原话变成机制
 *
 * 原话:「爻动阴阳那就太过了」
 *
 * 完整红线 (decision.md §三点九 末尾 + §三点十二):
 *
 *   | 层     | 放什么                                                                          | 不放什么               |
 *   |--------|---------------------------------------------------------------------------------|------------------------|
 *   | 卦层   | 阴阳卦、体用、纳甲                                                              | 爻变生克               |
 *   | 五行层 | 五行分阴阳(偏枯/得令之别), 生克强弱在这里判                                       | 爻位五行随动爻变       |
 *   | 六爻层 | 爻位编号防错(0..63) + 爻值 6/7/8/9(老阴/少阳/少阴/老阳) + 引用爻辞原文          | 五行/纳甲/爻变生克     |
 *
 * 编号体系 —— 每一套是**独立**的还是**派生**的(2026-10-23 第 53 批):
 *
 *   | 编号                | 取值                              | 关系              |
 *   |---------------------|-----------------------------------|-------------------|
 *   | 爻画 · yaoYinYang   | 阴=0 阳=1                         | 原子              |
 *   | 爻位 · yaoPosition  | 初爻 二爻 三爻 四爻 五爻 上爻     | 原子              |
 *   | 爻值 · yaoValue     | 6 老阴 / 7 少阳 / 8 少阴 / 9 老阳 | 派生自 yaoYinYang |
 *   | 八卦 · baguaXianTian | 乾1 兑2 离3 震4 巽5 坎6 艮7 坤8  | 派生自 yaoYinYang |
 *   | 八卦 · baguaHouTian | 坎1 坤2 震3 巽4 乾5 兑6 艮7 离8  | 独立于 yaoYinYang |
 *   | 六十四卦 · guaIndex | 0..63 = 上卦值×8 + 下卦值        | 派生自 yaoYinYang |
 *   | 六十四卦 · guaId    | 1..64 文王序                      | 独立于 yaoYinYang |
 *
 * ⚠️ 这张表是 2026-10-23 才有的, 因为**我此前讲错了**。
 *   我说盘古有「爻位序/二进制序/后天序三套并存」, 老板给了他的
 *   「乾=111=7 … 坤=000=0」表, 问「这么考虑是不是就不存在三套序的问题了?」
 *   —— 实测 8/8 全中, **老板是对的**。我把**派生函数**数成了**并列的另一套**。
 *   判据不是数法, 是一条: **能不能写成对方的函数。** 能 ⇒ 派生。
 *   ⇒ 表里每套编号都必须自报「派生自谁」或「为什么独立」, 派生关系还要当场算。
 *   **只有真正独立的两套(后天序 / 文王序)才配得上「换序会静悄悄返回另一个卦」。**
 *   老板 10-22 点的「不是 1~64 是 0~63」那个坑, 成因就在表里最后两行:
 *   `id`(文王序, 独立) 和 `index`(0..63, 派生) 长得太像, 都叫「第几卦」。
 *
 * ⚠️ 卦层/五行层那两行 2026-10-22 第 34 批才补上(之前是空的「—」):
 *   禁项**不写进表** = 这层职责没写出来, 下一个人看表看不到这一层管什么。
 *   而空着的两层看着像「这两层什么都行」—— 恰恰是最容易越界的地方。
 *   两行都**有真判据兜着**, 不是空头愿望:
 *     卦层的「爻变生克」← checkProductionChangePathNoWuxing + checkTransformOutputShape
 *     五行层的「爻位五行随动爻变」← checkYaoPositionWuxingIsStatic(方向 C)
 *
 * ⚠️ **这张表原写错了, 2026-10-22 当场改掉**(不是笔误, 是会拆地基的错):
 *   原表「六爻层 不放 **老阴老阳**」—— 可代码**允许**爻值 6/7/8/9:
 *   `64i/yin_yang.js` 整个爻值层就是老阳(9)/老阴(6)/少阳(7)/少阴(8),
 *   那是卦筮的**地基编码**(一个数同时表「阴阳」+「动静」), 禁了整个体系就塌了。
 *   照那张表去「补齐禁词」, 会把爻值层自己判成越界, 启动即炸。
 *
 *   老板禁的从来不是**爻值里的阴阳**, 是**在爻动上再叠一层术数阴阳**:
 *   「这爻是阳, 所以它属木, 阳木克阴土」这种**爻变生克** —— 那是五行层的活。
 *   这两件事长得像(都叫"阴阳"), 边界却是整个数术体系的地基线, 差一根头发丝就塌。
 *
 *   所以: 表从**数据**来 (LAYER_BOUNDARY, 下方), 注释是它的渲染, 由
 *   `tests/yao-boundary-doc-20261022.test.js` pin 住 —— 注释和判据不许各说一套。
 *
 * 理由(老板的): 生彼泻克耗是**五行关系层**的东西。一旦下沉到每一爻的动静,
 * 就变成另一套算命话术, 卦象会从「推断的一层」退化成「装饰」。
 *
 * ⚠️ **为什么不能只靠注释**: 项目铁律「注释 ≠ 隔离 —— 注释会被下一次改动吃掉」。
 *   这条红线原来**只写在 decision.md 里**(过程文档, 不在代码路径上),
 *   任何一次「顺手加个五行判断」都能悄无声息地越过去 —— 而且它不会报错,
 *   只会安静地给出另一套话术。所以这里做成**装时自检**: 越界即抛, 启动即炸。
 *
 * ═══════════════════════════════════════════════════════════════
 * 判据设计: **双向**, 不是单向
 * ═══════════════════════════════════════════════════════════════
 * 只禁「爻层有五行」是不够的 —— 那种守卫, 把五行功能全删光也能通过。
 * 老板的原话是**「什么时候用阴阳五行八卦, 什么时候用 64卦+6爻」**,
 * 两头都得在: 五行层必须**有**阴阳(老板 10-21 另立一条:「五行有阴阳」),
 * 六爻层必须**没有**阴阳五行。所以:
 *
 *   方向 A (禁): 爻层三模块不得触碰五行/纳甲
 *   方向 B (要): 五行层必须真的有阴阳维度(否则「合则不克」整个塌了)
 *     ⚠️ 第 39 批: 这条判据**换了守法** —— 原来只查「某个导出在不在」,
 *       是个假守卫(删掉生产零影响的 judgeKeByYinYang 报红, 而十神层
 *       阴阳维度全坏它照样绿)。现在改守**真载体**:
 *       五合判据(真源五对 + 全异性) + 十神层正偏阴阳 + 两套编码交叉校验。
 *       详见 checkYinyangJudgeReal。
 *   方向 C (准): 爻位固定五行是**静态属性**, 不得随动爻变化
 *   方向 D (锚): **真纳甲**必须住在卦层(防有人把纳甲下沉到爻层)
 *     ⚠️ 2026-10-22 第 33/34 批连着改了这条判据的前提:
 *       它原来数的是 `hexagrams.js` 每卦那根 `najia` 字段, 断言「64 处」。
 *       而那根字段**压根不是纳甲**(60 甲子按卦序的机械循环) ⇒
 *       拿它当锚 = **用假数据证明真数据在位**: 哪天真纳甲被删了, 这条守卫照样绿。
 *       现在锚在 `64i/bagua_annotations/najia.js`(天干 8/8 + 装卦接口)上。
 *
 * ⚠️ 方向 C 第 36 批**换了前提**(详见 `checkYaoPositionWuxingIsStatic`):
 *   它原来守的是「爻位固定五行表(初水二木三火四金五土上火)是静态的」。
 *   那张表**已经撤了** —— 查无出处, 且与真纳甲地支在可验爻位上大幅冲突。
 *   判据若不改, 就成了「守着一张已经不存在的表的守卫」——
 *   正是本文件头注释里说的「以为有守卫, 其实没有」。
 *   现在它守的是**真命题**: 爻的五行**只有一个来源**(该爻的纳甲地支五行, 卦层),
 *   且**不随动爻变**。老板那句「爻动阴阳那就太过了」, 数据上就落在这里。
 *
 * ⚠️ 顺带纠正一个**算错过的地方**: 纳甲是**按爻**算的, 不是按整卦 ——
 *   内三爻取下卦纳甲、外三爻取上卦纳甲, 所以只要卦的一半有地支,
 *   那一半三爻就装得出。先前按「整卦」算出的「4/64」把缺口夸大了一倍 ——
 *   **缺口被夸大比缺口本身更危险**: 会把有据可查的半边也记成「没有」。
 *   第 41 批: 八卦纳甲地支**八个卦全补齐**(四源交叉验证) ⇒ 实算 **384/384** 装得出,
 *   覆盖率一律从 `najia.getCoverageStats()` 现算, 不再手写。
 *
 * ⚠️ 方向 C 第 37 批**把 C4 从恒真改成了有牙齿**(详见
 *   `checkYaoPositionWuxingIsStatic` 里的 C4 段):
 *   第 36 批的 C4 是**结构上恒真**的, 三重问题:
 *     ① `getYaoVector(guaId, pos)` **只收两参** ⇒ 爻值从设计上就进不了
 *        被测路径, 向量层内部自己按 binary 推爻值 ⇒ movement 恒为 'static'。
 *        「四个爻值下爻五行都不许变」= 同一个调用比了四遍, 结论必然成立。
 *     ② 那四个爻值是配一个**编造的假卦** yao6=[7,8,7,8,7,8] 用的,
 *        跟 id 无关 ⇒ 「实跑一遍变卦」名不副实。
 *     ③ 当时真纳甲表只覆盖乾/坤 ⇒ 96 个装得出纳甲的爻位, 其**变卦**的纳甲
 *        100% 装不出 ⇒ 「本卦五行 vs 变卦五行」这条比较路径**一颗牙齿都没有**。
 *        (第 41 批补齐八卦地支后不再是这条原因, 但判据改成「56 个变卦的装卦
 *         结果必须逐字等于 64 卦表对应行」—— 那个版本是**永远成立**的,
 *         不依赖「变卦装不出」这个会消失的前提。)
 *   ⇒ 现在: 爻值真接进向量层(第 37 批), C4 改成**真卦真爻位**,
 *     断言「静/动两态下 yaoWuxing 相同」+「movement 必须随爻值变」
 *     +「矛盾爻值必须被拒」, 并配**三条负例**证明它会咬人。
 *   ★ 顺带修掉一个**生产 bug**: `gua_engine.js` 此前调 `getYaoVector(guaId, yaoIdx0)`
 *     只传两参 ⇒ **动爻在 8 维向量里 movement 恒为 'static'**,
 *     老阳(9)/老阴(6)的动静信息整条链丢光。现在动爻位的爻值真接上了。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const I64 = path.join(CORE, '64i');

// ============================================================
// 常量
// ============================================================

/**
 * 爻层(六爻层)模块清单 —— 职责只有两件: 爻位编号防错 + 引爻辞原文
 */
const YAO_LAYER_MODULES = [
  { file: path.join(I64, 'yin_yang.js'), label: '爻值层' },
  { file: path.join(I64, 'yao_transform.js'), label: '爻变层' },
  { file: path.join(I64, 'yao_models.js'), label: '爻辞层' },
];

/** 爻位公理层 —— 第 36 批起**不带**五行(爻的五行只来自纳甲) */
const YAO_AXIOM_FILE = path.join(I64, 'bagua_annotations', 'yao_axioms.js');

/**
 * 爻层源码里一律不许出现的 token。
 *
 * ⚠️ 为什么连「五行」都禁, 却不禁「老阳/老阴」:
 *   老阳(9)/老阴(6) 是**爻值编码**(一个数同时表「阴阳」+「动静」),
 *   是六爻占筮的基本语汇, 删了整个体系就塌了 —— 那是这套数术的地基。
 *   老板禁的是**在爻动上再叠一层术数阴阳**, 即「这爻是阳, 所以它属木,
 *   阳木克阴土」这种**爻变生克**。那属于五行层, 不属于六爻层。
 *
 *   所以爻层允许: 爻值 6/7/8/9、YIN/YANG、movement 静动、爻辞、编号 0..63。
 *   爻层禁止: wuxing/五行/纳甲/najia 这些**越层**的东西。
 */
const FORBIDDEN_IN_YAO_LAYER = [
  { token: 'wuxing', why: '五行层的东西不许下沉到六爻层' },
  { token: 'WUXING', why: '同上' },
  { token: 'najia', why: '纳甲是卦层语义, 不许下沉到六爻层' },
  { token: '五行', why: '同上' },
  { token: '纳甲', why: '同上' },
];

/**
 * 变卦推演路径的**输出形状**里不许出现的字段名。
 * 比源码扫描更硬 —— 源码扫描管「怎么写的」, 输出形状管「实际吐了什么」。
 */
const FORBIDDEN_OUTPUT_KEYS = [
  'wuxing', 'guaWuxing', 'yaoWuxing', 'wuxingRel', 'wuxing_rel',
  'liuQin', 'liu_qin', 'najia', 'yinYangOfWuxing', 'shengKe', 'sheng_ke',
];

/**
 * 五行层必须具备的函数 —— 方向 B
 *
 * ⚠️ 2026-10-22 第 39 批**换掉了这个清单的守法**:
 *   原来这里列了 4 个导出(getHe / isOppositeYinYang / judgeKeByYinYang /
 *   judgeShengByYinYang), 判据是「缺了就报红」。实跑抓出它是个**假守卫**:
 *
 *   ① 删掉 `judgeKeByYinYang` ⇒ 方向 B **报红**, 而**生产零影响**
 *      —— 因为生产根本不走它。它是十神层「正官/七杀」的**第二份编码**,
 *      实跑 20 对克关系, force 与十神正偏**零不一致**。
 *   ② 反过来, 把**十神层**的阴阳维度全弄坏 ⇒ 方向 B **照样绿**。
 *      —— 真正的漏洞它一点都看不见。
 *
 *   ⇒ 这就是本文件头注释里那条老教训的又一次: **守着影子, 不是真身**。
 *     跟第 33 批「拿假纳甲当锚」、第 37 批「C4 恒真」是同一族。
 *
 *   改法: 判据从「某个函数在不在」改成「**阴阳判据在生产里真不成立**」——
 *     · 五合判据: getHe 必须给出**真源那五对**, 且五合全异性(合则不克的根据)
 *     · 正偏判据: 十神层 getTenGod 必须真按阴阳分正偏
 *       (克我+同阴阳=七杀 / 异阴阳=正官, 真源《三命通会》3826「官喜正, 不喜偏」)
 *     · 两套编码**必须一致** —— 不一致就报红(交叉校验, 异源尺子)
 */
const WUXING_LAYER_REQUIRED = {
  file: path.join(I64, 'bagua_annotations', 'wuxing_yinyang.js'),
  label: '五行阴阳层',
  exports: ['getHe', 'isOppositeYinYang', 'judgeKeByYinYang', 'judgeShengByYinYang'],
};

// ============================================================
// 层的边界 —— 唯一真源 (头注释里那张表是它的渲染)
// ============================================================

/**
 * 每一层放什么 / 不放什么 —— **数据是唯一真源**。
 *
 * 为什么要数据化 (2026-10-22 当场撞出来的, 不是洁癖):
 *   原来这张表只活在头注释里, 判据活在代码里, 两边**各说一套** ——
 *   注释写「六爻层 不放 老阴老阳」, 代码却**允许**爻值 6/7/8/9
 *   (老阳9/老阴6/少阳7/少阴8, 卦筮的地基编码)。
 *   注释比代码严 → 下一个人照注释去"补禁词", 会把爻值层自己判成越界, 启动即炸;
 *   注释比代码松 → 下一个人以为有守卫, 其实没有。
 *   两种漂移都**安静地**坏掉, 不报错 —— 这就是「注释 ≠ 隔离」的另一面:
 *   注释连**说清楚**都保证不了时, 就更不能指望它能隔离。
 *
 *   所以表搬进代码, 注释渲染自它, 判据由 `checkLayerBoundaryDoc` 兜着:
 *   改表 → 注释必须跟着改(启动自检会炸); 改判据 → 表里的 enforcedBy 必须跟上。
 *
 * `enforcedBy` 是这张表最要紧的一列: 光写「不放五行」没用, 得写清**哪条判据兜住它**。
 * 写不出 enforcedBy 的禁项 = 一句愿望, 不是一道闸。
 */
const LAYER_BOUNDARY = [
  {
    layer: '卦层',
    allow: '阴阳卦、体用、纳甲',
    // 卦层只给**属性**(是什么卦、纳甲是谁), 不判强弱。
    // 变卦路径上不许出现五行生克 —— 那是五行层的活。
    forbid: ['爻变生克'],
    enforcedBy: {
      '爻变生克': ['checkProductionChangePathNoWuxing', 'checkTransformOutputShape'],
    },
  },
  {
    layer: '五行层',
    allow: '五行分阴阳(偏枯/得令之别), 生克强弱在这里判',
    // 爻位五行是**静态属性**: 动的是爻的阴阳, 不是爻位的水火木金土。
    // 这条 2026-10-21 就判对了(方向 C), 只是当时没写进表 —— 禁项不写进表
    // = 下一个人看不到这张表里有这一层职责。
    forbid: ['爻位五行随动爻变'],
    enforcedBy: {
      '爻位五行随动爻变': ['checkYaoPositionWuxingIsStatic'],
    },
  },
  {
    layer: '六爻层',
    allow: '爻位编号防错(0..63) + 爻值 6/7/8/9(老阴/少阳/少阴/老阳) + 引用爻辞原文',
    forbid: ['五行', '纳甲', '爻变生克'],
    enforcedBy: {
      '五行': ['checkYaoLayerNoWuxing', 'checkYaoPositionWuxingIsStatic', 'checkProductionChangePathNoWuxing'],
      '纳甲': ['checkYaoLayerNoWuxing', 'checkHexagramNajiaAnchored'],
      '爻变生克': ['checkTransformOutputShape', 'checkProductionChangePathNoWuxing'],
    },
  },
];

/** 爻值编码词 —— 这些在爻层是**地基**, 谁敢禁谁就是把卦筮拆了 */
const YAO_VALUE_ENCODING_WORDS = ['老阴', '老阳', '少阴', '少阳'];

// ═══════════════════════════════════════════════════════════════
// 编号体系登记表 —— 「派生 还是 独立」(2026-10-23 第 53 批)
// ═══════════════════════════════════════════════════════════════

/**
 * 盘古每一套编号, 到底是**独立**的还是**派生**的 —— **数据是唯一真源**。
 *
 * ── 这张表为什么存在(老板一句话顶掉了我一整段说法) ──
 *   我此前说盘古有「爻位序 / 二进制序 / 后天序」**三套序并存**, 并警告
 *   「三套在 1..7 上完全重叠, 传错基数不报错」。
 *   老板给了他的表:
 *     乾=111=7 兑=110=6 离=101=5 震=100=4 巽=011=3 坎=010=2 艮=001=1 坤=000=0
 *   问: 「你这么考虑是不是就不存在你所谓的三套顺序的问题了?」
 *   实测 8/8 全中 —— **他说得对, 我错了。**
 *
 *   错在: 我把**派生函数**数成了**并列的另一套**。
 *   真正能判「是不是独立」的不是数法, 是一条判据:
 *       **能不能写成对方的函数。** 能 ⇒ 派生, 不算独立。
 *
 *   ⇒ 老板那句话落地成这张表: 每套编号必须交代它**派生自谁**或**为什么独立**,
 *     派生关系还要**当场算一遍**验(见 checkNumberingBasis)。
 *
 * ── 分类结果(全部由下面 verify 实算, 不手写) ──
 *   原子(不可再派生, 整盘的地基):
 *     爻画阴阳 阴=0 阳=1 · 爻位 初爻..上爻
 *   派生(是别人的读法, 换个基数/序就错):
 *     爻值 6/7/8/9 = 爻画阴阳 × 动静两维   ← 老板「爻动阴阳那就太过了」
 *     八卦先天数 1..8 = 8 − parseInt(bits,2)
 *     六十四卦 index 0..63 = 上卦值×8 + 下卦值
 *   独立(写不出函数, **只有这两个**才真是「换序会静悄悄返回另一个卦」):
 *     八卦后天数 1..8(洛书方位) · 在 bits 上非单调: 2,0,4,3,7,6,1,5
 *     六十四卦 id 1..64(文王序/序卦传) · 与 binary 排序不一致
 *
 * ⚠️ 老板 10-22 亲自点过「64卦有一个最大的坑, 不是 1~64 是 0~63」——
 *   那坑的成因就在这张表里: `id`(1..64, 文王序) 和 `index`(0..63, 派生)
 *   是**两个真正独立**的编号, 而它们长得几乎一样(都叫"第几卦")。
 */
const NUMBERING_BASIS = Object.freeze([
  {
    key: 'yaoYinYang',
    layer: '爻画',
    kind: 'atom',
    values: '阴=0 阳=1',
    why: '整盘的地基。八卦三爻码、六爻卦码都由它拼出来, 它自己派不出别的东西。',
  },
  {
    key: 'yaoPosition',
    layer: '爻位',
    kind: 'atom',
    values: '初爻 二爻 三爻 四爻 五爻 上爻',
    why: '位次是**位置**, 不是数值 —— 没有"换个基数"这回事。',
  },
  {
    key: 'yaoValue',
    layer: '爻值',
    kind: 'derived',
    derivesFrom: ['yaoYinYang'],
    values: '6 老阴 / 7 少阳 / 8 少阴 / 9 老阳',
    why: '爻值 = 爻画阴阳 **×** 动静**两维**。'
      + '动爻变的是**动静**那一维(老阳9→阴、老阴6→阳), 阴阳那一维另由爻画还原 —— '
      + '老板 10-21 原话「爻动阴阳那就太过了」, 指的就是不许把这两维混成一维。',
    verify: (m) => {
      const problems = [];
      const cells = new Set();
      for (const [name, v] of Object.entries(m.YAO_VALUES)) {
        const yinYang = m.yaoToBinary(v);
        const movement = m.getMovement(v);
        cells.add(yinYang + '/' + movement);
        // 爻值的个位**不该**直接等于爻画: 9 是阳(爻画1) 但 9%2=1 巧合对,
        //   8 是阴(爻画0) 但 8%2=0 也巧合对 —— 所以这条对老少都成立,
        //   一旦有人把爻值和爻画混用(比如拿爻值当爻画), 这里就是第一道报警。
        if (v % 2 !== yinYang) {
          problems.push(name + '(' + v + ') 的个位(' + (v % 2) + ') ≠ 爻画(' + yinYang
            + ') —— 爻值与爻画是两维, 混用会把动静当阴阳');
        }
      }
      if (cells.size !== 4) {
        problems.push('爻值的阴阳×动静只覆盖 ' + cells.size + '/4 种组合 —— 不是完整的 2×2');
      }
      return problems;
    },
  },
  {
    key: 'baguaXianTian',
    layer: '八卦',
    kind: 'derived',
    derivesFrom: ['yaoYinYang'],
    values: '乾1 兑2 离3 震4 巽5 坎6 艮7 坤8',
    why: '先天数 = 8 − parseInt(bits, 2)。**单调递减**, 8/8 成立 ⇒ 它是爻画的读法, 不是另一套序。',
    verify: (m) => {
      const bad = m.BAGUA_AXIOMS.filter((a) => a.trigramIndex !== 8 - parseInt(a.bits, 2));
      if (bad.length) {
        return bad.map((a) => a.name + ' bits=' + a.bits + ' ⇒ 先天数应为 ' + (8 - parseInt(a.bits, 2))
          + ' 实为 ' + a.trigramIndex);
      }
      const byValue = m.BAGUA_AXIOMS.slice()
        .sort((x, y) => parseInt(x.bits, 2) - parseInt(y.bits, 2))
        .map((a) => a.trigramIndex);
      if (byValue.join(',') !== '8,7,6,5,4,3,2,1') {
        return ['按 bits 升序, 先天数应严格递减 8..1, 实为 ' + byValue.join(',')];
      }
      return [];
    },
  },
  {
    key: 'baguaHouTian',
    layer: '八卦',
    kind: 'independent',
    independentOf: ['yaoYinYang'],
    values: '坎1 坤2 震3 巽4 乾5 兑6 艮7 离8',
    why: '后天序是**洛书方位**(地理), 与爻画无关。'
      + '它在自己的 verify 里被证明: 在 bits 上**非单调**, 写不成函数 ⇒ 只能查表。'
      + '**这才是「换序会静悄悄返回另一个卦」唯一真实成立的地方。**',
    verify: (m) => {
      const byName = {};
      for (const a of m.BAGUA_AXIOMS) byName[a.name] = a.bits;
      const v = m.HOU_TIAN_SEQ.map((s) => parseInt(byName[s.name], 2));
      const problems = [];
      if (v.every((x, i) => i === 0 || x > v[i - 1])) {
        problems.push('后天数在 bits 上竟然单调(' + v.join(',')
          + ') —— 那它就该写得成函数, 不该标"独立"。表和数据对不上');
      }
      if (new Set(v).size !== 8) {
        problems.push('后天序对应的 bits 值不是 8 个互异值: ' + v.join(',') + ' —— 查表表本身坏了');
      }
      return problems;
    },
  },
  {
    key: 'guaIndex',
    layer: '六十四卦',
    kind: 'derived',
    derivesFrom: ['yaoYinYang'],
    values: '0..63 = 上卦值×8 + 下卦值',
    why: 'index 与 binary 是同一组 6 位的两种排法(index=上卦‖下卦, binary=下卦‖上卦)。'
      + '**0 基** —— 老板 10-22 原话「64卦有一个最大的坑, 不是 1~64 是 0~63」。',
    verify: (m) => {
      const v = (s) => parseInt(s.join(''), 2);
      const bad = m.HEXAGRAMS.filter((g) => {
        const b = g.binary.split('');
        return v(b.slice(3, 6)) * 8 + v(b.slice(0, 3)) !== g.index;
      });
      return bad.length ? bad.map((g) => g.name + '(id' + g.id + ') 的 index 与 binary 对不上') : [];
    },
  },
  {
    key: 'guaId',
    layer: '六十四卦',
    kind: 'independent',
    independentOf: ['yaoYinYang'],
    values: '1..64 文王序',
    why: '文王序(序卦传)是**传统编次**, 与爻画的二进制排序不一致 ⇒ 独立, 只能查表。'
      + '它和 `index`(0..63 派生)长得极像(都叫"第几卦"), 混用就是老板点过的那个坑。',
    verify: (m) => {
      const sortedByIndex = m.HEXAGRAMS.slice().sort((a, b) => a.index - b.index);
      if (sortedByIndex.every((g, i) => g.id === i + 1)) {
        return ['文王序(id)竟然就等于 index 排序 —— 那它是派生的, 表里标"独立"是错的'];
      }
      const problems = [];
      if (m.HEXAGRAMS.length !== 64) problems.push('卦数不是 64, 实为 ' + m.HEXAGRAMS.length);
      if (new Set(m.HEXAGRAMS.map((g) => g.id)).size !== 64) problems.push('id 不是 64 个互异值');
      if (new Set(m.HEXAGRAMS.map((g) => g.index)).size !== 64) problems.push('index 不是 64 个互异值');
      return problems;
    },
  },
]);

/** 渲染成 Markdown 行 —— 头注释里那张表就是它渲染出来的 */
function renderLayerBoundaryRows() {
  return LAYER_BOUNDARY.map(r => {
    const forbid = r.forbid.length ? r.forbid.join('/') : '—';
    return `| ${r.layer} | ${r.allow} | ${forbid} |`;
  });
}

/**
 * 编号体系对账: 每一套要么给出 `derivesFrom`, 要么给出 `independentOf` + 理由;
 * 凡是 derived 的, **当场算一遍**验。
 *
 * ⚠️ 为什么「derived 却没 verify」要直接报红:
 *   「先天数是 bits 的读法」这句话, 如果只写在表里而没人算, 那它就是我上一轮
 *   批评切片头的那句话 —— **一句没人核过的漂亮话**。
 *   而且老板已经证明过这类声明会骗人: 我据「三套序」讲了一整轮, 老板一问就穿。
 *
 * @param {{modules?:object, basis?:Array}} opts
 * @returns {{ok:boolean, violations:string[], results:Array}}
 */
function checkNumberingBasis(opts = {}) {
  const basis = opts.basis || NUMBERING_BASIS;
  const violations = [];
  const results = [];

  // 懒加载: 守卫不该在装载期把整个内核拉起来。
  const M = opts.modules || {
    yy: require(path.join(I64, 'yin_yang.js')),
    ax: require(path.join(I64, 'bagua_annotations', 'bagua_axioms.js')),
    pos: require(path.join(I64, 'bagua_annotations', 'bagua_positions.js')),
    hex: require(path.join(I64, 'hexagrams.js')),
  };
  const mods = {
    YAO_VALUES: M.yy.YAO_VALUES,
    yaoToBinary: M.yy.yaoToBinary,
    getMovement: M.yy.getMovement,
    BAGUA_AXIOMS: M.ax.BAGUA_AXIOMS,
    HOU_TIAN_SEQ: M.pos.HOU_TIAN_SEQ,
    HEXAGRAMS: M.hex.HEXAGRAMS || M.hex,
  };

  const keys = new Set(basis.map((r) => r.key));
  for (const r of basis) {
    // ① 自报家门
    if (r.kind === 'derived') {
      if (!Array.isArray(r.derivesFrom) || !r.derivesFrom.length) {
        violations.push('[编号表] ' + r.key + ' 标成 derived 却没有 derivesFrom —— 空头声明');
      }
      for (const d of r.derivesFrom || []) {
        if (!keys.has(d)) {
          violations.push('[编号表] ' + r.key + ' 说派生自「' + d + '」, 但表里没有这一项');
        }
      }
    } else if (r.kind === 'independent') {
      if (!Array.isArray(r.independentOf) || !r.independentOf.length) {
        violations.push('[编号表] ' + r.key + ' 标成 independent 却没有 independentOf');
      }
      if (!r.why || r.why.length < 10) {
        violations.push('[编号表] ' + r.key + ' 标成 independent 却没写理由 —— '
          + '"独立"是结论不是事实, 得说清为什么写不出函数');
      }
    } else if (r.kind !== 'atom') {
      violations.push('[编号表] ' + r.key + ' 的 kind 是「' + r.kind
        + '」, 不在 (atom / derived / independent) 里');
    }

    // ② verify 当场跑
    if (typeof r.verify === 'function') {
      let problems;
      try {
        problems = r.verify(mods) || [];
      } catch (e) {
        problems = [r.key + ' 的 verify 抛异常: ' + e.message];
      }
      results.push({ key: r.key, kind: r.kind, problems });
      for (const p of problems) violations.push('[编号表] ' + r.key + '(' + r.kind + ') ' + p);
    } else if (r.kind === 'derived') {
      violations.push('[编号表] ' + r.key + ' 是 derived 却没有 verify —— '
        + '「派生」这个声明不验, 就是一句没人核过的漂亮话');
    }
  }

  // ③ 一个 independent 都没有 ⇒ 那就全是派生, 「换序会返另一个卦」没有落点
  if (!basis.some((r) => r.kind === 'independent')) {
    violations.push('[编号表] 一套 independent 都没有 —— 那就全是派生, '
      + '"传错序会静悄悄返回另一个卦"这句话就没有落点');
  }
  // ④ 反过来也不该全是 independent —— 那说明没人算过派生
  if (!basis.some((r) => r.kind === 'derived')) {
    violations.push('[编号表] 一套 derived 都没有 —— 全独立等于"一个东西抄了很多遍"');
  }

  return { ok: violations.length === 0, violations, results };
}

/**
 * 编号表 ↔ 头注释那张表对账 —— 跟 checkLayerBoundaryDoc 同一机制。
 *
 * ⚠️ 为什么这张表必须核对, 不能只写不管(第 51 批的教训):
 *   切片头那句「上经 30 卦(180 爻位)逐字可比」能一直挂着假, 就是因为
 *   **没人核对散文声明里的数字**。表也是声明 —— 数据改了表没跟上,
 *   下一个人照着过期的表理解盘古, 比没有表更坏。
 */
function checkNumberingBasisDoc(opts = {}) {
  const violations = [];
  const src = opts.src !== undefined ? opts.src : readIfExists(__filename);
  const basis = opts.basis || NUMBERING_BASIS;
  if (src === null) {
    return { ok: false, violations: ['读不到本模块源码 —— 编号表没法核对'], rows: [] };
  }
  // ⚠️ 认领表头是「编号」的那张表, 别把层表的行吃进来。
  const rows = parseLayerBoundaryDocOnly(src, '编号');
  const byKey = new Map(rows.map((r) => [r[0].split('·')[1].trim(), r]));

  for (const r of basis) {
    const label = r.layer + ' · ' + r.key;
    const got = byKey.get(r.key);
    if (!got) {
      violations.push('[编号表] 头注释里没有「' + label + '」这一行 —— 表和数据对不上');
      continue;
    }
    if (got[1] !== r.values) {
      violations.push('[编号表] 「' + label + '」的取值与 NUMBERING_BASIS 不一致:\n'
        + '        注释: ' + got[1] + '\n        数据: ' + r.values);
    }
    const rel = r.kind === 'atom' ? '原子'
      : r.kind === 'derived' ? '派生自 ' + (r.derivesFrom || []).join('+')
        : '独立于 ' + (r.independentOf || []).join('+');
    if (got[2] !== rel) {
      violations.push('[编号表] 「' + label + '」的关系与 NUMBERING_BASIS 不一致:\n'
        + '        注释: ' + got[2] + '\n        数据: ' + rel);
    }
  }
  for (const got of rows) {
    const key = got[0].split('·')[1].trim();
    if (!basis.some((r) => r.key === key)) {
      violations.push('[编号表] 头注释里多出一行「' + got[0] + '」—— NUMBERING_BASIS 里没有它');
    }
  }
  return { ok: violations.length === 0, violations, rows };
}

/** 渲染成 Markdown 行 —— 头注释里那张表就是它渲染出来的 */
function renderNumberingBasisRows() {
  return NUMBERING_BASIS.map((r) => {
    const rel = r.kind === 'atom' ? '原子'
      : r.kind === 'derived' ? '派生自 ' + (r.derivesFrom || []).join('+')
        : '独立于 ' + (r.independentOf || []).join('+');
    return `| ${r.layer} · ${r.key} | ${r.values} | ${rel} |`;
  });
}

// ============================================================
// 工具
// ============================================================

/** 剥掉注释, 只留真代码 —— 否则判据会把自己判成违规 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 再剥掉字符串字面量 —— 只留**标识符与关键字**。
 *
 * ⚠️ 为什么必须剥 (2026-10-22 实测踩到):
 *   判据扫的是 `code.includes('wuxing')`。而
 *       const rel = require('.../wuxing_axioms.js');
 *   这行里也有 "wuxing" —— 但那是**文件名**, 不是"爻层在用五行"。
 *   于是 require 越层依赖的负例, 被"源码 token"这条判据抢先命中,
 *   闭包判据永远轮不到 —— 看着像"守卫抓到了", 实际测的是另一条规则。
 *   这就是「断言报错先怀疑尺子」。
 *
 *   真正的越界是**代码逻辑**用了五行(调 getRelation / 读 wuxing 字段),
 *   那些是标识符, 剥掉字符串后依然在。文件名不是。
 */
function stripStrings(src) {
  return src
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

/** 剥注释 + 剥字符串 → 只剩真代码 */
function codeOnly(src) {
  return stripStrings(stripComments(src));
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

// ============================================================
// 方向 A: 爻层零五行 / 零纳甲
// ============================================================

/**
 * 收集一个模块的 require 闭包(只看相对路径的本仓模块)。
 * 比文本扫描强: 就算有人用变量拼路径 require, 闭包里也藏不住。
 */
function collectRequireClosure(entryFile, maxDepth = 6) {
  const seen = new Set();
  const closure = new Set();
  const queue = [{ file: entryFile, depth: 0 }];
  while (queue.length) {
    const { file, depth } = queue.shift();
    if (seen.has(file) || depth > maxDepth) continue;
    seen.add(file);
    const src = readIfExists(file);
    if (src === null) continue;
    // 闭包扫描要**保留** require 的路径字符串, 否则解析不出依赖
    const code = stripComments(src);
    const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      const spec = m[1];
      // 只查**本仓内**的模块: 相对路径(./ ../) 或指向本仓的绝对路径。
      // 外部 npm 包一律不查 —— 那是第三方的事, 跟爻层边界无关。
      //
      // ⚠️ 绝对路径必须一起查 (2026-10-22 实测踩到):
      //   早先只查 `spec.startsWith('.')`, 绝对路径直接 `continue` 跳过 ——
      //   于是「爻层 require 了五行模块」这条负例**通过了**(漏检)。
      //   漏检比误伤更贵, 尤其这种"看着像测过了"的漏检。
      let resolved = null;
      if (spec.startsWith('.')) {
        resolved = path.resolve(path.dirname(file), spec) + '.js';
      } else if (path.isAbsolute(spec)) {
        resolved = spec.endsWith('.js') ? spec : spec + '.js';
        // 绝对路径不在本仓内 → 不查
        if (!resolved.startsWith(CORE + path.sep)) continue;
      } else {
        continue; // 外部包
      }
      if (!fs.existsSync(resolved)) continue;
      closure.add(resolved);
      queue.push({ file: resolved, depth: depth + 1 });
    }
  }
  return closure;
}

/**
 * 方向 A 主体
 * @param {{modules?: Array}} [opts] - modules 可注入, 便于喂负例
 * @returns {{ok: boolean, violations: string[], checks: object}}
 */
function checkYaoLayerNoWuxing(opts = {}) {
  const violations = [];
  const detail = {};
  const modules = opts.modules || YAO_LAYER_MODULES;

  for (const { file, label } of modules) {
    const src = readIfExists(file);
    if (src === null) {
      violations.push(`[${label}] 文件不存在: ${file}`);
      continue;
    }
    // 源码 token 扫描要**剥掉**字符串字面量 ——
    // 否则 `require('.../wuxing_axioms.js')` 这种**文件名**会被当成"爻层在用五行"。
    const code = codeOnly(src);

    // A1: 源码里不得出现五行/纳甲 token
    for (const { token, why } of FORBIDDEN_IN_YAO_LAYER) {
      if (code.includes(token)) {
        const lineNo = code.slice(0, code.indexOf(token)).split('\n').length;
        violations.push(`[${label}] 源码出现禁止 token "${token}" (第 ${lineNo} 行附近) —— ${why}`);
      }
    }

    // A2: require 闭包里不得有五行/纳甲模块
    const closure = collectRequireClosure(file);
    const banned = [];
    for (const f of closure) {
      const base = path.basename(f);
      // wuxing_* / najia* 是五行纳甲系模块
      if (/^wuxing_/i.test(base) || /najia/i.test(base)) banned.push(f);
      // yao_axioms.js 也不许被爻层 require —— 爻位五行是静态属性,
      // 属于卦层体用的输入, 爻层不该去取
      if (base === 'yao_axioms.js') banned.push(f);
    }
    detail[label] = { closureSize: closure.size, banned: banned.map(f => path.relative(CORE, f)) };
    for (const f of banned) {
      violations.push(
        `[${label}] require 闭包里出现了越层模块 ${path.relative(CORE, f)} —— ` +
        '爻层不许依赖五行/纳甲层, 那是卦层/五行层的东西'
      );
    }
  }

  return { ok: violations.length === 0, violations, checks: detail };
}

// ============================================================
// 方向 B: 五行层必须有阴阳(防「删光就通过」)
// ============================================================

function checkWuxingLayerHasYinyang(opts = {}) {
  const violations = [];
  const { file, label, exports: required } = opts.required || WUXING_LAYER_REQUIRED;
  let mod = null;
  try {
    mod = require(file);
  } catch (e) {
    violations.push(`[${label}] 加载失败: ${e.message}`);
    return { ok: false, violations };
  }
  for (const fn of required) {
    if (typeof mod[fn] !== 'function') {
      violations.push(
        `[${label}] 缺少导出 "${fn}" —— 五行层必须有阴阳维度(老板 10-21:「五行有阴阳」)`
        + (fn === 'judgeKeByYinYang' || fn === 'judgeShengByYinYang'
          ? '。注意: 这两个是**交叉校验的一端**(与十神层正偏判据对撞, 见 B3), '
            + '**不是**生产路径 —— 生产走十神层(正官/七杀)。'
          : '')
      );
    }
  }
  // ⚠️ 第 39 批: 光「导出在不在」是**假守卫**(见 WUXING_LAYER_REQUIRED 头注释)。
  //   下面加的是**真判据**: 阴阳判据在生产里到底成不成立。
  //   判据用**真源**当尺子, 不用被测对象自己当尺子(同源=恒真守卫)。
  violations.push(...checkYinyangJudgeReal(opts));
  // 该层自带的装时自检也要能跑通(它校验天干阴阳各 5、五合全异性)
  if (typeof mod._assertYinyangLayer === 'function') {
    try {
      mod._assertYinyangLayer();
    } catch (e) {
      violations.push(`[${label}] 自检不通过: ${e.message}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * 方向 B 的**真判据**: 阴阳判据在生产里成不成立。
 *
 * 拆成三段, 每段都有**异源尺子**:
 *
 *   B1 五合判据 —— `getHe` 必须给出真源那五对(甲己/乙庚/丙辛/丁壬/戊癸),
 *      且**五合全是异性**。这是「合则不克」的根据:
 *      真源《三命通会》1753「唯阴见阳, 阳见阴为合」——
 *      五合之所以能成立, 前提就是异性; 改成同性, 整层塌。
 *      尺子: 文件头那份**写死的真源对表**(不是被测对象自己吐的)。
 *
 *   B2 正偏判据 —— 十神层 `getTenGod` 必须真按阴阳分正偏:
 *      克我 + 同阴阳 = 七杀(偏官) / 异阴阳 = 正官。
 *      **这才是生产真正走的那条路**(`wuxing_strength` 的 polarity 取
 *      sameTenGod/diffTenGod, 再进 `bazi_strength` 的结论文案)。
 *      尺子: `ten_gods.js` 的 YIN_YANG + KE 表, 与 getTenGod 的返回**逐对核**。
 *
 *   B3 两套编码一致 —— `judgeKeByYinYang` 的 force(full=同阴阳/偏官那一路,
 *      weaken=异阴阳/正官那一路; **不是力度刻度**, 见第 49 批)
 *      必须与 B2 的正偏**一一对应**。这是**交叉校验**:
 *      两层判据是**独立写的**(一个查《三命通会》1753 的合/相竞,
 *      一个查 3826 的正偏), 所以它们一致 = 两条独立路径撞到同一个真相。
 *      不一致 = 至少有一层错了, 必须报出来。
 *
 * ⚠️ 为什么 B3 只「交叉校验」而**不**要求 `judgeKeByYinYang` 必须被生产调用:
 *   它是十神层的第二份编码, 生产走十神那条更老、被真源锁定的路。
 *   把它接进生产 = 两套编码并行 ⇒ 迟早只改其中一份(项目铁律)。
 *   所以它留在本层做**判据出处**, 由 B3 盯着它不许漂。
 *
 * @param {object} [opts] 可注入 yinyang / tenGods (负例用)
 * @returns {string[]} violations
 */
function checkYinyangJudgeReal(opts = {}) {
  const violations = [];

  // ---------- B1: 五合判据 ----------
  let wy = null;
  try {
    wy = opts.yinyang || require(path.join(I64, 'bagua_annotations', 'wuxing_yinyang.js'));
  } catch (e) {
    violations.push(`[五行阴阳层] 加载失败: ${e.message}`);
    return violations;
  }
  // 真源那五对(《三命通会》1756-1766 逐对给出), 写死当尺子
  const SOURCE_HE_PAIRS = ['甲己', '乙庚', '丙辛', '丁壬', '戊癸'];
  // 阴阳表 —— 用来把「阳干在前」的键归一化成真源写法(见下面 normPair)
  //
  // ⚠️ 这里**不能**用被测的十神层那份 YIN_YANG(第 39 批踩到):
  //   尺子和被测对象同源 = 尺子跟着被测对象一起坏 ⇒ 归因全错。
  //   实跑: 十神层阴阳全坏时, 归一化跟着坏, 于是「庚乙」被判成
  //   「多出真源没有的合」—— 结论看着对(确实坏了), 但**归因指向五行层**,
  //   下一个人会去改那个无辜的地方(项目铁律: 报错对象错了, 跟没报一样有害)。
  //   ⇒ 归一化用**独立写死的**阴阳表当尺子(天干阴阳是定死的, 不随判据变)。
  const GAN_YIN_YANG_FIXED = Object.freeze({
    甲: '阳', 乙: '阴', 丙: '阳', 丁: '阴', 戊: '阳',
    己: '阴', 庚: '阳', 辛: '阴', 壬: '阳', 癸: '阴',
  });
  let WY_YIN_YANG = null;
  try {
    const tgSrc = opts.tenGods || require(path.join(I64, 'bazi', 'ten_gods.js'));
    WY_YIN_YANG = tgSrc.YIN_YANG || null;
  } catch (e) {
    // 取不到就由下面的 B2 报「十神层加载失败」, 这里不重复报
  }
  if (typeof wy.getHe !== 'function') {
    violations.push('[五行阴阳层] getHe 不是函数 —— 「合则不克」无从判');
  } else {
    for (const pair of SOURCE_HE_PAIRS) {
      const a = pair[0], b = pair[1];
      const r = wy.getHe(a, b);
      if (!r) {
        violations.push(
          `[五行阴阳层] 真源五合 "${pair}" 判不出来 —— `
          + '「合则不克」整条判据塌了(老板 10-21:「阳火用阴水可能就克不了」)'
        );
        continue;
      }
      // 合化出的五行必须有 —— 老板那句「反而会助火」说的就是合化改变走向
      if (!r.hua || !['金', '木', '水', '火', '土'].includes(r.hua)) {
        violations.push(
          `[五行阴阳层] 五合 "${pair}" 的化出五行是 ${JSON.stringify(r.hua)} —— `
          + '真源给了甲己合土/乙庚合金/丙辛合水/丁壬合木/戊癸合火, 化不出来就不成立'
        );
      }
    }
    // 反向: 不得有多余的合(凭空多出来的合 = 编的)
    //   ⚠️ 键的写法有坑: `GAN_HE` 的键是**阳干在前**(庚乙/壬丁),
    //   而真源原文写的是「乙庚」「丁壬」—— 所以必须按**对**归一化后比,
    //   直接比键会报出「多出真源没有的合 庚乙」这种假阳性。
    const normPair = (p) => {
      const a = p[0], b = p[1];
      // 归一化用**固定的**阴阳表, 不用被测层的那份(见上面说明)
      const yyA = GAN_YIN_YANG_FIXED[a] || (WY_YIN_YANG && WY_YIN_YANG[a]);
      const first = yyA === '阳' ? a : b;
      return first + (first === a ? b : a);
    };
    for (const key of Object.keys(wy.GAN_HE || {})) {
      const norm = normPair(key);
      if (!SOURCE_HE_PAIRS.map(normPair).includes(norm)) {
        violations.push(
          `[五行阴阳层] 多出真源没有的合 "${key}" —— `
          + '真源五合只有甲己/乙庚/丙辛/丁壬/戊癸五对'
        );
      }
    }
  }

  // ---------- B2 + B3: 正偏判据 + 两套编码交叉校验 ----------
  let tg = null;
  try {
    tg = opts.tenGods || require(path.join(I64, 'bazi', 'ten_gods.js'));
  } catch (e) {
    violations.push(`[十神层] 加载失败: ${e.message}`);
    return violations;
  }
  if (typeof tg.getTenGod !== 'function') {
    violations.push('[十神层] getTenGod 不是函数 —— 正偏判据无从验');
    return violations;
  }
  const GAN = tg.TIAN_GAN || [];
  const WX = tg.WUXING || {};
  const YY = tg.YIN_YANG || {};
  const KE = tg.KE || {};
  if (!GAN.length || !Object.keys(WX).length || !Object.keys(YY).length || !Object.keys(KE).length) {
    violations.push('[十神层] 天干/五行/阴阳/克表不全 —— 正偏判据无从验');
    return violations;
  }

  let checked = 0;
  let mismatch = 0;
  for (const self of GAN) {
    for (const other of GAN) {
      if (self === other) continue;
      if (KE[WX[other]] !== WX[self]) continue;   // 只看 other 克 self 的组合
      checked++;
      // B2: 十神层必须真按阴阳分正偏
      const expect = YY[self] === YY[other] ? '七杀' : '正官';
      const got = tg.getTenGod(self, other);
      if (got !== expect) {
        mismatch++;
        violations.push(
          `[十神层] ${self}(${YY[self]}) 见 ${other}(${YY[other]}) 得 "${got}", `
          + `真源是 "${expect}" —— 阴阳正偏判据坏了 `
          + '(真源《三命通会》3826:「故甲见辛为正官, 见庚为偏官。官喜正, 不喜偏」)'
        );
      }
      // B3: 两套编码必须一致
      if (typeof wy.judgeKeByYinYang === 'function') {
        const j = wy.judgeKeByYinYang(self, other);
        if (j && j.established) {
          const expectForce = YY[self] === YY[other] ? 'full' : 'weaken';
          if (j.force !== expectForce) {
            mismatch++;
            violations.push(
              `[五行阴阳层] ${self} 见 ${other} 的同异阴阳档是 ${j.force}, `
              + `按阴阳应是 ${expectForce} —— 与十神层正偏判据对不上, `
              + '两套编码必须指向同一个真相'
            );
          }
        }
      }
    }
  }
  if (checked === 0) {
    violations.push('[十神层] 一对克关系都没数出来 —— 这条判据没法验');
  }

  // ---------- B1b: 生边上五合不成立(五合全是克边) ----------
  //   真源 1753-1766 逐对给的五合: 甲己(木克土) / 乙庚(金克木) /
  //   丙辛(金克火) / 丁壬(水克火) / 戊癸(土克水) —— **全是克边**。
  //   所以「生我者/同我者」那两格**不可能**被合废掉。
  //   这条不是形式检查: 一旦哪天真出现「生边有合」, 老板那句
  //   「合则不克」的适用范围就变了, 整个合化层的读法要重定。
  //   尺子: `judgeShengByYinYang` 自己(它就是为这条准备的), 配真源五合表。
  if (typeof wy.judgeShengByYinYang === 'function') {
    for (const self of (tg.TIAN_GAN || [])) {
      for (const other of (tg.TIAN_GAN || [])) {
        if (self === other) continue;
        const r = wy.judgeShengByYinYang(self, other);
        if (!r || r.affinity !== 'sheng') continue;   // 只看生边
        if (r.he) {
          violations.push(
            `[五行阴阳层] 生边上出现了合: ${self} 见 ${other} 判为生, 却有合 `
            + `(${r.he.pair}合${r.he.hua}) —— 真源五对全是克边, 生边不该有合。`
            + '「合则不克」的适用范围变了, 合化层读法要重定。'
          );
        }
      }
    }
  }
  return violations;
}

// ============================================================
// 方向 C: 爻的五行**只有一个来源** —— 该爻的纳甲地支五行(卦层)
//         且**不随动爻变**
// ============================================================

/**
 * ★ 第 36 批把这道判据**整个换了前提**, 名字保留。
 *
 * 它原来验的是「爻位固定五行表(初水二木三火四金五土上火)是静态的」。
 * 现在那张表**没了** —— 查无出处, 且与真纳甲地支在 4 个可验卦上冲突 20/24
 * (详见 `64i/bagua_annotations/yao_axioms.js` 头注释的三条理由)。
 * 判据若还留着, 就成了「守着一张已经不存在的表的守卫」——
 * 正是本文件头注释里说的「以为有守卫, 其实没有」。
 *
 * 老板那句「爻动阴阳那就太过了」, 在数据上的准确落地是:
 *     **爻的五行来自纳甲(卦层), 而纳甲只由卦的上下卦决定, 与动没动无关。**
 * 所以新的判据问四个问题, 每一个都有机械判据:
 *
 *   C1 爻位公理层**不得带 wuxing 字段** —— 假表不许回来。
 *       (它一回来, 就有第二个来源, 而两个来源在 20/24 的爻位上打架。)
 *   C2 `getYaoPositionAxiom(pos, 任意第二参)` 的返回**结构**不得随第二参变 ——
 *       接口语义: 爻位不看爻值。哪天有人加第二参做「动爻换五行」, 这里立刻响。
 *   C3 `getYaoVector(guaId, idx).yaoWuxing` **必须等于**纳甲地支五行 ——
 *       五行只有一个来源, 同源一致性由这条钉住。
 *   C4 爻值 6/7/8/9 **不许改变**爻五行, 也不许翻转本卦爻位的阴阳 ——
 *      对每个能装卦的卦 × 每个爻位, 把**真卦真爻位**的静爻值/动爻值
 *      真送进向量层, 断言 yaoWuxing 两态相同、movement 随之而变、
 *      矛盾爻值被拒。⚠️ 第 37 批之前这一条是**恒真**的(爻值压根没进被测路径)。
 *   C5 纳甲装不出的卦, 爻五行**必须为空** —— 不许拿别的东西顶
 *       (「诚实的空」与「拿假数据填」是两回事)。
 *   C6 **反向**: 乾卦六爻的六亲必须都算得出来 ——
 *       防「把五行功能全删光也能通过」那道已知的守卫失效方式。
 *
 * ⚠️ 为什么 C3/C4 要用**纳甲**当尺子, 而不是拿 `getYaoVector` 自己当尺子:
 *   尺子和被测对象同源 = 恒真守卫(本文件头注释里那条老教训)。
 *   纳甲表(`najia.js`)有真源出处、有装时自检、跟 `hexagram_vector` 走的是两条路 ——
 *   它才是这里唯一配得上的**异源尺子**。
 */
function checkYaoPositionWuxingIsStatic(opts = {}) {
  const violations = [];
  let yaoAxioms = null;
  try {
    yaoAxioms = opts.yaoAxioms || require(YAO_AXIOM_FILE);
  } catch (e) {
    violations.push(`[爻位公理层] 加载失败: ${e.message}`);
    return { ok: false, violations };
  }

  const axioms = yaoAxioms.YAO_POSITION_AXIOMS || [];
  if (axioms.length !== 6) {
    violations.push(`[爻位公理层] 应有 6 个爻位, 实为 ${axioms.length}`);
    return { ok: false, violations };
  }

  // ── C1: 爻位公理层不许再带五行 ──
  for (const ax of axioms) {
    if ('wuxing' in ax) {
      violations.push(
        `[爻位公理层] 爻位 ${ax.position} 又长出了 wuxing="${ax.wuxing}" —— `
        + '那张「爻位固定五行」表查无出处, 且与真纳甲地支在 4 个可验卦上冲突 20/24。'
        + '爻的五行只有一个来源: 该爻的纳甲地支五行(najia.js)。'
      );
    }
  }

  // ── C2: 接口语义 —— 爻位不看爻值 ──
  for (let pos = 0; pos < 6; pos++) {
    const base = yaoAxioms.getYaoPositionAxiom(pos);
    if (!base) {
      violations.push(`[爻位公理层] 取不到爻位 ${pos}`);
      continue;
    }
    for (const v of [6, 7, 8, 9]) {
      const asked = yaoAxioms.getYaoPositionAxiom(pos, v);
      if (!asked) continue;
      // 整份结构逐键比 —— 只比 wuxing 的话, C1 撤掉 wuxing 后这条就恒真了
      const extraKeys = Object.keys(asked).filter(k => !(k in base));
      if (extraKeys.length) {
        violations.push(
          `[爻位公理层] getYaoPositionAxiom(${pos}, ${v}) 多了字段 ${extraKeys.join(',')} —— `
          + '爻位公理是静态属性, 不许看爻值(第二参应被忽略)'
        );
      }
      for (const k of Object.keys(base)) {
        if (asked[k] !== base[k]) {
          violations.push(
            `[爻位公理层] getYaoPositionAxiom(${pos}, ${v}) 的 "${k}" 是 ${asked[k]}, `
            + `不带第二参时是 ${base[k]} —— 爻位公理不许随爻值变`
          );
        }
      }
    }
  }

  // ── C3/C4/C5: 五行只有一个来源, 且不随动爻变 ──
  let yy = null, hv = null, najia = null;
  try {
    yy = opts.yinYang || require(path.join(I64, 'yin_yang.js'));
  } catch (e) {
    violations.push(`[爻值层] 加载失败: ${e.message}`);
    return { ok: false, violations };
  }
  try {
    hv = opts.hexagramVector || require(path.join(I64, 'hexagram_vector.js'));
  } catch (e) {
    violations.push(`[爻向量层] 加载失败: ${e.message}`);
    return { ok: false, violations };
  }
  try {
    najia = opts.najia || require(path.join(I64, 'bagua_annotations', 'najia.js'));
  } catch (e) {
    violations.push(`[纳甲层] 加载失败: ${e.message}`);
    return { ok: false, violations };
  }

  const loadable = najia.loadableGuaIds ? najia.loadableGuaIds() : [];
  // ⚠️ 纳甲是**按爻**算的, 不是按整卦: 一个卦只要**一半**的上下卦是乾/坤,
  //   那一半的三爻就装得出来(内三爻取下卦纳甲)。所以「能不能装」必须逐爻判 ——
  //   第 41 批: 八卦地支 8/8 补齐 ⇒ 实算 384/384 装得出。
  //   第 36 批一开始我按「整卦」判, 结果 C5 把 24 个半边卦的**有据可查的半边**
  //   也报成「拿别的东西顶」—— 守卫自己把对的判成错的, 比没有守卫更坏。
  for (let id = 1; id <= 64; id++) {
    for (let pos = 0; pos < 6; pos++) {
      const gz = najia.getYaoGanzhi(id, pos + 1);
      if (!gz.ok) continue;   // 这一爻没尺子, 无从比起(下面 C5 反过来查它必须为空)
      const vec = hv.getYaoVector(id, pos);
      if (!vec) {
        violations.push(`[爻向量层] 卦 ${id} 第 ${pos + 1} 爻取不到向量 —— 这条判据没法验了`);
        continue;
      }
      if (vec.yaoWuxing !== gz.wuxing) {
        violations.push(
          `[爻向量层] 卦 ${id} 第 ${pos + 1} 爻五行是 ${vec.yaoWuxing}, `
          + `纳甲地支 ${gz.dianzhi} 的五行是 ${gz.wuxing} —— `
          + '爻的五行只有一个来源: 纳甲地支五行'
        );
      }

      // ── C4: 爻值只改「动静」, 不改「五行」也不改「阴阳」 ──
      //   老板 10-21 原话「爻动阴阳那就太过了」在数据层的准确落地:
      //     · 爻值 6/7/8/9 影响 movement(静/动) —— 卦筮地基, 必须接;
      //     · 爻值**不影响** yaoWuxing —— 爻五行唯一来源是纳甲地支五行;
      //     · 爻值**不翻转**本卦爻位的阴阳 —— 阴阳翻转发生在**变卦**里。
      //
      //   ⚠️ **这一段原来是个恒真的假判据**(2026-10-22 第 37 批实跑抓出来):
      //     ① `hv.getYaoVector(id, pos)` 只传两参 ⇒ **爻值根本没进被测路径**,
      //        向量层内部自己按 binary 推爻值(阳→7/阴→8), movement 恒为 'static'。
      //        所以「四个爻值下爻五行都不许变」= 同一个调用比了四遍, 结论必然成立。
      //     ② `const yao6 = [7,8,7,8,7,8]` 是**编造的假卦**, 跟 id 无关;
      //        `yy.buildTransformedHexagram(yao6)` 推的是那个假卦的变卦 ——
      //        「实跑一遍变卦」名不副实。
      //     ③ 更狠的一条(当时): 真纳甲表只覆盖乾/坤两卦 ⇒ **96 个装得出纳甲的爻位,
      //        其变卦的纳甲 100% 装不出** ⇒ 「本卦五行 vs 变卦五行」这条比较
      //        路径**一颗牙齿都没有**(差异计数恒为 0)。
      //        第 41 批: 八卦地支补齐后这个前提消失, 所以判据不写成
      //        「本卦 vs 变卦的纳支要相同」(变卦是另一个卦, 纳支当然不同, 会误报 152 条),
      //        改成**56 个变卦的装卦结果逐字等于 64 卦表对应行** —— 那条不依赖缺口。
      //   ⇒ 现在改成: **真卦真爻位**, 把爻值**真的送进** getYaoVector,
      //     断言三件事:
      //       (a) 同一爻位, 静爻值 vs 动爻值 ⇒ **yaoWuxing 完全相同**(五行只有一个来源);
      //       (b) 同一爻位, 静爻值 vs 动爻值 ⇒ **movement 必须变**(static→dynamic)
      //           —— 这是「扰动真的进到了被测路径」的**正向证据**。
      //           如果哪天爻值又被从向量层里摘掉, 这一条立刻炸(而不是悄悄恒真)。
      //       (c) 爻值阴阳跟爻位静态阴阳矛盾时 ⇒ **必须返回 null**(拒绝),
      //           不许静默改阴阳 —— 爻变在变卦里发生, 不在爻位上。
      //   尺子仍是**异源**的纳甲(najia), 不用被测对象自己当尺子。
      const staticBit = (function () {
        const b = (opts.yaoModels || require(path.join(I64, 'yao_models.js'))).getBinary(id);
        return (typeof b === 'string' && b.length === 6) ? b.charAt(pos) : null;
      })();
      if (staticBit !== '0' && staticBit !== '1') continue;   // 拿不到静态阴阳 ⇒ 无从比起
      const isYangPos = staticBit === '1';
      // 该爻位**合法**的爻值: 阳位 {7 少阳, 9 老阳}, 阴位 {8 少阴, 6 老阴}
      const staticYaoValue = isYangPos ? 7 : 8;
      const movingYaoValue = isYangPos ? 9 : 6;
      // 矛盾爻值: 阴阳跟爻位静态阴阳相反 ⇒ 传进去必须被拒
      const conflictYaoValue = isYangPos ? 6 : 9;

      const staticVec = hv.getYaoVector(id, pos, { yaoValue: staticYaoValue });
      const movingVec = hv.getYaoVector(id, pos, { yaoValue: movingYaoValue });
      if (!staticVec || !movingVec) {
        violations.push(
          `[爻向量层] 卦 ${id} 第 ${pos + 1} 爻取不到向量 `
          + `(静爻值 ${staticYaoValue}: ${staticVec ? '有' : '无'}; `
          + `动爻值 ${movingYaoValue}: ${movingVec ? '有' : '无'}) —— 这条判据没法验了`
        );
        continue;
      }
      // (a) 五行只有一个来源: 静动两态下必须完全相同, 且等于纳甲地支五行
      if (staticVec.yaoWuxing !== gz.wuxing) {
        violations.push(
          `[爻向量层] 卦 ${id} 第 ${pos + 1} 爻(静)五行是 ${staticVec.yaoWuxing}, `
          + `纳甲地支 ${gz.dianzhi} 的五行是 ${gz.wuxing} —— 爻的五行只有一个来源`
        );
      }
      if (movingVec.yaoWuxing !== staticVec.yaoWuxing) {
        violations.push(
          `[爻向量层] 卦 ${id} 第 ${pos + 1} 爻从静(${staticYaoValue})到动(${movingYaoValue}), `
          + `爻五行从 ${staticVec.yaoWuxing} 变成了 ${movingVec.yaoWuxing} —— `
          + '动的是爻的阴阳(在变卦里), 不是爻的五行(老板 10-21 原话)'
        );
      }
      // (b) 扰动真的进到了被测路径: movement 必须随爻值变
      if (staticVec.movement !== 'static') {
        violations.push(
          `[爻向量层] 卦 ${id} 第 ${pos + 1} 爻在静爻值 ${staticYaoValue} 下 `
          + `movement 是 "${staticVec.movement}" —— 静爻值必须是 static`
        );
      }
      if (movingVec.movement !== 'dynamic') {
        violations.push(
          `[爻向量层] 卦 ${id} 第 ${pos + 1} 爻在动爻值 ${movingYaoValue} 下 `
          + `movement 是 "${movingVec.movement}" —— **爻值没进到被测路径**, `
          + '这一条判据形同虚设(爻值被从向量层里摘掉了?)'
        );
      }
      // (c) 矛盾爻值必须被拒: 爻值不许翻转本卦爻位的阴阳
      const conflictVec = hv.getYaoVector(id, pos, { yaoValue: conflictYaoValue });
      if (conflictVec) {
        violations.push(
          `[爻向量层] 卦 ${id} 第 ${pos + 1} 爻在本卦是${isYangPos ? '阳' : '阴'}爻, `
          + `传进矛盾爻值 ${conflictYaoValue} 却仍然取到了向量 `
          + `(movement="${conflictVec.movement}") —— `
          + '爻值不许翻转本卦爻位的阴阳, 矛盾就该被拒绝(爻变在变卦里发生)'
        );
      }
      // 变卦推得出来(索引 0..63) —— 用**真卦真爻位**的爻值, 不是编造的假卦
      const realYao6 = [];
      for (let i = 0; i < 6; i++) {
        const b = (opts.yaoModels || require(path.join(I64, 'yao_models.js'))).getBinary(id);
        realYao6.push(typeof b === 'string' && b.length === 6 ? (b.charAt(i) === '1' ? 7 : 8) : 7);
      }
      realYao6[pos] = movingYaoValue;
      const tr = yy.buildTransformedHexagram(realYao6);
      if (typeof tr.changedIndex !== 'number' || tr.changedIndex < 0 || tr.changedIndex > 63) {
        violations.push(`[爻值层] 变卦索引越界: ${tr.changedIndex} (卦 ${id} 爻位 ${pos}, 爻值 ${movingYaoValue})`);
      }
      // 变卦的**阴阳翻转**只发生在动爻那一爻, 其余五爻不许动
      for (let i = 0; i < 6; i++) {
        const before = yy.yaoToBinary(realYao6[i]);
        const after = yy.yaoToBinary(tr.changed[i]);
        const shouldFlip = (i === pos);
        if ((before !== after) !== shouldFlip) {
          violations.push(
            `[爻值层] 卦 ${id} 第 ${i + 1} 爻阴阳翻转与否不对: `
            + `动爻位=${pos + 1}(应翻转=${shouldFlip}), 实测翻转=${before !== after}`
          );
        }
      }
    }
  }

  // ── C5: 装不出的卦, 爻五行必须为空(不许拿别的东西顶) ──
  let checkedEmpty = 0;
  let checkedFilled = 0;
  for (let id = 1; id <= 64; id++) {
    for (let pos = 0; pos < 6; pos++) {
      const gz = najia.getYaoGanzhi(id, pos + 1);
      const vec = hv.getYaoVector(id, pos);
      if (!vec) continue;   // 越界之类, 别的判据管
      if (gz.ok) { checkedFilled++; continue; }
      checkedEmpty++;
      if (vec.yaoWuxing) {
        violations.push(
          `[爻向量层] 卦 ${id} 第 ${pos + 1} 爻的五行是 ${vec.yaoWuxing}, `
          + `但这一爻装不出纳甲(${gz.error.message}) —— 缺数据要显式空着, 不许拿别的东西顶`
        );
      }
    }
  }
  // ⚠️ 这里**不再**因为 checkedEmpty===0 报错 (第 41 批):
  //   八卦纳甲补齐后真实数据 384/384 装得出, 缺口在真数据上**不存在**。
  //   拿「真数据里有没有缺口」当判据的前提, 前提已经不成立了 ——
  //   下面那段 C5 自检才是现在真正会咬人的那条。
  if (checkedFilled === 0) {
    violations.push('[爻向量层] 装得出纳甲的爻位一个都没验到 —— C3/C4 这条判据形同虚设');
  }

  // ── C5 的**自检**: 这条判据自己会不会咬人 ──
  //   ⚠️ 2026-10-22 第 41 批: 八卦纳甲地支补齐后, 真实数据 **384/384 装得出**
  //     ⇒ `checkedEmpty` 恒为 0 ⇒ 上面那个「形同虚设」的兜底会**永远报错**,
  //     而真数据那条「装不出 ⇒ 必须是空」的性质**再也走不到** ——
  //     哪天向量层偷偷给装不出的爻位顶了个五行, 没人会发现
  //     (踩坑日志: 旧负例会静默失效 / 判据写偏会冤枉正确数据)。
  //   ⇒ 改成**自己造缺口**来验: 注入一张「挖掉震」的纳甲表,
  //     看 (a) 缺口真的造出来了, (b) 造出来时向量层的爻五行**确实是空**。
  //     牙齿是「真数据 + 故意缺口」, 不是「数据恰好缺一块」。
  try {
    const NJ = require(path.join(I64, 'bagua_annotations', 'najia.js'));
    const realTable = NJ.JINGFANG_DIZHI;
    const holed = Object.assign({}, realTable);
    delete holed.震;                       // 挖一个真缺口
    const holedNajia = {
      getYaoGanzhi: (id, pos) => NJ.getYaoGanzhiWithTable(holed, id, pos),
    };
    let gapSeen = 0;
    let gapFilled = 0;
    for (let id = 1; id <= 64; id++) {
      for (let pos = 0; pos < 6; pos++) {
        const gz = holedNajia.getYaoGanzhi(id, pos + 1);
        if (gz.ok) continue;
        gapSeen++;
        // 向量层在同样这张(有缺口的)表下取向量 —— 装不出就该是空
        const vec = hv.getYaoVector(id, pos, { najia: holedNajia });
        if (!vec) continue;
        if (vec.yaoWuxing) {
          gapFilled++;
          violations.push(
            `[爻向量层] 卦 ${id} 第 ${pos + 1} 爻**装不出纳甲**却给出了五行 ${vec.yaoWuxing} `
            + '(故意挖掉震卦地支造出的缺口) —— 缺数据要显式空着, 不许拿别的东西顶'
          );
        }
      }
    }
    if (gapSeen === 0) {
      violations.push('[爻向量层] C5 自检: 挖掉震卦后一个缺口都没造出来 —— 这条自检自己坏了');
    }
    if (gapFilled > 0 && gapSeen === 0) {
      violations.push('[爻向量层] C5 自检逻辑矛盾');
    }
  } catch (e) {
    violations.push(`[爻向量层] C5 自检跑不起来: ${e.message}`);
  }

  // ── C6: 反向 —— 「删光也能过」是这道守卫最已知的失效方式 ──
  //   真源缺失不等于功能该没有: 乾卦(纳甲 6/6 有) 的六亲必须**六爻都算得出来**。
  //   期望值手写(乾纳甲子寅辰/壬午申戌 ⇒ 子水寅木辰土午火申金戌土; 乾宫属金),
  //   按「生我者父母 / 同我者兄弟 / 我生者子孙 / 我克者妻财 / 克我者官鬼」人工推一遍:
  //     子水=我生⇒子孙  寅木=我克⇒妻财  辰土=生我⇒父母
  //     午火=克我⇒官鬼  申金=同我⇒兄弟  戌土=生我⇒父母
  //   不从被测函数自己算 —— 尺子与被测对象同源 = 恒真守卫。
  const QIAN_LIU_QIN = ['子孙', '妻财', '父母', '官鬼', '兄弟', '父母'];
  let lq = null;
  try {
    lq = require(path.join(I64, 'bagua_annotations', 'liu_qin.js'));
  } catch (e) {
    violations.push(`[六亲层] 加载失败: ${e.message}`);
  }
  if (lq && typeof lq.computeLiuQin === 'function') {
    for (let pos = 0; pos < 6; pos++) {
      const got = lq.computeLiuQin(1, pos);
      if (got !== QIAN_LIU_QIN[pos]) {
        violations.push(
          `[六亲层] 乾卦第 ${pos + 1} 爻六亲是 ${got}, 应为 ${QIAN_LIU_QIN[pos]} `
          + '(乾宫属金: 子=兄弟 寅=父母 辰=子孙 午=官鬼 申=兄弟 戌=父母) —— '
          + '六亲功能被掏空了, 或「他」侧没走纳甲'
        );
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    loadable_gua: loadable.length,
    checked_filled_yao: checkedFilled,
    checked_empty_gua_yao: checkedEmpty,
  };
}

// ============================================================
// 方向 C2: 变卦推演的**输出形状**零五行
// ============================================================

/** 递归收集对象里的所有 key */
function collectKeys(obj, depth = 0, acc = new Set()) {
  if (!obj || typeof obj !== 'object' || depth > 6) return acc;
  for (const k of Object.keys(obj)) {
    acc.add(k);
    collectKeys(obj[k], depth + 1, acc);
  }
  return acc;
}

function checkTransformOutputShape(opts = {}) {
  const violations = [];
  let yy = null, yt = null;
  try {
    yy = opts.yinYang || require(path.join(I64, 'yin_yang.js'));
    yt = opts.yaoTransform || require(path.join(I64, 'yao_transform.js'));
  } catch (e) {
    violations.push(`[爻变层] 加载失败: ${e.message}`);
    return { ok: false, violations };
  }

  const banned = new Set(FORBIDDEN_OUTPUT_KEYS);
  const yao6 = [9, 8, 7, 6, 9, 8]; // 老阳/少阴/少阳/老阴/老阳/少阴 —— 四个爻值都出现

  // ⚠️ 容错: 某个变卦函数不存在时**跳过**, 不能让守卫自己崩成 TypeError。
  //   守卫崩了 = 判据形同虚设, 而且报错信息还跟"红线被越界"毫不相干,
  //   下一次看到的人只会以为守卫坏了, 直接把它删了。
  const outputs = {};
  const missing = [];
  const probe = (name, owner) => {
    if (typeof owner[name] !== 'function') { missing.push(name); return; }
    try {
      outputs[name] = owner[name](yao6);
    } catch (e) {
      violations.push(`[爻变层] ${name} 调用抛异常: ${e.message}`);
    }
  };
  probe('buildTransformedHexagram', yy);
  probe('analyzeHexagramChange', yt);
  probe('oneChange', yt);
  probe('twoChange', yt);
  probe('threeChange', yt);
  probe('fourChange', yt);
  probe('fiveChange', yt);
  probe('sixChange', yt);

  // 变卦推演整体被掏空也是一种越界(功能没了 = 卦象只剩装饰)
  if (missing.length >= Object.keys(outputs).length && missing.length > 0) {
    violations.push(
      `[爻变层] 变卦推演函数全都不存在(缺 ${missing.join(', ')}) —— ` +
      '爻变层被掏空了, 卦象会从「推断的一层」退化成「装饰」'
    );
  }

  for (const [name, out] of Object.entries(outputs)) {
    const keys = collectKeys(out);
    for (const k of keys) {
      if (banned.has(k)) {
        violations.push(
          `[爻变层] ${name} 的输出里出现越层字段 "${k}" —— ` +
          '爻动路径不许叠五行/纳甲/爻变生克(老板 10-21:「爻动阴阳那就太过了」)'
        );
      }
    }
  }

  // 反向: 输出里必须**有**爻位/爻值信息(不是空壳, 免得「删光就通过」)
  const tr = outputs.buildTransformedHexagram;
  if (tr) {
    for (const k of ['original', 'changed', 'moving', 'originalIndex', 'changedIndex']) {
      if (!(k in tr)) violations.push(`[爻变层] buildTransformedHexagram 缺少 "${k}" —— 变卦推演被掏空了`);
    }
    if (!Array.isArray(tr.moving) || tr.moving.length === 0) {
      violations.push('[爻变层] 动爻位置为空 —— 变卦推演没在跑');
    }
  }

  return { ok: violations.length === 0, violations };
}

// ============================================================
// 方向 D: 生产爻变路径(之卦)零五行
// ============================================================

/**
 * ★ 这条才是真正护住生产的。
 *
 * 查过一遍: `yao_transform.js` **在生产里根本没有被 require** ——
 * 真正的爻变是 `modules/gua_engine.js` 里手搓的 binary 翻转:
 *
 *     const changedBits = binary.split('');
 *     changedBits[movingYao - 1] = ...;
 *     const zhiGuaId = yaoModels.getGuaIdByBinary(changedBinary);
 *
 * 所以只盯 64i/yao_transform.js 是盯一条**死路** ——
 * 有人真去越界, 会改 gua_engine.js, 守卫却一声不响。
 *
 * 本判据直接实跑一次真起卦, 检查**之卦**(zhi_gua)那个对象里
 * 有没有混进五行/纳甲/六亲。
 *
 * 注意之卦**该有**的: id / name / name_full / symbol / gua_ci / binary ——
 * 卦名、卦辞、二进制是真信息, 都要留。
 * 不该有的是: wuxing / najia / liu_qin —— 那是**本卦卦层**的体用六亲,
 * 跟着动爻跑到之卦上, 就是"爻动叠五行"。
 */
function checkProductionChangePathNoWuxing() {
  const violations = [];
  let castGua = null;
  try {
    const engine = require(path.join(CORE, 'modules', 'gua_engine.js'));
    castGua = engine.castGua;
  } catch (e) {
    violations.push(`[生产爻变路径] gua_engine 加载失败: ${e.message}`);
    return { ok: false, violations };
  }
  if (typeof castGua !== 'function') {
    violations.push('[生产爻变路径] gua_engine.castGua 不是函数 —— 起卦入口没了');
    return { ok: false, violations };
  }

  // 三个数起卦 → 必得动爻 → 必得之卦
  const gua = castGua('边界自检', { numbers: [1, 2, 3] });
  if (!gua || !gua.zhi_gua) {
    violations.push('[生产爻变路径] 起卦没有产出之卦 —— 这条判据没法验了');
    return { ok: false, violations };
  }

  const zhiKeys = Object.keys(gua.zhi_gua);
  const banned = new Set(FORBIDDEN_OUTPUT_KEYS);
  for (const k of zhiKeys) {
    if (banned.has(k)) {
      violations.push(
        `[生产爻变路径] 之卦(zhi_gua)里出现越层字段 "${k}" —— ` +
        '本卦的体用五行/六亲不许跟着动爻跑到之卦上'
      );
    }
  }

  // 反向: 之卦必须真带卦名与卦辞(不能是空壳蒙混过关)
  for (const k of ['id', 'name', 'binary', 'gua_ci']) {
    if (!(k in gua.zhi_gua)) {
      violations.push(`[生产爻变路径] 之卦缺少 "${k}" —— 之卦内容被掏空了`);
    }
  }
  if (typeof gua.zhi_gua.id !== 'number' || gua.zhi_gua.id < 1 || gua.zhi_gua.id > 64) {
    violations.push(`[生产爻变路径] 之卦 id 越界: ${gua.zhi_gua.id} (卦序应 1..64)`);
  }

  return { ok: violations.length === 0, violations };
}

// ============================================================
// 方向 D (锚): **真纳甲**住在卦层
// ============================================================

/**
 * 真纳甲必须住在**卦层**, 而且必须是**真的**。
 *
 * ⚠️ 2026-10-22 第 33 批把这个判据的前提翻了:
 *   它原来数的是 `hexagrams.js` 每卦的 `najia` 字段, 断言「恰好 64 处」——
 *   而那根字段**压根不是纳甲**(60 甲子按卦序的机械循环, 同下卦组内初爻 8/8 组不唯一,
 *   违反京房装卦纳甲的必要条件, 真源无出处)。
 *   拿它当锚 = **用假数据证明真数据在位**: 哪天真纳甲层被删了, 这条守卫照样绿,
 *   因为那根假字段还杵在那儿。⇒ 锚必须落在真纳甲上。
 *
 * 现在的锚:
 *   ① 真纳甲层 `64i/bagua_annotations/najia.js` 在, 八卦纳甲天干 **8/8** 齐全
 *   ② 装卦接口在卦层(getYaoGanzhi / getGuaNajiaCoverage) —— 纳甲归卦层, 不归六爻层
 *   ③ 旧字段的「不是纳甲」判据仍成立; 万一哪天它被换成了真纳甲表,
 *      本守卫会点名要求**改口径标记**(legacy_field_is_najia), 而不是继续装作没看见
 *
 * 「不许下沉到六爻层」那半边由 FORBIDDEN_IN_YAO_LAYER 的 token 扫描兜着
 * (爻层三模块里出现 najia/纳甲 即报) —— 不重复造闸。
 *
 * @param {{najia?: object}} [opts]
 * @returns {{ok: boolean, violations: string[], count: number, loadable: number|null}}
 */
function checkHexagramNajiaAnchored(opts = {}) {
  const violations = [];
  let najia = null;
  try {
    najia = opts.najia || require(path.join(I64, 'bagua_annotations', 'najia.js'));
  } catch (e) {
    violations.push(`[卦层] 真纳甲层加载失败: ${e.message} —— 纳甲是卦层的活, 没了它整层塌`);
    return { ok: false, violations, count: 0, loadable: null };
  }

  // ① 八卦纳甲天干 8/8 —— 真源: 梅花易数资料「甲壬为乾, 乙癸为坤, 丙艮、丁兑、戊坎、己离、庚震、辛巽」
  const tg = najia.JINGFANG_TIANGAN || {};
  const tKeys = Object.keys(tg).sort();
  if (tKeys.length !== 8) {
    violations.push(
      `[卦层] 八卦纳甲天干应为 8 个, 实为 ${tKeys.length} 个: ${tKeys.join(',') || '空'} —— ` +
      '纳甲是**卦层**的京房配, 不许挪到六爻层(本守卫拦的是「下沉」, 不是「删除」)'
    );
  }

  // ② 装卦接口在卦层
  for (const fn of ['getYaoGanzhi', 'getGuaNajiaCoverage']) {
    if (typeof najia[fn] !== 'function') {
      violations.push(`[卦层] 真纳甲层缺少 ${fn}() —— 纳甲装卦的接口没了`);
    }
  }

  // ③ 旧字段一旦变成真纳甲表, 口径标记必须跟着改 —— 点名, 别装作没看见
  if (typeof najia.auditLegacyNajia === 'function') {
    const audit = najia.auditLegacyNajia();
    if (audit && audit.jingfang_necessary_property_holds) {
      violations.push(
        '[卦层] 64i/hexagrams.js 的旧 najia 字段现在**满足**京房装卦纳甲的必要条件 —— ' +
        '它可能已经换成了真纳甲表。请把口径标记(legacy_field_is_najia / legacy_field_kind)' +
        '一起改, 并重新评估本判据的锚还该不该指在这儿。'
      );
    }
  }

  const loadable = typeof najia.loadableGuaIds === 'function' ? najia.loadableGuaIds().length : null;
  return { ok: violations.length === 0, violations, count: tKeys.length, loadable };
}

// ============================================================
// 汇总
// ============================================================

/**
 * 方向 F: 头注释里的层表必须跟 LAYER_BOUNDARY 一致。
 *
 * ⚠️ 为什么要有这条 (2026-10-22 当场撞出来的):
 *   原表写「六爻层 不放 老阴老阳」, 而代码**允许**爻值 6/7/8/9 ——
 *   注释比代码严。下一个人照注释去"补齐禁词", 会把爻值层自己判成越界, 启动即炸;
 *   注释比代码松是另一头: 以为有守卫, 其实没有。
 *   两头都坏, 而且**不报错** —— 注释连"说清楚"都保证不了时, 更不能指望它能隔离。
 *
 * 判据是**双向**的:
 *   ① 头注释表每一行 == LAYER_BOUNDARY 渲染出来的行 (改了表, 注释必须跟上)
 *   ② 每个禁项必须**有** enforcedBy, 且引用的判据函数真实存在 (禁项不许是空头愿望)
 *   ③ 爻值编码词(老阴/老阳/少阴/少阳)不许出现在禁词表里 (禁了就拆卦筮地基)
 *   ④ 六爻层的「放什么」必须显式写出爻值 6/7/8/9
 *      —— 老板禁的是「在爻动上再叠一层术数阴阳」, 不是爻值里的阴阳;
 *         这两者长得像(都叫阴阳), 差一根头发丝就塌。
 */

/** 判据函数名白名单 —— enforcedBy 只许指向真存在的判据 */
const LAYER_BOUNDARY_CHECKS = [
  'checkYaoLayerNoWuxing',
  'checkWuxingLayerHasYinyang',
  'checkYaoPositionWuxingIsStatic',
  'checkTransformOutputShape',
  'checkProductionChangePathNoWuxing',
  'checkHexagramNajiaAnchored',
];

/** 抽出头注释里的 Markdown 层表 (行 = [层, 放什么, 不放什么]) */
function parseLayerBoundaryDoc(src) {
  const rows = [];
  const re = /^[ \t]*\*[ \t]*\|[ \t]*([^|]*?)[ \t]*\|[ \t]*([^|]*?)[ \t]*\|[ \t]*([^|]*?)[ \t]*\|[ \t]*$/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const cells = [m[1], m[2], m[3]];
    if (cells[0] === '层' || /^-+$/.test(cells[0])) continue;  // 表头行 / 分隔行
    rows.push(cells);
  }
  return rows;
}

/**
 * 只取**层表**那一段(第 1 列是「卦层/五行层/六爻层」那种纯层名)。
 *
 * ⚠️ 2026-10-23 第 53 批踩到: 头注释里现在有**两张**表(层表 + 编号表),
 *   而 `parseLayerBoundaryDoc` 是"扫出所有三列 markdown 行" —— 于是它把
 *   编号表的 7 行也当成层表的行, 报出 7 条「多出一层」。
 *   两张表共用一个解析器, 就必须**各自认领自己那段**, 不然互相误伤。
 *   判据用**表头行**而不是内容猜: 表头第一格是「层」的那张是层表。
 */
function parseLayerBoundaryDocOnly(src, headerCell) {
  const lines = src.split('\n');
  const rows = [];
  let inTarget = false;
  for (const raw of lines) {
    const m = raw.match(/^[ \t]*\*[ \t]*\|[ \t]*([^|]*?)[ \t]*\|[ \t]*([^|]*?)[ \t]*\|[ \t]*([^|]*?)[ \t]*\|[ \t]*$/);
    if (!m) continue;
    const cells = [m[1], m[2], m[3]];
    // ⚠️ 表头行要能**开始**也能**结束**上一段:
    //   头注释里现在有两张三列表, 只判"开始"的话第一张会把第二张也吞进去
    //   (层表检查于是把编号表 7 行全当成"多出一层")。
    //   正确做法: 见到**任何**已知表头就切换归属 —— 是本表头则开, 不是则关。
    const KNOWN = ['层', '编号'];
    if (KNOWN.includes(cells[0])) { inTarget = (cells[0] === headerCell); continue; }
    if (/^-+$/.test(cells[0])) continue;
    if (!inTarget) continue;
    rows.push(cells);
  }
  return rows;
}

function checkLayerBoundaryDoc(opts = {}) {
  const violations = [];
  const src = opts.src !== undefined ? opts.src : readIfExists(__filename);
  const boundary = opts.boundary || LAYER_BOUNDARY;
  const checks = opts.checks || LAYER_BOUNDARY_CHECKS;
  const forbidden = opts.forbidden || FORBIDDEN_IN_YAO_LAYER;
  if (src === null) {
    violations.push('读不到本模块源码 —— 头注释的层表没法核对');
    return { ok: false, violations, rows: [] };
  }

  // ⚠️ 只认领表头是「层」的那张表 —— 头注释里还有编号表(表头「编号」), 别互相误伤。
  const rows = parseLayerBoundaryDocOnly(src, '层');
  const byLayer = new Map(rows.map(r => [r[0], r]));

  // ① 表 == 数据
  for (const r of boundary) {
    const forbidCell = r.forbid.length ? r.forbid.join('/') : '—';
    const got = byLayer.get(r.layer);
    if (!got) {
      violations.push(`[层表] 头注释里没有「${r.layer}」这一行 —— 表和数据对不上`);
      continue;
    }
    if (got[1] !== r.allow) {
      violations.push(
        `[层表] 「${r.layer}」的「放什么」与 LAYER_BOUNDARY 不一致:\n` +
        `        注释: ${got[1]}\n` +
        `        数据: ${r.allow}`
      );
    }
    if (got[2] !== forbidCell) {
      violations.push(
        `[层表] 「${r.layer}」的「不放什么」与 LAYER_BOUNDARY 不一致:\n` +
        `        注释: ${got[2]}\n` +
        `        数据: ${forbidCell}`
      );
    }
  }
  for (const got of rows) {
    if (!boundary.some(r => r.layer === got[0])) {
      violations.push(`[层表] 头注释里多出一层「${got[0]}」—— LAYER_BOUNDARY 里没有它`);
    }
  }

  // ② 禁项必须写得出兜住它的判据
  for (const r of boundary) {
    for (const item of r.forbid) {
      const by = (r.enforcedBy || {})[item];
      if (!by || !by.length) {
        violations.push(`[层表] 「${r.layer}」的禁项「${item}」没写 enforcedBy —— 空头愿望不是闸`);
        continue;
      }
      for (const fn of by) {
        if (!checks.includes(fn)) {
          violations.push(`[层表] 禁项「${item}」指向了不存在的判据 ${fn}()`);
        }
      }
    }
  }

  // ③ 爻值编码词不许被禁 (禁了就拆地基)
  for (const { token, why } of forbidden) {
    for (const w of YAO_VALUE_ENCODING_WORDS) {
      if (token.includes(w)) {
        violations.push(
          `[层表] 禁词表里出现了爻值编码词「${w}」(token "${token}") —— ` +
          '爻值 6/7/8/9 是卦筮地基, 禁了整套塌掉。要禁的是爻变生克, 不是爻值阴阳。'
        );
      }
    }
  }

  // ④ 六爻层必须显式写出爻值 6/7/8/9
  const yaoLayer = boundary.find(r => r.layer === '六爻层');
  if (yaoLayer && !yaoLayer.allow.includes('6/7/8/9')) {
    violations.push('[层表] 六爻层的「放什么」没显式写出爻值 6/7/8/9 —— 不许再含糊');
  }

  return { ok: violations.length === 0, violations, rows };
}

/**
 * 跑全部判据。
 * @returns {{ok: boolean, violations: string[], report: object}}
 */
function checkYaoLayerBoundary() {
  const a = checkYaoLayerNoWuxing();
  const b = checkWuxingLayerHasYinyang();
  const c = checkYaoPositionWuxingIsStatic();
  const c2 = checkTransformOutputShape();
  const d = checkProductionChangePathNoWuxing();
  const e = checkHexagramNajiaAnchored();
  const f = checkLayerBoundaryDoc();
  const g = checkNumberingBasis();
  const g2 = checkNumberingBasisDoc();

  const violations = [
    ...a.violations.map(v => '【爻层零五行】' + v),
    ...b.violations.map(v => '【五行层有阴阳】' + v),
    ...c.violations.map(v => '【爻位五行静态】' + v),
    ...c2.violations.map(v => '【变卦输出形状】' + v),
    ...d.violations.map(v => '【生产爻变路径】' + v),
    ...e.violations.map(v => '【卦层纳甲锚】' + v),
    ...f.violations.map(v => '【层表-代码一致性】' + v),
    ...g.violations.map(v => '【编号派生/独立】' + v),
    ...g2.violations.map(v => '【编号表-注释一致性】' + v),
  ];

  return {
    ok: violations.length === 0,
    violations,
    report: {
      yaoLayerNoWuxing: { ok: a.ok, details: a.checks },
      wuxingLayerHasYinyang: { ok: b.ok },
      yaoPositionWuxingStatic: { ok: c.ok },
      transformOutputShape: { ok: c2.ok },
      productionChangePath: { ok: d.ok },
      hexagramNajia: { ok: e.ok, count: e.count },
      layerBoundaryDoc: { ok: f.ok, rows: f.rows.length },
      numberingBasis: { ok: g.ok, results: g.results },
      numberingBasisDoc: { ok: g2.ok, rows: g2.rows.length },
    },
  };
}

/**
 * 越界即抛 —— 装时自检用。
 * 抛而不是 warn: 这条红线一旦被越过, 盘古会安静地给出另一套话术,
 * 不会报错, 只会答得像模像样但口径全错(和「传男被当女命」同族)。
 */
function assertYaoLayerBoundary() {
  const r = checkYaoLayerBoundary();
  if (!r.ok) {
    throw new Error(
      '[yao-layer-boundary] 爻层边界被越过了 —— 老板 10-21 原话「爻动阴阳那就太过了」。\n' +
      '  爻层只干两件事: 爻位编号防错(0..63) + 引用爻辞原文。\n' +
      '  爻值 6/7/8/9(老阴/少阳/少阴/老阳)是卦筮地基, 允许; 禁的是爻变生克。\n' +
      '  五行/纳甲/爻变生克归卦层与五行层, 阴阳归卦层与五行层。\n' +
      '命中:\n  ' + r.violations.join('\n  ')
    );
  }
  return r;
}

module.exports = {
  checkYaoLayerBoundary,
  assertYaoLayerBoundary,
  // 分项导出, 便于喂负例(与 _assertNoGuaToExecutionCoupling 同一做法)
  checkYaoLayerNoWuxing,
  checkWuxingLayerHasYinyang,
  checkYinyangJudgeReal,
  checkYaoPositionWuxingIsStatic,
  checkTransformOutputShape,
  checkProductionChangePathNoWuxing,
  checkHexagramNajiaAnchored,
  checkLayerBoundaryDoc,
  checkNumberingBasis,
  checkNumberingBasisDoc,
  collectRequireClosure,
  FORBIDDEN_IN_YAO_LAYER,
  FORBIDDEN_OUTPUT_KEYS,
  YAO_LAYER_MODULES,
  LAYER_BOUNDARY,
  NUMBERING_BASIS,
  LAYER_BOUNDARY_CHECKS,
  YAO_VALUE_ENCODING_WORDS,
  renderLayerBoundaryRows,
  renderNumberingBasisRows,
  NUMBERING_BASIS,
};
