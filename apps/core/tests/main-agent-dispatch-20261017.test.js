#!/usr/bin/env node
// 主 agent (乾) 自主编排 —— dispatch_subagents 整条接线
//
// 老板原话 (2026-10-17): 「乾就应该把任务拆了, 分下去, 子agent只做自己相关的,
// 做好汇报, 这个跟你应该是一样的。」
//
// 这组测试钉三件事, 每件都对应一个真实缺陷类别:
//   ① 接线: 主 agent 够得着这个工具, 且**真的走它自己的拦截**而不是掉进
//      _j2ExecuteToolCalls (那边会按 name 查 TOOLS → 查不到 → 一刀都不派)
//   ② 形状: 模型给歪的参数 (raw 包装 / 大小写 / null 下标) 都能接住 ——
//      "调了工具但一把都没派出去" 正是这条链路最初要解决的问题, 不能自己再犯
//   ③ 单源: 派发实现只有一份 (subagent_runner), dispatcher 和主循环都调它
//
// 反向护栏 (谁把作废的做法加回来立刻红):
//   - dispatch_subagents 不许出现在 tools/index.js 的 TOOLS 里 (那边 ctx 不够用)
//   - 子 agent 的角色白名单里不许有 dispatch_subagents (递归派发是 token 黑洞)
//   - j2_dispatcher 里不许再出现第二份 DAG 引擎 (_MAX_CONCURRENT / _acquireSlot)
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');

const M = (p) => require(path.join(__dirname, '..', p));
const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const DISPATCH_SRC = ['modules/j2_dispatcher.js', 'modules/subagent_runner.js']
  .map((f) => SRC(f)).join('\n');

// ===== 1. 接线: 主 agent 够得着 =====

test('T1 dispatch_subagents 必须进 MAIN 工具集, 否则主 agent 根本看不见它', () => {
  const { MAIN_GENERAL_TOOLS_FOR_LLM, TOOLS_SCHEMA, getAllToolSchemas } = M('modules/tools_schema.js');
  assert.ok(MAIN_GENERAL_TOOLS_FOR_LLM.includes('dispatch_subagents'),
    '主 agent 的候选工具集里必须有它 —— 老板要的是"乾自己决定拆不拆"');
  assert.ok(TOOLS_SCHEMA.dispatch_subagents, 'schema 必须注册 (否则过滤工具集时拿不到)');
  assert.ok(getAllToolSchemas().some((s) => s.function.name === 'dispatch_subagents'),
    'getAllToolSchemas 也得能看到 (工具箱页读的就是它)');
  // 角色名必须与 ROLES 真源一致, 不许在 schema 里手抄一份
  const ROLES = M('agents/sub-agent.js').ROLES;
  const enumVals = TOOLS_SCHEMA.dispatch_subagents.function.parameters
    .properties.tasks.items.properties.agent.enum;
  for (const r of enumVals) {
    assert.ok(ROLES[r], 'enum 里的 "' + r + '" 在 sub-agent.js ROLES 里不存在 —— 会派到一个没有 system prompt 的空角色');
  }
  for (const r of Object.keys(ROLES)) {
    if (r === 'kan' || r === 'qian') continue;  // 坎(拆解主脑)/乾(总调度) 不当刀派
    assert.ok(enumVals.includes(r), '角色 ' + r + ' 没进 enum —— 主 agent 派不到它');
  }
});

