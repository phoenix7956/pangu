// 第 67 批判据 —— 「屏上答复」与「盘上答复」必须是同一段
//
// ## 现场 (b66-bridge-live-1792743482848, 2026-10-23)
//   屏上 final 415 字符, 落盘文件里 723 字符 —— **两个不同的文本**。
//   落盘时间戳比屏上 final 早 75 秒 ⇒ 盘上那份是**重写前**的旧版。
//
// ## 两层根因
//   A (顺序): 落盘点在 finally 块里 (答案定稿**之前**), 而 summary 重写 /
//     守卫改写 / task_done 文案都发生在 finally **之后** —— 改完的 finalText
//     只进了 SSE, 没进盘。
//   B (误判): `_looksLikeEmptyPlan` 把**正常答案**判成「空计划模板」——
//     旧判据是「数字清单 ≥3 行 + 正文任意位置出现 (读取|确认|检查|分析|查看|梳理)」。
//     那份正常的卦象断语正好有 4 条编号断语, 正文末尾还有一句「…得确认」
//     ⇒ 条件在**不同位置**各自命中 ⇒ 整份好答案被当成空计划
//     ⇒ 白烧一次 74 秒的 LLM 调用, 还产出新旧两个版本。
//
// ## 本文件锁什么
//   ① 判据层: 正常答案**不许**被判成空计划; 空计划模板**仍要**被抓到。
//   ② 行为层: 跑一遍真实主循环, 断言 **落盘文件里最后一条 assistant == 屏上 final 事件**。
//      —— 这一条是「屏上/盘上是不是同一段」的唯一有效判据。
//      查源码字符串判不了这件事 (第 66 批教训: 判据要钉机制不钉现状)。
'use strict';

// ══ 隔离必须先于任何 require ══
const fs = require('fs');
const path = require('path');
const os = require('os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-b67-'));
process.env.PANGU_HOME = path.join(TMP, 'home');
process.env.PANGU_PLAN_DIR = path.join(TMP, 'plans');
process.env.PANGU_TASK_DIR = path.join(TMP, 'tasks');
process.env.PANGU_SESSIONS_DIR = path.join(TMP, 'sessions');
process.env.PANGU_AGENTDB_DIR = path.join(TMP, 'agentdb');
process.env.PANGU_CHECKPOINT_DIR = path.join(TMP, 'checkpoints');
fs.mkdirSync(process.env.PANGU_HOME, { recursive: true });
fs.mkdirSync(process.env.PANGU_SESSIONS_DIR, { recursive: true });

const { test } = require('node:test');
const assert = require('node:assert');

const J2 = require('../modules/j2_agent_loop');
const { _looksLikeEmptyPlan } = require('../modules/j2_loop_shared');

// ── 现场原件: b66-bridge-live-1792743482848 的屏上答复原文 (723 字符) ──
// 这是一份**正常的卦象断语**: 4 条编号断语 + 结论 + 实操建议 + 一句「要细看的话得确认」。
// 旧判据在这里翻车 (4 条编号命中「≥3 行」, 末尾「确认」命中词表)。
const B66_ANSWER = `**卦已起, 先说结论: 今年别大动, 退一步反而赢。**

---

**卦象** (梅花易数·时间起卦, 2026丙午年九月十四):

| 层 | 内容 |
|---|---|
| 本卦 | **蹇 ䷦** (水山蹇) — 前路受阻 |
| 动爻 | **九三: "往蹇，来反"** |
| 之卦 | **比 ䷇** (水地比) — "比，吉" |
| 互卦 | 未济 — 事未成, 急不得 |
| 体用 | 体坎(水) / 用艮(土) → **用克体, 大凶** |

---

**断**:

1. **九三"往蹇，来反"** — 这一爻是整卦的核心判词: 往前冲 = 蹇(死磕), 退回来 = 反(反而得誉)。今年你如果硬推一个方向, 大概率撞墙。

2. **用克体** — 外部环境(行业/市场/上级)今年压你, 不是你的问题, 是势的问题。硬顶 = 耗。

3. **之卦比 = 吉** — 方向不是"永远不动", 而是**先退一步, 找盟友, 联合再动**。比卦的核心是"亲比", 不是孤军奋战。

4. **互卦未济** — 你心里那件事还没到火候, 小狐汔济濡其尾, 差一口气别硬渡。

**实操建议**: 今年(到年底)适合**收、整、联** — 收住扩张冲动, 整理手上资源, 找对人建立联盟。真正"动"的窗口大概率在**明年(丁未)** 或后年, 比卦的吉要等势转才兑现。

---

顺带一句: 1990年是**庚午(马)**, 不是鼠。你是属马的。如果你确认自己是鼠, 那出生年可能是1984(甲子)或1996(丙子) — 不影响这卦(卦是时间起的, 跟你的生肖无关), 但八字层面差一个年柱, 要细看的话得确认。`;

