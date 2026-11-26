'use strict';

const assert = require('assert');
const { test } = require('node:test');

// 2026-08-24 (老板 08:59 实案: rounds=21>max_rounds=20 会话被掐死, "居然不会自动压缩会话")
// 预算耗尽 → 强制压缩会话 → resetRoundsAfterCompaction 重置 rounds 续命。
// 2026-09-14 (老板 14:17 实案 "还有这个问题, 超限了"): tokens 终身累计不重置 → 真干活的长会话
// 烧满 500k 永久死。新语义: 压缩续命连 tokens 一起清 (预算 = 活跃窗口燃烧, 不是终身累计);
// 续命次数进展制 — checkpoint 有真写盘进展不耗额度, 原地打转才耗, 耗尽才熔断。

// task_checkpoint 目录隔离必须先于首次 resetRoundsAfterCompaction (lazy require 锁目录)
const fs = require('fs');
const path = require('path');
const os = require('os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-budget-test-'));
process.env.PANGU_TASK_DIR = path.join(TMP, 'tasks');
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

const budget = require('../modules/budget');

test('rounds 超限 → 压缩重置后放行, rounds 归零', () => {
  const sid = 'test-rescue-basic';
  budget.clear(sid);
  const max = budget.DEFAULTS.max_rounds;
  // 打到超限 (max+1)
  let last;
  for (let i = 0; i <= max; i++) last = budget.recordRound(sid, 0);
  assert.strictEqual(last.ok, false, '应在 max+1 轮熔断');
  assert.match(last.exceeded, /rounds=/);
  // 压缩重置 → 放行
  const reset = budget.resetRoundsAfterCompaction(sid);
  assert.strictEqual(reset.ok, true);
  assert.strictEqual(reset.resets, 1);
  const snap = budget.snapshot(sid);
  assert.strictEqual(snap.rounds, 0, 'rounds 应归零');
  assert.strictEqual(snap.exceeded, null, 'exceeded 应清除');
  // 重置后能继续记 round
  assert.strictEqual(budget.recordRound(sid, 0).ok, true);
  budget.clear(sid);
});

test('续命次数耗尽 (默认 3 次) → 拒续, 保持熔断', () => {
  const sid = 'test-rescue-exhaust';
  budget.clear(sid);
  const max = budget.DEFAULTS.max_rounds;
  for (let n = 1; n <= budget.MAX_COMPACT_RESETS; n++) {
    for (let i = 0; i <= max; i++) budget.recordRound(sid, 0);
    const r = budget.resetRoundsAfterCompaction(sid);
    assert.strictEqual(r.ok, true, '第 ' + n + ' 次续命应放行');
    assert.strictEqual(r.resets, n);
  }
  // 第 4 次: 再打爆 → 拒续
  for (let i = 0; i <= max; i++) budget.recordRound(sid, 0);
  const denied = budget.resetRoundsAfterCompaction(sid);
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.reason, 'compact_resets_exhausted');
  assert.strictEqual(denied.resets, budget.MAX_COMPACT_RESETS);
  budget.clear(sid);
});

test('tokens 超限 → 压缩重置连 tokens 一起清零续命 (2026-09-14 新语义: 预算=活跃窗口燃烧, 不终身累计)', () => {
  const sid = 'test-rescue-tokens';
  budget.clear(sid);
  // 直接灌爆 tokens (走 recordRound 的 tokens 参数)
  budget.recordRound(sid, budget.DEFAULTS.max_tokens + 1);
  const r = budget.resetRoundsAfterCompaction(sid);
  assert.strictEqual(r.ok, true, 'tokens 应随压缩一起重置, 不再终身封顶 (易经消化会话 506k 被杀实案)');
  const snap = budget.snapshot(sid);
  assert.strictEqual(snap.tokens, 0, 'tokens 应归零');
  assert.strictEqual(snap.exceeded, null, 'exceeded 应清除');
  budget.clear(sid);
});

test('续命次数耗尽但有实质进展 (checkpoint 真写盘增长) → 不耗额度放行; 无进展 → 熔断', () => {
  const sid = 'test-rescue-progress';
  budget.clear(sid);
  const tc = require('../modules/task_checkpoint');
  const max = budget.DEFAULTS.max_rounds;
  const burst = () => { for (let i = 0; i <= max; i++) budget.recordRound(sid, 0); };
  // 先耗尽 3 次续命额度 (无 checkpoint → 无进展 → 每次都耗)
  for (let n = 1; n <= budget.MAX_COMPACT_RESETS; n++) {
    burst();
    assert.strictEqual(budget.resetRoundsAfterCompaction(sid).ok, true, '第 ' + n + ' 次续命应放行');
  }
  // 第 4 次: 无进展 → 熔断
  burst();
  const denied = budget.resetRoundsAfterCompaction(sid);
  assert.strictEqual(denied.ok, false, '无进展时额度耗尽必须熔断 (防打转)');
  assert.strictEqual(denied.reason, 'compact_resets_exhausted');
  // 有进展: checkpoint 写盘数 0 → 2 → 放行且不耗额度
  tc.saveTaskCheckpoint(sid, { goal: '长任务', status: 'active', files_touched_count: 2 });
  const rescued = budget.resetRoundsAfterCompaction(sid);
  assert.strictEqual(rescued.ok, true, '有真写盘进展必须放行 — 预算防打转, 不惩罚干活的长任务');
  assert.strictEqual(rescued.resets, budget.MAX_COMPACT_RESETS, '有进展不耗额度');
  assert.strictEqual(rescued.progress, true);
  // 再来一轮: 进展继续 (2 → 5) → 仍放行
  burst();
  tc.saveTaskCheckpoint(sid, { files_touched_count: 5 });
  assert.strictEqual(budget.resetRoundsAfterCompaction(sid).ok, true, '持续有进展持续放行');
  // 打转: 写盘数不动 → 额度已耗尽 → 熔断
  burst();
  const denied2 = budget.resetRoundsAfterCompaction(sid);
  assert.strictEqual(denied2.ok, false, '进展停滞后额度耗尽照样熔断');
  budget.clear(sid);
});
