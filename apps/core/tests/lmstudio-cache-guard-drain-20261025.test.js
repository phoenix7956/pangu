const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ===========================================================================
// 第 94 批: LM Studio prompt 缓存守卫 —— 从"从来没触发过的死代码"改成真能干活
//
// 旧守卫的四条实测结论 (2026-10-25):
//   a) decide() 要求"空闲 180 秒"且"没有活跃轮次" ⇒ 盘古永远有活干 ⇒ 永远不触发
//      (启动行打了 11 次, 一次没触发)
//   b) `lms unload <盘古内部 id>` ⇒ "Model Not Found"
//      (LM Studio 只认 publisher/model: qwen/qwen3.8-27b)
//   c) lms 出错时退出码仍是 0 ⇒ 旧代码打"重载完成"的假日志
//   d) execFileSync 同步 ⇒ 重载期间整个服务卡死
//
// 新机制: **排空闸门** —— 重载时把新请求挡住排队 (实测重载只要 3.6 秒),
// 只要"在途 LLM 请求数 = 0"就是一个安全窗口, 不再依赖"世界安静 180 秒"。
//
// 本文件的核心是**变异体检**: 每条关键机制都用"改坏源码 ⇒ 测试必须咬住"证明它真在守。
// ===========================================================================

const G = require('../modules/lmstudio_cache_guard');
const GUARD_PATH = require.resolve('../modules/lmstudio_cache_guard');

const FULL = { used_mib: 41678.2, cap_mib: 41680.0, ratio: 41678.2 / 41680.0 };
const HEALTHY = { used_mib: 13948.2, cap_mib: 41680.0, ratio: 13948.2 / 41680.0 };
const IDLE_OK = 10 * 60 * 1000;

// 变异体检用: 把源码改坏, 加载改坏后的副本, 断言**它必须过不了同一条检查**。
function loadMutated(mutator) {
  const src = fs.readFileSync(GUARD_PATH, 'utf8');
  const mutated = mutator(src);
  assert.notEqual(mutated, src, '变异必须真的改了源码, 否则这发体检是假的');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmg-mut-'));
  const file = path.join(dir, 'mutated.js');
  fs.writeFileSync(file, mutated);
  const mod = require(file);
  return { mod, dir };
}

// 变异体检的标准写法: 原实现必须过同一条检查, 变异后必须过不了。
// (反过来写就成了"变异后还得通过", 那不叫体检, 叫摆设。)
async function assertMutationBreaks(mutator, check) {
  await check(G);
  const { mod, dir } = loadMutated(mutator);
  let broke = false;
  try { await check(mod); } catch (_) { broke = true; }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(broke, true, '变异后这检查仍然通过 ⇒ 这条检查根本没在守东西');
}

// 去掉注释再查代码 —— 注释里写着"旧代码用 execFileSync"不该被当成还在用
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// 守卫接线在 pangu-single.js 里的那一段 (只看代码, 不看注释)
function guardWindow(src) {
  const code = stripComments(src);
  const idx = code.indexOf('lmstudio_cache_guard');
  if (idx < 0) return '';
  return code.slice(Math.max(0, idx - 500), idx + 6000);
}

// ───────────────────────────────────────────────────────────────────────────
// A. 排空闸门本身
// ───────────────────────────────────────────────────────────────────────────

test('闸门: 不排空时请求立刻放行, 在途数 +1 / -1', async () => {
  G.resetForTests();
  const token = await G.enterRequest();
  assert.equal(G.inflightCount(), 1);
  assert.ok(G.lastRequestAt() > 0, '必须记录最近一次请求时间');
  G.leaveRequest(token);
  assert.equal(G.inflightCount(), 0);
  assert.equal(G.isDraining(), false);
});

test('闸门: 排空期间进来的请求**排队**, 不放行也不算在途', async () => {
  G.resetForTests();
  G.beginDrain();
  assert.equal(G.isDraining(), true);

  let released = false;
  const p = G.enterRequest().then((t) => { released = true; return t; });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(released, false, '排空期间请求必须被挡住');
  assert.equal(G.inflightCount(), 0, '排队的请求不算"在途" —— 否则守卫永远排不空');

  G.endDrain();
  const token = await p;
  assert.equal(released, true, 'endDrain 之后必须放行');
  assert.equal(G.inflightCount(), 1);
  G.leaveRequest(token);
  G.resetForTests();
});

