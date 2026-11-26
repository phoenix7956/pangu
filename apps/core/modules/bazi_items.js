'use strict';
/**
 * modules/bazi_items.js — 批命「做题」的口径唯一真源 (第 129 批, 2026-10-28)
 *
 * 现场 (2026-10-27 23:40, 会话 15567183)
 * ----------------
 *   老板发一张课件《排盘样例》图 +「做题，看清楚题目」。
 *   课件图右侧黄底高亮的八条题 (原件照抄, 一个字都不改):
 *     1 分析出生地周围情况   2 判断身强身弱   3 取喜忌用神
 *     4 看原局天干<course-source>   5 看身一体状况   6 看财运
 *     7 看婚姻感情   8 看大运流年(看壬申大运、25、26年)
 *
 *   盘古干的事: bazi_calc **排对了盘** (它读懂了图里的四柱), 然后自己脑补出一个
 *   题目里没有的议题 ——「查证 1975 年四川/成都的社会经济事实」: 发了 1 条 web_search,
 *   又派了 1 个子 agent 去查「1975 年四川职工平均工资 / 城镇化率 / 人口总数」。
 *   子 agent 连着 6 次 web_fetch 超时(每次 30s), 整轮 4m49s 还在跑, 实际 10 分钟没结束。
 *
 * 两个病, 都要在**内核**里治:
 *   ① **口径错**: 「分析出生地周围情况」在子平法里 = 出生地的**地理环境**
 *      (地形/山水/水土/气候寒暖燥湿) → 判**调候**, 再看调候用神与原局喜忌是否一致。
 *      **不是**出生年代的经济社会统计。老板原话:
 *      「出生地周围情况，不是让盘古分析当时的情况」。
 *      => 全仓 modules/ 里**一条规则都没有** (rg 调候|寒暖|燥湿 = 0 命中),
 *        模型只能猜 —— 猜错了没人拦, 就绕出去了。
 *   ② **不看题**: 八条题一道没按着答, 自造了一个「查史实」的子议题。
 *
 * 修法 = 一条腿都不能少:
 *   ① 口径写进内核 (本模块 = 唯一真源), 进门就注入给模型
 *      (modules/pangu_agent_stream.js, 读图纪律旁边);
 *   ② **机制拦住绕路** (不许只靠念经): 批命题不许为「出生地周围情况」发
 *      web_search / 派子 agent 去查时代统计 —— 见 inspectToolCall() / inspectDispatchTasks()。
 *
 * 与 chart_verify_guard 的分工 (两个门管两件事, 不许合并):
 *   chart_verify_guard 拦「**拿着盘还去重算**」(算同一张盘);
 *   本模块拦「**这题根本不该查**」(查表题不许查) —— 现行内核里**一个门都没有**。
 *
 * 「注释 ≠ 隔离」(项目铁律): 光在 prompt 里写"不许上网"没用, 模型照样发。
 *   所以注入块 (软) 和 inspectToolCall (硬) 都要在, 缺一条这题还会跑偏。
 */

// ============================================================
// 一、课件八条 (题目原文照抄; 「答法」是本模块给的口径, 不是改题目)
// ============================================================

