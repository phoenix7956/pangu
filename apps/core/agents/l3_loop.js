/**
 * L3 Loop - 自进化引擎 (pangu-single.js 主循环 setInterval 调用)
 * 
 * Pangu 2.0 灵魂 = 自进化闭环
 * 
 * 4 个组件:
 * 1. weight_tracker: 角色权重自适应(出场率/成功率/耗时)
 * 2. task_mapper: 任务 → 角色组合 映射学习
 * 3. prompt_evolver: 角色 prompt 自改进(Reflector 建议)
 * 4. tool_optimizer: 角色工具集自调整(高频加入,低频弃用)
 * 
 * 数据源:Learner 的 .learn/learner_data.json
 * 输出:l3_state.json + prompt_suggestions.json
 * 
 * P1-M6: 移除 DEPRECATED 标记, 确认在主进程 setInterval 中跑 (60s/tick)
 */

const fs = require('fs');
const path = require('path');
// 2026-10-18: 这里原来解构的是 `LearnerAgent`, 但改名那轮把 require 路径换成了
// ./gen.js 却**没换解构名** —— gen.js 导出的类名是 `GenAgent`, 于是 LearnerAgent
// 恒为 undefined → runCycle() 第一行就 TypeError。
// 而 pangu-single.js 的 L3 定时器把异常 catch 成一行 warn, 所以每 60 秒静默崩一次,
// 现场日志证据: /tmp/pangu-single.err 里 11 条 "L3 cycle error: Cannot read
// properties of undefined (reading 'getLearnData')" —— **L3 学习闭环整个是死的**,
// 而 L3 状态文件还停在旧时间戳, 没有任何东西会告诉你。
const { GenAgent } = require('./gen.js');

// 状态路径可被环境变量改写 —— 不是为了生产配置, 是为了让守卫能拿一份
// "磁盘上还是英文键" 的临时 state 真跑一遍迁移。
// 上一版的守卫只能看**当下**磁盘上那份已经是拼音的文件, 所以把整个迁移代码
// 删掉它照样转绿 —— 守卫测的是巧合, 不是机制。
const L3_STATE_PATH = process.env.PANGU_L3_STATE_PATH
  || path.join(__dirname, '..', '.learn', 'l3_state.json');
const PROMPT_SUGGESTIONS_PATH = path.join(__dirname, '..', '.learn', 'prompt_suggestions.json');

class L3Loop {
  constructor() {
    this._ensureDir();
    this.state = this._loadState();
    this.promptSuggestions = this._loadSuggestions();
  }
  
