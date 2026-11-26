const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const DISP_SRC = fs.readFileSync(require.resolve('../modules/j2_dispatcher.js'), 'utf8');
const DISP = require('../modules/j2_dispatcher');

// 2026-10-12 实案 (final-v1-20261012 第 1/2 轮): 我在 cb67b3c 加的"剥空回落"把
// toolHistorySummaries 整段吐给了主人, 而那个串的 `task:` 字段是喂给子 agent 的内部
// 脚手架, 里面带着【上文】块 —— 主人气泡里直接出现
//   "[上文-仅供你参考, 禁止在答复里复述本段或提及"上文"/"上下文"这类字样]"
// 这正是早上 commit 57e9e1a 立下的规矩 (注入给子 agent 的上文块不许泄到主人眼前)。
// 我的回落把这条规矩又捅穿了一次。回落只能用子 agent 的**结论**。
test('回落只取子 agent 结论, 不带 task: 脚手架', () => {
  const results = [{
    agent: 'analyzer',
    task: '[上文-仅供你参考, 禁止在答复里复述本段或提及"上文"/"上下文"这类字样]\n(这是同一条对话, 不是第一次问。)\n问事者: 我叫赵六',
    result: { summary: '已记下：姓名赵六，生日1992年12月12日。' },
  }];
  const out = DISP._childConclusions(results);
  assert.match(out, /赵六/, '结论必须保留');
  assert.doesNotMatch(out, /仅供你参考/, '内部上文块不许出现');
  assert.doesNotMatch(out, /问事者/, '任务脚手架不许出现');
  assert.doesNotMatch(out, /^agent:/m, 'agent: 前缀不许出现');
});

test('结论里自己带【上文】字样也要被剥掉', () => {
  const results = [{
    agent: 'analyzer',
    task: 't',
    result: { summary: '### 【上文 — 本会话此前的对话】\n结论: 上面那版是错的, 正确的是 B。' },
  }];
  const out = DISP._childConclusions(results);
  assert.doesNotMatch(out, /上文/, '结论正文里的【上文】块也不许上屏');
  assert.match(out, /正确的是 B/, '剥除不能把结论一起吃掉');
});

test('没有结论时返回空串, 让收口走诚实提示而不是泄脚手架', () => {
  assert.equal(DISP._childConclusions([{ agent: 'a', task: 't', result: {} }]), '');
  assert.equal(DISP._childConclusions([]), '');
});

test('四处收口的回落源都必须是 _childConclusions, 不是 toolHistorySummaries', () => {
  // 2026-10-23(第 65 批): 那句 `_finalizeAnswerText(finalText, _childConclusions(results))`
  //   从 4 份抄本收进了 `_synthesizeAndFinalize` 一处 —— 份数这个量法失效了。
  //   **意图一个字没变**: 回落源必须是 _childConclusions(子 agent 的汇报),
  //   不许是 toolHistorySummaries(那串带 task: 脚手架和【上文】块)。
  //   新量法: ① 统一实现里的回落源确实是 _childConclusions;
  //         ② 每条综合路都走到了那个统一实现(漏一条就是"只堵了一个洞")。
  const good = (DISP_SRC.match(/_finalizeAnswerText\(_ft, _childConclusions\(resultsRef\)\)/g) || []).length;
  assert.strictEqual(good, 1, `回落源应为 _childConclusions, 实际 ${good} 处(只允许统一实现里有一处)`);
  assert.doesNotMatch(
    DISP_SRC,
    /_finalizeAnswerText\([^,]+, toolHistorySummaries\)/,
    '回落不许再用 toolHistorySummaries —— 那个串带 task: 脚手架和【上文】块'
  );
  const { finalizeCoverage } = require('./helpers/dispatcher_exits');
  const _cov = finalizeCoverage();
  // 2026-10-24 (第 77 批): 「没走综合」的路从 1 条变成 2 条 ——
  //   ① 直答/单刀 (direct_answer / single_shot / single_file): 它本来就不该综合,
  //      一次一个 agent 出结果, 没有「子 agent 汇报」可综合;
  //   ② 澄清 (clarify): 主 agent 判「指代不明」, 把反问直接交回主人 (第 77 批新加)。
  //
  // 判据**不许**写成「≤N 条都行」—— 那是把漏网的路一起放过去。
  // 名单在 helpers/dispatcher_exits (唯一真源) —— 三个「份数/覆盖」判据共用一份,
  // 免得加一条新出口时漏改一处, 而漏改的那一处会静默放过一条绕路出口。
  const { isDirectDelivery } = require('./helpers/dispatcher_exits');
  const _unc = _cov.uncovered('_synthesizeAndFinalize');
  assert.ok(_unc.length <= 2,
    '有综合路没走统一实现(回落源也就没钉住): '
    + _unc.map((e) => 'L' + e.line).join(', '));
  for (const e of _unc) {
    assert.ok(isDirectDelivery(e),
      'L' + e.line + ' 没走统一实现, 而且不在点名允许的直交付路里: '
      + e.text.slice(0, 140));
  }
});
