'use strict';

// 2026-10-15: "盘古调用模型没问题, 但不是流式输出, 调用有没有用工具完全不知道, 跟死了一样"
//
// 现场证据 (LM Studio 服务端日志 2026-10-15.log):
//   21 个完整请求, 平均 77.4s / 最长 300s / 最短 12s, 期间界面零输出。
// 查出四个**互相独立**的断点, 少修一个体感都不变:
//
//   1. native 主循环的 onText 只 `streamedText += d`, res.write 一次都没有。
//      而 llm_caller 早就在流式推 (还把 reasoning_content 包成 <think> 转进来,
//      L1394-1397) —— 断点就在回调这一行。改前 77s 静默, 改后逐 token 出。
//   2. 后端每 5s 推 heartbeat (j2_agent_loop L556), 前端 ChatRoom 压根没监听
//      (`eventName === 'heartbeat'` 匹配数 0)。后端注释写的"用户能感知还在活不靠猜"是空话。
//   3. 所有 tool_call emit 发的是 `{calls:[...]}`, 前端只认单条 `{id,name}`
//      → obj.id 恒 undefined → **ToolCall 卡片从上线起一次都没渲染过**。
//      这条直接对应"调用有没有用工具完全不知道"。
//   4. 后端 48 处 warning / 5 处 model_switch, 前端同样一个都不收 —— 真出事时同样静默。
//
// 生产走的是 native 路径 (日志实证 j2-native 69 次 vs j2-legacy 8 次),
// 而 stream_delta 只在 legacy 路径发 (L2829/2868/2922) —— 所以必须查 native。
//
// ── 2026-10-26 第 107 批 (桌面端下线) ──
// 这个文件原来把"服务端发事件"和"前端收事件"混在一条条断言里 (S2/S3/S4/S5/S7/S8
// 各有一半在前端)。桌面端下线后前端那一半连同 ChatRoom.jsx / ActivityLine.tsx
// 一起没了 —— 但**服务端那一半全部保留**, 而且把它扶正成**事件契约**:
//   "服务端必须发这个事件, 载荷必须带这些字段"。
// 这样守的仍然是原来那个意图 (工具调用/思考/告警不许被静默丢掉), 只是不再靠
// "某个 React 组件认不认这个事件"来证明 —— 那种证明方式随前端一起消失了。
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const LOOP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
const SHARED_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'modules', 'j2_loop_shared.js'), 'utf8');

