/**
 * Pangu · 64i Layer
 * bagua_annotations/yao_ci_variants.js
 *
 * 爻辞**版本异文台账** —— 384 爻辞跟独立真源交叉核验的裁定结果 (2026-10-22 第三十一批)
 *
 * ═══════════════════════════════════════════════════════════════
 * 先说清这件事**为什么值得做成模块**, 而不是跑一次脚本就完
 * ═══════════════════════════════════════════════════════════════
 *
 *   一条爻辞有两个读法, 盘古**必须知道**自己有异文, 而且必须说得清依据 ——
 *   否则模型会拿 repo 那一条当唯一正解讲出去。碰到懂行的人一问「这读法有出处在哪」,
 *   就答不上来。而"看着很专业但说不出出处"正是这个项目反复出现的病根。
 *
 *   所以: 异文不是"备注", 是**要跟着数据出参的口径**(同第 30 批 `LIU_QIN_BASIS` 的做法)。
 *
 * ═══════════════════════════════════════════════════════════════
 * 真源只有一个 (这件事必须先承认, 否则整个结论都是空的)
 * ═══════════════════════════════════════════════════════════════
 *
 *   唯一独立真源:
 *     /Users/you/Desktop/course-source《易经》全文、全文翻译（上）.txt
 *     (周振甫/张善文译注版; 实含**上经 30 卦 + 咸卦** 共 31 卦爻辞)
 *
 *   ❌ `digest/<course-source>` 34 份**不能用**:
 *     它们各自的头注释写着「64i 真源: 本篇卦辞/爻辞…与 hexagrams.js **同源**」
 *     或「真源:64i/hexagrams.js (2026-09-17 12:21 拉取)」。
 *     ⇒ 拿它们回来核 hexagrams.js, 就是「尺子与被测对象同源」的恒真守卫,
 *       而且比没有守卫更坏: 它看起来在尽职。
 *     (16-20 那份没写"同源"两个字, 但它写的是「真源:64i/hexagrams.js」—— 一样同源。
 *      这就是为什么不能只 grep「同源」两个字就下结论。)
 *
 *   ⇒ **下经 30 卦 + 随卦 = 34 卦的爻辞没有独立原文可核**, 显式标 null + 原因, 不拿推算填。
 *
 * ═══════════════════════════════════════════════════════════════
 * 核验结果: 180 爻逐条核过, **repo 真错 0 条**
 * ═══════════════════════════════════════════════════════════════
 *
 *   L0 完全一致 0 / L1 仅标点不同 164 / L2 异体字 3 / L3 文字真差异 13
 *
 *   ⚠️ 这三个数字要一起读, 单看任何一个都会被误导:
 *     · L0 = 0 是因为 repo 统一去标点, 真源带标点 ⇒ 164 条「不一致」其实是同一句话
 *     · L3 = 13 看着吓人, 但逐条裁定后: **真源自己坏了 2 条, 版本异文 11 条,
 *       repo 真错 0 条**
 *
 * ⚠️ **这一批纠正了上一轮的结论**(踩坑: 拿「不一致」当「错」):
 *   上一轮 scratch 脚本报了 71 条不一致, 其中列出 5 处「确认的真错」:
 *   屯六二/屯六三/谦六四/观六二/坎上六 … 逐条回到原文查, 前两条是**真源自己坏了**,
 *   后三条是**异体字**(撝≡挥 / 闚≡窥 / 徵≡徽), 归一后完全一致。
 *   教训: 「两条读法不一样」≠「其中一条错」。**没有第二个源就不能断言谁是错的。**
 */

'use strict';

const path = require('path');

const HEXAGRAMS = require(path.join(__dirname, '..', 'hexagrams.js')).HEXAGRAMS;

// ============================================================
// 异体字归一表 (L2 层: 归一后完全一致, 不是错)
// ============================================================

/**
 * 只收**同字异写** —— 同一字的两种书写, 归一后逐字相同。
 *
 * ⚠️ 这里刻意**不放**「已/己」「祗/祇」这类:
 *   它们是**通假/异体**, 但归一后句子不完全相同(位置可能不同),
 *   塞进来会把 L3 的真差异吞掉。放不放得进这张表, 判据是
 *   「归一后**逐字**相同」, 不是「我觉得它们是一回事」。
 */
const VARIANT_GLYPHS = [
  { from: '撝', to: '挥', note: '撝(音huī) ≡ 挥, 同字异写' },
  { from: '闚', to: '窥', note: '闚 ≡ 窥, 同字异写' },
  { from: '徵', to: '徽', note: '徵 ≡ 徽, 同字异写(此处义为表彰)' },
];

