// 2026-10-16 lt6 实机 sub-1-executor 606s 的真凶: 「③ 未做: 无」被判 partial
//
// 现场 lt6 (5 步长任务, 本地 qwen3.8-27b), 第二个 executor 刀 606s / r0→r10,
// 而同一道题的第一个 executor 刀 143s / 3 轮就交完了。原因不是超时也不是端点:
//
//   1) 子 agent 按汇报契约交了 task_done, ③ 那一行写的是「未做: 无」——"我什么都没漏"
//   2) PARTIAL_JUDGE 在子 agent 这条路上拿不到 planSteps, 直接退回词法判定
//   3) 词法满篇扫「未做 / 继续 / pending」, 于是**干完了的活被判 partial**
//   4) partial → 自动续跑, 而续跑会把完整 goal 重新灌进子 agent 的上下文
//   5) 完整 goal 落在【只做你被分派的这一个子任务】那条 scope guard **之后**,
//      模型于是把前后邻居的活也重跑一遍 (sub-1 重跑 sub-0 的 mkdir/touch,
//      sub-2 把 sub-1 的 wc/cp 重跑了两次)
//   6) 烧满 3 次续跑, r10 时端点才 ECONNRESET
//
// 第 3 步是唯一能单点修的。同一条判据在 checker verdict 上已经栽过一次
// (「无未通过项」当失败, 7a6cec8 修过), 这是同一个病的另一处。
//
// 修法: 契约行优先 —— 模型按契约显式把 ③ 写成空值, 那就是权威的"没有剩余";
// 没按契约交的 (老模型 / 非子 agent 路径) 行为一个字不变。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { lexicalIsPartial, reportDeclaresNoRemaining } =
  require(path.join(__dirname, '..', 'modules', 'summary_completion.js'));

test('lt6 真实 summary: 契约说「③ 未做: 无」就不该被判 partial', () => {
  // 逐字取自 lt6 现场 sub-1-executor 的 task_done summary, 一个字没改。
  const summary = [
    '① 完成: /tmp/pangu_lt6_test 下 u1.txt~u5.txt 五文件齐备，u1.txt 为 alpha/beta/gamma 三行；u2.txt 已写入行数统计 "3"，u3.txt 为 u1.txt 完整副本，读回逐行一致。',
    '② 证据: exec_command ls -la 显示 u1.txt=17字节、u2~u5=0字节；read_file u1.txt 返回 "alpha\\nbeta\\ngamma\\n"（3行）；exec_command `wc -l < u1.txt > u2.txt && cp u1.txt u3.txt` 后 cat u2 输出 "       3"，diff 无差异输出 DIFF_OK，exit=0。',
    '③ 未做: 无（建目录/空文件由上游 executor 完成，本次仅核实后继续写 u2/u3）。',
    '④ 交接: u1.txt(3行)、u2.txt("       3")、u3.txt(u1副本) 均已落盘并验证一致，后续步骤可直接使用。',
  ].join('\n');

  assert.equal(reportDeclaresNoRemaining(summary), true,
    '契约字段 ③ 显式为空, 应该认出「没有剩余」');
  assert.equal(lexicalIsPartial(summary), false,
    '修复前这条被判 partial → 触发 3 次自动续跑 → sub-1 从 143s 烧到 606s');
});

test('契约字段 ③ 为空值 = 权威的「没有剩余」, 各种写法都认', () => {
  const empty = [
    '③ 未做: 无',
    '③ 未做：无',
    '③ 未做: 无。',
    '③ 未做: 无（建目录由上游完成）',
    '③ 未做: 没有',
    '③ 未做: 空',
    '③ 未做: 0',
    '③ 未做: none',
    '3 未做：无',
    '② 证据: cat 返回 3 行\n③ 未做: 无\n④ 交接: 无',
  ];
  for (const t of empty) {
    assert.equal(lexicalIsPartial(t), false, '不该判 partial: ' + JSON.stringify(t));
  }
});

test('「无法 / 未能」说的是做不到, 不是没有剩余 —— 不能被空值词表吃掉', () => {
  // 这几条是最危险的误放行方向: 判错 = 真没干完的活被当完成, 直接丢任务。
  const reallyPartial = [
    '③ 未做: 无法完成 u2 写入',
    '③ 未做: 未能验证 u3',
    '③ 未做: 无力执行',
  ];
  for (const t of reallyPartial) {
    assert.equal(lexicalIsPartial(t), true, '必须判 partial: ' + JSON.stringify(t));
  }
});

test('③ 里真有剩余内容 → 照旧 partial', () => {
  const real = [
    '③ 未做: 还有 2 个文件没建',
    '③ 未做: u4/u5 还没建',
    '③ 未做: 剩 u5 没写',
  ];
  for (const t of real) {
    assert.equal(lexicalIsPartial(t), true, '必须判 partial: ' + JSON.stringify(t));
  }
});

test('没按契约交 (老模型 / 非子 agent 路径) → 词法一个字都没放松', () => {
  // 契约行优先只对显式交了契约的报告生效。没有 ③ 行的散文必须走老判据,
  // 否则这次修复会把词法兜底整体掏空。
  const prose = [
    '还没有干完, 剩余步骤待续',
    'TODO: 继续处理',
    '本轮只做了一半, 待下一轮',
    '还有 3 个文件没建',
    'remaining items pending',
  ];
  for (const t of prose) {
    assert.equal(lexicalIsPartial(t), true, '词法兜底必须继续判 partial: ' + JSON.stringify(t));
  }
});

test('PARTIAL_JUDGE 拿不到 planSteps 时 (子 agent 常态) 走的就是这条词法路', () => {
  // 钉住接线: judgeSummaryCompletion 在 !planSteps 时直接 return 词法结果。
  // 子 agent 走自己的 plan 文件, 常常是空的 —— 所以词法这条路就是主路径,
  // 不是边角 fallback。哪天有人给词法再加严, 这里会先红。
  const { judgeSummaryCompletion } = require(path.join(__dirname, '..', 'modules', 'summary_completion.js'));
  const done = '① 完成: 写了 3 个文件\n② 证据: ls 显示齐备\n③ 未做: 无\n④ 交接: 无';
  assert.equal(judgeSummaryCompletion(done, { planSteps: [], callLLM: () => { throw new Error('不该被调'); } }), false);
  assert.equal(judgeSummaryCompletion('还在继续, 剩余 2 项', { planSteps: [], callLLM: () => { throw new Error('不该被调'); } }), true);
});

