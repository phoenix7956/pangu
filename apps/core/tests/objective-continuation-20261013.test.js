'use strict';
// 2026-10-13 现场统计 (600 个真实会话) + 逆向 Codex CLI 0.144.4 的 codex_goal_extension:
//
// 【现场】plan 确有 pending/doing 步的会话 4 个, 其中 **4 个**的末条答案都不含任何续作关键词
//         → 全部直接收口, 0 个被续上。
//         反过来, 主日志里 48 次 text_final_continue_intent 放行时, 客观状态**每一次**都是
//         pending=1 或 checkpoint active —— 没有一次是"模型说继续但客观上做完了"。
//         即 _TEXT_CONTINUE_RE 是个多余且不可靠的前置筛选: 它只决定"要不要问",
//         真正拍板的是 _tryAutoResume 里的客观检查。
//
// 【逆向】Codex 的续跑由 codex_goal_extension 拥有: 目标状态说了算, 模型只能把目标标
//         complete / blocked, 不能自己喊一句"继续"就决定续不续。差别不在提示词, 在**谁拍板**。
//
// 修法: 把客观判据提到调用点, 并抽成单一真源 _objectiveWorkRemaining —
//       _tryAutoResume 和收口处必须共用它, 各判一次必然漂移。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-objw-'));
process.env.PANGU_HOME = TMP;
process.env.PANGU_PLAN_DIR = path.join(TMP, 'plans');
process.env.PANGU_TASK_DIR = path.join(TMP, 'tasks');

const plan_state = require('../modules/plan_state');
const checkpoint = require('../modules/task_checkpoint');
const L = require('../modules/j2_agent_loop');
const stripComments = s => s.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
const SRC = stripComments(fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8'));

function mkPlan(sid, steps) {
  plan_state.setPlan(sid, { goal: 'g', steps: steps.map((s, i) => ({ id: 's' + i, title: s, status: s })) });
}
function mkCp(sid, obj) {
  checkpoint.saveTaskCheckpoint(sid, Object.assign({ goal: '继续把活干完' }, obj));
}

test('客观判据: plan 有 pending/doing → 有活没干', () => {
  const sid = 'objw-1';
  mkPlan(sid, ['pending', 'done']);
  assert.equal(L._objectiveWorkRemaining(sid).remaining, true);
});

test('客观判据: plan 全 done 且无 active checkpoint → 没活没干', () => {
  const sid = 'objw-2';
  mkPlan(sid, ['done', 'done']);
  assert.equal(L._objectiveWorkRemaining(sid).remaining, false);
});

test('客观判据: plan 无 pending 但 checkpoint active → 有活没干', () => {
  const sid = 'objw-3';
  mkPlan(sid, ['done']);
  mkCp(sid, { status: 'active' });
  assert.equal(L._objectiveWorkRemaining(sid).remaining, true);
});

// 这条是扫描里 23 条"残留 active"的形态: checkpoint 是 active 但**没有 goal**。
// 把它判成"没干完"会逼模型对着一个早就结束的会话继续干活 —— 那正是过度续跑。
test('checkpoint active 但无 goal → 不算未完成 (别把状态残留当活没干)', () => {
  const sid = 'objw-4';
  mkCp(sid, { status: 'active', goal: '' });
  assert.equal(L._objectiveWorkRemaining(sid).remaining, false);
  assert.equal(L._objectiveWorkRemaining(sid).hasActiveTask, false);
});

test('plan 已有 pending 时 hasActiveTask 必须为 false (互斥, 不能双重计数)', () => {
  const sid = 'objw-5';
  mkPlan(sid, ['pending']);
  mkCp(sid, { status: 'active' });
  const r = L._objectiveWorkRemaining(sid);
  assert.equal(r.hasActiveTask, false, 'pending 非空时不能再声称靠 checkpoint');
  assert.equal(r.remaining, true);
});

test('纯闲聊 (无 plan 无 checkpoint) → 不续跑', () => {
  assert.equal(L._objectiveWorkRemaining('objw-never-existed').remaining, false);
});

// 真正的回归用例: 现场那 4 个漏掉的会话形态 —— plan 还有一步没做, 但模型末条答案里
// 一个续作词都没有。旧逻辑 (文本正则 gate) 在这里不续跑, 直接收口。
test('现场回归: plan 未完成 + 答案无续作关键词 → 客观判据仍判定该续跑', () => {
  const sid = 'objw-6';
  mkPlan(sid, ['done', 'pending']);
  const REAL_FINAL = '作业仍等第 4 题定论：不给我按 D 交。';   // 现场 desktop-1790528544341 原句
  const TEXT_CONTINUE_RE = /(下一步|下轮|还剩|剩余|待做|待补|继续|主人拍|等你拍|等主人拍|待主人|我建议|建议.*拍|未做|未完成|还没动|等你?指令)/;
  assert.equal(TEXT_CONTINUE_RE.test(REAL_FINAL), false, '这条答案确实不含续作关键词 (前提)');
  assert.equal(L._objectiveWorkRemaining(sid).remaining, true,
    '但 plan 明摆着还有一步没做 → 必须判定为可续跑');
});

// 单一真源: _tryAutoResume 的 skip 判据和收口调用点必须共用同一个函数。
// 两处各判一次必然漂移 —— 这类"照着已有修复改第二处"的坑今天已经吃过一次。
test('单一真源: _tryAutoResume 与收口处共用 _objectiveWorkRemaining', () => {
  // 2026-10-17: 两处调用都补上了 { invocationStartedAt } (心跳是不是本次调用写的)。
  // 本护栏要钉的是"恰好两处调用、判据没被复制", 不是"不许带参数" —— 所以按调用形状匹配。
  assert.equal((SRC.match(/_objectiveWorkRemaining\(_sessionId[^)]*\)/g) || []).length, 2,
    '必须恰好两处调用 (_tryAutoResume 内 + 收口 gate), 多处少处都说明判据被复制了');
  assert.match(SRC, /if \(!_obj\.remaining\)/,
    '_tryAutoResume 的 skip 判据必须用这个函数的结果, 不能自己再读一遍 plan/checkpoint');
  // _tryAutoResume 内不得再直接 loadPlan/loadTaskCheckpoint 做未完成判定
  const iCall = SRC.indexOf('_objectiveWorkRemaining(_sessionId');
  const body = SRC.slice(SRC.indexOf('const _tryAutoResume'), SRC.indexOf('\n', iCall));
  assert.doesNotMatch(body, /_pending\.length === 0/,
    '_tryAutoResume 里不许再写一套 pending 判据');
});

