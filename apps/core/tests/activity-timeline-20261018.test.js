// 2026-10-18 老板两张截图 → 一条改造: 「这两个不要放最上面, 应该算是盘古的回答吧, 放左边,
// 另外调用工具或者思考按照你的这样子一个一个往下走, 这样用户知道盘古还活着, 现在这样一直感觉死的」
//
// 病根 (不是布局问题, 是数据被前端扔了):
//   ChatRoom.jsx 原来第 20 行 `const SHOW_TOOL_CARDS = false`, 加上 visibleMessages 里
//   把 tool_call / tool_result **整条过滤掉** —— 从 2026-10-09 起, 工具调用在界面上
//   **一次都没出现过**。老板 10-09 的原话是嫌一屏十几张 system_info/process_list 卡片
//   把真正的回答挤到很下面; 10-18 的原话是「还是没有任何显示」。两个极端打的是同一个开关。
//
// 改法: 一行一事件 (ActivityLine), 既不是卡片也不是隐藏。
//   · 工具/思考/子Agent 动作 → 消息流里**靠左、无气泡、无页脚**, 按到达时间一条条往下走
//   · tool_call push 新行, tool_result 按 id 合并回同一行 (所以"在读文件"会变成"读完了")
//   · thinking 增量原地更新 thinkChars, phase!=='on' 收口
//   · 顶部只留 pulse (心跳) + prefill (等首 token) + activeProgress, 不再堆面板
//   · SubAgentPanel 从消息区**上方**搬到**末尾** —— 原来钉在顶上, 跟下面盘古的话
//     时间完全对不上, 看着像另一个窗口的产物
//
// 实机依据 (2026-10-18, 本地 qwen3.8-27b-mlx @ LM Studio :1234, execution_path=j2-native):
//   前端真正调的端点是 `/api/pangu/agent/stream` (ChatRoom.jsx 的 fetch), **不是** `/message/stream`
//   —— 后者不做子 agent 编排。两者最终都进 `_runAgentLoopLegacyStream`/`j2-native` 的
//   _runAgentLoop, 所以事件源一样, 但验收必须打前者。
//   SSE 实收事件: gua / status / sub_agent_progress(thinking_chars 0→1066 在涨) /
//   heartbeat / thinking{phase,chars} / agent_progress / execution_path。
//   `event: thinking` 的发射点在 j2_agent_loop.js:1723 `_emitReason`, 载荷
//   `{phase:'on'|'off', chars, ts}` —— 子 agent 阶段的思考被 subagent_runner.js:95
//   消费成 `sub_agent_progress`, 所以两种阶段客户端都得接, 只接一种就有一段是死的。
//
// ── 2026-10-26 第 107 批 (桌面端下线) ──
// 这个文件原来是**纯前端**守卫: 它一条条查 "ChatRoom.jsx 必须监听 X 事件 /
// 必须 setMessages 落进消息流 / 活动行必须靠左", 守的是"界面怎么画"。
// 界面随 apps/desktop 一起下线 ⇒ 这些断言全部失去对象。
//
// 但老板那句话的**内核不是"画成什么样"**, 是
// 「**调用工具或者思考一个一个往下走, 这样用户知道盘古还活着**」
// —— 也就是: **这些活动事件必须真的发出去, 载荷必须带得上判断所需的字段**。
// 这一半是**服务端**的责任, 与有没有界面无关, 所以本文件原地改成
// **「活动事件契约」守卫**: 逐个事件断言"服务端发得出来 + 载荷字段齐全"。
//
// 换句话说: 原来守"客户端收不收", 现在守"服务端发不发、发得全不全"。
// 意图一个字没松 —— 反而更准: 以前前端一改, 这条守卫就得跟着改; 现在它只盯服务端。
//
// 全部静态断言源码, **不发任何真实请求** (不烧任何额度)。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const CORE = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(CORE, rel), 'utf8');

