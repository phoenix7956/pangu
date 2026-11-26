'use strict';

// 2026-10-15: 活体实测 (POST :18901/message/stream, 本地 qwen3.6-27b) 之后的三处修复。
//
// 实测结论先摆在这: **流式和工具本来就是通的** —— 16 次请求里 14 次 stream:true、
// 15 次带 tools、14 次 "Finished streaming response", stream_delta 逐 token 出,
// tool_call/tool_result 都真执行。
//
// "跟死了一样" 是另外三件事造成的, 跟流式通不通无关:
//
//   1. 防重复守门自伤。模型重复调同一个工具 → 盘古**自己**的守门 (j2:2397
//      DUPLICATE_TOOL_CALL, blocked:true) 拦下 → _shouldSelfCheck 不看 blocked,
//      判成 incorrect → plan_failed → 工具被 gate 拦一次 → 回灌 [SELF_CORRECT_FAIL]
//      逼模型重规划。实测: 一句"数个文件"跑 13 轮 / 168 秒。
//   2. 失败理由恒为 "错误码 undefined"。self_correct 只读 original.error.code,
//      但守门的 error 是**裸字符串**, 不是 {code, message} → 永远 undefined,
//      日志里看不出是哪一类失败。
//   3. prefill 死寂窗。execution_path 之后到第一个 reasoning delta 中位 8~12s、
//      极端 23.5s, 这段模型在 prefill 一万四千 token, 一个字节都吐不出来。
//      心跳证明连接活着, 但界面除了心跳什么都不显示 —— 观感就是死了。
//
// ── 2026-10-26 第 107 批 (桌面端下线) ──
// B6 / B7 原来查的是**前端怎么呈现思考灯** (ActivityLine 的 chars=0 显示省略号、
// PulseLight/StageLight 的 300s 停滞熔断、thinking 的 phase 切换), 随 apps/desktop
// 一起下线, 一起删。
// 它们守的**服务端那一半**没丢, 改写成一条**行为级**探针 (B6b):
//   开场 chars 恒为 0 —— 灯照样要点亮 (拿 chars 判停滞等于一开口就报假警);
//   开了必须关 —— phase on/off 必须配对 (关了不关 = 永远转圈, 比死寂更糟)。
// 为什么改成探针而不是源码断言: 这个文件开头就写着
// 「"源码里有没有接线"那种断言挡不住"接线还在、行为已经变了"」。
// 桌面端没了, 服务端这条链更得靠**真跑一遍**来验。
//
// ⚠ 诚实记账: 前端那条「300s 停滞熔断 (PulseLight / StageLight, 按耗时判定)」
// **服务端从来就没有对应实现** —— 它整个活在前端组件里。桌面端下线后,
// core 这边目前**没有任何停滞熔断**: 长任务卡住时, 服务端只发心跳, 不自杀。
// 这是现状, 不假装有 (不许凭空造一个常量来"补齐")。
// 要加的话, 判据必须是**耗时**, 不能是 chars —— 见下面 B6b 的第二条断言。

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const LOOP_SRC = fs.readFileSync(path.join(ROOT, 'modules', 'j2_agent_loop.js'), 'utf8');

test('B1 blocked=true 是盘古自己的守门, 不能进 self_correct', () => {
  const m = LOOP_SRC.match(/const _shouldSelfCheck = [^\n]+/);
  assert.ok(m, '要能找到 _shouldSelfCheck 的判定');
  assert.match(m[0], /!execResult\.blocked/,
    'B1: 守门拦截 (blocked:true) 是自我约束, 不是工具故障, 不能判 incorrect 再罚模型一次');
  // 回归: 真正的工具失败仍然要自检, 别把自检整个关掉
  assert.match(m[0], /execResult\.ok === false/,
    'B1: 真失败仍要触发自检 (不能为了消掉误报把真报也关了)');
  assert.match(m[0], /_READONLY_TOOLS\.includes/,
    'B1: 只读工具的 NOT_FOUND 仍按"信息"处理');
});

