/**
 * Pangu · 64i Layer
 * bagua_annotations/wuxing_yinyang.js
 *
 * 五行阴阳合化层 —— 「合则不克」这条盘古原本算不出来 (2026-10-21 第十批)
 *
 * 为什么需要这一层:
 *   `wuxing_axioms.js` 的 5×5 矩阵只按**五行**分格, 25 格全部填满。
 *   于是它必然说「水克火」—— 而且**永远**这么说, 不管这个水是壬还是癸,
 *   这个火是丙还是丁。老板的原话:
 *     「水克火, 是不是也是火耗费了水的精力?」
 *     「如果再加上阴阳呢? 阳火用阴水可能就克不了, 反而会助火」
 *   前半句: 对, 水克火就是一条边, 两端各叫一次(见下方「一条边两个名字」)。
 *   后半句: **有条件对, 而且条件不是"异性"本身, 是"五合"** —— 见下面。
 *
 * ⚠️ 我自己读《三命通会》时差点读错, 记下来免得再犯 (2026-10-21):
 *   1753 行「阳见阳, 二阳相竞则为克; 阴见阴, 二阴不足则为克,
 *            唯阴见阳, 阳见阴为合」—— 孤立看像"异性一律不克"。
 *   但 3825 行同一本书写「辛克甲, 庚克乙…是阴克阳, 阳克阴…
 *            乃阴阳配合之理。故甲见辛为正官」—— 异性相克**照样成立**,
 *            只是在克关系里分正偏。
 *   两段合起来才是对的读法:
 *     - 「异性为合」讲的是**天干五合为什么成立**(五合五对全是异性),
 *       它是"合"的**前提条件**, 不是"克"的**否定条件**;
 *     - 异性相克 → 克仍然成立, 只是在克关系里分正偏(3825「故甲见辛为正官,
 *       见庚为偏官」), 原文一个字都没提"力度"。
 *   所以 `keJudge()` 里: **合才是不克**, 异性只是"分正偏官"。
 *
 * ⚠️ 2026-10-23 第 49 批: 本层的 `reason` 原来说「克成立且力足」/「力度减一分」,
 *   已改成只说**成立 + 阴阳关系**。理由有三层, 每一层都能验:
 *   ① 《三命通会》3825 只给「正官/偏官」这个**名分**, 全文明写「官喜正, 不喜偏」——
 *      那是偏正之辨, 力度刻度这五个字在全文**零命中**。
 *   ② 生产文本同一行里, 格级分量用「无力/有力」, 关系层若也说「力足/力度减一分」,
 *      同一个「力」字在一行里说反话, 模型会把两句读打架(第 45/46/47 批治的是同一类病)。
 *   ③ 台账里那条 sourced 字段自己就叫「只分正官/偏官, **不分强弱**」——
 *      生产文本说"力度", 是在跟自己的出处层对着干。
 *   正偏官名**不由本层给**: 本层没有十神表, 硬写一遍就是第二份会漂的抄本。
 *   `polarity.sameTenGod / diffTenGod` 由十神表给, 上层照它渲染(见 wuxing_strength.js)。
 *   `force: 'full'|'weaken'` 作为**内部编码**保留(结构字段, 守卫在用),
 *   但它的实际内容是「同阴阳/异阴阳」这一路, 不是力度刻度。
 *
 * 判据出处 (原始典籍, 非二手消化):
 *   /Users/you/Desktop/course-source:1753 「夫合者, 乃和谐之义,
 *     如阳见阳, 二阳相竞则为克, 阴见阴, 二阴不足则为克, 唯阴见阳,
 *     阳见阴为合, 亦如男女相合而成夫妇之道。」
 *   同书 1756-1766 逐对给出五合: 乙与庚合 / 丁与壬合 / 甲与己合 /
 *     丙与辛合 / 戊与癸合。
 *
 * 一条边两个名字 (老板第一个问题的答案, 也是 `wuxing_axioms.js` 的既有约定):
 *   水克火**不是两种关系, 是一条边的两端**:
 *     - 站在水的角度 → 火是水「耗」的一部分(我克者为耗)
 *     - 站在火的角度 → 水是火「克」(克我者为克)
 *   该约定由 251 项 + 994 项测试锁定(见 `test_wuxing_axioms.js`),
 *   本层**不改名、不重定义**, 只在"这条边成不成立"上加阴阳判据。
 *
 * 分层纪律 (与 `wuxing_strength.js` 同一条铁律, 别越界):
 *   - 格局层(旺/弱/中和 + 喜用神 + 忌神) = `bazi_calc.py`, **八字唯一真源**
 *   - 逐格层(旺衰分量) = `wuxing_strength.js`
 *   - 本层只回答一件事: **这一对天干之间的生克边, 阴阳上成不成立**
 *   本层**不产出** status / 喜忌 / 旺衰。
 *
 * 范围限定 (老板 2026-10-21 拍「爻动阴阳那就太过了」):
 *   爻动、变爻、动爻阴阳**不参与**本层。本层只管**天干**的阴阳。
 */

'use strict';

