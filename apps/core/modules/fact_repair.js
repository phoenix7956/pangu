'use strict';
// fact_repair.js — 事实核验门共用的「重修」那一段 (2026-10-21, 第九批拆出来的)
//
// 为什么拆: 命盘门 (chart_answer_gate) 和卦象门 (gua_answer_gate) 要做的事是同一件 ——
//   拿本地查表真源当基准 → 检出硬伤 → 带硬伤清单重修一轮 → 再核 → 还有残余就附诚实标注出门。
// 差别只有"事实块长什么样"和"残余怎么再核"。那段**逻辑**不该抄两份 ——
// 抄两份就会漂, 而这段逻辑里恰好有一个已经栽过一次的判据(见下), 栽一次就得全项目长记性。
//
// 2026-10-21 (第七批): "repair failed (empty/short)" 用**绝对** 40 字下限判失败,
//   实测把**正确**的重修判死了 —— 草稿 30 字, 模型返回 30 字的正确重修, 被判失败,
//   真答案被换成"原稿 + ⚠️ 重修失败"。**守卫自己把好答案判死。**
//   与 P0-3「耗的方向反了」同一个错误类型: 拿一个没量过的常数当判据。
//   现在改成**相对**原稿长度, 并且把长度/floor/attempts 全打出来 ——
//   原来只留一句 empty/short, 下次同类问题又得从头查一遍。

const REPAIR_MIN_RATIO = 0.4;
const REPAIR_MIN_FLOOR = 10;

/** 重修稿的合格线: 与原稿成比例, 地板 10 字(只拦真正的空回执)。 */
function repairFloor(draftLen) {
  return Math.max(REPAIR_MIN_FLOOR, Math.floor(draftLen * REPAIR_MIN_RATIO));
}

/**
 * 跑一轮「带硬伤清单的重修」。
 *
 * @param {object}   o
 * @param {string}   o.draft        原稿全文(要改的那份)
 * @param {Array}    o.contradictions 硬伤清单 [{claim, expect}]
 * @param {string}   o.factsBlock    事实块正文(本地查表结果, 直接采信)
 * @param {string}   o.truthNote     关于"以哪个为准"的额外说明, 可空
 * @param {string}   o.label         日志前缀, 如 'CHART_GATE' / 'GUA_GATE'
 * @param {Function} o.ask           async (prompt) => text
 * @param {Function} o.findResidual  async? (text) => [{claim, expect}] 残余再核
 * @returns {Promise<{text:string, repaired:boolean, residual:Array, attempts:number}>}
 */
async function repairWithFacts(o) {
  const draft = String(o.draft || '');
  const contradictions = Array.isArray(o.contradictions) ? o.contradictions : [];
  const ask = o.ask;
  const label = o.label || 'FACT_GATE';
  const floor = repairFloor(draft.length);

  const base = '你的上一稿答复有以下与本地查表真源矛盾的硬伤 (不是模型意见, 是查表结果):\n'
    + contradictions.map((c, i) => (i + 1) + '. 草稿说「' + c.claim + '」, 查表真值: ' + c.expect).join('\n')
    + '\n\n' + o.factsBlock
    + (o.truthNote ? '\n\n' + o.truthNote : '')
    + '\n\n请输出修正后的完整答复: 只改与事实矛盾的部分, 其余保持草稿的结构与判断; '
    + '一切以事实块为准, 不许再凭记忆另算。\n\n【草稿原文】\n' + draft;

  let repaired = String(await ask(base) || '').trim();
  let attempts = 1;
  if (repaired.length < floor) {
    // 只回一句"已修正"就收工 → 把长度闸和原稿长度都摆明, 再给一次机会。
    // 只在这条罕见路径上多花一次调用(要先有硬伤才会走到)。
    console.log('[' + label + '] repair short (' + repaired.length + ' < ' + floor + '), retry once with explicit length floor');
    const hardPrompt = base
      + '\n\n【重要 · 上一稿不合格】你上一轮只回了 ' + repaired.length + ' 个字符, 低于长度闸 ' + floor
      + ' 字符, 会被判重修失败。必须输出**完整答复正文**, 体量不得少于原稿 ('
      + draft.length + ' 字符) 的四成, 直接给正文 —— 不许只回"已修正""已按事实块改好"这类回执, 不许只给改后的片段。';
    try {
      const second = String(await ask(hardPrompt) || '').trim();
      attempts = 2;
      // 第二次更短就别换: 短的至少是模型的意图, 换更短的只会更糟。
      if (second.length > repaired.length) repaired = second;
    } catch (e) {
      console.warn('[' + label + '] repair retry threw: ' + (e && e.message));
    }
  }

  if (repaired.length < floor) {
    // 把长度/floor/attempts/原稿规模都记下来 —— 原来只留一句 empty/short, 事后没法判断。
    console.log('[' + label + '] repair failed (len=' + repaired.length + ' < floor=' + floor
      + ', attempts=' + attempts + ', draft=' + draft.length + '), delivering with warning');
    return { text: draft, repaired: false, residual: contradictions, attempts };
  }

  const residual = typeof o.findResidual === 'function' ? (await o.findResidual(repaired)) || [] : [];
  if (residual.length) {
    console.log('[' + label + '] residual=' + residual.length + ' after repair, delivering with note');
    return { text: repaired, repaired: true, residual, attempts };
  }
  console.log('[' + label + '] repaired clean (len=' + repaired.length + ' floor=' + floor
    + ' attempts=' + attempts + ')');
  return { text: repaired, repaired: true, residual: [], attempts };
}

/** 附诚实标注: 门不许让带病答案静默出门, 但也不许把整段重写。 */
function withWarning(base, list, kind) {
  return base + '\n\n⚠️ 本地查表核验发现以上答复有 ' + list.length + ' 处与真源矛盾 ('
    + list.slice(0, 3).map(c => c.claim).join('、') + '), ' + kind + ', 请以查表事实为准。';
}

module.exports = { repairWithFacts, repairFloor, withWarning, REPAIR_MIN_RATIO, REPAIR_MIN_FLOOR };
