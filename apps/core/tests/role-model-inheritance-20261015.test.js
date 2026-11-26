'use strict';

// 2026-10-15: 老板原始清单里的第 1 条和第 4 条。
//
//   1. 子 agent 没有配置单独模型时, 直接用主模型; 配置了单独模型就用自己配置的。
//   4. 子 agent 没有单独配置时, 主模型切换后子 agent 要**马上**跟上, 不能 lagging 一轮。
//
// 2026-10-17 第 1 条后半句作废: 子 agent 现在**无条件**继承主模型, 单独配模型这条路
// 取消了 (见 role-model-fallback-20261014.test.js 里的反转理由)。第 4 条不但还在,
// 而且从"没单独配置的才要跟上"变成"**所有**角色都要跟上, 一个例外都没有"。
//
// 这两条当时的实现是散的:
//   - modules/role_model.js  resolveRoleModel(cfg, role, mainModel) 三级回退
//   - agents/sub-agent.js    run({ mainModel }) 把它透传进去
//   - modules/j2_dispatcher.js 5 个 spawn 点各传一次 mainModel
//   - loadConfig 每次现读文件 (无缓存) —— 这是"切换后立刻跟上"的前提
// 任何一环断了都会静默退化成"跑到池里随便一个模型", 所以这里按**行为**锁, 不按源码形状锁。

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const { resolveRoleModel } = require(path.join(ROOT, 'modules', 'role_model'));

const ROLES = ['planner', 'analyzer', 'executor', 'checker', 'bug_hunter', 'reflector', 'learner'];

// 合成配置 — 不依赖老板机器上的真实 config/nodes/*.json, 测试才可复现
function mkCfg(current, extra = {}) {
  return {
    llm: {
      current_model_id: current,
      models: [
        { id: 'main-model', provider: 'lmstudio', enabled: true, quality_score: 0.9 },
        { id: 'other-model', provider: 'kimi', enabled: true, quality_score: 0.8 },
      ],
      ...(extra.llm || {}),
    },
    agent: { role_configs: extra.role_configs || {} },
  };
}

test('R1 没有单独配置时, 每个角色都跟主模型', () => {
  const cfg = mkCfg('main-model');
  for (const r of ROLES) {
    const m = resolveRoleModel(cfg, r, null);
    assert.ok(m, r + ' 必须解析出模型, 不能让子 agent 没模型跑');
    assert.strictEqual(m.id, 'main-model', r + ' 无单独配置时应跟主模型, 实际 ' + m.id);
  }
});

test('R2 作废的 override 路径: 配了也**不用** (语义已于 2026-10-17 反转)', () => {
  // 设置·将灵页 per-role model 写的是八卦 id (executor -> kun), 不是角色英文名。
  // 这条断言现在是"反面护栏": 旧语义下它断言 `other-model`, 谁不小心把 override
  // 分支加回来, 它会立刻红 —— 而不是等到实机才发现子 agent 又跑偏了。
  const cfg = mkCfg('main-model', { role_configs: { kun: { model: 'other-model' } } });
  const m = resolveRoleModel(cfg, 'executor', null);
  assert.strictEqual(m.id, 'main-model', 'executor 配了 other-model 也不该用它 —— override 已下线');
  assert.strictEqual(m._role_model.locked_to_main, true);
  // 其它角色同样不受影响
  assert.strictEqual(resolveRoleModel(cfg, 'planner', null).id, 'main-model');
});

test('R2b llm.role_models 这条 override 通道同样下线 (池里存在也不生效)', () => {
  const cfg = mkCfg('main-model', { llm: { role_models: { executor: 'other-model' } } });
  for (const r of ROLES) {
    assert.strictEqual(resolveRoleModel(cfg, r, null).id, 'main-model',
      r + ': llm.role_models 已失效, 不该把子 agent 拉到别的模型上');
  }
});

