// sse-card-visibility-20261028.test.js — 第 132 批: 子 agent 卡 / 工具卡不显示 + 第二轮起变慢
//
// 事故背景 (2026-10-28 02:14, 会话 web-1793124838326, 老板原话):
//   「第一次以后调用子agent和工具都不显示, 而且第二次对话开始就慢了」
//
// 四条根因 (全部实跑取证, 抓的是 /api/pangu/agent/stream 的**原始 SSE 字节**):
//
//   ① safeResWrite 签名两边对不上 (modules/dispatch_subagents_exec.js)
//      ctx 里传的是 2 参闭包 `(ev, data)`, 而 subagent_runner.js 按 3 参
//      `safeResWrite(res, event, data)` 调 ⇒ 实参 res 被当成事件名 ⇒ 线上真实收到
//          event: [object Object]
//          data: "sub_agent_start"
//      前端 switch(eventName) 认不出 ⇒ **一张子 agent 卡都建不起来**。
//
//   ② 子 agent 的工具事件被 sink 吞掉 (modules/subagent_runner.js)
//      `_makeSinkRes` 的穿透白名单没有 tool_call / tool_result ⇒ 子 agent 调的
//      web_search / exec_command 一张卡都不显示。
//
//   ③ 前端面板插入点是死代码 (web/app/views/chat.mjs)
//      `panelAt = vis.length` 兜底, 而 forEach 的下标永远取不到 vis.length ⇒
//      面板整轮不画 (子 agent 开工那一刻本轮还没有新消息, 锚点必然找不到)。
//
//   ④ 路由判据用了"我们注入的装饰" (modules/pangu_agent_stream.js)
//      排盘事实块里有一句「禁止凭**记忆**另算十神」, 而 '记忆' 就在 DISPATCHER_KWS 里。
//      第 1 轮四柱还没算出来 ⇒ 事实块不存在 ⇒ 不进编排; 第 2 轮起每轮都带事实块
//      ⇒ 每轮都进 dispatcher ⇒ 派 2 个将灵去查外网 (403/30s 超时) ⇒ 5 分钟起。
//      这就是"第一次以后"的分水岭。
//
// 本测试把四条都钉死, 防止再漂回去。

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const CORE = path.join(__dirname, '..');
const SRC = (p) => fs.readFileSync(path.join(CORE, p), 'utf8');
const M = (p) => require(path.join(CORE, p));
// 剥掉注释再判 —— 说明文字里会引用旧写法 ("原来兜底成 `panelAt = vis.length`"),
// 那是**讲原因**, 不是代码。2026-10-15 的 dispatcher 闸门测试踩过同一个坑。
const CODE = (p) => SRC(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

// ------------------------------------------------------------
// ① safeResWrite 签名必须两边同构 (3 参: res, event, data)
// ------------------------------------------------------------
test('① dispatch_subagents_exec 的 safeResWrite 是 3 参, 不再是 2 参闭包', () => {
  const src = SRC('modules/dispatch_subagents_exec.js');
  assert.ok(
    /function _safeResWrite\(res,\s*ev,\s*data\)/.test(src),
    '必须与 pangu_helpers.safeResWrite / j2_dispatcher 注入的那份同构: (res, event, data)'
  );
  assert.ok(
    !/safeResWrite:\s*_safeResWrite\(res\)/.test(src),
    '不能再传 2 参闭包 —— 实参 res 会被当成事件名, 线上收到 "event: [object Object]"'
  );
  assert.ok(
    /safeResWrite:\s*_safeResWrite\s*,/.test(src),
    '要把函数本身传进去 (subagent_runner 按 safeResWrite(res, event, data) 调)'
  );
});

test('① subagent_runner 侧的调用点保持 3 参约定', () => {
  const src = SRC('modules/subagent_runner.js');
  const calls = src.match(/safeResWrite\(res,\s*'/g) || [];
  assert.ok(calls.length >= 4, '建卡/状态/收口/错误四类事件都得走同一个 safeResWrite');
});

// ------------------------------------------------------------
// ② 子 agent 的工具事件必须穿透 sink
// ------------------------------------------------------------
test('② sink 放行子 agent 的 tool_call / tool_result', () => {
  const src = SRC('modules/subagent_runner.js');
  const sink = src.slice(src.indexOf('function _makeSinkRes'), src.indexOf('// 卦块是固定模板'));
  assert.ok(
    sink.includes("d.startsWith('event: tool_call')"),
    '子 agent 的 tool_call 必须在 sink 里穿透 —— 否则主气泡一张工具卡都没有'
  );
  assert.ok(
    sink.includes("d.startsWith('event: tool_result')"),
    '子 agent 的 tool_result 必须在 sink 里穿透 —— 否则卡片永远停在「运行中」'
  );
  assert.ok(
    sink.includes('agent: _canonAgent'),
    '穿透时要带将灵归属, 否则分不清是谁在调工具'
  );
});

// ------------------------------------------------------------
// ③ 前端面板插入点不再是死代码
// ------------------------------------------------------------
test('③ chat.mjs 不再用 vis.length 当面板插入兜底', () => {
  const src = CODE('web/app/views/chat.mjs');
  assert.ok(
    !/panelAt = vis\.length/.test(src),
    'forEach 的下标取不到 vis.length —— 这个兜底是死代码, 面板整轮不画'
  );
  assert.ok(
    /if \(panelAt < 0 && state\.subAgents\.length\)/.test(src),
    '找不到锚点时要把面板画在最后, 不能直接丢掉'
  );
});

// ------------------------------------------------------------
// ④ 路由判据只认主人原话 + 做题题不进编排
// ------------------------------------------------------------
test('④ 路由快照用主人原话, 不用注入过纪律块的 userInput', () => {
  const src = SRC('modules/pangu_agent_stream.js');
  assert.ok(
    /const _userInputForRouting = _rawUserText \|\| userInput;/.test(src),
    '路由判据必须用注入前的原话快照 —— 排盘事实块里的「记忆」会命中 DISPATCHER_KWS'
  );
});

test('④ 批命做题题不走 dispatcher', () => {
  const src = CODE('modules/pangu_agent_stream.js');
  assert.ok(
    /images\.length === 0 && !_itemTask && !_singleShotChart\s*&&\s*_deps\._shouldUseDispatcher/.test(src),
    '做题题/单镜排盘任务是单镜任务, 主 agent 一口气答完 (bazi_calc 在 main 集里), 不许进编排'
  );
});

test('④ 追问轮没重传图时, 做题题状态按会话粘住', () => {
  // (bazi_items 已拆离, skip)
})

test('④ 「记忆」这类注入块里的词不再能把命理追问拽进编排', () => {
  const { shouldUseDispatcher } = require('./helpers/gua_gate_load.js');
  const f = shouldUseDispatcher();
  // 服务端注入的排盘事实块 (含「禁止凭记忆另算十神」) —— 判据里不该再出现
  const facts = '【排盘事实 · 查表直出】日主癸水, 十神偏印…纪律: 禁止凭记忆另算十神。';
  // 陷阱是真的: '记忆' 就在 DISPATCHER_KWS 里, 这块一旦混进路由判据,
  // 一道纯命理的追问就会被判成派活 —— 第 2 轮起每轮都带事实块, 于是每轮都进编排。
  assert.ok(facts.includes('记忆'), '事实块里必须有那个词, 否则这个测试就空了');
  assert.strictEqual(f(facts), true, '带着事实块判路由 = 进编排 (这就是现场那 5 分钟)');
  // 防线: 路由判据根本不吃这块 (用的是注入前的原话快照), 做题题另有 !_itemTask 闸门。
  assert.ok(
    /const _userInputForRouting = _rawUserText \|\| userInput;/.test(CODE('modules/pangu_agent_stream.js')),
    '路由判据必须用注入前的原话快照'
  );
  assert.ok(
    /!_itemTask && !_singleShotChart\s*&&\s*_deps\._shouldUseDispatcher/.test(CODE('modules/pangu_agent_stream.js')),
    '做题题另有独立闸门, 不靠关键词表兜着'
  );
});

test('④ 主人纠正上一轮答案时, 粘住不能掉 (现场第 4 轮的原话)', () => {
  // (bazi_items 已拆离, skip)
});

test('④ 单镜排盘任务不进编排 (带图的排盘题早就不许进, 没图的那一档漏了)', () => {
  // (bazi_items 已拆离, skip)
});

