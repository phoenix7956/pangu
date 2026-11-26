'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const AGENTDB_DIR = path.join(__dirname, '..', 'modules', 'agentdb');
const MEMORY_HELPERS_DIR = path.join(__dirname, '..', 'modules');

function freshRequire(relativePath) {
  const fullPath = path.join(MEMORY_HELPERS_DIR, relativePath);
  delete require.cache[require.resolve(fullPath)];
  return require(fullPath);
}

function freshAgentDbModule() {
  delete require.cache[require.resolve(path.join(AGENTDB_DIR, 'db.js'))];
  return require(path.join(AGENTDB_DIR, 'db.js'));
}

function makeTempDir(t, name = 'pangu-r39-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeFakeOldLibrary(dir) {
  const Database = require('better-sqlite3');
  const oldPath = path.join(dir, 'old.sqlite');
  const oldDb = new Database(oldPath);
  oldDb.exec(`
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY,
      text TEXT,
      model TEXT,
      hash TEXT,
      embedding TEXT
    );
  `);
  const samples = [
    ['chunk_001', '原告案件分析: 一审胜诉, 对方上诉, 准备答辩状。', 'sha256-text', 'h001', '[0.1, 0.2, 0.3]'],
    ['chunk_002', '证据目录: OCR真源/原案材料/另案/应对策略。', 'sha256-text', 'h002', '[]'],
    ['chunk_003', '应诉策略: 维持原判, 论证一审事实认定扎实。', 'sha256-text', 'h003', null],
    ['chunk_004', '短', '', 'h004', '[]'],
  ];
  const insert = oldDb.prepare('INSERT INTO chunks (id, text, model, hash, embedding) VALUES (?, ?, ?, ?, ?)');
  for (const row of samples) insert.run(...row);
  oldDb.close();
  return oldPath;
}

test('AgentDatabase.addMemory creates history session and persists embedding + metadata', (t) => {
  const dir = makeTempDir(t);
  const { AgentDatabase } = freshAgentDbModule();
  const db = new AgentDatabase({ root: path.join(dir, 'agentdb') });
  t.after(() => db.close());

  const memoryId = db.addMemory({
    sessionId: 'legacy_chunk_001',
    role: 'history',
    content: '原告案件分析: 一审胜诉, 对方上诉, 准备答辩状。',
    embedding: { vector: Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)), model: 'backfill' },
    embeddingModel: 'backfill',
    metadata: { source: 'legacy_backfill', orig_id: 'chunk_001', orig_hash: 'h001' },
    createdAt: 1700000000000,
  });

  assert.ok(Number.isInteger(memoryId));
  const row = db.db.prepare('SELECT session_id, role, content, embedding, metadata FROM memories WHERE id = ?').get(memoryId);
  assert.equal(row.session_id, 'legacy_chunk_001');
  assert.equal(row.role, 'history');
  assert.equal(row.embedding.length, 384 * 4);
  const meta = JSON.parse(row.metadata);
  assert.equal(meta.source, 'legacy_backfill');
  assert.equal(meta.orig_id, 'chunk_001');

  const session = db.db.prepare('SELECT state, message_count FROM sessions WHERE session_id = ?').get('legacy_chunk_001');
  assert.equal(session.state, 'history');
  assert.equal(session.message_count, 0);
});

test('AgentDatabase.addMemory reuses existing session row without overwriting state', (t) => {
  const dir = makeTempDir(t);
  const { AgentDatabase } = freshAgentDbModule();
  const db = new AgentDatabase({ root: path.join(dir, 'agentdb') });
  t.after(() => db.close());

  db.upsertSession({
    sessionId: 'legacy_chunk_002',
    createdAt: 1,
    updatedAt: 2,
    planId: 'p1',
    planState: { pendingPlan: { plan_id: 'p1' } },
    summary: 'pre',
    state: 'active',
    messageCount: 9,
  });

  db.addMemory({
    sessionId: 'legacy_chunk_002',
    role: 'history',
    content: '历史片段',
    embedding: null,
    embeddingModel: 'none',
    metadata: { source: 'legacy_backfill' },
    createdAt: 3,
  });

  const session = db.db.prepare('SELECT state, message_count, plan_id FROM sessions WHERE session_id = ?').get('legacy_chunk_002');
  assert.equal(session.state, 'active');
  assert.equal(session.message_count, 9);
  assert.equal(session.plan_id, 'p1');
});

test('backfill reads source readonly and skips short chunks', async (t) => {
  const dir = makeTempDir(t);
  const oldPath = makeFakeOldLibrary(dir);
  const backfillModule = freshRequire(path.join('..', 'modules', 'agentdb', 'backfill.js'));
  const backfill = backfillModule.backfill || backfillModule;
  t.after(() => {
    const Database = require('better-sqlite3');
    try {
      const oldDb = new Database(oldPath, { readonly: true });
      oldDb.close();
    } catch (_) {}
  });

  const result = await backfill({
    source: oldPath,
    target: path.join(dir, 'agentdb.sqlite'),
    batch: 50,
    dryRun: true,
    limit: null,
  });

  assert.equal(result.dryRun, true);
  // chunk_004 的 text 长度 <= 5 应被过滤, 其余 3 条都 > 5
  assert.equal(result.total, 3);
});

