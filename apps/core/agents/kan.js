/**
 * Planner - 规划者
 * 职责: 拆/序/设任务
 * 权限: 纯 LLM 推理
 * 边界: 不执行
 */
class Planner {
  async execute(task, context) {
    // 兼容旧测试脚本: { bigTask: '...' }
    if (task && typeof task === 'object' && !task.type && (task.bigTask || task.goal)) {
      task = { type: 'decompose', goal: task.bigTask || task.goal };
    }

    switch (task.type) {
      case 'plan':
        return await this.plan(task.goal, context);
      case 'decompose':
        return await this.decompose(task.goal, context);
      case 'sequence':
        return await this.sequence(task.subtasks, context);
      default:
        return { ok: false, error: `Unknown plan type: ${task.type}` };
    }
  }

  async plan(goal, context) {
    const plan = this.decompose(goal, context);
    return {
      ...plan,
      data: {
        goal,
        steps: this.inferSteps(goal),
        estimatedComplexity: this.assessComplexity(goal),
        ...plan.data
      }
    };
  }

  async decompose(goal, context) {
    const pattern = this.detectPattern(goal);
    const subTasks = this.generateSubtasks(goal, pattern);
    return {
      ok: true,
      summary: `Decomposed: ${goal}`,
      pattern,
      subTasks,
      data: {
        goal,
        pattern,
        subTasks
      }
    };
  }

  detectPattern(goal) {
    const g = (goal || '').toLowerCase();
    if (g.includes('code review') || g.includes('代码评审') || g.includes('review') || g.includes('评审')) return 'code_review';
    if (g.includes('bug') || g.includes('fix') || g.includes('修复')) return 'bug_fix';
    if (g.includes('feature') || g.includes('新功能') || g.includes('实现') || g.includes('做')) return 'feature_implementation';
    return 'general';
  }

  async sequence(subtasks, context) {
    // 拓扑排序
    return {
      ok: true,
      summary: 'Subtasks sequenced',
      data: { ordered: this.topologicalSort(subtasks) }
    };
  }

  inferSteps(goal) {
    return [
      { step: 1, action: 'analyze', role: 'li' },
      { step: 2, action: 'execute', role: 'kun' },
      { step: 3, action: 'verify', role: 'dui' }
    ];
  }

  assessComplexity(goal) {
    const length = goal.length;
    if (length < 30) return 'low';
    if (length < 100) return 'medium';
    return 'high';
  }

  generateSubtasks(goal, pattern) {
    if (pattern === 'code_review') {
      return [
        { agent: 'li', task: '分析代码结构' },
        // 角色名与 orchestrator.roles 的 key 对齐 (camelCase), snake_case 会被静默丢弃
        { agent: 'xun', task: '安全/bug扫描' },
        { agent: 'dui', task: '代码规范检查' }
      ];
    }
    return [
      { agent: 'li', task: '分析需求' },
      { agent: 'kun', task: '执行任务' },
      { agent: 'dui', task: '验证结果' }
    ];
  }

  topologicalSort(subtasks) {
    // 简单拓扑排序 (依赖关系由 deps 字段表示)
    const sorted = [];
    const visited = new Set();
    const visit = (task) => {
      if (visited.has(task)) return;
      visited.add(task);
      if (task.deps) task.deps.forEach(d => sorted.includes(d) || visit(subtasks.find(t => t.role === d)));
      sorted.push(task);
    };
    subtasks.forEach(visit);
    return sorted;
  }
}
module.exports = new Planner();
module.exports.KanAgent = Planner;
