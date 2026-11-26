/**
 * 排盘断言守卫 —— 抓「把编的盘标成已核实」
 *
 * 现场 (2026-10-21 E2E 实跑): 主人说「1987-11-20 07:00 男」,
 * planner 在**任何工具都没跑之前**就写下
 *     「丁卯/己亥/丁酉/甲辰，日主丁火」
 * 并把它标成
 *     「前一刀已核实，直接采信，不得另算、不得改动四柱与大运」
 * 喂给综合 agent。
 *
 * 真值是 **丁卯/辛亥/癸酉/丙辰，日主癸水** (bazi_calc 实跑确认)。
 *
 * > **把编的盘标成"已核实"，比答错更坏** —— 答错模型自己会怀疑，
 *   标成已核实就连怀疑的机会都没了。
 *
 * 现有的 `chart_verify_guard` **拦不住**: 它的边界写死是
 * 「只在**本轮已经成功调过确定性排盘工具**时才生效」, 防的是**事后**自己重算;
 * 编造发生在**事前**, 在 planner 写简报这一侧, 是另一个子系统。
 *
 * ═══════════════════════════════════════════════════════════════
 * 判据设计: **真源对照**, 不是文本匹配
 * ═══════════════════════════════════════════════════════════════
 * 为什么不直接匹配「已核实」三个字:
 *   它是盘古的**合法高频词** —— 提示词里写死了「回答的第一段必须是已核实的事实/
 *   结论」(pangu-single.js:345), 每个子 agent 的输出模板里都有它。
 *   拿它当判据 = 把正常输出全判成编造 = 误伤比漏检贵(项目铁律)。
 *
 * 本守卫只抓一种**具体到可以判真假**的东西: **四柱/日主这类具体断言**。
 * 判真假靠真源对照:
 *
 *   文本侧: 简报里出现了**带位置词的干支** (如「日主丁火」「时柱己未」)
 *           或「日主X」这种日主断言 —— 这些是**可验证的具体值**,
 *           不是模糊措辞, 不会出现"到底指哪一柱"的歧义。
 *   真源侧: 本轮**已经成功调过** bazi_calc / gua_cast 吗?
 *           有 → 用 sxtwl 权威盘对账, 对不上就是编的。
 *           没有 → 简报里就不该出现任何具体四柱 (谁给它的? 没人生成过)。
 *
 * 关键: 「没有真源」这一条也足以定罪, 因为**没有人算过盘**,
 * 简报里的四柱就只能是编的。这正是现场的形状。
 *
 * ⚠️ 误伤防线 (三条, 缺一不可):
 *   ① 没有真源时, **只判"带位置词"的干支** —— 裸干支 (如「丙寅」)
 *      可能是在讲流年/纳音/相关成语, 不判。
 *   ② 有真源时, 对账**逐柱**做, 某一柱对不上才算硬伤, 不整段否。
 *   ③ 本轮算出**多张不同的盘** (合婚/双人对比) → 不判。单盘的尺子量不了两盘。
 */

'use strict';

const path = require('path');

// 柱位断言与权威盘抽取的**唯一真源** —— 不另写一份正则。
// 另写一份 = 两个窗口各判各的, 然后边界漂成两个口径。
const chartFidelity = require('./chart_fidelity');

const GAN = '甲乙丙丁戊己庚辛壬癸';
const ZHI = '子丑寅卯辰巳午未申酉戌亥';
const WUXING = '金木水火土';

/** 确定性排盘/起卦工具 —— 它们的产出是本轮唯一真源 */
const CHART_TOOLS = new Set(['bazi_calc', 'gua_cast']);

/**
 * 带位置词的干支断言: 「月柱癸未」/「日 **戊子**」/「时支丙寅」
 * —— 必须带位置词, 裸干支不算 (可能是流年/纳音/成语)。
 */
const POSITIONED_PILLAR_RE = new RegExp(
  '(年|月|日|时)(?:柱|支|主)?[\\s*_`~：:]*'
  + '[' + GAN + '][' + ZHI + ']',
  'g'
);

/** 日主断言: 「日主丁火」/「日主为癸水」/「日元戊土」 */
const DAY_MASTER_RE = new RegExp(
  '(?:日主|日元|日干)[\\s*_`~：:是为]*([' + GAN + '][' + WUXING + '])',
  'g'
);

