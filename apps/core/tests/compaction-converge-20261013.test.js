'use strict';
// 2026-10-13 压缩活锁 —— 压到「正好等于阈值」等于没压, 子 agent 永远收不了尾
//
// 线上现场 (resume-live-1791875186#sub-0-executor, 探针 probe_resume 第一轮跑了
// 18 分钟不结束, 每 5~6 分钟把同一批 a1/a2/a3 重写一遍):
//   [j2-auto-resume] compact ...: 16 -> 14 msgs (reason=native_maxRounds_reached, resume #3/3)
//   [j2-auto-resume] compact ...: 16 -> 14 msgs (reason=native_maxRounds_reached, resume #1/3)
//   [j2-auto-resume] compact ...: 16 -> 14 msgs (reason=native_maxRounds_reached, resume #2/3)
//   [j2-budget]     force-compact ...: 16 -> 14 msgs
//   [j2-auto-resume] compact ...: 16 -> 14 msgs (reason=native_maxRounds_reached, resume #3/3)
//   …… 计数 #3/3 之后又从 #1/3 开始, 永远循环
//
// 根因:
//   1) shouldCompact 判的是 `messageCount >= messageThreshold`, 而压缩产物的下限是
//      「1 条摘要 + ≤8 条注入 system + maxRetainedMessages(20) + 最后一条 user」,
//      **可以大于阈值**。阈值 14 时保留 20 条 recent, 数学上必然压不到 14 以下 ——
//      压完正好卡在阈值上, 下一轮立刻又满足触发条件。
//   2) j2_agent_loop 的预算续命无条件调 budget.resetRoundsAfterCompaction 把轮次预算清零,
//      所以「压缩没解决任何问题」也会拿到新额度, 活锁就没有刹车。
//
// 真正的不变量不是「压完变短」, 而是「压完 shouldCompact 必须是 false」——
// 只要压完还会立刻触发, 下一轮就会再压一次。这条才是测试该锁的。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createCompactor } = require('../modules/session_compaction');

const ROLE_PROMPT = '# 你是盘古的 Executor（执行者）。职责：写文件、改文件、运行命令。';
const ENV_PROMPT = '[运行环境 — 路径铁律] 主机: x.local | 平台: darwin/arm64 | 真 home: /Users/you';

// 真实形状: 注入的 system 提示占多数, 中间夹真正的 user/assistant/tool 回合
function buildConversation(rounds) {
  const msgs = [];
  for (let i = 0; i < 8; i++) msgs.push({ role: 'system', content: ROLE_PROMPT });
  for (let i = 0; i < 12; i++) msgs.push({ role: 'system', content: ENV_PROMPT });
  msgs.push({ role: 'user', content: '主人当前的问题: 把 a1/a2/a3 写完并核对' });
  for (let i = 0; i < rounds; i++) {
    msgs.push({ role: 'system', content: '[自动续跑] objective_incomplete, 第 ' + i + ' 次。' });
    msgs.push({
      role: 'assistant', content: '',
      tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'write_file', arguments: '{"p":"a' + i + '.txt"}' } }],
    });
    msgs.push({
      role: 'tool', content: JSON.stringify({ ok: true, data: 'x'.repeat(400) }),
      tool_call_id: 'c' + i, tool_name: 'write_file',
    });
    msgs.push({ role: 'assistant', content: '第 ' + i + ' 轮结论文字' });
  }
  msgs.push({ role: 'user', content: '继续, 把没做完的做完' });
  return msgs;
}

// 主人问题在**最前面**, 后面全是工具回合 —— 现实中就是这样: 问题问完,
// 后面几十轮都是读写工具。这个形状才能区分 mustKeep 里那条 lastUser:
// 问题离末尾超过 maxRetainedMessages(20), 反向填充循环根本捞不到它,
// 只有显式 mustKeep 才留得住 (上一版夹具把问题放在末尾, 变异打不红)。
function buildQuestionFirstConversation(rounds) {
  const msgs = [];
  msgs.push({ role: 'system', content: ROLE_PROMPT });
  msgs.push({ role: 'user', content: '主人当前的问题: 把 a1/a2/a3 写完并核对' });
  for (let i = 0; i < rounds; i++) {
    msgs.push({ role: 'system', content: '[自动续跑] objective_incomplete, 第 ' + i + ' 次。' });
    msgs.push({
      role: 'assistant', content: '',
      tool_calls: [{ id: 'q' + i, type: 'function', function: { name: 'write_file', arguments: '{"p":"a' + i +'.txt"}' } }],
    });
    msgs.push({
      role: 'tool', content: JSON.stringify({ ok: true, data: 'x'.repeat(400) }),
      tool_call_id: 'q' + i, tool_name: 'write_file',
    });
    msgs.push({ role: 'assistant', content: '第 ' + i + ' 轮结论文字' });
  }
  return msgs;
}

