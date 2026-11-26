/**
 * modules/bazi_strength.js — 八字排盘结果 × 五行旺衰判断层 的连接
 *
 * 2026-10-21 立。目的: 把 `bazi_calc.py` 算出的盘, 接到
 * `64i/bagua_annotations/wuxing_strength.js` 的六格三态上, 让
 * 「我被什么克、我泄给谁、我使什么」变成**带出处的结构化判断**,
 * 而不是 LLM 临场编一段话。
 *
 * 判据出处: 桌面 <course-source>/<course-file>
 *   「生我者为生 / 同我者为比 / 克我者为克 / 我生者为泄 / 我克者为耗
 *     *此处"我"为日主」
 *   「得令: 月令生我 或 与我同五行 ✅ / 不得令: 月令克我、泄我或耗我 ❌」
 *
 * 设计约束 (铁律一: 注释 ≠ 隔离 / 一份东西抄四遍 = 迟早只改其中一份):
 *   - 地支五行表**不重抄**, 从 `64i/bazi/zhis_relations.js` 读
 *   - 十天干阴阳表**不重抄**, 从 `64i/bazi/ten_gods.js` 读
 *   - 生克循环**不重抄**, 从 `64i/bagua_annotations/wuxing_strength.js` 读
 *   本模块只做**编排**: 排盘 JSON → 六格三态
 *
 * 范围限定 (老板 2026-10-21 拍「爻动阴阳那就太过了」):
 *   爻动/变爻**不参与**本层。本层只处理八字静态四柱。
 */

'use strict';

const path = require('path');

const _ZHIS = require(path.join(__dirname, '..', '64i', 'bazi', 'zhis_relations.js'));
const _TG = require(path.join(__dirname, '..', '64i', 'bazi', 'ten_gods.js'));
const _WS = require(path.join(__dirname, '..', '64i', 'bagua_annotations', 'wuxing_strength.js'));
const _CF = require(path.join(__dirname, 'bazi_chart_facts.js'));

// 地支五行 (从 zhis_relations.js 读, 不重抄)
const ZHI_WUXING = _ZHIS.WUXING || {};

// 十天干阴阳 (从 ten_gods.js 读, 不重抄)
const GAN_YINYANG = _TG.YIN_YANG || {};
const GAN_WUXING = _TG.WUXING || {};

// 地支本气 (从 bazi_chart_facts.js 读, 不重抄)
const ZHI_BEN_QI = _CF.ZHI_BEN_QI || {};

/**
 * 从一格的 polarity 里挑出「克边力度」的两档。
 *
 * 为什么要做成共用函数: `formatJudgement` 与 `formatConclusion` 都要用,
 * 两处各抄一遍「挑 weaken / 挑 full」的判据 ⇒ 改一处忘一处,
 * 两边就会给出不同的力度结论(而且没人发现)。
 * 措辞各写各的(两个函数的行文风格不同), **判据不许各写各的**。
 *
 * @param {object|null} polarity  judgeRelation 给的 polarity
 * @returns {{weaken:string[], full:string[]}} 天干名数组(空数组 = 没有这一档)
 */
function keYinYangParts(polarity) {
  const list = (polarity && Array.isArray(polarity.keYinYang)) ? polarity.keYinYang : [];
  const pick = (force) => list
    .filter((x) => x && x.established && x.force === force)
    .map((x) => x.gan);
  return { weaken: pick('weaken'), full: pick('full') };
}

/**
 * 关系层那一注的**措辞**, 两个渲染点共用一个。
 *
 * 2026-10-23 第 49 批把措辞从「力度减一分/力足」换成「分正偏官」, 三条理由:
 *   ① 《三命通会》3825 给的是**名分**(正官/偏官) + 一句「官喜正, 不喜偏」,
 *      「力度」「力足」「力度减一分」这五个字在全文**零命中**。
 *   ② 格级分量那半句已经用「无力/有力」了, 同一行里再来一个「力足/力度减一分」,
 *      同一个「力」字说反话 —— 模型会把两句读打架(第 45/46/47.1 批治的都是这一类)。
 *   ③ 台账里那条 sourced 字段自己写的就是「只分正官/偏官, **不分强弱**」。
 *
 * 正偏官名**从 polarity 里读**(sameTenGod/diffTenGod, 来自十神表),
 * 本模块一个字都不另抄 ⇒ 两份抄本漂不开。
 *
 * @param {object|null} polarity  judgeRelation 给的 polarity
 * @returns {string|null} 拼好的那一注(没有可说的内容 ⇒ null)
 */
