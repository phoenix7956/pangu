// modules/chart_fidelity.js — 八字柱位保真核查 (2026-10-21)
//
// 为什么要有这个:
//   盘古内核最值钱的一条承诺是「四柱来自 sxtwl 万年历, 不是 LLM 推算」。
//   但 2026-10-21 E2E 实跑第 6 轮亲眼看到模型把真盘改写:
//     工具给: 庚午(年柱) 癸未(月柱) 戊子(日柱) 己未(时柱)
//     模型答: 年 庚午 ｜ **月 辛未** ｜ 日 戊子？ ｜ **时 辛未**
//   月柱时柱双双编错, 而且**没有任何东西拦它**。
//   五行六格判据接进去之后 (bazi_strength.js), 这件事更严重:
//   模型只要改错一个柱, 后面"日主是什么""哪一格不成立"整套推断就全建在错的盘上,
//   而判据层是照着**工具给的盘**算的 —— 判据越权威, 错的盘越有欺骗性。
//
// 与 grounding_check 同门, **同一套哲学** (那边 2026-10-14 立, 这边照搬):
//   「判出来的结果只留痕不改答案: 文本级判定一定有误报, 拿它去拦答案
//     会把真结论判死, 那样守卫就再也没人信了。可证伪比强拦更有用。」
//
// 刻意**不做**的事:
//   - 不改 finalText 一个字
//   - 不因为查出来就判 failed
//   - 不对没有 bazi_calc 结果的轮次做任何判定
//   - 本轮算出多张**不同**的盘 (合婚/双人对比) 也不判, 单盘的尺子量不了两盘答案
//   它只回答一个问题: **答案里说的柱, 和工具算出来的柱, 对不对得上**。
'use strict';

const GAN = '甲乙丙丁戊己庚辛壬癸';
const ZHI = '子丑寅卯辰巳午未申酉戌亥';
// 上下文判据 ("这句话说的是不是本命盘") 住在断言模块里, 那边也用同一套。
// 两处各写一份的代价不是重复, 是边界漂成两个窗口, 然后两个窗口各判各的。
const { nonNativeContext } = require('./bazi_chart_facts');

// 柱位断言: "月柱 癸未" / "月 辛未" / "时柱：己未" / "时 **辛未**" / "**月柱**:辛亥"
// 分隔符里必须容得下: 半角/全角冒号、空格、markdown 的 * _ ` ~ ——
//   实跑那句原话是 `时 **辛未**`, 一开始只写了 \s*[:]?, 结果时柱这一处直接漏检。
//   漏检比误报更难发现: 漏检悄无声息, 误报至少会吵。
// 干支两字必须都是天干地支 —— 中文散文里随便撞上这两个字连成词的机会极低,
// 所以这一层的精度足够, 误报主要来自"年份前缀"和"非柱位"两类 (两者都在
// bazi_chart_facts 的 nonNativeContext 里, 本模块不另写一份)。
const PILLAR_CLAIM_RE = new RegExp(
  '(年|月|日|时)(?:柱|支)?[\\s*_`~：:]*'
  + '[' + GAN + '][' + ZHI + ']',
  'g'
);

// 后缀写法: "庚午年 癸未月 戊子日 己未时" —— 八字的标准写法之一, 也是模型最常用的一种。
//   E2E 2026-10-21 实跑现场: 模型答的正是这个形状, 而只认前缀的正则会把
//   "年 癸未" 当成年柱 → 一张**完全正确**的盘被判成"年柱写成癸未、月柱写成戊子、
//   日柱写成己未"三条硬伤, 白花一次重修还在正确答案尾巴上挂了 ⚠️。
//   误伤比漏检贵 (判死了守卫就再也没人信), 所以两种写法必须都认。
//
// 两种写法必须**互斥**: 同一段文字既按前缀读又按后缀读, 必然自相矛盾。
//   判定: 位置词紧跟在干支后面 (后缀匹配正好结束在这个位置词上) →
//   这个位置词属于后缀, 前缀匹配作废。
const SUFFIX_PILLAR_CLAIM_RE = new RegExp(
  '[' + GAN + '][' + ZHI + '](年|月|日|时)',
  'g'
);

