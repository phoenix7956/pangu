'use strict';
// 卦块 (【盘古起卦 …】) 的**唯一真源**。
//
// 2026-10-21 教训 (**两份同义文本各改各的, 改一次就漂一次**):
//   收尾句「不要复述本块原文。」原来在三个地方各存了一份 ——
//     ① pangu_agent_stream.js (块正文, 生产者)
//     ② subagent_runner.js  _GUA_BLOCK_END (剥离者)
//     ③ task_split.js       _gEnd           (拆分者)
//   2026-10-21 改了正文措辞 (去掉"卦象定调"这个会被模型搬去开篇的短语, 去掉禁令式措辞),
//   ② ③ 立刻失效: 认不出收尾 → 整块卦象留在路由输入/刀任务里 → 卦象里的"推理/分析"
//   替主人投票 → 任务被派给写不了盘的 analyzer, 或者三刀各背 300 字一模一样的卦块。
//   (routing-gua-strip / task-split-no-gua-refill / delivery-truth 三条当场红。)
//
// 修法: 收尾句只在这里存一份, 生产者和消费者都从这里取。改措辞 = 改这一处。
// 别再往任何地方抄第二份。

// 块头 (开头标记)
const path = require('path');

const GUA_BLOCK_HEAD = '【盘古起卦 · 先于推理 (梅花易数, 64i 真卦辞爻辞)】';

// ── 编号口径行 (2026-10-23 第 54 批加) ───────────────────────────────────────
//
// 为什么模型必须看见这个: 老板 10-22 起连续三次问到编号, 根子是
// **同一个东西有两套号**, 而两套在数字上都合法, 用错了不报错、只静悄悄答错:
//
//   ① 64 卦:  id(文王序 1..64)  vs  index(二进制 0..63)
//   ② 八卦:  先天数(乾1兑2离3震4巽5坎6艮7坤8)  vs  后天数(坎1坤2震3巽4乾5兑6艮7离8)
//
// ② 尤其险: **两套都是 1..8**, 而且**只有艮在两套里都是 7** ——
// 坎 6/1、坤 8/2、震 4/3、巽 5/4、乾 1/5、兑 2/6、离 3/8 各不相同。
// 问「震是第几卦」, 答 4 和答 3 都对得住, 取决于用了哪套。
// 主人在《周易》里读到的大多是先天序(乾一兑二), 但洛书方位讲的是后天序,
// 两者在同一句话里出现是常事 ⇒ 模型必须自己知道自己在报哪一套。
//
// 判据来自第 53 批的 `NUMBERING_BASIS`: 能不能写成对方的函数。
// 先天数是 bits 的函数(8 − value) ⇒ 派生; 后天数在 bits 上非单调 ⇒ 独立。
// **只有真正独立的那两套才配得上「换序静悄悄返回另一个卦」**。
//
// ⚠️ 数字**一个都不手写**: 全部从 bagua_positions / hexagrams 真源算出来。
//   手写就会漂 —— 这正是本文件开头那条教训(两份同义文本各改各的)的翻版。
const NUMBERING_NOTE_HEAD = '编号口径';

function _trigramNumbers() {
  // 两套八卦号都从真源取; 取不到就返回 null(不猜、不硬编兜底值)。
  try {
    const bp = require(path.join(__dirname, '..', '64i', 'bagua_annotations', 'bagua_positions.js'));
    const xian = {}, hou = {};
    for (const s of bp.XIAN_TIAN_SEQ) xian[s.name] = s.position;
    for (const s of bp.HOU_TIAN_SEQ) hou[s.name] = s.position;
    return { xian, hou };
  } catch (_) {
    return null;
  }
}

/**
 * 拼出这一卦的编号口径行。取不到数据就返回空串(块里少一行, 不报错、不编)。
 *
 * @param {object} gua 起卦结果(gua_engine.castGua 的返回)
 * @returns {string}
 */
