// 2026-10-18 实机 (本地 qwen3.8-27b-mlx @ LM Studio :1234):
//
// 结论先说清楚: **流式和工具提示本来就是通的**, 这次实机逐事件核对过 ——
//   · stream_delta 逐 token 出 (一轮 87s 里 25+ 条)
//   · tool_call 在工具**执行前**就发 (j2_agent_loop.js:4074 写事件, :4084 才进执行循环),
//     带 id + 完整 params, 前端工具灯在那一刻点亮、tool_result 时熄灭
//   · SSE 一秒没静默, prefill 期间每 3s 一条 agent_progress
// 所以**不是**"没有进度", 是进度讲错了故事。
//
// 真正的问题只有一个, 实测序列 (session deciding-verify-1018):
//   elapsed_ms: 0 → 3001 → 6002 → 9003 → **0** → 3395 → 6395 → **0** → 17570 → **3429**
//   total_ms:  0 → 3001 → 6002 → 9003 → 11144 → 14539 → 16313 → 16313 → 19742
//
// 一轮多 round 的任务里计时器会**每轮归零**: 57s 突然跳回 0s 再往上走, 用户以为计时器坏了。
// 界面显示的就是 elapsed_ms。修法: 跨轮累计 total_ms (挂在 res 上, 每轮接着走)。
//
// 另外顺手钉死一个**发现**: j2_agent_loop 的 _emitReason 里原本有一行
// `if (typeof on === 'string') _pfStop();` —— **首参从来不是字符串**, llm_caller 只发
// `(true, chars)` / `(false, chars)`。这道门从未通过, 是死代码。删掉它不影响任何行为
// (prefill 收口由 onText 负责, 因为 llm_caller 推 reasoning 时走的是 onText(reasoning_content))。
// 见 T5 —— 防止下一个人再在这行上"接线"。
//
// 全部用假 res / 子进程假模型, **不发任何真实请求** (不烧任何额度)。
//
// ── 2026-10-26 第 107 批 (桌面端下线) ──
// T7 / T8 原来查的是**前端怎么读这两个字段** (界面计时器优先 total_ms /
// 只认 prefill 这一个 phase), 随 apps/desktop 一起下线。
// 它们守的**服务端那一半**没丢, 改写成服务端契约:
//   T7 —— 服务端发 agent_progress 时 phase 只许有 'prefill' 一个取值 (集合封闭)。
//         消费者既然已经不存在了, 那服务端就更不该发第二个 phase:
//         发出去没人认 = 死事件, 而且下一个人会照着它写前端。
//   T8 —— thinking 事件的 phase 只许 'on' / 'off' (集合封闭), 且必须带 ts:
//         思考灯的"停了多久"只能按**耗时**算, 不能按 chars 算
//         (chars 在开场恒为 0, 拿它判停滞等于一开口就报假警)。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const M = (p) => require(path.join(__dirname, '..', p));
const SHARED = M('modules/j2_loop_shared.js');
const LOOP_SRC = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
const CALLER_SRC = fs.readFileSync(path.join(__dirname, '..', 'modules', 'llm_caller.js'), 'utf8');

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

// ---------- 1. total_ms 跨轮累计 (这才是真问题) ----------

test('T1 两轮 prefill: total_ms 必须连续 — elapsed_ms 归零也不许把界面计时器拖回 0', async () => {
  process.env.PANGU_PREFILL_PROGRESS_MS = '60';
  const res = _fakeRes();

  const s1 = SHARED._startPrefillProgress(res, { input_tokens: 6122, model: 'qwen3.8-27b-mlx' });
  await _sleep(300);
  const r1 = _progressEvents(res);
  const last1 = r1[r1.length - 1];
  // 注意: total_ms 在**发事件那一刻**算, 最后一条必然早于 sleep 结束 ——
  // 不断言"≈300ms"(拿 sleep 末尾卡最后一条事件必然偏小), 断言不变式。
  assert.ok(last1.total_ms >= last1.elapsed_ms,
    `total_ms (${last1.total_ms}) 必须 ≥ 本轮 elapsed_ms (${last1.elapsed_ms})`);
  assert.ok(last1.total_ms > 0, '第 1 轮累计必须为正');
  s1();

  await _sleep(50);

  const s2 = SHARED._startPrefillProgress(res, { input_tokens: 6122, model: 'qwen3.8-27b-mlx' });
  await _sleep(120);
  const last2 = _progressEvents(res).pop();
  assert.ok(last2.elapsed_ms < 200,
    `第 2 轮 elapsed_ms 应该从头开始 (实测现象), 实际 ${last2.elapsed_ms}`);
  assert.ok(last2.total_ms > last1.total_ms + 50,
    `total_ms 必须跨轮累计: 第1轮 ${last1.total_ms} → 第2轮 ${last2.total_ms}。`
    + ' 不涨 = 界面计时器每轮跳回 0s, 正是这次要修的现象');
  s2();
});

