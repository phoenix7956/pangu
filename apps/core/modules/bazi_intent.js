/**
 * modules/bazi_intent.js — 生辰意图识别
 *
 * 2026-10-21 立。用途: 决定一条输入该不该起卦。
 *
 * 背景 (为什么需要它):
 *   `pangu_agent_stream.js` 对每条非闲聊输入都先过 gua_engine 起一卦, 把
 *   【盘古起卦】块注入 LLM 上下文前面。问题: 用户给的是**生辰八字**时,
 *   八字本身就是盘, 再叠一个梅花卦 = 两套盘打架; 更实际的后果是卦象块占住了
 *   推理入口, 模型顺着卦象走, 不去调 bazi_calc —— 而 bazi_calc 明明在
 *   `tools_schema.js:98` 的 MAIN_GENERAL_TOOLS_FOR_LLM 里, 主对话够得着。
 *
 * 识别不出来时返回 matched=false, 保持原有"照常起卦"的行为 ——
 *   本模块只做**减法** (该不起的不起), 不做加法。
 *
 * 判据为什么这样定:
 *   单看日期会误伤 (「看下 2015年3月15日 的会议记录」), 单看关键词会漏
 *   (「1990年3月15日, 男」没有任何八字关键词, 但显然是生辰)。
 *   所以要求 日期 ∧ 语境信号 才判命中。
 */

'use strict';

// 2026-10-23 第 58 批: 「主人明说要卦」的那一档判据住在 modules/gua_gate_kws.js
//   (起卦门词表的唯一真源)。这里引用它, 不另抄一份 ——
//   盘古 2026-10-21 踩过: 「两份同义文本各改各的, 改一次就漂一次」。
const { isGuaCastRequest } = require('./gua_gate_kws.js');

// ============================================================
// 片段
// ============================================================

// 完整年月日: 1990年3月15日 / 1990-03-15 / 1990/3/15 / 1990.3.15
// 必须 年月日 三者齐全 —— 只出现年份或年月不算 (「2015年的数据」不是生辰)
const _FULL_DATE = /\d{4}\s*[年\-/.]\s*\d{1,2}\s*[月\-/.]\s*\d{1,2}\s*日?/;

// 中文数字年月日: 一九八四年三月十五日 / 一九八四年生
// 年份允许 「一九八四」四字连写, 或「一九八四年」
const _CN_FULL_DATE = /[一二三四五六七八九零〇]{4}\s*[年]/;
const _CN_MONTH_DAY = /[一二三四五六七八九十]+\s*月\s*[一二三四五六七八九十]+\s*[日号]/;

// 时辰: 15时30分 / 15:30 / 下午三点 / 卯时
const _CLOCK = /(\d{1,2}\s*[:时点]\s*\d{0,2}\s*分?)|([子丑寅卯辰巳午未申酉戌亥]\s*时)/;

// 生辰语境关键词 —— 出现任一个即认为「这是在谈一个人的命」
const _BIZI_KEYWORD =
  /出生|生日|生辰|八字|命盘|排盘|四柱|农历|阴历|时辰|命理|算命|看命|合婚|批命/;

// 命理语境 (没有「八字」二字, 但明显在问命)
const _FATE_CONTEXT = /流年|大运|太岁|用神|喜用|日主|日元|十神|神煞|三合|六合|六冲/;

// 性别: 与日期同时出现时是强生辰信号
const _GENDER = /(^|[^\w])[男女]([^\w]|$)/;

// 明确要排八字 (即使没给数据 —— 此时正确动作是**问生辰**, 不是起卦)
const _BIZI_REQUEST = /排\s*(一下)?\s*八字|算\s*(一下)?\s*八字|看\s*(一下)?\s*八字|八字\s*排盘/;

// ============================================================
// API
// ============================================================

/**
 * 判一条输入是不是生辰八字意图
 *
 * @param {string} input 用户原始输入 (未经 resolveTaskInput 处理)
 * @returns {{matched: boolean, confidence: 'high'|'medium'|'low', reason: string, signals: string[]}}
 */
