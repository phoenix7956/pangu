// modules/action_policy.js — 按**动作**裁权限, 不是按工具名 (2026-10-14)
//
// 为什么有这个模块:
// 子 agent 的权限一直是"按角色配工具名"裁的, 于是有两个洞:
//   ① 角色是只读的 (analyzer 名义上"只分析不执行"), 但它手上有 exec_command。
//      prompt 里写着"只许只读命令", 那是一句**注释**, 不是隔离 —— 模型不听话
//      或者被诱导时, `rm -rf` 和 `ls -la` 在权限层是同一个工具。
//   ② shouldAsk() 只看 tool name。DANGEROUS_TOOLS 里有 'rm', 但盘古没有名为
//      'rm' 的工具 —— 命令都包在 exec_command 里。于是这层拦截**从来没生效过**。
//
// 对应 AGENTS.md 铁律 1: "注释 ≠ 隔离"。只读角色必须在**执行层**被挡住,
// 而不是靠 prompt 求模型自觉。
//
// 与 sandbox / permission 的分工 (三者不重叠):
//   sandbox     — 全局开关, 管路径白名单 + 14 种致命模式。老板 8/1 拍默认关。
//   permission  — 按档位决定"要不要弹审批", 但同样只看工具名。
//   action_policy— 按**角色职能**划不可逾越的边界。只读角色越界 = 直接拒,
//                 不弹审批、不看档位、不受全局 sandbox 开关影响。
//                 因为老板关掉全局 sandbox 是信任主循环, 不是授权将灵删文件。
'use strict';

// ===== 角色职能: 只读 vs 可写 =====
// 坎(qian/kan) 没有工具, 不在此表。艮要写记忆, 坤要写盘。
//
// 2026-10-18: 这份名单以前在本文件**重新手写一遍**, 而身份真源在 agents/gua-identity.js。
// 两份名单迟早漂 —— 而这份是安全边界, 漂了的后果是**静默放行**: 只读角色拿到写工具,
// 不报错、不留痕, "只验不修"当场失效。现在名单和判定都走真源。
//
// ⚠️ 角色名**必须先归一**再查这张表。这里收的有从 prompt 传进来的卦名/拼音,
// 写成 READ_ONLY_CODES.has(role) 的话卦名恒不相等 = 整道闸门静默失效,
// 且**没有一行日志会提示**。判定统一走 isReadOnlyRole。
const {isReadOnlyRole, READ_ONLY_CODES} = require('../agents/gua-identity');

// 一律改变本地或远程状态的工具。只读角色拿到这些直接拒。
const MUTATING_TOOLS = new Set([
  'write_file', 'file_edit', 'code_execute', 'batch_execute', 'run_installer',
  'memory_write', 'cache_put', 'cache_preheat', 'cache_evict',
  'archive_create', 'archive_extract', 'send_wechat', 'clipboard_write',
  'computer_use_click', 'computer_use_type', 'computer_use_key', 'computer_use_drag',
  'computer_use_vision_act', 'permission_grant', 'permission_apply',
  'set_env_path', 'sleep_timer',
]);

// 一定会改状态的命令。
const MUTATING_BINARIES = new Set([
  'rm', 'rmdir', 'unlink', 'mv', 'cp', 'mkdir', 'touch', 'install', 'rsync',
  'dd', 'mkfs', 'chmod', 'chown', 'chgrp', 'ln', 'truncate', 'shred',
  'kill', 'pkill', 'killall', 'shutdown', 'reboot', 'halt', 'poweroff',
  'launchctl', 'systemctl', 'service', 'crontab', 'at', 'defaults',
  'npm', 'yarn', 'pnpm', 'pip', 'pip3', 'brew', 'gem', 'cargo', 'go', 'apt',
  'apt-get', 'yum', 'dnf', 'port', 'docker', 'kubectl', 'git',
]);

