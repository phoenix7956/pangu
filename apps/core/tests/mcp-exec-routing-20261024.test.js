// 第 79 批: MCP 工具的**执行层**必须真通 —— 签名通了不等于调得动。
//
// 现场 (2026-10-24 实测):
//   提示词写着「MCP 工具 (44 个) … 跟内部工具一样直接用」, 而
//   ① 签名层: native 路径的 toolsSchema 只从 TOOLS_SCHEMA 取 ⇒ `mcp__` 是 0 个
//      ⇒ 模型看得见名字, 一个都签不出来。
//   ② 执行层: j2_agent_loop 的 native 路径执行工具是 `TOOLS[tc.name](...)`,
//      而 TOOLS 表里 `mcp__` 开头的工具也是 **0 个** ⇒ 就算把签名补上,
//      模型一调就炸 "TOOLS[...] is not a function"。
//      legacy 那条 (pangu-single 的 _j2ExecuteToolCalls) **有** mcp__ 路由,
//      native 这条**没有** —— 而本地模型 (LM Studio) 走的就是 native。
//   ③ 只读边界: MCP 工具不在任何角色的白名单里 (白名单只管内部工具),
//      而 action_policy 当时只拦内部工具 ⇒ 只读角色一句
//      `mcp__filesystem-mcp__write_file` 就能写盘, "只读"承诺当场破掉且无日志。
//
// 修法: modules/mcp_tool_exec.js —— 一个**唯一**执行入口 (native/legacy 都走它)
//        + 只读名单 (fail-closed) + action_policy 补 MCP 闸 + schema 层按角色收窄。
//
// 本文件只测**判据与接线**; 真调 (worker 真的调一次 MCP) 的证据在实跑记录里。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mcpExec = require('../modules/mcp_tool_exec');
const actionPolicy = require('../modules/action_policy');
const lc = require('../modules/llm_caller');
const { TOOLS } = require('../modules/tools');
const CORE = path.join(__dirname, '..');

const readSrc = (rel) => fs.readFileSync(path.join(CORE, rel), 'utf8');

test('① mcp__ 工具名认得准 (认得出真工具, 不认 "mcp__" 这种半截)', () => {
  assert.equal(mcpExec.isMcpToolName('mcp__filesystem-mcp__read_text_file'), true);
  assert.equal(mcpExec.isMcpToolName('mcp__github-mcp__create_or_update_file'), true);
  assert.equal(mcpExec.isMcpToolName('mcp__'), false, '"mcp__" 后面没有 server__tool, 不是任何工具');
  assert.equal(mcpExec.isMcpToolName('mcp____tool'), false, 'server 段是空的');
  assert.equal(mcpExec.isMcpToolName('read_file'), false);
  assert.equal(mcpExec.isMcpToolName('write_file'), false);
  assert.equal(mcpExec.isMcpToolName(null), false);
  assert.equal(mcpExec.mcpLeafName('mcp__filesystem-mcp__write_file'), 'write_file');
});

test('② execMcpTool 真路由到 mcp_adapter (参数原样透传, 不许自己改写)', async () => {
  const adapter = require('../modules/mcp_adapter');
  const orig = adapter._callMcpTool;
  const seen = [];
  try {
    adapter._callMcpTool = async (name, params) => {
      seen.push({ name, params });
      return { ok: true, data: { echo: params } };
    };
    const args = { path: '/tmp/x.txt', head: 10 };
    const r = await mcpExec.execMcpTool('mcp__filesystem-mcp__read_text_file', args);
    assert.equal(r.ok, true);
    assert.deepEqual(r.data.echo, args);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].name, 'mcp__filesystem-mcp__read_text_file');
    assert.deepEqual(seen[0].params, args);
    // 没给 params 也要能调 (不能因为 undefined 就炸在 adapter 里)
    await mcpExec.execMcpTool('mcp__filesystem-mcp__read_text_file');
    assert.deepEqual(seen[1].params, {});
  } finally {
    adapter._callMcpTool = orig;
  }
});

test('③ TOOLS 表里 mcp__ 是 0 个 ⇒ native 路径不接 MCP 就必炸 (这条是②存在的理由)', () => {
  const mcpKeys = Object.keys(TOOLS).filter(k => k.startsWith('mcp__'));
  assert.equal(mcpKeys.length, 0,
    'TOOLS 里居然有 mcp__ 工具了 —— 那 native 的 `TOOLS[tc.name](...)` 就不必接 MCP, '
    + '但那是另一套实现, 判据要重写');
});

