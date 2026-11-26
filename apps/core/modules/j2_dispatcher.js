// modules/j2_dispatcher.js — N5 refactor batch B3-Phase 4
// J2 Dispatcher — 任务 → 8 角色路由 (关键词打分 + planner + sub-agent)
// 依赖注入: init({ _recordSessionToMemory, _callLLMForAgent, _callLLMForAgentStream, _resolveApiKey,
                    //  safeResWrite, _j2ExecuteToolCalls, _j2AppendToolResults, path, buildAgentLegacyPrompt,
                    //  truncateMessagesForContext, getModelContextLength })
// 注意: _runPanguDispatcherLoop 内部调 _runAgentLoopLegacyStream (从 j2_agent_loop 注入)
// #6 架构重叠: 移除对 sub-agent.js 的依赖, 统一走 j2_agent_loop 的 legacy stream

let _deps = null;
function init(deps) { _deps = deps; }
const j2AgentLoop = require('./j2_agent_loop');
// 2026-10-23 第 63 批: 综合 system prompt 的**唯一真源**。
// 收口 prompt 历史上被抄了四遍, 其中三份还在说「必须先以卦象定调」——
// 与 `global_agent_rules.js` 规则 #19(事实在前/禁止拿卦象开篇) 直接矛盾,
// 也就是正在让模型做老板 2026-10-21 当场明令禁止的那件事。
// 四份的全部规则进真源取并集, 顺序规则按规则 #19 取「事实在前」。
// 要改措辞/收回哪条规则: 只改 synth_prompt.js, 别再在这里内联。
const { buildSynthesisSystemPrompt } = require('./synth_prompt');

// 2026-09-18 (实案: guard 把真扫描结果拦成"请重试"): guard 全拦时, 子任务真结论直接交付
//
// 2026-10-13 (现场 probe_trivial 两个真实会话): 分段标题原来用 r.task, 而 r.task 是
// planner 写给子 agent 的**指令**, 原样成了给用户看的 H1 ——
//   问"你好"          → "### 回应老板问候，并确认可以继续接收任务；保持简洁自然，不作卦象分析"
//   问"回答一个词:就绪" → "### 按真卦确认…并仅返回\"就绪\""
// 改用角色名做分段标识: 不泄指令, 又能让读者分清哪段是哪段。
// 交付真结论的初衷 (2026-09-18) 保留 —— summary 一个字不改。
// 2026-10-13 (现场 longwork-1791848076, 长工作 40 文件任务):
//   账本真实地体: outcome artifacts_count=40, 三个 executor 分别记 15/15/10,
//   checker 实测 PASS 且字节级细节 (f00-f09=57B, f10-f39=58B, f38=61B) 与磁盘完全吻合。
//   但最终答案开头写的是 analyzer **最早**那句快照:
//   「目录完全空、40 个文件**全部不存在**」——它跑的时候确实还没人写。
//   综合 LLM 把子 agent 自述**原样背了回来**(连 prompt 里的 --- 分隔符都一起背了),
//   丢掉了喂给它的本轮真写盘清单, 并把最陈旧的那段放在最前面。
//
//   既有守卫 _answerAdmitsIncomplete 只认「未创建/没有创建」这类措辞,
//   实测本答案的「全部不存在 / 均为 MISSING / 无任何输出」**全部漏网** —— 所以它当正常答案送上屏了。
//
// 根因不是措辞写少了几个词, 而是**答案与账本事实矛盾**。账本是真源,
// 它说本轮写了 N 个文件, 答案却宣称一个都没有 —— 这不是措辞问题, 是宣輓不实。
// 所以直接对账本, 不再去补措辞。
// 用 String.raw: 普通 JS 字符串里 '\s' 不是合法转义, 会**静默退化成字面 's'**,
// 于是 '0\s*个' 变成 '0s*个' ("0" 后跟任意多个 s), 分支形同虚设而且不报错。
// 2026-10-13 已中招一次: 现场措辞 "0 个条目" 漏网, 根因就是这处反斜杠被吞。
//
// 否定分支合并成**结构**而不是逐个措辞: (没|无|未)(有)? + 填充词 + 产出名词。
// 填充词是**枚举**而不是 [\s\S]{0,N} 通配 —— 通配会把 "未修改任何内容" 这类
// 诚实陈述误判成"什么都没产出"(实测会误报), 宁可漏也不乱报。
const _NOTHING_PRODUCED_RE = new RegExp([
  String.raw`[全均一律每][^\n]{0,6}不存在`,                        // 全部不存在 / 均不存在
  // (?<![\d]) 不可省: "已写入 40 个文件" 里的 0 会被 `0\s*个文件` 命中 ——
  // 而"写了 N 个文件"恰恰是**最常见的诚实答案形态**, 误报它等于把修复变成噪声。
  String.raw`(?<![\d])0\s*个[^\n]{0,6}(文件|条目|产物|产出)`,       // 0 个条目 / 0 个文件
  String.raw`(完全|彻底|空空)?(是)?空目录|目录(完全|彻底|空空)?(是)?为空`,   // 完全空目录 / 目录为空
  // "都没" 后必须跟**生产动词**: 否则"一个都没落下"(= 一个不落, 全对) 会被误判成宣称没产出。
  String.raw`一个[^\n]{0,4}(都没|也没有|也没)[^\n]{0,4}(写|创建|建|生成|产出|生|落盘)`,  // 一个都没写
  String.raw`(没|无|未)(有)?(任何|一个|任何一个)?(创建|写入|生成|产出|输出|文件|内容|结果|条目)`,
].join('|'));

// 答案声称「什么都没产出」, 而账本记着真写盘 → 矛盾。返回细节或 null。
function _answerContradictsLedger(answerText, sessionId, sinceTs) {
  let files = [];
  try { files = require('./task_ledger').collectWrittenFiles(sessionId) || []; } catch (_) {}
  // 只看本轮的写盘 —— 全会话累计会在长会话里误报
  if (Number.isFinite(sinceTs)) files = files.filter(f => Number(f && f.ts) >= Number(sinceTs));
  if (!files.length) return null;   // 本轮确实没写盘 → 无从矛盾, 不得误报
  const t = String(answerText || '');
  const m = t.match(_NOTHING_PRODUCED_RE);
  if (!m) return null;
  const paths = files.map(f => String((f && f.path) || '')).filter(Boolean);
  return {
    written: files.length,
    claim: m[0],
    examples: paths.slice(0, 3),
    dir: paths[0] ? paths[0].replace(/\/[^/]+$/, '') : '',
  };
}

// 对账入口。收成独立函数而不是内联在送屏前, 是因为 synthesis-leak-20261012 有一条
// 结构守卫: 每处 chunk 写出前 6 行内必须出现收口剥离 (_finalizeAnswerText /
// _stripPseudoToolMarkup)。内联逻辑会把那条防线撑出窗口 —— 那条防线防的是
// "伪工具标记/空答复直接漏给主人", 不许为了新功能放松它。
//
// 教训: 上面这段注释第一版把写出调用**原样抄了一遍**(带完整参数), 结果被那条守卫的
// 正则当成真写出点, 凭空多出一个"没有收口剥离的出口"。别在注释里复写被扫描的调用形态。
// 返回 { text, contradiction }: contradiction 非空 = 答案与账本相反。
function _reconcileWithLedger(finalText, sessionId, sinceTs) {
  const c = _answerContradictsLedger(finalText, sessionId, sinceTs);
  if (!c) return { text: finalText, contradiction: null };
  console.warn('[dispatcher] 答案与账本矛盾(声称「' + c.claim + '」 vs 账本真写盘 '
    + c.written + ' 个) → 提账本纠正');
  return { text: _groundTruthCorrection(c) + '\n\n' + finalText, contradiction: c };
}

// 纠正文案: 把账本真相放在前面。不改写模型原话(对账是模型的事),
// 只把权威清单摆到用户能看见的前面。
function _groundTruthCorrection(c) {
  const ex = (c.examples || []).join(' / ');
  return '⚠️ **对账纠正**：上文有「' + c.claim + '」的说法，但本轮账本实测**真写盘 ' + c.written
    + ' 个文件**' + (ex ? '（例: ' + ex + '）' : '')
    + '。那句话是某个子 agent **执行那一刻**的旧快照，后连的写盘已经完成 —— 以账本为准。';
}


function _subConclusionFallback(results) {
  const ok = (Array.isArray(results) ? results : []).filter(r => r.result && !r.error);
  if (!ok.length) return '';
  return ok.map(r => '### ' + String(r.agent || '子任务') + '\n\n' + String(r.result.summary || r.result.finalText || '').slice(0, 2000)).join('\n\n---\n\n');
}

const path = require('path');
const fs = require('fs');
const { guardAnswer, isCorrectionTurn, isBareFlip } = require('./answer_alignment');
const { classifyRuntimeVerdict } = require('./runtime_verdict');

// 2026-10-17 (老板拍: 「乾就应该把任务拆了, 分下去」):
// 派发机制整体搬进 subagent_runner, 因为主 agent (乾) 现在也要调它 ——
// 两边各留一份 = 迟早只改其中一份 (踩坑日志原话)。下面这些名字全部来自那一个真源,
// dispatcher 对外 API 一字未变 (回归测试仍从 j2_dispatcher 直接引用它们)。
const _runner = require('./subagent_runner');
const { createSubagentRunner } = _runner;
const _makeSinkRes = _runner._makeSinkRes;
const _ownerScopeBlock = _runner._ownerScopeBlock;
const _ownerPathScope = _runner._ownerPathScope;
const _extractOwnerPaths = _runner._extractOwnerPaths;
const _roleModelFor = _runner._roleModelFor;
const _effortForRole = _runner._effortForRole;
const _ROLE_REASONING_DEFAULT = _runner._ROLE_REASONING_DEFAULT;
const _stripGuaBlockForRouting = _runner._stripGuaBlockForRouting;


// 子 agent 的工具结果在 results[].result.data.toolHistory 里 (sub-agent.js 带回)。
// 出门核验门要拿它当权威四柱的依据 —— 各调用点自己拼一遍形状 = 迟早只改其中一处。
function _chartEvidenceFrom(results) {
  const out = [];
  for (const r of (Array.isArray(results) ? results : [])) {
    const h = r && r.result && r.result.data && r.result.data.toolHistory;
    if (Array.isArray(h)) out.push(...h);
  }
  return out;
}

// 2026-10-12 (老板拍"你没有修好"): 命盘答案出门核验门 — 所有 dispatcher 综合定稿共用。
// 答案里抽得出四柱就过本地查表; 有硬伤强制重修一轮 (事实块+硬伤清单), 重修仍有硬伤附诚实标注。
// 2026-10-21: toolResults 传进来后, 核验基准从"答案自己抽的盘"换成 sxtwl 权威盘 (chart_answer_gate 内)。
//
// 2026-10-21 第九批: 卦象侧也补上门, 这里改名 _factGate。
//   之前只有命盘侧有门, 卦侧一直是空的 —— 第八批实跑实测盘古把「第24卦」答成贲卦、
//   把复卦写成「雷地复」(应为地雷复)、爻辞写「七条」(单卦恒六爻), 没有任何东西拦。
//   合成一道门而不是并排两道: 出门只有一道闸, 以后加第三种断言(梅花/六壬/奇门)也只改一处,
//   不会出现"新门忘了接到某个调用点"。卦象门不需要排盘证据, 但照样收 toolResults 保持一个签名。
//
// 2026-10-23 第 60 批: 这段实现**搬进 modules/answer_gates.js**, 这里只留调用。
//   起因: j2_agent_loop.js 里另有一份内联拷贝(没走这个函数), 两份已经漂了 ——
//   日志条件一个看 repaired 一个看 repaired||矛盾, ask 回一个带 soulScope 一个不带。
//   「新门只改一处」这条设计意图, 正是被 loop 那份拷贝违反的。
//   现在「跑哪几道门、按什么顺序、怎么记日志、异常怎么办」只有 answer_gates 一份。
async function _factGate(finalText, model, toolResults) {
  try {
    const _gates = require('./answer_gates');
    const ask = _gates.buildAskFn(_deps._callLLMForAgent, model);
    const out = await _gates.runAnswerGates(finalText, ask, {
      chartEvidence: toolResults,
      logPrefix: '[dispatcher]',
    });
    return out.text;
  } catch (_) { return finalText; }
}

function _guardFinal(userInput, finalText, fallbackText, evidenceText = '') {
  const guarded = guardAnswer(userInput, finalText, fallbackText, evidenceText);
  if (guarded.blocked) return '本轮未形成与原问题匹配的可核验答案，请重试。';
  return guarded.text;
}

// 2026-09-12 (PANGU_RESCAN N3 接线): 关键词兜底前先看 L3 学习到的组合 —
// l3_dispatcher 从 .learn/l3_state.json 读 taskToAgents (B2 修复后有真数据),
// 有建议 (≥3 次调用 + pass≥0.4) 则覆盖关键词路由, 没有就走原关键词兜底。
function _routeWithL3(userInput, configPath) {
  const fallback = (typeof (_deps || {})._keywordFallback === 'function') ? _deps._keywordFallback(userInput, configPath) : null;
  try {
    const _l3 = require('./l3_dispatcher').dispatchAgentsForTask(userInput);
    if (_l3 && _l3.applied && Array.isArray(_l3.agents) && _l3.agents[0]) {
      console.log('[dispatcher] L3 路由生效: pattern=' + _l3.pattern + ' → [' + _l3.agents.join(', ') + ']' + (fallback ? ' (覆盖关键词 [' + fallback.role + '])' : ''));
      return { role: _l3.agents[0], matchedKws: ['l3:' + _l3.pattern], _l3Agents: _l3.agents };
    }
  } catch (_) { /* l3_dispatcher 未就绪不阻塞 */ }
  return fallback;
}
// Bug #11 (sub-agent report 误报): subAgent.run() 还在用 (line 48/100/108), 不能删 require
// 注: '架构已迁移' 注释反映长期目标, 但 subAgent.run 仍是 fallback 路径
const subAgent = require('../agents/sub-agent.js');
const subAgentRuns = require('../modules/subagent_runs'); // 2026-09-17 工作体现落盘
// 2026-10-12 P0 (老板报"会话 75738498 接不上上文", 实锤): dispatcher 把整段 messages
// 传进来了, 但只用来 _persistParent / legacy 兜底 —— planner、fixed_flow 子 agent、
// keyword fallback、综合 LLM **全都只拿到本轮 userInput**, 上一轮问答一个字都看不到。
// 实测: 主人追问"不对吧, 你是不是流年和大运看岔了?", analyzer 子 agent 的 task 里只有
// 卦块 + 这一句追问, 于是回"我会先检索是否有出生资料/排盘结果" —— 它根本不知道盘古上一轮
// 答了什么, 也不知道主人说的"流年/大运"指的是哪张盘。
// 修: 从 messages 里抽历史轮次, 拼成一段有预算上限的上下文块, 焊进每个子 agent 的任务
// 和综合 prompt。有历史才给块, 第一轮对话行为不变。
const _HISTORY_MAX_TURNS = 4;      // 最多回溯 4 轮
const _HISTORY_MAX_CHARS = 2600;   // 整块硬上限, 防止长会话把子 agent 上下文吃光
const _HISTORY_TURN_CHARS = 700;   // 单轮上限

// 2026-10-12 (final-v1-20261012): 只剩标题没有说明文字的那种【上文】块也要剥。
// 窄匹配: 必须同时有【方括号 + 破折号 + "本会话此前的对话"三个特征,
// 所以 '上文这个卦怎么解？' 这类主人原话不受影响 (④c 守着呢)。
// 2026-10-12 (leak-probe / leak-verify-20261012-1): 收口统一出口 ——
// ① 剥伪工具标记与控制 token ② 剥完不能是空的, 空了就回落子 agent 结论
// (剥干净但答案没了 = 主人看到一片白, 比显示垃圾更糟)。
// 2026-10-12 (final-v1-20261012 实案): 回落**只能**用子 agent 的结论, 不能用
// toolHistorySummaries —— 那个串带 `task:` 脚手架, 里面有喂给子 agent 的【上文】块,
// 泄给主人等于把 57e9e1a 立下的规矩再捅穿一次 (final-v1 实测答复里直接出现了
// 「[上文-仅供你参考…]」整段)。
function _childConclusions(results) {
  const parts = (results || []).map((r) => {
    const s = (r && r.result && (r.result.summary || r.result.finalText)) || '';
    return String(s).trim();
  }).filter(Boolean);
  if (!parts.length) return '';
  let out = parts.join('\n\n---\n\n');
  try { out = _stripHistoryLeak(out); } catch (_) {}
  return out.trim();
}

// 2026-10-12 (实案 diag-empty-20261012): 抽出成纯函数, 好让直答轮的例外能被单测钉住。
//   runtimeStatus 的语义是"这轮有没有成功调成工具", 主人明说"别调工具"时 analyzer 听话直答 →
//   status 必然是 failed → 整轮 child_failures 非空 → 对外自报"没干活", 实际答案就在手里。
//   directAnswerTurn 且拿到实质结论时, 听话不算失败。
const _CHILD_FAIL_TEXT_RE = /未通过|未核验|请重试|熔断|无法完成|没有通过核验|不通过/;
// 2026-10-25 (第 85 批 c): 老判据拿**全文扫**找失败词, 于是「在描述盘古自己的错误处理」
// 的**源码分析报告**被当成了「这一刀失败了」。
//
// 现场 (会话 probe86-fixed, 三刀 runtimeStatus **全是 completed**):
//   刀0 汇报 8440 字,  失败词首次命中在**第 1513 字** (在讲 llm_caller 的超时处理)
//   刀1 汇报 8042 字,  失败词首次命中在**第 198 字**  (「守卫与熔断」= 列举 J2 的守卫)
//   刀2 汇报 10208 字, 首次命中在**第 5686 字** (在讲 j2_agent_loop 的失败分支)
// ⇒ 三刀全被 `_CHILD_FAIL_TEXT_RE` 扫中 ⇒ 三刀全进 child_failures
// ⇒ `[dispatcher] resDone: child summaries contain failed/unverified evidence; refusing completed`
// ⇒ 一份结构完整的综合答案被判 partial。
//
// 这跟第 84 批修的验收刀 (`_verdictOfChecker`) 是**同一个病**, 修法也是同一把尺子:
//   **位置 + 形态** —— 只认**头部**的失败证据。
//   短文本 (≤400 字) 保持全文扫, 能力不减: 现场真死样本 102-339 字,
//   两条钉死的用例 (「结论未通过核验, 请重试」13 字 / 「工具熔断」4 字) 都在这一侧。
const _CHILD_FAIL_SCAN_MAX = 400;

// 「这份汇报里有没有失败证据」的**唯一**判据。
//
// 2026-10-25 (第 85 批 d): 抽出成函数, 因为这个判据在同一个文件里被抄成了**两份**——
//   ① `_isChildFailure` (拆解轮 qian 的 child_failures)
//   ② `_ffChildFailed` (fixed_flow 分支的 _ffFailed)
// 两份各自写死一份正则、各自全文扫, 于是 85c 只治好了 ①, ② 还带着同一个病:
// fixed_flow 下跑同样的源码分析任务, 照样会被降级成 partial。
// 这就是本文件注释里反复出现的那句「同一个修复只打了一半」。
//
// 抽出来的代价: fixed_flow 那份手抄的正则少了一个 alternative (`没有通过核验`)。
//   统一到 `_CHILD_FAIL_TEXT_RE` 之后, 两条路径对**同一份汇报**给出同一个判断 ——
//   同一份词表、同一套位置规则。这比「两条路径各判各的」可靠。
//   (语义上 `没有通过核验` 与 `未通过` 是同一件事, 补齐不改变判断方向。)
function _childTextFailure(summary) {
  const s = String(summary || '');
  if (s.length > _CHILD_FAIL_SCAN_MAX) return _CHILD_FAIL_TEXT_RE.test(_headLine(s));
  return _CHILD_FAIL_TEXT_RE.test(s);
}

function _isChildFailure(r, directAnswerTurn) {
  if (r && r.error) return true;
  const status = r && r.result && r.result.runtimeStatus;
  const summary = String((r && r.result && r.result.summary) || '');
  if (status === 'failed') {
    if (directAnswerTurn && summary.trim().length >= 2) return false;
    return true;
  }
  // 第 85 批 c: 长报告 ⇒ 只扫**头部第一行** (深处的是在描述被分析的对象)
  return _childTextFailure(summary);
}

// 合成层遇到「上游整条流只回思考」时的策略 (2026-10-25 第 86 批)。
//
// 抽成**模块级纯函数** (不闭包任何运行时依赖), 原因: 这条策略要能被单测直接钉住,
// 而 `_synthesizeStreamText` / `_fallbackSynthesis` 都住在 dispatcher 的闭包里,
// 测不到。抽出来之后, 「重试几次」「什么时候才兜底」这两个决定都有测试守着。
//
// 参数:
//   attempt  —— 跑一次综合, 返回最终文本; 失败就抛
//   fallback —— 兜底 (纯拼接, 不烧 LLM), 收一个错误对象
//
// 为什么「只回思考」要重试而别的错误不重试:
//   只回思考 = 上游这次抽风 (模型把「该读文件」写进了思考里, 没写正文),
//   重跑一次通常就有正文 —— 而兜底给的是「### 1. li」拼接, 有内容但形态难看。
//   别的错误 (端点挂了/超时) 重试没有意义, 直接兜底。
async function _synthesizeWithRetry(attempt, fallback) {
  try {
    return await attempt();
  } catch (e) {
    if (!(e && e.reasoningOnly)) return fallback(e);
    console.warn('[dispatcher] synthesis 只回思考 (' + (e.reasoningChars || 0)
      + ' 字, 无正文) → 重试一次');
    try {
      return await attempt();
    } catch (e2) {
      return fallback(e2);
    }
  }
}

// 2026-10-16 (现场 lt3, 本地 qwen3.8-27b, 5 步长任务 2190s = 36.5 分钟):
// 前两刀 executor 全对 —— u2.txt="3"、u1 与 u3 diff 一致, artifacts 都在盘上。
// 最后一层 checker 撞上 read ECONNRESET, 而老判据只有一句:
//   「本层全部死于 额度已耗尽|端点连不上 → 整轮 quota fast-fail」
// 它分不清两种完全不同的局面:
//   ① 第一层就死 —— 后面还没花钱, 中止确实省钱 (判据当初就是为了这个写的)
//   ② 最后一层验收时端点抖了一下 —— 上游的活已经落盘, 这时候中止不是省钱,
//     是把 36 分钟的正确产出扔进垃圾桶
// 盘古分不清, 于是按 ① 处理: 整轮判 failed, 主人收到的答复是
// 「本轮未形成与原问题匹配的可核验答案, 请重试。」
// —— 让他去重试一件已经做完的事。这才是"长任务无法执行"最伤的一种形态:
// 不是慢到不能忍, 是跑完了还没法信。慢用户会等, 不可信用户不会再用第二次。
//
// 所以加一条硬条件: 已经有刀真的交付了产出, 就不许整轮放弃。
// 降级路径本来就是现成的 —— 账本里有真写盘清单 (_groundTruthBlock), 综合 LLM 会照着
// 如实说「步骤 1-4 已完成并落盘, 步骤 5 验收因端点断连未完成」; 综合自己再挂,
// 还有 _fallbackSynthesis 纯拼接兜底 (不烧 LLM)。宁可交一份 partial, 不交一句重试。
//
// 抽成函数而不是就地改: 这个判据历史上抄在三处 (fixed_flow / DAG 分层 / 全并行),
// 上一次就是只改了一处、实机走的是另一处, 白改一场。这里三处共用一个定义。
// 2026-10-16: 补 STREAM_PREFILL_TIMEOUT —— llm_caller 把"首字节前的 prefill 预算用完"
// 和"吐着吐着静默"拆成两个报错名了, 这里只认旧的 STREAM_IDLE_TIMEOUT 会漏掉前者,
// 那一刀会被当成"有产出"从而放弃整轮 slice (实测 3 刀全空的现场就是这个组合)。
// 2026-10-19: 判定表搬进 modules/slice_death.js (叶子, 零依赖), 这份定义删掉。
// 为什么必须搬: subagent_runner.js 需要同一份判定来给 plan step 定状态
// (现场 59740796 那一轮 ECONNRESET 被标成 done), 而本文件第 113 行**已经
// require 了 subagent_runner** —— 反向引用就是循环依赖, Node 里半边是
// undefined, 哪天 require 顺序一变就炸。跟 gua-identity.js 当初被拆出来的
// 理由一模一样, 所以那份也得是叶子模块。
const { SLICE_DEAD_RE: _SLICE_DEAD_RE, sliceIsDead: _sliceIsDead, isDeadReport: _isDeadReport, headLine: _headLine } = require('./slice_death');
function _investedArtifacts(results) {
  return (results || []).some(r => {
    const a = r && r.result && r.result.artifacts;
    return Array.isArray(a) && a.length > 0;
  });
}
function _shouldFastFail(layerResults, allResults, isDead) {
  const _dead = typeof isDead === 'function' ? isDead : _sliceIsDead;
  if (!Array.isArray(layerResults) || !layerResults.length) return false;
  if (!layerResults.every(_dead)) return false;
  return !_investedArtifacts(allResults);   // 已交付产出 → 不许整轮丢
}

// 2026-10-17: 单刀直查那一刀要给的白名单。
//   = analyzer 的查询工具 + analyzer 够不着、却只挂在 checker 白名单上的那几个。
//
// 抽成独立函数是因为这里出过一个**极便宜但致命**的错:
//   写成 [ X || [] ] (本意"防 undefined"), new Set 里第一个元素就成了**数组本身** ——
//   它匹配不到任何工具名, toolsAllowed 从 21 个塌成 4 个。
//   现场证据: [llm-cost] sub:analyzer tools=4 (应该 21)。而天气那次是**碰巧**答对的 ——
//   weather_check 恰好在那 3 个字符串里; 换成"查一下英伟达股价"就当场翻车, 因为
//   stock_resolve / stock_quote 全被那个嵌套数组挤掉了。
//   这种错静态文本断言钉不住 (字面量看着完全合理), 只能把表达式本身拿出来跑。
function _singleShotTools(subAgent) {
  const base = (((subAgent && subAgent.ROLES && subAgent.ROLES.li) || {}).tools) || [];
  const out = Array.from(new Set([...base, 'weather_check', 'news_digest', 'http_check']));
  // 防御: 结果里不许混进非字符串 (嵌套数组就是从这里漏进去的)
  return out.filter(t => typeof t === 'string' && t);
}

// 答复自己承认"没做完"的措辞。窄口径, 只认明确的自认, 不碰"已完成/已交付"。
const _INCOMPLETE_ADMISSION_RE = /(尚未生成|尚未落盘|尚未写入|尚未产出|还没生成|还没有生成|没有生成|未生成|未能写入|未能生成|未能完成|未能产出|未能落盘|未完成|未产出|未落地|未落盘|未写入|没写入|未创建|没有创建|未执行|没有执行|未能执行|未成功|本次任务未完成|不能报告为|尚不能交付|无法交付|未写出|无法完成|无法写入|无法落盘|无法生成|全部未完成|未能[实真]?(?!.*(?:成功|达到))|本次未能|因此未能|没有实际|未实际|当前环境未提供|不具备.*能力|无法提供)/;
// 2026-10-13 (现场 session=pcheck-1791823545): 20 个文件全写成功、checker PASS、
// child_statuses 全 completed, 却判 partial —— 因为综合答案照抄了 analyzer 最早那句
// "未创建或修改任何文件" (它执行时是真的, 后来 executor 写完了)。
//
// 根因: 综合 prompt 只说"基于这些真实数据综合", 没把**本轮真写盘清单**立为准绳。
// 子 agent 的自述都是各自那个时点的快照, 相互之间天然会矛盾, 必须有外部锚点来对账。
// 账本在 ee2bf33 / 4ddc373 之后已是可靠真源 (含 exec_command 重定向 + 子 agent 汇总),
// 这里把它接进综合阶段。
//
// 原则: 只**呈现**权威清单, 不替模型改写子 agent 原话 —— 对账是模型的事, 我们只保证
// 它看得到真话。
function _groundTruthBlock(sessionId) {
  let paths = [];
  try { paths = require('./task_ledger').collectWrittenFiles(sessionId).map(w => String(w.path || '')).filter(Boolean); }
  catch (_) {}
  if (!paths.length) return '本轮真写盘文件 (本轮账本为准, 含各子 agent): 无';
  return '本轮真写盘文件 (本轮账本为准, 含各子 agent):\n' + paths.map(p => '- ' + p).join('\n');
}

// 2026-10-16 (现场 syn-234507 实测: final 开头是 "### executor\n\n① 完成: …" +
// "---\n\n### checker\n\n…" —— 主人看到的是将灵的内部英文代号, 不是盘古的答复):
// 注入块每段以 `agent: executor 【成功】` 开头 (见 _buildSynthesisInput 下面),
// 综合模型把**这行结构标签**当成了要输出的骨架, 原样复读成 markdown 标题。
//
// 为什么抽成常量而不是就地改: 收口 prompt 历史上被抄了**四遍** (主派发 / keyword 兜底 /
// direct-answer 兜底 / _buildSynthesisMessages), 四份措辞各不相同 —— 我只改了其中一份,
// 实机走的是另一份, 于是"改了没生效"。这类坑只能靠**唯一真源**堵, 不能靠记得改几处。
const _SYNTH_NO_ROLE_LABEL =
  '【输出形态】只对主人说话。注入块里的 `agent: executor` / `agent: checker` 这类是**内部定位锚**, '
  + '不是你要输出的内容 —— 禁止把它们 (或任何将灵代号/英文角色名) 当标题、章节名、小标题写进答复。'
  + '要说"哪一刀做的"就用中文说法 (如「执行」「复核」), 或者干脆融进正文; '
  + '答复开头第一句必须是直接回答主人问题的话。';

