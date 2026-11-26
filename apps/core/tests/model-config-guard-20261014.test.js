'use strict';

// 2026-10-14: 模型配置里"指向别的 id"的引用完整性闸。
// 现场 your-mac.json: fallback_id 和 fallback_chain 两条全是幽灵, role_models 全空。
// 后果不是"报错"而是"静默降级" —— 主模型一失败, 兜底链指向空气, 整轮死, 零报错。
const test = require('node:test');
const assert = require('node:assert');

const { checkModelConfig } = require('../modules/model_config_guard');

const M = (id, extra = {}) => Object.assign({ id, enabled: true }, extra);

test('S1 现场那种全幽灵兜底链 → 剔幽灵 + 自动重指向真实模型', () => {
  const cfg = {
    llm: {
      models: [M('agnes-3.0-flash'), M('minimax-m3'), M('qwen3.8-27b-mlx')],
      current_model_id: 'qwen3.8-27b-mlx',
      fallback_id: 'google_gemma-4-26b-a4b-qat',
      fallback_chain: ['google_gemma-4-26b-a4b-qat', 'qwen_qwen3.6-35b-a3b'],
      role_models: {},
    },
  };
  const r = checkModelConfig(cfg, { apply: true });
  assert.strictEqual(r.dangling.length >= 1, true, '幽灵引用要报出来');
  assert.deepStrictEqual(cfg.llm.fallback_chain, ['agnes-3.0-flash'], '幽灵剔干净, 补一条真的替补');
  assert.strictEqual(cfg.llm.fallback_id, 'agnes-3.0-flash');
  assert.ok(r.warnings.some((w) => w.includes('兜底链全是幽灵')));
});

test('S2 current_model_id 悬空只报不修 —— 那是用户的显式选择, 轮不到代码替用户改', () => {
  const cfg = {
    llm: { models: [M('a'), M('b')], current_model_id: 'ghost-model', fallback_chain: ['a'] },
  };
  const before = cfg.llm.current_model_id;
  const r = checkModelConfig(cfg, { apply: true });
  assert.strictEqual(cfg.llm.current_model_id, before);
  assert.strictEqual(r.dangling.some((d) => d.field === 'llm.current_model_id'), true);
  assert.ok(r.warnings.some((w) => w.includes('enabled 第一个')));
});

test('S3 role_models 整个删掉 (2026-10-17: 死字段, 不只是悬空的那几条)', () => {
  // 旧语义: 只剔悬空引用, 配得好好的 kan:'a' 留着 (它当时确实生效)。
  // 新语义: 子 agent 无条件继承主模型 → role_model.js 一个字都不读它 →
  //          **在不在池里都一样是死的**, 所以整个字段删掉, 不留"这次恰好对"。
  const cfg = {
    llm: {
      models: [M('a'), M('b')],
      current_model_id: 'a',
      fallback_chain: ['b'],
      role_models: { kan: 'a', kun: 'deleted-model' },
    },
  };
  const r = checkModelConfig(cfg, { apply: true });
  assert.ok(!('role_models' in cfg.llm), 'role_models 应整个消失, 包括指得到的那条');
  assert.ok(r.warnings.some((w) => /role_models/.test(w) && /继承主模型|失效|删除/.test(w)));
});

test('S3b role_configs[*].model 也删掉 (设置·将灵页那个下拉框下线了)', () => {
  const cfg = {
    llm: {
      models: [M('a'), M('b')],
      current_model_id: 'a',
      fallback_chain: ['b'],
    },
    agent: {
      role_configs: {
        kun: { model: 'b', reasoning_effort: 'low', max_tool_iterations: 80 },
        kan: { model: 'ghost-404' },
        li: { reasoning_effort: 'medium' },
      },
    },
  };
  const r = checkModelConfig(cfg, { apply: true });
  assert.ok(!('model' in cfg.agent.role_configs.kun), 'kun.model 要删');
  assert.ok(!('model' in cfg.agent.role_configs.kan), 'kan.model 要删, 哪怕指向幽灵');
  assert.ok(!('model' in cfg.agent.role_configs.li), '本来就没有也不能长出来');
  // 关键: 只删 model 这一个死字段, 同级的活字段一个都不许动
  assert.strictEqual(cfg.agent.role_configs.kun.reasoning_effort, 'low');
  assert.strictEqual(cfg.agent.role_configs.kun.max_tool_iterations, 80);
  assert.strictEqual(cfg.agent.role_configs.li.reasoning_effort, 'medium');
  assert.ok(r.fixed.some((f) => /role_configs\[\*\]\.model/.test(f.field)));
});

