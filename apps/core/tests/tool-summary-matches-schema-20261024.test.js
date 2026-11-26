// 2026-10-24 (第 80 批): 工具清单必须跟**这一轮真能调的集**对齐。
//
// 现场 (probe79-mcp 日志实测, 不是推演):
//   拆解轮 (dispatcher 的 _planViaMainAgent) 走 role='main' + toolsAllowed=['dispatch_subagents'],
//   它的 API schema 只有 **2 个**工具 (dispatch_subagents + task_done) ——
//   而 llm_caller 的工具清单按**角色档**给了它 main 的 **38 个**,
//   它一个都调不到, 却白背 6042 字符 ≈ 2115 token, 整刀 **183.7 秒**。
//
// 这跟第 79 批修的是**同一个病** (清单比 schema 多 ⇒ 模型看得见调不到),
// 只是那次修的是「角色档 vs 全量」, 这次是「toolsAllowed 收窄 vs 角色档」。
//
// 另外挖出: **流式路径从来没传过 soulScope** —— 2026-10-16 那次
// 「子 agent 只带 worker 档 soul」只接了非流式分支, 流式 (生产主路径) 漏了 8 个月。
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LC_PATH = path.join(__dirname, '../modules/llm_caller.js');
const LOOP_PATH = path.join(__dirname, '../modules/j2_agent_loop.js');
const lcSrc = fs.readFileSync(LC_PATH, 'utf8');
const loopSrc = fs.readFileSync(LOOP_PATH, 'utf8');

function initLlc() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/pangu/apps/core/modules/llm_caller.js')) delete require.cache[k];
  }
  const lc = require('../modules/llm_caller');
  lc.init({
    _config: { llm: { models: [{}] }, memory: {} },
    fs: require('fs'), path: require('path'), os: require('os'),
    https: require('https'), http: require('http'),
    PRESETS: {}, PANGU_SYSTEM_PROMPT: 'SOUL_BASE',
    _getPromptFacts: () => ({ toolCount: 127, skillCount: 0, skillManifest: '(空)', mcp: { tools: 0, servers: 0 } }),
  });
  return lc;
}

// ==== 一、清单口径: 传了「这一轮真能调的集」就以它为准 ====

test('清单按传入的可调集出 (拆解轮只列 dispatch_subagents + task_done)', () => {
  const lc = initLlc();
  const summary = lc._loadToolSummary(['dispatch_subagents', 'task_done']);
  assert.ok(summary, '必须出清单');
  assert.ok(/实际能调\*\*的 2 个/.test(summary),
    '清单必须说「实际能调的 2 个」, 而不是角色档的 38 个');
  assert.ok(summary.includes('dispatch_subagents'), '必须列 dispatch_subagents');
  assert.ok(summary.includes('task_done'), '必须列 task_done');
  // 角色档里那些拆解轮调不到的工具, 一个都不许出现
  for (const notAllowed of ['read_file', 'exec_command', 'write_file', 'stock_quote']) {
    assert.ok(!new RegExp('^- \\*\\*' + notAllowed + '\\*\\*', 'm').test(summary),
      '拆解轮调不到 ' + notAllowed + ', 清单里不许出现');
  }
});

test('清单不传可调集时退回角色档 (老调用方不受影响)', () => {
  const lc = initLlc();
  const summary = lc._loadToolSummary(undefined);
  // ⚠ 2026-10-30 第 172 批: 这个断言原来把 "38 个" 写死了 ——
  //   main 集加了 send_wechat (盘古自己接微信) 后变成 39, 断言就红了。
  //   **别把 38 改成 39** —— 下一个工具加进来还会红第二遍。
  //   口径应当是「角色档有几个就写几个」, 数字取自**同一份真源**。
  const { MAIN_GENERAL_TOOLS_FOR_LLM } = require(path.join(__dirname, '..', 'modules', 'tools_schema'));
  const n = MAIN_GENERAL_TOOLS_FOR_LLM.length;
  assert.ok(new RegExp('实际能调\\*\\*的 ' + n + ' 个').test(summary),
    '不传 = 不知道 = 退回角色档 (main ' + n + ' 个, 数字取自 MAIN_GENERAL_TOOLS_FOR_LLM)');
});

