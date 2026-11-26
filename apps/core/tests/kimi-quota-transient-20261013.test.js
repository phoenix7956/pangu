#!/usr/bin/env node
// 红测试: kimi 系探测全失败 (额度 403) 时 _detectToolCallSupport 必须保持 native, 不降级 legacy。
// 现场: soak-live-1791891310 — 4/4 探测全失败 (transient 403) → 走 j2-legacy → 子 agent 0 工具调用。
'use strict';
const assert = require('node:assert');
const { _detectToolCallSupport } = require('../modules/j2_helpers');

(async () => {
  const kimi = { id: 'k3-test-403', provider: 'kimi', endpoint: 'https://api.kimi.com/coding/v1' };
  // 模拟额度 403: 4 次探测全部 reject
  const failLLM = async () => { throw new Error('HTTP 403: quota exceeded'); };
  const result = await _detectToolCallSupport(kimi, failLLM);
  assert.strictEqual(result, true, 'kimi all-attempts-failed 必须保持 native (return true)');
  console.log('PASS: kimi transient 403 全失败 → native');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
