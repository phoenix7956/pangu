'use strict';
// 2026-10-13 压缩把「活干到哪」的证据全丢了 —— "压缩之后忘了"的最可能真凶
//
// 真实子会话现场 (objw-live-* sub-*.json 扫全量):
//   tool 消息正文合计 4295 字符 + assistant tool_calls 参数合计 2807 字符 = 7102 字符干活证据。
// 而 session_compaction.createPageSummary 对每条 tool 只写一行
//   `T: <工具名>`  (8 条 ≈ 100 字符) —— **98.6% 的证据在每次压缩里蒸发**。
//   assistant 那批 tool_calls 更惨: content 是空串, clean 为空直接被 continue 掉,
//   连「我刚跑的是什么命令」都留不下。
//
// 后果很具体: 压缩一次, 模型就不知道 b1.txt 里写的是 b1 还是 b, 只知道自己调过 write_file。
// 续跑时只能重做 —— 这正是「长任务续不回来」的表现。
const test = require('node:test');
const assert = require('node:assert/strict');

const { createCompactor } = require('../modules/session_compaction');

const PAGE = () => createCompactor({});

// 上一版断言 /b1/ —— 而助手的调用参数里就有 "b1.txt", 断言被参数顶住了 (变异 M1 存活)。
// 换成只可能来自 tool 正文的唯一标记, 断言才不会锁错对象。
test('tool 结果正文必须进摘要 (修前: 只剩 "T: read_file")', () => {
  const c = PAGE();
  const out = c.createPageSummary([
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/tmp/pangu_steps/beta/b1.txt"}' } }] },
    { role: 'tool', tool_call_id: 'c1', tool_name: 'read_file', content: 'TOOL_BODY_UNIQUE_MARKER\n' },
  ]);
  assert.match(out, /TOOL_BODY_UNIQUE_MARKER/, 'tool 返回的正文必须留下来: ' + JSON.stringify(out));
  assert.match(out, /read_file/, '工具名要留下来');
});

test('工具调用参数必须进摘要 (模型压缩后最需要知道的是「我刚跑的是什么」)', () => {
  const c = PAGE();
  const out = c.createPageSummary([
    {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'exec_command', arguments: '{"command":"ls -l /tmp/pangu_steps/alpha/"}' } }],
    },
  ]);
  assert.match(out, /exec_command/, '工具名要留下: ' + JSON.stringify(out));
  assert.match(out, /pangu_steps/, '命令/参数要留下, 不能只剩一个工具名');
});

test('空的 assistant 正文但带 tool_calls 时不能整条被丢掉', () => {
  const c = PAGE();
  const out = c.createPageSummary([
    { role: 'assistant', content: '', tool_calls: [{ id: 'c9', type: 'function', function: { name: 'task_done', arguments: '{"summary":"做完了"}' } }] },
  ]);
  assert.ok(out.length > 0, '不能因为 content 是空串就整条 continue 掉');
});

test('超长 tool 结果要头尾都留 (exit code / 结论常在末尾)', () => {
  const c = PAGE();
  const body = 'A'.repeat(5000) + 'TAIL_MARKER_EXIT_0';
  const out = c.createPageSummary([{ role: 'tool', tool_name: 'exec_command', content: body }]);
  assert.ok(out.length > 0);
  assert.match(out, /TAIL_MARKER_EXIT_0/, '超长结果末尾的结论必须留下: 末尾被整段砍掉了');
});

test('页摘要总长仍受上限约束 (证据变多不等于体积失控)', () => {
  const c = PAGE();
  const msgs = [];
  for (let i = 0; i < 60; i++) {
    msgs.push({ role: 'tool', tool_name: 'exec_command', content: 'X'.repeat(2000) + ' id=' + i });
    msgs.push({ role: 'assistant', content: 'done ' + i, tool_calls: [{ id: 'a' + i, type: 'function', function: { name: 'exec_command', arguments: '{"command":"cmd' + i + '"}' } }] });
  }
  const out = c.createPageSummary(msgs);
  assert.ok(out.length <= 8000, '60 条消息的页摘要 ' + out.length + ' 字符, 不得失控');
  assert.ok(out.length >= 2000, '也不能什么都不留, 实际 ' + out.length);
});

test('输出仍按时间顺序 (分配预算可以倒序, 输出不能倒)', () => {
  const c = PAGE();
  const out = c.createPageSummary([
    { role: 'user', content: 'FIRST_TASK_MARKER' },
    { role: 'assistant', content: 'MIDDLE_MARKER', tool_calls: [] },
    { role: 'tool', tool_name: 'x', content: 'LAST_MARKER' },
  ]);
  assert.ok(out.indexOf('FIRST_TASK_MARKER') < out.indexOf('MIDDLE_MARKER'), 'FIRST 必须在 MIDDLE 前');
  assert.ok(out.indexOf('MIDDLE_MARKER') < out.indexOf('LAST_MARKER'), 'MIDDLE 必须在 LAST 前');
});
