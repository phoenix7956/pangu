// modules/role_model.js — 2026-09-14 立, 2026-10-17 改: 子 agent **无条件**继承主模型
//
// 2026-09-14 → 10-14 的原设计是"八将灵按角色走不同档位, 还能单独配模型":
//   config.llm.role_models = { executor: 'smart' | '<model_id>', ... }
//   config.agent.role_configs[八卦id].model = '<model_id>'   ← 设置·将灵页 UI 写
// 2026-10-17 老板拍: **去掉这条路**, 子 agent 完全继承主模型。
//
// 为什么砍 (不是"少个功能", 是那条路本身在制造故障):
//   子 agent 一旦跑在别的模型上, 主模型切换时它**不跟着切** —— 除非那条 override
//   恰好也被改掉。于是最常见的现场是: 主人把主模型切到 minimax, 子 agent 还钉在
//   上一次配的模型上跑, 慢、超时、答非所问, 而且盘古自己看不出来。
//   10-14 那次修的 bug 就是这条路的产物 (配的模型不在池里 → 静默退化成全池
//   quality_score 最高的模型 → executor 悄悄跑到云端付费端点, 全程零提示)。
//   砍掉 override 之后这类"子 agent 跑在谁上面"的不确定性**整个消失**:
//   子 agent 跑什么模型只有一个答案 —— 主 agent 跑什么它就跑什么。
//
// 保留的仍然按角色定: 温度 (职责不同容错不同) + 推理强度 (将灵页 role_configs)。
// 这两个是**参数**不是**模型**, 换模型时会跟着主模型一起走, 不产生"跑在谁上面"
// 的分叉。档位 (tier) 相关的查找逻辑随之一起删掉 —— 没有 override 就没有档位可选。
'use strict';

// 2026-10-25 第 98 批: 模型能力真源 (温度锁等) —— 代码只读能力, 不认品牌。
const _modelCapability = require('./model_capability');

// 默认角色 → 温度 (2026-09-14 老板纠偏: 不是一刀切 0, 按各将灵实际职责定)
// 温度逻辑: 严格结构化输出 (JSON/pass-fail/改文件) = 0 容错低; 分析/找茬/复盘需要联想 = 给 0.2~0.3 发散空间
const ROLE_TIER = {
  // 2026-10-18 (身份统一): 键换成拼音。**这张表之前整张是死的** ——
  // 角色早就按拼音派了 (ROLES.li / ROLES.xun ...), 查 `ROLE_TIER['li']` 恒为
  // undefined, 于是 `|| { temperature: 0 }` 把**每一个**将灵都兜成温度 0:
  // 离该 0.2、巽该 0.3、震该 0.3、艮该 0.2, 全被压成 0。
  //
  // 不报错的理由很朴素: 温度 0 恰好也是兜底值, 所以每个角色都"看起来正常",
  // 只是四个该发散的角色变成了不许发散。发散度正是找 bug / 复盘 / 提炼的命根子。
  // 改名那一刻这张表就死了, 而唯一钉住它的测试传的是英文 role ('analyzer'),
  // 读的还是英文键 —— 守卫和被守卫一起错开, 于是全绿。
  kan:    { temperature: 0 },   // 输出必须是合法 JSON, 一个乱字全链崩
  kun:    { temperature: 0 },   // 写码/改文件/跑命令, 精确第一
  dui:    { temperature: 0 },   // pass/fail + 证据, 不许发挥
  li:     { temperature: 0.2 }, // 证据驱动但需要归纳
  xun:    { temperature: 0.3 }, // 找 bug 要发散联想, 太死板漏边角
  gen:    { temperature: 0.2 }, // 提炼经验, 适度归纳
  zhen:   { temperature: 0.3 }, // 复盘要能看到不同角度
  qian:   { temperature: 0 },   // 同 kan, JSON 输出
};

// 未显式配 quality_score 的模型用这个默认分 (2026-10-14 单一真源)。
// pangu_helpers.syncRouterModelsFromConfig 写 router/models.json 时也用这个值 ——
// 旧代码那边兜底用的是 (priority||50)/100, 导致同一个模型在 router 里 1.0 分、
// 在这里 0.7 分, 两套子系统排序打架。现在两边读同一个常量。
const DEFAULT_QUALITY_SCORE = 0.7;

function _currentModel(cfg) {
  const models = (cfg && cfg.llm && Array.isArray(cfg.llm.models)) ? cfg.llm.models : [];
  const enabled = models.filter(m => m.enabled !== false);
  if (!enabled.length) return null;
  const id = cfg.llm.current_model_id;
  if (id) { const cur = enabled.find(m => m.id === id); if (cur) return cur; }
  return enabled.sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
}

