'use strict';

/**
 * 2026-10-15 — sessionLoad 必须"取两个数据源里更新的那个", 不能无条件信 AgentDB
 *
 * 起因 (不是理论问题, 是当场实测):
 *   force-compact-endpoint 测试往 JSON 写了 17 条消息, forceCompactSession 读回来 4 条。
 *   原因不是压缩坏了, 而是 session_store.sessionLoad 的读写不对称:
 *
 *     sessionSave → 先写 JSON, 再写 AgentDB; AgentDB 抛错时 catch 明写
 *                   "JSON fallback retained" (言下之意: 还有 JSON 兜着)
 *     sessionLoad → 只查 AgentDB, 查不到才读 JSON
 *
 *   那个 fallback 于是是**只写不读**的: 只要 AgentDB 有一次写失败 / 落后,
 *   JSON 里躺着新消息而 AgentDB 冻着旧消息, sessionLoad 会永远返回旧的,
 *   而且**没有任何标记**告诉调用方你拿到的是哪一版。
 *
 *   现场那 4 条就是这么来的: 生产 AgentDB (~/.pangu-data/agentdb, 91MB / 1322 session)
 *   里有一条同名旧行, AgentDB 优先, 把刚写的 17 条整个盖住了。
 *
 * 本测试把"按 last_updated 取新的"钉成不变量, 并保证平手时仍偏向 AgentDB
 * (正常写入路径下两边同刻, 不改变既有语义)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 两个数据源都得重定向。只改 SESSIONS_DIR 的话, AgentDB 仍会打到生产库 ——
// 那正是本 bug 当场撞出来的方式。
const _dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-two-src-'));
process.env.PANGU_SESSIONS_DIR = path.join(_dataDir, 'sessions');
process.env.PANGU_AGENTDB_DIR = path.join(_dataDir, 'agentdb');

const store = require('../modules/session_store');

const jsonPath = (sid) => path.join(process.env.PANGU_SESSIONS_DIR, sid + '.json');

function msgs(n, tag) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ role: i % 2 ? 'user' : 'assistant', content: `${tag}-${i}` });
  return out;
}

// AgentDB 时间戳 = ts; JSON 时间戳 = 落盘那一刻。分开的。
async function saveDiverged(sid, agentdbTs, jsonTs, nMsgs) {
  await store.sessionSave({ session_id: sid, messages: msgs(nMsgs, sid), ts: agentdbTs });
  const rec = JSON.parse(fs.readFileSync(jsonPath(sid), 'utf8'));
  rec.last_updated = jsonTs;
  rec.messages = msgs(nMsgs, sid + '-json');
  fs.writeFileSync(jsonPath(sid), JSON.stringify(rec, null, 2), 'utf8');
}

test('JSON 更新时必须返回 JSON (AgentDB 写失败后的 fallback 终于能读到了)', async () => {
  const sid = 'two-src-json-newer';
  await saveDiverged(sid, 1_000, 9_000, 6);

  const r = await store.sessionLoad({ session_id: sid });
  assert.equal(r.ok, true);
  assert.equal(r.result.messages.length, 6);
  assert.equal(r.result.messages[0].content, `${sid}-json-0`,
    '返回的必须是 JSON 那一版 —— 这条以前返回的是 AgentDB 的旧数据');
  assert.equal(r.stale_agentdb, true, '必须标记出来是降级副本, 不能无声无息');
});

test('AgentDB 更新时必须返回 AgentDB (别把新数据让给旧文件)', async () => {
  const sid = 'two-src-db-newer';
  await saveDiverged(sid, 9_000, 1_000, 6);

  const r = await store.sessionLoad({ session_id: sid });
  assert.equal(r.ok, true);
  assert.equal(r.result.messages[0].content, `${sid}-0`,
    'AgentDB 较新时必须用它 —— 否则就是反向的同一个 bug');
});

test('两边同刻: 仍偏向 AgentDB (保持原有语义)', async () => {
  const sid = 'two-src-tie';
  await saveDiverged(sid, 5_000, 5_000, 4);

  const r = await store.sessionLoad({ session_id: sid });
  assert.equal(r.ok, true);
  assert.equal(r.result.messages[0].content, `${sid}-0`, '平手时必须还是 AgentDB');
});

test('只有 JSON 时能读出来, 标 degraded', async () => {
  const sid = 'two-src-json-only';
  await saveDiverged(sid, 9_000, 1_000, 3);
  // 把 AgentDB 指到一个**空的**库目录 —— getAgentDb() 发现 root 变了会重建实例,
  // 于是这条 session 在 DB 侧就不存在了。用现成的 root 切换缝, 不往生产代码里加测试钩子。
  const orig = process.env.PANGU_AGENTDB_DIR;
  process.env.PANGU_AGENTDB_DIR = path.join(_dataDir, 'agentdb-empty');
  try {
    const r = await store.sessionLoad({ session_id: sid });
    assert.equal(r.ok, true, '只有 JSON 也必须读得到');
    assert.equal(r.degraded, true);
  } finally {
    process.env.PANGU_AGENTDB_DIR = orig;
  }
});

test('切走的 DB 侧不能影响下一次读 (root 切换必须真的重建)', async () => {
  const sid = 'two-src-root-flip';
  await saveDiverged(sid, 9_000, 1_000, 3);

  const orig = process.env.PANGU_AGENTDB_DIR;
  process.env.PANGU_AGENTDB_DIR = path.join(_dataDir, 'agentdb-empty-2');
  let viaEmpty;
  try {
    viaEmpty = await store.sessionLoad({ session_id: sid });
  } finally {
    process.env.PANGU_AGENTDB_DIR = orig;
  }
  assert.equal(viaEmpty.degraded, true, '空库侧时该走 JSON');

  // 切回来必须重新读到 AgentDB 那一版 —— 证明前一次没把实例留在空库上
  const back = await store.sessionLoad({ session_id: sid });
  assert.equal(back.result.messages[0].content, `${sid}-0`,
    'root 切回来后必须重新拿到 AgentDB 那一版');
});

test('只有 AgentDB 时能读出来, 且不能被标 degraded', async () => {
  const sid = 'two-src-db-only';
  await saveDiverged(sid, 9_000, 1_000, 3);
  fs.unlinkSync(jsonPath(sid));

  const r = await store.sessionLoad({ session_id: sid });
  assert.equal(r.ok, true, '只有 AgentDB 也必须读得到');
  assert.ok(!r.degraded, '正常路径不该被标 degraded');
});

test('两边都没有: 报 SESSION_NOT_FOUND, 不许返回半截数据', async () => {
  const r = await store.sessionLoad({ session_id: 'two-src-does-not-exist' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'SESSION_NOT_FOUND');
});

test('AgentDB 读取抛错时, JSON 兜底必须真的兜住 (那个 fallback 原来是只写不读)', async () => {
  const sid = 'two-src-db-throws';
  await saveDiverged(sid, 9_000, 1_000, 5);

  // 把 root 指到一条根本建不出来的路径 (/dev/null 底下), 让 new AgentDatabase 直接抛。
  // 比 monkey-patch 私有实例更接近真实故障 (磁盘满 / 权限没了 / 库损坏), 且不用改生产代码。
  const orig = process.env.PANGU_AGENTDB_DIR;
  process.env.PANGU_AGENTDB_DIR = '/dev/null/agentdb-cannot-exist';
  try {
    const r = await store.sessionLoad({ session_id: sid });
    assert.equal(r.ok, true, 'AgentDB 抛错不能连带把 JSON 一起判死');
    assert.equal(r.result.messages.length, 5);
  } finally {
    process.env.PANGU_AGENTDB_DIR = orig;
  }
});

test('副作用: 本测试不许碰生产 AgentDB', () => {
  assert.ok(
    process.env.PANGU_AGENTDB_DIR.includes('pangu-two-src-'),
    'AgentDB 目录必须是临时目录',
  );
  assert.ok(
    process.env.PANGU_SESSIONS_DIR.includes('pangu-two-src-'),
    'SESSIONS 目录必须是临时目录',
  );
});

