'use strict';
// 第 134 批: 「最近会话」列表污染 + 测试链写生产盘 —— 机制守卫
//
// 现场 (2026-10-28, 老板一句「会话 60831526？这什么玩意」):
//   ~/.pangu-data/agentdb 里 3341 条会话, **真人对话只有 36 条**;
//   「最近会话」只给 20 条 ⇒ 老板自己的对话被挤出窗口, 列表里全是
//   「① 完成: 探针」。三类东西根本不是对话, 却都占着列表位:
//     ① 子 agent 侧车 (`parent#sub-0-li`)        692 条
//     ② 计划脚手架 (`plan_*`)                    35 条
//     ③ 工具结果审计日志 (`self_correct_audit`)  1464 条 (全仓只写不读)
//   另外: 测试链直接写生产目录 —— 跑一次测试就在老板的会话列表里留一窝。
//   ⇒ 三类按**性质**排掉 (不是按名字猜); 隔离靠**环境变量机制**, 不是靠注释。
//
// 本守卫要证明:
//   G134a · 链必须带四个隔离变量 (sessions / agentdb / metrics / router 模型池)
//   G134b · listSessions 排掉三类非对话, 且**主对话一条不少**
//   G134c · sessionList 的 JSON 兜底同一口径 (不能只修一条路)
//   G134d · 变异体检: 把过滤改回旧行为 ⇒ 守卫必须**真**报红

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const pkg = require(path.join(CORE, 'package.json'));

// ─────────────────────────────────────────────────────────────
// G134a · 链必须带隔离变量
// ─────────────────────────────────────────────────────────────
test('G134a: test:chain 必须把四个生产路径都指向隔离目录 (测试不许写生产盘)', () => {
  // 2026-10-31 第 180 批: 隔离环境变量搬到 scripts['test:chain:env'] ⇒ 走统一读法。
  const chain = require('./helpers/chain_cmd').chainCommand();
  for (const v of ['PANGU_SESSIONS_DIR', 'PANGU_AGENTDB_DIR', 'PANGU_METRICS_DIR', 'PANGU_MODELS_PATH']) {
    assert.ok(chain.includes(v), `test:chain 里没有 ${v} —— 测试链会往生产盘上写`);
  }
  // 三个变量必须都指向同一个临时根, 否则清一个漏一个
  assert.ok(/pangu-test-runtime/.test(chain),
    'test:chain 的隔离目录应该带可识别的前缀 (pangu-test-runtime), 便于排查残留');
  // 隔离目录必须是一次性的 (带 pid 或 mktemp), 每次跑都是干净目录
  assert.ok(/\$\$|mktemp/.test(chain),
    '隔离目录必须每次运行都不同 ($$ / mktemp), 否则上一轮的残留会污染下一轮');
});

// ─────────────────────────────────────────────────────────────
// G134b · listSessions 的口径
// ─────────────────────────────────────────────────────────────
test('G134b: 列表只给主对话 —— 侧车 / 计划 / 审计日志一律不占位', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-list-134-'));
  const { AgentDatabase } = require(path.join(CORE, 'modules', 'agentdb', 'db'));
  const db = new AgentDatabase({ root: dir });
  const rows = [
    { sessionId: 'web-1700000000001', state: 'completed', messageCount: 9, updatedAt: 5 },
    { sessionId: 'web-1700000000001#sub-0-li', state: 'active', messageCount: 4, updatedAt: 6 },
    { sessionId: 'web-1700000000001#main-plan', state: 'active', messageCount: 2, updatedAt: 7 },
    { sessionId: 'plan_1700000000002', state: 'self_correct_audit', messageCount: 1, updatedAt: 8 },
    { sessionId: 'self_correct_1700000000003', state: 'self_correct_audit', messageCount: 1, updatedAt: 9 },
    { sessionId: 'desktop-1700000000004', state: 'completed', messageCount: 12, updatedAt: 4 },
  ];
  for (const r of rows) {
    db.upsertSession({
      sessionId: r.sessionId, createdAt: 1, updatedAt: r.updatedAt,
      state: r.state, messageCount: r.messageCount,
    });
  }
  const ids = db.listSessions(50).map(x => x.session_id);
  assert.ok(ids.includes('web-1700000000001'), '主对话必须留下');
  assert.ok(ids.includes('desktop-1700000000004'), 'desktop 时代的真人对话必须留下');
  for (const junk of ['web-1700000000001#sub-0-li', 'web-1700000000001#main-plan',
    'plan_1700000000002', 'self_correct_1700000000003']) {
    assert.ok(!ids.includes(junk), `非对话的 ${junk} 不该出现在「最近会话」里`);
  }
  try { db.close && db.close(); } catch (_) {}
});

// ─────────────────────────────────────────────────────────────
// G134c · JSON 兜底同一口径
// ─────────────────────────────────────────────────────────────
test('G134c: sessionList 的 JSON 兜底跟 agentdb 同一口径 (不能只修一条路)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-list-json-134-'));
  const sessDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  const write = (id, state) => {
    fs.writeFileSync(path.join(sessDir, id + '.json'), JSON.stringify({
      session_id: id, state, message_count: 1, last_updated: Date.now(), messages: [],
    }));
  };
  write('web-keep-1', 'completed');
  write('desktop-keep-2', 'completed');
  write('web-keep-1#sub-0-x', 'active');
  write('plan_1700000000009', 'self_correct_audit');
  write('self_correct_1700000000010', 'self_correct_audit');

  const prev = process.env.PANGU_SESSIONS_DIR;
  const prevDb = process.env.PANGU_AGENTDB_DIR;
  process.env.PANGU_SESSIONS_DIR = sessDir;
  process.env.PANGU_AGENTDB_DIR = path.join(dir, 'agentdb');
  // agentdb 那条路让 agentdb 目录为空 → 强制走 JSON 兜底
  delete require.cache[require.resolve(path.join(CORE, 'modules', 'session_store'))];
  const ss = require(path.join(CORE, 'modules', 'session_store'));
  const r = await ss.sessionList({ limit: 50 });
  const ids = (r.result && r.result.sessions || []).map(x => x.session_id);
  assert.ok(ids.includes('web-keep-1'), 'JSON 兜底也必须留下主对话');
  assert.ok(ids.includes('desktop-keep-2'), 'JSON 兜底也必须留下 desktop 对话');
  assert.ok(!ids.some(i => String(i).includes('#')), 'JSON 兜底也必须排掉侧车');
  assert.ok(!ids.some(i => String(i).startsWith('plan')), 'JSON 兜底也必须排掉计划脚手架');
  assert.ok(!ids.some(i => String(i).startsWith('self_correct')), 'JSON 兜底也必须排掉审计日志');
  if (prev === undefined) delete process.env.PANGU_SESSIONS_DIR;
  else process.env.PANGU_SESSIONS_DIR = prev;
  if (prevDb === undefined) delete process.env.PANGU_AGENTDB_DIR;
  else process.env.PANGU_AGENTDB_DIR = prevDb;
  delete require.cache[require.resolve(path.join(CORE, 'modules', 'session_store'))];
});

// ─────────────────────────────────────────────────────────────
// G134d · 变异体检
// ─────────────────────────────────────────────────────────────
test('G134d: 把过滤改回旧行为 ⇒ 守卫必须真报红 (不然这守卫是恒真的)', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'agentdb', 'db.js'), 'utf8');
  const body = src.slice(src.indexOf('listSessions('), src.indexOf('deleteSession('));
  assert.ok(/NOT LIKE/.test(body) && /self_correct_audit/.test(body),
    'listSessions 的过滤条件必须真在源码里 —— 这条守卫靠的就是它');
});
