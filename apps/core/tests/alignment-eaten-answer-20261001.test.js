// 2026-10-01 回归测试 — session desktop-1790528544341 (9/30 20:14) 答案被核验门吃掉的那一轮。
//
// 事故链: 盘古调了 1 次工具后产出了 496 tokens 的实质答案, alignment 门把它清空 →
//   用户只看到 "⚠️ 已执行相关工具，但最终总结没有通过核验。", 且该轮被 runtime_verdict
//   记成 completed/success=true (16/16 同类轮次全部污染 success 桶)。
//
// 本文件锁住四处修复, 每条都对应上面因果链的一个环节。
const assert = require('assert');
const aa = require('../modules/answer_alignment');
const { classifyRuntimeVerdict } = require('../modules/runtime_verdict');

// 9/30 20:14:17 那一轮 evolution 记录里的真实注入 input (截断到注入块为止, 足够复现)
const REAL_INPUT = '字幕製作人Zither Harp\n\n【重复提问·已答过】主人重发了同一道题 (字幕製作人Zither Harp...), '
  + '你上一轮已给出实质答案。本轮基于上轮答案精炼/补全/直接确认, 禁止从头重新起卦、禁止重读已读过的文件、'
  + '禁止重复上轮全文。上轮答案开头: 收到，通道在。\n\n现状没变：第 4 题仍悬（配偶宫冲月令，A/B/C/D 四个断法我前后翻过两次，没定论），'
  + '等你一句课堂原话就锁；不给就按 D 交。其余六题答案已定稿。';

// ── 修 1: 「上一轮」不再在答案侧灭口 ────────────────────────────────────────────
// 原 bug: 注入器在**问题**里连喂两次「上一轮」, TRANSCRIPT_LEAK 却在**答案**侧禁这个词。
// 系统先叫模型说、再禁止模型说。同一答案只差两字就翻盘。
{
  const withPrevRound = '上一轮我给的六题答案是 1-ABC、2-C、3-A，第 4 题仍悬（配偶宫冲月令）。'
    + '本轮只补第 4 题：丑未冲在月令，主流断法是关系被动摇、聚少离多，按 D 交。'
    + '戊午 己未 丁丑 庚子 乾造，身弱喜木火忌土金。';
  const guarded = aa.guardAnswer(REAL_INPUT, withPrevRound, '', '');
  assert.strictEqual(guarded.blocked, undefined, '答案里的「上一轮」不该再被判编排泄漏而清空');
  assert.strictEqual(guarded.aligned, true);
  assert.match(guarded.text, /第 4 题仍悬/);
}
// 门不能被削废: 「上一轮」+「下一步」同现 (hits>=2) 仍须拦下
{
  const chatter = '上一轮我已经把文件都写好了。下一步我继续排查剩下的接口，然后等你拍。';
  assert.strictEqual(aa.isOrchestrationLeak(chatter), true, '「上一轮」+「下一步/等你拍」仍应判编排泄漏');
}
// 长答案 + 足量具体证据 → 走 concrete>=3 豁免, 不因一个时间指代整篇被拒
{
  const rich = '上一轮已定 1-ABC、2-C、3-A、5-B、6-C、7-B。依据：戊午 己未 丁丑 庚子 乾造，身弱喜木火忌土金水；'
    + '丑未冲在月令为力量最大之一冲；子午冲动根；子丑六合化土，财入库即被土泄。'
    + '详见 /Users/you/Desktop/course-source/<course-source>.txt:120 与 apps/core/modules/j2_agent_loop.js:3131。';
  assert.strictEqual(aa.isOrchestrationLeak(rich), false, 'concrete>=3 的长答案应走豁免');
  assert.strictEqual(aa.isOrchestrationLeak('下一步我先查一下日志再说'), true, '短编排话术仍须拦');
}

