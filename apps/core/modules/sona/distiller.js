'use strict';

// R40 Pattern Distiller — LLM 抽模式 + 写 patterns 表
// spec §阶段 4: 调 LLM 必须 try/catch + JSON parse + 不阻塞

const { embedText } = require('../agentdb/embedder');
const { themeHint } = require('./classifier');

const DISTILL_PROMPT = `分析以下 {N} 条 "{theme}" 任务的执行模式, 提炼共同成功模式.

{trajectories}

请输出 JSON:
{{
  "pattern_summary": "一句话总结核心策略 (≤80 字)",
  "decision_points": ["关键决策 1", "关键决策 2", "关键决策 3"]
}}

只输出 JSON, 不要其他.`;

async function distillTheme(getDb, theme, opts = {}) {
  const db = typeof getDb === 'function' ? await getDb() : getDb;
  if (!db) return null;

  const trajectories = db.getRecentTrajectories(theme, opts.limit || 30);
  const minSample = opts.minSampleSize || 2;
  if (trajectories.length < minSample) return null;

  const formatted = trajectories.slice(0, 5).map((t, i) => {
    const tools = (() => { try { return JSON.parse(t.tools_used || '[]').join(', '); } catch (_) { return ''; } })();
    return `[${i + 1}] input: ${String(t.user_input || '').slice(0, 200)}\n   summary: ${t.assistant_summary || '(无)'}\n   tools: ${tools || '(无)'}`;
  }).join('\n');

  const prompt = DISTILL_PROMPT
    .replace('{N}', String(trajectories.length))
    .replace('{theme}', theme)
    .replace('{trajectories}', formatted);

  let parsed;
  try {
    const llm = opts.callLLM || require('../llm_caller').callLLM;
    const result = await llm([{ role: 'user', content: prompt }], opts.llmConfig);
    const content = (result && (result.content || (result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content))) || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.warn('[sona] distill LLM failed:', e.message && e.message.slice(0, 200));
    return null;
  }

  if (!parsed || !parsed.pattern_summary) return null;

  try {
    const emb = await embedText(parsed.pattern_summary);
    const patternId = db.upsertPattern({
      theme,
      patternSummary: parsed.pattern_summary,
      decisionPoints: JSON.stringify(parsed.decision_points || []),
      trajectoryIds: JSON.stringify(trajectories.slice(0, 10).map(t => t.id)),
      embedding: emb,
      sampleSize: trajectories.length,
    });
    return patternId;
  } catch (e) {
    console.warn('[sona] pattern upsert failed:', e.message && e.message.slice(0, 200));
    return null;
  }
}

async function distillAll(getDb, opts = {}) {
  const db = typeof getDb === 'function' ? await getDb() : getDb;
  if (!db) return { distilled: 0, themes: [] };
  const themes = db.getActiveThemes(opts.minSampleSize || 2);
  const ids = [];
  for (const theme of themes) {
    const id = await distillTheme(db, theme, opts);
    if (id) ids.push(id);
  }
  return { distilled: ids.length, themes };
}

module.exports = { distillTheme, distillAll };
