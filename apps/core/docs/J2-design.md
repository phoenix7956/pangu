# Pangu J2 模式设计 — Model-Agnostic Agent Loop

> 老板拍 2026-07-08 11:55。Pangu 必须 model-agnostic:**"盘古无论用什么模型,功能都应该能用才对"**

## 1. 背景与动机

### 现状问题
- Pangu 后端 `_handlePanguAgentStream` 强依赖 LLM 原生 `tool_call` (`response.choices[0].message.tool_calls`)
- 当用 **MiniMax-M3 / Qwen-3.6-35b**(不支持 tool_call) 时,LLM 只会回文本,后端把它当"最终答案"返回 → **agent 能力完全废**
- 老板原话:"盘古无论用什么模型,功能都应该能用才对"

### J2 模式目标
- LLM 不支持原生 tool_call 时,Pangu 后端解析 LLM 自然语言输出中的 `<tool>` 块,自动调工具
- **LLM 只组织答案 + 输出结构化工具调用指令,工具执行交给后端**

### 不破坏现有
- 支持 tool_call 的模型(Gemma-4-26b-agent / Claude / GPT-4)继续走原路径(快,稳定)
- 只对"不支持 tool_call"的模型启用 J2(慢一点,但能用)

---

## 2. 现状扫描

| 项 | 位置 (line) | 说明 |
|---|---|---|
| Agent 端点 | `/api/pangu/agent/stream` → `_handlePanguAgentStream` (line 569) | 入口 |
| LLM 调用 | `_callLLMForAgent` (line 462) | 加 tools 参数 |
| OpenAI tool_call 解析 | `_extractToolCallsOpenAI` (line 419) | `result.choices[0].message.tool_calls` |
| Anthropic tool_use 解析 | `_extractToolCallsAnthropic` (line 411) | `result.content[type=tool_use]` |
| 工具定义加载 | `_loadToolsSchemaForLLM` (line 384) | 过滤 whitelist 后转 OpenAI functions 格式 |
| Agent 工具白名单 | `AGENT_TOOL_WHITELIST` (line 375) | 9 个核心工具 |
| Sandbox 检查 | `checkToolCall` (line 696) | 危险命令拦截 |
| 并发执行 | `isConcurrencySafe` (line 700) | safe 并发 / unsafe 串行 |
| L1 落盘 | `_recordEvolution` (line 1372) | dogfooding |
| 会话记忆 | `_recordSessionToMemory` (line 1246) | 写 sessions/{date}.md |

### tool_call 失败时返回什么
当 LLM 不返回 `tool_calls` 字段时,`_handlePanguAgentStream` 直接把 `textContent` 当最终答案 SSE 推完,**没有任何工具被调**。这就是 MiniMax-M3 模式下 Pangu 不能"做事"的根因。

---

## 3. J2 设计

### 3.1 触发判定 (`_detectToolCallSupport`)

启动时探测一次,缓存到 session:

```js
async function _detectToolCallSupport(model) {
  // 发最小请求: tools=[{ echo }], 看返回的 tool_calls 字段
  const result = await _callLLMForAgent(
    [{ role: 'user', content: 'ping' }],
    model,
    [{ type: 'function', function: { name: 'echo', description: 'echo', parameters: { type: 'object', properties: { msg: { type: 'string' } } } } }]
  );
  if (isAnthropic) {
    return Array.isArray(result.content) && result.content.some(b => b.type === 'tool_use');
  }
  return Array.isArray(result.choices?.[0]?.message?.tool_calls) && result.choices[0].message.tool_calls.length > 0;
}
```

判定规则:
- 返 200 + `tool_calls` 非空 → 支持
- 返 200 + `tool_calls` 为空/null/不存在 → 不支持
- 返 4xx → 抛错(其他问题,不动流程)

**缓存策略**:`_config.llm.models[].tool_call_support_cache` 按 model.id 缓存(进程级,重启重测)。

### 3.2 J2 prompt 模板 (`PROMPT_AGENT_LEGACY`)

不放 `tools` 字段给 LLM,改在 system prompt 末尾加一段:

```text
[Legacy Tool Mode - J2]
你的模型不支持原生 tool_call。改用以下方式:

需要工具时,在回答末尾输出 1+ 个 <tool> 块:
<tool name="read_file">{"path": "/Users/you/foo.md"}</tool>
<tool name="exec_command">{"cmd": "ls -la"}</tool>

多个工具可一次输出多个 <tool> 块。
输出工具调用后停止,等系统返回结果。

可用工具 (高价值子集):
- read_file(path): 读文件
- write_file(path, content): 写文件
- file_edit(path, oldText, newText): 精确替换
- list_directory(path): 列目录
- exec_command(cmd): 跑 shell
- web_search(query): 搜网
- web_fetch(url): 抓 URL
- memory_search(query): 搜长期记忆
- memory_read(path): 读 MEMORY.md 片段
- task_done(summary): 任务完成

注意:
- JSON 必须合法 (用 " 双引号,无尾逗号)
- 一次最多 3 个工具
- 工具调用块用单独段落,跟思考分开
- 拿到工具结果后,继续组织最终答案
```

### 3.3 输出解析 (`_extractToolCallsFromText`)

```js
function _extractToolCallsFromText(text) {
  // 匹配 <tool name="xxx">{json}</tool> 块 (贪婪到第一个 </tool>)
  const re = /<tool\s+name="([a-z_]+)">([\s\S]*?)<\/tool>/g;
  const calls = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    let params = {};
    try { params = JSON.parse(m[2]); } catch (e) { continue; /* skip malformed */ }
    calls.push({ name: m[1], params, raw: m[0] });
  }
  return calls;
}
```

