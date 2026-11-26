/**
 * Pangu · Modules · Sandbox
 * sandbox.js - 工具调用安全边界
 *
 * 加:盘古 2.0 全面工作操作电脑
 * 边界控制 = 不让 LLM "无限制" 操作老板 Pangu 系统
 *
 * 设计原则:
 * 1. 工具白名单(MVP 8 个 + 24 个卦象业务 = 32 个)
 * 2. 危险命令拦截(rm -rf /, sudo, mkfs, dd if=, ...)
 * 3. 路径白名单(默认 ~/.pangu/workspace, ~/Documents, ~/Applications, /tmp)
 * 4. 危险分级(观/行/革) → 革操作需要 Pangu UI 二次确认(由 Pangu 后端 audit log 触发)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

// ============================================================
// 工具白名单
// ============================================================
const ALLOWED_TOOLS = new Set([
  // 2026-08-02 自我迭代 (老板拍: 盘古必须能自我修改代码、自我迭代 — 验证+快照+重启+回滚全自动)
  'self_iterate',
  // 2026-08-02 平面图出图 (老板拍: 盘古为啥不出图 — 确定性工具, 只写 out_dir, 天然安全)
  'draw_layout',
  // MVP 8 核心
  'read_file', 'write_file', 'file_edit', 'list_directory',
  'file_grep', 'file_find', 'exec_command', 'code_execute',
  'web_search', 'web_fetch', 'network_check',
  'memory_write', 'memory_search', 'session_recall', 'current_time',
  // 24 卦象业务工具
  'situation_check', 'initial_assessment', 'caution_signal', 'wait_action',
  'signal_detection', 'trend_judgment', 'opportunity_check', 'first_step',
  'patience_manager', 'dilemma_resolution', 'stakeholder_check', 'steady_action',
  'critical_point_analysis', 'breakthrough_check', 'direction_decision', 'risk_assessment',
  'momentum_assessment', 'main_force_analysis', 'peak_judgment', 'full_deployment',
  'peak_detection', 'reversal_signal', 'withdrawal_plan', 'graceful_exit',
 // P0-3 OS 工具 — LAN/PATH/Installer
  'get_lan_ip', 'set_env_path', 'run_installer',
    // TTS
  'tts_speak', 'tts_voices',
 // 行情工具 — A股实时 + K 线(东方财富 free API)
  'stock_quote', 'stock_history',
 // Pangu skill 整理 — 扩白名单(LLM 能调剩余 27 个 tool)
  'permission_check', 'permission_grant',
  'resource_pool',
  'cache_get', 'cache_put', 'cache_preheat', 'cache_evict', 'cache_stats',
  'clipboard_read', 'clipboard_write',
  'currency_check', 'crypto_price',
  'github_api', 'send_wechat',
  'http_check', 'news_digest', 'weather_check',
  'process_list', 'system_info', 'screenshot',
  'search_files', 'sleep_timer', 'translate_text',
  'archive_create', 'archive_extract',
  'batch_execute', 'team_dispatch',
 // 借鉴 #3 (TaskOutputTool) — 异步后台任务查询
  'task_output',
 // C+D-adapter: computer_use 工具组
  'computer_use_click', 'computer_use_type', 'computer_use_key', 'computer_use_drag',
  'computer_use_vision_act',
 // 八字排盘 (sxtwl 真实万年历, 不让 LLM 脑补日柱)
  'bazi_calc',
 // macOS 权限自申请 + 拍照 + 录音 — 让盘古自己走通 "申请 → 老板点 TCC → 执行"
 // 加白名单后不再弹 sandbox 框, 只弹 macOS TCC 框 (老板只需点一次系统允许)
  'take_photo', 'record_audio', 'permission_apply',
 // #9 逐个验 GUI: tools_selftest 调用其他工具看能不能跑 (不修改任何文件)
  'tools_selftest',

    // P1 — 加 safe 工具 (read-only/info/计算)
  'memory_read',
  'list_pangu_agents',
 // todo/task — 任务管理 (LLM 写 todo, 标记完成)
  'todo_write', 'task_done',
  // P0-#14: Git Ops (4 个) — 让 Pangu 自闭环改自己
  'git_commit', 'git_branch', 'git_diff', 'git_status',
  // P0-#33: Checkpoint / Rollback (3 个) — 让 Pangu 改坏能回滚
  'checkpoint_create', 'checkpoint_list', 'checkpoint_rollback',
  // P0-#34: Session 恢复 (4 个) — 断线续接
  'session_save', 'session_load', 'session_list', 'session_delete',
  // P0-#7: Self-correct (1 个) — Pangu 自检 tool 输出
  'self_correct',
  // P0-#36: Metrics (2 个) — token 计数 + dashboard
  'metrics_query', 'metrics_dashboard',
  // P0-#18 (P0-10 LSP 整合): symbol search
  'symbol_search',
  // P0-#16 (P0-10 LSP 整合): syntax highlighting
  'syntax_highlight',
  // P0-#17 (P0-10 LSP 整合): LSP definition/references
  'lsp_definition', 'lsp_references',
]);

// ============================================================
// 危险命令拦截(行命 / exec_command 时强制检查)
// ============================================================
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?-?[a-zA-Z]*r[a-zA-Z]*\s+\//,  // rm -rf /
  /\brm\s+-[a-zA-Z]*\s+\/($|\s)/,                                  // rm -f /
  /\bsudo\b/,                                                       // sudo
  /\bmkfs\b/,                                                        // mkfs
  /\bdd\s+if=/,                                                     // dd if=
  /\bcurl\s+[^|]*\|\s*(sh|bash)/,                                   // curl | sh
  /\bwget\s+[^|]*\|\s*(sh|bash)/,                                   // wget | sh
  /\bchmod\s+-R\s+777\s+\//,                                       // chmod -R 777 /
  /\bchown\s+-R\s+/,                                                // chown -R /
  />\s*\/dev\/sd[a-z]/,                                            // > /dev/sda
  /\bshutdown\b/,                                                   // shutdown
  /\breboot\b/,                                                     // reboot
  /\bkill\s+-9\s+1\b/,                                              // kill -9 1
  /\b:\(\)\s*{\s*:\|:&\s*\};\s*:/,                                 // fork bomb
  /\beval\b/,                                                       // R30 修 (老板 7/25 20:04 拍 A): 对齐 tools/index.js:673 用 /\beval\b/, 漏 eval$(...) 等嵌入形式
  /\bnew\s+Function\s*\(/,                                          // M6 fix: new Function('code') 等价 eval
  /(?<![\w$])Function\s*\(\s*['"`]/,                                // M6 fix: Function('code') 直接调用构造器
  /\\u0065\\u0076\\u0061\\u006c/i,                                  // M6 fix: 'eval' 的 unicode 转义变形
  /\bsource\s+~\/\.bashrc\s*;.*\brm\b/,                           // 注入
];

// 加载外部 deny list (§0.7 + ClaudeCode)
const _extraDeny = [];
try {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const denyFile = path.join(os.homedir(), '.pangu', 'config', 'bash_denylist.txt');
  if (fs.existsSync(denyFile)) {
    const lines = fs.readFileSync(denyFile, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      try { _extraDeny.push(new RegExp(trimmed)); } catch (_) {}
    }
  }
} catch (_) {}
if (_extraDeny.length > 0) DANGEROUS_PATTERNS.push(..._extraDeny);

// §0.13 + §0.20 加白名单 (第 2 阶段): 低风险命令不再拦
const ALLOWED_LOW_RISK_COMMANDS = [
  /^ls(\s|$|\s-[a-zA-Z]+)/,
  /^cat\s+/,
  /^echo\s+/,
  /^pwd\s*$/,
  /^uname(\s|$|\s-[a-zA-Z]+)/,
  /^id(\s|$|\s-[a-zA-Z]+)/,
  /^whoami\s*$/,
  /^hostname(\s|$|\s-[a-zA-Z]+)/,
  /^date(\s|$|\s-[a-zA-Z]+|\s\+)/,
  /^df(\s|$|\s-[a-zA-Z]+)/,
  /^du(\s|$|\s-[a-zA-Z]+)/,
  /^wc(\s|$|\s-[a-zA-Z]+)/,
  /^head(\s|$|\s-[a-zA-Z]+)/,
  /^tail(\s|$|\s-[a-zA-Z]+)/,
  /^grep(\s|$|\s-[a-zA-Z]+)/,
  /^find(\s|$|\s-[a-zA-Z]+)/,
  /^which(\s|$|\s-[a-zA-Z]+)/,
  /^env(\s|$|\s-[a-zA-Z]+)/,
];

function isLowRiskCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  for (const p of ALLOWED_LOW_RISK_COMMANDS) {
    if (p.test(cmd)) return true;
  }
  return false;
}

// #11: 加 Python 危险操作黑名单 — exec_command 只查 shell pattern, 不查 Python 子进程
const PYTHON_DANGEROUS_PATTERNS = [
  /os\.system\s*\(/,
  /subprocess\.(call|run|Popen|check_output)\s*\(/,
  /shutil\.rmtree\s*\(/,
  /os\.remove\s*\(/,
  /os\.unlink\s*\(/,
  /__import__\s*\(\s*['"]os['"]\s*\)/,
];

function isPythonDangerous(code) {
  if (typeof code !== 'string') return false;
  for (const p of PYTHON_DANGEROUS_PATTERNS) {
    if (p.test(code)) return true;
  }
  return false;
}

// #11: 把 isPythonDangerous 挂到 isDangerousCommand 上
function isDangerousCommand(cmd) {
  if (typeof cmd !== 'string') return true;
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) return true;
  }
  if (isPythonDangerous(cmd)) return true;
  return false;
}

// ============================================================
// 路径白名单
// L3: 外部 platform workspace 已彻底移除 (双向隔离). 不再加
// "sandbox 这个问题，要彻底解决" — 加全路径白名单
// ============================================================
// §0.13 + §0.20 + “慢慢可以自己干活”: 第 2 阶段加白名单
// ALLOWED_PATHS 已包含常见路径, 此处不再加(含主目录就能 startsWith 匹配子路径)
const ALLOWED_PATHS = [
  process.env.HOME + '/.pangu',  // R80 修 (R80 BUG #8 LLM 没法写规则): ~/.pangu 父路径已覆盖子目录
                                  //   - ~/.pangu/memory/  LLM 写持久记忆 (memory_write 后端路径)
                                  //   - ~/.pangu/rules/   LLM 写跨 session 规则 (R18 自我迭代持久化)
                                  //   - ~/.pangu/MEMORY.md LLM 更新元守则
                                  //   - ~/.pangu/evolution/ LLM 写进化日志 (j2_agent_loop 写)
                                  //   - ~/.pangu/checkpoints/ checkpoint_create 落点
                                  // LLM 不要因为"路径不在白名单"被拒而绕到 ~/Desktop — 这就是 R80 BUG
                                  // L3: 历史注释 — 已彻底移除外部 platform workspace (双向隔离确立)
                                  // memory 自我保护边界由 memory 模块自身定义
  process.env.HOME + '/Documents',
  path.join(os.homedir(), 'Desktop'),                // H4: 适配任意用户
  path.join(os.homedir(), '.pangu-skills'),
  // H4: 用 os.homedir() 替代硬编码 Applications
  '/tmp',
  '/var/folders',  // macOS temp
  process.cwd(),
];

function isPathAllowed(targetPath) {
  if (typeof targetPath !== 'string') return false;
  // 2026-07-27 P1 修 (Bug #5): path.resolve 不展开 ~, ~/.pangu/mcp.json 会被解析成 cwd/~/.pangu/...
  // 直接走白名单外的 cwd 路径, 然后被拒, LLM 看到 "路径不在白名单" 不知改啥
  // 解: 入口先 expand ~ 和 ~user 形式 (bash 行为)
  let _expanded = targetPath;
  if (_expanded === '~' || _expanded.startsWith('~/') || _expanded.startsWith('~\\')) {
    _expanded = os.homedir() + _expanded.slice(1);
  } else {
    const _tildeUser = _expanded.match(/^~([^/\\]+)/);
    if (_tildeUser) _expanded = os.homedir() + _expanded.slice(_tildeUser[0].length);  // 简化: ~user 也走 HOME (本机单用户)
  }
 // #15: 防 symlink 攻击 — realpath 会解析所有 symlink
  // 但反向攻击仍可能: 在允许目录里创建 symlink 指向外部
  // 缓解: 同时检查 resolved 和 realpath, 两者都必须在白名单
  // R29 修 (老板 7/25 19:59 拍 '你直接修'): dangling symlink 上 realpathSync 抛错
  // 旧代码 fallback 到 resolved → 任何 ~/Desktop 下的 symlink 都能写任意路径
  // 解: realpathSync 抛错时返 false (不 fallback)
  const resolved = path.resolve(_expanded);
  let real;
  try { real = fs.realpathSync(_expanded); }
  catch (e) {
    // R29 原修过头了: realpathSync 对不存在的文件也抛 ENOENT → 新建文件全被拦
    // 区分: lstat 成功但 realpath 失败 = dangling symlink → 拒;
    //       lstat 也 ENOENT = 新文件 → 向上找最近存在的父目录 realpath 后再拼回去
    if (!e || e.code !== 'ENOENT') return false;
    try { fs.lstatSync(_expanded); return false; }  // dangling symlink → 拒
    catch (e2) {
      if (!e2 || e2.code !== 'ENOENT') return false;
      let dir = path.dirname(resolved);
      const rel = [path.basename(resolved)];
      while (true) {
        try { real = path.join(fs.realpathSync(dir), ...rel); break; }
        catch (e3) {
          if (e3 && e3.code === 'ENOENT') {
            rel.unshift(path.basename(dir));
            const parent = path.dirname(dir);
            if (parent === dir) return false;  // 到根了还不存在, 放弃
            dir = parent;
          } else { return false; }
        }
      }
    }
  }
  // 2026-07-27 P1 修: 白名单也走 realpath, 处理 ~/.pangu -> ~/pangu 这种 symlink
  // 老板 ~/.pangu 是 symlink, realpathSync 后 = ~/pangu, 不在 ALLOWED_PATHS 字面里 → 拒
  // 解: 算每条白名单的 realpath 缓存 (单次扫描), resolved/real 跟字面或 realpath 都能匹配
  const _allowedResolved = ALLOWED_PATHS.map(p => {
    try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); }
  });
  return ALLOWED_PATHS.some((allowed, i) => {
    const a = path.resolve(allowed);
    const aReal = _allowedResolved[i];
    return (resolved === a || resolved.startsWith(a + path.sep) ||
            resolved === aReal || resolved.startsWith(aReal + path.sep)) &&
           (real === a || real.startsWith(a + path.sep) ||
            real === aReal || real.startsWith(aReal + path.sep));
  });
}

// P0-#14: 检查文件路径是否在 Pangu repo 内 (~/pangu/)
// H4: PANGU_REPO 优先, fallback ~/pangu
const PANGU_REPO_ROOT = process.env.PANGU_REPO
  ? path.resolve(process.env.PANGU_REPO)
  : path.resolve(os.homedir(), 'pangu');
function isInsidePanguRepo(targetPath) {
  if (typeof targetPath !== 'string') return false;
  try {
    const resolved = path.resolve(targetPath);
    const root = path.resolve(PANGU_REPO_ROOT);
    return resolved === root || resolved.startsWith(root + path.sep);
  } catch (_) {
    return false;
  }
}

// ============================================================
// 危险分级(观 / 行 / 革)
// ============================================================
// 谋 = 规划布局(自动允许 + audit log)
// 断 = 决断判断(自动允许 + audit log)
// 观 = 只读操作(自动允许)
// 行 = 写本地非关键文件(自动允许 + audit log)
// 革 = 删/改关键文件/跑命令(自动 audit log + 建议 UI 二次确认,留接口给 Pangu UI)
// W4-I: 老板钦定“盘古的根本(谋/断)不能变”,TOOL_TIER 改为谋/断/观/行/革 五级
const TOOL_TIER = {
  // 谋 — 规划布局(谋断式 AI agent 的谋, Pangu 根本 1)
  first_step: '谋', opportunity_check: '谋', dilemma_resolution: '谋',
  stakeholder_check: '谋', breakthrough_check: '谋', main_force_analysis: '谋',
  full_deployment: '谋', wait_action: '谋', withdrawal_plan: '谋',
  graceful_exit: '谋', steady_action: '谋', team_dispatch: '谋',
  // 断 — 决断判断(谋断式 AI agent 的断, Pangu 根本 2)
  direction_decision: '断', situation_check: '断', initial_assessment: '断',
  caution_signal: '断', signal_detection: '断', trend_judgment: '断',
  risk_assessment: '断', critical_point_analysis: '断', momentum_assessment: '断',
  peak_judgment: '断', peak_detection: '断', reversal_signal: '断', patience_manager: '断',
  // 观 — 只读观察
  read_file: '观', list_directory: '观', file_grep: '观', file_find: '观',
  web_search: '观', web_fetch: '观', current_time: '观', network_check: '观',
  // W4-J: 历史别名 + 未分类新 skill — 只读
  weather_check: '观', news_digest: '观', translate_text: '观',
  github_api: '观', currency_check: '观', crypto_price: '观',
  http_check: '观', system_info: '观', process_list: '观',
  clipboard_read: '观', permission_check: '观', resource_pool: '观',
  cache_get: '观', cache_stats: '观',
  // 行 — 写本地非关键
  write_file: '行', file_edit: '行', code_execute: '行',
  memory_write: '行', memory_search: '行',
 // 借鉴 #3: 异步后台任务的 task_output 是"读后台状态" (观), 不改文件
  task_output: '观',
  // W4-J: 历史别名 + 未分类新 skill — 写本地
  send_wechat: '行', clipboard_write: '行',
  archive_create: '行', archive_extract: '行', sleep_timer: '行',
  screenshot: '行', cache_put: '行', cache_preheat: '行', cache_evict: '行',
 // C+D-adapter: computer_use 工具组 — 行(会操作屏幕/键盘)
  computer_use_click: '行', computer_use_type: '行', computer_use_key: '行',
  computer_use_drag: '行', computer_use_vision_act: '行',
  batch_execute: '行', permission_grant: '行',
 // bazi_calc — 观(只读万年历)
  bazi_calc: '观',
  // 革 — 删/改关键/跑命令(UI 二次确认)
  exec_command: '革',
};

// 加载外部 timeout_class.json (§0.7 + ClaudeCode 超时分级)
let TIMEOUT_BY_CLASS = { default: 30000 };
try {
  const fs2 = require('fs');
  const path2 = require('path');
  const os2 = require('os');
  const tcFile = path2.join(os2.homedir(), '.pangu', 'config', 'timeout_class.json');
  if (fs2.existsSync(tcFile)) {
    TIMEOUT_BY_CLASS = JSON.parse(fs2.readFileSync(tcFile, 'utf8'));
  }
} catch (_) {}

// ============================================================
// 权限申请机制 
// 工具被拦时 → 返回 needs_approval + reason，不直接拒绝
// 主人审批后 → 临时/永久授权
// ============================================================

// LRU 上限 — 防恶意客户端用大量 taskId 撑爆内存
const MAX_PENDING = 200;
const PENDING_APPROVALS = new Map(); // taskId -> { tool, params, reason, timestamp }

function requestApproval(toolName, params, reason) {
  // 满了先删最老的
  while (PENDING_APPROVALS.size >= MAX_PENDING) {
    const oldestKey = PENDING_APPROVALS.keys().next().value;
    PENDING_APPROVALS.delete(oldestKey);
  }
  // M10: 清掉同 toolName 上次的 grace_retry (旧 status 不应被新调用看到)
  for (const [oldId, oldT] of PENDING_APPROVALS) {
    if (oldT.tool === toolName && oldT.status === 'grace_retry') {
      PENDING_APPROVALS.delete(oldId);
    }
  }
  const taskId = 'approve_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  PENDING_APPROVALS.set(taskId, {
    tool: toolName,
    params: params,
    reason: reason,
    timestamp: Date.now(),
    status: 'pending'
  });
 // §0.13 + §8.11 全套: 30s 超时机制 (LLM 不能无限等)
  // B2 修: 30s 超时改为重试而不是 auto-reject (ClaudeCode 风格: 首次确认后 session 内放行)
  // 超时 = 给 LLM 一个 grace 续 round 机会, 让它尝试不同路径, 而不是直接死掉
  // H5: 用 timer handle + Map 仍存在的双重检查防 race (approve/reject 后 entry 已删, 但 setTimeout 仍可能触发)
  const timer = setTimeout(() => {
    const t = PENDING_APPROVALS.get(taskId);
    if (t && t.status === 'pending') {
      t.status = 'grace_retry';
      console.warn(`[sandbox] task ${taskId} timeout (30s), status=grace_retry (让 LLM 换路径)`);
      // 不删 entry, 让 LLM 看到 grace_retry 时尝试替代方案
    }
  }, 30000);
  if (timer.unref) timer.unref();
  // 记 timer handle, approve/reject 时主动 clear 防泄漏
  const _existingEntry = PENDING_APPROVALS.get(taskId);
  if (_existingEntry) _existingEntry._timer = timer;
  return {
    ok: false,
    needs_approval: true,
    task_id: taskId,
    reason: reason,
    message: `盘古申请权限: ${reason}\n请主人审批 (task_id: ${taskId})\n  超时: 30s 没批 → auto-rejected`
  };
}

function approveTask(taskId, permanent = false) {
  const task = PENDING_APPROVALS.get(taskId);
  if (!task) return { ok: false, error: '审批任务不存在或已过期' };
  task.status = 'approved';
  task.permanent = permanent;
  if (permanent) {
    saveOwnerPreference(task.tool, true);
  }
  // H5: 清 timeout 防 race 后修改 status
  if (task._timer) clearTimeout(task._timer);
 // §0.13 修: 批准后删 entry, 老板点完不会重复显示
  PENDING_APPROVALS.delete(taskId);
  return { ok: true, task: task };
}

function rejectTask(taskId) {
  const task = PENDING_APPROVALS.get(taskId);
  if (!task) return { ok: false, error: '审批任务不存在或已过期' };
  task.status = 'rejected';
  // H5: 清 timeout
  if (task._timer) clearTimeout(task._timer);
 // §0.13 修: 拒绝后删 entry, 不重复显示
  PENDING_APPROVALS.delete(taskId);
  return { ok: true };
}

function saveOwnerPreference(toolName, allowed) {
  try {
    const prefFile = path.join(os.homedir(), '.pangu', 'config', 'owner_preferences.json');
    let prefs = {};
    if (fs.existsSync(prefFile)) {
      prefs = JSON.parse(fs.readFileSync(prefFile, 'utf8'));
    }
    prefs[toolName] = allowed;
    fs.writeFileSync(prefFile, JSON.stringify(prefs, null, 2));
  } catch (_) {}
}

function checkOwnerPreference(toolName) {
  try {
    const prefFile = path.join(os.homedir(), '.pangu', 'config', 'owner_preferences.json');
    if (!fs.existsSync(prefFile)) return null;
    const prefs = JSON.parse(fs.readFileSync(prefFile, 'utf8'));
    return prefs[toolName] || null;
  } catch (_) { return null; }
}

// C1 修: .unref() 让测试/CLI/短期进程能正常退出
const _approvalCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [taskId, task] of PENDING_APPROVALS) {
    if (now - task.timestamp > 5 * 60 * 1000) {
      PENDING_APPROVALS.delete(taskId);
    }
  }
}, 5 * 60 * 1000);
if (_approvalCleanupInterval.unref) _approvalCleanupInterval.unref();

// ============================================================
// 主入口:工具调用前 sandbox 检查 (B1 版)
// ============================================================
function checkToolCall(name, params, opts) {
  // 2026-08-01 老板拍: "沙箱都没有必要, 防御的越狠出事越大" — 默认全放行
  // 实证: cwd 白名单/审批 gate 引爆 self_correct→plan_failed 死锁。PANGU_SANDBOX=on 可拉回
  if (process.env.PANGU_SANDBOX !== 'on') {
    // H5 fix: 默认放行是老板明拍, 但需醒目提示 (每进程只打一次), 避免"以为有沙箱其实没有"
    if (!checkToolCall._warnedOff) {
      checkToolCall._warnedOff = true;
      console.warn('[sandbox] ⚠️  WARNING: sandbox 默认关闭 (老板 2026-08-01 拍板), 当前全放行。设 PANGU_SANDBOX=on 可启用边界检查。');
    }
    return { ok: true, tier: TOOL_TIER[name] || '行', approved: true, sandbox_off: true };
  }
  // 1. 检查主人永久偏好
  const pref = checkOwnerPreference(name);
  if (pref === true) {
    return { ok: true, tier: TOOL_TIER[name] || '行', approved: true };
  }
  if (pref === false) {
    return { ok: false, reason: '主人已永久拒绝此工具: ' + name };
  }

  // 2. 工具白名单检查
  if (!ALLOWED_TOOLS.has(name)) {
    return requestApproval(name, params, '工具未在白名单: ' + name);
  }

  // 3. 用户禁用检查
  try {
    const cfgTools = (opts && opts.cfgTools) || null;
    if (cfgTools && cfgTools[name] && cfgTools[name].enabled === false) {
      return requestApproval(name, params, '工具已被用户在设置页禁用: ' + name);
    }
    // 2026-07-26: /api/tools/toggle 写的是 cfg.tools.disabled 数组 (旧代码只查 per-tool 对象 → 设置页开关从不生效)
    if (cfgTools && Array.isArray(cfgTools.disabled) && cfgTools.disabled.includes(name)) {
      return requestApproval(name, params, '工具已被用户在设置页禁用: ' + name);
    }
  } catch (_) {}

  // 4. 路径检查
  if (name === 'read_file' || name === 'write_file' || name === 'file_edit') {
    if (params && params.path && !isPathAllowed(params.path)) {
      return requestApproval(name, params, '路径不在白名单: ' + params.path + ' | resolved: ' + path.resolve(params.path) + ' | allowed_prefixes: ' + ALLOWED_PATHS.join(', '));
    }
  }
  if (name === 'list_directory' || name === 'file_grep' || name === 'file_find') {
    if (params && params.path && !isPathAllowed(params.path)) {
      return requestApproval(name, params, '路径不在白名单: ' + params.path + ' | resolved: ' + path.resolve(params.path) + ' | allowed_prefixes: ' + ALLOWED_PATHS.join(', '));
    }
  }

  // P0-#14: Git ops 严格限定在 Pangu repo 内
  if (name === 'git_commit' || name === 'git_branch' || name === 'git_diff' || name === 'git_status') {
    // 检查 files[] 是否全在 Pangu repo 内
    if (params && Array.isArray(params.files) && params.files.length > 0) {
      for (const f of params.files) {
        if (!isInsidePanguRepo(f)) {
          return { ok: false, tier: 'git', reason: 'GIT_OPS_NOT_IN_PANGU_REPO: file ' + f + ' 不在 Pangu repo', needs_approval: false };
        }
      }
    }
  }

  // P0-#33: Checkpoint 严格限定在 Pangu repo 内
  if (name === 'checkpoint_create') {
    if (params && Array.isArray(params.files) && params.files.length > 0) {
      for (const f of params.files) {
        if (!isInsidePanguRepo(f)) {
          return { ok: false, tier: 'checkpoint', reason: 'CHECKPOINT_NOT_IN_PANGU_REPO: file ' + f + ' 不在 Pangu repo', needs_approval: false };
        }
      }
    }
  }

  // 5. 危险命令检查
  if (name === 'exec_command') {
 // §0.13 + §0.20 加白名单 (第 2 阶段): 低风险命令 先看, 危险命令 拦
    if (isLowRiskCommand(params && params.command)) {
      // R29 修 (老板 7/25 19:59 拍 '你直接修'): 低风险也要过路径白名单 — 防 'cat /etc/passwd' 'grep TOKEN /etc/' 绕过
      // 安全审计 H1: isLowRiskCommand 检查先于 isDangerousCommand, cat /etc/passwd 被自动放行不审计
      const _cmd = params && params.command;
      // Bug #8 fix: 黑名单扩 — ~/.ssh / ~/.aws / ~/.gnupg / Keychains / /opt / /System / ~/.kube 等敏感路径
      const _blockedSubstrings = [
        '/etc/', '/private/', '/var/', '/usr/',
        '/bin/', '/sbin/',                       // 系统 binary 目录
        '/opt/', '/System/',                      // 第三方/系统核心
        '/Library/Keychains/',                     // macOS keychain
        '~/.ssh/', '~/.aws/', '~/.gnupg/', '~/.kube/', '~/.docker/',
        '$HOME/.ssh', '$HOME/.aws', '$HOME/.gnupg',
        '/Users/'                                  // 任何用户目录 (用 isPathAllowed 二次确认)
      ];
      if (typeof _cmd === 'string' && _blockedSubstrings.some(s => _cmd.includes(s))) {
        return { ok: false, tier: TOOL_TIER[name] || '行', reason: 'LOW_RISK_BUT_PATH_BLOCKED: 低风险但路径不在白名单 (' + _cmd.slice(0, 100) + ')', needs_approval: false };
      }
      return { ok: true, tier: TOOL_TIER[name] || '行', low_risk: true };
    }
    if (isDangerousCommand(params && params.command)) {
      return requestApproval(name, params, '危险命令，需要主人确认: ' + (params && params.command));
    }
  }
  if (name === 'code_execute') {
    if (isDangerousCommand(params && params.code)) {
      return requestApproval(name, params, '危险代码，需要主人确认');
    }
  }

  return { ok: true, tier: TOOL_TIER[name] || '行' };
}

module.exports = {
  ALLOWED_TOOLS,
  ALLOWED_PATHS,
  ALLOWED_LOW_RISK_COMMANDS,
  TOOL_TIER,
  TIMEOUT_BY_CLASS,
  PENDING_APPROVALS,
  approveTask,
  rejectTask,
  isDangerousCommand,
  isLowRiskCommand,
  isPathAllowed,
  isInsidePanguRepo,  // P0-#14
  checkToolCall,
 // W6-1: 工具按 class 取超时
  getTimeoutForTool(name) {
    for (const cls of Object.keys(TIMEOUT_BY_CLASS)) {
      if (cls.startsWith('_')) continue;
      const info = TIMEOUT_BY_CLASS[cls];
      if (info && Array.isArray(info.tools) && info.tools.includes(name)) {
        return info.timeout_ms || 30000;
      }
    }
    return (TIMEOUT_BY_CLASS.default && TIMEOUT_BY_CLASS.default.timeout_ms) || 30000;
  },
};