const POS_KEY = { 年: '年柱', 月: '月柱', 日: '日柱', 时: '时柱' };

/**
 * 把一条工具记录归一成 {name, ok, result}。
 *
 * 为什么必须归一 (2026-10-21): 本仓的工具记录有**三种**形状, 各自的生产者不同 ——
 *   ① {name, ok, result}       —— sub-agent.js 的 toolHistory (sub-agent.js:1639)
 *   ② {tc:{name}, execResult}  —— j2_agent_loop 的 toolResults (j2_agent_loop.js:3192 / 3472)
 *   ③ {name, ok, content}      —— pangu-single _j2ExecuteToolCalls 的返回值
 * 在下游按某一种形状硬编 = 换一条路就静默失效, 而失效的表现是"门不响", 看不出来。
 * 形状知识只允许住在这一处, 谁来都先过这里。
 */
function _normEntry(t) {
  if (!t || typeof t !== 'object') return null;
  const name = t.name || (t.tc && t.tc.name) || null;
  const result = t.result || t.execResult || null;
  if (!name || !result || typeof result !== 'object') return null;
  // 形状②的记录本身没有 ok 字段, 真值在 execResult.ok 上 —— 所以两个来源都认,
 // entry.ok 优先 (那是生产者显式给的)。
  const ok = t.ok === true ? true : (t.ok === false ? false : result.ok === true);
  return { name, ok, result };
}

/**
 * 从 bazi_calc 的工具结果里抠出**权威**四柱, 按盘去重后全部返回。
 * 同一盘算两次 (模型重试) 只算一张; 算出**不同**的盘 = 本轮有多盘 (合婚/双人对比),
 * 调用方要靠 charts.length 判断"答案里这一柱说的是哪张盘"。
 *
 * 只认 data.pillars.pillars —— 那是 sxtwl 直接吐出来的, 是盘古在这件事上唯一真源。
 * 拿不到就返回空数组: 宁可不做判定, 也不拿答案自己的字拼一个假盘去核验答案
 * (那就是"拿错东西验错东西", 2026-10-21 踩坑日志原话)。
 *
 * @param {Array} toolResults runAgentLoop / sub-agent 累积的 toolHistory
 * @returns {Array<{年柱:string,月柱:string,日柱:string,时柱:string}>}
 */
function collectAuthoritativeCharts(toolResults) {
  const list = Array.isArray(toolResults) ? toolResults : [];
  const out = [];
  const seen = new Set();
  for (const t of list) {
    const e = _normEntry(t);
    if (!e || e.name !== 'bazi_calc' || e.ok !== true) continue;
    // 工具结果有多种包裹形态 (result.data / 记录本身就是 chart), 全试一遍,
    // 但**只取真的带 pillars.pillars 的那个** —— 不猜。
    const cands = [e.result, t];
    for (const c of cands) {
      const p = c && c.data && c.data.pillars && c.data.pillars.pillars;
      if (!p || typeof p !== 'object') continue;
      const chart = {};
      let ok = true;
      for (const k of ['年柱', '月柱', '日柱', '时柱']) {
        const v = p[k];
        // 干支必须两字齐全, 缺一柱就当这份证据不完整, 宁可不做判定
        if (typeof v !== 'string' || v.length !== 2) { ok = false; break; }
        chart[k] = v;
      }
      if (!ok) continue;
      const key = chart['年柱'] + chart['月柱'] + chart['日柱'] + chart['时柱'];
      if (!seen.has(key)) { seen.add(key); out.push(chart); }
      break;
    }
  }
  return out;
}

/**
 * 从 bazi_calc 的工具结果里抠出**权威**四柱。
 * 只认 data.pillars.pillars —— 那是 sxtwl 直接吐出来的, 是盘古在这件事上唯一真源。
 *
 * @param {Array} toolResults runAgentLoop 累积的 toolHistory
 * @returns {object|null} {年柱, 月柱, 日柱, 时柱} 或 null
 */
