'use strict';

// 2026-10-14: 本地端点本来就不要 api_key, 但每轮都打一行 "no api_key for model"。
// 现场: qwen3.8-27b-mlx (LM Studio @1234) 每轮刷一次 warn, 看起来像模型坏了。
// 实际请求 200 正常返回 —— 是噪音, 不是故障。
const test = require('node:test');
const assert = require('node:assert');

const { isLocalEndpoint, resolveApiKey } = require('../modules/api_key_resolver');

test('S1 本地 host 一律认得出来 (IPv4 / IPv6 / 0.0.0.0 / 无 scheme)', () => {
  for (const u of [
    'http://127.0.0.1:1234/v1/chat/completions',
    'http://localhost:1234/v1',
    'http://[::1]:1234/v1',
    'http://0.0.0.0:1234',
  ]) {
    assert.strictEqual(isLocalEndpoint(u), true, u);
  }
});

test('S2 云端不能被误判成本地 (不然真没 key 的云模型会被静默吞掉警告)', () => {
  for (const u of [
    'https://api.kimi.com/coding/v1',
    'https://api.minimaxi.com/v1/chat/completions',
    'https://api.agnes-ai.cn/v1',
    // 主机名里带 127 但不是本机
    'https://127.0.0.1.evil.com/v1',
  ]) {
    assert.strictEqual(isLocalEndpoint(u), false, u);
  }
});

test('S3 本地模型无 key 时 resolveApiKey 返回空, 调用方据 isLocalEndpoint 决定要不要告警', () => {
  const local = { id: 'qwen3.8-27b-mlx', endpoint: 'http://127.0.0.1:1234' };
  const cloud = { id: 'minimax-m3', endpoint: 'https://api.minimaxi.com/v1/chat/completions' };
  assert.strictEqual(resolveApiKey(local), '');
  assert.strictEqual(resolveApiKey(cloud), '');
  // 判据是 endpoint, 不是 provider 名 —— 同一个 provider 也可能指向本地
  assert.strictEqual(isLocalEndpoint(local.endpoint), true);
  assert.strictEqual(isLocalEndpoint(cloud.endpoint), false);
});

test('S4 垃圾输入不许崩 (URL 解析失败要返回 false 而不是抛)', () => {
  for (const bad of ['', null, undefined, 'not a url', {}]) {
    assert.strictEqual(isLocalEndpoint(bad), false, String(bad));
  }
});

