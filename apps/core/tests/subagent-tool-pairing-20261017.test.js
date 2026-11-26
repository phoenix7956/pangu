'use strict';

// 2026-10-17 P0: 子 agent 的 tool_call / tool result 配对 —— 855fa63 的兄弟病灶。
//
// 现场 (session q-1792191820440, 老板那道「查清楚盘古模型池」长任务, 拆成 3 刀之后):
//   [dispatcher] 快路: 跳过 planner 调用, 规则拆成 3 刀: analyzer → analyzer → analyzer
//   [dispatcher] 将灵上场: analyzer            ← 这一刀就是今天修的成果, 拆刀真的上场了
//   [smoke-hook-Post] tool=exec_command ...   ← 工具真调了
//   [j2-native] LLM call failed: HTTP 400: invalid params, tool call and result not match (2013)
//   [j2-native] LLM call failed: HTTP 400: invalid params,
//                   tool result's tool id(call_3dbc2000c5e74ebb9f6ffc76) not found (2013)
//
// 855fa63 把主 agent (modules/j2_agent_loop.js) 那条循环修好了, 400 归零。
// 但子 agent (agents/sub-agent.js) 这条循环是**原样抄的一份**, 于是拆刀一上场 400 就回来。
//
// 一段代码里叠了三个缺陷, 互相掩盖:
//
//   ① 铸 id 用了**两套公式**: assistant 侧 `call_<name>_<轮内序号>`,
//      tool 侧 `call_<name>_<轮数>_<序号>` —— round 一起就分岔。
//      只在 `_nativeCallsFrom` 拿到 null id 时才发作 (上游不发 id 的模型),
//      所以平时看不出来, 一换模型 / 一换端点就整轮 400。
//
//   ② 配对按 **toolResults 下标**: `const _tc = toolCalls[_i]`。
//      这就是 855fa63 修掉的"驱动源选错"的原始形态。
//
//   ③ toolResults **被重排过**: 执行段把工具拆成 safe / unsafe 两组, 先跑完 safe 再跑
//      unsafe, 所以 toolResults 顺序是 [safe..., unsafe...], 而 toolCalls 是**模型的
//      调用顺序**。模型先 exec_command(unsafe) 再 read_file(safe), 结果数组就变成
//      [read_file, exec_command] —— 按下标配, 每个结果发给了错的 tool_call。
//      ③ 比 400 更阴: 上游收到的是**合法 id**, 校验过得去不报错, 但模型看到的是
//      "读文件返回了执行命令的结果", 证据静默错位。
//
// 修法: id 只在一个地方铸 (原地补齐, 幂等), 配对靠结果**自带的那个 tool call 对象**。
//
// R1/R2 是**动态**的: 真的驱动一遍 runAgentLoop, 让模型按 [unsafe, safe] 顺序发两次
//   原生调用 (上游不发 id, 复现 ①), 断言每个 tool_call_id 都能对上、且对上的是**自己**
//   的结果 (复现 ②③)。R3 是**静态接线**: 扫出全文件只有一处铸 id 的地方,
//   防止第二套公式再被抄回来 —— 这正是今天栽过的"同一份东西抄四遍只改其中一份"。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SA_SRC = fs.readFileSync(path.join(ROOT, 'agents', 'sub-agent.js'), 'utf8');
const { runAgentLoop } = require(path.join(ROOT, 'agents', 'sub-agent.js'));

// probe_missing 是仓库里不存在的工具名: executeTool 直接回 Tool not found,
// 既不碰真文件也不发网络 —— 但它在 safeTools 名单**之外**, 于是走 unsafe 分支。
// read_file 在 safeTools 名单**之内**, 于是走 safe 分支。
// 两条分支**都**是 safe 在前 unsafe 在后, 所以 [unsafe, safe] 的调用顺序会被重排成
// [safe, unsafe] —— 正好复现现场最常见的形态 (exec_command 先, read_file 后)。
const PROBE = 'probe_missing';

function mkTempFile(marker) {
  const p = path.join(os.tmpdir(), `pangu-pairing-${process.pid}-${marker.length}.txt`);
  fs.writeFileSync(p, marker + '\n');
  return p;
}

// 让假模型发原生调用 (id 全部为 null —— 复现"上游不发 id"), 跑完工具后收口。
function fakeNativeLLM({ file, seen }) {
  let round = 0;
 return async (messages) => {
    round += 1;
    seen.push(messages.map(m => ({ ...m })));
    if (round === 1) {
      return {
        text: '先探一个不存在的工具, 再读文件',
        nativeCalls: [
          { name: PROBE, args: { q: 'x' }, id: null },            // unsafe → 被排到后面
          { name: 'read_file', args: { path: file }, id: null },  // safe   → 被排到前面
        ],
      };
    }
    return { text: '收工', nativeCalls: [] };
  };
}

