// reading.js —— AI 解读的**分项规格**。
//
// 为什么分项 (2026-10-27, 老板拍):
//   旧页面一次性要一篇 2200-3000 字、nine 节的解读 ⇒ 只能给一个大预算 (6500),
//   而 MiniMax-M3.1-Flash 的思考长度**跟着预算走** ⇒ 预算被思考吃光 ⇒ 正文一个字没有。
//   拆成**一项一次请求**之后: 每次只要一小段 ⇒ 每次的预算都很小 ⇒
//   思考量也随之变小 (实测 2048 预算下思考 <1500 token) ⇒ 不会撞墙。
//   附带好处: 某一项失败只重试这一项, 其余项不受影响。
//
// 每项自带 max_tokens (预算) 与 reasoning_effort —— **不许**再出现 6500 这种
// 「按字数一次性算出来」的大预算。

// ─────────────────────────────────────────────────────────────────────────
// 2026-10-31 (老板: 「为什么要有请求上限? 每个部分的侧重点都不一样, 预设上限不对」)
//
// **上限的作用不是「限制内容写多少」** —— 内容长度由提示词里的篇幅指令决定
// (实测: cap 32768 下批语正文仍写 166-217 字, 贴着提示词要的 120-220 字)。
// 上限的作用是**给思考留过路费 + 兜住输出长度**:
//   推理模型的思考和正文抢同一个 token 池; 不给够, 思考吃光 ⇒ 正文一个字没有
//   (2026-10-26 现场: 6500 预算下九节只剩四个标题)。
//
// **但预设一个数套全部是错的** —— 本次实测 (25 项真实生产提示, 直连 MiniMax):
//   思考用量从 165 (命盘总解) 到 2712 (健康) 不等, 差 16 倍;
//   同一项重复跑还会再抖 2-4 倍 (health 1845/2156/2712)。
//   ⇒ 写死 2048 套 16 条批语 ⇒ 便宜的项浪费额度, 贵的项**必然撞墙**
//   (实测 health completion 3186 > 3072 ⇒ 触发服务端静默用满 32768 重试,
//    白烧约 30 秒, 而页面照样显示「预算 2048」—— 假账)。
//
// ⇒ **每一项按自己的规格算预算** (`SPEC`): 正文字数上限 + 思考预留。
//   思考预留取该项**实测上界 + 余量**, 不是拍脑袋。

/**
 * 每一项的规格 —— **提示词要什么** 与 **上限给多少** 放在同一个对象里。
 *
 *   ask   = 提示词里「篇幅:」那句 (正文长度由它决定, 不是由上限决定)
 *   chars = 正文 token 上界 (≥ ask 要求的字数; 用汉字数记 token 是安全上界)
 *   think = 思考预留 (token) —— 推理模型的思考跟正文抢同一个池子
 *
 * `think` 的来历 —— 2026-10-31 实测 **97 次** (25 项真实生产提示各跑一轮,
 * 再挑 14 项各重复 3-4 轮, 最后按新预算整批复跑一遍验证), MiniMax-M3.1-Flash,
 * reasoning_effort=low:
 *
 *   分段: summary 341 / advice 939 / timeline 1176 / **parents 1936**
 *         **career 1666** / **marriage 1666** / wealth 1951 / study 2126
 *         **health 2712**
 *   批语: 用神 644 / 大运 701 / 流年 910 / **刑冲合害 1609**
 *
 *   ⚠ 单样本会严重低估 (第一版只跑一轮时 parents 的思考上界看着是 596,
 *   补跑后是 1936 —— 差 3 倍多)。⇒ 表里每一项都是多轮实测的上界。
 *
 * 推导规则 (为什么是这两个系数):
 *   ① `chars` = max(提示词要的字数, 实测正文字数上界 × 1.3) ⇒ 正文留 30% 余量
 *      (实测中文正文 0.67-0.81 token/汉字)。
 *   ② `think` = 实测思考上界 × 2.0 ⇒ 思考留 100% 余量。
 *      理由: 同一提示重复跑, 思考会抖 2-5 倍 (实测 health 1845/2156/2712,
 *      advice 184/939)。**低估的代价不是「答得短」, 是撞墙后服务端静默
 *      用满 32768 重试 (白烧约 30 秒) 且页面还在显示原来的假预算。**
 *      ⇒ 宁可多给 —— 多给**不花钱**: 思考长度由 effort 决定, 不由 cap 决定
 *      (实测同一提示 cap 2048/3072/8192/32768, 思考量与 cap 无相关)。
 *      单样本的项 (n=1) 再 ×1.3, 因为一个样本看不到尾巴。
 */

