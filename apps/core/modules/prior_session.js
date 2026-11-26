// 2026-08-30: 跨 session 上下文加载 (修复"盘古新会话完全失忆"问题)
// checkpoint.js 只覆盖同 sessionId 30min 内的恢复, 但用户开新 session 时完全失忆。
// 本模块读 ~/.pangu/state/checkpoints/ 下任意最近 session 的 checkpoint,
// 抽出摘要注入新 session 的 system prompt, 让 pangu 能接上之前诊断线索。

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
const CHECKPOINT_DIR = process.env.PANGU_CHECKPOINT_DIR
  || path.join(DEFAULT_PANGU_HOME, 'state', 'checkpoints');
// 2026-10-25 (第 93 批): 排除自己时必须用**落盘用的那个文件名**, 不是原始 sid。
const { resolveSessionKeyPrefix } = require('./session_key');

/**
 * 列出最近 N 个其他 session 的 checkpoint 摘要
 * @param {Object} opts
 * @param {string} [opts.excludeSessionId] - 排除的 sessionId (通常是新 session 自己)
 * @param {number} [opts.maxAgeMs=21600000] - 最长有效期 (默认 6h)
 * @param {number} [opts.limit=3] - 最多返回几条
 * @returns {Array<{session_id, round, ts, age_min, plan_id, task_input, summary, file}>}
 */
function loadRecentSessionContext({ excludeSessionId = null, excludeSessionPrefix = null, maxAgeMs = 6 * 3600 * 1000, limit = 3 } = {}) {
  let files;
  try {
    files = fs.readdirSync(CHECKPOINT_DIR).filter(f => /_r\d+\.json$/.test(f));
  } catch (e) { return []; }
  const now = Date.now();
  const items = [];
  // 2026-10-25 (第 93 批): 「排除自己」原来拿**原始 sid** 去 startsWith 文件名 ——
  //   而落盘名是清洗过的 (子 agent 的 sid 恒为 `父会话#sub-N-role`,
  //   '#' 落盘成 '_') ⇒ 永远不匹配 ⇒ 排除自己**从来没生效过**
  //   ⇒ 子 agent 会把**自己上一手的 checkpoint** 当成「跨会话上下文」灌进提示词
  //   (既浪费 token, 又把「上一手」错标成「别的手」)。
  //   修法: 用 session_key 唯一真源算出**这个 sid 真正的落盘前缀**。
  const selfPrefix = excludeSessionId
    ? resolveSessionKeyPrefix(CHECKPOINT_DIR, excludeSessionId, { sep: '_r' }) + '_r'
    : null;
  for (const f of files) {
    if (selfPrefix && f.startsWith(selfPrefix)) continue;
    // 2026-10-16 (现场 e2e-scope-20261016, 子会话落盘逐条量出来的):
    // 子 agent 的 sid 恒为 `父会话#sub-N-role` (session_store.js 的固有约定), 所以
    // excludeSessionId 只能挡掉**自己**, 挡不住兄弟。而这里挑的是"最近的 3 个会话",
    // 同一轮派出去的兄弟子 agent 正好是最最近的三个 checkpoint —— 于是它们的**原始
    // prompt 转录**被当成"上文"整份灌进每一个兄弟的系统提示里。
    //
    // 实测 sub-2-analyzer 的系统块因此涨到 12639 字 (同代码路径上一轮是 9889 字),
    // 多出来的约 7.3k 字是**三份几乎逐字重复**的兄弟刀 prompt:
    //   【卦·损�.Quoc】+ 任务 + 【主人原话里的路径 — 直接照抄…】**三个路径** + 收口纪律 …
    // 那三个路径就是它去读兄弟文件的直接原因 (它被派 checkpoint.js, 却读了三个文件,
    // 工具结果 35.8k 字)。兄弟产出本来有正规通道 —— _ctxForSubagent 的 findingsBlock,
    // 那是按相关性筛过、摘要过的。这里等于把原始转录整份倒一遍: 又贵又污染分工。
    if (excludeSessionPrefix && f.indexOf(excludeSessionPrefix) === 0) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(CHECKPOINT_DIR, f), 'utf8')); }
    catch (_) { continue; }
    const ts = d.ts || 0;
    const age = now - ts;
    if (age > maxAgeMs || age < 0) continue;
    items.push({
      session_id: d.session_id,
      round: d.round,
      ts,
      age_min: Math.round(age / 60000),
      plan_id: d.plan_id || null,
      task_input: (d.task_input || '').toString().slice(0, 300),
      summary: extractSummary(d.messages || []),
      file: f,
    });
  }
  items.sort((a, b) => b.ts - a.ts);
  return items.slice(0, limit);
}

/**
 * 从 checkpoint 的 messages 里抽摘要: 优先找 【会话摘要】 / keyTopics 标记,
 * fallback 取最近 3 条 user 内容拼接。
 */
function extractSummary(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : '';
    if (content.includes('【会话摘要】') || content.includes('keyTopics')) {
      return content.slice(0, 1200);
    }
  }
  const users = messages.filter(m => m.role === 'user').slice(-3);
  const fallback = users
    .map(m => typeof m.content === 'string' ? m.content.slice(0, 250) : '')
    .filter(Boolean)
    .join(' || ');
  return fallback.slice(0, 1200);
}

/**
 * 把 items 渲染成 system prompt 注入块 (中文, 简洁)
 */
function buildPriorContextPrompt(items) {
  if (!items.length) return '';
  const blocks = items.map((it, i) =>
    `[Prior session ${i + 1}/${items.length}] session_id=${it.session_id} | round=${it.round} | ${it.age_min}min ago | file=${it.file}\n` +
    `  task: ${it.task_input || '(无 task_input)'}\n` +
    `  plan: ${it.plan_id || '(无 plan)'}\n` +
    `  summary: ${it.summary || '(无摘要)'}`
  );
  return `\n\n# 跨会话上下文 (auto-injected from prior checkpoints)\n` +
    `> 这是新 session 启动时自动加载的最近 ${items.length} 个 session 摘要。\n` +
    `> 来源: ~/.pangu/state/checkpoints/ (默认 6h 内, 跳过当前 session)。\n` +
    `> 作用: 帮新 session 承接之前的诊断/讨论线索, 避免反复排查相同问题。\n\n` +
    blocks.join('\n\n---\n\n') + '\n';
}

module.exports = { loadRecentSessionContext, buildPriorContextPrompt, CHECKPOINT_DIR };
