# 盘古 · 四合一集成架构

> 整合 Claude Code / OpenClaw / Hermes / Pi 四大系统的最佳设计

---

## 1. 架构全景图

```
                          ┌─────────────────────────────────────────┐
                          │           Hermes Gateway                │
                          │  (多平台接入: WeChat/Telegram/HTTP/...)  │
                          └──────────────────┬──────────────────────┘
                                             │
                          ┌─────────────────▼──────────────────────┐
                          │          Agent Orchestrator             │
                          │   (事件驱动循环 / Hooks / 权限策略)        │
                          └─────────────────┬───────────────────────┘
                                            │
        ┌────────────────────────────────────┼────────────────────────────────────┐
        │                 │                 │                 │                  │
   ┌────▼────┐      ┌────▼────┐      ┌────▼────┐      ┌────▼────┐       ┌────▼────┐
   │  64卦   │      │ 384爻  │      │ 工具层  │      │ Session │       │ Skills  │
   │ 推理层  │ ──▶  │ 执行层  │ ──▶  │ (Pi级)  │      │ & Memory│       │  (Pi级) │
   └─────────┘      └─────────┘      └─────────┘      └─────────┘       └─────────┘
        │                                   │
        │                        ┌─────────┴─────────┐
        │                  ┌─────▼─────┐       ┌─────▼─────┐
        │                  │  本地模型  │       │  云端模型  │
        │                  │ Qwen3.6-35B│       │  MiniMax  │
        │                  └───────────┘       └───────────┘
        │
   ┌────▼──────────────────────────────────────────────────────────────┐
   │              自我修复 / 自我净化 / 定时任务                         │
   │   (health.js + cleanup.js + cron + autoDream)                    │
   └───────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心模块矩阵

| 模块 | 来源 | 核心功能 | 盘古对应文件 |
|------|------|----------|-------------|
| **Agent Loop** | Pi `agent-loop.ts` | 事件驱动 + 串行工具执行 + retry | `modules/agent_loop.js`（新建） |
| **Hook System** | Claude Code Hook | PreToolUse / PostToolUse / beforeAgent | `modules/hooks.js`（新建） |
| **Permission Policy** | Claude Code Permission | 多级别权限模式 + 规则引擎 | `modules/permission.js`（新建） |
| **Sandbox** | Claude Code Sandbox | 文件系统隔离 + 网络限制 | `modules/sandbox.js`（新建） |
| **MCP Protocol** | Claude Code MCP | 工具前缀规则 + 传输类型 | `modules/mcp_adapter.js`（新建） |
| **Session Storage** | Pi `jsonl-storage.ts` | JSONL 持久化 + compaction | `modules/session.js`（增强现有） |
| **Session Memory** | Claude Code Session Memory | Markdown 笔记 + FTS5 检索 | `modules/session_memory.js`（已有） |
| **Skill Loader** | Pi `skills.ts` | 文件系统加载 + 运行时注册 | `modules/skill_runtime.js`（已有） |
| **Model Registry** | Pi `model-registry.ts` | 多 provider 统一 API | `modules/model_registry.js`（新建） |
| **Plan Mode** | Claude Code Plan + Pi | plan 文件管理 + 权限上下文 | `modules/plan_mode.js`（新建） |
| **Teams** | Claude Code Teams | Orchestrator / Worker / Mailbox | `modules/teams.js`（新建） |
| **Cron / Dream** | Claude Code Cron + Dream | 定时任务 + 自动记忆压缩 | `modules/dream.js`（新建） |
| **Health** | 盘古现有 | 自我修复 + 自动重启 | `modules/health.js`（已有） |
| **Cleanup** | 盘古现有 | 自我净化 + 磁盘清理 | `modules/cleanup.js`（已有） |
| **EventBus** | Pi EventStream + 盘古 | 事件流总线 + before/after hooks | `modules/event_bus.js`（已有） |
| **File Tools** | Pi `read/write/edit` + 盘古 | 生产级文件操作 | `modules/tools/index.js`（已增强） |
| **Code Executor** | Pi `bash-executor` + 盘古 | spawn + 流式 + 截断 | `modules/code_executor.js`（已有） |
| **Session Compaction** | Pi `compaction.ts` | 自动摘要 + token 控制 | `modules/session_compaction.js`（已有） |
| **Gateway** | Hermes | 多平台接入 | `modules/gateway`（已有） |
| **Commander** | OpenClaw | 任务下发 + 中间件 | `modules/commander.js`（新建） |

---

## 3. Agent Loop（Pi × Claude Code 融合）

### 3.1 事件驱动循环（Pi EventStream）

Pi 的 `agent-loop.ts` 核心模式：

```typescript
// Pi 的 Agent Loop 伪代码
export async function runAgentLoop(context, config, emit, signal) {
  while (true) {
    // ① LLM 调用
    const response = await llm.call(context.messages);
    
    // ② 发送事件
    await emit({ type: "message_start", message: response });
    
    // ③ 如果有工具调用
    if (response.tool_calls) {
      for (const toolCall of response.tool_calls) {
        // 工具开始执行
        await emit({ type: "tool_execution_start", toolCall });
        
        // 执行工具（可中断）
        const result = await executeTool(toolCall, signal, (partial) => {
          // partial result 回调
          emit({ type: "tool_execution_update", partial });
        });
        
        // 工具结束
        await emit({ type: "tool_execution_end", result });
        context.messages.push(toolResultMessage);
      }
    } else {
      // 无工具调用，结束
      break;
    }
  }
}
```

盘古的实现（`modules/agent_loop.js`）：

```javascript
// 盘古 Agent Loop
const { EventBus, createEventBus } = require('./event_bus');