test('④ native 执行点必须走 mcp_tool_exec (不许裸 TOOLS[tc.name])', () => {
  const src = readSrc('modules/j2_agent_loop.js');
  // native 的执行器: _execToolWithPermission
  const start = src.indexOf('async function _execToolWithPermission');
  assert.ok(start > 0, '没找到 native 执行器 _execToolWithPermission —— 改名了的话先核这条');
  const body = src.slice(start, start + 20000);
  // ⚠️ 只认**真正的调用点** (`TOOLS[tc.name]({ context`), 别撞上注释里那句
  //   "撞上 `TOOLS[tc.name](...)`" —— 那是给人看的, 不是代码 (断言报错先怀疑尺子)。
  const execAt = body.indexOf("TOOLS[tc.name]({ context");
  assert.ok(execAt > 0, 'native 执行器里不该再有 TOOLS[tc.name] —— 走的是别的入口');
  // 裸调用的**前面**必须先判 mcp__ (否则 MCP 调用照样撞 TOOLS[tc.name])
  const before = body.slice(Math.max(0, execAt - 400), execAt);
  assert.match(before, /_isMcpToolName\(tc\.name\)/,
    'TOOLS[tc.name] 之前没有 mcp__ 分支 —— MCP 工具照样走 TOOLS 表 ⇒ 一调就炸');
  assert.match(body, /_execMcpTool\(tc\.name/,
    'native 执行器没有调 _execMcpTool —— MCP 工具在 native 路径上仍然调不动');
});

test('⑤ native 与 legacy 必须共用同一个入口 (两份实现迟早漂)', () => {
  const native = readSrc('modules/j2_agent_loop.js');
  const legacy = readSrc('pangu-single.js');
  assert.match(native, /require\('\.\/mcp_tool_exec'\)/, 'native 没走 modules/mcp_tool_exec');
  assert.match(legacy, /modules[\/\\]mcp_tool_exec/, 'legacy 没走 modules/mcp_tool_exec');
});

test('⑥ 只读角色不许调会改状态的 MCP 工具 (执行层闸, 不是提示词里的承诺)', () => {
  // analyzer 是只读角色 (见 agents/gua-identity 的 READ_ONLY_CODES)
  const denied = actionPolicy.checkRoleAction('analyzer', 'mcp__filesystem-mcp__write_file', { path: '/tmp/x' });
  assert.equal(denied.ok, false, '只读角色调 MCP write_file 必须被拒');
  assert.equal(denied.code, 'ROLE_READ_ONLY');
  assert.match(denied.reason, /只读角色/);
  // 同理: github 的写工具
  const denied2 = actionPolicy.checkRoleAction('checker', 'mcp__github-mcp__create_or_update_file', {});
  assert.equal(denied2.ok, false, '只读角色调 MCP create_or_update_file 必须被拒');
  // 只读工具放行
  const allowed = actionPolicy.checkRoleAction('analyzer', 'mcp__filesystem-mcp__read_text_file', {});
  assert.equal(allowed.ok, true, '只读角色读文件是本分, 不该被拦');
  // 可写角色放行 (kun 坤是写盘那一档)
  const writable = actionPolicy.checkRoleAction('kun', 'mcp__filesystem-mcp__write_file', {});
  assert.equal(writable.ok, true, 'kun 是写盘角色, 不该被 MCP 闸拦');
  // 内部工具的老闸不许被这次改动带坏
  assert.equal(actionPolicy.checkRoleAction('analyzer', 'write_file', {}).ok, false);
  assert.equal(actionPolicy.checkRoleAction('analyzer', 'read_file', {}).ok, true);
});

test('⑦ 认不出来的 MCP 工具按"会改状态"处理 (fail-closed)', () => {
  assert.equal(mcpExec.isMcpMutatingTool('mcp__filesystem-mcp__read_text_file'), false);
  assert.equal(mcpExec.isMcpMutatingTool('mcp__filesystem-mcp__write_file'), true);
  assert.equal(mcpExec.isMcpMutatingTool('mcp__filesystem-mcp__edit_file'), true);
  assert.equal(mcpExec.isMcpMutatingTool('mcp__filesystem-mcp__move_file'), true);
  assert.equal(mcpExec.isMcpMutatingTool('mcp__filesystem-mcp__create_directory'), true);
  assert.equal(mcpExec.isMcpMutatingTool('mcp__github-mcp__push_files'), true);
  assert.equal(mcpExec.isMcpMutatingTool('mcp__github-mcp__add_issue_comment'), true);
  assert.equal(mcpExec.isMcpMutatingTool('mcp__github-mcp__search_code'), false);
  assert.equal(mcpExec.isMcpMutatingTool('mcp__github-mcp__list_commits'), false);
  // 将来某个 server 加了个没登记过的工具 ⇒ 一律按写处理 (只读角色宁可用不了)
  assert.equal(mcpExec.isMcpMutatingTool('mcp__some-new-server__do_something_new'), true);
  // 不是 MCP 工具 ⇒ 不由这个闸管 (内部工具有 MUTATING_TOOLS 那套)
  assert.equal(mcpExec.isMcpMutatingTool('write_file'), false);
});

test('⑧ schema 层按角色收窄: 只读角色看不见会改状态的 MCP 工具', () => {
  const adapter = require('../modules/mcp_adapter');
  const orig = adapter._collectAllToolSchemas;
  adapter._collectAllToolSchemas = () => ([
    { type: 'function', function: { name: 'mcp__filesystem-mcp__read_text_file', description: '读', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }, _mcpServer: 'filesystem-mcp', _mcpToolName: 'read_text_file' },
    { type: 'function', function: { name: 'mcp__filesystem-mcp__write_file', description: '写', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }, _mcpServer: 'filesystem-mcp', _mcpToolName: 'write_file' },
  ]);
  try {
    const readOnly = lc._mcpSchemasForLLM('analyzer');
    const roNames = readOnly.map(s => s.function.name);
    assert.ok(roNames.includes('mcp__filesystem-mcp__read_text_file'), '只读角色该看得见读工具');
    assert.ok(!roNames.includes('mcp__filesystem-mcp__write_file'), '只读角色不该看得见写工具');
    const writable = lc._mcpSchemasForLLM('kun');
    const wNames = writable.map(s => s.function.name);
    assert.ok(wNames.includes('mcp__filesystem-mcp__write_file'), 'kun 是写盘角色, 写工具该给');
    assert.ok(wNames.includes('mcp__filesystem-mcp__read_text_file'));
    // 参数说明必须还在 description 里 (parameters 刻意给空, 省 token)
    const rd = readOnly.find(s => s.function.name === 'mcp__filesystem-mcp__read_text_file');
    assert.match(rd.function.description, /参数:/, '参数说明必须在 description 里');
    assert.deepEqual(rd.function.parameters.properties, {});
  } finally {
    adapter._collectAllToolSchemas = orig;
  }
});

test('⑨ main 拿不到 MCP 工具 (44 个工具的选择噪声 = 模型一个都不调)', () => {
  const adapter = require('../modules/mcp_adapter');
  const orig = adapter._collectAllToolSchemas;
  adapter._collectAllToolSchemas = () => ([
    { type: 'function', function: { name: 'mcp__filesystem-mcp__read_text_file', description: '读', parameters: { type: 'object', properties: {} } } },
  ]);
  try {
    // main 不该由这里拿 (j2_agent_loop 只在 role !== 'main' 时调), 但函数本身按角色判
    assert.ok(lc._mcpSchemasForLLM('main').length >= 0, 'main 的 MCP 由 j2_agent_loop 拦, 这里不做主');
    assert.ok(lc._mcpSchemasForLLM('analyzer').length === 1);
  } finally {
    adapter._collectAllToolSchemas = orig;
  }
  const src = readSrc('modules/j2_agent_loop.js');
  assert.match(src, /if \(_roleForThisLoop !== 'main'\)[\s\S]{0,200}_mcpSchemasForLLM/,
    'j2_agent_loop 必须按角色拦 main (实测: 82 个工具时模型零工具调用)');
});

test('⑩ MCP 工具的超时必须是毫秒量级 (实测踩到的单位错配: 30 秒写成 30 毫秒)', () => {
  // 2026-10-24 (第 79 批实测): adapter 的 register() 里 `_timeout` 写的是**秒**
  //   (long ? 300 : durable ? 120 : 30), 而 callTool 是 setTimeout(..., timeout)
  //   按**毫秒**用 ⇒ 默认 MCP 工具超时只有 **30 毫秒**。
  //   现场证据: `MCP tool read_file timeout after 30ms` —— MCP 工具每一次调用都立刻超时,
  //   而外面看签名正常、路由正常、错误码还是 retryable ⇒ 模型只会以为"这工具坏了"。
  const adapter = require('../modules/mcp_adapter');
  const a = new adapter.MCPAdapter({ name: 'test-server', command: 'true', args: [] });
  try {
    a.register({ name: 'plain_tool', description: 'x' });
    a.register({ name: 'long_tool', description: 'x', long: true });
    a.register({ name: 'durable_tool', description: 'x', durable: true });
    const plain = a.listTools().find(t => t.name === 'plain_tool');
    const long = a.listTools().find(t => t.name === 'long_tool');
    const durable = a.listTools().find(t => t.name === 'durable_tool');
    assert.ok(plain._timeout >= 30000,
      '默认 MCP 工具超时只有 ' + plain._timeout + 'ms —— 单位错配, 每次调用都会立刻超时');
    assert.ok(long._timeout >= 300000, '长任务档的超时不该小于 5 分钟');
    assert.ok(durable._timeout >= 120000, '耐久档的超时不该小于 2 分钟');
    // schema 那边必须原样带过去 (别在转换时又换成秒)
    const schema = a.toPanguToolSchema(plain, 'test-server');
    assert.equal(schema._timeout, plain._timeout);
  } finally {
    try { a.disconnect(); } catch (_) {}
  }
});
