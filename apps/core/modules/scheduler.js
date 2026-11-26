// apps/core/modules/scheduler.js
// 盘古 · 调度器 / Scheduler (Prime Agent heartbeat + schedule 对位)
// 支持 cron 表达式 (5-field: min hour dom mon dow) + one-shot (ISO 时间戳)
// 持久化到 ~/.pangu/state/scheduler/jobs.json
// 默认任务: 每天 03:00 跑 refine.dryRun (自治自检, 替代 launchd plist)
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
const JOBS_FILE = path.join(DEFAULT_PANGU_HOME, 'state', 'scheduler', 'jobs.json');
const LOG_FILE = path.join(DEFAULT_PANGU_HOME, 'state', 'scheduler', 'log.jsonl');
function localDateKey(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function ensureDirs() {
  try { fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch (_) {}
}

function _atomicWrite(file, content) {
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function _newId() {
  return 'job_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

function _loadJobs() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return [];
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch (_) { return []; }
}

function _saveJobs(jobs) {
  ensureDirs();
  _atomicWrite(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function _logRun(jobId, status, detail) {
  try {
    ensureDirs();
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      job_id: jobId,
      status,
      detail: detail || '',
    });
    fs.appendFileSync(LOG_FILE, entry + '\n');
  } catch (_) {}
}

// cron 5-field: 分 时 日 月 周 (支持 * , - /)
// 简化版, 不支持 L W # (够用)
function _matchCron(expr, date) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [min, hour, dom, mon, dow] = fields;
  const checks = [
    [date.getMinutes(), min, 0, 59],
    [date.getHours(), hour, 0, 23],
    [date.getDate(), dom, 1, 31],
    [date.getMonth() + 1, mon, 1, 12],
    [date.getDay(), dow, 0, 6],
  ];
  for (const [val, expr, minV, maxV] of checks) {
    if (!_matchField(val, expr, minV, maxV)) return false;
  }
  return true;
}

function _matchField(val, expr, minV, maxV) {
  if (expr === '*') return true;
  // 列表: a,b,c
  for (const part of expr.split(',')) {
    // 步长: a-b/n 或 */n
    const stepMatch = part.match(/^(\*|\d+-\d+)\/(\d+)$/);
    if (stepMatch) {
      const [, range, step] = stepMatch;
      let start, end;
      if (range === '*') { start = minV; end = maxV; }
      else { const [s, e] = range.split('-').map(Number); start = s; end = e; }
      for (let v = start; v <= end; v += parseInt(step, 10)) {
        if (v === val) return true;
      }
      continue;
    }
    // 范围: a-b
    if (part.includes('-')) {
      const [s, e] = part.split('-').map(Number);
      if (val >= s && val <= e) return true;
      continue;
    }
    // 单值
    if (parseInt(part, 10) === val) return true;
  }
  return false;
}

// 计算 next fire (cron 模式)
function _nextCronFire(expr, fromDate) {
  // 最长回扫 366 天
  const start = fromDate ? new Date(fromDate.getTime()) : new Date();
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1); // 至少下一分钟
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const d = new Date(start.getTime() + i * 60000);
    if (_matchCron(expr, d)) return d;
  }
  return null;
}

// 注册 cron job
function addCronJob({ name, cron, action, payload }) {
  if (!cron || !action) return { ok: false, error: 'cron and action required' };
  const jobs = _loadJobs();
  const job = {
    id: _newId(),
    type: 'cron',
    name: name || ('cron-' + cron),
    cron,
    action,
    payload: payload || {},
    created_at: new Date().toISOString(),
    last_run: null,
    last_status: null,
    next_run: (_nextCronFire(cron, new Date()) || {}).toISOString(),
    enabled: true,
    run_count: 0,
  };
  jobs.push(job);
  _saveJobs(jobs);
  return { ok: true, job };
}

