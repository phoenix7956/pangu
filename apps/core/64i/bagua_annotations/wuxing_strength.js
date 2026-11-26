/**
 * Pangu · 64i Layer
 * bagua_annotations/wuxing_strength.js
 *
 * 五行旺衰判断层 —— 把"生克关系成立与否"和"成立时有多强"分开表达。
 *
 * 为什么需要这一层 (2026-10-21 老板拍「那你干吧」):
 *   `wuxing_axioms.js` 的 5×5 矩阵把 25 格**全部填满**, 兜底是 'unknown'。
 *   代码里没有"这格关系在我这里构不成"这个状态 —— 现实里有的格是填不上的。
 *   于是"判不出来"只能被硬填成一个假的值, 判据层没有空位。
 *
 * 判据出处 (原始课件, 不是二手消化):
 *   /Users/you/Desktop/course-source
 *     「得令: 月令生我【"我"就是日元】或与我同五行 ... ✅」
 *     「不得令: 月令克我【"我"就是日元】、泄我或耗我。 ❌」
 *     「生我者为生 / 同我者为比 / 克我者为克 / 我生者为泄 / 我克者为耗
 *       *此处"我"为日主」
 *   /Users/you/Desktop/course-source
 *     「相生就是为对方付出, 对对方好; 相克就是对对方不好, 克制对方, 要害对方。」
 *
 * 关键推论 (这就是"不成立"态的根据):
 *   「克」的定义是"克制对方, **要害对方**" —— 要真能克住才叫克。
 *   所以克不成立时, 不是"弱克", 是**不成克**: 该关系在"我"这里根本构不成。
 *
 * ⚠️ 作用域纠正 (2026-10-21 实跑发现的, 记下来免得再犯):
 *   「得令/不得令」是**全局格局判断** (我 = 日主, 整体强弱),
 *   **不是**逐格各判一次。
 *   初版把"不得令"套到每一格上, 结果五格全是"无力"且理由全是同一句
 *   「月令木克我」—— 跟 bazi_calc.py 自己的「中和」结论直接打架。
 *   正确分层:
 *     - 格局层 (judgeDeLing)  : 判**我整体**得不得令 → 一次
 *     - 逐格层 (judgeRelation): 判**这一对五行**成不成立关系 → 五次
 *   所以 judgeRelation 的 strength 表达的是"该格关系是否成立/是否有力",
 *   其"力"的来源是**该格自身的旺衰**, 不是我的全局得令。
 *
 * 范围限定 (老板 2026-10-21 拍「爻动阴阳那就太过了」):
 *   本层只做**旺衰/强弱**。爻动、变爻、动爻阴阳**不参与**本层判定。
 *   阴阳在本层只用于区分十神的正偏（同阴阳/异阴阳）—— 该逻辑已存在于
 *   `64i/bazi/ten_gods.js`, 本层**不重复实现**, 只在需要时读取。
 *
 * 五行有阴阳 (老板 2026-10-21 指出):
 *   五行 × 阴阳 = 十天干 (甲乙木、丙丁火、戊己土、庚辛金、壬癸水),
 *   阳: 甲丙戊庚壬, 阴: 乙丁己辛癸。
 *   所以"克我者(木)"这一格里, 还分**阳木克我**还是**阴木克我** ——
 *   日主阴阳固定, 同阴阳=七杀, 异阴阳=正官 (课件: 十神以同异阴阳分正偏)。
 *   本层不重算十神, 只把十神层的结果**引到格上**。
 *   (爻动阴阳仍然不参与 —— 老板拍「爻动阴阳那就太过了」。)
 *
 * 旺衰阈值 (原始课件, <course-source> 阴阳五行与干支学习资料.txt):
 *   「五行过强: 该五行在四柱中有 3 个及以上个。」
 *   「五行过弱: 克制该五行的有 2 个及以上个, **或者四柱里没有这个五行**。」
 *
 *   后半句就是"不成立"态的**原始依据**: 四柱里根本没有这个五行,
 *   它对"我"构不成任何关系 —— 不是"弱", 是**不存在**。
 *
 * ⚠️ 分层纪律 (2026-10-21 实跑 + 读 bazi_calc.py 后定的, 别越界):
 *   盘古有**两处**算旺衰, 职责不能重叠:
 *     - 格局层 = `modules/tools/bazi/bazi_calc.py`
 *         算 status(旺/弱/中和) + 喜用神 + 忌神。它是**八字**的唯一真源。
 *     - 逐格层 = 本模块
 *         只回答「这一对五行成不成立关系」+「该五行在盘中分量如何」。
 *
 *   初版把全局"得令"套到每一格, 结果五格全是"无力"且理由全是同一句
 *   「月令木克我」—— 跟 bazi_calc.py 自己的「中和」结论直接打架。
 *   教训: **全局格局不逐格复制**。本层不产出 status, 不产出喜忌。
 *
 * 计数口径 (重要):
 *   课件说的"四柱中有几个"指**八字八个字**里该五行的个数 (整数),
 *   不是 bazi_calc.py 的 `wuxing_count` (那是加权分: 天干1 + 藏干0.5 + 月令1)。
 *   两者**不是一回事**, 阈值要套在整数计数上。
 *   本层因此需要调用方传入 `counts` (整数计数), 缺了就不判强弱。
 */

