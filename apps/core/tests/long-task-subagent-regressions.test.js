const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('主聊天入口必须走统一 Agent 流，才能触发 dispatcher/子 agent', () => {
  // 2026-10-26 (第 107 批, 桌面端下线): 原来查的是**前端**打的是哪个端点
  // (ChatRoom.jsx 的 panguFetch('/api/pangu/agent/stream'))。
  // 桌面端没了, 改查**服务端那一半** —— 守的还是同一件事:「主入口 → 统一 Agent 流」:
  //   ① 端点必须在路由里真的注册 (端点没了 = dispatcher 永远不会被触发)
  //   ② 端点必须调统一 agent 循环, 不能自己另跑一套
  //   ③ 统一循环的另一条分支是 dispatcher —— 子 agent 从那儿派出来
  const router = read('pangu-single/routes/inline_router.js');
  assert.match(router, /pathname === '\/api\/pangu\/agent\/stream'/,
    '/api/pangu/agent/stream 必须真的在路由里注册');
  const stream = read('modules/pangu_agent_stream.js');
  assert.match(stream, /_deps\._runAgentLoopLegacyStream\(/,
    '主入口必须调统一 agent 循环 —— 另起一套 loop 就绕开了 dispatcher 和子 agent');
  assert.match(stream, /_deps\._runPanguDispatcherLoop\(/,
    '主入口必须能走 dispatcher 分支 —— 子 agent 从那儿派出来');
  // dispatcher 内部再调回统一循环 (从 j2_agent_loop 注入) —— 证明是**同一条**流,
  // 不是两个各自为政的入口。
  const dispatcher = read('modules/j2_dispatcher.js');
  assert.match(dispatcher, /j2AgentLoop\._runAgentLoopLegacyStream\(/,
    'dispatcher 必须调回统一 agent 循环 —— 另起一套就等于分裂成两个内核');
});

test('固定流程并行子 agent 必须使用独立 session abort 域', () => {
  const dispatcher = read('modules/j2_dispatcher.js');
  assert.match(dispatcher, /const _ffSid = sessionId \+ '#sub-fixed-'/);
  assert.match(dispatcher, /res, sessionId: _ffSid/);
});

test('无 session_id 的流请求不得回落到共享 default session', () => {
  const legacy = read('pangu-single/routes/message-stream.js');
  const unified = read('modules/pangu_agent_stream.js');
  assert.match(legacy, /req\.headers\?\.\['x-session-id'\]/);
  assert.match(legacy, /'request-' \+ Date\.now\(\)/);
  assert.match(unified, /req_body\.session_id = String\(/);
  assert.match(unified, /'request-' \+ Date\.now\(\)/);
});

test('子 agent 工作状态以当前进程 active 计数为准，旧 start 不能永久卡运行中', () => {
  const runs = read('modules/subagent_runs.js');
  assert.match(runs, /const _activeCounts = new Map\(\)/);
  // 2026-10-18 拼音迁移: running 必须以 _activeCounts 为准 (不能拿日志里的 start 当"在跑"),
  // 且**查表键必须与记账键一致** —— record() 按归一后的拼音记账, 磁盘上的历史行却是英文
  // code。原先这里写 `_activeCounts.get(e.code)`: 拿英文去查一张拼音键的表, 永远取不到 → 
  // running 恒 false (真在跑的将灵显示成待命)。现在两侧都过归一。
  assert.match(runs, /b\.running = \(_activeCounts\.get\(_nc\) \|\| 0\) > 0/);
  assert.match(runs, /const _nc = _normalize\(e\.code\)/,
    'digest 必须先把事件里的 code 归一成规范名再查 _activeCounts —— '
    + '记账用拼音而查询用英文, running 会恒为 false');
});

test('子 agent 直连 provider 必须优先发送 canonical api_model/name，而不是内部 id', () => {
  const subAgent = read('agents/sub-agent.js');
  assert.match(subAgent, /const apiModel = modelConfig\.api_model \|\| modelConfig\.name \|\| modelConfig\.id/);
});

test('聊天请求的模型选择同时接受内部 id、显示名和 provider api_model', () => {
  const unified = read('modules/pangu_agent_stream.js');
  const legacy = read('pangu-single/routes/message-stream.js');
  assert.match(unified, /\[m\.id, m\.name, m\.api_model\]/);
  assert.match(legacy, /\[m\.id, m\.name, m\.api_model\]/);
});

test('统一 Agent 流必须把 camelCase sessionId 归一化到下游使用的 session_id', () => {
  const stream = read('modules/pangu_agent_stream.js');
  assert.match(stream, /const suppliedSessionId = req_body\.session_id \|\| req_body\.sessionId \|\| req\.headers\?\./);
  assert.match(stream, /req_body\.session_id = String\(\s*suppledSessionId|req_body\.session_id = String\(\s*suppliedSessionId/);
});

test('统一 Agent 流显式请求未知模型必须返回 MODEL_NOT_FOUND，不得静默回退当前模型', () => {
  const stream = read('modules/pangu_agent_stream.js');
  assert.match(stream, /MODEL_NOT_FOUND/);
  assert.match(stream, /requested_model: req_body\.model/);
});

test('显式指定的模型必须压过服务端当前模型 —— 两条分支都得认', () => {
  // 2026-10-26 (第 107 批): 原来查的是**前端**怎么把选中的 id 发下去
  // (model: pickedModelId || undefined / 刷新模型池不覆盖本地选中项)。
  // 桌面端下线后改查**服务端那一半**: 显式 model 必须压过 current_model_id。
  //
  // 为什么这不是上面 MODEL_NOT_FOUND 那条的重复: 那条只钉"未知模型要报错";
  // 这条钉的是**两条分支 (dispatcher / legacy) 都得认显式模型** ——
  // 只在一条分支里认, 等于换个入口就静默回退到服务端当前模型,
  // 那正是"刷新了一下模型池, 下一轮请求悄悄走了另一个模型"的成因。
  const stream = read('modules/pangu_agent_stream.js');
  const branches = stream.match(/if \(req_body\.model\) \{/g) || [];
  assert.strictEqual(branches.length, 2,
    '显式模型的处理必须出现在 dispatcher / legacy 两条分支里, 实际 ' + branches.length + ' 处');
  // 每处都必须是同一个形状: 先按 req_body.model 找 → 找不到才回退 current_model。
  let at = -1;
  for (let i = 0; i < 2; i++) {
    at = stream.indexOf('if (req_body.model) {', at + 1);
    assert.ok(at > 0, '要能找到第 ' + (i + 1) + ' 处显式模型分支');
    const win = stream.slice(at, at + 900);
    assert.match(win, /\[m\.id, m\.name, m\.api_model\]/,
      '第 ' + (i + 1) + ' 处分支必须按 id / 显示名 / api_model 三种写法认模型');
    const fallbackAt = win.indexOf('if (!model)');
    assert.ok(fallbackAt > 0,
      '第 ' + (i + 1) + ' 处分支必须有 "没找到才回退" 的判断 —— '
      + '显式指定的模型找不到时应当报 MODEL_NOT_FOUND, 不是偷偷换一台');
  }
});

test('危险工具执行分支必须声明并归一化 params，且按对象传递重试选项', () => {
  const single = read('pangu-single.js');
  assert.match(single, /for \(const tc of unsafeCalls\) \{[\s\S]*const params = Object\.assign\(\{\}, tc\.params \|\| \{\}\)/);
  assert.match(single, /_callToolWithRetry\(tc\.name, params, \{ user: 'feng', sessionId: _ledgerSessionId \}, \{ maxAttempts: 3 \}\)/);
});

test('read_file 兼容模型传入 offset=0，不应返回文件末尾空行', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { TOOLS } = require('../modules/tools');
  const file = path.join(os.tmpdir(), `pangu-read-file-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, 'first line\nsecond line\n', 'utf8');
  try {
    const result = await TOOLS.read_file({ context: {}, params: { path: file, offset: 0, limit: 1 } });
    assert.equal(result.ok, true);
    assert.equal(result.data.content, 'first line');
    assert.equal(result.data.offset, 1);
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
});

test('子 agent 工具执行边界兼容 params/JSON 字符串包装', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { executeTool, normalizeToolArgs } = require('../agents/sub-agent');
  const file = path.join(os.tmpdir(), `pangu-read-file-wrapper-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, 'wrapped first\nwrapped second\n', 'utf8');
  try {
    assert.deepEqual(normalizeToolArgs({ params: { path: file, offset: 0, limit: 1 } }), { path: file, offset: 0, limit: 1 });
    const result = await executeTool('read_file', JSON.stringify({ params: { path: file, offset: 0, limit: 1 } }));
    assert.equal(result.ok, true);
    assert.equal(result.result.ok, true);
    assert.equal(result.result.data.content, 'wrapped first');
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
});

test('固定流程子 agent 工具执行发出成对 tool_call/tool_result SSE 事件', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { executeTool } = require('../agents/sub-agent');
  const file = path.join(os.tmpdir(), `pangu-tool-events-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, 'event payload\n', 'utf8');
  const chunks = [];
  const sink = { write: chunk => { chunks.push(String(chunk)); return true; } };
  try {
    const result = await executeTool('read_file', { path: file, offset: 0, limit: 1 }, undefined, {
      res: sink,
      sessionId: 'test-sub-fixed-events',
      agent: 'analyzer',
    });
    assert.equal(result.ok, true);
    const events = chunks.map(chunk => {
      const event = chunk.match(/^event: ([^\n]+)/m)?.[1];
      const data = chunk.match(/^data: ([\s\S]*?)\n\n/m)?.[1];
      return { event, data: JSON.parse(data) };
    });
    assert.deepEqual(events.map(e => e.event), ['tool_call', 'tool_result']);
    assert.equal(events[0].data.name, 'read_file');
    assert.equal(events[1].data.id, events[0].data.id);
    assert.equal(events[1].data.ok, true);
    assert.equal(events[1].data.result.data.content, 'event payload');
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
});

test('子 agent 解析 provider 的 tool_call 闭合标签和 JSON envelope', () => {
  const { extractToolCalls } = require('../agents/sub-agent');
  assert.deepEqual(extractToolCalls('<tool name="read_file">{"path":"/tmp/a","offset":0}</tool_call>'), [
    { name: 'read_file', args: { path: '/tmp/a', offset: 0 } },
  ]);
  assert.deepEqual(extractToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"/tmp/b","offset":0}}</tool_call>'), [
    { name: 'read_file', args: { path: '/tmp/b', offset: 0 } },
  ]);
});

test('工具 handler 兼容模型把参数包在 raw JSON 中', async () => {
  const { TOOLS } = require('../modules/tools');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(os.tmpdir(), `pangu-raw-tool-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, 'raw payload works\n', 'utf8');
  try {
    const readResult = await TOOLS.read_file({ context: {}, params: {
      raw: JSON.stringify({ path: file, offset: 0, limit: 1 }),
    } });
    assert.equal(readResult.ok, true);
    assert.equal(readResult.data.content, 'raw payload works');

    const execResult = await TOOLS.exec_command({ context: {}, params: {
      raw: JSON.stringify({ command: `printf raw-tool-ok` }),
    } });
    assert.equal(execResult.ok, true);
    assert.match(String(execResult.data.stdout || ''), /raw-tool-ok/);
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
});

test('子 agent 没有成功工具证据时不得返回 done', () => {
  const subAgent = read('agents/sub-agent.js');
  assert.match(subAgent, /const realToolResults = toolHistory\.filter/);
  assert.match(subAgent, /realToolResults\.some\(t => t\.ok === true\)/);
  assert.match(subAgent, /runtimeStatus === 'done'/);
});

test('子 agent 执行层必须把工具白名单传给调用器', () => {
  const loop = read('modules/j2_agent_loop.js');
  const single = read('pangu-single.js');
  assert.match(loop, /toolsAllowed: opts && opts\.toolsAllowed/);
  assert.match(single, /工具 \$\{tc\.name\} 不在当前将灵白名单/);
});