export const SPEC = {
  // 分段解读九节
  section: {
    summary:  { ask: '300-600 字',                            chars: 608,  think: 704 },
    timeline: { ask: '300-600 字',                            chars: 672,  think: 2368 },
    parents:  { ask: '300-600 字',                            chars: 800,  think: 3872 },
    study:    { ask: '300-600 字',                            chars: 896,  think: 4256 },
    career:   { ask: '300-600 字',                            chars: 992,  think: 3360 },
    wealth:   { ask: '300-600 字',                            chars: 1408, think: 3904 },
    marriage: { ask: '300-600 字',                            chars: 864,  think: 3360 },
    health:   { ask: '300-600 字',                            chars: 800,  think: 5440 },
    advice:   { ask: '6-8 条, 每条 1-3 句',                    chars: 1056, think: 1888 },
  },
  // 逐项批语四组
  note: {
    大运:      { ask: '120-220 字, 写成连贯的一段话, 可以分句但不要编号、不要加小标题。', chars: 288, think: 1408 },
    流年:      { ask: '120-220 字, 写成连贯的一段话, 可以分句但不要编号、不要加小标题。', chars: 288, think: 1824 },
    刑冲合害:  { ask: '120-220 字, 写成连贯的一段话, 可以分句但不要编号、不要加小标题。', chars: 288, think: 3232 },
    用神:      { ask: '120-220 字, 写成连贯的一段话, 可以分句但不要编号、不要加小标题。', chars: 288, think: 1312 },
  },
};

/**
 * 一项的输出预算 (token) = 正文上界 + 思考预留。
 *
 * 正文上界直接用**汉字数**: 实测中文正文 0.67-0.81 token/汉字, 1:1 记是安全上界
 * (换 tokenizer 会偏, 但偏高不偏低 ⇒ 只可能宽松, 不会撞墙)。
 * ⚠ 别把这个系数当精确值 —— 它只是「不撞墙」的保守界, 不是配额。
 *
 * @param {{chars:number, think:number}} spec
 * @returns {number} max_tokens
 */
export function budgetOf(spec) {
  const chars = Number(spec && spec.chars) || 0;
  const think = Number(spec && spec.think) || 0;
  return Math.max(256, Math.ceil(chars + think));
}

/**
 * 取一项的规格。分段按 `key`, 批语按 `group`。
 * 查不到 ⇒ 返回 null (调用方自己决定降级, 不静默套一个数)。
 */
export function specOf(kind, key) {
  const table = SPEC[kind];
  if (!table) return null;
  return table[key] || null;
}

/** 请求级推理强度: 'low'。实测 low ⇒ 思考 2472 token、速度 4 倍于默认。 */
export const EFFORT = 'low';

const RULES = [
  '只输出本节的正文, 不要写二级标题、不要写「本节」「以下是」这类开场白。',
  '只写中文正文, 不要输出英文思考过程、推理草稿、自我质疑。',
  '命盘的旺衰/喜用忌神/十神/原局刑冲合害/大运流年序列**已由确定性引擎算好**, 直接采用, 不要推翻、不要重算。',
  '**年龄一律直接读【当前年龄】和【流年】里的「年龄」字段, 禁止自己算 year - birth_year**。',
  '老派命师口吻, 直白可操作, 允许用「宜/慎/忌/莫」, 不堆砌神煞术语, 判断都要给依据。',
  '不要绝对化断语, 不要下恐吓式断言。',
].join('\n');

