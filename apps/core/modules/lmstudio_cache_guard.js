'use strict';

// LM Studio 的 prompt 缓存随**模型加载寿命**存在 (日志 lifetime=model_load),
// 上限跟**加载时的 ctx** 挂钩 (实测 2026-10-25):
//   ctx=65536   → cap_mib=41680
//   ctx=262144  → cap_mib=166720
// 盘古一次请求写 ~7.5GB (实测 records 64→226, used_mib 2070→7017),
// 41GB 上限 ⇒ 大约 6 次请求顶满。
//
// 顶满之后不是"变慢一点", 是掉悬崖: 缓存一边写一边驱逐, 命中率崩掉。
//   前缀稳定时: cached_tokens=24064 / uncached_tokens=147   → 命中 99.4%
//   顶满驱逐时: cached_tokens=22528 / uncached_tokens=21312  → 命中 51%
// 同一句问因此在 79.9s 和 274.8s 之间随机跳 (2026-10-15 实测)。
//
// 唯一官方重置路径 = 卸载+重载模型 (lifetime=model_load)。实测 2026-10-25:
//   lms unload qwen/qwen3.8-27b                  → 0 秒
//   lms load  qwen/qwen3.8-27b -c 65536 --gpu max → 3.6 秒
// 旧注释写的"重载要 10~25s"是过期数字, 现在只值 3.6 秒 ⇒ 排空等待完全可接受。
//
// ===========================================================================
// 2026-10-25 (第 94 批) 修的四件事 —— 旧守卫是**从来没生效过的死代码**
// ===========================================================================
// 1) 触发条件不可达: decide() 要求 activeRounds===0 **且** 空闲 180s,
//    而盘古一有活干这两个就都不满足 ⇒ 永远不重载 (实测: 启动行打了 11 次,
//    一次没触发)。而旧代码传的 activeRounds 是 j2_agent_loop 的"活跃轮次数",
//    它是"有人在用模型"的**粗代理** —— 连轮次之间的空窗期都被堵死。
//    → 改成传**在途 LLM 请求数**(精确口径), 并用闸门把空窗期变成安全窗口。
// 2) 模型标识用错: 旧代码 `lms unload <盘古的 model.id>` 用的是盘古内部 id
//    (qwen_qwen3.8-27b), LM Studio 只认 publisher/model (qwen/qwen3.8-27b)
//    ⇒ 实跑得到 "Model Not Found"。现在从 `lms ps` 解析真实标识。
// 3) 假成功: lms 出错时**退出码仍是 0**, execFileSync 不抛 ⇒ 旧代码会打
//    "重载完成" 的假日志。现在重载后用 `lms ps` 复核, 真的加载上了才算成功。
// 4) 同步阻塞: 旧代码用 execFileSync, 重载那 10~25s 里**整个 pangu 服务卡死**
//    (HTTP 全挂)。现在改成异步 execFile。
//
// LM Studio 没有暴露缓存查询 API (/api/v0/cache 返 "Unexpected endpoint"),
// 所以唯一权威数据源是它自己的服务端日志。

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(os.homedir(), '.lmstudio', 'server-logs');

// 阈值 (全部是可调常量, 测试直接引用, 不写死第二份)
const RATIO_TRIGGER = 0.85;      // 缓存占用到这个比例才考虑
const IDLE_REQUIRED_MS = 3 * 60 * 1000;  // 至少空闲这么久 (没有闸门时的保守路径)
const RELOAD_COOLDOWN_MS = 30 * 60 * 1000; // 两次重载之间的最小间隔
const DRAIN_WAIT_MS = 30 * 1000;  // 排空时最多等在途请求多久
const TAIL_BYTES = 256 * 1024;    // 只读日志尾部, 不整份扫 (日志已 6MB+)
const LEASE_TTL_MS = 10 * 60 * 1000; // 租约超龄 ⇒ 视为已死 (漏了 leave 不至于永久卡死守卫)

const _state = {
  lastReloadAt: 0,
  lastReason: '',
  draining: false,      // 闸门关着: 新请求排队等重载
  lastRequestAt: 0,     // 最近一次 LLM 请求开始的时间
};
const _leases = new Set();  // 在途 LLM 请求的租约
const _waiters = [];

function latestLogPath(now = new Date()) {
  // LM Studio 按 天/月 分目录, 当天没有日志时回退到前一天 (跨零点/刚启动的情况)
  const days = [now, new Date(now.getTime() - 86400000)];
  for (const d of days) {
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const dir = path.join(LOG_DIR, ym);
    let names;
    try { names = fs.readdirSync(dir).filter(n => n.endsWith('.log')).sort(); } catch (_) { continue; }
    if (names.length) return path.join(dir, names[names.length - 1]);
  }
  return null;
}

