/**
 * Pangu · Modules · Health
 * health.js — 盘古自我修复引擎（增强版）
 *
 * 新增功能：
 * - 三级内存响应（normal/high/critical）
 * - 重试指数退避（500ms → 32s）
 * - 前台/后台源分流（529错误处理）
 * - 多级降级机制
 * - Cleanup 注册表（进程退出时自动清理）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const net = require('net');

const execAsync = promisify(exec);

// 盘古工作目录
const PANGU_DIR = process.env.PANGU_HOME || path.resolve(__dirname, '..');
// 盘古自治: 默认 PANGU_HOME 为 ~/.pangu (已脱离一切外部框架路径)
const LOCK_FILE = path.join(PANGU_DIR, '.health.lock');
const CRASH_LOG = path.join(PANGU_DIR, '.crash.log');
const HEARTBEAT_FILE = path.join(PANGU_DIR, '.heartbeat');
const MAX_CRASHES_PER_HOUR = 5;

// ============================================================
// Cleanup 注册表（优雅关闭）
// ============================================================
const _cleanupFns = [];
function registerCleanup(fn) { _cleanupFns.push(fn); }
function runCleanup() {
  console.log('[Health] 执行清理注册表 (' + _cleanupFns.length + ' 个函数)...');
  for (const fn of _cleanupFns) {
    try { fn(); } catch (e) { console.warn('[Health] cleanup error:', e.message); }
  }
}
// 异步清理注册表（exit 事件只能做同步清理）
const _asyncCleanupFns = [];
function registerAsyncCleanup(fn) { _asyncCleanupFns.push(fn); }
async function runAsyncCleanup() {
  console.log('[Health] 执行异步清理 (' + _asyncCleanupFns.length + ' 个函数)...');
  for (const fn of _asyncCleanupFns) {
    try { await fn(); } catch (e) { console.warn('[Health] async cleanup error:', e.message); }
  }
}

// exit 仅做同步清理（如删除锁文件）
process.on('exit', () => {
  try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
});

// SIGTERM/SIGINT 做完整异步清理
process.on('SIGTERM', async () => { await runAsyncCleanup(); process.exit(0); });
process.on('SIGINT', async () => { await runAsyncCleanup(); process.exit(0); });

// ============================================================
// 指数退避（Retry Budget）
// ============================================================
class RetryBudget {
  constructor({ baseMs = 500, maxMs = 32000, budgetMs = 60000 } = {}) {
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.budgetMs = budgetMs;
    this.spent = 0;
    this.attempts = 0;
  }
  // 计算当前 delay（指数退避 + jitter）
  delayMs() {
    if (this.spent >= this.budgetMs) return null; // 已耗尽
    const exp = Math.min(this.maxMs, this.baseMs * Math.pow(2, this.attempts));
    const jitter = Math.random() * exp * 0.1;
    return Math.round(exp + jitter);
  }
  // 记录一次失败
  recordFailure() {
    this.attempts++;
    const d = this.delayMs() || this.maxMs;
    this.spent += d;
    return d;
  }
  reset() { this.spent = 0; this.attempts = 0; }
  canRetry() { return this.spent < this.budgetMs; }
}

// ============================================================
// 三级内存响应
// ============================================================
function getMemoryLevel(mb) {
  if (mb === null) return 'unknown';
  if (mb < 500) return 'normal';
  if (mb < 1000) return 'high';
  return 'critical';
}

// ============================================================
// 降级策略
// ============================================================
const _degradationLevel = { current: 'normal' };
function getDegradation() { return _degradationLevel.current; }
function setDegradation(level) {
  if (['normal', 'high', 'critical', 'minimal'].indexOf(level) < 0) return;
  if (level === _degradationLevel.current) return;
  _degradationLevel.current = level;
  console.log('[Health] 降级级别调整: ' + level);
}
function degradeOnHighLoad(memLevel) {
  if (memLevel === 'critical') setDegradation('critical');
  else if (memLevel === 'high') setDegradation('high');
  else setDegradation('normal');
}

// ============================================================
// 核心检查项
// ============================================================

async function getMemoryUsage() {
  try {
    const { stdout } = await execAsync(`ps -o rss= -p ${process.pid}`, { timeout: 5000 });
    const rssKb = parseInt(stdout.trim(), 10);
    return rssKb ? Math.round(rssKb / 1024) : null;
  } catch { return null; }
}

function checkEventLoopBlocked() {
  return new Promise((resolve) => {
    const start = Date.now();
    setImmediate(() => {
      const delay = Date.now() - start;
      resolve({ blocked: delay > 200, delayMs: delay });
    });
  });
}

// 端口检测缓存（避免每次 /health 都 fork lsof）
let _portCheckCache = { port: 0, ok: false, ts: 0 };
const PORT_CHECK_TTL_MS = 5000;

async function checkPortListening(port) {
  const now = Date.now();
  if (_portCheckCache.port === port && (now - _portCheckCache.ts) < PORT_CHECK_TTL_MS) {
    return _portCheckCache.ok;
  }
 // 修:原用 exec fork lsof 探测端口,但 Pangu 后端进程内 fork lsof 失败
  //   catch 静默 return false → port.listening 永远 false → Pangu UI 显示"未监听"+建议重启
  //   实际端口在 listen(lsof shell 测返 28646),纯属 Pangu 后端内部检测器 bug
  // 改用 net.connect 自连接探测:纯 node API,无需 fork,1ms 极快,跨平台
  // 优势:不会因 Pangu 沙箱 / launchd / 权限问题 fork 失败
  const ok = await new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    const finish = (v) => { if (resolved) return; resolved = true; try { socket.destroy(); } catch (_) {} resolve(v); };
    socket.setTimeout(2000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try { socket.connect(port, '127.0.0.1'); } catch (_) { finish(false); }
  });
  _portCheckCache = { port, ok, ts: now };
  return ok;
}

function checkCrashCount() {
  if (!fs.existsSync(CRASH_LOG)) return { count: 0, crashed: false };
  try {
    const content = fs.readFileSync(CRASH_LOG, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const oneHourAgo = Date.now() - 3600 * 1000;
    const recentCrashes = lines.filter(l => {
      const ts = parseInt(l.split('|')[0], 10);
      return ts > oneHourAgo;
    });
    return { count: recentCrashes.length, crashed: recentCrashes.length > 0 };
  } catch { return { count: 0, crashed: false }; }
}

function recordCrash(reason) {
  const entry = `${Date.now()}|${reason}`;
  try {
    fs.appendFileSync(CRASH_LOG, entry + '\n');
  } catch {}
}

function heartbeat(mem, loopOk) {
  try {
    const memLevel = getMemoryLevel(mem ? mem.mb : null);
    fs.writeFileSync(LOCK_FILE, JSON.stringify({
      pid: process.pid,
      uptime: process.uptime(),
      ts: Date.now(),
      mem: mem ? mem.mb : null,
      memLevel: memLevel,
      loopOk: loopOk,
      degradation: _degradationLevel.current
    }));
    const line = `${new Date().toISOString()}|${mem ? mem.mb : '?'}MB|loop=${loopOk ? 'ok' : 'lag'}|deg=${_degradationLevel.current}\n`;
    fs.appendFileSync(HEARTBEAT_FILE, line);
    return true;
  } catch { return false; }
}

function triggerRestart() {
  console.log('[Health] 触发重启策略...');
  recordCrash('health-triggered-restart');
  runCleanup();
  setTimeout(() => { process.exit(0); }, 1000);
}

// ============================================================
// 前台/后台源分流（来源标识）
// ============================================================
const _sourceTags = new Set();
function tagSource(tag) { _sourceTags.add(tag); }
function clearSource(tag) { _sourceTags.delete(tag); }
function isBackgroundSource() { return _sourceTags.has('background'); }

// ============================================================
// 主检查函数
// ============================================================

async function runHealthCheck(port = 18901) {
  const [mem, loop, portOk, crashInfo] = await Promise.all([
    getMemoryUsage(),
    checkEventLoopBlocked(),
    checkPortListening(port),
    Promise.resolve(checkCrashCount())
  ]);

  const memLevel = getMemoryLevel(mem);
  const memOk = mem === null || mem < 2000;
  const loopOk = !loop.blocked;
  const portListening = portOk;
  const healthy = memOk && loopOk && portListening;

  // 自动降级
  degradeOnHighLoad(memLevel);

  heartbeat({ mb: mem }, loopOk);

  return {
    ok: healthy,
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    memory: { mb: mem, ok: memOk, level: memLevel },
    eventLoop: { blocked: loop.blocked, delayMs: loop.delayMs, ok: loopOk },
    port: { listening: portListening, ok: portListening },
    crash: crashInfo,
    degradation: _degradationLevel.current,
    recommendations: buildRecommendations(memLevel, loop.blocked, portListening, crashInfo.count),
  };
}

// ============================================================
// 统一健康报告（Phase 4 统一 schema）
// ============================================================

/**
 * @param {number} port - 健康检查端口
 * @param {object} [bootInfo] - 启动信息 { mode, plan, license_ok, environment, skills_loaded, tools_loaded }
 */