// 注册 one-shot job
function addOneShotJob({ name, run_at, action, payload }) {
  if (!run_at || !action) return { ok: false, error: 'run_at and action required' };
  const jobs = _loadJobs();
  const job = {
    id: _newId(),
    type: 'oneshot',
    name: name || ('oneshot-' + run_at),
    run_at,
    action,
    payload: payload || {},
    created_at: new Date().toISOString(),
    last_run: null,
    last_status: null,
    next_run: run_at,
    enabled: true,
    run_count: 0,
  };
  jobs.push(job);
  _saveJobs(jobs);
  return { ok: true, job };
}

function listJobs() {
  const jobs = _loadJobs();
  // 更新 next_run (懒计算)
  const now = new Date();
  for (const j of jobs) {
    if (!j.enabled) continue;
    if (j.type === 'cron') {
      const n = _nextCronFire(j.cron, now);
      j.next_run = n ? n.toISOString() : null;
    } else if (j.type === 'oneshot') {
      j.next_run = j.run_at;
    }
  }
  return jobs.sort((a, b) => (a.next_run || '').localeCompare(b.next_run || ''));
}

function getJob(id) {
  return _loadJobs().find(j => j.id === id) || null;
}

function removeJob(id) {
  const jobs = _loadJobs();
  const next = jobs.filter(j => j.id !== id);
  if (next.length === jobs.length) return { ok: false, error: 'job not found' };
  _saveJobs(next);
  return { ok: true, removed: id, remaining: next.length };
}

function pauseJob(id) {
  return _setJobEnabled(id, false);
}
function resumeJob(id) {
  return _setJobEnabled(id, true);
}
function _setJobEnabled(id, enabled) {
  const jobs = _loadJobs();
  const j = jobs.find(x => x.id === id);
  if (!j) return { ok: false, error: 'job not found' };
  j.enabled = enabled;
  _saveJobs(jobs);
  return { ok: true, job: j };
}