/** 日主 → 五行 的真值表 (天干定五行, 这是常识级映射, 不是术数判断) */
const GAN_WUXING = {
  甲: '木', 乙: '木', 丙: '火', 丁: '火', 戊: '土',
  己: '土', 庚: '金', 辛: '金', 壬: '水', 癸: '水',
};

const POS_KEY = { 年: '年柱', 月: '月柱', 日: '日柱', 时: '时柱' };

/**
 * 「指示下游采信编造结论」的措辞 —— 光抹掉四柱**不够**。
 *
 * ⚠️ 为什么必须连指示语一起剥 (2026-10-22 实测):
 *   抹完四柱后, 现场那句剩下的是:
 *     「前一刀已核实: 〔四柱待核实〕/…, 日主〔日主待核实〕。直接采信, 不得另算…」
 *   「直接采信」「不得另算」**还在** —— 它继续指示下游 agent 照着一个
 *   已经被抹掉的盘推断, 只是变成了「照着一个空壳采信」。
 *   抹值不抹令 = 只拆了炸弹的引信, 没拆弹体。
 */
const TRUST_DIRECTIVE_RE = new RegExp(
  '(前一刀|上一刀|前面|上述|以上|先前|之前)[^。;；\n]{0,12}'
  + '(已核实|已确认|已核对|已验证|核实无误|确认无误)'
  + '|直接采信'
  + '|不得另算'
  + '|不许另算'
  + '|不要另算'
  + '|不得改动四柱'
  + '|不得改动[^。;；\n]{0,8}大运'
  + '|不要改动四柱',
  'g'
);

/**
 * 斜杠/顿号连写的四柱: 「丁卯/己亥/丁酉/甲辰」
 *
 * ⚠️ 为什么必须单列这一条 (2026-10-22 实测):
 *   现场的编造原文正是这个形状 —— 「丁卯/己亥/丁酉/甲辰，日主丁火」。
 *   而 `POSITIONED_PILLAR_RE` 要求**带位置词**, 认不出它;
 *   `chart_fidelity` 的两个正则(前缀/后缀写法)同样认不出它。
 *   于是**最常见的八字写法反而是判据的盲区** —— 现场那一份编造漏检了。
 *
 * 误伤风险评估: 四连干支 + 分隔符, 是四柱的标准形状。
 * 裸干支在中文散文里偶尔撞上 (如「甲子年」), 但**四个连写**几乎只可能是四柱。
 * 仍要防两种:
 *   ① 干支数不足 4 个 → 不认 (「甲乙丙丁」这种枚举不是盘)
 *   ② 上下文是流年/大运/纳音 → 不认 (借 bazi_chart_facts.nonNativeContext)
 */
const SLASH_PILLARS_RE = new RegExp(
  '([' + GAN + '][' + ZHI + '])(?:\\s*[/／、,，]\\s*'
  + '[' + GAN + '][' + ZHI + ']){3}',
  'g'
);

/** 斜杠串里的分隔符 —— 切出 4 个干支 */
const SLASH_SPLIT_RE = new RegExp(
  '[' + GAN + '][' + ZHI + ']', 'g'
);

// ============================================================
// 工具
// ============================================================

/** 把工具记录归一 — 直接用 chart_fidelity 的形状知识, 不重造 */
function _normEntry(t) {
  if (!t || typeof t !== 'object') return null;
  const name = t.name || (t.tc && t.tc.name) || null;
  const result = t.result || t.execResult || null;
  if (!name || !result || typeof result !== 'object') return null;
  const ok = t.ok === true ? true : (t.ok === false ? false : result.ok === true);
  return { name, ok, result };
}

/**
 * 本轮成功调过哪些确定性排盘工具。
 * @param {Array} toolResults
 * @returns {string[]}
 */
function succeededChartTools(toolResults) {
  const list = Array.isArray(toolResults) ? toolResults : [];
  const out = [];
  for (const t of list) {
    const e = _normEntry(t);
    if (!e || e.ok !== true) continue;
    if (!CHART_TOOLS.has(e.name)) continue;
    if (!out.includes(e.name)) out.push(e.name);
  }
  return out;
}

/**
 * 抽文本里的「带位置词的干支」断言。
 * @returns {Array<{index:number, pos:string, ganzhi:string}>}
 */
