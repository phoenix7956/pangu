/**
 * modules/permission.js
 * 盘古 · 多级别权限引擎（Claude Code PermissionPolicy 风格）
 *
 * 六种权限级别（Claude Code 对齐）：
 * default         - 只读，无写入无网络（最低权限）
 * plan            - 规划模式，基础工具+文件读取+网络，危险操作需确认
 * acceptEdits     - 接受编辑，文件写入+网络，危险操作需确认
 * bypassPermissions - 完全绕过，所有操作无限制（含危险操作）
 * dontAsk         - 不询问，AI 自动决定，危险操作直接执行
 * auto            - AI 自动判断是否询问用户（需 AI 分类器）
 */

'use strict';

const os = require('os');
const path = require('path');

const PERMISSION_LEVELS = {
  // default — 只读，无写入无网络
  default: {
    // R29 修 (老板 7/25 19:59 拍 '你直接修'): web_fetch 是网络工具, 但 allowNetwork: false 矛盾 → 网络工具无审计
    // 解: web_fetch 从 allowExec 删, 只留本地只读工具
    allowExec: ['file_grep', 'file_find', 'grep', 'ls', 'find'],
    allowWrite: false, allowWritePaths: [], allowNetwork: false, allowNetworkHosts: [],
    allowDangerous: false, allowDangerousTools: [], promptOnDangerous: false,
  },
  // plan — 规划模式，基础工具+文件写入+网络，危险操作需确认
  plan: {
    allowExec: ['file_grep', 'file_find', 'file_edit', 'web_fetch', 'code_execute', 'grep', 'ls', 'find'],
    allowWrite: true, allowWritePaths: [os.tmpdir(), '~/Downloads', path.join(os.homedir(), 'Downloads')],
    allowNetwork: true, allowNetworkHosts: [], allowDangerous: false, allowDangerousTools: [], promptOnDangerous: false,
  },
  // acceptEdits — 接受编辑，全部工具+全部路径，危险操作需确认
  acceptEdits: {
    allowExec: ['*'], allowWrite: true, allowWritePaths: ['*'],
    allowNetwork: true, allowNetworkHosts: ['*'],
    allowDangerous: true, allowDangerousTools: ['kill', 'pkill', 'rm', 'sudo'], promptOnDangerous: true, // H13: 'rm -rf' 不是 tool name, 改 'rm'
  },
  // bypassPermissions — 完全绕过，无限制（含危险操作）
  bypassPermissions: {
    allowExec: ['*'], allowWrite: true, allowWritePaths: ['*'],
    allowNetwork: true, allowNetworkHosts: ['*'],
    allowDangerous: true, allowDangerousTools: ['*'], promptOnDangerous: false,
    bypass: true, auditAll: true,
    rateLimit: { maxDangerousOpsPerMinute: 10, windowMs: 60000 },
  },
  // dontAsk — 不询问，危险操作直接执行（不弹窗）
  dontAsk: {
    allowExec: ['*'], allowWrite: true, allowWritePaths: ['*'],
    allowNetwork: true, allowNetworkHosts: ['*'],
    allowDangerous: true, allowDangerousTools: ['*'], promptOnDangerous: false,
    dontAsk: true,
    rateLimit: { maxDangerousOpsPerMinute: 10, windowMs: 60000 },
  },
  // auto — AI 自动判断是否询问用户
  auto: {
    allowExec: ['*'], allowWrite: true, allowWritePaths: ['*'],
    allowNetwork: true, allowNetworkHosts: ['*'],
    allowDangerous: true, allowDangerousTools: ['*'], promptOnDangerous: true,
    autoAsk: true, auditAll: true,
  },
};

const DANGEROUS_TOOLS = ['kill', 'pkill', 'rm', 'sudo', 'chmod', 'chown', 'dd', 'mkfs'];
const DANGEROUS_PATTERNS = [/rm\s+-rf\s+\/(?!tmp|Users)/, /:\(\)\{[^}]*\|[^}]*&/, />\/dev\/null/];

// 2026-09-14 (老板拍: 将灵页 auto_approve 收口进全局体系): 级别严格度序
// 将灵 override 只能"放松到某档", 全局/会话级别永远是天花板 — min(全局, 将灵档) 生效
const _LEVEL_RANK = { default: 0, plan: 1, acceptEdits: 2, auto: 3, dontAsk: 4, bypassPermissions: 5 };
// 将灵 auto_approve=true 映射到的 override 档: 替我审批 (常规免确认, 危险 op 仍弹审批)
// 故意不给 dontAsk/bypass — 一个将灵页开关不该能静默放开"危险操作不弹窗"
const AGENT_AUTO_APPROVE_LEVEL = 'acceptEdits';

