'use strict';
// gua_answer_gate.js — 卦象类答案的出门核验门 (2026-10-21, 第九批)
//
// 立这条是因为第八批那次实跑: 主人问"帮我看看第24卦", 盘古答"贲卦"。
// 根因查出来是两件事, 这道门只管得住第二件:
//   ① `hexagram_lookup` 够不着 → 已修 (第八批, 进 li/kun/dui/xun 白名单 + 提示写明)
//   ② **没有任何东西核过卦序/卦辞这类断言** —— 八字侧早就有 `chart_answer_gate`,
//      卦侧一直是空的。模型就算调了工具, 也可能把拿到的数据写错 (第八批实测就写过
//      "雷地复"(应为地雷复) 和 "爻辞七条"(单卦恒六爻))。**工具够得着 ≠ 答案对。**
//
// 与命盘门同构: 本地查表真源(64i)当基准 → 有硬伤带事实块重修一轮 → 再核 → 残余附诚实标注。
// 重修那一段共用 modules/fact_repair.js (那段逻辑里有个栽过一次的判据, 不许抄两份)。
//
// 只查**能定死**的四类, 文本级规则宁可漏检不可误伤:
//   ① 卦序 ↔ 卦名   —— 第N卦是哪一卦 / 某卦是第N卦 (第八批那个真 bug)
//   ② 卦象名构成     —— 「雷地复」这种上下卦写反/写错 (实测真答案里出现过)
//   ③ 单卦爻数       —— 单卦恒六爻, 写七爻就是错 (实测真答案里出现过)
//   ④ 卦辞/爻辞张冠李戴 —— 引的原文其实属于**另一卦**(定死型判据, 不猜语气)
// 每一条的判据都是"跟 64i 真源对不上", 不是"我觉得不像"。

const idx = require('../64i/index.js');
const { repairWithFacts, withWarning } = require('./fact_repair');
// 第 46 批: 象义的身份标签 —— 标签字面量只在 gua_block.js 定义一次, 这里只引用。
//   为什么标签在**值后面**而不是前面: 既有测试断言 `/卦义 贲饰/`(值紧跟在「卦义」后),
//   标签插在中间会撞断言; 而且「卦义 贲饰〔象义整理…〕」读起来也更顺 ——
//   先给内容, 再给身份。
const { XIANG_YI_TAG } = require('./gua_block');

const HEXAGRAMS = idx.listHexagrams();
// 长名优先, 否则「既济」会被更短的候选先截掉
const NAMES_ALT = HEXAGRAMS.map(h => h.name).sort((a, b) => b.length - a.length).join('|');
const BY_NAME = {};
for (const h of HEXAGRAMS) BY_NAME[h.name] = h;

// 卦符 → 卦象名。卦象名的成法是「上卦象 + 下卦象 + 卦名」:
//   复卦 上坤(地) 下震(雷) → 地雷复 ; 泰卦 上坤(地) 下乾(天) → 地天泰
//
// ⚠️ 象名的**唯一真源**是八卦公理表的 nature 字段(震→雷, 艮→山 …),
//   本文件原来自己抄了一张表 —— 抄的迟早只改其中一份(项目铁律)。
//   2026-10-22 收进 64i/hexagrams.js 的 xiangNameOf(), 门与工具共用同一份。
const BAGUA_AXIOMS = require('../64i/bagua_annotations/bagua_axioms').BAGUA_AXIOMS;
// 2026-10-22 (第 33 批): 纳甲只认真纳甲(64i/bagua_annotations/najia.js)。
//   以前这里打的是 `h.najia`(64i/hexagrams.js 的 najia 字段), 那**不是纳甲表** ——
//   它是 60 甲子按卦序的机械循环(坤卦打成「乙丑」, 真纳甲是「乙未」)。
//   而这块事实卡**紧跟着**「禁止凭记忆另写」那句 ⇒ 模型会把它当权威采信,
//   拿一个错的纳甲去纠别人。改口比不改更坏: 它说「这是纳甲」。
const NAJIA = require('../64i/bagua_annotations/najia.js');
const XIANG_OF = {};
for (const b of BAGUA_AXIOMS) XIANG_OF[b.name] = b.nature;
const expectedXiang = h => (XIANG_OF[h.trigrams.upper_name] || '?') + (XIANG_OF[h.trigrams.lower_name] || '?');

