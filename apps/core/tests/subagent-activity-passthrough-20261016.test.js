// 2026-10-16 子 agent 阶段的活性黑洞 —— "跟死了一样"的真正根因
//
// 现场 fastpath-234507 (本地 qwen3.8-27b, 同一道"建 2 个文件"):
//   planner 快路生效省掉 61.8s, 两刀都跑完, 文件真落盘 —— 但主人视角是:
//   **600s 里只看到 heartbeat, 子 agent 阶段 SSE 活性事件 0 条**。
//   SSE 里那 23 条 sub_agent_progress 全部来自 `agent: dispatcher`(收口那一步)。
//
// 根因不是"子 agent 没流式" —— j2 loop 一直流式 (onText/onReasoning 都在推 delta)。
// 根因是 dispatcher 给子任务套的 sink (`_makeSinkRes`) 只穿透五类**收口**事件:
//   permission_required / warning / task_done / partial_done / sub_task_rejected
// `thinking` 和 `stream_delta` 全部被吞 → 子 agent 逐 token 吐的东西一个都没到界面。
//
// 为什么当年这么写是对的: stream_delta 会进 ChatRoom 气泡, 直接放行等于让编排旁白
// 混进正文。但"不显示正文"和"不报活性"是两件事 —— 主人要的不是看子 agent 写什么,
// 是知道它还在动。所以转成 sub_agent_progress: 只带计数和耗时, 不带内容。
//
// 这组测试钉的是**内容不许漏出去**和**活性必须出去**这一对。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');

const { _makeSinkRes } = require('../modules/j2_dispatcher');
const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// 假 res: 只记被写出去的帧
const mkRes = () => {
  const frames = [];
  return { frames, writableEnded: false, write: (d) => { frames.push(d); return true; } };
};
const parse = (frames) => frames.map((f) => {
  const i = f.indexOf('data: ');
  return { event: f.slice(7, f.indexOf('\n')), data: JSON.parse(f.slice(i + 6).trim()) };
});

// 照实抄 j2_agent_loop._emitReason / j2_loop_shared._emitStreamDelta 的两种帧形状
const THINK_ON = 'event: thinking\ndata: ' + JSON.stringify({ phase: 'on', chars: 320, ts: 1 }) + '\n\n';
const THINK_OFF = 'event: thinking\ndata: ' + JSON.stringify({ phase: 'off', chars: 604, ts: 2 }) + '\n\n';
const DELTA = 'event: stream_delta\ndata: ' + JSON.stringify(
  { type: 'stream_delta', delta: '好的', accumulated: '好的我先看看', token_count: 5, ts: 3 }) + '\n\n';

test('T1 思考帧要变成活性事件 —— 之前 0 条, 正是"跟死了一样"', () => {
  const res = mkRes();
  _makeSinkRes(res, 'kun').write(THINK_ON);
  const out = parse(res.frames);
  assert.strictEqual(out.length, 1, '子 agent 一开口就该有活性事件');
  assert.strictEqual(out[0].event, 'sub_agent_progress');
  assert.strictEqual(out[0].data.agent, 'kun', '必须带将灵归属, 否则界面上分不清谁在动');
});

test('T2 内容一个字都不许漏 —— 只报计数 (stream_delta 会污染 ChatRoom 气泡)', () => {
  const res = mkRes();
  _makeSinkRes(res, 'kun').write(DELTA);
  const raw = res.frames.join('');
  assert.ok(!raw.includes('好的我先看看'), 'accumulated 正文绝不能穿透');
  assert.ok(!raw.includes('"delta"'), 'delta 字段绝不能穿透');
  const out = parse(res.frames);
  assert.strictEqual(out[0].data.content_chars, '好的我先看看'.length, '只报字数');
});

test('T3 thinking 的 chars 是**思考**字数, 别记成正文 —— 记错比不报更误导', () => {
  const res = mkRes();
  _makeSinkRes(res, 'kan').write(THINK_ON);
  const d = parse(res.frames)[0].data;
  assert.strictEqual(d.thinking_chars, 320);
  assert.strictEqual(d.content_chars, 0, '模型在思考时不该报"正在写正文"');
});

test('T4 节流: thinking 每 250ms 一帧, 不节流能把主人那边刷成瀑布', () => {
  const res = mkRes();
  const sink = _makeSinkRes(res, 'kun');
  for (let i = 0; i < 40; i++) {
    sink.write('event: thinking\ndata: ' + JSON.stringify({ phase: 'on', chars: i, ts: i }) + '\n\n');
  }
  const out = parse(res.frames);
  assert.ok(out.length >= 1, '至少要有一条');
  assert.ok(out.length <= 6, `40 帧应该被节流到个位数, 实际穿透 ${out.length} 帧`);
});