test('可调集是空数组 ⇒ 整块清单都不出 (这一轮一个工具都调不到)', () => {
  const lc = initLlc();
  const summary = lc._loadToolSummary([]);
  assert.strictEqual(summary, '',
    '空数组 = 这一轮调不到任何工具 ⇒ 清单整块不出 '
    + '(出「0 个工具」的壳子 + 「可以派给别的将灵」那段都是噪音, 还会教它去派活)');
});

test('空可调集时不许出现「派给别的将灵」那段', () => {
  const lc = initLlc();
  const summary = lc._loadToolSummary([]);
  assert.ok(!/派给/.test(summary),
    '一个工具都调不到的收口调用, 不该被教「可以派活」');
});

test('main 档不许列 MCP 工具 (它的 API schema 里 0 个 MCP 工具)', () => {
  // 2026-10-24 (第 80 批): 第 79 批定了「MCP 只给 worker, 不给 main」,
  // 而提示词的 MCP 段原来**无条件**列全部 ⇒ main 看得见 44 个 MCP 工具名,
  // 一个都签不出来 —— **第 79 批那个「看得见调不到」的病, 换了个地方复发**。
  // 判据: 提示词列的 MCP 工具集必须跟 API schema 那一侧用的是**同一个函数**的产物。
  const lc = initLlc();
  const mainSummary = lc._loadToolSummary(undefined, 'main');
  const mcpSchemasForMain = lc._mcpSchemasForLLM('main');
  assert.strictEqual(mcpSchemasForMain.length, 0,
    '前提: main 的 API schema 里 0 个 MCP 工具');
  assert.ok(!/^# MCP 工具/m.test(mainSummary),
    'main 档不许出现 MCP 工具段 —— 它的 API schema 里一个 MCP 工具都没有');
});

test('main 档不许列 MCP 工具 —— 注入式断言 (原断言是空枪, 环境没 MCP server 时恒真)', () => {
  // 2026-10-25 (第 82 批): 上面那条断言**在这个测试环境里是空枪** ——
  //   没有 MCP server ⇒ `_collectAllToolSchemas()` 返回 [] ⇒
  //   `_mcpSchemasForLLM('main').length === 0` 恒成立, 跟代码对不对无关。
  //   而线上**恰恰相反**: 会话 39268686 的主会话落盘里,
  //   main 档「工具清单」10851 字中有一段
  //     "# MCP 工具 (44 个 — 外部进程, 调用名格式 mcp__<server>__<tool>)"
  //   而同一轮 [agent-llm] 行写的是 tools=38 —— **38 个里 0 个是 MCP**。
  //   根因: _mcpSchemasForLLM 原来只按 isReadOnlyRole 过滤, 而
  //   isReadOnlyRole('main') 返回 false (NON_GUA_ROLES 含 'main') ⇒ main 拿到全部。
  //
  // 这条用**打桩注入** MCP schema, 让判据在"真有 MCP 工具"的世界里成立 ——
  // 空枪打不中 bug, 打桩枪才打得出。
  const mcp = require('../modules/mcp_adapter');
  const orig = mcp._collectAllToolSchemas;
  const fake = [
    { function: { name: 'mcp__github-mcp__search_repositories', description: '搜仓库', parameters: { properties: { query: { type: 'string' } }, required: ['query'] } }, _mcpServer: 'github-mcp' },
    { function: { name: 'mcp__github-mcp__create_or_update_file', description: '写文件', parameters: { properties: { path: { type: 'string' } } } }, _mcpServer: 'github-mcp' },
    { function: { name: 'mcp__filesystem-mcp__read_file', description: '读文件', parameters: { properties: { path: { type: 'string' } } } }, _mcpServer: 'filesystem-mcp' },
  ];
  mcp._collectAllToolSchemas = () => fake;
  try {
    const lc = initLlc();
    // 先确认桩生效: 别的角色确实能拿到 MCP 工具 (否则下面全是空枪)
    const asLi = lc._mcpSchemasForLLM('li');
    assert.ok(asLi.length > 0,
      '前提: 打桩后只读角色 (li) 确实能拿到 MCP 工具 —— 否则这条断言又是空枪');
    // 关键判据: main 一个都不许拿
    assert.strictEqual(lc._mcpSchemasForLLM('main').length, 0,
      'main 的 API schema 里 0 个 MCP 工具 (j2_agent_loop 按 role 挂), 提示词侧就必须 0 个');
    const mainSummary = lc._loadToolSummary(undefined, 'main');
    assert.ok(!/^# MCP 工具/m.test(mainSummary),
      'main 档不许出现 MCP 工具段 —— 有 MCP server 时它就会漏出 44 个调不到的工具名');
    assert.ok(!mainSummary.includes('mcp__github-mcp__search_repositories'),
      'main 档不许出现具体 MCP 工具名');
  } finally {
    mcp._collectAllToolSchemas = orig;
  }
});

