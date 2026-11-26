'use strict';

/**
 * modules/chat_answer_policy.js
 * 兼容端点 (`/message` `/chat` `/api/chat`) 的**答复策略** —— 两条规则:
 *
 *   ① **答复永不为空**。接口回 `{"ok":true, content:""}` = 空气泡 = 主人看到一片空白,
 *      而且**没有任何报错**。宁可明说「没答上来」，也不能回空字符串。
 *   ② **空 ⇒ 该升级**。这条路径是裸 `callLLM`（**没有工具循环**）,
 *      模型一旦想调工具就会只吐草稿 / 空 content ⇒ 说明这道题**需要工具**
 *      ⇒ 该升级到真 agent loop（有工具）去答, 而不是回空气泡。
 *
 * ── 为什么单独一个模块 (而不是把判断埋在 handler 里) ──────────────
 *   「答复不许为空」是一条**不变量**, 不变量要有地方能被直接测。
 *   埋在 HTTP handler 里就只能靠起真服务 + 真模型去测 ⇒ 慢、贵、还不稳定。
 *   抽成纯函数 ⇒ 几十个组合几毫秒跑完, 而且能**逐条变异验证**。
 *
 * ── 为什么不改 answer_alignment.isAligned 的空答案语义 ────────────
 *   `isAligned` 里 `if (!q || !a || q.length < 6) return true;` ⇒ 空答案被判「对齐」。
 *   改它会波及主路径 (`j2_agent_loop.js:1382` / `j2_dispatcher.js:171`) ——
 *   那两处**故意**把空当「不拦」(让上层自己决定兜底文案)。
 *   所以不变量落在**端点这一层**: 谁负责出答复, 谁负责保证答复不是空。
 */

/** 「本轮没答上来」的统一文案 (与 j2_dispatcher.js:172 同一句) */
const NO_ANSWER_TEXT = '本轮未形成与原问题匹配的可核验答案，请重试。';

/**
 * 推理模型的输出预算下限 (2026-10-27 第 112 批)。
 *
 * ── 实测 (MiniMax-M3.1-Flash + 九节八字解读提示, 2026-10-26/27) ──────
 *   max_tokens=6500  → 正文**空** (6500 全被思考吃掉), 主人看到模型的英文自说自话
 *   max_tokens=16384 → 正文**仍然空** (16383 token 全是思考), finish_reason=length
 *   max_tokens=32768 → 正文 3396 字, 九节**全齐**, finish_reason=stop
 *
 * ⚠ 关键: 这个模型的思考长度**跟着预算走** —— 给 16K 它想满 16K, 给 32K
 *   它想 25.3K 才肯落笔。所以「给 16K 就够」是错的直觉: 16K 连思考都装不下,
 *   正文一个字都轮不到。下限必须按**思考 + 正文**一起算。
 *
 * 也就是说: 推理模型至少要 **16K** 输出预算才可能给得出正文;
 * 客户端按「只要 3000 字汉字」去算预算 (6500) ⇒ 必死。
 *
 * 规矩: 推理模型的输出预算不得低于这个下限 —— 除非端点物理上限比它还低
 * (那就听端点的)。非推理模型不受影响 (客户端说多少就是多少)。
 */
const REASONING_OUTPUT_FLOOR = 32768;

/**
 * 这次请求该给多少输出预算。
 *
 * @param {object} p
 * @param {number} [p.requested] 客户端/调用方要的意图值
 * @param {number} [p.hardCap]   端点物理硬上限 (model_capability.hardOutputCap)
 * @param {boolean} [p.reasoningCapable] 这个模型是不是推理模型
 * @param {boolean} [p.effortSpecified] 客户端**显式指定了**本轮推理强度
 * @returns {number|null} 该用的 max_tokens; null = 没意见, 交回调用方默认口径
 */
function resolveOutputBudget(p) {
  const o = p || {};
  const requested = Number(o.requested);
  const hardCap = Number(o.hardCap);
  const isReasoning = !!o.reasoningCapable;
  let budget = (Number.isFinite(requested) && requested > 0) ? Math.floor(requested) : null;
  // 客户端显式指定了推理强度 ⇒ 它自己管住了思考的量 (实测 effort=low 时
  // 思考从 25300 token 掉到 2472, 6500 的预算就够写完 4222 字正文) ⇒
  // 这时**不许**再按默认思考量去抬预算 (那会把一次 42 秒的活变成 171 秒)。
  if (o.effortSpecified) {
    if (Number.isFinite(hardCap) && hardCap > 0 && budget !== null) budget = Math.min(budget, hardCap);
    return budget;
  }
  // 下限只在「端点有已知物理上限」时抬 —— 本地/自建端点的软默认 (8192) 是
  // batch 101 特意定的口径, 不能被这条推理模型规则顺手掀掉。
  if (isReasoning && Number.isFinite(hardCap) && hardCap > 0) {
    const floor = Math.min(REASONING_OUTPUT_FLOOR, hardCap);
    if (budget === null || budget < floor) budget = floor;
  }
  if (Number.isFinite(hardCap) && hardCap > 0 && budget !== null) {
    budget = Math.min(budget, hardCap);
  }
  return budget;
}