function buildNumberingBasisLine(gua) {
  // 只判 `!gua`, 不判 `gua.gua_name` —— 口径行里**没有**用到卦名
  // (卦名就在上一行「本卦:」里, 重复一遍是废话), 所以那个检查是死条件:
  // 变异体检 M7 把它删掉, 8 条断言一条没红 ⇒ 它从来没生效过。死条件删掉。
  if (!gua) return '';
  const parts = [];
  // ① 64 卦: id 是文王序; index 由 binary 算(0 基, 与 id 差一位)
  if (typeof gua.gua_id === 'number') {
    let idx = null;
    if (typeof gua.binary === 'string' && /^[01]{6}$/.test(gua.binary)) {
      idx = parseInt(gua.binary, 2);
    }
    parts.push('卦序用 id=' + gua.gua_id + '(文王序 1..64)'
      + (idx === null ? '' : ', 二进制索引 index=' + idx + '(0..63) —— 两套都合法, 引用时说清用哪套'));
  }
  // ② 八卦: 先天数 vs 后天数。两套都是 1..8, 只有艮相同。
  const n = _trigramNumbers();
  if (n && gua.upper_trigram && gua.lower_trigram) {
    const up = gua.upper_trigram, lo = gua.lower_trigram;
    const f = (k) => (n.xian[k] !== undefined && n.hou[k] !== undefined
      ? k + ' 先天' + n.xian[k] + '/后天' + n.hou[k] : '');
    const t = [f(up), f(lo)].filter(Boolean);
    if (t.length) {
      parts.push('上下卦数 ' + t.join('(上) ') + '(下)'
        + ' —— 先天数与后天数两套都叫 1..8, 八卦里只有艮两套相同, 别混着报');
    }
  }
  if (!parts.length) return '';
  return '—— ' + NUMBERING_NOTE_HEAD + ': ' + parts.join(' | ');
}

// 爻位性质(根元/身本/动用/变机/德成/极终)的身份标签 —— 2026-10-22 第 45 批加。
//
// 为什么必须标: 这 6 个词**查无典籍出处**(全树搜: 身本/变机/德成/极终 零命中;
// 「根元」在《三命通会》里的语境是禄命格局用神、「动用」是动词, 都跟爻位无关)。
// 它是一套**盘古自创**的解读框架(根→身→动→机→成→极, 内部自洽),
// 但它直接印在模型读到的卦块里, 不标身份的话模型会照着当经典讲。
//
// ⚠️ 用**正面式**标注, 不写「不许当经典讲」——
//   本文件上面那条教训: 禁令式措辞等于亲手把那个词喂给模型
//   (「不要复述本块原文」改成「要引就引真卦辞/爻辞原文里的一句」)。
//   标身份比下禁令可靠: 身份是事实, 模型自己会照事实说话。
const POSITION_NATURE_TAG = '〔盘古自创框架, 非典籍出处〕';

// 象义(nature/keywords)与卦码(binary)的身份标签 —— 2026-10-22 第 46 批加。
//
// 为什么必须标: 第 45 批给爻位性质标了身份, 顺手查出**同一类问题还有 12 个字段**。
//   本批逐个查到底(查法记在 decision.md 第 46 批), 结论分三类:
//     A 裸的且真进生产 → 标身份(本常量)
//     B 裸的但生产零消费者 → 登记「当前不进生产」+ 守卫 P13 钉住
//     C 进了生产但已有口径文本 → 已有机制够用, 不重复标
//
// 象义这一类为什么算「整理」而不是「原文」:
//   「贲饰」「刚健」这类**卦名/卦德本身有典籍根**(序卦传「贲者饰也」这类),
//   但**关键词组合是象义课程整理出来的** —— 「贲饰、文饰、装饰、美化、礼仪」
//   这么一列是整理者的归纳, 不是某句话的逐字引文。
//   模型拿到「卦义 贲饰(贲饰、文饰、装饰…)」很容易照着当经典原文讲。
//   ⇒ 标 interpretive 准确: 有根, 但这一串是整理。
//
// 为什么用正面式措辞: 同上文件那条教训 —— 禁令式措辞等于亲手把词喂给模型。
// 身份是事实, 模型自己会照事实说话。
const XIANG_YI_TAG = '〔象义整理, 非典籍原文〕';

