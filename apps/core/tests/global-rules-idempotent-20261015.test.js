'use strict';
// 2026-10-15 全局铁律被逐份叠加 —— 模型链 fallback 每跳一次多塞一份 5302 token
//
// 现场 (/tmp/pangu-single.log 的 [prompt-profile], 一次 28560 token 的请求):
//   8:system=5302  [运行环境 — 路径铁律] 主机: fengdeMacB…
//  13:system=5302  [运行环境 — 路径铁律] 主机: fengdeMacB…
//  16:system=5302  [运行环境 — 路径铁律] 主机: fengdeMacB…
// 三份逐字重复, 占整个提示词 15906/28560 = 56%。本地 27B prefill ~285 tok/s,
// 多一份就是白等 ~18s, 而且是每一轮。
//
// 机制 (逐轮计数实测):
//   round=0 msgs=2  gar_copies=1
//   round=0 msgs=10 gar_copies=2   ← _runAgentLoopLegacyStream 被重新进入
//   round=0 msgs=15 gar_copies=3
// silent_failure 触发模型链 fallback 时, 递归调自己 (chain-switch 那行),
// 而那次只剥"空调 assistant 消息", 已经注入的全局铁律留在数组里 → 再前置一份。
// getGlobalRules() 每次只被调 1 次 —— 不是重复调用, 是**同一份内容被叠进数组多次**。
//
// 修法: 注入幂等 —— 目标 system 消息已经以 [运行环境 — 路径铁律] 开头就不再前置。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const j2 = require('../modules/j2_agent_loop');

test('第一次注入: 正常前置, 返回 true', () => {
  const msgs = [{ role: 'system', content: 'ORIGINAL' }];
  const did = j2._injectGlobalRulesOnce(msgs, 0, '', 'TAIL');
  assert.equal(did, true, '首次必须注入');
  assert.ok(msgs[0].content.startsWith(j2._GAR_MARK), '注入后必须以全局铁律开头');
  assert.ok(msgs[0].content.includes('ORIGINAL'), '原内容必须保留');
  assert.ok(msgs[0].content.includes('TAIL'), '尾部提示必须保留');
});

test('第二次注入同一位置: 必须跳过, 不叠第二份', () => {
  const msgs = [{ role: 'system', content: 'ORIGINAL' }];
  j2._injectGlobalRulesOnce(msgs, 0, '', 'TAIL');
  const first = msgs[0].content;
  const did = j2._injectGlobalRulesOnce(msgs, 0, '', 'TAIL');
  assert.equal(did, false, '已注入过必须返回 false');
  assert.equal(msgs[0].content, first, '内容必须逐字不变 —— 再叠一份就是白等 ~18s prefill');
});

test('模拟模型链 fallback 连跳三次: 只能有一份全局铁律', () => {
  // chain-switch 递归时传的就是"上一轮已经注入过"的 messages
  const msgs = [{ role: 'system', content: 'ORIGINAL' }];
  for (let hop = 0; hop < 3; hop++) j2._injectGlobalRulesOnce(msgs, 0, '', 'TAIL');
  const n = msgs[0].content.split(j2._GAR_MARK).length - 1;
  assert.equal(n, 1, '三跳之后只能有 1 份, 实际 ' + n + ' 份');
});

test('fallback 剥掉空调 assistant 之后重注入, 仍只能有一份', () => {
  // 复刻 chain-switch 真实动作: 只剥 assistant 空消息, system 原样留着
  let msgs = [{ role: 'system', content: 'ORIGINAL' }, { role: 'assistant', content: '', tool_calls: [] }];
  j2._injectGlobalRulesOnce(msgs, 0, '', 'TAIL');
  msgs = msgs.filter(m => !(m && m.role === 'assistant' && !m.content && !m.tool_calls));
  const idx = msgs.findIndex(m => m.role === 'system');
  j2._injectGlobalRulesOnce(msgs, idx, '', 'TAIL');
  const n = msgs[idx].content.split(j2._GAR_MARK).length - 1;
  assert.equal(n, 1, 'fallback 之后仍只能有 1 份, 实际 ' + n + ' 份');
});

