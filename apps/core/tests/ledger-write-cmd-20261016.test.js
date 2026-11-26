// 2026-10-16 账本只认 > >> tee: cp/touch 造的文件全在账外 (现场 lt3)
//
// 实机 5 步长任务: 子 agent 的账本里 files_written 只有 u1.txt (write_file) 和
// u2.txt (echo > 重定向), 而它真做的还有:
//   mkdir -p … && touch u1.txt … u5.txt   → 5 个文件, 账上一个都没有
//   cp u1.txt u3.txt                       → 真写了, 账上还是没有
// 于是 task_done 被拒 2 次 (LEDGER_MISS count=2), 子 agent 白跑两轮工具调用去
// 补一个"账认的写盘" —— 每轮都是一次完整 LLM 往返 (本地 27B 一轮 ~33s)。
//
// 但真正的问题不是"少记几条", 是账本的角色: 它是**反幻觉的锚**。
// 锚把真写盘判成没写, 等于告诉模型"如实汇报会被拒" —— 那是在训练它改口。
// 锚宁可宽不可窄: claim 侧还有 mtime 兜底 + basename 归一, 两头都不放过真写盘。
//
// 这组测试两头都锁: 真写盘要记进来 (F1/F3/F4), 读命令绝不许被记成写 (F2),
// 以及最要紧的 —— **真幻觉仍然必须被抓出来** (F5/F6)。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');
const os = require('os');

const L = require(path.join(__dirname, '..', 'modules', 'task_ledger.js'));

let _n = 0;
const sid = () => 'wcmd-' + Date.now() + '-' + (_n++);
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-ledger-'));

const wrote = (sessionId) => {
  const l = L.loadLedger(sessionId);
  return ((l && l.facts && l.facts.files_written) || []).map(x => x.path);
};
const run = (command, sessionId) => {
  L.recordToolResult(sessionId || sid(), 'exec_command', { command }, { ok: true });
  return wrote(sessionId);
};

// ===== F1. 真写盘要记进来 =====

test('F1 cp / mv / touch / install / dd / sed -i 造的文件都要记账', () => {
  const s = sid();
  const d = dir();
  const got = run('cd ' + d + ' && touch u1.txt u2.txt && cp u1.txt u3.txt && mv u3.txt u4.txt && sed -i s/a/A/ u1.txt && dd if=/dev/zero of=blob.bin bs=1 count=4', s);
  for (const want of [d + '/u1.txt', d + '/u2.txt', d + '/u4.txt', d + '/blob.bin']) {
    assert.ok(got.includes(want), '漏记 ' + want + ' (实得 ' + JSON.stringify(got) + ')');
  }
  // cp 的中间产物 u3.txt 被 mv 走了, 记不记都行, 但不能凭空多出一条不存在的东西
  for (const p of got) {
    assert.ok(!/[())\s]$/.test(p), '路径带了包装符: ' + p);
  }
});

test('F2 读命令一条都不许被记成写 (账本是尺子, 尺子不能自己造证据)', () => {
  const s = sid();
  for (const cmd of [
    'cd /tmp && ls -la && cat a.txt && wc -l b.txt',
    'cat a.txt | grep foo | wc -l',
    'ls 2>&1 | head -5',
    'find /tmp -name "*.txt" -newer a.txt',
    'git checkout -- src/app.js',
    'rsync -a src/ dest/',
    'sed s/a/A/ /tmp/s.txt',           // 没有 -i, 不改文件
    'echo "/tmp/fake.txt"',            // 只是回显
    'cd /tmp && install --help',       // 没有源和目标
  ]) {
    const before = wrote(s).length;
    L.recordToolResult(s, 'exec_command', { command: cmd }, { ok: true });
    assert.strictEqual(wrote(s).length, before, '这条被记成写盘了: ' + cmd);
  }
});