// 只隔离消息数这一个条件: token/时间阈值开到不可能触发
function opts(threshold) {
  return { messageThreshold: threshold, tokenThreshold: 1e9, timeThreshold: 1e9 };
}

test('阈值低于压缩下限时, 压完必须立刻不再满足触发条件 (否则活锁)', async () => {
  const c = createCompactor(opts(14));
  c.register('conv-1', buildConversation(6));
  assert.equal(c.shouldCompact('conv-1'), true, '前置条件: 压之前确实该触发');

  const out = await c.compact('conv-1');

  assert.ok(out.compactedMessages.length < 14,
    '压完还是 ' + out.compactedMessages.length + ' 条 (>= 阈值 14), 等于没压');
  assert.equal(c.shouldCompact('conv-1'), false,
    '压完 shouldCompact 还是 true → 下一轮必然再压一次, 这就是活锁的定义');
});

test('收敛时不能牺牲不变量: 最后一条 user 与至少一条非 system 必须留着', async () => {
  const c = createCompactor(opts(14));
  // 问题在最前面: 它离末尾 19 条, 反向填充捞不到, 只有显式 mustKeep 留得住
  c.register('conv-2', buildQuestionFirstConversation(6));

  const out = await c.compact('conv-2');
  const kept = out.compactedMessages;

  assert.ok(kept.some(m => m.role === 'user' && m.content === '主人当前的问题: 把 a1/a2/a3 写完并核对'),
    '主人当前的问题不许被裁掉 (丢了就会退化成让模型自由发挥)');
  assert.ok(kept.some(m => m.role !== 'system'),
    '至少要留一条非 system 消息, 否则上游会 400 chat content is empty');
  assert.ok(kept.some(m => m.isCompactionSummary),
    '压缩摘要必须在, 否则等于把历史删了而不是压缩');
});

test('正常阈值下不许过度裁剪 (别为了收敛把好好的上下文砍光)', async () => {
  const input = buildConversation(6);
  const c = createCompactor(opts(90));
  c.register('conv-3', input);

  const out = await c.compact('conv-3');
  const kept = out.compactedMessages;

  // 2026-10-15: 这条断言原来写的是 `kept.length >= 23`, 看着是「不许砍光」, 实际上
  // **那 23 条里 22 条是 system, 其中 14 条是逐字重复的 ROLE_PROMPT/ENV_PROMPT,
  // 真正的 assistant 结论一条都没有** (修前实测: byRole={system:22, user:1})。
  // 也就是说它把「重复注入」当成了「上下文保留」在计数 —— 断言本身在给 bug 背书。
  // 根因: scoreMessages 给每条 system 固定 +10 (user +3 / assistant +2), 注入块超长再 +2,
  // 于是重要度排序的前 N 名全是注入提示, 保留名额被它们吃光, 对话一条留不下。
  // 现在排名池排除 system (由 keepSystemMessages 分支统一去重后保留), 修后实测 17 条:
  //   byRole={system:9, user:2, assistant:6} —— 6 条结论全在, system 无重复。
  // 所以「不许砍光」要按**内容**判, 不按条数判: 结论文字和当前问题必须还在。
  const keptAssistant = kept.filter(m => m.role === 'assistant' && /轮结论文字/.test(String(m.content || '')));
  assert.ok(keptAssistant.length >= 3,
    '真正干活留下的 assistant 结论只剩 ' + keptAssistant.length + ' 条 —— 那才叫砍光');
  assert.ok(kept.some(m => m.role === 'user' && m.content === '继续, 把没做完的做完'),
    '最后一条 user 必须留着');

  // 重复注入必须压掉: 8 份逐字相同的 ROLE_PROMPT 压完只能剩 1 份。
  // 这跟「不许砍光」不冲突 —— 重复的第 2~8 份不带任何新信息, 删掉不是砍上下文。
  const roleCopies = kept.filter(m => String(m.content || '') === ROLE_PROMPT).length;
  const envCopies = kept.filter(m => String(m.content || '') === ENV_PROMPT).length;
  assert.equal(roleCopies, 1, '8 份相同的角色提示压完还剩 ' + roleCopies + ' 份');
  assert.equal(envCopies, 1, '12 份相同的环境铁律压完还剩 ' + envCopies + ' 份');
  assert.equal(c.shouldCompact('conv-3'), false);

  // 低阈值侧: 收敛裁剪要「刚好压到阈值以下」, 不是只留必留项 —— 实测 23 -> 13 (阈值 14)
  const c2 = createCompactor(opts(14));
  c2.register('conv-3b', input);
  const out2 = await c2.compact('conv-3b');
  const kept2 = out2.compactedMessages;
  const kept2Assistant = kept2.filter(m => m.role === 'assistant' && /轮结论文字/.test(String(m.content || '')));
  assert.ok(kept2Assistant.length >= 1,
    '低阈值下 assistant 结论一条不剩 (只留 ' + kept2.length + ' 条) —— 那不叫压缩叫删除');
  assert.ok(kept2.some(m => m.isCompactionSummary), '压缩摘要必须在, 否则等于把历史删了');
  assert.equal(c2.shouldCompact('conv-3b'), false);
});

