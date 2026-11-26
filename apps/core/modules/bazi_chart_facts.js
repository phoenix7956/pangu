'use strict';
// bazi_chart_facts.js — 四柱已知时, 十神/五行/地支关系一律本地确定性计算, 不让 LLM 凭记忆算。
//
// 2026-10-12 (会话 desktop-1791787104119 实案, 老板报"感觉有点问题"):
//   追问轮 analyzer 凭记忆推十神, 推出"土印、庚金七杀、印旺生身" —— 三个全错
//   (土=食伤不是印; 庚金=正财不是七杀; 原局木=0 不可能印旺)。
//   十神/六合/六冲是**查表题**, 不是推理题 —— 64i/bazi/ten_gods.js + zhis_relations.js
//   本来就是干这个的, 但生成答案的链路上没人调它。本模块把"文本里出现四柱" →
//   "确定性事实块注入 userInput" 接通, 主 loop 和 dispatcher 子 agent 都拿得到。
//
// 数据源: 64i/bazi/ten_gods.js (<course-source> 十神) + 64i/bazi/zhis_relations.js (<course-source> 地支关系)

const { getTenGod, WUXING: GAN_WUXING } = require('../64i/bazi/ten_gods');
const { analyzePillars: analyzeZhiRelations, WUXING: ZHI_WUXING } = require('../64i/bazi/zhis_relations');

const GAN = '甲乙丙丁戊己庚辛壬癸';
const ZHI = '子丑寅卯辰巳午未申酉戌亥';
const GANZHI_RE = new RegExp('[' + GAN + '][' + ZHI + ']', 'g');

// ============================================================
// 文本级断言的公共底座 (2026-10-21, 第七批)
//   本模块核十神/五行/旺衰, chart_fidelity 核柱位 —— 两者都要先判一件事:
//   **这句话说的是不是本命盘**。判据完全一样, 所以只写一份, 核对模块 import 它。
//   两处各写一份的代价不是"重复", 是边界漂成两个窗口, 然后两个窗口各判各的。
//
//   非本命盘的上下文: 大运/流年/流月/太岁/纳音/卦/节气/旬/空亡。
//   回看窗口 = **本句**开头往前 60 字, 边界取句号不取逗号 ——
//     大运是一条列表 ("大运壬午年 4岁起运, 辛巳年 14岁"), 拿逗号当边界只拦得住一半。
// ============================================================
const NON_NATIVE_CHART_RE = /(大运|流年|流月|太岁|纳音|卦|节气|甲子旬|空亡)/;
const SENTENCE_BOUNDARY_RE = /[。！？!?\n]/g; // global: sentenceBefore 要循环取最后一个边界
const SENTENCE_LOOKBACK_MAX = 60;

function sentenceBefore(src, index) {
  const from = Math.max(0, index - SENTENCE_LOOKBACK_MAX);
  const seg = String(src == null ? '' : src).slice(from, index);
  // 取**最后一个**边界, 不是第一个 —— 第一版用了 search(), 结果从最早那个句号开始截,
  // 于是"逆排大运，起运4岁11月。\n\n五行力量分布\n土 4.5｜木 1（…）" 这段里,
  // "木 1" 的上文里留着上一句的"大运", 于是本命盘的计数断言被当成大运语境放过了。
  // 一句话前面的句子越多、越容易被误判成"这不是本命盘" —— 正好把最该查的那类放跑了。
  let cut = -1;
  let m;
  SENTENCE_BOUNDARY_RE.lastIndex = 0;
  while ((m = SENTENCE_BOUNDARY_RE.exec(seg)) !== null) cut = m.index;
  return cut === -1 ? seg : seg.slice(cut + 1);
}

// 断言所在位置的"上下文视野": 本句之前 + 断言本身开头两字。
function nativeScopeText(src, index) {
  return sentenceBefore(src, index) + String(src == null ? '' : src).slice(index, index + 2);
}

