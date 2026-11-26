/**
 * 64i/bagua_annotations/task_judge.js
 * 六格判局 —— 把「生彼泻克耗」从「排盘的附属」提成「通用判局内核」
 *
 * 起因 (老板 2026-10-21 原话, 一字不改):
 *   「就拿八字排盘, 其实都是规律结合变化形成的生彼泻克耗, 但是这用在项目上,
 *     加强了停顿, 走一步判断一步, 而且挂永远没有100%」
 *
 * 老板自己给的那张表 (唯一真源, 不重抄不改名):
 *   生 : 生我者
 *   彼 : 我自己
 *   泻 : 我生者
 *   克 : 克我者
 *   耗 : 耗费我精力的
 *
 * 盘古原来只有「排盘 → 六格」这一条路: `bazi_calc` 算完盘, 顺带把六格算出来。
 * 于是这套内核**只能用于八字**。老板要的「这用在项目上」—— 用在一件事、一个项目、
 * 一个决策上 —— 盘古**没有入口**。这一层就是那个入口。
 *
 * 分工纪律 (跟 bazi_calc / wuxing_strength 同一个分法):
 *   调用方(模型)负责**取数** —— 列出这一件事当下的资源/产出/阻力/要啃的/平级。
 *   本模块负责**判据** —— 分档、定性、给停点。
 * 模型不许自己下结论: 它只能列条目, 「强/弱/不成立」和「停/换向/续」由内核算。
 * (同 `wuxing_strength.js`: 排盘是 `bazi_calc.py` 的事, 六格是本层的活。)
 *
 * 三态的出处 (与 wuxing_strength.js 同源, 不另立一套):
 *   强 / 弱 / 不成立 —— `wuxing_strength.js` 的 STRENGTH。
 *   档位阈值借用课件原文「五行过强: 该五行在四柱中有 3 个及以上个」
 *   与「五行过弱: …或者四柱里没有这个五行」(= 不存在, 不是弱)。
 *   ⚠️ **这是结构借用, 不是命理判据**: 任务没有四柱, 这里的「个数」是调用方
 *   列出的**条目数**。借用的是「档位怎么分」, 不是「这个任务有多旺」。
 *   谁要把这层当命理用, 那是越界 —— 本模块只做「一件事此刻的形状」。
 *
 * 停点规则 (老板「加强了停顿, 走一步判断一步」; 规则表见 decision.md §五):
 *   S1 空转 : 生我者=不成立 且 我克者=不成立 → **停**
 *              (饿着 + 空转, 做多少泄多少 —— decision.md §五 原文)
 *   S2 压顶 : 克我者=强 且 我生者=不成立 且 非 S1 → **换向**
 *              (挡着、还没产出、但手上还有料或还有能啃的 → 先解阻力)
 *   其余    → **续**
 *   任一格 = 不成立 → **不是失败**, 是状态转移。所以这套判据没有「判不出来」的态:
 *   每一格永远有值, 只有「输入不足」才是真的判不出来 (见 NO_INPUT)。
 *
 * 「挂永远没有100%」—— 这条是**硬约束**, 不是免责声明文案:
 *   - 判据不足 (调用方什么都没列) → 拒绝给结论 (NO_INPUT), 不许拿「全是空」反推出「停」。
 *   - 输出永远带 disclaimer, 且强度是三态不是连续分数 —— 没有 80 分这回事。
 */

'use strict';

// ============================================================
// 常量
// ============================================================

/** 三态 —— 与 wuxing_strength.js 的 STRENGTH 同名同值, 不另造一套 */
const STATE = {
  STRONG: 'strong',
  WEAK: 'weak',
  NOT_ESTABLISHED: 'not_established',
};

const STATE_LABEL = {
  strong: '强',
  weak: '弱',
  not_established: '不成立',
};

/**
 * 档位阈值 —— 借用 wuxing_strength.js 的旺衰阈值 (课件原文)
 *   过强: 该五行在四柱中有 3 个及以上个
 *   不存在: 四柱里没有这个五行 (= 不成立, 不是弱)
 */
const STRONG_THRESHOLD = 3;

/**
 * 六格定义 —— 术数名 (老板的表) + 任务语义 (本层给的对应)
 * field = 调用方填条目的参数名
 */
