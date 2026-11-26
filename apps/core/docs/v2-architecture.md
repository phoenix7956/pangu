# Pangu 2.0: Agent Cluster Architecture

> **Status**: Phase 1 启动中(2026-07-01)
> **Owner**: 老板
> **里程碑**: Pangu 1.0 (64 卦推理内核) → Pangu 2.0 (8-Agent Cluster)

---

## 🎯 一句话定位

> **Pangu 不是 1 个 agent,是 1 个 agent 集群(8 个独立 agent 协同工作)。**
> **跟 Marvis 6-agent 协同、Codex 多模型、Sakana Fugu Multi-Agent 同一形态。**

---

## 🏗️ 完整架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Pangu Agent Cluster                      │
│                 (8 个独立 agent 协同工作)                     │
│                                                              │
│   ┌──────────────────────────────────────────────────────┐  │
│   │           Orchestrator (Pangu 核心调度器)              │  │
│   │     任务分析 → 拆解 → 设计拓扑 → 调度 → 综合          │  │
│   └──────────────────────────────────────────────────────┘  │
│                          ↓                                   │
│   ┌────────────┬─────────────┬──────────────┬─────────────┐  │
│   │  Executor  │   Analyzer  │   Checker    │ Bug Hunter  │  │
│   │  执行者    │   分析者    │   检查者     │  巡 bug     │  │
│   │ (25 skill) │(64 卦+LLM) │(read+test)   │(static+LLM) │  │
│   └────────────┴─────────────┴──────────────┴─────────────┘  │
│   ┌────────────┬─────────────┬──────────────┬─────────────┐  │
│   │  Planner   │  Reflector  │  Dispatcher  │   Learner   │  │
│   │  规划者    │   反思者    │   调度者     │   学习者    │  │
│   │  (LLM)     │(L2 矿工)   │(映射表)      │(知识库)    │  │
│   └────────────┴─────────────┴──────────────┴─────────────┘  │
│                          ↓                                   │
│   ┌──────────────────────────────────────────────────────┐  │
│   │              共享资源池                                │  │
│   │  • 70 in-process skill(45 推理型 + 25 执行型)        │  │
│   │  • 43 MCP 工具(像素/crawler/github/filesystem)       │  │
│   │  • 64 卦本体(8 宫 + 5 行 + 6 爻)                     │  │
│   │  • 384 爻 SKILL.md 知识库                              │  │
│   │  • LLM 推理(gemma-4-31b / minimax)                   │  │
│   └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 🤖 8 个 Agent 详细定义

### 1️⃣ Executor 执行者

| 维度 | 内容 |
|---|---|
| **角色** | 写、改、生成 artifact |
| **资源(挂)** | 25 个执行型 skill:write_file / exec_command / send_wechat / code_execute / archive_create / archive_extract / screenshot / tts_speak / clipboard_write / etc. |
| **输入契约** | `{task: string, params: object}` |
| **输出契约** | `{artifact: any, status: 'success'\|'failed', error?: string}` |
| **LLM 调用** | ❌(直接执行,不推理) |
| **关键边界** | ❌ 不分析(由 Analyzer) / ❌ 不检查(由 Checker) / ❌ 不修 bug(由 Bug Hunter 找) |

### 2️⃣ Analyzer 分析者

| 维度 | 内容 |
|---|---|
| **角色** | 看、读、推、判 |
| **资源(挂)** | 64 卦本体 + 5 行 + 6 爻 + LLM + read_file / web_search / web_fetch |
| **输入契约** | `{query: string, guaVector?: hexagramVector, context?: object}` |
| **输出契约** | `{guaInfer: object, confidence: number(0-1), reasoning: string}` |
| **LLM 调用** | ✅(基于 64 卦推理) |
| **关键边界** | ❌ 不执行(只推,不写) |

### 3️⃣ Checker 检查者

| 维度 | 内容 |
|---|---|
| **角色** | 评、验、测 |
| **资源(挂)** | read_file + grep + diff + test_runner + LLM(评质量) |
| **输入契约** | `{output: any, criteria: string[]}` |
| **输出契约** | `{pass: boolean, issues: [{type: string, severity: 'low'\|'med'\|'high', message: string}]}` |
| **LLM 调用** | ⚠️(可选,简单场景不需要) |
| **关键边界** | ❌ 不改(只评,改由 Executor) |

### 4️⃣ Bug Hunter 巡 bug

| 维度 | 内容 |
|---|---|
| **角色** | 找、抓、标 |
| **资源(挂)** | 静态分析 + 漏洞规则库 + LLM + grep / read_file |
| **输入契约** | `{code: string, rules?: string[]}` |
| **输出契约** | `{bugs: [{line: number, type: string, severity: 'low'\|'med'\|'high'\|'critical', fix_suggestion?: string}]}` |
| **LLM 调用** | ✅(智能识别) |
| **关键边界** | ❌ 不修(只找,修由 Executor) |

