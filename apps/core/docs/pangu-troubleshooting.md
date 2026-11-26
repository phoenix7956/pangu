# 盘古 排查文件

> 生成时间:2026-06-15 08:25(GMT+8)/ Mon Jun 15 00:25 UTC
> 盘古自查自改记录

---

## 0. 当前生产状态(刚查的)

| 项 | 实际值 | 判定 |
|---|---|---|
| 进程 PID | 5978(`pangu-single.js`) | 跑了 7h29m,稳定 |
| 端口 | 18901 LISTEN | ✅ |
| `/health` | `{"ok":true,"mode":"commercial","plan":"trial",...}` | ✅ |
| uptime | 27344 s(7.6 h) | 凌晨 00:41 重启后没再动 |
| 内存 | 62 MB / normal | ✅ |
| eventLoop delay | 0 ms | ✅ |
| crash 计数 | 0 | ✅ |
| license | trial,`expires_at=2026-07-03` | ✅ 19 天可用 |
| /message 非流式 | 200 OK 返文本 | ✅ 跑通 |
| /message/stream 流式 | 推 `event: chunk/done` | ✅ 跑通 |
| /chat 流式 | `error: messages required` | ⚠️ 字段不匹配 |
| /skills | `count:0`(目录有 387 文件) | ❌ **SkillRuntime 未加载** |
| /config | 200 OK 返回完整配置 | ✅ |
| /license/status | trial,active | ✅ |
| audit log | `~/.openclaw/workspace/audit/pangu-tools.log` 12 KB | ✅ 在记 |

**LLM 模型**:`MiniMax-M3`(云,minimax-cn),`openai_base_url=https://api.minimaxi.com/v1`
**降级本地**:LM Studio 1234 + `qwen/qwen3.6-35b-a3b`,协议 `anthropic`
**当前路由**:`provider=openai`(用云)→ `device:openai` 在 SSE done 事件中确认

---

## 1. 凌晨 00:41 改了什么(对比 bak-20260614-2134)

### 1.1 `pangu-single.js`(57009→70625,+13.6 KB)

**改 1:流式解析支持 tool_use 块累积**(`parseAnthropicSseDeltaStream`)
- 旧代码只 yield `text delta`,遇到 Anthropic 协议的 `content_block_start/delta/stop` 三个 tool_use 事件**全忽略**
- 新代码 yield 三种事件:
  - `{ delta: '...' }` — 文本块增量
  - `{ toolUse: {id, name, input} }` — tool_use 块完成时推(content_block_stop)
  - `{ done: true }` — message_stop
- 累积方式:`pendingToolUse` 对象,`input_json_delta.partial_json` 字符串拼接,块完成时 `JSON.parse`
- parse 失败兜底:`input = { _raw: inputRaw }` 不丢
- 注释写明:**老板 Pangu UI 流式体验不完整**(tool_use 看不到)

**改 2:加 `_executeTool` 统一入口**(在 `_pushToolResult` 之前)
- 1. 调 `panguSandbox.checkToolCall(name, args)` 做白名单 + 路径 + 危险命令检查
- 2. 查 `panguToolsImpl[name]`,没实现返 `{ok:false, error:'tool 未实现: '+name}`
- 3. 执行 + `panguAudit.logToolCall(...)` 写日志
- 4. 返回统一 `{ok, data, error}`
- 引入 3 个新 require:`panguSandbox` / `panguAudit` / `panguToolsImpl` / `panguToolsSchemas`

**改 3:`MVP_TOOL_NAMES` 5 核心(老板 6-14 拍)**
```
list_directory / read_file / file_grep / exec_command / web_search
```
- 注释明确:**qwen3.6-35B-A3B 4bit 在 32 个 tool 时会选错,5 个稳定** → 24 卦象业务工具明天加