const ITEMS = [
  {
    key: 'surrounding',
    title: '分析出生地周围情况',
    ask: '答出生地的**地理环境**: 地形(平原/盆地/山地/沿海)、山水、水土、气候寒暖燥湿、日照与降水。'
      + '再落到命理上怎么用: ① 出生地气候定**调候**, 看调候用神与原局喜忌是否一致'
      + '(例: 环境水汽重而盘里四柱无水 = 「环境有水、命局无印」); '
      + '② 出生地水土是助日主还是抑日主; '
      + '③ 配合盘里的驿马/桃花/将星等神煞, 说清这个环境对元主意味着什么(主迁移/主才气/不在原乡)。'
      + '出生当时的节气(立春/雨水/月令)照盘面写, 那不是「当时的社会情况」。',
    forbid: '**不是**出生年代的经济社会统计。不查 GDP / 国民经济 / 人均收入 / 平均工资 / '
      + '城镇化率 / 人口总数 / 统计公报, 不为这一条上网, 也不派子 agent 去查 —— '
      + '地形气候是常识, 直接写。',
  },
  {
    key: 'strength',
    title: '判断身强身弱',
    ask: '直接采用 bazi_calc 给的【六格判断】与【身旺身弱】: 得令/得地/得势三看, '
      + '日主与月令的关系, 印比与食伤财官的轻重对比, 给出旺/弱/中和的结论与依据。',
    forbid: '不要自己另算一遍旺衰 —— 引擎已经算好, 推翻它只会把对的改错。',
  },
  {
    key: 'useful',
    title: '取喜忌用神',
    ask: '采用引擎给的【喜用神】【忌神】, 再说清取用的理由: 扶抑/调候/通关三法用了哪一条, '
      + '以及这一条跟上一条「出生地周围情况」的调候结论是否合得上。',
    forbid: '喜用神允许是原局里没有的五行 (调候/补缺), 不许因为「盘里没有」就否掉引擎给的喜用。',
  },
  {
    key: 'relations',
    title: '看原局天干<course-source>',
    ask: '采用引擎给的【十神】【刑冲合害】: 天干五合、生克, 地支六合/三合/三会/六冲/相刑/相害, '
      + '点明哪几处是全局关键 (哪一处决定喜忌成败)。',
    forbid: '不要凭记忆排十神或编合冲 —— 引擎的十神表和地支关系表是唯一真源。',
  },
  {
    key: 'body',
    title: '看身一体状况',
    ask: '看日主与喜用神**是不是配得上**: 用神有没有得地有力 (有没有被合走、被克破), '
      + '用神能不能真起作用 (身强用财要身财两停、身弱用印要印能生身), '
      + '有没有「身用两伤」—— 这条决定这个人是「靠自己」还是「靠大运」。',
    forbid: '这一条不要另造术语, 按上面这套判法落到本局的喜用神上。',
  },
  {
    key: 'wealth',
    title: '看财运',
    ask: '看【财星】(正财=工资, 偏财=投资意外财)与食伤生财链: 钱从哪来、哪年进、哪年破, '
      + '破财处落在哪一柱哪一宫。',
    forbid: '',
  },
  {
    key: 'marriage',
    title: '看婚姻感情',
    ask: '看夫妻宫(日支)与配偶星(男看【财星】女看官杀): 配偶特点、缘分早晚、相处模式, '
      + '哪几年流年合夫妻宫、哪几年冲刑夫妻宫。',
    forbid: '',
  },
  {
    key: 'luck',
    title: '看大运流年',
    ask: '按题目指定的范围看: 当前大运(如壬申)与原局的冲合刑害、主这十年的主题; '
      + '再落到题目点名的年份 (如 25、26 年), 每年说什么事、宜什么忌什么。',
    forbid: '只说题目点名的范围, 不要把八十年流年全铺开。',
  },
];

/** 注入块标记 —— 工具层的门靠它认出「本轮是批命做题题」。 */
const ITEM_MARKER = '【批命做题纪律 · 系统强制】';

/** 「这轮是批命做题题」的判据 —— 只看主人自己的话, 不看注入块 (注入块是给模型的)。 */
const ITEM_TASK_RE = /(做题|做道题|这道题|这题|答这题|看题|看清楚题目|逐条答|照题目|按题目|按题答|这八条|八条题|批命|批八字)/;

/** 卦味词 —— 主人的话里出现这些 = 这不是排盘题, 别把排盘八条塞进去。 */
const GUA_WORD_RE = /(卦|占卜|梅花|起卦|易经)/;

/** 命理语境 (子平法那套词)。 */
const FATE_RE = /(八字|四柱|命盘|排盘|生辰|日主|日元|十神|喜用|用神|忌神|身强|身弱|旺衰|大运|流年|命理|批命|合婚|婚烟|婚姻)/;

/** 出生地环境语境 —— 命理上「出生地周围情况」这一条真正要的东西。 */
const ENV_RE = /(出生地|出生环境|出生地周围|周围情况|生活环境|居住环境|周边环境|地理环境|地形|气候|调候|水土|寒暖|燥湿)/;

/**
 * 时代统计语境 —— 命理题里出现这些 = 走偏了 (老板 2026-10-27 原话:
 * 「出生地周围情况，不是让盘古分析当时的情况」)。
 */
const STAT_RE = /(国民经济|生产总值|总产值|GDP|人均收入|人均可支配|平均工资|职工工资|工资水平|工资收入|城镇化|城镇人口|人口总数|统计公报|统计年鉴|筒子楼|凭票|票证|人均居住|生活水平)/i;

