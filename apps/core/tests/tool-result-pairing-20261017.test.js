'use strict';

// 2026-10-17 P0: tool_call / tool result 配对断裂 → 整轮 400 报废。
//
// 现场 (session stk-1792179831955#sub-0-analyzer, 问「查一下英伟达现在的股价」):
//   外面看到 16.5s "零工具调用", final 说 "本轮查询工具未执行, 不能编价格"。
//   日志里的真相是**工具真调了, 而且真拿到了数据**:
//     [smoke-hook-Post] web_fetch ok=false  (Yahoo 403)
//     [smoke-hook-Post] web_fetch ok=true   (stooq 成功 ← 行情就在这条里)
//     [self_correct]    web_fetch verdict=incorrect
//     break;                                ← 消费循环当场中断
//   断掉之后: 第二条 tool 没进 toolResults, 而回灌循环遍历的正是 toolResults
//             → 推了 0 条 tool 消息 → messages 停在 assistant(tool_calls:[2])
//             → 上游 HTTP 400 "tool call and result not match" → finalText len: 0
//
// 根因是**驱动源选错**: 上游的配对契约长在 assistant.tool_calls 上, 不在 toolResults 上。
// toolResults 是"消费循环处理到哪"的中间集合, 它可以被 break / continue / 熔断截断,
// 拿它当驱动源, 截断 = 契约断裂。2749 行那句注释早就写明了这个约束,
// 但 SELF_CORRECT_FAIL 分支的 break 没兑现它。
//
// 这个文件的核心断言是**动态**的: 用真实的"消费循环在第 1 条就 break"重放一遍回灌,
// 断言 2 个 tool_call_id 都拿到了 tool 消息, 且成功那条的数据没丢。
// 只做静态文本断言的话, "遍历 toolResults 还是遍历 toolCalls" 这种错根本钉不住。

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
const LOOP_SRC = fs.readFileSync(path.join(ROOT, 'modules', 'j2_agent_loop.js'), 'utf8');

// ---- 从真源码抽出回灌块, 用真代码跑 (而不是抄一份逻辑自己测自己) ----

function extractRefillBlock() {
  const start = LOOP_SRC.indexOf('const _j2SetExecResult = (tc, result) =>');
  assert.ok(start > 0, '要能找到 _j2SetExecResult (按 tool_call_id 落结果)');
  // 只取 refill 主体。end 标记用 _badResults (反幻觉钩子②), 它紧跟在回灌后面 ——
  // 早先用 messages.push({role:'tool'... 当标记会命中文件前面 task_done 那处推送 (行 ~2211),
  // 切出负长度的块, 报 "_j2FinalResult is not defined" —— 这种"标记不唯一"本身就是坑。
  const bodyStart = LOOP_SRC.indexOf('const _j2FinalResult = new Map();', start);
  // 退到紧随其后的 try { 之前 —— 直接切在 _badResults 那行会把 try 切成半个,
  // 报 "Missing catch or finally after try"。
  const _badIdx = LOOP_SRC.indexOf('const _badResults = toolResults.filter', bodyStart);
  const end = LOOP_SRC.lastIndexOf('try {', _badIdx);
  assert.ok(bodyStart > start, '要能找到 _j2FinalResult (回灌驱动源)');
  assert.ok(end > bodyStart, '要能找到回灌块末尾 (_badResults)');
  return LOOP_SRC.slice(bodyStart, end);
}

// 真源码里的 setter, 原样搬过来用 (改了就跟线上不一致, 那这个护栏就白写了)
const SETTER_SRC = LOOP_SRC.slice(
  LOOP_SRC.indexOf('const _j2SetExecResult = (tc, result) =>'),
  LOOP_SRC.indexOf('_j2ResultByCallId.set(tc.id, result);') + '_j2ResultByCallId.set(tc.id, result);\n        };'.length
);