const path = require('path');

// 十神层 = 天干/五行/阴阳的真源 —— 本层**不重抄**(铁律: 一份东西抄四遍 = 迟早只改其中一份)
const _TG = require(path.join(__dirname, '..', 'bazi', 'ten_gods.js'));

const TIAN_GAN = _TG.TIAN_GAN;
const GAN_WUXING = _TG.WUXING;
const GAN_YIN_YANG = _TG.YIN_YANG;

// ============================================================
// 天干五合
// ============================================================

/**
 * 五合五对, 全部是**异性**(这是五合能成立的前提, 见文件头 1753 行)。
 *   甲己合土 / 乙庚合金 / 丙辛合水 / 丁壬合木 / 戊癸合火
 * 内部键统一**阳干在前**(甲己/庚乙/丙辛/壬丁/戊癸), 查询时按阴阳归一化,
 * 所以 `getHe('壬','丁')` 和 `getHe('丁','壬')` 结果一致。
 * 对外 `pair` 保留《三命通会》原文的写法(甲己/乙庚/丙辛/丁壬/戊癸)。
 * ⚠️ 化出的五行**不等于**该对的本气 —— 甲(阳木)+己(阴土)化土,
 *    木既不生土也不被土克, 靠的就是"合"这条**独立的边**, 不是生克。
 */
const GAN_HE = Object.freeze({
  '甲己': Object.freeze({ pair: '甲己', hua: '土', name: '中正之合' }),
  '庚乙': Object.freeze({ pair: '乙庚', hua: '金', name: '仁义之合' }),
  '丙辛': Object.freeze({ hua: '水', name: '威制之合' }),
  '壬丁': Object.freeze({ pair: '丁壬', hua: '木', name: '淫慝之合' }),
  '戊癸': Object.freeze({ hua: '火', name: '无情之合' }),
});

/** 阳干在前 → 五合键。 */
function _heKey(a, b) {
  if (!(a in GAN_YIN_YANG) || !(b in GAN_YIN_YANG)) return null;
  const first = GAN_YIN_YANG[a] === '阳' ? a : b;
  const second = first === a ? b : a;
  return first + second;
}

// ============================================================
// 查询函数
// ============================================================

/**
 * 两干是否相合。
 * @param {string} a 天干
 * @param {string} b 天干
 * @returns {{pair:string, hua:string, name:string}|null}
 *
 * ⚠️ **故意不给"合化结果的阴阳"** (2026-10-21):
 *   《三命通会》只给了"甲己合土"这个五行, **没有**判化出来的是阳土还是阴土,
 *   各家(格局派/旺衰派)取法也不一致。这里编一个就是凭空造公理 ——
 *   本层的规矩是判据必须能指回原文, 指不回去的**留空**, 不猜。
 */
function getHe(a, b) {
  const key = _heKey(a, b);
  if (!key || !(key in GAN_HE)) return null;
  const rec = GAN_HE[key];
  return {
    pair: rec.pair || key,
    hua: rec.hua,
    name: rec.name,
  };
}

/**
 * 两个天干是不是异性。null = 非法输入。
 * @param {string} a @param {string} b
 * @returns {boolean|null}
 */
function isOppositeYinYang(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  if (!(a in GAN_YIN_YANG) || !(b in GAN_YIN_YANG)) return null;
  return GAN_YIN_YANG[a] !== GAN_YIN_YANG[b];
}

/**
 * 天干相克的阴阳判据 —— 本层的核心。
 *
 * 问的是: 「other 克 self 这条边, 在阴阳上**成不成立**」。
 * 不是问生克方向(方向由 wuxing_axioms 的 5×5 矩阵管), 只问成立与否和力度。
 *
 * 规则 (三段, 顺序不能换):
 *   1. 方向不对(对方不克我) → null(不是克的关系, 本层不管)
 *   2. **相合 → 不成立**。合则不克, 这就是老板说的"克不了"。
 *      例: 丁(阴火) 遇 壬(阳水) → 丁壬合木 → 水克火这条边不成立。
 *   3. 不合 → 成立, 记下同异阴阳:
 *      同阴阳 → 'full'   (二阳相竞 / 二阴不足, 《三命通会》1753 说的那种克)
 *      异阴阳 → 'weaken' (克仍然成立, 只是分正偏官 —— **不是**不成立)
 *
 * ⚠️ 第 3 条的 'weaken' 是本层最容易读错的地方, 也是我自己第一遍读错的:
 *   丙(阳火) 遇 癸(阴水): 异性, 但**不是五合**(丙辛合才是丙的合),
 *   所以水克火**依然成立**, 只是归正官那一路。**不是"助火", 也不是"力弱"。**
 *   老板的直觉在**丁壬**那一对上完全成立, 在丙癸这一对上不成立。
 *
 * @param {string} self  我(被克的一方)
 * @param {string} other 对方(施克的一方)
 * @returns {{established:boolean, force:'full'|'weaken', reason:string,
 *            he:object|null, sameYinYang:boolean}|null}
 *          null = 不是相克关系, 或输入非法
 */