const CELLS = [
  {
    key: 'sheng', shuxing: '生我者', alias: '生', field: 'resources',
    meaning: '手上的助力: 已经握到、能直接拿来用的资源/信息/权限/人手',
  },
  {
    key: 'xie', shuxing: '我生者', alias: '泄', field: 'outputs',
    meaning: '已经产出的东西: 这一路上真正落到纸面的产出',
  },
  {
    key: 'ke', shuxing: '克我者', alias: '克', field: 'blockers',
    meaning: '挡在路上的阻力: 压住这件事、让它推不动的因素',
  },
  {
    key: 'hao', shuxing: '我克者', alias: '耗', field: 'targets',
    meaning: '要主动啃的: 得花我精力的目标/难点 (老板: 「耗费我精力的」)',
  },
  {
    key: 'tong', shuxing: '同我者', alias: '比', field: 'peers',
    meaning: '平级/协作: 与我同类或并行的存在',
  },
];

/** 彼 = 我自己 = 这件事本身。不参与分档, 只做主体。 */
const BI = { key: 'bi', shuxing: '彼', alias: '彼', meaning: '这件事本身 (主体)' };

/**
 * ★ 停点规则**实际读过**的格 —— 数据化的唯一真源。
 *
 *   2026-10-22 实跑当场查出来的坑:
 *     `同我者`(peers) 在 CELLS 里, 会算 state、会出现在输出里, 但 S1/S2 两条规则
 *     **从头到尾没读过它** —— 实测 peers 从 1 条加到 5 条(档位 weak→strong),
 *     verdict 一点没变。可模型看见输出里的「同我者: 强」, 会以为它在左右结论,
 *     于是认真填一堆平级协作 —— 白填, 而且污染了它对判据的理解。
 *
 *   为什么数据化: 这跟 `yao_layer_boundary` 的 `LAYER_BOUNDARY` 同一个道理 ——
 *     注释写「peers 不参与」而下一个人照着改规则时会以为漏了, 反过来删规则时
 *     又没人知道它本来就不参与。写成数据 + 自检钉住, 才吵不起来。
 */
const VERDICT_INPUTS = new Set(['sheng', 'xie', 'ke', 'hao']);

// ============================================================================
// 进度判局 (2026-10-23 第 59 批)
// ============================================================================
//
// ## 为什么要有这一层
//
// 老板 10-21 原话: 「加强停顿, 走一步判断一步, 而且挂永远没有100%」。
// 任务判局(judgeTask)答的是「**这件事**该续还是该停」——
//   但它只由模型**主动调 wuxing_judge** 时才发生。实测(2026-10-23):
//   7940 个会话账本里只有 3 个提到 wuxing_judge, 运行日志里 0 次。
//   ⇒ **长任务上的「停顿」是空的**: 机制在, 但从不触发。
//
// 任务判局答的是「这件事的性质」, 进度判局答的是「**这一刀**干到哪儿了」。
// 后者每天都在发生 —— 每个 task_done 都有一次。
// 所以进度判局挂在 task_done 上: **不问「做完没有」, 问「现在哪个格填得上」**
// (decision.md §五 的原话)。
//
// ## 两者共用三态与六格, 但规则各是一套
//
// 术数名(生我者/我生者/克我者/我克者/同我者)与三态(强/弱/不成立)是**共用的**,
// 档位算法是**共用的**(见 _computeCells)。
// 但**读哪几格、怎么读, 两条规则不一样** —— 所以分表:
//   VERDICT_INPUTS        = 任务判局读的四格
//   PROGRESS_VERDICT_INPUTS = 进度判局读的三格
// 混成一张表 = 下一个人改规则时不知道自己在改哪条。
//
// ## 档位名的取舍
//
// 进度判局**不复用** stop/redirect/continue 那三个名字:
//   stop 在任务判局里是「没活可干了, 别往下冲」;
//   在进度判局里「本刀收口」是**正常完成**, 不是「停」。
// 名字一样意思不一样 = 语义漂移, 而 stop_point.js 明确要求档位严格同名。
// 所以进度用自己的一套: closed(收口) / open(还有活) / redirect(先解阻力)。

/**
 * 进度判局的档位 —— 与任务判局**不同名**, 语义不重叠。
 */
const PROGRESS_VERDICT = {
  CLOSED: 'closed',      // 本刀没有要续的了 —— 收口
  OPEN: 'open',          // 还有本刀范围内的活 —— 续
  REDIRECT: 'redirect',  // 还有活, 但被阻力压着 —— 先解阻力别再堆料
};

const PROGRESS_VERDICT_LABEL = {
  closed: '收口',
  open: '续',
  redirect: '换向',
};

/**
 * 进度规则 —— **数据化**, 顺序敏感, 先判到的先赢。
 *
 * 为什么数据化 (同 CELLS / VERDICT_INPUTS 的理由):
 * 写成 if/else 链的话, 下一个想加一条规则的人不知道该加在哪、
 * 也不知道加了之后哪几格变成了「影响判定」—— 于是表和代码各说一套,
 * 而且安静地不一致。
 */
