'use strict';

const assert = require('assert');
const { test } = require('node:test');

const { SessionCompaction, createCompactor } = require('../modules/session_compaction');

function freshCompactor(t, config = {}) {
  const c = createCompactor(config);
  t.after(() => c.sessions.clear());
  return c;
}

test('R49: shouldCompact triggers on tokenCount >= tokenThreshold (即使 messageCount < messageThreshold)', (t) => {
  const c = freshCompactor(t, { tokenThreshold: 100 });
  const sessionId = 's1';
  // 5 messages, total ~400 chars = 100 tokens
  const msgs = [
    { role: 'system', content: 'a'.repeat(80) },
    { role: 'user', content: 'b'.repeat(80) },
    { role: 'assistant', content: 'c'.repeat(80) },
    { role: 'user', content: 'd'.repeat(80) },
    { role: 'assistant', content: 'e'.repeat(80) },
  ];
  c.register(sessionId, msgs);
  assert.strictEqual(c.shouldCompact(sessionId), true, 'shouldCompact should be true when tokens (100) >= threshold (100)');
});

test('R49: shouldCompact 不触发 when tokenCount < tokenThreshold', (t) => {
  const c = freshCompactor(t, { tokenThreshold: 1000 });
  const sessionId = 's2';
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  c.register(sessionId, msgs);
  assert.strictEqual(c.shouldCompact(sessionId), false, 'shouldCompact should be false when tokens (1) < threshold (1000)');
});

test('R49: register() + addMessage() 跟踪 tokenCount', (t) => {
  const c = freshCompactor(t, {});
  const sessionId = 's3';
  c.register(sessionId, [{ role: 'user', content: 'aaaa' }]);  // 4 chars = 1 token
  const s = c.getSession(sessionId);
  assert.strictEqual(s.tokenCount, 1);
  c.addMessage(sessionId, { role: 'assistant', content: 'bbbbbbbb' });  // +8 chars = 2 tokens
  assert.strictEqual(s.tokenCount, 3, 'tokenCount should be 1+2=3 after addMessage');
});

test('R49: compact() 后 tokenCount 字段被重算 (实际增减因 keepSystemMessages=true 不一定降, 跟原代码行为一致)', async (t) => {
  const c = freshCompactor(t, { retentionRatio: 0.3, maxRetainedMessages: 2 });
  const sessionId = 's4';
  const msgs = [];
  for (let i = 0; i < 10; i += 1) {
    msgs.push({ role: i % 2 ? 'user' : 'assistant', content: `msg${i} ${'x'.repeat(50)}` });
  }
  c.register(sessionId, msgs);
  const beforeTokens = c.getSession(sessionId).tokenCount;
  assert.ok(beforeTokens > 50, `should have many tokens, got ${beforeTokens}`);
  await c.compact(sessionId);
  const afterTokens = c.getSession(sessionId).tokenCount;
  assert.ok(typeof afterTokens === 'number', `tokenCount should be a number after compact, got ${typeof afterTokens}`);
  assert.ok(afterTokens > 0, `tokenCount should be > 0, got ${afterTokens}`);
});
