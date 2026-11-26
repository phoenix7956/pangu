// 2026-10-16 长任务"跟死了一样" —— 子 agent 卡片从头到尾一张都没建起来
//
// 老板原话: "盘古调用模型, 没问题了, 但不是流式输出, 调用有没有用工具完全不知道, 跟死了一样"。
//
// 实跑取证 (live-1792146487916 / live-1792146810934, 两轮各 3 个并行 analyzer):
//   status{stage:'sub_agent_start'}  = 3 条
//   真正的 sub_agent_start 事件      = 0 条   ← 前端建卡就挂在这个事件上
//   sub_agent_done                  = 3 条   ← 但它只更新既有卡片, 不建卡
// 于是 SubAgentPanel 全程 0 张卡, 顶栏"将灵状态"从 subAgents 里筛 running 永远筛不到,
// 整个长任务期间显示"静候" —— 三个子 agent 各自磨 200~550s, 屏幕上连"在跑"都看不到。
//
// 三个并行 analyzer 本该是 3 张卡, 但前端又只用 agent 名当身份, 第二/第三个 start
 // 会把第一张卡替换掉 → 就算事件补上了, 仍然只有 1 张。
//
// ── 2026-10-26 第 107 批 (桌面端下线) ──
// 原来六条, 这批拆两半:
//   · T1 (服务端发真 sub_agent_start) / T5 (工具活动要穿透到带 agent 归属的事件)
//     —— 原样保留, 全是服务端。
//   · T2 (卡片身份必须是 agent+task) / T3 (必须接 sub_agent_progress)
//     —— 原来查的是前端怎么认领卡片, 现在**扶正成服务端事件契约**:
//       服务端发的事件必须带 agent+task (客户端靠它认领是哪一刀),
//       必须带 thinking_chars 和 tools (客户端靠它显示"它在动 + 它在调什么")。
//       载荷缺一个, 客户端就退化回"只显示运行中" —— 那正是当年"跟死了一样"的来源。
//   · T4 (SubAgentPanel 组件渲染) / T6 (卡片首行 knifeLabel)
//     —— 纯界面层, 随 apps/desktop 一起下线, 删。
'use strict';
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('T1 DAG 派发路径必须发真正的 sub_agent_start, 不能只发 status', () => {
  // 2026-10-17: 派发拆进了两个文件 —— fixed_flow 那条 status 留在 j2_dispatcher,
  // **DAG 那条搬进了 subagent_runner**。而这次 bug (整轮 0 张卡) 恰恰出在 DAG 上,
  // 所以两个文件都得查: 只查 dispatcher 等于把出问题的那条路径漏出守卫。
  for (const f of ['core/modules/j2_dispatcher.js', 'core/modules/subagent_runner.js']) {
    const src = read(f);
    // 那条只发 status 的行是本 bug 的原位
    const statusOnly = src.match(
      /safeResWrite\(res,\s*'status',\s*\{[^}]*stage:\s*'sub_agent_start'[^}]*\}\)\s*;/g) || [];
    assert.ok(statusOnly.length >= 1, f + ': 应该能找到这条 status 派发 (本测试锚定它)');
    // 在每一条 status{stage:sub_agent_start} 之后不远处必须有真事件
    for (const line of statusOnly) {
      const at = src.indexOf(line);
      // 窗口从 900 放宽到 1400: 2026-10-17 派发搬进 subagent_runner 时, 这两行之间
      // 多了一段现场取证注释, 距离从 854 涨到 880 —— 差 15 个字符过不了 900 的窗。
      // 放宽的只是**字符距离**, "真事件必须紧跟在 status 之后"这个本意一个字没松;
      // 真正的回归 (status 后面什么都没有) 仍然是几百上千字符的量级, 照样打红。
      const window = src.slice(at, at + 1400);
      assert.ok(window.includes("safeResWrite(res, 'sub_agent_start'"),
        f + ': 每条 status{stage:sub_agent_start} 后面都必须跟一条真 sub_agent_start 事件, '
        + '否则前端永远建不出卡片 (现场两轮实测 0 条真事件)');
    }
  }
});

