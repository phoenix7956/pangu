#!/usr/bin/env node
// Pangu · agent_test_harness.js (2026-07-15 §老板拍)
// 老板 RTF(盘古对话问题.rtf) §3 描述的"子 agent 调用测试工具" Node CLI 版
//
//   设计要点 (跟 RTF 一致):
//   1. CLI 接口: --agent <name> --task "<text>" --context <json-string> [--dry-run|--execute]
//   2. 内部读取 apps/core/agents/agents.json 真规范 (8 角色) — 2026-07-18 N2 fix, 替代 yaml
//   3. --spec <name> 打印指定 agent 的规范摘要 (老板据 RTF 说"用于人工核验")
//   4. --list-agents 列出 8 角色
//   5. --dry-run 模式: 模拟 Planner JSON 输出 + 模拟子 agent 模拟回执 (不调用 Pangu server)
//   6. --execute 模式: 通过 fetch 调真实的 /api/pangu/agent/run/<name> 端点
//   7. 错误处理: 无效 agent / 空 task / context 非法 JSON / 文件缺失
//
//   用法:
//     node tools/agent_test_harness.js --list-agents
//     node tools/agent_test_harness.js --spec analyzer
//     node tools/agent_test_harness.js --agent planner --task "review 一下 PR" --dry-run
//     node tools/agent_test_harness.js --agent executor --task "建 hello.txt" --execute --base http://127.0.0.1:18901
//
//   单一文件, 零外部依赖 (Node 22+ 自带 fs/path/child_process/url).

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// ---- 路径常量 ----------------------------------------------------------
const PANGU_ROOT = path.resolve(__dirname, '..');                  // tools/ → pangu/
// 2026-07-18 N2 fix: agents.yaml 双源漂移 + 工具列表过时, 真规范改 agents.json
// (yaml 仍保留在仓库做历史参考, 但 harness 不再读)
const AGENTS_JSON = path.join(PANGU_ROOT, 'agents', 'agents.json'); // 真规范源
const AGENT_CATALOG = path.join(PANGU_ROOT, 'agents', 'registry.js'); // 真角色定义

// ---- mini YAML 解析: 不引依赖, 业务需要的字段能取 --------------------
// RTF 说"内部模拟 Planner JSON 输出格式" — 但 RTF 同时承认
// agents.yaml 里的 tools 字段 ('todo_write'/'plan_create'/...) 在真实 modules/tools/index.js
// 里**不存在** (老板 audit 已确认 agents.yaml ≠ dispatcher.js ROLES 字段).
// 这里让 harness 显式标出"agents.yaml 工具列表 ≠ 真实工具集, 以 dispatcher.js ROLES 为准",
// 避免 RTF 里那段记忆错误被 harness 沿用.
function parseLightYaml(text) {
  const agents = {};
  let cur = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const m = line.match(/^(\s+)?([a-zA-Z_][\w]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const indent = (m[1] || '').length;
    const key = m[2];
    const val = m[3].trim();
    if (indent === 0 && !val) {
      if (key === 'agents') { cur = {}; continue; }
    }
    if (indent >= 2 && !val) {
      // 块起点: 如 '  planner:'
      cur[key] = {};
      continue;
    }
    if (cur === null || cur === undefined) continue;
    const block = cur; // indent >= 4 的字段属于最近的内层块
    // 顶层 agents 块的子项
    if (indent >= 2 && typeof block === 'object') {
      // agents.planer 是顶层块 (indent >= 4 + 0 length), 这里我们递归找最近的 object
      const target = findDeepestBlock(cur, indent);
      if (target) target[key] = parseVal(val);
    }
  }
  return cur || {};
}
function findDeepestBlock(obj, minIndent) {
  // 简化: 直接 flatten 处理, 用缩进栈
  // 因为我们 indent >= 2 都进 cur, ≥ 4 进 cur[key]; 这里 schema 知道 agents block 下的
  // agent 是 indent 2 块, agent 内字段是 indent 4+ 行, 不递归 — 用占位实现
  return obj;
}
function parseVal(s) {
  if (s === '' || s === '[]') return [];
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).split(',').map(x => x.trim().replace(/^"|"$/g, ''));
  return s;
}

