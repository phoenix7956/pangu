// 2026-10-16 planner 快路 —— 短机械活不调 planner
//
// 现场 v4 的时间账 (同一道"建 2 个文本文件", 本地 qwen3.8-27b):
//   v2 523s → v3 398.2s → v4 272.8s
// 剩下那 272.8s 的构成: planner 61.8s / executor ~70s / checker ~102s / synthesis 38.0s。
// 单刀 ~58s 是这个 27B 在大上下文下的底价, 动不了。**唯一的剩余杠杆是少几刀** ——
// Codex 同题 1 刀, 盘古 4 刀。
//
// 而这道题有个刺眼的事实: 规则拆分 (task_split) 给出的正是 [executor, checker],
// 和 planner 的产物同构, 且耗时是毫秒级。盘古却仍然先花了 61.8s 买它 ——
// 23% 的总时间, 花在一次本来可以规则回答的推理上。
//
// 快路的边界比"规则能拆就跳过"更严, 因为拆解质量值钱的地方正是长任务:
//   ① 只限短活 (剥块后 ≤120 字) —— 长的/调研的/需要权衡的一律原路给 planner
//   ② 长度按**剥掉卦块**算, 拆分按**原文** —— 服务端拼的块不该计工作量,
//      但子 agent 必须拿到主人逐字规格
//   ③ 拆不出 ≥2 刀就交回 null —— 宁可慢, 不给错的 plan
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');

const { _fastPlanFor, _FAST_PLAN_MAX_CHARS } = require('../modules/j2_dispatcher');
const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// 现场原题 (v3/v4 时间账用的就是这道)
const MECHANICAL = '在 /tmp/x 目录下创建 2 个文本文件: m.txt (内容就是 m) 和 n.txt (内容就是 n)。'
  + '确保目录存在后再写入, 写完读回确认内容正确。';

test('T1 短机械活命中快路 —— 省掉 planner 那 61.8s', () => {
  const r = _fastPlanFor(MECHANICAL);
  assert.ok(r, '这道应该命中快路');
  assert.strictEqual(r.subTasks.length, 2,
    `应为 2 刀 (executor 做 + checker 验), 实际 ${r.subTasks.length} 刀`);
  assert.deepStrictEqual(r.subTasks.map(s => s.agent), ['kun', 'dui']);
  assert.strictEqual(r.source, 'fast_rule', '快路产物必须自报家门, 便于现场分辨走的哪条路');
});

test('T2 长任务绝不命中 —— 拆解质量值钱的地方正是长任务, 快路不许吃掉它', () => {
  const LONG = '做一个 5 步计划并逐步执行：1) 列出 /Users/you/Desktop/pangu/apps/core/modules 下所有 .js 文件；'
    + '2) 统计这些文件的总行数；3) 找出其中超过 500 行的文件；4) 读取其中最大的 3 个文件的头 30 行；'
    + '5) 把汇总写成 markdown 报告写到 /tmp/longtask_report_20261012.md。每一步都真实用工具做，最后调 task_done 交付。';
  assert.strictEqual(_fastPlanFor(LONG), null,
    '长任务必须原路给 planner —— 这条要是松了, 长任务能力直接塌');
});

test('T3 单件事 / 调研类都不命中 —— 拆不出 ≥2 刀就老实交回 planner', () => {
  const cases = [
    ['单件事', '帮我看看盘古这个项目的架构是怎么组织的'],
    ['短调研', '分析一下 qwen3.8 这个模型为什么慢, 和 numctx 有没有关系'],
  ];
  for (const [name, input] of cases) {
    assert.strictEqual(_fastPlanFor(input), null,
      `${name} 只有一刀的活, 硬拆只会多付一次 ~58s 的调用`);
  }
});

