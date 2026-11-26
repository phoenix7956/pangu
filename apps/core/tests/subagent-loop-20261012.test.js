const test = require('node:test');
const assert = require('node:assert/strict');

const { runAgentLoop } = require('../agents/sub-agent');

// 子 agent 用的是文本工具标记 (不是原生 function calling), 所以假模型直接吐标记。
const toolCall = (name, args) => `<tool name="${name}">${JSON.stringify(args)}</tool>`;

// probe_missing 是仓库里不存在的工具名: executeTool 直接回 Tool not found,
// 既不碰真文件也不发网络, 同时让 runtimeStatus 如实变成 failed。
const BASE = {
  taskText: '回归用例',
  mode: 'executor',
  model: {},
  cfg: {},
  toolsAllowed: ['probe_missing'],
};

test('S1 子 agent 不再被硬编码的 5 轮腰斩 (2026-10-12)', async () => {
  let rounds = 0;
  const fake = async () => {
    rounds += 1;
    // 前 8 轮一直有真实进展要工具, 第 9 轮才收口 —— 旧上限 5 根本走不到这里。
    if (rounds <= 8) return { text: toolCall('probe_missing', { i: rounds }) };
    return { text: '收工总结' };
  };

  const r = await runAgentLoop({ ...BASE, callLLMFn: fake });

  assert.ok(rounds >= 9, `期望至少跑 9 轮, 实际 ${rounds} — 5 轮硬上限没拆掉`);
  assert.equal(r.summary, '收工总结');
  assert.equal(r.toolsUsed.length, 8, '八次探测都应该真的执行过');
});

test('S2 末轮工具结果先于总结进模型, 总结不再取"证据之前"的文本 (2026-10-12)', async () => {
  let round = 0;
  let sawToolResults = 0;
  const fake = async (messages) => {
    round += 1;
    // 统计模型在"只读总结轮"之前是否已经拿到过 tool_result。
    if (messages.some((m) => typeof m.content === 'string' && m.content.includes('<tool_result'))) {
      sawToolResults += 1;
    }
    if (round <= 12) return { text: toolCall('probe_missing', { i: round }) };
    return { text: '总结: 最后一次探测返回 Tool not found, 未取得真实数据' };
  };

  const r = await runAgentLoop({ ...BASE, callLLMFn: fake });

  assert.ok(sawToolResults > 0, '总结轮之前模型必须已经看过 tool_result');
  assert.match(r.summary, /^总结: 最后一次探测/, '总结必须来自读完工具结果之后的那一轮');
  assert.doesNotMatch(r.summary, /probe_missing/, '总结里不该残留工具标记');
});

test('S3 同参重复到第 3 次起熔断, 不再空转 (2026-10-12)', async () => {
  let round = 0;
  const stages = [];
  const fake = async () => {
    round += 1;
    // 每轮都是同一个工具配同一份参数 —— 最典型的空转。
    return { text: toolCall('probe_missing', { same: 1 }) };
  };

  const r = await runAgentLoop({
    ...BASE,
    callLLMFn: fake,
    onProgress: (e) => stages.push(e.stage),
  });

  const executed = r.toolsUsed.filter((t) => t === 'probe_missing').length;
  assert.equal(executed, 2, `同参只该执行 2 次, 实际 ${executed} 次 — 熔断没生效`);
  assert.ok(stages.includes('arg_fuse'), '应该上报 arg_fuse 阶段');
  assert.ok(round <= 4, `熔断后必须立刻收场, 实际空转了 ${round} 轮`);
});

test('参数键序不同也算同参, 绕不过熔断 (2026-10-12)', () => {
  assert.match(src, /function _stableArgs\(/);
  assert.match(src, /Object\.keys\(v\)\.sort\(\)/, '必须按键排序后再序列化, 否则 {"a","b"} 和 {"b","a"} 会被当成两次不同调用');
});


test('S4 轮次耗尽自动续跑, 12 轮上限不再腰斩长任务 (2026-10-12)', async () => {
// 20 轮 > 单次预算 12 轮。旧码轮次跑满就强制收尾, fake 只跑到 13 (12 + 总结轮) 就停。
let rounds = 0;
const seen = [];
const fake = async (messages) => {
rounds += 1;
const cont = messages.some((m) => typeof m.content === 'string' && m.content.includes('[自动续跑]'))
if (cont) seen.push(rounds);
if (rounds <= 20) return { text: toolCall('probe_missing', { i: rounds }) };
return { text: '收工总结' };
};

const prev = process.env.PANGU_SUBAGENT_AUTO_RESUME_MAX;
process.env.PANGU_SUBAGENT_AUTO_RESUME_MAX = '3';
try {
const r = await runAgentLoop({ ...BASE, callLLMFn: fake });

assert.ok(rounds >= 21, `期望跑满 20 轮工作 + 1 轮总结, 实际只跑了 ${rounds} 轮 — 轮次耗尽后没有续跑`);
assert.ok(seen.length > 0, '续跑时必须给子 agent 注入 [自动续跑] 提示, 否则它不知道自己被腰斩过');
assert.equal(r.summary, '收工总结');
} finally {
if (prev === undefined) delete process.env.PANGU_SUBAGENT_AUTO_RESUME_MAX;
else process.env.PANGU_SUBAGENT_AUTO_RESUME_MAX = prev;
}
});

test('S5 没有续跑预算时行为不变, 仍是跑满即收 (2026-10-12)', async () => {
let rounds = 0;
const fake = async () => {
rounds += 1;
return { text: toolCall('probe_missing', { i: rounds }) };
};

const prev = process.env.PANGU_SUBAGENT_AUTO_RESUME_MAX;
delete process.env.PANGU_SUBAGENT_AUTO_RESUME_MAX;
try {
const r = await runAgentLoop({ ...BASE, callLLMFn: fake });
assert.ok(rounds <= 14, `预算为 0 时不该无限续跑, 实际 ${rounds} 轮`);
assert.ok(r.summary.length > 0, '收场时仍要给出一段总结');
} finally {
if (prev !== undefined) process.env.PANGU_SUBAGENT_AUTO_RESUME_MAX = prev;
}
});

test('S6 子 agent 循环体不许退回硬编码轮次上限 (2026-10-12)', () => {
const src = require('node:fs').readFileSync(require.resolve('../agents/sub-agent.js'), 'utf8');
assert.doesNotMatch(src, /for \(let round = 0; round < maxRounds; round\+\+\)/,
'runAgentLoop 还在用不可续跑的硬上限循环 —— 换成了带续跑的驱动循环');
});
  const src = require('node:fs').readFileSync(require.resolve('../agents/sub-agent.js'), 'utf8');
