'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const transport = require('../modules/model_transport');

test('canonical provider model name wins over Pangu internal id', () => {
  assert.equal(transport.canonicalModelName({
    id: 'minimax_m3.1-flash-preview',
    name: 'MiniMax-M3.1-Flash-Preview',
    api_model: 'MiniMax-M3.1-Flash-Preview',
  }), 'MiniMax-M3.1-Flash-Preview');
  assert.equal(transport.canonicalModelName({ id: 'proxy-model', name: 'vendor-model' }), 'vendor-model');
});

test('protocol aliases and endpoint fingerprints are provider-neutral', () => {
  assert.equal(transport.normalizeProtocol({ protocol: 'anthropic-messages', endpoint: 'https://relay.example/v1' }), 'anthropic');
  assert.equal(transport.normalizeProtocol({ provider: 'anthropic', endpoint: 'https://relay.example/v1' }), 'anthropic');
  assert.equal(transport.normalizeProtocol({ provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }), 'ollama');
  assert.equal(transport.normalizeProtocol({ provider: 'custom', endpoint: 'https://relay.example/v1' }), 'openai');
});

test('simplified cloud/local endpoints become one valid request path', () => {
  assert.equal(
    transport.normalizeEndpoint('https://relay.example/v1', 'openai'),
    'https://relay.example/v1/chat/completions'
  );
  assert.equal(
    transport.normalizeEndpoint('https://relay.example/v1', 'anthropic'),
    'https://relay.example/v1/messages'
  );
  assert.equal(
    transport.normalizeEndpoint('http://127.0.0.1:1234', 'openai'),
    'http://127.0.0.1:1234/v1/chat/completions'
  );
  assert.equal(
    transport.normalizeEndpoint('http://127.0.0.1:11434', 'ollama'),
    'http://127.0.0.1:11434/v1/chat/completions'
  );
  assert.equal(
    transport.normalizeEndpoint('http://127.0.0.1:11434/api/chat', 'ollama-native'),
    'http://127.0.0.1:11434/v1/chat/completions'
  );
});

test('auth headers do not send an empty bearer token to local or proxy endpoints', () => {
  assert.deepEqual(transport.authHeaders({ protocol: 'openai' }, ''), { 'Content-Type': 'application/json' });
  assert.deepEqual(transport.authHeaders({ protocol: 'anthropic' }, 'sk-test'), {
    'Content-Type': 'application/json',
    'x-api-key': 'sk-test',
    'anthropic-version': '2023-06-01',
  });
  assert.equal(transport.authHeaders({ protocol: 'openai' }, 'sk-test').Authorization, 'Bearer sk-test');
});

test('legacy callers no longer contain MiniMax URL protocol heuristics', () => {
  for (const file of [
    path.join(__dirname, '..', 'agents', 'qian.js'),
    path.join(__dirname, '..', 'agents', 'class-compat.js'),
    path.join(__dirname, '..', 'modules', 'pangu_decide.js'),
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /baseUrl\.includes\(['"]minimaxi['"]\)/);
  }
});

test('provider model onboarding uses shared protocol auth and canonical names', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'pangu-single', 'routes', 'inline_router.js'), 'utf8');
  const start = source.indexOf("pathname === '/api/llm/provider-models/add'");
  const end = source.indexOf("pathname === '/api/llm/use'", start);
  const block = source.slice(start, end);
  assert.match(block, /modelTransport\.authHeaders/);
  assert.match(block, /modelTransport\.canonicalModelName/);
  assert.doesNotMatch(block, /_bearerAuth|Authorization['\"]\s*:/);
});
