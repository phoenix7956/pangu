/**
 * Analyzer - 分析者
 * 职责: 64 卦推理 + LLM 解读
 * 权限: 读文件、分析代码、64 卦推算
 * 边界: 不执行、不改文件
 */
const path = require('path');

class Analyzer {
  async execute(task, context) {
    // 兼容旧测试脚本输入
    if (task && typeof task === 'object' && !task.type) {
      if (task.query !== undefined) {
        task = { type: 'analyze_requirement', text: task.query, guaId: task.guaId, yaoPosition: task.yaoPosition };
      } else if (task.path !== undefined) {
        task = { type: 'analyze_code', path: task.path };
      }
    }

 // 修: 兼容 pangu-single dispatch 路由的输入 { type: 'default', goal, context }
    if (task && typeof task === 'object' && task.type === 'default' && task.goal !== undefined) {
      const goal = task.goal || '';
      if (goal.toLowerCase().includes('bug') || goal.toLowerCase().includes('fix')) {
        task = { type: 'analyze_requirement', text: goal };
      } else if (task.path || goal.toLowerCase().includes('file') || goal.toLowerCase().includes('code') || goal.toLowerCase().includes('read')) {
        task = { type: 'analyze_code', path: task.path || goal };
      } else {
        task = { type: 'analyze_requirement', text: goal };
      }
    }

    switch (task.type) {
      case 'analyze':
      case 'analyze_code':
        return await this.analyzeCode(task.path || task.text || task.filePath, context);
      case 'analyze_requirement':
      case 'requirement':
        return await this.analyzeRequirement(task.text || task.goal || task.task, context);
      case 'divination':
        return await this.divinate(task.question, context);
      default:
        // 未知 type 兜底：只要有文本就当需求分析
        if (task.text || task.goal || task.task || task.query) {
          return await this.analyzeRequirement(task.text || task.goal || task.task || task.query, context);
        }
        return { ok: false, error: `Unknown analysis type: ${task.type}` };
    }
  }

  async analyzeCode(filePath, context) {
    const { TOOLS } = require(path.join(__dirname, '..', 'modules', 'tools'));
    try {
      let content = null;
      try {
        content = await TOOLS.read_file({
          context: { user: 'feng' },
          params: { path: filePath }
        });
      } catch (e) { /* file not found */ }
 // 修: path 可能是自然语言描述，用文本本身作为分析对象
      const source = content ? (content.data !== undefined ? content.data : content) : (filePath || '');
      const data = typeof source === 'string' ? source : String(source);
      const lines = data.split('\n');
      const funcCount = (data.match(/function\s+\w+/g) || []).length;
      const todoCount = (data.match(/TODO|FIXME|XXX/g) || []).length;

      return {
        ok: true,
        summary: `Analyzed ${filePath}: ${lines.length} lines, ${funcCount} functions, ${todoCount} TODOs`,
        data: { lines: lines.length, functions: funcCount, todos: todoCount }
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async analyzeRequirement(text, context) {
    const input = text || '';
    return {
      ok: true,
      summary: 'Requirement analyzed',
      data: {
        type: this.inferType(input),
        complexity: this.assessComplexity(input),
        keywords: this.extractKeywords(input)
      }
    };
  }

  async divinate(question, context) {
    // 64 卦推理
    const { divinate } = require(path.join(__dirname, '..', 'kernel', 'index.js'));
    try {
      const result = divinate(question);
      return { ok: true, summary: `Divination: ${result.hexagram}`, data: result };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  inferType(text) {
    if (text.includes('bug') || text.includes('fix')) return 'bugfix';
    if (text.includes('feature') || text.includes('add')) return 'feature';
    if (text.includes('refactor')) return 'refactor';
    return 'other';
  }

  assessComplexity(text) {
    const lines = text.split('\n').length;
    if (lines < 5) return 'low';
    if (lines < 20) return 'medium';
    return 'high';
  }

  extractKeywords(text) {
    return [...text.matchAll(/\b\w{4,}\b/g)].map(m => m[0]).slice(0, 10);
  }
}

module.exports = new Analyzer();
module.exports.LiAgent = Analyzer;
