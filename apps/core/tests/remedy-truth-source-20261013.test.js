'use strict';
// 2026-10-13 soak-live-1791879822 现场 (子 agent 能收口之后的下一层):
//
// 第 2 轮 9 个文件都建出来了, 但:
//   ① 验收 checker 把规格里的 `04_data.csv` 在报告里写成 `04_*.md` (转述, 不是逐字);
//   ② 补救 executor 照这句转述建了 `04_data.md` —— 目录里多一个文件, `04_data.csv` 是别人建的;
//   ③ 补救 executor 的报告字节数全是编的 (报 01_index.md 60B / 02_notes.md 38B, 盘上实际 63B / 55B);
//   ④ 父循环最终答复: 「01–04 内容不是主人指定原文」—— 实测 01–04 **是对的**, 只是差一个尾换行;
//      还说「当前响应没有可调用的文件/命令工具接口」—— 综合轮本来就是
//      `_callLLMForAgent(summaryMessages, model, [])`, 工具列表**是空的**, 它却拿这个当理由
//      说「无法继续写盘」, 等于拿自己的构造当客观障碍上报。
//
// 病根是同一个: **转述被当成了真源**。checker 的 FAIL 原话被原样焊进补救任务当「上面指出的
// 缺失部分」, 补救 agent 就照着转述干活 (而不是照主人的原文); 综合轮拿子 agent 快照当事实, 也不
// 区分「第一次的 FAIL」和「补救后的现状」。
const test = require('node:test');
const assert = require('node:assert/strict');

const d = require('../modules/j2_dispatcher');

const FAIL_SUMMARY = '**FAIL — 验证不通过。** 目录里实际只有 4 个文件: 05_snippet.js (42B) … '
  + '缺失 (要求 8 份交付物 + summary_table.md): 01_index.md / 02_notes.md / 03_checklist.md / 04_*.md → 不存在';
// 真规格: 8 份文件, 前 400 字只够写完前两三份 —— 后面 (尤其 04_data.csv / 05_snippet.js)
// 正好落在老代码 userInput.slice(0, 400) 的刀口上。这就是现场那个 bug 的形状。
// 现场真实体量: 主人原话超过 8000 字 → 走截断分支。规格整体落在 400 字之后,
// 于是 slice(0,400) (老代码) 正好把 8 份规格全砍掉, slice(0,8000) 留着。
const USER_INPUT = '请真做一件事, 全程必须真的调工具, 不许只在嘴上说。'
  + '下面是这一轮的全部要求, 我会逐字核对, 任何一处对不上都算你没做完。'
  + '注意: 每一份文件的正文我都给了原文, 你不许自己编内容, 也不许拿占位串 (文件名当正文、'
  + '"示例"、"待补充") 顶替; 也不许增删任何字符或空行。核对的方式是我这边逐字 diff。'
  + '在 /tmp/x/ 下逐个创建这 8 份文件, 每份内容必须与下面给的内容一致 (这是硬要求):\n'
  + '--- 01_index.md ---\n# 交付清单\n\n本批共 8 份交付物, 逐份回读核对。\n'
  + '--- 02_notes.md ---\n# 现场笔记\n\n记录本轮真实观察到的现象。\n'
  + '--- 03_checklist.md ---\n# 自检清单\n\n- [ ] 每份都真落盘\n- [ ] 每份都 cat 回来过\n'
  + '--- 04_data.csv ---\nname,value\nalpha,1\nbeta,2\ngamma,3\n'
  + '--- 05_snippet.js ---\nfunction panguSoak(n) {\n  return n * 2;\n}\n'
  + '--- 06_readme.md ---\n# 说明\n\n这是第 6 份交付物。\n'
  + '--- 07_summary.md ---\n# 小结\n\n前面 6 份都已核对。\n'
  + '--- 08_final.md ---\n# 收尾\n\n全部 8 份交付完毕。\n'
  + '\n创建完后, 逐个 cat 回来核对内容, 再写一份 summary_table.md 汇总核对结果。全部做完再 task_done。'
  // 现场真实体量: 主人原话超过 8000 字 → 走截断分支。规格在 400~8000 字区间,
  // 于是 slice(0,400) (老代码) 正好把 04_data.csv / 05_snippet.js 全砍掉, slice(0,8000) 留着。
  + '\n[附: 背景资料占位 — ' + 'x'.repeat(9000) + ']';