'use strict';

const path = require('path');

// 十神层 (阴阳的真源 + 正偏判定的真源) —— 本层不重复实现, 只引用
const _TG = require(path.join(__dirname, '..', 'bazi', 'ten_gods.js'));
// 五行阴阳合化层 (合则不克) —— 只读 getHe, 不重复实现天干五合
// (依赖方向单一: wuxing_yinyang → ten_gods, 不反向, 无循环)
const _WY = require(path.join(__dirname, 'wuxing_yinyang.js'));

// ============================================================
// 强度档位
// ============================================================

/**
 * 三档强度。为什么要三档而不是布尔:
 *   二值(成立/不成立) 装不下"关系成立但我不得令"这个真实状态 ——
 *   而"不得令"在课件里是有明确判定的（月令克我/泄我/耗我 → ❌）。
 */
// ============================================================
// 出处标识
// ============================================================

/**
 * 出处标识 —— **不能是文件名**。
 *
 * 2026-10-21 E2E 实跑 (老板拍「那你干吧」那轮):
 *   这个字段初版写的是 'wuxing_strength.js'。模型看到文件名就去找 ——
 *   实跑 43~48 次 exec_command, 满世界 find/grep 这个文件和 bazi 目录,
 *   整轮陷进去出不来 (第一次跑没有 final)。
 *   模型把"出处"理解成"要我去核实的东西"。
 *   出处是给**人**查证用的, 不是给模型执行的任务 ——
 *   所以这里写判据**名**（《易经》课程资料·五行旺衰与日元强弱喜忌）, 不写实现文件。
 */
const _SOURCE_LABEL = '五行六格判据(易经课程资料·五行旺衰与日元强弱喜忌)';

const STRENGTH = {
  /** 关系成立且有力 —— 我得令（当令之气生我或同我） */
  STRONG: 'strong',
  /** 关系成立但无力 —— 我不得令（被克/被泄/被耗） */
  WEAK: 'weak',
  /** 关系不成立 —— 该格在我这里构不成，不是"弱" */
  NOT_ESTABLISHED: 'not_established',
  /** 判据不足（缺月令等必要输入） */
  UNDETERMINED: 'undetermined',
};

// ============================================================
// 旺衰阈值 (课件原文)
// ============================================================

/** 五行过强阈值: 四柱中该五行 ≥ 3 个 */
const OVERSTRONG_THRESHOLD = 3;
/** 五行过弱阈值: 克制该五行的 ≥ 2 个 */
const OVERWEAK_THRESHOLD = 2;

// ============================================================
// 五行生克（与 wuxing_axioms 同源定义，此处只读不重定义方向）
// ============================================================

const _SHENG_OF = Object.freeze({
  '金': '水', '水': '木', '木': '火', '火': '土', '土': '金',
});
const _KE_OF = Object.freeze({
  '金': '木', '木': '土', '土': '水', '水': '火', '火': '金',
});
const _ELEMENTS = ['金', '木', '水', '火', '土'];

/**
 * 该五行下, 阳/阴各对应哪些天干。
 * 来源: ten_gods.js 的 YIN_YANG (不重抄 —— 铁律: 一份东西抄四遍 = 迟早只改其中一份)
 */