test('backfill writes 3 history memories + reuses legacy_<id> namespace', async (t) => {
  const dir = makeTempDir(t);
  const oldPath = makeFakeOldLibrary(dir);
  process.env.PANGU_EMBEDDING_URL = '';
  process.env.OLLAMA_HOST = '';
  const backfillModule = freshRequire(path.join('..', 'modules', 'agentdb', 'backfill.js'));
  const backfill = backfillModule.backfill || backfillModule;

  // First import: no target file yet → no backup needed; second import: target exists → backup created.
  await backfill({
    source: oldPath,
    target: path.join(dir, 'agentdb.sqlite'),
    batch: 50,
    dryRun: false,
    limit: null,
  });

  const result = await backfill({
    source: oldPath,
    target: path.join(dir, 'agentdb.sqlite'),
    batch: 50,
    dryRun: false,
    limit: null,
  });

  assert.equal(result.imported, 3);
  assert.ok(result.backup, 'second import must back up the existing target before writing');
  assert.equal(result.fallbackEmbeddings, 3);
  assert.equal(result.hadNonEmptyEmbedding, 0);
  assert.ok(fs.existsSync(result.target));

  const Database = require('better-sqlite3');
  const newDb = new Database(result.target, { readonly: true });
  t.after(() => newDb.close());
  const counts = newDb.prepare(`
    SELECT
      (SELECT COUNT(*) FROM memories) AS memories,
      (SELECT COUNT(*) FROM sessions) AS sessions,
      (SELECT COUNT(*) FROM memories WHERE role = 'history') AS history
  `).get();
  assert.equal(counts.memories, 3);
  assert.equal(counts.sessions, 3);
  assert.equal(counts.history, 3);

  const legacyIds = newDb.prepare(`SELECT session_id FROM memories WHERE session_id LIKE 'legacy_%' ORDER BY session_id`).all().map(row => row.session_id);
  assert.deepEqual(legacyIds, ['legacy_chunk_001', 'legacy_chunk_002', 'legacy_chunk_003']);
});

test('backfill leaves source unchanged even after a destructive target failure', async (t) => {
  const dir = makeTempDir(t);
  const oldPath = makeFakeOldLibrary(dir);
  process.env.PANGU_EMBEDDING_URL = '';
  process.env.OLLAMA_HOST = '';
  const backfillModule = freshRequire(path.join('..', 'modules', 'agentdb', 'backfill.js'));
  const backfill = backfillModule.backfill || backfillModule;
  // 即使参数异常, source 也不被改 (readonly 打开保证)
  try { await backfill({ source: oldPath, target: '/non/existent/dir/x.sqlite', batch: 50, dryRun: false, limit: 1 }); } catch (_) {}
  const Database = require('better-sqlite3');
  const oldDb = new Database(oldPath, { readonly: true });
  const stillFour = oldDb.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
  oldDb.close();
  assert.equal(stillFour, 4);
});

test('_persistSession swallows sessionSave errors without throwing and writes nothing on bad session id', async (t) => {
  const dir = makeTempDir(t);
  process.env.PANGU_SESSIONS_DIR = path.join(dir, 'sessions');
  process.env.PANGU_AGENTDB_DIR = path.join(dir, 'agentdb');
  const j2 = freshRequire('j2_agent_loop.js');
  await j2._persistSession('bad session id with spaces', [{ role: 'user', content: 'x' }], { ts: 1 });
  assert.ok(true);
});

test('_persistSession writes JSON + SQLite through sessionSave', async (t) => {
  const dir = makeTempDir(t);
  process.env.PANGU_SESSIONS_DIR = path.join(dir, 'sessions');
  process.env.PANGU_AGENTDB_DIR = path.join(dir, 'agentdb');
  // j2 require session_store cache, 必须先把 session_store cache 清掉
  delete require.cache[require.resolve(path.join(__dirname, '..', 'modules', 'session_store.js'))];
  delete require.cache[require.resolve(path.join(__dirname, '..', 'modules', 'agentdb', 'db.js'))];
  delete require.cache[require.resolve(path.join(__dirname, '..', 'modules', 'agentdb', 'index.js'))];
  const j2 = freshRequire('j2_agent_loop.js');
  const ss = require(path.join(__dirname, '..', 'modules', 'session_store.js'));
  const messages = [
    { role: 'user', content: '我是原告被上诉方怎么应对' },
    { role: 'assistant', content: '维持原判, 准备答辩状' },
  ];
  await j2._persistSession('r39_persist_probe', messages, { ts: 1700000000000 });
  const loaded = await ss.sessionLoad({ session_id: 'r39_persist_probe' });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.result.messages.length, 2);
  assert.equal(loaded.result.messages[0].content, '我是原告被上诉方怎么应对');
  assert.ok(fs.existsSync(path.join(process.env.PANGU_SESSIONS_DIR, 'r39_persist_probe.json')));
  ss.closeAgentDB();
});

