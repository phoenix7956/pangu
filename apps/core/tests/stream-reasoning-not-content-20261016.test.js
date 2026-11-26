// 2026-10-16 lt7 实机: 用户第一眼看到的是 500 字英文自我推演, 之后才是中文答复
//
// 现场 lt7 (跟 lt6 同一道题, 727s vs 1593s 那一轮) 的 `event: final` 文本开头是:
//
//   "The user is asking for a final integrated answer. This is an execution/
//    verification task (no [Pangu Qigua] block), so I must not fabricate a hexagram.
//    All subtasks succeeded, and the ledger of files actually written to disk
//    matches: u1–u5 all exist.
//    Key facts from the tool results: ...
//    Output format: the first sentence must directly answer the master's question.
//    No internal agent labels (executor/checker) may be used as headings ...
//    Draft: ...
//    All done, all 5 steps executed and verified. ..."
//
//   ——之后才是那段正确的中文答复。
//
// 那段英文是**模型的思考**, 不是答案。它之所以跑到用户眼前, 是 llm_caller 的 SSE 解析里
// 那一行 `delta.content || delta.reasoning_content || ''`: 思考**先于**正文到达, 于是
// 开头那些 `content:'' + reasoning_content:'...'` 的 delta 被 `||` 兜底当成正文 yield,
// 累加进 textContent。收口(_synthesizeStreamText)和主循环(textContent += delta)都中招。
//
// 探针实测模型本身分得很清 (qwen3.8-27b-mlx: reasoning 173 字 / content 47 字),
// 所以这是**盘古侧读错了字段**, 不是模型乱说。
//
// 修法: 正文只走 content, reasoning 单独缓冲; **只有整条流一个 content 都没有**才把
// reasoning 交出去 —— 那种情况模型本来就没给正文 (qwen3.6/deepseek-r1 就是这样),
// 交思考强于交空, 旧行为不能回归。
//
// 测试起真的本地 SSE 服务端, 不用 mock: 这个 bug 住在字节层, mock 碰不到。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('fs');

const M = (p) => require(path.join(__dirname, '..', p));
const llmCaller = M('modules/llm_caller.js');

llmCaller.init({
  _config: { llm: { models: [], openai_base_url: '', temperature: 0.3 } },
  fs, path, os: require('os'), https: require('https'), http,
  PRESETS: {}, PANGU_SYSTEM_PROMPT: '你是测试用的最小身份。',
});

// 上下文长度只有一个真源 (model_registry), 不登记就 fail-loud。
// 真源是主人机器上的 ~/.pangu 文件 —— 测完原样还回去, 不留垃圾。
const registry = M('modules/model_registry.js');
const REG_PATH = registry.registryPath();
const REG_SNAPSHOT = fs.existsSync(REG_PATH) ? fs.readFileSync(REG_PATH, 'utf8') : null;
test.after(() => {
  registry._reset();
  try {
    if (REG_SNAPSHOT === null) { if (fs.existsSync(REG_PATH)) fs.unlinkSync(REG_PATH); }
    else fs.writeFileSync(REG_PATH, REG_SNAPSHOT);
  } catch (_) {}
  registry._reset();
});
registry.setContextLength('fake-reason', 65536, 'test');

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
    id: 'fake-reason', name: 'fake-reason', provider: 'lmstudio',
    endpoint: url, protocol: 'openai', context_length: 65536,
  };
}

async function drain(gen) {
  let text = '';
  for await (const d of gen) text += String(d || '');
  return text;
}

// ===== 1. 实况复现: 思考先到, 正文后到 =====

