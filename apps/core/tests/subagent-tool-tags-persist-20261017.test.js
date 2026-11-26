'use strict';

// 2026-10-17: "调用有没有用工具, 完全不知道" 在 UI 层的根因。
//
// 数据其实**一路都在**: 服务端 batch_complete / sub_done 都转成带 agent 归属的
//   sub_agent_progress(stage=tool_executed, tools:[...])  (见 j2_dispatcher._makeSinkRes,
//   2026-10-16 那刀已经打通了传输), 前端也**存**进了 agent.tools,
//   面板也确实有画工具标签的代码。
//
// 断点在最后一步: 那段标签渲染整个包在 `agent.status === 'running'` 里。
//   将灵一收工 status 翻成 done → **刚调过的工具名当场全部消失** →
//   主人在跑的时候偶尔瞥见几个标签, 等活干完回看卡片又是干干净净一张 →
//   "它到底用了什么工具?" 一问就答不上来。
//
// 工具名是**证据**, 不是活体信号: 干完活更要看它。而"思考中 · N 字"是活体信号,
// 停下来还显示就是假的 —— 两者必须拆开, 不能绑在同一个 status 判断上。
//
// ── 2026-10-26 第 107 批 (桌面端下线) ──
// 原来三条:
//   T1 (工具标签不许绑 status) / T2 (活体信号仍必须绑 running)
//     —— 查的是 SubAgentPanel.tsx 怎么画, 纯界面层, 随 apps/desktop 一起下线。
//   T3 (数据链路两端仍然通着)
//     —— 拆两半: 服务端那半 (batch_complete 要转成带 tools 的
//     sub_agent_progress) **保留**; 前端那半 (存进卡片状态 / 卡片类型字段) 删。
//
// **服务端这一侧就是"工具名是证据"的落点**: 事件里必须真的带着工具名,
// 客户端才有可能把它画出来。载荷缺了 = 证据在服务端就丢了, 谁都救不回来。

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

// 服务端: batch_complete 要转成带 tools 的 sub_agent_progress
// 2026-10-17: 这段转换随 sink 一起搬进了 subagent_runner (主 agent 复用同一份派发),
// 所以服务端那一端读两个文件 —— 只读 dispatcher 会对搬家后的真出事点失明。
const DISP = ['modules/j2_dispatcher.js', 'modules/subagent_runner.js']
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

test('T3 服务端必须把工具名真的挂进事件 payload (数据链路的源头)', () => {
  assert.match(DISP, /stage:\s*'tool_executed'/, 'T3: 服务端必须发 stage=tool_executed 的活性事件');
  assert.match(DISP, /tools:\s*names/, 'T3: 工具名必须真的挂进事件 payload');
  // 证据不许在服务端就丢: 工具名要透出去, 但**结果不许透** (结果可能含文件内容)。
  const at = DISP.indexOf("event: batch_complete");
  assert.ok(at > 0, '要能找到 batch_complete 的穿透点');
  const block = DISP.slice(at, at + 1200);
  assert.doesNotMatch(block, /toolResults|tool_results|\.data\b/,
    '只许透工具名, 不许把工具结果 (可能含文件内容) 发出去');
});

test('T3b 工具名必须来自真实调用记录, 不许是空数组凑数', () => {
  // 事件带着空的 tools: [] 发出去 = 看起来"有证据"其实没有 —— 比不发更坏。
  const at = DISP.indexOf('tools: names');
  assert.ok(at > 0, '要能找到 tools 赋值点');
  const seg = DISP.slice(Math.max(0, at - 900), at + 200);
  assert.ok(/tool_names/.test(seg),
    'tools 必须来自 batch_complete 载荷里的 tool_names —— 不是自己编的');
  assert.ok(/if \(names\.length\)/.test(seg),
    '一个工具名都没有时**不许发这条事件** —— 空证据比没证据更坏');
});