test('R1 回灌的驱动源必须是 toolCalls, 不是 toolResults', () => {
  // 钉死"驱动源"这个语义: 缺口是拿 toolCalls 逐条找出来的。
  assert.match(LOOP_SRC, /for \(const tc of toolCalls\) \{[\s\S]{0,200}?_j2FinalResult\.has\(tc\.id\)\) continue;/,
    'R1: 必须以 toolCalls 为准找缺口 (每个 tool_call_id 都要有结果)');

  // 反向: 不能再出现"遍历 toolResults 来决定推几条"的写法
  const refillRegion = LOOP_SRC.slice(
    LOOP_SRC.indexOf('// 回灌 messages (下一轮 LLM 看结果)'),
    LOOP_SRC.indexOf('if (!isAnthropic) {', LOOP_SRC.indexOf('// 回灌 messages (下一轮 LLM 看结果)')) + 900
  );
  assert.doesNotMatch(refillRegion, /for \(const \{ tc, execResult \} of toolResults\)\s*\{\s*\n\s*messages\.push\(\{ role: 'tool'/,
    'R1: 回灌不得再遍历 toolResults 推消息 (那正是被 break 截断的集合)');
});

test('R2 动态重放: 消费循环在第 1 条就 break, 两条 tool_call 仍都要有结果', () => {
  const block = extractRefillBlock();

  // 现场形状: 第 1 条失败 → self_correct 判 incorrect → break;
  // 第 2 条**成功**且已执行, 只是没轮到消费。
  const toolCalls = [
    { id: 'call_A', name: 'web_fetch', params: { url: 'yahoo' } },
    { id: 'call_B', name: 'web_fetch', params: { url: 'stooq' } },
  ];
  const toolResults = [{ tc: toolCalls[0], execResult: { ok: false, error: { code: 'HTTP_403', message: 'HTTP 403' } } }];
  // 走真 setter: 先按执行阶段的顺序落两份 (break 之前两条其实都跑完了)
  const _j2ExecResults = new Map();
  const _j2ResultByCallId = new Map();
  const _j2NameSeq = {};
  const _j2Ukey = (tc) => {
    if (!tc._ukey) {
      _j2NameSeq[tc.name] = (_j2NameSeq[tc.name] || 0) + 1;
      tc._ukey = tc.name + '#' + _j2NameSeq[tc.name];
    }
    return tc._ukey;
  };
  const _j2SetExecResult = new Function('_j2ExecResults', '_j2ResultByCallId', '_j2Ukey',
    SETTER_SRC + '\n return _j2SetExecResult;')(_j2ExecResults, _j2ResultByCallId, _j2Ukey);
  _j2SetExecResult(toolCalls[0], { ok: false, error: { code: 'HTTP_403', message: 'HTTP 403' } });
  _j2SetExecResult(toolCalls[1], { ok: true, data: 'NVDA 182.50  +1.2%' });
  const toolsUsed = ['web_fetch'];
  const toolHistory = [];
  const messages = [
    { role: 'user', content: '查一下英伟达现在的股价' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'call_A', type: 'function', function: { name: 'web_fetch', arguments: '{}' } },
      { id: 'call_B', type: 'function', function: { name: 'web_fetch', arguments: '{}' } },
    ] },
  ];

  // 2026-10-21: 抽出来 eval 的生产片段多了一个自由变量 _recordChartEvidence
  // (排盘证据留存, 第六批加的), 沙箱不提供就 ReferenceError —— 片段新增依赖时这里必须跟着补,
  // 否则这类"把真代码抽出来单跑"的守卫会在无关改动上炸, 久了就没人信它。
  //
  // 2026-10-25 (第 85 批): 片段又多了一个自由变量 _j2GuardMsgs ——
  //   守门提示现在**攒着**, 等 tool 结果回灌完再 push (见 j2_agent_loop 的 _j2GuardMsgs 注释)。
  //   这正是第 85 批要修的病: 守门提示插在 assistant(tool_calls) 和它的结果中间 ⇒ 上游 400。
  //   沙箱给一个空数组 (片段里 flush 的是它, 空数组 ⇒ flush 什么都不做, 语义不变)。
  const fn = new Function(
    'toolCalls', 'toolResults', '_j2ResultByCallId', 'toolsUsed', 'toolHistory', 'console',
    'messages', 'isAnthropic', '_fitToolResult', '_recordChartEvidence', '_j2GuardMsgs',
    block + '\n return { _j2FinalResult, backfilled: _j2Backfill, toolResults, messages };'
  );
  const out = fn(toolCalls, toolResults, _j2ResultByCallId, toolsUsed, toolHistory, { warn() {} },
    messages, false, (x) => JSON.stringify(x), () => {}, []);

  // 核心断言: 两个 tool_call_id 都有结果 —— 契约不再断裂
  assert.ok(out._j2FinalResult.has('call_A'), 'R2: call_A 必须有结果 (它被消费过)');
  assert.ok(out._j2FinalResult.has('call_B'), 'R2: call_B 必须有结果 —— 它是这条 P0 的正主');

  // 更强的断言: 成功那条的**真实数据**不能被占位符顶掉
  const bData = out._j2FinalResult.get('call_B');
  assert.strictEqual(bData.ok, true, 'R2: call_B 真跑成功了, 结果必须是成功结果, 不是占位');
  assert.match(JSON.stringify(bData), /182\.50/,
    'R2: 拿到的行情数据必须原样回到 messages —— 丢了就等于白调一次工具');

  // 占位只在**真没执行**时出现, 这条不属于占位场景
  assert.strictEqual(out.backfilled.length, 0,
    'R2: call_B 执行过, 不该被记成占位 (backfilled 应为空)');

  // 记账: 真跑过的那条要补进 toolsUsed, 否则指标少报
  assert.strictEqual(toolsUsed.filter(n => n === 'web_fetch').length >= 1, true,
    'R2: toolsUsed 至少有 web_fetch');

  // 正主断言: 上游按 tool_call_id 配对 —— 2 个 tool_call 必须有 2 条 tool 消息, 一条不能少。
  const toolMsgs = messages.filter(m => m.role === 'tool');
  assert.strictEqual(toolMsgs.length, 2,
    'R2: 2 个 tool_call 必须回灌 2 条 tool 消息 (少一条 = 上游 400 tool call and result not match)');
  assert.deepStrictEqual(toolMsgs.map(m => m.tool_call_id), ['call_A', 'call_B'],
    'R2: tool_call_id 必须与 assistant.tool_calls 逐一对上');
  assert.match(toolMsgs[1].content, /182\.50/,
    'R2: 成功那条的真实数据必须真的进了 messages —— 这正是今天白调一次工具的那一步');
});

test('R3 真没执行的 tool_call 也必须补占位, 且不许虚报 real_tool_calls_total', () => {
  const block = extractRefillBlock();

  // 场景: 第 2 条压根没执行 (被熔断 / 权限拒), 不在 _j2ExecResults 里。
  const toolCalls = [
    { id: 'call_A', name: 'web_fetch', params: {} },
    { id: 'call_C', name: 'web_fetch', params: {} },
  ];
  const toolResults = [
    { tc: toolCalls[0], execResult: { ok: false, error: { code: 'HTTP_403', message: 'HTTP 403' } } },
  ];
  const _j2ExecResults = new Map();
  const _j2ResultByCallId = new Map();
  const _j2NameSeq = {};
  const _j2Ukey = (tc) => {
    if (!tc._ukey) {
      _j2NameSeq[tc.name] = (_j2NameSeq[tc.name] || 0) + 1;
      tc._ukey = tc.name + '#' + _j2NameSeq[tc.name];
    }
    return tc._ukey;
  };
  // 只有第 1 条真跑了; 第 2 条 (call_C) 被熔断/权限拒, 压根没进执行阶段
  const _j2SetExecResult = new Function('_j2ExecResults', '_j2ResultByCallId', '_j2Ukey',
    SETTER_SRC + '\n return _j2SetExecResult;')(_j2ExecResults, _j2ResultByCallId, _j2Ukey);
  _j2SetExecResult(toolCalls[0], { ok: false, error: { code: 'HTTP_403', message: 'HTTP 403' } });
  const toolsUsed = ['web_fetch'];
  const toolHistory = [];
  const messages = [
    { role: 'user', content: '查一下英伟达现在的股价' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'call_A', type: 'function', function: { name: 'web_fetch', arguments: '{}' } },
      { id: 'call_C', type: 'function', function: { name: 'web_fetch', arguments: '{}' } },
    ] },
  ];

  const fn = new Function(
    'toolCalls', 'toolResults', '_j2ResultByCallId', 'toolsUsed', 'toolHistory', 'console',
    'messages', 'isAnthropic', '_fitToolResult', '_recordChartEvidence', '_j2GuardMsgs',
    block + '\n return { _j2FinalResult, backfilled: _j2Backfill, toolResults, messages };'
  );
  const out = fn(toolCalls, toolResults, _j2ResultByCallId, toolsUsed, toolHistory, { warn() {} },
    messages, false, (x) => JSON.stringify(x), () => {}, []);

  assert.ok(out._j2FinalResult.has('call_C'), 'R3: 没执行的也必须有结果, 否则又是孤儿 tool_call');
  const c = out._j2FinalResult.get('call_C');
  assert.strictEqual(c.ok, false, 'R3: 占位结果必须是失败态, 不许伪装成成功');
  assert.strictEqual(c.error.code, 'TOOL_RESULT_MISSING', 'R3: 占位要有可判别的错误码');
  assert.match(c.error.message, /不是这条工具不存在/,
    'R3: 占位文案要告诉模型"这是被自家闸门掐掉的, 不是工具不存在" —— 否则它会重发同一条再撞一次');
  assert.strictEqual(out.backfilled.length, 1, 'R3: 恰好 1 条占位');

  // 关键的反向断言: 没执行的**不许**进 toolsUsed, 否则 real_tool_calls_total 虚报,
  // 而那个数字正是用来判"模型到底调没调工具"的 —— 虚报就把真问题盖住了。
  const countedBefore = toolsUsed.length;
  assert.strictEqual(countedBefore, 1,
    'R3: 没执行的 tool 不许补进 toolsUsed (会虚报 real_tool_calls_total)');

  // 同样不能少消息: 没执行的那条也必须有一条 tool 消息顶着, 否则还是孤儿 tool_call
  const toolMsgs = messages.filter(m => m.role === 'tool');
  assert.strictEqual(toolMsgs.length, 2,
    'R3: 没执行的那条也必须有 tool 消息 —— 缺了照样 400');
  assert.deepStrictEqual(toolMsgs.map(m => m.tool_call_id), ['call_A', 'call_C'],
    'R3: tool_call_id 仍须逐一对上 assistant.tool_calls');
});

