/**
 * modules/plugin_loader.js
 * 盘古 · Plugin loader (P0-#23 · P0-10 Plugin marketplace)
 *
 * 从 ~/.pangu-data/plugins/<name>/ 加载 plugin, 注册其 tools 进 in-process tool 池
 * 每个 plugin 独立 require, 隔离失败 (一个 plugin 坏不毁整个 Pangu)
 *
 * v1 (按 spec §2): 本地 plugin, 不接 marketplace API
 *    plugin 目录结构:
 *      ~/.pangu-data/plugins/<name>/
 *        plugin.json       # { name, version, author, tools: [{name, schema, handler}] }
 *        <handler path>    # 实际 handler module (相对 plugin.json 解析)
 *
 * 学 P0-#18/16/17 风格: 懒加载 + 显式 module.exports + try/catch 隔离
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = path.join(process.env.HOME || '/tmp', '.pangu-data', 'plugins');

/**
 * 加载所有 plugin + 注册其 tools
 * @param {object} toolRegistry - { handlers: {}, schemas: {}, list: [] }
 * @returns {Promise<{ loaded: [], failed: [] }>}
 */
async function loadAllPlugins(toolRegistry) {
  const loaded = [];
  const failed = [];

  // 确保 plugin 目录存在
  try {
    if (!fs.existsSync(PLUGIN_ROOT)) {
      fs.mkdirSync(PLUGIN_ROOT, { recursive: true });
      return { loaded, failed, _meta: { root: PLUGIN_ROOT, note: 'plugin root 不存在, 已创建' } };
    }
  } catch (e) {
    failed.push({ plugin: '<root>', error: `创建 plugin root 失败: ${e.message}` });
    return { loaded, failed };
  }

  // 扫 plugin 目录
  let entries;
  try {
    entries = fs.readdirSync(PLUGIN_ROOT, { withFileTypes: true });
  } catch (e) {
    failed.push({ plugin: '<root>', error: `读 plugin root 失败: ${e.message}` });
    return { loaded, failed };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginName = entry.name;
    const pluginDir = path.join(PLUGIN_ROOT, pluginName);
    try {
      const info = await loadOnePlugin(pluginName, pluginDir, toolRegistry);
      loaded.push(info);
    } catch (e) {
      // 隔离失败 — 一个 plugin 坏不毁 Pangu
      failed.push({ plugin: pluginName, error: e.message });
    }
  }

  return { loaded, failed, _meta: { root: PLUGIN_ROOT, scanned: entries.filter(e => e.isDirectory()).length } };
}

/**
 * 加载单个 plugin
 * @returns {Promise<{ name, version, tools: [], handler_paths: [] }>}
 */
