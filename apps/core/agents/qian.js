/**
 * Pangu · 8 子 Agent 调度器 (Dispatcher)
 * 核心必须装
 * 加 上下文锚点 + 必须调工具 (§0.22 + §0.23)
 *
 * 设计原则：
 * 1. 任务来了 → Dispatcher 分析 → 分配角色 → 并行/串行执行
 * 2. 每个角色独立 prompt + 工具集，不串台
 * 3. 闭环：执行 → 检查 → 反思 → 学习 → 输出
 * 4. 进度实时 SSE 推给 UI
 * 5. **上下文锚点**：原始主人输入 + 前序结论注入每个子 agent，防丢失 (§0.23)
 * 6. **必须调工具**：kun/dui/xun 不调工具 = 违规重试 (§0.22)
 */

'use strict';

// #5 全局 prompt 约束: 从 modules/global_agent_rules.js 注入
const { getGlobalRules } = require('../modules/global_agent_rules');
// #3 全动态策略: 工具健康度报告 (仅 kun 角色注入)
const { getReport: getToolHealthReport } = require('../modules/tool_stats');
const {
  endpointOf,
  canonicalModelName,
  isAnthropic,
  normalizeProtocol,
  normalizeEndpoint,
  outputTokenCap,
  authHeaders,
  resolveRequestTimeoutMs,
} = require('../modules/model_transport');
const { resolveApiKey } = require('../modules/api_key_resolver');

