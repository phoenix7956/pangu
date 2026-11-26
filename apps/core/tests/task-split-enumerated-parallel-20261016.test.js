// 2026-10-16 编号并列清单 —— 长任务最高频的形状, 之前拆不出来
//
// 现场 live-1792146487916 (本地 qwen3.8-27b):
//   "请分别分析这三个文件各自解决什么问题, 每个文件给 3 个要点:
//    1) .../j2_loop_shared.js 2) .../model_cost.js 3) .../checkpoint.js"
//
// planner 没交出计划 (它吐的是伪工具调用), 落到确定性拆分, 而确定性拆分只认
// 句号/分号/换行 + 顺序连接词 —— 整个清单被当成**一句**, 于是拆出的是
//   刀0 analyzer「请分别分析这三个文件各自解决什么问题」
//   刀1 checker 「每个文件给 3 个要点: 1) … 2) … 3) …」
// 两刀都不对: 角色派错 (出要点是 analyzer 的活), 而且 analyzer 那刀仍然要读全部三个文件,
// 并行一分没兑现 —— 这正是老板要的"拆下去、子 agent 各做各的"落空的样子。
//
// 编号清单是**并列**的天然证据, 所以: 按项切 + 角色取清单前那个动词 + **不串 depends_on**。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { splitTask } = require('../modules/task_split');

const LIVE = '请分别分析这三个文件各自解决什么问题, 每个文件给 3 个要点: '
  + '1) /Users/you/Desktop/pangu/apps/core/modules/j2_loop_shared.js '
  + '2) /Users/you/Desktop/pangu/apps/core/modules/router/model_cost.js '
  + '3) /Users/you/Desktop/pangu/apps/core/modules/checkpoint.js';

test('T1 编号清单按项切, 一项一刀', () => {
  const r = splitTask(LIVE);
  assert.ok(r, '这道应该拆得出来');
  assert.strictEqual(r.pattern, 'enumerated_parallel', '必须走编号并列那条路, 不是通用切句');
  assert.strictEqual(r.subTasks.length, 3, '三个文件 = 三刀');
  assert.deepStrictEqual(r.subTasks.map(s => s.agent), ['li', 'li', 'li'],
    '角色取清单前的动词"分析" —— 出要点是 analyzer 的活, 不是 checker 的');
});

test('T2 每一刀只领自己那一个文件 (不许把整个清单塞给每刀)', () => {
  const r = splitTask(LIVE);
  const files = ['j2_loop_shared.js', 'model_cost.js', 'checkpoint.js'];
  files.forEach((f, i) => {
    const t = r.subTasks[i].task;
    assert.ok(t.includes(f), `刀${i} 必须领到 ${f}`);
    files.forEach((other) => {
      if (other !== f) assert.ok(!t.includes(other),
        `刀${i} 不该看见 ${other} —— 那就退回"三刀各读全部文件"的老形状了`);
    });
  });
});

test('T3 并列清单不许串 depends_on —— 串了就等于把并行的三刀排成一队', () => {
  const r = splitTask(LIVE);
  for (const st of r.subTasks) {
    assert.deepStrictEqual(st.depends_on, [],
      '编号清单是并列的, 刀之间不该有依赖 (2026-10-16 ed01b71 刚踩过"链式依赖把并发拆没了")');
  }
});

test('T4 文件名不许伪装成编号', () => {
  // 这正是 planner-fast-path-20261016 用的那道题: 编号规则若把 1.txt / 2.txt
  // 当成清单项, 就会把 executor+checker 的顺序活劈成两刀并行 executor,
  // "写完读回确认" 那一步直接消失。
  const r = splitTask('创建 2 个文件: 1.txt 内容 a, 2.txt 内容 b。写完读回确认');
  assert.ok(r, '这道题应该照旧拆得出来');
  assert.notStrictEqual(r.pattern, 'enumerated_parallel', '"1.txt" 是文件名, 不是第 1 项');
  assert.deepStrictEqual(r.subTasks.map(s => s.agent), ['kun', 'dui']);
  assert.ok(r.subTasks.some(s => s.task.includes('读回')), '"写完读回确认" 不能被劈掉');
});

test('T5 编号不是 1,2,3 连号 / 前面没有真动词 → 宁可不拆', () => {
  assert.strictEqual(splitTask('请分析 2026.10 的数据 2026.11 的数据'), null,
    '"2026.10" 是月份, 不是编号清单');
  assert.strictEqual(splitTask('分别读这三个文件: 1) x.js 2) y.js'), null,
    '清单前没有能判角色的动词 → 不猜, 交回 null 让上层走原路');
});

test('T6 刀数上限照旧生效', () => {
  const many = '分别分析这六个文件, 每个给 3 个要点: '
    + [1, 2, 3, 4, 5, 6, 7, 8].map(i => `${i}) /a/f${i}.js`).join(' ');
  const r = splitTask(many);
  assert.ok(r);
  assert.strictEqual(r.subTasks.length, 6, '默认上限 6 刀');
});