function extractAuthoritativePillars(toolResults) {
  const charts = collectAuthoritativeCharts(toolResults);
  return charts.length ? charts[0] : null;
}

/**
 * 核一遍答案里的柱位断言。
 *
 * @param {string} text 子 agent 的最终答复
 * @param {Array} toolResults toolHistory
 * @returns {{applicable:boolean, pillars:object|null, checked:number, mismatches:Array}}
 */
function check(text, toolResults) {
  const charts = collectAuthoritativeCharts(toolResults);
  const pillars = charts.length === 1 ? charts[0] : null;
  const empty = { applicable: false, pillars: null, checked: 0, mismatches: [] };
  // 没有 bazi_calc 的轮次一律不判 —— 不该拿排盘的尺子量所有问题。
  // 本轮算出**多张不同的盘** (合婚/双人对比) 也不判: 单张盘的尺子量不了两盘答案,
  // 硬判就是把第二张盘的柱子整片报成"改写", 误报比漏检吵得多。
  if (!pillars) return empty;

  const src = String(text == null ? '' : text);
  const mismatches = [];
  let checked = 0;

  // 两遍扫: 先扫后缀写法并记下它占用的位置词下标, 前缀写法撞上下标就作废 (互斥)。
  const claims = [];
  const suffixTaken = new Set();
  let m;
  SUFFIX_PILLAR_CLAIM_RE.lastIndex = 0;
  while ((m = SUFFIX_PILLAR_CLAIM_RE.exec(src)) !== null) {
    suffixTaken.add(m.index + 2);
    claims.push({ index: m.index, pos: POS_KEY[m[1]], ganzhi: m[0].slice(0, 2) });
  }
  PILLAR_CLAIM_RE.lastIndex = 0;
  while ((m = PILLAR_CLAIM_RE.exec(src)) !== null) {
    if (suffixTaken.has(m.index)) continue; // 这个位置词属于后缀写法
    const pos = POS_KEY[m[1]];
    const said = m[0].slice(m[0].indexOf(m[1]) + 1).replace(/[\s::]/g, '');
    // said 可能带"柱"字 ("月柱癸未" → slice 后是 "柱癸未"), 取末尾两字才是干支
    claims.push({ index: m.index, pos, ganzhi: said.slice(-2) });
  }
  for (const c of claims) {
    //
    // 上下文窗口要**含位置词自己** —— 第一版只取 m.index 之前的 8 个字符,
    // 于是「流年 丙午」里的那个"年"成了位置词, 它前面的窗口只剩"流"字,
    // NON_PILLAR_CTX_RE 匹配不到"流年", 丙午被判成了年柱。
    // 一个字之差, 整张盘每一年都会被自己的流年判成幻觉。
    // 流年/大运/流月/纳音 里的干支不是本命柱, 不按柱位核
    if (nonNativeContext(src, c.index)) continue;
    checked++;
    const expected = pillars[c.pos];
    if (c.ganzhi !== expected) {
      mismatches.push({ position: c.pos, said: c.ganzhi, expected });
    }
  }
  return {
    applicable: true,
    pillars,
    checked,
    mismatches,
  };
}

/**
 * 留痕用的文案。**不用于改答案**, 只用于 trace / 日志 / 事后复盘。
 * @returns {string}
 */
function describe(res) {
  if (!res || !res.applicable) return '';
  if (!res.mismatches.length) {
    return '柱位保真: 核了 ' + res.checked + ' 处柱位断言, 全部与 sxtwl 排盘一致';
  }
  return '柱位保真: ' + res.mismatches.length + ' 处柱位与 sxtwl 排盘对不上 —— '
    + res.mismatches.map((x) => x.position + ' 写成 ' + x.said + ' (真值 ' + x.expected + ')').join('; ')
    + '。答案已原样保留, 但这几句是模型改写的, 不是排盘结果。';
}

module.exports = { check, describe, extractAuthoritativePillars, collectAuthoritativeCharts };
