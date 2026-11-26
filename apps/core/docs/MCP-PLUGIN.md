# Pangu MCP 插件开发指南
**版本**: 0.5.1 · 2026-07-06

## 概述
Pangu 是 MCP client, 可加载任意 MCP server 作为外部工具。

## 快速开始
1. 在 `mcp_servers/<your-plugin>/` 下创建 `server.js`, 实现 MCP 协议
2. 在 `config/mcp_servers.json` 注册:
```json
{
  "servers": [
    {"name": "my-plugin", "transport": "stdio", "command": "node", "args": ["mcp_servers/my-plugin/server.js"], "enabled": true}
  ]
}
```
3. 重启 Pangu, 在 UI 设置 → MCP 查看

## 约束
- 独立运行, **不依赖 OpenClaw / Hermes / Claude Code**
- 单文件 < 5MB
- 启动时间 < 3s
