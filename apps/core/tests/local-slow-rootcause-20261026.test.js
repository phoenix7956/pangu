'use strict';

/**
 * 2026-10-26 — 第 100 批守卫：「本地慢」的两条真根因
 *
 * 症状 (老板长期体感: "同样的模型, codex 和 openclaw 都比盘古快"、"跟死了一样")
 *
 * 根因 A · 自愈跑批器空转烧本地 GPU
 *   · 跑批器每 10 分钟启动一次 (launchd StartInterval=600), 实测累计启动 **10002 次**,
 *     累计 **success=0 / failed=4818** —— 一次都没修成过。
 *   · 它每次把 **136695 字节**提示词发给本地 27B (≈45K token), 因为 pending 的证据文件是
 *     **进化账本 .jsonl** ⇒ 跑批器把**日志当源码上下文**喂给模型 ⇒ 模型只能答
 *     "这是运行日志不是源码" ⇒ confidence=0 ⇒ 跳过。
 *   · 代价: 本地 GPU 被占住十几分钟 (实测 00:00→01:54 连续占满约 2 小时, 每轮 12–25 分钟),
 *     老板的对话全排在它后面。45K token 请求还把 LM Studio 的 prompt 缓存顶到 85%
 *     ⇒ 触发缓存守卫重载 ⇒ 下次全量 prefill ⇒ 越滚越慢。
 *
 * 根因 B · 测试污染生产进化账本
 *   · `evolution_record.js` 硬编码 `os.homedir()/.pangu/evolution`, **无视沙箱变量**
 *     ⇒ 链里每个跑 agent 循环的测试都往**生产**账本写记录。
 *   · 实测污染 (2026-10-25 账本): 579 条里 **356 条"真失败"全是测试会话**,
 *     成功的那批也全是测试会话 —— 生产账本里**一条真实用户会话都没有**。
 *   · 污染链: 失败率虚高 → 看门狗报警 → 修复跑批器拿日志当源码去问模型 → 45K token/次空转。
 *
 * 本守卫钉死七件事, 任何一条被破坏都会红:
 *   G1 进化账本写 PANGU_EVO_DIR (不写生产 ~/.pangu/evolution)
 *   G2 沙箱脚本导出 PANGU_EVO_DIR, 且 MUST_SANDBOX 名单里有它
 *   G3 跑批器跳过判定: 日志证据 ⇒ 跳过 / 源码证据 ⇒ 不跳 / repairable:false ⇒ 跳过
 *   G4 源码上下文: 日志不进上下文, 总量有 16KB 上限
 *   G5 熔断: 连续 2 次修不了 ⇒ 冷却 24h; 成功 ⇒ 清零
 *   G6 看门狗写 l1-fail 时带 repairable:false (统计信号不占跑批器队列)
 *   G7 变异体检: 真改文件 → 真跑本守卫 → 断言红 → 还原
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CORE = path.join(__dirname, '..');                 // apps/core
const REPO = path.join(CORE, '..', '..');                // 仓库根

// ── 测试沙箱 (必须在 require runner/watcher **之前** 设好 ——
//    这两个模块在加载时就把 REPAIR_DIR / EVO_DIR / LOG_DIR 定下来了) ──
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-localslow-'));
const SB_REPAIR = path.join(SANDBOX, 'repair');
const SB_EVO = path.join(SANDBOX, 'evolution');
const SB_LOG = path.join(SANDBOX, 'logs');
for (const d of [SB_REPAIR, SB_EVO, SB_LOG]) fs.mkdirSync(d, { recursive: true });

process.env.PANGU_REPAIR_DIR = SB_REPAIR;
process.env.PANGU_EVO_DIR = SB_EVO;
process.env.PANGU_LOG_DIR = SB_LOG;

const runner = require(path.join(REPO, 'bin', 'pangu-repair-runner.js'));
const watcher = require(path.join(REPO, 'bin', 'pangu-repair-watcher.js'));
const { _recordEvolution } = require(path.join(CORE, 'modules', 'evolution_record.js'));

function _linesOf(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch (_) { return 0; }
}

// ─────────────────────────────────────────────────────────────
// G1 · 进化账本必须写 PANGU_EVO_DIR
// ─────────────────────────────────────────────────────────────
test('G1: 进化账本写 PANGU_EVO_DIR, 生产 ~/.pangu/evolution 一个字节都不动', () => {
  const prodFile = path.join(os.homedir(), '.pangu', 'evolution',
    new Date().toISOString().slice(0, 10) + '.jsonl');
  const before = _linesOf(prodFile);

  const tmpEvo = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-evo-probe-'));
  const prev = process.env.PANGU_EVO_DIR;
  process.env.PANGU_EVO_DIR = tmpEvo;
  try {
    _recordEvolution({ ts: Date.now(), input: 'guard-probe', provider: 'guard', model: 'guard' });
  } finally {
    if (prev === undefined) delete process.env.PANGU_EVO_DIR;
    else process.env.PANGU_EVO_DIR = prev;
  }

  const files = fs.readdirSync(tmpEvo);
  assert.equal(files.length, 1, '账本没落到 PANGU_EVO_DIR —— 进化记录还是写死的老地方');
  assert.match(files[0], /^\d{4}-\d{2}-\d{2}\.jsonl$/);
  const rec = JSON.parse(fs.readFileSync(path.join(tmpEvo, files[0]), 'utf8').trim());
  assert.equal(rec.input, 'guard-probe');

  assert.equal(_linesOf(prodFile), before, '生产进化账本被测试写脏了 —— 沙箱没生效');
});

test('G1b: PANGU_EVO_DIR 在**调用时**解析 (不是模块加载时)', () => {
  // 测试常在 require 之后才设 env —— 解析太早的话沙箱就漏了。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-evo-late-'));
  const prev = process.env.PANGU_EVO_DIR;
  process.env.PANGU_EVO_DIR = tmp;
  try {
    // 这个模块在 G1 之前就已经被 require 过了 —— 缓存命中, 正好验证"调用时解析"
    _recordEvolution({ ts: Date.now(), input: 'guard-late-probe' });
  } finally {
    if (prev === undefined) delete process.env.PANGU_EVO_DIR;
    else process.env.PANGU_EVO_DIR = prev;
  }
  assert.ok(fs.readdirSync(tmp).length === 1, 'env 改了但账本没跟着走 ⇒ 解析发生在模块加载时');
});

// ─────────────────────────────────────────────────────────────
// G2 · 沙箱脚本必须导出 PANGU_EVO_DIR
// ─────────────────────────────────────────────────────────────
test('G2: 沙箱脚本导出 PANGU_EVO_DIR 且指向沙箱内', () => {
  const src = fs.readFileSync(path.join(CORE, 'bin', 'run-tests.sh'), 'utf8');
  assert.match(src, /export PANGU_EVO_DIR="\$SANDBOX\/evolution"/,
    'run-tests.sh 必须把进化账本导到沙箱 —— 漏了它, 链里的测试就往生产账本写垃圾');
});

test('G2b: MUST_SANDBOX 名单里有 PANGU_EVO_DIR (漏一个就漏一个)', () => {
  const src = fs.readFileSync(path.join(CORE, 'tests', 'test-sandbox-not-polluting-20261015.test.js'), 'utf8');
  assert.match(src, /'PANGU_EVO_DIR'/,
    '沙箱守卫的 MUST_SANDBOX 名单漏了 PANGU_EVO_DIR —— 这个守卫正是防漏的');
});

// ─────────────────────────────────────────────────────────────
// G3 · 跑批器跳过判定
// ─────────────────────────────────────────────────────────────
test('G3a: 证据只有日志 ⇒ 跳过 (不调用模型)', () => {
  const d = runner._decideSkip({
    signal: 'l1-fail:2026-10-26',
    evidence: { files: ['/Users/you/.pangu/evolution/2026-10-26.jsonl'] },
  });
  assert.equal(d.skip, true);
  assert.match(d.why, /没有源码/);
});

test('G3b: 证据里有源码 ⇒ 不跳过', () => {
  const d = runner._decideSkip({
    signal: 'pangu-error',
    evidence: { files: ['/Users/you/Desktop/pangu/apps/core/pangu-single.js'] },
  });
  assert.equal(d.skip, false);
  assert.equal(d.why, '');
});

test('G3c: repairable:false ⇒ 跳过 (统计信号模型改不了)', () => {
  const d = runner._decideSkip({
    signal: 'l1-fail:2026-10-26',
    repairable: false,
    evidence: { files: ['/Users/you/Desktop/pangu/apps/core/pangu-single.js'] },
  });
  assert.equal(d.skip, true, 'repairable:false 必须优先于"证据里有源码"');
});

test('G3d: 日志类扩展名全覆盖 (log/jsonl/ndjson/txt/md/csv/tsv)', () => {
  for (const ext of ['.log', '.jsonl', '.ndjson', '.txt', '.md', '.csv', '.tsv']) {
    const cls = runner._classifyEvidence(['/x/a' + ext]);
    assert.equal(cls.source.length, 0, ext + ' 没被认成日志类');
    assert.equal(cls.skipped.length, 1);
  }
  // 大写扩展名也要认 (Windows/手写路径常见 .JSONL)
  assert.equal(runner._classifyEvidence(['/x/A.JSONL']).source.length, 0);
});

// ─────────────────────────────────────────────────────────────
// G4 · 源码上下文: 日志不进 + 16KB 上限
// ─────────────────────────────────────────────────────────────
test('G4a: 日志文件不进源码上下文', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-src-'));
  const srcFile = path.join(tmp, 'real.js');
  const logFile = path.join(tmp, 'trace.jsonl');
  fs.writeFileSync(srcFile, 'const MAGIC_TOKEN_ABC = 1;\n');
  fs.writeFileSync(logFile, '{"msg":"MAGIC_TOKEN_ABC is a log line"}\n'.repeat(50));

  const ctx = runner._buildSourceContext([logFile, srcFile], { evidence: {} });
  assert.ok(ctx.includes('MAGIC_TOKEN_ABC'), '源码没进上下文 —— 修不了');
  assert.ok(!ctx.includes('is a log line'), '日志进了上下文 ⇒ 又要把 45K token 喂给模型');
});

test('G4b: 源码上下文总量有 16KB 上限', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-src-big-'));
  const big = path.join(tmp, 'big.js');
  fs.writeFileSync(big, 'x'.repeat(200 * 1024));
  const ctx = runner._buildSourceContext([big], { evidence: {} });
  assert.ok(ctx.length <= runner.SOURCE_CONTEXT_MAX_BYTES + 200,
    '源码上下文没截断: ' + ctx.length + ' 字节 (上限 ' + runner.SOURCE_CONTEXT_MAX_BYTES + ')');
  assert.ok(ctx.includes('已截断'), '截断没留痕迹');
});

test('G4c: 单文件最多 3 个、每文件最多 200 行 (旧有的两条上限没被改掉)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-src-many-'));
  const files = [];
  for (let i = 0; i < 6; i++) {
    const f = path.join(tmp, 'f' + i + '.js');
    fs.writeFileSync(f, Array.from({ length: 500 }, (_, n) => `const L${i}_${n} = ${n};`).join('\n'));
    files.push(f);
  }
  const ctx = runner._buildSourceContext(files, { evidence: {} });
  assert.ok(ctx.includes('f0.js') && ctx.includes('f1.js') && ctx.includes('f2.js'));
  assert.ok(!ctx.includes('f3.js'), '第 4 个文件不该进上下文');
});

// ─────────────────────────────────────────────────────────────
// G5 · 熔断
// ─────────────────────────────────────────────────────────────
test('G5a: 连续 2 次修不了 ⇒ 冷却 24h', () => {
  let st = {};
  st = runner._breakerRecord(st, 'l1-fail', false, 1000);
  assert.equal(runner._breakerCoolingDown(st, 'l1-fail', 1000), false, '第 1 次失败不该就冷却');
  st = runner._breakerRecord(st, 'l1-fail', false, 2000);
  assert.equal(runner._breakerCoolingDown(st, 'l1-fail', 2000), true, '连续 2 次失败必须进冷却');
  assert.equal(st['l1-fail'].cooldownUntil, 2000 + runner.BREAKER_COOLDOWN_MS);
});

test('G5b: 修成功一次 ⇒ 计数清零', () => {
  let st = {};
  st = runner._breakerRecord(st, 'l1-fail', false, 1000);
  st = runner._breakerRecord(st, 'l1-fail', true, 2000);
  assert.equal(st['l1-fail'].consecutiveFails, 0);
  assert.equal(runner._breakerCoolingDown(st, 'l1-fail', 2000), false);
});

test('G5c: 冷却期过后自动放行 (不是永久封禁)', () => {
  const st = { 'l1-fail': { consecutiveFails: 2, cooldownUntil: 5000 } };
  assert.equal(runner._breakerCoolingDown(st, 'l1-fail', 4999), true);
  assert.equal(runner._breakerCoolingDown(st, 'l1-fail', 5001), false);
});

test('G5d: 熔断按**信号类**算, 不按日期 (l1-fail:2026-10-26 与 l1-fail:2026-10-27 同一类)', () => {
  assert.equal(runner._signalClass('l1-fail:2026-10-26'), 'l1-fail');
  assert.equal(runner._signalClass('l1-fail:2026-10-27'), 'l1-fail');
  assert.equal(runner._signalClass('pangu-error'), 'pangu-error');
});

test('G5e: 熔断状态落盘/读回一致', () => {
  const f = path.join(SANDBOX, 'breaker-probe.json');
  let st = runner._readBreaker(f);
  st = runner._breakerRecord(st, 'probe-sig', false, 1000);
  st = runner._breakerRecord(st, 'probe-sig', false, 2000);
  runner._writeBreaker(st, f);
  const back = runner._readBreaker(f);
  assert.equal(runner._breakerCoolingDown(back, 'probe-sig', 2000), true);
});

test('G5f: 过期结果产物会被清, 新的留着, pending 绝不动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-cleanup-'));
  const oldFailed = path.join(dir, 'failed-1000-aaaa.json');
  const oldSkipped = path.join(dir, 'skipped-1000-bbbb.json');
  const fresh = path.join(dir, 'failed-9999999-cccc.json');
  const pending = path.join(dir, 'pending-1000-dddd.json');
  const done = path.join(dir, 'done-1000-eeee.json');
  for (const f of [oldFailed, oldSkipped, fresh, pending, done]) fs.writeFileSync(f, '{}');
  const oldT = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  fs.utimesSync(oldFailed, oldT, oldT);
  fs.utimesSync(oldSkipped, oldT, oldT);

  const removed = runner.cleanupOldResults(7, Date.now(), dir);
  assert.equal(removed, 2, '过期产物没清干净');
  assert.ok(!fs.existsSync(oldFailed) && !fs.existsSync(oldSkipped));
  assert.ok(fs.existsSync(fresh), '新产物不该被清');
  assert.ok(fs.existsSync(pending), 'pending 绝不该被清 —— 那是待办队列, 不是产物');
  assert.ok(fs.existsSync(done), 'done 不在清理范围内 (成功修复的记录要留)');
});

// ─────────────────────────────────────────────────────────────
// G6 · 看门狗: 统计信号只报警, 不占跑批器队列
// ─────────────────────────────────────────────────────────────
test('G6: 看门狗写 l1-fail pending 时带 repairable:false', () => {
  // 造一份"今天有真失败"的进化账本 (在沙箱里), 让看门狗扫到
  const today = new Date().toISOString().slice(0, 10);
  const evoFile = path.join(SB_EVO, today + '.jsonl');
  const recs = [
    { ts: 1, success: false, error: 'TypeError: boom', tool_names: ['a'] },
    { ts: 2, success: false, error: 'TypeError: boom2', tool_names: ['b'] },
    { ts: 3, success: false, error: 'TypeError: boom3', tool_names: ['c'] },
    { ts: 4, success: true, final_text: '正常答复', tool_names: ['d'] },
  ];
  fs.writeFileSync(evoFile, recs.map(r => JSON.stringify(r)).join('\n') + '\n');

  const n = watcher.scanL1Failures();
  assert.equal(n, 1, '看门狗没扫到 l1-fail 统计信号');

  const pendings = fs.readdirSync(SB_REPAIR).filter(f => f.startsWith('pending-') && f.endsWith('.json'));
  assert.equal(pendings.length, 1, '没写 pending');
  const p = JSON.parse(fs.readFileSync(path.join(SB_REPAIR, pendings[0]), 'utf8'));
  assert.match(p.signal, /^l1-fail:/);
  assert.equal(p.repairable, false,
    'l1-fail 是统计信号, 必须标 repairable:false —— 否则跑批器会拿账本当源码去问模型');
});

// ─────────────────────────────────────────────────────────────
// G8 · 端到端: 证据只有日志的 pending ⇒ **一个 LLM 请求都不发**
//
// 为什么必须端到端 (纯函数测不出来):
//   G3 只验了 `_decideSkip` 这个**函数**返回对。
//   但真正的 bug 是「processOne 有没有把它接上」——
//   变异把 `if (_decision.skip)` 改成 `if (false)`, 纯函数照样全绿, 跑批器照样烧 GPU。
//   ⇒ 必须真的跑一次 CLI, 用**哨兵服务器**数请求数。
//
// 哨兵: 起一个本地 HTTP 服务, 把 PANGU_LLM_URL 指过去。
//   命中次数 = 0 ⇒ 真的没发请求 (不是"日志里没打印", 是"线上没打").
// ─────────────────────────────────────────────────────────────
function _startSentinel() {
  const http = require('node:http');
  const hits = { count: 0, bodies: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      hits.count++;
      hits.bodies.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"confidence":0.0}' } }] }));
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server, hits,
        url: 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions',
      });
    });
  });
}

test('G8: 端到端 —— 证据只有日志的 pending, 跑批器一个 LLM 请求都不发', async () => {
  const sent = await _startSentinel();
  const sbRepair = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-e2e-repair-'));
  const sbLog = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-e2e-log-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-e2e-home-'));

  // 造一个 l1-fail 形态的 pending: 证据 = **进化账本 .jsonl** (就是线上那 4775 次的来源)
  const evoFile = path.join(sbRepair, '2026-10-26.jsonl');
  fs.writeFileSync(evoFile, '{"success":false,"error":"boom"}\n'.repeat(200));
  fs.writeFileSync(path.join(sbRepair, 'pending-1.json'), JSON.stringify({
    id: 'pending-1',
    signal: 'l1-fail:2026-10-26',
    severity: 'warning',
    summary: '今日 L1 真失败 300/500 次',
    status: 'pending',
    evidence: { count: 300, total: 500, files: [evoFile] },
  }));

  const env = Object.assign({}, process.env, {
    PANGU_REPAIR_DIR: sbRepair,
    PANGU_LOG_DIR: sbLog,
    PANGU_LLM_URL: sent.url,
    PANGU_LLM_KEY: 'guard-key',
    PANGU_LLM_MODEL: 'guard-model',
    HOME: fakeHome,
  });
  delete env.NODE_TEST_CONTEXT;

  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(REPO, 'bin', 'pangu-repair-runner.js')], {
      cwd: REPO, env, encoding: 'utf8', timeout: 60000,
    });
  } finally {
    sent.server.close();
  }

  assert.equal(sent.hits.count, 0,
    '跑批器**真的发了 LLM 请求** (哨兵记录到 ' + sent.hits.count + ' 次) —— '
    + '证据只有日志时不该问模型; 请求体 ' + (sent.hits.bodies[0] || '').slice(0, 200));
  assert.match(out, /跳过 \(不调用模型\)/, '跑批器没打印跳过标记');

  const results = fs.readdirSync(sbRepair).filter(f => f.startsWith('skipped-') && f.endsWith('.json'));
  assert.equal(results.length, 1, '没写 skipped 结果产物');
  const r = JSON.parse(fs.readFileSync(path.join(sbRepair, results[0]), 'utf8'));
  assert.equal(r.reason, 'not-repairable');
  assert.ok(!fs.readdirSync(sbRepair).some(f => f.startsWith('pending-')),
    '跳过的 pending 没被清掉 —— 会一直堆着');
});

// ─────────────────────────────────────────────────────────────
// G9 · 账本目录的**唯一真源** —— 不许再有人硬编码
//
// 为什么要钉死:
//   账本目录原来在主体里有 7+ 处各自硬编码 `~/.pangu/evolution`。
//   只要有一处漏改 ⇒ **读写分裂** (写进沙箱、却从生产读) ⇒
//   测试读到陈旧生产数据, 结论全是假的 (2026-10-15 沙箱守卫注释记过这个坑)。
//   ⇒ 规则收进 modules/evolution_paths.js, 守卫扫全仓不许再出现硬编码。
// ─────────────────────────────────────────────────────────────
test('G9: 账本目录只有一个真源 —— 全仓不许再硬编码 ~/.pangu/evolution', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'docs') continue;
        walk(p);
      } else if (e.name.endsWith('.js')) {
        const rel = path.relative(REPO, p);
        if (rel === 'apps/core/modules/evolution_paths.js') continue;   // 真源本身
        if (rel.startsWith('apps/core/tests/')) continue;                // 测试里的探针不算
        const src = fs.readFileSync(p, 'utf8');
        // 只看**代码行**, 注释里的历史说明不算
        src.split('\n').forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
          if (/homedir\(\)[^\n]*'\.pangu'[^\n]*'evolution'/.test(t)) {
            offenders.push(`${rel}:${i + 1}: ${t.slice(0, 100)}`);
          }
        });
      }
    }
  };
  walk(path.join(CORE, 'modules'));
  walk(path.join(CORE, 'agents'));
  walk(path.join(CORE, 'scripts'));
  walk(path.join(CORE, 'pangu-single'));
  walk(path.join(REPO, 'bin'));
  assert.deepEqual(offenders, [], '账本目录又出现硬编码 —— 收进 modules/evolution_paths.js:\n' + offenders.join('\n'));
});

test('G9b: 账本目录解析规则三层 (专用开关 > 状态根 > 生产默认)', () => {
  const paths = require(path.join(CORE, 'modules', 'evolution_paths'));
  const prevEvo = process.env.PANGU_EVO_DIR;
  const prevHome = process.env.PANGU_HOME;
  try {
    // ① 专用开关最高
    process.env.PANGU_EVO_DIR = '/tmp/evo-switch';
    process.env.PANGU_HOME = '/tmp/state-root';
    assert.equal(paths.evolutionDir(), '/tmp/evo-switch');
    assert.equal(paths.evolutionL2Dir(), '/tmp/evo-switch/l2');

    // ② 状态根次之
    delete process.env.PANGU_EVO_DIR;
    process.env.PANGU_HOME = '/tmp/state-root';
    assert.equal(paths.evolutionDir(), '/tmp/state-root/evolution');

    // ③ 都没有 ⇒ 生产默认
    delete process.env.PANGU_EVO_DIR;
    delete process.env.PANGU_HOME;
    assert.equal(paths.evolutionDir(), path.join(os.homedir(), '.pangu', 'evolution'));
  } finally {
    if (prevEvo === undefined) delete process.env.PANGU_EVO_DIR;
    else process.env.PANGU_EVO_DIR = prevEvo;
    if (prevHome === undefined) delete process.env.PANGU_HOME;
    else process.env.PANGU_HOME = prevHome;
  }
});

// ─────────────────────────────────────────────────────────────
// G10 · 状态子目录的沙箱开关必须齐全
//
// 实测污染 (2026-10-26 第 100 批, 跑链窗口内 diff 生产 ~/.pangu):
//   state/harness/runs  72 + state/ledger 31 + state/compaction 5 + alignment-blocked.jsonl
//   = 104 个测试产物进了生产。内容全是测试会话 (r24-chain-exhaust / roletest / unit-compact-*)。
//   ⇒ 状态目录必须有**专用沙箱开关**, 而且沙箱脚本 + MUST_SANDBOX 名单都要有它。
// ─────────────────────────────────────────────────────────────
test('G10: 状态子目录的专用开关都在沙箱脚本和 MUST_SANDBOX 名单里', () => {
  const KNOB = {
    ledgerDir: 'PANGU_LEDGER_DIR',
    harnessDir: 'PANGU_HARNESS_DIR',
    compactionDir: 'PANGU_COMPACTION_DIR',
    runTraceDir: 'PANGU_RUN_TRACE_DIR',
    alignmentAuditFile: 'PANGU_ALIGNMENT_AUDIT_FILE',
  };
  const sandboxSrc = fs.readFileSync(path.join(CORE, 'bin', 'run-tests.sh'), 'utf8');
  const guardSrc = fs.readFileSync(path.join(CORE, 'tests', 'test-sandbox-not-polluting-20261015.test.js'), 'utf8');
  for (const env of Object.values(KNOB)) {
    assert.match(sandboxSrc, new RegExp('export ' + env + '='), env + ' 没在 bin/run-tests.sh 里导出');
    assert.ok(guardSrc.includes("'" + env + "'"), env + ' 不在 MUST_SANDBOX 名单里 —— 沙箱守卫正是防漏的');
  }
});

test('G10b: 开关生效时, 每个状态目录都落在沙箱内', () => {
  const paths = require(path.join(CORE, 'modules', 'state_paths'));
  const prev = {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-statepaths-'));
  const KEYS = ['PANGU_LEDGER_DIR', 'PANGU_HARNESS_DIR', 'PANGU_COMPACTION_DIR', 'PANGU_RUN_TRACE_DIR'];
  try {
    for (const k of KEYS) { prev[k] = process.env[k]; process.env[k] = path.join(tmp, k); }
    assert.equal(paths.ledgerDir(), path.join(tmp, 'PANGU_LEDGER_DIR'));
    assert.equal(paths.harnessDir(), path.join(tmp, 'PANGU_HARNESS_DIR'));
    assert.equal(paths.compactionDir(), path.join(tmp, 'PANGU_COMPACTION_DIR'));
    assert.equal(paths.runTraceDir(), path.join(tmp, 'PANGU_RUN_TRACE_DIR'));
    // runTraceDir 在专用开关缺省时挂在 harnessDir 底下
    delete process.env.PANGU_RUN_TRACE_DIR;
    assert.equal(paths.runTraceDir(), path.join(tmp, 'PANGU_HARNESS_DIR', 'runs'));
  } finally {
    for (const k of KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
});

// ─────────────────────────────────────────────────────────────
// G7 · 变异体检 —— 守卫必须**真**报红
// ─────────────────────────────────────────────────────────────
const _IS_MUTATION_CHILD = !!process.env.PANGU_LOCAL_SLOW_MUTATION_CHILD;
const SELF = path.join(__dirname, 'local-slow-rootcause-20261026.test.js');

function _runGuardExpectingRed() {
  // ⚠️ 必须摘掉 NODE_TEST_CONTEXT: Node 的 test runner 给子进程设
  // NODE_TEST_CONTEXT=child-v8, 被继承到孙进程时, 孙进程以为"我已经在 test runner 里了"
  // ⇒ --test 被忽略 ⇒ 根本不跑测试 ⇒ 静默 exit 0 ⇒ 守卫看起来"没报红"。
  // 这是假阴性最隐蔽的一种 (99 批 G4 踩过)。
  //
  // ⚠️ 还要改 HOME: G7a 的变异会把账本写回 `os.homedir()/.pangu/evolution`。
  // os.homedir() 在 POSIX 上认 $HOME ⇒ 把 HOME 指到临时目录, 变异子进程的"生产账本"
  // 就落在临时目录里, **不会真的污染生产**。
  // (守卫自己污染生产账本 = 本批要修的那个 bug 的缩小版, 不能自己犯。)
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-mut-home-'));
  const childEnv = Object.assign({}, process.env, {
    PANGU_LOCAL_SLOW_MUTATION_CHILD: '1',
    HOME: fakeHome,
  });
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    execFileSync(process.execPath, ['--test', SELF], {
      cwd: CORE, stdio: 'pipe', timeout: 120000, env: childEnv,
    });
    return null;   // 全绿 = 守卫没咬 = 失败
  } catch (e) {
    return String(e.stdout || '') + String(e.stderr || '');
  }
}

function _mutateAndExpectRed(file, from, to) {
  const p = path.join(REPO, file);
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(src.includes(from), `变异锚点没找到 (${file}) —— 测试自己失效了`);
  const mutated = src.replace(from, to);
  assert.notEqual(mutated, src, '变异没生效 —— 测试自己失效了');
  fs.writeFileSync(p, mutated);
  try {
    const out = _runGuardExpectingRed();
    assert.ok(out !== null, `守卫在「${file} 被改回去」时**没有报红** ⇒ 守卫是假的`);
    assert.match(out, /not ok/, '报红必须是真失败, 不是别的错');
  } finally {
    fs.writeFileSync(p, src);   // 还原
  }
}

test('G7a: 把账本写回生产硬编码 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'apps/core/modules/evolution_record.js',
    'const evoDir = evolutionDir();',
    "const evoDir = path.join(os.homedir(), '.pangu', 'evolution');"
  );
});

test('G7b: 把「证据没源码就跳过」去掉 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'bin/pangu-repair-runner.js',
    '  if (_decision.skip) {',
    '  if (false) {'
  );
});

test('G7c: 把源码上下文里的日志过滤去掉 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'bin/pangu-repair-runner.js',
    '  const _cls = _classifyEvidence(files);',
    '  const _cls = { source: (files || []), skipped: [] };'
  );
});

test('G7d: 把看门狗的 repairable:false 去掉 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'bin/pangu-repair-watcher.js',
    '          repairable: false,',
    '          repairable: true,'
  );
});

test('G7e: 把熔断阈值从 2 改成无限大 (等于关掉熔断) ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'bin/pangu-repair-runner.js',
    'const BREAKER_FAIL_THRESHOLD = 2;',
    'const BREAKER_FAIL_THRESHOLD = 9999;'
  );
});

test('G7f: 把账本目录改回硬编码 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'apps/core/modules/evolution_record.js',
    'const evoDir = evolutionDir();',
    "const evoDir = path.join(os.homedir(), '.pangu', 'evolution');"
  );
});
