# Pangu · 盘古

> 开天辟地，万物皆可为用。64 卦 · 384 爻 · **通用 AI Agent 内核**

[![Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![CI](https://github.com/phoenix7956/pangu/actions/workflows/ci.yml/badge.svg)](https://github.com/phoenix7956/pangu/actions/workflows/ci.yml)

---

## 1. 是什么

Pangu 是一个**通用 AI Agent 内核**：会自己拆任务、派活、验收、写记忆、越用越准。
它不绑定任何一家云厂商、任何一个模型、任何一种部署形态 —— 本地推理、云端 API、
自建推理服务，走的是同一套内核。

核心三层：

- **Agent 集群**：8 个将灵（乾坎艮震巽离坤兑）分工协同，主 agent 拆解 → 并发派活 → 收口验收
- **谋断内核**：64 卦 / 384 爻辞 / 阴阳五行 / 八卦类象 / 纳甲 / 八宫 —— **确定性推演**，不靠模型记忆
- **自进化闭环**：L1 行为留痕 → L2 每日挖矿 → L3 角色权重与提示词迭代

配套能力：130 个 in-process 工具、MCP 外部插件、跨 session 持久记忆、skill 运行时。

> **本仓是内核 + HTTP API，并自带一套零构建的浏览器工作台。**
> 打开 `http://127.0.0.1:18901/` 直接进**工作台**（根路径就是界面，没有多余前缀）；
> 只想调 API：`GET /api` 返回一张 API 索引页，列明全部可直接调用的端点 + 接入示例。
> 工作台的每一页就是一个**路径**：`/bazi` 八字排盘 · `/hexagrams` 六十四卦 ·
> `/settings` 系统设置 · `/history` 历史档案 · `/status` 状态。
> 源码在 `apps/core/web/app/`（手写 HTML+CSS+ESM，**零构建、零 npm 依赖、零外部资源**）。
> 本仓**不含**桌面客户端 —— 没有 Electron / Vite / Tauri 那一套壳。

## 2. 架构

```
┌──────────────────────────────────────────────┐
│  主 agent (self-loop)                        │  ← 接需求 / 判断 / 收口
├──────────────────────────────────────────────┤
│  将灵集群 (8: 乾调度 坎拆 艮记 震复盘         │  ← 并发派活, 各自带工具白名单
│            巽找雷 离读 坤做 兑验)             │
├──────────────────────────────────────────────┤
│  谋断内核 64i (64卦/384爻/阴阳五行/八卦类象)  │  ← 确定性结果, 不用模型现编
├──────────────────────────────────────────────┤
│  工具层 (130 in-process + MCP 外部插件)        │  ← 执行
└──────────────────────────────────────────────┘
```

**三条铁律**：
- 卦理推演不调 LLM（64i 是确定性计算）
- LLM 解读必看 64i 真源（不许凭记忆编卦辞）
- MCP 只执行，不推理

## 3. 安装

```bash
git clone https://github.com/phoenix7956/pangu.git
cd pangu
pnpm install --frozen-lockfile                              # 仓库是 pnpm workspace, 锁文件在根
cp apps/core/config/nodes/example-node.json apps/core/config/nodes/node.json   # 填你的 endpoint / api_key
pnpm start          # 起在 127.0.0.1:18901 (等价于 cd apps/core && npm start)
```

需要 Node.js 22+ 与 pnpm 10+。装不动原生模块（`better-sqlite3` / `hnswlib-node` /
`tree-sitter`）时先备好编译工具链：macOS 用 `xcode-select --install`，
Debian/Ubuntu 用 `apt-get install -y python3 make g++`。

**API key 配哪**：密钥值只放在 `~/.pangu/credentials.json`（600），节点配置里只留引用。

    bash scripts/setup_credential.sh MINIMAX_API_KEY --from-env MINIMAX_API_KEY

（`--from-env` / `--stdin` 是为了别让密钥出现在进程列表里。）
厂商名对不上约定时，在模型条目里写 `api_key_credential: "<条目名>"` 指名用哪一条。
详见 [SECURITY.md](SECURITY.md) 的「密钥怎么管」。

**前置依赖**：
- Node.js 22+
- 一个能用的推理端点（本地 LM Studio / Ollama / vLLM，或任意 OpenAI 兼容的云端 API）
- Python 3 + `sxtwl`（八字排盘工具 `bazi_calc.py` 用，`pip3 install sxtwl`；
  没装时八字相关工具降级，不影响其他工具）

节点配置解析顺序（见 `apps/core/config/node_config.js`）：

1. 环境变量 `PANGU_NODE_CONFIG`
2. `apps/core/config/nodes/node.json`（约定名）
3. `apps/core/config/nodes/` 下**唯一**一个非示例 `.json`

多于一个候选时盘古**不替你猜**，直接报错让你用 `PANGU_NODE_CONFIG` 指一份。
找不到配置时盘古**拒绝启动**（不降级成空配置 —— 那是「起来了但请求全挂」的空气泡）。

**两个运行时文件（不在仓里）**：

| 文件 | 谁生成 | 说明 |
|------|--------|------|
| `apps/core/config/nodes/node.json` | 你手写（从 `example-node.json` 拷） | 节点配置：endpoint / api_key 引用 / 模型池 |
| `apps/core/modules/router/models.json` | 盘古自己（`syncRouterModelsFromConfig`） | router 的模型池缓存，从上面的 `node.json` 同步而来 |

第二个文件以前是跟着仓走的 —— 里面装的是**维护者自己那台机器的模型池**，
别人克隆下来会看到 7 个自己根本没有的模型，而且每次启动同步都会把工作树改脏。
现在它不入库：干净克隆里第一次启动会自动生成，里面装的是**你自己**的模型。

### 3.1 工作台（`/`）

启动后浏览器打开 <http://127.0.0.1:18901/>（根路径直接就是工作台）：

| 视图 | 能干什么 |
|------|----------|
| 对话 | 主 agent 流式对话（SSE），工具调用卡 / 来源标记 / 推理摘要都画出来 |
| 六十四卦 | 64 卦全表，可按五行筛、可搜；点卦看卦辞 / 大象 / 逐爻爻辞 |
| 八字排盘 | 四柱 / 五行 / 喜忌 / 神煞 / 大运 / 流年 / 流月 |
| 历史 | 历史 session 列表与回放 |
| 进化 | 自进化闭环的逐日账本：任务量 / 成功率 / 耗时 / 工具 / 模型，plotly 离线画图 |
| 工具 · 状态 · 设置 | 工具清单、运行时状态、模型池 / 凭证 / MCP / 权限配置 |

工作台源码在 `apps/core/web/app/`：手写 HTML + CSS + ESM，**零构建、零 npm 依赖、
零外部资源**（不引 webfont、不引 CDN、没有任何外链）—— 图标是仓库内置的 SVG path，
字体走系统字体栈，纸纹是内联 data-URI。改完刷新浏览器就生效，
**没有 `npm run build` 这一步**。

唯一的例外是**「进化」页的图表**：它按需加载仓库内置的 plotly.js basic 分包
（MIT 协议，1 MB，放在 `apps/core/web/app/vendor/`，本机伺服，不联网、不引 CDN，
只有进这一页时才加载）。说明与升级步骤见
[`apps/core/web/app/vendor/README.md`](apps/core/web/app/vendor/README.md)。

**挂到子路径下也能跑**：界面里的地址一律是**相对**的（`themes.css`、`api/version`、
`bazi`……没有前导斜杠），所以盘古挂在 nginx 的 `/pangu/` 这种前缀后面一样能用。
路由全部是**单段**（设置里的十二项走 `?tab=xxx`，不是 `/settings/xxx`）——
这样相对地址永远解析到基址根。前缀由反代告诉服务端即可：

```nginx
location /pangu/ {
    proxy_pass http://127.0.0.1:18901/;
    proxy_set_header X-Forwarded-Prefix /pangu;   # 不剥前缀时才需要
}
```

不想装浏览器界面也行：内核就是一组 HTTP 端点，纯 API 客户端直接调 `/api/*` 即可。

## 4. LLM 路由

### 4.1 双维度设计

```
provider ∈ { local, openai, anthropic, custom }
protocol ∈ { openai, anthropic }   # 与 provider 独立选
```

### 4.2 典型配置

| 场景 | provider | protocol | endpoint | model |
|------|----------|----------|----------|-------|
| **本地 LM Studio** | `local` | `openai` | `http://127.0.0.1:1234/v1` | 任意已载入模型 |
| **本地 vLLM / Ollama** | `custom` | `openai` | `http://127.0.0.1:8000/v1` | 任意 |
| **OpenAI 官方** | `openai` | `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| **Anthropic 官方** | `anthropic` | `anthropic` | `https://api.anthropic.com` | `claude-sonnet-4-5` |
| **DeepSeek** | `openai` | `openai` | `https://api.deepseek.com/v1` | `deepseek-chat` |
| **通义千问** | `openai` | `openai` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| **GLM 智谱** | `openai` | `openai` | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-plus` |
| **Kimi 月之暗面** | `openai` | `openai` | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |

**协议自动判定**：endpoint 含 `anthropic` → anthropic 协议；provider=anthropic → anthropic 协议；其他 → openai 协议。

### 4.3 加一个新厂商不用改代码

厂商怪癖写在配置的 `vendor_profiles` / `cn_profiles` / `provider_guess_rules` /
`media_protocol_hints` 四张表里 —— 加一行即可，代码不动。
字段说明见 `apps/core/config/nodes/example-node.json` 的 `_schema_doc`。

### 4.4 key 从哪来（一条链）

取 key 只有一条链（`apps/core/modules/api_key_resolver.js`），从前往后：

1. 模型条目点名的凭证：`api_key_credential`
2. 显式环境变量：`api_key_env`，或 `api_key` 字段写成 `env:MY_KEY`
3. 凭证库 `~/.pangu/credentials.json`：按厂商名约定找（`minimax` → `MINIMAX_API_KEY`）
4. 同一个约定名的环境变量
5. 配置里的明文 `api_key`（兜底 —— 盘古启动时会把落盘明文自动收编进凭证库）

**为什么要单独一节**：原来取 key 的地方有**三套顺序**（主链、探针链、后台脚本链），
于是同一个模型在「测试连接」和「真调用」里能不能用 key 的结论能不一样 ——
而密钥搬进凭证库之后，探针那条链**根本找不到**，直接误判成「没鉴权」。
现在只有一条链，守卫（`tests/secret-hygiene-20261026.test.js`）盯着它不许分叉。

### 4.5 慢的时候盘古自己会让位（延迟感知路由）

认知模型不一定永远该是同一个。`llm.routing.policy` 三档：

| policy | 行为 |
|---|---|
| `off` | 完全不探针，模型只由用户显式选择决定 |
| `manual` | 探针只**报告**慢，不自动换（默认） |
| `auto` | 当前模型首字超过 `max_first_token_ms`（默认 2500）或连不上时，自动换到更快的 |

换的时候**质量优先**：先按模型条目里的 `quality_score` 分档，档内再按延迟排；
只有上一档全挂了才降档。你手动切过的模型会被钉住（`manual_pinned`），自动路由不改它。
探针结果缓存在 `~/.pangu/routing-state.json`（默认 6 小时），不烧额度、不拖慢启动。

看决策：`GET /api/llm/routing`；强制重探并应用：`POST /api/llm/routing/refresh`。

### 4.6 不知道窗口多大的时候，不许把对话打死

上下文长度只有一个真源：registry（`~/.pangu/models-registry.json`），由探针写回。
两层口径是分开的：

- **registry 层**照旧 fail-loud —— 没探到就是没探到，不拿配置里手填的数冒充真值；
- **运行时热路径**拿不到就退到保守值（32768），**不许**因为「不知道窗口多大」把整轮对话打成 500。

进池 / 被选中的模型会在后台补一次探测（`modules/model_ctx_ensure.js`，
输入上限用厂商自己的 token 计数二分，`modules/ctx_input_probe.js`），
补上之后压缩阈值和 `max_tokens` 都按真窗口算。

## 5. 对外接口

无前端，全部走 HTTP。常用的几个：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/` | API 索引页（列全部端点） |
| GET | `/health` | 存活 + 运行态（工具数 / skill 数 / 内存 / 端口） |
| GET | `/api/version` | 版本号 |
| GET | `/api/config` | 运行配置（provider / 模型 / 节点） |
| GET | `/api/models/list` | 模型池清单 |
| GET | `/api/nodes` | 推理节点清单 |
| GET | `/api/skills` | 已装 skill 清单 |
| GET | `/api/pangu/subagents/roles` | 八将灵清单与职责 |
| GET | `/api/hexagrams` | 64 卦全文（直读 64i 真源） |
| POST | `/api/pangu/agent/stream` | 主 agent 流式对话（SSE） |
| POST | `/api/message/stream` | 兼容端点（流式，带升级阶梯） |

跨源接入时用环境变量开白名单（默认只放行本机 18901）：

```bash
PANGU_ALLOWED_ORIGINS="https://a.example,https://b.example" npm start
```

## 6. MCP 插件

Pangu 是 **MCP client**，可调外部 MCP server。配置在 `apps/core/config/mcp_servers.json`，
启动时自动加载；增删改 server 不需要改代码。

## 7. 语料与出处

64i 谋断内核的**切片产物**（卦辞、爻辞、类象、纳甲表）在仓里；
**原始语料不在仓里**（各家版权）。重建切片产物时用环境变量指向你自己的语料根：

```bash
PANGU_CORPUS_ROOT=/path/to/易经 node scripts/build_xiang_ci.js
```

`PANGU_CORPUS_ROOT` 指向的是**包含「易经」目录的父目录**。没设这个变量时，
出处相关脚本会明说「语料不在本机」，不会瞎猜路径。

## 8. 开发

```bash
cd apps/core
npm test              # 跑所有单测
npm run test:chain    # 跑链式回归（守卫全集）
npm run test:coverage # 覆盖率报告
```

单条守卫也可以单跑：`node --test tests/<名字>.test.js`。

界面层的**规则**全部在内核里（爻题规则、有序列表判据等），改规则只需要改
`apps/core/64i/` 与 `apps/core/modules/`。
界面本身是 `apps/core/web/app/` 的手写静态页，改完刷新浏览器即可，不需要构建步骤。

仓库**不含**桌面客户端（Electron / Vite / Tauri 一套都没有），只有这一套浏览器工作台。

## 9. 平台说明

内核是纯 Node.js，**跨平台**。仓库里另有少量 **macOS 专属的可选适配器**，
它们只在本机调用工具时才生效，不是核心依赖：

- `apps/core/runtime/src/pangu_cg.swift` —— CGEvent 鼠标/键盘注入（替代 osascript）
- `apps/core/bin/pangu_request_tcc.py` —— 摄像头/麦克风 TCC 授权引导
- `apps/core/modules/teamflow.js` 的 launchd 部分 —— macOS 定时任务管理

## 10. 目录

```
apps/core/
  64i/            谋断内核: 64 卦 / 384 爻 / 阴阳五行 / 八卦类象 / 纳甲 / 八宫
  agents/         八将灵 (gua-identity.js 是身份唯一真源)
  modules/        工具 / 路由 / 记忆 / 调度 / HTTP 等运行时模块
  pangu-single/   HTTP 路由
  web/app/        浏览器工作台 (手写 HTML/CSS/ESM, 零构建, / 访问)
  config/         节点配置 / MCP 配置 / 路由表
  scripts/        运维脚本 (含八将灵工具白名单漂移检查)
  tests/          守卫全集
  meta/           运行时人格模板
```

## 11. 参与

- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [问题反馈](https://github.com/phoenix7956/pangu/issues)

## 12. 怎么发布一版

维护者用一条命令导出**干净的开源树**（已跟踪文件 + 显式排除清单 + 三项体检），
并直接做成可 push 的仓：

```bash
node scripts/publish-open-source.js --publish --out /tmp/pangu-release
cd /tmp/pangu-release && git push -u origin main
```

导出树是**全新 git 历史** ⇒ 开发期的历史（含任何曾经出现过的凭证）不会跟着走。
体检不过（发现本机绝对路径 / 疑似真密钥 / 机器名路径）就**不导出**。

## 13. License

Apache 2.0 — 商用友好。可自由使用、修改、分发、商用（含闭源产品集成、SaaS 服务），
条件：保留 LICENSE / NOTICE 里的版权与归属声明；修改过的文件要标注改动。见 [LICENSE](LICENSE)。

**商用要点**（Apache 2.0 原文 + 本项目约定）：
- 商用、二次开发、SaaS、闭源集成都**不**触发开源义务 —— Apache 2.0 不是 copyleft。
- 随分发必须保留：`LICENSE`、`NOTICE`（含第三方归属清单），以及你改过的文件的改动说明。
- "Pangu / 盘古" 作为项目名请保留出处标注（Apache 2.0 §1 授予的是专利与软件使用权，
  不授予你拿 "Pangu" 商标去冒充官方发布的权利）。

第三方组件归属见 [NOTICE](NOTICE)：工作台图标路径取自 lucide（ISC）；「进化」页图表用
plotly.js basic 分包（MIT，已随库存放在 `web/app/vendor/`）；npm 运行时 13 个依赖
（bcryptjs / better-sqlite3 / chalk / dotenv / hnswlib-node / tree-sitter×5 / vscode-langservers×2）
全为 MIT / BSD / Apache-2.0，均可商用。

## 14. 致谢

- Anthropic / OpenAI / DeepSeek / 通义千问 / 智谱 GLM / Kimi
- 64 卦传承人：每个相信"谋定而后动"的人
