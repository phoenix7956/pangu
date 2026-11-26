/**
 * Pangu 2.0 L3 自进化
 * 流程: L1 数据 → L2 矿工 → L3 优化 → 写回 Pangu
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');
// 2026-10-26 第 100 批: L1 账本目录走唯一真源 (modules/evolution_paths.js)。
// 原来这里自己拼 `path.join(panguDataHome, 'evolution')` —— 写方 (evolution_record.js)
// 认沙箱开关, 读方不认 ⇒ 写进沙箱、却从生产读, 测试结论全是假的。
const { evolutionDir } = require('../modules/evolution_paths');
const DEFAULT_PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');

class SelfEvolution {
  constructor() {
    this.panguDataHome = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
    this.evolutionDir = evolutionDir();
    this.reportDir = path.join(this.panguDataHome, 'state', 'evolution');
    // agents/ -> core/ -> apps/ -> repository root
    this.repoRoot = path.resolve(__dirname, '..', '..', '..');
  }

  // L3 流程入口 (每日跑一次)
  async evolve() {
    console.log('🧬 Pangu 2.0 自进化开始...\n');
    
    // 1. 读 L1 数据 (今日)
    const l1Data = this.readL1();
    
    // 2. 跑 L2 矿工 (复用 evolution_miner.js)
    const insights = this.runL2Miner(l1Data);
    
    // 3. 根据洞察优化 Pangu
    const optimizations = await this.applyOptimizations(insights);
    
    // 4. 报告
    const report = {
      timestamp: new Date().toISOString(),
      l1Records: l1Data.length,
      insights: insights,
      optimizations: optimizations,
      nextRun: this.nextDaily()
    };
    const saved = this.saveReport(report);
    if (!saved.ok) report.reportError = saved.error;
    return report;
  }

  readL1() {
    const today = new Date().toISOString().split('T')[0];
    const file = path.join(this.evolutionDir, `${today}.jsonl`);
    if (!fs.existsSync(file)) return [];
    const invalid = [];
    const records = fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((line, index) => ({ line, index: index + 1 }))
      .filter(({ line }) => line.trim())
      .map(({ line, index }) => {
        try { return JSON.parse(line); }
        catch (error) { invalid.push({ line: index, error: error.message }); return null; }
      })
      .filter(Boolean);
    if (invalid.length) console.warn(`[self-evolution] skipped ${invalid.length} invalid L1 record(s)`);
    return records;
  }

  runL2Miner(l1Data) {
 // TODO[§0.31 silent failure]: evolution_miner.js 之前没写过或被删，当前 silent skip
 //   L2 矿工原本应该在 self-evolution.js 启动后，对 L1 数据做模式聚合 (tool_usage / error_rate / latency)
 //   现在 L2 mining 整个被吞 → Pangu 自进化不会产出 L3 洞察
 // 修法: 写 scripts/evolution_miner.js (artifact: 死磕 L1 JSONL → 聚合 → 输出 insights)
 //   或下一轮 spec 这个 miner
 // 临时代偿: 直接走下方的内联 insight 聚合
    try {
      const minerScript = path.join(this.repoRoot, 'scripts', 'evolution_miner.js');
      if (fs.existsSync(minerScript)) {
        execSync(process.execPath + ' ' + JSON.stringify(minerScript), { cwd: this.repoRoot, stdio: 'pipe' });
      } else {
        console.warn('[self-evolution] evolution_miner.js missing — running inline L2 stats');
      }
    } catch (e) { console.warn('[self-evolution] L2 miner failed; inline stats retained:', e.message); }

    // 也跑内联统计
    const insights = [];
    
    if (l1Data.length === 0) {
      insights.push({ level: 'L3', type: 'no_data', message: '今日无 L1 数据' });
      return insights;
    }
    
    // 工具使用统计
    const toolUsage = {};
    l1Data.forEach(r => {
      (r.tool_names || []).forEach(t => {
        toolUsage[t] = (toolUsage[t] || 0) + 1;
      });
    });
    
    const topTool = Object.entries(toolUsage).sort((a, b) => b[1] - a[1])[0];
    if (topTool) {
      insights.push({
        level: 'L3',
        type: 'tool_freq',
        message: `最常用工具: ${topTool[0]} (${topTool[1]} 次)`,
        action: '优化该工具的响应速度'
      });
    }
    
    // 失败率分析
    const failRate = l1Data.filter(r => !r.success).length / l1Data.length;
    if (failRate > 0.1) {
      insights.push({
        level: 'L3',
        type: 'high_failure',
        message: `失败率 ${(failRate * 100).toFixed(1)}% (阈值 10%)`,
        action: '分析失败 case, 增加重试或参数校验'
      });
    }
    
    // 平均轮数
    const avgRounds = l1Data.reduce((s, r) => s + (r.rounds || 0), 0) / l1Data.length;
    if (avgRounds > 4) {
      insights.push({
        level: 'L3',
        type: 'high_rounds',
        message: `平均 ${avgRounds.toFixed(1)} 轮 (目标 <3)`,
        action: '优化 prompt, 让 LLM 更直接'
      });
    }
    
    return insights;
  }

  async applyOptimizations(insights) {
    const optimizations = [];
    
    for (const insight of insights) {
      const opt = await this.applyInsight(insight);
      if (opt) optimizations.push(opt);
    }
    
    return optimizations;
  }

  async applyInsight(insight) {
 // 自我进化: 用 LLM 提议修改 → 写入提案 → 等老板审核
    const proposal = {
      timestamp: new Date().toISOString(),
      insight: insight.message,
      action: insight.action,
      level: insight.level,
      status: 'pending_review', // 需人工复核
      autoApplied: false
    };
    
    // 写提案到 .learnings/
    const proposalFile = path.join(this.reportDir, 'proposals', `${Date.now()}.json`);
    const proposalDir = path.dirname(proposalFile);
    if (!fs.existsSync(proposalDir)) {
      fs.mkdirSync(proposalDir, { recursive: true });
    }
    fs.writeFileSync(proposalFile, JSON.stringify(proposal, null, 2));
    
    return { insight: insight.message, proposalFile };
  }

  // 2026-08-16 P2-1: 自进化增强 — dry-run 健康检查 + auto-improve + rollback
  async dryRun() {
    const tasks = [
      { name: 'health', check: () => ({ ok: true, msg: 'self-evolution loaded' }) },
      { name: 'checkpoints_recent', check: () => {
        try {
          const ckDir = path.join(this.panguDataHome, 'checkpoints');
          if (!fs.existsSync(ckDir)) return { ok: true, count: 0 };
          const files = fs.readdirSync(ckDir).filter(f => f.endsWith('.json'));
          const recent = files.filter(f => {
            try { return Date.now() - fs.statSync(path.join(ckDir, f)).mtimeMs < 7 * 86400 * 1000; }
            catch (_) { return false; }
          });
          return { ok: true, count: recent.length, total: files.length };
        } catch (e) { return { ok: false, error: e.message }; }
      }},
      { name: 'outcomes_recent', check: () => {
        try {
          // 2026-10-26 第 100 批: 走沙箱导出的 outcomes 目录 (原来绕过了 PANGU_OUTCOMES_DIR)
          const outDir = process.env.PANGU_OUTCOMES_DIR || path.join(DEFAULT_PANGU_HOME, 'state', 'outcomes');
          if (!fs.existsSync(outDir)) return { ok: true, count: 0 };
          const files = fs.readdirSync(outDir).filter(f => f.endsWith('.jsonl'));
          let completed = 0, failed = 0;
          for (const f of files) {
            try {
              for (const line of fs.readFileSync(path.join(outDir, f), 'utf8').split('\n').filter(Boolean)) {
                const d = JSON.parse(line);
                if (d.status === 'completed') completed++;
                else if (d.status === 'failed') failed++;
              }
            } catch (_) {}
          }
          const total = completed + failed;
          const failRate = total > 0 ? failed / total : 0;
          return { ok: failRate < 0.5, completed, failed, fail_rate: failRate };
        } catch (e) { return { ok: false, error: e.message }; }
      }},
    ];
    const results = [];
    for (const t of tasks) {
      try { results.push({ name: t.name, ...t.check() }); }
      catch (e) { results.push({ name: t.name, ok: false, error: e.message }); }
    }
    const allOk = results.every(r => r.ok);
    return { ok: allOk, ts: Date.now(), results };
  }

  /**
   * Auto-improve: 读最近失败 outcome, 生成 proposal (不自动 apply — 需主人批)
   */
  // 2026-08-16 P0-A 升级: 字改进真改! 不再"写 proposals 等主人批", 直接调 refine.applyHarnessDelta
  // 把近期失败 outcome 喂给 LLM 提 lesson → 写入 harness state (supplemental, 可 snapshot rollback)
  async autoImprove(options = {}) {
    const refine = require('./refine');
    const result = await refine.applyHarnessDelta({ sinceMs: options.sinceMs || 7 * 86400 * 1000 });
    return {
      ok: result.ok,
      mode: 'apply-harness-delta', // 标注: 真改, 不是写 proposals
      applied: result.applied || 0,
      pre_snapshot: result.pre_snapshot,
      failures_analyzed: result.applied > 0 ? 'see refine trajectory' : 0,
      message: result.message,
      error: result.error,
    };
  }

  getLastReport() {
    try {
      const reportFile = path.join(this.reportDir, 'last-report.json');
      if (!fs.existsSync(reportFile)) return null;
      return JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    } catch (e) { return null; }
  }

  saveReport(report) {
    try {
      if (!fs.existsSync(this.reportDir)) fs.mkdirSync(this.reportDir, { recursive: true });
      fs.writeFileSync(path.join(this.reportDir, 'last-report.json'), JSON.stringify(report, null, 2));
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  nextDaily() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(23, 0, 0, 0);
    return tomorrow.toISOString();
  }

 // 老板批准后自动应用
  async approveAndApply(proposalFile) {
    const proposal = JSON.parse(fs.readFileSync(proposalFile, 'utf8'));
    if (proposal.status !== 'pending_review') throw new Error('proposal is not pending_review');
    const patch = proposal.patch;
    if (!patch || !patch.file || typeof patch.oldText !== 'string' || typeof patch.newText !== 'string') {
      throw new Error('proposal.patch required: {file, oldText, newText}');
    }
    const target = path.resolve(this.repoRoot, patch.file);
    if (!target.startsWith(this.repoRoot + path.sep)) throw new Error('patch file outside repo');
    const relativeTarget = path.relative(this.repoRoot, target);
    try {
      const dirty = execFileSync('git', ['status', '--porcelain', '--', relativeTarget], { cwd: this.repoRoot, encoding: 'utf8' }).trim();
      if (dirty) throw new Error('patch target has uncommitted changes');
    } catch (error) {
      if (error.message === 'patch target has uncommitted changes') throw error;
      throw new Error('could not verify patch target: ' + error.message);
    }
    const source = fs.readFileSync(target, 'utf8');
    if (!source.includes(patch.oldText)) throw new Error('patch oldText not found');
    fs.writeFileSync(target, source.replace(patch.oldText, patch.newText));
    const appliedAt = Date.now();
    const { globalStats } = require('../modules/outcome_tracker');
    const before = globalStats({ sinceTs: appliedAt - 7 * 86400 * 1000, untilTs: appliedAt });
    proposal.status = 'approved';
    proposal.approvedAt = new Date().toISOString();
    proposal.effect_baseline = before;
    proposal.effect_window_started_at = appliedAt;
    fs.writeFileSync(proposalFile, JSON.stringify(proposal, null, 2));
    const { selfIterate } = require('../modules/tools/self_iterate');
    const result = await selfIterate({
      note: 'approved evolution proposal: ' + (proposal.insight || patch.file).slice(0, 160),
      files: [relativeTarget],
    });
    if (!result.ok) {
      fs.writeFileSync(target, source);
      proposal.status = 'pending_review';
      proposal.applyError = result.error;
      delete proposal.effect_baseline;
      delete proposal.effect_window_started_at;
    }
    proposal.iteration = result;
    fs.writeFileSync(proposalFile, JSON.stringify(proposal, null, 2));
    return { ...proposal, ok: !!result.ok };
  }

  async evaluateAppliedProposal(proposalFile, options = {}) {
    const proposal = JSON.parse(fs.readFileSync(proposalFile, 'utf8'));
    const baseline = proposal.effect_baseline;
    if (!baseline) return { ok: false, error: 'effect baseline missing' };
    const current = require('../modules/outcome_tracker').globalStats({ sinceTs: proposal.effect_window_started_at });
    const minTasks = Number(options.minTasks || 5);
    if (current.tasks_total < minTasks) return { ok: true, pending: true, baseline, current };
    const completionDrop = baseline.completed_rate - current.completed_rate;
    const failureRise = (current.failed / Math.max(1, current.tasks_total)) - (baseline.failed / Math.max(1, baseline.tasks_total));
    const degraded = completionDrop > 0.15 || failureRise > 0.15;
    if (degraded && proposal.iteration && proposal.iteration.result && proposal.iteration.result.rollback_target) {
      const appliedCommit = proposal.iteration.result.committed;
      try {
        execFileSync('git', ['revert', '--no-edit', appliedCommit], { cwd: this.repoRoot, stdio: 'ignore' });
      } catch (error) {
        proposal.status = 'rollback_requires_manual_resolution';
        proposal.rollbackError = error.message;
        fs.writeFileSync(proposalFile, JSON.stringify(proposal, null, 2));
        return { ok: false, rolled_back: false, error: 'revert failed; manual resolution required', baseline, current, completionDrop, failureRise };
      }
      const { selfIterate } = require('../modules/tools/self_iterate');
      const restart = await selfIterate({ restart_only: true, note: 'restart after evolution rollback' });
      proposal.status = 'rolled_back_effect_gate';
      proposal.rollbackAt = new Date().toISOString();
      proposal.rollbackCommit = true;
      proposal.restartAfterRollback = restart;
      fs.writeFileSync(proposalFile, JSON.stringify(proposal, null, 2));
      return { ok: !!restart.ok, rolled_back: true, baseline, current, completionDrop, failureRise, restart };
    }
    proposal.status = 'accepted_effect_gate';
    fs.writeFileSync(proposalFile, JSON.stringify(proposal, null, 2));
    return { ok: true, rolled_back: false, baseline, current, completionDrop, failureRise };
  }
}

module.exports = new SelfEvolution();
