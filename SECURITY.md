# 安全策略

## 报告漏洞

**不要**开 public issue。请发邮件给维护者，或用 GitHub 的
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidelines/reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)。

请在报告里写清：

- 受影响版本（`GET /api/version`）
- 复现步骤
- 影响面（能不能读到别的会话数据 / 能不能执行任意命令 / 能不能读本机文件）

我们会在 7 天内给第一次回应。

## 威胁模型（这个内核做什么、不做什么）

盘古是**在本机跑的 agent 内核**，默认只监听 `127.0.0.1`。

**它会做**（设计如此，不是漏洞）：

- 以你的身份执行工具调用（读写文件、跑命令、调 MCP server）
- 操控本机 GUI（macOS 专属适配器，见 README §9）
- 按你的指令访问网络

**它不做**：

- 不自动把数据发到第三方（除非你配的模型端点本身会上报 —— 那是你的选择）
- 不做多租户隔离（**它是单用户本机服务**，别直接暴露到公网）

## 部署注意

- **别把 18901 直接暴露到公网。** 要远程用请放在反向代理后面 + 自己加认证。
- 跨源接入用 `PANGU_ALLOWED_ORIGINS` 显式开白名单；`*` 会被忽略并告警。
- 密钥不进项目目录：密钥值只允许存在 `~/.pangu/credentials.json`（600），配置里只留引用。详见下节。

## 密钥怎么管（这条跟开不开源无关）

**密钥值只允许存在一处**：`~/.pangu/credentials.json`（`chmod 600`，只有你能读）。
项目目录里的配置**只准留引用**。

这不是发布前的一次性检查，是**运行时机制**：

- **写入端**：从设置页加模型时填的 key 会自动转存进凭证库，配置文件里只写
  `api_key_credential`（指明用凭证库里哪一条）。不用你记得做迁移。
- **收编端**：盘古启动时会扫一遍落盘配置，发现明文 key 就搬进凭证库，
  配置文件里改留引用。手工改过的配置一样会被收编。
- **读取端**：取 key 只有一条链（`modules/api_key_resolver.js`）——
  显式凭证引用 > 显式环境变量 > 凭证库 > 按厂商名约定的环境变量 > 明文兜底。
- **守卫**：`tests/secret-hygiene-20261026.test.js` 每次跑测试都验一遍：
  生效配置里不许有明文密钥、代码不许绕过解析链、凭证库权限必须是 600。

**为什么跟开源无关**：备份 / 云同步 / `git add -A` / 拷配置给同事 —— 这些都会把
落在项目目录里的密钥带走。本地开发同样要管。

**给开源用户的三种配法**（按推荐顺序）：

1. 凭证库（推荐）—— 盘古启动即读，launchd 起的服务也读得到：

       bash apps/core/scripts/setup_credential.sh MINIMAX_API_KEY sk-cp-xxxx

2. 环境变量 —— `<PROVIDER>_API_KEY`，盘古按厂商名约定自动找：

       export MINIMAX_API_KEY=sk-cp-xxxx

3. 模型条目显式声明：

       { "id": "my-model", "provider": "minimax", "api_key_env": "MINIMAX_API_KEY" }

> `api_key` 字段里写 `env:MY_KEY` 也认（显式指定，优先于按厂商名猜的环境变量）。

**如果你的 key 曾经落在项目目录里**（比如提交过、被备份过）：先在厂商控制台
**轮换**那把 key，再跑一次盘古让它自动收编。收编只是搬家，**不等于换锁**。

## 已知的「不算漏洞」的行为

- 磁盘上的会话 / 记忆库是**明文**的（单用户本机服务，没做加密）
- 工具调用默认在沙箱严格模式下跑，但写文件类工具仍以你的身份执行
- `computer_use` 类工具需要 macOS 辅助功能授权 —— 这是系统授权，不是盘古绕过

## 依赖

盘古依赖里有原生模块（`better-sqlite3` / `hnswlib-node` / `tree-sitter`）。
报告依赖漏洞时请一并说明版本与复现方式。
