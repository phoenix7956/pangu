/**
 * Pangu · Modules · Tools
 * index.js - 工具函数实现(完整版)
 *
 * v2 P2-9 备注:
 * 这是项目最大单文件 (2726 行, 95% TOOLS 字面量).
 * 风险: 83 处 require('./modules/tools/index.js') 引用 TOOLS 对象, 任何 require 关系改动
 *      都会引发 import cycle (skill_runtime ↔ tools 已有依赖).
 * 决策: 留 P3 拆, 先保证主路径零风险. 候选拆分:
 *   - tools/exec.js (exec_command, run_installer, sandbox 集成)
 *   - tools/files.js (read_file, write_file, list_dir)
 *   - tools/network.js (http_*, curl, weather)
 *   - tools/research.js (memory_search, web_search)
 *   - tools/specialty.js (bazi_calc, task_done, list_pangu_agents)
 *   + tools/index.js (re-export facade, 保留同 module.exports.TOOLS 接口)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
// 2026-08-02: 全模块统一仓库根锚点 (tools/index.js 在 apps/core/modules/tools/ 下, 上 4 级)
// 根治 daemon cwd = apps/core 导致的相对路径双重套娃 (盘古 RTF 11:24 连环幻觉实案)
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
// M4: 重命名 execSync → execCb (避免与 child_process.execSync 同步函数混淆)
const { exec: execCb } = require('child_process');
// 向后兼容别名, 老代码 String(execSync(...)) 模式仍能跑 (虽然语义可疑, 但不动以免引入新 bug)
const execSync = execCb;
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);

// ============================================================
// 2026-10-28 第 129 批: 批命做题题的「绕路」闸门
// ============================================================
//
// 现场 (2026-10-27 23:40, 会话 15567183): 老板发课件《排盘样例》图 +「做题，看清楚题目」。
//   盘古把「分析出生地周围情况」读成了「1975 年四川/成都的社会经济统计」——
//   发了一条 web_search, 又派了个子 agent 去查 1975 年职工平均工资/城镇化率/人口总数。
//   子 agent 连着 6 次 web_fetch 超时(每次 30s), 整轮 4m49s 还在跑, 实际 10 分钟没结束。
//
// 为什么这道门必须落在**工具层**而不是只写在 prompt 里:
//   prompt 里写「不许上网」是**注释**, 不是隔离 —— 模型照样发。
//   项目铁律: 注释 ≠ 隔离, 要靠机制。
//
// 口径真源 = modules/bazi_items.js (唯一真源, 这里不另抄一份判据)。
// 拦的是「这题根本不该查」; chart_verify_guard 拦的是「拿着盘还去重算」—— 两个门各管一件事。
function _baziItemScopeGuard(toolName, ctx) {
  try {
    const _bi = require('../bazi_items');
    const sessionId = ctx && ctx.context && ctx.context.sessionId;
    const v = _bi.inspectToolCall(toolName, (ctx && ctx.params) || {}, { sessionId });
    if (!v || !v.blocked) return null;
    console.warn('[bazi-items] 拦下 ' + toolName + ': ' + v.why);
    return {
      ok: false,
      blocked: true,
      data: null,
      error: { code: 'ITEM_SCOPE', message: v.why },
      message: _bi.scopeMessage(),
    };
  } catch (_) {
    // 闸门本身不许成为新的故障源 (跟 chart_verify_guard 同一条规矩)。
    return null;
  }
}

// ffmpeg 路径解析 — Pangu launchd 进程 PATH 不含 ~/.local/bin
// 但 imageio-ffmpeg 装的 ffmpeg 在那里. 依次尝试: PATH → ~/.local/bin → /opt/homebrew/bin → /usr/local/bin
const _FFMPEG_CANDIDATES = [
  'ffmpeg',
  require('path').join(require('os').homedir(), '.local', 'bin', 'ffmpeg'),
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
];
let _resolvedFfmpeg = null;

// Models occasionally wrap a tool payload in `{raw: "{...}"}` after a
// malformed XML/JSON tool tag. Normalize that shape once at the tool boundary
// so individual handlers do not silently report NO_PATH/NO_CMD.
function _parseJsonLoose(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch (_) {}
  // 模型常把坏工具标签的整段残留 (结尾常带一个 ">") 包进 raw。
  // 退回"截第一对花括号", 并从后往前逐个试闭合点, 避免一遇脏尾巴就整个放弃。
  const start = t.indexOf('{');
  if (start < 0) return null;
  let tries = 0;
  for (let end = t.length - 1; end > start && tries < 64; end--) {
    if (t[end] !== '}') continue;
    tries++;
    try {
      const v = JSON.parse(t.slice(start, end + 1));
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch (_) { /* 闭合点不对, 继续往前找 */ }
  }
  return null;
}

function _normalizeToolParams(params) {
  if (!params || typeof params !== 'object') return {};
  let out = { ...params };
  for (let i = 0; i < 2 && typeof out.raw === 'string'; i++) {
    const raw = out.raw.trim();
    if (!raw) break;
    try {
      const parsed = _parseJsonLoose(raw);
      if (!parsed) break;
      out = { ...parsed, ...Object.fromEntries(Object.entries(out).filter(([k]) => k !== 'raw')) };
    } catch (_) {
      break;
    }
  }
  return out;
}

// 2026-10-12: 把归一化收到单一出口, 原地裹住每个工具 (不换 TOOLS 对象, 免得
// streaming_tool_executor 读的 fn._concurrency 在替换后丢成 undefined)。
function _normalizeAllToolParams(tools) {
  if (!tools || typeof tools !== 'object') return tools;
  // 只有 TOOLS_SCHEMA 里登记的才是模型可调工具。TOOLS 命名空间里混着
  // _castGua / _guaData / _expandHome 三个内部 helper, 它们吃的是裸参数不是 {context,params},
  // 裹了会把 write_file 里的 TOOLS._expandHome(params.path) 弄炸。
  let schema = null;
  try { schema = require('../tools_schema').TOOLS_SCHEMA || null; } catch (_) { schema = null; }
  for (const name of Object.keys(tools)) {
    if (schema && !(name in schema)) continue;
    const fn = tools[name];
    if (typeof fn !== 'function' || fn.__panguParamsNormalized) continue;
    const wrapped = function (ctx) {
      const c = ctx && typeof ctx === 'object' ? Object.assign({}, ctx) : {};
      c.params = _normalizeToolParams(c.params);
      return fn.call(this, c);
    };
    try { Object.defineProperty(wrapped, 'name', { value: name, configurable: true }); } catch (_) {}
    // _concurrency 这类标记要原样带过去 (streaming_tool_executor.js:34 靠它判并发安全)
    for (const k of Object.keys(fn)) {
      if (k === 'length' || k === 'name' || k === 'prototype') continue;
      try { wrapped[k] = fn[k]; } catch (_) {}
    }
    try { Object.defineProperty(wrapped, '__panguParamsNormalized', { value: true }); } catch (_) {}
    tools[name] = wrapped;
  }
  return tools;
}

