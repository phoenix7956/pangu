'use strict';
/**
 * 第 90 批 —— 上游回了一整页 HTML 时, 报「上游没在跑」而不是「解析响应失败」。
 *
 * ## 现场 (2026-10-25, probe92 本地 LM Studio 127.0.0.1:1234)
 *
 * 盘古 stderr 里连着出现:
 *
 *   [j2-native] LLM call failed: 解析响应失败: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
 *
 * **这句话把人引向了解析器** —— 好像盘古自己的 JSON.parse 坏了。
 * 真因在**上游那一侧**: 那个地址此刻返回的不是 LLM 接口的响应, 是一整页 HTML。
 * 现场复核 (2026-10-25 17:44):
 *   GET  http://127.0.0.1:1234/v1/models  → HTTP 200, 1.5ms (服务活着, 模型列着)
 *   POST http://127.0.0.1:1234/v1/chat/completions → 20s 一个字节没回 (模型没真加载)
 * ⇒ 本地端点「活着但没在服务」, 盘古却把锅甩给了自己的解析器。
 *
 * 跟 2026-10-13 那次 (上游 500 被报成 JSON 语法错) 是**同一个病**:
 * 真因被 JSON.parse 的语法错顶掉了。那次修的是「SSE 信封里的错误事件」,
 * 这次漏的是「连 SSE 都不是, 是一整页 HTML」。
 *
 * ## 判据
 *
 * 只用**形态 + 状态码**:
 *   · 正文像一整页 HTML ⇒ 「上游返回的不是 LLM 接口」
 *   · 状态码 >= 400 且正文不是 JSON ⇒ 「上游返回的不是 JSON」+ 状态码
 * 别的照旧 (200 + 非 JSON 非 HTML ⇒ 仍然是老那句「解析响应失败」, 不越权改)。
 *
 * ## 手法
 *
 * 全程**真跑** `_handlePlainResponse` (生产代码本身, 不是抄一份),
 * 末尾做**变异体检**: 内存编译一份「坏掉的」llm_caller,
 * 证明守卫生效 ⇒ 这条判据真被测到 (第 86 批栽过「扫源码的守卫全是绿的」)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const CORE = path.join(__dirname, '..');
const LLC_PATH = path.join(CORE, 'modules', 'llm_caller.js');
const LLC_SRC = fs.readFileSync(LLC_PATH, 'utf8');

const llc = require(LLC_PATH);

// 一整页 HTML —— 本地端点没起来 / 打到网页端 / 被网关拦了, 都长这样。
const HTML_BODY = '<!DOCTYPE html>\n<html><head><title>502 Bad Gateway</title></head>'
  + '<body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>';

/**
 * 真跑一次 _handlePlainResponse。
 * @param {object} mod      llm_caller 模块 (真模块或变异体)
 * @param {number} status   HTTP 状态码
 * @param {string} body     上游回的正文
 */
function runPlain(mod, status, body) {
  return new Promise((resolve) => {
    const res = new EventEmitter();
    res.statusCode = status;
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    mod._handlePlainResponse(
      res,
      JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] }),
      (v) => finish({ ok: true, value: v }),
      (e) => finish({ ok: false, error: e }),
      false);
    res.emit('data', body);
    res.emit('end');
  });
}

// =====================================================================
// 一、真源: 一整页 HTML ⇒ 如实报「上游返回的不是接口」
// =====================================================================

test('A1 上游回一整页 HTML (502) ⇒ 报 UPSTREAM_RETURNED_HTML, 不许报「解析响应失败」', async () => {
  const r = await runPlain(llc, 502, HTML_BODY);
  assert.equal(r.ok, false, 'HTML 体不该被当成正常响应 resolve');
  assert.ok(r.error instanceof Error);
  assert.match(r.error.message, /UPSTREAM_RETURNED_HTML/,
    '上游回 HTML 却被报成别的: ' + r.error.message);
  assert.match(r.error.message, /HTTP 502/,
    '状态码必须带出来 (运维要知道是网关 502 还是别的): ' + r.error.message);
  assert.doesNotMatch(r.error.message, /解析响应失败/,
    '还在套「解析响应失败」的壳 ⇒ 把人引向没坏的解析器: ' + r.error.message);
  assert.equal(r.error.__upstreamBody, true,
    '打标记才能让上层别再套壳 (跟 __upstreamSSE 一个用法)');
});

