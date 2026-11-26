/**
 * Orchestrator - Pangu 元调度器
 * 职责: 任务分析 → 拆解 → 设计拓扑 → 调度 → 综合
 * 不执行, 只调度
 */
const path = require('path');

// 2026-10-18: 这里原来手抄了一张 `ROLE_ALIASES = { bug_hunter:'xun', bughunter:'xun' }`,
// 键还是英文 —— 身份表抄到第 8 份。而且它当时只认 bugHunter 一个角色, 其余英文名
// (analyzer/executor/...) 原样穿过去, 于是"归一化"只对 1/8 生效。
// 现在用真源的输入解析器: 拼音/卦名/英文全归一, 存的一律拼音。
// 注意这是**输入解析** (读完即丢), 跟"身份表不许存英文"不冲突 —— 模型和 planner
// 的先验里就是英文, 派发入口必须读得懂, 否则一个英文名 = 子任务被静默丢弃 + 死循环。
function normalizeRole(role) {
  try {
    const {resolveRole} = require('./gua-identity');
    const canonical = resolveRole(role);
    return canonical || role;
  } catch (_) {
    return role;
  }
}

function resultSucceeded(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.ok !== undefined) return result.ok === true;
  if (result.success !== undefined) return result.success === true;
  if (result.status !== undefined) return result.status === 'success';
  return false;
}

class Orchestrator {
  constructor() {
    // 键 = 拼音 (与 ROLES / task_split / 其余派发路径同一套名字)。
    // 这里原来用英文 (executor/analyzer/…/bugHunter), 而下面按 role 查表时已经改成
    // 拼音 —— 键和用法对不上, 角色桩全落空, 直接取到 undefined 再 .execute() 崩。
    this.roles = {
      // 键和值都改拼音 (2026-10-18): 模块文件整批改名 (executor.js → kun.js),
      // 这里原来 require 的是旧文件名 —— 文件一改名就 require 不到, orchestrator
      // 构造直接抛 "Cannot find module", 整个编排器起不来。
      kun:   require('./kun'),
      li:   require('./li'),
      dui:    require('./dui'),
      xun:  require('./xun'),
      kan:    require('./kan')
    };
  }

  async execute(task, context) {
    // 1. 任务分析
    const analysis = await this.analyze(task, context);

    // 2. 让 Planner 拆解
    const plan = await this.roles.kan.execute(
      { type: 'decompose', goal: task },
      context
    );

    // 3. 拆解子任务
    const subtasks = this.decompose(analysis, plan);

    // 4. 设计执行拓扑 (依赖图)
    const topology = this.designTopology(subtasks);

    // 5. 调度执行
    const results = await this.dispatch(topology, { ...(context || {}), goal: task });

    // 6. 综合结果
    return this.synthesize(results, analysis, plan);
  }

  // 兼容旧测试脚本的 orchestrate(task) 方法
  async orchestrate(task, context) {
    const t0 = Date.now();
    const result = await this.execute(task, context || {});
    return {
      ok: result.success,
      agents_used: Object.keys(result.results || {}),
      synthesis: { pass: result.success, score: result.success ? 90 : 50 },
      durationMs: Date.now() - t0,
      ...result
    };
  }

  async analyze(task, context) {
    // 用 Analyzer 分析任务类型
    return this.roles.li.execute(
      { type: 'analyze_requirement', text: task },
      context
    );
  }