test('提示词列的 MCP 工具必须跟 API schema 同源 (不许各列一份)', () => {
  // 两处各列一份 = 迟早漂。判据: 提示词那段必须调用 _mcpSchemasForLLM。
  const i = lcSrc.indexOf('function _loadToolSummary');
  const body = lcSrc.slice(i, lcSrc.indexOf('\n}', lcSrc.indexOf('return result;', i)));
  assert.ok(body.includes('_mcpSchemasForLLM'),
    '提示词的 MCP 段必须用 _mcpSchemasForLLM —— 它就是 API schema 那一侧用的同一个函数');
  assert.ok(!body.includes('_collectAllToolSchemas'),
    '不许直接调 _collectAllToolSchemas (那是全量, 不分角色, 会让 main 看得见调不到)');
});

// ==== 二、清单跟 API schema 同源: j2_agent_loop 必须把它带下去 ====

test('j2_agent_loop 算出有效工具集后, 必须把它带进 LLM 调用 (清单跟 schema 同源)', () => {
  // 判据: 「清单用哪个集合」和「schema 用哪个集合」必须是**同一个** _effectiveTools。
  // 少带一次 ⇒ 清单退回角色档 ⇒ 回到第 79 批修过的那个病。
  assert.ok(loopSrc.includes('_callableToolNames'),
    '必须算出本轮真能调的集 (名字列表)');
  const nCarry = (loopSrc.match(/callableTools:\s*_callableToolNames/g) || []).length;
  assert.ok(nCarry >= 3,
    '主路径的 LLM 调用点至少 3 处要带 callableTools, 实际 ' + nCarry + ' 处');
});

