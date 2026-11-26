'use strict';

// R24 regression: the 2026-09-07 env gates must be observable at runtime.
// J2 reads the flags at module load, so each case runs in a clean child process.
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');

function runScenario(env) {
  const script = String.raw`
    const J2 = require(${JSON.stringify(path.join(ROOT, 'modules/j2_agent_loop.js'))});
    const router = require(${JSON.stringify(path.join(ROOT, 'modules/router/smart_router.js'))});
    require(${JSON.stringify(path.join(ROOT, 'modules/pangu_helpers.js'))}).init({
      _config: { llm: { models: [] } }, CONFIG_PATH: '/tmp/r24-flags.json',
      PRESETS: [], safeGuard: null, fs: require('fs')
    });
    const events = [];
    const res = {
      writeHead() {}, setHeader() {}, flushHeaders() {},
      write(s) { events.push(String(s)); return true; },
      on() {}, aborted: false, writableEnded: false,
      end() { this.writableEnded = true; }
    };
    J2.init({
      _detectToolCallSupport: async () => false,
      _callLLMForAgentStream: async function* () { return; },
      _callLLMForAgent: async () => ({ choices: [{ message: { content: '' } }] }),
      _j2ExecuteToolCalls: async () => [], _j2AppendToolResults: () => {},
      _recordSessionToMemory: async () => {}, _sessionRecall: async () => ({ ok: false }),
      safeResWrite: (r, s) => r.write(s),
      _hasUnclosedToolBlock: () => false,
    });
    (async () => {
      const dead = { id: 'flag-dead', provider: 'lmstudio', endpoint: 'http://127.0.0.1:9', context_length: 8192 };
      const good = { id: 'flag-good', provider: 'kimi', endpoint: 'https://example.invalid', context_length: 8192 };
      await J2._runAgentLoopLegacyStream(
        [{ role: 'system', content: 'test' }, { role: 'user', content: 'test' }],
        dead, { on() {}, aborted: false }, res,
        { userInput: 'test', reqBody: { session_id: 'r24-flags' }, sessionId: 'r24-flags', _modelChain: [good] }
      );
      process.stdout.write('@@RESULT@@' + JSON.stringify({
        events: events.join(''),
        penalty: router._silentFailPenalty('flag-dead')
      }));
      process.exit(0);
    })().catch((e) => { console.error(e.stack || e); process.exit(2); });
  `;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r24-flags-home-'));
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  fs.rmSync(home, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, `child failed: ${r.stderr}`);
  const marker = r.stdout.lastIndexOf('@@RESULT@@');
  assert.ok(marker >= 0, `child produced no JSON: ${r.stdout}`);
  return JSON.parse(r.stdout.slice(marker + '@@RESULT@@'.length));
}

test('R24 flags: disabling silent-fail fallback suppresses model switch', () => {
  const out = runScenario({ PANGU_SILENT_FAIL_FALLBACK: 'false' });
  assert.ok(!out.events.includes('event: model_switch'), 'disabled fallback must not emit model_switch');
  assert.match(out.events, /Silent Failure/, 'disabled fallback must report the original failure');
});

test('R24 flags: disabling router demote leaves model health unchanged', () => {
  const out = runScenario({ PANGU_SILENT_FAIL_FALLBACK: 'false', PANGU_ROUTER_DEMOTE: 'false' });
  assert.strictEqual(out.penalty, 0, 'disabled demote must not record silent-fail penalty');
});