// 卦码(binary)的身份标签 —— 与象义**分开**。
//
// 为什么卦码也要标: 老板 10-22 原话「还有64卦有一个最大的坑, 不是1～64是0～63」。
// 同一片区域有两个编号: 文王序 id(1..64) 与二进制索引 index(0..63)。
// 它们在 1..63 上完全重叠, 混用会整卦错位。
// `binary`(6-bit 卦码, 上卦三位‖下卦三位) 是**编次 + 编码约定**,
// 各本偶有出入(夬/节/小过/丰 四卦的上下卦最易记反) ⇒ 属编次约定, 不是逐字原文。
const GUACODE_TAG = '〔卦码编次约定, 非典籍原文〕';

// 大象辞(象曰)的身份标签 —— 2026-10-23 第 70 批加。
//
// 为什么它跟上面两个标签**都不是同一类**:
//   XIANG_YI_TAG  = 「不是原文」(关键词是整理)
//   GUACODE_TAG   = 「不是原文」(卦码是编次约定)
//   XIANG_CI_TAG  = 「**是**原文, 但经三方对账裁决过」(大象辞是典籍原句)
//
// 为什么大象辞要标, 不能当纯原文直接给:
//   大象辞确实是《周易》原句(「天行健, 君子以自强不息」), 但盘古存的那一份
//   **不是任何单一底本的逐字拷贝** —— 它是三方(本地《周易》原文切片 /
//   npm iching-shifa / github yijing-data)交叉对账后的定稿:
//     · 54 卦三方文字层一致
//     · 10 卦有异文, 按「首句必含本卦名」筛掉贴错卦的一源 + 人工裁决平票
//   而象辞在这条路上**极容易混卦**(一卦贴成另一卦的, 跟爻辞串位同形),
//   模型拿到一句「山上有雷，小过」根本看不出它来自哪个卦的哪一版。
//   ⇒ 标出来: 让模型知道「这句是大象辞原文, 本盘古的版本是三方对账定稿」。
//   措辞用正面式: 只说身份与来源, 不写禁令。
const XIANG_CI_TAG = '〔大象辞原文, 三方对账定稿〕';

// 体用吉凶**分级/百分比/措辞**的身份标签 —— 2026-10-23 第 55 批加。
//
// 为什么必须标: 《梅花易数》「体用总决」原文给到的是**方向** ——
//   「体克用, 诸事吉; 用克体, 诸事凶。体生用, 有耗失之患; 用生体, 有进益之喜。
//     体用比和, 则百事顺遂。」
// 逐字核过了(切片 64i/sources/meihua_tiyong.txt)。原文里**没有**:
//   ① 大吉/次吉/中吉/小凶/大凶 这套五档分级
//   ② 任何百分比
//   ③ 「事必成」「事不成」这种绝对措辞 —— 原文是「诸事吉/诸事凶」这类方向句,
//      而且不少占例还带限定(「体克用, 功名虽成, 但成功得迟」)
// 而盘古的 TIYONG_TABLE 三样都有, **而且真进生产**(在 gua_cast 的 tool_result 里)。
//
// 不标的后果很具体: 模型读到「用克体 · 大凶(10%) · 事不成」会照着讲 ——
//   「这事 90% 概率不成」, 把一个**课件刻度**说成**典籍断语 + 概率**。
//   老板 10-23 原话「卦永远没有 100%」, 表里最高一档也只有 90%。
//
// ⚠️ 用**正面式**措辞, 不写禁令 —— 同本文件开头那条教训:
//   禁令式措辞等于亲手把那个词喂给模型。
//   标签说的是「这几项是什么来路」, 是事实; 模型照事实说话就够了。
const TIYONG_GRADE_TAG = '〔吉凶分级与百分比为课件量化, 非典籍原文〕';

