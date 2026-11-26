'use strict';

// 「这一刀其实死了」的判定 —— **叶子模块, 零依赖** (2026-10-19)
//
// 起因是会话 desktop-1792368769981 的现场:
//   plan s1  status: done
//   evidence: ⚠️ 模型 qwen_qwen3.8-27b 端点连不上: read ECONNRESET — 已重试 2 次仍失败
//
// 一刀 ECONNRESET, 界面上两个面板都显示「完成」—— 计划卡计进 nDone,
// 将灵卡显示「完成 90.5s」。主人看到的是"它干完了", 实际它一步都没跑成。
// 这正是老板盯的那件事: «我在乎的是盘古是不是活着, 是不是能交付»。
//
// 根因在 subagent_runner.js:
//   const _subSummary = (r && r.finalText) || '';
//   ...
//   updateStep(..., { status: 'done', evidence: _subSummary.slice(0, 200) });
// **只要 finalText 非空就标 done**。而 LLM 调用失败时 j2 把报错文案
// 塞进了 finalText ("⚠️ 模型 ... 端点连不上: ..."), 那是个非空字符串,
// 于是失败被当成产出。
//
// 为什么单独一个文件: 判定表原本住在 j2_dispatcher.js 里, 而
// j2_dispatcher.js:113 **已经 require 了 subagent_runner** —— 反过来再引就是
// 循环依赖, Node 里半边是 undefined, 哪天 require 顺序一变就炸。
// 跟 gua-identity.js 当初被拆出来的理由一模一样, 所以这里也做成叶子:
// 谁都能引, 引谁都安全, 而且只有一份。
//
// 判据两个, 缺一不可:
//   runtimeStatus —— j2 的裁决, 取值 completed / partial / failed
//   死法正则     —— 兜住 runtimeStatus 缺失的老路径, 以及"报错文案混进 summary"
//     两种信号都指认"没干成", 就别标 done。

// 2026-10-16 补 STREAM_PREFILL_TIMEOUT —— llm_caller 把"首字节前的 prefill 预算用完"
// 和"吐着吐着静默"拆成两个报错名了, 只认旧的 STREAM_IDLE_TIMEOUT 会漏掉前者,
// 那一刀会被当成"有产出"从而放弃整轮 slice (实测 3 刀全空的现场就是这个组合)。
//
// 2026-10-23 (第 64 批): **这份表原来只认 3 种超时** (LLM_SOCKET / STREAM_IDLE /
// STREAM_PREFILL), 漏掉 STREAM_TOTAL_TIMEOUT / LLM_FETCH_TIMEOUT / LLM_ROUND_TIMEOUT ——
// 而 STREAM_TOTAL_TIMEOUT 恰恰是最常撞的那一种 (总时长熔断)。
// 现场: b63-guagate3 撞的就是 STREAM_TOTAL_TIMEOUT_390s, 这张表认不出来 ⇒
// 那一刀被当成"有产出", 整轮 slice 不放弃, 接着再撞一次。
// 现在超时那 6 种从 modules/timeout_policy.js 取, 本文件不再自己抄。
const { buildTimeoutDeadRe: _buildTimeoutDeadRe, CONNECTION_ERROR_PATTERN: _CONN_RE, TIMEOUT_KINDS: _TIMEOUT_KINDS } = require('./timeout_policy');
const SLICE_DEAD_RE = _buildTimeoutDeadRe(
  '额度已耗尽|端点连不上|' + _CONN_RE);

