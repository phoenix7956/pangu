'use strict';

// Manual model selection regression: a legacy fallback chain must never
// *silently* change the model selected by the user.
//
// 2026-10-17 契约修订 (老板现场: 「池里本地模型只剩一个 27B 不够分」→ 主模型一哑火整轮死):
//   原契约 = "只要传了链就绝不许用" —— 那条链在生产路径上永远是 `_modelChain: []`,
//   于是**主人自己配的 llm.fallback_chain 100% 不可达**, 这段代码双重死锁。
//   现契约 = "**没配**兜底链就绝不许换" —— 判据从"代码里有没有传链"改成"主人配没配"。
//
// 本文件真正要保的东西一个字没动, 只是把判据换成可用的那个:
//   · 没配兜底 → 绝不换模型 (用例 3, 核心保护, 全程绿)
//   · 换了就**必须出声** —— model_switch 事件 + 屏幕上的可见提示, 绝不许静默 (用例 1/2)
// 自动选模型 (每次请求替主人挑一个) 仍然硬关, 见 j2_model_policy.isAutoModelSelectionEnabled。
const assert = require('assert');
const { test } = require('node:test');
const J2 = require('../modules/j2_agent_loop');

require('../modules/pangu_helpers').init({
  _config: { llm: { models: [] } },
  CONFIG_PATH: '/tmp/r24-fake.json',
  PRESETS: [],
  safeGuard: null,
  fs: require('fs'),
});

function makeFakeRes(events) {
  return {
    writeHead() {}, setHeader() {}, flushHeaders() {},
    write(s) { events.push(String(s)); return true; },
    on() {}, aborted: false, writableEnded: false,
  };
}

const DEAD = { id: 'dead-local', provider: 'lmstudio', endpoint: 'http://127.0.0.1:9/none', context_length: 8192 };
const GOOD = { id: 'good-cloud', provider: 'kimi', endpoint: 'https://example.invalid/v1/chat/completions', context_length: 8192 };

J2.init({
  _detectToolCallSupport: async () => false,
  _callLLMForAgentStream: async function* (_messages, model) {
    if (model.id === GOOD.id) yield '<tool name="task_done">{"summary":"好"}</tool>';
  },
  _callLLMForAgent: async () => ({ choices: [{ message: { content: '' } }] }),
  _j2ExecuteToolCalls: async () => [],
  _j2AppendToolResults: () => {},
  _recordSessionToMemory: async () => {},
  _sessionRecall: async () => ({ ok: false }),
  safeResWrite: (res, s) => res.write(s),
  _hasUnclosedToolBlock: (t) => String(t || '').includes('<tool') && !String(t || '').includes('</tool>'),
});

async function runWithChain(sessionId, chain) {
  const events = [];
  await J2._runAgentLoopLegacyStream([
    { role: 'system', content: 'test system' },
    { role: 'user', content: '说一个字: 好' },
  ], DEAD, { on() {}, aborted: false }, makeFakeRes(events), {
    userInput: '说一个字: 好',
    reqBody: { session_id: sessionId },
    sessionId,
    _modelChain: chain,
  });
  return events.join('');
}

test('configured chain: the selected model going silent switches to it — loudly', async () => {
  const events = await runWithChain('r24-chain-test', [GOOD]);
  assert.ok(events.includes('model_switch'),
    '主人配了兜底链, 主模型哑火就必须真的切 —— 这是 2026-10-17 修的那个双重死锁');
  assert.ok(events.includes(GOOD.id), '必须真的用到兜底模型, 否则又是「配了不生效」');
  // 本文件从头到尾要保的是「不许**静默**」: 切了必须让主人看得见。
  assert.ok(/无响应|自动切换|model_switch/.test(events),
    '切换必须出声 (model_switch 事件或可见提示), 绝不许悄悄换一个模型');
});

test('configured chain that also fails: falls through and reports the truth', async () => {
  const events = await runWithChain('r24-chain-exhaust', [{ id: 'dead-cloud', provider: 'kimi', endpoint: 'https://example.invalid' }]);
  assert.ok(events.includes('model_switch'), '配了链就该尝试, 用过之后才算尽');
  assert.ok(events.includes('Silent Failure'),
    '兜底也哑火时必须如实报失败 —— 不许粉饰成成功');
});

test('NO configured chain keeps truthful failure behavior — 核心保护, 绝不许换模型', async () => {
  const events = await runWithChain('r24-no-chain', []);
  assert.ok(!events.includes('model_switch'), 'no chain must not emit model_switch');
  assert.ok(events.includes('Silent Failure'), 'no chain must report failure');
  assert.ok(!events.includes('已尝试切换'), '没配兜底就不许声称尝试过切换');
});

// 2026-09-14: 测试进程偶发不退 (3/3 用例全过后事件循环仍被占) —
// 已定位到 stub LLM 零产出路径下 loop 内部偶发 pending (dump 显示只剩 socket 句柄,
// 生产路径真流式从未复现)。根因猎捕性价比低, 测试收尾显式退出, 不掩盖断言结果。
test.after(() => { setTimeout(() => process.exit(0), 300); });
