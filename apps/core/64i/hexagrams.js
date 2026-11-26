/**
 * Pangu · 64i Layer
 * hexagrams.js - 64卦完整定义
 *
 * 职责：64卦的完整数据（卦名/卦辞/象/爻辞/八宫/纳甲）
 * 接口规范：compiled/INTERFACE_SPEC.md §2.2
 *
 * ── 「八宫」这个字段名有歧义, 认准口径别认名字 ──
 *
 *   本文件每卦的 `bagong` 字段 = **上卦所属纯卦(上卦分组)**,
 *   程序验证 64/64: bagong === 上卦所属纯卦。
 *   **它不是京房八宫的宫** —— 两者名字撞了, 口径不同。
 *
 *   京房八宫(占筮用的宫/宫位/世应)在 `bagua_annotations/jingfang_bagong.js`,
 *   两处数据 64/64 逐格对得上(真源表 × 变爻规则机械推导)。
 *
 *   连带一条: 本文件的 `elements`(卦五行) 也是**上卦口径**,
 *   跟京房**宫五行**在 32/64 卦上不一致。
 *
 * ── 编号: 这张表里同时存在三套, 传错基数不会报错, 只会安静地返回另一卦 ──
 *
 * ── 编号: 这张表里同时存在三套, 传错基数不会报错, 只会安静地返回另一卦 ──
 *
 *   id      1..64    卦序 (文王卦序, 乾=1 坤=2 … 剥=23 复=24 … 既济=63 未济=64)。**主路径, 全部调用者走这个**
 *   index   0..63    上卦三位 ‖ 下卦三位 的整数值 (乾=63 坤=0)。目前**零生产调用者**
 *   binary  '111111' 下卦三位 ‖ 上卦三位, 初爻→上爻自下而上。与 index 是同一组 6 位,
 *                    但**上下两半对调** (index='010100' → binary='100010')
 *
 *   1..64 和 0..63 在 **1..63 上完全重叠** —— 少 1 错一位, 卦整个变, 且不抛异常。
 *   要换算就用 `idToIndex()` / `indexToId()`, 别手算; 看到裸数字先问是哪个基数。
 *   数据自检见文件下方 `assertBaseIntegrity()` (require 时就跑, 漂了当场炸)。
 *
 * ── `najia` 这个字段**不是纳甲表** (2026-10-22 实查后加的, 别删) ──
 *
 *   本表每卦有个 `najia: {tiangan, dianzhi}`。它**长得像**纳甲, 实际是:
 *     天干按 10 循环 × 地支按 12 循环 的 60 甲子机械序列, 按 id(文王序)排
 *     (乾甲子 坤乙丑 屯丙寅 蒙丁卯 …)。64 卦只有 60 种, id1 与 id61 完全相同。
 *
 *   为什么断定它不是纳甲 (两条机械证据, 都不依赖任何外部表):
 *     ① **同下卦组内初爻全部 8 组都不唯一**。而京房装卦纳甲的**必要条件**
 *        就是「初爻干支只由下卦决定」(内三爻取下卦的纳甲) ⇒ 8/8 组违反
 *        ⇒ 结构上不可能是京房纳甲。
 *     ② 真源树里**没有** 64 卦纳甲表 ⇒ 没有出处。
 *
 *   ⚠️ 它此前在生产输出里被当纳甲讲给用户:
 *     `modules/gua_answer_gate.js` 的 64 卦事实卡 + `modules/skill_runtime.js`。
 *     两处都已改成真话。**真纳甲在 `bagua_annotations/najia.js`**,
 *     那里有 8/8 八卦纳甲天干 + 乾/坤两卦的六爻地支(真源), 装卦走那条。
 *     ⚠️ 完整六爻干支**装得出的是 4 卦**(乾/泰/否/坤 —— 上下卦都是乾/坤),
 *        不是 2 卦; 其余 60 卦返回 null + 原因。别再手写这个数, 走 `loadableGuaIds()`。
 *
 *   本字段暂留(改名会砸掉前端镜像与既有调用), 但**只当"卦序→60甲子序号"用**,
 *   不许当纳甲用。口径见 `bagua_annotations/najia.js` 的 `NAJIA_BASIS`。
 */

'use strict';

const { YIN, YANG, yaoToBinary } = require('./yin_yang');

// 卦象名要用的「象名」(天/泽/火/雷/风/水/山/地) —— 唯一真源是八卦公理表的 nature 字段。
// bagua_axioms.js 是纯数据文件, 不 require 本文件, 所以这里没有循环依赖。
const BAGUA_AXIOMS = require('./bagua_annotations/bagua_axioms').BAGUA_AXIOMS;
const NATURE_OF_BAGUA = {};
for (const b of BAGUA_AXIOMS) NATURE_OF_BAGUA[b.name] = b.nature;

// ============================================================
// 64卦基础数据
//
// ⚠️ 卦序是**文王序（序卦传）**, 不是伏羲先天序。
//   2026-10-22 实查: 本表 id 1..64 = 乾 坤 屯 蒙 需 讼 师 比 小畜 履 泰 否
//   同人 大有 谦 豫 随 蛊 临 观 … 丰 旅 巽 兑 涣 节 中孚 小过 既济 未济
//   —— 与序卦传逐位相同。伏羲先天序在第 13 位就分岔(先天: 观 大畜 颐 复
//   无妄 明夷 损 益; 本表: 同人 大有 谦 豫 随 蛊 临 观)。
//   原注释写「伏羲先天序」是**错的** —— 照着它建先天序专属逻辑会整段错位。
//
// 数据来源：周易六十四卦三百八十四爻完整版
// ============================================================