test('T2 stop() 必须把本轮时长并进累计, 否则最后一小段等待永远不计入', async () => {
  process.env.PANGU_PREFILL_PROGRESS_MS = '10000';   // 只靠 stop() 记账, 不靠第二条事件
  const res = _fakeRes();
  const s1 = SHARED._startPrefillProgress(res, { input_tokens: 100, model: 'm' });
  await _sleep(200);
  s1();

  const s2 = SHARED._startPrefillProgress(res, { input_tokens: 100, model: 'm' });
  await _sleep(60);
  const total = _progressEvents(res).pop().total_ms;
  s2();
  assert.ok(total >= 200, `stop 后累计应含第 1 轮那 200ms, 实测 ${total}`);
});

test('T3 res=null / 不支持 write 时不能抛 (2026-10-16 的 P7 契约, 挂累计状态到 res 上会踩)', () => {
  const a = SHARED._startPrefillProgress(null, { input_tokens: 1, model: 'm' });
  const b = SHARED._startPrefillProgress({}, { input_tokens: 1, model: 'm' });
  assert.strictEqual(typeof a, 'function', 'res=null 必须返回可调用的 stop');
  assert.strictEqual(typeof b, 'function', 'res 不支持 write 必须返回可调用的 stop');
  a(); b();   // 幂等
});

// ---------- 2b. 迟到 stop() (实机多轮才暴露的坑) ----------

test('T3b 上一轮的 stop() 晚到时, 不许把新一轮的 total_ms 卡死', async () => {
  // 2026-10-18 实机 (session timer-verify-final, 多轮任务) 抓到的:
  //   elapsed_ms: 0,3002,6003,9004, 0,3761, 0,6761,9764,…,42163   ← 一路在涨
  //   total_ms:  0,3002,6003,9004, 9307,13068,13069,15096,15096,… ← 从 15096 **冻住**
  // 原因: 上一轮 stop() 晚于下一轮 _pfStart 才到, 把共享的 started_at 清零了。
  // 单轮测试永远测不到 —— 必须造出"两轮重叠 + stop 迟到"这个形状。
  process.env.PANGU_PREFILL_PROGRESS_MS = '40';
  const res = _fakeRes();

  const stop1 = SHARED._startPrefillProgress(res, { input_tokens: 100, model: 'm' });
  await _sleep(120);

  // 第 2 轮接管 (上一轮还没 stop)
  const stop2 = SHARED._startPrefillProgress(res, { input_tokens: 100, model: 'm' });
  await _sleep(120);

  // 第 1 轮的 stop **迟到** —— 真实生产里轮末兜底收口 / res close 都可能晚于下一轮启动
  stop1();
  // 关键: 基线必须等"冻结已经稳定"之后再取。迟到 stop() 之前的最后一条事件是
  // 零生效**之前**发的, 拿它当基线会掩盖冻结 (第一版就是这么漏掉的)。
  await _sleep(160);
  const atStop = _progressEvents(res).pop().total_ms;

  await _sleep(200);
  const later = _progressEvents(res).pop().total_ms;
  stop2();

  assert.ok(later > atStop,
    `第 1 轮迟到 stop() 之后 total_ms 必须继续涨 (冻在 ${atStop} = 界面计时器停摆, `
    + `正是实机 total 15096/elapsed 42163 那个现象)`);
});