// 执行内置 action (只支持盘古内置的, 沙箱边界清晰)
// action 形式: 'refine.dryRun' | 'evolution.dryRun' | 'compaction.run' | 'shell:<cmd>' (沙箱接管)
async function _runJobAction(action, payload) {
  if (action === 'pangu.self_train') {
    const until = payload && payload.until ? new Date(payload.until) : null;
    if (until && Date.now() >= until.getTime()) return { ok: true, skipped: true, reason: 'training_window_expired' };
    const script = path.join(__dirname, '..', 'scripts', 'self_train_cycle.js');
    const output = path.join(DEFAULT_PANGU_HOME, 'training', localDateKey(), 'manifest.json');
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [script, 'prepare', '--source', path.join(DEFAULT_PANGU_HOME, 'evolution'), '--output', output], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      child.stdout.on('data', d => { out += d.toString(); }); child.stderr.on('data', d => { err += d.toString(); });
      child.on('close', code => resolve({ ok: code === 0, code, output: out.slice(-2000), error: err.slice(-1000), manifest: output }));
    });
  }
  if (action === 'pangu.self_train_report') {
    const until = payload && payload.until ? new Date(payload.until) : null;
    if (until && Date.now() >= until.getTime()) return { ok: true, skipped: true, reason: 'training_window_expired' };
    const day = payload && payload.date ? payload.date : localDateKey();
    const manifest = path.join(DEFAULT_PANGU_HOME, 'training', day, 'manifest.json');
    const reportFile = path.join(DEFAULT_PANGU_HOME, 'training', day, 'daily-report.json');
    if (!fs.existsSync(manifest)) return { ok: false, reason: 'manifest_missing', manifest };
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const m = (data.metrics && (data.metrics.all || data.metrics.evaluation)) || {};
    const report = { schema: 'pangu-self-training/daily-report/v1', date: day, generated_at: new Date().toISOString(), status: data.status || 'unknown', counts: data.counts || {}, metrics: m, gates: data.gates || null, source_sha256: data.source_sha256 || null };
    writeReport(reportFile, report);
    return { ok: true, report, file: reportFile };
  }
  if (action === 'refine.dryRun') {
    const evolutionMod = require('../agents/self-evolution');
    return await evolutionMod.dryRun();
  }
  if (action === 'evolution.dryRun') {
    const evolutionMod = require('../agents/self-evolution');
    return await evolutionMod.dryRun();
  }
  if (action === 'evolution.autoImprove') {
    const evolutionMod = require('../agents/self-evolution');
    return await evolutionMod.autoImprove(payload || { sinceMs: 7 * 86400 * 1000 });
  }
  if (action === 'evolution.evaluateProposal') {
    const evolutionMod = require('../agents/self-evolution');
    return await evolutionMod.evaluateAppliedProposal(payload && payload.proposal_file, payload || {});
  }
  if (action === 'pangu.self_reflect') {
    const evolutionMod = require('../agents/self-evolution');
    const report = await evolutionMod.evolve();
    const file = path.join(DEFAULT_PANGU_HOME, 'self', 'assessment.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# Pangu 自我反思\n\n- 时间: ${report.timestamp}\n- L1 记录: ${report.l1Records}\n- 洞察: ${report.insights.length}\n- 优化提案: ${report.optimizations.length}\n\n${report.insights.map(i => `- ${i.message || i.type}`).join('\n')}\n`);
    // 2026-09-13 P3b (老板: 进化要闭环 — 失败侧): 接任务账本 — 聚合全部教训 kind,
    // 生成回归守卫测试 (每个死因 kind 必须在源码里有守卫, 新死法无守卫 = 测试红)。
    let _ledgerGuard = null;
    try { _ledgerGuard = require('./ledger_reflect').reflectLessons(); } catch (e) { _ledgerGuard = { ok: false, error: e.message }; }
    return { ok: true, report, file, ledger_guard: _ledgerGuard };
  }
  if (action === 'pangu.consolidate') {
    const evolutionMod = require('../agents/self-evolution');
    const report = evolutionMod.getLastReport();
    const file = path.join(DEFAULT_PANGU_HOME, 'self', 'lessons.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# Pangu Lessons\n\n更新时间: ${new Date().toISOString()}\n\n${report ? JSON.stringify(report.insights || [], null, 2) : '暂无已保存的自进化报告。'}\n`);
    return { ok: true, file };
  }
  if (action === 'pangu.inbox_scan') {
    const inbox = path.resolve((payload && payload.inbox_dir || path.join(DEFAULT_PANGU_HOME, 'inbox')).replace(/^~(?=\/|$)/, os.homedir()));
    const learned = path.resolve((payload && payload.learned_dir || path.join(DEFAULT_PANGU_HOME, 'learned')).replace(/^~(?=\/|$)/, os.homedir()));
    fs.mkdirSync(learned, { recursive: true });
    if (!fs.existsSync(inbox)) return { ok: true, moved: 0, message: 'inbox missing' };
    const files = fs.readdirSync(inbox).filter(f => !f.startsWith('.'));
    let moved = 0;
    for (const file of files) { fs.renameSync(path.join(inbox, file), path.join(learned, file)); moved++; }
    return { ok: true, moved };
  }
  if (action === 'pangu.observe') {
    const file = path.join(DEFAULT_PANGU_HOME, 'self', 'borrowed', 'principles.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# Borrowed Principles\n\n观察时间: ${new Date().toISOString()}\n\n当前暂无自动采纳的外部原则。\n`);
    return { ok: true, file };
  }
  if (action === 'compaction.run') {
    const compactionMod = require('./compaction');
    const msgs = (payload && payload.messages) || [];
    return await compactionMod.compact(msgs, { sessionId: (payload && payload.session_id) || 'scheduled' });
  }
  // 2026-10-30 (第 173 批): 集群健康检查 —— 从 openclaw 接收。
  //   旧版是 openclaw 的 cron 作业 (agentTurn, 靠模型跑脚本 + 发微信告警),
  //   openclaw 退休后没主人了 ⇒ 搬进盘古 scheduler。
  //   口径**不依赖模型**: 直接跑脚本, 只信退出码 (0=ok / 2=warn / 1=err),
  //   跟旧 cron 的 message 描述完全一致 ("只信 exit code")。
  //   注意: 老 cron 的描述写「每小时」实际是 0 9,21 * * * ⇒ 这里按真实口径注册。
  if (action === 'pangu.cluster_healthcheck') {
    // __dirname = apps/core/modules ⇒ 上三级才是 repo 根 (apps/core → apps → repo)
    const script = path.join(__dirname, '..', '..', '..', 'scripts', 'pangu-cluster-healthcheck.sh');
    if (!fs.existsSync(script)) {
      return { error: 'script_missing', script };
    }
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: (payload && payload.timeout_ms) || 120000 });
    const code = r.status === null ? -1 : r.status;
    // 退出码契约: 0=全 ok / 2=有 warn 不致命 / 1=真错 / 其他=脚本自己挂了
    const verdict = code === 0 ? 'ok' : code === 2 ? 'warn' : 'error';
    const out = String(r.stdout || '');
    const summary = (out.match(/汇总:.*$/m) || [''])[0].trim();
    const overall = (out.match(/^Overall:\s*(\S+)/m) || ['', ''])[1];
    return {
      ok: verdict === 'ok' || verdict === 'warn',
      verdict,
      exit_code: code,
      overall,
      summary,
      report: out,
      stderr: String(r.stderr || '').slice(0, 500),
    };
  }
  return { error: 'unknown action: ' + action };
}

