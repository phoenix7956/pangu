/**
 * tool_spin_guard.js — 「工具空转」守门的唯一真源 (2026-10-23 第 73 批)
 *
 * 为什么要有这个模块 (实跑现场, 不是推演):
 *   2026-10-23 23:30 真实请求「1990年3月15日生男，今天适不适合把手上这个项目的第一步做掉？给个决断。」
 *   实跑 SSE 200 秒没出 final, 服务日志:
 *     [j2-batch] tool_start: bazi_calc   ts=1792769430141
 *     [j2-batch] tool_start: exec_command ts=1792769430141   ← node -e "require('sxtwl')" → MODULE_NOT_FOUND
 *     [j2-batch] tool_start: exec_command ts=1792769466726   ← find sxtwl → 空输出
 *     [j2-batch] tool_start: exec_command ts=1792769538484   ← 再试
 *     [j2-batch] tool_start: wuxing_judge ts=1792769667551
 *   最终 nativeRounds=5 才收口。**空转守门一道没响**。
 *
 * 根因 (机制层, 不是"模型笨"):
 *   空转检测 (按工具名记账, 参数怎么换都算同一次) **只写在 legacy 分支**
 *   (j2_agent_loop.js 靠后那一段), native 分支 (实测主路) **一行都没有**。
 *   而 native 才是实测主路 —— qwen3.8-27b / MiniMax 全走 native。
 *   ⇒ 一道在主路上不存在的闸门, 等于没有闸门。
 *
 * 为什么既有三道闸门也拦不住 (参数换了就换桶):
 *   · DUPLICATE_TOOL_CALL: 按 工具名|参数 分桶 —— 模型每次换参数, 桶永远不同
 *   · _CROSS_ROUND_FAIL_LIMIT: 同上, 也按 工具名|参数
 *   · legacy 的空转守门: 唯一按工具名记的, 但它不在 native 路上
 *   三道闸门全都以"工具+参数"为键, 而空转的症状恰恰是**换参数重试**。
 *
 * ── 三条规则 (为什么是三条, 每条对应一类真实现场) ──────────────
 *
 *   R1 探测类工具反复调 (probeLimit = 4)
 *     探测类工具 (system_info / current_time / process_list …) 本身不产出结论,
 *     反复调就是原地打转。**不看结果有没有内容**, 看调用次数。
 *     现场: 2026-10-09 老板截图 (8 次调用全是探测, 一句结论没有)。
 *
 *   R2 同一个工具连续 barren (barrenLimit = 2) ← 本批新增, 抓的就是上面那次实跑
 *     barren = 失败 (ok=false) 或 空输出 (stdout/stderr 都空 / content 空 / 0 命中)。
 *     模型拿同一个工具连吃两个空, 说明**这条路走不通**, 换参数再试第三次就是在瞎试。
 *     实跑证据 (会话 request-1792769303516-b1fe3a 的工具结果原文):
 *       exec_command #1 → ok:false, stderr "Cannot find module 'sxtwl'"
 *       exec_command #2 → ok:true, stdout:"" stderr:""   ← 空
 *       exec_command #3 → ok:true, stdout "今日干支: 庚午…" ← 才拿到东西
 *     R2 在第 2 次就响, 比"数够 3 次"早一轮, 省下的就是本地 27B 的一整轮 (≈70s)。
 *     ⚠️ 为什么这条不能被"模型说了话"解禁: 实跑那三轮 assistant content 是空的
 *     (模型的推理走 reasoning 通道, 正文留空), 所以"说过话"在 native 上没有信息量。
 *
 *   R3 同一个域工具反复调 + 这一轮没结论 (domainLimit = 3)
 *     域工具合法重复很多 (读 8 个文件 / 给 3 个人排盘), 所以它比 R1 严:
 *     要求"这一轮一句实质话都没说" **且** "手上没有写盘/编辑/验收进展"。
 *     现场: 2026-10-12 会话 78325678 —— bazi_calc 被连调 5 次, 每次换一套瞎猜的出生日期
 *     (1978-8-26 → 8-13 → 8-6 → 7-14 → 7-14@11时), 五轮零文本输出。
 *
 * ── native 与 legacy 的 R3 口径为什么不一样 (不是偷懒, 是信号质量不同) ──
 *   native 路径里, 工具轮的 assistant content **经常是空的** (模型把话都放进
 *   reasoning 通道) —— 实跑那次三轮 content 分别只有 "\n\n\n" / "\n\n" / "\n\n"。
 *   于是 native 上的"这句话是不是实质结论"没有信息量, 拿它当 R3 的解禁条件,
 *   等于让 R3 对**合法的多文件阅读**开火 (读 5 个文件 → 第 3 次就被喊停 → 提前收口)。
 *   native 改用"手上有没有证据"(本次运行里有没有非 barren 的工具结果)当解禁条件:
 *   有证据 = 手里有东西, 让它继续; 全是空 = 才是真的空转。
 *   legacy 路径的模型会在工具轮里写说明文字, "说过话"在那里有信息量, 口径保持原样。
 *   ⇒ 这个差异由调用方显式传进来 (domainRuleNeedsEvidence), 不是藏在实现里的暗改。
 *
 * 收成唯一真源的意义: legacy 那份实现改成调本模块, native 那份**新接上**本模块。
 * 两份抄本 = 两个真源 = 迟早又岔开 (2026-10-18 那次三套顺序就是这么来的)。
 *
 * 纯逻辑, 不碰 res / messages —— 好测。判据在 tests/tool-spin-guard-20261023.test.js。
 */
