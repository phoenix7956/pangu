// 2026-09-12 新增 (老板 PANGU_SCAN_REPORT_20260912 §6.2 ③): L3 dispatcher 智能选组 (框架)
// 修活 L3 学习闭环 (B2 已修 weights/taskToAgents 空数据不覆盖) — dispatcher 按 taskPattern
// 从 l3_loop.state.taskToAgents 查历史上 pass 率最高的 agent 组合, 自动派活。
//
// 用法:
//   const l3 = require('./l3_dispatcher');
//   const _plan = l3.suggestAgentsForTask(taskPattern); // ['analyze', 'execute', 'check']
//   // B2 已修前 weights/taskToAgents 是 {} → _plan = null → 走默认组合
//   // 数据积累后自动产出真值
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
// 2026-09-12 修 (PANGU_RESCAN N3): 旧路径 ~/.pangu/../apps/core/.learn = ~/apps/core/.learn (不存在),
// _loadL3State 永远 null → dispatcher 永远空转。改用 __dirname 相对定位 (modules/ -> apps/core/.learn)
const L3_STATE_FILE = path.join(__dirname, '..', '.learn', 'l3_state.json');
// 备用路径 (PANGU_HOME 部署变体)
const ALT_L3_STATE = path.join(DEFAULT_PANGU_HOME, 'learn', 'l3_state.json');

function _loadL3State() {
  for (const f of [L3_STATE_FILE, ALT_L3_STATE]) {
    try {
      if (fs.existsSync(f)) {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      }
    } catch (_) {}
  }
  return null;
}

/**
 * 推断 taskPattern (粗粒度)
 * @param {string} taskInput
 * @returns {string} 模式键
 */
function inferTaskPattern(taskInput) {
  const t = String(taskInput || '').toLowerCase();
  if (/(审计|扫描|排查|查 bug|debug|diagnose)/.test(t)) return 'audit_diagnose';
  if (/(消化|精读|总结|吸收|全套|整本)/.test(t)) return 'digest_summarize';
  if (/(写|创建|生成|implement|create|build)/.test(t)) return 'create_implement';
  if (/(改|重构|优化|修|refactor|fix|optimize)/.test(t)) return 'refactor_optimize';
  if (/(分析|对比|比较|research|analyze|compare)/.test(t)) return 'analyze_compare';
  return 'general';
}

/**
 * 给定 taskPattern + 当前可用 agents, 建议最优 agent 组合
 * @param {string} taskPattern
 * @param {string[]} availableAgents — 默认对齐 sub-agent.js ROLES 8 角色全名
 *   (2026-09-12 修: 旧默认 ['analyze','execute','check'] 跟 ROLES 全名 'analyzer' 等永不匹配,
 *    过滤后必为空数组 → 默认调用永远 null)
 * @returns {string[]|null} 推荐组合 (按顺序), 或 null (无数据走默认)
 */
function suggestAgentsForTask(taskPattern, availableAgents = require('../agents/gua-identity').GUA_CODES) {
  const state = _loadL3State();
  if (!state) return null;
  const mapping = state.taskToAgents || {};
  const _pat = mapping[taskPattern];
  if (!_pat || !Array.isArray(_pat.agents)) return null;
  const _stats = _pat.stats || {};
  const _passRate = parseFloat(_stats.pass_rate || '0');
  // 数据门槛: 至少 3 次调用 + pass 率 >= 0.4 才采纳 (避免冷启动期噪声)
  if ((_stats.count || 0) < 3 || _passRate < 0.4) return null;
  // 过滤: 只保留 availableAgents 里有的。
  //
  // 两边都只认拼音 (2026-10-18)。l3_state.json 的 taskToAgents 是 l3_loop
  // 写出来的, 写侧早就拼音化, 所以这里不需要任何"读时归一"——
  // 原来那层 _parse + `|| a` 兜底已删。`|| a` 尤其危险: 认不出的名字会**原样**
  // 漏过滤进 `_filtered`, 再被 `_routeWithL3` 当 role 发出去, 下游 ROLES[role]
  // 查不到 → 落到没有 system prompt 的空角色。认不出就该丢掉。
  const _avail = new Set(availableAgents || []);
  const _filtered = (_pat.agents || []).filter((a) => _avail.has(a));
  // 2026-09-12 修 (PANGU_RESCAN N3): 过滤后空数组是 truthy → dispatchAgentsForTask 会报
  // applied: true 但 agents: [], 下游拿到空组合。空即无建议, 返回 null。
  return _filtered.length > 0 ? _filtered : null;
}

/**
 * 给定 taskInput 自动推断 pattern + 选组合
 * @returns {string[]|null}
 */
function dispatchAgentsForTask(taskInput, availableAgents) {
  const pattern = inferTaskPattern(taskInput);
  const agents = suggestAgentsForTask(pattern, availableAgents);
  return { pattern, agents, applied: !!agents };
}

module.exports = {
  inferTaskPattern,
  suggestAgentsForTask,
  dispatchAgentsForTask,
  _paths: { L3_STATE_FILE, ALT_L3_STATE },
};
