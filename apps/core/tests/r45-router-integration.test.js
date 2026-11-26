'use strict';

// Legacy router modules remain available for configuration tooling, but the
// production chat paths must retain the explicitly selected current model.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const ROUTES_DIR = path.join(ROOT, 'pangu-single', 'routes');
const policy = require(path.join(ROOT, 'modules', 'j2_model_policy'));
const LLM_CALLER = require(path.join(ROOT, 'modules', 'llm_caller'));

function readUtf8(file) {
  return fs.readFileSync(file, 'utf8');
}

test('message-stream uses the manually selected current model', () => {
  const source = readUtf8(path.join(ROUTES_DIR, 'message-stream.js'));
  // Explicit picker selection wins; requests without an override use the
  // persisted current model. Both paths must feed the same model copy.
  assert.ok(source.includes("const _requestedModelId = typeof req_body.model === 'string'"), 'stream must accept an explicit model id');
  assert.ok(source.includes(': getDefaultModel();'), 'stream must fall back to current_model_id');
  assert.ok(source.includes('const model = _baseModel ? { ..._baseModel, reasoning_effort: _effort } : _baseModel;'), 'model must derive only from the manually selected base model');
  assert.ok(!source.includes('smartRoute('), 'stream must not invoke smart routing');
  assert.ok(!source.includes('router_forced'), 'stream must not accept model-routing overrides');
});

test('message-stream resumes interrupted J2 work only for continuation input', () => {
  const source = readUtf8(path.join(ROUTES_DIR, 'message-stream.js'));
  assert.ok(source.includes("const resumeCheckpoint = userInput.includes('【续跑约束】');"));
  assert.ok(source.includes('resumeCheckpoint,',), 'continuation flag must reach J2');
});

test('non-J2 caller keeps a manual-current-model fast path', () => {
  assert.equal(typeof LLM_CALLER.callLLMRouter, 'function');
  const source = readUtf8(path.join(ROOT, 'modules', 'llm_caller.js'));
  assert.ok(source.includes('if (!isAutoModelSelectionEnabled()) {'));
  assert.ok(source.includes('const selected = getDefaultModel();'));
});

test('legacy env cannot re-enable AUTO SELECTION (自动选模型是不可被 env 推翻的产品不变量)', () => {
  // 2026-10-17 修订: 这条原本还顺带把 silentFailFallback 也钉成 env 无效。
  // 故障转移现在默认开、PANGU_SILENT_FAIL_FALLBACK=0 可关 —— 它是一个**可观察的
  // 逃生阀**, 不再是恒 false 的墓碑 (恒 false 曾把 chain-switch 挡成死代码)。
  // 这里真正要守的不变量是 autoModelSelection: 无论 env 写什么, 盘古都绝不替主人
  // 自动挑模型 —— 2026-09-07 老板拍「关了自动选择, 现在还不成熟」。
  const p = policy.getModelPolicy({
    PANGU_AUTO_MODEL_SELECTION: 'true',
    PANGU_SILENT_FAIL_FALLBACK: 'true',
  });
  assert.strictEqual(p.autoModelSelection, false,
    '自动选模型必须永远为 false, 不受任何 env 影响');
  // 兜底链默认开, 但第一道闸门是「链非空」: 没配 fallback_chain 就一个模型都不换。
  assert.strictEqual(p.silentFailFallback, true);
  // 逃生阀: env 能把它关掉。
  assert.deepStrictEqual(policy.getModelPolicy({
    PANGU_SILENT_FAIL_FALLBACK: 'false',
  }), {
    autoModelSelection: false,
    silentFailFallback: false,
    routerDemote: false,
  });
});
