// gua-roster.mjs —— 8 将灵 (sub-agent) 的单一真源 (浏览器版)
//
// 从原版 `apps/desktop/src/data/gua-roster.js` (git 110661d^) 原样搬过来。
// 字段一个没改 —— 后端 /api/pangu/subagents/roles 也是这份表,
// 前端显示的名字必须跟落盘的名字是同一个 (原版注释里那条「越多越乱」的教训)。

export const GUA_ROSTER = [
  { gua: '乾', code: 'qian', icon: '☰',
    // 第 143 批: 说明原来是给写代码的人看的黑话 (「洗 think/碎念」「基于真账」
    //   「纯 LLM, 无工具」)。改成"这一位负责什么", 一句白话说清。
    role: '调度', desc: '汇总其余七位的结果，整理成一段结论交给你。不调用工具，思考过程不外露。',
    tools: [] },
  { gua: '坎', code: 'kan', icon: '☵',
    role: '拆', desc: '把大任务拆成有先后顺序的子任务，标出依赖关系与耗时估计。',
    tools: ['todo_write', 'plan_create', 'plan_view'] },
  { gua: '离', code: 'li', icon: '☲',
    role: '读', desc: '翻目录、读文件、检索资料，并给出研判。',
    tools: ['list_directory', 'read_file', 'memory_search'] },
  { gua: '坤', code: 'kun', icon: '☷',
    role: '做', desc: '落盘文件、执行命令、产出成品，一直做到有结果。',
    tools: ['exec_command', 'write_file', 'run_installer'] },
  { gua: '兑', code: 'dui', icon: '☱',
    role: '验', desc: '「坤」做完必须过「兑」：只核对成败，不改不动。',
    tools: ['http_check', 'exec_command'] },
  { gua: '巽', code: 'xun', icon: '☴',
    role: '找雷', desc: '专门找隐藏的缺陷、安全隐患和回归风险，只找不修。',
    tools: ['exec_command', 'memory_search'] },
  { gua: '震', code: 'zhen', icon: '☳',
    role: '复盘', desc: '「兑」没通过时复盘：成因为何、败在哪里、怎么破局，不写入记忆。',
    tools: ['memory_search', 'caution_signal', 'withdrawal_plan'] },
  { gua: '艮', code: 'gen', icon: '☶',
    role: '记', desc: '任务完成后自动运行，把经验沉淀成规则与长期记忆，只记不干活。',
    tools: ['memory_search', 'memory_write'] },
];

/** 显示名统一成「卦 · 职责」—— 跟后端 GUA_ROLES.zh 和将灵面板一致。 */
export function guaLabel(gua) {
  if (!gua) return '';
  return `${gua.gua} · ${gua.role || ''}`.trim();
}

export const CODE_TO_GUA = GUA_ROSTER.reduce((m, r) => {
  m[r.code] = r;
  m[r.gua] = r;
  return m;
}, {});

/** 按拼音或卦名查将灵, 查不到返回 null。 */
export function findGua(name) {
  const k = String(name == null ? '' : name).trim().toLowerCase();
  if (!k) return null;
  return CODE_TO_GUA[k] || null;
}

export const GENERAL_TOOLS = [
  'web_search', 'file_grep', 'current_time',
  'cache_get', 'cache_put', 'cache_stats',
];

export const GENERAL_TOOL_DESC = {
  web_search: 'web 搜索 (Bing cn fallback)',
  file_grep: '文件读 (grep 模式)',
  current_time: '当前时间',
  cache_get: 'cache 读',
  cache_put: 'cache 写',
  cache_stats: 'cache 统计',
};