const _GAN_OF_ELEMENT = (function build() {
  const m = { '金': { '阳': [], '阴': [] }, '木': { '阳': [], '阴': [] }, '水': { '阳': [], '阴': [] },
               '火': { '阳': [], '阴': [] }, '土': { '阳': [], '阴': [] } };
  for (const gan of _TG.TIAN_GAN) {
    const el = _TG.WUXING[gan];
    const yy = _TG.YIN_YANG[gan];
    if (m[el] && yy) m[el][yy].push(gan);
  }
  return m;
})();

/**
 * 我(主方)与对方(其他五行)的关系, 用**我的视角**命名。
 * 命名依据课件: 生我者为生 / 同我者为比 / 克我者为克 / 我生者为泄 / 我克者为耗
 *
 * @param {string} self  我的五行
 * @param {string} other 对方五行
 * @returns {'sheng'|'bi'|'ke'|'xie'|'hao'|null} null = 非法输入
 */
function relationFromSelf(self, other) {
  if (typeof self !== 'string' || typeof other !== 'string') return null;
  if (!_ELEMENTS.includes(self) || !_ELEMENTS.includes(other)) return null;
  if (self === other) return 'bi';
  if (_SHENG_OF[other] === self) return 'sheng';   // 生我者 → 生
  if (_KE_OF[other] === self) return 'ke';         // 克我者 → 克
  if (_SHENG_OF[self] === other) return 'xie';     // 我生者 → 泄
  if (_KE_OF[self] === other) return 'hao';        // 我克者 → 耗
  return null;
}

// ============================================================
// 旺衰判断
// ============================================================

/**
 * 判断"我"得令与否。
 *
 * 课件原文 (<course-source>):
 *   得令:   月令生我 或 与我同五行          → ✅
 *   不得令: 月令克我、泄我或耗我              → ❌
 *   另:     月令既不生我也不克我(是"我生"或"我克") → 同样不得令
 *
 * @param {string} self 五行
 * @param {string} monthBranchFive 五行 — 月令(月支)的五行
 * @returns {{deLing: boolean, relation: string, reason: string}}
 */
function judgeDeLing(self, monthBranchFive) {
  if (typeof self !== 'string' || typeof monthBranchFive !== 'string') {
    return { deLing: false, relation: null, reason: '输入非法' };
  }
  if (!_ELEMENTS.includes(self) || !_ELEMENTS.includes(monthBranchFive)) {
    return { deLing: false, relation: null, reason: '五行名非法' };
  }

  const rel = relationFromSelf(self, monthBranchFive);

  if (rel === 'sheng' || rel === 'bi') {
    return {
      deLing: true,
      relation: rel,
      reason: '得令: 月令' + monthBranchFive + (rel === 'sheng' ? '生我' : '与我同五行'),
    };
  }
  if (rel === 'ke') {
    return { deLing: false, relation: rel, reason: '不得令: 月令' + monthBranchFive + '克我' };
  }
  if (rel === 'xie') {
    return { deLing: false, relation: rel, reason: '不得令: 月令' + monthBranchFive + '泄我' };
  }
  if (rel === 'hao') {
    return { deLing: false, relation: rel, reason: '不得令: 月令' + monthBranchFive + '耗我' };
  }
  return { deLing: false, relation: rel, reason: '不得令: 月令' + monthBranchFive + '与我不成生克' };
}

/**
 * 判断某个五行关系对"我"是否成立, 以及该五行在盘中的分量。
 *
 * 语义 (对齐课件五格):
 *   'sheng' 生我者 —— 喂我的
 *   'bi'    同我者 —— 帮我的
 *   'ke'    克我者 —— 压我的
 *   'xie'   我生者 —— 我泄出去的
 *   'hao'   我克者 —— 我拿去使的
 *
 * 分量判定 (课件阈值, 套在**整数计数**上):
 *   计数 = 0        → NOT_ESTABLISHED「四柱里没有这个五行」→ 该格构不成
 *   计数 ≥ 3        → STRONG        「五行过强: 四柱中有 3 个及以上个」
 *   计数 1-2        → WEAK          (有, 但不厚)
 *
 * 注意: 这里的分量是**该五行自己的旺衰**, 不是"我"的全局得令。
 *       "我"的格局由 bazi_calc.py 的 status 负责, 本层不重复。
 *
 * @param {string} self 我的五行
 * @param {string} other 对方五行
 * @param {object} [opts]
 * @param {object} [opts.counts] 五行→整数计数 (八字八字里的个数)
 * @param {string} [opts.selfGan] 日主天干 (用于判阴阳同异 → 正偏)
 * @returns {{relation: string, strength: string, reason: string, source: string}}
 */
