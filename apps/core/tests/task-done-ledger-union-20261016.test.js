const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const taskLedger = require('../modules/task_ledger');
const { checkDeliveryClaims, loadLedger, recordToolResult, collectWrittenFiles } = taskLedger;

// ─────────────────────────────────────────────────────────────────────────────
// 实案 live-030634 (2026-10-16): 主 agent 把两个子任务派下去, 子 agent 各自真写了
// m.txt / n.txt (账上 files_written 有, 磁盘上也在, 内容也对), 子 agent 自己的
// task_done 顺利验收。轮到主 agent 汇报时, 被 task_done 守门拒了:
//
//     [j2-native] TASK_DONE_LEDGER_REJECT: summary 声称写盘但账上无据:
//       /tmp/pangu-live-030634/m.txt, /n.txt
//
// 机制: 那道门是另写的一份对账, 用 loadLedger(_sessionId) 只查自己那本账。
// 而 dispatch 路径的父会话根本不经过 j2 主循环, 没有自己的账本文件,
// 写盘全在 <parent>_sub-N-role 各一本里 (task_ledger 10-13 已经为此修过一次,
// 但只修了 checkDeliveryClaims 一侧, 这条旁路没跟着改)。
// 后果不只是多烧一个补救轮次: 回灌话术逼主 agent "只报账上确认的本轮产出",
// 于是**子任务的交付被从汇报里删掉** —— 主 agent 报上来的东西永远缺一块。
//
// 定式: "本轮真写盘" 只有一个真源 = 父账本 ∪ 全部子账本。任何自写一份比对、
// 直接 loadLedger 就算数的门, 都是同一个坑的下一个入口。
// ─────────────────────────────────────────────────────────────────────────────

// 2026-10-26 第 100 批: 账本目录走唯一真源 (modules/state_paths.js)
//   原来这里自己拼 PANGU_HOME/state/ledger ⇒ 沙箱没导走 ⇒ 测试账本写进生产。
const LEDGER_DIR = require('../modules/state_paths').ledgerDir();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-tdone-union-'));
const made = [];

function parentSid() {
  const sid = 'tdone-union-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  made.push(sid.replace(/[^\w.-]/g, '_') + '.json');
  return sid;
}

function childSid(parent, n, role) {
  const sid = parent + '#sub-' + n + '-' + role;
  made.push(sid.replace(/[^\w.-]/g, '_') + '.json');
  return sid;
}

function writeReal(sid, tool, params, result) {
  recordToolResult(sid, tool, params, result);
}

