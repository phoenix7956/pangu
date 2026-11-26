/**
 * modules/task_output.js
 * 盘古 · TaskOutput 异步后台任务系统
 * 借鉴来源: ClaudeCode Leaked §9.3 (BashTool.tsx + TaskOutputTool) — W1-Borrow-03
 *
 * 设计:
 *  - 长期 shell / 子 agent / 安装任务 → 立即返 task_id, 不阻塞 LLM turn
 *  - LLM 收到 task_id → 下次轮询 task_output(task_id)
 *  - 输出超过 100K char → 自动写盘 pangu/output_files/{task_id}.txt, LLM 看 output_file_path
 *  - thread pool: 同时跑 8 个 (可配)
 *  - 任务状态: queued / running / completed / failed / killed
 *
 * 严守 §9 Pangu 独立原则: 本模块只用 Pangu 内部模块, 不引外部 agent 框架
 * 不动 64 卦内核: 不修改 hexagram_vector.js / yao_models.js / 64i/* 任何文件
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PANGU_BASE = path.resolve(__dirname, '..');
const OUTPUT_FILES_DIR = path.join(PANGU_BASE, 'output_files');

// ============================================================
// 配置
// ============================================================

const CONFIG = {
  // thread pool: 同一时刻最多跑 N 个后台任务
  MAX_CONCURRENT: 8,
  // 单任务 stdout+stderr buffer 上限 (byte) — 超过即落盘
  INLINE_MAX_CHARS: 100 * 1024,  // 100K char
  // 任务结果在内存里保留时长 (ms) — 30 分钟
  TASK_TTL_MS: 30 * 60 * 1000,
  // 默认 kill 宽限 (ms) — SIGTERM 后等 SIGKILL 的时间
  KILL_GRACE_MS: 5000,
  // 进度更新节流 (ms) — 写 progressMessage 频度
  PROGRESS_THROTTLE_MS: 250,
};

// ============================================================
// 内存任务表 — task_id → TaskState
// LRU 上限 — 防恶意 task_id 撑爆内存
const MAX_TASKS = 500;
// ============================================================
const _tasks = new Map();
function _evictOldestTask() {
  while (_tasks.size >= MAX_TASKS) {
    const oldest = _tasks.keys().next().value;
    if (!oldest) break;
    _tasks.delete(oldest);
  }
}

// 输出目录确保存在
try { fs.mkdirSync(OUTPUT_FILES_DIR, { recursive: true }); } catch (_) {}

// ============================================================
// 状态机 / 工具
// ============================================================

function newTaskId() {
  return 't_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

function nowIso() { return new Date().toISOString(); }

function ensureTask(id) {
  const t = _tasks.get(id);
  if (!t) return null;
  // TTL 检查 — 已结束的任务超 30 分钟自动清
  if (t.status !== 'running' && t.status !== 'queued') {
    if (Date.now() - t.endedAt > CONFIG.TASK_TTL_MS) {
      _tasks.delete(id);
      return null;
    }
  }
  return t;
}

function activeRunningCount() {
  let n = 0;
  for (const t of _tasks.values()) if (t.status === 'running') n++;
  return n;
}

function progressMessage(t) {
  const stdout = t.stdoutBuf.length;
  const stderr = t.stderrBuf.length;
  return `[${t.id}] ${t.status} | ${t.commandName} | ${stdout}+${stderr} chars | ${t.elapsed()}ms`;
}

// ============================================================
// 任务调度 — thread pool 简化实现 (信号量)
// ============================================================
let _wakeupResolver = null;
function wakeupPool() { if (_wakeupResolver) { const r = _wakeupResolver; _wakeupResolver = null; r(); } }

async function acquireSlot() {
  while (activeRunningCount() >= CONFIG.MAX_CONCURRENT) {
    await new Promise((resolve) => { _wakeupResolver = resolve; });
  }
}

function releaseSlot() { wakeupPool(); }

// ============================================================
// 文件 fallback — 超过 100K char 落盘
// ============================================================

function spillToFile(t) {
  try {
    const filePath = path.join(OUTPUT_FILES_DIR, t.id + '.txt');
    const fd = fs.openSync(filePath, 'w');
    fs.writeSync(fd, '=== STDOUT ===\n' + t.stdoutBuf + '\n\n=== STDERR ===\n' + t.stderrBuf);
    fs.closeSync(fd);
    t.outputFilePath = filePath;
    t.outputFileSize = t.stdoutBuf.length + t.stderrBuf.length;
    // 落盘后清空内存 buffer (省内存)
    t.stdoutBuf = '';
    t.stderrBuf = '';
    return filePath;
  } catch (e) {
    t.error = t.error || 'spill_to_file failed: ' + e.message;
    return null;
  }
}

function appendBuf(t, stream, chunk) {
  if (t[stream].length > CONFIG.INLINE_MAX_CHARS) {
    // 已落盘, 不再缓存
    return;
  }
  t[stream] += chunk;
  // 写 progress 节流
  const now = Date.now();
  if (now - (t._lastProgressAt || 0) > CONFIG.PROGRESS_THROTTLE_MS) {
    t._lastProgressAt = now;
    t.progressMessage = progressMessage(t);
    if (t.onProgress) try { t.onProgress(t); } catch (_) {}
  }
  // 满 100K 触发 spill
  if (t.stdoutBuf.length > CONFIG.INLINE_MAX_CHARS || t.stderrBuf.length > CONFIG.INLINE_MAX_CHARS) {
    spillToFile(t);
  }
}

// ============================================================
// 启动后台任务
// ============================================================

/**
 * 启动一个后台 shell / 命令任务, 立即返 task_id
 * @param {object} opts
 *   command: str (要跑的 shell 命令, 走 /bin/sh -c)
 *   args: array (execFile 参数, 互斥 command)
 *   commandName: str (展示用)
 *   toolName: str (调用方, e.g. "exec_command" / "run_installer" / "sub_agent")
 *   cwd: str (工作目录)
 *   env: object (附加环境变量)
 *   timeoutMs: number (单任务超时)
 *   meta: object (附加元数据, 不影响逻辑)
 *   onProgress: function(t) (可选, 节流调用)
 * @returns {object} { task_id, status: 'queued' | 'running', progressMessage }
 */