// 紧跟在断言前面的数字 → 这是**流年/月份**, 不是本命盘: "2026年 丙午" / "生于3月 辛未"。
const DIGIT_PREFIX_RE = /\d+\s*(?:年|月|日)?\s*$/;
// 句子里出现"2026 丙午年" / "2026丙午（偏印、正印）"这种流年干支形态 —— 整句按流年语境处理。
//   不加这一档就漏: "2026 丙午年, 火 2 个。" 句里没有"流年"两个字,
//   但它说的显然是流年不是原局, 拿原局计数去判它就是误伤 (E2E 实跑撞出来的)。
//   "年"字可省: E2E 实跑原句就是 "2026丙午（偏印、正印）" ——
//   四个字数字后面紧跟干支, 就是流年干支, 没有别的可能。
const STREAM_YEAR_RE = new RegExp('\\d{4}\\s*年?\\s*[' + GAN + '][' + ZHI + ']');

/**
 * 这个位置的断言是不是在谈**非本命盘**? 是 → 让路, 不拿原局的尺子去量它。
 * 三档判据合一 (chart_fidelity 的柱位核对复用同一个, 不另写一份):
 *   ① 本句出现 大运/流年/太岁/纳音… 等词
 *   ② 断言前紧跟数字 ("2026年 丙午" / "生于3月 辛未")
 *   ③ 本句出现流年四柱形态 ("2026 丙午年")
 */
function nonNativeContext(src, index) {
  const s = String(src == null ? '' : src);
  const scope = nativeScopeText(s, index);
  const before = s.slice(Math.max(0, index - 8), index);
  return NON_NATIVE_CHART_RE.test(scope) || DIGIT_PREFIX_RE.test(before) || STREAM_YEAR_RE.test(scope);
}

// 地支本气 (藏干主气) — 支十神按本气论 (子平通规)
const ZHI_BEN_QI = {
  '子': '癸', '丑': '己', '寅': '甲', '卯': '乙', '辰': '戊', '巳': '丙',
  '午': '丁', '未': '己', '申': '庚', '酉': '辛', '戌': '戊', '亥': '壬',
};

const PILLAR_LABELS = ['年', '月', '日', '时'];

