/**
 * modules/permission_guard.js —— 权限档位的**执行层**闸门 (2026-10-28 · 第 136 批 P3)
 *
 * 为什么要有这个文件:
 *   设置页早就写着「只读: 只能查文件 / 跑只读命令, 不能写, 不能联网」,
 *   permission.js 的 default 档也确实写着 allowWrite:false / allowNetwork:false ——
 *   但 **`PermissionEngine.can()` 全仓没有任何调用方** (rg `\.can\(` 零命中)。
 *   ⇒ 切到「只读」只改了一个标签, 工具照样写盘、照样联网。
 *   这正是 AGENTS.md 铁律 1「注释 ≠ 隔离」的原样复发: 规则写在配置里, 执行层没接线。
 *
 * 与已有三道闸的分工 (不重叠):
 *   action_policy — 按**角色职能**划线 (只读将灵不许调写工具), 不受全局开关影响。
 *   sandbox       — 全局开关, 管路径白名单 + 致命命令模式。老板 8/1 拍默认关。
 *   permission    — 按**档位**决定"要不要弹审批" (shouldAsk), 只管"问不问", 不管"准不准"。
 *   permission_guard (本文件) — 按**档位**决定"准不准": 只读档真禁写禁网, 规划档只准写白名单路径。
 *
 * 判据口径全部复用现成真源, 不另抄一份:
 *   写盘判定 → action_policy.MUTATING_TOOLS + classifyCommand (含 exec 里的写命令)
 *   MCP 判定 → mcp_tool_exec.isMcpMutatingTool (名单外 fail-closed)
 *   档位     → permission.resolveEffectiveLevel (session override > global, 将灵 override 只能收紧)
 */

'use strict';

const ap = require('./action_policy');

// ── 写盘工具 ────────────────────────────────────────────────────────
//
// action_policy.MUTATING_TOOLS 是**只读角色**用的名单 (视角是"这个工具改不改状态")。
// 这里要的是"档位只读时哪些必须禁" —— 同一个视角, 但名单要更全:
//   action_policy 漏掉的写工具 (file_edit_batch / git_commit / todo_write …) 在这里补齐,
//   否则「只读档」会出现"禁了 write_file 却放过了 file_edit_batch"这种半拉子。
//
// 不在名单里的 (刻意放行):
//   todo_write / checkpoint_create —— 盘古**自己**的进度账本 (PANGU_HOME/state),
//   不是主人的文件。只读档禁它 = 盘古连"我在干第几步"都记不下来, 反而制造空转。
const WRITE_TOOLS = new Set([
  'write_file', 'file_edit', 'file_edit_batch', 'code_execute', 'batch_execute',
  'memory_write', 'cache_put', 'cache_preheat', 'cache_evict',
  'archive_create', 'archive_extract', 'send_wechat', 'clipboard_write',
  'computer_use_click', 'computer_use_type', 'computer_use_key', 'computer_use_drag',
  'computer_use_vision_act', 'permission_grant', 'permission_apply',
  'set_env_path', 'sleep_timer', 'run_installer',
  'git_commit', 'git_branch', 'git_add', 'git_reset', 'git_checkout', 'git_stash',
  // 会把产物写盘的几个 (名字取自 modules/tools/index.js 的真名, 别照着旧文档写):
  'media_generate', 'draw_layout', 'take_photo', 'record_audio',
]);

// ── 网络工具 ────────────────────────────────────────────────────────
const NETWORK_TOOLS = new Set([
  'web_search', 'web_fetch', 'weather_check', 'news_digest', 'github_api',
  'currency_check', 'crypto_price', 'translate_text', 'http_request',
]);

// exec_command 里裹着的联网动作 —— 工具名看不出来, 只能看命令。
// 只读档说"不能联网", 那 `curl` / `wget` / `ssh` 这类必须一起算进网络,
// 否则「只读档禁网」会被一句 curl 绕过去 (和 2026-10-14 那次
// "DANGEROUS_TOOLS 里有 'rm' 但盘古没有名为 rm 的工具" 是同款漏洞)。
const NETWORK_BINARIES = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'ssh', 'sftp', 'scp',
  'ftp', 'dig', 'nslookup', 'host', 'ping', 'aria2c',
]);

// 一定要写文件的参数名 (判 allowWritePaths 白名单用)。
const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'file', 'target', 'dest'];

function _isMcpTool(name) {
  return typeof name === 'string' && name.startsWith('mcp__');
}

function _commandTouchesNetwork(cmd) {
  const bare = String(cmd == null ? '' : cmd).replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
  if (/(^|[\s;&|])(curl|wget|aria2c|nc|ncat|netcat|telnet|ssh|sftp|scp|ftp|dig|nslookup|host|ping)\b/.test(bare)) {
    return true;
  }
  return false;
}