// 这些 git 子命令只读 (git status/log/diff/show 是查询, 不是改动)。
const GIT_READONLY_SUBS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'config', 'blame',
  'describe', 'rev-parse', 'ls-files', 'shortlog', 'tag', 'stash',
]);

// 包管理器和 go 里**只读**的子命令。
const PM_READONLY_SUBS = {
  // 不含 'run'/'exec'/'dlx': 那三个会执行任意脚本, 在 classify 里单独前置判定。
  npm: new Set(['ls', 'list', 'view', 'info', 'outdated', 'audit', 'search', 'root', 'bin', 'help']),
  yarn: new Set(['list', 'info', 'why', 'outdated']),
  pnpm: new Set(['list', 'ls', 'outdated', 'why', 'store']),
  pip: new Set(['list', 'show', 'freeze', 'check']),
  pip3: new Set(['list', 'show', 'freeze', 'check']),
  brew: new Set(['list', 'info', 'search', 'deps', 'config', 'outdated']),
  gem: new Set(['list', 'info', 'search', 'dependency', 'env']),
  cargo: new Set(['tree', 'search', 'metadata', 'locate-project']),
  go: new Set(['list', 'version', 'env', 'doc', 'vet']),
};

// 任意代码执行 = 任意写权限。`python -c "print(1)"` 和 `python -c "open('/etc/x','w')"`
// 在权限层无法区分, 所以一律当写。只读角色要算数请用专用工具。
const ARBITRARY_CODE = /(^|[\s;&|])(python3?|node|perl|ruby|php|sh|bash|zsh)\s+(-[a-zA-Z]*\s+)*(-c|-e)\b/;

function _stripQuotes(s) {
  // 只为"找元字符"服务: 引号里的内容换成同长度空格, 保留下标, 不影响其它判断。
  return String(s == null ? '' : s)
    .replace(/'[^']*'/g, (m) => ' '.repeat(m.length))
    .replace(/"[^"]*"/g, (m) => ' '.repeat(m.length));
}

function _segments(cmd) {
  return _stripQuotes(cmd).split(/[\n;|&]+/).map(s => s.trim()).filter(Boolean);
}

function _firstWord(seg) {
  const m = seg.match(/^[A-Za-z0-9_./~-]+/);
  return m ? m[0] : '';
}

function _subCommand(seg, bin) {
  const rest = seg.slice(seg.indexOf(bin) + bin.length).trim();
  const m = rest.match(/^([A-Za-z][A-Za-z0-9:_-]*)/);
  return m ? m[1] : '';
}

/**
 * 判断一条 shell 命令到底改不改变状态。
 * @returns {{mutating: boolean, reason: string}}
 */