const HEXAGRAMS = [
  {
    // 索引 63：乾（下乾上乾）
    id: 1,
    index: 63,
    name: '乾',
    name_cn: '乾',
    symbol: '䷀',
    binary: '111111',
    gua_ci: '乾，元亨利贞。',
    xiang: '天行健，君子以自强不息。',
    yao_ci: [
      '初九：潜龙勿用',
      '九二：见龙在田，利见大人',
      '九三：君子终日乾乾，夕惕若，厉无咎',
      '九四：或跃在渊，无咎',
      '九五：飞龙在天，利见大人',
      '上九：亢龙有悔',
    ],
    trigrams: { upper: '☰', lower: '☰', upper_name: '乾', lower_name: '乾' },
    elements: '金',
    bagong: '乾',
    najia: { tiangan: '甲', dianzhi: '子' },
    nature: '刚健',
    keywords: ['天道', '刚健', '纯阳', '创造', '领导'],
  },
  {
    // 索引 0：坤（下坤上坤）
    id: 2,
    index: 0,
    name: '坤',
    name_cn: '坤',
    symbol: '䷁',
    binary: '000000',
    gua_ci: '坤，元亨，利牝马之贞。君子有攸往，先迷后得主，利。西南得朋，东北丧朋，安贞吉。',
    xiang: '地势坤，君子以厚德载物。',
    yao_ci: [
      '初六：履霜，坚冰至',
      '六二：直方大，不习无不利',
      '六三：含章可贞，或从王事，无成有终',
      '六四：括囊，无咎无誉',
      '六五：黄裳，元吉',
      '上六：龙战于野，其血玄黄',
    ],
    trigrams: { upper: '☷', lower: '☷', upper_name: '坤', lower_name: '坤' },
    elements: '土',
    bagong: '坤',
    najia: { tiangan: '乙', dianzhi: '丑' },
    nature: '柔顺',
    keywords: ['地道', '柔顺', '纯阴', '承载', '生育'],
  },
  {
    // 索引 17：屯（下震上坎）
    id: 3,
    index: 20,
    name: '屯',
    name_cn: '屯',
    symbol: '䷂',
    binary: '100010',
    gua_ci: '屯，元亨利贞。勿用有攸往，利建侯。',
    xiang: '云雷屯，君子以经纶。',
    yao_ci: [
      '初九：磐桓，利居贞，利建侯',
      '六二：屯如邅如，乘马班如。匪寇婚媾，女子贞不字，十年乃字',
      '六三：即鹿无虞，惟入于林中，君子几不如舍，往吝',
      '六四：乘马班如，求婚媾，往吉无不利',
      '九五：屯其膏，小贞吉，大贞凶',
      '上六：乘马班如，泣血涟如',
    ],
    trigrams: { upper: '☵', lower: '☳', upper_name: '坎', lower_name: '震' },
    elements: '水',
    bagong: '坎',
    najia: { tiangan: '丙', dianzhi: '寅' },
    nature: '萌芽',
    keywords: ['屯难', '萌芽', '初始', '困难', '生机'],
  },
  {
    // 索引 34：蒙（下坎上艮）
    id: 4,
    index: 10,
    name: '蒙',
    name_cn: '蒙',
    symbol: '䷃',
    binary: '010001',
    gua_ci: '蒙，亨。匪我求童蒙，童蒙求我。初筮告，再三渎，渎则不告。利贞。',
    xiang: '山下出泉，蒙；君子以果行育德。',
    yao_ci: [
      '初六：发蒙，利用刑人，用说桎梏，以往吝',
      '九二：包蒙吉，纳妇吉，子克家',
      '六三：勿用取女，见金夫，不有躬，无攸利',
      '六四：困蒙，吝',
      '六五：童蒙，吉',
      '上九：击蒙，不利为寇，利御寇',
    ],
    trigrams: { upper: '☶', lower: '☵', upper_name: '艮', lower_name: '坎' },
    elements: '土',
    bagong: '艮',
    najia: { tiangan: '丁', dianzhi: '卯' },
    nature: '蒙昧',
    keywords: ['蒙昧', '教育', '启蒙', '童蒙', '迷惑'],
  },
  {
    // 索引 23：需（下乾上坎）
    id: 5,
    index: 23,
    name: '需',
    name_cn: '需',
    symbol: '䷄',
    binary: '111010',
    gua_ci: '需，有孚光亨，贞吉，利涉大川。',
    xiang: '云上于天，需；君子以饮食宴乐。',
    yao_ci: [
      '初九：需于郊，利用恒，无咎',
      '九二：需于沙，小有言，终吉',
      '九三：需于泥，致寇至',
      '六四：需于血，出自穴',
      '九五：需于酒食，贞吉',
      '上六：入于穴，有不速之客三人来，敬之终吉',
    ],
    trigrams: { upper: '☵', lower: '☰', upper_name: '坎', lower_name: '乾' },
    elements: '水',
    bagong: '坎',
    najia: { tiangan: '戊', dianzhi: '辰' },
    nature: '需待',
    keywords: ['需待', '等待', '饮食', '诚信', '时机'],
  },
  {
    // 索引 58：讼（下坎上乾）
    id: 6,
    index: 58,
    name: '讼',
    name_cn: '讼',
    symbol: '䷅',
    binary: '010111',
    gua_ci: '讼，有孚窒惕，中吉终凶。利见大人，不利涉大川。',
    xiang: '天与水违行，讼；君子以作事谋始。',
    yao_ci: [
      '初六：不永所事，小有言，终吉',
      '九二：不克讼，归而逋，其邑人三百户无眚',
      '六三：食旧德，贞厉终吉，或从王事无成',
      '九四：不克讼，复即命渝，安贞吉',
      '九五：讼，元吉',
      '上九：或锡之鞶带，终朝三褫之',
    ],
    trigrams: { upper: '☰', lower: '☵', upper_name: '乾', lower_name: '坎' },
    elements: '金',
    bagong: '乾',
    najia: { tiangan: '己', dianzhi: '巳' },
    nature: '讼争',
    keywords: ['讼争', '争论', '诉讼', '分歧', '警惕'],
  },
  {
    // 索引 2：师（下坎上坤）
    id: 7,
    index: 2,
    name: '师',
    name_cn: '师',
    symbol: '䷆',
    binary: '010000',
    gua_ci: '师，贞，丈人吉，无咎。',
    xiang: '地中有水，师；君子以容民畜众。',
    yao_ci: [
      '初六：师出以律，否臧凶',
      '九二：在师中吉，无咎，王三锡命',
      '六三：师或舆尸，凶',
      '六四：师左次，无咎',
      '六五：田有禽，利执言无咎。长子帅师，弟子舆尸，贞凶',
      '上六：大君有命，开国承家，小人勿用',
    ],
    trigrams: { upper: '☷', lower: '☵', upper_name: '坤', lower_name: '坎' },
    elements: '土',
    bagong: '坤',
    najia: { tiangan: '庚', dianzhi: '午' },
    nature: '师众',
    keywords: ['师众', '军队', '统帅', '大众', '纪律'],
  },
  {
    // 索引 16：比（下坤上坎）
    id: 8,
    index: 16,
    name: '比',
    name_cn: '比',
    symbol: '䷇',
    binary: '000010',
    gua_ci: '比，吉。原筮元永贞无咎。不宁方来，后夫凶。',
    xiang: '地上有水，比；先王以建万国，亲诸侯。',
    yao_ci: [
      '初六：有孚比之无咎，有孚盈缶，终来有它吉',
      '六二：比之自内，贞吉',
      '六三：比之匪人',
      '六四：外比之，贞吉',
      '九五：显比，王用三驱，失前禽，邑人不诫吉',
      '上六：比之无首，凶',
    ],
    trigrams: { upper: '☵', lower: '☷', upper_name: '坎', lower_name: '坤' },
    elements: '水',
    bagong: '坎',
    najia: { tiangan: '辛', dianzhi: '未' },
    nature: '比亲',
    keywords: ['比亲', '亲比', '亲近', '协和', '团结'],
  },
  {
    // 索引 55：小畜（下乾上巽）
    id: 9,
    index: 31,
    name: '小畜',
    name_cn: '小畜',
    symbol: '䷈',
    binary: '111011',
    gua_ci: '小畜，亨。密云不雨，自我西郊。',
    xiang: '风行天上，小畜；君子以懿文德。',
    yao_ci: [
      '初九：复自道，何其咎，吉',
      '九二：牵复，吉',
      '九三：舆说辐，夫妻反目',
      '六四：有孚，血去惕出，无咎',
      '九五：有孚挛如，富以其邻',
      '上九：既雨既处，尚德载。妇贞厉，月几望，君子征凶',
    ],
    trigrams: { upper: '☴', lower: '☰', upper_name: '巽', lower_name: '乾' },
    elements: '木',
    bagong: '巽',
    najia: { tiangan: '壬', dianzhi: '申' },
    nature: '小畜',
    keywords: ['小畜', '积累', '储蓄', '微细', '准备'],
  },
  {
    // 索引 61：履（下兑上乾）
    id: 10,
    index: 62,
    name: '履',
    name_cn: '履',
    symbol: '䷉',
    binary: '110111',
    gua_ci: '履，履虎尾，不咥人，亨。',
    xiang: '上天下泽，履，君子以辨上下，定民志。',
    yao_ci: [
      '初九：素履，往无咎',
      '九二：履道坦坦，幽人贞吉',
      '六三：眇能视，跛能履，履虎尾咥人凶，武人为于大君',
      '九四：履虎尾，愬愬终吉',
      '九五：夬履，贞厉',
      '上九：视履考祥，其旋元吉',
    ],
    trigrams: { upper: '☰', lower: '☱', upper_name: '乾', lower_name: '兑' },
    elements: '金',
    bagong: '乾',
    najia: { tiangan: '癸', dianzhi: '酉' },
    nature: '履虎',
    keywords: ['履虎', '实践', '履行', '谨慎', '危机'],
  },
  {
    // 索引 7：泰（下乾上坤）
    id: 11,
    index: 7,
    name: '泰',
    name_cn: '泰',
    symbol: '䷊',
    binary: '111000',
    gua_ci: '泰，小往大来，吉亨。',
    xiang: '天地交，泰；后以财成天地之道，辅相天地之宜，以左右民。',
    yao_ci: [
      '初九：拔茅茹，以其汇，征吉',
      '九二：包荒，用冯河，不遐遗，朋亡，得尚于中行',
      '九三：无平不陂，无往不复，艰贞无咎。勿恤其孚，于食有福',
      '六四：翩翩，不富以其邻，不戒以孚',
      '六五：帝乙归妹，以祉元吉',
      '上六：城复于隍，勿用师，自邑告命，贞吝',
    ],
    trigrams: { upper: '☷', lower: '☰', upper_name: '坤', lower_name: '乾' },
    elements: '土',
    bagong: '坤',
    najia: { tiangan: '甲', dianzhi: '戌' },
    nature: '泰通',
    keywords: ['泰通', '通泰', '平安', '通畅', '和谐'],
  },
  {
    // 索引 56：否（下坤上乾）
    id: 12,
    index: 56,
    name: '否',
    name_cn: '否',
    symbol: '䷋',
    binary: '000111',
    gua_ci: '否之匪人，不利君子贞，大往小来。',
    xiang: '天地不交，否；君子以俭德辟难，不可荣以禄。',
    yao_ci: [
      '初六：拔茅茹，以其汇，贞吉亨',
      '六二：包承，小人吉，大人否亨',
      '六三：包羞',
      '九四：有命无咎，畴离祉',
      '九五：休否，大人吉。其亡其亡，系于苞桑',
      '上九：倾否，先否后喜',
    ],
    trigrams: { upper: '☰', lower: '☷', upper_name: '乾', lower_name: '坤' },
    elements: '金',
    bagong: '乾',
    najia: { tiangan: '乙', dianzhi: '亥' },
    nature: '否塞',
    keywords: ['否塞', '否闭', '阻隔', '闭塞', '混乱'],
  },
  {
    // 索引 60：同人（下离上乾）
    id: 13,
    index: 61,
    name: '同人',
    name_cn: '同人',
    symbol: '䷌',
    binary: '101111',
    gua_ci: '同人于野，亨。利涉大川，利君子贞。',
    xiang: '天与火，同人，君子以类族辨物。',
    yao_ci: [
      '初九：同人于门，无咎',
      '六二：同人于宗，吝',
      '九三：伏戎于莽，升其高陵，三岁不兴',
      '九四：乘其墉，弗克攻，吉',
      '九五：同人，先号咷而后笑，大师克相遇',
      '上九：同人于郊，无悔',
    ],
    trigrams: { upper: '☰', lower: '☲', upper_name: '乾', lower_name: '离' },
    elements: '金',
    bagong: '乾',
    najia: { tiangan: '丙', dianzhi: '子' },
    nature: '同人',
    keywords: ['同人', '同仁', '合作', '大同', '和同'],
  },
  {
    // 索引 39：大有（下乾上离）
    id: 14,
    index: 47,
    name: '大有',
    name_cn: '大有',
    symbol: '䷍',
    binary: '111101',
    gua_ci: '大有，元亨。',
    xiang: '火在天上，大有；君子以遏恶扬善，顺天休命。',
    yao_ci: [
      '初九：无交害，匪咎，艰则无咎',
      '九二：大车以载，有攸往无咎',
      '九三：公用亨于天子，小人弗克',
      '九四：匪其彭，无咎',
      '六五：厥孚交如威如，吉',
      '上九：自天佑之，吉无不利',
    ],
    trigrams: { upper: '☲', lower: '☰', upper_name: '离', lower_name: '乾' },
    elements: '火',
    bagong: '离',
    najia: { tiangan: '丁', dianzhi: '丑' },
    nature: '大有',
    keywords: ['大有', '丰收', '富有', '广大', '收获'],
  },
  {
    // 索引 3：谦（下艮上坤）
    id: 15,
    index: 1,
    name: '谦',
    name_cn: '谦',
    symbol: '䷎',
    binary: '001000',
    gua_ci: '谦，亨，君子有终。',
    xiang: '地中有山，谦。君子以裒多益寡，称物平施。',
    yao_ci: [
      '初六：谦谦君子，用涉大川吉',
      '六二：鸣谦，贞吉',
      '九三：劳谦，君子有终吉',
      '六四：无不利，撝谦',
      '六五：不富以其邻，利用侵伐无不利',
      '上六：鸣谦，利用行师征邑国',
    ],
    trigrams: { upper: '☷', lower: '☶', upper_name: '坤', lower_name: '艮' },
    elements: '土',
    bagong: '坤',
    najia: { tiangan: '戊', dianzhi: '寅' },
    nature: '谦逊',
    keywords: ['谦逊', '谦虚', '谦让', '谦卑', '美德'],
  },
  {
    // 索引 24：豫（下坤上震）
    id: 16,
    index: 32,
    name: '豫',
    name_cn: '豫',
    symbol: '䷏',
    binary: '000100',
    gua_ci: '豫，利建侯行师。',
    xiang: '雷出地奋，豫。先王以作乐崇德，殷荐之上帝，以配祖考。',
    yao_ci: [
      '初六：鸣豫，凶',
      '六二：介于石，不终日，贞吉',
      '六三：盱豫悔，迟有悔',
      '九四：由豫，大有得，勿疑，朋盍簪',
      '六五：贞疾，恒不死',
      '上六：冥豫，成有渝，无咎',
    ],
    trigrams: { upper: '☳', lower: '☷', upper_name: '震', lower_name: '坤' },
    elements: '木',
    bagong: '震',
    najia: { tiangan: '己', dianzhi: '卯' },
    nature: '豫乐',
    keywords: ['豫乐', '豫悦', '欢乐', '预备', '喜悦'],
  },
  {
    // 索引 43：随（下震上兑）
    id: 17,
    index: 52,
    name: '随',
    name_cn: '随',
    symbol: '䷐',
    binary: '100110',
    gua_ci: '随，元亨利贞，无咎。',
    xiang: '泽中有雷，随。君子以向晦入宴息。',
    yao_ci: [
      '初九：官有渝，贞吉，出门交有功',
      '六二：系小子，失丈夫',
      '六三：系丈夫，失小子，随有求得，利居贞',
      '九四：随有获，贞凶。有孚在道以明，何咎',
      '九五：孚于嘉，吉',
      '上六：拘系之，乃从维之，王用亨于西山',
    ],
    trigrams: { upper: '☱', lower: '☳', upper_name: '兑', lower_name: '震' },
    elements: '金',
    bagong: '兑',
    najia: { tiangan: '庚', dianzhi: '辰' },
    nature: '随从',
    keywords: ['随从', '跟随', '随意', '变动', '自由'],
  },
  {
    // 索引 30：蛊（下巽上艮）
    id: 18,
    index: 11,
    name: '蛊',
    name_cn: '蛊',
    symbol: '䷑',
    binary: '011001',
    gua_ci: '蛊，元亨。利涉大川，先甲三日，后甲三日。',
    xiang: '山下有风，蛊；君子以振民育德。',
    yao_ci: [
      '初六：干父之蛊，有子，考无咎，厉终吉',
      '九二：干母之蛊，不可贞',
      '九三：干父之蛊，小有悔，无大咎',
      '六四：裕父之蛊，往见吝',
      '六五：干父之蛊，用誉',
      '上九：不事王侯，高尚其事',
    ],
    trigrams: { upper: '☶', lower: '☴', upper_name: '艮', lower_name: '巽' },
    elements: '土',
    bagong: '艮',
    najia: { tiangan: '辛', dianzhi: '巳' },
    nature: '蛊惑',
    keywords: ['蛊惑', '蛊乱', '整治', '弊端', '救治'],
  },
  {
    // 索引 5：临（下兑上坤）
    id: 19,
    index: 6,
    name: '临',
    name_cn: '临',
    symbol: '䷒',
    binary: '110000',
    gua_ci: '临，元亨利贞，至于八月有凶。',
    xiang: '泽上有地，临；君子以教思无穷，容保民无疆。',
    yao_ci: [
      '初九：咸临，贞吉',
      '九二：咸临，吉无不利',
      '六三：甘临，无攸利，既忧之无咎',
      '六四：至临，无咎',
      '六五：知临，大君之宜，吉',
      '上六：敦临，吉无咎',
    ],
    trigrams: { upper: '☷', lower: '☱', upper_name: '坤', lower_name: '兑' },
    elements: '土',
    bagong: '坤',
    najia: { tiangan: '壬', dianzhi: '午' },
    nature: '临观',
    keywords: ['临观', '临察', '监督', '濒临', '视察'],
  },
  {
    // 索引 48：观（下坤上巽）
    id: 20,
    index: 24,
    name: '观',
    name_cn: '观',
    symbol: '䷓',
    binary: '000011',
    gua_ci: '观，盥而不荐，有孚颙若。',
    xiang: '风行地上，观；先王以省方观民设教。',
    yao_ci: [
      '初六：童观，小人无咎，君子吝',
      '六二：窥观，利女贞',
      '六三：观我生，进退',
      '六四：观国之光，利用宾于王',
      '九五：观我生，君子无咎',
      '上九：观其生，君子无咎',
    ],
    trigrams: { upper: '☴', lower: '☷', upper_name: '巽', lower_name: '坤' },
    elements: '木',
    bagong: '巽',
    najia: { tiangan: '癸', dianzhi: '未' },
    nature: '观照',
    keywords: ['观照', '观看', '观察', '仰观', '教化'],
  },
  {
    // 索引 35：噬嗑（下震上离）
    id: 21,
    index: 44,
    name: '噬嗑',
    name_cn: '噬嗑',
    symbol: '䷔',
    binary: '100101',
    gua_ci: '噬嗑，亨，利用狱。',
    xiang: '雷电噬嗑，先王以明罚敕法。',
    yao_ci: [
      '初九：屦校灭趾，无咎',
      '六二：噬肤灭鼻，无咎',
      '六三：噬腊肉遇毒，小吝无咎',
      '九四：噬乾胏，得金矢，利艰贞吉',
      '六五：噬乾肉，得黄金，贞厉无咎',
      '上九：何校灭耳，凶',
    ],
    trigrams: { upper: '☲', lower: '☳', upper_name: '离', lower_name: '震' },
    elements: '火',
    bagong: '离',
    najia: { tiangan: '甲', dianzhi: '申' },
    nature: '噬嗑',
    keywords: ['噬嗑', '噬咬', '刑罚', '断决', '法制'],
  },
  {
    // 索引 28：贲（下离上艮）
    id: 22,
    index: 13,
    name: '贲',
    name_cn: '贲',
    symbol: '䷕',
    binary: '101001',
    gua_ci: '贲，亨，小利有攸往。',
    xiang: '山下有火，贲；君子以明庶政，无敢折狱。',
    yao_ci: [
      '初九：贲其趾，舍车而徒',
      '六二：贲其须',
      '九三：贲如濡如，永贞吉',
      '六四：贲如皤如，白马翰如，匪寇婚媾',
      '六五：贲于丘园，束帛戋戋，吝终吉',
      '上九：白贲，无咎',
    ],
    trigrams: { upper: '☶', lower: '☲', upper_name: '艮', lower_name: '离' },
    elements: '土',
    bagong: '艮',
    najia: { tiangan: '乙', dianzhi: '酉' },
    nature: '贲饰',
    keywords: ['贲饰', '文饰', '装饰', '美化', '礼仪'],
  },
  {
    // 索引 24：剥（下坤上艮）
    id: 23,
    index: 8,
    name: '剥',
    name_cn: '剥',
    symbol: '䷖',
    binary: '000001',
    gua_ci: '剥，不利有攸往。',
    xiang: '山附于地，剥；上以厚下安宅。',
    yao_ci: [
      '初六：剥床以足，蔑贞凶',
      '六二：剥床以辨，蔑贞凶',
      '六三：剥之，无咎',
      '六四：剥床以肤，凶',
      '六五：贯鱼，以宫人宠，无不利',
      '上九：硕果不食，君子得舆，小人剥庐',
    ],
    trigrams: { upper: '☶', lower: '☷', upper_name: '艮', lower_name: '坤' },
    elements: '土',
    bagong: '艮',
    najia: { tiangan: '丙', dianzhi: '戌' },
    nature: '剥落',
    keywords: ['剥落', '剥蚀', '侵蚀', '腐败'],
  },
  {
    // 索引 3：复（下震上坤）
    id: 24,
    index: 4,
    name: '复',
    name_cn: '复',
    symbol: '䷗',
    binary: '100000',
    gua_ci: '复，亨。出入无疾，朋来无咎。反复其道，七日来复，利有攸往。',
    xiang: '雷在地中，复；先王以至日闭关，商旅不行，后不省方。',
    yao_ci: [
      '初九：不远复，无祗悔，元吉',
      '六二：休复，吉',
      '六三：频复，厉无咎',
      '六四：中行独复',
      '六五：敦复，无悔',
      '上六：迷复凶，有灾眚。用行师终有大败，以其国君凶，十年不克征',
    ],
    trigrams: { upper: '☷', lower: '☳', upper_name: '坤', lower_name: '震' },
    elements: '土',
    bagong: '坤',
    najia: { tiangan: '丁', dianzhi: '亥' },
    nature: '回复',
    keywords: ['复归', '复返', '复兴', '回归', '恢复'],
  },
  {
    // 索引 59：无妄（下震上乾）
    id: 25,
    index: 60,
    name: '无妄',
    name_cn: '无妄',
    symbol: '䷘',
    binary: '100111',
    gua_ci: '无妄，元亨利贞。其匪正有眚，不利有攸往。',
    xiang: '天下雷行，物与无妄；先王以茂对时育万物。',
    yao_ci: [
      '初九：无妄，往吉',
      '六二：不耕获，不菑畬，则利有攸往',
      '六三：无妄之灾，或系之牛，行人之得，邑人之灾',
      '九四：可贞，无咎',
      '九五：无妄之疾，勿药有喜',
      '上九：无妄，行有眚，无攸利',
    ],
    trigrams: { upper: '☰', lower: '☳', upper_name: '乾', lower_name: '震' },
    elements: '金',
    bagong: '乾',
    najia: { tiangan: '戊', dianzhi: '子' },
    nature: '无妄',
    keywords: ['无妄', '无望', '不妄', '真诚', '天道'],
  },
  {
    // 索引 31：大畜（下乾上艮）
    id: 26,
    index: 15,
    name: '大畜',
    name_cn: '大畜',
    symbol: '䷙',
    binary: '111001',
    gua_ci: '大畜，利贞。不家食吉，利涉大川。',
    xiang: '天在山中，大畜；君子以多识前言往行，以畜其德。',
    yao_ci: [
      '初九：有厉，利已',
      '九二：舆说輹',
      '九三：良马逐，利艰贞，日闲舆卫，利有攸往',
      '六四：童牛之牿，元吉',
      '六五：豮豕之牙，吉',
      '上九：何天之衢，亨',
    ],
    trigrams: { upper: '☶', lower: '☰', upper_name: '艮', lower_name: '乾' },
    elements: '土',
    bagong: '艮',
    najia: { tiangan: '己', dianzhi: '丑' },
    nature: '大畜',
    keywords: ['大畜', '蓄止', '养育', '大山', '稳重'],
  },
  {
    // 索引 27：颐（下震上艮）
    id: 27,
    index: 12,
    name: '颐',
    name_cn: '颐',
    symbol: '䷚',
    binary: '100001',
    gua_ci: '颐，贞吉。观颐，自求口实。',
    xiang: '山下有雷，颐。君子以慎言语，节饮食。',
    yao_ci: [
      '初九：舍尔灵龟，观我朵颐，凶',
      '六二：颠颐拂经，于丘颐，征凶',
      '六三：拂颐，贞凶，十年勿用，无攸利',
      '六四：颠颐吉，虎视眈眈，其欲逐逐，无咎',
      '六五：拂经，居贞吉，不可涉大川',
      '上九：由颐厉吉，利涉大川',
    ],
    trigrams: { upper: '☶', lower: '☳', upper_name: '艮', lower_name: '震' },
    elements: '土',
    bagong: '艮',
    najia: { tiangan: '庚', dianzhi: '寅' },
    nature: '颐养',
    keywords: ['颐养', '颐卦', '养育', '饮食', '养生'],
  },
  {
    // 索引 46：大过（下巽上兑）
    id: 28,
    index: 51,
    name: '大过',
    name_cn: '大过',
    symbol: '䷛',
    binary: '011110',
    gua_ci: '大过，栋桡，利有攸往，亨。',
    xiang: '泽灭木，大过；君子以独立不惧，遯世无闷。',
    yao_ci: [
      '初六：藉用白茅，无咎',
      '九二：枯杨生稊，老夫得其女妻，无不利',
      '九三：栋桡，凶',
      '九四：栋隆吉，有它吝',
      '九五：枯杨生华，老妇得其士夫，无咎无誉',
      '上六：过涉灭顶，凶无咎',
    ],
    trigrams: { upper: '☱', lower: '☴', upper_name: '兑', lower_name: '巽' },
    elements: '金',
    bagong: '兑',
    najia: { tiangan: '辛', dianzhi: '卯' },
    nature: '大过',
    keywords: ['大过', '大失误', '越常', '危机', '行动'],
  },
  {
    // 索引 18：坎（下坎上坎）
    id: 29,
    index: 18,
    name: '坎',
    name_cn: '坎',
    symbol: '䷜',
    binary: '010010',
    gua_ci: '习坎，有孚维心亨，行有尚。',
    xiang: '水洊至，习坎；君子以常德行，习教事。',
    yao_ci: [
      '初六：习坎，入于坎窞，凶',
      '九二：坎有险，求小得',
      '六三：来之坎坎，险且枕，入于坎窞，勿用',
      '六四：樽酒簋贰，用缶，纳约自牖，终无咎',
      '九五：坎不盈，祗既平，无咎',
      '上六：系用徽纆，置于丛棘，三岁不得，凶',
    ],
    trigrams: { upper: '☵', lower: '☵', upper_name: '坎', lower_name: '坎' },
    elements: '水',
    bagong: '坎',
    najia: { tiangan: '壬', dianzhi: '辰' },
    nature: '坎水',
    keywords: ['坎陷', '坎险', '陷入', '危险', '智慧'],
  },
  {
    // 索引 36：离（下离上离）
    id: 30,
    index: 45,
    name: '离',
    name_cn: '离',
    symbol: '䷝',
    binary: '101101',
    gua_ci: '离，利贞亨，畜牝牛吉。',
    xiang: '明两作，离；大人以继明照于四方。',
    yao_ci: [
      '初九：履错然，敬之无咎',
      '六二：黄离，元吉',
      '九三：日昃之离，不鼓缶而歌，则大耋之嗟，凶',
      '九四：突如其来如，焚如死如弃如',
      '六五：出涕沱若，戚嗟若，吉',
      '上九：王用出征，有嘉折首，获匪其丑，无咎',
    ],
    trigrams: { upper: '☲', lower: '☲', upper_name: '离', lower_name: '离' },
    elements: '火',
    bagong: '离',
    najia: { tiangan: '癸', dianzhi: '巳' },
    nature: '离火',
    keywords: ['离丽', '依附', '美丽', '光明', '文明'],
  },
  {
    // 索引 43：咸（下艮上兑）
    id: 31,
    index: 49,
    name: '咸',
    name_cn: '咸',
    symbol: '䷞',
    binary: '001110',
    gua_ci: '咸，亨利贞，取女吉。',
    xiang: '山上有泽，咸；君子以虚受人。',
    yao_ci: [
      '初六：咸其拇',
      '六二：咸其腓，凶，居吉',
      '九三：咸其股，执其随，往吝',
      '九四：贞吉悔亡，憧憧往来，朋从尔思',
      '九五：咸其脢，无悔',
      '上六：咸其辅颊舌',
    ],
    trigrams: { upper: '☱', lower: '☶', upper_name: '兑', lower_name: '艮' },
    elements: '金',
    bagong: '兑',
    najia: { tiangan: '甲', dianzhi: '午' },
    nature: '咸感',
    keywords: ['咸感', '感应', '情感', '爱情', '沟通'],
  },
  {
    // 索引 30：恒（下巽上震）
    id: 32,
    index: 35,
    name: '恒',
    name_cn: '恒',
    symbol: '䷟',
    binary: '011100',
    gua_ci: '恒，亨无咎利贞，利有攸往。',
    xiang: '雷风，恒，君子以立不易方。',
    yao_ci: [
      '初六：浚恒，贞凶，无攸利',
      '九二：悔亡',
      '九三：不恒其德，或承之羞，贞吝',
      '九四：田无禽',
      '六五：恒其德贞，妇人吉，夫子凶',
      '上六：振恒，凶',
    ],
    trigrams: { upper: '☳', lower: '☴', upper_name: '震', lower_name: '巽' },
    elements: '木',
    bagong: '震',
    najia: { tiangan: '乙', dianzhi: '未' },
    nature: '恒久',
    keywords: ['恒常', '恒久', '持久', '恒心', '稳定'],
  },
  {
    // 索引 59：遯（下艮上乾）
    id: 33,
    index: 57,
    name: '遁',
    name_cn: '遁',
    symbol: '䷠',
    binary: '001111',
    gua_ci: '遯，亨，小利贞。',
    xiang: '天下有山，遁，君子以远小人，不恶而严。',
    yao_ci: [
      '初六：遯尾，厉，勿用有攸往',
      '六二：执之用黄牛之革，莫之胜说',
      '九三：系遯，有疾厉，畜臣妾吉',
      '九四：好遯，君子吉，小人否',
      '九五：嘉遯，贞吉',
      '上九：肥遯，无不利',
    ],
    trigrams: { upper: '☰', lower: '☶', upper_name: '乾', lower_name: '艮' },
    elements: '金',
    bagong: '乾',
    najia: { tiangan: '丙', dianzhi: '申' },
    nature: '遁退',
    keywords: ['遁退', '隐退', '逃避', '撤退', '智慧'],
  },
  {
    // 索引 31：大壮（下乾上震）
    id: 34,
    index: 39,
    name: '大壮',
    name_cn: '大壮',
    symbol: '䷡',
    binary: '111100',
    gua_ci: '大壮，利贞。',
    xiang: '雷在天上，大壮，君子以非礼弗履。',
    yao_ci: [
      '初九：壮于趾，征凶有孚',
      '九二：贞吉',
      '九三：小人用壮，君子用罔，贞厉。羝羊触藩，羸其角',
      '九四：贞吉悔亡，藩决不羸，壮于大舆之輹',
      '六五：丧羊于易，无悔',
      '上六：羝羊触藩，不能退不能遂，无攸利，艰则吉',
    ],
    trigrams: { upper: '☳', lower: '☰', upper_name: '震', lower_name: '乾' },
    elements: '木',
    bagong: '震',
    najia: { tiangan: '丁', dianzhi: '酉' },
    nature: '大壮',
    keywords: ['大壮', '壮大', '强盛', '发展', '行动'],
  },
  {
    // 索引 32：晋（下坤上离）
    id: 35,
    index: 40,
    name: '晋',
    name_cn: '晋',
    symbol: '䷢',
    binary: '000101',
    gua_ci: '晋，康侯用锡马蕃庶，昼日三接。',
    xiang: '明出地上，晋，君子以自昭明德。',
    yao_ci: [
      '初六：晋如摧如，贞吉。罔孚裕无咎',
      '六二：晋如愁如，贞吉，受兹介福于其王母',
      '六三：众允，悔亡',
      '九四：晋如鼫鼠，贞厉',
      '六五：悔亡，失得勿恤，往吉无不利',
      '上九：晋其角，维用伐邑，厉吉无咎，贞吝',
    ],
    trigrams: { upper: '☲', lower: '☷', upper_name: '离', lower_name: '坤' },
    elements: '火',
    bagong: '离',
    najia: { tiangan: '戊', dianzhi: '戌' },
    nature: '晋进',
    keywords: ['晋进', '晋升', '前进', '扩展', '日出'],
  },
  {
    // 索引 4：明夷（下离上坤）
    id: 36,
    index: 5,
    name: '明夷',
    name_cn: '明夷',
    symbol: '䷣',
    binary: '101000',
    gua_ci: '明夷，利艰贞。',
    xiang: '明入地中，明夷，君子以莅众，用晦而明。',
    yao_ci: [
      '初九：明夷于飞，垂其翼。君子于行，三日不食，有攸往主人有言',
      '六二：明夷，夷于左股，用拯马壮吉',
      '九三：明夷于南狩，得其大首，不可疾贞',
      '六四：入于左腹，获明夷之心，于出门庭',
      '六五：箕子之明夷，利贞',
      '上六：不明晦，初登于天，后入于地',
    ],
    trigrams: { upper: '☷', lower: '☲', upper_name: '坤', lower_name: '离' },
    elements: '土',
    bagong: '坤',
    najia: { tiangan: '己', dianzhi: '亥' },
    nature: '明夷',
    keywords: ['明夷', '伤夷', '隐藏', '日落', '黑暗'],
  },
  {
    // 索引 52：家人（下离上巽）
    id: 37,
    index: 29,
    name: '家人',
    name_cn: '家人',
    symbol: '䷤',
    binary: '101011',
    gua_ci: '家人，利女贞。',
    xiang: '风自火出，家人。君子以言有物而行有恒。',
    yao_ci: [
      '初九：闲有家，悔亡',
      '六二：无攸遂，在中馈，贞吉',
      '九三：家人嗃嗃，悔厉吉；妇子嘻嘻，终吝',
      '六四：富家，大吉',
      '九五：王假有家，勿恤吉',
      '上九：有孚威如，终吉',
    ],
    trigrams: { upper: '☴', lower: '☲', upper_name: '巽', lower_name: '离' },
    elements: '木',
    bagong: '巽',
    najia: { tiangan: '庚', dianzhi: '子' },
    nature: '家人',
    keywords: ['家人', '家庭', '内务', '温暖', '责任'],
  },
  {
    // 索引 37：睽（下兑上离）
    id: 38,
    index: 46,
    name: '睽',
    name_cn: '睽',
    symbol: '䷥',
    binary: '110101',
    gua_ci: '睽，小事吉。',
    xiang: '上火下泽，睽，君子以同而异。',
    yao_ci: [
      '初九：悔亡。丧马勿逐自复，见恶人无咎',
      '九二：遇主于巷，无咎',
      '六三：见舆曳，其牛掣，其人天且劓，无初有终',
      '九四：睽孤，遇元夫，交孚厉无咎',
      '六五：悔亡，厥宗噬肤，往何咎',
      '上九：睽孤，见豕负涂，载鬼一车。先张之弧，后说之弧，匪寇婚媾，往遇雨则吉',
    ],
    trigrams: { upper: '☲', lower: '☱', upper_name: '离', lower_name: '兑' },
    elements: '火',
    bagong: '离',
    najia: { tiangan: '辛', dianzhi: '丑' },
    nature: '睽乖',
    keywords: ['睽违', '乖睽', '分离', '对立', '差异'],
  },
  {
    // 索引 19：蹇（下艮上坎）
    id: 39,
    index: 17,
    name: '蹇',
    name_cn: '蹇',
    symbol: '䷦',
    binary: '001010',
    gua_ci: '蹇，利西南，不利东北。利见大人，贞吉。',
    xiang: '山上有水，蹇，君子以反身修德。',
    yao_ci: [
      '初六：往蹇，来誉',
      '六二：王臣蹇蹇，匪躬之故',
      '九三：往蹇，来反',
      '六四：往蹇，来连',
      '九五：大蹇，朋来',
      '上六：往蹇，来硕吉，利见大人',
    ],
    trigrams: { upper: '☵', lower: '☶', upper_name: '坎', lower_name: '艮' },
    elements: '水',
    bagong: '坎',
    najia: { tiangan: '壬', dianzhi: '寅' },
    nature: '蹇难',
    keywords: ['蹇难', '蹇阻', '艰难', '困苦', '障碍'],
  },
  {
    // 索引 26：解（下坎上震）
    id: 40,
    index: 34,
    name: '解',
    name_cn: '解',
    symbol: '䷧',
    binary: '010100',
    gua_ci: '解，利西南。无所往，其来复吉；有攸往，夙吉。',
    xiang: '雷雨作，解，君子以赦过宥罪。',
    yao_ci: [
      '初六：无咎',
      '九二：田获三狐，得黄矢，贞吉',
      '六三：负且乘，致寇至，贞吝',
      '九四：解而拇，朋至斯孚',
      '六五：君子维有解吉，有孚于小人',
      '上六：公用射隼于高墉之上，获之无不利',
    ],
    trigrams: { upper: '☳', lower: '☵', upper_name: '震', lower_name: '坎' },
    elements: '木',
    bagong: '震',
    najia: { tiangan: '癸', dianzhi: '卯' },
    nature: '解散',
    keywords: ['解难', '解除', '缓解', '释放', '自由'],
  },
  {
    // 索引 29：损（下兑上艮）
    id: 41,
    index: 14,
    name: '损',
    name_cn: '损',
    symbol: '䷨',
    binary: '110001',
    gua_ci: '损，有孚元吉无咎，可贞，利有攸往。曷之用，二簋可用享。',
    xiang: '山下有泽，损。君子以惩忿窒欲。',
    yao_ci: [
      '初九：已事遄往，无咎，酌损之',
      '九二：利贞，征凶，弗损益之',
      '六三：三人行则损一人，一人行则得其友',
      '六四：损其疾，使遄有喜，无咎',
      '六五：或益之十朋之龟，弗克违，元吉',
      '上九：弗损益之，无咎贞吉，利有攸往，得臣无家',
    ],
    trigrams: { upper: '☶', lower: '☱', upper_name: '艮', lower_name: '兑' },
    elements: '土',
    bagong: '艮',
    najia: { tiangan: '甲', dianzhi: '辰' },
    nature: '损减',
    keywords: ['损益', '增减', '变化', '调整', '平衡'],
  },
  {
    // 索引 51：益（下震上巽）
    id: 42,
    index: 28,
    name: '益',
    name_cn: '益',
    symbol: '䷩',
    binary: '100011',
    gua_ci: '益，利有攸往，利涉大川。',
    xiang: '风雷，益。君子以见善则迁，有过则改。',
    yao_ci: [
      '初九：利用为大作，元吉无咎',
      '六二：或益之十朋之龟，弗克违，永贞吉，王用享于帝吉',
      '六三：益之用凶事，无咎，有孚中行，告公用圭',
      '六四：中行，告公从，利用为依迁国',
      '九五：元吉无咎，有孚惠心，勿问元吉，有孚惠我德',
      '上九：莫益之，或击之，立心勿恒，凶',
    ],
    trigrams: { upper: '☴', lower: '☳', upper_name: '巽', lower_name: '震' },
    elements: '木',
    bagong: '巽',
    najia: { tiangan: '乙', dianzhi: '巳' },
    nature: '益增',
    keywords: ['益增', '增益', '利益', '施予', '互助'],
  },
  {
    // 索引 47：夬（下乾上兑）
    id: 43,
    index: 55,
    name: '夬',
    name_cn: '夬',
    symbol: '䷪',
    binary: '111110',
    gua_ci: '夬，扬于王庭，孚号有厉。告自邑，不利即戎，利有攸往。',
    xiang: '泽上于天，夬，君子以施禄及下，居德则忌。',
    yao_ci: [
      '初九：壮于前趾，往不胜为咎',
      '九二：惕号，莫夜有戎，勿恤',
      '九三：壮于頄，有凶。君子夬夬独行遇雨，若濡有愠，无咎',
      '九四：臀无肤，其行次且，牵羊悔亡，闻言不信',
      '九五：苋陆夬夬，中行无咎',
      '上六：无号，终有凶',
    ],
    trigrams: { upper: '☱', lower: '☰', upper_name: '兑', lower_name: '乾' },
    elements: '金',
    bagong: '兑',
    najia: { tiangan: '丙', dianzhi: '午' },
    nature: '夬决',
    keywords: ['夬决', '决断', '决定', '果断', '行动'],
  },
  {
    // 索引 62：姤（下巽上乾）
    id: 44,
    index: 59,
    name: '姤',
    name_cn: '姤',
    symbol: '䷫',
    binary: '011111',
    gua_ci: '姤，女壮，勿用取女。',
    xiang: '天下有风，姤；后以施命诰四方。',
    yao_ci: [
      '初六：系于金柅，贞吉。有攸往见凶，羸豕孚蹢躅',
      '九二：包有鱼，无咎，不利宾',
      '九三：臀无肤，其行次且，厉无大咎',
      '九四：包无鱼，起凶',
      '九五：以杞包瓜，含章，有陨自天',
      '上九：姤其角，吝无咎',
    ],
    trigrams: { upper: '☰', lower: '☴', upper_name: '乾', lower_name: '巽' },
    elements: '金',
    bagong: '乾',
    najia: { tiangan: '丁', dianzhi: '未' },
    nature: '姤遇',
    keywords: ['姤遇', '邂逅', '相遇', '偶然'],
  },
  {
    // 索引 40：萃（下坤上兑）
    id: 45,
    index: 48,
    name: '萃',
    name_cn: '萃',
    symbol: '䷬',
    binary: '000110',
    gua_ci: '萃，亨。王假有庙，利见大人亨，利贞。用大牲吉，利有攸往。',
    xiang: '泽上于地，萃。君子以除戎器，戒不虞。',
    yao_ci: [
      '初六：有孚不终，乃乱乃萃。若号，一握为笑，勿恤往无咎',
      '六二：引吉无咎，孚乃利用禴',
      '六三：萃如嗟如，无攸利，往无咎小吝',
      '九四：大吉无咎',
      '九五：萃有位无咎，匪孚，元永贞悔亡',
      '上六：赍咨涕洟，无咎',
    ],
    trigrams: { upper: '☱', lower: '☷', upper_name: '兑', lower_name: '坤' },
    elements: '金',
    bagong: '兑',
    najia: { tiangan: '戊', dianzhi: '申' },
    nature: '萃聚',
    keywords: ['萃聚', '聚集', '聚合', '荟萃', '团结'],
  },
  {
    // 索引 6：升（下巽上坤）
    id: 46,
    index: 3,
    name: '升',
    name_cn: '升',
    symbol: '䷭',
    binary: '011000',
    gua_ci: '升，元亨。用见大人勿恤，南征吉。',
    xiang: '地中生木，升。君子以顺德，积小以高大。',
    yao_ci: [
      '初六：允升，大吉',
      '九二：孚乃利用禴，无咎',
      '九三：升虚邑',
      '六四：王用亨于岐山，吉无咎',
      '六五：贞吉，升阶',
      '上六：冥升，利于不息之贞',
    ],
    trigrams: { upper: '☷', lower: '☴', upper_name: '坤', lower_name: '巽' },
    elements: '土',
    bagong: '坤',
    najia: { tiangan: '己', dianzhi: '酉' },
    nature: '晋升',
    keywords: ['升进', '上升', '提升', '进步', '发展'],
  },
  {
    // 索引 42：困（下坎上兑）
    id: 47,
    index: 50,
    name: '困',
    name_cn: '困',
    symbol: '䷮',
    binary: '010110',
    gua_ci: '困，亨。贞大人吉无咎，有言不信。',
    xiang: '泽无水，困。君子以致命遂志。',
    yao_ci: [
      '初六：臀困于株木，入于幽谷，三岁不觌',
      '九二：困于酒食，朱绂方来，利用享祀，征凶无咎',
      '六三：困于石，据于蒺藜，入于其宫不见其妻，凶',
      '九四：来徐徐，困于金车，吝有终',
      '九五：劓刖，困于赤绂，乃徐有说，利用祭祀',
      '上六：困于葛藟，于臲卼，曰动悔有悔，征吉',
    ],
    trigrams: { upper: '☱', lower: '☵', upper_name: '兑', lower_name: '坎' },
    elements: '金',
    bagong: '兑',
    najia: { tiangan: '庚', dianzhi: '戌' },
    nature: '困厄',
    keywords: ['困局', '被困', '困境', '穷困', '等待'],
  },
  {
    // 索引 22：井（下巽上坎）
    id: 48,
    index: 19,
    name: '井',
    name_cn: '井',
    symbol: '䷯',
    binary: '011010',
    gua_ci: '井，改邑不改井，无丧无得，往来井井。汔至亦未繘井，羸其瓶，凶。',
    xiang: '木上有水，井。君子以劳民劝相。',
    yao_ci: [
      '初六：井泥不食，旧井无禽',
      '九二：井谷射鲋，瓮敝漏',
      '九三：井渫不食，为我心恻，可用汲，王明并受其福',
      '六四：井甃，无咎',
      '九五：井冽，寒泉食',
      '上六：井收勿幕，有孚元吉',
    ],
    trigrams: { upper: '☵', lower: '☴', upper_name: '坎', lower_name: '巽' },
    elements: '水',
    bagong: '坎',
    najia: { tiangan: '辛', dianzhi: '亥' },
    nature: '井养',
    keywords: ['井泉', '水井', '不变', '稳定', '汲取'],
  },
  {
    // 索引 44：革（下离上兑）
    id: 49,
    index: 53,
    name: '革',
    name_cn: '革',
    symbol: '䷰',
    binary: '101110',
    gua_ci: '革，己日乃孚，元亨利贞，悔亡。',
    xiang: '泽中有火，革。君子以治历，明时。',
    yao_ci: [
      '初九：巩用黄牛之革',
      '六二：己日乃革之，征吉无咎',
      '九三：征凶贞厉，革言三就，有孚',
      '九四：悔亡，有孚改命吉',
      '九五：大人虎变，未占有孚',
      '上六：君子豹变，小人革面，征凶居贞吉',
    ],
    trigrams: { upper: '☱', lower: '☲', upper_name: '兑', lower_name: '离' },
    elements: '金',
    bagong: '兑',
    najia: { tiangan: '壬', dianzhi: '子' },
    nature: '革命',
    keywords: ['革新', '变革', '更新', '去除', '改变'],
  },
  {
    // 索引 38：鼎（下巽上离）
    id: 50,
    index: 43,
    name: '鼎',
    name_cn: '鼎',
    symbol: '䷱',
    binary: '011101',
    gua_ci: '鼎，元吉亨。',
    xiang: '木上有火，鼎。君子以正位凝命。',
    yao_ci: [
      '初六：鼎颠趾，利出否，得妾以其子无咎',
      '九二：鼎有实，我仇有疾，不我能即吉',
      '九三：鼎耳革，其行塞，雉膏不食，方雨亏悔终吉',
      '九四：鼎折足，覆公餗，其形渥凶',
      '六五：鼎黄耳金铉，利贞',
      '上九：鼎玉铉，大吉无不利',
    ],
    trigrams: { upper: '☲', lower: '☴', upper_name: '离', lower_name: '巽' },
    elements: '火',
    bagong: '离',
    najia: { tiangan: '癸', dianzhi: '丑' },
    nature: '鼎烹',
    keywords: ['鼎器', '宝鼎', '权威', '稳定', '更新'],
  },
  {
    // 索引 27：震（下震上震）
    id: 51,
    index: 36,
    name: '震',
    name_cn: '震',
    symbol: '䷲',
    binary: '100100',
    gua_ci: '震，亨。震来虩虩，笑言哑哑，震惊百里，不丧匕鬯。',
    xiang: '洊雷震。君子以恐惧修省。',
    yao_ci: [
      '初九：震来虩虩，后笑言哑哑吉',
      '六二：震来厉，亿丧贝，跻于九陵，勿逐七日得',
      '六三：震苏苏，震行无眚',
      '九四：震遂泥',
      '六五：震往来厉，亿无丧有事',
      '上六：震索索，视矍矍，征凶。震不于其躬于其邻，无咎，婚媾有言',
    ],
    trigrams: { upper: '☳', lower: '☳', upper_name: '震', lower_name: '震' },
    elements: '木',
    bagong: '震',
    najia: { tiangan: '甲', dianzhi: '寅' },
    nature: '震动',
    keywords: ['震雷', '震动', '威严', '惊恐', '振奋'],
  },
  {
    // 索引 18：艮（下艮上艮）
    id: 52,
    index: 9,
    name: '艮',
    name_cn: '艮',
    symbol: '䷳',
    binary: '001001',
    gua_ci: '艮，艮其背，不获其身，行其庭不见其人，无咎。',
    xiang: '兼山，艮。君子以思不出其位。',
    yao_ci: [
      '初六：艮其趾，无咎，利永贞',
      '六二：艮其腓，不拯其随，其心不快',
      '九三：艮其限，列其夤，厉薰心',
      '六四：艮其身，无咎',
      '六五：艮其辅，言有序，悔亡',
      '上九：敦艮，吉',
    ],
    trigrams: { upper: '☶', lower: '☶', upper_name: '艮', lower_name: '艮' },
    elements: '土',
    bagong: '艮',
    najia: { tiangan: '乙', dianzhi: '卯' },
    nature: '艮止',
    keywords: ['艮止', '静止', '停止', '稳健', '安宁'],
  },
  {
    // 索引 50：渐（下艮上巽）
    id: 53,
    index: 25,
    name: '渐',
    name_cn: '渐',
    symbol: '䷴',
    binary: '001011',
    gua_ci: '渐，女归吉，利贞。',
    xiang: '山上有木，渐。君子以居贤德善俗。',
    yao_ci: [
      '初六：鸿渐于干，小子厉有言，无咎',
      '六二：鸿渐于磐，饮食衎衎吉',
      '九三：鸿渐于陆，夫征不复，妇孕不育凶，利御寇',
      '六四：鸿渐于木，或得其桷，无咎',
      '九五：鸿渐于陵，妇三岁不孕，终莫之胜吉',
      '上九：鸿渐于陆，其羽可用为仪吉',
    ],
    trigrams: { upper: '☴', lower: '☶', upper_name: '巽', lower_name: '艮' },
    elements: '木',
    bagong: '巽',
    najia: { tiangan: '丙', dianzhi: '辰' },
    nature: '渐进',
    keywords: ['渐近', '渐进', '稳步', '进步'],
  },
  {
    // 索引 29：归妹（下兑上震）
    id: 54,
    index: 38,
    name: '归妹',
    name_cn: '归妹',
    symbol: '䷵',
    binary: '110100',
    gua_ci: '归妹，征凶，无攸利。',
    xiang: '泽上有雷，归妹，君子以永终知敝。',
    yao_ci: [
      '初九：归妹以娣，跛能履，征吉',
      '九二：眇能视，利幽人之贞',
      '六三：归妹以须，反归以娣',
      '九四：归妹愆期，迟归有时',
      '六五：帝乙归妹，其君之袂不如其娣之袂良，月几望吉',
      '上六：女承筐无实，士刲羊无血，无攸利',
    ],
    trigrams: { upper: '☳', lower: '☱', upper_name: '震', lower_name: '兑' },
    elements: '木',
    bagong: '震',
    najia: { tiangan: '丁', dianzhi: '巳' },
    nature: '归妹',
    keywords: ['归妹', '嫁女', '结果', '归宿', '完成'],
  },
  {
    // 索引 28：丰（下离上震）
    id: 55,
    index: 37,
    name: '丰',
    name_cn: '丰',
    symbol: '䷶',
    binary: '101100',
    gua_ci: '丰，亨。王假之，勿忧，宜日中。',
    xiang: '雷电皆至，丰。君子以折狱致刑。',
    yao_ci: [
      '初九：遇其配主，虽旬无咎，往有尚',
      '六二：丰其蔀，日中见斗，往得疑疾，有孚发若吉',
      '九三：丰其沛，日中见沫，折其右肱，无咎',
      '九四：丰其蔀，日中见斗，遇其夷主吉',
      '六五：来章，有庆誉吉',
      '上六：丰其屋，蔀其家，窥其户阒其无人，三岁不觌凶',
    ],
    trigrams: { upper: '☳', lower: '☲', upper_name: '震', lower_name: '离' },
    elements: '木',
    bagong: '震',
    najia: { tiangan: '戊', dianzhi: '午' },
    nature: '丰大',
    keywords: ['丰大', '丰盛', '丰满', '丰富', '盛大'],
  },
  {
    // 索引 34：旅（下艮上离）
    id: 56,
    index: 41,
    name: '旅',
    name_cn: '旅',
    symbol: '䷷',
    binary: '001101',
    gua_ci: '旅，小亨，旅贞吉。',
    xiang: '山上有火，旅。君子以明慎用刑，而不留狱。',
    yao_ci: [
      '初六：旅琐琐，斯其所取灾',
      '六二：旅即次，怀其资，得童仆贞',
      '九三：旅焚其次，丧其童仆，贞厉',
      '九四：旅于处，得其资斧，我心不快',
      '六五：射雉，一矢亡，终以誉命',
      '上九：鸟焚其巢，旅人先笑后号咷，丧牛于易凶',
    ],
    trigrams: { upper: '☲', lower: '☶', upper_name: '离', lower_name: '艮' },
    elements: '火',
    bagong: '离',
    najia: { tiangan: '己', dianzhi: '未' },
    nature: '旅寄',
    keywords: ['旅居', '旅行', '流浪', '漂泊', '不安'],
  },
  {
    // 索引 54：巽（下巽上巽）
    id: 57,
    index: 27,
    name: '巽',
    name_cn: '巽',
    symbol: '䷸',
    binary: '011011',
    gua_ci: '巽，小亨，利有攸往，利见大人。',
    xiang: '随风，巽。君子以申命行事。',
    yao_ci: [
      '初六：进退，利武人之贞',
      '九二：巽在床下，用史巫纷若，吉无咎',
      '九三：频巽，吝',
      '六四：悔亡，田获三品',
      '九五：贞吉悔亡，无不利，无初有终，先庚三日，后庚三日吉',
      '上九：巽在床下，丧其资斧，贞凶',
    ],
    trigrams: { upper: '☴', lower: '☴', upper_name: '巽', lower_name: '巽' },
    elements: '木',
    bagong: '巽',
    najia: { tiangan: '庚', dianzhi: '申' },
    nature: '巽入',
    keywords: ['巽入', '进入', '谦逊', '渗透', '柔顺'],
  },
  {
    // 索引 45：兑（下兑上兑）
    id: 58,
    index: 54,
    name: '兑',
    name_cn: '兑',
    symbol: '䷹',
    binary: '110110',
    gua_ci: '兑，亨，利贞。',
    xiang: '丽泽，兑，君子以朋友讲习。',
    yao_ci: [
      '初九：和兑，吉',
      '九二：孚兑，吉悔亡',
      '六三：来兑，凶',
      '九四：商兑未宁，介疾有喜',
      '九五：孚于剥，有厉',
      '上六：引兑',
    ],
    trigrams: { upper: '☱', lower: '☱', upper_name: '兑', lower_name: '兑' },
    elements: '金',
    bagong: '兑',
    najia: { tiangan: '辛', dianzhi: '酉' },
    nature: '兑悦',
    keywords: ['兑悦', '喜悦', '说话', '和谐', '愉快'],
  },
  {
    // 索引 50：涣（下坎上巽）
    id: 59,
    index: 26,
    name: '涣',
    name_cn: '涣',
    symbol: '䷺',
    binary: '010011',
    gua_ci: '涣，亨。王假有庙，利涉大川，利贞。',
    xiang: '风行水上，涣，先王以享于帝，立庙。',
    yao_ci: [
      '初六：用拯马壮吉',
      '九二：涣奔其机，悔亡',
      '六三：涣其躬，无悔',
      '六四：涣其群，元吉，涣有丘，匪夷所思',
      '九五：涣汗其大号，涣王居，无咎',
      '上九：涣其血，去逖出，无咎',
    ],
    trigrams: { upper: '☴', lower: '☵', upper_name: '巽', lower_name: '坎' },
    elements: '木',
    bagong: '巽',
    najia: { tiangan: '壬', dianzhi: '戌' },
    nature: '涣散',
    keywords: ['涣散', '涣发', '离散', '分散', '拯救'],
  },
  {
    // 索引 21：节（下兑上坎）
    id: 60,
    index: 22,
    name: '节',
    name_cn: '节',
    symbol: '䷻',
    binary: '110010',
    gua_ci: '节，亨，苦节不可贞。',
    xiang: '泽上有水，节。君子以制数度，议德行。',
    yao_ci: [
      '初九：不出户庭，无咎',
      '九二：不出门庭，凶',
      '六三：不节若，则嗟若，无咎',
      '六四：安节，亨',
      '九五：甘节，吉，往有尚',
      '上六：苦节，贞凶悔亡',
    ],
    trigrams: { upper: '☵', lower: '☱', upper_name: '坎', lower_name: '兑' },
    elements: '水',
    bagong: '坎',
    najia: { tiangan: '癸', dianzhi: '亥' },
    nature: '节度',
    keywords: ['节止', '节制', '节约', '限制', '控制'],
  },
  {
    // 索引 53：中孚（下兑上巽）
    id: 61,
    index: 30,
    name: '中孚',
    name_cn: '中孚',
    symbol: '䷼',
    binary: '110011',
    gua_ci: '中孚，豚鱼吉，利涉大川，利贞。',
    xiang: '泽上有风，中孚。君子以议狱缓死。',
    yao_ci: [
      '初九：虞吉，有它不燕',
      '九二：鸣鹤在阴，其子和之，我有好爵，吾与尔靡之',
      '六三：得敌，或鼓或罢，或泣或歌',
      '六四：月几望，马匹亡，无咎',
      '九五：有孚挛如，无咎',
      '上九：翰音登于天，贞凶',
    ],
    trigrams: { upper: '☴', lower: '☱', upper_name: '巽', lower_name: '兑' },
    elements: '木',
    bagong: '巽',
    najia: { tiangan: '甲', dianzhi: '子' },
    nature: '孚信',
    keywords: ['中孚', '诚信', '信用', '中心', '守信'],
  },
  {
    // 索引 25：小过（下艮上震）
    id: 62,
    index: 33,
    name: '小过',
    name_cn: '小过',
    symbol: '䷽',
    binary: '001100',
    gua_ci: '小过，亨利贞，可小事不可大事。飞鸟遗之音，不宜上宜下，大吉。',
    xiang: '山上有雷，小过。君子以行过乎恭，丧过乎哀，用过乎俭。',
    yao_ci: [
      '初六：飞鸟以凶',
      '六二：过其祖，遇其妣，不及其君遇其臣，无咎',
      '九三：弗过防之，从或戕之，凶',
      '九四：无咎，弗过遇之，往厉必戒，勿用永贞',
      '六五：密云不雨，自我西郊，公弋取彼在穴',
      '上六：弗遇过之，飞鸟离之凶，是谓灾眚',
    ],
    trigrams: { upper: '☳', lower: '☶', upper_name: '震', lower_name: '艮' },
    elements: '木',
    bagong: '震',
    najia: { tiangan: '乙', dianzhi: '丑' },
    nature: '小过',
    keywords: ['小过', '过度', '纠正', '小事'],
  },
  {
    // 索引 20：既济（下离上坎）
    id: 63,
    index: 21,
    name: '既济',
    name_cn: '既济',
    symbol: '䷾',
    binary: '101010',
    gua_ci: '既济，亨小利贞，初吉终乱。',
    xiang: '水在火上，既济。君子以思患而豫防之。',
    yao_ci: [
      '初九：曳其轮，濡其尾，无咎',
      '六二：妇丧其茀，勿逐七日得',
      '九三：高宗伐鬼方，三年克之，小人勿用',
      '六四：繻有衣袽，终日戒',
      '九五：东邻杀牛，不如西邻之禴祭，实受其福',
      '上六：濡其首，厉',
    ],
    trigrams: { upper: '☵', lower: '☲', upper_name: '坎', lower_name: '离' },
    elements: '水',
    bagong: '坎',
    najia: { tiangan: '丙', dianzhi: '寅' },
    nature: '既济',
    keywords: ['既济', '完成', '成功', '完美'],
  },
  {
    // 索引 34：未济（下坎上离）
    id: 64,
    index: 42,
    name: '未济',
    name_cn: '未济',
    symbol: '䷿',
    binary: '010101',
    gua_ci: '未济，亨。小狐汔济，濡其尾，无攸利。',
    xiang: '火在水上，未济。君子以慎辨物居方。',
    yao_ci: [
      '初六：濡其尾，吝',
      '九二：曳其轮，贞吉',
      '六三：未济，征凶，利涉大川',
      '九四：贞吉悔亡，震用伐鬼方，三年有赏于大国',
      '六五：贞吉无悔，君子之光，有孚吉',
      '上九：有孚于饮酒，无咎，濡其首，有孚失是',
    ],
    trigrams: { upper: '☲', lower: '☵', upper_name: '离', lower_name: '坎' },
    elements: '火',
    bagong: '离',
    najia: { tiangan: '丁', dianzhi: '卯' },
    nature: '未济',
    keywords: ['未济', '未成', '未完成', '继续', '希望'],
  },
];

