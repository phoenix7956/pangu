// 2026-10-13 压缩续命的"有进展"判据读错了数据源 (budget.js 绕过了已修好的读取口)
//
// 现场: 4 个真实长任务会话 (pcheck-1791823545 / pcheck-1791823788 / r13-live /
// longwork-1791823116) 的 checkpoint 情况全是 **父 checkpoint 0 个, 子 checkpoint 4~7 个**。
// 走 dispatcher 的父会话不经过 j2_agent_loop, 自己不落 checkpoint —— 只有子 agent 各有一份。
//
// budget.js 的 resetRoundsAfterCompaction 直接读:
//   loadTaskCheckpoint(sessionId).files_touched_count
// 父会话这一读恒为 undefined → filesNow 恒 0 →
//   _progress = filesNow > filesAtLast && filesNow > 0   ← 结构性恒 false
// 于是**每次压缩都扣一次续命额度**, 扣满 PANGU_BUDGET_MAX_COMPACT_RESETS
// (本机活进程 = 10) 会话永久死 —— 正是这行注释自己写的:
//   "tokens 一碰 500k 终身封顶, 会话永久死 ('请新建 session') = 惩罚有进展的长任务"
//
// 讽刺之处: ee2bf33 / 4ddc373 已经把 countFilesTouched 修成"父 + 子账本一起算",
// budget.js 却在直接读原始 checkpoint, 绕过了这个修复。
// 同一类毛病今天已经犯第三次 (只修生产者不修消费者), 测试要钉住消费者。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 断言前先剥注释。今天栽过两次: 注释里写了什么代码字面量, 全文断言就被注释顶住,
// 回归锁变成"注释在就绿"的假锁。剥掉注释再断言, 这类脆弱性一次根除。
// 已知局限: 字符串里含 '//' (如 URL) 会被当成行注释截断 —— 本文件断言的锚点都不含 '//'。
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .map(l => l.replace(/\/\/.*$/, '')).join('\n');
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-budget-'));
process.env.PANGU_HOME = TMP;
// 2026-10-26 第 100 批: 账本目录走唯一真源 (modules/state_paths.js),
// 解析顺序 PANGU_LEDGER_DIR > PANGU_HOME/state/ledger > 生产默认。
// 只设 PANGU_HOME 会被链沙箱里的 PANGU_LEDGER_DIR 抢在前面 ⇒ 账本落到共享沙箱目录,
// 本测试的隔离意图 (自己的 TMP) 就没了。
process.env.PANGU_LEDGER_DIR = path.join(TMP, 'state', 'ledger');
// 必须在 require budget 之前设 —— MAX_COMPACT_RESETS 是模块加载时读的
process.env.PANGU_BUDGET_MAX_COMPACT_RESETS = '3';

const ledger = require('../modules/task_ledger');
const budget = require('../modules/budget');

const SID = 'budget-1';

// 真实形态: 父会话没有 checkpoint, 写盘全记在子 agent 账本里
//
// ⚠️ 文件名必须**全局唯一**, 不能用 `Date.now()` (2026-10-21 修的 flaky):
//   原写法 `/tmp/b${Date.now()}_${i}.txt` 只有毫秒精度。本文件里有三处
//   writeViaChild/recordToolResult, 同一毫秒内跑就会生成**同名文件**,
//   而 `countDistinctWrittenFiles` 数的是**去重后**的文件数 ——
//   于是计数塌掉, 断言偶发失败(实测 1/60 量级)。
//
//   注意: **产品代码是对的**, 重复写同一个文件本来就只该算一次
//   (见 task_ledger.countDistinctWrittenFiles 的注释: 事件数会被"反复重写
//   同一批文件"灌水)。所以该修的是夹具的文件名, 不是去重逻辑。
let _seq = 0;
function writeViaChild(n) {
  for (let i = 0; i < n; i++) {
    _seq += 1;
    ledger.recordToolResult(SID + '#sub-0-executor', 'exec_command',
      { command: `cd /tmp && echo x > /tmp/b${process.pid}_${_seq}.txt` }, { ok: true, data: {} });
  }
}

test('前提: 该会话没有父 checkpoint (生产形态)', () => {
  writeViaChild(2);
  assert.strictEqual(require('../modules/task_checkpoint').loadTaskCheckpoint(SID), null,
    '走 dispatcher 的父会话不该有 checkpoint');
});

test('子 agent 有真写盘时, 压缩续命必须认得出"有进展", 不扣额度', () => {
  // 四次压缩 (MAX=3, 熔断是"先判 >= MAX 再自增", 所以第 4 次才是踩线那次)。
  // 每次之间都真的有新写盘 —— 正是"干了两天活的长会话"的样子。
  // 旧实现下 4 次里必然有一次被拒, 因为 filesNow 恒 0 恒判无进展。
  for (let i = 0; i < 4; i++) {
    writeViaChild(1);
    const r = budget.resetRoundsAfterCompaction(SID);
    assert.equal(r.ok, true,
      `第 ${i + 1} 次压缩续命被拒: ${JSON.stringify(r)} —— 有真写盘却扣额度, 扣满就会"会话永久死"`);
  }
});

test('额度不会被这些续命吃掉', () => {
  const b = budget.getBudget(SID);
  assert.ok((b.compactResets || 0) <= 1,
    '连续有进展的压缩不该累积消耗 compactResets, 实际=' + b.compactResets);
});

