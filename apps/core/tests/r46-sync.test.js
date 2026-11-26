'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const HELPERS = require('../modules/pangu_helpers');
const MODEL_REGISTRY = require('../modules/model_registry');

// 2026-08-23 重写 (事故驱动): 旧版用 monkey-patch stub sync, 但 init() 内部仍调真 sync 写生产
// modules/router/models.json — test1 留下 2 个假模型 / test3 空 config 把全表清成 0,
// 导致 daemon router 60s 缓存到期后 NO_MODELS_AVAILABLE, 所有请求静默掉回 k3-256k。
// 现版: 全程 PANGU_MODELS_PATH 指到 temp 文件 (sync 与 smart_router 读路径同 env), 零生产副作用。

function setupTmp(t, initialModels) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r46-sync-iso-'));
  const tmpRouterPath = path.join(tmpDir, 'models.json');
  // 2026-10-14: registry 也要隔离。光隔离 router 文件不够 ——
  // registerTestContexts 里的 setContextLength 直接写 ~/.pangu/models-registry.json,
  // 于是 r46-test-model / minimax/MiniMax-M3 这几条测试条目**活进了生产 registry**
  // (现场 source='test' 的条目就是它们)。同一个 2026-08-23 事故修了半边。
  const tmpRegistryPath = path.join(tmpDir, 'models-registry.json');
  fs.writeFileSync(tmpRegistryPath, JSON.stringify({ version: 1, models: {}, updated: new Date().toISOString() }));
  fs.writeFileSync(tmpRouterPath, JSON.stringify({
    routing_policy: { default_strategy: 'smart' },
    models: initialModels,
  }));
  process.env.PANGU_MODELS_PATH = tmpRouterPath;
  process.env.PANGU_REGISTRY_PATH = tmpRegistryPath;
  t.after(() => {
    delete process.env.PANGU_MODELS_PATH;
    delete process.env.PANGU_REGISTRY_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  return tmpRouterPath;
}

function registerTestContexts(entries) {
  MODEL_REGISTRY._reset();
  for (const [id, contextLength] of entries) {
    MODEL_REGISTRY.setContextLength(id, contextLength, 'test', { measure: 'v2-tokens' });
  }
}

test('R46 §1: syncRouterModelsFromConfig upsert _config.llm.models → router/models.json (env 隔离)', (t) => {
  const tmpRouterPath = setupTmp(t, [
    { id: 'minimax/MiniMax-M3', provider: 'minimax', api_base: 'https://api.minimax.com/v1/chat/completions', cost_per_1k_input: 0.003, cost_per_1k_output: 0.015, max_tokens: 32768, context_length: 524288, quality_score: 0.85, available: true, env_var: 'MINIMAX_API_KEY' },
  ]);

  const fakeConfig = {
    llm: {
      current_model_id: 'r46-test-model',
      models: [
        { id: 'r46-test-model', provider: 'openai', endpoint: 'http://r46.test/v1/chat/completions', api_key: '${R46_KEY}', priority: 80, enabled: true, context_length: 16000, capabilities: ['code', 'reasoning'] },
        { id: 'minimax/MiniMax-M3', provider: 'minimax', endpoint: 'https://api.minimax.com/v1/chat/completions', api_key: '${MINIMAX_API_KEY}', priority: 85, enabled: true, context_length: 524288, capabilities: ['reasoning', 'chinese', 'law', 'code', 'strategy'] },
      ],
    },
  };
  registerTestContexts([['r46-test-model', 16000], ['minimax/MiniMax-M3', 524288]]);
  HELPERS.init({ _config: fakeConfig, CONFIG_PATH: '/tmp/fake.json', PRESETS: null, safeGuard: null, fs });
  // init 末尾已 sync 一次 (全部写 tmp); 再显式调一次断言幂等返回
  const r = HELPERS.syncRouterModelsFromConfig();
  assert.strictEqual(r.synced, 2);

  const after = JSON.parse(fs.readFileSync(tmpRouterPath, 'utf8'));
  const ids = after.models.map(m => m.id);
  assert.ok(ids.includes('r46-test-model'), 'should add new model');
  assert.ok(ids.includes('minimax/MiniMax-M3'), 'should keep existing model');
  assert.strictEqual(after.models.length, 2, `expected 2 models (1 orig + 1 new), got ${after.models.length}`);

  // Verify field mapping for the new model (真实现契约: max_tokens 与 context_length 分离)
  const newEntry = after.models.find(m => m.id === 'r46-test-model');
  assert.strictEqual(newEntry.provider, 'openai');
  assert.strictEqual(newEntry.api_base, 'http://r46.test/v1/chat/completions');
  assert.strictEqual(newEntry.env_var, 'R46_KEY', 'should extract env var from ${R46_KEY}');
  assert.strictEqual(newEntry.max_tokens, 32768, 'config 无 max_tokens → 默认 32768');
  assert.strictEqual(newEntry.context_length, 16000);
// 2026-10-14 契约变更: quality_score 缺失不再用 (priority||50)/100 兜底。
// 实证: 真实配置 your-mac.json 里 8 个模型的 priority 全是 100 (纯填充、零信息量),
// 于是所有没显式配分的模型全被兜成 1.0, 和 minimax-m3 并列最高分 —— 连本地 4bit
// 量化模型也一样。同时 role_model 直读 config 时同一批模型是 null → 0.7,
// 同一池两套排序打架。现在统一走 role_model.DEFAULT_QUALITY_SCORE。
assert.strictEqual(newEntry.quality_score, require('../modules/role_model').DEFAULT_QUALITY_SCORE,
`quality_score 未配 → 默认 ${require('../modules/role_model').DEFAULT_QUALITY_SCORE}, 不受 priority 影响`);
  assert.deepStrictEqual(newEntry.role_specialty, ['code', 'reasoning']);
  assert.strictEqual(newEntry.available, true);

  // Verify existing model updated (not duplicated)
  const existingEntry = after.models.find(m => m.id === 'minimax/MiniMax-M3');
  assert.strictEqual(existingEntry.env_var, 'MINIMAX_API_KEY', 'should update env_var');
  assert.strictEqual(existingEntry.context_length, 524288);
});

test('R46 §1: sync 跑 2 次幂等 (二跑 added=0, updated=N)', (t) => {
  const tmpRouterPath = setupTmp(t, []);

  const fakeConfig = {
    llm: {
      current_model_id: 'r46-idem-model',
      models: [
        { id: 'r46-idem-model', provider: 'openai', endpoint: 'http://x/v1/chat/completions', api_key: '', priority: 50, enabled: true, context_length: 8000, capabilities: ['reasoning'] },
      ],
    },
  };
  registerTestContexts([['r46-idem-model', 8000]]);
  HELPERS.init({ _config: fakeConfig, CONFIG_PATH: '/tmp/fake.json', PRESETS: null, safeGuard: null, fs });

  // init() already called sync once (added=1, updated=0); r1 is 2nd sync
  const r1 = HELPERS.syncRouterModelsFromConfig();
  assert.strictEqual(r1.added, 0, 'r1 (2nd sync) should add 0 — model already there');
  assert.strictEqual(r1.updated, 1, 'r1 should update 1 (existing model)');

  const r2 = HELPERS.syncRouterModelsFromConfig();
  assert.strictEqual(r2.added, 0, 'idempotent — third run should add 0');
  assert.strictEqual(r2.updated, 1, 'third run should still update 1 (model entry refreshed)');

  const after = JSON.parse(fs.readFileSync(tmpRouterPath, 'utf8'));
  assert.strictEqual(after.models.length, 1, 'temp file should hold exactly the 1 config model');
});

test('R46 §1: 未探测模型隔离跳过, 不拖垮已探测模型', (t) => {
  const tmpRouterPath = setupTmp(t, []);
  const fakeConfig = {
    llm: {
      current_model_id: 'r46-known-model',
      models: [
        { id: 'r46-known-model', provider: 'openai', endpoint: 'http://known.test/v1/chat/completions', priority: 80, enabled: true, capabilities: ['reasoning'] },
        { id: 'r46-unknown-model', provider: 'openai', endpoint: 'http://unknown.test/v1/chat/completions', priority: 50, enabled: true, capabilities: ['reasoning'] },
      ],
    },
  };
  registerTestContexts([['r46-known-model', 16000]]);
  HELPERS.init({ _config: fakeConfig, CONFIG_PATH: '/tmp/fake.json', PRESETS: null, safeGuard: null, fs });
  const result = HELPERS.syncRouterModelsFromConfig();
  const after = JSON.parse(fs.readFileSync(tmpRouterPath, 'utf8'));
  assert.strictEqual(result.synced, 1);
  assert.strictEqual(result.skipped, 1);
  assert.deepStrictEqual(after.models.map(model => model.id), ['r46-known-model']);
});

test('R46 §1: 空 config 兜底 — 不清库, skip 不抛 (2026-08-23 事故回归)', (t) => {
  // 关键回归: 空 _config 时绝不允许把 router models.json prune 成 0 (会让 router 静默失效)
  const sentinel = [
    { id: 'sentinel-a', provider: 'openai', available: true },
    { id: 'sentinel-b', provider: 'openai', available: true },
  ];
  const tmpRouterPath = setupTmp(t, sentinel);
  const before = fs.readFileSync(tmpRouterPath, 'utf8');

  HELPERS.init({ _config: {}, CONFIG_PATH: '/tmp/fake.json', PRESETS: null, safeGuard: null, fs });
  const r = HELPERS.syncRouterModelsFromConfig();
  assert.strictEqual(r.synced, 0, 'empty _config should sync 0');
  assert.strictEqual(r.error, undefined, 'empty _config should not error');
  assert.strictEqual(r.skipped, 'empty_config', 'empty _config should skip explicitly');
  assert.strictEqual(fs.readFileSync(tmpRouterPath, 'utf8'), before, 'empty _config MUST NOT touch models.json (prune-to-zero = incident)');
});