// ============================================================
// ============================================================
// 基数防错 (2026-10-21, 老板亲口点过的坑)
// ============================================================
//
// 「还有 64卦有一个最大的坑, 不是 1~64 是 0~63」——
// 这张表里**三套编号同时存在**, 而且互相不重合:
//
//   字段        取值        含义                      生产调用者
//   id          1..64       卦序 (文王卦序, 乾=1 坤=2)   主路径, 全部
//   index       0..63       六爻二进制的整数值 (乾=63 坤=0)  **零个**
//   binary      '111111'    同一件事的可读形式                —
//
// 注意 1..64 和 0..63 在 1..63 上**完全重叠** ——
// 传错基数不会报错, 只会安静地返回**另一卦**。坤(id 2)在 index 表里是 0;
// 乾(id 1)在 index 表里是 63。少 1 错一位, 卦就整个变了, 而且没有异常。
//
// 现在没有机制挡这个。下面这个断言是**加载时**跑的:
// 数据一旦漂了(多一条、重复、binary 和 index 对不上、序号改成 0 基),
// require 这模块的那一刻就炸, 而不是等到某天算出一卦错的。
function assertBaseIntegrity() {
  const ids = new Set();
  const idx = new Set();
  for (const h of HEXAGRAMS) {
    if (!Number.isInteger(h.id) || h.id < 1 || h.id > 64) {
      throw new Error('[hexagrams] id 越界: ' + h.name + ' id=' + h.id + ' (必须 1..64, 1 基)');
    }
    if (ids.has(h.id)) throw new Error('[hexagrams] id 重复: ' + h.id + ' (' + h.name + ')');
    ids.add(h.id);

    //
    // index 与 binary 是**同一组 6 位**, 但排法相反 (实测 64/64 全中, 不是猜的):
    //   index  = 上卦三位 ‖ 下卦三位   →  卦序序, 乾=63(111111) 坤=0
    //   binary = 下卦三位 ‖ 上卦三位   →  爻位序, 初爻→上爻, 自下而上读
    // 所以 index 的二进制串**前后两半对调**就等于 binary:
    //   屯: index 20 = '010100' (上坎010 ‖ 下震100)
    //        binary  = '100010' (下震100 ‖ 上坎010)  ✓
    //
    // ⚠️ 第一版这里写的是 `parseInt(binary, 2) === h.index` —— 那条**对 64 卦里的 56 卦
    // 都是假的**, 一 require 就炸。没去核实际关系就写断言, 断言本身就成了噪音。
    // 教训: 写自检之前先把手上的数据量一遍 (这次是 eval 出来跑 64 条)。
    if (!Number.isInteger(h.index) || h.index < 0 || h.index > 63) {
      throw new Error('[hexagrams] index 越界: ' + h.name + ' index=' + h.index + ' (必须 0..63, 0 基)');
    }
    if (idx.has(h.index)) throw new Error('[hexagrams] index 重复: ' + h.index + ' (' + h.name + ')');
    idx.add(h.index);

    if (typeof h.binary !== 'string' || !/^[01]{6}$/.test(h.binary)) {
      throw new Error('[hexagrams] binary 形态不对: ' + h.name + ' binary=' + JSON.stringify(h.binary));
    }
    const ib = h.index.toString(2).padStart(6, '0');
    const expectBinary = ib.slice(3) + ib.slice(0, 3);
    if (h.binary !== expectBinary) {
      throw new Error('[hexagrams] index 与 binary 不一致: ' + h.name
        + ' index=' + h.index + "(='" + ib + "' 上卦‖下卦) 推出 binary 应为 '"
        + expectBinary + "' 但表里是 '" + h.binary + "'");
    }
    // symbol 是 Unicode「易经卦符」块的单字符卦符, 不是上下卦拼 (如 ䷳ ䷵ 那种三画组合)。
    // 那个块的排法恰好就是文王卦序: U+4DC0 ䷀=乾 … U+4DFF ䷿=未济。
    //
    // ⚠️ 这一条改过一次。第一版断言的是「卦符必须由上下卦拼成」, 结果 64 卦**全部**报错 ——
    // 看上去像是 64 条数据全坏了, 差一步就把 64 个正确值按错的期望值"修"成了垃圾。
    // 断言写错比没断言更贵: 它会**主动**把你推向错误方向。
    const wantSymbol = String.fromCharCode(0x4DC0 + h.id - 1);
    if (h.symbol !== wantSymbol) {
      throw new Error('[hexagrams] 卦符与卦序脱钩: ' + h.name + ' id=' + h.id
        + " 应为 " + wantSymbol + '(U+' + (0x4DC0 + h.id - 1).toString(16).toUpperCase()
        + ') 但表里是 ' + h.symbol);
    }

  }
  if (HEXAGRAMS.length !== 64) {
    throw new Error('[hexagrams] 卦数不是 64, 实为 ' + HEXAGRAMS.length);
  }
  assertKeywordsAligned(HEXAGRAMS);
}

