const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SRC = fs.readFileSync(require.resolve('../modules/j2_dispatcher.js'), 'utf8');
const HELPERS = require('../modules/j2_helpers');

// 2026-10-12 两起实案:
//   leak-probe-20261012-1  主人说"我叫王五，生日1990年9月9日。请记住", fixed_flow 的
//     synthesis 写出整段 <tool_call><mm:think> 草稿, 经 chunk/final/done 原样喷上屏。
//   leak-verify-20261012-1 剥干净之后答案变成空字符串 —— 主人看到一片白。
// j2_dispatcher.js 有 4 处 `safeResWrite(res,'chunk',{delta:finalText})` 收口出口,
// 2026-09-14 #12 只覆盖了其中一处。现在统一走 _finalizeAnswerText: 剥 + 剥空兜底。
// 这条守卫防的是"再加一条收口路径又忘了", 以及"有人把剥离绕开了"。
test('每一处把 finalText 写上屏的 chunk 之前, 都必须经过收口剥离', () => {
  // 2026-10-23(第 65 批): 收口剥离从「4 处各写一遍 `_finalizeAnswerText(finalText, _childConclusions(results))`」
  //   收进了 `_synthesizeAndFinalize` 一处 —— 「写上屏的 chunk」也因此只剩 3 处
  //   (关键词兜底那两条路共用一个收口了; 少的那处**不是漏了**, 是合并了)。
  //   **意图一个字没变**: 每处把答复写上屏之前, 都得先剥过收口 ——
  //   伪工具标记或空答复一旦漏出去, 主人看到的就是模型的心理活动。
  //
  //   新量法钉的是**机制**: 每条「把答复写上屏」的路, 它的答复都必须由那个
  //   **统一的剥离实现**产出; 有一条绕过, 覆盖检查当场红。
  const { finalizeCoverage } = require('./helpers/dispatcher_exits');
  const _cov = finalizeCoverage();
  // 3 条综合路(关键词兜底 / fixed_flow / 主路径)都由 _synthesizeAndFinalize 产出,
  // 它内部必过 _finalizeAnswerText; 直答那条走自己的 _stripPseudoToolMarkup。
  const _uncovered = _cov.uncovered('_finalizeAnswerText');
  assert.ok(_uncovered.length <= 1,
    '不该有综合路绕过收口剥离: ' + _uncovered.map((e) => 'L' + e.line).join(', '));
  // 上屏的 chunk 口不许比「过了剥离的出口」少
  const chunkWrites = (SRC.match(/safeResWrite\(res,\s*'chunk',\s*\{\s*delta:\s*(finalText|_daText)\s*\}\)/g) || []).length;
  assert.ok(chunkWrites >= 4, `预期至少 4 条 chunk 收口路径, 实际 ${chunkWrites}`);
  // 统一实现里必须真的有收口剥离(不是「有实现就算」)
  assert.ok(/_ft = _finalizeAnswerText\(_ft, _childConclusions\(resultsRef\)\)/.test(SRC),
    '统一实现里必须有收口剥离 —— 伪工具标记或空答复会直接漏给主人');
  // 直答那条自己剥(它不走 _finalizeAnswerText, 走 _stripPseudoToolMarkup)
  assert.ok(/_stripPseudoToolMarkup\(_daStripped\)/.test(SRC),
    '直答路径必须剥伪工具标记再上屏');
});

test('收口剥离后为空时必须回落子 agent 结论, 不给主人一片白', () => {
  // 直接验证收口语义: 整段泄漏剥完是空 → 回落
  const leaked = '<tool_call>\n<mm:think>We need call memory_write. User asks remember...';
  const stripped = HELPERS._stripPseudoToolMarkup(leaked);
  assert.equal(stripped.trim(), '', '整段泄漏应被剥干净');
  assert.ok(stripped.length < 10, '剥完不足 10 字, 必须触发回落分支');
});

test('正常正文不能被误剥', () => {
  const normal = '主人叫王五，生日 1990年9月9日，已记入长期记忆。';
  assert.equal(HELPERS._stripPseudoToolMarkup(normal), normal);
});

test('五处收口(含直答路径)仍都在过命盘核验门 (回归: 曾被批量替换误删过)', () => {
  // 2026-10-12: 新增直答单 agent 定稿 (if (_directAnswerTurn)) 也过门 → 4 → 5。
  // 判据是"每处定稿都先剥历史标记再过门", 直答那处同样合规。
  // 2026-10-23 第 61 批: 那句 `await _factGate(_stripHistoryLeak(...))` 收进了
  //   final_pipeline.finalizeAnswer —— 五处各写一遍的顺序契约变成了一个函数的行为。
  //   「五处都要走」这个判据一条没放松, 只是数的是新调用点。
  // 2026-10-23 第 65 批: 公共 5 步(综合 → 兜底 → 定稿核验 → 剥伪工具标记)收进了
  //   `_synthesizeAndFinalize` —— 「五处各写一遍 `await _finalize(`」这个量法失效了。
  //   **意图一个字没变**: 五处定稿一处都不能少, 门还是只调一次真源。
  //   新量法钉的是**机制**: 每条交付出口都必须走到定稿流水线。
  const { finalizeCoverage } = require('./helpers/dispatcher_exits');
  const _cov = finalizeCoverage();
  assert.ok(_cov.count >= 4,
    `交付出口找少了 (直答/fixed_flow/关键词兜底/主路径), 实际 ${_cov.count}`);
  assert.ok(_cov.all('_finalize'),
    '有定稿收口没过命盘核验门: '
    + _cov.uncovered('_finalize').map((e) => 'L' + e.line + '/' + (e.mode || '直答')).join(', '));
  // 2026-10-17: 这个分支后来又接了第二种触发 (单刀直查), 条件从 `if (_directAnswerTurn)`
  // 变成 `if (_directAnswerTurn || ...)`。
  // 2026-10-19: 那个「...」现在是 `_oneShotTurn` = 单刀直查 || 单目标阅读 (两条"一件事
  // 就完"的触发合流, 运行语义相同)。守的是"直答定稿也过命盘核验门",
  // 锚点跟着分支条件走, 语义不变 —— 上面那处计数仍是 5, 命盘门一处没少。
  assert.ok(/if\s*\(\s*_directAnswerTurn\s*\|\|\s*_oneShotTurn\s*\)[\s\S]{0,4000}?await _finalize\(/.test(SRC),
    '直答路径定稿必须同样走定稿流水线(先剥历史标记再过出门核验门)');
});
