'use strict';

// 2026-10-17 现场 (q-1792197270649): objective_incomplete 这道门对**每个子 agent 恒为真**。
//
// 判据是 `cp.status === 'active' && cp.goal`, 但 status:'active' 是**循环自己每轮写的**
// (j2_agent_loop.js:1896, 注释自陈是"崩溃恢复"心跳):
//     tc.saveTaskCheckpoint(sid, { goal: userInput, status: 'active', ... })
// 同一个字段被当成两件事用 —— **循环在给自己打分**。
//
// 对没有 plan 的 session (即每一个子 agent: loadPlan('q-…#sub-2-checker') 返回 **null**),
// pending 恒为 0, 于是 hasActiveTask 退化成 "status==='active' && goal 非空",
// 而这两项刚被本循环写过 → 恒 true → remaining 恒 true。
// 于是: 模型第一遍没调 task_done → objective_incomplete **必定**触发一次自动续跑,
// 白烧一整轮往返 + 一次 compact。
//
// 这次续跑有用吗? 725 个子 agent checkpoint 实测收口率:
//   auto_resumes=0  (505): 168 收口 → 33%   ← 基线
//   auto_resumes=1  (145):  54 收口 → 37%   ← 续一次与"能不能收口"零相关
//   auto_resumes>=2 ( 75):  12 收口 → 16%   ← 越续越不成
// 日志窗口内也对得上: auto-resume 55 次, 54 次是 #1/3, 50 次 reason=objective_incomplete。
//
// 修: 判据不落在 _objectiveWorkRemaining (那是 _tryAutoResume 的**总**闸门,
//     partial_task_done / task_done_rejected / 崩溃恢复都走它, 一个字不能动),
//     落在 objective_incomplete 这道门专用的 _objectiveGateOpen 上。
//
// ⚠️ 走过的弯路, 别再走一遍: 第一版把 selfAuthored 直接塞进 hasActiveTask,
//    打红了 guard_e2e_scenarios 的 S2/S4 —— 那两个是 2026-09-14 三命通会现场的回归锁,
//    钉的是"plan 全 done 但模型还没 task_done 交验时必须再给一轮", 而它们的证据**也是**
//    本次调用自己写的心跳。旧码 6/6 → 新码 4/6, 只有拿旧码对照才当场抓得到。
//    真分界是**有没有 plan**, 不是"谁写的"。本文件的下面几组断言就是钉这个分界的。
// 隔离必须先于任何 require —— plan_state / task_checkpoint 加载即锁目录,
// 不隔离的话本文件会往**真实的** ~/.pangu/state/{plans,tasks} 里写测试垃圾。
const fs = require('fs');
const os = require('os');
const pathmod = require('path');
const _TMP = fs.mkdtempSync(pathmod.join(os.tmpdir(), 'pangu-objgate-'));
process.env.PANGU_PLAN_DIR = pathmod.join(_TMP, 'plans');
process.env.PANGU_TASK_DIR = pathmod.join(_TMP, 'tasks');
fs.mkdirSync(process.env.PANGU_PLAN_DIR, { recursive: true });
fs.mkdirSync(process.env.PANGU_TASK_DIR, { recursive: true });

const test = require('node:test');
const assert = require('node:assert');

const { _objectiveWorkRemaining, _objectiveGateOpen } = require('../modules/j2_agent_loop');
const tc = require('../modules/task_checkpoint');
const ps = require('../modules/plan_state');

let n = 0;
const sid = () => 'objg-' + process.pid + '-' + (n++);
const iso = (t) => new Date(t).toISOString();
const done = (s) => { try { tc.clearTaskCheckpoint(s); } catch (_) {} try { ps.clearPlan(s); } catch (_) {} };

test('核心修复: 无 plan + 心跳是本次调用自己写的 → objective 门不开', () => {
  const S = sid();
  const now = Date.now();
  // 循环本轮刚写的心跳 (崩溃恢复用途)
  tc.saveTaskCheckpoint(S, { goal: '子任务目标', status: 'active', updated_at: iso(now) });
  const r = _objectiveWorkRemaining(S, { invocationStartedAt: now - 1000 });
  assert.strictEqual(r.selfAuthored, true, '必须认出这份 checkpoint 是本次调用写的');
  assert.strictEqual(r.hasPlan, false, '子 agent 没有 plan');
  assert.strictEqual(r.pending, 0);
  assert.strictEqual(_objectiveGateOpen(r), false,
    '循环自己的心跳不是"还有活没干完"的证据 —— 拿它当判据就是循环给自己打分, 每个子 agent 白烧一轮');
  done(S);
});