/**
 * 把一次工具调用归类成一种"动作"。
 * @returns {'write'|'network'|'exec'|'other'}
 */
function classifyAction(toolName, args) {
  const t = String(toolName || '').trim();
  if (!t) return 'other';
  try {
    if (t === 'exec_command') {
      const cmd = ap._extractCommand(args);
      const v = ap.classifyCommand(cmd);
      if (v.mutating) return 'write';
      return _commandTouchesNetwork(cmd) ? 'network' : 'other';
    }
    // 任意代码执行 = 任意写权限 (跟 action_policy 同一个判断: 解释器一行代码就能 open(...,'w'))
    if (t === 'code_execute' || t === 'batch_execute') return 'write';
    if (_isMcpTool(t)) {
      let mutating = true;
      try { mutating = require('./mcp_tool_exec').isMcpMutatingTool(t); }
      catch (_) { mutating = true; }   // 判定自身出错 ⇒ 按"会改状态"处理 (fail-closed)
      if (mutating) return 'write';
      return NETWORK_TOOLS.has(t) ? 'network' : 'other';
    }
    if (WRITE_TOOLS.has(t)) return 'write';
    if (NETWORK_TOOLS.has(t)) return 'network';
    return 'other';
  } catch (_) {
    // 分类自身出错 ⇒ 当成写 (最严的一档)。这是安全边界, 不能默认放行。
    return 'write';
  }
}

function _targetPath(args) {
  if (!args || typeof args !== 'object') return '';
  for (const k of PATH_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function _expandUser(p) {
  const os = require('os');
  const path = require('path');
  if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  const m = p.match(/^~([^/]+)\/(.*)$/);
  if (m) {
    try { return path.join(os.userInfo(m[1]).homedir, m[2]); } catch (_) { return p; }
  }
  return p;
}

function _pathAllowed(targetPath, allowWritePaths) {
  const path = require('path');
  const resolved = path.resolve(_expandUser(targetPath));
  return allowWritePaths.some(p => resolved.startsWith(path.resolve(_expandUser(p))));
}

/**
 * 主入口: 这次工具调用在当前档位下准不准。
 *
 * @param {string} toolName
 * @param {object} args
 * @param {{sessionId?: string, agentLevel?: string}} ctx
 * @returns {{allowed: boolean, reason?: string, action?: string, level?: string}}
 */
function checkToolPermission(toolName, args, ctx = {}) {
  let level, rules;
  try {
    const perm = require('./permission');
    level = perm.resolveEffectiveLevel(ctx && ctx.sessionId, ctx && ctx.agentLevel);
    rules = perm.PERMISSION_LEVELS[level] || perm.PERMISSION_LEVELS.default;
  } catch (e) {
    // 档位都读不出来 ⇒ 没法判断"准不准" ⇒ 放行, 但必须留一句日志。
    // (这里选放行而不是拒绝: 拒绝会让整个盘古的工具全瘫, 那是更大的事故;
    //  真正的安全底线在 action_policy / sandbox / permission 三道闸上。)
    console.warn('[permission_guard] 档位读取失败, 本次调用放行: ' + String((e && e.message) || e));
    return { allowed: true, action: 'unknown', level: 'unknown' };
  }

  // 完全访问 = 不受限制 (审计与危险 op 限速照旧走 permission 那套)。
  if (rules.bypass) return { allowed: true, action: 'bypass', level };

  const action = classifyAction(toolName, args);

  if (action === 'write') {
    if (!rules.allowWrite) {
      return {
        allowed: false, action, level,
        reason: '当前权限档位是「只读」, 不许写盘 (' + toolName + ')。要写请让主人在「系统设置 · 权限」里切档。',
      };
    }
    // 规划档: 写只准落在白名单路径 (tmp / Downloads)。
    if (!rules.allowWritePaths.includes('*')) {
      const target = _targetPath(args);
      if (target && !_pathAllowed(target, rules.allowWritePaths)) {
        return {
          allowed: false, action, level,
          reason: '当前权限档位只许写 ' + rules.allowWritePaths.join(' / ') + ', 目标路径不在白名单: ' + target,
        };
      }
    }
    return { allowed: true, action, level };
  }

  if (action === 'network') {
    if (!rules.allowNetwork) {
      return {
        allowed: false, action, level,
        reason: '当前权限档位禁网 (' + toolName + ')。要联网请让主人在「系统设置 · 权限」里切档。',
      };
    }
    return { allowed: true, action, level };
  }

  return { allowed: true, action, level };
}

module.exports = {
  checkToolPermission, classifyAction,
  WRITE_TOOLS, NETWORK_TOOLS, PATH_KEYS,
};