// 决议有效级别: session override > global, 再与将灵 override 取较严者
// agentOverride 不传/null → 纯 session/global (主循环行为不变)
function resolveEffectiveLevel(sessionId, agentOverride) {
  let level = getCurrentLevel(sessionId);
  if (agentOverride && PERMISSION_LEVELS[agentOverride]) {
    if ((_LEVEL_RANK[agentOverride] ?? 0) < (_LEVEL_RANK[level] ?? 0)) level = agentOverride;
  }
  return level;
}

// 危险命令自动剥离（Claude Code 安全规则）
function hasDangerousPatterns(cmdStr) {
  for (const p of DANGEROUS_PATTERNS) {
    if (p.test(cmdStr)) return true;
  }
  return false;
}

class PermissionEngine {
  // M4: 危险操作速率跟踪 — 适用所有 allowDangerous=true 的 level
  _checkDangerousRate(toolName, action, args) {
    if (action !== 'dangerous' || !this.rules.rateLimit) return null;
    const now = Date.now();
    const window = this.rules.rateLimit.windowMs || 60000;
    const maxOps = this.rules.rateLimit.maxDangerousOpsPerMinute || 10;
    this._dangerousOps = this._dangerousOps.filter(t => now - t < window);
    if (this._dangerousOps.length >= maxOps) {
      this._audit(action, toolName, args, 'rate-limited');
      return { allowed: false, reason: `危险操作速率限制: 每分钟最多 ${maxOps} 次` };
    }
    this._dangerousOps.push(now);
    return null;
  }

  constructor(levelOrConfig = 'default') {
    if (typeof levelOrConfig === 'string') {
      this.level = levelOrConfig;
      this.rules = PERMISSION_LEVELS[levelOrConfig] || PERMISSION_LEVELS.default;
    } else {
      this.level = 'CUSTOM';
      this.rules = { ...PERMISSION_LEVELS.default, ...levelOrConfig };
      // M5: 自定义 rule 审计 — 对未知键 warn 防止 typo 静默
      const knownKeys = new Set(Object.keys(PERMISSION_LEVELS.default));
      for (const key of Object.keys(levelOrConfig)) {
        if (!knownKeys.has(key)) {
          console.warn(`[PermissionEngine] unknown rule key: '${key}' (typo?)`);
        }
      }
      // 校验 allowWritePaths 必须是 array
      if (this.rules.allowWritePaths && !Array.isArray(this.rules.allowWritePaths)) {
        console.warn(`[PermissionEngine] allowWritePaths should be array, got ${typeof this.rules.allowWritePaths}`);
        this.rules.allowWritePaths = [];
      }
    }
    this._customRules = [];
    this._promptCallback = null;
    this._auditLog = [];
    this._dangerousOps = [];  // 危险操作速率追踪 [timestamp, ...]
  }

  setPromptCallback(fn) { this._promptCallback = fn; }

  // 审计日志（bypass/auto 模式）
  _audit(action, toolName, args, result) {
    if (!this.rules.auditAll) return;
    this._auditLog.push({
      ts: new Date().toISOString(),
      level: this.level,
      action, tool: toolName, args, result,
    });
    if (this._auditLog.length > 1000) {
      // M7: O(n) shift() → splice(0, n) 一次性清掉开头 100 条避免循环
      this._auditLog.splice(0, this._auditLog.length - 1000);
    }
  }

  getAuditLog(limit = 50) {
    return this._auditLog.slice(-limit);
  }

