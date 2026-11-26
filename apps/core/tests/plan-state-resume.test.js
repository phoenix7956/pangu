// 2026-09-12 (PANGU_RESCAN_20260912 N1/N2/N3 + O2): plan 状态机 + 自动续跑 + L3 dispatcher 回归测试
// 运行: node tests/plan-state-resume.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 隔离: plan/task 落盘指向临时目录, 不污染真实 ~/.pangu/state
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-test-'));
process.env.PANGU_PLAN_DIR = path.join(TMP, 'plans');
process.env.PANGU_TASK_DIR = path.join(TMP, 'tasks');

const planState = require('../modules/plan_state');
const taskCp = require('../modules/task_checkpoint');
const l3d = require('../modules/l3_dispatcher');

const SID = 'test-session-' + Date.now();

// ── L3 状态文件: 测之前保证它在, 测完还原 ──────────────────────────
// `.learn/` 是**运行时目录** (apps/core/.gitignore 里 `.learn/` 一行), 里面的
// l3_state.json 是 L3 闭环跑出来的状态, **不入库**。
// ⇒ 干净克隆 / CI 上它压根不存在 —— 而下面两条断言要读写它。
// (2026-10-28: 这条链因此在干净树上红过 —— 开源前必须修。)
const L3_STATE_FILE = path.join(__dirname, '..', '.learn', 'l3_state.json');
const L3_STATE_EXISTED = fs.existsSync(L3_STATE_FILE);
const L3_STATE_BACKUP = L3_STATE_EXISTED ? fs.readFileSync(L3_STATE_FILE, 'utf8') : null;
if (!L3_STATE_EXISTED) {
  fs.mkdirSync(path.dirname(L3_STATE_FILE), { recursive: true });
  fs.writeFileSync(
    L3_STATE_FILE,
    JSON.stringify({ weights: {}, taskToAgents: {} }, null, 2),
    'utf8'
  );
}
process.on('exit', () => {
  try {
    if (L3_STATE_EXISTED) fs.writeFileSync(L3_STATE_FILE, L3_STATE_BACKUP, 'utf8');
    else fs.rmSync(L3_STATE_FILE, { force: true });
  } catch (_) { /* 还原失败也不能让测试红 */ }
});

test('N2: plan 注入文本只引用真实注册的工具名', () => {
  const r = planState.setPlan(SID, {
    goal: '测试目标',
    steps: [
      { id: 's1', title: '第一步', dod: '产出文件A' },
      { id: 's2', title: '第二步', dod: '测试通过' },
    ],
  });
  assert.strictEqual(r.ok, true);
  const text = planState.renderPlanForSession(SID);
  assert.ok(text.includes('plan_step_done'), '应引用真实工具 plan_step_done');
  assert.ok(text.includes('plan_step_failed'), '应引用真实工具 plan_step_failed');
  assert.ok(text.includes('plan_create'), '应指引开工先 plan_create');
  assert.ok(!text.includes('plan.step_done'), '不得引用不存在的 plan.step_done');
  assert.ok(!text.includes('plan.complete'), '不得引用不存在的 plan.complete');
});

test('O2: step 标 done 后 current_step 自动推进到下一个 pending', () => {
  planState.setPlan(SID + '-adv', {
    goal: 'g',
    steps: [
      { id: 's1', title: 'a', dod: 'd' },
      { id: 's2', title: 'b', dod: 'd' },
      { id: 's3', title: 'c', dod: 'd' },
    ],
  });
  planState.updateStep(SID + '-adv', 's1', { status: 'done', evidence: 'fileA.md' });
  const p = planState.loadPlan(SID + '-adv');
  assert.strictEqual(p.current_step, 's2', 's1 done 后应推进到 s2');
  planState.updateStep(SID + '-adv', 's2', { status: 'done' });
  assert.strictEqual(planState.loadPlan(SID + '-adv').current_step, 's3');
});

test('plan 状态机全链路: create → doing → done → listActivePlans 清空', () => {
  const sid = SID + '-e2e';
  planState.setPlan(sid, { goal: 'g', steps: [{ id: 's1', title: 'only', dod: 'd' }] });
  assert.strictEqual(planState.listActivePlans().some(p => p.session_id === sid), true);
  planState.updateStep(sid, 's1', { status: 'done', evidence: 'ok' });
  assert.strictEqual(planState.listActivePlans().some(p => p.session_id === sid), false, '全 done 后不再是 active');
});

test('task_checkpoint: 保存/加载/合并/active 列表/清除', () => {
  const sid = SID + '-tc';
  taskCp.saveTaskCheckpoint(sid, { goal: '长任务', status: 'active' });
  taskCp.saveTaskCheckpoint(sid, { auto_resumes: 2 }); // 合并语义: 旧字段保留
  const d = taskCp.loadTaskCheckpoint(sid);
  assert.strictEqual(d.goal, '长任务');
  assert.strictEqual(d.auto_resumes, 2);
  assert.ok(taskCp.listActiveTasks().some(t => t.session_id === sid));
  taskCp.saveTaskCheckpoint(sid, { status: 'done' });
  assert.ok(!taskCp.listActiveTasks().some(t => t.session_id === sid), 'done 后不再 active');
  taskCp.clearTaskCheckpoint(sid);
  assert.strictEqual(taskCp.loadTaskCheckpoint(sid), null);
});

