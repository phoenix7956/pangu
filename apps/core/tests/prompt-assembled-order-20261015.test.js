'use strict';
// 2026-10-15 「当前时间」其实没挪到底 —— 上一个测试是假绿
//
// prompt-prefix-stability-20261015.test.js 断言 "时间必须是最后一条 system", 并且**通过了**。
// 它只测 `_buildSystemMessages` 这一个函数的返回值, 而真实消息流还要经过
// `_injectSoulSysMsgs` 拼装: [soul msgs][调用方传的 system][对话]。
// j2_agent_loop native 路径传给调用方的那条 system 前面粘着 `_getGlobalRules()`
// (实测 4829 token 的环境+全局铁律), 拼装后它排在时间**后面**。
//
// 实测画像 (14912 token, 2026-10-15 17:25):
//   8:system=45   # 当前时间 (权威) 2026/10/15 17:25 …
//   9:system=4829 [运行环境 — 路径铁律] 主机: fengdeMacB…
//
// 后果: 分钟一跳 → 时间变 → 后面 4829 个 token 的前缀缓存一起作废。
// 本地 27B prefill ~285 tok/s, 4829 token ≈ 17s —— 正好是"一句闲聊要 26s"里的大头。
//
// 修: 时间挪到**整条消息流**里最后一条 system (所有静态块之后, 对话之前)。
// 时间是唯一分钟级会动的东西, 提示词缓存只认从头开始的公共前缀, 动的必须全垫在不动之后。

const test = require('node:test');
const assert = require('node:assert/strict');

function init() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/pangu/apps/core/modules/llm_caller.js')) delete require.cache[k];
  }
  const lc = require('../modules/llm_caller');
  lc.init({
    _config: { llm: { models: [{}] }, memory: {} },
    fs: require('fs'), path: require('path'), os: require('os'),
    https: require('https'), http: require('http'),
    PRESETS: {}, PANGU_SYSTEM_PROMPT: 'SOUL_BASE',
    _getPromptFacts: () => ({ toolCount: 127, skillCount: 0, skillManifest: '(空)', mcp: { tools: 0, servers: 0 } }),
  });
  return lc;
}

const isTime = (m) => /^# 当前时间 \(权威\)/.test(String((m || {}).content || ''));
const isEvo = (m) => /^# Pangu 自我进化数据/.test(String((m || {}).content || ''));

test('拼装后: 时间必须是最后一条 system (调用方传进来的大块也必须在它前面)', () => {
  const lc = init();
  // 模拟 j2_agent_loop native 路径: 调用方自己带一条 system, 前面粘着巨大的全局规则块
  const callerSys = { role: 'system', content: '[运行环境 — 路径铁律] 主机: x.local\n' + 'R'.repeat(14000) };
  const assembled = lc._injectSoulSysMsgs([callerSys, { role: 'user', content: 'hi' }], {});

  const iTime = assembled.findIndex(isTime);
  assert.ok(iTime >= 0, '时间消息必须还在 (2026-07-26 老板定的: 治模型拿旧时间回答"现在几点")');

  const lastSys = assembled.map(m => m.role).lastIndexOf('system');
  assert.equal(iTime, lastSys,
    '时间必须排在整条消息流的最后一条 system, 不能只是 _buildSystemMessages 内部的最后一条');
});

test('拼装后: 大块静态内容必须在时间之前 (前缀缓存只认从头开始的公共前缀)', () => {
  const lc = init();
  const callerSys = { role: 'system', content: '[运行环境 — 路径铁律] 主机: x.local\n' + 'R'.repeat(14000) };
  const assembled = lc._injectSoulSysMsgs([callerSys, { role: 'user', content: 'hi' }], {});

  const iBig = assembled.findIndex(m => String(m.content || '').includes('[运行环境 — 路径铁律]'));
  const iTime = assembled.findIndex(isTime);
  assert.ok(iBig >= 0, '调用方的 system 必须还在');
  assert.ok(iBig < iTime,
    '静态大块被排到了会动的时间后面 —— 分钟一跳就把它连同后面所有内容的缓存作废');
});