  can(toolName, action = 'execute', args = {}) {
    // bypassPermissions 模式：全部允许但记录（含速率限制）
    if (this.rules.bypass) {
      // 危险操作速率限制
      if (action === 'dangerous' && this.rules.rateLimit) {
        const now = Date.now();
        const window = this.rules.rateLimit.windowMs;
        const maxOps = this.rules.rateLimit.maxDangerousOpsPerMinute;
        this._dangerousOps = this._dangerousOps.filter(t => now - t < window);
        if (this._dangerousOps.length >= maxOps) {
          this._audit(action, toolName, args, 'rate-limited');
          return { allowed: false, reason: `危险操作速率限制: 每分钟最多 ${maxOps} 次` };
        }
        this._dangerousOps.push(now);
      }
      this._audit(action, toolName, args, 'allowed-bypass');
      return { allowed: true, reason: 'bypassPermissions模式: 全部允许', bypass: true };
    }

    // dontAsk 模式：危险操作直接执行，不弹窗（含速率限制）
    if (this.rules.dontAsk) {
      if (action === 'dangerous' && this.rules.rateLimit) {
        const now = Date.now();
        const window = this.rules.rateLimit.windowMs;
        const maxOps = this.rules.rateLimit.maxDangerousOpsPerMinute;
        this._dangerousOps = this._dangerousOps.filter(t => now - t < window);
        if (this._dangerousOps.length >= maxOps) {
          this._audit(action, toolName, args, 'rate-limited');
          return { allowed: false, reason: `危险操作速率限制: 每分钟最多 ${maxOps} 次` };
        }
        this._dangerousOps.push(now);
      }
      this._audit(action, toolName, args, 'allowed-dontAsk');
      return { allowed: true, reason: 'dontAsk模式: 直接执行', dontAsk: true };
    }

    // auto 模式：AI 决定是否询问
    if (this.rules.autoAsk && this._promptCallback) {
      this._audit(action, toolName, args, 'auto-pending');
      return { allowed: true, reason: 'auto模式: AI判断', autoAsk: true };
    }

    for (const rule of this._customRules) {
      if (rule.match(toolName, action, args)) {
        return { allowed: rule.allow, reason: `Custom rule: ${rule.name}` };
      }
    }

    switch (action) {
      case 'execute':
        if (this.rules.allowExec.includes('*')) {
          this._audit(action, toolName, args, 'allowed');
          return { allowed: true, reason: '全部工具允许' };
        }
        if (!this.rules.allowExec.includes(toolName)) {
          this._audit(action, toolName, args, 'denied');
          return { allowed: false, reason: `工具 ${toolName} 不在允许列表` };
        }
        this._audit(action, toolName, args, 'allowed');
        return { allowed: true, reason: `工具 ${toolName} 允许` };

      case 'write':
        if (!this.rules.allowWrite) {
          this._audit(action, toolName, args, 'denied');
          return { allowed: false, reason: '写入已禁用' };
        }
        if (this.rules.allowWritePaths.includes('*')) {
          this._audit(action, toolName, args, 'allowed');
          return { allowed: true, reason: '所有路径允许写入' };
        }
        const targetPath = args.path || '';
        // M3: expandUser 处理 ~user/foo + 用 path.resolve 规范化 startsWith
        const expandUser = (p) => {
          if (p === '~' || p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
          const m = p.match(/^~([^/]+)\/(.*)$/); // ~user/foo 格式
          if (m) {
            try {
              const ent = os.userInfo(m[1]);
              return path.join(ent.homedir, m[2]);
            } catch { return p; }
          }
          return p;
        };
        const resolvedTarget = path.resolve(targetPath);
        const allowed = this.rules.allowWritePaths.some(p =>
          resolvedTarget.startsWith(path.resolve(expandUser(p)))
        );
        this._audit(action, toolName, args, allowed ? 'allowed' : 'denied');
        return allowed ? { allowed: true, reason: '路径在白名单内' } : { allowed: false, reason: `路径 ${targetPath} 不在白名单` };

      case 'network':
        if (!this.rules.allowNetwork) {
          this._audit(action, toolName, args, 'denied');
          return { allowed: false, reason: '网络访问已禁用' };
        }
        if (this.rules.allowNetworkHosts.includes('*')) {
          this._audit(action, toolName, args, 'allowed');
          return { allowed: true, reason: '所有主机允许' };
        }
        if (args.host && !this.rules.allowNetworkHosts.includes(args.host)) {
          this._audit(action, toolName, args, 'denied');
          return { allowed: false, reason: `主机 ${args.host} 不在白名单` };
        }
        this._audit(action, toolName, args, 'allowed');
        return { allowed: true, reason: '网络访问允许' };

      case 'dangerous':
        if (!this.rules.allowDangerous) {
          const cmdStr = args.command || args.shell || '';
          if (hasDangerousPatterns(cmdStr)) {
            this._audit(action, toolName, args, 'denied-dangerous-pattern');
            return { allowed: false, reason: '命令匹配危险模式，已拦截' };
          }
          if (DANGEROUS_TOOLS.includes(toolName)) {
            this._audit(action, toolName, args, 'denied');
            return { allowed: false, reason: `危险工具: ${toolName}` };
          }
          this._audit(action, toolName, args, 'denied');
          return { allowed: false, reason: '危险操作已禁用' };
        }
        if (this.rules.allowDangerousTools.includes('*')) {
          this._audit(action, toolName, args, 'allowed');
          return { allowed: true, reason: '全部危险操作允许' };
        }
        if (!this.rules.allowDangerousTools.includes(toolName)) {
          this._audit(action, toolName, args, 'denied');
          return { allowed: false, reason: `危险工具 ${toolName} 不在白名单` };
        }
        this._audit(action, toolName, args, 'allowed');
        return { allowed: true, reason: `危险工具 ${toolName} 允许` };

      default:
        return { allowed: true, reason: '未知操作类型，默认允许' };
    }
  }

  addRule(rule) { this._customRules.push(rule); }

  loadFromFile(configPath) {
    if (!require('fs').existsSync(configPath)) return;
    try {
      const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
      if (config.level && PERMISSION_LEVELS[config.level]) {
        this.level = config.level;
        this.rules = { ...PERMISSION_LEVELS[config.level] };
      } else if (config.level) {
        // M6: 未知 level 不能静默 — 显式 log
        console.warn(`[PermissionEngine] unknown config.level='${config.level}', falling back to '${this.level}'`);
      }
      if (Array.isArray(config.customRules)) {
        for (const r of config.customRules) this.addRule(r);
      } else if (config.customRules) {
        console.warn(`[PermissionEngine] config.customRules should be array, got ${typeof config.customRules}`);
      }
    } catch (err) {
      console.error(`[PermissionEngine] Failed to load config: ${err.message}`);
    }
  }

  async withElevated(level, fn) {
    const savedLevel = this.level;
    const savedRules = { ...this.rules };
    try {
      this.level = level;
      this.rules = PERMISSION_LEVELS[level] || this.rules;
      return await fn();
    } finally {
      this.level = savedLevel;
      this.rules = savedRules;
    }
  }

  describe() {
    return {
      level: this.level,
      allowExec: this.rules.allowExec,
      allowWrite: this.rules.allowWrite,
      allowNetwork: this.rules.allowNetwork,
      allowDangerous: this.rules.allowDangerous,
      bypass: !!this.rules.bypass,
      dontAsk: !!this.rules.dontAsk,
      autoAsk: !!this.rules.autoAsk,
      auditSize: this._auditLog.length,
    };
  }
}

// 2026-08-16 P1-2: 危险操作审批流 (新政 #7 安全治理: 沙箱 + 分级授权 + 高危人工审批)
// 流程: 调 requirePermission(tool, args, ctx) → 阻塞等待 → emit SSE permission_required →
//       主人前端弹窗 → POST /api/pangu/agent/permission/respond → resolve promise → 工具执行
// 默认 60s 超时拒绝 (防主人不在时挂死 loop)

const _pendingApprovals = new Map(); // token -> { resolve, reject, timeout, tool, args, sessionId, ts }
let _approvalCounter = 0;

function _nextToken() {
  _approvalCounter++;
  return 'perm_' + Date.now().toString(36) + '_' + _approvalCounter.toString(36);
}

/**
 * 同步等待主人审批
 * @param {string} toolName
 * @param {object} args
 * @param {object} ctx { sessionId, res, timeoutMs }
 * @returns {Promise<{approved: boolean, reason?: string}>}
 */
function requirePermission(toolName, args, ctx = {}) {
  return new Promise((resolve, reject) => {
    const token = _nextToken();
    // 2026-09-14 (老板拍 #8): 超时时长可配, 默认 60s 不变
    const timeoutMs = ctx.timeoutMs || parseInt(process.env.PANGU_APPROVAL_TIMEOUT_MS || '60000', 10);
    const sessionId = ctx.sessionId || 'unknown';
    const timeout = setTimeout(() => {
      if (_pendingApprovals.has(token)) {
        _pendingApprovals.delete(token);
        // 2026-09-14 (老板拍 #8: 审批卡 60s 干等默认拒, 深夜误杀长任务):
        // 超时不再一刀切拒 — 可逆工作区操作 (写文件/编辑/记忆/plan 等, 非 exec 非删除非外发)
        // 且路径过沙箱白名单 → 自动批准 + 审计记账 + SSE 告知, 主人第二天可在审计里回看;
        // exec_command/删除/外发/危险命令 一律维持超时拒绝 (安全底线不动)。
        const verdict = _timeoutVerdict(toolName, args);
        _auditTimeout(sessionId, toolName, args, verdict);
        if (verdict.approved) {
          try {
            if (ctx.res && !ctx.res.writableEnded) {
              ctx.res.write('event: permission_timeout_autopass\ndata: ' + JSON.stringify({
                token, tool: toolName, session_id: sessionId,
                reason: verdict.reason, ts: Date.now(),
              }) + '\n\n');
            }
          } catch (_) { /* swallow */ }
        }
        resolve(verdict);
      }
    }, timeoutMs);
    _pendingApprovals.set(token, { resolve, reject, timeout, tool: toolName, args, sessionId, ts: Date.now() });
    // emit SSE 通知前端
    try {
      if (ctx.res && !ctx.res.writableEnded) {
        ctx.res.write('event: permission_required\ndata: ' + JSON.stringify({
          token, tool: toolName, args: _summarizeArgs(args), session_id: sessionId, timeout_ms: timeoutMs, ts: Date.now()
        }) + '\n\n');
      }
    } catch (e) { /* swallow */ }
  });
}

function _summarizeArgs(args) {
  // 截断 args 防止 SSE 过大, 只留关键字段
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const k of Object.keys(args).slice(0, 8)) {
    let v = args[k];
    if (typeof v === 'string' && v.length > 200) v = v.slice(0, 200) + '...';
    out[k] = v;
  }
  return out;
}

