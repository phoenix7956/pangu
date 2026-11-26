// modules/memory_helpers.js — N5 refactor: 从 pangu-single.js 抽出
// 4 个 memory 系统函数：_recordSessionToMemory / _mergeSessionsIntoMemory / _dateOffset / _incrementalReindex
// 依赖：Node 内置 (fs/os/path/crypto) + better-sqlite3，零外部状态耦合（除 process.env.PANGU_TEST_MODE）

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 异步记录一次 session 到 ~/.pangu/memory/memory/sessions/{today}.md
// 同时触发 merge + incremental reindex
async function _recordSessionToMemory(reqBody, assistantContent, modelUsed) {
 // §0.13 dogfooding: PANGU_TEST_MODE=1 不写 session (干净测试状态)
  if (process.env.PANGU_TEST_MODE === '1') {
    console.log('[memory] TEST_MODE=1, skip session record');
    return true;
  }
  try {
    const memRoot = path.join(os.homedir(), '.pangu', 'memory');
    const sessDir = path.join(memRoot, 'memory', 'sessions');
    if (!fs.existsSync(sessDir)) fs.mkdirSync(sessDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const sessFile = path.join(sessDir, today + '.md');
    const now = new Date().toISOString().slice(11, 19);
    const userInput = reqBody.input || '';
    const messages = reqBody.messages || [];
    const images = reqBody.images || [];

    // 构造 entry
    const entry = [];
    entry.push('## ' + now + ' · model=' + modelUsed);
    entry.push('');
    if (userInput) entry.push('**User**: ' + userInput.slice(0, 500));
    if (messages.length > 0) {
      const lastUser = messages.slice().reverse().find(m => m.role === 'user');
      if (lastUser && lastUser.content !== userInput) {
        entry.push('**History user**: ' + String(lastUser.content).slice(0, 300));
      }
    }
    if (assistantContent) entry.push('');
    entry.push('**Pangu**: ' + assistantContent.slice(0, 1500));
    if (images.length > 0) entry.push('**Images**: ' + images.length);
    entry.push('');

    fs.appendFileSync(sessFile, entry.join('\n'), 'utf8');
    console.log('[memory] recorded session to', sessFile);

 // 修: 每天累积合并到 MEMORY.md, 并清理超过 30 天的 session
    _mergeSessionsIntoMemory(memRoot, sessDir, today);

    // 增量 reindex: 只 rebuild 刚改的文件
    _incrementalReindex(sessFile, memRoot);
    return true;
  } catch (e) {
    console.warn('[memory] recordSession failed:', e.message);
    return false;
  }
}

// 新增: 合并 sessions 到 MEMORY.md, 只保留最近 30 天 session
function _mergeSessionsIntoMemory(memRoot, sessDir, today) {
  try {
    const memoryFile = path.join(memRoot, 'MEMORY.md');
    if (!fs.existsSync(memRoot)) fs.mkdirSync(memRoot, { recursive: true });

    const files = fs.readdirSync(sessDir)
      .filter(f => f.endsWith('.md'))
      .map(f => ({ name: f, file: path.join(sessDir, f), date: f.replace(/\.md$/, '') }))
      .filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.date))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (files.length === 0) return;

    const HEADER = '# 盘古累积记忆 (MEMORY.md)\n\n由所有历史 session 每日自动合并而来。历史 session 仅保留最近 30 天，超过 30 天的 session 已删除，但其内容已合并到本文件。\n\n';

    let memory = '';
    if (fs.existsSync(memoryFile)) {
      memory = fs.readFileSync(memoryFile, 'utf8');
      // 如果已有旧格式 header，去掉旧 header 重新生成
      if (memory.startsWith('# 盘古累积记忆')) {
        memory = memory.split('\n\n').slice(2).join('\n\n');
      }
    }

    const merged = [];
    for (const { file, date } of files) {
      const content = fs.readFileSync(file, 'utf8');
      // 避免重复合并：检查 memory 里是否已有这个日期标记
      const marker = `<!-- session:${date} -->`;
      if (memory.includes(marker)) continue;
      merged.push(`<!-- session:${date} -->\n## ${date}\n\n${content}`);
    }

    if (merged.length > 0) {
      memory = HEADER + memory + '\n\n' + merged.join('\n\n');
      fs.writeFileSync(memoryFile, memory, 'utf8');
      console.log('[memory] merged', merged.length, 'sessions into MEMORY.md');
    }

    // 删除超过 30 天的 session
    const cutoff = _dateOffset(today, -30);
    let deleted = 0;
    for (const { name, file, date } of files) {
      if (date < cutoff) {
        try { fs.unlinkSync(file); deleted++; } catch (e) {}
      }
    }
    if (deleted > 0) console.log('[memory] deleted', deleted, 'sessions older than', cutoff);
  } catch (e) {
    console.warn('[memory] mergeSessions failed:', e.message);
  }
}

function _dateOffset(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 增量 reindex (单文件 rebuild)
function _incrementalReindex(filePath, memRoot) {
  try {
    const sqlite3 = require('better-sqlite3');
    const dbPath = path.join(memRoot, 'main.sqlite');
    const db = sqlite3(dbPath);
 // schema 缺失修复 — 必须在任何 DELETE/INSERT 之前建表 (与 l2-miner 同步)
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        source TEXT,
        hash TEXT,
        mtime INTEGER,
        size INTEGER
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        path TEXT,
        source TEXT,
        start_line INTEGER,
        end_line INTEGER,
        hash TEXT,
        model TEXT,
        text TEXT,
        embedding TEXT,
        updated_at INTEGER
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text, id UNINDEXED, path UNINDEXED, source UNINDEXED, model UNINDEXED,
        start_line UNINDEXED, end_line UNINDEXED,
        content='chunks', content_rowid='rowid'
      );
    `);
    const relPath = path.relative(memRoot, filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const stat = fs.statSync(filePath);
    const fileHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

    // 删旧 chunks (同 path) + 同步 chunks_fts (R39 防 FTS5 drift, 风控 M)
    db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE path = ?)').run(relPath);
    db.prepare('DELETE FROM chunks WHERE path = ?').run(relPath);
    db.prepare('DELETE FROM files WHERE path = ?').run(relPath);

    // 重新插入 file
    db.prepare('INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)').run(
      relPath, 'memory', fileHash, Math.floor(stat.mtimeMs), stat.size);

    // 重新插入 chunks + FTS
    const insertChunk = db.prepare('INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertFts = db.prepare('INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const lines = content.split('\n');
    const CHUNK_SIZE = 40;
    for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
      const start = i + 1;
      const end = Math.min(i + CHUNK_SIZE, lines.length);
      const text = lines.slice(i, end).join('\n');
      if (!text.trim()) continue;
      const chunkId = fileHash + '_' + start + '_' + end;
      const chunkHash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
      insertChunk.run(chunkId, relPath, 'memory', start, end, chunkHash, 'sha256-text', text, '[]', Date.now());
      insertFts.run(text, chunkId, relPath, 'memory', 'sha256-text', start, end);
    }
    db.close();
    console.log('[memory] reindexed', relPath);
  } catch (e) {
    console.warn('[memory] reindex failed:', e.message);
  }
}

module.exports = {
  _recordSessionToMemory,
  _mergeSessionsIntoMemory,
  _dateOffset,
  _incrementalReindex,
};