const YINGQI_RULE = [
  '断应期必须落到**具体年份 + 该领域发生什么具体事**, 并点明是哪个流年干支与命局哪处宫位/十神形成了冲/合/刑/害。',
  '只做静态性格或方向描述而不落到年份的, 不合格。',
].join('\n');

const EXCLUDE_RULE = [
  '每个领域除了断「何时会、何时忌」, 还要断一句「**绝对不会**发生什么」, 且用两层依据:',
  '(甲)年龄/生命阶段层 —— 该年龄段根本不可能发生某事(未成年绝不婚配/无工资性财运, 不看命理也成立);',
  '(乙)命理扳机层 —— 哪一年因关键宫位十神未被合动冲动、或冲象被合解、或该十神根本不成局, 确定不会有某事。',
].join('\n');

/** 九节 —— 每一节一次独立请求。 */
export const SECTIONS = [
  {
    key: 'summary',
    title: '命盘总解',
    ask: '这一节是全篇根基: 把整张命盘翻译成一段人话。必须写清: '
      + '① 日主是谁、旺或弱(引【身旺身弱】【旺衰判断依据】); '
      + '② 喜用什么忌什么(引【喜用神】【忌神】); '
        + '②½ 若【调候】非空, 一句带过命局寒暖燥湿倾向与所需调候五行(引擎已查表, 你只翻译, 不重判); '
        + '若【通关】非空, 点明哪两行交战、靠哪行通关(只念引擎给的字, 不自己推); '
      + '③ 月令与格局(从月令本气与透干判断「何格」); '
      + '④ 地支有哪些冲合刑害(引【刑冲合害】), 点明哪几处是全局关键。',
  },

  {
    key: 'timeline',
    title: '大运流年总览',
    ask: '这是「日历」节: ① 当前大运干支十神属性、与原局的冲合刑害, 主导这十年什么主题; '
      + '② 早运/中运/晚运的走向; '
      + '③ 接下来五到十年的时间轴, 指出哪几步大运是关键转折。'
        + '各步大运的【互动命中】(忌神引动/冲月令等)已由引擎查表算好, '
        + '你只按命中的 rule 写「这十年得到什么/失去什么」(论得失, 不论绝对好坏), 不要自己重判吉凶。'
      + '具体某领域哪年发生什么事, 留给后面各领域去细断, 这里不要重复。',
  },
  {
    key: 'parents',
    title: '父母',
    ask: '父母看年柱(年支为父母宫, 年干所透十神), 正印为母、偏印为父或长辈; 印星强弱看缘分厚薄与长辈助力。'
      + '结合【刑冲合害】看父母宫(年支)是否被冲合刑害: 被冲=与父母/祖业/家乡变动聚散, 被合=与长辈家人牵绊结合。'
      + '断应期: 哪几年流年冲刑父母宫或冲动印星, 那几年多与父母长辈祖屋家乡有大事; 哪几年印星得地或父母宫逢合, 那几年得上辈提携。'
      + '按年龄层说明: 幼年多看照拂, 成年后看与父母祖业兄弟姐妹的牵连。',
  },
  {
    key: 'study',
    title: '学业',
    ask: '看印星(学历文凭证书)与食神(天赋)定学业底子, 官杀看考试压力; 结合【刑冲合害】看学业易被什么打断。'
      + '断应期: 哪几年流年干支冲/合/刑/害到印星、文昌位或学业宫, 那几年就有升学考试录取证书专业转折等事件; 哪几年适合进修考证。'
      + '学生期命主重点断升学考运, 成年命主转为考证进修运。',
  },
  {
    key: 'career',
    title: '事业',
    ask: '看官杀(正官=体制稳定, 七杀=压力竞争)、食伤(才华创业)、偏印(技术)定职业类型; 结合【刑冲合害】定职场环境。'
      + '断应期: 哪几年流年合动官杀/食伤或冲命局禄位, 那几年就有求职跳槽升职创业贵人合作等事件; 哪几年冲刑太重忌变动。'
      + '指出「某年宜求/某年宜升/某年忌动」。',
  },
  {
    key: 'wealth',
    title: '财运',
    ask: '看【财星】(正财=工资, 偏财=投资意外财)与食伤生财链定赚钱方式; 指出易破财处。'
      + '断应期: 哪几年流年天干透出财星或食神生财且未冲破, 那几年是进财得财的年份; 哪几年流年冲财星或比劫夺财, 那几年是破财耗财易被人分夺需守成的年份。'
      + '指出「某年宜进财/某年宜守财/某年忌投资」。',
  },
  {
    key: 'marriage',
    title: '婚姻感情',
    ask: '看夫妻宫(日支)、配偶星(男看【财星】女看官杀); 判断配偶特点、缘分早晚、相处模式。'
      + '断应期: 哪几年流年合夫妻宫或合配偶星, 那几年利成婚恋爱得伴; 哪几年流年冲刑夫妻宫, 那几年婚恋有波动聚散需磨合。'
      + '指出「某年利婚/某年宜稳/某年忌强求」。',
  },
  {
    key: 'health',
    title: '健康',
    ask: '五行偏枯对应脏腑(水→肾/膀胱, 木→肝胆, 火→心血管/眼, 土→脾胃, 金→肺/呼吸); 结合【刑冲合害】说明先天易发部位。'
      + '断应期: 哪几年流年冲刑所对应的脏腑宫位或忌神当值, 那几年健康需格外留意; 哪几年较平稳。'
      + '并按年龄段点明该年龄段的常发之疾。各年龄段养护重点。',
  },
  {
    key: 'advice',
    title: '调理建议',
    ask: '最实操的一节: 给 6-8 条**具体、日常、不花钱或低成本**的建议, 每条「做法 + 对本局的作用 + 为什么对这个命局有效」。'
      + '按维度展开: 补【喜用神】、养【忌神】之伤、化解【刑冲合害】里最棘手某处的通关做法、作息与五脏养护、居所方位、'
      + '人际取舍、时间规避(结合【大运流年】列忌神年, 忌做辞职/重仓/担保等激进动作)。'
      + '每条一行, 以「1. 2. 3.」开头。老派做法, 不讲玄虚。',
  },
];