  decompose(analysis, plan) {
    // 根据分析结果拆解子任务
    const subtasks = [];
    const planSubtasks = plan?.subTasks || plan?.data?.subTasks || [];
    if (planSubtasks.length > 0) {
      // 使用 planner 给出的子任务
      // 只依赖上一个被接受的角色: 若上一个角色被丢弃(不在 roles 里),
      // depends 会指向永远不会执行的节点 → dispatch 死循环
      let lastAccepted = null;
      planSubtasks.forEach((st, i) => {
        const role = normalizeRole(st.agent || st.role);
        if (this.roles[role]) {
          subtasks.push({ role, task: st.task, command: st.command, code: st.code, output: st.output, index: i, depends: lastAccepted ? [lastAccepted] : [] });
          lastAccepted = role;
        }
      });
    }
    if (subtasks.length === 0 && analysis.data && analysis.data.type === 'coding') {
      subtasks.push({ role: 'li',   task: '分析需求' });
      subtasks.push({ role: 'kun',   task: '写代码', depends: ['li'] });
      subtasks.push({ role: 'dui',    task: '验证代码', depends: ['kun'] });
      subtasks.push({ role: 'xun',  task: '找 bug', depends: ['kun'] });
    }
    if (subtasks.length === 0) {
      // 默认用 analyzer + checker 至少凑 3 个
      subtasks.push({ role: 'li', task: '分析需求' });
      subtasks.push({ role: 'kun', task: '默认执行', depends: ['li'] });
      subtasks.push({ role: 'dui', task: '验证结果', depends: ['kun'] });
    }
    return subtasks;
  }

  designTopology(subtasks) {
    // 构建依赖图
    const graph = {};
    subtasks.forEach(st => {
      graph[st.role] = { ...st, deps: st.depends || [] };
    });
    return graph;
  }

  async dispatch(topology, context) {
    const results = {};
    const executed = new Set();

    // 拓扑排序执行
    while (executed.size < Object.keys(topology).length) {
      const ready = Object.entries(topology)
        .filter(([role, node]) => !executed.has(role) && node.deps.every(d => executed.has(d)));

      // 死锁护栏: 没有任何就绪节点但还有未执行节点 → 依赖环或指向不存在角色的 dep
      // 旧代码这里 Promise.all([]) 立即返回, executed 不再增长, while 死循环挂死请求
      if (ready.length === 0) {
        const stuck = Object.keys(topology).filter(r => !executed.has(r));
        throw new Error('orchestrator 调度死锁: 无就绪节点, 剩余 [' + stuck.join(', ') + '] (依赖环或未知角色 dep)');
      }

      // 并行执行就绪的任务
      const batch = await Promise.all(ready.map(async ([role, node]) => {
        const roleObj = this.roles[role];
        let taskPayload;
        if (role === 'li') {
          taskPayload = { type: 'analyze_requirement', text: node.task || node.goal };
        } else if (role === 'kun') {
          if (typeof node.command !== 'string' || !node.command.trim()) {
            executed.add(role);
            return [role, { ok: false, error: 'EXECUTABLE_COMMAND_MISSING', message: 'Planner must provide an explicit command before Executor can run.' }];
          }
          taskPayload = { type: 'run_command', command: node.command.trim() };
        } else if (role === 'dui') {
          taskPayload = { type: 'security_scan', output: node.output || context.goal || node.task || node.goal };
        } else if (role === 'xun') {
          taskPayload = { type: 'scan', code: node.code || context.goal || node.task || node.goal };
        } else {
          taskPayload = { type: node.task, goal: node.goal };
        }
        const result = await roleObj.execute(taskPayload, context);
        executed.add(role);
        return [role, result];
      }));

      batch.forEach(([role, result]) => results[role] = result);
    }

    return results;
  }

  synthesize(results, analysis, plan) {
    // 综合各角色结果
    return {
      success: Object.values(results).every(resultSucceeded),
      analysis: analysis,
      plan: plan,
      results: results,
      summary: this.generateSummary(results)
    };
  }

  generateSummary(results) {
    return Object.entries(results)
      .map(([role, result]) => `${role}: ${resultSucceeded(result) ? '✅' : '❌'} ${result.summary || result.error || ''}`)
      .join('\n');
  }
}

module.exports = Orchestrator;
module.exports.PanguOrchestrator = Orchestrator;
module.exports.Orchestrator = Orchestrator;