// 2026-09-14 (#8): 超时裁决 — 可逆工作区操作白名单
// 安全边界: ① 工具必须在白名单 (无 exec/kill/rm/sudo/外发类) ② args 里的路径字段必须全过沙箱白名单
// 白名单刻意短 — 拿不准的不进, 进错了是安全事故
const _TIMEOUT_AUTOPASS_TOOLS = new Set([
  'write_file', 'file_edit', 'file_edit_batch', 'apply_patch',
  'memory_write', 'todo_write', 'plan_create', 'plan_step_done', 'plan_step_failed',
  'session_save', 'cache_put',
]);
const _PATH_ARG_KEYS = ['path', 'file', 'file_path', 'target', 'target_path', 'output', 'output_path', 'dest', 'destination'];

function _timeoutVerdict(toolName, args) {
  if (!_TIMEOUT_AUTOPASS_TOOLS.has(toolName)) {
    return { approved: false, reason: '主人未在限时内审批, 默认拒绝 (工具 ' + toolName + ' 不在超时自动批准白名单)' };
  }
  // 路径字段全过沙箱白名单才放行 (write_file 写到 /etc 绝不许超时自动批)
  try {
    const sandbox = require('./sandbox');
    if (args && typeof args === 'object') {
      for (const k of _PATH_ARG_KEYS) {
        const v = args[k];
        if (typeof v === 'string' && (v.startsWith('/') || v.startsWith('~'))) {
          if (!sandbox.isPathAllowed(v)) {
            return { approved: false, reason: '超时默认拒绝: ' + toolName + ' 路径 ' + v.slice(0, 80) + ' 不在沙箱白名单' };
          }
        }
      }
      // file_edit_batch 的 edits 数组里每个 path 也要查
      if (Array.isArray(args.edits)) {
        for (const e of args.edits) {
          const p = e && (e.path || e.file);
          if (typeof p === 'string' && (p.startsWith('/') || p.startsWith('~')) && !sandbox.isPathAllowed(p)) {
            return { approved: false, reason: '超时默认拒绝: 批量编辑含白名单外路径 ' + p.slice(0, 80) };
          }
        }
      }
    }
  } catch (_) {
    return { approved: false, reason: '超时默认拒绝: 沙箱校验不可用, 宁可拒' };
  }
  return { approved: true, reason: '审批超时, 自动批准可逆工作区操作 (' + toolName + '), 已记审计' };
}