// 从文本里提取四柱 (干支对序列)。
// 抽取路径 (按可信度排序):
//   ① 显式标注: "戊午年 己未月 丁丑日 庚子时" (干支+年月日时后缀);
//   ①b 标签在前: "年柱 戊午" / "| 月柱 | 己未 |" 表格行 — 按标签各取其后第一个干支对,
//      与行文顺序无关 (2026-10-12 gate-004 实案: 答案用表格抄盘, ① 抓不到);
//   ② 连续干支对: 优先取"命局/四柱/原局/八字"标签后面那一组, 否则全文第一组。
//      **4 个干支对必须挤在 80 字窗口内** — 散布全文的前 4 个干支对不是一盘
//      (gate-004 血泪: 锚点命中"原局**无寅巳申三刑", 抓到 丙午甲子丙午丙午 垃圾盘,
//      核验门拿垃圾当真值把对的草稿修成了垃圾)。
// 日主可信度闸: 文本声明了日主 (日主X/X日主/X命) 且正序倒序都对不上日柱天干 → 返回 null。
// 宁可不核验, 也不拿错盘核验 — 错盘事实块会把对的答案强行改成错的。
// 返回 { pillars: [年,月,日,时], dayMaster, orderAssumed } 或 null。
function extractPillars(text) {
  const t = String(text || '');
  if (!t) return null;

  // 日主声明 (校准 + 可信度闸共用): "日主丁火" / "丁火日主" / "丁火命"
  const dmMatch = /日主\s*[*`]*\s*([甲乙丙丁戊己庚辛壬癸])|([甲乙丙丁戊己庚辛壬癸])日[元主]|([甲乙丙丁戊己庚辛壬癸])命/.exec(t);
  const dmDeclared = dmMatch ? (dmMatch[1] || dmMatch[2] || dmMatch[3]) : null;

  // 日主闸: 正序不合试倒序, 倒序也不合 → null (抽取不可信)
  const _credible = (pillars) => {
    if (!pillars) return null;
    if (!dmDeclared || pillars[2][0] === dmDeclared) return { pillars, orderAssumed: null };
    const rev = pillars.slice().reverse();
    if (rev[2][0] === dmDeclared) return { pillars: rev, orderAssumed: '时日月年(已按日主倒序校准)' };
    return null;
  };

  // ① 显式标注: X年 X月 X日 X时 (允许间隔任意非干支字符)
  const labeled = new RegExp(
    '([' + GAN + '][' + ZHI + '])年[^' + GAN + ZHI + ']{0,12}([' + GAN + '][' + ZHI + '])月[^' + GAN + ZHI + ']{0,12}([' + GAN + '][' + ZHI + '])日[^' + GAN + ZHI + ']{0,12}([' + GAN + '][' + ZHI + '])时'
  ).exec(t);
  if (labeled) {
    const r = _credible([labeled[1], labeled[2], labeled[3], labeled[4]]);
    if (r) { r.orderAssumed = r.orderAssumed || 'labeled'; r.dayMaster = r.pillars[2][0]; return r; }
  }

  // ①b 标签在前: 年柱/月柱/日柱/时柱 各取其后第一个干支对 (表格抄盘的常见写法)
  {
    const byLabel = {};
    let allFound = true;
    for (const lab of PILLAR_LABELS) {
      const mm = new RegExp(lab + '柱[^' + GAN + ZHI + ']{0,12}([' + GAN + '][' + ZHI + '])').exec(t);
      if (!mm) { allFound = false; break; }
      byLabel[lab] = mm[1];
    }
    if (allFound) {
      const r = _credible(PILLAR_LABELS.map(l => byLabel[l]));
      if (r) { r.orderAssumed = r.orderAssumed || 'labeled(柱标签)'; r.dayMaster = r.pillars[2][0]; return r; }
    }
  }

  // ② 连续干支对窗口: 4 个干支对必须挤在 80 字内, 散布的不算一盘
  const _grab4 = (s) => {
    const re = new RegExp(GANZHI_RE.source, 'g');
    const hits = [];
    let mm;
    while ((mm = re.exec(s)) !== null) hits.push({ p: mm[0], i: mm.index });
    for (let k = 0; k + 4 <= hits.length; k++) {
      if (hits[k + 3].i - hits[k].i <= 80) return hits.slice(k, k + 4).map(h => h.p);
    }
    return null;
  };
  let pillars = null;
  const anchor = /(命局|四柱|原局|八字|命造)[^子丑寅卯辰巳午未申酉戌亥]{0,10}/.exec(t);
  if (anchor) pillars = _grab4(t.slice(anchor.index));
  if (!pillars) pillars = _grab4(t);

  const r = _credible(pillars);
  if (!r) return null;
  r.dayMaster = r.pillars[2][0];
  r.orderAssumed = r.orderAssumed || '年月日时(默认左到右)';
  return r;
}

// 生成确定性事实块。LLM 可以直接采信, 禁止凭记忆另算。
function buildFactsBlock(pillars) {
  if (!Array.isArray(pillars) || pillars.length !== 4) return '';
  const dm = pillars[2][0];

  // 天干十神 (日主不算)
  const ganGods = pillars.map((p, i) => {
    if (i === 2) return null;
    return PILLAR_LABELS[i] + '干' + p[0] + '=' + getTenGod(dm, p[0]);
  }).filter(Boolean);

  // 地支十神 (本气)
  const zhiGods = pillars.map((p, i) => {
    const z = p.slice(-1);
    const bq = ZHI_BEN_QI[z];
    // 支本气与日干同干 = 比肩 (getTenGod 对同干返回 null, 这里补上)
    const god = i === 2 ? null : (bq ? (bq === dm ? '比肩' : getTenGod(dm, bq)) : null);
    return PILLAR_LABELS[i] + '支' + z + '(本气' + bq + (god ? '=' + god : '') + ')';
  });

  // 五行统计 (天干五行 + 地支五行, 四柱都算 —— 与 _chartTruth().elementCount 同一份,
  // 不在这里另数一遍: 两处各数一遍迟早漂成两个数字)
  const wxText = Object.entries(_chartTruth(pillars).elementCount).map(([k, v]) => k + v).join(' ');

  // 地支关系 (zhis_relations 的学校规则: 冲/合/害看相邻柱)
  const rel = analyzeZhiRelations(pillars);
  const _at = (a) => (a || []).map(i => PILLAR_LABELS[i]).join('');
  const relLines = [];
  if (rel.liu_he.length) relLines.push('六合: ' + rel.liu_he.map(r => r.pair.join('') + '合(' + _at(r.at) + ')').join(' '));
  if (rel.liu_chong.length) relLines.push('六冲: ' + rel.liu_chong.map(r => r.pair.join('') + '冲(' + _at(r.at) + ')').join(' '));
  if (rel.liu_hai.length) relLines.push('六害: ' + rel.liu_hai.map(r => r.pair.join('') + '害(' + _at(r.at) + ')').join(' '));
  if (rel.san_xing.length) relLines.push('刑: ' + rel.san_xing.map(r => {
    const members = r.trio || r.pair || [];
    return members.join('') + (r.type === '自刑' ? '自刑' : '刑') + '(' + _at(r.at) + ')';
  }).join(' '));
  if (rel.san_he.length) relLines.push('三合: ' + rel.san_he.map(r => r.trio.join('') + (r.partial ? '半合' : '') + r.element + '局(' + _at(r.at) + ')').join(' '));
  if (rel.san_hui.length) relLines.push('三会: ' + rel.san_hui.map(r => r.trio.join('') + (r.partial ? '半会' : '') + r.element + '(' + _at(r.at) + ')').join(' '));
  if (rel.liu_po.length) relLines.push('破: ' + rel.liu_po.map(r => r.pair.join('') + '破(' + _at(r.at) + ')').join(' '));

  return '【排盘事实 · 本地确定性计算 (ten_gods.js + zhis_relations.js 查表, 不是模型推算)】\n'
    + '四柱(年月日时): ' + pillars.join(' / ') + ' | 日主: ' + dm + '(' + GAN_WUXING[dm] + ')\n'
    + '天干十神: ' + ganGods.join(' ') + '\n'
    + '地支十神(本气): ' + zhiGods.join(' ') + '\n'
    + '五行计数(天干五行+地支五行): ' + wxText + '\n'
    + '地支关系(相邻柱): ' + (relLines.length ? relLines.join('; ') : '无') + '\n'
    + '纪律: 以上十神/五行/合冲是查表结果, 直接采信; 禁止凭记忆另算十神 (实案: 把伤官说成"土印"、正财说成"七杀"), 禁止说原局"印旺"而五行计数里木=0。'
    + '大运/流年与原局的相互作用由你在此基础上推演, 原局本身的定性不许偏离本块。';
}

// 从本轮输入 + 近期历史里找四柱, 找到就生成事实块 (找不到返回 '')。
function buildFactsFromConversation(rawInput, messages) {
  try {
    const corpus = [String(rawInput || '')];
    for (const m of (Array.isArray(messages) ? messages : []).slice(-6)) {
      if (!m) continue;
      if (typeof m.content === 'string') corpus.push(m.content);
      // 2026-10-28: 落盘会话存的是干净正文 (主人原话), 注入版另存在 `injected`。
      //   四柱可能**只**出现在注入块里 (主人是发图不是发字) ⇒ 事实抽取要把注入版一起扫。
      if (typeof m.injected === 'string') corpus.push(m.injected);
    }
    for (const text of corpus) {
      const found = extractPillars(text);
      if (found) {
        const block = buildFactsBlock(found.pillars);
        if (block) return block + (found.orderAssumed ? '\n(四柱顺序: ' + found.orderAssumed + ')' : '');
      }
    }
    return '';
  } catch (_) { return ''; }
}

// ============================================================
// 答案核验 (2026-10-12, 老板拍"你没有修好" — 首轮纯图定稿没人核验):
// 从**答案文本**里抽四柱 → 查表算真值 → 扫描答案里的十神/旺衰断言, 逐条对账。
// 只对得上"硬伤"才报 (十神张冠李戴 / 说某神旺但该神计数为 0), 擦边表述不报, 防误伤。
// ============================================================
const GODS = ['比肩', '劫财', '食神', '伤官', '偏财', '正财', '七杀', '正官', '偏印', '正印'];
const GODS_RE = '(比肩|劫财|食神|伤官|偏财|正财|七杀|正官|偏印|正印)';

function _chartTruth(pillars) {
  const dm = pillars[2][0];
  // 2026-10-12 (e2e-812-gate-003 实测): stemGod/benqiGod/godOfElement 必须是**绝对真值** ——
  // 全部 10 天干 + 全部 12 支本气都算出来。只算四柱自带的干会漏掉大运/流年干的十神断言
  // (实测 "甲木=偏财透出" 漏检: 甲不在四柱里, 查表得 undefined 直接跳过; 丁日主甲=正印)。
  const stemGod = {};   // 任意天干 → 十神 (日主除外)
  for (const s of Object.keys(GAN_WUXING)) {
    if (s !== dm) stemGod[s] = getTenGod(dm, s);
  }
  const benqiGod = {};  // 任意地支 → 本气十神
  for (const z of Object.keys(ZHI_BEN_QI)) {
    const bq = ZHI_BEN_QI[z];
    benqiGod[z] = (bq === dm ? '比肩' : getTenGod(dm, bq));
  }
  // 十神 → 命中次数 (只数本盘四柱: 天干 + 支本气, 日柱不算 — 保持 ⑤ 旺衰计数语义不变)
  const godCount = {};
  pillars.forEach((p, i) => {
    if (i === 2) return;
    [stemGod[p[0]], benqiGod[p.slice(-1)]].forEach(g => {
      if (g) godCount[g] = (godCount[g] || 0) + 1;
    });
  });
  // 元素 → 该五行干支的十神集合 (绝对真值, "木（财）" 类 shorthand 断言的核验基准)
  const godOfElement = {};
  for (const s of Object.keys(stemGod)) {
    (godOfElement[GAN_WUXING[s]] = godOfElement[GAN_WUXING[s]] || new Set()).add(stemGod[s]);
  }
  for (const z of Object.keys(benqiGod)) {
    if (!ZHI_WUXING[z]) continue;
    (godOfElement[ZHI_WUXING[z]] = godOfElement[ZHI_WUXING[z]] || new Set()).add(benqiGod[z]);
  }
  // 元素计数 (2026-10-21, 第七批): 五行"数量"断言的核验基准。
  // 口径必须与事实块里的「五行计数」**逐字一致** (天干五行 + 地支五行, 四柱都算, 日柱也算),
  // 所以它定义在这里, buildFactsBlock 也从这里取 —— 两处各数一遍, 迟早漂成两个数字,
  // 核验门拿一个数字去判事实块里的另一个数字, 那就是把对的判成错的。
  const elementCount = { 木: 0, 火: 0, 土: 0, 金: 0, 水: 0 };
  for (const p of pillars) {
    elementCount[GAN_WUXING[p[0]]]++;
    elementCount[ZHI_WUXING[p.slice(-1)]]++;
  }
  return { dm, stemGod, benqiGod, godCount, godOfElement, elementCount };
}

// 返回硬伤清单 [{claim, expect}], 无硬伤返回 []
function findChartContradictions(text, pillars) {
  const t = String(text || '');
  if (!t || !Array.isArray(pillars) || pillars.length !== 4) return [];
  const truth = _chartTruth(pillars);
  const bad = [];
  const seen = new Set();
  const _push = (claim, expect) => {
    const k = claim + '|' + expect;
    if (!seen.has(k)) { seen.add(k); bad.push({ claim, expect }); }
  };

  // ①② 干=十神断言 (合并原①②, 2026-10-12 gate-003 漏检实案后扩展):
  // 允许 干 + 可选五行字 + 可选[=为是：:] + 可选括号 + 十神 ——
  // 覆盖 "戊=伤官" / "庚金七杀" / "时干庚（偏财）" / "甲木 = 偏财透出" / "丑中癸（正官暗藏）"。
  // 分隔符全可选是有意的: 这类连写在命盘答案里几乎必是十神断言; 干与神之间出现句号等
  // 强分隔就不会命中, 防误伤。
  const p1 = new RegExp('([甲乙丙丁戊己庚辛壬癸])[木火土金水]?\\s*(?:[=为是：:]\\s*)?[（(]?\\s*' + GODS_RE, 'g');
  let m;
  while ((m = p1.exec(t)) !== null) {
    const [, stem, god] = m;
    if (stem === truth.dm) continue;
    const real = truth.stemGod[stem];
    if (real && god !== real) _push(m[0].trim() + ' (干' + stem + ')', stem + '=' + real);
  }
  // ③ 表格十神行: "| 十神 | 食神 | 伤官 | 丁火 | 偏财 |" (列序 = 年月日时)
  const p3 = /\|\s*十神[^|]*\|([^\n]+)\|/g;
  while ((m = p3.exec(t)) !== null) {
    const cells = m[1].split('|').map(s => s.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    [0, 1, 3].forEach(ci => {
      const god = GODS.find(g => cells[ci] === g || cells[ci].endsWith(g));
      if (!god) return;
      const real = truth.stemGod[pillars[ci][0]];
      if (real && god !== real) _push('表格' + PILLAR_LABELS[ci] + '柱十神=' + god, PILLAR_LABELS[ci] + '柱' + pillars[ci][0] + '=' + real);
    });
  }
  // ④ 元素+神 shorthand: "土印" "金财" "土（印过重" "木（财，疏土" (实案: 土印 — 土=伤官/食神, 盘里没有印;
  // gate-003: 括号隔开的形式漏检)。核验基准是绝对真值 (该五行的全部干支十神), 不只看本盘出现的。
  const p4 = /([木火土金水])\s*[（(]?\s*(印|财)(?![签名])/g;
  while ((m = p4.exec(t)) !== null) {
    const [, wx, sh] = m;
    const want = sh === '印' ? ['正印', '偏印'] : ['正财', '偏财'];
    const got = truth.godOfElement[wx];
    const hit = got && want.some(g => got.has(g));
    if (!hit) _push(wx + sh, wx + '的干支里没有' + sh + '星 (' + (got ? [...got].join('/') : '该五行不出现') + ')');
  }
  // ⑤ 旺衰断言 vs 计数为 0: "印旺" "财星很重" "食伤旺" "印多" — 该神在命局计数=0 就是硬伤
  const p5 = /(正印|偏印|正财|偏财|七杀|正官|食神|伤官|比肩|劫财|食伤|官杀|印|财)(?:星|星象)?\s*(旺|很重|重重|多)/g;
  while ((m = p5.exec(t)) !== null) {
    // 否定语境豁免 (gate-005 实案): "不能称'印旺'" "谈不上印旺" 是在否定, 不是断言 — 不许误报
    const before = t.slice(Math.max(0, m.index - 5), m.index);
    if (/[不无非未莫勿]/.test(before)) continue;
    const g = m[1];
    const members = g === '印' ? ['正印', '偏印'] : g === '财' ? ['正财', '偏财']
      : g === '食伤' ? ['食神', '伤官'] : g === '官杀' ? ['七杀', '正官'] : [g];
    const cnt = members.reduce((n, x) => n + (truth.godCount[x] || 0), 0);
    if (cnt === 0) _push(g + m[2], '命局里' + members.join('/') + '计数=0, 谈不上' + m[2]);
  }
  // ⑥ 地支+括号十神断言 (gate-002 实案 "子（正财）"): 支的本气十神是查表真值。
  // 只认全名十神, 单字 shorthand ("子（官）" — 官可泛指官杀) 不报, 防误伤。
  const p6 = new RegExp('([子丑寅卯辰巳午未申酉戌亥])\\s*[（(]\\s*' + GODS_RE, 'g');
  while ((m = p6.exec(t)) !== null) {
    const [, zhi, god] = m;
    // 干支连写 + 括号里两个十神 ("2027丁未（正印、劫财）") 是**干支各一个**的写法,
    //   括号里头一个对应**天干**。拿支本气去判它 = 把对的判成错的 (E2E 实跑实句)。
    const prev = m.index > 0 ? t[m.index - 1] : '';
    if (GAN.indexOf(prev) >= 0) {
      const realGan = truth.stemGod[prev];
      if (realGan && god !== realGan) _push(prev + zhi + '（' + god + '）', prev + '干=' + realGan);
      continue;
    }
    const real = truth.benqiGod[zhi];
    if (real && god !== real) _push(zhi + '（' + god + '）', zhi + '本气=' + real);
  }
  // ⑦ "日主坐X / 坐X" 断言 (gate-003 实案 "日主坐印" — 日支丑本气己=食神, 不是印):
  // 命理行话里"坐X"专指日支本气。单字 shorthand 印/财/官 也验, 官接受正官/七杀两种。
  const p7 = /坐\s*(正印|偏印|正财|偏财|正官|七杀|食神|伤官|比肩|劫财|印|财|官)/g;
  while ((m = p7.exec(t)) !== null) {
    const g = m[1];
    const real = truth.benqiGod[pillars[2].slice(-1)];
    if (!real) continue;
    const ok = g === '印' ? (real === '正印' || real === '偏印')
      : g === '财' ? (real === '正财' || real === '偏财')
      : g === '官' ? (real === '正官' || real === '七杀')
      : g === real;
    if (!ok) _push('坐' + g, '日支' + pillars[2].slice(-1) + '本气=' + real);
  }
  // ⑧ 五行"数量"断言 vs 查表计数 (2026-10-21 第七批, E2E 实跑逼出来的):
  //   答案写 "土 4（强）/ 水 2 / 木 0（不成立）" 这种, 数字是**可查的** —— 四柱干支各算一次,
  //   对不上就是硬伤。而这一条原来**完全没人查**, 数字写错照样出门。
  //   基准用 _chartTruth().elementCount, 跟事实块里的「五行计数」同一份数字 (不许各数一遍)。
  //   非本命盘语境 (大运/流年…) 让路: "2026 丙午年, 火 1" 说的是流年不是原局。
  const p8 = /([木火土金水])\s*(?:有|共|计|为|剩|余)?\s*(\d+)\s*个/g;
  while ((m = p8.exec(t)) !== null) {
    if (nonNativeContext(t, m.index)) continue;
    // 藏干口径让路: "木 1（乙藏于两未）" 说的是藏干, 与事实块的"天干五行+地支五行"
    // 不是同一把尺 —— 拿整数计数去判带权重的藏干数, 是把对的判成错的 (E2E 实跑实句)。
    if (/藏/.test(t.slice(m.index, m.index + 24))) continue;
    const wx = m[1], said = Number(m[2]);
    const real = truth.elementCount[wx];
    if (real === undefined || said === real) continue;
    _push(wx + m[2] + '个', wx + '实际 ' + real + ' 个 (四柱天干五行+地支五行)');
  }
  // ⑧b "土 4（强）" 这种 数字+括注 的写法 (E2E 原句就是这个形状)
  const p8b = /([木火土金水])\s*(\d+)\s*[（(]/g;
  while ((m = p8b.exec(t)) !== null) {
    if (nonNativeContext(t, m.index)) continue;
    if (/藏/.test(t.slice(m.index, m.index + 24))) continue;
    const wx = m[1], said = Number(m[2]);
    const real = truth.elementCount[wx];
    if (real === undefined || said === real) continue;
    _push(wx + m[2], wx + '实际 ' + real + ' 个 (四柱天干五行+地支五行)');
  }
  // ⑨ 喜用/忌 自相矛盾 (2026-10-21 第七批, E2E 实跑逼出来的):
  //   同一份答案里既写 "喜用：土、木" 又写 "忌：土" —— 元素同时在两边的名单里,
  //   这不是命理分歧, 是**文本内部自相矛盾**, 不需要任何术数判断就能判。
  //   刻意**不**查 "喜用某五行" 对不对: 子平常用神恰恰可以是盘里没有的五行 (调候/补缺),
  //   把 "喜木" 当错来判 = 把真结论判死 (grounding_check 立时就写下的规矩)。
  // 元素抽取: **跳过括号里的字** —— "木（疏土、通官）" 括注里的"疏土"是解释, 不是喜用土。
  //   第一版把整段当元素列表, 于是"喜用：木（疏土）" 会把土也收进喜用集合, 跟"忌土"一撞
  //   就报一个根本不存在的矛盾。
  const _elsIn = (win) => {
    let flat = '';
    let depth = 0;
    for (const ch of String(win)) {
      if (ch === '(' || ch === '（') depth++;
      else if (ch === ')' || ch === '）') { if (depth > 0) depth--; }
      else if (depth === 0) flat += ch;
    }
    const out = new Set();
    for (const w of flat.split(/[^\u4e00-\u9fa5]+/)) if (/^[木火土金水]$/.test(w)) out.add(w);
    return out;
  };
  // 标签扫描: 标签 → 取后面的窗口 → 抽元素。
  //   窗口必须**有边界**: 遇到句末或下一个喜忌标签就停 —— 不设窗口的话
  //   "喜用：木。忌：土。" 里"喜用"的窗口会把"忌"的土也收进去, 凭空造出一个矛盾。
  const LABEL_RE = /(喜用神|喜用|喜神|用神|取用|喜|忌神|忌用|忌讳|忌|不宜用|不可用)/g;
  const WINDOW_STOP_RE = /[。！？；;\n，,]|(?:喜用神|喜用|喜神|用神|取用|喜|忌神|忌用|忌讳|忌|不宜用|不可用)/;
  // 按**块**分组再比, 不做全局比对:
  //   合婚/双人对比的答案里, "男方 喜用木、忌火" 和 "女方 喜用火、忌木" 分处两个块,
  //   全局一比就成了"木和火都同时被列两边" —— 那是**两个人**, 不是自相矛盾。
  //   块边界: 空行 / markdown 标题行 / 表格行。同一块里还分不清是谁的, 那就不判 (宁可漏检)。
  const BLOCK_BOUNDARY_RE = /(?:\n[ \t]*\n)|(?:\n[ \t]*#{1,6}[ \t])|(?:\n[ \t]*\|)/g;
  const _blockStart = (text, index) => {
    const seg = text.slice(0, index);
    BLOCK_BOUNDARY_RE.lastIndex = 0;
    let cut = 0, mm;
    while ((mm = BLOCK_BOUNDARY_RE.exec(seg)) !== null) cut = mm.index;
    return cut;
  };
  const _joy = new Map(), _ji = new Map();
  const _classify = (label) => (/忌|不宜|不可/.test(label) ? 'ji' : (/喜|用|取/.test(label) ? 'joy' : null));
  // 单趟扫, 每个标签**互斥**归一类。
  //   第一版跑了两趟 ("是喜就收 joy, 否则收 ji"), 于是"喜用"那趟的窗口被忌那趟又收了一遍,
  //   "喜用：木（疏土）。忌：土。" 凭空多出一个"木"的矛盾 —— 守卫自己造矛盾, 比不查更坏。
  {
    LABEL_RE.lastIndex = 0;
    let mm;
    while ((mm = LABEL_RE.exec(t)) !== null) {
      if (nonNativeContext(t, mm.index)) continue;
      const kind = _classify(mm[1]);
      if (!kind) continue;
      const rest = t.slice(mm.index + mm[1].length);
      const stop = rest.search(WINDOW_STOP_RE);
      const win = stop === -1 ? rest.slice(0, 40) : rest.slice(0, stop);
      const target = kind === 'joy' ? _joy : _ji;
      const key = _blockStart(t, mm.index);
      if (!target.has(key)) target.set(key, new Set());
      _elsIn(win).forEach(x => target.get(key).add(x));
    }
  }
  for (const [key, joyEls] of _joy) {
    const jiEls = _ji.get(key);
    if (!jiEls) continue;
    for (const wx of joyEls) {
      if (jiEls.has(wx)) _push('喜用与忌都列了' + wx, wx + '不能同时是喜用和忌神 (同一份答案自相矛盾)');
    }
  }
  return bad;
}

module.exports = {
  extractPillars, buildFactsBlock, buildFactsFromConversation, findChartContradictions, ZHI_BEN_QI,
  // 文本级断言的公共底座 (chart_fidelity 复用, 不许在那边另写一份)
  sentenceBefore, nativeScopeText, nonNativeContext, NON_NATIVE_CHART_RE,
};