const PROGRESS_RULES = [
  {
    key: 'P_REDIRECT',
    verdict: PROGRESS_VERDICT.REDIRECT,
    // 跟任务判局 S2 同形: 阻力压顶(强) + 还没产出 + 还有活 ⇒ 先解阻力。
    // 差别只在多一条「还有活」—— 进度上「没产出」但「没活可干」是收口, 不是换向。
    when: (c) => c.ke === STATE.STRONG && c.xie === STATE.NOT_ESTABLISHED && c.hao !== STATE.NOT_ESTABLISHED,
    reason: '阻力压顶: 克我者(阻力)强 而 我生者(产出)不成立, 且还有活没干。',
    next_step: '先解克我者(阻力) —— 把挡住的那几条拆掉; 解开一个再回头推我生者(产出)。',
  },
  {
    key: 'P_OPEN',
    verdict: PROGRESS_VERDICT.OPEN,
    when: (c) => c.hao !== STATE.NOT_ESTABLISHED,
    reason: '还有活: 我克者(还要主动啃的)不成立 ⇒ 本刀范围内仍有未做的事。',
    next_step: '按我克者(还要主动啃的)接着走, 走一步判断一步 —— 下一轮再判一次。',
  },
  {
    key: 'P_CLOSED',
    verdict: PROGRESS_VERDICT.CLOSED,
    when: (c) => c.hao === STATE.NOT_ESTABLISHED && c.xie !== STATE.NOT_ESTABLISHED,
    reason: '收口: 我克者(还要主动啃的)不成立, 而我生者(已落地产出)有东西 ⇒ 本刀没有要续的了。',
    next_step: '本刀该做的做完了。收口交回, 别自动往下冲。',
  },
];

/**
 * 进度判局实际读了哪几格 —— 与 PROGRESS_RULES 一一对应, 装时自检双向验证。
 *   sheng(生我者/助力): 进度上不问「手上有没有料」—— 收不收口看的是
 *     「有没有要啃的」和「有没有产出」, 助力多少不改变这两个判断。
 *   tong(同我者/平级):  同任务判局, 算了档位但规则从不读它。
 */
const PROGRESS_VERDICT_INPUTS = new Set(['xie', 'ke', 'hao']);

/**
 * 出处标识 —— **不能是文件名**。
 * 2026-10-21 实跑教训 (wuxing_strength.js 里同款): 出处写文件名, 模型就满世界
 * find/grep 这个文件 (43~48 次 exec_command, 第一轮没跑出 final)。
 * 出处是给**人**查证用的, 不是给模型执行的任务。
 */
const SOURCE_LABEL = '六格判局(生彼泻克耗 + 易经课程资料·五行旺衰档位)';

/**
 * 任务语义对应(meaning)的身份标签 —— 2026-10-22 第 46 批加。
 *
 * 为什么必须标: 这一层有两样东西混在一起, 出处完全不同:
 *   ① `shuxing`(生我者/我生者/克我者/我克者/同我者) —— **术数名**, 有《三命通会》根
 *      (「生我者壬癸水,我生者丙丁火,克我者庚辛金,我克者戊己土」) ⇒ sourced
 *   ② `meaning`(手上的助力/已经产出的东西/挡在路上的阻力/要主动啃的/平级协作)
 *      —— **任务语义的对应**, 来自老板 10-22 亲自给的表 + 课程整合
 *      ⇒ interpretive(解读框架), 不冒充典籍原文
 *
 * 不标的后果: 模型看到「克我者: 挡在路上的阻力」会当成典籍断语讲出去。
 * 老板原话其实已经点明这层是**他自己的表**:
 *   「生: 生我者 / 彼: 我自己 / 泻: 我生者 / 克: 克我者 / 耗: 耗费我精力的」
 * —— 这是他给的**术数名与任务义的对应**, 不是引自某部书。
 *
 * ⚠️ 标签放**整组 meaning 之前**说明一次, 不逐格挂:
 *   六格都挂一遍 = 六份噪音, 模型会麻木 —— 挂多了跟没挂一样。
 */
const MEANING_TAG = '〔任务语义对应, 非典籍原文〕';

const DISCLAIMER = '卦与术数从不给 100% —— 这是结构参考, 不是断言。';

// ============================================================
// 内部工具
// ============================================================