// 角色名 → 卦条目。身份只有一个名字 (拼音), role_configs 的键就是它 —— 中间不再有任何
// 映射表。以前这里手抄过一张英文→拼音的 ROLE_ID, 那张表是"两个真名"的产物:
// 配置层用拼音、ROLES 用英文, 于是每个读配置的地方都得先翻一遍字典。
// 拼音统一后这层映射消失了, 直接查。
function roleConfig(cfg, role) {
  const id = require('../agents/gua-identity').resolveRole(role);
  const rc = cfg && cfg.agent && cfg.agent.role_configs;
  return (id && rc && rc[id]) || {};
}

// 返回模型副本 (不污染池里原对象): 温度按角色职责定 (见 ROLE_TIER 注释), 不一刀切
// 推演强度优先级: 将灵页 role_configs.reasoning_effort > 模型自带 > 不设(走请求档/auto 分类)
// 2026-10-14 修 (切换模型后子 agent 没跟上): 主请求可以带显式 model (前端 picker 下发,
// 走 req_body.model), 主循环用它; 但"跟随主模型"的子 agent 原先只读全局 llm.current_model_id ——
// 两者分叉时(前端 pickedModelId localStorage 态 vs 后端全局)子 agent 仍用旧模型 -> 超时/答非所问。
// mainModel = 本次运行实际用的主模型 (由调用方传入); 没传才回退全局 current_model_id。
//
// 2026-10-17: 整段 override 解析 (role_models / role_configs[id].model / tier 查找 /
// _cfgMiss 静默降级告警) 全部删除。子 agent 的模型**只有一个来源**: 本次运行的主模型。
// 机制约束(不是注释): 下面 return 里没有任何一条分支会读 cfg.llm.role_models
// 或 rc.model —— 想给某个将灵单独换模型, 现在唯一的办法是改这段代码, 而不是改配置。
function resolveRoleModel(cfg, role, mainModel) {
  if (!cfg) return null;
  // 归一: role 从模型/日志/旧脚本流进来, 用哪种写法不由这张表决定。
  const _canonRole = require('../agents/gua-identity').resolveRole(role);
  const roleDef = ROLE_TIER[_canonRole] || ROLE_TIER[role] || { temperature: 0 };
  // 继承主模型 = 本次运行的 mainModel (优先) → 全局 current_model_id (兜底)
  const model = (mainModel && typeof mainModel === 'object' && mainModel.id) ? mainModel : _currentModel(cfg);
  if (!model) return null;
  const rc = roleConfig(cfg, role);
  // 2026-09-19 老板拍 (现在已无 override 可忽略, 但语义保留): 乾·大脑(qian)
  // = 主模型专属, 温度 0 (收口要精确), 无 reasoning_effort。
  //
  // 2026-10-18: 这行原来判的是 'synthesizer' || 'dispatcher'。角色换成拼音以后 role 是
  // 'qian', 两个判断都不成立 → 乾**悄悄拿回 roleDef.temperature**。收口温度不再锁 0,
  // 而且不报错 —— 这就是"不统一就出错"最便宜的一种: 改个名字, 一条业务规则悄悄失效。
  const isSynth = role === 'qian';
  const temp = isSynth ? 0 : roleDef.temperature;
  // 2026-10-13: kimi 编码端点 (k3/k3-256k/kimi-for-coding) 只接受 temperature=1,
  // 角色温度 0 (executor/planner/checker) 会绕过 _resolveTemperature 的 kimi 特判 (显式 temperature 优先级最高),
  // 导致 HTTP 400 "invalid temperature: only 1 is allowed" → 子 agent 每轮全 400 → 0 工具调用。
  //
  // 2026-10-25 第 98 批: 这里是**第三份** kimi 特判副本, 判定条件跟前两份还不完全一样
  // (这份用 model.name, llm_caller 那份用 model.api_model)。
  // ⇒ 同一个模型在不同代码路径可能被判成"不同厂商" ⇒ 行为不一致。
  // 现在统一走能力真源: "端点锁死温度" 是**能力**, 不是品牌。
  // 温度意图 = 角色自己的温度 (executor/planner/checker 是 0, 乾是 0);
  // 端点物理锁死时锁死值压过意图 (kimi 编码端点只收 1.0, 传 0 直接 400)。
  const _effectiveTemp = _modelCapability.temperatureFor(model, temp);
  const out = { ...model, temperature: _effectiveTemp, _role_model: { role, tier: model.tier || null, locked_to_main: true } };
  // 将灵页配的推演强度挂到副本上 (auto = 删, 走任务分类)
  if (!isSynth && ['low', 'medium', 'high'].includes(rc.reasoning_effort)) out.reasoning_effort = rc.reasoning_effort;
  return out;
}

module.exports = { resolveRoleModel, roleConfig, ROLE_TIER, DEFAULT_QUALITY_SCORE };