test('闸门: endDrain 之后新请求不再排队', async () => {
  G.resetForTests();
  G.beginDrain();
  G.endDrain();
  const token = await G.enterRequest();
  assert.equal(G.inflightCount(), 1);
  G.leaveRequest(token);
  G.resetForTests();
});

test('闸门: 有在途请求时 waitForInflightZero 必须报"没排空" (不无限等)', async () => {
  G.resetForTests();
  await G.enterRequest();       // 故意不 leave
  assert.equal(G.inflightCount(), 1);
  const ok = await G.waitForInflightZero(120);
  assert.equal(ok, false, '有在途请求时必须报"没排空"');
  G.resetForTests();
});

test('闸门: 排空后 waitForInflightZero 返回 true', async () => {
  G.resetForTests();
  assert.equal(await G.waitForInflightZero(1000), true);
});

// ───────────────────────────────────────────────────────────────────────────
// B. decide(): 闸门就位 ⇒ 安全窗口靠机制, 不靠"世界安静 180 秒"
// ───────────────────────────────────────────────────────────────────────────

test('decide: drainReady + 在途=0 ⇒ 就算不满 180 秒也允许重载', () => {
  const d = G.decide({ pressure: FULL, activeRounds: 0, idleMs: 1000, lastReloadAt: 0, drainReady: true });
  assert.equal(d.ok, true);
  assert.equal(d.reason, 'cache_pressure_drain');
});

test('decide: 没有闸门时仍走老路径 (空闲不够久 ⇒ 不重载) —— 老守卫不许被悄悄改掉', () => {
  const d = G.decide({ pressure: FULL, activeRounds: 0, idleMs: 1000, lastReloadAt: 0 });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'not_idle_enough');
});

test('decide: 有请求在飞 ⇒ 绝对不重载 (闸门就位也一样 —— 这条最要紧)', () => {
  for (const active of [1, 2, 17]) {
    const d = G.decide({ pressure: FULL, activeRounds: active, idleMs: IDLE_OK, lastReloadAt: 0, drainReady: true });
    assert.equal(d.ok, false, 'activeRounds=' + active + ' 时重载会打断主人正在做的事');
    assert.equal(d.reason, 'busy');
    assert.equal(d.activeRounds, active);
  }
});

test('decide: 冷却期在闸门路径上照样生效 (不然每 2 秒卸一遍模型)', () => {
  const d = G.decide({
    pressure: FULL, activeRounds: 0, idleMs: IDLE_OK,
    lastReloadAt: Date.now() - 60 * 1000, drainReady: true,
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'cooldown');
});

test('decide: 缓存健康 ⇒ 不碰模型', () => {
  const d = G.decide({ pressure: HEALTHY, activeRounds: 0, idleMs: IDLE_OK, lastReloadAt: 0, drainReady: true });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'cache_healthy');
});

// ───────────────────────────────────────────────────────────────────────────
// C. lms ps 解析 —— "LM Studio 里这个模型到底叫什么"的唯一权威来源
// ───────────────────────────────────────────────────────────────────────────

const LMS_PS_REAL = [
  'IDENTIFIER          MODEL               STATUS    SIZE        CONTEXT    PARALLEL    LOAD CONFIG    DEVICE    TTL',
  'qwen/qwen3.8-27b    qwen/qwen3.8-27b    IDLE      16.08 GB    65536      4           LM Studio    Local',
  '',
].join('\n');

test('parseLmsPs: 解析真实 lms ps 输出', () => {
  const rows = G.parseLmsPs(LMS_PS_REAL);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].identifier, 'qwen/qwen3.8-27b');
  assert.equal(rows[0].model, 'qwen/qwen3.8-27b');
  assert.equal(rows[0].status, 'IDLE');
});

test('parseLmsPs: 表头和空行不算模型', () => {
  assert.equal(G.parseLmsPs('IDENTIFIER   MODEL   STATUS\n').length, 0);
  assert.equal(G.parseLmsPs('').length, 0);
  assert.equal(G.parseLmsPs(null).length, 0);
});

test('resolveIdentifier: 盘古内部 id → LM Studio 真实标识 (旧代码就是栽在这)', () => {
  const rows = G.parseLmsPs(LMS_PS_REAL);
  assert.equal(G.resolveIdentifier(rows, 'qwen_qwen3.8-27b'), 'qwen/qwen3.8-27b');
});

test('resolveIdentifier: 认不出来就返回 null (宁可不动模型, 也不能 unload 错的那个)', () => {
  const rows = G.parseLmsPs(LMS_PS_REAL);
  assert.equal(G.resolveIdentifier(rows, 'some_other_model'), null);
  assert.equal(G.resolveIdentifier([], 'qwen_qwen3.8-27b'), null);
  assert.equal(G.resolveIdentifier(rows, ''), null);
});