// 超时裁决全量审计 (批准/拒绝都记) — 主人可在 ~/.pangu/state/permission_audit.jsonl 回看
function _auditTimeout(sessionId, toolName, args, verdict) {
  try {
    const f = _path.join(_PANGU_HOME, 'state', 'permission_audit.jsonl');
    _fs.mkdirSync(_path.dirname(f), { recursive: true });
    _fs.appendFileSync(f, JSON.stringify({
      ts: new Date().toISOString(), session: sessionId, tool: toolName,
      args: _summarizeArgs(args), timeout: true, approved: verdict.approved, reason: verdict.reason,
    }) + '\n');
  } catch (_) { /* 审计失败不阻断裁决 */ }
}

/**
 * 主人审批回调 (从 /api/pangu/agent/permission/respond 调)
 */
function respondToApproval(token, approved, reason) {
  const p = _pendingApprovals.get(token);
  if (!p) return { ok: false, error: { code: 'NO_PENDING', message: '审批 token 不存在或已过期' } };
  clearTimeout(p.timeout);
  _pendingApprovals.delete(token);
  p.resolve({ approved: !!approved, reason: reason || (approved ? '主人批准' : '主人拒绝') });
  return { ok: true, result: { tool: p.tool, session_id: p.sessionId, approved: !!approved } };
}

/**
 * 列出当前待审批 (前端 reconnect 后能查到)
 */