function startTask(opts) {
  if (!opts || (!opts.command && !opts.args)) {
    throw new Error('startTask: command or args required');
  }
  const id = newTaskId();
  const t = {
    id,
    toolName: opts.toolName || 'unknown',
    commandName: opts.commandName || (opts.command ? opts.command.slice(0, 60) : (opts.args || []).join(' ').slice(0, 60)),
    status: 'queued',
    startedAt: Date.now(),
    endedAt: 0,
    exitCode: null,
    signal: null,
    error: null,
    stdoutBuf: '',
    stderrBuf: '',
    outputFilePath: null,
    outputFileSize: 0,
    progressMessage: '',
    _lastProgressAt: 0,
    _childProc: null,
    _killTimer: null,
    _onProgress: opts.onProgress || null,
    meta: opts.meta || {},
  };
  t.elapsed = () => Date.now() - t.startedAt;
  t.progressMessage = progressMessage(t);
  _evictOldestTask();  // 满了先 LRU 删老
  _tasks.set(id, t);

  // 排队 → 跑
  (async () => {
    await acquireSlot();
    runTask(t, opts).catch((e) => {
      t.status = 'failed';
      t.error = e.message;
      t.endedAt = Date.now();
      releaseSlot();
    });
  })();

  return {
    task_id: id,
    status: t.status,
    progressMessage: t.progressMessage,
  };
}

