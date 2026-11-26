// Persistent long-work workflow engine. Unlike task_output, its state survives restarts.
'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const queue = require('./task_queue');
const goal = require('./goal');
const { saveCheckpoint } = require('./checkpoint');

const events = new EventEmitter();
events.setMaxListeners(100);
const WORKFLOW_STATES = new Set(['queued', 'running', 'waiting_review', 'completed', 'failed', 'cancelled']);
let _timer = null;
let _executing = false;

function now() { return new Date().toISOString(); }
function id() { return 'wf_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'); }
function parse(json, fallback) { try { return json ? JSON.parse(json) : fallback; } catch (_) { return fallback; } }

function db() {
  const d = queue.getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      input TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 3,
      max_retries INTEGER NOT NULL DEFAULT 2,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      result TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS workflow_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'tool',
      tool_name TEXT,
      params TEXT NOT NULL DEFAULT '{}',
      depends_on TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 2,
      started_at TEXT,
      completed_at TEXT,
      result TEXT,
      error TEXT,
      UNIQUE(workflow_id, step_key)
    );
    CREATE TABLE IF NOT EXISTS workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status, priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_state ON workflow_steps(workflow_id, status);
    CREATE INDEX IF NOT EXISTS idx_workflow_events ON workflow_events(workflow_id, id);
  `);
  return d;
}

function emit(workflowId, type, data = {}) {
  const payload = { workflow_id: workflowId, type, data, ts: now() };
  db().prepare('INSERT INTO workflow_events (workflow_id, type, data, created_at) VALUES (?, ?, ?, ?)')
    .run(workflowId, type, JSON.stringify(data), payload.ts);
  events.emit('event:' + workflowId, payload);
  events.emit('event', payload);
  return payload;
}

function normalizeWorkflow(row) {
  if (!row) return null;
  return { ...row, result: parse(row.result, null), steps: undefined };
}
function normalizeStep(row) {
  return { ...row, params: parse(row.params, {}), depends_on: parse(row.depends_on, []), result: parse(row.result, null) };
}

function getWorkflow(workflowId) {
  const d = db();
  const workflow = normalizeWorkflow(d.prepare('SELECT * FROM workflows WHERE id=?').get(workflowId));
  if (!workflow) return null;
  workflow.steps = d.prepare('SELECT * FROM workflow_steps WHERE workflow_id=? ORDER BY id').all(workflowId).map(normalizeStep);
  return workflow;
}

function listWorkflows(status, limit = 50) {
  const d = db();
  const rows = status
    ? d.prepare('SELECT * FROM workflows WHERE status=? ORDER BY updated_at DESC LIMIT ?').all(status, limit)
    : d.prepare('SELECT * FROM workflows ORDER BY updated_at DESC LIMIT ?').all(limit);
  return rows.map(normalizeWorkflow);
}

function createWorkflow(input = {}) {
  const title = String(input.title || input.input || '').trim();
  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (!title) return { ok: false, error: 'title required' };
  if (!steps.length) return { ok: false, error: 'at least one step required' };
  const workflowId = id();
  const created = now();
  const sessionId = String(input.session_id || 'default');
  const priority = Number(input.priority || queue.PRIORITY.NEXT);
  const maxRetries = Math.max(0, Number(input.max_retries ?? 2));
  const d = db();
  const tx = d.transaction(() => {
    d.prepare(`INSERT INTO workflows (id,session_id,title,input,status,priority,max_retries,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(workflowId, sessionId, title, String(input.input || title), 'queued', priority, maxRetries, created, created);
    const insert = d.prepare(`INSERT INTO workflow_steps
      (workflow_id,step_key,title,kind,tool_name,params,depends_on,max_attempts)
      VALUES (?,?,?,?,?,?,?,?)`);
    const keys = new Set();
    for (let index = 0; index < steps.length; index++) {
      const s = steps[index] || {};
      const key = String(s.id || s.key || 'step_' + (index + 1));
      if (keys.has(key)) throw new Error('duplicate step key: ' + key);
      keys.add(key);
      const kind = s.kind || (s.requires_review ? 'review' : 'tool');
      if (!['tool', 'review'].includes(kind)) throw new Error('unsupported step kind: ' + kind);
      if (kind === 'tool' && !s.tool_name) throw new Error('tool_name required for ' + key);
      const dependencies = Array.isArray(s.depends_on) ? s.depends_on : [];
      for (const dependency of dependencies) {
        if (!keys.has(String(dependency))) {
          throw new Error('dependency must refer to an earlier step: ' + dependency);
        }
      }
      insert.run(workflowId, key, String(s.title || key), kind, s.tool_name || null,
        JSON.stringify(s.params || {}), JSON.stringify(dependencies),
        // max_attempts is the number of executions, max_retries is extra tries.
        Math.max(1, Number(s.max_attempts ?? (maxRetries + 1))));
    }
  });
  try { tx(); } catch (error) { return { ok: false, error: error.message }; }
  emit(workflowId, 'workflow_queued', { title, steps: steps.length });
  return { ok: true, workflow: getWorkflow(workflowId) };
}