/**
 * 体用吉凶行 (第 55 批加)。取不到 ti_yong 就返回空串(块里少一行, 不报错、不编)。
 *
 * 为什么这行必须进块: `ti_yong` 一直在 `gua_cast` 的 tool_result 里,
 *   模型拿得到「用克体 · 大凶(10%) · 事不成」这么一句**决定性断语**,
 *   而它一半有出处(方向)、一半没有(分级和百分比)。
 *   以前没印进卦块, 也就没机会标身份 —— 模型只能照单全收。
 *
 * 顺序是刻意的: **原文方向在前, 课件量化在后**, 且后者带标签。
 *   原文只到「吉/凶」这一步, 它才是有典籍背书的那一半。
 *
 * @param {object} gua 起卦结果
 * @returns {string}
 */
function buildTiYongLine(gua) {
  const ty = gua && gua.ti_yong;
  if (!ty || !ty.relation || !ty.ti_gua || !ty.yong_gua) return '';
  return '—— 体用: 体卦' + ty.ti_gua + '(' + (ty.ti_wuxing || '') + ') 主我 / 用卦'
    + ty.yong_gua + '(' + (ty.yong_wuxing || '') + ') 应事 → ' + ty.relation
    + ' · 原文方向「' + (ty.direction || '?') + '」'
    + ' · 分级 ' + (ty.level || '?') + '(' + (ty.pct || '?') + ') ' + (ty.verdict || '')
    + TIYONG_GRADE_TAG;
}

// 爻值(6/7/8/9)的老少与动静 —— 身份标签, 2026-10-23 第 56 批加。
//
// 为什么标: 出处层原本把爻值语义整条挂在 sourced 上, 引文却是「初九, 潜龙勿用」——
//   那句证的是**爻题**(九=阳), 不是**爻值**(老阳9/少阳7/…)。
//   本地全树查过: 「老阳|老阴」只命中梅花「老阴之极」(讲极象)与三命通会「少阳之气」(讲五行),
//   「六七八九」连写零命中, 系辞揲蓍法(大衍之数五十)在本地语料里也没有 ⇒ 拿不出逐字引文。
//   九=阳/六=阴 那半是真有源的(实算 384 条爻题与爻画零不符), 已单列 sourced;
//   不可核的是**老少 + 动静**这一层。
//
// 特别要紧的是**静爻那个 7/8**: 它是盘古的默认取值, 把蓍法的「平」并进了「少」——
//   卦画只给阴阳, 推不出老/少/平(那要看蓍草投掷几次)。不标的话模型会把它当读出来的事实。
//   动爻那边反而是确定的: 动爻必是老爻(9 或 6), 与变卦自洽。
//
// ⚠️ 正面式措辞, 不写禁令(同本文件开头那条教训)。
const YAO_VALUE_TAG = '〔爻值老少动静属传统筮法约定, 本地典籍无逐字出处〕';

// ── 装卦口径行 (2026-10-23 第 57 批加) ──────────────────────────────────────
//
// 为什么必须加: 2026-10-23 实测发现, `gua_cast` 的 tool_result 里
// **纳甲/六亲/京房/互卦的数据早就全到了模型眼前**(34 个字段、2663 字节),
// 一次都没被搬进卦块。真正缺的不是数据, 是**「这串数是什么来路」**:
//
//   · `hu_gua` 是互卦, 但没说它是「二三四爻为下互、三四五爻为上互」——
//     模型极可能按自己想当然的算法去重算, 算错也察觉不到。
//   · `jingfang.gong_wuxing` 是**京房宫五行**, 不是卦的上卦五行。
//     这两个在 32/64 卦上不一致(蒙卦: 上卦艮 ⇒ 土, 京房 ⇒ 离宫四世 ⇒ 火)。
//     `jingfang_bagong.js` 头部早就警告过这件事, 但那份注释模型看不见。
//   · `liu_qin_all[].najia_ganzhi` 是纳甲干支, 而**纳甲的出处分两档**:
//     乾、坤有本地文本真源(<course-source> 阳德条/阴德条);
//     震巽坎离艮兑本地语料**一条都没有**, 是第 41 批靠外部四源交叉验证定的。
//     不说清, 模型会把 8 卦的纳甲当成同样有典籍背书地讲出去。
//
// ⚠️ 这几项在出处台账里**全是 sourced**, 所以**不需要**身份标签 ——
//   需要的是口径本身。标签只留给 interpretive/unsourced 的那些
//   (爻位性质 / 象义 / 体用分级 / 爻值老少动静)。
//
// ⚠️ 措辞规矩照旧: **正面式**, 不写禁令。
//   本文件开头那条教训 —— 禁令式措辞等于亲手把那个词喂给模型。
//   只说「这是什么来路」, 事实摆出来, 模型照事实说话。
const ZHUANG_GUA_HEAD = '装卦口径';