function runTask(t, opts) {
  return new Promise((resolve) => {
    t.status = 'running';
    t.progressMessage = progressMessage(t);

    let proc;
    try {
      if (opts.command) {
        // 走 shell, e.g. exec_command
        proc = spawn('/bin/sh', ['-c', opts.command], {
          cwd: opts.cwd || process.cwd(),
          env: { ...process.env, ...(opts.env || {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } else {
        // execFile 模式
        const [bin, ...args] = opts.args;
        proc = spawn(bin, args, {
          cwd: opts.cwd || process.cwd(),
          env: { ...process.env, ...(opts.env || {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
    } catch (e) {
      t.status = 'failed';
      t.error = 'spawn failed: ' + e.message;
      t.endedAt = Date.now();
      releaseSlot();
      resolve();
      return;
    }

    t._childProc = proc;

    // 超时
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      t._killTimer = setTimeout(() => {
        if (t.status === 'running') {
          try { proc.kill('SIGTERM'); } catch (_) {}
          setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, CONFIG.KILL_GRACE_MS);
          t.error = 'task killed: timeout ' + opts.timeoutMs + 'ms';
        }
      }, opts.timeoutMs);
    }

    proc.stdout.on('data', (chunk) => appendBuf(t, 'stdoutBuf', chunk.toString()));
    proc.stderr.on('data', (chunk) => appendBuf(t, 'stderrBuf', chunk.toString()));

    proc.on('error', (err) => {
      t.status = 'failed';
      t.error = 'proc error: ' + err.message;
      t.endedAt = Date.now();
      if (t._killTimer) clearTimeout(t._killTimer);
      releaseSlot();
      resolve();
    });

    proc.on('close', (code, signal) => {
      t.exitCode = code;
      t.signal = signal;
      t.endedAt = Date.now();
      if (t._killTimer) clearTimeout(t._killTimer);
      // 满 100K 强制 spill
      if (t.stdoutBuf.length > CONFIG.INLINE_MAX_CHARS || t.stderrBuf.length > CONFIG.INLINE_MAX_CHARS) {
        spillToFile(t);
      }
      if (t.status === 'running') {
        t.status = (code === 0) ? 'completed' : 'failed';
        if (code !== 0 && !t.error) t.error = 'exit code ' + code;
      }
      t.progressMessage = progressMessage(t);
      if (t._onProgress) try { t._onProgress(t); } catch (_) {}
      releaseSlot();
      resolve();
    });
  });
}

// ============================================================
// 查询 / 轮询 / 杀 — task_output 工具的接口
// ============================================================

/**
 * 查询一个任务的状态 + 输出
 * @param {string} taskId
 * @param {object} opts
 *   block: bool — true 时同步等任务结束 (或 waitMs 到期), false 立即返
 *   wait: bool — true 时 block 模式下等, 默认 true
 *   timeoutMs: number — block 等多久 (默认 30000)
 * @returns {object}
 *   { ok, task_id, status, exit_code, signal, error, progressMessage,
 *     stdout_preview, stderr_preview, output_file_path, output_file_size, elapsed_ms }
 */
function getOutput(taskId, opts = {}) {
  const t = ensureTask(taskId);
  if (!t) return { ok: false, error: 'task not found or expired: ' + taskId };

  const block = !!opts.block;
  const wait = opts.wait !== false;  // 默认 true (block 模式才生效)
  const timeoutMs = (opts.timeoutMs && opts.timeoutMs > 0) ? opts.timeoutMs : 30000;

  // 同步等 — 仅在 running/queued 且 block 且 wait
  if (block && wait && (t.status === 'running' || t.status === 'queued')) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const onUpdate = () => {
        const cur = ensureTask(taskId);
        if (!cur) { resolve({ ok: false, error: 'task expired during wait' }); return; }
        if (cur.status !== 'running' && cur.status !== 'queued') {
          resolve(snapshotTask(cur));
          return;
        }
        if (Date.now() >= deadline) {
          resolve(snapshotTask(cur));  // 超时也返当前 progress
          return;
        }
        setTimeout(onUpdate, 200);
      };
      onUpdate();
    });
  }

  return snapshotTask(t);
}

function snapshotTask(t) {
  const isInline = !t.outputFilePath;
  return {
    ok: true,
    task_id: t.id,
    tool_name: t.toolName,
    command_name: t.commandName,
    status: t.status,
    exit_code: t.exitCode,
    signal: t.signal,
    error: t.error,
    progress_message: progressMessage(t),
    elapsed_ms: t.endedAt ? (t.endedAt - t.startedAt) : (Date.now() - t.startedAt),
    started_at: new Date(t.startedAt).toISOString(),
    ended_at: t.endedAt ? new Date(t.endedAt).toISOString() : null,
    // inline 模式: 直接返 stdout/stderr (截 8K 预览); 落盘模式: 返 _preview + file path
    stdout_preview: isInline ? t.stdoutBuf.slice(-8192) : '(已落盘, 见 output_file_path)',
    stderr_preview: isInline ? t.stderrBuf.slice(-8192) : '(已落盘, 见 output_file_path)',
    stdout_chars: t.stdoutBuf.length,
    stderr_chars: t.stderrBuf.length,
    output_file_path: t.outputFilePath || null,
    output_file_size: t.outputFileSize || 0,
    is_final: (t.status === 'completed' || t.status === 'failed' || t.status === 'killed'),
  };
}

/**
 * 杀一个还在跑的任务
 * @returns {boolean}
 */
function killTask(taskId) {
  const t = ensureTask(taskId);
  if (!t) return false;
  if (t.status !== 'running' && t.status !== 'queued') return false;
  try {
    if (t._childProc) t._childProc.kill('SIGTERM');
    setTimeout(() => { try { if (t._childProc) t._childProc.kill('SIGKILL'); } catch (_) {} }, CONFIG.KILL_GRACE_MS);
    t.status = 'killed';
    t.error = 'killed by user';
    t.endedAt = Date.now();
    return true;
  } catch (_) {
    return false;
  }
}

function listTasks(limit = 50) {
  const arr = [];
  for (const t of _tasks.values()) arr.push(snapshotTask(t));
  arr.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
  return arr.slice(0, limit);
}

// ============================================================
// 同步执行 (兼容旧调用方 — exec_command / run_installer 仍能直接 await)
// ============================================================
function execSync_({ command, args, cwd, env, timeoutMs, toolName, commandName, onProgress }) {
  // 同步阻塞执行 — 用于 block: true 且 run_in_background: false 的兼容路径
  return new Promise((resolve) => {
    const t = {
      id: 'inline_' + Date.now().toString(36),
      toolName: toolName || 'inline',
      commandName: commandName || (command || (args || []).join(' ')).slice(0, 60),
      status: 'running',
      startedAt: Date.now(),
      endedAt: 0,
      exitCode: null,
      signal: null,
      error: null,
      stdoutBuf: '',
      stderrBuf: '',
      outputFilePath: null,
      outputFileSize: 0,
      progressMessage: '',
      _lastProgressAt: 0,
      _childProc: null,
      _killTimer: null,
    };
    t.elapsed = () => Date.now() - t.startedAt;
    t._onProgress = onProgress;

    let proc;
    try {
      if (command) {
        proc = spawn('/bin/sh', ['-c', command], {
          cwd: cwd || process.cwd(),
          env: { ...process.env, ...(env || {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } else {
        const [bin, ...rest] = args;
        proc = spawn(bin, rest, {
          cwd: cwd || process.cwd(),
          env: { ...process.env, ...(env || {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
    } catch (e) {
      resolve({ success: false, error: 'spawn failed: ' + e.message, exitCode: -1, stdout: '', stderr: '' });
      return;
    }

    if (timeoutMs && timeoutMs > 0) {
      t._killTimer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch (_) {}
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, CONFIG.KILL_GRACE_MS);
        t.error = 'killed: timeout';
      }, timeoutMs);
    }

    proc.stdout.on('data', (chunk) => appendBuf(t, 'stdoutBuf', chunk.toString()));
    proc.stderr.on('data', (chunk) => appendBuf(t, 'stderrBuf', chunk.toString()));

    proc.on('close', (code, signal) => {
      t.exitCode = code;
      t.signal = signal;
      t.endedAt = Date.now();
      if (t._killTimer) clearTimeout(t._killTimer);
      if (t.stdoutBuf.length > CONFIG.INLINE_MAX_CHARS || t.stderrBuf.length > CONFIG.INLINE_MAX_CHARS) {
        spillToFile(t);
      }
      resolve({
        success: code === 0 && !t.error,
        error: t.error,
        exitCode: code,
        signal,
        stdout: t.stdoutBuf,
        stderr: t.stderrBuf,
        outputFilePath: t.outputFilePath,
        outputFileSize: t.outputFileSize,
      });
    });

    proc.on('error', (err) => {
      t.endedAt = Date.now();
      if (t._killTimer) clearTimeout(t._killTimer);
      resolve({ success: false, error: err.message, exitCode: -1, stdout: t.stdoutBuf, stderr: t.stderrBuf });
    });
  });
}

module.exports = {
  // 异步后台
  startTask,
  getOutput,
  killTask,
  listTasks,
  // 同步阻塞 (兼容路径)
  execSync_,
  // 配置
  CONFIG,
  OUTPUT_FILES_DIR,
};