function recoverInterrupted() {
  const d = db();
  const stamp = now();
  const interrupted = d.prepare("SELECT id FROM workflows WHERE status='running'").all();
  const tx = d.transaction(() => {
    d.prepare("UPDATE workflows SET status='queued', updated_at=?, error=? WHERE status='running'")
      .run(stamp, 'worker restarted; resuming from last committed step');
    d.prepare("UPDATE workflow_steps SET status='pending', started_at=NULL WHERE status='running'").run();
  });
  tx();
  for (const row of interrupted) emit(row.id, 'workflow_recovered', { reason: 'process restart' });
  return { recovered: interrupted.length };
}

function readyStep(workflow) {
  const finished = new Set(workflow.steps.filter(s => s.status === 'completed').map(s => s.step_key));
  return workflow.steps.find(s => s.status === 'pending' && s.depends_on.every(dep => finished.has(dep)));
}

function completedResult(workflow) {
  return {
    workflow_id: workflow.id,
    title: workflow.title,
    completed_at: now(),
    steps: workflow.steps.map(step => ({
      step_key: step.step_key,
      title: step.title,
      kind: step.kind,
      tool_name: step.tool_name,
      result: step.result,
    })),
  };
}

async function runOne() {
  if (_executing) return null;
  _executing = true;
  try {
    const d = db();
    const row = d.prepare("SELECT id FROM workflows WHERE status='queued' ORDER BY priority ASC, created_at ASC LIMIT 1").get();
    if (!row) return null;
    const workflow = getWorkflow(row.id);
    const step = readyStep(workflow);
    if (!step) {
      const unresolved = workflow.steps.filter(s => s.status !== 'completed');
      if (unresolved.length === 0) {
        const result = completedResult(workflow);
        d.prepare("UPDATE workflows SET status='completed', completed_at=?, updated_at=?, result=? WHERE id=?")
          .run(result.completed_at, result.completed_at, JSON.stringify(result), workflow.id);
        goal.addProgress(workflow.session_id, '长工作流完成: ' + workflow.title);
        emit(workflow.id, 'workflow_completed', { result });
      } else {
        d.prepare("UPDATE workflows SET status='failed', error=?, completed_at=?, updated_at=? WHERE id=?")
          .run('no runnable step; dependency missing or blocked', now(), now(), workflow.id);
        emit(workflow.id, 'workflow_failed', { error: 'no runnable step' });
      }
      return workflow.id;
    }
    if (step.kind === 'review') {
      d.prepare("UPDATE workflow_steps SET status='waiting_review' WHERE id=?").run(step.id);
      d.prepare("UPDATE workflows SET status='waiting_review', updated_at=? WHERE id=?").run(now(), workflow.id);
      emit(workflow.id, 'review_required', { step_key: step.step_key, title: step.title });
      return workflow.id;
    }
    d.prepare("UPDATE workflows SET status='running', started_at=COALESCE(started_at, ?), updated_at=? WHERE id=?").run(now(), now(), workflow.id);
    d.prepare("UPDATE workflow_steps SET status='running', attempts=attempts+1, started_at=? WHERE id=?").run(now(), step.id);
    emit(workflow.id, 'step_started', { step_key: step.step_key, tool_name: step.tool_name });
    let outcome;
    try {
      const { TOOLS } = require('./tools');
      if (!TOOLS[step.tool_name]) throw new Error('tool not found: ' + step.tool_name);
      outcome = await TOOLS[step.tool_name]({ context: { user: 'feng', sessionId: workflow.session_id, workflowId: workflow.id }, params: step.params });
      if (!outcome || outcome.ok === false) throw new Error((outcome && outcome.error && (outcome.error.message || outcome.error.code)) || 'tool failed');
    } catch (error) {
      const latest = d.prepare('SELECT attempts,max_attempts FROM workflow_steps WHERE id=?').get(step.id);
      const retry = latest.attempts < latest.max_attempts;
      d.prepare("UPDATE workflow_steps SET status=?, error=?, completed_at=? WHERE id=?")
        .run(retry ? 'pending' : 'failed', String(error.message || error).slice(0, 1000), retry ? null : now(), step.id);
      if (retry) {
        d.prepare("UPDATE workflows SET status='queued', retry_count=retry_count+1, updated_at=?, error=? WHERE id=?")
          .run(now(), String(error.message || error).slice(0, 1000), workflow.id);
        emit(workflow.id, 'step_retrying', { step_key: step.step_key, error: String(error.message || error) });
      } else {
        d.prepare("UPDATE workflows SET status='failed', completed_at=?, updated_at=?, error=? WHERE id=?")
          .run(now(), now(), String(error.message || error).slice(0, 1000), workflow.id);
        emit(workflow.id, 'workflow_failed', { step_key: step.step_key, error: String(error.message || error) });
      }
      return workflow.id;
    }
    d.prepare("UPDATE workflow_steps SET status='completed', result=?, completed_at=? WHERE id=?")
      .run(JSON.stringify(outcome), now(), step.id);
    d.prepare("UPDATE workflows SET status='queued', updated_at=?, error=NULL WHERE id=?").run(now(), workflow.id);
    saveCheckpoint(workflow.session_id, { round: step.id, taskInput: workflow.input, messages: [], lastToolCall: { name: step.tool_name, params: step.params } });
    goal.addProgress(workflow.session_id, '完成步骤: ' + step.title);
    emit(workflow.id, 'step_completed', { step_key: step.step_key, result: outcome });
    return workflow.id;
  } finally { _executing = false; }
}