/** 需要断应期的节 (排除断法只加在这些节上)。 */
const YINGQI_KEYS = new Set(['parents', 'study', 'career', 'wealth', 'marriage', 'health']);

/**
 * 全局上下文 —— 每次请求都带, 但只带必要的(完整盘 JSON 有 15KB, 一项带全太胖)。
 */
export function chartContext(chart) {
  const by = Number(chart.input && chart.input.year) || 0;
  const now = new Date().getFullYear();
  return {
    四柱: chart.pillars,
    藏干: chart.cang_gan,
    天干十神: chart.shishen_tiangan,
    星运: chart.changsheng_4,
    纳音: chart.nayin_4,
    // 自坐 (每柱天干坐自己地支) / 空亡 (每柱按自己所在旬)
    // —— 2026-10-31 第 176 批补齐, 与老板上课 app 的盘面结构对齐。
    //   自坐跟星运**不是一回事**: 星运是「日主」在四柱地支上的位置,
    //   自坐是「这一柱自己的天干」坐在「这一柱自己的地支」上。
    自坐: chart.zichuan_4,
    空亡: chart.xunkong_4,
    // 逐柱神煞 (2026-10-31 第 182 批恢复: 按课件 08/09 补齐, 老板盘 16 条逐字一致)
    逐柱神煞: chart.shensha_by_pillar,
    五行分布: chart.wuxing_count,
    日主: `${chart.day_master || ''} ${chart.day_master_wuxing || ''}${chart.day_master_yinyang || ''}`,
    //
    // 命主性别 —— 显式给, 不让模型从日干阴阳去猜 (2026-10-31 第 176 批)。
    //   「男看财星女看官杀」这类判断**依赖命主性别**, 而日干阴阳 ≠ 命主性别
    //   (男命里阴日干的大有人在)。给 male/female/unknown 三态。
    命主性别: (function () {
      const g = String((chart.gender || (chart.input && chart.input.gender) || '')).toLowerCase();
      if (g === 'male') return '男';
      if (g === 'female') return '女';
      return '未知';
    })(),
    月令: (chart.jieqi && chart.jieqi['月令']) || '-',
    身旺身弱: chart.status || '-',
    旺衰判断依据: chart.status_reason || '',
    喜用神: chart.xi_yong || [],
    喜用神依据: chart.xi_yong_reason || '',
    忌神: chart.ji_shell || [],
    财星: chart.cai_xing || [],
    六格: { 部别: chart.taiyuan, 命局: chart.minggong, 身局: chart.shengong },
    刑冲合害: {
      冲: chart.chong || [], 合: chart.he || [], 刑: chart.xing || [],
      害: chart.hai || [], 破: chart.po || [],
    },
    // 查法真源 (2026-11-07 第 211 批): 调候/通关由引擎查表算好, 模型只翻译不判断。
    调候: chart.tiaohou && chart.tiaohou['适用']
      ? { 倾向: chart.tiaohou['倾向'], 需: chart.tiaohou['调候需'], 注: chart.tiaohou['注'] }
      : null,
    通关: (chart.tongguan && chart.tongguan['交战对'].length)
      ? chart.tongguan['通关需']
      : null,
    // 盲派轨 (2026-11-07 第 214 批): 跟子平轨并列, 模型只翻译「公位坐星/做功」, 不重判。
    // 仅在盲派.可用 时喂, 子平轨喜忌 (喜用/忌神) 不受盲派污染。
    盲派: (chart['盲派'] && chart['盲派']['可用'])
      ? {
          公位坐星: chart['盲派']['公位坐星'],
          干支做功: chart['盲派']['干支做功'],
          体用党事: chart['盲派']['体用党事'],
        }
      : null,
    // 流年引动: 引擎标的「命中哪类引动」, 模型只翻译不重判 (2026-11-07 第 211 批)
    流年引动: chart.liunian_yindong || null,
    当前年龄: by ? now - by : null,
    出生: chart.input || {},
  };
}

