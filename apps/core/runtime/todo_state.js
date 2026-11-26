#!/usr/bin/env node
// Pangu TodoWrite 状态机 (§0.7 + W6-3 抄 Claude Code)
// 2026-07-09 老板拍: 状态机 pending → in_progress → completed, 只 forward 不 rollback
// 持久化: ~/.pangu/state/todos.jsonl

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.pangu', 'state');
const STATE_FILE = path.join(STATE_DIR, 'todos.jsonl');

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

// 状态机: pending → in_progress → completed (只 forward)
function transition(current, next) {
  const order = { 'pending': 0, 'in_progress': 1, 'completed': 2 };
  if (!(current in order) || !(next in order)) return false;
  if (order[next] < order[current]) return false; // 不允许 rollback
  return true;
}

function add(items) {
  ensureDir();
  const ts = new Date().toISOString();
  // M19: Date.now()+i 同毫秒撞 id — 加随机后缀
  const rand = require('crypto').randomBytes(4).toString('hex');
  const entries = items.map((item, i) => ({
    id: 'todo_' + Date.now() + '_' + rand + '_' + i,
    content: item.content || '',
    status: 'pending',
    activeForm: item.activeForm || '',
    ts,
  }));
  for (const e of entries) {
    fs.appendFileSync(STATE_FILE, JSON.stringify({ op: 'add', ...e }) + '\n');
  }
  return entries;
}

function update(id, status) {
  ensureDir();
  if (!['pending', 'in_progress', 'completed'].includes(status)) return { ok: false, error: 'invalid_status' };
  // 检查状态机
  const lines = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8').trim().split('\n') : [];
  let currentStatus = null;
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (r.id === id) {
        if (r.op === 'add') currentStatus = r.status;
        if (r.op === 'update') currentStatus = r.status;
      }
    } catch {}
  }
  if (currentStatus && !transition(currentStatus, status)) {
    return { ok: false, error: `invalid_transition: ${currentStatus} -> ${status}` };
  }
  const ts = new Date().toISOString();
  fs.appendFileSync(STATE_FILE, JSON.stringify({ op: 'update', id, status, ts }) + '\n');
  return { ok: true, id, status };
}

function list() {
  ensureDir();
  if (!fs.existsSync(STATE_FILE)) return [];
  const lines = fs.readFileSync(STATE_FILE, 'utf8').trim().split('\n');
  const map = new Map();
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (r.op === 'add') map.set(r.id, { ...r });
      if (r.op === 'update') {
        if (map.has(r.id)) map.get(r.id).status = r.status;
      }
    } catch {}
  }
  return Array.from(map.values());
}

module.exports = { add, update, list, transition, STATE_FILE };

// CLI 直接调用
if (require.main === module) {
  const op = process.argv[2];
  if (op === 'list') {
    const items = list();
    console.log(JSON.stringify({ ok: true, count: items.length, items }, null, 2));
  } else if (op === 'add') {
    const items = JSON.parse(process.argv[3] || '[]');
    const added = add(items);
    console.log(JSON.stringify({ ok: true, added }, null, 2));
  } else if (op === 'update') {
    const id = process.argv[3];
    const status = process.argv[4];
    console.log(JSON.stringify(update(id, status)));
  } else {
    console.log('Usage: todo_state.js [list|add|update] [args]');
  }
}