class AgentLoop {
  constructor({ llm, tools, eventBus = createEventBus() }) {
    this.llm = llm;
    this.tools = tools;
    this.eb = eventBus;
  }

  async run(userMessage, context = {}) {
    const messages = [{ role: 'user', content: userMessage }];
    const session = { messages, ...context };

    await this.eb.emit(EventBus.EVENTS.AGENT_START, { userMessage });
    await this.eb.emit(EventBus.EVENTS.TURN_START, { turn: 1 });

    let turn = 0;
    while (turn++ < 20) { // max turns
      // LLM 调用
      const response = await this.llm.call(messages, this._getTools());
      
      // 发送 assistant 消息事件
      await this.eb.emit(EventBus.EVENTS.MESSAGE_END, { 
        message: response, turn 
      });

      if (!response.tool_calls || response.tool_calls.length === 0) {
        // 无工具调用，结束
        await this.eb.emit(EventBus.EVENTS.TURN_END, { turn });
        await this.eb.emit(EventBus.EVENTS.AGENT_END, { turns: turn });
        return response;
      }

      // 串行执行工具
      for (const toolCall of response.tool_calls) {
        await this.eb.emit(EventBus.EVENTS.TOOL_EXECUTION_START, toolCall);
        
        const toolFn = this.tools[toolCall.name];
        if (!toolFn) {
          await this.eb.emit(EventBus.EVENTS.TOOL_ERROR, { 
            toolCall, error: `Tool ${toolCall.name} not found` 
          });
          continue;
        }

        // 执行工具（带 partial result 回调）
        const result = await toolFn(
          { params: toolCall.arguments, context: session },
          {
            onPartial: (partial) => {
              this.eb.emit(EventBus.EVENTS.TOOL_EXECUTION_UPDATE, {
                toolCallId: toolCall.id, partial
              });
            },
            signal: context.abortSignal
          }
        );

        await this.eb.emit(EventBus.EVENTS.TOOL_EXECUTION_END, {
          toolCall, result, duration: result._duration
        });

        messages.push({
          role: 'toolResult',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: JSON.stringify(result)
        });
      }
    }
  }

  _getTools() {
    return Object.entries(this.tools)
      .filter(([name]) => !name.startsWith('_'))
      .map(([name, fn]) => ({
        name,
        description: fn._description || name,
        parameters: fn._schema || {}
      }));
  }
}
```

### 3.2 Hook 拦截层（Claude Code Hook System）

```javascript
// modules/hooks.js
class HookSystem {
  constructor() {
    this._preAgent = [];
    this._postAgent = [];
    this._preTool = [];   // Claude Code: PreToolUse
    this._postTool = [];  // Claude Code: PostToolUse
    this._onError = [];
  }

