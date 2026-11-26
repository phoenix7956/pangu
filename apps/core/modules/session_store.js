'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentDatabase, normalizeMessageContent } = require('./agentdb/db');
const { AgentDBIndex } = require('./agentdb/index');
const { embedText } = require('./agentdb/embedder');
// 2026-10-25 (第 92 批): session id → 落盘文件名的唯一真源。
//   原来这里自己抄了一份清洗 ⇒ 跟 tasks 目录各算各的, '#' 被换成 '_' 后
//   'parent#sub-0-li' 与 'parent_sub-0-li' 落同一个文件 ⇒ 两个会话互相覆盖。
const { resolveSessionKey } = require('./session_key');

const DEFAULT_SESSIONS_DIR = path.resolve(
  process.env.PANGU_SESSIONS_DIR || path.join(os.homedir(), '.pangu-data', 'sessions')
);
const DEFAULT_AGENTDB_DIR = path.resolve(
  process.env.PANGU_AGENTDB_DIR || path.join(os.homedir(), '.pangu-data', 'agentdb')
);

function currentSessionsDir() {
  return path.resolve(process.env.PANGU_SESSIONS_DIR || DEFAULT_SESSIONS_DIR);
}

function currentAgentDbDir() {
  return path.resolve(process.env.PANGU_AGENTDB_DIR || DEFAULT_AGENTDB_DIR);
}

let _agentDb = null;
let _agentIndex = null;
let _syncPromise = null;
let _agentDbRoot = '';
let _agentIndexRoot = '';

function ensureSessionsDir() {
  fs.mkdirSync(currentSessionsDir(), { recursive: true });
}