test('崩溃恢复不能被这次修复打死: 上一轮遗留的心跳仍然要续跑', () => {
  const S = sid();
  const now = Date.now();
  // 上一次进程崩了留下的心跳 (早于本次调用)
  tc.saveTaskCheckpoint(S, { goal: '没干完的目标', status: 'active', updated_at: iso(now - 60000) });
  const r = _objectiveWorkRemaining(S, { invocationStartedAt: now });
  assert.strictEqual(r.selfAuthored, false, '旧的 checkpoint 不是本次写的');
  assert.strictEqual(r.hasActiveTask, true);
  assert.strictEqual(r.remaining, true, '崩溃恢复的续跑行为必须一字不变');
  assert.strictEqual(_objectiveGateOpen(r), true, '崩溃恢复必须还能续 —— 这是这道门存在的正当理由');
  done(S);
});

test('plan 驱动的续跑不能被这次修复打死 (长任务主路径)', () => {
  const S = sid();
  const now = Date.now();
  ps.setPlan(S, { goal: '长任务', steps: [{ id: 's1', status: 'pending', title: 'a' }, { id: 's2', status: 'done', title: 'b' }] });
  tc.saveTaskCheckpoint(S, { goal: 'g', status: 'active', updated_at: iso(now) });
  const r = _objectiveWorkRemaining(S, { invocationStartedAt: now - 1000 });
  assert.strictEqual(r.pending, 1, 'plan 说还有一步没做');
  assert.strictEqual(_objectiveGateOpen(r), true,
    'plan 说没干完就必须能续 —— 这是长任务真正依赖的路径, 不许被"心跳不算数"误伤');
  done(S);
});

test('plan 全 done 但模型没交验 → 门仍要开 (S2/S4 现场锁的反面, 第一版就是错在这)', () => {
  const S = sid();
  const now = Date.now();
  ps.setPlan(S, { goal: '长任务', steps: [{ id: 's1', status: 'done', title: 'a' }, { id: 's2', status: 'done', title: 'b' }] });
  tc.saveTaskCheckpoint(S, { goal: 'g', status: 'active', updated_at: iso(now) });
  const r = _objectiveWorkRemaining(S, { invocationStartedAt: now - 1000 });
  assert.strictEqual(r.pending, 0);
  assert.strictEqual(r.hasPlan, true);
  assert.strictEqual(_objectiveGateOpen(r), true,
    'plan 全 done ≠ 收口。模型还没 task_done 交验, 必须再给一轮 —— guard_e2e_scenarios 的 S2/S4 ' +
    '(2026-09-14 三命通会现场) 钉的就是这条。第一版把 selfAuthored 塞进 hasActiveTask, 这里就红了。');
  done(S);
});

test('_objectiveWorkRemaining 本体语义一字未改 (_tryAutoResume 的总闸门靠它)', () => {
  // 2026-10-17 第一版把 selfAuthored 塞进 hasActiveTask, 顺手把 partial_task_done /
  // task_done_rejected_last_round / 崩溃恢复三条路径一起改了 —— 那些场景续跑是对的。
  // 这条断言的作用是: 以后谁再想往本体里塞新判据, 这条会红。
  const S = sid();
  const now = Date.now();
  tc.saveTaskCheckpoint(S, { goal: 'g', status: 'active', updated_at: iso(now) });
  const r = _objectiveWorkRemaining(S, { invocationStartedAt: now - 1000 });
  assert.strictEqual(r.hasActiveTask, true,
    '本体判据必须是 pending===0 && status==active && goal —— 心跳自己算不算数, 由 _objectiveGateOpen 决定, 不许动本体');
  assert.strictEqual(r.remaining, true);
  done(S);
});

test('无 plan + 没有 active 心跳 → 门本来就不开 (不许被这次修复改变)', () => {
  const S = sid();
  const now = Date.now();
  tc.saveTaskCheckpoint(S, { goal: 'g', status: 'done', updated_at: iso(now) });
  const r = _objectiveWorkRemaining(S, { invocationStartedAt: now - 1000 });
  assert.strictEqual(r.remaining, false);
  assert.strictEqual(_objectiveGateOpen(r), false);
  done(S);
});

test('不传 invocationStartedAt 的旧调用方 (单测/内联路由导出) 保持旧语义', () => {
  // inline_router 也导出这个纯函数给单测用, 它不传 opts。
 // 这里必须显式钉住: 不传 opts 时**不**因为这次修复而改变行为, 免得静默改掉别人的用法。
  const S = sid();
  tc.saveTaskCheckpoint(S, { goal: 'g', status: 'active', updated_at: iso(Date.now()) });
  const r = _objectiveWorkRemaining(S);
  assert.strictEqual(r.selfAuthored, false, '没有 invocationStartedAt 就判不出是不是自己写的');
  assert.strictEqual(r.remaining, true, '旧调用方语义保持原样 (保守方向)');
  assert.strictEqual(_objectiveGateOpen(r), true, '判不出就按有证据处理 —— 保守方向, 宁可多续一轮也不误砍长任务');
  done(S);
});

