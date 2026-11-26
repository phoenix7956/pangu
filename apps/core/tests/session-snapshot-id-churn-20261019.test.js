'use strict';

// 2026-10-19: 盘古 100% CPU、HTTP 根路径 15s 超时。
// 索引那侧改成增量之后, 线上实测**仍然**每保存一次就全量重建 3.7 秒 ——
// 说明增量那条路每一条判据都被判成了「不满足」。顺着查上去, 真凶在上游:
//
//   upsertMessages 第一行是 `DELETE FROM memories WHERE session_id = ?`
//   然后整段重插。
//
// 于是每保存一次, 这个会话里**每一条**记忆都拿到全新 rowid —— 内容一个字没变,
// id 变了。id 一变, 向量索引里的 id 全部对不上, 只能全量重建。
//
// 实测(线上 agentdb.sqlite):
//   同样 4 条消息连存两次 → id 363853-363856 变成 363857-363860
//   全库 max(id) 363860, 实际行数 17050 → **34 万行已经被反复销毁重建过**
//
// message_key 本来就是 (session_id, message_key) 唯一键, ON CONFLICT 也一直在用它。
// 原地 upsert 才是这张表本来的设计。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULES_DIR = path.join(__dirname, '..', 'modules');

function freshRequire(relativePath) {
  const fullPath = path.join(MODULES_DIR, relativePath);
  delete require.cache[require.resolve(fullPath)];
  return require(fullPath);
}

// 和 agentdb.test.js 同一套: 确定性嵌入, 让"向量变没变"可判。
function deterministicEmbed(text) {
 const normalized = String(text || '').replace(/案子/g, '案件').replace(/诉讼/g, '案件');
  const vector = [0, 0, 0, 0];
  for (const ch of normalized) vector[ch.codePointAt(0) % vector.length] += 1;
  const norm = Math.hypot(...vector) || 1;
  return { vector: vector.map(v => v / norm), model: 'det-embed' };
}

function isolatedStore(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-idchurn-'));
  process.env.PANGU_AGENTDB_DIR = path.join(dataDir, 'agentdb');
  process.env.PANGU_SESSIONS_DIR = path.join(dataDir, 'sessions');
  const store = freshRequire('session_store.js');
  t.after(() => {
    store.closeAgentDB?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return store;
}

function memoryIds(db, sessionId) {
  return db.db.prepare('SELECT id FROM memories WHERE session_id = ? ORDER BY id').all(sessionId).map(r => r.id);
}

function memoryVectors(db, sessionId) {
  const { bufferToVector } = require(path.join(MODULES_DIR, 'agentdb', 'db.js'));
  return db.db.prepare(
    'SELECT message_key, embedding FROM memories WHERE session_id = ? ORDER BY message_key',
  ).all(sessionId).map(r => ({ key: r.message_key, vector: bufferToVector(r.embedding) }));
}

test('内容一个字没改、重复保存 → id 和向量都不变', async (t) => {
  const store = isolatedStore(t);
  const messages = [
    { role: 'user', content: '原告案件分析' },
    { role: 'assistant', content: '先整理证据目录并核对时效。' },
    { role: 'user', content: '那我下一步做什么' },
  ];

  await store.sessionSave({ session_id: 'churn_1', messages, embed: deterministicEmbed });
  const db = store.getAgentDb();
  const idsFirst = memoryIds(db, 'churn_1');
  const vectorsFirst = memoryVectors(db, 'churn_1');

  // 一模一样再存三次
  for (let i = 0; i < 3; i += 1) {
    await store.sessionSave({ session_id: 'churn_1', messages, embed: deterministicEmbed });
  }

  assert.deepEqual(memoryIds(db, 'churn_1'), idsFirst,
    '重复保存把每条记忆的 rowid 都换了 —— 向量索引必然全量重建');
  assert.deepEqual(memoryVectors(db, 'churn_1'), vectorsFirst, '向量也不该变');
});

test('会话变短(压缩) → 只清掉新快照里没有的那些, 留下的 id 不动', async (t) => {
  const store = isolatedStore(t);
  const long = [
    { role: 'user', content: '一' },
    { role: 'assistant', content: '二' },
    { role: 'user', content: '三' },
    { role: 'assistant', content: '四' },
  ];
  await store.sessionSave({ session_id: 'churn_2', messages: long, embed: deterministicEmbed });
  const db = store.getAgentDb();
  const idsLong = memoryIds(db, 'churn_2');
  assert.equal(idsLong.length, 4);

  await store.sessionSave({ session_id: 'churn_2', messages: long.slice(0, 2), embed: deterministicEmbed });

  const after = db.db.prepare(
    'SELECT message_key FROM memories WHERE session_id = ? ORDER BY message_key',
  ).all('churn_2').map(r => r.message_key);
  assert.deepEqual(after, ['0', '1'], '压缩后应只剩前两条, 高位 message_key 要清掉');
  assert.deepEqual(memoryIds(db, 'churn_2'), idsLong.slice(0, 2),
    '留下来的两条 id 不该因为压缩而变 —— 否则每次压缩都全量重建一次');
});

test('压缩到 10 条以下也必须清干净(message_key 是 TEXT, 不能按大小比)', async (t) => {
  // 隔离「怎么判断新快照里没有的 message_key」。
  //
  // message_key 存的是 TEXT, 所以 `message_key >= '4'` 这种写法在消息超过
  // 10 条时会漏删: 字符串比较下 '10' < '4', 于是第 10、11 条永远清不掉,
  // 压缩后的会话里留着本该消失的旧消息 —— 而且不会报任何错。
  //
  // 上面那条压缩测试只有 4 条消息, 单数字符串比较恰好是对的, 抓不到这个。
  const store = isolatedStore(t);
  const long = [];
  for (let i = 0; i < 14; i += 1) {
    long.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `第 ${i} 条` });
  }
  await store.sessionSave({ session_id: 'churn_2b', messages: long, embed: deterministicEmbed });
  const db = store.getAgentDb();
  const idsLong = memoryIds(db, 'churn_2b');
  assert.equal(idsLong.length, 14);

  await store.sessionSave({ session_id: 'churn_2b', messages: long.slice(0, 3), embed: deterministicEmbed });

  const keys = db.db.prepare(
    'SELECT message_key FROM memories WHERE session_id = ? ORDER BY CAST(message_key AS INTEGER)',
  ).all('churn_2b').map(r => r.message_key);
  assert.deepEqual(keys, ['0', '1', '2'],
    `压缩后应只剩 0/1/2, 实际留下 ${JSON.stringify(keys)} —— 有高位 message_key 没清掉`);
  assert.deepEqual(memoryIds(db, 'churn_2b'), idsLong.slice(0, 3), '留下的三条 id 不该变');
});

