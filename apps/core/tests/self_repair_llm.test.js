// self_repair_llm.test.js — 自愈 LLM 精修路径实测 (2026-09-14 老板拍 #7)
// 此前只测过规则快修 (const→let), LLM 精修路径从未真跑过。
// 本测试用真实模型 (活配置里挑) 走通: 假崩溃 → _llmFix 出补丁 → _applyPatch 应用 → node --check 验证。
// 跑法: node --test apps/core/tests/self_repair_llm.test.js
// 注意: 会真调一次云端模型 (temperature 0, max 800 tokens); 网络/额度挂了按 skip 处理不误报。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const sr = require('../modules/self_repair');
const { _ruleFix, _llmFix, _applyPatch, _topCoreFrame } = sr._internals;

const FIXTURE = path.join(__dirname, 'fixtures', 'self_repair_fixture.js');

function loadLiveConfig() {
  const p = require(path.join(__dirname, '..', 'config', 'node_config')).resolveNodeConfigPathOrExample();
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// 构造一个指向夹具的假崩溃 (规则快修不中的类型 → 强制走 LLM)
function makeCrash() {
  const stack = 'TypeError: Cannot read properties of undefined (reading \'trim\')\n'
    + '    at normalizeTitle (' + FIXTURE + ':6:24)\n'
    + '    at Object.<anonymous> (/Users/you/Desktop/pangu/apps/core/tests/x.js:1:1)';
  return { message: "Cannot read properties of undefined (reading 'trim')", stack };
}

test('_topCoreFrame: 从栈里定位 apps/core 内的帧', () => {
  const frame = _topCoreFrame(makeCrash().stack);
  assert.ok(frame, '应找到帧');
  assert.strictEqual(frame.file, FIXTURE);
  assert.strictEqual(frame.line, 6);
});

test('_ruleFix: const→let 规则快修仍然工作', () => {
  const src = "const x = 1;\nfunction f() {\n  x += 2;\n  return x;\n}\n";
  const err = { message: 'Assignment to constant variable.' };
  const frame = { file: '/fake.js', line: 3 };
  const patch = _ruleFix(err, frame, src);
  assert.ok(patch && patch.rule === 'const_to_let' && patch.var === 'x');
  assert.ok(patch.replace.startsWith('let'));
});

test('LLM 精修真跑: 出补丁 → 唯一匹配 → 应用 → 语法验证', { timeout: 90000 }, async (t) => {
  let cfg;
  try { cfg = loadLiveConfig(); } catch (e) { t.skip('活配置不可用: ' + e.message); return; }
  const err = makeCrash();
  const frame = _topCoreFrame(err.stack);
  const src = fs.readFileSync(FIXTURE, 'utf8');

  // 规则快修必须不中 (不是 const 赋值事故)
  assert.strictEqual(_ruleFix(err, frame, src), null, '此崩溃类型不应命中规则快修');

  const patch = _llmFix(err, frame, src, cfg);
  if (!patch) { t.skip('LLM 未返回可用补丁 (网络/额度/模型拒答) — 不算代码失败'); return; }
  assert.strictEqual(patch.rule, 'llm');
  assert.ok(patch.find.length > 0, 'find 非空');
  assert.ok(src.includes(patch.find), 'find 必须在原文中');

  // 在夹具副本上应用 (不碰真夹具, 防测试本身污染)
  const tmpCopy = path.join(os.tmpdir(), 'self_repair_fixture_copy_' + Date.now() + '.js');
  fs.writeFileSync(tmpCopy, src);
  try {
    const applied = _applyPatch(tmpCopy, patch);
    assert.ok(applied.ok, '补丁应通过验证: ' + (applied.error || ''));
    const fixed = fs.readFileSync(tmpCopy, 'utf8');
    assert.notStrictEqual(fixed, src, '文件应有变化');
    console.log('  [llm-patch] find:', JSON.stringify(patch.find.slice(0, 80)));
    console.log('  [llm-patch] replace:', JSON.stringify(patch.replace.slice(0, 120)));
  } finally {
    try { fs.unlinkSync(tmpCopy); } catch (_) {}
  }
});

test('_applyPatch 守门: find 不唯一必须拒改', () => {
  const tmpCopy = path.join(os.tmpdir(), 'self_repair_dup_' + Date.now() + '.js');
  fs.writeFileSync(tmpCopy, 'const a = 1;\nconst b = 1;\n');
  try {
    const r = _applyPatch(tmpCopy, { find: 'const', replace: 'let' });
    assert.strictEqual(r.ok, false, 'find 出现 2 次必须拒');
    assert.ok(r.error.includes('不唯一'));
  } finally { try { fs.unlinkSync(tmpCopy); } catch (_) {} }
});