test('R3 主模型切换后, 子 agent 立刻跟上 (不 lagging)', () => {
  // 老板原话: "子agent模型没有单独配置时, 主模型切换, 子agent没有马上关联上"
  // 关键在 resolveRoleModel 每次现读 cfg.llm.current_model_id —— 只要不缓存就天然跟上。
  const cfg = mkCfg('main-model');
  assert.strictEqual(resolveRoleModel(cfg, 'executor', null).id, 'main-model');
  // 模拟切换
  cfg.llm.current_model_id = 'other-model';
  for (const r of ROLES) {
    assert.strictEqual(resolveRoleModel(cfg, r, null).id, 'other-model',
      r + ' 在主模型切换后必须立刻改用新主模型');
  }
});

test('R4 本次运行传入的 mainModel 优先于全局 current (多轮之间不串味)', () => {
  // j2_dispatcher 每次 spawn 都传本次运行的 model; 它该压过全局值,
  // 否则一次运行中途切了全局配置, 同一轮里的子 agent 会分裂成两个模型。
  const cfg = mkCfg('other-model');
  const runModel = { id: 'main-model', provider: 'lmstudio', enabled: true };
  for (const r of ROLES) {
    assert.strictEqual(resolveRoleModel(cfg, r, runModel).id, 'main-model',
      r + ' 应跟随本次运行的主模型');
  }
});

test('R5 配了已下线的模型时只能回主模型 (2026-10-17: 这条失败模式已从根上消失)', () => {
  // 2026-10-14 现场: executor 配了个池里没有的模型, 静默退化成 quality_score 最高的
  // minimax-m3 (云端付费端点), 全程无提示 —— 静默烧额度 + 答非所问。
  // 现在的语义更简单: 既然没有 override, "配的模型在不在池里"这个问题根本不存在,
  // 结果只可能是主模型。fallback_reason 也随之没有了 (没东西可 miss)。
  const cfg = mkCfg('main-model', { role_configs: { kun: { model: 'ghost-model-404' } } });
  const m = resolveRoleModel(cfg, 'executor', null);
  assert.strictEqual(m.id, 'main-model');
  assert.strictEqual(m._role_model.fallback_reason, undefined,
    '没有 override 可配 → 不存在"没命中", 不该再有 fallback_reason');
});

test('R6 机制约束: loadConfig 每次现读, 不许加缓存', () => {
  // 这是 R3 能成立的前提。一旦加了进程级缓存, 主模型切换就要等缓存过期才生效,
 // 正是老板说的"没有马上关联上"。把它钉死在这里, 免得有人顺手"优化"回去。
  const src = fs.readFileSync(path.join(ROOT, 'agents', 'sub-agent.js'), 'utf8');
  const i = src.indexOf('function loadConfig');
  assert.ok(i > 0, '要能找到 loadConfig');
  const seg = src.slice(i, i + 400);
  assert.match(seg, /readFileSync\(configPath, 'utf8'\)/,
    'loadConfig 必须现读配置文件');
  assert.ok(!/cache|memo|let _cached/i.test(seg),
    'loadConfig 不许加缓存 —— 缓存会让主模型切换延迟生效 (老板原始清单第 4 条)');
});

test('R7 dispatcher 的每个 spawn 点都要传 mainModel', () => {
  // 少传一个 = 那条路径上的子 agent 永远跟主模型切换脱钩。
  const src = fs.readFileSync(path.join(ROOT, 'modules', 'j2_dispatcher.js'), 'utf8');
  const runs = src.match(/subAgent\.run\(\{/g) || [];
  const withMain = src.match(/mainModel:\s*model/g) || [];
  assert.ok(runs.length > 0, '要能找到 subAgent.run 调用');
  assert.strictEqual(withMain.length, runs.length,
    runs.length + ' 个 spawn 点里只有 ' + withMain.length +
    ' 个传了 mainModel — 漏传的那个路径上子 agent 不会跟随主模型切换');
});

