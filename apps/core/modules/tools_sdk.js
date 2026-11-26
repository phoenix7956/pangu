/**
 * modules/tools_sdk.js
 * 盘古 · Tools SDK (P0-#20)
 *
 * 让老板能写自定义 tool 不改源码 — JSON Schema + JS handler 自动注册
 *
 * 设计 (§0.24 教训修后):
 * - CLI 部分 spec 假设 apps/cli/pangu.js 存在但实际没有 → 走 HTTP endpoint (server-only)
 * - Web UI 部分推 v2, v1 用文件 + HTTP API
 * - 跟 #23 plugin 协同: plugin 是 SDK 的一种用法 (handler.js 在 plugin 目录里)
 *
 * Tool 注册流程:
 *   1. 老板写 ~/.pangu-data/tools/<name>/tool.json (schema) + handler.js
 *   2. daemon boot 时 tools_sdk.loadAllSdkTools() 自动扫 + 注册
 *   3. 也可以走 /api/sdk/tools/add (上传 schema + handler) 远程加
 *
 * 工具 lifecycle:
 *   - loadAllSdkTools()     boot 时调, 跟 #23 plugin 一样
 *   - removeSdkTool(name)   从磁盘删目录 + unregister TOOLS/TOOLS_SCHEMA
 *   - listSdkTools()        列举 (跟 plugin 一样)
 *   - addSdkTool(meta, code)  从 HTTP 上传 (POST /api/sdk/tools/add)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SDK_ROOT = path.join(process.env.HOME || '/tmp', '.pangu-data', 'tools');

/**
 * loadAllSdkTools — 跟 #23 plugin 类似, 但 schema 在 tool.json 里强制要求, handler.js 强制 require
 * @param {object} toolRegistry - { handlers: TOOLS, schemas: TOOLS_SCHEMA, list: [] }
 * @returns {Promise<{loaded: [], failed: []}>}
 */
async function loadAllSdkTools(toolRegistry) {
  const loaded = [];
  const failed = [];

  // 确保目录存在
  try {
    if (!fs.existsSync(SDK_ROOT)) {
      fs.mkdirSync(SDK_ROOT, { recursive: true });
      return { loaded, failed, _meta: { root: SDK_ROOT, note: 'SDK root 不存在, 已创建' } };
    }
  } catch (e) {
    failed.push({ tool: '<root>', error: `创建 SDK root 失败: ${e.message}` });
    return { loaded, failed };
  }

  let entries;
  try {
    entries = fs.readdirSync(SDK_ROOT, { withFileTypes: true });
  } catch (e) {
    failed.push({ tool: '<root>', error: `读 SDK root 失败: ${e.message}` });
    return { loaded, failed };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const toolName = entry.name;
    const toolDir = path.join(SDK_ROOT, toolName);
    try {
      const info = await loadOneSdkTool(toolName, toolDir, toolRegistry);
      loaded.push(info);
    } catch (e) {
      failed.push({ tool: toolName, error: e.message });
    }
  }

  return { loaded, failed, _meta: { root: SDK_ROOT, scanned: entries.filter(e => e.isDirectory()).length } };
}

/**
 * 加载单个 SDK tool
 * @returns {Promise<{name, version, schema_loaded, handler_loaded, ...}>}
 */