test('接线: 收口处先用客观判据, 文本意图退居其后', () => {
  const iObj = SRC.indexOf('const _objGate = _objectiveWorkRemaining(_sessionId');
  const iText = SRC.indexOf('const _TEXT_CONTINUE_RE =');
  assert.ok(iObj > 0 && iText > 0, '两个 gate 都必须在');
  assert.ok(iObj < iText, '客观判据必须在文本意图之前 —— 谁拍板决定有没有效');
  // 客观 gate 必须带 round 预算护栏, 否则会无限续跑
  assert.match(SRC.slice(iObj, iText), /round < maxRounds - 1/,
    '客观 gate 必须仍有轮次护栏');
  assert.match(SRC.slice(iObj, iText), /_tryAutoResume\('objective_incomplete'\)/,
    '客观 gate 必须走 auto_resume, 不能自己改预算');
});

test('证据: reason 命名要能区分客观续跑与文本意图续跑', () => {
  assert.match(SRC, /objective_incomplete/);
  assert.match(SRC, /text_final_continue_intent/,
    '文本意图这条路留着做兜底, 但不再是主判据');
});

// 2026-10-13 实踩: 把 `_pending` 改名成 `_pendingCount`、`tc` 改名成 `_tc` 时漏改三处,
// 残留引用变成 ReferenceError —— 其中两处正好落在 `catch (_) {}` 里被**静默吞掉**,
// 表现是"auto_resume 事件发不出去", 看起来像功能没生效, 不像代码坏了。
// e2e 里三条 S2/S2b/S4 变红才定位到。这条守卫防的就是"改完名自认为改干净了"。
test('改名不留悬空引用: _tryAutoResume 里不许再出现 _pending / tc.', () => {
  const i = SRC.indexOf('const _tryAutoResume');
  assert.ok(i > 0, '找不到 _tryAutoResume');
  // 取到下一个顶层注释为止即可覆盖整个函数体
  const body = SRC.slice(i, i + 4000);
  const stale = body.split('\n')
    .map((l, k) => [k + 1, l])
    .filter(([, l]) => /(^|[^\w])_pending\b/.test(l) || /(^|[^\w])tc\./.test(l));
  assert.deepEqual(stale, [],
    '悬空引用(改名漏改, 会被空 catch 吞成静默失败): ' + JSON.stringify(stale));
});