test('某条消息内容改了 → 原地更新, id 不变, 向量跟着变', async (t) => {
  const store = isolatedStore(t);
  const before = [
    { role: 'user', content: '原告案件分析' },
    { role: 'assistant', content: '先整理证据目录。' },
  ];
  await store.sessionSave({ session_id: 'churn_3', messages: before, embed: deterministicEmbed });
  const db = store.getAgentDb();
  const idsBefore = memoryIds(db, 'churn_3');
  const vectorsBefore = memoryVectors(db, 'churn_3');

  const after = [before[0], { role: 'assistant', content: '先整理证据目录并核对诉讼时效。' }];
  await store.sessionSave({ session_id: 'churn_3', messages: after, embed: deterministicEmbed });

  assert.deepEqual(memoryIds(db, 'churn_3'), idsBefore, '改内容也不该换 id');
  const vectorsAfter = memoryVectors(db, 'churn_3');
  assert.deepEqual(vectorsAfter[0].vector, vectorsBefore[0].vector, '没动的那条向量不该变');
  assert.notDeepEqual(vectorsAfter[1].vector, vectorsBefore[1].vector, '改了内容向量必须跟着更新');
});

test('反复 sessionSave 之后, 同步不再全量重建', async (t) => {
  // 这条是整条链的收口: 前三条锁的是"id 别再乱跳", 这条锁的是
  // "id 不跳了以后, 索引那条路真的走成了增量"。
  //
  // 场景必须是**纯追加** —— 用户每发一条消息就是这个形状, 也是 J2 每轮
  // 保存的真实形状。中间那几条旧消息一个字节都不动。
  if (!require('hnswlib-node')) return t.skip('hnswlib-node 不可用');
  const store = isolatedStore(t);
  const index = store.getAgentIndex();

  const history = [
    { role: 'user', content: '原告案件分析' },
    { role: 'assistant', content: '先整理证据目录。' },
  ];
  await store.sessionSave({ session_id: 'churn_4', messages: history, embed: deterministicEmbed });

  // 从这里开始数全量重建了几次
  let rebuilds = 0;
  const original = index._rebuild.bind(index);
  Object.defineProperty(index, '_rebuild', {
    value: (...args) => { rebuilds += 1; return original(...args); },
    writable: true,
    configurable: true,
  });
  t.after(() => { delete index._rebuild; });

  for (let round = 0; round < 3; round += 1) {
    history.push({ role: 'user', content: `第 ${round} 轮追问` });
    history.push({ role: 'assistant', content: `第 ${round} 轮答复` });
    await store.sessionSave({ session_id: 'churn_4', messages: history.slice(), embed: deterministicEmbed });
  }

  assert.equal(rebuilds, 0, `三轮保存重建了 ${rebuilds} 次 —— 增量路径还是没走通`);
});

