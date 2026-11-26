const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// ===========================================================================
// 没人说话的请求烧掉一整轮本地推理 (现场 /tmp/pangu-single.err + .log, 10-15 15:35~15:41)
//
//   [j2] §0.56 cleared session state for request-1792049757527-fc47se
//   [llm] NO_USER_TURN: 请求里一条 user 消息都没有 (roles=[9 个 system]) ...
//   [j2] loop ended, nativeRounds: 1 ... finalText len: 171
//
// task checkpoint 里那个 session 是 goal='' / messages_count=1 —— 没人说过话。
// 这种请求一路走到 llm_caller._ensureUserTurn 补一条占位 user 轮才发得出去,
// 于是本地 27B 白跑 1~3 轮完整推理 (实测单轮 60~200s), 换回来一句
// "本轮无新指令(系统提示缺用户输入) ... 等你拍"。界面上就是盘古自己跟自己说话。
//
// _ensureUserTurn 是止血 (让请求发得出去), 真正该拦的是这里: 没有可回应的用户轮
// 就不该进模型。判据两条同时成立才短路, 免得误伤带 history 的后续请求和 "继续" 续跑。
// ===========================================================================

const HANDLER_PATH = require.resolve('../pangu-single/routes/message-stream.js');
const SRC = fs.readFileSync(HANDLER_PATH, 'utf8');
const { makeHandler } = require(HANDLER_PATH);

function makeFakeRes() {
  const chunks = [];
  const listeners = {};
  return {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    chunks,
    events() {
      return chunks.join('').split('\n').filter(l => l.startsWith('event: '))
        .map(l => l.slice(7).trim());
    },
    writeHead() { this.headersSent = true; },
    write(s) { chunks.push(String(s)); return true; },
    end() { this.writableEnded = true; },
    flushHeaders() {},
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return this; },
    emit(ev, ...a) { (listeners[ev] || []).forEach(fn => { try { fn(...a); } catch (_) {} }); },
  };
}

function makeFakeReq(body) {
  const req = {
    headers: {},
    on(ev, fn) {
      if (ev === 'data') req._data = fn;
      else if (ev === 'end') req._end = fn;
      return req;
    },
    destroy() {},
  };
  const payload = JSON.stringify(body);
  process.nextTick(() => { req._data(Buffer.from(payload)); req._end(); });
  return req;
}

function buildHandler(spy) {
  return makeHandler({
    getDefaultModel: () => ({ id: 'test-model', provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234' }),
    callLLM: async () => ({ content: '不应被调用' }),
    callLLMRouter: async () => ({ content: '不应被调用' }),
    extractContent: (r) => (r && r.content) || '',
    _recordSessionToMemory: () => {},
    runAgentLoop: spy,
    _config: { llm: { models: [{ id: 'test-model', provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234' }] } },
  });
}

async function drive(body) {
  const res = makeFakeRes();
  let called = 0;
  const spy = async () => { called++; return { modelUsed: 'test-model' }; };
  const handler = buildHandler(spy);
  await handler(makeFakeReq(body), res);
  await new Promise(r => setImmediate(r));
  return { called, res };
}

test('空 input + 空 history → 不进 agent loop (省掉本地 27B 的 1~3 轮推理)', async () => {
  const { called, res } = await drive({ session_id: 'empty-1', input: '', run_j2: true });
  assert.equal(called, 0, '没人说话时 runAgentLoop 一次都不该被调');
  assert.ok(res.events().includes('done'), '必须正常收口, 不能让 SSE 连接悬着');
  assert.ok(res.writableEnded, '响应必须结束');
  assert.ok(res.chunks.join('').includes('empty_request'),
    'done 事件要带 skipped 标记, 便于事后分辨"没人说话"和"模型没答出来"');
});

test('input 只有空白字符 → 同样短路 (不能靠 trim 蒙混过关)', async () => {
  const { called } = await drive({ session_id: 'empty-2', input: '   \n  ', run_j2: true });
  assert.equal(called, 0);
});

test('空 input 但 history 里有用户轮 → 放行 (带历史的后续请求是正常用法)', async () => {
  const { called } = await drive({
    session_id: 'hist-1',
    input: '',
    messages: [{ role: 'user', content: '上一轮问的那个' }],
    run_j2: true,
  });
  assert.equal(called, 1, 'history 带用户轮时必须正常进 loop');
});

test('history 里 user 轮是空串 → 仍算没人说话', async () => {
  const { called } = await drive({
    session_id: 'hist-2',
    input: '',
    messages: [{ role: 'system', content: 'soul' }, { role: 'user', content: '  ' }],
    run_j2: true,
  });
  assert.equal(called, 0);
});

test('正常 input → 必须照常进 agent loop (短路不能误伤主流程)', async () => {
  const { called } = await drive({ session_id: 'ok-1', input: '现在几点了', run_j2: true });
  assert.equal(called, 1);
});

test('"继续" 这类续跑输入 → 必须放行 (auto-resume 主路径不能被拦)', async () => {
  const { called } = await drive({ session_id: 'ok-2', input: '继续', run_j2: true });
  assert.equal(called, 1);
});

test('短路判定必须基于 allMessages 的 user 轮, 且发生在进 loop 之前', () => {
  const idx = SRC.indexOf('EMPTY_REQUEST 短路');
  assert.ok(idx > 0, '短路分支必须留可检索的标记');
  // 判据写在 if 体内、warn 之前, 所以从标记往前找一小段就够。
  assert.match(SRC.slice(Math.max(0, idx - 600), idx), /allMessages\.some\(m => m && m\.role === 'user'/,
    '短路判据必须基于 allMessages 里有没有非空 user 轮, 而不是只看 input');
  const callIdx = SRC.indexOf('await runAgentLoop(');
  assert.ok(idx < callIdx, '短路必须发生在真的调 agent loop 之前, 才有省算力的意义');
});