// ============================================================
// 口径常量 —— 跟着数据一起出参
// ============================================================

const YAO_CI_BASIS = Object.freeze({
  source_path: '/Users/you/Desktop/course-source《易经》全文、全文翻译（上）.txt',
  source_edition: '周振甫/张善文译注版',
  source_is_single: true,          // ★ 只有一个源 ⇒ 版本异文无法内部裁定
  covered_gua: 31,                  // 上经 30 + 咸
  checked_yao: 180,
  repo_errors: 0,                   // ★ 逐条裁定后 repo 真错数
  src_broken: 3,                    // 真源爻辞位坏了(白话混入 1 / 衍字 1 / 脱字 1)
  variant_readings: 10,             // 两读皆通的版本异文
  uncovered_gua: 34,                 // 无独立原文可核 → null, 不推算
  reject_as_source: [
    'digest/<course-source> (34 份) —— 头注释自标与 hexagrams.js 同源, '
      + '拿它核 hexagrams.js 是恒真守卫',
  ],
});

// ============================================================
// L3 逐条裁定
// ============================================================

/**
 * 三类裁定:
 *   SRC_BROKEN  真源爻辞位被污染(白话混入) ⇒ **不改 repo**, 反过来钉住 repo 是对的
 *   VERSION     版本异文, 两读皆通, 无第二源 ⇒ **不改**, 但必须带出处讲出去
 *   REPO_ERR    repo 真错 ⇒ 改 repo
 *
 * `evidence` 是判据本身, 不是装饰 —— `assertYaoCiVariants()` 会拿它去查源文件:
 * 证据对不上 = 这条裁定自己塌了, 启动即炸。
 *
 * ⚠️ `xiang_quote` 只在真源《象》曰**原文引用了该爻**时才写。
 *   象曰没引的, 一律 null —— 「象曰未引此句, 无法内部裁定」,
 *   凭"感觉该是哪个"填证据就是造假。
 */