function classifyCommand(cmd) {
  const raw = String(cmd == null ? '' : cmd).trim();
  if (!raw) return { mutating: false, reason: 'empty' };
  const bare = _stripQuotes(raw);

  // 1) 输出重定向 / tee —— 写文件的最常见形态。
  //    `grep ">" f` 里引号已被抹成空格, 所以不会误判。
  if (/(^|[^0-9<>])>{1,2}(?!&)/.test(bare) || /&>/.test(bare) || /\|\s*tee\b/.test(bare)) {
    return { mutating: true, reason: 'output redirect / tee 会写文件' };
  }
  // 2) 原地编辑
  if (/\b(sed|perl|ruby)\b[^|;&]*\s-i\b/.test(bare)) {
    return { mutating: true, reason: '原地编辑 (-i) 会改文件' };
  }
  // 3) 任意代码
  if (ARBITRARY_CODE.test(bare)) {
    return { mutating: true, reason: '内联解释器代码 = 任意写权限' };
  }
  // 4) 逐段看首个命令
  for (const seg of _segments(raw)) {
    const bin0 = _firstWord(seg);
    if (!bin0) continue;
    const bin = bin0.split('/').pop();
    if (!MUTATING_BINARIES.has(bin)) continue;
    if (bin === 'git') {
      const sub = _subCommand(seg, bin0);
      if (GIT_READONLY_SUBS.has(sub)) continue;
      return { mutating: true, reason: 'git ' + (sub || '<sub>') + ' 会改仓库' };
    }
    // npm run <script> 会执行任意脚本 = 任意写权限。必须排在下面的只读判定**之前**,
    // 否则 'run' 在 PM_READONLY_SUBS.npm 里, 会先被 continue 掉, 这条检查成了死代码。
    if (bin === 'npm' || bin === 'yarn' || bin === 'pnpm') {
      const sub = _subCommand(seg, bin0);
      if (sub === 'run' || sub === 'exec' || sub === 'dlx') {
        return { mutating: true, reason: bin + ' ' + sub + ' 会执行任意脚本' };
      }
    }
    const pm = PM_READONLY_SUBS[bin];
    if (pm) {
      const sub = _subCommand(seg, bin0);
      if (!sub || pm.has(sub)) continue;
      return { mutating: true, reason: bin + ' ' + sub + ' 会安装/改动依赖' };
    }
    return { mutating: true, reason: bin + ' 会改变系统或文件状态' };
  }
  // 5) curl 写远端
  if (/(^|\s)curl\b/.test(bare) && /(-X\s*(POST|PUT|PATCH|DELETE)|--data\b|-d\s|upload-file|--form\b|-F\s)/.test(bare)) {
    return { mutating: true, reason: 'curl 写方法/带 body, 会改远端状态' };
  }
  return { mutating: false, reason: 'read-only' };
}

function _extractCommand(args) {
  if (!args || typeof args !== 'object') return '';
  for (const k of ['command', 'cmd', 'script', 'shell', 'commandLine']) {
    if (typeof args[k] === 'string' && args[k].trim()) return args[k];
  }
  return '';
}

/**
 * 只读角色越界检查。
 * @returns {{ok: boolean, code?: string, reason?: string}}
 */
function checkRoleAction(role, toolName, args) {
  // 失败必须**关闭**而不是打开。这是一道安全边界, 内部出错时若返回 ok:true,
  // 等于把"注释 ≠ 隔离"这个坑又挖一遍 —— 只是这次藏得更深, 连日志都不会有。
  try {
    const r = String(role || '').trim();
    if (!isReadOnlyRole(r)) return { ok: true };
    const t = String(toolName || '').trim();
    if (MUTATING_TOOLS.has(t)) {
      return {
        ok: false, code: 'ROLE_READ_ONLY',
        reason: r + ' 是只读角色, 不许调 ' + t + ' (需要写请派 kun 坤)',
      };
    }
    // 2026-10-24 (第 79 批): **MCP 工具也要过只读边界**。
    // 内部工具这边有 MUTATING_TOOLS 拦着, MCP 这边以前**一道闸都没有** ——
    // 而 MCP 工具不在任何角色的白名单里 (白名单只管内部工具),
    // 于是只读角色 (analyzer/checker/...) 一句 `mcp__filesystem-mcp__write_file`
    // 就能写盘, "只读"这个承诺当场破掉, 而且**没有任何日志会提示**。
    // 判据在 mcp_tool_exec (名单外的叶子一律按"会改状态"处理, fail-closed)。
    if (t.startsWith('mcp__')) {
      let _mutating = true;
      try { _mutating = require('./mcp_tool_exec').isMcpMutatingTool(t); }
      catch (_) { _mutating = true; }   // 判定自身出错 => 按拒绝处理
      if (_mutating) {
        return {
          ok: false, code: 'ROLE_READ_ONLY',
          reason: r + ' 是只读角色, 不许调会改状态的 ' + t + ' (需要写请派 kun 坤)',
        };
      }
    }
    if (t === 'exec_command') {
      const v = classifyCommand(_extractCommand(args));
      if (v.mutating) {
        return {
          ok: false, code: 'ROLE_READ_ONLY',
          reason: r + ' 是只读角色, 命令会改状态: ' + v.reason + ' (需要写请派 kun 坤)',
        };
      }
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false, code: 'ROLE_READ_ONLY',
      reason: '权限判定自身出错, 按拒绝处理 (fail-closed): ' + String((e && e.message) || e),
    };
  }
}