// 2026-08-16 P0: 当前 level 持久化 (老板截图 ChatGPT 权限 UI, 盘古缺这玩意)
// 写到 ~/.pangu/state/permission.json — 启动读, 修改写
const _fs = require('fs');
const _path = require('path');
const _os = require('os');
const _PANGU_HOME = process.env.PANGU_HOME || _path.join(_os.homedir(), '.pangu');
const _LEVEL_FILE = _path.join(_PANGU_HOME, 'state', 'permission.json');

const _LEVEL_META = {
  default: { name: '只读', color: 'gray', icon: '🔒', description: '只读模式, 无写入无网络 (最低权限)', preset: 'requestApproval' },
  plan: { name: '规划', color: 'blue', icon: '📋', description: '基础工具 + 文件写入 + 网络, 危险操作需确认', preset: 'requestApproval' },
  acceptEdits: { name: '接受编辑', color: 'cyan', icon: '✏️', description: '全部工具 + 全部路径, 危险操作需确认', preset: 'autoApprove' },
  bypassPermissions: { name: '完全访问', color: 'red', icon: '⚠️', description: '完全绕过, 不受限制 (含危险操作), 所有动作审计', preset: 'fullAccess' },
  dontAsk: { name: '不询问', color: 'orange', icon: '⚡', description: '危险操作直接执行, 不弹窗 (限速保护)', preset: 'fullAccess' },
  auto: { name: '智能审批', color: 'purple', icon: '🤖', description: 'AI 自动判断是否询问 (需 AI 分类器)', preset: 'autoApprove' },
};

// 2026-09-14 (老板拍: 聊天弹层和设置页对应起来): 6 级 ↔ 聊天页 4 档的映射单一真源
// 聊天弹层/设置页/将灵页都从这份读, 禁止前端各自硬编码第二份词汇表
const _PRESET_META = {
  requestApproval: { label: '请求批准', icon: '✋', desc: '编辑外部文件和使用互联网时始终询问', levels: ['default', 'plan'], defaultLevel: 'default' },
  autoApprove:     { label: '替我审批', icon: '🛡', desc: '仅对检测到的风险操作请求批准', levels: ['acceptEdits', 'auto'], defaultLevel: 'acceptEdits' },
  fullAccess:      { label: '完全访问', icon: '⚠️', desc: '可不受限制地访问互联网和您电脑上的任何文件', levels: ['bypassPermissions', 'dontAsk'], defaultLevel: 'bypassPermissions' },
};
// level → preset 反查
function levelToPreset(level) {
  const meta = _LEVEL_META[level];
  return (meta && meta.preset) || 'autoApprove';
}

// 2026-08-17: 两级 — global default + session_overrides[sessionId]
// 存 ~/.pangu/state/permission.json: {global, session_overrides: {sid: {level, expires_at, set_at}}, updated_at}
// 兼容旧格式 {level: X} → 启动时包装
let _permState = null;

function _ensureLevelFile() {
  try { _fs.mkdirSync(_path.dirname(_LEVEL_FILE), { recursive: true }); } catch (_) {}
}

function _normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return { global: 'default', session_overrides: {} };
  if (typeof raw.level === 'string' && !raw.global) return { global: raw.level, session_overrides: {} };
  return {
    global: raw.global || 'default',
    session_overrides: raw.session_overrides && typeof raw.session_overrides === 'object' ? raw.session_overrides : {},
  };
}

function _loadLevelFromDisk() {
  try {
    if (!_fs.existsSync(_LEVEL_FILE)) return null;
    const d = JSON.parse(_fs.readFileSync(_LEVEL_FILE, 'utf8'));
    return _normalizeState(d);
  } catch (_) { return null; }
}

function _saveStateToDisk(state) {
  _ensureLevelFile();
  const tmp = _LEVEL_FILE + '.tmp.' + process.pid;
  _fs.writeFileSync(tmp, JSON.stringify({
    global: state.global,
    session_overrides: state.session_overrides,
    updated_at: new Date().toISOString(),
  }, null, 2), 'utf8');
  _fs.renameSync(tmp, _LEVEL_FILE);
}

const _SESSION_OVERRIDE_TTL_MS = 24 * 60 * 60 * 1000;

function _purgeStaleOverrides(state) {
  const now = Date.now();
  let changed = false;
  for (const [sid, v] of Object.entries(state.session_overrides)) {
    const expires = (v && typeof v === 'object' && v.expires_at) ? new Date(v.expires_at).getTime() : 0;
    if (expires && expires < now) {
      delete state.session_overrides[sid];
      changed = true;
    }
  }
  return changed;
}

