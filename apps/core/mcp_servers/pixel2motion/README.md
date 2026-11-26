# Pixel2Motion MCP Server (简化版)

> **战略定位**: Pangu 端到端推理验证工具 (B6)
>
> 老板拍板的 Pangu 验证路径: 用户输入 logo SVG + 任务描述 → Pangu 8 维向量推理 → LLM 读卦决策 → 调 Pixel2Motion MCP → 输出动效 HTML
>
> **关键是 Pangu 推理要决定 motion_type 等参数**（5 种动效模板），所以这个 MCP 工具必须够丰富才能验证 Pangu 推理价值。

---

## 概览

| 项 | 值 |
|---|---|
| Server name | `pixel2motion` |
| Tool name | `animate_logo_svg` |
| Transport | stdio (JSON-RPC 2.0, line-delimited) |
| 风格 | CommonJS, 零外部依赖 |
| 协议版本 | `2024-11-05` |
| 位置 | `/Users/you/Desktop/pangu/mcp_servers/pixel2motion/` |

## 文件结构

```
mcp_servers/pixel2motion/
├── server.js              # MCP server (stdio JSON-RPC, 0 deps)
├── tests/
│   └── test_pixel2motion.js   # 134 项断言测试
├── README.md              # 本文档
└── (no package.json — 零依赖)
```

## Tool 接口

### `animate_logo_svg(svg, motion_type, duration_ms, easing, output_format?)`

#### 参数 (JSON Schema)

| 字段 | 类型 | 必填 | 取值 / 范围 | 说明 |
|---|---|---|---|---|
| `svg` | string | ✅ | 1B - 1MB, 必须含 `<svg` 或 `<?xml` | SVG 源文件内容 |
| `motion_type` | enum | ✅ | `fade-in` \| `scale-up` \| `rotate` \| `draw-on` \| `bounce` | 动效类型 (Pangu 推理决定) |
| `duration_ms` | number | ✅ | 500 - 5000 | 动效时长 |
| `easing` | enum | ✅ | `linear` \| `ease` \| `ease-in` \| `ease-out` \| `ease-in-out` | 缓动函数 |
| `output_format` | enum | ❌ | `html` (默认) \| `svg-with-css` | 输出格式 |

#### 返回 (JSON)

成功:
```json
{
  "ok": true,
  "html": "<!DOCTYPE html>...完整 HTML...",
  "svg_size": 76,
  "css_keyframes": "p2m-scale-up-ease-out",
  "render_time_ms": 0
}
```

失败 (`isError: true`):
```json
{
  "ok": false,
  "error": "motion_type must be one of fade-in|scale-up|rotate|draw-on|bounce, got: \"wrong-type\""
}
```

## 5 种动效 CSS 模板

| motion_type | CSS 效果 | 关键 CSS |
|---|---|---|
| **fade-in** | opacity 0 → 1 | `from { opacity: 0; } to { opacity: 1; }` |
| **scale-up** | transform: scale(0.3) → scale(1) | `from { transform: scale(0.3); opacity: 0; }` |
| **rotate** | rotate(-180deg) → rotate(0deg) | `from { transform: rotate(-180deg); opacity: 0; }` |
| **draw-on** | stroke-dasharray + stroke-dashoffset 描边 | `from { stroke-dasharray: 1000; stroke-dashoffset: 1000; }` |
| **bounce** | translateY(0) ↔ translateY(-30px) | `0% { translateY(0); } 50% { translateY(-30px); } 100% { translateY(0); }` |

每个 `(motion_type, easing)` 组合有独立 keyframe 名: `p2m-{motion_type}-{easing}`。

## 安装 / 注册

配置文件: `/Users/you/Desktop/pangu/config/mcp_servers.json`

```json
{
  "name": "pixel2motion",
  "transport": "stdio",
  "command": "node",
  "args": ["/Users/you/Desktop/pangu/mcp_servers/pixel2motion/server.js"],
  "env": {},
  "enabled": true,
  "description": "简化版 Pixel2Motion — 把 SVG logo 变成动效 HTML (B6 Pangu 端到端推理验证工具)"
}
```

## 用法

### 1. 启动 / 重启 Pangu (自动加载 MCP)

```bash
# 查 Pangu PID
lsof -ti:18901
# kill (launchd 自动重启)
kill <PID>
sleep 3
```

### 2. 验证 MCP 注册成功

```bash
curl -s http://127.0.0.1:18901/api/mcp/servers | python3 -m json.tool
# 应看到 pixel2motion + pangu-crawler 两个 server, 都 status=connected
```

### 3. 测试 animate_logo_svg 工具

```bash
curl -X POST http://127.0.0.1:18901/api/mcp/call \
  -H "Content-Type: application/json" \
  -d '{
    "server":"pixel2motion",
    "tool":"animate_logo_svg",
    "args":{
      "svg":"<svg viewBox=\"0 0 100 100\"><circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"red\"/></svg>",
      "motion_type":"scale-up",
      "duration_ms":1500,
      "easing":"ease-out"
    }
  }'
```

## 测试

```bash
node /Users/you/Desktop/pangu/mcp_servers/pixel2motion/tests/test_pixel2motion.js
```

**当前结果**: 134/134 断言通过 (0 失败)

覆盖:
- ✅ 5 种 motion_type 都能生成有效 HTML
- ✅ 5 种 easing 都能正确注入 CSS
- ✅ duration_ms 边界值 (500/1000/3000/5000)
- ✅ HTML 结构完整 (DOCTYPE / svg / style / keyframes)
- ✅ output_format=svg-with-css 模式
- ✅ 输入校验失败 (motion_type 错 / duration 错 / easing 错 / svg 缺失)
- ✅ SVG 字符数正确传递
- ✅ unknown tool 错误处理
- ✅ ping 兼容

## Pangu 端集成 (下一步)

1. 在 `pangu-single.js` 给 LLM 暴露 `mcp_animate_logo_svg` tool
2. LLM 收到 Pangu 8 维向量 → 读卦 (64卦语义) → 决定 `motion_type` + `easing` + `duration_ms`
3. 调本 MCP 工具 → 把返回的 HTML 渲染给用户

## 设计原则

- **零依赖**: stdio MCP 协议手写 JSON-RPC, 不用 `@modelcontextprotocol/sdk`, 装即用
- **CommonJS**: 跟 pangu-crawler 一致, 跟 Pangu 主项目一致
- **路径绝对**: 配置文件用绝对路径, 不依赖 cwd
- **错误透传**: 校验失败用 `isError: true` + `ok: false` 双重信号, LLM 端能区分 "工具执行失败" vs "参数错误"
- **无副作用**: 不写文件, 不发网络请求, 完全 in-process 纯函数

---

*更新: 2026-06-19*