/** 一次请求只带它需要的那部分大运/流年, 不把 90 个流年全塞进去。 */
export function timelineContext(chart, opts) {
  const o = opts || {};
  const by = Number(chart.input && chart.input.year) || 0;
  const list = (chart.dayun && chart.dayun['列表']) || [];
  const now = new Date().getFullYear();
  const dayun = o.dayn
    ? list.filter((d) => o.dayn.includes(d['干支']))
    : list.slice(0, 3);
  const years = (chart.liunian || []).filter((y) => {
    const yr = Number(y['年份']);
    if (o.years && o.years.includes(yr)) return true;
    if (o.fromYear && yr >= o.fromYear) return true;
    return false;
  });
  return {
    大运: dayun.map((d) => ({
      干支: d['干支'], 起始年份: d['起始年份'], 起始年龄: Math.floor(d['起始年龄']),
      天干十神: d['十神'], 地支十神: d['地支十神'],
      // 性运 = 日主坐大运地支的十二长生 (app 大运表有这行; 解读时别自己重算)
      性运: d['性运'] || null,
      // 查法真源: 大运互动命中的 rule id (忌神引动/冲月令…), 模型据此写「得/失」, 不自创
      互动命中: d['互动命中'] || [],
    })),
    流年: years.map((y) => ({
      年份: y['年份'], 干支: y['干支'], 天干十神: y['十神'], 地支十神: y['地支十神'],
      年龄: by ? Number(y['年份']) - by : null,
    })),
    当前年份: now,
  };
}

