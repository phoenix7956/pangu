'use strict';

// 2026-10-19: 盘古进程 100% CPU 把事件循环饿死, 整个 HTTP 服务对外全挂
// (根路径 15s 超时, 页面都加载不出来)。现场: sample 1408 个采样里 802 个
// 堆在 HierarchicalNSW::addPoint。
//
// 根因链:
//   session_store.persistToAgentDb → db.listEmbeddedMemories() → index.sync(rows, fingerprint)
//   → _loadPersisted 要求 state.fingerprint === fingerprint,
//     而 fingerprint 覆盖全部 (id + 向量) —— **多加一条消息指纹必变**
//   → 落盘索引作废 → _rebuild 把 17046 条全量重插。
// 日志窗口内 persist 325 次, 每次 3.3 秒量级的 CPU 独占。
//
// 量化 (tools/bench-agentdb-index.mjs + node 实测, 17046 条 × 1024 维):
//   全量重插    3348 ms   ← 事件循环被吃光的地方
//   writeIndexSync   6 ms ← 落盘其实不贵, 所以"每次都落盘"完全舍得
//   补插一条      4 ms
// 所以修法是"只补插新增的 id", 而不是"少落盘"。
//
// 关键约束: 少插几条 ≠ 索引还对。所以下面**以检索结果等价为主判据**,
// 补插条数只是辅助证据。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULES_DIR = path.join(__dirname, '..', 'modules', 'agentdb');
const { AgentDBIndex } = require(path.join(MODULES_DIR, 'index.js'));
const { rowsFingerprint, sortRowsById } = require(path.join(MODULES_DIR, 'fingerprint.js'));
const { AgentDatabase } = require(path.join(MODULES_DIR, 'db.js'));

const DIM = 24;

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-hnsw-incr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 造一批"像嵌入"的向量: 低维 + 有相关性。
// 刻意不用纯随机 —— 随机向量彼此正交, 检索结果退化到全并列, 等价性断言会失真。
function makeRows(count, seed = 1) {
  const rows = [];
  for (let i = 1; i <= count; i += 1) {
    const vector = [];
    for (let d = 0; d < DIM; d += 1) {
      vector.push(Math.sin((i * 7 + d * 13 + seed) * 0.017) + 0.15 * Math.cos(i * 0.31 + d));
    }
    const norm = Math.hypot(...vector) || 1;
    rows.push({ id: i, vector: vector.map(v => v / norm) });
  }
  return rows;
}

const hnswReady = Boolean(require('hnswlib-node'));

// spy: 数清这一次 sync 到底往索引里插了几条。
// 用条数而不是耗时当证据 —— 耗时会随机器抖, 条数不会。
//
// 注意不能直接 `index.index.addPoint = fn`: hnswlib-node 的实例和 prototype
// 都是只读的, 赋值会抛 "Cannot assign to read only property"。
// defineProperty 绕开 [[Set]] 走 [[DefineOwnProperty]], 是唯一能挂上去的口子。
function spyAddPoint(index) {
  const counts = { calls: 0 };
  const original = index.index.addPoint.bind(index.index);
  Object.defineProperty(index.index, 'addPoint', {
    value: (vector, label) => {
      counts.calls += 1;
      return original(vector, label);
    },
    writable: true,
    configurable: true,
  });
  return counts;
}

function topIds(index, vector, k) {
  const hit = index.search(vector, k);
  return hit ? hit.neighbors.slice().sort((a, b) => a - b) : [];
}

test('索引账本: 落盘 state 必须带 indexedIds / indexedFingerprint / maxElements 三件套', async (t) => {
  if (!hnswReady) return t.skip('hnswlib-node 不可用');
  const root = tempRoot(t);
  const index = new AgentDBIndex({ root });
  const rows = makeRows(40);
  index.sync(rows, rowsFingerprint(rows));

  const state = JSON.parse(fs.readFileSync(path.join(root, 'agentdb.hnsw.json'), 'utf8'));
  assert.ok(Array.isArray(state.indexedIds), '没有 indexedIds → 下次 sync 无法知道哪些点已在索引里');
  assert.equal(typeof state.indexedFingerprint, 'string', '没有 indexedFingerprint → 无法证明向量没变过');
  assert.ok(state.maxElements > 0, '没有 maxElements → 补插前没法判容量');
  assert.deepEqual(state.indexedIds, rows.map(r => r.id), '账本里的 id 必须和实际入库的完全一致');
});