test('R4 SELF_CORRECT_FAIL 的 break 必须有配对补偿, 不是无责任中断', () => {
  // break 本身没问题 (熔断要有), 但它必须落在"回灌以 toolCalls 为准"之后才安全。
  // 钉死这个先后关系: 回灌块在源码里位于 break 之后, 否则修了也没用。
  const breakIdx = LOOP_SRC.indexOf('break;  // 中断本 round tool 执行');
  const refillIdx = LOOP_SRC.indexOf('// 回灌 messages (下一轮 LLM 看结果)');
  assert.ok(breakIdx > 0, '要能找到 SELF_CORRECT_FAIL 的 break');
  assert.ok(refillIdx > breakIdx,
    'R4: 回灌块必须在 break 之后 (回灌依赖 toolCalls 全集, 天然在消费循环之后)');
  assert.match(LOOP_SRC, /TOOL_RESULT_MISSING/,
    'R4: 补位路径要有日志/错误码标记, 现场能看见');
});

test('R5 不许凭空造 tool_call_id (verify-after-allow 的 "verify" 是同类的第二处)', () => {
  // 扫之前先剥注释 —— 注释里引用旧代码是这里修的**证据**, 按原文扫全文必然撞上自己
  // (踩坑日志第 9 条: 断言扫到自己的注释)。只留可执行代码。
  const codeOnly = LOOP_SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1'))
    .join('\n');

  // 全文件扫: 任何 messages.push({ role:'tool', tool_call_id: X }) 里的 X,
  // 都必须来自 assistant 真实发出的 tool_calls。'verify' 这种自造 id 一律不行。
  const fakeIdPushes = [...codeOnly.matchAll(/role:\s*'tool',\s*tool_call_id:\s*([^,}]+)/g)]
    .map(m => m[1].trim());
  assert.ok(fakeIdPushes.length >= 2,
    'R5: 扫不到 tool 结果推送点就说明正则失效了, 护栏没在看真东西');
  for (const idExpr of fakeIdPushes) {
    assert.ok(/^(tc\.id|taskDoneCall\.id)$/.test(idExpr),
      'R5: tool_call_id 只能来自真实 tool_call (tc.id / taskDoneCall.id), '
      + '发现自造 id: ' + idExpr + ' —— 上游按 id 配对, 对不上直接 400');
  }
  // 具体钉住 verify 那处: 它必须变成 system 通知, 且 verify-after-allow 的信息不许丢
  assert.doesNotMatch(codeOnly, /tool_call_id:\s*'verify'/,
    'R5: verify-after-allow 不许再推 tool_call_id:"verify" 的 tool 消息');
  assert.match(LOOP_SRC, /PERMISSION_VERIFIED/,
    'R5: 改成 system 通知后, "权限已生效" 这条信息仍要送达模型');
});