test('B2 守门拦截的错误形状 (裸字符串) 必须被 self_correct 如实报出来', () => {
  const { TOOLS } = require(path.join(ROOT, 'modules', 'tools'));
  // 与 j2:2397 的 DUPLICATE_TOOL_CALL 完全同形
  const blockedResult = {
    ok: false,
    blocked: true,
    data: {},
    error: 'DUPLICATE_TOOL_CALL',
    message: '同一工具和参数已经原样执行过了',
  };
  return TOOLS.self_correct({
    context: { user: 'feng', sessionId: 'test-blocked' },
    params: { tool_name: 'list_pangu_agents', original_result: blockedResult, plan_id: null },
  }).then(sc => {
    const reason = String((sc && sc.result && sc.result.reason) || '');
    assert.ok(reason.includes('DUPLICATE_TOOL_CALL'),
      'B2: 裸字符串 error 必须直接当错误码报出来, 实际拿到: ' + reason);
    assert.ok(!/错误码 undefined/.test(reason),
      'B2: 不能再出现 "错误码 undefined" —— 排查时等于没信息, 实际: ' + reason);
  });
});

test('B3 对象形状的 error 仍走 .code (不能把字符串分支写成唯一分支)', () => {
  const { TOOLS } = require(path.join(ROOT, 'modules', 'tools'));
  return TOOLS.self_correct({
    context: { user: 'feng', sessionId: 'test-objerr' },
    params: {
      tool_name: 'read_file',
      original_result: { ok: false, error: { code: 'NO_PATH', message: '路径不存在' } },
      plan_id: null,
    },
  }).then(sc => {
    const reason = String((sc && sc.result && sc.result.reason) || '');
    assert.ok(reason.includes('NO_PATH'), 'B3: {code,message} 形状仍要取到 code, 实际: ' + reason);
  });
});

test('B4 prefill 死寂窗: 请求发出前先点一次 thinking:on', () => {
  // 必须早于 await, 否则 prefill 那 8~12s 仍然全黑
  const emitAt = LOOP_SRC.indexOf("_emitReason(true, 0);  // prefill 死寂窗");
  const awaitAt = LOOP_SRC.indexOf('llmResult = await _deps._callLLMForAgent(');
  assert.ok(emitAt > 0, '要能找到 prefill 思考灯的提前点亮');
  assert.ok(emitAt < awaitAt,
    'B4: thinking:on 必须在 await 之前发 —— 发在之后就等于没提前');
});