test('新增一条消息 → 只补插那一条, 不重插已有的', async (t) => {
  if (!hnswReady) return t.skip('hnswlib-node 不可用');
  const root = tempRoot(t);
  const index = new AgentDBIndex({ root });
  const base = makeRows(60);
  index.sync(base, rowsFingerprint(base));

  const spy = spyAddPoint(index);
  const grown = [...base, { id: 61, vector: makeRows(1, 9)[0].vector }];
  const result = index.sync(grown, rowsFingerprint(grown));

  assert.equal(result.appended, 1, '应该只补 1 条');
  assert.equal(spy.calls, 1, `实际插了 ${spy.calls} 条 —— 全量重插就是这里没生效`);
  assert.equal(result.count, 61);
  assert.equal(result.rebuilt, undefined, '不该走全量重建');
});

test('增量后的检索结果必须和全量重建逐条一致(主判据)', async (t) => {
  if (!hnswReady) return t.skip('hnswlib-node 不可用');
  const incrementalRoot = tempRoot(t);
  const rebuiltRoot = tempRoot(t);

  const base = makeRows(120);
  const grown = [...base, ...makeRows(7, 3).map(row => ({ ...row, id: row.id + 120 }))];
  const queries = makeRows(5, 77).map(row => row.vector);

  const incremental = new AgentDBIndex({ root: incrementalRoot });
  incremental.sync(base, rowsFingerprint(base));
  incremental.sync(grown, rowsFingerprint(grown)); // 增量这条路

  const rebuilt = new AgentDBIndex({ root: rebuiltRoot });
  rebuilt.sync(grown, rowsFingerprint(grown)); // 一次性全量这条路

  assert.equal(incremental.count, rebuilt.count);
  for (const [i, vector] of queries.entries()) {
    assert.deepEqual(
      topIds(incremental, vector, 8),
      topIds(rebuilt, vector, 8),
      `第 ${i} 个查询的 top8 不一致 —— 增量索引和全量索引已经不是同一个东西`,
    );
  }
});

test('冷启动(新进程)后第一次 sync 也走增量, 不退回全量', async (t) => {
  if (!hnswReady) return t.skip('hnswlib-node 不可用');
  const root = tempRoot(t);
  const base = makeRows(80);
  const first = new AgentDBIndex({ root });
  first.sync(base, rowsFingerprint(base));

  // 换一个实例 = 内存索引没了, 只能靠落盘的账本
  const revived = new AgentDBIndex({ root });
  const grown = [...base, ...makeRows(2, 5).map(row => ({ ...row, id: row.id + 80 }))];
  const result = revived.sync(grown, rowsFingerprint(grown));

  assert.equal(result.appended, 2, '冷启动后应该只补插新增的 2 条');
  assert.equal(result.rebuilt, undefined, '冷启动后退回全量 = 落盘账本没起作用');
  assert.equal(result.count, 82);
});

test('冷启动确实读了落盘索引 —— 把索引文件写坏就必须退回全量', async (t) => {
  // 上一条只证明「结果是增量的」。这条反向锁死「它真的去读盘了」:
  // 落盘索引坏掉时, 增量那条路必然读不出来, 只能全量重建。
  // 如果这条还能增量, 说明它根本没读盘 —— 账本就是摆设。
  if (!hnswReady) return t.skip('hnswlib-node 不可用');
  const root = tempRoot(t);
  const base = makeRows(60);
  const first = new AgentDBIndex({ root });
  first.sync(base, rowsFingerprint(base));

  fs.writeFileSync(path.join(root, 'agentdb.hnsw'), Buffer.from('not a real hnsw file'));

  const revived = new AgentDBIndex({ root });
  const grown = [...base, { id: 61, vector: makeRows(1, 7)[0].vector }];
  const result = revived.sync(grown, rowsFingerprint(grown));

  assert.ok(result.rebuilt, '索引文件都坏了还能增量 = 压根没读盘, 账本是摆设');
  assert.equal(result.count, 61);
  // 重建完落盘恢复, 再来一条又要能增量
  const next = [...grown, { id: 62, vector: makeRows(1, 13)[0].vector }];
  const again = new AgentDBIndex({ root });
  const after = again.sync(next, rowsFingerprint(next));
  assert.equal(after.appended, 1, '重建之后账本要恢复成可增量');
});

