const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// ===========================================================================
// reasoning_effort 对本地模型是空转的 —— 老板 2026-09-14 拍的分档从没生效过
//
// LM Studio 服务端日志逐条自证 (2026-10-15.1.log):
//   [WARN][qwen3.8-27b-mlx] No valid custom reasoning fields found in model
//   'lmstudio-community/Qwen3.8-27B-MLX-6bit'. Reasoning setting 'medium'
//   cannot be converted to any custom KVs.
//
// 字段原样发出去, 模型侧没有东西接收。N=5 实测 (直连 LM Studio):
//   无 effort                    中位 2.9s  思考中位 35  gen [51,40,51,51,51]
//   reasoning_effort=low         中位 3.2s  思考中位 41  ← 无效果
//   提示词层预算指令              中位 2.2s  思考中位 24  gen 全是 40
// 快 24%, 且方差消失 —— 那个抖动正是"跟死了一样"的来源。
//
// 所以本地模型改走提示词层。分档语义沿用原有 low/medium/high/off,
// 不是新增能力, 是让既有分档从空转变成生效。
// ===========================================================================

const SRC = fs.readFileSync(require.resolve('../modules/llm_caller.js'), 'utf8');

function freshCaller() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/pangu/apps/core/modules/llm_caller.js')) delete require.cache[k];
  }
  return require('../modules/llm_caller');
}

function init(model) {
  const lc = freshCaller();
  lc.init({
    _config: { llm: { models: [model] }, memory: {} },
    fs: require('fs'), path: require('path'), os: require('os'),
    https: require('https'), http: require('http'),
    PRESETS: {}, PANGU_SYSTEM_PROMPT: 'SOUL_BASE',
    _getPromptFacts: () => ({ toolCount: 127, skillCount: 0, skillManifest: '(空)', mcp: { tools: 0, servers: 0 } }),
  });
  return lc;
}

const LOCAL = { id: 'qwen3.8-27b-mlx', provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234', context_length: 65536, reasoning_effort: 'low' };
const CLOUD = { id: 'k3-256k', provider: 'moonshot', endpoint: 'https://api.moonshot.cn/v1', context_length: 256000, api_key: 'x', reasoning_effort: 'low' };

const build = (model) => init(model)._buildSystemMessages(model);
const hasBudget = (msgs, tag) => msgs.some(m => new RegExp('\\[推理预算' + (tag ? ': ' + tag + '\\]' : '')).test(m.content || ''));

test('本地模型 + low → 必须注入推理预算指令', () => {
  assert.ok(hasBudget(build(LOCAL), '低'),
    '本地模型拿不到 reasoning_effort, 预算必须走提示词层');
});

test('云端模型 → 不注入 (它自己的 reasoning_effort 字段是有效的, 别加重复信号)', () => {
  assert.ok(!hasBudget(build(CLOUD)),
    '云端模型的 API 字段有人收, 提示词层不该重复干预');
});

test('没配 reasoning_effort → 不注入 (不替用户做没拍过的决定)', () => {
  assert.ok(!hasBudget(build({ ...LOCAL, reasoning_effort: undefined })));
});

test('三档语义都在, 且档位越高指令越不催着模型别想', () => {
  for (const [effort, tag] of [['low', '低'], ['medium', '中'], ['high', '高']]) {
    const out = build({ ...LOCAL, reasoning_effort: effort });
    const hit = out.find(m => new RegExp('\\[推理预算: ' + tag + '\\]').test(m.content || ''));
    assert.ok(hit, effort + ' 档必须有自己的指令');
    if (effort === 'low') assert.match(hit.content, /不要展开分析/);
    if (effort === 'high') assert.match(hit.content, /简单问题仍然直接答/,
      'high 档也不能变成"什么都要想很久" —— 那正是要治的毛病');
  }
});

test('off 档不注入 (用户明确关了推理, 别又用提示词把它打开)', () => {
  assert.ok(!hasBudget(build({ ...LOCAL, reasoning_effort: 'off' })));
});

test('_isLocalModel 必须认 IPv6 [::1] 和 127/8 —— 原来抄的旧正则这两个都漏', () => {
  // 走行为断言: 同一个预算指令, 只换 endpoint, 结果必须一致。
  for (const endpoint of ['http://[::1]:1234', 'http://127.0.0.5:1234', 'http://localhost:1234']) {
    assert.ok(hasBudget(build({ ...LOCAL, provider: 'custom', endpoint }), '低'),
      endpoint + ' 必须被认成本地端点');
  }
});

test('真云端 endpoint 不能被误判成本地', () => {
  assert.ok(!hasBudget(build({ ...LOCAL, provider: 'custom', endpoint: 'https://api.openai.com/v1' })));
});

test('skipSoul 探测路径不能被预算指令污染 (探测要的是干净 echo)', () => {
  const m = SRC.match(/if \(opts && opts\.skipSoul\) \{[\s\S]{0,200}?\}/);
  assert.ok(m, 'skipSoul 分支必须还在');
  assert.match(m[0], /_sanitizeMessages\(messages\)/,
    'skipSoul 必须走纯 sanitize, 不能顺手注入 soul 或预算指令');
  assert.ok(!/_injectSoulSysMsgs/.test(m[0]),
    'skipSoul 分支里不能调 _injectSoulSysMsgs');
});

test('预算指令必须排在静态块末尾 (时间消息之后才是变的, 见 prompt-prefix-stability)', () => {
  const out = build(LOCAL);
  const idx = out.findIndex(m => /\[推理预算/.test(m.content || ''));
  assert.ok(idx > 0, '必须注入');
  assert.match(out[0].content, /SOUL_BASE|你是盘古/, 'soul 仍必须是第一条, 不能被挤到后面');
  const iTime = out.findIndex(m => /^# 当前时间 \(权威\)/.test(m.content || ''));
  assert.ok(iTime > idx, '预算是静态内容, 要留在可缓存的前缀里, 不能被时间挤到缓存线之外');
});

test('三处调用点都必须把 useModel 传下去 (漏一处 = 那条路径的预算不生效)', () => {
  const calls = SRC.match(/_injectSoulSysMsgs\(messages\)/g) || [];
  assert.equal(calls.length, 0,
    '还有调用点没传 useModel: ' + calls.length + ' 处仍是无参调用');
  // 函数定义本身也匹配, 所以 4 = 1 定义 + 3 个调用点。
  // 不能把右括号写死在 useModel 后面: 2026-10-16 给这个函数加了第三个参数 soulScope
  // (子 agent 走精简 soul 档), 写成 `_injectSoulSysMsgs\(messages, useModel\)` 就一个都
  // 匹配不到, 测试会从"4 处都传了"变成"2 处传了" —— 报了个跟真实缺陷无关的假红。
  // 这里要守的不变式只有一个: useModel 必须在第二位。
  const withModel = (SRC.match(/_injectSoulSysMsgs\(messages, useModel/g) || []).length;
  assert.equal(withModel, 4, 'raw / stream / callLLM 三条路径都要传 (含函数定义共 4 处)');
});

test('不得回退成"检测模型是否支持 reasoning 字段"的重活 — 那是启动期开销', () => {
  assert.ok(!/probe.*reasoning|reasoning.*probe/i.test(SRC.slice(SRC.indexOf('_reasoningBudgetInstruction'), SRC.indexOf('_reasoningBudgetInstruction') + 2000)),
    '预算指令必须是纯函数判断, 不能在请求路径上探测');
});