// ════════════════ ① 判据层: 空计划检测 ════════════════

test('B67-1: 现场原件 (4 条编号断语 + 正文含「确认」) 不许被判成空计划', () => {
  assert.ok(B66_ANSWER.length > 700, 'fixture 必须是那份真答案, 不是随手编的短样本');
  assert.strictEqual(_looksLikeEmptyPlan(B66_ANSWER), false,
    '一份正常的卦象断语被判成空计划 ⇒ 会白烧一次 LLM 调用把它重写一遍');
});

test('B67-2: 空计划模板仍然必须被抓到 (判据不能为了修误判而放水)', () => {
  // R80 现场样本 (老板 7/30 00:40 实证: 模型复读 5 步模板 6+ 轮, 0 工具调用)
  const fiveSteps = '\n\n收到。直接执行。\n\n**第一步：读取当前配置和代码结构，确认需要修改的地方。**\n\n'
    + '**第二步：读取核心循环代码，确认断流和响应慢的根因。**\n\n'
    + '**第三步：读取 `~/.pangu/config/settings.json` 确认当前配置。**\n\n'
    + '**第四步：读取 `~/.pangu/config/system_prompt.md` 确认系统提示词。**\n\n'
    + '**第五步：读取 `~/.pangu/config/agent_config.json` 确认 Agent 配置。**';
  assert.strictEqual(_looksLikeEmptyPlan(fiveSteps), true);

  const numbered = '我将并行执行这些操作：\n1. 读取 MEMORY.md 证明记忆存在。\n2. 调用 memory_search 搜索记忆库。\n3. 获取子 agent 清单。\n4. 确认当前会话状态。';
  assert.strictEqual(_looksLikeEmptyPlan(numbered), true);
});

test('B67-3: 「有结论」就不算空计划 (结构判据: 每一步都得是待办动作)', () => {
  // 每一步的头词都不是动作动词 (是结论) ⇒ 不是空计划
  const verdicts = '结论如下：\n1. 九三: 往前冲是死磕。\n2. 用克体: 今年外部压你。\n3. 之卦比: 先退一步找盟友。\n4. 互卦未济: 事还没到火候。';
  assert.strictEqual(_looksLikeEmptyPlan(verdicts), false);

  // 步骤带**完成体** (读取了) ⇒ 已经做完了, 不是待办 ⇒ 不是空计划
  const done = '已经做完了：\n1. 读取了 MEMORY.md, 找到 3 条记忆。\n2. 检查了配置, 一切正常。\n3. 修改了设置, 已生效。';
  assert.strictEqual(_looksLikeEmptyPlan(done), false);

  // 有待办也有结论 ⇒ 是答复, 不是空计划
  const mixed = '我先看了下：\n1. 读取配置完成。\n2. 结论: 问题在超时策略上。\n3. 修复超时判据。';
  assert.strictEqual(_looksLikeEmptyPlan(mixed), false);
});

test('B67-4: 判据不能恒真也不能恒假 (负例自检)', () => {
  assert.strictEqual(_looksLikeEmptyPlan('好的'), false);
  assert.strictEqual(_looksLikeEmptyPlan(''), false);
  assert.strictEqual(_looksLikeEmptyPlan(null), false);
  // 阈值: 编号清单 <3 行不算 (跟旧判据一致)
  assert.strictEqual(_looksLikeEmptyPlan('我来处理：\n1. 读取配置。\n2. 修改文件。'), false);
});

// ════════════════ ② 行为层: 屏上 == 盘上 ════════════════