test('注入之后又 push 了新的 system 消息, 再注入仍只能有一份', () => {
  // 这是实测里真正复现的那条路径: 第一次注入后, 循环里又 push 了
  // [SYSTEM WARNING] / [SELF_CORRECT_FAIL] 等 system 消息, 于是"最后一条 system"
  // 已经不是原来那条了 —— 逐条判定会往新消息上再塞一份全局铁律 (实测 at[7,8,11])。
  const msgs = [{ role: 'system', content: 'ORIGINAL' }];
  j2._injectGlobalRulesOnce(msgs, 0, '', 'TAIL');
  msgs.push({ role: 'system', content: '[SYSTEM WARNING] 工具失败' });
  msgs.push({ role: 'system', content: '[SELF_CORRECT_FAIL] tool=list_dir' });
  const last = msgs.map(m => m.role).lastIndexOf('system');
  const did = j2._injectGlobalRulesOnce(msgs, last, '', 'TAIL');
  assert.equal(did, false, '数组里已经有全局铁律 → 必须整体跳过');
  const n = msgs.filter(m => String(m.content || '').indexOf(j2._GAR_MARK) === 0).length;
  assert.equal(n, 1, '只能有 1 份, 实际 ' + n + ' 份');
  assert.ok(msgs[last].content.includes('[SELF_CORRECT_FAIL]'),
    '后面那条 system 的原内容必须原样保留, 不能被清掉');
});

test('判定粒度是整个数组: 别处已注入就不该再往目标消息上塞', () => {
  const msgs = [
    { role: 'system', content: j2._GAR_MARK + ' + 已有的一份' },
    { role: 'system', content: 'ORIGINAL' },
  ];
  const did = j2._injectGlobalRulesOnce(msgs, 1, '', 'TAIL');
  assert.equal(did, false);
  assert.equal(msgs[1].content, 'ORIGINAL', '目标消息必须一个字都没动');
});

test('所有注入点都必须走幂等守卫, 不许有人绕过直接调 _getGlobalRules', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  // 守卫自己的实现里当然也有这个写法 (它就是那个"安全地拼一次"的地方),
  // 先把它整段切掉, 只检查**其余**代码有没有绕过。
  const _h0 = src.indexOf('function _injectGlobalRulesOnce');
  const _h1 = src.indexOf('\n}', _h0);
  const outsideGuard = src.slice(0, _h0) + src.slice(_h1 + 2);
  // 禁止**旧的绕过写法**: 直接往某条已有 system 消息上拼 _getGlobalRules。
  // 这正是叠 3 份的成因 —— 模型链 fallback 带着已注入的 messages 递归回来时走的这条。
  const bypass = outsideGuard.match(/messages\[\w+\] = \{ \.\.\.messages\[\w+\], content: _getGlobalRules\([^)]*\)/g) || [];
  assert.equal(bypass.length, 0,
    '还有 ' + bypass.length + ' 处直接往已有 system 消息上拼全局铁律, 会重复叠加');

  // 3 处 = 守卫函数内部 1 处 + 两个 unshift 分支 (各自自带 some() 判定)。
  const raw = (src.match(/_getGlobalRules\([^)]*\) \+ _readSelfKnowledge\([^)]*\)/g) || []).length;
  assert.equal(raw, 3,
    '直接拼 _getGlobalRules 的地方应只剩守卫内部 1 处 + unshift 2 处, 实际 ' + raw +
    ' 处 —— 多出来的说明有新的注入点绕过了幂等守卫');
  // 3 = 守卫函数定义 1 + 两个调用点 (不许有第三个调用点绕过)
  assert.equal((src.match(/_injectGlobalRulesOnce\(messages,/g) || []).length, 3,
    '两个"已存在 system 消息"的注入点都必须走幂等守卫');
  // 两个 unshift 分支都必须走数组级判定
  assert.equal((src.match(/if \(!_hasGlobalRulesIn\(messages\)\)/g) || []).length, 2,
    '两个 unshift 注入点都必须先判定数组里是否已有全局铁律');
  assert.equal((src.match(/function _hasGlobalRulesIn/g) || []).length, 1,
    '_hasGlobalRulesIn 只应有一处实现, 不许各抄一份');
});

