// 2026-10-13 files_touched_count 判据失效 (现场证据 session=r10-live-1)
//
// 现场: 跑一个三子任务 (2 executor + 1 checker) 的真实会话, 三个文件真写盘成功。
//   同一时刻盘古自己的两份数据对同一场会话说了两套话:
//     ~/.pangu/state/ledger/r10-live-1_sub-0-executor.json → facts.files_written = 2 (a.txt / b.txt)
//     ~/.pangu/state/tasks/r10-live-1_sub-0-executor.json  → files_touched_count = 0
//
// 全量统计 286 条 checkpoint 的 tools_used: exec_command 467 次 vs write_file 26 次 (18:1),
// 而 files_touched_count 只按 ['write_file','file_edit','apply_patch'] 工具名白名单计数
// → 94.7% 的真写盘对该字段不可见, 只有 7% 的会话记录到过 >0。
//
// 后果链 (全部在盘古自己代码里, 不依赖任何外部实现):
//   j2_agent_loop.js:849 _fileProgress 恒 false → auto_resume 预算永远不按进展重置
//   budget.js:225     _progress 恒 false → 每次压缩都扣续命额度 → MAX_COMPACT_RESETS 后会话永久死
// 这就是"长工作干不下去 / 会话用着用着就死"的机制。
//
// 本测试钉住: 账本是唯一真源, 工具名白名单只作账本缺失时的兜底。
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-ftc-test-'));
process.env.PANGU_HOME = TMP_HOME;
// 2026-10-26 第 100 批: 账本目录走唯一真源 (modules/state_paths.js),
// 解析顺序 PANGU_LEDGER_DIR > PANGU_HOME/state/ledger > 生产默认。
// 只设 PANGU_HOME 会被链沙箱里的 PANGU_LEDGER_DIR 抢在前面 ⇒ 账本落到共享沙箱目录,
// 本测试的隔离意图 (自己的 TMP) 就没了。
process.env.PANGU_LEDGER_DIR = path.join(TMP_HOME, 'state', 'ledger');

const ledger = require('../modules/task_ledger');
const tc = require('../modules/task_checkpoint');

test('真实形态: exec_command 重定向写盘 → files_touched_count 必须 > 0', () => {
  const sid = 'r10-exec-cmd';
  // 这正是 r10-live-1 里子 agent 实际用的工具 (tools_used = ['exec_command','exec_command'])
  ledger.recordToolResult(sid, 'exec_command',
    { command: "echo '甲内容' > /tmp/pangu_v10/a.txt" },
    { ok: true, data: {} });
  ledger.recordToolResult(sid, 'exec_command',
    { command: "echo '乙内容' > /tmp/pangu_v10/b.txt" },
    { ok: true, data: {} });

  const facts = ledger.loadLedger(sid).facts;
  assert.strictEqual(facts.files_written.length, 2, '账本应记录 2 份真写');

  // 关键断言: 旧实现只数 ['write_file','file_edit','apply_patch'], 这里 toolsUsed 全是
  // exec_command → 旧实现返回 0 (真 bug 形态, 不是自造变体)
  assert.strictEqual(tc.countFilesTouched(sid, ['exec_command', 'exec_command']), 2,
    'exec_command 真写盘必须计入 files_touched_count');
});

test('只读命令不算写盘 (不能把 ls/cat 也当成进展)', () => {
  const sid = 'r10-readonly';
  ledger.recordToolResult(sid, 'exec_command', { command: 'ls -la /tmp' }, { ok: true, data: {} });
  ledger.recordToolResult(sid, 'exec_command', { command: 'cat /tmp/a.txt' }, { ok: true, data: {} });
  ledger.recordToolResult(sid, 'read_file', { path: '/tmp/a.txt' }, { ok: true, data: { path: '/tmp/a.txt' } });
  assert.strictEqual(tc.countFilesTouched(sid, ['exec_command', 'exec_command', 'read_file']), 0,
    '只读命令不得虚增进展计数');
});

test('/dev/null 与管道不误判为写盘', () => {
  const sid = 'r10-devnull';
  ledger.recordToolResult(sid, 'exec_command', { command: 'cat /tmp/a.txt > /dev/null' }, { ok: true, data: {} });
  assert.strictEqual(tc.countFilesTouched(sid, ['exec_command']), 0, '/dev/null 不是真写盘');
});

test('写盘计数单调递增, 不被 files_written 的 30 条上限截断', () => {
  const sid = 'r10-cap';
  for (let i = 0; i < 45; i++) {
    ledger.recordToolResult(sid, 'write_file', { path: `/o/f${i}.md` }, { ok: true, data: { path: `/o/f${i}.md`, bytes: 10 } });
  }
  const facts = ledger.loadLedger(sid).facts;
  assert.strictEqual(facts.files_written.length, 30, '列表本身按 CAPS 封顶 (维持原行为)');
  // 进展判据要能反映"干了很多活" —— 封顶列表会卡在 30, 所以另有单调计数
  assert.strictEqual(tc.countFilesTouched(sid, []), 45, '进展计数不得随列表上限卡死');
});

test('老账本 (无 files_written_total) 退回列表长度, 不崩', () => {
  const sid = 'r10-legacy';
  ledger.recordToolResult(sid, 'write_file', { path: '/o/old.md' }, { ok: true, data: { path: '/o/old.md' } });
  // 2026-10-26 第 100 批: 这里原来硬编码**生产绝对路径** '/Users/you/.pangu/state/ledger/…'
  //   ⇒ 测试每次跑都往生产账本写一个文件 (实测 r10-legacy.json 每次链都多一个)。
  //   改成走唯一真源 (modules/state_paths.js) ⇒ 落在本测试自己的 TMP 里。
  const f = path.join(require('../modules/state_paths').ledgerDir(), sid + '.json');
  // 直接构造一个没有新字段的老账本形态
  const blank = { session_id: sid, goal: '', facts: { files_read: [], files_written: [{ path: '/o/old.md', bytes: 1 }], dirs_seen: [], paths_missing: [], cmds_failed: [] }, lessons: [], last_run: null, updated_at: null };
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(blank));
  assert.strictEqual(tc.countFilesTouched(sid, []), 1, '老账本应回退到 files_written.length');
});

test('接线: j2_agent_loop 必须走 countFilesTouched, 不再用内联工具名白名单', () => {
  const src = fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8');
  assert.ok(src.includes('countFilesTouched'), 'j2_agent_loop 应调用 task_checkpoint.countFilesTouched');
  assert.ok(!/toolsUsed\.filter\(n => \['write_file'/.test(src),
    '内联工具名白名单计数必须消失 (exec_command 写盘会再次隐身)');
});

test('接线: 账本写盘事件总数记进 facts.files_written_total', () => {
  const sid = 'r10-total';
  ledger.recordToolResult(sid, 'write_file', { path: '/o/x1.md' }, { ok: true, data: { path: '/o/x1.md' } });
  ledger.recordToolResult(sid, 'exec_command', { command: 'cat a > /o/x2.md' }, { ok: true, data: {} });
  const f = ledger.loadLedger(sid).facts;
  assert.strictEqual(f.files_written_total, 2);
});
