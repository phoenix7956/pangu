/**
 * modules/layer_plan.js — 分层编排: 探测 + 生产渲染
 *
 * 起因 (老板 2026-10-23 原话, 一字不改):
 *   「所以, 现在的盘古到底是什么情况? 要怎么处理?
 *      什么时候用阴阳五行八卦, 什么时候 64卦+6爻? 什么时候串起来用?」
 *
 * 这个模块回答的就是那后半句。分两件活:
 *   ① detectLayerPlan(text)  —— 这条输入该走哪一层 (bazi / gua / lookup / combo / project / chat)
 *   ② renderLayerPlanLine(plan) —— 把「这题走哪层」拼成**一行**送给模型看
 *
 * 为什么模型必须看见这一行 (2026-10-23 实查, 三条硬证据):
 *   · 全局规则 #19 只讲了 64 卦 —— bazi_calc / 六格判局 / 串起来, **一个字没提**
 *   · 工具描述里 gua_cast 只有 9 个字符、bazi_calc 16 个字符 —— 等于没有说明书
 *     (而 li 角色 schema 已 8987/9000, 再塞就超预算)
 *   · 出处台账把每一层都登得很好, 但那是给**机器**看的, 模型看不见台账
 * ⇒ 模型从来不知道「还有一条 bazi_calc 的路」, 于是它只会起卦、只会用卦。
 *
 * 探测器的纪律 (**只做减法, 跟 modules/bazi_intent.js 一个规矩**):
 *   判不出来就落 'chat' 兜底, 由起卦门按老规矩办。探测器**只解释, 不改行为**。
 *
 * ⚠️ 为什么「项目上的事」不靠关键词猜:
 *   老板 10-21 原话「就拿八字排盘…但是这用在项目上, 加强了停顿, 走一步判断一步」——
 *   六格判据是**模型列条目**式的判断(wuxing_judge 的工具描述里已写死【何时调】),
 *   用关键词去猜「这题是不是项目题」只会两头不讨好: 猜中也要靠模型再判一次,
 *   猜错就把普通占问推进六格。所以这里只认**主人明说**(点名「六格」/「生彼泻克耗」),
 *   其余的由规则 #19 + 工具描述兜。
 */
'use strict';

const {
  LAYERS,
  ROUTES,
  LAYER_PLAN_TAG,
} = require('../64i/bagua_annotations/layer_plan.js');

const {
  isGuaFactLookup,
  isGuaCastRequest,
  isDecisionQuestion,
} = require('./gua_gate_kws.js');

const { detectBaziIntent } = require('./bazi_intent.js');

// ============================================================
// 主人明说「要六格判局」的信号 (窄口径: 只认点名, 不猜)
// ============================================================

// ⚠️ 这张表**故意很短**。往里加「项目」「计划」这类词 = 开始替模型猜「这题算不算项目题」,
//   而那正是老板 10-21 亲手否掉的做法(六格判据是模型列条目, 不是关键词)。
//   真正的判据在 wuxing_judge 的工具描述里(【何时调】那一段), 规则 #19 也会交代。
const JUDGE_REQUEST_KWS = [
  '六格', '生彼泻克耗', '五行判局', '六格判局', 'wuxing_judge',
];

// ============================================================
// 主人明说「住宅方位/风水」的信号 (窄口径: 只认风水门的专名)
// ============================================================
//
// ⚠️ 这张表为什么可以宽一点, 而 JUDGE_REQUEST_KWS 那样窄:
//   六格判据是**模型列条目**式的判断, 用关键词猜「这题算不算项目题」会两头不讨好。
//   而风水是**确定性排盘** —— 「坐北朝南的门该朝哪开」有唯一算法,
//   命中有就是风水题, 没命中就按原样办, 不会把别的题改造成风水题。
//
// ⚠️ 但**必须避开的坑**: 「方位」两个字**不能**进这张表 ——
//   「今年财运方位在哪」是八字题(有生辰), 不是风水题。
//   所以这里只认风水这一门的**专名**, 不认通用词。
const FENGSHUI_REQUEST_KWS = [
  '风水', '八宅', '大游年', '阳宅', '宅命', '宅卦', '坐山', '命卦',
  '宅运', '九运', '三元九运',
  // 口语: 主人说的是「坐北朝南」「坐向」「朝哪个方位」, 不会说「坐山」。
  //   ⚠️ 「坐向」「朝向」是**风水这一门独有的说法** —— 八字里没有「坐山」这概念。
  //   加它们不是「猜」, 是把主人真会说的那句话认出来。
  '坐向', '朝向',
];