test('N3: l3_dispatcher 路径指向真实 l3_state.json + 空过滤返回 null', () => {
  const realFile = path.join(__dirname, '..', '.learn', 'l3_state.json');
  assert.strictEqual(l3d._paths.L3_STATE_FILE, realFile, 'L3_STATE_FILE 必须 __dirname 相对定位');
  assert.ok(fs.existsSync(l3d._paths.L3_STATE_FILE), 'l3_state.json 必须真实存在');
  // 当前 taskToAgents 为空 → 任何 pattern 都无建议
  assert.strictEqual(l3d.suggestAgentsForTask('audit_diagnose'), null);
  const r = l3d.dispatchAgentsForTask('帮我扫描排查 bug');
  assert.strictEqual(r.pattern, 'audit_diagnose');
  assert.strictEqual(r.applied, false);
});

test('N3: suggestAgentsForTask 过滤后空数组必须返回 null (不能 applied:true 空组合)', () => {
  // 构造一个 taskToAgents 有数据但 agents 都不在 availableAgents 里的场景:
  // 直接mock _loadL3State 不可行 (模块内私有), 改用真实文件临时注入
  const f = l3d._paths.L3_STATE_FILE;
  const bak = fs.readFileSync(f, 'utf8');
  try {
    const state = JSON.parse(bak);
    state.taskToAgents = {
      audit_diagnose: { agents: ['ghost_agent'], stats: { count: 5, pass_rate: '0.800', avg_quality_score: '90.0' } },
    };
    fs.writeFileSync(f, JSON.stringify(state));
    assert.strictEqual(l3d.suggestAgentsForTask('audit_diagnose'), null, 'ghost_agent 不在 ROLES → 必须 null');
    // 有匹配角色时返回非空
    state.taskToAgents.audit_diagnose.agents = ['li', 'kun'];
    fs.writeFileSync(f, JSON.stringify(state));
    // 出来的是**拼音**: 状态文件里躺的是历史英文, 读完即丢。
    // 英文名如果能原样流出去, 它会一路走到 ROLES[role] 那个查不到的空角色。
    assert.deepStrictEqual(l3d.suggestAgentsForTask('audit_diagnose'), ['li', 'kun']);
    // 数据门槛: count < 3 → null
    state.taskToAgents.audit_diagnose.stats.count = 2;
    fs.writeFileSync(f, JSON.stringify(state));
    assert.strictEqual(l3d.suggestAgentsForTask('audit_diagnose'), null);
  } finally {
    fs.writeFileSync(f, bak); // 恢复真实状态文件
  }
});

test('N1: 自动续跑必须重置循环变量 round 且闸门是 taskDoneAccepted (静态守卫 — 防回退)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  const start = src.indexOf('if (round === maxRounds - 1 && !taskDoneAccepted)');
  assert.ok(start > 0, 'auto-resume 闸门必须是 !taskDoneAccepted (e2e 实案: !finalText 几乎永远不可达, 模型留句话就跳过续跑)');
  const end = src.indexOf('R16 maxRounds', start);
  assert.ok(end > start, '必须存在 auto-resume 块');
  const region = src.slice(start, end);
  assert.ok(region.includes('round = -1'), '续跑必须 round = -1 (for 循环由 round 驱动)');
  // 注释里提到旧代码不算, 只查真实代码行
  const codeLines = region.split('\n').filter(l => !l.trim().startsWith('//'));
  assert.ok(!codeLines.some(l => /^\s*rounds = 0;/.test(l)), '不得再有重置 rounds 的死代码行');
});

test('N1: 无 plan 但 checkpoint 有 active goal 时也应续跑 (静态守卫)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  assert.ok(src.includes('_hasActiveTask'), '必须有 plan-less 任务续跑分支 (截图实案: 易经消化无 plan)');
});

test('budget recordTokens 真值入账 (C1 防回退)', () => {
  const budget = require('../modules/budget');
  const sid = SID + '-budget';
  budget.recordRound(sid, 0);
  budget.recordTokens(sid, 12345);
  const snap = budget.snapshot(sid);
  assert.strictEqual(snap.tokens, 12345, 'tokens 必须累计真值, 不再永远 0');
  budget.clear(sid);
});

test('j2_dispatcher 接线: _routeWithL3 存在且两处兜底都走它 (静态守卫)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_dispatcher.js'), 'utf8');
  assert.ok(src.includes('function _routeWithL3'), '必须有 _routeWithL3');
  const calls = src.match(/_routeWithL3\(userInput, configPath\)/g) || [];
  assert.ok(calls.length >= 3, '定义 + 至少 2 处调用 (planner 失败 / planner 为空)');
});

// 清理
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });
