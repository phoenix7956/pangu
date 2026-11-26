/**
 * tests/synthesis-reasoning-only-20261025.test.js
 * 第 86 批 —— 合成层把「模型的思考」当成答案交了给主人
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 现场 (2026-10-25, 会话 probe87-fixed, 真端点 /api/pangu/agent/stream)
 *
 *   任务: 「分别分析 llm_caller.js 和 j2_agent_loop.js 各自负责什么, 然后综合」
 *   拆解: 3 刀 (li/li/li), 三刀 runtimeStatus 全 completed
 *   收口: status=**completed** / child_failures=[] / 上游 400 出现 0 次
 *          (第 83-85 批的修复全部生效 ✓)
 *
 *   **但主人收到的是 307 字英文自说自话**:
 *     "We need synthesize, perhaps need actual files? User asks analysis.
 *      We have subagent outputs, but weird write ledger paths invalid.
 *      Need perhaps call tools ourselves per "about yourself must read".
 *      This is code analysis, should read files. Use read_file both maybe
 *      parallel unavailable; tool calls commentary"
 *
 *   ——那是模型的**思考**(计划口吻), 不是答案。`event: chunk` 和 `event: final`
 *   两个事件都是这 307 字。
 *
 * 根因链 (逐环取证, 不是猜):
 *   ① 上游这一轮**整条流一个 content delta 都没有**, 只回了 reasoning_content
 *      (err 日志: `[llm-stream] REASONING_ONLY_STREAM: … 307 字思考已交回`)
 *   ② llm_caller 的老行为 (2026-07-28 起): 「整条流一个 content 都没有 ⇒
 *      把思考交出去 —— 给思考强于给空」。
 *      在**主循环**里这是对的 (qwen3.6 / deepseek-r1 那类模型根本不会给正文);
 *      在**合成层**那是错的 —— 合成层要的本来就是「一份答案」, 没有答案就该兜底。
 *   ③ dispatcher 的合成层只在**零内容**时兜底
 *      (`_synthesizeStreamText` 里 `if (!text.trim()) throw`),
 *      而「只回思考」有内容 (307 字) ⇒ 兜底**从不触发** ⇒ 思考被当成综合稿交付。
 *
 * 修法: **不靠「文本像不像思考」去判** (拿词当判据是 2026-10-25 这一整天在治的病),
 *   而是让上游**如实上报**「这条流没有正文」这个事实:
 *     · llm_caller: `opts.onReasoningOnly(chars)` —— 只在整条流零正文时调一次。
 *       不传这个回调的老调用方, 行为**一个字都不变** (思考照旧交出去)。
 *     · dispatcher: 合成层据此抛**可区分**的错 `SYNTHESIS_STREAM_REASONING_ONLY`
 *       → 重试一次 → 仍失败才走原来的兜底 (`_fallbackSynthesis` 纯拼接, 不烧 LLM)。
 *
 * 本文件钉住:
 *   A. llm_caller 契约 (真 SSE 服务端, 不用 mock —— 这个 bug 住在字节层)
 *   B. 重试策略 (纯函数 `_synthesizeWithRetry`)
 *   C. 结构守卫 + 变异测试
 *
 * ⚠ 硬约束:
 *   · 2026-07-28 那批「只回思考」的模型 (qwen3.6 / deepseek-r1) **不能被打死**
 *     —— 主循环里思考照旧交出去, 一条都不许回归
 *   · 「有正文时 reasoning 一律不进流」的老契约不许破
 *   · 术数支线 apps/core/64i/ 一行不许碰
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const M = (p) => require(path.join(__dirname, '..', p));
const llmCaller = M('modules/llm_caller.js');
const disp = M('modules/j2_dispatcher.js');
const DISPATCH_PATH = path.join(__dirname, '..', 'modules', 'j2_dispatcher.js');

llmCaller.init({
  _config: { llm: { models: [], openai_base_url: '', temperature: 0.3 } },
  fs, path, os, https: require('https'), http,
  PRESETS: {}, PANGU_SYSTEM_PROMPT: '你是测试用的最小身份。',
});

// 上下文长度只有一个真源 (model_registry), 不登记就 fail-loud。
// ⚠ 这里**不写盘** —— 单改内存里的 getContextLength。
//   写盘会跟 tests/stream-reasoning-not-content-20261016.test.js 抢同一个
//   ~/.pangu/models-registry.json: `node --test` 默认**并行**跑文件,
//   那个文件在 after 里会把整个 registry 还原成它自己 load 时的快照 ——
//   两个文件一并行, 先还原的那个会把另一个登记的模型条目抹掉 ⇒ 偶发 fail-loud。
const registry = M('modules/model_registry.js');
const _origGetContextLength = registry.getContextLength;
registry.getContextLength = function (id) {
  if (id === 'fake-reason-b86') return 65536;
  return _origGetContextLength.call(this, id);
};

function sseLine(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }
function dContent(c) { return sseLine({ choices: [{ index: 0, delta: { content: c } }] }); }
function dReasoning(r) { return sseLine({ choices: [{ index: 0, delta: { reasoning_content: r } }] }); }

async function startServer(handler) {
  const open = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { open.push(res); handler(req, res); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return {
    url: 'http://127.0.0.1:' + srv.address().port,
    close: () => new Promise(r => { for (const res of open) { try { res.destroy(); } catch (_) {} } srv.close(r); }),
  };
}

function localModel(url) {
  return {
    id: 'fake-reason-b86', name: 'fake-reason-b86', provider: 'lmstudio',
    endpoint: url, protocol: 'openai', context_length: 65536,
  };
}

async function drain(gen) {
  let text = '';
  for await (const d of gen) text += String(d || '');
  return text;
}

// ═════════════════════════════════════════════════════════════════════════════
// A. llm_caller 契约
// ═════════════════════════════════════════════════════════════════════════════

test('A1 整条流零正文 ⇒ onReasoningOnly 被调一次, 且思考仍照旧交出去', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(dReasoning('We need synthesize, perhaps need actual files? '));
    res.write(dReasoning('Need perhaps call tools ourselves.'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const seen = [];
    const text = await drain(llmCaller._callLLMForAgentStream(
      [{ role: 'user', content: '综合一下' }], localModel(s.url), [],
      { onReasoningOnly: (n) => seen.push(n) }));
    assert.equal(seen.length, 1, '零正文时必须**恰好**上报一次, 实际 ' + seen.length + ' 次');
    assert.ok(seen[0] > 0, '上报的思考字数必须 > 0, 实际 ' + seen[0]);
    assert.match(text, /We need synthesize/,
      '老行为不许改: 思考仍要交出去 (2026-07-28 那批只回思考的模型靠这个活着)');
  } finally { await s.close(); }
});

test('A2 有正文 ⇒ onReasoningOnly 一次都不许被调', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(dReasoning('先想一下 '));
    res.write(dContent('答案开头 '));
    res.write(dReasoning('再想一下 '));
    res.write(dContent('答案结尾'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const seen = [];
    const text = await drain(llmCaller._callLLMForAgentStream(
      [{ role: 'user', content: '综合一下' }], localModel(s.url), [],
      { onReasoningOnly: (n) => seen.push(n) }));
    assert.equal(seen.length, 0, '有正文时竟上报了「零正文」⇒ 上报条件写错了');
    assert.equal(text, '答案开头 答案结尾',
      '老契约不许破: 有正文时 reasoning 一律不进流');
  } finally { await s.close(); }
});

test('A3 不传回调 ⇒ 行为一个字都不变 (老调用方不许被影响)', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(dReasoning('只有思考的模型, 思考就是它的全部输出。'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const text = await drain(llmCaller._callLLMForAgentStream(
      [{ role: 'user', content: '综合一下' }], localModel(s.url), []));
    assert.equal(text, '只有思考的模型, 思考就是它的全部输出。',
      '2026-07-28 那次修的正是这种模型, 删掉 fallback 会让它们流式全废');
  } finally { await s.close(); }
});

// ═════════════════════════════════════════════════════════════════════════════
// B. 重试策略 (纯函数 _synthesizeWithRetry)
// ═════════════════════════════════════════════════════════════════════════════

function reasoningOnlyError(chars) {
  const e = new Error('SYNTHESIS_STREAM_REASONING_ONLY');
  e.reasoningOnly = true;
  e.reasoningChars = chars || 0;
  return e;
}

test('B1 一次就成 ⇒ 用它的结果, 只调 1 次', async () => {
  let calls = 0;
  const out = await disp._synthesizeWithRetry(
    async () => { calls++; return '综合稿'; },
    () => '兜底');
  assert.equal(out, '综合稿');
  assert.equal(calls, 1);
});

test('B2 第一次只回思考、第二次成功 ⇒ 用第二次的结果, 调 2 次', async () => {
  let calls = 0;
  const out = await disp._synthesizeWithRetry(
    async () => {
      calls++;
      if (calls === 1) throw reasoningOnlyError(307);
      return '第二次的综合稿';
    },
    () => '兜底');
  assert.equal(out, '第二次的综合稿', '重试成功了却没交重试的结果');
  assert.equal(calls, 2);
});

test('B3 两次都只回思考 ⇒ 走兜底, 调 2 次 (不许无限重试)', async () => {
  let calls = 0;
  const out = await disp._synthesizeWithRetry(
    async () => { calls++; throw reasoningOnlyError(307); },
    (e) => '兜底(' + (e && e.reasoningOnly ? '思考' : '别的错') + ')');
  assert.equal(out, '兜底(思考)');
  assert.equal(calls, 2, '重试次数必须封顶在 2 次 (1 次首发 + 1 次重试)');
});

test('B4 别的错误 (端点挂了/超时) ⇒ 直接兜底, **只调 1 次**', async () => {
  let calls = 0;
  const out = await disp._synthesizeWithRetry(
    async () => { calls++; throw new Error('ECONNREFUSED'); },
    (e) => '兜底(' + e.message + ')');
  assert.equal(out, '兜底(ECONNREFUSED)');
  assert.equal(calls, 1, '非「只回思考」的错误不该重试 —— 重试没有意义, 只烧 token');
});

// ═════════════════════════════════════════════════════════════════════════════
// C. 结构守卫 + 变异测试
// ═════════════════════════════════════════════════════════════════════════════

test('C1 合成层必须问上游「有没有正文」, 不许自己看文本猜', () => {
  const src = fs.readFileSync(DISPATCH_PATH, 'utf8');
  assert.match(src, /onReasoningOnly/,
    '合成层没接上游的「零正文」上报 ⇒ 它又只能靠猜');
  assert.match(src, /SYNTHESIS_STREAM_REASONING_ONLY/,
    '缺少可区分的错误名 ⇒ 调用方分不出「该重试」和「该兜底」');
  assert.match(src, /_synthesizeWithRetry/,
    '合成层没走模块级重试策略 ⇒ 重试逻辑又分家了');
});

test('C2 变异: 把重试分支拆掉 ⇒ B2 必须红', () => {
  // 手法 (照第 83/85 批的做法): Module._compile 在内存里编译一份「坏掉的」副本,
  // **一个字节都不落盘**。
  const src = fs.readFileSync(DISPATCH_PATH, 'utf8');
  const broken = src.replace(
    '    if (!(e && e.reasoningOnly)) return fallback(e);',
    '    return fallback(e); /* MUTANT: 关掉重试分支 */');
  assert.notEqual(broken, src, '变异没生效 —— 替换目标对不上, 这条负例是空枪');
  const m = new Module(DISPATCH_PATH, null);
  m.filename = DISPATCH_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(DISPATCH_PATH));
  m._compile(broken, DISPATCH_PATH);
  const brokenMod = m.exports;

  return (async () => {
    let calls = 0;
    const out = await brokenMod._synthesizeWithRetry(
      async () => {
        calls++;
        if (calls === 1) throw reasoningOnlyError(307);
        return '第二次的综合稿';
      },
      () => '兜底');
    assert.equal(out, '兜底',
      '变异后没有重试 ⇒ B2 测的是「兜底」不是「重试」 ⇒ 这条负例是空枪');
    assert.equal(calls, 1, '变异后只调了 1 次 ⇒ 重试分支真的被拆掉了');
  })();
});

