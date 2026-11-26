// 2026-10-17 假产出护栏把一份**正确**的分析报告杀掉了
//
// 现场 (lt3-1792177128350_sub-2-analyzer.json, 子会话 messages 逐条读):
// sub-2 读 checkpoint.js (166 行) **1 轮就读完**, 然后交出完整分析:
//   「…时机在于 checkpoint 已落盘、随时可接棒…3 个要点 1. 解决什么问题: agent loop
//     断点续跑 (新政 #2 驾驭层) 每个 round 结束落盘一次会话状态…」
// 那句「已落盘」在**描述被分析的模块干了什么**, 不是声称它本轮写了文件。
// FAKE_OUT_RE 的 "已落盘" 分支照样命中 → 护栏 nudge 一轮, 然后**熔断**,
// 把这份对的报告整个换成「⚠️ [盘古 FAKE-OUTPUT 熔断] 我刚才把结果说成了本轮已落盘…」
// 一份正确交付被自己的护栏杀掉, 还白烧两轮。
//
// 根因: 把"描述代码行为"和"声称自己产出"当成同一件事。
// 对"读完就讲解"的角色, 报告里必然出现 落盘/写入/保存/生成 —— 讲一个落盘模块
// 就得说落盘。角色不对, 词就不该当证据。
//
// 闸门 (j2_agent_loop): 只在**这一刀本来就要产出东西**时才拦 ——
//   ① 任务文本要求产出/改动, 或 ② 本轮 0 工具调用 (纯文本声称永远可疑)。
// 2026-08-03 老板两次实案和 2026-09-12 那次全部落在 ①, 一条都不许放过。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'modules', 'j2_agent_loop.js'), 'utf8');

// 把闸门从源码里原样抽出来跑 —— 不重写一份正则, 免得测试和实现各说各话。
// 抽的是实现里那三行 const (剥方块 / 判只读 / 合成武装), 源码一改这里就跟着变,
// 不会出现"实现改了、测试还按老逻辑绿着"。
function _gate(userInput, toolsUsed) {
  const body = src.match(/const _taskCore = [\s\S]*?const _guardArmed = [^;]+;/);
  assert.ok(body, '闸门那几行必须还在源码里 (抽不出来 = 实现被挪走了, 护栏要跟着改)');
  const anyToolUsed = toolsUsed.length > 0;
  // eslint-disable-next-line no-new-func
  const fn = new Function('userInput', 'toolsUsed', body[0] + '\n return _guardArmed;');
  return fn(userInput, toolsUsed);
}

// 现场 sub-2 逐字抄的回答片段 (子会话 messages[9])
const ANALYSIS_ANSWER =
  '**文件** `/Users/you/Desktop/pangu/apps/core/modules/checkpoint.js` (167 行, 实读全文)\n\n'
  + '**卦断方向**: 临䷒九二「咸临，吉无不利」→ 之卦复䷗「反复其道，七日来复」——'
  + '**该守的守、该复的复**：本文件正是一条「复」的路径…'
  + '时机在于 checkpoint 已落盘、随时可接棒。\n\n'
  + '**3 个要点**\n1. 解决什么问题: agent loop 断点续跑…每个 round 结束落盘一次会话状态';

test('F1 现场那句话本来就会命中 FAKE_OUT_RE —— 护栏失效不是因为词表宽松', () => {
  const gp = require('../modules/guard_patterns');
  assert.ok(gp.FAKE_OUT_RE.test(ANALYSIS_ANSWER),
    '这段回答必须仍然命中 FAKE_OUT_RE —— 不命中就说明今天的推断错了, 得重查');
  assert.strictEqual((ANALYSIS_ANSWER.match(gp.FAKE_OUT_RE) || [''])[0], '已落盘',
    '命中的是"已落盘", 正是描述模块行为的那三个字');
});