test('B5 思考灯必须有关灯路径 (否则永远转圈, 比死寂更糟)', () => {
  assert.match(LOOP_SRC, /const _closeReasonIfOpen = \(\) => \{ if \(_reasonOpen\) _emitReason\(false/,
    'B5: 要有关灯函数');
  // 成功路径 + 异常路径都要关
  const closes = LOOP_SRC.match(/_closeReasonIfOpen\(\);/g) || [];
  assert.ok(closes.length >= 3,
    'B5: 流式成功 / 非流式成功 / catch 异常 三处都要关灯, 实际 ' + closes.length + ' 处');
  // 关灯函数本身必须真的写出去一条 off, 而不是空实现
  const seg = LOOP_SRC.slice(
    LOOP_SRC.indexOf('const _closeReasonIfOpen'),
    LOOP_SRC.indexOf('const _closeReasonIfOpen') + 200);
  assert.match(seg, /_emitReason\(false/, 'B5: 关灯要走真实的 thinking:off');
});

test('B8 拦下的重复调用必须记账 — 否则它对三个刹车同时隐身', () => {
  // 背景: fix 1 摘掉 self_correct 那道"假刹"之后, 无限重试立刻现形 ——
  // 实测 list_pangu_agents 被拦 3 次, 每轮本地推理 ~40s, 200s 不收尾。
  // 根因不是"没有刹车", 是被拦的调用够不到任何一辆车:
  //   - _crossRoundToolCalls / _crossRoundToolFails 只遍历 toolResults 时 +1,
  //     而拦下的结果只进 _j2ExecResults, 不在 toolResults 里 → [HARD-LOOP]/[HARD] 永不响;
  //   - budget.recordToolCall 只在 _execToolWithPermission 里, 拦下的调用走不到 → 预算不扣。
  // 锚点必须是**唯一**的。原锚点是 'DUPLICATE_TOOL_CALL' 的首次出现 ——
  // 2026-10-17 在别处的注释里提到这六个字之后, 首次出现变成了注释,
  // 1800 字符窗口整个切偏, 这条护栏红得莫名其妙 (真实代码一个字没动)。
  // 教训与 2026-10-15 那次一样: **「标记不唯一」本身就是坑**, 别去加宽窗口,
  // 加宽只会让下一个加注释的人再踩一次。改用记账块唯一的头。
  const dup = LOOP_SRC.indexOf('_j2DupCalls.length > 0');
  assert.ok(dup > 0, '要能找到重复调用记账块 (锚点唯一, 别用 DUPLICATE_TOOL_CALL 首次出现)');
  const seg = LOOP_SRC.slice(dup, dup + 2200);
  assert.match(seg, /_crossRoundToolCalls\.set\(/,
    'B8: 拦截必须计入 _crossRoundToolCalls, 否则 [HARD-LOOP] 永远不响');
  assert.match(seg, /_crossRoundToolFails\.set\(/,
    'B8: 拦截必须计入 _crossRoundToolFails, 否则 [HARD] 永远不响');
  assert.match(seg, /budget\.recordToolCall\(/,
    'B8: 拦截必须扣算力预算, 否则可以无限重试');
});

test('B9 当场告诉模型"这次没执行, 再调也是白烧"', () => {
  // 实测模型会连着调 3~4 次同一个工具 —— 不能等下一轮才说教,
  // 每一次都是一整轮本地推理 (~40s)。
  const dup = LOOP_SRC.indexOf('_j2DupCalls.length > 0');   // 唯一锚点, 同 B8
  const seg = LOOP_SRC.slice(dup, dup + 3000);
  assert.match(seg, /DUPLICATE-CALL-BLOCKED/,
    'B9: 拦截当场要回灌指令, 不能只发个 alarm 就放过');
  assert.match(seg, /根本没执行|不会执行第二遍|这次调用根本没执行/,
    'B9: 文案要点明"没执行", 否则模型以为自己已经拿到结果了');
  assert.match(seg, /task_done/,
    'B9: 必须给出收口出口 (task_done), 光骂不给路模型会继续撞');
});

test('B10 main 角色必须够得着"探索"这一半文件 API', () => {
  // 现场 (实测 /message/stream): 老板问 "用 list_directory 看某目录有几个文件",
  // 模型连调 6 次 list_pangu_agents, 200s 不收尾, 最后给了错答案。
  // 根因: list_directory 压根不在 main 集里 —— 模型调不到, 只能退而选
  // 集里唯一带 "list" 字样的 list_pangu_agents, 然后被自己的守门拦到死。
  // main 有 read_file (能读已知路径) 却没有 list_directory (不知道有哪些文件)
  // = 半个文件 API, 长任务里"先摸清现场再动手"这第一步直接不通。
  // 2026-10-25 (第 97 批): 改读**运行时导出** —— 原来按源码文本正则抠数组字面量,
  //   文件一拆/一挪就失效。运行时拿到的就是真正发给模型的那份。
  const main = new Set(require(path.join(ROOT, 'modules', 'tools_schema')).MAIN_GENERAL_TOOLS_FOR_LLM);
  for (const t of ['list_directory', 'file_find', 'search_files', 'read_file']) {
    assert.ok(main.has(t), 'B10: main 角色必须有 ' + t + ' (否则探索链断在第一步)');
  }
  // 这三个是只读工具, 必须在防重复白名单里, 否则新暴露的探索工具会引入空转面
  assert.match(LOOP_SRC, /_READONLY_TOOLS = \[[^\]]*'list_directory'/,
    'B10: list_directory 必须在 _READONLY_TOOLS 里');
  assert.match(LOOP_SRC, /_READONLY_REPEAT_OK = new Set\(\[[^\]]*'list_directory'/,
    'B10: list_directory 必须在 _READONLY_REPEAT_OK 里 (同参数重读是合法的)');
});

test('B11 游标必须在同一坐标系比 — 前导空白偏移会凭空多发尾巴', () => {
  // 实测 (qwen3.8-27b-mlx, 7/7 次全中): 该模型 content 恒带前导 '\n\n'。
  // 流式累积从正文首字开始 (visible=28), 轮末回灌的 textContent 带 '\n\n' (30 字),
  // 拿 30 去 slice(28) → 多吐 '）。', 气泡变成 '…周四夜）。）。'
  // 而 final 里的稿子是干净的, 但前端 ChatRoom.jsx:1234 规则是
  // "流式更长就保留流式" —— 所以用户看到的正是坏的那份。
 const SHARED = fs.readFileSync(path.join(ROOT, 'modules', 'j2_loop_shared.js'), 'utf8');
  const i = SHARED.indexOf('function _emitStreamDelta');
  assert.ok(i > 0, '要能找到 _emitStreamDelta');
  const seg = SHARED.slice(i, i + 1800);
  assert.match(seg, /\.replace\(\/\^\\s\+\/, ''\)/,
    'B11: stateful 路径必须剥掉前导空白再比游标, 否则两个来源差一个偏移量');
  // 回归: 非 stateful 路径 (accumulated='') 的故意 '\n\n' 前缀不能被剥掉
  assert.match(seg, /_deltaStripped = stateful \? _accumulatedStripped\.slice\(previousVisible\) : _stripThink\(delta\)/,
    'B11: 非 stateful 路径必须原样透传 delta (计划提示/换模型提示靠 \n\n 起头)');
});

test('B12 游标偏移复现 — 端到端断言不多发尾巴', () => {
  // 直接跑真实的 _emitStreamDelta, 不做源码字符串断言。
  const { _emitStreamDelta } = require(path.join(ROOT, 'modules', 'j2_loop_shared.js'));
  const answer = '2026年10月15日 22:22（北京时间，周四夜）。';
  const res = { __panguVisibleLen: 0 };
  const emitted = [];
  const fakeRes = {
    write(s) {
      const m = /data: (.*)/.exec(s);
      if (m) emitted.push(JSON.parse(m[1]).delta);
    },
  };
  fakeRes.__panguVisibleLen = 0;
  let acc = '<think>内部思考</think>';
  for (const ch of answer) { acc += ch; _emitStreamDelta(fakeRes, ch, acc, 0); }
  const streamed = emitted.join('');
  // 轮末回灌: 模型的 content 带前导 '\n\n'
  _emitStreamDelta(fakeRes, '\n\n' + answer, '\n\n' + answer, 0);
  const final = emitted.join('');
  assert.strictEqual(streamed, answer, 'B12: 流式阶段应逐字吐出完整正文');
  assert.strictEqual(final, answer,
    'B12: 轮末回灌不得凭空多发尾巴 — 实际多出: ' +
    JSON.stringify(final.slice(answer.length)));
  assert.ok(!final.includes('）。）。'), 'B12: 不能出现重复的尾巴');
});


// ---------- B6b: 思考灯的服务端行为 (原 B6 / B7 的服务端那一半) ----------
//
// 必须子进程: j2 主循环跑完不一定让事件循环退出 (同 prefill-progress 的教训)。
// 假模型在 prefill 上真停 400ms —— 模拟现场那 8~12s 的死寂窗。
const _THINK_PROBE = `
const path = require('path');
const fs = require('fs');
const os = require('os');
process.env.PANGU_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu_think_probe_'));
const CORE = ${JSON.stringify(ROOT)};
const J2 = require(path.join(CORE, 'modules', 'j2_agent_loop.js'));
const sse = [];
const res = { writeHead(){}, setHeader(){}, flushHeaders(){},
  write(c){ sse.push(String(c)); return true; }, on(){}, aborted:false, writableEnded:false, end(){} };
let turn = 0;
J2.init({
  _detectToolCallSupport: async () => true,      // ← 生产走 native 这一条
  _callLLMForAgent: async (messages, model, tools, opts) => {
    turn += 1;
    if (turn === 1) {
      await new Promise(r => setTimeout(r, 400));   // prefill 死寂窗
      if (opts && typeof opts.onText === 'function') opts.onText('探针正文');
      return { choices: [{ message: { role:'assistant', content:'', tool_calls: [{
        id:'call_think_done', type:'function', function:{ name:'task_done',
        arguments: JSON.stringify({ status:'completed', summary:'① 完成: 探针' }) } }] } }],
        usage: { prompt_tokens: 6122, completion_tokens: 30 } };
    }
    return { choices: [{ message: { role:'assistant', content:'', tool_calls: [{
      id:'call_think_done2', type:'function', function:{ name:'task_done',
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
      { id:'think-probe-model', provider:'lmstudio', endpoint:'http://127.0.0.1:9/none', context_length:65536 },
      { on(){}, aborted:false }, res,
      { userInput:'探针', reqBody:{ session_id:'j2-think-probe' }, sessionId:'j2-think-probe',
        role:'main', toolsAllowed:['task_done'] });
  } catch (e) { err = String(e.message); }
  process.stdout.write(JSON.stringify({ sse, err, turns: turn }));
  process.exit(0);
})();
`;

function _runThinkProbe() {
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', _THINK_PROBE], {
    timeout: 60000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split('\n').filter(Boolean).pop());
}

function _thinkingEvents(sse) {
  return sse
    .filter(e => e.startsWith('event: thinking'))
    .map(e => {
      const m = e.match(/data: (\{.*\})/);
      try { return m ? JSON.parse(m[1]) : null; } catch (_) { return null; }
    })
    .filter(Boolean);
}

test('B6b 思考灯: chars 恒 0 的开场也要亮, 且 on/off 必须配对', () => {
  const r = _runThinkProbe();
  assert.ok(r.turns > 0, '探针没驱动模型 (turns=0) —— 这条会变成恒过的摆设, err=' + r.err);
  const evs = _thinkingEvents(r.sse);
  assert.ok(evs.length > 0,
    '服务端一条 thinking 都没发 —— prefill 死寂窗里界面就是全黑 (err=' + r.err + ')');

  // ① 开场 chars 恒为 0, 灯照样要点亮。
  //    拿 chars 判停滞 = 一开口就报假警 —— 这是这条测试最想守住的那半。
  const zeros = evs.filter(e => e.phase === 'on' && e.chars === 0);
  assert.ok(zeros.length > 0,
    'prefill 死寂窗里必须发一条 chars=0 的 thinking{phase:"on"} —— '
    + 'chars 恒 0 的开场也要点灯, 不许因为"没有字数"就不发');

  // ② 开了必须关: 最后一个 phase=on 之后必须有 phase=off。
  //    关了不关 = 永远转圈, 比死寂更糟。
  const lastOn = evs.map(e => e.phase).lastIndexOf('on');
  assert.ok(lastOn >= 0, '没有 phase=on 的 thinking 事件');
  const offs = evs.map(e => e.phase).filter(p => p === 'off');
  assert.ok(offs.length > 0,
    'thinking 开了没关 —— 思考灯永远转圈, 比死寂更糟');
  const lastOff = evs.map(e => e.phase).lastIndexOf('off');
  assert.ok(lastOff > lastOn,
    '最后一个 phase=on 之后必须有 phase=off (事件序: '
    + evs.map(e => e.phase).join(',') + ')');

  // ③ phase 集合封闭 —— 只有 on / off 两种。
  //    发第三种 phase 没有消费者, 就是死事件 (下一个人还会照着它写前端)。
  const phases = [...new Set(evs.map(e => e.phase))].sort();
  assert.deepStrictEqual(phases, ['off', 'on'],
    'thinking 的 phase 集合必须封闭在 {on, off}, 实际 ' + JSON.stringify(phases));

  // ④ 停滞判据只能按耗时 —— 事件必须带 ts, 消费方才有"停了多久"可用。
  //    (chars 只说明"还在想", 不涨也不等于死。前端那条 300s 熔断随桌面端下线,
  //     core 这边目前没有停滞熔断, 如实记账, 不凭空造常量。)
  assert.ok(evs.every(e => Number.isFinite(e.ts)),
    '每条 thinking 必须带 ts —— 没有时间戳, 消费方就只剩 chars 可用, '
    + '而 chars 在开场恒为 0');
});




