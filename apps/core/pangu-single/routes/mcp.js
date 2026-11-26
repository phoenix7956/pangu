// pangu-single/routes/mcp.js
'use strict';
const path = require('path');
const safeGuard = require('../safe-guard/global');
const { checkLocalOrigin } = require('./route_security');

function json(res, obj, status) {
  res.statusCode = status || 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
  return { consumed: true };
}

async function handler(req, res, pathname) {
  if (pathname === '/api/mcp/servers' && req.method === 'GET') {
    try {
      const { loadMcpServers } = require(path.join(__dirname, '..', '..', 'modules', 'mcp_loader'));
      const list = loadMcpServers();
      // 2026-08-02 根治 (老板实证): 之前是硬编码 stub — toolCountMap 拍脑袋 + enabled 就当 connected, 全是假的
      // 现在读 mcp_adapter 运行时真状态 (_multiAdapters 里真 spawn 的进程 + 真 syncTools 数)
      let live = { servers: 0, tools: 0, perServer: {} };
      try { live = require(path.join(__dirname, '..', '..', 'modules', 'mcp_adapter'))._toolStats(); } catch (_) {}
      const enriched = (list || []).map(s => Object.assign({}, s, {
        status: (s.enabled && (live.perServer || {})[s.name] != null) ? 'connected' : (s.enabled ? 'spawn_failed' : 'disabled'),
        tool_count: (live.perServer || {})[s.name] || 0,
        error: null,
      }));
      return json(res, { ok: true, servers: enriched, count: enriched.length, live_tools: live.tools });
    } catch (e) {
      safeGuard.writeCrash('mcp-servers-error', e);
      return json(res, { ok: false, error: e.message }, 500);
    }
  }
  if (pathname === '/api/mcp/tools' && req.method === 'GET') {
    // 2026-08-02 根治: 真 schema 从 mcp_adapter._collectAllToolSchemas() 取 (mcp__<server>__<tool> 命名)
    try {
      const schemas = require(path.join(__dirname, '..', '..', 'modules', 'mcp_adapter'))._collectAllToolSchemas();
      const tools = schemas.map(sc => ({ name: sc.function.name, description: String(sc.function.description || '').slice(0, 120) }));
      return json(res, { ok: true, tools, count: tools.length });
    } catch (e) {
      return json(res, { ok: false, error: 'MCP_SCHEMA_COLLECTION_FAILED', message: e.message }, 500);
    }
  }
  if (pathname === '/api/mcp/call' && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return { consumed: true };
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let req_body;
      try { req_body = JSON.parse(body || '{}'); }
      catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
      try {
        // 2026-08-02 根治: stub 下岗, 真调 mcp_adapter._callMcpTool (mcp__<server>__<tool>)
        const namespaced = ('' + (req_body.tool || '')).startsWith('mcp__') ? req_body.tool : ('mcp__' + req_body.server + '__' + req_body.tool);
        const params = req_body.args ?? req_body.params ?? {};
        const r = await require(path.join(__dirname, '..', '..', 'modules', 'mcp_adapter'))._callMcpTool(namespaced, params);
        return json(res, r, r.ok ? 200 : 502);
      } catch (e) {
        safeGuard.writeCrash('mcp-call-error', e);
        return json(res, { ok: false, error: 'BAD_REQUEST' }, 400);
      }
    });
    return { consumed: true };
  }
  if (pathname === '/api/mcp/restart' && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return { consumed: true };
    try {
      const { loadMcpServers } = require(path.join(__dirname, '..', '..', 'modules', 'mcp_loader'));
      const adapter = require(path.join(__dirname, '..', '..', 'modules', 'mcp_adapter'));
      const servers = loadMcpServers();
      await adapter._setServers(servers);
      const live = adapter._toolStats();
      return json(res, { ok: true, restarted: true, servers: live.servers, tools: live.tools, perServer: live.perServer });
    } catch (e) {
      safeGuard.writeCrash('mcp-restart-error', e);
      return json(res, { ok: false, restarted: false, error: e.message }, 500);
    }
  }
  if (pathname === '/api/mcp/servers' && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return { consumed: true };
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let req_body;
      try { req_body = JSON.parse(body || '{}'); }
      catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
      try {
        // §0.49 batch4 fix: loadAllMcpServers() 含 enabled=false (UI 模板), 检查会假阳性 DUPLICATE_NAME
        // 改用 loadMcpServers() (仅 enabled) + 也查模板名防止覆盖现有
        const { loadMcpServers, loadAllMcpServers, saveMcpServers, validateServer } = require(path.join(__dirname, '..', '..', 'modules', 'mcp_loader'));
        const list = loadAllMcpServers();
        const enabledList = loadMcpServers();
        const v = validateServer(req_body);
        if (!v.valid) return json(res, { ok: false, error: v.error });
        if (enabledList.find(s => s.name === req_body.name)) return json(res, { ok: false, error: 'DUPLICATE_NAME', hint: '该 server 已 enabled 存在,先禁用或删除再添加' });
        if (list.find(s => s.name === req_body.name)) {
          // 模板里有同名的 enabled=false — 覆盖 enable 它
          const idx = list.findIndex(s => s.name === req_body.name);
          list[idx] = Object.assign({}, req_body, { enabled: true });
          saveMcpServers(list);
          return json(res, { ok: true, server: list[idx], count: list.length, action: 'replaced_template' });
        }
        list.push(Object.assign({}, req_body, { enabled: true }));
        saveMcpServers(list);
        return json(res, { ok: true, server: req_body, count: list.length });
      } catch (e) {
        safeGuard.writeCrash('mcp-servers-post-error', e);
        return json(res, { ok: false, error: e.message }, 500);
      }
    });
    return { consumed: true };
  }
  const patchMatch = pathname.match(/^\/api\/mcp\/servers\/([^/]+)$/);
  if (patchMatch && req.method === 'GET') {
    try {
      const { loadAllMcpServers } = require(path.join(__dirname, '..', '..', 'modules', 'mcp_loader'));
      const list = loadAllMcpServers();
      const server = list.find(s => s.name === patchMatch[1]);
      if (!server) return json(res, { ok: false, error: 'NOT_FOUND' }, 404);
      return json(res, { ok: true, server });
    } catch (e) {
      safeGuard.writeCrash('mcp-servers-get-one-error', e);
      return json(res, { ok: false, error: e.message }, 500);
    }
  }
  if (patchMatch && req.method === 'PATCH') {
    if (!checkLocalOrigin(req, res)) return { consumed: true };
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let patch;
      try { patch = JSON.parse(body || '{}'); }
      catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
      try {
        const { loadAllMcpServers, saveMcpServers } = require(path.join(__dirname, '..', '..', 'modules', 'mcp_loader'));
        const list = loadAllMcpServers();
        const idx = list.findIndex(s => s.name === patchMatch[1]);
        if (idx === -1) return json(res, { ok: false, error: 'NOT_FOUND' }, 404);
        list[idx] = { ...list[idx], ...patch };
        saveMcpServers(list);
        return json(res, { ok: true, server: list[idx] });
      } catch (e) {
        safeGuard.writeCrash('mcp-servers-patch-error', e);
        return json(res, { ok: false, error: e.message }, 500);
      }
    });
    return { consumed: true };
  }
  if (patchMatch && req.method === 'DELETE') {
    if (!checkLocalOrigin(req, res)) return { consumed: true };
    try {
      const { loadAllMcpServers, saveMcpServers } = require(path.join(__dirname, '..', '..', 'modules', 'mcp_loader'));
      const list = loadAllMcpServers();
      const idx = list.findIndex(s => s.name === patchMatch[1]);
      if (idx === -1) return json(res, { ok: false, error: 'NOT_FOUND' }, 404);
      list.splice(idx, 1);
      saveMcpServers(list);
      return json(res, { ok: true, removed: patchMatch[1], count: list.length });
    } catch (e) {
      safeGuard.writeCrash('mcp-servers-delete-error', e);
      return json(res, { ok: false, error: e.message }, 500);
    }
  }
  return { consumed: false };
}

module.exports = { handler };
