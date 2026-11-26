// modules/chart_verify_guard.js — 拦住"自己不信自己的排盘" (2026-10-21)
//
// 现场 (E2E 实跑, 同一条输入「1990-7-22 14:00 女 排八字」):
//   bazi_calc 一次就把完整的盘给了 —— 庚午 癸未 戊子 己未, 外加六格判断。
//   然后模型干了这些:
//     r5:  exec_command ×16  满世界 find/grep 判据出处的文件
//     r7:  exec_command `python3 -c "import sxtwl; d=sxtwl.fromSolar(1990,7,22); ..."
//          bazi_calc(1949-10-01) / bazi_calc(2026-10-21)  ← 两次都是编的日期
//          web_search「1990年7月22日 干支 壬午日 八字」
//          web_fetch huangli.com / buyiju.com / api.vvhan.com
//          → 180 秒超时, **连 final 都没有**
//     r8:  同样一路, 13 次工具调用, 同样没有 final
//
// 它在干什么: **交叉核对一张它已经拿到的盘**。
//   这不是能力问题, 是姿态问题 —— 它把工具输出当成"待证实的东西",
//   不当成"结论"。于是每一次工具调用都在烧钱烧时间, 而且多数轮跑不到收口。
//   r5/r7/r8 三轮里两轮**根本没出答案** —— 那比答案写错更糟。
//
// 为什么判据层接进来之后这更要命:
//   判据 (wuxing_strength.js) 是照着**工具给的盘**算的。
//   模型如果不信那张盘而是自己另算/另查, 后面"哪一格不成立""喜忌如何"
//   整套推断就建在一张**它自己都没真正核过的**盘上 ——
//   而且因为判据层本身权威, 错得更有欺骗性。
//
// 边界 (宁可不拦, 不可乱拦):
//   - 只在**本轮已经成功调过确定性排盘工具**时才生效。没有盘 → 一律不拦。
//   - 只拦**外部核算** (自己跑 sxtwl / 上网查干支 / 找别的 agent 要盘)。
//   - **不拦 bazi_calc 本身** —— 用户问别的年份时换日期再调一次是正当路径,
//     而且是 tools_schema 里明写的能力。把它拦了等于自断手脚。
//   - 只拦"**算/查/核对**干支", 不拦"grep 一个提到八字的笔记文件"。
'use strict';

// 确定性排盘/起卦工具 —— 它们的结果是本轮唯一真源。
const CHART_TOOLS = new Set(['bazi_calc', 'gua_cast']);

// 外部核算的"工具指纹": 直接调库、找盘、查表。
// - sxtwl/fromSolar/getYearGZ…: 自己拿 python 重算一遍, r7 原样
// - *bazi*/bazi_calc.py: 满世界找排盘实现, r5/r8 原样
// - ganzhi/bazi/huangli/wannianli: 外部万年历站点的 slug, r7/r8 原样
const RECOMPUTE_RE = /(sxtwl|fromsolar|getyeargz|getmonthgz|getdaygz|gettimegz|bazi_calc\.py|\*bazi\*|bazi_calc|python3?\s+-c)/i;
const EXTERNAL_SLUG_RE = /(ganzhi|bazi|huangli|wannianli|黄历|万年历)/i;

// "就干支这个**事实**去查/核对" —— 动词词表里**不能有「排」**:
//   「排盘」「排八字」本身就是主题词, 拿它当动词会让 news_digest{keyword:'排盘'}
//   这类正常调用也被当成"在核算盘"。动词只留真正的动作词。
//   "第二个词是必需的。
//   "grep 八字 ~/笔记.md" 里只有八字, 没有查/核对 → 不拦。
//   "web_search 1990年7月22日 干支 八字" 两个都有 → 拦。
const LOOKUP_VERB_RE = /(算|查|核对|核验|验证|确认|重新|再算|复查|cross.?check|verify|calc|compute|convert)/i;
const SUBJECT_RE = /(八字|四柱|干支|排盘|生辰|命盘|五行旺衰)/;

/**
 * 本轮有没有已经成功的确定性排盘结果。
 * @param {Array} toolHistory
 * @returns {Array} 命中的工具名 (空数组 = 没有盘, 不拦)
 */
function succeededChartTools(toolHistory) {
  const list = Array.isArray(toolHistory) ? toolHistory : [];
  return list.filter(t => t && t.ok === true && CHART_TOOLS.has(t.name)).map(t => t.name);
}

/**
 * 这次调用是不是"去核算一张已经有的盘"。
 *
 * @param {string} name 工具名
 * @param {object} args 参数
 * @returns {{blocked:boolean, why:string}}
 */
