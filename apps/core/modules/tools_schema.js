'use strict';
/**
 * Pangu · Modules · Tools Schema
 * tools_schema.js - 工具参数Schema（MiniMax function calling用）
 *
 * 每个工具的：名称、描述、参数schema
 *
 * 2026-10-25 (第 97 批): 这个文件原来 2379 行, 其中 1739 行是**一个对象字面量**
 * (98 个工具) + 后面 32 个 `TOOLS_SCHEMA.xxx = {...}` 事后追加 —— 共 130 个工具。
 * 现按域拆成 modules/tools_schema/<域>.js 十三个文件, 本文件只做**门面 (facade)**:
 *   按顺序合并 → TOOLS_SCHEMA (顺序不变, 因为工具顺序会进 LLM 提示词)
 *   保留 getAllToolSchemas / getToolSchema / MAIN_GENERAL_TOOLS_FOR_LLM
 *
 * 守卫: tests/tools-schema-split-20261025.test.js
 *   用**拆分前**抓的基线 (130 个工具的顺序 + 每个 schema 的 sha1) 逐个对。
 */

// 顺序即语义 —— 工具顺序会进提示词, 所以这里是**显式的顺序表**, 不是自动收集。
const _FAMILIES = [
  require('./tools_schema/memory_media'),
  require('./tools_schema/divination'),
  require('./tools_schema/exec_files'),
  require('./tools_schema/web_info'),
  require('./tools_schema/dev_files'),
  require('./tools_schema/system_device'),
  require('./tools_schema/computer_use'),
  require('./tools_schema/cache_sched'),
  require('./tools_schema/decision_signals'),
  require('./tools_schema/gua_trend'),
  require('./tools_schema/ops_workflow'),
  require('./tools_schema/plan_goal_session'),
  require('./tools_schema/dev_misc'),
];

const TOOLS_SCHEMA = Object.assign({}, ..._FAMILIES);

function getAllToolSchemas() {
  // TL-4: tier 分类常量 (跟 tool_stats.js _tier2Fallback 对应)
  const _tier2Tools = new Set([
    'computer_use_vision_act', 'computer_use_click', 'computer_use_type',
    'computer_use_key', 'computer_use_drag', 'screenshot', 'take_photo',
    'record_audio', 'permission_apply',
  ]);
  return Object.values(TOOLS_SCHEMA).map(s => {
    if (!s || !s.function || !s.function.parameters) return s;
    const params = s.function.parameters;
    if (params.properties && params.properties.tier && params.properties.timeout_ms) return s;
    // TL-1 注入: parallel_group + depends_on
    // TL-4 注入: tier + timeout_ms
    const toolName = s.function.name;
    const tier = _tier2Tools.has(toolName) ? 2 : 1;
    const timeoutMs = tier === 2 ? 60000 : 30000;  // tier 2 GUI 给 60s, tier 1 30s
    const newProps = Object.assign({}, params.properties, {
      parallel_group: { type: 'string', description: 'TL-1: 相同 group 名 = parallel. 缺省 = 跟其他独立 tool 并行.' },
      depends_on: { type: 'array', items: { type: 'string' }, description: 'TL-1: 依赖的前序 tool name list. 等待这些 tool 完成才跑, ctx 自动注入前序 result.' },
      tier: { type: 'number', enum: [1, 2], description: 'TL-4: 1=确定性 API (preferred), 2=GUI vision_act (last resort). j2_agent_loop 优先调 tier 1.' },
      timeout_ms: { type: 'number', description: 'TL-4: per-tool timeout (ms). tier 1 default 30000, tier 2 default 60000.' },
    });
    return Object.assign({}, s, {
      function: Object.assign({}, s.function, {
        parameters: Object.assign({}, params, { properties: newProps }),
      }),
    });
  });
}

/**
 * 根据工具名获取 schema (同样注入 TL-1 字段)
 * @param {string} name
 * @returns {object|null}
 */