test('T3c 两轮重叠时 total_ms 必须单调不减, 且大于任何一轮单独的 elapsed', async () => {
  process.env.PANGU_PREFILL_PROGRESS_MS = '30';
  const res = _fakeRes();
  const stop1 = SHARED._startPrefillProgress(res, { input_tokens: 100, model: 'm' });
  await _sleep(100);
  const stop2 = SHARED._startPrefillProgress(res, { input_tokens: 100, model: 'm' });
  await _sleep(100);
  const mid = _progressEvents(res).pop();
  stop1();                       // 迟到
  await _sleep(80);
  const after = _progressEvents(res).pop();
  stop2();

  assert.ok(after.total_ms >= mid.total_ms,
    `total_ms 不得倒退: ${mid.total_ms} → ${after.total_ms}`);
  assert.ok(after.total_ms >= after.elapsed_ms,
    `累计必须 ≥ 本轮 elapsed: total ${after.total_ms} / elapsed ${after.elapsed_ms}`);
});

test('T3d 多轮**并发**交错发事件时, total_ms 一律不许倒退', async () => {
  // 2026-10-18 实机 (session multiround-verify, 3 个文件连读):
  //   elapsed_ms: ...,42017, 0,3348, 0,6350,3001,9352,6003,12353,...
  //   total_ms:  ...,42017,43016,46364,46365,52715,**49366**,55717,**52368**,66738,...
  // 两次倒退 —— "按轮持有起点"的算法在轮次并发时必然出现: 晚起的轮从更晚的起点算,
  // 它的数字比先起的轮小, 两条流交错写进同一个 SSE, 界面计时器就往回跳。
  process.env.PANGU_PREFILL_PROGRESS_MS = '25';
  const res = _fakeRes();
  const stops = [];
  // 三轮先后启动但**都不立刻停** —— 制造真实的交错 emit
  for (let i = 0; i < 3; i++) {
    stops.push(SHARED._startPrefillProgress(res, { input_tokens: 100, model: 'm' }));
    await _sleep(70);
  }
  await _sleep(150);
  const seq = _progressEvents(res).map(e => e.total_ms);
  stops.forEach(s => s());

  const dips = seq.filter((v, i) => i > 0 && v < seq[i - 1]);
  assert.strictEqual(dips.length, 0,
    `total_ms 出现 ${dips.length} 次倒退 (界面计时器往回跳)。序列: ${seq.join(',')}`);
});

// ---------- 2. 生产路径真跑 (子进程, 不能只测 helper) ----------
//
// 只测 helper 挡不住"helper 改了但生产没接线"。这一组让 j2 主循环真跑一遍 native 路径
// (生产实机走的那条, 日志 [j2-path] path=j2-native)。
const _NATIVE_PROBE = (progressMs) => `
const path = require('path');
const fs = require('fs');
const os = require('os');
process.env.PANGU_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu_timer_native_'));
const CORE = ${JSON.stringify(path.join(__dirname, '..'))};
const J2 = require(path.join(CORE, 'modules', 'j2_agent_loop.js'));
const sse = [];
const res = { writeHead(){}, setHeader(){}, flushHeaders(){},
  write(c){ sse.push(String(c)); return true; }, on(){}, aborted:false, writableEnded:false, end(){} };
let turn = 0;
J2.init({
  _detectToolCallSupport: async () => true,
  _callLLMForAgent: async (messages, model, tools, opts) => {
    turn += 1;
    if (turn === 1) {
      await new Promise(r => setTimeout(r, ${progressMs * 3}));
      if (opts && typeof opts.onReasoning === 'function') opts.onReasoning(true, 0);
      if (opts && typeof opts.onText === 'function') opts.onText('探针正文');
      return { choices: [{ message: { role:'assistant', content:'', tool_calls: [{
        id:'call_t_done', type:'function', function:{ name:'task_done',
        arguments: JSON.stringify({ status:'completed', summary:'① 完成: 探针' }) } }] } }],
        usage: { prompt_tokens: 6122, completion_tokens: 30 } };
    }
    // 第 2 轮**不吐任何 token** —— 直接返回, 逼主循环走到 onText 之后的兜底收口。
    return { choices: [{ message: { role:'assistant', content:'', tool_calls: [{
      id:'call_t_done2', type:'function', function:{ name:'task_done',
      arguments: JSON.stringify({ status:'completed', summary:'① 完成: 探针2' }) } }] } }],
      usage: { prompt_tokens: 6200, completion_tokens: 30 } };
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
      { id:'timer-probe-model', provider:'lmstudio', endpoint:'http://127.0.0.1:9/none', context_length:65536 },
      { on(){}, aborted:false }, res,
      { userInput:'探针', reqBody:{ session_id:'j2-prefill-timer' }, sessionId:'j2-prefill-timer',
        role:'main', toolsAllowed:['task_done'] });
  } catch (e) { err = String(e.message); }
  process.stdout.write(JSON.stringify({ sse, err, turns: turn }));
  process.exit(0);
})();
`;