test('C3 变异: 把「零正文」上报拆掉 ⇒ A1 必须红', async () => {
  const LLM_PATH = path.join(__dirname, '..', 'modules', 'llm_caller.js');
  const src = fs.readFileSync(LLM_PATH, 'utf8');
  // 两个上报点都要拆 (正常收尾 + 流未闭合那两条路)
  const broken = src.replace(
    /([ \t]*)_reportReasoningOnly\(_reasoningBuf\.length\);/g,
    '$1/* MUTANT: 不上报 */');
  assert.notEqual(broken, src, '变异没生效 —— 替换目标对不上, 这条负例是空枪');
  assert.doesNotMatch(broken, /_reportReasoningOnly\(_reasoningBuf\.length\)/,
    '变异没生效: 还有上报调用留着');

  // 真跑变异副本 (内存编译, 一个字节都不落盘)
  const m = new Module(LLM_PATH, null);
  m.filename = LLM_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(LLM_PATH));
  m._compile(broken, LLM_PATH);
  m.exports.init({
    _config: { llm: { models: [], openai_base_url: '', temperature: 0.3 } },
    fs, path, os, https: require('https'), http,
    PRESETS: {}, PANGU_SYSTEM_PROMPT: '你是测试用的最小身份。',
  });

  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(dReasoning('We need synthesize, perhaps need actual files?'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const seen = [];
    await drain(m.exports._callLLMForAgentStream(
      [{ role: 'user', content: '综合一下' }], localModel(s.url), [],
      { onReasoningOnly: (n) => seen.push(n) }));
    assert.equal(seen.length, 0,
      '变异后仍然上报 ⇒ 变异没生效, 这条负例是空枪');
    // ⇒ 变异体下 A1 的 `seen.length === 1` 必然红 ⇒ A1 真在测这条上报。
  } finally { await s.close(); }
});

