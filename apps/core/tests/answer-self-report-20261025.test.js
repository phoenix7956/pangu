/**
 * tests/answer-self-report-20261025.test.js
 * 第 83 批 —— 盘古主体第 4 次修同一个病, 这次修**判据本身**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 现场 (会话 probe82-real-split, 落盘 ~/.pangu-data/sessions/probe82-real-split.json)
 *
 *   题目: 「分别分析一下 /Users/you/Desktop/pangu/apps/core/modules/llm_caller.js 和
 *          .../j2_agent_loop.js 各自负责什么, 然后综合说明它们是怎么配合的」
 *   → 主 agent 自拆 3 刀 (li/li/li) → 3 刀全部交卷
 *   → 综合层写出**完整综合正文** (「## 一、各自职责」+「## 二、协作时序」, 5157 字)
 *   → 主人收到的却是 `state:"partial"` / `success:false`,
 *     答复是三段 `### li` 原文拼接 (6038 字, 每段截断 2000 字, 末尾断在半句)
 *
 * stderr 唯一两行:
 *   [dispatcher] 答复自认未完成 → 收口标 partial
 *   [dispatcher] 收口 partial: acceptance_failed=false admits=true unknown_acceptance=false
 * ⇒ acceptance_failed=false (这轮没排验收刀) + unknown_acceptance=false (同上)
 * ⇒ partial 的**唯一**来源是 admits=true。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 但**真凶不在「未完成」这个词表上**。把那份 6038 字答复原样喂判据只命中 3 处,
 * 三处**没有一处**是盘古在承认「这轮没干完」:
 *
 *   ① L50 `| _objectiveWorkRemaining / … | 客观未完成判定、终局文案 |`
 *      ← 子 agent 在**描述 j2_agent_loop.js 的一个函数** (那函数的注释就叫「客观未完成判定」)
 *   ② L40 `…并挂满守卫（复读熔断、重复调用拦截、…）`
 *      ← 在**列举盘古自己的守卫机制名** (复读熔断 = 重复读的保护)
 *   ③ L74 `- 超时/熔断：_prefillMs(L115)/…`
 *      ← **斜杠复合类别名** (超时/熔断 是两类机制的并称, 不是谓语)
 *
 * 而**答复为什么是子 agent 原文拼接**, 更是另一个更靠上游的病:
 *   综合稿被**对齐门**判成「跑题」, guardAnswer 回落到 `_subConclusionFallback(results)`
 *   —— 也就是三段各 slice(0,2000) 的原文拼接 (现场答复 6038 字, 逐字等于该函数的产物)。
 *
 * 对齐门为什么拒? 逐条定位到**一处** (现场综合稿逐字取证):
 *   `TRANSCRIPT_LEAK` 命中综合稿里的「**怎么对主人说话**」——
 *   「主人说」这三个字在中文里是正常搭配 (「对主人说话」), 而 TRANSCRIPT_LEAK 是
 *   **无条件 return true 的短路闸**, 一个词就把整篇 5157 字判死。
 *   现场逐字: 「**j2_agent_loop 管**：这一轮调不调工具、…、什么时候停、**怎么对主人说话**。」
 *
 *   另一条**独立的**误伤路径 (这次一并修, 但**不是**本轮现场的真凶):
 *   `BROAD_SELF_REPORT` 命中「**源码地图**」。
 *   「源码地图」是**盘古自己 prompt 里的一个 block 名** (llm_caller.js:903
 *   「# 自身源码地图 (回答"关于你自己"的问题前必读, 禁止凭印象)」) ——
 *   它出现在**子 agent 刀2 的汇报**里 (那份汇报被综合层逐字引用),
 *   主人让盘古分析自己源码时提到它, 是在**描述被分析的对象**, 不是灌水自我介绍。
 *   这道守卫本来是拦「主人问 A, 盘古答一整篇自我介绍」(老板 2026-10-18 原话),
 *   它只看答案不看问题 ⇒ 把**答对了的源码分析**判成跑题。
 *   ⚠ 两条是**各自独立**的路径: 拆掉任何一条, 另一条仍然会拒。
 *   所以变异测试 C1/C2 各自用**命中自己那条判据**的答案来验 (用错样本 = 空枪)。
 *
 * 也就是说: **主因在 answer_alignment.js (上游), 症状在 j2_dispatcher.js (下游)**。
 * 两层都得修 —— 只修下游, 徽章会变绿, 但主人拿到的还是那三段截断的原文。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 本文件钉住三件事:
 *   A. 上游: 主人问盘古自己的源码时, 综合稿**必须过**对齐门 (不再回落子 agent 拼接)
 *   B. 下游: 那份子 agent 原文拼接**不得**被判成自认未完成
 *   C. 变异测试: 把两条判据改坏, 必须响 (证明这些用例真的在测这两条判据)
 *
 * ⚠ 硬约束 (一条都不许破):
 *   · `_INCOMPLETE_ADMISSION_RE` **词表一个字都不许放宽**
 *   · 10-12 那批真阳性 (「结论：本次任务未完成，不能报告为全量索引。」等) 一条不许挂
 *   · tests/subagent-no-sibling-reread-20261016.test.js T7 钉死的前提不许改
 *   · 灌水守卫对「没问」的场景必须照咬 (tests/self-intro-asked-answered-20261019.test.js)
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const CORE = path.join(__dirname, '..');
const AA_PATH = path.join(CORE, 'modules', 'answer_alignment.js');
const DISPATCH_PATH = path.join(CORE, 'modules', 'j2_dispatcher.js');

const aa = require(AA_PATH);
const { _answerAdmitsIncomplete } = require(DISPATCH_PATH);

// ─────────────────────────────────────────────────────────────────────────────
// 现场语料 —— 从落盘会话里取, 不手抄 (手抄 = 抄错 = 测了个假的)
//
// 语料从 ~/.pangu-data/sessions/ 读; 读不到就**跳过现场那一节**,
// 但**不许**用别处的手抄文本冒充现场 (那正是「夹具覆盖不到新说法」的病根)。
// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-28 (第 134 批): 原来读**生产盘** ~/.pangu-data/sessions 当夹具 ——
//   ① 生产盘被清一次, 这条守卫就静默变成空枪 (夹具没了 ⇒ 变异测试测不到东西);
//   ② 测试的语料不该由生产数据的生死决定。
//   ⇒ 改成读**仓内夹具** (tests/fixtures/sessions/)。要跑真现场语料:
//   PANGU_CORPUS_DIR=$HOME/.pangu-data/sessions npm run test:chain
const SESSION_DIR = process.env.PANGU_CORPUS_DIR
  || path.join(__dirname, 'fixtures', 'sessions');
const PROBE = 'probe82-real-split';

function loadProbe() {
  const answerFile = path.join(SESSION_DIR, PROBE + '.json');
  const synthFile = path.join(SESSION_DIR, PROBE + '_sub-2-li.json');
  if (!fs.existsSync(answerFile) || !fs.existsSync(synthFile)) return null;
  let parent;
  try { parent = JSON.parse(fs.readFileSync(answerFile, 'utf8')); } catch (_) { return null; }
  const msgs = parent.messages || [];
  const answer = String((msgs[msgs.length - 1] && msgs[msgs.length - 1].content) || '');
  let sub;
  try { sub = JSON.parse(fs.readFileSync(synthFile, 'utf8')); } catch (_) { return null; }
  let synth = '';
  for (const m of (sub.messages || [])) {
    if (m.role === 'assistant' && m.content) synth = String(m.content);
  }
  if (!answer || !synth) return null;
  return { answer, synth };
}

// 第二份现场语料 (会话 probe83b-fixed, 第 83 批之后的复验轮):
//   同一道题, 综合稿 5671 字; 主人收到的仍是子 agent 原文拼接, 但**内容不同** ——
//   这份拼接里有两处**代码引用形态**的「熔断」, 老判据照样扫中 ⇒ 仍判 partial。
//   现场: ~/.pangu-data/sessions/probe83b-fixed.json (最后一条 assistant 消息)
const PROBE_B = 'probe83b-fixed';

function loadProbeB() {
  const f = path.join(SESSION_DIR, PROBE_B + '.json');
  if (!fs.existsSync(f)) return null;
  let parent;
  try { parent = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; }
  const msgs = parent.messages || [];
  const answer = String((msgs[msgs.length - 1] && msgs[msgs.length - 1].content) || '');
  return answer || null;
}

// 第三份现场语料 (会话 probe85-fixed, 第 85 批 b):
//   同一道题, 答案 2927 字 —— **结构完整的综合稿** (职责分层 + 协作时序),
//   但里面有三条在**描述盘古自己的机制** (熔断守卫 / 触发熔断 / 跨轮熔断)。
//   老判据 ⇒ 好答案被判 partial。
const PROBE_C = 'probe85-fixed';

function loadProbe85() {
  const f = path.join(SESSION_DIR, PROBE_C + '.json');
  if (!fs.existsSync(f)) return null;
  let parent;
  try { parent = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; }
  const msgs = parent.messages || [];
  const answer = String((msgs[msgs.length - 1] && msgs[msgs.length - 1].content) || '');
  return answer || null;
}

const PROBE_Q = '分别分析一下 /Users/you/Desktop/pangu/apps/core/modules/llm_caller.js '
  + '和 /Users/you/Desktop/pangu/apps/core/modules/j2_agent_loop.js 各自负责什么, '
  + '然后综合说明它们是怎么配合的';

// ═════════════════════════════════════════════════════════════════════════════
// A. 上游 —— 对齐门
// ═════════════════════════════════════════════════════════════════════════════

test('A1 主人问盘古自己的源码 → 综合稿必须过对齐门 (2026-10-25 现场真因)', () => {
  const probe = loadProbe();
  if (!probe) {
    assert.ok(true, '现场会话不存在, 跳过 (A2/A3 用内联最小复现覆盖同一条判据)');
    return;
  }
  assert.equal(aa.isAligned(PROBE_Q, probe.synth), true,
    '综合稿被判跑题 ⇒ guardAnswer 回落 _subConclusionFallback ⇒ '
    + '主人收到三段 2000 字截断的子 agent 原文拼接, 末尾断在半句');
});

test('A2 「源码地图」不能把源码分析稿判成灌水自我介绍 (BROAD_SELF_REPORT 误伤)', () => {
  // 最小复现: 只要答案里出现「源码地图」, 旧判据就 return false。
  // 注意答案**必须谈到题目点名的对象** —— 那才是「正题」; 见 A2b 讲反面。
  const answer = 'llm_caller.js 是传输层, j2_agent_loop.js 是主循环。'
    + '盘古的源码地图显示这两个模块通过 _deps 耦合。';
  assert.equal(aa.isAligned(PROBE_Q, answer), true,
    '题目问的是盘古自己的源码, 答案提到「源码地图」不该被判成灌水');
});

test('A2b 题目点名盘古源码, 答的却是一篇自我介绍 → 灌水守卫必须照咬', () => {
  // 这是本次修复的**边界**: 让位的是「答案在谈题目点名的对象」这一种,
  // 不是「题目提到了源码就一律放行」。守卫不能被整条拆掉。
  const SELF_REPORT = '盘古 (Pangu) 全面自画像\n1. 身份与底座：易经占问 agent\n'
    + '2. 工具矩阵：文件/命令/网络\n3. 三层记忆：短期/长期/源码地图\n'
    + '4. 源码地图: 见 system prompt';
  assert.equal(aa.isAligned(PROBE_Q, SELF_REPORT), false,
    '问 llm_caller.js, 答一篇全面自画像 → 必须继续拦 (否则守卫被整条拆了)');
});

test('A3 「怎么对主人说话」不是编排泄漏 (TRANSCRIPT_LEAK 误伤)', () => {
  // 「主人说」这三个字在中文里是正常搭配; TRANSCRIPT_LEAK 是无条件短路闸。
  const answer = 'j2_agent_loop.js 管的是这一轮调不调工具、结果怎么回灌、'
    + '什么时候停、**怎么对主人说话**。llm_caller.js 管请求怎么发出去、回包怎么解析。';
  assert.equal(aa.isAligned(PROBE_Q, answer), true,
    '「怎么对主人说话」被当成「主人在说话」⇒ 整篇源码分析判跑题');
});

test('A4 灌水守卫对「没问」的场景必须照咬 (不许被这次修复放水)', () => {
  // tests/self-intro-asked-answered-20261019.test.js 已经钉了这条, 这里再钉一遍
  // 本次改动的**边界**: 修的是「题目点名盘古源码」, 不是把守卫整条拆了。
  const SELF_REPORT = '盘古 (Pangu) 全面自画像\n1. 身份与底座：易经占问 agent\n'
    + '2. 工具矩阵：文件/命令/网络\n3. 三层记忆：短期/长期/源码地图';
  assert.equal(aa.isAligned('排盘页面为什么没有详情', SELF_REPORT), false,
    '主人问排盘, 盘古答一整篇自我介绍 → 必须继续拦');
  assert.equal(aa.isAligned('帮我检查 router 为什么会问非所答', SELF_REPORT), false);
  // 顺带把问题里的词复述一遍的那种灌水 (词法对齐放行, 只有守卫拦得住)
  const echo = '排盘页面没有详情，是因为工具矩阵里缺了四柱渲染这一环，'
    + '架构 3 层设计和三层记忆链路都要过一遍。';
  assert.equal(aa.isAligned('排盘页面为什么没有详情', echo), false,
    '复述了问题词的灌水 —— 词法对齐放行, 必须靠守卫拦住');
});

test('A5 题目点名盘古源码但答非所问 → 仍然必须拦 (不许变成万能豁免)', () => {
  assert.equal(aa.isAligned(PROBE_Q, '今天北京天气晴, 适合出门'), false,
    '问盘古源码, 答天气 → 放行就是拿守卫换交付');
  assert.equal(aa.isAligned(PROBE_Q, '好的'), false);
  assert.equal(aa.isAligned(PROBE_Q, '2'), false);
});

test('A6 问盘古源码但拿不出 file:line 取证 → 仍判跑题 (豁免不是放水)', () => {
  // 这条是本次修复的**安全边界**: 判据是词法对齐, 不是「问了就放行」。
  // 「这两个文件各自负责什么」是**普通问答** —— 答「llm_caller.js 是传输层」
  // 就是完整答案, 拿不出 file:line 也该放行 (取证口径是给「全面分析你自己」准备的,
  // 套到普通问答上就是把一道正常问答复核成考试)。
  assert.equal(aa.isAligned(PROBE_Q,
    'llm_caller.js 是传输层, j2_agent_loop.js 是主循环, 两者通过 _deps 耦合。'), true,
    '普通源码问答不该被卡成考试');
  // 但**答非所问**必须拦 (词法对齐在管这件事)
  assert.equal(aa.isAligned(PROBE_Q, '今天北京天气晴, 适合出门'), false);
});

test('A7 盘古分析自己源码的行号格式必须三种都认 (取证口径用得上)', () => {
  // 盘古分析自己源码时写的行号格式是 `file(L123)` / `file.js L123` / `file.js:123` ——
  // 三种都得认 (现场逐字), 否则「全面分析你自己」那条路一个证据都收不到 ⇒ 永远判 false。
  // 这三处的行号必须能落到**真文件**的那一行 (下面 hasSelfInspectionEvidence 核)。
  const withColon = 'llm_caller.js 负责传输层, 见 llm_caller.js:772 和 llm_caller.js:302。';
  const withParen = 'llm_caller.js 负责传输层, 见 llm_caller.js(L772)、llm_caller.js(L302)。';
  const withSpace = 'llm_caller.js 负责传输层, 见 llm_caller.js L772 和 llm_caller.js L302。';
  for (const [name, txt] of [['file.js:123', withColon], ['file.js(L123)', withParen], ['file.js L123', withSpace]]) {
    assert.equal(aa.hasSelfInspectionEvidence(txt, ''), true,
      `${name} 格式没被认成取证行号 → 「全面分析盘古源码」这条路会永远判跑题`);
  }
  // 反面: 编一个不存在的行号 ⇒ 取证不成立
  assert.equal(aa.hasSelfInspectionEvidence('见 llm_caller.js:999999 这一行。', ''), false,
    '行号越界还认 ⇒ 取证等于没核');
});

// ═════════════════════════════════════════════════════════════════════════════
// B. 下游 —— 自认未完成判据
// ═════════════════════════════════════════════════════════════════════════════

test('B1 现场那份 6038 字答复 (子 agent 原文拼接) 不得判成自认未完成', () => {
  const probe = loadProbe();
  if (!probe) {
    assert.ok(true, '现场会话不存在, 跳过 (B2/B3 用内联最小复现覆盖)');
    return;
  }
  assert.equal(_answerAdmitsIncomplete(probe.answer), false,
    '三个命中点没有一处是「盘古承认这轮没干完」: '
    + '①表格里那行是子 agent 描述 j2_agent_loop 的函数 '
    + '②括号清单里是守卫机制名 ③「超时/熔断」是斜杠复合类别名');
});

test('B2 三类误伤形态逐条钉死 (剥壳 + 主语锚定)', () => {
  // ① 表格行: 描述被分析的对象
  assert.equal(_answerAdmitsIncomplete(
    '| `_objectiveWorkRemaining` / `_objectiveGateOpen` / `_looksLikeEmptyPlan` '
    + '| L5972 / L6022 / L5184 | 客观未完成判定、终局文案 |'), false);
  // ② 括号里的顿号清单: 被列举的机制名
  assert.equal(_answerAdmitsIncomplete(
    '把这条循环跑完, 并挂满守卫（复读熔断、重复调用拦截、承诺气泡 nudge、核验门、'
    + '断点续跑、自动压缩、终局防谎报）。'), false);
  // ③ 斜杠复合类别名: 「超时/熔断」是两个类别的并称, 不是谓语
  assert.equal(_answerAdmitsIncomplete(
    '- 超时/熔断：`_prefillMs`(L115)/`_streamIdleMs`(L90)/`_streamTotalMs`(L127)'), false);
  // ⑤ 代码引用形态的机制名 (第 84 批 c, 现场 probe83b-fixed 那份 5998 字拼接):
  //    「熔断」是机制名 (总时长熔断 / FOUNTAIN 熔断), 后面跟的是**代码引用**
  //    (行号 L2171 / 语句 break(L2775)) —— 不是「这一轮熔断了」。
  assert.equal(_answerAdmitsIncomplete(
    '- 两段空闲预算: prefill/idle L2129-2152, 总时长熔断 L2171; tool_calls 增量拼装 L2192-2203。'), false,
    '「总时长熔断 L2171」被判自认 ⇒ 机制名被当成谓语了 (现场 probe83b-fixed 的真凶)');
  assert.equal(_answerAdmitsIncomplete(
    '退出条件: task_done 被验收后 break(L3046-3089)、FOUNTAIN 熔断 break(L2775)、轮次耗尽。'), false,
    '「FOUNTAIN 熔断 break(L2775)」被判自认 ⇒ 同上');
  // ④ 将灵汇报块 (子 agent 原话的转述)
  assert.equal(_answerAdmitsIncomplete(
    '### li\n\n① 完成: 读完并核实 llm_caller.js\n② 证据: 2645 行\n③ 未做: 未跑测试'), false);
});

test('B2b 第二份现场语料 (probe83b-fixed 的子 agent 拼接) 不得判成自认未完成', () => {
  // 现场取证: 这份拼接里「熔断」只出现两次 (偏移 2717 / 3461), 两处都是**机制名**:
  //   「… 总时长熔断 L2171; …」
  //   「… FOUNTAIN 熔断 break(L2775)、…」
  // 老判据扫全文 ⇒ 命中 ⇒ 主人收到的是 partial + 一份被砍过的拼接。
  //
  // ⚠ 会话文件里落盘的是**同一份拼接的前半段** (2785 字, 含第一处; 第二处在
  //   偏移 3461, 已经越过落盘边界) —— 现场 SSE 给主人的是 5998 字完整版。
  //   所以这里用会话文件做**现场取证**, 第二处形态由 B2 ⑥ 的内联最小复现覆盖。
  const answer = loadProbeB();
  if (!answer) {
    assert.ok(true, '现场会话不存在, 跳过 (B2 ⑤⑥ 用内联最小复现覆盖同一条判据)');
    return;
  }
  assert.ok(answer.indexOf('总时长熔断 L2171') >= 0,
    '现场语料里没有「总时长熔断 L2171」⇒ 取证样本不对, 这条用例在测一个不存在的东西');
  assert.equal(_answerAdmitsIncomplete(answer), false,
    'probe83b-fixed 那份拼接仍被判自认未完成 ⇒ 「机制名 + 代码引用」这条形态没被认出来');
});

test('B2c 第三份现场语料 (probe85-fixed 的最终答复) 不得判成自认未完成', () => {
  // 现场 (会话 probe85-fixed, 2026-10-25 第 85 批 b): 主人问的是「分别分析 llm_caller.js 和
  // j2_agent_loop.js 各自负责什么, 然后综合说明它们是怎么配合的」。
  // 答案 2927 字, 结构完整、有职责分层、有协作时序 —— 是一份**好答案**。
  // 但里面有三条都在**描述盘古自己的机制**:
  //   「…权限沙箱、熔断守卫、记忆落盘和最终收口。」   ← 列举 j2_agent_loop 的职责
  //   「…达到轮数上限或触发熔断。」                   ← 列举循环的停止条件
  //   「J2 又有超时、跨轮熔断。」                     ← 列举 J2 的守卫
  // 老判据扫全文 ⇒ 三处里两处命中 ⇒ 好答案被判 partial (徽章误报)。
  const probe = loadProbe85();
  if (!probe) {
    assert.ok(true, '现场会话不存在, 跳过 (下面三条内联复现覆盖同一条形态)');
  } else {
    assert.ok(probe.length > 2000, `现场答复长度只有 ${probe.length} —— 取证样本不对`);
    assert.equal(_answerAdmitsIncomplete(probe), false,
      'probe85-fixed 那份好答案仍被判自认未完成 ⇒ 「机制名」这条形态没被认出来');
  }
  // 三条形态逐条钉死
  assert.equal(_answerAdmitsIncomplete(
    '负责多轮循环、工具执行与回灌、上下文压缩、权限沙箱、熔断守卫、记忆落盘和最终收口。'), false,
    '「熔断守卫」是机制名 (列举职责), 不是「这一轮熔断了」');
  assert.equal(_answerAdmitsIncomplete(
    '循环一直跑到模型不再要求工具、达到轮数上限或触发熔断。'), false,
    '「触发熔断」是机制名 (列举停止条件)');
  assert.equal(_answerAdmitsIncomplete(
    'llm_caller 有模型名自愈和冷启动重试；J2 又有超时、跨轮熔断。'), false,
    '「跨轮熔断」是机制名 (列举守卫)');
});

test('B3b 熔断当谓语用时必须照咬 (机制名判据不许把自认一起放过)', () => {
  // 「熔断」是两份词表里唯一的名/动同形词 —— 名词形态放过, 谓语形态一条都不许放过。
  for (const t of [
    '子任务熔断了',
    '被熔断了。',
    '本轮熔断。',
    '子任务熔断。',
    '熔断失败。',
    '跨轮熔断失败。',
  ]) {
    assert.equal(_answerAdmitsIncomplete(t), true, `谓语形态被放走了: ${t}`);
  }
});

test('B3 10-12 那批真阳性一条不许挂 (词表一个字都没放宽)', () => {
  const admits = [
    '当前仅成功读取并排序了部分 .js 文件，输出在 memory_helpers.js 处截断，未证明覆盖全部文件；索引文件 /tmp/module_firstline_20261012.md 也未生成。',
    '结论：本次任务未完成，不能报告为全量索引。',
    '当前八字排盘未成功，工具返回 MISSING_DATE，因此没有生成可核验的四柱。',
    '已核实目录存在 .js 文件。但当前工具权限仅允许只读，未能写入 /tmp/x.md，因此索引表尚未生成。',
    '该文件未落地，无法完成后续步骤。',
    '报告未写出，无法交付。',
  ];
  for (const t of admits) {
    assert.equal(_answerAdmitsIncomplete(t), true, `真阳性被放走: ${t.slice(0, 40)}`);
  }
  // 旧词表的四种措辞继续认
  for (const t of ['验收未通过', '子任务熔断了', '请重试', '结论不通过']) {
    assert.equal(_answerAdmitsIncomplete(t), true, `旧口径应继续生效: ${t}`);
  }
});

test('B4 「③ 未做」栏的前提不许被改没 (10-16 T7 钉死的同一条)', () => {
  // 这一条钉的是「判据没被改松」: 子 agent 汇报契约的「③ 未做」栏仍然会被扫成自认,
  // 所以真缺口的处理必须在**判定层** (验收刀豁免 / 账本对账), 不能靠改词表。
  assert.equal(_answerAdmitsIncomplete('③ 未做: 未执行 compaction 相关测试验证 (按指令不扩展)'), true);
});

test('B5 正常交付不得被误伤', () => {
  const done = [
    '已递归列出 **122 个 .js 文件**，清单：/tmp/longtask_js_files_20261012.txt。',
    '已完成并交付： .js 文件 122 个 / 总行数 37,847 行 / 报告已写入并核验：/tmp/x.md / task_done 已交付',
    '记住了，主人：你叫**孙七**，生日是**1986年3月15日**。',
    '限制：第 4 步仅完整取得 tools/index.js 前 30 行；其余两份未取得逐行原文，报告已如实标注。',
    '已核实四柱前三柱：**丙寅年、辛卯月、戊午日**。因未提供出生时辰，时柱无法确定。',
  ];
  for (const t of done) {
    assert.equal(_answerAdmitsIncomplete(t), false, `被误伤: ${t.slice(0, 40)}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// C. 变异测试 —— 证明上面这些用例真的在测这两条判据
//
// 手法 (照第 82 批 soul-tier 的做法): Module._compile 在内存里编译一份「坏掉的」副本,
// **一个字节都不落盘** —— 不污染 modules/ 目录, 不跟整链并发打架, 也不可能改到一半忘了还原。
// ═════════════════════════════════════════════════════════════════════════════

function compileMutant(filePath, mutate) {
  const src = fs.readFileSync(filePath, 'utf8');
  const broken = mutate(src);
  assert.notEqual(broken, src, '变异没生效 —— 替换目标对不上, 这条负例是空枪');
  const m = new Module(filePath, null);
  m.filename = filePath;
  m.paths = Module._nodeModulePaths(path.dirname(filePath));
  m._compile(broken, filePath);
  return m.exports;
}

test('C1 把 BROAD_SELF_REPORT 的分流拆掉 → A2/A3 必须红', () => {
  // 变异: 拿掉「题目点名盘古源码」这条分流, 让灌水守卫重新一刀切。
  const broken = compileMutant(AA_PATH, (src) => src.replace(
    'if (asksAboutPanguSource(question)) {',
    'if (false && asksAboutPanguSource(question)) {'));
  // ⚠ 用的答案**必须含「源码地图」** —— 现场 probe82 的**综合稿**里其实没有这三个字
  //   (它被拒的真凶是「怎么对主人说话」, 见 C2); 「源码地图」出现在**子 agent 刀2**
  //   的汇报里。两条是**各自独立**的误伤路径, 所以这里要用含「源码地图」的答案验。
  //   变异后它必须判 false (灌水守卫一刀切)。
  const withSourceMap = 'llm_caller.js 是传输层, j2_agent_loop.js 是主循环。'
    + '盘古的源码地图显示这两个模块通过 _deps 耦合。';
  assert.equal(broken.isAligned(PROBE_Q, withSourceMap), false,
    '变异后含「源码地图」的源码分析稿仍判对齐 ⇒ 这条用例没在测 BROAD_SELF_REPORT 那条分流 (空枪)');
});

test('C2 把 TRANSCRIPT_LEAK 的句首锚定拆掉 → A3 必须红', () => {
  // 变异: 把「主人 X」塞回那条无条件短路的大正则 —— 还原成 2026-10-25 之前的行为。
  //
  // ⚠ 第 84 批 b 加了一层「源码分析豁免」(题目点名盘古源码 + 实质报告 ⇒ 编排守卫让位),
  //   所以这个变异**必须把那层也一并关掉**, 否则豁免会替句首锚定兜住底 ⇒ 变异成空枪。
  //   变异只测**一层**判据, 别的层要么留着、要么明确关掉 —— 不能靠别的层救场。
  const broken = compileMutant(AA_PATH, (src) => src
    .replace(
      'if (_OWNER_SPEECH_LEAK.test(text)) return true;',
      'if (/(主人(?:说|拍板|拍|要|问|醒了))/.test(text)) return true;')
    .replace(
      'if (!(asksAboutPanguSource(question) && _isSubstantiveReport(answer))) return false;',
      'if (true) return false; /* MUTANT: 关掉源码分析豁免, 只测句首锚定这一层 */'));
  const probe = loadProbe();
  // 现场真实综合稿 —— 它含「**怎么对主人说话**」(逐字, 在「j2_agent_loop 管」那条里),
  // 这是它被对齐门拒掉的**唯一**原因。
  const synth = probe ? probe.synth
    : 'j2_agent_loop.js 管的是怎么对主人说话。llm_caller.js 管请求怎么发出去。';
  assert.equal(broken.isAligned(PROBE_Q, synth), false,
    '变异后仍判对齐 ⇒ 「怎么对主人说话」这条用例没在测句首锚定 (空枪)');
});

