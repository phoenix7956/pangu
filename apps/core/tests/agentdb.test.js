'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const MODULES_DIR = path.join(__dirname, '..', 'modules');

function freshRequire(relativePath) {
  const fullPath = path.join(MODULES_DIR, relativePath);
  delete require.cache[require.resolve(fullPath)];
  return require(fullPath);
}

function makeTempDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-agentdb-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function deterministicEmbed(text) {
  const normalized = String(text || '').replace(/案子/g, '案件').replace(/诉讼/g, '案件');
  const vector = [0, 0, 0, 0];
  for (const ch of normalized) vector[ch.codePointAt(0) % vector.length] += 1;
  const norm = Math.hypot(...vector) || 1;
  return vector.map(v => v / norm);
}

test('sessionSave persists messages into SQLite and sessionLoad survives JSON loss', async (t) => {
  const dataDir = makeTempDataDir(t);
  process.env.PANGU_AGENTDB_DIR = path.join(dataDir, 'agentdb');
  process.env.PANGU_SESSIONS_DIR = path.join(dataDir, 'sessions');

  const store = freshRequire('session_store.js');
  t.after(() => store.closeAgentDB?.());

  const messages = [
    { role: 'user', content: '原告案件分析' },
    { role: 'assistant', content: '先整理证据目录并核对时效。' },
  ];
  const saved = await store.sessionSave({ session_id: 'case_1', messages, state: 'active', ts: 101 });
  assert.equal(saved.ok, true);
  assert.equal(fs.existsSync(path.join(process.env.PANGU_AGENTDB_DIR, 'agentdb.sqlite')), true);

  fs.rmSync(path.join(process.env.PANGU_SESSIONS_DIR, 'case_1.json'));
  const loaded = await store.sessionLoad({ session_id: 'case_1' });
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.result.messages, messages);
  assert.equal(loaded.result.session_id, 'case_1');
});

test('sessionRecall retrieves semantic memory after reopening the index', async (t) => {
  const dataDir = makeTempDataDir(t);
  process.env.PANGU_AGENTDB_DIR = path.join(dataDir, 'agentdb');
  process.env.PANGU_SESSIONS_DIR = path.join(dataDir, 'sessions');

  let store = freshRequire('session_store.js');
  await store.sessionSave({
    session_id: 'case_2',
    messages: [
      { role: 'user', content: '案件分析：我是原告，应当怎么准备？' },
      { role: 'assistant', content: '优先固定证据、确认诉讼时效、准备答辩要点。' },
    ],
    ts: 202,
    embed: deterministicEmbed,
  });
  store.closeAgentDB();

  store = freshRequire('session_store.js');
  t.after(() => store.closeAgentDB?.());
  const recalled = await store.sessionRecall({ query: '这个案子上次给了什么建议？', k: 3, embed: deterministicEmbed });

  assert.equal(recalled.ok, true);
  assert.ok(recalled.result.memories.length >= 1);
  assert.ok(recalled.result.memories.some(m => m.content.includes('诉讼时效')));
});

test('sessionRecall degrades to SQLite keyword search when the vector index is unavailable', async (t) => {
  const dataDir = makeTempDataDir(t);
  process.env.PANGU_AGENTDB_DIR = path.join(dataDir, 'agentdb');
  process.env.PANGU_SESSIONS_DIR = path.join(dataDir, 'sessions');

  const store = freshRequire('session_store.js');
  t.after(() => store.closeAgentDB?.());
  await store.sessionSave({
    session_id: 'case_3',
    messages: [{ role: 'assistant', content: '回滚方案：保留 JSON session，不让主循环死亡。' }],
    ts: 303,
    embed: async () => { throw new Error('embedding offline'); },
  });

  const recalled = await store.sessionRecall({
    query: '回滚方案',
    k: 3,
    embed: async () => { throw new Error('embedding offline'); },
  });
  assert.equal(recalled.ok, true);
  assert.equal(recalled.result.mode, 'keyword');
  assert.ok(recalled.result.memories.some(m => m.content.includes('保留 JSON session')));
});

