'use strict';
// 2026-10-15: POST /api/pangu/admin/compact 是**假成功** ——
//
// 现场 (实测):
//   POST /api/pangu/admin/compact {"session_id":"fctest-1"}
//     -> {"ok":true,"queued":true,"budget_reset":{"ok":true,"resets":1}}
//   再给这个 session 连发两条消息 -> 队列条目纹丝不动, session 文件也没变。
//
// 根因: 队列唯一的消费者在主循环内 (j2_agent_loop §0.32 那段), 而**主循环只对子 session 跑**。
//   实测 `fctest-1` 走 dispatcher, 自己 spawn 的是 `fctest-1#sub-0-analyzer`,
//   真正进那个循环的 `_sessionId` 永远是子 id。UI 上照抄的主 session id 入队之后
//   永远不会被消费, 而接口还回了 ok:true —— 顺带白拿一份 round budget
//   (为一个永远不会发生的压缩发额度, 这本身就是额度漏洞)。
//
// 修 (j2_agent_loop.forceCompactSession): 磁盘上有这个 session 就**当场压 + 落盘**,
//   回真实的 before/after; 压不了且容器也不认识它 -> 拒绝, 不入队、不发预算。
//
// 注意别改错东西: 空闲自动压缩 (watchdog -> requestForceCompact) 那条路**本来就是通的** ——
//   watchdog 入队的和消费者检查的是同一批 _sessionId (都由主循环 markRoundActivity 写入),
//   实测两者对得上。坏的只有 HTTP 端点这条。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GAR = '[运行环境 — 路径铁律]';
const countRealGar = (ms) => ms.filter(m => String(m.content || '').indexOf(GAR) === 0).length;

// session_store 的 currentSessionsDir() 是**调用时**读 env 的, 所以这里先设再 require 也来得及。
const _dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-fc-'));
process.env.PANGU_SESSIONS_DIR = path.join(_dataDir, 'sessions');
// 2026-10-15 补: 只重定向 SESSIONS_DIR **不够** —— session_store 读 session 时是
// "AgentDB 优先, JSON 兜底", 而 AgentDB 认的是 PANGU_AGENTDB_DIR (默认 ~/.pangu-data/agentdb),
// 不受 SESSIONS_DIR 管。于是本测试写进临时目录的假 session, 读的时候却撞上**生产库**里
// 上一次跑测试留下的同名旧行, AgentDB 赢 → "压完 4 -> 4"。
// 更糟的是每跑一次就往生产库塞一条垃圾 session (实测已攒到 fc-inline-1 / fc-keep-1 / fc-inline-2)。
process.env.PANGU_AGENTDB_DIR = path.join(_dataDir, 'agentdb');

const j2 = require('../modules/j2_agent_loop');

function writeSession(sid, messages, extra) {
  fs.mkdirSync(process.env.PANGU_SESSIONS_DIR, { recursive: true });
  const rec = Object.assign({
    session_id: sid,
    plan_id: null,
    messages: messages,
    compaction_summary: '',
    state: 'active',
    message_count: messages.length,
    last_updated: Date.now(),
    plan_state: null,
  }, extra || {});
  fs.writeFileSync(path.join(process.env.PANGU_SESSIONS_DIR, sid + '.json'), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

function readSession(sid) {
  return JSON.parse(fs.readFileSync(path.join(process.env.PANGU_SESSIONS_DIR, sid + '.json'), 'utf8'));
}

function dupHeavySession() {
  const gar = GAR + '\n主机: test.local\n' + '铁律正文。'.repeat(300);
  const msgs = [
    { role: 'system', content: gar },
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '结论: 第一轮干完了。'.repeat(4) },
    { role: 'system', content: gar },
    { role: 'system', content: gar },
  ];
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: 'assistant', content: '第 ' + i + ' 轮结论文字' });
    msgs.push({ role: 'user', content: '追问 ' + i });
  }
  return msgs;
}

