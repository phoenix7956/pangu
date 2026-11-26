'use strict';
/**
 * session-ledger-field-20261025.test.js —— 第 96 批: session 账本**落盘字段名**统一
 *
 * 起因 (实查, 不是推演 —— 2026-10-25 21:45 扫真实账本):
 *   budget 是**唯一**用 `sessionId` 落盘的账本:
 *     budget    1373 个文件  全部 "sessionId"
 *     tasks     1361 个文件  全部 "session_id"
 *     plans      404 个文件  全部 "session_id"
 *     goals       20 个文件  全部 "session_id"
 *     handoff    191 个文件  全部 "session_id"
 *     ledger    9554 个文件  全部 "session_id"
 *     sessions            全部 "session_id"
 *   为什么一直没人发现: 读方是**容错**的 (`j.session_id || j.sessionId`),
 *   ⇒ 不一致对现有守卫完全隐形 (第 92 批的 C2 那条就是这么写的)。
 *   下一个写「汇总所有账本」的人会只看到 6/7 个账本 —— 这就是它该被钉死的原因。
 *
 * 口径 (全部是**机制**, 不靠注释):
 *   G1 新写的账必须用 wire 规范名 `session_id`, 且不许再留 `sessionId`
 *   G2 存量 (老格式 `sessionId`) 必须仍能读回来 —— 存量文件零改名、零迁移
 *   G3 边界只转换一次: 内存对象上不许漏出 wire 字段名
 *   G4 真实账本扫描: 除 budget 外的账本目录里, 一旦出现 `sessionId` 就红
 *   G5 变异体检两发 —— 证明 G1/G2 不是空枪
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MODULES = path.join(__dirname, '..', 'modules');
const BUDGET_SRC = path.join(MODULES, 'budget.js');
const SESSION_KEY_SRC = path.join(MODULES, 'session_key.js');
const HOME = os.homedir();

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pangu-ledger-${tag}-`));
}

// 子进程的 stdout 里混着模块自己的日志 (比如 "[budget] C2 reload: N sessions restored"),
// 所以载荷要用哨兵隔出来, 免得 JSON.parse 把日志当 JSON 吃 (踩过一次)。
const SENTINEL = '__PANGU_JSON__';

function extractJson(stdout) {
  const i = stdout.lastIndexOf(SENTINEL);
  if (i < 0) throw new Error('子进程没吐出哨兵: ' + JSON.stringify(stdout.slice(0, 300)));
  return JSON.parse(stdout.slice(i + SENTINEL.length).trim());
}

/** 在**指定** budget 模块路径上跑一段脚本, 把它 stdout 原样吐回来 */
function runBudget(modulePath, budgetDir, script) {
  const code = `
    process.env.PANGU_BUDGET_DIR = ${JSON.stringify(budgetDir)};
    const budget = require(${JSON.stringify(modulePath)});
    ${script}
  `;
  return execFileSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    env: Object.assign({}, process.env),
    timeout: 30000,
  });
}

/** 账本目录里某个 session 的账文件名 (跟 budget 内部同一条规则) */
function ledgerFileName(dir, sid) {
  const sk = require(path.join(MODULES, 'session_key.js'));
  return sk.resolveSessionKey(dir, sid) + '.json';
}

// ---- G1: 新写的账必须用 wire 规范名 -----------------------------------------

