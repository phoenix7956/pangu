/**
 * Pangu · 64i Layer
 * bagua_annotations/bagua_axioms.js
 *
 * Pangu 8 维向量的八卦数据层 - 2026-06-18 老板拍板完全重构
 *
 * 8 卦完整属性公理表
 * 顺序采用先天序（伏羲序）：乾1兑2离3巽4震5艮6坎7坤8
 *
 * 字段说明（公理 = 不可变底层属性）：
 *   name          卦名
 *   symbol        卦象符号（Unicode 三爻）
 *   bits          3 位二进制（先天序编码）
 *   trigramIndex  八卦序号 1-8（先天序）
 *   polarity      阴阳（阳/阴）
 *   wuxing        五行（金/木/水/火/土）
 *   family        家庭人伦（父/母/长男/中男/少男/长女/中女/少女）
 *   nature        自然象征（天/泽/火/雷/风/水/山/地）
 *   season        季节
 *   direction     方位（后天方位）
 *   attribute     主要属性（卦德）
 *   keywords      关键词数组
 */

'use strict';

// ============================================================
// 8 卦公理表（先天序：乾1兑2离3震4巽5坎6艮7坤8）
//
// ⚠️ 2026-10-22 第 42 批: 先天序原来是「乾1兑2离3巽4震5艮6坎7坤8」——
//   **震/巽 与 坎/艮 两对都错位了**, 而且跟本表自己的「方位」字段自相矛盾
//   (方位是震东北/巽西南/艮西北/坎西, 按先天圆图走一圈必须是 震4巽5坎6艮7)。
//   出处: 64i/sources/course_bagua_fundamental.txt
//     「八卦的顺序是乾一、兑二、离三、震四、巽五、坎六、艮七、坤八。」
//   是出处层(64i/provenance.js)的 live 探针把这处对不上的, 不是拍脑袋改的。
// ============================================================

const BAGUA_AXIOMS = [
  {
    name: '乾',
    symbol: '☰',
    bits: '111',
    trigramIndex: 1,
    polarity: '阳',
    wuxing: '金',
    family: '父',
    nature: '天',
    season: '秋末冬初',
    direction: '西北',
    attribute: '刚健/创造/领导',
    keywords: ['刚健', '创造', '领导', '纯粹'],
  },
  {
    name: '兑',
    symbol: '☱',
    bits: '110',
    trigramIndex: 2,
    polarity: '阴',
    wuxing: '金',
    family: '少女',
    nature: '泽',
    season: '秋',
    direction: '西',
    attribute: '喜悦/和悦',
    keywords: ['喜悦', '和悦', '口舌', '柔美'],
  },
  {
    name: '离',
    symbol: '☲',
    bits: '101',
    trigramIndex: 3,
    polarity: '阴',
    wuxing: '火',
    family: '中女',
    nature: '火',
    season: '夏',
    direction: '南',
    attribute: '光明/依附',
    keywords: ['光明', '依附', '文明', '热烈'],
  },
  {
    name: '震',
    symbol: '☳',
    bits: '100',
    trigramIndex: 4,
    polarity: '阳',
    wuxing: '木',
    family: '长男',
    nature: '雷',
    season: '春',
    direction: '东',
    attribute: '震动/启动',
    keywords: ['震动', '启动', '惊醒', '奋起'],
  },
  {
    name: '巽',
    symbol: '☴',
    bits: '011',
    trigramIndex: 5,
    polarity: '阴',
    wuxing: '木',
    family: '长女',
    nature: '风',
    season: '春末',
    direction: '东南',
    attribute: '顺从/渗透',
    keywords: ['顺从', '渗透', '谦逊', '进退'],
  },
  {
    name: '坎',
    symbol: '☵',
    bits: '010',
    trigramIndex: 6,
    polarity: '阳',
    wuxing: '水',
    family: '中男',
    nature: '水',
    season: '冬',
    direction: '北',
    attribute: '险阻/智慧',
    keywords: ['险阻', '智慧', '流动', '隐伏'],
  },
  {
    name: '艮',
    symbol: '☶',
    bits: '001',
    trigramIndex: 7,
    polarity: '阳',
    wuxing: '土',
    family: '少男',
    nature: '山',
    season: '冬末',
    direction: '东北',
    attribute: '静止/止步',
    keywords: ['静止', '止步', '稳重', '阻滞'],
  },
  {
    name: '坤',
    symbol: '☷',
    bits: '000',
    trigramIndex: 8,
    polarity: '阴',
    wuxing: '土',
    family: '母',
    nature: '地',
    season: '夏末秋初',
    direction: '西南',
    attribute: '柔顺/承载',
    keywords: ['柔顺', '承载', '包容', '滋养'],
  },
];

// ============================================================
// 索引表（构建期一次性生成，O(1) 查询）
// ============================================================

const _BY_INDEX = {};   // trigramIndex → axiom
const _BY_NAME = {};    // name → axiom
const _BY_BITS = {};    // bits → axiom

for (const axiom of BAGUA_AXIOMS) {
  _BY_INDEX[axiom.trigramIndex] = axiom;
  _BY_NAME[axiom.name] = axiom;
  _BY_BITS[axiom.bits] = axiom;
}

// ============================================================
// 查询函数
// ============================================================

/**
 * 按八卦序号（先天序 1-8）获取卦公理
 * @param {number} trigramIndex - 1-8
 * @returns {object|null} 卦公理对象，未找到返回 null
 */
function getBaguaAxioms(trigramIndex) {
  if (typeof trigramIndex !== 'number') return null;
  return _BY_INDEX[trigramIndex] || null;
}