/**
 * 装卦口径行 (纳甲 + 六亲)。取不到数据就返回空串(块里少一行, 不报错、不编)。
 *
 * 数字与规则**一个都不手写**: 装法规则读 najia.NAJIA_BASIS.zhuanggua_rule,
 * 出处分级读 najia.NAJIA_BASIS.dizhi_source, 六亲口径读起卦结果自带的 liu_qin_note。
 *
 * @param {object} gua 起卦结果
 * @returns {string}
 */
function buildZhuangGuaLine(gua) {
  if (!gua) return '';
  let nj = null;
  try {
    nj = require(path.join(__dirname, '..', '64i', 'bagua_annotations', 'najia.js'));
  } catch (_) {
    return '';   // 真源取不到就不报这一行, 不硬编装法
  }
  const basis = nj.NAJIA_BASIS || {};
  const rule = basis.zhuanggua_rule || '';
  if (!rule) return '';

  // 出处分两档, 必须说清: 本地文本真源 vs 外部四源交叉验证。
  // 分档**从真源数**, 不手写哪几个卦是哪一档 ——
  //   (DIZHI_SOURCE 的值里带「本地文本真源」/「外部四源交叉验证」两种措辞)
  //
  // ⚠️ 必须锚**前缀**, 不能用 indexOf 找子串 ——
  //   震那一条的原文是「外部四源交叉验证(第 41 批): … ; **本地文本真源未收录**震卦六爻地支」
  //   子串搜「本地文本真源」会命中这句**否定**, 于是 8/8 全被判成本地真源。
  //   (与第 56 批「默认」被同句括号里的「默认值」顶替是同一类错:
  //    关键词断言不做位置锚定, 就会被同一句里**别处**的同名词替身顶掉。)
  const ds = nj.DIZHI_SOURCE || {};
  const names = Object.keys(ds);
  let localNames = [], crossNames = [];
  for (const k of names) {
    const v = String(ds[k] || '');
    if (/^本地文本真源/.test(v)) localNames.push(k);
    else if (/^外部四源交叉验证/.test(v)) crossNames.push(k);
  }
  const parts = ['—— ' + ZHUANG_GUA_HEAD + ': 纳甲 ' + rule];
  if (localNames.length && crossNames.length) {
    parts.push('纳甲地支出处分两档 —— ' + localNames.join('/') + ' 有本地文本真源, '
      + crossNames.join('/') + ' 本地语料未收录, 系外部四源交叉验证');
  } else if (crossNames.length) {
    parts.push('纳甲地支全部系外部四源交叉验证(' + crossNames.join('/') + ')');
  }
  // 六亲口径: 我=宫五行, 他=该爻纳甲地支五行。
  //   note 是起卦结果**自带的**, 不在这儿重述一遍, 免得两处各说各的。
  const lq = Array.isArray(gua.liu_qin_all) ? gua.liu_qin_all : null;
  if (lq) {
    const n = lq.filter((x) => x && x.najia_ganzhi).length;
    const total = lq.length;
    parts.push('六亲 ' + n + '/' + total + ' 爻已装出纳甲干支'
      + (n < total ? '(其余给 null + 原因)' : '(六爻齐全)'));
  }
  return parts.join(' | ');
}

