/**
 * Learner - 学习者
 * 职责: 学/忆/优 (知识库 + 缓存)
 * 权限: 读 L1/L2 数据、优化 prompt
 * 边界: 不执行新任务,只优化历史
 */

// 共享的静态学习数据，兼容旧测试脚本 LearnerAgent.getLearnData()
const sharedExperiences = [];
const sharedPatterns = new Map();

class Learner {
  constructor() {
    this.knowledgeBase = new Map();
  }

  async execute(task, context) {
    switch (task.type) {
      case 'learn':
        return await this.learn(task.experience, context);
      case 'recall':
        return this.recall(task.query, context);
      case 'optimize':
        return await this.optimize(task.component, context);
      default:
        // 兼容旧测试脚本: { expData: {...} }
        if (task.expData) {
          return this.learn(task.expData, context);
        }
        return { ok: false, error: `Unknown learn type: ${task.type}` };
    }
  }

  async learn(experience, context) {
    const key = experience.key || JSON.stringify(experience).slice(0, 50);
    this.knowledgeBase.set(key, experience);
    sharedExperiences.push(experience);

    // 提取任务 pattern
    const taskName = experience.task || 'unknown';
    if (!sharedPatterns.has(taskName)) sharedPatterns.set(taskName, { count: 0, successes: 0 });
    const p = sharedPatterns.get(taskName);
    p.count++;
    if (experience.synthesis?.pass) p.successes++;

    return {
      ok: true,
      experience_recorded: true,
      total_experiences: sharedExperiences.length,
      summary: `Learned: ${key}`,
      data: { key, totalKBSize: this.knowledgeBase.size }
    };
  }

  recall(query, context) {
    const results = [];
    this.knowledgeBase.forEach((v, k) => {
      if (k.includes(query) || JSON.stringify(v).includes(query)) {
        results.push({ key: k, value: v });
      }
    });
    return {
      ok: true,
      summary: `Recalled ${results.length} entries`,
      data: { results }
    };
  }

  async optimize(component, context) {
    return {
      ok: true,
      summary: `Optimized: ${component}`,
      data: { component, suggestedChanges: [] }
    };
  }

  static getLearnData() {
    const taskPatterns = {};
    sharedPatterns.forEach((v, k) => {
      taskPatterns[k] = { count: v.count, successRate: v.count ? v.successes / v.count : 0 };
    });
    const agentPerformance = {};
    return { experiences: sharedExperiences, taskPatterns, agentPerformance };
  }
}
module.exports = new Learner();
module.exports.GenAgent = Learner;