test('T2 服务端事件必须带 agent+task —— 客户端靠它认领是哪一刀', () => {
  // 只按 agent 认领的话, 第一个 analyzer 收工会把三张并行卡一起标成完成。
  // **认领规则是客户端的事, 但载荷是服务端的事** —— 载荷缺 task, 客户端无从认领。
  const DISP = read('core/modules/j2_dispatcher.js');
  const RUN = read('core/modules/subagent_runner.js');
  // dispatcher 侧的三个事件
  for (const ev of ['sub_agent_start', 'sub_agent_done', 'sub_agent_error']) {
    const m = DISP.match(new RegExp("safeResWrite\\(res, '" + ev + "', \\{[^}]*"));
    assert.ok(m, 'dispatcher: 找不到 ' + ev + ' 的发射点');
    assert.ok(/agent:/.test(m[0]), ev + ' 必须带 agent');
    assert.ok(/task:/.test(m[0]), ev + ' 必须带 task —— 没有它三张并行卡认不出来');
  }
  // runner 侧: done/error 共用一段 (事件名是变量 _doneEvt), 载荷一样带 agent+task
  const runDone = RUN.match(/safeResWrite\(res, _doneEvt, \{[^}]*/);
  assert.ok(runDone, 'runner: 找不到收口事件的发射点');
  assert.ok(/agent:/.test(runDone[0]), 'sub_agent_done/error 必须带 agent');
  assert.ok(/task:/.test(runDone[0]), 'sub_agent_done/error 必须带 task');
  const runErr = RUN.match(/safeResWrite\(res, 'sub_agent_error', \{[^}]*/);
  assert.ok(runErr, 'runner: 找不到 sub_agent_error 的发射点');
  assert.ok(/agent:/.test(runErr[0]) && /task:/.test(runErr[0]),
    'sub_agent_error 必须带 agent + task');
});

test('T3 sub_agent_progress 必须带 thinking_chars 与 tools —— 否则工具调用永远看不见', () => {
  // 服务端一直发着 thinking_chars/tools, 载荷缺了客户端就只能显示"运行中",
  // 这正是"调用有没有用工具完全不知道"的来源。
  const src = read('core/modules/subagent_runner.js');
  assert.ok(src.includes("event: sub_agent_progress"),
    '服务端必须发 sub_agent_progress');
  assert.ok(/thinking_chars/.test(src),
    'sub_agent_progress 必须带 thinking_chars —— 客户端靠它显示"思考中 N 字"');
  assert.ok(/tools:\s*names/.test(src),
    'sub_agent_progress 必须带 tools —— 客户端靠它列出调过的工具');
});

test('T5 j2 路径的工具活动必须穿透 —— 子 agent 真的调了工具, 界面上却一个名字都没有', () => {
  // 2026-10-17: batch_complete → sub_agent_progress 这段转换随 sink 一起搬进了
  // subagent_runner (主 agent 复用同一份派发)。守卫本意一字未动, 只换读哪个文件。
  const src = read('core/modules/subagent_runner.js');
  // 现场 card-1792148760918: 服务端 [j2-batch] tool_start: read_file ×3 且 ok=true,
  // 但整轮 365 条 sub_agent_progress 里带 tools 的 = 0 条。
  assert.ok(src.includes("d.startsWith('event: batch_complete')"),
    "DAG 子 agent 走 j2_agent_loop, 工具活动落在 event: batch_complete 里, "
    + "穿透白名单没放行它 → 卡片只有'运行中', 一个工具名都没有");
  assert.ok(/stage:\s*'tool_executed'/.test(src),
    'batch_complete 必须转成带 agent 归属的 sub_agent_progress(stage=tool_executed)');
  assert.ok(/tool_names/.test(src), '要取 batch_complete 里的 tool_names');
  // 只透名字, 不透结果 —— 工具结果可能含文件内容
  const block = src.slice(src.indexOf("event: batch_complete"), src.indexOf("event: batch_complete") + 1200);
  assert.ok(!/toolResults|tool_results|\.data\b/.test(block),
    '只许透工具名, 不许把工具结果 (可能含文件内容) 发到前端');
});