test('R1 每个 tool_call 都拿到自己的结果 —— id 配对 + 结果不错位', async (t) => {
  const MARK = 'MARKER_READ_FILE_CONTENT_9f3a';
  const file = mkTempFile(MARK);
  t.after(() => { try { fs.unlinkSync(file); } catch (_) {} });

  const seen = [];
  await runAgentLoop({
    taskText: '配对回归',
    mode: 'executor',
    model: {}, cfg: {},
    toolsAllowed: [PROBE, 'read_file'],
    callLLMFn: fakeNativeLLM({ file, seen }),
  });

  // 找那条"工具跑完之后、模型收口之前"的 messages: 它必须同时含
  // assistant(tool_calls) 和它后面那几条 role:'tool'。
  const round2 = seen.find((msgs) => msgs.some((m) => m.role === 'tool'));
  assert.ok(round2, 'R1: 工具结果必须真的回灌进 messages');

  const asst = round2.filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)).pop();
  assert.ok(asst && asst.tool_calls.length === 2,
    `R1: assistant 上应有 2 个 tool_call, 实际 ${asst ? asst.tool_calls.length : '没有 assistant.tool_calls'}`);

  // ① 上游不发 id 时, 每个 tool_call 都必须有 id, 且不能重复 —— 重复会让
  //    tool_call_id 指错人, 上游同样 400。
  const ids = asst.tool_calls.map((tc) => tc.id);
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0),
    `R1: 每个 tool_call 都必须有 id, 实际 ${JSON.stringify(ids)}`);
  assert.equal(new Set(ids).size, ids.length, `R1: tool_call id 必须互不相同, 实际 ${JSON.stringify(ids)}`);

  const tools = round2.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 2, `R1: 2 个 tool_call 必须各有 1 条结果, 实际 ${tools.length}`);

  // ② 每个 tool_call_id 都得能在上面那张表里找到 —— 否则就是
  //    "tool call and result not match" / "tool id not found" 那两条 400。
  for (const m of tools) {
    assert.ok(ids.includes(m.tool_call_id),
      `R1: 结果 ${m.tool_call_id} 找不到对应的 tool_call —— 上游必然 400`);
  }

  // ③ 结果必须发给**自己**那个调用。这是重排防护的核心断言:
  //    read_file 是 safe、probe_missing 是 unsafe, toolResults 被重排过,
  //    按下标配的话 read_file 的结果会挂到 probe_missing 的 id 上, 反之亦然。
  const byId = new Map(tools.map((m) => [m.tool_call_id, m]));
  const probeMsg = byId.get(ids[asst.tool_calls.findIndex((tc) => tc.function.name === PROBE)]);
  const readMsg = byId.get(ids[asst.tool_calls.findIndex((tc) => tc.function.name === 'read_file')]);

  assert.match(String(probeMsg.content), /not found|不存在/i,
    `R1: ${PROBE} 的位置上应该是它自己的失败结果, 实际: ${String(probeMsg.content).slice(0, 120)}`);
  assert.ok(String(readMsg.content).includes(MARK),
    `R1: read_file 的位置上应该是文件内容 (含 ${MARK}), 实际: ${String(readMsg.content).slice(0, 120)}`
    + ' —— 结果被发给了错的 tool_call (safe/unsafe 重排后按下标配对)');
});

test('R2 铸 id 是幂等的 —— 同一个调用重复补齐不会分岔', () => {
  // 助手侧先补过、tool 侧再补一次, 若两次公式不同就会分岔成两个 id。
  // 现场那条 400 (tool id(call_3dbc...) not found) 就是这么来的。
  const calls = [{ name: 'read_file', args: {} }, { name: 'exec_command', args: {} }];
  const first = calls.map((tc) => tc.id);
  assert.deepEqual(first, [undefined, undefined], 'R2: 前置条件: 还没铸过 id');

  const sa = require(path.join(ROOT, 'agents', 'sub-agent.js'));
  // _ensureToolCallIds 不导出 —— 走公开路径: _assistantMessage 会原地补齐。
  const msg = sa._assistantMessage('t', calls, true);
  const afterFirst = calls.map((tc) => tc.id);
  assert.ok(afterFirst.every(Boolean), `R2: _assistantMessage 必须补齐 id, 实际 ${JSON.stringify(afterFirst)}`);
  assert.equal(new Set(afterFirst).size, 2, `R2: id 必须互不相同, 实际 ${JSON.stringify(afterFirst)}`);
  assert.deepEqual(afterFirst, msg.tool_calls.map((tc) => tc.id),
    'R2: 铸出来的 id 就是 assistant.tool_calls 上那批');

  // 再走一次 (模拟 tool 侧那次幂等补齐) —— id 不得变化, 否则两侧对不上。
  sa._assistantMessage('t2', calls, true);
  assert.deepEqual(calls.map((tc) => tc.id), afterFirst,
    'R2: 重复补齐不得改 id —— 两套公式分岔就是这条 400');
});

test('R3 全文件只有一处铸 tool_call id —— 防止第二套公式被抄回来', () => {
  // 静态接线: 扫掉注释与字符串里的说明文字, 找出所有真的在铸 id 的地方。
  const code = SA_SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const mints = [...code.matchAll(/['"`]call_['"`]\s*\+/g)].map((m) => m.index);
  assert.equal(mints.length, 1,
    `R3: 全文件应该只有 _ensureToolCallIds 一处铸 id, 实际 ${mints.length} 处 —— `
    + 'assistant 侧和 tool 侧各铸一次就会在 round 一起分岔 (现场 400 的成因)');
});