test('C4 合成收口那个结果变量必须是 let —— const 会被重新赋值, 运行时炸', () => {
  // ⚠ 这一条是**真出过事**的: 第 86 批第一版把 `_ft` 写成 `const`, 后面两行又
  //   `_ft = await _finalize(...)` / `_ft = _finalizeAnswerText(...)` 重新赋值
  //   ⇒ 运行时 `TypeError: Assignment to constant variable.` ⇒ **整轮收口炸掉**
  //   (现场 probe88: 合成都流完了, 收口这一步抛异常, 连接断在 CURL_EXIT=18)。
  //
  //   为什么前面的单测没抓到: A/B/C 测的是 `_synthesizeWithRetry` (纯函数) 和
  //   llm_caller 的上报契约, **没覆盖**真正出错的那几行 (它在 dispatcher 的闭包里,
  //   整条 dispatcher 路径太重, 单测跑不动)。
  //   ⇒ 补一条结构守卫, 盯住那几行的声明。
  //
  //   (实机那条是盘古的 self-repair 系统 4 秒内自愈的 —— 它把 const 改成 let 并
  //    提交了 b8cbfb3。但自愈是**兜底**, 不该是唯一的防线。)
  const body = synthClosureSource();
  const decl = body.match(/^\s*(const|let)\s+(_ft)\b[^\n]*$/m);
  assert.ok(decl, '找不到 _ft 的声明 —— 这条守卫跟不上源码改动了');
  assert.equal(decl[1], 'let',
    '_ft 是 const, 后面却被重新赋值 ⇒ 运行时 TypeError, 整轮收口炸掉');
  // 顺带确认它确实是「先声明后重新赋值」的形状 (否则这条守卫就没意义了)
  assert.match(body, /_ft\s*=[^=]/,
    '_ft 没被重新赋值 ⇒ 这条守卫的形状已经不对了, 源码改了要一起改');
});

