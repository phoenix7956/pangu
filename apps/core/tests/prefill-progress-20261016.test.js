// 2026-10-16 「跟死了一样」的最后一块: prefill 期间的用户可见进度
//
// 现场实测 (qwen3.8-27b-mlx @ lmstudio :1234, 主人只问了一句「1+1等于几」):
//   HTTP 响应头 20ms 到达, 第一个 SSE 字节 41,081ms —— 41 秒纯死寂。
//   对照: 同前缀第二次 TTFB 只有 892ms → 前缀缓存是好的, 死寂是缓存未命中那轮的代价。
//
// 为什么已有的心跳救不了场: pangu_agent_stream 的 attachSseHeartbeat 发的是 SSE **注释行**
// (`: keepalive`), 它只保 TCP 连接, 前端一个字符都渲染不出来, 界面照样全黑。
// 所以这一刀要的不是"再保一次活", 是发一条**渲染得出来**的事件。
//
// 分两层测:
//   A 组 = helper 的行为 (幂等 / 断连自停 / 没有 res 也不炸 / payload 形状)
//   B 组 = 行为层反证: 假模型在 prefill 上真停一会儿, 让 j2 主循环真跑一遍,
//         断言进度事件出现在**首个正文 delta 之前**, 且之后不再出现。
//         "源码里有没有接线"那种断言挡不住"接线还在、行为已经变了"。
//
// ── 2026-10-26 第 107 批 (桌面端下线) ──
// C 组 (前端认不认 agent_progress / 谁负责清 prefill / 不许并进 progress 通道)
// 随 apps/desktop 一起下线, 一起删。
// 它们守的**服务端那一半**没丢, 由 A/B 组继续守着:
//   A 组 —— helper 的 payload 形状 (phase / elapsed_ms / total_ms / input_tokens)
//   B 组 —— 进度必须早于首个正文 delta, 且首个正文之后必须停
// 而"agent_progress 不许并进计划进度通道"这条分通道意图, 由
// tests/activity-timeline-20261018.test.js 的事件契约守卫接着守。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const M = (p) => require(path.join(__dirname, '..', p));
const SHARED = M('modules/j2_loop_shared.js');

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

function _fakeRes() {
  const events = [];
  const handlers = {};
  return {
    events,
    writeHead() {}, setHeader() {}, flushHeaders() {},
    write(c) { events.push(String(c)); return true; },
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    emit(ev) { (handlers[ev] || []).forEach(fn => { try { fn(); } catch (_) {} }); },
    aborted: false, writableEnded: false, end() {},
  };
}

function _progressEvents(res) {
  return res.events
    .filter(e => e.startsWith('event: agent_progress'))
    .map(e => {
      const m = e.match(/data: (\{.*\})/);
      try { return m ? JSON.parse(m[1]) : null; } catch (_) { return null; }
    })
    .filter(Boolean);
}

// ---------- A 组: helper 行为 ----------

test('P1 t=0 必须立刻发第一条 —— 等一个间隔才出现, 等于没解决"像死了"', async () => {
  process.env.PANGU_PREFILL_PROGRESS_MS = '80';
  const res = _fakeRes();
  const stop = SHARED._startPrefillProgress(res, { input_tokens: 11000, model: 'qwen3.8-27b-mlx' });
  const now = _progressEvents(res);
  assert.strictEqual(now.length, 1, 'start 后同步就该有 1 条, 不能等第一个 interval');
  stop();
  delete process.env.PANGU_PREFILL_PROGRESS_MS;
});

test('P2 等待期间必须周期发, 且 payload 带得上排障需要的字段', async () => {
  process.env.PANGU_PREFILL_PROGRESS_MS = '50';
  const res = _fakeRes();
  const stop = SHARED._startPrefillProgress(res, { input_tokens: 11000, model: 'qwen3.8-27b-mlx' });
  await _sleep(220);
  stop();
  const evs = _progressEvents(res);
  assert.ok(evs.length >= 3, '220ms / 50ms 间隔至少 3 条, 实际 ' + evs.length);
  assert.strictEqual(evs[0].type, 'agent_progress');
  assert.strictEqual(evs[0].phase, 'prefill');
  assert.strictEqual(evs[0].input_tokens, 11000);
  assert.strictEqual(evs[0].model, 'qwen3.8-27b-mlx');
  assert.ok(evs[evs.length - 1].elapsed_ms > evs[0].elapsed_ms, 'elapsed 必须单调递增, 否则前端进度条会倒退');
  delete process.env.PANGU_PREFILL_PROGRESS_MS;
});

