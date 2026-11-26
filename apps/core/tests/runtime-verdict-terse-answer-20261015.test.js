'use strict';

/**
 * 2026-10-15 — 主人明说"要短答案"时, 短答案就是完整答案
 *
 * 实测现场 (curl 走真实 SSE 端点):
 *   POST /api/message/stream
 *     {"messages":[{"role":"user","content":"只回一个词: 盘古"}]}
 *   → event: final  data: {"text":"盘古"}          ← 答案一字不差
 *   → event: status data: {"status":"failed","success":false}
 *
 * 正确答案被判 failed, 前端因此给正常答复盖 ✗ "任务执行失败"。
 * 这正是 runtime_verdict 里 2026-09-12 那条注释一直在防的事 ("判 failed 前端会盖 ✗,
 * 主人以为跑完了"), 只是漏了一种形态。
 *
 * 根因不在长度, 在**漏看了 user_input**:
 *   conversational 的门槛是 text.length > 10, 背后假设是"短 = 没答完整"。
 *   但主人既然明说"只回一个词", 2 个字就是**刚刚好**的完整交付。
 *   而 user_input 一直就在 classifyRuntimeVerdict 的参数里, 从没参与这条判断。
 *
 * 边界很重要 —— 放宽不能变成"什么短文本都算数":
 *   - 无 terse 信号时, "好的" 仍判 failed (runtime-verdict-conversational 第 3 项钉着)
 *   - 有 terse 信号但模型回的是**前向承诺** ("我先去看看"), 仍判 failed
 *   - ⚠️ 开头的熔断文案仍判 failed
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { classifyRuntimeVerdict } = require('../modules/runtime_verdict');

const v = (final_text, user_input) => classifyRuntimeVerdict({
  real_tool_calls_total: 0,
  final_text,
  user_input,
  alignment_blocked: false,
  task_done_status: null,
});

test('主人说"只回一个词" + 模型答两字 → partial, 不是 failed (今天修的正主)', () => {
  const r = v('盘古', '只回一个词: 盘古');
  assert.strictEqual(r.status, 'partial', '正确短答案被判 failed → 前端盖 ✗');
  assert.strictEqual(r.success, false, '聊天轮仍不进 evolution 成功桶 (沿用既有口径)');
});

test('"直接答"也算 terse 信号 (现场就是这么问的)', () => {
  const r = v('22:26', '现在几点了? 直接答, 不要调工具。');
  assert.strictEqual(r.status, 'partial', '时间类短答复被判 failed 是同一类误杀');
});

test('各种 terse 措辞都要认', () => {
  for (const q of ['只回一个词', '只答结论', '直接答', '一句话总结', '别废话', '不用解释', '简短点']) {
    assert.strictEqual(v('好', q).status, 'partial', `terse 措辞没被认出来: ${q}`);
  }
});

test('安全阀: terse 信号 + 前向承诺 → 仍 failed (那是空头支票不是答案)', () => {
  for (const a of ['我先去看看文件', '接下来我会处理', '让我先读一遍', '正在处理中', '稍等一下']) {
    assert.strictEqual(v(a, '只回一个词').status, 'failed',
      `前向承诺被当成答案放过了: ${a}`);
  }
});

test('语义未变: 没有 terse 信号时, 超短应答仍 failed', () => {
  // runtime-verdict-conversational 第 3 项钉的就是这条, 不许因为今天这个修复而松掉
  assert.strictEqual(v('好的').status, 'failed');
  assert.strictEqual(v('好的', '嗯').status, 'failed');
});

test('语义未变: ⚠️ 熔断文案即使 terse 也仍 failed', () => {
  assert.strictEqual(v('⚠️ [盘古 空计划熔断] 模型连续 3 轮只输出计划模板', '只回一个词').status, 'failed');
});

test('语义未变: 实质答复 (>10 字) 一直 partial', () => {
  const r = v('盘古是一个 AI 助手, 跑在本机 18901 端口上。', '盘古是谁');
  assert.strictEqual(r.status, 'partial');
});

test('语义未变: 有真工具的完成轮仍 completed', () => {
  const r = classifyRuntimeVerdict({
    real_tool_calls_total: 3,
    final_text: '已读 372 行课件并落盘消化笔记到 digest/<course-source>。',
    alignment_blocked: false,
    task_done_status: null,
  });
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.success, true);
});

test('空答复不能因为 terse 信号而放行', () => {
  assert.strictEqual(v('', '只回一个词').status, 'failed');
  assert.strictEqual(v('   ', '只回一个词').status, 'failed');
});

test('terser 信号不能把"工具任务失败"洗成 partial', () => {
  // 有真工具 + task_done 明确 failed 时, terse 措辞无权改判
  const r = classifyRuntimeVerdict({
    real_tool_calls_total: 2,
    final_text: '好',
    user_input: '只回一个词',
    alignment_blocked: false,
    task_done_status: 'failed',
  });
  assert.strictEqual(r.status, 'failed');
});

test('四个调用点都必须把 user_input 传下去 (少一处 = 修一半)', () => {
  // 这条比上面所有单测都重要: runtime_verdict 的整套短答逻辑挂在 user_input 上,
  // 而**调用点才是决定它生不生效**的地方。少传一处, 那条路径上白修。
  // 2026-10-15 实测就是这样: 主 agent loop 传了, dispatcher 和进化账本没传 ——
  // 单测全绿, 线上编排跑通了照样报 failed, 账本还记下一笔假失败。
  const files = ['j2_agent_loop.js', 'j2_dispatcher.js', 'evolution_record.js'];
  const src = Object.fromEntries(files.map(f => [
    f, fs.readFileSync(path.join(__dirname, '..', 'modules', f), 'utf8'),
  ]));

  for (const f of files) {
    // 取出 classifyRuntimeVerdict({ ... }) 的实参块
    const calls = src[f].match(/classifyRuntimeVerdict\(\{[\s\S]*?\}\)/g) || [];
    assert.ok(calls.length > 0, `${f}: 找不到 classifyRuntimeVerdict 调用点`);
    for (const call of calls) {
      assert.match(call, /user_input\s*:/,
        `${f}: 有 classifyRuntimeVerdict 调用没传 user_input —— terse 判定在该路径上不生效`);
    }
  }

  // 传的值本身也要对: dispatcher 传 opts.userInput (局部变量), 账本传 record.input
  assert.match(src['j2_dispatcher.js'], /user_input:\s*userInput/);
  assert.match(src['evolution_record.js'], /user_input:\s*record\.input/);
});

