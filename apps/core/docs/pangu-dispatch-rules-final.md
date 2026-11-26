# 盘古 8 子 Agent 调用规则 — 最终方案

> 生成时间: 2026-07-17
> 涉及文件: `pangu-single.js`, `config/dispatch_rules.json`, `agents/sub-agent.js`

---

## 一、三层调用架构总览

```
用户输入
  │
  ▼
┌─────────────────────────────────────────────┐
│ Layer 1: Gate1 — _shouldUseDispatcher()     │
│  判断是否走 Dispatcher 还是 Legacy 单 Agent  │
│  - 匹配 DISPATCHER_KWS → 走 Dispatcher       │
│  - 匹配 PURE_CHAT → 走 Legacy                │
│  - 默认走 Dispatcher (保守策略)               │
└─────────────────────────────────────────────┘
  │ 走 Dispatcher
  ▼
┌─────────────────────────────────────────────┐
│ Layer 2: Gate2 — _runPanguDispatcherLoop()  │
│                                             │
│  ├─ [新] skip_planner 检测                  │
│  │   └─ _matchSkipPlannerRole()             │
│  │       └─ 匹配 dispatch_rules.json        │
│  │           中 skip_planner=true 的角色     │
│  │       └─ 是 → 走 FixedFlow 路径           │
│  │       └─ 否 → 继续到 Planner             │
│  │                                           │
│  ├─ [正常] LLM Planner                     │
│  │   └─ subAgent.run(mode='planner')        │
│  │       └─ 将用户输入拆解为 subTasks        │
│  │       └─ 每个 subTask 指定 agent + task   │
│  │                                           │
│  ├─ [新] Keyword Fallback (Planner 失败)    │
│  │   └─ _keywordFallback()                  │
│  │       └─ 用 dispatch_rules.json 关键词    │
│  │           直接路由到单个角色              │
│  │                                           │
│  └─ [FixedFlow 路径]                        │
│      └─ _buildFixedSubTasks()               │
│          └─ 从 fixed_agents + fixed_tasks   │
│              构建固定 subTasks 数组           │
│      └─ 串行执行同类型 agent 的并行组         │
│      └─ LLM 综合输出                        │
│                                           │
│  └─ [Keyword Fallback 路径]                 │
│      └─ 直接调 subAgent.run(mode=role)      │
│      └─ LLM 综合输出                        │
└─────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────┐
│ Layer 3: subAgent.run(mode=X)               │
│  - executor / analyzer / checker / ...      │
│  - 各自有 system prompt + tool calls        │
│  - 返回 { ok, summary, data: { toolHistory }}│
└─────────────────────────────────────────────┘
```

---

## 二、8 个子 Agent 角色与调用规则

### 2.1 角色列表

| # | 角色 | 职责 | 权重 | 关键词示例 |
|---|------|------|------|-----------|
| 1 | **executor** | 执行操作（写代码、跑命令、截图等） | 1.0 | 写、创建、生成、执行、build、run |
| 2 | **analyzer** | 分析推理（趋势、风险、状态判断） | 1.0 | 分析、推理、判断、趋势、风险 |
| 3 | **checker** | 验证检查（网络、端口、状态检测） | 1.0 | 验证、检查、测试、verify、ping |
| 4 | **bug_hunter** | Bug 查找（错误诊断、根因分析） | 1.2 | bug、找错、debug、异常、错误 |
| 5 | **planner** | 任务拆解（LLM 分解复杂任务） | 1.0 | 规划、拆、步骤、计划 |
| 6 | **reflector** | 复盘反思（回顾、教训、信号） | 1.0 | 复盘、反思、回顾、教训 |
| 7 | **learner** | 学习记忆（记住、缓存、沉淀） | 1.0 | 学、记、记住、记忆 |
| 8 | **dispatcher** | 派活调度（分发任务给其他 agent） | 1.0 | 派活、派、分派、调度 |

### 2.2 特殊角色：self_checker（skip_planner）

在 `config/dispatch_rules.json` 中新增的元角色：

```json
{
  "self_checker": {
    "keywords": ["排查", "自查", "体检", "诊断", "检查自己", "self_check", "audit"],
    "weight": 1.5,
    "skip_planner": true,
    "fixed_agents": ["checker", "checker", "checker", "checker", "checker"],
    "fixed_tasks": [
      "检查系统环境：主机名、CPU、内存、负载、网络",
      "检查 Agent 架构：8 角色列表、工具集、边界规则",
      "检查运行状态：进程监控、关键文件存在性",
      "检查工具清单：exec/file/network/code/memory 各分类",
      "综合输出：状态报告"
    ]
  }
}
```

**调用规则：**
- 当用户输入包含"排查"、"自查"、"体检"、"诊断"等关键词时
- `_matchSkipPlannerRole()` 检测到 `skip_planner=true`
- **跳过 LLM Planner**，直接执行 5 次 checker 子任务
- 每次任务固定不变 → **保证相同输入产生相同输出**

---

## 三、调用决策树

