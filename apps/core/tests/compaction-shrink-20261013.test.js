'use strict';
// 2026-10-13 盘古的「压缩」压完比压前还大 —— 长工作做不了的直接机制
//
// 线上现场 (探针 objw-live-1791850128, 子 agent sub-0; 修复 9eb32e7 让子 agent
// 会话首次落盘之后才看得见的):
//   - 日志: `107 -> 108 msgs, ratio 1.01` / `122 -> 124 msgs, ratio 1.03`
//   - 落盘 compaction_summary 119392 字符, 而 _summaryCap 字段写着 60000
//   - 该摘要的头是 {"type":"fold","summary":"【会话摘要】{\n \"type\":\"fold\"...
//     尾是一串 \\\\\\\ —— 摘要自己套自己, JSON 转义的反斜杠一轮翻一倍
//   - sub-0 跑了 50 多轮、账本记着文件数 11→66, 而对话记录 assistant 0 条 tool 0 条:
//     124 条里 122 条是注入的 system 提示 (53 份环境提示 + 24 份角色提示 +
//     42 份续跑 + 3 份账本), 这 122 条**精确去重后只剩 6 条**。
//
// 三个缺陷叠在一起:
//   A. buildCompactedMessages 把摘要包成 `【会话摘要】${JSON.stringify(summary)}`,
//      下一轮 compact() 把整条当 oldSummary 再塞进新摘要的 summary 字段 → 自嵌套、无界增长。
//   B. _summaryCap 写进去**全代码库没有任何地方读它** → 封顶形同虚设。
//   C. buildCompactedMessages 里 keepSystemMessages 把所有 system 消息**一条不压全留**,
//      而盘古的会话 99% 就是注入的 system 提示 → 压不动。
const test = require('node:test');
const assert = require('node:assert/strict');

const { createCompactor } = require('../modules/session_compaction');

const ENV_PROMPT = '[运行环境 — 路径铁律] 主机: x.local | 平台: darwin/arm64 | 真用户名: you | 真 home: /Users/you';
const ROLE_PROMPT = '# 你是盘古的 Executor（执行者）。职责：写文件、改文件、运行命令、生成 artifact。';
const TASK = '在 /tmp/pangu_steps/alpha/ 下逐个真实写入 a1.txt、a2.txt、a3.txt';
const LEDGER_PROMPT = '# 任务账本 (盘古真账 — 全部来自工具结果, 不是你的自述)\n**目标**: ' + TASK;

// 复刻线上 sub-0 的真实配比: 注入的 system 提示 122 条, 真正的对话只有个位数。
// 之前用「注入少、真实回合多」的样本压完确实会变短, 抓不到线上 ratio≈1 的病 ——
// 这就是「样本不忠实于现场」的教训。
function buildOnlineShapedConversation() {
  const msgs = [];
  for (let i = 0; i < 24; i++) msgs.push({ role: 'system', content: ROLE_PROMPT });
  for (let i = 0; i < 53; i++) msgs.push({ role: 'system', content: ENV_PROMPT });
  for (let i = 0; i < 3; i++) msgs.push({ role: 'system', content: LEDGER_PROMPT });
  msgs.push({ role: 'user', content: TASK });
  for (let i = 0; i < 42; i++) msgs.push({ role: 'system', content: '[自动续跑] objective_incomplete, 第 ' + i + ' 次。' });
  for (let i = 0; i < 2; i++) {
    msgs.push({
      role: 'assistant', content: '',
      tool_calls: [{ id: 'x' + i, type: 'function', function: { name: 'write_file', arguments: '{"p":"a' + i + '.txt"}' } }],
    });
    msgs.push({
      role: 'tool', content: JSON.stringify({ ok: true, data: 'x'.repeat(600) }),
      tool_call_id: 'x' + i, tool_name: 'write_file',
    });
  }
  return msgs;
}

// 真实回合较多、注入较少的普通形状 (给去重/自嵌套/不变量用例用)
function buildBusyConversation(rounds) {
  const msgs = [];
  msgs.push({ role: 'system', content: ROLE_PROMPT });
  msgs.push({ role: 'user', content: TASK });
  for (let i = 0; i < rounds; i++) {
    msgs.push({ role: 'system', content: '[自动续跑] objective_incomplete, 第 ' + i + ' 次。' });
    msgs.push({
      role: 'assistant', content: '',
      tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'write_file', arguments: '{"p":"a' + i + '.txt"}' } }],
    });
    msgs.push({
      role: 'tool', content: JSON.stringify({ ok: true, data: 'x'.repeat(600) }),
      tool_call_id: 'c' + i, tool_name: 'write_file',
    });
  }
  return msgs;
}

const totalChars = (ms) => ms.reduce((n, m) => n + String((m && m.content) || '').length, 0);
const countCopies = (ms, needle) => ms.filter(m => String((m && m.content) || '').includes(needle)).length;

test('压缩必须真的让会话变短 (线上 ratio 1.01~1.03, 压完比压前还大)', async () => {
  const c = createCompactor({});
  const input = buildOnlineShapedConversation();
  c.register('shrink-1', input);
  const beforeN = input.length, beforeChars = totalChars(input);

  const r = await c.compact('shrink-1');
  const out = r.compactedMessages;

  assert.ok(out.length < beforeN,
    '消息条数必须减少: 压前 ' + beforeN + ' → 压后 ' + out.length);
  assert.ok(totalChars(out) < beforeChars,
    '总字符必须减少: 压前 ' + beforeChars + ' → 压后 ' + totalChars(out));
});