**改 4:`_pushToolResult` 通用化(原硬编码 web_search 是 bug)**
- 旧代码:所有非 web_search 工具的 result **全被映射成 `"[web_search 工具调用失败: ...]"`** 推给 LLM → LLM 误以为没数据不总结
- 新代码:
  ```js
  const toolName = (tc && tc.function && tc.function.name) || 'unknown';
  if (result && result.error) {
    content = `[${toolName} 工具调用失败: ...]`;
  } else if (toolName === 'web_search' && result && result.results) {
    // web_search 原有逻辑保留
  }
  // 其他工具 → 走通用分支,按 result 结构格式化
  ```

---

## 2. 凌晨 00:40 之前(18:43 / 6-14)改了什么

### 2.1 `modules/health.js`(18:44 改,1 分钟前做 18:43 备份)

**改:`portCheck` 从 `exec lsof` 改 `net.connect`**
- 旧:`exec('lsof -i :18901 -sTCP:LISTEN -t')` → Pangu 后端进程内 fork lsof **失败** → catch 静默返 `false` → `port.listening` 永远 false → Pangu UI 误报"未监听"
- 新:`new net.Socket()` 自连接 `127.0.0.1:18901`,connect/timeout/error 三事件,2s 超时
- 优势:纯 Node API,1ms 极快,跨平台,不会因 Pangu 沙箱/launchd 失败
- **实测**:`/health` `port.ok=true`,延迟从 57ms 降到 3.3ms(17x),回归 100%

### 2.2 `.env` — 跟 6-13 bak **没 diff**(0 字节变化)

---

## 3. 查出来的活代码 bug(P0~P3)

### P0(影响使用)

| # | Bug | 位置 | 现象 | 根因 |
|---|---|---|---|---|
| **P0-1** | `/skills` 返回 0,但 `skills/` 目录有 387 文件 | `server_routes.js` `/skills` 路由 → `handleFn._skillRuntime._skills` | Pangu UI 看不到任何技能,LLM 也调不到 | `pangu-single.js` 启动**没初始化** `_skillRuntime`(grep 整个文件没 `_skillRuntime =`)。`/health` 也跟着报 `skills_loaded:0`。MVP 5 工具(只走 `_executeTool`)不受影响,但 24 卦象业务工具 / 384 技能全哑火。|
| **P0-2** | `.heartbeat` 6-14 16:58 之后再没写过 | `pangu-single.js` 心跳定时器 | file mtime 停在 6-14 16:58,但 `/health` 正常 → 心跳**写文件线程**死了,健康检查走的是内存指标 | 凌晨 00:11 / 00:17 还在写,之后没写。**00:41 重启前**已坏(早 16 小时),重启没修。`sessionSearch` 6-15 03:01 cron 也只能查到 6-14 16:58 前的。|

### P1(可读性/可测)

| # | Bug | 位置 | 现象 |
|---|---|---|---|
| P1-1 | `/chat` 用 `input` 字段会 500 | `server_routes.js` `/chat` 路由 | 返 `{"error":"messages required"}`。**该走 `/message` 走 `/message` 就行**,但前端/老 SDK 仍可能调 `/chat` |
| P1-2 | `MVP_TOOLS_SCHEMAS` schema 列表里**没有** `file_find` `file_ls` 等,但 sandbox 白名单有 | `pangu-single.js` 24-30 行 | 老板可以让我"列文件"用 `list_directory`,但 LLM 如果要 `file_find`(同义)会拿到 `tool 未实现` 错。**只影响 LLM 自动选 tool**,手动调不受影响 |
| P1-3 | `health.js` `tools_loaded` 写死 `Object.keys(bootInfo._TOOLS || {}).length` | `health.js` runtimeInfo | 当前报 0,因为 `pangu-single.js` 用了 `panguToolsImpl` 模块变量,没塞 `bootInfo._TOOLS`。**误导监控**。改 `panguToolsImpl` 长度即可 |

### P2(锦上添花)