  _ensureDir() {
    const dir = path.dirname(L3_STATE_PATH);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (_) {}
    }
  }
  
  _loadState() {
    let _loaded = null;
    try {
      if (fs.existsSync(L3_STATE_PATH)) {
        _loaded = JSON.parse(fs.readFileSync(L3_STATE_PATH, 'utf8'));
      }
    } catch (_) {}
    // §1.4 fix (Prime Agent 风格: harness 启动即有 baseline, 不空转):
    // 老 state 文件可能 weights:{} (旧版本没填), 检测到就重填默认权重, 别让 L3 永远空转
    if (!_loaded) {
      const _defaultWeights = this._discoverDefaultRoles();
      return {
        weights: _defaultWeights,
        taskToAgents: {},
        toolSets: {},
        lastUpdated: null,
      };
    }
    // 2026-10-18: 这里原来有一整段"加载期把英文键迁成拼音"的代码 (含先迁移
    // 再回填的顺序讲究、_migrated 丢键也置位的坑)。**已删**。
    //
    // 删的理由和 modules/subagent_runs.js 里那张 LEGACY_RUN_CODE 一样: 磁盘上
    // 这份 l3_state.json 的键**已经是拼音** (实测 {kan,li,kun,dui,xun,gen,zhen,qian}),
    // 唯一的写侧 (_discoverDefaultRoles / _computeWeights / _updateTaskMapping)
    // 也只写拼音, 所以这段迁移永远走不到。它唯一的作用是让英文键还能在别的
    // 机器/旧备份上混进来 —— 也就是老板说的「说了全部换, 还留着干嘛」。
    //
    // 万一真的捞回一份英文 state: 那是**数据**问题, 跑一次性迁移脚本, 不要在
    // 热路径上养一张常设表。scripts/migrate-run-codes-to-pinyin-20261018.js。
    //
    // 但"不翻译"不等于"不设防": 权重表只留**认得出来的角色键** (拼音/卦名)。
    // 捞回来一份英文 state 时, 那些键被丢掉 → 表空 → 下面回填默认值。
    // 这是 fail-closed, 不是兼容层: 它不含任何英文名字, 也不试图猜"analyzer
    // 大概是 li" —— 猜错了就是权重长到错的将灵头上, 那比清零更难查。
    const _resolve = require('./gua-identity').resolveRole;
    const _kept = Object.create(null);
    for (const [k, v] of Object.entries(_loaded.weights || {})) {
      const p = _resolve(k);
      if (p) _kept[p] = v;
    }
    _loaded.weights = _kept;
    if (!_loaded.weights || Object.keys(_loaded.weights).length === 0) {
      _loaded.weights = this._discoverDefaultRoles();
      _loaded._weightsBackfilled = Date.now();
    }
    return _loaded;
  }

  /**
   * §1.4 fix (Prime Agent 风格: harness 启动即有 baseline, 不空转):
   * 优先读 sub-agent.js 的 ROLES (权威 8 角色), 失败兜底硬编码
   * 这样 self-monitor tick 能看到非空 weights, L3 反馈回路不再「形同虚设」
   */
  _discoverDefaultRoles() {
    const defaults = {};
    // 主路径: require sub-agent.js 拿权威 ROLES
    try {
      const mod = require(path.join(__dirname, 'sub-agent.js'));
      const roles = (mod && mod.ROLES) || {};
      for (const role of Object.keys(roles)) {
        if (role && !defaults[role]) defaults[role] = 0.5;
      }
    } catch (_) { /* require 失败走兜底 */ }
    // 兜底: 8 将灵 (拼音就是唯一身份, 这里不许再抄一份英文名单 ——
    // 抄出来的那份和上面遍历到的 ROLES 键永远对不上, 等于给每个角色凭空多出
    // 一条 0.5 权重的假记录, L3 学到的权重因此一直是错的)。
    const _coreRoles = require('./gua-identity').GUA_CODES;
    for (const r of _coreRoles) {
      if (!defaults[r]) defaults[r] = 0.5;
    }
    return defaults;
  }
  
  _loadSuggestions() {
    try {
      if (fs.existsSync(PROMPT_SUGGESTIONS_PATH)) {
        return JSON.parse(fs.readFileSync(PROMPT_SUGGESTIONS_PATH, 'utf8'));
      }
    } catch (_) {}
    return [];
  }
  
  _save() {
    try {
      fs.writeFileSync(L3_STATE_PATH, JSON.stringify(this.state, null, 2));
      fs.writeFileSync(PROMPT_SUGGESTIONS_PATH, JSON.stringify(this.promptSuggestions, null, 2));
    } catch (_) {}
  }
  
  /**
   * 主入口:跑一次 L3 闭环(每次任务结束调用)
   */
  async runCycle() {
    const learnerData = GenAgent.getLearnData();
    
    // 4 个组件
    this._computeWeights(learnerData);
    this._updateTaskMapping(learnerData);
    this._suggestPromptImprovements(learnerData);
    this._optimizeToolSets(learnerData);
    
    this.state.lastUpdated = Date.now();
    this._save();
    
    return {
      weights: this.state.weights,
      taskToAgents: this.state.taskToAgents,
      pending_prompts: this.promptSuggestions.length,
      last_updated: this.state.lastUpdated,
    };
  }
  
  /**
   * L3.1 角色权重自适应
   * 公式:weight = 0.5 + 0.5 * success_rate (50% baseline + 50% 历史)
   * 失败率 < 30% 时 weight 降到 0.4 (避免反复调失败 agent)
   */
  _computeWeights(learnerData) {
    const perf = learnerData.agentPerformance || {};
    const experiences = learnerData.experiences || [];

    // 从 experiences 推导 agentPerformance（兼容老 learner 不输出 perf 的情况）
    if (Object.keys(perf).length === 0 && experiences.length > 0) {
      for (const exp of experiences) {
        const results = exp.results || {};
        for (const [agentName, result] of Object.entries(results)) {
          // 只认拼音, 认不出就**丢掉**, 不给权重表长出 ROLES 里不存在的键。
          // 2026-10-18: 这里原来还挂着一张 {analyze:'li', execute:'kun', check:'dui'}
          // 的动词表。已删 —— 它守着的是一个活路径根本到不了的输入 (exp.results
          // 在实跑里恒为空: pangu_decide 传的是字符串, dogfood 的 fullReport 里
          // 也没有 results 字段), 而留着它就等于留着第二套英文身份。
          const role = require('./gua-identity').resolveRole(agentName);
          if (!role) continue;
          if (!perf[role]) perf[role] = { invocations: 0, successes: 0 };
          perf[role].invocations++;
          if (result.status === 'success' || result.pass === true) perf[role].successes++;
        }
      }
    }

    const newWeights = {};
    
    for (const role of Object.keys(perf)) {
      const p = perf[role];
      if (!p || p.invocations < 1) {
        newWeights[role] = 0.5; // 默认
        continue;
      }
      
      const successRate = p.successes / p.invocations;
      const weight = 0.5 + 0.5 * successRate;
      
      // 高失败率降权
      if (successRate < 0.3 && p.invocations >= 3) {
        newWeights[role] = 0.4;
      } else {
        newWeights[role] = parseFloat(weight.toFixed(3));
      }
    }
    
    // 2026-09-12 修 (老板 PANGU_SCAN_REPORT_20260912 B2): 空数据不覆盖 — 保留旧权重/回填默认值,
    // 否则每 60s tick 把状态清成 {} → L3 自进化闭环形同虚设。
    if (Object.keys(newWeights).length > 0) {
      this.state.weights = { ...(this.state.weights || {}), ...newWeights };
    }
  }
  
  /**
   * L3.2 任务 → agent 组合 映射学习
   * 对每个 taskPattern,找出最常用的 agent 组合
   * 至少 ≥ 3 次才记录
   */
  _updateTaskMapping(learnerData) {
    const patterns = learnerData.taskPatterns || {};
    const experiences = learnerData.experiences || [];
    
    // 按 pattern 分组,统计 agent 组合
    const patternAgents = {};
    
    for (const exp of experiences) {
      const pattern = this._inferPattern(exp.task);
      if (!patternAgents[pattern]) {
        patternAgents[pattern] = {};
      }
      
      // 防御 agents_used 缺失：从 results keys 推断
      let agentsUsed = Array.isArray(exp.agents_used) ? exp.agents_used : Object.keys(exp.results || {});
      if (agentsUsed.length === 0) agentsUsed = ['li'];
      
      const key = agentsUsed.slice().sort().join(',');
      if (!patternAgents[pattern][key]) {
        patternAgents[pattern][key] = { count: 0, pass_count: 0, total_pass_score: 0 };
      }
      
      const stat = patternAgents[pattern][key];
      stat.count++;
      // 防御 pass 缺失：从 synthesis 推断
      const pass = exp.pass !== undefined ? exp.pass : (exp.synthesis?.pass || false);
      if (pass) stat.pass_count++;
      stat.total_pass_score += (exp.quality_score || exp.synthesis?.quality_score || 0);
    }
    
    // 只保留 ≥ 3 次的组合
    const newMapping = {};
    for (const [pattern, combos] of Object.entries(patternAgents)) {
      const validCombos = Object.entries(combos)
        .filter(([_, stat]) => stat.count >= 3)
        .sort((a, b) => {
          const scoreA = (a[1].pass_count / a[1].count) + (a[1].total_pass_score / a[1].count / 200);
          const scoreB = (b[1].pass_count / b[1].count) + (b[1].total_pass_score / b[1].count / 200);
          return scoreB - scoreA;
        });
      
      if (validCombos.length > 0) {
        const best = validCombos[0];
        newMapping[pattern] = {
          agents: best[0].split(','),
          stats: {
            count: best[1].count,
            pass_rate: (best[1].pass_count / best[1].count).toFixed(3),
            avg_quality_score: (best[1].total_pass_score / best[1].count).toFixed(1),
          },
        };
      }
    }
    
    // 2026-09-12 修 (B2 同型): 空映射不覆盖, 保留已有学习成果。
    if (Object.keys(newMapping).length > 0) {
      this.state.taskToAgents = { ...(this.state.taskToAgents || {}), ...newMapping };
    }
  }
  
  /**
   * L3.3 Prompt 自改进建议
   * 失败率 ≥ 30% 且 5 次以上的 agent → 触发 prompt 改进
 * 不直接改 Pangu 源码,只写到 prompt_suggestions.json,等老板 OK
   */
  _suggestPromptImprovements(learnerData) {
    const perf = learnerData.agentPerformance || {};
    const newSuggestions = [];
 // #12: 自进化无界 — 加长度 cap + 自动 rollback
    const MAX_SUGGESTIONS = 20;
    if (this.promptSuggestions.length >= MAX_SUGGESTIONS) {
      console.warn('[l3] prompt_suggestions cap reached, auto-rollback to empty');
      this.promptSuggestions = [];
    }

    for (const [role, p] of Object.entries(perf)) {
      if (!p || p.invocations < 5) continue;

      const successRate = p.successes / p.invocations;
      if (successRate < 0.7) {
        // 已有 suggestion 且未解决?
        const existing = this.promptSuggestions.find(s => s.role === role && s.status === 'pending');

        if (!existing) {
          newSuggestions.push({
            role,
            type: 'low_success_rate',
            success_rate: successRate.toFixed(3),
            invocations: p.invocations,
            suggestion: this._generatePromptSuggestion(role, successRate),
            status: 'pending',
            created_at: Date.now(),
          });
        }
      }
    }

    if (newSuggestions.length > 0) {
      this.promptSuggestions = [
        ...this.promptSuggestions.filter(s => s.status === 'pending'),
        ...newSuggestions,
      ];
    }
  }
  
  /**
   * L3.4 工具集自调整
   * 跟 agent 实际使用的 tool 关联(简化版,不追踪)
   * 这里只验证框架,实际数据来自后续 integration
   */
  _optimizeToolSets(learnerData) {
    // 占位:简化版不实际调整,只记录 last_updated
    // 完整版需要 hook agent.execute 收集 tool_calls
    this.state.toolSets = this.state.toolSets || {};
    this.state.toolSets['_last_updated'] = Date.now();
  }
  
  _inferPattern(task) {
    const t = (task || '').toLowerCase();
    if (/写|build|create|实现|开发|做/.test(t)) return 'feature_implementation';
    if (/检查|test|review|评审/.test(t)) return 'code_review';
    if (/风险|assess|risk/.test(t)) return 'risk_assessment';
    if (/架构|architecture/.test(t)) return 'architecture_decision';
    if (/修|fix/.test(t)) return 'bug_fix';
    if (/安全|security/.test(t)) return 'security_audit';
    return 'simple_query';
  }
  
  _generatePromptSuggestion(role, successRate) {
    const suggestions = {
      'kun': `成功率 ${(successRate * 100).toFixed(0)}%,建议:
- 加更明确的错误处理指引
- 减少危险命令(rm、sudo)
- 加确认步骤(高风险操作)`,
      'li': `成功率 ${(successRate * 100).toFixed(0)}%,建议:
- 增强 query 关键词 → 卦ID 映射
- 多 query 给 fallback 建议
- 加 confidence 阈值过滤低 confidence 结果`,
      'dui': `成功率 ${(successRate * 100).toFixed(0)}%,建议:
- 加更多代码规范检查
- 提高 security pattern 召回率
- 加 language-specific 检查`,
      'xun': `成功率 ${(successRate * 100).toFixed(0)}%,建议:
- 加更多漏洞规则
- 减少 false positive(更严匹配)`,
      'kan': `成功率 ${(successRate * 100).toFixed(0)}%,建议:
- 扩 task pattern 关键词
- 加更多场景任务类型`,
      'zhen': `成功率 ${(successRate * 100).toFixed(0)}%,建议:
- 加更细粒度评分
- 引入 LLM 二次评`,
      'qian': `成功率 ${(successRate * 100).toFixed(0)}%,建议:
- 用 L3 state.taskToAgents 推荐 agent 组合`,
      'gen': `成功率 ${(successRate * 100).toFixed(0)}%,建议:
- 增加经验数据维度`,
    };
    return suggestions[role] || `成功率 ${(successRate * 100).toFixed(0)}%,需要 review`;
  }
  
  /**
 * 应用 prompt 改进(老板批准后调用)
   */
  applyPromptSuggestion(role, approved) {
    this.promptSuggestions = this.promptSuggestions.map(s => {
      if (s.role === role && s.status === 'pending') {
        return { ...s, status: approved ? 'approved' : 'rejected', applied_at: Date.now() };
      }
      return s;
    });
    this._save();
  }
  
  /**
   * 获取当前状态(给前端展示)
   */
  getState() {
    return {
      weights: this.state.weights,
      taskToAgents: this.state.taskToAgents,
      promptSuggestions: this.promptSuggestions.filter(s => s.status === 'pending'),
      lastUpdated: this.state.lastUpdated,
    };
  }
}

module.exports = { L3Loop };