function approveReview(workflowId, approved, note = '') {
  const workflow = getWorkflow(workflowId);
  if (!workflow || workflow.status !== 'waiting_review') return { ok: false, error: 'workflow is not waiting for review' };
  const step = workflow.steps.find(s => s.status === 'waiting_review');
  if (!step) return { ok: false, error: 'review step missing' };
  const d = db();
  if (!approved) {
    d.prepare("UPDATE workflow_steps SET status='failed', error=?, completed_at=? WHERE id=?").run(note || 'rejected by reviewer', now(), step.id);
    d.prepare("UPDATE workflows SET status='failed', error=?, completed_at=?, updated_at=? WHERE id=?").run(note || 'rejected by reviewer', now(), now(), workflowId);
    emit(workflowId, 'review_rejected', { step_key: step.step_key, note });
    return { ok: true, workflow: getWorkflow(workflowId) };
  }
  d.prepare("UPDATE workflow_steps SET status='completed', result=?, completed_at=? WHERE id=?").run(JSON.stringify({ approved: true, note }), now(), step.id);
  d.prepare("UPDATE workflows SET status='queued', updated_at=? WHERE id=?").run(now(), workflowId);
  emit(workflowId, 'review_approved', { step_key: step.step_key, note });
  return { ok: true, workflow: getWorkflow(workflowId) };
}

function cancelWorkflow(workflowId, note = '') {
  const d = db();
  const changed = d.prepare("UPDATE workflows SET status='cancelled', error=?, completed_at=?, updated_at=? WHERE id=? AND status IN ('queued','running','waiting_review')")
    .run(note || 'cancelled by user', now(), now(), workflowId).changes;
  if (changed) emit(workflowId, 'workflow_cancelled', { note });
  return { ok: !!changed };
}

function listEvents(workflowId, afterId = 0, limit = 100) {
  return db().prepare('SELECT * FROM workflow_events WHERE workflow_id=? AND id>? ORDER BY id ASC LIMIT ?')
    .all(workflowId, Number(afterId) || 0, Math.min(Number(limit) || 100, 500))
    .map(row => ({ ...row, data: parse(row.data, {}) }));
}

function start(intervalMs = 2000) {
  if (_timer) return { ok: true, already_started: true };
  recoverInterrupted();
  _timer = setInterval(() => { runOne().catch(error => console.warn('[workflow] worker error:', error.message)); }, intervalMs);
  if (_timer.unref) _timer.unref();
  setImmediate(() => runOne().catch(error => console.warn('[workflow] initial worker error:', error.message)));
  return { ok: true, interval_ms: intervalMs };
}

module.exports = { createWorkflow, getWorkflow, listWorkflows, runOne, start, recoverInterrupted, approveReview, cancelWorkflow, listEvents, events, WORKFLOW_STATES };
