'use strict';
// 2026-10-13 soak-live-1791878006 现场 (长工作正面验收, 第 1 轮就翻了):
//
// 主人给的规格是「8 份文件, 每份内容必须与下面给的内容一致 (我会逐字核对)」+ 8 段原文。
// 盘古拆成 4 个子任务后:
//   1. [executor] 交代写着「必须严格使用主人给出的内容」—— 但**原文一个字都没传过去**,
//      于是 8 份文件写成了 `01_index` / `02_notes` 这种「文件名当内容」的占位串,
//      回头还给了个逐项 ✅ 的核对表 (全编的);
//   2. [checker] 交代写着「与主人给定的 8 份原始内容严格比对 (xxd 全文 hexdump)」——
//      同样没有原文, 于是报「PASS — 8/8 完全一致」;
//   3. 补救轮 executor 拿到「按主人逐字提供的原文逐一重写」—— 依旧没有原文, 自己编了内容
//      还写「全部完成, 无差异」。
//
// 根因: modules/j2_dispatcher._ownerScopeBlock —— 多子任务时**故意**只给路径,
// 「其他步骤的目标一句都不给」。防的是子 agent 越界抢别的步骤, 结果把「需求真源」也一起省了:
// 凡是「按主人给的原文」型规格, 子 agent 拿不到原文 = 只能编, 编完还说核对通过。
// 长工作做不完、子 agent 调用一直有问题, 这条是真凶之一。
//
// 本测试盯住: 多子任务派发时, 子任务文本必须带得上主人原文 (需求真源), 且不许丢掉
// 「只做你这一步」的边界 —— 两头都要, 不能为了修一个坑坏另一个坑。
const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../modules/j2_dispatcher');

const LONG_INPUT = '做一个 5 步计划并逐步执行: 1) 列出 /Users/you/Desktop/pangu/apps/core/modules 下所有 .js 文件; '
  + '2) 统计这些文件的总行数; 3) 找出其中超过 500 行的文件; 4) 读取其中最大的 3 个文件的头 30 行; '
  + '5) 把汇总写成 markdown 报告写到 /tmp/longtask_report_20261012.md。每一步都真实用工具做, 最后调 task_done 交付。';

const USER_INPUT = [
  '请真做一件事: 在 /tmp/pangu_soak_x/ 下逐个创建这 8 份文件, 每份内容必须与下面给的内容一致 (我会逐字核对):',
  '--- 01_index.md ---',
  '# 交付清单',
  '',
  '本批共 8 份交付物, 逐份回读核对。',
  '--- 05_snippet.js ---',
  'function panguSoak(n) {',
  '  return n * 2;',
  '}',
].join('\n');

// 现场 executor 的原话交代 (父会话派发记录里逐字抄的)
const SPEC_TASK = '在 /tmp/pangu_soak_x/ 下逐个创建 01_index.md … 08_final.md; '
  + '必须严格使用主人给出的内容, 包含原有换行, 不增删任何字符; 创建后逐个 cat 回读';


// 反向不变量: **不是**所有多子任务都给原文。2026-10-12 longtask-01 实案里 5 个 executor
// 因为都看见「写汇总报告」而抢同一个文件, 报告互相覆盖 → 交付 partial。
// 所以按需注入: 子任务没点名要主人原文, 就维持「只给路径锚 + 边界」。
test('步骤型任务不许注入主人原文 (2026-10-12 串味防线不许被这次修复带坏)', () => {
  const stepTask = '将文件清单、总行数、超过 500 行的文件、最大 3 个文件及其头 30 行汇总为 Markdown, '
    + '真实写入 /tmp/longtask_report_20261012.md; 写入后检查文件存在且内容完整';
  const block = d._ownerScopeBlock(LONG_INPUT, 5, stepTask);
  assert.ok(!block.includes('把汇总写成 markdown 报告'),
    '每个 executor 都看见「写汇总报告」→ 全去抢同一个文件 (longtask-01 实案)');
  assert.match(block, /禁止替别的步骤产出文件/, '边界围栏必须在');
  assert.ok(block.includes('/Users/you/Desktop/pangu/apps/core/modules'), '路径锚必须在');
});

test('多子任务派发: 子 agent 必须拿到主人原文 (逐字规格的唯一真源)', () => {
  const block = d._ownerScopeBlock(USER_INPUT, 4, SPEC_TASK);
  assert.ok(block.includes('function panguSoak(n)'),
    '多子任务时原文被整段省掉 —— 子 agent 拿不到规格就会编 (现场: 8 份文件写成文件名占位, '
    + 'checker 还报 "xxd hexdump 字节级核验 8/8 一致")');
  assert.ok(block.includes('# 交付清单'),
    '不只是代码/命令, 正文类逐字规格同样不能丢');
  assert.ok(block.includes('/tmp/pangu_soak_x/'),
    '原来那条「主人原话里的路径」必须继续在 (2026-09-18 实案: 固定任务扫了 pangu cwd)');
});

