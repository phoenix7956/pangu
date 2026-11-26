// 2026-09-12 (老板 19:22 实案): 0 工具纯对话轮 (纠正/确认/闲聊) 的实质答复
// 不得判 failed — 聊天不需要工具, 判 failed 前端会盖 ✗ 任务执行失败。
// ⚠️ 开头的诚实熔断文案仍必须 failed。
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classifyRuntimeVerdict } = require('../modules/runtime_verdict');

test('0 工具对话轮: 实质答复 → partial (不再 failed)', () => {
  const v = classifyRuntimeVerdict({
    real_tool_calls_total: 0,
    final_text: '对, <course-source>是 PDF 原档, extracted/ 里那份 txt 是从它抽的文本。',
    alignment_blocked: false,
    task_done_status: null,
  });
  assert.strictEqual(v.status, 'partial');
  assert.strictEqual(v.success, false);  // 不污染 #13 evolution 成功率口径
});

test('0 工具对话轮: ⚠️ 熔断文案 → 仍 failed', () => {
  const v = classifyRuntimeVerdict({
    real_tool_calls_total: 0,
    final_text: '⚠️ [盘古 R80 空计划熔断] 模型连续 3 轮只输出计划模板',
    alignment_blocked: false,
    task_done_status: null,
  });
  assert.strictEqual(v.status, 'failed');
});

test('0 工具对话轮: 超短文本 (<=10) → 仍 failed', () => {
  const v = classifyRuntimeVerdict({
    real_tool_calls_total: 0,
    final_text: '好的',
    alignment_blocked: false,
    task_done_status: null,
  });
  assert.strictEqual(v.status, 'failed');
});

test('工具任务: 有真工具+实质文本 → completed (原有行为不变)', () => {
  const v = classifyRuntimeVerdict({
    real_tool_calls_total: 3,
    final_text: '已读 372 行课件并落盘消化笔记到 digest/<course-source>。',
    alignment_blocked: false,
    task_done_status: null,
  });
  assert.strictEqual(v.status, 'completed');
  assert.strictEqual(v.success, true);
});

test('工具任务: 对齐被拦且无交付文本 → failed (原有行为不变)', () => {
  const v = classifyRuntimeVerdict({
    real_tool_calls_total: 2,
    final_text: '',
    alignment_blocked: true,
    task_done_status: null,
  });
  assert.strictEqual(v.status, 'failed');
});

test('j2_agent_loop 静态守卫: 对话轮解锁块存在 (防回退)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8');
  assert.ok(src.includes('CONVERSATIONAL_UNBLOCK'), '缺 CONVERSATIONAL_UNBLOCK 对话轮解锁块');
  assert.ok(src.includes('_lastBlockedFinal'), '缺 _lastBlockedFinal 被拦原文暂存');
  // 2026-10-18: 条件前面加了 `!_isPlanOnlyTurn &&` (拆解轮不判对齐, 见
  // alignment-skip-planonly-20261018.test.js)。不变量没变 —— realToolsUsed.length > 0
  // 仍在, 其余条件一字未动, 所以这里只允许**前缀**多一个判据, 尾巴逐字钉死。
  // 写成"只要 realToolsUsed 还在就算过"是放水, 不许那么写。
  assert.ok(
    /while \((?:!_isPlanOnlyTurn && )?_alignNudges < 2 && finalAlignmentBlocked && !finalText && !taskDoneAccepted && !_partialDeliveryOk && realToolsUsed\.length > 0\)/.test(src),
    'ALIGNMENT_RETRY 未限工具任务轮 (realToolsUsed.length > 0 掉了, 或条件被改写)');
});

test('j2_agent_loop 静态守卫: 假工具调用文本双层拦截 (老板 19:33 实案, 防回退)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8');
  assert.ok(src.includes('FAKE_TOOLCALL_TEXT'), '缺轮内 FAKE_TOOLCALL_TEXT nudge 守卫');
  assert.ok(src.includes('FAKE_TOOLCALL_FINAL'), '缺终局 FAKE_TOOLCALL_FINAL 保险丝');
  // 假调用文本绝不允许无拦截直进 finalText = textContent 收口 (找守卫之后的第一个收口点)
  const fakeTcGuard = src.indexOf('_FAKE_TC_TEXT_RE');
  const finalAccept = src.indexOf('finalText = textContent;', fakeTcGuard);
  assert.ok(fakeTcGuard > 0 && finalAccept > fakeTcGuard, '假调用守卫必须在文本收口之前');
});