/**
 * 快路径没拿到答案时, 要不要升级到 agent loop?
 *
 * @param {object} p
 * @param {string} p.guardedText   guardAnswer 放行后的正文 (可能为空)
 * @param {boolean} p.guardedBlocked  guardAnswer 判跑题 (答了但不对题)
 * @param {boolean} p.wasToolDraft  模型只吐了工具草稿 (正文被剥空)
 * @returns {boolean}
 */
function needsEscalation(p) {
  const o = p || {};
  // 判跑题 ≠ 没答案: 那是「答了但不对题」, 升级重跑一遍也未必对题,
  //   而且会白烧一整轮 agent 编排 ⇒ 不升级, 直接说没答上来。
  if (o.guardedBlocked) return false;
  if (String(o.guardedText || '').trim()) return false;
  // 只吐了工具草稿 ⇒ 这道题需要工具 ⇒ 升级 (有工具的路径才答得了)
  if (o.wasToolDraft) return true;
  // 模型返回空 ⇒ 升级试试 (快路径没有工具循环, 空往往是「想调工具调不了」)
  return true;
}

/**
 * 端点跑 agent loop 时该用哪个 session id。
 *
 * ── 为什么不能让它落到 `'default'` (2026-10-26 第 106 批补, 交叉审抓到的 P1) ──
 *   agent loop 的 sessionId 兜底是 `'default'` (j2_agent_loop.js:818), 而:
 *   ① **同 session 来新请求会把上一个正在跑的 loop 当场 abort**
 *      (j2_agent_loop.js:1047 `activeAbort.abort('user_switched')`);
 *   ② session state 是**模块级 Map** ⇒ 匿名请求之间 planState / fountainRepeat /
 *      lastRoundText 互相串味 (复读守卫会误伤不相干的那一条)。
 *   ⇒ 两个匿名客户端并发打这个端点, 后一个会把前一个的升级轮掐掉。
 *
 *   规矩: **客户端显式给了 session_id 就尊重它**(连续性照旧);
 *   **没给就走一次性 id**(每个请求一个) ⇒ 匿名请求互不干扰。
 *
 * @param {object} p
 * @param {string} [p.explicitSessionId] 客户端给的 session_id
 * @param {function} [p.makeUnique] 一次性 id 的生成器 (测试可注入, 保持确定性)
 * @returns {string}
 */
function resolveChatSessionId(p) {
  const o = p || {};
  const explicit = String(o.explicitSessionId || '').trim();
  if (explicit) return explicit;
  const uniq = typeof o.makeUnique === 'function'
    ? String(o.makeUnique())
    : (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
  return 'http-' + uniq;
}

/**
 * 最终答复 (含「永不为空」这条不变量)。
 *
 * @param {object} p
 * @param {string}  p.guardedText
 * @param {boolean} p.guardedBlocked
 * @param {string}  p.escalatedText 升级后拿到的正文 (没升级就传空)
 * @param {string}  [p.noAnswerText]
 * @returns {{content: string, reason: string}}
 */
function decideChatAnswer(p) {
  const o = p || {};
  const fallback = typeof o.noAnswerText === 'string' && o.noAnswerText
    ? o.noAnswerText
    : NO_ANSWER_TEXT;
  const guardedText = String(o.guardedText || '').trim();
  const escalatedText = String(o.escalatedText || '').trim();

  if (o.guardedBlocked) return { content: fallback, reason: 'blocked' };
  if (guardedText) return { content: guardedText, reason: 'direct' };
  if (escalatedText) return { content: escalatedText, reason: 'escalated' };
  // ⚠ 不变量: 走到这里 content 绝不能是空串
  return { content: fallback, reason: 'empty' };
}

module.exports = {
  NO_ANSWER_TEXT,
  REASONING_OUTPUT_FLOOR,
  resolveOutputBudget,
  needsEscalation,
  decideChatAnswer,
  resolveChatSessionId,
};

