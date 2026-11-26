// labels.mjs —— 枚举值的中文化 (界面里那些 "done / start / openai / single_free")
//
// 起因 (2026-10-28 第 138 批, 老板一句「还有界面问题」):
//   盘古的界面是中文的, 但**从后端原样搬过来的英文枚举**到处漏:
//   将灵表里状态列写着 done / start; 状态页里协议列写着 openai、
//   节点角色写着 primary、状态写着 online; 设置页里模式写着 single_free。
//   ⇒ 一屏里中英混排, 这就是"不上档次"的一部分 —— 不是设计不到位, 是**没翻译**。
//
// 口径: 只翻译**人读的标签**, 不改数据本身 (发给模型的字段名一个字不动)。
//   未知值原样透出 (别把没见过的值吞掉 —— 那会让人以为界面上显示错了)。

const SUBAGENT_RUN_STATE = {
  done: '已完成',
  start: '进行中',
  running: '进行中',
  pending: '排队中',
  failed: '失败',
  error: '失败',
  timeout: '超时',
  cancelled: '已取消',
  aborted: '已中止',
  skipped: '已跳过',
};

const NODE_ROLE = {
  primary: '主节点',
  secondary: '备节点',
  worker: '工作节点',
  observer: '观察节点',
};

const NODE_STATUS = {
  online: '在线',
  offline: '离线',
  busy: '忙碌',
  degraded: '降级',
  error: '异常',
};

const PROTOCOL = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  gemini: 'Gemini',
};

const MODE = {
  single_free: '单机·免费优先',
  single: '单机',
  team: '多机协同',
  cluster: '集群',
};

const PLAN = {
  personal: '个人',
  team: '团队',
  enterprise: '企业',
};

const CAPABILITY = {
  chat: '对话',
  reasoning: '推理',
  vision: '视觉',
  tool: '工具调用',
  tools: '工具调用',
  streaming: '流式',
  json: 'JSON',
};

// 降级级别 (core health.js 的 degradation / memory.level)
//   normal / high / critical / minimal —— 界面上原来直接写英文,
//   一屏中文里夹一个 "normal" 看着像没做完。
const DEGRADATION = {
  normal: '正常',
  high: '偏高',
  critical: '严重',
  minimal: '极简',
};

const TABLES = {
  SUBAGENT_RUN_STATE,
  NODE_ROLE,
  NODE_STATUS,
  PROTOCOL,
  MODE,
  PLAN,
  CAPABILITY,
  DEGRADATION,
};

/**
 * 查一张表; 查不到就原样返回 (不吞值)。
 * @param {string} table  表名 (TABLES 的键)
 * @param {*} value       后端给的原值
 */
export function label(table, value) {
  if (value == null) return '';
  const t = TABLES[table];
  if (!t) return String(value);
  const hit = t[String(value)];
  return hit == null ? String(value) : hit;
}

/** 能力列表 → 中文数组 (未知的原样保留) */
export function labels(table, list) {
  if (!Array.isArray(list)) return [];
  return list.map((v) => label(table, v));
}

export default { label, labels, TABLES };