test('T1 思考先于正文到达 → 正文流里一个字思考都不许有 (lt7 的形状)', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // lt7 的真实顺序: 先一大段英文自我推演, 最后才是中文答复
    res.write(dReasoning('The user is asking for a final integrated answer. '));
    res.write(dReasoning('I must not fabricate a hexagram. '));
    res.write(dReasoning('Draft: All done, all 5 steps executed.'));
    res.write(dContent('全部完成，5 步均真实执行并验证通过。'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const text = await drain(llmCaller._callLLMForAgentStream(
      [{ role: 'user', content: '综合一下' }], localModel(s.url), []));
    assert.equal(text, '全部完成，5 步均真实执行并验证通过。',
      '正文流必须只有答案; 修复前会把上面三段英文思考一起累加进来');
    assert.doesNotMatch(text, /The user is asking/);
    assert.doesNotMatch(text, /Draft:/);
    assert.doesNotMatch(text, /hexagram/);
  } finally { await s.close(); }
});

test('T2 正文与思考交错到达 → 仍然只交正文 (不是只挡"思考在最前"这一种形状)', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(dReasoning('先想一下 '));
    res.write(dContent('答案开头 '));
    res.write(dReasoning('再想一下 '));   // 有的模型会来回横跳
    res.write(dContent('答案结尾'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const text = await drain(llmCaller._callLLMForAgentStream(
      [{ role: 'user', content: '综合一下' }], localModel(s.url), []));
    assert.equal(text, '答案开头 答案结尾', '交错形状下也不许混进思考');
  } finally { await s.close(); }
});

// ===== 2. 不能回归: 2026-07-28 修的那批模型只回 reasoning_content =====

test('T3 整条流只有思考没有正文 → 交思考, 不交空 (qwen3.6/deepseek-r1 不能被这次修复打死)', async () => {
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

test('T4 [DONE] 正常收尾且一个字都没给 → 返空串不报错 (既有契约, 这里只钉住不回归)', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    let err = null;
    let text = null;
    try {
      text = await drain(llmCaller._callLLMForAgentStream(
        [{ role: 'user', content: '综合一下' }], localModel(s.url), []));
    } catch (e) { err = e; }
    // 这是 synthesis-stream-idle-20261016 T3 钉死的契约: 上游**正常收尾**但没给内容,
    // 流层返空串不报错, 防线在收口助手自己身上 (SYNTHESIS_STREAM_ZERO_CONTENT)。
    // 写这条断言时我一度想让流层直接报错, 结果打破了那个既有契约 —— 记在这里,
    // 下次有人想"顺手改严"之前先看一眼 synthesis-stream-idle T3。
    assert.strictEqual(err, null, `[DONE] 正常收尾不该报错: ${err && err.message}`);
    assert.strictEqual(text, '');
  } finally { await s.close(); }
});

test('T4b 连接直接断掉 (没有 [DONE]) 且一个字都没给 → 照旧报 ZERO_CONTENT', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end();          // 正常收尾但一个 data 帧都没有, 也没发 [DONE]
  });
  try {
    let err = null;
    try {
      await drain(llmCaller._callLLMForAgentStream(
        [{ role: 'user', content: '综合一下' }], localModel(s.url), []));
    } catch (e) { err = e; }
    assert.ok(err, '没 [DONE] 的空流必须报错 (那才是"上游异常", 不是"正常收尾")');
    assert.match(err.message, /STREAM_ENDED_WITH_ZERO_CONTENT/);
  } finally { await s.close(); }
});

// ===== 3. 接线: 主循环和收口都靠"流里只有正文"才成立 =====

test('T5 收口累加的是纯正文 (模拟 _synthesizeStreamText 的 text += delta)', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(dReasoning('我先分析一下主人到底要什么。'));
    res.write(dReasoning('不能编卦象。'));
    res.write(dContent('- u1 已写入 alpha/beta/gamma\n- u2 = 3\n- u3 与 u1 一致'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    let text = '';
    for await (const delta of llmCaller._callLLMForAgentStream(
      [{ role: 'user', content: '综合一下' }], localModel(s.url), [])) {
      text += String(delta || '');
    }
    // 收口的 content_chars 上报 / final 文本 / 【对账铁律】的比对, 全都建立在这个值上
    assert.ok(!text.includes('分析'), '收口文本里不许出现思考');
    assert.ok(text.startsWith('- u1'), '收口文本应当就是那段中文答复');
    assert.doesNotMatch(text, /卦象/);
  } finally { await s.close(); }
});