function loadL3State(statePath = process.env.PANGU_L3_STATE_PATH) {
  try {
    const fs = require('fs');
    const path = require('path');
    const file = statePath || path.join(__dirname, '..', '.learn', 'l3_state.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch (_) { return {}; }
}

// 角色工具集 (同 ROLES)
// 必须调工具的角色 (返回 0 工具调用 = 违规, 补 1 次重试 + 警告)
const MUST_TOOL_ROLES = new Set(['kun', 'dui', 'xun']);

// 复杂度 → 应跳过的角色 (思维要"按任务大小选 agent")
// 'flash': 1-2 角色, 直奔主题 (闲聊/查值/单步操作)
// 'standard': kan+kun+dui 最小闭环
// 'pro': standard + li + zhen
// 'ultra': 全套 8 角色 (默认, 跨域大活 / 老板显式声明)
const ROLE_SKIP_FOR_COMPLEXITY = {
  flash:    new Set(['li', 'xun', 'gen', 'zhen']),
  standard: new Set(['li', 'gen', 'zhen']),
  pro:      new Set(['gen']),
  ultra:    new Set(),
};

const ROLES = {
  kan:    { name: 'kan',    icon: '📋', desc: '规划拆解',  tools: ['first_step', 'opportunity_check', 'critical_point_analysis', 'team_dispatch'] },
  li:   { name: 'li',   icon: '🔍', desc: '分析研判',  tools: ['situation_check', 'trend_judgment', 'risk_assessment', 'momentum_assessment', 'main_force_analysis', 'peak_judgment', 'bazi_calc'] },
 // #3 工具优先级 — Tier 1 确定性工具优先, Tier 2 GUI 仅兜底
  // 实测: LLM 看到 GUI 工具就去点 (加上 vision_act 失败率高) — 应该放最后并要求 LLM 给理由
  kun:   { name: 'kun',   icon: '⚒️', desc: '执行落地 (优先确定性工具, GUI 仅兜底)',  tools: [
    // Tier 1: 确定性 (preferred — 有 API / 真实命令路径)
    'exec_command', 'write_file', 'file_edit',
    'send_wechat', 'clipboard_write', 'archive_create', 'batch_execute',
    'run_installer', 'code_execute',  // 2026-10-13: 不是写文件工具, 挪到 Tier 1 末尾
    // Tier 2: GUI (last resort — 视觉 / 点击 / 键盘依赖, 常因 TCC / 权限失败)
    'computer_use_click', 'computer_use_type', 'computer_use_key', 'computer_use_drag',
    'computer_use_vision_act'
  ] },
  dui:    { name: 'dui',    icon: '✅', desc: '检查验证',  tools: ['read_file', 'file_grep', 'list_directory', 'http_check', 'weather_check', 'currency_check', 'crypto_price', 'stock_quote', 'stock_history', 'system_info', 'process_list', 'network_check', 'permission_check'] },
  xun:  { name: 'xun', icon: '🐛', desc: '巡查找 bug', tools: ['file_grep', 'file_find', 'search_files', 'read_file', 'system_info'] },
  zhen:  { name: 'zhen',  icon: '🪞', desc: '反思复盘',  tools: ['caution_signal', 'wait_action', 'patience_manager', 'dilemma_resolution', 'reversal_signal', 'withdrawal_plan', 'graceful_exit'] },
  gen:    { name: 'gen',    icon: '📚', desc: '学习进化',  tools: ['memory_write', 'memory_search', 'memory_read', 'cache_get', 'cache_put', 'cache_preheat', 'cache_evict', 'cache_stats'] },
  qian: { name: 'qian', icon: '🎯', desc: '调度协调',  tools: ['team_dispatch', 'permission_check', 'permission_grant', 'resource_pool'] },
};

// 2026-10-18 (身份统一): 上面 8 个 name 原本是英文 (Planner/Analyzer/Executor/...),
// 而 name 不是装饰 —— 它直接进 LLM 提示词:
//   qian.js:391 `你是 Pangu 的 ${role.name} ${role.icon}`
//   qian.js:264/353/372 的重试与约束文案也各插一次。
// 于是同一个提示词里, 上面刚说"只写拼音, 英文名会被判未知", 下面却在自称
// Planner/Executor —— 模型看到两套名字。跟 tools_schema.js 那次同源: **提示词里
// 教的名字必须和运行时认的名字是同一个**。
//
// 不手抄中文名 (那是第 9 份身份表, 迟早漂移), 从真源取, 取不到就退回拼音本身 ——
// 宁可显示 "kun", 也不要显示一个运行时根本不认的英文名。
{
  const {GUA_BY_CODE} = require('./gua-identity');
  for (const code of Object.keys(ROLES)) {
    const g = GUA_BY_CODE[code];
    ROLES[code].name = g ? g.zh : code;
  }
}

// 角色边界铁律
const BOUNDARY_RULES = [
  '坤 kun 不分析 — 写完就返回，好坏由兑 dui 评',
  '离 li 不执行 — 只推，不写',
  '兑 dui 不改 — 只评，不改（改是坤 kun）',
  '巽 xun 不修 — 只找，不修（修是坤 kun）',
  '坎 kan 不执行 — 只拆，不跑',
];

function defaultMockLLM(prompt, opts) {
  return Promise.resolve({ content: 'LLM mock response: ' + ((opts && opts.role) || 'qian') });
}

class AgentDispatcher {
  constructor(opts = {}) {
    this.llm = opts.llm || defaultMockLLM;
    this.tools = opts.tools || {};
    this.cfg = opts.cfg || {};     // 配置
    this.onProgress = opts.onProgress || (() => {});  // 进度回调
  }

  // 兼容旧测试 / 路由层的 execute 接口
  async execute(input, context) {
    const task = input?.task || input;
    const goal = task?.bigTask || task?.goal || task?.input || 'default';
    const plan = await this._callRole('kan', { type: 'decompose', goal });
    const subTasks = plan?.subTasks || plan?.data?.subTasks || [];
    const agents = subTasks.map(t => t.agent || t.role).filter(Boolean);
    return {
      taskType: this._inferPattern(goal),
      agents: agents.length > 0 ? agents : Object.keys(ROLES),
      schedule: subTasks,
      plan,
    };
  }

  // 主入口：调度任务
  async dispatch(task) {
    const start = Date.now();
    this.onProgress({ stage: 'start', task: task.input });

 // 先 classify (判断分什么任务给什么子 agent)
    const classification = await this._classifyTask(task);
    task.__classification = classification;
    // 注入 perAgentReasoning 到 task 供 _buildRolePrompt 读
    task.__perAgentReasoning = classification.perAgentReasoning || {};

    // 1. Planner 拆解
    const plan = await this._callRole('kan', task);
    this.onProgress({ stage: 'planned', plan });

    // 2. Analyzer 并行分析（同时 Checker 预检）
    const [analysis, preCheck] = await Promise.all([
      this._callRole('li', { ...task, plan }),
      this._callRole('dui', { ...task, plan, mode: 'pre_check' }),
    ]);
    this.onProgress({ stage: 'analyzed', analysis, preCheck });

    // 3. Executor 执行（并行）+ Bug Hunter 并行扫描
    const execPromises = (plan.steps || [{ action: 'execute', params: task }]).map(step =>
      this._callRole('kun', { ...task, step, analysis })
    );
    const [results, bugs] = await Promise.all([
      Promise.all(execPromises),
      this._callRole('xun', { ...task, plan, analysis }),
    ]);
    this.onProgress({ stage: 'executed', results, bugs });

    // 4. Checker 验证（并行 Reflector 预反思）
    const [check, preReflection] = await Promise.all([
      this._callRole('dui', { ...task, results }),
      this._callRole('zhen', { ...task, results, mode: 'pre_reflect' }),
    ]);
    this.onProgress({ stage: 'checked', check, preReflection });

    // 5. 有 bug → Executor 修（并行 Learner 预学习）
    let fixed = null;
    let learning = null;
    if (bugs.issues && bugs.issues.length > 0) {
      [fixed, learning] = await Promise.all([
        this._callRole('kun', { ...task, bugs, mode: 'fix' }),
        this._callRole('gen', { ...task, bugs, mode: 'pre_learn' }),
      ]);
      results.push(fixed);
      this.onProgress({ stage: 'fixed', fixed, learning });
    } else {
      learning = await this._callRole('gen', { ...task, results, mode: 'learn' });
    }

    // 6. Reflector 复盘（已预反思，现在综合）
    const reflection = await this._callRole('zhen', { ...task, results, check, preReflection });
    this.onProgress({ stage: 'reflected', reflection });

    // 7. Learner 学习（已预学习，现在综合）
    const finalLearning = await this._callRole('gen', { ...task, results, reflection, preLearning: learning });
    this.onProgress({ stage: 'learned', learning: finalLearning });

    // 8. 综合输出
    const output = await this._synthesize(task, plan, analysis, results, check, reflection, learning);
    this.onProgress({ stage: 'done', elapsed_ms: Date.now() - start, output });

    return output;
  }

  // 加载主人偏好
  _loadOwnerPreferences() {
    try {
      const prefFile = require('path').join(require('os').homedir(), '.pangu', 'config', 'owner_preferences.json');
      if (require('fs').existsSync(prefFile)) {
        return JSON.parse(require('fs').readFileSync(prefFile, 'utf8'));
      }
    } catch (_) {}
    return {};
  }

  // 检查主人偏好 override
  _checkOwnerOverride(roleKey, task) {
    const prefs = this._loadOwnerPreferences();
    // 主人可以指定：某类任务跳过某角色
    if (prefs.skip_roles && prefs.skip_roles.includes(roleKey)) {
      return { skipped: true, reason: '主人偏好：跳过 ' + roleKey };
    }
    // 主人可以指定：某类任务只用某角色
    if (prefs.only_roles && !prefs.only_roles.includes(roleKey)) {
      return { skipped: true, reason: '主人偏好：只使用 ' + prefs.only_roles.join(', ') };
    }
 // 复杂度分级 → 跳过不必要的角色
    const taskComplexity = task && task.__classification && task.__classification.complexity;
    if (taskComplexity && ROLE_SKIP_FOR_COMPLEXITY[taskComplexity]) {
      if (ROLE_SKIP_FOR_COMPLEXITY[taskComplexity].has(roleKey)) {
        return { skipped: true, reason: `复杂度 ${taskComplexity}: 跳过 ${roleKey}` };
      }
    }
    return null;
  }

  // 调用单个角色（带主人偏好检查 + 必须调工具约束 + 上下文锚点注入）
  async _callRole(roleKey, ctx) {
 // 把 classification 透传到 ctx 供 prompt 用
    if (ctx && ctx.__classification === undefined && this._taskAnchor && this._taskAnchor.classification) {
      ctx = { ...ctx, __classification: this._taskAnchor.classification };
    }
    if (ctx && ctx.__perAgentReasoning === undefined) {
      const perAgent = (this._taskAnchor && this._taskAnchor.perAgentReasoning) || (ctx && ctx.__classification && ctx.__classification.perAgentReasoning);
      if (perAgent) ctx = { ...ctx, __perAgentReasoning: perAgent };
    }

    // 检查主人偏好 override
    const override = this._checkOwnerOverride(roleKey, ctx);
    if (override) {
      this.onProgress({ stage: 'skipped', role: roleKey, reason: override.reason });
      return { role: roleKey, skipped: true, reason: override.reason, timestamp: Date.now() };
    }

    const role = ROLES[roleKey];
    if (!role) throw new Error('Unknown role: ' + roleKey);

    // 注入上下文锚点 (原始任务 + 前序结论 + 主人原文) (§0.23)
    const anchoredCtx = this._injectAnchor(ctx);

    // 构建角色 prompt
    const prompt = this._buildRolePrompt(roleKey, anchoredCtx);

    // 调 LLM（带工具）
    let result = await this.llm(prompt, { role: roleKey, tools: role.tools });

    // 必须调工具约束 (§0.22): kun/dui/xun 不调工具 = 违规
    if (MUST_TOOL_ROLES.has(roleKey) && !result.tool_calls && !this._hasToolResult(result)) {
      console.warn(`[dispatcher] §0.22 违规: ${roleKey} 返回 0 工具调用, 补 1 次重试`);
      this.onProgress({ stage: 'retry_tool_required', role: roleKey });
      const retryPrompt = prompt + '\n\n【⚠️ §0.22 提醒】你刚返回了 0 工具调用。\n作为 ' + role.name + '，**必须** 调至少 1 个工具 (' + role.tools.slice(0, 3).join(' / ') + ' 等) 验证现状后再输出结论。\n**立即调用工具**, 不要纯文字描述。';
      result = await this.llm(retryPrompt, { role: roleKey, tools: role.tools });
    }

    // #2 强制收手 (接 d261c27 sub-agent 标记之后)
    // 必须调工具的角色 (§0.22) 重试 1 次后仍 0 工具调用 → 强制失败上报, 不要静默吞掉
    if (MUST_TOOL_ROLES.has(roleKey) && !result.tool_calls && !this._hasToolResult(result)) {
      console.warn(`[dispatcher] §0.22 违规2次: ${roleKey} 重试后仍 0 工具调用, 强制失败`);
      this.onProgress({ stage: 'forced_failure_no_tool', role: roleKey });
      return {
        role: roleKey,
        result: `❌ [${role.name}] 强制失败: 重试 1 次后仍 0 工具调用. LLM 不能/不愿调用工具完成任务. 建议: (1) 简化任务 (2) 提供更多上下文 (3) system prompt 强化必须调工具 (4) 检查 tools 列表是否含可执行工具.`,
        toolResults: [],
        failed: true,
        forced_failure: 'no_tool_after_retry',
        timestamp: Date.now()
      };
    }

    // 如果 LLM 返回 tool_use，执行工具
    let toolResults = [];
    if (result.tool_calls) {
      for (const call of result.tool_calls) {
        const toolResult = await this._executeTool(call.name, call.arguments);
        toolResults.push({ tool: call.name, result: toolResult });
      }
    }

    return { role: roleKey, result: result.content || result, toolResults, timestamp: Date.now() };
  }

  // 注入上下文锚点 (§0.23): 原始主人输入 + 前序角色结论
  _injectAnchor(ctx) {
    const anchor = this._taskAnchor;
    if (!anchor) return ctx;
    return {
      ...ctx,
      __anchor: {
        original_input: anchor.original,        // 主人原话
        owner_command: anchor.command,          // 主人明确命令句
        history: anchor.history.slice(-3),      // 最近 3 个子 agent 结论
        inferred: anchor.inferred || null,      // 主人已表达过的推断
      },
    };
  }

  // 设置任务锚点 (dispatch 前调一次)
  setTaskAnchor(anchor) {
    this._taskAnchor = anchor;
  }

  // 检查 LLM 返回是否包含 tool_use / function_call / tool_calls
  _hasToolResult(result) {
    if (!result) return false;
    if (result.tool_calls && result.tool_calls.length > 0) return true;
    // 某些 LLM 返回 tool_use (anthropic) 或 function_call (openai legacy)
    if (result.tool_use && result.tool_use.length > 0) return true;
    if (result.function_call) return true;
    if (result.content && typeof result.content === 'string' && /<tool_use>|<invoke|tool_calls/i.test(result.content)) return true;
    return false;
  }

  // 执行工具（调用 Pangu 工具集）
  async _executeTool(toolName, args) {
    try {
      const { TOOLS } = require('../modules/tools');
      if (TOOLS[toolName]) {
        // 工具函数签名: async (ctx) => {}, ctx = { context, params }
        const ctx = {
          context: { user: 'feng' },
          params: args || {}
        };
        return await TOOLS[toolName](ctx);
      }
      return { ok: false, error: 'Tool not found: ' + toolName };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  // 构建角色 system prompt
  _buildRolePrompt(roleKey, ctx) {
    // 2026-10-18 拼音统一: 角色键从磁盘上的 L3 权重 / 上游 subtasks 流进来,
    // 那些是**历史英文** (analyzer/executor/…)。不归一就是 ROLES[undefined] → 崩,
    // 或静默拿不到那一份权重。读进来的当场归成拼音。
    roleKey = require('./gua-identity').resolveRole(roleKey) || roleKey;
    const role = ROLES[roleKey];
    const boundaries = BOUNDARY_RULES.join('\n');
    const anchor = ctx.__anchor || {};
    const mustTool = MUST_TOOL_ROLES.has(roleKey)
      ? `\n\n【⚠️ §0.22 硬约束】作为 ${role.name}，**你必须调用至少 1 个工具**才算完成任务。\n可用工具: ${role.tools.join(', ')}\n纯文字描述 = 违规。`
      : '';
 // #3 工具优先级 — 仅 kun 角色注入
    const toolPriority = roleKey === 'kun'
      ? `\n\n【⚡ #3 工具优先级】**优先用 Tier 1 确定性工具** (exec_command / send_wechat / write_file / code_execute / clipboard_write 等 — 有 API 或真实命令路径)。\n只有在确定性工具**无法完成任务**时才用 Tier 2 GUI 工具 (computer_use_vision_act / click / type / key / drag)。\n用 GUI 工具必须在回复里说明：**为什么确定性方案不行**。\n原因: GUI 工具依赖 vision_act + TCC 权限, 失败率高 (#9), 把它们当首选是 早期观察到的喷泉主因。\n\n【⚠️ #9 Computer Use 失败兜底】如果调用 Tier 2 GUI 工具 (computer_use_*) 后返回 fail / error / 超时, **不要重试同一个 GUI 工具**, 立即跳到以下兜底: \n  1. \`exec_command\` + \`osascript -e\` (AppleScript 走系统应用)\n  2. \`exec_command\` + \`open "weixin://...\` (URL scheme)\n  3. \`clipboard_write\` + 然后在另一个平台手动粘要\n  4. 告诉用户 "GUI 路径走不通, 需要你手动 ..."\n不要预测 "如果我能按 X ..." / "我现在先 ..." / "准备点击 Y ..." — 这种纯文本嘴上操作 = STATUS_FOUNTAIN_GUARD 会被切断 (#1)。`
      : '';

    const anchorBlock = anchor.original
      ? `\n\n【🔗 上下文锚点 (§0.23) - 防止 context 丢失】
原始主人输入: ${anchor.original}
${anchor.owner_command ? `主人明确命令: ${anchor.owner_command}` : ''}
${anchor.history && anchor.history.length > 0 ? `前序 agent 结论: ${JSON.stringify(anchor.history)}` : ''}
${anchor.inferred ? `主人已表达推断: ${JSON.stringify(anchor.inferred)}` : ''}`
      : '';

 // dispatcher 把"为什么是你"显式注入
    const perAgent = (ctx && ctx.__perAgentReasoning) || {};
    const agentReason = perAgent[roleKey];
    const reasoningBlock = agentReason
      ? `\n\n【🎯 你被选是因为】${agentReason}\n（dispatcher 已判断本任务需要 ${role.name}，请按你 ${role.desc} 的职责完成。）`
      : '';

    // 分类全局感知
    const cls = (ctx && ctx.__classification) || null;
    const l3 = loadL3State();
    // L3 权重表的键**已经是拼音** (2026-10-18: l3_loop._loadState 加载期就迁完并
    // 写回磁盘, 磁盘上现在只有 {kan:0.5, li:0.5, …})。这里原来还挂着一层
    // _weightsByPinyin 兜底, 已删 —— 留着的唯一作用是让英文键在别的机器/旧备份上
    // 又能混进来, 也就是老板说的「还留着干嘛」。
    const learnedWeight = l3.weights && Number(l3.weights[roleKey]);
    const learnedBlock = Number.isFinite(learnedWeight)
      ? `\n\n【L3 学习权重】${roleKey}=${learnedWeight.toFixed(3)}。相似任务优先参考 L3 学到的组合，但不得跳过必要验证。`
      : '';
    const complexityBlock = cls
      ? `\n\n【📊 任务分类 (dispatcher 视角)】\n类型: ${cls.taskType || 'general'} · 复杂度: ${cls.complexity || 'pro'}\n${cls.reasoning ? `分类判断: ${cls.reasoning}` : ''}`
      : '';

    return `${getGlobalRules()}${learnedBlock}
你是盘古八将灵中的 ${role.name} ${role.icon}
职责：${role.desc}
可用工具：${role.tools.join(', ')}
${reasoningBlock}${complexityBlock}${toolPriority}${roleKey === 'kun' ? getToolHealthReport() : ''}
边界铁律（不可违反）：
${boundaries}

【§0.22 先做原则】默认执行，不堆 5 项参数让主人拍。 拿不准 = 1 次推 3-4 个备选 + 老板选。 不要纯文字推断。
${mustTool}${anchorBlock}

当前任务上下文：
${JSON.stringify(ctx, null, 2)}

请按你的职责输出结果。`;
  }

  _inferPattern(goal) {
    const g = (goal || '').toLowerCase();
    if (g.includes('review') || g.includes('评审') || g.includes('检查') || g.includes('test')) return 'code_review';
    if (g.includes('bug') || g.includes('fix') || g.includes('修')) return 'bug_fix';
    if (g.includes('risk') || g.includes('风险')) return 'risk_assessment';
    if (g.includes('architecture') || g.includes('架构')) return 'architecture_decision';
    if (g.includes('security') || g.includes('安全')) return 'security_audit';
    if (g.includes('feature') || g.includes('新功能') || g.includes('做') || g.includes('实现')) return 'feature_implementation';
    return 'simple_query';
  }

 // 思维层 LLM-first 分类, 不再 keyword 猜
  // LLM 失败降级: priority keyword-pattern → flash+general
  async _classifyTask(task) {
    const raw = (task && (task.input || task.goal || task.bigTask)) || '';
    // 1) 试 LLM (用 dispatcher.llm, 同样接口)
    let classification = null;
    try {
      const classifyPrompt = this._buildClassifyPrompt(raw);
      const llmRes = await this.llm(classifyPrompt, { role: 'dispatcher.classifier' });
      classification = this._parseClassifyResponse(llmRes, raw);
    } catch (e) {
      // M10: 不吞错 — 留痕但不打断 (降级到 keyword 分类)
      console.warn('[dispatcher] LLM classify failed, fallback to keyword:', e.message);
      this.onProgress({ stage: 'classified_fallback_warning', error: e.message });
    }
    if (classification && classification.complexity && classification.reasoning) {
      this.onProgress({ stage: 'classified', classification });
      return this._applyL3Routing(classification);
    }
    // 2) LLM 失败/无效 → keyword 降级
    const fallback = this._fallbackClassify(raw);
    this.onProgress({ stage: 'classified_fallback', classification: fallback });
    return this._applyL3Routing(fallback);
  }

  _applyL3Routing(classification) {
    const l3 = loadL3State();
    const taskType = this._inferPattern(classification.taskType || '');
    const learned = l3.taskToAgents && (l3.taskToAgents[taskType] || l3.taskToAgents[classification.taskType]);
    if (!learned || !Array.isArray(learned.agents) || !learned.stats || Number(learned.stats.count) < 3) return classification;
    // 历史组合 (l3_state.json) 存的是英文名, 而 subtasks 里现在可能是拼音。
    // 两边都归一到拼音再配对 —— 否则 byRole 配不上, 学到的组合被静默丢弃。
    const {resolveRole} = require('./gua-identity');
    const byRole = new Map((classification.subtasks || [])
      .map(s => [resolveRole(s.role) || s.role, s]));
    const normalizedRoles = learned.agents
      .map(role => resolveRole(role))
      .filter(role => role && ROLES[role]);
    const reordered = normalizedRoles.map(role => byRole.get(role) || ({ role, goal: `按 L3 历史组合执行 ${taskType}` }));
    const rest = (classification.subtasks || []).filter(s => !normalizedRoles.includes(resolveRole(s.role) || s.role));
    return { ...classification, taskPattern: taskType, subtasks: [...reordered, ...rest], l3Applied: true };
  }

  _buildClassifyPrompt(raw) {
    const roleNames = Object.keys(ROLES).map(k => `${k}=${ROLES[k].name}/${ROLES[k].desc}`).join(', ');
    const l3 = loadL3State();
    const learned = l3.taskToAgents && Object.keys(l3.taskToAgents).length ? JSON.stringify(l3.taskToAgents).slice(0, 3000) : '暂无足够样本';
    // 2026-10-19: 跟 _synthesize 同修 —— 分类器也是模型真正读到的提示词,
    // 「Pangu Dispatcher」是英文身份, 且 roleNames 里已经列了 8 将灵的真名,
    // 分类器却自称一个不在列表里的第四个身份。
    const {GUA_BY_CODE} = require('./gua-identity');
    const selfZh = (GUA_BY_CODE.qian && GUA_BY_CODE.qian.zh) || '乾 · 调度';
    return `你是盘古八将灵中的 ${selfZh} 里的任务分类器 🎯
可用角色: ${roleNames}

主人输入: ${JSON.stringify(raw)}

L3 历史学习到的任务→角色组合（仅作参考，必须服从当前任务事实）: ${learned}

请分析这个任务:
1. taskType: 一句话分类 (e.g. "review a PR", "implement a feature", "answer a factual query")
2. complexity: flash (闲聊/单步) | standard (最小闭环) | pro (含分析反思) | ultra (跨域全套)
3. perAgentReasoning: { kan: '...', kun: '...', dui: '...', li: '...', xun: '...', zhen: '...', gen: '...', qian: '...' }
   - 每个角色**一句话**说明"为什么叫它" 或 "为什么跳过"
4. reasoning: 一句话总判断 (给主人看的分类理由)
5. subtasks: [{role, goal}]: 2-5 个具体子任务, role 必须从可用角色里选, goal 是这个子任务的目标
6. estimatedAgents: 整数, 调用 LLM 的次数估算

严格按 JSON 输出 (不要 Markdown code block, 不要前后缀文字):
{"taskType": "...", "complexity": "flash|standard|pro|ultra", "reasoning": "...", "subtasks": [{"role": "...", "goal": "..."}], "perAgentReasoning": {"kun": "...", "dui": "..."}, "estimatedAgents": N}`;
  }

  _parseClassifyResponse(llmRes, raw) {
    if (!llmRes || !llmRes.content) return null;
    const text = typeof llmRes.content === 'string' ? llmRes.content : JSON.stringify(llmRes.content);
    // 鲁棒解析: 提取 JSON (允许包含 ```json ... ``` 或加前后文字)
    let jsonStr = text.trim();
    const firstBrace = jsonStr.indexOf('{');
    if (firstBrace < 0) return null;
    jsonStr = jsonStr.slice(firstBrace);
    const lastBrace = jsonStr.lastIndexOf('}');
    if (lastBrace < 0) return null;
    jsonStr = jsonStr.slice(0, lastBrace + 1);
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (_) {
      return null;
    }
    if (!parsed.complexity || !['flash', 'standard', 'pro', 'ultra'].includes(parsed.complexity)) return null;
    if (!parsed.reasoning) return null;
    if (!Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) return null;
    // 验证 sub-task role 在 ROLES 里
    parsed.subtasks = parsed.subtasks.filter(s => s && s.role && ROLES[s.role]);
    if (parsed.subtasks.length === 0) return null;
    parsed.perAgentReasoning = parsed.perAgentReasoning || {};
    parsed.estimatedAgents = Number(parsed.estimatedAgents) || parsed.subtasks.length;
    return parsed;
  }

  _fallbackClassify(raw) {
    const g = (raw || '').toLowerCase();
 // 中文一个字 1 char, 50 chars 约等于一段话
    let complexity = 'pro';
    let taskType = 'general';
    if (g.length < 15) complexity = 'flash';
    if (g.includes('review') || g.includes('评审')) { complexity = 'standard'; taskType = 'code_review'; }
    else if (g.includes('bug') || g.includes('fix') || g.includes('修')) { complexity = 'pro'; taskType = 'bug_fix'; }
    else if (g.includes('feature') || g.includes('新功能') || g.includes('做') || g.includes('实现')) { complexity = 'ultra'; taskType = 'feature_implementation'; }
    return {
      taskType, complexity, reasoning: `[keyword 降级] 类比任务原话 "${(raw||'').slice(0,40)}..."`,
      subtasks: [{ role: 'kan', goal: '拆解此任务' }, { role: 'kun', goal: '执行任务' }],
      perAgentReasoning: { kan: '拆解任务', kun: '执行任务' },
      estimatedAgents: 5,
    };
  }

  // 综合输出
  async _synthesize(task, plan, analysis, results, check, reflection, learning) {
    // 2026-10-19: 原来写死「你是 Pangu 的 Dispatcher 🎯」——
    //   一是英文身份 (老板: 说了全换), 二是**不诚实**: 现场 59740796 实际只跑了 5 刀
    //   全是离 (li), 兑一把没派, 照这个提示词模型会以为"兑已经验过了"而编出验收结论。
    // 从真源取卦名, 不再手抄。
    const {GUA_BY_CODE} = require('./gua-identity');
    const selfZh = (GUA_BY_CODE.qian && GUA_BY_CODE.qian.zh) || '乾 · 调度';
    const prompt = `你是盘古八将灵中的 ${selfZh} 🎯
请综合以下 8 角色结果，给主人最终答案：

任务：${task.input}

规划：${JSON.stringify(plan.result)}
分析：${JSON.stringify(analysis.result)}
执行：${JSON.stringify(results.map(r => r.result))}
检查：${JSON.stringify(check.result)}
反思：${JSON.stringify(reflection.result)}
学习：${JSON.stringify(learning.result)}

请给出：
1. 最终结论（简洁，≤3 句话）
2. 关键数据/证据
3. 风险提示（如有）
4. 下一步建议（如有）`;

    return await this.llm(prompt, { role: 'qian' });
  }
}

module.exports = { AgentDispatcher, ROLES, BOUNDARY_RULES, QianAgent: AgentDispatcher, loadConfig, getEnabledModel };

// 兼容路由层：提供 execute 方法。如果 context 提供 config_path，则读配置使用真实 LLM + 工具集。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

function loadConfig(configPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return cfg;
  } catch (e) {
    console.warn('[dispatcher] load config failed:', e.message);
    return null;
  }
}

function getEnabledModel(cfg) {
  if (!cfg || !cfg.llm || !Array.isArray(cfg.llm.models)) return null;
  const enabled = cfg.llm.models.filter(m => m.enabled !== false);
  // 单一真源: llm.current_model_id (pangu-single 启动时已删 model.default 字段)
  const id = cfg.llm.current_model_id;
  if (id) {
    const cur = enabled.find(m => m.id === id);
    if (cur) return cur;
  }
  if (enabled.length > 0) return enabled.sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
  return null;
}

async function callLLM(messages, modelConfig) {
  if (!modelConfig) throw new Error('No model available');
  const apiKey = resolveApiKey(modelConfig);
  const baseUrl = normalizeEndpoint(endpointOf(modelConfig), normalizeProtocol(modelConfig));
  const useAnthropic = isAnthropic(modelConfig);

  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    let body, headers = authHeaders(modelConfig, apiKey);
    const apiModel = canonicalModelName(modelConfig);

    if (useAnthropic) {
      const mergedSystem = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n---\n\n');
      const userMessages = messages.filter(m => m.role !== 'system');
      body = JSON.stringify({
        model: apiModel,
        max_tokens: Math.min(4096, outputTokenCap(modelConfig)),
        system: mergedSystem || undefined,
        messages: userMessages.map(m => ({ role: m.role, content: m.content }))
      });
    } else {
      body = JSON.stringify({
        model: apiModel,
        max_tokens: 4096,
        messages
      });
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: (() => {
        const p = url.pathname + url.search;
        if (useAnthropic) return p;
        if (p.includes('/chat/completions') || p.includes('/completions')) return p;
        return (p.endsWith('/') ? p.slice(0, -1) : p) + '/chat/completions';
      })(),
      method: 'POST',
      headers,
      // 2026-10-14: 本地端点 (mlx/lmstudio/ollama) 给 300s, 云端 60s; 否则本地大 prompt 一轮必被 60s 打断
      timeout: resolveRequestTimeoutMs(modelConfig, 60000, 300000)
    };
    const req = (url.protocol === 'https:' ? https : http).request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.error) return reject(new Error(result.error.message || result.error));
          let content = '';
          if (useAnthropic) {
            content = result.content && result.content.map(c => c.text).join('') || '';
          } else {
            content = result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content || '';
          }
          resolve({ content });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('LLM timeout')));
req.setHeader('Content-Length', Buffer.byteLength(body)); // 2026-10-14: mlx-serve 不吃 chunked
    req.write(body);
    req.end();
  });
}