test('T5 收尾帧 (phase=off) 不节流 —— 那是"想完了"的信号, 不能被节流吞掉', () => {
  const res = mkRes();
  const sink = _makeSinkRes(res, 'kun');
  sink.write(THINK_ON);
  sink.write(THINK_OFF);
  const out = parse(res.frames);
  assert.ok(out.some((o) => o.data.phase === 'off'), '思考结束的帧必须到');
  assert.strictEqual(out[out.length - 1].data.thinking_chars, 604, '终值要带上');
});

// ── 2026-10-16 追加: 活性事件必须自带时间戳 ────────────────────────────────
//
// 现场 e2e-full-20261016 实测: 同一条 SSE 流里 gua / plan / sub_agent_start /
// sub_agent_done 全都带 ts, **唯独 91 条 sub_agent_progress 一条都没有**。
// 后果有两层:
//   1. 主人看到的是一张写着"运行中"的卡 —— 读不出"最后一次活动是什么时候",
//      所以分不清它在想、在调工具、还是已经卡死。这是"跟死了一样"里最要命的一半
//      (另一半是整轮 0 张卡, 已修)。
//   2. 探针也是瞎的: 我按 ts 切时间线, 91 条进度全被过滤成 0, 思考曲线根本画不出来
//      —— 想量"思考占多少时间"都量不了。
// 活性事件证明不了自己活着, 就等于没报。
test('T6 每条 sub_agent_progress 都必须带 ts —— 不带就没法判断"还在动"', () => {
  // 两条路径分开用两个 sink: 思考/正文那条有 1500ms 节流 (T4), 同一次 write 连发
  // 必然只放行一条, 混在一起数会误判成"少转了一条"。batch_complete 那条不走节流。
  const res = mkRes();
  const sinkThink = _makeSinkRes(res, 'li');
  const sinkTool = _makeSinkRes(res, 'li');
  const t0 = Date.now();
  sinkThink.write(THINK_ON);
  sinkThink.write(DELTA);           // 被节流吃掉 —— 这正是 T4 的行为
  sinkTool.write('event: batch_complete\ndata: ' + JSON.stringify(
    { tool_names: ['read_file'], round: 1, batch: 0 }) + '\n\n');
  const out = parse(res.frames);
  assert.ok(out.length >= 2,
    `思考路径 + 工具路径各该转成一条活性事件, 实际 ${out.length} 条`);
  assert.ok(out.some((o) => o.data.stage === 'sub_progress'), '思考/正文路径要出活性事件');
  for (const o of out) {
    assert.ok(typeof o.data.ts === 'number' && o.data.ts >= t0 && o.data.ts <= Date.now(),
      `${o.data.stage} 这条活性事件没有可信 ts —— 字段=${JSON.stringify(o.data.ts)}`);
  }
  // tool_executed 那条 ms 和 ts 必须是同一个值, 不能是两次 Date.now() 各算各的
  const te = out.find((o) => o.data.stage === 'tool_executed');
  assert.ok(te, '工具活动也要有 ts');
  assert.strictEqual(te.data.ms, te.data.ts, 'ms 与 ts 必须同源, 否则两个时间会差几毫秒互相矛盾');
});

test('T7 上游帧的 ts 不能直接抄 —— 那是模型侧的时间, 不是本地发生的时间', () => {
  // THINK_ON / THINK_OFF / DELTA 的 ts 分别是 1/2/3, 是照抄的假值。
  // 如果实现图省事写 out.ts = payload.ts, 界面拿到的就是 1970 年的时间,
  // "最后活动 56 年前" —— 比不报更坏。
  const res = mkRes();
  _makeSinkRes(res, 'li').write(THINK_ON);
  const d = parse(res.frames)[0].data;
  assert.notStrictEqual(d.ts, 1, 'ts 必须取本地 Date.now(), 不能抄上游');
  assert.ok(d.ts > 1_600_000_000_000, 'ts 得是像样的 epoch 毫秒');
});

test('T6 原来的五类收口事件继续穿透, 一个都不能被这次改动挤掉', () => {
  const res = mkRes();
  const sink = _makeSinkRes(res, 'dui');
  sink.write('event: warning\ndata: {"message":"对账不通过"}\n\n');
  sink.write('event: task_done\ndata: {"ok":true}\n\n');
  sink.write('event: partial_done\ndata: {}\n\n');
  sink.write('event: sub_task_rejected\ndata: {}\n\n');
  const events = parse(res.frames).map((o) => o.event);
  for (const e of ['warning', 'task_done', 'partial_done', 'sub_task_rejected']) {
    assert.ok(events.includes(e), `${e} 必须照旧穿透 (2026-09-18 老板点名的对账拦截)`);
  }
});