// Bug#4 修复: 设备名枚举 (替代硬编码 'MacBook Pro相机'/'MacBook Pro麦克风')
function _enumerateAVDevices() {
  try {
    const { execSync } = require('child_process');
    const ff = _resolveFfmpeg();
    const out = execSync('"' + ff.replace(/"/g, '\"') + '" -f avfoundation -list_devices true -i "" 2>&1', { encoding: 'utf8', timeout: 5000 });
    const videoMatch = out.match(/AVFoundation video devices:\s*\n((?:\s*\[.*?\].*\n?)*)/);
    const audioMatch = out.match(/AVFoundation audio devices:\s*\n((?:\s*\[.*?\].*\n?)*)/);
    return {
      video: videoMatch ? videoMatch[1].trim().split('\n').map(l => l.trim()).filter(Boolean) : [],
      audio: audioMatch ? audioMatch[1].trim().split('\n').map(l => l.trim()).filter(Boolean) : [],
    };
  } catch (_) {
    return { video: [], audio: [] };
  }
}

let _cachedAVDevices = null;
function _getAVDevices() {
  if (!_cachedAVDevices) {
    _cachedAVDevices = _enumerateAVDevices();
  }
  return _cachedAVDevices;
}

function _findFirstDevice(type) {
  const devices = _getAVDevices();
  if (devices[type] && devices[type].length > 0) {
    const m = devices[type][0].match(/\[(\d+)\]\s*(.+)/);
    if (m) return m[2].trim();
    return devices[type][0].trim();
  }
  return type === 'video' ? '[0]' : '[1]';
}

function _resolveFfmpeg() {
  if (_resolvedFfmpeg) return _resolvedFfmpeg;
  const fs = require('fs');
  for (const cand of _FFMPEG_CANDIDATES) {
    try {
      if (cand === 'ffmpeg') {
        // PATH 查找: 用 which
        require('child_process').execSync('which ffmpeg', { stdio: 'pipe' });
        _resolvedFfmpeg = 'ffmpeg';
        return _resolvedFfmpeg;
      }
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        _resolvedFfmpeg = cand;
        return _resolvedFfmpeg;
      }
    } catch (_) { /* try next */ }
  }
  // H10 修: 失败时不写缓存 (避免 transient PATH miss 永久毒化)
  // 下次再试, 给 PATH 修复一次机会
  return 'ffmpeg';  // 仅当下次使用, 不存
}

// 工具箱全局安全日志 (4 处 catch 引用, 此前从未定义导致 ReferenceError, get_lan_ip 等走 catch 路径必崩)
function _safeLog(tag, msg) {
  if (process.env.PANGU_DEBUG) console.warn('[pangu]', tag + ':', (msg || '').slice(0, 200));
}

// 修: 上一行原来是 'execFile'); (缺右括号+单引号), 改正为 execFile);
// 这是预先存在的 syntax 错误, 本次顺带修, 严格不动 64 卦内核
// 借鉴 #3 (TaskOutputTool): 异步后台任务调度器
const taskOutput = require(path.join(__dirname, '..', 'task_output'));

// 跨平台修: read_file/write_file 里用的 blocked 之前没声明 (Mac 依赖外层 scope undefined 运气好没爆, Linux ReferenceError)
// 现在 module-level 显式声明
const blocked = [
  path.join(os.homedir(), '.ssh'),
  // 与 sandbox.js 命令黑名单对齐 (Bug #8 只扩了 shell 侧, read_file/write_file 漏了)
  path.join(os.homedir(), '.aws'),
  path.join(os.homedir(), '.gnupg'),
  path.join(os.homedir(), '.kube'),
  path.join(os.homedir(), '.docker'),
  path.join(os.homedir(), 'Library', 'Keychains'),
  // 2026-10-27 第 118 批: ~/.pangu/credentials.json 里是**三个真 key 的明文**
  // (KIMI/MINIMAX/AGNES)。目录本身 0700 + 文件 0600, 所以同机别的用户读不到;
  // 但 read_file 工具能读 —— 一次提示注入就能把密钥读进模型上下文/日志。
  // 挡掉「文件本身」而不是整个 ~/.pangu —— 后者的记忆/状态目录是盘古自己的正经活。
  path.join(os.homedir(), '.pangu', 'credentials.json'),
  path.join(os.homedir(), '.pangu', 'credentials'),
  '/etc/ssh',
  '/etc/passwd',
  '/etc/shadow',
  '/etc/sudoers',
  '/root/.ssh',
  '/.ssh',
  '/System',
  '/Library/Keychains',
];

// ================================================================
// 工具注册表
// ================================================================

// 2026-08-01 老板拍: 静默截断 = bug (丢数据 + 逼模型幻觉)。超限完整落盘 /tmp, 返回路径分段读
function _spillOutput(text, limit, tag) {
  if (!text || text.length <= limit) return text;
  try {
    const dir = '/tmp/pangu-exec-out';
    // 2026-10-27 第 118 批: 之前是 mkdir 默认 0755 + writeFile 默认 0644 ⇒
    // 全世界可读的目录里躺着 579 份工具输出日志 (其中有真 key 明文)。
    // 落盘就按「只有自己能看」建: 目录 0700 / 文件 0600。
    require('fs').mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { require('fs').chmodSync(dir, 0o700); } catch (_) { /* 目录已存在且归别人, 不强改 */ }
    const f = require('path').join(dir, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + tag + '.log');
    require('fs').writeFileSync(f, text, { mode: 0o600 });
    try { require('fs').chmodSync(f, 0o600); } catch (_) { /* umask 挡住 mode 参数时补一刀 */ }
    return text.slice(0, limit) + '\n\n[⚠️ 输出共 ' + text.length + ' 字符, 此处只显示前 ' + limit + '。完整输出已保存: ' + f + ' — 用 read_file 或 exec_command (sed -n 分段) 继续读]';
  } catch (_) {
    return text.slice(0, limit) + '\n\n[⚠️ 输出共 ' + text.length + ' 字符, 已截断 (落盘失败)]';
  }
}

  // 2026-10-09 (老板截图报"这是什么问题"): 模型凭训练惯性写 Linux 命令, 盘古跑在 macOS。
  // 实案: `hostname && uptime && cat /proc/loadavg` → macOS 无 /proc, 工具红字失败。
  // 而 uptime 本身已经给了它想要的负载均值, 那截纯属多余。
  // 这里不硬拦(命令可能合法), 而是直接把 macOS 对应写法告诉模型, 省一轮往返。
const DARWIN_ONLY_HINTS = [
  { re: /\/proc\/loadavg/,       hint: 'macOS 无 /proc; 负载均值直接用 `uptime`, 或 `sysctl -n vm.loadavg`' },
  { re: /\/proc\/meminfo/,      hint: 'macOS 无 /proc; 内存用 `vm_stat` 或 `memory_pressure -l`' },
  { re: /\/proc\/cpuinfo/,      hint: 'macOS 无 /proc; CPU 用 `sysctl -n machdep.cpu.brand_string` / `hw.ncpu`' },
  { re: /\bfree\s+-[hmg]/,        hint: 'macOS 无 `free`; 内存用 `vm_stat` 或 `memory_pressure -l`' },
  { re: /\bnproc\b/,              hint: 'macOS 无 `nproc`; 核数用 `sysctl -n hw.ncpu`' },
  { re: /\b(top|htop)\s+-b/,     hint: 'macOS 的 top/htop 不支持 -b; 改用 `top -l 1 -n 10` 或 `ps aux | head`' },
  { re: /\b(uname)\s+-r\b/,      hint: 'macOS 上 `uname -r` 给内核版本, 不是发行版; 要 macOS 版本用 `sw_vers`' },
];
function darwinCommandHint(command) {
  if (process.platform !== 'darwin') return null;
  const c = String(command || '');
  const hits = DARWIN_ONLY_HINTS.filter((h) => h.re.test(c)).map((h) => h.hint);
  return hits.length ? hits : null;
}
// 把 macOS 对应写法附到 stderr 尾部 — 成功/失败两条路径都要走, 否则模型看不到提示。
function withDarwinHint(command, stderr) {
  const hints = darwinCommandHint(command);
  const err = String(stderr || '');
  if (!hints) return err;
  if (!/No such file or directory|command not found|not found/i.test(err)) return err;
  return err + '\n[盘古/macOS 提示] ' + hints.join('; ');
}

// 2026-10-09: push2.eastmoney 行情接口实测会被限流(Empty reply / other side closed),
// 而盘古原来没有任何兜底 → 模型只拿到 FETCH_FAILED, 于是转头编数据。
// 退回腾讯行情(qt.gtimg.cn, 实测同一时刻可用)。
// 格式: v_sh603230="1~内蒙新华~603230~13.30~13.02~12.95~546079~...~20261009161448~0.28~2.15~13.54~12.95~..."
async function _stockQuoteFallback(pureCode, market) {
  try {
    const sym = (market === 1 ? 'sh' : 'sz') + pureCode;
    const res = await fetch('https://qt.gtimg.cn/q=' + sym, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' },
      signal: AbortSignal.timeout(8000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = new TextDecoder('gbk').decode(buf);
    const m = text.match(/="([^"]*)"/);
    if (!m || !m[1]) return null;
    const f = m[1].split('~');
    if (f.length < 35 || !f[3]) return null;
    return {
      ok: true,
      data: {
        code: pureCode,
        market: market === 1 ? '上海' : '深圳',
        name: f[1] || pureCode,
        price: f[3],
        prev_close: f[4],
        open: f[5],
        volume: f[6],                       // 手
        timestamp: f[30] || '',
        change: f[31] || '',
        change_pct: f[32] || '',
        high: f[33] || '',
        low: f[34] || '',
        source: 'tencent-fallback',
        note: '东财主源被限流, 已自动退回腾讯行情',
      },
    };
  } catch (_) { return null; }
}

// 2026-10-09: stock_history 的腾讯兜底 (push2.eastmoney 被限流时用)。
// 格式: [日期, 开, 收, 高, 低, 成交量(手)]
async function _stockHistoryFallback(pureCode, market, days, fqt) {
  try {
    const sym = (market === 1 ? 'sh' : 'sz') + pureCode;
    const adj = fqt === 0 ? '' : (fqt === 2 ? 'hfq' : 'qfq');
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,${Math.max(days, 1) + 1},${adj || 'qfq'}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/' }, signal: AbortSignal.timeout(10000) });
    const json = await res.json();
    const node = (json && json.data && json.data[sym]) || {};
    const arr = node.qfqday || node.hfqday || node.day || [];
    if (!Array.isArray(arr) || !arr.length) return null;
    const klines = arr.slice(-days).map((r) => ({
      date: r[0], open: r[1], close: r[2], high: r[3], low: r[4], volume: Number(r[5]) || 0,
    }));
    return {
      ok: true,
      data: {
        code: pureCode, name: pureCode, count: klines.length, klines,
        source: 'tencent-fallback', note: '东财主源被限流, 已自动退回腾讯K线',
      },
    };
  } catch (_) { return null; }
}

const TOOLS = {

  // ================================================================
  // 模块级状态(缓存工具集)
  // ================================================================
  __cache_map: new Map(),
  __cache_meta: new Map(),
  __cache_ttl: 300,

  // 系统控制
  permission_check: async (ctx) => {
    const { context = {}, params = {} } = ctx;
    const { user = 'anonymous', action = params.action || 'read' } = context;
    const { check_tcc = false, tcc_type = null } = params;
    const writeActions = ['write', 'delete', 'execute', 'grant'];
 // P1-S2: 精确白名单 + 配置文件加载 (不再 includes 模糊匹配)
    let _allowedUsers = ['feng', 'root']; // 默认白名单
    try {
      const _pConf = path.join(__dirname, '..', '..', 'config', 'permission_allowlist.json');
      if (fs.existsSync(_pConf)) {
        const _list = JSON.parse(fs.readFileSync(_pConf, 'utf8'));
        if (Array.isArray(_list)) _allowedUsers = _list;
      }
    } catch (e) { /* 配置缺失走默认 */ }
    const isExactAdmin = _allowedUsers.includes(user);
    const allowed = action === 'read' || (isExactAdmin && writeActions.includes(action));
    
 // Bug#14: 可选检查 macOS TCC 权限状态
    let tccStatus = null;
    if (check_tcc && tcc_type) {
      try {
        const { execSync } = require('child_process');
        // 用 TCCUtil 查询 TCC 数据库 (macOS 10.15+)
        const tccQuery = execSync(
          'sqlite3 "/usr/bin/tccutil" 2>/dev/null || true',
          { encoding: 'utf8', timeout: 3000 }
        );
        // 降级: 尝试用 ffmpeg 探测设备可用性
        if (tcc_type === 'camera' || tcc_type === 'microphone') {
          const ff = _resolveFfmpeg();
          try {
            const probeCmd = tcc_type === 'camera'
              ? `'${ff.replace(/'/g, "'\\''")}' -f avfoundation -i '[0]' -frames:v 1 -y /tmp/.pangu_tcc_probe.png 2>&1`
              : `'${ff.replace(/'/g, "'\\''")}' -f avfoundation -i '[1]' -t 1 -y /tmp/.pangu_tcc_probe.wav 2>&1`;
            execSync(probeCmd, { encoding: 'utf8', timeout: 5000 });
            tccStatus = { type: tcc_type, granted: true };
            // Cleanup probe file
            try { require('fs').unlinkSync('/tmp/.pangu_tcc_probe.' + (tcc_type === 'camera' ? 'png' : 'wav')); } catch(_) {}
          } catch (e) {
            tccStatus = { type: tcc_type, granted: false, error: e.message.slice(0, 200) };
          }
        }
      } catch (_) {
        tccStatus = { type: tcc_type, granted: null, note: 'TCC 查询失败' };
      }
    }
    
    return { ok: true, data: { allowed, user, action, check_time: new Date().toISOString(), allowlist: _allowedUsers.length, tcc: tccStatus } };
  },

  permission_grant: async (ctx) => {
    const { context = {}, params = {} } = ctx;
    const { target = 'unknown', role = 'reader' } = params;
    return { ok: true, data: { granted: true, target, role, granted_at: new Date().toISOString() } };
  },

  // 内存系统
 // P0-1 修复 — ctx._memory 未注入, 在工具入口处按需注入
  // 不改 pangu-single.js 4 个调用点, 保持测试时可 mock ctx._memory
  memory_write: async (ctx) => {
    if (!ctx._memory) ctx._memory = require('../memory').getInstance();
    const { context = {}, params = {} } = ctx;
    const { key = params.key, value, tags = [] } = params;
    if (!key) return { ok: false, data: null, error: { code: 'NO_KEY', message: '未提供记忆键' } };
    if (ctx._memory) {
      const r = await ctx._memory.write(key, value, { tags });
      return { ok: r, data: { key, written: true, tags } };
    }
    return { ok: true, data: { key, stored: true, tags, note: 'memory module not available' } };
  },

  memory_search: async (ctx) => {
    const { context = {}, params = {} } = ctx;
    const { query = params.q, limit = 10 } = params;
    if (!query) return { ok: false, data: null, error: { code: 'NO_QUERY', message: '未提供搜索查询' } };
    // 2026-10-30 (第 173 批): 检索一律走 chunks/chunks_fts, **不再优先走 kv 表**。
    //   旧口径: ctx._memory 存在时先查 kv (LIKE on key/value), 那个表只放 key-value
    //   结构化条目, 不含文档正文 ⇒ 真正的记忆库 (chunks) 永远搜不到。
    //   实测: 迁移 openclaw 的 199KB 台账进 chunks 后, 走 kv 分支命中 0, 走 chunks 命中 30+。
    //   kv 命中作为**补充**保留 (老数据不丢), 但排在 chunks 之后。
    let db = null;
    try {
      const os = require('os');
      const path = require('path');
      const sqlite3 = require('better-sqlite3');
      const dbPath = path.join(os.homedir(), '.pangu', 'memory', 'main.sqlite');
      db = sqlite3(dbPath, { readonly: true });
      const results = [];
      const seen = new Set();
      const push = (r, how) => {
        const key = r.path + '::' + r.start_line;
        if (seen.has(key)) return;
        seen.add(key);
        results.push({ chunk_id: r.chunk_id, path: r.path, source: r.source, snippet: r.snip, matched_by: how });
      };
      // 1) FTS5 unicode61: 英文/数字快, 但**中文双字 tokenize 不好** ⇒ 中文必须靠 LIKE。
      //    而且带连字符/引号的查询 (如 "ACE-Step") 会让 MATCH 抛语法错 ⇒ 必须 try/catch 兜住,
      //    否则整个 memory_search 直接挂, 连 LIKE 兜底都走不到。
      try {
        const rows = db.prepare(
          // snippet 列号 = fts5 表自己的列序 (0=text, 1=id, 2=path ...)。
          // 写 2 会取回**文件路径**而不是内容 —— 搜索结果看着像"命中了", 但没有信息。
          `SELECT rowid AS chunk_id, path, source, start_line, snippet(chunks_fts, 0, '<<', '>>', '...', 32) AS snip` +
          ` FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT ?`
        ).all(query, limit);
        rows.forEach(r => push(r, 'fts'));
      } catch (_) { /* FTS 语法错 (连字符/引号/特殊字符) ⇒ 交给 LIKE */ }
      // 2) LIKE 兜底: 中文与含符号的关键词靠它 (FTS 命中为 0 时, 以及 FTS 抛错时)。
      const likeRows = db.prepare(
        `SELECT rowid AS chunk_id, path, source, start_line, substr(text, 1, 200) AS snip` +
        ` FROM chunks WHERE text LIKE ? LIMIT ?`
      ).all('%' + query + '%', limit);
      likeRows.forEach(r => push(r, 'like'));
      // 3) kv 表作为补充 (老 key-value 条目), 排最后, 不再抢在 chunks 前面。
      try {
        if (!ctx._memory) ctx._memory = require('../memory').getInstance();
        const kvRows = ctx._memory.search(query, { limit });
        for (const r of kvRows) {
          if (results.length >= limit) break;
          results.push({ chunk_id: r.key, path: 'kv', source: 'kv', snippet: String(r.value || '').slice(0, 200), matched_by: 'kv' });
        }
      } catch (_) { /* kv 表缺失/损坏不该影响主检索 */ }
      const source = results.length === 0
        ? 'sqlite-no-match'
        : (results.some(r => r.matched_by === 'like') ? 'sqlite-like-fallback' : 'sqlite-fts-fallback');
      return { ok: true, data: { query, results: results.slice(0, limit), source } };
    } catch (e) {
      return { ok: false, data: null, error: { code: 'MEMORY_QUERY_FAIL', message: String(e.message || e) } };
    } finally {
 // D1: try/finally 保证异常路径也关 db (防止句柄泄漏)
      if (db) { try { db.close(); } catch (_) { /* 关闭失败忽略 */ } }
    }
  },

 // Pangu 必须能读具体 chunk (用于自我进化引用)
  memory_read: async (ctx) => {
    const { params = {} } = ctx;
    const { chunk_id } = params;
    if (!chunk_id) return { ok: false, data: null, error: { code: 'NO_CHUNK_ID', message: '未提供 chunk_id' } };
    let db = null;
    try {
      const os = require('os');
      const path = require('path');
      const sqlite3 = require('better-sqlite3');
      const dbPath = path.join(os.homedir(), '.pangu', 'memory', 'main.sqlite');
      db = sqlite3(dbPath, { readonly: true });
      const row = db.prepare(`SELECT id, path, source, start_line, end_line, text FROM chunks WHERE id = ? OR rowid = ?`).get(String(chunk_id), Number(chunk_id));
      if (!row) return { ok: false, data: null, error: { code: 'NOT_FOUND', message: 'chunk 不存在' } };
      return { ok: true, data: row };
    } catch (e) {
      return { ok: false, data: null, error: { code: 'MEMORY_READ_FAIL', message: String(e.message || e) } };
    } finally {
 // D1: try/finally 保证异常路径也关 db
      if (db) { try { db.close(); } catch (_) { /* 关闭失败忽略 */ } }
    }
  },

  // 资源池
  _resource_pool: new Map(),

  resource_pool: async (ctx) => {
    const { context = {}, params = {} } = ctx;
    const { pool_name = 'default', acquire = false, release = false, resource_id } = params;
    if (!TOOLS._resource_pool.has(pool_name)) TOOLS._resource_pool.set(pool_name, { size: 0, max: 10, resources: [] });
    const pool = TOOLS._resource_pool.get(pool_name);
    if (acquire) {
      if (pool.resources.length >= pool.max) return { ok: false, data: null, error: { code: 'POOL_EXHAUSTED', message: '资源池已耗尽' } };
      const id = resource_id || `res_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      pool.resources.push({ id, acquired_at: new Date().toISOString() });
      pool.size++;
      return { ok: true, data: { pool: pool_name, acquired: id, pool_size: pool.size } };
    }
    if (release && resource_id) {
      pool.resources = pool.resources.filter(r => r.id !== resource_id);
      pool.size = pool.resources.length;
      return { ok: true, data: { pool: pool_name, released: resource_id, pool_size: pool.size } };
    }
    return { ok: true, data: { pool: pool_name, size: pool.size, max: pool.max, resources: pool.resources.map(r => r.id) } };
  },

  // ================================================================
  // 真实爻位决策工具(接 skillContext 真实数据)
  // skillContext 注入来自 server.js 六爻路由层,数据真实
  // ================================================================

  // 2026-08-02 重构 (老板拍板: 设计初衷 = 64 卦为核心, 调用 384 爻判方向):
  // 以前这些工具全是硬编码模板, yao_position 吃 skill.meta 默认值, 从不碰 64i 真数据
  /**
   * 象义(nature/keywords)与卦码(binary)的**身份说明** —— 2026-10-22 第 46 批。
   *
   * 为什么单独一个 helper: hexagram_lookup 有**三个**返回分支(列表 / 模糊匹配 / 单卦),
   * 三处都带 nature。三处各写一份说明 = 迟早只改其中一份, 漏的那条路裸着走。
   * ⇒ 一处组装, 三处引用。
   *
   * ⚠️ 标签由**调用方传进来**, helper 自己不 require:
   *   标签字面量仍然只在 modules/gua_block.js 定义一次(一处定义, 不漂);
   *   但 require 与引用发生在**渲染点里** —— 出处层守卫 P12 查的就是
   *   「渲染点函数体里有没有引用标签常量符号」。
   *   若把 require 藏在 helper 里, 渲染点函数体里就没有那个符号, 守卫会报红;
   *   而绕开守卫(比如让守卫认 helper) = 守卫变松, 迟早漏。
   *   ⇒ 宁可通过参数, 不让守卫开口子。
   */
  _xiangYiBasis: (XIANG_YI_TAG, GUACODE_TAG) => {
    return {
      nature: '卦义/象义',
      keywords: '象义关键词',
      tag: XIANG_YI_TAG,
      note: '卦名/卦德本身有典籍根(如序卦传「贲者饰也」), '
        + '但**这一串关键词是象义课程整理的归纳**, 不是逐字原文; '
        + '引用时当「整理的解读」讲, 别当典籍原句引。',
      // 卦码(binary)与文王序 id 是**两套编号**:
      //   id = 1..64 文王序; index = 0..63 二进制索引(上卦三位‖下卦三位, 乾=63 坤=0)。
      //   两者在 1..63 上完全重叠, 混用会整卦错位 —— 一律用 id。
      binary_tag: GUACODE_TAG,
      binary_note: 'binary 是 6-bit 卦码(编次+编码约定, 各本偶有出入); '
        + '卦序一律用 id(1..64 文王序), 别用 index(0..63), 混用会整卦错位。',
    };
  },

  _castGua: (ctx) => {
    try {
      const { castGua } = require('../gua_engine');
      const question = (ctx && ctx.params && (ctx.params.question || ctx.params.input)) ||
        (ctx && ctx.context && ctx.context.input) || '';
      // 工具兜底 (跟 USER_HOME_FIX 同哲学: 模型必漏传, 工具自己识别):
      // 问题语义像报数 (报/三个数/给数/数字起卦) 且含 ≥2 个数字 → 自动提取 (2026-08-03 老板拍: 数字卦是三个数)
      let numbers = ctx && ctx.params && Array.isArray(ctx.params.numbers) && ctx.params.numbers.length >= 2
        ? ctx.params.numbers.slice(0, 3).map(Number) : undefined;
      if (!numbers) {
        const text = String(question);
        const looksLikeBaoshu = /报|两个数|三个数|给.{0,4}数|数字起卦|报数/.test(text);
        const found = text.match(/\d+/g);
        if (looksLikeBaoshu && found && found.length >= 2) numbers = found.slice(0, 3).map(Number);
      }
      return castGua(question, { numbers });
    } catch (e) {
      console.warn('[gua] cast failed:', e.message);
      return null;
    }
  },
  _guaData: (gua) => gua ? {
    gua_name: gua.gua_name, gua_name_full: gua.gua_name_full, symbol: gua.symbol, binary: gua.binary,
    gua_ci: gua.gua_ci, moving_yao: gua.moving_yao, moving_yao_ci: gua.moving_yao_ci,
    // 2026-10-22 第 37 批: 动爻的爻值(9 老阳 / 6 老阴)与动静。
    //   老爻会变 ⇒ 变卦(zhi_gua)就是它阴阳翻转后的卦; 爻值只说动/静, 不说五行。
    moving_yao_value: gua.moving_yao_value, moving_yao_movement: gua.moving_yao_movement,
    zhi_gua: gua.zhi_gua, hu_gua: gua.hu_gua, zong_gua: gua.zong_gua, cuo_gua: gua.cuo_gua, ti_yong: gua.ti_yong, lunar: gua.lunar,
    wuxing: gua.wuxing, wuxing_rel: gua.wuxing_rel,
    liu_qin: gua.liu_qin, yao_name: gua.yao_name, cast_method: gua.method,
    // 2026-10-22: 京房八宫归属 (宫/宫位/世应) —— 卦层真值, 查表来的。
    jingfang: gua.jingfang,
    // 2026-10-22: 引擎层算出的「爻名/爻五行自相矛盾」判定, **别被白名单吃掉**。
    //   这份数据里 `yao_name` 和 `liu_qin` 都来自那条**曾经会错位**的链 ——
    //   引擎一旦错位, 模型看到的就是「爻名说六四、六亲却是九五的妻财」,
    //   两半自相矛盾, 而模型**没有理由怀疑**它(它以为工具给的是真的)。
    //   所以: 只在**判为矛盾时**才带上这个字段 ——
    //     正常时形状一个字都不变(不惊动任何既有消费方/测试),
    //     出事时模型看得见「这两个字段打架了, 别照着答」。
    ...(gua.yao_vector_check && gua.yao_vector_check.ok === false
      ? { yao_vector_check: gua.yao_vector_check } : {}),
    // 第 36 批: 爻位对齐判定同理 —— 且它**不依赖五行**
    //   (第 41 批纳甲补齐后两者都是 384/384, 但爻位对齐这条本来就只要爻名对齐)。
    //   64 个卦上错位一爻, 模型拿到的就是「爻名说六四、六亲却是九五的妻财」。
    ...(gua.yao_index_check && gua.yao_index_check.ok === false
      ? { yao_index_check: gua.yao_index_check } : {}),
  } : {},

  // 2026-08-02 (老板拍板: 64 卦是核心, 调用 384 爻判方向): 起卦 — 64 卦推演总入口
  gua_cast: async (ctx) => {
    const gua = TOOLS._castGua(ctx);
    if (!gua) return { ok: false, data: null, error: { code: 'CAST_FAILED', message: '起卦失败' } };
    //
    // 2026-10-23 第 66 批: **纳甲搭桥** —— 卦接干支五行, 把「什么时候串起来用」落地。
    //
    // 为什么挂在这里 (不新开工具):
    //   · combo 路 (明说要卦 + 有生辰) 本来就要调 gua_cast; 桥挂在它后面,
    //     模型起完卦**顺手**就拿到搭好的桥, 不用再想「再调什么工具」。
    //   · li 角色的工具 schema 已 8987/9000 (只剩 13 字符), 新开一个工具会当场顶穿
    //     守卫(cloud-reasoning-budget-20261016 T10)。挂在既有工具上不动预算。
    //   · 桥的两头都是**已经在生产里的真数据**: 卦=刚起的卦, 干支=账本里真排过的盘。
    //
    // 为什么干支那一头只从**账本**取 (collectCastCharts), 不从主人那句话里猜:
    //   · 账本里存的是 **sxtwl 权威四柱**(task_ledger 只收 data.pillars.pillars),
    //     模型自己写的四柱根本不记 —— 这正是「防编造」那道闸。
    //   · 主人给公历生日(1990年3月15日)时, 文本里**没有**干支, 只有排盘才有;
    //     所以正规路径是 模型调 bazi_calc → 账本记下真盘 → 桥从账本取。
    //   · 猜 = 编造盘 = 盘古最重的病。取不到就不搭 (桥缺一头时是诚实的)。
    //
    // ⚠️ **只解释, 不改行为**: 取不到盘 / 桥接抛错, 一律不影响这次起卦的返回。
    let bridge = null;
    try {
      const _nb = require('../najia_bridge.js');
      const _sid = (ctx && ctx.context && ctx.context.sessionId) || '';
      let _chart = null;
      if (_sid) {
        const _charts = require('../task_ledger.js').collectCastCharts(_sid);
        // 只认 **bazi_calc 排的盘**。
        //   账本 charts_cast 里理论上混着 gua_cast 的条目 (recordToolResult 对两个工具
        //   同一段逻辑), 只是 gua_cast 的返回恰好没有 `data.pillars.pillars` 才没记上。
        //   **不靠那个巧合** —— 一旦哪天 gua_cast 的返回多带一个 pillars, 桥就会
        //   拿卦当盘接上去, 那是最难查的一类错(数字都像, 但接错了对象)。
        //   ⇒ 显式按 tool 过滤。
        const _baziCharts = (_charts || []).filter((c) => c && c.tool === 'bazi_calc' && c.pillars);
        // 取**最近一次**排的盘 (collectCastCharts 按记录顺序返回, 取最后一个)
        if (_baziCharts.length) _chart = { pillars: _baziCharts[_baziCharts.length - 1].pillars };
      }
      if (_chart) {
        const _b = _nb.buildBridgeBlock({
          guaId: gua.gua_id,
          chart: _chart,
          movingYao: gua.moving_yao,
        });
        if (_b.ok) bridge = _b.block;
      }
    } catch (e) {
      console.warn('[tools/gua_cast] 纳甲搭桥未接上 (不影响起卦):', e.message);
    }
    if (bridge) {
      return { ok: true, data: Object.assign({}, gua, { najia_bridge: bridge }) };
    }
    return { ok: true, data: gua };
  },

  // 2026-09-17 全修: 64i 真源直接暴露 — 消化/整理/对比 64 卦任务先查这里, 不从 extracted/ 推算
  // 64卦位运算 (2026-11-24 老板拍: 64卦二进制化, 互/综/错纯位运算零幻觉)
  // 传卦名/卦id → 返回 binary + 互卦 + 综卦 + 错卦 (纯 6-bit 位运算, 不查表不推演)
  hexagram_transform: async (ctx) => {
    const p = ctx.params || {};
    const q = p.query || p.name || p.id || '';
    try {
      const idx = require('../../64i/index.js');
      const yt = require('../../64i/yao_transform.js');
      const gua = typeof q === 'number' ? idx.getHexagram(q) : idx.getHexagram(String(q));
      if (!gua) return { ok: false, error: { code: 'NOT_FOUND', message: '未找到卦: ' + q } };
      return {
        ok: true,
        data: {
          id: gua.id,
          name: gua.name,
          symbol: gua.symbol,
          binary: gua.binary,
          '互卦': yt.mutualGua(gua).name,
          '综卦': yt.converseGua(gua).name,
          '错卦': yt.opposedGua(gua).name,
        },
        source: '64i/yao_transform.js (纯位运算: 互=位1-4‖2-5, 综=NOT, 错=XOR 111111)',
      };
    } catch (e) {
      return { ok: false, error: { code: 'TRANSFORM_FAIL', message: e.message } };
    }
  },
  // 位运算推理内核 (2026-11-24 老板拍: 64卦384爻推演万物, 位运算驱动决策不查断语表)
  // 传 binary(6-bit) + 动爻位 → 5卦位串(本/之/互/综/错) + 确定性决策(进/守/固/争/避)
  // 也可传卦名, 引擎自动反查 binary; 不传动爻默认三爻。
  gua_infer: async (ctx) => {
    const p = ctx.params || {};
    try {
      const inf = require('../../64i/gua_inference');
      const h = require('../../64i/hexagrams');
      const yt = require('../../64i/yao_transitions');
      let binary = p.binary || '';
      if (!binary && (p.name || p.query)) {
        const q = p.name || p.query;
        const gua = (typeof q === 'number' || /^\d+$/.test(String(q))) ? h.getHexagram(q) : h.getHexagramByName(String(q));
        if (!gua) return { ok: false, error: { code: 'NOT_FOUND', message: '未找到卦: ' + (p.name || p.query) } };
        binary = gua.binary;
      }
      if (!binary || binary.length !== 6) return { ok: false, error: { code: 'BAD_INPUT', message: '需要 binary(6位) 或 卦名' } };
      const moving = Number.isInteger(p.moving) ? p.moving : 3;
      const r = inf.infer(binary, moving)
      if (!r.ok) return { ok: false, error: { code: 'INFER_FAIL', message: r.error } };
      const chain = p.chain !== false ? inf.chainInfer(binary, moving) : null
      // 384 爻状态转移 (哪爻动→下一态), 从独立数据层取 (2026-11-24 老板拍)
      const trans = yt.transition(binary, moving)
      // 推演校验: 模型自推结果回传 (p.claimed) → 跟内核对拍 (2026-11-24 闭环)
      const verify = p.claimed ? inf.verifyInference(binary, moving, p.claimed) : null
      return {
        ok: true,
        data: { ...r, 推演链: chain && chain.ok ? chain : null, 爻变转移: trans && trans.ok ? trans : null, 推演校验: verify },
        source: '64i/gua_inference.js (位运算推理内核 + 推演校验) + 64i/yao_transitions.js (384爻状态转移)',
      };
    } catch (e) {
      return { ok: false, error: { code: 'INFER_FAIL', message: e.message } };
    }
  },

  hexagram_lookup: async (ctx) => {
    const p = ctx.params || {};
    const query = p.query || p.name || p.id || '';
    try {
      const idx = require('../../64i/index.js');
      const jf = require('../../64i/bagua_annotations/jingfang_bagong.js');
      if (!query || query === 'list') {
        const list = idx.listHexagrams();
        // 列表也带宫位: 模型问「64 卦里属乾宫的都有哪些」时不用自己回忆京房序。
        return {
          ok: true,
          data: list.map(h => {
            const j = jf.getJingfang(h.id);
            return {
              id: h.id, name: h.name, symbol: h.symbol, nature: h.nature, elements: h.elements,
              bagong: h.bagong,
              ...(j ? { jingfang_gong: j.gong, jingfang_wei: j.wei, gong_wuxing: j.gong_wuxing } : {}),
            };
          }),
          count: list.length,
          bagong_note: jf.REPO_BAGONG_NOTE,
          // 第 46 批: 列表分支也带象义标签 —— 三个返回分支都带 nature,
          //   漏一个就有一条路裸着走。口径用**同一个函数**出, 不三处各写一份。
          //   标签字面量只在 modules/gua_block.js 定义一次; 这里 require + 引用,
          //   是为了让出处层守卫 P12 查得到「这个渲染点真的带了标签」。
          nature_basis: TOOLS._xiangYiBasis(
            require('../gua_block').XIANG_YI_TAG,
            require('../gua_block').GUACODE_TAG),
          source: '64i/hexagrams.js',
        };
      }
      const gua = typeof query === 'number' ? idx.getHexagram(query) : idx.getHexagram(String(query));
      if (!gua) {
        // 模糊匹配: 按 name 包含
        const list = idx.listHexagrams();
        const fuzzy = list.filter(h => h.name.includes(String(query)) || h.name_cn.includes(String(query)));
        return {
          ok: true,
          data: fuzzy.map(h => ({ id: h.id, name: h.name, symbol: h.symbol, nature: h.nature, elements: h.elements, gua_ci: h.gua_ci })),
          matched: fuzzy.length,
          nature_basis: TOOLS._xiangYiBasis(
            require('../gua_block').XIANG_YI_TAG,
            require('../gua_block').GUACODE_TAG),
          source: '64i/hexagrams.js',
        };
      }
      // 卦象名(xiang_name, 山火贲/震为雷) 与 卦义(nature, 贲饰) 是**两样东西** ——
      // 名字都带「象」, 最容易混。两个都得给, 不给模型就只能凭记忆补一个:
      //   2026-10-22 E2E 实测: 工具只给 nature, 模型就把「贲饰」填进了「卦象名」栏。
      //   「地天雷」那类编造也是同一个根: 该给真值的地方给了回忆, 没给的地方模型自己编。
      const data = Object.assign({}, gua, {
        xiang_name: require('../../64i/hexagrams.js').xiangNameOf(gua),
        // 2026-10-23 (第 70 批): 大象辞(象曰)首次入库 ⇒ 它随 Object.assign
        //   **自动进了 tool_result**。这跟第 46 批 `keywords` 那次是同一个形状:
        //   数据在生产里, 但模型不知道它是什么来路。
        //   大象辞的身份跟象义/卦码都不同:
        //     · 它**是**《周易》原句(不是整理品) —— 所以不能贴「非典籍原文」
        //     · 但盘古存的那一份是**三方对账定稿**, 不是任一单一底本的逐字拷贝
        //   ⇒ 用自己的标签标出来, 跟 XIANG_YI_TAG / GUACODE_TAG 分开。
        //   标在**数据旁边**(xiang_basis), 跟该文件里 najia_basis / liu_qin_note
        //   同一套路: 模型不会只读值不读口径。
        xiang_basis: {
          tag: require('../gua_block').XIANG_CI_TAG,
          field: 'xiang',
          note: '大象辞(象曰)是《周易》原文。本盘古这一份是三方交叉对账定稿: '
            + '本地《周易》原文切片(上经30卦+咸卦) / npm iching-shifa / github yijing-data '
            + '三源逐条比对, 文字层一致者取共识(54卦), 有异文者按「首句必含本卦名」'
            + '筛掉贴错卦的一源并人工裁决平票(10卦, 异文逐条登记在 provenance 台账)。'
            + '引用时按《周易》大象辞讲即可, 跟爻辞一样属典籍原句。',
        },
        // 原始 najia 字段本身也打个标记: 口径写在旁边的 note 里, 模型还是可能
        // 只看数据不看 note ⇒ 标记要**跟着数据一起走**。
        najia: Object.assign({}, gua.najia, {
          _kind: 'legacy_60_cycle_by_gua_order',
          _is_najia: false,
          _warn: '不是纳甲表, 只当「卦序→60甲子序号」用; 真纳甲见 yao_ganzhi',
        }),
        // 2026-10-22 (第 33 批): 纳甲层**改口** —— 以前这里写的是
        //   「六十四卦纳甲表, 60甲子按文王序」, 那**是假的**。
        //   64i/hexagrams.js 的 najia 字段其实是天干10循环×地支12循环的
        //   60 甲子机械序列按 id(文王序)排(乾甲子 坤乙丑 屯丙寅…)。
        //   机械证据: 同下卦组内初爻 8/8 组全不唯一 ⇒ 违反京房装卦纳甲的
        //   必要条件「初爻只由下卦决定」⇒ 结构上不可能是纳甲, 且真源无出处。
        //   模型信了这句「纳甲表」就会照着编整套六爻 —— 这才是编造的源头。
        //   现在: 口径 + 真纳甲的六爻装卦结果(装得出就给, 装不出给 null + 原因)一起出。
        najia_note: (function () {
          const NJ = require('../../64i/bagua_annotations/najia.js');
          return '⚠️ 64i/hexagrams.js 的 najia 字段**不是纳甲表**(它是 60 甲子按卦序的'
            + '机械循环, 无真源出处, 违反京房必要条件), 别当纳甲用。'
            + '真纳甲在 64i/bagua_annotations/najia.js: 8/8 八卦纳甲天干有真源; '
            + '爻级地支 8/8 卦齐全(乾、坤为本地文本真源, 震巽坎离艮兑为外部四源交叉验证) '
            + '⇒ 64 卦 384/384 爻位都装得出干支, 无缺口; '
            + '装卦规则是内三爻取下卦纳甲、外三爻取上卦纳甲, 与哪一爻动无关(动爻只翻阴阳, 不改纳支)。'
            + '若哪天真装不出, 见 yao_ganzhi.reason —— 报 null + 原因, 别自己展开。';
        })(),
        // 口径跟着数据一起给: 模型不知道「哪条是推导、哪条有出处」, 就会把推导当定论。
        najia_basis: (function () {
          const NJ = require('../../64i/bagua_annotations/najia.js');
          return NJ.NAJIA_BASIS;
        })(),
        // 六爻装卦干支 —— 装得出就给, 装不出给 null + 原因(不推算填)。
        yao_ganzhi: (function () {
          const NJ = require('../../64i/bagua_annotations/najia.js');
          const cov = NJ.getGuaNajiaCoverage(gua.id);
          if (!cov.loadable) {
            return { loadable: false, missing: cov.missing, reason: cov.reason, yao: null };
          }
          const NAMES = ['初爻', '二爻', '三爻', '四爻', '五爻', '上爻'];
          const yao = [];
          for (let p = 1; p <= 6; p++) {
            const r = NJ.getYaoGanzhi(gua.id, p);
            yao.push(r.ok
              ? {
                pos: p, name: NAMES[p - 1], ganzhi: r.ganzhi,
                tiangan: r.tiangan, dianzhi: r.dianzhi,
                wuxing: r.wuxing, yin_yang: r.yin_yang,
              }
              : { pos: p, name: NAMES[p - 1], ganzhi: null, error: r.error });
          }
          return { loadable: true, missing: [], reason: null, yao };
        })(),
        // 2026-10-22: 京房八宫归属 —— 宫/宫位/世应, 卦层真值。
        //   为什么要给: 老板问「什么时候用阴阳五行八卦, 什么时候 64卦+6爻」,
        //   模型答宫位时**本来只能凭记忆**(京房八宫序不常见), 编错的概率很高。
        //   世应是查表 + 机械推导(变爻链)出来的, 64/64 双源交叉过。
        //   应爻: 第 35 批起 8/8 行都有值(统一按隔三位), 本宫卦应三爻。
        //   口径一起给, 模型才不会再讲「本宫卦应爻缺失」那种话。
        jingfang: (function () {
          const e = jf.getJingfang(gua.id);
          if (!e) return null;
          return Object.assign({}, e, {
            shi_ying_basis: jf.SHI_YING_STATUS.ying_basis,
          });
        })(),
        // 口径: repo 的 bagong 字段是「上卦分组」, 不是京房宫 —— 别混。
        bagong_note: jf.REPO_BAGONG_NOTE,
        // 2026-10-22 (第 30 批): 逐爻六亲 + 口径。
        //   六亲原先建在**上卦五行**上(跟京房宫五行 32/64 不一致), 已切到宫五行;
        //   第 36 批起「他」侧也换成**真纳甲地支五行** ⇒ 装得出纳甲的爻位
        //   **就是京房六亲**; 装不出的爻位是 null + reason, 不许模型自己编。
        //   (第 41 批补齐八卦地支后 384/384 都装得出, 但这条机制不许删:
        //    缺口一旦再现, 它是唯一拦住「模型自己编」的东西。)
        //   口径跟着数据一起给, 模型才不会把它当传统六亲讲出去。
        liu_qin_all: (function () {
          const lq = require('../../64i/bagua_annotations/liu_qin.js');
          const arr = lq.computeLiuQinForGua(gua.id);
          if (!arr) return null;
          const NAMES = ['初爻', '二爻', '三爻', '四爻', '五爻', '上爻'];
          return arr.map((x, i) => ({
            pos: i + 1,
            name: NAMES[i],
            liu_qin: x.liuQin,
            yao_wuxing: x.yaoWuxing,
            najia_ganzhi: x.ganzhi,
            reason: x.reason,
          }));
        })(),
        liu_qin_note: require('../../64i/bagua_annotations/liu_qin.js').LIU_QIN_BASIS.note,
        liu_qin_basis: (function () {
          const b = require('../../64i/bagua_annotations/liu_qin.js').LIU_QIN_BASIS;
          return { is_jingfang: b.is_jingfang, coverage: b.coverage, other_side: b.other_side };
        })(),
        // 2026-10-22 (第 31 批): 爻辞**版本异文** + 核验状态。
        //   为什么必须跟着数据出参: 模型若不知道有异文, 会把本表那一条读法
        //   当**唯一正解**讲出去。碰到懂行的人问「这读法有出处在哪」就答不上来 ——
        //   而"看着专业却说不出出处"正是这个项目反复出现的病根。
        //   核验状态也一并给: 34 卦(下经 + 随)**没有独立原文可核**,
        //   那里 verified=false, 别让模型以为全书都校过。
        // ⚠️ 字段名**不能**叫 yao_ci —— 那已经被 hexagrams.js 的爻辞数组占了,
        //   Object.assign 会**静默覆盖**它, 现有调用方拿到的就从数组变成对象。
        //   「传错类型不抛异常, 只是安静地返回另一个东西」—— 同族病, 不重复犯。
        yao_ci_basis: (function () {
          const YCV = require('../../64i/bagua_annotations/yao_ci_variants.js');
          const variants = YCV.getGuaVariants(gua.name);
          return {
            variants: variants.map(v => ({
              yao: v.yao, kind: v.kind, this_reading: v.repo,
              other_reading: v.source, note: v.note,
            })),
            verified: YCV.isYaoCiVerified(gua.name),
            uncovered_reason: YCV.describeYaoCi(gua.name).uncovered_reason,
            basis: YCV.YAO_CI_BASIS,
          };
        })(),
        // 出处**直接给**: 2026-10-22 E2E 实测, 模型为了在答案里引用「数据源」,
        // 自己 grep 了 3 次源文件(多花 ~15 秒: 22.2s vs 6.7s) —— 工具描述里
        // 明写「不要用 exec_command grep 源文件」, 它还是去查了。
        // 缺的从来不是纪律, 是**出处本身**: 给了出处, 就不用去 grep。
        source_ref: '64i/hexagrams.js · id ' + gua.id + ' (' + gua.name + '卦)',
        // 第 46 批: 象义(nature/keywords)的**身份**跟着数据出参。
        //   为什么必须给: `data` 是 Object.assign({}, gua, …) ⇒ nature/keywords
        //   整个在 tool_result 里。模型看到「卦义 贲饰」+ 一串关键词,
        //   很容易照着当经典原文讲 —— 而**关键词组合是象义课程整理的**,
        //   不是某句话的逐字引文(卦名/卦德本身有典籍根, 整理的是这一串)。
        //   与 najia_note / yao_ci_basis 同款做法: **口径跟着数据走**,
        //   模型不必记住「哪条是推导哪条有出处」, 它只管读。
        //   ⚠️ 标签字面量只在 modules/gua_block.js 定义一次, 这里只引用 ——
        //   两处各写一份, 改一处忘一处就有一半路径悄悄没标签。
        nature_basis: TOOLS._xiangYiBasis(
          require('../gua_block').XIANG_YI_TAG,
          require('../gua_block').GUACODE_TAG),
      });
      return { ok: true, data, source: '64i/hexagrams.js' };
    } catch (e) {
      return { ok: false, error: { code: 'LOOKUP_FAILED', message: e.message } };
    }
  },

  // 2026-10-22 (老板原话「就拿八字排盘…但是这用在项目上, 加强了停顿, 走一步判断一步」):
  //   六格判局 —— 把「生彼泻克耗」从「排盘的附属」提成**通用判局内核**。
  //   原来这套内核只有一条路: bazi_calc 算完盘顺带算六格 → 于是它只能用于八字。
  //   老板要的「这用在项目上」——用在一件事/一个项目/一个决策上——盘古**没有入口**。
  //   这个工具就是那个入口。
  //
  //   分工跟 bazi_calc → wuxing_strength 一模一样:
  //     调用方(模型)只负责**取数** (列条目), 内核负责**判据** (分档/定性/停点)。
  //   模型不许自己下结论 —— 它能列, 不能判。
  //
  //   ⚠️ 判据不足时**拒绝给结论** (NO_INPUT), 不拿「六格全空」反推出「停」。
  //   这就是老板那句「挂永远没有100%」的落地: 没数据就说没数据, 不硬凑一个答案。
  // 2026-10-23 第 69 批: 风水排盘 —— 把风水门接进生产。
  //   第 68 批风水内核 1052 行做出来了, 但**没有工具 = 模型够不着**,
  //   于是那层只是「内核里很完整、模型看不见」。这一刀把它挂上入口。
  //
  // ⚠️ 三条纪律:
  //   ① **缺料不编** —— 缺出生年就不给命卦, 缺坐山就不给宅卦, 少一项那一项跳过。
  //      绝不用默认值把缺的那项「补」出来(补出来的盘是假的, 而且不报错)。
  //   ② **带身份标签** —— 风水层里混着「原文 / 课上图片 / 盘古推导」三类来源,
  //      不标的话主人问一句出处就露馅。标签字面量只在 64i/fengshui/index.js 定义一次,
  //      这里 require + 引用(出处台账 P12 守卫查的就是这个)。
  //   ③ **不给整体吉凶评级** —— 内核本来就不给, 这里也不许自己加。
  fengshui_calc: async (ctx) => {
    const p = ctx.params || {};
    try {
      const fs = require('../../64i/fengshui/index.js');

      const year = (p.year === undefined || p.year === null || p.year === '') ? undefined : Number(p.year);
      const genderRaw = p.gender === undefined ? '' : String(p.gender);
      // 性别只认「男/女」(含 male/female), 认不出就**不带** —— 命卦的男女加减完全相反,
      //   猜错等于整盘反了, 且不报错。所以认不出就不给命卦。
      let gender = null;
      if (/^(男|male|m|1|true)$/i.test(genderRaw.trim())) gender = 'm';
      else if (/^(女|female|f|0|false)$/i.test(genderRaw.trim())) gender = 'f';

      const sitting = p.sitting || p.sitting_mountain || p.sittingMountain || '';
      const houseYear = (p.house_year === undefined || p.house_year === null || p.house_year === '')
        ? undefined : Number(p.house_year);

      // 什么都没给 ⇒ 直接回缺料, 不排一个空盘。
      const hasAny = year !== undefined || gender !== null || String(sitting).trim() || houseYear !== undefined;
      if (!hasAny) {
        return {
          ok: false,
          data: null,
          error: {
            code: 'FENGSHUI_NO_INPUT',
            message: '风水排盘至少要一项: 出生年+性别(算命卦)、坐山/朝向(算宅卦)、或入伙年(算宅运)',
          },
        };
      }

      const profile = fs.fengshuiProfile({
        year: year,
        gender: gender || undefined,
        sitting: String(sitting).trim() || undefined,
        houseYear: houseYear,
      });

      const report = require('../fengshui_report.js').renderFengshuiReport(profile);

      // 「为什么这一项空着」要显式说, 不让模型自己脑补成「没有所以没关系」。
      const missing = [];
      if (year === undefined) missing.push('出生年(命卦)');
      if (year !== undefined && gender === null) missing.push('性别(命卦男女加减相反, 认不出不敢填)');
      if (!String(sitting).trim()) missing.push('坐山/朝向(宅卦与大游年盘)');
      if (houseYear === undefined) missing.push('入伙年(宅运)');

      return {
        ok: true,
        data: profile,
        report,
        missing,
        // 身份标签: 整段风水平盘是什么 + 段内哪些是解读/推导。
        //   ⚠️ 字面量只在 64i/fengshui/index.js 定义一次, 这里引用。
        tag: fs.FENGSHUI_TAG,
        interpretive_tag: fs.FENGSHUI_INTERPRETIVE_TAG,
        source: fs.FENGSHUI_SOURCE_LABEL,
      };
    } catch (e) {
      return { ok: false, data: null, error: { code: 'FENGSHUI_FAILED', message: e.message } };
    }
  },

  wuxing_judge: async (ctx) => {
    const p = ctx.params || {};
    const _ctx = ctx.context || {};
    try {
      const judgeTask = require('../../64i/bagua_annotations/task_judge.js').judgeTask;
      const r = judgeTask({
        subject: p.subject,
        resources: p.resources,
        outputs: p.outputs,
        blockers: p.blockers,
        targets: p.targets,
        peers: p.peers,
      });
      if (!r.ok) {
        return { ok: false, data: null, error: { code: r.error.code, message: r.error.message } };
      }
      // 2026-10-22 (老板「加强停顿, 走一步判断一步」· 过程侧那一半):
      //   判局原来判完就蒸发 —— 它是纯函数, 返回值只活在这一次 tool_result 里。
      //   于是「停」只对**问答案**的人有用, 对**正在干活**的盘古没用:
      //   auto-resume 在模型不接话的时刻跑, 那时看不到任何停点, 照跑不误。
      //   这里把停点落进 task checkpoint, 续跑决策 (`stop_point.js`) 才读得到。
      //
      //   ⚠️ 落盘失败**不许**让这次工具调用失败: 判局已经算出来了, 答给主人要紧;
      //   过程侧增强挂掉只降级成「这轮没停点」(行为与从前一字不差)。
      //   所以这里只记 ok/written, 不改返回值 —— 模型不需要知道这个内部细节。
      let _spWritten = false;
      try {
        // goal 从 checkpoint 里读当前那份 —— 不让模型传 goal 参数。
        // 理由同「模型只列条目, 判据由内核算」: goal 是**这一轮请求**的身份,
        // 不是模型的活儿。多一个参数就多一条「模型编一个 goal 把它算糊过去」的路。
        // 读不到 (无 session / 无 checkpoint) → 空 goal → 指纹不绑, 交给 TTL 兜底。
        let _curGoal = '';
        try {
          const _cp = _ctx.sessionId
            ? require('../task_checkpoint.js').loadTaskCheckpoint(_ctx.sessionId) : null;
          _curGoal = String((_cp && _cp.goal) || '');
        } catch (_) {}
        const _w = require('../stop_point.js').writeStopPoint(
          _ctx.sessionId, r, _curGoal);
        _spWritten = !!_w.ok;
      } catch (e) {
        console.warn('[tools/wuxing_judge] stop_point 落盘失败 (不影响本次判局):', e.message);
      }
      return {
        ok: true,
        data: r,
        // 第 46 批: 任务语义对应(meaning)的身份标签, 跟着数据出参。
        //   `r.cells[*].meaning`(助力/产出/阻力/目标/平级)与 `r.bi.meaning` 是
        //   **任务语义的对应**(老板 10-22 给的表 + 课程整合), 不是典籍断语;
        //   而 `shuxing`(生我者/我生者/克我者/我克者/同我者)是**术数名**, 有《三命通会》根。
        //   两者混在一个 tool_result 里, 不标身份模型会把 meaning 当原话引出去。
        //   ⚠️ 标签字面量只在 64i/bagua_annotations/task_judge.js 定义一次。
        //   这里 require + 引用, 是为了让出处层守卫 P12 查得到「这个渲染点真的带了标签」。
        meaning_tag: require('../../64i/bagua_annotations/task_judge.js').MEANING_TAG,
        // 明写 false: 没落盘也是**正常**状态 (无 sessionId / 磁盘故障),
        // 让排查的人一眼看出是「没落上」而不是「没这功能」。
        stop_point_written: _spWritten,
        source: require('../../64i/bagua_annotations/task_judge.js').SOURCE_LABEL,
      };
    } catch (e) {
      return { ok: false, data: null, error: { code: 'JUDGE_FAILED', message: e.message } };
    }
  },

  situation_check: async (ctx) => {
    const { context = {}, params = {} } = ctx;
    const sc = ctx.skillContext || {};
    const input = context.input || params.input || '';
    // 2026-08-02: 真起卦 — 爻位取真动爻, 不再吃 skillContext 默认值
    const _gua = TOOLS._castGua(ctx);
    const pos = _gua ? _gua.moving_yao : parseInt(sc.yao_position || 3);
    const gname = _gua ? _gua.gua_name : (sc.guaName || '');
    const gci = _gua ? _gua.gua_ci : (sc.guaCi || '');
    const yname = _gua ? _gua.yao_name : (sc.yao_name || '');
    const gwx = _gua ? _gua.wuxing : (sc.wuxing || '');
    const gbin = _gua ? _gua.binary : (sc.binary || '');

    // 从真实卦象数据构建情势分析
    const stageNames = ['初爻(潜龙)', '二爻(现)', '三爻(震荡)', '四爻(抉择)', '五爻(鼎盛)', '上爻(转衰)'];
    const stageDescs = [
      '时机未至,力量积蓄中,应静观其变',
      '机会初现,曙光出现,可谨慎试探',
      '震荡波折,多空博弈,需耐心坚守',
      '临界节点,方向待定,关键抉择时刻',
      '鼎盛时机,趋势强劲,全力以赴',
      '盛极转衰,动能衰退,警惕反转',
    ];
    const stage = stageNames[pos - 1] || '未知爻位';
    const desc = stageDescs[pos - 1] || '阶段不明';

    // 构建卦象全貌
    const hexagram = gbin ? `${gbin.slice(0, 3)}/${gbin.slice(3)}` : '';
    const wuxingPhase = {
      '金': { strength: pos <= 2 ? '弱化期' : pos <= 4 ? '持稳期' : '消退期', advice: '金主决断,审时度势' },
      '木': { strength: pos <= 2 ? '萌发期' : pos <= 4 ? '生长期' : '凋零期', advice: '木主生发,顺势而为' },
      '水': { strength: pos <= 2 ? '潜伏期' : pos <= 4 ? '流动期' : '退潮期', advice: '水主智慧,洞察先机' },
      '火': { strength: pos <= 2 ? '初燃期' : pos <= 4 ? '炽盛期' : '熄灭期', advice: '火主明辨,趋利避害' },
      '土': { strength: pos <= 2 ? '奠基期' : pos <= 4 ? '厚积期' : '转化期', advice: '土主承载,稳重求进' },
    }[gwx] || { strength: '不明', advice: '审时度势' };

    return {
      ok: true,
      data: {
        gua: TOOLS._guaData(_gua),
        summary: `【${gname || '未知'}·${yname || '未知爻'}】${stage}情势分析`,
        stage: pos,
        stage_name: stage,
        stage_description: desc,
        gua_name: gname,
        gua_ci: gci,
        wuxing: gwx,
        wuxing_phase: wuxingPhase.strength,
        wuxing_advice: wuxingPhase.advice,
        hexagram_binary: hexagram,
        signal: sc.signal || '',
        decision_hint: sc.decisionHint || '',
        input_summary: input.slice(0, 100),
        guidance: desc + ' | ' + wuxingPhase.advice,
        yao_context: {
          gua_ci: gci,
          binary: gbin,
          wuxing: gwx,
          xiang: sc.xiang || '',
          moving_yao_ci: _gua ? _gua.moving_yao_ci : '',
        },
        timestamp: new Date().toISOString(),
      },
    };
  },

  initial_assessment: async (ctx) => {
    const { skill = {} } = ctx;
    const { yao_position, yao_name, gua_name } = skill.meta || {};
    // 2026-08-02: 真起卦 — 爻位取真动爻
    const _gua = TOOLS._castGua(ctx);
    const pos = _gua ? _gua.moving_yao : parseInt(yao_position || 1);
    const gname = _gua ? _gua.gua_name : (gua_name || '');
    const yname = _gua ? _gua.yao_name : (yao_name || '');
    return {
      ok: true,
      data: {
        stage: pos,
        phase: ['初始', '初现', '震荡', '抉择', '鼎盛', '转衰'][pos - 1],
        description: `${gname}卦·${yname}阶段评估完成`,
        guidance: '初期阶段:静观其变,积蓄力量',
        gua: TOOLS._guaData(_gua),
        timestamp: new Date().toISOString(),
      },
    };
  },

  caution_signal: async (ctx) => {
    const { skill = {} } = ctx;
    const { yao_position } = skill.meta || {};
    const _gua = TOOLS._castGua(ctx);
    const pos = _gua ? _gua.moving_yao : parseInt(yao_position || 1);
    const signals = ['保持观望,不宜冒进', '谨慎试探,见机而行', '耐心坚守,不可动摇', '审时度势,果断行动', '把握机遇,全力以赴', '见好就收,警惕反转'];
    return {
      ok: true,
      data: {
        signal: 'CAUTION',
        level: pos <= 2 ? 'LOW' : pos <= 4 ? 'MEDIUM' : 'HIGH',
        recommendation: signals[pos - 1] || '谨慎行事',
        gua: TOOLS._guaData(_gua),
        timestamp: new Date().toISOString(),
      },
    };
  },

  wait_action: async (ctx) => {
    return { ok: true, data: { action: 'WAIT', message: '时机未至,继续观察,不宜采取行动', timestamp: new Date().toISOString() } };
  },

  signal_detection: async (ctx) => {
    const { context = {} } = ctx;
    const { input = '' } = context;
    return { ok: true, data: { signal: 'DETECTED', input_summary: input.slice(0, 80), confidence: 'MODERATE', note: '信号已探测,建议结合趋势判断进一步确认', timestamp: new Date().toISOString() } };
  },

  trend_judgment: async (ctx) => {
    const { skill = {} } = ctx;
    const { yao_position } = skill.meta || {};
    // 2026-08-02: 真起卦 — 趋势判定基于真动爻 + 384 爻词
    const _gua = TOOLS._castGua(ctx);
    const pos = _gua ? _gua.moving_yao : parseInt(yao_position || 3);
    const trends = ['横盘整理', '初步显现', '震荡波折', '方向待定', '趋势明确', '盛极转弱'];
    return { ok: true, data: { trend: trends[pos - 1] || '待观察', direction: pos <= 2 ? 'NEUTRAL' : pos <= 4 ? 'UNCERTAIN' : 'CONFIRMED', gua: TOOLS._guaData(_gua), timestamp: new Date().toISOString() } };
  },

  opportunity_check: async (ctx) => {
    const { skill = {} } = ctx;
    const { yao_position } = skill.meta || {};
    const _gua = TOOLS._castGua(ctx);
    const pos = _gua ? _gua.moving_yao : parseInt(yao_position || 1);
    return { ok: true, data: { opportunity: pos === 2 ? 'EMERGING' : pos === 5 ? 'OPTIMAL' : 'NOT_YET', description: pos === 2 ? '机会初现,可谨慎试探' : pos === 5 ? '最佳时机,全力把握' : '时机未成熟,继续等待', gua: TOOLS._guaData(_gua), timestamp: new Date().toISOString() } };
  },

  first_step: async (ctx) => {
    return { ok: true, data: { action: 'FIRST_STEP', message: '迈出第一步:从小处着手,谨慎验证', timestamp: new Date().toISOString() } };
  },

  patience_manager: async (ctx) => {
    const { skill = {}, context = {}, params = {} } = ctx;
    const { yao_position = 3, yao_name = '', gua_name = '' } = skill.meta || {};
    const input = context.input || params.input || '';
    const _gua = TOOLS._castGua(ctx);
    const pos = _gua ? _gua.moving_yao : parseInt(yao_position || 3);
    const gname = _gua ? _gua.gua_name : gua_name;
    const yname = _gua ? _gua.yao_name : yao_name;

    // 阶段对应策略
    const stageStrategies = {
      1: { action: 'OBSERVE', message: '潜龙勿用,时机未至,继续积蓄力量', duration: '观望等待,不急于行动' },
      2: { action: 'PROBE', message: '机会初现,可谨慎试探', duration: '小仓位试探,1-2个周期验证' },
      3: { action: 'HOLD', message: '震荡期需耐心消化,保持方向,不动摇', duration: '坚守1-3个周期,不频繁变动' },
      4: { action: 'PREPARE', message: '临界节点,做好两手准备', duration: '确认方向后再加大仓位' },
      5: { action: 'FULL_THROTTLE', message: '鼎盛时机已到,全力以赴', duration: '满仓运行,跟随趋势' },
      6: { action: 'EXIT', message: '盛极转衰,见好就收', duration: '逐步减仓,保存成果' },
    };
    const strategy = stageStrategies[pos] || stageStrategies[3];

    return {
      ok: true,
      data: {
        action: strategy.action,
        message: `【${gname}·${yname}】${strategy.message}`,
        input_summary: input.slice(0, 80),
        guidance: strategy.duration,
        stage: pos,
        stageName: ['初爻(潜)', '二爻(现)', '三爻(震荡)', '四爻(抉择)', '五爻(鼎盛)', '上爻(转衰)'][pos - 1] || '未知',
        gua: TOOLS._guaData(_gua),
        timestamp: new Date().toISOString(),
      },
    };
  },

  dilemma_resolution: async (ctx) => {
    const { context = {}, params = {} } = ctx;
    const sc = ctx.skillContext || {};
    const input = context.input || params.input || '';
    const _gua = TOOLS._castGua(ctx);
    const pos = _gua ? _gua.moving_yao : parseInt(sc.yao_position || 3);
    const gname = _gua ? _gua.gua_name : (sc.guaName || '');
    const gwx = _gua ? _gua.wuxing : (sc.wuxing || '');
    const { options = [] } = params;

    const decisionStrategies = {
      1: { strategy: 'WAIT_MORE', message: '时机未至,两难时选择观望,等待更多信息', options: ['静观其变', '收集信息', '暂不做决定'], timing: '继续等待信号' },
      2: { strategy: 'SMALL_BET', message: '机会初现,两难时可用小仓位试探', options: ['小仓位试探', '等待确认', '分批建仓'], timing: '轻仓介入' },
      3: { strategy: 'ANALYZE_STAKEHOLDERS', message: '震荡期两难:梳理利益相关方,评估各方得失', options: ['维持现状', '主动求变', '寻求第三方意见'], timing: '观望为主' },
      4: { strategy: 'DECIDE_NOW', message: '临界节点:必须做出抉择,不能再拖', options: ['果断选择A', '果断选择B', '设置触发条件'], timing: '立即决策' },
      5: { strategy: 'FULL_COMMIT', message: '鼎盛期:方向已明,全力以赴', options: ['满仓跟进', '金字塔加仓', '趋势跟踪'], timing: '全力出击' },
      6: { strategy: 'SECURE_GAINS', message: '盛极转衰:两难时优先保成果', options: ['逐步撤退', '设置止损', '落袋为安'], timing: '撤退优先' },
    };
    const ds = decisionStrategies[pos] || decisionStrategies[3];

    // 加入五行决策倾向
    const wuxingDecision = {
      '金': '宜速断,忌犹豫',
      '木': '宜布局,忌急躁',
      '水': '宜洞察,忌盲动',
      '火': '宜把握,忌迟缓',
      '土': '宜稳健,忌冒进',
    }[gwx] || '';

    return {
      ok: true,
      data: {
        strategy: ds.strategy,
        message: `【${gname || '未知'}·${pos}爻】${ds.message}`,
        wuxing_guidance: wuxingDecision,
        options_identified: options.length > 0 ? options : ds.options,
        recommendation: ds.options[0],
        timing: ds.timing,
        stage: pos,
        gua_name: gname,
        wuxing: gwx,
        gua: TOOLS._guaData(_gua),
        input_summary: input.slice(0, 80),
        timestamp: new Date().toISOString(),
      },
    };
  },

  stakeholder_check: async (ctx) => {
    const { context = {}, params = {} } = ctx;
    const sc = ctx.skillContext || {};
    const input = context.input || params.input || '';
    const _gua = TOOLS._castGua(ctx);
    const pos = _gua ? _gua.moving_yao : parseInt(sc.yao_position || 3);
    const gname = _gua ? _gua.gua_name : (sc.guaName || '');
    const gwx = _gua ? _gua.wuxing : (sc.wuxing || '');

    // 真实爻位利益方分析
    const stakeholderFrameworks = {
      1: {
        parties: ['主力资金', '散户', '空仓观望者'],
        view: '初期格局,各方均未进场',
        insight: '谁是潜在多方/空方?资金在观望什么信号?',
        strategy: '静观其变,不急于站队',
      },
      2: {
        parties: ['先知先觉者', '跟风的散户', '还未入场的大资金'],
        view: '机会初现,先头部队开始试探',
        insight: '先觉者入场逻辑是什么?跟风是否安全?',
        strategy: '谨慎跟随,控制仓位',
      },
      3: {
        parties: ['短期博弈者', '中长期资金', '套牢盘/解套盘'],
        view: '震荡博弈期,多空分歧',
        insight: '震荡区间上下沿各有哪些力量?有无新增变量?',
        strategy: '高抛低吸,不追涨杀跌',
      },
      4: {
        parties: ['决定方向的关键力量', '观望资金', '止损触发线附近的力量'],
        view: '临界抉择,多空临界对峙',
        insight: '哪个方向的力量更强?触发条件是什么?',
        strategy: '两手准备,等待确认后行动',
      },
      5: {
        parties: ['主导趋势的主力', '趋势跟随者', '伺机反向的聪明钱'],
        view: '鼎盛趋势,主力主导',
        insight: '主力意图是什么?聪明钱在观察什么信号?',
        strategy: '顺势而为,但保持警惕',
      },
      6: {
        parties: ['高位减仓的主力', '接盘散户', '做空力量'],
        view: '盛极转衰,高位派发',
        insight: '主力是否在撤退?谁在接盘?谁在做空?',
        strategy: '逐步撤退,不可恋战',
      },
    };
    const fw = stakeholderFrameworks[pos] || stakeholderFrameworks[3];

    // 真实卦象加入分析
    const wuxingAdvantage = {
      '金': '决策力强,适合快进快出',
      '木': '生发之力,适合布局长线',
      '水': '流动智慧,适合灵活应变',
      '火': '明辨之势,适合把握热点',
      '土': '承载之德,适合稳健持有',
    }[gwx] || '';

    return {
      ok: true,
      data: {
        parties: fw.parties,
        framework_view: `【${gname || '未知'}·${pos}爻】${fw.view}`,
        insight: fw.insight,
        wuxing_benefit: wuxingAdvantage,
        strategy: fw.strategy,
        stage: pos,
        gua_name: gname,
        wuxing: gwx,
        gua: TOOLS._guaData(_gua),
        signal: sc.signal || '',
        input_summary: input.slice(0, 80),
        timestamp: new Date().toISOString(),
      },
    };
  },

  steady_action: async (ctx) => {
    const { skill = {}, context = {}, params = {} } = ctx;
    const { yao_position = 3, yao_name = '', gua_name = '' } = skill.meta || {};
    const _gua = TOOLS._castGua(ctx);
    const pos = _gua ? _gua.moving_yao : parseInt(yao_position || 3);
    const gname = _gua ? _gua.gua_name : gua_name;
    const yname = _gua ? _gua.yao_name : yao_name;

    const actionStrategies = {
      1: { action: 'HOLD', intensity: '极轻仓', message: '潜龙勿用,静观其变', guidance: '保持轻仓/空仓,积蓄力量,等待信号' },
      2: { action: 'SMALL_ENTRY', intensity: '试探仓', message: '谨慎试探,验证判断', guidance: '用小仓位验证方向,方向确认后再加仓' },
      3: { action: 'STEADY_HOLD', intensity: '标准仓', message: '稳健持有,耐心坚守', guidance: '维持现有仓位,不频繁操作,耐心等待突破' },
      4: { action: 'INCREASE_ON_CONFIRM', intensity: '加仓', message: '确认方向,稳步加仓', guidance: '方向确认后分批加仓,设好止损' },
      5: { action: 'FULL_POSITION', intensity: '满仓', message: '鼎盛时机,全力以赴', guidance: '满仓运行,趋势不破坏不退出' },
      6: { action: 'GRADUAL_EXIT', intensity: '轻仓', message: '盛极转衰,逐步撤退', guidance: '分批减仓,保存成果,不可恋战' },
    };
    const as = actionStrategies[pos] || actionStrategies[3];

    return {
      ok: true,
      data: {
        action: as.action,
        intensity: as.intensity,
        message: `【${gname}·${yname}】${as.message}`,
        guidance: as.guidance,
        stage: pos,
        gua: TOOLS._guaData(_gua),
        timestamp: new Date().toISOString(),
      },
    };
  },

  critical_point_analysis: async (ctx) => {
    const { yao_position } = ctx.skill?.meta || {};
    // 2026-08-02: 真起卦 — 临界点判定基于真动爻 (四爻 = 真临界)
    const _gua = TOOLS._castGua(ctx);
    const pos = _gua ? _gua.moving_yao : parseInt(yao_position || 4);
    return { ok: true, data: { point: 'CRITICAL_NODE', stage: '临界点', description: pos === 4 ? '关键抉择节点:上或下的临界状态' : '已过临界点', recommendation: '做好两手准备,设置触发条件', gua: TOOLS._guaData(_gua), timestamp: new Date().toISOString() } };
  },

  breakthrough_check: async (ctx) => {
    return { ok: true, data: { breakthrough: 'POSSIBLE', conditions: ['方向已明确', '资源已就位', '时机已成熟'], recommendation: '检查突破条件是否满足,若已满足则果断行动', timestamp: new Date().toISOString() } };
  },

  direction_decision: async (ctx) => {
    return { ok: true, data: { decision: 'DIRECTION_CONFIRMED', message: '方向已明确:选定方向,坚定执行', timestamp: new Date().toISOString() } };
  },

  risk_assessment: async (ctx) => {
    const { yao_position } = ctx.skill?.meta || {};
    // 2026-08-02: 真起卦 — 风险等级基于真动爻位置 (高位 = 真高风险)
    const _gua = TOOLS._castGua(ctx);
    const pos = _gua ? _gua.moving_yao : parseInt(yao_position || 1);
    const levels = ['极低', '低', '中', '高', '极高', '极高'];
    return { ok: true, data: { risk_level: levels[pos - 1] || '中', recommendation: pos >= 5 ? '高位风险加剧,建议做好止损准备' : '风险可控,继续观察', gua: TOOLS._guaData(_gua), timestamp: new Date().toISOString() } };
  },

  momentum_assessment: async (ctx) => {
    const { yao_position } = ctx.skill?.meta || {};
    // 2026-08-02: 真起卦 — 动能判定基于真动爻
    const _gua = TOOLS._castGua(ctx);
    const pos = _gua ? _gua.moving_yao : parseInt(yao_position || 3);
    return { ok: true, data: { momentum: pos === 5 ? 'PEAKING' : pos === 6 ? 'WEAKENING' : 'BUILDING', description: pos === 5 ? '动能鼎盛,趋势强劲' : pos === 6 ? '动能衰退,注意转向' : '动能积累中', gua: TOOLS._guaData(_gua), timestamp: new Date().toISOString() } };
  },

  main_force_analysis: async (ctx) => {
    return { ok: true, data: { main_force: 'IDENTIFIED', description: '主力/核心力量已明确,正主导局势', recommendation: '顺势而为,跟随主导力量', timestamp: new Date().toISOString() } };
  },

  peak_judgment: async (ctx) => {
    const { yao_position } = ctx.skill?.meta || {};
    const _gua = TOOLS._castGua(ctx);
    const pos = _gua ? _gua.moving_yao : parseInt(yao_position || 5);
    return { ok: true, data: { peak_status: pos === 5 ? 'AT_PEAK' : pos === 6 ? 'PASSED_PEAK' : 'NOT_AT_PEAK', description: pos === 5 ? '正处于鼎盛极点' : pos === 6 ? '已过极点,盛极转衰' : '尚未到达极点', gua: TOOLS._guaData(_gua), timestamp: new Date().toISOString() } };
  },

  full_deployment: async (ctx) => {
    return { ok: true, data: { action: 'FULL_DEPLOYMENT', message: '全力部署:把握鼎盛时机,调动全部资源', caution: '注意留有余地,不可孤注一掷', timestamp: new Date().toISOString() } };
  },

  peak_detection: async (ctx) => {
    const { yao_position } = ctx.skill?.meta || {};
    const _gua = TOOLS._castGua(ctx);
    const pos = _gua ? _gua.moving_yao : parseInt(yao_position || 6);
    return { ok: true, data: { detection: 'PEAK_DETECTED', status: pos >= 5 ? 'AT_OR_NEAR_PEAK' : 'NOT_AT_PEAK', gua: TOOLS._guaData(_gua), timestamp: new Date().toISOString() } };
  },

  reversal_signal: async (ctx) => {
    return { ok: true, data: { signal: 'REVERSAL_WARNING', message: '反转信号已出现:盛极转衰,注意撤退时机', urgency: 'HIGH', timestamp: new Date().toISOString() } };
  },

  withdrawal_plan: async (ctx) => {
    return { ok: true, data: { action: 'WITHDRAW', message: '制定撤退计划:分批退出,保存成果', steps: ['评估退出时机', '确定退出比例', '执行并复盘'], timestamp: new Date().toISOString() } };
  },

  graceful_exit: async (ctx) => {
    return { ok: true, data: { action: 'GRACEFUL_EXIT', message: '体面退出:完成本阶段使命,优雅转身', guidance: '不是失败,是阶段性完成', timestamp: new Date().toISOString() } };
  },

  // ================================================================
  // 真正可执行的工具(接系统能力)
  // ================================================================

  /**
   * exec_command - 执行 Shell/Git 命令
   * ctx.params.cmd: 命令字符串
   * ctx.params.timeout: 超时 ms(默认 30000)
   */
 // 借鉴 #1 (ClaudeCode Leaked BashTool _simulatedSedEdit):
  // 内部 computed field - 模型看不到, Pangu ORM 可注入 (路由建议 / hook 结果)
  // 借鉴来源: A §9.1 (BashTool.tsx:223-260 + toolExecution.ts:735-755)
  exec_command: async (ctx) => {
    // 2026-10-28 第 129 批: 批命做题题不许拿外网调研绕路 (口径真源 modules/bazi_items.js)。
    const _itemScopeGuard = _baziItemScopeGuard('exec_command', ctx);
    if (_itemScopeGuard) return _itemScopeGuard;
    const params = _normalizeToolParams(ctx && ctx.params);
    const { cmd, command, timeout = 30000, _panguRoute, _panguHookRes } = params;
 // 借鉴 #1: defense-in-depth - 模型不能传 _panguRoute, strip 一次
    delete params._panguRoute;
    delete params._panguHookRes;
 // 借鉴 #3: 异步后台标志 (LLM 传 run_in_background: true 时立即返 task_id, 不阻塞主 turn)
    const runInBackground = params.run_in_background === true;
    const finalCmd = cmd || command;
    if (!finalCmd) return { ok: false, data: null, error: { code: 'NO_CMD', message: '未提供命令' } };
 // 借鉴 #1: _panguRoute 内部用 (e.g. Pangu 决定是否路由到 read_file/write_file)
    if (_panguRoute && typeof _panguRoute === 'string') {
      console.log('[exec_command] _panguRoute hint:', _panguRoute, '(stripped, not in model view)');
    }
    // 危险命令黑名单校验(去空格后检测)
    const normalized = finalCmd.replace(/\s+/g, ' ').trim().toLowerCase();
 // P0 扩展: 覆盖 base64|sh, eval, nohup, sh -c, bash -c 等
    const _panguExtDangerousPatterns = [
      /\beval\b/,                    // eval 任意代码
      /\bbash\s+-c\b/,              // bash -c 'cmd'
      /\bsh\s+-c\b/,                // sh -c 'cmd'
      /\bnohup\b/,                   // 后台脱钩
      /\bdisown\b/,                  // 后台脱钩
      /\bbase64\s+.*\|\s*(sh|bash)/, // base64 解码后跑
      /\bpython\s+-c\b/,            // python -c 'code'
      /\bperl\s+-e\b/,              // perl -e 'code'
      /\bnode\s+-e\b/,              // node -e 'code'
      /\bosascript\s+-e\b/,          // macOS AppleScript 任意执行
    ];
    const dangerous = [
      /^rm\s+-rf\s+\//, /^sudo\s+rm\s+-rf/, /dd\s+if=/, /mkfs/, /:\(\)\{.*\|.*&;:/,
      /chmod\s+-r?\s+777\s+\//, />\s*\/dev\/sda/, /shutdown|init\s+[06]/,
      /curl\s+.*\|\s*sh/, /wget\s+.*\|\s*sh/, /python\s+.*\|\s*sh/,
      ..._panguExtDangerousPatterns,
    ];
 // P0: cwd 必须命中白名单
    const _panguAllowedCwds = [
      path.join(os.homedir(), '.pangu'),  // Pangu 工作目录
      path.join(os.homedir(), 'Documents'),
      path.join(os.homedir(), 'Desktop'),  // Bug#20 + H9: 适配任意用户
      path.join(os.homedir(), 'Desktop'),  // H9 修: 不再硬编码某台机器的家目录
      path.join(os.homedir(), 'Applications'),  // H9 修: 不再硬编码某台机器的家目录
      '/tmp',
      '/private/tmp',
    ];
    // 2026-08-02 修: cwd/workdir 必须展开 ~ — 模型传 workdir:"~/pangu" 时
    // spawn 的 cwd 不存在 → "spawn /bin/sh ENOENT" (老板实证: exec_command 全部 ENOENT 假死)
    // 2026-08-02 根治 (老板 RTF 实证): 默认 cwd 用仓库根 (~/pangu), 不是 process.cwd() —
    // daemon 从 apps/core 起, process.cwd() = apps/core/, LLM 写 "ls apps/core/modules/..." 必双重套娃失败
    // → 连环幻觉 "沙箱关了/文件不存在" (盘古 11:24 实录)。仓库根 = LLM 心智模型的默认锚点。
    const _repoRoot = REPO_ROOT;
    const _panguCwd = TOOLS._expandHome(params.cwd || params.workdir || _repoRoot);
    const _panguCwdOk = process.env.PANGU_SANDBOX !== 'on' || _panguAllowedCwds.some(p => _panguCwd === p || _panguCwd.startsWith(p + '/'));
    if (!_panguCwdOk) {
      return { ok: false, error: { code: 'CWD_NOT_ALLOWED', message: 'cwd 不在白名单: ' + _panguCwd + ' (允许: ' + _panguAllowedCwds.join(', ') + ')' } };
    }
    // 2026-08-02 修: 模型传了不存在的 cwd → spawn /bin/sh ENOENT 假死; 回退 daemon cwd 并告知
    let _effectiveCwd = _panguCwd;
    try { require('fs').accessSync(_effectiveCwd); } catch (_) {
      _effectiveCwd = _repoRoot;
      console.warn('[exec_command] cwd 不存在:', _panguCwd, '→ 回退', _effectiveCwd);
    }
    // exec_command 同时调 sandbox.isDangerousCommand, 拦截 Python 子进程模式 (os.system / subprocess.run / shutil.rmtree 等)
    // 自有 dangerous regex (shell + python -c) 保留作冗余
    const sandbox = process.env.PANGU_SANDBOX === 'on' ? require('../sandbox') : null;
    if (sandbox && typeof sandbox.isDangerousCommand === 'function' && sandbox.isDangerousCommand(finalCmd)) {
      return { ok: false, error: { code: 'FORBIDDEN_CMD', message: '禁止执行危险命令 (sandbox 拦截, 含 Python 子进程): ' + finalCmd.slice(0, 50) } };
    }
    for (const pattern of (process.env.PANGU_SANDBOX === 'on' ? dangerous : [])) {
      if (pattern.test(normalized)) {
        return { ok: false, error: { code: 'FORBIDDEN_CMD', message: '禁止执行危险命令: ' + finalCmd.slice(0, 50) } };
      }
    }
 // 借鉴 #3: 异步后台路径 - 立即返 task_id, LLM 下次轮询 task_output
    if (runInBackground) {
      const kick = taskOutput.startTask({
        command: finalCmd,
        commandName: finalCmd.slice(0, 60),
        toolName: 'exec_command',
        cwd: _effectiveCwd,
        timeoutMs: typeof timeout === 'string' ? parseInt(timeout, 10) : timeout,
        meta: { original_tool: 'exec_command' },
      });
      return {
        ok: true,
        data: {
          task_id: kick.task_id,
          status: kick.status,
          progress_message: kick.progressMessage,
          run_in_background: true,
          message: '任务已在后台启动, LLM 下次轮询用 task_output(task_id="' + kick.task_id + '") 取结果',
          next_tool_hint: 'task_output',
          next_tool_args_hint: { task_id: kick.task_id, block: true, wait: true, wait_timeout: 30000 },
          timestamp: new Date().toISOString(),
        },
      };
    }
    try {
      const { exec, execFile } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      const trimmed = finalCmd.trim();

 // 根本修: 默认用 execFile 直接执行命令,继承 Node 进程的 TCC 权限。
      // 只有命令包含 shell 元字符(管道/重定向/逻辑组合/通配符/反引号/变量替换等)时才走 /bin/sh,
      // 避免 macOS TCC 把需要屏幕录制/辅助功能等权限的命令误判为 Terminal/shell 子进程。
      const shellMetachars = /[|&;<>()`$\\*?{}\[\]\n\r'"]/;
      if (!shellMetachars.test(trimmed)) {
        const parts = trimmed.split(/\s+/).filter(Boolean);
        if (parts.length > 0) {
          // 优先在 PATH 中解析命令
          let bin = parts[0];
          if (bin.includes('/') || process.platform === 'win32') {
            bin = path.resolve(_effectiveCwd, bin);
          } else if (process.platform !== 'win32') {
            // Unix: 尝试常见路径 + PATH
            const pathDirs = (process.env.PATH || '').split(':').concat(['/usr/bin', '/usr/sbin', '/bin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin']);
            for (const d of pathDirs) {
              const full = path.join(d, bin);
              if (fs.existsSync(full)) { bin = full; break; }
            }
          }
          const args = parts.slice(1);
          try {
            const out = await promisify(execFile)(bin, args, {
              cwd: _effectiveCwd,  // 2026-08-02: 统一走展开/回退后的 cwd (之前算 _effectiveCwd 却不用, 默认还掉 apps/core 套娃)
              timeout,
              env: process.env,
            });
            return {
              ok: true,
              data: {
                cmd: finalCmd,
                stdout: _spillOutput(out.stdout, 4096, 'stdout'),
                stderr: _spillOutput(out.stderr, 1024, 'stderr'),
                exit: 0,
                timestamp: new Date().toISOString(),
              },
            };
          } catch (execErr) {
            // TCC 权限 handoff: 把命令 delegate 到用户 Aqua GUI session
            // (那里 Terminal.app 有 Screen Recording / Camera 权限)
            // 触发条件: execFile 报 EACCES/EPERM/permission, 或命令是已知 TCC 二进制 (screencapture)
            const errMsg = ((execErr && execErr.message) || '') + ' ' + ((execErr && execErr.stderr) || '');
            const isTCCFail = /EACCES|EPERM|not permitted|Operation not permitted|denied/i.test(errMsg);
            const tccBin = new Set(['screencapture']);
            const firstToken = trimmed.split(/\s+/)[0] || '';
            const firstBase = firstToken.replace(/^.*\//, '');
            const needHandoff = isTCCFail || tccBin.has(firstBase);

            if (needHandoff) {
              // launchctl asuser UID cmd (走用户 Aqua session, 继承 Terminal TCC)
              try {
                const uidOut = execCb('id -u', { shell: '/bin/sh' });
                const uid = String(uidOut || '').trim();
                const esc1 = finalCmd.replace(/'/g, `'\\''`);
                const h1 = `launchctl asuser ${uid} ${esc1}`;
                const out1 = await execAsync(h1, { timeout, cwd: _effectiveCwd, shell: '/bin/sh' });
                return {
                  ok: true,
                  data: {
                    cmd: finalCmd,
                    stdout: _spillOutput(out1.stdout, 4096, 'stdout'),
                    stderr: _spillOutput(out1.stderr, 1024, 'stderr'),
                    exit: 0,
                    tcc_handoff: 'launchctl_asuser',
                    timestamp: new Date().toISOString(),
                  },
                };
              } catch (_) {
                // launchctl asuser 失败: 落回下方 shell fallback
              }
            }
            // execFile 失败时回退到 shell 执行(兼容相对路径/内置 shell 命令等)
            // 继续走下方 shell 路径
          }
        }
      }

 // 改: 跨平台 shell 选择
      // Mac/Linux: bash → sh (sh 是 POSIX 标准, 跨 Mac/Linux 都存在)
      // Windows: cmd.exe
      const shell = process.platform === 'win32'
        ? (process.env.ComSpec || 'cmd.exe')
        : '/bin/sh';
 // 根治: shell 兜底时 PATH 也要补 /usr/sbin 等 launchd 缺的路径
      const augmentedEnv = process.platform === 'win32'
        ? process.env
        : Object.assign({}, process.env, {
            PATH: (process.env.PATH || '') + ':/usr/sbin:/sbin:/opt/homebrew/sbin:/usr/local/sbin',
          });
      const { stdout, stderr } = await execAsync(finalCmd, { timeout, cwd: _effectiveCwd, shell, env: augmentedEnv });
      const _stderrOut = withDarwinHint(finalCmd, stderr);
      return {
        ok: true,
        data: {
          cmd: finalCmd,
          stdout: _spillOutput(stdout, 4096, 'stdout'),
          stderr: _spillOutput(_stderrOut, 1024, 'stderr'),
          exit: 0,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (err) {
      return {
        ok: false,
        data: {
          cmd: finalCmd,
          stdout: err.stdout ? _spillOutput(err.stdout, 4096, 'stdout') : '',
          stderr: err.stderr ? _spillOutput(withDarwinHint(finalCmd, err.stderr), 1024, 'stderr') : '',
          exit: err.code || 1,
          error: err.message,
          timestamp: new Date().toISOString(),
        },
      };
    }
  },

  // 2026-08-01: LLM 爱传 ~/.pangu 这种路径, Node fs 不展开 ~ → ENOENT 假错误
  // (实证: list_directory('~/.pangu') ENOENT 触发 self_correct → PLAN_FAILED 死锁)
  // 2026-08-03: LLM 把主机名当用户名, 全程写 /Users/<hostname>/... → 全 ENOENT
  // (实证: 老板 8/3 下午自我迭代任务, file_edit 全失败, 文本却报"已改完" — 模型必犯的错, 工具兜底+告知)
  // 规则: /Users/<seg>/... 且 seg ≠ 真实用户名 且 /Users/<seg> 不存在 → 改写到真实 homedir
  // (/Users/Shared 等真实存在的目录不动; 改写后 tool_result.path 与入参不同, LLM 可见差异)
  _expandHome: (p) => {
    if (typeof p !== 'string') return p;
    const os = require('os');
    let out = (p === '~' || p.startsWith('~/')) ? require('path').join(os.homedir(), p.slice(1)) : p;
    // 跨平台 (老板拍: 到其他电脑也要能解决): mac /Users/<x>, linux /home/<x>, win X:\Users\<x>
    // 统一判据: 拼出的 home 根 (前缀+用户名段) 不存在 → 改写真实 homedir
    // 同时覆盖两种幻觉: ①假用户名 (/Users/<hostname>) ②错平台前缀 (mac 上 /home/<name>, linux 上 /Users/<name>)
    // 真实存在的他人 home (如 /Users/Shared) 不动
    const m = out.match(/^(\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/])([^/\\]+)(.*)$/);
    if (m && !require('fs').existsSync(m[1] + m[2])) {
      const fixed = os.homedir() + (m[3] || '');
      console.warn(`[tools] USER_HOME_FIX: ${out} → ${fixed} (home 根 ${m[1] + m[2]} 不存在, 已自动纠正)`);
      out = fixed;
    }
    return out;
  },

  /**
   * read_file - 读取文件内容
   * ctx.params.path: 文件路径
   * ctx.params.offset: 起始行(默认 1；兼容 schema/旧模型传入的 0，按第 1 行读取)
   * ctx.params.limit: 最大行数(默认 500 — 2026-09-12 从 100 提高: 老板实案 372 行资料
   *   要 4 次调用才读完, 3 轮轮次预算全烧在翻页上, 读到一半就被 maxRounds 切)
   */
  read_file: async (ctx) => {
    const params = _normalizeToolParams(ctx && ctx.params);
    const { offset: requestedOffset = 1, limit = 500 } = params;
    // The public schema historically described offset as zero-based while the
    // implementation and existing callers use one-based line numbers. Keep
    // the established one-based contract, but make offset=0 mean the first
    // line instead of slicing from -1 (which commonly returns an empty tail
    // line for files ending in a newline).
    const parsedOffset = Number(requestedOffset);
    const offset = Number.isFinite(parsedOffset) ? Math.max(1, Math.floor(parsedOffset)) : 1;
    let filePath = TOOLS._expandHome(params.path);
    // 2026-08-02: 相对路径锚仓库根 (原先隐式锚 process.cwd()=apps/core → 相对路径双重套娃)
    if (filePath && !path.isAbsolute(filePath)) filePath = path.join(REPO_ROOT, filePath);
    if (!filePath) return { ok: false, data: null, error: { code: 'NO_PATH', message: '未提供文件路径' } };
 // P0-4 修: 先检查存在, 再 realpath (realpathSync 不存在会抛 ENOENT)
    const fs = require('fs');
    if (!fs.existsSync(filePath)) {
      return { ok: false, data: null, error: { code: 'NOT_FOUND', message: `文件不存在: ${filePath}` } };
    }
    let real;
    try {
      real = fs.realpathSync(path.resolve(filePath));
    } catch (e) {
      return { ok: false, data: null, error: { code: 'REALPATH_FAILED', message: e.message } };
    }
    if (blocked.some(b => real.startsWith(b))) {
      return { ok: false, data: null, error: { code: 'PATH_FORBIDDEN', message: '禁止访问该路径' } };
    }
    try {
      const content = require('fs').readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      const total = lines.length;
      // 2026-08-02 修 (老板实证: 模型 offset=600 读 310 行的文件, 拿到空内容以为文件是空的, 浪费 2 轮重读):
      // offset 超末尾时 ok:true + 空 content 是误导 — 改明确报错并告知真实行数
      if (offset > total) {
        return { ok: false, data: { path: filePath, total_lines: total }, error: { code: 'OFFSET_OUT_OF_RANGE', message: `offset ${offset} 超出文件末尾 (文件共 ${total} 行) — 请用 offset=1 重读, 或分段读 (每次 offset 不超过 ${total})` } };
      }
      const slice = lines.slice(offset - 1, offset - 1 + limit).join('\n');
      return {
        ok: true,
        data: { path: filePath, total_lines: total, offset, limit, content: slice, timestamp: new Date().toISOString() },
      };
    } catch (err) {
      return { ok: false, data: null, error: { code: 'READ_ERROR', message: err.message } };
    }
  },

  /**
   * write_file - 写入文件
   * ctx.params.path: 文件路径
   * ctx.params.content: 文件内容
   * ctx.params.append: 是否追加(默认 false,覆盖)
   */
  write_file: async (ctx) => {
    const { params = {} } = ctx;
    const { content, append = false } = params;
    let filePath = TOOLS._expandHome(params.path);
    if (filePath && !path.isAbsolute(filePath)) filePath = path.join(REPO_ROOT, filePath);  // 2026-08-02: 相对路径锚仓库根
    if (!filePath) return { ok: false, data: null, error: { code: 'NO_PATH', message: '未提供文件路径' } };
    if (content === undefined) return { ok: false, data: null, error: { code: 'NO_CONTENT', message: '未提供文件内容' } };
    // 安全校验:禁止写入敏感路径和系统目录(realpath解析符号链接,防止 ../ 绕过)
    const real = (() => { try { return require('fs').realpathSync(path.resolve(filePath)); } catch { return path.resolve(filePath); } })();
    if (blocked.some(b => real.startsWith(b))) {
      return { ok: false, data: null, error: { code: 'PATH_FORBIDDEN', message: '禁止写入该路径' } };
    }
    try {
      const fs = require('fs');
      const flag = append ? 'a' : 'w';
      fs.writeFileSync(filePath, content, { flag, encoding: 'utf8' });
      return { ok: true, data: { path: filePath, bytes: Buffer.byteLength(content, 'utf8'), append, timestamp: new Date().toISOString() } };
    } catch (err) {
      return { ok: false, data: null, error: { code: 'WRITE_ERROR', message: err.message } };
    }
  },

  /**
   * list_directory - 列出目录内容
   * ctx.params.path: 目录路径(默认 .)
   * ctx.params.depth: 深度(默认 1,只当前目录)
   */
  list_directory: async (ctx) => {
    const { params = {} } = ctx;
    const { depth = 1 } = params;
    const dirPath = TOOLS._expandHome(params.path || '.');
    try {
      const fs = require('fs');
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items = entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        path: path.join(dirPath, e.name),
      }));
      return { ok: true, data: { path: dirPath, items, count: items.length, timestamp: new Date().toISOString() } };
    } catch (err) {
      return { ok: false, data: null, error: { code: 'LIST_ERROR', message: err.message } };
    }
  },

  // ---- 联网搜索(SearXNG + 国内 fallback)----
  web_search: async (ctx) => {
    // 2026-10-28 第 129 批: 同上 —— 批命做题题不许为「出生地周围情况」上网查时代统计。
    const _itemScopeGuard = _baziItemScopeGuard('web_search', ctx);
    if (_itemScopeGuard) return _itemScopeGuard;
    const { params = {} } = ctx;
    // 2026-10-09 (老板实测: "本轮网上检索未执行成功, 原因是未传搜索关键词 query"):
    // schema 告诉模型参数叫 q, 这里原来只读 query → 模型永远按 schema 传 q → 永远拿不到搜索词,
    // 也就是说 web_search 从来没有真正成功过一次。两个名字都收, 以 schema 的 q 为主。
    const query = params.q || params.query || params.keyword || '';
    const { count, categories, language, baseUrl } = params;
    if (!query) return { ok: false, error: { code: 'NO_QUERY', message: '未提供搜索关键词query' } };
    // 1) 优先 SearXNG (老板自己跑的实例)
    if (baseUrl) {
      try {
        const loader = require(path.join(__dirname, 'web_search_loader.js'));
        const result = await loader.webSearch({ query, count, categories, language, baseUrl });
        if (result && result.length > 0) return { ok: true, data: { engine: 'searxng', results: result } };
      } catch (_) { /* fallthrough */ }
    }
    // 2) fallback: 国内 Bing HTML scrape (无 SearXNG 时用)
    try {
      const loader = require(path.join(__dirname, 'web_search_loader.js'));
      const result = await loader.bingSearch({ query, count: count || 5 });
      return { ok: true, data: { engine: 'bing-cn-fallback', results: result } };
    } catch (e) {
      return { ok: false, error: { code: 'SEARCH_ERROR', message: e.message } };
    }
  },

  web_fetch: async (ctx) => {
    // 2026-10-28 第 129 批: 同上 (子 agent 那 6 次 30 秒超时就是从这儿烧掉的)。
    const _itemScopeGuard = _baziItemScopeGuard('web_fetch', ctx);
    if (_itemScopeGuard) return _itemScopeGuard;
    const { params = {} } = ctx;
    const { url, maxChars = 30000, extract = 'text' } = params;
    if (!url) return { ok: false, error: { code: 'NO_URL', message: '未提供url参数' } };
    const lib = url.startsWith('https') ? require('https') : require('http');
    const zlib = require('zlib');
    const httpFetch = (urlStr, hops = 0) => new Promise((resolve) => {
      if (hops > 5) return resolve({ ok: false, error: { code: 'TOO_MANY_REDIRECTS', message: '>5 hops' } });
      const req = lib.get(urlStr, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate',
        },
        timeout: 15000,
      }, (res) => {
        // redirect
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, urlStr).toString();
          return resolve(httpFetch(next, hops + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return resolve({ ok: false, error: { code: 'HTTP_' + res.statusCode, message: 'HTTP ' + res.statusCode } });
        }
        const chunks = [];
        let size = 0;
        const MAX = (maxChars || 30000) * 8; // 留 gzip 膨胀余量
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX) { res.destroy(); }
          else chunks.push(c);
        });
        res.on('end', () => {
          try {
            let buf = Buffer.concat(chunks);
            // gzip / deflate 解压
            const enc = res.headers['content-encoding'];
            if (enc === 'gzip') { try { buf = zlib.gunzipSync(buf); } catch (_) {} }
            else if (enc === 'deflate') { try { buf = zlib.inflateSync(buf); } catch (_) {} }
            // charset
            const ct = res.headers['content-type'] || '';
            const charsetMatch = ct.match(/charset=([^;\s]+)/i);
            const charset = (charsetMatch && charsetMatch[1]) || 'utf-8';
            let html = buf.toString(charset.toLowerCase() === 'gbk' || charset.toLowerCase() === 'gb2312' ? 'utf-8' : 'utf-8');
            // 简单 charset 探测: 检测 gb2312 bytes 比例
            if (charset.toLowerCase().includes('gb')) {
              try { html = require('iconv-lite').decode(buf, 'gbk'); } catch (_) { /* iconv-lite 未装, 退化 */ }
            }
            // HTML → text
            let content;
            if (extract === 'html') {
              content = html.substring(0, maxChars);
            } else {
              const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
              const body = bodyMatch ? bodyMatch[1] : html;
              // 去 script/style/comments
              const cleaned = body
                .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                .replace(/<!--[\s\S]*?-->/g, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/\s+/g, ' ')
                .trim();
              content = cleaned.substring(0, maxChars);
            }
            resolve({
              ok: true,
              data: {
                url: urlStr,
                content,
                length: content.length,
                final_url: urlStr,
                content_type: ct,
                charset,
                encoding: enc || 'none',
              },
            });
          } catch (e) {
            resolve({ ok: false, error: { code: 'PARSE_ERROR', message: e.message } });
          }
        });
        res.on('error', (e) => resolve({ ok: false, error: { code: 'NETWORK_ERROR', message: e.message } }));
      });
      req.on('error', (e) => resolve({ ok: false, error: { code: 'NETWORK_ERROR', message: e.message } }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: { code: 'TIMEOUT', message: '请求超时' } }); });
    });
    return httpFetch(url);
  },

  // ---- 天气查询 ----
  weather_check: async (ctx) => {
    const { params = {} } = ctx;
    const { city } = params;
    if (!city) return { ok: false, error: { code: 'NO_CITY', message: '未提供城市名称' } };
    try {
      const https = require('https');
      const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
      const result = await new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'curl/7.68.0' } }, res => {
          if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve(data));
          res.on('error', reject);
        }).on('error', reject);
      });
      const j = JSON.parse(result);
      const curr = j.current_condition[0];
      return { ok: true, data: { city, temp_C: curr.temp_C, humidity: curr.humidity, weather: curr.weatherDesc[0].value, windSpeed: curr.windspeedKmph + ' km/h', feelsLike: curr.FeelsLikeC + '°C', timestamp: new Date().toISOString() } };
    } catch (e) {
      return { ok: false, error: { code: 'WEATHER_ERROR', message: e.message } };
    }
  },

  // ---- 新闻摘要(国内可用RSS源,无API key)----
  news_digest: async (ctx) => {
    const { params = {} } = ctx;
    const { category = 'general', count = 5 } = params;
    const https = require('https');

    // 按优先级尝试可用的RSS源
    const FEEDS = [
      {
        name: 'OSChina',
        url: 'https://www.oschina.net/news/rss',
        parser: (text) => {
          // OSChina RSS: <item><title>...</title><link>...</link><description>...</description></item>
          const items = [];
          const re = /<item[^>]*>\s*<title><!\[CDATA\[([^\]]+)\]\]><\/title>\s*<link>([^<]+)<\/link>/g;
          let m;
          while ((m = re.exec(text)) !== null && items.length < count) {
            const title = m[1].replace(/<!\[CDATA\[|\]]>/g, '').trim();
            const link = m[2].trim();
            items.push({ title, url: link, content: title });
          }
          return items;
        }
      },
      {
        name: '36kr',
        url: 'https://36kr.com/feed',
        parser: (text) => {
          const items = [];
          const re = /<item[^>]*>\s*<title><!\[CDATA\[([^\]]+)\]\]><\/title>\s*<link>([^<]+)<\/link>/g;
          let m;
          while ((m = re.exec(text)) !== null && items.length < count) {
            const title = m[1].replace(/<!\[CDATA\[|\]]>/g, '').trim();
            const link = m[2].trim();
            items.push({ title, url: link, content: title });
          }
          return items;
        }
      },
      {
        name: 'Solidot',
        url: 'https://www.solidot.org/index.rss',
        parser: (text) => {
          const items = [];
          const re = /<item[^>]*>\s*<title>([^<]+)<\/title>\s*<link>([^<]+)<\/link>/g;
          let m;
          while ((m = re.exec(text)) !== null && items.length < count) {
            items.push({ title: m[1].trim(), url: m[2].trim(), content: m[1].trim() });
          }
          return items;
        }
      },
      {
        name: 'Lobste.rs',
        url: 'https://lobste.rs/rss',
        parser: (text) => {
          const items = [];
          const re = /<item[^>]*>\s*<title>([^<]+)<\/title>\s*<link>([^<]+)<\/link>/g;
          let m;
          while ((m = re.exec(text)) !== null && items.length < count) {
            items.push({ title: m[1].trim(), url: m[2].trim(), content: m[1].trim() });
          }
          return items;
        }
      },
    ];

    // 2026-08-22 改: 并行 (Promise.any), 任一成功立即返回, P50 从 ~16s 降到 ~4s
    const tasks = FEEDS.map(feed => (async () => {
      try {
        const raw = await new Promise((resolve, reject) => {
          const req = https.get(feed.url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml, application/xml, text/xml' },
            timeout: 6000,
          }, res => {
            if (res.statusCode !== 200) { res.destroy(); return reject(new Error('HTTP ' + res.statusCode)); }
            const bufs = []; let size = 0;
            res.on('data', c => { size += c.length; if (size > 2e6) { res.destroy(); return reject(new Error('Too large')); } bufs.push(c); });
            res.on('end', () => resolve(Buffer.concat(bufs).toString('utf8')));
            res.on('error', reject);
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });
        const items = feed.parser(raw);
        return items.length > 0 ? { ok: true, source: feed.name, items } : { ok: false, source: feed.name, reason: 'empty' };
      } catch (e) {
        return { ok: false, source: feed.name, reason: e.message.slice(0, 80) };
      }
    })());

    const settled = await Promise.all(tasks);
    const winner = settled.find(x => x.ok);
    if (winner) {
      return {
        ok: true,
        data: {
          category, count, source: winner.source, headlines: winner.items.slice(0, count),
          all_sources: settled.map(x => ({ source: x.source, status: x.ok ? 'ok' : 'fail:' + x.reason })),
          timestamp: new Date().toISOString(),
        },
      };
    }
    return { ok: false, error: { code: 'NEWS_ERROR', message: '所有新闻源均不可用', sources: settled.map(x => x.source + ':' + x.reason).join('; ') } };
  },

  // ---- 翻译 ----
  translate_text: async (ctx) => {
    const { params = {} } = ctx;
    const { text, target_lang = 'auto' } = params;
    if (!text) return { ok: false, error: { code: 'NO_TEXT', message: '未提供待翻译文本' } };
    // 用 MyMemory 免费翻译 API
    try {
      const https = require('https');
      const langPair = target_lang === 'auto' ? 'auto|zh' : `auto|${target_lang}`;
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langPair}`;
      const result = await new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'curl/7.68.0' }, timeout: 8000 }, res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve(data));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('MyMemory timeout 8s')); });
      });
      const j = JSON.parse(result);
      return { ok: true, data: { original: text, translated: j.responseData.translatedText, detected_lang: j.responseData.detectedLang, timestamp: new Date().toISOString() } };
    } catch (e) {
      return { ok: false, error: { code: 'TRANSLATE_ERROR', message: e.message } };
    }
  },

  // ---- GitHub API ----
  github_api: async (ctx) => {
    const { params = {} } = ctx;
    // 注意: 不要解构 'path', 会 shadow 顶部 const path = require('path')
    const { method = 'GET', path: apiPath, body } = params;
    if (!apiPath) return { ok: false, error: { code: 'NO_PATH', message: '未提供 API 路径 (params.path)' } };
 // 凭证代理 : env → credentials 文件, key 不返 LLM
    const credentials = require(path.join(__dirname, '..', 'credentials'));
    const token = process.env.GITHUB_PAT || process.env.GITHUB_TOKEN || credentials.get('github_pat');
    if (!token) return { ok: false, error: { code: 'NO_TOKEN', message: '未配置 GITHUB_PAT (env 或 credentials 文件)' } };
    credentials.touch('github_pat');  // 审计:记录使用
    try {
      const https = require('https');
      const url = new URL(`https://api.github.com${apiPath}`);
      const opts = { hostname: url.hostname, path: url.pathname, method, headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'Pangu/1.0' } };
      const result = await new Promise((resolve, reject) => {
        const req = https.request(opts, res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve({ status: res.statusCode, data }));
          res.on('error', reject);
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
      return { ok: true, data: { status: result.status, body: JSON.parse(result.data || '{}') } };
    } catch (e) {
      return { ok: false, error: { code: 'GITHUB_ERROR', message: e.message } };
    }
  },

  // ---- 微信推送 (2026-10-30 第 172 批: 盘古自己接微信) ----
  // 原来是空壳 (只往 ~/.pangu/weixin_queue/ 写文件, 没有消费者 ⇒ 直接报错防 LLM 装成功)。
  // 现在走 modules/weixin_channel.js —— 盘古自己直连 iLink 微信通道,
  // 不经过老 openclaw 桌面端 (那套随时要退休)。
  send_wechat: async (ctx) => {
    const { params = {} } = ctx;
    const { to, message } = params;
    if (!message || !String(message).trim()) {
      return { ok: false, error: { code: 'MISSING_PARAMS', message: '未提供 message (消息正文)' } };
    }
    try {
      const weixin = require('../weixin_channel');
      const sent = await weixin.sendText({
        // to 省略 = 发给账号里的默认会话 (老板本人)
        to: (to && String(to).trim()) || undefined,
        text: String(message),
      });
      if (!sent.ok) {
        return {
          ok: false,
          error: {
            code: sent.error || 'WECHAT_SEND_FAILED',
            message: sent.message || '微信发送失败',
          },
        };
      }
      return { ok: true, data: { to: sent.to, chars: sent.chars } };
    } catch (e) {
      return { ok: false, error: { code: 'WECHAT_SEND_FAILED', message: String(e.message || e) } };
    }
  },

  // ---- 汇率查询 ----
  currency_check: async (ctx) => {
    const { params = {} } = ctx;
    const { pair = 'USD/CNY' } = params;
    try {
      const https = require('https');
      const [from, to] = pair.split('/');
      // frankfurter.app(欧盟央行数据,免费无需key)
      const url = `https://api.frankfurter.app/latest?from=${from}&to=${to}`;
      const result = await new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'curl/7.68.0', 'Accept': 'application/json' } }, res => {
          // frankfurter.app 返回301,Node.js默认不跟随,手动处理
          if (res.statusCode === 301 && res.headers.location) {
            const redirectUrl = res.headers.location;
            https.get(redirectUrl, { headers: { 'User-Agent': 'curl/7.68.0', 'Accept': 'application/json' } }, res2 => {
              let data = '';
              res2.on('data', c => data += c);
              res2.on('end', () => resolve(data));
              res2.on('error', reject);
            }).on('error', reject);
            return;
          }
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve(data));
          res.on('error', reject);
        });
        req.on('error', reject);
      });
      const j = JSON.parse(result);
      const rate = j.rates ? j.rates[to] : null;
      return { ok: true, data: { pair, rate, date: j.date || new Date().toISOString().slice(0, 10), timestamp: new Date().toISOString() } };
    } catch (e) {
      return { ok: false, error: { code: 'CURRENCY_ERROR', message: e.message } };
    }
  },

  // ---- 加密货币价格(CoinGecko免费API,无需key)----
  crypto_price: async (ctx) => {
    const { params = {} } = ctx;
    const { symbol = 'BTC', currency = 'USD' } = params;
    // 2026-08-22 修: 国内 CoinGecko 不通, 加 Binance/OKX fallback 链 + 8s 超时
    const symbolUpper = symbol.toUpperCase();
    const currencyUpper = currency.toUpperCase();
    const https = require('https');

    function _httpGet(urlStr, timeoutMs) {
      return new Promise((resolve, reject) => {
        const lib = urlStr.startsWith('https') ? require('https') : require('http');
        const req = lib.get(urlStr, {
          headers: { 'User-Agent': 'Pangu/1.0', 'Accept': 'application/json' },
          timeout: timeoutMs || 8000,
        }, res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + timeoutMs + 'ms')); });
      });
    }

    // Binance: BTCUSDT 直接拿 (USDT 当 USD)
    const BINANCE_QUOTE = { 'USD': 'USDT', 'USDC': 'USDC', 'BTC': 'BTC', 'ETH': 'ETH' };
    const tryBinance = async () => {
      const quote = BINANCE_QUOTE[currencyUpper] || currencyUpper;
      const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbolUpper}${quote}`;
      const { status, body } = await _httpGet(url, 4000);
      if (status !== 200) throw new Error('binance HTTP ' + status);
      const j = JSON.parse(body);
      return { price: parseFloat(j.price), raw: j };
    };

    // OKX: instId = BTC-USD / BTC-USDT
    const tryOKX = async () => {
      const instId = `${symbolUpper}-${currencyUpper === 'USD' ? 'USDT' : currencyUpper}`;
      const url = `https://www.okx.com/api/v5/market/ticker?instId=${instId}`;
      const { status, body } = await _httpGet(url, 4000);
      if (status !== 200) throw new Error('okx HTTP ' + status);
      const j = JSON.parse(body);
      if (!j.data || !j.data[0]) throw new Error('okx empty data');
      const d = j.data[0];
      return { price: parseFloat(d.last), raw: d };
    };

    // CoinGecko: 兜底, 国际服常用
    const symbolMap = { 'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana', 'DOGE': 'dogecoin', 'XRP': 'ripple', 'ADA': 'cardano', 'DOT': 'polkadot', 'AVAX': 'avalanche-2', 'MATIC': 'matic-network', 'LINK': 'chainlink' };
    const tryCoinGecko = async () => {
      const coinId = symbolMap[symbolUpper] || symbol.toLowerCase();
      const currencyLower = currency.toLowerCase();
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=${currencyLower}&include_last_updated_at=true`;
      const { status, body } = await _httpGet(url, 4000);
      if (status !== 200) throw new Error('coingecko HTTP ' + status);
      const j = JSON.parse(body);
      const priceData = j[coinId];
      if (!priceData || !priceData[currencyLower]) throw new Error('coingecko no data');
      return { price: priceData[currencyLower], last_updated: priceData.last_updated_at, raw: j };
    };

    // 并行 (Promise.any): 任一成功立即返回, 减少 P50 延迟
    const sources = [
      { name: 'Binance', fn: tryBinance },
      { name: 'OKX', fn: tryOKX },
      { name: 'CoinGecko', fn: tryCoinGecko },
    ];

    // 带 trace 的 Promise.any, 收集每个的失败原因
    const tagged = sources.map(s => (async () => {
      try { return { ok: true, source: s.name, result: await s.fn() }; }
      catch (e) { return { ok: false, source: s.name, err: e.message }; }
    })());

    const settled = await Promise.all(tagged);
    const winner = settled.find(x => x.ok);
    if (winner) {
      const r = winner.result;
      return {
        ok: true,
        data: {
          symbol: symbolUpper,
          currency: currencyUpper,
          price: r.price,
          unit: currencyUpper,
          last_updated: r.last_updated ? new Date(r.last_updated * 1000).toISOString() : new Date().toISOString(),
          source: winner.source,
          fallback_used: winner.source !== 'Binance',
        },
      };
    }
    const errors = settled.map(x => x.source + ': ' + x.err.slice(0, 80)).join(' | ');
    return { ok: false, error: { code: 'CRYPTO_ERROR', message: '所有源都失败: ' + errors } };
  },

  // ---- 代码执行 ----
  code_execute: async (ctx) => {
    const { params = {} } = ctx;
    const { code, language = 'python', timeout = 30 } = params;
    if (!code) return { ok: false, error: { code: 'NO_CODE', message: '未提供代码' } };
 // P1-S6 加固: 危险命令黑名单 + 模式拦截 + python 特定禁字
    try {
      const sandbox = require('../sandbox');
      const danger = sandbox.isDangerousCommand ? sandbox.isDangerousCommand(code) : false;
      if (danger === true) {
        return { ok: false, error: { code: 'FORBIDDEN_CMD', message: 'code_execute 检测到危险命令模式 (sandbox.isDangerousCommand=true)' } };
      }
    } catch (e) { /* sandbox 加载失败不阻塞执行, 但记录 */ console.warn('[code_execute] sandbox load failed:', e.message); }
 // Python 沙箱加固 — 拦截常用 RCE 入口
    if (language === 'python' || language === 'py') {
      // 顺序: 先解码去掉注释/字符串字面量, 再看是否含禁字
      const stripped = code
        .replace(/#[^\n]*/g, '')           // 行注释
        .replace(/('''[\s\S]*?'''|"""[\s\S]*?""")/g, '""')  // 三引号字符串
        .replace(/('([^'\\]|\\.)*'|"([^"\\]|\\.)*")/g, '""'); // 单/双引号字符串
      const FORBIDDEN_PY = [
        /\bimport\s+os\b/,                    // import os (os.system, os.popen)
        /\bfrom\s+os\s+import\b/,
        /\bimport\s+subprocess\b/,
        /\bfrom\s+subprocess\s+import\b/,
        /\bimport\s+socket\b/,                // 网络
        /\bimport\s+urllib\b/,
        /\bimport\s+requests\b/,
        /\b__import__\s*\(/,                  // __import__('os')
        /\bexec\s*\(/,                         // exec / eval
        /\beval\s*\(/,
        /\bcompile\s*\(/,
        /\bopen\s*\([^)]*['"][wa]/,           // open('x', 'w') 写文件
        /\bopen\s*\([^)]*['"][wa]['"]\s*,\s*['"][wa]['"]/,
      ];
      for (const re of FORBIDDEN_PY) {
        if (re.test(stripped)) {
          return { ok: false, error: { code: 'FORBIDDEN_PY', message: `code_execute 拦截危险 Python 模式: ${re.source} — code_execute 不是写文件工具, 新建/批量写文件请改用 write_file 或 exec_command heredoc 重规划` } };
        }
      }
    }
    try {
      let result, exitCode;
      if (language === 'python' || language === 'py') {
        const tmpfile = '/tmp/pangu_code_' + Date.now() + '.py';
        require('fs').writeFileSync(tmpfile, code);
        const { stdout, stderr } = await execFile('python3', [tmpfile], { timeout: Math.min(timeout, 60) });
        require('fs').unlinkSync(tmpfile);
        result = stdout || stderr;
        exitCode = stderr && !stdout ? 1 : 0;
      } else if (language === 'shell' || language === 'bash') {
 // 改: 跨平台 shell (Windows 不支持 bash 用 cmd.exe)
        const _shellBin = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
        const { stdout, stderr } = await execFile(_shellBin, ['-c', code], { timeout: Math.min(timeout, 60) });
        result = stdout || stderr;
        exitCode = stderr && !stdout ? 1 : 0;
      } else {
        return { ok: false, error: { code: 'LANG_UNSUPPORTED', message: '仅支持 python/py 和 shell/bash' } };
      }
      return { ok: exitCode === 0, data: { language, output: result, exitCode }, exit_code: exitCode };
    } catch (e) {
      return { ok: false, error: { code: 'EXEC_ERROR', message: e.message } };
    }
  },

  // ---- 本地文件编辑(新增)----
  file_edit: async (ctx) => {
    const { params = {} } = ctx;
    const { old_string, new_string, replace_all = false } = params;
    let filePath = TOOLS._expandHome(params.path);
    if (filePath && !path.isAbsolute(filePath)) filePath = path.join(REPO_ROOT, filePath);  // 2026-08-02: 相对路径锚仓库根
    if (!filePath) return { ok: false, error: { code: 'NO_PATH', message: '未提供文件路径' } };
    if (old_string === undefined) return { ok: false, error: { code: 'NO_OLD_STRING', message: '未提供 old_string' } };
    if (new_string === undefined) return { ok: false, error: { code: 'NO_NEW_STRING', message: '未提供 new_string' } };
    try {
      const fs = require('fs');
      const content = fs.readFileSync(filePath, 'utf8');
      let newContent;
      let count = 0;
      if (replace_all) {
        const regex = new RegExp(old_string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        newContent = content.replace(regex, new_string);
        count = (content.match(regex) || []).length;
      } else {
        const idx = content.indexOf(old_string);
        if (idx === -1) return { ok: false, error: { code: 'NOT_FOUND', message: '未找到匹配内容' } };
        newContent = content.slice(0, idx) + new_string + content.slice(idx + old_string.length);
        count = 1;
      }
      fs.writeFileSync(filePath, newContent, 'utf8');
      // P0-#29: 算 unified diff + before/after (推 SSE event:diff)
      // 用临时文件 + git diff --no-index (因为 git diff --no-index 需要 2 个 path)
      const before = content;
      const after = newContent;
      let unifiedDiff = '';
      try {
        const { spawnSync } = require('child_process');
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        // 写 before 到 tmp
        const tmpBefore = path.join(os.tmpdir(), `diff_before_${Date.now()}_${process.pid}.tmp`);
        fs.writeFileSync(tmpBefore, before, 'utf8');
        try {
          const r = spawnSync('git', ['diff', '--no-index', '--unified=3', '--no-color', '--', tmpBefore, filePath], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          unifiedDiff = (r.stdout || '');
          // git diff --no-index 开头有 "diff --git a/tmp/xxx b/file" — 过滤掉
          unifiedDiff = unifiedDiff.split('\n').filter(l => !l.startsWith('diff --git') && !l.startsWith('index ') && !l.startsWith('--- a/') && !l.startsWith('+++ b/')).join('\n');
          // 重写 a/ tmp/xxx b/ file → 真实 file
          unifiedDiff = `--- ${filePath}\n+++ ${filePath}\n${unifiedDiff.replace(/^@@/, '@@').trim()}`;
        } finally {
          try { fs.unlinkSync(tmpBefore); } catch (_) {}
        }
      } catch (_) {
        unifiedDiff = `--- ${filePath}\n+++ ${filePath}\n@@ ...\n-${before.slice(0, 200).replace(/\n/g, '\n-')}\n+${after.slice(0, 200).replace(/\n/g, '\n+')}`;
      }
      return {
        ok: true,
        data: {
          path: filePath, edited: true, count, timestamp: new Date().toISOString(),
          // P0-#29: diff data for SSE event:diff
          file: filePath,
          diff: unifiedDiff,
          before,
          after,
          changes: count,
        },
      };
    } catch (e) {
      return { ok: false, error: { code: 'EDIT_ERROR', message: e.message } };
    }
  },

  // ---- TL-5 子项 B: Multi-file atomic edit ----
  file_edit_batch: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { fileEditBatch } = require('../file_edit_batch');
      const r = await fileEditBatch(params);
      // P0-#29: 给每个 success_count 的 edit 算 diff + before/after (推 SSE event:diff_batch)
      if (r && r.ok && Array.isArray(r.data && r.data.results)) {
        const { spawnSync } = require('child_process');
        const fs = require('fs');
        const path = require('path');
        const diffs = [];
        for (const e of r.data.results) {
          if (!e || !e.ok || !e.path) continue;
          let before = '', after = '';
          try { after = fs.readFileSync(e.path, 'utf8'); } catch (_) {}
          // before 只能从 "改前的 file" 推, 但 file_edit_batch 没存 — 用 git 拿
          let beforeFromGit = '';
          try {
            const rg = spawnSync('git', ['show', `HEAD:${e.path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            if (rg.status === 0) beforeFromGit = rg.stdout;
          } catch (_) {}
          // unified diff: 用 git diff
          let unifiedDiff = '';
          try {
            const rd = spawnSync('git', ['diff', '--unified', '--no-color', '--', e.path], {
              cwd: process.cwd(),
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            unifiedDiff = (rd.stdout || '');
          } catch (_) {}
          diffs.push({
            file: e.path,
            diff: unifiedDiff,
            before: beforeFromGit,
            after,
            changes: 1,
          });
        }
        if (diffs.length > 0) {
          r.data.diffs = diffs;
          r.data.files_changed = diffs.map(d => d.file);
        }
      }
      return r;
    } catch (e) {
      return { ok: false, error: { code: 'BATCH_EDIT_ERROR', message: e.message } };
    }
  },

  // ---- P0-#14: Git Ops (4 个 tool, 让 Pangu 自闭环改自己) ----
  git_commit: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { gitCommit } = require('./git_ops');
      return await gitCommit(params);
    } catch (e) {
      return { ok: false, error: { code: 'GIT_COMMIT_ERROR', message: e.message } };
    }
  },
  git_branch: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { gitBranch } = require('./git_ops');
      return await gitBranch(params);
    } catch (e) {
      return { ok: false, error: { code: 'GIT_BRANCH_ERROR', message: e.message } };
    }
  },
  git_diff: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { gitDiff } = require('./git_ops');
      return await gitDiff(params);
    } catch (e) {
      return { ok: false, error: { code: 'GIT_DIFF_ERROR', message: e.message } };
    }
  },
  git_status: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { gitStatus } = require('./git_ops');
      return await gitStatus(params);
    } catch (e) {
      return { ok: false, error: { code: 'GIT_STATUS_ERROR', message: e.message } };
    }
  },

  // ---- 2026-08-02 自我迭代 (老板拍: "我需要盘古可以自我修改代码，自我迭代") ----
  // 闭环: 改代码 → self_iterate → 语法验证 → git 快照 → 延迟重启 → 看门狗健康检查 → 挂了自动回滚
  self_iterate: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { selfIterate } = require('./self_iterate');
      return await selfIterate(params);
    } catch (e) {
      return { ok: false, error: { code: 'SELF_ITERATE_ERROR', message: e.message } };
    }
  },

  // ---- P0-#1 Plan Mode: 3 个 plan_* tool + main.sqlite 持久化 ----
  plan_approve: async (ctx) => {
    const { params = {} } = ctx;
    const planId = params.plan_id || (ctx.context && ctx.context.plan_id);
    if (!planId) return { ok: false, error: { code: 'NO_PLAN_ID', message: 'plan_id required', retryable: false } };
    try {
      const { _planAudit } = require('../plan_mode');
      const r = _planAudit.record(planId, 'approved', { ts: Date.now() });
      console.log('[plan-mode] approved plan_id=' + planId);
      return { ok: true, result: { plan_id: planId, status: 'approved', ts: r.ts } };
    } catch (e) {
      return { ok: false, error: { code: 'PLAN_APPROVE_ERROR', message: e.message } };
    }
  },
  plan_reject: async (ctx) => {
    const { params = {} } = ctx;
    const planId = params.plan_id || (ctx.context && ctx.context.plan_id);
    const reason = params.reason || '';
    if (!planId) return { ok: false, error: { code: 'NO_PLAN_ID', message: 'plan_id required', retryable: false } };
    if (!reason) return { ok: false, error: { code: 'NO_REASON', message: 'reason required for reject', retryable: false } };
    try {
      const { _planAudit } = require('../plan_mode');
      const r = _planAudit.record(planId, 'rejected', { reason, ts: Date.now() });
      console.log('[plan-mode] rejected plan_id=' + planId + ' reason=' + reason.slice(0, 80));
      return { ok: true, result: { plan_id: planId, status: 'rejected', reason, ts: r.ts } };
    } catch (e) {
      return { ok: false, error: { code: 'PLAN_REJECT_ERROR', message: e.message } };
    }
  },
  plan_status: async (ctx) => {
    const { params = {} } = ctx;
    const planId = params.plan_id || (ctx.context && ctx.context.plan_id);
    if (!planId) return { ok: false, error: { code: 'NO_PLAN_ID', message: 'plan_id required', retryable: false } };
    try {
      const { _planAudit } = require('../plan_mode');
      const status = _planAudit.status(planId);
      return { ok: true, result: status };
    } catch (e) {
      return { ok: false, error: { code: 'PLAN_STATUS_ERROR', message: e.message } };
    }
  },

  // ---- P0-#33 Checkpoint / Rollback: 3 个 tool ----
  checkpoint_create: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { createCheckpoint } = require('../checkpoint');
      return await createCheckpoint(params);
    } catch (e) {
      return { ok: false, error: { code: 'CHECKPOINT_CREATE_ERROR', message: e.message } };
    }
  },
  checkpoint_list: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { listCheckpoints } = require('../checkpoint');
      return await listCheckpoints(params);
    } catch (e) {
      return { ok: false, error: { code: 'CHECKPOINT_LIST_ERROR', message: e.message } };
    }
  },
  checkpoint_rollback: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { rollbackCheckpoint } = require('../checkpoint');
      return await rollbackCheckpoint(params);
    } catch (e) {
      return { ok: false, error: { code: 'CHECKPOINT_ROLLBACK_ERROR', message: e.message } };
    }
  },

  // ---- P0-#34 Session 恢复: 4 个 tool ----
  session_save: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { sessionSave } = require('../session_store');
      return await sessionSave(params);
    } catch (e) {
      return { ok: false, error: { code: 'SESSION_SAVE_ERROR', message: e.message } };
    }
  },
  session_load: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { sessionLoad } = require('../session_store');
      return await sessionLoad(params);
    } catch (e) {
      return { ok: false, error: { code: 'SESSION_LOAD_ERROR', message: e.message } };
    }
  },
  session_recall: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { sessionRecall } = require('../session_store');
      return await sessionRecall(params);
    } catch (e) {
      return { ok: false, error: { code: 'SESSION_RECALL_ERROR', message: e.message } };
    }
  },
  session_list: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { sessionList } = require('../session_store');
      return await sessionList(params);
    } catch (e) {
      return { ok: false, error: { code: 'SESSION_LIST_ERROR', message: e.message } };
    }
  },
  session_delete: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { sessionDelete } = require('../session_store');
      return await sessionDelete(params);
    } catch (e) {
      return { ok: false, error: { code: 'SESSION_DELETE_ERROR', message: e.message } };
    }
  },

  // ---- P0-#7 Self-correct: LLM judge 评估 tool 输出 ----
  self_correct: async (ctx) => {
    const { params = {} } = ctx;
    const toolName = params.tool_name;
    if (!toolName) return { ok: false, error: { code: 'NO_TOOL_NAME', message: 'tool_name required' } };
    const original = params.original_result || {};
    const planId = params.plan_id || (ctx.context && ctx.context.plan_id) || null;
    try {
      // 调 LLM judge (复用 Pangu 主模型 — 通过 _callLLMForAgent, 但 self_correct 工具本身
      // 是 Pangu 内部用, 不用 LLM, 用静态启发式 + 复用 _callLLMForAgent)
      // v1 简化: 不真调 LLM (避免递归), 用 deterministic 检查:
      //  - ok=false → 'incorrect' (error path)
      //  - ok=true + 字段齐全 → 'correct'
      //  - ok=true 但有 warning 字段 → 'suspicious'
      const verdict = (() => {
        if (original && original.ok === false) return 'incorrect';
        if (original && original.ok === true) {
          // 可疑信号: error 字段存在但 ok=true (矛盾), 警告, 或 result 空
          if (original.error) return 'suspicious';
          if (original.warning) return 'suspicious';
          if (original.result === null || original.result === undefined || (typeof original.result === 'object' && Object.keys(original.result).length === 0)) return 'suspicious';
          return 'correct';
        }
        return 'suspicious';
      })();
      const reason = verdict === 'correct'
        ? 'tool 输出结构完整, ok=true, 字段齐全'
        : verdict === 'incorrect'
          // 2026-10-15: error 有两种形状 —— 对象 {code, message} (多数工具) 和**裸字符串**
          // (如 j2 的 DUPLICATE_TOOL_CALL, :2397)。旧代码只读 original.error.code,
          // 碰到裸字符串一律取到 undefined, 于是所有失败理由都写成 "错误码 undefined",
          // 日志里根本看不出是哪一类失败 — 排查时只能靠猜。
          ? 'tool 返 ok=false, 错误码 ' + (typeof original.error === 'string' ? original.error
              : (original.error && original.error.code) || 'UNKNOWN') + ' — 需重规划'
          : 'tool 输出可疑 (error/warning/空 result) — 需 LLM 进一步 judge';
      // v2: 调 LLM judge 评 return 'suspicious' — v1 用确定性规则
      // 持久化 self_correct 历史 (借 #34 session_store)
      try {
        const { sessionSave } = require('../session_store');
        const entry = { plan_id: planId, tool_name: toolName, verdict, reason, ts: Date.now() };
        const r2 = await sessionSave({
          session_id: 'self_correct_' + Date.now(),
          plan_id: planId,
          messages: [entry],
          state: 'self_correct_audit',
          ts: entry.ts,
        });
        // 存到 plan_id sessions (累积)
        if (planId) {
          await sessionSave({
            session_id: planId,
            plan_id: planId,
            messages: [entry],
            state: 'self_correct_audit',
            ts: entry.ts,
          });
        }
      } catch (_) {}
      return {
        ok: true,
        result: {
          verdict,
          reason,
          tool_name: toolName,
          plan_id: planId,
          ts: Date.now(),
          suggestion: verdict === 'incorrect' ? { action: 'replan', message: '建议调用 plan_approve 后重新规划' } : undefined,
        },
      };
    } catch (e) {
      return { ok: false, error: { code: 'SELF_CORRECT_ERROR', message: e.message } };
    }
  },

  // ---- P0-#18 (P0-10 LSP 整合): symbol search (tree-sitter + 3 grammar) ----
  symbol_search: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { symbolSearch } = require('../symbol_search');
      return await symbolSearch(params);
    } catch (e) {
      return { ok: false, error: { code: 'SYMBOL_SEARCH_ERROR', message: e.message } };
    }
  },

  // ---- P0-#17 (P0-10 LSP 整合): LSP go-to-def / references (vscode-langservers-extracted + tsserver + python 占位) ----
  lsp_definition: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { lspDefinition } = require('../lsp');
      return await lspDefinition(params);
    } catch (e) {
      return { ok: false, error: { code: 'LSP_DEFINITION_ERROR', message: e.message } };
    }
  },

  lsp_references: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { lspReferences } = require('../lsp');
      return await lspReferences(params);
    } catch (e) {
      return { ok: false, error: { code: 'LSP_REFERENCES_ERROR', message: e.message } };
    }
  },

  // ---- P0-#16 (P0-10 LSP 整合): syntax highlighting (chalk + tree-sitter-highlight) ----
  syntax_highlight: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { colorize, colorizeFile } = require('../syntax_hl');
      let result;
      if (params.file) {
        result = colorizeFile(params.file, params);
        return { ok: true, result: { file: params.file, output: result } };
      } else if (params.code) {
        result = colorize(params.code, params);
        return { ok: true, result: { lang: params.lang, output: result } };
      } else {
        return { ok: false, error: { code: 'NO_INPUT', message: '需 code 或 file 之一' } };
      }
    } catch (e) {
      return { ok: false, error: { code: 'SYNTAX_HIGHLIGHT_ERROR', message: e.message } };
    }
  },

  // ---- P0-#36 Metrics: token 计数 ----
  metrics_query: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { getMetrics } = require('../metrics');
      // 2026-07-26: 省略 session_id 时归当前会话 (之前模型照 schema 示例传 "default" → 读到全 daemon 旧账)
      const sid = (params.session_id && params.session_id !== 'default') ? params.session_id : ((ctx.context && ctx.context.sessionId) || 'default');
      return await getMetrics({ ...params, session_id: sid });
    } catch (e) {
      return { ok: false, error: { code: 'METRICS_QUERY_ERROR', message: e.message } };
    }
  },
  metrics_dashboard: async (ctx) => {
    const { params = {} } = ctx;
    try {
      const { metricsDashboard } = require('../metrics');
      const sid = (params.session_id && params.session_id !== 'default') ? params.session_id : ((ctx.context && ctx.context.sessionId) || 'default');
      return await metricsDashboard({ ...params, session_id: sid });
    } catch (e) {
      return { ok: false, error: { code: 'METRICS_DASHBOARD_ERROR', message: e.message } };
    }
  },

  // ---- 文件内容搜索 grep(新增)----
  file_grep: async (ctx) => {
    const { params = {} } = ctx;
    const { path: _rawSearchPath = '.', pattern, file_glob, context = 0, output_mode = 'content', limit = 50 } = params;
    const searchPath = TOOLS._expandHome(_rawSearchPath);  // 2026-08-03: ~ 展开 + /Users/假用户名 纠正
    if (!pattern) return { ok: false, error: { code: 'NO_PATTERN', message: '未提供搜索模式' } };
    try {
    const execFile = require('util').promisify(require('child_process').execFile);
      const args = ['-rn'];
      if (file_glob) args.push('--include=' + file_glob);
      if (context > 0) args.push(`-A ${context}`, `-B ${context}`);
      args.push(pattern, searchPath);
      const { stdout, stderr } = await execFile('grep', args, { timeout: 15000 });
      const lines = (stdout || '').split('\n').filter(Boolean).slice(0, limit);
      let matches;
      if (output_mode === 'files_only') {
        matches = [...new Set(lines.map(l => l.split(':')[0]))];
      } else if (output_mode === 'count') {
        matches = lines.length;
      } else {
        matches = lines.map(line => {
          const colonIdx = line.indexOf(':');
          const file = line.slice(0, colonIdx);
          const rest = line.slice(colonIdx + 1);
          const colonIdx2 = rest.indexOf(':');
          return {
            file,
            line: parseInt(rest.slice(0, colonIdx2)) || 0,
            text: rest.slice(colonIdx2 + 1).slice(0, 200),
          };
        });
      }
      return {
        ok: true,
        data: { path: searchPath, pattern, matches, count: lines.length, output_mode, timestamp: new Date().toISOString() },
      };
    } catch (e) {
      return { ok: true, data: { path: searchPath, pattern, matches: [], count: 0, error: e.message } };
    }
  },

  // ---- 按文件名查找文件(新增)----
  file_find: async (ctx) => {
    const { params = {} } = ctx;
    // 2026-08-02 修 (老板实证: 找 FreeCAD 误判"没安装"):
    // 1) -name 区分大小写, "freecad*" 匹配不到 "FreeCAD.app" → 默认改 -iname
    // 2) find / 全盘递归 15s 必超时 → macOS 优先 mdfind (Spotlight, 毫秒级), find 兜底加 maxdepth+剪枝
    const { path: _rawSearchPath2 = '.', pattern, file_glob, type = 'f', limit = 50, case_sensitive = false } = params;
    const searchPath = TOOLS._expandHome(_rawSearchPath2);  // 2026-08-03: ~ 展开 + /Users/假用户名 纠正
    if (!pattern && !file_glob) return { ok: false, error: { code: 'NO_PATTERN', message: '未提供搜索模式' } };
    try {
      const execFile = require('util').promisify(require('child_process').execFile);
      const pat = file_glob || pattern;
      // macOS 全盘/大范围搜索 → mdfind 快路径 (find / 15s 必超时, 超时结果让 LLM 误判"不存在")
      const _broad = searchPath === '/' || searchPath === '/System/Volumes/Data' || searchPath === os.homedir();
      if (process.platform === 'darwin' && _broad) {
        try {
          const mdName = pat.replace(/\*/g, '');
          const { stdout: mdOut } = await execFile('mdfind', ['-name', mdName], { timeout: 8000 });
          let files = (mdOut || '').split('\n').filter(Boolean);
          if (type === 'd') files = files.filter(f => { try { return require('fs').statSync(f).isDirectory(); } catch (_) { return false; } });
          files = files.slice(0, limit);
          return { ok: true, data: { path: searchPath, pattern: pat, files, count: files.length, engine: 'mdfind', timestamp: new Date().toISOString() } };
        } catch (_) { /* mdfind 失败走 find 兜底 */ }
      }
      const args = [searchPath];
      // 防全盘递归爆炸: 默认 maxdepth 6 + 剪掉系统/依赖目录
      args.push('-maxdepth', String(params.maxdepth || 6));
      for (const prune of ['/System', '/private', '/Library', 'node_modules', '.git', '/Volumes']) {
        args.push('-path', prune, '-prune', '-o');
      }
      if (type === 'd') {
        args.push('-type', 'd');
      } else {
        args.push('-type', 'f');
      }
      args.push(case_sensitive ? '-name' : '-iname', pat);
      args.push('-print');
      const { stdout } = await execFile('find', args, { timeout: 15000 });
      const files = (stdout || '').split('\n').filter(Boolean).slice(0, limit);
      return {
        ok: true,
        data: { path: searchPath, pattern: pat, files, count: files.length, engine: 'find', note: '不区分大小写 (-iname), maxdepth ' + (params.maxdepth || 6) + ', 已剪 /System /private /Library node_modules .git', timestamp: new Date().toISOString() },
      };
    } catch (e) {
      return { ok: false, error: { code: 'FIND_ERROR', message: e.message } };
    }
  },

  // ================================================================
  // 新增系统工具(Phase 3 扩充)
  // ================================================================

  // ---- search_files 别名(兼容 64i/symbol_table.js 20+ 处引用)----
  // W4-K-2: redirect 到 file_grep(939 行真 grep 实现,runtime 可达)
  // (之前 redirect 到 1021 行那个错实现--screencapture,已删)
  search_files: async (ctx) => TOOLS.file_grep(ctx),

  // ---- 剪贴板读写 ----
  clipboard_read: async (ctx) => {
 // 跨平台: clipboard 平台分流
    // Mac: pbpaste (内置)
    // Linux: xclip / xsel / wl-copy (依赖外部, 没装报错)
    // Windows: powershell Get-Clipboard
 // 参数化: format(text/image/html)
    const { params = {} } = ctx;
    const format = params.format || 'text';
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      let cmd;
      if (process.platform === 'darwin') {
        // Mac: pbpaste -Prefer={{text, png, html, ...}}
        const macPrefer = format === 'image' ? 'png' : (format === 'html' ? 'html' : 'txt');
        cmd = `/usr/bin/pbpaste -Prefer=${macPrefer}`;
      } else if (process.platform === 'win32') {
        // Win: Get-Clipboard -Format {{Text, Image, Html}}
        const winFormat = format === 'image' ? 'Image' : (format === 'html' ? 'Html' : 'Text');
        cmd = `powershell -NoProfile -Command "Get-Clipboard -Format ${winFormat}"`;
      } else {
        // Linux: 试 xclip -t image/html/text
        const xclipTarget = format === 'image' ? 'image/png' : (format === 'html' ? 'text/html' : 'text/plain');
        cmd = `(xclip -selection clipboard -t ${xclipTarget} -o 2>/dev/null || xsel --clipboard --output --mimetype '${format === 'image' ? 'image/png' : (format === 'html' ? 'text/html' : 'text/plain')}' 2>/dev/null || wl-paste --type '${format === 'image' ? 'image' : (format === 'html' ? 'text/html' : 'text')}' 2>/dev/null || cat /dev/null)`;
      }
      const { stdout } = await execAsync(cmd, { timeout: 5000 });
      return { ok: true, data: { content: stdout, length: stdout.length, format, timestamp: new Date().toISOString() } };
    } catch (e) {
      return { ok: false, error: { code: 'CLIPBOARD_ERROR', message: e.message + ' (平台: ' + process.platform + ', format: ' + format + ')' } };
    }
  },

  clipboard_write: async (ctx) => {
    const { params = {} } = ctx;
    const { text } = params;
    if (!text) return { ok: false, error: { code: 'NO_TEXT', message: '未提供文本' } };
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
 // 跨平台: clipboard write 平台分流
      const encoded = Buffer.from(text).toString('base64');
      let cmd;
      if (process.platform === 'darwin') {
        cmd = `echo "${encoded}" | base64 -d | /usr/bin/pbcopy`;
      } else if (process.platform === 'win32') {
 // P2-S5: 用 -EncodedCommand 传 base64 (PowerShell 原生支持), 完全避免 shell 注入
        const psEncoded = Buffer.from('Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(\"' + encoded + '\")))', 'utf16le').toString('base64');
        cmd = `powershell -NoProfile -EncodedCommand ${psEncoded}`;
      } else {
        // Linux: 试 xclip → xsel → wl-copy (fallback)
        cmd = `(echo "${encoded}" | base64 -d | xclip -selection clipboard 2>/dev/null || echo "${encoded}" | base64 -d | xsel --clipboard --input 2>/dev/null || echo "${encoded}" | base64 -d | wl-copy 2>/dev/null) || exit 1`;
      }
      const shellBin = process.platform === 'win32' ? null : '/bin/sh';
      await execAsync(cmd, { timeout: 5000, shell: shellBin });
      return { ok: true, data: { written: true, length: text.length, platform: process.platform, timestamp: new Date().toISOString() } };
    } catch (e) {
      return { ok: false, error: { code: 'CLIPBOARD_ERROR', message: e.message + ' (平台: ' + process.platform + ')', platform: process.platform } };
    }
  },

  // ---- 系统信息 ----
  system_info: async (ctx) => {
    const { params = {} } = ctx;
    const { detail = false } = params;
    const info = {
      hostname: os.hostname(),
      // 2026-08-03: 补上真用户名+home — LLM 只见 hostname(fengdeMacBook-Pro) 不见 username(feng),
      // 拼 /Users/ 路径时拿主机名当用户名 → /Users/<hostname>/ 幻觉 (老板 8/3 下午实案)
      username: os.userInfo().username,
      home: os.homedir(),
      platform: os.platform(),
      arch: os.arch(),
      uptime: Math.round(os.uptime()),
      cpu_count: os.cpus().length,
      total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
      free_memory_mb: Math.round(os.freemem() / 1024 / 1024),
      loadavg: os.loadavg(),
      timestamp: new Date().toISOString(),
    };
    if (detail) {
      info.cpu_model = os.cpus()[0].model;
      info.cpu_speed = os.cpus()[0].speed + ' MHz';
      info.cpu_usage = 'use top for per-process';
    }
    return { ok: true, data: info };
  },

  // ---- 进程列表 ----
  process_list: async (ctx) => {
    const { params = {} } = ctx;
    const { search = '', limit = 20 } = params;
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      let cmd = 'ps -eo pid,pcpu,pmem,rss,ucomm,args | head -50';
      if (search) {
        cmd = `ps -eo pid,pcpu,pmem,rss,ucomm,args | grep -i "${search.replace(/"/g, '')}" | head -${limit}`;
      }
      const { stdout } = await execAsync(cmd, { timeout: 10000 });
      const lines = stdout.trim().split('\n').filter(Boolean);
      const processes = lines.slice(0, limit).map(line => {
        const parts = line.trim().split(/\s+/);
        return {
          pid: parts[0] || '',
          cpu: parts[1] || '',
          mem: parts[2] || '',
          rss: parts[3] || '',
          command: parts.slice(4).join(' '),
        };
      });
      return { ok: true, data: { search, count: processes.length, processes, timestamp: new Date().toISOString() } };
    } catch (e) {
      return { ok: false, error: { code: 'PROCESS_ERROR', message: e.message } };
    }
  },

  // ---- 网络连通性检查 ----
  network_check: async (ctx) => {
    const { params = {} } = ctx;
    const { host, port = 80, timeout = 5000 } = params;
    if (!host) return { ok: false, error: { code: 'NO_HOST', message: '未提供 host' } };
    try {
      const net = require('net');
      const result = await new Promise((resolve) => {
        const socket = new net.Socket();
        const timer = setTimeout(() => {
          socket.destroy();
          resolve({ reachable: false, timed_out: true });
        }, timeout);
        socket.connect(port, host, () => {
          clearTimeout(timer);
          socket.destroy();
          resolve({ reachable: true, timed_out: false });
        });
        socket.on('error', () => {
          clearTimeout(timer);
          socket.destroy();
          resolve({ reachable: false, timed_out: false, error: 'connection refused' });
        });
      });
      return { ok: true, data: { host, port, ...result, timestamp: new Date().toISOString() } };
    } catch (e) {
      return { ok: false, error: { code: 'NETWORK_ERROR', message: e.message } };
    }
  },

  // ---- 文件压缩 ----
  archive_create: async (ctx) => {
    const { params = {} } = ctx;
    const { path: targetPath, output, format = 'zip' } = params;
    if (!targetPath) return { ok: false, error: { code: 'NO_PATH', message: '未提供目标路径' } };
    if (!output) return { ok: false, error: { code: 'NO_OUTPUT', message: '未提供输出文件名' } };
    if (!['zip', 'tar.gz'].includes(format)) return { ok: false, error: { code: 'BAD_FORMAT', message: 'format 仅支持 zip 或 tar.gz' } };
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      const fs = require('fs');
      const path = require('path');
      const stat = fs.statSync(targetPath);
      let cmd;
      if (format === 'zip') {
        // zip -r <output> <target_basename_or_target>
        // target 是文件 → zip -j output file; target 是目录 → zip -r output dir
        if (stat.isDirectory()) {
          cmd = `cd "${path.dirname(targetPath)}" && zip -r "${path.resolve(output)}" "${path.basename(targetPath)}"`;
        } else {
          cmd = `zip -j "${path.resolve(output)}" "${path.resolve(targetPath)}"`;
        }
      } else {
        // tar.gz: -C 到父目录, 包 basename
        cmd = `tar -czf "${path.resolve(output)}" -C "${path.dirname(targetPath)}" "${path.basename(targetPath)}"`;
      }
      await execAsync(cmd, { timeout: 120000 });
      const outStat = fs.statSync(output);
      return { ok: true, data: { archive: path.resolve(output), size: outStat.size, format, timestamp: new Date().toISOString() } };
    } catch (e) {
      return { ok: false, error: { code: 'ARCHIVE_ERROR', message: e.message } };
    }
  },

  archive_extract: async (ctx) => {
    const { params = {} } = ctx;
    const { path: archivePath, output: outputDir } = params;
    if (!archivePath) return { ok: false, error: { code: 'NO_PATH', message: '未提供压缩包路径' } };
 // P0-S3/S7: outputDir 必填 (原代码用 ${dir} 拼写错且未声明)
    if (!outputDir) return { ok: false, error: { code: 'NO_OUTPUT', message: '未提供解压输出目录 (params.output)' } };
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      const fs = require('fs');
      const path = require('path');
      const resolved = fs.realpathSync(archivePath);
      // 确保输出目录存在
      fs.mkdirSync(outputDir, { recursive: true });
      const outResolved = fs.realpathSync(outputDir);
      let cmd;
      if (resolved.endsWith('.zip')) {
        cmd = `unzip -o "${resolved}" -d "${outResolved}"`;
      } else if (resolved.endsWith('.tar.gz') || resolved.endsWith('.tgz')) {
        cmd = `tar -xzf "${resolved}" -C "${outResolved}"`;
      } else {
        return { ok: false, error: { code: 'UNKNOWN_FORMAT', message: '仅支持 .zip 和 .tar.gz' } };
      }
      await execAsync(cmd, { timeout: 60000 });
      return { ok: true, data: { extracted_to: outResolved, archive: resolved, timestamp: new Date().toISOString() } };
    } catch (e) {
      return { ok: false, error: { code: 'EXTRACT_ERROR', message: e.message } };
    }
  },

  // ---- URL 检测(HTTP GET 返回状态码)----
  http_check: async (ctx) => {
    const { params = {} } = ctx;
    const { url, timeout = 8000 } = params;
    if (!url) return { ok: false, error: { code: 'NO_URL', message: '未提供 URL' } };
    try {
      const http = require(url.startsWith('https') ? 'https' : 'http');
      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ status: 0, error: 'timeout' }), timeout);
        const req = http.get(url, { headers: { 'User-Agent': 'Pangu/1.0', 'Accept': '*/*' } }, res => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, headers: { 'content-type': res.headers['content-type'], 'content-length': res.headers['content-length'] } });
        });
        req.on('error', e => { clearTimeout(timer); resolve({ status: 0, error: e.message }); });
        req.setTimeout(timeout, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
      });
      return { ok: true, data: { url, status: result.status, headers: result.headers || {}, error: result.error, timestamp: new Date().toISOString() } };
    } catch (e) {
      return { ok: false, error: { code: 'HTTP_ERROR', message: e.message } };
    }
  },

  // ---- 简易定时器(sleep + callback 模式,返回一个 timer id)----
  sleep_timer: async (ctx) => {
    const { params = {} } = ctx;
    const { seconds = 5 } = params;
    const sec = Math.max(1, Math.min(parseInt(seconds) || 5, 3600));
    return { ok: true, data: { action: 'sleep', duration_seconds: sec, note: `sleep ${sec}s, use process_list to check completion`, timestamp: new Date().toISOString() } };
  },

  // ---- 当前时间(带时区)----
  current_time: async (ctx) => {
    const { params = {} } = ctx;
    const { timezone = 'Asia/Shanghai' } = params;
    try {
      const now = new Date();
      const fmt = (d) => d.toLocaleString('zh-CN', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return {
        ok: true,
        data: {
          utc: now.toISOString(),
          local: fmt(now),
          timezone,
          timestamp: now.getTime(),
        },
      };
    } catch (e) {
      return { ok: true, data: { utc: new Date().toISOString(), timezone: 'unknown', error: e.message } };
    }
  },

  // ---- 系统截图 (macOS screencapture) ----
  // 2 路: 1) execFile 直接调 (Terminal 有权限时)  2) launchctl asuser (走用户 Aqua session)
  // 删掉 osascript + Terminal .command — 太绕, 错误难诊断, 实际成功率低
  screenshot: async (ctx) => {
    const { params = {} } = ctx;
    const { path: savePath = '/tmp/pangu_screenshot.png', delay = 0 } = params;
    const { execFileSync, spawnSync, execSync } = require('child_process');
    const fs = require('fs');

    const tryExec = () => {
      if (delay > 0) execFileSync('/bin/sleep', [String(delay)]);
      execFileSync('/usr/sbin/screencapture', ['-x', savePath]);
    };

    // 策略 1: 直接 execFile
    try {
      tryExec();
      const stat = fs.statSync(savePath);
      if (stat.size > 0) {
        return { ok: true, data: { path: savePath, saved: true, bytes: stat.size, handoff: null, timestamp: new Date().toISOString() } };
      }
    } catch (_) {}

    // 策略 2: launchctl asuser UID cmd
    try {
      const uid = String(execSync('id -u', { shell: '/bin/sh' }) || '').trim();
      const h1 = `launchctl asuser ${uid} /usr/sbin/screencapture -x '${savePath.replace(/'/g, `'\\''`)}'`;
      const r1 = spawnSync('/bin/sh', ['-c', h1], { encoding: 'utf8', timeout: 10000 });
      if (r1.status === 0 && fs.existsSync(savePath) && fs.statSync(savePath).size > 0) {
        const stat = fs.statSync(savePath);
        return { ok: true, data: { path: savePath, saved: true, bytes: stat.size, handoff: 'launchctl_asuser', timestamp: new Date().toISOString() } };
      }
    } catch (_) {}

    return {
      ok: false,
      error: {
        code: 'SCREENSHOT_FAILED',
        message: '截图失败. 请确认 Terminal.app 已在 系统设置 → 录屏与系统录音 中授权, 然后重启 Terminal.',
      },
    };
  },

  // ---- Computer Use: 鼠标点击 (Swift CGEvent, 不依赖 osascript 授权) ----
    // 盘古必须完全独立 (但不需要老板手动授权辅助功能)
    // 方案: Pangu 自己的 Swift helper binary, 用 CoreGraphics CGEvent
    // 路径: ~/.pangu/apps/core/runtime/bin/pangu-cg (跟 AGENTS.md 一致, 实际部署位置)
    computer_use_click: async (ctx) => {
      const { params = {} } = ctx;
      const { x, y, button = 'left', double = false } = params;
      if (x === undefined || y === undefined) {
        return { ok: false, error: { code: 'NO_COORDS', message: '需要 x, y 参数' } };
      }
      try {
        const { execFileSync } = require('child_process');
        // 2026-08-22 修: 迁仓后 ~/.pangu/apps/core/runtime/bin 不存在, 改用 REPO_ROOT 相对路径
      const helperPath = path.join(REPO_ROOT, 'apps', 'core', 'runtime', 'bin', 'pangu-cg');
      const args = ['click', String(x), String(y)];
      if (button && button !== 'left') args.push('--button', button);
      if (double) args.push('--double');
      const result = execFileSync(helperPath, args, { timeout: 5000, encoding: 'utf8' });
      return { ok: true, data: { x, y, button, double, ts: new Date().toISOString(), helper_result: result.trim() } };
    } catch (e) {
      return { ok: false, error: { code: 'CLICK_ERROR', message: e.message, stderr: e.stderr ? e.stderr.toString() : '' } };
    }
  },

  // ---- Computer Use: 输入文本 (Swift CGEvent) ----
  computer_use_type: async (ctx) => {
    const { params = {} } = ctx;
    const { text, delay_ms = 0 } = params;
    if (!text || typeof text !== 'string') {
      return { ok: false, error: { code: 'NO_TEXT', message: '需要 text 参数' } };
    }
    try {
      const { execFileSync } = require('child_process');
      // 2026-08-22 修: 迁仓后 ~/.pangu/apps/core/runtime/bin 不存在, 改用 REPO_ROOT 相对路径
      const helperPath = path.join(REPO_ROOT, 'apps', 'core', 'runtime', 'bin', 'pangu-cg');
      const result = execFileSync(helperPath, ['type', text], { timeout: 10000, encoding: 'utf8' });
      if (delay_ms > 0) execFileSync('/bin/sleep', [String(delay_ms / 1000)]);
      return { ok: true, data: { text_length: text.length, delay_ms, ts: new Date().toISOString(), helper_result: result.trim() } };
    } catch (e) {
      return { ok: false, error: { code: 'TYPE_ERROR', message: e.message, stderr: e.stderr ? e.stderr.toString() : '' } };
    }
  },

  // ---- Computer Use: 按键 (Swift CGEvent) ----
  computer_use_key: async (ctx) => {
    const { params = {} } = ctx;
    const { key, modifiers = [] } = params;
    if (!key) {
      return { ok: false, error: { code: 'NO_KEY', message: '需要 key 参数(如 return/tab/space/up)' } };
    }
    try {
      const { execFileSync } = require('child_process');
      // 2026-08-22 修: 迁仓后 ~/.pangu/apps/core/runtime/bin 不存在, 改用 REPO_ROOT 相对路径
      const helperPath = path.join(REPO_ROOT, 'apps', 'core', 'runtime', 'bin', 'pangu-cg');
      // 简单 keycode 映射 (扩展可加)
      const keycodeMap = { 'return': 36, 'enter': 36, 'tab': 48, 'space': 49, 'escape': 53, 'esc': 53, 'delete': 51, 'backspace': 51, 'up': 126, 'down': 125, 'left': 123, 'right': 124 };
      const kc = keycodeMap[String(key).toLowerCase()] || (isNaN(Number(key)) ? 36 : Number(key));
      const result = execFileSync(helperPath, ['key', String(kc)], { timeout: 5000, encoding: 'utf8' });
      return { ok: true, data: { key, keycode: kc, modifiers, ts: new Date().toISOString(), helper_result: result.trim() } };
    } catch (e) {
      return { ok: false, error: { code: 'KEY_ERROR', message: e.message, stderr: e.stderr ? e.stderr.toString() : '' } };
    }
  },

  // ---- Computer Use: 拖拽 (Swift CGEvent) ----
 // ===== todo_write (Claude Code TodoWrite) =====
  todo_write: async (ctx) => {
    const { params = {} } = ctx;
    const { op = 'list', items = [], id, status } = params;
    try {
      // 2026-08-22 修: 迁仓后 ~/.pangu/apps/core 已不存在, 改用 REPO_ROOT 相对路径
const todoMod = require(path.join(REPO_ROOT, 'apps', 'core', 'runtime', 'todo_state.js'));
      if (op === 'add') {
        const added = todoMod.add(items);
        return { ok: true, op: 'add', added: added.length, items: added };
      } else if (op === 'update') {
        if (!id || !status) return { ok: false, error: 'need id + status' };
        const result = todoMod.update(id, status);
        return result.ok ? { ok: true, op: 'update', ...result } : { ok: false, ...result };
      } else {
        const list = todoMod.list();
        return { ok: true, op: 'list', count: list.length, items: list };
      }
    } catch (e) {
      return { ok: false, error: { code: 'TODO_ERROR', message: e.message } };
    }
  },

  computer_use_drag: async (ctx) => {
    const { params = {} } = ctx;
    const { x1, y1, x2, y2, duration = 0.5 } = params;
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
      return { ok: false, error: { code: 'NO_COORDS', message: '需要 x1, y1, x2, y2 参数' } };
    }
    try {
      const { execFileSync } = require('child_process');
      // 2026-08-22 修: 迁仓后 ~/.pangu/apps/core/runtime/bin 不存在, 改用 REPO_ROOT 相对路径
      const helperPath = path.join(REPO_ROOT, 'apps', 'core', 'runtime', 'bin', 'pangu-cg');
      const result = execFileSync(helperPath, ['drag', String(x1), String(y1), String(x2), String(y2)], { timeout: 10000, encoding: 'utf8' });
      return { ok: true, data: { x1, y1, x2, y2, duration, ts: new Date().toISOString(), helper_result: result.trim() } };
    } catch (e) {
      return { ok: false, error: { code: 'DRAG_ERROR', message: e.message, stderr: e.stderr ? e.stderr.toString() : '' } };
    }
  },

  // ---- Computer Use Vision Act: screenshot → vision 模型 → 自动执行闭环 ----
 // D-adapter: vision 模型看截图 → 推断 click/type 坐标 → 执行
 // 兼容任意 LM Studio vision 模型，不再硬编码 Fara-7B
  computer_use_vision_act: async (ctx) => {
    const { params = {}, tools: injectedTools = {} } = ctx;
    const { instruction = '描述截图内容', savePath = '/tmp/pangu_vision_screenshot.png' } = params;

    // Step 1: screenshot
    let screenshotResult;
    try {
      screenshotResult = await TOOLS.screenshot({ params: { path: savePath, delay: 0 } });
      if (!screenshotResult.ok) return { ok: false, error: { code: 'VISION_SCREENSHOT_FAIL', message: '截图失败: ' + screenshotResult.error?.message } };
    } catch (e) {
      return { ok: false, error: { code: 'VISION_SCREENSHOT_FAIL', message: e.message } };
    }

    // Step 2: read screenshot as base64
    let b64;
    try {
      const fs = require('fs');
      const buf = fs.readFileSync(savePath);
      // resize to max 800px wide for vision 模型 (avoid LM Studio timeout on huge images)
      b64 = buf.toString('base64');
    } catch (e) {
      return { ok: false, error: { code: 'VISION_IMAGE_READ_FAIL', message: '读截图失败: ' + e.message } };
    }

    // Step 3: call vision model (LM Studio at localhost:1234) with vision + tools
 // Fara-7B 硬编码改为可配置
 // 默认 fallback 到 ctx.config.llm.current_model_id; vision_act 探测阶段会校验模型是否支持 vision
    const https = require('http');
    const visionUrl = (ctx.config && ctx.config.vision && ctx.config.vision.base_url) || injectedTools._visionBaseUrl || 'http://127.0.0.1:1234';
    const visionModel = (ctx.config && ctx.config.vision && ctx.config.vision.model) || injectedTools._visionModel || (ctx.config && ctx.config.llm && ctx.config.llm.current_model_id) || '';

    const faraTools = [
      {
        type: 'function',
        function: {
          name: 'computer_use_click',
          description: 'Click at screen coordinates x,y',
          parameters: {
            type: 'object',
            properties: {
              x: { type: 'number', description: '屏幕 x 坐标' },
              y: { type: 'number', description: '屏幕 y 坐标' },
              button: { type: 'string', description: 'left/right/middle,默认 left' },
              double: { type: 'boolean', description: '是否双击,默认 false' }
            },
            required: ['x', 'y']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'computer_use_type',
          description: 'Type text into the focused window',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: '要输入的文本' },
              delay_ms: { type: 'number', description: '输入后等待毫秒,默认 0' }
            },
            required: ['text']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'computer_use_key',
          description: 'Press a keyboard key',
          parameters: {
            type: 'object',
            properties: {
              key: { type: 'string', description: '键名:return/tab/space/escape 等' },
              modifiers: { type: 'array', items: { type: 'string' }, description: '修饰键:cmd/shift/option/control' }
            },
            required: ['key']
          }
        }
      }
    ];

    const faraMessages = [{
      role: 'user',
      content: [
        { type: 'text', text: `You are a computer use agent. Instruction: "${instruction}". Analyze the screenshot and take action using available tools. Always output a <tool_call> block with your action.` },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }
      ]
    }];

    const faraBody = JSON.stringify({
      model: visionModel,
      messages: faraMessages,
      tools: faraTools,
      max_tokens: 500,
      temperature: 0.1,
      stream: false,
    });

    const faraParsedUrl = new URL(visionUrl);
    const faraOptions = {
      hostname: faraParsedUrl.hostname,
      port: faraParsedUrl.port || 80,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(faraBody) }
    };

    let faraResult;
    try {
      faraResult = await new Promise((resolve, reject) => {
        const req = https.request(faraOptions, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ raw: d.slice(0, 500) }); } });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Vision 模型调用 timeout 30s (LM Studio :1234 未响应)')) });
        req.write(faraBody);
        req.end();
      });
    } catch (e) {
      return { ok: false, error: { code: 'VISION_FARA_FAIL', message: 'Vision 模型调用失败 (LM Studio ' + visionModel + ' @ ' + visionUrl + '): ' + e.message } };
    }

    const assistantMsg = faraResult?.choices?.[0]?.message;
    const content = assistantMsg?.content || '';

    // Step 4: parse <tool_call>...</tool_call> from content
    const toolCallMatch = content.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
    if (!toolCallMatch) {
      return { ok: true, data: { vision_description: content.slice(0, 500), action: 'no_tool_call', raw_response: content.slice(0, 300) } };
    }

    let toolCallObj;
    try {
      toolCallObj = JSON.parse(toolCallMatch[1]);
    } catch (e) {
      return { ok: false, error: { code: 'VISION_PARSE_FAIL', message: 'Vision 模型 tool_call JSON 解析失败 (模型 ' + visionModel + ' 可能不支持 tool_call 协议): ' + e.message, raw: toolCallMatch[1].slice(0, 200) } };
    }

    const toolName = toolCallObj.name;
    const toolArgs = toolCallObj.arguments || {};

    // Step 5: fix argument format (vision 模型 sometimes sends x:[a,b] instead of x:a, y:b)
    let fixedArgs = { ...toolArgs };
    if (Array.isArray(fixedArgs.x) && fixedArgs.x.length >= 2) {
      fixedArgs.y = fixedArgs.x[1];
      fixedArgs.x = fixedArgs.x[0];
    }
    // also handle case where all coords in one array
    const coordKeys = ['x', 'y', 'x1', 'y1', 'x2', 'y2'];
    for (const k of coordKeys) {
      if (Array.isArray(fixedArgs[k]) && fixedArgs[k].length >= 2 && !Array.isArray(fixedArgs[k][0])) {
        // single-level array, promote first element
        if (k === 'x' && fixedArgs.y === undefined && fixedArgs.x.length >= 2) {
          fixedArgs.y = fixedArgs.x[1];
          fixedArgs.x = fixedArgs.x[0];
        }
      }
    }

    // Step 6: execute the action via Pangu's computer_use_* tools
    let execResult;
    try {
      switch (toolName) {
        case 'computer_use_click':
          execResult = await TOOLS.computer_use_click({ params: { x: Number(fixedArgs.x), y: Number(fixedArgs.y), button: fixedArgs.button || 'left', double: fixedArgs.double || false } });
          break;
        case 'computer_use_type':
          execResult = await TOOLS.computer_use_type({ params: { text: String(fixedArgs.text || ''), delay_ms: Number(fixedArgs.delay_ms || 0) } });
          break;
        case 'computer_use_key':
          execResult = await TOOLS.computer_use_key({ params: { key: String(fixedArgs.key || ''), modifiers: Array.isArray(fixedArgs.modifiers) ? fixedArgs.modifiers : [] } });
          break;
        default:
          return { ok: false, error: { code: 'VISION_UNKNOWN_TOOL', message: 'Vision 模型调了未知工具: ' + toolName + ' (模型 ' + visionModel + ' 可能不支持 tool_call)', args: fixedArgs } };
      }
    } catch (e) {
      return { ok: false, error: { code: 'VISION_EXEC_FAIL', message: '执行工具失败: ' + e.message } };
    }

    return {
      ok: true,
      data: {
        instruction,
        tool_called: toolName,
        args_fixed: fixedArgs,
        execution: execResult,
        screenshot_path: savePath,
        vision_raw: content.slice(0, 200)
      }
    };
  },

  // ---- 缓存工具集(进程内 TTL Map)----
  cache_get: async (ctx) => {
    const { params = {} } = ctx;
    const { key } = params;
    if (!key) return { ok: false, error: { code: 'NO_KEY', message: '未提供缓存 key' } };
    const sk = String(key).slice(0, 200);
    const map = TOOLS.__cache_map;
    const meta = TOOLS.__cache_meta;
    const ttl = TOOLS.__cache_ttl;
    const entry = map.get(sk);
    const m = meta.get(sk) || {};
    if (!entry) return { ok: true, data: { hit: false, key: sk, value: null } };
    if (Date.now() - m.ts > (m.ttl || ttl) * 1000) {
      map.delete(sk); meta.delete(sk);
      return { ok: true, data: { hit: false, key: sk, value: null, expired: true } };
    }
    return { ok: true, data: { hit: true, key: sk, value: entry, ttl_remaining: Math.max(0, Math.round(((m.ttl || ttl) * 1000 - (Date.now() - m.ts)) / 1000)) } };
  },

  cache_put: async (ctx) => {
    const { params = {} } = ctx;
    const { key, value, ttl } = params;
    if (!key) return { ok: false, error: { code: 'NO_KEY', message: '未提供缓存 key' } };
    const sk = String(key).slice(0, 200);
    const map = TOOLS.__cache_map;
    const meta = TOOLS.__cache_meta;
    const defTTL = TOOLS.__cache_ttl;
    const actualTTL = Math.max(1, Math.min(parseInt(ttl) || defTTL, 86400));
    map.set(sk, value);
    meta.set(sk, { ts: Date.now(), ttl: actualTTL });
    return { ok: true, data: { key: sk, stored: true, ttl_set: actualTTL } };
  },

  cache_preheat: async (ctx) => {
    const { params = {} } = ctx;
    const { items = [] } = params;
    if (!Array.isArray(items) || items.length === 0) return { ok: false, error: { code: 'NO_ITEMS', message: '未提供预热数据' } };
    const map = TOOLS.__cache_map;
    const meta = TOOLS.__cache_meta;
    const defTTL = TOOLS.__cache_ttl;
    let count = 0;
    for (const item of items.slice(0, 100)) {
      if (item.key !== undefined) {
        const sk = String(item.key).slice(0, 200);
        map.set(sk, item.value);
        meta.set(sk, { ts: Date.now(), ttl: Math.max(1, Math.min(parseInt(item.ttl) || defTTL, 86400)) });
        count++;
      }
    }
    return { ok: true, data: { preheated: count, total: items.length } };
  },

  cache_evict: async (ctx) => {
    const { params = {} } = ctx;
    const { key, pattern } = params;
    const map = TOOLS.__cache_map;
    const meta = TOOLS.__cache_meta;
    if (key !== undefined) {
      const sk = String(key).slice(0, 200);
      const existed = map.has(sk);
      map.delete(sk); meta.delete(sk);
      return { ok: true, data: { evicted: existed, key: sk } };
    }
    if (pattern) {
      let count = 0;
      for (const k of map.keys()) {
        if (pattern === '*' || k.includes(pattern)) { map.delete(k); meta.delete(k); count++; }
      }
      return { ok: true, data: { evicted_by_pattern: count, pattern } };
    }
    const size = map.size;
    map.clear(); meta.clear();
    return { ok: true, data: { cleared: true, count: size } };
  },

  cache_stats: async (ctx) => {
    const map = TOOLS.__cache_map;
    const meta = TOOLS.__cache_meta;
    const ttl = TOOLS.__cache_ttl;
    let valid = 0, expired = 0;
    for (const [k] of map) {
      const m = meta.get(k) || {};
      if (Date.now() - m.ts > (m.ttl || ttl) * 1000) expired++;
      else valid++;
    }
    return { ok: true, data: { total: map.size, valid, expired, max_ttl_seconds: ttl } };
  },

  // ---- 并行批量执行 ----
  batch_execute: async (ctx) => {
    const { params = {} } = ctx;
    const { commands = [], parallel = true, timeout = 30 } = params;
    if (!Array.isArray(commands) || commands.length === 0) return { ok: false, error: { code: 'NO_COMMANDS', message: '未提供 commands 数组' } };
 // H3 实战发现 + 修: 原 `execFile(require('child_process').execFile)` 是错的, execFile 不接受 execFile 作参数
    // 改为 promisify(execFile) 拿 promise 版
    const { promisify } = require('util');
    const { execFile: cpExecFile } = require('child_process');
    const execFileAsync = promisify(cpExecFile);
    const safeCmds = commands.slice(0, 20);
 // 改: 跨平台 shell
    const _shellBin = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const run = async (cmd) => {
      try {
        const { stdout, stderr } = await execFileAsync(_shellBin, ['-c', cmd], { timeout: Math.min(timeout, 120) });
        return { ok: true, output: stdout || stderr, exit_code: 0 };
      } catch (e) {
        return { ok: false, error: e.message, exit_code: e.code || 1 };
      }
    };
    const results = parallel ? await Promise.all(safeCmds.map(run)) : await (async () => { const r = []; for (const c of safeCmds) r.push(await run(c)); return r; })();
    return { ok: true, data: { count: safeCmds.length, results, parallel }, timestamp: new Date().toISOString() };
  },

  // ---- 团队任务分发 ----
  team_dispatch: async (ctx) => {
    const { params = {} } = ctx;
    const { task, agents = [], priority = 'normal', mode = 'auto' } = params;
    if (!task) return { ok: false, error: { code: 'NO_TASK', message: '未提供任务描述' } };
    const fs = require('fs');
    const QUEUE_DIR = path.join(os.homedir(), '.pangu', 'tasks');
    if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const payload = JSON.stringify({ id, task, agents, priority, status: 'pending', created_at: Date.now(), created_by: 'pangu' });
    const file = path.join(QUEUE_DIR, `task_${id}.json`);
    fs.writeFileSync(file, payload);

 // 修: 启动真实后台子 agent 任务, 与 task_output 打通
    // 轻量模式: 默认只派一个子 agent (避免完整 8 角色调度多次 LLM 卡死)
    // 节点配置路径 —— 不写死任何人的机器名/主机名 (2026-10-26 第 109 批)。
    const configPath = process.env.PANGU_NODE_CONFIG
      || require('../../config/node_config').resolveNodeConfigPathOrEmpty()
      || require('../../config/node_config').resolveNodeConfigPathOrExample();
    const projectDir = path.join(__dirname, '..', '..');

    // 决定用哪个子 agent 执行; mode 可显式指定拼音 (qian/kan/li/kun/dui/xun/zhen/gen)。
    //
    // 2026-10-18 (身份统一): 这段以前返回英文名, 名单也是**第三份手抄**的英文表。
    // 而 PANGU_AGENT_MODE 传进 sub-agent.js 之后要查 ROLES[mode] —— ROLES 的键早就是
    // 拼音了, 于是这里推出来的角色**必然查不到**, 派出去的是没有 system prompt 的
    // 空角色。名单和推出来的值都改从身份真源取, 不再抄。
    const _guaIdentity = require('../../agents/gua-identity');
    const chosenAgent = (() => {
      // mode 是外部传进来的, 可能是英文 (旧脚本/旧调用方/模型先验), 读进来归一
      if (mode !== 'auto') return _guaIdentity.resolveRole(mode) || mode;
      const lower = task.toLowerCase();
      if (lower.includes('bug') || lower.includes('fix') || lower.includes('修')) return 'xun';
      if (lower.includes('检查') || lower.includes('验证') || lower.includes('test')) return 'dui';
      if (lower.includes('分析') || lower.includes('总结') || lower.includes('analyze')) return 'li';
      if (lower.includes('计划') || lower.includes('规划') || lower.includes('plan')) return 'kan';
      return 'kun';
    })();

    const allowedAgents = _guaIdentity.GUA_CODES;
    const agentName = allowedAgents.includes(chosenAgent) ? chosenAgent : 'kun';

    const agentModule = path.join(projectDir, 'agents', 'sub-agent.js');
    const taskJson = JSON.stringify(task).replace(/'/g, "'\\''");
    const command = `PANGU_AGENT_MODE='${agentName}' PANGU_CONFIG_PATH='${configPath}' node '${agentModule}' ${taskJson}`;

    const kick = taskOutput.startTask({
      command,
      commandName: `team_dispatch: ${task.slice(0, 40)} [${agentName}]`,
      toolName: 'team_dispatch',
      cwd: projectDir,
      env: { PANGU_CONFIG_PATH: configPath },
      timeoutMs: 120000, // 子进程 2 分钟超时
      meta: { queue_id: id, agents, priority, mode: agentName },
    });

    return {
      ok: true,
      data: {
        dispatched: true,
        id,
        task_id: kick.task_id,
        task,
        agent_count: agents.length || 1,
        agent_mode: agentName,
        queue_file: file,
      },
      timestamp: new Date().toISOString(),
    };
  },

  // ============================================================
 // P0-3 OS 工具 - 系统级 LAN/PATH/Installer
  // 接入 bootInfo.tools_loaded, 默认白名单 (sandbox.js ALLOWED_TOOLS)
  // ============================================================

  /**
   * get_lan_ip - 取本机 LAN IP (192.168.x.x / 10.x / 172.16-31.x)
   * ctx.params.interface (可选): 网络接口名 (macOS: en0/en1; Linux: eth0/wlan0; 留空 = 自动探测)
   * ctx.params.family (可选): 'ipv4' (默认) | 'ipv6'
   * 返回: { ok, data: { ip, family, interface, all_interfaces: [...] } }
   */
  get_lan_ip: async (ctx) => {
    const { params = {} } = ctx;
    const { interface: iface, family = 'ipv4' } = params;
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    const platform = os.platform();

    try {
      let ip = null;
      let detectedIface = iface || null;
      const allInterfaces = [];

      if (platform === 'darwin') {
        // macOS: ipconfig getifaddr <iface> - 优先 en0, 否则 en1, 否则全扫
        let ifaces;
        if (iface) {
          ifaces = [iface];
        } else {
          // 自动探测: 列出所有网络接口名 (macOS 没 ipconfig listif, 用 networksetup 或 ifconfig -l)
          try {
            const { stdout } = await execFileAsync('/sbin/ifconfig', ['-l'], { timeout: 3000 });
            ifaces = stdout.trim().split(/\s+/).slice(0, 10);
          } catch (e) {
        _safeLog('safeCatch', e.message);
      
            ifaces = ['en0', 'en1'];
          }
        }
        for (const i of ifaces) {
          try {
            const { stdout } = await execFileAsync('/usr/sbin/ipconfig', ['getifaddr', i], { timeout: 3000 });
            const candidate = stdout.trim();
            if (candidate && /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(candidate)) {
              allInterfaces.push({ interface: i, ip: candidate });
              if (!ip && !candidate.startsWith('127.')) {
                ip = candidate; detectedIface = i;
              }
            }
          } catch (e) {
        _safeLog('safeCatch', e.message);
       /* 接口无 IP, 跳过 */ }
        }
      } else if (platform === 'linux') {
        const { stdout } = await execFileAsync('/bin/hostname', ['-I'], { timeout: 3000 }).catch(() => ({ stdout: '' }));
        const candidates = stdout.trim().split(/\s+/).filter(Boolean);
        for (const c of candidates) {
          if (family === 'ipv6' || /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(c)) {
            allInterfaces.push({ ip: c });
            if (!ip && !c.startsWith('127.')) ip = c;
          }
        }
      } else if (platform === 'win32') {
        const { stdout } = await execFileAsync('ipconfig', [], { timeout: 5000 }).catch(() => ({ stdout: '' }));
        const m = stdout.match(/IPv4[^\d]+((?:\d{1,3}\.){3}\d{1,3})/);
        if (m) { ip = m[1]; allInterfaces.push({ ip }); }
      }

      if (!ip) return { ok: false, error: { code: 'NO_LAN_IP', message: '未找到 LAN IP', data: { all_interfaces: allInterfaces } } };
      return { ok: true, data: { ip, family, interface: detectedIface, all_interfaces: allInterfaces, platform }, timestamp: new Date().toISOString() };
    } catch (e) {
      return { ok: false, error: { code: 'GET_LAN_IP_FAILED', message: e.message } };
    }
  },

  /**
   * set_env_path - 修改进程 PATH (append/prepend/set)
   * ctx.params.action: 'append' (默认) | 'prepend' | 'set'
   * ctx.params.value: 要添加/设置的路径
   * ctx.params.replace (set 时必填 true, 防误覆盖)
   * 安全: 黑名单路径 (根目录 /, /etc, /usr/bin 整段) 禁覆盖;
   *      set 必须 explicit replace=true; 否则只能 append/prepend
   * 返回: { ok, data: { before, after, action } }
   */
  set_env_path: async (ctx) => {
    const { params = {} } = ctx;
    const { action = 'append', value, replace = false } = params;
    if (!value || typeof value !== 'string') return { ok: false, error: { code: 'NO_VALUE', message: '未提供 value 路径' } };
    if (!['append', 'prepend', 'set'].includes(action)) return { ok: false, error: { code: 'BAD_ACTION', message: 'action 必须是 append/prepend/set' } };

    // 黑名单: 不能 set 成这些
    const FORBIDDEN_REPLACE = ['/', '/etc', '/usr', '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/private/etc'];
 // append/prepend 也限白名单路径 — 防注入恶意路径
    // 允许的路径前缀: 用户家目录、/opt、/usr/local、/tmp/pangu
    const path = require('path');
    const os = require('os');
    const homeDir = os.homedir();
    const resolved = path.resolve(value);
    const allowedPrefixes = [
      homeDir,
      '/opt',
      '/usr/local',
      '/tmp/pangu',  // 盘古自己的临时目录
      path.join(homeDir, '.local'),
    ];
    const isAllowed = allowedPrefixes.some(p => resolved === p || resolved.startsWith(p + path.sep));
    if (!isAllowed) {
      return { ok: false, error: { code: 'PATH_NOT_ALLOWED', message: `append/prepend 仅允许以下前缀: ${allowedPrefixes.join(', ')}; 实际: ${resolved}` } };
    }
    if (action === 'set') {
      if (!replace) return { ok: false, error: { code: 'NEED_REPLACE_FLAG', message: 'action=set 必须 explicit replace=true, 防止误覆盖 PATH' } };
      const normalized = value.replace(/\/+$/, '');
      if (FORBIDDEN_REPLACE.includes(normalized)) {
        return { ok: false, error: { code: 'FORBIDDEN_REPLACE', message: `禁止 set 成系统关键目录: ${normalized}` } };
      }
    }

    const before = process.env.PATH || '';
    let after;
    if (action === 'append') {
      after = before + ':' + value;
    } else if (action === 'prepend') {
      after = value + ':' + before;
    } else {
      after = value;
    }
    process.env.PATH = after;

    return {
      ok: true,
      data: {
        before, after, action, value,
        delta: after.split(':').length - before.split(':').length,
        timestamp: new Date().toISOString(),
      },
    };
  },

  /**
   * run_installer - 跑 macOS .pkg / .dmg 安装 (高危, 默认 dry-run)
   * ctx.params.path: 安装包绝对路径 (.pkg / .dmg)
   * ctx.params.mode: 'dry-run' (默认, 仅解析 manifest) | 'install' (真跑, 需 user_confirmed=true)
   * ctx.params.target (install 时): '/' (默认) | '/Volumes/<name>' | 自定义
   * ctx.params.user_confirmed: 必须 true 才能 install (防止 LLM 自动跑)
   * 返回 dry-run: { ok, data: { mode, manifest, warnings } }
   * 返回 install: { ok, data: { mode, exit, stdout, stderr } }
   */
  run_installer: async (ctx) => {
    const { params = {} } = ctx;
    const { path: pkgPath, mode = 'dry-run', target = '/', user_confirmed = false, run_in_background = false } = params;
    if (!pkgPath) return { ok: false, error: { code: 'NO_PATH', message: '未提供 .pkg/.dmg 路径' } };
    if (!['dry-run', 'install'].includes(mode)) return { ok: false, error: { code: 'BAD_MODE', message: 'mode 必须是 dry-run / install' } };

    const fs = require('fs');
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    if (!fs.existsSync(pkgPath)) return { ok: false, error: { code: 'NOT_FOUND', message: `路径不存在: ${pkgPath}` } };

    const ext = path.extname(pkgPath).toLowerCase();
    const warnings = [];

    // mode === 'install' 时: 先检查 user_confirmed, 再检查 ext, 最后跑
    if (mode === 'install') {
      if (!user_confirmed) {
        return { ok: false, error: { code: 'NEED_USER_CONFIRM', message: 'install 模式必须 user_confirmed=true (防 LLM 自动跑安装)' } };
      }
      if (ext !== '.pkg') return { ok: false, error: { code: 'INSTALL_REQUIRES_PKG', message: 'install 模式当前只支持 .pkg (.dmg 需要先挂载再装, 见 run_installer dry-run)' } };
    }

    if (mode === 'dry-run') {
      // 仅解析, 不真跑
      try {
        if (ext === '.pkg') {
          const { stdout: infoOut } = await execFileAsync('/usr/sbin/installer', ['-pkginfo', '-pkg', pkgPath, '-target', '/'], { timeout: 10000 }).catch(() => ({ stdout: '' }));
          const { stdout: pkgIdOut } = await execFileAsync('/usr/sbin/installer', ['-pkg', pkgPath, '-showChoicesXML', '-target', '/'], { timeout: 10000 }).catch(() => ({ stdout: '<unavailable>' }));
          return {
            ok: true,
            data: {
              mode, type: 'pkg', path: pkgPath, info: infoOut.trim().split('\n').filter(Boolean),
              pkg_id_extracted: (infoOut.match(/package-id="([^"]+)"/) || [])[1] || null,
              warnings: warnings.length ? warnings : ['未实际安装, 仅展示 manifest'],
              timestamp: new Date().toISOString(),
            },
          };
        } else if (ext === '.dmg') {
          const { stdout } = await execFileAsync('/usr/bin/hdiutil', ['info', '-plist', pkgPath], { timeout: 10000 }).catch(() => ({ stdout: '' }));
          return {
            ok: true,
            data: {
              mode, type: 'dmg', path: pkgPath, hdiutil_info_summary: stdout.slice(0, 2048),
              warnings: warnings.length ? warnings : ['未实际挂载/安装, 仅解析 dmg 元信息'],
              timestamp: new Date().toISOString(),
            },
          };
        } else {
          return { ok: false, error: { code: 'UNSUPPORTED_EXT', message: `暂只支持 .pkg/.dmg, 当前: ${ext}` } };
        }
      } catch (e) {
        return { ok: false, error: { code: 'DRYRUN_FAILED', message: e.message } };
      }
    }

    // mode === 'install' (含 run_in_background 借鉴 #3 异步路径)
 // 借鉴 #3: install 长任务(可跑 1-5 分钟) 走异步, 立即返 task_id
    if (run_in_background) {
      const kick = taskOutput.startTask({
        args: ['/usr/sbin/installer', '-pkg', pkgPath, '-target', target],
        commandName: '/usr/sbin/installer -pkg ' + path.basename(pkgPath) + ' -target ' + target,
        toolName: 'run_installer',
        timeoutMs: 600000,  // 10 分钟硬上限, install 任务
        meta: { original_tool: 'run_installer', mode, target, pkg: pkgPath },
      });
      return {
        ok: true,
        data: {
          task_id: kick.task_id,
          status: kick.status,
          progress_message: kick.progressMessage,
          run_in_background: true,
          message: '安装已在后台启动, LLM 下次轮询用 task_output(task_id="' + kick.task_id + '")',
          next_tool_hint: 'task_output',
          next_tool_args_hint: { task_id: kick.task_id, block: true, wait: true, wait_timeout: 30000 },
          timestamp: new Date().toISOString(),
        },
      };
    }

    // mode === 'install' 同步 (默认)
    try {
      const { stdout, stderr } = await execFileAsync('/usr/sbin/installer', ['-pkg', pkgPath, '-target', target], { timeout: 300000 });
      return {
        ok: true,
        data: {
          mode, type: 'pkg', path: pkgPath, target, exit: 0,
          stdout: stdout.slice(0, 4096), stderr: stderr.slice(0, 1024),
          timestamp: new Date().toISOString(),
        },
      };
    } catch (e) {
      return {
        ok: false,
        data: { mode, path: pkgPath, exit: e.code || 1, stdout: e.stdout?.slice(0, 4096) || '', stderr: e.stderr?.slice(0, 1024) || '', error: e.message },
      };
    }
  },

  // ============================================================
 // 借鉴 #3 (ClaudeCode Leaked TaskOutputTool) - 异步后台任务查询/轮询
  // LLM 拿到 exec_command(run_in_background: true) 或 run_installer 返的 task_id 后,
  // 下次 turn 调 task_output(task_id) 拿结果。
  // block=true 同步等结果, block=false 立即返 progressMessage (非阻塞)
  // kill=true 杀后台任务
  // ============================================================
  task_output: async (ctx) => {
    const { params = {} } = ctx;
    const { task_id, block = false, wait = true, wait_timeout = 30000, kill = false } = params;
    if (!task_id) return { ok: false, error: { code: 'NO_TASK_ID', message: '未提供 task_id' } };

    // 持久工作流兼容 task_output 协议。旧调用方仍用 task_id 轮询，
    // 但真实状态/结果由 workflow_engine 的 SQLite 表提供，重启不丢失。
    if (String(task_id).startsWith('wf_')) {
      const workflowEngine = require(path.join(__dirname, '..', 'workflow_engine'));
      const workflow = workflowEngine.getWorkflow(task_id);
      if (!workflow) return { ok: false, error: { code: 'TASK_NOT_FOUND', message: '工作流不存在' } };
      const terminal = ['completed', 'failed', 'cancelled'].includes(workflow.status);
      return {
        ok: true,
        data: {
          task_id,
          tool_name: 'workflow_engine',
          status: workflow.status,
          is_final: terminal,
          result: workflow.result,
          error: workflow.error,
          workflow,
          events: workflowEngine.listEvents(task_id, 0, 50),
        },
      };
    }

    // 杀
    if (kill) {
      const ok = taskOutput.killTask(task_id);
      const snap = taskOutput.getOutput(task_id);
      return { ok, data: { killed: ok, task: snap } };
    }

    // 查询
    const result = await taskOutput.getOutput(task_id, { block, wait, timeoutMs: wait_timeout });
    if (!result.ok) return { ok: false, error: { code: 'TASK_NOT_FOUND', message: result.error } };

    // LLM 友好: 当任务完成时, 完整字段透传
    return {
      ok: true,
      data: {
        task_id: result.task_id,
        tool_name: result.tool_name,
        command_name: result.command_name,
        status: result.status,
        is_final: result.is_final,
        exit_code: result.exit_code,
        signal: result.signal,
        error: result.error,
        progress_message: result.progress_message,
        elapsed_ms: result.elapsed_ms,
        started_at: result.started_at,
        ended_at: result.ended_at,
        // 关键: stdout/stderr 内联 (如果没落盘), 否则只返预览 + 路径
        stdout: result.stdout_chars > 0 && !result.output_file_path ? '(inline ' + result.stdout_chars + ' chars, 见 stdout_preview 末尾 8K)' : '',
        stderr: result.stderr_chars > 0 && !result.output_file_path ? '(inline ' + result.stderr_chars + ' chars, 见 stderr_preview 末尾 8K)' : '',
        stdout_preview: result.stdout_preview,
        stderr_preview: result.stderr_preview,
        stdout_chars: result.stdout_chars,
        stderr_chars: result.stderr_chars,
        output_file_path: result.output_file_path,
        output_file_size: result.output_file_size,
        hint: result.is_final
          ? (result.output_file_path
              ? '任务已完成, 完整输出已落盘 (大于 100K 触发), 用 read_file("' + result.output_file_path + '") 读'
              : '任务已完成, stdout/stderr 已直接嵌入 (小输出)')
          : '任务未完成, block=true 同步等; block=false 立即返当前 progress',
      },
    };
  },

  // ---- 持久长工作流 ----
  workflow_create: async (ctx) => {
    const { params = {}, context = {} } = ctx;
    const workflowEngine = require(path.join(__dirname, '..', 'workflow_engine'));
    const result = workflowEngine.createWorkflow({ ...params, session_id: params.session_id || context.sessionId || 'default' });
    return result.ok
      ? { ok: true, data: { workflow: result.workflow, task_id: result.workflow.id, next_tool_hint: 'task_output or workflow_status' } }
      : { ok: false, error: { code: 'WORKFLOW_CREATE_FAILED', message: result.error } };
  },

  workflow_status: async (ctx) => {
    const { workflow_id } = ctx.params || {};
    if (!workflow_id) return { ok: false, error: { code: 'NO_WORKFLOW_ID', message: '未提供 workflow_id' } };
    const workflowEngine = require(path.join(__dirname, '..', 'workflow_engine'));
    const workflow = workflowEngine.getWorkflow(workflow_id);
    if (!workflow) return { ok: false, error: { code: 'WORKFLOW_NOT_FOUND', message: '工作流不存在' } };
    return { ok: true, data: { workflow, events: workflowEngine.listEvents(workflow_id, 0, 50) } };
  },

  workflow_review: async (ctx) => {
    const { workflow_id, approved, note = '' } = ctx.params || {};
    if (!workflow_id || typeof approved !== 'boolean') return { ok: false, error: { code: 'INVALID_REVIEW', message: 'workflow_id 和 approved(boolean) 必填' } };
    const workflowEngine = require(path.join(__dirname, '..', 'workflow_engine'));
    const result = workflowEngine.approveReview(workflow_id, approved, note);
    return result.ok ? { ok: true, data: { workflow: result.workflow } } : { ok: false, error: { code: 'WORKFLOW_REVIEW_FAILED', message: result.error } };
  },

  // ============================================================
    // TTS 进 Pangu
  // macOS say + 自定义 voice, 产 .aiff 文件
  // 不调外部 music_generate (§9 独立原则)
  // ============================================================

  /**
   * tts_speak - macOS say 文本转语音
   * ctx.params.text: 要念的文本(必填)
   * ctx.params.voice: 声线名(可选, 默认 Tingting 中文)
   * ctx.params.output: 输出文件路径(可选)
   * ctx.params.speed: 语速(可选, 默认 200 wpm)
   * ctx.params.play: 是否立即播放(可选, 默认 false - 只产文件)
   * 返回: { ok, data: { path, voice, duration_sec, size_bytes } }
   */
  tts_speak: async (ctx) => {
    const { params = {} } = ctx;
    const { text, voice, output, speed = 200, play = false } = params;
    if (!text) return { ok: false, error: { code: 'NO_TEXT', message: '未提供要念的文本' } };

    const fs = require('fs');
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    const outPath = output || `/tmp/pangu-tts-${Date.now()}.aiff`;

    const args = [];
    if (voice) args.push('-v', voice);
    args.push('-r', String(speed));
    args.push('-o', outPath);
    args.push(text);

    try {
      await execFileAsync('/usr/bin/say', args, { timeout: 60000 });
      const stats = fs.statSync(outPath);
      // aiff 16kHz mono ≈ 32KB/sec
      const durationSec = Math.round((stats.size / 32000) * 10) / 10;

      let played = false;
      if (play) {
        try {
          await execFileAsync('/usr/bin/afplay', [outPath], { timeout: 60000 });
          played = true;
        } catch (e) { /* 播放失败不阻断 */ }
      }

      return {
        ok: true,
        data: {
          path: outPath,
          voice: voice || 'default',
          speed, play, played,
          size_bytes: stats.size,
          duration_sec: durationSec,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (e) {
      return { ok: false, error: { code: 'TTS_FAILED', message: e.message } };
    }
  },

  /**
   * tts_voices - 列出可用声线,优先中文
   * 返回: { ok, data: { total, chinese, recommended_chinese, all } }
   */
  tts_voices: async (ctx) => {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);
    try {
      const { stdout } = await execFileAsync('/usr/bin/say', ['-v', '?'], { timeout: 5000 });
      const lines = stdout.split('\n').filter(l => l.trim());
      const voices = lines.map(line => {
        const m = line.match(/^(\S+)\s+(\S+)\s+#\s+(.+)$/);
        if (m) return { name: m[1], lang: m[2], demo: m[3] };
        return { name: line.trim(), lang: '?', demo: '' };
      });
      const chineseVoices = voices.filter(v =>
        v.lang === 'zh_CN' || v.lang === 'zh_TW' ||
        ['Tingting', 'Sin-ji', 'Mei-Jia', 'Tian-Tian'].includes(v.name)
      );
      return {
        ok: true,
        data: {
          total: voices.length,
          chinese: chineseVoices,
          all: voices,
          recommended_chinese: chineseVoices[0] || { name: 'Tingting', lang: 'zh_CN' },
        },
      };
    } catch (e) {
      return { ok: false, error: { code: 'LIST_FAILED', message: e.message } };
    }
  },

  /**
   * stock_quote - A股实时行情(东方财富 free API)
   * ctx.params: { code: '600000' 或 '000001' 或 'sz000001' 或 'sh600000' }
   * 自动识别: 6 位数字 → 沪市(1), 0 开头深市(0); 'sh'/'sz' 前缀直接用
   * 返回: { ok, data: { code, name, price, change, change_pct, open, high, low, prev_close,
   *                     volume, amount, timestamp } }
   */
  /**
   * stock_resolve - 按名称/拼音查股票代码 (2026-10-09)
   * 起因: 内蒙新华被模型先后说成 600295(鄂尔多斯) / 600311, 根因是盘古没有"名称→代码"工具,
   * 模型只能凭记忆猜代码, 然后拿错票的数据当目标票汇报。有了解析工具就不必猜。
   * ctx.params: { name: '内蒙新华' | 'NMXH' | '603230', limit: 5 }
   */
  stock_resolve: async (ctx) => {
    const raw = (ctx.params.name || ctx.params.q || ctx.params.query || ctx.params.code || '').toString().trim();
    if (!raw) return { ok: false, error: { code: 'NO_NAME', message: '需要股票名称或代码, 如 name=内蒙新华' } };
    // 已经是 6 位代码 → 直接回显并校验名称(不猜市场, 让调用方自己确认)
    if (/^\d{6}$/.test(raw)) {
      return { ok: true, data: { query: raw, matches: [{ code: raw, name: null, market: raw.startsWith('6') || raw.startsWith('9') ? '上海' : '深圳', source: 'passthrough' }] } };
    }
    const limit = Math.min(Math.max(parseInt(ctx.params.limit) || 5, 1), 20);
    // 东财 suggest 接口(push2 行情被限流时它仍然可用 — 实测 2026-10-09)
    const url = 'https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(raw) +
      '&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=' + limit;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      const json = await res.json();
      const rows = ((json || {}).QuotationCodeTable || {}).Data || [];
      const matches = rows.map((r) => ({
        code: r.UnifiedCode || r.Code,
        name: r.Name,
        pinyin: r.PinYin,
        market: r.SecurityTypeName || (r.MktNum === '1' ? '上海' : '深圳'),
        secid: r.QuoteID,
      })).filter((m) => m.code);
      if (!matches.length) {
        return { ok: false, error: { code: 'NOT_FOUND', message: `没搜到"${raw}"对应的股票, 请确认名称或改用代码` } };
      }
      return { ok: true, data: { query: raw, matches, best: matches[0], source: 'eastmoney-suggest' } };
    } catch (e) {
      return { ok: false, error: { code: 'RESOLVE_FAILED', message: e.message } };
    }
  },

  stock_quote: async (ctx) => {
    const code = (ctx.params.code || '').toString().trim();
    if (!code) return { ok: false, error: { code: 'NO_CODE', message: '需要股票代码' } };

    // 解析 secid: market.code (1=沪, 0=深)
    let market, pureCode;
    if (/^sh/i.test(code)) { market = 1; pureCode = code.replace(/^sh/i, ''); }
    else if (/^sz/i.test(code)) { market = 0; pureCode = code.replace(/^sz/i, ''); }
    else if (/^\d{6}$/.test(code)) {
      // A 股惯例: 6/9 开头沪市, 0/3 开头深市, 5/1/2 开头基金/债券
      if (code.startsWith('6') || code.startsWith('9')) market = 1;
      else if (code.startsWith('0') || code.startsWith('3')) market = 0;
      else market = 1; // fallback 沪
      pureCode = code;
    } else if (/^\d{5}$/.test(code)) { market = 1; pureCode = code; } // 港股等
    // 2026-10-12: 原来只说"无法识别的代码", 模型拿不到任何下一步线索 (它会转去试 crypto_price,
    // 然后三个源全超时)。把支持范围写进报错, 让模型当场知道这条路走不通。
    else return { ok: false, error: { code: 'BAD_CODE', message: '无法识别的代码: ' + code + ' (stock_quote 只支持 A 股: 6 位数字如 600000, 或 sh600000 / sz000001; 美股港股目前无数据源)' } };

    const secid = market + '.' + pureCode;
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' }, signal: AbortSignal.timeout(8000) });
      const json = await res.json();
      const d = json.data || {};
      if (!d || !d.f43) {
        const fb = await _stockQuoteFallback(pureCode, market);
        if (fb) return fb;
        return { ok: false, error: { code: 'NO_DATA', message: 'API 返空数据' } };
      }
      return {
        ok: true,
        data: {
          code: pureCode,
          market: market === 1 ? '上海' : '深圳',
          secid: secid,
          name: d.f58 || pureCode,
          price: (d.f43 / 100).toFixed(2),      // f43=价(分)
          change: (d.f169 / 100).toFixed(2),   // f169=涨跌(分)
          change_pct: (d.f170 / 100).toFixed(2),// f170=涨跌幅(万分)
          open: (d.f46 / 100).toFixed(2),
          high: (d.f44 / 100).toFixed(2),
          low: (d.f45 / 100).toFixed(2),
          prev_close: (d.f60 / 100).toFixed(2),
          volume: d.f47,                          // 成交量(手)
          amount: d.f48,                          // 成交额(元)
          amplitude_pct: d.f57 ? (d.f57 / 100).toFixed(2) : null,  // f57=振幅(万分)
          timestamp: new Date().toISOString(),
        },
      };
    } catch (e) {
      const fb = await _stockQuoteFallback(pureCode, market);
      if (fb) return fb;
      return { ok: false, error: { code: 'FETCH_FAILED', message: e.message } };
    }
  },

  /**
   * stock_history - A股 K线(东方财富 free API)
   * ctx.params: { code: '600000', days: 30, klt: 101 }
   * klt: 101=日线, 102=周线, 103=月线, 1=1分线, 5=5分线, 15=15分线, 30=30分线, 60=60分线
   * fqt: 0=不复权, 1=前复权, 2=后复权
   * 返回: { ok, data: { code, klines: [{date,open,close,high,low,volume,amount,amplitude_pct,change_pct,change}], count } }
   */
  stock_history: async (ctx) => {
    const code = (ctx.params.code || '').toString().trim();
    const days = Math.min(Math.max(parseInt(ctx.params.days) || 30, 1), 365);
    const klt = parseInt(ctx.params.klt) || 101;
    const fqt = parseInt(ctx.params.fqt !== undefined ? ctx.params.fqt : 1);
    if (!code) return { ok: false, error: { code: 'NO_CODE', message: '需要股票代码' } };

    let market, pureCode;
    if (/^sh/i.test(code)) { market = 1; pureCode = code.replace(/^sh/i, ''); }
    else if (/^sz/i.test(code)) { market = 0; pureCode = code.replace(/^sz/i, ''); }
    else if (/^\d{6}$/.test(code)) {
      market = (code.startsWith('6') || code.startsWith('9')) ? 1 : 0;
      pureCode = code;
    } else { return { ok: false, error: { code: 'BAD_CODE', message: '无法识别' } }; }

    const secid = market + '.' + pureCode;
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${klt}&fqt=${fqt}&end=20500000&lmt=${days}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' }, signal: AbortSignal.timeout(8000) });
      const json = await res.json();
      const raw = (json.data && json.data.klines) || [];
      const klines = raw.map(line => {
        const p = line.split(',');
        return {
          date: p[0],
          open: parseFloat(p[1]),
          close: parseFloat(p[2]),
          high: parseFloat(p[3]),
          low: parseFloat(p[4]),
          volume: parseInt(p[5]),       // 手
          amount: parseFloat(p[6]),    // 元
          amplitude_pct: parseFloat(p[7]),
          change_pct: parseFloat(p[8]),
          change: parseFloat(p[9]),
          turnover_pct: parseFloat(p[10]),  // 换手率%
        };
      });
      return {
        ok: true,
        data: {
          code: pureCode,
          market: market === 1 ? '上海' : '深圳',
          klt, fqt,
          count: klines.length,
          klines,
        },
      };
    } catch (e) {
      const fb = await _stockHistoryFallback(pureCode, market, days, fqt);
      if (fb) return fb;
      return { ok: false, error: { code: 'FETCH_FAILED', message: e.message } };
    }
  },

};

// =================================================================
// 借鉴 #2: 标记 safe 工具 (可并发执行)
// 默认 unsafe (write_file / exec_command / run_installer / 一切未标)
// safe = 只读 + 无副作用 + 不依赖其他工具状态的工具
// =================================================================
try {
  if (TOOLS.read_file)        TOOLS.read_file._concurrency = 'safe';
  if (TOOLS.file_grep)        TOOLS.file_grep._concurrency = 'safe';
  if (TOOLS.file_find)        TOOLS.file_find._concurrency = 'safe';
  if (TOOLS.list_directory)   TOOLS.list_directory._concurrency = 'safe';
  if (TOOLS.web_search)       TOOLS.web_search._concurrency = 'safe';
  if (TOOLS.stock_resolve)     TOOLS.stock_resolve._concurrency = 'safe';
  if (TOOLS.cache_get)        TOOLS.cache_get._concurrency = 'safe';
  if (TOOLS.cache_stats)      TOOLS.cache_stats._concurrency = 'safe';
  // 纯位运算查表 (64i 真源, 零副作用, 并发安全)
  if (TOOLS.hexagram_transform) TOOLS.hexagram_transform._concurrency = 'safe';
  if (TOOLS.gua_infer) TOOLS.gua_infer._concurrency = 'safe';
} catch (e) {
        _safeLog('safeCatch', e.message);
      
  // 不影响 module 加载, 仅并发标记失败
}

// =================================================================
// 真实八字排盘 (sxtwl 万年历 + LLM 解读)
// 不要让 LLM 脑补日柱 — 调 sxtwl 真实万年历
// 老板原话: "1991年11月23日早上7点, 女, 江苏盐城射阳, 算八字"
// Pangu LLM 两次都编了日柱 (丁卯/丁丑), sxtwl 真万年历 = 丁酉
// =================================================================
function _baziCalcPython(year, month, day, hour, minute = 0, gender = 'unknown', city = 'default', useSolarTime = true, isLunar = false, isLeapMonth = false, district = '', province = '') {
  // 调 sxtwl 真实万年历排盘 (脚本: tools/bazi/bazi_calc.py — 单一真源, modules/bazi/ 已弃用)
 // 修: 必须用 /usr/bin/python3 (系统 Python 有 sxtwl), Homebrew python 没装
  const { execFileSync } = require('child_process');
  const path = require('path');
  // 2026-09-22 老板拍: bazi_calc 真源统一到 tools/bazi/ (9/9 版), 不再从 modules/bazi/ (旧版) 跑
  // 两份文件同名, 工具层实际只认这一处 — 改错文件不生效的坑 (handoff 已记, 现在从根上删歧义)
  const scriptPath = path.join(__dirname, 'bazi', 'bazi_calc.py');
  const pythonPath = '/usr/bin/python3';
  try {
    // 2026-11-01 第 189 批: 「半夜十二点半」(hour=0) 被 `hour || 12` 当成缺省值 12 点
    //   ⇒ 子时出生的人被排成**午时**, 时柱整套错(1987-08-15 24:30 子时排成甲午, 正确是庚子)。
    //   修法: 0 点按 **24 点** 传 —— python 端 sxtwl getHourGZ(24) 走的是
    //   「早子时派」(23:00 起的时干按次日日干推、日柱不变), 与 bazi_calc 自己
    //   声明的 zishi_convention 一致; 其余缺省仍是 12 点。
    const _hour = (hour === 0 || hour === '0') ? 24 : (hour || 12);
    const args = [scriptPath, String(year), String(month), String(day), String(_hour), String(minute || 0), String(gender || 'unknown')];
    if (city && city !== 'default') args.push('--city', String(city));
    // 2026-10-28 第 131 批: 省/区/县也要传下去 —— 真太阳时经度**按区县查最准**,
    //   而且查不到时能落到省级参考值, 而不是静默退回东八区中心。
    if (district) args.push('--district', String(district));
    if (province) args.push('--province', String(province));
    if (!useSolarTime) args.push('--no-solar-time');
    if (isLunar) args.push('--lunar');
    if (isLeapMonth) args.push('--leap-month');
    const out = execFileSync(pythonPath, args, { timeout: 10000, encoding: 'utf-8' });
    return JSON.parse(out.trim());
  } catch (e) {
    return { error: 'bazi script failed: ' + (e.stderr || e.message).slice(0, 200) };
  }
}
/**
 * 性别归一化 —— 工具边界的**唯一**性别真源 (2026-10-21)
 *
 * 为什么必须在边界做: `bazi_calc.py` 只认 'male' / 'female',
 * 认不得就**静默当成女命**, 大运顺逆全反且不报错。
 * 人和模型都自然写「男」, 所以人话必须在这里翻译成那一个值。
 *
 * 认不出来时返回 'unknown' —— 交给 python **如实说不知道**,
 * 而不是在这儿替它猜一个。猜出来的方向是错的, 而且看不出来。
 *
 * @param {*} raw
 * @returns {'male'|'female'|'unknown'}
 */
function _normalizeGender(raw) {
  if (raw === null || raw === undefined) return 'unknown';
  if (typeof raw === 'boolean') return raw ? 'male' : 'female';
  if (typeof raw === 'number') {
    if (raw === 1) return 'male';
    if (raw === 0) return 'female';
    return 'unknown';
  }
  const s = String(raw).trim().toLowerCase();
  if (['男', '男性', '男命', '乾', 'male', 'm', 'man', 'boy', '1', 'true'].includes(s)) return 'male';
  if (['女', '女性', '女命', '坤', 'female', 'f', 'woman', 'girl', '0', 'false'].includes(s)) return 'female';
  return 'unknown';
}

TOOLS.bazi_calc = async (ctx) => {
  const { params = {} } = ctx;
  const { year, month, day, hour = 12, minute = 0, gender = 'unknown', province = '', city = 'default', district = '', use_solar_time = true, is_lunar = false, is_leap_month = false } = params;
  //
  // ⚠️ 性别必须在**进 Python 之前**规范化 (2026-10-21 E2E 实跑撞出来的)。
  //
  // 现场: 主人说「男」, 任务简报里也写着「男」, 但 `bazi_calc.py` 里写的是
  //     is_yang_gender = (gender == 'male')      ← 只认英文字面量
  // 于是传 '男' → 不等于 'male' → **被当成女命** → 丁卯(阴年)女命顺排。
  // 而正确的是阴年男命**逆排** —— 整张盘的大运方向、起运岁数、10 步干支全反,
  // 而且**一声不吭**: 没有报错, 没有警告, 返回的是一份看起来完全正常的排盘。
  //
  // 这属于"索引/取值错了不抛异常, 只是安静地返回另一个东西"那一族 ——
  // 与 64卦 0..63 那条同形, 与 hexagram_lookup 白名单漏了同形。
  //
  // 规范化放在**工具边界**(这里)而不是 python 里: python 只该认一个值,
  //   人话(男/女/男命/M/1)由边界翻译, 免得同一个词在两处各认一遍。
  const _gender = _normalizeGender(gender);
  //
  // liunian_months —— 要不要每个流年底下那 12 条**流月**明细。
  //
  // 2026-10-21 E2E 实跑逼出来的 (不是预判, 是现场数字):
  //   liunian 有 90 条 (90 年), 每条 533 字符, 其中 **484 字符 (91%) 是流月**,
  //   流年本身只有 48 字符。90 × 484 = 43,556 字符, 占整个工具结果的 82%。
  //   于是: 结果 53,423 → 撞上 24,000 预算 → _fitToolResult 结构化砍半 →
  //   模型收到 `_truncated` 标记, 知道"还有数据你看不到" →
  //   实跑接着 16 次 exec_command 满世界 find/grep 那块它看不到的数据,
  //   最后还扒上了 /private/tmp 里一个陈年 sse 文件, 14 轮都在 grep 它。
  //
  // 「数据在那儿」和「模型看得见」是两回事: 看得见的部分模型才会用,
  // 被砍掉的部分反而会招来一整轮无效的"找数据"行动。
  //
  // 所以默认**不带流月明细**, 90 年的流年干支/十神一样不少 (那才是常问的),
  // 真要流月再说一声 —— 并且下面 note 里明写这件事, 不静默省。
  const wantLiunianMonths = params.liunian_months === true || params.liunian_months === 'true';
  if (!year || !month || !day) {
    return { ok: false, error: { code: 'MISSING_DATE', message: '需要 year/month/day 三个参数' } };
  }
  const pillars = _baziCalcPython(Number(year), Number(month), Number(day), Number(hour), Number(minute), _gender, city, use_solar_time !== false, is_lunar === true, is_leap_month === true, district, province);
  if (pillars.error) return { ok: false, error: { code: 'BAZI_FAIL', message: pillars.error } };
  if (!wantLiunianMonths && Array.isArray(pillars.liunian)) {
    // 只摘流月这一层, 流年本身原样留着 —— 不重算、不重排、不改任何字段值。
    pillars.liunian = pillars.liunian.map((y) => {
      if (!y || !Array.isArray(y.流月)) return y;
      const c = Object.assign({}, y);
      delete c.流月;
      return c;
    });
    pillars.liunian_months_omitted = pillars.liunian.length;
  }
  //
  // 2026-10-21 (老板拍「那你干吧」, decision.md §P0-1/P0-2):
  // 排完盘顺手把「五行六格判断」一并算出来, 让模型**拿结构化判断**去解读,
  // 而不是自己临场编一段旺衰的话。
  //
  // 为什么要接在这里 (不是另开一个工具):
  //   这层判断**必须**以 bazi_calc 的真实排盘为输入 (日主五行 + 月令 + 八字计数),
  //   脱离排盘单独调它没有意义。挂在 bazi_calc 后面, 数据流是直的。
  //
  // 判据出处: 桌面<course-source>/<course-file>
  //   「生我者为生 / 同我者为比 / 克我者为克 / 我生者为泄 / 我克者为耗 *此处"我"为日主」
  //   「五行过强: 四柱中有 3 个及以上个」
  //   「五行过弱: ... 或者四柱里没有这个五行」← 这是"不成立"态的原始依据
  //
  // 判据层算不出来时**不许挡住排盘** —— 排盘是硬的, 判断是软的, 硬的优先。
  let strength = null;
  // 给模型看的**结论式**摘要 (已算好, 照着讲就行)。
  // 为什么要单独一条字符串, 而不是让模型自己去读 strength 对象:
  //   E2E 实跑两轮, 模型拿到 strength 里的六格判断后不去用, 反而满世界
  //   exec_command 去"核实"判据出处 (43~48 次, 整轮陷进去, 第一次连 final 都没有)。
  //   模型需要的是**结论**, 不是可追查的线索 —— 结论式一行字最省它动。
  let strengthConclusion = null;
  try {
    const _bs = require('../bazi_strength.js');
    const _judged = _bs.judgeFromChart(pillars);
    if (_judged) {
      strength = {
        cells: _judged.cells,
        strong: _judged.strong,
        weak: _judged.weak,
        notEstablished: _judged.notEstablished,
        counts: _judged.counts,
        countsTotal: _judged.countsTotal,
        deLing: _judged.month.deLing,
        text: _bs.formatJudgement(_judged),
        source: _judged.source,
      };
      strengthConclusion = _bs.formatConclusion(_judged);
    }
  } catch (e) {
    console.warn('[bazi_calc] strength layer failed (排盘不受影响):', e.message);
  }
  return {
    ok: true,
    data: {
      //
      // ⚠ gender 必须用**归一化后**的 `_gender`, 不能用原始的 `gender` (2026-10-31 第 176 批)。
      //   原始值可能是「男」/「男命」/「M」这类人话 —— 前端按 `=== 'male'` 判断,
      //   拿到「男」就走 else 分支 ⇒ **男命显示成「女」**。
      //   而排盘本身用的就是 `_gender`, 所以这里必须跟排盘口径一致, 不许两处各认一遍。
      input: { year, month, day, hour, minute, gender: _gender, province, city, district, birthplace: [province, city, district].filter(Boolean).join(' '), use_solar_time, is_lunar, is_leap_month },
      //
      // 2026-10-21 (老板拍「那你干吧」):
      // 六格判断放在**排盘之前**, 不是之后。
      //
      // 为什么 (实跑发现的, 不是想当然):
      //   bazi_calc 完整返回 52,880 字符, 裁剪到 24,000 后还剩 16,568。
      //   strength 字段**没被砍** (裁剪只砍数组, liunian 被砍两轮),
      //   但它躺在 JSON 尾部 16,004 字符处 —— 模型翻 16K 才找得到,
      //   结果 E2E 实跑: 模型**没看** strength, 照样按自己的理解讲旺衰。
      //   「数据在那儿」不等于「模型会用」—— 信噪比也是结构问题。
      //
      // 所以: 判据放最前, 排盘摘要紧随其后。模型先看到"该按什么判", 再看到"盘是什么"。
      //
      // 内容与 `data.strength` 完全相同 (同一份对象, 不抄第二份),
      // 只是位置在前面 —— 铁律: 一份东西抄四遍 = 迟早只改其中一份。
      strengthConclusion,
      strength,
      // 排盘要点摘要 (模型第一眼能看到的事实, 省得它从 52K 里刨)
      chartSummary: pillars ? {
        //
        // 四柱写成**扁平一行字符串**, 不写成嵌套对象 (2026-10-21 E2E 实跑第 6 轮):
        //   嵌套形态 {"四柱":{"年柱":"庚午","月柱":"癸未","日柱":"戊子","时柱":"己未"}}
        //   实跑被模型读成「月 辛未 ｜ 时 辛未」—— 月柱时柱双双编错, 而且带问号。
        //   扁平一行没有可嵌套的层级, 错不了位:
        //   「庚午(年柱) 癸未(月柱) 戊子(日柱) 己未(时柱)」
        //   凡是能少一层解析的, 就少一层。
        四柱: ['年柱', '月柱', '日柱', '时柱']
          .map((k) => (pillars.pillars && pillars.pillars[k] ? pillars.pillars[k] + '(' + k + ')' : null))
          .filter(Boolean).join(' '),
        日主: pillars.day_master + '(' + pillars.day_master_wuxing + '·' + pillars.day_master_yinyang + ')',
        月令: (pillars.month_branch || '') + '月',
        旺衰: pillars.status,
        // 2026-10-28 第 130 批: 旺衰的**等级**与**依据**一起给模型。
        //   以前只给「旺/弱/中和」三值, 模型说不清凭什么 ⇒ 会自己编一套。
        //   喜忌另标「命局中已出现」(课程: 优先选用命局中已出现的喜用五行)。
        旺衰等级: pillars.status_grade,
        旺衰依据: (pillars.status_detail && pillars.status_detail['三要素']) || null,
        喜用: pillars.xi_yong,
        '喜用(命局中已出现)': pillars.xi_yong_present,
        忌神: pillars.ji_shell,
        '忌神(命局中已出现)': pillars.ji_shell_present,
        财星: pillars.cai_xing,
        纳音: pillars.nayin_4,
        神煞: Object.keys(pillars.shensha_by_pillar || {}).length ? Object.keys(pillars.shensha_by_pillar || {}) : [],
        刑冲合害: {
          冲: pillars.chong, 合: pillars.he, 刑: pillars.xing, 害: pillars.hai, 破: pillars.po,
        },
      } : null,
      pillars,
      shensha_by_pillar: pillars.shensha_by_pillar,
      source: 'sxtwl 万年历真实排盘 (不是 LLM 推算)',
      note: '以上四柱来自万年历准；strengthConclusion/strength 是按课件判据算出的五行六格判断（含"不成立"态），解读须以它为准，不要另编旺衰'
        //
        // 2026-10-28 第 131 批: 真太阳时的**经度出处**必须让模型看见。
        //   以前查不到出生地经度就静默退回东八区中心(喀什这类差 2~3 小时, 时柱会错),
        //   而且输出看起来跟正确盘一模一样。现在如实说。
        + (pillars && pillars.solar_time_source && pillars.solar_time_source['近似值']
          ? '；真太阳时经度是**近似值**（' + (pillars.solar_time_source['层级'] || '')
            + '：' + (pillars.solar_time_source['说明'] || '')
            + '），时柱可能有偏差，解读时要点出来'
          : '')
        // 晚子时(23:00 出生)会用到**次日**日干, 日柱仍在当天 —— 这条口径要讲明,
        //   不然模型自己按「过了23点就换日」去解读, 会跟盘面对不上。
        + (pillars && pillars.hour_pillar_next_day_stem
          ? '；本盘生于 23 时（晚子时），按早子时派：时干用次日日干推，日柱仍属当天'
          : '')
        + (pillars && pillars.liunian_months_omitted
          //
          // 只说**有什么**, 不说**没什么** (2026-10-21 E2E 实跑第 6 轮才想明白的):
          //   初版这里写的是「未带流月明细 …… 不要因为看不到它就改口说流月数据缺失」。
          //   我以为"禁令"能挡住它, 结果它照样写了
          //   「本次返回被截断, **大运与流年明细未取到**」——
          //   而且事实是这次**根本没截断** (9,467 < 24,000, _truncated 不存在)。
          //   提示里写了"缺失""截断"这几个词, 模型就抓住了这几个词。
          //
          // 所以改成纯正面陈述: 90 条流年(哪年到哪年)已经全在这儿了,
          // 想要某年某月就带参数重调。正面陈述它会照做, 禁令只会给它一个说法。
          ? '；liunian ' + pillars.liunian_months_omitted + ' 条流年（每年干支/十神）已完整给出，'
            + '用户问到具体某年某月时，带 liunian_months=true 再调一次本工具即可拿到该年十二个月明细'
          : '')
    }
  };
};

// 标记 bazi_calc 为 safe (只读, 调万年历)
if (TOOLS.bazi_calc) TOOLS.bazi_calc._concurrency = 'safe';

// ===== E2-A: task_done =====
TOOLS.task_done = async (ctx) => {
  const { params = {} } = ctx;
  const { summary = '', pending = [], status = 'completed', artifacts = [], metrics = {} } = params;
  // 2026-08-02 (老板拍: 盘古非常啰嗦): task_done 摘要 2000+ 字会回灌上下文每轮烧 token
  // 还示范"长篇大论"风格。摘要 = 给调度/记忆看的要点, 硬上限 800 字。
  const _sum = String(summary || '');
  const _capped = _sum.length > 800 ? _sum.slice(0, 800) + '\n...(摘要超长已截断, 原文 ' + _sum.length + ' 字)' : _sum;
  // 2026-08-16 P1-1: outcome 字段 (新政 #1 闭环交付)
  const _status = ['completed', 'partial', 'failed'].includes(status) ? status : 'completed';
  const _artifacts = Array.isArray(artifacts) ? artifacts.slice(0, 50) : [];
  const _metrics = (metrics && typeof metrics === 'object') ? metrics : {};
  const _outcome = { status: _status, artifacts: _artifacts, metrics: _metrics, ts: Date.now() };
  return {
    ok: true,
    task_done: true,
    summary: _capped,
    pending: Array.isArray(pending) ? pending : [],
    status: _status,
    artifacts: _artifacts,
    metrics: _metrics,
    requested_status: _status,
    ts: new Date().toISOString()
  };
};
if (TOOLS.task_done) TOOLS.task_done._concurrency = 'safe';

// ===== 2026-09-12 新增 (老板 PANGU_SCAN_REPORT_20260912 §6): Plan 状态机 tool handler =====
TOOLS.plan_create = async (ctx) => {
  try {
    const { params = {}, context = {} } = ctx;
    const { goal, steps = [] } = params;
    const _sid = context.sessionId || 'default';
    if (!_sid) return { ok: false, error: 'NO_SESSION_ID' };
    const plan = require(path.join(__dirname, '..', 'plan_state'));
    const _steps = (Array.isArray(steps) ? steps : []).map((s, i) => ({
      id: String(s.id || ('s' + (i + 1))),
      title: String(s.title || '').slice(0, 200),
      dod: String(s.dod || '').slice(0, 500),
    }));
    const _r = plan.setPlan(_sid, { goal: String(goal || '').slice(0, 500), steps: _steps });
    if (!_r.ok) return { ok: false, error: _r.error };
    return { ok: true, plan_id: _sid, steps_total: _r.steps_total, message: 'plan_create 成功: ' + _r.steps_total + ' 步' };
  } catch (e) { return { ok: false, error: e.message }; }
};
TOOLS.plan_step_done = async (ctx) => {
  try {
    const { params = {}, context = {} } = ctx;
    const { step_id, evidence } = params;
    const _sid = context.sessionId || 'default';
    const plan = require(path.join(__dirname, '..', 'plan_state'));
    return plan.updateStep(_sid, step_id, { status: 'done', evidence: String(evidence || '').slice(0, 1000) });
  } catch (e) { return { ok: false, error: e.message }; }
};
TOOLS.plan_step_failed = async (ctx) => {
  try {
    const { params = {}, context = {} } = ctx;
    const { step_id, reason } = params;
    const _sid = context.sessionId || 'default';
    const plan = require(path.join(__dirname, '..', 'plan_state'));
    return plan.updateStep(_sid, step_id, { status: 'failed', evidence: String(reason || '').slice(0, 500) });
  } catch (e) { return { ok: false, error: e.message }; }
};
TOOLS.plan_view = async (ctx) => {
  try {
    const { context = {} } = ctx;
    const _sid = context.sessionId || 'default';
    const plan = require(path.join(__dirname, '..', 'plan_state'));
    const _p = plan.loadPlan(_sid);
    if (!_p) return { ok: false, error: 'NO_PLAN', message: '未创建 plan — 先调 plan_create' };
    return { ok: true, plan: _p, render: plan.renderPlanForSession(_sid) };
  } catch (e) { return { ok: false, error: e.message }; }
};
for (const _t of ['plan_create', 'plan_step_done', 'plan_step_failed', 'plan_view']) {
  if (TOOLS[_t]) TOOLS[_t]._concurrency = 'safe';
}

// ===== 2026-09-12 新增 (老板 PANGU_SCAN_REPORT_20260912 B4): Goal tool handler =====
TOOLS.goal_set = async (ctx) => {
  try {
    const { params = {}, context = {} } = ctx;
    const { text, priority = 'normal' } = params;
    const _sid = context.sessionId || 'default';
    const goal = require(path.join(__dirname, '..', 'goal'));
    return goal.setGoal(_sid, String(text || '').slice(0, 500), { priority });
  } catch (e) { return { ok: false, error: e.message }; }
};
TOOLS.goal_progress = async (ctx) => {
  try {
    const { params = {}, context = {} } = ctx;
    const { note } = params;
    const _sid = context.sessionId || 'default';
    const goal = require(path.join(__dirname, '..', 'goal'));
    return goal.addProgress(_sid, String(note || '').slice(0, 500));
  } catch (e) { return { ok: false, error: e.message }; }
};
TOOLS.goal_complete = async (ctx) => {
  try {
    const { params = {}, context = {} } = ctx;
    const { summary } = params;
    const _sid = context.sessionId || 'default';
    const goal = require(path.join(__dirname, '..', 'goal'));
    return goal.completeGoal(_sid, String(summary || '').slice(0, 1000));
  } catch (e) { return { ok: false, error: e.message }; }
};
for (const _t of ['goal_set', 'goal_progress', 'goal_complete']) {
  if (TOOLS[_t]) TOOLS[_t]._concurrency = 'safe';
}

// 让盘古能内省自己有多少子 agent 以及各自职责
TOOLS.list_pangu_agents = async (ctx) => {
  try {
    const { getAgentCatalog } = require(path.join(__dirname, '..', '..', 'agents', 'registry'));
    const catalog = getAgentCatalog();
    return {
      ok: true,
      data: {
        count: catalog.length,
        agents: catalog,
        note: '当前 Pangu 运行时实际加载的子 agent 列表'
      }
    };
  } catch (e) {
    return { ok: false, error: { code: 'AGENT_CATALOG_FAIL', message: String(e.message || e) } };
  }
};
if (TOOLS.list_pangu_agents) TOOLS.list_pangu_agents._concurrency = 'safe';

// ===== 盘古自主申请 macOS 权限 =====
// 之前: 盘古发现没权限就求助主人手动点, 现在自己弹 AppleScript + 引导到系统设置
TOOLS.permission_apply = async (ctx) => {
  const { params = {} } = ctx;
  // selftest 模式: 不真触发 TCC dialog, 只返 shape (跟其他工具 sentinel 一致)
  if (params._selftest_sentinel) {
    return {
      ok: true,
      selftest: true,
      permission_type: params.permission_type || 'camera',
      steps: ['tccutil reset (mocked)', 'Terminal trigger (mocked)', 'verify (mocked)'],
      note: 'permission_apply shape check passed (sentinel mode, no real TCC triggered)',
    };
  }
  const permission_type = params.permission_type || 'camera';
  const PERMISSION_LABELS = { camera: '摄像头', microphone: '麦克风', accessibility: '辅助功能', automation: '自动化', full_disk_access: '完整磁盘访问权', screen_recording: '录屏', input_monitoring: '输入监控' };
  const PERMISSION_URLS = {
    camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
    full_disk_access: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    screen_recording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    input_monitoring: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  };
  const TCC_SERVICE = { camera: 'Camera', microphone: 'Microphone', screen_recording: 'ScreenCapture', accessibility: 'Accessibility', automation: 'AppleEvents', full_disk_access: 'SystemPolicyAllFiles', input_monitoring: 'ListenEvent' };
  const label = PERMISSION_LABELS[permission_type] || permission_type;
  const url = PERMISSION_URLS[permission_type];
  const child_process = require('child_process');
  const fs = require('fs');

  // 老板定案 (2026-07-21): 顺序必须是 盘古申请 → 系统弹窗 → 老板同意.
  // 流程: 1) tccutil reset 清旧 deny 记录 2) 触发 Terminal 调用敏感操作 → 系统弹窗 3) 等老板点允许 4) 验证
  const service = TCC_SERVICE[permission_type];
  const steps = [];

  // Step 1: reset 旧 TCC 记录 (Terminal 以前被拒过的话, 清掉才会重新弹窗)
  if (service) {
    try {
      child_process.execSync(`tccutil reset ${service} com.apple.Terminal 2>&1 || true`, { timeout: 5000 });
      steps.push('tccutil reset ' + service + ' com.apple.Terminal: ok');
    } catch (e) {
      steps.push('tccutil reset: ' + (e.message || '').slice(0, 100));
    }
  }

  // Step 2: 触发 Terminal 调用敏感操作 → macOS 弹窗 (camera 用 ffmpeg 抓一帧; microphone 录 0.5s)
  if (permission_type === 'camera' || permission_type === 'microphone') {
    const ff = _resolveFfmpeg();
    // shell-safe escape: 路径含空格/单引号时 bash 不会爆
    const ffEsc = ff.replace(/'/g, `'\\''`);
    const probePath = `/tmp/pangu-permission-probe-${Date.now()}.png`;
    const scriptPath = `/tmp/pangu-perm-probe-${Date.now()}.sh`;
    // 老板定案 (2026-07-21): 设备名不写死, 脚本里动态枚举本机设备 (按本机型号匹配, 排除 iPhone/Continuity Camera)
    // 分辨率/帧率: 不指定 -video_size 让设备用默认, 但 -framerate 30 必须加 (所有设备都支持, 不加会报 "Selected framerate 29.97 is not supported")
    const scriptContent = `#!/bin/bash
MODEL=$(system_profiler SPHardwareDataType 2>/dev/null | grep 'Model Name' | cut -d: -f2 | xargs)
DEVICES=$('${ffEsc}' -f avfoundation -list_devices true -i '' 2>&1 | grep -A10 'AVFoundation video devices' | grep '\\[.*\\]')
DEV=""
# 匹配本机内置相机 (e.g. "MacBook Pro 相机") 或第一个非 iPhone 设备
while IFS= read -r line; do
  if [[ "$line" == *"\${MODEL}相机"* ]]; then DEV=$(echo "$line" | sed 's/\\[.*\\] //'); break; fi
done <<< "$DEVICES"
if [ -z "$DEV" ]; then
  while IFS= read -r line; do
    if [[ "$line" != *iPhone* && "$line" != *Continuity* ]]; then DEV=$(echo "$line" | sed 's/\\[.*\\] //'); break; fi
  done <<< "$DEVICES"
fi
if [ -z "$DEV" ]; then
  echo "ERROR: 未找到任何可用相机设备" > '${scriptPath}.log'
  echo "$DEVICES" >> '${scriptPath}.log'
  exit 1
fi
'${ffEsc}' -f avfoundation -framerate 30 -i "$DEV:none" -frames:v 1 -y '${probePath}' 2>&1
echo "EXIT_CODE=$?" >> '${scriptPath}.log'
`;
    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
    // AppleScript: 弹 Terminal → 立即 miniaturize 到 Dock (不抢老板窗口)
    const as = `tell application "Terminal"
  set winCount to count of windows
  do script "bash '${scriptPath}'"
  if (count of windows) > winCount then
    set miniaturized of window (winCount + 1) to true
  end if
end tell`;
    try {
      child_process.spawnSync('/usr/bin/osascript', ['-e', as], { encoding: 'utf8', timeout: 10000 });
      steps.push('Terminal 委托已触发 — macOS 应弹 "' + label + '" 授权窗口, 请点允许');
    } catch (e) {
      steps.push('Terminal 触发失败: ' + (e.message || '').slice(0, 200));
    }

    // Step 3: 单次 verify, 不做 30-retry (旧版 `$DEV` undefined bug 不复现, 用文件存在 + 日志 exit code 检测)
    // 12 × 1s = 12s — 老板通常 5-10s 内点, 12s 够, 真超时了落回 settings 兜底
    const logPath = scriptPath + '.log';
    let verified = false;
    let verifyReason = '';
    for (let i = 0; i < 12; i++) {
      child_process.spawnSync('/bin/sleep', ['1']);
      if (fs.existsSync(probePath) && fs.statSync(probePath).size > 0) {
        verified = true;
        break;
      }
      // bash 已 exit → 看日志判断真错
      if (fs.existsSync(logPath)) {
        const log = fs.readFileSync(logPath, 'utf8');
        const exitMatch = log.match(/EXIT_CODE=(\d+)/);
        if (exitMatch) {
          if (exitMatch[1] === '0') {
            // exit 0 但 probe 文件没出来 — 异常
            verifyReason = 'ffmpeg 退出 0 但 probe 文件未生成';
          } else {
            verifyReason = 'ffmpeg 退出码 ' + exitMatch[1] + ' (设备打开失败 / TCC 拒)';
          }
          break;
        }
      }
    }
    // cleanup probe 临时文件
    try { fs.unlinkSync(probePath); } catch (_) {}
    try { fs.unlinkSync(scriptPath); } catch (_) {}
    try { fs.unlinkSync(logPath); } catch (_) {}

    if (verified) {
      return {
        ok: true,
        permission_granted: true,
        verified: true,
        data: { permission_type, label, steps, note: label + ' 权限已授予 Terminal, 盘古后续通过 Terminal 委托调用' }
      };
    }
    // 12s 内没拿到 — 老板没点 / 没勾。打开 settings 兜底 + 错误区分 (PENDING vs DISPATCH_FAIL)
    if (url) { try { child_process.execSync(`open "${url}"`, { stdio: 'ignore', timeout: 5000 }); } catch (e) { _safeLog('openFail', e.message); } }
    const code = verifyReason ? 'PERMISSION_DISPATCH_FAIL' : 'PERMISSION_PENDING';
    const msg = verifyReason
      ? `${label} 授权失败: ${verifyReason}. 系统设置面板已打开, 请检查 ffmpeg 输出.`
      : `${label} 授权窗口已触发, 12s 内未检测到授权成功. 系统设置面板已打开, 请确认 Terminal 已勾选.`;
    return {
      ok: false,
      permission_granted: false,
      verified: false,
      error: { code, message: msg },
      data: { permission_type, label, steps, settings_opened: true }
    };
  }

  // 非 camera/microphone: 打开设置面板 (无法程序化触发弹窗)
  let opened = false;
  if (url) {
    try { child_process.execSync(`open "${url}"`, { stdio: 'ignore', timeout: 5000 }); opened = true; } catch (_) {}
  }
  return {
    ok: false,
    permission_granted: false,
    verified: false,
    error: { code: 'NO_DIALOG_HELP', message: label + ' 权限无法程序化触发弹窗, 系统设置面板已打开, 请手动勾选 Terminal.' },
    data: { permission_type, label, settings_opened: opened, steps }
  };
};
if (TOOLS.permission_apply) TOOLS.permission_apply._concurrency = 'safe';

// ===== 盘古长出眼睛 — take_photo =====
// 3 路 handoff: execFile → launchctl asuser → Terminal osascript 委托
// 老板定案 (2026-07-21): 盘古是 launchd daemon, TCC 摄像头权限永远给不了它自己;
// 唯一正解 = 委托 Terminal (GUI app, TCC 面板可勾选) 执行 ffmpeg.
// launchctl asuser 只是换 session, responsible process 还是盘古 → 必败.
TOOLS.take_photo = async (ctx) => {
  const { params = {} } = ctx;
  const {
    // 设备选择: 优先用 params.device 指定的关键词 ("iPhone" / "MacBook" / 具体设备名), 没传则默认本机相机
    // 老板定案 (2026-07-21): 支持 iPhone Continuity Camera, 也支持本机相机, 脚本里动态匹配
    device,
    output,
  } = params;

  const child_process = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const ts = Date.now();
  // 默认落到老板桌面, 不用 /tmp (老板指令: 拍照照片存到桌面)
  const outPath = output || path.join(os.homedir(), 'Desktop', `pangu-eye-${ts}.png`);  // C2 修: 适配任意用户

  // 策略 1: execFile (Node 直接调, 继承 Terminal TCC 时可用 — launchd daemon 永远失败)
  const tryExecFile = () => {
    try {
      child_process.execFileSync(_resolveFfmpeg(),
        ['-f', 'avfoundation', '-i', device, '-frames:v', '1', '-y', outPath],
        { timeout: 10000, stdio: ['ignore', 'ignore', 'pipe'] }
      );
      return { ok: true, handoff: null };
    } catch (e) {
      return { ok: false, stderr: (e.stderr || '').toString().slice(-200), stage: 'execFile' };
    }
  };

  // 策略 2: launchctl asuser UID cmd (走用户 Aqua session — 但 responsible process 还是盘古, TCC 不给)
  const tryLaunchctlAsuser = () => {
    try {
      const uid = String(child_process.execSync('id -u', { shell: '/bin/sh' }) || '').trim();
      const esc = outPath.replace(/'/g, `'\\''`);
      const ff = _resolveFfmpeg();  // sh -c 默认 PATH 不含 ~/.local/bin
      const ffEsc = ff.replace(/'/g, `'\\''`);  // B1 fix: 路径含空格/单引号时也安全
      const cmd = `launchctl asuser ${uid} '${ffEsc}' -f avfoundation -i '${device.replace(/'/g, `'\\''`)}' -frames:v 1 -y '${esc}'`;
      const r = child_process.spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', timeout: 15000 });
      if (r.status === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        return { ok: true, handoff: 'launchctl_asuser' };
      }
      return { ok: false, stderr: (r.stderr || '').slice(-200), stage: 'launchctl_asuser' };
    } catch (e) {
      return { ok: false, stderr: (e.stderr || '').toString().slice(-200), stage: 'launchctl_asuser' };
    }
  };

  // 策略 3: Terminal osascript 委托 — Terminal 是 GUI app, TCC 面板可勾选, 权限记 Terminal.
  // 盘古 daemon 让 AppleScript 叫 Terminal 跑 ffmpeg, Terminal 作为 responsible process 拿摄像头.
  // 老板定案 (2026-07-21): 设备名不写死, Terminal 脚本里动态枚举本机设备 (按本机型号匹配, 排除 iPhone/Continuity Camera)
  const tryTerminalOsascript = () => {
    try {
      const ff = _resolveFfmpeg();
      // shell-safe escape: 路径含空格/单引号时 bash 不会爆 (B1 fix from audit)
      const ffEsc = ff.replace(/'/g, `'\\''`);
      // 脚本逻辑:
      // 1) system_profiler 拿本机型号 (MacBook Pro / MacBook Air / Mac mini / Mac Studio)
      // 2) ffmpeg 枚举 video devices
      // 3) 设备匹配: 如果 params.device 传了关键词 (如 "iPhone"), 优先匹配含该关键词的设备
      //    如果指定了设备但没找到, 报错返回 (不静默 fallback)
      //    否则匹配 "{Model}相机" (本机内置) 或第一个非 iPhone 设备 (fallback)
      // 4) ffmpeg 拍照 — 不指定 -video_size 让设备用默认, 但 -framerate 30 必须加
      // 引号地狱修法: 把 shell 命令写到临时文件, AppleScript 让 Terminal 执行 bash 脚本, 避免嵌套引号
      const deviceHint = device ? String(device).toLowerCase() : '';
      const scriptPath = `/tmp/pangu-eye-${Date.now()}.sh`;
      const scriptContent = `#!/bin/bash
MODEL=\$(system_profiler SPHardwareDataType 2>/dev/null | grep 'Model Name' | cut -d: -f2 | xargs)
DEVICES=\$('${ffEsc}' -f avfoundation -list_devices true -i '' 2>&1 | grep -A10 'AVFoundation video devices' | grep '\\[.*\\]')
DEVICE_HINT="${deviceHint}"
DEV=""
# 1) 如果指定了设备关键词, 优先匹配
if [ -n "\$DEVICE_HINT" ]; then
  while IFS= read -r line; do
    if [[ "\$line" == *"\$DEVICE_HINT"* ]]; then DEV=\$(echo "\$line" | sed 's/\\[.*\\] //'); break; fi
  done <<< "\$DEVICES"
  # 指定了设备但没找到 → 报错
  # 指定了设备但没找到 → 报错并写日志
  if [ -n "\$DEVICE_HINT" ] && [ -z "\$DEV" ]; then
    echo "ERROR: 指定设备 '\$DEVICE_HINT' 未找到. 可用设备:" > '${scriptPath}.log'
    echo "\$DEVICES" >> '${scriptPath}.log'
    exit 1
  fi
  # 2) 没指定设备 → 匹配本机型号相机
  if [ -z "\$DEV" ]; then
    while IFS= read -r line; do
      if [[ "\$line" == *"\\${MODEL}相机"* ]]; then DEV=\$(echo "\$line" | sed 's/\\[.*\\] //'); break; fi
    done <<< "\$DEVICES"
  fi
  # 3) fallback: 第一个非 iPhone/Continuity 设备
  if [ -z "\$DEV" ]; then
    while IFS= read -r line; do
      if [[ "\$line" != *iPhone* && "\$line" != *Continuity* ]]; then DEV=\$(echo "\$line" | sed 's/\\[.*\\] //'); break; fi
    done <<< "\$DEVICES"
  fi
  # 4) 最终检查: 还是没找到 → 报错并写日志
  if [ -z "\$DEV" ]; then
    echo "ERROR: 未找到任何可用相机设备" > '${scriptPath}.log'
    echo "\$DEVICES" >> '${scriptPath}.log'
    exit 1
  fi
  echo "SELECTED_DEVICE: \$DEV" > '${scriptPath}.log'
  '${ffEsc}' -f avfoundation -framerate 30 -i "\$DEV:none" -frames:v 1 -y '${outPath.replace(/'/g, `'\\''`)}' 2>&1
  echo "EXIT_CODE=\$?" >> '${scriptPath}.log'
`;
      fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
      // AppleScript: 新开窗口执行, 立即 minimize 到 Dock, 不弹前台
      // do script 新开 window 时操作最后一个 window; 在现有 window 新开 tab 时不操作 window (避免误 minimize 老板窗口)
      const as = `tell application "Terminal"
  set winCount to count of windows
  do script "bash '${scriptPath}'"
  if (count of windows) > winCount then
    set miniaturized of window (winCount + 1) to true
  end if
end tell`;
      const r = child_process.spawnSync('/usr/bin/osascript', ['-e', as], { encoding: 'utf8', timeout: 15000 });
      if (r.status !== 0) {
        return { ok: false, stderr: (r.stderr || '').slice(-200), stage: 'terminal_osascript' };
      }
      // Terminal 新开 tab 异步执行, 等文件落地或日志出现 (最多 12s)
      for (let i = 0; i < 24; i++) {
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
          return { ok: true, handoff: 'terminal_osascript' };
        }
        // 检查日志: 如果脚本已执行完 (日志存在), 读日志判断真实错误
        const logPath = scriptPath + '.log';
        if (fs.existsSync(logPath)) {
          const log = fs.readFileSync(logPath, 'utf8');
          const errMatch = log.match(/ERROR: (.+)/);
          if (errMatch) {
            return { ok: false, stderr: errMatch[1].slice(0, 200), stage: 'terminal_osascript' };
          }
          const exitMatch = log.match(/EXIT_CODE=(\d+)/);
          if (exitMatch && exitMatch[1] !== '0') {
            return { ok: false, stderr: `ffmpeg 退出码 ${exitMatch[1]}: 设备打开失败`, stage: 'terminal_osascript' };
          }
        }
        child_process.spawnSync('/bin/sleep', ['0.5']);
      }
      return { ok: false, stderr: 'Terminal 已启动但照片未落地 (12s 超时). Terminal 可能 TCC 没勾摄像头', stage: 'terminal_osascript' };
    } catch (e) {
      return { ok: false, stderr: (e.stderr || e.message || '').toString().slice(-200), stage: 'terminal_osascript' };
    }
  };

  // 3 路: execFile → launchctl asuser → Terminal osascript (老板定案, 保底委托)
  const stages = [tryExecFile, tryLaunchctlAsuser, tryTerminalOsascript];
  let lastResult = null;
  for (const stage of stages) {
    const r = stage();
    if (r.ok) {
      const size = fs.statSync(outPath).size;
      return {
        ok: true,
        data: {
          output: outPath,
          size_bytes: size,
          device,
          handoff: r.handoff || null,
          note: r.handoff ? `盘古睁眼成功 (走 ${r.handoff} 委托)` : '盘古睁眼成功',
        }
      };
    }
    lastResult = r;
  }

  return {
    ok: false,
    error: {
      code: 'CAMERA_PERMISSION_DENIED',
      message: '摄像头权限被拒绝。盘古已尝试 3 路委托（直接执行 / launchctl / Terminal 委托），均失败。根因：盘古是 launchd 后台进程，macOS TCC 摄像头权限只能授予 GUI 应用（Terminal/Cursor），授予后盘古通过 Terminal 委托调用摄像头。',
      hint_stage: lastResult.stage,
      hint_stderr: lastResult.stderr,
      user_action: '1. 打开 系统设置 → 隐私与安全性 → 摄像头\n2. 勾选 **Terminal**（不是勾选盘古，盘古不在列表里）\n3. 无需重启 Terminal — 盘古每次拍照都会新开 Terminal 窗口委托执行\n4. 如果 Terminal 已勾选仍失败，检查 系统设置 → 隐私与安全性 → 自动化 里 Terminal 是否允许控制 Terminal',
    },
    data: { device, attempts: stages.length },
  };
};
if (TOOLS.take_photo) TOOLS.take_photo._concurrency = 'safe';

// ===== 盘古长出耳朵 — record_audio =====
// 2 路 handoff: execFile → launchctl asuser
TOOLS.record_audio = async (ctx) => {
  const { params = {} } = ctx;
  const {
    // 老板定案 (2026-07-21): 本机设备动态识别, 不写死 — 由调用方传 device
    device,
    duration_s = 3,
    output,
  } = params;

  const child_process = require('child_process');
  const fs = require('fs');
  const ts = Date.now();
  const outPath = output || `/tmp/pangu-ear-${ts}.wav`;

  // 策略 1: execFile
  const tryExecFile = () => {
    try {
      child_process.execFileSync(_resolveFfmpeg(),
        ['-f', 'avfoundation', '-i', device, '-t', String(duration_s), '-y', outPath],
        { timeout: duration_s * 1000 + 5000, stdio: ['ignore', 'ignore', 'pipe'] }
      );
      return { ok: true, handoff: null };
    } catch (e) {
      return { ok: false, stderr: (e.stderr || '').toString().slice(-200), stage: 'execFile' };
    }
  };

  // 策略 2: launchctl asuser
  const tryLaunchctlAsuser = () => {
    try {
      const uid = String(child_process.execSync('id -u', { shell: '/bin/sh' }) || '').trim();
      const esc = outPath.replace(/'/g, `'\\''`);
      const cmd = `launchctl asuser ${uid} '${_resolveFfmpeg()}' -f avfoundation -i '${device.replace(/'/g, `'\\''`)}' -t ${duration_s} -y '${esc}'`;
      const r = child_process.spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', timeout: duration_s * 1000 + 8000 });
      if (r.status === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        return { ok: true, handoff: 'launchctl_asuser' };
      }
      return { ok: false, stderr: (r.stderr || '').slice(-200), stage: 'launchctl_asuser' };
    } catch (e) {
      return { ok: false, stderr: (e.stderr || '').toString().slice(-200), stage: 'launchctl_asuser' };
    }
  };

  // 2 路: execFile + launchctl asuser (删 osascript + Terminal .command — 太绕, 成功率低)
  const stages = [tryExecFile, tryLaunchctlAsuser];
  let lastResult = null;
  for (const stage of stages) {
    const r = stage();
    if (r.ok) {
      return {
        ok: true,
        data: {
          output: outPath,
          size_bytes: fs.statSync(outPath).size,
          duration_s,
          device,
          handoff: r.handoff || null,
          note: r.handoff ? `盘古听见了一段声音 (走 ${r.handoff} 委托)` : '盘古听见了一段声音',
        }
      };
    }
    lastResult = r;
  }

  return {
    ok: false,
    error: {
      code: 'RECORD_AUDIO_FAILED',
      message: '盘古需要麦克风权限. 主人请在 系统设置 → 隐私与安全性 → 麦克风 勾 Terminal (或 Cursor), 授权一次后盘古自动能录.',
      hint_stage: lastResult.stage,
      hint_stderr: lastResult.stderr,
    },
    data: { device, attempts: stages.length },
  };
};
if (TOOLS.record_audio) TOOLS.record_audio._concurrency = 'safe';

// #9 逐个验 GUI: tools_selftest 逐个调 GUI 工具看能不能跑
// 返回 { ok, total, failed, summary, detail, checks[] }
TOOLS.tools_selftest = async (ctx) => {
  const { params = {} } = ctx;
  const onlyFailed = params.only_failed === true;
  const targets = params.targets || [
    'computer_use_vision_act', 'computer_use_click', 'computer_use_type',
    'computer_use_key', 'computer_use_drag', 'screenshot', 'record_audio', 'take_photo',
    'permission_apply'
  ];
  const checks = [];

  // 1. cliclick 二进制检查
  try {
    require('child_process').execFileSync('which', ['cliclick'], { stdio: 'ignore' });
    checks.push({ tool: 'cliclick', category: 'infra', status: 'ok' });
  } catch (_) {
    checks.push({ tool: 'cliclick', category: 'infra', status: 'fail', detail: '未安装 (brew install cliclick)' });
  }

  // 2. vision 模型端点探测 (vision_act 依赖) — 探测 LM Studio :1234 上是否有支持 vision 的模型
  try {
    const configPath = path.join(__dirname, '..', '..', 'config', 'nodes', `${os.hostname()}.json`);  // R30 修 (老板 7/25 20:04 拍 A): 适配任意机器名
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const faraEndpoint = cfg.vision?.fara_endpoint || cfg.fara_endpoint;
      if (faraEndpoint) {
        await new Promise((resolve) => {
          const lib = faraEndpoint.startsWith('https') ? require('https') : require('http');
          const url = new URL(faraEndpoint);
          const req = lib.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', timeout: 2000 }, (res) => {
            checks.push({ tool: 'fara_endpoint', category: 'infra', status: res.statusCode < 500 ? 'ok' : 'fail', detail: 'HTTP ' + res.statusCode + ' ' + faraEndpoint });
            resolve();
          });
          req.on('timeout', () => { req.destroy(); checks.push({ tool: 'fara_endpoint', category: 'infra', status: 'fail', detail: 'timeout 2s' }); resolve(); });
          req.on('error', (e) => { checks.push({ tool: 'fara_endpoint', category: 'infra', status: 'fail', detail: e.code || e.message }); resolve(); });
          req.end();
        });
      } else {
        checks.push({ tool: 'fara_endpoint', category: 'infra', status: 'fail', detail: 'config 未配 fara_endpoint' });
      }
    }
  } catch (e) {
    checks.push({ tool: 'fara_endpoint', category: 'infra', status: 'fail', detail: e.message.slice(0, 100) });
  }

  // 3. 逐个调 GUI 工具看能跑不 (5s 超时防卡住)
  for (const toolName of targets) {
    if (!TOOLS[toolName]) {
      checks.push({ tool: toolName, category: 'gui_tool', status: 'fail', detail: '工具未注册' });
      continue;
    }
    try {
      const result = await Promise.race([
        TOOLS[toolName]({ context: { user: 'feng' }, params: {} }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_5s')), 5000))
      ]);
      const isOk = result && result.ok === true;
      let errDetail = '';
      if (!isOk && result && result.error) {
        errDetail = (result.error.code || result.error.message || JSON.stringify(result.error)).slice(0, 150);
      }
      checks.push({
        tool: toolName,
        category: 'gui_tool',
        status: isOk ? 'ok' : 'fail',
        detail: isOk ? '' : errDetail
      });
    } catch (e) {
      checks.push({ tool: toolName, category: 'gui_tool', status: 'fail', detail: e.message.slice(0, 150) });
    }
  }

  const filtered = onlyFailed ? checks.filter(c => c.status !== 'ok') : checks;
  const detailText = filtered.map(c => c.tool + ': ' + c.status + (c.detail ? ' (' + c.detail + ')' : '')).join('\n') || '全部 OK';
  const failCount = checks.filter(c => c.status !== 'ok').length;

  return {
    ok: true,
    data: {
      checks: filtered,
      total: checks.length,
      failed: failCount,
      summary: failCount === 0 ? '✅ 全部 GUI 工具 OK' : '⚠️ ' + failCount + '/' + checks.length + ' 工具失败',
      detail: detailText,
      hint: failCount > 0 ? '失败原因可能: TCC 权限未授 / cliclick 未装 / LM Studio :1234 未加载 vision 模型 / 工具实现缺失' : ''
    }
  };
};

// P0-#23: boot 时加载本地 plugin (老板 ~/.pangu-data/plugins/<name>/)
// 隔离 failure — 一个 plugin 坏不毁 TOOLS
// 共享 TOOLS_SCHEMA 引用, plugin 注入后 server 拿 schema (getAllToolSchemas 同步看到)
async function loadPluginsIntoTools() {
  try {
    const { loadAllPlugins } = require('../plugin_loader');
    const schemaModule = require('../tools_schema');
    const reg = { handlers: TOOLS, schemas: schemaModule.TOOLS_SCHEMA, list: Object.keys(TOOLS) };
    const r = await loadAllPlugins(reg);
    _normalizeAllToolParams(TOOLS);
    return r;
  } catch (e) {
    return { loaded: [], failed: [{ plugin: '<boot>', error: e.message }] };
  }
}

// P0-#20: boot 时加载本地 SDK tool (老板 ~/.pangu-data/tools/<name>/)
// 跟 plugin 不同: SDK tool 强制要 tool.json + handler.js (plugin 可多个 tool, SDK 一个)
async function loadSdkToolsIntoTools() {
  try {
    const { loadAllSdkTools } = require('../tools_sdk');
    const schemaModule = require('../tools_schema');
    const reg = { handlers: TOOLS, schemas: schemaModule.TOOLS_SCHEMA, list: Object.keys(TOOLS) };
    const r = await loadAllSdkTools(reg);
    _normalizeAllToolParams(TOOLS);
    return r;
  } catch (e) {
    return { loaded: [], failed: [{ tool: '<boot>', error: e.message }] };
  }
}

module.exports = { TOOLS, loadPluginsIntoTools, loadSdkToolsIntoTools };

// 2026-08-02 (老板拍: "盘古为啥不出图"): 确定性平面图出图工具 — SVG/DXF 纯 Node 必出,
// FCSTD 走 freecadcmd best-effort, 返回前逐文件 statSync 验证 (反幻觉硬结构)
TOOLS.draw_layout = require('./draw_layout');
TOOLS.draw_layout._concurrency = 'safe';

// 2026-08-07 (老板拍: "适配所有模型的就不应该是 MCP, 应该是盘古内置"):
// 通用多模态生成 (image/video/music), 能力声明读模型配置 capabilities + <modality>_endpoint,
// 产物经 media_sink 落盘只回路径 (原 mcp_servers/pangu-media 内化, MCP 壳已退役)
TOOLS.media_generate = require('./media_gen');
// 2026-09-13 (老板拍: 盘古是完全独立的 agent, 去掉所有其他 agent 的痕迹):
// 四个外部 agent 桥接工具已移除 (模块文件同删, git 历史可查)。盘古编码任务一律自做, 不外包。
TOOLS.media_generate._concurrency = 'safe';

// 2026-08-07 (同上老板拍): 内置 skill 读取 — 一个 skill_use 顶掉 4 个 echo 模式 MCP 桥
// (pangu-mcp-dev-workflow / baoyu-compress-image / codivupload / evomap 的 MCP 只回显 SKILL.md)
TOOLS.skill_use = require('./skill_use');
TOOLS.skill_use._concurrency = 'safe';

// 2026-10-12: 归一化必须放在文件末尾 —— 上面几个工具是 module.exports 之后才注册的,
// 提前调会漏掉它们。放在这里才能覆盖全部注册路径 (内建 + 插件 + SDK)。
_normalizeAllToolParams(TOOLS);