  // 注册 hook
  register({ name, when, fn }) {
    const list = {
      'beforeAgent': this._preAgent,
      'afterAgent': this._postAgent,
      'beforeTool': this._preTool,
      'afterTool': this._postTool,
      'onError': this._onError,
    }[when] || [];
    list.push({ name, fn });
  }

  // 执行 hooks
  async exec(when, payload) {
    const lists = {
      beforeAgent: this._preAgent,
      afterAgent: this._postAgent,
      beforeTool: this._preTool,
      afterTool: this._postTool,
      onError: this._onError,
    };
    for (const { fn } of lists[when] || []) {
      try {
        const r = fn(payload);
        if (r instanceof Promise) await r;
      } catch (e) {
        console.error(`Hook ${when} error:`, e.message);
      }
    }
  }
}
```

### 3.3 权限策略（Claude Code Permission Policy）

```javascript
// modules/permission.js
const PERMISSION_LEVELS = {
  LOW: {
    allowExec: ['read', 'grep', 'ls', 'web_fetch'],
    allowWrite: false,
    allowNetwork: false,
    allowDangerous: false,
  },
  MEDIUM: {
    allowExec: ['read', 'grep', 'ls', 'web_fetch', 'read_file', 'file_ls', 'file_grep'],
    allowWrite: ['/tmp', '~/Downloads'],
    allowNetwork: ['GET only'],
    allowDangerous: false,
  },
  HIGH: {
    allowExec: ['*'],
    allowWrite: ['*'],
    allowNetwork: ['*'],
    allowDangerous: ['kill', 'pkill'],
  },
  FULL: {
    allowExec: ['*'],
    allowWrite: ['*'],
    allowNetwork: ['*'],
    allowDangerous: ['*'],
  },
};

class PermissionEngine {
  constructor(level = 'MEDIUM') {
    this.level = level;
    this.rules = PERMISSION_LEVELS[level] || PERMISSION_LEVELS.MEDIUM;
  }

  can(toolName, action = 'execute') {
    if (this.rules.allowExec === '*') return true;
    if (!this.rules.allowExec.includes(toolName)) return false;
    if (action === 'write' && !this.rules.allowWrite) return false;
    return true;
  }

  // Claude Code 风格的规则引擎：可配置规则
  evaluate(context) {
    // context: { userId, sessionId, toolName, args, cwd }
    // 返回 { allowed: bool, reason: string }
  }
}
```

### 3.4 沙箱隔离（Claude Code Sandbox）

```javascript
// modules/sandbox.js
class Sandbox {
  constructor({ 
    allowedDirs = [],      // 允许写入的目录
    allowedNetworks = [],  // 允许网络访问的域名
    maxMemoryMB = 512,
    timeoutSec = 60,
  } = {}) {
    this.allowedDirs = allowedDirs;
    this.allowedNetworks = allowedNetworks;
    this.maxMemoryMB = maxMemoryMB;
    this.timeoutSec = timeoutSec;
  }

  // 文件系统沙箱
  canReadPath(path) {
    return this.allowedDirs.some(dir => path.startsWith(dir));
  }

  canWritePath(path) {
    return this.allowedDirs.some(dir => path.startsWith(dir));
  }

  // 网络沙箱
  canNetworkAccess(hostname) {
    if (this.allowedNetworks.includes('*')) return true;
    return this.allowedNetworks.includes(hostname);
  }

  // 执行沙箱（限制 CPU / 内存）
  async execInSandbox(command, args) {
    // 使用 cgroups 或 Linux namespace 隔离
    // 或简化为 setrlimit + unprivileged_user namespaces
  }
}
```

### 3.5 MCP 协议（Claude Code MCP）

```javascript
// modules/mcp_adapter.js
class MCPAdapter {
  constructor() {
    this._tools = new Map(); // name → tool def
  }

  // 注册 MCP 工具（带前缀）
  register(toolDef) {
    // Claude Code MCP 规则：
    // - 以 "mmcp_" 开头的工具不会被截断
    // - 以 "long_mcp_" 开头的工具允许长时间运行
    // - 其他工具默认 30s 超时
    const prefix = toolDef.long ? 'long_mcp_' : toolDef.durable ? 'mmcp_' : 'mcp_';
    const name = prefix + toolDef.name;
    this._tools.set(name, {
      ...toolDef,
      _mcp: true,
      _timeout: toolDef.long ? 300 : toolDef.durable ? 120 : 30,
    });
  }