test('拼装后: 时间仍然在对话之前 (不能沉到 user 轮后面去)', () => {
  const lc = init();
  const assembled = lc._injectSoulSysMsgs([{ role: 'system', content: '[CALLER]' }, { role: 'user', content: 'hi' }], {});
  const iTime = assembled.findIndex(isTime);
  const iUser = assembled.findIndex(m => m.role === 'user');
  assert.ok(iUser >= 0, '要有 user 轮');
  assert.ok(iTime < iUser,
    '时间必须在 user 轮之前 —— 模型看不到"当前时间"就会拿记忆里的旧时间回答"现在几点"');
});

test('内容一个字都不能少: 只挪位置, 不许顺手把任何一条 system 丢掉', () => {
  const lc = init();
  const callerA = { role: 'system', content: '[CALLER_A]' };
  const callerB = { role: 'system', content: '[CALLER_B]' };
  const withCallers = lc._injectSoulSysMsgs([callerA, callerB, { role: 'user', content: 'hi' }], {});
  const withoutCallers = lc._injectSoulSysMsgs([{ role: 'user', content: 'hi' }], {});
  const n = withoutCallers.length;
  assert.equal(withCallers.length, n + 2, '调用方传进来的每一条 system 都必须原样保留');
  assert.ok(withCallers.some(m => m.content === '[CALLER_A]'));
  assert.ok(withCallers.some(m => m.content === '[CALLER_B]'));
  assert.ok(withoutCallers.some(isTime), '没有调用方 system 时, 时间仍然必须注入');
});

test('没有当前时间的环境 (测试模式) 也不能因为这次改动崩掉', () => {
  const lc = init();
  const assembled = lc._injectSoulSysMsgs([{ role: 'user', content: 'hi' }], {});
  assert.ok(Array.isArray(assembled) && assembled.length > 0, '拼装必须仍返回非空消息流');
  assert.ok(assembled.some(m => m.role === 'user' && m.content === 'hi'), 'user 轮必须还在');
});

test('自我进化快照 (5 分钟 TTL) 也必须进易变区 —— 换个位置犯第二次同一个病', () => {
  const lc = init();
  const assembled = lc._injectSoulSysMsgs([{ role: 'user', content: 'hi' }], {});
  const iEvo = assembled.findIndex(isEvo);
  if (iEvo < 0) return; // 本机没造 evolution 数据时跳过, 不给假绿
  const lastSys = assembled.map(m => m.role).lastIndexOf('system');
  assert.ok(iEvo > lastSys - 3,
    '自我进化快照在 idx ' + iEvo + ', 后面还压着 ' + (lastSys - iEvo) +
    ' 条 system —— 它一刷新, 后面这些的缓存全废 (实测 LM Studio cached 28160→18432)');
});

test('易变块全部排在最后两条 system 内 (顺序: 时间 → 进化, 都在对话之前)', () => {
  const lc = init();
  const assembled = lc._injectSoulSysMsgs([{ role: 'user', content: 'hi' }], {});
  const iUser = assembled.findIndex(m => m.role === 'user');
  const volatileIdx = assembled.map(isEvo).indexOf(true);
  const timeIdx = assembled.findIndex(isTime);
  for (const [name, idx] of [['进化', volatileIdx], ['时间', timeIdx]]) {
    if (idx < 0) continue;
    assert.ok(idx < iUser, name + '块必须在 user 轮之前 (沉到对话后面模型就看不到"现在几点")');
  }
  // 易变区里最多两条, 且都在尾部
  const sysIdx = assembled.map((m, i) => (m.role === 'system' ? i : -1)).filter(i => i >= 0);
  const lateVolatile = assembled.filter((m, i) =>
    sysIdx.includes(i) && (isTime(m) || isEvo(m)) && i < sysIdx[sysIdx.length - 3]);
  assert.equal(lateVolatile.length, 0,
    '还有 ' + lateVolatile.length + ' 条易变块没进尾部, 静态前缀还是会被它们打断');
});
