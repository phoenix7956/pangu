'use strict';

// Single source of truth for completion across SSE, evolution, outcomes and training.
function classifyRuntimeVerdict(input = {}) {
  const realToolCalls = Number(input.real_tool_calls_total != null
    ? input.real_tool_calls_total
    : (Array.isArray(input.tools_used) ? input.tools_used.filter(n => n !== 'task_done').length : 0)) || 0;
  const text = String(input.final_text || '').trim();
  const taskDoneOnly = Array.isArray(input.tools_used)
    && input.tools_used.length > 0
    && input.tools_used.every(n => n === 'task_done')
    && realToolCalls === 0;
  // 2026-09-17 全修 (#5 指令优先级): 主人明确说"按顺序全做完/全做完/不用等我拍/不需要再问/直接干" → 本轮处于 autoComplete 模式
  // 此时"停下来等你拍"不应判 failed, 也不该让模型每段都停 — 一路推进到真做完。
  // 识别方式: 输入指令(autoComplete 标志由 j2_agent_loop 传入, 它已扫描 owner 原话) 或 final 文本里模型自述在 autoComplete。
  const autoComplete = input.auto_complete === true
    || /按顺序(全部)?(完成|做完|全做完)|全做完|不用等(我|主人)?拍|不需要(再)?(问|拍)|不用再(问|拍)|直接干(就行|吧)?/.test(String(input.user_input || ''))
    || /按顺序(全部)?(做完|完成)|全做完|接着做完|继续做完|全部做完|按主人指令(顺|顺序)续/.test(text) && !/等(你|主人)?拍|等指令|给指令就|听指令/.test(text)  // 2026-09-17 修: 自述 autoComplete 必须不带等待措辞 — SILENT 收口说"等你拍"仍不得判 completed
    || /不需要再(问|拍)|不用再(问|拍)|不用等我(拍|指令)|不需(再)?(问|拍)|直接(干|做)(就行|吧|下去)/.test(String(input.user_input || ''));  // 2026-09-17: 主人"不需要再问我/直接干"指令豁免
  const aligned = input.alignment_blocked !== true && input.final_alignment_blocked !== true;
  // A rejected task_done summary is a rewrite signal, not proof that the
  // underlying work failed. Once a real aligned final exists, only an explicit
  // task_done status of failed should force a failed runtime verdict.
  const taskDoneFailed = input.task_done_status === 'failed';
  const acceptedTaskDone = input.task_done_accepted === true && !taskDoneFailed;
  const executionSucceeded = input.execution_succeeded !== false;
  const verifiedExecution = input.has_verified_execution !== false;
  // 2026-09-13 (老板 00:30 实案): 文本自首失败不得判 completed —
  // "未完成, 原因: 路径越界 … 等你拍" 13 次真工具 0 产出, 旧逻辑判 completed,
  // 前端不亮 ✗, 主人以为跑完了。首句自首失败 / 结尾等主人拍 = 最多 partial。
  const selfDeclaredFail = /^\s*[#>*\s]*(未完成|没完成|未能完成|无法完成|任务失败|搞不定|干不了)/.test(text);
  // 2026-09-16 老板拍 "为什么一直有 任务执行失败": SILENT_FAILURE 诚实收口文案 (进度已落盘, 说继续可断点续跑)
  // 是合法 partial 交付, 不是 failed — 旧逻辑的 waitsUserDecision 正则没覆盖"等等你拍/候选"字样, 把诚实收口判成 failed,
  // 前端盖 "✗ 任务执行失败"。现在: SILENT_FAILURE 标记文案 + 进度已落盘 直接豁免判 failed, 落 partial。
  const isSilentFailureRecoverable = /\[本轮未收口\]|进度已落盘|断点续跑|自动断点续跑/.test(text);
  // 2026-09-17 全修 (#1/#2): "等你拍" 但 (a) 进度已落盘 或 (b) 有明确下一步/待办清单 → 是合法 partial, 不再判 failed。
  // 旧逻辑只要命中"等你拍"就压 waitsUserDecision→partial 之外→failed, 把诚实交代的答复全盖 ✗。
  const hasNextStep = /(下一步|下一批|待办|待续|待你拍|等你?确认|需你?拍|继续推|顺延|收工|等你?拍下一)/.test(text);
  // 2026-09-17 修(二次): waitsUserDecision 回归"纯等待信号" — 文本含等待措辞且非 SILENT_FAILURE 收口就为 true,
  // 不再被 hasNextStep/工具数 抑制。等待措辞继续挡住 completed (防 "下一步建议(等主人拍)" 误判 completed);
  // "不盖 ✗" 由下方 partialRecoverable (hasNextStep+工具数) 兜底 — 等待但可续跑 = partial, 绝不 failed。
  // 2026-09-17 全修: 等待措辞回归为纯信号 (不再被 SILENT/hasNextStep 抑制) — "等你拍/给指令就接着干" 一律挡 completed;
  // SILENT 收口 (进度已落盘) 由 partialRecoverable 兜底 partial, 不再靠压 waitsUserDecision。
  const waitsUserDecision = !autoComplete
    && /(等你拍|等主人拍|等您拍|主人拍[。.？?]|请主人(手动|确认|决定|拍)|需要主人(确认|介入|拍)|等你?指令|给指令就|听指令|待主人拍|拍板)/.test(text);
  // SILENT 收口文案 ("进度已落盘/断点续跑") 明说"没干完" — 永远不得 completed, 顶格 partial。
  // 2026-10-01 修 (16/16 实锤): completed 分支漏了 /^⚠️/ 豁免 — conversational 分支一直有,
  // completed 没有 → 核验门/熔断的诚实失败文案 (⚠️ 已执行相关工具，但最终总结没有通过核验…)
  // 反而被判 completed + success=true。实测 evolution 1324 轮里被门吃掉答案的 16 轮,
  // 100% 被记成 success, 全部进了 evolution 成功桶和训练数据 — 门挡掉的答案反过来
  // 变成"门工作正常"的正样本。豁免后这 16 轮落 partial, success=false。
  const completed = aligned && (realToolCalls > 0 || acceptedTaskDone) && text.length > 0 && !/^⚠️/.test(text) && !taskDoneFailed && executionSucceeded && verifiedExecution && !selfDeclaredFail && !isSilentFailureRecoverable && !waitsUserDecision;
  // 2026-09-16 老板拍: SILENT_FAILURE 诚实收口 (进度已落盘, 可断点续跑) = 合法 partial, 不是 failed。
  // 单独一条: 可恢复收口直接判 partial, 不看 selfDeclaredFail (它开头常带 "未完成")。
  // 2026-09-17 全修: 加 waitsUserDecision 分支 — "等你拍" 但下一步已指明 → 合法 partial, 不盖 ✗ (老板 20:13/20:21 实案)。
  const partialRecoverable = (isSilentFailureRecoverable
    || (waitsUserDecision && hasNextStep && realToolCalls > 0 && aligned)
    || (hasNextStep && realToolCalls > 0 && aligned)) && text.length >= 8;  // SILENT_FAILURE 收口文案常短, 门槛放宽到 8 字
  const partial = !completed && aligned && realToolCalls > 0 && text.length > 10;
  // 2026-09-12 (老板 19:22 实案): 0 工具纯对话轮 (纠正/确认/闲聊) 的实质答复不再判 failed —
  // 聊天不需要工具, 判 failed 会让前端给正常答复盖 ✗。⚠️ 开头的诚实熔断文案仍判 failed。
  // 2026-09-17: "你没再发指令, 我不再喷" / "下一步=主索引更新" 这类 0 工具但有实质收口/计划 的答复 = 合法 partial
  //
  // 2026-10-15 (实测): 门槛 text.length > 10 背后的假设是"短 = 没答完整"。
  // 但主人明说"只回一个词: 盘古"、模型答"盘古" —— 这是**完全正确**的交付,
  // 2 个字刚刚好, 却被判 failed, 前端因此给正确答案盖 ✗ "任务执行失败"。
  // 现场: POST /api/message/stream {"只回一个词: 盘古"} -> final "盘古" 一字不差,
  // 同时 status:"failed" success:false。
  //
  // 这不是长度问题, 是**"主人在这一轮本来就要短的"这个信息被漏看了** ——
  // user_input 一直就在参数里, 只是从没参与这条判断。
  // 所以只在主人明说要短时放宽, 免得把"好的"这种无内容应答也放过去
  // (runtime-verdict-conversational 第 3 项钉着 "好的" 仍 failed, 语义不变)。
  //
  // 同时挡住"前向承诺": 主说要短, 模型却回"我先去看看 / 接下来我会" ——
  // 那是空头支票不是答案, 短也不能算数。
  const askedTerse = /(只回|只答|只说|直接答|一句话|别废话|不要解释|不用解释|简短|简要|一个字)/.test(String(input.user_input || ''));
  const forwardPromise = /^(我先|接下来|下一步|让我|正在|马上|稍等|稍候|我去|我来|将要|准备|这就|这就来)/.test(text);
  const conversational = !taskDoneOnly && !completed && !partial && aligned && realToolCalls === 0
    && (text.length > 10 || (askedTerse && text.length > 0 && !forwardPromise))
    && !taskDoneFailed && executionSucceeded && !/^⚠️/.test(text);
  return { status: completed ? 'completed' : (partial || partialRecoverable || conversational) ? 'partial' : 'failed', success: completed, real_tool_calls_total: realToolCalls };
}

module.exports = { classifyRuntimeVerdict };
