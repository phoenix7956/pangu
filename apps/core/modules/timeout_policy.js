'use strict';

// 「超时」这一族错误的唯一真源 + 抢救策略 (2026-10-23, 第 64 批)
//
// ── 起因 (现场 session b63-guagate3, 2026-10-23 12:23:48 起) ─────────────
//   native 路径问「1990-03-15 生男, 今天适不适合把手上项目第一步做掉」。
//   第一轮 LLM 调用把 reasoning 推了 2980 字 (12:23:48 → 12:30:08, 字符稳定增长,
//   **一个工具都没调**), 390s 总预算到了 → STREAM_TOTAL_TIMEOUT_390s。
//
//   **这不是上游挂死**: 同一个流还在稳定出字, 是盘古自己的墙把它掐了。
//   (先前一轮排查把它记成「上游挂死」, 是被错误名带偏的 —— 判据是字符曲线, 不是报错名。)
//
// ── 而这一族错误在项目里有两份同义分类, 互不相同 ───────────────────────
//   · modules/slice_death.js     SLICE_DEAD_RE  认 3 种 (缺 STREAM_TOTAL_TIMEOUT)
//   · modules/j2_loop_shared.js  _isInfraError  认 **0 种**
//
//   于是超时在 native 路径上**不是「基础设施错误」**:
//   不原地重试、不切模型、不快速失败, 而是掉进 catch 末尾那句
//   「fallback to legacy J2 XML path」——
//   **而那条路根本不存在**: useNative 是 const (j2_agent_loop.js:1335),
//   catch 里改的 nativeToolCallSupported 没人读, legacy 循环的守卫 !useNative 恒假。
//   ⇒ 烧掉 390s 什么都不交; 外层续跑再原样烧一轮 (实测重试的 prompt 逐字节同大小:
//     msgs 12 / inputTokens 16186), 用户只看到转圈。
//
//   2026-10-13 修过一次同型的 (上游 5xx 落不进分类 → 静默降级 legacy),
//   **超时这一半没修**。同一个坑的两半, 现在一次补齐。
//
// ── 这个模块收三件事 ──────────────────────────────────────────────────
//   1. 分类: 6 种预算类超时, 跟连接类瞬断**分开**判
//   2. 抢救: 超时时把已经流出来的内容/工具调用捞回来 (别让 2980 字思考白想)
//   3. 措辞: 给用户看的「超时收口」文案 (正面式标签, 不装成失败)
//
// 为什么单独一个文件: slice_death.js 已经是叶子 (为避开 j2_dispatcher → subagent_runner
// 的循环依赖), j2_loop_shared.js 也要引它 —— 同一份表必须放在谁都能引的地方。

// 预算类超时的 6 个名字。**不许在别处增删**: 要增删只改这里一处。
const TIMEOUT_KINDS = Object.freeze([
  'STREAM_TOTAL_TIMEOUT',    // llm_caller: 总时长熔断 (本地默认 390s)
  'STREAM_IDLE_TIMEOUT',     // llm_caller: 吐过字之后静默
  'STREAM_PREFILL_TIMEOUT',  // llm_caller: 首字节前静默
  'LLM_SOCKET_TIMEOUT',      // llm_caller: socket 熔断
  'LLM_FETCH_TIMEOUT',       // llm_caller: fetch 超时
  'LLM_ROUND_TIMEOUT',       // j2_agent_loop: 整轮熔断
]);

// 超时 ≠ 瞬断。
//   超时 = 「这一轮算不完」—— 端点是通的, 预算不够 (STREAM_TOTAL_TIMEOUT 就是)。
//   瞬断 = 「连接断了」—— 换一次可能就好 (ECONNRESET / socket hang up)。
// 把两者混在一起, 后果是: 超时会去走「原地重试」—— 而同一个 prompt 再来一次
// **必然再撞同一堵墙** (现场: msgs 12 / inputTokens 16186, 两次逐字节同大小)。
// ETIMEDOUT 属于瞬断, **不算**超时。
const CONNECTION_ERROR_PATTERN = 'ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up';

function isTimeoutError(msg) {
  const s = String(msg == null ? '' : msg);
  for (let i = 0; i < TIMEOUT_KINDS.length; i++) {
    if (s.indexOf(TIMEOUT_KINDS[i]) >= 0) return true;
  }
  return false;
}

function isConnectionError(msg) {
  return new RegExp(CONNECTION_ERROR_PATTERN, 'i').test(String(msg || ''));
}

// 「这刀死了」判定要用的正则: 超时那 6 种 + 调用方自己那份 (配额/瞬断/… )。
// slice_death.js 从这里取, 免得它自己抄一份只认 3 种。
function buildTimeoutDeadRe(extraPattern) {
  const base = TIMEOUT_KINDS.join('|');
  const extra = extraPattern ? ('|' + extraPattern) : '';
  return new RegExp(base + extra);
}