test('主路径的每一处 LLM 调用都要带 callableTools (漏一处 = 那条路径白修)', () => {
  // 跟 2026-10-16 那条守卫同一个教训: 判定挂在 opts 上, **调用点**才决定它生不生效。
  const re = /_callLLMWithTimeout\(|_deps\._callLLMForAgent\(/g;
  const sites = [...loopSrc.matchAll(re)]
    // 去掉**函数定义**那一处 (async function _callLLMWithTimeout(...)) ——
    // 它不是调用点, 它的 opts 是形参。把它算进去, 守卫就会报一个查不出来的"漏一处"。
    .filter(m => !/async function\s*$/.test(loopSrc.slice(Math.max(0, m.index - 30), m.index)));
  const argSpan = (from) => {
    let i = loopSrc.indexOf('(', from), depth = 0;
    for (; i < loopSrc.length; i++) {
      if (loopSrc[i] === '(') depth++;
      else if (loopSrc[i] === ')' && --depth === 0) return loopSrc.slice(from, i + 1);
    }
    return loopSrc.slice(from);
  };
  // 只查**主路径**: 收口调用 (tools=[]) 传的是空数组 (整块清单不出), 是对的。
  const mainPath = sites.filter(m => {
    const span = argSpan(m.index);
    return !/,\s*\[\]\s*,/.test(span.slice(0, 120)) || /toolsSchema/.test(span.slice(0, 120));
  });
  const withTools = mainPath.filter(m => argSpan(m.index).includes('callableTools'));
  assert.equal(withTools.length, mainPath.length,
    `${withTools.length}/${mainPath.length} 处主路径调用带了 callableTools —— `
    + '漏掉的那些在提示词里仍会拿到角色档清单 (第 79 批那个病)');
});

test('收口调用 (tools=[]) 必须显式传空数组 (不许省略成没传)', () => {
  // 省略 = undefined = 「不知道」⇒ 退回角色档 38 个 ⇒ 收口调用又白背一份清单。
  const re = /_callLLMWithTimeout\([^)]*?,\s*\[\]\s*,/g;
  const sites = [...loopSrc.matchAll(re)];
  assert.ok(sites.length >= 3, '收口调用点数量变了 (' + sites.length + '), 复核一遍');
  for (const s of sites) {
    const span = loopSrc.slice(s.index, s.index + 600);
    const optsStart = span.indexOf('{');
    const optsEnd = span.indexOf('});');
    const opts = optsStart >= 0 && optsEnd > optsStart ? span.slice(optsStart, optsEnd) : span;
    assert.ok(/callableTools:\s*\[\]/.test(opts),
      '收口调用必须传 callableTools: [] (它一个工具都调不到)');
  }
});

// ==== 三、流式路径的 soulScope (2026-10-16 漏了 8 个月的那处) ====

test('流式 LLM 调用必须带 soulScope (子 agent 不该再背 main 档 soul)', () => {
  // 现场: llm_caller._callLLMForAgentStream 的签名原来只有 3 个参数,
  // 而调用方 (j2_agent_loop 生产主路径) 传了第 4 个 ({signal, sessionId})
  // ⇒ **整个 opts 被静默丢掉** ⇒ 流式下子 agent 拿的是 main 档 soul (9918 token),
  // 而不是 worker 档 (242 token)。2026-10-16 那次只接了非流式分支。
  assert.ok(/async function\* _callLLMForAgentStream\(messages, modelConfig, toolsSchema, opts\)/.test(lcSrc),
    '_callLLMForAgentStream 必须接住 opts (原来只有 3 个参数, opts 被丢了)');
  assert.ok(/async function\* _callLLMForAgentStreamImpl\(messages, modelConfig, toolsSchema, opts\)/.test(lcSrc),
    '_callLLMForAgentStreamImpl 必须接住 opts');
  assert.ok(/_callLLMForAgentStreamImpl\(messages, modelConfig, toolsSchema, opts\)/.test(lcSrc),
    'wrapper 必须把 opts 传下去');
});

test('流式路径的 soul 注入必须用 opts.soulScope (不许再写死 main)', () => {
  const i = lcSrc.indexOf('async function* _callLLMForAgentStreamImpl');
  assert.ok(i > 0, '找不到流式实现');
  const body = lcSrc.slice(i, i + 1200);
  const call = body.match(/_injectSoulSysMsgs\([^)]*\)/);
  assert.ok(call, '流式实现里必须有 soul 注入');
  assert.ok(/opts\s*&&\s*opts\.soulScope/.test(call[0]),
    '流式的 soul 注入必须用 opts.soulScope —— '
    + '写死就等于子 agent 在流式下又背 main 档 soul');
});

test('j2_agent_loop 的流式调用点必须带 soulScope', () => {
  const i = loopSrc.indexOf('_deps._callLLMForAgentStream(');
  assert.ok(i > 0, '找不到流式调用点');
  const span = loopSrc.slice(i, i + 900);
  assert.ok(/soulScope:/.test(span),
    '流式调用点必须带 soulScope (2026-10-16 那次就漏在这儿)');
});

// ==== 四、llm_caller 自己的两个 soul 注入点 ====

test('llm_caller 里的 soul 注入点: 带 opts 的必须真的用 opts (不许接了不用)', () => {
  const re = /_injectSoulSysMsgs\(messages, useModel[^)]*\)/g;
  const calls = [...lcSrc.matchAll(re)].map(m => m[0]);
  for (const c of calls) {
    if (c.includes('opts && opts.soulScope')) {
      assert.ok(c.includes('callableTools'),
        '带 opts 的注入点必须同时把 callableTools 带下去 —— '
        + '只带 soulScope 的话, 清单还是角色档');
    }
  }
});
