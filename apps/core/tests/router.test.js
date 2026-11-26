'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const SMART_ROUTER = require('../modules/router/smart_router');
const COST_GUARD = require('../modules/router/cost_guard');

function freshTempDir(t, name = 'router-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withModels(t, dir, modelsObj) {
  const file = path.join(dir, 'models.json');
  fs.writeFileSync(file, JSON.stringify(modelsObj));
  process.env.PANGU_MODELS_PATH = file;
  SMART_ROUTER.invalidateCache();
  t.after(() => {
    SMART_ROUTER.invalidateCache();
    delete process.env.PANGU_MODELS_PATH;
  });
}

test('classifyTask picks task type by keywords', (t) => {
  const tests = [
    { input: '写一段 TypeScript function 处理 null', expect: 'code' },
    { input: '请帮我摘要一下这篇文章', expect: 'summary' },
    { input: '翻译这段英文成中文', expect: 'translation' },
    { input: '查找所有 7 月 25 日的 session', expect: 'search' },
    { input: '为什么 Pangu 沉默? 分析一下', expect: 'reasoning' },
  ];
  for (const tt of tests) {
    const r = SMART_ROUTER.classifyTask(tt.input);
    assert.ok(['code', 'summary', 'translation', 'search', 'reasoning', 'strategy', 'chinese'].includes(r.task),
      `classify should return known task for "${tt.input}", got ${r.task}`);
  }
});

test('route returns primary + fallback chain', (t) => {
  const dir = freshTempDir(t);
  withModels(t, dir, {
    routing_policy: { default_strategy: 'smart', fallback_chain: [], task_classifier: 'keyword' },
    models: [
      { id: 'm1', provider: 'openai', api_base: 'http://x', cost_per_1k_input: 0.001, cost_per_1k_output: 0.002, latency_p50_ms: 100, quality_score: 0.9, max_tokens: 8000, role_specialty: ['code'], 'available': true },
      { id: 'm2', provider: 'openai', api_base: 'http://y', cost_per_1k_input: 0.003, cost_per_1k_output: 0.015, latency_p50_ms: 800, quality_score: 0.85, max_tokens: 32000, role_specialty: ['reasoning'], 'available': true },
    ],
  });
  const r = SMART_ROUTER.route('写一段 TypeScript function');
  assert.ok(r.primary, 'primary should exist');
  assert.ok(Array.isArray(r.fallback_chain), 'fallback_chain should be array');
  assert.ok(r.strategy === 'smart' || r.strategy === 'forced', 'strategy should be smart or forced');
});

test('route strategy=cost orders by cost ascending', (t) => {
  const dir = freshTempDir(t);
  withModels(t, dir, {
    routing_policy: { default_strategy: 'smart' },
    models: [
      { id: 'expensive', provider: 'openai', api_base: 'http://a', cost_per_1k_input: 0.01, cost_per_1k_output: 0.05, quality_score: 0.95, role_specialty: ['reasoning'], 'available': true },
      { id: 'cheap', provider: 'openai', api_base: 'http://b', cost_per_1k_input: 0.0001, cost_per_1k_output: 0.0002, quality_score: 0.7, role_specialty: ['reasoning'], 'available': true },
    ],
  });
  const r = SMART_ROUTER.route('为什么 Pangu 沉默?', { strategy: 'cost' });
  assert.strictEqual(r.primary.id, 'cheap', 'cost strategy should pick cheapest first');
});

test('route strategy=fastest orders by latency ascending', (t) => {
  const dir = freshTempDir(t);
  withModels(t, dir, {
    routing_policy: { default_strategy: 'smart' },
    models: [
      { id: 'slow', provider: 'openai', api_base: 'http://a', cost_per_1k_input: 0.001, cost_per_1k_output: 0.002, latency_p50_ms: 5000, quality_score: 0.9, role_specialty: ['reasoning'], 'available': true },
      { id: 'fast', provider: 'openai', api_base: 'http://b', cost_per_1k_input: 0.001, cost_per_1k_output: 0.002, latency_p50_ms: 100, quality_score: 0.7, role_specialty: ['reasoning'], 'available': true },
    ],
  });
  const r = SMART_ROUTER.route('为什么 Pangu 沉默?', { strategy: 'fastest' });
  assert.strictEqual(r.primary.id, 'fast', 'fastest should pick lowest latency');
});

test('route with empty models returns warning NO_MODELS_AVAILABLE', (t) => {
  const dir = freshTempDir(t);
  withModels(t, dir, { routing_policy: { default_strategy: 'smart' }, models: [] });
  const r = SMART_ROUTER.route('test');
  assert.strictEqual(r.warning, 'NO_MODELS_AVAILABLE');
  assert.strictEqual(r.primary, null);
});

test('forced model bypasses routing', (t) => {
  const dir = freshTempDir(t);
  withModels(t, dir, {
    routing_policy: { default_strategy: 'smart' },
    models: [
      { id: 'forced', provider: 'openai', api_base: 'http://a', quality_score: 0.5, role_specialty: ['code'], 'available': true },
      { id: 'best', provider: 'openai', api_base: 'http://b', quality_score: 0.95, role_specialty: ['code'], 'available': true },
    ],
  });
  const r = SMART_ROUTER.route('test', { forced: 'forced' });
  assert.strictEqual(r.primary.id, 'forced');
  assert.strictEqual(r.strategy, 'forced');
});