/**
 * 条目归一 —— **去重**, 而且**如实报出去**。
 *
 * ⚠️ 为什么必须去重 (2026-10-22 实跑当场抓到的洞):
 *   阈值是「≥3 条记强」, 而条数是**调用方(模型)填的**。
 *   不去重 ⇒ 模型把**同一条阻力写三遍**就凑成「强」, 凭空造出 S2 换向:
 *     judgeTask({resources:['余力'], outputs:[], blockers:['缺测试环境','缺测试环境','缺测试环境'], ...})
 *     → 克我者=strong → verdict='redirect'
 *   这等于**判据被入参灌水绕过** —— 而模型正是那个既想续、又想显得在推理的角色。
 *
 *   课件原句是「五行过强: 该五行在**四柱中**有 3 个及以上个」。
 *   四柱里三见同一五行 = **三个不同位置**; 任务里同一句话写三遍 = **一件事**。
 *   所以「借用档位怎么分」必须连带借用「按不同条目数」, 否则借来的就是半个判据。
 *
 * ⚠️ **去重不许静默**: 原始条数、去掉的重复、留下的条目全给出去。
 *   静默去重 = 模型不知道自己填的 3 条被当成 1 条, 下轮它会以为判据有 bug。
 *   (同「口径跟着数据走」: 变化必须让调用方看得见。)
 */
function _asItems(v) {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  const seen = new Map();   // 归一串 → 首次出现的原样
  for (const x of arr) {
    if (x === undefined || x === null) continue;
    const s = String(x).trim();
    if (!s) continue;
    // 归一: 压掉内部连续空白, 让「缺测试环境」与「缺 测试 环境」判成同一条。
    // 只压空白、**不改字** —— 改字会把真的两条合成一条, 那是另一种造假。
    const k = s.replace(/\s+/g, ' ');
    if (seen.has(k)) continue;
    seen.set(k, s);
    out.push(s);
  }
  return out;
}

/** 归一**前**的条数 —— 只数非空条目, 与去重规则保持同一把尺子 */
function _rawCount(v) {
  if (v === undefined || v === null) return 0;
  const arr = Array.isArray(v) ? v : [v];
  let n = 0;
  for (const x of arr) {
    if (x === undefined || x === null) continue;
    if (String(x).trim()) n++;
  }
  return n;
}

/** 档位: 0 → 不成立, 1~2 → 弱, ≥3 → 强 */
function _stateOf(count) {
  if (count <= 0) return STATE.NOT_ESTABLISHED;
  if (count >= STRONG_THRESHOLD) return STATE.STRONG;
  return STATE.WEAK;
}

/**
 * 六格计算 —— **judgeTask 与 judgeProgress 共用的唯一实现**。
 *
 * 为什么抽出来: 进度判局(judgeProgress)与任务判局(judgeTask)问的是两个问题,
 * 但「某格是强是弱」这个算法必须是**同一把尺子**。
 * 两份各写一遍 = 阈值会漂 (改了一处另一处不变) —— 盘古 2026-10-21 亲自踩过
 * 「两份同义文本各改各的」, 这里不给它第二次机会。
 */
function _computeCells(s) {
  const cells = {};
  let total = 0;
  let droppedTotal = 0;
  for (const c of CELLS) {
    const rawCount = _rawCount(s[c.field]);
    const items = _asItems(s[c.field]);
    const dropped = rawCount - items.length;
    if (dropped > 0) droppedTotal += dropped;
    total += items.length;
    cells[c.key] = {
      shuxing: c.shuxing,
      alias: c.alias,
      meaning: c.meaning,
      count: items.length,
      state: _stateOf(items.length),
      state_label: STATE_LABEL[_stateOf(items.length)],
      items,
      // ★ 归一必须**如实出参**: 模型填 3 条被判成 1 条时, 得让它知道为什么。
      //   input_count 是它填的条数, dropped 是被去掉的重复 —— 两者都在, 它能自查。
      input_count: rawCount,
      dropped_duplicates: dropped,
      // ★ 明写这一格**参不参与**停点判定 (peers 就是个坑: 算了档位但规则从不读它,
      //   模型看见「同我者: 强」会以为它在左右结论, 于是白填一堆平级协作)。
      affects_verdict: VERDICT_INPUTS.has(c.key),
    };
  }
  return { cells, total, droppedTotal };
}

// ============================================================
// 主判定
// ============================================================

/**
 * 对「一件事」出六格判局。
 *
 * @param {object} spec
 * @param {string} spec.subject      这件事 (彼)。必填。
 * @param {string[]} [spec.resources] 生我者: 助力
 * @param {string[]} [spec.outputs]   我生者: 已产出
 * @param {string[]} [spec.blockers]  克我者: 阻力
 * @param {string[]} [spec.targets]   我克者: 要啃的
 * @param {string[]} [spec.peers]     同我者: 平级/协作
 * @returns {object} 判局结果。判不出来时 ok:false 且**不给结论**。
 */
