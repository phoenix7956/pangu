// 2026-10-16 实机: 一道算卦题被磨成 Silent Failure (session=modelswitch-t1#sub-0-analyzer)
//
// 日志原文 (/tmp/pangu-single.err):
//
//   [j2-volume] 大体量任务预检命中: input=【卦·节䷻ 六四动→兑】「六四：安节，亨」—
//                先按此卦断方向 (攻守/时机/进退), 再执行子任务: 读取文件 /Use…
//   [j2-volume] plan 骨架已生成 (分母兜底): session=modelswitch-t1#sub-0-analyzer
//   [j2-native] TASK_DONE_GATE: plan 还有 1 步未完成, 拒收 task_done      ← ×4
//   [j2-auto-resume] 上限到达且无实质进展 (4/3, done=0, files=0), 收口
//   [j2-taxonomy] silent-fail strategy: … 我没能完成这次任务
//   [j2] SILENT_FAIL_PARTIAL: 诚实收口文案走 partial 收口
//
// 两个缺陷叠在一起:
//
// ① **体量预检不该作用在子 agent 上**。它的用途是"用户扔来一个超大任务 → 逼它自拆成轮",
//    而子 agent 的切片按定义已经是拆好的一刀。更糟的是骨架那一步的 dod 写着
//    「每步 plan_step_done 附证据后才允许 task_done(completed)」—— 子 agent 的 prompt
//    (切片 + 汇报契约 + scope guard) **从头到尾没告诉它要调 plan_step_done**。
//    于是它按契约交完就被拒, 4 次全拒 → auto-resume 烧完 → 一道算卦题以 Silent Failure 收场。
//    这是一道**结构上无法满足的门**。
//
// ② **谓词本身过宽**: volume 只要文本里出现**任何一个** `/Users/` 路径就算"大体量",
//    于是「读取 /Users/you/a.md 并总结」这种普通单文件总结也会命中。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');

const M = (p) => require(path.join(__dirname, '..', p));
const { isHeavyDigestTask } = M('modules/answer_alignment.js');
const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ===== ① 结构性护栏: 子 agent 不建 plan 骨架 =====

test('子 agent 会话不得触发体量预检建骨架 (那道门子 agent 无法满足)', () => {
  const src = SRC('modules/j2_agent_loop.js');
  // 子会话判据跟 task_ledger 一致: 含 `#` 即子 agent (j2_dispatcher 恒用
  // parentId + '#sub-' + n + '-' + role)。
  assert.match(src, /_isSubAgentSession\s*=\s*String\(_sessionId\s*\|\|\s*''\)\.split\('#'\)\[0\]\s*!==\s*String\(_sessionId\s*\|\|\s*''\)/,
    '子 agent 会话判据丢了 (含 # 即子会话)');
  // 护栏必须真的挂在建骨架那个 if 上, 而不是声明了没人用。
  assert.match(src,
    /if \(userInput && !opts\._volumeChecked && !_isSubAgentSession && _isHeavyDigestTask\(userInput\)\) \{/,
    '体量预检入口没有挂 !_isSubAgentSession 护栏 —— 子 agent 会被建骨架');
});

test('护栏要挂在"建骨架"那个入口上, 不是别处 (别改成只挡 609/3864 的判断)', () => {
  const src = SRC('modules/j2_agent_loop.js');
  // 骨架创建紧跟在这个 if 之后 —— 确认护栏和骨架在同一个作用域, 中间没有提前 return。
  const gate = src.indexOf("if (userInput && !opts._volumeChecked && !_isSubAgentSession && _isHeavyDigestTask(userInput)) {");
  const skeleton = src.indexOf("[j2-volume] plan 骨架已生成", gate);
  assert.ok(gate > 0, '找不到体量预检入口');
  assert.ok(skeleton > gate, '找不到骨架创建点');
  // 入口到骨架之间不允许有 return (否则护栏形同虚设)
  const between = src.slice(gate, skeleton);
  assert.doesNotMatch(between, /^\s*return\b/m, '预检入口到建骨架之间有提前 return, 护栏会被绕过');
});

// ===== ② 谓词收窄: 误判收回, 真批量保住 =====

test('实机那条卦象题不再被判大体量', () => {
  assert.equal(isHeavyDigestTask(
    '【卦·节䷻ 六四动→兑】「六四：安节，亨」— 先按此卦断方向 (攻守/时机/进退), '
    + '再执行子任务: 读取文件 /Users/you/Desktop/x.md, 然后总结要点, 全部处理完'), false);
});

test('光提一个 /Users/ 路径不算"大体量" (旧判据就栽在这)', () => {
  const single = [
    '读取 /Users/you/a.md 并总结',
    '总结 /Users/you/a.md 的要点',
    '把 /Users/you/notes.md 全部读一遍并总结',
  ];
  for (const t of single) {
    assert.equal(isHeavyDigestTask(t), false, '单文件不该判大体量: ' + t);
  }
});

test('真批量仍然命中 (收窄不能把真需求也砍掉)', () => {
  const real = [
    ['把 /Users/you/books/ 下 20 本 md 全部总结', '显式数量 + 全部'],
    ['消化 /Users/you/notes/a.txt 和 /Users/you/notes/b.txt', '多个路径 + 消化'],
    ['这套 5 个 txt 全部精读并总结', '显式个数 + 全部精读'],
    ['把整套资料吸收完', '整套资料'],
    ['全部文件精读并总结', '全部文件'],
  ];
  for (const [t, why] of real) {
    assert.equal(isHeavyDigestTask(t), true, '真批量不能漏: ' + why + ' | ' + t);
  }
});

test('原有的三条短路一条都不能被这刀碰坏', () => {
  // 这三条是 2026-09-14 / 2026-09-16 各自踩坑钉下来的, 都在函数开头, 这次只动了 volume。
  assert.equal(isHeavyDigestTask('现在消化吸收了多少了'), false, '疑问句');
  assert.equal(isHeavyDigestTask('继续消化完它好吗'), false, '带行动动词的疑问仍是任务');
  assert.equal(isHeavyDigestTask('【续跑约束】按顺序全部都做'), false, '续跑/顺序指令不是新的大批量消化');
  assert.equal(isHeavyDigestTask('【顺序指令】1. 读 A 2. 读 B 3. 全部写进 C.md'), false, '顺序指令');
});

test('lt7/lt8 的真实切片都不该命中 (那两轮就是靠这个才干净的)', () => {
  const slices = [
    '在 /tmp/pangu_lt8_test 建立目录并创建 5 个空文件 u1.txt、u2.txt、u3.txt、u4.txt、u5.txt',
    '往 /tmp/pangu_lt8_test/u1.txt 写入恰好 3 行内容：第一行 alpha，第二行 beta，第三行 gamma',
    '统计 /tmp/pangu_lt8_test/u1.txt 的行数（用 wc -l），写入 u2.txt；复制 u1.txt 到 u3.txt',
    '读回 /tmp/pangu_lt8_test/u1.txt 和 u3.txt，逐行比对确认两文件完全一致',
  ];
  for (const t of slices) {
    assert.equal(isHeavyDigestTask(t), false, '切片不该被判大体量: ' + t.slice(0, 40));
  }
});

