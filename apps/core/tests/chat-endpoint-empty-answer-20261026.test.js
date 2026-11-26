'use strict';

// 2026-10-26 (第 106 批): 兼容端点 `/message` `/chat` `/api/chat` 回**空气泡**
//
// ─────────────────────────────────────────────────────────────────────────
// 现场 (2026-10-26 生产 :18901 实测):
//
//   curl -X POST :18901/api/chat -d '{"messages":[{"role":"user",
//         "content":"用一句话说明你现在能做什么。"}]}'
//   → {"ok":true,"choices":[{"message":{"role":"assistant","content":""}}]}
//
// ⇒ **ok:true + 空 content** = 主人看到一片空白, 而且没有任何报错。
//
// ─────────────────────────────────────────────────────────────────────────
// 真因 (两层):
//
//   ① 这条路径是**裸 callLLM, 没有工具循环** (`_buildOpenAIPayload(…, null, false)`
//      —— tools 传 null)。模型想调工具时, 正文要么是空, 要么是**工具草稿**。
//      2026-10-19 加的「模型只吐了工具调用草稿 ⇒ 拦截未交付」把正文剥成了空串。
//   ② `guardAnswer(q, '', fallback)` 返回 `{text:'', aligned:true}` ——
//      因为 `answer_alignment.isAligned` 里 `if (!q || !a || q.length < 6) return true;`
//      ⇒ **空答案被判「对齐」直接放行** ⇒ content = '' ⇒ 回空气泡。
//
// ⚠ 为什么不改 `isAligned` 的空答案语义: 那会波及主路径
//   (`j2_agent_loop.js:1382` / `j2_dispatcher.js:171` —— 那两处**故意**把空当「不拦」)。
//   ⇒ 不变量落在**端点这一层**: 谁负责出答复, 谁负责保证答复不是空。
//
// ─────────────────────────────────────────────────────────────────────────
// 修法: **升级阶梯** (规则本体在 modules/chat_answer_policy.js —— 纯函数, 可直接测)
//   ① 单发拿到答案 ⇒ 直接回 (默认路径**零延迟变化**)
//   ② 单发拿到**工具草稿 / 空** ⇒ 这道题需要工具 ⇒ **升级**到真 agent loop (有工具) 拿真答案
//   ③ 升级后仍没有 ⇒ 明确说「没答上来」, **绝不** content:""
//
//   顺带把「run_j2: true」这个写在注释里两年、源码里却是 `if (false && …)` 的
//   **死承诺**真正接上 (老收集器认的事件名 `event: chunk` 早就不存在了,
//   真实契约是 `event: stream_delta` / `event: final` ⇒ 老收集器收到的也是空)。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const policy = require(path.join(ROOT, 'modules', 'chat_answer_policy.js'));
const { createSseCollector } = require(path.join(ROOT, 'modules', 'sse_text_collector.js'));

