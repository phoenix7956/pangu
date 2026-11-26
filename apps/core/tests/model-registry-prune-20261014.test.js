'use strict';

// 2026-10-14: ~/.pangu/models-registry.json 积成坟场 (24 条里 17 条池外),
// 而且下划线/连字符 id 变体会让"精确匹配"误杀活着的模型缓存。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 测试必须重定向到 temp, 否则测试会真的清空主人的 registry
// (2026-08-23 models.json 已经栽过一次; registry 这边也栽了 —— r46-sync 写进过生产)。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-registry-test-'));
const REG = path.join(TMP, 'models-registry.json');
process.env.PANGU_REGISTRY_PATH = REG;

const registry = require('../modules/model_registry');

function seed(models) {
  fs.writeFileSync(REG, JSON.stringify({ version: 1, models, updated: new Date().toISOString() }));
  registry._reset();
}

test('S1 resolveKey 是 id 查找的唯一真源 (精确 → 下划线换连字符)', () => {
  seed({
    'minimax-m3.1-flash-preview': { context_length: 1004333 },
    'qwen3.8-27b-mlx': { context_length: 65536 },
  });
  // 池里写的带下划线, registry 存的是连字符 —— 两边必须认得是同一条
  assert.strictEqual(registry.resolveKey('minimax_m3.1-flash-preview'), 'minimax-m3.1-flash-preview');
  assert.strictEqual(registry.getContextLength('minimax_m3.1-flash-preview'), 1004333);
  assert.strictEqual(registry.resolveKey('qwen3.8-27b-mlx'), 'qwen3.8-27b-mlx');
  assert.strictEqual(registry.resolveKey('nope'), null);
  assert.strictEqual(registry.getContextLength('nope'), null);
});

test('S2 prune 绝不能删掉"池内 id 的变体写法" — 那正好制造 registry miss', () => {
  seed({
    'minimax-m3.1-flash-preview': { context_length: 1004333 },
    'qwen3.8-27b-mlx': { context_length: 65536 },
    'test-model': { context_length: 262144 },
    'ddalcu_qwen3.8-27b-mlx-serve-4bit': { context_length: 262144 },
  });
  // 池里只有这两条 (第一条是下划线写法)
  const r = registry.pruneModels(['minimax_m3.1-flash-preview', 'qwen3.8-27b-mlx']);
  const left = Object.keys(registry.load().models);
  assert.ok(left.includes('minimax-m3.1-flash-preview'),
    '变体写法必须活下来, 否则 getContextLength 查不到 → 触发我们刚修的那个坑');
  assert.ok(left.includes('qwen3.8-27b-mlx'));
  assert.ok(!left.includes('test-model'));
  assert.ok(!left.includes('ddalcu_qwen3.8-27b-mlx-serve-4bit'));
  assert.deepStrictEqual(r.removed.sort(), ['ddalcu_qwen3.8-27b-mlx-serve-4bit', 'test-model']);
});

test('S3 prune 要落盘并真删 (不是只在内存里算一遍)', () => {
  seed({ 'a-model': { context_length: 100 }, 'b-ghost': { context_length: 200 } });
  registry.pruneModels(['a-model']);
  const onDisk = JSON.parse(fs.readFileSync(REG, 'utf8'));
  assert.deepStrictEqual(Object.keys(onDisk.models), ['a-model']);
});

test('S4 空 validIds 会把 registry 清空 —— 必须拒 (空池清库 = 事故, 不是清理)', () => {
  seed({ 'a-model': { context_length: 100 } });
  registry.pruneModels([]);
  const onDisk = JSON.parse(fs.readFileSync(REG, 'utf8'));
  assert.ok(onDisk.models['a-model'], '空池不许清库');
});

test('S5 alsoKeep 保住在池外但随时会加回来的模型 (可选, 默认不保)', () => {
  seed({ 'a-model': { context_length: 100 }, 'kimi-for-coding': { context_length: 1048576 } });
  registry.pruneModels(['a-model']);
  assert.ok(!registry.load().models['kimi-for-coding'], '默认不保 —— 池外就是池外');
  // 重新 seed: 上一步已经把它真删了, 再保就没意义了 (测的是"保"这个开关, 不是复活)
  seed({ 'a-model': { context_length: 100 }, 'kimi-for-coding': { context_length: 1048576 } });
  registry.pruneModels(['a-model'], { alsoKeep: ['kimi-for-coding'] });
  assert.ok(registry.load().models['kimi-for-coding']);
});

test('S6 清理回归: HOME 还原 + temp 目录归零', () => {
  delete process.env.PANGU_REGISTRY_PATH;
  fs.rmSync(TMP, { recursive: true, force: true });
  assert.ok(true);
});

