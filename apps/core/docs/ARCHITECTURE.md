# Pangu 架构 2026-07-18 v2

> 三层调度关系说明: Orchestrator / Dispatcher / Worker
> 解决: 哪个文件干哪个活, 名字 ≠ 角色

## 一句话总结

```
用户消息 → j2_dispatcher (入口) → dispatcher.js (8 worker + meta) → orchestrator.js (组合编排) → workers
```

---

## 三层模型

### Layer 1: Orchestrator (元编排)
- **文件**: `agents/orchestrator.js` (5KB, 154 行)
- **导出**: `Orchestrator` / `PanguOrchestrator`
- **方法**: `analyze → planner → decompose → dispatch` (4 阶段)
- **路由触发**: `POST /api/pangu/orchestrate` → `routes/agent.js:38-39`
- **作用**: 把一个大任务拆成 sub-tasks, 设计执行拓扑, 然后调 individual agents
- **谁用**: 只有 HTTP 端点用, dispatcher.js 不用

### Layer 2: Dispatcher (任务路由)
- **文件**: `agents/dispatcher.js` (25KB, 563 行)
- **导出**: `AgentDispatcher` 类 + `loadConfig`/`getEnabledModel` 等 helpers
- **方法**: `classify(task) → dispatch(task, role) → tool chain`
- **入口触发**: `_runPanguDispatcherLoop` in `modules/j2_dispatcher.js` (v2 Pangu 主循环)
- **8 角色**:
  - 7 worker: planner / analyzer / executor / checker / bug_hunter / reflector / learner
  - 1 meta: dispatcher (DispatcherAgent 自己 = meta, 只路由不执行)
- **谁用**: 全部 SSE 流式对话 + tool 调用入口

### Layer 3: Workers (实际执行)
- **文件**: `agents/{planner,analyzer,executor,...}.js`
- **统一基类**: `agents/base_agent.js`
- **每个 worker**: 接受 task, 调 tool 集, 返回 result
- **注册中心**: `agents/registry.js` → `agents/class-compat.js` (兼容老 class API)

---

## 兼容层 (过渡, 别动)

- **文件**: `agents/class-compat.js` (6.9KB)
- **作用**: 把新"实例 executor(...)" 包装成老 "Class X.execute(input)" API
- **历史**: 2026-07-11 写, 当时为了不改老的 test/harness
- **现在**: 已经稳定运行 7 天, 替代前已 unused 警告未触发, 是事实上的稳定接口

---

## 名字错位 → 真实含义对照

| 名字 | 角色 | 真位置 |
|---|---|---|
| Orchestrator | **Layer 1** | 编排/拓扑, 不常用 (HTTP 入口) |
| Dispatcher | **Layer 2** | 任务路由, 主入口 (j2 循环) |
| Worker | **Layer 3** | 7 真 worker + 1 meta (dispatcher 自己) |

**容易混淆点**: "dispatcher 既是 Layer 2 (任务路由) 名字, 又是 8 worker 之一的名字". 后者实质是 dispatcher meta (自我引用).

---

## v2 commit 历史

| commit | 内容 | 行数变化 |
|---|---|---|
| 6ce9a2e | baseline snapshot 266 files | - |
| 52a75a4 | P0+P1 fixes per deep-scan-v1 | -50 lines |
| 0d47534 | N5+B4: pangu-single.js 4279→1748 | -2531 |
| 0aef4f8 | N5 B5+B6+B7: decide/dispatch/agent_stream/dogfood 拆完 | -3005 |

主线演进: 单文件 4236→1748→拆模块→死代码清理→L2 fixes

---

## 推荐: 调用路径

```
Pangu 主对话流 (经 j2 dispatcher)
  ↓
j2_dispatcher → classify(task)  (关键词 + dispatch_rules.json scoring, 或 LLM 兜底)
  ↓
dispatcher.dispatch(task, role) → sub-agent.run (单 worker)
  ↓
worker.execute(input) → 调 工具 → 返回

vs

Pangu orchestrate HTTP 入口 (经 Layer 1)
  ↓
routes/agent.js:38-39 直接 require orchestrator.js
  ↓
PanguOrchestrator.analyze + planner + decompose + dispatch
  ↓
组合 multi-agent 结果, 综合输出
```

---

## 不要做的事

- **不要在 dispatcher.js 里改 Layer 1 的编排逻辑** — 那不是它的活
- **不要删 class-compat.js** — 旧 test 还在用, 而且 worker 8 个 class 全过这道手
- **不要把 orchestrator.js 改名 dispatcher.js** — 名字错位但稳定, 改了反而坏 8 agent 注册链
