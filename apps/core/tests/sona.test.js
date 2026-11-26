'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const { AgentDatabase } = require('../modules/agentdb/db');
const { themeHint, normalize } = require('../modules/sona/classifier');
const { logTrajectory } = require('../modules/sona/logger');
const { formatPatternsForPrompt } = require('../modules/sona/router');

function freshDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sona-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new AgentDatabase({ root: path.join(dir, 'agentdb') });
}

test('themeHint picks domain by keywords', (t) => {
  const cases = [
    ['我是原告, 被上诉方, 怎么应对', 'case_response'],
    ['帮我看一下这个 PR 的 diff', 'code_review'],
    ['设计一个新架构', 'architecture'],
    ['查一下 7 月 25 日的 session', 'data_query'],
    ['系统报错了, 500 错误', 'bug_investigate'],
    ['今天天气不错', 'general'],
    ['', 'general'],
  ];
  for (const [input, expected] of cases) {
    const theme = themeHint(input);
    assert.strictEqual(theme, expected, `theme("${input}") should be ${expected}, got ${theme}`);
  }
});

test('themeHint does not call LLM (no network dep)', () => {
  // classifier must work synchronously + return immediately
  const start = Date.now();
  for (let i = 0; i < 100; i += 1) themeHint('我是原告被上诉');
  const duration = Date.now() - start;
  assert.ok(duration < 500, `100 themeHint calls should take <500ms, took ${duration}ms`);
});

test('AgentDatabase.addTrajectory persists trajectory', (t) => {
  const db = freshDb(t);
  t.after(() => db.close());
  const id = db.addTrajectory({
    sessionId: 's1',
    theme: 'case_response',
    userInput: '我是原告',
    assistantSummary: '建议答辩',
    toolsUsed: '["session_recall"]',
    toolCallCount: 1,
    tokensTotal: 1234,
    rounds: 3,
    modelUsed: 'minimax/MiniMax-M3',
  });
  assert.ok(Number.isInteger(id) && id > 0, 'should return positive id');
  const rows = db.db.prepare('SELECT * FROM trajectories WHERE id = ?').get(id);
  assert.strictEqual(rows.theme, 'case_response');
  assert.strictEqual(rows.user_input, '我是原告');
});

test('getActiveThemes returns themes with >= minSample trajectories', (t) => {
  const db = freshDb(t);
  t.after(() => db.close());
  for (let i = 0; i < 3; i += 1) {
    db.addTrajectory({ sessionId: `s${i}`, theme: 'case_response', userInput: 'x' });
  }
  db.addTrajectory({ sessionId: 's4', theme: 'code_review', userInput: 'y' });
  const themes = db.getActiveThemes(2);
  assert.ok(themes.includes('case_response'), 'case_response should appear with 3 trajectories');
  assert.ok(!themes.includes('code_review'), 'code_review should not appear with only 1 trajectory');
});

test('upsertPattern creates pattern + dedups by (theme, summary)', (t) => {
  const db = freshDb(t);
  t.after(() => db.close());
  const id1 = db.upsertPattern({
    theme: 'case_response',
    patternSummary: '老板偏好短句',
    decisionPoints: '["先案由"]',
    trajectoryIds: '["1","2"]',
    embedding: [0.1, 0.2, 0.3, 0.4],
    sampleSize: 3,
  });
  const id2 = db.upsertPattern({
    theme: 'case_response',
    patternSummary: '老板偏好短句',
    decisionPoints: '["先案由","先证据"]',
    trajectoryIds: '["1","2","3"]',
    embedding: [0.1, 0.2, 0.3, 0.4],
    sampleSize: 3,
  });
  assert.strictEqual(id1, id2, 'same (theme, summary) should return same id');
  const row = db.db.prepare('SELECT * FROM patterns WHERE id = ?').get(id1);
  assert.ok(row.sample_size >= 4, `sample_size should accumulate, got ${row.sample_size}`);
});

test('searchPatterns returns patterns sorted by sample_size desc', (t) => {
  const db = freshDb(t);
  t.after(() => db.close());
  db.upsertPattern({ theme: 'case_response', patternSummary: 'A', sampleSize: 2 });
  db.upsertPattern({ theme: 'case_response', patternSummary: 'B', sampleSize: 5 });
  db.upsertPattern({ theme: 'case_response', patternSummary: 'C', sampleSize: 1 });
  const rows = db.searchPatterns('case_response', { limit: 3 });
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].pattern_summary, 'B', 'B has highest sample_size, should be first');
});