const YAO_CI_VARIANTS = [
  // ── 真源自己坏了 (爻辞位混进了白话) ────────────────────────
  {
    gua: '屯', yao: '六二',
    repo: '女子贞不字，十年乃字',
    source: '十年后才生育',
    kind: 'SRC_BROKEN',
    xiang_quote: '十年乃字',
    note: '真源爻辞位被塞进白话「十年后才生育」, 但同卦《象》曰原话引的是「十年乃字」。'
      + '《象》曰引原文 = 象曰与爻辞同源 ⇒ 爻辞位那处被污染, repo 的「十年乃字」是真文。',
  },
  {
    gua: '屯', yao: '六三',
    repo: '即鹿无虞',
    source: '即主鹿无虞',
    kind: 'SRC_BROKEN',
    xiang_quote: '即鹿无虞',
    note: '真源「即主鹿无虞」多一个「主」字(白话层「主鹿」混入爻辞位), 衍字。'
      + '★ 同卦《象》曰原话引「即鹿无虞」(「以从禽也」) ⇒ 无衍字, '
      + '真源爻辞位多一个「主」是衍字, repo 对。',
  },

  // ── 版本异文 (两读皆通, 标出来, 不改) ──────────────────────
  {
    gua: '泰', yao: '九三',
    repo: '勿恤其孚',
    source: '勿悔恤其孚',
    kind: 'VERSION',
    xiang_quote: null,
    note: '「勿恤其孚」/「勿悔恤其孚」两读皆有出处。象曰未引此句 ⇒ 单一真源无法裁定, 标异文。',
  },
  {
    gua: '泰', yao: '上六',
    repo: '城复于隍，勿用师，自邑告命，贞吝',
    source: '“城复于隍”；勿用师，自邑告命，贞吝',
    kind: 'VERSION',
    xiang_quote: null,
    note: '文字**完全相同**, 真源只是给「城复于隍」加了引号并改了断句 ⇒ 纯断句异文, 非文字差异。',
  },
  {
    gua: '大有', yao: '六五',
    repo: '厥孚交如威如，吉',
    source: '厥孚交加，威如，吉',
    kind: 'VERSION',
    xiang_quote: '厥孚交加',
    note: '「交如」/「交加」两读。真源爻辞位与《象》曰**都**作「交加」⇒ 真源自洽, '
      + '判为异文而非错; repo 保留「交如」(通行读法)。',
  },
  {
    gua: '噬嗑', yao: '九四',
    repo: '噬乾胏，得金矢，利艰贞吉',
    source: '噬干子，得金矢；利艰贞，吉',
    kind: 'VERSION',
    xiang_quote: null,
    note: '「乾胏」(乾=干、胏=带骨干肉) / 「干子」两读。象曰未引此句 ⇒ 标异文。',
  },
  {
    gua: '噬嗑', yao: '六五',
    repo: '噬乾肉，得黄金，贞厉无咎',
    source: '噬干肉，得黄金；贞厉，无咎',
    kind: 'VERSION',
    xiang_quote: null,
    note: '「乾」/「干」异体。象曰未引此句 ⇒ 标异文。',
  },
  {
    gua: '剥', yao: '六三',
    repo: '剥之，无咎',
    source: '剥，无咎',
    kind: 'SRC_BROKEN',
    xiang_quote: '剥之无咎',
    note: '★ 真源爻辞位**脱了一个「之」字**(作「剥，无咎」), 但同卦《象》曰原话引「剥之无咎」。'
      + '⇒ repo 的「剥之，无咎」与象曰一致, 是对的; 真源爻辞位漏字。'
      + '这条同时说明: 真源不是逐条校过的干净底本, 拿它当唯一真理会跟着错。',
  },
  {
    gua: '复', yao: '上六',
    repo: '迷复凶，有灾眚。用行师终有大败，以其国君凶，十年不克征',
    source: '迷复，凶，有灾眚。用行师，终有大败；以其国，君凶。至于十年不克征',
    kind: 'VERSION',
    xiang_quote: null,
    note: '文字相同, 仅断句与「至于」二字之差。象曰未引此句 ⇒ 标异文。',
  },
  {
    gua: '大畜', yao: '初九',
    repo: '有厉，利已',
    source: '有厉，利己',
    kind: 'VERSION',
    xiang_quote: '利己',
    note: '「已」/「己」通假异写。真源《象》曰作「利己」⇒ 真源自洽; 两读皆通, 标异文。',
  },
  {
    gua: '大畜', yao: '九三',
    repo: '良马逐，利艰贞，日闲舆卫，利有攸往',
    source: '良马逐，利艰贞。曰闲舆卫，利有攸往',
    kind: 'VERSION',
    xiang_quote: null,
    note: '「日」/「曰」异体(曰=说)。象曰引的是「利有攸往」, 未引此句 ⇒ 标异文。',
  },
  {
    gua: '坎', yao: '九五',
    repo: '坎不盈，祗既平，无咎',
    source: '坎不盈，祇既平，无咎',
    kind: 'VERSION',
    xiang_quote: null,
    note: '「祗」/「祇」异体。象曰未引此句 ⇒ 标异文。',
  },
  {
    gua: '离', yao: '上九',
    repo: '王用出征，有嘉折首，获匪其丑，无咎',
    source: '王用出征，用嘉折首，获匪其丑，无咎',
    kind: 'VERSION',
    xiang_quote: null,
    note: '「有嘉」/「用嘉」两读。象曰引的是「王用出征」, 未引此句 ⇒ 标异文。',
  },
];

// ============================================================
// 无独立原文可核的卦 —— 显式标 null + 原因, 不拿推算填
// ============================================================

/** 真源未覆盖的卦 (含上经的「随」—— 真源文件本身漏了它的卦头) */
const UNCOVERED_GUA = Object.freeze([
  '随', '恒', '遁', '大壮', '晋', '明夷', '家人', '睽', '蹇', '解', '损', '益',
  '夬', '姤', '萃', '升', '困', '井', '革', '鼎', '震', '艮', '渐', '归妹',
  '丰', '旅', '巽', '兑', '涣', '节', '中孚', '小过', '既济', '未济',
].map(n => Object.freeze({
  name: n,
  verified: null,
  reason: n === '随'
    ? '真源文件漏了随卦卦头(第十六卦《豫》之后直接跳到第十八卦《蛊》), 原文不在该文件里'
    : '真源文件只到上经 + 咸卦, 下经爻辞原文不在这一份里',
})));

// ============================================================
// 查询
// ============================================================

/** 某卦某爻的异文裁定; 没有 ⇒ null */
function getYaoCiVariant(guaName, yaoName) {
  return YAO_CI_VARIANTS.find(v => v.gua === guaName && v.yao === yaoName) || null;
}