/**
 * 按卦名获取卦公理
 * @param {string} name - 卦名（乾/兑/离/巽/震/艮/坎/坤）
 * @returns {object|null}
 */
function getBaguaByName(name) {
  if (typeof name !== 'string') return null;
  return _BY_NAME[name] || null;
}

/**
 * 按 3 位二进制编码获取卦公理
 * @param {string} bits - '000' - '111'
 * @returns {object|null}
 */
function getBaguaByBits(bits) {
  if (typeof bits !== 'string') return null;
  return _BY_BITS[bits] || null;
}

// ═══════════════════════════════════════════════════════════════
// 装载期自检: bits ↔ trigramIndex 是**同一个编码的两种读法**
// ═══════════════════════════════════════════════════════════════

/**
 * 为什么这道自检是 2026-10-23 才加的(第 52 批)。
 *
 * ── 老板一句提问, 顶掉我之前一整段说法 ──
 *   我此前把盘古的编号讲成「三套序并存」(爻位序 / 二进制序 / 后天序),
 *   还说「三套在 1..7 上完全重叠, 传错基数不报错」。
 *   老板直接问:
 *     「乾=111=7 兑=110=6 离=101=5 震=100=4 巽=011=3 坎=010=2 艮=001=1 坤=000=0
 *       你这么考虑是不是就不存在你所谓的三套顺序的问题了?」
 *   实测 8/8 全中。**他说得对, 我的说法是错的。**
 *
 * ── 错在哪 ──
 *   根本不存在「三套序」。只有**一个**编码: bits = 爻画自下而上, 阴=0 阳=1。
 *   其余全是这一个编码的**读法**, 而且读法是唯一的:
 *     trigramIndex(先天数 1..8) = 8 − parseInt(bits, 2)
 *   8/8 成立, 无一例外。所以「先天序」不是一套独立的序,
 *   它是 bits 的一个**单调递减函数** —— 说它是"另一套序"是我自己造的抽象。
 *
 *   真正独立的只有一个: **后天序**(洛书方位, 坎一…离八)。
 *   它跟 bits **无关** —— 后天数在 bits 上非单调, 没有公式, 只能查表。
 *   这才是「换基数会静悄悄返回另一个卦」唯一真实存在的地方。
 *
 * ── 那为什么代码里一直没钉住 ──
 *   现有测试只分别验「bits 唯一」和「先天序顺序对」, **两者之间的关系没人管**。
 *   于是把 `trigramIndex` 改成 `parseInt(bits,2)`(即 trigramIndex ≡ bits 的数),
 *   测试**照样全绿** —— 因为「先天序」那一条断言的是**名字的顺序**,
 *   改成 7..0 之后按 trigramIndex 排序拿到的名字顺序变了, 但那条断言比的是
 *   `乾兑离震巽坎艮坤`, 恰恰会被抓住… 可只要有人**同时**改 bits 和 trigramIndex,
 *   两个断言就一起漂, 谁也发现不了。
 *
 *   ⇒ 关系必须**自己会喊**。数据一旦漂了, require 这一刻就炸, 不等到某天算错卦。
 *   (同一个做法在 hexagrams.js 的 assertBaseIntegrity 里已经有了。)
 *
 * ⚠️ 这道自检钉的是**关系**, 不是某个具体数字。
 *   8 − 这个常数来自「先天数 1..8」与「bits 0..7」两个取值域,
 *   由下面的循环自己算出来, 不写死。
 */
function assertBitsIndexCoherence() {
  const seenBits = new Set();
  const seenIdx = new Set();
  for (const a of BAGUA_AXIOMS) {
    if (typeof a.bits !== 'string' || !/^[01]{3}$/.test(a.bits)) {
      throw new Error('[bagua_axioms] bits 形态不对: ' + a.name + ' bits=' + JSON.stringify(a.bits));
    }
    if (seenBits.has(a.bits)) {
      throw new Error('[bagua_axioms] bits 重复: ' + a.bits + ' (' + a.name + ')');
    }
    seenBits.add(a.bits);

    if (!Number.isInteger(a.trigramIndex) || a.trigramIndex < 1 || a.trigramIndex > 8) {
      throw new Error('[bagua_axioms] trigramIndex 越界: ' + a.name
        + ' trigramIndex=' + a.trigramIndex + ' (必须 1..8)');
    }
    if (seenIdx.has(a.trigramIndex)) {
      throw new Error('[bagua_axioms] trigramIndex 重复: ' + a.trigramIndex + ' (' + a.name + ')');
    }
    seenIdx.add(a.trigramIndex);

    // ★ 这条就是「不存在三套序」这句话, 写成代码。
    //   先天数与 bits 必须严格反序对应; 对不上就是有人只改了一个字段。
    const want = 8 - parseInt(a.bits, 2);
    if (a.trigramIndex !== want) {
      throw new Error('[bagua_axioms] 先天数与 bits 脱钩: ' + a.name
        + ' bits=' + a.bits + '(=' + parseInt(a.bits, 2) + ') 推出 trigramIndex 应为 '
        + want + ' 但表里是 ' + a.trigramIndex
        + ' —— 先天数是 bits 的读法(8−值), 不是独立的一套序');
    }
  }
  if (BAGUA_AXIOMS.length !== 8) {
    throw new Error('[bagua_axioms] 卦数不是 8, 实为 ' + BAGUA_AXIOMS.length);
  }
}
assertBitsIndexCoherence();

module.exports = {
  BAGUA_AXIOMS,
  assertBitsIndexCoherence,
  getBaguaAxioms,
  getBaguaByName,
  getBaguaByBits,
};