/**
 * 京房八宫/世应 + 互卦 口径行。取不到数据就返回空串(块里少一行, 不报错、不编)。
 *
 * 为什么必须标「宫五行 ≠ 上卦五行」: 这是 64i 里**唯一一个同名字段两种含义**的坑,
 * 而且在 32/64 卦上给出**不同**的五行。模型看到 `jingfang.gong_wuxing` 和
 * 卦本身的五行同时出现, 极容易混着用 —— 混了之后六亲全错, 而且不报错。
 *
 * @param {object} gua 起卦结果
 * @returns {string}
 */
function buildJingfangLine(gua) {
  if (!gua) return '';
  const parts = [];
  const jf = gua.jingfang;
  if (jf && jf.gong && jf.gong_wuxing) {
    parts.push('京房 ' + jf.gong + '宫(' + jf.gong_wuxing + ')'
      + (jf.wei ? ' ' + jf.wei + '卦' : '')
      + (jf.shi && jf.ying ? ' · 世在' + jf.shi + '爻 应在' + jf.ying + '爻' : '')
      + ' —— 宫五行说的是「宫」的五行, 与本卦上卦的五行是两回事');
  }
  // 互卦: 二三四爻为下互, 三四五爻为上互。规则从 gua_engine 的注释/实现来, 不手写。
  const hu = gua.hu_gua;
  if (hu && hu.name) {
    parts.push('互卦 ' + hu.name + (hu.name_full ? '(' + hu.name_full + ')' : '')
      + (hu.gua_ci ? '「' + hu.gua_ci + '」' : '')
      + ' —— 二三四爻为下互、三四五爻为上互, 取过程不只看结果');
  }
  if (!parts.length) return '';
  return '—— ' + parts.join(' | ');
}

/**
 * 爻值口径行 (第 56 批加)。取不到爻值就返回空串(块里少一行, 不报错、不编)。
 *
 * 为什么模型必须看见: `gua_cast` 的 tool_result 里有 `moving_yao_value: 6`,
 *   但 6 是什么**从没解释过** —— 不知道它=老阴=动, 就可能当成爻位编号或五行编号。
 *
 * @param {object} gua 起卦结果
 * @returns {string}
 */
function buildYaoValueLine(gua) {
  if (!gua || typeof gua.moving_yao_value !== 'number') return '';
  let V = null;
  try {
    V = require(path.join(__dirname, '..', '64i', 'yin_yang.js')).YAO_VALUES;
  } catch (_) {
    return '';   // 真源取不到就不报这一行, 不硬编 6/7/8/9
  }
  const v = gua.moving_yao_value;
  const name = v === V.LAO_YANG ? '老阳' : v === V.LAO_YIN ? '老阴'
    : v === V.SHAO_YANG ? '少阳' : v === V.SHAO_YIN ? '少阴' : '?';
  const isYang = (v === V.LAO_YANG || v === V.SHAO_YANG);
  // 老少与动静是**两维**, 说清动爻变的是哪一维 ——
  //   老板 10-21 原话「爻动阴阳那就太过了」: 动爻变的是动静, 阴阳另由爻画还原。
  const flips = v === V.LAO_YANG ? '本卦为阳, 变后为阴'
    : v === V.LAO_YIN ? '本卦为阴, 变后为阳' : '静爻不变';
  return '—— 爻值口径: 本卦动爻爻值 ' + v + ' = ' + name
    + '(' + (gua.moving_yao_movement === 'dynamic' ? '动' : '静')
    + ', ' + (isYang ? '阳' : '阴') + ') —— ' + flips
    + ' | 其余静爻默认 少阳' + V.SHAO_YANG + '/少阴' + V.SHAO_YIN
    + '(把蓍法「平」并入「少」的默认值; 卦画只给阴阳, 推不出老少)'
    + ' | 爻题的九=阳、六=阴有《周易》原文可逐字核'
    + YAO_VALUE_TAG;
}

// 块尾 (收尾标记) —— 剥离函数靠它认边界, 所以必须**恰好是块的收尾句**。
// 注意: 剥离是"从块尾往后取", 所以这句后面不能再跟正文。
const GUA_BLOCK_END = '引用时引真卦辞/爻辞原文里的一句。';

