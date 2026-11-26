// apps/core/modules/compaction.js
// 盘古 · 自动 compaction —— **薄适配层** (2026-10-24 第 80 批)
//
// 【为什么有这层】
//   仓库里曾经有**两套**压缩实现:
//     (1) 本文件 (旧, 9KB)  —— 自己算 token、自己调 LLM 摘要、自己拼 summary system 消息
//     (2) modules/session_compaction.js (41KB) —— 主循环在用的那套
//   两个调用方走 (1): llm_caller._maybeCompactMessages / scheduler 的 compaction.run。
//   => **两套摘要格式能进同一个上下文**, 而 (1) 的产物**没过工具配对清洗**。
//
// 【现场根因 (2026-10-24 实测, 不是推演)】
//   (1) 的 token 口径是 pangu_helpers.estimateMessagesTokens = chars x 0.35;
//     (2) 的口径是 _estimateTokens = chars / 4。
//   同一段消息, (1) 算出的 token 数**比 (2) 大 1.4 倍** => **(1) 先触发**。
//   于是坏的压缩产物先进上下文, (2) 再拿它去压第二遍 —— 两套格式叠加。
//   而 (1) 的产物没有 _sanitizeToolPairing => 可能留下**孤儿 tool result**
//   (父 assistant.tool_calls 被切掉) => MiniMax 400 "tool result's tool id not found"
//   => 整轮被迫降级 legacy 重跑。
//
// 【修法】
//   本文件**不再自己实现压缩**。判据、产物、清洗全部下沉到 (2) (唯一真源),
//   本层只保留两件 (2) 不做的事:
//     - **快照落档** ((2) 不落档; 而 listSnapshots / 回档证据依赖它)
//     - **旧调用方的函数形状** (needsCompaction / compact 的入参出参)
//   注意: 注释 != 隔离 —— 判据在 needsCompaction / compact 的代码里, 不在注释里。
//
//   产物格式统一成 (2) 的 `【会话摘要】{...}` (带 isCompactionSummary 标记),
//   这样主循环的 _persistSession 能把它认出来落进 session_store.compaction_summary。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
// 2026-10-25 (第 92 批): session id → 落盘文件名的唯一真源。
//   本文件两处各抄了一份清洗 (而且截断长度是 60, 与别处的 80 不同)。
//   ⇒ 统一到 session_key, 并**保留 60 这个截断长度**:
//   listSnapshots 是按文件名前缀匹配的, 改截断长度会让存量快照读不到。
const { sessionKeyCandidates, resolveSessionKeyPrefix } = require('./session_key');
// 2026-10-26 第 100 批: 压缩快照目录走唯一真源 (modules/state_paths.js)
//   沙箱导出 PANGU_COMPACTION_DIR ⇒ 测试链不再往生产 ~/.pangu/state/compaction 写
//   (实测每跑一次链 5 个 unit-compact-* 文件进生产)。
const statePaths = require('./state_paths');
const _SNAP_ID_MAXLEN = 60;

const DEFAULT_PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
const COMPACTION_DIR = () => statePaths.compactionDir();

// 阈值单一信源 —— 跟 plist/local.pangu-single.plist + session_compaction.DEFAULT_CONFIG 一致。
// (旧代码在这里写死 0.8 常量, 而 (2) 用 env PANGU_COMPACT_TOKEN_RATIO, 两边会漂。)
const TRIGGER_RATIO = parseFloat(process.env.PANGU_COMPACT_TOKEN_RATIO || '0.8');
const TRIGGER_MIN_NON_SYSTEM = 8;    // 至少 8 条非 system 才值得压缩 (太少反而丢上下文)

function ensureDir() { try { fs.mkdirSync(COMPACTION_DIR(), { recursive: true }); } catch (_) {} }

