// 2026-09-16 老板拍 "开源其他人说话也不和我一样" — 模型自判 task_done summary 是否 partial:
// 1) 通用词法 (剩余/TODO/pending/未完成 等, 不绑特定话术) 作 fallback;
// 2) 有剩余计划/产出时, 让模型自己对照判定 (JSON {completed, remaining}), 结果写 task_ledger 供下轮断点;
// 3) 任何异常 (调用失败/JSON 解析失败) 一律回退词法判定, 不阻塞主流程; 只用当前 model 调一次, 不切模型不重试 (额度 P0)。
'use strict';

// 2026-10-17: 「接着」原来单字就算"还要继续"的信号, 但中文里它是**普通连接词**。
// 现场两份自由格式 summary 根本没有「③ 未做」栏, 却被判 partial —— 唯一命中的就是正文里
// 描述**这个文件自己的行为**的"接着":
//   checkpoint.js: "新请求进来时能捞回来接着跑"  ← 它干的就是让任务接着跑
//   另一份: "把上一个模型省下来的预算接着算进本轮"  ← 描述预算累计
// 这不是"我还没干完", 是散文。收紧成必须跟一个动词, 真意图 (接着做/接着写) 照样命中。
// 2026-10-17 现场逐字 (lt3-1792175798792 的两份自由格式 summary, 都没有「③ 未做」栏):
//   "…我**本轮** system prompt 里那段守则即出自本文件。"        ← 「本轮」= 这一轮我读了它
//   "…云端全**缺**价时 cloudPriced=false…"                      ← 「缺」= 这个模块的字段概念
// 这两个都是中文里极普通的字, 拿单字当"还有活没干"的信号, 等于把整个技术语料误伤一遍。
// 「本轮未完成」这类真信号另有覆盖 (未完成 / _REAL_REMAINING_RE), 不靠裸「本轮」。
// 「缺」只保留带宾语的形态 (缺少/缺项/缺口/缺漏), 「缺价」「缺省」不是缺口。
//
// 剩下的散文歧义 (「捞回来接着跑」这种描述文件自身行为的) 词法**判不了**, 也不打算再补词 ——
// 2026-10-16 补过一次现场原话, 10-17 又漏一批, 再补还是漏。真正的解是让模型判官每次都跑
// (见下面那个短路), 词法只在判官不可用时才兜底。这是取舍, 不是遗漏。
const _GENERIC_PARTIAL_RE = /(未完成|未做|未消化|缺(?:少|项|口|漏)|剩余|尚未|未开始|自动续|Round\s*\d|还有|还剩|未读|待读|待拆|TODO|pending|remaining|not\s+done|still\s+(to\s+do|left|pending)|left\s*(\d|one|two|three)|s[ABCD]-\d|继续|接下来|让我|我来|待补|稍后|回头|下一份|下一轮|下一卷|下一块|下一候选|step\s*\d|步\s*\d|继续读|接着(?:做|写|读|改|跑|处理|补|试|看|干|办|弄|整)|continue|next\s+(step|chunk|block|volume|candidate)|proceed|resum)/i;

// 2026-10-16 (lt6 实机 sub-1-executor 606s 的真凶, 不是超时也不是端点):
// 汇报契约 (session_container.REPORT_CONTRACT) 把"还有没有剩余"锁死在 `③ 未做:` 这一行,
// 模型按契约交「③ 未做: 无」= "我什么都没漏"。但词法是满篇扫「未做 / 继续 / pending」,
// 于是**干完了的活被判 partial** → 触发自动续跑 → 续跑把完整 goal 重新灌进上下文,
// 推翻 slice 的 scope guard【只做你被分派的这一个子任务】→ 同一个切片把前后邻居的活
// 重跑一遍, 烧满 3 次 (r0→r10)。同一条判据在 checker verdict 上已经栽过一次
// (「无未通过项」当失败, 7a6cec8 修过), 这里是同一个病的另一处, 还没修。
//
// 修法: **契约行优先**。模型按契约显式把 ③ 写成空值, 那就是权威的"没有剩余",
// 不再让满篇词法翻案。没按契约交的 (老模型 / 非子 agent 路径) 行为一个字不变。
// 边界: 「无法 / 未能」说的是"做不到", 不是"没有剩余", 所以要排掉这两个后继。
const _REPORT_NOTDONE_FIELD_RE = /(?:^|[\n\r])\s*(?:[③3]|[（(]?C[)）]?)\s*[.、]?\s*未做\s*[:：]\s*([^\n\r]*)/;
const _EMPTY_FIELD_VALUE_RE = /^\s*(?:没有|沒有|没(?!有)|空|为空|暂无|0|零|none|null|nil|n\/?a|-|—|无(?!法|力))/i;