// ─────────────────────────────────────────────────────────────────────────────
// 死法判据 (2026-10-25 第 84 批): 从「全文扫」改成「只认机器报错文案的**头部**」
//
// 现场 (2026-10-25, 子 agent 分析盘古自己源码的那一轮):
//   刀交卷 8379 字, 汇报里**引用了** llm_caller.js 里的超时错误名
//   (`LLM_SOCKET_TIMEOUT` / `STREAM_PREFILL_TIMEOUT` / `STREAM_IDLE_TIMEOUT` /
//     `STREAM_TOTAL_TIMEOUT` / `LLM_FETCH_TIMEOUT`)
//   —— 那是**在描述代码怎么处理超时**, 不是**这一刀撞上了超时**。
//   老判据扫全文 ⇒ 命中 ⇒ 这一刀被判「死了」:
//     · 界面发 sub_agent_error (主人看到的是「这一刀失败」)
//     · plan step 标 failed (计划卡把它计进没干成的)
//     · findings.ok = false (记成「不是真交付」)
//   ⇒ 一刀**干完了的源码分析**被报成失败。
//
// 这跟第 83 批修的那两个守卫是**同一个病**:
//   守卫拿**自由散文**当判据, 分不清「这件事发生了」和「这件事被提到」。
//
// 证据 (全库 29 条命中样本, ~/.pangu-data/sessions, 现场逐条统计):
//   真死 (16 条): 长度 102-339,  首次命中偏移 23-31   —— 命中**就在首行**
//   误伤 (13 条): 长度 1169-8379, 首次命中偏移 853-6279 —— 命中在**正文深处**
//   真死样本**全部**以 `⚠️` 开头 (机器错误文案 = `⚠️ 模型 …`)。
// ⇒ 判据: 只看**第一行**, 且第一行得是**机器报错形态**。
//
// ⚠ 死法**词表一个字都不改** (`SLICE_DEAD_RE` 原样, 变异测试 M8 仍咬得住):
//   改的是「在哪儿找」, 不是「找什么」。
// ─────────────────────────────────────────────────────────────────────────────

// 剥掉开头的 markdown 标题行, 取真正的「第一行」。
//
// 为什么必须剥标题: 父 agent 的答复会把子 agent 的汇报**连 `### li` 标题一起抄**
// (现场实测: 答复开头就是 `### li\n\n⚠️ 模型 …`)。不剥标题, 死法词就落在标题**后面**的行上,
// 头判据就漏判真死刀。
//
// 最多剥 2 行标题 (`## 一、各自职责` 这种), 剥多了会把正文的头一行也当标题吃掉。
const _HEADING_LINE_RE = /^[ \t]*#{1,6}[ \t]+[^\n]*\n?/;

