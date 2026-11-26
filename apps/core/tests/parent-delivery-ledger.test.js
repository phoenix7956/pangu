// 2026-10-13 父会话看不见子 agent 的产物 (现场证据 session=r10-live-2)
//
// 现场: 一个 4 子 agent 的真实会话真写了 3 个文件 (a.txt / b.txt / report.txt, 盘上已核对存在),
// 但走 dispatcher 的父会话账本文件**根本不存在** —— 只有 <parent>_sub-N-role.json 四份。
//
//   checkDeliveryClaims('r10-live-2', '已落盘 ... a.txt / b.txt / report.txt')
//     → {"missed":["a.txt","b.txt","report.txt"], "written":[]}
//   同一句话问子 agent 自己:
//     → null (无幻觉)
//
// 即: 子 agent 真写的东西, 到父会话验收时 100% 被当成幻觉 → 老板看到的"文件第一次就做对了,
// 盘古却补救两轮"。
//
// 同一根因还有两处盲区 (全代码库唯一真源都在账本, 但父会话读不到):
//   ① j2_dispatcher.js:591 recordOutcome 硬编码 artifacts: []
//      → 1023 条结局记录里只有 3 条有产物 (全是 2026-09-09 引入前), 之后整整一个月全是 0
//      → 445 条 completed 里 442 条零产物, 含真写了 3 个文件的那次
//   ② _runStartedAt 只处理"子 → 父+兄弟", 没处理"父 → 它的子"
//      → 父 sid 取到 0, _writtenDuringRun(path, 0) 恒 false, 连 mtime 兜底都失效
//
// 修法: 账本层加一个 collectWrittenFiles(sessionId) 作为"本轮真写盘"的唯一真源 ——
// 父账本 ∪ 全部 <parent>_sub-* 子账本, 按 path 去重。三处消费者都改读它。
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-deliv-test-'));
process.env.PANGU_HOME = TMP_HOME;
// 2026-10-26 第 100 批: 账本目录走唯一真源 (modules/state_paths.js),
// 解析顺序 PANGU_LEDGER_DIR > PANGU_HOME/state/ledger > 生产默认。
// 只设 PANGU_HOME 会被链沙箱里的 PANGU_LEDGER_DIR 抢在前面 ⇒ 账本落到共享沙箱目录,
// 本测试的隔离意图 (自己的 TMP) 就没了。
process.env.PANGU_LEDGER_DIR = path.join(TMP_HOME, 'state', 'ledger');

const ledger = require('../modules/task_ledger');
const tc = require('../modules/task_checkpoint');

const PARENT = 'r11-parent';
const CHILD = 'r11-parent#sub-0-executor';
const CLAIM = '已落盘三个文件: /tmp/pangu_v11/a.txt 和 /tmp/pangu_v11/b.txt, 汇总写入 /tmp/pangu_v11/report.txt。';

// 真实形态: 子 agent 用 exec_command 重定向写盘 (占全部写盘的 94.7%)
function seedChild() {
  ledger.recordToolResult(CHILD, 'exec_command',
    { command: "echo '甲' > /tmp/pangu_v11/a.txt" }, { ok: true, data: {} });
  ledger.recordToolResult(CHILD, 'exec_command',
    { command: "echo '乙' > /tmp/pangu_v11/b.txt" }, { ok: true, data: {} });
  ledger.recordToolResult('r11-parent#sub-1-executor', 'exec_command',
    { command: "echo '丙' > /tmp/pangu_v11/report.txt" }, { ok: true, data: {} });
}

test('前提: 父会话确实没有自己的账本文件 (这是现场真实形态)', () => {
  seedChild();
  assert.strictEqual(ledger.loadLedger(PARENT), null, '父账本应不存在 —— dispatcher 父会话不走 j2_agent_loop');
  assert.ok(ledger.loadLedger(CHILD), '子账本应存在');
});

test('collectWrittenFiles: 父会话能看到全部子 agent 的真写盘', () => {
  const paths = ledger.collectWrittenFiles(PARENT).map(w => w.path);
  assert.ok(paths.includes('/tmp/pangu_v11/a.txt'), '应看到 sub-0 写的 a.txt');
  assert.ok(paths.includes('/tmp/pangu_v11/b.txt'), '应看到 sub-0 写的 b.txt');
  assert.ok(paths.includes('/tmp/pangu_v11/report.txt'), '应看到 sub-1 写的 report.txt');
});