test('补救任务: 主人原话是真源, checker 转述只是线索 —— 顺序必须写死', () => {
  const task = d._buildRemedyTask(1, FAIL_SUMMARY, USER_INPUT);
  assert.match(task, /主人原话[^。]*真源|真源[^。]*主人原话/,
    '补救 agent 必须知道该信谁 —— 现在只说「按上面指出的缺失部分补齐」, 它就照 checker 的转述干活');
  assert.match(task, /不许照抄[^。]*(转述|原话)|别照抄/,
    '必须点名: checker 的文件名/规格可能是转述错的 (04_*.md → 04_data.csv), 照抄就会建错文件');
  assert.match(task, /逐字/,
    '文件名与内容一律回主人原话逐字取');
});

test('补救任务: 原任务不能只截 400 字 —— 规格在后面就被砍掉了', () => {
  const task = d._buildRemedyTask(1, FAIL_SUMMARY, USER_INPUT);
  assert.ok(task.includes('gamma,3'),
    '主人原话里的规格必须完整带进补救任务 (原来 userInput.slice(0,400) 正好把 04_data.csv 的内容砍掉)');
  assert.ok(task.includes('05_snippet.js'),
    '主人原话里的文件名必须完整带进补救任务');
  assert.match(task, /超长|截断/,
    '超长截断时必须明说 —— 默默截断等于补救 agent 拿着半截规格去补');
});

test('补救任务: 报告只许写亲眼回读到的, 数字不许凭印象', () => {
  const task = d._buildRemedyTask(1, FAIL_SUMMARY, USER_INPUT);
  assert.match(task, /cat|回读/,
    '必须要求回读');
  assert.match(task, /字节|大小/,
    '必须点名字节数/大小 —— 现场补救 agent 报的 60B/38B 全是编的 (盘上 63B/55B)');
});

// 综合轮: _callLLMForAgent(summaryMessages, model, []) —— 工具列表是空的, 这是构造决定的,
// 不是现场故障。答复里拿它当「无法继续写盘」的理由上报, 等于把自己的构造说成客观障碍。
test('综合轮 system 提示: 不许拿「没有工具」当没干完的理由', () => {
  const msgs = d._buildSynthesisMessages('sid-x', USER_INPUT, '', [{ agent: 'executor', task: 't', result: { summary: 's' } }], 2000);
  const sys = msgs[0].content;
  assert.match(sys, /没有工具|工具列表为空/,
    '必须告诉综合轮它自己没有工具 —— 否则它会编「当前响应没有可调用的工具接口」');
  assert.match(sys, /不许[^。]*(没有可调用|无法继续写盘)/,
    '明写禁令: 综合轮不许说「无法继续写盘 / 没有可调用的工具」');
});

test('综合轮 system 提示: 同一件事以最后一次结论为准 (旧 FAIL 不作数)', () => {
  const msgs = d._buildSynthesisMessages('sid-x', USER_INPUT, '', [{ agent: 'executor', task: 't', result: { summary: 's' } }], 2000);
  assert.match(msgs[0].content, /最后一次|最新/,
    '现场: 第一次验收 FAIL 说 01–04 缺失, 补救后文件已建对, 最终答复却还按旧 FAIL 说「01–04 不是原文」');
});

// 接线守卫: helper 写对了但调用处还在用老的内联拼接 = 等于没修 (今天已经吃过两次这种亏:
// 子 agent 原生工具那次、派发规格那次)。
test('接线守卫: 补救轮必须走 _buildRemedyTask', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'modules', 'j2_dispatcher.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(src, /task: _buildRemedyTask\(/,
    '补救任务必须在调用处用 helper —— 留着内联拼接就等于没修');
  assert.ok(!/userInput\.slice\(0, ?400\)/.test(src),
    '不许再出现 userInput.slice(0, 400) 这种把规格砍掉的写法');
});