// 真正可工作的方案: 直接正则解析缩进, 不引第三方
function parseAgentsYaml(text) {
  const agents = {};
  const lines = text.split('\n');
  // 找到 'agents:' 顶层
  let inAgents = false;
  let curName = null;
  let curAgent = null;
  let curTools = null;
  for (const raw of lines) {
    if (raw.match(/^agents:\s*$/)) { inAgents = true; continue; }
    if (!inAgents) continue;
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    // 跳过结尾的 # ... 说明
    if (raw.match(/^\s*#/) && !raw.includes(':')) continue;
    const m = raw.match(/^(\s*)([^:]+):\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2].trim();
    const val = m[3].trim();
    if (indent === 2 && !val) {
      // 块起点: 一个 agent 名
      curName = key;
      curAgent = {};
      curTools = null;
      agents[curName] = curAgent;
      continue;
    }
    if (!curAgent) continue;
    if (indent >= 4) {
      if (key === 'tools' && val === '') {
        curTools = [];
        curAgent.tools = curTools;
      } else if (curTools && /^[-\s]/.test(raw.slice(0, indent))) {
        // 缩进更深的 list item
        const item = val.replace(/^-\s*/, '').replace(/^"|"$/g, '');
        curTools.push(item);
        curAgent.tools = curTools;
      } else {
        curAgent[key] = parseVal(val);
      }
    }
  }
  return agents;
}

// ---- 错误类 -----------------------------------------------------------
class InvalidAgentError extends Error {
  constructor(name) {
    super(`InvalidAgentError: "${name}" 不在 8 角色之列 — 用 --list-agents 查可用名`);
    this.name = 'InvalidAgentError';
  }
}
class EmptyTaskError extends Error {
  constructor() { super('EmptyTaskError: 任务描述不能为空'); this.name = 'EmptyTaskError'; }
}
class InvalidContextError extends Error {
  constructor(msg) { super('InvalidContextError: ' + msg); this.name = 'InvalidContextError'; }
}

// ---- 加载 agents 真实规范 ---------------------------------------------
function loadAgentsCatalog() {
  if (!fs.existsSync(AGENTS_JSON)) {
    throw new Error(`agents.json 不存在: ${AGENTS_JSON} — 检查 Pangu 仓库结构`);
  }
  const text = fs.readFileSync(AGENTS_JSON, 'utf8');
  const parsed = JSON.parse(text);
  // agents.json 结构: { _comment, _meta_agents, _worker_agents, agents: { planner: {...}, ... } }
  const agents = parsed.agents || {};
  return { source: 'agents/agents.json', agents };
}

// CLI 的 --agent 是**外部输入**: 老脚本/老文档里全是英文 (analyzer/executor/...)。
// 拼音是唯一身份, 所以读进来先归一, 往下只用拼音 —— 认不出来就原样留着,
// 让 `cat.agents[agentName]` 如实报 "不在 8 角色之列", 不猜。
// 2026-10-18: agents.json 的键整批改成拼音之后, 这里没跟着归一 →
// `--agent analyzer` 直接被拒, 而这是文档里一直在教的用法。
function _canonAgentName(name) {
  try {
    return require('../agents/gua-identity').resolveRole(name) || name;
  } catch (_) { return name; }
}

// ---- 子命令实现 -----------------------------------------------------
function cmdListAgents() {
  const cat = loadAgentsCatalog();
  const names = Object.keys(cat.agents);
  console.log('Pangu · 8 Agent Catalog (' + cat.source + ', 加载于 ' + new Date().toISOString() + ')');
  console.log('');
  for (const k of names) {
    const a = cat.agents[k] || {};
    console.log(`  ${k.padEnd(12)} ${(a.name_cn || '').padEnd(4)}  ${a.name} (主卦 ${a.hex_main || '?'}) — ${a.role || ''}`);
  }
  console.log('');
  console.log('  注: agents.json 是真规范源, 工具列表以 agents/qian.js ROLES 表为准.');
  console.log('  本工具打印 agents.json 内容仅做 "人工核验", 真实执行请用 --execute 模式.');
}

function cmdSpec(agentName) {
    if (!agentName) throw new InvalidAgentError('');
  agentName = _canonAgentName(agentName);   // CLI 输入归一: 拼音是唯一身份, 英文只在这一行读进来
  const cat = loadAgentsCatalog();
  const a = cat.agents[agentName];
  if (!a) {
    const valid = Object.keys(cat.agents).join(', ');
    throw new InvalidAgentError(`${agentName} (可用: ${valid})`);
  }
  console.log(`=== Agent 规范摘要: ${agentName} ===`);
  console.log(`名称:     ${a.name}`);
  console.log(`中文名:   ${a.name_cn}`);
  console.log(`主卦:     ${a.hex_main} (${a.hex_main_no})`);
  console.log(`辅卦:     ${(a.hex_aux || []).join(' / ')}`);
  console.log(`角色描述: ${a.role}`);
  console.log(`工具列表 (来自 agents.yaml, 仅供参考):`);
  if (Array.isArray(a.tools) && a.tools.length > 0) {
    for (const t of a.tools) console.log(`  - ${t}`);
  } else {
    console.log('  (空)');
  }
  console.log('');
  console.log('注: 真实工具集请执行: node tools/agent_test_harness.js --agent <name> --task "<x>" --execute');
}

function cmdDryRun(agentName, task, context) {
    if (!agentName) throw new InvalidAgentError('');
  agentName = _canonAgentName(agentName);   // CLI 输入归一: 拼音是唯一身份, 英文只在这一行读进来
  if (!task || !task.trim()) throw new EmptyTaskError();
  const cat = loadAgentsCatalog();
  if (!cat.agents[agentName]) {
    const valid = Object.keys(cat.agents).join(', ');
    throw new InvalidAgentError(`${agentName} (可用: ${valid})`);
  }

  // 模拟 Planner JSON (RTF 3 节指定格式)
  const plannerJson = {
    agent: agentName,
    task: task,
    context: context || {},
    plan: [
      `读取 ${agentName} 角色规范 (主卦 + 辅卦 + 工具集)`,
      `基于规范与任务生成执行步骤`,
      `执行步骤并产出结构化结果`,
    ],
    trace_steps: [
      { order: 1, phase: 'thinking', role: 'kan', action: '读取角色配置', detail: `加载 agents.yaml 中 ${agentName} 规范的元数据`, took_ms: 5, ok: true },
      { order: 2, phase: 'acting',   role: agentName, action: '执行任务 (mock)', detail: task.slice(0, 80), took_ms: 0, ok: true },
      { order: 3, phase: 'done',     role: agentName, action: '产出回执',           detail: `dry-run 模式, 已模拟返回 (未真实调用 Pangu server)`, took_ms: 1, ok: true },
    ],
    dispatch_classification: {
      dispatcher: 'pangu-v2 (LLM-first)',
      trace_v: 'pangu-v2 (LLM-first)',
      confidence: 0.85,
      reasoning: `dry-run mode: ${agentName} 与任务"${task.slice(0, 30)}${task.length > 30 ? '...' : ''}" 意图匹配,confidence=mock 0.85`,
    },
  };

  // 模拟回执 — RTF "子 agent 完成" 行样例
  const receipt = {
    ok: true,
    agent: agentName,
    mode: 'dry-run',
    summary: `[dry-run] ${agentName} 模拟执行任务`,
    data: {
      task,
      agent_name: agentName,
      keywords: extractKeywords(task),
      complexity: task.length < 30 ? 'low' : task.length < 80 ? 'medium' : 'high',
      plan: plannerJson.plan,
      dry_run_note: '这是模拟回执, 真执行请用 --execute 模式',
    },
  };

  console.log('=== Planner 输出 (模拟 RTF §3 描述格式) ===');
  console.log(JSON.stringify(plannerJson, null, 2));
  console.log('');
  console.log('=== 模拟子 agent 回执 (raw) ===');
  console.log(JSON.stringify(receipt, null, 2));
}

function cmdExecute(agentName, task, context, baseUrl) {
    if (!agentName) throw new InvalidAgentError('');
  agentName = _canonAgentName(agentName);   // CLI 输入归一: 拼音是唯一身份, 英文只在这一行读进来
  if (!task || !task.trim()) throw new EmptyTaskError();
  const cat = loadAgentsCatalog();
  if (!cat.agents[agentName]) {
    const valid = Object.keys(cat.agents).join(', ');
    throw new InvalidAgentError(`${agentName} (可用: ${valid})`);
  }
  const base = (baseUrl || process.env.PANGU_BASE || 'http://127.0.0.1:18901').replace(/\/+$/, '');
  // Keep the task payload separate from the optional task type.
  const query = new URLSearchParams({
    goal: task,
    context: JSON.stringify(context || {}),
  });
  const targetPath = `/api/agent/run/${encodeURIComponent(agentName)}?${query}`;

  console.log(`[execute] GET ${base}${targetPath}`);
  return panguFetch('GET', base, targetPath, null, 60000).then(resp => {
    console.log('=== 真实 Pangu server 返回 ===');
    console.log(JSON.stringify(resp, null, 2));
    if (resp.http < 200 || resp.http >= 300 || resp.body?.ok === false) {
      console.error('[execute] Agent execution failed');
      process.exitCode = 1;
    }
  }).catch(e => {
    console.error('[execute] 调用失败:', e.message);
    console.error('回退建议: 用 --dry-run 模拟, 或确认 Pangu server 在', base, '运行');
    process.exit(1);
  });
}

function panguFetch(method, base, path, body, timeoutMs) {
  const u = new URL(base + path);
  return new Promise((resolve, reject) => {
    const hasBody = method !== 'GET' && method !== 'HEAD' && body !== undefined && body !== null;
    const data = hasBody ? JSON.stringify(body) : '';
    const lib = u.protocol === 'https:' ? https : http;
    const headers = hasBody ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: method || 'GET',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve({ http: res.statusCode, body: j });
        } catch (e) {
          resolve({ http: res.statusCode, body: body });
        }
      });
    });
    req.on('timeout', () => reject(new Error('timeout after ' + timeoutMs + 'ms')));
    req.on('error', reject);
    if (hasBody) req.write(data);
    req.end();
  });
}