test('A2 状态码 200 但回的是 HTML (打到网页端了) ⇒ 照样如实报', async () => {
  const r = await runPlain(llc, 200, '<!DOCTYPE html><html><body>LM Studio</body></html>');
  assert.equal(r.ok, false);
  assert.match(r.error.message, /UPSTREAM_RETURNED_HTML/,
    '200 不代表内容对 —— 一整页 HTML 永远不是 LLM 响应: ' + r.error.message);
  assert.doesNotMatch(r.error.message, /解析响应失败/);
});

test('A3 非 JSON 非 HTML 且状态码 >= 400 ⇒ 报 UPSTREAM_RETURNED_NON_JSON + 状态码', async () => {
  const r = await runPlain(llc, 503, 'upstream connect error or disconnect/reset before headers');
  assert.equal(r.ok, false);
  assert.match(r.error.message, /UPSTREAM_RETURNED_NON_JSON/,
    '4xx/5xx 的非 JSON 正文要连状态码一起报出来: ' + r.error.message);
  assert.match(r.error.message, /HTTP 503/);
  assert.doesNotMatch(r.error.message, /解析响应失败/);
});

// =====================================================================
// 二、不许越权: 原来对的路径一个字都不许变
// =====================================================================

test('B1 正常 JSON 响应照旧 resolve (一个字都不许变)', async () => {
  const r = await runPlain(llc, 200, JSON.stringify({ choices: [{ message: { role: 'assistant', content: '你好' } }] }));
  assert.equal(r.ok, true, '正常 JSON 响应被拒了: ' + JSON.stringify(r.error && r.error.message));
  assert.equal(r.value.choices[0].message.content, '你好');
});

test('B2 SSE 体照旧走 SSE 兜底 (2026-10-13 那条防御不许回归)', async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"流式正文"}}]}\n\ndata: [DONE]\n\n';
  const r = await runPlain(llc, 200, sse);
  assert.equal(r.ok, true, 'SSE 体被拒了: ' + JSON.stringify(r.error && r.error.message));
  assert.equal(r.value.choices[0].message.content, '流式正文');
});

test('B3 200 + 非 JSON 非 HTML ⇒ 仍是老那句「解析响应失败」 (不许越权改口径)', async () => {
  const r = await runPlain(llc, 200, 'not json at all');
  assert.equal(r.ok, false);
  assert.match(r.error.message, /解析响应失败/,
    '这一档不属于本批要修的形态, 口径不许动: ' + r.error.message);
});

test('B4 4xx 带 JSON 错误信封 ⇒ 仍是老的 HTTP + error.message 口径', async () => {
  const body = JSON.stringify({ error: { message: 'model not loaded' } });
  const r = await runPlain(llc, 400, body);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /HTTP 400/);
  assert.match(r.error.message, /model not loaded/);
  assert.doesNotMatch(r.error.message, /UPSTREAM_RETURNED/,
    'JSON 错误信封有真因, 不该被本批的新口径盖掉: ' + r.error.message);
});

// =====================================================================
// 三、接线: 判据只有一份, 子 agent 那条路也用它
// =====================================================================

test('C1 判据是导出的一份真源 (agents/sub-agent.js 有自己的一套 HTTP 客户端)', () => {
  assert.equal(typeof llc._upstreamBodyDiagnosis, 'function',
    '_upstreamBodyDiagnosis 没导出 —— 子 agent 那条路就没法共用同一份判据');
  const subSrc = fs.readFileSync(path.join(CORE, 'agents', 'sub-agent.js'), 'utf8');
  assert.match(subSrc, /_upstreamBodyDiagnosis/,
    'agents/sub-agent.js 没用同一份判据 ⇒ 两处各写一份, 迟早漂');
  const d = llc._upstreamBodyDiagnosis(502, HTML_BODY);
  assert.ok(d && d.__upstreamBody === true);
  assert.equal(llc._upstreamBodyDiagnosis(200, JSON.stringify({ ok: 1 })), null,
    '正常 JSON 不该被判成异常');
});

// =====================================================================
// 四、变异体检: 证明守卫生效 (不是扫源码, 是真跑变异体)
// =====================================================================

function loadMutant(src) {
  const m = new Module(LLC_PATH, null);
  m.filename = LLC_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(LLC_PATH));
  m._compile(src, LLC_PATH);
  return m.exports;
}