/** 明确的**动作/交付物**信号 —— 主人在这一轮要的是"东西", 不是"这道题的答案"。
 *  命中它 ⇒ 粘住解除 (那一轮可以走 dispatcher 去派活)。
 */
const ACTION_RE = /(导出|写脚本|生成脚本|存成|保存到|写成|做成|建个|建一个|拉个|写到|落盘|打包)/;

/** 外网调研类工具 —— 这些是「绕路」的出口。 */
const RESEARCH_TOOLS = new Set(['web_search', 'web_fetch', 'dispatch_subagents', 'ask_agent']);

/**
 * 覆盖检查用的关键词 —— 答案里点到几个, 才算「按题目答了」。
 *
 * 给 modules/answer_alignment.js 的「做题」分流用 (见那里的说明):
 * 词法门对「做题，看清楚题目」这种**没有内容词**的问题天生用不了,
 * 只能改成正向检查 —— 答案到底有没有落到这八条上。
 */
const COVER_KEYS = [
  '身强', '身弱', '旺衰', '喜用', '用神', '忌神', '日主', '月令',
  '原局', '十神', '刑冲合害', '身一体', '财运', '财星',
  '婚姻', '感情', '夫妻宫', '大运', '流年', '出生地', '调候',
];

// ============================================================
// 二、判据
// ============================================================

/**
 * 这一轮是不是「批命做题题」。
 *
 * 判据只看主人自己的话 + 有没有图:
 *   - 有图 (课件/排盘截图) + 话里出现「做题/题目」 => 是。
 *   - 话里出现「批命/批八字」 => 是 (哪怕没图)。
 *   - 话里带卦味 (卦/梅花/起卦) => **不是** —— 那可能是卦象题, 别把排盘八条塞进去。
 *
 * @param {string} text 主人这一轮的话 (未注入任何纪律块)
 * @param {{hasImages?: boolean, sessionItemTask?: boolean, hasChart?: boolean}} opts
 * @returns {{matched: boolean, reason: string}}
 */
function detectItemTask(text, opts = {}) {
  const t = String(text || '');
  if (!t) return { matched: false, reason: '空输入' };
  if (GUA_WORD_RE.test(t)) {
    return { matched: false, reason: '话里带卦味 —— 不是排盘做题题' };
  }
  // 2026-10-28 (现场 web-1793124838326 第 2 轮实测): 原来要求「有图」才认做题题,
  //   但老板的第 2 轮只发了一个字「**做题**」—— 没重传图 ⇒ 判不中 ⇒
  //   纪律没注入、路由掉进 dispatcher ⇒ 那一轮 5 分钟起 (现场亲历)。
  //
  //   补两档依据, 都是「这一轮八条是明摆着的」:
  //     · sessionItemTask —— 上一轮就是做题题 (追问轮)
  //     · hasChart        —— 会话里已经有盘了 (facts 块能抽出四柱)
  //       此时一句「做题」只可能指这张盘的那八条, 不可能指别的。
  if (ITEM_TASK_RE.test(t)
      && (opts.hasImages || /批命|批八字/.test(t) || opts.sessionItemTask || opts.hasChart)) {
    return { matched: true, reason: '做题/批命题' };
  }
  // 2026-10-28 (现场 web-1793124838326): 追问轮**没重传图**时, 上面那档判不出来 ——
  //   于是「八条逐条作答」纪律没注入、路由又掉进 dispatcher, 一道主 agent 自己就能干
  //   的命理题被派给 2 个将灵去查外网 (403/超时), 整轮 5 分钟起。
  //
  //   修法: 本会话**上一轮**就是批命做题题 ⇒ 这一轮仍按做题题处理 (粘住)。
  //   粘住只在"主人还在同一道题上追问"时成立, 所以额外要求本轮文本仍带做题信号
  //   (ITEM_TASK_RE) 或是一句明显的短追问 (继续/接着/再/还有/…)。
  //   一旦主人换话题 (比如"帮我写个脚本"), 两个条件都不满足 ⇒ 粘住自动解除。
  if (opts.sessionItemTask) {
    if (ITEM_TASK_RE.test(t)) {
      return { matched: true, reason: '做题/批命题(承接上一轮)' };
    }
    // 2026-10-28 (现场 web-1793124838326 第 4 轮实测): 主人**纠正**上一轮答案时,
    //   原话是「是原主出生地附近的情况，不是四川盆地的情况」——
    //   既没有「做题」二字, 也不是「继续/接着」那种短追问 ⇒ 上面两档都判不中
    //   ⇒ 粘住失效 ⇒ 这一轮掉进 dispatcher, 又派了 2 个将灵去查外网 (5 分钟起)。
    //   证据在会话落盘里: 那一轮的 msgs 里有一条 [子 agent 派发记录]。
    //
    //   判据改成"**还在这道题的语境里**": 命理词 (日主/大运/喜用…) 或
    //   出生地环境词 (出生地/调候/水土…) 都算还在问这道题。
    //   例外: 主人在这一轮要的是**交付物** (导出/写脚本/存成…) ⇒ 粘住解除,
    //   那一轮该走 dispatcher 就让它走。
    if ((FATE_RE.test(t) || ENV_RE.test(t)) && !ACTION_RE.test(t)) {
      return { matched: true, reason: '命理追问(承接上一轮做题题)' };
    }
    if (/^(继续|接着|再来|再|还有|然后|往下|下一步|详细点|展开|嗯|对|好|行)/.test(t.trim())) {
      return { matched: true, reason: '做题/批命题(承接上一轮)' };
    }
  }
  return { matched: false, reason: '不是做题题' };
}