/**
 * keywords 必须**属于本卦** —— 这条是 2026-10-21 加的, 因为它已经错过一次。
 *
 * 实测: 27/64 卦的 keywords 是**隔壁卦的**, 而且是一整条错位链, 不报错、不抛异常:
 *   20观→21噬嗑 21噬嗑→22贲 22贲→23剥 23剥→24复 24复→25无妄 …
 *   48井→50鼎 49革→51震 … 62小过→64未济
 * 后果不是崩, 是**答错**: 主人问"第24卦", hexagram_lookup 把复卦连同**无妄的**
 * keywords 一起端给模型, 模型当场发现不对, 在答案里写"疑为该数据源字段错位"。
 * 64i 自己不消费 keywords (它只原样透给 LLM), 所以没有任何一处会喊疼。
 *
 * 判据: 本文件里 keywords 的约定是**首项带卦名**(屯难/蒙昧/剥落/复归…),
 * 所以"首项的前缀是另一卦的名"就是错位。
 * 乾/坤 是仅有的两个例外 —— 它们的关键词讲的是天地定位(天道/地道)而不是卦名,
 * 天然不含"乾/坤"字样, 白名单里显式放行, 不靠放宽规则蒙过去。
 *
 * 单独导出(而不是只写在 assertBaseIntegrity 里)是为了能**直接拿错数据喂它**做负例 ——
 * 断言自己不接受负例检验, 等于不知道它会不会真炸。
 */
