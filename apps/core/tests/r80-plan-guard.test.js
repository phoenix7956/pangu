'use strict';

// R80 回归测试 — BUG #1 空计划模板熔断 + BUG #3 本地模型超时自适应
// 老板 7/30 00:40-01:36 实证: qwen3.6-35b 复读 "第一步...第二步..." 6+ 轮 0 工具调用

const assert = require('assert');
const { test } = require('node:test');

const J2 = require('../modules/j2_agent_loop');
const { createPlanGate, _isToolLockClaim } = require('../modules/j2_plan_gate');
const { sanitizeRecalledContent } = require('../modules/j2_loop_shared');

test('R80 BUG#1: 5 步计划模板被识别为空计划', () => {
  // evolution/2026-07-29.jsonl 真实样本 (老板说"那就自动修正"后的回复)
  const sample = '\n\n收到。直接执行。\n\n**第一步：读取当前配置和代码结构，确认需要修改的地方。**\n\n**第二步：读取核心循环代码，确认断流和响应慢的根因。**\n\n**第三步：读取 `~/.pangu/config/settings.json` 确认当前配置。**\n\n**第四步：读取 `~/.pangu/config/system_prompt.md` 确认系统提示词。**\n\n**第五步：读取 `~/.pangu/config/agent_config.json` 确认 Agent 配置。**';
  assert.strictEqual(J2._looksLikeEmptyPlan(sample), true);
});

test('R80 BUG#1: 数字编号计划清单 (≥3 行 + 计划动作词) 被识别', () => {
  const sample = '我将并行执行这些操作：\n1. 读取 MEMORY.md 证明记忆存在。\n2. 调用 memory_search 搜索记忆库。\n3. 获取子 agent 清单。\n4. 确认当前会话状态。';
  assert.strictEqual(J2._looksLikeEmptyPlan(sample), true);
});

test('R80 BUG#1: 真实答复不误判', () => {
  // 短文本
  assert.strictEqual(J2._looksLikeEmptyPlan('好的'), false);
  // 只提一次"第一步"的正常答复
  assert.strictEqual(J2._looksLikeEmptyPlan('已完成。第一步我做了 X, 结果是 Y, 文件已写入 /tmp/a.txt。'), false);
  // 数字清单但无计划动作词 (纯枚举结果)
  assert.strictEqual(J2._looksLikeEmptyPlan('找到 3 个文件：\n1. foo.js\n2. bar.js\n3. baz.js\n都是上周改的。'), false);
  // 空/非字符串
  assert.strictEqual(J2._looksLikeEmptyPlan(''), false);
  assert.strictEqual(J2._looksLikeEmptyPlan(null), false);
});

test('R80 BUG#3: 本地模型 round 超时 300s, 云端 120s', () => {
  // 2026-08-23 修: 两次拍板后的现行值 — 本地 35B 300s (2026-08-02, j2_loop_shared.js:83),
  // 云端默认 120s (现行代码 j2_loop_shared + llm_caller 两处一致; 原 30s 是 R80 初值, 已不适用)
  delete process.env.PANGU_ROUND_TIMEOUT_MS;
  assert.strictEqual(J2._resolveRoundTimeoutMs({ provider: 'lmstudio' }), 300000);
  assert.strictEqual(J2._resolveRoundTimeoutMs({ provider: 'ollama' }), 300000);
  assert.strictEqual(J2._resolveRoundTimeoutMs({ provider: 'minimax', endpoint: 'https://api.minimaxi.com/v1/chat/completions' }), 120000);
  // endpoint 是 127.0.0.1 也按本地算
  assert.strictEqual(J2._resolveRoundTimeoutMs({ provider: 'openai', endpoint: 'http://127.0.0.1:1234/v1/chat/completions' }), 300000);
});

test('R80 BUG#3: PANGU_ROUND_TIMEOUT_MS env 强制覆盖', () => {
  process.env.PANGU_ROUND_TIMEOUT_MS = '45000';
  try {
    assert.strictEqual(J2._resolveRoundTimeoutMs({ provider: 'lmstudio' }), 45000);
  } finally {
    delete process.env.PANGU_ROUND_TIMEOUT_MS;
  }
});