function judgeTask(spec) {
  const s = spec || {};
  const subject = String(s.subject || '').trim();
  if (!subject) {
    return {
      ok: false,
      error: { code: 'NO_SUBJECT', message: '没给「这件事是什么」(彼), 判不了' },
    };
  }

  const cells = {};
  let total = 0;
  let droppedTotal = 0;
  for (const c of CELLS) {
    const rawCount = _rawCount(s[c.field]);
    const items = _asItems(s[c.field]);
    const dropped = rawCount - items.length;
    if (dropped > 0) droppedTotal += dropped;
    total += items.length;
    cells[c.key] = {
      shuxing: c.shuxing,
      alias: c.alias,
      meaning: c.meaning,
      count: items.length,
      state: _stateOf(items.length),
      state_label: STATE_LABEL[_stateOf(items.length)],
      items,
      // ★ 归一必须**如实出参**: 模型填 3 条被判成 1 条时, 得让它知道为什么。
      //   input_count 是它填的条数, dropped 是被去掉的重复 —— 两者都在, 它能自查。
      input_count: rawCount,
      dropped_duplicates: dropped,
      // ★ 明写这一格**参不参与**停点判定 (peers 就是个坑: 算了档位但规则从不读它,
      //   模型看见「同我者: 强」会以为它在左右结论, 于是白填一堆平级协作)。
      affects_verdict: VERDICT_INPUTS.has(c.key),
    };
  }

  // 「什么都没列」不等于「六格都不成立」。
  // 前者是**输入不足**, 拿它反推出「停」是拿空数据当结论 —— 正是老板说的「永远没有100%」。
  if (total === 0) {
    return {
      ok: false,
      subject,
      error: {
        code: 'NO_INPUT',
        message: '六格一个条目都没列 —— 判据不足, 不给结论。'
          + '先把手上有什么/产出了什么/挡着什么/要啃什么列出来。',
      },
    };
  }

  const sheng = cells.sheng.state;
  const xie = cells.xie.state;
  const ke = cells.ke.state;
  const hao = cells.hao.state;

  // ── 停点规则 (顺序敏感, 先判 S1) ──
  let verdict, stop_reason, next_step;
  if (sheng === STATE.NOT_ESTABLISHED && hao === STATE.NOT_ESTABLISHED) {
    // S1 空转: 饿着 + 没有能啃的 → 继续下去只是空转
    verdict = 'stop';
    stop_reason = '空转: 生我者(助力)不成立 且 我克者(可攻克项)不成立 —— '
      + '手上没料、要啃的也没有, 再做只是做多少泄多少。';
    next_step = '先把助力(生我者)补上, 或换一件啃得动的事(我克者); 现在的停不是失败, 是状态转移。';
  } else if (ke === STATE.STRONG && xie === STATE.NOT_ESTABLISHED) {
    // S2 压顶: 挡着 + 还没产出 + (还有料或还有能啃的) → 换向, 不是死磕
    verdict = 'redirect';
    stop_reason = '阻力压顶: 克我者(阻力)强 而 我生者(产出)不成立 —— '
      + '还在被外部约束拖着, 这时候硬推产出推不出来。';
    next_step = '先解克我者(阻力) —— 把挡住的那几条拆掉; 解开一个再回头推我生者(产出)。';
  } else {
    verdict = 'continue';
    stop_reason = '不停: ' + [
      sheng === STATE.NOT_ESTABLISHED ? '助力不足' : '有助力',
      hao === STATE.NOT_ESTABLISHED ? '无明确可攻克项' : '有可攻克项',
      xie === STATE.NOT_ESTABLISHED ? '尚无产出' : '已有产出',
    ].join(' / ') + '。';
    next_step = '按我克者(可攻克项)接着走, 走一步判断一步 —— 下一轮再判一次六格。';
  }

  return {
    ok: true,
    subject,
    bi: { shuxing: BI.shuxing, alias: BI.alias, meaning: BI.meaning, subject },
    cells,
    // 第 46 批: 任务语义对应(meaning)的身份说明, 跟着数据出参。
    //   为什么单独给一段而不是给每个格挂标签: 六格都挂 = 六份噪音 = 模型麻木。
    //   为什么必须给: `shuxing`(生我者/我生者/…)是**术数名**, 有《三命通会》根;
    //   但 `meaning`(助力/产出/阻力/目标/平级)是**任务语义对应**, 来自老板给的表
    //   + 课程整合 —— 不标身份, 模型会当典籍断语讲出去。
    meaning_basis: {
      tag: MEANING_TAG,
      note: '六格的 `shuxing`(生我者/我生者/克我者/我克者/同我者)是**术数名**, '
        + '有《三命通会》根; 但各格的 `meaning`(助力/产出/阻力/目标/平级协作)与 `bi.meaning`'
        + '是**任务语义对应**(老板 10-22 给的表 + 课程整合), 不是典籍断语; '
        + '引用时当「解读框架」讲, 别当原句引。',
    },
    // 停点规则实际只读这四格 —— 明写出来, 别让模型以为六格都参与判定。
    verdict_reads_cells: Array.from(VERDICT_INPUTS),
    // 本次因重复条目被去掉的条数 (0 = 调用方没有灌水)
    dropped_duplicates_total: droppedTotal,
    verdict,                      // 'stop' | 'redirect' | 'continue'
    verdict_label: verdict === 'stop' ? '停' : (verdict === 'redirect' ? '换向' : '续'),
    stop_reason,
    next_step,
    thresholds: {
      strong: '≥' + STRONG_THRESHOLD + ' 条记强 (借用课件「五行过强: 3 个及以上个」)',
      weak: '1~2 条记弱',
      not_established: '0 条记不成立 (课件: 四柱里没有这个五行 = 不存在, 不是弱)',
    },
    disclaimer: DISCLAIMER,
    source: SOURCE_LABEL,
  };
}

