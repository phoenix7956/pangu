# Pangu 4 场景 Prompt 模板
**版本**: 0.5.1 · 2026-07-06

## 4 决策场景

| 场景 | 输入示例 | 输出契约 |
|---|---|---|
| **arch** (架构决策) | "选 React 还是 Vue" | `{decision: {options: [...], rationale: '...'}}` |
| **tech** (技术选型) | "用 PostgreSQL 还是 MySQL" | `{decision: {recommendation: '...', tradeoffs: [...]}}` |
| **risk** (风险评估) | "上线这个功能有什么风险" | `{decision: {top_3_risks: [{risk, severity, mitigation}, ...]}}` |
| **refactor** (重构路径) | "这个烂代码怎么改" | `{decision: {phases: [{phase, tasks, duration}, ...]}}` |

## 输出统一(规划中)

未来 4 场景统一为 `unified: {summary, options, rationale}` 顶层结构, 详见 OPT-5。