/**
 * 这一轮是不是「单镜排盘任务」—— 主 agent 一口气答完, **不许进 dispatcher**。
 *
 * 2026-10-28 (现场 web-1793124838326) 立。理由跟第 129 批那条同源:
 *   dispatcher 路径下 main 的工具笼被砍到 2 个 (dispatch_subagents + task_done),
 *   main **够不到 bazi_calc** ⇒ 排盘只能派给将灵 ⇒ 将灵去查外网 (403/30s 超时)
 *   ⇒ 一道主 agent 一次调用就能答完的排盘题, 整轮 5 分钟起。
 *   老板现场原话: 「第二次对话开始就慢了」。
 *
 * 三档 (任一命中即是):
 *   ① 批命做题题 (含会话粘住)          —— detectItemTask
 *   ② 生辰排盘题 (带日期或明说排八字)    —— bazi_intent.detectBaziIntent (唯一真源)
 *   ③ 会话里已经有盘 + 本轮还在问命理    —— 追问轮
 *
 * ③ 的两个必要条件缺一不可:
 *   - `opts.hasChart`: 会话里确实已经算出了盘 (bazi_chart_facts 能抽出四柱)。
 *     没有它, 「这个人的大运怎么样」这种没头没尾的句子会被当排盘题。
 *   - 本轮还在命理/出生地语境里, 且**不是**在要交付物 (导出/写脚本/存成…) ——
 *     后者该走 dispatcher 就让它走。
 *
 * @param {string} text 主人这一轮的话 (未注入任何纪律块)
 * @param {{hasImages?: boolean, sessionItemTask?: boolean, hasChart?: boolean}} opts
 * @returns {{matched: boolean, reason: string}}
 */
function detectSingleShotChartTask(text, opts = {}) {
  const t = String(text || '');
  if (!t) return { matched: false, reason: '空输入' };

  const _it = detectItemTask(t, opts);
  if (_it.matched) return { matched: true, reason: '批命做题题 (' + _it.reason + ')' };

  // ② 生辰排盘题 —— 用 bazi_intent 的判据, 不另抄一份词表
  //   (项目铁律: 同一件事只留一个真源, 抄第二份就是下一次漂移的起点)。
  try {
    const _bi = require('./bazi_intent.js');
    const _r = _bi.detectBaziIntent(t);
    if (_r && _r.matched) {
      return { matched: true, reason: '生辰排盘题 (' + (_r.reason || '') + ')' };
    }
  } catch (_) { /* 模块不在就退到下面两档 */ }

  // ③ 追问轮 —— 已经有盘了, 这一轮还在问命理
  if (opts.hasChart && (FATE_RE.test(t) || ENV_RE.test(t)) && !ACTION_RE.test(t)) {
    return { matched: true, reason: '已有命盘 + 命理追问' };
  }

  // ④ 题目类信号 —— 主人明说「做题/这道题/八条题」。
  //   为什么单独一档, 不并进 ①: 纪律注入 (八条逐条作答) 要求「确实是那八条」
  //   (得有课件图或批命字样), 而**路由**只要判断「主 agent 能不能一口气答完」。
  //   两个门管两件事, 不许合并 —— 与 chart_verify_guard 的分工是同一条规矩。
  //   实测 (现场 web-1793124838326): 老板第 2 轮只发了「做题」两个字,
  //   没重传图 ⇒ ① 不命中 ⇒ 掉进 dispatcher ⇒ 5 分钟起。
  if (ITEM_TASK_RE.test(t)) {
    return { matched: true, reason: '主人明说是做题题 (' + (ITEM_TASK_RE.exec(t) || [''])[0] + ')' };
  }

  return { matched: false, reason: '不是单镜排盘任务' };
}