### 3.1 完整决策流程

```
用户输入: "排查一下你自己"
  │
  ├─ Gate1: _shouldUseDispatcher()?
  │   ├─ 匹配 DISPATCHER_KWS: "排查" ✓
  │   └─ → 走 Dispatcher
  │
  ├─ Gate2: _runPanguDispatcherLoop()
  │   ├─ [新] _matchSkipPlannerRole("排查一下你自己")
  │   │   ├─ 扫描 dispatch_rules.json
  │   │   ├─ 匹配 self_checker: keywords=["排查", ...] ✓
  │   │   └─ → 返回 { role: "self_checker", fixed_agents: [...], fixed_tasks: [...] }
  │   │
  │   ├─ [FixedFlow 路径]
  │   │   ├─ _buildFixedSubTasks(5个checker, 5个固定任务)
  │   │   ├─ 执行 subTask[0]: checker → "检查系统环境..."
  │   │   ├─ 执行 subTask[1]: checker → "检查Agent架构..."
  │   │   ├─ 执行 subTask[2]: checker → "检查运行状态..."
  │   │   ├─ 执行 subTask[3]: checker → "检查工具清单..."
  │   │   ├─ 执行 subTask[4]: checker → "综合输出..."
  │   │   ├─ LLM 综合 5 个 checker 的结果
  │   │   └─ → 返回最终答案
  │   │
  │   └─ [不会走到这里] LLM Planner → 因为 skip_planner 已拦截
  │
  └─ 结果: 确定性输出，无 LLM 随机性
```

### 3.2 普通任务示例

```
用户输入: "帮我写一个Python脚本分析日志"
  │
  ├─ Gate1: _shouldUseDispatcher()?
  │   ├─ 匹配 DISPATCHER_KWS: "写" ✓
  │   └─ → 走 Dispatcher
  │
  ├─ Gate2: _runPanguDispatcherLoop()
  │   ├─ [新] _matchSkipPlannerRole("帮我写一个Python脚本分析日志")
  │   │   ├─ 扫描 dispatch_rules.json
  │   │   └─ 没有角色匹配 skip_planner=true
  │   │   └─ → 返回 null，继续
  │   │
  │   ├─ [正常 Planner 路径]
  │   │   ├─ subAgent.run(mode='planner', task="帮我写一个Python脚本分析日志")
  │   │   │   ├─ LLM 拆解任务
  │   │   │   └─ → { subTasks: [
  │   │   │       { agent: "executor", task: "写Python脚本..." },
  │   │   │       { agent: "checker", task: "验证脚本能否运行..." }
  │   │   │   ]}
  │   │   ├─ 并行执行同 agent 的子任务
  │   │   ├─ LLM 综合输出
  │   │   └─ → 返回最终答案
  │   │
  │   └─ [Keyword Fallback] 仅当 Planner 失败时触发
  │
  └─ 结果: LLM 拆解，可能有随机性
```

### 3.3 Planner 失败时的兜底

```
场景: LLM 服务不可用 / Planner 超时 / 返回空 subTasks
  │
  ├─ Gate2: _runPanguDispatcherLoop()
  │   ├─ subAgent.run(mode='planner') → 抛出异常
  │   │   └─ 或返回 { subTasks: [] }
  │   │
  │   ├─ [新] _keywordFallback("帮我写一个Python脚本")
  │   │   ├─ 扫描 dispatch_rules.json 所有角色
  │   │   ├─ executor: 匹配 "写" → score=1.0
  │   │   ├─ planner: 匹配 "脚本" → score=0 (不在planner关键词中)
  │   │   └─ → 返回 { role: "executor", score: 1.0, matchedKws: ["写"] }
  │   │
  │   ├─ [Keyword Fallback 路径]
  │   │   ├─ subAgent.run(mode='executor', task="帮我写一个Python脚本")
  │   │   ├─ LLM 综合输出
  │   │   └─ → 返回最终答案
  │   │
  │   └─ 如果关键词也匹配不到
  │       └─ → 降级到 _runAgentLoopLegacyStream() (单 agent 模式)
  │
  └─ 结果: 至少能找到一个 agent 处理，不会直接失败
```

---

## 四、修复的问题汇总

### P0-1: Gate1 逻辑反转 ✅ 已修复
- **问题**: `_shouldUseDispatcher()` 使用 negation (PURE_CHAT) 作为主要判断
- **修复**: 改为 affirmation 策略，DISPATCHER_KWS 优先匹配
- **影响**: 更多任务正确进入 Dispatcher

### P0-2: Planner 对自查任务的不一致性 ✅ 已修复
- **问题**: "排查一下你自己" 每次被 Planner 拆解成不同的 subTasks
- **修复**: self_checker 加入 `skip_planner: true`，Planner system prompt 增加固定流程
- **影响**: 自查任务 100% 确定性输出

### P1-1: dispatch_rules.json 缺少 self_checker ✅ 已修复
- **问题**: 没有 `skip_planner` 配置
- **修复**: 添加 self_checker 角色及其固定流程
- **影响**: 支持固定流程路由