test.after(() => {
  for (const f of made) { try { fs.unlinkSync(path.join(LEDGER_DIR, f)); } catch (_) {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test('父会话没有账本, 子 agent 真写的产物 → 主 agent 汇报不该被拦 (live-030634 回归)', () => {
  const p = parentSid();
  const m = path.join(TMP, 'm.txt');
  const n = path.join(TMP, 'n.txt');
  fs.writeFileSync(m, 'm');
  fs.writeFileSync(n, 'n');

  // 两个子 agent 各自记账 —— 写盘只发生在子会话里, 父会话一份账都没有
  writeReal(childSid(p, 0, 'executor'), 'exec_command',
    { command: `printf m > ${m} && printf n > ${n}` }, { ok: true, data: { exit_code: 0 } });

  // 前提: 父会话自己确实没有账本 (旧旁路 loadLedger 在这里拿到的是 null)
  assert.equal(loadLedger(p), null, '父会话不该有自己那本账, 否则这个回归测不到根因');

  const claim = `两个子任务都已完成, 产出 m.txt (内容 m) 与 n.txt (内容 n) 已落盘在 ${TMP}`;
  const r = checkDeliveryClaims(p, claim, { toolsThisRun: 2 });
  assert.equal(r, null, `子 agent 真写的产物不该判无据: ${JSON.stringify(r)}`);

  // 合并视图也要能看到它们 (单一真源)
  const seen = collectWrittenFiles(p).map(w => w.path);
  assert.ok(seen.some(x => x.endsWith('m.txt')), '合并账本应含 m.txt');
  assert.ok(seen.some(x => x.endsWith('n.txt')), '合并账本应含 n.txt');
});

test('真写的放行 / 老文件冒充本轮产出仍然被拦 — 单一真源不等于放宽幻觉保护', () => {
  const p = parentSid();
  // 子 agent 只真写了 real_m.txt
  writeReal(childSid(p, 0, 'executor'), 'write_file',
    { path: path.join(TMP, 'real_m.txt') }, { ok: true, data: { path: path.join(TMP, 'real_m.txt') } });

  // 老文件存在, 但 mtime 早于本轮 —— 冒充"本轮新产出"必须被拦 (幻觉保护一点没放松)
  const old = path.join(TMP, 'preexisting_source.txt');
  fs.writeFileSync(old, '早就在这了');
  fs.utimesSync(old, new Date(Date.now() - 3600 * 1000), new Date(Date.now() - 3600 * 1000));

  const r = checkDeliveryClaims(p, `已落盘 ${path.join(TMP, 'real_m.txt')} 和 ${old}`, { toolsThisRun: 1 });
  assert.ok(r && r.missed && r.missed.length, '冒充本轮产出的老文件必须仍被拦');
  assert.ok(r.missed.some(x => x.endsWith('preexisting_source.txt')), `该拦的是老文件: ${JSON.stringify(r.missed)}`);
  assert.ok(!r.missed.some(x => x.endsWith('real_m.txt')), '真写的不该被误伤');
});

test('声称一个根本不存在的路径 → 记进 paths_missing 幻觉名单 (不是"写盘无据")', () => {
  const p = parentSid();
  writeReal(childSid(p, 0, 'executor'), 'write_file',
    { path: path.join(TMP, 'real_m2.txt') }, { ok: true, data: { path: path.join(TMP, 'real_m2.txt') } });
  const ghost = path.join(TMP, 'ghost_never_written.txt');
  const r = checkDeliveryClaims(p, `已落盘 ${path.join(TMP, 'real_m2.txt')} 和 ${ghost}`, { toolsThisRun: 1 });
  assert.equal(r, null, `不存在路径走幻觉名单, 不该当写盘无据: ${JSON.stringify(r)}`);
  const L = loadLedger(p);
  const miss = ((L && L.facts && L.facts.paths_missing) || []).map(x => x.path);
  assert.ok(miss.some(x => x.endsWith('ghost_never_written.txt')), `幻觉路径应被记账: ${JSON.stringify(miss)}`);
});

test('源级: task_done 守门走 checkDeliveryClaims, 不再自己 loadLedger 比对', () => {
  const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const src = SRC('modules/j2_agent_loop.js');
  // 抓 task_done 守门这一段 (从注释锚点到拒收分支)
  const start = src.indexOf('task_done 声称的写盘必须账上有据');
  const end = src.indexOf('TASK_DONE_LEDGER_REJECT', start);
  assert.ok(start > 0 && end > start, '定位不到 task_done 对账段, 源码结构变了?');
  // 只看代码行 —— 注释里写着 "原来是 loadLedger(...)" 是这段事故史, 不该被当成调用
  const code = (s) => s.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const seg = code(src.slice(start, end));
  assert.ok(seg.includes('checkDeliveryClaims'), 'task_done 守门必须走单一真源 checkDeliveryClaims');
  assert.ok(!/loadLedger\(/.test(seg), `task_done 守门不该再直接 loadLedger: ${seg.match(/loadLedger\([^)]*\)/g)}`);
  // 拒收日志那一行也要看合并账, 不然打出来是"(无)"
  const logLine = code(src.slice(src.indexOf('TASK_DONE_LEDGER_REJECT') - 400, src.indexOf('TASK_DONE_LEDGER_REJECT')));
  assert.ok(logLine.includes('collectWrittenFiles'), '拒收日志的"账上真实写盘"应取合并账');
});
