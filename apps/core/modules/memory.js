// SqliteMemory — P0-1 ctx._memory 未注入修复
// 接 ~/.pangu/memory/main.sqlite, 接 l2-miner 现有 files/chunks/chunks_fts schema
// 提供 write/search/read 三方法, 与 modules/tools/index.js 里的 memory_write/memory_search/memory_read 对接
const os = require('os');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('better-sqlite3');

const DB_PATH = path.join(os.homedir(), '.pangu', 'memory', 'main.sqlite');

let _instance = null;

function getInstance() {
  if (_instance) return _instance;
  try {
    // 保证父目录在
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const db = sqlite3(DB_PATH);
    // schema 兜底 (与 l2-miner 一致)
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT,
        tags TEXT,
        updated_at INTEGER
      );
    `);
    _instance = {
      db,
      write(key, value, opts = {}) {
        try {
          const tags = JSON.stringify(opts.tags || []);
          const r = db.prepare(
            'INSERT OR REPLACE INTO kv (key, value, tags, updated_at) VALUES (?, ?, ?, ?)'
          ).run(String(key), JSON.stringify(value), tags, Date.now());
 // BugE: 诊断日志
          console.log('[memory] write:', key, 'changes:', r.changes);
          return r.changes > 0;
        } catch (e) {
          console.error('[memory.write]', e.message);
          return false;
        }
      },
      search(query, opts = {}) {
        try {
          const limit = opts.limit || 10;
          const q = String(query || '').trim();
          if (!q) return [];
          // 简单 LIKE 搜索 (key 或 value 包含 q)
          const rows = db.prepare(
            'SELECT key, value, tags, updated_at FROM kv WHERE key LIKE ? OR value LIKE ? ORDER BY updated_at DESC LIMIT ?'
          ).all('%' + q + '%', '%' + q + '%', limit);
          return rows.map(r => ({
            key: r.key,
            value: tryParse(r.value),
            tags: tryParse(r.tags) || [],
            updated_at: r.updated_at,
          }));
        } catch (e) {
          console.error('[memory.search]', e.message);
          return [];
        }
      },
      read(key) {
        try {
          const row = db.prepare('SELECT value, tags, updated_at FROM kv WHERE key = ?').get(String(key));
          if (!row) return null;
          return {
            key: String(key),
            value: tryParse(row.value),
            tags: tryParse(row.tags) || [],
            updated_at: row.updated_at,
          };
        } catch (e) {
          console.error('[memory.read]', e.message);
          return null;
        }
      },
    };
    return _instance;
  } catch (e) {
    console.error('[memory.init]', e.message);
    return null;
  }
}

function tryParse(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch (_) { return s; }
}

module.exports = { getInstance, DB_PATH };