module.exports = {
  READ_ONLY_CODES, MUTATING_TOOLS, MUTATING_BINARIES,
  classifyCommand, checkRoleAction, _extractCommand,
};

// ===== 危险 (破坏性) 判定 ——
//
// 和 classifyCommand 的区别很要紧:
//   classifyCommand  回答"改不改状态" → 用来卡只读角色 (mkdir 也要拦)
//   classifyDanger   回答"会不会毁东西" → 用来决定要不要弹审批 (mkdir 不用问)
//
// 两者不能混。只读角色要严, 主循环要准: 主循环是老板直接指挥的, 写文件建目录
// 都该放行; 但 rm -rf / 覆盖系统文件必须问 —— 以前问不了, 因为
// permission.shouldAsk 只按 tool name 判, 盘古没有名为 'rm' 的工具。
const DESTRUCTIVE_BINARIES = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'truncate', 'dd', 'mkfs', 'mkswap',
  'chmod', 'chown', 'chgrp', 'ln', 'kill', 'pkill', 'killall',
  'shutdown', 'reboot', 'halt', 'poweroff', 'launchctl', 'systemctl',
  'crontab', 'at', 'visudo', 'diskutil',
]);
const DESTRUCTIVE_SUBS = {
  docker: new Set(['rm', 'rmi', 'system', 'volume', 'prune', 'compose']),
  kubectl: new Set(['delete', 'drain', 'cordon', 'taint']),
  git: new Set(['push', 'reset', 'clean', 'filter-branch']),
  defaults: new Set(['write', 'delete']),
  brew: new Set(['uninstall', 'remove']),
  npm: new Set(['uninstall', 'rm', 'prune']),
};
// 重定向进系统目录 / 下载即执行 / fork 炸弹
const DESTRUCTIVE_PATTERNS = [
  { re: />\s*\/etc\//, why: '重定向覆盖 /etc' },
  { re: />\s*\/(usr|bin|sbin|boot|var)\//, why: '重定向覆盖系统目录' },
  { re: /\bcurl\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python)/, why: '下载即执行 (curl | sh)' },
  { re: /:\(\)\s*\{.*\}\s*;?\s*:/, why: 'fork 炸弹' },
  { re: /\bmkfs(\.\w+)?\b/, why: '格式化文件系统' },
  { re: /\bdd\b[^|;]*\bof=\/dev\//, why: 'dd 写裸设备' },
];

/**
 * 判断一条命令是否**破坏性** (会毁东西 / 不可逆)。
 * @returns {{dangerous: boolean, binary: string|null, reason: string}}
 */
function classifyDanger(cmd) {
  const raw = String(cmd == null ? '' : cmd).trim();
  if (!raw) return { dangerous: false, binary: null, reason: 'empty' };
  const bare = _stripQuotes(raw);

  for (const p of DESTRUCTIVE_PATTERNS) {
    if (p.re.test(bare)) return { dangerous: true, binary: null, reason: p.why };
  }
  for (const seg of _segments(raw)) {
    const bin0 = _firstWord(seg);
    if (!bin0) continue;
    const bin = bin0.split('/').pop();
    if (DESTRUCTIVE_BINARIES.has(bin)) {
      return { dangerous: true, binary: bin, reason: bin + ' 是破坏性命令' };
    }
    const subs = DESTRUCTIVE_SUBS[bin];
    if (subs) {
      const sub = _subCommand(seg, bin0);
      if (sub && subs.has(sub)) {
        return { dangerous: true, binary: bin, reason: bin + ' ' + sub + ' 会毁东西' };
      }
    }
  }
  return { dangerous: false, binary: null, reason: 'safe' };
}

module.exports.DESTRUCTIVE_BINARIES = DESTRUCTIVE_BINARIES;
module.exports.classifyDanger = classifyDanger;