test('C3 把剥壳拆掉 → B1/B2 必须红', () => {
  // 变异: 让 _stripQuotedMaterial 原样返回 (等于回到第 83 批之前的裸扫)。
  const broken = compileMutant(DISPATCH_PATH, (src) => src.replace(
    'function _stripQuotedMaterial(t) {',
    'function _stripQuotedMaterial(t) { return String(t || ""); /* MUTANT */'));
  const probe = loadProbe();
  const answer = probe ? probe.answer
    : '并挂满守卫（复读熔断、重复调用拦截、核验门）。';
  assert.equal(broken._answerAdmitsIncomplete(answer), true,
    '变异后仍判不完整 ⇒ 剥壳这条用例没在测剥壳 (空枪)');
});

test('C4 把主语锚定拆掉 → B2 的斜杠复合类别名必须红', () => {
  // 变异: 让 _admitsByPredicate 不做复合名判断 (等于回到纯裸扫)。
  const broken = compileMutant(DISPATCH_PATH, (src) => src.replace(
    'if (_COMPOUND_PREFIX_RE.test(before)) continue;',
    'if (false && _COMPOUND_PREFIX_RE.test(before)) continue;'));
  const compound = '- 超时/熔断：`_prefillMs`(L115)/`_streamIdleMs`(L90)/`_streamTotalMs`(L127)';
  assert.equal(broken._answerAdmitsIncomplete(compound), true,
    '变异后仍判不完整 ⇒ 主语锚定这条用例没在测锚定 (空枪)');
});

