'use strict';
/**
 * 出门核验门 —— **唯一编排实现**。
 *
 * ## 为什么有这个模块 (2026-10-23 第 60 批)
 *
 * 门本身早就有(卦象门 gua_answer_gate / 命盘门 chart_answer_gate),
 * 但「跑门」这件事被抄成了两份:
 *   - `j2_dispatcher.js` 的 `_factGate()` —— 5 个调用点都走它,
 *     注释里还写着「出门只有一道闸, 以后加第三种断言(梅花/六壬/奇门)也只改一处,
 *     不会出现『新门忘了接到某个调用点』」。
 *   - `j2_agent_loop.js:5038-5075` —— **内联抄了一份**, 没走上面那个抽象。
 *
 * 两份已经漂了(不是「将来会漂」, 是现在):
 *   | 差异点              | _factGate                        | loop 内联那份              |
 *   |---------------------|----------------------------------|----------------------------|
 *   | 日志触发条件        | 只在 `repaired` 时打             | `repaired \|\| 有矛盾` 就打  |
 *   | 重修用的 ask 回调   | 不带 soulScope                   | 带 `soulScope`             |
 *   | 系统守卫文案豁免    | 没有                             | `_SYS_GUARD_TEXT_RE` 豁免   |
 *
 * 「新门只改一处」这条设计意图, 被 loop 那份内联拷贝正面违反 ——
 * 而恰恰是 loop 那条路才是主 agent 出答复的主路(第 8 批实跑里抓到
 * 「第24卦答成贲卦」「复卦写成雷地复」「爻辞写七条」的就是这条路)。
 *
 * 本模块把「跑哪几道门、按什么顺序、怎么记日志、异常怎么办」收成一份,
 * 调用点只负责**提供证据**和**提供 ask**。
 *
 * ## 纪律
 *
 * - 门异常**不阻断交付**(两道门都包在 try 里) —— 门是加法不是减法,
 *   跟 stop_point、progress_judge 同一纪律。
 * - 日志条件统一成「重修了 或 有矛盾」: 两者都打。
 *   只在 `repaired` 时打的话, 「查出来有硬伤但重修没改掉」这种最该被看见的情况
 *   反而静悄悄 —— 而那正是第 8 批实跑里盘古把卦名答错的那一类。
 * - `soulScope` 变成**参数**: loop 传自己的, dispatcher 传它原来那个值(不传)。
 *   不替调用方猜 —— 猜错就是静默改行为。
 */

const _isAnthModel = (m) => {
  try { return require('./model_transport').isAnthropic(m); } catch (_) { return false; }
};

/**
 * 构造「问模型一个重修问题」的回调。
 *
 * @param {function} callLLM  `_deps._callLLMForAgent(messages, model, tools, opts)`
 * @param {string} model
 * @param {object} [opts]
 * @param {string} [opts.soulScope]  传了就带上, 不传就不带 (跟改造前逐字一致)
 * @param {string} [opts.logPrefix]  留空则不打任何日志 (dispatcher 原行为)
 * @returns {function(string): Promise<string>}
 */
function buildAskFn(callLLM, model, opts = {}) {
  return async (prompt) => {
    // 没有 soulScope 时**只传三个参数** —— 改造前 dispatcher 那条路就是这么调的,
    // 多传一个 {} 会不会改变 _callLLMForAgent 内部行为, 不该由这里替它赌。
    const resp = opts.soulScope
      ? await callLLM([{ role: 'user', content: prompt }], model, [], { soulScope: opts.soulScope })
      : await callLLM([{ role: 'user', content: prompt }], model, []);
    if (Array.isArray(resp && resp.content)) {
      return resp.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
    }
    if (_isAnthModel(model)) {
      return (resp.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
    }
    return (resp && resp.choices && resp.choices[0] && resp.choices[0].message
      && resp.choices[0].message.content) || '';
  };
}

/**
 * 跑全部出门核验门。
 *
 * @param {string} finalText
 * @param {function} askFn  `buildAskFn` 造的回调
 * @param {object} [opts]
 * @param {Array}  [opts.chartEvidence]  权威四柱证据 (bazi_calc 的 toolHistory 条目)
 * @param {RegExp} [opts.skipWhen]  命中就整轮跳过 (系统守卫文案不核验)
 * @param {string} [opts.logPrefix]   日志前缀, 如 '[j2]' / '[dispatcher]'
 * @returns {Promise<{text:string, gua:object|null, chart:object|null}>}
 */
async function runAnswerGates(finalText, askFn, opts = {}) {
  const out = { text: String(finalText || ''), gua: null, chart: null };
  if (!out.text || typeof askFn !== 'function') return out;
  if (opts.skipWhen && opts.skipWhen.test(out.text.trim())) return out;
  const tag = opts.logPrefix || '';
  const say = (line) => { if (tag) console.log(tag + line); };

  // 卦象门先跑: 只看文本 + 64i 真源, 不依赖排盘证据。
  // 结果喂给命盘门 —— 卦名先对了, 命盘门核的才是同一个对象的答案。
  try {
    const guaGate = require('./gua_answer_gate');
    const g = await guaGate.verifyAndRepairGuaAnswer(out.text, askFn);
    out.gua = g;
    if (g.repaired || (g.contradictions && g.contradictions.length)) {
      say(' GUA_GATE: 卦象答案核验, 硬伤 '
        + (g.contradictions ? g.contradictions.length : 0) + ' 处, 重修=' + !!g.repaired);
    }
    out.text = g.text;
  } catch (e) {
    say(' GUA_GATE 异常(不阻断交付): ' + (e && e.message ? e.message : e));
  }

  // 命盘门 (要排盘证据; 拿不到权威盘时退回从答案抽 —— 见 chart_answer_gate 内注释)。
  try {
    const chartGate = require('./chart_answer_gate');
    const r = await chartGate.verifyAndRepairChartAnswer(out.text, askFn, opts.chartEvidence);
    out.chart = r;
    if (r.repaired || (r.contradictions && r.contradictions.length)) {
      say(' CHART_GATE: 命盘答案核验, 硬伤 '
        + (r.contradictions ? r.contradictions.length : 0) + ' 处, 重修=' + !!r.repaired);
    }
    out.text = r.text;
  } catch (e) {
    say(' CHART_GATE 异常(不阻断交付): ' + (e && e.message ? e.message : e));
  }

  return out;
}

module.exports = {
  buildAskFn,
  runAnswerGates,
};