function judgeKeByYinYang(self, other) {
  if (typeof self !== 'string' || typeof other !== 'string') return null;
  if (!(self in GAN_YIN_YANG) || !(other in GAN_YIN_YANG)) return null;
  if (self === other) return null;

  // 方向: 对方必须真的克我(_TG.KE[对方] === 我的五行), 否则不是克的关系
  if (_TG.KE[GAN_WUXING[other]] !== GAN_WUXING[self]) return null;

  const sameYinYang = GAN_YIN_YANG[self] === GAN_YIN_YANG[other];
  const he = getHe(self, other);

  // 规则 2: 合则不克
  if (he) {
    return {
      established: false,
      force: null,
      reason: other + '与' + self + '相' + he.name + '(合' + he.hua + '), 合则不克',
      he,
      sameYinYang,
    };
  }
  // 规则 3: 成立, 记下同异阴阳。
  //   reason 只说「成立 + 阴阳关系」—— 正偏官名由十神表给(polarity.sameTenGod/diffTenGod),
  //   力度刻度不在这儿编(第 49 批, 理由见文件头那段)。
  return {
    established: true,
    force: sameYinYang ? 'full' : 'weaken',
    reason: sameYinYang
      ? other + '与' + self + '同' + GAN_YIN_YANG[self] + ', 克成立'
      : other + '与' + self + '异阴阳, 克仍然成立',
    he: null,
    sameYinYang,
  };
}

/**
 * 同边查询: 生边上有没有"合"把它废掉。
 * 生边上五合不成立(五合全是克边), 所以只对**同五行**与**生边**给口径,
 * 避免调用方误以为生也能被合掉。
 * @returns {{affinity:'sheng'|'tong', he:object|null, sameYinYang:boolean}|null}
 */
function judgeShengByYinYang(self, other) {
  if (typeof self !== 'string' || typeof other !== 'string') return null;
  if (!(self in GAN_YIN_YANG) || !(other in GAN_YIN_YANG)) return null;
  if (self === other) return null;

  const wxSelf = GAN_WUXING[self];
  const wxOther = GAN_WUXING[other];
  const affinity = _TG.SHENG[wxSelf] === wxOther ? 'sheng'
    : (wxSelf === wxOther ? 'tong' : null);
  if (!affinity) return null;

  return {
    affinity,
    he: getHe(self, other),
    sameYinYang: GAN_YIN_YANG[self] === GAN_YIN_YANG[other],
  };
}

// ============================================================
// 装时自检 —— 这层的判据栽过一次, 不许静默退化 (2026-10-21)
// ============================================================

function _assertYinyangLayer() {
  // ① 五合五对必须**全是异性** —— 这是本层存在的根据, 哪天有人改成同性
  //    "合则不克"就整个塌了, 而它不会抛异常, 只会安静地给出相反的答案。
  for (const key of Object.keys(GAN_HE)) {
    const a = key[0];
    const b = key[1];
    if (!(a in GAN_YIN_YANG) || !(b in GAN_YIN_YANG)) {
      throw new Error('[wuxing_yinyang] 五合 "' + key + '" 含非天干');
    }
    if (GAN_YIN_YANG[a] === GAN_YIN_YANG[b]) {
      throw new Error('[wuxing_yinyang] 五合 "' + key + '" 必须一阳一阴, 实际同' + GAN_YIN_YANG[a]);
    }
  }
  // ② 天干必须刚好 10 个, 且阴阳两支各 5 —— 少一个整层就残废
  if (TIAN_GAN.length !== 10) {
    throw new Error('[wuxing_yinyang] 天干数应为 10, 实为 ' + TIAN_GAN.length);
  }
  const yangCount = TIAN_GAN.filter(g => GAN_YIN_YANG[g] === '阳').length;
  const yinCount = TIAN_GAN.filter(g => GAN_YIN_YANG[g] === '阴').length;
  if (yangCount !== 5 || yinCount !== 5) {
    throw new Error('[wuxing_yinyang] 天干阴阳应各 5, 实为 阳' + yangCount + ' 阴' + yinCount);
  }
  // ③ 每个五行都必须有阳有阴 —— 直接堵住"火=阳所以只有阳火"那个坑
  //    (`wuxing_axioms.js` 的 `yin_yang` 字段是**本气单值**, 不是全貌)
  for (const el of ['金', '木', '水', '火', '土']) {
    const ys = TIAN_GAN.filter(g => GAN_WUXING[g] === el).map(g => GAN_YIN_YANG[g]);
    if (!ys.includes('阳') || !ys.includes('阴')) {
      throw new Error('[wuxing_yinyang] 五行' + el + '必须阴阳各一, 实为 ' + ys.join('/'));
    }
  }
}

_assertYinyangLayer();

// 单独导出, 便于喂负例(与 assertKeywordsAligned 同一做法)
module.exports = {
  GAN_HE,
  getHe,
  isOppositeYinYang,
  judgeKeByYinYang,
  judgeShengByYinYang,
  _assertYinyangLayer: _assertYinyangLayer,
};
