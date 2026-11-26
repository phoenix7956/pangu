'use strict';

// @deprecated (2026-08-16 P0-2): R39 一次性迁移脚本, 已跑完不再用.
// Pangu DB 自治, 此脚本保留仅供历史参考. 新代码请勿 require 此模块.
// R39-AgentDB-Backfill 一次性迁移 (老板 7/26 21:08 拍 'A')
// 把老 ~/.pangu/memory/main.sqlite 的 chunks 全部导到新库
// ~/.pangu-data/agentdb/agentdb.sqlite, 走 SQLite (WAL) + HNSW (cosine 384d).
//
// 红线:
// - source 永远 readonly 打开, 永不改老库 (风控 M, R29/R30 教训)
// - target 写前先 cp 备份 (R37 我一个人干过犯的最重的错, 这次先 cp)
// - 老 chunks `embedding='[]'` 是字符串, 反序列失败落 local-hash fallback, 不阻塞导入
// - session_id = legacy_<orig_id>, role = 'history', 不污染真 session 命名空间
//
// 用法:
//   node modules/agentdb/backfill.js [--source <path>] [--target <path>] [--batch 50] [--limit 173]

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { AgentDatabase } = require('./db');
const { AgentDBIndex } = require('./index');
const { embedText } = require('./embedder');

const DEFAULT_SOURCE = path.join(os.homedir(), '.pangu', 'memory', 'main.sqlite');
const DEFAULT_TARGET = path.join(os.homedir(), '.pangu-data', 'agentdb', 'agentdb.sqlite');

function parseArgs(argv) {
  const out = { source: DEFAULT_SOURCE, target: DEFAULT_TARGET, batch: 50, limit: null, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source' || arg === '-s') out.source = argv[++i];
    else if (arg === '--target' || arg === '-t') out.target = argv[++i];
    else if (arg === '--batch' || arg === '-b') out.batch = Math.max(1, Number.parseInt(argv[++i], 10) || 50);
    else if (arg === '--limit' || arg === '-l') out.limit = Math.max(1, Number.parseInt(argv[++i], 10));
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('node modules/agentdb/backfill.js [--source <path>] [--target <path>] [--batch 50] [--limit 173] [--dry-run]\n');
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }
  return out;
}

function backupTarget(target) {
  if (!fs.existsSync(target)) return null;
  const stamp = Math.floor(Date.now() / 1000);
  const backup = `${target}.bak-${stamp}`;
  fs.copyFileSync(target, backup);
  if (fs.existsSync(`${target}-wal`)) fs.copyFileSync(`${target}-wal`, `${backup}-wal`);
  if (fs.existsSync(`${target}-shm`)) fs.copyFileSync(`${target}-shm`, `${backup}-shm`);
  return backup;
}

