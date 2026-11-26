// modules/memory_snapshot.js —— 会话开局的记忆快照注入
//
// 2026-10-30 (第 173 批): 从 openclaw 接收。
//
// 老 openclaw 有一链: `local.mo-memory-auto-recall` (launchd, 每 30 分钟) 跑
// `workspace/scripts/memory-auto-recall.py`, 用 `openclaw memory search` 查 6 条核心
// query, 把结果写进 `workspace/assets/BOOTSTRAP.md`; openclaw 的
// `hooks.internal.bootstrap-extra-files` 再把它当常驻文件注入每次会话。
//
// 退役前实测 (2026-10-30):
//   · 那条链每 30 分钟拉起整个 openclaw node 运行时 (879MB 包) + 277MB agent.sqlite,
//     **峰值 597MB 内存, 单次 17.6 秒** ⇒ 一天 48 次 ≈ 每天 28 分钟的纯浪费。
//   · 而它算出来的 BOOTSTRAP.md, **唯一消费者是 openclaw 自己的 hook**
//     (gateway 12:16 已死) ⇒ 每 30 分钟重算一份没人读的文件。
//   · 盘古这边 grep 不到任何 BOOTSTRAP/MEMORY 注入 ⇒ **盘古一直没有等价能力**。
//
// 所以这里补上盘古自己的版本: 直接读 ~/.pangu/memory/main.sqlite 的 chunks/chunks_fts,
// 用一组核心 query 取命中, 压成一段紧凑快照注入 system。
//
// 设计约束:
//   · **必须有界** — 注入进 system 的每一 token 都要付 prefill 代价
//     (踩坑日志: 重复注入 3 份 × 5302 token = 提示词的 56%)。所以条数/字数都封顶。
//   · **必须不抛错** — 注入抛错 ⇒ SSE 流挂掉 ⇒ 客户端收到空回复。
//     全程 try/catch, 失败就返空串。
//   · **必须便宜** — 不跑 LLM, 只做 sqlite LIKE/FTS 查询 (毫秒级)。

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(os.homedir(), '.pangu', 'memory', 'main.sqlite');

// 核心 recall query —— 每条都是「老板反复拍过、且不会自己变」的那种事实。
// 数量刻意少: 这是每轮 system 都要付的钱。
const CORE_QUERIES = [
  ['老板原则', '老板原则'],
  ['微信通道', '微信通道'],
  ['出歌', '出歌'],
  ['出图', '出图'],
];

const MAX_PER_QUERY = 2;      // 每条 query 最多取几个命中
const MAX_SNIPPET = 160;       // 单条摘要最多多少字符
const MAX_TOTAL = 900;         // 整段快照最多多少字符

function _query(db, q, limit) {
  const out = [];
  try {
    const fts = db.prepare(
      // snippet 的列号是 **fts5 表自己的列序**: 0=text, 1=id, 2=path ...
      // 老代码写 2 ⇒ 取出来的是文件路径不是内容 (踩坑: 快照里全是文件名)。
      `SELECT path, source, snippet(chunks_fts, 0, '<<', '>>', '...', 24) AS snip` +
      ` FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT ?`
    ).all(q, limit);
    for (const r of fts) out.push(r);
  } catch (_) { /* FTS 语法错 ⇒ 交给 LIKE */ }
  if (!out.length) {
    try {
      const like = db.prepare(
        `SELECT path, source, substr(text, 1, ${MAX_SNIPPET}) AS snip FROM chunks` +
        ` WHERE text LIKE ? LIMIT ?`
      ).all('%' + q + '%', limit);
      for (const r of like) out.push(r);
    } catch (_) { /* LIKE 也失败就算了 */ }
  }
  return out;
}

/**
 * 生成记忆快照文本。失败一律返回空串 (不抛)。
 * @param {object} [opts] { queries, maxPerQuery, maxTotal }
 * @returns {string}
 */
function buildMemorySnapshot(opts = {}) {
  try {
    if (!fs.existsSync(DB_PATH)) return '';
    const sqlite3 = require('better-sqlite3');
    const db = sqlite3(DB_PATH, { readonly: true });
    try {
      const queries = opts.queries || CORE_QUERIES;
      const maxPer = opts.maxPerQuery || MAX_PER_QUERY;
      const maxTotal = opts.maxTotal || MAX_TOTAL;
      const lines = [];
      for (const [label, q] of queries) {
        if (lines.join('\n').length > maxTotal) break;
        const hits = _query(db, q, maxPer);
        if (!hits.length) continue;
        lines.push(`【${label}】`);
        for (const h of hits) {
          const snip = String(h.snip || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET);
          if (!snip) continue;
          lines.push(`- ${snip}`);
        }
      }
      const body = lines.join('\n');
      if (!body) return '';
      const head = '[记忆快照 — 开局注入, 来自 ~/.pangu/memory]\n';
      return (head + body).slice(0, maxTotal + head.length);
    } finally {
      db.close();
    }
  } catch (_) {
    return ''; // 记忆不可用不许影响主流程
  }
}

module.exports = { buildMemorySnapshot, CORE_QUERIES, DB_PATH };

