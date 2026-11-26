'use strict';
// OpenAI 原生 tool_calls 配对清洗 —— 唯一真源。
//
// 上游对「配不上对」零容忍, 两种形状都直接 400:
//   ① 孤儿 tool result (role:'tool' 的父 assistant.tool_calls 被切掉)
//      → "tool result's tool id not found"
//   ② 反向: assistant 带 tool_calls 却没有对应 tool 结果
//      → "an assistant message with 'tool_calls' must be followed by tool messages"
//
// session_compaction 的压缩产物从 2026-09-12 起就过这一关 (_sanitizeToolPairing)。
// 2026-10-13 发现**子 agent 的上下文截断没过**: truncateMessages 只按条数切尾巴,
// 切完父 assistant 没了、tool 结果还在 —— 于是「子 agent 用原生工具」这条链一超预算就 400,
// 表现正是老板说的「子 agent 调用也一直有问题」。同一类 bug 同一个解法, 所以抽成唯一真源。
//
// 纯函数, 不打日志 (调用方决定要不要报)。
function sanitizeToolPairing(messages) {
  const list = Array.isArray(messages) ? messages : [];

  // 有结果的 tool_call_id
  const resultIds = new Set();
  for (const m of list) {
    if (m && m.role === 'tool') {
      const id = m.tool_call_id || m.tool_callId;
      if (id) resultIds.add(id);
    }
  }

  // pass1: assistant.tool_calls 只留有结果的; 全没配对就剥掉 tool_calls 字段,
  //        连空 content 一起整条丢 (留一条"有调用没结果"的 assistant 一样 400)
  const survivingIds = new Set();
  const pass1 = [];
  let stripped = 0;
  let droppedAssistant = 0;
  for (const m of list) {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const kept = m.tool_calls.filter(tc => tc && tc.id && resultIds.has(tc.id));
      if (kept.length === 0) {
        stripped++;
        const hasText = typeof m.content === 'string'
          ? m.content.trim()
          : (m.content && JSON.stringify(m.content).length > 4);
        if (hasText) pass1.push({ ...m, tool_calls: undefined });
        else droppedAssistant++;
        continue;
      }
      if (kept.length !== m.tool_calls.length) stripped++;
      for (const tc of kept) survivingIds.add(tc.id);
      pass1.push(kept.length === m.tool_calls.length ? m : { ...m, tool_calls: kept });
      continue;
    }
    pass1.push(m);
  }

  // pass2: 丢掉配不上对的 tool result
  let droppedTool = 0;
  const out = pass1.filter(m => {
    if (m && m.role === 'tool') {
      const id = m.tool_call_id || m.tool_callId;
      if (id && !survivingIds.has(id)) { droppedTool++; return false; }
    }
    return true;
  });

  return { messages: out, stats: { droppedTool, stripped, droppedAssistant } };
}

// ─────────────────────────────────────────────────────────────────────────────
// 让每个 assistant.tool_calls 后面**紧跟**它自己的 tool 结果 (2026-10-25 第 85 批)
//
// 上游契约 (OpenAI / MiniMax 都一样): tool 结果消息必须**紧跟**发起它的那条
// assistant 消息。中间夹一条 system/user, 上游就报:
//   HTTP 400 invalid params, tool call result does not follow tool call (2013)
// ⇒ 整轮作废, 那一刀直接死。
//
// 现场 (会话 probe84-fixed 的刀2, ~/.pangu-data/sessions/probe84-fixed_sub-2-li.json
//       逐条取证, 索引 26-30):
//   26 assistant  tool_calls=[exec_command×2]
//   27 system     [DUPLICATE-CALL-BLOCKED]   ← 本地守门的话
//   28 system     [HARD] / [HARD-LOOP]       ← 本地守门的话
//   29 tool       (exec_command 的结果)
//   30 tool       (exec_command 的结果)
// ⇒ 两条**本地守门提示**插在了 assistant 和它的结果中间 → 上游 400
//   → 那一刀的 summary 调用死了 → runtimeStatus=partial → 主人收到 partial。
//
// 为什么这是「上游的锅」也是「盘古的锅」:
//   上游按契约拒收没错; 但**那些 system 提示是盘古自己插进去的** ——
//   守门想说「别再重复调这个工具」, 说的时机选错了: 应该等结果回灌完再说,
//   不该挤在 assistant 和结果中间。
//
// 修法 (两层):
//   ① 根修 (j2_agent_loop.js): 守门提示**推迟**到 tool 结果回灌之后再 push。
//   ② 网 (llm_caller.js, 唯一真源这里): 每次发请求前过一遍本函数,
//      把夹在中间的消息挪到那批结果**之后** —— 顺序不变, 语义不变
//      (「先看结果, 再看守门的话」比「先看守门的话, 结果还没到」更对)。
//
// 纯函数, 不打日志 (调用方决定要不要报)。
function enforceToolResultAdjacency(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return { messages: list, moved: 0 };

  const out = [];
  let moved = 0;
  let i = 0;
  while (i < list.length) {
    const m = list[i];
    out.push(m);
    i++;
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) continue;

    // 这一条 assistant 期望哪些结果
    const need = new Set();
    for (const tc of m.tool_calls) if (tc && tc.id) need.add(tc.id);
    if (!need.size) continue;

    // 往后扫: 找它的结果, 顺手记下夹在中间的东西
    const found = [];
    const gap = [];
    const scanStart = i;
    let j = i;
    while (j < list.length && need.size) {
      const n = list[j];
      if (n && n.role === 'tool' && n.tool_call_id && need.has(n.tool_call_id)) {
        found.push(n);
        need.delete(n.tool_call_id);
      } else {
        gap.push(n);
      }
      j++;
    }

    // 结果没凑齐 —— 这一段本来就不完整, 挪也没用, 原位保留 (别把语义搅乱)
    if (need.size) {
      i = scanStart;   // 一条都不挪: 这段本来就残缺, 挪只会把顺序搅乱
      continue;
    }

    // 结果齐了: 先摆结果, 再摆夹在中间的东西
    for (const f of found) out.push(f);
    if (gap.length) moved += gap.length;
    for (const g of gap) out.push(g);
    i = j;
  }

  return { messages: out, moved };
}

module.exports = { sanitizeToolPairing, enforceToolResultAdjacency };
