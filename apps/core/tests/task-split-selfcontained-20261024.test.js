'use strict';
/**
 * tests/task-split-selfcontained-20261024.test.js
 *
 * 第 78 批: 拆出来的刀**必须自足** —— 不许出现「每个写入不同的中文」这种
 * 没说清"每个"是指谁的刀。
 *
 * ## 现场 (实跑 probe76-multi, 桌面端真主路)
 *   主人: 「在 /tmp/probe76_work/ 下创建 3 个文件 a.txt b.txt c.txt,
 *          每个写入不同的中文, 然后逐个读回确认, 最后把清单写进 summary.txt。」
 *   规则拆分切出 3 刀:
 *     #0 kun 「在 /tmp/probe76_work/ 下创建 3 个文件 a.txt b.txt c.txt」
 *     #1 kun 「每个写入不同的中文」        ← **不自足**
 *     #2 dui 「逐个读回确认, 最后把清单写进 summary.txt」
 *   #1 的子 agent 只好自己猜"每个"是谁 ⇒ 把三个文件**又写了一遍**
 *   (两轮写入内容不同, 第二轮覆盖第一轮 —— 主人看到的是重复劳动 + 一轮白等的推理)。
 *
 * ## 这组测试钉的是**两边**
 *   ① 回指小句必须并进上一刀 (少一刀 = 少一次大上下文推理调用);
 *   ② 独立的第一刀不许被并掉 (「先备份」那种);
 *   ③ 编号并列清单仍要真并行拆开 (不许被这次的合并误伤)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { splitTask } = require('../modules/task_split');

const MECHANICAL = '在 /tmp/x 目录下创建 2 个文本文件: m.txt (内容就是 m) 和 n.txt (内容就是 n)。'
  + '确保目录存在后再写入, 写完读回确认内容正确。';

// 现场那一句 (一字不改, 就用实跑时主人说的原话)
const REAL = '在 /tmp/probe76_work/ 下创建 3 个文件 a.txt b.txt c.txt, 每个写入不同的中文, '
  + '然后逐个读回确认, 最后把清单写进 summary.txt。要求真读真写。';

/** 回指词表 —— 跟 modules/task_split.js 的 CONT_PREFIX_RE 同一类东西 */
const BACKREF_RE = /^(每个|各个|每一|各自|逐个|分别|它们|这些|那些|上述|该)/;

// --------------------------------------------------------------------------
// 1. 现场: 回指小句并进上一刀
// --------------------------------------------------------------------------

test('T1 现场那句: 3 刀 → 2 刀, 「每个写入不同的中文」并进上一刀', () => {
  const r = splitTask(REAL);
  assert.ok(r, '这条应该拆得出来');
  assert.strictEqual(r.subTasks.length, 2,
    '应为 2 刀 (kun 做 + dui 验), 实际 ' + r.subTasks.length + ' 刀: '
    + JSON.stringify(r.subTasks.map(s => s.agent)));
  assert.strictEqual(r.subTasks[0].agent, 'kun');
  assert.strictEqual(r.subTasks[1].agent, 'dui');
  assert.match(r.subTasks[0].task, /创建 3 个文件 a\.txt b\.txt c\.txt/);
  assert.match(r.subTasks[0].task, /每个写入不同的中文/,
    '回指小句被并进来了, 但不能被改写掉');
});

test('T2 不许有「裸回指刀」: 同角色的回指小句不许自己成刀', () => {
  const r = splitTask(REAL);
  for (let i = 1; i < r.subTasks.length; i++) {
    const s = r.subTasks[i];
    const prev = r.subTasks[i - 1];
    if (s.agent !== prev.agent) continue;   // 不同角色靠 depends_on 传递上文, 不算裸刀
    assert.ok(
      !BACKREF_RE.test(s.task),
      '第 ' + (i + 1) + ' 刀是裸回指刀 (同角色 + 以回指词开头): ' + JSON.stringify(s.task)
      + ' —— 子 agent 会因为"没说是谁"而重做上一刀的活'
    );
  }
});

test('T3 只有回指小句时, 不许拆 (拆不出就交回 null, 别造一刀空气)', () => {
  const r = splitTask('创建 a.txt b.txt c.txt, 每个写入不同的中文');
  assert.strictEqual(r, null,
    '这一句合完只有一刀 ⇒ 不该交回 plan (省一次 prefill): ' + JSON.stringify(r));
});

