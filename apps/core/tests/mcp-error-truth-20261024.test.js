// 第 81 批: MCP 工具**失败**不许报成成功 —— MCP 有两条错误通道, 以前只听了一条。
//
// 现场 (2026-10-24 probe80 实跑, /tmp/pangu-single.log):
//   盘古派子 agent 用 mcp__filesystem-mcp__write_file 往 /tmp/probe80-work/ 写文件。
//   filesystem-mcp 明明白白回了:
//     { content:[{type:'text',text:'Access denied - path outside allowed directories: /tmp/probe80-work not in /Users/you'}],
//       isError:true }
//   盘古照样报 `ok=true exec_ms=173` —— 模型以为写成功了, SSE 显示成功,
//   磁盘上什么都没有 ⇒ 假交付 + 反复重试 ⇒ probe80 15 分钟超时 (CURL_EXIT=28)。
//
// 协议事实 (本机实测 @modelcontextprotocol/server-filesystem, 2026-10-24):
//   失败: { result: { content:[{type:'text',text:'Access denied - ...'}], isError:true } }
//   成功: { result: { content:[{type:'text',text:'Successfully wrote to X'}], structuredContent:{...} } }
//   —— 失败**不走** JSON-RPC 的 error 字段。adapter 的 callTool 只在 result.error 时 reject,
//      于是工具层失败一路 resolve 到 _callMcpTool, 以前被包成 { ok:true }。
//
// 修法: mcp_adapter.normalizeMcpCallResult —— 判据只看协议字段 isError===true,
//      归一在**所有** MCP 调用路的唯一入口 (_callMcpTool) 上做。
//      配套: MCP 的四个错误码进 ERROR_CODES 枚举; MCP 真写盘进账本 files_written。
//
// 本文件只测**判据与接线**; 真调的证据在实跑记录 (probe81) 里。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 隔离 PANGU_HOME — 账本测试要写文件, 必须在 require 之前设
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-mcp-truth-'));
process.env.PANGU_HOME = TMP_HOME;
// 2026-10-26 第 100 批: 账本目录走唯一真源 (modules/state_paths.js),
// 解析顺序 PANGU_LEDGER_DIR > PANGU_HOME/state/ledger > 生产默认。
// 只设 PANGU_HOME 会被链沙箱里的 PANGU_LEDGER_DIR 抢在前面 ⇒ 账本落到共享沙箱目录,
// 本测试的隔离意图 (自己的 TMP) 就没了。
process.env.PANGU_LEDGER_DIR = path.join(TMP_HOME, 'state', 'ledger');

const adapter = require('../modules/mcp_adapter');
const mcpExec = require('../modules/mcp_tool_exec');
const errorCodes = require('../modules/error_codes');
const ledger = require('../modules/task_ledger');

const CORE = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(CORE, rel), 'utf8');

// 现场抓到的真形状 (2026-10-24 实测 MCP server 返回)
const DENIED_RESULT = {
  content: [{ type: 'text', text: 'Access denied - path outside allowed directories: /tmp/probe80-work not in /Users/you' }],
  isError: true,
};
const OK_RESULT = {
  content: [{ type: 'text', text: 'Successfully wrote to /Users/you/x.txt' }],
  structuredContent: { content: 'Successfully wrote to /Users/you/x.txt' },
};

test('① 工具层失败 (isError=true) ⇒ ok=false, 真错误正文必须带到模型面前', () => {
  const r = adapter.normalizeMcpCallResult(DENIED_RESULT, 'filesystem-mcp', 'write_file');
  assert.equal(r.ok, false, 'isError=true 还报 ok=true —— 这就是 probe80 那次撒谎的地方');
  assert.equal(r.error.code, 'MCP_TOOL_ERROR');
  assert.match(r.error.message, /Access denied - path outside allowed directories/,
    '模型必须看见 MCP server 的真错误正文, 否则它只会原样重试');
  assert.match(r.error.message, /filesystem-mcp\/write_file/, '错误里要带 server/工具名, 才知道是谁拒绝了');
  assert.equal(r.error.retryable, false, '确定性失败 (路径不在允许目录) 不该按可重试处理');
  assert.match(r.error.fallback_hint, /write_file/, '得告诉模型有退路 (内部 write_file)');
  // 原始回执不丢 (证据 + 模型看得见真正文)
  assert.deepEqual(r.data, DENIED_RESULT);
});

