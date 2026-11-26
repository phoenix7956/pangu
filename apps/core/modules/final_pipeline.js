'use strict';
/**
 * 定稿流水线 —— **唯一实现**(2026-10-23 第 61 批)。
 *
 * ## 起因
 *
 * 这一句在 `j2_dispatcher.js` 里**5 处各写一遍**:
 *
 *   await _factGate(
 *     _stripHistoryLeak(
 *       _guardWithSubFallback(userInput,
 *         _stripThink(finalText))),
 *     model, _chartEvidenceFrom(results));
 *
 * 五处一模一样, 但**顺序是隐式的** —— 「先剥上文泄漏再过核验门」这件事,
 * 只存在于写这行的人脑子里。第 60 批刚把门收成唯一实现, 顺手量到这一层还有 5 份。
 *
 * 两个老测试(`synthesis-leak` / `context-continuity`)都在数这个字面量出现几次(5 处),
 * 说明**顺序本身是有价值的契约** —— 但契约应该是「一个函数的行为」,
 * 不是「五处字符串长得一样」。加一层包装或调一下顺序, 只改一处的话没人会发现。
 *
 * ## 顺序(每一步为什么在这个位置 —— 顺序本身是有讲究的)
 *
 *   1. _stripThink      剥 `<think>…</think>` 与特殊 token
 *                        —— 必须在 guard 之前: 对齐门是拿问题跟答案比,
 *                          答案里混着思维链就永远对不齐。
 *   2. guardWithSubFallback  对齐门 + 全拦时回落子 agent 真结论
 *                        —— 在剥泄漏之前: 它比的是**语义**, 泄漏块不影响语义;
 *                          放后面会让剥剩的半句话被当成未对齐而误拦。
 *   3. stripHistoryLeak 剥内部【上文】块
 *                        —— 必须在门之前: 门是拿文本里的卦名/四柱去查表的,
 *                          泄漏块里混着我们自己注入的旧卦象, 会让核验基准串味。
 *   4. runAnswerGates   卦象门 → 命盘门
 *                        —— 最后一道, 门看到的是即将上屏的最终文本。
 */

const _HISTORY_LEAK_RE = /(?:^|\n)\s*(?:#{1,6}\s*)?[【\[（(]?\s*上文\s*[-—–:：]?[^\n]{0,200}?(?:指这里|这类字样)[^\n]{0,80}\n?/g;

// 只剩标题没有说明文字的那种【上文】块也要剥。
// 窄匹配: 必须同时有【方括号 + 破折号 + "本会话此前的对话"三个特征,
// 所以 '上文这个卦怎么解？' 这类主人原话不受影响 (context-continuity ④c 守着呢)。
const _HISTORY_HEADING_RE = /(?:^|\n)\s*(?:#{1,6}\s*)?[【\[（(]\s*上文\s*[-—–]\s*本会话此前的对话[^\n]{0,120}\n?/g;

/**
 * 剥内部【上文】块 —— 主人原话里的「上文」二字不受影响。
 *
 * 2026-10-23 第 61 批从 j2_dispatcher 搬来(j2_dispatcher 仍 re-export,
 * 老 require 路径不断)。
 */
function stripHistoryLeak(text) {
  let out = String(text == null ? '' : text);
  for (let i = 0; i < 3 && _HISTORY_LEAK_RE.test(out); i++) {
    _HISTORY_LEAK_RE.lastIndex = 0;
    out = out.replace(_HISTORY_LEAK_RE, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '');
  }
  _HISTORY_LEAK_RE.lastIndex = 0;
  for (let i = 0; i < 3 && _HISTORY_HEADING_RE.test(out); i++) {
    _HISTORY_HEADING_RE.lastIndex = 0;
    out = out.replace(_HISTORY_HEADING_RE, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '');
  }
  _HISTORY_HEADING_RE.lastIndex = 0;
  return out;
}

/**
 * 剥 `<think>…</think>` 与特殊 token。
 *
 * 必须排在最前 —— 对齐门是拿问题跟答案比, 答案里混着思维链就永远对不齐。
 */
function stripThink(text) {
  const helpers = require('./j2_helpers');
  return helpers._stripSpecialTokens(
    String(text || '')
      .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
      .replace(/<think>[\s\S]*$/g, '')
  ).trim();
}

/**
 * 定稿 —— 四步流水线, 顺序写死在这里。
 *
 * @param {object} o
 * @param {string} o.finalText        模型这轮的正文
 * @param {string} o.userInput        主人这一轮的原话(对齐门要比)
 * @param {function} o.guardWithSubFallback  (userInput, strippedText) => string
 * @param {string} o.model
 * @param {function} o.ask            `answer_gates.buildAskFn` 造的回调
 * @param {Array}  [o.chartEvidence]  权威四柱证据
 * @param {string} [o.logPrefix]      日志前缀; 不给就不打日志
 * @returns {Promise<string>} 可以上屏的最终文本
 */
async function finalizeAnswer(o) {
  const src = String(o.finalText || '');
  let text = stripThink(src);
  if (typeof o.guardWithSubFallback === 'function') {
    text = o.guardWithSubFallback(o.userInput, text);
  }
  text = stripHistoryLeak(text);
  try {
    const gates = require('./answer_gates');
    const out = await gates.runAnswerGates(text, o.ask, {
      chartEvidence: o.chartEvidence,
      logPrefix: o.logPrefix,
    });
    return out.text;
  } catch (_) {
    // 门异常不阻断交付 —— 门是加法不是减法。返回已经剥干净的文本。
    return text;
  }
}

module.exports = {
  finalizeAnswer,
  stripHistoryLeak,
  stripThink,
};
