# Pangu Tools — 完整参考 (2026-06-25 15:03)

> **70 个 in-process tool** + **43 个 MCP tool**(4 个 MCP server)
> **100% LLM 全暴露**(exposed_to_llm = 70, 总数 = 70)
> 安全: `ALLOWED_TOOLS` 白名单 + `DANGEROUS_PATTERNS` 拦截

## 目录

1. [64 卦业务工具](#64-卦业务工具-24-个)
2. [文件 I/O](#文件-io-8-个)
3. [网络/信息](#网络信息-7-个)
4. [缓存](#缓存-5-个)
5. [系统/监控](#系统监控-5-个)
6. [时间/辅助](#时间辅助-4-个)
7. [OS (P0-3)](#os-工具-p0-3-3-个)
8. [TTS (P0-3 + 后续)](#tts-2-个)
9. [数据/财务](#数据财务-2-个)
10. [翻译](#翻译-1-个)
11. [集成](#集成-3-个)
12. [协作](#协作-3-个)
13. [权限](#权限-2-个)
14. [资源](#资源-1-个)
15. [剪贴板](#剪贴板-2-个)
16. [压缩](#压缩-2-个)

---

## 64 卦业务工具 (24 个)

Pangu 核心 — 接 `skillContext` 真实数据,六爻路由层注入。

### 谋 (规划/预判)

| Tool | 用途 | 返回示例 |
|------|------|---------|
| `situation_check` | 当前形势判断 | `{situation: "EMERGING", description: "..."}` |
| `initial_assessment` | 初步评估 | ... |
| `caution_signal` | 警示信号 | ... |
| `wait_action` | 等待动作 | ... |
| `signal_detection` | 信号检测 | ... |
| `trend_judgment` | 趋势判断 | ... |
| `opportunity_check` | 机会检查 | `{opportunity: "EMERGING/OPTIMAL/NOT_YET"}` |
| `first_step` | 第一步 | ... |
| `patience_manager` | 耐心管理 | ... |
| `dilemma_resolution` | 两难解决 | ... |
| `stakeholder_check` | 利益方检查 | ... |
| `steady_action` | 稳态动作 | ... |

### 断 (决策)

| Tool | 用途 | 返回示例 |
|------|------|---------|
| `critical_point_analysis` | 临界点分析 | `{point: "CRITICAL_NODE", stage: "临界点"}` |
| `breakthrough_check` | 突破检查 | ... |
| `direction_decision` | 方向决策 | ... |
| `risk_assessment` | 风险评估 | ... |
| `momentum_assessment` | 动能评估 | `{momentum: "PEAKING/WEAKENING/BUILDING"}` |
| `main_force_analysis` | 主力分析 | ... |
| `peak_judgment` | 顶峰判断 | ... |
| `full_deployment` | 全面部署 | ... |
| `peak_detection` | 顶峰检测 | ... |
| `reversal_signal` | 反转信号 | ... |
| `withdrawal_plan` | 撤退计划 | ... |
| `graceful_exit` | 优雅退出 | ... |

---

## 文件 I/O (8 个)

| Tool | 参数 | 说明 |
|------|------|------|
| `read_file` | `{path, offset?, limit?}` | 读文件(支持行号偏移) |
| `write_file` | `{path, content}` | 写文件(覆盖) |
| `file_edit` | `{path, oldText, newText}` | 精确编辑(单点替换) |
| `list_directory` | `{path}` | 列目录 |
| `file_grep` | `{path, pattern}` | grep 文件内容 |
| `file_find` | `{path, pattern}` | 找文件 |
| `search_files` | `{path, query}` | 高级搜索 |
| `exec_command` | `{command, timeout?, cwd?}` | 跑命令(带危险拦截) |

**安全**: `DANGEROUS_PATTERNS` 拦 `rm -rf /`, `sudo`, `dd if=`, `curl|sh` 等 14 种

---

## 网络/信息 (7 个)

| Tool | 用途 | 数据源 |
|------|------|--------|
| `web_search` | 通用搜索 | DuckDuckGo / Bing / SearxNG |
| `web_fetch` | 抓取 URL | HTTP GET |
| `weather_check` | 天气查询 | wttr.in |
| `news_digest` | 新闻摘要 | RSS feeds |
| `translate_text` | 翻译 | Lingva Translate |
| `github_api` | GitHub 操作 | REST API |
| `send_wechat` | 微信发送(单条) | itchat-style bridge |

---

## 缓存 (5 个)

| Tool | 用途 |
|------|------|
| `cache_get` | 取缓存 |
| `cache_put` | 写缓存 |
| `cache_preheat` | 预热 |
| `cache_evict` | 清缓存 |
| `cache_stats` | 缓存统计 |

---

## 系统/监控 (5 个)

| Tool | 用途 |
|------|------|
| `system_info` | 系统信息(Mac/Win/Linux) |
| `process_list` | 进程列表 |
| `network_check` | 网络连通性 |
| `http_check` | HTTP 状态码 |
| `screenshot` | 截图(macOS) |

---

## 时间/辅助 (4 个)

| Tool | 用途 |
|------|------|
| `current_time` | 当前时间(多时区) |
| `sleep_timer` | 延时 |
| `currency_check` | 汇率查询 |
| `crypto_price` | 加密货币价格 |

---

## OS 工具 (P0-3) (3 个)

| Tool | 参数 | 跨平台 |
|------|------|--------|
| `get_lan_ip` | `{interface?, family?}` | ✅ macOS/Linux/Win |
| `set_env_path` | `{action, value, replace?}` | ✅ |
| `run_installer` | `{path, mode, target?, user_confirmed?}` | ⚠️ macOS only (`.pkg`) |

---

## TTS (2 个)

| Tool | 参数 | 说明 |
|------|------|------|
| `tts_speak` | `{text, voice?, output?, speed?, play?}` | macOS `say` 转 .aiff |
| `tts_voices` | `{}` | 列声线(优先中文) |

> 推荐中文声线: `Tingting` / `Meijia`
> 全部 Pangu 内置实现 (§9 独立原则)

---

## 数据/财务 (2 个)

| Tool | 用途 |
|------|------|
| `currency_check` | 实时汇率 |
| `crypto_price` | BTC/ETH 等价格 |

---

## 翻译 (1 个)

| Tool | 参数 |
|------|------|
| `translate_text` | `{text, source_lang?, target_lang}` |

---

## 集成 (3 个)

| Tool | 用途 |
|------|------|
| `github_api` | issues / PR / release |
| `send_wechat` | 发微信(单条) |
| `archive_create` | 压缩包(tar/zip) |
| `archive_extract` | 解压 |

---

## 协作 (3 个)

| Tool | 用途 |
|------|------|
| `batch_execute` | 批量跑多个 tool |
| `team_dispatch` | 派活给 sub-agent |

---

## 权限 (2 个)

| Tool | 用途 |
|------|------|
| `permission_check` | 检查权限(读/写/执行) |
| `permission_grant` | 显式授权 |

---

## 资源 (1 个)

| Tool | 用途 |
|------|------|
| `resource_pool` | CPU/内存/磁盘 配额管理 |

---

## 剪贴板 (2 个)

| Tool | 用途 |
|------|------|
| `clipboard_read` | 读 macOS pbpaste |
| `clipboard_write` | 写 pbcopy |

---

## 压缩 (2 个)

| Tool | 用途 |
|------|------|
| `archive_create` | tar/zip 压缩 |
| `archive_extract` | 解压 |

---

## 统计

| 指标 | 值 |
|------|---|
| **总 tool 数** | **70** |
| **ALLOWED_TOOLS 覆盖** | **100%** (70/70) |
| **分类数** | 16 |
| **MCP tools** | 43 (4 个 server: pixel2motion / pangu-crawler / github-mcp / filesystem-mcp) |
| **LLM 总可见 tool** | **70 + 43 = 113** |

---

## 安全机制(双重)

1. **ALLOWED_TOOLS 白名单** (`modules/sandbox.js`): 默认 100% 开放
2. **DANGEROUS_PATTERNS** 拦截 (`modules/sandbox.js`): 14 种危险模式
   - `rm -rf /` / `rm -f /`
   - `sudo`
   - `mkfs`
   - `dd if=`
   - `curl | sh` / `wget | sh`
   - `chmod -R 777 /`
   - `chown -R /`
   - `> /dev/sda`
   - `shutdown` / `reboot`
   - `kill -9 1`
   - fork bomb `:(){:|:&};:`
   - `eval`
   - bashrc 注入 `source ~/.bashrc; rm`

---

## 历史

- **2026-06-15 P0-1**:触发词匹配,top-K 爻注入 LLM system
- **2026-06-21 W4-K2**:MVP 工具集(20 个谋断+核心)— 当时 n_ctx=4096 太紧
- **2026-06-25 P0-3**:加 3 个 OS 工具(get_lan_ip/set_env_path/run_installer)
- **2026-06-25**:加 2 个 TTS 工具(tts_speak/tts_voices)
- **2026-06-25 15:03**:**全暴露 70 个工具 + 扩 ALLOWED_TOOLS + 写 README** ← 你正在看