// 象名 → 卦名 (一个象名只对应一个纯卦: 雷=震, 泽=兑, 天=乾 …)
const PURE_BY_XIANG = {};
for (const h of HEXAGRAMS) {
  if (h.trigrams.upper_name === h.trigrams.lower_name) {
    PURE_BY_XIANG[XIANG_OF[h.trigrams.upper_name]] = h;
  }
}
/**
 * 这一卦**该怎么称** —— 卦象名的正确写法。
 *
 * ⚠️ 别用 expectedXiang(h) 拼: 那是「上象+下象」的**原材料**, 对纯卦不成立 ——
 *   震卦 上震下震 → expectedXiang = "雷雷" → 拼出来「雷雷震」, 而正确写法是「**震为雷**」。
 *   这个错误一度就躺在事实块里 (buildGuaFactsBlock), 等于让重修稿照着一句错话改 ——
 *   事实块给的是**基准**, 基准自己错了, 整道门就跟着错。
 *
 * 现在真源在 64i/hexagrams.js 的 xiangNameOf() (工具输出与门共用同一份)。
 */
const correctXiangName = require('../64i/hexagrams').xiangNameOf;

// 合法卦象名集合 (64 个, 全部由 64i 真源算出来, 不手写):
//   非纯卦 = 上象 + 下象 + 卦名 (山火贲 / 地雷复 / 风天小畜)
//   纯  卦 = 卦名 + 为 + 象     (震为雷 / 乾为天)
// 集合里**没有**「象+象+象」这种形状 —— 这就是 ②b 的判据来源。
const VALID_XIANG_NAME = new Set(HEXAGRAMS.map(correctXiangName));
const XIANG_CHARS = '天地水火风雷山泽';

// (上象+下象) → 卦 —— 由 64i 真源反查, 不手写
const BY_TRIGRAM_PAIR = {};
for (const h of HEXAGRAMS) {
  BY_TRIGRAM_PAIR[XIANG_OF[h.trigrams.upper_name] + XIANG_OF[h.trigrams.lower_name]] = h;
}

// 比的应该是内容不是排版: 各家标点不同 (,，。) 一律抹掉
const norm = s => String(s || '').replace(/[^一-龥0-9]/g, '');

// 卦辞/爻辞原文 → 归属卦。用归一后前 8 字做键, 够长不会撞。
const GUA_CI_OWNER = new Map();
for (const h of HEXAGRAMS) {
  const k = norm(h.gua_ci).slice(0, 8);
  if (k && !GUA_CI_OWNER.has(k)) GUA_CI_OWNER.set(k, h.id);
}
const YAO_CI_OWNER = new Map();
for (const h of HEXAGRAMS) {
  for (const y of (h.yao_ci || [])) {
    // 爻辞原文带爻位前缀("六二：贲其须"), 引用时通常不带 → 建键时剥掉
    const k = norm(String(y).split('：')[1] || y).slice(0, 8);
    if (k && !YAO_CI_OWNER.has(k)) YAO_CI_OWNER.set(k, h.id);
  }
}

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 文中每一次「卦名卦」出现的位置, 按位置排好。 */
function _mentions(t) {
  const out = [];
  for (const m of t.matchAll(new RegExp('(' + NAMES_ALT + ')\\s*卦', 'g'))) {
    if (BY_NAME[m[1]]) out.push({ name: m[1], id: BY_NAME[m[1]].id, at: m.index });
  }
  return out.sort((a, b) => a.at - b.at);
}
/**
 * 某位置之前**最近**的那个卦名。
 * 不用固定字符窗口: 爻辞常排成一张六行的表, 卦名在表头, 隔着上百字 ——
 * 窗口开到那么大误伤风险高, 开小了又漏。"最近提及"与排版无关。
 */
function _nearestMention(ms, pos) {
  let best = null;
  for (const m of ms) if (m.at < pos) best = m;
  return best;
}

/**
 * 找出答案里与 64i 真源冲突的卦象断言。
 * @returns {Array<{kind:string, claim:string, expect:string, guaIds:number[]}>}
 */