test('对账: 父会话不能再把子 agent 真写的文件判成幻觉 (文件真在盘上)', () => {
  // 关键: 必须先把文件真落盘 —— 否则 normalizeClaimPath 把不存在的路径当幻觉过滤掉,
  // 测试会因为错误的原因变绿 (今天第一版就栽在这)。
  fs.mkdirSync('/tmp/pangu_v11', { recursive: true });
  for (const f of ['a.txt', 'b.txt', 'report.txt']) {
    fs.writeFileSync('/tmp/pangu_v11/' + f, '真实内容');
    assert.ok(fs.existsSync('/tmp/pangu_v11/' + f), '前提: 文件必须真实存在');
  }
  const r = ledger.checkDeliveryClaims(PARENT, CLAIM);
  assert.strictEqual(r, null,
    '父会话对账必须放行子 agent 真写的文件, 实际却报 missed=' + JSON.stringify(r && r.missed));
});

test('对账仍要抓真幻觉: 老文件 (mtime 早于本轮) 且账上无记录 → 判 missed', () => {
  // mtime 兜底的设计本意: 本轮内被改写过的文件算真产出 (账本漏记时的兜底),
  // 但"老文件 (mtime 早于本轮) 不算"是幻觉保护。所以这里必须把 mtime 拨到本轮之前。
  fs.writeFileSync('/tmp/pangu_v11/stale.md', '上一轮的旧内容');
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync('/tmp/pangu_v11/stale.md', old, old);
  const r = ledger.checkDeliveryClaims(PARENT, '已落盘 /tmp/pangu_v11/stale.md');
  assert.ok(r && r.missed && r.missed.includes('/tmp/pangu_v11/stale.md'),
    '账上查无此文件 → 仍须判幻觉, 实际=' + JSON.stringify(r));
});

test('进展计数: 父会话的写盘进展要算上子 agent (auto_resume / budget 续命判据)', () => {
  assert.strictEqual(tc.countFilesTouched(PARENT, []), 3,
    '父会话进展计数必须包含子 agent 写盘, 否则长任务被判零进展');
});

test('去重: 同一路径父账本 + 子账本都记了只算一次', () => {
  ledger.recordToolResult(PARENT, 'write_file', { path: '/tmp/pangu_v11/a.txt' }, { ok: true, data: { path: '/tmp/pangu_v11/a.txt' } });
  const paths = ledger.collectWrittenFiles(PARENT).map(w => w.path);
  const a = paths.filter(p => p === '/tmp/pangu_v11/a.txt').length;
  assert.strictEqual(a, 1, '同一路径应去重, 实际出现 ' + a + ' 次');
});

test('接线: recordOutcome 不得再硬编码 artifacts: []', () => {
  const src = fs.readFileSync(path.join(__dirname, '../modules/j2_dispatcher.js'), 'utf8');
  assert.ok(!/artifacts:\s*\[\]\s*,/.test(src),
    'outcome 记录仍在硬编码空产物 (0201da1 引入, 一个月来 1023 条记录零产物)');
  assert.ok(/collectWrittenFiles/.test(src), 'outcome 应改读账本真源');
});

test('接线: _runStartedAt 必须锚到子账本 (父→子方向)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../modules/task_ledger.js'), 'utf8');
  // 现有实现只写了 parent = sid.split('#')[0] 的"子→父+兄弟"分支
  assert.ok(/sid\.split\('#'\)\[0\]\s*===\s*sid|_collectChildLedgers|collectWrittenFiles/.test(src),
    '父会话也要能锚到子账本');
});

test('账本漏记时 mtime 兜底仍要救父会话 (钉住 _runStartedAt 的父→子锚定)', () => {
  // 必须用一个全新的父会话: 前面的测试给 PARENT 建过账本文件, 会把"父无账本"这个
  // 生产前提消掉, 测试就因为错误的原因变绿 (今天的变异复验已经把这条钉出来了)。
  //
  // 生产形态: 走 dispatcher 的父会话没有账本文件, 只有子账本。某个子 agent 走了
  // 账本没覆盖的写盘路径, 文件确实在本轮写出来了 —— 此时唯一能救它的是 mtime 兜底,
  // 而 _runStartedAt 原来只写"子 → 父+兄弟"方向, 父 sid 取到 0, 兜底在父会话上完全失效。
  const P2 = 'r11-parent-noledger';
  ledger.recordToolResult(P2 + '#sub-0-executor', 'list_directory',
    { path: '/tmp/pangu_v11' }, { ok: true, data: { path: '/tmp/pangu_v11', entries: [] } });
  assert.strictEqual(ledger.loadLedger(P2), null, '前提: 该父会话自己没有账本 (生产形态)');

  fs.writeFileSync('/tmp/pangu_v11/unledgered.md', '账本没记到, 但真的写了');
  const r = ledger.checkDeliveryClaims(P2, '已落盘 /tmp/pangu_v11/unledgered.md');
  assert.strictEqual(r, null,
    '账本漏记但本轮真写过的文件, 应由 mtime 兜底放行, 实际=' + JSON.stringify(r));
});

