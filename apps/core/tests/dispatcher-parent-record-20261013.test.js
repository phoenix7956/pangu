'use strict';
// 2026-10-13 父会话的磁盘记录里**没有它派过什么** —— 长工作续不回来的根因
//
// 线上现场 (objw-live-1791858904, 3 个子 agent 全部跑完, 最终答案 918 字带真实证据):
//   ~/.pangu-data/sessions/objw-live-1791858904.json 共 10 条消息
//     = 8 条注入 system 样板 (28385 字符) + 1 user (193) + 1 assistant (918)
//     工具消息 0 条 —— 派了哪几个子 agent、各自返回了什么、跑了哪些工具, 一条都没有
//
// 根因: j2_dispatcher._persistParent (2026-10-09 加的) 把
//   convo = [...dispatcher 自己的 messages, {assistant: 答案}]
// 存盘。而 dispatcher 的 messages 只有那 8 条注入 system + 1 条用户输入 ——
// 真正的活全在 results[] 里 (每个 {agent, task, result:{summary, artifacts, toolsUsed}}),
// 只被拼进综合提示词, 从未进过父会话历史。
// 后果: 刷新/续跑时父会话读到的是「一句任务 + 一段样板」, 对刚做完的事毫无记忆 ——
// 长任务天然续不下去, 也只能照抄子 agent 自述 (见 commit 219f69c)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const disp = require('../modules/j2_dispatcher');

const SAMPLE = [
  {
    agent: 'executor',
    task: '在 /tmp/pangu_steps/alpha/ 下真实创建并写入 a1.txt、a2.txt、a3.txt',
    result: {
      summary: 'alpha 已落盘并核验: a1.txt/a2.txt/a3.txt 各 3 字节, cat 内容分别为 a1/a2/a3',
      artifacts: ['/tmp/pangu_steps/alpha/a1.txt', '/tmp/pangu_steps/alpha/a2.txt'],
      data: {}, toolsUsed: ['write_file', 'read_file'], runtimeStatus: 'done',
    },
  },
  {
    agent: 'checker',
    task: '逐个 cat 两个目录的全部文件, 核对编号与内容对应',
    result: {
      summary: '核验通过: 6 个文件编号与内容全部对应',
      artifacts: [], data: {}, toolsUsed: ['read_file'], runtimeStatus: 'done',
    },
  },
];

test('父会话必须记下派了哪些子 agent、各自返回了什么', () => {
  const rec = disp._buildDispatchRecord(SAMPLE);
  assert.ok(typeof rec === 'string' && rec.trim().length > 0, '必须能生成派发记录');

  // 每个子 agent 的角色 + 任务 + 结论都得在里面
  assert.match(rec, /executor/, '要记下子 agent 角色');
  assert.match(rec, /checker/, '要记下子 agent 角色');
  assert.match(rec, /alpha 已落盘并核验/, '要记下子 agent 的结论原文, 不能只剩角色名');
  assert.match(rec, /核验通过/, '第二个子 agent 的结论也要记');
  assert.match(rec, /a1\.txt/, '产出文件要记下来');
  assert.match(rec, /write_file/, '调过的工具要记下来');
});

test('派发记录必须是**一条** system 消息, 不是每个子 agent 一条', () => {
  // 踩坑: 压缩那条已经证明, 注入一堆近似的 system 提示会让会话逐轮膨胀压不动。
  // 3 个子 agent 就 3 条 system 的话, 派发记录本身会变成新的膨胀源。
  const rec = disp._buildDispatchRecord(SAMPLE);
  assert.equal(typeof rec, 'string', '返回单个字符串而不是数组');
  const asMsgs = disp._buildParentConvo([], SAMPLE, '答案');
  const recordMsgs = asMsgs.filter(m => String(m.content || '').includes('子 agent 派发记录'));
  assert.equal(recordMsgs.length, 1, '只能有 1 条派发记录消息, 实际 ' + recordMsgs.length);
});

// 上一版按「内容里含不含派发记录字样」判断, 而空记录 content 是 '' —— 任何 content 匹配都
// 看不见它, 于是把 if (_rec) 改成无条件 push 照样全绿 (变异 M4 存活)。改判消息条数。
test('没有派发时不许塞空记录 (直答轮不该凭空多一条 system)', () => {
  const base = [{ role: 'user', content: '你好' }];
  const convo = disp._buildParentConvo(base, [], '你好，我在。');
  assert.equal(convo.length, base.length + 1,
    'results 为空时只该多出那一条 assistant, 实际多出 ' + (convo.length - base.length) + ' 条');
  assert.equal(convo[convo.length - 1].role, 'assistant', '最后一条必须是答案本身');
});

test('子 agent 失败要如实记成失败, 不能记成做完了', () => {
  const failed = [{
    agent: 'executor',
    task: '写 a1.txt',
    result: { summary: '', artifacts: [], data: {}, toolsUsed: [], runtimeStatus: 'failed' },
  }];
  const rec = disp._buildDispatchRecord(failed);
  assert.ok(rec.length > 0, '失败的派发也要留痕');
  assert.doesNotMatch(rec, /已完成|已落盘并核验完毕(?!$)/,
    'runtimeStatus=failed 不得被写成完成: ' + rec);
});

// 守卫必须锁**调用点**, 不能锁函数名出现过 —— 上一版写成 /_buildParentConvo\(messages, results/,
// 结果函数**定义本身**就匹配上了, 把 _persistParent 改回旧写法照样全绿 (变异 M3 存活)。
test('_persistParent 必须真的用上派发记录 (别写了个函数没人调)', () => {
  const src = fs.readFileSync(require.resolve('../modules/j2_dispatcher'), 'utf8');
  // 只认「把 _buildParentConvo(...) 的返回值直接交给 _persistSession」这个调用点形态
  assert.match(src, /_persistSession\(\s*sessionId,\s*_buildParentConvo\(/,
    '_persistParent 必须把 _buildParentConvo(messages, results, answer) 的结果交给 _persistSession');
  assert.match(src, /_buildParentConvo,\s*$/m,
    '_buildParentConvo 必须导出, 否则回归测试测不到');
  assert.match(src, /_buildDispatchRecord,\s*$/m,
    '_buildDispatchRecord 必须导出, 否则回归测试测不到');
});
