'use strict';
/**
 * modules/dispatcher_closeout.js —— dispatcher 的「唯一出口」契约
 *
 * ## 是什么
 *   一个工厂: 传进 `resDone` / `persistParent`, 拿回一个 `closeOut` 函数。
 *   dispatcher 的**每一个**出口都必须走它 —— 落盘跟它绑死, 不靠各处记得。
 *
 * ## 为什么要有 (2026-10-23 第 65 批)
 *   dispatcher 有 8 个出口, 而「这一轮要落盘」是每处**各自记住**的:
 *
 *   · 2026-10-12 P1 修过一次「会话跑完刷新就没了」(会话 61554610)——
 *     根因是桌面聊天的父会话在磁盘上不存在, 当时只修了 fixed_flow 那条路;
 *   · 2026-10-16 现场「Planner failed: LLM timeout 300s」→ 走关键词兜底,
 *     那条路**答完了、也上屏了**, 父会话却没落盘 ⇒ 刷新/重启整轮消失;
 *   · 而 `_persistParent` 的注释还写着「6 处调用覆盖 … 关键词兜底 … 全部路径」——
 *     **那是假的**, 实际只有 5 处, 关键词兜底一处都没有。
 *     注释写着覆盖、代码没覆盖 ⇒ 没人去查, 于是同一族的事故修了 3 次还在长新的。
 *
 *   靠记性守不住的, 就得靠结构: 出口只有一处, 落盘只有一处。
 *
 * ## 契约
 *   ① 每个出口必须显式给「落盘规格」:
 *        persistState: 'completed' | 'partial' | 'failed' | 'active'
 *        或 persist:false + **理由**(不给理由就当没给)
 *   ② 不落盘必须写清为什么 —— 没写就 warn, 让它响, 不许默默跳过
 *   ③ 落盘的内容 = 出口的 `result` 原文(不另造一份, 免得两处不一样)
 *
 * ## 为什么单独一个文件
 *   落盘规格的判定(什么时候算完成/部分/失败, 什么时候**不许**落盘)是整条链上
 *   最容易出错、也最该有单测的一环, 而它原先藏在 2295 行的 dispatcher 里,
 *   一次都没被单独验过 —— 出事只能靠整链实跑才发现。
 *   同款做法: 第 60 批 gates / 第 61 批 final_pipeline / 第 63 批 synth_prompt。
 */

/**
 * @param {object} deps
 * @param {Function} deps.resDone        收口上报(状态事件 + 账本 + 断流)
 * @param {Function} deps.persistParent  父会话落盘
 * @param {object} [deps.log]            日志口(默认 console)
 * @returns {Function} closeOut(done, spec)
 */
function makeCloseOut(deps) {
  const d = deps || {};
  const resDone = d.resDone;
  const persistParent = d.persistParent;
  const log = d.log || console;

  return function closeOut(done, spec) {
    const o = done || {};
    const sp = spec || {};
    // 落盘内容 = 出口的 result 原文。**不另造一份** —— 另造就会出现
    // 「上屏的是 A、落盘的是 B」, 而下一轮读的是落盘那份。
    const answer = String(o.result || '');

    if (typeof resDone === 'function') {
      resDone(o);
    } else {
      log.warn('[dispatcher-closeout] 缺 resDone —— 收口状态没上报');
    }

    if (sp.persist === false) {
      const why = String(sp.persistWhy || '').trim();
      if (!why) {
        log.warn('[dispatcher-closeout] 这个出口不落盘但没写理由 —— 父会话会丢这一轮');
      } else {
        log.log('[dispatcher-closeout] 本出口不落盘:', why);
      }
      return;
    }

    if (typeof persistParent !== 'function') {
      log.warn('[dispatcher-closeout] 缺 persistParent —— 这一轮不会落盘');
      return;
    }
    persistParent(answer, sp.persistState || 'completed');
  };
}

module.exports = { makeCloseOut };