'use strict';

// 探测类工具: 反复调没有任何推进作用, 阈值低。
// 2026-10-09 老板截图现场 (连续探测 system_info/network_check/process_list) 定下的名单。
const PROBE_TOOLS = new Set([
  'system_info', 'process_list', 'network_check', 'current_time',
  'list_pangu_agents', 'system_quality_check',
]);

// 探测类: 第 4 次起喊停。
const TOOL_NAME_SPAM_LIMIT = 4;
// 域工具: 合法重复很多 (读 8 个文件 / 给 3 个人排盘), 阈值高, 且只在"整轮零实质输出"时才触发。
const DOMAIN_TOOL_SPAM_LIMIT = 3;
// 同一个工具连续吃两个空 (失败/无输出) 就该换路 —— 本批新增。
const BARREN_SPAM_LIMIT = 2;

// 有实质进展就不算空转 —— 写盘/编辑/验收三类。
const PROGRESS_TOOLS = new Set(['write_file', 'file_edit', 'apply_patch', 'task_done']);

/**
 * 结果是不是"barren"(失败或空输出)。
 *
 * 认得两种形状:
 *   · native: { tc:{name}, execResult:{ ok, data:{ stdout, stderr, content, matches } } }
 *   · legacy: { name, ok, content }
 */
function isBarrenResult(entry) {
  if (!entry) return true;
  const ok = entry.ok !== undefined ? entry.ok
    : (entry.execResult && entry.execResult.ok !== undefined ? entry.execResult.ok : undefined);
  if (ok === false) return true;
  const payload = entry.execResult || entry;
  if (!payload) return true;
  if (payload.error) return true;
  const d = payload.data;
  if (d && typeof d === 'object') {
    const hasOut = typeof d.stdout === 'string' || typeof d.stderr === 'string';
    if (hasOut) {
      // shell 类: stdout 和 stderr 都空 = 什么都没拿到
      const out = String(d.stdout || '').trim();
      const err = String(d.stderr || '').trim();
      return !out && !err;
    }
    if (typeof d.content === 'string') return d.content.trim() === '';
    if (Array.isArray(d.matches)) return d.matches.length === 0;
  }
  if (typeof payload.content === 'string') return payload.content.trim() === '';
  if (typeof payload.stdout === 'string' || typeof payload.stderr === 'string') {
    return String(payload.stdout || '').trim() === '' && String(payload.stderr || '').trim() === '';
  }
  return false;
}

function resultName(entry) {
  if (!entry) return null;
  if (entry.name) return entry.name;
  if (entry.tc && entry.tc.name) return entry.tc.name;
  return null;
}

/**
 * 造一个按 session 记工具名的守门。
 *
 * @param {object} opts
 * @param {number} [opts.probeLimit]       探测类工具的喊停阈值
 * @param {number} [opts.domainLimit]      域工具的喊停阈值
 * @param {number} [opts.barrenLimit]      同一工具连续 barren 的喊停阈值
 * @param {string[]} [opts.progressTools]  有实质进展就算数的工具名
 * @param {string[]} [opts.probeTools]     探测类工具名单
 * @param {boolean} [opts.domainRuleNeedsEvidence]
 *        R3 (域工具次数) 是否额外要求"手上没有证据"。
 *        native 传 true (工具轮正文常为空, "说过话"没有信息量),
 *        legacy 保持 false (那里的"说过话"有信息量)。
 * @returns {{
 *   note: (calls: Array, results?: Array) => void,
 *   check: (ctx: { saidAnything?: boolean, toolsUsed?: string[] }) => { spammed: string[], message: string } | null,
 *   countOf: (toolName: string) => number,
 *   barrenOf: (toolName: string) => number,
 *   hasEvidence: () => boolean,
 *   reset: (toolNames?: string[]) => void,
 * }}
 */