function inspect(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  // 一律不拦排盘/起卦本身 —— 换日期重排是正当且被 schema 明确支持的用法
  if (CHART_TOOLS.has(name)) return { blocked: false, why: '' };

  // 把参数里能当文本看的都摊平: command / q / query / url / pattern / path / reason
  const parts = [
    a.command, a.q, a.query, a.url, a.pattern, a.path, a.reason, a.keyword, a.patterns,
  ].filter(v => typeof v === 'string');
  const text = parts.join(' ');
  if (!text) return { blocked: false, why: '' };

  // ① 直接重算 / 找实现 —— 不需要第二个关键词, 意图已经足够明确
  if (RECOMPUTE_RE.test(text)) {
    return { blocked: true, why: '自己去重算/找排盘实现 (命中 ' + (String(text).match(RECOMPUTE_RE) || [''])[0] + ')' };
  }

  // ② 光一个"外部干支站 + 具体某天"就足够说明意图, 不管是 web_fetch 还是 curl。
  //     实跑原话: huangli.com/ganzhi/1990-07-22.html、
  //               api.vvhan.com/api/ganzhi?date=1990-07-22。
  //     要求同时带日期 —— 否则一篇讲干支的文章也会被误伤。
  const DATE_RE = /\d{4}-?\d{2}-?\d{2}|\d{8}/;
  if (EXTERNAL_SLUG_RE.test(text) && DATE_RE.test(text)) {
    return { blocked: true, why: '去外部万年历站点取同一张盘' };
  }

  // ②b web_search: 工具名本身就是"查", 搜索框里从来不写动词
  //     (实跑那句「1990年7月22日 干支 壬午日 八字」一个动词都没有,
  //      第一版按"必须有动词"筛, 反而把最典型的那次放过去了)。
  //     这里只认主题词 —— 手里已经有盘还要搜八字/干支/排盘, 就是在核对。
  if (name === 'web_search' && SUBJECT_RE.test(text)) {
    return { blocked: true, why: '上网搜同一张盘' };
  }

  // ③ 找别的 agent 要盘 (r8 实跑: list_pangu_agents + "有没有专门排盘的 agent")
  //    **只对"找 agent"这一类工具开** —— 第一版对所有工具都开这条,
  //    结果 "grep 八字 ~/笔记.md" 和 "news_digest 排盘" 全被按头。
  //    找 agent 才是"绕过排盘工具去别处拿盘", 读文件不是。
  //    排在 ②c 前面, 是为了让日志里的理由说的是真话。
  if (/list_pangu_agents|dispatch_subagents|ask_agent/.test(name)
    && /排盘|八字|干支|命盘|术数/.test(text)) {
    return { blocked: true, why: '去找别的 agent 要盘' };
  }

  // ②c 其它工具里提到干支主题 + 确实在算/查 → 拦
  if (SUBJECT_RE.test(text) && LOOKUP_VERB_RE.test(text)) {
    return { blocked: true, why: '去核算同一张盘' };
  }

  return { blocked: false, why: '' };
}

/**
 * 给模型看的回灌文案。
 *
 * ⚠️ 措辞是有讲究的, 而且是被 2026-10-21 实跑教会的:
 *   第一版写的是「不要去验证排盘」—— 结果模型照样去验证了,
 *   因为它从这句里学到的关键词是"验证/核实", 不是禁令。
 *   所以这里**只说已经有了什么、该干什么**, 一个"别"字都不出现。
 *   （同一个教训在 bazi_calc 的 note 上已经栽过一次: 写了「不要因为看不到
 *     就改口说流月数据缺失」, 模型转头就写「流年明细未取到」。）
 *
 * @param {string[]} chartTools 本轮已成功的排盘工具
 * @param {number} blocks 到目前为止被拦了几次
 * @param {string} why 这次为什么被拦
 * @returns {string}
 */
function message(chartTools, blocks, why) {
  const head = '[系统: 盘已经在这儿了] 本轮 ' + chartTools.join('/') + ' 已经算出完整的盘, '
    + '四柱、藏干、十神、纳音、五行六格判断、大运、流年都在上面, 那就是本轮唯一真源。';
  if (blocks >= 2) {
    return head
      + '这次调用(' + why + ')不执行, 它只会重复上面已有的结果。'
      + '**现在就按已给的盘给主人完整答复**, 不必再调任何工具 —— '
      + '盘上有的照盘讲, 盘上没有的如实说没有, 两条都算答完。';
  }
  return head
    + '这次调用(' + why + ')不执行, 它重复不了新东西。'
    + '直接按上面的盘作答; 主人问其它年份或另一张盘, 用同一个排盘工具换日期再调一次就够了。';
}

module.exports = { CHART_TOOLS, succeededChartTools, inspect, message };