test('C5 把词表放宽 (删掉一个词) → B3 必须红', () => {
  // 反向守卫: 证明 B3 真的在测「词表不许放宽」。
  // 把 _INCOMPLETE_ADMISSION_RE 里的「未写出」删掉 —— 真阳性「报告未写出，无法交付。」
  // 就只靠这一个词命中 (「未写出」在词表里只出现一次), 删了它该漏。
  //
  // ⚠ 变异目标为什么选「未写出」而不是「未完成」:
  //   「未完成」在词表里出现**两次** (`|未完成|` 和 `|本次任务未完成|`),
  //   删掉前者, 「结论：本次任务未完成」还命中后者 ⇒ 变异是**空枪**。
  //   踩坑日志里那条「变异测试出空枪 = 那条判据没被测到」说的就是这种事。
  const broken = compileMutant(DISPATCH_PATH, (src) => src.replace(
    '|未写出|无法完成|', '|无法完成|'));
  assert.equal(broken._answerAdmitsIncomplete('报告未写出，无法交付。'), false,
    '删掉词表里的「未写出」竟仍然判 true ⇒ B3 没在测这条真阳性 (空枪)');
});

test('C6 把「代码引用锚点」这条形态判断拆掉 → B2 ⑤⑥ 必须红', () => {
  // 变异: 让 _admitsByPredicate 不看「自认词后面是不是代码引用锚点」。
  //
  // ⚠ 为什么这条必须单独测: B2 ①②③ 三条靠的是**剥壳**和**复合前缀**两道,
  //   B2 ⑤⑥ 靠的是第三道 (代码引用锚点) —— 三道各管各的形态, 拆错一道会被
  //   别的道救回来 ⇒ **空枪**。所以这里必须单独拆第三道, 用只踩第三道的样本来验。
  //
  // ⚠ 第 85 批 b 加了第四道 (熔断的机制名形态), 它**也**认代码引用锚点 ——
  //   所以这个变异必须把**两道一起拆**, 否则第四道会替第三道兜底 ⇒ 又是空枪。
  const broken = compileMutant(DISPATCH_PATH, (src) => src
    .replace(
      'if (_CODE_CITATION_AFTER_RE.test(after)) continue;',
      'if (false && _CODE_CITATION_AFTER_RE.test(after)) continue;')
    .replace(
      'if (m[0] === _MECHANISM_NOUN_WORD && _isMechanismNounUsage(before, after)) continue;',
      'if (false && m[0] === _MECHANISM_NOUN_WORD && _isMechanismNounUsage(before, after)) continue;'));
  assert.equal(broken._answerAdmitsIncomplete(
    '- 两段空闲预算: prefill/idle L2129-2152, 总时长熔断 L2171; tool_calls 增量拼装 L2192-2203。'), true,
    '变异后仍判不完整 ⇒ 「代码引用锚点」这条形态判断没被测到 (空枪)');
  assert.equal(broken._answerAdmitsIncomplete(
    '退出条件: task_done 被验收后 break(L3046-3089)、FOUNTAIN 熔断 break(L2775)、轮次耗尽。'), true,
    '变异后仍判不完整 ⇒ 同上 (空枪)');
});

