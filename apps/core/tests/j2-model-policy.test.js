'use strict';

const assert = require('assert');
const { test } = require('node:test');
const policy = require('../modules/j2_model_policy');

// 2026-10-17 修订: silentFailFallback 默认从 false 改成 **true**。
//
// 这条默认值以前是 false, 而它当时把整段 model-chain switch 挡成了死代码 ——
// 加上 message-stream 传的是字面量 `_modelChain: []` (双重死锁), 主人的
// llm.fallback_chain 双重不可达。于是: 主模型一哑火整轮直接死, 池子里配了几个
// 兜底都不起作用, 而 model_config_guard 每次启动还在校验并"修好"那条没人读的链。
//
// 为什么改默认值是安全的 —— 第一道闸门是**链非空**:
//   · 没配 fallback_chain → 链为空 → 一个模型都不会换, 行为与改动前逐字节一致
//   · 配了 → 主人已经显式表达过"哑了就用这些", 切换是他的配置, 不是盘古自作主张
// 而 autoModelSelection (每次请求替主人挑模型) 仍然**硬关**, 2026-09-07
// 「关了自动选择, 现在还不成熟」那条产品决定一个字没动 —— 下面第 2 条继续钉着它。
//
// env 逃生阀保留且变成真能用的开关: PANGU_SILENT_FAIL_FALLBACK=0 立刻全关。
// 「默认值」和「可关」是两件事, 不该用一条恒 false 把整个功能埋掉。
test('model policy: 自动选模型仍默认关, 故障转移默认开但可 env 关, 降权默认关', () => {
  assert.deepStrictEqual(policy.getModelPolicy({}), {
    autoModelSelection: false,
    silentFailFallback: true,
    routerDemote: false,
  });
});

test('manual selection cannot be overridden by legacy routing env values', () => {
  // 自动选模型: 无论 env 怎么写都是 false —— 2026-09-07 的产品决定, 不可被 env 推翻。
  assert.deepStrictEqual(policy.getModelPolicy({
    PANGU_AUTO_MODEL_SELECTION: 'true',
    PANGU_SILENT_FAIL_FALLBACK: 'on',
    PANGU_ROUTER_DEMOTE: '1',
  }), {
    autoModelSelection: false,
    silentFailFallback: true,
    routerDemote: true,
  });
  assert.deepStrictEqual(policy.getModelPolicy({
    PANGU_AUTO_MODEL_SELECTION: '0',
    PANGU_SILENT_FAIL_FALLBACK: 'off',
    PANGU_ROUTER_DEMOTE: 'false',
  }), {
    autoModelSelection: false,
    silentFailFallback: false,
    routerDemote: false,
  });
});

test('invalid env values use the safe default', () => {
  assert.strictEqual(policy.parseFlag('maybe', false), false);
  assert.strictEqual(policy.parseFlag('maybe', true), true);
});

test('故障转移开关是可观察的运行时逃生阀, 不是恒 false 的墓碑', () => {
  assert.strictEqual(policy.isSilentFailFallbackEnabled({}), true, '默认开');
  for (const v of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      policy.isSilentFailFallbackEnabled({ PANGU_SILENT_FAIL_FALLBACK: v }), false,
      'PANGU_SILENT_FAIL_FALLBACK=' + v + ' 必须能关掉 (不必改代码发版)'
    );
  }
  for (const v of ['1', 'true', 'on', 'yes']) {
    assert.strictEqual(
      policy.isSilentFailFallbackEnabled({ PANGU_SILENT_FAIL_FALLBACK: v }), true,
      '显式开也要认'
    );
  }
  // 自动选模型没有任何逃生阀 —— 它是产品不变量, 不是开关。
  for (const v of ['1', 'true', 'on', 'yes']) {
    assert.strictEqual(
      policy.isAutoModelSelectionEnabled({ PANGU_AUTO_MODEL_SELECTION: v }), false,
      '自动选模型不认 env'
    );
  }
});
