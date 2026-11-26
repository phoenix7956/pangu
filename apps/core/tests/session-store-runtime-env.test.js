'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { test, after } = require('node:test');

const store = require('../modules/session_store');
const originalSessions = process.env.PANGU_SESSIONS_DIR;
const originalAgentDb = process.env.PANGU_AGENTDB_DIR;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-session-runtime-env-'));

test('session store follows runtime storage env after module load', async () => {
  const sessions = path.join(tmp, 'sessions');
  const agentdb = path.join(tmp, 'agentdb');
  process.env.PANGU_SESSIONS_DIR = sessions;
  process.env.PANGU_AGENTDB_DIR = agentdb;
  const id = 'runtime-env-probe';
  const saved = await store.sessionSave({ session_id: id, messages: [{ role: 'user', content: 'probe' }] });
  assert.equal(saved.ok, true);
  assert.equal(fs.existsSync(path.join(sessions, `${id}.json`)), true);
  const loaded = await store.sessionLoad({ session_id: id });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.result.session_id, id);
  await store.sessionDelete({ session_id: id });
  assert.equal(fs.existsSync(path.join(sessions, `${id}.json`)), false);
});

after(() => {
  if (originalSessions === undefined) delete process.env.PANGU_SESSIONS_DIR;
  else process.env.PANGU_SESSIONS_DIR = originalSessions;
  if (originalAgentDb === undefined) delete process.env.PANGU_AGENTDB_DIR;
  else process.env.PANGU_AGENTDB_DIR = originalAgentDb;
  fs.rmSync(tmp, { recursive: true, force: true });
});