test('不能因为幂等就把真内容弄丢: 第一条注入成功, 后一条原样不动', () => {
  const msgs = [{ role: 'system', content: '你是 Pangu' }, { role: 'system', content: 'OTHER' }];
  const d0 = j2._injectGlobalRulesOnce(msgs, 0, '', 'TAIL');
  const d1 = j2._injectGlobalRulesOnce(msgs, 1, '', 'TAIL');
  assert.equal(d0, true, '第一条 system 正常注入');
  assert.equal(d1, false, '数组里已有 → 第二条不重复注入');
  assert.ok(msgs[0].content.startsWith(j2._GAR_MARK), '第一条以全局铁律开头');
  assert.ok(msgs[0].content.includes('你是 Pangu'), '原内容一个都不能丢');
  assert.ok(msgs[0].content.includes('TAIL'), '尾部提示不能丢');
  assert.equal(msgs[1].content, 'OTHER', '第二条必须逐字不变, 不能被覆盖也不能被清空');
  const n = msgs.filter(m => String(m.content || '').indexOf(j2._GAR_MARK) === 0).length;
  assert.equal(n, 1, '整个数组只能有 1 份, 实际 ' + n + ' 份');
});

// ============================================================================
// 第二条来源: **压缩自己造重复**。
//
// 现场 (/tmp/pangu-single.log, session=desktop-1791994196419, 18:25 那轮):
//   [prompt-profile] total=24538 gar_dup=3 at[7,8,10]
//   7:system=399  【会话摘要】{ "type": "smart", ...
//   8:system=6568 [运行环境 — 路径铁律] 主机: fengdeMacB…
//   10:system=6568 [运行环境 — 路径铁律] 主机: fengdeMacB…   ← 同一段又来一份
// 而 [gar-inject] 决策日志证实注入代码**只跑了一次** —— 所以不是注入点叠的,
// 是压缩把数组里已有的那条又放了一遍。
//
// 机制 (session_compaction.js buildCompactedMessages):
//   ① keepSystemMessages 分支 (默认 true) 已经把**去重后**的 system 消息全发出去了
//   ② 紧接着的 recentMessages 分支 filter 是 `m.role !== 'system' || !m.isCompactionSummary`
//      —— 放行了**所有**非摘要 system 消息, 跟 ① 的产物重叠
//   ③ 一次压缩多一份, 再压一次三份。而这份 6568 token, 本地 27B prefill ~285 tok/s
//      ≈ 白等 23s, 而且**每一轮工具调用都要重付一次**。
//
// 为什么必须单独写这条测试: compaction-shrink-20261013.test.js 里那条
// "53 份压完只剩 1 份" **修前也过** —— 它的 fixture 走 smart 分支,
// smart 分支只 push summary.importantMessages, 压根不碰 recentMessages,
// 所以那条断言对"重复"这个病是假绿。这里必须显式走 else 分支。
// ============================================================================

const { SessionCompaction } = require('../modules/session_compaction');
const GAR = '[运行环境 — 路径铁律]';
const countCopies = (ms, needle) =>
  ms.filter(m => String((m && m.content) || '').indexOf(needle) >= 0).length;

// 复刻线上形状 —— 关键在**位置**: 重复不是凭空来的, recentMessages 尾部还有
// `.slice(-maxRetainedMessages)` (默认 20), 铁律消息必须落在保留窗口里才会被放第二遍。
// 线上就是落在窗口里 —— 18:25 那轮压出来的数组长这样:
//   7:summary  8:GAR  9:WARNING  10:GAR  11:WARNING  12:ledger  13:autorun …
// 第 ① 步去重分支先发了一份 (8/9), recentMessages 又把窗口内的同一条发了一遍 (10/11)。
// 第一版 fixture 把 GAR 放在 index 1, 被 slice(-20) 甩掉 → 修前修后都过, 纯假绿。
function buildCompactionFixture() {
  const msgs = [
    { role: 'system', content: '# 你是盘古 (Pangu)\n你是盘古,内部 129 个工具。' },
    { role: 'user', content: '第一问' },
  ];
  for (let i = 0; i < 40; i++) {
    msgs.push({ role: 'assistant', content: '答' + i });
    msgs.push({ role: 'user', content: '追问' + i });
  }
  // 注入块落在保留窗口 (最后 20 条) 之内 —— 这才是线上触发重复的位置
  msgs.push({ role: 'system', content: GAR + '\n主机: fengdeMacBook-Pro\n' + '铁律正文。'.repeat(400) });
  msgs.push({ role: 'system', content: '[SYSTEM WARNING] 刚才 1 个工具失败' });
  msgs.push({ role: 'user', content: '读一下 /Users/you/Desktop/pangu' });
  return msgs;
}