test('真的原地打转 (无任何写盘) 时仍要扣额度并最终熔断', () => {
  const SID2 = 'budget-2';
  let last = null;
  for (let i = 0; i < 5; i++) last = budget.resetRoundsAfterCompaction(SID2);
  assert.equal(last.ok, false, '没有任何写盘却永不熔断 = 无限续命');
  assert.equal(last.reason, 'compact_resets_exhausted');
});

test('接线: budget.js 的进展判据必须 checkpoint 与账本取并集 (不是二选一)', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '../modules/budget.js'), 'utf8'));
  // 两种真实会话形态都还在生产里:
  //   ① checkpoint 读数: 单 agent / j2 会话 (有这份文件; budget-rescue.test.js 就是这个形态)
  //   ② 账本读数: dispatcher 父会话 (压根没有这份文件 —— 就是本轮要修的那个)
  // 只留 ② 会打破 budget-rescue (丢旧信号); 只留 ① 则长任务父会话恒判无进展 → 会话永久死。
  assert.match(src, /loadTaskCheckpoint\(sessionId\)/,
    '必须保留 checkpoint 读数 (单 agent / j2 会话的真会话形态)');
  assert.match(src, /countFilesTouched\(sessionId/,
    '必须补上账本读数 (dispatcher 父会话没有 checkpoint, 不补就恒判无进展)');
  assert.match(src, /Math\.max\(\s*_cpFiles\s*,/,
    '两个读数必须取并集 (都单调不减, max 即并集); 二选一都会打破另一种真会话');
});
test('前提: 父会话没有 checkpoint 时, countFilesTouched 仍能数出子 agent 的真写盘', () => {
  const SID3 = 'budget-3';
  _seq += 1;
  ledger.recordToolResult(SID3 + '#sub-0-executor', 'exec_command',
    { command: `cd /tmp && echo x > /tmp/c_${process.pid}_${_seq}.txt` }, { ok: true, data: {} });
  assert.strictEqual(require('../modules/task_checkpoint').loadTaskCheckpoint(SID3), null);
  const n = require('../modules/task_checkpoint').countFilesTouched(SID3, []);
  assert.ok(n > 0,
    '子 agent 真写盘却数出 0 个 → 任何"有进展"判据接这个口都会恒 false, 实际=' + n);
});

// ═══ j2 那处: 2026-10-13 现场推翻过一次 ═══
//
// 同一轮里我照着 budget.js 的思路, 把 j2_agent_loop 的续命判据也改成"直接活读账本"
// (countFilesTouched), 理由听上去一样: "别读缓存"。**被 guard_e2e_scenarios 打脸**:
//   budget.js=我的 / j2=HEAD → 6 绿      ← 真修复, 干净
//   budget.js=HEAD / j2=我的 → 3 红 S2/S2b/S4
//   两边都HEAD              → 6 绿        ← 干净基线, 证明是本轮引入
// 而 j2 根本不跟 budget.js 一个毛病 —— 它的 checkpoint 字段是**它自己每轮写的**
// (同函数内 1128 行: files_touched_count: _files, 而 _files = tc.countFilesTouched(...)),
// 读的不是"外部脏数据", 是自己的账本投影。绕开它改活读, 判据的尺子和基线就错位了。
//
// 所以真 bug 只有一个: budget.js 的**父会话压根没有 checkpoint 文件** (dispatcher 父
// 不走 j2 循环), 读一个不存在的文件恒得 undefined。这两处的差别不在"缓不缓存",
// 在"这个文件到底存不存在"。
test('j2 的续命判据读的是 j2 自己写进 checkpoint 的那个计数', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8'));
  assert.match(src,
    /const _filesNow = \(typeof _prev\.files_touched_count === 'number'\) \? _prev\.files_touched_count : 0;/,
    '续命判据的读数应来自 checkpoint 里 j2 自己写的字段');
});

test('j2 存回去的基线跟比较用的是同一个字段', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8'));
  assert.match(src,
    /files_at_last_resume: \(typeof _prev\.files_touched_count === 'number'\) \? _prev\.files_touched_count : 0,/,
    '基线和读数不同源 → 差值恒无意义, 这正是 2026-10-13 打脸那版的病根');
});

test('j2 写进 checkpoint 的那个计数必须来自账本真源', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8'));
  // 2026-10-13 更新: 账本真源不变 (仍是 task_ledger, ee2bf33/4ddc373), 但投影换了 ——
  // countFilesTouched 数**写盘事件数**, 子 agent 把同一批文件重写 100 多次就能灌水
  // (现场 resume-live-1791876482: done 0→0 而 files 12→130, 每轮都判成有进展,
  //  预算反复重置 → 锁死在重复循环里)。改用 countDistinctFilesTouched 数**不同文件数**,
  // 它同样读 task_ledger 的去重路径集, 事件数另存 files_touched_events 作观测。
  assert.match(src, /const _files = tc\.countDistinctFilesTouched\(_sessionId, toolsUsed\);/,
    '缓存若不来自账本去重投影, 读它就等于读一个跟账本脱钩的数 (ee2bf33/4ddc373 的账本真源)');
  assert.match(src, /files_touched_count: _files,/,
    'checkpoint 里存的必须是上面那个账本计数');
});
