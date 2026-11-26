const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ===========================================================================
// LM Studio 的 VLM prompt 缓存顶满 → 命中率崩 → 同一句问在 79.9s 和 274.8s 之间跳
//
// 清理前: used_mib=41678.2 / cap_mib=41680.0 (99.996%)
//         lifetime_evicted_mib=41821.8   命中最好 10240 / 22883
// 重载后: used_mib=13948.2 / cap_mib=41680.0 (33%)
//         lifetime_evicted_mib=0.0       命中最好 28416 / 292
//
// 一次盘古请求写 182 条记录 (实测 records 422 → 604), ≈6GB,
// 41GB 上限 → 大约 7 次请求就顶满。
//
// LM Studio 没暴露缓存 API (/api/v0/cache 返 "Unexpected endpoint"),
// 唯一权威源是它自己的服务端日志; 唯一官方重置路径是卸载+重载 (lifetime=model_load)。
// 但重载 10~25s 且期间请求失败, 所以**宁可不重载也绝不能打断在途请求** ——
// 这条守卫的全部设计重心就在这里。
// ===========================================================================

const G = require('../modules/lmstudio_cache_guard');

const FULL = { used_mib: 41678.2, cap_mib: 41680.0, ratio: 41678.2 / 41680.0 };
const HEALTHY = { used_mib: 13948.2, cap_mib: 41680.0, ratio: 13948.2 / 41680.0 };
const IDLE_OK = 10 * 60 * 1000;

test('缓存顶满 + 确实空闲 → 允许重载', () => {
  const d = G.decide({ pressure: FULL, activeRounds: 0, idleMs: IDLE_OK, lastReloadAt: 0 });
  assert.equal(d.ok, true);
  assert.equal(d.reason, 'cache_pressure_idle');
});

test('有请求在飞 → 绝对不重载 (这是整个守卫最重要的一条)', () => {
  for (const active of [1, 2, 17]) {
    const d = G.decide({ pressure: FULL, activeRounds: active, idleMs: IDLE_OK, lastReloadAt: 0 });
    assert.equal(d.ok, false, 'activeRounds=' + active + ' 时重载会打断主人正在做的事');
    assert.equal(d.reason, 'busy');
    assert.equal(d.activeRounds, active);
  }
});

test('空闲不够久 → 不重载 (防止两句话之间的停顿被当成"没人用")', () => {
  const d = G.decide({ pressure: FULL, activeRounds: 0, idleMs: 10 * 1000, lastReloadAt: 0 });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'not_idle_enough');
  assert.equal(d.required_ms, G.IDLE_REQUIRED_MS);
});

test('冷却期内不重复重载 (否则每次 tick 都卸一遍, 主人永远等在模型加载上)', () => {
  const d = G.decide({
    pressure: FULL, activeRounds: 0, idleMs: IDLE_OK,
    lastReloadAt: Date.now() - 60 * 1000,
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'cooldown');
  assert.equal(d.cooldown_ms, G.RELOAD_COOLDOWN_MS);
});

test('缓存健康 → 不碰模型 (别为了"顺手"去打断别人的好状态)', () => {
  const d = G.decide({ pressure: HEALTHY, activeRounds: 0, idleMs: IDLE_OK, lastReloadAt: 0 });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'cache_healthy');
});

test('读不到缓存数据 → 不做任何事 (拿不准就不动)', () => {
  for (const pressure of [null, undefined]) {
    const d = G.decide({ pressure, activeRounds: 0, idleMs: IDLE_OK, lastReloadAt: 0 });
    assert.equal(d.ok, false);
    assert.equal(d.reason, 'no_pressure_data');
  }
  assert.equal(G.decide({}).ok, false, '空参数也不能崩成 true');
});

test('只认 LM Studio 的本地模型 (云端模型没这个缓存, 别去 unload 云端)', () => {
  assert.equal(G.guardApplies({ provider: 'lmstudio' }), true);
  assert.equal(G.guardApplies({ provider: 'moonshot', endpoint: 'https://api.moonshot.cn/v1' }), false);
  assert.equal(G.guardApplies({ provider: 'k3', endpoint: 'http://127.0.0.1:9999' }), false);
  assert.equal(G.guardApplies(null), false);
});

test('日志解析只认 used_mib + cap_mib 同时出现的行, 半截数据不认', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmg-'));
  const f = path.join(dir, 'x.log');
  fs.writeFileSync(f, [
    'noise',
    'used_mib=100.0 cap_mib=41680.0 lifetime_evicted_mib=0.0 records=1',
    'broken line used_mib=99999.0 without cap',
    'used_mib=20131.2 cap_mib=41680.0 lifetime_evicted_mib=0.0 records=604',
    'trailing used_mib=cap_mib=',   // 半截, 必须被忽略
  ].join('\n'));
  const p = G.readCachePressure(f);
  assert.equal(p.used_mib, 20131.2, '必须取最后一条**完整**的行');
  assert.equal(p.cap_mib, 41680.0);
  assert.ok(Math.abs(p.ratio - 20131.2 / 41680) < 1e-9);
  // 垃圾输入不能变成一个"看起来很满"的压力值
  fs.writeFileSync(f, 'used_mib=99999.0 without cap\ntrailing garbage');
  assert.equal(G.readCachePressure(f), null);
  assert.equal(G.readCachePressure(path.join(dir, 'nope.log')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cap<=0 或非数字不能除出 Infinity/NaN', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmg2-'));
  const f = path.join(dir, 'x.log');
  fs.writeFileSync(f, 'used_mib=1.0 cap_mib=0.0');
  assert.equal(G.readCachePressure(f), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('latestLogPath 指向当天最新那份 (跨零点/刚启动也不会瞎指)', () => {
  const p = G.latestLogPath();
  assert.ok(p && p.endsWith('.log'), '必须能找到日志, 实际: ' + p);
  assert.ok(fs.existsSync(p));
});

test('重载后必须能被记住, 冷却窗口真的会生效', () => {
  G.resetForTests();
  assert.equal(G.lastReloadAt(), 0);
  G.markReloaded('cache_pressure_idle');
  assert.ok(G.lastReloadAt() > 0);
  const d = G.decide({ pressure: FULL, activeRounds: 0, idleMs: IDLE_OK, lastReloadAt: G.lastReloadAt() });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'cooldown', 'markReloaded 存在却没起作用 = 守卫会每分钟卸一次模型');
  G.resetForTests();
});

test('j2_agent_loop 必须导出 _sessionStats —— 守卫靠它判断"有没有人在用"', () => {
  const loop = require('../modules/j2_agent_loop');
  assert.equal(typeof loop._sessionStats, 'function');
  const s = loop._sessionStats();
  assert.ok(Number.isInteger(s.activeRounds), 'activeRounds 必须是整数, 实际: ' + s.activeRounds);
});

test('守卫只接在维护 tick 上, 不得出现在请求路径里', () => {
  const src = fs.readFileSync(require.resolve('../pangu-single.js'), 'utf8');
  const hits = src.match(/lmstudio_cache_guard/g) || [];
  assert.ok(hits.length >= 1, '守卫必须被接上');
  const idx = src.indexOf('lmstudio_cache_guard');
  const window = src.slice(Math.max(0, idx - 400), idx + 900);
  assert.match(window, /setInterval/, '必须挂在定时器上, 不能在请求处理里跑');
});