// ═════════════════════════════════════════════════════════════════════════════
// D. 整条接线 (收口本体) 的集成测试 —— **把生产源码原样抽出来 eval 跑**
//
// ⚠ 这一段是**补第 86 批那个洞**的: A/B/C 测的是策略 (纯函数) 和上游契约,
//   **没测**真正出错的那几行 —— 出错的是 `_synthesizeAndFinalize` 的收口本体
//   (它在闭包里, 整条 dispatcher 路径单测跑不动)。
//   第 86 批第一版把 `_ft` 写成 `const` 又重新赋值 ⇒ 实机整轮收口炸掉
//   (主人什么都没收到), 单测全绿。
//
//   ⇒ 手法: 用**真 AST** (tests/helpers/js_ast) 把这个闭包的源码原样取出来,
//     用 `new Function` 把它的自由变量灌进去, 然后**真的调用它**。
//     跑的是**生产代码本身** (不是抄一份), 所以:
//       · 「只回思考 ⇒ 重试 ⇒ 用重试的结果」整条接线被覆盖到;
//       · 把 `let _ft` 变异成 `const _ft` ⇒ 变异体必炸 (D4) ⇒ 证明这段真被测了。
//
//   ⚠ 踩过的坑 (写这组测试时): 抽出来的片段有**自由变量**
//     (_synthesizeWithRetry / _synthesizeStreamText / _fallbackSynthesis /
//      _finalize / _finalizeAnswerText / _chartEvidenceFrom / _childConclusions / res),
//     生产代码新增自由变量时, 这里的参数列表**必须跟着补**, 否则单测报
//     ReferenceError —— 而那不是被测代码坏了, 是装载器没跟上。
// ═════════════════════════════════════════════════════════════════════════════

