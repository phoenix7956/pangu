/**
 * modules/plan_mode.js
 * 盘古 · 计划模式（Claude Code Plan + Pi 融合）
 * 
 * 功能：
 * - 创建 plan 文件（markdown格式，含任务/步骤/验证）
 * - 进入计划模式（限制性权限上下文）
 * - 验证步骤完成状态
 * - 自动保存执行历史
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PLAN_TEMPLATE = `# Plan

## Task
{task}

## Context
{context}

## Steps
{steps}

## Verification
{verification}

---
*Created: {created}*
*Status: {status}*
`;

class PlanMode {
  constructor({ plansDir = '.plans/' } = {}) {
    this.plansDir = path.resolve(plansDir);
    this.activePlan = null;
    this._eb = null; // EventBus reference (optional)
  }

  /**
   * TL-5 子项 A: 从 LLM 响应提取 plan steps
   * LLM 返: <think>plan</think> or ```plan\n...``` (显式 plan 标签)
   * R19 修 (老板 7/25 13:36 截图 + v3 原则 'agent 动手 + 老板整合'):
   *   删 "纯数字列表" fallback — 老板场景 LLM 文本里的 "1. 原告 2. 被上诉方 3. 提供材料 4. 明确重点"
   *   会被误判为 plan steps, PlanViewer 显示 "(no tool) LOW" × 4 (no tool bug)
   *   正确: LLM 显式用 <plan>...</plan> 或 ```plan\n...\n``` 才算 plan
   *   不解析自然数字列表 (那是 LLM 文字结构, 不是 plan)
   * @param {string} llmResponse - LLM 文本
   * @returns {Array<string>} 步骤列表
   */
  extractPlanSteps(llmResponse) {
    if (!llmResponse) return [];
    // 1. <plan>...</plan> 标签
    const tagged = llmResponse.match(/<plan>([\s\S]*?)<\/plan>/i);
    if (tagged) {
      return tagged[1].split('\n').map(l => l.replace(/^\s*[-*\d.)\s]+/, '').trim()).filter(l => {
        if (l.length <= 5) console.warn('[plan_mode] dropped short step:', JSON.stringify(l));  // M9: 静默丢 step 留痕
        return l.length > 5;
      });
    }
    // 2. ```plan ... ``` code block
    const codeBlock = llmResponse.match(/```plan\n([\s\S]*?)```/);
    if (codeBlock) {
      return codeBlock[1].split('\n').map(l => l.replace(/^\s*[-*\d.)\s]+/, '').trim()).filter(l => {
        if (l.length <= 5) console.warn('[plan_mode] dropped short step:', JSON.stringify(l));  // M9: 静默丢 step 留痕
        return l.length > 5;
      });
    }
    // R19: 删纯数字列表 fallback — 老板场景实证误判 (no tool) LOW × 4
    // 不解析自然数字列表 — 那是 LLM 文字结构, 不是 plan
    return [];
  }

  /**
   * TL-5 子项 A: 生成 plan, 准备给老板看 (接 j2_agent_loop)
   * @param {string} task - 任务
   * @param {string[]} steps - 步骤
   * @returns {Object} { plan_id, task, steps, status, created_at }
   */
  /**
   * normalize steps: string[] → {step_id, text} objects so PlanViewer renders properly.
   * Also passes through plain objects unchanged.
   */
  _normalizeSteps(steps) {
    if (!Array.isArray(steps)) return [];
    return steps.map((s, i) => {
      if (typeof s === 'object' && s !== null) return s; // already PlanStep[]
      return { step_id: i + 1, text: String(s), risk: 'low' };
    });
  }

  generatePlan(task, steps) {
    const planId = `plan_${Date.now()}`;
    return {
      plan_id: planId,
      task: task || '未命名',
      steps: this._normalizeSteps(steps),
      status: 'pending_approval',
      created_at: new Date().toISOString(),
    };
  }

  setEventBus(eb) { this._eb = eb; }

  /**
   * 创建新计划
   * @param {string} task - 任务描述
   * @param {string[]} steps - 步骤列表
   * @param {Object} context - 额外上下文
   * @returns {Object} { planFile, planId }
   */
  async createPlan(task, steps = [], context = {}) {
    if (!fs.existsSync(this.plansDir)) {
      fs.mkdirSync(this.plansDir, { recursive: true });
    }

    const planId = `plan_${Date.now()}`;
    const planFile = path.join(this.plansDir, `${planId}.md`);
    const stepList = steps.length > 0
      ? steps.map((s, i) => `${i + 1}. [ ] ${s}`).join('\n')
      : '1. [ ] （待补充）';

    const verification = steps.length > 0
      ? steps.map((s, i) => `- [ ] 验证步骤 ${i + 1}: ${s}`).join('\n')
      : '- [ ] （待补充验证条件）';

    const content = PLAN_TEMPLATE
      .replace('{task}', task)
      .replace('{context}', context.summary || '（无额外上下文）')
      .replace('{steps}', stepList)
      .replace('{verification}', verification)
      .replace('{created}', new Date().toISOString())
      .replace('{status}', 'active');

    fs.writeFileSync(planFile, content);

    this.activePlan = { planId, planFile, task, steps, created: new Date() };
    this._emit('plan:created', this.activePlan);

    return { planId, planFile, plan: this.activePlan };
  }

  /**
   * 进入计划模式（更新权限上下文 + 加载 plan 提示）
   * @param {string} planId
   * @returns {Object} { context, permission } 供 AgentLoop 使用
   */
  async enter(planId) {
    let plan;
    if (planId) {
      plan = this.loadPlan(planId);
    } else if (this.activePlan) {
      plan = this.activePlan;
    } else {
      throw new Error('No active plan to enter');
    }

    // 加载 plan 内容
    const content = fs.readFileSync(plan.planFile, 'utf8');
    const planContext = this._parsePlanContent(content);

    // 更新 plan 状态
    this._updatePlanStatus(plan.planFile, 'in_progress');
    this.activePlan = { ...plan, status: 'in_progress' };

    this._emit('plan:entered', this.activePlan);

    return {
      planId: plan.planId,
      task: plan.task,
      context: planContext,
      // 计划模式下权限收紧
      permission: {
        level: 'MEDIUM',
        allowWrite: ['/tmp'],
        allowNetwork: false,
        allowDangerous: false,
      },
      // AgentLoop 继续执行而非中止
      continueMode: true,
    };
  }

  /**
   * 退出计划模式
   */
  async exit() {
    if (this.activePlan) {
      this._updatePlanStatus(this.activePlan.planFile, 'completed');
      this._emit('plan:exited', this.activePlan);
      this.activePlan = null;
    }
  }

  /**
   * 标记步骤完成
   * @param {number} stepIndex - 1-indexed 步骤编号
   */
  async completeStep(stepIndex) {
    if (!this.activePlan) throw new Error('No active plan');
    const content = fs.readFileSync(this.activePlan.planFile, 'utf8');
    // 替换 [ ] 为 [x]（第一个未完成的步骤）
    let count = 0;
    const updated = content.replace(/(\d+)\. \[ \] /g, (match, num) => {
      count++;
      if (count === stepIndex) return `${num}. [x] `;
      return match;
    });
    fs.writeFileSync(this.activePlan.planFile, updated);
    this._emit('plan:step_completed', { planId: this.activePlan.planId, step: stepIndex });
    return { step: stepIndex, completed: true };
  }

  /**
   * 验证步骤是否完成
   * @param {number} stepIndex
   * @returns {boolean}
   */
  async verifyStep(stepIndex) {
    if (!this.activePlan) return false;
    const content = fs.readFileSync(this.activePlan.planFile, 'utf8');
    // H6 修: 取全部步骤, 检查 index 位置的步骤是否 [x] (而非 ">=N 个完成")
    const stepLines = content.match(/^\d+\. \[([ x])\]/gm) || [];
    if (stepIndex < 1 || stepIndex > stepLines.length) return false;
    return stepLines[stepIndex - 1].includes('[x]');
  }

  /**
   * 获取计划进度
   * @returns {Object} { total, completed, percentage }
   */
  async getProgress() {
    if (!this.activePlan) return null;
    const content = fs.readFileSync(this.activePlan.planFile, 'utf8');
    const total = (content.match(/\d+\. \[.?\]/g) || []).length;
    const completed = (content.match(/\d+\. \[x\]/g) || []).length;
    return { total, completed, percentage: total > 0 ? Math.round((completed / total) * 100) : 0 };
  }

  /**
   * 加载计划文件
   */
  loadPlan(planId) {
    const planFile = path.join(this.plansDir, `${planId}.md`);
    if (!fs.existsSync(planFile)) throw new Error(`Plan not found: ${planId}`);
    const content = fs.readFileSync(planFile, 'utf8');
    const planContext = this._parsePlanContent(content);
    return { planId, planFile, ...planContext };
  }

  /**
   * 列出所有计划
   */
  listPlans() {
    if (!fs.existsSync(this.plansDir)) return [];
    return fs.readdirSync(this.plansDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const fullPath = path.join(this.plansDir, f);
        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath, 'utf8');
        const ctx = this._parsePlanContent(content);
        return {
          planId: f.replace('.md', ''),
          task: ctx.task,
          status: ctx.status,
          created: ctx.created,
          mtime: stat.mtime,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  /**
   * 删除计划
   */
  async deletePlan(planId) {
    const planFile = path.join(this.plansDir, `${planId}.md`);
    if (fs.existsSync(planFile)) {
      fs.unlinkSync(planFile);
      if (this.activePlan?.planId === planId) this.activePlan = null;
      this._emit('plan:deleted', { planId });
      return true;
    }
    return false;
  }

  _parsePlanContent(content) {
    const task = content.match(/## Task\n([^\n#]+)/)?.[1]?.trim() || '';
    const status = content.match(/\*Status: (\w+)\*/)?.[1] || 'unknown';
    const created = content.match(/\*Created: ([^\n*]+)\*/)?.[1]?.trim() || '';
    const steps = [...content.matchAll(/^\d+\. \[([ x])\] (.+)$/gm)]
      .map(m => ({ completed: m[1] === 'x', text: m[2].trim() }));
    return { task, status, created, steps };
  }

  _updatePlanStatus(planFile, status) {
    const content = fs.readFileSync(planFile, 'utf8');
    const updated = content.replace(/\*Status: \w+\*/, `*Status: ${status}*`);
    fs.writeFileSync(planFile, updated);
  }

  _emit(event, data) {
    if (this._eb) this._eb.emit(event, data);
  }
}

// P0-#1 Plan Audit: 持久化 plan approve/reject (audit trail, brief §5)
// main.sqlite 优先 (跟盘古其他存储一致), fallback JSON file 在 ~/.pangu/plan_audit.json
const _planAuditFile = path.join(os.homedir(), '.pangu', 'plan_audit.json');

function _planAuditLoad() {
  try {
    if (fs.existsSync(_planAuditFile)) {
      const raw = JSON.parse(fs.readFileSync(_planAuditFile, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    }
  } catch (_) {}
  return {};
}

function _planAuditSave(data) {
  try {
    fs.mkdirSync(path.dirname(_planAuditFile), { recursive: true });
    fs.writeFileSync(_planAuditFile, JSON.stringify(data, null, 2));
  } catch (_) {}
}

const _planAudit = {
  record(planId, action, info = {}) {
    const data = _planAuditLoad();
    const entry = data[planId] || { plan_id: planId, history: [] };
    entry.history.push({ action, ...info });
    entry.status = action;
    entry.last_updated = Date.now();
    data[planId] = entry;
    _planAuditSave(data);
    return entry;
  },
  status(planId) {
    const data = _planAuditLoad();
    return data[planId] || { plan_id: planId, status: 'unknown' };
  },
  list() {
    return _planAuditLoad();
  },
};

// P0-#3: 把 plan.steps 转成 todo 项 list (plan 批准后自动 todo_write 用)
function _planToTodos(plan) {
  if (!plan || !Array.isArray(plan.steps)) return [];
  return plan.steps.map((s, i) => {
    if (typeof s === 'string') return s;
    return s.tool ? `${s.step_id || i + 1}. ${s.tool}` : (s.text || JSON.stringify(s));
  });
}

module.exports = { PlanMode, _planAudit, _planToTodos };
module.exports.createPlanMode = (config) => new PlanMode(config);
