'use strict';

// Runtime policy for model failover. Read env on each call so launchd/env
// changes are observable without relying on module-load order in tests.
function parseFlag(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  return defaultValue;
}

function isSilentFailFallbackEnabled(env = process.env) {
  // 2026-10-17: 默认**开**。
  //
  // 它以前恒 false, 理由是「fallback 会在主人没明确选择时换掉模型」。但那个理由
  // 针对的是**自动选模型**, 与故障转移是两件事, 当时被混成一个开关, 结果把
  // j2_agent_loop 的 chain-switch 一起挡成了死代码 —— 而那条链在生产路径上还是
  // 字面量 `_modelChain: []`, 于是主人的 llm.fallback_chain 双重不可达。
  //
  // 现在两件事拆开:
  //   · 自动选模型 (每次请求替主人挑一个) —— 仍然硬关, 见 isAutoModelSelectionEnabled
  //   · 故障转移 (主人配的链只在当前模型**已经哑火之后**才轮到) —— 默认开,
  //     而且第一个条件永远是「链非空」: 没配兜底链就一个模型都不会换。
  //
  // 于是这个 env 第一次成为**真能用的逃生阀** (PANGU_SILENT_FAIL_FALLBACK=0
  // 立刻关掉, 不必改代码发版), 而不是恒 false 的墓碑。
  // r24-router-flags.test.js 钉的就是"开关运行时可观察"这件事, 一直是对的。
  return parseFlag(env.PANGU_SILENT_FAIL_FALLBACK, true);
}

function isAutoModelSelectionEnabled(env = process.env) {
  // Manual model selection is a product invariant. Keep the legacy env
  // readable for diagnostics, but never let it silently reroute a request.
  return false;
}

function isRouterDemoteEnabled(env = process.env) {
  return parseFlag(env.PANGU_ROUTER_DEMOTE, false);
}

function getModelPolicy(env = process.env) {
  return {
    autoModelSelection: isAutoModelSelectionEnabled(env),
    silentFailFallback: isSilentFailFallbackEnabled(env),
    routerDemote: isRouterDemoteEnabled(env),
  };
}

// 2026-10-17: 故障转移链的唯一真源构造点。
//
// 修的是什么 (老板现场: 「池里本地模型只剩一个 27B 不够分」→ 主模型一哑火整轮死):
//   `fallback_chain` 在配置里配了, model_config_guard 每次启动还校验并"修好"它 ——
//   但**运行时没有任何代码读它**:
//     · j2_agent_loop.js 的 model-chain switch 被 isSilentFailFallbackEnabled() 硬编码 false 挡死
//     · message-stream.js 传给 loop 的 _modelChain 是**字面量空数组** (唯一的生产注入点)
//   于是那份配置 100% 不可达 —— 这是「注释 ≠ 隔离」的又一例: 维护它的代码是活的, 用它的代码是死的。
//
// 为什么"配了就生效"不等于"自动选模型":
//   2026-09-07 老板拍「关了自动选择, 现在还不成熟」针对的是 **每次请求帮我挑最合适的**。
//   本函数不是那个 —— 它只在**主人显式配了 fallback_chain** 时才产出链, 且只在
//   当前模型已经哑火之后才被消费。没配 = 空链 = 行为与今天完全一致 (哑火直接报失败)。
//   自动选模型 (autoModelSelection) 仍然硬关着, 那条产品决定一个字没动。
//
// 过滤规则 (每条都有理由, 不是洁癖):
//   - 非本地端点必须能解析出 key: 否则切过去必定 401, 等于把一次失败换成另一次失败
//   - 排除当前模型: 自己切到自己 = 无限重试同一条死路
//   - 排除 enabled=false: 主人手动关掉的模型不该被自动复活
function resolveFallbackChain(cfg, currentModelId) {
  const llm = (cfg && cfg.llm) || {};
  const models = Array.isArray(llm.models) ? llm.models : [];
  const raw = Array.isArray(llm.fallback_chain) ? llm.fallback_chain : [];
  const byId = new Map();
  for (const m of models) {
    if (m && m.id != null) byId.set(String(m.id), m);
  }
  const cur = currentModelId != null ? String(currentModelId) : null;
  const out = [];
  const seen = new Set();
  for (const id of raw) {
    if (id == null) continue;
    const key = String(id);
    if (!key || key === cur || seen.has(key)) continue;
    const m = byId.get(key);
    if (!m) continue;                 // 悬空引用: guard 会报, 这里静默跳过 (不制造第二次失败)
    if (m.enabled === false) continue; // 主人手动关掉的, 不许自动复活
    seen.add(key);
    out.push(m);
  }
  return out;
}

module.exports = {
  parseFlag,
  isAutoModelSelectionEnabled,
  isSilentFailFallbackEnabled,
  isRouterDemoteEnabled,
  getModelPolicy,
  resolveFallbackChain,
};
