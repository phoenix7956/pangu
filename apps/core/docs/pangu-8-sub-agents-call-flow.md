# Pangu 8 个子 Agent 调用链路详解

> 梳理时间: 2026-07-16
> 核心文件: pangu-single.js + agents/dispatcher.js + agents/sub-agent.js + agents/orchestrator.js

---

## 一、调用入口（3 条路径）

Pangu 有 **3 条** 调用 8 个子 agent 的路径，它们互不干扰：

```
用户输入 → pangu-single.js
              │
              ├─ 路径 A: /message/stream (主对话流)
              │   └─ _shouldUseDispatcher() → _runPanguDispatcherLoop()
              │
              ├─ 路径 B: /api/pangu/dispatch (REST API)
              │   └─ _handlePanguDispatch()
              │
              └─ 路径 C: /api/pangu/orchestrate (旧 orchestrator)
                  └─ PanguOrchestrator.execute()
```

---

## 二、路径 A: 主对话流（_runPanguDispatcherLoop）

**入口:** `pangu-single.js:1351`
**触发:** `POST /message/stream`（SSE 流式响应）

### 2.1 分流判断：走 dispatcher 还是 legacy？

**文件:** `pangu-single.js:1338-1350`

```javascript
function _shouldUseDispatcher(userInput) {
  const chatOnly = [
    '你好', '在吗', '你是谁', '你叫什么', '介绍一下自己',
    '嗨', 'hello', 'hi', 'who are you',
    '你是什么模型', '你是哪个模型', '模型是什么',
    '版本是多少', '几点了', '今天几号'
  ];
  if (chatOnly.some(k => text.includes(k.toLowerCase()))) return false;
  // 其他所有任务全部走 dispatcher
  return true;
}
```

**逻辑：**
- 如果是闲聊/认知类问题 → **不走 dispatcher**，走 `_runAgentLoopLegacyStream()`（单 agent J2 主循环）
- 其他所有任务 → **走 dispatcher**（8 子 agent 协同）

### 2.2 Dispatcher 执行流程

**文件:** `pangu-single.js:1352-1440`

```
┌─────────────────────────────────────────────────┐
│  Step 1: Planner 拆解                            │
│  subAgent.run({ mode: 'planner', taskText })     │
│  → 输出: { subTasks: [{agent, task}, ...] }      │
│  (最多 5 个子任务)                                │
└──────────────────────┬──────────────────────────┘
                       │  subTasks 为空?
                       ▼
                  ┌──────────────┐
                  │ 降级 legacy  │ ← 单 agent 模式
                  └──────────────┘
                       │ 有 subTasks
                       ▼
┌─────────────────────────────────────────────────┐
│  Step 2: 分组执行子任务                          │
│  同类 agent 合并为一组并行执行                   │
│                                                  │
│  group = [subTasks[idx], ...同 agent 的]         │
│  Promise.all(group.map(subAgent.run))            │
│                                                  │
│  每组之间串行，组内并行                           │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  Step 3: 综合输出                                 │
│  收集所有 toolHistory                             │
│  调 LLM 综合成最终答案                            │
│  → SSE 推送给用户                                 │
└─────────────────────────────────────────────────┘
```

### 2.3 子 agent 实际执行

**文件:** `agents/sub-agent.js`

每个子 agent 的执行是 **LLM 驱动的循环**：

```javascript
// sub-agent.js: runAgentLoop()
for (round = 0; round < maxRounds; round++) {
  1. 调 LLM 生成回复（带 role system prompt）
  2. 解析工具调用 <tool name="...">...</tool>
  3. 如果没有工具调用 → 警告重试（最多 2 轮）
  4. 执行工具（safe 并行，unsafe 串行）
  5. 工具结果回灌 LLM
  6. 最后一轮 → 输出最终总结
}
```

**每个角色的专属 system prompt 和工具集:**

| 角色 | 系统提示 | 工具数 | 关键工具 |
|------|----------|--------|----------|
| planner | 只输出 JSON 规划 | 0 | 无（纯 LLM 推理） |
| analyzer | 只分析不执行 | 17 | read_file, web_search, stock_quote... |
| executor | 只执行不分析 | 17 | exec_command, write_file, code_execute... |
| checker | 只验证不改 | 15 | read_file, exec_command, http_check... |
| bug_hunter | 只找不修 | 7 | file_grep, file_find, search_files... |
| learner | 学忆优 | 7 | memory_write, cache_put... |
| reflector | 评改学 | 7 | caution_signal, withdrawal_plan... |