// 回答顺序行 (老板 2026-10-09 裁定: 事实在前, 卦象在后)
const GUA_ORDER_LINE = '—— 回答顺序 (2026-10-09 老板定): **第一段先给已核实的事实/结论**(工具返回的数字与证据); '
  + '本块卦象随后作补充视角, ' + GUA_BLOCK_END;

// 2026-10-21 之前的收尾句 —— 老会话里存的卦块还带着它, 剥离时也要认。
// (换句子的那天顺手把老句子留成 legacy 标记, 这样老会话不会突然开始把卦象漏进路由。)
const GUA_LEGACY_BLOCK_ENDS = ['不要复述本块原文。'];

// 找块尾: 返回**块尾之后**的下标; 认不出返回 -1 (调用方退回旧行为, 不猜)。
// 三条路, 从准到糊:
//   ① 已知收尾句 (现版本 + 老版本)
//   ② 结构锚点: "—— 回答顺序"那一行 (句子改了但行还在, 仍认得出)
//   ③ 都没有 → -1
function findGuaBlockEnd(s, start) {
  let best = -1;
  for (const marker of [GUA_BLOCK_END, ...GUA_LEGACY_BLOCK_ENDS]) {
    const i = s.indexOf(marker, start);
    if (i >= 0 && (best < 0 || i < best)) best = i + marker.length;
  }
  if (best > 0) return best;
  const m = /——\s*回答顺序[^\n]*\n?/.exec(s.slice(start));
  if (m) return start + m.index + m[0].length;
  return -1;
}