test('多子任务派发: 给了原文也必须守住「只做你这一步」的边界', () => {
  const block = d._ownerScopeBlock(USER_INPUT, 4, SPEC_TASK);
  assert.match(block, /只做你被分派的这一个子任务/,
    '注入原文是为了当规格真源, 不是让子 agent 抢别的步骤 —— 边界丢了就是互相覆盖');
  assert.match(block, /禁止替别的步骤收口/,
    '不能因为给了原文就放行替别人收口');
  assert.match(block, /没干完不许调 task_done/,
    '收口纪律: 你这步做完才调 task_done —— 给了原文更容易让它以为整轮都归它, 更要把话说死');
  assert.match(block, /不许自己编|不许编|不得编|禁止编/,
    '必须明写「不许编」—— 现场两次编造都出在这一条');
  assert.match(block, /原文未给出 X/,
    '必须点名「原文里真的没有 → 如实说缺什么」这条退路, 不能只喊「不许编」—— '
    + '不给退路, 子 agent 宁可编一个也不肯交白卷');
});

test('单子任务仍全量注入 (2026-10-12 既有行为不许回归)', () => {
  const block = d._ownerScopeBlock(USER_INPUT, 1);
  assert.ok(block.includes('function panguSoak(n)'), '单子任务本来就全量给原文');
  assert.ok(block.includes('/tmp/pangu_soak_x/'));
});

test('超长原文要截断但必须明说截断 —— 默默截断等于子 agent 拿到半截规格去编', () => {
  const huge = 'X'.repeat(30000) + '\nEND_OF_SPEC';
  const block = d._ownerScopeBlock(huge, 3, SPEC_TASK);
  assert.ok(block.length < huge.length + 2000, '超长原文必须截断, 不然 5 个子 agent 各背一份 3 万字');
  assert.match(block, /截断|已省略|超长/,
    '截断了必须告诉子 agent, 否则它以为这就是全部规格 → 拿半截去编');
});

// prompt 层同款约束 (只看 ROLES.*.system 运行时真值, 不做源码正则 —— 正则会被注释里的
// 字样骗过, 2026-10-13 已经在结构守卫上踩过两次)。
test('planner 必须把逐字规格抄进子任务 task (prompt 层, 防止转述派发)', () => {
  const sys = require('../agents/sub-agent').ROLES.kan.system;
  assert.match(sys, /抄进对应子任务的 task/,
    'planner 只转述"按主人给的内容" → 子 agent 手上没原文 → 编 (现场 8 份占位文件)');
});

test('checker 没原文不许判 pass (prompt 层, 防止编造核对结论)', () => {
  const sys = require('../agents/sub-agent').ROLES.dui.system;
  assert.match(sys, /手上没有主人给的原文.*不许判 pass/,
    '现场 checker 手上没有原文却报「PASS — 8/8 完全一致, 字节级核验 (xxd hexdump)」');
  assert.match(sys, /核对表里每一行都要有/, '逐行证据要求, 不许整表一个 ✅');
});

// 接线守卫: 触发判断靠的是「子任务原文」, 派发处不传 = 永远判定不了 = 修复等于没装。
// 两条派发路径 (fixed_flow / planner DAG) 都要传。
test('接线守卫: 两条派发路径都必须把子任务原文传进 _ownerScopeBlock', () => {
  // 2026-10-17: planner DAG 派发处搬进了 subagent_runner (主 agent 复用同一份),
  // fixed_flow 还在 dispatcher —— 两条路径分居两个文件, 所以两个都要读。
  // 只读 dispatcher 的话这条守卫会**假装还在** (第一半匹配不上才碰巧报红),
  // 而真出问题时它同样看不见, 那才是它要防的东西。
  const src = ['j2_dispatcher.js', 'subagent_runner.js']
    .map((f) => require('fs').readFileSync(require('path').join(__dirname, '..', 'modules', f), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')            // 剥注释, 别被注释里的字样骗过
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(src, /_ownerScopeBlock\(userInput, subTasks\.length, subTask\.task\)/,
    'planner DAG 派发处漏传 subTask.task → 「这任务点名要主人原文」永远判不出来, 规格永远不注入');
  assert.match(src, /_ownerScopeBlock\(userInput, _isOwnerCarrier \? 1 : total, st\.task\)/,
    'fixed_flow 派发处同样要传 st.task');
});