// 端到端那条走 smart 选取分支时, user 消息本身就会被选进去, mustKeep 被掩盖 ——
// 所以必须**直接**测这个 helper, 否则「不保 lastUser」这个变异打不红。
test('helper 直测: 离末尾很远的最后一条 user 也必须被保住', () => {
  const c = createCompactor(opts(8));
  const QUESTION = '主人当前的问题: 把 a1/a2/a3 写完并核对';
  const compacted = [
    { role: 'system', content: '【会话摘要】{"type":"smart"}', isCompactionSummary: true },
    { role: 'system', content: ROLE_PROMPT },
    { role: 'system', content: ENV_PROMPT },
    { role: 'user', content: QUESTION },              // 位置 3, 离末尾很远
    { role: 'assistant', content: '第 0 轮结论' },
    { role: 'assistant', content: '第 1 轮结论' },
    { role: 'assistant', content: '第 2 轮结论' },
    { role: 'assistant', content: '第 3 轮结论' },
    { role: 'assistant', content: '第 4 轮结论' },
    { role: 'assistant', content: '第 5 轮结论' },
    { role: 'assistant', content: '第 6 轮结论' },
    { role: 'assistant', content: '第 7 轮结论' },
    { role: 'assistant', content: '第 8 轮结论' },
    { role: 'assistant', content: '第 9 轮结论' },
  ];
  const original = compacted.slice();

  const out = c._clampBelowThreshold(compacted, original);

  assert.ok(out.length < 8, '必须压到阈值 8 以下, 实际 ' + out.length);
  assert.ok(out.some(m => m.role === 'user' && m.content === QUESTION),
    '离末尾很远的最后一条 user 被裁掉了 —— 它是主人正在问什么, 丢了就退化成让模型自由发挥');
  assert.ok(out.some(m => m.isCompactionSummary), '压缩摘要必须留');
  assert.ok(out.some(m => m.role !== 'system'), '至少留一条非 system');
});

test('结构守卫: _clampBelowThreshold 必须真的挂在 compact() 的返回路径上', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'session_compaction.js'), 'utf8');
  const start = src.indexOf('async compact(sessionId');
  assert.ok(start > 0, '找不到 compact 方法');
  const end = src.indexOf('\n  /**', start);
  const body = src.slice(start, end > 0 ? end : start + 6000);

  assert.match(body, /_clampBelowThreshold\(compactedMessages/,
    '函数定义了但没在 compact() 里调用 —— 等于没修 (上次就是被这个坑过)');
});

test('结构守卫: 预算续命必须被「压缩是否真的收敛」把门', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  const start = src.indexOf('const _budgetCheck = budget.recordRound');
  assert.ok(start > 0, '找不到预算检查锚点');
  const body = src.slice(start, start + 4000);

  assert.match(body, /_converged/,
    '预算续命没有「压缩是否收敛」的判据 —— 压不动也照样清零轮次预算, 活锁没有刹车');
  assert.match(body, /_converged\s*\n?\s*\?\s*budget\.resetRoundsAfterCompaction/,
    'resetRoundsAfterCompaction 必须被 _converged 把门, 不能无条件调用');
});