function writeReport(file, report) {
  ensureDirs();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  _atomicWrite(file, JSON.stringify(report, null, 2) + '\n');
  const textFile = file.replace(/\.json$/, '.md');
  const m = report.metrics || {};
  fs.writeFileSync(textFile, `# 盘古训练日报 ${report.date}\n\n- 状态: ${report.status}\n- 总样本: ${m.total ?? '-'}\n- 有效样本率: ${m.eligible_rate != null ? (m.eligible_rate * 100).toFixed(2) + '%' : '-'}\n- 成功率: ${m.success_rate != null ? (m.success_rate * 100).toFixed(2) + '%' : '-'}\n- 工具调用率: ${m.tool_rate != null ? (m.tool_rate * 100).toFixed(2) + '%' : '-'}\n- 答非所问率: ${m.alignment_block_rate != null ? (m.alignment_block_rate * 100).toFixed(2) + '%' : '-'}\n- 虚假工具锁率: ${m.fake_tool_lock_rate != null ? (m.fake_tool_lock_rate * 100).toFixed(2) + '%' : '-'}\n- 计划未执行率: ${m.plan_only_rate != null ? (m.plan_only_rate * 100).toFixed(2) + '%' : '-'}\n- 平均奖励: ${m.reward_mean ?? '-'}\n`);
}

// 主动 tick: 检查 + 触发到期 jobs
async function tick() {
  const jobs = _loadJobs();
  const now = new Date();
  let fired = 0;
  for (const j of jobs) {
    if (!j.enabled) continue;
    let shouldFire = false;
    if (j.type === 'cron') {
      // 每分钟 tick, _matchCron 用秒=0 检查当分钟
      if (_matchCron(j.cron, now) && (!j.last_run || (now - new Date(j.last_run)) > 60000)) {
        shouldFire = true;
      }
    } else if (j.type === 'oneshot') {
      if (!j.last_run && now >= new Date(j.run_at)) shouldFire = true;
    }
    if (!shouldFire) continue;
    fired++;
    j.last_run = now.toISOString();
    j.run_count++;
    try {
      const r = await _runJobAction(j.action, j.payload);
      j.last_status = (r && r.ok) ? 'ok' : 'fail';
      _logRun(j.id, j.last_status, JSON.stringify(r).slice(0, 500));
    } catch (e) {
      j.last_status = 'error';
      _logRun(j.id, 'error', e.message);
    }
  }
  if (fired > 0) _saveJobs(jobs);
  return { fired, total: jobs.length };
}

