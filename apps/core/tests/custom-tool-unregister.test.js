'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const sdk = require('../modules/tools_sdk');
const plugins = require('../modules/plugin_loader');

function registry() {
  return { handlers: Object.create(null), schemas: Object.create(null), list: [] };
}

test('removing an SDK tool unregisters its live handler and schema', () => {
  const name = `codex_unregister_${process.pid}_${Date.now()}`;
  const dir = path.join(sdk.SDK_ROOT, name);
  const fullName = `sdk_${name}`;
  const tools = registry();
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, 'tool.json'), JSON.stringify({ name, parameters: { type: 'object' } }));
    tools.handlers[fullName] = () => ({ ok: true });
    tools.schemas[fullName] = { function: { name: fullName } };
    tools.list.push(fullName);

    assert.equal(sdk.removeSdkTool(name, tools), true);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(tools.handlers[fullName], undefined);
    assert.equal(tools.schemas[fullName], undefined);
    assert.deepEqual(tools.list, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removing a plugin unregisters each live handler and schema', () => {
  const name = `codex_unregister_${process.pid}_${Date.now()}`;
  const dir = path.join(plugins.PLUGIN_ROOT, name);
  const toolNames = ['first', 'second'];
  const tools = registry();
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name, tools: toolNames.map(tool => ({ name: tool })) }));
    for (const tool of toolNames) {
      const fullName = `plugin_${name}__${tool}`;
      tools.handlers[fullName] = () => ({ ok: true });
      tools.schemas[fullName] = { function: { name: fullName } };
      tools.list.push(fullName);
    }

    assert.equal(plugins.removePlugin(name, tools), true);
    assert.equal(fs.existsSync(dir), false);
    assert.deepEqual(Object.keys(tools.handlers), []);
    assert.deepEqual(Object.keys(tools.schemas), []);
    assert.deepEqual(tools.list, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