// 按契约交了报告, 且 ③ 未做 显式为空 → 认定"没有剩余", 不再走词法。
// 返回 true 表示"契约已表态", 调用方据此跳过词法 (而不是判定为 completed)。
function reportDeclaresNoRemaining(summary) {
  const m = _REPORT_NOTDONE_FIELD_RE.exec(String(summary || ''));
  if (!m) return false;
  return _EMPTY_FIELD_VALUE_RE.test(m[1] || '');
}

function lexicalIsPartial(summary) {
  if (reportDeclaresNoRemaining(summary)) return false;
  return _GENERIC_PARTIAL_RE.test(_stripScopedNotDoneField(String(summary || '')));
}

// 2026-10-16 (现场 lt-after-222442, 一刀一个文件改造的连带修正):
//   汇报契约 (session_container.REPORT_CONTRACT) 强制每个子 agent 写
//   「③ 未做: <没做到/跳过/存疑的部分; 没有就写"无">」。豁免只认**该栏为空**的情形,
//   于是「③ 未做: 未读兄弟的文件(按指令不扩展)」整句命中 _GENERIC_PARTIAL_RE 的
//   未做/未读/剩余 → 判 partial → task_done 被判部分交付 → 自动续跑接管,
//   白烧 3~4 轮 (每轮一次 LLM 约 20s)。
//
//   而分析类刀**没有 plan 步**, _judgeSummaryCompletion 开头就是
//   `if (!o.callLLM || !o.planSteps || o.planSteps.length === 0) return fallback;`
//   —— 这条词法路径是热路径, 不是兜底。现场 stderr 里
//   `[j2-auto-resume] … (done 0→0, files 0→0)` 连出 7 次, 根子就在这里:
//   子 agent 干得越规矩, 越被判没干完, 越要为没干完的部分重跑。
//
//   修法不是把 _GENERIC_PARTIAL_RE 改松 (那会把真缺口一起放过去), 是先把
//   **明确划在别人地里**的从句摘掉再扫 —— 跟 j2_dispatcher 里摘「无未通过项」
//   是同一个手法: 剥壳, 不放宽判据。
//
//   只认"别人的活/按指令不扩展"这类**排他性**标记。本刀范围内的真缺口
//   (「本刀范围还有 2 项没做」) 一个都不许摘, 否则这道修正就成漏斗。
//   划界词表按**现场真话**收, 不是按想象收。lt-after-222442 的离实际写的是
//   「未打开 plan_state.js（受"不得读另外三个文件"约束）」「未读 checkpoint.js
//   （按指令不扩展）」「未验证 X（超出本刀范围）」—— 第一版词表只认"按指令不扩展",
//   真实那句直接漏过去, 护栏当场自己测出来 (T2 用的就是现场原文)。
//   "受…约束" / "不得读" / "本刀不涉及" 这类是模型最常用的划界说法, 一并收。
// 2026-10-17 (现场 lt3-1792175798792 / sp-1792175880739 逐字抄的「③ 未做」栏原文):
//   "未分析另两个文件(…)—— 按子任务边界只做被派的 checkpoint.js; 未验证…"
//   "model_cost.js 与 checkpoint.js 不属本刀, 未读。"
//   "未做 model_cost.js 与 checkpoint.js 的分析 (本刀只分派 j2_loop_shared.js); …"
// 上一版词表 (按指令不扩展 / 不在本刀 / 本刀不涉及 / 超出本刀 / 兄弟的活 / 受…约束 /
// 不得读) —— **一条都对不上**。词是照着想象写的, 于是每一把按规矩划界的刀都被判 partial,
// 每把白续跑一轮 (实测一轮 10~25s)。
// 这是"判据词表不能按想象写"的第二次复发: 10-16 已经按现场原话补过一次, 10-17 又漏了一批
// 新说法。词表只能靠抓真实 summary 长, 补不齐就说明该换机制 —— 见下面 G4 那个短路。
// 注意「不属本刀」要单独排一条: 写成 `不属(?:我|本)(?:这一刀|本刀)` 时, 现场那句
// "不属本刀" 是「不属 + 本 + 刀」, 后面既不是"这一刀"也不是"本刀", 一条都不中 ——
// 补词表补了还是漏, 这种错只在逐字样本上才看得出来。
const _OUT_OF_SCOPE_RE = /(?:按指令不扩展|按分工(?:未|不)?扩展|不扩展|不在(?:我|本)(?:这一刀|本刀|这一刀范围|本刀范围)|不属(?:我|本)(?:这一刀|本刀|范围)?|不属本刀|本刀范围之外|本刀范围外|超出本刀|本刀不涉及|本就不该|非本刀范围|已交给下一棒|交给下一棒|兄弟(?:的)?(?:活|文件|任务|刀|那部分)|受[^。；;\n]{0,20}约束|不得(?:读|修改|碰)|按子任务边界|按分工边界|本刀只分派|本刀仅分派|本刀仅|只做被派的|按收口纪律不越界|不越界)/;