test('T7 连接断了就什么都别写 (writableEnded), 别往死连接上怼', () => {
  const res = mkRes();
  res.writableEnded = true;
  _makeSinkRes(res, 'kun').write(THINK_ON);
  assert.strictEqual(res.frames.length, 0, '连接已断不该再写');
});

test('T8 接线: 主派发路径真的用了这个 sink (定义存在 ≠ 那条路用了它)', () => {
  // 按行定位: sink 构造和它那次调用隔着几十行, 按字符窗口切会切不全。
  // 2026-10-17: sink 构造和那次调用一起搬进了 subagent_runner (主 agent 复用同一份
  // 派发)。"定义存在 ≠ 那条路用了它" 这条本意一字未动, 只换了读哪个文件。
  const lines = SRC('modules/subagent_runner.js').split('\n');
  const callLine = lines.findIndex((l) => /_subModelForRequest,\s*req,\s*_sinkRes,/.test(l));
  assert.ok(callLine > 0, '子任务主派发路径还在');
  // sink 必须在这次调用**之前**构造出来, 同一个子任务作用域内
  // 2026-10-17: 这条正则原来写成 `_makeSinkRes(res, subTask.agent)` —— 结尾那个右括号
  // 等于**硬性断言 sink 只收两个参数**。但本条的意图是"子任务必须走 sink"(别直接传 res,
  // 否则编排旁白混进正文气泡), 参数个数从来不是它要守的东西。
  // 10-17 为了修前端活性事件丢光, 给 sink 加了第三个参数 task (前端用 agent+task 做匹配键,
  // 不带就永远对不上卡片), 于是这条断言红了 —— 又一次"护栏挡住的不是回归, 是修正"。
  // 放宽的只是参数个数, "必须走 sink" 一点没松; 而且第三个参数现在由
  // subagent-progress-task-key-20261017 的 C2 钉得更死 (以前根本没人管它传什么)。
  const constructed = lines.findIndex((l, i) => i < callLine && /_makeSinkRes\(res,\s*subTask\.agent\b/.test(l));
  assert.ok(constructed > 0,
    '子任务必须走 _makeSinkRes —— 直接传 res 会让编排旁白混进正文气泡');
  const window = lines.slice(Math.max(0, callLine - 3), callLine + 3).join('\n');
  assert.ok(!/,\s*req,\s*res,/.test(window),
    '子任务不许直接把父 res 传进 j2 loop —— 那等于没有 sink, 编排旁白会进正文气泡');
});

test('T9 收口不许把将灵代号当标题复读 (现场: final 开头就是 "### executor")', () => {
  const { _buildSynthesisMessages } = require('../modules/j2_dispatcher');
  const msgs = _buildSynthesisMessages('s1', '建两个文件', '', [
    { agent: 'kun', task: '建文件', result: { summary: '建好了' } },
    { agent: 'dui', task: '读回确认', result: { summary: 'PASS' } },
  ], 3000);
  const sys = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  assert.ok(/内部定位锚/.test(sys),
    '综合 system prompt 必须明说 agent: 这行是内部锚, 不是输出内容');
  // 注入块本身不能被改 —— agent:/task: 是模型定位"哪个结论属于哪一刀"的依据
  const user = msgs.find((m) => m.role === 'user').content;
  assert.ok(/agent: kun/.test(user), '注入块仍要保留 agent: 定位锚');
  assert.ok(/agent: dui/.test(user));
});

test('T10 四条收口路径必须共用同一条禁令 —— 抄四遍的坑已经踩过一次', () => {
  // 现场: 我只改了 _buildSynthesisMessages 那份, 实机走的是主派发那份, 于是"改了没生效"。
  // 这条断言的作用是让"新增一条收口路径却忘了挂禁令"当场失败, 而不是等实机才发现。
  //
  // 2026-10-23 第 63 批: 判据换了对象。
  // 原来钉的是「三条内联 prompt 各挂一次常量 + 引用共 4 处」——
  // 也就是**钉抄本份数**。综合提示词收成唯一真源(synth_prompt.js)之后内联归零,
  // 旧判据必然红。而且它数引用时把**注释行**也数进去了(本项目老坑)。
  // 现在钉的是机制: 禁令只定义一次 ⇒ 四条路径要么从真源拿, 要么自己挂常量,
  // 而「不许各抄一份文案」由 synth-prompt-single-20261023.test.js 的 T6/T8 兜住
  // (那边扫全部拼装点 + 全库抄本指纹, 覆盖面更宽)。别再在这里加同义的扫源码断言。
  const strip = (s) => String(s)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
  const src = strip(SRC('modules/j2_dispatcher.js'));
  const lines = src.split('\n');
  // 只允许一份定义 (定义行含 const), 引用处必须全部是"用常量"而不是"再抄一遍文案"
  const defs = lines.filter((l) => /const\s+_SYNTH_NO_ROLE_LABEL\s*=/.test(l));
  assert.strictEqual(defs.length, 1, '常量只能定义一次');
  // 剥注释后: 第 89 批 (2026-10-25) 之后, 禁令**只在唯一拼装点**
  //   `_synthesisSystemMessages` 里被引用一次, 四条路径全部经由它拿到。
  //
  // 为什么从「3 处引用」变成「1 处引用」: 「3 处引用」这件事**只钉住了份数**,
  //   钉不住「挂法」—— 三处引用的**形态**可以不一样 (走真源的 noRoleLabel 参数 /
  //   独立 system 消息 / 合并进同一条), 而每种形态单独看都通得过。
  //   2026-10-25 实跑撞的就是这个: 主路是两条独立 system 消息, 关键词兜底路是
  //   合并成一条, 改禁令时两条路只有一条跟得上, 而测试全绿。
  //   ⇒ 现在引用收敛到 1 处, **挂法不可能再分叉**。
  //   (原来数 4 处引用时把注释行也算进去, 所以这里必须先剥注释再数。)
  const uses = lines.filter((l) => l.includes('_SYNTH_NO_ROLE_LABEL')
    && !/const\s+_SYNTH_NO_ROLE_LABEL/.test(l));
  assert.strictEqual(uses.length, 1,
    `禁令只许在唯一拼装点里被引用一次 (四条路径共用它); 实际 ${uses.length} 处引用 —— `
    + '多出来的那处就是「同一条禁令两种挂法」的开始; '
    + '注意: 剥了注释再数, 注释里提到常量不算)');
  // 反向钉住: 关键词兜底仍是两条路, 两条共用那一条禁令
  assert.strictEqual((SRC('modules/j2_dispatcher.js').match(/await _keywordFallbackCloseOut\(results\);/g) || []).length, 2,
    '关键词兜底仍是两条路, 两条都得挂上那条禁令');
  // 那唯一一处必须**是 system 消息的 content** ——
  // 不许出现"引用了常量但挂的不是 system 消息"这种半吊子 (挂不到位 = 禁令落空)。
  for (const l of uses) {
    const ok = /role:\s*'system',\s*content:\s*_SYNTH_NO_ROLE_LABEL\s*\}?/.test(l);
    assert.ok(ok, `这处引用挂法不对, 会让禁令落到不到位: ${l.trim().slice(0, 100)}`);
  }
  // 真调验它确实带上了禁令, 且**逐字等于**唯一拼装点的产物
  const disp = require('../modules/j2_dispatcher');
  const msgs = disp._buildSynthesisMessages('s', 'q', '', [
    { agent: 'kun', task: 't', result: { summary: 'ok' } }], 3000);
  const sys = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  assert.ok(/内部定位锚/.test(sys), '第四条收口路径也要带上禁令');
  assert.deepStrictEqual(
    msgs.filter((m) => m.role === 'system').map((m) => m.content),
    disp._synthesisSystemMessages('q').map((m) => m.content),
    '综合路径拿到的 system 消息与唯一拼装点的产物不逐字一致 —— 挂法分叉了');
});