// ============================================================================
// 第 87 批 (2026-10-25): 交付保真 —— 综合层拿到的**料**被砍了头, 拿到的**长度**被压着
// ============================================================================
//
// ## 一、现场 (会话 probe89-fixed, 2026-10-25 实跑, 全程落盘 ~/.pangu-data/sessions/)
//
// 主人原话 (逐字):
//   「分别分析一下 apps/core/modules/llm_caller.js 和
//     apps/core/modules/j2_agent_loop.js 各自负责什么,
//     然后综合说明它们是怎么配合的」
//
// 三刀子 agent 全部 completed, 汇报字数 8440 / 8042 / 10208 (合计 26690)。
// 主人收到的最终答复: **557 字**。
//
// 丢掉的不是废话, 是子 agent **已经查实**的东西:
//   · 「定位 5 处职责重叠 + 3 处缝隙」
//   · 「接口契约三套」
//   · 「pangu-single.js:823/1822/1839/1880/1910 五处注入点同步断」
//   · 「置信度: 未确认 Anthropic 分支在 native 路径上的完整 tool_use 生命周期」
// ⇒ 主人的问题问的是「各自负责什么 + 怎么配合」, 答案里**一条实质发现都没有**。
//
// ## 二、根因有三条, 都是机制层的, 不是模型不听话
//
// ① **喂进去的料被砍头**:
//    `_buildSynthesisInput` 里 `String(summary).slice(0, budget)` ——
//    budget = `Math.min(3000, 15000 / n)`。n=3 时 **3000 这个硬顶说了算**,
//    「均分」根本没发生 (15000 的额度只用了 9000, **6000 字没用上**)。
//    砍头砍掉的正是尾巴 —— 汇报契约里「③ 未做」和「置信度」都在尾巴上。
//    ⚠ 而且同一个 `slice(0, N)` 抄在**三条综合路**上 (主路 / fixed_flow / 兜底),
//      只修一条 = 「同一个修复只打了一半」—— 这个项目最贵的一类假绿。
//
// ② **长度上限的例外条款从来没被兑现**:
//    老板 2026-08-02 拍「≤300 字, 非常啰嗦」, 那条规则**自带例外**
//    「仅当主人明确要『详细/综合/报告』时才可长」——
//    但例外**由模型自己判断要不要用**, 于是基本没被用过 (现场主人原话里
//    「分别」「综合」两个信号都在, 结果还是 557 字)。
//    ⇒ 例外改由**机制**判: 判据取**主人原话** (老板自己打的字), 不取模型散文。
//      这 20 批一直在治「拿模型的自由散文当判据」这个病, 这条判据不犯它。
//    (文案的改动在 synth_prompt.js 的 LENGTH_RULE_BREADTH —— 那边是唯一真源。)
//
// ③ **fixed_flow 那条综合路是另一套**:
//    它自己内联了一份 `slice(0, 3000)` + 总 `slice(0, 15000)`,
//    连 2026-10-22 的「排盘断言核验」都没走 (那个守卫在 `_buildSynthesisInput` 里) ——
//    同一个修复只打了一半的第二例。
//    ⇒ fixed_flow 改走 `_buildSynthesisMessages` 真源。
//
// ## 三、这一批做三件事
//
// A. `_trimKeepEnds` —— 砍料改成**留两头** (结论在头, 未做/置信度在尾)。
// B. `_synthesisBudget` —— 总量按**模型真实上下文**给, 老板那个 15000 当**下限**不当上限;
//    「均分、不许前几个吃满」这条规则一个字没改, 只是那个 3000 硬顶没了。
//    老板 2026-09-16 拍的是「均分额度」这个**规则**, 15000 是当时 32K 上下文时代的估法;
//    现在池子里 context_length 是 65536 ~ 1048576, 15000 字 ≈ 5K token, 塞得下而**料不够**。
// C. fixed_flow 改走真源 + 修 `产出: [object Object]` (派发记录里的渲染 bug)。

// ---- A. 留两头 ----
//
// 为什么要两头而不是一头: 汇报契约是「① 完成 ② 证据 ③ 未做」,
// 结论在头、**诚实项在尾** (③ 未做 / 置信度 / 未确认什么)。
// 只留头 = 把「这刀没做什么」和「这刀没确认什么」这两句最该让主人看见的话丢掉。
// 中段是证据正文, 被省掉时主人至少还拿得到「做完了什么」和「没做完什么」。
function _trimKeepEnds(text, budget) {
  const s = String(text == null ? '' : text);
  const cap = Number(budget);
  if (!Number.isFinite(cap) || cap <= 0) return s;
  if (s.length <= cap) return s;
  const headLen = Math.max(1, Math.floor(cap * 0.62));
  const tailLen = Math.max(1, cap - headLen);
  const omitted = s.length - headLen - tailLen;
  return s.slice(0, headLen)
    + '\n…【中段省略 ' + omitted + ' 字: 结论在头, 未做/置信度在尾, 两头都留着】…\n'
    + s.slice(s.length - tailLen);
}

// ---- 覆盖面需求: 判据取**主人原话** ----
//
// ⚠ 为什么不看子 agent 说什么 / 不看答案长什么样:
//   「拿模型散文当判据」正是第 83-86 批一路在治的同一个病
//   (守卫拿「这件事被提到」当「这件事发生了」)。
//   主人原话是**老板自己打的字**, 可数、可定位、不会漂 —— 它是这里唯一够格的判据。
const _BREADTH_POS_RE =
  /分别|分头|逐条|逐个|逐项|逐一|一一|每个|各个|详细|详尽|展开|完整|全面|所有|全部|对比|比较|差异|区别|梳理|列举|清单|长文|报告|深入|剖析/;
const _BREADTH_NEG_RE =
  /一句话|简要|简短|概括|提纲|要点|三句|总结一下|归纳|不展开|不要展开|别展开|无需展开|不用展开|别啰嗦|简述|一段话|简版|精简/;

// 这一轮主人要不要「覆盖面型」的答复?
// @param userInput 主人原话 (真源, 逐字)
// @returns true = 覆盖面型 (不限 300 字, 每条子任务结论都要出现)
//
// ⚠ 本文件一律用行注释, **不许写多行块注释**。
//   (斜杠紧跟星号的那对符号这里刻意不写出来 —— 它一旦出现就是一个未闭合的块注释,
//    后面的代码就对自己的结构守卫隐身了。D1 守卫管的就是这件事。)
//   原因: 全仓的结构守卫都按同一套剥法 (`/\*[\s\S]*?\*\//g` 去掉块注释)
//   剥完再数行数/数调用点 —— 块注释连着换行一起被吃掉 ⇒ 行数塌 ⇒ 守卫误报。
//   2026-10-25 实测: 第 87/89 批加的 4 段多行块注释让 D2 守卫红了 44 行。
//   这不是守卫的问题, 是「这个文件不写块注释」这条既有约定。
function _breadthDemand(userInput) {
  const q = String(userInput || '');
  if (!q) return false;
  if (_BREADTH_NEG_RE.test(q)) return false;   // 压缩型优先
  return _BREADTH_POS_RE.test(q);
}

// ---- B. 综合层的总料量 ----
//
// 老板 2026-09-16 拍的是**规则**: 「按子 agent 数量均分额度, 不许前几个吃满」。
// 这个规则一个字没改 —— 改的是「总额」这个数字, 以及那个把规则架空了的 3000 硬顶。
// 总额按**模型真实上下文**给 (registry 真源, 探不到就退回老板那个数, 绝不比它低)。
const _SYNTH_BUDGET_FLOOR = 15000;   // 老板 2026-09-16 拍的数 —— 只当下限
const _SYNTH_BUDGET_MAX = 60000;     // 封顶: 再多也不会让综合层读得更好, 只会更慢更贵

// 综合层这一轮能拿到多少料 (字)。
// @param model 当前模型
// @param n 子 agent 个数
// @param fixedChars 固定块 (system 提示 + 主人问题 + 上文 + 写盘清单) 的字数
// @returns {total, per}
function _synthesisBudget(model, n, fixedChars) {
  let ctx = 0;
  try {
    // registry 真源; 探不到就返 null → 退回老板那个下限 (fail-safe, 不 fail-loud)
    ctx = require('./model_registry').getContextLength(model && model.id) || 0;
  } catch (_) { ctx = 0; }
  let total = _SYNTH_BUDGET_FLOOR;
  if (ctx > 0) {
    // 0.35 字/token (与 pangu_helpers.estimateMessagesTokens 同一估法) + 留 4096 token 余量
    const room = Math.floor((ctx - 4096) / 0.35) - Math.max(0, Number(fixedChars) || 0);
    if (room > total) total = Math.min(_SYNTH_BUDGET_MAX, room);
  }
  const per = Math.max(1000, Math.floor(total / Math.max(1, Number(n) || 1)));
  return { total, per };
}

// 综合层的固定块 (system 提示 + 主人问题 + 上文 + 写盘清单) 有多少字。
//
// 抽成一处是因为原来三个调用点各自抄了一遍同样的加法 —— 抄三遍的代价是
// 「改了一处, 另两处没改」, 而固定块算大了算小了都会直接改变给料的空间。
//
// 第 89 批 (2026-10-25): **量真源真产物**, 不再自己加长度。
//   原来这里是从真源**外面**猜它有多长 (调真源取 .length 再加禁令的 .length)
//   —— 那是从真源外面猜: 真源哪天多一句话/少一句, 这个数字就跟着错,
//   而它错的方向是「算大了」⇒ 给料的额度被悄悄吃掉 (主人看到的还是被砍过的答案)。
//   现在直接量**真的要发出去的那两条 system 消息** (`_synthesisSystemMessages`),
//   主人问题/上文/写盘清单那一段则量**真的注入块** (`_buildSynthesisInput` 的空料版本)。
//   ⇒ 真源改了, 这个数字自动跟着改, 不用记得来改第二处。
function _synthesisFixedChars(sessionId, userInput, historyBlock) {
  const _sysChars = _synthesisSystemMessages(userInput)
    .reduce((n, m) => n + String(m.content || '').length, 0);
  // 空料版注入块 = 固定的那一段 (主人问题 + 上文 + 写盘清单 + 注入块表头)。
  // 各刀的汇报正文是**可变**的那部分, 由 perAgentBudget 管, 不该算进固定块。
  const _inputChars = _buildSynthesisInput(sessionId, userInput, historyBlock, [], 0).length;
  return _sysChars + _inputChars;
}

// 综合层的 system 消息 —— **四条路径共用这一份拼装**。
//
// 第 89 批 (2026-10-25): 为什么从「各路各拼一遍」收到这里。
//   第 87 批把 fixed_flow 并进了 `_buildSynthesisMessages` (它原来自己内联了一套,
//   连排盘断言核验都没走)。但「system 消息怎么拼」这件事当时仍是**两处**:
//   主路拼一份 (提示词一条 + 禁令一条), 关键词兜底拼另一份 (提示词与禁令**合并**成一条)。
//   ⇒ 「同一条禁令有四种挂法」这个老毛病只剩一半: 文案是一份了, **挂法**还是两份。
//   后果不是难看, 是真会出事: 哪天给禁令加一句 (或给覆盖面规则加一句),
//   两边的挂法不一样 ⇒ 有一条路径静默少拿一句话, 而这类错**测不出来**
//   (每条路径单独看都通得过)。
//
// 现在: 一处拼装 ⇒ 四条路径 (主派发 / fixed_flow / 关键词兜底 ×2)
// 拿到**逐字相同**的 system 消息。改禁令只改这一处, 四条路同时生效。
//
// 形态说明: 提示词与禁令是**两条独立的 system 消息**, 不是合并成一条 ——
//   这是第 63 批 `_buildSynthesisMessages` 原来的结构, 也在
//   tests/synth-prompt-single-20261023.test.js 的 T9 里钉着
//   (「第一条逐字等于真源, 禁令在第二条」)。保持不变。
function _synthesisSystemMessages(userInput) {
  return [
    // 覆盖面型题目 (主人原话里明写「分别/逐条/详细/全面」) 走 LENGTH_RULE_BREADTH ——
    //   那是老板 2026-08-02 那条长度规则**自己写的例外**,
    //   原来由模型自己判断要不要用, 现场 (probe89) 证明基本没用过。
    { role: 'system', content: buildSynthesisSystemPrompt({ breadthDemand: _breadthDemand(userInput) }) },
    // 只加禁令, 不改注入格式: 注入块的 `agent:` / `task:` / `结论:` 是给模型看的定位锚,
    // 抽掉反而会削弱它对"哪个结论属于哪一刀"的判断。
    { role: 'system', content: _SYNTH_NO_ROLE_LABEL },
  ];
}

function _buildSynthesisInput(sessionId, userInput, historyBlock, results, perAgentBudget) {
  const budget = perAgentBudget || 3000;
  const subBlocks = (Array.isArray(results) ? results : []).map(r => {
    const summary = (r.result && r.result.summary) || ('ERROR: ' + (r.error || 'no result'));
    const statusMark = r.error ? '【失败】' : '【成功】';
    const arts = Array.isArray(r.result && r.result.artifacts) ? r.result.artifacts : [];
    const artLine = arts.length ? '产出文件: ' + arts.map(a => a.path).join(', ') + '\n' : '';
    //
    // 2026-10-22: 合成前的最后一道排盘断言核验。
    //
    // 现场 (老板 10-21 E2E 实跑): planner 在任何工具都没跑之前就编了张盘
    //   「丁卯/己亥/丁酉/甲辰，日主丁火」+「前一刀已核实，直接采信，不得另算」,
    // 而下面这行 task: ${r.task} 把它**原样**拼进了综合 agent 的 prompt ——
    // 那正是「喂给综合 agent」的确切位置。综合 agent 拿到一张编的盘,
    // 还被告知"直接采信", 于是整份最终答复建在编的盘上。
    //
    // 为什么 runner 里那道不够: runner 核的是**派发时**的 task, 而真源
    // (前序刀的 toolHistory) 只在 DAG 有序时才有; 并行的第一刀那会儿
    // 什么都没跑过, 只能问账本。这里是**所有**刀都跑完之后,
    // 账本与各刀 toolHistory 都已就绪 —— 真源最全的一道。
    //
    // 处置与 runner 一致: 抹掉编造的断言, 不整块否掉 (那一刀可能还干了别的活)。
    let _taskText = String(r.task == null ? '' : r.task);
    try {
      const _cg = require('./chart_claim_guard');
      const _ev = _chartEvidenceFrom(results);
      const _res = _cg.check(_taskText, _ev, sessionId);
      if (_res.applicable && _res.violations.length) {
        console.warn('[dispatcher] ⚠️ 合成前核出未核实的排盘断言 (' + r.agent + '): ' + _cg.describe(_res));
        _taskText = _cg.sanitizeTaskText(_taskText, _res);
      }
    } catch (e) {
      console.warn('[dispatcher] 排盘断言守卫异常 (不影响合成): ' + e.message);
    }
    // 第 87 批: 砍料改成**留两头** —— 原来 `slice(0, budget)` 只留头,
    // 汇报契约里的「③ 未做」和「置信度」全在尾巴上, 砍头就等于把它们扔了。
    return `agent: ${r.agent} ${statusMark}\ntask: ${_taskText}\n结论:\n${_trimKeepEnds(summary, budget)}\n${artLine}`;
  }).join('\n---\n');
  return `主人问题：${userInput}\n\n${historyBlock || ''}\n${_groundTruthBlock(sessionId)}\n`
    + `\n子任务工具执行结果 (含成功/失败标记, 失败任务不许当已完成汇报; 各子 agent 自述是**各自那个时点**的快照, 相互可能矛盾 —— 一律以上面的真写盘清单为准绳):\n${subBlocks}`;
}

function _buildSynthesisMessages(sessionId, userInput, historyBlock, results, perAgentBudget, images) {
  return [
    // 第 89 批 (2026-10-25): system 消息**一律**走唯一拼装点 `_synthesisSystemMessages`。
    //   原来这里自己内联拼了「提示词」+「禁令」两条, 而关键词兜底那条路拼的是**另一种形态**
    //   (提示词与禁令**合并**成一条) ⇒ 「同一条禁令两种挂法」。
    //   两种挂法都能把话送到模型面前, 但「改禁令只改一处」这件事做不到:
    //   哪天给禁令加一句, 有一条路径会静默少拿一句, 而每条路径单独看都通得过 ⇒ 测不出来。
    //   现在四条路径 (主派发 / fixed_flow / 关键词兜底×2) 拿到**逐字相同**的 system 消息。
    //   第 63 批的「事实在前」、第 87 批的覆盖面档都还在真源里, 一字没丢 ——
    //   变的只是「谁去拼」, 不是「拼什么」。
    ..._synthesisSystemMessages(userInput),
    // 2026-10-12: 综合 LLM 也挂上本会话的图 — 追问轮主人不再附图, 没这层综合就只能凭转述定稿。
    //   第 87 批: 这个 `images` 之前**只有 fixed_flow 那条路有**, 主路没有 ——
    //   「同一个修复只打了一半」的第三例。现在两条路都走这里, 谁都别再单独加。
    { role: 'user', content: _buildSynthesisInput(sessionId, userInput, historyBlock, results, perAgentBudget), ...(images && images.length ? { images } : {}) },
  ];
}

// 第 65 批: 关键词兜底那两条路的**汇报优先**摘要 (原来在 dispatcher 里一字不差地抄了两遍, 752 字符)。
//
// 为什么是「汇报在前, 工具证据在后」(2026-10-16 现场 syn-234507 老板拍「子 agent 要做好汇报」):
//   旧码这里优先用原始 toolHistory, 只有一条工具都没调时才回退到 summary ——
//   也就是**只要子 agent 干了活, 它写的汇报就被丢掉**, 父 agent 拿着同一批工具 JSON 再推一遍结论。
//   父没有子的一手判断 (②证据/③未做), 重新推就是重新猜, 而且更贵。
//   改成: 汇报在前 (父先读结论), 工具证据在后 (结论可疑时才翻)。
//
// 跟 _buildSynthesisInput 的差别是**有意的**: 那条是主路径, 带状态标记/产出文件/排盘断言核验;
//   这条是兜底路径, 轻量且不重复实现一遍排盘守卫。两边别合并 —— 合并就成了「一份抄两份」的老毛病。
function _buildFallbackSummaries(results, perAgentBudget) {
  // 第 87 批: 每刀的额度做成参数 (原来写死 1500, 且和主路那个 3000 硬顶各算各的)。
  const _fbBudget = Number(perAgentBudget) > 0 ? Number(perAgentBudget) : 1500;
  return (Array.isArray(results) ? results : []).map(r => {
    const summary = (r.result && (r.result.summary || r.result.finalText)) || '';
    const history = (r.result && r.result.data && r.result.data.toolHistory) || [];
    const parts = history.map(h => {
      if (!h.ok) return `[${h.name}] ERROR: ${h.error}`;
      const resultStr = JSON.stringify(h.result).slice(0, 800);
      return `[${h.name}] ${resultStr}`;
    });
    const head = 'agent: ' + r.agent + '\ntask: ' + r.task + '\n汇报:\n'
      // 第 87 批: 兜底路也留两头 (原来 `slice(0, 1500)` 抄的是主路那个砍头的写法)
      + _trimKeepEnds(summary || '(子 agent 没交汇报, 别替它补 —— 按下面的工具证据说话)', _fbBudget);
    const tail = parts.length ? ('\n工具证据(汇报可疑时才查):\n' + parts.join('\n')) : '';
    return head + tail + '\n';
  }).join('\n---\n');
}

// 2026-10-13 (soak-live-1791879822 现场): 验收 agent 的 FAIL 原话是**转述**, 不是规格 ——
// 它把主人要的 `04_data.csv` 在报告里写成「04_*.md」, 补救 agent 照这句建出了 04_data.md
// (目录多一个文件), 而且补救报告里的字节数全是编的 (报 60B/38B, 盘上实际 63B/55B)。
// 原来这里还只带 userInput.slice(0, 400) —— 8 份文件的规格正好落在 400 字之后, 全被砍掉。
// 改: 主人原话当真源**全量**带下去 (超长才截断并明说), 验收原话降级成线索; 数字只许回读取证。
function _buildRemedyTask(round, failSummary, userInput) {
  const _ask = String(_stripGuaBlockForRouting(userInput) || '');
  const _cap = 8000;
  const _spec = _ask.length > _cap
    ? _ask.slice(0, _cap) + '\n…【主人原话超长, 已截断到 ' + _cap + ' 字; 你要补的规格若落在截断之后, '
      + '去原始出处 (主人给的文件/路径) 取, 取不到就如实说缺什么, 不许编】'
    : _ask;
  return '【验收补救 · 第' + round + '轮】验收 agent 判定任务未通过, 它的原话: 「'
    + String(failSummary || '').slice(0, 1200) + '」\n'
    + '【真源顺序】主人原话 = 真源; 上面那段验收原话**只是线索, 不许照抄** —— 验收 agent 会把文件名/规格'
    + '转述错 (实测: 主人要 04_data.csv, 它写成 04_*.md, 你照抄就多建一个 04_data.md)。'
    + '文件名、内容、大小一律回下面主人原话逐字取。\n'
    + '【报告纪律】只许写你**亲眼 cat 回读**到的内容与字节数; 没回读过的文件不许写进报告, 数字不许凭印象。\n'
    + '请直接动手补齐 (写盘/执行), 不要再分析规划。\n'
    + '【主人原话 — 真源】' + _spec;
}

function _answerAdmitsIncomplete(text) {
  const t = String(text || '');
  if (!t) return false;
  // 2026-10-25 (第 83 批, 现场 probe82-real-split): **判据问错了问题**, 第 4 次修同一个病。
  //
  // 现场 (会话 probe82-real-split, 落盘 ~/.pangu-data/sessions/probe82-real-split.json):
  //   题目「分别分析 llm_caller.js 和 j2_agent_loop.js 各自负责什么, 然后综合说明怎么配合」
  //   → 主 agent 自拆 3 刀 (li/li/li) → 3 刀全部交卷 → 综合层写出**完整综合正文**
  //   → 主人收到 `state:"partial"` / `success:false`, 答复是三段 `### li` 原文拼接
  //     (每段截断 2000 字, 末尾断在半句)。
  // stderr 唯一两行:
  //   [dispatcher] 答复自认未完成 → 收口标 partial
  //   [dispatcher] 收口 partial: acceptance_failed=false admits=true unknown_acceptance=false
  // ⇒ acceptance_failed=false (这轮没排验收刀) + unknown_acceptance=false (同上)
  // ⇒ partial 的**唯一**来源是 admits=true。
  //
  // 把那份答复 (6038 字) 原样喂判据, 命中 3 处:
  //   ① L50 `| _objectiveWorkRemaining / … | 客观未完成判定、终局文案 |`  ← NEW 词表「未完成」
  //   ② L40 `…并挂满守卫（复读熔断、重复调用拦截、…）`                      ← OLD 词表「熔断」
  //   ③ L74 `- 超时/熔断：`_prefillMs`(L115)/…`                            ← OLD 词表「熔断」
  // 三处**没有一处**是盘古在承认「这一轮没干完」:
  //   ① 是子 agent 在**描述 j2_agent_loop.js 的一个函数** (那函数的注释就叫「客观未完成判定」);
  //   ② 是在**列举盘古自己的守卫机制名** (复读熔断 = 重复读的保护);
  //   ③ 是**斜杠复合类别名** (超时/熔断 是两类机制, 不是谓语)。
  //
  // 为什么这是**第四次**修同一个病 (前三次都修在症状层):
  //   · 2026-10-12 (pcheck-1791823545): 20 个文件全写成功、checker PASS, 却因答案照抄
  //     analyzer 最早那句「未创建或修改任何文件」判 partial → 修法 = 加**账本对账**
  //     _reconcileWithLedger。只治「答案与账本矛盾」这一类, 其余照旧。
  //   · 2026-10-16 (lt-after-221121): 3 刀全交卷、兑 PASS, 却因各刀「③ 未做: 未执行相关测试」
  //     判 partial → 修法 = 加**验收刀豁免** _acceptanceOverridesAdmission。
  //   · 2026-10-25 (本批, 上游): 3 刀全交卷, 综合稿被判跑题 → 回落子 agent 原文拼接 →
  //     拼接里全是子 agent 的原话 → 又被词表扫中。修法 = 改**对齐门** (在 answer_alignment.js)。
  //   三次都是「**再加一个豁免函数**」: 豁免加得越多, 洞越多。
  //
  // 根因不是词表太宽, 是**判据问错了问题**:
  //   「答复里有没有『未完成』这三个字」 ≠ 「盘古有没有承认这一轮没做完」。
  // 答复是一份**报告**, 报告必然包含**被描述的对象** —— 代码标识符、功能注释、
  // 引用的子 agent 汇报。那些是**引文**, 不是自述。
  //
  // 同一个项目里另外两处判据早就是对的, 收口这条用了最松的一套:
  //   · runtime_verdict.js `selfDeclaredFail` = /^\s*[#>*\s]*(未完成|没完成|…)/  ← **句首锚定**
  //   · summary_completion.js `lexicalIsPartial` = 先定位「③ 未做」栏 → 判有没有**划界**
  //     → **整栏摘掉**再扫                                                       ← **分层剥离**
  // summary_completion.js 里那套「剥壳, 不放宽判据」的手法**早就在项目里了**,
  // 只是**没接到收口这条路**。
  //
  // 修法 (两道, 都落代码, 不靠注释):
  //   ① **分层剥离** (沿用 summary_completion.js 已验证的手法): 把答复里**引文**的部分摘掉 ——
  //      markdown 表格行 (代码分析报告的表格 = 被描述的对象)、
  //      将灵汇报块标题行 + 汇报契约四栏 (子 agent 的原话转述)、
  //      行内代码 (标识符与路径)。
  //      **一次摘一整块, 不做半剥** —— 半剥会留下孤儿标点, 而且剥到最后命中点还在。
  //   ② **主语锚定**: 剩下的**主体**上, 自认必须**以自认词开头**
  //      (对齐 runtime_verdict.js 已有的句首锚定口径), 或者前面有「结论/因此/所以」
  //      这类总结连接词 —— 这才是「盘古在陈述自己这轮没做完」的形态。
  //
  // ⚠ 词表**一个字都不放宽** —— `_INCOMPLETE_ADMISSION_RE` 原样保留, 「③ 未做」那类
  //   措辞**仍然会被扫成自认未完成** (tests/subagent-no-sibling-reread-20261016.test.js T7
  //   明确钉住这条前提: 不许靠把正则改松来"解决"问题)。真缺口的处理在**判定层**
  //   (验收刀豁免 / 账本对账), 那两条一行都不动。
  //   10-12 那批真阳性 (「结论：本次任务未完成，不能报告为全量索引。」等) 也一条不许挂。
  const s = _stripQuotedMaterial(t);
  // 已经被别处判过失败的措辞也算 (沿用旧正则, 不重复维护两份)
  if (_admitsByPredicate(s, _ADMITS_OLD_RE)) return true;
  return _admitsByPredicate(s, _INCOMPLETE_ADMISSION_RE);
}

// 旧词表 —— 沿用 2026-10-12 的原正则, **一个字未改**。
//   单独抽成常量是因为下面两条判据 (剥壳 / 锚定) 都要用它, 抄两份 = 以后必然改漏一处。
const _ADMITS_OLD_RE = /未通过|未核验|请重试|熔断|不通过/;

// ─────────────────────────────────────────────────────────────────────────────
// 主语锚定 —— 「自认词是不是在当谓语」。
//
// 剥壳之后还剩最后一个误伤点 (现场 probe82-real-split 的 6038 字答复):
//   「- 超时/熔断：`_prefillMs`(L115)/`_streamIdleMs`(L90)/…」
// 「熔断」在这里是**斜杠复合类别名**的后半截 —— 「超时/熔断」是两类机制的**并称**,
// 冒号后面跟的是机制解释。它不是「熔断了」。
// 这类形态剥不掉 (不在括号里、不在行内代码里、不是表格行), 只能靠**主语归属**判。
//
// 形态上的区别 (对照 10-12 那批真阳性, 逐条比对):
//   真阳性 —— 自认词**自己当谓语**, 主语是这一轮的**交付物**:
//     「索引文件 /tmp/x.md 也**未生成**。」        ← 主语 = 索引文件
//     「结论：本次任务**未完成**，不能报告为全量索引。」
//     「该文件**未落地**，无法完成后续步骤。」
//     「报告**未写出**，无法交付。」
//   误伤   —— 自认词是**被列举的名词/类别名**, 不是谓语:
//     「- 超时/熔断：…」
//     「…挂满守卫（复读**熔断**、重复调用拦截、…）」  ← 这条已被括号清单剥掉
//
// 判据: 自认词**前面**不能是「X/Y」这种复合名的后半截 —— 即自认词的前一个字
// 不能是斜杠 / 全角斜杠 / 顿号 / 连字符 (那说明它是某个复合词的一部分)。
// 这是**形态**判断, 不是词表枚举: 复合类别名的形态就那几种连接符。
//
// 为什么不用「句首锚定」(runtime_verdict.js 那套):
//   10-12 那批真阳性**没有一条**是句首开始的 (「索引文件…也未生成」在句中),
//   句首锚定会把它们全部放走 —— 那比误伤更坏 (真缺口被放过 = 虚报完成)。
//   这里要的是「自认词是谓语」, 不是「自认词在句首」。
const _COMPOUND_PREFIX_RE = /[/／、,，·\-—–_]\s*$/;