function createToolSpinGuard(opts) {
  const o = opts || {};
  const probeLimit = Number.isFinite(o.probeLimit) ? o.probeLimit : TOOL_NAME_SPAM_LIMIT;
  const domainLimit = Number.isFinite(o.domainLimit) ? o.domainLimit : DOMAIN_TOOL_SPAM_LIMIT;
  const barrenLimit = Number.isFinite(o.barrenLimit) ? o.barrenLimit : BARREN_SPAM_LIMIT;
  const progressTools = new Set(Array.isArray(o.progressTools) && o.progressTools.length
    ? o.progressTools
    : Array.from(PROGRESS_TOOLS));
  const probeTools = new Set(Array.isArray(o.probeTools) && o.probeTools.length
    ? o.probeTools
    : Array.from(PROBE_TOOLS));
  const domainRuleNeedsEvidence = !!o.domainRuleNeedsEvidence;

  // toolName -> 调用次数 (跨轮累计, 参数不参与)
  const counts = new Map();
  // toolName -> 连续 barren 次数
  const barrens = new Map();
  // 本次运行有没有拿到过非空结果
  let evidence = false;

  function note(calls, results) {
    const callList = Array.isArray(calls) ? calls : (calls ? [calls] : []);
    for (const c of callList) {
      const name = typeof c === 'string' ? c : (c && c.name);
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    const resList = Array.isArray(results) ? results : [];
    for (const r of resList) {
      const name = resultName(r);
      if (!name) continue;
      if (isBarrenResult(r)) {
        barrens.set(name, (barrens.get(name) || 0) + 1);
      } else {
        barrens.set(name, 0);   // 有内容 ⇒ 这一轮不是 barren, 连续计数断掉
        evidence = true;
      }
    }
  }

  /**
   * 判定这轮是不是在空转。
   *
   * @param {object} ctx
   * @param {boolean} [ctx.saidAnything] 本轮/本次运行模型有没有说出实质内容
   * @param {string[]} [ctx.toolsUsed]  本次运行用过的工具 (含历史), 用于判"有没有实质进展"
   * @returns {{spammed: string[], message: string}|null}
   */
  function check(ctx) {
    const c = ctx || {};
    const used = Array.isArray(c.toolsUsed) ? c.toolsUsed : [];
    const hasProgress = used.some((n) => progressTools.has(n));
    const saidAnything = !!c.saidAnything;
    const spammed = [];
    for (const [name, count] of counts.entries()) {
      if (probeTools.has(name)) {
        // R1: 探测类只看次数 —— 它本来就不该反复调。
        if (count >= probeLimit) spammed.push(name);
        continue;
      }
      // R2: 同一个工具连吃两个空 ⇒ 这条路走不通, 换参数再试就是瞎试。
      if ((barrens.get(name) || 0) >= barrenLimit) {
        spammed.push(name);
        continue;
      }
      // R3: 域工具次数多 + 没结论 + 没进展 (+ native 上还要"手上没证据")。
      if (count >= domainLimit && !saidAnything && !hasProgress
        && (!domainRuleNeedsEvidence || !evidence)) {
        spammed.push(name);
      }
    }
    if (!spammed.length) return null;
    return {
      spammed,
      message: buildMessage(spammed),
    };
  }

  function buildMessage(spammed) {
    return '[SYSTEM WARNING: 工具空转] 你已经反复调用 ' + spammed.join('、')
      + ', 但这一轮你从没说出一句结论, 也没有任何写盘/编辑/验收进展。'
      + '不要继续用改参数的方式重试同一个工具 —— 每次换一个参数再调一次不是查数据, 是试错。'
      + '现在立刻停下来做以下之一: (1) 基于已经拿到的工具结果直接给出结论; '
      + '(2) 如果关键参数(路径/编号/日期/名称/股票代码…)你其实不知道, 就直接问主人要, '
      + '禁止自己编一个值再去试。现在输出一段话, 不要继续调工具。';
  }

  function countOf(toolName) {
    return counts.get(toolName) || 0;
  }

  function barrenOf(toolName) {
    return barrens.get(toolName) || 0;
  }

  function hasEvidence() {
    return evidence;
  }

  function reset(toolNames) {
    if (Array.isArray(toolNames) && toolNames.length) {
      for (const n of toolNames) {
        counts.set(n, 0);
        barrens.set(n, 0);
      }
      return;
    }
    counts.clear();
    barrens.clear();
  }

  return { note, check, countOf, barrenOf, hasEvidence, reset };
}

module.exports = {
  createToolSpinGuard,
  isBarrenResult,
  PROBE_TOOLS,
  PROGRESS_TOOLS,
  TOOL_NAME_SPAM_LIMIT,
  DOMAIN_TOOL_SPAM_LIMIT,
  BARREN_SPAM_LIMIT,
};