// ============================================================
// 进度判局
// ============================================================

/**
 * 对「这一刀干到哪儿了」出进度判局。
 *
 * 与 judgeTask 的区别只有一处: **规则换了一套**, 三态和六格是共用的。
 * 槽位语义在进度语境下读作:
 *   生我者 resources = 手上的助力
 *   我生者 outputs   = 已落地的产出
 *   克我者 blockers  = 挡着这事的阻力
 *   我克者 targets   = 还要主动啃的(本刀范围内没做完的)
 *   同我者 peers     = 平级协作
 *
 * @param {object} spec  同 judgeTask 的入参形状
 * @returns {object} ok:true 时带 verdict(cells 形状); 判不出来时 ok:false 且不给结论
 */
function judgeProgress(spec) {
  const s = spec || {};
  const subject = String(s.subject || '').trim();
  if (!subject) {
    return {
      ok: false,
      error: { code: 'NO_SUBJECT', message: '没给「这一刀是什么」(彼), 判不了' },
    };
  }

  const { cells, total, droppedTotal } = _computeCells(s);

  // 「什么都没列」不等于「六格都不成立」。
  // 前者是**输入不足**, 拿它反推出「收口」是拿空数据当结论 ——
  // 正是老板说的「永远没有100%」: 没有证据时, 不许给结论。
  if (total === 0) {
    return {
      ok: false,
      subject,
      error: {
        code: 'NO_INPUT',
        message: '六格一个条目都没列 —— 判据不足, 不给结论。',
      },
    };
  }

  const states = {
    sheng: cells.sheng.state,
    xie: cells.xie.state,
    ke: cells.ke.state,
    hao: cells.hao.state,
  };

  let hit = null;
  for (const r of PROGRESS_RULES) {
    if (r.when(states)) { hit = r; break; }
  }

  // 落空 = 「既没有要啃的, 也没有产出」⇒ 判不出来, 不给结论。
  // 这跟任务判局的 NO_INPUT 是同一条纪律: 宁可不给结论, 也不拿空数据当结论。
  if (!hit) {
    return {
      ok: false,
      subject,
      cells,
      error: {
        code: 'NO_CONCLUSION',
        message: '既没有「还要主动啃的」, 也没有「已落地的产出」—— 判据不足, 不给结论。',
      },
    };
  }

  return {
    ok: true,
    subject,
    bi: { shuxing: BI.shuxing, alias: BI.alias, meaning: BI.meaning, subject },
    cells,
    meaning_basis: {
      tag: MEANING_TAG,
      note: '进度判局与任务判局共用六格三态; 判据是**术数名 + 任务语义对应**, '
        + '不是典籍断语。',
    },
    verdict_reads_cells: Array.from(PROGRESS_VERDICT_INPUTS),
    dropped_duplicates_total: droppedTotal,
    verdict: hit.verdict,
    verdict_label: PROGRESS_VERDICT_LABEL[hit.verdict] || hit.verdict,
    rule_key: hit.key,
    stop_reason: hit.reason,
    next_step: hit.next_step,
    thresholds: {
      strong: '≥' + STRONG_THRESHOLD + ' 条记强 (借用课件「五行过强: 3 个及以上个」)',
      weak: '1~2 条记弱',
      not_established: '0 条记不成立 (课件: 四柱里没有这个五行 = 不存在, 不是弱)',
    },
    disclaimer: DISCLAIMER,
    source: SOURCE_LABEL,
  };
}