// 「受"不得读另外三个文件"约束」和「未做运行时验证」被分号切到了两句里 ——
// 逐句过滤失配, 现场原话当场测不出来。改成**按「③ 未做」整栏判**:
// 划界声明一旦在这一栏里出现, 就为这一栏后面所有项划了边界。
//
// 否决信号 (出现任一个就不许摘, 宁可误判 partial 也绝不放过真缺口):
//   还剩 / 还没建|做|写|改 / 待处理|建|写|补 / 还有 N / 本轮未完成 / 下一轮要
//
// 只用**整栏**这一条。逐句那层已经删掉了 —— 两个半机制叠在一栏上会互相咬,
// 而且是往危险的方向咬: 现场实测「未读 a.js（按指令不扩展）；但 t2.txt 还没建」,
// 逐句层把划界句摘掉, 而 `还没建` 又不在 _GENERIC_PARTIAL_RE 词表里 →
// 真缺口被漏判成 completed。整栏判定有 _REAL_REMAINING_RE 否决, 混合场景整栏一律
// 不摘, 天然没有这个漏。一个机制, 一个判据, 别抄两份。
const _REAL_REMAINING_RE = /(?:还剩|还没(?:建|做|写|改|读|跑)|待(?:处理|建|写|补|办)|还有\s*\d|本轮未完成|下一轮要|下轮要|得再|还需要)/;

function _stripScopedNotDoneField(text) {
  const raw = String(text || '');
  const m = _REPORT_NOTDONE_FIELD_RE.exec(raw);
  if (!m) return raw;
  const field = m[1] || '';
  if (!_OUT_OF_SCOPE_RE.test(field)) return raw;   // 这一栏没划界 → 照扫
  if (_REAL_REMAINING_RE.test(field)) return raw;  // 混着真缺口 → 照扫, 不摘
  return raw.slice(0, m.index) + raw.slice(m.index + m[0].length);  // 只摘这一栏
}

// ============================================================================
// 进度判官 (2026-10-23 第 59 批)
// ============================================================================
//
// ## 之前是什么
//
// 判官问的是**布尔**: 「这次 task_done 是"全部完成"还是"部分完成"?」
// 模型答 `{"completed": true|false, "remaining": [...]}`。
// decision.md §五 早就指出这条不对: 「不问「做完没有」, 问「现在哪个格填得上」」,
// 而且「布尔判断有『判不出来』的状态 → 模型说完了、词法说没完 → 打架」。
//
// ## 现在是什么
//
// 判官让模型**只列条目** (六格), **不下结论**; 结论由 64i 的
// `task_judge.judgeProgress` 内核算 —— 与盘古其它地方用六格的方式完全一致
// (与 bazi_calc→wuxing_strength、wuxing_judge 是同一个分法:
//   调用方负责取数, 内核负责判据)。
//
// 这条改动的真正价值不在"换个说法", 在**它让六格判局在长任务上自动发生**:
// 2026-10-23 实测, 7940 个会话账本里只有 3 个提到 wuxing_judge,
// 运行日志里 0 次 —— 老板要的「加强停顿, 走一步判断一步」在长任务上是空的,
// 因为它只靠模型自觉调工具。挂在 task_done 上, 它才真的每天都在发生。
//
// ## 向后兼容
//
// 模型若仍答旧形状 `{completed, remaining}`, 按**模型自报**处理:
// completed 且无 remaining ⇒ 收口; 否则 ⇒ 还有活。
// 这与改造前的判定**逐字等价** —— 所以这不是一次行为变更, 是换了一套说法。
// 旧形状的结论会标 `source:'model_legacy'` —— 跟内核算的结论**不混为一谈**,
// 因为前者是模型下的结论, 后者才是内核算出来的。

