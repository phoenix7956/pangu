'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rowsFingerprint } = require('./fingerprint');

let BetterSqlite3;

function loadSqlite() {
  if (!BetterSqlite3) BetterSqlite3 = require('better-sqlite3');
  return BetterSqlite3;
}

function defaultRoot() {
  return process.env.PANGU_AGENTDB_DIR || path.join(os.homedir(), '.pangu-data', 'agentdb');
}

function vectorToBuffer(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  const values = vector.map(Number);
  if (values.some(v => !Number.isFinite(v))) return null;
  return Buffer.from(new Float32Array(values).buffer);
}

function bufferToVector(value) {
  if (!value) return null;
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (buffer.byteLength === 0 || buffer.byteLength % 4 !== 0) return null;
  const view = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  return Array.from(view);
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  try { return JSON.stringify(content) || String(content); } catch (_) { return String(content); }
}

function contentHash(sessionId, messageKey, role, content) {
  return crypto.createHash('sha256')
    .update(`${sessionId}\u0000${messageKey}\u0000${role}\u0000${content}`)
    .digest('hex');
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

class AgentDatabase {
  constructor({ root = defaultRoot() } = {}) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
    this.path = path.join(this.root, 'agentdb.sqlite');
    const Sqlite = loadSqlite();
    this.db = new Sqlite(this.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this._schema();
  }

  _schema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agentdb_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        plan_id TEXT,
        plan_state TEXT,
        summary TEXT,
        state TEXT,
        message_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        message_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        embedding_model TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        UNIQUE(session_id, message_key),
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash);

      CREATE TABLE IF NOT EXISTS trajectories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        theme TEXT NOT NULL,
        user_input TEXT NOT NULL,
        assistant_summary TEXT,
        tools_used TEXT,
        tool_call_count INTEGER DEFAULT 0,
        tokens_total INTEGER DEFAULT 0,
        rounds INTEGER DEFAULT 0,
        success_signal INTEGER,
        model_used TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trajectories_theme ON trajectories(theme);
      CREATE INDEX IF NOT EXISTS idx_trajectories_session ON trajectories(session_id);
      CREATE INDEX IF NOT EXISTS idx_trajectories_created ON trajectories(created_at);

      CREATE TABLE IF NOT EXISTS patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        theme TEXT NOT NULL,
        pattern_summary TEXT NOT NULL,
        decision_points TEXT,
        trajectory_ids TEXT,
        embedding BLOB,
        confidence REAL DEFAULT 0.5,
        sample_size INTEGER DEFAULT 1,
        hit_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(theme, pattern_summary)
      );
      CREATE INDEX IF NOT EXISTS idx_patterns_theme ON patterns(theme);
    `);

    // Keep databases created by the short-lived JSON-only prototype readable.
    const columns = tableColumns(this.db, 'sessions');
    if (!columns.has('plan_id')) this.db.exec('ALTER TABLE sessions ADD COLUMN plan_id TEXT');
    if (!columns.has('state')) this.db.exec('ALTER TABLE sessions ADD COLUMN state TEXT');
    if (!columns.has('message_count')) this.db.exec('ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0');

    const memoryColumns = tableColumns(this.db, 'memories');
    if (!memoryColumns.has('message_key')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN message_key TEXT NOT NULL DEFAULT 'legacy'");
    }
    if (!memoryColumns.has('content_hash')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_session_key ON memories(session_id, message_key)');
  }

  close() {
    if (this.db && this.db.open) this.db.close();
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM agentdb_meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO agentdb_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  getEmbeddingDimension() {
    const value = this.getMeta('embedding_dim');
    return value ? Number(value) : null;
  }

  setEmbeddingDimension(dimension) {
    if (!Number.isInteger(dimension) || dimension <= 0) throw new Error('invalid embedding dimension');
    const current = this.getEmbeddingDimension();
    if (current && current !== dimension) throw new Error(`embedding dimension mismatch: ${dimension} != ${current}`);
    this.setMeta('embedding_dim', dimension);
    return dimension;
  }

  upsertSession({ sessionId, createdAt, updatedAt, planId, planState, summary, state, messageCount }) {
    const now = Number(updatedAt) || Date.now();
    const created = Number(createdAt) || now;
    const plan = planState === undefined || planState === null ? null : JSON.stringify(planState);
    this.db.prepare(`
      INSERT INTO sessions (session_id, created_at, updated_at, plan_id, plan_state, summary, state, message_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        plan_id = excluded.plan_id,
        plan_state = excluded.plan_state,
        summary = excluded.summary,
        state = excluded.state,
        message_count = excluded.message_count
    `).run(sessionId, created, now, planId || null, plan, summary || '', state || 'active', Number(messageCount) || 0);
  }

  addMemory({ sessionId, role = 'history', content, embedding = null, embeddingModel = null, metadata = null, messageKey = null, createdAt = null }) {
    const session = this.db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(sessionId);
    if (!session) {
      this.upsertSession({
        sessionId,
        createdAt: createdAt || Date.now(),
        updatedAt: createdAt || Date.now(),
        planId: null,
        planState: null,
        summary: '',
        state: 'history',
        messageCount: 0,
      });
    }
    return this._insertSingleMemory({
      sessionId,
      role,
      content,
      embedding,
      embeddingModel,
      metadata,
      messageKey: messageKey || `legacy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: createdAt || Date.now(),
    });
  }

  _insertSingleMemory({ sessionId, role, content, embedding, embeddingModel, metadata, messageKey, createdAt }) {
    const buffer = embedding && Array.isArray(embedding.vector)
      ? vectorToBuffer(embedding.vector)
      : (Buffer.isBuffer(embedding) ? embedding : null);
    const model = (embedding && embedding.model) || embeddingModel || 'unknown';
    const metadataString = metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null;
    const createdAtMs = Number(createdAt) || Date.now();
    const normalizedContent = normalizeMessageContent(content);
    const hash = contentHash(sessionId, messageKey, role, normalizedContent);
    this.db.prepare(`
      INSERT INTO memories
        (session_id, message_key, role, content, embedding, embedding_model, metadata, created_at, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, message_key) DO UPDATE SET
        role = excluded.role,
        content = excluded.content,
        embedding = COALESCE(excluded.embedding, memories.embedding),
        embedding_model = COALESCE(excluded.embedding_model, memories.embedding_model),
        metadata = excluded.metadata,
        created_at = excluded.created_at,
        content_hash = excluded.content_hash
    `).run(sessionId, messageKey, role, normalizedContent, buffer, model, metadataString, createdAtMs, hash);
    const id = this.db.prepare('SELECT id FROM memories WHERE session_id = ? AND message_key = ?').get(sessionId, messageKey);
    return id && id.id ? id.id : null;
  }

  upsertMessages(sessionId, messages, embeddings, embeddingModel = 'unknown') {
    // Messages are a session snapshot: anything the new snapshot no longer
    // contains must go (that is how compaction drops old turns).
    //
    // 但**只能删掉新快照里没有的那些**, 不能整段 DELETE 再重插。
    // 原来这里是无条件删光重插, 后果是: 每保存一次, 这个会话里每一条记忆
    // (哪怕内容一个字没变) 都拿到全新 rowid。实测同样 4 条消息连存两次,
    // id 从 363853-363856 变成 363857-363860。
    //
    // id 一变, 向量索引里的 id 就全部对不上, syncIndex 只能全量重建 —— 17050 条
    // 要 3.5 秒, 而 J2 每跑一轮就保存一次。事件循环被反复饿死, 整个 HTTP 服务
    // 对外假死(根路径 15s 超时)。这不是索引的毛病, 是这里的。
    //
    // message_key 本来就是 (session_id, message_key) 唯一键, 下面的 ON CONFLICT
    // 也一直在用它 —— 原地 upsert 才是这张表本来的设计。
    const keys = messages.map((_, index) => String(index));
    if (keys.length === 0) {
      this.db.prepare('DELETE FROM memories WHERE session_id = ?').run(sessionId);
    } else {
      const stalePlaceholders = keys.map(() => '?').join(',');
      this.db.prepare(
        `DELETE FROM memories WHERE session_id = ? AND message_key NOT IN (${stalePlaceholders})`,
      ).run(sessionId, ...keys);
    }
    const insert = this.db.prepare(`
      INSERT INTO memories
        (session_id, message_key, role, content, embedding, embedding_model, metadata, created_at, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, message_key) DO UPDATE SET
        role = excluded.role,
        content = excluded.content,
        embedding = COALESCE(excluded.embedding, memories.embedding),
        embedding_model = COALESCE(excluded.embedding_model, memories.embedding_model),
        metadata = excluded.metadata,
        created_at = excluded.created_at,
        content_hash = excluded.content_hash
    `);

    const rows = [];
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i] || {};
      const role = typeof message.role === 'string' ? message.role : 'user';
      const content = normalizeMessageContent(message.content);
      const messageKey = String(i);
      const vector = embeddings && embeddings[i] ? vectorToBuffer(embeddings[i].vector) : null;
      const model = embeddings && embeddings[i] ? embeddings[i].model || embeddingModel : null;
      const { role: _ignoredRole, content: _ignoredContent, metadata: messageMetadata, ...messageFields } = message;
      const metadata = JSON.stringify({
        ...messageFields,
        ...(messageMetadata && typeof messageMetadata === 'object' ? { metadata: messageMetadata } : {}),
      });
      const createdAt = Number(message.created_at || message.ts) || Date.now();
      const hash = contentHash(sessionId, messageKey, role, content);
      insert.run(sessionId, messageKey, role, content, vector, model, metadata, createdAt, hash);
      rows.push({ messageKey, role, content, createdAt });
    }
    return rows;
  }

  legacyMessageKey(content, indexHint = null) {
    if (Number.isInteger(indexHint) && indexHint >= 0) return String(indexHint);
    const hash = crypto.createHash('sha256')
      .update(`${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${typeof content === 'string' ? content : JSON.stringify(content)}`)
      .digest('hex')
      .slice(0, 12);
    return `legacy_${hash}`;
  }

  transaction(fn) {
    return this.db.transaction(fn)();
  }

  getSession(sessionId) {
    const session = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
    if (!session) return null;
    const messages = this.db.prepare(`
      SELECT role, content, metadata, created_at, message_key
      FROM memories WHERE session_id = ?
      ORDER BY CAST(message_key AS INTEGER), id
    `).all(sessionId).map(row => {
      let metadata = {};
      try { metadata = row.metadata ? JSON.parse(row.metadata) : {}; } catch (_) {}
      const message = { ...metadata, role: row.role, content: row.content };
      return message;
    });
    let planState = null;
    try { planState = session.plan_state ? JSON.parse(session.plan_state) : null; } catch (_) {}
    return {
      session_id: session.session_id,
      messages,
      plan_id: session.plan_id || null,
      compaction_summary: session.summary || '',
      state: session.state || 'active',
      message_count: session.message_count || messages.length,
      last_updated: session.updated_at,
      plan_state: planState,
    };
  }

  listSessions(limit = 20) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 200));
    // 2026-10-28 (现场 ~/.pangu-data/agentdb 3341 条会话, 真人对话只有 36 条):
    //   「最近会话」列表里塞的是三类**根本不是对话**的东西 ——
    //     ① 子 agent 侧车 (`parent#sub-0-li`)          692 条
    //     ② 计划脚手架 (`plan_*`, 1 条空 user 消息)
    //     ③ 工具结果审计日志 (`self_correct_audit` 状态, 每次工具调用存一条,
    //        全仓**只写不读**)                            1464 条
    //   列表只给 20 条, 于是老板自己的真实对话被这堆脚手架挤出窗口
    //   (老板看到的就是「最近会话」里全是「① 完成: 探针」)。
    //   ⇒ 列表只列**主对话**, 三类按「性质」排掉, 不靠名字猜。
    return this.db.prepare(`
      SELECT session_id, plan_id, state, message_count, updated_at, created_at
      FROM sessions
      WHERE session_id NOT LIKE '%#%'
        AND session_id NOT LIKE 'plan%'
        AND state != 'self_correct_audit'
      ORDER BY updated_at DESC LIMIT ?
    `).all(safeLimit).map(row => ({
      session_id: row.session_id,
      plan_id: row.plan_id || null,
      state: row.state || 'active',
      message_count: row.message_count || 0,
      last_updated: row.updated_at,
      created_at: row.created_at,
    }));
  }

  deleteSession(sessionId) {
    const remove = this.db.transaction((sid) => {
      // memories cascade from sessions; trajectories intentionally have no FK
      // because they may outlive a message snapshot, so remove them explicitly
      // when the user deletes the owning session.
      this.db.prepare('DELETE FROM trajectories WHERE session_id = ?').run(sid);
      return this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sid).changes > 0;
    });
    return remove(sessionId);
  }

  listEmbeddedMemories(limit = 100000) {
    const rows = this.db.prepare(`
      SELECT id, session_id, role, content, embedding, embedding_model, metadata, created_at
      FROM memories WHERE embedding IS NOT NULL
      ORDER BY id ASC LIMIT ?
    `).all(Math.max(1, Math.min(Number(limit) || 100000, 100000)));
    return rows.map(row => ({
      id: row.id,
      session_id: row.session_id,
      role: row.role,
      content: row.content,
      vector: bufferToVector(row.embedding),
      embedding_model: row.embedding_model || 'unknown',
      metadata: parseJson(row.metadata, {}),
      created_at: row.created_at,
    })).filter(row => Array.isArray(row.vector) && row.vector.length > 0);
  }

  // 给「索引同步」和「暴力检索兜底」用的瘦行: 只要 id 和向量。
  //
  // 原来这里直接调 listEmbeddedMemories, 把 17052 行的 content / metadata
  // 也全查出来、全 JSON.parse 一遍, 可这两个字段从头到尾没人用过 ——
  // 实测每落一次盘白花 190ms(胖查询 287ms vs 瘦查询 95ms)。
  // 这个函数在每轮 J2 保存时都会跑, 不是一次性的。
  listEmbeddedVectors(limit = 100000) {
    const rows = this.db.prepare(`
      SELECT id, embedding, embedding_model, created_at
      FROM memories WHERE embedding IS NOT NULL
      ORDER BY id ASC LIMIT ?
    `).all(Math.max(1, Math.min(Number(limit) || 100000, 100000)));
    return rows.map(row => ({
      id: row.id,
      vector: bufferToVector(row.embedding),
      embedding_model: row.embedding_model || 'unknown',
      created_at: row.created_at,
    })).filter(row => Array.isArray(row.vector) && row.vector.length > 0);
  }

  getMemoriesByIds(ids) {
    const validIds = [...new Set((ids || []).map(Number).filter(Number.isInteger))];
    if (validIds.length === 0) return [];
    const placeholders = validIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT id, session_id, role, content, embedding_model, metadata, created_at
      FROM memories WHERE id IN (${placeholders})
    `).all(...validIds);
    const byId = new Map(rows.map(row => [row.id, row]));
    return validIds.map(id => byId.get(id)).filter(Boolean).map(row => ({
      id: row.id,
      session_id: row.session_id,
      role: row.role,
      content: row.content,
      embedding_model: row.embedding_model || 'unknown',
      metadata: parseJson(row.metadata, {}),
      created_at: row.created_at,
    }));
  }

  getSessionMemories(sessionIds, limitPerSession = 8) {
    const ids = [...new Set((sessionIds || []).filter(Boolean))];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT id, session_id, role, content, embedding_model, metadata, created_at
      FROM memories WHERE session_id IN (${placeholders})
      ORDER BY created_at ASC, id ASC
    `).all(...ids);
    const counts = new Map();
    return rows.filter(row => {
      const count = counts.get(row.session_id) || 0;
      if (count >= limitPerSession) return false;
      counts.set(row.session_id, count + 1);
      return true;
    }).map(row => ({
      id: row.id,
      session_id: row.session_id,
      role: row.role,
      content: row.content,
      embedding_model: row.embedding_model || 'unknown',
      metadata: parseJson(row.metadata, {}),
      created_at: row.created_at,
    }));
  }

  keywordSearch(query, limit = 20) {
    const terms = searchTerms(query);
    const rows = this.db.prepare(`
      SELECT id, session_id, role, content, embedding_model, metadata, created_at
      FROM memories ORDER BY created_at DESC, id DESC LIMIT 5000
    `).all();
    const normalizedQuery = normalizeSearchText(query);
    const scored = rows.map(row => {
      const text = normalizeSearchText(row.content);
      let score = normalizedQuery && text.includes(normalizedQuery) ? 1 : 0;
      for (const term of terms) if (text.includes(term)) score += term.length > 1 ? 0.25 : 0.08;
      return { row, score };
    }).filter(item => item.score > 0);
    scored.sort((a, b) => b.score - a.score || b.row.created_at - a.row.created_at || b.row.id - a.row.id);
    return scored.slice(0, Math.max(1, Number(limit) || 20)).map(item => ({
      id: item.row.id,
      session_id: item.row.session_id,
      role: item.row.role,
      content: item.row.content,
      embedding_model: item.row.embedding_model || 'unknown',
      metadata: parseJson(item.row.metadata, {}),
      created_at: item.row.created_at,
      score: item.score,
    }));
  }

  addTrajectory({ sessionId, theme, userInput, assistantSummary = '', toolsUsed = '[]', toolCallCount = 0, tokensTotal = 0, rounds = 0, successSignal = null, modelUsed = 'unknown', createdAt = null }) {
    const created = Number(createdAt) || Date.now();
    const result = this.db.prepare(`
      INSERT INTO trajectories (session_id, theme, user_input, assistant_summary, tools_used, tool_call_count, tokens_total, rounds, success_signal, model_used, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, theme, userInput, assistantSummary || '', toolsUsed, Number(toolCallCount) || 0, Number(tokensTotal) || 0, Number(rounds) || 0, successSignal, modelUsed || 'unknown', created);
    return Number(result.lastInsertRowid);
  }

  listUserMemoriesForBootstrap(limit = 200, roles = ['user', 'history']) {
    // R40 polish §7: bootstrap 老 data — 从 memories 表读指定角色, 用于反推 trajectories
    // 默认 ['user', 'history'] — 'user' 是 daemon 真输入, 'history' 是 R39 backfill 导入的老 chunks
    const placeholders = roles.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT id, session_id, role, content, created_at FROM memories
      WHERE role IN (${placeholders}) ORDER BY created_at DESC LIMIT ?
    `).all(...roles, Math.max(1, Math.min(Number(limit) || 200, 5000)));
  }

  bootstrapTrajectoriesFromMemories(opts = {}) {
    // R40 polish §7: 把 R39 backfill 老 memories 反推成 trajectories, 冷启动 SONA
    const themeHintFn = opts.themeHint || require('../sona/classifier').themeHint;
    const limit = opts.limit || 200;
    const dryRun = !!opts.dryRun;
    const roles = Array.isArray(opts.roles) && opts.roles.length > 0 ? opts.roles : ['user', 'history'];
    const rows = this.listUserMemoriesForBootstrap(limit, roles);
    let written = 0;
    const byTheme = {};
    const byRole = {};
    for (const m of rows) {
      const text = String(m.content || '').slice(0, 2000);
      if (!text) continue; // skip empty
      const theme = themeHintFn(text);
      byTheme[theme] = (byTheme[theme] || 0) + 1;
      byRole[m.role] = (byRole[m.role] || 0) + 1;
      if (dryRun) continue;
      // 避免重复 (同一 session + 内容 hash) — 用 session_id + content hash 作 message_key 重写一条 trajectory
      const exists = this.db.prepare('SELECT 1 FROM trajectories WHERE session_id = ? AND user_input = ?').get(m.session_id, text);
      if (exists) continue;
      this.db.prepare(`
        INSERT INTO trajectories (session_id, theme, user_input, assistant_summary, tools_used, tool_call_count, tokens_total, rounds, success_signal, model_used, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(m.session_id, theme, text, '(bootstrap from R39 memory)', '[]', 0, 0, 1, null, 'bootstrap', Number(m.created_at) || Date.now());
      written += 1;
    }
    return { scanned: rows.length, written, byTheme, byRole };
  }

  getRecentTrajectories(theme, limit = 30) {
    const rows = this.db.prepare(`
      SELECT id, session_id, theme, user_input, assistant_summary, tools_used, tool_call_count, tokens_total, rounds, model_used, created_at
      FROM trajectories WHERE theme = ?
      ORDER BY id DESC LIMIT ?
    `).all(theme, Number(limit) || 30);
    return rows;
  }

  getActiveThemes(minSample = 2) {
    const rows = this.db.prepare(`
      SELECT theme, COUNT(*) AS n FROM trajectories
      WHERE created_at > ? GROUP BY theme HAVING n >= ?
      ORDER BY n DESC
    `).all(Date.now() - 7 * 24 * 60 * 60 * 1000, Number(minSample) || 2);
    return rows.map(r => r.theme);
  }

  upsertPattern({ theme, patternSummary, decisionPoints = '[]', trajectoryIds = '[]', embedding = null, sampleSize = 1 }) {
    const now = Date.now();
    let buffer = null;
    if (embedding) {
      if (Buffer.isBuffer(embedding)) buffer = embedding;
      else if (Array.isArray(embedding)) buffer = vectorToBuffer(embedding);
      else if (embedding && Array.isArray(embedding.vector)) buffer = vectorToBuffer(embedding.vector);
    }
    const result = this.db.prepare(`
      INSERT INTO patterns (theme, pattern_summary, decision_points, trajectory_ids, embedding, sample_size, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(theme, pattern_summary) DO UPDATE SET
        decision_points = excluded.decision_points,
        trajectory_ids = excluded.trajectory_ids,
        embedding = COALESCE(excluded.embedding, patterns.embedding),
        sample_size = patterns.sample_size + 1,
        updated_at = ?
    `).run(theme, patternSummary, decisionPoints, trajectoryIds, buffer, Number(sampleSize) || 1, now, now, now);
    return Number(result.lastInsertRowid);
  }

  searchPatterns(theme, opts = {}) {
    const limit = Math.max(1, Math.min(Number(opts.limit) || 3, 20));
    const rows = this.db.prepare(`
      SELECT id, theme, pattern_summary, decision_points, trajectory_ids, confidence, sample_size, hit_count
      FROM patterns WHERE theme = ?
      ORDER BY id DESC
    `).all(theme);
    // R40 polish §6: hit_count → effective_confidence boost (max +0.3)
    // sample_size 也加成 (历史越多越可靠), 但权重低于 hit_count (实战命中更准)
    for (const r of rows) {
      r.hit_boost = Math.min(Number(r.hit_count || 0) * 0.05, 0.3);
      r.sample_boost = Math.min(Number(r.sample_size || 0) * 0.02, 0.1);
      r.effective_confidence = Number(r.confidence || 0) + r.hit_boost + r.sample_boost;
    }
    rows.sort((a, b) => (b.effective_confidence - a.effective_confidence) || (b.hit_count - a.hit_count) || (b.id - a.id));
    return rows.slice(0, limit);
  }

  incrementPatternHit(patternId) {
    if (!Number.isInteger(patternId)) return 0;
    const r = this.db.prepare('UPDATE patterns SET hit_count = hit_count + 1 WHERE id = ?').run(patternId);
    return r.changes;
  }

  fingerprint(rows) {
    return rowsFingerprint(rows);
  }
}

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; }
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replaceAll('案子', '案件')
    .replaceAll('打官司', '诉讼')
    .replaceAll('应诉', '答辩')
    .replace(/\s+/g, '');
}

function searchTerms(value) {
  const normalized = normalizeSearchText(value);
  const words = normalized.match(/[a-z0-9_]+|[\u4e00-\u9fff]{1,}/gi) || [];
  const chars = Array.from(normalized).filter(ch => /[\u4e00-\u9fff]/.test(ch));
  return [...new Set([...words, ...chars].filter(term => term.length > 0))];
}

module.exports = {
  AgentDatabase,
  bufferToVector,
  vectorToBuffer,
  normalizeMessageContent,
  normalizeSearchText,
};