// ============================================================
// 装时自检
// ============================================================

function _assertTaskJudgeLayer() {
  const problems = [];
  if (CELLS.length !== 5) problems.push('六格应含生我者/我生者/克我者/我克者/同我者 5 格, 实为 ' + CELLS.length);
  const keys = new Set(CELLS.map(c => c.key));
  for (const k of ['sheng', 'xie', 'ke', 'hao', 'tong']) {
    if (!keys.has(k)) problems.push('缺格: ' + k);
  }
  if (STRONG_THRESHOLD !== 3) problems.push('强档阈值应与课件一致 (3 个及以上), 实为 ' + STRONG_THRESHOLD);
  // 停点规则依赖的两格必须存在
  for (const k of ['sheng', 'hao', 'ke', 'xie']) {
    if (!keys.has(k)) problems.push('停点规则依赖的格不存在: ' + k);
  }

  // ★ VERDICT_INPUTS 必须与**规则实际读了什么**一致 —— 用行为证明, 不靠注释。
  //
  //   做法: 把每一格在几组底稿上从 0 条扫到 3 条(= 三档全过),
  //   记录 verdict 是否**曾经**变过。然后要求:
  //     「verdict 变过」 ⟺ 「这一格在 VERDICT_INPUTS 里」
  //
  //   为什么必须这么验 (这道判据是**双向**的):
  //     · 反向(本条): 有人把 peers 加进规则、却忘了更新 VERDICT_INPUTS ⇒
  //       扫 peers 时 verdict 会变, 但表里说它不影响 ⇒ 自检当场报出来。
  //       2026-10-22 那个「算了档位但规则从不读它」的洞, 就是靠这条钉住的。
  //     · 正向: 有人把某格从规则里删掉、却忘了从 VERDICT_INPUTS 里删 ⇒
  //       扫那格 verdict 永远不变, 但表里说它影响 ⇒ 也报出来。
  //   只靠注释的话, 两边会各说一套, 而且**安静地**不一致。
  const BASES = [
    { resources: [], outputs: [], blockers: [], targets: [], peers: [] },
    { resources: ['a'], outputs: [], blockers: ['b'], targets: ['c'], peers: [] },
    { resources: ['a'], outputs: [], blockers: ['b', 'c', 'd'], targets: [], peers: [] },
    { resources: [], outputs: ['x'], blockers: ['b', 'c', 'd'], targets: ['e'], peers: [] },
    { resources: ['a'], outputs: [], blockers: [], targets: ['e'], peers: [] },
    // ⚠️ 这两组**必须**填 peers。第一版底稿全是 `peers: []`, 于是
    //   「往规则里加一条 peers 条件」只会让规则**永远不成立** ⇒ 死的是别的格,
    //   报错指向 ke/xie 而不是 peers, 咬得歪。
    //   (第一版实测就是这样: 注入 peers 条件后自检红了, 但说的是「克我者不影响了」)
    //   底稿填了 peers, 加进去的 peers 条件才**可达**, 自检才会指着 peers 报。
    { resources: ['a'], outputs: [], blockers: ['b', 'c', 'd'], targets: ['e'], peers: ['p', 'q', 'r'] },
    { resources: [], outputs: [], blockers: [], targets: [], peers: ['p', 'q', 'r'] },
  ];
  for (const c of CELLS) {
    let changed = false;
    for (const base of BASES) {
      const verdicts = new Set();
      for (const n of [0, 1, 3]) {
        const spec = Object.assign({ subject: '自检' }, base);
        spec[c.field] = n === 0 ? [] : Array.from({ length: n }, (_, i) => c.key + '-项' + i);
        const r = judgeTask(spec);
        if (r.ok) verdicts.add(r.verdict);
      }
      if (verdicts.size > 1) changed = true;
    }
    const declared = VERDICT_INPUTS.has(c.key);
    if (declared && !changed) {
      problems.push(
        '「' + c.shuxing + '」在 VERDICT_INPUTS 里(声称影响判定), '
        + '但把它从 0 条扫到 3 条, verdict 从来没变过 —— 规则已经不读它了, 表没跟上'
      );
    }
    if (!declared && changed) {
      problems.push(
        '「' + c.shuxing + '」不在 VERDICT_INPUTS 里(声称不影响判定), '
        + '但扫它的条数时 verdict 变了 —— 规则已经读它了, 表没跟上 '
        + '(输出里的 affects_verdict=false 就是在骗模型)'
      );
    }
  }

  // ★ 进度判局同规格的自检: PROGRESS_VERDICT_INPUTS 也必须与
  //   「规则实际读了什么」一致 —— 用行为证明, 不靠注释。
  //
  //   与任务判局那套同形, 但**底稿要换**: 进度规则读的是
  //   「有没有要啃的 / 有没有产出」, 所以底稿必须先有 outputs 或 targets,
  //   否则「加一条 sheng 条件」永远不成立 ⇒ 死的是别的格, 报错指向错的地方。
  //   (任务判局那版第一版就栽在 peers 底稿全空上, 这里别重犯。)
  const PROGRESS_BASES = [
    { resources: [], outputs: ['x'], blockers: [], targets: [], peers: [] },
    { resources: [], outputs: [], blockers: [], targets: ['e'], peers: [] },
    { resources: [], outputs: ['x'], blockers: ['b', 'c', 'd'], targets: ['e'], peers: [] },
    { resources: [], outputs: [], blockers: ['b', 'c', 'd'], targets: ['e'], peers: [] },
    { resources: ['r'], outputs: ['x'], blockers: [], targets: [], peers: [] },
    { resources: [], outputs: ['x'], blockers: [], targets: [], peers: ['p', 'q', 'r'] },
  ];
  for (const c of CELLS) {
    let changed = false;
    for (const base of PROGRESS_BASES) {
      const verdicts = new Set();
      for (const n of [0, 1, 3]) {
        const spec = Object.assign({ subject: '自检-进度' }, base);
        spec[c.field] = n === 0 ? [] : Array.from({ length: n }, (_, i) => c.key + '-项' + i);
        const r = judgeProgress(spec);
        if (r.ok) verdicts.add(r.verdict);
      }
      if (verdicts.size > 1) changed = true;
    }
    const declared = PROGRESS_VERDICT_INPUTS.has(c.key);
    if (declared && !changed) {
      problems.push(
        '进度判局: 「' + c.shuxing + '」在 PROGRESS_VERDICT_INPUTS 里(声称影响判定), '
        + '但把它从 0 条扫到 3 条, verdict 从来没变过 —— 规则已经不读它了, 表没跟上'
      );
    }
    if (!declared && changed) {
      problems.push(
        '进度判局: 「' + c.shuxing + '」不在 PROGRESS_VERDICT_INPUTS 里(声称不影响判定), '
        + '但扫它的条数时 verdict 变了 —— 规则已经读它了, 表没跟上'
      );
    }
  }
  // 进度判局必须能走齐三档 —— 走不齐说明档位映射断了, 不该默默继续。
  {
    const seen = new Set();
    const samples = [
      { subject: '自检-收口', outputs: ['x'] },
      { subject: '自检-续', outputs: ['x'], targets: ['e'] },
      { subject: '自检-换向', outputs: [], blockers: ['b', 'c', 'd'], targets: ['e'] },
    ];
    for (const s of samples) {
      const r = judgeProgress(s);
      if (r.ok && r.verdict) seen.add(r.verdict);
    }
    for (const v of seen) {
      if (!Object.values(PROGRESS_VERDICT).includes(v)) {
        problems.push('进度判局产出了本模块不认识的档位: ' + v);
      }
    }
    if (seen.size < 3) {
      problems.push('进度判局的三条自检样本没能走齐三档 (只走到 ' + seen.size + ' 档)');
    }
  }
  if (problems.length) {
    throw new Error('[task_judge] 装时自检失败:\n  - ' + problems.join('\n  - '));
  }
}

_assertTaskJudgeLayer();

module.exports = {
  STATE,
  STATE_LABEL,
  CELLS,
  BI,
  VERDICT_INPUTS,
  PROGRESS_VERDICT,
  PROGRESS_VERDICT_LABEL,
  PROGRESS_VERDICT_INPUTS,
  PROGRESS_RULES,
  SOURCE_LABEL,
  DISCLAIMER,
  MEANING_TAG,
  STRONG_THRESHOLD,
  judgeTask,
  judgeProgress,
  // 单独导出, 便于启动链显式跑一遍 —— load 期那一次会被调用方的 try/catch 吞掉
  // (2026-10-22 铁律: load 期自检必被吞, 要抛就抛在启动链里)
  // ⚠️ 漏了这个导出, 启动链那句 `._assertTaskJudgeLayer()` 就是 TypeError,
  //   而它是 **throw** 的分支 ⇒ **盘古直接起不来**。测试当场抓到的。
  _assertTaskJudgeLayer,
};