  // 转换 MCP 工具为盘古工具格式
  toPanguTool(mcpTool) {
    return {
      name: mcpTool.name,
      description: mcpTool.description,
      parameters: {
        type: 'object',
        properties: mcpTool.inputSchema.properties || {},
        required: mcpTool.inputSchema.required || [],
      },
      _timeout: mcpTool._timeout,
    };
  }
}
```

---

## 4. 会话与记忆（Pi + Claude Code + Hermes）

### 4.1 Session Storage（Pi JSONL + Claude Code Session Memory）

```javascript
// modules/session.js
const fs = require('fs');
const path = require('path');

class SessionStore {
  constructor({ dir = '~/.hermes/sessions' }) {
    this.dir = path.expanduser(dir);
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  // Pi 的 JSONL 格式：每行一条消息
  // Claude Code 的 session 格式：JSON + markdown 笔记
  save(sessionId, data) {
    const file = path.join(this.dir, `${sessionId}.json`);
    const backup = file + '.bak.' + Date.now();
    if (fs.existsSync(file)) fs.copyFileSync(file, backup);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  load(sessionId) {
    const file = path.join(this.dir, `${sessionId}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  appendMessage(sessionId, message) {
    // Pi 风格：追加到 JSONL 文件
    const jlFile = path.join(this.dir, `${sessionId}.jsonl`);
    fs.appendFileSync(jlFile, JSON.stringify(message) + '\n');
  }

  list() {
    return fs.readdirSync(this.dir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        id: f.replace('.json', ''),
        mtime: fs.statSync(path.join(this.dir, f)).mtime,
        size: fs.statSync(path.join(this.dir, f)).size,
      }));
  }
}
```

### 4.2 自动 Compaction（Pi compaction）

已在 `modules/session_compaction.js` 实现：

```javascript
// 三种压缩策略
const STRATEGIES = {
  latest: { keep: 10, discard: 'all_before' },
  full:   { keep: 5,  discard: 'oldest_half' },
  smart:  { keep: 10, discard: 'by_importance' }, // Claude Code style
};

// Smart 策略：按消息重要性打分（Claude Code）
function scoreMessage(msg) {
  let score = 0;
  if (msg.role === 'user') score += 2;
  if (msg.tool_calls) score += 3; // 有工具调用 = 重要
  if (msg.content && msg.content.length > 500) score += 1;
  if (msg._compact) score += 1; // 已经是摘要的优先保留
  return score;
}
```

### 4.3 FTS5 全域检索（Hermes Session Memory）

```javascript
// Herme's FTS5 SQLite — 已有实现
// 搜索跨所有 session，保留上下文片段
async function sessionSearch(query, { limit = 5 } = {}) {
  // FTS5: messages.content MATCH 'query'
  // 返回：session_id, snippet, bookend_start, bookend_end
}
```

### 4.4 Skill Memory（Claude Code Session Memory Markdown 笔记）

```javascript
// Claude Code 的 .claude.md 笔记
// 在 session 目录下创建 notes.md
class SessionNotes {
  constructor(sessionDir) {
    this.notesFile = path.join(sessionDir, 'notes.md');
  }

  append(content) {
    const entry = `\n## ${new Date().toISOString()}\n${content}\n`;
    fs.appendFileSync(this.notesFile, entry);
  }

  search(query) {
    // 读取 notes.md，用简单 grep 搜索
  }
}
```

---

## 5. 技能系统（Pi × Claude Code × Hermes）

### 5.1 Skill Loader（Pi skills.ts）

```javascript
// modules/skill_loader.js
class SkillLoader {
  constructor({ skillDir = 'skills/' }) {
    this.skillDir = skillDir;
  }

  // 从文件系统加载技能（Pi 风格）
  async loadSkills() {
    const skills = [];
    const files = fs.readdirSync(this.skillDir);
    
    for (const file of files) {
      if (!file.endsWith('.md') && !file.endsWith('.json')) continue;
      const skill = file.endsWith('.md') 
        ? this._loadMdSkill(file) 
        : this._loadJsonSkill(file);
      skills.push(skill);
    }
    return skills;
  }

  _loadMdSkill(file) {
    // Skill MD 格式（Claude Code + Pi 融合）：
    // ---
    // name: xxx
    // description: xxx
    // tools: [tool1, tool2]
    // ---
    // # Prompt template...
    const content = fs.readFileSync(path.join(this.skillDir, file), 'utf8');
    const [, frontmatter, body] = content.split(/^---\n([\s\S]+?)\n---\n/);
    const meta = this._parseFrontmatter(frontmatter);
    return { ...meta, prompt: body.trim(), _file: file };
  }
}
```

### 5.2 Skill Registry（Hermes skill_runtime）

```javascript
// modules/skill_runtime.js（已有）
// Hermes 风格：skill_view / skill_manage / skills_list
class SkillRegistry {
  async get(name) {
    // 从 ~/.hermes/skills/ 加载 SKILL.md
  }

  async list() {
    // 列出所有可用技能
  }

  async invoke(name, context) {
    // 执行技能：加载 → 注入 tools → 执行
  }
}
```

### 5.3 MCP Skill（Claude Code MCP Adapter）

```javascript
// 通过 MCP 协议接入外部工具作为技能
class MCPSkill {
  constructor(mcpClient) {
    this.client = mcpClient;
  }

  async list() {
    const tools = await this.client.listTools();
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      tools: [t.name], // MCP 工具列表
    }));
  }