test('T4 现场那句不许再切出第二个 kun 刀 (重复写盘的根因)', () => {
  const r = splitTask(REAL);
  const kun = r.subTasks.filter(s => s.agent === 'kun');
  assert.strictEqual(kun.length, 1,
    '现场出现两个 kun 刀 ⇒ 第二刀会重写第一刀的文件: '
    + JSON.stringify(r.subTasks.map(s => s.agent)));
});

// --------------------------------------------------------------------------
// 2. 反向护栏: 独立的第一刀不许被并掉
// --------------------------------------------------------------------------

test('T5 「先 X」是独立的第一刀, 绝不许被并进上一刀', () => {
  const r = splitTask('修改生产环境的配置文件并重新加载服务, 先创建一份完整备份文件保存到 /tmp');
  assert.ok(r, '这条应该拆得出来');
  assert.strictEqual(r.subTasks.length, 2,
    '"先创建备份"是独立一刀, 不该被并进"修改配置": ' + JSON.stringify(r.subTasks));
  assert.ok(r.subTasks.every(s => s.agent === 'kun'));
});

test('T6 前置条件 (确保/再/写完) 仍然并进上一刀 —— 老行为不许退化', () => {
  const r = splitTask(MECHANICAL);
  assert.ok(r, '这条应该拆得出来');
  assert.strictEqual(r.subTasks.length, 2,
    '应为 2 刀 (kun 做 + dui 验), 实际 ' + r.subTasks.length + ' 刀');
  assert.match(r.subTasks[0].task, /确保目录存在后再写入/);
});

test('T7 编号并列清单仍然真并行拆开 (不许被这次的合并误伤)', () => {
  const r = splitTask('请分别分析这三个文件各自解决什么问题, 1) /tmp/a.js 2) /tmp/b.js 3) /tmp/c.js');
  assert.ok(r, '编号清单应该走并列拆开');
  assert.strictEqual(r.subTasks.length, 3,
    '并列清单应拆 3 刀: ' + JSON.stringify(r.subTasks.map(s => s.agent)));
  assert.ok(r.subTasks.every(s => s.agent === 'li'),
    '动词是"分析" ⇒ 都该是 li: ' + JSON.stringify(r.subTasks.map(s => s.agent)));
  assert.ok(r.subTasks.every(s => !s.depends_on || s.depends_on.length === 0),
    '并列清单不许串 depends_on (串了就白拆): ' + JSON.stringify(r.subTasks.map(s => s.depends_on)));
});

test('T8 不同角色绝不合并 (li 查完 kun 才动手, 是两刀)', () => {
  const r = splitTask('查一下为什么子 agent 调用很慢, 定位根因并修复');
  assert.ok(r, '这条应该拆得出来');
  assert.deepStrictEqual(r.subTasks.map(s => s.agent), ['li', 'kun']);
});

// --------------------------------------------------------------------------
// 3. 判据本身不许乱咬 (情态动词 "该做" 不是回指)
// --------------------------------------------------------------------------

test('T9 「该文件」是回指 —— 并进上一刀 (别留一刀自足不了的活)', () => {
  // 前一刀要**够长** —— 短刀有另一条老规则 ("两刀都短就并") 兜着,
  // 那条规则会让这一条判据看起来在咬人, 其实没被测到。
  const r = splitTask('在 /tmp/x 目录下创建 3 个文件 a.txt b.txt c.txt, 该文件写入不同的中文, 然后读回确认');
  assert.ok(r, '这条应该拆得出来');
  assert.strictEqual(r.subTasks.length, 2,
    '"该文件写入不同的中文"是上一刀 (创建 3 个文件) 的补充, 该并进去: '
    + JSON.stringify(r.subTasks.map(s => s.agent)));
  assert.match(r.subTasks[0].task, /该文件写入不同的中文/,
    '并进来时原文不许丢');
});

test('T10 回指词表不许含「先」 (「先备份」是独立第一刀)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'task_split.js'), 'utf8');
  const m = src.match(/const CONT_PREFIX_RE = \/\^\(([^/]+)\)\//);
  assert.ok(m, '定位不到 CONT_PREFIX_RE');
  assert.ok(!m[1].split('|').includes('先'),
    'CONT_PREFIX_RE 不许含"先": ' + m[1]);
});