### 3.4 J2 循环 (`_runAgentLoopLegacyStream`)

```
1. 发 prompt (含系统提示 [Legacy Mode] + 历史 + 用户问题)
   - 注意: 不传 tools 字段
   - 用 _callLLMForAgent 拿完整 LLM 输出 (一次性, 不流式 — 简化)
2. 解析输出:
   - _extractToolCallsFromText(textContent) → toolCalls[]
3. 没有 toolCalls → 视为完整回答,流式推 SSE chunk,结束
4. 有 toolCalls → 
   - 推 tool_call 事件 (UI 能看到)
   - 跑 sandbox check + tool 执行 (并发/串行逻辑复用现有 isConcurrencySafe)
   - 推 tool_result 事件
   - 把 tool 结果拼成 user 消息:
     <tool_result name="read_file">
     {"ok": true, "content": "..."}
     </tool_result>
   - 跳回 1
5. 最多 5 轮 (避免无限循环)
```

### 3.5 双路径自动分流 (`_handlePanguAgentStream`)

```js
// 在原 for-loop 之前:
const toolCallSupported = await _detectToolCallSupport(model);
if (!toolCallSupported) {
  console.log('[agent] model', model.id, '不支持 tool_call, 启用 J2 模式');
  return _runAgentLoopLegacyStream(messages, model, req, res, opts);
}
// 否则走原 _handlePanguAgentStream 内部 for-loop
```

**注意**:为不破坏现有结构,把 J2 模式做**完整独立函数**,只在入口分流一次。两种模式共享:
- `_loadToolsSchemaForLLM` (拿 schema 用于探测)
- `TOOLS` / `checkToolCall` / `isConcurrencySafe` (执行工具)
- `_recordEvolution` (L1 落盘)
- `_recordSessionToMemory` (会话记忆)

---

## 4. 实现要点

### 4.1 文件
- `/Users/you/Applications/pangu/pangu-single.js` — 改这一个文件
- `/Users/you/Applications/pangu/tests/test_j2_legacy_mode.js` — 新增测试
- `/Users/you/Applications/pangu/docs/J2-design.md` — 本文档

### 4.2 代码量预估
| 函数 | 行数 | 说明 |
|---|---|---|
| `_detectToolCallSupport(model)` | ~40 | 探测 + 缓存 |
| `PROMPT_AGENT_LEGACY` | ~30 | prompt 字符串 |
| `_extractToolCallsFromText(text)` | ~20 | 正则解析 |
| `_runAgentLoopLegacyStream(messages, model, req, res)` | ~120 | J2 主循环 |
| 入口分流 | ~10 | 加在 `_handlePanguAgentStream` 顶部 |
| **总计** | **~220 行** | 含注释 |

### 4.3 不动的东西
- ❌ `_filterEmptyUserMessages`(如果存在)
- ❌ `_limitContextWindow`(如果存在)
- ❌ `recordEvolution` L1 落盘逻辑本身(只复用)
- ❌ 其他端点 (`/chat`, `/api/chat`, `/message/stream`)
- ❌ bootInfo / 老路由 / cron / watchdog

---

## 5. 测试策略

### 5.1 单元测试 (无 LLM 调用)
`tests/test_j2_legacy_mode.js`:
- `_extractToolCallsFromText`: 5 个 case
  1. 单个 tool: `<tool name="read_file">{"path":"/a.md"}</tool>`
  2. 多个 tool: 两个连续的 tool 块
  3. 嵌套 JSON: params 含对象 `{"path":"x","options":{"recursive":true}}`
  4. 错误 JSON: `<tool name="x">{not json}</tool>` → 应跳过
  5. 嵌套在回答中: 文本里嵌 1 个 tool 块 → 应解析

- `_detectToolCallSupport`: 2 个 case (mock)
  1. Gemma-4 (gemma-4-agent) → true
  2. MiniMax-M3 → false

### 5.2 端到端 (用真 LLM, USE_MAIN=1)
- **场景 1**: Pangu + MiniMax-M3,问题"读 /Users/you/.pangu/evomap/top5_recommended.md",验证:
  - 工具被调(看 tool_call event)
  - 文件内容被读出
  - LLM 拿到结果后整理答案
  
- **场景 2**: Pangu + Gemma-4-26b-agent,同问题,验证:
  - 走原 tool_call 路径(快)
  - 仍能拿到文件内容
  
- **场景 3**: Pangu + MiniMax-M3,问题"算一卦,乾为天",验证:
  - 64 卦推理仍工作
  - J2 模式下答案正常

### 5.3 回归
- 跑 `tests/test_pangu_decide.js` + `tests/test_pangu_agent.js`,确认不退化
- `curl /health` 验证进程存活

---

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| LLM 输出乱码 JSON 解析失败 | `_extractToolCallsFromText` try/catch 单个跳过,不中断循环 |
| LLM 不按规则输出 tool 块 | prompt 里强调格式 + 5 轮兜底(空轮直接退) |
| J2 流式输出有延迟 | 第一版用 non-streaming 调 LLM,简单稳;v2 再加 stream |
| 误判 tool_call 支持 | 探测加 timeout 5s,失败默认按不支持走(J2 更稳) |
| 工具 schema 不在 prompt 里,LLM 不知道有 task_done | prompt 列了 10 个核心工具,够用 |

---

## 7. 工时

| 阶段 | 估时 |
|---|---|
| 现状扫描 | 30 min |
| 设计文档 (本文) | 30 min |
| 实现 | 2-3 h |
| 测试 | 1 h |
| **总** | **4-5 h** |

---

*老板拍: 盘古 model-agnostic — J2 模式打通 MiniMax-M3 不可用问题*