### 5️⃣ Planner 规划者

| 维度 | 内容 |
|---|---|
| **角色** | 拆、序、设 |
| **资源(挂)** | 纯 LLM 推理 + 历史任务模式库 |
| **输入契约** | `{bigTask: string, constraints?: object[]}` |
| **输出契约** | `{subTasks: [{id: string, type: string, agent: string, args: object, deps?: string[]}], estimatedDuration?: number}` |
| **LLM 调用** | ✅(必须) |
| **关键边界** | ❌ 不执行(只拆,不跑) |

### 6️⃣ Reflector 反思者

| 维度 | 内容 |
|---|---|
| **角色** | 评、改、学 |
| **资源(挂)** | L2 矿工历史 + 失败 case 库 + LLM |
| **输入契约** | `{output: any, context: object, criteria?: string[]}` |
| **输出契约** | `{score: number(0-100), strengths: string[], weaknesses: string[], suggestions: string[]}` |
| **LLM 调用** | ✅(必须) |
| **关键边界** | 只评,不执行 |

### 7️⃣ Dispatcher 调度者

| 维度 | 内容 |
|---|---|
| **角色** | 派、合、调 |
| **资源(挂)** | 任务 → 角色映射表 + 拓扑设计 LLM + 资源池状态 |
| **输入契约** | `{task: object, ctx: {availableAgents: string[], availableResources: string[]}}` |
| **输出契约** | `{toAgent: string, schedule: {parallel?: string[], sequential?: string[]}, timeout?: number}` |
| **LLM 调用** | ✅(必须) |
| **关键边界** | 只调度,不执行 |

### 8️⃣ Learner 学习者

| 维度 | 内容 |
|---|---|
| **角色** | 学、忆、优 |
| **资源(挂)** | 知识库 + 缓存 + L2 矿工 jsonl |
| **输入契约** | `{expData: {task: object, results: any, reflection: object}}` |
| **输出契约** | `{updatedStrategy: {taskPattern: string, agentCombo: string[], prompts?: object, weights?: object}}` |
| **LLM 调用** | ⚠️(可选,主要用于 prompt 改进) |
| **关键边界** | 只学,不干扰当前任务 |

---

## 🎯 Orchestrator 调度器

### Orchestrator 工作流

```javascript
class PanguOrchestrator {
  async orchestrate(task) {
    // 1. Planner 拆任务
    const subTasks = await this.agents.planner.execute({bigTask: task});
    
    // 2. Dispatcher 设计拓扑
    const schedule = await this.agents.dispatcher.execute({
      task: subTasks, 
      ctx: {availableAgents: Object.keys(this.agents)}
    });
    
    // 3. 执行 schedule(并行 + 串行)
    const results = await this.executeSchedule(schedule);
    
    // 4. Reflector 评质量
    const reflection = await this.agents.reflector.execute({
      output: results, 
      context: {task, schedule}
    });
    
    // 5. Learner 学经验(异步,不阻塞)
    this.agents.learner.execute({expData: {task, results, reflection}})
      .catch(err => console.error('learner failed:', err));
    
    return {results, reflection};
  }
  
  async executeSchedule(schedule) {
    const results = {};
    // 并行阶段
    if (schedule.parallel) {
      const parallelResults = await Promise.all(
        schedule.parallel.map(id => this.agents[id].execute(/* ... */))
      );
      parallelResults.forEach((r, i) => results[schedule.parallel[i]] = r);
    }
    // 串行阶段
    if (schedule.sequential) {
      for (const id of schedule.sequential) {
        results[id] = await this.agents[id].execute(/* ... */);
      }
    }
    return results;
  }
}
```

---

## 🔄 完整工作流 case:老板说"做 Pangu 新功能"

```
老板输入:做 Pangu 新功能
  ↓
[Planner 规划者] 拆 5 子任务
  ├─ T1:架构决策(给 Analyzer)
  ├─ T2:技术选型(给 Analyzer)
  ├─ T3:风险评估(给 Analyzer)
  ├─ T4:写代码(给 Executor)
  └─ T5:写 test(给 Executor)
  ↓
[Dispatcher 调度者] 设计拓扑
  phase1: [T1, T2, T3] 并行
  phase2: [T4, T5] 并行(等 phase1)
  phase3: [check_code, hunt_bugs] 并行
  phase4: [fix_bugs](如果有)
  phase5: [check_final]
  ↓
执行:
  phase1: 3 个 Analyzer agent 并行跑(各 1 次 LLM call)
  phase2: 2 个 Executor agent 并行跑(各 1 次 LLM call)
  phase3: 1 个 Checker + 1 个 Bug Hunter 并行跑
  phase4: 如有 bugs → Executor 修
  phase5: Checker 再验
  ↓
[Reflector 反思者] 评质量(1 次 LLM call)
  → score: 87 / 100
  → suggestions: ['测试覆盖率低', '缺错误处理']
  ↓
[Learner 学习者] 学经验(异步,1 次 LLM call)
  → 更新 "代码生成任务 → [Analyzer+Executor+Checker+BugHunter] 组合" 映射
  ↓
输出:代码 + test + 质量分 + 改进建议
```