  async invoke(name, context) {
    return this.client.callTool(name, context);
  }
}
```

---

## 6. 计划模式（Pi + Claude Code Plan + Hermes Plan）

### 6.1 Plan 文件管理

```javascript
// modules/plan_mode.js
class PlanMode {
  constructor({ plansDir = '.plans/' }) {
    this.plansDir = plansDir;
    this.activePlan = null;
  }

  // 创建计划文件（Claude Code 风格）
  async createPlan(taskDescription) {
    const planFile = path.join(this.plansDir, `plan_${Date.now()}.md`);
    const content = `# Plan\n\n## Task\n${taskDescription}\n\n## Steps\n1. ...\n\n## Verification\n- [ ] ...\n`;
    fs.writeFileSync(planFile, content);
    this.activePlan = planFile;
    return planFile;
  }

  // 进入计划模式（Pi + Claude Code）
  async enter(session) {
    // 1. 保存当前 session 状态
    // 2. 加载 plan 提示词模板
    // 3. 将权限设置为 PLAN（限制性更强）
    // 4. 开启 agentLoopContinue 模式
  }

  // 验证步骤完成（Claude Code check）
  async verifyStep(stepIndex) {
    // 读取 plan 文件，检查 [x] checkbox
  }
}
```

---

## 7. 多模型支持（Pi model-registry × Hermes multi-provider）

### 7.1 Provider 抽象层

```javascript
// modules/model_registry.js
class ModelRegistry {
  constructor() {
    this.models = []; // Model[]
    this.apis = {};   // name → API instance
  }

  // 注册 provider（Pi 风格：支持 OAuth）
  registerProvider(name, config) {
    // config: { baseUrl, apiKey, oauth?, models[] }
    // 支持 OAuth 的 provider（Google/GitHub）会自动刷新 token
    this.apis[name] = {
      ...config,
      getToken: config.oauth ? () => this._refreshOAuth(name) : () => config.apiKey,
    };
    for (const model of config.models || []) {
      this.models.push({
        id: model.id,
        name: model.name,
        provider: name,
        api: config.api,
        baseUrl: model.baseUrl || config.baseUrl,
        reasoning: model.reasoning || false,
        input: model.input || ['text'],
        cost: model.cost || { input: 0, output: 0 },
        contextWindow: model.contextWindow,
      });
    }
  }

  // 切换模型
  async switchModel(modelId) {
    const model = this.models.find(m => m.id === modelId);
    if (!model) throw new Error(`Model ${modelId} not found`);
    this.currentModel = model;
    return model;
  }
}
```

### 7.2 本地 + 云端双轨

```javascript
// .env 配置（已有）
// LOCAL_MODEL=local
// LOCAL_BASE_URL=http://localhost:1234/v1
// MINIMAX_API_KEY=xxx
// MINIMAX_BASE_URL=https://api.minimax.io