/**
 * 把调用参数摊平成可判定的文本。
 * @param {string} name
 * @param {object} params
 * @returns {string}
 */
function callText(name, params) {
  const p = params && typeof params === 'object' ? params : {};
  const parts = [
    p.q, p.query, p.keyword, p.url, p.command, p.cmd, p.pattern, p.path,
    p.reason, p.task, p.message, p.description, p.prompt,
  ];
  if (Array.isArray(p.tasks)) {
    for (const t of p.tasks) {
      if (t && typeof t === 'object') parts.push(t.task, t.description, t.reason);
    }
  }
  const s = parts.filter(v => typeof v === 'string').join(' ');
  return name + ' ' + s;
}

// ============================================================
// 三、注入块 (给模型看的)
// ============================================================

/** 八条题目清单 (照抄课件原文)。 */
function renderItemChecklist() {
  return ITEMS.map((it, i) => (i + 1) + '. ' + it.title).join('\n');
}

/**
 * 批命做题纪律 —— 进门就注入给模型。
 *
 * 位置铁律 (第 129 批, 别改):
 *   必须挂在 modules/pangu_agent_stream.js 里 **`const _userInputForRouting` 快照之后**。
 *   快照之前挂 = 这段字会参与 dispatcher 路由判定, 而 DISPATCHER_KWS 里有
 *   '分析'/'天气'/'检查'/'验证'/'64'/'卦' 等词 —— 一挂就把纯文字的命理题
 *   拽进 90 秒起步的 dispatcher 编排。**那本身就是一个「慢」的制造机。**
 *
 * @returns {string}
 */
function renderItemDiscipline() {
  const lines = [];
  lines.push(ITEM_MARKER + '这是一道批命做题题: 题目在图里, 八条, 逐条作答。');
  lines.push('① 先把八条题目按原文抄下来(标题一个字都不改), 再一条一段作答, 顺序照题目来, 不要自造议题;');
  lines.push('② 命理部分一律用 bazi_calc 算出来的确定性盘面(【十神】【五行】【身旺身弱】【喜用神】【忌神】【刑冲合害】【大运流年】都已算好), 不要自己另算, 不要推翻;');
  lines.push('③ 「分析出生地周围情况」= 出生地的**地理环境**(地形/山水/水土/气候寒暖燥湿/日照降水), '
    + '命理上用来判**调候**(调候用神与原局喜忌是否一致), 再配合盘里的驿马/桃花/将星说清这个环境对元主意味着什么; '
    + '**不是**出生年代的经济社会统计(GDP/人均收入/平均工资/城镇化率/人口总数/统计公报);');
  lines.push('④ 这一条不需要外网调研: 地理气候是常识, 直接写; 不许为它发 web_search / web_fetch, 也不许派子 agent 去查;');
  lines.push('⑤ 上下文里的【盘古起卦】块是按你的话另起的一卦, 与本题(排盘)无关, 不要据此推断;');
  lines.push('八条题目(照抄图上原文):');
  lines.push(renderItemChecklist());
  lines.push('两条容易走偏的口径:');
  lines.push('- 出生地周围情况 → 地理环境/调候, 不是时代统计。');
  lines.push('- 身一体状况 → 日主与喜用神配不配得上(用神有没有被合走/克破, 能不能真起作用), 不是另造一个术语。');
  return lines.join('\n');
}

// ============================================================
// 四、工具层的门 (硬机制, 不靠模型自觉)
// ============================================================

// 本轮的上下文 (按 sessionId 存)。
// 为什么需要它: 光看调用参数判不出「这一轮是批命题」—— 那条 web_search 的参数是
// 「1975年四川省 国民经济总产值 人口 城镇职工平均工资 统计公报」, 里面一个命理词都没有。
// 有没有题, 只有**本轮上下文**知道。
const _turnCtx = new Map();
const _TURN_CTX_MAX = 500;

/**
 * 记下本轮的上下文 (pangu_agent_stream 进门时调)。
 * @param {string} sessionId
 * @param {{itemTask?: boolean, turnText?: string}} ctx
 */