test('j2_agent_loop 静态守卫: 假产出三修复 (老板 20:26 实案, 防回退)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8');
  // 1. FAKE_OUTPUT nudge 耗尽后必须熔断, 不得放行假落盘声称
  assert.ok(src.includes('FAKE_OUTPUT_GUARD: nudge 后仍假产出声称, 熔断'), '假产出 nudge 耗尽后缺熔断');
  // 2. CONVERSATIONAL_UNBLOCK 不得解锁假交付文本
  assert.ok(src.includes('_FAKE_DELIVERY_RE'), '对话轮解锁缺 _FAKE_DELIVERY_RE 假交付排除');
  // 3. verdict 必须在终局决议 (CONVERSATIONAL_UNBLOCK) 之后计算
  const unblockAt = src.indexOf('CONVERSATIONAL_UNBLOCK');
  const verdictAt = src.indexOf('classifyRuntimeVerdict({');
  assert.ok(unblockAt > 0 && verdictAt > unblockAt, 'verdict 必须计算在 CONVERSATIONAL_UNBLOCK 之后');
});

test('j2_agent_loop 静态守卫: 22:24 实案三修 (防回退)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8');
  // 1. 部分放行续跑不得戴 _taskDonePartialOk 帽子 (确认词续轮漏检 → "待主人拍"原地停)
  assert.ok(/if \(taskDoneAccepted && _isPartialSummary\)/.test(src), 'partial 续跑仍戴 _taskDonePartialOk 帽子');
  // 2. 裸标签式假产出声称 ("落盘：/写入:" 无"已"前缀) 必须纳入拦截
  assert.ok(/落盘\|写入\|产出\|交付\)\\s\*\[\:：\]/.test(src), '_FAKE_OUT_RE 缺裸标签落盘声称分支');
  // 3. 对话轮解锁排除清单同步含裸标签分支
  const fakeDelivery = src.match(/_FAKE_DELIVERY_RE = \/([^/]+)\//);
  assert.ok(fakeDelivery && fakeDelivery[1].includes('落盘|写入|产出|交付'), '_FAKE_DELIVERY_RE 未同步裸标签分支');
});


// ============================================================
// 2026-09-13 (老板 00:21/00:30 实案): 四修复防回退
// 实案 A: "未完成, 原因: 路径越界 … 等你拍" 13 工具 0 产出 → 旧 verdict 判 completed
// 实案 B: auto_resumes 会话级计数不清零 → 烧满 3 次后续跑永久死亡, 必须人肉"继续"
// 实案 C: task_done 无 plan 守门 → 跑 1-2 步就交卷 (对照核查 L1)
// 实案 D: invariant 回退壳摘要零内容 → 压缩后丢已核实事实, 信过期地图幻觉路径
// ============================================================

test('verdict: 文本首句自首失败 → 不得 completed (00:30 实案)', () => {
  const v = classifyRuntimeVerdict({
    real_tool_calls_total: 13,
    final_text: '**未完成**, 原因: 路径越界。\n工具链真实返回:\n- 13 次调用已用, 已写文件 = 0\n等你拍。',
    alignment_blocked: false,
    task_done_status: null,
  });
  assert.notStrictEqual(v.status, 'completed', '自首失败文本不得判 completed');
  assert.strictEqual(v.status, 'partial');
  assert.strictEqual(v.success, false);
});

test('verdict: 结尾等主人拍 → 不得 completed (19:18 实案)', () => {
  const v = classifyRuntimeVerdict({
    real_tool_calls_total: 5,
    final_text: '真实进度 2/4 已深读。\n下一步建议 (等主人拍):\nA: 消化刑冲合害\nB: 消化看财方位\n主人拍。',
    alignment_blocked: false,
    task_done_status: null,
  });
  assert.notStrictEqual(v.status, 'completed', '等主人拍不得判 completed');
  assert.strictEqual(v.status, 'partial');
});

test('verdict: 合法消化交付 (完成+下轮计划) → 仍 completed (防误杀)', () => {
  const v = classifyRuntimeVerdict({
    real_tool_calls_total: 14,
    final_text: '【刑冲合害核心体系消化完成】\n读了 2 文件 (188 行), 落盘 5.8KB 总结到 output_files/易经消化_01_刑冲合害.md。\n下轮计划: 继续第一波十神性格总结。',
    alignment_blocked: false,
    task_done_status: null,
  });
  assert.strictEqual(v.status, 'completed');
  assert.strictEqual(v.success, true);
});

test('j2_agent_loop 静态守卫: task_done plan 守门 (对照核查 L1, 防回退)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8');
  assert.ok(src.includes('TASK_DONE_GATE'), '缺 TASK_DONE_GATE plan 守门');
  assert.ok(src.includes('_taskDonePlanBlocked'), '缺 _taskDonePlanBlocked pending 步骤计算');
  assert.ok(src.includes('TASK_DONE_BLOCKED'), '缺 TASK_DONE_BLOCKED 拒收回灌消息');
  // 守门必须在 task_done 验收 (taskDoneAccepted = true) 之前计算
  const gateAt = src.indexOf('_taskDonePlanBlocked = ');
  const acceptAt = src.indexOf('taskDoneAccepted = true;', src.indexOf("tc.name === 'task_done'"));
  assert.ok(gateAt > 0 && acceptAt > gateAt, 'plan 守门必须在验收之前');
});