test('端点必须当场压缩并落盘, 而不是只回一句 queued:true', async () => {
  const sid = 'fc-inline-1';
  writeSession(sid, dupHeavySession());

  const r = await j2.forceCompactSession(sid);

  assert.equal(r.ok, true, '必须成功: ' + JSON.stringify(r));
  assert.equal(r.mode, 'inline', '必须走当场压缩, 不是排队');
  assert.ok(Number.isInteger(r.from) && Number.isInteger(r.to), '必须回真实的 before/after');
  assert.ok(r.to < r.from, '压完必须真的变短: ' + r.from + ' -> ' + r.to);

  const after = readSession(sid);
  assert.equal(after.messages.length, r.to, '落盘条数必须和返回值一致 (不然调用方看到的和真实状态不是一回事)');
  assert.equal(countRealGar(after.messages), 1,
    '逐字相同的三份铁律压完只能剩 1 份, 实际 ' + countRealGar(after.messages) + ' 份');
});

test('当场压缩不许把 plan_state / state 抹掉 (只该换 messages)', async () => {
  const sid = 'fc-keep-1';
  writeSession(sid, dupHeavySession(), {
    state: 'checkpointed',
    plan_state: { pendingPlan: { plan_id: 'plan_x', task: '把 a1/a2/a3 写完并核对' } },
  });

  await j2.forceCompactSession(sid);

  const after = readSession(sid);
  assert.equal(after.state, 'checkpointed', 'state 被抹了 —— 断点续跑会直接失效');
  assert.ok(after.plan_state, 'plan_state 被抹了 —— 压缩后就没法接着干');
  assert.equal(after.plan_state.pendingPlan.task, '把 a1/a2/a3 写完并核对');
  assert.equal(after.session_id, sid, 'session_id 不能被改');
});

test('不存在的 session: 必须拒绝, 不许入队也不许发预算', async () => {
  // 这是原来最阴的一条: 乱写一个 id -> {"ok":true,"queued":true} + budget_reset,
  // 之后那个条目就永远躺在队列里, 还会白拿一份 round budget。
  const before = j2.listForceCompactQueue().length;
  const r = await j2.forceCompactSession('no-such-session-xyz');
  assert.equal(r.ok, false, '压不了就必须说失败, 不许 ok:true');
  assert.equal(r.queued, false, '不认识的 session 不该入队');
  assert.equal(r.budget_reset, null, '没发生压缩就不该发 round budget');
  assert.equal(j2.listForceCompactQueue().length, before, '队列长度不许变化');
  assert.ok(r.note && r.note.length > 0, '必须给出人能看懂的下一步提示');
});

test('重复调用必须给出确定结果, 不许越压越长', async () => {
  const sid = 'fc-inline-2';
  writeSession(sid, dupHeavySession());
  const r1 = await j2.forceCompactSession(sid);
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const afterFirst = readSession(sid).messages.length;
  const r2 = await j2.forceCompactSession(sid);
  assert.equal(typeof r2, 'object', '必须回对象');
  assert.ok(readSession(sid).messages.length <= afterFirst,
    '不许越压越长: ' + afterFirst + ' -> ' + readSession(sid).messages.length);
});

test('过短会话不许被压成一个坏产物', async () => {
  const sid = 'fc-short-1';
  writeSession(sid, [{ role: 'user', content: '只有一条' }]);
  const r = await j2.forceCompactSessionNow(sid);
  assert.equal(r.ok, false, '一条消息压了等于删');
  assert.equal(readSession(sid).messages.length, 1, '必须原样不动');
});

test('idle 自动压缩那条路没坏: watchdog 和消费者用的是同一批 id', async () => {
  // 防止有人把「HTTP 端点改成当场压」顺手改成「把队列彻底删了」——
  // 空闲自动压缩依赖的正是 markRoundActivity -> requestForceCompact -> 主循环消费这条链。
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  assert.ok(src.indexOf('_sessionLastRoundAt.set(sessionId, Date.now())') >= 0,
    'markRoundActivity 必须在, 否则 watchdog 判定不出 idle');
  assert.ok(src.indexOf('if (_forceCompactQueue.has(_sessionId))') >= 0,
    '主循环里的队列消费点必须保留');
  assert.ok(src.indexOf('resetRoundsAfterCompaction') >= 0, '预算续命逻辑必须保留');
});
