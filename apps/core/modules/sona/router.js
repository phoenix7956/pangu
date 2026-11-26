'use strict';

// R40 Smart Match — Recall patterns + format for prompt injection
// spec §阶段 5: 复用 R39 _injectRelevantMemories 模式 (1800 char + "以当前输入为准")

const { themeHint } = require('./classifier');

function recallPatternsForInput(getDb, input, opts = {}) {
  try {
    const db = typeof getDb === 'function' ? (getDb.__esModule ? getDb : getDb()) : getDb;
    if (!db) return [];
    const theme = opts.themeHint || themeHint(input);
    const patterns = db.searchPatterns(theme, { limit: opts.k || 3 });
    return patterns.map(p => ({
      id: p.id,
      theme: p.theme,
      pattern_summary: p.pattern_summary,
      decision_points: (() => { try { return JSON.parse(p.decision_points || '[]'); } catch (_) { return []; } })(),
      sample_size: p.sample_size,
      hit_count: p.hit_count,
      trajectory_refs: (() => { try { return JSON.parse(p.trajectory_ids || '[]'); } catch (_) { return []; } })(),
    }));
  } catch (e) {
    console.warn('[sona] recall patterns failed:', e.message && e.message.slice(0, 200));
    return [];
  }
}

function formatPatternsForPrompt(patterns, maxChars = 1200) {
  if (!Array.isArray(patterns) || patterns.length === 0) return '';
  const lines = ['## 学习到的成功模式 (SONA ReasoningBank)'];
  let used = lines[0].length;
  for (const p of patterns) {
    const dps = (p.decision_points || []).slice(0, 3);
    const block = `\n\n### 主题: ${p.theme} (基于 ${p.sample_size} 条历史任务, ${p.hit_count} 次命中)\n${p.pattern_summary}\n关键决策:\n${dps.map((d, i) => `  ${i + 1}. ${d}`).join('\n')}`;
    if (used + block.length > maxChars) break;
    lines.push(block);
    used += block.length;
  }
  return lines.join('');
}

async function injectSonaPatterns(messages, input, getDb, opts = {}) {
  try {
    if (process.env.PANGU_SONA_ENABLED === '0') return messages;
    const patterns = recallPatternsForInput(getDb, input, opts);
    if (patterns.length === 0) return messages;
    const formatted = formatPatternsForPrompt(patterns, opts.maxChars || 1200);
    if (!formatted) return messages;
    messages.push({
      role: 'system',
      content: `${formatted}\n\n参考这些学习到的模式; 但以当前用户输入 + 相关记忆为准.`,
    });
    for (const p of patterns) {
      try {
        const db = typeof getDb === 'function' ? getDb() : getDb;
        if (db && typeof db.incrementPatternHit === 'function') db.incrementPatternHit(p.id);
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[sona] inject failed:', e.message && e.message.slice(0, 200));
  }
  return messages;
}

module.exports = { recallPatternsForInput, formatPatternsForPrompt, injectSonaPatterns };