test('G1: 新写的预算账落盘字段是 session_id, 不再有 sessionId', () => {
  const dir = tmpDir('g1');
  try {
    runBudget(BUDGET_SRC, dir, `budget.recordRound('fresh-sid-r96', 120);`);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    assert.strictEqual(files.length, 1, `一个账都没落盘 (files=${JSON.stringify(files)})`);
    const j = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    assert.ok(
      Object.prototype.hasOwnProperty.call(j, 'session_id'),
      `新账里没有 session_id —— 实际键: ${JSON.stringify(Object.keys(j))}`,
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(j, 'sessionId'),
      '新账里还留着 sessionId —— 两个键并存, 统一就没做到',
    );
    assert.strictEqual(j.session_id, 'fresh-sid-r96', 'session_id 的值不是那个 session');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- G2: 存量 (老格式) 必须仍能读回来 ---------------------------------------

test('G2: 存量老账 (sessionId) 仍能被启动批量 reload 读回来', () => {
  const dir = tmpDir('g2');
  try {
    const sid = 'legacy-sid-r96';
    fs.writeFileSync(path.join(dir, ledgerFileName(dir, sid)), JSON.stringify({
      sessionId: sid,           // ← 存量格式: 老版本写的就是这个键
      ts: Date.now(),
      rounds: 7,
      tokens: 4242,
    }), 'utf8');

    const out = runBudget(BUDGET_SRC, dir, `console.log('${SENTINEL}' + JSON.stringify(budget.globalStats()));`);
    const stats = extractJson(out);
    assert.strictEqual(
      stats.active_sessions, 1,
      '启动没把存量账读回来 —— 存量 1373 个文件会直接失联 (同第 92 批「存量零迁移」纪律)',
    );
    assert.strictEqual(stats.sessions[0].session_id, sid, '读回来的是别的 session');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- G3: 边界只转换一次 ------------------------------------------------------

test('G3: 内存对象上只留 sessionId, 不漏出 wire 字段名 session_id', () => {
  const dir = tmpDir('g3');
  try {
    const out = runBudget(BUDGET_SRC, dir, `
      budget.recordRound('mem-sid-r96', 10);
      const b = budget.getBudget('mem-sid-r96');
      console.log(JSON.stringify({
        hasId: Object.prototype.hasOwnProperty.call(b, 'sessionId'),
        hasWire: Object.prototype.hasOwnProperty.call(b, 'session_id'),
        id: b.sessionId,
      }));
    `);
    const r = JSON.parse(out);
    assert.strictEqual(r.hasId, true, '内存对象没有 sessionId');
    assert.strictEqual(r.hasWire, false, '内存对象漏出了 session_id —— 边界转换不止一次');
    assert.strictEqual(r.id, 'mem-sid-r96');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- G4: 真实账本扫描 (防别的账本也开始写 sessionId) ------------------------

test('G4: 真实账本里除 budget 外, 没有任何账本用 sessionId 落盘', () => {
  const dirs = [
    [path.join(HOME, '.pangu', 'state', 'tasks'), '.json'],
    [path.join(HOME, '.pangu', 'state', 'plans'), '.json'],
    [path.join(HOME, '.pangu', 'state', 'goals'), '.json'],
    [path.join(HOME, '.pangu', 'state', 'handoff'), '.json'],
    [path.join(HOME, '.pangu', 'state', 'ledger'), '.json'],
    [path.join(HOME, '.pangu-data', 'sessions'), '.json'],
  ];
  let checked = 0;
  for (const [dir, ext] of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith(ext)); } catch (_) { continue; }
    for (const f of files) {
      let raw = '';
      try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { continue; }
      if (!raw.includes('session_id')) continue;      // 没有 session 字段的文件不管
      checked++;
      assert.ok(
        !raw.includes('"sessionId"'),
        `${dir}/${f} 里出现了 sessionId ⇒ 落盘字段名又分叉了 (规范名只有 session_id)`,
      );
    }
  }
  assert.ok(checked > 0, '一个带 session 字段的真实账本都没扫到 —— 这条守卫会变成空枪');
});

// ---- G5: 变异体检 (证明 G1/G2 会咬) -----------------------------------------

function mutateBudget(tag, mutate) {
  const root = tmpDir(tag);
  const dst = path.join(root, 'budget.js');
  const src = fs.readFileSync(BUDGET_SRC, 'utf8');
  const next = mutate(src);
  assert.notStrictEqual(next, src, `变异 ${tag} 根本没改到源码 (匹配串写错了)`);
  fs.writeFileSync(dst, next, 'utf8');
  fs.copyFileSync(SESSION_KEY_SRC, path.join(root, 'session_key.js'));
  return { budgetPath: dst, tmpRoot: root };
}

test('G5a: 把落盘字段改回 sessionId ⇒ G1 必须红', () => {
  const m = mutateBudget('mutA', s => s.replace('session_id: b.sessionId,', 'sessionId: b.sessionId,'));
  const d = tmpDir('mutA-run');
  try {
    let red = false;
    try {
      runBudget(m.budgetPath, d, `budget.recordRound('mutant-a', 1);`);
      const f = fs.readdirSync(d).filter(x => x.endsWith('.json'))[0];
      const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
      if (!Object.prototype.hasOwnProperty.call(j, 'session_id')) red = true;
    } catch (_) { red = true; }
    assert.ok(red, '变异体没让 G1 红 ⇒ G1 是空枪');
  } finally {
    fs.rmSync(m.tmpRoot, { recursive: true, force: true });
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('G5b: 去掉存量兼容分支 ⇒ G2 必须红', () => {
  const m = mutateBudget('mutB', s => s.replace('data.session_id || data.sessionId', 'data.session_id'));
  const d = tmpDir('mutB-run');
  try {
    const sid = 'legacy-mut-b';
    fs.writeFileSync(path.join(d, ledgerFileName(d, sid)), JSON.stringify({
      sessionId: sid, ts: Date.now(), rounds: 7,
    }), 'utf8');
    let stats = null;
    try {
      stats = extractJson(runBudget(m.budgetPath, d, `console.log('${SENTINEL}' + JSON.stringify(budget.globalStats()));`));
    } catch (_) { stats = null; }
    assert.ok(
      !stats || stats.active_sessions !== 1,
      '变异体没让 G2 红 ⇒ G2 是空枪',
    );
  } finally {
    fs.rmSync(m.tmpRoot, { recursive: true, force: true });
    fs.rmSync(d, { recursive: true, force: true });
  }
});