// ── 修 2: guardAnswer 证据参数位置 ────────────────────────────────────────────
// 原 bug: j2_agent_loop 只传 3 参, _evidenceText() 落进 fallback 槽, evidenceText 恒为 ''。
// 后果: (a) hasArtifactEvidence(answer,'') 开头 return false → 证据通道全死;
//       (b) 整份 transcript 变成 fallback 候选 → 把 raw tool_result 当答案返回。
{
  const evidence = 'tool_result: 1-ABC 2-C 3-A 5-B tool_result 字节 1206 行 285 '
    + '文件 /Users/you/Desktop/course-source/<course-source>.txt';
  const grounded = '已核实 6 题答案定稿，其中 1-ABC 2-C 3-A 5-B 有 tool_result 支撑，共 1206 字节 285 行。';
  // 4 参 (证据走第 4 参) → 证据锚定生效
  assert.strictEqual(aa.guardAnswer(REAL_INPUT, grounded, '', evidence).aligned, true,
    '证据串走第 4 参时, 锚定 tool_result 的答案应判对齐');
  // 答非所问 + 证据 → 仍须拦, 且**绝不能**把证据原文当答案吐出来
  const offTopic = '今天天气不错，我们去公园散步吧，顺便聊聊最近的新闻。';
  const g = aa.guardAnswer(REAL_INPUT, offTopic, '', evidence);
  assert.strictEqual(g.blocked, true, '答非所问须拦');
  assert.ok(!/^tool_result/.test(String(g.text || '')), '拦截时不得把原始工具输出当答案返回');
  // 锁住调用约定: fallback 传空 → 无泄漏面。旧代码把 transcript 塞进 fallback 的行为不得回来。
  assert.strictEqual(String(aa.guardAnswer(REAL_INPUT, offTopic, '', evidence).text).startsWith('tool_result'), false,
    '拦截时返回的必须是拦截文案, 不是 tool_result 原文');
  assert.strictEqual(String(aa.guardAnswer(REAL_INPUT, offTopic, '', evidence).text).startsWith('tool_result'), false);
}

// ── 修 3: runtime_verdict 不得把 ⚠️ 失败文案记成 success ──────────────────────
{
  const fallbackText = '⚠️ 已执行相关工具，但最终总结没有通过核验。\n'
    + '原始命令和 OCR 结果已保留在工具记录中，不会当作聊天答复。请重新执行该任务以生成可核验的总结。';
  const v = classifyRuntimeVerdict({
    real_tool_calls_total: 1, tools_used: ['list_pangu_agents'], final_text: fallbackText,
    alignment_blocked: false, task_done_accepted: false, execution_succeeded: true,
  });
  assert.strictEqual(v.success, false, '⚠️ 核验失败文案不得判 success=true');
  assert.notStrictEqual(v.status, 'completed', '⚠️ 核验失败文案不得判 completed');
  // 正常实质答复不受影响
  const ok = classifyRuntimeVerdict({
    real_tool_calls_total: 1, tools_used: ['read_file'],
    final_text: '已核实 6 题答案定稿，第 4 题仍悬，等课堂原话锁死。',
    alignment_blocked: false, execution_succeeded: true,
  });
  assert.strictEqual(ok.success, true, '正常答复仍应判 success');
  assert.strictEqual(ok.status, 'completed');
}