test('resolveIdentifier: 多个模型时只认能唯一对上那个', () => {
  const ps = [
    'IDENTIFIER    MODEL    STATUS',
    'a/one        a/one    IDLE',
    'b/two        b/two    IDLE',
  ].join('\n');
  const rows = G.parseLmsPs(ps);
  assert.equal(G.resolveIdentifier(rows, 'b_two'), 'b/two');
  assert.equal(G.resolveIdentifier(rows, 'c_three'), null, '对不上就不能猜');
});

// ───────────────────────────────────────────────────────────────────────────
// D. 缓存压力读数: 也要能读出"已经在驱逐"这个事实
// ───────────────────────────────────────────────────────────────────────────

test('readCachePressure: 读得出 evicted_mib (已经在驱逐 = 比"满了"更早的信号)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmg3-'));
  const f = path.join(dir, 'x.log');
  fs.writeFileSync(f, 'used_mib=40000.0 cap_mib=41680.0 lifetime_evicted_mib=1234.5 records=900\n');
  const p = G.readCachePressure(f);
  assert.equal(p.evicted_mib, 1234.5);
  assert.equal(p.records, 900);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readCachePressure: 只读日志尾部也不会把半截行当成完整数据', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmg4-'));
  const f = path.join(dir, 'big.log');
  const filler = 'x'.repeat(400 * 1024);
  fs.writeFileSync(f, filler + '\nused_mib=1.0 cap_mib=2.0 lifetime_evicted_mib=0.0 records=1\n');
  const p = G.readCachePressure(f);
  assert.equal(p.used_mib, 1.0);
  assert.equal(p.cap_mib, 2.0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────────
// E. 接线: llm_caller 必须真的持租约, pangu-single 必须真的异步
// ───────────────────────────────────────────────────────────────────────────

test('llm_caller: 三个请求出口都要持租约 (enter + leave 成对)', () => {
  const src = fs.readFileSync(require.resolve('../modules/llm_caller.js'), 'utf8');
  assert.match(src, /require\('\.\/lmstudio_cache_guard'\)/, 'llm_caller 必须接守卫');
  const enters = (src.match(/_gateEnter\(\)/g) || []).length;
  const leaves = (src.match(/_gateLeave\(/g) || []).length;
  assert.ok(enters >= 3, 'callLLM / _callLLMForAgentRaw / _callLLMForAgentStream 三处都要持租约, 实际 ' + enters);
  assert.ok(leaves >= 3, '每一处都必须放租约, 实际 ' + leaves);
  for (const fn of ['async function callLLM(', 'async function _callLLMForAgentRaw(', 'async function* _callLLMForAgentStream(']) {
    const idx = src.indexOf(fn);
    assert.ok(idx > 0, '找不到 ' + fn);
    const window = src.slice(idx, idx + 700);
    assert.match(window, /_gateEnter\(\)/, fn + ' 必须持租约');
    assert.match(window, /_gateLeave\(/, fn + ' 必须放租约');
  }
});

test('pangu-single: 重载不许用同步的 execFileSync (那会让整个服务卡死)', () => {
  const src = fs.readFileSync(require.resolve('../pangu-single.js'), 'utf8');
  const window = guardWindow(src);
  assert.ok(window.length > 0, '必须找到守卫接线');
  assert.doesNotMatch(window, /execFileSync/, '守卫重载不许同步执行 —— 那 10~25s 里 HTTP 全挂');
  assert.match(window, /execFile\(/, '必须用异步 execFile');
});

test('pangu-single: unload/load 用的是 lms ps 解析出的标识, 不是盘古内部 id', () => {
  const src = fs.readFileSync(require.resolve('../pangu-single.js'), 'utf8');
  const window = guardWindow(src);
  assert.match(window, /resolveIdentifier/, '必须从 lms ps 解析真实标识');
  assert.match(window, /parseLmsPs/, '必须解析 lms ps 输出');
  assert.doesNotMatch(window, /\['unload',\s*_model\.id\]/, '不许把盘古内部 id 直接喂给 lms');
  assert.doesNotMatch(window, /\['load',\s*_model\.id\]/, '不许把盘古内部 id 直接喂给 lms');
});

test('pangu-single: 重载完要用 lms ps 复核 (旧代码在这里打假日志)', () => {
  const src = fs.readFileSync(require.resolve('../pangu-single.js'), 'utf8');
  const window = guardWindow(src);
  assert.match(window, /_ps2/, '必须有第二次 lms ps 复核');
  assert.match(window, /不算成功/, '复核不过必须判成失败');
});

test('pangu-single: "有人在用模型"必须用精确的在途请求数, 不能用活跃轮次数', () => {
  const src = fs.readFileSync(require.resolve('../pangu-single.js'), 'utf8');
  const window = guardWindow(src);
  assert.match(window, /activeRounds:\s*_inflight/, '必须传在途 LLM 请求数');
  assert.doesNotMatch(window, /_sessionStats\(\)\.activeRounds/, '旧的"活跃轮次数"是粗代理, 会把安全空窗堵死');
});

test('pangu-single: 必须走排空 (关了闸门才允许动模型)', () => {
  const src = fs.readFileSync(require.resolve('../pangu-single.js'), 'utf8');
  const window = guardWindow(src);
  assert.match(window, /beginDrain\(\)/, '必须关闸门');
  assert.match(window, /endDrain\(\)/, '必须开闸门');
  assert.match(window, /waitForInflightZero\(/, '必须等在途请求排空');
});

// ───────────────────────────────────────────────────────────────────────────
// F. 变异体检 —— 证明上面每条检查真会咬
// ───────────────────────────────────────────────────────────────────────────

test('变异体检: 把 endDrain 的"放行排队请求"改掉 ⇒ 排队机制必须失效', async () => {
  await assertMutationBreaks((s) => s.replace(
    'const waiters = _waiters.splice(0, _waiters.length);',
    'const waiters = []; _waiters.length = 0;',
  ), async (m) => {
    m.resetForTests();
    m.beginDrain();
    let released = false;
    const p = m.enterRequest().then(() => { released = true; });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(released, false, '排空期间请求必须被挡住');
    m.endDrain();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(released, true, 'endDrain 之后必须放行');
  });
});

test('变异体检: 把"在途计数"改掉 ⇒ 在途计数必须失效', async () => {
  await assertMutationBreaks((s) => s.replace(
    'function inflightCount() {',
    'function inflightCount() { return 0;',
  ), async (m) => {
    m.resetForTests();
    await m.enterRequest();
    assert.equal(m.inflightCount(), 1);
  });
});

test('变异体检: 把"排空时请求不计入在途"改掉 ⇒ 守卫永远排不空', async () => {
  await assertMutationBreaks((s) => s.replace(
    'async function enterRequest() {\n  while (_state.draining) {',
    'async function enterRequest() {\n  _leases.add({ at: Date.now() });\n  while (_state.draining) {',
  ), async (m) => {
    m.resetForTests();
    m.beginDrain();
    m.enterRequest();
    assert.equal(m.inflightCount(), 0, '排队的请求不算"在途"');
  });
});

test('变异体检: 把 drainReady 分支删掉 ⇒ 触发路径必须退化成老行为', async () => {
  await assertMutationBreaks((s) => s.replace(
    'if (!drainReady && idle < IDLE_REQUIRED_MS) {',
    'if (idle < IDLE_REQUIRED_MS) {',
  ), (m) => {
    const d = m.decide({ pressure: FULL, activeRounds: 0, idleMs: 1000, lastReloadAt: 0, drainReady: true });
    assert.equal(d.ok, true, '闸门就位时不满 180 秒也该能触发');
  });
});

test('变异体检: 把"有在途就不重载"改掉 ⇒ 最要紧那条必须被咬住', async () => {
  await assertMutationBreaks((s) => s.replace(
    'if (Number(activeRounds) > 0) {',
    'if (false) {',
  ), (m) => {
    const d = m.decide({ pressure: FULL, activeRounds: 3, idleMs: IDLE_OK, lastReloadAt: 0, drainReady: true });
    assert.equal(d.ok, false, '有在途就必须挡住');
    assert.equal(d.reason, 'busy');
  });
});

test('变异体检: 把 resolveIdentifier 改成直接返回盘古 id ⇒ 解析测试必须失败', async () => {
  await assertMutationBreaks((s) => s.replace(
    'function resolveIdentifier(rows, wantedId) {',
    'function resolveIdentifier(rows, wantedId) { return wantedId;',
  ), (m) => {
    const rows = m.parseLmsPs(LMS_PS_REAL);
    assert.equal(m.resolveIdentifier(rows, 'qwen_qwen3.8-27b'), 'qwen/qwen3.8-27b');
  });
});
