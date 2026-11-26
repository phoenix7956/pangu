'use strict';

// R40 Trajectory Logger — fire-and-forget, 跟 R39 _persistSession 同模式
// spec §阶段 2: 不阻塞 round, 失败 log warn 不抛

const { themeHint } = require('./classifier');

function _summarize(messages) {
  const lastAssistant = [...(messages || [])].reverse().find(m => m && m.role === 'assistant');
  return (lastAssistant && lastAssistant.content ? String(lastAssistant.content) : '').slice(0, 200).replace(/\s+/g, ' ').trim();
}

function _extractTools(messages) {
  const tools = new Set();
  for (const m of (messages || [])) {
    if (m && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc && tc.function && tc.function.name) tools.add(tc.function.name);
      }
    }
  }
  return [...tools];
}

function _totalTokens(messages) {
  let total = 0;
  for (const m of (messages || [])) {
    if (m && m.usage && typeof m.usage.total_tokens === 'number') total += m.usage.total_tokens;
  }
  return total;
}

function _countRounds(messages) {
  return (messages || []).filter(m => m && m.role === 'assistant').length;
}

async function logTrajectory(getDb, sessionId, input, messages, opts = {}) {
  try {
    const db = typeof getDb === 'function' ? await getDb() : getDb;
    if (!db) return null;
    const toolsUsed = _extractTools(messages);
    const summary = _summarize(messages);
    const tokens = _totalTokens(messages);
    const rounds = _countRounds(messages);

    return db.addTrajectory({
      sessionId,
      theme: themeHint(input),
      userInput: String(input || '').slice(0, 2000),
      assistantSummary: summary,
      toolsUsed: JSON.stringify(toolsUsed),
      toolCallCount: toolsUsed.length,
      tokensTotal: tokens,
      rounds,
      // 2026-08-02 修: 调用方传的是整个 model config 对象 ({ model }), 不是字符串 —
      // better-sqlite3 把对象绑定误判为命名参数 → "Too few parameter values" → 7/26 起每条 trajectory 全丢
      modelUsed: (typeof opts.model === 'string' ? opts.model : (opts.model && (opts.model.id || opts.model.name))) || 'unknown',
    });
  } catch (e) {
    console.warn('[sona] trajectory log failed:', e.message && e.message.slice(0, 200));
    return null;
  }
}

module.exports = { logTrajectory };
