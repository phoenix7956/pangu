'use strict';

// 2026-10-17 — 模型池故障转移: 配了就必须能用
//
// 老板现场: 「池里本地模型只剩一个 27B 不够分」→ 主模型一哑火, 整轮直接死。
//
// 修之前的形状 (**双重死代码**, 与模型池大小无关, 换台机器一样):
//   1. j2_agent_loop.js 的 model-chain switch 第一道闸门是
//      isSilentFailFallbackEnabled(), 而它在 j2_model_policy.js 里硬编码 `return false`
//      → 分支 100% 不可达
//   2. message-stream.js 传给 loop 的 `_modelChain` 是**字面量空数组**,
//      而它是全仓唯一的生产注入点 → 即使闸门开了也没链可走
//   3. r24-chain-switch.test.js 直接调 _runAgentLoopLegacyStream 并手工塞链,
//      两道门全绕开 → 所以"测试全绿但功能不存在"
//
// 与 model_config_guard 叠加成完整的「注释 ≠ 隔离」:
// guard 每次启动校验并"修好" llm.fallback_chain, 而运行时**没有任何代码读它** ——
// 维护着一份没人用的配置。
//
// 本测试全部走假 loop / 纯函数, **不发任何真实模型请求** (老板的 kimi 是 token plan,
// 拿来做健康检查是要烧额度的 —— 那是测试行为, 不是产品行为)。

const assert = require('assert');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');

const { resolveFallbackChain } = require('../modules/j2_model_policy');
const J2 = require('../modules/j2_agent_loop');

const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const DEAD = { id: 'dead-main', provider: 'lmstudio', endpoint: 'http://127.0.0.1:9/none', context_length: 8192 };
const GOOD = { id: 'good-backup', provider: 'custom', endpoint: 'https://backup.invalid/v1/chat/completions', context_length: 8192 };

function makeFakeRes(events) {
  return {
    writeHead() {}, setHeader() {}, flushHeaders() {},
    write(s) { events.push(String(s)); return true; },
    on() {}, aborted: false, writableEnded: false,
  };
}

require('../modules/pangu_helpers').init({
  _config: { llm: { models: [] } },
  CONFIG_PATH: '/tmp/failover-fake.json',
  PRESETS: [],
  safeGuard: null,
  fs: require('fs'),
});

J2.init({
  _detectToolCallSupport: async () => false,
  _callLLMForAgentStream: async function* (_messages, model) {
    if (model && model.id === GOOD.id) yield '<tool name="task_done">{"summary":"好"}</tool>';
  },
  _callLLMForAgent: async () => ({ choices: [{ message: { content: '' } }] }),
  _j2ExecuteToolCalls: async () => [],
  _j2AppendToolResults: () => {},
  _recordSessionToMemory: async () => {},
  _sessionRecall: async () => ({ ok: false }),
  safeResWrite: (res, s) => res.write(s),
  _hasUnclosedToolBlock: (t) => String(t || '').includes('<tool') && !String(t || '').includes('</tool>'),
});