// 服务端全部发事件的地方。派发链路 2026-10-17 拆进了两个文件, 只读一个
// 就等于对搬家后的真正出事点失明 (同 subagent-progress-task-key 的教训)。
const DISPATCHER = read('modules/j2_dispatcher.js');
const RUNNER = read('modules/subagent_runner.js');
const LOOP = read('modules/j2_agent_loop.js');
const SHARED = read('modules/j2_loop_shared.js');
const DISPATCH = DISPATCHER + '\n' + RUNNER;

/**
 * 剥注释。
 *
 * 为什么必须剥: 源码注释里会**引用事件名** (比如 "S8 那条测试取窗口找
 * `event: thinking`") —— 不剥的话 indexOf 命中的是注释, 断言就去检查一段
 * 根本不存在的载荷。踩坑日志第 9 条: 断言扫到自己的注释。
 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
}

/**
 * 取某个事件的**发射点前后**一段, 用来断言载荷字段。
 *
 * 两个坑 (都踩过):
 *   ① 载荷对象是在写入点**之前**构造的 (`res.write('event: X\ndata: ' +
 *      JSON.stringify(payload))` 里 payload 单独一行一行写的) ⇒ 只往后切会切掉载荷。
 *   ② 两种发射写法并存: 主循环用 `res.write('event: X\\ndata: '...)`,
 *      派发链用 `safeResWrite(res, 'X', {...})` ⇒ 两种都要认。
 */
function emitSeg(src, eventName) {
  const code = stripComments(src);
  const markers = [
    'event: ' + eventName + '\\ndata: ',       // 主循环写法 (源码里 \n 是转义的两个字符)
    "safeResWrite(res, '" + eventName + "'",     // 派发链写法
    'event: ' + eventName,
  ];
  let at = -1;
  for (const m of markers) {
    const i = code.indexOf(m);
    if (i > 0) { at = i; break; }
  }
  assert.ok(at > 0, '要能找到 event: ' + eventName + ' 的发射点');
  return code.slice(Math.max(0, at - 1500), at + 1200);
}

/** 这个事件名在源码里有没有对应的发射点 (两种写法都认) */
function hasEvent(src, eventName) {
  const code = stripComments(src);
  return code.includes('event: ' + eventName + '\\ndata: ')
    || code.includes("safeResWrite(res, '" + eventName + "'")
    || code.includes('event: ' + eventName);
}

test('活动事件一个都不能少: 服务端必须真的发出去', () => {
  // 少发一个 = 客户端有一段是死的。老板的原话: 「感觉盘古死了」。
  const ALL = LOOP + '\n' + DISPATCH + '\n' + SHARED;
  const required = [
    'tool_call',         // 工具调用
    'tool_result',       // 工具收口
    'thinking',          // 思考相位
    'heartbeat',         // 心跳
    'agent_progress',    // prefill 进度
    'plan',              // 计划
    'status',            // 阶段状态
    'stream_delta',      // 正文流
    'sub_agent_start',
    'sub_agent_progress',
    'sub_agent_done',
    'sub_agent_error',
    'final',
  ];
  for (const ev of required) {
    assert.ok(hasEvent(ALL, ev),
      '服务端必须发 event: ' + ev + ' —— 不发就是"客户端看不见 = 感觉死了"');
  }
});

test('tool_call / tool_result 必须成对, 且带 id —— 客户端靠 id 把结果对回调用', () => {
  const call = emitSeg(LOOP, 'tool_call');
  assert.match(call, /calls:/, 'tool_call 载荷必须带 calls 数组');
  assert.match(call, /id:/, 'tool_call 的每条必须带 id (靠它配对 tool_result)');
  assert.match(call, /name:/, 'tool_call 的每条必须带 name');
  assert.match(call, /params:/, 'tool_call 的每条必须带 params —— 不带参数客户端显示不出"在干什么"');
  const result = emitSeg(LOOP, 'tool_result');
  assert.match(result, /id:/, 'tool_result 必须带 id');
  assert.match(result, /\bok:/, 'tool_result 必须带 ok —— 客户端要一眼看出成没成');
  assert.match(result, /result:/, 'tool_result 必须带 result');
});