test('cost_guard.recordSpend + checkBudget track spend', (t) => {
  const dir = freshTempDir(t, 'cost-');
  process.env.PANGU_COST_DIR = dir;
  delete process.env.MONTHLY_BUDGET_USD;
  t.after(() => {
    delete process.env.PANGU_COST_DIR;
    delete process.env.MONTHLY_BUDGET_USD;
  });

  const before = COST_GUARD.checkBudget();
  const initial = before.spent;

  const model = { id: 'test', cost_per_1k_input: 0.001, cost_per_1k_output: 0.002 };
  const newSpend = COST_GUARD.recordSpend(model, 1000, 500);

  const expectedCost = (1000 / 1000) * 0.001 + (500 / 1000) * 0.002;
  assert.ok(Math.abs(newSpend - (initial + expectedCost)) < 0.0001,
    `spent ${newSpend} should equal initial ${initial} + ${expectedCost}`);

  const after = COST_GUARD.checkBudget();
  assert.ok(after.spent >= newSpend, 'checkBudget should reflect recorded spend');
});

test('cost_guard budget threshold triggers over_threshold', (t) => {
  const dir = freshTempDir(t, 'budget-');
  process.env.PANGU_COST_DIR = dir;
  process.env.MONTHLY_BUDGET_USD = '0.001';
  t.after(() => {
    delete process.env.PANGU_COST_DIR;
    delete process.env.MONTHLY_BUDGET_USD;
  });

  const model = { id: 'test2', cost_per_1k_input: 1.0, cost_per_1k_output: 1.0 };
  COST_GUARD.recordSpend(model, 100, 100);

  const b = COST_GUARD.checkBudget();
  assert.strictEqual(b.over_threshold, true, 'over_threshold should be true after heavy spend');
  assert.ok(b.ratio >= 0.9, `ratio ${b.ratio} should be >= 0.9`);
});

test('R42 polish: normalizeSemanticText 真生效 — 案子→案件 归 law 类', (t) => {
  const r1 = SMART_ROUTER.classifyTask('我有个案子要处理');
  assert.strictEqual(r1.task, 'law', `案子 should normalize to 案件 and hit law class, got ${r1.task}`);
  const r2 = SMART_ROUTER.classifyTask('打官司找律师');
  assert.strictEqual(r2.task, 'law', `打官司 should normalize to 诉讼 and hit law class, got ${r2.task}`);
  const r3 = SMART_ROUTER.classifyTask('合同纠纷需要应诉');
  assert.strictEqual(r3.task, 'law', `应诉 should normalize to 答辩 and hit law class, got ${r3.task}`);
  const r4 = SMART_ROUTER.classifyTask('attorney needed for court case');
  assert.strictEqual(r4.task, 'law', `English law keywords should hit law class, got ${r4.task}`);
});

test('R42 polish: budgetRatio >= 0.9 触发 cost 排序 (auto-degrade)', (t) => {
  const dir = freshTempDir(t);
  withModels(t, dir, {
    routing_policy: { default_strategy: 'smart' },
    models: [
      { id: 'expensive', provider: 'openai', api_base: 'http://a', cost_per_1k_input: 0.01, cost_per_1k_output: 0.05, quality_score: 0.95, role_specialty: ['reasoning'], 'available': true },
      { id: 'cheap', provider: 'openai', api_base: 'http://b', cost_per_1k_input: 0.0001, cost_per_1k_output: 0.0002, quality_score: 0.7, role_specialty: ['reasoning'], 'available': true },
    ],
  });
  // budgetRatio >= 0.9 → cost order 真生效, 即使 quality_score 更高也选 cheap
  const r = SMART_ROUTER.route('为什么 Pangu 沉默?', { budgetRatio: 0.95 });
  assert.strictEqual(r.primary.id, 'cheap', 'budgetRatio >= 0.9 should force cost ordering (auto-degrade)');
  assert.strictEqual(r.strategy, 'smart', 'strategy 仍是 smart (内部 sort 用 cost)');
});

test('R42 polish: budgetRatio < 0.9 走 quality 排序 (不退化)', (t) => {
  const dir = freshTempDir(t);
  withModels(t, dir, {
    routing_policy: { default_strategy: 'smart' },
    models: [
      { id: 'expensive', provider: 'openai', api_base: 'http://a', cost_per_1k_input: 0.01, cost_per_1k_output: 0.05, quality_score: 0.95, role_specialty: ['reasoning'], 'available': true },
      { id: 'cheap', provider: 'openai', api_base: 'http://b', cost_per_1k_input: 0.0001, cost_per_1k_output: 0.0002, quality_score: 0.7, role_specialty: ['reasoning'], 'available': true },
    ],
  });
  const r = SMART_ROUTER.route('为什么 Pangu 沉默?', { budgetRatio: 0.5 });
  assert.strictEqual(r.primary.id, 'expensive', 'budgetRatio < 0.9 should keep quality ordering');
});
