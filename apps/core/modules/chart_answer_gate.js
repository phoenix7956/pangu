'use strict';
// chart_answer_gate.js — 命盘类答案的出门核验门 (2026-10-12, 老板拍"你没有修好")。
//
// 背景: bazi_chart_facts 的事实块只能覆盖"文字里已有四柱"的轮次 (追问轮)。
// 首轮纯图做题时文字里没有四柱, 事实块注不进去 —— 第一稿的十神标注仍是模型凭记忆算,
// 实测把 戊=伤官 写成食神 (e2e-812 T1)。修: 出门闸 —— 答案定稿后、上屏前,
// 本地查表核验 → 有硬伤就带事实块+硬伤清单强制重修一轮;
// 重修仍有硬伤 → 附诚实标注交付, 带病答案不许原样出门。
//
// 2026-10-21 (第六批 · 两把刀合一): **核验基准从"答案自己"换成"工具给的盘"**。
//   原来从答案文本里抽四柱当基准 —— 也就是**拿答案验答案**, 两种翻车都实测过:
//     ① 抽错盘: 全文散着干支时抓到流年/别处的干支当本命柱 (gate-004 那次差点把对的改废)
//     ② 抽不出: 首轮纯图题答案没抄全四柱 → 门直接不响 (checked=false), 模型的错没人拦
//   而盘古在这件事上本来就有唯一真源: sxtwl 万年历 (bazi_calc 的 data.pillars.pillars)。
//   所以现在: 有权威盘就用它当基准, 没有才退回旧的"从答案抽"。
//
//   同时把 chart_fidelity 的柱位保真接了进来 —— 它原来**只留痕不改答案**
//   (单看它的哲学是对的: 文本级判定必有误报, 拿它硬拦会把真结论判死)。
//   但"答案说月柱辛未、工具算的是癸未"不是模糊判定, 是**拿工具真值就能定死**的事实:
//   与其留痕等人看, 不如当硬伤进重修。所以这里只在**有权威盘**时把柱位不一致算硬伤。
//   本轮算出多张不同的盘 (合婚/双人对比) 一律退回旧路 —— 单盘的尺子量不了两盘答案。
//
// 只有检出硬伤才多花一次 LLM 调用; 答对了零开销。

const det = require('./bazi_chart_facts');
const fid = require('./chart_fidelity');
// 2026-10-21 (第九批): 重修那一段抽到 modules/fact_repair.js 与卦象门共用。
//   这段逻辑里有一个已经栽过的判据(绝对 40 字下限把正确重修判死), 栽一次就得全项目长记性,
//   抄两份必然会漂。原委见 fact_repair.js 顶部注释。
const { repairWithFacts, withWarning } = require('./fact_repair');

// askFn: async (promptText) => text — 调用方传适配器 (legacy 与 dispatcher 的 LLM 返回结构不同)
// toolResults: 可选。本轮工具结果 (sub-agent 的 data.toolHistory / j2 loop 的排盘证据)。
//   给了就有机会用 sxtwl 权威盘当基准; 没给就走旧路 (抽不出就不判), 不误伤。
async function verifyAndRepairChartAnswer(answerText, askFn, toolResults) {
  const text = String(answerText || '');
  if (!text || typeof askFn !== 'function') return { text, checked: false, repaired: false, contradictions: [], source: 'none' };
  try {
    const charts = fid.collectAuthoritativeCharts(toolResults);
    // 多张不同的盘 = 本轮在比两个人的命 (合婚/双人对比), 权威盘跟答案里的柱对不上号。
    // 这种轮次宁可不判 —— 拿单盘的尺子量两盘答案, 整片误报。
    const auth = charts.length === 1 ? charts[0] : null;
    const found = auth
      ? { pillars: [auth['年柱'], auth['月柱'], auth['日柱'], auth['时柱']], source: 'sxtwl' }
      : det.extractPillars(text);
    if (!found) return { text, checked: false, repaired: false, contradictions: [], source: 'none' };

    const contradictions = det.findChartContradictions(text, found.pillars);
    // 权威盘在场时, 柱位不一致也算硬伤 (fidelity 原来只留痕)。
    // 只在权威盘在场时做 —— 没权威盘就没有"哪个柱才对"的答案, 判定会退化成文本猜测。
    if (auth) {
      for (const x of fid.check(text, toolResults).mismatches) {
        contradictions.push({ claim: x.position + '写成' + x.said, expect: x.position + '真值 ' + x.expected });
      }
    }
    if (!contradictions.length) {
      console.log('[CHART_GATE] checked clean, pillars=' + found.pillars.join(' ') + ' (source=' + (found.source || 'answer') + ')');
      return { text, checked: true, repaired: false, contradictions: [], source: found.source || 'answer' };
    }
    console.log('[CHART_GATE] contradictions=' + contradictions.length + ' (source=' + (found.source || 'answer') + ') -> repair round; first: ' + contradictions[0].claim);

    const factsBlock = det.buildFactsBlock(found.pillars);
    const sxtwlNote = auth
      ? '\n\n四柱以本事实块为准: 那是 sxtwl 万年历实算的结果。草稿里与之不同的柱位是模型自己改写的, 必须改回事实块里的写法, 不许迁就草稿。'
      : '';
    const findResidual = (t) => {
      const r = det.findChartContradictions(t, found.pillars);
      // 柱位不一致要在重修稿上**再核一遍** —— 模型常常把十神改对了, 柱还是抄错的。
      if (auth) {
        for (const x of fid.check(t, toolResults).mismatches) {
          r.push({ claim: x.position + '写成' + x.said, expect: x.position + '真值 ' + x.expected });
        }
      }
      return r;
    };
    const out = await repairWithFacts({
      draft: text,
      contradictions,
      factsBlock,
      truthNote: sxtwlNote.trim(),
      label: 'CHART_GATE',
      ask: askFn,
      findResidual,
    });
    if (!out.repaired) {
      return { text: withWarning(text, contradictions, '重修失败'), checked: true, repaired: false,
        contradictions, source: found.source || 'answer' };
    }
    if (out.residual.length) {
      return { text: withWarning(out.text, out.residual, '重修稿仍有不一致'), checked: true, repaired: true,
        contradictions, residual: out.residual, source: found.source || 'answer' };
    }
    return { text: out.text, checked: true, repaired: true, contradictions, source: found.source || 'answer' };
  } catch (_) {
    return { text, checked: false, repaired: false, contradictions: [], source: 'none' };
  }
}

module.exports = { verifyAndRepairChartAnswer };