### P1-2: 缺少 fixedFlow 执行路径 ✅ 已修复
- **问题**: `_runPanguDispatcherLoop` 没有处理 skip_planner 角色
- **修复**: 添加 `_matchSkipPlannerRole()` + `_buildFixedSubTasks()` + 固定流程执行
- **影响**: skip_planner 角色直接执行固定任务，跳过 LLM Planner

### P1-3: Planner 失败缺少关键词兜底 ✅ 已修复
- **问题**: Planner 失败或返回空时直接降级到 Legacy 单 agent
- **修复**: 添加 `_keywordFallback()`，Planner 失败时先尝试关键词路由
- **影响**: 即使 LLM 服务异常，仍能通过关键词找到合适的 agent

---

## 五、新增函数说明

### 5.1 `_matchSkipPlannerRole(userInput, configPath)`
- **位置**: `pangu-single.js:1395`
- **功能**: 扫描 `dispatch_rules.json`，检查是否有 `skip_planner=true` 的角色匹配当前输入
- **返回**: `{ role, fixed_agents, fixed_tasks, score }` 或 `null`
- **调用时机**: `_runPanguDispatcherLoop` 入口处，Planner 之前

### 5.2 `_buildFixedSubTasks(fixedAgents, fixedTasks)`
- **位置**: `pangu-single.js:1441`
- **功能**: 将 fixed_agents 和 fixed_tasks 配对，构建 subTasks 数组
- **返回**: `[{ agent, task, index, total }, ...]`
- **调用时机**: skip_planner 匹配成功后

### 5.3 `_keywordFallback(userInput, configPath)`
- **位置**: `pangu-single.js:1456`
- **功能**: 扫描所有角色的 keywords，找到匹配度最高的角色
- **返回**: `{ role, score, matchedKws }` 或 `null`
- **调用时机**: Planner 失败或返回空 subTasks 时

---

## 六、测试验证

### 6.1 测试自查固定流程（skip_planner）
```bash
curl -sN -X POST http://127.0.0.1:18901/message/stream \
  -H "Content-Type: application/json" \
  -d '{"input":"排查一下你自己","messages":[],"stream":true}' \
  --max-time 60
```
**预期**: 
- 响应中应出现 `stage: fixed_flow`
- `plan.note` 应为 `"固定流程 (skip_planner)"`
- 执行 5 个 checker 子任务
- 两次调用结果应完全一致

### 6.2 测试普通任务（走 LLM Planner）
```bash
curl -sN -X POST http://127.0.0.1:18901/message/stream \
  -H "Content-Type: application/json" \
  -d '{"input":"帮我写一个Python脚本分析日志","messages":[],"stream":true}' \
  --max-time 60
```
**预期**:
- 响应中应出现 `stage: planner`
- `plan.plan` 为 LLM 拆解的 subTasks
- 按 subTasks 执行对应 agent

### 6.3 测试关键词兜底
```bash
# 模拟 Planner 失败场景：修改代码让 subAgent.run(mode='planner') 抛异常
# 然后发送任意有操作意图的请求
curl -sN -X POST http://127.0.0.1:18901/message/stream \
  -H "Content-Type: application/json" \
  -d '{"input":"分析一下当前系统状态","messages":[],"stream":true}' \
  --max-time 60
```
**预期**:
- 响应中应出现 `stage: keyword_fallback`
- `plan.note` 应显示匹配的角色和关键词
- 至少有一个 agent 被执行

---

## 七、文件变更清单

| 文件 | 变更 | 说明 |
|------|------|------|
| `pangu-single.js` | +278 行 | 新增 3 个 helper 函数 + fixedFlow 路径 + keyword fallback |
| `config/dispatch_rules.json` | +10 行 | 新增 self_checker 角色 |
| `agents/sub-agent.js` | +20 行 | Planner system prompt 增加自查固定流程 |

---

## 八、调用规则总结

```
用户输入
  │
  ▼
Gate1: 是否走 Dispatcher?
  ├─ 是 → _runPanguDispatcherLoop()
  │   │
  │   ├─ Step 1: 检查 skip_planner
  │   │   └─ 匹配? → FixedFlow 路径 (确定性)
  │   │
  │   ├─ Step 2: 调用 LLM Planner
  │   │   ├─ 成功 → 执行 subTasks (有随机性)
  │   │   └─ 失败/空 → Step 3
  │   │
  │   └─ Step 3: 关键词兜底
  │       └─ 匹配? → 单角色执行
  │       └─ 不匹配 → Legacy 单 agent
  │
  └─ 否 → _runAgentLoopLegacyStream() (单 agent)
```

**核心原则：**
1. **确定性优先**: skip_planner 角色永远走固定流程
2. **容错优先**: Planner 失败时有关键词兜底
3. **向后兼容**: 原有 LLM Planner 路径保持不变
4. **可观测**: 每个路径都有 stage 标记，便于调试