async function runLoop(sessionId, chain) {
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

// ── 1. 纯函数: 链怎么构造 ────────────────────────────────────────────

test('F1 配了兜底链就产出链, 没配就是空链 (行为与改动前一致)', () => {
  const cfg = {
    llm: {
      models: [DEAD, GOOD],
      fallback_chain: ['good-backup'],
    },
  };
  const chain = resolveFallbackChain(cfg, 'dead-main');
  assert.strictEqual(chain.length, 1, '配了就必须拿到链');
  assert.strictEqual(chain[0].id, 'good-backup');

  // 没配 → 空链 → 主循环不进 chain-switch, 与改动前逐字节一致
  const none = resolveFallbackChain({ llm: { models: [DEAD, GOOD] } }, 'dead-main');
  assert.deepStrictEqual(none, [], '没配 fallback_chain 必须给空链 (不许自作主张选模型)');
});

test('F2 过滤四种链成员: 当前自己 / 悬空引用 / 已停用 / 重复', () => {
  const cfg = {
    llm: {
      models: [
        { id: 'main', provider: 'custom', endpoint: 'https://a.invalid/v1' },
        { id: 'backup', provider: 'custom', endpoint: 'https://b.invalid/v1' },
        { id: 'off', provider: 'custom', endpoint: 'https://c.invalid/v1', enabled: false },
      ],
      fallback_chain: ['main', 'ghost-does-not-exist', 'off', 'backup', 'backup'],
    },
  };
  const chain = resolveFallbackChain(cfg, 'main');
  assert.deepStrictEqual(chain.map(m => m.id), ['backup'],
    '只留 backup: 自己/幽灵/停用/重复都要剔掉');
});

test('F3 自动选模型仍然是关的 (2026-09-07 老板拍的决定一个字没动)', () => {
  const policy = require('../modules/j2_model_policy');
  assert.strictEqual(policy.isAutoModelSelectionEnabled(), false,
    '自动选模型必须仍然硬关 —— 本次改的是故障转移, 不是自动挑模型');
});

test('F3b env 逃生阀真的能关 (默认开, PANGU_SILENT_FAIL_FALLBACK=0 关掉)', () => {
  const policy = require('../modules/j2_model_policy');
  assert.strictEqual(policy.isSilentFailFallbackEnabled({}), true,
    '默认必须是开 —— 否则整段 chain-switch 又是死代码');
  assert.strictEqual(policy.isSilentFailFallbackEnabled({ PANGU_SILENT_FAIL_FALLBACK: 'false' }), false,
    'PANGU_SILENT_FAIL_FALLBACK=0/false 必须能关 (运行时逃生阀, 不必改代码发版)');
  assert.strictEqual(policy.isSilentFailFallbackEnabled({ PANGU_SILENT_FAIL_FALLBACK: '1' }), true,
    '显式开也要认');
});

// ── 2. 接线: 生产路径必须真的把链传下去 ──────────────────────────────

test('F4 生产路径不许再传字面量空数组 (那正是双重死锁的第二重)', () => {
  const src = SRC('pangu-single/routes/message-stream.js');
  assert.ok(!/_modelChain:\s*\[\]/.test(src),
    'message-stream 不许再写 `_modelChain: []` —— 那是全仓唯一生产注入点, 写空等于功能不存在');
  assert.match(src, /_modelChain:\s*\(function \(\)/,
    '生产注入点必须从配置构造链');
  assert.match(src, /resolveFallbackChain\(_config, model && model\.id\)/,
    '构造必须走 j2_model_policy.resolveFallbackChain 这一个真源');
});

test('F5 闸门两个条件都必须活着: env 可关 + 链非空 (恒 false 是当初的死因)', () => {
  const loop = SRC('modules/j2_agent_loop.js');
  const body = loop.slice(loop.indexOf('const _chain = Array.isArray(opts._modelChain)'));
  assert.match(body, /if \(isSilentFailFallbackEnabled\(\) && _chain\.length > 0 && _depth < 2\)/,
    '闸门必须是「env 没关 且 链非空 且 没超深度」三个条件');
  // 曾经的死因不是"两个闸门串联", 而是其中一个**恒 false**:
  //   isSilentFailFallbackEnabled() 硬编码 `return false` → 链非空也进不来。
  // 两个条件都合法 (env 是运行时逃生阀, 链非空是主人配没配), 但必须都是活的。
  // 判据钉在 policy 函数上, 而不是这里反着猜。
  const policy = SRC('modules/j2_model_policy.js');
  const fn = policy.slice(policy.indexOf('function isSilentFailFallbackEnabled'));
  assert.match(fn, /return parseFlag\(env\.PANGU_SILENT_FAIL_FALLBACK,\s*true\)/,
    'env 逃生阀必须默认开且可被 PANGU_SILENT_FAIL_FALLBACK=0 关掉 —— '
    + '恒 false 会把整段 chain-switch 挡成死代码 (2026-10-17 修的就是这个)');
});

test('F6 llm_caller 那条路同步修 (半修等于池子里还留着一条死兜底)', () => {
  const src = SRC('modules/llm_caller.js');
  const body = src.slice(src.indexOf('let _fallbackChain = [];'));
  assert.ok(body.length > 0, 'llm_caller 必须构造兜底链');
  assert.match(body, /resolveFallbackChain\(_config, primaryId\)/,
    'callLLMRouter 的兜底链必须走同一个真源, 不许自己另拼一套');
  assert.match(body, /isSilentFailFallbackEnabled\(\) \? \[routing\.primary, \.\.\._fallbackChain\] : \[routing\.primary\]/,
    'callLLMRouter 的链 = env 没关 ? primary + 兜底 : 只有 primary '
    + '(与 J2 主循环同一套判据, 两条路不许分叉)');
});

// ── 3. 行为: 假 loop 真跑一次切换 (不发真实请求) ──────────────────────

test('F7 主模型哑火 + 配了兜底 → 真的切过去并拿到答复', async () => {
  const events = await runLoop('failover-switch-test', [GOOD]);
  assert.ok(events.includes('model_switch'),
    '配了兜底链就必须真的切 —— 实跑打的是这条路, 之前从来没被走到过');
  assert.ok(events.includes(GOOD.id),
    '必须真的用到兜底模型 (否则又是"配了不生效")');
});

test('F8 主模型哑火 + 没配兜底 → 保持原样, 显式报失败 (不许偷偷换模型)', async () => {
  const events = await runLoop('failover-nocfg-test', []);
  assert.ok(!events.includes('model_switch'),
    '没配兜底链时绝不许换模型 —— 那是 2026-09-07 老板明确关掉的自动行为');
  assert.ok(events.includes('Silent Failure'),
    '必须走显式失败上报, 而不是静悄悄换一个模型');
});

// 与 r24-chain-switch.test.js 同一个已知毛病 (2026-09-14 定位):
// stub LLM 零产出路径下 loop 内部偶发 pending, 断言全过但事件循环仍被占,
// 进程不退 → 在 test:chain 里会把整条链卡死。显式退出, 不掩盖断言结果。
// 300ms 是**留给 TAP 输出刷完**的窗口 (r24 同款): 直接 process.exit 会把
// 子测试结果截断成 1 条, 那样 test:chain 里虽然 exit 0 能过, 但报告是假的。
test.after(() => { setTimeout(() => process.exit(0), 300); });
test.after(() => { process.exit(0); });