test('F3 路径带空格 / 子 shell / 命令替换都不能把路径算错', () => {
  const s = sid();
  const d = dir();
  const got = run('cd ' + d + ' && (touch sub1.txt) && `touch bt.txt` && touch "/tmp/x y.txt" && cp "/tmp/a b.txt" "/tmp/c d.txt"', s);
  for (const want of [d + '/sub1.txt', d + '/bt.txt', '/tmp/x y.txt', '/tmp/c d.txt']) {
    assert.ok(got.includes(want), '漏记 ' + want + ' (实得 ' + JSON.stringify(got) + ')');
  }
  assert.ok(!got.some(p => /[()`)]$/.test(p)), '路径尾部带了包装符: ' + JSON.stringify(got));
});

test('F4 cp 到 /dev/null 不记账 (那是伪写盘)', () => {
  const s = sid();
  assert.strictEqual(run('cp /tmp/a /dev/null', s).length, 0);
});

// ===== F5/F6. 关键: 牙没松 =====

test('F5 lt3 现场: summary 写简写路径 /u3.txt, 文件真由 cp 建在本轮 → 不许判无据', () => {
  const s = sid();
  const d = dir();
  const started = Date.now();
  // 让账本的 runStart 落在建文件之前
  L.recordToolResult(s, 'exec_command', { command: 'cd ' + d + ' && cp u1.txt u3.txt' }, { ok: true });
  fs.writeFileSync(path.join(d, 'u3.txt'), 'alpha\nbeta\ngamma\n');
  const lateStart = started - 1000;   // _runStartedAt 取账本 birthtime, 这里只要保证不早于即可
  assert.ok(fs.statSync(path.join(d, 'u3.txt')).mtimeMs >= lateStart);
  // 声称写盘, 但用的是简写形式 (模型很常这么写: "u1.txt 复制到 /u3.txt")
  const r = L.checkDeliveryClaims(s, '① 完成: u1.txt 已复制到 /u3.txt, 写入完成。', { toolsThisRun: 3 });
  assert.ok(!r, '真写过的文件被判成"账上无据"了 —— 这就是 lt3 那两次白跑: ' + JSON.stringify(r));
});

test('F6 牙必须还在: 压根不存在的路径被声称写盘 → 进幻觉名单 (比 missed 更狠的一层)', () => {
  const s = sid();
  const d = dir();
  // 造一个"本轮写过别的文件"的环境, 让 basename 兜底有机会误放行 —— 它不该
  fs.writeFileSync(path.join(d, 'other.txt'), 'x');
  L.recordToolResult(s, 'exec_command', { command: 'cd ' + d + ' && touch other.txt' }, { ok: true });
  const r = L.checkDeliveryClaims(s, '已写入 ' + d + '/never_written.md, 交付完成', { toolsThisRun: 3 });
  // 不存在的路径走的是 normalizeClaimPath → 记 paths_missing 这条路 (模型随后会被
  // 告知"这路径不存在, 别再试"), 不是 missed。断言真实行为, 不改机制迎合断言。
  const l = L.loadLedger(s);
  const miss = ((l && l.facts && l.facts.paths_missing) || []).map(x => x.path);
  assert.ok(miss.some(p => p.endsWith('never_written.md')),
    '编造的路径没进幻觉名单 —— 反幻觉的牙松了 (paths_missing=' + JSON.stringify(miss) + ', r=' + JSON.stringify(r) + ')');
  assert.ok(!r, '幻觉路径不该再出现在 missed 里, 免得对账话术把它说成"可能存在"');
});

test('F6b 牙必须还在: 文件本来就存在但本轮没动过 → 不许说成本轮新产出', () => {
  const s = sid();
  const d = dir();
  // 老文件: mtime 早于账本 birthtime, 所以 _writtenDuringRun 判 false
  const old = path.join(d, 'pre_existing.md');
  fs.writeFileSync(old, 'last week');
  const oldT = Date.now() - 7 * 24 * 3600 * 1000;
  fs.utimesSync(old, oldT / 1000, oldT / 1000);
  const other = path.join(d, 'touched_this_run.txt');
  fs.writeFileSync(other, 'x');
  L.recordToolResult(s, 'exec_command', { command: 'touch ' + other }, { ok: true });
  const r = L.checkDeliveryClaims(s, '已写入 ' + old + ', 交付完成', { toolsThisRun: 2 });
  assert.ok(r && r.missed && r.missed.length,
    '本轮没碰过的老文件被当成本轮新产出放过了 —— 这正是对账制要抓的那一种');
});

test('F7 牙还���在: 读过的源文件不能被说成本轮新产出', () => {
  const s = sid();
  const d = dir();
  fs.writeFileSync(path.join(d, 'src.txt'), 'original');
  // 本轮只读了它, 一个字节都没改
  L.recordToolResult(s, 'read_file', { path: path.join(d, 'src.txt') }, { ok: true, data: { content: 'original' } });
  const r = L.checkDeliveryClaims(s, '已写入 ' + d + '/src.txt, 交付完成', { toolsThisRun: 2 });
  assert.ok(r && r.missed && r.missed.length, '读过的文件被当成本轮新产出放过了');
});

test('F8 结构性: 解析不出目标就一条都不记 (宁可漏, 不造假)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'task_ledger.js'), 'utf8');
  const fn = src.match(/function _shellWriteTargets[\s\S]*?\n}/);
  assert.ok(fn, '找不到 _shellWriteTargets');
  assert.ok(/catch \(_\) \{ \/\* 解析不了就不记, 不猜 \*\/ \}/.test(fn[0]),
    '解析失败必须静默不记, 不能抛也不能硬猜');
  assert.ok(/default: break;/.test(fn[0]), '未知命令必须走 default 不记, 不能落进某个已知分支');
});