// 2026-10-13 账本自身还有洞: exec_command 相对路径重定向漏记
//
// 现场 r11-live 的 sub-0 真实命令 (原样摘自 /tmp/pangu-single.log:265693):
//   cd /tmp/pangu_v10 && od -c a.txt && printf '%s' "$(cat a.txt)" > report.txt \
//     && printf '%s' "$(cat b.txt)" >> report.txt && od -c report.txt
// 账本记到 a.txt / b.txt, 但 report.txt 漏了 —— files_written_total=2 而实际写了 3 个文件。
// 根因: 重定向正则 />{1,2}\s*([~/][^\s|;&"']+)/g 只认 [~/] 开头的绝对路径。
// 盘古模型极爱 `cd X && ... > 相对文件名` (现场 5 个子 agent 里就有这一种)。
test('exec_command 相对路径重定向必须按命令里的 cd 解析后入账', () => {
  const sid = 'r12-relredir';
  ledger.recordToolResult(sid, 'exec_command', {
    command: "cd /tmp/pangu_v12 && od -c a.txt && printf '%s' \"$(cat a.txt)\" > report.txt && printf '%s' \"$(cat b.txt)\" >> report.txt",
  }, { ok: true, data: {} });
  const paths = ledger.loadLedger(sid).facts.files_written.map(w => w.path);
  assert.ok(paths.includes('/tmp/pangu_v12/report.txt'),
    'cd 后的相对重定向必须解析成绝对路径入账, 实际=' + JSON.stringify(paths));
  assert.strictEqual(paths.filter(p => p === '/tmp/pangu_v12/report.txt').length, 1,
    '>> 重复写同一文件应按 path 去重');
});

test('绝对路径重定向仍照常入账 (不能被相对路径修复带坏)', () => {
  const sid = 'r12-absredir';
  ledger.recordToolResult(sid, 'exec_command',
    { command: "cat a b > /tmp/pangu_v12/abs.txt" }, { ok: true, data: {} });
  const paths = ledger.loadLedger(sid).facts.files_written.map(w => w.path);
  assert.ok(paths.includes('/tmp/pangu_v12/abs.txt'), '绝对路径重定向不能退化');
});

test('无 cd 参照的相对重定向不臆造绝对路径', () => {
  const sid = 'r12-nocd';
  ledger.recordToolResult(sid, 'exec_command',
    { command: "echo hi > out.txt" }, { ok: true, data: {} });
  const l = ledger.loadLedger(sid);
  const paths = (l && l.facts && l.facts.files_written || []).map(w => w.path);
  // 没有 cd 参照就定位不了真实文件 —— 如实不记 (mtime 兜底仍能在对账时救场)
  assert.deepStrictEqual(paths, [],
    '没有 cd 参照时不得猜路径, 实际=' + JSON.stringify(paths));
});

test('fd 重定向不成目标, 真写盘照记 (实测钉住, 不加没证据的防御)', () => {
  const sid = 'r12-fd';
  // 捕获组字符类已排除 `&`, 所以 2>&1 / >&2 都匹配不到任何目标 —— 实测确认过。
  ledger.recordToolResult(sid, 'exec_command',
    { command: "cd /tmp/pangu_v12 && somecmd 2>&1 | tee out.log > /tmp/pangu_v12/ok.txt" }, { ok: true, data: {} });
  const paths = ledger.loadLedger(sid).facts.files_written.map(w => w.path);
  assert.ok(!paths.some(p => p && (p.includes('&1') || p.includes('&2'))),
    'fd 重定向不得入账, 实际=' + JSON.stringify(paths));
  assert.ok(paths.includes('/tmp/pangu_v12/ok.txt'), '真写盘仍要记');
  assert.ok(paths.includes('/tmp/pangu_v12/out.log'), 'tee 的相对路径也要按 cd 解析');

  // 数字开头是合法文件名, 不能被"看起来像 fd"的理由误杀
  const sid2 = 'r12-fd2';
  ledger.recordToolResult(sid2, 'exec_command',
    { command: "echo x > 2" }, { ok: true, data: {} });
  const p2 = ((ledger.loadLedger(sid2) || { facts: { files_written: [] } }).facts.files_written || []).map(w => w.path);
  assert.ok(p2.length === 0 || p2[0].endsWith('/2'), '不得凭"像 fd"误杀合法文件名, 实际=' + JSON.stringify(p2));
});
