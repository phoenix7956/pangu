'use strict';

// 2026-10-14: 本地端点模型名失配自愈。
// 现场: oMLX 只认 "Qwen3.8-27B-4bit", 池里存着 "mlx-community_qwen3.8-27b-4bit",
// 盘古把 404 (正文里明明列着正确名字) 原样抛上去, 整轮死。
const test = require('node:test');
const assert = require('node:assert');

const heal = require('../modules/model_name_selfheal');

const OMLX_404 =
  'HTTP 404: {"error":{"message":"Model \'mlx-community_qwen3.8-27b-4bit\' not found. ' +
  'Available models: Qwen3.8-27B-4bit","type":"not_found_error"}}';

test('S1 只在"模型没找到"这类错误上自愈 — 401/网络错不许重试', () => {
  assert.strictEqual(heal.looksLikeModelMissing(new Error('HTTP 401: Unauthorized')), false);
  assert.strictEqual(heal.looksLikeModelMissing(new Error('ECONNREFUSED')), false);
  assert.strictEqual(heal.looksLikeModelMissing(new Error('LLM_FETCH_TIMEOUT_600s')), false);
  // 404 但不是模型问题 (路径写错) → 不自愈, 重试没意义
  assert.strictEqual(heal.looksLikeModelMissing(new Error('HTTP 404: Not Found')), false);
  assert.strictEqual(heal.looksLikeModelMissing(new Error(OMLX_404)), true);
});

test('S2 registry miss 也是同一个根因 (名字错 → registry 必然没有 → fail-loud)', () => {
  assert.strictEqual(
    heal.looksLikeModelMissing(
      new Error(
        'getModelContextLength: model context not discoverable ' +
          '(registry miss, probe failed or not run): mlx-community_qwen3.8-27b-4bit'
      )
    ),
    true
  );
});

test('S3 别的模型缺失形态也认 (503 no default / no models loaded)', () => {
  assert.strictEqual(heal.looksLikeModelMissing(new Error('HTTP 503: {"error":"No default model configured"}')), true);
  assert.strictEqual(heal.looksLikeModelMissing(new Error('HTTP 400: No models loaded. Please load a model.')), true);
});

test('S4 从 oMLX 的 404 正文里直接捞出正确名字, 不额外往返', () => {
  assert.deepStrictEqual(heal.parseAvailableFromError(new Error(OMLX_404)), ['Qwen3.8-27B-4bit']);
  assert.deepStrictEqual(heal.parseAvailableFromError(new Error('HTTP 401: Unauthorized')), []);
});

test('S5 规范化匹配: 端点用短名 / 池里带仓库前缀, 两个方向都要救得回来', () => {
  // 池里带前缀, 端点只认短名
  assert.strictEqual(
    heal.pickCorrectName('mlx-community_qwen3.8-27b-4bit', ['Qwen3.8-27B-4bit']),
    'Qwen3.8-27B-4bit'
  );
  // 池里是短名, 端点列的是带仓库前缀的
  assert.strictEqual(
    heal.pickCorrectName('Qwen3.8-27B-4bit', ['mlx-community/Qwen3.8-27B-4bit']),
    'mlx-community/Qwen3.8-27B-4bit'
  );
  // 大小写 / 分隔符差异
  assert.strictEqual(heal.pickCorrectName('ddalcu/ACE-Step-1.5-XL-Turbo-MLX-Serve-8bit', ['ddalcu/ACE-Step-1.5-XL-Turbo-MLX-Serve-8bit']), 'ddalcu/ACE-Step-1.5-XL-Turbo-MLX-Serve-8bit');
  // 完全对不上 → 端点挂了多个模型时不能瞎猜
  assert.strictEqual(heal.pickCorrectName('gpt-4', ['Qwen3.8-27B-4bit', 'llama-3']), null);
});

test('S6 端点只挂一个模型时, 它就是答案 (改名最常见的场景)', () => {
  assert.strictEqual(heal.pickCorrectName('mlx-community_qwen3.8-27b-4bit', ['Qwen3.8-27B-4bit']), 'Qwen3.8-27B-4bit');
  assert.strictEqual(heal.pickCorrectName('whatever-i-guessed', ['Qwen3.8-27B-4bit']), 'Qwen3.8-27B-4bit');
});

test('S7 名字本来就是对的 → 不自愈 (别制造无谓的改名)', async () => {
  assert.strictEqual(heal.pickCorrectName('Qwen3.8-27B-4bit', ['Qwen3.8-27B-4bit']), 'Qwen3.8-27B-4bit');
  const healed = await heal.healModelConfig(
    new Error(OMLX_404),
    { id: 'Qwen3.8-27B-4bit', api_model: 'Qwen3.8-27B-4bit' },
    () => ({ useModel: { id: 'Qwen3.8-27B-4bit', api_model: 'Qwen3.8-27B-4bit', endpoint: 'http://127.0.0.1:1' }, apiKey: '' })
  );
  assert.strictEqual(healed, null, '非 Promise 调用下救不了就该老实返回 null');
});

test('S8 规范化折叠对各种命名风格都稳', () => {
  // 分隔符差异 → 折叠后完全一致
  assert.strictEqual(heal.normalizeModelId('Qwen3.8-27B-4bit'), heal.normalizeModelId('qwen3_8_27b_4bit'));
  // 仓库前缀是"多出来的字符", 不是分隔符差异 —— 规范化后仍不等,
  // 所以只能靠 endsWith 那一档来救 (S5 覆盖)。
  assert.notStrictEqual(
    heal.normalizeModelId('mlx-community/Qwen3.8-27B-4bit'),
    heal.normalizeModelId('Qwen3.8-27B-4bit')
  );
});

test('S9 端点不可达时 fetchUpstreamIds 返回空数组而不是抛 (自愈不能变成新的失败源)', async () => {
  // 端口 1 必然连不上
  const ids = await heal.fetchUpstreamIds('http://127.0.0.1:1', 'k');
  assert.deepStrictEqual(ids, []);
});

test('S10 改名不许留下悬空的 current_model_id (否则静默退到别的模型)', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'modules', 'llm_caller.js'),
    'utf8'
  );
  // 反向保护: 池里条目改名后, 指向它的那条 current_model_id 必须一起改,
  // 否则 getCurrentModel 找不到 id 会退到 "enabled 第一个" —— 用户选的还是它,
  // 实际跑的是另一条模型, 且没有任何报错。
  assert.match(src, /current_model_id\s*===\s*oldId/,
    '改名逻辑里必须处理 current_model_id');
  assert.match(src, /current_model_id\s*=\s*healed\.id/,
    'current_model_id 必须指向新名字');
});