function keYinYangNoteText(polarity) {
  if (!polarity) return null;
  const { weaken, full } = keYinYangParts(polarity);
  const parts = [];
  if (weaken.length) {
    parts.push(weaken.join('、') + ' 异阴阳, 克成立, 为'
      + (polarity.diffTenGod || '正官'));
  }
  if (full.length) {
    parts.push(full.join('、') + ' 同阴阳, 克成立, 为'
      + (polarity.sameTenGod || '七杀'));
  }
  return parts.length ? parts.join('; ') : null;
}

/**
 * 这一格在**本盘里**到底有没有这个东西。
 *
 * 为什么要有这道门 (2026-10-23 实跑取证):
 *   实盘(庚午 癸未 戊子 己未, 日主戊土)跑出来的第 47 批生产文本是:
 *     「克我者(木): 不成立 → 七杀/正官(乙 异阴阳, 克成立但力度减一分;
 *       甲 同阴阳, 克成立且力足)」
 *   这一格自己写着「**不成立**」(四柱里一个木都没有), 括号里却说「**克成立**」——
 *   **自相矛盾**。模型读到会得出「克我者(木)克成立」, 直接跟格级结论打架。
 *
 * 根因: `polarity` 说的是**关系规则**(如果这一格有东西, 它怎么克我),
 *   而格级强度说的是**本盘分量**(这一格有没有东西)。两件事, 不该混在一行里。
 *   本盘没有木 ⇒ 甲乙只是"假如有的木", 说"力度减一分"是**假设**, 不是事实。
 *
 * ⇒ 关系层的注(合则不克 / 力度分档)只在**该五行确实在盘里**时印。
 *   不在盘里时, 格级「不成立」已经说清楚了, 再加假设只会添乱。
 *
 * @param {object} judged judgeFromChart 的结果
 * @param {string} other  五行名
 * @returns {boolean}
 */
function cellPresent(judged, other) {
  const c = judged.counts && judged.counts[other];
  return typeof c === 'number' && c > 0;
}

// ============================================================
// 整数计数 (八字八个字里各五行的个数)
// ============================================================

/**
 * 数八字八个字里每个五行出现几次。
 *
 * 口径 (与 bazi_calc.py 的 `wuxing_count` **不是一回事**):
 *   课件说的"四柱中有 3 个及以上个"指的是**字**的个数 —— 天干算一个,
 *   地支按**本气**算一个 (子平通规: 支十神按本气论)。
 *   bazi_calc.py 的 wuxing_count 是加权分 (天干1 + 每个藏干0.5 + 月令1),
 *   两者数值不可互换。课件阈值要套在本函数的整数计数上。
 *
 * @param {object} pillars {年柱, 月柱, 日柱, 时柱} 或 {年,月,日,时}
 * @returns {object} 五行→整数计数, 合计应为 8
 */