test('T11 出口防御: 本地模型不听 prompt 禁令时, 标题里的将灵代号也要剥掉', () => {
  const { _finalizeAnswerText } = require('../modules/j2_dispatcher');
  // 现场: 禁令四条路径全挂上了, 本地 27B 照样复读 "### executor" —— 光靠 prompt 不可靠
  const dirty = '### executor\n\n① 完成: 建好 f1.txt\n\n---\n\n### checker\n\n① 完成: PASS';
  const out = _finalizeAnswerText(dirty, '兜底');
  assert.ok(!/###\s*executor/i.test(out), 'executor 代号必须剥掉');
  assert.ok(!/###\s*checker/i.test(out), 'checker 代号必须剥掉');
  assert.ok(/建好 f1\.txt/.test(out), '真结论一个字都不许丢');
  assert.ok(/PASS/.test(out), 'checker 的结论必须保留 —— 剥的是标签不是内容');
});

test('T12 剥的只是将灵代号标题, 主人自己要的分节不许被误伤', () => {
  const { _finalizeAnswerText } = require('../modules/j2_dispatcher');
  const good = '## 结论\n\n已完成两个文件的创建与核验。\n\n## 证据\n\nls + cat 读回逐字一致。';
  const out = _finalizeAnswerText(good, '兜底');
  assert.ok(/## 结论/.test(out), '主人要的中文分节必须保留');
  assert.ok(/## 证据/.test(out));
  assert.ok(!/_finalize/.test(out));
});