// 形态判断 (第三道, 2026-10-25 第 84 批 c): 自认词后面紧跟**代码引用锚点**
// ⇒ 它是被列举的**名词** (机制名 / 条目名), 不是谓语。
//
// 现场 (会话 probe83b-fixed, 主人收到 5998 字的子 agent 原文拼接):
//   `- SSE 解析 _parseSSEBody L1530; … 两段空闲预算 prefill/idle L2129-2152, 总时长熔断 L2171; …`
//   `… task_done 被验收后 break(L3046-3089)、FOUNTAIN 熔断 break(L2775)、…`
// 两处「熔断」都是**机制名** (「总时长熔断」「FOUNTAIN 熔断」= 一个保护器),
// 后面跟的是**代码引用** (行号 L2171 / 语句 break(L2775)) —— 不是「这一轮熔断了」。
//
// 对照真阳性 (10-12 那批, 一条都不许放走):
//   「索引文件 /tmp/x.md 也未生成。」  ← 后面是句末标点
//   「报告未写出，无法交付。」       ← 后面是逗号
//   「子任务熔断了」                ← 后面是句末
// ⇒ 只在「后面紧跟代码引用锚点」这一种形态下排除; 其余形态**一律照咬**。
// 词表一个字没动 —— 这是**形态**判断, 和上面 _COMPOUND_PREFIX_RE 同一把尺子。
//
// 为什么不用「熔断后面必须跟了」来收窄:
//   · 「子任务熔断了」是钉死的真阳性, 但「熔断失败」「熔断后未恢复」也是谓语用法
//     (后面跟的是别的词), 只认「了」会把真缺口放过 —— 漏咬比误咬更坏。
//   · 收窄词表违反本批的硬约束 (词表一个字不许放宽); 形态判断不碰词表。
const _CODE_CITATION_AFTER_RE = /^\s*(?:L\d+|[A-Za-z_$][\w$]*\s*\()/;

// ─────────────────────────────────────────────────────────────────────────────
// 「熔断」是两份词表里**唯一**的名/动同形词 (第 85 批 b)
//
//   谓语 (这一轮真出事了): 「子任务熔断了」「被熔断。」「本轮熔断。」
//   名词 (在描述盘古自己的机制): 「熔断守卫」「触发熔断。」「跨轮熔断。」「总时长熔断 L2171」
//
// 现场 (2026-10-25, 会话 probe85-fixed 的最终答复 2927 字, 逐字取证):
//   「…权限沙箱、熔断守卫、记忆落盘和最终收口。」  ← 顿号前缀, 复合名前缀规则已挡
//   「…达到轮数上限或触发熔断。」                  ← 触发 + 熔断 (宾语)
//   「J2 又有超时、跨轮熔断。」                    ← 修饰语 + 熔断
// 三处都在**描述盘古自己的机制**, 不是在承认「这一轮熔断了」。
// 老判据扫全文 ⇒ 命中 ⇒ 一份好答案被判 partial (徽章误报, 和徽章撒谎一样有害)。
//
// 形态判据 (只对「熔断」这一个词生效, 别的词一个字都不动):
//   前面是 CJK 字 + 后面是**句末标点/文本结尾** ⇒ 它是机制名, 不是谓语
//   (「触发熔断。」「跨轮熔断。」「熔断守卫。」都落这一侧)
//
// 两种例外, 一律当谓语照咬:
//   ① 前面是**被动/使动标记** (被/让/使/遭)  → 「被熔断。」= 这一轮被熔断了
//   ② 前面是**自指词** (本轮/本次/这次/这一轮/子任务/任务/该) → 指这一轮的活
//
// ⚠ 已知取舍 (写在这儿, 别装作没有): 「任务熔断。」这种
//   (主语 + 动词 + 句末, 既没有「了」也没有自指词) 会被放过。
//   盘古的自认更常用「熔断了」「被熔断」; 而机制描述是**满篇都是**的。
//   放过这一种, 比把好答案全打成 partial 划算。
//   漏咬的下游还有一道: 账本对账 (_reconcileWithLedger) + 验收刀。
const _MECHANISM_NOUN_WORD = '熔断';
const _CLAUSE_TAIL_RE = /^\s*(?:[。！？；，、]|$)/;
const _PASSIVE_MARKER_RE = /(?:被|让|使|遭|受)$/;
const _SELF_REF_RE = /(?:本轮|本次|此次|这次|这一轮|子任务|任务|该|此)$/;
const _CJK_BEFORE_RE = /[一-鿿]$/;
// 第 95 批 (2026-10-25): 条件/时间状语标记 —— 自认词紧跟这些字 ⇒ 它在条件从句里。
//   现场: 「- 最后一轮未完成时，可自动续跑，L4364」← 机制的条件描述, 不是自认。
//   词表一个字没动 —— 这是**形态**判断 (只看紧跟的几个字), 和 _COMPOUND_PREFIX_RE 同一把尺子。
const _CONDITIONAL_AFTER_RE = /^(?:时|的话|时候)/;
// 第 95 批 (2026-10-25): markdown 的**结构分界**也是句末 ——
//   空行 / 标题 / 下一个列表项 / 下一个有序列表项 / 文本结束。
//   「这一条到这儿就完了」⇒ 后面的话不在这一句里。
//   只作用在「熔断」上 (熔断是唯一的名/动同形词, 本来就有专门的机制名判定),
//   不碰其他词 ⇒ 「索引文件未生成」这类真缺口不会被放走。
const _STRUCT_BREAK_AFTER_RE = /^(?:\s*\n\s*\n|\s*\n\s*(?:[-*+>#]|\d+[.)、])|\s*$)/;
// 「熔断X」这种复合**机制名**的后半截 —— X 得是"部件/机制"类名词。
//   机制名 (名词): 熔断守卫 / 熔断机制 / 熔断保护 / 熔断阈值
//   谓语带补语 (不是机制名): 熔断失败 / 熔断恢复 / 熔断后
// 这张表只列**机制名的后缀**, 不碰自认词表 (词表一个字都不许放宽)。
const _MECHANISM_HEAD_NOUN_RE = /^(?:守卫|机制|策略|保护|阈值|开关|限制|逻辑|器|部件|规则|计数|状态|策略表)/;

function _isMechanismNounUsage(before, after) {
  const b = String(before || '');
  const a = String(after || '');
  // N1: 后面是代码引用锚点 (总时长熔断 L2171)
  if (_CODE_CITATION_AFTER_RE.test(a)) return true;
  // 被动/使动标记 → 谓语 (「被熔断。」)
  if (_PASSIVE_MARKER_RE.test(b)) return false;
  // 自指词 → 谓语 (「本轮熔断。」「子任务熔断。」)
  if (_SELF_REF_RE.test(b)) return false;
  // N2: 「熔断X」, X 是机制名的一部分 (熔断守卫) ⇒ 它在修饰后面的名词
  if (_MECHANISM_HEAD_NOUN_RE.test(a)) return true;
  // 前面没有 CJK 字 → 它自己就是句子的主语/谓语 (「熔断失败。」这种)
  if (!_CJK_BEFORE_RE.test(b)) return false;
  // N3: 后面不是句末 ⇒ 它在带宾语/补语, 是谓语 (「跨轮熔断失败。」)
  //
  // 第 95 批 (2026-10-25, 现场 probe93-fixed 的 7083 字真综合稿):
  // 「句末」不能只看标点 —— markdown 的**结构分界**也是句末。
  //   现场逐字: 「- 预算不足时尝试压缩续命，压缩无效才熔断」← 后面紧跟 "\n\n### 4. …"
  //   这一条是**机制政策**的描述 (压缩失败才熔断), 不是「这一轮熔断了」的自认。
  //   旧判据把"换行"当成"带宾语的谓语" ⇒ 误伤。
  //   只多认一种「句末」形态, 词表一个字没动, 其他词不受影响。
  if (!_CLAUSE_TAIL_RE.test(a) && !_STRUCT_BREAK_AFTER_RE.test(a)) return false;
  return true;
}

function _admitsByPredicate(text, wordRe) {
  const s = String(text || '');
  if (!s) return false;
  const re = new RegExp(wordRe.source, wordRe.flags.includes('g') ? wordRe.flags : wordRe.flags + 'g');
  let m;
  while ((m = re.exec(s))) {
    const at = m.index;
    const before = s.slice(0, at);
    // 自认词前面紧挨着连接符 ⇒ 它是**复合名的一部分** (「超时/熔断」的后半截), 不算自认。
    if (_COMPOUND_PREFIX_RE.test(before)) continue;
    // 自认词前面是**行内代码的尾巴**或**引文结束符** —— 说明它在被描述, 不在自述。
    //   (剥壳后行内代码已摘, 但 `` `code` `` 的反引号可能还在跨行残留)
    if (/[`"')\]】》」』]\s*$/.test(before)) continue;
    // 自认词后面紧跟**代码引用锚点** ⇒ 它是机制名, 不是谓语 (「总时长熔断 L2171」)。
    //   (这条对所有词生效; 熔断 自己的机制名形态见 _isMechanismNounUsage)
    const after = s.slice(at + m[0].length);
    if (_CODE_CITATION_AFTER_RE.test(after)) continue;
    // ─────────────────────────────────────────────────────────────────────
    // 第 95 批 (2026-10-25, 现场 probe93-fixed 的 7083 字真综合稿):
    // 自认词后面紧跟**条件/时间状语** ⇒ 它在条件从句里, 描述的是
    // 「什么情况下会怎样」, 不是对**这一轮的交付物**的陈述。
    //
    // 现场逐字 (剥壳后):
    //   「- 最后一轮未完成时， 可自动续跑，L4364」
    // 「未完成」在这儿是**机制的条件描述** (最后一轮没跑完时会自动续跑),
    // 不是盘古在说「这一轮没做完」。
    //
    // 形态判据, 不是词表枚举: 只看自认词**紧跟**的那几个字。
    // 10-12 那批真阳性一条都不含这种形态 (全部以 。/， 收尾) ⇒ 一条不许挂的前提不破:
    //   「索引文件 /tmp/x.md 也未生成。」        ← 后面是 。
    //   「结论：本次任务未完成，不能报告为…」   ← 后面是 ，
    //   「报告未写出，无法交付。」              ← 后面是 ，
    if (_CONDITIONAL_AFTER_RE.test(after)) continue;
    // 第 85 批 b: 「熔断」的名词形态 (机制名) 不是自认 —— 见 _isMechanismNounUsage 的注释。
    if (m[0] === _MECHANISM_NOUN_WORD && _isMechanismNounUsage(before, after)) continue;
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 剥壳: 把答复里的**引文**摘掉, 只留盘古自己的话。
//
// 为什么是「整块摘」而不是「逐个词形打补丁」:
//   前一版 (本批早期草稿) 试过按词形加壳 —— 剥表格行 / 剥将灵标题 / 剥行内代码 /
//   剥括号清单。实测:
//     · 剥壳**顺序**有讲究, 半剥会产生孤儿标点 (摘掉括号里的一项, 留下孤儿「、」);
//     · 剥到最后一层, 「超时/熔断」这种**斜杠复合类别名**剥不掉 (它不在括号里,
//       也不在行内代码里, 是「超时」和「熔断」两个词用斜杠拼起来的**类别名**);
//     · 每加一层壳, 就多一条「这个形态没被想到」的风险 —— 而 2026-10-12/10-16
//       两次翻车都是因为「按想象写词表」栽的。
//   换思路: 剥壳只做**结构级**的整块摘除 (表格行 / 汇报块 / 行内代码),
//   剩下靠**主语锚定**收口 —— 那是形态判断, 不是形态枚举。
//
// (a) markdown 表格行。
//   为什么表格整行都摘: 分析类任务的答复主体就是一张张「导出函数 | 行号 | 作用」表,
//   表格格里几乎必然出现描述被分析对象的措辞。而**真自认不会写在表格里** ——
//   真自认是散文的结论句, 不该在结构化表格里 (表格是"列事实", 结论是"下判断")。
const _TABLE_ROW_RE = /^[ \t]*\|.*$/gm;

// (b) 将灵汇报块 —— `### li` / `### 离` 这种行开头的段落。
//   综合层把子 agent 汇报**逐字抄进**答复时, 会连 `### <代号>` 标题一起抄 (现场实测:
//   答复开头就是 `### li\n\n① 完成: 读完并核实 …`)。那一段是**子 agent 的原话**,
//   不是综合层对整轮的自述。
//   注意只摘**代号标题行**, 不摘整段 —— 段里可能混着综合层自己的话, 整段摘掉会漏真自认。
//   这里摘的是「以代号标题起头的那一行」以及它引用的**汇报契约四栏**
//   (① 完成 / ② 证据 / ③ 未做 / ④ 交接) —— 那四栏是子 agent 汇报的固定结构。
const _AGENT_BLOCK_HEAD_RE = /^[ \t]*#{2,6}[ \t]*(li|kun|dui|xun|zhen|gen|kan|qian|离|坤|兑|巽|震|艮|坎|乾)[ \t]*[:：]?[ \t]*$/gm;
const _REPORT_FIELD_LINE_RE = /^[ \t]*[①②③④1-4][ \t]?[.、)）]?[ \t]*(完成|证据|未做|交接)[ \t]*[:：]/gm;

// (c) 行内代码 `` `...` `` —— 标识符/路径/行号引用。
const _INLINE_CODE_RE = /`[^`\n]*`/g;

// (d) **括号里的顿号清单** —— 被列举的**机制名 / 条目名**。
//
//   现场 (同一份 6038 字答复, 第二个误伤点):
//     「……并挂满守卫（复读熔断、重复调用拦截、承诺气泡 nudge、核验门、断点续跑、
//       自动压缩、终局防谎报）。」
//   「复读熔断」是**盘古自己的守卫机制的名字** (复读 = duplicate read)，
//   不是「熔断了」—— 子 agent 在**介绍盘古有哪些防线**。
//   形态上的区别很硬: 清单项是**被列举的名词**, 不是谓语。
//
//   为什么摘**整个括号**而不是只摘那一个词:
//     清单里每个词都有同样的性质 ——「未核验」「请重试」「未通过」出现在清单里
//     也是在**列举机制名**, 逐个词打补丁就是词表补不完的老路。整块摘掉,
//     判据只管**盘古自己的话**。
//
//   边界: 只摘**成对**的括号/书名号里、且**含顿号**的清单 (≥2 项)。
//   单项括号 (「（按指令不扩展）」) 不摘 —— 那是真正的免责从句, 摘了就放走真缺口。
//
//   ⚠ 实现上是**扫描**而不是一条大正则: 现场那句前面还有一层括号
//   (`**agent 主循环（orchestration 层）**——…挂满守卫（复读熔断、…）`),
//   单条正则从最左的 `（` 起匹配会因为**排除 `）`**而跨不过去, 整条失配。
//   所以: 逐个字符扫, 找**最浅成对括号**里的顿号清单。
function _stripBracketedLists(text) {
  const s = String(text || '');
  const OPEN = '（(【[';
  const CLOSE = '）)】]';
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (OPEN.indexOf(ch) >= 0) {
      // 找配对的收括号 (允许一层嵌套)
      let depth = 0;
      let end = -1;
      for (let k = i; k < s.length; k++) {
        const c = s[k];
        if (OPEN.indexOf(c) >= 0) depth++;
        else if (CLOSE.indexOf(c) >= 0) {
          depth--;
          if (depth === 0) { end = k; break; }
        }
      }
      if (end > i) {
        const seg = s.slice(i, end + 1);
        const inner = seg.slice(1, -1);
        // 清单 = 括号里含顿号, 且**不是**嵌套括号里的 (只看这一层)
        const hasList = inner.indexOf('、') >= 0;
        if (hasList) { i = end + 1; continue; }   // 整块摘掉
        out += seg;
        i = end + 1;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// 剥壳: 把答复里的**引文**摘掉, 只留盘古自己的话。
function _stripQuotedMaterial(t) {
  let out = String(t || '');
  // (a) 表格行
  out = out.replace(_TABLE_ROW_RE, '');
  // (b) 将灵汇报块的标题行 + 汇报契约四栏
  //     —— 只摘这些**行**, 段落里综合层自己的话留着 (整段摘会漏真自认)。
  out = out.replace(_AGENT_BLOCK_HEAD_RE, '');
  out = out.replace(_REPORT_FIELD_LINE_RE, '');
  // (c) 行内代码
  out = out.replace(_INLINE_CODE_RE, '');
  // (d) 被列举的清单项 (机制名 / 条目名)
  out = _stripBracketedLists(out);
  return out;
}

// 2026-10-16 (现场 lt-after-221121): 验收刀 PASS 时, 答案正文里的免责从句无权翻案。
//
// 「分工范围内没做」和「任务没做完」是两件事, 但 _INCOMPLETE_ADMISSION_RE 分不开 ——
// 它认「未执行」「未创建」「未产出」这些裸子词, 而汇报契约要求的「③ 未做」栏在
 // 分工制下必然非空 (每个离都只读自己那一个文件)。于是干得最规矩的刀被判失败,
 // 主人看到「跑了两分多钟, 失败了」。
 //
// 口径交给**独立验收刀**: 它读的就是这些汇报, 它的结论才是最终依据。
 // 没有验收刀 (或验收刀 FAIL / unknown) 时保持原语义, 一行都不放宽 —— 长任务里
 // 那种"三个刀都交卷但活真没干完"仍然会被标 partial。
function _acceptanceOverridesAdmission(results, acceptanceFailed, unknownAcceptance) {
  if (acceptanceFailed || unknownAcceptance) return false;
  const list = Array.isArray(results) ? results : [];
  return list.some(r => /checker|验收/.test(String((r && r.agent) || '')));
}

const _CHECKER_FAIL_RE = /验收\s*FAIL|验收未通过|验收不通过|验收.*不[通过]|FAIL[ —:：]|未通过|不通过|未(完成|通过)\s*[\)\]》。]|⚠️\s*\[盘古/i;

// 2026-10-13 (真实会话 ar2-0007/ar2-0009 取证): 上面这个正则对 checker 整段文本做
// 子串扫描, **两个方向都错**:
//   漏判真FAIL(更严重): `FAIL[ —:：]` 要求 FAIL 紧跟空格/破折号/冒号, 而 checker 实际
//     输出几乎都用 markdown 强调, FAIL 后面跟的是 `*`:
//       "**最终验收结论：FAIL** …"  "**结论: FAIL**(复验第2轮)" → 判 PASS ❌
//     实测 4 个 checker 里 2 个是这个形态, 其中 sub-3 开篇写着"最终验收结论：FAIL"
//     却没被补救循环捕获 —— 等于把验收失败的轮次当成通过放行。
//   误判PASS为FAIL(白烧两轮): 裸子串 `未通过` 命中"否定的否定":
//       "PASS: 5 个文件全部存在, 无未通过项。" → 判 FAIL ❌
//     于是本该一轮做完的活被判失败, 触发最多 2 轮补救重做(ar2-0009 实测白烧 2 轮)。
//
// 修: checker 输出**有明确结论**, 应该读结论而不是满篇扫失败词。三级判定:
//   ① 带标签的结论 (结论/判定/验收/核验/复验/结果/verdict + FAIL/PASS/通过/…);
//   ② 开头首个结论词 (markdown 强调剥掉后, 取最靠前的结论词定夺);
//   ③ 都没有 → 退回 _CHECKER_FAIL_RE 扫全文(兜底, 保持旧能力不放宽)。
// 注意 FAIL 类词必须排在 PASS 类词前面: `不通过` 内含 `通过`, 交替顺序错了会反向误判。
const _VERDICT_FAIL_TOK = 'FAIL|不通过|未通过|不达标|不合格|失败|未通过验收|未通过校验';
const _VERDICT_PASS_TOK = 'PASS|通过|成功|合格|达标|OK';
const _VERDICT_ANY_RE = new RegExp('(' + _VERDICT_FAIL_TOK + '|' + _VERDICT_PASS_TOK + ')', 'i');
const _VERDICT_LABELED_RE = new RegExp(
  '(?:最终)?(?:验收|核验|验证|复验)?\\s*(?:结论|判定|结果|状态|verdict)\\s*[:：]?\\s*\\**\\s*'
  + '(' + _VERDICT_FAIL_TOK + '|' + _VERDICT_PASS_TOK + ')', 'i');
const _VERDICT_HEAD_LEN = 160;
// checker 说 PASS 时最常见的两种壳: 「无未通过项」「没有发现差异」。老码把它们当失败词
// 扫到 —— 判成 FAIL → 白触发最多 2 轮补救 (executor 重做 + checker 复验 = 4 次额外
// LLM 调用, 本地 27B 每次 ~60s)。所以扫之前先把"否定式失败陈述"摘掉。
// 只摘有明确否定前缀的, 「验收 FAIL」「未通过」这种裸失败陈述一个都不动。
const _NEGATED_FAIL_RE = /(?:无|没有|不存在|不含|未发现|未见|未出现|没有发现|0|零)\s*(?:任何|一个|一处|一项|半点)?\s*(?:未通过|不通过|未完成|未达成|未达标|不合格|不达标|失败项|失败|错误项|错误|差异|问题|异常|缺失|遗漏)/g;

function _verdictOfChecker(summary) {
  const raw = String(summary || '');
  if (!raw.trim()) return 'unknown';
  // 2026-10-16 (lt3 现场): 这一刀压根没跑起来 —— 端点 ECONNRESET, 它一个字都没验。
  // 老码走兜底 ③ 全文扫失败词, 扫不到就 return 'pass' —— 于是"没验"被记成"验过了",
  // 整轮收一个 success:true。这比报 partial 更坏: partial 用户会去看, 假 pass 用户不会。
  // 死掉的切片一律 unknown, 收口层再决定怎么如实说 (见 _unknownAcceptance)。
  // 2026-10-25 (第 84 批): 死法判定改成「只认**头部**的机器报错文案」。
  //   原来这里扫**全文** —— 验收刀在汇报里**提到** llm_caller 的超时错误名
  //   (那把刀的任务就是验超时处理), 就被当成「这一刀撞上了超时」⇒ 裁决记 unknown
  //   ⇒ 白白把一轮好验收降级成「没验成」。判据真源在 modules/slice_death.js。
  if (_isDeadReport(raw)) return 'unknown';
  // 剥 markdown 装饰, 让 **FAIL** / ## 标题 / `代码` 里的结论词能被正常识别。
  // 再把「无未通过项」这类否定式失败陈述摘掉 (见 _NEGATED_FAIL_RE 注释)。
  const t = raw.replace(/[*#`>_]/g, '').replace(_NEGATED_FAIL_RE, '');
  // ① 带标签的结论优先 —— 它是 checker 最明确的表态。
  const lab = t.match(_VERDICT_LABELED_RE);
  if (lab) return new RegExp('^(?:' + _VERDICT_FAIL_TOK + ')$', 'i').test(lab[1]) ? 'fail' : 'pass';
  // ② 开头段: FAIL 词优先。验收语义下"有失败项"就是没过 ——
  //    老码按"第一个词定夺", 于是「3 个文件通过, 2 个未通过」判成 pass,
  //    2 步没过却收 completed。少数未通过被多数通过盖住, 验收就白做了。
  //    (有明确标签的结论走 ①, 不受这条影响 —— 那种形态的表述是自洽的。)
  const head = t.slice(0, _VERDICT_HEAD_LEN);
  // 捕获组不是可选的: 用 (?:…) 的话 match()[1] 是 undefined, 条件恒假, 整条规则变哑巴
  const headFail = head.match(new RegExp('(' + _VERDICT_FAIL_TOK + ')', 'i'));
  const any = head.match(_VERDICT_ANY_RE);
  const _tok = headFail ? headFail[1] : (any ? any[1] : null);
  if (_tok) return new RegExp('^(?:' + _VERDICT_FAIL_TOK + ')$', 'i').test(_tok) ? 'fail' : 'pass';
  // ③ 兜底: 旧的全文失败词扫描, 保持既有能力不放宽。
  return _CHECKER_FAIL_RE.test(t) ? 'fail' : 'pass';
}

function _finalizeAnswerText(text, fallbackText) {
  let out = String(text || '');
  try { out = require('./j2_helpers')._stripPseudoToolMarkup(out); } catch (_) {}
  try { out = require('./j2_helpers')._stripSpecialTokens(out); } catch (_) {}
  // 2026-10-24 (第 75 批 b): 剥内部标记 —— 与 _cleanLine 同一套判据,
  //   保证「流出去的和最后写出的同源」。判据真源 modules/internal_markers.js。
  try { out = require('./internal_markers').stripInternalMarkers(out); } catch (_) {}
  // 2026-10-16 (现场 syn2-234507: 禁令已挂上四条收口路径, 本地 27B 仍把注入块里的
  // `agent: executor` 复读成 "### executor" 标题 —— 主人看到的是将灵内部代号)。
  // 结论: 对这种本地模型, **光在 prompt 里说"不许写"是不可靠的**, 得在出口挡一道。
  // 这里剥的是"标题行里的将灵代号" (`### executor` / `## 2. checker` / `**planner**`),
  // 不是删代码块/引用块 —— 主人自己要求 Markdown 分节是合理的, 不该被误伤。
  out = out.replace(/^[ \t]*#{1,6}[ \t]*\d+[.)、]?[ \t]*[ 　]*[a-z_]+[ \t]*$/gim, '')
         .replace(/^[ \t]*#{1,6}[ \t]*(planner|executor|checker|analyzer|bug_hunter|reflector|learner|dispatcher|synthesizer)[ \t]*[:：]?[ \t]*$/gim, '');
  out = out.trim();
  if (out.length >= 10) return out;
  const fb = String(fallbackText || '').trim();
  // 2026-10-12 (diag-empty-20261012): 阈值从"10 字"改成"比剥完的更充实"。
  // 子 agent 的结论可能只有两个字 ("孙七"), 那也是真答案 —— 拿空白或拦截提示顶掉它是倒退。
  console.warn('[dispatcher] 收口剥完不可用, 回落子 agent 结论 (' + out.length + ' -> ' + fb.length + ' chars)');
  if (fb.length > out.length) return fb;
  return '⚠️ [盘古 收口异常] 模型只写出了工具调用草稿, 答复正文为空, 已拦截未交付。';
}

// 2026-10-23 第 61 批: 实现搬到 modules/final_pipeline.js —— 它跟
//   stripThink / 对齐门 / 出门核验门 是同一条流水线上的四步, 顺序必须一起定死,
//   散在两个文件里迟早被改乱。这里只保留一个 re-export, 老 require 路径不断。
//   (本文件里的两条正则常量同步删了 —— 留着的不是「备份」, 是第三份词表。)
const _stripHistoryLeak = require('./final_pipeline').stripHistoryLeak;

// 2026-10-12 (会话 resume-01/resume-02 实测): fixed_flow 的子任务文本统一走这里。
// 主人这轮的真实诉求只交给第 1 个子任务独家执行 —— 之前是当"上文"漏给每个子任务,
// 5 个 checker 各干一遍, 同一份产物被追加 3 次 (39 行 = 13×3); 判重修好后诉求彻底没人接。
// 2026-10-12 (会话 resume-05 实测): 固定流程原本按"连续同角色"并成一组 Promise.all,
// self_checker 的 5 个模板任务全是 checker → 全同时跑。承载主人诉求的 #0 正在写盘时,
// #1~#4 已经在查那个文件, 查到半成品 → 最终答复报"文件不存在、终态 0 bytes"。
// 承载诉求的首个子任务必须自己一组先跑完, 其余再并行。
function _fixedFlowGroups(fixedTasks) {
  const out = [];
  let idx = 0;
  while (idx < fixedTasks.length) {
    const group = [{ st: fixedTasks[idx], i: idx }];
    const isCarrierFirst = (idx === 0);
    idx++;
    while (!isCarrierFirst && idx < fixedTasks.length && fixedTasks[idx].agent === fixedTasks[idx - 1].agent) {
      group.push({ st: fixedTasks[idx], i: idx });
      idx++;
    }
    out.push(group);
  }
  return out;
}

function _fixedTaskPrompt(st, idx, total, userInput, historyBlock) {
  // 首发子任务 (第 1 个, 或总共只有 1 个) 主人这轮的真活就是它的正事 —— 不能套
  // '只做你被分派的这一个子任务' 那个围栏, 围栏跟诉求自相矛盾, 模型会照围栏办, 活就没了
  // (会话 resume-03 实测: 诉求和围栏同时给, 产物依然不存在)。
  const _isOwnerCarrier = (total <= 1) || (idx === 0);
  // 2026-10-12 (会话 resume-04 实测): userInput 服务端前缀拼了【盘古起卦】块, 直接 slice
  // 的话 600 字符全被卦块模板吃掉, 主人真实诉求落在切片之外 → 承载子 agent 0 次工具调用。
  // 注入前一律先剥卦块: 卦块是给模型看方向的, 不是主人的诉求。
  const _ownerAskText = _stripGuaBlockForRouting(userInput);
  const ownerAsk = _isOwnerCarrier
    ? ('\n\n【本轮主人的真实诉求 — 你负责执行, 与上面那个检查项一起做完】'
       + _ownerAskText.slice(0, 900))
    : '\n\n【本轮主人的真实诉求由子任务 #1 独家执行, 你不要碰 —— 你只做上面被分派的这一个检查项】';
  // 2026-10-12: 旧文案 '如果只有一轮工具执行机会, 请直接输出最终总结, 不要继续调用工具'
  // 等于开工前就劝模型收尾 —— 长任务被腰斩的 prompt 层根因。改成: 证据不够就继续调工具。
  // 2026-10-16: 换成结构化汇报契约 —— 分工要成立, 光"分下去"不够, 得"报上来"。
  // 散文式汇报让下一个兄弟自己从段落里刨事实, 分工省的 token 在交接处还回去。
  const summaryHint = require('./session_container').REPORT_CONTRACT;
  return String(historyBlock || '') + String(st.task || '') + ownerAsk
    + _ownerScopeBlock(userInput, _isOwnerCarrier ? 1 : total, st.task) + summaryHint;
}

// 2026-10-16 (时间账第五轮: 523s → 398.2s → 272.8s, 剩下的账在"刀数"不在"单刀速度"):
// 现场那道题是"建 2 个文本文件"。规则拆分 (task_split) 给出的正是 [executor, checker],
// 和 planner 的产物同构 —— 但盘古仍然先花了 61.8s 调一次 planner, 只为得到这个答案。
// 61.8s / 272.8s ≈ 23% 的总时间, 花在一次**本来可以规则回答**的推理上。
// 剩下的差距也印证了这一点: Codex 同题 1 刀, 盘古 4 刀, 每刀 ~58s 是这个 27B 的底价。
// 所以省时间只能两条路 (少几刀 / 单刀少想), 这条是第一条。
//
// 快路边界, 三条一条都不能松:
//   ① 只限**短机械活** —— 剥掉服务端拼的卦块后仍 ≤120 字。长的、调研的、需要权衡的
//      一律照旧给 planner: 那些活里拆解质量值钱, 长任务更不能在这里塌掉。
//   ② 判定用**剥块后**的长度, 拆分用**原文** —— 服务端拼的块不该计入工作量,
//      但子 agent 必须拿到主人逐字规格, 不能只拿到摘要。
//   ③ 拆不出 ≥2 刀 → 返回 null 走原路。宁可慢, 不给错的 plan。
const _FAST_PLAN_MAX_CHARS = 120;
// 2026-10-16: 主人明说"这些互不相干"的措辞。配合 numbered-parallel 判据使用 ——
// 只有主人逐字列了清单 **且** 明说互不相干时, 拆解才是输入本身, planner 无事可做。
// 见 _fastPlanFor 里的现场取证 (282s 那次)。
const _INDEPENDENT_LIST_RE = /(分别|各自|每个|逐个|独立|并行)/;
function _fastPlanFor(userInput) {
  try {
    const stripped = String(_stripGuaBlockForRouting(userInput) || '')
      .replace(/【[^】]*】/g, ' ').replace(/\s+/g, ' ').trim();
    if (!stripped) return null;
    // 2026-10-16 现场 e2e-agent-20261016: 「分别分析这三个文件, 每个文件给 3 个要点:
    //   1) j2_loop_shared.js 2) model_cost.js 3) checkpoint.js」
    //   → 282.0s 之后第一刀才开跑 (起卦 11:45:20 → sub_agent_start)。这 282s 全花在
    //   planner 那一次调用上, 而它交回的正是**规则拆分毫秒级就能给出的同一份三刀**:
    //   三个 analyzer、三个文件各一刀、"给 3 个要点"。纯浪费, 而且本地 27B 上最贵。
    //
    // 为什么原来没走快路: 闸门 _FAST_PLAN_MAX_CHARS = 120, 而三个绝对路径一写就 464 字。
    // 闸门本身没错 —— 长的/要权衡的活, 拆解质量值钱, 该给 planner (见 T2)。
    //
    // 但有一种长活不需要 planner: **主人自己把清单逐字列出来了, 而且明说项与项互不相干**。
    // 这时拆解就是输入本身 —— 清单是主人给的, 没有依赖要排, planner 无论怎么想都只能
    // 得到同一份答案。这正是老板说的"全量重填"的另一种形态: 把主人已经写清楚的拆解
    // 再花一次全上下文推理买回来。
    //
    // 两个条件缺一不可, 都收窄到不能再窄:
    //   ① 主人明说互不相干 (分别/各自/每个/逐个/独立/并行) —— 否则"5 步依次做"这种
    //      真有依赖顺序的活会被误伤 (T2 的例子不含这些词, 照旧给 planner);
    //   ② 规则确实认出了编号并列清单 (pattern === 'enumerated_parallel') —— 必须
    //      一项一刀、depends_on 为空, 也就是真并行, 不是把顺序活硬拆成并行。
    const _spelledOut = _INDEPENDENT_LIST_RE.test(stripped);
    if (stripped.length > _FAST_PLAN_MAX_CHARS && !_spelledOut) return null;
    const plan = require('./task_split').splitTask(String(userInput || ''));
    if (!plan || !Array.isArray(plan.subTasks) || plan.subTasks.length < 2) return null;
    if (stripped.length > _FAST_PLAN_MAX_CHARS
      && !(plan.pattern === 'enumerated_parallel' && _spelledOut)) return null;
    plan.source = 'fast_rule';
    return plan;
  } catch (_) { return null; }
}

function _buildHistoryBlock(messages, userInput, hasImages) {
  try {
    // 2026-10-12 (会话 resume-01 实测): 判重必须先把卦块剥掉再比。
    // 服务端 userInput 前面拼了【盘古起卦】块, 客户端 messages[].content 里没有, 
    // 精确相等永远判不出来 → 当前轮被当成上一轮上文灌回每个子任务, 多子任务各干一遍。
    // fixed_flow 5 个 checker 全部重跑主人这一轮, 索引被追加 3 次 (39 行 = 13×3)。
    const _normTurn = (t) => _stripGuaBlockForRouting(String(t || '')).replace(/\s+/g, ' ').trim();
    const _cur = _normTurn(userInput);
    const turns = (Array.isArray(messages) ? messages : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && !m.type && !m.tool_calls)
      .filter(m => !(m.role === 'user' && _normTurn(m.content) === _cur));
    if (!turns.length) return '';
    const lines = [];
    let used = 0;
    for (let i = turns.length - 1; i >= 0 && lines.length < _HISTORY_MAX_TURNS * 2; i--) {
      const m = turns[i];
      const raw = String(m.content || '').trim();
      if (!raw) continue;
      const who = m.role === 'user' ? '问事者' : '盘古';
      // 2026-10-12: 别只写 "[附图 N 张]" —— 子 agent **拿不到图像**, 看到这行就
      // 会去满世界找文件 (会话 80922578 实测: list_directory "/" 然后汇报"工具结果仅
      // 返回根目录清单", 整轮空转)。图里的内容盘古在首轮 legacy 路径已经转述成文字了,
      // 所以正确做法是让它用文字, 并明说别去找。
      // 2026-10-12 根修后: hasImages=true 时图已随任务透传给子 agent (bazi 盘面等),
      // 措辞必须跟着事实变 —— 再说"你拿不到图像"就是撒谎, 模型会弃图去翻文字。
      const withImg = Array.isArray(m.images) && m.images.length
        ? raw + (hasImages
          ? ' [上一轮带图 ' + m.images.length + ' 张 —— 图已随本任务一并发给你, 直接看图里的盘面分析; 禁止再为找图去调 list_directory/read_file/exec_command]'
          : ' [上一轮带图 ' + m.images.length + ' 张 —— 你拿不到图像本身, 但图里的盘面内容已经由盘古转述在下面这段文字里, 直接按文字分析; 禁止为找图去调 list_directory/read_file/exec_command]')
        : raw;
      let text = withImg;
      if (text.length > _HISTORY_TURN_CHARS) text = text.slice(0, _HISTORY_TURN_CHARS) + '…';
      if (used + text.length > _HISTORY_MAX_CHARS) break;
      lines.unshift(who + ': ' + text);
      used += text.length;
    }
    if (!lines.length) return '';
    return '[上文-仅供你参考, 禁止在答复里复述本段或提及"上文"/"上下文"这类字样]\n'
      + '(这是同一条对话, 不是第一次问。回答必须接住这段: 主人说的"上一轮/这个/它"都指这里。)\n'
      + lines.join('\n') + '\n\n';
  } catch (_) { return ''; }
}

// 2026-10-12 (会话 80922578 根修): 收集本会话主人发过的图, 透传给子 agent 与综合 LLM。
// 根因: 图只挂在 messages 的 user 消息上, 主 agent 看得见; 但 dispatcher 派生的子 agent
// 只拿到文字 task —— "做题要看清楚图" 这类题, 子 agent 没有盘面这个**独立证据源**,
// 只能去 list_directory 满世界找图 (实案: list_directory "/"), 或被主人一纠正就翻面
// (没有地面真相可锚, 主人的话就成了唯一信号)。图 = 子 agent 唯一能独立核验的根据。
// 取最近若干轮 user 消息上的图, 上限 3 张防上下文爆炸; vision 判定在下游
// (_adaptImagesForModel / _prepareMessagesForModel) 按模型能力各自落地。
const _DIALOG_IMG_MAX = 3;
function _collectDialogImages(messages) {
  const out = [];
  const userTurns = (Array.isArray(messages) ? messages : []).filter(m => m && m.role === 'user');
  for (let i = userTurns.length - 1; i >= 0 && out.length < _DIALOG_IMG_MAX; i--) {
    const imgs = userTurns[i].images;
    if (!Array.isArray(imgs) || !imgs.length) continue;
    for (let j = imgs.length - 1; j >= 0 && out.length < _DIALOG_IMG_MAX; j--) {
      const img = imgs[j];
      if (typeof img === 'string' || (img && (img.url || img.data_url || img.dataURL))) out.unshift(img);
    }
  }
  return out;
}

const _CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
// 主人是不是明说了"逐步/依次/按顺序", 或者给了 1)2)3) 这样的编号清单。
// 是的话, 计划本身就是顺序的 —— 此时没有任何显式依赖的任务应当等前面所有任务。
function _looksSequentialPlan(userInput) {
  const s = String(userInput || '');
  if (!s) return false;
  if (/(逐步|依次|按顺序|顺序执行|一步步|先[^。；]{0,24}再)/.test(s)) return true;
  // 2026-10-16 (现场 lt2-1792136693166): 原式把 `(?:第)?` 里的"第"做成可选, 于是
  // "1) a.js 2) b.js 3) c.js" 这种**编号清单**也算顺序计划 —— 可编号清单恰恰是
  // 并行的典型形状 ("分别分析这三个文件" = 三个互不相干的刀)。
  // 实测代价: _looksSequentialPlan('请分别分析这三个文件… 1) … 2) … 3) …') === true,
  // 于是 _inferDependsOn 把三份独立的文件分析补成 [0]→[0,1]→[0,1,2] 的串行链,
  // 并发归零, 4 刀全排队 —— 比不拆还慢。
  // 现在编号必须写成"第 N 步 / 步骤 N" 才算顺序证据; 裸编号只是清单。
  // 这里刻意不锚前导边界: 主人在正文里常写"第 1 步…第 2 步…第 3 步",
  // 省略号/破折号都不该把真顺序漏掉 —— "第 N 步" 三个字本身已经足够特异。
  const nums = new Set();
  const re = /(?:第\s*(\d{1,2})\s*步|步骤\s*(\d{1,2}))/g;
  let m;
  while ((m = re.exec(s)) !== null) nums.add(m[1] || m[2]);
  return nums.size >= 3;
}

// 任务文字里有没有"我要吃前面几刀的产出"的证据。
// 只用来裁决**链式依赖**该不该保留 (见 _inferDependsOn), 不做通用依赖推断 ——
// 宁可放过一条真依赖, 也不能把该并行的刀排成队。
// 这一刀是不是在**引用前面所有刀**的产出。
// 现场 lt2-1792139218147 (真端点, 同一道题第四次) 的完整时间线:
//   225132ms  三个 analyzer 同时开跑 (并发对了)
//   949520ms  checker 就启动了 —— 而第二、三刀 analyzer 分别到 1080608 / 1371998ms 才结束
//   1384528ms status=remediation 「验收未通过, 盘古自动补齐缺失 (第 1/2 轮)」
//             checker 的原话: 「什么都没产出 (没调任何工具, 也没有 plan 进度)」
// 原因很直白: planner 给的刀4 写的是「验证**前三个** analyzer 输出」、刀5 写的是
// 「基于已验证事实**综合最终回答**」—— 两句都在指上游, 但都指不出**哪一刀**,
// 于是依赖推断全部落空, 验收在三个 analyzer 还没写完时就开审, 审了个空,
// 判 FAIL, 再白白多跑一轮补救。顺序错了, 后面每一刀都在为空气干活。
// 从 task 文字里的 "基于步骤 2 的…" / "第 3 步…" 补出 depends_on。
// 只认比自己靠前的下标, 所以不可能成环。
//
// ── 角色名依赖 (2026-10-17, 现场 tl-1792194596414) ──────────────────────────
// planner 表达"这刀要吃上一刀的产出"有两种写法, 旧码只认第一种:
//   ① 步骤号   "基于子任务 0 的已核实事实" / "核验第 2 步"
//   ② 角色名   "仅依据**上游 analyzer** 的汇报结论…验收"   ← 这一种没人认
// 第二种在验收刀里尤其常见 —— checker 的任务天生就是"验收某个角色", planner
// 十有八九直接写角色名而不是下标。于是验收刀被当成无依赖的独立刀, 跟被验收的
// 那刀**同时开跑**, 审了个空。
//
// 这里把角色名映射回下标: 在**自己前面**的刀里, 找 agent == 该角色名的刀, 取**最后**
// 一个 (离得最近的才是"上游")。找不到 → 不产出依赖 (宁可放过, 也不把无关刀排成队)。
//
// 两道闸防止误判:
//   ① 指名必须带**上游语义** (上游/前置/前面/以上/基于/根据/核验…)。光出现
//      "analyzer" 两个字母不算 —— 像 "analyzer 和 executor 并行分析" 是并列,
//      不是依赖, 排成队就是白白损失并发。
//   ② 不许指向**自己**这一刀的 agent (自己依赖自己是环), 也不许指向后面的刀。
// 扫哪些词 → 归一成哪个拼音。
//
// 2026-10-18 实测: 这张表原来只剩拼音, 而它扫的是**模型写的散文**
// (「仅依据 analyzer 的汇报结论」)。于是扫出来的词是英文, 要比对的
// `list[k].agent` 已经是拼音 —— **恒不相等** → 依赖恒推出 0 组 →
// 该排队的刀全部并发跑出去 (现场 11ms 同时开跑)。列表又漏了 kan/qian 且
// 重复了 xun, 还挂着一个后端根本不存在的 'synthesizer'。
// 2026-10-18 实测 (两次):
//   第一次这张表只剩拼音, 而它扫的是**模型写的散文** (「仅依据 analyzer 的汇报结论」)
//   —— 扫出来的词是英文, 要比对的 list[k].agent 已经是拼音, **恒不相等** ->
//   依赖恒推出 0 组 -> 该排队的刀全部并发跑出去 (现场 11ms 同时开跑)。
//   当时的修法是给身份模块加一张英文解析表。
//   第二次 (老板「说了全部换, 还留着干嘛」) 把那张表删了, 于是同一个坑会以另一个
//   形式回来 —— 所以这次不是靠"多认几个写法"补, 是从提示词上掐:
//   ROLES.kan 的 system 已经明写「只写上面这 6 个拼音, 写英文名会被判未知角色」,
//   模型输出的散文里的角色名也是拼音, 扫的就是拼音。扫不到就不产出依赖
//   (下面 ① 明确说了宁可放过), 所以最坏情况是这次不排队, 不是排错队。
//
// 词表从身份真源派生: 8 个拼音 + 8 个卦名。卦名也在内, 因为提示词和 task 文本里
// 「离·眼」这种写法本来就常见, 而它要能跟 list[k].agent 的拼音对上。
const {GUA_ROLES: _DEP_GUA, resolveRole: _depTok} = require('../agents/gua-identity');
// 长词优先 (免得短名先命中, 把长名的后半截吃掉)
// 「验」「调度」「复盘」三种角色按定义要吃上游**已完成**的结论 → 默认依赖全部前置。
//
//   兑·验    核验 pass/fail, 对着已完成的东西下裁决
//   乾·调度  收全部将灵结果, 出最终结论
//   震·复盘  复盘"为什么成/败" —— 没有已完成的结果就没有可复盘的东西
// (震是 2026-10-18 补进来的: 现场 T10 里 planner 把「基于已验证事实综合最终回答」
//  交给震, 旧代码靠扒"基于…综合"认出了它依赖兑。新结构下它必须自己排上。)
//
// 从身份真源的 role 字段派生, 不手写名单 —— 手写就是第 N 次抄身份表,
// 而上一轮已经因为抄表抄错过一次 (CODE_TO_GUA 把乾写成 synthesizer)。
const _VERIFIER_CODES = Object.freeze(new Set(
  _DEP_GUA.filter((r) => r.role === '验' || r.role === '调度' || r.role === '复盘').map((r) => r.code)));

function _inferDependsOn(subTasks, sequentialPlan) {
  const list = Array.isArray(subTasks) ? subTasks : [];
  let inferred = 0;
  const undeclared = [];
  list.forEach((t, i) => {
    if (!t || typeof t !== 'object') return;
    const isAggregator = _VERIFIER_CODES.has(_depTok(t.agent));

    // ── 1. 显式 depends_on = 唯一权威 ────────────────────────────────────────
    if (Array.isArray(t.depends_on)) {
      const explicit = t.depends_on.filter((d) => Number.isInteger(d) && d >= 0 && d < i);
      // 链式伪依赖 (2026-10-16 现场 lt2-1792136693166): planner 把三份互不相干的
      // 文件分析填成 刀1→刀2([0])→刀3([0,1])→刀4([0,1,2]) 的串行链, 并发直接归零。
      // 动机很朴素: 提示词里的例子就是 depends_on:[0,1,2], 它把"综合任务该依赖全部"
      // 误推广成了"每刀都依赖前面"。
      //
      // 旧代码用**任务文字里的聚合措辞**来分辨真假链 (综合前 3 个…)。那又是读散文 ——
      // 措辞变了, 调度就变了。改成两个**结构判据**:
      //   ① 角色: 兑·乾·震 本来就是收口/复盘刀, 依赖全部前置合情合理;
      //      离·坤·巽 各自独立, 它声明 [0,1,2] 就是懒惰。
      //   ② 用户要的是不是顺序计划: _looksSequentialPlan 读的是**用户原话**
      //      (依次/一步步/先…再…), 不是模型写的散文。用户说"依次", 那链条就是
      //      他要的, 不许剥。没说要顺序, 才把懒惰链剥掉恢复并发。
      //      (现场 T8: 用户明说依次, planner 填的链是真顺序, 剥了就跑反了。)
      const isChain = i > 0 && explicit.length === i && explicit.every((d, k) => d === k);
      if (isChain && !isAggregator && !sequentialPlan) {
        delete t.depends_on;                    // 剥掉: 这一刀本该独立
      } else {
        t.depends_on = [...new Set(explicit)].sort((a, b) => a - b);
        // 兑/乾 显式声明"我不依赖任何东西"是可的 (orchestrator 的 pre_check 就是),
        // 但它站在有前置的位置上时值得记一笔 —— 那是"审了个空"的入口形状。
        if (!explicit.length && isAggregator && i > 0) {
          undeclared.push({ i, agent: t.agent, why: 'aggregator_declared_empty' });
        }
        return;
      }
    }

    // ── 2. 没声明依赖 = 拆解缺字段, 这是缺陷, 不是让盘古去猜 ────────────────
    // 旧实现在这里有三层散文兜底 (扒角色名 / 扒中文连接词 / 扒「第N步」编号)。
    // 全部删掉: 它们要盘古从模型写的散文里反推模型的意图, 于是调度结果取决于模型
    // 这一轮用了哪个词。模型用哪种措辞是模型的自由, 调度被措辞决定是盘古的 bug。
    undeclared.push({ i, agent: t.agent, why: 'missing' });

    // ── 3. 兑·验 / 乾·收口: 按定义就排在全部前置之后 (结构事实, 不读文字) ────
    if (isAggregator) {
      if (i > 0) {
        t.depends_on = Array.from({ length: i }, (_, k) => k);
        inferred++;
      }
      return;
    }
    // ── 4. 显式顺序计划: 依赖全部前置 ────────────────────────────────────────
    // 读的是**用户**的原话 (要一份/依次/一步步), 不是模型写的散文 —— 用户不会换措辞,
    // 而且这是用户自己的意图, 不是猜来的。
    if (sequentialPlan && i > 0) {
      t.depends_on = Array.from({ length: i }, (_, k) => k);
      inferred++;
    }
    // ── 5. 其余: 独立并发。这里不猜。 ────────────────────────────────────────
    // 认不出依赖就不是独立, 但**盘古猜不出来就不该假装知道**。缺声明记进 undeclared,
    // 由调用方报出来 —— 宁可让人看见"这份拆解没声明依赖", 也不要盘古替模型编一个。
  });
  return { inferred, undeclared };
}

  // 2026-10-13 (objw-live-1791858904 现场): 父会话落盘只有 8 条注入 system + 1 user +
// 1 assistant(918 字), 工具消息 0 条 —— 派了哪几个子 agent、各自返回什么、跑了哪些工具,
// 一条都没进历史。根因是 _persistParent 只存 [...dispatcher 自己的 messages, {assistant}],
// 而真正的活全在 results[] 里 (只被拼进综合提示词, 从未进过历史)。
// 后果: 续跑时父会话对刚做完的事毫无记忆 → 长任务天然续不回来。
// 记成**一条** system 消息而不是每个子 agent 一条: 压缩那条已经证明, 注入一堆近似的
// system 提示会让会话逐轮膨胀压不动, 派发记录本身不能变成新的膨胀源。
function _buildDispatchRecord(results) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return '';
  const lines = list.map((r, i) => {
    const _r = (r && r.result) || {};
    const _task = String((r && r.task) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const _sum = String(_r.summary || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    // 第 87 批: artifacts 是**对象数组** `{path, bytes, tool}` (见 j2_agent_loop.js 的
//   `_artifacts` 构造), 原来 `.map(String)` 直接把每个变成 "[object Object]" ——
//   现场 probe89 的派发记录里第 1 刀就是这么写的: 「产出: [object Object]」。
    //   ⇒ 主人和续跑看到的是「产出: [object Object]」, 什么信息都没有。
    const _arts = Array.isArray(_r.artifacts)
      ? _r.artifacts.filter(Boolean).map(a => {
        if (typeof a === 'string') return a;
        if (a && typeof a === 'object') return String(a.path || a.file || a.name || '');
        return String(a);
      }).filter(Boolean)
      : [];
    const _artStr = _arts.length
      ? _arts.slice(0, 5).join(', ') + (_arts.length > 5 ? ' (+' + (_arts.length - 5) + ')' : '')
      : '(无)';
    const _tools = Array.isArray(_r.toolsUsed) && _r.toolsUsed.length ? _r.toolsUsed.join(', ') : '(无)';
    const _status = String(_r.runtimeStatus || 'unknown');
    return [
      (i + 1) + '. [' + String((r && r.agent) || '?') + '] 交代: ' + (_task || '(无)'),
      '   返回: ' + (_sum || '(空)'),
      '   产出: ' + _artStr + ' | 工具: ' + _tools + ' | 状态: ' + _status,
    ].join('\n');
  });
  return '[子 agent 派发记录] 本轮拆解为 ' + list.length + ' 个子任务并交由子 agent 执行。'
    + '以下为各自交代与返回 (供续跑与复盘; 要细节去读子会话落盘, 别拿这里的摘要下结论):\n'
    + lines.join('\n')
    + '\n子 agent 完整现场按 2026-10-13 修复已落盘在 ~/.pangu-data/sessions/ '
    + '(文件名把 # 换成 _), 例如 <父会话 id>_sub-<序号>-<角色>.json。';
}

function _buildParentConvo(messages, results, answer) {
  const convo = [...(Array.isArray(messages) ? messages : [])];
  const _rec = _buildDispatchRecord(results);
  if (_rec) convo.push({ role: 'system', content: _rec });
  convo.push({ role: 'assistant', content: String(answer || '') });
  return convo;
}

async function _runPanguDispatcherLoop(messages, model, req, res, opts) {
  // 2026-10-13: 本轮起始时间 —— 对账只能看**本轮**写了什么。
  // 不限本轮的话长会话里, 后面某一轮说「这次没创建文件」会被上面轮的
  // 累计写盘误报成矛盾 (账本 collectWrittenFiles 是全会话累计的)。
  const _turnStartTs = Date.now();
  // N5 B3-Phase 4 遗留 bug: 抽模块时丢了 deps 解构, safeResWrite/CONFIG_PATH/_callLLMForAgent
  // 等全是裸标识符, 一进 dispatcher 就 ReferenceError。这里统一从 _deps 取, CONFIG_PATH
  // 兜底用相对路径 (modules/ -> apps/core/config/nodes/your-mac.json)
  const {
    safeResWrite,
    _callLLMForAgent,
    truncateMessagesForContext,
    _matchSkipPlannerRole,
    _buildFixedSubTasks,
    _keywordFallback,
  } = _deps || {};
  // 2026-10-16 (现场 v2-032551: "建 2 个文件"的任务总共跑了 8 分 43 秒, 其中 4 分 46 秒
  // 全耗在**收口这一次调用**上 ——
  //   上游半路死了 (LM Studio 推理进程 2.7% CPU = 空闲, TCP 连接还 ESTABLISHED,
  //   一个字节都不发), 而收口走的是非流式: 拿到响应头之后, "上游死了"和"还在慢慢生成"
  //   在协议上**完全一样**, 没有任何办法提前判, 只能等 req.setTimeout 的 300s 空闲墙。
  //   实测本机 headers 0.00s、首字节 ~1s (探到 48K 字上下文仍 ~0.8s), 所以那 300s 里
  //   99% 是白等的 —— 屏幕上只有心跳, 子 agent 早就报完工了。
  //
  //   修法: 收口也走流式。llm_caller 的流式路径自带两道熔断 ——
  //     · 90s 无数据 → STREAM_IDLE_TIMEOUT_90s (中途死掉 90 秒就让位, 不烧满 300s)
  //     · 300s 总时长 → controller.abort (兜底"永远不结束"的流)
  //   顺带把 delta 报成活性: 子 agent 那段有 142 条活性事件, 主人却要干等最后这几分钟。
  //
  //   依赖没注入流式版 (老调用方 / 单测) 时老实退回非流式, 行为一个字不变。
  async function _synthesizeStreamText(summaryMessages, model, res, label) {
    const _streamFn = (_deps && _deps._callLLMForAgentStream);
    if (typeof _streamFn !== 'function') {
      const r = await _callLLMForAgent(summaryMessages, model, []);
      return (r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '';
    }
    let text = '';
    const t0 = Date.now();
    let lastTick = 0;
    // 2026-10-17 (现场 rp-1792175683xxx 实测): 综合阶段**在流式收 delta, 但一个字都不发出去** ——
    //   只每 1.5s 发一个带字数计数的 sub_progress (前端只把它渲染成"字数在涨"),
    //   正文直到最后才作为一整块 chunk 一次性写出。
    //   老板原话"不是流式输出"就是这一段。而这段恰恰是主人**唯一**能看见正文的时刻:
    //   前面 47~98s 是子 agent 的活(走卡片), 综合这段才是他等着读的东西。
    //
    // 为什么原来不发: 大概是怕原文里的伪工具标记 / 将灵代号标题漏上屏 ——
    //   确实会漏, 那些东西收口时是要剥掉的。所以这里不是"把原文直接推出去", 而是:
    //   ① 逐行缓冲, 只发**已经写完整的一行** (半行留着, 等它写完) —— 避免把
    //      还没成形的标记残片刷到屏上, 也避免把 `## executor` 这种行首匹配的东西
    //      拆成两半发出去;
    //   ② 每发一行都先过一遍收口用的同一套剥除规则, 让**流出去的和最后写出的同源**;
    //   ③ 最终稿带 replace:true 声明权威 (前端见 subagent-progress-task-key 旁的
    //      ChatRoom 改动), 收口阶段任何后处理 (对账 / 验收注记) 的结果都盖得住已流的。
    let emitted = '';
    let pending = '';
    const _cleanLine = (ln) => {
      let s = ln;
      try { s = require('./j2_helpers')._stripPseudoToolMarkup(s); } catch (_) {}
      try { s = require('./j2_helpers')._stripSpecialTokens(s); } catch (_) {}
      // 2026-10-24 (第 75 批 b): 剥内部标记 —— 这条流是**综合稿真正上屏的唯一通道**
      //   (前端只从 stream_delta 取正文, 'done' 事件里的 result 只用来记元数据),
      //   综合模型要是把子 agent 报告里的内部标记抄进来, 主人就看见了。
      //   判据与白名单的单一真源在 modules/internal_markers.js。
      try { s = require('./internal_markers').stripInternalMarkers(s); } catch (_) {}
      // 与 _finalizeAnswerText 同一组将灵代号行首规则 —— 那两行是 `m` 标志的行锚正则,
      // 完整行才可能命中, 所以逐行发是安全的。
      s = s.replace(/^[ \t]*#{1,6}[ \t]*\d+[.)、]?[ \t]*[ 　]*[a-z_]+[ \t]*$/gim, '')
           .replace(/^[ \t]*#{1,6}[ \t]*(planner|executor|checker|analyzer|bug_hunter|reflector|learner|dispatcher|synthesizer)[ \t]*[:：]?[ \t]*$/gim, '');
      return s;
    };
    // 2026-10-25 (第 86 批): 问上游「这条流有没有正文」。
    //   上游整条流零 content、只回 reasoning_content 时, 老行为是把思考交出去
    //   (2026-07-28 为了兼容 qwen3.6 / deepseek-r1 这类只回思考的模型)。
    //   在主循环里那是对的, 但在**合成层**那是模型的计划口吻
    //   (现场 probe87-fixed: 307 字 "We need synthesize, perhaps need actual
    //   files? … Need perhaps call tools ourselves …"), 不是答案 ——
    //   主人收到的是一段英文自说自话, 不是综合稿。
    //   ⇒ 这里记下这个事实, 收口时当「这次综合没成」处理 (重试一次, 再兜底)。
    //   判据是上游**回没回正文**这个事实, 不是「文本像不像思考」——
    //   拿词当判据是 2026-10-25 这一整天在治的病, 不许在这里复发。
    let _reasoningOnly = false;
    let _reasoningChars = 0;
    let _threwReasoningOnly = false;
    for await (const delta of _streamFn(summaryMessages, model, [], {
      onReasoningOnly: (n) => { _reasoningOnly = true; _reasoningChars = Number(n) || 0; },
    })) {
      if (!delta) continue;
      const d = String(delta);
      text += d;
      pending += d;
      // 只在拿到换行时才发已完整的部分; 结尾那半行留给收口时的 chunk/final。
      const nl = pending.lastIndexOf('\n');
      if (nl >= 0) {
        const ready = pending.slice(0, nl + 1);
        pending = pending.slice(nl + 1);
        const cleaned = _cleanLine(ready);
        if (cleaned.trim()) {
          emitted += cleaned;
          if (res) {
            try {
              safeResWrite(res, 'stream_delta', {
                delta: cleaned, accumulated: emitted, token_count: 0, ts: Date.now(),
              });
            } catch (_) { /* 流式写不出去不能影响综合结果, 末尾的 chunk/final 仍然照发 */ }
          }
        }
      }
      const now = Date.now();
      // 1.5s 节流: 收口这段以前是纯黑箱, 现在主人看得见字数在长
      if (res && now - lastTick >= 1500) {
        lastTick = now;
        try {
          safeResWrite(res, 'sub_agent_progress', {
            agent: label || 'qian', task: '', stage: 'sub_progress',
            ms: now - t0, content_chars: text.length, thinking_chars: 0, tools: [],
          });
        } catch (_) {}
      }
    }
    try {
      // 一个字都没有 → 跟流式路径自身的零内容保护一致, 交回调用方的 fallback
      if (!text.trim()) throw new Error('SYNTHESIS_STREAM_ZERO_CONTENT');
      // 2026-10-25 (第 86 批): 上游整条流零正文, 只回了思考 ⇒ 这一轮综合**没成**。
      //   跟零内容同一条处理 (交回调用方的 fallback), 但用**可区分的**错误名,
      //   好让调用方知道该**重试一次**而不是直接兜底。
      if (_reasoningOnly) {
        _threwReasoningOnly = true;
        const e = new Error('SYNTHESIS_STREAM_REASONING_ONLY');
        e.reasoningOnly = true;
        e.reasoningChars = _reasoningChars;
        throw e;
      }
      return text;
    } finally {
      // 2026-10-19 (老板: 「还是两个agent在跑」): 上面每 1.5s 一帧的
      // sub_agent_progress{agent:'qian'} 只报「还在写」, **从不**发 sub_agent_done ——
      // 而它是主人唯一能看见正文的时刻 (前面几十秒是子 agent 的活, 走卡片)。
      // 前端据此建出来的乾·调度卡永远收不了工, 面板虚报「已派 5 路」。
      //
      // 放 finally: 零内容抛错那条路 (交回 _fallbackSynthesis) 同样是**干完了**,
      // 照样得收口 —— 只在成功路径发的话, 兜底一触发就又漏一张卡。
      //
      try {
        // 2026-10-25 (第 86 批): 「只回思考 ⇒ 重试一次」那条路上, 第一次尝试
        //   **不算一次综合** (它连正文都没给), 不该在前端多出一张「综合 307 字」的卡。
        //   第二次 (真正的综合) 才发卡。
        //   零内容那条老路**照旧发卡** —— 它是真的收尾了, 兜底要接着往下走。
        if (!_threwReasoningOnly) {
          safeResWrite(res, 'sub_agent_done', {
            agent: label || 'qian', task: '', ts: Date.now(),
            summary: '综合 ' + text.length + ' 字',
          });
        }
      } catch (_) { /* 收尾事件不许影响综合结果本身 */ }
    }
  }
  if (typeof safeResWrite !== 'function') {
    throw new Error('j2_dispatcher 未初始化: 请先调用 init({ safeResWrite, ... })');
  }
  // 2026-08-02 修: done 后必须 res.end() — 之前只写事件不关连接,
  // 客户端收完 final/done 还干等 keepalive 直到超时 (curl exit 28 / UI 转圈)
  const userInput = opts.userInput || '';
  const sessionId = opts.sessionId || (opts.reqBody && opts.reqBody.session_id) || 'default';
  // 2026-10-12 (会话 80922578 根修): ①本会话的图透传给所有子 agent/综合; ②纠错轮标记 —
  // 纠错轮里子 agent 的"无依据改口"不许直接进综合, 强制复核一轮 (见 fixed_flow 分支)。
  const _dialogImages = _collectDialogImages(messages);
  const _isCorrTurn = isCorrectionTurn(userInput, messages);
  // 2026-10-12 (实案 diag-empty-20261012): 主人显式说"直接答/别调工具"时, analyzer 听话不调工具
  // 直接把结论答出来了 —— runtimeStatus 的定义是"有无成功工具", 于是这轮被判 failed, 整轮自报没干活。
  // 直答轮拿到实质结论就算成功 (听话 ≠ 没干活)。
  const _directAnswerTurn = (() => {
    try { return require('./j2_loop_shared').wantsDirectAnswer(userInput) === true; } catch (_) { return false; }
  })();
  // 2026-10-09 P0 (老板报"会话 61554610 排查"): 父会话从来没落盘过。
  // 根因: 子 agent 各自跑 j2_agent_loop, 那条路 finally 有 _persistSession, 所以 #sub-* 账本能落盘;
  // 但桌面聊天的父会话走的是本函数(_runPanguDispatcherLoop), 全文没有任何 sessionSave 调用 —
  // 综合完直接 resDone + res.end 就结束, 父会话在磁盘上不存在。
  // 后果: 任何走 dispatcher 的对话(基本等于所有非平凡对话)刷新/重启即丢。
  // 实测: 2026-10-08 的 desktop-1791461554610 跑了 26 分钟子 agent, 主会话文件不存在。
  const _persistParent = (answer, state) => {
    // 2026-10-14 连续上下文 (最后一块): 把本轮的答复记进 session 容器。
    // 挂在 _persistParent 里而不是逐个 final 点, 因为这是父会话落盘的**唯一实现**。
    //
    // 2026-10-23 (第 65 批): 原来这条注释写的是「6 处调用覆盖 fixed_flow / 直答 /
    // 关键词兜底 / DAG 全部路径 —— 挂这里就不会漏」—— **那是假的**:
    //   实际调用点只有 5 处, 而「关键词兜底」那两条路**一处都没有**。
    //   注释写着覆盖、代码没覆盖, 这就是「注释 ≠ 隔离」的第五种形态:
    //   注释会让人以为不用查, 于是漏了三次都没人发现。
    // 现在: 调用点收成**一处** (_closeOut 内部), 出口只有 _closeOut 能落盘。
    // 漏了这块的后果: 下一轮主人问"那现在呢", 容器里只有他的问题,
    // 没有盘古上轮答了什么, 连续性从第二轮就断了。
    try {
      const _sc2 = require('./session_container').getContainer();
      if (sessionId && answer && String(answer).trim()) {
        _sc2.appendTurn(sessionId, 'assistant', String(answer));
      }
    } catch (_) {}
    try {
      const { _persistSession } = require('./j2_loop_shared');
      _persistSession(sessionId, _buildParentConvo(messages, results, answer), {
        state: state || 'active',
        task_input: userInput,
        mode: 'qian',
        final: true,
      });
    } catch (e) {
      console.warn('[dispatcher-persist] parent sessionSave failed:', e.message && e.message.slice(0, 200));
    }
  };
  const resDone = (obj = {}) => {
    // Keep Dispatcher terminal events, outcome files, and success telemetry on
    // the same evidence rule as the legacy loop. A prose synthesis is not a
    // completed task unless at least one real (non-task_done) tool was used.
    const tools = Array.isArray(obj.tools_used) ? obj.tools_used : [];
    const realTools = tools.filter((name) => name !== 'task_done');
    const resultText = String(obj.result || '');
    const pseudoToolText = /<tool(?:\s|>)|<tool_call(?:\s|>)|\btool_call\b/i.test(resultText);
    const childFailures = Array.isArray(obj.child_failures) ? obj.child_failures : [];
    const childStatuses = Array.isArray(obj.child_statuses) ? obj.child_statuses : [];
    let verdict = classifyRuntimeVerdict({
      real_tool_calls_total: realTools.length,
      final_text: resultText,
      alignment_blocked: obj.alignment_blocked,
      task_done_status: obj.task_done_status,
      task_done_accepted: obj.task_done_accepted,
      // 2026-10-19 (现场 probe-1792372025): 这里原来只认 'completed'。
      // 而 sub-agent.js:1734 的 runtimeStatus **只会产出 'done' 或 'failed'** ——
      // 'completed' 这个值在运行时根本不存在。于是 `includes('completed')` 恒为 false,
      // has_verified_execution 恒为 undefined → runtime verdict 恒判 partial。
      //
      // 后果不是"偶尔误判", 是**每一个子 agent 交付的答复都被标成没做完**。实测:
      // 「读 pangu_dogfood.js 列出串联了几个将灵」→ li 读了 4 次文件、答案完整正确
      // (7 个将灵, 带行号证据), 收口却是 status=partial success=false。
      // 老板要的"能交付"在这里被自己的判分器否掉。
      //
      // 为什么下面几行早就写对了: fixed_flow/qian 分支用的是
      // `c === 'completed' || c === 'done'` —— 同一份判据, 上面这行漏了一个值。
      // 两边现在用同一个判定函数, 不再各写一份。
      has_verified_execution: childStatuses.length
        ? childStatuses.some(c => c === 'completed' || c === 'done')
        : undefined,
      // 2026-10-15: 主人明说"只回一个词"时, 子 agent 的短答是**正确交付**,
      // 不是没答完整。不传这个字段 → runtime_verdict 只看得到 final_text 长度,
      // 短答一律判 failed → 编排明明跑通了却报失败。
      user_input: userInput,
    });
    // 2026-09-18 (老板点名调度体验): fixed_flow/dispatcher 模式父级 tools_used 恒空,
    // runtime verdict 只看到 0 工具 → 一律 partial, 把子任务真跑通的成功误判成 partial。
    // 修复: child_statuses 全 completed/done 时, 把 real_tool_calls_total 补上子任务工具数,
    // 让 verdict 有合理输入 → completed。
    // 2026-10-12 (现场 probe-direct-fix4-2136): 直答轮 0 工具是**预期行为** ——
    // 主人明说"直接答", 拿到实质答复就算这轮成功。通用判分器拿"0 工具"当失败证据,
    // 于是把正确答复判成 failed (盘古表现 = 答对了前端却盖 ✗)。直答路径显式豁免:
    // 有实质答复且不是占位文案 → completed。空答复/占位仍 failed, 不许蒙混。
    if (obj.mode === 'direct_answer') {
      const _daOut = String(resultText || '').trim();
      // 2026-10-13 补 (现场 ar-0006 回归): 原豁免只看"是不是占位文案", 没看"答复是否
      // 自认没干活" —— 子 agent 如实交代"本次未能实际创建文件"却被判 success:true,
      // 主人看到绿勾而磁盘上空手, 比原 bug 更坏。必须同时查 _answerAdmitsIncomplete。
      const _daAdmitsFail = _answerAdmitsIncomplete(_daOut);
      const _daReal = _daOut.length > 0
        && !/未能产出实质答复|收口异常|未产出文字总结/.test(_daOut)
        && !/[<>]\s*tool[\s/>]/.test(_daOut)
        && !_daAdmitsFail;
      if (_daAdmitsFail) console.warn('[dispatcher] direct_answer: 答复自认未完成 → 不判 success');
      if (_daReal && !pseudoToolText) {
        verdict = { ...verdict, status: 'completed', success: true };
        console.log('[dispatcher] direct_answer: 实质答复且 0 工具为预期 → override to completed');
      } else {
        verdict = { ...verdict, status: 'failed', success: false };
        console.warn('[dispatcher] direct_answer: 无实质答复 → 保持 failed');
      }
    }
    if (obj.mode === 'fixed_flow' || obj.mode === 'qian') {
      if (childStatuses.length > 0 && childStatuses.every(c => c === 'completed' || c === 'done')) {
        if (childFailures.length === 0) {
          verdict = { ...verdict, status: 'completed', success: true };
          console.log('[dispatcher] resDone: child_statuses all ok → override to completed');
        } else {
          verdict = { ...verdict, status: 'partial', success: false };
          console.warn('[dispatcher] resDone: child summaries contain failed/unverified evidence; refusing completed');
        }
      }
    }
    let status = obj.status || verdict.status;
    if (childFailures.length > 0 && status === 'completed') status = 'partial';
    if (pseudoToolText && realTools.length === 0) {
      status = 'failed';
      console.warn('[dispatcher] pseudo tool markup without executed tools; refusing success');
    }
    const terminal = { ...obj, status, success: status === 'completed', session_id: sessionId };
    safeResWrite(res, 'status', {
      status: status === 'failed' ? 'failed' : status === 'partial' ? 'partial' : 'done',
      success: status === 'completed', session_id: sessionId,
      tool_calls_total: tools.length, ts: Date.now()
    });
    safeResWrite(res, 'done', terminal);
    try {
      const { recordOutcome } = require('./outcome_tracker');
      // 2026-10-13: 原来硬编码 artifacts: [] (0201da1 / 2026-09-09 引入) ——
      // 1023 条结局记录里只有 3 条有产物, 全是引入前; 之后整整一个月 0 产物,
      // 连真写了 3 个文件那次也是 completed + artifacts_count=0。
      // 账本早知道本轮真写了哪些文件 (含子 agent), 这里改读真源。
      let _artifacts = [];
      try {
        _artifacts = require('./task_ledger').collectWrittenFiles(sessionId)
          .map(w => ({ type: 'file', path: w.path, bytes: (w && w.bytes) != null ? w.bytes : null, tool: (w && w.tool) || null }));
      } catch (_) {}
      recordOutcome(sessionId, {
        status,
        artifacts: _artifacts,
        metrics: { rounds: Number(obj.rounds || 0), tool_calls_total: tools.length, real_tool_calls_total: realTools.length, dispatcher_mode: obj.mode || null },
        ts: Date.now()
      });
    } catch (_) {}
    try { res.end(); } catch (_) {}
  };

  // ══════════════════════════════════════════════════════════════════════
  // 第 65 批: **唯一出口** —— 所有 resDone 都走它, 落盘跟它绑死。
  //
  // 为什么要收成一处 (不是为了整齐):
  //   2026-10-12 P1 修过一次「会话跑完刷新就没了」(会话 61554610):
  //   根因是 dispatcher 有 8 个出口, 每个出口都要**自己记得**调 _persistParent,
  //   当时只修了 fixed_flow 那一条。
  //   结果 2026-10-16 现场「Planner failed: LLM timeout 300s」→ 走关键词兜底,
  //   那条路**答完了、也上屏了**, 父会话却没落盘 ⇒ 刷新/重启即丢。
  //   同一族的事故修了 3 次还在长新的 —— 因为「要落盘」是每处各自记住的,
  //   而「出口」有 8 个。靠记性守不住的, 就得靠结构。
  //
  // 契约:
  //   ① resDone 全文件只有这一个调用点
  //   ② 每个出口都必须显式给落盘规格:
  //        persistState: 'completed' | 'partial' | 'failed' | 'active'
  //        或 persist: false + **理由** (不给理由就当没给, 按 completed 落盘)
  //   ③ 不落盘的出口必须写清为什么 —— 没写就 warn, 让它响, 不许默默跳过
  // ══════════════════════════════════════════════════════════════════════
  // 机制本身在 modules/dispatcher_closeout.js (叶子模块, 可单测) ——
  // 「落盘规格怎么判」是这条链上最该有单测的一环, 不能只靠整链实跑才发现。
  const _closeOut = require('./dispatcher_closeout').makeCloseOut({
    resDone,
    persistParent: _persistParent,
  });

  // 2026-08-02 老板拍 ("盘古必须是以易经为核心推理"):
  // 整条推理链以卦为纲 — 入口卦注入每个子任务, 不只停在 planner/综合
  const _guaFirst = opts.guaFirst || null;
  const _historyBlock = _buildHistoryBlock(messages, userInput, _dialogImages.length > 0);
  if (_historyBlock) console.log('[dispatcher] history block attached, chars=' + _historyBlock.length);
  // ===== 连续上下文接线 (2026-10-14, 老板: "盘古一样需要连续上下文") =====
  // 旧码的连续性只靠 _historyBlock —— 那是把客户端传来的 messages 压成一段**文字**,
  // 塞进每个 task 的开头。它有三个硬伤:
  //   ① 压缩过, 细节全丢 (每轮 1200 字上限)
  //   ② 它是"引用一段文字", 不是"接着往下说" —— 模型仍然要重新推断这句话在说什么局面
  //   ③ 将灵之间互不可见: 同一轮里 analyzer 查到的, bug_hunter 完全不知道
  // 现在改成: session 容器存真实对话轮次 + 将灵产出, 子 agent 直接继承**结构化历史**,
  // 而不是继承一段被压扁的引文。这跟 codex 单一长对话是同一个语义, 只是盘古要显式接线。
  const _sc = require('./session_container').getContainer();
  const _shared = require('./j2_loop_shared');
  // 本轮之前的历史快照 —— 子任务型调用 (taskText 是 planner 拆的 subTask.task, 不含主人原话)
  // 靠它继承真实轮次; 而 planner/直答/关键词兜底那几条路的 taskText 已经带了
  // _historyBlock, 再灌一遍就是重复注入, 只会白烧 token。
  // 存的是**条数**而不是内容: 分工上下文是懒取的 (调用点在 append 之后),
  // 但快照语义必须留在 append 之前 —— 否则本轮主人的提问会在 turns 和 taskText
  // 里各出现一次。这个反直觉的顺序是 2026-10-14 那版就写在代码里的, 别"顺手整理"掉。
  let _priorTurnCount = 0;
  // 服务端成为真源: 首次见到这个 session 时用客户端带来的 messages 播种,
  // 之后每轮 appendTurn。这样即使前端不重发历史, 连续性也不断。
  if (sessionId) {
    try {
      _sc.ensureRoot(sessionId);
      const _st = _sc.getState(sessionId);
      if (_st && !_st.seeded && Array.isArray(messages)) {
        _st.seeded = true;
        for (const _m of messages) {
          if (_m && (_m.role === 'user' || _m.role === 'assistant') && !_m.type && !_m.tool_calls) {
            // 2026-10-28: 容器记**主人原话**, 不记注入块拼过的版本 (口径见 j2_loop_shared)。
            _sc.appendTurn(sessionId, _m.role, _shared.turnText(_m));
          }
        }
      }
      // 先记轮数, 再 append 当前轮 —— 顺序不能反, 反了就把本轮也算进"上文"
      try {
        const _stNow = _sc.getState(sessionId);
        _priorTurnCount = _stNow && Array.isArray(_stNow.turns) ? _stNow.turns.length : 0;
      } catch (_) { _priorTurnCount = 0; }
      // 同上: 记原话。
      _sc.appendTurn(sessionId, 'user', _shared.lastUserRaw(messages) || userInput);
    } catch (_) {}
  }
  // 给子 agent 的继承上下文 (turns + 其他将灵产出)。子 agent 仍拿独立的 sessionId
  // 做 abort/权限隔离, 但上下文从父会话继承 —— 隔离与连续性拆成两件事。
  // mode='task'   → taskText 是 planner 拆出来的子任务, 不含主人原话, 必须继承真实轮次
  // mode='inline' → taskText 已含 _historyBlock, 只补将灵产出, 不重复灌轮次
  //
  // 2026-10-16 (老板: "全量重填肯定是大问题, 就该把任务拆了, 分下去, 子 agent 只做
  // 自己相关的"): 这里从"全量灌"改成"按这一次要干的活来选"。
  // 旧码把最近 8 轮 + 12 条产出**无条件**发给每个将灵, 于是每个兄弟都在替别人的活
  // 付一次 prefill, 而且模型读到主人的宽问题会去答整件事, 不是自己那一刀。
  // 现在传入本次 taskText, 由 buildScopedContext 按相关性挑 —— 无关的不下发,
  // 但**没有从历史里删掉**, 所以下一个兄弟该看得到时照样看得到。
  const _ctxForSubagent = (m, taskText, excludeScopePaths) => {
    if (!sessionId) return undefined;
    try {
      const _live = _sc.buildScopedContext(sessionId, {
        taskText: String(taskText || ''),
        includeFindings: true,
        upToTurns: _priorTurnCount,
        excludeScopePaths: excludeScopePaths || [],
      });
      // 分工是否真的生效只有一个地方能查: 这行日志。感觉不作数。
      if (_live && _live.scope) {
        const _s = _live.scope;
        console.log('[dispatch] 分工上下文 ' + m + ': 作业键=' + _s.task_keys
          + ' 轮次 ' + _s.turns_kept + '(相关 ' + _s.turns_kept_relevant
          + '/砍无关 ' + _s.turns_dropped_irrelevant + ')'
          + '/砍兄弟 ' + _s.turns_dropped_sibling
          + ' 产出 ' + _s.findings_kept + '(砍无关 ' + _s.findings_dropped_irrelevant + ')'
          + ' 下发 ' + _s.chars + ' 字符');
      }
      return {
        turns: m === 'inline' ? [] : _live.turns,
        findingsBlock: _live.findingsBlock,
        rootId: _live.rootId,
        scope: _live.scope,
      };
    } catch (_) { return undefined; }
  };
  const _guaLine = (_guaFirst && _guaFirst.gua_name)
    ? ('【卦·' + _guaFirst.gua_name + (_guaFirst.symbol || '') + ' ' + (_guaFirst.yao_name || '') + '动→' +
       (_guaFirst.zhi_gua ? _guaFirst.zhi_gua.name : '?') + '】「' + (_guaFirst.moving_yao_ci || '') + '」— 先按此卦断方向 (攻守/时机/进退), 再执行子任务:\n')
    : '';

  // 2026-08-02 修 (MiniMax-M3 实测: 综合 LLM 把 <think> 内联进 content, final 事件漏思考全文上屏):
  // dispatcher 所有 final/chunk/done 收口处统一剥 think (j2 主循环 emitFinalOnce 早这么干了, dispatcher 漏了)
  const _stripThink = (t) => require('./j2_helpers')._stripSpecialTokens(String(t || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/<think>[\s\S]*$/g, '')).trim();

  // 2026-08-02 修 (老板标准: 有真内容就给看, 不甩 HTTP 错误): 综合 LLM 失败时
  // 子任务结论都是真跑出来的 — 拼干净汇总当答案, 错误只进日志
  // M3 fix: _fallbackSynthesis 定义移到 results 声明之后 (见下方), 消除闭包依赖提升的 TDZ 隐患
 // #6 架构重叠: 不再 require sub-agent, 统一走 j2_agent_loop
  const configPath = (_deps && _deps.CONFIG_PATH) ||
    require('../config/node_config').resolveNodeConfigPathOrEmpty();
  const results = [];
  let finalText = '';
  // 2026-10-16: 收口改走流式后, anthropic 的形状由 llm_caller 的 SSE 解析自己处理
  // (content_block_delta → 纯文本), 这里原来的 isAnthropicModel 分叉已经没有调用方, 删掉。

  // (M3 fix) _fallbackSynthesis 原在 results 声明前定义, 现移到此处
  const _fallbackSynthesis = (e) => {
    console.warn('[dispatcher] synthesis LLM failed:', e && e.message);
    // 2026-10-13: 同 _subConclusionFallback —— 标题用角色名, 不用 planner 写给子 agent 的指令
    // (cleanTask 只剥了 "\n\n【重要】" 尾巴, "不作卦象分析" 这类指令原样留着)。
    const parts = results.map((r, i) => {
      const body = (r.result && r.result.summary) || ('⚠️ 该子任务失败: ' + (r.error || '无结果'));
      return `### ${i + 1}. ${String(r.agent || '子任务')}\n\n${body}`;
    });
    return '## 各子任务结论汇总\n\n' + parts.join('\n\n---\n\n');
  };

  // 2026-09-18: guard 全拦时兜底 — 子任务真结论直接交付 (不甩"请重试", 不虚报完成)
  const _guardWithSubFallback = (q, primary) => {
    try {
      const { guardAnswer } = require('./answer_alignment');
      const g = guardAnswer(q, primary, _subConclusionFallback(results));
      if (!g.blocked) return g.text;
    } catch (_) {}
    const sub = _subConclusionFallback(results);
    return sub || primary || '本轮未形成与原问题匹配的可核验答案，请重试。';
  };

  // 2026-10-24 (第 77 批): 澄清文本的放行门 —— 主 agent 判「指代不明」时,
  // 它写的是**给主人的回问**, 不是「对原问题的答案」。
  //
  // 为什么词法对齐门不能审它: 那道门是给「答案」用的 ——
  // 它会拿主人原话跟答复比词面重叠, 并且把「主人问…」「我先确认现状」这类
  // 编排口吻判成编排泄漏。现场 (probe76b-decide) 那段反问正是这样被吃掉的:
  //   isAligned('这个项目该不该继续做, 值不值', 主agent原文) === false
  //   isOrchestrationLeak(主agent原文) === true   ← 「主人问」命中
  // ⇒ 主人看到的会是「本轮未形成与原问题匹配的可核验答案, 请重试。」
  //
  // 所以这一路换成**判据放行**: 先看这段到底是不是澄清(跟分类用的是同一份判据),
  // 是就放行, 不是就走原门。放行不是无条件的 —— 判据本身有语料夹具钉着。
  const _guardAllowClarification = (q, primary) => {
    try {
      const pv = require('./plan_verdict');
      if (pv.isClarification(primary)) {
        console.warn('[dispatcher] 澄清文本放行 (主 agent 判指代不明, 这是回问不是答案)');
        return String(primary || '').trim();
      }
    } catch (_) {}
    return _guardWithSubFallback(q, primary);
  };

  // 2026-10-23 第 61 批: 定稿流水线收成一次调用。
  //
  //   原来这一句在下面 5 处**一字不差地各写一遍**:
  //     await _factGate(_stripHistoryLeak(_guardWithSubFallback(
  //       userInput, _stripThink(finalText))), model, _chartEvidenceFrom(results));
  //   五处一样, 但**顺序是隐式的** —— 「先剥上文泄漏再过核验门」只存在于
  //   写这行的人脑子里。加一层包装或调一下顺序, 只改一处没人会发现。
  //   现在顺序是 final_pipeline.finalizeAnswer 这一个函数的行为, 有单测钉着。
  // guardFn: 可选的**替代对齐门**。只给「澄清」那条路用 (它的答复不是答案,
  // 见上面 _guardAllowClarification)。不给就走默认的 _guardWithSubFallback。
  const _finalize = async (text, evidence, guardFn) => {
    const fp = require('./final_pipeline');
    const gates = require('./answer_gates');
    return fp.finalizeAnswer({
      finalText: text,
      userInput,
      model,
      ask: gates.buildAskFn(_deps._callLLMForAgent, model),
      guardWithSubFallback: guardFn || _guardWithSubFallback,
      chartEvidence: evidence,
      logPrefix: '[dispatcher]',
    });
  };

  // 第 65 批: 四条综合路共用的一段 —— 综合 → 兜底 → 定稿核验 → 剥伪工具标记。
  //
  // 为什么要收成一处:
  //   这 5 步原来在 4 条综合路里**一字不差地各写一遍**。
  //   而 2026-10-12 那次「伪工具标记漏上屏」(leak-probe-20261012-1)的根因,
  //   正是「同一个修复只打了一半」—— 补了 fixed_flow, 忘了另外三条。
  //   抄一遍就多一处会漏的地方, 收成一处之后: 补一次补全四条。
  //
  // 主路径多出的两步 (_reconcileWithLedger / _deadAcceptanceNote) 留在调用点 ——
  //   那两条是主路径特有的对账, 不该硬塞给所有路。
  const _synthesizeAndFinalize = async (summaryMessages, mdl, resultsRef) => {
    // 2026-10-25 (第 86 批): 「上游只回思考」重试一次再兜底, 别的错误直接兜底。
    //   策略本身在模块级 `_synthesizeWithRetry` (纯函数, 有单测钉着)。
    //
    // ⚠ `_ft` 必须是 **let**: 下面两行会重新赋值它。
    //   第 86 批第一版写成了 `const` ⇒ 运行时
    //   `TypeError: Assignment to constant variable.` ⇒ **整轮收口炸掉**
    //   (现场 probe88: 合成都流完了, 收口抛异常, 主人什么都没收到)。
    //   ⇒ tests/synthesis-reasoning-only-20261025.test.js 的 C4 盯着这一行;
    //     那份测试还把**这个函数体原样抽出来 eval 跑**(D1~D4) ⇒ 出错那几行真被覆盖到。
    let _ft = await _synthesizeWithRetry(
      () => _synthesizeStreamText(summaryMessages, mdl, res, 'qian'),
      (e) => _fallbackSynthesis(e));
    _ft = await _finalize(_ft, _chartEvidenceFrom(resultsRef));
    _ft = _finalizeAnswerText(_ft, _childConclusions(resultsRef));
    return _ft;
  };

  // 第 65 批: 关键词兜底的收口 —— 原来在 dispatcher 里**一字不差地抄了两遍**
  // (3050 / 2918 字符, 只差一个变量声明顺序和一个三元表达式的写法)。
  //
  // 抄两遍的代价不是「难看」, 是 2026-10-16 那次现场:
  //   「Planner failed: LLM timeout 300s」→ 走这条兜底 → 答完了、也上屏了,
  //   **但父会话没落盘** ⇒ 刷新/重启整轮消失。
  //   两份里**两份都漏了** —— 因为「要落盘」是每份各自记住的, 而没有一份记得。
  //   现在收成一处: 落盘由 _closeOut 兜住, 不会再漏。
  const _keywordFallbackCloseOut = async (resultsRef) => {
    safeResWrite(res, 'status', { stage: 'synthesis', message: '盘古正在综合结果...' });
    // 第 87 批: 兜底路的料量也走同一个预算 (原来写死每刀 1500 / 总 15000, 与主路各算各的)。
    const _fbFixed = _synthesisFixedChars(sessionId, userInput, _historyBlock);
    const _fbBudget = _synthesisBudget(model, (resultsRef || []).length, _fbFixed);
    const toolHistorySummaries = _buildFallbackSummaries(resultsRef, _fbBudget.per);
    const summaryMessages = [
      // 第 89 批: system 消息跟主路走**同一个拼装点**。
      //   原来这条兜底路把禁令**合并**进提示词 (靠真源的 noRoleLabel 参数), 主路却是
      //   **两条独立** system 消息 ⇒ 同一句禁令两种挂法 (文案是同一份, 挂法是两份)。
      //   两种挂法都能把话送到模型面前, 但「改禁令只改一处」做不到:
      //   哪天给禁令加一句, 这条路会静默少拿一句 —— 而每条路单独看都通得过 ⇒ 测不出来。
      //   第 63 批收进真源的文案 (含「事实在前」)、第 87 批的覆盖面档, 这里一字没丢。
      ..._synthesisSystemMessages(userInput),
      { role: 'user', content: '主人问题：' + userInput + '\n\n' + (_historyBlock ? _historyBlock.replace(/^【上文/, '【上文') + '\n' : '') + _groundTruthBlock(sessionId) + '\n子任务工具执行结果：\n' + toolHistorySummaries.slice(0, _fbBudget.total), ...( _dialogImages.length ? { images: _dialogImages } : {}) }
    ];
    finalText = await _synthesizeAndFinalize(summaryMessages, model, resultsRef);
    safeResWrite(res, 'chunk', { delta: finalText });
    // 2026-08-02: 补 final 事件 (前端主气泡认 final, 只发 chunk 答案不上屏)
    // 2026-10-17: replace:true = 我是**处理后**的权威稿, 覆盖你刚才看到的流式原文。
    // 综合阶段现在会先把原文逐行流出去给人看 (owner 一直在等这段), 而收口还要对它
    // 做剥除/对账 —— 剥完往往更短。前端"流式更长就不换"那条规则会把剥除结果整个丢掉,
    // 伪工具标记和将灵代号标题就留在屏上了 (2026-10-16 `### executor` 漏出去的那条路)。
    safeResWrite(res, 'final', { text: finalText, replace: true });
    const fallbackTools = (Array.isArray(resultsRef) ? resultsRef : []).flatMap(r => {
      const used = r && r.result && r.result.toolsUsed;
      return Array.isArray(used) ? used : [];
    });
    const _kAdmits = _answerAdmitsIncomplete(finalText);
    if (_kAdmits) console.warn('[dispatcher] keyword_fallback 答复自认未完成 → 标 partial');
    _closeOut({
      status: _kAdmits ? 'partial' : undefined,
      success: !_kAdmits,
      rounds: 1,
      tools_used: fallbackTools,
      child_statuses: (Array.isArray(resultsRef) ? resultsRef : []).map(r => r.result && r.result.runtimeStatus).filter(Boolean),
      mode: 'keyword_fallback',
      result: finalText,
      note: '关键词兜底模式',
    }, { persistState: _kAdmits ? 'partial' : 'completed' });
    return finalText;
  };

  // 2026-09-16 老板拍: 续跑/消化类短指令 ("继续消化"/"继续"/"消化"/"把剩下的") 必须走 planner 真拆 —
  // 旧逻辑命中 skip_planner 固定流程或单 agent loop, 4 轮烧光就 silent failure。
  // 拆成 step 后 ③ 拆解状态机接管: 单步卡住不拖垮整轮, 断点可续。
  const _trimIn = String(userInput||'').trim();
  const _resumeIntent = /^(继续|再|接着|消化|补|跑|干|做完|剩余|下一步|按计划|按顺序|把剩余|继续消化)/.test(_trimIn);
  const _forcePlanner = _resumeIntent && _trimIn.length <= 30;

  // P1-2: skip_planner 角色 → 固定流程，不走 LLM Planner (续跑意图除外: 固定流程没上下文, 套了就是空跑)
  // The gua preamble is system-generated context, not the user's intent. Do
  // not let words such as "卦/判断" inside it trigger a fixed role route.
  const _routingInput = _stripGuaBlockForRouting(userInput);
  // 2026-10-17: 单刀直查判定放在**这里**, 不放在上面跟 _directAnswerTurn 并排 ——
  //   因为判据要按剥掉卦块后的长度算, 而卦块只有 _routingInput 剥得干净。
  //   【盘古起卦…】的方括号只包住第一行, 后面还跟着 ~150 字卦辞/爻辞/五行/六亲 正文,
  //   自己拿 /【[^】]*】/ 剥 → 剥不干净 → 主人一句 8 字的"北京天气"被顶成 160 字 →
  //   闸门第一道就拦掉 → 这条通道在生产里**一次都不会触发**。
  //   (护栏 S1 就是这么红的: 带卦块命中失败。判据自己剥卦块 = 抄了一份更差的实现。)
  const _singleShotTurn = (() => {
    if (_directAnswerTurn) return false;
    try { return require('./j2_loop_shared').wantsSingleShotLookup(_routingInput) === true; } catch (_) { return false; }
  })();
  // 2026-10-19: 单目标阅读 —— 「读这一个文件回答我」也算"一件事就完"。
  // 它和 _singleShotTurn 的**运行语义完全相同**(一个将灵 / 必须真调工具 / 不起 planner、
  // checker、综合), 所以并进同一条通道, 而不是新开一条。
  // 分开才是坑: 两条通道的收口/门禁/图标都得各修一遍, 而它们的差别只有"落点是外部事实
  // 还是本地文件"。差别用 stage 名字记就够了, 行为不该分叉。
  const _singleTargetTurn = (() => {
    if (_directAnswerTurn || _singleShotTurn) return false;
    try { return require('./j2_loop_shared').wantsSingleTargetRead(_routingInput) === true; } catch (_) { return false; }
  })();
  // 直答之外的"一件事"通道合流: 单刀直查(查外部) + 单目标阅读(读本地文件)
  const _oneShotTurn = _singleShotTurn || _singleTargetTurn;
  // 2026-10-09 (老板截图): 空输入守门 — 历史上 dispatcher 拿到空 userInput 照样分派子 agent,
  // 子 agent 收到空任务后只能到处试探(system_info/network_check/process_list), 表现成"工具空转"。
  // 实案 2026-10-08: task_checkpoint 里记成 `主人问题: ？` — 问题整个丢了。
  // 这里直接拒绝分派, 把问题退给主人, 好过让子 agent 空跑一轮烧 token。
  if (!String(userInput || '').trim()) {
    const _msg = '没收到你的问题内容(只有卦象块或空输入)。请把要问的话再发一次。';
    safeResWrite(res, 'chunk', { delta: _msg });
    safeResWrite(res, 'final', { text: _msg });
    _closeOut(
      { status: 'failed', rounds: 0, tools_used: [], mode: 'qian', result: _msg, note: 'empty user input' },
      // 空输入 = **拒收语**, 不是答复。落盘它会让下一轮上下文里多一句
      // 「请把要问的话再发一次」, 而主人那边一个字都没问。
      { persist: false, persistWhy: '空输入拒收语, 不是答复' },
    );
    try { res.end(); } catch (_) {}
    return;
  }
  // ==========================================================================
  // 2026-10-12 直答短路 (现场证据 probe-direct-2131, SSE 全量 dump):
  //   主人: "我叫王铁柱,只回答我的名字,不要调用任何工具"
  //   旧行为: 99 秒 / 21 次工具调用 / 起 planner→analyzer+executor+checker→synthesis 综合。
  //     ① 主人明说"不要工具", 工具照样调 21 次 —— 直答意图完全失效;
  //     ② checker 的 task 是空壳"验证结果"(问名字根本没有结果可验),
  //        无锚点 checker 自己找活干 → 去审计整个 git 工作区,
  //        把一份代码审计报告当 FAIL 结论;
  //     ③ checker 脚手架整段泄漏给主人 —— 问名字收到代码审计报告。
  //   根因: _directAnswerTurn 只喂 runtimeStatus 判分, 完全不参与派工。
  //   修法: 直答轮单 agent 直答 —— executor 带工具直接作答, 不起 planner/
  //        子 agent 编排/synthesis。保留工具能力("今天股价多少,直接答"仍要取数),
  //        只砍掉无谓编排。答案同样过 chartGate/guard/finalize, 不裸上屏。
  // ==========================================================================
  // 2026-10-17: 两种"一件事就完"的形态并到同一条通道, 但语义不同 ——
  //   ① _directAnswerTurn: 主人明说"别调工具/直接答" → executor + directAnswer (优先不调工具)
  //   ② _singleShotTurn:   一件短事实查询, 主人没说任何特殊措辞 → analyzer + **必须调工具**
  // ② 绝不能复用 directAnswer: 那个标志会注入"优先不调工具",
  // 而单刀查询要的恰恰是它去取数 —— 走错标志会让天气/股价这类问题**又变成零工具空答**
  // (跟 855fa63 修的那个 bug 同一个出口)。所以 ② 传 directAnswer:false,
  // 让"每次回复必须调用至少一个工具"那条硬规则继续生效, 只是不起 planner / checker / 综合。
  if (_directAnswerTurn || _oneShotTurn) {
    const _daMode = _oneShotTurn ? 'li' : 'kun';
    // 单刀查询要的是"能查到外部事实"的那套工具。
    // analyzer 白名单有 web_search / web_fetch / stock_* / crypto / currency, 但**没有**
    // weather_check / news_digest —— 那两个只在 checker 白名单里 (现场 q-1792180668162:
    // 取数的 analyzer 够不着 weather_check, 只好 exec_command curl 了 6 次)。
    // 这里补齐, 别让单刀查询退化成"没有专用工具 → 去 curl"。
    // 2026-10-18: 这里原来查的是 ROLES.executor —— 而 ROLES 拼音化之后键全是拼音,
    // .executor 恒 undefined, 所以 _daAllowed 恒 null, 下面 runAgentLoop 的
    // `Array.isArray(toolsAllowed) && toolsAllowed.length ? toolsAllowed : role.tools`
    // 每次都走兜底。**结果恰好是对的** (role = ROLES[_daMode='kun']),
    // 但那是撞对的, 不是算对的: 整段三元永远落不到, 一旦兜底条件变了就静默跑错将灵。
    // 而且它表达的身份 (executor) 运行时根本不认。直接写清 _daMode。
    const _daAllowed = _oneShotTurn
      ? _singleShotTools(subAgent)
      : ((((subAgent.ROLES || {})[_daMode] || {}).tools) || null);
    safeResWrite(res, 'status', {
      stage: _singleTargetTurn ? 'single_file' : (_oneShotTurn ? 'single_shot' : 'direct_answer'),
      message: _singleTargetTurn
        ? '单目标阅读, 一刀读完就答 (跳过 planner/checker 编排)...'
        : _oneShotTurn
        ? '单件事实查询, 单刀直查 (跳过 planner/checker 编排)...'
        : '直答模式, 单 agent 直接作答...',
    });
    const _daSid = sessionId + (_singleTargetTurn ? '#sub-single-file' : (_oneShotTurn ? '#sub-single-shot' : '#sub-direct-executor'));
    let _daText = '';
    let _daRaw = '';
    let _daTools = [];
    let _daHistory = []; // 子 agent 的工具结果 —— 出门核验门拿它当权威四柱的依据 (sub-agent.js 带回)
    let _daStatus = 'failed';
    try {
      const _daModel = _roleModelFor(configPath, _daMode, model);
      { const _gua = (subAgentRuns.CODE_TO_GUA || {})[_daMode]; safeResWrite(res, 'sub_agent_start', { agent: _daMode, gua: _gua || null, task: userInput, model: _daModel.id, session_id: _daSid, ts: Date.now() }); try { subAgentRuns.record({ kind: 'start', code: _daMode, task: userInput, model: _daModel.id, sessionId: _daSid }); } catch (_) {} }
      const _r = await subAgent.run({
        taskText: _historyBlock + userInput,
        mode: _daMode,
        configPath,
mainModel: model,  // 跟随本次运行主模型 (切换后不落后)
        // 直答标志**绝不能**给单目标阅读: 它会注入"优先不调工具",
        // 于是"读一个文件"变成零工具空答 —— 跟 855fa63 修的那个 bug 同一个出口。
        // 这里要的恰恰是它去 read_file 真读。
        directAnswer: !_oneShotTurn,
        reasoningEffort: opts.reqBody && opts.reqBody.reasoning_effort,
        toolsAllowed: _daAllowed,
        images: _dialogImages,
        res, sessionId: _daSid,
        parentSessionId: sessionId,          // 2026-10-14: 隔离只用于 abort/权限, 上下文继承父会话
        contextSeed: _ctxForSubagent('inline', userInput),
        onProgress: (e) => safeResWrite(res, 'sub_agent_progress', { agent: _daMode, task: userInput, ...e })
      });
      _daText = String((_r && (_r.summary || _r.finalText)) || '');
      _daRaw = _daText; // 剥壳前的原文, 收口兜底用(绝不用 userInput 顶答案 —— 那会把整块卦辞当答复上屏)
      _daTools = Array.isArray(_r && _r.toolsUsed) ? _r.toolsUsed : [];
      _daHistory = Array.isArray(_r && _r.data && _r.data.toolHistory) ? _r.data.toolHistory : [];
      _daStatus = String((_r && _r.runtimeStatus) || 'completed');
      safeResWrite(res, 'sub_agent_done', { agent: _daMode, gua: (subAgentRuns.CODE_TO_GUA || {})[_daMode] || null, task: userInput, session_id: _daSid, summary: _daText });
      try { subAgentRuns.record({ kind: 'done', code: _daMode, task: userInput, model: _daModel.id, sessionId: _daSid, summary: _daText }); } catch (_) {}
    } catch (e) {
      safeResWrite(res, 'sub_agent_error', { agent: _daMode, task: userInput, error: e.message });
      try { subAgentRuns.record({ kind: 'error', code: _daMode, task: userInput, model: (model && model.id) || '?', sessionId: _daSid, error: e.message }); } catch (_) {}
      _daText = _guardFinal(userInput, '直答失败: ' + e.message, '直答过程中出错。');
    }
    _daText = await _finalize(_daText, _daHistory);
    // 直答轮的答案天然可以很短 ("王铁柱" 3 个字就是真答案), _finalizeAnswerText 的
    // 10 字阈值会把它们当"空"拦掉并吐异常文案 —— 直答轮只要子 agent 给了实质答复就收。
    {
      let _daStripped = String(_daText || '');
      // 零宽字符能把 <tool_call> 伪装成 <tool_call> 逃过正则 —— 先剥零宽再剥标记
      _daStripped = _daStripped.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '');
      try { _daStripped = require('./j2_helpers')._stripPseudoToolMarkup(_daStripped); } catch (_) {}
      try { _daStripped = require('./j2_helpers')._stripSpecialTokens(_daStripped); } catch (_) {}
      _daStripped = _daStripped.trim();
      // 剥完还剩裸的 tool_result / tool_use_error 段 = 伪工具草稿泄漏, 不许上屏
      if (/<tool_result|tool_use_error|<tool_call|\"name\":\s*\"/i.test(_daStripped)) {
        console.warn('[dispatcher] direct_answer: 答复里仍有伪工具标记, 拦截不交付');
        _daStripped = '';
      }
      if (_daStripped.length >= 1) {
        _daText = _daStripped;
      } else {
        _daText = _finalizeAnswerText(_daText, _daRaw);
      }
    }
    safeResWrite(res, 'chunk', { delta: _daText });
    safeResWrite(res, 'final', { text: _daText });
    const _daAdmits = _answerAdmitsIncomplete(_daText);
    if (_daAdmits) console.warn('[dispatcher] ' + (_singleTargetTurn ? 'single_file' : (_oneShotTurn ? 'single_shot' : 'direct_answer')) + ' 答复自认未完成 → 标 partial');
    _closeOut({
      status: _daAdmits ? 'partial' : undefined,
      success: !_daAdmits,
      rounds: 1,
      tools_used: _daTools,
      child_statuses: [_daStatus],
      mode: _singleTargetTurn ? 'single_file' : (_oneShotTurn ? 'single_shot' : 'direct_answer'),
      result: _daText,
      note: _singleTargetTurn ? '单目标阅读 (无 planner/checker/综合)' : (_oneShotTurn ? '单刀直查 (无 planner/checker/综合)' : '直答单 agent'),
    }, { persistState: _daAdmits ? 'partial' : 'active' });
    try { res.end(); } catch (_) {}
    return;
  }

  const skipResult = _forcePlanner ? null : _matchSkipPlannerRole(_routingInput, configPath);
  if (skipResult) {
    safeResWrite(res, 'status', { stage: 'fixed_flow', message: '检测到固定流程任务 [' + skipResult.role + ']，直接执行...' });
    const fixedTasks = _buildFixedSubTasks(skipResult.fixed_agents, skipResult.fixed_tasks);
    safeResWrite(res, 'plan', { plan: fixedTasks, note: '固定流程 (skip_planner)' });

    // 2026-09-18 (实案 ×3: 固定任务扫了 pangu cwd, 没扫主人给的路径):
    // fixed_tasks 是模板, 不含主人原话路径。owner quote + 抽出的路径直接焊进 st.task,
    // 不再依赖 sub-agent.js 侧的 _hasQuote 兜底 (那边拿不到完整 prompt 上下文)。
    fixedTasks.forEach((st, _fi) => {
      st.task = _fixedTaskPrompt(st, _fi, fixedTasks.length, userInput, _historyBlock);
    });

    const _groups = _fixedFlowGroups(fixedTasks);
    for (let _gi = 0; _gi < _groups.length; _gi++) {
      const group = _groups[_gi].map(x => x.st);

      // 2026-09-16 老板拍: 子 agent 按职能配工具 — fixed_flow 也注入 ROLES.tools 白名单
      const _ffRole = (subAgent.ROLES && subAgent.ROLES[group[0].agent]) || null;
      const _ffTools = (_ffRole && Array.isArray(_ffRole.tools)) ? _ffRole.tools : null;
      const batchResults = await Promise.all(group.map(async (subTask, groupIndex) => {
        safeResWrite(res, 'status', { stage: 'sub_agent_start', agent: subTask.agent, task: subTask.task });
        const _ffModel = _roleModelFor(configPath, subTask.agent, model);
        // Each parallel fixed-flow worker needs its own abort domain. Sharing
        // the parent session makes J2's boundary guard abort sibling workers.
        const _ffSid = sessionId + '#sub-fixed-' + _groups[_gi][groupIndex].i + '-' + String(subTask.agent || 'agent');
        { const _gua = (subAgentRuns.CODE_TO_GUA || {})[subTask.agent]; safeResWrite(res, 'sub_agent_start', { agent: subTask.agent, gua: _gua || null, task: subTask.task, model: _ffModel.id, session_id: _ffSid, ts: Date.now() }); try { subAgentRuns.record({ kind: 'start', code: subTask.agent, task: subTask.task, model: _ffModel.id, sessionId: _ffSid }); } catch (_) {} }
        try {
          let r = await subAgent.run({
            taskText: subTask.task,
            mode: subTask.agent,
            configPath,
            res, sessionId: _ffSid,  // 每个固定流程 worker 独立 session (abort/权限域)
            parentSessionId: sessionId,  // 2026-10-14: 但上下文继承父会话 —— 隔离 ≠ 断链
            contextSeed: _ctxForSubagent('task', subTask.task),
mainModel: model,  // 跟随本次运行主模型 (切换后不落后)
            toolsAllowed: _ffTools,  // 2026-09-16: 职能白名单硬约束
            images: _dialogImages,   // 2026-10-12: 盘面/截图透传 — 子 agent 的独立证据源
            onProgress: (e) => safeResWrite(res, 'sub_agent_progress', { agent: subTask.agent, task: subTask.task, ...e })
          });
          // 2026-10-12 (会话 80922578 根修·纠错纪律的机制层): 纠错轮里子 agent 给出
          // "无依据改口" (顺从措辞 + 0 工具 + 无可核验来源) 不允许直接进综合 ——
          // 强制复核一轮 (任务里焊死二选一: 给可核验依据, 或如实列缺项);
          // 复核后仍是空翻面 → 用"维持待定"的诚实文案顶替, 不许谄媚结论上屏。
          if (_isCorrTurn && r && isBareFlip(r.summary, r.toolsUsed)) {
            safeResWrite(res, 'status', { stage: 'correction_recheck', agent: subTask.agent, message: '答复被判为无依据改口, 强制复核一轮' });
            try { subAgentRuns.record({ kind: 'start', code: subTask.agent, task: subTask.task + ' [纠错复核]', model: _ffModel.id, sessionId: _ffSid + '-recheck' }); } catch (_) {}
            const _recheckTask = subTask.task + '\n\n【复核纪律 — 系统强制】你上一轮答复被判为"无依据改口" (只有顺从措辞, 没有可核验来源)。本轮二选一: ①引用可核验来源 (盘面原文/工具返回/文件内容) 给出维持或改口的依据; ②手上没有独立依据就如实列出"要定论还缺什么"。禁止只顺着主人的话翻面。';
            let r2 = null;
            try {
              r2 = await subAgent.run({
                taskText: _recheckTask,
                mode: subTask.agent,
                configPath,
                res, sessionId: _ffSid + '-recheck',
                parentSessionId: sessionId,  // 2026-10-14: 复核轮同样继承父会话上下文
                contextSeed: _ctxForSubagent('task', _recheckTask),
mainModel: model,  // 跟随本次运行主模型 (切换后不落后)
                toolsAllowed: _ffTools,
                images: _dialogImages,
                onProgress: (e) => safeResWrite(res, 'sub_agent_progress', { agent: subTask.agent, task: subTask.task, recheck: true, ...e })
              });
              try { subAgentRuns.record({ kind: 'done', code: subTask.agent, task: _recheckTask, model: _ffModel.id, sessionId: _ffSid + '-recheck', summary: r2 && r2.summary }); } catch (_) {}
            } catch (eR) {
              try { subAgentRuns.record({ kind: 'error', code: subTask.agent, task: _recheckTask, model: _ffModel.id, sessionId: _ffSid + '-recheck', error: eR.message }); } catch (_) {}
            }
            if (r2 && !isBareFlip(r2.summary, r2.toolsUsed)) {
              r = r2; // 复核给出了依据/缺项, 采信复核版
            } else {
              r = { ...(r || {}),
                summary: '该题目前缺乏可独立核验的依据, 两次作答均未提供新证据, 结论维持待定、不随最新一句话翻面。要定论需要补充可核验来源 (原始盘面/出生信息/原始数据)。',
                runtimeStatus: (r && r.runtimeStatus) || 'failed',
                toolsUsed: (r && r.toolsUsed) || [] };
            }
          }
          safeResWrite(res, 'sub_agent_done', { agent: subTask.agent, gua: (subAgentRuns.CODE_TO_GUA || {})[subTask.agent] || null, task: subTask.task, session_id: _ffSid, summary: r.summary }); try { subAgentRuns.record({ kind: 'done', code: subTask.agent, task: subTask.task, model: _ffModel.id, sessionId: _ffSid, summary: r.summary }); } catch (_) {}
          return { agent: subTask.agent, task: subTask.task, result: r };
        } catch (e) {
          safeResWrite(res, 'sub_agent_error', { agent: subTask.agent, gua: (subAgentRuns.CODE_TO_GUA || {})[subTask.agent] || null, task: subTask.task, session_id: _ffSid, error: e.message }); try { subAgentRuns.record({ kind: 'error', code: subTask.agent, task: subTask.task, model: _ffModel.id, sessionId: _ffSid, error: e.message }); } catch (_) {}
          return { agent: subTask.agent, task: subTask.task, error: e.message };
        }
      }));
      results.push(...batchResults);
      // 2026-08-02: 配额快速失败 — 首批全部死于 429 时不再烧后续子任务和综合 LLM
      const _INFRA_RE = /HTTP 429|AccountQuotaExceeded|rate_limit_error|Token Plan 用量上限|usage quota|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/i;
      // 2026-10-25 (第 84 批): 别再**全文扫汇报**。
      //   原来: _INFRA_RE.test(r.error || 汇报全文) —— 汇报里只要**提到**这些字符串就算命中。
      //   现场 (2026-10-25): 一份**八字排盘**汇报里出现 `eNotFound` (第 567 字),
      //   整份报告就被当成「配额/网络挂了就整轮丢」。
      //   ⇒ 现在分两路:
      //     · `r.error` 是**机器字段** —— 那就是真错误, 全文扫是对的;
      //     · 汇报正文只扫**头部一行** (机器错误文案就在那儿, 详见 modules/slice_death.js)。
      const _infraHit = (r) => {
        const errText = String((r && r.error) || '');
        if (errText && _INFRA_RE.test(errText)) return true;
        const sum = String((r && r.result && (r.result.summary || r.result.finalText)) || '');
        if (!sum) return false;
        return _INFRA_RE.test(_headLine(sum));
      };
      const _quotaHit = batchResults.find(r => _infraHit(r));
      const _ffAllDead = (r) => _infraHit(r) || _sliceIsDead(r);
      // 2026-10-16: 门加一条 —— 已经有产出落盘就不许整轮丢 (见 _shouldFastFail 注释)
      const _ffAllDeadBatch = batchResults.every(_ffAllDead);
      const _ffFail = _shouldFastFail(batchResults, results, _ffAllDead);
      if (_quotaHit && _ffAllDeadBatch && !_ffFail) {
        console.warn('[dispatcher] fixed_flow 本批基础设施全挂, 但已有产出落盘 → 降级如实汇报, 不整轮判死');
      }
      if (_quotaHit && _ffFail) {
        const _m = String(_quotaHit.error || '').match(/reset at ([0-9\-: +]+(?:CST|UTC|GMT)?[0-9:+]*)/i);
        const _rawErr = String(_quotaHit.error || (_quotaHit.result && _quotaHit.result.summary) || '');
        const _isQuota = /HTTP 429|AccountQuotaExceeded|rate_limit_error|Token Plan 用量上限|usage quota/i.test(_rawErr);
        // 2026-10-19: 建议模型名改从真源取 —— 这里原来手抄 "qwen3.6-35b",
        // 那个模型在配置里**不存在** (会话 59740796: 照着报错去设置里找, 查无此模型)。
        // 跟 j2_loop_shared 的 _suggestModels 同一个修法, 同源手抄就要一起改。
        const _suggest = (() => {
          try {
            const _cfgPath = require('../config/node_config').resolveNodeConfigPathOrEmpty();
            if (!_cfgPath) return '见「设置」里已启用的模型';
            const _cfg = JSON.parse(require('fs').readFileSync(_cfgPath, 'utf8'));
            const _chain = ((_cfg || {}).llm || {}).fallback_chain || [];
            if (_chain.length) return _chain.join(' / ');
            return (((_cfg || {}).llm || {}).models || [])
              .filter((x) => x && x.enabled !== false && x.id).slice(0, 3)
              .map((x) => x.id).join(' / ');
          } catch (_) { return '见「设置」里已启用的模型'; }
        })();
        const q = _isQuota
          ? '⚠️ 模型 ' + (model && model.id || '?') + ' 额度已耗尽 (HTTP 429)。' + (_m ? '配额重置时间: ' + _m[1].trim() + '。' : '') + '恢复前该模型所有请求都会失败 — 请在「设置」切换到其他模型 (' + _suggest + '), 或等配额重置后再试。'
          : '⚠️ 模型 ' + (model && model.id || '?') + ' 端点连不上: ' + _rawErr.slice(0, 120) + ' — 已重试仍失败。请检查网络/DNS, 或在「设置」切换到其他模型 (' + _suggest + ')。';
        const guardedQ = _guardFinal(userInput, q, '当前模型不可用，未能完成原问题。');
        safeResWrite(res, 'final', { text: guardedQ });
        _closeOut(
          { status: 'failed', rounds: 1, tools_used: [], mode: 'fixed_flow', result: guardedQ, note: 'quota fast-fail' },
          { persistState: 'failed' },
        );
        return;
      }
    }

    safeResWrite(res, 'status', { stage: 'synthesis', message: '盘古正在综合各子 agent 结果...' });
    //
    // 第 87 批: fixed_flow 改走 `_buildSynthesisMessages` 真源。
    //   原来它自己内联了一套 (每刀 `slice(0, 3000)` + 总 `slice(0, 15000)`),
    //   于是: ① 砍头 (主路已修, 这条没修 —— 「同一个修复只打了一半」第二例);
    //        ② 连 2026-10-22 的「排盘断言核验」都没走 (那个守卫在 `_buildSynthesisInput` 里);
    //        ③ 它的综合 system prompt 用的是「合并写法」(把 noRoleLabel 拼进同一段),
    //           与真源的分条写法不同源。
    //   ⇒ 一条路一处写法, 以后改真源还是会漏。现在只有一处。
    const _ffFixedChars = _synthesisFixedChars(sessionId, userInput, _historyBlock);
    const _ffPerAgent = _synthesisBudget(model, results.length, _ffFixedChars).per;
    const summaryMessages = truncateMessagesForContext(
      _buildSynthesisMessages(sessionId, userInput, _historyBlock, results, _ffPerAgent, _dialogImages), model, 2048);

    // 第 65 批: 这 5 步 (综合 → 兜底 → 定稿核验 → 剥伪工具标记) 收进 _synthesizeAndFinalize。
    //   2026-10-12 (leak-probe-20261012-1 实案) 的根因就在这儿: fixed_flow 收口漏剥伪工具标记,
    //   synthesis LLM 把 <tool_call><mm:think> 整段草稿原样喷上屏 ——
    //   因为主路径 2026-09-14 #12 已经加过, 这里「补齐」了, 而**同一个修复只打了一半**。
    //   收成一处之后: 补一次补全四条, 不再有「打了一半」这回事。
    finalText = await _synthesizeAndFinalize(summaryMessages, model, results);
    safeResWrite(res, 'chunk', { delta: finalText });
  // 2026-08-02: 补 final 事件 (前端主气泡认 final, 只发 chunk 答案不上屏)
  // 2026-10-17: replace:true = 我是**处理后**的权威稿, 覆盖你刚才看到的流式原文。
  // 综合阶段现在会先把原文逐行流出去给人看 (owner 一直在等这段), 而收口还要对它
  // 做剥除/对账 —— 剥完往往更短。前端"流式更长就不换"那条规则会把剥除结果整个丢掉,
  // 伪工具标记和将灵代号标题就留在屏上了 (2026-10-16 `### executor` 漏出去的那条路)。
  // 这四条路径都紧跟在 _synthesizeStreamText 后面 —— 只有它们真的流出过原文, 才需要这个位。
  safeResWrite(res, 'final', { text: finalText, replace: true });
    const fixedTools = results.flatMap(r => {
      const used = r && r.result && r.result.toolsUsed;
      return Array.isArray(used) ? used : [];
    });
      // 2026-10-12 P1 (会话 75738498 实锤): fixed_flow 成功分支直接 return, 漏了 _persistParent
      // —— 只有 quota/acceptance 失败的几条路径落盘, 正常答完的 fixed_flow 对话在磁盘上不存在,
      // 刷新/重启即丢 (outcomes 里留下 status=partial / dispatcher_mode=fixed_flow 的空壳)。
      // 2026-10-25 (第 85 批 d): 原来这里**手抄了一份**失败词正则做全文扫 ——
      //   跟拆解轮的 `_isChildFailure` 是同一个病 (长源码分析报告被当成「这一刀失败」),
      //   85c 只治好了拆解轮那一侧, fixed_flow 这侧照旧误伤。
      //   现在两条路径共用 `_childTextFailure`: 一份词表 + 一套位置规则。
      const _ffChildFailed = results.some(r => r.error || (r.result && r.result.runtimeStatus === 'failed')
        || _childTextFailure((r.result && r.result.summary) || ''));
      // 2026-10-12 (sustained-01-20261012): 答复原文自认没做完, 徽章不许亮绿。
      // 原来只查子 agent summary, 老板实际看到的 finalText 从来没进过判据。
      const _ffAdmits = _answerAdmitsIncomplete(finalText);
      if (_ffAdmits) console.warn('[dispatcher] 答复自认未完成 → 收口标 partial (不虚报 completed)');
      const _ffFailed = _ffChildFailed || _ffAdmits;
      _closeOut({ rounds: fixedTasks.length, tools_used: fixedTools, child_statuses: results.map(r => r.result && r.result.runtimeStatus).filter(Boolean), mode: 'fixed_flow', result: finalText, note: '固定流程模式', status: _ffFailed ? 'partial' : undefined, success: !_ffFailed },
        { persistState: _ffFailed ? 'partial' : 'completed' });
    return;
  }

  safeResWrite(res, 'status', { stage: 'kan', message: '盘古正在规划任务...' });

  let plan;
  // 2026-10-17 (老板拍: 「乾就应该把任务拆了, 分下去」):
  // 原来这道题只有坎·planner 能答 —— 一次独立的全上下文推理, 实测 115s 里 113s 在思考,
  // 而它要输出的只是一个拆解。更贵的是**它没有决定权**: 拆几刀、派给谁, 全由坎
  // 一个额外角色说了算, 主 agent (乾) 站在编排链外面。
  //
  // 现在: 主 agent 先拆。它有全部上下文 (主人的原话 + 同会话上文 + 将灵已有产出),
  // 拆得出来就直接用它的方案; 拆不出来 / 没拆, 才轮到规则快路 → 坎 → 关键词兜底。
  //
  // 用 planOnly 而不是让它真跑: 派发和收口 (DAG 调度 / 并发闸门 / 合成 / 对账 /
  // 验收闭环 / 补救轮) 全留在下面那条成熟路径上, 一个字不动。主 agent 只负责
  // **决定拆什么**, 执行仍然走既有机制 —— 这是把决定权交回去, 不是把机制重写一遍。
  // 那些验收闭环是 2026-09-14 以来一整套现场修出来的 (三命通会 04/05 缺失仍报
  // success 等), 为"把决定权交回去"去动它们是拿真功能换抽象上的整齐。
  //
  // 2026-10-24 (第 77 批): 拆解轮的**结论**也要留下来。
  //   原来拆解轮只有一个出口 —— 派出的刀。刀没派出来时, 它说了什么(拆不动? 指代不明?)
  //   全被丢掉, 于是 dispatcher 只能「再买一次 planner」, 而那第二次买的结论
  //   往往跟第一次一样, 于是白等一轮 (现场 139 秒一刀)。
  let _planVerdict = null;
  // 拆解轮的原话 —— 必须在**外层**留一份, 不许只在闭包里拿着。
  //
  // 2026-10-24 (第 77 批, 实跑 probe76b-decide 第二次):
  //   `_planResult` 是 `_planViaMainAgent` 闭包里的 let, 出了那个函数就没了。
  //   分类那一行 (在闭包内) 读它没事; 但 B 类分支 (在闭包外) 读它 ⇒
  //   **ReferenceError: _planResult is not defined** ⇒ 整个 dispatcher 抛出去 ⇒
  //   主人这一轮 32 帧 sub_agent_progress、**一个 final 都没有**, 又白等一场。
  //
  // 为什么单测没抓到: 单测断言的是**源码文本**(分支里写了什么), 不是**作用域**。
  //   「引用了一个只存在于闭包里的变量」在文本上完全合法 ⇒ 假绿。
  // ⇒ 规矩: 跨闭包传值只走**外层声明**的变量 (`_planVerdict` / `_planFinalText`),
  //   闭包内的 `_planResult` 只许在闭包内用。
  let _planFinalText = '';
  const _planViaMainAgent = async () => {
    const _PLAN_TOOLS = ['dispatch_subagents'];
    const _planTask = (typeof _historyBlock === 'string' ? _historyBlock : '') + userInput;
    // 预算必须**合并进 model 对象**, 不能只写进 opts: llm_caller 认的是
    // useModel.reasoning_effort, 而 j2_agent_loop 全程不读 opts.reasoning_effort。
    // 现场与证据见 tests/delivery-truth-20261019.test.js 的 G4。
    // UI 的推理强度选择器把「自动」写成 'auto' (ChatRoom.jsx:1223), 它是**界面占位**,
    // 不是 API 值: 直接透传会让 LM Studio 直接 400
    // ("Invalid 'reasoning_effort' value: 'auto'"), 整轮死掉。落到 low。
    const _planEffortRaw = (opts.reqBody && opts.reqBody.reasoning_effort) || '';
    const _planEffort = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(_planEffortRaw)
      ? _planEffortRaw
      : 'low';
    const _planModel = (model && typeof model === 'object') ? { ...model, reasoning_effort: _planEffort } : model;
    const _planMessages = [
      { role: 'system', content: '你是 Pangu 的主 agent (乾), 这一轮**只**负责一件事: 把主人的任务拆成 2~6 个互不相干的子任务, 并派出去。\n\n'
        + '【铁律】\n'
        + '① 只能调 dispatch_subagents 一个工具, 不许调别的, 不许自己动手做。\n'
        + '② 每一刀的 task 必须自足 (做什么 / 看哪些绝对路径 / 交付什么), 不许写「同上」「按上面」。\n'
        + '③ 路径逐字照抄主人的原话。\n'
        + '④ 互不相干的刀 depends_on 留空 (它们会并行); 后一刀要用前一刀的结论才写 depends_on。\n'
        + '⑤ 拆不动 (一件事就完) 就**不要调工具**, 直接说「拆不动」。\n'
        + '⑥ 派完就结束, 不要输出文字分析 —— 这一轮不执行, 执行方接手。\n'
        + '⑦ 如果主人的话**指代不明**(没说清是哪个项目/文件/对象), 在「拆不动」后面**用第二人称把要问主人的话写出来**'
        + '(例如「你说的『这个项目』是哪一个? 说个名字或路径我就接着做」), 不要提子 agent/派活/拆解这些内部说法。' },
      { role: 'user', content: _planTask },
    ];
    let _captured = null;
    let _planResult = null;
    try {
      // 写 sink res: 拆解过程的编排旁白绝不能进主气泡。
      // 2026-10-24 (第 77 批, 实跑 probe76b-decide): **返回值必须接住**。
      // 原来这里是裸 await —— 返回值被丢掉, 于是主 agent 那一轮说了什么
      // dispatcher 一点都不知道: 「拆不动」这三个字连同它的理由一起消失。
      // 现场代价: 主 agent 明明判了「指代不明, 需要主人先点一下是哪个项目」,
      // 盘古却接着买了第二次坎·planner, 派了个 li 去「探索项目全貌」——
      // 146 帧没有一个 final, 主人这一轮什么都没拿到。
      _planResult = await j2AgentLoop._runAgentLoopLegacyStream(_planMessages, _planModel, req,
        _makeSinkRes(res, 'kan', userInput),
        {
          userInput: _planTask,
          reqBody: opts.reqBody || {},
          sessionId: sessionId + '#main-plan',
          role: 'main',
          // 2026-10-25 (第 82 批): **soulTier='planner'** —— 拆解轮独立一档。
          //   role 仍然是 'main' (它决定 API schema / 工具白名单 / 只读边界 ——
          //   拆解轮必须能调 dispatch_subagents, 且不能受将灵只读边界约束),
          //   但提示词**不发 main 档**。
          //   现场 39268686 实测: 拆解轮那一轮 in=15366 token, 拿的是完整 main 档 soul
          //   (主人长期记忆 / 工具清单 / 自我进化 / 源码地图 / 关键路径速查 /
          //   Continual Harness / 持久目标) + 6358 字全局铁律 + 自我认知 +
          //   **跨会话上下文**(实测是兄弟刀 prompt, 带主人全量路径清单) +
          //   R18 (教它调 38 个它调不到的工具) + Native HARD RULE
          //   (要求调 risk_assessment —— 拆解轮 schema 里没有这个工具)。
          //   而它这一轮真能调的只有 2 个工具, 产出上限是"拆不拆 / 拆几刀"。
          soulTier: 'planner',
          toolsAllowed: _PLAN_TOOLS,
        // 2026-10-19 (四次实测 probe-1792370454/0699/1312/1334): 拆解刀**没设推理预算**,
        // 于是 llm_caller 的 `_reasoningBudgetInstruction` 返回 null (它只认
        // useModel.reasoning_effort), 本地模型完全自由发挥:
        //
        //   probe-1792371312  106s  ~6030 token  70 字符   status done
        //   probe-1792370699  377s  ~9690 token  269 字符  status incomplete
        //   probe-1792370454  120s  ~8828 token  192 字符  status incomplete
        //
        // 三次的活都是同一件: 「读一个文件, 列出它串联了几个将灵」。主 agent 花 100~380 秒
        // 和 6000~9700 token, 产出的答案是 **0 刀** —— 它只是需要回答"拆不拆"。
        // 8 次 main-pl 累计 308 小时 / 10 万 token, 平均 139 秒一刀。
        //
        // 为什么这一刀该给 low: 它的产出是一个**是/否 + 至多 6 行 JSON**, 不是需要权衡的
        // 判断。同一文件里 kun/li 都是 low —— 拿证据的活靠工具结果, 不靠推演; 拆解这刀
        // 连工具都不用, 只需要读一眼主人这句话能不能切。
        //
        // 注意别改成 _effortForRole('kan', ...): 那张表 kan='medium' (拆解质量是命根子)。
        // 但那是给**真要拆的活**的, 而这里 88% 的到场都只为了得出"拆不动" —— 主人已经
        // 把活写清楚的时候, 拆解质量不存在, 只存在代价。所以这里显式给 low, 不走角色表。
          // 2026-10-17 (首次实跑 q-1792248439788 的教训): 光传 toolsAllowed 不够 ——
          // main 默认走全套工具, 那一轮模型直接 read_file ×3 自己去读文件, 一刀都没派,
          // **且不报任何错**。enforce 才是"把它关进笼子"的那根开关。
          enforceToolFilter: true,
          suppressOutcomeRecord: true,
          planOnlyDispatch: true,
          onPlanned: (tasks) => { _captured = tasks; },
          reasoning_effort: opts.reqBody && opts.reqBody.reasoning_effort,
        });
    } catch (e) {
      console.warn('[dispatcher] 主 agent 拆解失败 (' + e.message + ') → 落到规则/坎');
      return null;
    }
    // 原话落到**外层**变量 (B 类分支要把它交回主人)。
    _planFinalText = (_planResult && _planResult.finalText) || '';
    // 拆解轮的结论分类: B 指代不明 / A 一件事就完 / 其它(含空)。
    // 真源在 plan_verdict (有 81 条现场语料夹具), 判据不在这里另写一份。
    try {
      const _pv = require('./plan_verdict');
      _planVerdict = _pv.classifyPlanVerdict(_planFinalText);
      console.warn('[dispatcher] 拆解轮结论: ' + _planVerdict.kind + ' (' + _planVerdict.reason + ')');
    } catch (e) {
      console.warn('[dispatcher] 拆解轮结论分类失败 (' + e.message + ') → 按「没表态」处理');
      _planVerdict = { kind: 'other', reason: '分类失败' };
    }
    if (!_captured || !Array.isArray(_captured) || _captured.length < 2) {
      console.warn('[dispatcher] 主 agent 没给出 ≥2 刀方案 → 落到规则/坎');
      return null;
    }
    return _captured;
  };
  const _mainPlan = await _planViaMainAgent();
  if (_mainPlan && _mainPlan.length >= 2) {
    plan = { subTasks: _mainPlan, source: 'main_agent' };
    console.warn('[dispatcher] 主 agent 自拆 ' + _mainPlan.length + ' 刀 (跳过坎·kan): '
      + _mainPlan.map((s) => s.agent).join(' → '));
    try { subAgentRuns.record({ kind: 'done', code: 'kan', task: userInput, model, sessionId, summary: '主 agent 自拆 ' + _mainPlan.length + ' 刀 (坎未调用)' }); } catch (_) {}
    // 2026-10-19 (老板: 「是出来了, 但是还是两个agent在跑」): 这条路的拆解过程走
    // _makeSinkRes(res,'kan',userInput), 逐帧转成 sub_agent_progress{agent:'kan'} ——
    // 而**从来不**发 sub_agent_done。前端认不到卡时的兜底是"按角色建一张 progressOnly 卡",
    // 于是凭空多出一张 status:'running' 的坎·拆, 没有任何事件能让它离开 running。
    // 现场 (会话 15764258): 答复完整上屏, 坎·拆/乾·调度 永远「运行中」, 面板虚报「已派 5 路」
    // (dispatcher 实际只派了 3 刀)。补上真收尾 —— 拆解确实干过活, 就该记完成。
    try {
      safeResWrite(res, 'sub_agent_done', {
        agent: 'kan', task: userInput, ts: Date.now(),
        summary: '拆出 ' + _mainPlan.length + ' 刀 (' + _mainPlan.map(s => s.agent).join(' → ') + ')',
      });
    } catch (_) { /* 收尾事件不许影响派发 */ }
  } else if (_planVerdict && _planVerdict.kind === 'B') {
    // ==========================================================================
    // 2026-10-24 (第 77 批, 实跑 probe76b-decide): 主 agent 判「指代不明」。
    //
    // 这条路原来**根本不存在** —— 拆解轮的原话被 await 丢掉, 于是:
    //   主人问「这个项目该不该继续做, 值不值」
    //   → 主 agent: 「指代不明, 拆不出自足的子任务。需要主人先点一下是哪个项目」
    //   → dispatcher: 看不见这句话 ⇒ 又买一次坎·planner ⇒ 派了个 li 去
    //     「探索当前工作目录下的项目全貌: 读 README、目录结构…」
    //   → 146 帧没有一个 final, 主人 9 分钟什么都没拿到。
    //
    // 现在: **不派任何子 agent**, 把主 agent 的反问交回主人。
    //   「这个项目」到底指哪个, 只有主人知道 —— 这是主 agent 的判断, 不是编排的活。
    //   交回反问本身就是一次交付 (所以走 _finalize + _closeOut, 落盘, 不是拒收)。
    // ==========================================================================
    const _pvB = require('./plan_verdict');
    const _bRaw = _pvB.toUserFacingClarification(_planFinalText);
    // 坎·拆那张卡得收尾 —— 拆解轮确实干过活 (它判了「指代不明」),
    // 不发终态事件的话, 前端那张 progressOnly 卡会永远停在「运行中」
    // (跟 2026-10-19 那次「答复完整上屏、坎·拆永远运行中」同一个坑)。
    try {
      safeResWrite(res, 'sub_agent_done', {
        agent: 'kan', task: userInput, ts: Date.now(),
        summary: '判定指代不明, 反问主人 (不派子 agent)',
      });
    } catch (_) { /* 收尾事件不许影响交付 */ }
    safeResWrite(res, 'status', { stage: 'clarify', message: '主人这句话指向不明, 正在回问...' });
    let _ft = '';
    let _finErr = null;
    // 澄清文本过定稿流水线, 但走**澄清放行门** (见 _guardAllowClarification):
    // 它是回问不是答案, 词法对齐门会把「主人问…」判成编排泄漏整段吃掉。
    //
    // 这一句必须**直接**写在交付出口所在的块里 (不许藏进 try/catch 或 helper):
    // 「每个交付出口都过了定稿流水线」那条判据是按**同块语句**数的 ——
    // 藏起来它就看不见, 于是判据变成假绿。
    _ft = await _finalize(_bRaw, [], _guardAllowClarification)
      .catch((e) => { _finErr = e; return _bRaw; });
    if (_finErr) console.warn('[dispatcher] 澄清收口失败 (' + _finErr.message + ') → 交主 agent 原话');
    if (!String(_ft || '').trim()) _ft = _bRaw;
    // 收口剥离 (伪工具标记 / 内部标记 / 空答复兜底) —— 跟其它交付路**同一套实现**。
    // 兜底文案: 主 agent 那句话要是剥完只剩几个字 (「指代不明」这种),
    // 主人拿到的是一句没头没尾的话 —— 那就换一句能回应的反问。
    _ft = _finalizeAnswerText(_ft,
      '你这句话指向不明, 我不知道该接哪一件事 —— 说个名字或路径, 我就接着做。');
    safeResWrite(res, 'chunk', { delta: _ft });
    safeResWrite(res, 'final', { text: _ft });
    const _bAdmits = _answerAdmitsIncomplete(_ft);
    if (_bAdmits) console.warn('[dispatcher] clarify 答复自认未完成 → 标 partial');
    _closeOut({
      status: _bAdmits ? 'partial' : undefined,
      success: !_bAdmits,
      rounds: 1,
      tools_used: [],
      child_statuses: [],
      mode: 'clarify',
      result: _ft,
      note: '主 agent 判指代不明, 反问主人 (不派子 agent)',
    }, { persistState: _bAdmits ? 'partial' : 'active' });
    try { res.end(); } catch (_) {}
    return;
  } else if (_planVerdict && _planVerdict.kind === 'A') {
    // ==========================================================================
    // 2026-10-24 (第 77 批): 主 agent 判「一件事就完」——**不再买第二次 planner**。
    //
    // 主 agent (乾) 拿的是全部上下文 (主人原话 + 同会话上文 + 将灵已有产出),
    // 它说拆不动, 后面再叫坎 (坎) 用同样的上下文再问一遍「拆得动吗」,
    // 得到的答案八成一样 —— 而这一问是 **139 秒一刀** (8 次 main-pl 平均 139s)。
    // 现场语料: 81 次拆解轮里 11 次主 agent 说「拆不动」, 其中 10 次真的一件活,
    // 1 次 (建 3 个文件) 规则拆分本来就能接。
    //
    // 省掉第二次规划之后: 规则拆分 (前面 _fastPlanFor 已试过) → 关键词兜底 → 单 agent。
    //
    // 2026-10-24 (第 78 批, 实跑 probe76-multi): **确定性拆分也不许跑**。
    //   主 agent 的原话是: 「拆不动。这是一条线性链（建 3 文件 → 逐个读回 → 写 summary.txt）,
    //   三步互相依赖、同一目录, **拆了反而要排队等依赖, 不如一口气做完**。」
    //   —— 这个判断是**对的**。而 dispatcher 转头就用规则拆分器把它切成了 3 刀:
    //     kun「创建 3 个文件」→ kun「每个写入不同的中文」→ dui「逐个读回确认」
    //   ① 第 2 刀**不自足** (没说"每个"是指谁) ⇒ 子 agent 只好**把 3 个文件重写一遍**;
    //   ② 三刀靠 depends_on **串行** ⇒ 一点并行都没换到, 只多付两次大上下文推理 (107s + 114s);
    //   ③ 结论就是主 agent 说的: 不如一口气做完。
    //   ⇒ 主 agent 说「拆不动」时, **不许用规则拆分器推翻它** ——
    //     规则拆分器是给「planner 被打挂、没人拆」兜底的, 不是给「有人拆过了」兜底的。
    //   落回: 关键词兜底 → 单 agent (一口气做完, 跟主 agent 的判断一致)。
    // ==========================================================================
    plan = null;
    console.warn('[dispatcher] 主 agent 判「一件事就完」→ 不再买坎·kan, 也不走确定性拆分 '
      + '(省一次规划推理 + 免掉规则拆出的串行重复活)');
    try {
      safeResWrite(res, 'sub_agent_done', {
        agent: 'kan', task: userInput, ts: Date.now(),
        summary: '判定一件事就完 (坎未调用)',
      });
    } catch (_) { /* 收尾事件不许影响派发 */ }
    try { subAgentRuns.record({ kind: 'done', code: 'kan', task: userInput, model, sessionId, summary: '主 agent 判一件事就完 (坎未调用)' }); } catch (_) {}
  } else {
  // 2026-10-16: 短机械活快路 —— 规则能拆出 ≥2 刀就直接拆, 省掉 planner 那次推理
  // (现场实测省 61.8s / 总 272.8s)。拆不出来或活不短, 一律原路给 planner。
  const _fastPlan = _fastPlanFor(userInput);
  if (_fastPlan) {
    plan = _fastPlan;
    try { subAgentRuns.record({ kind: 'done', code: 'kan', task: userInput, model, sessionId, summary: '规则快路: ' + plan.subTasks.length + ' 刀 (跳过 planner 调用)' }); } catch (_) {}
    console.warn('[dispatcher] 快路: 跳过 planner 调用, 规则拆成 '
      + plan.subTasks.length + ' 刀: ' + plan.subTasks.map(s => s.agent).join(' → '));
  }
  else try {
    // 2026-09-18: 坎·planner 拆动作也记入 subagent-runs (治坎永远 0)
    try { subAgentRuns.record({ kind: 'start', code: 'kan', task: userInput, model, sessionId }); } catch (_) {}
    plan = await subAgent.run({
      taskText: _historyBlock + userInput,
      mode: 'kan',
      configPath,
      parentSessionId: sessionId,     // 2026-10-14: planner 也要继承上下文, 别从零理解主人
      contextSeed: _ctxForSubagent('inline', userInput),
mainModel: model,  // 跟随本次运行主模型 (切换后不落后)
      // 2026-10-16: planner 必须报活性 —— 它是唯一一条会被 300s 墙砍掉的调用,
      // 也是主人唯一看不到"在干什么"的那几分钟 (屏幕上只有 heartbeat)。
      // 子 agent 现在流式了 (sub-agent.js callLLM), 这里把它报出来:
      // sub_thinking 会明确说"模型在思考, 已产 N 字", 别让主人以为卡死。
      onProgress: (e) => safeResWrite(res, 'sub_agent_progress', { agent: 'kan', task: userInput, ...e }),
      // Preserve the user's per-request reasoning choice for the planner;
      // otherwise local Qwen/LM Studio silently falls back to its xhigh default.
      // 2026-10-16: 主人没显式指定时, 本地 planner 走默认档 'medium' —— 见 _effortForRole
      // 的时间账 (planner 115s 里 113s 在思考, 而它只要输出一个 JSON)。
      reasoningEffort: _effortForRole('kan', model, opts.reqBody),
    });
    try { subAgentRuns.record({ kind: 'done', code: 'kan', task: userInput, model, sessionId, summary: (plan && plan.subTasks) ? ('拆出 ' + plan.subTasks.length + ' 个子任务') : 'planner done' }); } catch (_) {}
    // 同上: planner 真上场时也要有终态事件, 否则它那串 progress 帧建出来的卡同样悬空。
    try {
      safeResWrite(res, 'sub_agent_done', {
        agent: 'kan', task: userInput, ts: Date.now(),
        summary: (plan && plan.subTasks) ? ('拆出 ' + plan.subTasks.length + ' 刀') : 'planner done',
      });
    } catch (_) { /* 收尾事件不许影响派发 */ }
  } catch (e) {
    safeResWrite(res, 'error', { error: 'Planner failed: ' + e.message });
    // 2026-10-19: 这里原来只发 SSE 不收账本 —— 上面 1608 记的 kan 'start' 就永远没有
    // 配对的 done/error。现场 subagent-runs.jsonl: 86 组 start 悬空共 119 次, kan 占 54
    // (最多的一个)。悬空 start 的代价: 那一刀的 activeCount 只增不减, 界面上坎·拆
    // 永远显示"在跑", 而它其实早就炸了 —— 老板要看的"干过/在干"在这里直接说谎。
    // planner 失败也是**发生过的事**, 如实记 error, 不当没发生过。
    try { subAgentRuns.record({ kind: 'error', code: 'kan', task: userInput, model, sessionId, error: 'Planner failed: ' + String(e.message || e).slice(0, 300) }); } catch (_) {}
    // 2026-10-19: 账本记了 error, 界面那张坎·拆的卡却还开着 —— 悬空 start 的代价
    // 2026-10-19 已经付过一次 (86 组悬空, kan 占 54)。前端只认 SSE 事件, 不读账本,
    // 所以这里必须同时发终态事件, 否则「炸了」和「还在跑」在界面上长得一模一样。
    try {
      safeResWrite(res, 'sub_agent_error', {
        agent: 'kan', task: userInput, ts: Date.now(),
        error: '拆解失败: ' + String(e.message || e).slice(0, 300),
      });
    } catch (_) { /* 收尾事件不许影响兜底路由 */ }
    // P1-3: Planner 失败 → 关键词兜底
    const fallback = _routeWithL3(userInput, configPath);
    if (fallback) {
      safeResWrite(res, 'status', { stage: 'keyword_fallback', message: 'Planner 不可用，使用关键词路由到 [' + fallback.role + '] (' + fallback.matchedKws.join(', ') + ')' });
      try {
        const _fbRole = (subAgent.ROLES && subAgent.ROLES[fallback.role]) || null;
        const r = await subAgent.run({
          taskText: _historyBlock + userInput,
          mode: fallback.role,
          configPath,
mainModel: model,  // 跟随本次运行主模型 (切换后不落后)
          toolsAllowed: (_fbRole && Array.isArray(_fbRole.tools)) ? _fbRole.tools : null,  // 2026-09-16 职能白名单
          images: _dialogImages,  // 2026-10-12: 盘面/截图透传 (会话 80922578 根修)
          res, sessionId,  // 2026-09-14: 审批卡直达主人
          parentSessionId: sessionId,   // 2026-10-14: 兜底路径同样继承上下文
          contextSeed: _ctxForSubagent('inline', userInput),
          onProgress: (e) => safeResWrite(res, 'sub_agent_progress', { agent: fallback.role, task: userInput, ...e })
        });
        safeResWrite(res, 'sub_agent_done', { agent: fallback.role, task: userInput, summary: r.summary });
        results.push({ agent: fallback.role, task: userInput, result: r });
      } catch (e2) {
        safeResWrite(res, 'sub_agent_error', { agent: fallback.role, task: userInput, error: e2.message });
        return j2AgentLoop._runAgentLoopLegacyStream(messages, model, req, res, opts);
      }
      // 第 65 批: 这一整段 (综合 → 兜底 → 定稿 → 剥伪工具标记 → 上屏 → 落盘)
      //   原来在下面**一字不差地抄了两遍** (3050 / 2918 字符)。
      //   抄两遍的代价: 两份**都**漏了落盘 —— 2026-10-16 现场
      //   「Planner failed: LLM timeout 300s」走这条兜底, 答完了、上屏了,
      //   父会话却没落盘 ⇒ 刷新/重启整轮消失。
      //   2026-10-16 (老板: "子 agent ... 做好汇报") 的「汇报在前, 工具证据在后」
      //   那次改动也只打在了这两份里 —— 收成一处之后, 改一次两条路一起改。
      await _keywordFallbackCloseOut(results);
      return;
    }
    // 2026-10-16 (现场: 本地 qwen3.8-27b, "Planner failed: LLM timeout" 300s):
    // planner 是**非流式阻塞**调用, 本地模型没配 max_tokens → 输出上限兜底 32768,
    // 27B 解码 ~20 tok/s 光生成就能跑 27 分钟, 300s 的墙在第 6000 token 处砍掉它。
    // 砍掉之后旧码走关键词路由 (对"建 3 个文件"这种没有关键词的活必空) →
    // 退回 j2 主循环**单线程硬啃整件事**: 活能干完, 但没人拆、没人并行、没人汇报,
    // 主人全程看不见进度。这就是"跟死了一样"最纯的一种形态。
    //
    // 现在: 模型来不及拆的时候我们自己拆。拆不出来 (>1 刀) 就老实地退回原路 ——
    // 宁可慢, 也不给一个错的 plan。
    let _detPlan = null;
    try { _detPlan = require('./task_split').splitTask(userInput); } catch (_) {}
    if (_detPlan && _detPlan.subTasks.length >= 2) {
      plan = _detPlan;
      console.warn('[dispatcher] planner 失败 (' + e.message + ') → 确定性拆分接管, '
        + plan.subTasks.length + ' 刀: ' + plan.subTasks.map(s => s.agent).join(' → '));
    } else {
      return j2AgentLoop._runAgentLoopLegacyStream(messages, model, req, res, opts);
    }
  }
  }  // end else (主 agent 没拆出来 → 规则快路 / 坎·planner / 关键词兜底)

  let subTasks = (plan && plan.subTasks) || [];

  // planner 活着但交回空 plan —— 和"planner 被打挂"是同一个病: 没人拆, 于是
  // 单线程硬啃。这里同样让确定性拆分接管; 拆不出来 (>1 刀) 才走下面的关键词兜底。
  //
  // 2026-10-16 (现场 live-1792146487916, 本地 qwen3.8-27b): planner **交回了 3 刀**,
  // 于是上面那条"空 plan 就让规则拆"的路根本没被走到 —— 走的是 parsePlan 的硬编码
  // fallback: [analyzer「分析需求: 全文」/ executor「执行任务: 全文」/ checker「验证结果」]。
  // 三刀同一毫秒并发, 每刀都拿着**同一份任务全文**, 等于把同一件事让三个角色各干一遍,
  // 而事件流里"刀数=3、全并发"看着跟真拆解一模一样。
  //
  // planner 为什么会交回这种? 它的原文不是 JSON, 是一段**伪工具调用**:
  //   <tool_call><|im_start|>function=read_file>{"paths":[三个文件路径]}</function></tool_call>
  // —— 它想自己去读文件, 而不是规划。parsePlan 抓不到 subTasks → fallback。
  //
  // 所以判定条件不能只看"刀数是不是 0": fallback 交回的是 3 刀**看起来正常**的计划,
  // 必须认它自报的 data.fallback。宁可交给规则拆 (它至少按动作切句、按动词派角色),
  // 也不要拿三份重复全文当"拆解成果"交出去。
  const _isFakePlan = !!(plan && plan.data && plan.data.fallback);
  if (_isFakePlan) {
    console.warn('[dispatcher] planner 交回的是 parsePlan 兜底 (不是真拆解): '
      + subTasks.length + ' 刀全部是同一份任务全文的复述 → 交由确定性拆分接管');
  }
  // 2026-10-24 (第 78 批): 主 agent 已经判过「拆不动」时, **不许再拿规则拆分推翻它**。
  //   实跑现场见上面 A 分支的注释 (probe76-multi): 规则拆分把一条线性链切成 3 刀串行活,
  //   第 2 刀不自足 ⇒ 子 agent 把 3 个文件重写了一遍, 并行一分没换到。
  //   规则拆分器的定位是「planner 被打挂、没人拆」时的兜底 —— 主 agent 拆过了就不该它上。
  // 「主 agent 判拆不动 ⇒ 不许规则拆分推翻它」这条判据住在 plan_verdict (跟分类同源),
  // 不在这里另写一份 —— 分类和它的后果分家过一次, 代价是一次整轮白等。
  let _mainSaidNoSplit = false;
  try {
    const _pvRoute = require('./plan_verdict');
    _mainSaidNoSplit = !_pvRoute.shouldUseDeterministicSplit(_planVerdict);
  } catch (_) {
    _mainSaidNoSplit = !!(_planVerdict && _planVerdict.kind === 'A');
  }
  if ((!subTasks.length || _isFakePlan) && !_mainSaidNoSplit) {
    try {
      const _det = require('./task_split').splitTask(userInput);
      if (_det && _det.subTasks.length >= 2) {
        subTasks = _det.subTasks;
        plan = _det;
        console.warn('[dispatcher] planner 没交出真拆解 (' + (_isFakePlan ? 'parsePlan 兜底' : '空 plan')
          + ') → 确定性拆分接管, '
          + subTasks.length + ' 刀: ' + subTasks.map(s => s.agent).join(' → '));
      }
    } catch (_) {}
  } else if (_mainSaidNoSplit) {
    console.warn('[dispatcher] 主 agent 判「拆不动」→ 不用规则拆分推翻它, '
      + '落回关键词兜底/单 agent (一口气做完)');
  }
  // 2026-10-18: 旧实现在这里有四层兜底 —— depends_on 字段之外, 还从 task 文字里
  // 扒角色名、扒中文连接词、扒「第N步」编号, 全靠猜模型想说什么来排顺序。
  // 现在 depends_on 是唯一权威, 兑/乾 按定义排全部前置, 其余缺声明就**报出来**
  // (不猜)。缺声明是拆解的缺陷, 该让人看见, 不该由盘古替模型编一个。
  const _depResult = _inferDependsOn(subTasks, _looksSequentialPlan(userInput));
  if (_depResult.inferred) {
    console.log('[dispatcher] 按角色语义补出 ' + _depResult.inferred
      + ' 组依赖 (兑/乾 默认排在全部前置之后)');
  }
  if (_depResult.undeclared.length) {
    console.warn('[dispatcher] ⚠️ 拆解缺 depends_on 声明 '
      + _depResult.undeclared.length + '/' + subTasks.length + ' 刀: '
      + _depResult.undeclared.map((d) => '刀' + (d.i + 1) + '(' + d.agent + ')'
        + (d.why === 'aggregator_declared_empty' ? ' 收口刀却声明无依赖' : '')).join(', ')
      + ' —— 这些刀按独立并发处理。兑/乾 已自动排在前置之后, 其余刀若本该串行, '
      + '请让 planner 补 depends_on (提示词里已写死这是必填字段)。');
  }
  safeResWrite(res, 'plan', { plan: subTasks });
  // 2026-09-16 一期③ 拆解状态机: planner 拆出的子任务强制结构化落盘成 plan_state —
  // 压缩/重启/接续跑不再蒸发, ①状态卡 + ②交接卡 读它驱动验收。长任务 (子任务 ≥3 或带 depends_on) 必拆成 step。
  try {
    if (subTasks.length) {
      const _psMod = require('./plan_state');
      const _steps = subTasks.map((t, i) => ({
        id: 's' + (i + 1),
        title: (t.task || '').slice(0, 160) + ' @' + (t.agent || '?'),
        dod: t.dod || ('[' + (t.agent || '?') + '] 子任务完成并回传非空结论' + (Array.isArray(t.depends_on) && t.depends_on.length ? ' (依赖 s' + t.depends_on.map(d => d + 1).join(',s') + ')' : '')),
        status: 'pending',
      }));
      const _sr = _psMod.setPlan(sessionId, {
        goal: String(userInput || '').slice(0, 300),
        steps: _steps,
        current_step: 's1',
      });
      if (_sr.ok) console.log('[dispatcher-plan] ' + sessionId + ': ' + subTasks.length + ' 子任务已结构化落盘 plan_state (拆解状态机激活)');
    }
  } catch (_) { /* plan_state 未就绪不阻塞 dispatch */ }

  if (!subTasks.length) {
    // P1-3: Planner 返回空 → 关键词兜底
    const fallback = _routeWithL3(userInput, configPath);
    if (fallback) {
      safeResWrite(res, 'status', { stage: 'keyword_fallback', message: '规划为空，使用关键词路由到 [' + fallback.role + '] (' + fallback.matchedKws.join(', ') + ')' });
      try {
// #6: 用 j2_agent_loop 替代 sub-agent
        // 2026-09-14 (分派接通): 兜底分支同样注入角色 prompt — 将灵在哪条路上都得真上场
        const _fbRole = (subAgent.ROLES && subAgent.ROLES[fallback.role]) || null;
        const _fbRoleSys = _fbRole
          ? _fbRole.system.replace(/[^\n]*工具调用格式[^\n]*\n?/g, '') +
            '\n工具调用以本轮系统注入的格式为准 (function calling 或系统级 XML 协议), 禁止自创 <tool> 标签。'
          : '';
        if (_fbRole) console.log('[dispatcher] 将灵上场(兜底): ' + fallback.role);
        const _fbModel = _roleModelFor(configPath, fallback.role, model);
        if (_fbModel !== model) console.log('[dispatcher] 将灵(兜底) ' + fallback.role + ' → ' + _fbModel.id);
        const _fbMessages = _fbRoleSys
          ? [{ role: 'system', content: _fbRoleSys }, { role: 'user', content: userInput }]
          : [{ role: 'user', content: userInput }];
        const r = await j2AgentLoop._runAgentLoopLegacyStream(
          _fbMessages,
          _fbModel, req, _makeSinkRes(res, fallback.role, userInput),  // 2026-09-14: sink + 审批卡穿透(带将灵归属)
          { userInput, reqBody: opts.reqBody || {}, sessionId, suppressOutcomeRecord: true }
        );
        const _fbSummary = (r && r.finalText) || '';
        safeResWrite(res, 'sub_agent_done', { agent: fallback.role, task: userInput, summary: _fbSummary.slice(0, 500) });
        results.push({ agent: fallback.role, task: userInput, result: { summary: _fbSummary, data: {} } });
      } catch (e2) {
        safeResWrite(res, 'sub_agent_error', { agent: fallback.role, task: userInput, error: e2.message });
        return j2AgentLoop._runAgentLoopLegacyStream(messages, model, req, res, opts);
      }
      // 第 65 批: 同一段, 见上面那条注释 (原来这里抄了第二份)。
      await _keywordFallbackCloseOut(results);
      return;
    }
    safeResWrite(res, 'status', { stage: 'fallback', message: '规划为空且无关键词匹配，降级为单 agent 模式' });
    return j2AgentLoop._runAgentLoopLegacyStream(messages, model, req, res, opts);
  }

  // 子任务提示：要求每个 agent 返回有效总结，并在最后一轮直接总结
  for (const st of subTasks) {
    st.task = st.task + '\n\n【重要】请基于实际工具执行结果给出一段非空的总结文字（summary）。证据不足就继续调用工具去取, 不许在没拿到证据时下结论; 全部做完再收尾。';
  }

  // 2026-10-17: 派发引擎搬到 subagent_runner (主 agent 也要用同一份)。
  // 这里只留**收口政策**: 配额快速失败时整轮怎么跟主人交代。
  const _runner2 = createSubagentRunner({
    // req 必须透传: 子 loop 靠它接"主人关掉页面"事件, 不传的话关页面后
    // 子 agent 会继续烧 token 直到自己跑完 (这是从闭包搬出来时最容易丢的一根线)。
    req, res, sessionId, userInput, model, configPath, opts,
    subTasks, results,
    guaLine: _guaLine, dialogImages: _dialogImages,
    runSubAgentLoop: (msgs, mdl, rq, rs, op) => j2AgentLoop._runAgentLoopLegacyStream(msgs, mdl, rq, rs, op),
    safeResWrite, sc: _sc, ctxForSubagent: _ctxForSubagent,
    isSliceDead: _sliceIsDead,
    shouldFastFail: _shouldFastFail,
    onQuotaFastFail: (layerResults, kind) => {
      const q = (layerResults[0] && layerResults[0].result && layerResults[0].result.summary) || '';
      const guardedQ = _guardFinal(userInput, q, '当前模型不可用，未能完成原问题。');
      safeResWrite(res, 'final', { text: guardedQ });
      _closeOut(
        { status: 'failed', rounds: 1, tools_used: [], mode: 'qian', result: guardedQ, note: 'quota fast-fail (' + kind + ')' },
        { persistState: 'failed' },
      );
    },
  });
  const _runOneSubTask = _runner2.runOne;
  await _runner2.runAll();

  // 2026-09-14 (#11, 三命通会实测 11:23): checker 验收 FAIL (04/05 缺失) 但 dispatcher 照样
  // success:true 收口 — 验收结论只进了综合 prompt 的文字, 从没进状态裁决 = 综合层虚报完成。
  // 闭环: 验收 FAIL → 自动补救 (executor 补缺) → 复验 (checker) → 最多 2 轮;
  // 仍 FAIL 则诚实标 partial (success:false), 不许虚报 completed。
  // 2026-09-18 收窄: 旧 |缺失|缺少 太宽 (analyzer "扫描发现缺 02/06 编号" 也命中 → 误补救)。
  // 现在: 要么 验收 FAIL 语义明确, 要么 checker 真报 FAIL/未通过。
  // 2026-09-18 (实案: "把剩下的做完" → 验收 FAIL 误判 → 虚假补救 executor + 误报 partial):
  // 只有计划里真有 checker/验收 agent 才谈验收闭环; analyzer/executor 普通任务的
  // "对账拦截" 警告不再触发补救、不再把 success 打成 partial。
  const _checkerSubTask = subTasks.find(st => /checker|验收/.test(st.agent || ''));
  // 2026-10-13: 改用 _verdictOfChecker (读 checker 的明确结论, 而不是满篇扫失败词)。
  // 旧 _CHECKER_FAIL_RE 双向都错: 漏判 "**结论: FAIL**" 这类 markdown 形态的真失败,
  // 又把 "无未通过项" 这种 PASS 陈述误判成失败 → 白触发最多 2 轮补救重做。
  const _latestCheckerFail = () => {
    const cks = results.filter(r => /checker|验收/.test(r.agent || ''));
    const last = cks[cks.length - 1];
    return (last && last.result && _verdictOfChecker(last.result.summary || '') === 'fail') ? last : null;
  };
  let _remedyRound = 0;
  let _failHit = _checkerSubTask ? _latestCheckerFail() : null;
  while (_failHit && _remedyRound < 2) {
    _remedyRound++;
    console.warn('[dispatcher] 验收 FAIL → 自动补救轮 #' + _remedyRound + ': ' + (_failHit.result.summary || '').slice(0, 120));
    safeResWrite(res, 'status', { stage: 'remediation', message: '验收未通过, 盘古自动补齐缺失 (第 ' + _remedyRound + '/2 轮)...' });
    const _remedy = await _runOneSubTask({
      agent: 'kun',
      task: _buildRemedyTask(_remedyRound, (_failHit.result || {}).summary, userInput),
      depends_on: [],
    }, subTasks.length + _remedyRound * 2 - 2);
    results.push(_remedy);
    const _recheck = await _runOneSubTask({
      agent: 'dui',
      task: _checkerSubTask.task + '\n\n【复验 · 第' + _remedyRound + '轮】上一轮验收未过, 已按指摘做补救。请基于磁盘真实状态重新验收, 明确给出 PASS 或 FAIL 结论。',
      depends_on: [],
    }, subTasks.length + _remedyRound * 2 - 1);
    results.push(_recheck);
    _failHit = _latestCheckerFail();
  }
  const _acceptanceFailed = !!_failHit;
  if (_acceptanceFailed) console.warn('[dispatcher] 补救 2 轮后验收仍 FAIL → 收口标 partial, 不虚报 completed');
  // 2026-10-16 (lt3 现场, 5 步长任务 2190s): 计划里排了 checker, 它也确实被排进去了,
  // 但它自己撞上 ECONNRESET 死了 —— **一个字都没验**。老码 _verdictOfChecker 兜底扫不到
  // 失败词就 return 'pass', 于是"没验"被当成"验过了", 整轮收 success:true。
  // 计划里排了验收刀却没验成, 就不许说"全部完成": 诚实标 partial, 并把死因摆给主人看
  // (主人要修的是端点, 不是重做一遍已经做完的事)。
  const _unknownAcceptance = (() => {
    const cks = results.filter(r => /checker|验收/.test(r.agent || ''));
    const last = cks[cks.length - 1];
    return !!(last && _verdictOfChecker((last.result && last.result.summary) || '') === 'unknown');
  })();
  const _deadAcceptanceReason = (() => {
    const cks = results.filter(r => /checker|验收/.test(r.agent || ''));
    const last = cks[cks.length - 1];
    return String((last && last.result && last.result.summary) || last && last.error || '').slice(0, 160);
  })();
  if (_unknownAcceptance) console.warn('[dispatcher] 验收刀未给出任何结论 (端点/超时把它打死了) → 标 partial, 不虚报 completed: ' + _deadAcceptanceReason.slice(0, 80));
  // 话术在收口前就备好 —— 收口剥离到 chunk 写出之间只许 ≤6 行 (synthesis-leak 结构守卫)。
  const _deadAcceptanceNote = _unknownAcceptance
    ? '> ⚠️ **最后一步的独立复核没跑成** —— 验收那刀死在: ' + _deadAcceptanceReason
      + '\n> 上面这些产出是执行刀真写盘并核对过的（清单以账本为准）；盘古不把「没验成」记成「全部完成」,'
      + '也不用你重做已经做完的活 —— 把模型端点稳住, 单独复验一次即可。'
    : '';

  // 综合输出：让 LLM 基于 toolHistory 自己写 summary，不再依赖子 agent 的 finalText
  safeResWrite(res, 'status', { stage: 'synthesis', message: '盘古正在综合各子 agent 结果...' });

  // 2026-08-02 修: 子任务走 j2 loop 后 data.toolHistory 恒为空 — 综合输入改用子任务的真实 finalText,
  // 否则 LLM 只能拿 "stream done" 字符串瞎编
  // 2026-09-16 老板拍: 综合输入按 sub-agent 数量均分额度 — 9 个 sub-agent 时不再是"前 5 个吃满 15K, 后面全被砍"
  //   ↑ 这条**规则**一个字没改。改的是两处:
  //     ① 原来 `Math.min(3000, 15000 / n)` 里的 3000 硬顶 —— n ≤ 5 时它说了算,
  //        「均分」根本没发生 (现场 probe89: n=3, 额度 15000 只用了 9000, **6000 字没用**)。
  //     ② 总额 15000 是当时 32K 上下文时代的估法; 现在池子里 context_length
  //        65536 ~ 1048576, 15000 字 ≈ 5K token, 塞得下而**料不够**
  //        (现场 probe89: 三刀汇报合计 26690 字, 综合层只拿到 9000)。
  //   ⇒ 总额按**模型真实上下文**给, 15000 当**下限**不当上限 (第 87 批, `_synthesisBudget`)。
  const _fixedChars = _synthesisFixedChars(sessionId, userInput, _historyBlock);
  const _perAgentBudget = _synthesisBudget(model, results.length, _fixedChars).per;
  const summaryMessages = truncateMessagesForContext(
    // 第 87 批: 图也一起给 (2026-10-12 那个修复原先只在 fixed_flow 有, 主路没有)
    _buildSynthesisMessages(sessionId, userInput, _historyBlock, results, _perAgentBudget, _dialogImages), model, 2048);

  // 第 65 批: 公共 5 步 (综合 → 兜底 → 定稿核验 → 剥伪工具标记) 收进 _synthesizeAndFinalize。
  //   原来 4 条综合路各抄一遍, 于是 2026-10-12 那次「同一个修复只打了一半」才发生。
  //   主路径多出的两步 (_reconcileWithLedger / _deadAcceptanceNote) 留在下面 ——
  //   那两条是主路径特有的对账, 不该硬塞给所有路。
  finalText = await _synthesizeAndFinalize(summaryMessages, model, results);
  // 2026-10-16 (lt3): 验收刀死了这件事**必须摆到答复里**。综合 LLM 只看到 checker 那句
  // "端点连不上", 它会照着编一段像模像样的总结 —— 主人分不清是"活没干成"还是"验收没跑成",
  // 前者该重做, 后者该修端点, 弄反一次就白等 36 分钟。
  const _recon = _reconcileWithLedger(finalText, sessionId, _turnStartTs); finalText = _recon.text;
  if (_deadAcceptanceNote) finalText = String(finalText || '').trimEnd() + '\n\n' + _deadAcceptanceNote;
  safeResWrite(res, 'chunk', { delta: finalText });
  // 2026-08-02: 补 final 事件 (前端主气泡认 final, 只发 chunk 答案不上屏)
  // 2026-10-17: replace:true = 我是**处理后**的权威稿, 覆盖你刚才看到的流式原文。
  // 综合阶段现在会先把原文逐行流出去给人看 (owner 一直在等这段), 而收口还要对它
  // 做剥除/对账 —— 剥完往往更短。前端"流式更长就不换"那条规则会把剥除结果整个丢掉,
  // 伪工具标记和将灵代号标题就留在屏上了 (2026-10-16 `### executor` 漏出去的那条路)。
  // 这四条路径都紧跟在 _synthesizeStreamText 后面 —— 只有它们真的流出过原文, 才需要这个位。
  safeResWrite(res, 'final', { text: finalText, replace: true });
  const dispatcherTools = results.flatMap(r => (r && r.result && Array.isArray(r.result.toolsUsed)) ? r.result.toolsUsed : []);
  // #11: 验收 FAIL 时不许 verdict 给 completed — 显式 partial, success=false
  const _childFailures = results.filter(r => _isChildFailure(r, _directAnswerTurn)).map(r => ({ agent: r.agent, status: r.result && r.result.runtimeStatus, summary: String((r.result && r.result.summary) || r.error || '').slice(0, 500) }));
  // 2026-10-12 (sustained-01-20261012 同源): 答复自认没做完 → partial, 不许虚报 completed。
  // 账本矛盾时**账本决定口径**: 产物都写完了, 答案说「没写」是答案在辞不是任务没做。
  // 此时不能用「答案自认未完成」把已完成的任务错判成 partial
  // (也不能被刚插的纠正文案自身触发 —— 纠正文案里含「没写」等措辞。)
  const _admits = _recon.contradiction ? false : _answerAdmitsIncomplete(finalText);
  if (_recon.contradiction) console.warn('[dispatcher] 答案自认未完成但账本有产出 → 以账本为准, 不标 partial');
  if (_admits) console.warn('[dispatcher] 答复自认未完成 → 收口标 partial');
  // 2026-10-16 (现场 lt-after-221121, 云端 minimax-m3.1-flash, 改造后第一次跑):
  //   3×离 各读完自己那一个文件并如实汇报 → 兑只读汇报不出刀 (38.5s, 改前是 102s
  //   重读源文件) → 兑判 PASS → 乾合成。总耗时 250.6s → 220.3s。
  // 但收口仍报 `partial / success:false`, 四个刀全交卷。
  // 原因: 每个离的汇报里都有「③ 未做: 未读兄弟的文件 / 未执行相关测试(按指令不扩展)」,
  // 而 _INCOMPLETE_ADMISSION_RE 认「未执行」「未创建」「未读不到」这些词。**分工范围内
  // 没做 ≠ 任务没做完** —— 汇报契约要求子 agent 诚实披露边界, 分工制下那栏必然非空,
  // 干得越规矩越容易被判失败。
  //
  // 与上面账本那条同源: 已经有**独立验收刀**读过这些汇报并判 PASS 时, 答案正文里的
  // 免责从句不再有资格单方面推翻它 —— 兑读的就是这些汇报, 兑的结论才是口径。
  // 边界不动: 没有验收刀、或验收刀 FAIL/unknown 时, 自认未完成照样标 partial。
  const _acceptanceOverrides = _acceptanceOverridesAdmission(results, _acceptanceFailed, _unknownAcceptance);
  if (_admits && _acceptanceOverrides) {
    console.warn('[dispatcher] 答复含免责从句, 但验收刀已判 PASS → 以验收口径为准, 不标 partial');
  }
  const _admitsFinal = _acceptanceOverrides ? false : _admits;
  const _notComplete = _acceptanceFailed || _admitsFinal || _unknownAcceptance;
  // 2026-10-16 (lt-after-221727): 收口标 partial 时**必须说清是哪一条**。
  // 原来三个标志 (_acceptanceFailed / _admits / _unknownAcceptance) 里只有前两个会打日志,
  // _unknownAcceptance 一声不吭 —— 于是现场只见 `success:false` 查不到死因,
  // 只能靠猜 (这次就先把原因猜成了"兑没下裁决", 真因是另一条)。
  // 主人看不到内层日志, 这行是唯一能自证的部分。
  if (_notComplete) {
    console.warn('[dispatcher] 收口 partial: acceptance_failed=' + !!_acceptanceFailed
      + ' admits=' + !!_admitsFinal + ' unknown_acceptance=' + !!_unknownAcceptance
      + ' | 验收刀原文: ' + _deadAcceptanceReason.slice(0, 180));
  }
  _closeOut({ status: _notComplete ? 'partial' : undefined, success: !_notComplete, rounds: subTasks.length, tools_used: dispatcherTools, child_statuses: results.map(r => r.result && r.result.runtimeStatus).filter(Boolean), child_failures: _childFailures, mode: 'qian', result: finalText, acceptance_failed: _acceptanceFailed || undefined },
    { persistState: _notComplete ? 'partial' : 'completed' });

  // 2026-09-18: 艮·learner 自动沉淀 — 任务 done 后写一条经验记忆 (治艮 0)
  //
  // 2026-10-19 (老板: 「站在用户的角度看什么? 看子agent干过」): 这里原来是**假账** ——
  // 两行 record() 之间**什么都没做**, 没有 memory.write, 没有 gen.execute,
  // 就往盘古的运行账本上写死一句「已记录任务经验至长期记忆」。
  // 于是艮·gen 在 3799 条记录里拿了 458 次「干过」, 实际落盘 0 条 ——
  // 老板要看的恰恰是"干过", 而这一格是**编出来的**。
  //
  // 规矩: 账本只记真发生的事。写了 → done; 没写/写失败 → error 如实记。
  // 宁可账上少一条, 不可账上多一条假的 —— 假账比没账更坏, 它让"干过"两个字失效。
  try {
    const _learnerTask = '沉淀本次任务经验: ' + String(userInput).slice(0, 200) + ' → 结论: ' + String(finalText).slice(0, 200);
    subAgentRuns.record({ kind: 'start', code: 'gen', task: _learnerTask, model, sessionId });
    // 键带日期: 一轮一个键, 同一会话重跑覆盖而不是把账本滚成一条无限长的 append。
    const _memKey = 'task-experience:' + new Date().toISOString().slice(0, 10) + ':' + String(sessionId || 'nosession').slice(-24);
    let _memOk = false, _memErr = null;
    try {
      const _mem = require('./memory').getInstance();
      _memOk = await _mem.write(_memKey, { task: String(userInput).slice(0, 500), conclusion: String(finalText).slice(0, 800), ts: Date.now() }, { tags: ['task-experience'] });
    } catch (_me) { _memErr = _me.message; }
    if (_memOk) {
      subAgentRuns.record({ kind: 'done', code: 'gen', task: _learnerTask, model, sessionId, summary: '已写入长期记忆 ' + _memKey });
      console.log('[dispatcher] 艮·gen 已沉淀: ' + _memKey);
    } else {
      // 写不成就照实写 error —— 不许再出现"没写却记成功"。
      subAgentRuns.record({ kind: 'error', code: 'gen', task: _learnerTask, model, sessionId, error: '记忆写入失败: ' + (_memErr || 'memory.write 返回 false') });
      console.warn('[dispatcher] 艮·gen 沉淀失败 → 如实记 error, 不记成功');
    }
  } catch (_) {}
}


module.exports = {
  _buildDispatchRecord,
  _buildParentConvo,
  _answerContradictsLedger,
  _groundTruthCorrection,
  _NOTHING_PRODUCED_RE,
  _reconcileWithLedger,
  init,
  // 导出给回归测试直接验证 (context-continuity-20261012), 运行时路径不用它
  _buildHistoryBlock,
  _fixedTaskPrompt,
  _effortForRole,
  _ROLE_REASONING_DEFAULT,
  _fastPlanFor,
  _FAST_PLAN_MAX_CHARS,
  _makeSinkRes,
  _fixedFlowGroups,
  _stripHistoryLeak,
  _subConclusionFallback,
  _buildSynthesisInput,
  // 第 87 批: 交付保真 —— 导出给 tests/synthesis-fidelity-20261025.test.js
  //   (_trimKeepEnds 留两头 / _breadthDemand 主人原话判覆盖面 / _synthesisBudget 料量上限)
  _trimKeepEnds,
  _breadthDemand,
  _synthesisBudget,
  // 第 89 批: 固定块字数 —— 量真源真产物 (system 消息 + 注入块)。
  //   导出是因为它决定了「给料的位置」有多大, 而那个数字一旦算大就是**静默**地
  //   吃掉主人的答案 (算大 ⇒ 可变部分变小 ⇒ 答案被砍)。
  //   不导出就没法对它写断言 —— 「不可测的函数」等于「没人守的算法」。
  _synthesisFixedChars,
  // 第 89 批: 唯一拼装点 —— 导出给 tests/synth-prompt-single-20261023.test.js
  //   与 tests/subagent-activity-passthrough-20261016.test.js。
  //   守卫要能**逐字比对**「每条综合路径拿到的 system 消息」与「拼装点的产物」,
  //   只扫源码数调用点做不到这件事 (数的是抄本份数, 不是每条路径拿到了没有)。
  _synthesisSystemMessages,
  _buildDispatchRecord,
  _buildRemedyTask,
  _buildSynthesisMessages,
  _groundTruthBlock,
  _childConclusions,
  _finalizeAnswerText,
  _isChildFailure,
  _childTextFailure,
  // 2026-10-25 (第 86 批): 导出给 tests/synthesis-reasoning-only-20261025.test.js ——
  // 「上游只回思考 ⇒ 重试一次 ⇒ 再兜底」这条策略必须有测试守着。
  _synthesizeWithRetry,
  _answerAdmitsIncomplete,
  _acceptanceOverridesAdmission,
  _verdictOfChecker,
  _shouldFastFail,
  _sliceIsDead,
  _investedArtifacts,
  _SLICE_DEAD_RE,
  _stripGuaBlockForRouting,
  _singleShotTools,
  _ownerScopeBlock,
  _ownerPathScope,
  _extractOwnerPaths,
  _inferDependsOn,
  _looksSequentialPlan,
  _collectDialogImages,
  _runPanguDispatcherLoop: async function (messages, model, req, res, opts) {
    return _runPanguDispatcherLoop(messages, model, req, res, opts);
  },
};