test('F2 分析类任务 + 真读了文件 → 不许拦 (今天这一刀)', () => {
  const task = '请分别分析这三个文件各自解决什么问题, 每个文件给 3 个要点 —— '
    + '只做这一项: /Users/you/Desktop/pangu/apps/core/modules/checkpoint.js';
  assert.strictEqual(_gate(task, ['read_file']), false,
    '闸门必须对"读完就讲解"关上 —— 打开就等于今天那份正确报告又被杀一次');
});

test('F2b 带边界块的分析任务同样不许拦 (剥【】是这道闸门的命门)', () => {
  // 现场真实形态: userInput 里带着服务端拼的卦块/路径锚/收口纪律,
  // 其中「禁止替别的步骤**产出**文件」自带产出二字 —— 不剥方块就必然误判成"要产出"。
  const task = '【卦·临䷒ 九二动→复】「九二：咸临，吉无不利」— 先按此卦断方向, 再执行子任务: '
    + '请分别分析这三个文件各自解决什么问题, 每个文件给 3 个要点 —— 只做这一项: '
    + '/Users/you/Desktop/pangu/apps/core/modules/checkpoint.js\n\n'
    + '【这一刀自己的路径 — 直接照抄, 禁止用你自己的 cwd 顶替】/Users/you/Desktop/pangu/apps/core/modules/checkpoint.js\n\n'
    + '【只做你被分派的这一个子任务】上面任务描述之外的步骤一律不做; 禁止替别的步骤产出文件 '
    + '(会和其他子 agent 抢同一个文件互相覆盖); 禁止替别的步骤收口。';
  assert.strictEqual(_gate(task, ['read_file']), false,
    '带边界块的分析任务被误判成要产出 → 闸门等于没加, 今天那份报告还是会被杀');
});

test('F3 2026-08-03 / 09-12 的真案一条都不许放过', () => {
  const cases = [
    ['出图 6 张, 已保存到 /tmp/a.png, 共 5.6KB 已存好', '把今天的会议图出 6 张', ['read_file']],
    ['已写入 总结.md, 共 5.6KB 已存好', '把这次的结论写入 总结.md', ['exec_command']],
    ['改完 _trimOutput / buildClaimAudit 已挂', '按上面的建议改一下代码', ['read_file', 'file_grep']],
    ['总结.md 从 1010 行变成 1106 行了', '写一份总结.md 落盘', ['read_file']],
    // 词表补不齐的现场证据: "出 6 张" 这种主谓宾倒装, 任何写类动词表都命不中。
    // 所以闸门必须靠"认不出只读 → 默认拦"兜住, 而不是靠词表全。
    ['已生成 6 张图, 共 5.6KB 已存好', '把今天的会议图出 6 张再存好', ['read_file']],
  ];
  for (const [answer, task, tools] of cases) {
    assert.strictEqual(_gate(task, tools), true,
      '这条真案被放过了: 任务="' + task + '" —— 闸门必须仍然拦它');
  }
});

test('F4 纯文本声称产出: 不看任务说什么都拦 (0 工具 = 永远可疑)', () => {
  assert.strictEqual(_gate('讲讲这个模块是干什么的', []), true,
    '一个工具都没调还声称落盘, 无论任务怎么写都必须拦');
  assert.strictEqual(_gate('', []), true, '空任务 + 0 工具照样拦');
});

test('F5 源码里闸门与调用点必须同时在, 不许只留一半', () => {
  assert.ok(/_guardArmed\s*&&/.test(src),
    'if 条件里必须带 _guardArmed —— 只定义不用 = 又修在了死路上 '
    + '(今天已有前例: 判官被 planSteps 短路, 改了一年提示词线上没动过)');
  const armed = src.match(/_guardArmed\s*&&/g) || [];
  const def = src.match(/const _guardArmed =/g) || [];
  assert.strictEqual(def.length, 1, '_guardArmed 只能算一次, 重复定义说明有人在两处各判一遍');
  assert.strictEqual(armed.length, 1, '_guardArmed 只能在一个 if 里生效');
});
