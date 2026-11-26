'use strict';
// 出门核验门收成唯一实现 (2026-10-23 第 60 批)
//
// 起因是量出来的:
//   j2_dispatcher.js 有 `_factGate()`, 5 个调用点都走它, 注释里明写
//   「出门只有一道闸, 以后加第三种断言(梅花/六壬/奇门)也只改一处,
//     不会出现『新门忘了接到某个调用点』」。
//   而 j2_agent_loop.js:5038 附近**另有一份内联拷贝**, 没走那个函数 ——
//   上面那条设计意图, 正是被这份拷贝正面违反的。
//
// 两份已经漂了(不是「将来会漂」, 是现在):
//   日志条件  : _factGate 只在 repaired 时打; loop 那份在 repaired||有矛盾 时打
//   ask 回调  : loop 那份带 soulScope, _factGate 不带
//   结果      : 「查出来有硬伤但重修没改掉」这种最该被看见的情况,
//               在只认 repaired 的那份里静悄悄 —— 而那正是第 8 批实跑里
//               盘古把「第24卦」答成贲卦、把复卦写成「雷地复」的那一类。
//
// 本批把「跑哪几道门、按什么顺序、怎么记日志、异常怎么办」收成
// modules/answer_gates.js 一份, 调用点只提供证据和 ask。
//
// 判官的老教训照旧: **绿灯是结果, 咬人才是证据**。每条护栏都有对应负例。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const GATES = path.join(CORE, 'modules', 'answer_gates.js');
const DISPATCHER = path.join(CORE, 'modules', 'j2_dispatcher.js');
const LOOP = path.join(CORE, 'modules', 'j2_agent_loop.js');
const readCode = (p) => fs.readFileSync(p, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const dispCode = readCode(DISPATCHER);
const loopCode = readCode(LOOP);
const gatesCode = readCode(GATES);

// (1) 唯一实现

test('A1 两道门只有 answer_gates 一个编排方 (没有第二份内联拷贝)', () => {
  // 真源里调这两道门 —— 就这一处。
  assert.match(gatesCode, /verifyAndRepairGuaAnswer/);
  assert.match(gatesCode, /verifyAndRepairChartAnswer/);
  // 两个调用点都不许自己调门。注释里提到不算(已剥)。
  for (const [name, src] of [['j2_dispatcher', dispCode], ['j2_agent_loop', loopCode]]) {
    assert.doesNotMatch(src, /verifyAndRepairGuaAnswer|verifyAndRepairChartAnswer/,
      `${name} 里还有自己调门的代码 —— 第二份编排, 迟早只改其中一处`);
    assert.match(src, /runAnswerGates/,
      `${name} 没走唯一真源 answer_gates.runAnswerGates`);
  }
  // 而且要求问的那道文件也不许被直接 require(否则下一个人又会顺手调)。
  for (const [name, src] of [['j2_dispatcher', dispCode], ['j2_agent_loop', loopCode]]) {
    assert.doesNotMatch(src, /require\(['"]\.\/gua_answer_gate['"]\)/,
      `${name} 直接 require 了门本身 —— 绕过编排`);
    assert.doesNotMatch(src, /require\(['"]\.\/chart_answer_gate['"]\)/,
      `${name} 直接 require 了门本身 —— 绕过编排`);
  }
});

test('A2 dispatcher 的 5 个定稿收口都走流水线, 而门只被调一次真源', () => {
  // 2026-10-23 第 61 批: 定稿收口从 `_factGate(...)` 收成了 `_finalize(text, evidence)`
  // (剥泄漏 + 对齐门 + 门 一条流水线, 见 final_pipeline)。**判据没放松**:
  // 还是那五处定稿一处都不能少, 门还是只调一次真源。
  // 2026-10-23 第 65 批: 公共 5 步(综合 → 兜底 → 定稿核验 → 剥伪工具标记)收进了
  //   `_synthesizeAndFinalize`, 「五处各写一遍 `await _finalize(`」的份数没了。
  //   **判据还是没放松**: 改成钉机制 —— 每条交付出口都得走到定稿流水线。
  const { finalizeCoverage } = require('./helpers/dispatcher_exits');
  const _cov = finalizeCoverage();
  assert.ok(_cov.count >= 4,
    `交付出口找少了 (直答/fixed_flow/关键词兜底/主路径), 实际 ${_cov.count}`);
  assert.ok(_cov.all('_finalize'),
    '有交付出口没过定稿流水线: '
    + _cov.uncovered('_finalize').map((e) => 'L' + e.line).join(', '));
  assert.doesNotMatch(dispCode, /await _factGate\(/,
    '有定稿收口绕过流水线直接过门 —— 剥【上文】块和对齐门被跳过了');
  assert.equal((dispCode.match(/runAnswerGates\(/g) || []).length, 1,
    '_factGate 里调 runAnswerGates 只能一次 —— 调两次就是同一段文本过了两遍门');
});

// (2) 行为: 顺序、证据、ask、豁免

test('B1 卦象门先跑, 结果喂给命盘门 (顺序不能反)', () => {
  const seq = [];
  const fakeGua = '〔重修后的卦象文〕';
  const fakeChart = '〔重修后的命盘文〕';
  // 用 require 缓存替换两个门模块, 记录调用顺序与入参。
  const guaPath = require.resolve(path.join(CORE, 'modules', 'gua_answer_gate.js'));
  const chartPath = require.resolve(path.join(CORE, 'modules', 'chart_answer_gate.js'));
  const realGua = require(guaPath);
  const realChart = require(chartPath);
  require.cache[guaPath].exports = {
    verifyAndRepairGuaAnswer: async (t) => {
      seq.push('gua');
      return { text: fakeGua, checked: true, repaired: true, contradictions: [{ claim: '卦名写错' }] };
    },
  };
  require.cache[chartPath].exports = {
    verifyAndRepairChartAnswer: async (t, ask, evidence) => {
      seq.push('chart');
      assert.equal(t, fakeGua, '命盘门拿到的必须是卦象门重修后的文本');
      assert.deepEqual(evidence, [{ name: 'bazi_calc', ok: true, result: {} }],
        '命盘门必须拿到调用方给的权威盘证据');
      return { text: fakeChart, checked: true, repaired: false, contradictions: [{ claim: '十神写错' }] };
    },
  };
  const evidence = [{ name: 'bazi_calc', ok: true, result: {} }];
  return Promise.resolve(require(GATES).runAnswerGates('原始答复', async () => 'x',
    { chartEvidence: evidence }))
    .then((out) => {
      require.cache[guaPath].exports = realGua;
      require.cache[chartPath].exports = realChart;
      assert.deepEqual(seq, ['gua', 'chart'], '卦象门必须先跑, 命盘门后跑');
      assert.equal(out.text, fakeChart, '最后交付的必须是命盘门的输出(它在最后跑)');
      assert.equal(out.gua.repaired, true);
      assert.equal(out.chart.contradictions.length, 1);
    });
});

test('B2 ask 回调: 给了 soulScope 才传第四个参数 (不替调用方猜)', () => {
  const calls = [];
  const callLLM = (...args) => { calls.push(args); return Promise.resolve({ choices: [{ message: { content: '答' } }] }); };
  const G = require(GATES);
  // 不给 soulScope => 三个参数(跟改造前 dispatcher 那条路逐字一致)
  return G.buildAskFn(callLLM, 'some-model')('问题').then(() => {
    assert.equal(calls[0].length, 3,
      '没有 soulScope 时多传第四个参数 —— _callLLMForAgent 内部行为不该由这里替它改');
    assert.deepEqual(calls[0][2], [], '第三个参数必须仍是空工具表');
    calls.length = 0;
    return G.buildAskFn(callLLM, 'some-model', { soulScope: 'worker' })('问题');
  }).then(() => {
    assert.equal(calls[0].length, 4, '给了 soulScope 就该带上');
    assert.equal(calls[0][3].soulScope, 'worker');
  });
});

test('B3 ask 回调吃得下三种响应形状 (anthropic / openai / content 数组)', () => {
  const G = require(GATES);
  const shapes = [
    { resp: { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }, want: 'AB' },
    { resp: { choices: [{ message: { content: 'C' } }] }, want: 'C' },
    // anthropic 旧形状: content 不是数组但模型是 anthropic
    { resp: { content: [{ type: 'text', text: 'D' }] }, want: 'D' },
    // 什么都没有 => 空串, 不许抛
    { resp: {}, want: '' },
  ];
  return Promise.all(shapes.map(({ resp, want }) =>
    G.buildAskFn(() => Promise.resolve(resp), 'm')('q').then((r) => {
      assert.equal(typeof r, 'string', 'ask 回调必须永远回字符串, 不能回 undefined 让下游崩');
      assert.equal(r, want);
    })));
});

test('B4 三种不该跑门的情况, 一道门都不跑', () => {
  const G = require(GATES);
  let asked = 0;
  const ask = () => { asked++; return Promise.resolve('x'); };
  return Promise.all([
    // 空文本
    G.runAnswerGates('', ask).then((o) => { assert.equal(o.text, ''); assert.equal(o.gua, null); }),
    // 没有 ask(判官不可用)
    G.runAnswerGates('盘古的答复', null).then((o) => {
      assert.equal(o.text, '盘古的答复', '没有 ask 时必须原样放行, 不许吞掉答复');
      assert.equal(o.gua, null);
    }),
    // 系统守卫文案豁免(跟改造前 loop 那条路一致)
    G.runAnswerGates('⚠️ [盘古] 本轮未收口', ask,
      { skipWhen: /^(⚠️\s*\[盘古|⚠️\s*我的结论|\[SYSTEM_GUARD\])/ })
      .then((o) => {
        assert.equal(o.text, '⚠️ [盘古] 本轮未收口');
        assert.equal(o.gua, null, '守卫文案不该进核验门');
      }),
  ]).then(() => {
    assert.equal(asked, 0, '上面三种情况都不该发起重修问询');
  });
});

// (3) 零影响: 门异常不阻断交付

test('C1 一道门抛异常, 另一道照跑, 交付不丢 (门是加法不是减法)', () => {
  const guaPath = require.resolve(path.join(CORE, 'modules', 'gua_answer_gate.js'));
  const realGua = require(guaPath);
  const boom = new Error('门炸了');
  require.cache[guaPath].exports = {
    verifyAndRepairGuaAnswer: async () => { throw boom; },
  };
  const chartPath = require.resolve(path.join(CORE, 'modules', 'chart_answer_gate.js'));
  let chartRan = false;
  require.cache[chartPath].exports = {
    verifyAndRepairChartAnswer: async (t) => {
      chartRan = true;
      return { text: t + '(命盘门跑过了)', checked: true, repaired: false, contradictions: [] };
    },
  };
  return Promise.resolve(require(GATES).runAnswerGates('原始答复', async () => 'x', {
    logPrefix: '[test]',
  })).then((out) => {
    require.cache[guaPath].exports = realGua;
    assert.equal(chartRan, true, '卦象门炸了, 命盘门必须照跑 —— 两道门各管各的, 不互相拖挂');
    assert.equal(out.text, '原始答复(命盘门跑过了)', '交付内容不能因为一道门炸了就丢');
  }).then(() => {
    // 还原命盘门(本测试改过 require 缓存)
    delete require.cache[chartPath];
  });
});

test('C2 没给 logPrefix 就不打任何日志 (不替调用方加噪声)', () => {
  const orig = console.log;
  let n = 0;
  console.log = () => { n++; };
  const guaPath = require.resolve(path.join(CORE, 'modules', 'gua_answer_gate.js'));
  const realGua = require(guaPath);
  require.cache[guaPath].exports = {
    verifyAndRepairGuaAnswer: async (t) => ({
      text: t, checked: true, repaired: false, contradictions: [{ claim: '有硬伤' }],
    }),
  };
  return Promise.resolve(require(GATES).runAnswerGates('答复', async () => 'x'))
    .then(() => {
      require.cache[guaPath].exports = realGua;
      assert.equal(n, 0, '没给 logPrefix 却打了日志 —— 门不该擅自往控制台写东西');
      console.log = orig;
    }, (e) => { console.log = orig; throw e; });
});

// 负例: 拆掉修复, 断言必须变红

test('负例: 把编排挪回调用点(两份实现又回来了), A1 必须报出来', () => {
  // 真变异: 把 loop 里那句 runAnswerGates 换成「自己 require 门自己调」——
  // 也就是这个 bug 修复之前的样子。A1 是扫源码的, 所以直接把污染喂给它看它咬不咬。
  const before = readCode(LOOP);
  assert.match(before, /runAnswerGates/,
    '变异前提不成立: loop 里已经没有 runAnswerGates 了, 这条负例验不到东西');
  const mutated = before.replace(
    /const _gated = await _gates\.runAnswerGates\(/,
    "const _gated = await require('./gua_answer_gate').verifyAndRepairGuaAnswer("
  );
  assert.notEqual(mutated, before, '变异没生效 —— 替换目标对不上, 这条负例是空枪');
  assert.match(mutated, /verifyAndRepairGuaAnswer/,
    '变异前提不成立: 没真造出第二份实现');
  // A1 的判据在污染后必须挂
  assert.throws(
    () => {
      assert.doesNotMatch(mutated, /verifyAndRepairGuaAnswer|verifyAndRepairChartAnswer/);
    },
    undefined,
    '守卫没咬住: 调用点又自己调门了它还放行'
  );
});

test('负例: 把顺序反过来(命盘门先跑), B1 的断言必须挂', () => {
  // 真源里 gua 在 chart 之前 —— 反过来就抓不到。
  const guaAt = gatesCode.indexOf('verifyAndRepairGuaAnswer');
  const chartAt = gatesCode.indexOf('verifyAndRepairChartAnswer');
  assert.ok(guaAt > -1 && chartAt > -1, '前置: 两道门都得在真源里');
  assert.ok(guaAt < chartAt,
    '顺序反了 —— 卦象门必须先跑, 命盘门拿到的要是卦象门重修后的文本');
});

test('负例: 把日志条件改回「只看 repaired」, 必须被记录下来', () => {
  // 这不是运行时断言, 是把「为什么统一日志条件」钉成注释里的判据 ——
  // 若哪天有人图省事改回只认 repaired, 至少这条会提醒他为什么不行。
  const logsBoth = /repaired \|\| \(g\.contradictions && g\.contradictions\.length\)/;
  assert.match(gatesCode, logsBoth,
    '日志条件退回「只看 repaired」了 —— 「查出硬伤但重修没改掉」会静悄悄, '
    + '而那正是第 8 批实跑里卦名答错的那一类');
  const logsBothChart = /repaired \|\| \(r\.contradictions && r\.contradictions\.length\)/;
  assert.match(gatesCode, logsBothChart, '命盘门同理');
});