async function getHealthReport(port = 18901, bootInfo = {}) {
  const report = await runHealthCheck(port);
  return {
    ok: report.ok,
    mode: bootInfo.mode || 'unknown',
    plan: bootInfo.plan || null,
    license_ok: bootInfo.license_ok !== undefined ? bootInfo.license_ok : true,
    environment: bootInfo.environment || 'unknown',
    data: {
      status: report.ok ? 'ok' : 'degraded',
      uptime_s: report.uptime,
      skills_loaded: bootInfo.skills_loaded || 0,
      tools_loaded: bootInfo.tools_loaded || 0,
      memory: report.memory,
      eventLoop: report.eventLoop,
      port: report.port,
      crash: report.crash,
      degradation: report.degradation,
      recommendations: report.recommendations,
    },
  };
}

function buildRecommendations(memLevel, loopBlocked, portListening, crashCount) {
  const recs = [];
  if (memLevel === 'high') recs.push({ level: 'warn', msg: '内存使用偏高（500MB-1GB）' });
  if (memLevel === 'critical') recs.push({ level: 'error', msg: '内存使用过高（>1GB），已触发降级' });
  if (loopBlocked) recs.push({ level: 'warn', msg: '事件循环响应变慢，请关注是否有同步阻塞操作' });
  if (!portListening) recs.push({ level: 'error', msg: 'HTTP端口无响应，需要重启进程' });
  if (crashCount >= 3) recs.push({ level: 'critical', msg: `最近1小时崩溃${crashCount}次，建议人工介入检查` });
  return recs;
}

async function shouldAutoRestart() {
  const crash = checkCrashCount();
  if (crash.count >= MAX_CRASHES_PER_HOUR) {
    return { should: true, reason: `Crash次数超限(${crash.count}/${MAX_CRASHES_PER_HOUR})` };
  }
  const port = await checkPortListening(18901);
  if (!port) {
    return { should: true, reason: 'HTTP端口无响应' };
  }
  return { should: false };
}

// ============================================================
// 指数退避重试（供外部使用）
// ============================================================
function createRetryBudget(opts) { return new RetryBudget(opts); }

module.exports = {
  runHealthCheck,
  shouldAutoRestart,
  heartbeat,
  recordCrash,
  triggerRestart,
  registerCleanup,
  runCleanup,
  getDegradation,
  setDegradation,
  createRetryBudget,
  tagSource,
  clearSource,
  isBackgroundSource,
  getMemoryLevel,
  getHealthReport,
};

// P1-9 (OPT-6): 用 net.connect 替代 lsof fork (解决 launchd 沙箱 fork 失败问题)
function _panguNetConnectCheck(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (!done) { done = true; try { sock.destroy(); } catch (_) {} resolve(ok); } };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, host); } catch (_) { finish(false); }
  });
}