test('logTrajectory fire-and-forget on bad db returns null without throwing', async () => {
  const id = await logTrajectory(null, 's', 'input', [{ role: 'assistant', content: 'reply' }], { model: 'test' });
  assert.strictEqual(id, null);
});

test('formatPatternsForPrompt includes theme + decision points within maxChars', () => {
  const patterns = [
    { theme: 'case_response', pattern_summary: '老板偏好短句 + 直接 + 边界假设', decision_points: ['先案由', '再法条', '最后诉求'], sample_size: 5, hit_count: 3 },
    { theme: 'case_response', pattern_summary: '证据链结构化', decision_points: ['OCR 真源', '原案材料', '应对策略'], sample_size: 3, hit_count: 1 },
  ];
  const formatted = formatPatternsForPrompt(patterns, 1200);
  assert.ok(formatted.includes('SONA ReasoningBank'), 'should include header');
  assert.ok(formatted.includes('case_response'), 'should include theme name');
  assert.ok(formatted.includes('老板偏好短句'), 'should include summary');
  assert.ok(formatted.includes('先案由'), 'should include first decision point');
  assert.ok(formatted.length <= 1200, `output should respect maxChars, got ${formatted.length}`);
});

test('formatPatternsForPrompt returns empty for empty array', () => {
  assert.strictEqual(formatPatternsForPrompt([], 1200), '');
  assert.strictEqual(formatPatternsForPrompt(null, 1200), '');
});

test('R40 polish §6: hit_count → effective_confidence boost 真排序', (t) => {
  const db = freshDb(t);
  t.after(() => db.close());
  // A: high sample_size=10, hit_count=0 (没人命中过)
  // B: low sample_size=2, hit_count=10 (实战 10 次命中)
  // 期望 B 排前 (effective_confidence B > A)
  db.upsertPattern({ theme: 'case_response', patternSummary: 'A_old_pattern_high_sample', sampleSize: 10 });
  db.upsertPattern({ theme: 'case_response', patternSummary: 'B_new_pattern_many_hits', sampleSize: 2 });
  // 给 B 加 hit_count (模拟实战命中)
  const bId = db.db.prepare('SELECT id FROM patterns WHERE pattern_summary = ?').get('B_new_pattern_many_hits').id;
  for (let i = 0; i < 10; i += 1) db.incrementPatternHit(bId);

  const rows = db.searchPatterns('case_response', { limit: 3 });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].pattern_summary, 'B_new_pattern_many_hits', 'B (high hit_count) should rank first despite lower sample_size');
  assert.ok(rows[0].effective_confidence > rows[1].effective_confidence, `B.effective(${rows[0].effective_confidence}) should > A.effective(${rows[1].effective_confidence})`);
  assert.ok(rows[0].hit_boost >= 0.3, `B hit_boost should be capped at 0.3, got ${rows[0].hit_boost}`);
});

test('R40 polish §6: effective_confidence 在 sample_size + hit_count 都 0 时不爆', (t) => {
  const db = freshDb(t);
  t.after(() => db.close());
  db.upsertPattern({ theme: 'bug_investigate', patternSummary: 'fresh_pattern', sampleSize: 1 });
  const rows = db.searchPatterns('bug_investigate', { limit: 1 });
  assert.strictEqual(rows.length, 1);
  assert.ok(typeof rows[0].effective_confidence === 'number', 'effective_confidence should be number');
  assert.ok(rows[0].effective_confidence >= 0.5, `base confidence = 0.5 + boost 0 = 0.5, got ${rows[0].effective_confidence}`);
});