test('P3 stop 之后一条都不能再多发 (漏清定时器 = 每 3 秒往死响应上刷一次)', async () => {
  process.env.PANGU_PREFILL_PROGRESS_MS = '30';
  const res = _fakeRes();
  const stop = SHARED._startPrefillProgress(res, { input_tokens: 100, model: 'm' });
  await _sleep(120);
  stop();
  const at = _progressEvents(res).length;
  await _sleep(200);
  assert.strictEqual(_progressEvents(res).length, at, 'stop 之后计数必须冻结');
  delete process.env.PANGU_PREFILL_PROGRESS_MS;
});

test('P4 stop 必须幂等 —— 成功/失败/抛错/断连四条出口都会调它', async () => {
  process.env.PANGU_PREFILL_PROGRESS_MS = '30';
  const res = _fakeRes();
  const stop = SHARED._startPrefillProgress(res, { input_tokens: 100, model: 'm' });
  stop(); stop(); stop();
  const at = _progressEvents(res).length;
  await _sleep(150);
  assert.strictEqual(_progressEvents(res).length, at, '重复 stop 不能再触发任何写入');
  delete process.env.PANGU_PREFILL_PROGRESS_MS;
});

test('P5 客户端断连 (res close) 必须自停, 不靠调用方记得清', async () => {
  process.env.PANGU_PREFILL_PROGRESS_MS = '30';
  const res = _fakeRes();
  SHARED._startPrefillProgress(res, { input_tokens: 100, model: 'm' });
  await _sleep(100);
  res.emit('close');
  const at = _progressEvents(res).length;
  await _sleep(180);
  assert.strictEqual(_progressEvents(res).length, at, 'close 之后必须停');
  delete process.env.PANGU_PREFILL_PROGRESS_MS;
});

test('P6 写失败自停 —— 不能因为响应已死而无限刷异常', async () => {
  process.env.PANGU_PREFILL_PROGRESS_MS = '30';
  let calls = 0;
  const res = {
    events: [], writeHead() {}, setHeader() {}, flushHeaders() {}, on() {}, end() {},
    write(c) { calls += 1; this.events.push(String(c)); if (calls > 2) throw new Error('ERR_STREAM_WRITE_AFTER_END'); return true; },
  };
  SHARED._startPrefillProgress(res, { input_tokens: 100, model: 'm' });
  await _sleep(250);
  assert.ok(calls <= 3, '写炸了就该停, 实际还在写 ' + calls + ' 次');
  delete process.env.PANGU_PREFILL_PROGRESS_MS;
});

test('P7 没有 res / res 不支持 write 时返回可调用的 stop, 不能抛', () => {
  const a = SHARED._startPrefillProgress(null, { input_tokens: 1, model: 'm' });
  const b = SHARED._startPrefillProgress({}, { input_tokens: 1, model: 'm' });
  assert.doesNotThrow(() => { a(); b(); });
});

// ---------- B 组: 行为层反证 (假模型真跑 j2 主循环) ----------
//
// 必须子进程: j2 主循环有心跳 interval / 自动续跑 / 压缩分支, 跑完不一定让事件循环退出,
// 放主进程会把整个测试文件挂死 (continuity-and-harness-20261014 的 D1 已踩过)。
const _PROBE_SRC = (progressMs) => `
const path = require('path');
const fs = require('fs');
const os = require('os');
// 2026-10-16: 探针必须与真实状态目录隔离。
// 踩的是 role-gate-wiring 那个同样的坑: 固定 sessionId + 落盘到 ~/.pangu/state/ →
// 预算/checkpoint 跨轮累积 → 跑着跑着就先撞 max_rounds, 走另一条路发事件,
// 于是"进度必须早于首个正文 delta"这种顺序断言开始时红时绿 (实测 3 次里挂 1 次)。
// 必须在 require 之前改 —— budget.js / checkpoint.js 在模块加载期就把路径算死了。
process.env.PANGU_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu_prefill_legacy_'));
const CORE = ${JSON.stringify(path.join(__dirname, '..'))};
const J2 = require(path.join(CORE, 'modules', 'j2_agent_loop.js'));
const sse = [];
const res = { writeHead(){}, setHeader(){}, flushHeaders(){},
  write(c){ sse.push(String(c)); return true; }, on(){}, aborted:false, writableEnded:false, end(){} };
let turn = 0;
J2.init({
  // 这一组走 legacy (native=false), 因为 j2_agent_loop.js:3129 那个 for 循环写的是
  // \`!useNative && round < maxRounds\` —— legacy 的流式块整个包在这个条件里。
  //
  // 2026-10-16 教训: 第一版**只有**这一组, 全绿, 然后实机一次都没走到 ——
  // 生产走的是 j2-native (日志 [j2-path] path=j2-native), native 的 LLM 调用在
  // 另一处 (带 onText/onReasoning 回调), 跟这里的 for-await 没关系。
  // 「单测全绿 + 生产无效」就是这么发生的。native 那条路见下面 P11~P13。
  _detectToolCallSupport: async () => false,
  _callLLMForAgent: async () => {
    turn += 1;
    if (turn === 1) {
      return { choices: [{ message: { role:'assistant', content:'', tool_calls: [{
        id:'call_pp_1', type:'function', function:{ name:'exec_command',
        arguments: JSON.stringify({ command: 'echo hi' }) } }] } }],
        usage: { prompt_tokens: 11000, completion_tokens: 20 } };
    }
    return { choices: [{ message: { role:'assistant', content:'', tool_calls: [{
      id:'call_pp_done', type:'function', function:{ name:'task_done',
      arguments: JSON.stringify({ status:'completed',
        summary:'① 完成: 探针\\n② 证据: exec_command\\n③ 未做: 无\\n④ 交接: 无' }) } }] } }],
      usage: { prompt_tokens: 12000, completion_tokens: 30 } };
  },
  _callLLMForAgentStream: async function*(){
    await new Promise(r => setTimeout(r, ${progressMs * 6}));
    yield '探针正文';
    await new Promise(r => setTimeout(r, ${progressMs * 6}));
    yield '<tool name="task_done">{"status":"completed","summary":"① 完成: 探针"}</tool>';
  },
  _j2ExecuteToolCalls: async () => [], _j2AppendToolResults: () => {},
  _recordSessionToMemory: async () => {}, _sessionRecall: async () => ({ ok:false }),
  safeResWrite: (r, s) => r.write(s), _hasUnclosedToolBlock: () => false,
});
(async () => {
  let err = '';
  try {
    await J2._runAgentLoopLegacyStream(
      [{ role:'system', content:'sys' }, { role:'user', content:'探针' }],
      { id:'prefill-probe-model', provider:'lmstudio', endpoint:'http://127.0.0.1:9/none', context_length:65536 },
      { on(){}, aborted:false }, res,
      { userInput:'探针', reqBody:{ session_id:'j2-prefill-progress' }, sessionId:'j2-prefill-progress',
        role:'main', toolsAllowed:['exec_command','task_done'] });
  } catch (e) { err = String(e.message); }
  process.stdout.write(JSON.stringify({ sse, err }));
  process.exit(0);
})();
`;