// 从日志里取最近一条缓存占用。只认 used_mib/cap_mib 同时出现的那行 —— 宁可读不到,
// 也不能因为半截匹配就按错误数据去动模型。
// 只读文件尾部: 日志已经 6MB+, 每 5 秒整份读一遍是白烧 IO。
function readCachePressure(logPath) {
  if (!logPath) return null;
  let text;
  try {
    const st = fs.statSync(logPath);
    const len = Math.min(st.size, TAIL_BYTES);
    const fd = fs.openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(len);
      if (len > 0) fs.readSync(fd, buf, 0, len, st.size - len);
      text = buf.toString('utf8');
      // 尾部截断 ⇒ 第一行可能是半截的, 丢掉它 (否则半截数字会被当成完整数据)
      if (st.size > len) {
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
      }
    } finally { fs.closeSync(fd); }
  } catch (_) { return null; }
  const re = /used_mib=([\d.]+)\s+cap_mib=([\d.]+)(?:\s+lifetime_evicted_mib=([\d.]+))?(?:\s+records=(\d+))?/g;
  let m, last = null;
  while ((m = re.exec(text)) !== null) last = m;
  if (!last) return null;
  const used = parseFloat(last[1]);
  const cap = parseFloat(last[2]);
  if (!isFinite(used) || !isFinite(cap) || cap <= 0) return null;
  const out = { used_mib: used, cap_mib: cap, ratio: used / cap };
  if (last[3] != null) {
    const evicted = parseFloat(last[3]);
    if (isFinite(evicted)) out.evicted_mib = evicted;
  }
  if (last[4] != null) {
    const records = parseInt(last[4], 10);
    if (isFinite(records)) out.records = records;
  }
  return out;
}

// ===========================================================================
// 排空闸门 (2026-10-25 第 94 批)
// ===========================================================================
// 重载模型期间 LM Studio 会拒绝/丢失请求。旧守卫的对策是"绝不在有活干时重载",
// 但盘古**永远有活干** ⇒ 守卫永远不触发 ⇒ 缓存永远满 ⇒ 命中率永远崩。
// 现在反过来: 把新来的请求**挡住排队**, 等重载完再放行。
//   - 在途请求数 = 0 ⇒ 此刻卸载模型不会打断任何人
//   - 闸门关着 ⇒ 卸载期间新来的请求排队, 而不是失败
// 实测重载只要 3.6 秒, 排一次队远好过顶满缓存后每轮 60~200 秒。

// 请求进来前调一次: 重载中就排队等, 排完再放行; 放行时登记在途数。
async function enterRequest() {
  while (_state.draining) {
    await new Promise((resolve) => _waiters.push(resolve));
  }
  const token = { at: Date.now() };
  _leases.add(token);
  _state.lastRequestAt = Date.now();
  return token;
}

// 请求结束 (或失败) 后调一次。
function leaveRequest(token) {
  if (token && _leases.has(token)) { _leases.delete(token); return; }
  // 没给 token 时退化成"清掉最早的租约" (单请求场景够用)
  let oldest = null;
  for (const t of _leases) if (!oldest || t.at < oldest.at) oldest = t;
  if (oldest) _leases.delete(oldest);
}

function beginDrain() { _state.draining = true; }

function endDrain() {
  _state.draining = false;
  const waiters = _waiters.splice(0, _waiters.length);
  for (const w of waiters) { try { w(); } catch (_) {} }
}

function isDraining() { return _state.draining; }
function inflightCount() {
  const now = Date.now();
  for (const t of _leases) {
    if (now - t.at > LEASE_TTL_MS) _leases.delete(t);
  }
  return _leases.size;
}
function lastRequestAt() { return _state.lastRequestAt; }