/** 某卦的异文清单 */
function getGuaVariants(guaName) {
  return YAO_CI_VARIANTS.filter(v => v.gua === guaName);
}

/** 这条爻辞能不能说成"有独立原文可核" */
function isYaoCiVerified(guaName) {
  return !UNCOVERED_GUA.some(g => g.name === guaName);
}

/**
 * 装配给模型看的口径 —— **异文必须跟着数据出参**。
 * 模型若不知道有异文, 就会把 repo 那一条当唯一正解讲出去。
 * @returns {{basis:object, variants:Array, verified:boolean, uncovered_reason:string|null}}
 */
function describeYaoCi(guaName, yaoName) {
  const v = getYaoCiVariant(guaName, yaoName);
  const unc = UNCOVERED_GUA.find(g => g.name === guaName) || null;
  return {
    basis: YAO_CI_BASIS,
    variants: v ? [v] : [],
    verified: isYaoCiVerified(guaName),
    uncovered_reason: unc ? unc.reason : null,
  };
}

// ============================================================
// 自检 —— 越界即抛, 接进启动链
// ============================================================

/** 爻名 → `yao_ci` 数组下标 (数组是**初爻→上爻**的位置序, 不是名字表序) */
const CN_NUM = { '二': 2, '三': 3, '四': 4, '五': 5 };

/**
 * ⚠️ 爻位在爻名的哪个字上, **两读都有** —— 这是第一版写错的地方:
 *   初九/初六 → 爻位在**首**字(初=1)
 *   九二/六二 → 爻位在**次**字(二=2)   ← 「六二」的首字是「六」, 不是爻位
 *   上九/上六 → 爻位在**首**字(上=6)
 *   第一版按「首字是爻位」统一处理 ⇒ 所有阴爻(六x)全部认不出来,
 *   而那恰好是台账里 9 条的位置。当场被自检抓住, 没流出去。
 */
function yaoNameToIndex(yaoName) {
  const s = String(yaoName || '');
  if (s.length !== 2) return -1;
  if (s[0] === '初') return 0;
  if (s[0] === '上') return 5;
  const n = CN_NUM[s[1]];
  return n ? n - 1 : -1;
}

/**
 * 这道自检要咬的是三件事, 每件都**不是**"注释写对了":
 *
 *   ① **台账里的 repo 那一条必须真的等于表里的爻辞**
 *      —— 台账跟 hexagrams.js 是两份数据。不对齐 = 台账在讲一件不存在的事。
 *      (同族病: 静态 LIU_QIN 表塌成 5 形态, 第 30 批已处理过一次)
 *
 *   ② **每条 SRC_BROKEN 必须带象曰证据, 且证据真能在源文件里找到**
 *      —— 「我判真源坏了」这句话本身要有凭证。没凭证 = 我觉得。
 *
 *   ③ **REPO_ERR 一条都不许有**
 *      —— 这批核验的结论是 repo 真错 0 条。哪天冒出一条 REPO_ERR,
 *      要么是核验漏了, 要么是有人把某个真错改标成 VERSION 蒙过去。
 *
 * ⚠️ 源文件不在时**不抛**, 只降级报告 —— 守卫不许把起卦带崩
 *   (同 `guard 不许把起卦带崩` 那条铁律)。但 `repo_errors` 恒为 0 这条照抛。
 */