test('S1 native 的 onText 必须把 token 推给前端 (断点1: 之前只攒进本地变量)', () => {
  // 取 native 分支那段 onText (第一处 _callLLMForAgent 调用之后)
  const start = LOOP_SRC.indexOf('llmResult = await _deps._callLLMForAgent(');
  assert.ok(start > 0, '要能找到 native 的 _callLLMForAgent 调用点');
  const seg = LOOP_SRC.slice(start, start + 2000);
  const onTextAt = seg.indexOf('onText:');
  assert.ok(onTextAt > 0, 'native 分支必须传 onText');
  const cbEnd = seg.indexOf('});', onTextAt);
  const cb = seg.slice(onTextAt, cbEnd);
  assert.match(cb, /streamedText\s*\+=/, '仍要累积 streamedText (轮末判定要用)');
  assert.match(cb, /_emitStreamDelta\(/,
    '断点1: onText 必须 _emitStreamDelta 推给前端, 否则 77s 全静默');
});

test('S2 heartbeat 后端在发、前端必须收 (断点2: 前端匹配数 0 等于没发)', () => {
  assert.match(LOOP_SRC, /event: heartbeat/, '后端仍在推 heartbeat');
  // 2026-10-26: 载荷必须带 phase —— 客户端靠它区分"还在跑"和"这一轮结束了"。
  // (原来这条断言在前端: "必须只收 phase==active"。现在改成服务端契约:
  //  服务端必须**发得出** phase, 否则客户端无从判断。)
  const at = LOOP_SRC.indexOf('event: heartbeat');
  const seg = LOOP_SRC.slice(Math.max(0, at - 600), at + 600);
  assert.match(seg, /phase/,
    '断点2: heartbeat 载荷必须带 phase —— 客户端要靠它分"还在跑"和"结束了"');
});

test('S3 tool_call 载荷形状必须对上 (断点3: 后端发 {calls:[...]}, 前端只认 {id,name})', () => {
  // 后端三处 tool_call emit 的实际形状
  const emits = LOOP_SRC.match(/event: tool_call[^\n]*\n?[^\n]*/g) || [];
  assert.ok(emits.length >= 3, '后端有多处 tool_call emit');
  const arrayShaped = emits.filter(e => /calls:/.test(e));
  assert.ok(arrayShaped.length >= 2,
    '后端主流形状是 {calls:[...]} — 前端只认单条就是恒假');
  // 2026-10-26: 数组形状里的每一条必须带 name + id —— 客户端靠 id 把
  // tool_result 对回 tool_call, 少一个字段就成不了对。
  const seg = LOOP_SRC.slice(
    LOOP_SRC.indexOf("event: tool_call"),
    LOOP_SRC.indexOf("event: tool_call") + 900);
  assert.match(seg, /name:/, '断点3: tool_call 的 calls 里必须带 name');
  assert.match(seg, /id:/, '断点3: tool_call 的 calls 里必须带 id (靠它配对 tool_result)');
});

test('S4 warning / model_switch 也得收 (断点4: 后端 48 处 warning 前端全丢)', () => {
  const warns = LOOP_SRC.match(/event: warning/g) || [];
  assert.ok(warns.length >= 10, '后端大量发 warning');
  // 2026-10-26: 换成服务端契约 —— warning 必须真的发得出去, 且带可读信息。
  const at = LOOP_SRC.indexOf('event: warning');
  const seg = LOOP_SRC.slice(Math.max(0, at - 300), at + 500);
  assert.match(seg, /message|msg|text|error/,
    '断点4: warning 载荷必须带可读信息 —— 一个空 warning 等于没发');
  assert.ok(LOOP_SRC.includes('event: model_switch'),
    '断点4: model_switch 也要发 (悄悄换了模型用户得知道)');
});

test('S5 流式通道不许重复推 — final 事件是替换不是追加', () => {
  // summary 路径 (:3483 附近) 已经是"累积 + 游标去重"的正确写法, native 照搬
  assert.match(SHARED_SRC, /__panguVisibleLen/,
    '_emitStreamDelta 必须带游标, 否则增量会重复');
  const i = LOOP_SRC.indexOf('onText: (d) => { _sumStreamed += d; _emitStreamDelta(');
  assert.ok(i > 0, 'summary 路径是既有的正确参考实现');
  // 2026-10-26: 游标去重是**服务端**的事 (服务端保证同一份文本只推一次),
  // 原来那条"前端整体替换气泡"的断言随前端一起删 —— 但服务端这一侧不许松:
  // 游标必须在同一个坐标系里比。
  assert.match(SHARED_SRC, /previousVisible|__panguVisibleLen/,
    '流式通道不许重复推 —— 游标必须存在 (final 是替换不是追加)');
});

test('S6 reasoning_content 必须能被推到前端 (本地 27B 的 content 是空的)', () => {
  // 现场 27/27 响应: content 为 "\n\n\n\n\n" 或 "", 真正内容在 reasoning_content。
  // llm_caller 已把它包成 <think> 喂 onText —— 前端 appendDelta 会剥掉标签,
  // 所以只要 S1 的转发通了, 思考期就能显示 (气泡显示 thinkPhase)。
  //
  // ⚠ 2026-10-27 (第 112 批): 这条原来还有第二个断言 —— 「非流式也要有
  // reasoning_content fallback」。**那个断言被现场证伪了**, 删掉:
  //   2026-10-26 八字排盘 AI 解读: content 空时拿 reasoning_content 当答案 ⇒
  //   主人收到 13754 字的英文自说自话, 九节只剩四个标题。
  // ⇒ 思考是**事实**, 不是答案: 非流式只报「这轮没答上来」(reasoningOnly),
  //   由上层重试/升级/明说, **不许**在传输层悄悄换个东西顶上去。
  //   流式那条 (思考喂 onText, 让前端显示思考相位) 不变 —— 那是**另一个**契约。
  const CALLER = fs.readFileSync(
    path.join(__dirname, '..', 'modules', 'llm_caller.js'), 'utf8');
  assert.match(CALLER, /opts\.onText\(delta\.reasoning_content\)/,
    'llm_caller 必须把 reasoning_content 转进 onText');
  assert.match(CALLER, /reasoningOnly: true/,
    '非流式必须报出「只回思考」这个事实 (上层据此重试/升级)');
  assert.doesNotMatch(CALLER, /m\.content === '' && m\.reasoning_content/,
    '「思考冒充正文」的兜底不许复活 (2026-10-26 现场证伪)');
});

test('S7 工具可见性走"一行一事件", 既不是卡片墙也不是隐藏', () => {
  // 老板 2026-10-09 拍过"蓝框能不能不显示出来" (一屏十几张卡片把回答挤下去),
  // 10-18 又拍「还是没有任何显示」+「一个一个往下走, 这样用户知道盘古还活着」。
  // 这两个极端当年是**同一个开关** (SHOW_TOOL_CARDS) 造成的: 关掉 = 工具彻底不见。
  // 2026-10-18 定案: 一行一事件 (ActivityLine) —— 靠左、无气泡、按到达顺序往下走。
  // 下面三条锁的是**意图** (工具名要看得见 / 跑完要收口 / 不能刷屏), 不是呈现形式。
  //
  // 2026-10-26: 这一整条原来锁的是前端的呈现方式 (一行一事件 / 靠左 / 无气泡 /
  // 工具名说人话), 随界面一起下线。但它守的**意图**不许丢:
  // 「工具活动不许被静默隐藏」—— 这一半是**服务端**的责任:
  // 服务端必须真的把 tool_call / tool_result 发出去, 发不出去 = 没人知道它用了工具。
  // 呈现成什么样是客户端的事; 发不发是服务端的事。
  assert.ok(LOOP_SRC.includes('event: tool_call'),
    'S7: 服务端必须发 tool_call —— 发不出去, 客户端就无从知道"有没有在用工具"');
  assert.ok(LOOP_SRC.includes('event: tool_result'),
    'S7: 服务端必须发 tool_result —— 跑完/失败要一眼可见');
  // 成对: tool_result 必须带 id, 客户端靠它把结果对回调用
  const at = LOOP_SRC.indexOf('event: tool_result');
  const seg = LOOP_SRC.slice(Math.max(0, at - 300), at + 500);
  assert.match(seg, /id:/,
    'S7: tool_result 必须带 id —— 客户端靠它把结果对回 tool_call');
});

test('S8 思考相位必须有独立信号 — stream_delta 单独治不了死寂', () => {
  // 这是最关键的一条。忠实复刻 _emitStreamDelta + llm_caller 的喂法实测:
  //   feed('<think>') / feed('两段 reasoning') / feed('</think>') / feed('\n\n北京')
  //   → 4 次喂入, 只 emit **1** 条 stream_delta, 且是最后的正文。
  // 思考内容被整段剥掉是**对的** (思考不该进气泡), 但后果是本地 27B 思考的那
  // 30~300 秒里前端一条 SSE 都收不到 —— 光把 onText 接通 (S1) 仍然是"跟死了一样"。
  // 所以必须有 onReasoning → event:thinking 这条独立通道。
  const CALLER = fs.readFileSync(
    path.join(__dirname, '..', 'modules', 'llm_caller.js'), 'utf8');
  assert.match(CALLER, /opts\.onReasoning\(true/,
    'llm_caller 必须在 reasoning 开始时通知 (本地模型 content 恒空, 这是唯一信号)');
  assert.match(CALLER, /opts\.onReasoning\(false/,
    '思考结束也要通知, 否则前端一直显示思考中');
  // 2026-10-15: 思考灯的发射逻辑从 inline 回调提成具名 _emitReason,
  // 好让"请求发出前先点亮 + 轮末关灯"复用同一段代码 (见 prefill 死寂窗那处修复)。
  // 断言跟着结构走, 但三件事一件都不能松: 接上 onReasoning / 发成 SSE / 节流。
  const i = LOOP_SRC.indexOf('onReasoning:');
  assert.ok(i > 0, 'native 必须传 onReasoning');
  const wiring = LOOP_SRC.slice(i, i + 120);
  assert.match(wiring, /onReasoning:\s*_emitReason/,
    'native 的 onReasoning 必须接到 _emitReason');
  const def = LOOP_SRC.indexOf('const _emitReason =');
  assert.ok(def > 0, '要能找到 _emitReason 定义');
  const seg = LOOP_SRC.slice(def, def + 700);
  assert.match(seg, /event: thinking/, '_emitReason 必须把思考相位发成 SSE');
  assert.match(seg, /< 250/, '必须节流 (本地模型每秒几十个 delta, 不节流会把前端打爆)');
  // 2026-10-26: 前端那半 ("前端必须收 thinking" / "显示思考字符数") 随界面删。
  // 服务端这一半要扶正: 载荷必须带 chars —— 客户端靠"字符数在涨"判断模型还在动。
  assert.match(seg, /chars:/,
    'S8: thinking 载荷必须带 chars —— 客户端靠"字符数在涨"证明模型还在动');
});

test('S10 全 system 的请求必须挡住 (jinja 直接 400, 不是"模型空回复")', () => {
  // 现场 LM Studio 日志 15:28:35: 9 条消息全是 system, 一条 user 都没有 →
  //   ERROR: Error rendering prompt with jinja template: "No user query found in messages."
  // 端点是 400 拒绝, 不是返回空内容。上层把它读成 EMPTY_CONTENT_ROUND → 白烧一整轮
  // + 界面弹一次"模型卡顿"假警报。模型其实什么都没做错。
  const CALLER = fs.readFileSync(
    path.join(__dirname, '..', 'modules', 'llm_caller.js'), 'utf8');
  assert.match(CALLER, /function _ensureUserTurn\(/, '必须有 _ensureUserTurn 这个闸');
  // 两条路径都要接 (非流式 raw + 流式 agent)
  const calls = CALLER.match(/_ensureUserTurn\(messages, useModel\)/g) || [];
  assert.ok(calls.length >= 2,
    'raw 和 stream 两条路径都要接 —— 只接一条等于漏一半');
  // 有 user 时不许动消息 (不能污染正常对话)
  assert.match(CALLER, /if \(arr\.some\(m => m && m\.role === 'user'\)\) return arr;/,
    '有 user 消息时必须原样返回, 不许篡改正常请求');
  // 必须留痕: 触发源在上层, 不打日志就永远查不到
  assert.match(CALLER, /NO_USER_TURN/, '必须打日志 (触发源是 auto-resume/checkpoint, 不留痕查不到)');
});

test('S11 _ensureUserTurn 行为正确 (补 user / 不动有 user 的 / 不改原数组)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'modules', 'llm_caller.js'), 'utf8');
  const start = src.indexOf('function _ensureUserTurn(');
  assert.ok(start > 0);
  // 抽出函数体在沙箱里跑 (不 require 整个模块 —— 它依赖注入的 _config)
  const body = src.slice(start, src.indexOf('\n}\n', start) + 3);
  const fn = new Function('console', body + '\nreturn _ensureUserTurn;')(
    { warn() {}, log() {}, error() {} });

  const onlySystem = [{ role: 'system', content: 'a' }, { role: 'system', content: 'b' }];
  const out = fn(onlySystem);
  assert.strictEqual(out.length, 3, '9 条全 system 要补一条 → 10 条');
  assert.strictEqual(out[2].role, 'user', '补的必须是 user');
  assert.ok(String(out[2].content).length > 0, '占位内容不能是空的 (空的又会被 jinja 拒)');
  assert.strictEqual(onlySystem.length, 2, '不许原地改调用方的数组');

  const withUser = [{ role: 'system', content: 'a' }, { role: 'user', content: 'hi' }];
  assert.strictEqual(fn(withUser), withUser, '有 user 就原样返回 (同一引用)');
});