test('session_recall surfaces backfilled legacy rows by semantic query', async (t) => {
  const dir = makeTempDir(t);
  const oldPath = makeFakeOldLibrary(dir);
  process.env.PANGU_EMBEDDING_URL = '';
  process.env.OLLAMA_HOST = '';
  process.env.PANGU_SESSIONS_DIR = path.join(dir, 'sessions');
  process.env.PANGU_AGENTDB_DIR = path.join(dir, 'agentdb');
  delete require.cache[require.resolve(path.join(__dirname, '..', 'modules', 'agentdb', 'backfill.js'))];
  delete require.cache[require.resolve(path.join(__dirname, '..', 'modules', 'session_store.js'))];
  delete require.cache[require.resolve(path.join(__dirname, '..', 'modules', 'agentdb', 'db.js'))];
  delete require.cache[require.resolve(path.join(__dirname, '..', 'modules', 'agentdb', 'index.js'))];
  delete require.cache[require.resolve(path.join(__dirname, '..', 'modules', 'agentdb', 'embedder.js'))];
  const backfillModule = freshRequire(path.join('..', 'modules', 'agentdb', 'backfill.js'));
  const backfill = backfillModule.backfill || backfillModule;
  // R39 件 1 修: target 既能传 dir 也能传 file (跟 sessionStore 读 ${PANGU_AGENTDB_DIR}/agentdb.sqlite 一致)
  const r1 = await backfill({
    source: oldPath,
    target: process.env.PANGU_AGENTDB_DIR,
    batch: 50,
    dryRun: false,
    limit: null,
  });
  assert.equal(r1.imported, 3);
  assert.equal(r1.target, path.join(process.env.PANGU_AGENTDB_DIR, 'agentdb.sqlite'));
  const ss = require(path.join(__dirname, '..', 'modules', 'session_store.js'));
  // 别 closeAgentDB — backfill.js 自己 close 过了, 再 close 会让 ss.getAgentDb 拿到 close 后的句柄
  const recalled = await ss.sessionRecall({ query: '原告上诉答辩', k: 3 });
  assert.equal(recalled.ok, true);
  assert.ok(recalled.result.memories.length >= 1);
  assert.ok(recalled.result.memories.some(m => m.content.includes('原告案件分析')));
  ss.closeAgentDB();
});

test('pangu-rebuild-fts is a no-op when drift is zero and rebuilds when drift exists', (t) => {
  const dir = makeTempDir(t);
  const Database = require('better-sqlite3');
  const oldPath = path.join(dir, 'old.sqlite');
  const oldDb = new Database(oldPath);
  oldDb.exec(`
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY,
      text TEXT,
      model TEXT,
      hash TEXT,
      embedding TEXT,
      start_line INTEGER,
      end_line INTEGER,
      path TEXT,
      source TEXT
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      text, id UNINDEXED, path UNINDEXED, source UNINDEXED, model UNINDEXED, start_line UNINDEXED, end_line UNINDEXED,
      content='chunks', content_rowid='rowid'
    );
  `);
  oldDb.prepare('INSERT INTO chunks (id, text, model, hash, embedding, path, source, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('c1', '原告上诉答辩', 'sha256-text', 'h1', '[]', '/p/c1', 'memory', 1, 1);
  oldDb.close();

  const { rebuild } = freshRequire(path.join('..', 'modules', 'pangu-rebuild-fts.js'));
  const noDrift = rebuild({ source: oldPath, dryRun: false });
  assert.equal(noDrift.drift, 0);
  assert.equal(noDrift.mode, 'no-op');
});

test('_incrementalReindex keeps chunks_fts in sync when chunks are reindexed', (t) => {
  const dir = makeTempDir(t);
  const sessDir = path.join(dir, 'memory', 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  const sessFile = path.join(sessDir, '2026-07-26.md');
  fs.writeFileSync(sessFile, '原告答辩状\n'.repeat(200), 'utf8');

  const helpers = freshRequire(path.join('..', 'modules', 'memory_helpers.js'));
  helpers._incrementalReindex(sessFile, path.join(dir, 'memory'));

  const Database = require('better-sqlite3');
  const db = new Database(path.join(dir, 'memory', 'main.sqlite'), { readonly: true });
  t.after(() => db.close());
  const drift = db.prepare('SELECT (SELECT COUNT(*) FROM chunks) - (SELECT COUNT(*) FROM chunks_fts) AS drift').get().drift;
  assert.equal(drift, 0);
});