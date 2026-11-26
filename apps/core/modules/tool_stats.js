// modules/tool_stats.js — — #3 全动态策略核心
// 工具健康度追踪: 失败率高的工具自动降权 + 注入到 executor system prompt
// 在 _j2ExecuteToolCalls 调用后 record
// 持久化: 进程内 + 落盘 ~/.pangu/tool_stats.json (防重启清零)

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATS_FILE = path.join(os.homedir(), '.pangu', 'tool_stats.json');
const MAX_RECENT = 20;            // 每个工具最近 20 次调用
const MIN_CALLS_FOR_REPORT = 3;   // 至少 3 次才进报告
const FAIL_RATE_THRESHOLD = 30;   // 失败率 ≥ 30% 才列入报告
const RECENT_WINDOW = 10;         // 看最近 10 次算失败率
const SAVE_THROTTLE_MS = 5000;    // 5s 内多次失败只写一次 (避免高频 I/O)

let _stats = _loadStats();
let _lastSave = 0;

function _loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    }
  } catch (_) {}
  return {};
}

function _saveStatsThrottled() {
  const now = Date.now();
  if (now - _lastSave < SAVE_THROTTLE_MS) return;
  _lastSave = now;
  try {
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(_stats, null, 2));
  } catch (_) {}
}

function _trim(arr) {
  if (arr.length > MAX_RECENT) arr.splice(0, arr.length - MAX_RECENT);
}

function recordSuccess(name) {
  if (!name) return;
  if (!_stats[name]) _stats[name] = { recent: [], success: 0, failure: 0 };
  _stats[name].recent.push({ ok: true, ts: Date.now() });
  _stats[name].success++;
  _trim(_stats[name].recent);
  _saveStatsThrottled();
}

function recordFailure(name, errorInfo) {
  if (!name) return;
  if (!_stats[name]) _stats[name] = { recent: [], success: 0, failure: 0 };
  const errCode = (errorInfo && typeof errorInfo === 'object') ? (errorInfo.code || 'unknown')
                 : (typeof errorInfo === 'string' ? errorInfo.slice(0, 100) : 'unknown');
  _stats[name].recent.push({ ok: false, ts: Date.now(), code: errCode });
  _stats[name].failure++;
  _trim(_stats[name].recent);
  _saveStatsThrottled();
}

// 返回 top-N 失败率最高的工具 (动态健康度报告, 注入 executor prompt)
function getReport(topN = 5) {
  const lines = [];
  for (const [name, s] of Object.entries(_stats)) {
    if (!s.recent || s.recent.length < MIN_CALLS_FOR_REPORT) continue;
    const recent = s.recent.slice(-RECENT_WINDOW);
    const failCount = recent.filter(r => !r.ok).length;
    const failRate = Math.round(failCount / recent.length * 100);
    if (failRate < FAIL_RATE_THRESHOLD) continue;
    lines.push({ name, failRate, recent: recent.length, failCount });
  }
  if (lines.length === 0) return '';
  lines.sort((a, b) => b.failRate - a.failRate);
  const top = lines.slice(0, topN).map(l => `- ${l.name}: ${l.failRate}% 失败 (最近 ${l.recent} 次, 失败 ${l.failCount})`).join('\n');
  return `\n\n[⚡ #3 动态工具健康度 — 失败率 ≥${FAIL_RATE_THRESHOLD}% 的工具, 优先避开, 用 Tier 1 确定性兜底]\n${top}\n`;
}

// TL-4 改造 (2026-07-23 11:35): shouldDemote + fallbackHint
// 失败率 ≥30% → shouldDemote(name) 返 true
// tier 2 失败 → fallbackHint() 返等价 tier 1 tool name
function shouldDemote(name) {
  const s = _stats[name];
  if (!s || !s.recent || s.recent.length < MIN_CALLS_FOR_REPORT) return false;
  const recent = s.recent.slice(-RECENT_WINDOW);
  const failCount = recent.filter(r => !r.ok).length;
  const failRate = failCount / recent.length;
  return failRate >= FAIL_RATE_THRESHOLD / 100;
}

// TL-4 改造: tier 2 失败切 tier 1 fallback
const _tier2Fallback = {
  computer_use_vision_act: 'exec_command',
  computer_use_click: 'exec_command',
  computer_use_type: 'write_file',
  computer_use_key: 'exec_command',
  computer_use_drag: 'exec_command',
  screenshot: 'exec_command',
  take_photo: 'read_file',  // H7 修: 之前是 'file_read' 不存在, 调就 TypeError
  record_audio: 'exec_command',     // H8 修: transcribe_audio 不在 ALLOWED_TOOLS, 改 exec_command
  permission_apply: 'permission_check',
};
function fallbackHint(toolName) {
  return _tier2Fallback[toolName] || null;
}

// 给 sandbox/Pangu UI 看的内部接口 — 不是给 LLM 看
function getFullStats() {
  return JSON.parse(JSON.stringify(_stats));
}

// 测试/重置
function _reset() {
  _stats = {};
  _lastSave = 0;
  try { if (fs.existsSync(STATS_FILE)) fs.unlinkSync(STATS_FILE); } catch (_) {}
}

module.exports = {
  recordSuccess,
  recordFailure,
  getReport,
  getFullStats,
  shouldDemote,
  fallbackHint,
  _reset,
  _saveStatsThrottled,  // 暴露供 SIGTERM 时调用
};