function setTurnContext(sessionId, ctx) {
  const sid = String(sessionId || '').trim();
  if (!sid) return;
  if (_turnCtx.size >= _TURN_CTX_MAX) {
    // 超量就清掉最老的一半 (Map 保插入序) —— 不让这玩意儿变成内存坑。
    const drop = Math.floor(_TURN_CTX_MAX / 2);
    let i = 0;
    for (const k of _turnCtx.keys()) {
      _turnCtx.delete(k);
      if (++i >= drop) break;
    }
  }
  _turnCtx.set(sid, {
    itemTask: Boolean(ctx && ctx.itemTask),
    turnText: String((ctx && ctx.turnText) || ''),
    ts: Date.now(),
  });
}

/**
 * 取本轮上下文。
 * @param {string} sessionId
 * @returns {{itemTask: boolean, turnText: string}}
 */
function getTurnContext(sessionId) {
  const sid = String(sessionId || '').trim();
  const hit = sid ? _turnCtx.get(sid) : null;
  return hit
    ? { itemTask: hit.itemTask, turnText: hit.turnText }
    : { itemTask: false, turnText: '' };
}

/** 给模型看的回灌文案 —— 只说「该干什么」, 不说「别干什么」(chart_verify_guard 的同款教训)。 */
function scopeMessage() {
  return '[系统: 口径纠正] 「分析出生地周围情况」这一条在子平法里 = 出生地的地理环境'
    + '(地形/山水/水土/气候寒暖燥湿), 命理上用来判调候, 再看调候用神与原局喜忌是否一致; '
    + '不是出生年代的经济社会统计(GDP/人均收入/平均工资/城镇化率/人口总数/统计公报)。'
    + '这一条不需要外网调研 —— 地理气候是常识, 直接按盘面(月令/季节/喜用忌神/日主五行)结合出生地的地形气候写。'
    + '接下来该做的事: 用 bazi_calc 的确定性盘面, 按题目八条逐条作答。';
}

/**
 * 这次工具调用要不要拦。
 *
 * 三档判据 (缺一条就漏, 三条都要):
 *   ① 参数自带错口径 (**只对派下来的活**): 参数文本同时命中「时代统计」和「命理/出生地环境」=> 拦。
 *      —— 这条管的是子 agent 拿到的任务原文 (它自己就写着「为八字命理报告提供事实底座」)。
 *      ⚠️ 不对主人自己的问句开: 主人问「查一下1975年四川的GDP, 顺便看看我八字」是正当问题。
 *   ② 本轮是批命做题题 (有状态): 本轮注入了纪律 => 这一轮不许发时代统计类调研。
 *      —— 这条管的是主 agent 自己那条 web_search (参数里一个命理词都没有)。
 *   ③ 本轮本身就是「查时代统计」的调研轮 (`ctx.assignment` 为真时才算): 轮次文本命中 ① => 该轮的**联网调研全拦**。
 *      —— 这条管的是子 agent 在自己那一轮里继续查统计。
 *      ⚠️ 只对**派下来的活**开 (assignment=true), 不对主人自己的问句开 ——
 *      主人问「查一下 1975 年四川的 GDP, 顺便看看我八字」是正当问题, 拦了就是误伤。
 *
 * @param {string} name 工具名
 * @param {object} params 工具参数
 * @param {{turnText?: string, sessionId?: string, itemTask?: boolean}} ctx
 * @returns {{blocked: boolean, why: string}}
 */