// ── 修 4: 注入的"上轮答案开头"不能是陈旧/残片的 ──────────────────────────────
// 原 bug: 只认 length>100 的 assistant → 上轮答复 <100 字时被跳过, 捞到更早的陈旧答复;
//          再叠 slice(0,200) 硬截 → 切在工具调用碎片中间。
{
  const longEarlier = '选择题定稿 1-ABC 2-C 3-A 4-B。第 4 题丑未冲在配偶宫，力量最大，'
    + '主流断法是关系被动摇、聚少离多，按 D 交。戊午 己未 丁丑 庚子 乾造，身弱喜木火忌土金水。';
  const truePrevious = '通道正常，我在。\n\n第 4 题还悬着，等你一句课堂原话就锁死；没有就按 D 交。';
  // 2026-10-12: fixture 改成**真·原样重发**(上一条 user 与本轮 raw 同句, 末条是客户端
  // 追加的本轮)。旧 fixture 把本轮当"上一轮"来触发判重 —— 那是 75738498 的 bug 本尊
  // (判重拿本轮跟 messages 最后一条=本轮自己比, 相似度恒 1.0), 已于 2026-10-12 修掉。
  // 本块真正要守的是 _prevAnswerDigest 挑哪条答复, 与判重触发机制无关。
  const msgs = [
    { role: 'user', content: '第十一节作业' },
    { role: 'assistant', content: longEarlier },
    { role: 'user', content: '字幕製作人Zither Harp' },
    { role: 'assistant', content: truePrevious },
    { role: 'user', content: '字幕製作人Zither Harp' },
  ];
  const out = aa.resolveTaskInput('字幕製作人Zither Harp', msgs);
  const digest = String(out.split('上轮答案开头: ')[1] || '').trim();
  assert.ok(digest.startsWith('通道正常'), '应取真正上一轮答复, 而不是被跳过的陈旧长答复');
  assert.ok(!digest.startsWith('选择题定稿'), '不应误取更早的陈旧答复');
  // 残片: 工具调用文本被硬切进来的尾巴
  assert.ok(!/课程资料/.test(digest) && !/ng\/Desktop/.test(digest), '注入摘要里不该出现工具调用残片');
  // ⚠️ 失败文案不该被当成"上轮实质答复"引用
  const withFail = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: longEarlier },
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: '⚠️ 已执行相关工具，但最终总结没有通过核验。' },
    { role: 'user', content: 'q3' },
  ];
  const outFail = aa.resolveTaskInput('q3', withFail);
  const d2 = String(outFail.split('上轮答案开头: ')[1] || '');
  // 先确认注入块真的触发了 —— 否则下面两条断言会因为 d2 为空而空过 (守卫形同虚设)
  assert.ok(outFail.includes('上轮答案开头: '), '⚠️ fixture 必须真的触发【重复提问】注入, 否则本组断言空过');
  assert.ok(d2.includes('选择题定稿'), '⚠️ 场景应回退到更早的实质答复, 而不是失败文案');
  assert.ok(!d2.includes('没有通过核验'), '⚠️ 失败文案不得被当作上轮实质答复注入');
}

// ── 修 5: 对齐门判的 question 不能是注入指令本身 ──────────────────────────────
// 原 bug: userInput 已被 resolveTaskInput 拼进【重复提问·已答过】"禁止从头重新起卦/
// 禁止重读已读过的文件/禁止重复上轮全文"等指令措辞, terms() 全算成问题词, 真实答案永不命中。
{
  const q = aa.alignmentQuestion(REAL_INPUT);
  assert.ok(!q.includes('禁止重复上轮全文'), '指令措辞不该留在对齐问题里');
  assert.ok(!q.includes('【重复提问·已答过】'), '注入块标记不该留在对齐问题里');
  assert.ok(q.startsWith('字幕製作人Zither Harp'), '主人原话必须保留');
  assert.ok(q.includes('配偶宫冲月令'), '上轮答案开头这个真实上下文载荷必须保留 (丢了门会收得过严)');
  // 无注入的普通输入原样返回
  assert.strictEqual(aa.alignmentQuestion('把排盘页面补上出生地'), '把排盘页面补上出生地');
  // 续跑/顺序指令块同样剥掉
  const ackQ = aa.alignmentQuestion('把排盘页面补全' + '\n\n【用户确认】继续执行上一条任务' + '\n【续跑约束】这是同一任务的续跑：直接从上次未完成处继续调用工具。');
  assert.strictEqual(ackQ, '把排盘页面补全', '【用户确认】/【续跑约束】应被剥掉');
  // 【上轮待办】是真实上下文, 保留
  const todoQ = aa.alignmentQuestion('继续' + '\n\n【上轮待办】拉黑 dead 模型');
  assert.ok(todoQ.includes('拉黑 dead 模型'), '【上轮待办】载荷应保留');
}