test('injectRelevantMemories adds one bounded system message and ignores recall failures', async () => {
  const j2 = freshRequire('j2_agent_loop.js');
  const messages = [{ role: 'user', content: '案子后来怎么办？' }];
  await j2._injectRelevantMemories(messages, '案子后来怎么办？', async () => ({
    ok: true,
    result: {
      memories: [{ session_id: 'old_case', role: 'assistant', content: '先固定证据，再核对时效。', created_at: 404 }],
    },
  }));
  assert.equal(messages.filter(m => m.role === 'system' && m.content.includes('相关记忆')).length, 1);
  assert.ok(messages[0].content.includes('固定证据'));

  const unchanged = [{ role: 'user', content: '测试' }];
  await j2._injectRelevantMemories(unchanged, '测试', async () => { throw new Error('recall down'); });
  assert.deepEqual(unchanged, [{ role: 'user', content: '测试' }]);
});

test('sessionDelete removes DB trajectories and resume sidecars', async (t) => {
  const dataDir = makeTempDataDir(t);
  process.env.PANGU_AGENTDB_DIR = path.join(dataDir, 'agentdb');
  process.env.PANGU_SESSIONS_DIR = path.join(dataDir, 'sessions');
  process.env.PANGU_HOME = path.join(dataDir, 'home');
  process.env.PANGU_CHECKPOINT_DIR = path.join(dataDir, 'checkpoints');
  process.env.PANGU_TASK_DIR = path.join(dataDir, 'tasks');
  process.env.PANGU_PLAN_DIR = path.join(dataDir, 'plans');
  const store = freshRequire('session_store.js');
  t.after(() => store.closeAgentDB?.());
  await store.sessionSave({ session_id: 'case_delete', messages: [{ role: 'user', content: 'x' }], ts: 505, embed: async () => null });
  const db = store.getAgentDb();
  db.addTrajectory({ sessionId: 'case_delete', theme: 'test', userInput: 'x' });
  require('../modules/checkpoint').saveCheckpoint('case_delete', { round: 1, messages: [] });
  require('../modules/task_checkpoint').saveTaskCheckpoint('case_delete', { status: 'active' });
  require('../modules/plan_state').setPlan('case_delete', { goal: 'x', steps: [{ id: 's1', title: 'x' }] });
  const deleted = await store.sessionDelete({ session_id: 'case_delete' });
  assert.equal(deleted.ok, true);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS c FROM trajectories WHERE session_id = ?').get('case_delete').c, 0);
  assert.equal(require('../modules/checkpoint').listCheckpoints('case_delete').length, 0);
  assert.equal(require('../modules/task_checkpoint').loadTaskCheckpoint('case_delete'), null);
  assert.equal(require('../modules/plan_state').loadPlan('case_delete'), null);
});

test('checkpoint load falls back from corrupt latest and lists newest rounds first', async (t) => {
  const dir = makeTempDataDir(t);
  process.env.PANGU_CHECKPOINT_DIR = dir;
  const cpPath = require.resolve('../modules/checkpoint');
  delete require.cache[cpPath];
  const cp = require('../modules/checkpoint');
  cp.saveCheckpoint('checkpoint_case', { round: 1, messages: [{ role: 'user', content: 'old' }] });
  cp.saveCheckpoint('checkpoint_case', { round: 2, messages: [{ role: 'user', content: 'new' }] });
  cp.saveCheckpoint('checkpoint_case', { round: 3, messages: [{ role: 'user', content: 'newest' }] });
  const listed = cp.listCheckpoints('checkpoint_case', 1);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].round, 3);
  fs.writeFileSync(path.join(dir, 'checkpoint_case_r2.json'), '{broken', 'utf8');
  const loaded = cp.loadLatestCheckpoint('checkpoint_case');
  assert.equal(loaded.fresh, true);
  assert.equal(loaded.round, 3);
});