async function backfill(opts) {
  const startedAt = Date.now();
  if (!fs.existsSync(opts.source)) {
    throw new Error(`source not found: ${opts.source}`);
  }
  // target 既能传完整文件路径, 也能传目录 (回落到 <dir>/agentdb.sqlite, 跟 sessionStore 一致)
  let targetFile = opts.target;
  if (!targetFile.endsWith('.sqlite') && !targetFile.endsWith('.sqlite3')) {
    targetFile = path.join(targetFile, 'agentdb.sqlite');
  }
  // §0.13 + R37 教训: 写新库前先 cp 老新库 (target 已经是新库, 不是老源)
  const backup = opts.dryRun ? null : backupTarget(targetFile);

  // readonly 打开老库, 永不改
  const oldDb = new Database(opts.source, { readonly: true, fileMustExist: true });
  const rowidLimitClause = opts.limit ? ` LIMIT ${Number.parseInt(opts.limit, 10)}` : '';
  const oldRows = oldDb.prepare(`
    SELECT id, text, model, hash, embedding
    FROM chunks
    WHERE text IS NOT NULL AND length(text) > 5
    ORDER BY rowid ASC
    ${rowidLimitClause}
  `).all();
  oldDb.close();
  if (oldRows.length === 0) {
    return { imported: 0, total: 0, backup, note: 'source has no eligible chunks' };
  }

  const targetDb = opts.dryRun ? null : new AgentDatabase({ root: path.dirname(targetFile) });

  // 统计从 source 来的原 embedding (老库全是 '[]' 字符串占位)
  const hadNonEmptyEmbedding = oldRows.filter(row => {
    if (!row.embedding || row.embedding === '[]') return false;
    try {
      const parsed = JSON.parse(row.embedding);
      // 真实可用 embedding 必须跟新库 384 维匹配, 否则落到本地 fallback 重算 (维度冲突直接 throw)
      return Array.isArray(parsed) && parsed.length === 384;
    } catch (_) { return false; }
  }).length;

  if (opts.dryRun) {
    return {
      imported: 0,
      total: oldRows.length,
      backup,
      dryRun: true,
      hadNonEmptyEmbedding,
    };
  }

  const targetIndex = new AgentDBIndex({ root: path.dirname(targetFile) });
  let imported = 0;
  let fallbackEmbeddings = 0;
  const targetSessions = new Set();
  const targetSessionMeta = new Map();
  let lastSaveAt = 0;

  for (let i = 0; i < oldRows.length; i += 1) {
    const row = oldRows[i];
    const sessionId = `legacy_${row.id}`;
    const text = String(row.text || '').slice(0, 32000);
    if (!text.trim()) continue;

    let embedding = null;
    if (row.embedding && row.embedding !== '[]') {
      try {
        const parsed = JSON.parse(row.embedding);
        // 老库 dimension 不匹配时 (老 chunks 'embedding':'[0.1, 0.2, 0.3]' 占位 3 维)
        // 一律落到本地 fallback 重算, 不留维度冲突污染新库
        if (Array.isArray(parsed) && parsed.length === 384) {
          embedding = { vector: parsed, model: row.model || 'legacy' };
        }
      } catch (_) {}
    }
    if (!embedding) {
      try {
        embedding = await embedText(text, { dimension: 384 });
        fallbackEmbeddings += 1;
      } catch (error) {
        console.warn(`[backfill] row ${row.id} embed failed, skipping: ${error.message}`);
        continue;
      }
    }

    const metadata = {
      source: 'legacy_backfill',
      orig_id: row.id,
      orig_hash: row.hash || null,
      old_embedding_was_empty: !(embedding && embedding.model !== 'local-hash-v1') ? true : false,
      imported_at: new Date().toISOString(),
    };
    const createdAt = Date.now();
    const sessionKey = 'msg_0';
    let memoryId = null;
    try {
      memoryId = targetDb.addMemory({
        sessionId,
        role: 'history',
        content: text,
        embedding,
        embeddingModel: embedding && embedding.model ? embedding.model : (row.model || 'unknown'),
        metadata,
        messageKey: sessionKey,
        createdAt,
      });
    } catch (error) {
      console.warn(`[backfill] row ${row.id} addMemory failed: ${error.message}`);
      continue;
    }

    if (memoryId) {
      try {
        const vector = Array.isArray(embedding.vector) ? embedding.vector : null;
        targetIndex.addPoint(vector, Number(memoryId));
      } catch (error) {
        console.warn(`[backfill] row ${row.id} hnsw addPoint failed: ${error.message}`);
      }
    }

    if (!targetSessions.has(sessionId)) {
      targetSessions.add(sessionId);
      targetSessionMeta.set(sessionId, {
        sessionId,
        createdAt: createdAt,
        updatedAt: createdAt,
        planId: null,
        planState: null,
        summary: '',
        state: 'history',
        messageCount: 0,
      });
    }

    imported += 1;
    if (imported % opts.batch === 0) {
      lastSaveAt = Date.now();
      try { targetIndex.save(); } catch (error) { console.warn(`[backfill] incremental save failed: ${error.message}`); }
      process.stdout.write(`[backfill] imported ${imported}/${oldRows.length}\n`);
    }
  }

  // 收尾: 写所有 session row + 落 HNSW 索引
  for (const meta of targetSessionMeta.values()) {
    targetDb.upsertSession(meta);
  }
  try { targetIndex.save(); } catch (error) { console.warn(`[backfill] final save failed: ${error.message}`); }
  try { targetDb.close(); } catch (_) {}

  return {
    imported,
    total: oldRows.length,
    fallbackEmbeddings,
    hadNonEmptyEmbedding,
    backup,
    target: targetFile,
    targetIndexPath: path.join(path.dirname(targetFile), 'agentdb.hnsw'),
    durationMs: Date.now() - startedAt,
  };
}

if (require.main === module) {
  let opts;
  try { opts = parseArgs(process.argv); }
  catch (error) { console.error(`[backfill] ${error.message}`); process.exit(2); }

  backfill(opts)
    .then((r) => {
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      process.exit(0);
    })
    .catch((error) => {
      console.error('[backfill] fatal:', error && error.stack || error);
      process.exit(1);
    });
}

module.exports = { backfill, parseArgs, backupTarget };
