// sub-agent-defaults.mjs —— 8 将灵推荐预设
//
// 从原版 `apps/desktop/src/data/sub-agent-defaults.js` (git 110661d^) 原样搬过来。
// 真源在 core 的 SUB_AGENT_DEFAULTS, 前端这份保持 UI 同步。

export const SUB_AGENT_DEFAULTS = {
  qian: { max_tool_iterations: 10, reasoning_effort: 'medium', parallel_tools: false, auto_approve: false, sandbox_strict: true, memory_enabled: true },
  kan: { max_tool_iterations: 5, reasoning_effort: 'low', parallel_tools: false, auto_approve: false, sandbox_strict: true, memory_enabled: true },
  li: { max_tool_iterations: 60, reasoning_effort: 'medium', parallel_tools: true, auto_approve: false, sandbox_strict: true, memory_enabled: true },
  kun: { max_tool_iteritions: 80, reasoning_effort: 'low', parallel_tools: false, auto_approve: false, sandbox_strict: true, memory_enabled: false },
  dui: { max_tool_iterations: 30, reasoning_effort: 'medium', parallel_tools: true, auto_approve: false, sandbox_strict: true, memory_enabled: false },
  xun: { max_tool_iterations: 70, reasoning_effort: 'medium', parallel_tools: true, auto_approve: false, sandbox_strict: true, memory_enabled: true },
  zhen: { max_tool_iterations: 25, reasoning_effort: 'medium', parallel_tools: false, auto_approve: false, sandbox_strict: true, memory_enabled: true },
  gen: { max_tool_iterations: 20, reasoning_effort: 'low', parallel_tools: false, auto_approve: false, sandbox_strict: true, memory_enabled: true },
};

export default SUB_AGENT_DEFAULTS;
