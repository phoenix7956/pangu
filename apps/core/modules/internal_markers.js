/**
 * apps/core/modules/internal_markers.js
 *
 * 立库: 第 75 批 b —— 盘古自己往上下文里塞过的**内部标记**, 一个字都不许出门。
 *
 * ## 现场 (2026-10-24, 会话 desktop-verify75-1792780764, 实跑 SSE 逐帧抓到)
 *   模型把注入上下文的 [CONTINUITY] 标记**原样抄进了答复** (142 字, 一字不差),
 *   用户气泡尾巴上挂着一段「[CONTINUITY] 上一条 assistant 消息是…」。
 *   更糟: 那段文字被落盘进 session 文件 + AgentDB ⇒ 被 recall 回上下文
 *   ⇒ 模型再抄一遍 ⇒ **自循环**。所以这不是「文案不好看」, 是**内部协议泄漏到用户面**。
 *
 * ## 判据为什么是「行首 + 完整 token」, 两个都省不掉
 *   ① **行首**: 实测扫遍 1161 个答复块 —— 真泄漏 1 处 (行首 [CONTINUITY]),
 *      而模型**讲解盘古源码**时会在行中引用标记名 (8 处: [REVERIFY_FIRST] ×5 /
 *      [会话续跑] ×3)。那 8 处是合法正文, 剥了就毁答案。
 *      ⇒ 判据 = 「**行首** marker → 删到行尾」, 不是「看到 [..] 就删」。
 *   ② **完整 token, 不前缀匹配**: [SYSTEM] 是 [SYSTEM_GUARD] 的**前缀**,
 *      而 [SYSTEM_GUARD] 是**用户可见**的守卫生成文案 (熔断/内容喷泉收口),
 *      剥掉它 = 把真话灭口 (2026-09-13 老板现场: 「这就是你说的好了」)。
 *      ⇒ 按完整方括号 token 精确匹配。([SYSTEM WARNING] 是另一条, 与 [SYSTEM] 互不为前缀。)
 *
 * ## 白名单 (绝不许剥, 有的是用户可见文案)
 *   [SYSTEM_GUARD]  —— 用户可见的守卫生成文案
 *   ⚠️ [盘古 ...]    —— 同上, 系统自产死因文案 (行首不是 "[" ⇒ 天然不命中)
 *   [DONE] / [CHART_GATE] / [GUA_GATE] —— SSE 协议 / 只出现在日志里
 *
 * ## 为什么「删到行尾」而不是「只删标记本身」
 *   标记的正文是**一句完整的话** (例: 「上一条 assistant 消息是…后面被截掉了」),
 *   删掉方括号那几个字, 剩下一句没头没尾的废话挂在用户面前 —— 更糟。
 *   整行删掉, 边界干净。
 */
'use strict';

/**
 * 内部标记清单 —— **行首出现就删到行尾**。
 *
 * 两条匹配规则, 缺一不可:
 *   · 列表项是**字面前缀** (startsWith), 不是正则 ⇒ `[SYSTEM]` 不会误伤
 *     `[SYSTEM_GUARD]` (第 7 个字符是 "_" 不是 "]")。
 *   · `[SYSTEM WARNING` 带一段尾巴, 因为现场有两个变体:
 *     `[SYSTEM WARNING] ...` 和 `[SYSTEM WARNING: 工具空转] ...`。
 */
