'use strict';
// 定稿流水线收成唯一实现 (2026-10-23 第 61 批)
//
// 起因:
//   `await _factGate(_stripHistoryLeak(_guardWithSubFallback(userInput,
//     _stripThink(finalText))), model, _chartEvidenceFrom(results))`
//   这一句在 j2_dispatcher.js 里**五处一字不差地各写一遍**。
//   五处一样, 但**顺序是隐式的** —— 「先剥上文泄漏再过核验门」只存在于
//   写这行的人脑子里。两个老测试在数这个字面量出现几次(5 处), 说明顺序本身
//   是有价值的契约 —— 但契约应该是「一个函数的行为」, 不是「五处字符串长得一样」。
//
// 本批: 顺序变成 modules/final_pipeline.js 里 finalizeAnswer 这一个函数的行为。
//   判官的老教训照旧: **绿灯是结果, 咬人才是证据** —— 每条护栏都有对应负例。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const FP = require(path.join(CORE, 'modules', 'final_pipeline.js'));
const DISPATCHER = path.join(CORE, 'modules', 'j2_dispatcher.js');
const readCode = (p) => fs.readFileSync(p, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const dispCode = readCode(DISPATCHER);
const fpCode = readCode(path.join(CORE, 'modules', 'final_pipeline.js'));

const GATES_PATH = require.resolve(path.join(CORE, 'modules', 'answer_gates.js'));
const realGates = require(GATES_PATH);

// 用假门记录「门看到的文本」—— 顺序对不对, 一眼就知道, 不用扫源码。
function withFakeGate(fn) {
  const seen = { gate: null, guard: null, evidence: undefined };
  require.cache[GATES_PATH].exports = {
    runAnswerGates: async (text, ask, opts) => {
      seen.gate = text;
      seen.evidence = opts && opts.chartEvidence;
      return { text, gua: null, chart: null };
    },
  };
  const restore = () => { require.cache[GATES_PATH].exports = realGates; };
  return Promise.resolve()
    .then(() => fn(seen))
    .then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
}

const LEAKY = '### 【上文 — 本会话此前的对话】(这段指这里)\n\n第24卦是复卦，地雷复。';

// (1) 顺序

test('P1 四步顺序真跑一遍: 剥思维链 → 对齐门 → 剥上文块 → 核验门', () => {
  return withFakeGate((seen) => FP.finalizeAnswer({
    finalText: '<think>盘古先盘算了一下</think>' + LEAKY,
    userInput: '第24卦是哪一卦',
    model: 'm',
    ask: async () => '',
    guardWithSubFallback: (q, primary) => { seen.guard = primary; return primary; },
    chartEvidence: [],
  }).then(() => {
    assert.ok(!seen.guard.includes('<think>'),
      '对齐门看到的文本里还有 <think> —— stripThink 必须排在它前面');
    // 对齐门**仍然看得到**【上文】块: 这是改造前的顺序, 本批逐字保留。
    // 它比的是语义, 泄漏块不影响语义; 核验门才是拿文本查表的那个, 泄漏必须排在它前面。
    assert.ok(seen.guard.includes('上文'),
      '对齐门不该看到已被剥掉的【上文】块 —— 顺序与改造前不一致(见 final_pipeline 注释)');
    assert.ok(!seen.gate.includes('上文'),
      '核验门看到的文本里还有【上文】块 —— 顺序反了, 核验基准会串味');
    assert.ok(seen.gate.includes('第24卦'), '剥泄漏把正文一起吃掉了');
  }));
});

test('P2 证据原样传到门 (不吞不改)', () => {
  const evidence = [{ name: 'bazi_calc', ok: true, result: { data: { pillars: {} } } }];
  return withFakeGate((seen) => FP.finalizeAnswer({
    finalText: '答复', userInput: '问题', model: 'm', ask: async () => '',
    guardWithSubFallback: (q, p) => p, chartEvidence: evidence,
  }).then(() => {
    assert.equal(seen.evidence, evidence, '证据必须**原样**传给门 —— 重建一份就等于拿错东西验错东西');
  }));
});

// (2) 剥泄漏本体

test('P3 stripHistoryLeak 搬了家, 行为一条没变', () => {
  const leaked = LEAKY;
  assert.ok(!FP.stripHistoryLeak(leaked).includes('上文'), '④ 内部【上文】标记复读上屏了');
  assert.ok(FP.stripHistoryLeak(leaked).includes('第24卦'), '④b 剥除把正文一起吃掉了');
  assert.equal(FP.stripHistoryLeak('上文这个卦怎么解？主人在问流年。'), '上文这个卦怎么解？主人在问流年。',
    '④c 主人原话里的「上文」二字不该被剥');
  assert.equal(FP.stripHistoryLeak(null), '', 'null 不许炸');
  // 老 require 路径不断
  const { _stripHistoryLeak } = require(path.join(CORE, 'modules', 'j2_dispatcher.js'));
  assert.equal(typeof _stripHistoryLeak, 'function', 'j2_dispatcher 必须仍 re-export _stripHistoryLeak');
  assert.equal(_stripHistoryLeak(leaked), FP.stripHistoryLeak(leaked),
    '两个入口行为不一致 —— 那就是两份实现');
});

test('P4 三层包装只在一处写 (五处各写一遍的老形状不许回来)', () => {
  // 2026-10-23 第 65 批: 公共 5 步收进 `_synthesizeAndFinalize` —— 「五处各写一遍
  //   `await _finalize(`」这个量法失效了。**意图没变**: 每条交付路都得走这条流水线,
  //   而且「五处各记一遍顺序」的老形状不许回来。改钉机制。
  const { finalizeCoverage } = require('./helpers/dispatcher_exits');
  const _cov = finalizeCoverage();
  assert.ok(_cov.count >= 4, `交付出口找少了, 实际 ${_cov.count}`);
  assert.ok(_cov.all('_finalize'),
    '有交付出口没走定稿流水线: '
    + _cov.uncovered('_finalize').map((e) => 'L' + e.line).join(', '));
  // 老形状不许复活
  assert.doesNotMatch(dispCode, /_factGate\(\s*_stripHistoryLeak\(\s*_guardWithSubFallback/,
    '三层包装的老形状回来了 —— 顺序又变成五处各记一遍的默契');
  // 顺序在真源里, 不在调用点里
  const fp = fpCode.slice(fpCode.indexOf('async function finalizeAnswer('));
  const iThink = fp.indexOf('stripThink(src)');
  const iGuard = fp.indexOf('guardWithSubFallback');
  const iStrip = fp.indexOf('stripHistoryLeak(text)');
  const iGate = fp.indexOf('runAnswerGates');
  assert.ok(iThink > -1 && iGuard > iThink && iStrip > iGuard && iGate > iStrip,
    `真源里的顺序不对 (think=${iThink} guard=${iGuard} strip=${iStrip} gate=${iGate})`);
});

// (3) 零影响

test('Z1 门抛异常时, 已经剥干净的文本照样交付 (门是加法不是减法)', () => {
  const gatesPath = GATES_PATH;
  require.cache[gatesPath].exports = {
    runAnswerGates: async () => { throw new Error('门炸了'); },
  };
  return FP.finalizeAnswer({
    finalText: '<think>x</think>' + LEAKY,
    userInput: 'q', model: 'm', ask: async () => '',
    guardWithSubFallback: (q, p) => p, chartEvidence: [],
  }).then((out) => {
    require.cache[gatesPath].exports = realGates;
    assert.ok(out.includes('第24卦'), '门炸了不该把正文也弄丢');
    assert.ok(!out.includes('<think>'), '门炸了不该把已剥干净的思维链还回去');
    assert.ok(!out.includes('上文'), '门炸了不该把已剥干净的上文块还回去');
  }, (e) => { require.cache[gatesPath].exports = realGates; throw e; });
});

test('Z2 没有 guardWithSubFallback 时也能走完 (不许因为少一个回调就丢交付)', () => {
  return withFakeGate((seen) => FP.finalizeAnswer({
    finalText: '<think>x</think>' + LEAKY, userInput: 'q', model: 'm', ask: async () => '',
  }).then(() => {
    assert.ok(!seen.gate.includes('<think>'));
    assert.ok(!seen.gate.includes('上文'));
    assert.ok(seen.gate.includes('第24卦'));
  }));
});

// 负例: 拆掉修复, 断言必须变红

test('负例: 把剥泄漏挪到门之后, P1/P4 必须报出来', () => {
  // 真变异: 把 `text = stripHistoryLeak(text);` 整行挪到 runAnswerGates **之后** ——
  // 整段搬移, 不是「改个变量名」那种根本不改变顺序的假变异。
  const before = fpCode;
  assert.match(before, /stripHistoryLeak\(text\)[\s\S]{0,400}?runAnswerGates/,
    '变异前提不成立: 真源里本来的顺序就不对 —— 这条负例验不到东西');
  const stripLine = '  text = stripHistoryLeak(text);';
  const gateLine = '    const out = await gates.runAnswerGates(text, o.ask, {';
  assert.ok(before.includes(stripLine) && before.includes(gateLine),
    '变异前提不成立: 锚点行变了 —— 这条负例是空枪');
  const mutated = before.replace(stripLine + '\n', '')
    .replace(gateLine, gateLine + '\n' + stripLine);
  assert.notEqual(mutated, before, '变异没生效 —— 替换目标对不上, 这条负例是空枪');
  const fn = mutated.slice(mutated.indexOf('async function finalizeAnswer('));
  const iStrip = fn.indexOf(stripLine.trim());
  const iGate = fn.indexOf('runAnswerGates');
  assert.ok(iGate > -1 && iStrip > -1 && iGate < iStrip,
    '守卫没咬住: 剥泄漏被挪到门之后了, 顺序断言还放行');
});

test('负例: 剥泄漏的实现留在 dispatcher 里(两份实现), P3 必须报出来', () => {
  assert.doesNotMatch(dispCode, /function _stripHistoryLeak\(/,
    'dispatcher 里还留着一份实现 —— 留着的不是备份, 是第三份词表');
  assert.doesNotMatch(dispCode, /_HISTORY_LEAK_RE|_HISTORY_HEADING_RE/,
    'dispatcher 里还留着剥泄漏的两条正则 —— 同一份词表两处维护, 迟早漂');
});