function _atomicWrite(file, content) {
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function _newSnapId(sessionId) {
  // 快照文件名 = <前缀>-<时间戳>-<随机>.json ⇒ 后缀随机 ⇒ 不会互相覆盖;
  //   前缀用唯一真源算 (真撞名时换指纹前缀), 跟 listSnapshots 的匹配规则对齐。
  const safeSid = resolveSessionKeyPrefix(COMPACTION_DIR(), sessionId, { sep: '-', maxLen: _SNAP_ID_MAXLEN });
  return safeSid + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(2).toString('hex');
}

// 复用 (2) 的摘要产物形状: 它是 `【会话摘要】{json}` 的 system 消息。
// 这里取**最后一条** isCompactionSummary —— 跟 j2_loop_shared._persistSession 同一口径。
function _extractSummaryText(messages) {
  const _cs = (Array.isArray(messages) ? messages : []).filter(m => m && m.isCompactionSummary);
  if (!_cs.length) return '';
  return String(_cs[_cs.length - 1].content || '').replace(/^【会话摘要】/, '').trim();
}

/**
 * 判断是否需要压缩。
 *
 * 【口径统一到 (2)】旧实现用 pangu_helpers.estimateMessagesTokens (chars x 0.35),
 * (2) 用 _estimateTokens (chars / 4) —— 同一段消息前者大 1.4 倍 => 影子先触发。
 * 现在两边都用 **(2) 的口径** (chars / 4) + **同一个 ratio** (PANGU_COMPACT_TOKEN_RATIO),
 * 触发时机跟主循环 (j2_agent_loop 的 _compactor.shouldCompact) 对齐。
 */
function needsCompaction(messages, model) {
  try {
    const arr = Array.isArray(messages) ? messages : [];
    const nonSystem = arr.filter(m => m && m.role !== 'system');
    if (nonSystem.length <= TRIGGER_MIN_NON_SYSTEM) return false;

    // token 口径跟 (2) 的 _estimateTokens 一致 (chars / 4, 跟 (2) 的 PageSummary 预算同尺)
    let chars = 0;
    for (const m of arr) {
      if (m && typeof m.content === 'string') chars += m.content.length;
      else if (m && Array.isArray(m.content)) {
        for (const part of m.content) if (part && typeof part.text === 'string') chars += part.text.length;
      }
    }
    const tokens = Math.ceil(chars / 4);

    // ctx 拿不到 => 不猜。旧代码靠 pangu_helpers.getModelContextLength 抛异常来 return false,
    // 那个函数在 registry miss 时**抛**, 所以旧行为其实是「拿不到 ctx 就不压」——
    // 这里显式写出来, 语义一样但不靠异常控制流。
    let ctx = 0;
    try {
      const { getModelContextLength } = require('./pangu_helpers');
      ctx = getModelContextLength(model);
    } catch (_) {
      return false;
    }
    if (!ctx) return false;
    return tokens / Math.max(1, ctx) > TRIGGER_RATIO;
  } catch (_) {
    return false;
  }
}

/**
 * 主入口: 压缩并返回新 messages + snapshot meta。
 *
 * 【产物唯一真源 = (2)】摘要怎么生成、保留哪些消息、工具配对怎么清洗 ——
 * 全部由 modules/session_compaction.js 决定, 本函数不重复实现一遍。
 * 这样两套摘要格式永远不可能同时进上下文。
 */
async function compact(messages, opts = {}) {
  const sessionId = opts.sessionId || 'default';
  const arr = Array.isArray(messages) ? messages : [];
  if (arr.length < 2) return { ok: false, reason: 'no_old_messages_to_compact', messages };

  let cr = null;
  try {
    const { createCompactor } = require('./session_compaction');
    // 每次 compact 用**独立** compactor 实例: 免得跟主循环那个共享 sessions Map,
    // 把「谁在什么 session 上压过」搅在一起 (auto-resume 计数归零就是这么来的)。
    const compactor = createCompactor();
    compactor.register(sessionId, arr);
    cr = await compactor.compact(sessionId);
  } catch (e) {
    console.warn('[compaction] compress failed:', e.message && e.message.slice(0, 200));
    return { ok: false, reason: 'compaction_failed', messages };
  }

  const newMessages = cr && cr.compactedMessages;
  if (!Array.isArray(newMessages) || newMessages.length === 0) {
    return { ok: false, reason: 'llm_summary_failed', messages };
  }

  // 压缩产物必须严格更短, 否则「压完立刻又触发」= 活锁 ((2) 内部已 clamp, 这里兜一道)
  if (newMessages.length >= arr.length) {
    return { ok: false, reason: 'not_shrunk', messages };
  }

  // 快照入档 —— (2) 不做这件事, 而回档证据 (listSnapshots) 依赖它。
  // 存的是 (2) 的产物摘要, 不是另起一套格式。
  const summaryText = _extractSummaryText(newMessages);
  ensureDir();
  const snapId = _newSnapId(sessionId);
  const snapshot = {
    id: snapId,
    ts: new Date().toISOString(),
    session_id: sessionId,
    summary: summaryText,
    old_count: arr.length,
    recent_count: newMessages.length,
    model_id: opts.modelId || null,
  };
  try {
    _atomicWrite(path.join(COMPACTION_DIR(), snapId + '.json'), JSON.stringify(snapshot, null, 2));
  } catch (e) {
    console.warn('[compaction] snapshot write failed:', e.message && e.message.slice(0, 200));
  }

  return { ok: true, messages: newMessages, snapshot, ratio_before: opts.ratio_before || null };
}

function listSnapshots(sessionId, limit = 50) {
  try {
    if (!fs.existsSync(COMPACTION_DIR())) return [];
    const all = [];
    // 与 _newSnapId 同一个函数 + 同一个截断长度 ⇒ 写出来的名字能被这里前缀匹配到;
    // 再用快照文件里自己的 session_id 校一遍 ⇒ 前缀撞上但属于别的 session 的快照不串进来。
    const cands = sessionKeyCandidates(sessionId, _SNAP_ID_MAXLEN);
    const eff = String(sessionId || 'default');
    for (const f of fs.readdirSync(COMPACTION_DIR()).filter(x => x.endsWith('.json'))) {
      try {
        if (cands.length && !cands.some(c => f.startsWith(c))) continue;
        const d = JSON.parse(fs.readFileSync(path.join(COMPACTION_DIR(), f), 'utf8'));
        if (d.session_id && d.session_id !== eff) continue; // 是别人的快照
        all.push({ id: d.id, ts: d.ts, session_id: d.session_id, old_count: d.old_count, recent_count: d.recent_count });
      } catch (_) {}
    }
    return all.sort((a, b) => (b.ts || '').localeCompare(a.ts || '')).slice(0, limit);
  } catch (_) { return []; }
}

module.exports = {
  needsCompaction,
  compact,
  listSnapshots,
  _paths: { COMPACTION_DIR },
};