test('R80 BUG#2: cache_get 描述明确"不是记忆"', () => {
  const { TOOLS_SCHEMA } = require('../modules/tools_schema');
  assert.ok(TOOLS_SCHEMA.cache_get.function.description.includes('不是记忆'));
  assert.ok(TOOLS_SCHEMA.cache_put.function.description.includes('memory_write'));
  assert.ok(TOOLS_SCHEMA.cache_stats.function.description.includes('memory_search'));
});

test('R80 BUG#4/#5: global rules 含不自爆 + 先调研后归因', () => {
  const { GLOBAL_AGENT_RULES } = require('../modules/global_agent_rules');
  assert.ok(GLOBAL_AGENT_RULES.includes('不自爆局限'));
  assert.ok(GLOBAL_AGENT_RULES.includes('先调研后归因'));
  assert.ok(GLOBAL_AGENT_RULES.includes('主人拍板 = 立即执行'));
});

// R80-ext BUG#6: 调工具后嘴说型空响应 (老板 2026-08-01 14:24 实证: tool_calls_total=6 但 finalText="先调工具拿真实数据" 392 字)
const _LIP_SERVICE_RE = /先调(?:工具|子)?|立即补上|会调|嘴说|不靠嘴|马上调|这就去|下面调|现在调|动手调|立即执行|调工具拿(?:真实|真)?数据/;

test('R80-ext BUG#6: 嘴说型文本被识别 (老板 14:24 实证)', () => {
  assert.strictEqual(_LIP_SERVICE_RE.test('先调工具拿真实数据,不靠嘴说。'), true);
  assert.strictEqual(_LIP_SERVICE_RE.test('我先调子 agent 看情况'), true);
  assert.strictEqual(_LIP_SERVICE_RE.test('立即补上'), true);
  assert.strictEqual(_LIP_SERVICE_RE.test('你说的对,嘴说没用,直接调工具拿真数据。'), true);
  assert.strictEqual(_LIP_SERVICE_RE.test('下面调 list_pangu_agents 看看'), true);
  assert.strictEqual(_LIP_SERVICE_RE.test('马上调 read_file 看一下'), true);
});

test('R80: fabricated tool-lock claim is rejected and requires a real tool call', () => {
  const sample = '工具锁了，不调任何工具。system 指令禁止本轮调 read_file/write_file/exec_command。';
  assert.strictEqual(_isToolLockClaim(sample), true);
  const decision = createPlanGate().check({ textContent: sample, toolsUsed: [], round: 0, maxRounds: 5 });
  assert.strictEqual(decision.action, 'nudge');
  assert.strictEqual(decision.rule, 'tool_lock_claim');
  assert.match(decision.message, /工具仍可用/);
  const blocked = createPlanGate();
  blocked.check({ textContent: sample, toolsUsed: [], round: 0, maxRounds: 5 });
  assert.strictEqual(blocked.check({ textContent: sample, toolsUsed: [], round: 1, maxRounds: 5 }).action, 'break');
  assert.strictEqual(sanitizeRecalledContent(sample), '');
});

test('R80-ext BUG#6: 真实正常答案不误判', () => {
  assert.strictEqual(_LIP_SERVICE_RE.test('已完成, 5 个子 agent: alpha, beta, gamma, pangu, delta'), false);
  assert.strictEqual(_LIP_SERVICE_RE.test('当前 Pangu 跑在 port 18901, uptime 8.6h'), false);
  assert.strictEqual(_LIP_SERVICE_RE.test(''), false);
  // "我先" 后跟非调工具动词 — 也不算嘴说型
  assert.strictEqual(_LIP_SERVICE_RE.test('我先查一下日志,再继续'), false);
});

test('R80-ext BUG#6: 集成 — toolsUsed>0 + 嘴说 → finalText 应被清空', () => {
  // 模拟 legacy 路径 L1240 行为
  const textContent = '先调工具拿真实数据,不靠嘴说。';
  const toolsUsed = ['list_pangu_agents', 'system_info', 'memory_search'];
  let finalText = textContent;
  if (toolsUsed.length > 0 && textContent && _LIP_SERVICE_RE.test(textContent)) {
    finalText = '';
  }
  assert.strictEqual(finalText, '', '嘴说型 finalText 应清空, 触发 summary 路径');
});