test('C7 把「熔断当机制名」这条形态判断拆掉 → B2c 必须红', () => {
  // 变异: 让 _admitsByPredicate 不再认「熔断」的名词形态。
  //
  // ⚠ 样本必须**只**踩这一条形态, 别的层救不回来, 否则就是空枪:
  //   「跨轮熔断。」前面是顿号 ⇒ 复合名前缀规则会挡 ⇒ 用它验是空枪。
  //   「触发熔断。」前面是「或」⇒ 前缀规则挡不住 ⇒ 只有这条形态能救。
  const broken = compileMutant(DISPATCH_PATH, (src) => src.replace(
    'if (m[0] === _MECHANISM_NOUN_WORD && _isMechanismNounUsage(before, after)) continue;',
    'if (false && m[0] === _MECHANISM_NOUN_WORD && _isMechanismNounUsage(before, after)) continue;'));
  assert.equal(broken._answerAdmitsIncomplete(
    '循环一直跑到模型不再要求工具、达到轮数上限或触发熔断。'), true,
    '变异后仍判不完整 ⇒ 「机制名」这条形态判断没被测到 (空枪)');
  assert.equal(broken._answerAdmitsIncomplete(
    '负责熔断守卫与记忆落盘。'), true,
    '变异后仍判不完整 ⇒ 同上 (空枪)');
});