| # | 项 | 说明 |
|---|---|---|
| P2-1 | UI 报"5 个 MVP 工具" | Pangu UI 还停留在 MVP 5 阶段,需要同步 schema 描述 |
| P2-2 | audit log 全是 `tier:革` | sandbox 给所有 exec 都打"革"级,没按危险程度细分。**不影响安全**,但日志噪声大 |
| P2-3 | `pangu-tools.log` 6-14 16:40 后没新条目 | 不是没调工具,是上面 P0-2 心跳死没死的问题延伸。/health / /message 都不写 audit,只有 tool 写 → 0 调用就不写。**先有调用再回看** |

### P3(风格)

| # | 项 |
|---|---|
| P3-1 | `pangu-single.js` 70 KB 单文件,凌晨又 +13 KB 到 70 KB,加 sandbox/audit/tools 3 个 require 后单文件已 4 个 require,建议下次版本拆 `pangu-single/` 目录 |
| P3-2 | `pangu-tools.log` 没按 session_id 分文件,跨 session 查要 grep |

---

## 4. 凌晨没改成的(6-15 等老板拍)

来自 6-14 22:00 session 的"明早"清单:

- 🟡 `/hexagrams` 端点缺失(活代码 bug) — `server_routes.js` 里有 `/hexagram/:id`(单数)没 `/hexagrams`(复数),前端如果调复数会 404
- 🟡 8 个根目录孤儿(CEO 改 server 前不动)
- 🟡 `.dot` 文件归档
- 🟡 `pangu-server.js` 归档
- 🟢 `ui/index.html` 70K 加废弃提示

---

## 5. 验证命令(下次开新 turn 直接复制)

```bash
# 健康
curl -sS -m 3 http://127.0.0.1:18901/health

# 流式对话
curl -sS -N -m 8 -X POST -H 'Content-Type: application/json' \
  -d '{"input":"hi","session_id":"diag-X"}' \
  http://127.0.0.1:18901/message/stream

# 非流式
curl -sS -m 8 -X POST -H 'Content-Type: application/json' \
  -d '{"input":"hi"}' \
  http://127.0.0.1:18901/message

# 心跳文件(看写没写)
ls -la /Users/you/Applications/pangu/.heartbeat

# audit tail
tail -5 ~/.openclaw/workspace/audit/pangu-tools.log
```

---

## 6. 6-15 凌晨 cron 顺带报告

`f14f10685d11` 每天 03:00 自动跑 `memory_audit.py`(**只列候选不自动删**)。
最近一次 6-15 03:01:`availableMB=1,506,266` 远高于 500 阈值,跳过清理。

---

## 7. 文件清单(防止忘了)

| 文件 | 状态 | 大小 | 改它的人 |
|---|---|---|---|
| `/Users/you/Applications/pangu/pangu-single.js` | 当前生产 | 70625 字节(6-15 00:41 改) | CEO |
| `pangu-single.js.bak-20260614-2134-tools-mvp` | 上一版准生产 | 57009 字节 | 备份点 |
| `modules/health.js` | 当前 | - | 6-14 18:44 改 |
| `modules/health.js.bak-20260614-1843-net-connect` | 上一版 | - | 备份点 |
| `archive/2026-06-15-pangu-bak/` | 24 个旧 bak 归档 | - | 6-14 22:00 |
| `~/.openclaw/workspace/audit/pangu-tools.log` | tool 审计 | 12 KB | 自动写 |

---

## 8. 我的建议执行顺序

1. **先 P0-1**(修 SkillRuntime 加载)— 影响所有 24 卦象业务 + 384 技能,**最大价值**
2. **再 P0-2**(修心跳写文件)— 改一行 setInterval 即可,但要排查为什么 16:58 死
3. 然后 P1-1(改 /chat 字段名,跟 /message 统一)
4. P1-3 顺手把 `tools_loaded` 改成读 `panguToolsImpl` 长度
5. P2~P3 等 CEO 改完 server 一起处理

要直接动 P0-1 / P0-2 改吗?P0-1 涉及决定 skill 加载策略(是 lazy 还是 boot 时全加载 387 个),这步需要你拍方向。