const _TASK_JUDGE_PATH = '../64i/bagua_annotations/task_judge.js';

/** 六格条目的字段名 —— 与 task_judge.CELLS 的 field 同名, 单一真源在那边 */
const PROGRESS_CELL_FIELDS = ['resources', 'outputs', 'blockers', 'targets', 'peers'];

/**
 * 判官提示词 —— **本模块是唯一真源**。
 *
 * 为什么单独抽出来: 之前 j2_agent_loop.js 里有一份内联拷贝,
 * 两份的「划界规则 B 信号词」词表**已经漂了**(一份有「本刀范围/已交/未修改」,
 * 一份没有; 一份有「验收结论 PASS/FAIL」, 一份没有)。
 * 「两份同义文本各改各的」= 盘古 2026-10-21 亲自踩过的坑, 不给它第二次机会。
 */
function buildProgressJudgePrompt(summary, planSteps) {
  return [
    '[PROGRESS_JUDGE] 判断这一刀(task_done 这次汇报)干到哪儿了。',
    '只输出一个 JSON 对象, 六个数组, 不要输出任何其他文字:',
    '{"resources":["生我者·手上的助力"],"outputs":["我生者·已落地的产出"],'
      + '"blockers":["克我者·挡着这事的阻力"],"targets":["我克者·还要主动啃的"],'
      + '"peers":["同我者·平级协作"]}',
    '',
    '【你只列条目, 判据由内核算 —— 不许自己下结论】',
    '不要输出 completed / remaining / 100% 这类结论词。判「收口/续/换向」是内核算的活。',
    '',
    '【划界规则 —— 列之前先读这条】汇报契约强制子 agent 写「③ 未做」一栏, 所以那一栏非空是常态, 不是自首。分清两种"未做":',
    '  A. 本刀分工范围内、本该做而没做的 → 列进 targets。',
    '  B. 兄弟刀该干的活、明说"按指令不扩展/不在我这一刀/已交给下一棒"的 → **不列进 targets**(那不是这一刀欠的)。',
    '判 B 的信号词: 按指令不扩展 / 按分工 / 不在我这一刀 / 本刀范围 / 本刀范围外 / 已交 / 交给下一棒 / 未读<别的文件> / 未修改(本就不该改)。',
    '汇总类总结常带一个明确的「验收结论: PASS/FAIL」—— PASS 意味着本刀做完且没缺口。',
    '',
    '【怎么分格】',
    '  outputs: 这一刀**真正落地**的东西(写了哪些文件/查出了哪些事实/改了什么), 一条一个。',
    '  targets: 本刀范围内**还没做完**的事, 一条一个。没有就留空数组 []。',
    '  resources: 手上有、能直接拿来用的东西(已读到的文件/已拿到的前提/已确认的事实)。',
    '  blockers: 挡着这一刀的事(缺权限/上游挂了/结论对不上), 一条一个。',
    '  peers: 与这一刀平级或并行的存在。没话说就 []。',
    '【宁可少列也别编】列不出来就留空数组 —— 空数组不是失败, 内核会自己判"判不出来"。',
    '',
    '剩余计划步骤: ' + JSON.stringify(Array.isArray(planSteps) ? planSteps : []),
    'task_done 总结: ' + String(summary || '').slice(0, 2000),
  ].join('\n');
}

/**
 * 解析判官的 JSON —— 接受两种形状。
 *
 * 六格形状: 五个数组字段里**任何一个**是数组就算。
 * 旧形状: {completed: boolean, remaining: string[]}
 *
 * 2026-10-16 的教训照旧生效: 原来用贪婪 /\{[\s\S]*\}/ 抓 JSON ——
 * 抓到**另一段**合法 JSON 时不抛异常, 只是 completed 读到 undefined
 * ⇒ 恒判"部分完成" ⇒ 明明做完了也判成没做完。这里用括号配对扫描 + 自己的形状判定。
 */
function parseProgressJudgeText(text) {
  const _hits = require('../agents/sub-agent')._extractJsonObjects(
    String(text || ''),
    (j) => PROGRESS_CELL_FIELDS.some(f => Array.isArray(j[f]))
      || typeof j.completed === 'boolean'
      || Array.isArray(j.remaining));
  if (!_hits.length) return null;
  const j = _hits[0];
  const hasCells = PROGRESS_CELL_FIELDS.some(f => Array.isArray(j[f]));
  if (hasCells) {
    const cells = {};
    for (const f of PROGRESS_CELL_FIELDS) {
      cells[f] = Array.isArray(j[f]) ? j[f].map(String).filter(s => s.trim()) : [];
    }
    return { kind: 'cells', cells };
  }
  return {
    kind: 'legacy',
    completed: j.completed === true,
    remaining: Array.isArray(j.remaining) ? j.remaining.map(String) : [],
  };
}