---

## 三、路径 B: REST API dispatch（_handlePanguDispatch）

**入口:** `pangu-single.js:3476`
**触发:** `POST /api/pangu/dispatch`

### 3.1 三路角色选择

```
输入: { task: "...", target_role: "executor"? }
                     │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
   路径 1: 显式指定  路径 2: LLM   路径 3: keyword
   target_role 非空  分类          打分兜底
         │            │            │
         └────────────┼────────────┘
                      ▼
              选定 targetRole
```

**路径 1（显式指定）：**
```javascript
// 用户传 { target_role: "executor" } → 直接用
if (explicitRole && roleMap[explicitRole]) {
  targetRole = explicitRole;
}
```

**路径 2（LLM 分类 — pangu-v2 思维层）：**
```javascript
// _classifyDispatchTask() — 调 LLM 判断应该派给哪个角色
// 给 LLM 看 8 角色 + 关键词 + 一句话 purpose
// LLM 输出: { targetRole, confidence, reasoning, perAgentReasoning }
```

**路径 3（keyword 打分 — pangu-v1 兜底）：**
```javascript
// dispatch_rules.json 中每个角色有权重和关键词
// 任务文本中命中关键词越多 → 分数越高
// 最高分角色胜出
// 如果无命中 → 默认 fallback 到 analyzer
```

### 3.2 dispatch_rules.json 关键词映射

| 角色 | 权重 | 关键词 |
|------|------|--------|
| **executor** | 1.0 | 写、创建、生成、改、编辑 |
| **analyzer** | 1.0 | 分析、推理、判断、趋势、风险 |
| **reflector** | 1.0 | 复盘、反思、回顾、总结、教训 |
| **checker** | 1.0 | 验证、检查、测试、测、校验 |
| **bug_hunter** | **1.2** | bug、找错、找bug、debug、出错 |
| **planner** | 1.0 | 规划、拆、步骤、计划、阶段 |
| **dispatcher** | 1.0 | 派活、派、分派、调度、分配 |
| **learner** | 1.0 | 学、记、记住、缓存、记忆 |

### 3.3 工具角色映射（tool_role_map.json）

| 角色 | 工具数 | Purpose |
|------|--------|---------|
| executor | 27 | 执行型 — 写、改、跑、生成 artifact |
| analyzer | 12 | 推理型 — 看、读、推、判（64 卦 + LLM） |
| checker | 9 | 验证型 — 评、验、测（不改不修） |
| bug_hunter | 6 | 找 bug — 静态分析（不修只标） |
| planner | 9 | 拆任务 — 纯 LLM 推理（不执行） |
| reflector | 9 | 复盘 — L2 矿工 + 失败 case |
| dispatcher | 3 | 派活 — 任务→角色映射 |
| learner | 6 | 学习 — 知识库 + 缓存 |

---

## 四、路径 C: 旧 Orchestrator

**入口:** `agents/orchestrator.js`
**触发:** `POST /api/pangu/orchestrate`

这是 **旧版调度器**，与 dispatcher 不同：

```
Orchestrator.execute(task)
  │
  ├─ 1. Analyzer 分析需求
  ├─ 2. Planner 拆解子任务
  ├─ 3. 设计拓扑（依赖图）
  ├─ 4. 拓扑排序执行（串行/并行）
  │     ├─ executor.execute()
  │     ├─ checker.execute()
  │     └─ bugHunter.execute()
  └─ 5. 综合结果
```

**与 dispatcher 的区别：**
- Orchestrator 是**硬编码拓扑**（analyzer → planner → executor → checker → bugHunter）
- Dispatcher 是**LLM 动态规划**（planner 拆解 → 按类型分组并行）

---

## 五、8 角色的边界铁律

**文件:** `agents/dispatcher.js`

```javascript
const BOUNDARY_RULES = [
  'Executor 不分析 — 写完就返回，好坏由 Checker 评',
  'Analyzer 不执行 — 只推，不写',
  'Checker 不改 — 只评，不改（改是 Executor）',
  'Bug Hunter 不修 — 只找，不修（修是 Executor）',
  'Planner 不执行 — 只拆，不跑',
];

// 必须调工具的角色
const MUST_TOOL_ROLES = new Set(['executor', 'checker', 'bugHunter']);
```