test('T4 卦块不计入长度, 但子 agent 拿到的是主人逐字规格', () => {
  const gua = '【盘古起卦】\n乾卦 · 第 3 爻\n本卦体象: 金在天上, 刚健中正\n'
    + '该做: 动手把事做成\n不要复述本块原文。\n主人问题: ' + MECHANICAL;
  const withGua = _fastPlanFor(gua);
  const bare = _fastPlanFor(MECHANICAL);
  assert.ok(withGua && withGua.subTasks.length === 2,
    '卦块只是服务端拼的, 不该让这道短活被判成"长"而错失快路');
  // 长度按剥块后算
  assert.ok(MECHANICAL.length <= _FAST_PLAN_MAX_CHARS, '原题本身就该在阈值内');
  // 拆分按原文 —— 两道题的刀数必须一致, 说明卦块没进拆分, 也没被剥掉规格
  assert.deepStrictEqual(withGua.subTasks.map(s => s.task), bare.subTasks.map(s => s.task),
    '带卦块时子 agent 拿到的规格必须和裸题一致 —— 卦块既不该混进 prompt, 也不该被吃掉');
  assert.ok(!withGua.subTasks.some(s => /盘古起卦|该做:|体象/.test(s.task)),
    '卦块文本绝不能漏进子 agent 的任务里');
  assert.ok(withGua.subTasks[0].task.includes('m.txt') && withGua.subTasks[0].task.includes('n.txt'),
    '主人逐字规格 (文件名) 必须完整传下去');
});