test('R40 polish §7: bootstrapTrajectoriesFromMemories 从 user memories 反推 trajectories', (t) => {
  const db = freshDb(t);
  t.after(() => db.close());
  // 模拟 R39 backfill 写的 user memories
  db.upsertSession({ sessionId: 's1', createdAt: 1000, updatedAt: 1000 });
  db.addMemory({ sessionId: 's1', role: 'user', content: '我是原告, 被上诉方, 怎么应对', messageKey: 'm1', createdAt: 1000 });
  db.addMemory({ sessionId: 's1', role: 'assistant', content: '需要先看案由...', messageKey: 'm2', createdAt: 1001 });
  db.addMemory({ sessionId: 's1', role: 'user', content: '帮我看一下这个 PR 的 diff', messageKey: 'm3', createdAt: 1002 });
  db.addMemory({ sessionId: 's2', role: 'user', content: '系统报错了 500 错误', messageKey: 'm4', createdAt: 1003 });

  const r = db.bootstrapTrajectoriesFromMemories({ limit: 100 });
  assert.strictEqual(r.scanned, 3, 'should scan 3 user-role memories (skip assistant)');
  assert.strictEqual(r.written, 3, 'should write 3 trajectories');
  assert.ok(r.byTheme.case_response >= 1, `should classify case_response, got byTheme=${JSON.stringify(r.byTheme)}`);
  assert.ok(r.byTheme.code_review >= 1 || r.byTheme.bug_investigate >= 1, `should classify code/bug theme, got byTheme=${JSON.stringify(r.byTheme)}`);

  // Verify trajectories 表确实有 3 行
  const trajCount = db.db.prepare('SELECT COUNT(*) AS n FROM trajectories').get().n;
  assert.strictEqual(trajCount, 3, 'trajectories table should have 3 rows');

  // 二次跑 — 不重复写
  const r2 = db.bootstrapTrajectoriesFromMemories({ limit: 100 });
  assert.strictEqual(r2.written, 0, 'idempotent — second run writes 0');
});

test('R40 polish §7: bootstrap dryRun 只算不算', (t) => {
  const db = freshDb(t);
  t.after(() => db.close());
  db.upsertSession({ sessionId: 's1', createdAt: 1000, updatedAt: 1000 });
  db.addMemory({ sessionId: 's1', role: 'user', content: '查一下 7 月 25 日的 session', messageKey: 'm1', createdAt: 1000 });
  const r = db.bootstrapTrajectoriesFromMemories({ dryRun: true });
  assert.strictEqual(r.scanned, 1);
  assert.strictEqual(r.written, 0);
  const trajCount = db.db.prepare('SELECT COUNT(*) AS n FROM trajectories').get().n;
  assert.strictEqual(trajCount, 0, 'dryRun should not write');
});

test('R40 polish §7: bootstrap 支持 history role (R39 backfill 175 老 chunks)', (t) => {
  const db = freshDb(t);
  t.after(() => db.close());
  db.upsertSession({ sessionId: 's1', createdAt: 1000, updatedAt: 1000 });
  // user role
  db.addMemory({ sessionId: 's1', role: 'user', content: '老板下个指令', messageKey: 'm1', createdAt: 1000 });
  // history role (R39 backfill 模式)
  db.addMemory({ sessionId: 's1', role: 'history', content: '帮我修个 bug', messageKey: 'm2', createdAt: 1001 });
  db.addMemory({ sessionId: 's1', role: 'history', content: '翻译这段中文', messageKey: 'm3', createdAt: 1002 });

  const r = db.bootstrapTrajectoriesFromMemories({ limit: 100 });
  assert.strictEqual(r.scanned, 3, 'should scan user + history');
  assert.strictEqual(r.written, 3);
  assert.strictEqual(r.byRole.user, 1, 'should count user role separately');
  assert.strictEqual(r.byRole.history, 2, 'should count history role separately');

  // 限定 roles: ['user'] — 只扫 user, 跳过 history
  const r2 = db.bootstrapTrajectoriesFromMemories({ roles: ['user'] });
  assert.strictEqual(r2.scanned, 1, 'roles filter should exclude history');
  assert.strictEqual(r2.byRole.history, undefined, 'byRole should not include excluded role');
});

test('R40 polish §7: bootstrap 跳过空内容', (t) => {
  const db = freshDb(t);
  t.after(() => db.close());
  db.upsertSession({ sessionId: 's1', createdAt: 1000, updatedAt: 1000 });
  db.addMemory({ sessionId: 's1', role: 'history', content: '', messageKey: 'm1', createdAt: 1000 });
  const r = db.bootstrapTrajectoriesFromMemories({ limit: 100 });
  assert.strictEqual(r.scanned, 1, 'should still scan empty row');
  assert.strictEqual(r.written, 0, 'should skip empty content');
});
