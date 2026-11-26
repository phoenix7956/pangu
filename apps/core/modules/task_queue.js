/**
 * Pangu · Task Queue Module（增强版）
 * 基于 SQLite 的任务队列，支持：
 * - 三级优先级（now/next/later）
 * - Cron jitter 防碰撞
 * - 容量上限
 * - 分布式锁（基于文件）
 */

'use strict';

const path = require('path');
const fs = require('fs');

// 确保 better-sqlite3 从 pangu/node_modules 加载
let _sqlite3 = null;
function loadSqlite3() {
  if (_sqlite3) return _sqlite3;
  const panguBase = path.resolve(__dirname, '..');
  const sqlite3Path = path.join(panguBase, 'node_modules', 'better-sqlite3');
  _sqlite3 = require(sqlite3Path);
  return _sqlite3;
}

// Tests and maintenance jobs can point at an isolated database without changing
// the production default used by the daemon.
const QUEUE_DB_PATH = process.env.PANGU_TASK_QUEUE_DB || path.join(path.resolve(__dirname, '..'), 'data', 'task_queue.db');

// 三级优先级
const PRIORITY = { NOW: 1, NEXT: 2, LATER: 3 };
const MAX_QUEUE_SIZE = 1000; // 容量上限
const JITTER_MAX_MS = 2000;  // Cron jitter 上限（防 thundering herd）

let _db = null;

function getDb() {
  if (_db) return _db;
  const sqlite = loadSqlite3();
  fs.mkdirSync(path.dirname(QUEUE_DB_PATH), { recursive: true });
  _db = new sqlite(QUEUE_DB_PATH);
  _db.pragma('journal_mode = WAL');
  initSchema();
  return _db;
}

function initSchema() {
  _db.exec(`
    -- 分布式锁表（SQLite 原子操作，替代文件锁）
CREATE TABLE IF NOT EXISTS task_locks (
  lock_name TEXT PRIMARY KEY,
  acquired_at TEXT NOT NULL,
  holder_pid INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL DEFAULT 'immediate',
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 3,
      run_at TEXT,
      jitter_ms INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      result TEXT,
      error TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3
    );
    CREATE INDEX IF NOT EXISTS idx_status_run_at ON tasks(status, run_at);
    CREATE INDEX IF NOT EXISTS idx_task_id ON tasks(task_id);
  `);
}

function nowISO() {
  return new Date().toISOString();
}

// 容量检查
function isFull() {
  const row = getDb().prepare(`SELECT COUNT(*) as c FROM tasks WHERE status='pending'`).get();
  return row.c >= MAX_QUEUE_SIZE;
}

// 添加 jitter
function applyJitter(runAt) {
  if (!runAt) return { runAt: null, jitterMs: 0 };
  const jitterMs = Math.floor(Math.random() * JITTER_MAX_MS);
  const ms = new Date(runAt).getTime() + jitterMs;
  return { runAt: new Date(ms).toISOString(), jitterMs };
}

// 分布式锁 — 用 SQLite INSERT OR IGNORE 原子操作替代文件锁（消除 TOCTOU 竞态）
function acquireLock(taskId, ttlMs = 30000) {
  const db = getDb();
  try {
    const result = db.prepare(
      'INSERT INTO task_locks (lock_name, acquired_at, holder_pid) VALUES (?, ?, ?) ON CONFLICT(lock_name) DO NOTHING'
    ).run(taskId, new Date().toISOString(), process.pid);
    return result.changes > 0;
  } catch (e) {
    console.warn('[task_queue] acquireLock failed:', e.message);
    return false;
  }
}

function releaseLock(taskId) {
  const db = getDb();
  try {
    db.prepare('DELETE FROM task_locks WHERE lock_name = ?').run(taskId);
    return true;
  } catch { return false; }
}

function enqueue(payload, options = {}) {
  if (isFull()) {
    return { ok: false, error: 'QUEUE_FULL', maxSize: MAX_QUEUE_SIZE };
  }
  const {
    taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    type = 'immediate',
    runAt = null,
    priority = PRIORITY.LATER,
    maxRetries = 3,
    jitter = false
  } = options;

  const { runAt: actualRunAt, jitterMs } = jitter ? applyJitter(runAt) : { runAt, jitterMs: 0 };

  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO tasks (task_id, type, payload, status, priority, run_at, jitter_ms, max_retries)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
  `);
  const result = stmt.run(taskId, type, JSON.stringify(payload), priority, actualRunAt, jitterMs, maxRetries);
  return { ok: result.changes > 0, taskId, jitterMs };
}

function dequeue(limit = 10) {
  return getDb().prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending'
      AND (run_at IS NULL OR run_at <= ?)
      AND retry_count < max_retries
    ORDER BY priority ASC, created_at ASC
    LIMIT ?
  `).all(nowISO(), limit);
}

function markRunning(taskId) {
  getDb().prepare(`UPDATE tasks SET status='running', started_at=? WHERE task_id=? AND status='pending'`)
    .run(nowISO(), taskId);
}

function markDone(taskId, result) {
  getDb().prepare(`UPDATE tasks SET status='done', completed_at=?, result=? WHERE task_id=?`)
    .run(nowISO(), JSON.stringify(result), taskId);
}

function markFailed(taskId, error) {
  const current = getDb().prepare(`SELECT retry_count, max_retries FROM tasks WHERE task_id=?`).get(taskId);
  if (!current) return;
  const count = (current.retry_count || 0) + 1;
  if (count >= current.max_retries) {
    getDb().prepare(`UPDATE tasks SET status='failed', completed_at=?, error=? WHERE task_id=?`)
      .run(nowISO(), String(error).slice(0, 1000), taskId);
  } else {
    getDb().prepare(`UPDATE tasks SET status='pending', retry_count=? WHERE task_id=?`)
      .run(count, taskId);
  }
}

function getStats() {
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) as c FROM tasks`).get().c;
  const pending = db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE status='pending'`).get().c;
  const running = db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE status='running'`).get().c;
  const done = db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE status='done'`).get().c;
  const failed = db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE status='failed'`).get().c;
  return { total, pending, running, done, failed, maxSize: MAX_QUEUE_SIZE };
}

function getTask(taskId) {
  const row = getDb().prepare(`SELECT * FROM tasks WHERE task_id=?`).get(taskId);
  if (!row) return null;
  return { ...row, payload: JSON.parse(row.payload), result: row.result ? JSON.parse(row.result) : null };
}

function cancelTask(taskId) {
  getDb().prepare(`DELETE FROM tasks WHERE task_id=? AND status IN ('pending','failed')`).run(taskId);
  return { ok: true };
}

function listTasks(status, limit = 50) {
  let sql = `SELECT task_id, type, status, priority, run_at, jitter_ms, created_at, retry_count FROM tasks`;
  const args = [];
  if (status) { sql += ` WHERE status=?`; args.push(status); }
  sql += ` ORDER BY priority ASC, created_at ASC LIMIT ?`;
  args.push(limit);
  return getDb().prepare(sql).all(...args);
}

// 按优先级列出待执行任务
function listByPriority(levels, limit = 20) {
  const placeholders = levels.map(() => '?').join(',');
  return getDb().prepare(`
    SELECT * FROM tasks
    WHERE status='pending' AND priority IN (${placeholders})
    ORDER BY priority ASC, created_at ASC LIMIT ?
  `).all(...levels, limit);
}

module.exports = {
  enqueue, dequeue, markRunning, markDone, markFailed,
  getStats, getTask, cancelTask, listTasks, listByPriority,
  acquireLock, releaseLock,
  getDb,
  isFull, PRIORITY, MAX_QUEUE_SIZE,
};