test('改写已有历史 → 必须全量重建(向量真变了, 复用就是错的)', async (t) => {
  // 上一条的姊妹条, 故意写反的方向。
  //
  // 有人可能会想"能不能也走增量"。不能: 旧消息内容一改, 向量就变了,
  // 索引里存的是**旧向量**, 不重建的话检索会一直命中改写前的内容, 而且
  // 一声不响。这里锁死"宁可慢一次也不错", 别为了性能把它改成增量。
  if (!require('hnswlib-node')) return t.skip('hnswlib-node 不可用');
  const store = isolatedStore(t);
  const index = store.getAgentIndex();
  const history = [
    { role: 'user', content: '原告案件分析' },
    { role: 'assistant', content: '先整理证据目录。' },
  ];
  await store.sessionSave({ session_id: 'churn_5', messages: history, embed: deterministicEmbed });

  let rebuilds = 0;
  const original = index._rebuild.bind(index);
  Object.defineProperty(index, '_rebuild', {
    value: (...args) => { rebuilds += 1; return original(...args); },
    writable: true,
    configurable: true,
  });
  t.after(() => { delete index._rebuild; });

  history[1] = { role: 'assistant', content: '先整理证据目录并核对诉讼时效。' };
  await store.sessionSave({ session_id: 'churn_5', messages: history.slice(), embed: deterministicEmbed });

  assert.equal(rebuilds, 1, '改写历史后向量真的变了, 必须重建一次(不许增量蒙混过关)');
});

test('索引同步用的瘦行 = 胖行的 id + 向量, 换过去没丢东西', async (t) => {
  const store = isolatedStore(t);
  await store.sessionSave({
    session_id: 'churn_6',
    messages: [
      { role: 'user', content: '原告案件分析' },
      { role: 'assistant', content: '先整理证据目录。' },
      { role: 'user', content: '' },
      { role: 'assistant', content: '第三句没有内容, 不该有向量' },
    ],
    embed: deterministicEmbed,
  });
  const db = store.getAgentDb();

  const fat = db.listEmbeddedMemories().map(r => ({ id: r.id, vector: r.vector }));
  const lean = db.listEmbeddedVectors().map(r => ({ id: r.id, vector: r.vector }));

  assert.deepEqual(lean, fat, '瘦行必须和胖行给出同一批 id + 向量, 否则索引会漏东西');
  assert.ok(lean.length > 0);
});

test('索引同步不许把 content / metadata 拖回来(性能契约, 用静态断言)', async (t) => {
  // 这条故意是静态断言。
  //
  // 理由: 这里要锁的是「SQL 有没有多查两列」, 那是查询形状, 不是行为。
  // 换成计时断言的话, 慢机器上会假绿, 快的机器上又会因为抖动假红。
  //
  // 为什么值得锁: 这段每轮 J2 保存都跑一遍, 实测胖查询 287ms vs 瘦查询 95ms
  // (17052 行)。content 和 metadata 在这条路径上从头到尾没人读过,
  // 谁哪天"顺手"换回 listEmbeddedMemories, 就会悄悄把 190ms 加回去。
  const dbSource = fs.readFileSync(path.join(MODULES_DIR, 'agentdb', 'db.js'), 'utf8');
  const storeSource = fs.readFileSync(path.join(MODULES_DIR, 'session_store.js'), 'utf8');

  const leanStart = dbSource.indexOf('listEmbeddedVectors(limit');
  const leanEnd = dbSource.indexOf('getMemoriesByIds(', leanStart);
  const leanSql = dbSource.slice(leanStart, leanEnd);
  assert.ok(leanStart > 0 && leanEnd > leanStart, '找不到 listEmbeddedVectors 的 SQL 段');
  assert.ok(!/\bselect\b[\s\S]*\bcontent\b/i.test(leanSql),
    'listEmbeddedVectors 又把 content 查出来了 —— 每轮白花 ~190ms');
  assert.ok(!/\bselect\b[\s\S]*\bmetadata\b/i.test(leanSql),
    'listEmbeddedVectors 又把 metadata 查出来了 —— 每轮白花 ~190ms');

  // 两个调用点(syncIndex 和 sessionRecall)都得走瘦的
  assert.ok(!/listEmbeddedMemories\(\)/.test(storeSource),
    'session_store 还有地方在用胖查询 listEmbeddedMemories()');
  assert.ok(storeSource.includes('db.listEmbeddedVectors()'), 'syncIndex 没用瘦查询');
});


