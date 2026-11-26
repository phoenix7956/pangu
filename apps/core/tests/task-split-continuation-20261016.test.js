// 2026-10-16 拆分器的过度拆分 —— 快路的拦路虎
//
// 现场 v3-034204 的时间账: 同一道"建 2 个文本文件", planner 要 61.8s, 而规则式拆分
// 是毫秒级的。按现在的拆法它给出**三刀**:
//   #0 executor 创建 2 个文件 | #1 executor 确保目录存在后再写入, | #2 checker 读回确认
//
// #1 不是一份独立的活, 它是 #0 的**前置条件**被切成了单独一刀。而这些刀靠
// depends_on 串行, 换不到任何并行 —— 多切一刀就多付一整次大上下文推理调用
// (本地 27B ~58s)。也就是说: 直接把拆分器提成快路, 省下的 planner 时间会被
// 多出来的那一刀原样吃回去, 甚至倒亏。
//
// 这组测试钉的是**两边**: 该合的必须合, 不该合的一个都不许合。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');

const { splitTask, splitClauses, roleForClause } = require('../modules/task_split');
const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const MECHANICAL = '在 /tmp/x 目录下创建 2 个文本文件: m.txt (内容就是 m) 和 n.txt (内容就是 n)。'
  + '确保目录存在后再写入, 写完读回确认内容正确。';

test('T1 前置条件并进上一刀 —— 3 刀变 2 刀 (少一次 ~58s 的调用)', () => {
  const r = splitTask(MECHANICAL);
  assert.ok(r, '这条应该拆得出来');
  assert.strictEqual(r.subTasks.length, 2,
    `应为 2 刀 (kun 做 + dui 验), 实际 ${r.subTasks.length} 刀`);
  assert.strictEqual(r.subTasks[0].agent, 'kun');
  assert.strictEqual(r.subTasks[1].agent, 'dui');
  // 合并后原文不能丢: 主活和前置条件都得在
  assert.match(r.subTasks[0].task, /创建 2 个文本文件/);
  assert.match(r.subTasks[0].task, /确保目录存在后再写入/,
    '前置条件被并进来了, 但不能被改写掉');
});

test('T2 "先 X" 是独立的第一刀, 绝不许被合进上一刀', () => {
  const src = SRC('modules/task_split.js');
  const m = src.match(/const CONT_PREFIX_RE = \/\^\(([^/]+)\)\//);
  assert.ok(m, '定位不到 CONT_PREFIX_RE');
  const alts = m[1].split('|');
  assert.ok(alts.length >= 3, `备选词表不该是空的: ${m[1]}`);
  assert.ok(!alts.includes('先'),
    `CONT_PREFIX_RE 不许含"先" —— "先备份数据库, 然后迁移"里"先备份"是独立一刀, 合掉就错了: ${m[1]}`);
  // 再钉一层, 而且必须是**同角色、前后都够长** —— 短的同角色早被旧规则合并了,
  // 不同角色则被角色判据挡住, 两种情况都测不到"先"这条排除。
  const r = splitTask('修改生产环境的配置文件并重新加载服务, 先创建一份完整备份文件保存到 /tmp');
  assert.ok(r, '这条应该拆得出来');
  assert.strictEqual(r.subTasks.length, 2,
    '"先创建备份"是独立一刀, 不该被并进"修改配置": ' + JSON.stringify(r.subTasks));
  assert.ok(r.subTasks.every(s => s.agent === 'kun'),
    '两刀都是 kun, 合并与否只取决于"先"这个前缀: ' + JSON.stringify(r.subTasks.map(s => s.agent)));
});

test('T3 不同角色绝不合并 (li 查完 kun 才动手, 是两刀)', () => {
  const r = splitTask('查一下为什么子 agent 调用很慢, 定位根因并修复');
  assert.ok(r, '这条应该拆得出来');
  assert.deepStrictEqual(r.subTasks.map(s => s.agent), ['li', 'kun']);
});

test('T4 合并只发生在同角色之间, 不改 depends_on 语义', () => {
  const r = splitTask(MECHANICAL);
  assert.strictEqual(r.subTasks[0].depends_on.length, 0, '第一刀没有前置');
  assert.deepStrictEqual(r.subTasks[1].depends_on, [0],
    'checker 依赖 executor —— 验的是上一刀的产出');
});

test('T5 保守性没被破坏: 拆不出来的仍然交回 planner', () => {
  const conservative = [
    ['单件事', '把 README 第一段改短一点'],
    ['调研', '帮我对比一下 vLLM 和 SGLang 的吞吐差异, 给出选型建议'],
    ['长链', '给 llm_caller.js 加一个首字节超时, 然后补测试, 最后跑全量回归'],
    ['独立两步', '修改配置, 重新部署服务'],
  ];
  for (const [name, input] of conservative) {
    const r = splitTask(input);
    assert.equal(r, null, `「${name}」不该被规则拆 —— 拆错了比不拆更贵`);
  }
});

test('T6 切句层没被动过: 三个子句还在, 合并只发生在派角色之后', () => {
  const clauses = splitClauses(MECHANICAL);
  assert.strictEqual(clauses.length, 3,
    `切句层应仍切出 3 句 (executor/executor/checker), 实际 ${clauses.length}`);
  assert.strictEqual(roleForClause(clauses[1]), 'kun');
  assert.strictEqual(roleForClause(clauses[2]), 'dui');
});