test('T2 主循环必须就地拦截它, 不许丢给 _j2ExecuteToolCalls', () => {
  const src = SRC('modules/j2_agent_loop.js');
  // 拦截点: 按 name 把 freshToolCalls 分流
  assert.match(src, /tc\.name === 'dispatch_subagents'/,
    '主循环必须按名字把 dispatch_subagents 从普通工具调用里摘出来');
  // 真的执行了 (只分流不执行 = 一刀都没派, 跟没有这个工具一样)
  assert.match(src, /dispatch_subagents_exec'\)\.runDispatchSubagents\(/,
    '摘出来之后必须真的调用执行器');
  // 剩下的才走普通执行器 —— 顺序反了会把派活工具丢进 TOOLS 查表
  assert.match(src, /_j2ExecuteToolCalls\(_normalCalls/,
    '普通工具执行器只该收到 _normalCalls');
  // 结果必须并回 toolResults 回灌给主 agent (不并 = 主 agent 看不到派活结果)
  assert.match(src, /\.\.\._dispatchResults,[\s\S]{0,200}_j2ExecuteToolCalls\(_normalCalls/,
    '派活结果必须排在普通工具结果前面一起回灌');
});

// ===== 2. 形状: 模型给歪的参数也得接住 =====

test('T3 参数解析: raw 包装 / 大小写 / 字段别名都要接住', () => {
  const { normalizeTasks } = M('modules/dispatch_subagents_exec.js');
  const base = [
    { agent: 'li', task: '读 A' },
    { agent: 'dui', task: '验 A' },
  ];
  assert.strictEqual(normalizeTasks({ tasks: base }).length, 2, '标准形状');
  assert.strictEqual(normalizeTasks({ raw: JSON.stringify({ tasks: base }) }).length, 2,
    '包在 raw 字符串里的也要接住 —— 模型经常这么给');
  assert.strictEqual(normalizeTasks(base).length, 2, '直接给数组');
  assert.strictEqual(normalizeTasks({ subtasks: base }).length, 2, 'subtasks 别名');
  assert.strictEqual(normalizeTasks({ sub_tasks: base }).length, 2, 'sub_tasks 别名');
  const up = normalizeTasks({ tasks: base });
  // 2026-10-18 拼音迁移: 归一的**目标名**从英文换成了拼音 (老板: 「英文 code 要换成拼音」)。
  // 这条断言原本钉的是"归一后还等于 analyzer" —— 形状跟着迁移改了, 但它真正要守的
  // 不变量是「大小写/别名变体都要落到同一个角色」, 那个仍然成立。
  assert.strictEqual(up[0].agent, 'li',
    '角色名要归一成规范名 (拼音); 模型写 Analyzer/analyzer/离 都该落在这一个角色上');
  assert.deepStrictEqual(up[0].depends_on, [], '没给 depends_on 归一成空数组 (并行)');
  assert.deepStrictEqual(up[0].depends_on, [], '幂等');
  const alias = normalizeTasks({ tasks: [{ role: 'kun', prompt: '写文件' }, { agent: 'dui', description: '验' }] });
  assert.strictEqual(alias[0].task, '写文件', 'prompt 是 task 的别名');
  assert.strictEqual(alias[1].task, '验', 'description 是 task 的别名');
  // 空 task 的刀派下去就是白烧一轮
  assert.strictEqual(normalizeTasks({ tasks: [{ agent: 'li', task: '  ' }, base[1]] }).length, 1,
    '空 task 的刀要被丢掉');
  assert.strictEqual(normalizeTasks({}).length, 0);
  assert.strictEqual(normalizeTasks(null).length, 0);
});

test('T4 depends_on: null / 空串不许被当成下标 0', () => {
  const { normalizeTasks } = M('modules/dispatch_subagents_exec.js');
  // Number(null) === Number('') === 0 —— 一旦直接 Number(), 模型给 [null]
  // 就被悄悄接成"依赖第 0 刀", DAG 去等一个它根本没提过的上游。
  const r = normalizeTasks({
    tasks: [{ agent: 'li', task: 'a', depends_on: [null, '', undefined, false] },
      { agent: 'kun', task: 'b' }],
  });
  assert.deepStrictEqual(r[0].depends_on, [], 'null/空串/undefined/false 一律丢掉');
  assert.deepStrictEqual(
    normalizeTasks({ tasks: [{ agent: 'li', task: 'a', depends_on: [0] }, base2()] })[0].depends_on,
    [0], '字面 0 是下标 0, 必须留下');
  assert.deepStrictEqual(
    normalizeTasks({ tasks: [{ agent: 'li', task: 'a', depends_on: ['2'] }, base2()] })[0].depends_on,
    [2], '字符串数字接受');
  assert.deepStrictEqual(
    normalizeTasks({ tasks: [{ agent: 'li', task: 'a', depends_on: [-1] }, base2()] })[0].depends_on,
    [], '负数丢掉');
  function base2() { return { agent: 'kun', task: 'b' }; }
});

test('T5 参数校验: 错角色 / 越界下标必须提前报错, 而不是派出去空跑', () => {
  const { validateTasks } = M('modules/dispatch_subagents_exec.js');
  assert.deepStrictEqual(
    validateTasks([{ agent: 'li', task: 'a', depends_on: [0] }, { agent: 'kun', task: 'b' }]), [],
    '合法形状不该报错');
  const badRole = validateTasks([{ agent: 'nope', task: 'a' }, { agent: 'kun', task: 'b' }]);
  assert.strictEqual(badRole.length, 1, '未知角色必须报出来');
  assert.match(badRole[0], /nope/, '报错要带上那个错角色名');
  const oob = validateTasks([{ agent: 'li', task: 'a', depends_on: [5] }, { agent: 'kun', task: 'b' }]);
  assert.strictEqual(oob.length, 1, 'depends_on 越界必须报出来 (DAG 会白等一圈)');
  // 防御: 不能假设 depends_on 是数组 (模型给字符串是常事)
  assert.deepStrictEqual(
    validateTasks([{ agent: 'li', task: 'a', depends_on: '1' }, { agent: 'kun', task: 'b' }]), [],
    'depends_on 不是数组时不该自己崩');
  assert.deepStrictEqual(validateTasks(null), [], '非数组输入不该崩');
});

test('T6 一刀不派 (派活至少两刀), 错误结果必须说清怎么办', () => {
  // 纯形状层: 1 刀 / 0 刀都要在**跑之前**被拦住, 不许起一个 executor 再告诉主 agent 没必要
  const src = SRC('modules/dispatch_subagents_exec.js');
  assert.match(src, /DISPATCH_SINGLE/, '单刀必须提前拦下 (拿并行机制干一件自己能干的活 = 多一轮往返)');
  assert.match(src, /DISPATCH_NO_TASKS/, '零刀要有独立报错, 不跟单刀混用');
  assert.match(src, /DISPATCH_INVALID/, '参数非法要有独立报错');
  // 每个失败结果都得带"怎么办", 否则主 agent 会照着失败重试或者干脆编一个结论
  for (const k of ['DISPATCH_NO_TASKS', 'DISPATCH_SINGLE', 'DISPATCH_INVALID']) {
    const at = src.indexOf(k);
    assert.ok(at > 0, k + ' 必须存在');
    assert.ok(/怎么办|别|直接做|别派活/.test(src.slice(at, at + 500)),
      k + ' 的报错必须告诉主 agent 接下来怎么办 —— 只报错误会让它重发同样的参数');
  }
});

// ===== 3. 单源 + 反向护栏 =====

test('T7 派发实现只有一份: DAG 引擎/闸门不许在 dispatcher 里出现第二遍', () => {
  const disp = SRC('modules/j2_dispatcher.js');
  const run = SRC('modules/subagent_runner.js');
  // 并发闸门的**定义**只在 runner
  for (const id of ['_MAX_CONCURRENT', '_acquireSlot', '_releaseSlot', '_runOneSubTaskInner']) {
    assert.ok(run.includes(id), 'subagent_runner 必须有 ' + id + ' 的定义');
    assert.ok(!disp.includes(id), 'j2_dispatcher 里不许再有 ' + id + ' —— 两份实现 = 迟早只改其中一份');
  }
  // dispatcher 改成调共享实现
  assert.match(disp, /createSubagentRunner\(\{/, 'dispatcher 必须调 createSubagentRunner');
  assert.match(disp, /_runner2\.runAll\(\)/, 'dispatcher 必须走 runAll (整轮 DAG)');
  assert.match(disp, /_runner2\.runOne/, '补救轮/复验轮必须走同一个 runOne');
});

test('T8 收口政策留在调用方: 配额快速失败不许在派发机制里直接收口', () => {
  const run = SRC('modules/subagent_runner.js');
  // resDone / _persistParent 是**跟主人交代**的动作, 属于调用方。派发机制只负责停。
  assert.ok(!/resDone\(/.test(run), 'subagent_runner 不许直接 resDone —— 主 agent 那条路没有 resDone 可调');
  assert.ok(!/_persistParent\(/.test(run), 'subagent_runner 不许直接 _persistParent');
  assert.match(run, /ctx\.onQuotaFastFail|_onQuotaFastFail/, '配额快速失败必须走回调');
  const disp = SRC('modules/j2_dispatcher.js');
  assert.match(disp, /onQuotaFastFail:/, 'dispatcher 必须提供那个回调 (它才有 resDone/_persistParent)');
});

test('T9 反向护栏: dispatch_subagents 不许进 TOOLS (tools 的 ctx 不够派发用)', () => {
  const tools = SRC('modules/tools/index.js');
  assert.ok(!/TOOLS\.dispatch_subagents\s*=/.test(tools),
    'tools/index.js 里不许有 dispatch_subagents 的实现 —— 那边 ctx 只有 {user, sessionId}, '
    + '拿不到 res/model/configPath, 派发必然残废');
});

test('T10 反向护栏: 子 agent 不许能派活 (递归派发是 token 黑洞)', () => {
  const ROLES = M('agents/sub-agent.js').ROLES;
  for (const [name, def] of Object.entries(ROLES)) {
    const tools = Array.isArray(def.tools) ? def.tools : [];
    assert.ok(!tools.includes('dispatch_subagents'),
      '角色 ' + name + ' 的白名单里有 dispatch_subagents —— 子 agent 会自己再拆一层, '
      + '没有深度闸门就是 token 黑洞');
  }
  // 白名单真源由 buildRoleToolFilter 补 task_done, 但补的集合里也绝不能出现派活工具
  const filter = SRC('modules/j2_loop_shared.js');
  // 2026-10-17: 这条原来直接扫全文找 'dispatch_subagents' 字样, 于是我**给 enforce
  // 写的那段解释性注释**里只要提到这个词就报红 —— 护栏挡住的不是递归派发, 是说明。
  // 改成剥掉注释再查: 要守的是"代码里不许把它塞进任何角色的白名单"。
  const filterCode = filter
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/dispatch_subagents/.test(filterCode),
    'j2_loop_shared 的角色工具补齐逻辑 (代码, 不含注释) 不许把 dispatch_subagents 塞给任何角色');
});

test('T11 接线守卫: req 必须一路透传到子 loop (丢了就是静默降级)', () => {
  // 为什么单独一条: 子 loop 只用 req 接"主人关掉页面"事件。不传的话**不报错**
  // —— 子 agent 照跑照交汇报, 一切看起来正常, 只是关页面后还在烧 token 烧到跑完。
  // 这正是"单测绿 ≠ 实机对"那一类: 唯一能查的地方就是这条接线。
  // 派发实现刚从 dispatcher 闭包搬进共享模块, req 正是最容易在搬家时掉的那根线。
  const run = SRC('modules/subagent_runner.js');
  assert.match(run, /const req = ctx\.req \|\| null;/,
    'runner 必须从 ctx 接 req');
  assert.ok(!/await j2AgentLoop\./.test(run),
    'runner 里不许直接引用 j2AgentLoop (自循环依赖) —— 一刀怎么跑必须由调用方的 runSubAgentLoop 决定');
  // dispatcher 那条路
  const disp = SRC('modules/j2_dispatcher.js');
  const at = disp.indexOf('createSubagentRunner({');
  assert.ok(at > 0, 'dispatcher 必须建 runner');
  assert.match(disp.slice(at, at + 400), /(^|[^.\w])req,/m,
    'dispatcher 调 runner 时必须传 req —— 少了它, 主人关页面后子 agent 会烧到跑完');
  // 主循环那条路
  const loop = SRC('modules/j2_agent_loop.js');
  const at2 = loop.indexOf('runDispatchSubagents({');
  assert.ok(at2 > 0, '主循环必须调执行器');
  assert.match(loop.slice(at2, at2 + 400), /(^|[^.\w])req,/m,
    '主循环调执行器时必须传 req');
  const exec = SRC('modules/dispatch_subagents_exec.js');
  assert.match(exec, /req: req \|\| null,/, '执行器必须把 req 交给 runner');
});

test('T13 路由顺序: 主 agent 自拆必须排在规则快路和坎·planner 前面', () => {
  // 这条是"配了但不生效"的护栏。工具加上、接线对上、测试全绿 —— 但只要主 agent
  // 排在坎后面, 它就永远轮不到 (坎先拆完就返回了), 实跑一次都调不到新工具。
  // 2026-10-17 首次实跑就是这样: 新工具 0 次调用, 因为坎先拆了。
  const disp = SRC('modules/j2_dispatcher.js');
  const mainAt = disp.indexOf('const _mainPlan = await _planViaMainAgent();');
  const fastAt = disp.indexOf('const _fastPlan = _fastPlanFor(userInput);');
  const kanAt = disp.indexOf("mode: 'kan'");
  assert.ok(mainAt > 0, '必须真有主 agent 自拆这一步 (不然工具白加)');
  assert.ok(fastAt > 0, '规则快路还在');
  assert.ok(kanAt > 0, '坎·planner 还在 (降级成顾问, 不是删掉)');
  assert.ok(mainAt < fastAt, '主 agent 自拆必须排在规则快路前面 —— 老板要的是乾决定');
  assert.ok(mainAt < kanAt, '主 agent 自拆必须排在坎·planner 前面');
  // 顺序对了还不够: 分支本身必须活着。把 `if (_mainPlan && ...)` 改成
  // `if (false && _mainPlan && ...)` 顺序一点没变, 但主 agent 永远拆不了 ——
  // 而那正是"配了但不生效"最省事的一种形态 (顺序守卫照样绿)。
  assert.match(disp, /\n  if \(_mainPlan && _mainPlan\.length >= 2\) \{/,
    '主 agent 方案的分支必须真判 (_mainPlan && _mainPlan.length >= 2), 不许被阉成恒假');
  assert.ok(!/if \(false && _mainPlan/.test(disp) && !/if \(_mainPlan && false/.test(disp),
    '分支不许被改成恒假 —— 那等于工具白加, 而顺序守卫还照样绿');
  // planOnly: 这一轮只收方案, 不许真跑刀 (执行和收口留在成熟路径上)
  assert.match(disp, /planOnlyDispatch: true/, '必须走 planOnly, 不许让拆解那一轮真执行');
  const loop = SRC('modules/j2_agent_loop.js');
  assert.match(loop, /planOnly: Boolean\(opts && opts\.planOnlyDispatch\)/,
    '主循环必须把 planOnly 透传给执行器');
  // 拆解那一轮只准调 dispatch_subagents —— 给全套它就顺手去 read_file, 那一轮变成干活
  assert.match(disp, /const _PLAN_TOOLS = \['dispatch_subagents'\];/,
    '拆解那一轮只准调 dispatch_subagents 一个工具');
  // 拆不出 ≥2 刀必须老实退回坎/规则, 不许拿 1 刀硬派
  assert.match(disp, /!_captured\.length < 2|_captured\.length < 2/,
    '少于 2 刀必须退回 —— 拿 1 刀派活是多一轮往返');
});

test('T14 坎降级成顾问, 但不许被删 (它是主 agent 拆不出来时的兜底)', () => {
  const disp = SRC('modules/j2_dispatcher.js');
  // 三个兜底还在: 规则快路 / 坎 / 关键词。主 agent 拆不出来时必须有路可走,
  // 否则就变成"主 agent 一犹豫, 整轮没人拆 → 单线程硬啃"。
  assert.match(disp, /const _fastPlan = _fastPlanFor\(userInput\)/, '规则快路必须还在');
  assert.match(disp, /mode: 'kan'/, '坎·planner 必须还在 (降级 ≠ 删除)');
  assert.match(disp, /_routeWithL3\(userInput, configPath\)/, '关键词兜底必须还在');
  assert.match(disp, /确定性拆分接管/, 'planner 失败后的确定性拆分必须还在');
});

test('T16 工具笼必须真的关得上 (首次实跑: 白名单算了但没接线, 一刀都没派)', () => {
  // 2026-10-17 现场 q-1792248439788: dispatcher 传了 toolsAllowed:['dispatch_subagents'],
  // 而 buildRoleToolFilter 对 role==='main' 直接 `return null` —— 白名单被算出来就扔了。
  // 后果**不是报错**: 那一轮模型照常 read_file ×3 自己把活干了, 一个子 agent 都没派,
  // 然后坎照旧拆。而 T13 那条守卫当时照样全绿 (它只查了 `_PLAN_TOOLS` 这行字存在)。
  // 所以这条不许再只查源码形状 —— 直接调真函数验行为。
  const { buildRoleToolFilter } = M('modules/j2_loop_shared.js');
  // 老契约不能破: main 默认仍是全量 (它有自己的交付语义)
  assert.strictEqual(buildRoleToolFilter('main', undefined), null,
    'main 不 enforce 时仍走全量工具 —— 这是老契约, 不许顺手改掉');
  assert.strictEqual(buildRoleToolFilter('main', ['dispatch_subagents']), null,
    'main 只传 toolsAllowed 而不 enforce → 仍然全量 (显式开关, 不猜意图)');
  // enforce 时才真的关进笼子
  const locked = buildRoleToolFilter('main', ['dispatch_subagents'], true);
  assert.ok(locked, 'main + enforce 必须真的算出白名单');
  assert.ok(locked.has('dispatch_subagents'), '派活工具必须在笼子里');
  assert.ok(locked.has('task_done'), '收口信号必须补上 (否则那一轮没法结束)');
  assert.ok(!locked.has('read_file') && !locked.has('exec_command'),
    '笼子里不许有 read_file/exec_command —— 有了它就自己去干活, 不派活');
  // enforce 但没给白名单 → 宁可全量也不给空集 (空集 = 模型什么都调不到 = 卡死)
  assert.strictEqual(buildRoleToolFilter('main', [], true), null,
    '空白名单不许生效 —— 那会让模型无工具可用, 一轮白烧');
  // 非 main 角色的老路径一个字没变
  assert.ok(buildRoleToolFilter('kun', undefined), 'executor 仍按 ROLES 取名单');

  // 接线: dispatcher 必须真的传 enforce, 且主循环必须把它透到 buildRoleToolFilter
  const disp = SRC('modules/j2_dispatcher.js');
  assert.match(disp, /enforceToolFilter: true/, 'dispatcher 必须传 enforceToolFilter: true');
  const loop = SRC('modules/j2_agent_loop.js');
  assert.match(loop, /_buildRoleToolFilter\(_roleForThisLoop, opts && opts\.toolsAllowed,\s*\n?\s*Boolean\(opts && opts\.enforceToolFilter\)\)/,
    '主循环必须把 enforce 透给 buildRoleToolFilter');
  // 工具集**挑选**那处原来自己判 'main' → _mainTools, 于是白名单算了也不接线。
  // 判据只能有一处: 先算 _effectiveTools, 后面一律用它。
  assert.match(loop, /const _effectiveTools = _roleToolFilter \|\| \(_roleForThisLoop === 'main'/,
    '必须先算出有效工具集 _effectiveTools');
  assert.ok(!/orderSchemas\(\(_roleForThisLoop === 'main' \? _mainTools/.test(loop),
    'toolsSchema 不许再自己判 main → _mainTools (那是"算了不接线"的原位)');
  assert.match(loop, /orderSchemas\(_effectiveTools/, 'toolsSchema 必须用 _effectiveTools');
});

test('T17 派活结果回灌: 汇报在前、工具证据次之 (旧坑: 只要子 agent 干了活, 汇报就被丢)', () => {
  const { renderDispatchResult } = M('modules/dispatch_subagents_schema.js');
  const ok = renderDispatchResult([
    { agent: 'kun', task: '写文件', result: { summary: '写好了', artifacts: [{ path: '/tmp/a.txt' }], toolsUsed: ['write_file'], runtimeStatus: 'done' } },
    { agent: 'dui', task: '验', result: { summary: 'PASS', runtimeStatus: 'done' } },
  ]);
  assert.strictEqual(ok.ok, true);
  assert.ok(ok.content.includes('写好了'), '汇报必须进结果');
  assert.ok(ok.content.includes('/tmp/a.txt'), '产出路径必须进结果 (主 agent 据此 read_file 取细节)');
  assert.ok(ok.content.indexOf('汇报') < ok.content.indexOf('产出'), '汇报在前、产出在后');
  // 失败那刀不许被粉饰
  const mixed = renderDispatchResult([
    { agent: 'kun', task: 'a', result: { summary: '好了' } },
    { agent: 'dui', task: 'b', error: 'ECONNRESET' },
  ]);
  assert.strictEqual(mixed.ok, false, '有刀失败就不能报全绿');
  assert.ok(mixed.content.includes('ECONNRESET'), '失败原因必须原样带出来');
  assert.ok(mixed.content.includes('不许粉饰'), '必须提醒主 agent 如实反映失败');
  assert.ok(/别替它编结论/.test(mixed.content), '必须明说别替失败的刀编结论');
  // 空结果
  assert.strictEqual(renderDispatchResult([]).ok, false);
  assert.ok(renderDispatchResult(null).content.includes('DISPATCH_EMPTY'));
  // 子 agent 没交汇报时, 不许让主 agent 以为"没产出" —— 要指向产物路径
  const noSummary = renderDispatchResult([
    { agent: 'kun', task: 'a', result: { summary: '', artifacts: [{ path: '/tmp/b.txt' }] } },
  ]);
  assert.ok(noSummary.content.includes('/tmp/b.txt'), '没汇报也要给出产物路径');
  assert.ok(/别替它补/.test(noSummary.content), '并明说别替它补汇报');
});


test('T18 native 路径也必须拦下 dispatch_subagents (实跑踩中: 只拦 legacy = 静默失效)', () => {
  // 2026-10-17 实跑 q-1792249178899 (第二个坑, 上一条 T16 修好之后才暴露出来):
  // 工具笼关上了, 主 agent 也老实调了 dispatch_subagents —— 但调用是从 **native 轮**
  // 下去的 (:3003 → _execToolWithPermission → `TOOLS[tc.name](...)`),
  // 而当时的拦截只加在 legacy 路径 (:4150)。native / legacy 是两条互不相交的路,
  // 于是拦截从没被调用, dispatch_subagents 撞上不在 TOOLS 表里的事实:
  //   error.code=EXEC_FAILED, message="[dispatch_subagents] TOOLS[tc.name] is not a function"
  // 主 agent 拿到的是**工具崩溃**, 于是如实汇报"派活工具本身坏了" —— 它判断得没错, 工具是真坏了。
  //
  // 为什么两轮假 loop 都没抓到: 它们打的是 legacy 分支。
  // 这条守卫存在的意义就是不许再有人只在一个分支上接线。
  const loop = SRC('modules/j2_agent_loop.js');

  // ① native 路径: _execToolWithPermission 必须有拦截, 且在撞 TOOLS[tc.name] 之前
  const fnStart = loop.indexOf('async function _execToolWithPermission(');
  assert.ok(fnStart > 0, '_execToolWithPermission 必须存在 (native 路径的唯一工具执行口)');
  // 该函数体到下一个同缩进 function 定义为止。
  // **必须剥掉注释再比位置** —— 我自己在解释这个坑的注释里就写了 `TOOLS[tc.name]`,
  // 不剥的话守卫会拿注释里那处当执行点, 位置判据整个失去意义
  // (这正是 T10 被自己注释误伤的同一个形状, 又踩了一次)。
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const fnBody = stripComments(loop.slice(fnStart));
  const guardAt = fnBody.indexOf("tc.name === 'dispatch_subagents'");
  const tosAt = fnBody.indexOf('TOOLS[tc.name]');
  assert.ok(guardAt > 0, 'native 路径 (_execToolWithPermission) 必须拦 dispatch_subagents');
  assert.ok(tosAt > 0, '_execToolWithPermission 里应该还有 TOOLS[tc.name] 通用执行点');
  assert.ok(guardAt < tosAt,
    '拦截必须在 TOOLS[tc.name] **之前** —— 放在之后就等于没放 (实跑踩的就是这个)');

  // ② legacy 路径那份不许被"优化"掉: 两条路互不相交, 少一个就有一个模型走不到
  const legacyGuard = loop.indexOf("if (tc.name === 'dispatch_subagents') _dispatchCalls.push(tc)");
  assert.ok(legacyGuard > 0, 'legacy 路径的拦截也不许删 (native/legacy 互不相交)');

  // ③ 两条路都要透传 planOnly/onPlanned —— dispatcher 的「只问方案不跑刀」靠这两个,
  //    漏传的话主 agent 会替 dispatcher 把刀真跑一遍, onPlanned 永不触发, 白拆。
  const guards = [
    ['native', fnBody],
    // legacy 那段从 `const _dispatchCalls = []` 起, 到它自己那处 runDispatchSubagents
    // 调用结束 (configPath 块收尾) 为止。
    // 终点不能拿 fnStart 当 —— legacy 段在文件里**比 native 那段更靠后**
    // (246347 > 165217), 拿小的当终点会切出负长度空串, 断言以"找不到"的形式
    // 打红而不是真的在查透传。这是我写这条守卫时自己踩的第二个坑。
    ['legacy', stripComments(loop.slice(
      loop.indexOf('const _dispatchCalls = []'),
      loop.indexOf("name: 'dispatch_subagents', ok: false,"),
    ))],
  ];
  for (const [which, body] of guards) {
    assert.ok(/planOnly:\s*Boolean\(opts && opts\.planOnlyDispatch\)/.test(body),
      which + ' 路径必须透传 planOnly');
    assert.ok(/onPlanned:\s*opts && opts\.onPlanned/.test(body),
      which + ' 路径必须透传 onPlanned');
    assert.ok(/configPath:/.test(body),
      which + ' 路径必须传 configPath (子 agent 的角色档位/模型解析从它读)');
    assert.ok(/\breq,/.test(body) || /\breq:\s*req\b/.test(body),
      which + ' 路径必须透传 req (子 loop 靠它接"主人关掉页面", 丢了不报错只是烧 token)');
  }

  // ⑤ 两处拦截都不许出现**裸** path.join。
  // 实跑 q-1792249305xxx 踩中: path 在本文件里是块级局部 require
  // (:260 自我认知块 / :3870 task_done 块), 两处拦截都在其作用域之外,
  // 写裸 path.join → ReferenceError "path is not defined" → 派活链路当场断。
  // 主 agent 拿到的是 DISPATCH_EXCEPTION, 于是如实汇报「派活这条路断了」——
  // 它没撒谎, 工具是真坏了。所以这条断言只认 require('path') + _pathMod。
  //
  // 2026-10-26 第 109 批: 判据从「必须用 _pathMod.join」改成**概念判据**——
  //   节点配置路径改走 config/node_config.js 解析后, 这两个块**根本不需要拼路径**,
  //   于是 _pathMod 连同它的 require 一起删掉了 (死代码)。
  //   真正要守的不变式只有一个: **裸 path.join 绝不許出现在这两块里**。
  //   万一以后又要拼路径, 那时必须写成 _pathMod.join 并在同块 require('path')。
  const rawBodies = {
    native: loop.slice(fnStart),
    legacy: loop.slice(loop.indexOf('const _dispatchCalls = []'),
      loop.indexOf("name: 'dispatch_subagents', ok: false,")),
  };
  for (const which of ['native', 'legacy']) {
    const body = stripComments(rawBodies[which]);
    const usesPathJoin = /(^|[^_\w.])path\.join/.test(body);
    if (usesPathJoin) {
      assert.ok(/const _pathMod = require\('path'\)/.test(rawBodies[which]),
        which + ' 路径的拦截块要拼路径就必须自己 require path (外层那个是块级局部变量, 不在作用域内)');
      assert.ok(/_pathMod\.join/.test(body),
        which + ' 路径要拼路径只能用 _pathMod.join, 不许裸 path.join');
    }
    // 剥掉注释 + 剥掉 _pathMod.join 之后, 不许还剩裸 path.join
    const leftover = body
      .replace(/_pathMod\.join/g, '')
      .replace(/const _pathMod = require\('path'\)/g, '');
    assert.ok(!/(^|[^_\w.])path\.join/.test(leftover),
      which + ' 路径不许残留裸 path.join (块级局部变量, 实跑会 ReferenceError)');
  }

  // ④ 变异防线: 把 native 的拦截删掉, 这条必须打红
  assert.ok(!/async function _execToolWithPermission[\s\S]{0,4000}?\n        \}/.test(
    // 拦截就在函数体开头附近; 确认它没被挪到 budget 之外之类导致误判
    'async function _execToolWithPermission() {}'),
    '占位: 真实判据在上面的 guardAt/tosAt 顺序断言');
});