function assertKeywordsAligned(list) {
  const KEYWORDS_NAME_OPTIONAL = new Set(['乾', '坤']);
  for (const h of list) {
    if (!Array.isArray(h.keywords) || h.keywords.length === 0) {
      throw new Error('[hexagrams] keywords 为空: ' + h.name + ' id=' + h.id);
    }
    const seen = new Set();
    for (const k of h.keywords) {
      if (seen.has(k)) {
        throw new Error('[hexagrams] keywords 内部重复: ' + h.name + ' id=' + h.id
          + ' 出现两次 "' + k + '" —— ' + JSON.stringify(h.keywords));
      }
      seen.add(k);
    }
    if (KEYWORDS_NAME_OPTIONAL.has(h.name)) continue;
    const kw0 = String(h.keywords[0]);
    if (!kw0.startsWith(h.name)) {
      const realOwner = list.find(x => x.id !== h.id && x.name !== h.name && kw0.startsWith(x.name));
      throw new Error('[hexagrams] keywords 与本卦脱钩: ' + h.name + ' id=' + h.id
        + ' 的 keywords 首项是 "' + kw0 + '"'
        + (realOwner ? ' —— 那是 id=' + realOwner.id + ' ' + realOwner.name + ' 的词, 整条链错位了一格' : '')
        + '; 本卦首项应以 "' + h.name + '" 开头');
    }
  }
}
assertBaseIntegrity();

