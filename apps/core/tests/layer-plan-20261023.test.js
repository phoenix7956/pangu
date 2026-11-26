/**
 * tests/layer-plan-20261023.test.js — 第 58 批: 分层编排
 *
 * 老板 2026-10-23 原话:
 *   「所以, 现在的盘古到底是什么情况? 要怎么处理?
 *      什么时候用阴阳五行八卦, 什么时候 64卦+6爻? 什么时候串起来用?」
 *
 * 这套判据此前**没有落点**:
 *   · 规则 #19 只讲 64 卦 —— bazi_calc / 六格判局 / 串起来, 模型一个都没被告知过
 *   · 工具描述里 gua_cast 9 个字符、bazi_calc 16 个字符 —— 等于没有说明书
 *   · 出处台账每层都登得很好, 但那是给机器看的, 模型看不见台账
 *
 * 本测试钉住三件事:
 *   ① 路由优先级 (谁压谁) —— 改顺序会静默改行为, 所以必须钉死
 *   ② 起卦跳过与否的三档 —— 包括老板报的那个真 bug(给生辰 + 明说要卦, 却没卦)
 *   ③ 生产文本: 那一行送到了模型眼前, 且带身份标签
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const M = (p) => require(path.join(CORE, p));

const LP = M('modules/layer_plan.js');
const { detectBaziIntent, evaluateGuaSkip, shouldSkipGuaCast } = M('modules/bazi_intent.js');
const { LAYER_PLAN_TAG } = M('64i/bagua_annotations/layer_plan.js');
const P = M('64i/provenance.js');

const STREAM_SRC = fs.readFileSync(path.join(CORE, 'modules', 'pangu_agent_stream.js'), 'utf8');
const RULES = M('modules/global_agent_rules.js');

// ─────────────────────────────────────────────────────────────
// ① 路由优先级
// ─────────────────────────────────────────────────────────────

test('路由: 明说排八字 → bazi (八字本身就是盘, 不叠卦)', () => {
  const p = LP.detectLayerPlan('帮我排八字 1990年3月15日 15时30分');
  assert.equal(p.route, 'bazi');
  assert.deepEqual(p.layers, ['wuxing']);
  assert.deepEqual(p.tools, ['bazi_calc']);
});

test('路由: 明说排八字时, 同一句里的「算一卦」不改变结果 (优先级定死)', () => {
  // 这条是**定死的顺序**: 明说排八字 → 不叠卦 (P1-4 原话: 两套盘打架)。
  //   哪天改成「算一卦优先」, 八字题就会多出一卦 —— 这里就是拦住那次的。
  const p = LP.detectLayerPlan('排一下八字顺便算一卦');
  assert.equal(p.route, 'bazi');
});

test('路由: 明说要卦 + 有生辰 → combo (串起来: 卦给方向, 生辰给落地)', () => {
  // 老板报的真 bug 原话:
  const p = LP.detectLayerPlan('1990年3月15日生，男，算一卦看今年财运');
  assert.equal(p.route, 'combo');
  assert.deepEqual(p.layers, ['gua', 'bridge', 'wuxing']);
  assert.deepEqual(p.tools, ['gua_cast', 'bazi_calc']);
  assert.ok(p.signals.includes('gua_request'), '要卦的信号要留着');
  assert.ok(p.signals.includes('bazi_data'), '生辰的信号要留着');
});

test('路由: 明说要卦但没生辰 → gua', () => {
  const p = LP.detectLayerPlan('算一卦看看');
  assert.equal(p.route, 'gua');
  assert.deepEqual(p.tools, ['gua_cast']);
});

test('路由: 问 64 卦本身的资料 → lookup (查表, 不是占问)', () => {
  const p = LP.detectLayerPlan('第24卦是哪一卦？请给出卦名、卦辞、上下卦');
  assert.equal(p.route, 'lookup');
  assert.deepEqual(p.tools, ['hexagram_lookup']);
});

test('路由: 只有生辰没说卦 → bazi', () => {
  const p = LP.detectLayerPlan('1990年3月15日生，男');
  assert.equal(p.route, 'bazi');
});

test('路由: 明说六格 → project (六格给结构与停点, 卦给方向)', () => {
  const p = LP.detectLayerPlan('用六格判局看这个项目');
  assert.equal(p.route, 'project');
  assert.deepEqual(p.layers, ['judge', 'gua']);
  assert.ok(p.tools.includes('wuxing_judge'));
});

test('路由: 谋断类 → gua; 闲聊/取数 → chat (兜底, 不注入那一行)', () => {
  assert.equal(LP.detectLayerPlan('这个项目该不该继续做').route, 'gua');
  assert.equal(LP.detectLayerPlan('你好').route, 'chat');
  assert.equal(LP.detectLayerPlan('帮我查一下成交量').route, 'chat');
  assert.equal(LP.detectLayerPlan('').route, 'chat');
});

test('路由: 兜底不许自己长出层来 (chat 的 layers/tools 必须为空)', () => {
  const p = LP.detectLayerPlan('随便聊聊');
  assert.equal(p.route, 'chat');
  assert.deepEqual(p.layers, []);
  assert.deepEqual(p.tools, []);
});

// ─────────────────────────────────────────────────────────────
// ② 起卦跳过与否的三档
// ─────────────────────────────────────────────────────────────

test('起卦门: 明说排八字 → 跳过起卦', () => {
  assert.equal(shouldSkipGuaCast('帮我排八字 1990年3月15日 15时30分'), true);
});

test('起卦门: 只有生辰没说卦 → 跳过起卦 (P1-4 原行为不许回归)', () => {
  assert.equal(shouldSkipGuaCast('1990年3月15日生，男'), true);
  assert.equal(shouldSkipGuaCast('1990年3月15日 卯时'), true);
});

test('起卦门: 明说要卦 → **不跳过** (老板 2026-10-23 报的真 bug)', () => {
  // 这条是本批的核心回归: 规则 #19(a) 写的是「主人明确说算一卦 → 必调」,
  //   而原来 detectBaziIntent 命中就跳过 ⇒ 主人明说要卦却没卦。
  assert.equal(shouldSkipGuaCast('1990年3月15日生，男，算一卦看今年财运'), false);
  const r = evaluateGuaSkip('1990年3月15日生，男，算一卦看今年财运');
  assert.equal(r.skip, false);
  assert.ok(r.signals.includes('gua_request'), '理由里要留得住「主人明说要卦」这个信号');
});

test('起卦门: 识别不出生辰 → 照常起卦 (只做减法, 原行为不变)', () => {
  assert.equal(shouldSkipGuaCast('帮我看下2015年3月15日的会议记录'), false);
  assert.equal(shouldSkipGuaCast('这个股票该不该买'), false);
  assert.equal(shouldSkipGuaCast(''), false);
});

test('起卦门与路由必须同一处决定 (两处各写一份必然漂)', () => {
  // 同一条输入, 路由说 combo(要卦) ⇒ 起卦门就不许跳过。
  //   这两条判据住在不同文件里, 所以这里显式钉住它们的**一致性**。
  //   不变量: **只有八字题才跳过起卦**。
  //     · bazi  → 跳过 (八字本身就是盘)
  //     · combo → 不跳过 (主人要卦, 生辰是落地材料)
  //     · 其余  → 不跳过 (查表题不起卦是**起卦门自己**的第五档管的, 不是这儿)
  const CASES = [
    '1990年3月15日生，男，算一卦看今年财运',
    '1990年3月15日生，男',
    '排一下八字顺便算一卦',
    '算一卦',
    '帮我看下2015年3月15日的会议记录',
  ];
  for (const c of CASES) {
    const route = LP.detectLayerPlan(c).route;
    const skip = shouldSkipGuaCast(c);
    assert.equal(skip, route === 'bazi',
      `两处判据打架: 「${c}」路由=${route} 跳过起卦=${skip}`);
  }
});

// ─────────────────────────────────────────────────────────────
// ③ 生产文本: 那一行送到了模型眼前
// ─────────────────────────────────────────────────────────────

test('渲染: chat 走默认那套 → 空串 (省 prefill)', () => {
  assert.equal(LP.renderLayerPlanLine(LP.detectLayerPlan('你好')), '');
  assert.equal(LP.renderLayerPlanLine(null), '');
});

test('渲染: 非默认型才出行, 且带入口与身份标签', () => {
  const line = LP.renderLayerPlanLine(LP.detectLayerPlan('第24卦是哪一卦'));
  assert.match(line, /【分层编排】/);
  assert.match(line, /hexagram_lookup/, '入口工具要写出来, 否则模型不知道调哪个');
  assert.ok(line.endsWith(LAYER_PLAN_TAG), '末尾要带身份标签');
});

test('渲染: 身份标签是**正面式**措辞 (禁令式 = 亲手把那个词喂给模型)', () => {
  for (const w of ['不要', '禁止', '不许', '勿', '不得']) {
    assert.ok(LAYER_PLAN_TAG.indexOf(w) < 0, '标签里出现了禁令式措辞: ' + w);
  }
});

test('渲染: 那一行挂在主人原话**后面** (对齐门只算主人真问的那部分)', () => {
  // modules/answer_alignment.js 的 alignmentQuestion() 会把第一处【…】之后的整段
  //   当成「给模型的话术」剔掉 ⇒ 这一行必须在主人原话后面, 否则混进「问题」里,
  //   抬高对齐门槛 (2026-10-01 踩过)。
  const i = STREAM_SRC.indexOf("userInput = userInput + '\\n\\n' + _planLine");
  assert.ok(i > 0, '分层编排那一行应该挂在 userInput 末尾');
  assert.ok(STREAM_SRC.indexOf("_planLine + '\\n\\n' + userInput") < 0,
    '这一行不许挂在 userInput 开头 —— 挂了开头, 对齐门会把主人真问的算进去');
});

test('渲染: 路由判定用**挂行之前**的 userInput (单字「卦」不许把查表题拽进 dispatcher)', () => {
  // DISPATCHER_KWS 里 '卦' 是保留的单字词条。分层编排那一行里带「卦」,
  //   拿挂了行的文本判路由, 「第24卦是哪一卦」会从 legacy 变成派子 agent
  //   (2026-10-21 修过一次, 这里不许回归)。
  //
  // 2026-10-28 (现场 web-1793124838326): 契约**收紧**成「主人原话」——
  //   原版比的是「挂行之前」那份 userInput, 但那份 userInput 里已经带了服务端
  //   自己注入的【排盘事实】/【自查纪律】块。事实块里有一句「禁止凭记忆另算十神」,
  //   而 '记忆' 就在 DISPATCHER_KWS 里 ⇒ 第 2 轮起每轮都进 dispatcher (5 分钟起)。
  //   「挂行之前」不够, 必须是「**任何注入之前**」—— 也就是 _rawUserText 快照。
  //   这里同时锁住两件事: ① 判定走 _userInputForRouting; ② 它取的是 _rawUserText。
  assert.match(STREAM_SRC, /_deps\._shouldUseDispatcher\(_userInputForRouting\)/,
    'dispatcher 门必须用挂行之前那份 userInput');
  assert.match(STREAM_SRC, /const _userInputForRouting = _rawUserText \|\| userInput;/,
    '路由判据必须是主人原话快照 (_rawUserText), 不能是服务端注入过的 userInput');
});

test('渲染: 这一行必须挂进**起卦之后** (挂早了会把占问当成查表题, 卦先于推理作废)', () => {
  const iCast = STREAM_SRC.indexOf('_formatGuaFirstBlock(_g) + userInput');
  const iPlan = STREAM_SRC.indexOf("userInput = userInput + '\\n\\n' + _planLine");
  assert.ok(iCast > 0 && iPlan > 0);
  assert.ok(iPlan > iCast, '分层编排那一行必须挂在起卦之后');
});

// ─────────────────────────────────────────────────────────────
// ④ 规则 #19 与台账
// ─────────────────────────────────────────────────────────────

test('规则 #19: 必须把四层和「串起来」讲给模型 (否则模型还是不知道有 bazi_calc)', () => {
  const r19 = RULES.RULES.find((r) => r.n === '19');
  assert.ok(r19, '找不到规则 #19');
  assert.ok(r19.worker === false, '#19 仍是主 agent 专属');
  for (const kw of ['bazi_calc', 'gua_cast', 'wuxing_judge', 'hexagram_lookup', '纳甲', '六格']) {
    assert.ok(r19.text.indexOf(kw) >= 0, '规则 #19 没提 ' + kw
      + ' —— 模型就不知道该走哪层(2026-10-23 实查: 工具描述里 gua_cast 只有 9 个字符)');
  }
});

test('规则条数仍是 27 (新增铁律要显式标 worker, 并复核分档)', () => {
  assert.equal(RULES.RULES.length, 27);
});

test('台账: 分层编排层已登记, 且「映射」那半边标 interpretive + 生产身份标签', () => {
  const layer = P.LAYERS['bagua_annotations:layer_plan'];
  assert.ok(layer, '分层编排层没登记出处');
  assert.equal(layer.kind, 'derived');
  const interp = (layer.fields || []).find((f) => f.status === 'interpretive');
  assert.ok(interp, '「什么时候用哪层」这半边必须登记, 且不能是 sourced');
  assert.ok(interp.basis && interp.reason, 'interpretive 必须写 basis 与 reason');
  assert.ok(interp.production, '这条进生产, 必须带身份标签');
  assert.equal(interp.production.marker, LAYER_PLAN_TAG);
  assert.equal(interp.production.markerConstant,
    '64i/bagua_annotations/layer_plan.js:LAYER_PLAN_TAG');
  assert.deepEqual(interp.production.renderedIn, ['modules/layer_plan.js:renderLayerPlanLine']);
});

test('台账: 「五层的判据出处」那半边必须有 sourced 引文 (有原文的部分不许含混)', () => {
  const layer = P.LAYERS['bagua_annotations:layer_plan'];
  const sourced = (layer.fields || []).find((f) => f.status === 'sourced');
  assert.ok(sourced, '判据出处那半边必须登 sourced');
  assert.ok((sourced.claims || []).length >= 4, '四个层各要一条引文');
  for (const c of sourced.claims) {
    assert.ok(c.source && c.quote && c.tokens && c.live, 'claim 四件套缺一');
  }
});

test('台账: 出处守卫全绿 (引文逐字可核 + 生产标签在渲染点函数体里)', () => {
  const r = P.assertProvenance();
  assert.ok(r.ok, '出处层报红:\n' + r.problems.join('\n'));
});