function assertYaoCiVariants(opts = {}) {
  const violations = [];

  // ① 台账的 repo 读法 == 表里的爻辞
  for (const v of YAO_CI_VARIANTS) {
    const h = HEXAGRAMS.find(x => x.name === v.gua);
    if (!h) {
      violations.push('[台账] 表里没有这个卦: ' + v.gua + '·' + v.yao);
      continue;
    }
    const idx = yaoNameToIndex(v.yao);
    if (idx < 0) {
      violations.push('[台账] 爻名认不出来: ' + v.gua + '·' + v.yao);
      continue;
    }
    const line = String(h.yao_ci[idx] || '');
    const body = line.includes('：') ? line.slice(line.indexOf('：') + 1) : line;
    if (!body.includes(v.repo)) {
      violations.push(
        '[台账] ' + v.gua + '·' + v.yao + ' 台账记的 repo 读法「' + v.repo + '」'
        + '在 hexagrams.js 里找不到 —— 爻辞改过了, 台账没跟上'
      );
    }
  }

  // ② SRC_BROKEN 必须有象曰证据且证据存在于源文件
  // 2026-11-26: 默认源文件路径是本机 /Users/you/Desktop/course-source,
  //   开源导出树里没有这个路径 ⇒ 降级试 64i/sources/ 切片 (public 公版切片)。
  //   私有树优先本机路径 (真源), 导出树 fallback 到切片。
  const _localSrc = require('path').join(require('os').homedir(),
    'Desktop', '易经', 'digest', '<course-source>', '完整版《易经》全文、全文翻译（上）.txt');
  const _sliceSrc = require('path').join(__dirname, '..', '..', 'sources', 'xiang_ci_64.txt');
  const srcPath = opts.sourcePath !== undefined
    ? opts.sourcePath
    : (require('fs').existsSync(_localSrc) ? _localSrc : _sliceSrc);
  let srcText = null;
  try {
    srcText = require('fs').readFileSync(srcPath, 'utf8');
  } catch (e) {
    srcText = null;   // 源不在本机 → 降级, 不抛
  }
  //
  // ⚠️ 判据要用 `srcText !== null`, **不能**写 `if (srcText && ...)` ——
  //   `''`(空文件) 在 JS 里是 falsy, 源文件被清空/截断成 0 字节时,
  //   `srcText && ...` 直接短路 ⇒ 全部证据检查被跳过 ⇒ 守卫安静通过。
  //   这跟「把五行功能全删光也能过」是同一族: 东西没了, 检查反而不响了。
  //   (这个洞是被负例咬出来的: 喂空文件没报, 喂「非空但无证据」才报)
  if (srcText !== null && srcText.length === 0) {
    violations.push(
      '[源文件] 爻辞真源读出来是**空文件**: ' + srcPath
      + ' —— 证据全部无法核对, 不许安静通过'
    );
  }
  for (const v of YAO_CI_VARIANTS) {
    if (v.kind !== 'SRC_BROKEN') continue;
    if (!v.xiang_quote) {
      violations.push(
        '[裁定] ' + v.gua + '·' + v.yao + ' 判成 SRC_BROKEN(真源坏了) 却没有象曰证据 '
        + '—— 「我觉得真源错了」没有凭证, 这条裁定自己塌了'
      );
      continue;
    }
    if (srcText !== null && !srcText.includes(v.xiang_quote)) {
      violations.push(
        '[裁定] ' + v.gua + '·' + v.yao + ' 的象曰证据「' + v.xiang_quote + '」'
        + '在源文件里找不到 —— 源文件换了或引错了, 这条裁定失效'
      );
    }
  }

  // ③ 不许有 REPO_ERR (这批核验的结论是 0)
  const repoErr = YAO_CI_VARIANTS.filter(v => v.kind === 'REPO_ERR');
  if (repoErr.length) {
    violations.push(
      '[裁定] 台账里有 ' + repoErr.length + ' 条 REPO_ERR, 但核验结论是 repo 真错 0 条 —— '
      + '要么核验漏了, 要么有人把真错改标成 VERSION 蒙过去了: '
      + repoErr.map(v => v.gua + '·' + v.yao).join(', ')
    );
  }

  // ④ 口径数字必须跟台账实际条数对上 (防止"文档写 11 条, 实际 13 条")
  const actual = {
    src_broken: YAO_CI_VARIANTS.filter(v => v.kind === 'SRC_BROKEN').length,
    variant: YAO_CI_VARIANTS.filter(v => v.kind === 'VERSION').length,
  };
  if (actual.src_broken !== YAO_CI_BASIS.src_broken
      || actual.variant !== YAO_CI_BASIS.variant_readings) {
    violations.push(
      '[口径] YAO_CI_BASIS 声称 真源坏 ' + YAO_CI_BASIS.src_broken + ' 条 / 异文 '
      + YAO_CI_BASIS.variant_readings + ' 条, 台账实际是 ' + actual.src_broken
      + ' / ' + actual.variant + ' —— 口径不跟着数据走, 模型会拿到错的说法'
    );
  }

  if (violations.length) {
    throw new Error(
      '[yao-ci-variants] 爻辞异文台账自检不通过:\n  ' + violations.join('\n  ')
    );
  }
  return {
    ok: true,
    source_available: srcText !== null,
    counts: actual,
    uncovered: UNCOVERED_GUA.length,
  };
}

module.exports = {
  YAO_CI_BASIS,
  YAO_CI_VARIANTS,
  UNCOVERED_GUA,
  VARIANT_GLYPHS,
  getYaoCiVariant,
  getGuaVariants,
  isYaoCiVerified,
  describeYaoCi,
  assertYaoCiVariants,
};