// 本地优先策略（Pi 风格）
async function callModel(modelId, messages, tools) {
  const model = registry.getModel(modelId);
  if (model.provider === 'local') {
    // 本地 LM Studio（Qwen3.6-35B）
    return localLLM.call(messages, tools);
  } else {
    // 云端 MiniMax / OpenAI / Anthropic
    return cloudLLM.call(messages, tools);
  }
}
```

---

## 8. 定时任务与自我修复（Claude Code Cron/Dream + Pi + 盘古）

### 8.1 Cron 定时任务（Hermes cron）

已有：`hermes cron` — 每分钟/每小时/每天触发，支持 skill 注入。

### 8.2 autoDream 自动记忆（Claude Code dream）

```javascript
// modules/dream.js
// Claude Code 的 dream consolidation 流程
class DreamConsolidator {
  constructor({ eventBus, sessionStore }) {
    this.eb = eventBus;
    this.ss = sessionStore;
  }

  // 4阶段整合（Claude Code cron-dream）
  async consolidate(sessionId) {
    // 阶段1：收集最近对话
    const recent = await this.ss.load(sessionId);
    
    // 阶段2：识别关键事件
    const events = this.extractEvents(recent.messages);
    
    // 阶段3：生成摘要
    const summary = await this.llm.summarize(events);
    
    // 阶段4：更新 session
    await this.ss.update(sessionId, { _dream_summary: summary });
    
    await this.eb.emit('dream_complete', { sessionId, summary });
  }
}
```

### 8.3 自我修复（health.js，已有）

```javascript
// modules/health.js
// 已有功能：
// - 内存监控（>500MB 预警）
// - 事件循环延迟检测（>100ms 预警）
// - 心跳文件 + .health.lock
// - 自动重启（PM2 或直接 spawn）
```

### 8.4 自我净化（cleanup.js，已有）

```javascript
// modules/cleanup.js
// 已有功能：
// - 多目录清理（crash 日志/临时文件/hermes 缓存）
// - 磁盘空间检测（<500MB 自动清理）
// - 清理计划日志
```

---

## 9. 工具层（Pi bash/read/write/edit × Claude Code MCP）

### 9.1 文件工具族（Pi 生产级 + 盘古增强）

已在 `modules/tools/index.js` 实现（对比 Pi）：

| Pi (行数) | 盘古 | 差距 |
|-----------|------|------|
| read.ts 15,567 | file_read | 盘古需补：glob、Unicode、二进制检测、超大文件截断 |
| write.ts 9,934 | file_write | 盘古已补：原子写入、备份、目录自动创建 |
| edit.ts 15,439 | file_edit | 盘古已补：字符串替换、replace_all |
| bash.ts 15,350 | code_executor | 盘古已补：spawn、流式、临时文件、信号取消 |

**还需要补齐的 Pi 级差距：**

```
Pi read.ts 核心逻辑（盘古还缺的）：
1. Unicode NFC/NFD 规范化
2. xattr 扩展属性读取
3. 二进制文件截断（PIXBUF / 字体文件检测）
4. glob 再展开（**/*.js 递归）
5. 路径别名（~、..、符号链接解析）

Pi bash.ts 核心逻辑（盘古还缺的）：
1. PTY 模式（pseudo-terminal，用于交互式命令）
2. SIGINT 传递（Ctrl+C 转发给子进程）
3. 环境变量隔离（clearenv + 最小化 env）
```

### 9.2 代码执行（Pi spawn + Claude Code 沙箱）

已在 `modules/code_executor.js` 实现。

### 9.3 MCP 工具适配器（Claude Code MCP）

已在 `modules/mcp_adapter.js` 设计。

### 9.4 工具注册与发现

```javascript
// 工具注册流程
function registerTools(tools) {
  for (const [name, fn] of Object.entries(tools)) {
    if (name.startsWith('_')) continue; // 私有工具跳过
    
    // 注册到 Agent Loop
    agentLoop.registerTool(name, fn);
    
    // 注册到 Skill Runtime
    skillRuntime.registerTool(name, fn);
    
    // 注册到 EventBus
    eventBus.registerTool(name, fn);
    
    // 注册到 Permission Engine
    permissionEngine.registerTool(name, fn);
  }
}
```

---

## 10. 通讯层（Hermes Gateway + OpenClaw Commander）

### 10.1 Gateway 多平台接入（Hermes，已有）

```javascript
// modules/gateway
// 已有：WeChat / Telegram / HTTP / WebSocket
// 统一消息格式：{ platform, chat_id, message, sender }
```

### 10.2 Commander 任务下发（OpenClaw）

```javascript
// modules/commander.js
// OpenClaw 的核心：任务下发 + 中间件链
class Commander {
  constructor({ gateway, skillRuntime }) {
    this.gateway = gateway;
    this.sr = skillRuntime;
    this.middlewares = [];
  }

  // 中间件链（Express 风格）
  use(fn) {
    this.middlewares.push(fn);
  }

  // 任务下发（OpenClaw commander）
  async dispatch(task) {
    const ctx = { task, startTime: Date.now() };
    
    // 中间件链
    for (const mw of this.middlewares) {
      await mw(ctx);
      if (ctx.handled) return; // 中间件自行处理
    }
    
    // 路由到 skill runtime
    const result = await this.sr.invoke(task.skill, ctx);
    return result;
  }

  // 任务状态查询（OpenClaw relay）
  async queryStatus(taskId) {
    return this.tasks.get(taskId);
  }
}
```

### 10.3 消息路由与转发

```javascript
// 消息路由
async function routeMessage(msg) {
  // 1. 平台解析
  const { platform, chat_id, content } = parsePlatformMessage(msg);
  
  // 2. 认证
  const user = await auth.authenticate(msg);
  
  // 3. 意图识别（64卦）
  const { gua, yao } = await liushisanchi.infer(content);
  
  // 4. 路由到对应 handler
  const handler = router.get(gua.hexagram);
  
  // 5. 执行
  const result = await handler({ user, content, context: { gua, yao } });
  
  // 6. 响应
  return sendTo(platform, chat_id, result);
}
```

---

## 11. 多 Agent 协作（Claude Code Teams × Hermes delegation）

### 11.1 Orchestrator 模式

```javascript
// modules/teams.js
class TeamsOrchestrator {
  constructor() {
    this.workers = new Map(); // worker_id → worker
  }

  // 启动一个 worker
  spawnWorker(config) {
    const id = 'w_' + Date.now();
    const worker = {
      id,
      pid: spawn('node', ['worker.js', id]),
      mailbox: new Mailbox(),
      status: 'idle',
    };
    this.workers.set(id, worker);
    return id;
  }

  // 主任务拆分
  async orchestrate(task) {
    // 1. 分解任务为子任务
    const subtasks = this.decompose(task);
    
    // 2. 分派给 workers（并行）
    const results = await Promise.all(
      subtasks.map((st, i) => this.workers[i % this.workers.size].mailbox.send(st))
    );
    
    // 3. 聚合结果
    return this.aggregate(results);
  }
}
```

### 11.2 Mailbox 消息传递（Claude Code Teams）

```javascript
// 邮箱队列（线程安全）
class Mailbox {
  constructor() {
    this._queue = [];
    this._handlers = [];
  }

  send(message) {
    this._queue.push(message);
    // 唤醒等待的 handler
    for (const h of this._handlers) h(message);
  }

  async receive() {
    if (this._queue.length > 0) return this._queue.shift();
    // 阻塞等待
    return new Promise(resolve => {
      this._handlers.push(msg => {
        this._queue.shift();
        resolve(msg);
      });
    });
  }
}
```

---

## 12. 实施路线图

### Phase 1：基础设施补齐（1-2周）

- [ ] `agent_loop.js` — 事件驱动循环 + Hooks 接入
- [ ] `permission.js` — 权限引擎（LOW/MEDIUM/HIGH/FULL）
- [ ] `sandbox.js` — 文件系统沙箱 + 网络沙箱
- [ ] `mcp_adapter.js` — MCP 协议适配器
- [ ] `model_registry.js` — 多 provider 统一封装（本地+云端）
- [ ] 补齐 Pi 级 read.ts 差距（二进制检测/glob/Unicode）

### Phase 2：高级功能（2-4周）

- [ ] `plan_mode.js` — 计划文件管理 + 权限上下文
- [ ] `dream.js` — autoDream 自动记忆压缩
- [ ] `teams.js` — Orchestrator + Worker + Mailbox
- [ ] `commander.js` — OpenClaw 风格任务下发中间件链
- [ ] `skill_loader.js` — Pi 风格文件系统技能加载
- [ ] Session compaction 接入 Agent Loop

### Phase 3：优化打磨（持续）

- [ ] PTY 模式支持（交互式命令）
- [ ] 环境变量隔离（沙箱加固）
- [ ] 分布式 Session（JSONL → PostgreSQL）
- [ ] 多租户权限（用户级别权限）
- [ ] MCP 服务端（让盘古作为 MCP 服务器被其他工具调用）

---

## 13. 对比总表

| 维度 | Claude Code | OpenClaw | Hermes | Pi | 盘古 |
|------|-------------|----------|--------|-----|------|
| **推理引擎** | 无 | 无 | 无 | 无 | ✅ 64卦概率场 |
| **Agent Loop** | 基础 | 无 | 无 | ✅ EventStream | ⚠️ 待建 |
| **工具质量** | ✅ MCP | 垂直 | 基础 | ✅ 生产级 | ⚠️ 大部分完成 |
| **Hook System** | ✅ 完善 | 无 | 基础 | ✅ EventStream | ⚠️ 待建 |
| **Permission** | ✅ 多级 | 无 | 无 | 无 | ⚠️ 待建 |
| **Sandbox** | ✅ 文件+网络 | 无 | 无 | 无 | ⚠️ 待建 |
| **Session 存储** | JSON | 无 | SQLite | ✅ JSONL | ⚠️ 待升级 |
| **Compaction** | 自动摘要 | 无 | 无 | ✅ 自动摘要 | ✅ 已实现 |
| **多 Provider** | Anthropic | 无 | 基础 | ✅ 9+ | ⚠️ 待建 |
| **Skill 系统** | ✅ .md 格式 | 无 | ✅ skill_view | ✅ 文件加载 | ✅ 已有 |
| **Plan 模式** | ✅ plan 文件 | 无 | ✅ 计划模式 | 无 | ⚠️ 待建 |
| **Teams** | ✅ Orch/Worker | 无 | ⚠️ delegation | 无 | ⚠️ 待建 |
| **Cron/Dream** | ✅ 完善 | 无 | ✅ cron | 无 | ⚠️ 待建 |
| **自愈/自净** | 无 | 无 | 无 | 无 | ✅ health+cleanup |
| **多平台接入** | 无 | ✅ 中间件 | ✅ Gateway | 无 | ✅ 已有 |
| **MCP 支持** | ✅ 协议 | 无 | 无 | 无 | ⚠️ 待建 |
| **EventBus** | 无 | 无 | ⚠️ 基础 | ✅ EventStream | ✅ 已实现 |
| **代码执行** | ✅ 沙箱 | 无 | 基础 | ✅ spawn+截断 | ✅ 已实现 |
| **文件工具** | 基础 | 无 | 基础 | ✅ 15k+ 行 | ⚠️ 大部分完成 |
| **通用工具** | 基础 | ✅ 垂直 | ✅ 完整 | 纯编码 | ✅ 完整 |
| **形态** | CLI/TUI | Server | CLI+Server | CLI | ✅ HTTP Server |
| **网络工具** | 限制 | 无 | 有 | 有 | ✅ 有 |

**图例：** ✅ = 已有/完善　⚠️ = 部分完成/待建　无 = 无此功能

---

## 附录：新建模块清单

| 文件路径 | 优先级 | 功能 |
|---------|--------|------|
| `modules/agent_loop.js` | P0 | 事件驱动 Agent 循环 |
| `modules/hooks.js` | P0 | Pre/Post Agent + Tool hooks |
| `modules/permission.js` | P0 | 权限策略引擎 |
| `modules/sandbox.js` | P0 | 文件/网络沙箱隔离 |
| `modules/mcp_adapter.js` | P0 | MCP 协议工具适配器 |
| `modules/model_registry.js` | P1 | 多 provider 模型注册 |
| `modules/plan_mode.js` | P1 | 计划模式管理 |
| `modules/dream.js` | P1 | autoDream 自动记忆 |
| `modules/teams.js` | P2 | Orchestrator + Worker |
| `modules/commander.js` | P1 | OpenClaw 风格任务下发 |
| `modules/skill_loader.js` | P1 | Pi 风格文件系统技能加载 |
| `modules/session.js` | P1 | Pi 风格 JSONL Session |
| `docs/integrated-architecture.md` | 参考 | 本文档 |