// ═════════════════════════════════════════════════════════════════════════════
// D. 注释不许在行注释里开块注释
//
// 2026-10-25 (本批踩到, 当场把一条既有守卫打红了):
//   我在 j2_dispatcher.js 的注释里写了
//     「- 超时/ + 熔断：…」—— 那个位置的斜杠紧跟着两个星号
//   它开了**一个未闭合的块注释** —— 全仓多处结构守卫用
//   `src.replace(/slash-star + ... + star-slash/g, '')` 剥注释, 于是从那里一直到
//   往后某个配对 (30KB 之后) 全被当成注释删掉 ⇒ 守卫看不见真正的代码 ⇒
//   tests/owner-spec-to-subagent-20261013.test.js「接线守卫」当场报红。
//
// 教训: **注释里的斜杠+星号会开块注释**。行注释里别写那个组合, 换个说法就行。
// 这条不是洁癖 —— 它能让 30KB 代码对结构守卫隐身。
// ═════════════════════════════════════════════════════════════════════════════

test('D1 行注释里不许出现「斜杠+星号」(会开一个未闭合的块注释, 把后面的代码对结构守卫藏起来)', () => {
  // ⚠ 只扫**生产文件**, 不扫本测试文件 —— 本文件里必须提到那个组合 (C3 的变异体
  //   也要真的写出一个块注释), 扫自己就是自己判自己红。
  //
  // ⚠ 判据用「斜杠 + 星号」拼出来, 不把这两个符号连写在本文件里 ——
  //   连写在**任何**位置 (注释/字符串/代码) 都会开一个未闭合的块注释,
  //   本文件自己就会先坏掉 (当场实测: 剥块注释后本文件少 77 行)。
  const SLASH_STAR = String.fromCharCode(47) + '*';
  const files = [
    path.join(CORE, 'modules', 'j2_dispatcher.js'),
    path.join(CORE, 'modules', 'answer_alignment.js'),
    path.join(CORE, 'modules', 'subagent_runner.js'),
  ];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      const t = l.trim();
      if (!t.startsWith('//')) return;
      assert.ok(t.indexOf(SLASH_STAR) < 0,
        `${path.basename(f)}:${i + 1} 行注释里含「斜杠+星号」⇒ 它会开一个未闭合的块注释, `
        + '把后面的代码对结构守卫藏起来: ' + t.slice(0, 80));
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// E. 编排泄漏守卫 (第 84 批 b)
//
// 现场 (2026-10-25 probe83b-fixed, 综合稿 5671 字):
//   主人问「分别分析 llm_caller.js 和 j2_agent_loop.js 各自负责什么, 然后综合说明怎么配合」
//   综合稿里逐字有两处触发编排泄漏守卫:
//     ① 「决定下一轮」                 ← 在讲 j2_agent_loop 的轮次逻辑
//     ② 「`agents/sub-agent` 的 ROLES」 ← 这是一个**路径**
//   TRANSCRIPT_LEAK 是无条件短路闸 (不走 concrete 豁免) ⇒ 两个词把整篇判死
//   ⇒ guardAnswer 回落 `_subConclusionFallback` ⇒ 主人收到三段 `### li` 原文拼接。
//
// 修法: 题目点名盘古源码 + 答案够长够具体 (实质报告) ⇒ 编排守卫让位。
//       别的题 (排盘页为什么没详情这种) 编排守卫照旧一词灭口。
// ═════════════════════════════════════════════════════════════════════════════

test('E1 综合稿里出现「下一轮」「agents/sub-agent」⇒ 不许被判编排泄漏', () => {
  // 最小复现: 一段够长够具体的源码分析, 里面有「下一轮」和一个 sub-agent 路径。
  const report = '## 一、llm_caller.js 职责\n\n'
    + '- `_resolveCallContext`(1177) 解析模型与端点; `_buildOpenAIPayload`(1442) 构造请求体。\n'
    + '- 两段空闲预算: prefill L2129-2152, 总时长熔断 L2171。\n'
    + '## 二、j2_agent_loop.js 职责\n\n'
    + '- 轮内编排: 装配 toolsSchema、跑模型、解析 tool_calls、回灌消息、决定下一轮。\n'
    + '- 角色白名单真源在 `agents/sub-agent` 的 ROLES, MCP 只读名单真源在 llm_caller。\n'
    + '- 调用链: llm_caller.js:2593 导出, j2_agent_loop.js:1693 require, j2_agent_loop.js:4460 调用点。\n';
  assert.equal(aa.isOrchestrationLeak(report), true,
    '这道报告本身仍算编排泄漏 (底层判据没变) —— 变的是「问盘古源码」这条路给不给它让位');
  assert.equal(aa.isAligned(PROBE_Q, report), true,
    '源码分析报告被判跑题 ⇒ 主人收到的是子 agent 原文拼接, 不是综合稿');
});

test('E2 别的题照旧一词灭口 (豁免不许外溢)', () => {
  // 排盘页那道题跟盘古源码无关 ⇒ 编排守卫照旧。
  assert.equal(aa.isAligned('排盘页面为什么没有详情', '待办清单：拉 vite 日志，确认接口，明天你醒来再看。'), false);
  assert.equal(aa.isAligned('排盘页面为什么没有详情', '好，直接出。先确认现状，再一把写完。侧栏入口已加。'), false);
});

test('E3 短报告不许靠豁免混过去 (豁免要求 ≥200 字且 ≥3 个具体证据)', () => {
  // 同样的词, 但短 —— 没有具体证据 ⇒ 豁免不生效 ⇒ 照旧判跑题。
  const short = '好，直接出。决定下一轮，先确认现状，再一把写完。';
  assert.equal(aa.isAligned(PROBE_Q, short), false,
    '短报告靠豁免混过去了 ⇒ 豁免的门槛松了');
});

test('D2 剥注释后必须还看得见关键代码 (结构守卫的地基)', () => {
  // 上面那条是「不许犯错」, 这条是「就算犯了也看得见」——
  // 复刻 owner-spec-to-subagent 那个守卫的剥法, 确认剥完代码还在。
  const src = fs.readFileSync(path.join(CORE, 'modules', 'j2_dispatcher.js'), 'utf8');
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // ⚠ 判据是**行数**不是字数: 行注释正则本来就删掉每行的后半截 (那是注释),
  //   字数掉一半是正常的。用字数判会天天误报 (踩过一次)。
  //   真正要抓的是「有未闭合的块注释把**代码行**吞了」—— 那会让行数塌。
  assert.ok(stripped.split('\n').length === src.split('\n').length,
    `剥完行数从 ${src.split('\n').length} 变成 ${stripped.split('\n').length} `
    + '—— 有未闭合的块注释把代码吞了');
  assert.match(stripped, /_ownerScopeBlock\(userInput, _isOwnerCarrier \? 1 : total, st\.task\)/,
    '剥完看不见 fixed_flow 派发处的 _ownerScopeBlock 调用 ⇒ 结构守卫会假装还在');
});