function findGuaContradictions(text) {
  const t = String(text || '');
  if (!t) return [];
  const out = [];
  const push = o => { if (!out.some(x => x.claim === o.claim)) out.push(o); };
  const inRange = n => n >= 1 && n <= 64;

  // ① 第N卦 … 卦名 (窗口只跨一句, 跨句的"第N卦…某卦"多半不是同一个断言)
  //
  // ⚠️ 名字后面**必须跟一个「卦」字**, 这不是格式洁癖, 是被真实答案打回来的:
  //   重修稿里一句「核实并给出第24卦全套卦爻资料与**解读**」——
  //   「解读」的「解」正好是一卦的名字(解卦 id=40), 旧写法把它当成了「第24卦是解卦」,
  //   于是一份**完全正确**的重修稿被自己判成残余硬伤, 白挂一个 ⚠️。
  //   单字卦名(比/复/解/师/困/井/革/升/屯/剥)本来就常是普通词的一部分
  //   (对比/恢复/解读/老师/困难/水井/革命/上升), 所以单字名一律要求带「卦」。
  //   代价: 「第24卦是贲」这种不带「卦」的写法会漏 —— 漏检可以接受, 误伤不行。
  //
  // 窗口怎么开是被真答案打回来的第二次: 收紧时把 `：` 也划成了断句符, 结果
  // 「**周易·第24卦：贲卦**」这种最常见的标题体反被抓不到了。
  // 正确的切法是**位置**而不是**标点**: 卦序和卦名之间要么就是纯分隔符
  // (标题体「第24卦：贲卦」/「第24卦=贲卦」), 要么紧挨着一小段内容(≤12字),
  // 两种都要求卦名后面必须带「卦」。逗号可以进内容窗, 但「跨一句」还是不行。
  const CLAUSE_STOP = '。；;\n';
  const ORDER_RE = new RegExp(
    '第\\s*(\\d{1,2})\\s*卦(?:[ \\t]*[:：=＝~～—\\-]+[ \\t]*|[^' + CLAUSE_STOP + '，,]{0,12}?)(' + NAMES_ALT + ')\\s*卦', 'g');
  for (const m of t.matchAll(ORDER_RE)) {
    const id = Number(m[1]);
    if (!inRange(id)) continue;
    const real = idx.getHexagram(id);
    if (real && real.name !== m[2]) {
      // 三个都带上: 查到的真值、草稿说的那个 —— 事实块要**同时**告诉模型
      // "第24卦是复"和"贲其实是22", 少一个它就不知道该往哪改。
      push({ kind: 'order', guaIds: [id, real.id, BY_NAME[m[2]].id], claim: '第' + id + '卦写成' + m[2] + '卦',
        expect: '卦序 ' + id + ' 实为 ' + real.name + '卦' });
    }
  }
  // ①b 卦名 … 第N卦
  for (const m of t.matchAll(new RegExp('(' + NAMES_ALT + ')\\s*卦[^。；;\\n]{0,6}?第\\s*(\\d{1,2})\\s*卦', 'g'))) {
    const id = Number(m[2]);
    if (!inRange(id)) continue;
    const real = idx.getHexagram(id);
    if (real && real.name !== m[1]) {
      push({ kind: 'order', guaIds: [id, BY_NAME[m[1]].id], claim: m[1] + '卦说成第' + id + '卦',
        expect: m[1] + '卦的卦序是 ' + real.id });
    }
  }

  // ② 卦象名 = 上象+下象+卦名
  for (const m of t.matchAll(new RegExp('([天地水火风雷山泽]{2})(' + NAMES_ALT + ')', 'g'))) {
    const h = BY_NAME[m[2]];
    if (!h) continue;
    const exp = expectedXiang(h);
    if (m[1] !== exp) {
      push({ kind: 'xiang', guaIds: [h.id], claim: m[2] + '卦写成「' + m[1] + m[2] + '」',
        expect: m[2] + '卦是上' + h.trigrams.upper_name + '下' + h.trigrams.lower_name + ', 应称「' + exp + m[2] + '」' });
    }
  }

  // ②b 卦象名的第三字是**象名** —— 「地天雷」这一类
  //
  // 2026-10-21 现场原文 (第22卦那一份, 存 ~/.pangu/state/ledger/b9-collect-1-*.json):
  //   「纳甲：地天雷/艮宫（乙酉）」
  //   贲卦(22) 上艮下离 → 卦象名该是「山火贲」; 艮宫、乙酉 都对, 「地天雷」是编的。
  // 为什么 ② 抓不到: ② 的形状是「象+象+**卦名**」, 而这里第三字「雷」是**象名**不是卦名 ——
  //   规则压根不匹配, 这条硬伤从门缝里溜过去了 (第九批钉成「已知漏检」, 挂了两批)。
  //
  // 判据: **卦象名从来没有「象+象+象」这种形状**。
  //   非纯卦 = 上象+下象+卦名 (山火贲); 纯卦 = 卦名+为+象 (震为雷)。两者都不是象象象。
  // 所以「象+象+象」三字组 = 恒错 —— 不猜语气不猜排版, 定死型判据。
  //
  // 误伤防线 (象名连排): 先天八卦序「天泽火雷风山水地」是一整串象名, 不是卦象名。
  //   规则: 象名**连排 ≥ 4 个**的整段跳过 (那是八卦列举), 只查孤立的正好 3 个。
  //   残留误伤面: 恰好 3 个连排又被拆开的八卦列举 —— 罕见, 代价是一次重修。
  for (const m of t.matchAll(new RegExp('([' + XIANG_CHARS + ']{3})', 'g'))) {
    const triple = m[1];
    const at = m.index;
    let before = 0, after = 0;
    for (let i = at - 1; i >= 0 && XIANG_CHARS.includes(t[i]); i--) before++;
    for (let i = at + 3; i < t.length && XIANG_CHARS.includes(t[i]); i++) after++;
    if (before + 3 + after >= 4) continue;            // 八卦列举, 整段跳过
    if (VALID_XIANG_NAME.has(triple)) continue;       // 象象象 不在合法集合里, 这里是保险
    // 后面紧跟一个卦名 → 那是 ② 的形状 (象象卦名), ② 已用更准的话报过, 不重复报
    const tail = t.slice(at + 3, at + 3 + 4);
    const tailName = NAMES_ALT.split('|').find(nm => tail.startsWith(nm));
    if (tailName && BY_NAME[tailName]) continue;
    const implied = BY_TRIGRAM_PAIR[triple.slice(0, 2)];   // 前两字 → 那个卦
    const pure = PURE_BY_XIANG[triple[2]];                  // 第三字 → 那个纯卦
    push({
      kind: 'xiang3',
      guaIds: [implied && implied.id, pure && pure.id].filter(Boolean),
      claim: '「' + triple + '」不是任何一卦的卦象名',
      expect: (implied ? triple.slice(0, 2) + ' = 上' + implied.trigrams.upper_name + '下' + implied.trigrams.lower_name
        + ' = ' + implied.name + '卦, 应称「' + correctXiangName(implied) + '」' : '')
        + (pure ? '; 而「' + triple[2] + '」是 ' + pure.name + '卦的象 (纯卦卦象名 = ' + pure.name + '为' + triple[2] + ')' : '')
        + ' —— 卦象名只有两种形状: 上象+下象+卦名, 或 纯卦的 卦名+为+象',
    });
  }

  // ③ 单卦永远六爻
  for (const m of t.matchAll(/(爻辞|爻文)\s*([一二三四五六七八九十]|\d+)\s*条/g)) {
    const n = CN_NUM[m[2]] !== undefined ? CN_NUM[m[2]] : Number(m[2]);
    if (n && n !== 6) {
      push({ kind: 'yao', guaIds: [], claim: '爻辞条数写成' + n + '条', expect: '单卦恒为六爻, 爻辞 6 条' });
    }
  }
  for (const m of t.matchAll(new RegExp('(' + NAMES_ALT + ')\\s*卦[^。；;\\n]{0,8}?([一二三四五六七八九]|\\d)\\s*爻', 'g'))) {
    const n = CN_NUM[m[2]] !== undefined ? CN_NUM[m[2]] : Number(m[2]);
    if (n && n !== 6) {
      push({ kind: 'yao', guaIds: [BY_NAME[m[1]].id], claim: m[1] + '卦写成' + n + '爻', expect: m[1] + '卦恒为六爻' });
    }
  }

  // ④ 引的原文属于**另一卦** —— 定死型判据, 不猜语气不猜排版
  const ms = _mentions(t);
  for (const m of t.matchAll(/[「『"']\s*([^」』"'\n]{3,60}?)\s*[」』"']/g)) {
    const k = norm(m[1]).slice(0, 8);
    if (!k) continue;
    const near = _nearestMention(ms, m.index);
    if (!near) continue;
    const gOwner = GUA_CI_OWNER.get(k);
    if (gOwner && gOwner !== near.id) {
      push({ kind: 'quote', guaIds: [near.id, gOwner],
        claim: near.name + '卦的卦辞写成「' + m[1].slice(0, 16) + '…」',
        expect: '那是 ' + idx.getHexagram(gOwner).name + '卦的卦辞' });
      continue;
    }
    const yOwner = YAO_CI_OWNER.get(k);
    if (yOwner && yOwner !== near.id) {
      push({ kind: 'quote', guaIds: [near.id, yOwner],
        claim: near.name + '卦的爻辞写成「' + m[1].slice(0, 16) + '…」',
        expect: '那是 ' + idx.getHexagram(yOwner).name + '卦的爻辞' });
    }
  }

  return out;
}