const { parseJs, functionSource } = require('./helpers/js_ast');

/** 从生产源码里取出 `_synthesizeAndFinalize` 这个闭包的**原文**。 */
function synthClosureSource(srcOverride) {
  const src = srcOverride != null
    ? srcOverride
    : fs.readFileSync(DISPATCH_PATH, 'utf8');
  const fn = functionSource(parseJs(src), '_synthesizeAndFinalize');
  assert.ok(fn, '找不到 _synthesizeAndFinalize —— 源码结构变了, 这条测试要跟着改');
  return fn;
}

/**
 * 把上面那个闭包**原样**装配成可调用的函数, 自由变量用假件灌进去。
 * streamImpl = 假「综合」实现 (它抛错就代表这一轮综合没成)。
 */
function makeSynthClosure(streamImpl, srcOverride) {
  const closure = synthClosureSource(srcOverride);
  const factory = new Function(
    '_synthesizeWithRetry',
    '_synthesizeStreamText',
    '_fallbackSynthesis',
    '_finalize',
    '_finalizeAnswerText',
    '_chartEvidenceFrom',
    '_childConclusions',
    'res',
    'return (' + closure + ');');
  const fn = factory(
    disp._synthesizeWithRetry,
    streamImpl,
    (e) => '兜底:' + (e && e.reasoningOnly ? '只回思考' : '别的错'),
    async (t, ce) => t + '|定稿',
    (t, cc) => t + '|剥标记',
    (r) => ({ ok: true }),
    (r) => '子结论',
    null);
  return fn;
}

test('D1 整条收口接线: 只回思考 ⇒ 重试 ⇒ 用重试的结果 (出异常就是 bug)', async () => {
  let calls = 0;
  // 自己装配一份「综合」实现: 第一次抛「只回思考」, 第二次给正文。
  const fn = makeSynthClosure(async () => {
    calls++;
    if (calls === 1) throw reasoningOnlyError(307);
    return '第二次的综合稿';
  });
  const out = await fn([{ role: 'user', content: '综合一下' }], { id: 'm' }, [{ agent: 'li' }]);
  assert.equal(out, '第二次的综合稿|定稿|剥标记',
    '收口接线没把重试的结果一路送到底 (或中途抛了异常)');
  assert.equal(calls, 2, '重试次数不对');
});

test('D2 整条收口接线: 两次都只回思考 ⇒ 走兜底, 兜底也要走完定稿', async () => {
  let n = 0;
  const fn = makeSynthClosure(async () => { n++; throw reasoningOnlyError(307); });
  const out = await fn([{ role: 'user', content: '综合一下' }], { id: 'm' }, [{ agent: 'li' }]);
  assert.equal(out, '兜底:只回思考|定稿|剥标记');
  assert.equal(n, 2, '重试次数必须封顶在 2 次');
});

test('D3 整条收口接线: 一次就成 ⇒ 不重试, 一次定稿到位', async () => {
  let calls = 0;
  const fn = makeSynthClosure(async () => { calls++; return '综合稿'; });
  const out = await fn([{ role: 'user', content: '综合一下' }], { id: 'm' }, [{ agent: 'li' }]);
  assert.equal(out, '综合稿|定稿|剥标记');
  assert.equal(calls, 1, '成功时不该重试');
});

test('D4 变异: 把 `let _ft` 改成 `const _ft` ⇒ D1 必须红 (证明 D1 真能抓那次事故)', async () => {
  const src = fs.readFileSync(DISPATCH_PATH, 'utf8');
  const broken = src.replace(/let _ft = await _synthesizeWithRetry\(/g,
    'const _ft = await _synthesizeWithRetry(');
  assert.notEqual(broken, src, '变异没生效 —— 替换目标对不上, 这条负例是空枪');
  let calls = 0;
  const fn = makeSynthClosure(async () => {
    calls++;
    if (calls === 1) throw reasoningOnlyError(307);
    return '第二次的综合稿';
  }, broken);
  let threw = null;
  try {
    await fn([{ role: 'user', content: '综合一下' }], { id: 'm' }, [{ agent: 'li' }]);
  } catch (e) { threw = e; }
  assert.ok(threw,
    '变异后没抛异常 ⇒ D1 测不出那次事故 ⇒ D1 是空枪');
  assert.match(String(threw && threw.message), /Assignment to constant variable/,
    '变异抛的错不是 const 重新赋值 ⇒ 变异没作用在正确的位置');
});