async function loadOnePlugin(pluginName, pluginDir, toolRegistry) {
  // 1. 读 plugin.json
  const pluginJsonPath = path.join(pluginDir, 'plugin.json');
  if (!fs.existsSync(pluginJsonPath)) {
    throw new Error('缺 plugin.json');
  }
  const meta = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
  if (meta.name !== pluginName) {
    throw new Error(`plugin.json name (${meta.name}) 与目录名 (${pluginName}) 不匹配`);
  }

  const result = {
    name: meta.name,
    version: meta.version || '0.0.0',
    author: meta.author || 'unknown',
    dir: pluginDir,
    tools: [],
    handler_paths: [],
  };

  // 2. 注册每个 tool
  if (!Array.isArray(meta.tools)) {
    return result;
  }

  for (const toolMeta of meta.tools) {
    if (!toolMeta.name || !toolMeta.handler) {
      result.tools.push({ name: toolMeta.name, error: 'tool 缺 name 或 handler' });
      continue;
    }
    const handlerPath = path.resolve(pluginDir, toolMeta.handler);
    if (!fs.existsSync(handlerPath)) {
      result.tools.push({ name: toolMeta.name, error: `handler 不存在: ${handlerPath}` });
      continue;
    }
    try {
      // require handler module (每个 plugin 独立 require, 隔离命名冲突)
      const handlerModule = require(handlerPath);
      const handler = typeof handlerModule === 'function' ? handlerModule : handlerModule.default || handlerModule.handler;
      if (typeof handler !== 'function') {
        result.tools.push({ name: toolMeta.name, error: 'handler 不是函数' });
        continue;
      }
      // 注册到 toolRegistry
      const fullName = `plugin_${meta.name}__${toolMeta.name}`;
      toolRegistry.handlers[fullName] = async (ctx) => {
        try {
          const r = await handler(ctx.params || {}, ctx);
          return r;
        } catch (e) {
          return { ok: false, error: { code: 'PLUGIN_HANDLER_ERROR', message: e.message } };
        }
      };
      // schema (从 plugin.json 内嵌, 或 handler module 自带 schema export)
      let schema = toolMeta.schema || handlerModule.schema;
      if (typeof schema === 'string') {
        try { schema = JSON.parse(schema); } catch (_) { schema = null; }
      }
      if (schema) {
        toolRegistry.schemas[fullName] = {
          type: 'function',
          function: {
            name: fullName,
            description: `${meta.name}/${toolMeta.name} (plugin) — ${meta.description || meta.author || 'no desc'}`,
            parameters: schema,
            meta: { required_capabilities: toolMeta.required_capabilities || ['plugin'] },
          },
        };
      }
      toolRegistry.list.push(fullName);
      result.tools.push({ name: toolMeta.name, full_name: fullName, ok: true });
      result.handler_paths.push(handlerPath);
    } catch (e) {
      result.tools.push({ name: toolMeta.name, error: `require 失败: ${e.message}` });
    }
  }

  return result;
}

/**
 * 列举本地 plugin (不 require, 只列 metadata)
 * @returns {Array<{name, version, author, tools_count, path}>}
 */
function listPlugins() {
  if (!fs.existsSync(PLUGIN_ROOT)) return [];
  const entries = fs.readdirSync(PLUGIN_ROOT, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(PLUGIN_ROOT, entry.name);
    const pluginJsonPath = path.join(pluginDir, 'plugin.json');
    let meta = { name: entry.name, version: '?', author: '?', tools_count: 0 };
    try {
      if (fs.existsSync(pluginJsonPath)) {
        const j = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
        meta = {
          name: j.name || entry.name,
          version: j.version || '?',
          author: j.author || '?',
          tools_count: Array.isArray(j.tools) ? j.tools.length : 0,
          description: j.description || '',
          path: pluginDir,
        };
      } else {
        meta.path = pluginDir;
        meta.error = '缺 plugin.json';
      }
    } catch (e) {
      meta.error = `parse 失败: ${e.message}`;
    }
    out.push(meta);
  }
  return out;
}

/**
 * 卸 plugin (从 disk 删目录)
 * @returns {boolean}
 */
function removePlugin(pluginName, toolRegistry) {
  const safe = String(pluginName).replace(/[^a-zA-Z0-9_-]/g, '');
  if (safe !== pluginName) {
    throw new Error('plugin name 含非法字符 (只允许 a-zA-Z0-9_-)');
  }
  const dir = path.join(PLUGIN_ROOT, safe);
  if (!fs.existsSync(dir)) {
    throw new Error(`plugin ${pluginName} 不存在`);
  }
  if (toolRegistry) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    for (const item of Array.isArray(manifest.tools) ? manifest.tools : []) {
      if (!item?.name) continue;
      const fullName = `plugin_${safe}__${item.name}`;
      delete toolRegistry.handlers[fullName];
      delete toolRegistry.schemas[fullName];
      toolRegistry.list = toolRegistry.list.filter(name => name !== fullName);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * 搜本地 plugin (按 name/description 匹配 keyword)
 */
function searchPlugins(keyword) {
  const re = new RegExp(keyword.replace(/[.+^${}()|[\]\\]/g, '\\$&'), 'i');
  return listPlugins().filter(p => re.test(p.name) || re.test(p.description || '') || re.test(p.author || ''));
}

module.exports = {
  PLUGIN_ROOT,
  loadAllPlugins,
  loadOnePlugin,
  listPlugins,
  removePlugin,
  searchPlugins,
};

// 注: 不在这里 auto-load — 由 pangu-single.js 显式调 loadPluginsIntoTools() (顺序可控)