// 从错误名里抠出秒数: 'STREAM_TOTAL_TIMEOUT_390s' → 390。
// 抠不出来就返回 null (别猜, 也别拿 0 冒充)。
function timeoutSeconds(msg) {
  const m = String(msg || '').match(/(\d+)\s*s(?:\b|$)/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// 本轮流式总预算的缩放。
//   为什么是「缩放」而不是「另设一个值」: 运维可以用 PANGU_STREAM_TOTAL_MS 定基线,
//   调用方只想「这一轮收紧一点」(超时续想时用)。两者相乘 ⇒ 谁都不吃掉谁。
//
//   下限 120s —— 这个数不是随手定的:
//   本地 27B 的大 prompt **首字节就要 45~90s** (llm_caller._prefillMs 的注释里写着),
//   而 prefill 预算配的是 300s (最坏情况的预留, 不是实际耗时)。
//   预算缩到 prefill 之下 ⇒ 续想那轮连首字节都等不到, 必然又是一次超时 —— 刹车踩成了自杀。
//   120s = 给 prefill (≤90s) 留出余量 + 一点思考/正文时间。
const MIN_SCALED_STREAM_TOTAL_MS = 120000;

function scaledStreamTotal(base, scale, floorMs) {
  const b = Number(base);
  if (!Number.isFinite(b) || b <= 0) return b;
  const s = Number(scale);
  if (!Number.isFinite(s) || s <= 0 || s === 1) return b;
  const floor = Number.isFinite(floorMs) ? floorMs : MIN_SCALED_STREAM_TOTAL_MS;
  return Math.max(Math.round(b * s), floor);
}

// ── 抢救 ──────────────────────────────────────────────────────────────
// 流式推送时盘古把 <think> … </think> 标记和正文一起塞进 streamedText
// (思考不进气泡是**呈现层**的事, 缓冲区里两样都在)。超时的时候要把它们分开:
//   reasoning → 留给下一轮续想 (模型已经想过的, 别让它从头再来)
//   content   → 已经是正文了, 就能当答复交出去
function splitThinkText(text) {
  const s = String(text || '');
  let reasoning = '';
  let content = '';
  let last = 0;
  const re = /<think>([\s\S]*?)(?:<\/think>|$)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    content += s.slice(last, m.index);
    reasoning += m[1];
    last = m.index + m[0].length;
  }
  content += s.slice(last);
  return { reasoning: reasoning.trim(), content: content.trim() };
}

// 把 llm_caller 挂在 error 上的 partial 跟 streamedText 合起来。
// 两边各有对方没有的东西:
//   err.partial  有**已拼好的 tool_calls** (只有 llm_caller 拼得到)
//   streamedText 有**逐 token 的正文与思考** (调用方才有)
function collectPartial(err, streamedText) {
  const e = (err && err.partial) ? err.partial : null;
  const split = splitThinkText(streamedText);
  const toolCalls = (e && Array.isArray(e.toolCalls)) ? e.toolCalls : [];
  const content = String(split.content || (e && e.content) || '').trim();
  const reasoning = String(split.reasoning || (e && e.reasoning) || '').trim();
  return {
    content,
    reasoning,
    toolCalls,
    reasonChars: (e && Number.isFinite(e.reasonChars) ? e.reasonChars : reasoning.length),
    hasAnything: !!(content || reasoning || toolCalls.length),
  };
}

// ── 措辞 (正面式标签; 不装成「失败」, 也不把没算完的说成算完了) ────────
function timeoutNoticeText(opts) {
  const o = opts || {};
  const kind = String(o.kind || '这一轮').trim();
  const secs = Number.isFinite(o.seconds) ? o.seconds : null;
  const budget = secs ? ('预算 ' + secs + 's 内') : '预算内';
  const head = '【超时收口】' + kind + '在' + budget + '没算完。';
  const tail = o.partialText
    ? ('\n\n已经算出来的部分原样交给你 —— 没算完的那部分, 盘古不替它编:\n\n' + o.partialText)
    : '\n\n这一轮没有产出正文, 盘古不拿半成品充数。想让它接着走, 说「继续」就行。';
  const hint = o.hint ? ('\n\n' + o.hint) : '';
  return head + tail + hint;
}

// 续想时给模型的指令: **逼它动一步**, 而不是让它接着空想。
// (老板: 「加强了停顿, 走一步判断一步」—— 这一条就是「走一步」的机械实现。)
function continueNudgeText(opts) {
  const o = opts || {};
  const attempt = Number.isFinite(o.attempt) ? o.attempt : 1;
  const chars = Number.isFinite(o.reasonChars) ? o.reasonChars : 0;
  return [
    '[超时收口 · 第 ' + attempt + ' 次续想]',
    '上一轮你想了 ' + (chars > 0 ? (chars + ' 字') : '很久') + '还没交出结论 —— 已经想过的部分我留在上面了, 不用从头再来。',
    '现在二选一, 别再空想:',
    '1) 直接调一个工具把事实拿出来 (bazi_calc / hexagram_lookup / risk_assessment / task_done …);',
    '2) 用一两句话给结论, 依据只引用你上面已经算出来的东西。',
  ].join('\n');
}

module.exports = {
  TIMEOUT_KINDS,
  CONNECTION_ERROR_PATTERN,
  isTimeoutError,
  isConnectionError,
  buildTimeoutDeadRe,
  timeoutSeconds,
  scaledStreamTotal,
  MIN_SCALED_STREAM_TOTAL_MS,
  splitThinkText,
  collectPartial,
  timeoutNoticeText,
  continueNudgeText,
};