function _getState() {
  if (_permState === null) {
    // 2026-10-28 (第 136 批 P3): 「只读」档从今天起**真的**禁写禁网 (见 permission_guard.js)。
    // 那就带来一个必须说清楚的问题: **从没设置过的机器**该是什么档?
    //
    //   · 老口径: 文件不存在 ⇒ global='default' ⇒ 界面上写"只读", 实际什么都能干
    //     (permission_engine.can() 从来没人调)。新装/被删了 state 的机器实际是**不限**的。
    //   · 如果照搬 'default' 当兜底, 新装的盘古会当场变成"只读" ⇒ 写不了记忆、导不了文件,
    //     开源版主人第一眼就撞上一个"坏了"的盘古 —— 这是**新造的**事故, 不是修事故。
    //
    // ⇒ 兜底改成 'bypassPermissions': 没设置过 = 保持 2026-10-28 之前的行为 (不限),
    //   一旦主人在设置页**显式**选了「只读」, 那个选择立刻变成真的 (permission_guard 硬拦)。
    //   注意这是"兼容老行为", 不是"默认就该全放行" —— 想收紧请显式选档。
    _permState = _loadLevelFromDisk() || { global: 'bypassPermissions', session_overrides: {} };
    if (_purgeStaleOverrides(_permState)) _saveStateToDisk(_permState);
  }
  return _permState;
}

// 返回某 session 当前生效的 level (override 优先, 否则 global)
// 不传 sessionId → global
function getCurrentLevel(sessionId) {
  const s = _getState();
  if (!sessionId) return s.global;
  const ov = s.session_overrides[sessionId];
  if (!ov) return s.global;
  return (typeof ov === 'object' && ov.level) ? ov.level : ov;
}

function setCurrentLevel(level, opts = {}) {
  if (!PERMISSION_LEVELS[level]) return { ok: false, error: 'unknown level: ' + level };
  const scope = opts.scope === 'session' ? 'session' : 'global';
  const s = _getState();
  if (scope === 'global') {
    const prev = s.global;
    s.global = level;
    _saveStateToDisk(s);
    return { ok: true, prev, current: level, scope: 'global' };
  }
  const sid = opts.sessionId || '';
  if (!sid) return { ok: false, error: 'sessionId required for scope=session' };
  const prev = getCurrentLevel(sid);
  const expires_at = new Date(Date.now() + _SESSION_OVERRIDE_TTL_MS).toISOString();
  s.session_overrides[sid] = { level, expires_at, set_at: new Date().toISOString() };
  _saveStateToDisk(s);
  return { ok: true, prev, current: level, scope: 'session', session_id: sid, expires_at };
}

function clearSessionOverride(sessionId) {
  if (!sessionId) return { ok: false, error: 'sessionId required' };
  const s = _getState();
  if (!s.session_overrides[sessionId]) return { ok: true, cleared: 0, session_id: sessionId };
  delete s.session_overrides[sessionId];
  _saveStateToDisk(s);
  return { ok: true, cleared: 1, session_id: sessionId };
}

function listSessionOverrides() {
  const s = _getState();
  _purgeStaleOverrides(s);
  return Object.entries(s.session_overrides).map(([sid, v]) => ({
    session_id: sid,
    level: (typeof v === 'object' && v.level) ? v.level : v,
    set_at: (typeof v === 'object' && v.set_at) || null,
    expires_at: (typeof v === 'object' && v.expires_at) || null,
  }));
}

// 给前端列所有 level + 当前选中 + 简短描述
// sessionId 可选 — 传则显示该 session 实际生效的 (override 或 global)
function listLevels(sessionId) {
  const current = getCurrentLevel(sessionId);
  return Object.keys(PERMISSION_LEVELS).map(key => {
    const rules = PERMISSION_LEVELS[key];
    const meta = _LEVEL_META[key] || {};
    const preset = meta.preset || 'autoApprove';
    return {
      id: key,
      name: meta.name || key,
      color: meta.color || 'gray',
      icon: meta.icon || '⚙',
      description: meta.description || '',
      current: key === current,
      // 2026-09-14: preset 归属 (聊天弹层 4 档词汇) — 两端 UI 对齐用
      preset,
      preset_label: (_PRESET_META[preset] || {}).label || preset,
      // 关键 flags 摘要 (前端不用深入 rule)
      summary: {
        allowExec: Array.isArray(rules.allowExec) && rules.allowExec[0] === '*' ? '全部' : (rules.allowExec || []).length + ' 个',
        allowWrite: !!rules.allowWrite,
        allowNetwork: !!rules.allowNetwork,
        allowDangerous: !!rules.allowDangerous,
        promptOnDangerous: !!rules.promptOnDangerous,
        bypass: !!rules.bypass,
        dontAsk: !!rules.dontAsk,
        autoAsk: !!rules.autoAsk,
      },
    };
  });
}

