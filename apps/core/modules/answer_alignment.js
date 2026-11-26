// Final-answer alignment guard. Keep this deterministic and dependency-free.

const STOP = new Set(['什么', '怎么', '如何', '为什么', '是否', '可以', '能否', '请问', '一下', '一个', '这个', '那个', '以及', '然后']);

// LLMs occasionally leak the orchestration transcript instead of answering.
// These markers are implementation chatter, never a user-facing answer.
// 2026-10-01 修 (9/30 实锤): 「上一轮」从 TRANSCRIPT_LEAK 降级到 ORCHESTRATION_MARKERS。
// 原 bug: resolveTaskInput 的【重复提问·已答过】注入文本里"你上一轮已给出实质答案…禁止重复上轮全文"
// 连喂两次「上一轮」, 而 TRANSCRIPT_LEAK 恰恰在**答案**侧禁这个词 → 系统先叫模型说、再禁止模型说。
// 实测: 同一个答案, 写「上一轮我给的…」blocked=true, 改成「上轮我给的…」blocked=false。
// 语义上「上一轮」是正常口语时间指代 (「下一轮」才是编排话术, 留在原处), 且降级后能吃到下面的
// concrete>=3 豁免; 单独出现不再灭口, 与「下一步/等你拍」同时出现仍拦。
const TRANSCRIPT_LEAK = /(先\s*[a-z一二三四五六七八九十]\s*还是\s*[a-z一二三四五六七八九十]|这是个具体事实题|下一轮|立即动手|并行往下走|汇报[:：]|action\s*[:：]|file_edit|sub[-_ ]agent|先并行拉数据|待办清单|不会再来打扰|不再回话|睡[，,。.!！]?我(?:会|继续)|明天你醒来|先确认现状|一把(?:改完|写完)|我(?:先|会|来|猜|直接)\s*(?:看|查|拉|补|修|读|写|确认|排查)|直接(?:看|查|拉|补|修|读|写|排查)(?:\S{0,12})(?:日志|代码|文件|接口|路由|现状))/i;