test('② 成功结果不许被误判成失败 (别为了修谎报把好结果也判坏)', () => {
  const r = adapter.normalizeMcpCallResult(OK_RESULT, 'filesystem-mcp', 'write_file');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, OK_RESULT);
  // 没有 content 的成功结果 (某些 server 直接回 structuredContent) 也不能判坏
  const bare = adapter.normalizeMcpCallResult({ structuredContent: { ok: 1 } }, 'github-mcp', 'list_commits');
  assert.equal(bare.ok, true);
  // undefined / null 一律当成功处理 (没有 isError 就不该说失败)
  assert.equal(adapter.normalizeMcpCallResult(undefined, 'x', 'y').ok, true);
});

test('③ 判据只看协议字段 isError, 不看错误正文长什么样 (不许用字符串猜)', () => {
  // 正文里带 denied/error, 但协议没说失败 ⇒ 仍算成功 (否则换个措辞就误杀)
  const notFlagged = adapter.normalizeMcpCallResult(
    { content: [{ type: 'text', text: 'Access denied: 0 errors found' }] }, 'filesystem-mcp', 'read_file');
  assert.equal(notFlagged.ok, true, '正文像错误就判失败 = 用措辞猜判据');
  // 正文看着像成功, 但协议标了 isError ⇒ 算失败 (协议说了算)
  const flagged = adapter.normalizeMcpCallResult(
    { content: [{ type: 'text', text: 'Successfully wrote to /x' }], isError: true }, 'filesystem-mcp', 'write_file');
  assert.equal(flagged.ok, false, 'isError=true 必须算失败, 不看正文');
  // isError 必须是布尔 true —— 字符串 'true' / 数字 1 不算
  assert.equal(adapter.normalizeMcpCallResult({ isError: 'true' }, 's', 't').ok, true);
  assert.equal(adapter.normalizeMcpCallResult({ isError: 1 }, 's', 't').ok, true);
});

test('④ 错误正文抽取认三种形状 (content 数组 / content 字符串 / structuredContent)', () => {
  // 精确等值 —— 抽取的契约是"content[].text 那几行", 不是"把整个 result 序列化"。
  // (退化成 JSON 兜底也能凑出 "Access denied" 字样, 但那是坨 JSON, 不是给模型看的错误行 ——
  //  变异测试实测过: 少了精确断言, "抠不出正文" 这一发就是空枪。)
  assert.equal(
    adapter.extractMcpErrorText(DENIED_RESULT),
    'Access denied - path outside allowed directories: /tmp/probe80-work not in /Users/you');
  assert.match(adapter.extractMcpErrorText(DENIED_RESULT), /Access denied/);
  assert.match(adapter.extractMcpErrorText({ content: 'plain string error' }), /plain string error/);
  assert.match(adapter.extractMcpErrorText({ structuredContent: { content: 'from structured' } }), /from structured/);
  assert.match(adapter.extractMcpErrorText({ structuredContent: { error: 'from error field' } }), /from error field/);
  // 抠不出正文也不许空着 (空错误正文 = 模型不知道为什么失败 → 原样重试)
  const noText = adapter.normalizeMcpCallResult({ isError: true }, 's', 't');
  assert.ok(noText.error.message.length > 0, 'isError=true 但没正文 ⇒ 也得有句能看的话');
});

test('⑤ MCP 的四个错误码在枚举里 (ToolResult 契约不许有法外码)', () => {
  for (const c of ['MCP_TOOL_ERROR', 'MCP_CALL_FAILED', 'MCP_SERVER_DOWN', 'MCP_BAD_NAME']) {
    assert.equal(errorCodes.isValidErrorCode(c), true, c + ' 不在 ERROR_CODES 枚举里 —— isValidErrorCode 会判它非法');
    assert.ok(errorCodes.getFallbackHint(c), c + ' 缺 fallback_hint (模型看不到退路)');
  }
  // MCP 失败结果要能通过工具结果 schema 校验 (ok=false 分支)
  const r = adapter.normalizeMcpCallResult(DENIED_RESULT, 'filesystem-mcp', 'write_file');
  assert.equal(errorCodes.isValidToolResult(r), true, 'MCP 失败结果过不了 ToolResult schema 校验');
});

