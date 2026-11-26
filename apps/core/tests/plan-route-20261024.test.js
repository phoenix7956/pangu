'use strict';
/**
 * tests/plan-route-20261024.test.js
 *
 * 第 78 批: 拆解轮结论 → **走哪条路**的判据。
 *
 * ## 为什么要有这一条
 *   实跑 probe76-multi (桌面端真主路):
 *     主 agent (乾) 判「拆不动」, 原话:
 *       「拆不动。这是一条线性链（建 3 文件 → 逐个读回 → 写 summary.txt）,
 *         三步互相依赖、同一目录, 拆了反而要排队等依赖, 不如一口气做完。」
 *     ⇒ 这个判断是**对的**。而 dispatcher 转头用规则拆分器把它切成 3 刀:
 *       kun「创建 3 个文件」→ kun「每个写入不同的中文」→ dui「逐个读回确认」
 *     现场代价: 第 2 刀**不自足** ⇒ 子 agent 把三个文件**又写了一遍**
 *     (两轮内容不同, 第二轮覆盖第一轮); 三刀还靠 depends_on **串行**, 并行一分没换到。
 *
 *   ⇒ 规则拆分器的定位是「**planner 被打挂、没人拆**」时的兜底,
 *     不是「有人已经拆过了」的兜底。主 agent 判过「拆不动」, 它就不该上。
 *
 * ## 这条测试判什么
 *   ① 判据与分类**同源**: 住在 modules/plan_verdict.js, 不许在 dispatcher 里另写一份;
 *   ② 「拆不动」(A) ⇒ 不许用规则拆分;
 *   ③ 其它态 (B/other/empty) ⇒ 照旧能用;
 *   ④ dispatcher 真的调的是这个判据 (不许自己写个 kind === 'A')。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const pv = require('../modules/plan_verdict.js');

const DISPATCHER = path.join(__dirname, '..', 'modules', 'j2_dispatcher.js');
const SRC = fs.readFileSync(DISPATCHER, 'utf8');

// --------------------------------------------------------------------------
// 1. 现场夹具: 判据 + 后果, 一条不许错
// --------------------------------------------------------------------------

const ROUTES = [
  {
    id: 'r1',
    kind: 'A',
    useDeterministicSplit: false,
    why: '实跑 probe76-multi: 主 agent 判「拆不动 / 一口气做完」—— 规则拆分不许推翻它',
  },
  {
    id: 'r2',
    kind: 'B',
    useDeterministicSplit: true,
    why: 'B 类在 dispatcher 里提前走澄清路返回了, 根本到不了这里; 但判据本身不许误伤',
  },
  { id: 'r3', kind: 'other', useDeterministicSplit: true, why: '主 agent 没表态 → 原路不变' },
  { id: 'r4', kind: 'empty', useDeterministicSplit: true, why: '拆解轮没留下正文 → 原路不变' },
  { id: 'r5', kind: '', useDeterministicSplit: true, why: '压根没跑拆解轮 → 原路不变' },
];

test('现场夹具: 每条结论对应的路由都对', () => {
  const wrong = [];
  for (const r of ROUTES) {
    const got = pv.shouldUseDeterministicSplit(r.kind);
    if (got !== r.useDeterministicSplit) {
      wrong.push(r.id + '(' + r.kind + ') 期望 ' + r.useDeterministicSplit + ' 实得 ' + got);
    }
  }
  assert.deepStrictEqual(wrong, [], '判错的: ' + wrong.join(' | '));
});

test('判据接受 verdict 对象, 不接受它的 kind 串 (两种写法结果必须一样)', () => {
  for (const r of ROUTES) {
    assert.strictEqual(
      pv.shouldUseDeterministicSplit({ kind: r.kind }),
      pv.shouldUseDeterministicSplit(r.kind),
      r.id + ' 两种写法结果不一致'
    );
  }
});

test('「拆不动」不许用规则拆分 —— 这条的代价是主人看了一轮重复劳动', () => {
  assert.strictEqual(pv.shouldUseDeterministicSplit('A'), false);
  assert.strictEqual(pv.shouldUseDeterministicSplit({ kind: 'A' }), false);
});

test('没表态不许被误伤 (规则拆分器是 planner 被打挂时的唯一兜底)', () => {
  for (const k of ['other', 'empty', '', 'B', 'A ']) {
    assert.strictEqual(pv.shouldUseDeterministicSplit(k), true, 'kind=' + JSON.stringify(k) + ' 被误伤了');
  }
});

// --------------------------------------------------------------------------
// 2. dispatcher 必须用这个判据 (不许自己写一份)
// --------------------------------------------------------------------------

test('dispatcher 调的是 plan_verdict 的真源, 不许自己写 kind === "A"', () => {
  assert.match(
    SRC,
    /shouldUseDeterministicSplit\(/,
    'dispatcher 没调 plan_verdict.shouldUseDeterministicSplit —— 判据被抄走了一份'
  );
  assert.match(
    SRC,
    /_mainSaidNoSplit\s*=\s*!_pvRoute\.shouldUseDeterministicSplit\(/,
    '守卫用的不是真源函数的返回值'
  );
});

test('确定性拆分那块必须被 _mainSaidNoSplit 挡住 (反向护栏)', () => {
  // 用**真语法树**找每一个 splitTask 调用点, 判它落在哪种上下文里:
  //   ① catch 子句 (planner 被打挂) —— 合法, 规则拆分器就是给这一路兜底的;
  //   ② 带 _mainSaidNoSplit 守卫的 if —— 主 agent 说「拆不动」时这一路必须被挡住;
  //   ③ 其它任何地方 —— **不合法** (主 agent 的判断会被规则拆分推翻)。
  const ast = require('./helpers/js_ast.js');
  const tree = ast.parseJsFile(DISPATCHER);
  const calls = ast.callSites(tree, 'splitTask');
  assert.ok(calls.length >= 1, '一个 splitTask 调用点都找不到 —— 判据锚点没了');

  // _fastPlanFor 是**规则快路** (主 agent 之前那条), 它在别的函数里 ——
  // 它的 splitTask 调用点合法, 不能跟共享兜底那条混为一谈。
  const fastRange = ast.functionRange(tree, '_fastPlanFor');
  assert.ok(fastRange, '找不到 _fastPlanFor —— 判据锚点没了');

  const wrong = [];
  for (const c of calls) {
    if (c.node.startIndex >= fastRange.start && c.node.endIndex <= fastRange.end) continue;
    let ifCond = null;
    let inPlannerFailCatch = false;
    for (let n = c.node.parent; n; n = n.parent) {
      if (!ifCond && n.type === 'if_statement') {
        const cond = n.childForFieldName('condition');
        ifCond = cond ? cond.text : '';
      }
      if (n.type === 'catch_clause' && /planner 失败/.test(n.text)) {
        inPlannerFailCatch = true;
      }
    }
    const guarded = !!(ifCond && ifCond.includes('_mainSaidNoSplit'));
    if (!guarded && !inPlannerFailCatch) {
      wrong.push('第 ' + c.line + ' 行的 splitTask 既不在 planner 失败的兜底里, '
        + '也不在 _mainSaidNoSplit 守卫里');
    }
  }
  assert.deepStrictEqual(wrong, [], '守卫漏了: ' + wrong.join(' | '));
});

test('规则快路 (_fastPlanFor) 只在 A 分支的 else 里, A 分支够不着它', () => {
  // 结构: if (主 agent 自拆 ≥2 刀) {...} else if (B) {...} else if (A) {...} else { ...规则快路... }
  // A 分支是**中间那条**, 它只能往下落到共享兜底 (那里有 _mainSaidNoSplit 守卫),
  // 规则快路在**最后的 else** 里 —— A 分支走不到, 所以「拆不动」不会被规则快路推翻。
  const ast = require('./helpers/js_ast.js');
  const tree = ast.parseJsFile(DISPATCHER);

  let chain = null;
  (function walk(n) {
    if (chain) return;
    if (n.type === 'if_statement') {
      const cond = n.childForFieldName('condition');
      if (cond && cond.text.includes("_planVerdict.kind === 'A'")) { chain = n; return; }
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i));
  })(tree.rootNode);
  assert.ok(chain, '找不到 A 分支的 if —— 判据锚点没了');

  const consequence = chain.childForFieldName('consequence');
  const alternative = chain.childForFieldName('alternative');
  assert.ok(consequence, 'A 分支没有 body —— 判据锚点没了');
  assert.ok(alternative, 'A 分支后面没有 else —— 规则快路可能被 A 分支走到');

  const fastCalls = ast.callSites(tree, '_fastPlanFor');
  assert.ok(fastCalls.length >= 1, '找不到 _fastPlanFor 的调用点 —— 判据锚点没了');
  for (const c of fastCalls) {
    assert.ok(
      c.node.startIndex >= alternative.startIndex && c.node.endIndex <= alternative.endIndex,
      '第 ' + c.line + ' 行的 _fastPlanFor 调用不在 A 分支的 else 里 —— '
      + '主 agent 判「拆不动」时也可能被规则快路抢跑'
    );
    assert.ok(
      !(c.node.startIndex >= consequence.startIndex && c.node.endIndex <= consequence.endIndex),
      '第 ' + c.line + ' 行的 _fastPlanFor 调用落在 A 分支 body 里 —— 拆不动会被规则拆推翻'
    );
  }
});

test('A 分支 body 里不许有派发调用 (「拆不动」= 一件事, 不许拆成多刀)', () => {
  const ast = require('./helpers/js_ast.js');
  const tree = ast.parseJsFile(DISPATCHER);

  let chain = null;
  (function walk(n) {
    if (chain) return;
    if (n.type === 'if_statement') {
      const cond = n.childForFieldName('condition');
      if (cond && cond.text.includes("_planVerdict.kind === 'A'")) { chain = n; return; }
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i));
  })(tree.rootNode);
  assert.ok(chain, '找不到 A 分支的 if —— 判据锚点没了');

  const body = chain.childForFieldName('consequence');
  assert.ok(body, 'A 分支没有 body —— 判据锚点没了');

  for (const bad of ['subAgent.run(', 'createSubagentRunner(', 'subTasks.push(']) {
    assert.ok(
      !body.text.includes(bad),
      'A 分支里出现了「' + bad + '」—— 主 agent 判「一件事就完」时不该再派刀'
    );
  }
});