/**
 * 把判官的答案变成**进度判局**。
 *
 * 六格形状 → 交给 64i 的 task_judge.judgeProgress 内核算 (结论是算出来的, 不是模型喊的)。
 * 旧形状   → 按模型自报映射 (与改造前逐字等价), 并标 source 以示区别。
 * 判不出   → 返回 ok:false, 调用方走词法兜底。
 *
 * @returns {{ok:boolean, isPartial?:boolean, verdict?:string, verdict_label?:string,
 *            cells?:object, rule_key?:string, reason?:string, next_step?:string,
 *            source:string, error?:object}}
 */
function judgeProgressShape(shape, subject) {
  if (!shape) {
    return { ok: false, source: 'model', error: { code: 'NO_SHAPE', message: '判官没给出可解析的形状' } };
  }
  if (shape.kind === 'cells') {
    let tj;
    try { tj = require(_TASK_JUDGE_PATH); } catch (e) {
      return { ok: false, source: 'model', error: { code: 'NO_KERNEL', message: '取六格内核失败: ' + e.message } };
    }
    const r = tj.judgeProgress(Object.assign({ subject: subject || '这一刀' }, shape.cells));
    if (!r.ok) {
      return { ok: false, source: 'model', cells: r.cells || null, error: r.error };
    }
    return {
      ok: true,
      source: 'kernel',
      isPartial: r.verdict !== tj.PROGRESS_VERDICT.CLOSED,
      verdict: r.verdict,
      verdict_label: r.verdict_label,
      rule_key: r.rule_key,
      cells: r.cells,
      reason: r.stop_reason,
      next_step: r.next_step,
      disclaimer: r.disclaimer,
    };
  }
  // 旧形状 —— 模型自报。逐字等价于改造前的判定:
  //   旧: _isPartial = !completed || remaining.length > 0
  //   新: completed && 无 remaining ⇒ 收口(不 partial); 其余 ⇒ 还有活(partial)
  // remaining 先归一 (这里是导出函数, 调用方可能直接喂手搓形状 ——
  //   shape.remaining.length 在缺字段时会抛, 判官抛了就退化成词法兜底, 白判一场)。
  const _remaining = Array.isArray(shape.remaining) ? shape.remaining : [];
  const isPartial = !(shape.completed === true && _remaining.length === 0);
  return {
    ok: true,
    source: 'model_legacy',
    isPartial,
    verdict: isPartial ? 'open' : 'closed',
    verdict_label: isPartial ? '续' : '收口',
    rule_key: isPartial ? 'LEGACY_PARTIAL' : 'LEGACY_COMPLETE',
    cells: null,
    reason: isPartial
      ? '模型自报: 还有剩余未做项 ' + _remaining.slice(0, 3).join('; ')
      : '模型自报: 本刀已完成',
    next_step: isPartial ? '把剩余项做掉, 做完再判一次。' : '本刀完成。',
  };
}

/**
 * 词法兜底 → 同一套形状。
 *
 * 它**不产六格** —— 词法看不出「助力/阻力/平级」, 硬编就是造假。
 * 只给档位, 并把 source 标成 'lexical', 跟内核算的结论区分开。
 */
function lexicalProgressShape(summary) {
  const partial = lexicalIsPartial(summary);
  return {
    ok: true,
    source: 'lexical',
    isPartial: partial,
    verdict: partial ? 'open' : 'closed',
    verdict_label: partial ? '续' : '收口',
    rule_key: partial ? 'LEXICAL_PARTIAL' : 'LEXICAL_COMPLETE',
    cells: null,
    reason: partial ? '词法判为还有未做项' : '词法未命中任何未做措辞',
    next_step: partial ? '把剩余项做掉, 做完再判一次。' : '本刀完成。',
  };
}

/**
 * 同步版判官 —— 给不需要预算控制的调用方 (测试 / 将来别的路)。
 *
 * 返回**布尔**(与改造前一致), 额外把结构化结论交给 onVerdict。
 *
 * ⚠️ 判官不依赖 plan 步: 它要回答的是"这一刀**该做的**做完了没有",
 * 而"该做什么"就在提示词的划界规则 A/B 里。剩下的计划为空,
 * 恰恰是最该问这句话的场合 (分析类子 agent 永远没有 plan 步)。
 * 2026-10-16 那次「③ 未做不当认罪书」的修复就是因为这里有个
 * `planSteps.length === 0` 短路而**修在了死路上** —— 线上纹丝不动。
 */