test('thinking 必须带 phase 与 chars —— 客户端靠这两个判断"还在动"', () => {
  const seg = emitSeg(LOOP, 'thinking');
  assert.match(seg, /phase:\s*on\s*\?\s*'on'\s*:\s*'off'/,
    "thinking 载荷要有 phase (客户端靠 phase!=='on' 收口)");
  assert.match(seg, /chars:/,
    'thinking 载荷要有 chars (客户端靠 chars 在涨证明模型在动)');
});

test('agent_progress 必须带 prefill 相位与耗时 —— 41 秒死寂就是这一段', () => {
  const seg = emitSeg(SHARED, 'agent_progress');
  assert.match(seg, /phase:\s*'prefill'/, 'agent_progress 必须标 phase=prefill');
  assert.match(seg, /elapsed_ms/, 'agent_progress 必须带 elapsed_ms');
  assert.match(seg, /total_ms/, 'agent_progress 必须带 total_ms (跨轮累计, 不然计时器每轮归零)');
});

test('sub_agent 三件套必须带 agent + task —— 客户端靠 agent+task 认领是哪一刀', () => {
  for (const ev of ['sub_agent_start', 'sub_agent_progress', 'sub_agent_done']) {
    const seg = emitSeg(DISPATCH, ev);
    assert.match(seg, /agent:/, ev + ' 必须带 agent');
    assert.match(seg, /task:/, ev + ' 必须带 task —— 三个同角色并行刀只能靠 task 区分');
  }
  const err = emitSeg(DISPATCH, 'sub_agent_error');
  assert.match(err, /agent:/, 'sub_agent_error 必须带 agent');
  assert.match(err, /error:/, 'sub_agent_error 必须带 error');
});

test('plan 的两种载荷形状都要能发出来 (客户端靠归一后才知道画不画)', () => {
  // 形状 A (j2_agent_loop): { plan_id, steps: PlanStep[], summary, risks }
  // 形状 B (j2_dispatcher): { plan: [{agent,task}], note }
  // 形状 B 恰恰是最常见的路径 (简单问题 skip_planner / 长任务 planner)。
  // 服务端两种都在发 —— 客户端归一是客户端的事, 这里只保证"发得出来"。
  assert.ok(hasEvent(LOOP, 'plan'), 'j2_agent_loop 必须发 plan (形状 A)');
  assert.ok(hasEvent(DISPATCH, 'plan'), 'dispatcher 必须发 plan (形状 B)');
  const seg = emitSeg(DISPATCH, 'plan');
  assert.match(seg, /plan:/, '形状 B 的 plan 载荷必须带 plan 数组');
});

test('status 必须带 stage —— planner 死区(130s 无事件)靠它', () => {
  const seg = emitSeg(LOOP, 'status');
  assert.match(seg, /stage/, 'status 必须带 stage (客户端靠它区分"在规划"和"失败了")');
});

test('sub_agent_queue 必须单独分流 —— 它是"刀在跑但没抢到槽位"的那条信号', () => {
  // 排队等待正是"感觉死的"最典型形态: 刀在跑, 只是没抢到槽位。
  const at = DISPATCH.indexOf("stage: 'sub_agent_queue'");
  assert.ok(at > 0, '服务端必须发 sub_agent_queue');
  const seg = DISPATCH.slice(at - 400, at + 400);
  assert.match(seg, /safeResWrite\(res, 'status'/,
    'sub_agent_queue 走 status 通道, 带 stage=sub_agent_queue —— 客户端靠它显示排队行');
});

test('stream_delta 必须带 delta 正文 —— 只发字数计数等于没流式', () => {
  const seg = emitSeg(DISPATCH, 'stream_delta');
  assert.match(seg, /delta/, 'stream_delta 必须带 delta');
});