function getToolSchema(name) {
  return TOOLS_SCHEMA[name] || null;
}

// ===== task_done 工具 (LLM 显式结束) =====


// ===== 主 agent 的编排工具 — dispatch_subagents (2026-10-17) =====
// 独立文件放 schema + 结果渲染: 这两样将来主循环和 dispatcher 都要用, 写进
// tools_schema.js 就又是"拆不动的巨石"。schema 文本和渲染逻辑都不是本文件真源。
TOOLS_SCHEMA.dispatch_subagents = require('./dispatch_subagents_schema').TOOL;

// R15 修 (plan-mode-tool-selection spec 2nd pass): 集中导出 MAIN_GENERAL_TOOLS_FOR_LLM 给 j2_helpers 跟 pangu-meta 对齐真源
// 避免 j2_helpers ↔ pangu-meta.js MAIN_GENERAL_TOOLS 重复字义漂移 (老板 7/25 12:42 截图)
// R80 修 (R80 BUG #6 main role 工具不全): 老板 7/30 实证 "main 集只有 14 个, task_done/write_file/memory_* 都没有"
//   → LLM 反复嘴"task_done"但 0 工具调用, 没法写 MEMORY.md, 没法持久记忆
// 修: 加 9 个核心工具 (从 14 → 23), 让 main role 能真调 task_done / 写 MEMORY.md / 持久记忆
// 原则: 加"必须"工具, 不一次暴露 109 个 (R15 防止工具爆炸)
//   - task_done: 真能停 (而不是嘴停)
//   - memory_search/write/read: 真能持久记忆 (cache_get 不是记忆, R80 BUG #2)
//   - write_file: 真能写 MEMORY.md / ~/.pangu/rules/
//   - file_edit / file_edit_batch: 原子编辑
//   - todo_write: 结构化任务清单
//   - list_pangu_agents: 老板对话"必须先调"但没暴露
//   - system_info: 自报状态
//   - exec_command: shell, sandbox 二次拦截
const MAIN_GENERAL_TOOLS_FOR_LLM = [
  // 原有通用 (executor/cache 类)
  'web_search', 'read_file', 'current_time', 'cache_get', 'cache_put', 'cache_stats',
  // 2026-10-15: 补上"探索"这一半的文件 API。
  // 现场 (实测 /message/stream, 本地 27B): 老板问 "用 list_directory 看一下某目录有几个文件",
  // 模型连调 6 次 list_pangu_agents —— 因为 list_directory 压根不在 main 集里, 它调不到!
  // 它退而选了这个集里唯一带 "list" 字样的工具, 被自己的防重复守门拦了 6 次,
  // 每一次都是一整轮本地推理 (~40s), 200s 还没收尾, 最后还给了个错答案。
  //
  // 根因不是模型笨, 是它够不着: main 集有 read_file (能读已知路径的文件)
  // 却没有 list_directory (不知道有哪些文件) —— 半个文件 API, 等于没法探索磁盘。
  // 长任务里"先摸清现场再动手"是最常见的第一步, 这一步不通, 后面白烧。
  // 这三个都是只读工具, 已在 _READONLY_TOOLS 防重复白名单里, 不会引入新的空转面。
  'list_directory',       // 列目录 — 探索链的第一步, 缺了它 read_file 只能靠猜路径
  'file_find',            // 按名找文件 (不知道在哪但知道叫什么)
  'search_files',         // 按内容搜 (alias file_grep)
  // 策略分析 (analyzer 类, 主对话也要见 — P1 64卦降级后默认走 LLM 自身推理, 5 个 64卦工具 description 已标 [辅助参考])
  'gua_cast', 'hexagram_lookup', 'risk_assessment', 'critical_point_analysis', 'situation_check', 'momentum_assessment',
  // 六格判局 (2026-10-22 老板「这用在项目上」): 生彼泻克耗用在**非八字**的事情上 ——
  // 项目推进/决策取舍/该不该停。这是内核唯一能对「一件事」出判断的入口, 六格判局工具。
  'wuxing_judge',
  // 风水排盘 (2026-10-23 第 69 批): 八宅/风水 —— 命卦/宅卦/大游年/阳宅四要/三元九运。
  //   ⚠️ 只进 main, **不进 li**: li 那份 schema 已经 8987/9000, 只剩 13 字符,
  //   塞进去就顶穿那条守卫(见 tests/cloud-reasoning-budget-20261016 T10)。
  'fengshui_calc',
  // 数据查询 (analyzer 类)
  'metrics_dashboard', 'metrics_query', 'trend_judgment', 'session_recall',
  // ===== R80 加: 核心"真能停/真能写/真能记"工具 =====
  'task_done',            // 真能停 (LLM main role 必须能调, 否则只能嘴停)
  'memory_search',        // 查持久记忆库 (~/.pangu/memory/main.sqlite) — 替代 cache_get 误调
  'memory_write',         // 写持久记忆 — 让 LLM 真能更新 MEMORY.md / 跨 session 规则
  'memory_read',          // 读持久记忆
  'write_file',           // 写 MEMORY.md / ~/.pangu/rules/ — 老板实证需要
  'file_edit',            // 原子编辑
  'file_edit_batch',      // 批量编辑
  'todo_write',           // 结构化任务清单
  'list_pangu_agents',    // 老板对话"必须先调"但 R15 没暴露
  'system_info',          // 自报当前状态 (回答"你自己啥情况"类问题)
  'exec_command',         // shell, sandbox 二次拦截 (白名单 + 危险命令检查)
  'self_iterate',         // 2026-08-02 老板拍: 自我迭代闭环 (改码→验证→快照→重启→回滚)
  'draw_layout',          // 2026-08-02 老板拍: 平面图出图 (SVG/DXF 确定性必出, 文件 statSync 验证)
  'media_generate',       // 多模态生成内置化 (image/music; video 已停用)
  'skill_use',            // 2026-08-07 老板拍: skill 读取内置化 (顶 4 个 echo MCP 桥)
  // 2026-10-30 (第 172 批): 盘古自己接微信了 ——
  //   send_wechat 从「空壳」(只往 ~/.pangu/weixin_queue/ 写文件, 没有消费者 ⇒ 直接报错)
  //   变成**真能发**: modules/weixin_channel.js 直连 iLink 微信通道 (不经过老 openclaw 桌面端)。
  //   进了 main 集 ⇒ 老板在网页/终端跟盘古说话, 盘古能主动把结果推回微信。
  //   `to` 省略 = 发给绑定的默认会话 (主人本人) —— 所以模型不需要知道 user_id。
  'send_wechat',
  // 2026-10-17 (老板拍: 「乾就应该把任务拆了, 分下去」):
  // 主 agent 原本**没有任何编排能力** —— MAIN 集里没有 plan_create, 也没有任何
  // 派活工具。于是"该不该派活"完全由 j2_dispatcher 里四个正则/启发式决定, 主循环
  // 只是最后兜底。长任务里主 agent 只能单线程硬啃整件事: 没人拆、没人并行、没人汇报。
  // 加上它之后, 主 agent 自己就能决定拆几刀、派给谁 —— 跟 Codex 一个模式。
  // 执行不在 tools/index.js (那里 ctx 只有 {user, sessionId}, 拿不到 res/model),
  // 由 j2_agent_loop 主循环拦截并 in-process 调 subagent_runner。
  // 只给 main 角色: 子 agent 的白名单里没有它 → 递归派发从工具层就断了 (深度锁 1 层)。
  'dispatch_subagents',
];

module.exports = { TOOLS_SCHEMA, getAllToolSchemas, getToolSchema, MAIN_GENERAL_TOOLS_FOR_LLM };

