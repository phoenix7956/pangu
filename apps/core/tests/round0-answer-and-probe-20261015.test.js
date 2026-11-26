'use strict';
// 2026-10-15 两个「本地 27B 慢 / 跟死了一样」的真因
//
// ① 强逼工具闸门把 2 秒的正确答案变成 4 分钟卡死 (j2_agent_loop.js)
//    实测 (LM Studio / qwen3.8-27b-mlx, /tmp/pangu-single.log + server-logs):
//      模型第 0 轮就答对了 "跑在本机、以64卦为内核的谋断AI。"
//      但 `round >= 1 || len >= 120` 不成立 → 答复被丢弃 → 追问"请调用一个工具"
//      → 模型调了个毫不相干的 current_time → 下一轮 23.6k token 提示词 prefill 83s 空转。
//
// ② tool_call 探测跑满 4 次, 但判定线是"一次成功即 native" (j2_helpers.js)
//    attempt=0 就 probeOk=true 了, 后 3 次改不了结论 —— LM Studio 日志实测每次 ~3.5s,
//    白扔 ~10s/进程。失败路径仍必须跑满 4 次 (区分"偶发不调工具" vs "真 legacy")。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const j2 = require('../modules/j2_helpers');

function toolCallResult() {
  return { choices: [{ message: { content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'echo', arguments: '{"msg":"t"}' } }] } }] };
}
function cleanTextResult() {
  return { choices: [{ message: { content: 'I cannot call tools.', tool_calls: null } }] };
}

test('探测: 第一次就成功 → 只发 1 次请求, 不再白烧后 3 次', async () => {
  j2.invalidateToolCallSupportCache();
  let calls = 0;
  const fakeLLM = async () => { calls++; return toolCallResult(); };
  const supported = await j2._detectToolCallSupport({ id: 'probe-early-exit-1' }, fakeLLM);
  assert.equal(supported, true, '一次成功必须判 native');
  assert.equal(calls, 1, '判定线是 supportedCount>=1, 成功后必须立刻 break, 实际发了 ' + calls + ' 次');
});

test('探测: 第 2 次才成功 → 发 2 次就停', async () => {
  j2.invalidateToolCallSupportCache();
  let calls = 0;
  const fakeLLM = async () => { calls++; return calls === 1 ? cleanTextResult() : toolCallResult(); };
  const supported = await j2._detectToolCallSupport({ id: 'probe-early-exit-2' }, fakeLLM);
  assert.equal(supported, true);
  assert.equal(calls, 2, '成功后必须立刻 break, 实际发了 ' + calls + ' 次');
});

test('探测: 4 次全干净 (无 tool_calls) 仍跑满 4 次 —— 才能判真 legacy', async () => {
  j2.invalidateToolCallSupportCache();
  let calls = 0;
  const fakeLLM = async () => { calls++; return cleanTextResult(); };
  await j2._detectToolCallSupport({ id: 'probe-all-clean-1' }, fakeLLM);
  assert.equal(calls, 4, '失败路径必须跑满 4 次, 实际发了 ' + calls + ' 次');
});

test('探测: 4 次全异常 (transient) 仍跑满 4 次, 且不缓存 false', async () => {
  j2.invalidateToolCallSupportCache();
  let calls = 0;
  const fakeLLM = async () => { calls++; throw new Error('ECONNRESET'); };
  await j2._detectToolCallSupport({ id: 'probe-all-throw-1' }, fakeLLM);
  assert.equal(calls, 4, 'transient 路径必须跑满 4 次, 实际发了 ' + calls + ' 次');
  const cache = j2._getToolCallSupportCache();
  assert.equal(cache['probe-all-throw-1'], undefined, 'transient 全失败不能缓存 false, 下次要重探');
});

test('强逼工具闸门: 第 0 轮的干净直接回答必须被收下, 不再强逼工具', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  const guardAt = src.indexOf('ROUND0_ANSWER_ACCEPTED');
  const forceAt = src.indexOf('请调用一个工具完成任务');
  assert.ok(guardAt > 0, 'ROUND0_ANSWER_ACCEPTED 守卫必须存在');
  assert.ok(forceAt > 0, '强逼工具分支必须存在');
  assert.ok(guardAt < forceAt, '守卫必须在强逼工具之前, 否则永远不会生效');
  // 谓词必须是模块级常量 —— 原 _PROMISE_RE 声明在 indent 12 的嵌套块里, 这里引用不到
  assert.match(src, /^const _J2_PROMISE_TEXT_RE = \/让[\s\S]*?\/;$/m);
  assert.match(src, /if \(round === 0 && !taskDoneAccepted && toolsUsed\.length === 0[\s\S]*?!_J2_PROMISE_TEXT_RE\.test\(textContent\)\) \{/);
});

test('强逼工具闸门: 承诺型文本仍然要逼工具 (不能把"我来查一下"当答案放走)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  const m = src.match(/^const _J2_PROMISE_TEXT_RE = \/(.+)\/;$/m);
  assert.ok(m, '_J2_PROMISE_TEXT_RE 必须能取到');
  const re = new RegExp(m[1]);
  for (const p of ['让我先看看', '我来查一下', '接下来我读一下文件', '我先调工具确认']) {
    assert.ok(re.test(p), '「' + p + '」是承诺不是答案, 必须继续逼工具');
  }
  for (const a of ['跑在本机、以64卦为内核的谋断AI。', '盘古是本地部署的智能体。', '股价约 180 美元。']) {
    assert.ok(!re.test(a), '「' + a + '」是直接回答, 不该被判成承诺');
  }
});