function countElements(pillars) {
  const counts = { '金': 0, '木': 0, '水': 0, '火': 0, '土': 0 };
  if (!pillars || typeof pillars !== 'object') return counts;

  // ⚠️ 两种形状都得认 (2026-10-21 实测踩到):
  //   bazi_calc.py 返回的是**对象** {"年柱":"辛未", …}, 这是正常路径。
  //   但我自己写夹具时传了**数组** ['庚午','丙子',…] —— 而旧实现只读对象键,
  //   于是四柱全部读不到, counts 全 0, **不报错、不告警**,
  //   后果是每一格都判成「四柱里没有这个五行, 故该格关系不成立」——
  //   整份六格判断变成五格全"不成立", 而输出看起来完全正常。
  //   这正是"索引错了不抛异常, 只是安静地返回另一个东西"的同一族坑。
  //
  //   所以: 数组**也认**(年→月→日→时), 认不出来就**响亮报错**, 绝不静默返回全 0。
  let seq = null;
  if (Array.isArray(pillars)) {
    if (pillars.length !== 4) {
      throw new Error(
        '[bazi_strength] countElements: 柱数组长度应为 4(年月日时), 实为 ' + pillars.length +
        '。旧实现会静默返回全 0 并让六格全判「不成立」, 所以这里必须报错。');
    }
    seq = pillars.slice();
  } else if (typeof pillars['年柱'] === 'string') {
    seq = [pillars['年柱'], pillars['月柱'], pillars['日柱'], pillars['时柱']];
  } else if (typeof pillars['年'] === 'string') {
    seq = [pillars['年'], pillars['月'], pillars['日'], pillars['时']];
  } else {
    throw new Error(
      '[bazi_strength] countElements: 认不出 pillars 的形状, 键为 [' + Object.keys(pillars).join(',') +
      ']。期望 {"年柱","月柱","日柱","时柱"} 或 4 元素数组。');
  }

  for (const p of seq) {
    if (typeof p !== 'string' || p.length < 2) continue;
    const gan = p[0];
    const zhi = p[1];
    if (GAN_WUXING[gan]) counts[GAN_WUXING[gan]] += 1;
    const benQi = ZHI_BEN_QI[zhi];
    if (benQi && GAN_WUXING[benQi]) counts[GAN_WUXING[benQi]] += 1;
  }
  return counts;
}

// ============================================================
// 主入口
// ============================================================

/**
 * 从 bazi_calc.py 的排盘 JSON 算出六格三态
 *
 * @param {object} chart bazi_calc.py 的输出 (JSON.parse 后的对象)
 * @returns {object|null}
 */
function judgeFromChart(chart) {
  if (!chart || typeof chart !== 'object') return null;

  const self = chart.day_master_wuxing;
  if (!self || !self.length) return null;

  // 月令: 优先用 month_branch 的五行, 退回 month_benqi (月令本气天干)
  const monthBranch = chart.month_branch;
  const monthFive = ZHI_WUXING[monthBranch] || null;

  // 整数计数 (八字八个字) —— 课件阈值用这个口径
  const counts = countElements(chart.pillars);
  const totalCounted = Object.values(counts).reduce((a, b) => a + b, 0);

  // 日主天干 + 阴阳 (日主本身也占一格: 同我者)
  const dmGan = chart.day_master;
  const dmYinYang = GAN_YINYANG[dmGan] || chart.day_master_yinyang || null;

  const six = _WS.judgeSixCells(self, counts, dmGan);

  return {
    self: {
      wuxing: self,
      gan: dmGan || null,
      yinYang: dmYinYang,
      // 日主的旺衰结论 (bazi_calc 已算, 这里带上做交叉验证)
      status: chart.status || null,
      statusReason: chart.status_reason || null,
      // 2026-10-28 第 130 批: 格局层给的**等级**与**三要素依据**。
      //   以前只透传 status(旺/弱/中和) —— 模型只能说出「旺」, 说不清凭什么旺;
      //   老板要的是「乙木身强」这种带依据的话, 依据就在这三要素里。
      //   ⚠️ 仍然是**转述**(格局层才是真源), 本层不另算一遍旺衰。
      grade: chart.status_grade || null,
      detail: chart.status_detail || null,
    },
    month: {
      branch: monthBranch || null,
      wuxing: monthFive,
      benqi: chart.month_benqi || null,
      // deLing 是**格局层的单项判据**("月令生我/同我"→得令),
      // 不是整盘的强弱结论。整盘强弱看 status (由 bazi_calc.py 算)。
      // 两者可以并存不矛盾: 得令 + 中和 = 月令扶我, 但五行整体不偏。
      deLing: monthFive ? _WS.judgeDeLing(self, monthFive) : null,
    },
    // 六格: 生我者/同我者/克我者/我生者/我克者 各自的强度 + 理由 + 出处
    cells: six.cells,
    strong: six.strong,
    weak: six.weak,
    notEstablished: six.notEstablished,
    undetermined: six.undetermined,
    // 整数计数 (八字节) + 合计 (应为 8, 用于自检)
    counts,
    countsTotal: totalCounted,
    // 八字八个字 → 计数合计必须是 8。**这个自检以前是假的**:
    // 文档写着「合计应为 8, 用于自检」, 但 totalCounted 只是算出来透传,
    // **从来没有被任何地方检查过** —— 跟第十批批的
    // `WUXING_AXIOMS.yin_yang` 是同一个毛病: 算出来、透出去、没人看。
    // 后果: 柱子读不到时会静默变成"每格都不成立", 而输出看起来完全正常。
    // 现在它是**真的**: 不为 8 就把警告印进给模型看的结论里。
    countsOk: totalCounted === 8,
    // 排盘自带的喜忌 (bazi_calc 算的, 与本层独立, 用于交叉验证)
    xiYong: chart.xi_yong || null,
    jiShell: chart.ji_shell || null,
    xiYongReason: chart.xi_yong_reason || null,
    // bazi_calc 的加权分 (与上面的整数计数不是一回事, 并列保留供对照)
    wuxingCountWeighted: chart.wuxing_count || null,
    //
    // 出处写法有讲究 (2026-10-21 E2E 实跑踩到的):
    //   初版这里写的是**文件路径**「桌面<course-source>/<course-file>」,
    //   模型看到路径就去找文件 —— 实跑 43 次 exec_command 满世界 find bazi 目录,
    //   陷进去出不来, 整轮没有 final。
    //   出处是给**人**查证用的, 不是给模型执行的任务。
    //   所以: 保留出处标识, 但不给出可执行路径。
    source: '五行六格判据(易经课程资料·五行旺衰与日元强弱喜忌)',
  };
}

