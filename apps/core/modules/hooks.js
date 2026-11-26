/**
 * modules/hooks.js
 * 盘古 · Hooks 系统 (P0-#21)
 *
 * PreToolUse / PostToolUse 钩子, 给 tool 行为装"中间件"
 * - PreToolUse: 改 tool args 或拒绝调用
 * - PostToolUse: 改 tool result 或追加日志
 *
 * 配置文件: ~/.pangu-data/hooks/<name>.js (CommonJS module)
 * 格式:
 *   module.exports = {
 *     events: ['PreToolUse', 'PostToolUse'],
 *     matcher: { tool_name: 'web_search' },  // 或 '*'
 *     handler: async (event, ctx) => {
 *       // event = { tool_name, params, result?, ok?, error?, execution_ms? }
 *       // PreToolUse 改 args: ctx.params = {...}
 *       // PreToolUse 拒绝调用: ctx.deny = true; ctx.reason = '...'
 *       // PostToolUse 改 result: ctx.result = {...}
 *       // 返回 { ok: true } 或 throw
 *     }
 *   }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HOOK_ROOT = path.join(process.env.HOME || '/tmp', '.pangu-data', 'hooks');

let _hooks = []; // [{ name, events, matcher, handler, path }]

/**
 * 启动时加载所有 hook
 */
async function loadAllHooks() {
  _hooks = [];
  if (!fs.existsSync(HOOK_ROOT)) {
    try {
      fs.mkdirSync(HOOK_ROOT, { recursive: true });
    } catch (_) {}
    return { loaded: [], failed: [], _meta: { root: HOOK_ROOT, note: '不存在, 已创建' } };
  }
  const entries = fs.readdirSync(HOOK_ROOT, { withFileTypes: true });
  const loaded = [];
  const failed = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const hookName = entry.name.replace(/\.js$/, '');
    try {
      const hookPath = path.join(HOOK_ROOT, entry.name);
      // H6 fix: require.cache 的 key 是 require.resolve() 的 canonical 绝对路径, 直接 delete 原字符串会静默失败
      delete require.cache[require.resolve(hookPath)];  // 重新加载
      const mod = require(hookPath);
      const hook = mod.default || mod;
      if (typeof hook.handler !== 'function') {
        throw new Error('缺 handler 函数');
      }
      if (!Array.isArray(hook.events)) {
        throw new Error('缺 events 数组 (PreToolUse / PostToolUse)');
      }
      _hooks.push({
        name: hookName,
        events: hook.events,
        matcher: hook.matcher || '*',
        handler: hook.handler,
        path: hookPath,
      });
      loaded.push({ name: hookName, events: hook.events, matcher: hook.matcher || '*' });
    } catch (e) {
      failed.push({ hook: hookName, error: e.message });
    }
  }
  return { loaded, failed };
}

/**
 * 触发 hook
 * @param {string} event - 'PreToolUse' | 'PostToolUse'
 * @param {object} ctx - { tool_name, params, result?, ok?, error?, execution_ms? }
 * @returns {Promise<object>} - 修改后的 ctx (PreToolUse: deny? params?, PostToolUse: result?)
 */
async function runHooks(event, ctx) {
  for (const hook of _hooks) {
    if (!hook.events.includes(event)) continue;
    // matcher 检查
    if (hook.matcher !== '*' && hook.matcher.tool_name && hook.matcher.tool_name !== ctx.tool_name) {
      continue;
    }
    try {
      // M11 fix: 单 hook 执行限时 5s, 防止死循环/阻塞 IO 永久挂起 tool 调用
      const HOOK_TIMEOUT_MS = 5000;
      const r = await Promise.race([
        hook.handler(event, ctx),
        new Promise((_, rej) => setTimeout(() => rej(new Error('hook timeout ' + HOOK_TIMEOUT_MS + 'ms')), HOOK_TIMEOUT_MS)),
      ]);
      if (r && r.ok === false) {
        ctx._hookError = r.error || 'hook error';
        if (event === 'PreToolUse') ctx.deny = true;
      }
    } catch (e) {
      // 隔离: hook 失败不毁 tool 调用, 只 log
      ctx._hookError = e.message;
      console.warn(`[hook] ${hook.name} ${event} failed:`, e.message);
    }
  }
  return ctx;
}

/**
 * 列举已加载 hook
 */
function listHooks() {
  return _hooks.map(h => ({ name: h.name, events: h.events, matcher: h.matcher, path: h.path }));
}

module.exports = {
  HOOK_ROOT,
  loadAllHooks,
  runHooks,
  listHooks,
};