---

## 🧬 自进化 L3 闭环(老板重点)

```
L1 数据底座(✅ 6/30) → L2 经验矿工(✅ 6/30) → L3 角色进化(❌ 待设计)
```

### L3.1 角色权重自适应

每个 agent 记录:
- `agent_weights[role] = {appearances: number, successes: number, avgDurationMs: number}`
- 失败率高 → 触发 prompt 改进(Reflector 建议 → 老板 OK → commit)
- 平均耗时高 → 资源优化

### L3.2 任务 → 角色组合 映射学习

```
{
  "code_review": {
    "agents": ["bug_hunter", "checker"],
    "success_rate": 0.87,
    "avg_score": 82
  },
  "architecture_decision": {
    "agents": ["planner", "analyzer"],
    "success_rate": 0.91,
    "avg_score": 88
  },
  "bug_fix": {
    "agents": ["bug_hunter", "executor", "checker"],
    "success_rate": 0.78,
    "avg_score": 76
  }
}
```

### L3.3 角色 prompt 自我改进

每次失败 → Reflector 写改进建议 → 老板 OK → 角色 prompt 自动更新

### L3.4 角色工具集自调整

- 高频 tool → 加入角色默认工具集
- 低频 tool → 角色弃用
- 每周 Learner 自省 1 次

---

## 🌍 跟行业对齐

| 系统 | 形态 | Agent 数 | 协同方式 |
|---|---|---|---|
| **Marvis** | Agent cluster | 6 | Computer Use + 桌面自动化 |
| **Codex** | Multi-model | N | 不同模型处理不同任务 |
| **Open Core** | 单 agent | 1 | 单独跑 |
| **Sakana Fugu** | Multi-agent cluster | 3 角色动态 | Conductor RL 路由 |
| **Pangu 2.0** | **Agent cluster** | **8 agent 动态** | **Orchestrator + 自进化** |

### Pangu 2.0 比 Fugu 强 2 点

1. **推理源 = 64 卦**(中国决策框架),不只 LLM
2. **真执行**(MCP 跑工具),Fugu 只到生成文本

---

## 🚀 Phase 1 实施(5-7 天)

### Day 1-2:文档 + 基础架构

- ✅ `docs/v2-architecture.md`(本文件)
- ⬜ `agents/base_agent.js`(PanguAgent 基类)
- ⬜ `agents/orchestrator.js`(调度器)
- ⬜ `agents/registry.js`(8 agent 注册)

### Day 3-4:4 核心 agent

- ⬜ `agents/executor.js`
- ⬜ `agents/analyzer.js`
- ⬜ `agents/checker.js`
- ⬜ `agents/bug_hunter.js`

### Day 5:L3 闭环骨架

- ⬜ `agents/weight_tracker.js`(角色权重)
- ⬜ `agents/task_mapper.js`(任务映射)
- ⬜ `agents/prompt_evolver.js`(prompt 进化)

### Day 6-7:测试 + 端到端

- ⬜ `tests/test_agents_basic.js`(单 agent 测试)
- ⬜ `tests/test_orchestrator.js`(调度测试)
- ⬜ `tests/test_e2e_workflow.js`(端到端)

### 端点

- `POST /api/pangu/orchestrate` — 老板新接口
- 内部调度 4-5 次 LLM call

---

## 📐 设计原则(铁律)

1. **每个 agent 是独立单元** — 不是内部模块
2. **资源独占** — 一个 skill 主要只给一个 agent 用
3. **输入/输出契约严格** — 跨 agent 调用靠 schema 校验
4. **失败可恢复** — agent 失败不阻塞整个 cluster
5. **可观测** — 每个 agent 调用都进 L1 jsonl(给 Learner 学)

---

## 📂 相关文件

- `memory/2026-07-01.md` — 今晚老板设计对话完整记录
- `MEMORY.md §0.7` — Pangu 战略 4 层(基础定调)
- `MEMORY.md §0.8` — Rust 重写 Pangu Kernel
- `docs/README.md` — Pangu 1.0 文档(待升级为 2.0)

---

*最后更新:2026-07-01 20:30 GMT+8*
*状态:Phase 1 设计完成,代码骨架启动中*