/** 真实 SSE 帧 (事件名取自 j2_loop_shared / j2_agent_loop 的实际发射点) */
function sse(event, data) {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

test('106-1: SSE 收集器认的是**真实事件契约** (老收集器认的 chunk 早就不存在了)', () => {
  // ① 权威稿: final.text
  let c = createSseCollector();
  c.res.write(sse('stream_delta', { type: 'stream_delta', delta: '盘古', accumulated: '盘古' }));
  c.res.write(sse('final', { text: '盘古。跑在你 Mac 上的谋断 agent。', ts: 1 }));
  c.res.write(sse('done', { status: 'ok', rounds: 1, result: 'x' }));
  assert.equal(c.getText(), '盘古。跑在你 Mac 上的谋断 agent。');

  // ② 没有 final 时用 stream_delta.accumulated
  c = createSseCollector();
  c.res.write(sse('stream_delta', { delta: '你好', accumulated: '你好' }));
  c.res.write(sse('stream_delta', { delta: '啊', accumulated: '你好啊' }));
  assert.equal(c.getText(), '你好啊');

  // ③ 老事件名 `chunk` **不再被收集** —— 这正是老收集器永远收到空的原因
  c = createSseCollector();
  c.res.write(sse('chunk', { delta: '老事件名' }));
  assert.equal(c.getText(), '', '`event: chunk` 不该再被当成正文 (真实契约里没有它)');

  // ④ done.status=failed 时, done.result 是**错误说明**, 不能当答案
  c = createSseCollector();
  c.res.write(sse('done', { status: 'failed', result: '没收到你的问题内容。请把要问的话再发一次。' }));
  assert.equal(c.getText(), '', '失败说明不能当答案上屏');
  assert.ok(c.getError().length > 0, '失败要留下错误说明');

  // ⑤ 心跳注释行不能污染正文
  c = createSseCollector();
  c.res.write(': keepalive\n\n');
  c.res.write(sse('final', { text: '正文' }));
  assert.equal(c.getText(), '正文');

  // ⑥ 帧被拆成多次 write 也要能拼回来
  c = createSseCollector();
  c.res.write('event: final\ndata: {"te');
  c.res.write('xt":"拼回来的正文"}\n\n');
  assert.equal(c.getText(), '拼回来的正文');

  // ⑦ 真实收口信号是 `event: status` (done 的真实 payload 里**没有** status/result)
  //    失败时 reason 是错误说明 —— 只进 getError(), 不能当答案上屏
  c = createSseCollector();
  c.res.write(sse('status', { status: 'failed', reason: '模型端点不可用', duration_ms: 12, rounds: 2 }));
  c.res.write(sse('done', { rounds: 2, tools_used: [], total_chars: 0, model_used: 'x' }));
  assert.equal(c.getText(), '', '失败说明不能当答案上屏');
  assert.ok(c.getError().length > 0, 'status=failed 要留下错误说明');

  // ⑧ status=done 是正常收口, 不能被当成错误
  c = createSseCollector();
  c.res.write(sse('status', { status: 'done', reason: null, duration_ms: 12, rounds: 1 }));
  c.res.write(sse('final', { text: '答完了' }));
  assert.equal(c.getText(), '答完了');
  assert.equal(c.getError(), '', '正常收口不该留下错误说明');

  // ⑨ 「failed」≠「没答上来」: loop 没调 task_done 时 verdict 也是 failed, 但正文可能是好的
  //    ⇒ 状态单独报 (getStatus), 没有 reason 就**不编**错误说明
  c = createSseCollector();
  c.res.write(sse('final', { text: '2' }));
  c.res.write(sse('status', { status: 'failed', reason: null, duration_ms: 57, rounds: 1 }));
  assert.equal(c.getText(), '2', '正文还在');
  assert.equal(c.getStatus(), 'failed', '状态要如实报出来');
  assert.equal(c.getError(), '', '没有 reason 就不许编一个错误说明 (会把「答对了」报成错误)');
});

test('106-2: 答复**永不为空** (不变量: ok:true 就绝不能配一个空 content)', () => {
  const CASES = [
    { guardedText: '正常答案', guardedBlocked: false, escalatedText: '', reason: 'direct' },
    { guardedText: '', guardedBlocked: false, escalatedText: '', reason: 'empty' },
    { guardedText: '', guardedBlocked: false, escalatedText: '升级后拿到的答案', reason: 'escalated' },
    { guardedText: '', guardedBlocked: true, escalatedText: '', reason: 'blocked' },
    { guardedText: '', guardedBlocked: true, escalatedText: '升级后的答案', reason: 'blocked' },
    { guardedText: '   ', guardedBlocked: false, escalatedText: '', reason: 'empty' },
    { guardedText: undefined, guardedBlocked: false, escalatedText: undefined, reason: 'empty' },
  ];
  for (const c of CASES) {
    const d = policy.decideChatAnswer(c);
    assert.equal(typeof d.content, 'string');
    assert.ok(d.content.trim().length > 0,
      `答复不许为空: ${JSON.stringify(c)}`);
    assert.equal(d.reason, c.reason, `分支判错了: ${JSON.stringify(c)}`);
  }
  // 无答案时用的是那句统一文案 (与 j2_dispatcher 同一句)
  assert.equal(policy.decideChatAnswer({ guardedText: '', guardedBlocked: false, escalatedText: '' }).content,
    '本轮未形成与原问题匹配的可核验答案，请重试。');
});

test('106-3: 什么时候升级 (只吐了工具草稿 ⇒ 这道题需要工具 ⇒ 该升级)', () => {
  // 快路径拿到答案 ⇒ 不升级 (零延迟变化)
  assert.equal(policy.needsEscalation({ guardedText: '答案', guardedBlocked: false, wasToolDraft: false }), false);
  // 判跑题 ⇒ 不升级 (那是「答了但不对题」, 升级也未必对题, 白烧一轮编排)
  assert.equal(policy.needsEscalation({ guardedText: '', guardedBlocked: true, wasToolDraft: true }), false);
  // 只吐了工具草稿 ⇒ 升级
  assert.equal(policy.needsEscalation({ guardedText: '', guardedBlocked: false, wasToolDraft: true }), true);
  // 裸模型返回空 ⇒ 升级
  assert.equal(policy.needsEscalation({ guardedText: '', guardedBlocked: false, wasToolDraft: false }), true);
});

test('106-4: 端点真的接上了策略与收集器 (源码级: 承诺不许是死代码)', () => {
  const rawSrc = fs.readFileSync(path.join(ROOT, 'pangu-single', 'routes', 'inline_router.js'), 'utf8');
  // ⚠ 断言要看**代码**, 不能看注释 —— 注释里为了说明历史, 恰好写着
  //   「源码里是 `if (false && runJ2 && …)`」, 不剥注释就会把说明当成罪证。
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  // ① 「run_j2: true」不再是死代码
  assert.doesNotMatch(src, /if \(false && runJ2/, 'run_j2 还是死代码 (承诺写了两年没兑现)');
  assert.match(src, /if \(runJ2\)/, 'run_j2 分支不见了');
  // ② 答复走策略模块, 不是就地拼的
  assert.match(src, /decideChatAnswer\(/, '端点没走 decideChatAnswer');
  assert.match(src, /needsEscalation\(/, '端点没走 needsEscalation');
  assert.match(src, /createSseCollector\(\)/, '端点没用 SSE 收集器');
  // ②-b 不变量只有**一个收口点**: run_j2 分支也不许自己拼 `|| NO_ANSWER_TEXT`
  //      (两处兜底必然漂移 —— 一处改了另一处没改, 就出现「一个端点空、一个端点不空」)
  assert.doesNotMatch(src, /\|\|\s*NO_ANSWER_TEXT/, '端点里自己拼了兜底文案 (收口点不唯一)');
  assert.doesNotMatch(src, /content:\s*_j2Text/, 'run_j2 分支绕过策略模块直接回原文');
  // ②-d 状态与错误说明**分两个字段**: loop 没调 task_done 时 verdict 也是 'failed'
  //      (完成度不足, 正文可能是好的) ⇒ 报成 agent_error 会误导客户端
  assert.match(src, /agent_status/, '端点没暴露 agent_status');
  const collectorSrc = fs.readFileSync(path.join(ROOT, 'modules', 'sse_text_collector.js'), 'utf8');
  // ⚠ 断言要看**代码**, 不能看注释 —— 注释里为了说明历史, 恰好写着 'AGENT_FAILED'
  //   (第一版就栽在这儿: 说明被当成罪证, 守卫自己报红)
  const collectorCode = collectorSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(collectorCode, /AGENT_FAILED/, '收集器编了个 AGENT_FAILED —— 「failed」不等于出了什么错');
  // ③ 端点里不许再出现「空 content」的写法
  assert.doesNotMatch(src, /content:\s*_raw\b/, '端点还在把可能为空的 _raw 直接当答复');
  // ④ 「没答上来」的文案只有一份真源 (不许在端点里再抄一遍)
  const policySrc = fs.readFileSync(path.join(ROOT, 'modules', 'chat_answer_policy.js'), 'utf8');
  assert.equal((rawSrc.match(/本轮未形成与原问题匹配的可核验答案/g) || []).length, 0,
    '端点里抄了一份「没答上来」文案 (两份同义文本必然漂移)');
  assert.ok(policySrc.includes('本轮未形成与原问题匹配的可核验答案'), '真源里没有那句文案');
});

test('106-5: 变异体检 —— 把两处修法各改回旧行为 ⇒ 守卫必须真报红', () => {
  const _MUT_SUFFIX = '.pangu-mut-backup-106';
  const _mutationGuard = require(path.join(__dirname, 'helpers', 'mutation_guard'));

  function _runGuardExpectingRed() {
    const childEnv = Object.assign({}, process.env, { PANGU_CHATENDPOINT_106_MUTATION_CHILD: '1' });
    delete childEnv.NODE_TEST_CONTEXT;
    childEnv.PANGU_REGISTRY_PATH = path.join(require('node:os').tmpdir(),
      'pangu-registry-mut106-' + process.pid + '.json');
    try {
      execFileSync(process.execPath, ['--test', __filename], {
        cwd: ROOT, stdio: 'pipe', timeout: 120000, env: childEnv,
      });
      return null;   // 全绿 = 守卫没咬 = 失败
    } catch (e) {
      return String(e.stdout || '') + String(e.stderr || '');
    }
  }

  const isChild = !!process.env.PANGU_CHATENDPOINT_106_MUTATION_CHILD;
  if (isChild) return;

  // 变异 1: 不变量拿掉 (空答复照旧上屏)
  _mutationGuard.mutateAndExpectRed({
    root: ROOT,
    file: 'modules/chat_answer_policy.js',
    from: "  if (escalatedText) return { content: escalatedText, reason: 'escalated' };\n  // ⚠ 不变量: 走到这里 content 绝不能是空串\n  return { content: fallback, reason: 'empty' };",
    to: "  if (escalatedText) return { content: escalatedText, reason: 'escalated' };\n  return { content: '', reason: 'empty' };",
    suffix: _MUT_SUFFIX,
    runGuard: _runGuardExpectingRed,
  });

  // 变异 2: 工具草稿不再触发升级 (退回「回空气泡」)
  _mutationGuard.mutateAndExpectRed({
    root: ROOT,
    file: 'modules/chat_answer_policy.js',
    from: "  if (o.wasToolDraft) return true;",
    to: "  if (o.wasToolDraft) return false;",
    suffix: _MUT_SUFFIX,
    runGuard: _runGuardExpectingRed,
  });

  // 变异 3: 收集器不再认权威稿 final.text (只认 stream_delta)
  _mutationGuard.mutateAndExpectRed({
    root: ROOT,
    file: 'modules/sse_text_collector.js',
    from: "      if (typeof data.text === 'string') finalText = data.text;",
    to: "      if (false && typeof data.text === 'string') finalText = data.text;",
    suffix: _MUT_SUFFIX,
    runGuard: _runGuardExpectingRed,
  });
});

test('106-6: 匿名请求不许共用一个 session (同 session 会互相 abort + 串味)', () => {
  // 客户端显式给了 session_id ⇒ 尊重它 (连续性照旧)
  assert.equal(policy.resolveChatSessionId({ explicitSessionId: 'sess-abc' }), 'sess-abc');
  assert.equal(policy.resolveChatSessionId({ explicitSessionId: '  sess-xyz  ' }), 'sess-xyz');
  // 没给 ⇒ 一次性 id, **绝不能是 'default'**
  //   (agent loop 的兜底就是 'default', 而同 session 新请求会 abort 上一个:
  //    j2_agent_loop.js:1047 `activeAbort.abort('user_switched')`)
  const a = policy.resolveChatSessionId({ makeUnique: () => 'aaa' });
  const b = policy.resolveChatSessionId({ makeUnique: () => 'bbb' });
  assert.notEqual(a, 'default', '匿名请求落进 default session ⇒ 会被下一个请求当场掐死');
  assert.notEqual(b, 'default');
  assert.notEqual(a, b, '两个匿名请求不能撞同一个 id');
  // 空串 / undefined 也算「没给」
  assert.notEqual(policy.resolveChatSessionId({ explicitSessionId: '' }), 'default');
  assert.notEqual(policy.resolveChatSessionId({ explicitSessionId: '   ' }), 'default');
  // 端点必须真的用它 (不许自己拼)
  const rawSrc = fs.readFileSync(path.join(ROOT, 'pangu-single', 'routes', 'inline_router.js'), 'utf8');
  assert.match(rawSrc, /resolveChatSessionId\(\{/, '端点没用 resolveChatSessionId');
  assert.match(rawSrc, /sessionId:\s*_sessionId/, '端点没把 sessionId 传给 agent loop');
});

test('106-7: 走 agent loop 的路径**不许**在端点里再记一遍记忆 (会落两条)', () => {
  // agent loop 出口自己记了 (j2_agent_loop.js:6003 `_deps._recordSessionToMemory(...)`)
  // ⇒ 端点再记一次 ⇒ 同一个回合在 memory 里两条 (先一条 Pangu 为空, 后一条才是真答案)
  //    ⇒ 语义召回把主人的话喂回两遍。
  //
  // ⚠ 顺便钉住一件历史事实: 这条端点**从来就没有活的记忆写入** ——
  //   唯一那处 `_recordSessionToMemory` 在 106 批之前的 `if (false && runJ2 …)` **死分支**里
  //   (git show 35bc80d:inline_router.js:3071) ⇒ 快路径(单发 callLLM)从来不写记忆。
  //   ⇒ 端点里的调用数必须是 **0**: 走 agent loop 的由 loop 记, 快路径的本来就不记。
  const rawSrc = fs.readFileSync(path.join(ROOT, 'pangu-single', 'routes', 'inline_router.js'), 'utf8');
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  const recordCalls = (src.match(/_recordSessionToMemory\(/g) || []).length;
  assert.equal(recordCalls, 0,
    `端点里 _recordSessionToMemory 出现了 ${recordCalls} 次 —— agent loop 自己已经记了, 端点再记就是双写`);
});

test('106-8: agent_error 只在**真失败**时带 (状态喷泉会先发 error 再跑成功)', () => {
  const rawSrc = fs.readFileSync(path.join(ROOT, 'pangu-single', 'routes', 'inline_router.js'), 'utf8');
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  // 两处 agent_error (run_j2 分支 + 升级分支) 都必须在 status !== 'done' 时才带
  const statusGuard = (src.match(/status\s*!==\s*'done'/g) || []).length;
  const agentErr = (src.match(/agent_error:/g) || []).length;
  assert.equal(agentErr, 2, `agent_error 字段数不对 (实际 ${agentErr}, 应为 2)`);
  assert.ok(statusGuard >= 2,
    `「status !== 'done'」条件只有 ${statusGuard} 处 —— agent_error 可能带一个陈旧错误`);
});

test('106-9: 工具草稿判据不许把**普通 JSON 答复**整段清空', () => {
  const rawSrc = fs.readFileSync(path.join(ROOT, 'pangu-single', 'routes', 'inline_router.js'), 'utf8');
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  // 老判据 `|"name"\s*:` 会把任何含 {"name": "张三"} 的正常答复整段清空
  assert.doesNotMatch(src, /<tool_call\|tool_use_error\|<tool_result\|"name"\\s\*:/,
    '工具草稿判据还是老的老样子 (普通 JSON 答复会被误清空 ⇒ 白跑一整轮 agent 编排)');
  // 新判据: 标签形态, 或 name+arguments 的 JSON 对
  assert.match(src, /_looksLikeToolDraft/, '端点没有 _looksLikeToolDraft 这个判据');
});