// 等在途请求跑完。返回 false = 没排空 (有请求赖着不走) ⇒ 宁可放弃重载也不能打断。
async function waitForInflightZero(timeoutMs = DRAIN_WAIT_MS) {
  const t0 = Date.now();
  while (inflightCount() > 0) {
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

// 纯决策: 给定当前状态, 要不要现在重载。返回 { ok, reason, ... }。
// 单独拎出来是为了能在不碰真模型的前提下把每条分支都测一遍。
//
// drainReady = 闸门已就位 (新请求会被挡住排队)。这时"在途=0"本身就是安全窗口,
// 不再需要"世界安静 180 秒"这种跟盘古工作方式互斥的假设。
// 没闸门时 (drainReady 为假) 走老的保守路径: 仍要求空闲满 IDLE_REQUIRED_MS。
function decide({ pressure, activeRounds, idleMs, lastReloadAt, drainReady = false, now = Date.now() } = {}) {
  if (!pressure) return { ok: false, reason: 'no_pressure_data' };
  if (pressure.ratio < RATIO_TRIGGER) {
    return { ok: false, reason: 'cache_healthy', ratio: pressure.ratio };
  }
  // 有请求在飞就绝对不动 —— 重载期间请求会失败, 打断主人正在做的事比慢几十秒恶劣得多。
  if (Number(activeRounds) > 0) {
    return { ok: false, reason: 'busy', ratio: pressure.ratio, activeRounds };
  }
  const idle = Number.isFinite(idleMs) ? idleMs : 0;
  if (!drainReady && idle < IDLE_REQUIRED_MS) {
    return { ok: false, reason: 'not_idle_enough', idle_ms: idle, required_ms: IDLE_REQUIRED_MS };
  }
  const since = now - (Number(lastReloadAt) || 0);
  if (since < RELOAD_COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', since_ms: since, cooldown_ms: RELOAD_COOLDOWN_MS };
  }
  return {
    ok: true,
    reason: drainReady ? 'cache_pressure_drain' : 'cache_pressure_idle',
    ratio: pressure.ratio,
    idle_ms: idle,
  };
}

// 判断这个模型是否受本守卫管辖: 只有走 LM Studio 的本地模型才有这个缓存问题。
function guardApplies(model) {
  if (!model) return false;
  const provider = String(model.provider || '').toLowerCase();
  if (provider === 'lmstudio' || provider === 'lm-studio') return true;
  const ep = String(model.endpoint || model.api_base || '');
  return /:1234\b/.test(ep);
}

// ===========================================================================
// `lms ps` 解析 —— "LM Studio 里这个模型到底叫什么" 的唯一权威来源
// ===========================================================================
// 盘古的 model.id 是内部 id (qwen_qwen3.8-27b), LM Studio 只认 publisher/model
// (qwen/qwen3.8-27b)。拿盘古的 id 去 unload 只会得到 "Model Not Found",
// 而 lms 出错时**退出码仍然是 0** ⇒ 旧守卫会打出"重载完成"的假日志。
function parseLmsPs(text) {
  const rows = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^IDENTIFIER\s/i.test(line)) continue;
    if (/no models/i.test(line)) continue;
    const parts = line.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    if (parts.length < 3) continue;
    const identifier = parts[0];
    // 标识必须是 publisher/model 形态 —— 别把表头或别的列当成标识
    if (!identifier || identifier.indexOf('/') < 0) continue;
    rows.push({ identifier, model: parts[1], status: parts[2] });
  }
  return rows;
}

// 从 `lms ps` 的行里找出盘古这个 model.id 对应的**真实 LM Studio 标识**。
// 匹配规则 (先精确后模糊):
//   1. identifier / model 字符串完全相等
//   2. 把 '/' 和 '_' 都去掉之后相等 (盘古内部 id 就是这么来的)
//   3. 只有一行、且扁平化后互相包含 (只有一个模型在跑时的兜底)
// 认不出来就返回 null —— 宁可不动模型, 也不能 unload 错的那个。
function resolveIdentifier(rows, wantedId) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const flat = (s) => String(s || '').replace(/[\/_]/g, '');
  const want = String(wantedId || '').trim();
  const wf = flat(want);
  if (!wf) return null;
  const hits = rows.filter((r) => (
    r.identifier === want
    || r.model === want
    || flat(r.identifier) === wf
    || flat(r.model) === wf
  ));
  if (hits.length === 1) return hits[0].identifier;
  if (hits.length === 0 && rows.length === 1) {
    const only = rows[0];
    const of = flat(only.identifier);
    if (of && (of.includes(wf) || wf.includes(of))) return only.identifier;
  }
  return null;
}

function markReloaded(reason) {
  _state.lastReloadAt = Date.now();
  _state.lastReason = reason || '';
}

function lastReloadAt() { return _state.lastReloadAt; }
function lastReason() { return _state.lastReason; }

function resetForTests() {
  _state.lastReloadAt = 0;
  _state.lastReason = '';
  _state.draining = false;
  _state.lastRequestAt = 0;
  _leases.clear();
  _waiters.splice(0, _waiters.length);
}

module.exports = {
  LOG_DIR, RATIO_TRIGGER, IDLE_REQUIRED_MS, RELOAD_COOLDOWN_MS, DRAIN_WAIT_MS, TAIL_BYTES,
  LEASE_TTL_MS,
  latestLogPath, readCachePressure, decide, guardApplies,
  enterRequest, leaveRequest, beginDrain, endDrain, isDraining,
  inflightCount, lastRequestAt, waitForInflightZero,
  parseLmsPs, resolveIdentifier,
  markReloaded, lastReloadAt, lastReason, resetForTests,
};