test('T5 接线: planner 调用点真的被 if 包住了 (定义存在 ≠ 那条路用了它)', () => {
  const src = SRC('modules/j2_dispatcher.js');
  const call = src.indexOf('plan = await subAgent.run(');
  assert.ok(call > 0, 'planner 调用点还在');
  const before = src.slice(Math.max(0, call - 700), call);
  assert.ok(/_fastPlanFor\(userInput\)/.test(before),
    'planner 调用前必须先判快路');
  assert.ok(/else\s+try\s*\{/.test(before),
    'planner 那次调用必须落在 else 里 —— 快路命中时它要真的被跳过, '
    + '否则只是先把 plan 设好再被 planner 的结果覆盖, 61.8s 一分没省');
});

test('T6 快路也要记进 subagent-runs —— 将灵卡片得看得出坎出了多少活', () => {
  const src = SRC('modules/j2_dispatcher.js');
  assert.ok(/code:\s*'kan'[\s\S]{0,160}规则快路/.test(src),
    '快路必须留一条 done 记录, 否则界面上的坎看着像没动过, 现场没法分辨');
});

// ── 2026-10-16 追加: 主人自己把清单列出来的那种"长"活 ──────────────────────
//
// 现场 e2e-agent-20261016 (本地 qwen3.8-27b):
//   题: 「请分别分析这三个文件各自解决什么问题, 每个文件给 3 个要点: 1) … 2) … 3) …」
//   起卦 11:45:20 → 第一刀开跑 = **282.0s**。这 282s 全在 planner 那一次调用上,
//   而它交回的是三个 analyzer、三个文件各一刀、"给 3 个要点" —— 规则拆分
//   **毫秒级**就能给出同一份答案 (本文件 T7 断言刀数/角色/逐字规格全对得上)。
//
// 所以"长度 >120 字就交回 planner"这条闸门有个洞: 三个绝对路径一写就 464 字,
// 于是这种**主人已经逐字列好清单、且明说互不相干**的活, 白花 282s 把拆解买回来。
// 这就是老板说的"全量重填"的另一种形态。
//
// 豁免收窄到两个条件同时成立 —— 见 _fastPlanFor 注释:
//   ① 主人明说互不相干 (分别/各自/每个/逐个/独立/并行)
//   ② 规则确实认出编号并列清单 (真并行, 一项一刀, depends_on 为空)
// T8 专门钉住 T2 那道 5 步依赖链不许被误伤。
const SPELLED_OUT = '请分别分析这三个文件各自解决什么问题, 每个文件给 3 个要点: '
  + '1) /Users/you/Desktop/pangu/apps/core/modules/j2_loop_shared.js '
  + '2) /Users/you/Desktop/pangu/apps/core/modules/router/model_cost.js '
  + '3) /Users/you/Desktop/pangu/apps/core/modules/checkpoint.js';

test('T7 主人逐字列了清单 + 明说互不相干 → 走快路, 省掉那 282s', () => {
  assert.ok(SPELLED_OUT.length > _FAST_PLAN_MAX_CHARS,
    '这题必须确实超阈值, 否则这个测试证明不了闸门被放宽过');
  const r = _fastPlanFor(SPELLED_OUT);
  assert.ok(r, '这道应该命中快路 —— 清单是主人给的, 没有依赖要排');
  assert.strictEqual(r.pattern, 'enumerated_parallel');
  assert.strictEqual(r.subTasks.length, 3);
  assert.deepStrictEqual(r.subTasks.map(s => s.agent), ['li', 'li', 'li']);
  // 必须是真并行: 项与项之间没有先后, 串起来就白拆了
  for (const st of r.subTasks) assert.deepStrictEqual(st.depends_on, [], '编号并列清单各刀互不依赖');
  // 每刀必须点名自己那一个 —— 这就是"子 agent 只做自己相关的"的实际载荷
  const items = r.subTasks.map(s => (s.task.match(/只做这一项[:：]\s*(\S+)/) || [])[1]);
  assert.deepStrictEqual(items, [
    '/Users/you/Desktop/pangu/apps/core/modules/j2_loop_shared.js',
    '/Users/you/Desktop/pangu/apps/core/modules/router/model_cost.js',
    '/Users/you/Desktop/pangu/apps/core/modules/checkpoint.js',
  ]);
  for (const st of r.subTasks) assert.ok(!/【盘古起卦|不要复述本块原文/.test(st.task), '卦块不许进刀');
});

test('T8 放宽闸门不许误伤真·长任务 —— T2 那道 5 步依赖链照旧给 planner', () => {
  const LONG = '做一个 5 步计划并逐步执行：1) 列出 /Users/you/Desktop/pangu/apps/core/modules 下所有 .js 文件；'
    + '2) 统计这些文件的总行数；3) 找出其中超过 500 行的文件；4) 读取其中最大的 3 个文件的头 30 行；'
    + '5) 把汇总写成 markdown 报告写到 /tmp/longtask_report_20261012.md。每一步都真实用工具做，最后调 task_done 交付。';
  assert.ok(LONG.length > _FAST_PLAN_MAX_CHARS);
  assert.ok(!/分别|各自|每个|逐个|独立|并行/.test(LONG),
    '前提: 这道题没有"互不相干"的措辞 —— 它的 5 步是真的前后依赖');
  assert.strictEqual(_fastPlanFor(LONG), null,
    '这道要是被快路吃掉, 长任务能力直接塌 —— 放宽闸门的边界就在这里');
  // 编号清单 + 没明说互不相干 → 也不豁免 (顺序活不能硬拆成并行)
  const SEQ = '1. 先备份数据库, 2. 然后迁移数据, 3. 最后校验一致性';
  assert.ok(!/分别|各自|每个|逐个|独立|并行/.test(SEQ), '前提: 没说互不相干');
  assert.strictEqual(_fastPlanFor(SEQ), null, '顺序活不许因为有编号就当并行');
});

test('T9 豁免只认 enumerated_parallel —— 编号在别的形状里出现也不豁免', () => {
  const src = SRC('modules/j2_dispatcher.js');
  assert.ok(/plan\.pattern === 'enumerated_parallel'/.test(src),
    '放宽必须同时验 pattern, 不能只看主人说了"分别"就算数');
  assert.ok(/_INDEPENDENT_LIST_RE\.test\(stripped\)/.test(src),
    '要验主人原话的措辞, 不是验子任务');
});
