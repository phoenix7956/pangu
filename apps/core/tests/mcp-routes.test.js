'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const adapter = require('../modules/mcp_adapter');
const route = require('../pangu-single/routes/mcp');

function invoke(method, pathname, body) {
  const req = new EventEmitter();
  req.method = method;
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
  };
  const ended = new Promise(resolve => {
    res.end = text => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) });
  });
  const handled = route.handler(req, res, pathname);
  if (body !== undefined) {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  }
  return Promise.all([handled, ended]).then(([, response]) => response);
}

async function main() {
  const originalCollect = adapter._collectAllToolSchemas;
  const originalCall = adapter._callMcpTool;
  try {
    adapter._collectAllToolSchemas = () => { throw new Error('injected schema failure'); };
    const failed = await invoke('GET', '/api/mcp/tools');
    assert.equal(failed.status, 500);
    assert.equal(failed.body.ok, false);
    assert.equal(failed.body.error, 'MCP_SCHEMA_COLLECTION_FAILED');

    adapter._callMcpTool = async (_name, params) => ({ ok: true, data: params });
    const args = { path: '/read-only/path' };
    const fromArgs = await invoke('POST', '/api/mcp/call', { server: 'filesystem-mcp', tool: 'list_directory', args });
    const fromParams = await invoke('POST', '/api/mcp/call', { server: 'filesystem-mcp', tool: 'list_directory', params: args });
    assert.deepEqual(fromArgs.body.data, args);
    assert.deepEqual(fromParams.body.data, args);
  } finally {
    adapter._collectAllToolSchemas = originalCollect;
    adapter._callMcpTool = originalCall;
  }
  process.stdout.write('mcp-routes.test.js: PASS\n');
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