/**
 * 把六格判断压成一段给 LLM 看的结构化文本。
 * 刻意用**固定格式**, 便于 answer_alignment 查证, 也便于反幻觉守卫核对。
 *
 * @param {object} judged judgeFromChart 的输出
 * @returns {string}
 */
function formatJudgement(judged) {
  if (!judged) return '';
  const L = [];
  L.push('【五行六格判断】我(日主) = ' + judged.self.wuxing +
    (judged.self.gan ? '·' + judged.self.gan : '') +
    (judged.self.yinYang ? '(' + judged.self.yinYang + ')' : ''));
  if (judged.month.branch) {
    L.push('  月令: ' + judged.month.branch +
      (judged.month.wuxing ? '(' + judged.month.wuxing + ')' : '') +
      ' → ' + (judged.month.deLing ? (judged.month.deLing.deLing ? '得令' : '不得令') : '判不了') +
      (judged.month.deLing ? ' — ' + judged.month.deLing.reason : ''));
  }
  const NAMES = { sheng: '生我者', bi: '同我者', ke: '克我者', xie: '我生者', hao: '我克者' };
  const SNAMES = { strong: '有力', weak: '无力', undetermined: '判不了', not_established: '不成立' };

  // 合则不克的措辞 (2026-10-21 第十批接线)
  //
  // 目的是**堵住模型的一个具体错读**: 看到「克我者(水): 有力」就当成
  // 壬癸两支一起来克我。不标出来的话, 格级结论本身是对的, 但解读会走偏。
  //
  // 措辞按角色分开 —— 只有这两格的合会改变这一格的读法:
  //   克我者: 被合住 = 那一支**不参与克我**
  //   我克者: 合住 = 我少了一样使的手段 (老板说的"耗费我精力的")
  //   生我/同我/泄: 不提(合不影响这三格成不成立)
  const HE_ROLE = { ke: '被合住, 不参与克我', hao: '与日主相合, 不受我克' };
  const heLine = (cell) => {
    const p = cell.polarity;
    if (!p || !Array.isArray(p.heGans) || !p.heGans.length) return null;
    const role = HE_ROLE[cell.relation];
    if (!role) return null;
    return p.heGans.map(h => h.pair + '合' + h.hua + ' — ' + role).join('; ');
  };

  // ---- 阴阳克边的正偏官 (2026-10-22 第 47 批接线, 10-23 第 49 批改措辞) ----
  // 老板 10-22 原话: 「如果再加上阴阳呢? 阳火用阴水可能就克不了, 反而会助火」
  //
  // 第十批接了「合则不克」(heGans), 但没接**同异阴阳分正偏官**那两路。
  // 后果: 丙火日主遇癸水, 结论显示「克我者(水): 有力」——
  //   与「丙遇庚(同阴阳那一路)」**完全同等对待**。
  //   老板问「阳火用阴水是不是克不了」, 盘古只能答对一半:
  //   合的那对(丁壬)答对了, 不同阴阳的这对(丙癸)**答不出来**。
  //
  // 核心里 `judgeKeByYinYang` 给三档(合则不克 / 同阴阳 / 异阴阳),
  // 出处是《三命通会》1753 + 3825 两段合读。
  // 第十批接了第一档, 本批接后两档。
  //
  // ⚠️ 只在**克我者**这格提 —— 我克者那格是「我克对方」, 方向相反,
  //   `judgeKeByYinYang` 的语义是「other 克 self」, 用在那格是搞反了。
  //
  // ⚠️ 措辞按本模块纪律: **正面式陈述事实**, 不写禁令。
  const keYinYangLine = (cell) => {
    if (cell.relation !== 'ke') return null;
    return keYinYangNoteText(cell.polarity);
  };

  for (const [other, cell] of Object.entries(judged.cells)) {
    const cnt = judged.counts && judged.counts[other] !== undefined ? judged.counts[other] : '?';
    let line = '  ' + (NAMES[cell.relation] || cell.relation) + '(' + other + ', ' + cnt + '个): ' +
      (SNAMES[cell.strength] || cell.strength) + ' — ' + cell.reason;
    // 阴阳细分: 日主阴阳固定, 同异决定正偏 (正官/七杀, 正财/偏财…)
    const p = cell.polarity;
    if (p && (p.sameSample || p.diffSample)) {
      // 同阴阳 / 异阴阳 两支都列 —— 正偏是两个, 不是一个
      const tgOf = (sample, isSame) => {
        if (!sample) return null;
        let tg = isSame ? p.sameTenGod : p.diffTenGod;
        // 同我者(日主本身) 时 getTenGod 返回 null —— 比肩/劫财要走另一条路
        if (!tg && cell.relation === 'bi') tg = isSame ? '比肩' : '劫财';
        return tg ? sample + ' → ' + tg : null;
      };
      const parts = [tgOf(p.sameSample, true), tgOf(p.diffSample, false)].filter(Boolean);
      if (parts.length) {
        line += '；' + parts.join(' / ') + ' (日主' + (judged.self.yinYang || '?') + ')';
      }
    }
    const he = heLine(cell);
    if (he && cellPresent(judged, other)) line += '；' + he;
    const ky = keYinYangLine(cell);
    if (ky && cellPresent(judged, other)) line += '；' + ky;
    L.push(line);
  }
  if (judged.self.status) {
    L.push('  排盘旺衰结论: ' + judged.self.status
      + (judged.self.grade ? '(' + judged.self.grade + ')' : ''));
  }
  // 2026-10-28 第 130 批: 把三要素的依据摊开 —— 模型要能说清「凭什么旺」。
  const _detail = judged.self.detail;
  if (_detail && _detail['三要素']) {
    L.push('  旺衰依据: ' + _detail['三要素']
      + (_detail['等级'] ? ' → ' + _detail['等级'] : ''));
  }
  if (judged.xiYong && judged.xiYong.length) L.push('  喜用: ' + judged.xiYong.join('、'));
  if (judged.jiShell && judged.jiShell.length) L.push('  忌: ' + judged.jiShell.join('、'));
  // 计数自检不通过 → **必须让模型看见**, 不许它照着一份缺柱的判断往下解读
  if (judged.countsOk === false) {
    L.push('  ⚠️ 本次只读到 ' + judged.countsTotal + '/8 个字, 六格分量判断**不可靠**, ' +
      '缺失的五行一律显示"不成立"。照缺柱读, 别当成盘里真没有。');
  }
  return L.join('\n');
}

