# Pangu HTTP API 文档
**版本**: 0.5.1 · 2026-07-06

## 基础信息
- 默认端口: `18901`
- 默认绑定: `127.0.0.1` (0.5.1 起)
- 鉴权: 远端请求需 `Authorization: Bearer ${PANGU_HTTP_TOKEN}` 或 `?token=xxx`
- 鉴权豁免: `/health`, `/setup-status`, 本地 loopback

## 端点列表

| Method | Path | 用途 |
|---|---|---|
| GET | `/health` | 服务健康 |
| GET | `/setup-status` | 引导状态 (本地 LLM / 模型池) |
| POST | `/api/chat` | 单轮对话 |
| POST | `/api/chat/stream` | 流式对话 (SSE) |
| POST | `/api/message` | 简化对话 (含 vision) |
| POST | `/api/pangu/decide` | 64 卦推理决策 |
| POST | `/api/pangu/orchestrate` | 8 Agent 集群调度 |
| POST | `/api/pangu/agent` | 单 agent 调用 (block/async) |
| GET | `/api/pangu/agent/status/{task_id}` | 轮询后台任务 |
| POST | `/api/llm/models` | 增删改模型池 |
| GET | `/api/llm/preset/{key}` | 单个 provider preset |
| GET | `/api/mcp/servers` | MCP server 列表 |
| POST | `/api/mcp/call` | MCP 工具调用 |
| GET | `/api/pangu/evolution` | 进化账本汇总 (总量 / 成功率 / 最近 20 条) |
| GET | `/api/pangu/evolution/series` | 进化账本**逐日序列** (工作台「进化」页画趋势图用; `?days=60` 默认 60 天, `days=0` 全量) |
| POST | `/api/credentials` | 凭证增删改查 |

## 详细

### POST /api/chat
**Request**:
```json
{
  "messages": [{"role":"user","content":"..."}],
  "max_tokens": 2048,
  "tools": []   // 可选, 不传则用 MVP_TOOLS_SCHEMAS
}
```
**Response**:
```json
{
  "text": "...",
  "raw": {...}
}
```

### POST /api/chat/stream (SSE)
- 事件类型: `chunk` (文本), `tool_call` (工具调用), `done` (结束)
- `event: done` payload: `{"input": 0, "output": <总字符数>}`

### POST /api/pangu/orchestrate
**Request**:
```json
{"task": "做 Pangu 新功能", "ctx": {}}
```
**Response**:
```json
{
  "ok": true,
  "results": {"executor": {...}, "analyzer": {...}, ...},
  "synthesis": "...",
  "reflection": {...}
}
```

## 错误码
| Code | HTTP | 含义 |
|---|---|---|
| `INPUT_REQUIRED` | 400 | input 缺失 |
| `MESSAGES_REQUIRED` | 400 | messages 缺失 |
| `NO_MODEL_CONFIG` | 400 | 模型未配置 |
| `UNAUTHORIZED` | 401 | 鉴权失败 |
| `RATE_LIMITED` | 429 | 限流 |
| `AUTH_DISABLED` | 503 | 未设 PANGU_HTTP_TOKEN 拒绝远端 |
| `SANDBOX_BLOCKED` | 403 | 沙箱拦截 |
| `TOOL_EXCEPTION` | 500 | 工具抛异常 |
