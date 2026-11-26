// 2026-09-12 新增 (老板 PANGU_SCAN_REPORT_20260912 §5 + §6 L2): 任务级检查点
// 跟文件级 checkpoint.js 互补 — checkpoint.js 存 messages (LLM 上下文)
// task_checkpoint.js 存任务进度结构 (goal / plan / done / pending / files_touched / next_action)
// → 跨 round 续跑 (maxRounds 触发 compact 后) / 跨进程重启 / 跨 daemon 续跑都不丢
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
const TASK_DIR = process.env.PANGU_TASK_DIR || path.join(DEFAULT_PANGU_HOME, 'state', 'tasks');
const TASK_STALE_MS = parseInt(process.env.PANGU_TASK_STALE_MS || String(7 * 24 * 60 * 60 * 1000), 10); // 7 天

function ensureDir() { try { fs.mkdirSync(TASK_DIR, { recursive: true }); } catch (_) {} }

// 2026-10-25 (第 92 批): session id → 落盘文件名的唯一真源收成 modules/session_key.js。
//   原来这里有自己一份 _safeSid 拷贝, 各账各写一份 ⇒ 同一个 sid 在不同账里
//   落到不同文件名; 且清洗后不含字母数字的 sid ('!!!' / '@@@') 全落同一个文件,
//   两个不同 session 互相覆盖。
//   resolveSessionKey = 纯清洗 (存量零改名) + 真撞名时才换指纹名 (不覆盖别人的账)。
const { resolveSessionKey } = require('./session_key');

function taskFile(sessionId) {
  return path.join(TASK_DIR, resolveSessionKey(TASK_DIR, sessionId) + '.json');
}

/**
 * 保存/更新 task checkpoint
 * @param {string} sessionId
 * @param {object} state { goal, plan, done: [], pending: [], files_touched: [], next_action, status, ... }
 * @returns {{ok: boolean, path?: string}}
 */
function saveTaskCheckpoint(sessionId, state = {}) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  try {
    ensureDir();
    const file = taskFile(sessionId);
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
    const payload = {
      ...prev,
      ...state,
      session_id: sessionId,
      ts: Date.now(),
      schema: 1,
    };
    const tmp = file + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, path: file };
  } catch (e) {
    console.warn('[task-checkpoint] save failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * 加载 task checkpoint (用于续跑注入)
 * @returns {object|null}
 */
function loadTaskCheckpoint(sessionId) {
  if (!sessionId) return null;
  try {
    const file = taskFile(sessionId);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - (data.ts || 0) > TASK_STALE_MS) return null;
    return data;
  } catch (_) { return null; }
}

function shouldResumeTaskCheckpoint(checkpoint, userInput, now = Date.now()) {
  return !!(
    checkpoint &&
    checkpoint.status === 'active' &&
    checkpoint.ts &&
    now - checkpoint.ts < 30 * 60 * 1000 &&
    String(userInput || '').includes('【续跑约束】')
  );
}

/**
 * 列出所有 active 任务 (status != done/failed), 启动时扫描用于恢复
 */
function listActiveTasks() {
  try {
    ensureDir();
    const files = fs.readdirSync(TASK_DIR).filter(f => f.endsWith('.json'));
    const out = [];
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(TASK_DIR, f), 'utf8'));
        if (data.status && data.status !== 'done' && data.status !== 'failed' && data.status !== 'cleared') {
          if (Date.now() - (data.ts || 0) < TASK_STALE_MS) {
            out.push({ ...data, _file: f });
          }
        }
      } catch (_) {}
    }
    return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  } catch (_) { return []; }
}

function clearTaskCheckpoint(sessionId) {
  try {
    const file = taskFile(sessionId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// 2026-10-13 (现场 session=r10-live-1): files_touched_count 原来只按工具名白名单
// ['write_file','file_edit','apply_patch'] 数写盘, 但盘古真写盘的主力是 exec_command
// (shell 重定向) —— 全量 286 条 checkpoint 统计 exec_command 467 次 vs write_file 26 次 (18:1),
// 于是 94.7% 的真写盘对该字段隐身, 只有 7% 的会话记录到过 >0。
// 后果: j2_agent_loop 的 auto_resume 进展判据 和 budget.js 的压缩续命判据 同时恒 false
//       → 长任务预算永不按进展重置, 且每次压缩都扣额度, 会话最终永久死。
// 根因不是判据写错, 是判据读错了数据源: task_ledger 早已把 exec_command 写盘记进
// facts.files_written, state_card.js 也一直在用它 —— 只有 checkpoint 没用。
// 修法: 账本作唯一真源, 工具名白名单降级为账本缺失时的兜底。
function countFilesTouched(sessionId, toolsUsed) {
  // 父 + 子账本一起算: 走 dispatcher 的父会话自己没有账本, 只读它会恒得 0
  // (子 agent 真写盘 → 父会话被判零进展 → 长任务预算永不重置)。
  let n = 0;
  try {
    n = require('./task_ledger').countWrittenEvents(sessionId) || 0;
  } catch (_) {}
  if (n > 0) return n;
  // 兜底: 账本还没落盘 (首轮) 时用工具名白名单, 保证旧路径不退化
  const wl = (Array.isArray(toolsUsed) ? toolsUsed : [])
    .filter(n2 => ['write_file', 'file_edit', 'apply_patch'].includes(n2)).length;
  return Math.max(n, wl);
}

// 进展判据专用: **不同**文件数, 不是写盘事件数。
// 事件数会被「反复重写同一批文件」灌水 (现场 done 0→0 而 files 12→130),
// 于是每轮都判成有进展 → 预算反复重置 → 子 agent 锁死在重复循环。
// 细节与有界取舍见 task_ledger.countDistinctWrittenFiles 的注释。
function countDistinctFilesTouched(sessionId, toolsUsed) {
  try {
    const n = require('./task_ledger').countDistinctWrittenFiles(sessionId) || 0;
    if (n > 0) return n;
  } catch (_) {}
  const wl = (Array.isArray(toolsUsed) ? toolsUsed : [])
    .filter(n2 => ['write_file', 'file_edit', 'apply_patch'].includes(n2)).length;
  return wl;
}

module.exports = {
  saveTaskCheckpoint, loadTaskCheckpoint, listActiveTasks, clearTaskCheckpoint,
  shouldResumeTaskCheckpoint, countFilesTouched, countDistinctFilesTouched,
  _paths: { TASK_DIR, TASK_STALE_MS },
};
