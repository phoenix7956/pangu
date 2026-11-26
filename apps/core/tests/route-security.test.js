'use strict';

const assert = require('assert');
const { test } = require('node:test');
const { checkLocalOrigin, validateOutboundUrl } = require('../pangu-single/routes/route_security');

function response() {
  return { headersSent: false, writeHead(code) { this.code = code; }, end(body) { this.body = body; } };
}

test('route security allows local browser origin and rejects foreign origin', () => {
  const local = response();
  assert.equal(checkLocalOrigin({ headers: { origin: 'http://127.0.0.1:5173' } }, local), true);
  const foreign = response();
  assert.equal(checkLocalOrigin({ headers: { origin: 'https://evil.example' } }, foreign), false);
  assert.equal(foreign.code, 403);
});

test('route security blocks private outbound URLs', async () => {
  for (const url of ['http://127.0.0.1/x', 'http://localhost/x', 'http://169.254.169.254/latest/meta-data']) {
    const result = await validateOutboundUrl(url);
    assert.equal(result.ok, false, url);
    assert.equal(result.error, 'PRIVATE_URL_BLOCKED', url);
  }
});

test('route security rejects non-http schemes', async () => {
  const result = await validateOutboundUrl('file:///etc/passwd');
  assert.deepEqual(result, { ok: false, error: 'URL_SCHEME_NOT_ALLOWED' });
});
