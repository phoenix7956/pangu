// 第 79 批: 单刀派活的判据 —— 从「刀数」换成「主 agent 自己能不能干」。
//
// 现场 (probe79-mcp 实测):
//   主 agent 派了一个**合法**的一刀 (kun 用 MCP 的 filesystem 工具读 IDENTITY.md),
//   撞上 DISPATCH_SINGLE ⇒ 白烧一轮本地推理 ⇒ 拿回一句「这不该派活」⇒
//   主 agent 改用 exec_command 自己干了。
//   闸门省下的往返并不存在 —— 它自己多造了一轮。
//
// 为什么原判据是错的 (它是个**代理**):
//   「刀数 ≥ 2」只在「主 agent 工具齐全」时才等价于「该不该派」。
//   而第 79 批刚定下「MCP 工具只给 worker, 不给 main」(main 一次拿到 44 个 MCP
//   工具会造成选择噪声, 实测 82 个工具那版模型一个工具都没调, success=false),
//   于是「派一刀去查 MCP」**天生就是单刀** —— 这道闸等于把 MCP 派活堵死了。
//   将灵专属工具 (web_fetch / weather_check / stock_quote / github_api …) 同理,
//   它们都不在 main 的 38 个里 (真源 MAIN_GENERAL_TOOLS_FOR_LLM)。
//
// 修法: 任务里点名了主 agent 调不到的工具 ⇒ 这一刀必须外包 ⇒ 放行;
//       点名的工具 main 也有 / 根本没点名 ⇒ 原来的纪律照旧 (自己干, 别派)。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const disp = require('../modules/dispatch_subagents_exec.js');
const CORE = path.join(__dirname, '..');

// planOnly: 只收方案, 一刀都不跑 —— 用它测**闸门**本身, 不碰模型。
async function gate(taskText, agent = 'kun') {
  const r = await disp.runDispatchSubagents({
    params: { tasks: [{ agent, task: taskText }] },
    planOnly: true,
    onPlanned: () => {},
  });
  return String(r.content || '');
}

test('① 单刀 + 点名 MCP 工具 ⇒ 放行 (主 agent 根本调不到 MCP)', async () => {
  const c = await gate('用 mcp__filesystem-mcp__read_text_file 读 /Users/you/Desktop/pangu/IDENTITY.md 的全文');
  assert.match(c, /PLAN_ONLY/, '这一刀点名的工具主 agent 自己调不到, 不该被拦: ' + c);
});

test('② 单刀 + 点名将灵专属工具 ⇒ 放行 (web_fetch 不在 main 的 38 个里)', async () => {
  const c = await gate('用 web_fetch 把 https://example.com 的正文抓回来');
  assert.match(c, /PLAN_ONLY/, 'web_fetch 只有 li 有, 这一刀该放行: ' + c);
});

test('③ 单刀 + 自己能干 ⇒ 仍然拦 (原来的纪律不许被拆掉)', async () => {
  const c = await gate('读一下 /tmp/x.txt 的内容, 顺便看看时间');
  assert.match(c, /DISPATCH_SINGLE/, '主 agent 自己能干的活不该外包: ' + c);
  // 报错必须告诉主 agent 接下来怎么办 (T6 钉着这条)
  assert.match(c, /怎么办|别|直接做/);
});

test('④ 点名的是 main 自己有的工具 ⇒ 照样拦 (别拿"我点了 read_file"当通行证)', async () => {
  const c = await gate('用 read_file 读 /tmp/x.txt');
  assert.match(c, /DISPATCH_SINGLE/, 'read_file main 自己就有, 这一刀该自己干: ' + c);
});

test('⑤ 判据函数本身: 认得"main 调不到"与"main 调得到"', () => {
  const need = disp._knifeNeedsToolMainLacks;
  assert.equal(typeof need, 'function', '判据必须导出 (别让测试去数源码字符)');
  assert.equal(need('用 mcp__filesystem-mcp__write_file 写点东西'), true);
  assert.equal(need('用 MCP 工具查一下'), true);
  assert.equal(need('用 web_fetch 抓网页'), true);
  assert.equal(need('用 stock_quote 查股价'), true);
  assert.equal(need('用 read_file 读文件'), false, 'read_file main 自己有');
  assert.equal(need('用 exec_command 跑个命令'), false, 'exec_command main 自己有');
  assert.equal(need('随便看看这个目录'), false);
  assert.equal(need(''), false);
});

test('⑥ ≥2 刀照旧放行 (这条没被改)', async () => {
  const r = await disp.runDispatchSubagents({
    params: { tasks: [{ agent: 'kun', task: 'a' }, { agent: 'li', task: 'b' }] },
    planOnly: true,
    onPlanned: () => {},
  });
  assert.match(String(r.content || ''), /PLAN_ONLY/);
});

test('⑦ 零刀照旧报错 (别跟单刀混用)', async () => {
  const r = await disp.runDispatchSubagents({ params: { tasks: [] }, planOnly: true });
  assert.match(String(r.content || ''), /DISPATCH_NO_TASKS/);
});

test('⑧ 判据必须落在真源表上 (不许把 main 的工具名单抄一份在别处)', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'dispatch_subagents_exec.js'), 'utf8');
  assert.match(src, /MAIN_GENERAL_TOOLS_FOR_LLM/,
    '判据必须用 MAIN_GENERAL_TOOLS_FOR_LLM 这份真源, 不许另抄一份名单 (两份迟早漂)');
  assert.match(src, /ROLES/,
    '将灵专属工具必须从 sub-agent.js 的 ROLES.tools 取');
});