function _runNativeProbe(progressMs) {
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', _NATIVE_PROBE(progressMs)], {
    timeout: 60000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: Object.assign({}, process.env, { PANGU_PREFILL_PROGRESS_MS: String(progressMs) }),
  });
  return JSON.parse(out.trim().split('\n').filter(Boolean).pop());
}

function _payload(sseEntry) {
  const m = sseEntry.match(/data: (\{.*\})/);
  try { return m ? JSON.parse(m[1]) : null; } catch (_) { return null; }
}

test('T4 native 生产路径发出的进度必须带 total_ms (前端计时器跨轮全靠它)', () => {
  const r = _runNativeProbe(40);
  assert.ok(r.turns > 0, '探针没驱动模型 (turns=0) —— 这条会变成恒过的摆设, err=' + r.err);
  const evs = r.sse.filter(e => e.startsWith('event: agent_progress')).map(_payload).filter(Boolean);
  assert.ok(evs.length > 0, '生产路径一条进度都没发, err=' + r.err);
  assert.ok(evs.every(e => Number.isFinite(e.total_ms)),
    '生产路径的每条进度都必须带 total_ms —— 前端倒回 elapsed_ms 就还是每轮归零');
});

test('T5 onReasoning 的首参**从来不是字符串** —— 那道 typeof 门是死代码, 不许复活', () => {
  // 这是本次实机查出来的真事实, 钉死它防止有人再在 _emitReason 里"接线":
  // llm_caller 只发布尔 + chars, 所以 `typeof on === 'string'` 永不成立。
  const calls = [...CALLER_SRC.matchAll(/opts\.onReasoning\(([^)]*)\)/g)].map(m => m[1].trim());
  assert.ok(calls.length > 0, 'llm_caller 里应当找得到 onReasoning 调用');
  assert.ok(calls.every(a => /^(true|false)\b/.test(a)),
    'onReasoning 的实参必须全是布尔开头。实测发现非布尔调用: ' + JSON.stringify(calls));
  // 只看**代码行**: 那道死门在注释里被引用了一次 (留作"这里曾经错在哪"的说明),
  // 断言不能把注释当代码, 否则自己写的注释会把自己判红。
  const _codeOnly = LOOP_SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/typeof on === 'string'/.test(_codeOnly),
    '_emitReason 里不该再有 `typeof on === \'string\'` —— llm_caller 从不发字符串, '
    + '那道门从未通过, 留着只会诱导下一个人以为"推理收口接在这里"');
});