function detectBaziIntent(input) {
  const empty = { matched: false, confidence: 'low', reason: '空输入', signals: [] };
  if (!input || typeof input !== 'string') return empty;

  const text = input.trim();
  if (!text) return empty;

  const signals = [];

  // ---- 显式要排八字 ----
  // 没给数据也命中: 此时该做的是追问生辰, 起卦是错的
  if (_BIZI_REQUEST.test(text)) {
    signals.push('bazi_request');
    return {
      matched: true,
      confidence: 'high',
      reason: '明确要求排八字 —— 该走 bazi_calc 或追问生辰, 不该起卦',
      signals,
    };
  }

  // ---- 判日期 ----
  const hasDate = _FULL_DATE.test(text) || _CN_FULL_DATE.test(text) || _CN_MONTH_DAY.test(text);
  if (!hasDate) {
    return { matched: false, confidence: 'low', reason: '无生辰日期', signals };
  }
  signals.push('date');

  // ---- 日期 ∧ 语境信号 ----
  if (_BIZI_KEYWORD.test(text)) {
    signals.push('keyword');
    return {
      matched: true,
      confidence: 'high',
      reason: '生辰日期 + 八字关键词',
      signals,
    };
  }
  if (_CLOCK.test(text)) {
    signals.push('clock');
    return {
      matched: true,
      confidence: 'high',
      reason: '生辰日期 + 具体时辰',
      signals,
    };
  }
  if (_FATE_CONTEXT.test(text)) {
    signals.push('fate_context');
    return {
      matched: true,
      confidence: 'high',
      reason: '生辰日期 + 命理术语',
      signals,
    };
  }
  if (_GENDER.test(text)) {
    signals.push('gender');
    return {
      matched: true,
      confidence: 'medium',
      reason: '生辰日期 + 性别',
      signals,
    };
  }

  // 只有日期、没有语境信号 —— 可能只是普通日期 (「查 2015年3月15日的会议」)
  // 不拦, 保持原行为
  return {
    matched: false,
    confidence: 'low',
    reason: '只有日期, 无生辰语境 —— 可能是普通日期, 不拦',
    signals,
  };
}

/**
 * 该不该跳过起卦 —— **唯一真源** (2026-10-23 第 58 批)。
 *
 * 2026-10-23 老板报的真 bug (原话):
 *   「1990年3月15日生, 男, **算一卦**看今年财运」
 * → detectBaziIntent 命中(日期+性别) → **跳过起卦** → 主人明说要卦却没卦。
 *   而规则 #19(a) 白纸黑字写着「主人明确说算一卦 → **必调**」。
 *
 * 根因: 本模块原来只做减法, 判据是「这题是不是八字题」。可主人给生辰
 *   **正是想让卦落到干支上** —— 那就是「串起来」最该做对的一题。
 *   真正该跳过的只有一种: 主人明说排八字(八字本身就是盘, 再叠卦 = 两套盘打架)。
 *
 * 三档 (顺序定死):
 *   ① 明说排八字        → 跳过。P1-4 的原话: 两套盘打架。
 *   ② 明说要卦 + 有生辰 → **不跳过**。卦要, 生辰是落地材料 ⇒ 走 combo。
 *   ③ 有生辰, 没说卦    → 跳过。八字本身就是盘。
 *
 * ⚠️ ① 放在 ② 前面是**定死的**: 「排八字顺便算一卦」按排八字办(不叠卦)。
 *   跟 modules/layer_plan.js 的路由优先级是同一处决定, 两边必须一致 ——
 *   一处改一处不改就是「两份同义文本各改各的」。
 *
 * @param {string} input
 * @returns {boolean}
 */
function shouldSkipGuaCast(input) {
  return evaluateGuaSkip(input).skip;
}

/**
 * 起卦跳过与否 —— 带理由版 (给上层打日志用)。
 *
 * @param {string} input
 * @returns {{skip:boolean, reason:string, signals:string[]}}
 */
function evaluateGuaSkip(input) {
  const r = detectBaziIntent(input);
  const signals = (r && r.signals) || [];
  if (!r || !r.matched) {
    return {
      skip: false,
      reason: '未识别出生辰意图 —— 照常起卦',
      signals,
    };
  }
  if (signals.indexOf('bazi_request') >= 0) {
    return {
      skip: true,
      reason: '主人明说排八字 —— 八字本身就是盘, 不叠卦',
      signals,
    };
  }
  if (isGuaCastRequest(input)) {
    return {
      skip: false,
      reason: '主人明说要卦 —— 生辰此时是落地材料, 卦与八字串起来用',
      signals: signals.concat(['gua_request']),
    };
  }
  return {
    skip: true,
    reason: (r.reason || '识别出生辰意图') + ' —— 八字本身就是盘, 不叠卦',
    signals,
  };
}

module.exports = { detectBaziIntent, shouldSkipGuaCast, evaluateGuaSkip };