// 默认启动器: 注册每天 03:00 的 refine.dryRun (若未注册)
function ensureDefaults() {
  const jobs = _loadJobs();
  const has = jobs.find(j => j.action === 'refine.dryRun' && j.cron === '0 3 * * *');
  if (has) return { ok: true, message: 'default already exists', job: has, training: ensureSelfTraining().job, training_report: ensureSelfTrainingReport().job };
  const r = addCronJob({
    name: '每天 03:00 跑 refine dryRun (自治自检, 替代 launchd plist)',
    cron: '0 3 * * *',
    action: 'refine.dryRun',
  });
  const training = ensureSelfTraining();
  const trainingReport = ensureSelfTrainingReport();
  return { ok: true, added: r.ok ? r.job.id : null, training: training.job ? training.job.id : null, training_report: trainingReport.job ? trainingReport.job.id : null, message: 'default added' };
}

// Daily local self-training window, active for 30 days from first registration.
function ensureSelfTraining() {
  const jobs = _loadJobs();
  const existing = jobs.find(j => j.action === 'pangu.self_train' && j.name === '盘古本机自我训练 03:00-08:00');
  if (existing) {
    let changed = false;
    if (existing.cron !== '0,30 3-7 * * *') { existing.cron = '0,30 3-7 * * *'; changed = true; }
    if (!existing.payload || existing.payload.mode !== 'local-policy-only') { existing.payload = { ...(existing.payload || {}), mode: 'local-policy-only' }; changed = true; }
    if (changed) { existing.next_run = (_nextCronFire(existing.cron, new Date()) || {}).toISOString(); _saveJobs(jobs); }
    return { ok: true, job: existing, message: changed ? 'self-training updated' : 'self-training already exists' };
  }
  const until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const r = addCronJob({ name: '盘古本机自我训练 03:00-08:00', cron: '0,30 3-7 * * *', action: 'pangu.self_train', payload: { until, mode: 'local-policy-only' } });
  return { ok: r.ok, job: r.job || null, until, message: 'self-training registered' };
}

function ensureSelfTrainingReport() {
  const jobs = _loadJobs();
  const existing = jobs.find(j => j.action === 'pangu.self_train_report' && j.name === '盘古每日训练统计 08:05');
  const training = jobs.find(j => j.action === 'pangu.self_train');
  const until = training && training.payload && training.payload.until;
  if (existing) {
    if (until && (!existing.payload || existing.payload.until !== until)) { existing.payload = { ...(existing.payload || {}), until, mode: 'daily-report' }; _saveJobs(jobs); }
    return { ok: true, job: existing };
  }
  return addCronJob({ name: '盘古每日训练统计 08:05', cron: '5 8 * * *', action: 'pangu.self_train_report', payload: { mode: 'daily-report', until } });
}

// 后台 tick loop (启动时调一次)
let _loopStarted = false;
function startLoop(intervalMs = 60000) {
  if (_loopStarted) return { ok: true, message: 'already started' };
  _loopStarted = true;
  ensureDefaults();
  const timer = setInterval(async () => {
    try { await tick(); } catch (e) { console.warn('[scheduler] tick error:', e.message); }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return { ok: true, interval_ms: intervalMs };
}

module.exports = {
  addCronJob, addOneShotJob, listJobs, getJob, removeJob, pauseJob, resumeJob, ensureSelfTraining, ensureSelfTrainingReport,
  tick, ensureDefaults, startLoop, _runJobAction,
  _paths: { JOBS_FILE, LOG_FILE },
  // 测试用
  _matchCron, _nextCronFire,
};
