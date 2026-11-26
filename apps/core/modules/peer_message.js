// apps/core/modules/peer_message.js
// 盘古 · Subagent 直连 / Peer Messaging (Prime Agent "Agents communicate directly" 对位)
// 不路由过 dispatcher: 任意 agent → 任意 active session 投递消息
// 持久化到 ~/.pangu/state/peer/<sessionId>.jsonl (append-only)
//
// 用法 (sub-agent 或 sub-task 工具里):
//   peer.send('sessionId', { from: 'agent-id', content: '...', kind: 'info'|'request'|'result'|'blocker' })
//   peer.list('sessionId', sinceTs)   // 拉新消息
//   peer.ack('sessionId', [msgId, ...])  // 确认已读
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
// 2026-10-25 (第 92 批): session id → 落盘文件名的唯一真源。
//   原来 inbox 与 archive 两处各抄一份清洗 ⇒ '!!!' 与 '@@@' 落同一个文件。
// 2026-10-25 (第 92 批): session id → 落盘文件名的唯一真源。
//   原来 inbox 与 archive 两处各抄一份清洗 ⇒ '!!!' 与 '@@@' 落同一个文件。
//   resolveSessionKey = 纯清洗 (存量零改名) + 真撞名时才换指纹名 (不覆盖别人的账)。
const { resolveSessionKey } = require('./session_key');

const DEFAULT_PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
const PEER_DIR = path.join(DEFAULT_PANGU_HOME, 'state', 'peer');
const MAX_PER_FILE = 500; // 单 session 收满 500 条自动归档到 <sid>.archive.jsonl

function ensureDir() { try { fs.mkdirSync(PEER_DIR, { recursive: true }); } catch (_) {} }

function _inboxFile(sid) {
  const safe = resolveSessionKey(PEER_DIR, sid, { ext: '.jsonl' });
  return path.join(PEER_DIR, safe + '.jsonl');
}

function _archiveFile(sid) {
  const safe = resolveSessionKey(PEER_DIR, sid, { ext: '.jsonl' });
  return path.join(PEER_DIR, safe + '.archive.jsonl');
}

function _newId() {
  return 'msg_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

function send(sessionId, msg) {
  if (!msg || !msg.content) return { ok: false, error: 'content required' };
  ensureDir();
  const entry = {
    id: msg.id || _newId(),
    ts: msg.ts || new Date().toISOString(),
    from: String(msg.from || 'unknown').slice(0, 100),
    session_id: sessionId,
    kind: msg.kind || 'info', // info | request | result | blocker
    content: String(msg.content).slice(0, 10000),
    metadata: msg.metadata || {},
    acked: false,
  };
  const file = _inboxFile(sessionId);
  // 超 MAX_PER_FILE → 归档当前文件
  try {
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length >= MAX_PER_FILE) {
        const archive = _archiveFile(sessionId);
        fs.appendFileSync(archive, lines.join('\n') + '\n');
        fs.unlinkSync(file);
      }
    }
  } catch (_) {}
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return { ok: true, message: entry };
}

// 拉新消息 (sinceTs 之后), 默认未读优先
function list(sessionId, sinceTs) {
  const file = _inboxFile(sessionId);
  if (!fs.existsSync(file)) return [];
  const since = sinceTs || 0;
  const out = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      try {
        const d = JSON.parse(line);
        if (new Date(d.ts).getTime() > since) out.push(d);
      } catch (_) {}
    }
  } catch (_) {}
  return out.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
}

function ack(sessionId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: 'ids required' };
  const file = _inboxFile(sessionId);
  if (!fs.existsSync(file)) return { ok: true, acked: 0 };
  let ackedCount = 0;
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const next = [];
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        if (ids.includes(d.id)) {
          d.acked = true;
          d.acked_at = new Date().toISOString();
          ackedCount++;
        }
        next.push(JSON.stringify(d));
      } catch (_) { next.push(line); }
    }
    fs.writeFileSync(file, next.join('\n') + '\n');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, acked: ackedCount };
}

// 列出某 session 的未读数 (供前端 badge / polling)
function unreadCount(sessionId) {
  const all = list(sessionId);
  return all.filter(m => !m.acked).length;
}

module.exports = {
  send, list, ack, unreadCount,
  _paths: { PEER_DIR, MAX_PER_FILE },
};
