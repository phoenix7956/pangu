'use strict';
// 2026-10-18 (老板原话: «那问题就应该盘古判断几个agent并发, 不是人为控制agent并发»)
//
// 这组测的是**行为**, 不是源码形状 (形状在 dispatcher-concurrency-20261013 里钉着)。
// 用一个假的 sub-agent loop 记录"同一时刻有几个在跑", 对着两种端点各派 4 刀:
//
//   本地端点 (lmstudio / 127.0.0.1) → 峰值并发必须 = 1 (单卡串行解码)
//   云端端点 (kimi / api.kimi.com) → 峰值并发必须 > 1
//
// 为什么必须是 1: 实机 session 80004976, 本地 27B 上 4 路并发 → 2 条
// ZERO_CONTENT_TIMEOUT_300s (633.2s / 300.0s), 整轮 15 分半, 主人看着像死了。
// 原来那个"全局 3"不是更快, 是每路都慢到超时。
//
// 为什么必须 > 1: 反过来全串行也不行 —— 云端端点吃得下并发, 5 个互不相干的
// 子 agent 串着跑就是 5 倍等待时间 (2026-08-02 已经为这个把串行改回并行)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSubagentRunner } = require('../modules/subagent_runner');
const { isLocalModel } = require('../modules/router/model_cost');

// 造一个只够 _roleModelFor 读出主模型的节点配置。
function _tmpConfig() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-gate-')), 'config.json');
  fs.writeFileSync(p, JSON.stringify({ llm: { models: [], current_model_id: null } }));
  return p;
}

function _runner(model, n) {
  const results = [];
  const subTasks = Array.from({ length: n }, (_, i) => ({ agent: 'executor', task: 't' + i }));
  let inflight = 0;
  let peak = 0;
  const res = { write() {}, end() {}, writableEnded: false };
  return {
    results,
    subTasks,
    peak: () => peak,
    runAll: () => createSubagentRunner({
      res,
      sessionId: 's1',
      userInput: 'u',
      model,
      configPath: _tmpConfig(),
      subTasks,
      results,
      safeResWrite: () => {},
      runSubAgentLoop: async () => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 25));
        inflight--;
        return { summary: 's', toolsUsed: [], artifacts: [] };
      },
    }).runAll(),
  };
}

test('本地端点: 4 刀互不相干也只能同时跑 1 路 (单卡串行解码)', async () => {
  const model = { id: 'qwen3.8-27b-mlx', provider: 'lmstudio', api_base: 'http://127.0.0.1:1234/v1' };
  assert.equal(isLocalModel(model), true, '这条测试的前提: 这个模型确实被判成本地');
  const r = _runner(model, 4);
  await r.runAll();
  assert.equal(r.peak(), 1, '本地端点峰值并发必须是 1 —— 塞更多不是更快, 是每路都慢到撞 300s 超时');
  assert.equal(r.results.length, 4, '4 刀都要跑到完 (排队不等于丢掉)');
});

test('云端端点: 4 刀互不相干必须真并行 (不能因为修了本地就把云端也降成串行)', async () => {
  const model = { id: 'k3', provider: 'kimi', api_base: 'https://api.kimi.com/v1' };
  assert.equal(isLocalModel(model), false, '这条测试的前提: 这个模型确实被判成云端');
  const r = _runner(model, 4);
  await r.runAll();
  assert.ok(r.peak() > 1, `云端端点应该并行 (实测峰值 ${r.peak()}) —— 全串行就是 4 倍等待时间`);
  assert.equal(r.results.length, 4, '4 刀都要跑到完');
});

test('排队时要报一声 —— 没抢到槽位的刀必须让主人看见', async () => {
  const model = { id: 'qwen3.8-27b-mlx', provider: 'lmstudio', api_base: 'http://127.0.0.1:1234/v1' };
  const seen = [];
  const res = {
    write(d) { seen.push(String(d)); },
    end() {}, writableEnded: false,
  };
  // safeResWrite 认的是 SSE 文本 (event:/data:), 这里直接把 status 事件挑出来。
  const results = [];
  await createSubagentRunner({
    res,
    sessionId: 's2',
    userInput: 'u',
    model,
    configPath: _tmpConfig(),
    subTasks: Array.from({ length: 3 }, (_, i) => ({ agent: 'executor', task: 't' + i })),
    results,
    // safeResWrite 收的是 (res, eventName, payload), 拼成 SSE 文本好让下面断言。
    safeResWrite: (_r, ev, payload) => {
      seen.push('event: ' + ev + '\ndata: ' + JSON.stringify(payload || {}));
    },
    runSubAgentLoop: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { summary: 's', toolsUsed: [], artifacts: [] };
    },
  }).runAll();
  assert.ok(
    seen.some((s) => s.includes('sub_agent_queue')),
    '本地端点 3 刀必然有 2 刀排队, 必须发 sub_agent_queue —— 不报的话主人看到的就是一片死寂'
  );
});
