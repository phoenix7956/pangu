'use strict';
// 2026-10-13 进展判据被「写盘事件数」灌水 —— 子 agent 锁死在重复循环里收不了尾
//
// 线上现场 (resume-live-1791876482, 子 agent 跑满 18 分钟不结束, 每 5~6 分钟
// 把同一批 a1/a2/a3 重写一遍):
//   [j2-auto-resume] 上限到达但有实质进展 (done 0→0, files 12→24), 预算重置续跑
//   [j2-auto-resume] 上限到达但有实质进展 (done 0→0, files 28→30), 预算重置续跑
//   [j2-auto-resume] 上限到达但有实质进展 (done 0→0, files 100→114), 预算重置续跑
//   [j2-auto-resume] 上限到达且无实质进展 (4/3, done=0, files=130), 收口
//
// **done 一直是 0→0** —— 计划里一步都没完成。但 files 从 12 涨到 130:
// 子 agent 在把同一批文件反复重写, 写盘**事件数**被灌水, 于是每一轮都被判成
// 「有实质进展」→ 预算重置 → 继续重写。循环的燃料就是它自己的重复动作。
//
// 这正是老板说的「子 agent 调用一直有问题」的机制: 不是模型笨, 是判据在奖励重复。
//
// 修法: 进展判据数「不同文件数」, 不数「动作次数」。
// 注意 countFilesTouched (事件数) **故意保留** —— tests/files-touched-count.test.js
// 钉住它不被 CAPS=30 卡死, 它现在只作观测, 不参与判定。
const test = require('node:test');
const assert = require('node:assert');

const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-progress-test-'));
process.env.PANGU_HOME = TMP_HOME;
// 2026-10-26 第 100 批: 账本目录走唯一真源 (modules/state_paths.js),
// 解析顺序 PANGU_LEDGER_DIR > PANGU_HOME/state/ledger > 生产默认。
// 只设 PANGU_HOME 会被链沙箱里的 PANGU_LEDGER_DIR 抢在前面 ⇒ 账本落到共享沙箱目录,
// 本测试的隔离意图 (自己的 TMP) 就没了。
process.env.PANGU_LEDGER_DIR = path.join(TMP_HOME, 'state', 'ledger');

const ledger = require('../modules/task_ledger');
const tc = require('../modules/task_checkpoint');
const budget = require('../modules/budget');

const writeA = (sid, p) => ledger.recordToolResult(sid, 'write_file', { path: p }, { ok: true, data: { path: p, bytes: 10 } });

// 结构守卫必须对着**代码**判。budget.js 的注释里就写着 countDistinctFilesTouched,
// 我第一版守卫没剥注释, 结果「判据改回事件数」这个变异照样全绿 —— 守卫被自己的注释骗过。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('反复重写同一批文件: 事件数暴涨, 不同文件数纹丝不动', () => {
  const sid = 'pad-1';
  writeA(sid, '/o/a.md');
  writeA(sid, '/o/b.md');
  writeA(sid, '/o/c.md');
  for (let i = 0; i < 40; i++) writeA(sid, '/o/a.md');   // 同一批文件重写 40 次

  assert.strictEqual(tc.countFilesTouched(sid, []), 43, '事件数确实暴涨 (它仍作观测, 故意不修)');
  assert.strictEqual(tc.countDistinctFilesTouched(sid, []), 3,
    '不同文件数必须还是 3 —— 重复触碰同一批文件不是进展');
});

test('真写出新文件才算数', () => {
  const sid = 'pad-2';
  writeA(sid, '/o/a.md');
  const before = tc.countDistinctFilesTouched(sid, []);
  writeA(sid, '/o/b.md');
  assert.strictEqual(tc.countDistinctFilesTouched(sid, []), before + 1, '新增交付物必须被计入');
});

test('功能: 重写同一批文件不得再判成「有实质进展」(预算不许被重复动作白嫖)', () => {
  const sid = 'pad-budget';
  writeA(sid, '/o/a.md');
  writeA(sid, '/o/b.md');

  const first = budget.resetRoundsAfterCompaction(sid);
  assert.strictEqual(first.progress, true, '第一次有真写盘, 应该有进展');

  // 原地打转: 把同样的两个文件重写 25 次, 什么都没前进
  for (let i = 0; i < 25; i++) { writeA(sid, '/o/a.md'); writeA(sid, '/o/b.md'); }
  const spin = budget.resetRoundsAfterCompaction(sid);
  assert.strictEqual(spin.progress, false,
    '只是把同一批文件重写 25 次 —— 判成有进展 = 预算被重复动作白嫖, 于是永远收不了尾');

  // 真推进: 写出一个新文件
  writeA(sid, '/o/c.md');
  const real = budget.resetRoundsAfterCompaction(sid);
  assert.strictEqual(real.progress, true, '写出新交付物必须重新算有进展');
});

test('接线: budget 的进展判据必须走「不同文件数」', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'modules', 'budget.js'), 'utf8'));
  const start = src.indexOf('resetRoundsAfterCompaction(sessionId)');
  assert.ok(start > 0, '找不到 resetRoundsAfterCompaction');
  const body = src.slice(start, start + 3000);
  assert.match(body, /countDistinctFilesTouched/,
    '预算续命的进展判据还在数写盘事件数 —— 重复动作能白嫖续命额度');
  assert.match(body, /eventsNow[\s\S]{0,200}_progress = /,
    '事件数只能作观测, 不许参与 _progress 判定');
  assert.doesNotMatch(body, /Math\.max\(_cpFiles, _tc\.countFilesTouched/,
    '并集里那一路不许退回写盘事件数 —— 重复动作能白嫖续命额度');
});

test('接线: j2 的 auto_resume 判据 + checkpoint 投影都必须用不同文件数', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8'));
  // 语义链必须闭合: 续命读数 ← checkpoint 同一个字段 ← 账本去重投影。
  // 中间任何一环换成「事件数」, 灌水就回来了。
  assert.match(src, /const _filesNow = \(typeof _prev\.files_touched_count === 'number'\)/,
    'auto_resume 的读数必须来自 checkpoint 里 j2 自己写的那个字段');
  // 接线形态刻意一个字没动 (读数/基线/写入都用 files_touched_count 这个同一个字段),
  // 变的只是这个字段装的数不再是「动作次数」—— 灌水的源头在写入端, 那里改就够了。
  assert.match(src, /files_touched_count: _files/,
    'checkpoint 存的必须就是续命判据读的那个字段');
  assert.match(src, /files_at_last_resume: \(typeof _prev\.files_touched_count === 'number'\)/,
    '续跑基线必须与读数同源, 否则差值恒无意义');
});

test('语义: checkpoint 的 files_touched_count 必须写「不同文件数」而不是事件数', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8'));
  // 字段名字面意思就是「碰过多少个文件」。旧代码往里写事件数, 于是 budget-rescue 那条
  // 「有真写盘进展必须放行」的判据能被重复写同一个文件刷出来 —— 灌水的源头就在这行赋值。
  assert.match(src, /const _files = tc\.countDistinctFilesTouched\(_sessionId, toolsUsed\);/,
    'files_touched_count 必须由 countDistinctFilesTouched 赋值');
  assert.match(src, /files_touched_events: _filesEvents/,
    '事件数要另存到 files_touched_events 作观测, 不能占用进展字段');
  assert.match(src, /const _filesEvents = tc\.countFilesTouched/,
    '事件数仍要算出来留档 —— tests/files-touched-count.test.js 钉住它不被 CAPS 卡死');
});
