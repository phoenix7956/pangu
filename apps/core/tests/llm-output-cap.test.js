'use strict';

// Regression: context_length is a total window, never an output budget.
// A local 262K model previously received max_tokens ~= 254K and appeared hung
// while reasoning. The generic caller must use a bounded default unless the
// model or provider declares a stricter limit.
const assert = require('assert');
const caller = require('../modules/llm_caller');

const local = { id: 'local-qwen', provider: 'lmstudio', context_length: 262144 };
assert.strictEqual(caller._maxTokensCap(local), 8192);

const smallWindow = { id: 'small-local', provider: 'lmstudio', max_tokens: 16384 };
assert.strictEqual(caller._maxTokensCap(smallWindow), 16384);

const explicit = { id: 'explicit-local', provider: 'lmstudio', context_length: 262144, max_tokens: 8192 };
assert.strictEqual(caller._maxTokensCap(explicit), 8192);
assert.strictEqual(caller._wireReasoningEffort({ provider: 'lmstudio', reasoning_effort: 'off' }), 'none');
assert.strictEqual(caller._wireReasoningEffort({ provider: 'minimax', reasoning_effort: 'off' }), 'off');

const minimax = { id: 'minimax-test', provider: 'minimax', context_length: 1048576 };
// 2026-10-27 复测 (第 112 批): 16384 这条是 2026-09-10 的旧数据, 已过期 ——
// 直连 api.minimaxi.com 实测 16384/32768/65536/131072 全部 200。
// 旧值的后遗症: 推理模型 (MiniMax-M3.1-Flash) 的思考要吃掉 2.5 万 token,
// 输出预算卡在 16384 ⇒ 正文一个字都写不出来 (2026-10-26 现场)。
assert.strictEqual(caller._maxTokensCap(minimax), 32768);

const relay = { id: 'relay-test', provider: 'custom', endpoint: 'http://127.0.0.1:9000/v1' };
assert.strictEqual(caller._maxTokensCap(relay), 8192);

console.log('llm-output-cap: PASS');