test('压缩不能自己造出第二份全局铁律 (走 else/recent 分支, 修前必挂)', async () => {
  const c = new SessionCompaction({ strategy: 'smart' });
  const input = buildCompactionFixture();
  c.register('garfold-1', input);
  assert.equal(countCopies(input, GAR), 1, '前提: 压前确实只有 1 份');

  // type='latest' → generateSmartSummary 那条路走不了 (type !== 'smart') →
  // 落进 else 分支的 recentMessages, 正是重复的现场。
  const r = await c.compact('garfold-1', {
    type: 'latest', timestamp: Date.now(), summary: '会话摘要正文',
  });
  const out = r.compactedMessages;

  assert.equal(countCopies(out, GAR), 1,
    '压缩产物里全局铁律只能有 1 份, 实际 ' + countCopies(out, GAR) +
    ' 份 —— else 分支把 keepSystemMessages 已经发过的 system 消息又放了一遍');
});

test('连续压三轮, 铁律份数恒为 1 (线上是 1→2→3 涨)', async () => {
  const c = new SessionCompaction({ strategy: 'smart' });
  c.register('garfold-2', buildCompactionFixture());
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const r = await c.compact('garfold-2', {
      type: 'fold', timestamp: Date.now(), summary: '第' + i + '轮摘要', foldKeepRecent: false,
    });
    c.register('garfold-2', r.compactedMessages);
    seen.push(countCopies(r.compactedMessages, GAR));
  }
  assert.deepEqual(seen, [1, 1, 1],
    '每轮压缩后都必须还是 1 份, 实际 ' + JSON.stringify(seen) + ' —— 涨就是回归');
});

test('keepSystemMessages=false 时不许把注入提示一起吞掉', async () => {
  // 上面的 filter 条件是 `... || !keepSystemMessages` —— 这个开关必须真的还有效,
  // 否则有人以后把默认值翻过来, 会静默丢掉全部注入提示而没人发现。
  // 注意断言只能落在**保留窗口内**的消息: recent 分支尾部还有 `.slice(-maxRetainedMessages)`,
 // 压在窗口外的 system 消息本来就会被丢 (那是既有行为, 不是这个修复的责任范围)。
  const c = new SessionCompaction({ strategy: 'smart', keepSystemMessages: false });
  const input = [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '答' },
    { role: 'system', content: GAR + '\n主机: fengdeMacBook-Pro\n铁律正文。' },
    { role: 'user', content: '当前问题' },
  ];
  c.register('garnosys-1', input);
  const r = await c.compact('garnosys-1', {
    type: 'latest', timestamp: Date.now(), summary: '摘要',
  });
  assert.ok(countCopies(r.compactedMessages, GAR) >= 1,
    '关掉 keepSystemMessages 后, recent 分支仍要负责把窗口内的 system 消息带过去, ' +
    '不能被新 filter 一并吞掉');
  assert.ok(r.compactedMessages.some(m => m.role === 'system' && !m.isCompactionSummary),
    '产物里必须还有非摘要 system 消息, 不然这个开关就是纯吞');
});

// ============================================================================
// 第三条来源 (真正的线上根因): **smart 分支绕过内容去重**。
//
// 上面两条测试都把 summary 钉成 latest/fold, 走 else 分支 —— 而线上默认 strategy='smart',
// 走的是 smart 分支, 结果**修完 else 分支照样出重复**。这是本轮栽的第二个假绿。
//
// 现场 (真实落盘 session ~/.pangu-data/sessions/garfix-1015_sub-0-analyzer.json, 17 条):
//   0 summary  1 GAR(15168)  2 Role  3 WARNING  4 GAR(15168)  5 Role  6 user …
// 第 1/4 条和第 2/5 条**逐字相同**。离线重放压缩: 3 份进去 → **4 份出来**。
//
// 机制: scoreMessages 给**每条** system 消息固定 +10, 注入块 15168 字符再 +2 (长消息加分),
//      而 user 只有 +3 / assistant +2 —— 盘古注入的 system 提示永远是得分最高的一批,
//      importantMessages 基本被它们占满。buildCompactedMessages 的 smart 分支
      // 「逐条 push 回 importantMessages」就等于把上面 keepSystemMessages 分支
//      刚做完的内容去重**原样撤销**。压一次多一份, 再压继续涨。
// ============================================================================

// 判定"真正的铁律消息": 必须以标记**开头**。
// 压缩摘要正文里会**引用**这段铁律 (createTextSummary 摘录), 用 includes 数会多算一份。
const countRealGar = (ms) => ms.filter(m => String(m.content || '').indexOf(GAR) === 0).length;