/**
 * 基数转换: 卦序(1基) ↔ 二进制索引(0基)。
 *
 * ⚠️ 两个数在 1..63 上**完全重叠** —— 只传一个裸数字进来,
 * 程序**没有可能**猜对你想问的是哪一套。所以这两个函数强制显式:
 * 想要索引就调 indexToId, 想要卦序就调 idToIndex, 别手算。
 *
 * @param {number} id 卦序 1..64
 * @returns {number} 0 基索引 0..63
 */
function idToIndex(id) {
  const h = getHexagram(id);
  if (!h) throw new RangeError('[hexagrams] id=' + id + ' 不存在 (卦序是 **1..64**, 1 基; '
    + '若你要的是 0 基二进制索引, 请改用 getHexagramByIndex)');
  return h.index;
}

/**
 * @param {number} index 0 基二进制索引 0..63
 * @returns {number} 卦序 1..64
 */
function indexToId(index) {
  const h = getHexagramByIndex(index);
  if (!h) throw new RangeError('[hexagrams] index=' + index + ' 不存在 (二进制索引是 **0..63**, 0 基; '
    + '若你要的是 1 基卦序, 请改用 getHexagram)');
  return h.id;
}

/**
 * 卦象名 —— 这一卦**该怎么称**。
 *
 * 两种形状, 没有第三种:
 *   非纯卦 = 上象 + 下象 + 卦名   (山火贲 / 地雷复 / 风天小畜)
 *   纯  卦 = 卦名 + 为 + 象       (震为雷 / 乾为天)
 * **从来没有「象+象+象」** —— 这条是判据 ②b 的来源(见 modules/gua_answer_gate.js)。
 *
 * 象名(天/泽/火/雷/风/水/山/地)取自八卦公理表的 `nature` 字段
 * (震→雷, 艮→山 …), **不另抄一份** —— 抄的迟早只改其中一份。
 *
 * ⚠️ 跟 `nature`(=卦义, 序卦传「贲者饰也」→ 贲饰) 是**两样东西**,
 *   名字都带「象」, 最容易混:
 *     卦象名 = 卦的**构成**象 (山火贲)
 *     卦  义 = 卦的**义**象     (贲饰)
 *   2026-10-22 E2E 实测: 工具只给 nature, 模型就把「贲饰」填进了「卦象名」栏。
 *   所以工具输出里两个都得给, 不给模型就得凭记忆补 —— 「地天雷」那类编造就是这么来的。
 *
 * @param {object} h 64i 卦对象
 * @returns {string} 卦象名 (取不到时返回空串, 不猜)
 */