test('返回的布尔字段必须真的是布尔 (hasActiveTask 曾漏过 !! 收口)', () => {
  const S = sid();
  tc.saveTaskCheckpoint(S, { goal: 'g', status: 'active', updated_at: iso(Date.now()) });
  for (const r of [_objectiveWorkRemaining(S), _objectiveWorkRemaining(S, { invocationStartedAt: Date.now() })]) {
    assert.strictEqual(typeof r.hasActiveTask, 'boolean', '字段说是布尔就必须是布尔, 调用方不该替它做类型判断');
    assert.strictEqual(typeof r.remaining, 'boolean');
    assert.strictEqual(typeof r.selfAuthored, 'boolean');
    assert.strictEqual(typeof r.hasPlan, 'boolean');
    assert.strictEqual(typeof _objectiveGateOpen(r), 'boolean');
  }
  done(S);
});

// ── 接线守卫 ────────────────────────────────────────────────────────────
// 上面 8 条全是**纯函数**断言, 它们绿只说明 _objectiveGateOpen 本身算对了。
// 判据被复制一份、或者调用点没走这个函数, 单测照样全绿 —— 这正是本轮踩过的坑的形状
// (第一版规则写对了、测试也绿了, 实机 S2/S4 直接红)。所以必须钉住接线。
test('接线: objective_incomplete 这道门必须走 _objectiveGateOpen, 不许直接读 .remaining', () => {
  const SRC = fs.readFileSync(
    pathmod.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  assert.match(SRC, /_objectiveGateOpen\(_objGate\)/,
    '收口处的 objective 门必须调 _objectiveGateOpen(obj)');
  // objective 门那个 if 条件里不许再出现裸的 _objGate.remaining
  const iGate = SRC.indexOf('const _objGate = _objectiveWorkRemaining(');
  assert.ok(iGate > 0, '收口处必须有 objective 判据调用');
  const condStart = SRC.indexOf('if (', iGate);
  const cond = SRC.slice(condStart, SRC.indexOf(') {', condStart));
  assert.doesNotMatch(cond, /_objGate\.remaining/,
    'objective 门不许绕过 _objectiveGateOpen 直接读 .remaining —— 那就是循环给自己打分');
  assert.match(cond, /_objectiveGateOpen/,
    'objective 门的 if 条件必须出现 _objectiveGateOpen');
});

test('接线: _tryAutoResume 内的调用不许带 invocationStartedAt (总闸门语义必须保持原样)', () => {
  const SRC = fs.readFileSync(
    pathmod.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  const iTry = SRC.indexOf('const _tryAutoResume');
  const iObj = SRC.indexOf('_objectiveWorkRemaining(_sessionId', iTry);
  assert.ok(iTry > 0 && iObj > iTry, '_tryAutoResume 里必须有这次调用');
  const callLine = SRC.slice(SRC.lastIndexOf('\n', iObj) + 1, SRC.indexOf('\n', iObj));
  assert.match(callLine, /_objectiveWorkRemaining\(_sessionId\);/,
    '总闸门必须用原语义 (心跳 active 就是上次没干完) —— partial_task_done / ' +
    'task_done_rejected / 崩溃恢复三条路径都靠它。第一版在这里传了 invocationStartedAt, ' +
    '顺手把这三条一起改了, 结果 S2/S4 红了。');
});

test('接线: text_final_continue_intent 也必须走 _objectiveGateOpen (不许留后门)', () => {
  // 现场 q-1792198449369: objective_incomplete 修好之后 (归零), 3 次续跑全部
  // reason=text_final_continue_intent, 三次都是 checker, pending=0 / plan=null ——
  // 跟修之前是同一笔白烧, 只是换了个 reason。所以前门关了就必须把后门也关上。
  const SRC = fs.readFileSync(
    pathmod.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  const iText = SRC.indexOf("const _TEXT_CONTINUE_RE =");
  assert.ok(iText > 0, 'text 续作意图门必须还在');
  const condStart = SRC.indexOf('if (', iText);
  const cond = SRC.slice(condStart, SRC.indexOf(') {', condStart));
  assert.match(cond, /_objectiveGateOpen\(_objGate\)/,
    'text_final_continue_intent 必须过同一个客观闸门 —— 代码注释自己写着"真正拍板的是客观检查"');
  // 顺序: 客观闸门必须排在文本筛选之后同层出现 (两者都是 && 项), 不许被 || 分支绕过
  assert.ok(cond.indexOf('_TEXT_CONTINUE_RE') < cond.indexOf('_objectiveGateOpen'),
    '客观闸门跟文本筛选同层并列, 不许改成短路绕过');
});