function headLine(summary) {
  let t = String(summary == null ? '' : summary).replace(/^\uFEFF/, '');
  for (let i = 0; i < 2; i++) {
    const m = t.match(_HEADING_LINE_RE);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  t = t.replace(/^[ \t\r\n]+/, '');
  const nl = t.indexOf('\n');
  return nl >= 0 ? t.slice(0, nl) : t;
}

// 机器错误文案的签名: `⚠️` 开头。
//   j2_loop_shared._infraFailText / _quotaFailText 生成的文案**全部**长这样
//   (`⚠️ 模型 <id> 端点连不上: …` / `⚠️ 模型 <id> 额度已耗尽 (HTTP 429)。…` / …),
//   现场 16 条真死样本无一例外。
//
// ⚠ 别把 `⚠️` 当成「死」的充分条件: 机器还会发别的 `⚠️` 文案
//   (`⚠️ [Silent Failure / 本轮未收口] …` / `⚠️ **对账纠正** …` / `⚠️ 已执行相关工具…`),
//   那些**不是**死刀。⇒ 死法词检查必须**在前**, `⚠️` 只是形态确认。
const _MACHINE_ERROR_HEAD_RE = /^⚠️/;

// 超时那 6 种的**实例形态**: `_timeoutError` 造出来的错误名带真实秒数
//   (`STREAM_TOTAL_TIMEOUT_390s`); 而**文档里引用的是裸名** (`STREAM_TOTAL_TIMEOUT`)。
// ⇒ 认实例形态。
//
// ⚠ 超时清单**只允许存在 modules/timeout_policy.js 一处** (结构守卫:
//   tests/timeout-policy-20261023.test.js「消费者不许自己抄一份超时清单」会红)。
//   所以这里**从 TIMEOUT_KINDS 现场拼**, 不写字面量。
const _TIMEOUT_INSTANCE_RE = new RegExp('(?:' + _TIMEOUT_KINDS.join('|') + ')_\\d+s');
// 整行**就是**那个裸名 (现场 E4 钉死的形态: 「LLM_SOCKET_TIMEOUT」这种整条就是错误名)
const _TIMEOUT_BARE_ONLY_RE = new RegExp('^(?:' + _TIMEOUT_KINDS.join('|') + ')$');

// 其余死法 (端点连不上 / 额度已耗尽 / Node 的连接类原始报错) 出现在**头部第一行**就算死。
//   连接类错误码 (ECONNRESET 之类) 是**原始错误串**, 不是代码标识符 ——
//   报告正文里出现它极少, 出现在头部更少。
const _HEAD_DEAD_RE = /额度已耗尽|端点连不上|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/;

// 机器报错文案的**长度上限** —— 现场 16 条真死样本最长 339 字 (单行)。
// 超过这个长度的「第一行」是散文, 不是报错 (比如整段没有换行的长报告,
// 剥标题后第一行 = 整篇, 不设上限就等于又回到全文扫)。
const _DEAD_HEAD_MAX = 400;

// 这一段是不是「机器报错文案」—— 即这一刀真的死了。
function isDeadReport(summary) {
  const s = String(summary == null ? '' : summary);
  if (!s.trim()) return false;
  const head = headLine(s);
  if (!head) return false;
  if (head.length > _DEAD_HEAD_MAX) return false;
  // 死法词表 (一个字没改) —— 只是**只在头行里找**
  if (!SLICE_DEAD_RE.test(head)) return false;
  // 词命中了, 还得是**机器报错的形态**, 不是散文里引用了这些字
  if (_MACHINE_ERROR_HEAD_RE.test(head)) return true;
  if (_TIMEOUT_INSTANCE_RE.test(head)) return true;
  if (_TIMEOUT_BARE_ONLY_RE.test(head)) return true;
  if (_HEAD_DEAD_RE.test(head)) return true;
  return false;
}

// 兼容旧调用点: 原来叫 _sliceIsDead, 收进对象后名字不变
function sliceIsDead(r) {
  const s = typeof r === 'string' ? r : String((r && r.result && (r.result.summary || r.result.finalText)) || '');
  return isDeadReport(s);
}

// 一刀子任务到底算不算真的干完了 → plan step 该标什么状态。
//
// 返回 'done' | 'failed'。
// 'partial' 归到 done: 它**确实**产生了产出, 只是没收口 —— 标 failed 会让
// "还没做完" 和 "彻底挂了" 混成一类, 那比现在更糊。真正没产出的情况由
// runtimeStatus === 'failed' 和死法正则挡住。
function stepStatusFor(summary, runtimeStatus) {
  const s = String(summary || '');
  if (runtimeStatus === 'failed') return 'failed';
  if (isDeadReport(s)) return 'failed';
  // 空产出也算没干成 —— done 的前提是"有东西交"。
  if (!s.trim()) return 'failed';
  return 'done';
}

// 产出是否算真交付 (appendFinding 的 ok 字段)
//
// 原写法 `(_subResult.runtimeStatus || 'done') === 'done'` **恒为 false** ——
// runtimeStatus 的取值是 completed / partial / failed, 永远不等于 'done',
// 所以每一刀记进 findings 的 ok 都是 false, 成功刀失败刀分不开。
function isRealDelivery(summary, runtimeStatus) {
  return stepStatusFor(summary, runtimeStatus) === 'done';
}

module.exports = {
  SLICE_DEAD_RE,
  headLine,
  isDeadReport,
  sliceIsDead,
  stepStatusFor,
  isRealDelivery,
};