test('⑥ 唯一入口收口: native / legacy / HTTP 三条调用路都过 _callMcpTool', async () => {
  // 动态: 塞一个假 adapter 进表, 让它回 isError 的失败 ⇒ 必须报 ok=false
  const fake = {
    callTool: async () => DENIED_RESULT,
    listTools: () => [],
    isConnected: () => true,
  };
  adapter._multiAdapters.set('fake-server', fake);
  try {
    const r = await adapter._callMcpTool('mcp__fake-server__write_file', { path: '/tmp/x.txt' });
    assert.equal(r.ok, false, '唯一入口没收口 ⇒ 撒谎漏回');
    assert.equal(r.error.code, 'MCP_TOOL_ERROR');
    // 另一条调用路 (mcp_tool_exec.execMcpTool) 也必须拿到同样的真伪
    const r2 = await mcpExec.execMcpTool('mcp__fake-server__write_file', { path: '/tmp/x.txt' });
    assert.equal(r2.ok, false, 'execMcpTool 这条路报成功了 —— 两路分叉');
    // 成功路径不受影响
    fake.callTool = async () => OK_RESULT;
    const r3 = await adapter._callMcpTool('mcp__fake-server__write_file', { path: '/Users/you/x.txt' });
    assert.equal(r3.ok, true);
  } finally {
    adapter._multiAdapters.delete('fake-server');
  }
  // 静态: 三条调用口都指向同一个入口
  assert.match(readSrc('modules/mcp_tool_exec.js'), /require\('\.\/mcp_adapter'\)/);
  assert.match(readSrc('pangu-single.js'), /modules[\/\\]mcp_tool_exec/);
  assert.match(readSrc('pangu-single/routes/mcp.js'), /mcp_adapter'\)\._callMcpTool|_callMcpTool/,
    'HTTP 的 /api/mcp/call 不走唯一入口 ⇒ 它会继续对前端撒谎 (200 + ok:true)');
});

test('⑦ MCP 真写盘进账本, 失败的 MCP 写**不进**', () => {
  const SID = 'mcp-truth-' + Date.now();
  // 真写 (ok=true) ⇒ 进 files_written
  ledger.recordToolResult(SID, 'mcp__filesystem-mcp__write_file', { path: '/Users/you/notes/a.md', content: 'x' }, {
    ok: true, data: { content: [{ type: 'text', text: 'Successfully wrote to /Users/you/notes/a.md' }] },
  });
  const l = ledger.loadLedger(SID);
  const w = l.facts.files_written;
  assert.ok(w.some(x => x.path === '/Users/you/notes/a.md'),
    'MCP 写的文件没进账本 ⇒ "已真写"清单少它, 对账只剩 mtime 兜底');
  // 失败 (ok=false) ⇒ 不进 (账上写着写了 = 真写了)
  ledger.recordToolResult(SID, 'mcp__filesystem-mcp__write_file', { path: '/tmp/denied.txt', content: 'x' }, {
    ok: false, error: { code: 'MCP_TOOL_ERROR', message: 'Access denied - path outside allowed directories' },
  });
  const l2 = ledger.loadLedger(SID);
  assert.ok(!l2.facts.files_written.some(x => x.path === '/tmp/denied.txt'),
    '失败的 MCP 写进账本了 —— 账本变成谎话来源');
  // 内部 write_file 老行为不变
  const SID2 = SID + '-internal';
  ledger.recordToolResult(SID2, 'write_file', { path: '/o/x.md' }, { ok: true, data: { path: '/o/x.md', bytes: 12 } });
  assert.ok(ledger.loadLedger(SID2).facts.files_written.some(x => x.path === '/o/x.md'));
});
