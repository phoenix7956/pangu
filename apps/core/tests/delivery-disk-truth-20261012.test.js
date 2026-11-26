const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkDeliveryClaims, _runStartedAt, _writtenDuringRun } = require('../modules/task_ledger');

// ─────────────────────────────────────────────────────────────────────────────
// 实案 longtask-02-20261012 第 5 步: 汇总报告真写了 6693 字节, 内容也对
// (引用了第 1-4 步的真实产物), 但记账只认 write_file 的 path 参数和 exec_command 里的
// shell 重定向/tee, 认不出 heredoc 里的脚本写盘:
//     python3 - <<'EOF'
//     open('/tmp/longtask_report_20261012.md','w').write(...)
//     EOF
// 于是账上无据 → 对账把这次正确交付拦成 FAKE_DELIVERY →
// "第 5 步因缺少报告写盘凭据被拦截, 尚不能交付"。
//
// 账本枚举不出 shell 的所有写盘方式, 磁盘才是真源: 本轮开始后被改写过的文件就是本轮产出。
// 老文件 (mtime 早于本轮) 照样拦 —— 幻觉保护一点没放松。
// ─────────────────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-delivery-'));
const HOUR = 3600 * 1000;

function newSession() {
  // 先建账本文件 —— 它代表"这一轮开始" (模块自己的 _runStartedAt 就拿它的创建时间)
  const sid = 'test-delivery-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  // 2026-10-26 第 100 批: 沙箱里这个目录是新建的 (生产 ~/.pangu/state/ledger 一直存在,
// 所以以前不用建) ⇒ 写之前先 mkdir。
  fs.mkdirSync(require('../modules/state_paths').ledgerDir(), { recursive: true });
  fs.writeFileSync(
    path.join(require('../modules/state_paths').ledgerDir(),
      sid.replace(/[^\w.-]/g, '_') + '.json'),
    JSON.stringify({ session_id: sid, goal: '', facts: { files_read: [], files_written: [], dirs_seen: [], paths_missing: [], cmds_failed: [] } }),
  );
  return sid;
}

test('账上没记, 但文件是本轮写出来的 → 不能拦 (heredoc 写盘回归)', () => {
  const sid = newSession();
  const start = _runStartedAt(sid);
  assert.ok(start > 0, '应能取到本轮开始时间');

  const f = path.join(TMP, 'heredoc_report.md');
  fs.writeFileSync(f, '# 报告\n真写了');
  // mtime 明确落在本轮开始之后
  fs.utimesSync(f, new Date(start + 60 * 1000), new Date(start + 60 * 1000));

  const claim = '已写入 ' + f;
  const r = checkDeliveryClaims(sid, claim, { toolsThisRun: 1 });
  assert.equal(r, null, `本轮真写出来的文件不该被拦: ${JSON.stringify(r)}`);
});

test('老文件冒充本轮产出 → 照样拦 (幻觉保护不能被放松)', () => {
  const sid = newSession();
  const start = _runStartedAt(sid);

  const f = path.join(TMP, 'old_file.md');
  fs.writeFileSync(f, '# 上周就写好的\n');
  // mtime 远早于本轮开始 = 只是被读了, 不是本轮写的
  fs.utimesSync(f, new Date(start - 10 * HOUR), new Date(start - 10 * HOUR));

  const r = checkDeliveryClaims(sid, '本轮已写入 ' + f, { toolsThisRun: 1 });
  assert.ok(r, '老文件声称本轮新写必须仍被拦');
  assert.ok(r.missed.some((m) => m.endsWith('old_file.md')), `漏报: ${JSON.stringify(r.missed)}`);
});

test('根本不存在的路径 → 记成幻觉路径 (本模块既有语义: 移出对账而不是当缺失拦截)', () => {
  const sid = newSession();
  const ghost = path.join(TMP, 'never_existed_ghost.md');
  const r = checkDeliveryClaims(sid, '已写入 ' + ghost, { toolsThisRun: 1 });
  // 设计如此: 本机不存在的路径判为幻觉, 记进 paths_missing, 不再当声称写盘证据。
  // 这条守住的是幻觉路径要留痕, 不是要拦 —— 后者是老文件的职责。
  assert.equal(r, null, '不存在的路径按既有设计被移出对账');
  const led = JSON.parse(fs.readFileSync(require('../modules/task_ledger').ledgerFile(sid), 'utf8'));
  assert.ok(led.facts.paths_missing.some((p) => p.path.endsWith('never_existed_ghost.md')),
    '幻觉路径必须留痕到 paths_missing, 不能悄悄放过');
});