/**
 * 给模型看的**结论式摘要** —— 只要结论, 不要可追查的线索。
 *
 * 2026-10-21 E2E 实跑 (老板拍「那你干吧」那轮) 的教训:
 *   第一版把完整结构化对象(含 source / 文件路径 / 理由) 放在工具结果最前面,
 *   模型把它当成"需要我去核实的东西" —— 实跑 48 次 exec_command 满世界
 *   find/grep 判据文件和 bazi 目录, 整轮陷进去, 第一次跑连 final 都没有。
 *   模型看到路径/文件名就会去验证; 出处是给**人**查证的, 不是给模型的任务。
 *
 * 所以这里只给三样东西: 日主是什么 / 五个格各是什么状态 / 旺衰结论。
 * 全部是**已经算好的结论**, 模型照着用即可, 不需要再去求证。
 *
 * @param {object} judged judgeFromChart 的输出
 * @returns {string}
 */
function formatConclusion(judged) {
  if (!judged) return '';
  const NAMES = { sheng: '生我者', bi: '同我者', ke: '克我者', xie: '我生者', hao: '我克者' };
  const SNAMES = { strong: '有力', weak: '无力', not_established: '不成立', undetermined: '判不了' };
  const L = [];
  L.push('【六格判断·已算好, 直接用】');
  L.push('日主: ' + judged.self.wuxing + (judged.self.gan ? '·' + judged.self.gan : '') +
    (judged.self.yinYang ? '(' + judged.self.yinYang + ')' : ''));
  for (const [other, cell] of Object.entries(judged.cells)) {
    const p = cell.polarity;
    let tg = null;
    if (p) {
      const same = p.sameTenGod || (cell.relation === 'bi' ? '比肩' : null);
      const diff = p.diffTenGod || (cell.relation === 'bi' ? '劫财' : null);
      tg = [same, diff].filter(Boolean).join('/') || null;
    }
    // 合则不克 —— 只有克我者/我克者两格提 (理由见 formatJudgement 里 HE_ROLE 的注释)
    const heGans = (p && Array.isArray(p.heGans)) ? p.heGans : [];
    let heNote = '';
    // ⚠️ 只在该五行**确实在盘里**时才印(见 cellPresent 的注释):
    //   本盘没有这一格的东西, 说"与日主相合/克成立"是**假设**, 跟格级「不成立」打架。
    const present = cellPresent(judged, other);
    if (heGans.length && present && cell.relation === 'ke') {
      heNote = '（' + heGans.map(h => h.gan).join('、') + ' 与日主相合, 不参与克我）';
    } else if (heGans.length && present && cell.relation === 'hao') {
      heNote = '（' + heGans.map(h => h.gan).join('、') + ' 与日主相合, 不受我克）';
    }
    // 同异阴阳分正偏官 (第 47 批接线, 第 49 批换措辞) —— 老板 10-22 原话那条。
    // 只在**克我者**这格提(方向: other 克 self); 措辞与 formatJudgement 共用
    //   keYinYangNoteText, 两边不许各拼各的。
    let kyNote = '';
    if (cell.relation === 'ke' && present) {
      const ky = keYinYangNoteText(p);
      if (ky) kyNote = '（' + ky + '）';
    }
    L.push('  ' + (NAMES[cell.relation] || cell.relation) + '(' + other + '): ' +
      (SNAMES[cell.strength] || cell.strength) + (tg ? ' → ' + tg : '') + heNote + kyNote);
  }
  if (judged.self.status) {
    L.push('旺衰: ' + judged.self.status
      + (judged.self.grade ? '(' + judged.self.grade + ')' : ''));
  }
  // 2026-10-28 第 130 批: 依据也带一行(转述格局层的三要素, 本层不另算)。
  const _detail = judged.self.detail;
  if (_detail && _detail['三要素']) {
    L.push('旺衰依据: ' + _detail['三要素']);
  }
  if (judged.xiYong && judged.xiYong.length) L.push('喜用: ' + judged.xiYong.join('、'));
  if (judged.jiShell && judged.jiShell.length) L.push('忌: ' + judged.jiShell.join('、'));
  // 同 formatJudgement: 缺柱时这六格是残的, 必须在结论里说明
  if (judged.countsOk === false) {
    L.push('⚠️ 只读到 ' + judged.countsTotal + '/8 个字, 上面六格的分量不可靠, 缺失五行显示"不成立"是读不到不是没有。');
  }
  return L.join('\n');
}

module.exports = {
  judgeFromChart,
  formatJudgement,
  formatConclusion,
  countElements,
  keYinYangNoteText,
  ZHI_WUXING,
  GAN_YINYANG,
  GAN_WUXING,
  ZHI_BEN_QI,
};