function validateSessionId(id) {
  // `#` 是子 agent sid 的固有字符 (j2_dispatcher 恒用 `parentId + '#sub-' + n + '-' + role`)。
  // 2026-10-13 现场: 它原先不在白名单里, 子 agent 的每一次 save/load/delete 都抛
  // INVALID_SESSION_ID, 抛错又被 _persistSession 的 catch 吃掉只剩一行 warn —— 不报错、
  // 无计数器, 现场看起来就是「子 agent 干完就忘」。父会话因此只能照抄子 agent 的自述。
  // `#` 不是路径分隔符, 放行它; `.` `/` 仍拒 —— 路径穿越那道闸门不能跟着一起拆。
  if (typeof id !== 'string' || !/^[A-Za-z0-9_#-]+$/.test(id)) {
    throw new Error('非法 session id: ' + JSON.stringify(id));
  }
  return id;
}

function sessionFilePath(id) {
  // 文件名走 session_key.js 唯一真源 (第 92 批), 两边文件名才能对上号:
  // ~/.pangu/state/tasks/xxx_sub-1-executor.json ↔ ~/.pangu-data/sessions/xxx_sub-1-executor.json
  //   纯清洗 ⇒ 存量零改名 (sessions 目录 741 个文件一个都不动);
  //   真撞名 (目标文件属于别的 session) ⇒ 换指纹名, 不覆盖别人的会话。
  const valid = validateSessionId(id);
  const safe = resolveSessionKey(currentSessionsDir(), valid);
  return path.join(currentSessionsDir(), `${safe}.json`);
}

function getAgentDb() {
  const root = currentAgentDbDir();
  if (!_agentDb || _agentDbRoot !== root) {
    _agentDb = new AgentDatabase({ root });
    _agentDbRoot = root;
  }
  return _agentDb;
}

function getAgentIndex() {
  const root = currentAgentDbDir();
  if (!_agentIndex || _agentIndexRoot !== root) {
    _agentIndex = new AgentDBIndex({ root });
    _agentIndexRoot = root;
  }
  return _agentIndex;
}

function closeAgentDB() {
  if (_agentIndex) _agentIndex.close();
  if (_agentDb) _agentDb.close();
  _agentIndex = null;
  _agentDb = null;
  _syncPromise = null;
}

function readJsonSession(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(sessionFilePath(sessionId), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeJsonSession(sessionId, data) {
  ensureSessionsDir();
  const target = sessionFilePath(sessionId);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch (_) {}
    throw error;
  }
}

function _stripThinking(content) {
  // 2026-09-22: assistant 存盘前剥 标签 — thinking 是模型的内心独白, 不该被下一轮
  // 当"上一轮说过的话"喂回 (实案: session 60273479 msg[8] 整条 thinking 713 字,
  // 下轮 LLM 看到自己"已思考过" → 跳过工具直接复述/重新起卦). 正文保留.
  if (typeof content !== 'string') return content;
  return content
    .replace(/think[\s\S]*?<\/think>\s*/gi, '')   // 成对剥
    .replace(/think[\s\S]*$/gi, '');                  // 未闭合到末尾
}

function normalizeMessages(messages) {
  // 2026-10-28 (现场会话 web-1793124838326 + 探针 probe-dup3-20261028):
  //   落盘会话里存的是**给模型看的脚手架版本** (卦块/排盘事实/分层编排都拼在 user 消息里)。
  //   后果有两条, 都是老板亲眼报的:
  //     ① UI 一刷新, 这些块连同 9 条 system 提示词全灌进聊天区 —— 「头部重复」「全乱了」。
  //     ② 会话被接回时, 脚手架版本跟客户端的原话**比不上** ⇒ 同一轮被当成两条再塞一遍。
  //   所以落盘改存**干净正文** (主人原话), 注入版另存 `injected` 字段 ——
  //   事实抽取还要用它 (四柱可能只出现在注入块里), 但对话与显示都不该看它。
  let _core = (t) => String(t || '');
  try { _core = require('./answer_alignment').coreUserText; } catch (_) { /* 模块不在就存原样 */ }
  return (Array.isArray(messages) ? messages : []).map(message => {
    const _role = typeof message.role === 'string' ? message.role : 'user';
    // assistant 剥 thinking; user/system/tool 原样 (user 里的 think 是引用, 不剥)
    const _content = message.role === 'assistant'
      ? _stripThinking(normalizeMessageContent(message.content))
      : normalizeMessageContent(message.content);
    const out = { ...message, role: _role, content: _content };
    if (_role === 'user' && typeof _content === 'string') {
      const _clean = String(message.raw || _core(_content) || '').trim();
      if (_clean && _clean !== _content) {
        out.injected = _content;
        out.content = _clean;
      }
    }
    return out;
  });
}

// 2026-10-28 (第 134 批, 现场会话 web-1793124838326):
//   第 133 批之后新写的会话, user 消息带 `raw` (主人原话), 落盘也存干净正文。
//   但**修复之前**存的老会话没有 `raw` —— 里面存的是给模型看的脚手架版本:
//   「【盘古起卦 …】<卦块> 主人问题: <原话>【排盘事实 …】」。
//   老会话读出来还是这副样子 ⇒ UI 显示卦块和排盘事实 (老板报的「头部重复」「全乱了」),
//   而且同一轮的两条 (干净版 + 注入版) 谁跟谁都不等。
//   ⇒ **读的时候也剥一次**, 口径跟写的时候同一个函数 (coreUserText) —— 不在前端再抄一份。
//   注入版不丢, 另存 `injected`: 四柱事实只出现在注入块里 (bazi_chart_facts 要扫它)。
function cleanUserMessagesOnLoad(messages) {
  let _core = (t) => String(t || '');
  try { _core = require('./answer_alignment').coreUserText; } catch (_) { /* 模块不在就原样 */ }
  return (Array.isArray(messages) ? messages : []).map(m => {
    if (!m || m.role !== 'user' || typeof m.content !== 'string') return m;
    const clean = String(m.raw || _core(m.content) || '').trim();
    // 已经干净 ⇒ **原样返回** (不补字段) —— 加一个 raw 就让
    // 「存进去 == 读出来」这条老判据 (agentdb.test.js) 的深比较挂掉。
    if (!clean || clean === m.content) return m;
    return { ...m, injected: m.injected || m.content, content: clean, raw: clean };
  });
}

function serializeSession(args, messages) {
  return {
    session_id: args.session_id,
    plan_id: args.plan_id || null,
    messages,
    compaction_summary: args.compaction_summary || '',
    state: args.state || 'active',
    message_count: messages.length,
    last_updated: args.ts || Date.now(),
    plan_state: args.plan_state || null,
  };
}

async function buildEmbeddings(messages, embed = embedText) {
  const embeddings = [];
  for (const message of messages) {
    const content = normalizeMessageContent(message.content).trim();
    if (!content) {
      embeddings.push(null);
      continue;
    }
    try {
      const result = await embed(content);
      const normalized = Array.isArray(result)
        ? { vector: result, model: 'custom' }
        : result;
      embeddings.push(normalized && Array.isArray(normalized.vector) ? normalized : null);
    } catch (error) {
      console.warn('[session-store] embedding failed:', error.message);
      embeddings.push(null);
    }
  }
  return embeddings;
}

async function syncIndex(db) {
  const rows = db.listEmbeddedVectors();
  if (rows.length === 0) return { ok: true, mode: 'empty', count: 0 };
  const fingerprint = db.fingerprint(rows);
  return getAgentIndex().sync(rows, fingerprint);
}

async function persistToAgentDb(data, messages, options = {}) {
  const db = getAgentDb();
  const embeddings = await buildEmbeddings(messages, options.embed || embedText);
  const embeddingDimensions = embeddings.filter(Boolean).map(item => item.vector.length);
  if (embeddingDimensions.length > 0) {
    const firstDimension = embeddingDimensions[0];
    if (embeddingDimensions.some(dimension => dimension !== firstDimension)) {
      throw new Error('embedding dimension mismatch within session');
    }
    db.setEmbeddingDimension(firstDimension);
  }
  db.transaction(() => {
    db.upsertSession({
      sessionId: data.session_id,
      createdAt: data.ts || data.last_updated,
      updatedAt: data.last_updated,
      planId: data.plan_id,
      planState: data.plan_state,
      summary: data.compaction_summary,
      state: data.state,
      messageCount: messages.length,
    });
    db.upsertMessages(data.session_id, messages, embeddings, embeddingDimensions.length ? 'mixed' : 'none');
  });
  const indexResult = await syncIndex(db);
  return { db, embeddings, indexResult };
}

async function sessionSave(args = {}) {
  const sessionId = args.session_id;
  if (!sessionId) return { ok: false, error: { code: 'NO_SESSION_ID', message: 'session_id required' } };
  try { validateSessionId(sessionId); } catch (error) {
    return { ok: false, error: { code: 'INVALID_SESSION_ID', message: error.message } };
  }
  const messages = normalizeMessages(args.messages);
  const data = serializeSession(args, messages);
  try {
    // JSON remains the immediate, independently readable fallback. SQLite is canonical for recall/load.
    writeJsonSession(sessionId, data);
    const persisted = await persistToAgentDb({ ...data, ts: args.ts || data.last_updated }, messages, args);
    return {
      ok: true,
      result: {
        session_id: sessionId,
        path: sessionFilePath(sessionId),
        agentdb_path: persisted.db.path,
        message_count: messages.length,
        state: data.state,
        index_mode: persisted.indexResult.mode,
      },
    };
  } catch (error) {
    console.warn('[session-store] AgentDB write failed; JSON fallback retained:', error.message);
    return {
      ok: true,
      result: {
        session_id: sessionId,
        path: sessionFilePath(sessionId),
        message_count: messages.length,
        state: data.state,
        degraded: true,
        warning: 'AGENTDB_WRITE_FAILED',
      },
    };
  }
}

async function sessionLoad(args = {}) {
  const sessionId = args.session_id;
  if (!sessionId) return { ok: false, error: { code: 'NO_SESSION_ID', message: 'session_id required' } };
  try { validateSessionId(sessionId); } catch (error) {
    return { ok: false, error: { code: 'INVALID_SESSION_ID', message: error.message } };
  }
  // 2026-10-15 修: **两个数据源取更新的那个**, 而不是无条件信 AgentDB。
  //
  // 原来的不对称是这么形成的:
  //   sessionSave → 先 writeJsonSession, 再 persistToAgentDb, 后者抛错时 catch 里
  //     写着 "JSON fallback retained" —— 言下之意是"AgentDB 挂了还有 JSON 兜着"。
  //   sessionLoad → 却**只查 AgentDB**, 查不到才读 JSON。
  // 于是那个 fallback 是**只写不读**的: 一次 AgentDB 写失败之后, JSON 里躺着新消息,
  // AgentDB 里冻着旧消息, 而下一次 sessionLoad 永远返回旧的 —— 静默读到陈旧状态,
  // 调用方完全看不出自己拿的是哪一版。
  //
  // 现场 (2026-10-15): force-compact-endpoint 测试往 JSON 写 17 条消息, 读回来 4 条,
  // 因为生产 AgentDB (91MB / 1322 个 session) 里有一条同名的旧行, AgentDB 优先把它盖住了。
  //
  // 修法: 两边都读, 按 last_updated 取新的; 平手时仍偏向 AgentDB (保持原行为 ——
  // 正常写入路径下两边同刻, 不改变既有语义)。任一侧缺失就退另一侧。
  let fromDb = null;
  let dbError = null;
  try {
    fromDb = getAgentDb().getSession(sessionId);
  } catch (error) {
    dbError = error;
  }
  const fromJson = readJsonSession(sessionId);
  if (!fromDb && !fromJson) {
    if (dbError) {
      console.warn('[session-store] AgentDB load failed, and no JSON fallback exists:', dbError.message);
      return { ok: false, error: { code: 'SESSION_NOT_FOUND', message: `session ${sessionId} 不存在 (AgentDB 读取失败: ${dbError.message})` } };
    }
    return { ok: false, error: { code: 'SESSION_NOT_FOUND', message: `session ${sessionId} 不存在` } };
  }
  if (!fromDb) return { ok: true, result: _withCleanUsers(fromJson), degraded: true };
  if (!fromJson) return { ok: true, result: _withCleanUsers(fromDb) };

  const dbTs = Number(fromDb.last_updated) || 0;
  const jsonTs = Number(fromJson.last_updated) || 0;
  if (jsonTs > dbTs) {
    // JSON 更新 —— 说明 AgentDB 那次写失败了 (或还没追上)。返回 JSON 并标记,
    // 让调用方有机会发现"我拿到的是降级副本", 而不是无声无息地继续用旧的。
    return { ok: true, result: _withCleanUsers(fromJson), degraded: true, stale_agentdb: true };
  }
  return { ok: true, result: _withCleanUsers(fromDb) };
}

// 把「读出来的 user 消息剥成主人原话」这层套在会话结果外面。
function _withCleanUsers(result) {
  if (!result || !Array.isArray(result.messages)) return result;
  return { ...result, messages: cleanUserMessagesOnLoad(result.messages) };
}

async function sessionList(args = {}) {
  const limit = Math.max(1, Math.min(Number(args.limit) || 20, 200));
  try {
    const sessions = getAgentDb().listSessions(limit);
    if (sessions.length > 0) return { ok: true, result: { sessions, count: sessions.length } };
  } catch (error) {
    console.warn('[session-store] AgentDB list failed, using JSON fallback:', error.message);
  }
  ensureSessionsDir();
  try {
    const sessions = fs.readdirSync(currentSessionsDir())
      .filter(file => file.endsWith('.json'))
      .map(file => readJsonSession(file.replace(/\.json$/, '')))
      .filter(Boolean)
      // 2026-10-28: 跟 agentdb.listSessions 同一口径 —— 只列主对话, 排掉
      // 子 agent 侧车 (`#`)、计划脚手架 (`plan_*`)、工具审计日志 (`self_correct_audit`)。
      .filter(d => d.session_id
        && !String(d.session_id).includes('#')
        && !String(d.session_id).startsWith('plan')
        && d.state !== 'self_correct_audit')
      .sort((a, b) => (b.last_updated || 0) - (a.last_updated || 0))
      .slice(0, limit)
      .map(data => ({
        session_id: data.session_id,
        state: data.state,
        message_count: data.message_count,
        plan_id: data.plan_id,
        last_updated: data.last_updated,
      }));
    return { ok: true, result: { sessions, count: sessions.length }, degraded: true };
  } catch (error) {
    return { ok: false, error: { code: 'LIST_FAILED', message: error.message } };
  }
}

async function sessionDelete(args = {}) {
  const sessionId = args.session_id;
  if (!sessionId) return { ok: false, error: { code: 'NO_SESSION_ID', message: 'session_id required' } };
  try { validateSessionId(sessionId); } catch (error) {
    return { ok: false, error: { code: 'INVALID_SESSION_ID', message: error.message } };
  }
  let deleted = false;
  try { deleted = getAgentDb().deleteSession(sessionId) || deleted; } catch (error) {
    console.warn('[session-store] AgentDB delete failed:', error.message);
  }
  try {
    fs.unlinkSync(sessionFilePath(sessionId));
    deleted = true;
  } catch (error) {
    if (error.code !== 'ENOENT') return { ok: false, error: { code: 'DELETE_FAILED', message: error.message } };
  }
  // A deleted session must not be resurrected by any resume/plan sidecar.
  // These stores intentionally live outside AgentDB and are not covered by FK.
  try { require('./checkpoint').clearCheckpoints(sessionId); } catch (error) { console.warn('[session-store] checkpoint cleanup failed:', error.message); }
  try { require('./task_checkpoint').clearTaskCheckpoint(sessionId); } catch (error) { console.warn('[session-store] task checkpoint cleanup failed:', error.message); }
  try { require('./plan_state').clearPlan(sessionId); } catch (error) { console.warn('[session-store] plan cleanup failed:', error.message); }
  return deleted
    ? { ok: true, result: { session_id: sessionId, deleted: true } }
    : { ok: false, error: { code: 'SESSION_NOT_FOUND', message: `session ${sessionId} 不存在` } };
}

async function sessionRecall(args = {}) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { ok: false, error: { code: 'NO_QUERY', message: 'query required' } };
  const k = Math.max(1, Math.min(Number(args.k) || 5, 20));
  const db = getAgentDb();
  const embed = args.embed || embedText;
  let embeddingError = null;
  try {
    const embedded = await embed(query);
    const vector = Array.isArray(embedded) ? embedded : embedded && embedded.vector;
    if (Array.isArray(vector) && vector.length > 0) {
      const rows = db.listEmbeddedVectors();
      if (rows.length > 0) {
        const fingerprint = db.fingerprint(rows);
        getAgentIndex().sync(rows, fingerprint);
        const searchResult = getAgentIndex().search(vector, k, rows);
        if (searchResult && Array.isArray(searchResult.neighbors)) {
          const memories = db.getMemoriesByIds(searchResult.neighbors).map((memory, index) => ({
            ...memory,
            score: searchResult.distances && Number.isFinite(searchResult.distances[index])
              ? 1 - searchResult.distances[index]
              : 0,
          }));
          if (memories.length > 0) return { ok: true, result: { memories, mode: 'hnsw', query } };
        }
      }
    }
  } catch (error) {
    embeddingError = error;
    console.warn('[session-store] semantic recall unavailable:', error.message);
  }
  const memories = db.keywordSearch(query, k);
  return {
    ok: true,
    result: {
      memories,
      mode: 'keyword',
      query,
      degraded: Boolean(embeddingError),
      warning: embeddingError ? 'EMBEDDING_UNAVAILABLE' : undefined,
    },
  };
}

async function ensureIndex() {
  if (_syncPromise) return _syncPromise;
  _syncPromise = (async () => {
    try { return await syncIndex(getAgentDb()); } finally { _syncPromise = null; }
  })();
  return _syncPromise;
}

module.exports = {
  sessionSave,
  sessionLoad,
  sessionList,
  sessionDelete,
  sessionRecall,
  ensureIndex,
  closeAgentDB,
  getAgentDb,
  getAgentIndex,
  SESSIONS_DIR: DEFAULT_SESSIONS_DIR,
  AGENTDB_DIR: DEFAULT_AGENTDB_DIR,
};