function buildSmartBranchFixture() {
  // 复刻线上形状: 铁律/角色/警告各出现两份 (逐字相同), 中间夹 user/assistant/tool 轮次。
  const gar = GAR + '\n主机: fengdeMacBook-Pro\n' + '铁律正文。'.repeat(400);
  const role = '你是 Pangu 的 Analyzer（分析者）。职责：分析需求、读取文件。';
  const warn = '[SYSTEM WARNING] 刚才 1 个工具失败或空输出 (read_file)。';
  const msgs = [
    { role: 'system', content: gar },
    { role: 'system', content: role },
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '答', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', content: JSON.stringify({ ok: true, data: 'x'.repeat(300) }), tool_call_id: 'c1', tool_name: 'read_file' },
    { role: 'system', content: warn },
    { role: 'system', content: gar },
    { role: 'system', content: role },
    { role: 'assistant', content: '再答', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', content: JSON.stringify({ ok: true, data: 'y'.repeat(300) }), tool_call_id: 'c2', tool_name: 'read_file' },
    { role: 'user', content: '读一下 /Users/you/Desktop/pangu' },
  ];
  return msgs;
}

test('smart 分支不许绕过内容去重 (线上默认策略, 修前必挂)', async () => {
  const c = new SessionCompaction({ strategy: 'smart' });   // 生产默认: 自己 generateSmartSummary
  const input = buildSmartBranchFixture();
  c.register('garsmart-1', input);
  assert.equal(countRealGar(input), 2, '前提: 压前确实是 2 份逐字相同的铁律');

  const out = (await c.compact('garsmart-1')).compactedMessages;

  assert.equal(countRealGar(out), 1,
    'smart 分支必须让 keepSystemMessages 分支独家负责 system 消息, 实际压出 ' +
    countRealGar(out) + ' 份 —— smart 分支把 importantMessages 里的 system 又 push 了一遍');
});

test('smart 分支连压 5 轮, 铁律份数恒为 1 (线上是滚雪球)', async () => {
  const c = new SessionCompaction({ strategy: 'smart' });
  c.register('garsmart-2', buildSmartBranchFixture());
  const seen = [];
  let cur = (await c.compact('garsmart-2')).compactedMessages;
  seen.push(countRealGar(cur));
  for (let i = 2; i <= 5; i++) {
    c.register('garsmart-2', cur);
    cur = (await c.compact('garsmart-2')).compactedMessages;
    seen.push(countRealGar(cur));
  }
  assert.deepEqual(seen, [1, 1, 1, 1, 1],
    '每轮都必须还是 1 份, 实际 ' + JSON.stringify(seen) + ' —— 涨一档就是回归');
});

test('smart 分支去掉 system 后, 对话内容一条都不能少', async () => {
  // 修法是「smart 分支不再重复放 system」, 不许顺手把 user/assistant/tool 也滤掉 ——
  // 那会让压缩变成只留摘要, 模型直接失忆。
  // 注意别断言「工具结果一定留着」: tool-pairing sanitize 会丢孤儿 tool result
  // (压完 assistant 被裁掉, tool 就成了孤儿), 那是既有行为, 不是这个修复的责任范围。
  // 这里断言的是**这次过滤没有误伤非 system 消息** —— 给足 assistant 正文让它们活下来。
  const msgs = buildSmartBranchFixture();
  msgs.splice(4, 0, { role: 'assistant', content: '结果: 已完成第一轮分析, 结论如下。'.repeat(6) });
  msgs.splice(9, 0, { role: 'assistant', content: '结论: 第二轮也完成了, 证据如下。'.repeat(6) });
  const c = new SessionCompaction({ strategy: 'smart', retentionRatio: 0.9 });
  c.register('garsmart-3', msgs);
  const out = (await c.compact('garsmart-3')).compactedMessages;
  assert.ok(out.some(m => m.role === 'user'), '必须还留得住 user 消息');
  assert.ok(out.some(m => m.role === 'assistant' && /结论|结果/.test(String(m.content || ''))),
    'assistant 的实质结论必须留着 —— 这次过滤只该针对 system, 不该误伤对话');
  const lastUser = out.filter(m => m.role === 'user').pop();
  assert.equal(lastUser.content, '读一下 /Users/you/Desktop/pangu',
    '最后一条 user (主人的当前问题) 必须原样保留');
});