test('T6 prefill 收口仍由 onText 负责 —— 删掉死门之后不许把这条也删了', () => {
  // llm_caller 推 reasoning 时走的是 onText(delta.reasoning_content), 所以第一个推理
  // 增量照样落到 onText 的 _pfStop()。删死门不影响行为的前提就是这个 _pfStop 还在。
  assert.match(CALLER_SRC, /opts\.onText\(delta\.reasoning_content\)/,
    'llm_caller 必须仍然用 onText 推 reasoning —— 这是 prefill 收口的真实通路');
  assert.match(LOOP_SRC, /onText: \(d\) => \{\s*\n\s*_pfStop\(\);/,
    'onText 首 token 的 _pfStop() 是 prefill 的真实收口点, 不许丢');
});

// ---------- 3. 服务端契约 (原 T7/T8 的前端半, 随桌面端下线改成服务端那一半) ----------

test('T7 agent_progress 的 phase 集合必须封闭 —— 服务端只发 prefill 一个取值', () => {
  // 中间态 (reasoning→正文 之间那个) 特意**没有**加: reasoning 期间 thinking 事件
  // 一直在发且 chars 在涨, 再加一个 agent_progress phase 只会和 thinking 讲同一件事。
  // 消费者已经不存在了, 服务端更不该发第二个 phase ——
  // 发出去没人认 = 死事件, 而且下一个人会照着它写前端。
  const SHARED_SRC = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_loop_shared.js'), 'utf8');
  const i = SHARED_SRC.indexOf("event: agent_progress");
  assert.ok(i > 0, '要能找到 agent_progress 的发射点');
  // 取载荷定义那一段 (payload 在 write 之前)
  const payloadAt = SHARED_SRC.lastIndexOf('const payload = {', i);
  assert.ok(payloadAt > 0, '要能找到 agent_progress 的 payload 定义');
  const seg = SHARED_SRC.slice(payloadAt, i);
  const phases = (seg.match(/phase:\s*'([^']+)'/g) || []).map(s => s.match(/'([^']+)'/)[1]);
  assert.deepStrictEqual(phases, ['prefill'],
    'T7: agent_progress 的 phase 集合必须恰好是 {prefill}, 实际 ' + JSON.stringify(phases)
    + ' —— 多发一个 phase 就是没人认的死事件');
  // 全 core 扫一遍: 别处再发一次 agent_progress 也不能带别的 phase
  const roots = ['modules', 'agents', 'pangu-single'];
  const offenders = [];
  for (const r of roots) {
    const base = path.join(__dirname, '..', r);
    for (const f of fs.readdirSync(base, { recursive: true })) {
      const p = path.join(base, f);
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (!st.isFile() || !/\.(js|mjs)$/.test(p)) continue;
      const src = fs.readFileSync(p, 'utf8');
      let at = src.indexOf('event: agent_progress');
      while (at >= 0) {
        const win = src.slice(Math.max(0, at - 1200), at);
        const m = win.match(/phase:\s*'([^']+)'/g);
        for (const x of (m || [])) {
          const v = x.match(/'([^']+)'/)[1];
          if (v !== 'prefill') offenders.push(path.relative(path.join(__dirname, '..'), p) + ':' + v);
        }
        at = src.indexOf('event: agent_progress', at + 1);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    'T7: 全 core 不许再发第二种 agent_progress phase, 实际: ' + offenders.join(', '));
});

test('T8 thinking 的 phase 只许 on/off, 且必须带 ts (停滞只能按耗时判)', () => {
  // thinking 事件的 phase 是**封闭集合**: 开 / 关。
  // 思考灯"停了多久"只能按 ts 算 —— chars 在开场恒为 0 (prefill 死寂窗那一条),
  // 拿 chars 判停滞等于一开口就报假警。
  const i = LOOP_SRC.indexOf("res.write('event: thinking");
  assert.ok(i > 0, '要能找到 thinking 事件的发射点');
  const win = LOOP_SRC.slice(Math.max(0, i - 600), i + 400);
  assert.match(win, /phase: on \? 'on' : 'off'/,
    "T8: thinking 的 phase 必须只有 'on' / 'off' 两个取值");
  assert.match(win, /chars: _reasonChars/,
    'T8: thinking 必须带 chars (它是"还在思考"的量化, 但**不是**停滞判据)');
  assert.match(win, /ts: now/,
    'T8: thinking 必须带 ts —— 停滞判定只能按耗时, 没有 ts 消费者就只剩 chars 可用, '
    + '而 chars 在开场恒为 0');
});

// 测试文件的老毛病: 进程不退 (同 r24 / model-failover)。给 300ms 让输出刷完再退。
test.after(() => { setTimeout(() => process.exit(0), 300); });
