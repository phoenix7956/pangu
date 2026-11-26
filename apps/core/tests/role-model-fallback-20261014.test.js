'use strict';

// role_model 模型解析 — 2026-10-17 语义**反转**。
//
// 旧语义 (2026-09-14 → 10-14), 老板当时逐字定的:
//   1. 子 agent 没有配置单独模型 → 直接用主模型
//   2. 配置了单独模型 → 用自己配置的那个          ← 这一条 10-17 作废
//   4. 主模型切换 → 子 agent 立刻跟上
//
// 新语义 (2026-10-17 老板拍): **子 agent 完全继承主模型**, 单独配模型这条路取消。
//
// 为什么反转 (这是本文件存在的理由, 别当成"少了个功能"):
//   子 agent 一旦跑在别的模型上, 主模型切换时它**不跟着切** —— 除非那条 override
//   恰好也被手工改掉。于是最常见的现场是: 主人把主模型切走, 子 agent 还钉在上一次
//   配的模型上跑, 慢、超时、答非所问, 而盘古自己完全看不出来。
//   2026-10-14 那次修的 bug 本身就是这条路的产物 (配的模型不在池里 → 静默退化成
//   全池 quality_score 最高的模型 → executor 悄悄跑到云端付费端点, 全程零提示)。
//   砍掉 override 之后"子 agent 跑在谁上面"的不确定性整个消失:
//   **只有一个答案** —— 主 agent 跑什么, 它就跑什么。
//
// 仍然按角色定的是**参数**不是模型: 温度 + 推理强度。换模型时它们跟着主模型一起走,
// 不产生"跑在谁上面"的分叉, 所以留着。

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveRoleModel } = require('../modules/role_model');
// 2026-10-18 拼音统一后 role_model 里不再有 ROLE_ID 映射表 (拼音就是唯一名字,
// 中间那层翻字典的映射整个消失了)。这里直接遍历身份真源 —— 覆盖范围和以前一样。
const {GUA_CODES} = require('../agents/gua-identity');
const ROLE_ID = Object.freeze(GUA_CODES.reduce((m, c) => (m[c] = c, m), {}));

