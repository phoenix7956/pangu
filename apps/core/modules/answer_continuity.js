/**
 * apps/core/modules/answer_continuity.js
 *
 * 立库: 第 75 批 —— 回灌腰斩导致「答复开头丢失 / 正文重复」
 *
 * ## 现场 (2026-10-24, 会话 desktop-verify74-1792774960, 主角色, 真实用户轮)
 *   主人问「全面介绍一下你自己」。
 *   r1 (2062 字): 模型交了一份**完整**答复, 但里面有一句「沙箱预算钩子正常」
 *       → 命中 UNVERIFIED_CLAIM 守卫 (0 工具 + 系统状态断言) → nudge 逼举证。
 *   回灌那一行的动作是 `content: textContent.slice(0, 300)` ——
 *       模型只拿到自己那 300 字, 看不到自己后面写的 1762 字。
 *   r2 (1225 字): 模型**从断点接着写**(r2 首字接 r1 第 300 码位, 重叠 18 字),
 *       交出的是一份**从半句开始**的正文。
 *   final: 只发 r2 ⇒ **答复的开头 300 字永久消失**(盘古把一段完整的话讲成了半句)。
 *   桌面气泡: 流式 = r1(2062) + r2(1224) ⇒ 用户看到「完整答复 + 重写一遍的尾巴」。
 *
 * ## 为什么只留"确定性还原", 不留提示词那一层
 *   原来的设计是两层: ① 回灌片段**带明确标记** (概率层: 让模型知道那是上一轮原话的开头,
 *   别从那里续写) + ② 终稿出口**确定性还原** (保证层: 续写就把被砍掉的头接回去)。
 *   **实跑把 ① 否掉了** (现场 verify75c-1792780764, 2026-10-24):
 *     · 模型**照样从断点续写** —— 标记压根没起作用;
 *     · 模型把标记**原样抄进了答复** (142 字, 一字不差) —— 用户气泡尾巴上挂着一段
 *       「[CONTINUITY] 上一条 assistant 消息是…」(真数据见 tests/fixtures/)。
 *   一条既没生效、又漏给用户看的机制不能上生产 ⇒ **概率层撤掉**, 只留保证层。
 *   (想再加概率层的话: 必须① 不许紧挨 assistant 片段 ② 出门前必须剥 —— 这两条一起上。)
 *   提示词能压低概率, 不能保证; 这条链要的是保证。
 *
 * ## 判定为什么用"对齐"而不是"前缀相等"
 *   现场 r2 与 r1[300:] 只有 18 字重叠 (模型换了自己的措辞, 不是照抄),
 *   逐字相等判不出来 —— 那种判据在现场是**空枪**。
 *   但"新答复的开头"确实落在"被砍掉那段的紧后面" ⇒ 判据取
 *   **新答复 vs 被砍尾段的公共前缀长度**, ≥ 16 字即认定为续写。
 */
'use strict';

// 续写认定: 新答复与「被砍掉那段的紧后面」的公共前缀至少这么长
const OVERLAP_MIN = 16;
// 在被砍尾巴里往后找对齐点, 最多往后看多少字
const SCAN_TAIL = 200;
// 新答复开头允许有几字错位 (模型可能先写一句引子再续上)
const SCAN_HEAD = 8;
// 已经写得很长的答复, 公共前缀到这么多就够判, 不必再扫
const SCAN_ENOUGH = 64;

// 我们自己往上下文里塞过的内部标记 —— 出门前必须剥掉。
// 2026-10-24 (第 75 批 b): 判据与白名单的**单一真源**挪到 modules/internal_markers.js
//   (流式层 / final 层 / 回忆层 / checkpoint 层四处共用同一份清单)。
//   这里只做转手 —— 两处各留一份清单, 早晚有一份漏更新, 漏的那份就是漏给用户看的那些。
const { INTERNAL_MARKER_TAGS, stripInternalMarkers } = require('./internal_markers');

function _stripThink(s) {
  return String(s == null ? '' : s)
    .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
    .replace(/<think>[\s\S]*$/g, '');
}

// 两个字符串的公共前缀长度 (最多 max)
function _cpLen(a, b, max) {
  const n = Math.min(a.length, b.length, max == null ? Infinity : max);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * 终稿还原: 新答复是不是从断点续写出来的?
 *
 * @param {string} text      本轮要出门的答复 (原文)
 * @param {object|null} record  { full, cut } —— 上一轮被腰斩时的完整正文与腰斩位置
 * @returns {{text:string, merged:boolean, reason:string, overlap?:number, at?:number}}
 *
 * 判定: 新答复的开头, 与「被砍掉那段的紧后面」(full.slice(cut)) 的公共前缀 ≥ 16 字
 *       ⇒ 模型确实是从断点续写的 ⇒ 把 full.slice(0, cut+at) 接回去。
 * 合并结果 = full.slice(0, cut+at) + 新答复 —— 接缝处两段内容**不重叠**
 *       (head 结束于 tail[at] 之前, 重叠区由新答复提供一次)。
 */
function reconstruct(text, record) {
  const t = _stripThink(text);
  if (!record || !record.full) return { text: t, merged: false, reason: 'no-record' };
  const full = _stripThink(record.full);
  const cut = Math.max(0, Math.min(Number(record.cut) || 0, full.length));
  if (cut <= 0) return { text: t, merged: false, reason: 'not-truncated' };
  if (cut >= full.length) return { text: t, merged: false, reason: 'not-truncated' };
  const head = full.slice(0, cut);
  // 已经带着开头 (还原过了, 或模型自己从头重写了) → 不用再动
  if (head && t.startsWith(head)) return { text: t, merged: false, reason: 'already-has-head' };
  const probe = Math.min(40, cut);
  if (probe >= 8 && t.indexOf(full.slice(0, probe)) >= 0) {
    return { text: t, merged: false, reason: 'rewrote-with-head' };
  }
  const tail = full.slice(cut);
  if (!tail.length || !t.length) return { text: t, merged: false, reason: 'empty-side' };
  let best = { at: 0, len: 0, headOff: 0 };
  const maxTail = Math.min(tail.length, SCAN_TAIL);
  for (let hs = 0; hs < SCAN_HEAD; hs++) {
    if (hs >= t.length) break;
    for (let off = 0; off < maxTail; off++) {
      const len = _cpLen(t.slice(hs), tail.slice(off));
      if (len > best.len) best = { at: off, len, headOff: hs };
      if (best.len >= SCAN_ENOUGH) break;
    }
    if (best.len >= SCAN_ENOUGH) break;
  }
  if (best.len < OVERLAP_MIN) return { text: t, merged: false, reason: 'no-overlap' };
  const merged = full.slice(0, cut + best.at) + t.slice(best.headOff);
  return { text: merged, merged: true, reason: 'resumed', overlap: best.len, at: best.at };
}

module.exports = {
  OVERLAP_MIN,
  INTERNAL_MARKER_TAGS,
  stripInternalMarkers,
  reconstruct,
  _stripThink,
  _cpLen,
};
