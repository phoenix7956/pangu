// answer-alignment-terse-20261014.test.js
// 老板 2026-10-14 报「盘古不肯说话」的回归锁。
//
// 真凶: modules/answer_alignment.js 的 isAligned() 里 `if (a.length < 6) return false;`
// 把**正确**的短答案整个清空。实测「1+1等于几?直接回答数字。」模型答「2」(1 字)被拒,
// 「请只回复:收到」答「收到」「好的, 收到」「已收到, 谢谢」全部被拒, 用户只看到
// 「本轮未形成与原问题匹配的可核验答案, 请重试。」然后反复重试 —— 体感就是"慢/没反应"。
// 寒暄「你好」能过, 越是索要具体答案越被拒: 判据是"答案有没有复述问题的词", 与对错无关。
//
// 逆向 Codex (codex-cli 26.1007) 的结论: 它没有这道关卡。反幻觉落在三处 ——
//   ① 提示层 "Do not hallucinate completion"
//   ② 工具结果来源/截断记账 (tool_result_source / original_bytes / omitted_calls)
//   ③ Guardian 的**动作**风险闸门 (管命令审批, 不管答案对错)
// 词法对齐门是盘古独有的发明, 且是纯负向判据 (重叠低 = 跑题), 必然误杀短而正确的答案。
//
// 本文件同时锁住修复的两面: 短答案放行 **且** 真跑题仍然拦。修复不是把门拆了。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const aa = require('../modules/answer_alignment');

const ARITH = '1+1等于几？直接回答数字。';
const ECHO = '请只回复：收到';
// 9/30 那次事故的同款长问题 (tests/alignment-eaten-answer-20261001.test.js 同源)
const REAL = '字幕製作人Zither Harp\n\n现状没变：第 4 题仍悬（配偶宫冲月令），'
  + '等你一句课堂原话就锁；不给就按 D 交。其余六题答案已定稿。';

test('S1 正确的短答案不再被当成跑题 (2026-10-14)', () => {
  for (const a of ['2', '两', '2。', '答案是2', '2 个']) {
    assert.strictEqual(aa.guardAnswer(ARITH, a, '').blocked, undefined,
      `「${a}」是对「1+1等于几」的正确答案, 不该被拒`);
  }
});

test('S2 问题点名要的内容, 短答案照样放行 (2026-10-14)', () => {
  for (const a of ['收到', '收到。', '好的，收到', '已收到，谢谢']) {
    assert.strictEqual(aa.guardAnswer(ECHO, a, '').blocked, undefined,
      `「${a}」回应了「只回复:收到」, 不该被拒`);
  }
});

test('S3 修复不是拆门: 真跑题仍然必须拦 (2026-10-14)', () => {
  const offTopic = '今天天气不错，我们去公园散步吧，顺便聊聊最近的新闻。';
  const g = aa.guardAnswer(REAL, offTopic, '');
  assert.strictEqual(g.blocked, true, '长答案零词法重叠仍是真跑题, 必须拦');
  assert.ok(!/^tool_result/.test(String(g.text || '')), '拦截时不得把原始工具输出当答案返回');
  assert.strictEqual(aa.isAligned('1+1等于几？', '澳门去西班牙的距离是多少公里', ''), false,
    '答非所问的长答案必须判跑题');
});

test('S4 带证据的真跑题仍然拦, 真证据的答案仍然放行 (2026-10-14)', () => {
  const evidence = 'tool_result: 1-ABC 2-C 3-A 5-B tool_result 字节 1206 行 285 文件 /tmp/x.txt';
  assert.strictEqual(aa.guardAnswer(REAL, '今天天气不错，我们去公园散步吧。', '', evidence).blocked, true,
    '带证据也不能让跑题蒙混过关');
  const grounded = '已核实 6 题答案定稿，其中 1-ABC 2-C 3-A 5-B 有 tool_result 支撑，共 1206 字节 285 行。';
  assert.strictEqual(aa.guardAnswer(REAL, grounded, '', evidence).aligned, true,
    '锚定 tool_result 的实质答案必须放行 (9/30 事故的初衷不能丢)');
});

test('S5 反幻觉能力没被拆: 编排泄漏仍拦 (2026-10-14)', () => {
  assert.strictEqual(
    aa.isOrchestrationLeak('上一轮我已经把文件都写好了。下一步我继续排查剩下的接口，然后等你拍。'), true,
    '「上一轮」+「下一步/等你拍」仍须判编排泄漏');
  assert.strictEqual(aa.isOrchestrationLeak('下一步我先查一下日志再说'), true, '短编排话术仍须拦');
});

test('S6 源码锁: 短答案长度门槛不得退回 6 (2026-10-14)', () => {
  // 先剥掉行注释 —— 本文件的修复说明里会**引用**旧码原文, 不剥会被自己的注释误判。
  const src = require('node:fs').readFileSync(require.resolve('../modules/answer_alignment'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /if \(a\.length < 6\) return false;/,
    '短答案长度门槛一旦退回 6, 「2」「收到」这类正确答案会重新被清空');
  assert.match(src, /_wantsDirect && a\.length < 12\) return true;/,
    '短答案豁免必须挂在「问题在索要直接答案」这个条件上 —— 无条件放行短答案会把'
    + '「检查路由 bug」答「天气不错」这种短而跑题的也放过去 (answer-alignment.test.js:42)');
});
