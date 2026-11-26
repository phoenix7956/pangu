/**
 * Pangu Agent Registry
 * 统一注册和管理所有 8 个 agent
 */

const {
  KunAgent,
  LiAgent,
  DuiAgent,
  KanAgent,
  ZhenAgent,
  GenAgent,
  QianAgent,
  XunAgent,
} = require('./class-compat');

// 可选 agent(尚未实现)
let _plannerAgent = null;
let _reflectorAgent = null;
let _dispatcherAgent = null;
let _learnerAgent = null;

function getRegistry() {
  const registry = {
    kun: new KunAgent(),
    li: new LiAgent(),
    dui: new DuiAgent(),
    xun: new XunAgent(),
    kan: new KanAgent(),
    zhen: new ZhenAgent(),
    qian: new QianAgent(),
    gen: new GenAgent(),
  };
  return registry;
}

// Singleton
let _registry = null;

function getAgents() {
  if (!_registry) {
    _registry = getRegistry();
  }
  return _registry;
}

// 2026-10-18 (老板: 「这8个就应该是乾坎艮震巽离坤兑, 英文一个、中文一个…应该统一」)
//
// 身份 (卦 / 拼音 / 图标 / 中文名 / 职责) 现在**只**住在 gua-identity.js 的
// GUA_ROLES 里 —— 这里只补**说明文案**, 不再重写身份。
//
// 改之前这份 catalog 是**第 6 份**手抄的"8 将灵", 而且和另外 5 份互相矛盾
// (最要命的是"乾是谁": 这里写 dispatcher, 前端 gua-roster.js 写 synthesizer,
// 而 synthesizer 在后端根本不是个角色)。手抄的清单 = 迟早只改其中一份。
// 现在身份改一处, 这份 catalog 和 API、前端全都跟着走。
const _CATALOG_PROSE = {
  qian: { title: '调度者', description: '编排调度，决定任务交给哪个 agent 执行。', tools_hint: 'dispatch' },
  kan: { title: '规划者', description: '拆/序/设任务，把大任务拆成可执行步骤。', tools_hint: 'LLM reasoning' },
  gen: { title: '学习者', description: '学/忆/优 (知识库 + 缓存)，沉淀失败模式和优化建议。', tools_hint: 'read L1/L2 data, optimize prompts' },
  zhen: { title: '复盘者', description: '评/改/学 (L2 矿工)，总结历史经验。', tools_hint: 'read L1/L2 data, memory' },
  xun: { title: '巡 bug', description: '找、抓、标 bug；只找不修。', tools_hint: 'exec_command, memory_search' },
  li: { title: '分析者', description: '64 卦推理 + LLM 解读，分析需求、检索信息、解析输入。', tools_hint: 'read_file, file_grep, session_recall, web_search' },
  kun: { title: '执行者', description: '写/改/生成 artifact，执行具体任务和命令。', tools_hint: 'write_file, file_edit, code_execute, exec_command' },
  dui: { title: '检查者', description: '评/验/测结果，验证输出和测试。', tools_hint: 'read_file, exec_command, http_check' },
};

const AGENT_CATALOG = (() => {
  // require 写在函数体内: registry.js 与 sub-agent.js 互相引用, 顶层 require 会成环。
  const { GUA_ROLES } = require('./sub-agent');
  return GUA_ROLES.map((g) => Object.assign({}, g, {
    // name 保持等于拼音 code —— 一批调用方 (含 list_pangu_agents 的消费方) 按 name 取角色。
    name: g.code,
    zhName: g.zh,
    title: (_CATALOG_PROSE[g.code] || {}).title || g.code,
    description: (_CATALOG_PROSE[g.code] || {}).description || '',
    // 原字段名是 tools (字符串提示, 不是数组)。保留原名, 免得消费方炸掉。
    tools: (_CATALOG_PROSE[g.code] || {}).tools_hint || '',
  }));
})();


function getAgentCatalog() {
  return AGENT_CATALOG;
}

function resetAgents() {
  _registry = null;
}

module.exports = {
  getAgents,
  getRegistry,
  getAgentCatalog,
  resetAgents,
};
