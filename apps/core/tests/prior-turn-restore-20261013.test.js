'use strict';
// 2026-10-13 盘古写下来的记忆从来不读回来 —— "长工作做不了"的最后一块
//
// 端到端实测 (probe_resume, resume-live-1791860580, 阈值压到 14 让压缩真触发):
//   第一轮 442.3s: 写了 a1/a2/a3 (3 字节, 内容正确), 随后上游 ETIMEDOUT,
//                   如实回「本轮未形成与原问题匹配的可核验答案, 请重试」
//   第二轮 453.9s: 新增 b1/b2/b3 (该做的), 但 **a1/a2/a3 的 mtime 全被刷新** —— 重做了一遍
//
// 而此时盘古的落盘记录里明明写着 a1.txt:
//   resume-live-1791860580.json  msgs=11  派发记录=1 条 (3674 字符, 含 a1.txt)
//   sub-0/1/2 会话摘要 1619~2227 字符 (今天修的压缩摘要, 非空)
//
// 根因: 全代码库里 sessionLoad 只在三处被调 ——
//   ① inline_router 的查询路由 ② 给模型可调用的 session_recall 工具
//   ③ j2_loop_shared 建会话状态时**只恢复 plan_state, 不恢复对话消息**
// 而新的一轮, messages 是从**当前这一轮请求**现拼的 (pangu_agent_stream 140-141 行),
// 历史从来没进过上下文。于是 _buildHistoryBlock 这个函数是对的, 但它的输入永远是空的。
const test = require('node:test');
const assert = require('node:assert/strict');

const shared = require('../modules/j2_loop_shared');

test('上一轮的用户/助手对话必须被恢复进新一轮的上下文', () => {
  const prior = [
    { role: 'system', content: '# 你是盘古' },
    { role: 'user', content: '在 /tmp/x/ 下写 a1.txt a2.txt a3.txt' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    { role: 'assistant', content: '已写入 a1/a2/a3, 逐个 cat 核对通过。' },
  ];
  const turns = shared._extractPriorTurns(prior);
  const text = turns.map(t => t.content).join('\n');
  assert.match(text, /a1\.txt/, '上一轮的任务原文必须带回来');
  assert.match(text, /逐个 cat 核对通过/, '上一轮的结论必须带回来');
});

test('不得把 system / tool / 带 tool_calls 的助手消息灌进历史', () => {
  // 带 tool_calls 的 assistant 如果单独灌进去而没有配对的 tool 结果 → 上游 400
  // (这正是 session_compaction._sanitizeToolPairing 一直在防的事)
  const turns = shared._extractPriorTurns([
    { role: 'system', content: 'SYS_SHOULD_NOT_LEAK' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'exec_command', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'TOOL_SHOULD_NOT_LEAK' },
    // content 非空 + 带 tool_calls 的助手: 空正文检查挡不住它, 只有 tool_calls 过滤能挡。
    // 上一版样本里那条 content 是空串, 于是「不过滤 tool_calls」的变异照样全绿 (变异 M5 存活)。
    { role: 'assistant', content: 'ASSISTANT_WITH_TOOLCALLS_SHOULD_NOT_LEAK', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'exec_command', arguments: '{}' } }] },
    { role: 'assistant', content: '纯文本结论' },
  ]);
  const text = turns.map(t => t.content).join('\n');
  assert.doesNotMatch(text, /SYS_SHOULD_NOT_LEAK/, 'system 提示每轮本来就会重新注入, 不必进历史');
  assert.doesNotMatch(text, /TOOL_SHOULD_NOT_LEAK/, '孤儿 tool result 会让上游 400');
  assert.doesNotMatch(text, /ASSISTANT_WITH_TOOLCALLS_SHOULD_NOT_LEAK/,
    '带 tool_calls 的助手灌进来而没有配对的 tool 结果 → 上游 400');
  assert.ok(turns.every(t => t.role === 'user' || t.role === 'assistant'), '历史里只该有 user/assistant');
  // 上一条只验了 role, 放行「带 tool_calls 的 assistant」照样能过 (它 role 也是 assistant)。
  // 它的 content 常是空串, 一旦被放行, 上游就会看到没有 tool 结果的 tool_calls → 400。
  assert.equal(turns.length, 1, '空正文 + 带 tool_calls 的助手必须被剔除, 实际留下 ' + turns.length + ' 条');
  assert.match(text, /纯文本结论/);
});

test('历史条数必须有上限 (否则多轮之后上下文越滚越大)', () => {
  const prior = [];
  for (let i = 0; i < 200; i++) {
    prior.push({ role: i % 2 ? 'assistant' : 'user', content: '第 ' + i + ' 轮' });
  }
  const turns = shared._extractPriorTurns(prior, 10);
  assert.ok(turns.length <= 10, '实际 ' + turns.length + ' 条, 必须受上限约束');
  // 留的应该是**最近**的, 不是最早的 —— 最近才接得上
  assert.match(turns[turns.length - 1].content, /第 199 轮/, '要保留最近的那轮');
});

test('没有历史 / 输入非法时返回空数组 (首轮不能凭空多出东西)', () => {
  assert.deepEqual(shared._extractPriorTurns(null), []);
  assert.deepEqual(shared._extractPriorTurns(undefined), []);
  assert.deepEqual(shared._extractPriorTurns([]), []);
  assert.deepEqual(shared._extractPriorTurns('not-an-array'), []);
});

test('空正文的助手占位不许进历史 (否则历史全是空气)', () => {
  const turns = shared._extractPriorTurns([
    { role: 'assistant', content: '' },
    { role: 'assistant', content: '   ' },
    { role: 'assistant', content: '真有内容' },
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].content, '真有内容');
});

// 光测纯函数不够: 函数写对了但请求路径没接上, 线上照样每轮从零开始。
// 锁**调用点形态** —— 函数定义本身满足不了下面两条。
test('agent stream 请求路径必须真的接回上一轮 (函数写了不调 = 没修)', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../modules/pangu_agent_stream'), 'utf8');
  assert.match(src, /sessionLoad\(\{ session_id: _priorSid \}\)/,
    '必须真的从落盘会话里把上一轮读回来');
  assert.match(src, /_extractPriorTurns\(_priorRes\.result\.messages\)/,
    '读回来的消息必须过 _extractPriorTurns 过滤 (不许把 system/tool 灌进历史)');
  // 锁实际的变量名 (_keep), 上一版写的是 /_priorTurns\.length|turns\.length/ ——
  // 源码里根本没有那个变量, 于是这条守卫在定稿上就是红的, 等于没守。
  assert.match(src, /if \(_keep\.length\)/, '过滤后的历史必须判过非空');
  assert.match(src, /\.\.\._keep,/, '接回的对话必须真的铺进 messages');
  // 2026-10-28 (第 133 批): 比对口径从「逐字比内容」改成「**剥掉注入块还原原话**再比」
  //   (coreUserText) —— 落盘里存的是注入块拼过的版本, 逐字比永远比不上,
  //   本轮会被当成上一轮再灌一遍 (现场: 模型复读上一轮, 答案长度 1836 = 1836)。
  assert.match(src, /t\.role === 'user'[\s\S]{0,240}_curNorm/,
    '当前这条 user 请求不许被灌两遍 (比对走原话口径)');
  assert.match(src, /_clientTurnCount > 1/,
    '客户端自带整段历史时, 不许再从会话存储接回一遍 (否则同一轮对话出现两遍)');
});