test('j2_agent_loop 静态守卫: auto_resumes 每请求清零 (00:30 实案, 防回退)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8');
  assert.ok(src.includes('新用户请求, 重置续跑预算'), '缺 auto_resumes 每请求重置块');
  assert.ok(/auto_resumes:\s*0/.test(src), '缺 auto_resumes: 0 重置写盘');
});

test('session_compaction 静态守卫: latest 回退摘要必须带语义内容 (00:30 实案, 防回退)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../modules/session_compaction.js'), 'utf8');
  const fnAt = src.indexOf('generateLatestSummary(messages) {');
  const fnEnd = src.indexOf('generateFullSummary(messages) {', fnAt);
  const body = src.slice(fnAt, fnEnd);
  assert.ok(body.includes('textSummary'), 'latest 摘要缺 textSummary 文本摘要');
  assert.ok(body.includes('lastUser'), 'latest 摘要缺 lastUser 原文片段');
  assert.ok(body.includes('lastAssistant'), 'latest 摘要缺 lastAssistant 原文片段');
});


test('j2_agent_loop 静态守卫: MiniMax 空内容轮熔断 + 被拦原文落证 (老板 12:51 实案, 防回退)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8');
  // 1. 空内容轮必须可见 + 连空 2 轮诚实熔断
  assert.ok(src.includes('EMPTY_CONTENT_ROUND'), '缺 EMPTY_CONTENT_ROUND 空轮日志');
  assert.ok(src.includes('EMPTY-ROUND 熔断'), '缺连空熔断文案');
  assert.ok(src.includes('_emptyContentRounds'), '缺 _emptyContentRounds 计数器');
  // 2. 空轮守卫必须在 SM gate 之前 (空文本过不了 SM 任何规则, 会静默漏到底部 nudge)
  const emptyGuardAt = src.indexOf('EMPTY_CONTENT_ROUND');
  const smGateAt = src.indexOf('_planGate.check({ textContent, toolsUsed, round, maxRounds');
  assert.ok(emptyGuardAt > 0 && smGateAt > emptyGuardAt, '空轮守卫必须在 SM gate 之前');
  // 3. 空 assistant 消息不得入列 (MiniMax 400 chat content is empty)
  const emptyBlock = src.slice(src.indexOf('if (!textContent || !textContent.trim())'), smGateAt);
  assert.ok(!emptyBlock.includes("messages.push({ role: 'assistant', content: '' })"), '空 assistant 消息入列会触发 MiniMax 400');
  // 4. 0 工具终局交付 ⚠️ 模板前必须落被拦原文证据
  assert.ok(src.includes('ALIGNMENT_BLOCKED_DELIVERED'), '缺被拦原文落证日志');
});


test('verdict: "等你指令就接着干" → 不得 completed (14:06 实案, 正则缺口)', () => {
  const v = classifyRuntimeVerdict({
    real_tool_calls_total: 13,
    final_text: '本轮交付 (13 工具调用): A 级 1/7 已交付。\n下一步继续做 A02/A03, 主人给指令就接着干。',
    alignment_blocked: false,
    task_done_status: null,
  });
  assert.notStrictEqual(v.status, 'completed', '"给指令就接着干" 是等指示, 不得判 completed');
  assert.strictEqual(v.status, 'partial');
});

test('j2_agent_loop 静态守卫: 等指示 nudge + 文本收口续跑 (老板 14:06/14:07 实案, 防回退)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8');
  // 1. 等指示 nudge: 主人已拍板 + 0 工具 + 等指示措辞 → 逼直接执行
  assert.ok(src.includes('WAIT_INSTRUCTION_NUDGE'), '缺 WAIT_INSTRUCTION_NUDGE 日志');
  assert.ok(src.includes('WAIT_INSTRUCTION_BLOCKED'), '缺 WAIT_INSTRUCTION_BLOCKED 回灌消息');
  assert.ok(src.includes('_WAIT_INSTRUCTION_RE'), '缺 _WAIT_INSTRUCTION_RE 等指示正则');
  assert.ok(src.includes('_CONTINUATION_INPUT_RE'), '缺 _CONTINUATION_INPUT_RE 拍板输入正则');
  // 2. 等指示 nudge 必须在文本收口 (finalText = textContent) 之前
  const nudgeAt = src.indexOf('WAIT_INSTRUCTION_NUDGE');
  const acceptAt = src.indexOf('finalText = textContent;', nudgeAt);
  assert.ok(nudgeAt > 0 && acceptAt > nudgeAt, '等指示 nudge 必须在文本收口之前');
  // 3. 干活中途文本收口必须先试续跑 (text_final_continue_intent)
  assert.ok(src.includes('text_final_continue_intent'), '缺 text_final_continue_intent 续跑触发点');
  assert.ok(src.includes('_TEXT_CONTINUE_RE'), '缺 _TEXT_CONTINUE_RE 续作文本正则');
});