function xiangNameOf(h) {
  if (!h || !h.trigrams) return '';
  const up = NATURE_OF_BAGUA[h.trigrams.upper_name];
  const low = NATURE_OF_BAGUA[h.trigrams.lower_name];
  if (!up || !low) return '';
  return (h.trigrams.upper_name === h.trigrams.lower_name)
    ? h.name + '为' + up
    : up + low + h.name;
}

// 工具函数
// ============================================================

/**
 * 获取卦
 * @param {number} id - 卦ID（1-64）
 * @returns {object|null}
 */
function getHexagram(id) {
  return HEXAGRAMS.find(h => h.id === id) || null;
}

/**
 * 根据卦名获取卦
 * @param {string} name
 * @returns {object|null}
 */
function getHexagramByName(name) {
  return HEXAGRAMS.find(h => h.name === name || h.name_cn === name) || null;
}

/**
 * 获取所有卦
 * @returns {object[]}
 */
function getAllHexagrams() {
  return HEXAGRAMS.map(h => ({ ...h }));
}

/**
 * 通过二进制索引获取卦
 * @param {number} index - 0-63
 * @returns {object|null}
 */
function getHexagramByIndex(index) {
  return HEXAGRAMS.find(h => h.index === index) || null;
}

/**
 * 获取卦的二进制索引
 * @param {number} hexagramId
 * @returns {number}
 */
