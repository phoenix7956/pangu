// tool-thrash-guard.test.js — 老板 2026-10-09 截图报的工具空转 + Linux 命令误用
// 截图实况: 8 次工具调用全是探测(system_info/network_check baidu/exec_command/
//          process_list), 没有一次在回答问题; exec_command 红色失败, 命令是
//          `hostname && uptime && cat /proc/loadavg` —— /proc 是 Linux 的, macOS 没有。
//
// 排查结论(会话 desktop-1791461554610):
//   a) 模型凭训练惯性写 Linux 命令, exec_command 无平台守卫 → 报 "No such file or directory",
//      而 uptime 本来就给了它想要的负载均值。
//   b) 探测类工具反复调但参数每次不同, _CROSS_ROUND_CALL_LIMIT(按 工具名|参数 判重, 阈值 1)
//      拦不住, 于是模型一路空转。
//   c) task_checkpoint 里问题被记成 `主人问题: ？` —— 空输入也会照常分派子 agent,
//      子 agent 拿不到问题就只能到处试探。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULES = path.join(__dirname, '..', 'modules');
const tools = fs.readFileSync(path.join(MODULES, 'tools', 'index.js'), 'utf8');
const loop = fs.readFileSync(path.join(MODULES, 'j2_agent_loop.js'), 'utf8');
const dispatcher = fs.readFileSync(path.join(MODULES, 'j2_dispatcher.js'), 'utf8');

// 2026-10-23 (第 73 批): 「工具空转」的判定逻辑收成唯一真源 modules/tool_spin_guard.js。
// 原来这份测试 pin 的是 j2_agent_loop.js 里一份**抄本**的位置
// (`const _PROBE_TOOLS = new Set(` / `_sessionToolNameCalls` / `[SYSTEM WARNING: 工具空转]`)。
// 抄本被收走之后, 这些断言就变成了"实现细节的墓碑" —— 改对了反而红。
// 现在改成对**唯一真源**断言行为 (名单/阈值/回灌/清零), 判据不随实现搬家而失效。
const spin = require(path.join(MODULES, 'tool_spin_guard.js'));

function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

test('exec_command: Linux-only 命令在 macOS 上要给出对应写法', () => {
  // 提示表必须在模块作用域(不能被塞进 JSDoc 注释或 TOOLS 对象字面量里)
  assert.ok(
    /^const DARWIN_ONLY_HINTS = \[/m.test(tools),
    'DARWIN_ONLY_HINTS 必须是模块顶层 const — 塞进注释/对象字面量里会静默失效',
  );
  assert.ok(/^function darwinCommandHint\(/m.test(tools), 'darwinCommandHint 必须顶层声明');
  assert.ok(/^function withDarwinHint\(/m.test(tools), 'withDarwinHint 必须顶层声明');
  // 覆盖实案里出现的 Linux 构造
  // 源码里是正则字面量(斜杠已转义), 所以只查关键词本体, 不查带斜杠的完整串
  for (const needle of ['loadavg', 'meminfo', 'cpuinfo', 'free', 'nproc', 'vm_stat', 'sysctl']) {
    assert.ok(tools.includes(needle), `平台提示表应覆盖 ${needle}`);
  }
  // 成功/失败两条返回路径都要注入提示, 否则模型看不到
  const withHintCalls = tools.match(/withDarwinHint\(/g) || [];
  assert.ok(withHintCalls.length >= 3, `withDarwinHint 应在定义外至少被用 2 次(成功/失败路径), 实际 ${withHintCalls.length - 1}`);
});

test('exec_command: 平台提示只挂在 stderr, 成功命令不受污染', () => {
  // 只在 stderr 命中 "No such file or directory" 等失败特征时才追加
  assert.ok(
    /No such file or directory\|command not found\|not found/.test(tools),
    '提示应只在真的报"找不到"时追加, 否则正常命令的 stderr 会被污染',
  );
});

test('空输入守门: dispatcher 不该拿空 userInput 去分派子 agent', () => {
  assert.ok(
    /if\s*\(!String\(userInput \|\| ''\)\.trim\(\)\)/.test(dispatcher),
    'dispatcher 应在分派前拒绝空 userInput — 否则子 agent 空跑一轮烧 token',
  );
  assert.ok(
    /note:\s*'empty user input'/.test(dispatcher),
    '空输入应走明确的失败收口, 而不是继续分派',
  );
});

test('探测类工具空转检测: 按工具名维度记次并回灌停止指令', () => {
  // 名单 + 阈值住在唯一真源里 (不在 j2_agent_loop 的抄本里)
  assert.ok(spin.PROBE_TOOLS instanceof Set, '应导出探测类工具名单');
  for (const t of ['system_info', 'current_time', 'process_list', 'network_check']) {
    assert.ok(spin.PROBE_TOOLS.has(t), `探测类名单应包含 ${t} (2026-10-09 老板截图现场)`);
  }
  assert.ok(spin.TOOL_NAME_SPAM_LIMIT >= 2, '探测类阈值应存在');

  // 行为: 同一个探测工具连调 N 次 (参数每次不同) 必须被喊停 ——
  // 这正是"参数一变就换桶"的老闸门拦不住的那一类 (2026-10-23 实跑现场)。
  const g = spin.createToolSpinGuard({});
  for (let i = 0; i < spin.TOOL_NAME_SPAM_LIMIT; i++) {
    g.note([{ name: 'system_info', params: { attempt: i } }],
      [{ name: 'system_info', ok: true, stdout: 'x' }]);
  }
  const hit = g.check({ saidAnything: false, toolsUsed: ['system_info'] });
  assert.ok(hit, '探测类工具反复调 (参数每次不同) 必须被判定为空转');
  assert.ok(hit.message && hit.message.length > 10, '命中时要给出可回灌的停止指令');

  // 有实质进展时不能打扰 (写盘/编辑/验收)
  for (const t of ['write_file', 'file_edit', 'apply_patch', 'task_done']) {
    assert.ok(spin.PROGRESS_TOOLS.has(t), `${t} 应算实质进展, 不该被当成空转`);
  }
});

test('空转回灌后要清零, 避免每轮都喊', () => {
  const g = spin.createToolSpinGuard({});
  for (let i = 0; i < spin.TOOL_NAME_SPAM_LIMIT; i++) {
    g.note([{ name: 'system_info', params: { attempt: i } }],
      [{ name: 'system_info', ok: true, stdout: 'x' }]);
  }
  const first = g.check({ saidAnything: false, toolsUsed: ['system_info'] });
  assert.ok(first, '第 N 次探测应被喊停');
  g.reset(first.spammed);
  const second = g.check({ saidAnything: false, toolsUsed: ['system_info'] });
  assert.equal(second, null, '回灌并清零后, 同一批计数不该再触发 (否则每轮都喊)');
});

test('唯一真源: 判定阈值不许在 j2_agent_loop 里再抄一份', () => {
  const code = stripComments(loop);
  assert.doesNotMatch(code, /_PROBE_TOOLS\s*=\s*new Set\(/,
    '探测类名单只有一份 —— 两份抄本 = 两个真源 = 迟早又岔开 (第 73 批收拢的原因)');
  assert.doesNotMatch(code, /_sessionToolNameCalls/,
    '按工具名记次的计数表只有一份');
});