test('S3c apply:false 时只报不动 (死字段体检模式不许改配置)', () => {
  const cfg = {
    llm: { models: [M('a'), M('b')], current_model_id: 'a', fallback_chain: ['b'], role_models: { kun: 'b' } },
    agent: { role_configs: { kun: { model: 'b', reasoning_effort: 'low' } } },
  };
  const snap = JSON.stringify(cfg);
  const r = checkModelConfig(cfg, { apply: false });
  assert.strictEqual(JSON.stringify(cfg), snap, 'apply:false 下配置一个字都不能动');
  assert.ok(r.warnings.some((w) => /role_models/.test(w)), '要报出来');
  assert.ok(r.warnings.some((w) => /role_configs\[\*\]\.model/.test(w)), '要报出来');
});

test('S4 role_models 全空 / 不存在 = 合法默认, 不该被念叨', () => {
  const cfg = {
    llm: { models: [M('a'), M('b')], current_model_id: 'a', fallback_chain: ['b'], role_models: {} },
  };
  const r = checkModelConfig(cfg, { apply: true });
  assert.strictEqual(r.dangling.length, 0, '全空不算悬空引用');
  assert.strictEqual(r.warnings.length, 0, '默认行为不该每次开机都被提醒一遍');
});

test('S5 健康配置零误报零改动', () => {
  // 2026-10-17: "健康配置"的形状也跟着变了 —— role_models / role_configs[*].model
  // 是死字段, 出现在"健康"配置里本身就是不健康, 所以这个 fixture 不再带它们。
  const cfg = {
    llm: {
      models: [M('a'), M('b')],
      current_model_id: 'a',
      fallback_id: 'b',
      fallback_chain: ['b'],
    },
  };
  const snap = JSON.stringify(cfg);
  const r = checkModelConfig(cfg, { apply: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dangling.length, 0);
  assert.strictEqual(r.warnings.length, 0);
  assert.strictEqual(JSON.stringify(cfg), snap, '健康配置一个字都不能动');
});

test('S6 apply:false 只体检不落手', () => {
  const cfg = {
    llm: { models: [M('a')], current_model_id: 'a', fallback_chain: ['ghost'] },
  };
  const r = checkModelConfig(cfg, { apply: false });
  assert.deepStrictEqual(cfg.llm.fallback_chain, ['ghost'], 'apply:false 下不许改');
  assert.ok(r.warnings.some((w) => w.includes('没有一条指向真实模型')));
});

test('S7 current_model_id 存在但 enabled=false → 报出来 (它不会被选中)', () => {
  const cfg = {
    llm: {
      models: [M('a', { enabled: false }), M('b')],
      current_model_id: 'a',
      fallback_chain: ['b'],
    },
  };
  const r = checkModelConfig(cfg, { apply: true });
  assert.ok(r.warnings.some((w) => w.includes('enabled=false')));
});

test('S8 兜底修完不能挑中主模型自己 (兜底的意义是"主模型挂了还能出活")', () => {
  const cfg = {
    llm: { models: [M('a'), M('b')], current_model_id: 'a', fallback_chain: ['ghost1', 'ghost2'] },
  };
  checkModelConfig(cfg, { apply: true });
  assert.ok(!cfg.llm.fallback_chain.includes('a'));
});

test('S9 llm.models 缺失/非数组 → 明确报, 不假装校验通过', () => {
  const r = checkModelConfig({ llm: { models: 'nope' } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.warnings[0].includes('llm.models'));
});