/** 事实块: 把涉及的卦的 64i 真值整份端出来, 让重修稿照着改。 */
function buildGuaFactsBlock(contradictions) {
  const ids = new Set();
  for (const c of (contradictions || [])) for (const id of (c.guaIds || [])) ids.add(id);
  if (!ids.size) return '64i 真源: 卦序 1..64 文王序 (乾=1 坤=2 … 既济=63 未济=64)。';
  const lines = ['64i 真源 (卦序 1..64 文王序) 相关卦:'];
  for (const id of Array.from(ids).sort((a, b) => a - b)) {
    const h = idx.getHexagram(id);
    if (!h) continue;
    lines.push([
      '- 卦序 ' + h.id + ' = ' + h.name + '卦（' + h.symbol + '）',
      '卦象名 ' + correctXiangName(h) + '（上' + h.trigrams.upper_name + ' 下' + h.trigrams.lower_name + '）',
      // 卦义(nature)与卦象名是**两样东西**, 名字都带「象」, 最容易混:
      //   卦象名 = 上象+下象+卦名 (山火贲) —— 卦的**构成**象
      //   卦义   = 序卦传「贲者饰也」 (贲饰)   —— 卦的**义**象
      // 不给这一行, 模型只能凭记忆补 —— 「地天雷」那类编造就是这么来的。
      // 第 46 批: 卦义带身份标签。象义**有典籍根**(序卦传「贲者饰也」这类),
      //   但**关键词组合是象义课程整理的** —— 不标的话模型照着当经典原文讲。
      //   标签放值后面: 既有的 `/卦义 贲饰/` 断言不许撞。
      '卦义 ' + (h.nature || '—') + '（' + ((h.keywords || []).join('、') || '—') + '）' + XIANG_YI_TAG,
      '五行 ' + h.elements + '，八宫 ' + h.bagong + '，纳甲 ' + (function () {
        const r = NAJIA.getYaoGanzhi(h.id, 1);
        return r.ok ? r.ganzhi + '(初爻, 真纳甲)' : '—(本卦六爻地支真源没有, 装不出)';
      })()
        + '(真纳甲: 八卦纳甲天干 8/8 有真源, 爻级地支 8/8 卦齐全(乾、坤来自本地文本真源, '
        + '震巽坎离艮兑来自外部四源交叉验证) ⇒ 384/384 爻位都装得出干支, 无缺口; '
        + '64i 的 najia 字段是 60 甲子机械循环、**不是纳甲表**, 别引用)',
      '卦辞：' + h.gua_ci,
      '爻辞（恒六爻）：',
    ].join('\n    '));
    (h.yao_ci || []).forEach(y => lines.push('    ' + y));
  }
  lines.push('纪律: 卦序/卦辞/爻辞/卦象名/卦义一律以上面 64i 为准, 禁止凭记忆另写。'
    + '卦序是 1..64 文王序(乾=1 坤=2 … 既济=63 未济=64); '
    + '另有一套 0..63 二进制索引(上卦三位‖下卦三位, 乾=63 坤=0), 两者在 1..63 上完全重叠, '
    + '混用会整卦错位, 一律用上面的卦序。'
    + '单卦恒为六爻, 不存在七爻。单卦的爻位是初/二/三/四/五/上。');
  return lines.join('\n');
}