async function loadOneSdkTool(toolName, toolDir, toolRegistry) {
  // 1. tool.json 强制要求 (跟 #23 plugin 不一样, SDK tool 必须有 schema)
  const toolJsonPath = path.join(toolDir, 'tool.json');
  if (!fs.existsSync(toolJsonPath)) {
    throw new Error('缺 tool.json');
  }
  const meta = JSON.parse(fs.readFileSync(toolJsonPath, 'utf8'));
  if (meta.name !== toolName) {
    throw new Error(`tool.json name (${meta.name}) 与目录名 (${toolName}) 不匹配`);
  }
  if (!meta.parameters || typeof meta.parameters !== 'object') {
    throw new Error('tool.json 缺 parameters (OpenAI JSON Schema 格式)');
  }

  // 2. handler.js 强制要求
  const handlerPath = path.join(toolDir, 'handler.js');
  if (!fs.existsSync(handlerPath)) {
    throw new Error(`缺 handler.js (跟 plugin 不同, SDK tool 必须有 handler)`);
  }

  // 3. require handler (隔离 try/catch)
  let handlerModule;
  try {
    handlerModule = require(handlerPath);
  } catch (e) {
    throw new Error(`require handler 失败: ${e.message}`);
  }
  const handler = typeof handlerModule === 'function' ? handlerModule : handlerModule.default || handlerModule.handler;
  if (typeof handler !== 'function') {
    throw new Error('handler 不是函数 (exports.default / exports.handler / module.exports 都不对)');
  }

  // 4. 注册到 TOOLS + TOOLS_SCHEMA
  // 命名: sdk_<name> (跟 plugin_<plugin>__<tool> 区分, SDK 工具是顶层 1 个, plugin 是 N 个)
  const fullName = `sdk_${meta.name}`;
  toolRegistry.handlers[fullName] = async (ctx) => {
    try {
      const r = await handler(ctx.params || {}, ctx);
      return r;
    } catch (e) {
      return { ok: false, error: { code: 'SDK_HANDLER_ERROR', message: e.message } };
    }
  };
  toolRegistry.schemas[fullName] = {
    type: 'function',
    function: {
      name: fullName,
      description: meta.description || `SDK tool ${meta.name} (auto-registered)`,
      parameters: meta.parameters,
      meta: { required_capabilities: meta.required_capabilities || ['sdk'] },
    },
  };
  // 加进 list (如果不在)
  if (!toolRegistry.list.includes(fullName)) toolRegistry.list.push(fullName);

  return {
    name: meta.name,
    version: meta.version || '0.0.0',
    author: meta.author || 'unknown',
    description: meta.description || '',
    dir: toolDir,
    handler_path: handlerPath,
    schema_loaded: true,
    handler_loaded: true,
    full_name: fullName,
  };
}

/**
 * 列举本地 SDK tool (不 require, 只 metadata)
 */
function listSdkTools() {
  if (!fs.existsSync(SDK_ROOT)) return [];
  const entries = fs.readdirSync(SDK_ROOT, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const toolDir = path.join(SDK_ROOT, entry.name);
    const toolJsonPath = path.join(toolDir, 'tool.json');
    let meta = { name: entry.name, version: '?', author: '?', path: toolDir };
    try {
      if (fs.existsSync(toolJsonPath)) {
        const j = JSON.parse(fs.readFileSync(toolJsonPath, 'utf8'));
        meta = {
          name: j.name || entry.name,
          version: j.version || '?',
          author: j.author || '?',
          description: j.description || '',
          path: toolDir,
          parameters_keys: j.parameters?.properties ? Object.keys(j.parameters.properties) : [],
        };
      } else {
        meta.error = '缺 tool.json';
      }
    } catch (e) {
      meta.error = `parse 失败: ${e.message}`;
    }
    out.push(meta);
  }
  return out;
}

/**
 * 卸 SDK tool
 */
function removeSdkTool(toolName, toolRegistry) {
  const safe = String(toolName).replace(/[^a-zA-Z0-9_-]/g, '');
  if (safe !== toolName) {
    throw new Error('tool name 含非法字符');
  }
  const dir = path.join(SDK_ROOT, safe);
  if (!fs.existsSync(dir)) {
    throw new Error(`SDK tool ${toolName} 不存在`);
  }
  const fullName = `sdk_${safe}`;
  if (toolRegistry) {
    delete toolRegistry.handlers[fullName];
    delete toolRegistry.schemas[fullName];
    toolRegistry.list = toolRegistry.list.filter(name => name !== fullName);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * 加 SDK tool (从 HTTP POST /api/sdk/tools/add)
 * @param {object} payload - { name, version?, author?, description?, parameters (JSON Schema), handler_code (string) }
 * @returns {object} { installed, path }
 */
function addSdkTool(payload) {
  const name = payload.name;
  if (!name) throw new Error('name required');
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '');
  if (safe !== name) throw new Error('name 含非法字符');
  if (!payload.parameters) throw new Error('parameters (JSON Schema) required');
  if (!payload.handler_code) throw new Error('handler_code (string) required');

  const dir = path.join(SDK_ROOT, safe);
  if (fs.existsSync(dir)) throw new Error('SDK tool 已存在, 先 remove');
  fs.mkdirSync(dir, { recursive: true });

  const toolJson = {
    name: safe,
    version: payload.version || '1.0.0',
    author: payload.author || 'feng',
    description: payload.description || `SDK tool ${safe} installed at ${new Date().toISOString()}`,
    parameters: payload.parameters,
  };
  fs.writeFileSync(path.join(dir, 'tool.json'), JSON.stringify(toolJson, null, 2));
  fs.writeFileSync(path.join(dir, 'handler.js'), payload.handler_code);
  return { installed: safe, path: dir, message: '下次 daemon restart 后生效' };
}

module.exports = {
  SDK_ROOT,
  loadAllSdkTools,
  loadOneSdkTool,
  listSdkTools,
  removeSdkTool,
  addSdkTool,
};