// 复刻真实池 (apps/core/config/nodes/your-mac.json 的结构与取值)
function cfg() {
  return {
    llm: {
      current_model_id: 'main-local',
      models: [
        { id: 'main-local', tier: 'standard', quality_score: 0.85, provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234' },
        { id: 'cloud-fast', tier: 'fast', quality_score: 0.76, provider: 'kimi' },
        { id: 'cloud-smart', tier: 'smart', quality_score: 1.0, provider: 'minimax', endpoint: 'https://api.minimaxi.com/v1' },
        { id: 'off-model', tier: 'standard', quality_score: 0.9, provider: 'x', enabled: false },
      ],
      role_models: {},
    },
    agent: { role_configs: {} },
  };
}

const MAIN = () => cfg().llm.models[0];

// ── 核心: 八将灵全部无条件跟主模型 ────────────────────────────────────────
test('八将灵全部跟主模型', () => {
  const c = cfg();
  for (const role of Object.keys(ROLE_ID)) {
    const m = resolveRoleModel(c, role, MAIN());
    assert.equal(m.id, 'main-local', `${role} 应跟主模型`);
    assert.equal(m._role_model.locked_to_main, true, `${role} 应标记 locked_to_main`);
  }
});

// ── 作废的 override 路径必须**真的**不再生效 ──────────────────────────────
test('agent.role_configs[id].model 完全失效 (哪怕那个模型就在池里且 enabled)', () => {
  const c = cfg();
  c.agent.role_configs.kun = { model: 'cloud-fast' };   // kun = executor, 且 cloud-fast 在池里
  assert.equal(resolveRoleModel(c, 'kun', MAIN()).id, 'main-local',
    'per-role 模型字段已下线 —— 它在池里也不该被选中, 选了就等于 override 路径还活着');
});

test('llm.role_models 完全失效 (哪怕那个模型就在池里且 enabled)', () => {
  const c = cfg();
  c.llm.role_models.executor = 'cloud-smart';
  assert.equal(resolveRoleModel(c, 'kun', MAIN()).id, 'main-local',
    'llm.role_models 已下线 —— 同上, 池里存在也不该被选中');
});

test('role_models 对象形式 {model, temperature} 也不再改模型', () => {
  const c = cfg();
  c.llm.role_models.executor = { model: 'cloud-smart', temperature: 0.1 };
  const m = resolveRoleModel(c, 'kun', MAIN());
  assert.equal(m.id, 'main-local');
});

test('档位名 override (fast/smart/standard) 也不再改模型', () => {
  const c = cfg();
  c.agent.role_configs.kun = { model: 'fast' };
  assert.equal(resolveRoleModel(c, 'kun', MAIN()).id, 'main-local',
    '档位查找路径已删 —— 传档位名不该把子 agent 拉到那个档的模型上');
});

test('停用的模型也不该被选中 (enabled:false 与 override 无关)', () => {
  const c = cfg();
  c.agent.role_configs.kun = { model: 'off-model' };
  assert.equal(resolveRoleModel(c, 'kun', MAIN()).id, 'main-local');
});

// ── 主模型切换: 立刻跟上, 而且**不再有例外角色** ───────────────────────────
test('主模型切换 → 八将灵立刻全部跟上新主模型', () => {
  const c = cfg();
  const newMain = c.llm.models.find((m) => m.id === 'cloud-smart');
  for (const role of Object.keys(ROLE_ID)) {
    assert.equal(resolveRoleModel(c, role, newMain).id, 'cloud-smart', `${role} 应立刻跟到新主模型`);
  }
});

test('主模型切换 → 连"配过模型"的角色也不再例外 (旧语义在这里是分叉的根源)', () => {
  // 旧语义: 配了自己的角色切主模型时不动 → 这正是"子 agent 没马上关联上"的成因。
  // 新语义下**不存在**例外角色, 所以这条断言是这次反转的核心价值所在。
  const c = cfg();
  c.agent.role_configs.kun = { model: 'cloud-fast' };
  c.llm.role_models.executor = 'cloud-fast';
  const newMain = c.llm.models.find((m) => m.id === 'cloud-smart');
  for (const role of Object.keys(ROLE_ID)) {
    assert.equal(resolveRoleModel(c, role, newMain).id, 'cloud-smart',
      `${role} 必须跟新主模型 —— 旧的 "配了就例外" 分叉已经取消`);
  }
});

test('没传 mainModel 时回退全局 current_model_id', () => {
  const c = cfg();
  assert.equal(resolveRoleModel(c, 'kan').id, 'main-local');
  c.llm.current_model_id = 'cloud-smart';
  assert.equal(resolveRoleModel(c, 'kan').id, 'cloud-smart');
});

// ── synthesizer / dispatcher: 锁主模型 + 温度 0 + 不吃推理强度 ──────────────
test('synthesizer 与 dispatcher 锁主模型, 温度 0, 不吃 role_configs 的推理强度', () => {
  const c = cfg();
  c.llm.role_models.synthesizer = 'cloud-fast';
  c.agent.role_configs.qian = { model: 'cloud-fast', reasoning_effort: 'high' };
  const m = resolveRoleModel(c, 'synthesizer', MAIN());
  assert.equal(m.id, 'main-local');
  assert.equal(m.temperature, 0);
  assert.equal(m.reasoning_effort, undefined, '乾·大脑不吃将灵页推理强度');
  assert.equal(resolveRoleModel(c, 'dispatcher', MAIN()).id, 'main-local');
});

// ── 仍按角色定的参数 (这些是参数不是模型, 换模型时跟着主模型走) ─────────────
test('温度仍按角色职责定 (保留的是参数, 不是模型选择)', () => {
  const c = cfg();
  assert.equal(resolveRoleModel(c, 'kan', MAIN()).temperature, 0);
  assert.equal(resolveRoleModel(c, 'dui', MAIN()).temperature, 0);
  assert.equal(resolveRoleModel(c, 'kun', MAIN()).temperature, 0);
  assert.equal(resolveRoleModel(c, 'li', MAIN()).temperature, 0.2);
  assert.equal(resolveRoleModel(c, 'xun', MAIN()).temperature, 0.3);
  assert.equal(resolveRoleModel(c, 'zhen', MAIN()).temperature, 0.3);
  assert.equal(resolveRoleModel(c, 'gen', MAIN()).temperature, 0.2);
});

test('推理强度仍按将灵页 role_configs 定', () => {
  const c = cfg();
  c.agent.role_configs.kun = { reasoning_effort: 'low' };    // 卦 id, executor
  assert.equal(resolveRoleModel(c, 'kun', MAIN()).reasoning_effort, 'low');
  assert.equal(resolveRoleModel(c, 'kan', MAIN()).reasoning_effort, undefined,
    '没配的不许凭空长出 reasoning_effort');
});

test('kimi 端点温度强制 1.0 (角色温度 0 会被物理约束改掉)', () => {
  // 物理约束: k3/k3-256k/kimi-for-coding 只接受 temperature=1。
  // 角色温度 0 会绕过 _resolveTemperature 的 kimi 特判 (显式 temperature 优先级最高),
  // 导致 HTTP 400 → 子 agent 每轮全 400 → 0 工具调用。
  const c = cfg();
  const kimiMain = c.llm.models.find((m) => m.id === 'cloud-fast');
  assert.equal(resolveRoleModel(c, 'kun', kimiMain).temperature, 1.0);
});

// ── 不再有"配置没命中"这回事 ─────────────────────────────────────────────
test('模型副本上不再有 fallback_reason (没有 override 可配, 也就没有"没命中")', () => {
  const c = cfg();
  c.agent.role_configs.kun = { model: 'ghost-model-404' };
  const m = resolveRoleModel(c, 'kun', MAIN());
  assert.equal(m.id, 'main-local');
  assert.equal(m._role_model.fallback_reason, undefined,
    'override 路径已删 → "配的模型不在池里" 这个失败模式本身不存在了');
});

test('池里一个 enabled 模型都没有 → 返回 null, 绝不让子 agent 没模型跑', () => {
  const c = cfg();
  c.llm.models = [];
  assert.equal(resolveRoleModel(c, 'kun'), null,
    '既没有本次运行的主模型, 池里也没有可用模型 → 返回 null (调用方会回退上层默认)');
});

// ── 机制约束 (不是注释): role_model.js 不许再读那两个字段 ──────────────────
test('机制约束: role_model.js 不许再读 role_models / rc.model', () => {
  // 注释写"已下线"没用 —— 上面每个断言都是行为层的, 这里再钉一层源码形状:
  // 谁把 override 分支加回来, 这条会立刻红, 免得只靠人记得。
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../modules/role_model'), 'utf8');
  const body = src.slice(src.indexOf('function resolveRoleModel'));
  assert.doesNotMatch(body, /role_models/,
    'resolveRoleModel 里出现 role_models = override 路径还活着');
  assert.doesNotMatch(body, /rc\.model|rcModel/,
    'resolveRoleModel 里出现 rc.model = per-role 模型路径还活着');
});

// ── 真配置回归: 拿仓库里真实的 config/nodes/your-mac.json 跑一遍 ─────────
test('真实配置 your-mac.json: 八将灵全部跟主模型 (不再有"真配了的角色跳过")', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const p = require(path.join(__dirname, '..', 'config', 'node_config')).resolveNodeConfigPathOrExample();
  if (!fs.existsSync(p)) return;                       // 配置不在就跳过, 不让测试红
  const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  const main = (c.llm.models || []).find((m) => m.id === c.llm.current_model_id);
  if (!main) return;
  for (const role of Object.keys(ROLE_ID)) {
    // 旧版本这里有 `if (rc.model) continue;` —— "真配了的角色不参与断言"。
    // 新语义下没有任何角色可以例外, 所以那个豁免必须删掉, 否则这条断言是空的。
    assert.equal(resolveRoleModel(c, role, main).id, main.id, `${role} 应跟主模型 ${main.id}`);
  }
});