test('重复注入的系统提示必须折叠成一份 (线上 122 条注入 system 去重后只剩 6 条)', async () => {
  const c = createCompactor({});
  const input = buildOnlineShapedConversation();
  c.register('dedup-1', input);
  assert.equal(countCopies(input, '路径铁律'), 53, '前提: 压前确实是 53 份');
  assert.equal(countCopies(input, 'Executor'), 24, '前提: 角色提示压前确实是 24 份');

  const out = (await c.compact('dedup-1')).compactedMessages;

  assert.equal(countCopies(out, '路径铁律'), 1,
    '53 份一模一样的环境提示压完必须只剩 1 份, 实际 ' + countCopies(out, '路径铁律') + ' 份');
  assert.equal(countCopies(out, 'Executor'), 1,
    '角色提示同理, 实际 ' + countCopies(out, 'Executor') + ' 份');
});

// 不变式是「有界」而不是「单调变小」: 不同轮走 fold / generateSummary 两条路,
// 摘要长度本来就会有正常起伏。曾经踩过的坑是把它写成单调断言, 结果被自己的用例判红。
test('摘要有界: 连压 8 轮不自嵌套、不越过封顶、不出现数量级膨胀', async () => {
  const c = createCompactor({});
  c.register('nest-1', buildBusyConversation(45));

  let firstLen = 0;
  for (let round = 1; round <= 8; round++) {
    const r = await c.compact('nest-1');
    const sums = r.compactedMessages.filter(m => m.isCompactionSummary);
    assert.equal(sums.length, 1,
      '第 ' + round + ' 轮压缩后只该有一条摘要消息, 实际 ' + sums.length + ' 条');
    const content = String(sums[0].content || '');
    const body = content.replace(/^【会话摘要】/, '');
    assert.equal(body.includes('【会话摘要】'), false,
      '第 ' + round + ' 轮摘要里又出现【会话摘要】= 自己套自己, 长度 ' + content.length);
    assert.ok(content.length <= 70000,
      '第 ' + round + ' 轮摘要 ' + content.length + ' 字符, 超过 _summaryCap(60000) 的余量');
    if (round === 1) firstLen = content.length;
    else {
      assert.ok(content.length <= firstLen * 4,
        '第 ' + round + ' 轮摘要 ' + content.length + ' 相对首轮 ' + firstLen
        + ' 出现数量级膨胀 = 自嵌套复发');
    }
  }
});

// 结构性守卫: _summaryCap 当年是写进去没人读的, 封顶形同虚设。
test('_summaryCap 必须真被读 (2026-09-16 写进去, 全代码库零引用)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../modules/session_compaction'), 'utf8');
  const reads = src.match(/_summaryCap/g) || [];
  assert.ok(reads.length >= 2,
    '_summaryCap 至少要被读一次 (写 + 读), 实际出现 ' + reads.length + ' 次');
  assert.match(src, /merged\.slice\(0,\s*SUMMARY_CAP\)/,
    '折进摘要时必须真的按封顶 slice');
});

test('压缩产物仍须保住既有硬不变量: 最后一条 user + ≥1 条非 system + tool 配对完整', async () => {
  const c = createCompactor({});
  c.register('inv-1', buildBusyConversation(45));
  const out = (await c.compact('inv-1')).compactedMessages;

  assert.ok(out.some(m => m.role === 'user'), '主人当前问的那句不能被压掉');
  assert.ok(out.some(m => m.role !== 'system'), '至少要留一条非 system 消息');
  const callIds = new Set();
  for (const m of out) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) callIds.add(tc.id);
    }
  }
  for (const m of out) {
    if (m.role === 'tool') {
      assert.ok(callIds.has(m.tool_call_id),
        '出现孤儿 tool result: ' + m.tool_call_id + ' (会触发上游 400)');
    }
  }
});

// 去重只压得住**逐字相同**的那些。盘古注入的续跑/熔断提示每轮带不同计数 (#1/#2/#3),
// 去重压不住 —— 少了有界闸门, 这些陈年指令会逐轮累积 (实测 47→62→66)。
test('压缩产物里保留的注入 system 提示必须有界', async () => {
  const c = createCompactor({});
  c.register('sysbound-1', buildBusyConversation(45));
  for (let round = 1; round <= 6; round++) {
    const out = (await c.compact('sysbound-1')).compactedMessages;
    const sys = out.filter(m => m.role === 'system' && !m.isCompactionSummary);
    assert.ok(sys.length <= 20,
      '第 ' + round + ' 轮保留了 ' + sys.length + ' 条注入 system, 必须有界');
  }
});

// 线上 sub-0 是「边干活边压缩」: 每轮压缩完又干一堆活, 会话重新变大, 于是 fold 分支
// 每轮都会把上一轮的旧摘要折进新摘要。只跑一次压缩抓不到自嵌套, 必须连着跑。
test('边干活边连续压缩: 旧摘要折进新摘要时不得自嵌套', async () => {
  const c = createCompactor({});
  c.register('grow-1', buildBusyConversation(120));
  for (let round = 1; round <= 4; round++) {
    const r = await c.compact('grow-1');
    const sums = r.compactedMessages.filter(m => m.isCompactionSummary);
    assert.equal(sums.length, 1, '第 ' + round + ' 轮只该有一条摘要, 实际 ' + sums.length);
    const content = String(sums[0].content || '');
    assert.equal(content.replace(/^【会话摘要】/, '').includes('【会话摘要】'), false,
      '第 ' + round + ' 轮摘要自嵌套, 长度 ' + content.length);
    assert.ok(content.length <= 70000, '第 ' + round + ' 轮摘要 ' + content.length + ' 字符, 越过封顶');
    // 这一轮又干了一堆活 → 会话重新变大, 逼下一轮 fold 分支再次吃到旧摘要
    const s = c.sessions.get('grow-1');
    s.messages = s.messages.concat(buildBusyConversation(120).slice(2));
  }
});