function _runProbe(progressMs) {
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', _PROBE_SRC(progressMs)], {
    timeout: 60000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: Object.assign({}, process.env, { PANGU_PREFILL_PROGRESS_MS: String(progressMs) }),
  });
  return JSON.parse(out.trim().split('\n').filter(Boolean).pop());
}

test('P8 端到端: prefill 停顿期间前端必须收到进度事件', () => {
  const r = _runProbe(40);
  const all = r.sse.join('');
  const progress = (all.match(/event: agent_progress/g) || []).length;
  assert.ok(progress > 0,
    'j2 主循环真跑一遍, 假模型 prefill 停顿期间一条进度都没发 —— 这一刀没接上 (err=' + r.err + ')');
});

test('P9 进度必须排在首个正文 delta 之前 (顺序反了等于噪声)', () => {
  const r = _runProbe(40);
  const all = r.sse.join('');
  const firstDelta = all.indexOf('event: stream_delta');
  const firstProgress = all.indexOf('event: agent_progress');
  assert.ok(firstProgress >= 0, '没有进度事件');
  assert.ok(firstDelta < 0 || firstProgress < firstDelta,
    '进度事件必须早于首个 stream_delta —— 晚于它就只是事后补一句, 不解决死寂');
});

test('P10 首个正文 delta 之后必须停 —— 否则进度条会盖着正常输出一直跳', () => {
  const r = _runProbe(40);
  const firstDelta = r.sse.findIndex(e => e.startsWith('event: stream_delta'));
  // 不许"没有 delta 就跳过" —— 那会让本条在什么坏情况下都绿 (反证时它就是这么空过的)。
  // 假 generator 明明 yield 了 '探针正文', 走 legacy 流式路径必然有 delta; 没有就是接线断了,
  // 那该红, 不该放过。
  assert.ok(firstDelta >= 0, 'legacy 流式路径一个正文 delta 都没发 —— 这条路径本身没走到');
  const after = r.sse.slice(firstDelta).filter(e => e.startsWith('event: agent_progress'));
  assert.strictEqual(after.length, 0, '首个正文 delta 之后还发了 ' + after.length + ' 条进度');
});