/**
 * 「坐X朝Y」句式 —— 主人说住宅朝向时最常给的就是这一句。
 *
 * ⚠️ 为什么用**句式**而不是把「坐北朝南」等组合逐个列进词表:
 *   组合有 8×8 种(还有「坐子山午向」这种), 列不全就漏;
 *   而「坐…朝…」这个句式是**有限**的, 且只有风水/宅命这一门在用。
 *   ⇒ 认句式, 不认组合。
 */
const FENGSHUI_SITTING_RE = /坐[^，。,\s]{1,3}朝/;

/**
 * 判一条输入是不是**住宅方位**题。
 *
 * @param {string} text 主人这一轮的原话
 * @returns {{matched:boolean, signal:?string}}
 */
function detectFengshuiIntent(text) {
  const t = String(text || '').trim();
  if (!t) return { matched: false, signal: null };
  for (const k of FENGSHUI_REQUEST_KWS) {
    if (t.includes(k)) return { matched: true, signal: k };
  }
  if (FENGSHUI_SITTING_RE.test(t)) return { matched: true, signal: '坐…朝…句式' };
  return { matched: false, signal: null };
}

// ============================================================
// 探测
// ============================================================

/**
 * 判一条输入该走哪一层。
 *
 * 优先级 (从上往下, 先命中先定):
 *   1. 明说排八字        → bazi    八字本身就是盘, 不叠卦
 *   2. 明说要卦 + 有生辰 → combo   卦给方向, 生辰给落地, 纳甲搭桥
 *   3. 明说要卦          → gua     规则 19(a) 必调
 *   4. 问 64 卦本身的资料 → lookup  查表, 不是占问
 *   5. 有生辰            → bazi
 *   6. 明说六格          → project 六格给结构与停点, 卦给方向
 *   7. 明说风水/住宅方位 → fengshui 排盘, 不起卦 (第 69 批)
 *   8. 谋断类            → gua
 *   9. 其余              → chat    兜底, 按老规矩办
 *
 * ⚠️ 第 7 条为什么排在第 8 条(谋断类)**前面**:
 *   「我家坐北朝南, 门该开在哪个方位」带「该」字, 会被 decision 类命中。
 *   若 decision 先判, 一个**确定性排盘题**就被变成起卦题 ⇒ 答出来的是卦不是盘。
 *
 * 1 和 2 的顺序是**定死的**, 不是随手排的:
 *   主人明说「排八字」时, 八字本身就是盘, 再叠一个梅花卦 = 两套盘打架
 *   (P1-4 的原话)。哪怕同一句里还有「算一卦」, 也以「排八字」为准。
 *   ⇒ 「排八字顺便算一卦」→ bazi(不叠卦)。这条要钉住, 见测试。
 *
 * @param {string} text 主人这一轮的原话
 * @returns {{route:string, layers:string[], tools:string[], reason:string,
 *            signals:string[], line:string}}
 */
