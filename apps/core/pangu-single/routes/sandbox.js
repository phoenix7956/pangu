// pangu-single/routes/sandbox.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const safeGuard = require('../safe-guard/global');
const { checkLocalOrigin } = require('./route_security');

let _sandboxModule = null;
function loadSandboxModule() {
  if (!_sandboxModule) {
    try { _sandboxModule = require(path.join(__dirname, '..', '..', 'modules', 'sandbox')); } catch (e) { if (process.env.PANGU_DEBUG) console.warn('[pangu] suppressed error:', e.message); }
  }
  return _sandboxModule;
}

async function handler(req, res, pathname) {
  if (pathname === '/api/sandbox/pending' && req.method === 'GET') {
    try {
      const m = loadSandboxModule();
      if (!m) return res.end(JSON.stringify({ ok: false, error: 'sandbox module not loaded' }));
      const pending = [];
      const now = Date.now();
      for (const [taskId, task] of m.PENDING_APPROVALS) {
        if (task.status !== 'pending') continue;
        pending.push({ task_id: taskId, tool: task.tool, reason: task.reason, status: task.status, timestamp: task.timestamp, age_seconds: Math.floor((now - task.timestamp) / 1000) });
      }
      pending.sort((a, b) => b.timestamp - a.timestamp);
      res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
      return res.end(JSON.stringify({ ok: true, pending, count: pending.length }));
    } catch (e) {
      safeGuard.writeCrash('sandbox-pending-error', e);
      res.writeHead(500, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if ((pathname === '/api/sandbox/approve' || pathname === '/api/sandbox/reject') && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return { consumed: true };
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const m = loadSandboxModule();
        if (!m) {
          res.writeHead(500, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ ok: false, error: 'sandbox module not loaded' }));
        }
        let payload;
        try { payload = JSON.parse(body || '{}'); }
        catch (_) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ ok: false, error: 'INVALID_JSON' }));
        }
        const r = pathname === '/api/sandbox/approve' ? m.approveTask(payload.task_id, !!payload.permanent) : m.rejectTask(payload.task_id);
        res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
        return res.end(JSON.stringify(r));
      } catch (e) {
        if (e && e.code === 'INVALID_JSON') {
          res.writeHead(400, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ ok: false, error: 'INVALID_JSON' }));
        }
        safeGuard.writeCrash('sandbox-approve-reject-error', e);
        res.writeHead(500, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return { consumed: true };
  }
  return { consumed: false };
}

module.exports = { handler };
