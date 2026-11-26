/**
 * Pangu Base Agent
 * 所有 8 个 agent 的基类
 * 提供:统一输入/输出校验 + LLM 调用封装 + 生命周期 hooks
 */

const { getTools } = require('../modules/tools/index.js');

// Agent registry for lookup
const AGENT_CLASSES = {};

/**
 * PanguAgent 基类
 */
class PanguAgent {
  constructor(role, config) {
    this.role = role;
    this.name = config.name || role;
    this.description = config.description || '';
    this.systemPrompt = config.systemPrompt || '';
    this.tools = config.tools || [];          // 可用 tool 名列表
    this.inputSchema = config.inputSchema || {};
    this.outputSchema = config.outputSchema || {};
    this.llmEndpoint = config.llmEndpoint || 'local';  // 'local' | 'cloud'
    this.timeoutMs = config.timeoutMs || 60000;
    this.retries = config.retries || 1;
    
    // 统计
    this._stats = {
      appearances: 0,
      successes: 0,
      failures: 0,
      totalDurationMs: 0,
    };
  }
  
  /**
   * 验证输入 schema
   */
  validateInput(input) {
    const required = this.inputSchema.required || [];
    for (const field of required) {
      if (input[field] === undefined || input[field] === null) {
        throw new Error(`[${this.role}] Missing required field: ${field}`);
      }
    }
    return true;
  }
  
  /**
   * 验证输出 schema
   */
  validateOutput(output) {
    // 简单校验:确保非空
    if (output === undefined || output === null) {
      throw new Error(`[${this.role}] Output cannot be null/undefined`);
    }
    return true;
  }
  
  /**
   * 执行 agent(主入口)
   * 子类 override
   */
  async execute(input, ctx = {}) {
    this._stats.appearances++;
    const start = Date.now();
    
    try {
      // 1. 校验输入
      this.validateInput(input);
      
      // 2. 执行(子类实现)
      const result = await this._executeImpl(input, ctx);
      
      // 3. 校验输出
      this.validateOutput(result);
      
      this._stats.successes++;
      this._stats.totalDurationMs += Date.now() - start;
      
      return {
        agent: this.role,
        status: 'success',
        ...result,
      };
    } catch (err) {
      this._stats.failures++;
      this._stats.totalDurationMs += Date.now() - start;
      
      return {
        agent: this.role,
        status: 'failed',
        error: err.message,
        durationMs: Date.now() - start,
      };
    }
  }
  
  /**
   * 子类实现具体逻辑
   * @abstract
   */
  async _executeImpl(input, ctx) {
    throw new Error(`[${this.role}] _executeImpl not implemented`);
  }
  
  /**
   * 获取统计(给 Learner 用)
   */
  getStats() {
    return {
      role: this.role,
      appearances: this._stats.appearances,
      successes: this._stats.successes,
      failures: this._stats.failures,
      successRate: this._stats.appearances > 0 
        ? (this._stats.successes / this._stats.appearances).toFixed(3) 
        : null,
      avgDurationMs: this._stats.appearances > 0
        ? Math.round(this._stats.totalDurationMs / this._stats.appearances)
        : null,
    };
  }
  
  /**
   * 构造 LLM prompt
   */
  buildPrompt(userPrompt, context = '') {
    let prompt = this.systemPrompt;
    if (context) prompt += `\n\n## Context\n${context}`;
    prompt += `\n\n## Task\n${userPrompt}`;
    prompt += `\n\n## Output Format\nRespond with JSON matching this schema: ${JSON.stringify(this.outputSchema)}`;
    return prompt;
  }
  
  /**
   * 工具注册(给 executor 用)
   * 返回可用的 pangu tool 函数
   */
  getToolFunctions() {
    const allTools = getTools();
    const allowed = this.tools;
    
    if (!allowed || allowed.length === 0) return {};
    
    const fns = {};
    for (const toolName of allowed) {
      if (allTools[toolName]) {
        fns[toolName] = allTools[toolName];
      }
    }
    return fns;
  }
}

/**
 * 注册 agent 类(供 registry 用)
 */
function registerAgent(role, AgentClass) {
  AGENT_CLASSES[role] = AgentClass;
}

module.exports = {
  PanguAgent,
  registerAgent,
  AGENT_CLASSES,
};