// 2026-10-21 (实跑取证): 这行原来写「卦象定调放在事实之后作补充视角。引用上面的真卦辞爻辞时不要复述本块原文。」
//   两条都在害模型:
//   ① 「卦象定调」这四个字被模型**原样搬到答案第一行** —— 实跑: 「卦象定调: 此问只做编号核准, 宜"宜下不宜上"」,
//      主人问的是第24卦是什么, 答案却拿卦象开篇, 事实(复卦)排在后面。
//      提示里出现一个词, 模型就容易拿它当开篇标签 —— 那个词不该出现在答案形态的描述里。
//   ② 「不要复述本块原文」是禁令式措辞 —— 写"不要说什么"等于亲手把那个词喂给模型。
//   改成正面式: 只说**该做什么**(第一段给事实; 要引就引真卦辞/爻辞原文里的一句)。
function formatGuaFirstBlock(gua) {
  const zhi = gua.zhi_gua ? (' | 之卦: ' + gua.zhi_gua.name + ' ' + (gua.zhi_gua.symbol || '') + '「' + (gua.zhi_gua.gua_ci || '') + '」') : '';
  // 编号口径行 (第 54 批): 两套号都合法, 用错了不报错、只静悄悄答错 ⇒ 必须让模型看见。
  //   放在**事实行之后、卦象之前**: 老板 10-09 定的顺序是「第一段先给已核实的事实」,
  //   而 id/index 与先天/后天**都是**事实(不是卦象解读), 所以不违反那个顺序。
  //   取不到数据时返回空串 ⇒ 块里少一行, 不报错、也不编数字。
  const numbering = buildNumberingBasisLine(gua);
  // 体用行 (第 55 批): 方向有出处、分级与百分比是课件量化 ⇒ 印的时候分开,
  //   课件那半带 TIYONG_GRADE_TAG。取不到数据返回空串 ⇒ 块里少一行, 不报错、不编。
  const tiyong = buildTiYongLine(gua);
  // 爻值口径行 (第 56 批): tool_result 里的 moving_yao_value 从没被解释过,
  //   而静爻 7/8 是默认值不是读出来的 —— 不标身份模型就会照着当事实讲。
  const yaoValue = buildYaoValueLine(gua);
  // 装卦口径行 + 京房/互卦行 (第 57 批): tool_result 里 34 个字段的数据**早就全到了**
  //   模型眼前, 缺的是「这串数是什么来路」。纳甲是「三层串起来」的那一下,
  //   而它一直只在 JSON 里躺着, 模型拿得到干支却不知道装法与出处分档。
  const zhuangGua = buildZhuangGuaLine(gua);
  const jingfang = buildJingfangLine(gua);
  // 大象辞行 (第 70 批): 「这卦整体在讲什么」那一层。
  //   为什么放在**卦辞那行之后、五行那行之前**: 卦辞与大象辞是同一卦的原文,
  //   连着印模型才接得上; 而五行/六亲是**另一层**(装卦结果), 不该跟原文混排。
  //   为什么带标签: 它**是**《周易》原文(不是整理品), 但盘古这份是三方对账定稿
  //   (10 卦有登记异文) ⇒ 标出来, 模型知道引用时怎么讲。
  //   取不到就不印这一行(不是印空): 缺行不报错、不编。
  const xiangLine = gua.gua_xiang
    ? ('大象辞: ' + gua.gua_xiang + ' ' + XIANG_CI_TAG + '\n')
    : '';
  // 2026-11-24: 综卦/错卦 位运算 (跟互卦同构, 纯 6-bit 位翻转/取反, 零幻觉)
  const zong = gua.zong_gua ? (' | 综卦: ' + gua.zong_gua.name + ' ' + (gua.zong_gua.symbol || '') + '「' + (gua.zong_gua.gua_ci || '') + '」') : '';
  const cuo = gua.cuo_gua ? (' | 错卦: ' + gua.cuo_gua.name + ' ' + (gua.cuo_gua.symbol || '') + '「' + (gua.cuo_gua.gua_ci || '') + '」') : '';
  return GUA_BLOCK_HEAD + '\n'
    + '本卦: ' + gua.gua_name + ' ' + (gua.symbol || '') + ' (' + (gua.upper_trigram || '') + '上' + (gua.lower_trigram || '') + '下)「' + (gua.gua_ci || '') + '」'
    + ' | 动爻: ' + (gua.yao_name || ('第' + gua.moving_yao + '爻')) + '「' + (gua.moving_yao_ci || '') + '」' + zhi + zong + cuo + '\n'
    + (gua.infer ? (' | 推理内核: 阳' + gua.infer.阳爻数 + '阴' + gua.infer.阴爻数 + ' 体用' + gua.infer.体用.关系 + ' → 决策「' + gua.infer.决策 + '」 ' + gua.infer.决策依据 + '\n') : '')
    + (gua.transition ? (' | 384爻转移: ' + gua.transition.from.name + '·' + gua.transition.yao_pos_name + '动(' + gua.transition.yao_name + ') → ' + gua.transition.to.name + ' (' + gua.transition.to.binary + ')\n') : '')
    + xiangLine
    + '五行: ' + (gua.wuxing || '') + ' | 动爻五行: ' + (gua.yao_wuxing || '') + ' (' + (gua.wuxing_rel || '') + ') | 六亲: ' + (gua.liu_qin || '') + ' | 爻位性质: ' + (gua.position_nature || '') + POSITION_NATURE_TAG + '\n'
    + (numbering ? numbering + '\n' : '')
    + (tiyong ? tiyong + '\n' : '')
    + (yaoValue ? yaoValue + '\n' : '')
    + (zhuangGua ? zhuangGua + '\n' : '')
    + (jingfang ? jingfang + '\n' : '')
    + GUA_ORDER_LINE + '\n'
    + '   若工具没拿到数据, 先如实说"没拿到"及原因, 不许用卦象顶替缺失的数据。\n\n主人问题: ';
}

module.exports = {
  GUA_BLOCK_HEAD,
  GUA_BLOCK_END,
  GUA_LEGACY_BLOCK_ENDS,
  GUA_ORDER_LINE,
  POSITION_NATURE_TAG,
  XIANG_YI_TAG,
  GUACODE_TAG,
  XIANG_CI_TAG,
  TIYONG_GRADE_TAG,
  YAO_VALUE_TAG,
  ZHUANG_GUA_HEAD,
  findGuaBlockEnd,
  formatGuaFirstBlock,
  buildNumberingBasisLine,
  buildTiYongLine,
  buildYaoValueLine,
  buildZhuangGuaLine,
  buildJingfangLine,
  NUMBERING_NOTE_HEAD,
};