/** 分段解读的一次请求提示。 */
export function buildSectionPrompt(chart, sec) {
  const ctx = chartContext(chart);
  const tl = timelineContext(chart, { dayn: null, fromYear: null });
  const parts = [
    '你是深谙子平八字的中式命理师。下面【排盘 JSON】是已排好的真命盘, 直接采用, 不要推翻。',
    '你这次**只写一节**: 《' + sec.title + '》。',
    sec.ask,
  ];
  if (YINGQI_KEYS.has(sec.key)) {
    parts.push(YINGQI_RULE);
    parts.push(EXCLUDE_RULE);
  }
  // 篇幅从 SPEC 出 (2026-10-31): 提示词要的字数与这一项的预算上限同源,
  // 不再是两处各写各的 —— 以前「篇幅」硬编码在这行、「预算」硬编码在 BUDGET,
  // 改一处忘另一处就会漂。
  const _spec = SPEC.section[sec.key] || SPEC.section.summary;
  parts.push('篇幅: ' + _spec.ask + '。');
  parts.push(RULES);
  parts.push('【排盘 JSON】\n' + JSON.stringify(Object.assign({}, ctx, tl), null, 1));
  return parts.join('\n\n');
}

/**
 * 逐项批语的目标清单 —— 每条批语针对**一个具体对象**, 不是一篇通论。
 *
 * 分组: 大运 / 流年 / 刑冲合害 / 用神。
 * 返回的每一项都自带 id / 分组 / 标签 / 提问, 页面据此一行行渲染、一项项请求。
 */