function judgeRelation(self, other, opts) {
  const o = opts || {};
  const rel = relationFromSelf(self, other);
  if (!rel) {
    return {
      relation: null,
      strength: STRENGTH.UNDETERMINED,
      reason: '五行名非法',
      source: _SOURCE_LABEL,
    };
  }

  // ---- 阴阳细分 (五行有阴阳: 甲乙木、丙丁火…) ----
  // 日主阴阳固定, 对方天干跟我同阴阳还是异阴阳 → 决定正偏
  // (同阴阳=七杀/偏财, 异阴阳=正官/正财 —— 十神层已有判定, 这里只引用)
  //
  // ⚠️ 取样必须**同阴阳/异阴阳都取一个** (2026-10-21 实跑交叉验证发现的):
  //   初版只取 same[0] || diff[0], 于是"同阴阳优先" —— 异阴阳那一支永远取不到,
  //   表现为「月干丁 → 偏印」而 bazi_calc.py 给的是「正印」。
  //   两种阴阳要**都**列出来, 才是完整的十神分布。
  let polarity = null;
  if (o.selfGan && _TG.YIN_YANG[o.selfGan]) {
    const selfYY = _TG.YIN_YANG[o.selfGan];
    const gans = (_GAN_OF_ELEMENT[other] || {});
    const same = gans[selfYY] || [];
    const diff = gans[selfYY === '阳' ? '阴' : '阳'] || [];
    // 同异两支各取一个样本, 正偏由十神层判 (不重算)
    const sameSample = same[0] || null;
    const diffSample = diff[0] || null;
    const sample = sameSample || diffSample;
    polarity = {
      sameYinYangGans: same,
      diffYinYangGans: diff,
      sample,
      sameSample,
      diffSample,
      sameTenGod: sameSample ? _TG.getTenGod(o.selfGan, sameSample) : null,
      diffTenGod: diffSample ? _TG.getTenGod(o.selfGan, diffSample) : null,
      tenGod: sample ? _TG.getTenGod(o.selfGan, sample) : null,
      // ---- 合则不克 (2026-10-21 第十批接线) ----
      // 对方这一格里, 哪些天干**被我日主合住**。
      //
      // 为什么必须在这一层算, 而且只能在这一层算:
      //   「合」是**天干对天干**的判断(丁壬合木), 不是五行对五行的判断。
      //   而本层是按**五行**分格的 —— 一格里躺着两个天干(阴/阳各一)。
      //   所以格级判不出来, 只能说"这格里有一支被我合住了"。
      //   老板的原话「阳火用阴水可能就克不了, 反而会助火」落在这里:
      //     日主丁(阴火) + 水格(壬/癸) → 壬被合住 → **真正克我的只剩癸**。
      //   如果不标出来, 模型看到「克我者(水): 有力」就会以为壬癸一起来克。
      //
      // ⚠️ 纯增量: **不改变 strength / relation 的任何取值**。
      //   旺衰那一套的阈值和判据一个字没动, 这里只是把「合」这条
      //   独立信息挂出来。上层要用就用, 不用也不影响原有结论。
      heGans: (function () {
        const out = [];
        for (const g of [...same, ...diff]) {
          const he = _WY.getHe(o.selfGan, g);
          if (he) out.push({ gan: g, with: o.selfGan, pair: he.pair, hua: he.hua, name: he.name });
        }
        return out;
      })(),
      // ---- 阴阳克判据 (2026-10-22 第 47 批接线) ----
      // 对方这一格里, 逐支判「这条克边在阴阳上成不成立、多大力」。
      //
      // 为什么必须接这一层 (老板 10-22 原话落在这里):
      //   「如果再加上阴阳呢? 阳火用阴水可能就克不了, 反而会助火」
      // 第十批接了**合则不克**(第一档), 但没接**力度**那两档:
      //   · 同一阴阳(如庚克甲) → 克成立且力足        ← 之前分不出来
      //   · 异阴阳(如癸克丙)   → 克成立但力度减一分   ← 之前分不出来
      // 后果: 丙火日主遇癸水, 六格结论显示「克我者(水): 有力」——
      //   与「丙遇己(同阴阳力足)」**完全同等对待**。
      //   老板问「阳火用阴水是不是克不了」, 盘古只能答对一半:
      //   合的那对(丁壬)答对了, 弱的这对(丙癸)**答不出来**。
      //
      // ⚠️ 纯增量: **不改变 strength / relation 的任何取值**。
      //   旺衰阈值与判据一个字没动, 这里只是把「这条边成不成立/多大力」
      //   这条独立信息挂出来。上层要用就用, 不用也不影响原有结论。
      //   (与第十批 heGans 同一纪律)
      //
      // ⚠️ 只对**克边**算, 不对生边/同边算:
      //   生边与同边没有「力度减一分」这回事(judgeShengByYinYang 只判合不合)。
      //   硬算等于编公理。
      keYinYang: (function () {
        // 只有「对方克我」这一格才需要判克边(我克者那格是「我克对方」,
        // 方向相反 —— judgeKeByYinYang 的语义是「other 克 self」)
        const out = [];
        for (const g of [...same, ...diff]) {
          const j = _WY.judgeKeByYinYang(o.selfGan, g);
          if (!j) continue;   // 不是克关系(生/同) ⇒ 不在本判据范围内
          out.push({
            gan: g,
            with: o.selfGan,
            established: j.established,
            force: j.force,               // 'full' | 'weaken' | null
            sameYinYang: j.sameYinYang,
            he: j.he ? { pair: j.he.pair, hua: j.he.hua, name: j.he.name } : null,
            reason: j.reason,
          });
        }
        return out;
      })(),
    };
  }

  // 没有计数 → 判不了分量, 关系本身仍然成立
  const counts = o.counts;
  if (!counts || typeof counts !== 'object') {
    return {
      relation: rel,
      strength: STRENGTH.UNDETERMINED,
      reason: '关系成立，但缺五行计数, 判不了分量',
      source: _SOURCE_LABEL,
      polarity,
    };
  }

  const n = typeof counts[other] === 'number' ? counts[other] : 0;

  // 课件: 「或者四柱里没有这个五行」→ 该格**构不成**, 不是"弱"
  if (n <= 0) {
    return {
      relation: rel,
      strength: STRENGTH.NOT_ESTABLISHED,
      reason: '四柱里没有这个五行, 故该格关系不成立',
      source: _SOURCE_LABEL,
      polarity,
    };
  }

  // 课件: 「五行过强: 该五行在四柱中有 3 个及以上个」
  if (n >= OVERSTRONG_THRESHOLD) {
    return {
      relation: rel,
      strength: STRENGTH.STRONG,
      reason: '该五行四柱中 ' + n + ' 个, 过强',
      source: _SOURCE_LABEL,
      polarity,
    };
  }

  // 有, 但不厚 (1-2 个)
  return {
    relation: rel,
    strength: STRENGTH.WEAK,
    reason: '该五行四柱中 ' + n + ' 个, 分量不足',
    source: _SOURCE_LABEL,
    polarity,
  };
}