// 判断给定 tool 在当前 level 下是否需要 ask 主人
// ctx.sessionId 可选 — 传则用该 session 的 override 或 global; 不传则纯 global
// 返回 { ask: bool, reason: string, level: string, scope: 'global'|'session'|'inherited' }
function shouldAsk(toolName, args, ctx) {
  const sid = (ctx && ctx.sessionId) || null;
  const agentOv = (ctx && ctx.agentLevel) || null;
  const s = _getState();
  const ov = sid ? s.session_overrides[sid] : null;
  let level, scope;
  if (ov) { level = (typeof ov === 'object' && ov.level) ? ov.level : ov; scope = 'session'; }
  else { level = s.global; scope = sid ? 'inherited' : 'global'; }
  // 2026-09-14: 将灵 auto_approve override — 只能收紧不能放开 (全局是天花板)
  if (agentOv && PERMISSION_LEVELS[agentOv] && (_LEVEL_RANK[agentOv] ?? 0) < (_LEVEL_RANK[level] ?? 0)) {
    level = agentOv; scope = 'agent';
  }
  const rules = PERMISSION_LEVELS[level] || PERMISSION_LEVELS.default;
  // 1. bypass / dontAsk → 不问
  if (rules.bypass || rules.dontAsk) return { ask: false, reason: 'level=' + level + ' (bypass/dontAsk)', level, scope };
  // 1.5 2026-10-14: exec_command 里包着的命令, 以前**完全看不见**。
  // DANGEROUS_TOOLS 里有 'rm'/'sudo'/'kill', 但盘古没有名为 'rm' 的工具 ——
  // 命令都包在 exec_command 里, 于是这道拦截一次都没生效过。
  // 现场: 老板填本地 BASE URL 点"从上游获取"打到了云端, 同一个洞的另一面 ——
  // 权限层看不见命令内容, 就等于对"这条命令要干什么"完全没有判断力。
  // 这里把命令内容分类一次, 破坏性的按危险 op 处理 (仍受 promptOnDangerous 开关管,
  // bypass 档位照旧不问 —— 老板明确说了别问我, 那就不问)。
  if (toolName === 'exec_command' && rules.promptOnDangerous) {
    try {
      const ap = require('./action_policy');
      const v = ap.classifyDanger(args && (args.command || args.cmd || args.script));
      if (v.dangerous) {
        return { ask: true, reason: 'exec_command 内含破坏性命令: ' + v.reason, level, scope };
      }
    } catch (_) { /* 分类器异常不阻断 */ }
  }
  // 2. 危险 tool 列表
  if (rules.allowDangerous && Array.isArray(rules.allowDangerousTools)) {
    const inDangerList = rules.allowDangerousTools.includes('*') || rules.allowDangerousTools.includes(toolName);
    if (inDangerList && rules.promptOnDangerous) {
      return { ask: true, reason: '危险 op (' + toolName + ') 命中 level=' + level + ' 的 allowDangerousTools', level, scope };
    }
  }
  // 3. acceptEdits / auto → 写文件类也问
  if (rules.promptOnDangerous && DANGEROUS_TOOLS.includes(toolName)) {
    return { ask: true, reason: '危险 op (' + toolName + ') 默认拦截', level, scope };
  }
  return { ask: false, reason: 'tool ' + toolName + ' 不在 level=' + level + ' 拦截范围', level, scope };
}

function listPendingApprovals(sessionId) {
  const out = [];
  for (const [token, p] of _pendingApprovals.entries()) {
    if (!sessionId || p.sessionId === sessionId) {
      out.push({ token, tool: p.tool, session_id: p.sessionId, ts: p.ts, age_ms: Date.now() - p.ts });
    }
  }
  return out;
}

module.exports = {
  PermissionEngine, PERMISSION_LEVELS,
  requirePermission, respondToApproval, listPendingApprovals,
  getCurrentLevel, setCurrentLevel, listLevels, shouldAsk,
  clearSessionOverride, listSessionOverrides,
  levelToPreset, PRESET_META: _PRESET_META,
  resolveEffectiveLevel, AGENT_AUTO_APPROVE_LEVEL, LEVEL_RANK: _LEVEL_RANK,
  _timeoutVerdict, // 2026-09-14 (#8): 导出供单测
};

module.exports.createPermissionEngine = (level) => new PermissionEngine(level);