// ---------- B2 组: native 路径 (生产实机走的就是这条) ----------
//
// 实机证据 (session e2e-prefill / qwen3.8-27b-mlx): [j2-path] {"path":"j2-native"},
// 第一个正文 delta 在 92,274ms, 期间只有 thinking / heartbeat。
// native 的调用点是 `_deps._callLLMForAgent(messages, model, toolsSchema, {onText, onReasoning})`,
// 跟 legacy 的 for-await 是**两处不同的代码**, 所以必须各测一遍。
const _NATIVE_PROBE_SRC = (progressMs) => `
const path = require('path');
const fs = require('fs');
const os = require('os');
process.env.PANGU_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu_prefill_native_'));
const CORE = ${JSON.stringify(path.join(__dirname, '..'))};
const J2 = require(path.join(CORE, 'modules', 'j2_agent_loop.js'));
const sse = [];
const res = { writeHead(){}, setHeader(){}, flushHeaders(){},
  write(c){ sse.push(String(c)); return true; }, on(){}, aborted:false, writableEnded:false, end(){} };
let turn = 0;
J2.init({
  _detectToolCallSupport: async () => true,   // ← 生产路径
  _callLLMForAgent: async (messages, model, tools, opts) => {
    turn += 1;
    if (turn === 1) {
      // 假上游在 prefill 上真停 ${progressMs * 6}ms —— 现场那 92 秒就是这个形状
      await new Promise(r => setTimeout(r, ${progressMs * 6}));
      if (opts && typeof opts.onReasoning === 'function') opts.onReasoning('先想一下');
      await new Promise(r => setTimeout(r, ${progressMs * 4}));
      if (opts && typeof opts.onText === 'function') opts.onText('探针正文');
      return { choices: [{ message: { role:'assistant', content:'', tool_calls: [{
        id:'call_np_done', type:'function', function:{ name:'task_done',
        arguments: JSON.stringify({ status:'completed', summary:'① 完成: 探针' }) } }] } }],
        usage: { prompt_tokens: 11000, completion_tokens: 30 } };
    }
    return { choices: [{ message: { role:'assistant', content:'', tool_calls: [{
      id:'call_np_done2', type:'function', function:{ name:'task_done',
      arguments: JSON.stringify({ status:'completed', summary:'① 完成: 探针2' }) } }] } }],
      usage: { prompt_tokens: 12000, completion_tokens: 30 } };
  },
  _callLLMForAgentStream: async function*(){ yield ''; },
  _j2ExecuteToolCalls: async () => [], _j2AppendToolResults: () => {},
  _recordSessionToMemory: async () => {}, _sessionRecall: async () => ({ ok:false }),
  safeResWrite: (r, s) => r.write(s), _hasUnclosedToolBlock: () => false,
});
(async () => {
  let err = '';
  try {
    await J2._runAgentLoopLegacyStream(
      [{ role:'system', content:'sys' }, { role:'user', content:'探针' }],
      { id:'native-prefill-probe', provider:'lmstudio', endpoint:'http://127.0.0.1:9/none', context_length:65536 },
      { on(){}, aborted:false }, res,
      { userInput:'探针', reqBody:{ session_id:'native-prefill-progress' }, sessionId:'native-prefill-progress',
        role:'main', toolsAllowed:['task_done'] });
  } catch (e) { err = String(e.message); }
  process.stdout.write(JSON.stringify({ sse, err, turns: turn }));
  process.exit(0);
})();
`;

function _runNativeProbe(progressMs) {
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', _NATIVE_PROBE_SRC(progressMs)], {
    timeout: 60000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: Object.assign({}, process.env, { PANGU_PREFILL_PROGRESS_MS: String(progressMs) }),
  });
  return JSON.parse(out.trim().split('\n').filter(Boolean).pop());
}

test('P11 native 路径 (生产实机走的那条) prefill 期间必须发进度', () => {
  const r = _runNativeProbe(40);
  assert.ok(r.turns > 0, '探针没驱动模型 (turns=0) —— 这条测试又会变成恒过的摆设, err=' + r.err);
  const progress = r.sse.filter(e => e.startsWith('event: agent_progress'));
  assert.ok(progress.length > 0,
    'native 路径 prefill 停顿期间一条进度都没发。现场 92 秒死寂就是这条路径 (err=' + r.err + ')');
});

test('P12 native 路径: 进度必须早于首个正文 delta', () => {
  const r = _runNativeProbe(40);
  const firstDelta = r.sse.findIndex(e => e.startsWith('event: stream_delta'));
  const firstProgress = r.sse.findIndex(e => e.startsWith('event: agent_progress'));
  assert.ok(firstProgress >= 0, 'native 路径没有进度事件');
  assert.ok(firstDelta < 0 || firstProgress < firstDelta, 'native 路径进度排在正文之后 = 不解决死寂');
});

test('P13 native 路径: 首个正文 delta 之后必须停', () => {
  const r = _runNativeProbe(40);
  const firstDelta = r.sse.findIndex(e => e.startsWith('event: stream_delta'));
  if (firstDelta < 0) return;
  const after = r.sse.slice(firstDelta).filter(e => e.startsWith('event: agent_progress'));
  assert.strictEqual(after.length, 0, 'native 路径首个正文之后还发了 ' + after.length + ' 条进度');
});