/**
 * 五格全景 —— 一眼看清"谁在喂我、谁在压我、我在往哪泄、我在使什么"。
 *
 * 这是老板要的「六格三态」的格级部分（彼那一格由调用方填）。
 *
 * @param {string} self 我的五行
 * @param {object} counts 五行→整数计数
 * @param {string} [selfGan] 日主天干 (用于阴阳同异细分)
 * @returns {object} 五个格 + 强度 + 出处
 */
function judgeSixCells(self, counts, selfGan) {
  const cells = {};
  for (const other of _ELEMENTS) {
    const r = judgeRelation(self, other, { counts, selfGan });
    cells[other] = r;
  }
  return {
    self,
    counts,
    cells,
    // 便于上层直接用: 哪些格"有力"、哪些格"不成立/判不了"
    strong: _ELEMENTS.filter((e) => cells[e].strength === STRENGTH.STRONG),
    weak: _ELEMENTS.filter((e) => cells[e].strength === STRENGTH.WEAK),
    notEstablished: _ELEMENTS.filter((e) => cells[e].strength === STRENGTH.NOT_ESTABLISHED),
    undetermined: _ELEMENTS.filter((e) => cells[e].strength === STRENGTH.UNDETERMINED),
    source: _SOURCE_LABEL,
  };
}

module.exports = {
  STRENGTH,
  relationFromSelf,
  judgeDeLing,
  judgeRelation,
  judgeSixCells,
};

