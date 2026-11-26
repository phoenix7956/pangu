// 2026-09-22 regression (session 44008568 实案): 断连轮 → 幻觉续写 → 澄清句记成目标
// 三道新机制的回归守卫 — 任一被删/被改坏即红:
//   ① 断片轮识别 (0工具 + <60字 + 未完成 → ledger 记 interrupted)
//   ② 澄清/疑问句不入账本目标 (recordGoal 换目标要等祈使句)
//   ③ 兜底文案隔离 (断连提示带 _connLost, 组 LLM history 时过滤)
//
// 2026-10-26 第 107 批 (桌面端下线): ③ 那两条断言查的是
// `apps/desktop/src/views/ChatRoom.jsx` —— 前端没了, 一起删。
// ③ 的**服务端那一半** (兜底文案不许混进 assistant 历史) 由
// tests/session-store-runtime-env-20261015.test.js 等服务端守卫继续管;
// 本文件其余六条 (①②④⑤⑥⑦) 全是服务端, 一条没松。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CORE = path.join(__dirname, '..');
const src = (rel) => fs.readFileSync(path.join(CORE, rel), 'utf8');

// ① 断片轮 → interrupted 入账 + 下轮 REVERIFY_FIRST 门禁
const j2 = src('modules/j2_agent_loop.js');
assert.ok(j2.includes("if (!runtimeCompleted && realToolsUsed.length === 0 && String(finalText || '').length < 60)"),
  '① 断片轮识别条件缺失 (0工具 + <60字 + 未完成)');
assert.ok(j2.includes("_runEndStatus = 'interrupted'"),
  '① 断片轮应记 interrupted (而不是 failed/empty)');
assert.ok(j2.includes('[REVERIFY_FIRST]'),
  '① 中断轮续跑缺 REVERIFY_FIRST 强制先工具核验门禁');

// ② 澄清句不入账本目标 — 疑问语气 + 短句不换目标
const ledger = src('modules/task_ledger.js');
assert.ok(ledger.includes('t.length <= 60') && ledger.includes('.test(t.slice(-3))'),
  '② recordGoal 缺澄清/疑问句守卫 — 短疑问句会再被记成新 goal');

// 行为验证: 真跑一遍 recordGoal, 疑问句不得换目标
const tl = require('../modules/task_ledger.js');
const FSID = 'reverify-test-' + Date.now();
tl.recordGoal(FSID, '消化易经 <course-source> 全部资料');
tl.recordGoal(FSID, '你分析的是我给你的图吗？');
const after = tl.loadLedger(FSID);
assert.strictEqual(after.goal, '消化易经 <course-source> 全部资料',
  '② 澄清句被换成了新 goal — 目标栏被污染, 进度卡会注入错误的"不要等主人指示"');
// 祈使句仍可换目标 (守卫不能误伤)
tl.recordGoal(FSID, '重做神煞第 4 轮, 写进 总结.md');
assert.strictEqual(tl.loadLedger(FSID).goal, '重做神煞第 4 轮, 写进 总结.md',
  '② 祈使句换目标被误伤了');

// ④ social-confirm 不入账本目标 — "你现在能看见我了吧" 这类状态确认句不换 goal
const _ledgerSrc4 = src('modules/task_ledger.js');
assert.ok(_ledgerSrc4.includes('social-confirm skip goal') && _ledgerSrc4.includes('_isImperative'),
  '④ recordGoal 缺 social-confirm 守卫 — 状态确认句会再被记成新 goal, 进度卡注入"不要等主人指示"导致答非所问');
// ⑤ answer_alignment.resolveTaskInput 状态确认句短路 — "你现在能看见我了吧" 不走续跑链
const _aaSrc = src('modules/answer_alignment.js');
assert.ok(_aaSrc.includes('_isSocialConfirm') && _aaSrc.includes('看见|看到|听见|听到'),
  '⑤ resolveTaskInput 缺 social-confirm 短路 — 状态确认句会被当普通输入喂给 LLM, 模型答非所问/重新起卦');
// ⑥ session_store 存盘剥 thinking — assistant raw 不应把 thinking 段喂回下一轮 LLM
const _ssSrc = src('modules/session_store.js');
assert.ok(_ssSrc.includes('_stripThinking') && _ssSrc.includes("message.role === 'assistant'"),
  '⑥ session_store.normalizeMessages 缺 thinking 剥除 — assistant raw 把 thinking 段存进 session JSON, 下轮 LLM 看到"已思考过"跳过工具直接复述/重新起卦');
// ⑦ 同问重发识别 — 主人重发同一道题 + 上轮已答实质答案 → 标记【重复提问·已答过】, 基于上轮精炼, 禁止从头重新起卦
const _aaSrc2 = src('modules/answer_alignment.js');
assert.ok(_aaSrc2.includes('_isDuplicateQuestion') && _aaSrc2.includes('【重复提问·已答过】'),
  '⑦ resolveTaskInput 缺同问重发识别 — 主人重发同一道题时盘古从头重新起卦+复述 (session 60273479 灾煞题重发 3 次实案)');
console.log('reverify-interrupted guard test OK (①②④⑤⑥⑦)');