/**
 * 卦象答案的出门核验。答对了零开销 —— 只有检出硬伤才多花一次 LLM 调用。
 * @returns {Promise<{text:string, checked:boolean, repaired:boolean, contradictions:Array}>}
 */
async function verifyAndRepairGuaAnswer(answerText, askFn) {
  const text = String(answerText || '');
  if (!text || typeof askFn !== 'function') {
    return { text, checked: false, repaired: false, contradictions: [] };
  }
  try {
    const contradictions = findGuaContradictions(text);
    if (!contradictions.length) return { text, checked: true, repaired: false, contradictions: [] };
    console.log('[GUA_GATE] contradictions=' + contradictions.length + ' -> repair round; first: ' + contradictions[0].claim);

    const out = await repairWithFacts({
      draft: text,
      contradictions,
      factsBlock: buildGuaFactsBlock(contradictions),
      truthNote: '卦序一律用 1..64 文王序 (乾=1 坤=2)。本工具不收 0 基二进制索引 (乾=63 坤=0 那套)。',
      label: 'GUA_GATE',
      ask: askFn,
      findResidual: findGuaContradictions,
    });
    if (!out.repaired) {
      return { text: withWarning(text, contradictions, '重修失败'), checked: true, repaired: false, contradictions };
    }
    if (out.residual.length) {
      return { text: withWarning(out.text, out.residual, '重修稿仍有不一致'), checked: true, repaired: true,
        contradictions, residual: out.residual };
    }
    return { text: out.text, checked: true, repaired: true, contradictions };
  } catch (_) {
    return { text, checked: false, repaired: false, contradictions: [] };
  }
}

module.exports = {
  findGuaContradictions,
  buildGuaFactsBlock,
  verifyAndRepairGuaAnswer,
  expectedXiang,
};