test('已索引的向量被重新嵌入过 → 必须全量重建, 不许拿脏索引接着补', async (t) => {
  if (!hnswReady) return t.skip('hnswlib-node 不可用');
  const root = tempRoot(t);
  const index = new AgentDBIndex({ root });
  const base = makeRows(50);
  index.sync(base, rowsFingerprint(base));

  // id=5 那条被换了向量(比如 embedding 模型升级后重嵌入), 其余不变
  const tampered = base.map(row => (row.id === 5 ? { ...row, vector: makeRows(1, 42)[0].vector } : row));
  const grown = [...tampered, { id: 51, vector: makeRows(1, 8)[0].vector }];
  const result = index.sync(grown, rowsFingerprint(grown));

  assert.ok(result.rebuilt, '向量变了还接着增量 = 索引里留着旧向量, 检索结果会错');
  assert.equal(result.count, 51);
  // 全量重建后账本必须是新的, 下一轮又要能增量
  const next = [...grown, { id: 52, vector: makeRows(1, 11)[0].vector }];
  const after = index.sync(next, rowsFingerprint(next));
  assert.equal(after.appended, 1, '重建之后账本没更新, 增量能力丢了');
});

test('索引里有、库里没了(删除) → 必须全量重建', async (t) => {
  // 说明: 这条目前被「指纹校验」顺带兜住了(少一个 id, 子集指纹必变)。
  // 它锁的是**行为**(删除后不许留幽灵点), 不是单独锁某一行判据。
  if (!hnswReady) return t.skip('hnswlib-node 不可用');
  const root = tempRoot(t);
  const index = new AgentDBIndex({ root });
  const base = makeRows(50);
  index.sync(base, rowsFingerprint(base));

  const shrunk = base.filter(row => row.id !== 7).concat({ id: 51, vector: makeRows(1, 4)[0].vector });
  const result = index.sync(shrunk, rowsFingerprint(shrunk));

  assert.ok(result.rebuilt, 'hnsw 不能原地删点, 不重建就留着幽灵点');
  assert.equal(result.count, 50);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'agentdb.hnsw.json'), 'utf8'));
  assert.ok(!state.indexedIds.includes(7), '幽灵 id 还留在账本里');
});

test('账本被截短 → 不许补插, 退回全量', async (t) => {
  // 同上, 这条也被指纹校验顺带兜住。锁行为, 不是单独锁判据。
  if (!hnswReady) return t.skip('hnswlib-node 不可用');
  const root = tempRoot(t);
  const index = new AgentDBIndex({ root });
  const base = makeRows(40);
  index.sync(base, rowsFingerprint(base));

  // 模拟落盘被截断 / 索引文件被换过: 账本少记了一个 id
  const statePath = path.join(root, 'agentdb.hnsw.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.indexedIds = state.indexedIds.slice(0, -1);
  fs.writeFileSync(statePath, JSON.stringify(state));

  const revived = new AgentDBIndex({ root });
  const grown = [...base, { id: 41, vector: makeRows(1, 6)[0].vector }];
  const result = revived.sync(grown, rowsFingerprint(grown));

  assert.ok(result.rebuilt, '账本和索引条数不一致还补插 = 会插出重复/幽灵点');
  assert.equal(result.count, 41);
});

test('索引文件被换成点数更少的另一个索引 → 必须全量重建(这条只有条数校验能拦)', async (t) => {
  // 隔离「索引实际条数 vs 账本条数」这条判据。
  //
  // 上面两条都被指纹校验顺带挡住了, 这条挡不住: 账本的 ids 和指纹**全都自洽**
  // (还是那 40 条), 只有索引文件本身少了 10 个点 —— 比如上次写盘被截断,
  // 或者有人拿别的索引文件换了个名。
  //
  // 这时如果只信账本: shared(1..40) 指纹对得上 → 只补插第 41 条 →
  // 索引里实际只有 {1..30, 41}, **31..40 这 10 条记忆从此检索不到, 一声不响**。
  // 这正是「grep 匹配到 ≠ 证据」同款: 账本说全在, 索引说少十个, 谁都没报错。
  if (!hnswReady) return t.skip('hnswlib-node 不可用');
  const root = tempRoot(t);
  const index = new AgentDBIndex({ root });
  const base = makeRows(40);
  index.sync(base, rowsFingerprint(base));

  // state 保持不动(自洽), 只把索引文件换成只装了前 30 条的另一个索引
  const truncated = new AgentDBIndex({ root: tempRoot(t) });
  truncated.sync(base.slice(0, 30), 'ignored-fingerprint');
  fs.copyFileSync(
    path.join(truncated.root, 'agentdb.hnsw'),
    path.join(root, 'agentdb.hnsw'),
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'agentdb.hnsw.json'), 'utf8')).count, 40,
    '账本必须仍然是自洽的 40 条, 这条测试才成立');

  const revived = new AgentDBIndex({ root });
  const grown = [...base, { id: 41, vector: makeRows(1, 23)[0].vector }];
  const result = revived.sync(grown, rowsFingerprint(grown));

  assert.ok(result.rebuilt, '索引点数和账本对不上还补插 = 中间那批记忆永久检索不到');
  assert.equal(result.count, 41);
  // 重建后 31..40 必须真的能检索到, 不能只是 count 对
  const found = topIds(revived, base[34].vector, 3);
  assert.ok(found.includes(35), `重建后 id=35 检索不到, 实际 top3=${JSON.stringify(found)}`);
});