function hexagramIdToIndex(hexagramId) {
  const h = getHexagram(hexagramId);
  return h ? h.index : -1;
}

/**
 * 获取卦的6爻符号串
 * @param {number} hexagramId
 * @returns {string} 如 '111111'
 */
function getHexagramYaoBinary(hexagramId) {
  const h = getHexagram(hexagramId);
  return h ? h.binary : null;
}

/**
 * 获取卦的6爻符号
 * @param {number} hexagramId
 * @returns {string} 如 '☰☰☰☰☰☰'
 */
function getHexagramYaoSymbol(hexagramId) {
  const h = getHexagram(hexagramId);
  if (!h) return null;
  return h.binary.split('').map(b => b === '1' ? '⚊' : '⚋').join('');
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  HEXAGRAMS,
  getHexagram,
  getHexagramByName,
  getAllHexagrams,
  getHexagramByIndex,
  hexagramIdToIndex,
  // 基数显式版 (2026-10-21): 裸数字在 1..63 上两套编号完全重叠, 不许靠猜。
  idToIndex,
  indexToId,
  // 卦象名 (山火贲 / 震为雷) —— 64i 真源, 工具与门都用它, 不各抄一份
  xiangNameOf,
  assertBaseIntegrity,
  assertKeywordsAligned,
  getHexagramYaoBinary,
  getHexagramYaoSymbol,
};