function detectLayerPlan(text) {
  const t = String(text || '').trim();
  const signals = [];
  if (!t) {
    return {
      route: 'chat', layers: [], tools: [],
      reason: '空输入 —— 按原行为处理', signals: [], line: '',
    };
  }

  const bazi = detectBaziIntent(t);
  const wantsBaziCalc = !!bazi.matched;
  const explicitlyAsksBazi = (bazi.signals || []).indexOf('bazi_request') >= 0;
  const explicitlyAsksGua = isGuaCastRequest(t);
  const factLookup = isGuaFactLookup(t);
  const decision = isDecisionQuestion(t);
  const wantsJudge = JUDGE_REQUEST_KWS.some((k) => t.includes(k));
  const fengshui = detectFengshuiIntent(t);

  let route = 'chat';
  let reason = '没有命中任何一条层判据 —— 按原行为处理';

  if (explicitlyAsksBazi) {
    route = 'bazi';
    reason = '主人明说排八字 —— 八字本身就是盘, 不叠卦';
    signals.push('bazi_request');
  } else if (explicitlyAsksGua && wantsBaziCalc) {
    route = 'combo';
    reason = '主人明说要卦, 又给了生辰 —— 卦给方向, 生辰给落地, 纳甲搭桥';
    signals.push('gua_request', 'bazi_data');
  } else if (explicitlyAsksGua) {
    route = 'gua';
    reason = '主人明说要卦 —— 规则 19(a) 必调';
    signals.push('gua_request');
  } else if (factLookup) {
    route = 'lookup';
    reason = '问的是 64 卦本身的资料 —— 查表, 不是占问';
    signals.push('gua_fact_lookup');
  } else if (wantsBaziCalc) {
    route = 'bazi';
    reason = '输入里有生辰 —— 八字本身就是盘, 不叠卦';
    signals.push('bazi_data');
  } else if (wantsJudge) {
    route = 'project';
    reason = '主人点名要六格判局 —— 六格给结构与停点, 卦给方向';
    signals.push('judge_request');
  } else if (fengshui.matched) {
    // ⚠️ 位置要紧: 必须在 decision **前面** ——
    //   风水题常带「该」字(「门该开在哪」), 若先判 decision 就会被"谋断类 ⇒ gua"抢走,
    //   把一个**确定性排盘题**变成起卦题 ⇒ 答出来的是卦不是盘。
    route = 'fengshui';
    reason = '主人说的是住宅方位 —— 走风水排盘, 不起卦';
    signals.push('fengshui_request:' + fengshui.signal);
  } else if (decision) {
    route = 'gua';
    reason = '谋断类问题 —— 卦给方向';
    signals.push('decision');
  }

  const r = ROUTES[route];
  return {
    route,
    layers: (r && r.layers) || [],
    tools: (r && r.tools) || [],
    reason,
    signals,
    line: renderLayerPlanLine({ route, layers: (r && r.layers) || [], tools: (r && r.tools) || [], reason }),
  };
}

// ============================================================
// 生产渲染 (模型看得见的那一行)
// ============================================================

/**
 * 拼「这题走哪层」那一行。**这是生产层渲染点** —— 台账 P12 守卫查的就是这里。
 *
 * 为什么用【…】包起来: modules/answer_alignment.js 的 alignmentQuestion() 会把
 *   第一处【…】之后的整段当成「给模型的话术」剔掉 —— 这一行挂在主人原话**后面**,
 *   于是对齐门算「问题」时只算主人真问的那部分, 不会被这一行污染。
 *
 * @param {object} plan 探测结果
 * @returns {string} 空串 = 这题走默认那套(占问), 不用特别交代
 */
function renderLayerPlanLine(plan) {
  if (!plan || !plan.route) return '';
  const r = ROUTES[plan.route];
  if (!r || r.id === 'chat') return '';
  const names = (plan.layers || []).map((k) => (LAYERS[k] ? LAYERS[k].name : k));
  const parts = ['【分层编排】这题走「' + r.label + '」'
    + (names.length ? ' = ' + names.join(' + ') : '')];
  if (r.tools && r.tools.length) parts.push('入口 ' + r.tools.join(' / '));
  if (r.note) parts.push(r.note);
  if (plan.reason) parts.push('判据: ' + plan.reason);
  return parts.join(' | ') + LAYER_PLAN_TAG;
}

module.exports = {
  JUDGE_REQUEST_KWS,
  FENGSHUI_REQUEST_KWS,
  FENGSHUI_SITTING_RE,
  detectLayerPlan,
  detectFengshuiIntent,
  renderLayerPlanLine,
  LAYERS,
  ROUTES,
  LAYER_PLAN_TAG,
};