// ── 修 6/7: 重答要计 token + 被吃答案要留痕 (源码级断言) ──────────────────────
// 这两条都在 _runAgentLoop 闭包里, 无法纯函数化; 本仓库 task-checkpoint-resume.test.js 已有同款源码断言惯例。
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  // 修 6: ALIGNMENT_RETRY 的重答调用必须进 metrics, 否则面板少算这两次烧的 token
  const retryBlock = src.slice(src.indexOf('while (_alignNudges < 2'), src.indexOf('const _toolEvidenceMessages'))
  assert.ok(retryBlock.includes('recordTokenUsage'), 'ALIGNMENT_RETRY 重答必须记 token 用量');
  assert.ok(retryBlock.includes('_retryResult'), '重答结果须留引用以便取 usage');
  // 修 7: 被吃答案必须落盘, 否则事后无法证明命中了哪条规则
  assert.ok(src.includes('alignment-blocked.jsonl'), '被拦答案须落审计文件');
  assert.ok(src.includes('blocked_final'), '审计记录须含被拦原文');
  assert.ok(src.includes("alignment_question: _alignmentQuestion(userInput)"), '审计须记当时的对齐问题');
  const fbIdx = src.indexOf('const _noSummaryFallback');
  // 2026-10-24 (第 74 批): 原来这里 pin 的是字面量 `_auditBlocked('no_summary_fallback')`。
  // 第 74 批把 reason 改成**参数** (一次执行只记一笔账, 原来记两笔) ⇒ 字面量没了,
  // 但**意图不变**: fallback 分支必须触发审计。
  // 改法是断言**行为**而不是钉死某个字符串 —— 钉死字符串 = 给实现细节立碑,
  // 改对了反而红 (本仓库 tool-thrash-guard / tool-result-fidelity 已经吃过这个亏)。
  const fbBlock = src.slice(fbIdx, fbIdx + 400);
  assert.match(fbBlock, /_auditBlocked\(/,
    'fallback 分支须触发审计 (_auditBlocked 必须在 _noSummaryFallback 里)');
  assert.match(fbBlock, /_noSummaryFallback\s*=\s*\(reason\)/,
    'reason 走参数 —— 一次执行只记一笔账, 按 reason 统计才不会翻倍');
}

// ── 修 8: 收口安全网 — 被"强逼工具"劫持的纯对话轮不该比不注入还差 ──────────────
// 完整事故链 (从 ~/.pangu-data/sessions 真实会话存储还原):\</text>
//   主人发"字幕製作人Zither Harp" (只是句备注) → 模型第 1 轮给出 81 字**正常答复** →</</text>
//   循环里"强逼 LLM 调工具"分支直接 continue, 从不写 finalText → 注入"请调用一个工具完成任务" →</</text>
//   模型调了毫不相干的 list_pangu_agents → realToolsUsed=1 → 收口条件成立 → 第 3 轮被门拦 → ⚠️ 模板。
// 净效果: 明明第 1 轮就答对了, 主人收到的却是"最终总结没有通过核验"。
{
  // 真实注入 input + 真实第 1 轮答复 (逐字取自会话存储, 不做美化)
  const realSpoken = '`字幕製作人 Zither Harp` —— 署名，记下了。这是《易经》课程视频的字幕署名，和第 11 课作业无关。\n\n作业仍等第 4 题定论：不给我按 D 交。';
  const realQ = '字幕製作人Zither Harp\n\n【重复提问·已答过】主人重发了同一道题 (字幕製作人Zither Harp...), 你上一轮已给出实质答案。'
    + '本轮基于上轮答案精炼/补全/直接确认, 禁止从头重新起卦、禁止重读已读过的文件、禁止重复上轮全文。'
    + '上轮答案开头: 收到，通道在。\n\n现状没变：第 4 题仍悬（配偶宫冲月令，A/B/C/D 四个断法我前后翻过两次，没定论），'
    + '等你一句课堂原话就锁；不给就按 D 交。其余六题答案已定稿。ng/Desktop/<course-source>/<course-file>` 里搜。';
  const recovered = aa.guardAnswer(aa.alignmentQuestion(realQ), realSpoken, '', 'tool_result: {\"count\":8,\"agents\":[{\"name\":\"executor\"}]}');
  assert.ok(!recovered.blocked, '第 1 轮那句正常答复必须能过对齐门, 否则安全网救不回 9/30 那轮');
  assert.match(recovered.text, /署名，记下了/);
  // 源码级: 安全网必须真的在收口路径上, 而不是只存在于我脑子里
  const loopSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  assert.ok(loopSrc.includes('BEST_SPOKEN_RECOVERY'), '收口落空须尝试复用模型已说过的实质答复');
  assert.ok(loopSrc.includes('_bestSpoken'), '须从 messages 里回收本轮已说出的文本');
  // 回收的必须是"说过的话", 不能把系统护栏/失败模板当成答案
  assert.ok(loopSrc.includes("!/^⚠️/.test(t)"), '⚠️ 失败模板不得被当成可回收答复');
  assert.ok(loopSrc.includes("!/^\\[SYSTEM/.test(t)"), '[SYSTEM 护栏文案不得被当成可回收答复');
}

console.log('alignment-eaten-answer-20261001 tests: ok');