module.exports.execute = async function(task, context) {
  const goal = (task && task.goal) || (task && task.bigTask) || 'default task';
  // 2026-10-19 修 (会话 59740796 现场): 这里兜底路径拼成了
  //   ~/.pangu/config/nodes/<某台机器>.json
  // 但真源从来就在 **仓库里**: apps/core/config/nodes/ 下的节点配置
  // (现在由 config/node_config.js 统一解析, 见 pangu-single.js 顶部的 CONFIG_PATH)。
  // ~/.pangu/config/ 整个目录都不存在 —— 于是每次走这个兜底都必然 ENOENT,
  // loadConfig 吞成 null → getEnabledModel(null) = null → llm 退回
  // 'LLM 模拟响应: <role>', 8 个将灵全部返回假数据, 而界面上一片绿。
  //
  // 现场: lm-watch 21:44:46
  //   [dispatcher] load config failed: ENOENT ... /.pangu/config/nodes/your-mac.json
  //   [dispatcher] §0.22 违规: dui 返回 0 工具调用, 补 1 次重试
  //   [dispatcher] §0.22 违规2次: dui 重试后仍 0 工具调用, 强制失败
  // —— 真实模型连一步都没跑起来, 它当然调不动工具。
  //
  // 修法: 兜底指向仓库真源 (跟 j2_dispatcher.js:1178 同一个 __dirname/.. 拼法)。
  // 不再用 ~/.pangu —— 那个目录树里从来没有过 nodes/。
  // 2026-10-26 第 108 批: 路径不再写死某台机器的节点文件名, 交给
  // config/node_config.js 解析 (PANGU_NODE_CONFIG > node.json > 唯一候选)。
  const configPath = (context && context.config_path)
    || require('../config/node_config').resolveNodeConfigPathOrExample();
  const cfg = loadConfig(configPath);
  const model = getEnabledModel(cfg);
  const llm = model
    ? async (prompt, opts) => callLLM([{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: prompt }], model)
    : async (prompt, opts) => ({ content: 'LLM 模拟响应: ' + (opts && opts.role || 'qian') });

  const dispatcher = new AgentDispatcher({
    llm,
    tools: require('../modules/tools').TOOLS,
    cfg,
  });

  try {
    const result = await dispatcher.dispatch({ input: goal });
    return { ok: true, summary: 'Dispatched', data: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};