// 2026-10-25 (第 83 批, 现场 probe82-real-split): 「主人 X」必须**句首锚定**。
//
// 原来它跟别的 marker 挤在 TRANSCRIPT_LEAK 那条大正则里, 判据是「答案里出现
// 『主人说』这三个字」。中文里这四个字有正常用法:
//   「**怎么对主人说话**」—— 现场 probe82 刀3 的综合正文**逐字**就有这句
//     (在讲 j2_agent_loop 的职责边界: 「怎么对主人说话」)
//   「**主人要**求高」/「对主人**要**求」……
// TRANSCRIPT_LEAK 是**无条件 return true** 的短路闸 (不走 concrete 豁免),
// 于是「怎么对主人说话」这一句, 把整篇 5157 字的**源码分析综合稿**判成编排泄漏
// → isAligned=false → guardAnswer 回落 `_subConclusionFallback` →
// 主人收到三段 2000 字截断的子 agent 原文拼接, 末尾断在半句。
//
// 形态上的区别很硬: 编排泄漏里的「主人说」是盘古**转述主人的话**
//   —— 它出现在**句子开头** (「主人说要改成 X」)。
// 而「怎么对主人说话」「对主人的要求」里, 「主人」是**介词宾语或所有格**,
// 前面有实词顶着, 不是句子主语。
//
// 修法: 认**句首**形态 —— (句首 | 句读分隔符后) + 「主人」+ 动词。
//   词表一个字没删, 只是把「出现在任何位置」收紧成「出现在主语位」。
const _OWNER_SPEECH_LEAK = /(?:^|[。！？；\n]\s*|^\s*[-*•]\s*|^\s*>+\s*|^\s*\d+[.)、]\s*)主人\s*(?:说|拍板|要|问|醒了|要求|指示|交代|的命令)/;
// A recurring failure mode is a broad self-description being emitted after a
// concrete product/debug question. It may share incidental nouns (for example
// “排盘”), so keyword overlap alone must not pass it.
const BROAD_SELF_REPORT = /(?:盘古\s*[（(]?pangu[）)]?\s*(?:全面自我|全面自画像|自我剖析)|(?:身份(?:与|\s*&\s*)底座|子\s*agent\s*(?:矩阵|\d)|工具矩阵|架构\s*[（(]?\d+\s*层|三层记忆|四层进化|源码地图|行为准则))/i;

// 「只要一个短答案」的识别 —— 2026-10-23 第 72 批补全。
//
// 原来只有 `(?:只|仅|直接|原样|马上|立刻)\s*(?:回复|回答|答|返回|给出|说)`,
// 于是最自然的两种说法全漏:
//   「只回两个字：收到」   「只给我两个字：收到」
// ⇒ 短答案豁免(`_wantsDirect && 长度<12`)不触发 ⇒ 落到词法对齐 ⇒
//   「收到」被判跑题 ⇒ 主人看到「本轮未形成与原问题匹配的可核验答案，请重试。」
// 这不是新问题: 2026-10-14 已经为「请只回复:收到」修过一次(那个形状认得),
// 但动词表没覆盖「只回」「只给」, 同一个死法从另一个形状回来。
// 实测被拦的现场: 「最终仅回答一个字：好」答「OK」、10-03 的同款。
//
// 补法两条:
//   ① 动词表加 回/给/讲/吐/写/整 —— 「只回」「只给」「只讲」都是要短答案。
//   ② 独立信号「N个字 / N句话 / N个数」—— 不管动词是什么, 这就是要一个短答案。
//      ⚠️ 「个字」里的 个 是必须的: 否则「第3字段」这种会被误当成信号。
//   ⚠️ 两条防误伤:
//     「个字」后面不许跟「段」—— 否则「3个字段怎么填?」会被当成「给我三个字」,
//       短跑题答案就能靠它过闸。
//     「N个数」不算信号—— 「这几个数字对不对?」是**核对**请求, 不是要一个短答案,
//       拿它当信号会把「不太确定」这种非答案放过去。
//       要「一个数」的说法另有专门一条 (只/仅/直接/原样 + 要/想要/需要 + 数/字),
//       那个不会撞「这几个数字」。
//     「N句话」也不算信号 —— 「说三句话总结这次改动」要的是**总结**, 总结可以很长;
//       拿它当「要短答案」会把「一二三」这种糊弄答案放过去。
//       想要「一句话」时主人一般会说「只说一句」, 那条由上面的 只+说 兜住。
const _WANTS_DIRECT_RE = /(?:只|仅|直接|原样|马上|立刻)\s*(?:回复|回答|答|返回|给出|说|回|给|讲|吐|写|整)|(?:等于几|是几|多少钱|多少|什么时候|哪(?:个|天|年|里))|(?:一|两|二|三|四|五|六|七|八|九|十|几)\s*个字(?!段)|(?:回|给|说|讲|答|写|整|吐)\s*\d+\s*个字(?!段)|(?:只|仅|直接|原样)\s*(?:要|想要|需要)\s*(?:一|1|两|2|三|3)?\s*(?:个)?(?:数|字)/;
const ORCHESTRATION_MARKERS = [
  /真凭实据|不嘴炮|先阶段|方案[:：]|工作量|下一步|等主人|等你拍|直接干|开始排查|并行(?:三查|查)/i,
  /我(?:先|会|来|直接)\s*(?:查|看|读|改|补|写|排查|确认)/i,
  /主人(?:新要求|要加|截了|说|拍板)|这次(?:直接|一把)|不再(?:嘴炮|空话)/i,
  // 2026-10-01: 「上一轮」从 TRANSCRIPT_LEAK 移到这里 — 单独出现是正常口语时间指代, 不构成编排泄漏;
  // 与「下一步/等你拍」同现 (hits>=2) 仍拦, 长答案+具体证据 (concrete>=3) 走 isOrchestrationLeak 豁免。
  /上一轮/,
];

function isOrchestrationLeak(answer) {
  const text = String(answer || '');
  if (!text) return false;
  if (TRANSCRIPT_LEAK.test(text)) return true;
  // 2026-10-25 (第 83 批): 「主人说」只在**主语位**才算编排泄漏。
  //   「怎么对主人说话」这种正常中文 (现场 probe82 刀3 综合正文逐字) 不再命中。
  if (_OWNER_SPEECH_LEAK.test(text)) return true;
  let hits = 0;
  for (const marker of ORCHESTRATION_MARKERS) if (marker.test(text)) hits++;
  if (hits === 0) return false;
  // 2026-09-14 (老板 05:51 实案): "下一步"本身是 marker, 实质报告结尾一句"下一步建议/等你拍"
  // 就 hits≥2 被整篇判编排泄漏 → 真答案被换成"请重试"。
  // 有真凭据 (数字/文件名/路径 ≥3 个) 的长答案 = 内容+元话调料, 不是纯编排泄漏, 放行。
  if (_isSubstantiveReport(text)) return false;
  return hits >= 2 || (text.length > 220 && hits >= 1 && /(?:先|再|然后|下一步)/.test(text));
}

// 「实质报告」判据 (2026-10-25 第 84 批 b 抽成公共判据, **不抄第二份**)
//
// 原来这段只长在 isOrchestrationLeak 里 (ORCHESTRATION_MARKERS 那条路的豁免)。
// 现在**源码分析那条路**也要用同一把尺子 —— 两处各写一份, 以后必然改漏一处
// (这正是 2026-10-12「同一个修复只打了一半」的成因)。
//
// 口径: 长度 ≥200 字, 且具体证据 (数字 / 文件名 / 路径) ≥3 个。
//   现场 16 条真死样本里没有一条够 200 字 ⇒ 这道豁免不会把真泄漏放走;
//   而被 TRANSCRIPT_LEAK 钉死的那批样本 (「汇报：A. … B. …」「先确认现状, 再一把写完」
//   「待办清单：拉 vite 日志…」) **全都短于 200 字** ⇒ 一条都不受影响。
function _concreteCount(text) {
  const t = String(text || '');
  return (t.match(/\d+/g) || []).length
    + (t.match(/[A-Za-z0-9_./~一-龥-]+\.(?:txt|md|json|pdf)/g) || []).length
    + (t.match(/\/Users\/\S+/g) || []).length;
}

function _isSubstantiveReport(text) {
  const t = String(text || '');
  return t.length >= 200 && _concreteCount(t) >= 3;
}
const SELF_INSPECTION = /(全面|全量).{0,8}(分析|扫描|检查|排查).{0,12}(你自己|自身|盘古)|(?:分析|扫描|检查|排查).{0,8}(你自己|自身|盘古)|你的(架构|工具|沙箱|权限|记忆|推理|代码|配置|系统|MCP|模型|能力)/i;
const ABSOLUTE_PATH = /(?:^|\s)\/Users\/[A-Za-z0-9_-]+\/[\S]+/;
const EXTERNAL_ARTIFACT_TASK = /(消化|吸收|学习|资料|素材|文件夹|目录|文档|总结|提取|归档|digest|extracted|learned|进度|盘点)/i;
const EVIDENCE_MARKER = /(?:[A-Za-z0-9_./-]+\.(?:js|json|md|sqlite|jsonl):\d+|(?:命令|tool_result|工具结果|真源|证据)\s*[:：])/i;
const EVIDENCE_REF = /([A-Za-z0-9_./~-]+\.(?:js|json|md|sqlite|jsonl)):(\d+)/gi;

function isExternalArtifactTask(question) {
  const text = String(question || '');
  return ABSOLUTE_PATH.test(text) && EXTERNAL_ARTIFACT_TASK.test(text);
}

function isSelfInspection(question) {
  const text = String(question || '');
  // "你自己排查" can describe a comparison method rather than a request for
  // a source-code audit. For a path-backed learning/materials task, require
  // evidence from the supplied corpus instead of unrelated source file:line
  // references. The broad old regex rejected valid folder audit summaries.
  return SELF_INSPECTION.test(text) && !isExternalArtifactTask(text);
}

// 2026-10-25 (第 83 批, 现场 probe82-real-split): 主人问的是**盘古自己的源文件**。
//
// 现场 (会话 probe82-real-split, 落盘 ~/.pangu-data/sessions/probe82-real-split.json):
//   题目「分别分析一下 .../llm_caller.js 和 .../j2_agent_loop.js 各自负责什么,
//         然后综合说明它们是怎么配合的」
//   → 主 agent 自拆 3 刀 (li/li/li) → 3 刀全部交卷 → 综合层写出**完整综合稿**
//     (「## 一、各自职责」+「## 二、协作时序」)
//   → 主人收到的却是三段 `### li` 原文拼接, 每段截断到 2000 字, 末尾断在半句。
//
// ⚠ 两条**各自独立**的误伤路径 (现场逐字定位, 不是猜):
//
//   ① `TRANSCRIPT_LEAK` 命中综合稿里的「**怎么对主人说话**」——
//      这是现场 probe82 那一轮被拒的**直接**原因。
//      「主人说」这三个字在中文里是正常搭配 (「对主人说话」), 而 TRANSCRIPT_LEAK 是
//      **无条件 return true 的短路闸**, 一个词就把整篇 5157 字判死。
//      (修法见上面 _OWNER_SPEECH_LEAK: 「主人 X」只在**主语位**才算编排泄漏。)
//
//   ② `BROAD_SELF_REPORT` 命中「**源码地图**」。
//
// ② 的详细说明 (它不是现场这一轮的直接原因, 但同样是真实误伤, 一并修):
//
//   BROAD_SELF_REPORT 是**灌水式自我介绍守卫** (老板 2026-10-18 原话:
//   「这么大篇幅都在说计划、子agent, 用户会在乎吗」), 拦的是
//   「主人问 A, 盘古答一整篇自我介绍」。它的判据是**答案里出现了自我画像的措辞**。
//
//   但「源码地图」是**盘古自己 prompt 里的一个 block 名**
//   (llm_caller.js:903 「# 自身源码地图 (回答"关于你自己"的问题前必读, 禁止凭印象)」)。
//   主人让盘古分析自己的源码, 综合稿里提到「盘古的源码地图显示这两个模块通过 _deps 耦合」
//   —— 那是在**描述被分析的对象**, 不是在灌水自我介绍。
//
//   守卫只看答案不看问题 ⇒ 一道「防灌水」的守卫, 把**答对了的源码分析**判成跑题。
//   判 false 之后 guardAnswer 回落到 `_subConclusionFallback(results)` ——
//   也就是三段各 slice(0,2000) 的子 agent 原文拼接 (现场答复 6038 字,
//   逐字等于 _subConclusionFallback 的产物, 已比对确认)。
//   于是: **综合层的正文被整段丢掉, 主人拿到的是被截断的内部代号原文。**
//
// 这比「徽章误判」严重得多 —— 答复内容本身是坏的 (带 `### li` 内部代号、
// 末尾半句截断), 不是徽章颜色的问题。
//
// 修法: 守卫**必须看问题意图**。
//   「主人问的是不是盘古自己」这个问题, 已经有现成判据:
//     · isSelfInspection(question)  —— 「全面分析你自己」这类 (走源码取证那条路)
//     · isSelfIntroAsk(question)   —— 「你是什么」这类 (走 isSelfIntroAnswer)
//   但 probe82 那道题**两个都不匹配**:
//     · SELF_INSPECTION 正则要「你自己/自身/盘古」紧挨「分析/扫描/排查」——
//       题目说的是**文件名** (llm_caller.js / j2_agent_loop.js), 没说「你自己」;
//     · SELF_INTRO_ASK 要「你是什么/介绍一下你自己」这类 —— 题目问的是两个文件。
//   ⇒ 题目既不是「自我介绍」也不是「全面自查」, 但它**确实**是关于盘古自己的源码的。
//
// 所以要单开一条判据: 题目里点名了**盘古自己的源码/模块** ⇒
//   ① BROAD_SELF_REPORT 对这份答案**不再生效** (它防的是灌水, 不是防分析);
//   ② 但**不放水**: 放行条件是「答案**确实在谈题目点名的那些对象**」
//      (见 _mentionsPanguSubject)。答案里一个都没有、只有一篇自我画像 ⇒
//      灌水守卫照咬 —— 「问盘古源码」不是万能豁免。
//
// 关键: 判据认的是「题目点名了盘古自己的**源码路径**」, 不是「答案里提到了盘古」。
//   回答里提一句「盘古」不会豁免 —— 只有**题目**点了源码才豁免。
//
// 词表按**现场真话**收 (不是按想象):
//   · 绝对路径落在盘古自己的仓库里 (apps/core/modules/… / 64i/… 等);
//   · 或者题目点名了盘古的模块名 (llm_caller / j2_agent_loop / j2_dispatcher / …)。
//   「问的是盘古自己的源码」有两种自然说法, 都得认。
const _PANGU_REPO_PATH_RE = /(?:^|[\s"'`(（])((?:~?\/)?(?:Users\/[A-Za-z0-9_-]+\/)?(?:Desktop\/)?pangu\/)/;
const _PANGU_SOURCE_MODULE_RE = /\b(?:llm_caller|j2_agent_loop|j2_dispatcher|j2_helpers|answer_alignment|answer_gates|subagent_runner|dispatch_subagents_exec|final_pipeline|runtime_verdict|internal_markers|session_container|chart_claim_guard|plan_verdict|summary_completion|j2_middleware|run_trace)\b/;

// 题目是否在问盘古自己的源码。
function asksAboutPanguSource(question) {
  const text = String(question || '');
  if (!text) return false;
  if (_PANGU_SOURCE_MODULE_RE.test(text)) return true;
  // 绝对路径落在盘古仓库里 —— 认的是**盘古这个仓库**, 不是任意绝对路径。
  const m = text.match(_PANGU_REPO_PATH_RE);
  return !!m;
}

// 答案有没有在谈**题目点名的那些对象**。
//
// 这是「问盘古源码」这条分流的放行条件 (2026-10-25 第 83 批):
//   题目点名 llm_caller.js / j2_agent_loop.js ⇒ 答案里出现这两个名字 ⇒ 谈的是正题
//   ⇒ 灌水守卫 (BROAD_SELF_REPORT) 让位。
//   答案里一个都没有, 只有「全面自画像 / 工具矩阵 / 三层记忆」⇒ 灌水 ⇒ 守卫照咬。
//
// 判据认的是**具体对象名** (从题目里抽), 不是「答案里有没有出现『盘古』」——
// 后者会把「盘古的源码地图显示…」这种描述对象的句子也当成谈正题。
function _mentionsPanguSubject(answer, question) {
  const a = String(answer || '');
  if (!a) return false;
  const q = String(question || '');
  // 从题目里抽出盘古的模块名 (题目点了哪些, 答案就该谈哪些)
  const names = [];
  const re = new RegExp(_PANGU_SOURCE_MODULE_RE.source, 'g');
  let m;
  while ((m = re.exec(q))) names.push(m[0]);
  // 题目给的是绝对路径 ⇒ 抽出文件名 (llm_caller.js) 当锚点
  const fileRe = /([A-Za-z0-9_-]+\.(?:js|json|md|sqlite|jsonl))/g;
  while ((m = fileRe.exec(q))) names.push(m[1]);
  if (!names.length) {
    // 题目只给了盘古仓库路径, 没点名具体模块 ⇒ 答案里出现仓库里的模块名就算谈正题
    return _PANGU_SOURCE_MODULE_RE.test(a);
  }
  for (const n of names) {
    if (n && a.indexOf(n) >= 0) return true;
  }
  return false;
}

// 明确要求「自我介绍」的问题。
//
// 为什么单开一条: BROAD_SELF_REPORT 这道守卫本来是拦「主人问 A，盘古答一整篇
// 自我介绍」的灌水(老板 2026-10-18 原话: 「这么大篇幅都在说计划、子agent, 用户
// 会在乎吗」)。但主人**真的**问「你是什么 / 介绍一下你自己」时, 自我介绍就是
// 答案本身, 拿自己的话当跑题证据, 等于把正确答案清空再回一句
// 「本轮未形成可核验答案」—— 这是拿守卫挡交付。
//
// 守卫对**没问**的场景必须照咬: tests/answer-alignment.test.js:60 锁着
// 「问排盘页为什么没详情 / 答一整篇全面自画像 → 必须拦」。
// 2026-10-26 (第 104 批, 实跑发现的洞): 这条正则原来要求「你」**紧跟**能力动词
// (`你(?:能|会|可以)(?:做什么|…)`), 于是中文里极常见的插字说法全部漏掉:
//   「用一句话说明**你现在**能做什么」 ← 「现在」夹在中间 ⇒ 不匹配
//   「**到底**能做什么」            ← 同上
//   「你**其实**会干什么」
//   「你能**帮我**干什么」
// 漏掉 ⇒ 走不进 isSelfIntroAsk 分流 ⇒ 掉进词法对齐门 ⇒ 本地模型明明答对了
// (「我可以帮你解答问题、整理信息…」) 也被判跑题 ⇒ 主人看到的是
// 「本轮未形成与原问题匹配的可核验答案，请重试。」
//
// 修法: 把「你」和能力动词之间允许出现**语气词/副词**这一层写进正则
// (中文里这几个字插在中间是常态, 不是特例)。
//
// ⚠ 边界: 放宽的是「你 + 能力动词」这个**固定搭配**, 不是泛化到所有问句 ——
//   「你能帮我分析磁盘空间吗」是**任务请求**, 不是自我介绍 ⇒ 仍然不匹配。
//   (那一条要求能力动词后面**紧跟**「做什么/干什么」这类疑问词组,
//    插了「帮我分析磁盘空间」就不是了。)
// 「你」和能力动词之间允许插入的东西, 分三段:
//   ① 语气/时间副词 (现在 / 目前 / 到底 / 其实 …) —— 可以**叠加**
//   ② 情态动词 (能 / 会 / 可以) —— 可有可无
//   ③ 客套前缀 (帮我 / 替我) —— 只允许**紧贴**能力动词
// ⚠ ③ 之所以只允许「帮我」这一种: 「你能帮我**分析磁盘空间**吗」是**任务请求**,
//   不是自我介绍 —— 靠的是 ③ 后面必须紧跟「做什么/干什么」这类疑问词组才成立。
// 2026-10-26 (第 105 批, 审计 agent 实测补漏): 再补三种插字说法 ——
//   「你**本质上**是什么」「你**都**有哪些能力」「你**都**能做什么」
//   ⇒ ADV 里加 '本质上' / '都'; 且把「通常来说」挪到「通常」**前面**
//   (JS 的正则交替是**先匹配到谁就算谁**, '通常' 在前会把 '通常来说' 切成 '通常' + '来说')。
const _SELF_INTRO_ADV = '(?:(?:现在|目前|当下|到底|究竟|其实|本质上|都|一般|通常来说|通常|原则上|基本上|大致|大体|真的|究竟能|还能|可以|能|会)*)';
const _SELF_INTRO_MODAL = '(?:能|会|可以)?';
const _SELF_INTRO_POLITE = '(?:帮我|替我|为我)?';
const SELF_INTRO_ASK = new RegExp(
  '(?:你' + _SELF_INTRO_ADV + '(?:是|叫|到底)(?:什么|谁|啥)'
  + '|自我介绍'
  + '|(?:介绍|说说|讲讲|描述|说明|讲明)(?:一?下)?\\s*你(?:自己|本人)'
  + '|你' + _SELF_INTRO_ADV + _SELF_INTRO_MODAL + _SELF_INTRO_POLITE + '(?:做|干)(?:什么|啥|些什么)'
  + '|你' + _SELF_INTRO_ADV + '(?:有什么|有哪些)(?:能力|功能|本事)'
  + '|你的(?:定位|职责|身份)(?:是|是什么)?'
  + '|你(?:负责|管)(?:什么|啥|哪些事|哪些事情|哪块|哪些方面)'
  + ')',
  'i'
);

function isSelfIntroAsk(question) {
  return SELF_INTRO_ASK.test(String(question || ''));
}

// 放过归放过, 但不能变成「问什么都算数」。
// 答案得**确实在讲自己**, 且不能是一句敷衍 —— 否则「你是什么」答「今天天气不错」
// 就成了合法答案。
function isSelfIntroAnswer(answer) {
  const text = String(answer || '');
  if (normalize(text).length < 8) return false;
  // 2026-10-26 (第 104 批): 原来只认「盘古/易经/agent」这类**实体名**,
  // 或者「我就是/我是/我叫」这种**自我介绍句**。
  // 但中文里答「你能做什么」最自然的答法是**第一人称讲能力**, 不一定报名字:
  //   「我可以帮你解答问题、整理信息、分析思路、写作创作, 并处理许多日常和学习工作中的任务。」
  //   ↑ 这句**完全对题**, 但既没出现「盘古」, 也不是「我是…」(是「我可以…」)
  //   ⇒ 老判据判 false ⇒ 主人看到的是「本轮未形成与原问题匹配的可核验答案，请重试。」
  // (实跑: 本地 qwen3.8-27b 答得挺好, 却被守卫拦了 —— 拦的是**正确答案**。)
  //
  // 放宽的口子: 第一人称 + 能力/职责动词。
  //   「我(能|会|可以|负责|擅长|主要)…」 = 这段话在讲**自己能做什么**。
  // 仍然拦得住的: 天气/闲聊/超短回答 —— 它们没有第一人称能力陈述
  //   (「今天北京天气晴, 适合出门」没有「我…」→「不是自我介绍」⇒ 照拦)。
  return /(盘古|pangu|我(?:就是|是|叫)|易经|占问|卦象|将灵|agent|智能体)/i.test(text)
    || /我(?:能|会|可以|能够|擅长|主要|负责)(?:帮|为|做|回答|解答|处理|提供|协助|搞定|处理这些|做这些|做的事|负责)/i.test(text)
    || /我(?:能|会|可以|能够|擅长|主要|负责)[^。！？\n]{0,40}(?:工作|任务|事情|问题|活儿|事儿|需求)/i.test(text);
}

function hasSelfInspectionEvidence(answer, evidenceText = '') {
  const text = String(answer || '') + '\n' + String(evidenceText || '');
  const refs = _extractEvidenceRefs(text);
  let fs, path, os;
  try { fs = require('fs'); path = require('path'); os = require('os'); } catch (_) { return false; }
  const verified = refs.filter(ref => {
    const raw = ref.file.replace(/^~\//, os.homedir() + '/');
    const cwd = process.cwd();
    // The service and tests are launched from different roots (repo root or
    // apps/core). Try both so valid `apps/core/...` evidence is not rejected
    // merely because the current working directory changed.
    const candidates = [
      raw,
      path.resolve(cwd, raw),
      path.resolve(cwd, 'apps/core', raw),
      path.resolve(cwd, '..', '..', raw),
      // 2026-10-25 (第 83 批): **裸文件名**。
      //   盘古分析自己源码时写的是「`llm_caller.js`(L772)」—— 只给文件名 + 行号,
      //   不给路径 (现场 probe82-real-split 刀3 综合正文逐字)。原来四个候选全是
      //   「路径拼法」变体, 裸文件名一个都命中不了 ⇒ 取证判据收不到证据 ⇒
      //   「问盘古自己源码」这条路永远判 false ⇒ 综合稿被丢, 回落成子 agent 原文拼接。
      //   盘古的模块集中在 apps/core/modules/ 和 apps/core/64i/, 按这两处试一遍。
      path.resolve(cwd, 'modules', path.basename(raw)),
      path.resolve(cwd, 'apps/core/modules', path.basename(raw)),
      path.resolve(cwd, 'apps/core/64i', path.basename(raw)),
      path.resolve(cwd, '..', '..', 'apps/core/modules', path.basename(raw)),
      path.resolve(cwd, '..', '..', 'apps/core/64i', path.basename(raw)),
    ];
    const file = candidates.find(p => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!file) return false;
    try { return ref.line > 0 && ref.line <= fs.readFileSync(file, 'utf8').split(/\r?\n/).length; } catch (_) { return false; }
  });
  if (verified.length < 2) return false;
  // A self-report that claims a commit must name a real commit in this checkout.
  // This blocks invented hashes such as "8d9b3dc" from being presented as proof.
  const commitClaims = [...text.matchAll(/(?:commit|提交)[\s:#]*([0-9a-f]{7,40})/gi)].map(m => m[1]);
  if (commitClaims.length) {
    const child = require('child_process');
    for (const hash of commitClaims) {
      try { child.execFileSync('git', ['rev-parse', '--verify', hash + '^{commit}'], { cwd: process.cwd(), stdio: 'ignore' }); }
      catch (_) { return false; }
    }
  }
  return true;
}

// 取证行号 —— 认**两种**现场真实格式 (2026-10-25 第 83 批补)。
//
// 原先只有一种: `file.ext:123` (EVIDENCE_REF)。
// 但盘古**分析自己源码**时用的格式根本不是那个 —— 现场 probe82-real-split
// 刀3 的综合正文逐字是:
//   「`_buildSystemMessages`(L772)、`_loadToolSummary`(L302)」
//   「`init(deps)` 注入 `_config/fs/path/https/PRESETS/PANGU_SYSTEM_PROMPT`（L47-88）」
//   「`module.exports` 在 2593 行」
// 三种写法里**一种都不匹配** `file.ext:123` ⇒ 取证判据一个证据都收不到 ⇒
// 「全面分析你自己」那条路永远判 false (一个问对了的源码盘点被判跑题)。
//
// 这次补的三种格式都来自**现场真话**, 不是按想象收的:
//   ① `file.ext:123`          —— 原有
//   ② `file.ext(L123)` / `(L123-456)`  —— 盘古源码分析的主力写法
//   ③ `file.ext L123` / `file.ext 第123行` —— 也出现过
//
// 行号必须**能落到真文件的那一行**, 否则跟没取证一样 (下面 verified 那段会核)。
// 区间写法 (L47-88) 取**起始行**, 起始行越界同样算不通过。
const _EVIDENCE_REF_PAREN = /([A-Za-z0-9_.\/~-]+\.(?:js|json|md|sqlite|jsonl))\s*[（(]\s*L?(\d+)/gi;
const _EVIDENCE_REF_SPACE = /([A-Za-z0-9_.\/~-]+\.(?:js|json|md|sqlite|jsonl))\s+(?:第\s*)?L?(\d+)\s*行?/gi;

function _extractEvidenceRefs(text) {
  const src = String(text || '');
  const out = [];
  const push = (file, line) => {
    const n = Number(line);
    if (!Number.isFinite(n) || n <= 0) return;
    out.push({ file: String(file), line: n });
  };
  let m;
  EVIDENCE_REF.lastIndex = 0;
  while ((m = EVIDENCE_REF.exec(src))) push(m[1], m[2]);
  _EVIDENCE_REF_PAREN.lastIndex = 0;
  while ((m = _EVIDENCE_REF_PAREN.exec(src))) push(m[1], m[2]);
  _EVIDENCE_REF_SPACE.lastIndex = 0;
  while ((m = _EVIDENCE_REF_SPACE.exec(src))) push(m[1], m[2]);
  out.push(..._extractSectionScopedRefs(src));
  return out;
}

// 「小节作用域」取证 —— 盘古分析自己源码时的**主力写法**。
//
// 现场 (probe82-real-split 刀3 的综合正文, 逐字):
//   **llm_caller.js（2645 行）= LLM 传输层**
//   - `init(deps)` 注入 `_config/fs/path/https/PRESETS/PANGU_SYSTEM_PROMPT`（L47-88）
//   - 提示词/记忆装配：`_buildSystemMessages`(L772)、`_loadToolSummary`(L302)
//   ...
//   **j2_agent_loop.js（6096 行）= Agent 编排层**
//   - `_runAgentLoopLegacyStream`(L804) 单一入口 …
//
// 也就是说: **文件名在小节标题行, 行号在下面若干条条目行**。
// 全局正则扫「文件名+行号成对」一个都配不出来 (文件名和行号隔了好几行),
// 于是取证判据收不到证据 ⇒ 「问盘古自己源码」这条路永远判 false。
//
// 修法: **按行扫**, 维护一个「当前小节的文件名」, 拿它跟本行的 L行号配对。
//   · 小节标题行 = 含 `xxx.js` 且该行后面跟着 (行数|行) 或行内还有 L行号;
//   · 条目行 = 含 (L123) / (L123-456) / L123 这种行号, 且上下几行内能找到文件名。
//
// 为什么按「上下几行」而不是「整个小节」: 小节可能很长 (现场那份 llm_caller 小节有 7 行),
// 但行号跟文件名的距离不超过一两行 —— 现场逐字就是这么写的。
// 取一个**有限窗口**(默认 3 行), 窗口外的行号不配 —— 免得把 A 文件的行号算到 B 文件头上。
const _SECTION_FILE_RE = /([A-Za-z0-9_.\/~-]+\.(?:js|json|md|sqlite|jsonl))/;
const _BARE_LINE_REF_RE = /[（(]\s*L?(\d+)(?:\s*[-–~]\s*\d+)?\s*[）)]|(?:^|[\s:：])(?:L|pangu-single\s*:)?(\d{2,5})\s*(?=[,，。、)\s]|$)/g;

function _extractSectionScopedRefs(src) {
  const lines = String(src || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 先看这一行是不是「小节标题行」: 有文件名, 且这行还带一个总行数标注
    //   (现场形态: `**llm_caller.js（2645 行）= LLM 传输层**`)
    const fm = line.match(_SECTION_FILE_RE);
    if (!fm) continue;
    const file = fm[1];
    // 本行的行号标注 —— 两种: `（2645 行）` 和 `(L2645)`
    const total = line.match(/[（(]\s*L?(\d+)\s*行?/);
    if (total) {
      const n = Number(total[1]);
      if (Number.isFinite(n) && n > 0) out.push({ file, line: n, scoped: true });
    }
    // 往下看几行, 把「只带 L行号、不带文件名」的条目行归到这个小节的文件名下
    for (let k = i + 1; k <= Math.min(lines.length - 1, i + 3); k++) {
      const below = lines[k];
      if (_SECTION_FILE_RE.test(below) && /[（(]\s*L?\d+\s*行?\s*[）)]/.test(below)) break; // 下一个小节标题
      const bare = [...below.matchAll(_BARE_LINE_REF_RE)];
      for (const bm of bare) {
        const n = Number(bm[1] || bm[2]);
        if (Number.isFinite(n) && n > 0) out.push({ file, line: n, scoped: true });
      }
    }
  }
  return out;
}

function normalize(text) {
  return String(text || '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[`*_#>\[\]{}()（）「」“”‘’、，。！？：；…—\-]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function terms(text) {
  const s = normalize(text);
  const out = new Set();
  for (const word of s.match(/[a-z0-9][a-z0-9._/:+-]{2,}/g) || []) out.add(word);
  for (const run of s.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    if (run.length <= 8 && !STOP.has(run)) out.add(run);
    for (let i = 0; i < run.length - 1; i++) {
      const pair = run.slice(i, i + 2);
      if (!STOP.has(pair)) out.add(pair);
    }
  }
  return out;
}

// 2026-09-12 七次: 证据锚点匹配 — 答案是"消化/执行报告"且引用了 tool_result 里的
// 真实文件路径/字节数/行数/章节号 → 视为对齐, 不再拿问题标题逐词匹配 (易经营案 Round 3/4 真因)。
// 这是"有枪就用" — 有硬证据就信证据, 词法只做 0 工具时的嘴炮兜底。
function hasArtifactEvidence(answer, evidenceText) {
  const a = String(answer || '');
  const ev = String(evidenceText || '');
  if (!ev || !a) return false;
  // 答案里出现 tool_result 证据里也有的具体文件扩展名引用 (总结.md / xx.txt / 字节数 N)
  const fileRefs = a.match(/[\w\u4e00-\u9fff.\-]{2,40}\.(?:md|txt|json|sqlite|pdf)\b/g) || [];
  const numRefs = a.match(/\d{2,5}/g) || [];
  const evNorm = ev.toLowerCase();
  let anchored = 0;
  for (const f of fileRefs.slice(0, 6)) {
    if (evNorm.includes(f.toLowerCase())) anchored++;
  }
  for (const n of numRefs.slice(0, 8)) {
    if (evNorm.includes(n)) anchored++;
  }
  // 写文件动作证据 (tool_result 里有 "字节" / "行" / "写入" / write_file 成功)
  const writeProof = /(字节|byte|行|写入|write_file|file_edit|落盘)/i.test(ev);
  return anchored >= 2 || (anchored >= 1 && writeProof && numRefs.length >= 1);
}

// 2026-10-28 第 129 批: 「做题」类问题的两道判据 (配套说明见 isAligned 里的分流)。
//
// 为什么单独写在这儿而不是内联: isAligned 是盘古最老的一道门, 改它要留证据 ——
//   判据 = 主人话里出现「做题/看题/逐条答」这类**做题指令**, 且话里没有卦味
//   (卦象题也有「做题」, 但那不是排盘八条, 走词法门才对)。
function isBatchItemQuestion(question) {
  const q = String(question || '');
  if (!q) return false;
  if (/(卦|占卜|梅花|起卦|易经)/.test(q)) return false;
  return /(做题|看清楚题目|看题|逐条答|照题目|按题目)/.test(q);
}

// 覆盖关键词的唯一真源在 modules/bazi_items.js (别在这里另抄一份 —— 两份同义文本改一次就漂)。
function itemCoverageKeys() {
  try {
    const keys = require('./bazi_items').COVER_KEYS;
    if (Array.isArray(keys) && keys.length) return keys;
  } catch (_) { /* 模块不在就退到空表 */ }
  return [];
}

function isAligned(question, answer, evidenceText = '') {
  const q = normalize(question);
  const a = normalize(answer);
  if (!q || !a || q.length < 6) return true;
  // 2026-10-28 第 129 批: 「做题」类问题改用**覆盖检查**, 不用词法重叠。
  //
  // 现场 (2026-10-27 23:40, 会话 15567183): 老板发课件《排盘样例》图 +「做题，看清楚题目」。
  //   主人这一轮的话里**一个内容词都没有**(做题/看清楚/题目) ⇒ 词法门判它「零命中 = 跑题」=
  //   判死, 主人收到的会是「我没有拿到与原问题对齐的答案」。
  //   这跟 2026-10-26 第 104 批那起「正确答案被对齐门吃掉」是同一个病。
  //
  // 这条路上词法门**本来就用不了** —— 问题没有内容词, 拿什么算重叠?
  // ⇒ 改成**正向覆盖检查**: 答案必须点到课件八条里的若干条
  //   (身强身弱/喜用用神/原局十神/身一体/财运/婚姻感情/大运流年/出生地),
  //   点到才算答了这道题; 一个都不点 = 没按题目答, 拦。
  //
  // 题目清单真源 = modules/bazi_items.js 的 ITEMS (不许在这里另抄一份)。
  if (isBatchItemQuestion(question)) {
    const covered = itemCoverageKeys().filter(k => a.indexOf(k) >= 0);
    if (covered.length >= 3) return true;
    // 覆盖不够 → 落到下面的常规判据 (万一主人在问别的, 词法门还能给出路)。
  }
  // 2026-10-25 (第 84 批 b): 「主人问盘古自己的源码」这条路上, 编排话术守卫要让位。
  //
  // 现场 (2026-10-25 probe83b-fixed, 综合稿 5671 字):
  //   主人问「分别分析 llm_caller.js 和 j2_agent_loop.js 各自负责什么, 然后综合说明怎么配合」
  //   综合稿里逐字有两处:
  //     ① 「决定下一轮」            ← 在讲 j2_agent_loop 的轮次逻辑
  //     ② 「`agents/sub-agent` 的 ROLES」 ← 这是**一个路径**
  //   TRANSCRIPT_LEAK 是**无条件短路闸** (不走 concrete 豁免) ⇒
  //   「下一轮」「sub-agent」这两个词就把整篇 5671 字的源码分析判死
  //   ⇒ guardAnswer 回落 `_subConclusionFallback` ⇒ 主人收到的是三段
  //   `### li` 原文拼接 (末尾断在半句), 而不是综合稿。
  //
  // 根因跟第 83 批修的那几个是**同一个**: 守卫拿**词**当判据,
  // 分不清「盘古在编排话术」和「盘古在讲自己的代码里就有这个词」。
  //
  // 修法: 复用**已经存在**的「实质报告」豁免 (2026-09-14 为同一类病加的):
  //   长度 ≥200 且具体证据 ≥3 个 = 内容 + 元话调料, 不是纯编排泄漏。
  //   跟 ORCHESTRATION_MARKERS 那条路**同一把尺子** (_isSubstantiveReport)。
  //
  // ⚠ 只对「题目点名盘古自己源码」这条路开 —— 别的题 (排盘页为什么没详情这种)
  //   编排守卫照旧一词灭口。泄漏样本 (「汇报：A. …」) 全部短于 200 字 ⇒ 不受影响。
  if (isOrchestrationLeak(answer)) {
    if (!(asksAboutPanguSource(question) && _isSubstantiveReport(answer))) return false;
  }
  // 顺序等价于原来的 `!isSelfInspection && BROAD_SELF_REPORT` 再 `isSelfInspection`:
  // isSelfInspection 为真时, 第一行本来就是个空操作, 先判它不改变任何行为。
  if (isSelfInspection(question)) return hasSelfInspectionEvidence(answer, evidenceText);
  if (isSelfIntroAsk(question)) return isSelfIntroAnswer(answer);
  // 2026-10-25 (第 83 批): 题目点名盘古自己的源码 ⇒ 灌水守卫让位给**取证口径**。
  //
  // 原来只有两道分流 (isSelfInspection / isSelfIntroAsk), probe82-real-split 那道题
  // 两道都不匹配 (题目问的是两个**文件名**, 没说「你自己」; 也不是「你是什么」),
  // 于是掉进 BROAD_SELF_REPORT ⇒ 综合稿被判跑题 ⇒ guardAnswer 回落到
  // `_subConclusionFallback` ⇒ 主人收到三段 2000 字截断的子 agent 原文拼接,
  // 末尾断在半句, 还带着 `### li` 内部代号。
  //
  // 这里**不放水**, 只换口径: 灌水守卫让位, 但**判据仍然是词法对齐** ——
  // 题目点名了 llm_caller.js / j2_agent_loop.js, 答复就得谈这两个东西,
  // 谈不到自然会被词法门拦下。这跟「主人问 A 盘古答一篇自我介绍」是两回事:
  // 后者跟题目**毫无词面关联**, 靠词法门就能拦; 前者**本来就有**关联,
  // 是灌水守卫**误伤**了它。
  //
  // 为什么不给它开 file:line 取证豁免 (看着更严, 其实是另一种误伤):
  //   取证口径是给「**全面分析你自己**」准备的 (isSelfInspection 那条路) ——
  // 那种问题的答案就是一份盘点, 必须带 file:line 才算数。
  //   但「这两个文件各自负责什么」是**普通问答**, 答「llm_caller.js 是传输层」
  //   就是完整答案, 拿不出行号也该放行。给它套取证口径 = 把一道正常问答复核成考试。
  //   ⇒ 两道分流要的东西不同, 就该用不同的判据, 不该硬凑成一条。
  if (asksAboutPanguSource(question)) {
    // 题目点名盘古源码 ⇒ 灌水守卫**要让位**, 但不是无条件让位。
    //
    // 守卫存在的理由是「主人问 A, 盘古答一篇自我介绍」—— 那种答案跟题目**毫无
    // 词面关联**。所以正确的放行条件是「答案**确实在谈题目点名的那些东西**」,
    // 而不是「题目提到了源码就一律放行」(那样的话盘古答一篇全面自画像也能过 ——
    // 守卫就被整条拆了)。
    //
    // 判据 = 词法锚点: 答案必须提到题目点名的那**具体模块/文件**。
    //   现场 probe82 的综合稿里出现了 llm_caller.js / j2_agent_loop.js ⇒ 谈的是正题 ⇒ 放行。
    //   一篇「盘古全面自画像: 身份与底座 / 工具矩阵 / 三层记忆」里没有它们 ⇒ 灌水 ⇒ 拦。
    if (!_mentionsPanguSubject(answer, question)) {
      // 没谈题目点名的对象 ⇒ 灌水守卫照咬 (跟「没问」的场景一样)
      if (BROAD_SELF_REPORT.test(String(answer || ''))) return false;
    }
    // 谈的是正题 ⇒ 判据走词法对齐 (题目问什么、答什么, 对得上就行)
    return _lexicalAligned(q, a, evidenceText, question, answer);
  }
  if (BROAD_SELF_REPORT.test(String(answer || ''))) return false;
  return _lexicalAligned(q, a, evidenceText, question, answer);
}

// 词法对齐 —— 从 isAligned 里抽出来, 让上面两条分流能复用同一套判据。
//
// 为什么抽: 第 83 批要在 isAligned 内部做**分流** (题目问盘古源码 ⇒ 换口径),
// 而词法那段是分流之后**两条路都要走**的公共部分。抄一份 = 以后必然改漏一处
// (这正是 2026-10-12「同一个修复只打了一半」的成因)。
// 抽出来之后, 词法判据**只有这一份**, 两条分流共用。
function _lexicalAligned(q, a, evidenceText = '', question = '', answerRaw = '') {
  // `a` 是 normalize 过的答案; 这几处判据要的是**原文** (精确子串 / 正则),
  // 归一化会把标点和小写改掉, 用 `a` 会改变行为。所以原文单独传进来。
  const answer = answerRaw;
  if (/^(是|否|可以|不可以|能|不能|有|没有|会|不会|好|不行|行)[。.!！]?$/i.test(a)) return true;
  // 2026-10-14 (老板报「盘古不肯说话」): 旧码 `if (a.length < 6) return false;` 把
  // **正确**的短答案整个清空 —— 问「1+1等于几?直接回答数字。」模型答「2」(1 字)、问
  // 「请只回复:收到」答「收到」「好的，收到」「已收到, 谢谢」, 全部被判跑题, 用户只看到
  // 「本轮未形成与原问题匹配的可核验答案, 请重试。」然后反复重试。实测: 寒暄「你好」能过,
  // 越是索要具体答案越被拒 —— 因为判据是「答案有没有复述问题的词」, 与对错无关。
  //
  // 逆向 Codex (codex-cli 26.1007) 的结论: 它没有这道关卡。反幻觉落在三处 ——
  //   ① 提示层 "Do not hallucinate completion" / "Do not present unverified ... as confirmed"
  //   ② 工具结果来源与截断记账 (tool_result_source / original_bytes / omitted_calls)
  //   ③ Guardian 的**动作**风险闸门 (管命令审批, 不管答案对错)
  // 词法对齐门是盘古独有的发明, 而它是纯负向判据 (重叠低 = 跑题), 必然误杀短而正确的答案。
  //
  // 改法不能只看长度 —— 回归锁 tests/answer-alignment.test.js:42 要求「检查路由 bug」答
  // 「天气不错」仍然拦: 短, 但确实跑题。所以豁免只对**在索要直接答案**的问题生效。
  // 阈值取 12 而不是 6: 覆盖「已收到, 谢谢」这类带礼貌语的实际回答。长答案的跑题检测
  // 与 9/30 那次 496 token 实质答案被吃掉的回归锁
  // (tests/alignment-eaten-answer-20261001.test.js) 均原样保留。
  const _qRaw = String(question || '');
  const _wantsDirect = _WANTS_DIRECT_RE.test(_qRaw);
  if (_wantsDirect && a.length < 12) return true;
  // 问题点名要某个具体答案 (只回复:X / 直接回答…) → 答案里带上它就算对齐,
  // 不再要求凑够 2 个词法锚点。相当于把上面那个是/否/可以白名单推广到「问题即答案」。
  const _want = _qRaw
    .match(/(?:只|仅|直接|原样)\s*(?:回复|回答|答|返回|给出)\s*[:：]?\s*([^\s，。？！、；]{1,12})/)
    // 「只回两个字：收到」这个形状: 答案在冒号**后面**, 冒号前面是「两个字」。
    //   原来那个 _want 抓不到(它要动词紧挨冒号), 于是「收到」判跑题被拒。
    || _qRaw
      .match(/(?:一|两|二|三|四|五|六|七|八|九|十|几)\s*(?:个字|句话)\s*[:：]\s*([^\s，。？！、；]{1,12})/);
  if (_want && String(answer || '').indexOf(_want[1]) >= 0) return true;
  // Narrow evidence-based exception for list/query requests that explicitly
  // ask for a filename/path only. A single verified basename is the complete
  // answer in that contract; requiring two lexical/evidence anchors wrongly
  // rejected valid `ls` results from MiniMax native-tool rounds.
  if (/(?:只|仅).{0,8}(?:返回|给出|报告).{0,8}(?:文件名|路径)|(?:文件名|路径).{0,6}(?:即可|就行|为主)/i.test(String(question || ''))
    && evidenceText) {
    const refs = String(answer || '').match(/[A-Za-z0-9_./~\u4e00-\u9fff（）()【】&\-]+\.(?:md|txt|json|sqlite|pdf|csv|html|js|jsx|ts|tsx|docx|png|jpg|jpeg|mp4)\b/gi) || [];
    const uniqueRefs = [...new Set(refs.map(x => x.replace(/^.*\//, '')))];
    const ev = String(evidenceText).toLowerCase();
    if (uniqueRefs.length === 1 && ev.includes(uniqueRefs[0].toLowerCase())) return true;
  }
  const qTerms = terms(q);
  if (!qTerms.size) return true;
  const aTerms = terms(a);
  let hits = 0;
  let latinHit = false;
  for (const term of qTerms) {
    if (aTerms.has(term) || a.includes(term)) {
      hits++;
      if (/^[a-z0-9][a-z0-9._/:+-]{2,}$/i.test(term)) latinHit = true;
    }
  }
  // Execution reports often answer with derived facts (counts, filenames,
  // categories) rather than repeating the user's wording. When the tool
  // transcript contains those same concrete anchors, treat the answer as
  // aligned instead of rejecting it for low lexical overlap.
  // 2026-09-12 七次: 证据主判 — 答案是执行/消化报告且锚定 tool_result 真证据 → 直接对齐。
  // (旧词法 evidenceHits>=2 太严, 把"起了时法+纳甲"的真报告判跑题; 证据锚点才是对的判据)
  if (hasArtifactEvidence(String(answer || ''), evidenceText)) return true;
  if (evidenceText && /(?:工具结果|tool_result|stdout|文件|目录|统计|汇总|清点|已执行|字节|写入|落盘)/i.test(String(answer))) {
    const evidence = normalize(evidenceText);
    let evidenceHits = 0;
    for (const term of aTerms) {
      if (term.length >= 3 && evidence.includes(term)) evidenceHits++;
      if (evidenceHits >= 2) break;
    }
    if (evidenceHits >= 2) return true;
    const concreteFacts = (a.match(/\d+/g) || []).length + (a.match(/[A-Za-z0-9_./-]+\.(?:txt|md|json|pdf|mp4)/g) || []).length;
    if (concreteFacts >= 2) return true;
  }
  // Longer questions need two independent anchors. One incidental word (for
  // example “现在” or “问题”) is not evidence that the answer addresses it.
  return hits >= (q.length >= 7 && !latinHit ? 2 : 1);
}

function guardAnswer(question, answer, fallback, evidenceText = '') {
  const clean = String(answer || '').trim();
  if (isAligned(question, clean, evidenceText)) return { text: clean, aligned: true };
  const backup = String(fallback || '').trim();
  if (backup && isAligned(question, backup, evidenceText)) {
    return { text: backup, aligned: true, recovered: true };
  }
  // 2026-10-14 守卫记账: 盘古的守卫以前不留任何痕迹 —— 拒答了现场只能靠猜
  // ("为什么它不肯说话")。codex 那边对应的做法是 Guardian 只管动作风险 +
  // tool_result 落库, 答案层不留词法关卡; 盘古守卫继续存在 (排盘不许编造是产品定义),
  // 但**必须留痕**: 谁按哪条依据拒的、原文是什么, 才谈得上"改得对"。
  // 写当日账本 (guards-<date>.jsonl) 而不是每次拦一个文件: 现场统计 206 个 trace
  // 里 101 个是 guard, 一条一个文件等于把目录冲成垃圾场, 反而查不动。
  try {
    const _rt = require('./run_trace');
    _rt.appendGuard({
      guard: 'answer_alignment',
      action: 'block',
      reason: 'isAligned=false (词法/证据锚点不足)',
      userInput: String(question || '').slice(0, 120),
      detail: 'primary_len=' + clean.length + (backup ? ' backup_len=' + backup.length : ' backup=无'),
    });
  } catch (_) {}
  return {
    text: `我没有拿到与原问题对齐的答案。原问题是：${String(question || '').trim()}\n当前结果未通过问题对齐校验，未将跑题内容当作答案。`,
    aligned: false,
    blocked: true,
  };
}

// Short confirmations are continuations, not standalone tasks. Route and
// alignment must inherit the last substantive user request from the same
// conversation, otherwise "ok, go" is treated as a new unrelated question.
// 2026-09-22 (session 60273479 实案: 同一道灾煞题重发 3 次, 盘古每次从头重新起卦+复述):
// 识别"同问重发" — 新 input 跟上一条 user input 高度相似 + 上轮 assistant 已给实质答案
// → 标记【重复提问·基于上轮精炼】, 让 LLM 直接基于上轮答案确认/补全, 禁止从头重新起卦。
const _normForDup = (s) => String(s || '').replace(/主人问题:\s*/g, '').replace(/【盘古起卦[^]*?主人问题:\s*/u, '').replace(/\s+/g, '').replace(/[，。？！、；：""''（）()【】]/g, '').toLowerCase();
const _commonRatio = (a, b) => {
  if (!a || !b) return 0;
  const short = Math.min(a.length, b.length), long_ = Math.max(a.length, b.length);
  let c = 0;
  while (c < short && a[c] === b[c]) c++;
  return c / long_;
};

// 2026-10-12 (老板报"会话 80922578"): 盘古被纠正时**无条件顺着改口**, 零核验。
// 实案同一道八字题: 身强身弱连续翻了 4 次 ——
//   第1轮 判"偏弱" → 主人"原主情况都没分析" → 改口"身偏旺, 印旺"
//   → 主人"身强还是身弱?喜用呢?" → "应判偏强偏燥, 不宜定作偏弱"
//   → 主人"为什么偏强? 肯定偏弱啊?" → "你说得对, 更应判偏弱"
//   → 主人"整道题要重新做" → "全部暂缓, 无法定论"
// 每一轮都没有调过任何排盘/核对工具, 纯粹跟着主人最新一句话翻面。
//
// 机制: 主人话里出现纠正信号(不对/错了/不是/应该是/肯定/搞错/看岔…)且本会话已有实质
// 答复 → 注入一条"改口前先交代依据"的约束。不是不许改, 是不许**无条件**改:
// 要么指出是哪一条依据变了, 要么明说依据不足定不了。禁止只回一句"你说得对"。
// 词表是照着会话 80922578 里主人**实际说的话**收的, 不是凭想象列的:
//   "不对吧, 你是不是看岔了?" "为什么偏强? 肯定偏弱啊?" "那题要重做" "整道题要重新做, 细心点"
//   "原主什么情况你都没分析" "这些不在里面" "重新输出完整答案"
const _CORRECTION_RE = /(不对|错了|搞错|看岔|你应该|应该是|肯定(?!对)|你确定|真的吗|哪里错|明明|并不是|重做|重来|重新|作废|都没分析|都没加|漏了|不在里面|这些不在|细心点|有疑问|再看看|重新看)/;
// 2026-10-12 (会话 80922578 根修): 纠错判定从"只注提示词"升级为"机制判定 + 强制复核"。
// isCorrectionTurn 与 _buildCorrectionBlock 共用同一套词表/前提, 供 dispatcher 在纠错轮
// 对子 agent 的答复做事后核验 —— 光注入纪律是软约束, 模型照样可以只回"你说得对"。
function isCorrectionTurn(raw, messages) {
  try {
    const q = String(raw || '');
    if (!_CORRECTION_RE.test(q)) return false;
    return (messages || []).some(m => m && m.role === 'assistant'
      && typeof m.content === 'string' && m.content.trim().length > 40);
  } catch (_) { return false; }
}

// 无依据改口 (bare flip): 答复里带顺从/认错措辞, 但①没引用任何可核验来源
// (工具返回/盘面原文/重算/文件), ②本轮 0 真实工具调用 —— 那就是跟着主人的话翻面, 不是推理。
// 词表照会话 80922578 实案收: "你说得对, 更应判偏弱" (0 工具, 无来源引用)。
// 反例 (不误伤): verify-002 的 "你说'偏弱'是有依据的: 丁火生未月…" — 无顺从措辞, 不命中。
const _CONCESSION_RE = /(你说得对|您说得对|你说得没错|你说的是对的|你说对了|是我错了|我错了|是我搞错|是我看岔|之前判错|是我分析错|接受你的纠正)/;
const _VERIFIABLE_SOURCE_RE = /(重新排|重算|bazi_calc|工具(返回|结果|显示)|图上(原文|写|标)|盘面原文|原文(写|说|标)|核实|查[到证]|数据(显示|表明)|根据[^，。；]{0,24}(显示|表明|原文|记录|返回))/;
function isBareFlip(answer, toolsUsed) {
  try {
    const t = String(answer || '');
    if (!_CONCESSION_RE.test(t)) return false;
    if (_VERIFIABLE_SOURCE_RE.test(t)) return false;
    if (Array.isArray(toolsUsed) && toolsUsed.length > 0) return false;
    return true;
  } catch (_) { return false; }
}
function _buildCorrectionBlock(raw, messages) {
  try {
    const q = String(raw || '');
    if (!_CORRECTION_RE.test(q)) return '';
    const hasAnswer = (messages || []).some(m => m && m.role === 'assistant'
      && typeof m.content === 'string' && m.content.trim().length > 40);
    if (!hasAnswer) return '';
    return '\n\n【纠错纪律 — 系统强制】主人这句话是在纠正你上一轮的结论。铁律:\n'
      + '1. 禁止只回一句"你说得对/是我错了"就翻面 —— 那是谄媚, 不是推理。\n'
      + '2. 改口前必须先交代**依据**: 具体指出是哪一条事实/数据/规则变了导致结论反转; '
      + '或直接调用工具重算。\n'
      + '3. 如果主人只是给了个说法而你没有独立依据, 就如实说"这是按你给的前提推的, '
      + '我自己手上没有能验证它的数据", 然后说明在什么条件下结论才成立 —— 禁止无条件点头。\n'
      + '4. 同一道题你已经在本会话里反复改过结论时, 不要再翻第五次: 直接列出"要定论还缺什么'
      + '(出生年月日时/性别/出生地/起运岁数/原始盘面)", 把缺项一次性问清楚。';
  } catch (_) { return ''; }
}

function _isDuplicateQuestion(raw, messages) {
  if (!raw || !Array.isArray(messages)) return false;
  // 2026-10-12 P0 (老板报"会话 75738498 接不上上文", 实锤): 桌面端 ChatRoom 发的是
  //   messages = [...历史, 当前这条 user] —— 当前轮**已经在 messages 里**。
  // 旧代码直接取最后一条 user 当"上一轮", 等于拿 raw 跟它自己比 → 相似度恒为 1.0 →
  // 每一轮新问题都被判成"同问重发", 然后注入【重复提问·已答过】+"禁止从头重新起卦 /
  // 禁止重读已读过的文件 / 禁止重复上轮全文"。后果: 追问和纠错全被压成"在上轮答案上精炼",
  // 模型拒绝重新推导 → 接不上上文。
  // 修: 先把内容就是 raw 的那些 user 消息(= 本轮自己)剔掉, 再找真正的上一轮。
  // 主人真把同一句话再发一遍时, 剔掉本轮后依然能命中上一轮 → 重发识别不受影响。
  const _normRaw = _normForDup(raw);
  const _rawTrimmed = String(raw).trim();
  const _isSameTurn = (m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()
    && (m.content.trim() === _rawTrimmed || _normForDup(m.content) === _normRaw);
  const _userTurns = messages.filter(m => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim());
  // 只剔掉**最后那一条**(客户端本轮追加的), 不能按内容全剔 —— 主人原样重发时
  // 两条 user 内容相同, 全剔会把真正的上一轮也删掉, 重发识别就失效了。
  let _cut = _userTurns.length - 1;
  if (_cut >= 0 && _isSameTurn(_userTurns[_cut])) _cut -= 1;
  const lastPrev = _cut >= 0 ? String(_userTurns[_cut].content || '').trim() : '';
  if (!lastPrev) return false;
  // 当前 raw 跟上一条 user 高度相似 (去空白/标点/起卦前缀后, 共享前缀长度 / 短串长度 > 0.6)
  const _norm = (s) => String(s || '').replace(/主人问题:\s*/g, '').replace(/【盘古起卦[^]*?主人问题:\s*/u, '').replace(/\s+/g, '').replace(/[，。？！、；：""''（）()【】]/g, '').toLowerCase();
  const a = _norm(raw), b = _norm(lastPrev);
  if (!a || !b) return false;
  const short = Math.min(a.length, b.length), long_ = Math.max(a.length, b.length);
  // 共享前缀长度
  let common = 0;
  while (common < short && a[common] === b[common]) common++;
  // 2026-10-12: 共享前缀不足以判重发。老板连着问"2026 年的流年运势"/"2027 年的流年运势",
  // 共享前缀能到 0.7+, 旧的 0.4 阈值会把这种追问也当成重发。收紧成"必须是同一句话":
  // 归一化后完全相等, 或一方是另一方的真子串**且长度接近**(主人只改了标点/加个称呼)。
  const _exact = a === b;
  const _contained = (b.includes(a) || a.includes(b)) && short / long_ >= 0.9;
  const _similar = _exact || _contained;
  if (_similar) {
    const hasAssistantAnswer = messages.some(m => m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 80 && !/^(继续|计划|第\d+步|\[SYSTEM)/.test(m.content.trim()));
    if (hasAssistantAnswer) return true;
  }
  return false;
}

// 2026-10-01 修 (9/30 实锤): 取"上轮答案开头"的摘要。
//   旧代码两处坏: (a) 只认 length>100 的 assistant 消息 → 上轮答复只要 <100 字 (实案: 48 字的
//     "通道正常，我在。…按 D 交。") 就被跳过, 捞到更早的**陈旧**答复当"上轮答案"; (b) .slice(0,200)
//     硬截 → 切在工具调用碎片中间 ("…其余六题答案已定稿。ng/Desktop/<course-source>/<course-file>` 里搜。"),
//     注入进 userInput 的上下文本身就是坏的。修: 取真正最后一条实质答复 (排除 ⚠️ 失败文案),
//   不足 40 字才回退到上一条, 并按句读边界截断而不是硬切。
function _prevAnswerDigest(messages) {
  const assistants = (messages || []).filter(m => m && m.role === 'assistant'
    && typeof m.content === 'string' && m.content.trim() && !/^\s*[⚠️]/.test(m.content.trim()));
  if (!assistants.length) return '';
  const last = assistants[assistants.length - 1].content.trim();
  const src = last.length >= 40 ? last : ((assistants[assistants.length - 2] || {}).content || last);
  const flat = String(src).replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  if (flat.length <= 200) return flat;
  const head = flat.slice(0, 200);
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf(';'));
  return (cut >= 60 ? head.slice(0, cut + 1) : head) + '…';
}

function resolveTaskInput(rawInput, messages) {
  const raw = String(rawInput || '').trim();
  if (!raw || !Array.isArray(messages)) return raw;
  // 2026-09-22 (session 60273479 实案: 同一道灾煞题重发 3 次, 盘古每次从头重新起卦):
  // 同问重发识别 — 新 input 跟上一条 user input 高度相似(共享前缀 >50%) + 上轮已有实质答案
  // → 标记【重复提问·基于上轮精炼】, 让 LLM 直接基于上轮答案确认/补全, 禁止从头重新起卦.
  // 这条必须在 social-confirm/ack 判定之前 (重发的往往是"做一下"这类短指令, 会被 ack 先吃).
  if (_isDuplicateQuestion(raw, messages)) {
    const _digest = _prevAnswerDigest(messages);
    return raw + '\n\n【重复提问·已答过】主人重发了同一道题 (' + raw.slice(0, 40) + '...), 你上一轮已给出实质答案。本轮基于上轮答案精炼/补全/直接确认, 禁止从头重新起卦、禁止重读已读过的文件、禁止重复上轮全文。上轮答案开头: '
      + (_digest ? _digest : '(无可引用的上轮答复)');
  }
  // 2026-09-22 (session 60273479 实案 "你现在能看见我了吧"): 状态确认/寒暄句不是 ack (不是"继续"),
  // 是"确认你能看见我" — 旧逻辑没覆盖, 被当普通输入直接喂给 LLM, 但 task_ledger 已单独拦它不入账本.
  // 这里: 状态确认句直接返回原样 (不走续跑/顺序指令链), 让 LLM 正常回答"看见了/没看见"即可.
  const _isSocialConfirm = raw.length <= 30 && /看见|看到|听见|听到|读到|读得到|看得见|听得见|在吗|在不在|在么|在哦|在不|你好|您好|嗨|hi|hello/.test(raw)
    && !/^(?:写|做|跑|查|读这|把|帮我|请|执行|做一下|测试|分析|生成|建|改|修|查一下|看一)/.test(raw);
  if (_isSocialConfirm) return raw;
  // 2026-10-12: 纠错纪律 —— 放在 ack 判定之前, 因为"不对吧""肯定偏弱啊"这类纠正句
  // 很可能被后面的 isAck 正则误吃掉。
  const _corrBlock = _buildCorrectionBlock(raw, messages);
  if (_corrBlock) {
    const _ackLike = /^(?:(?:ok|okay|yes|y|go|do it)|继续|直接做|确认|收到)/i.test(raw.trim());
    if (!_ackLike) return raw + _corrBlock;
  }
  // 2026-09-16 老板拍 "按顺序一个来 但还是不行": 把 "按顺序一个来" 这类**顺序指令** 也判成 isAck (续跑确认) —
  // 旧正则没覆盖, 导致 "按顺序" 被当新任务重新规划, 模型回 "等你拍"。现在: 顺序指令 = 执行第一个, 走 planner 续跑链。
  const isAck = /^(?:(?:ok|okay|yes|y|go|do it)(?:[\s,，]*(?:继续|去干吧|开干|开始|做))?|a|b|c|继续|去干吧|开干|开始|可以了|可以|好的|好|行|嗯|嗯嗯|没问题|直接做|直接干|照做|按这个|就这样|确认|收到|写|去做|直接做好(?:[，, ]*中间不用问我)?|你继续(?:[，, ]*别再问我)?|(?:直接干|按顺序修|开始修|照上面修)(?:[\s]*[＃#]?\d+(?:[\s]*[+,、和及][\s]*[＃#]?\d+)*)?|(?:按顺序|按推荐|按依赖|按你推荐)(?:一个来|一个一个|依次|逐个|一个接一个|全部都做|全部做完|都做完|都做了)?)?[\s。.!！,，：:；;]*$/i.test(raw);
  if (!isAck) return raw;
  // 2026-09-16 老板拍: 区分"顺序指令"和"普通确认"。
  // 顺序指令 (按顺序一个来/按推荐/按依赖) = 主人已给排序规则, 执行第一个候选即可, 不能再问。
  // 普通确认 (继续/去干/直接做) = 同上轮任务续跑。
  const isOrderingAck = /(?:按顺序|按推荐|按依赖|按你推荐)(?:一个来|一个一个|依次|逐个|一个接一个|全部都做|全部做完|都做完|都做了)/.test(raw);
  const previous = [...messages].reverse().find(m => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim() && m.content.trim() !== raw);
  if (!previous) return raw;
  const assistant = [...messages].reverse().find(m => m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
  const pending = assistant && assistant.content.match(/(?:可继续拍|下一步(?:建议)?|待办(?:事项)?)[：:]?[^。\n]{0,240}/i);
  const task = pending ? `${previous.content.trim()}\n\n【上轮待办】${pending[0].trim()}` : previous.content.trim();
  if (isOrderingAck) {
    const _doAll = /全部|都(做完|做了)/.test(raw);
    const _orderTxt = _doAll
      ? '【顺序指令·全部】主人已给排序规则且要"全部做完" — 从上轮候选里依赖最少/排第一的开始, 逐个真调工具读源+落盘, 一条接一条做完全部候选, 做完 task_done 报"全做完 X 条, 还剩 Y(如有)"。禁止只规划/拆轮不执行, 禁止再列候选问"选哪个", 禁止回"等你拍"。'
      : '【顺序指令】主人已给排序规则 (按顺序/按推荐), 你只需执行上轮候选里依赖最少/排第一的那个, 真调工具读源+落盘, 做完 task_done 报"做完 X, 还剩 Y"。禁止再列候选问"选哪个", 禁止回"等你拍"。';
    return task + '\n\n' + _orderTxt + '\n【续跑约束】直接从上次未完成处继续调用工具；在拿到新的真实结果前，不要把过程说明当最终答案。';
  }
  return task + '\n\n【用户确认】继续执行上一条任务，不要重新提问或只汇报计划。\n【续跑约束】这是同一任务的续跑：直接从上次未完成处继续调用工具；在拿到新的真实结果前，不要把过程说明当最终答案。';
}

// 2026-10-01 修 (9/30 实锤): 对齐门拿 userInput 当 question, 而 userInput 已被 resolveTaskInput
// 拼进了【重复提问·已答过】/【用户确认】/【顺序指令】/【续跑约束】等**指令措辞**。
// terms() 会把 "禁止从头重新起卦 / 禁止重读已读过的文件 / 禁止重复上轮全文" 全算成问题词,
// 而真实答案永远不会命中这些词 → 白白抬高对齐门槛, 且门判的"问题"根本不是主人问的东西。
// 修: 剥掉【…】指令块, 但**保留**真正携带上下文的载荷 (上轮答案开头 / 上轮待办) ——
// 那部分正是答案该对齐的主题词 (第4题/配偶宫/月令…), 丢了反而会把门收得过严。
function alignmentQuestion(input) {
  let s = stripGuaPrefix(String(input || '').trim());
  if (!s) return s;
  // 先把注入块里真正携带上下文的载荷摘出来 (答案该对齐的主题词就在这里)
  const payloads = [];
  s = s.replace(/上轮答案开头: ([^【]*)/g, (m, p) => { payloads.push(p.trim()); return ' '; });
  s = s.replace(/【上轮待办】([^【]*)/g, (m, p) => { payloads.push(p.trim()); return ' '; });
  // 从第一个【…】注入标记起, 后面整段都是给模型的话术, 不是"问题" —
  // 注意指令正文在标签**外面** (【重复提问·只答过】主人重发了同一道题…禁止重复上轮全文。),
  // 所以必须按标记位置切, 不能只 replace 标签本身。
  const cut = s.search(/【[^】]*】/);
  let head = (cut >= 0 ? s.slice(0, cut) : s).replace(/\s+/g, ' ').trim();
  if (!head) head = s.replace(/【[^】]*】/g, ' ').replace(/\s+/g, ' ').trim();
  const kept = payloads.filter(Boolean);
  return kept.length ? (head ? head + ' ' : '') + kept.join(' ') : head;
}

function stripGuaPrefix(input) {
  return String(input || '').replace(/^【盘古起卦[^]*?主人问题:\s*/u, '').trim();
}

// 2026-10-28 (现场 probe-dup-20261028 + 会话 web-1793124838326):
//   「主人这一轮说了什么」在系统里有三个版本 ——
//     (a) 原话 (客户端发的, 我们要的)
//     (b) 注入块前缀版 (卦块拼在前面)
//     (c) 注入块后缀版 (分层编排/排盘事实拼在后面)
//   同一个东西三副面孔, 谁跟谁比都对不上, 于是同一轮对话被当成两条, 塞进模型两遍。
//   (实跑 [j2-msgs] 抓到: user/assistant 各两份; 模型随后复读上一轮, 答案长度一模一样。)
//   所以**所有去重比对必须走同一个口径**: 先剥掉注入块还原成原话再比。
//   这函数是那个口径的唯一真源, 别在别处再抄一份。
function coreUserText(text) {
  let s = String(text == null ? '' : text);
  const _pre = /^【盘古起卦[^]*?主人问题:\s*/u.exec(s);
  if (_pre) s = s.slice(_pre[0].length);
  s = s
    .replace(/\s*【分层编排】[\s\S]*$/u, '')
    .replace(/\s*【排盘事实[\s\S]*$/u, '')
    .replace(/\s*【[^】]*纪律[\s\S]*$/u, '')
    .trim();
  return s;
}

// 2026-10-28 (现场 probe-dup-20261028 实跑取证, 会话 web-1793124838326 同源):
//   客户端把**本轮 user 消息也放进 messages 一起发**(web/app/views/chat.mjs:
//   `messages: history.concat([{ role:'user', content: user.content, images: user.images }])`),
//   服务端又按 userInput(注入过卦块/事实块/纪律块的版本) **追加**一条 ——
//   判据 `last.content === userInput` 比的是「注入后」的内容, 而客户端那条是「原话」,
//   永远不等 ⇒ 服务端又追加一份。
//   ⇒ 模型同一轮看见两条 user 消息, 注入块以「用户说的」的身份进历史, 图片也发了两遍。
//
//   实测后果(不是理论): 追问轮「1.出生地周围环境…」的最终答案长度 1836,
//   跟上一轮排盘答案长度**一模一样** —— 模型在复读上一轮; 对齐门连拦两次
//   (ALIGNMENT_RETRY #1 #2), 一轮 116 秒。用户侧表现就是「又傻又慢」。
//
//   修法: 最后一条就是本轮 (内容 == 主人口原话) ⇒ **替换**成注入后的版本, 不追加。
//   额外带一个 `raw` 字段存主人口原话 —— 落盘会话用它还原干净正文,
//   否则 UI 一刷新就把【盘古起卦】【排盘事实】这些注入块当正文显示出来(老板报「头部重复」)。
function ensureCurrentUserMessage(messages, userInput, images = [], rawUserText = '') {
  const next = Array.isArray(messages) ? messages.slice() : [];
  const last = next[next.length - 1];
  const lastIsUser = !!(last && last.role === 'user');
  const lastContent = lastIsUser ? String(last.content || '').trim() : '';
  const raw = String(rawUserText || '').trim();
  const imgs = Array.isArray(images) ? images : [];

  // 本轮消息已经在 messages 里(客户端会带) ⇒ 替换, 不追加。
  // 纯图片轮没带 input 时用「最后一条 user 带图」兜底 —— 客户端就是那么发的。
  const isCurrentTurn = lastIsUser && (
    (raw && lastContent === raw)
    || (!raw && imgs.length > 0 && Array.isArray(last.images) && last.images.length > 0)
  );
  if (isCurrentTurn) {
    const userMsg = { role: 'user', content: userInput };
    const keepImgs = imgs.length > 0 ? imgs : (last.images || []);
    if (Array.isArray(keepImgs) && keepImgs.length > 0) userMsg.images = keepImgs;
    if (raw) userMsg.raw = raw;
    next[next.length - 1] = userMsg;
    return next;
  }

  const hasCurrentUserMessage = lastIsUser && lastContent === String(userInput || '').trim();
  if ((userInput || imgs.length > 0) && !hasCurrentUserMessage) {
    const userMsg = { role: 'user', content: userInput };
    if (raw) userMsg.raw = raw;
    if (imgs.length > 0) userMsg.images = imgs;
    next.push(userMsg);
  } else if (imgs.length > 0 && lastIsUser) {
    next[next.length - 1] = { ...last, images: (last.images || []).concat(imgs) };
  }
  return next;
}

// 2026-09-12 铁律23 (易经营案): 判定任务文本是否"大体量消化/总结类" — 给 agent loop 做
// partial 交付合法化 + 自拆预检共享用。只看任务文本本身, 不看确认词。
function isHeavyDigestTask(text) {
  const t = String(text || '');
  // 2026-09-14 (老板 05:45 实案): "现在消化吸收了多少了" 是查进度的问题, 不是消化指令 —
  // 疑问句被误判大体量任务 → 预检误建 plan 骨架 → TASK_DONE_GATE 以"骨架步骤 pending"拒收 task_done
  // → 模型干了 9 次真工具也交不了卷 → auto-resume 烧完 → Silent Failure。疑问句式一律不算任务。
  // 但带行动动词的疑问 ("继续消化完它好吗") 仍是任务, 不放行。
  if (/(多少|几件|哪些|进度|盘点|了吗|嘛|呢|怎么样|如何|啥|\?|？)/.test(t) && !/(继续|接着|开始|动手|执行|完成|消化掉|啃|做完|去消化)/.test(t)) return false;
  const heavy = /(消化|精读|总结|吸收|全套|整本|全部)/.test(t);
  // 2026-10-16 (实机 modelswitch-t1#sub-0-analyzer): volume 原来只要文本里出现
  // **任何一个** `/Users/` 路径就算"大体量", 于是「读取 /home/you/a.md 并总结」这种
  // 普通单文件总结也命中 → 预检误建 plan 骨架 → TASK_DONE_GATE 以骨架步骤 pending
  // 拒收 task_done → 模型干了活也交不了卷 (那一条还叠上了子 agent 无法调 plan_step_done)。
  // 改成: 一个路径不算量。要么显式批量 ("5 个 txt" / "全套资料"), 要么真的出现多个路径。
  const _absPaths = t.match(/\/Users\/[^\s，。；、)）'"]{1,200}/g) || [];
  const volume = /\d+\s*(?:个|本|篇|份|章|套|批)\s*(?:txt|文件|文档|md|pdf|书|笔记|资料)?/.test(t)
    || _absPaths.length >= 2
    || /(?:全套|整套|整本|全部|所有)\s*(?:文件|文档|资料|书|章节|篇|目录|txt|md)/.test(t);
  // 2026-09-16 老板拍: 续跑/顺序指令 (带【续跑约束】/【顺序指令】) 不是新的大体量消化 —
  // 它是在既有任务里接着干, 体量预检不该再建 plan 骨架逼拆轮 (旧 bug: "按顺序全部都做" 命中"全部"→拆轮)。
  if (/【续跑约束】|【顺序指令】/.test(t)) return false;
  return heavy && volume;
}

module.exports = { normalize, terms, isAligned, guardAnswer, resolveTaskInput, stripGuaPrefix, coreUserText, alignmentQuestion, ensureCurrentUserMessage, isSelfInspection, isSelfIntroAsk, isExternalArtifactTask, hasSelfInspectionEvidence, isOrchestrationLeak, isHeavyDigestTask, hasArtifactEvidence, isCorrectionTurn, isBareFlip };
