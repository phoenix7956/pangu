# 贡献指南

感谢你愿意给盘古加东西。这份文档只讲**怎么不被卡住**。

## 一句话架构

盘古是**纯内核 + HTTP API**，没有图形界面。

```
主 agent (self-loop)  →  将灵集群 (8 个角色)  →  谋断内核 64i  →  工具层 (in-process + MCP)
```

改任何东西前先确认自己动的是哪一层，**跨层的改动要拆成两个 PR**。

## 四条铁律（违反了 PR 会被打回）

1. **卦理推演不调 LLM** —— 64i 是确定性计算。凡是「让模型算卦」的改动都要重写。
2. **LLM 解读必看 64i 真源** —— 不许凭模型记忆编卦辞。
3. **MCP 只执行，不推理** —— MCP server 回来的是动作结果，不是结论。
4. **不许留「空气泡」** —— 降级路径不许悄悄把错误变成空结果/假成功。宁可**大声报错**。

## 环境

```bash
cd apps/core
npm install
cp config/nodes/example-node.json config/nodes/node.json   # 填你的 endpoint / api_key
npm start          # 127.0.0.1:18901
```

没有推理端点也能跑大部分单测：`npm run test:chain`。

## 提交前必跑

```bash
cd apps/core && npm run test:chain      # 守卫全集, 必须 0 个 not ok
```

单条守卫单跑：`node --test tests/<名字>.test.js`。

**改了 64i 就必须加出处**：新模块要在 `apps/core/64i/provenance.js` 登记来源，
`tests/provenance-*.test.js` 会当场抓漏。

## 提交信息

格式：`<type>(<scope>): <一句话>`，type 用 `feat` / `fix` / `refactor` / `test` / `docs` / `chore`。
正文写清**为什么**，不写**做了什么**（diff 里看得到做了什么）。

## 什么不能进仓

- 任何真实 API key / token —— 配置模板一律 `sk-REPLACE-ME`
- 本机绝对路径（`/Users/<某人>/...`）—— 用 `${_REPO_ROOT}` / `PANGU_CORPUS_ROOT` 之类
- 崩溃报告、运行日志、内存库、语料原文
- 过程文档（整改记录、扫描报告）—— 那些属于你自己的笔记，不属于产品

这几条由 `apps/core/tests/open-source-hygiene-20261026.test.js` 机械检查，注释挡不住它。

## 加一个新模型厂商

**不要改代码**。在节点配置的 `vendor_profiles` / `cn_profiles` /
`provider_guess_rules` / `media_protocol_hints` 四张表里加一行。
字段说明见 `apps/core/config/nodes/example-node.json` 的 `_schema_doc`。

## 加一个工具

1. 在 `apps/core/modules/tools_schema/` 写 schema（顺序会进提示词，**别乱插**）
2. 在 `apps/core/modules/tools/index.js` 实现
3. 工具名要进对应角色的白名单（真源：`apps/core/agents/gua-identity.js`）
   —— `tests/roster-tools-drift-20261026.test.js` 会查漂移

## 报告问题

带上前缀：`[Pangu]`。请附上 `GET /health` 的输出和复现步骤。

## License

提交即表示同意按 [Apache 2.0](LICENSE) 授权。