function inspectToolCall(name, params, ctx = {}) {
  const tool = String(name || '');
  if (!RESEARCH_TOOLS.has(tool) && tool !== 'exec_command') {
    return { blocked: false, why: '' };
  }

  const text = callText(tool, params);
  const turn = ctx && ctx.turnText ? String(ctx.turnText) : '';
  const sessionId = ctx && ctx.sessionId ? ctx.sessionId : '';
  const turnCtx = (ctx && ctx.itemTask !== undefined)
    ? { itemTask: Boolean(ctx.itemTask), turnText: turn }
    : getTurnContext(sessionId);
  const turnText = turn || turnCtx.turnText || '';

  // exec_command 只在它真去外网取东西时才管 (grep 一个提到八字的笔记不该被拦)。
  if (tool === 'exec_command' && !/(curl|wget|http:\/\/|https:\/\/|urllib|requests\.|fetch\()/.test(text)) {
    return { blocked: false, why: '' };
  }

  const callHasStat = STAT_RE.test(text);
  const callHasFate = FATE_RE.test(text);
  const callHasEnv = ENV_RE.test(text);

  // ① 参数自带错口径 —— 只对**派下来的活**开 (主人自己的问句不是活)
  if (ctx && ctx.assignment && callHasStat && (callHasFate || callHasEnv)) {
    return { blocked: true, why: '参数里同时出现「时代统计」和「命理/出生地环境」—— 这是错口径的调研' };
  }

  // ② 本轮是批命做题题 => 这一轮不许发时代统计类调研
  if (turnCtx.itemTask && callHasStat) {
    return { blocked: true, why: '本轮是批命做题题, 「出生地周围情况」不需要外网调研' };
  }

  // ③ 本轮本身就是查时代统计的调研轮 (子 agent 拿到的那种任务; 只对 assignment 开)
  //   整轮都拦, 不看单次调用的参数 —— 现场那 6 次 web_fetch 的 URL 里一个统计词都没有
  //   (是 www.stats.gov.cn 这种域名), 按参数判会漏。任务本身就是错口径 ⇒ 这一轮不该联网。
  const turnIsStatsResearch = STAT_RE.test(turnText) && (FATE_RE.test(turnText) || ENV_RE.test(turnText));
  if (ctx && ctx.assignment && turnIsStatsResearch) {
    return { blocked: true, why: '本轮任务本身就是「为命理报告查时代统计」—— 口径错, 这一轮该查的是出生地地理环境' };
  }

  return { blocked: false, why: '' };
}

/**
 * 派活闸门 —— 拦「把命理题派成史实调研」。
 *
 * 现场: 主 agent 派的这一刀原文是「查证「1975年(尤其中四川省/成都)居民家庭周边的
 * 实际生活环境」, 为一份1975年2月8日出生四川者的**八字命理报告**提供「出生地周围情况」
 * 一节的事实底座」—— 命理 + 时代统计, 两样齐了 => 这刀从一开始就不该派。
 *
 * @param {Array} tasks [{task, agent, ...}]
 * @param {{turnText?: string, itemTask?: boolean}} ctx
 * @returns {{blocked: boolean, why: string, task: string}}
 */
function inspectDispatchTasks(tasks, ctx = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  const turnText = String((ctx && ctx.turnText) || '');
  const itemTask = Boolean(ctx && ctx.itemTask);
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const txt = [t.task, t.description, t.reason].filter(v => typeof v === 'string').join(' ');
    if (!txt) continue;
    const hasStat = STAT_RE.test(txt);
    const hasFate = FATE_RE.test(txt);
    const hasEnv = ENV_RE.test(txt);
    if (hasStat && (hasFate || hasEnv)) {
      return { blocked: true, why: '这一刀是「为命理报告查时代统计」—— 口径错', task: txt };
    }
    if (hasEnv && /\d{4}\s*年/.test(txt) && (hasStat || hasFate)) {
      return { blocked: true, why: '这一刀是「按出生年代去查出生地环境」—— 口径错(要查的是地理环境, 不是年代统计)', task: txt };
    }
    if (itemTask && hasEnv && /\d{4}\s*年/.test(txt)) {
      return { blocked: true, why: '批命做题题里不许派刀去查出生地/周边环境的年代事实', task: txt };
    }
  }
  if (itemTask && list.length) {
    // 批命做题题: 派活一律不放行 (八条题都能用 bazi_calc 的盘面直接答)。
    // 单刀本来就会被 dispatch_subagents_exec 的 DISPATCH_SINGLE 拦, 多刀是
    // 「拿并行机制干一件自己能干的活」—— 一律拦掉, 让主 agent 自己按八条答。
    return {
      blocked: true,
      why: '批命做题题: 八条题都能用 bazi_calc 的确定性盘面直接答, 不需要派刀',
      task: (list[0] && list[0].task) || '',
    };
  }
  return { blocked: false, why: '', task: '' };
}

module.exports = {
  ITEMS,
  ITEM_MARKER,
  COVER_KEYS,
  FATE_RE,
  ENV_RE,
  STAT_RE,
  renderItemChecklist,
  renderItemDiscipline,
  detectItemTask,
  detectSingleShotChartTask,
  inspectToolCall,
  inspectDispatchTasks,
  setTurnContext,
  getTurnContext,
  scopeMessage,
  callText,
};
