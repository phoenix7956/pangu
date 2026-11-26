'use strict';
/**
 * tests/plan-verdict-20261024.test.js —— 第 77 批: 拆解轮的结论分类
 *
 * ## 这条判据在守什么
 *   2026-10-24 实跑 (probe76b-decide): 主人问「这个项目该不该继续做, 值不值」,
 *   主 agent 那一刀明明回了「指代不明, 拆不出自足的子任务。需要主人先点一下是哪个项目」——
 *   但 dispatcher 里 `await j2AgentLoop._runAgentLoopLegacyStream(...)` 的
 *   **返回值被丢了**, 于是那句话连同它的理由一起消失。
 *   后果: 又买一次坎·planner, 派了个 li 去「探索项目全貌」,
 *   146 帧没有一个 final —— 主人这一轮**什么都没拿到**。
 *
 *   本测试把「拆不动」拆成两态, 并且用 **81 条现场原话**钉住:
 *     B  指代不明 → 不派子 agent, 把反问交回主人
 *     A  一件事就完 → 不再买第二次 planner
 *
 * ## 为什么语料是夹具而不是现编
 *   判据吃的是**主 agent 的原话** —— 只有现场那 81 条能覆盖真实的说法分布
 *   (「拆不动。」/「拆不动 — 单一任务…」/「指代不明, 拆不出…」…),
 *   现编的句子覆盖不了, 还会写出「判据对了我想的样子」。
 *   语料来源: ~/.pangu/state/harness/runs/*main-pl*.jsonl, 抄录 2026-10-24。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');

const M = (p) => require(path.join(__dirname, '..', p));
const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const pv = M('modules/plan_verdict.js');
const CORPUS = require('./plan-verdict-corpus-20261024.json');

// --------------------------------------------------------------------------
// 1. 语料: 81 条现场原话, 逐条判对
// --------------------------------------------------------------------------

test('语料: 82 条拆解轮原话一条都不许判错', () => {
  assert.strictEqual(CORPUS.cases.length, 82, '语料条数变了 —— 夹具被改动过?');
  const wrong = [];
  for (const c of CORPUS.cases) {
    const got = pv.classifyPlanVerdict(c.ft).kind;
    if (got !== c.kind) wrong.push(c.id + ' 期望 ' + c.kind + ' 实得 ' + got);
  }
  assert.deepStrictEqual(wrong, [], '判错的: ' + wrong.join(' | '));
});

// 逐条独立成用例 —— 判错时能直接看到是哪一条, 而不是一堆里挑
for (const c of CORPUS.cases) {
  test('语料 ' + c.id + ' (' + c.kind + ') 判对', () => {
    assert.strictEqual(pv.classifyPlanVerdict(c.ft).kind, c.kind);
  });
}

test('语料构成: B 恰好 2 条 / A 10 条 / 其它 60 条 / 空 10 条', () => {
  const by = {};
  for (const c of CORPUS.cases) by[c.kind] = (by[c.kind] || 0) + 1;
  assert.deepStrictEqual(by, { B: 2, A: 10, other: 60, empty: 10 });
});

// --------------------------------------------------------------------------
// 2. 弱信号不许单独定案 (否则正常答复会被当反问)
// --------------------------------------------------------------------------

test('弱信号(哪个/不确定)单独出现**不算** B', () => {
  assert.strictEqual(pv.classifyPlanVerdict('我不确定哪个文件才对。').kind, 'other');
  assert.strictEqual(pv.classifyPlanVerdict('这个项目该继续做吗? 值不值。').kind, 'other');
});

test('A 类的解释句不许被误判成 B', () => {
  // 「没有哪个子任务能独立做」是 A 类在**解释为什么拆不动**, 不是在抱怨指代不明。
  assert.strictEqual(
    pv.classifyPlanVerdict('拆不动。这件事没有哪个子任务能独立完成, 建议单刀做完。').kind, 'A');
  assert.strictEqual(
    pv.classifyPlanVerdict('拆不动。不确定的是要不要当场改, 但活本身是一件。').kind, 'A');
});

test('弱信号 + 「拆不动」= B (主 agent 明说了拆不动, 又指出指代不明)', () => {
  assert.strictEqual(pv.classifyPlanVerdict('拆不动。你说的这个我不确定是哪个文件。').kind, 'B');
});

test('强信号单独就定案 (主 agent 直接说指代不明)', () => {
  assert.strictEqual(pv.classifyPlanVerdict('指代不明, 需要主人先点一下是哪个项目。').kind, 'B');
  assert.strictEqual(pv.classifyPlanVerdict('拆不出自足的子任务。').kind, 'B');
});

test('主 agent 在**回问主人**时也算 B (2026-10-24 实跑新抓到的说法)', () => {
  // 这一条是当天实跑抓出来的: 提示词让模型「用第二人称把要问主人的话写出来」,
  // 模型照做了 —— 于是它一个 tier1/tier2 的词都没用, 但它**就是在回问**。
  // 判成 A 的代价: 不听这句反问, 自己猜一个项目开干 (就是原来那个「探索项目全貌」)。
  assert.strictEqual(
    pv.classifyPlanVerdict('拆不动。\n\n你说的「这个项目」是哪一个？给个名字或路径我就接着判。').kind, 'B');
  assert.strictEqual(
    pv.classifyPlanVerdict('拆不动。这件事得你给个名字或路径我才知道做哪一件。').kind, 'B');
  // 但「是哪一个」出现在**解释**里(不是在回问)不算 B
  assert.strictEqual(
    pv.classifyPlanVerdict('拆不动。读的是哪一个文件由主人的原话指定, 建议直接 read_file。').kind, 'A');
});

test('空/非字符串不许炸', () => {
  for (const v of [null, undefined, '', '   ']) {
    assert.strictEqual(pv.classifyPlanVerdict(v).kind, 'empty',
      '空输入应该判 empty: ' + JSON.stringify(v));
  }
  // 非字符串的垃圾输入: 不许炸, 也不许当成「有结论」
  for (const v of [0, false, {}, [], NaN]) {
    const r = pv.classifyPlanVerdict(v);
    assert.ok(r && typeof r.kind === 'string', '必须返回结论: ' + String(v));
    assert.ok(['empty', 'other', 'A', 'B'].includes(r.kind), '结论种类不认识: ' + r.kind);
  }
});

// --------------------------------------------------------------------------
// 3. isClarification 必须与分类同源 (两处两个判据 = 迟早漂)
// --------------------------------------------------------------------------

test('isClarification 与 classifyPlanVerdict 的 B 判定逐条一致', () => {
  for (const c of CORPUS.cases) {
    assert.strictEqual(pv.isClarification(c.ft), c.kind === 'B', c.id);
  }
});

// --------------------------------------------------------------------------
// 4. 上屏文本: 剥内部信号 + 换第二人称 + 过得了词法对齐门
// --------------------------------------------------------------------------

test('澄清文本上屏前要剥内部信号词、换第二人称, 且过得了词法对齐门', () => {
  const b = CORPUS.cases.find((c) => c.kind === 'B');
  const out = pv.toUserFacingClarification(b.ft);
  assert.ok(!/拆不动/.test(out), '答复里不该留着内部信号词「拆不动」: ' + out.slice(0, 80));
  assert.ok(!/主人/.test(out), '答复里不该出现内部人称「主人」: ' + out.slice(0, 80));
  assert.ok(out.length > 10, '清洗把正文一起吃掉了: ' + JSON.stringify(out));

  const aa = M('modules/answer_alignment.js');
  // 原文过不了门 (「主人问…」被判编排泄漏) —— 所以清洗 + 放行门这两道都省不掉。
  assert.strictEqual(aa.isAligned(b.realQ, b.ft), false,
    '原文居然过得了词法对齐门 —— 那「主人问」这条编排泄漏判据改了?');
  assert.strictEqual(aa.isOrchestrationLeak(b.ft), true, '原文不再被判编排泄漏');
  // 清洗之后必须过得了门, 否则主人看到的是「本轮未形成与原问题匹配的可核验答案, 请重试。」
  assert.strictEqual(aa.isAligned(b.realQ, out), true,
    '上屏文本过不了词法对齐门 —— 会被整段换成「请重试」');
  assert.strictEqual(aa.isOrchestrationLeak(out), false, '上屏文本被判编排泄漏');
});

// --------------------------------------------------------------------------
// 5. dispatcher 接线
// --------------------------------------------------------------------------

const _sliceBetween = (src, from, to) => {
  const a = src.indexOf(from);
  assert.ok(a > 0, '找不到起点: ' + from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, '找不到终点: ' + to);
  return src.slice(a, b);
};

test('dispatcher: 拆解轮的返回值必须被接住 (裸 await 等于把主 agent 的话丢掉)', () => {
  const src = SRC('modules/j2_dispatcher.js');
  assert.match(src, /_planResult = await j2AgentLoop\._runAgentLoopLegacyStream/,
    '拆解轮那一刀的返回值必须接住 —— 丢了它, 「拆不动 / 指代不明」就永远没人知道');
  assert.match(src, /classifyPlanVerdict/,
    '必须用 plan_verdict 那份判据, 不许在 dispatcher 里另写一份词表');
});

test('dispatcher: B 类(指代不明)不许派任何子 agent, 必须把反问交回主人', () => {
  const src = SRC('modules/j2_dispatcher.js');
  const b = _sliceBetween(src, "_planVerdict.kind === 'B'", "_planVerdict.kind === 'A'");
  assert.doesNotMatch(b, /subAgent\.run\(/,
    'B 类不许派子 agent —— 「这个项目」指代不明, 派谁都是猜');
  assert.doesNotMatch(b, /mode:\s*'kan'/, 'B 类不许再买坎·planner');
  assert.match(b, /await _finalize\(/, 'B 类的答复必须过定稿流水线');
  assert.match(b, /_guardAllowClarification/, 'B 类必须走澄清放行门 (原话是回问, 不是答案)');
  assert.match(b, /safeResWrite\(res, 'final'/, 'B 类必须给主人一条终稿');
  assert.match(b, /persistState:/, 'B 类是答复, 必须落盘 (不许 persist:false)');
  assert.doesNotMatch(b, /persist:\s*false/, 'B 类是答复, 不许声明不落盘');
});

test('dispatcher: A 类(一件事就完)不许再买第二次坎·planner', () => {
  const src = SRC('modules/j2_dispatcher.js');
  const a = _sliceBetween(src, "_planVerdict.kind === 'A'", "const _fastPlan = _fastPlanFor(userInput);");
  assert.doesNotMatch(a, /mode:\s*'kan'/,
    'A 类不许再买坎·planner —— 主 agent 已经判过了, 再问一遍是白烧一次规划推理');
  assert.match(a, /plan = null/, 'A 类必须把 plan 置空, 让流程落到确定性拆分/关键词兜底');
  // 顺序: A 分支必须排在快路/坎之前 (否则 A 还是会先买一次坎)
  const aAt = src.indexOf("_planVerdict.kind === 'A'");
  const fastAt = src.indexOf('const _fastPlan = _fastPlanFor(userInput);');
  const kanAt = src.indexOf("mode: 'kan'");
  assert.ok(aAt > 0 && fastAt > aAt && kanAt > fastAt,
    'A 分支必须在规则快路和坎·planner 之前');
});

test('dispatcher: 澄清出口在「交付出口账本」里, 且过了定稿流水线', () => {
  const { finalizeCoverage } = require('./helpers/dispatcher_exits');
  const cov = finalizeCoverage();
  assert.ok(cov.all('_finalize'),
    '有交付出口没过定稿流水线: ' + cov.uncovered('_finalize').map((e) => 'L' + e.line).join(', '));
  const clarify = cov.ledger.exits.filter((e) => /mode:\s*'clarify'/.test(e.text));
  assert.strictEqual(clarify.length, 1, '澄清出口必须恰好一个');
});

test('dispatcher: 拆解轮那张坎·拆卡必须收尾 (B/A 两条路都要发终态事件)', () => {
  const src = SRC('modules/j2_dispatcher.js');
  const b = _sliceBetween(src, "_planVerdict.kind === 'B'", "_planVerdict.kind === 'A'");
  const a = _sliceBetween(src, "_planVerdict.kind === 'A'", "const _fastPlan = _fastPlanFor(userInput);");
  assert.match(b, /sub_agent_done/, 'B 类必须给坎·拆那张卡发终态事件');
  assert.match(a, /sub_agent_done/, 'A 类必须给坎·拆那张卡发终态事件');
});