function extractPositionedPillars(text) {
  const src = String(text == null ? '' : text);
  const out = [];
  POSITIONED_PILLAR_RE.lastIndex = 0;
  let m;
  while ((m = POSITIONED_PILLAR_RE.exec(src)) !== null) {
    // ⚠️ 「流年丙午」的「年」**不是**柱位词 —— 它是「流年」的半截。
    //   正则从「年」字起命中, 于是断言位置落在「年」上, 而 nonNativeContext
    //   的窗口(位置词之前 8 字)此时还没包含「流」字 → 「流年」判不出来 →
    //   流年干支被当成年柱 → **误伤**。
    //   (实测: nonNativeContext(src, 干支起点) = true, 但 (src, 位置词起点) = false)
    //
    //   修法: 位置词前面紧邻「流/大/太/纳/节/空」等限定字时, 这个位置词不算柱位。
    //   这些字正是 NON_NATIVE_CHART_RE 里那批非本命盘语境词的首字。
    const before = src.slice(Math.max(0, m.index - 2), m.index);
    if (/[流大太纳节空甲]/.test(before)) continue;
    const pos = POS_KEY[m[1]];
    const said = m[0].slice(m[0].indexOf(m[1]) + 1).replace(/[\s*_:：`~]/g, '');
    const ganzhi = said.slice(-2);
    if (ganzhi.length !== 2) continue;
    out.push({ index: m.index, pos, ganzhi });
  }
  return out;
}

/**
 * 抽文本里的日主断言。
 * @returns {Array<{index:number, gan:string, wuxing:string}>}
 */
function extractDayMaster(text) {
  const src = String(text == null ? '' : text);
  const out = [];
  DAY_MASTER_RE.lastIndex = 0;
  let m;
  while ((m = DAY_MASTER_RE.exec(src)) !== null) {
    out.push({ index: m.index, gan: m[1][0], wuxing: m[1][1] });
  }
  return out;
}

/**
 * 抽文本里的「斜杠连写四柱」。
 * @returns {Array<{index:number, pillars:Array<{pos:string, ganzhi:string}>}>}
 */
function extractSlashPillars(text) {
  const src = String(text == null ? '' : text);
  const out = [];
  SLASH_PILLARS_RE.lastIndex = 0;
  let m;
  while ((m = SLASH_PILLARS_RE.exec(src)) !== null) {
    const raw = m[0];
    const list = raw.match(SLASH_SPLIT_RE) || [];
    if (list.length !== 4) continue; // 干支数不对 → 不是四柱
    // 流年/大运/纳音语境不算本命盘
    try {
      const { nonNativeContext } = require('./bazi_chart_facts');
      if (nonNativeContext(src, m.index)) continue;
    } catch (_) { /* 拿不到就按本命盘判, 宁可多看 */ }
    const order = ['年柱', '月柱', '日柱', '时柱'];
    out.push({
      index: m.index,
      pillars: list.map((g, i) => ({ pos: order[i], ganzhi: g })),
    });
  }
  return out;
}

// ============================================================
// 核心判定
// ============================================================

/**
 * 核一段简报/答复里的排盘断言。
 *
 * @param {string} text 待核的文本 (子任务简报 task / 子 agent 答复)
 * @param {Array} toolResults 本轮工具结果 (用于抽权威盘)
 * @param {string} [sessionId] 有则一并查账本里的跨轮真源
 * @returns {{
 *   applicable: boolean,
 *   violations: Array<{kind:string, said:string, expected?:string, why:string}>,
 *   reason: string
 * }}
 */
function check(text, toolResults, sessionId) {
  const src = String(text == null ? '' : text);
  const empty = { applicable: false, violations: [], reason: '' };
  if (!src.trim()) return empty;

  const charts = collectCharts(toolResults, sessionId);
  const chartTools = succeededChartTools(toolResults);

  const pillars = extractPositionedPillars(src);
  const dayMasters = extractDayMaster(src);
  const slashPillars = extractSlashPillars(src);

  // 连一个可验证的具体断言都没有 → 本守卫不适用, 不判。
  // 这一条是误伤防线的第一道: 「已核实」「已确认」这类模糊措辞**不在判据里**。
  if (!pillars.length && !dayMasters.length && !slashPillars.length) {
    return { ...empty, reason: '没有可验证的排盘断言 (无带位置词的干支, 无日主)' };
  }

  const violations = [];

  // ── 分支 A: 本轮**没有任何**排盘真源 ──────────────────────────
  // 没人算过盘, 简报里的四柱就只能是编的。
  if (!charts.length) {
    for (const p of pillars) {
      violations.push({
        kind: 'pillar_no_source',
        pos: p.pos,
        said: p.ganzhi,
        why: '本轮没有任何排盘工具产出, 简报里却出现了带位置词的干支「' + p.ganzhi + '」—— '
          + '没有人算过盘, 这个值只能是编的',
      });
    }
    for (const d of dayMasters) {
      violations.push({
        kind: 'day_master_no_source',
        said: d.gan + d.wuxing,
        why: '本轮没有任何排盘工具产出, 简报里却断言日主「' + d.gan + d.wuxing + '」—— '
          + '没有人算过盘, 这个值只能是编的',
      });
    }
    for (const sp of slashPillars) {
      const desc = sp.pillars.map(p => p.ganzhi).join('/');
      violations.push({
        kind: 'slash_pillars_no_source',
        said: desc,
        why: '本轮没有任何排盘工具产出, 简报里却给出了完整四柱「' + desc + '」—— '
          + '没有人算过盘, 这一整张盘只能是编的',
      });
    }
    return {
      applicable: true,
      violations,
      reason: chartTools.length
        ? ('调过 ' + chartTools.join('/') + ' 但没抽出权威盘, 视为无真源')
        : '本轮未调过任何排盘工具',
    };
  }

  // ── 分支 B: 有真源 ──────────────────────────────────────────
  // ③ 多张不同的盘 (合婚/双人对比) → 不判。单盘的尺子量不了两盘答案。
  if (charts.length > 1) {
    return {
      applicable: false,
      violations: [],
      reason: '本轮算出 ' + charts.length + ' 张不同的盘 (合婚/双人对比), 单盘的尺子量不了, 不判',
    };
  }

  const auth = charts[0];

  // 逐柱对账 —— 某一柱对不上才算硬伤, 不整段否。
  for (const p of pillars) {
    const expected = auth[p.pos];
    if (expected && p.ganzhi !== expected) {
      violations.push({
        kind: 'pillar_mismatch',
        pos: p.pos,
        said: p.ganzhi,
        expected,
        why: p.pos + '写成「' + p.ganzhi + '」, sxtwl 排盘是「' + expected + '」',
      });
    }
  }

  // 斜杠连写四柱: 逐柱对账
  for (const sp of slashPillars) {
    for (const p of sp.pillars) {
      const expected = auth[p.pos];
      if (expected && p.ganzhi !== expected) {
        violations.push({
          kind: 'slash_pillar_mismatch',
          pos: p.pos,
          said: p.ganzhi,
          expected,
          why: p.pos + '写成「' + p.ganzhi + '」, sxtwl 排盘是「' + expected + '」',
        });
      }
    }
  }

  // 日主对账: 日主 = 日柱天干。日柱没抽出来就不判日主。
  const dayGan = auth['日柱'] ? auth['日柱'][0] : null;
  if (dayGan) {
    for (const d of dayMasters) {
      if (d.gan !== dayGan) {
        violations.push({
          kind: 'day_master_mismatch',
          said: d.gan + d.wuxing,
          expected: dayGan + (GAN_WUXING[dayGan] || ''),
          why: '日主写成「' + d.gan + d.wuxing + '」, 日柱是「' + auth['日柱'] + '」, 日主应是「'
            + dayGan + (GAN_WUXING[dayGan] || '') + '」',
        });
      } else if (d.wuxing && GAN_WUXING[d.gan] && d.wuxing !== GAN_WUXING[d.gan]) {
        violations.push({
          kind: 'day_master_wuxing_mismatch',
          said: d.gan + d.wuxing,
          expected: d.gan + GAN_WUXING[d.gan],
          why: '日主天干「' + d.gan + '」属' + GAN_WUXING[d.gan] + ', 写成了' + d.wuxing,
        });
      }
    }
  }

  return {
    applicable: true,
    violations,
    reason: violations.length
      ? ('与 sxtwl 权威盘对不上 ' + violations.length + ' 处')
      : '与 sxtwl 权威盘一致',
  };
}

/**
 * 抽权威盘 —— 两个来源合并:
 *   ① toolResults 里的 bazi_calc 结果 (本轮内存里的)
 *   ② 账本里记的 charts_cast (跨轮存活的, 父会话自己没有账本文件)
 *
 * ② 是必要的: 走 dispatcher 的父会话**不经过 j2_agent_loop**, 没有自己的账本,
 *   只有 <parent>_sub-N-role 各有一份。而判"编造"恰恰发生在派活那一刻 ——
 *   那时本轮的 toolHistory 还不存在, 只能问账本。
 *
 * @param {Array} toolResults
 * @param {string} [sessionId] 有则一并查账本
 * @returns {Array<{年柱:string,月柱:string,日柱:string,时柱:string}>}
 */
function collectCharts(toolResults, sessionId) {
  const out = [];
  const seen = new Set();
  const push = (chart) => {
    if (!chart) return;
    const key = chart['年柱'] + chart['月柱'] + chart['日柱'] + chart['时柱'];
    if (seen.has(key)) return;
    seen.add(key);
    out.push(chart);
  };
  for (const c of chartFidelity.collectAuthoritativeCharts(toolResults)) push(c);
  if (sessionId) {
    try {
      const ledger = require('./task_ledger');
      for (const rec of ledger.collectCastCharts(sessionId)) push(rec.pillars);
    } catch (_) { /* 账本读不到就当没有 */ }
  }
  return out;
}

/**
 * 留痕文案。**只用于日志/复盘**, 不用于改答案。
 * @returns {string}
 */
function describe(res) {
  if (!res || !res.applicable || !res.violations.length) return '';
  return '排盘断言核验: ' + res.violations.length + ' 处对不上 (' + res.reason + ') —— '
    + res.violations.map(v => v.why).join('; ');
}

/**
 * 把简报里的编造断言**剥掉**, 换回一句让执行方自己去算的话。
 *
 * ⚠️ 这是**唯一**允许改动简报文本的地方, 而且只动**被证实编造**的那几处。
 *   做法: 把编造的干支/日主从 task 文本里抹掉, 换成
 *   「【真源缺失】此前的排盘结论没有排盘工具产出支撑, 不得采信;
 *     请自己调 bazi_calc 取权威盘, 不许沿用任何未核实的四柱/日主」
 *
 *   为什么是"抹掉"而不是"标个警告":
 *   留着「日主丁火」四个字, 后面每个 agent 看到它都可能当成事实用 ——
 *   标注只是给人看的, 抹掉才是给机器看的。**注释 ≠ 隔离**。
 *
 * @param {string} text 原始 task 文本
 * @param {object} res check() 的结果
 * @returns {string} 处理后的 task 文本
 */
function sanitizeTaskText(text, res) {
  const src = String(text == null ? '' : text);
  if (!res || !res.applicable || !res.violations.length) return src;

  let out = src;
  // 先抹斜杠连写的四柱 (整个串一起抹, 别只抹一个字留三个)
  for (const sp of extractSlashPillars(src)) {
    const raw = sp.pillars.map(p => p.ganzhi).join('/');
    // 原文里分隔符可能不是 '/', 逐个干支抹更稳
    for (const p of sp.pillars) {
      if (p.ganzhi) out = out.split(p.ganzhi).join('〔四柱待核实〕');
    }
    void raw;
  }
  // 先抹带位置词的干支
  for (const p of extractPositionedPillars(src)) {
    if (p.ganzhi) out = out.split(p.ganzhi).join('〔四柱待核实〕');
  }
  // 再抹日主断言
  for (const d of extractDayMaster(src)) {
    const token = d.gan + d.wuxing;
    if (token) out = out.split(token).join('〔日主待核实〕');
  }
  // ★ 连「指示语」一起剥 —— 否则下游 agent 还在被指示采信一个已被抹掉的盘
  TRUST_DIRECTIVE_RE.lastIndex = 0;
  out = out.replace(TRUST_DIRECTIVE_RE, '〔原指示已作废〕');

  const banner = '【真源缺失 · 排盘结论未核实】\n'
    + '此前简报里出现的排盘结论(四柱/日主)**没有排盘工具产出支撑**, 是编的。\n'
    + '不得采信、不得沿用、不得改动任何未核实的四柱/日主。\n'
    + '请自己调 bazi_calc 取 sxtwl 权威盘, 以工具结果为准。\n'
    + '————————————————————————\n';

  return banner + out;
}

module.exports = {
  check,
  describe,
  sanitizeTaskText,
  collectCharts,
  succeededChartTools,
  extractPositionedPillars,
  extractDayMaster,
  extractSlashPillars,
  CHART_TOOLS,
  GAN_WUXING,
};