// ---- 简单 utility ---------------------------------------------------
function extractKeywords(text) {
  if (!text) return [];
  const words = String(text).split(/[\s,.,!?;:]+/).filter(w => w.length >= 2);
  return Array.from(new Set(words)).slice(0, 6);
}

// ---- 入口 + CLI parse -----------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') out.agent = argv[++i];
    else if (a === '--task') out.task = argv[++i];
    else if (a === '--context') out.context = argv[++i];
    else if (a === '--spec') out.spec = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--execute') out.execute = true;
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--list-agents') out.listAgents = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('--')) out._.push(a);
    else { console.error('Unknown flag: ' + a); process.exit(2); }
  }
  return out;
}

function showHelp() {
  console.log(`用法: node tools/agent_test_harness.js [选项]

Pangu · 8 子 Agent 测试 harness (RTF 盘古对话问题.rtf §3 实现)

选项:
  --list-agents              列出所有 8 角色 + 规范摘要
  --spec <name>              打印指定 agent 的详细规范
  --agent <name>             调用的将灵名 (qian/kan/li/kun/dui/xun/zhen/gen —— 只认拼音和卦名)
  --task "<text>"            任务描述 (--agent 必须 + 非空)
  --context '{"k":"v"}'       上下文 JSON 字符串 (可选)
  --dry-run                   不调 server, 模拟 Planner + 子 agent 回执
  --execute                   真调 Pangu server (/api/agent/<name>/execute)
  --base <url>               Pangu server base (默认 http://127.0.0.1:18901)
                             也可设环境变量 PANGU_BASE

示例:
  node tools/agent_test_harness.js --list-agents
  node tools/agent_test_harness.js --spec li
  node tools/agent_test_harness.js --agent kan --task "复盘上次失败" --dry-run
  node tools/agent_test_harness.js --agent kun --task "写 hello.txt" --execute
  node tools/agent_test_harness.js --agent xun --task "排查 JVM OOM" --execute --base http://localhost:18901

错误类别:
  InvalidAgentError  agent 名不在 8 角色之内
  EmptyTaskError      --task 缺失或空白
  InvalidContextError --context 不是合法 JSON

退出:
  0 = 成功
  1 = Pangu server 错误
  2 = 参数错
`);
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.help || argv.length === 0) {
    showHelp();
    process.exit(0);
  }
  try {
    if (args.listAgents) {
      cmdListAgents();
    } else if (args.spec) {
      cmdSpec(args.spec);
    } else if (args.dryRun) {
      let ctx = {};
      if (args.context) {
        try { ctx = JSON.parse(args.context); }
        catch (e) { throw new InvalidContextError(e.message); }
      }
      cmdDryRun(args.agent, args.task, ctx);
    } else if (args.execute) {
      let ctx = {};
      if (args.context) {
        try { ctx = JSON.parse(args.context); }
        catch (e) { throw new InvalidContextError(e.message); }
      }
      cmdExecute(args.agent, args.task, ctx, args.base).then(() => process.exit(process.exitCode || 0));
      return;
    } else {
      console.error('错误: 缺操作. 跑 --help 查看用法.');
      process.exit(2);
    }
  } catch (e) {
    console.error('\n[' + (e.name || 'Error') + '] ' + e.message);
    process.exit(2);
  }
  process.exit(0);
}

main();