test('D1 变异: 去掉判据调用 ⇒ 守卫生效 (报错口径退回老样子)', async () => {
  const mutated = LLC_SRC.replace(
    /const _diag = _upstreamBodyDiagnosis\(res\.statusCode, data\);/,
    'const _diag = null;');
  assert.notEqual(mutated, LLC_SRC, '变异没打上 —— 源码结构变了, 这条测试要跟着改');
  const mutant = loadMutant(mutated);
  const r = await runPlain(mutant, 502, HTML_BODY);
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error.message, /UPSTREAM_RETURNED_HTML/,
    '变异体竟然报对了 ⇒ 这条守卫根本没咬住');
  assert.match(r.error.message, /解析响应失败/,
    '变异体应当退回老口径 (证明生产那版是真的改掉了)');
});

test('D2 变异: 漏了「别套壳」的出口 ⇒ 守卫生效 (错误名在但壳又套回去了)', async () => {
  const mutated = LLC_SRC.replace(
    /if \(e && e\.__upstreamBody\) \{ reject\(e\); return; \}/,
    'if (false) { reject(e); return; }');
  assert.notEqual(mutated, LLC_SRC, '变异没打上 —— 源码结构变了, 这条测试要跟着改');
  const mutant = loadMutant(mutated);
  const r = await runPlain(mutant, 502, HTML_BODY);
  assert.equal(r.ok, false);
  assert.match(r.error.message, /解析响应失败/,
    '出口漏了 ⇒ 「解析响应失败」又套回壳上了 ⇒ A1 那条守卫 (不许套壳) 会当场报红');
  assert.match(r.error.message, /UPSTREAM_RETURNED_HTML/,
    '错误名还在, 只是壳套回去了 —— 这正是这个变异体的性质');
});

test('D3 子 agent 那条路 (自己的一套 HTTP 客户端) 也如实报, 不报裸语法错', async () => {
  // 真起一个本地 HTTP 服务, 让它回一整页 HTML —— 然后调**生产代码**里
  // agents/sub-agent.js 的 callLLM (它不走 llm_caller, 有自己的一套客户端)。
  const http = require('http');
  const subAgent = require(path.join(CORE, 'agents', 'sub-agent.js'));
  const srv = http.createServer((req, res) => {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end(HTML_BODY);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    let err = null;
    try {
      await subAgent.callLLM(
        [{ role: 'user', content: 'ping' }],
        { id: 'probe-upstream-html-test', provider: 'custom', endpoint: 'http://127.0.0.1:' + port + '/v1' },
        [],
        { stream: false });
    } catch (e) { err = e; }
    assert.ok(err, '上游回 HTML 却 resolve 了 ⇒ 子 agent 把它当答案了');
    assert.match(err.message, /UPSTREAM_RETURNED_HTML/,
      '子 agent 那条路没共用判据 ⇒ 报出去的还是裸语法错: ' + err.message);
    assert.doesNotMatch(err.message, /Unexpected token/,
      '还在报 JSON 语法错 ⇒ 把人引向没坏的解析器: ' + err.message);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('D4 变异: 子 agent 退回自己的 JSON.parse ⇒ 守卫生效 (错误退回裸语法错)', async () => {
  // D3 是「生产代码跑对了」; 这条是「**只有那条接线**让它跑对的」。
  // 内存编译一份坏掉的 agents/sub-agent.js (一个字节不落盘), 跑同一个场景:
  // 错误必须退回「Unexpected token '<'」—— 那正是这一批之前的样子。
  const http = require('http');
  const SUB_PATH = path.join(CORE, 'agents', 'sub-agent.js');
  const subSrc = fs.readFileSync(SUB_PATH, 'utf8');
  const mutated = subSrc.replace(
    /const _diag = require\('\.\.\/modules\/llm_caller'\)\._upstreamBodyDiagnosis\(res\.statusCode, data\);/,
    'const _diag = null;');
  assert.notEqual(mutated, subSrc, '变异没打上 —— 源码结构变了, 这条测试要跟着改');
  const m = new Module(SUB_PATH, null);
  m.filename = SUB_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(SUB_PATH));
  m._compile(mutated, SUB_PATH);

  const srv = http.createServer((req, res) => {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end(HTML_BODY);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    let err = null;
    try {
      await m.exports.callLLM(
        [{ role: 'user', content: 'ping' }],
        { id: 'probe-upstream-html-mutant', provider: 'custom', endpoint: 'http://127.0.0.1:' + port + '/v1' },
        [],
        { stream: false });
    } catch (e) { err = e; }
    assert.ok(err, '变异体竟然 resolve 了');
    assert.match(err.message, /Unexpected token/,
      '变异体应当退回裸语法错 (证明生产那版是真的改掉了): ' + err.message);
    assert.doesNotMatch(err.message, /UPSTREAM_RETURNED_HTML/,
      '变异体不该报出新的口径');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