test('多个声称里只要有一个是老文件就仍然拦 (不能因为另一个是本轮产物就整体放行)', () => {
  const sid = newSession();
  const start = _runStartedAt(sid);
  const good = path.join(TMP, 'good.md');
  fs.writeFileSync(good, 'ok');
  fs.utimesSync(good, new Date(start + 60 * 1000), new Date(start + 60 * 1000));
  const stale = path.join(TMP, 'stale.md');
  fs.writeFileSync(stale, '上次的');
  fs.utimesSync(stale, new Date(start - 10 * HOUR), new Date(start - 10 * HOUR));

  const r = checkDeliveryClaims(sid, `已写入 ${good} 和 ${stale}`, { toolsThisRun: 1 });
  assert.ok(r, '只要有一个声称是本轮没写过的文件就该拦');
  assert.deepEqual(r.missed.map((m) => path.basename(m)), ['stale.md'],
    `应只报出无据的那个: ${JSON.stringify(r.missed)}`);
});

test('不是文件的路径 (目录) 不算写盘凭据', () => {
  const sid = newSession();
  const start = _runStartedAt(sid);
  const dir = path.join(TMP, 'a_dir_' + Date.now());
  fs.mkdirSync(dir);
  fs.utimesSync(dir, new Date(start + 60 * 1000), new Date(start + 60 * 1000));
  assert.equal(_writtenDuringRun(dir, start), false, '目录不是写盘凭据');
});

test('没有本轮开始时间时, 磁盘兜底不生效 (宁可保守, 不乱放行)', () => {
  assert.equal(_runStartedAt('no-such-session-at-all-' + Date.now()), 0);
  const f = path.join(TMP, 'anything.md');
  fs.writeFileSync(f, 'x');
  assert.equal(_writtenDuringRun(f, 0), false, '取不到本轮起点就不能拿 mtime 当证据');
});

test('没有写盘措辞的普通答复不受对账影响', () => {
  const sid = newSession();
  assert.equal(checkDeliveryClaims(sid, '今天贵州茅台的走势偏弱, 建议观望。', { toolsThisRun: 1 }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 实案 longtask-03-20261012 第 3 步: analyzer 只是"筛选超 500 行的文件", 它终局文本里
// 提到了上游第 2 步 (executor) 真写出来的 /tmp/longtask_js_loc_20261012.txt。
// analyzer 自己的账本比上游那份晚建 → mtime 早于"本轮开始" → 被当成旧文件拦成 partial。
// 但从用户视角这是一轮, 上游兄弟的产物就是这一轮的产物 (最终会被一起交付)。
// 所以锚点必须取**整个调度轮最早**的账本, 不是某一个子 agent 的。
// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-26 第 100 批: 账本目录走唯一真源 (modules/state_paths.js)
//   原来这里自己拼 PANGU_HOME/state/ledger ⇒ 沙箱没导走 ⇒ 每跑一次链
//   就往生产 ~/.pangu/state/ledger 写一批 test-delivery-* 文件 (实测 12 个/次)。
const LEDGER_DIR = require('../modules/state_paths').ledgerDir();

function mkSubLedger(parent, tag, birthIso) {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  const f = path.join(LEDGER_DIR, parent.replace(/[^\w.-]/g, '_') + '_' + tag + '.json');
  fs.writeFileSync(f, JSON.stringify({ session_id: parent + '#' + tag, facts: {} }));
  const t = new Date(birthIso);
  fs.utimesSync(f, t, t);
  return f;
}

test('调度轮锚点取最早兄弟账本: 上游兄弟写的产物对下游不再算旧文件', () => {
  const parent = 'test-turn-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const t0 = Date.now() - 60 * 1000;
  mkSubLedger(parent, 'sub-0-executor', new Date(t0).toISOString());        // 上游, 先建
  mkSubLedger(parent, 'sub-2-analyzer', new Date(t0 + 30 * 1000).toISOString()); // 下游, 晚建

  const downstream = parent + '#sub-2-analyzer';
  const anchor = _runStartedAt(downstream);
  assert.ok(anchor <= t0 + 1000, `锚点应取最早那份账本, 实际 ${new Date(anchor).toLocaleTimeString()}`);

  // 上游 executor 在 t0+10s 写的产物
  const f = path.join(TMP, 'upstream_artifact.txt');
  fs.writeFileSync(f, '上游产物');
  fs.utimesSync(f, new Date(t0 + 10 * 1000), new Date(t0 + 10 * 1000));
  assert.equal(_writtenDuringRun(f, anchor), true, '上游兄弟的产物应算本轮产物');
});

test('锚点扩到整轮后, 真正的老文件依然被拦 (幻觉保护不受影响)', () => {
  const parent = 'test-turn-old-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const t0 = Date.now() - 600 * 1000;
  mkSubLedger(parent, 'sub-0-executor', new Date(t0).toISOString());
  const anchor = _runStartedAt(parent + '#sub-2-analyzer');

  const f = path.join(TMP, 'ancient_artifact.md');
  fs.writeFileSync(f, '上古产物');
  fs.utimesSync(f, new Date(t0 - 10 * HOUR), new Date(t0 - 10 * HOUR));
  assert.equal(_writtenDuringRun(f, anchor), false, '早于整轮的老文件仍必须被拦');
});