const MODEL = { id: 'b67-fake', provider: 'lmstudio', endpoint: 'http://127.0.0.1:9/none', context_length: 100000 };

function makeScriptedLLM(script, calls) {
  return async (messages, model, toolsSchema, opts) => {
    const idx = calls.n++;
    const step = script[Math.min(idx, script.length - 1)];
    calls.seen.push({ round: idx, msgs: messages.length });
    if (opts && typeof opts.onText === 'function' && step.text) opts.onText(step.text);
    return {
      choices: [{
        message: {
          content: step.text || '',
          tool_calls: (step.tools || []).map((t, i) => ({
            id: 'call_' + idx + '_' + i,
            type: 'function',
            function: { name: t.name, arguments: JSON.stringify(t.params || {}) },
          })),
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };
  };
}

function makeRes() {
  const chunks = [];
  return {
    chunks, writableEnded: false,
    write(s) { chunks.push(String(s)); return true; },
    end() { this.writableEnded = true; },
    text() { return chunks.join(''); },
  };
}

function finalEventText(res) {
  const t = res.text();
  const m = t.match(/event: final\ndata: (\{.*?\})\n\n/s);
  if (!m) return null;
  try { return JSON.parse(m[1]).text; } catch (_) { return null; }
}

function lastAssistantText(sid) {
  const file = path.join(process.env.PANGU_SESSIONS_DIR, sid + '.json');
  if (!fs.existsSync(file)) return { file, missing: true, text: null };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const msgs = (data.messages || []).filter(m => m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
  return { file, missing: false, text: msgs.length ? msgs[msgs.length - 1].content : null };
}

async function runLoop(sid, input, script, extraOpts) {
  const calls = { n: 0, seen: [] };
  J2.init({
    _callLLMForAgent: makeScriptedLLM(script, calls),
    _callLLMForAgentStream: async function* () { throw new Error('stream not scripted'); },
    _detectToolCallSupport: async () => true,
    getModelContextLength: () => 100000,
    getCurrentModel: () => MODEL,
    _recordSessionToMemory: async () => {},
    _sessionRecall: async () => [],
    _recordEvolution: () => {},
    safeResWrite: (res, s) => res.write(s),
    _j2ExecuteToolCalls: async () => [],
    _j2AppendToolResults: () => {},
    _hasUnclosedToolBlock: () => false,
    path,
    MAX_BODY_BYTES: 10 * 1024 * 1024,
  });
  const res = makeRes();
  const req = { on() {}, aborted: false };
  await J2._runAgentLoopLegacyStream(
    [{ role: 'system', content: 'test system' }, { role: 'user', content: input }],
    MODEL, req, res,
    Object.assign({ sessionId: sid, userInput: input, reqBody: { session_id: sid } }, extraOpts || {})
  );
  return { res, calls };
}

test('B67-5: 屏上 final 与落盘文件里最后一条 assistant **逐字相同**', async () => {
  const sid = 'b67-truth-' + Date.now();
  // 剧本: 第 1 轮调一个工具 (让 toolsUsed > 0), 第 2 轮只吐一个短答案「好」,
  //       短答案会触发 summary 重写 —— 重写后的那段才是屏上真正给主人看的。
  //       第 3 次 LLM 调用 = summary 那一程, 返回「总结后的答复」。
  //       summary 那段**带 think 标签**: 屏上不该有 think, 盘上也不该有 ——
  //       盘上存的是「屏上发出去的那段」, 不是模型原话。
  const script = [
    { text: '', tools: [{ name: 'current_time', params: {} }] },
    { text: '好' },
    { text: '<think>这段内部思考不该上屏</think>总结后的答复: 今天是 2026-10-23, 这一轮已经收口。' },
  ];
  const { res } = await runLoop(sid, '现在几点', script);
  const shown = finalEventText(res);
  assert.ok(shown, '这一轮必须真的上屏 (event: final), 否则这条判据测的不是它该测的东西');
  assert.strictEqual(shown, '总结后的答复: 今天是 2026-10-23, 这一轮已经收口。',
    '屏上必须是 summary 重写后的那段');

  const disk = lastAssistantText(sid);
  assert.ok(!disk.missing, '这一轮必须落盘 (会话文件不存在 = 整轮对话蒸发)');
  assert.strictEqual(disk.text, shown,
    '盘上最后一条 assistant 与屏上 final 不是同一段 ⇒ 「屏上显示的」和「盘上存着的」分家了');
  assert.ok(!/<think>/.test(String(disk.text)),
    '盘上不许留 think 标签 —— 落盘的必须是「屏上发出去的那段」, 不是模型原话');
});

test('B67-7: 盘上不许有两条答案 (重写后的答复要**替换**旧的, 不是追加一条)', async () => {
  const sid = 'b67-dup-' + Date.now();
  const script = [
    { text: '', tools: [{ name: 'current_time', params: {} }] },
    { text: '好' },
    { text: '总结后的答复: 只有这一句。' },
  ];
  await runLoop(sid, '现在几点', script);
  const file = path.join(process.env.PANGU_SESSIONS_DIR, sid + '.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const answers = (data.messages || []).filter(m => m && m.role === 'assistant'
    && !m.tool_calls && typeof m.content === 'string' && m.content.trim());
  assert.strictEqual(answers.length, 1,
    '盘上只能有**一条**答复 —— 追加一条会让模型下一轮看到「自己连说两遍」, 反而更困惑');
  // 答复不许把工具结果顶掉: 工具结果是**证据**, 下一轮模型要靠它。
  const hasToolResult = (data.messages || []).some(m => m && m.role === 'tool');
  assert.ok(hasToolResult, '工具结果必须还在盘上 —— 答复落盘时把它顶掉了, 下一轮就只剩一句光话');
});

test('B67-8: 第二轮不许把第一轮从盘上抹掉 (2026-10-14 h6 那个老坑)', async () => {
  const sid = 'b67-hist-' + Date.now();
  const file = path.join(process.env.PANGU_SESSIONS_DIR, sid + '.json');
  // 第一轮: 正常一问一答
  await runLoop(sid, '第一个问题', [
    { text: '', tools: [{ name: 'current_time', params: {} }] },
    { text: '第一轮的答复: 现在是 2026-10-23 下午。' },
  ]);
  const first = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok((first.messages || []).some(m => m.role === 'user' && String(m.content).includes('第一个问题')),
    '第一轮必须落盘');
  // 第二轮: 正常的一问一答 (历史靠容器水合带回来)。
  //   落盘是**整份覆盖** —— 所以落盘时写进去的 messages 必须是**带历史的整份**,
  //   少写一条就等于把上一轮抹掉 (2026-10-14 h6 现场: 第一轮乌龙茶, 第二轮覆盖后
  //   文件里只剩第二轮, 第一轮从此消失, 而且再也回不来)。
  await runLoop(sid, '第二个问题', [
    { text: '', tools: [{ name: 'current_time', params: {} }] },
    { text: '第二轮的答复: 现在是 2026-10-23 傍晚。' },
  ]);
  const second = JSON.parse(fs.readFileSync(file, 'utf8'));
  const users = (second.messages || []).filter(m => m.role === 'user').map(m => String(m.content));
  assert.ok(users.some(u => u.includes('第一个问题')),
    '第一轮不能被这一轮覆盖掉 —— 整份覆盖没有兜底, 抹掉就再也回不来');
  assert.ok(users.some(u => u.includes('第二个问题')), '第二轮也必须还在');
});

test('B67-6: 盘上不许留下「主人从没说过的 user 轮」(summary 脚手架不许进历史)', async () => {
  const sid = 'b67-scaffold-' + Date.now();
  const script = [
    { text: '', tools: [{ name: 'current_time', params: {} }] },
    { text: '好' },
    { text: '最终答复: 已经查过时间了。' },
  ];
  await runLoop(sid, '现在几点', script);
  const file = path.join(process.env.PANGU_SESSIONS_DIR, sid + '.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const users = (data.messages || []).filter(m => m && m.role === 'user');
  assert.strictEqual(users.length, 1,
    '落盘历史里只能有主人那一句话 —— summary 的「已调工具…」是内部脚手架, 不是主人说的话');
  assert.ok(!/已调工具/.test(JSON.stringify(data.messages || [])),
    '落盘历史里不该出现 summary 的内部指令');
});