const INTERNAL_MARKER_TAGS = [
  '[CONTINUITY]',
  '[SYSTEM WARNING',
  '[SYSTEM]',
  '[UNVERIFIED 熔断]',
  '[LEDGER_REJECT]',
  '[LIP_SERVICE_BLOCKED]',
  '[LIP_SERVICE_AFTER_TOOLS]',
  '[LIP_SERVICE_SUMMARY]',
  '[OVERCLAIM_BLOCKED]',
  '[TASK_DONE_BLOCKED]',
  '[WAIT_INSTRUCTION_BLOCKED]',
  '[FINAL_REWRITE_REQUIRED]',
  '[GATE_AUTO_APPROVE]',
  '[SELF_CORRECT_FAIL]',
  '[PERMISSION_VERIFIED]',
  '[REVERIFY_FIRST]',
  '[DUPLICATE-CALL-BLOCKED]',
  '[ALIGNMENT_RETRY]',
  '[HARD]',
  '[HARD-LOOP]',
  '[READONLY-LOOP]',
  '[自动续跑]',
  '[六格判局 · 换向]',
  '[会话续跑]',
];

// 行首空白 (含全角空格) —— 缩进一格的标记行照样是真标记
const _LEADING_BLANK = /^[ \t　]+/;

function _lineHead(line) {
  return String(line == null ? '' : line).replace(_LEADING_BLANK, '');
}

/**
 * 这一行是内部标记吗? (行首精确 token 匹配)
 *   「行首」= 允许行首空白; 「精确」= 完整方括号 token, 不做前缀匹配。
 */
function isInternalMarkerLine(line) {
  const t = _lineHead(line);
  if (!t) return false;
  for (const tag of INTERNAL_MARKER_TAGS) {
    if (t.startsWith(tag)) return true;
  }
  return false;
}

/**
 * 这一行**还没写完**、但已经可能是内部标记吗?
 *   流式层用: 标记是逐字吐出来的 ('CONT' → 'INU' → 'ITY' → ']'),
 *   看到 'CONT' 四个字时根本认不出它是不是标记 ⇒ 这一行必须**扣住不发**,
 *   等它写完再判。判完不是标记, 再补发 (不丢字)。
 */
function isPendingMarkerLine(line) {
  const t = _lineHead(line);
  if (!t) return false;
  if (isInternalMarkerLine(line)) return false;
  for (const tag of INTERNAL_MARKER_TAGS) {
    if (tag.startsWith(t)) return true;
  }
  return false;
}

/**
 * 剥掉内部标记行 —— 返回剥干净的文本。
 *
 * 做法: 按行切开, 标记行整行变空 (换行结构**保留** ⇒ 剥完的文本仍是原文的前缀,
 * 流式游标 `__panguVisibleLen` 的语义才成立)。
 *   · 「删到行尾」= 标记行整行去掉, 连同行尾那句没头没尾的话。
 *   · 最后一行若是「还没写完的标记」⇒ 扣住 (映射成空), 等写完再判。
 *
 * @param {string} text
 * @returns {{text:string, stripped:boolean, held:boolean}}
 *   text     : 剥干净的文本
 *   stripped : 有没有真的剥掉过东西 (用来决定 final 要不要带 replace 位)
 *   held     : 末尾有没有「还在写、暂时认不出来」的那一行 (流式层据此扣住增量)
 */
function stripInternalMarkerLines(text) {
  const s = String(text == null ? '' : text);
  if (!s) return { text: '', stripped: false, held: false };
  const lines = s.split('\n');
  const lastIdx = lines.length - 1;
  let stripped = false;
  let held = false;
  const out = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (isInternalMarkerLine(ln)) {
      out[i] = '';
      stripped = true;
      continue;
    }
    if (i === lastIdx && isPendingMarkerLine(ln)) {
      out[i] = '';
      held = true;
      continue;
    }
    out[i] = ln;
  }
  return { text: out.join('\n'), stripped, held };
}

/**
 * 剥掉内部标记 —— 只要干净文本。
 *   幂等: 剥过一次再剥, 结果不变 (流式层与 final 层可以对同一段文本各剥一次)。
 */
function stripInternalMarkers(text) {
  return stripInternalMarkerLines(text).text;
}

module.exports = {
  INTERNAL_MARKER_TAGS,
  isInternalMarkerLine,
  isPendingMarkerLine,
  stripInternalMarkerLines,
  stripInternalMarkers,
};