export function buildNoteTargets(chart) {
  const by = Number(chart.input && chart.input.year) || 0;
  const now = new Date().getFullYear();
  const age = by ? now - by : 0;
  const dayun = (chart.dayun && chart.dayun['列表']) || [];
  const liunian = chart.liunian || [];
  const notes = [];

  // 每条批语的预算从**它自己那一组**的规格来 (2026-10-31)。
  // 四组的思考用量差 2.5 倍 (实测 reasoning: 用神 644 / 大运 701 / 流年 719 /
  // 刑冲合害 1609) ⇒ 写死一个数必然对某组太宽、对某组撞墙。
  const _budgetOfGroup = (group) => budgetOf(SPEC.note[group] || SPEC.note['用神']);

  // ① 大运: 当前这一步 + 后面两步
  const cur = dayun.find((d) => now >= Number(d['起始年份']) && now < Number(d['起始年份']) + 10)
    || dayun[0] || null;
  const curIdx = cur ? dayun.indexOf(cur) : 0;
  const picked = dayun.slice(Math.max(0, curIdx), Math.max(0, curIdx) + 3);
  picked.forEach((d, i) => {
    const isCur = i === 0;
    notes.push({
      id: 'dayun-' + d['干支'],
      group: '大运',
      label: '大运 ' + d['干支'] + ' (' + d['起始年份'] + '-' + (Number(d['起始年份']) + 9) + ')',
      chip: isCur ? '当前大运' : '第' + (i + 1) + '步',
      budget: _budgetOfGroup('大运'),
      ask: '针对【' + d['干支'] + '大运】写一条批语, 说清三件事: '
        + '① 这十年主导什么主题(由天干' + (d['十神'] || '') + '、地支' + (d['地支十神'] || '') + '引动哪处宫位/十神决定); '
        + '② 这个阶段最该做成的事; '
        + '③ 最该避开的坑。'
        + (isCur ? '这是命主**当下正在走**的运, 要落到他这个年龄(现 ' + age + ' 岁)眼下该怎么办。' : ''),
    });
  });

  // ② 流年: 从今年起六年的应期批语 —— 八字最值钱的就是这一层
  liunian.filter((y) => Number(y['年份']) >= now && Number(y['年份']) <= now + 5).forEach((y) => {
    const yr = Number(y['年份']);
    notes.push({
      id: 'year-' + yr,
      group: '流年',
      label: yr + ' ' + y['干支'] + ' (' + (yr - by) + ' 岁)',
      chip: y['十神'] || '',
      budget: _budgetOfGroup('流年'),
      ask: '针对【' + yr + ' ' + y['干支'] + '年】写一条批语。'
        + '必须自己判断该流年干支与命局哪处宫位/十神形成了冲、合、刑或害(命局原局的冲合刑害见 JSON), '
        + '然后说清: 这一年**哪个领域会动**、会动出什么性质的事(成/破/聚/散)、以及要防什么。'
        + '再补一句这一年**确定不会**发生什么(年龄层 + 扳机层各一句)。',
    });
  });

  // ③ 刑冲合害: 逐条关系一条批语
  const rels = [
    ['chong', '冲', chart.chong], ['he', '合', chart.he],
    ['hai', '害', chart.hai], ['xing', '刑', chart.xing], ['po', '破', chart.po],
  ];
  rels.forEach(([kind, label, arr]) => {
    (arr || []).forEach((txt, i) => {
      notes.push({
        id: 'rel-' + kind + '-' + i,
        group: '刑冲合害',
        label: label + ' · ' + txt,
        chip: label,
        budget: _budgetOfGroup('刑冲合害'),
        ask: '针对命局这一处【' + label + '】(' + txt + ')写一条批语: '
          + '① 这处关系具体牵着哪两个宫位/十神; '
          + '② 它在人生里通常怎么应(什么时候被引动、动的是什么事); '
          + '③ 日常怎么化解或怎么跟它相处。',
      });
    });
  });

  // ④ 用神调剂
  notes.push({
    id: 'yong',
    group: '用神',
    label: '喜用神 ' + (chart.xi_yong || []).join('') + ' / 忌神 ' + (chart.ji_shell || []).join(''),
    chip: '调理',
    budget: _budgetOfGroup('用神'),
    ask: '针对这张盘的喜忌写一条批语: 用神是什么、为什么是它(引旺衰依据)、忌神为什么耗它; '
      + '以及日常怎么补用神、怎么避忌神(颜色、方位、作息、行业、人际取舍各给一点)。要具体, 不讲玄虚。',
  });

  return notes;
}

/** 批语的一次请求提示。 */
export function buildNotePrompt(chart, note) {
  const ctx = chartContext(chart);
  const tl = timelineContext(chart, {
    fromYear: note.group === '流年' ? Number(String(note.id).replace('year-', '')) - 1 : null,
  });
  const years = (tl['流年'] || []).filter((y) => String(note.id) === 'year-' + y['年份']);
  const years2 = years.length ? years : (tl['流年'] || []).slice(0, 2);
  const dayun = (tl['大运'] || []).slice(0, 3);
  // 篇幅从 SPEC 出 (同 buildSectionPrompt) —— 提示词与预算同源。
  const _spec = SPEC.note[note.group] || SPEC.note['用神'];
  return [
    '你是深谙子平八字的中式命理师。下面【排盘 JSON】是已排好的真命盘, 直接采用, 不要推翻。',
    '你这次**只写一条批语**, 针对: ' + note.label + (note.chip ? ' (' + note.chip + ')' : ''),
    note.ask,
    '篇幅: ' + _spec.ask,
    RULES,
    '【排盘 JSON】\n' + JSON.stringify(Object.assign({}, ctx, {
      相关大运: dayun, 相关流年: years2,
    }), null, 1),
  ].join('\n\n');
}