function judgeSummaryCompletion(summary, opts) {
  const o = opts || {};
  const fallback = lexicalProgressShape(summary);
  const onVerdict = o.onVerdict || null; // (verdict: 结构化结论) => void, 用于写 ledger
  if (!o.callLLM) return fallback.isPartial;
  try {
    const _prompt = buildProgressJudgePrompt(summary, o.planSteps);
    const _res = o.callLLM(_prompt);
    const _text = String(_res && _res.text !== undefined ? _res.text : _res || '').trim();
    const _shape = parseProgressJudgeText(_text);
    const _judged = judgeProgressShape(_shape, o.subject || '这一刀');
    if (!_judged.ok) {
      if (onVerdict) onVerdict(_judged);
      return fallback.isPartial;
    }
    if (onVerdict) onVerdict(_judged);
    return !!_judged.isPartial;
  } catch (e) {
    if (onVerdict) onVerdict(Object.assign({ error: { message: e.message } }, fallback));
    return fallback.isPartial;
  }
}

/**
 * 把判局结论变成一条送到模型眼前的话; 不该送时返回 null。
 *
 * 为什么抽成纯函数放在生产层 (而不是留在 j2_agent_loop 的调用点里):
 *   留在调用点里就只能**扫源码**来测它 —— 而扫源码验不出行为,
 *   把整段注入删掉测试都照样绿 (第 59 批变异体检实测空枪两发)。
 *   抽成纯函数后, 测试能真的调它、真的看它返回什么。
 *
 * 零影响: 判不出 / 已收口 / 一条条目都没有 => null, 调用点一条都不加。
 *   (停点是加法不是减法 —— 同 stop_point 的纪律。)
 */
function buildProgressJudgeMessage(judged, isPartial) {
  try {
    if (!judged || !judged.ok || !judged.cells) return null;
    if (!isPartial) return null;
    const cellLines = Object.values(judged.cells)
      .filter((c) => c && c.items && c.items.length)
      .map((c) => '  ' + c.shuxing + '(' + c.alias + ') ' + c.state_label
        + '(' + c.count + '条): ' + c.items.slice(0, 3).join(' / '));
    if (!cellLines.length) return null;
    return '[六格进度判局 · 走一步判断一步] 上一刀判成「'
      + (judged.verdict_label || '续')
      + '」(判据: ' + String(judged.reason || '').slice(0, 120) + ')\n'
      + cellLines.join('\n') + '\n'
      + '下一步: ' + String(judged.next_step || '把「我克者(还要主动啃的)」里列的条目做掉, 做完再判一次。')
      + '\n(这一行是盘古内核算出来的进度判局, 不是典籍断语。)';
  } catch (_) {
    return null;
  }
}

/**
 * 注入器 —— 调用点只调这一个, 自己拼内容/自己判断的事都不许做。
 *
 * 为什么还要再包一层: buildProgressJudgeMessage 造内容, 这个负责**放进 messages**。
 * 分开是因为「该不该送」(三道门) 和「送什么」(措辞) 是两种失败模式, 得分开验 ——
 * 而且只有在这里, 「调用点到底送没送」才是可测的。
 * (第 59 批变异体检实测: 注入内容抽出来了, 调用点那句 if 仍没人验 ⇒ 变异空枪。)
 *
 * @returns {number} 实际注入了几条 (0 = 零影响)
 */
function injectProgressJudge(messages, judged, isPartial) {
  try {
    if (!Array.isArray(messages)) return 0;
    const msg = buildProgressJudgeMessage(judged, isPartial);
    if (!msg) return 0;
    messages.push({ role: 'system', content: msg });
    return 1;
  } catch (_) {
    return 0;
  }
}

module.exports = {
  lexicalIsPartial,
  judgeSummaryCompletion,
  reportDeclaresNoRemaining,
  // 第 59 批: 判官的三件套 + 词法兜底, 全部走同一套形状
  PROGRESS_CELL_FIELDS,
  buildProgressJudgePrompt,
  parseProgressJudgeText,
  judgeProgressShape,
  lexicalProgressShape,
  buildProgressJudgeMessage,
  injectProgressJudge,
};