test('容量装不下 → 退回全量重建(而不是等 addPoint 抛异常)', async (t) => {
  if (!hnswReady) return t.skip('hnswlib-node 不可用');
  const root = tempRoot(t);
  const index = new AgentDBIndex({ root });
  const base = makeRows(30);
  index.sync(base, rowsFingerprint(base));

  const statePath = path.join(root, 'agentdb.hnsw.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.maxElements = base.length; // 只剩 0 空位, 但下面要补 1 条
  fs.writeFileSync(statePath, JSON.stringify(state));

  const revived = new AgentDBIndex({ root });
  const grown = [...base, { id: 31, vector: makeRows(1, 2)[0].vector }];
  const result = revived.sync(grown, rowsFingerprint(grown));

  assert.ok(result.rebuilt, '容量不够还硬补 = addPoint 会抛, 整条 sync 挂掉');
  assert.equal(result.count, 31);
});

test('旧的 state 文件(没有账本三件套)仍能按精确指纹复用, 不炸不重建', async (t) => {
  if (!hnswReady) return t.skip('hnswlib-node 不可用');
  const root = tempRoot(t);
  const index = new AgentDBIndex({ root });
  const rows = makeRows(35);
  const fingerprint = rowsFingerprint(rows);
  index.sync(rows, fingerprint);

  // 退回到 10 月 19 日之前的老 state 格式
  fs.writeFileSync(path.join(root, 'agentdb.hnsw.json'), JSON.stringify({
    dimension: DIM,
    fingerprint,
    count: rows.length,
  }));

  const revived = new AgentDBIndex({ root });
  const result = revived.sync(rows, fingerprint);
  assert.equal(result.reused, true, '老 state 也该直接复用');
  assert.equal(result.rebuilt, undefined);
});

test('外部 addPoint(backfill 那条路)之后指纹失效 → 下次 sync 全量重建', async (t) => {
  if (!hnswReady) return t.skip('hnswlib-node 不可用');
  const root = tempRoot(t);
  const index = new AgentDBIndex({ root });
  const base = makeRows(45);
  index.sync(base, rowsFingerprint(base));

  // backfill.js 就是这么用的: 直接往活着的索引里塞点, 然后 save()
  const extra = makeRows(1, 21)[0];
  assert.equal(index.addPoint(extra.vector, 9999), true);
  assert.equal(index.save().ok, true);

  // 聚合指纹没法靠单个向量增量更新, 必须承认不可信
  const state = JSON.parse(fs.readFileSync(path.join(root, 'agentdb.hnsw.json'), 'utf8'));
  assert.equal(state.indexedFingerprint, null, '不可信却写了个看起来可信的指纹 = 下次会拿脏索引当对的用');

  const rows = [...base, { id: 9999, vector: extra.vector }, { id: 46, vector: makeRows(1, 33)[0].vector }];
  const result = index.sync(rows, rowsFingerprint(rows));
  assert.ok(result.rebuilt, 'backfill 之后必须重建一次');
  assert.equal(result.count, 47);
});

test('指纹算法与 db.fingerprint 逐字一致(两边共用一份, 不许各写各的)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-fp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new AgentDatabase({ root: dir });
  const rows = makeRows(12);
  assert.equal(
    db.fingerprint(rows),
    rowsFingerprint(rows),
    '两边算法不一致 → 增量验证永远判「向量变了」→ 白写增量, 而且日志一声不响',
  );
  assert.deepEqual(sortRowsById(rows).map(r => r.id), rows.map(r => r.id));
  db.close();
});

test('空库 / 无向量 → 不建索引, 状态清干净', async (t) => {
  if (!hnswReady) return t.skip('hnswlib-node 不可用');
  const root = tempRoot(t);
  const index = new AgentDBIndex({ root });
  index.sync(makeRows(10), 'x');
  const emptied = index.sync([], null);
  assert.equal(emptied.count, 0);
  assert.equal(index.index, null);
  assert.equal(index.indexedIds, null);
  assert.equal(index.indexedFingerprint, null);
});