**复杂度 → 角色筛选:**

| 复杂度 | 跳过的角色 | 说明 |
|--------|-----------|------|
| flash | analyzer, bugHunter, learner, reflector | 1-2 角色，直奔主题 |
| standard | analyzer, learner, reflector | planner+executor+checker 最小闭环 |
| pro | learner | standard + analyzer + reflector |
| ultra | 无 | 全套 8 角色 |

---

## 六、完整调用链图示

```
用户输入
  │
  ▼
┌─────────────────────────────────────────────┐
│  pangu-single.js: _shouldUseDispatcher()     │
│  闲聊/认知 → legacy (单 agent J2 loop)       │
│  其他 → dispatcher (8 子 agent 协同)         │
└─────────────────────┬───────────────────────┘
                      │
                      ▼
          ┌───────────────────────┐
          │  _runPanguDispatcher() │
          │                       │
          │  Step 1: Planner 拆解  │
          │  subAgent.run(mode=    │
          │    'planner')          │
          │  → { subTasks: [       │
          │      {agent:'executor',│
          │       task:'写代码'},  │
          │      {agent:'checker', │
          │       task:'验证'}     │
          │    ] }                 │
          │                       │
          │  Step 2: 分组执行      │
          │  同类 agent 合并并行    │
          │  subAgent.run(mode=    │
          │    'executor', task)   │
          │  subAgent.run(mode=    │
          │    'checker', task)    │
          │                       │
          │  Step 3: 综合输出      │
          │  收集 toolHistory →    │
          │  调 LLM 综合 → SSE 返回 │
          └───────────────────────┘
```

**每个 subAgent.run() 内部：**
```
subAgent.run(mode='executor', task='写代码')
  │
  ▼
┌─────────────────────────────────────┐
│  runAgentLoop(taskText, mode)        │
│                                      │
│  system prompt = ROLES[mode].system  │
│  tools = ROLES[mode].tools           │
│                                      │
│  for round in [0..4]:               │
│    1. LLM 生成回复 + 工具调用         │
│    2. 无工具 → 警告重试              │
│    3. 执行工具 (safe并行/unsafe串行)  │
│    4. 工具结果回灌 LLM               │
│    5. 最后一轮 → 输出总结            │
└─────────────────────────────────────┘
```

---

## 七、关键发现

### 7.1 三层调度架构

Pangu 实际上有 **三层** agent 调度：

1. **路由层** (`_shouldUseDispatcher`) — 判断走 dispatcher 还是 legacy
2. **思维层** (`_handlePanguDispatch`) — LLM 分类 / keyword 打分 → 选角色
3. **执行层** (`subAgent.run`) — LLM 驱动的 tool-use 循环

### 7.2 Legacy J2 主循环是 fallback

当 `_shouldUseDispatcher()` 返回 false 时，走 `_runAgentLoopLegacyStream()`：
- 这是**单 agent 模式**，不走 8 角色
- LLM 直接调用工具，没有角色隔离
- 适合闲聊、查时间、自我介绍等简单任务

### 7.3 Planner 拆解是核心

Dispatcher 的第一步永远是 Planner 拆解：
```javascript
plan = await subAgent.run({
  taskText: userInput,
  mode: 'planner'  // ← 纯 LLM 推理，不调工具
});
```

Planner 的输出格式：
```json
{
  "subTasks": [
    { "agent": "analyzer", "task": "分析 XX 需求" },
    { "agent": "executor", "task": "写 XX 代码" },
    { "agent": "checker", "task": "验证 XX 结果" }
  ]
}
```

### 7.4 分组并行策略

相同 agent 的子任务合并为一组并行执行：
```
subTasks = [
  { agent: 'executor', task: '写文件A' },
  { agent: 'executor', task: '写文件B' },
  { agent: 'checker', task: '验证文件A' },
]

分组:
  Group 1: [executor×2] → Promise.all(并行)
  Group 2: [checker×1]  → 串行
```

### 7.5 最终综合输出

所有子任务完成后，不是简单拼接结果，而是**再调一次 LLM** 综合：
```javascript
// 收集所有 toolHistory
// 组装 prompt: "下面是多个子 agent 的工具执行结果，请综合成最终答案"
// 调 LLM 输出结构化 Markdown 答案
```

---

*以上为 8 个子 agent 调用链路完整分析。*
