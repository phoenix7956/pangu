'use strict';

/**
 * gua_engine.js — 盘古真起卦引擎 (2026-08-03 老板拍板: 真·梅花易数, 按<instructor>课件规矩)
 *
 * 旧版问题 (2026-08-02 初版是伪梅花):
 *   1) 用公历 Y+M+D — 正统梅花用农历 (年支数+农历月+农历日)
 *   2) 用 24 小时 H — 正统用时支数 (子1丑2...亥12)
 *   3) 混 question 哈希 — 正统时间起卦同时辰同卦, 变化靠报数/外应, 不混哈希
 *   4) 缺体用生克/互卦 — 梅花核心断法
 *
 * 现在 (两法):
 *   数字起卦法 (老板报数, 课件主推):
 *     上卦 = n1 % 8 || 8, 下卦 = n2 % 8 || 8, 动爻 = (n1+n2+时支数) % 6 || 6
 *   时间起卦法 (默认, 农历):
 *     上卦 = (年支数+农历月+农历日) % 8 || 8
 *     下卦 = (年支数+农历月+农历日+时支数) % 8 || 8
 *     动爻 = (年支数+农历月+农历日+时支数) % 6 || 6
 *   八卦取先天伏羲序: 1乾 2兑 3离 4震 5巽 6坎 7艮 8坤 (余 0 = 8 坤)
 *
 * 体用 (课件): 动爻 1-3 → 下卦为用/上卦为体; 动爻 4-6 → 上卦为用/下卦为体
 * 吉凶表 (照抄课件):
 *   用生体 大吉 90% 事必成 | 体用比合 次吉 70% 事易成 | 体克用 中吉 40-60% 事可成
 *   体生用 小凶 30% 事难成 | 用克体 大凶 10% 事不成
 */

const yaoModels = require('../64i/yao_models');
const hexagrams = require('../64i/hexagrams');
const hexagramVector = require('../64i/hexagram_vector');
// 2026-10-22: 爻向量自洽守卫 (爻名 vs 爻五行 说的是不是同一爻)。
//   顶层 require 是安全的 —— 该模块**不在 load 期抛**。
//   (上一版把自检放在 load 期抛, 结果 gua_engine 只能 try/catch 包着,
//    **自检被整个吞掉**, 守卫带着「装时自检」的名号却一道都没跑成。
//    抛错挪到了启动链 pangu-single.js, 一次性、可见、有失败现场。)
const yaoConsistency = require('./yao_vector_consistency.js');
// 2026-10-22: 京房八宫 64 卦表 (卦层 · 占筮结构层)。
//   宫/宫位/世应是**卦的结构**, 跟爻动无关, 也不做生克强弱判定 ——
//   所以放在引擎输出里是安全的, 不违反爻层边界(那条禁的是「爻动上再叠五行」)。
//   ⚠️ 跟 64i/hexagrams.js 的 `bagong` 字段**不是一回事**:
//      那个是「上卦所属纯卦(上卦分组)」, 这个才是京房的宫。
const jingfangBagong = require('../64i/bagua_annotations/jingfang_bagong.js');
// 2026-10-23 第 70 批: 大象辞的**身份标签**跟数据一起走。
//   为什么在引擎这一层(require)而不是各渲染点各写一份:
//   · 标签字面量只在 gua_block.js 定义一次 —— 各处手写会漂
//     (第 46 批踩过: 出处台账写「渲染点带了标签」, 渲染点其实手写了另一份字面量)。
//   · 循环依赖已核: gua_block.js **不** require gua_engine(它拿卦是靠调用方传进来),
//     所以顶层 require 这一侧不成环。
//     万一成环, 代价不是报错, 而是「某一边的导出在对方 load 时还是 undefined」——
//     症状是「标签莫名其妙没了」, 极难查。
const { XIANG_CI_TAG } = require('./gua_block');

// 先天八卦序 → 三爻二进制 (自下而上, 1=阳; 与 hexagrams.js binary 约定一致, 已验证: 泰='111000', 夬='111110')
const TRIGRAM_BITS = { 1: '111', 2: '110', 3: '101', 4: '100', 5: '011', 6: '010', 7: '001', 8: '000' };
const TRIGRAM_NAMES = { 1: '乾', 2: '兑', 3: '离', 4: '震', 5: '巽', 6: '坎', 7: '艮', 8: '坤' };
const BITS_TO_NUM = { '111': 1, '110': 2, '101': 3, '100': 4, '011': 5, '010': 6, '001': 7, '000': 8 };
// 八卦五行 (课件): 乾兑金, 离火, 震巽木, 坎水, 艮坤土
const TRIGRAM_WUXING = { 1: '金', 2: '金', 3: '火', 4: '木', 5: '木', 6: '水', 7: '土', 8: '土' };
// 八卦自然象 (课件: 卦名全名推导用 — 乾天兑泽离火震雷巽风坎水艮山坤地)
const TRIGRAM_NATURE = { 1: '天', 2: '泽', 3: '火', 4: '雷', 5: '风', 6: '水', 7: '山', 8: '地' };
// 体用生克公理 —— 2026-10-23 第 55 批搬进 64i 公理层。
//   为什么搬: 这张表原来住在这里, 而 `64i/provenance.js` 的 P1 守卫把出处台账
//   双向锁在 `64i/` 上 ⇒ **生产层的查表根本没有登记的口子**(第 43 批记下没堵的洞)。
//   搬进 64i/bagua_annotations/tiyong_axioms.js 之后, P1 立刻逼它在台账里登记,
//   于是「方向有出处、分级和百分比没有出处」这件事被**切成两半写清楚了**
//   —— 混在 sourced 里等于蒙混过关。
//   ⚠️ 断法结果一个字节都没变: 那张表逐行原样搬过去, 只是换了住址。
//      tests/tiyong-provenance-20261023.test.js 里有断言钉住这一点。
const {
  SHENG, KE, TIYONG_TABLE, getTiYongRelation, tiYongFromMovingYao, TIYONG_RELATIONS,
} = require('../64i/bagua_annotations/tiyong_axioms.js');

/**
 * 农历信息 (sxtwl 桥, 按 年月日时 缓存; 桥失败降级公历近似并标注)
 */
const _lunarCache = new Map();
function _lunarInfo(now) {
  const Y = now.getFullYear(), M = now.getMonth() + 1, D = now.getDate(), H = now.getHours();
  const key = `${Y}-${M}-${D}-${H}`;
  if (_lunarCache.has(key)) return _lunarCache.get(key);
  let info = null;
  try {
    const { execFileSync } = require('child_process');
    const path = require('path');
    const scriptPath = path.join(__dirname, 'bazi', 'lunar_info.py');
    const out = execFileSync('/usr/bin/python3', [scriptPath, String(Y), String(M), String(D), String(H)], { timeout: 8000, encoding: 'utf-8' });
    info = JSON.parse(out.trim());
    info.degraded = false;
  } catch (e) {
    // 降级: 年支按公历立春近似, 月日≈公历 (标注, 不装真)
    const gzIdx = ((M < 2 || (M === 2 && D < 4)) ? (Y - 5) : (Y - 4)) % 12;
    info = { lunar_month: M, lunar_day: D, lunar_leap: false, year_zhi_num: (gzIdx + 12) % 12 + 1, hour_zhi_num: Math.floor((H + 1) / 2) % 12 + 1, year_ganzhi: '?', degraded: true };
  }
  if (_lunarCache.size > 500) _lunarCache.delete(_lunarCache.keys().next().value);
  _lunarCache.set(key, info);
  return info;
}

/**
 * 体用分析
 * @param {number} upperNum 上卦数, lowerNum 下卦数, movingYao 动爻 1-6
 */
function _tiYong(upperNum, lowerNum, movingYao) {
  // 动爻定主客 + 五行生克定关系 —— 两条都走 64i 公理层(第 55 批搬过去的),
  //   这里只负责把卦数翻成卦名/五行。**不在本层重推一遍** ——
  //   两份同义逻辑各改各的正是本文件开头那条教训(改一次就漂一次)。
  const role = tiYongFromMovingYao(movingYao);
  const yongNum = role ? (role.yong === 'lower' ? lowerNum : upperNum) : lowerNum;
  const tiNum = role ? (role.ti === 'lower' ? lowerNum : upperNum) : upperNum;
  const tiWx = TRIGRAM_WUXING[tiNum], yongWx = TRIGRAM_WUXING[yongNum];
  const rel = getTiYongRelation(tiWx, yongWx);
  const t = TIYONG_TABLE[rel];
  return {
    ti_gua: TRIGRAM_NAMES[tiNum], ti_wuxing: tiWx,
    yong_gua: TRIGRAM_NAMES[yongNum], yong_wuxing: yongWx,
    relation: rel, level: t.level, pct: t.pct, verdict: t.verdict,
    // 吉凶**方向**(有出处)与分级/百分比(课件量化, 无出处)是两个东西 ——
    //   一起给, 让调用方能自己分开用, 也让台账那条 interpretive 有落点。
    direction: TIYONG_RELATIONS[rel],
    summary: `体卦${TRIGRAM_NAMES[tiNum]}(${tiWx}) / 用卦${TRIGRAM_NAMES[yongNum]}(${yongWx}) → ${rel} · ${t.level}(${t.pct}) · ${t.verdict}`,
  };
}

/**
 * 互卦: 二三四爻为下互, 三四五爻为上互 (binary 自下而上, index0=初爻)
*/
function _huGua(binary) {
  const lowerHuBits = binary[1] + binary[2] + binary[3];  // 二爻在下
  const upperHuBits = binary[2] + binary[3] + binary[4];  // 三爻在下
  const huBinary = lowerHuBits + upperHuBits;
  const huId = yaoModels.getGuaIdByBinary(huBinary);
  const hu = hexagrams.getHexagram(huId);
  return hu ? { id: huId, name: hu.name, symbol: hu.symbol, gua_ci: hu.gua_ci || '', binary: huBinary } : null;
}

/**
 * 综卦: 反转全部 6 位 (上下颠倒), 纯位运算
 */
function _zongGua(binary) {
  const rev = binary.split('').reverse().join('');
  const zId = yaoModels.getGuaIdByBinary(rev);
  const z = hexagrams.getHexagram(zId);
  return z ? { id: zId, name: z.name, symbol: z.symbol, gua_ci: z.gua_ci || '', binary: rev } : null;
}

/**
 * 错卦: 取反全部 6 位 (阴阳全翻), 纯位运算
 */
function _cuoGua(binary) {
  const not = binary.split('').map(c => c === '1' ? '0' : '1').join('');
  const cId = yaoModels.getGuaIdByBinary(not);
  const c = hexagrams.getHexagram(cId);
  return c ? { id: cId, name: c.name, symbol: c.symbol, gua_ci: c.gua_ci || '', binary: not } : null;
}

/**
 * 卦名全名 (课件"乾为天/雷地豫"式): 纯卦 "X为<自然象>", 否则 上象+下象+短名
 * 已对账: 64 卦全部匹配课件 8×8 矩阵 (2026-08-03)
 */
function _fullName(upperNum, lowerNum, shortName) {
  if (upperNum === lowerNum) return `${shortName}为${TRIGRAM_NATURE[upperNum]}`;
  return `${TRIGRAM_NATURE[upperNum]}${TRIGRAM_NATURE[lowerNum]}${shortName}`;
}

/**
 * 起卦 (真·梅花易数)
 * @param {string} question 主人问题/事项 (仅记录, 不混入起卦 — 正统同时辰同卦)
 * @param {object} [opts]
 *   opts.numbers: [n1, n2] 报数起卦 (课件主推)
 *   (2026-08-03 老板拍: 数字卦是三个数 — [n1,n2,n3], 上=n1%8 下=n2%8 动=n3%6;
 *    只报两个数时兜底旧法 动=(n1+n2+时支)%6)
 *   opts.now: Date|number 注入时间 (测试用)
 * @returns {object} 完整卦象: 本卦/动爻/互卦/变卦/体用吉凶/卦辞爻辞/五行六亲
 */
function castGua(question, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const lunar = _lunarInfo(now);
  const hourZhi = lunar.hour_zhi_num;

  let upperNum, lowerNum, movingYao, method;
  const nums = Array.isArray(opts.numbers) ? opts.numbers.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
  if (nums.length >= 2) {
    // 数字起卦法 (课件: "9 去掉 8 得 1")
    method = '梅花易数·数字起卦';
    upperNum = (nums[0] % 8) || 8;
    lowerNum = (nums[1] % 8) || 8;
    movingYao = nums.length >= 3
      ? (nums[2] % 6) || 6                                          // 三数法 (正统): 第三数取动爻
      : ((nums[0] + nums[1] + hourZhi) % 6) || 6;                   // 两数兜底: 加时支
  } else {
    // 时间起卦法 (农历)
    method = '梅花易数·时间起卦';
    const s = lunar.year_zhi_num + lunar.lunar_month + lunar.lunar_day;
    upperNum = (s % 8) || 8;
    lowerNum = ((s + hourZhi) % 8) || 8;
    movingYao = ((s + hourZhi) % 6) || 6;
  }

  // 二进制自下而上: 前 3 位下卦, 后 3 位上卦
  const binary = TRIGRAM_BITS[lowerNum] + TRIGRAM_BITS[upperNum];
  const guaId = yaoModels.getGuaIdByBinary(binary);
  const gua = hexagrams.getHexagram(guaId);

  // 变卦: 翻动爻
  const changedBits = binary.split('');
  changedBits[movingYao - 1] = changedBits[movingYao - 1] === '1' ? '0' : '1';
  const changedBinary = changedBits.join('');
  const zhiGuaId = yaoModels.getGuaIdByBinary(changedBinary);
  const zhiGua = hexagrams.getHexagram(zhiGuaId);

  // 互卦 + 体用
  const huGua = _huGua(binary);
  const zongGua = _zongGua(binary);
  const cuoGua = _cuoGua(binary);
  // 2026-11-24: 位运算推理内核 (本/之/互/综/错 5卦 + 确定性决策)
  let inferResult = null;
  try {
    const inf = require('../64i/gua_inference');
    inferResult = inf.infer(binary, movingYao);
  } catch (_) {}
  // 2026-11-24: 384 爻状态转移 (哪爻动→下一态), 从独立数据层取, 不再内嵌翻转逻辑
  let transitionRow = null;
  try {
    const yt = require('../64i/yao_transitions');
    transitionRow = yt.transition(binary, movingYao);
  } catch (_) {}
  const tiYong = _tiYong(upperNum, lowerNum, movingYao);

  // 8 维向量 (五行/六亲/爻位性质)
  let vector = null;
  // 2026-10-22 (老板 10-21 原话「64卦不是 1~64 是 0~63」的同款坑, 下沉一层):
  //   `movingYao` 是 **1-based** (四爻 = 4), 本函数下面两处都按 1-based 用它:
  //     moving_yao_ci: yaoCiAll[movingYao - 1]
  //     _tiYong(upperNum, lowerNum, movingYao)
  //   而 `getYaoVector(guaId, yaoPosition)` 的形参是 **0-based**:
  //     文档写「yaoPosition - 爻位 (0=初爻, 5=上爻)」, 且内部 `_isValidYaoPosition`
  //     只收 0..5。
  //   原来直接传 movingYao → **整个向量错位一爻**, 而且**一声不吭**:
  //     四爻(movingYao=4) 取到的是 idx4=九五 的值 →
  //       yao_name 六四(来自 yaoCiAll[3], 对) 配 yao_wuxing 土 / liu_qin 妻财(九五的, 错)
  //     → 同一个回答里两半在描述**不同的爻**。六亲/五行/爻位性质全部跟着错。
  //   更糟的是 **上爻**: movingYao=6 超出 0..5 → getYaoVector 返回 null →
  //     yao_wuxing / wuxing_rel / liu_qin / position_nature **静默全空**。
  //   E2E 实测那把卦(gua_id 61 中孚, 动爻4) 就是这样: 六四 配 土/妻财。
  //
  //   修法: 显式减 1, 并把换算关系写在两处, 别让下一个人再「顺手」传原值。
  //   为什么之前没人发现: 下游 `yao_name` 走的是 yaoCiAll[movingYao-1], 那条是对的,
  //   于是**看起来**整条链都对 —— 错的是只有 vector 那四个字段, 且不报错。
  const yaoIdx0 = movingYao - 1;   // 1-based → 0-based, 唯一换算点
  // 2026-10-22 第 37 批: 把**动爻的真实爻值**接进向量层。
  //   为什么要接: 此前 `getYaoVector(guaId, yaoIdx0)` 只传两参 ⇒ 向量层内部
  //   只能按 binary 推「阳→7 少阳 / 阴→8 少阴」⇒ `movement` **恒为 'static'**,
  //   老阳(9)/老阴(6)的动静信息**整条链丢光**。
  //   而这个卦**本来就有动爻** —— 动爻在梅花里就是「老阳/老阴」:
  //     动爻位在本卦是阳 ⇒ 老阳 9(动, 变后为阴)
  //     动爻位在本卦是阴 ⇒ 老阴 6(动, 变后为阳)
  //   这跟下面 changedBits 翻的那一位是**同一个位** ⇒ 变卦与爻值自洽。
  //   ⚠️ 位序: `binary` 的 char0 = 初爻(已实测 384/384 爻名阴阳与 binary 位一致),
  //     所以动爻位的下标是 movingYao-1, 与 yaoIdx0 同一个换算点。
  const movingBit = binary.charAt(yaoIdx0);
  const movingYaoValue = movingBit === '1' ? 9 : 6;   // 老阳 / 老阴
  try { vector = hexagramVector.getYaoVector(guaId, yaoIdx0, { yaoValue: movingYaoValue }); } catch (_) {}
  const yaoCiAll = (gua && gua.yao_ci) || [];
  // 2026-10-22 第 37 批: 纳甲覆盖率**从表算**, 不写死字符串。
  //   写死的数会跟表漂(真源一补就变), 而且**没人会发现** ——
  //   本文件曾两次写下「96/384」「4/64」这种当时为真、后来变假的数。
  //   ⇒ 口径句里的数一律走 getCoverageStats()。
  const _najiaCoverage = (function () {
    try {
      const st = require('../64i/bagua_annotations/najia.js').getCoverageStats();
      return {
        yao: `${st.yao_loadable}/${st.yao_total}`,
        gua_full: st.gua_full.length,
        gua_partial: st.gua_partial.length,
      };
    } catch (e) {
      // 纳甲层取不到 ⇒ 口径句里就不给数(宁可不说, 也不说错的)
      return { yao: '未知', gua_full: '未知', gua_partial: '未知' };
    }
  })();
  // 输出层的两个字段: 爻名取自爻词前缀(yao_ci), 爻五行取自 vector。
  //   两者**来自不同的表** —— 所以它们可能对不上, 而且对不上就是错
  //   (同一个回答里两半在描述不同的爻)。这才是守卫该看的地方。
  const yaoNameOut = (yaoCiAll[movingYao - 1] || '').split('：')[0] || (vector ? vector.yaoName : '');
  const yaoWuxingOut = vector ? vector.yaoWuxing : '';

  // 2026-10-22: 出参前做一次**自洽**检查 (爻名 vs 爻五行说的是不是同一爻)。
  //   这一条不是"多一道保险", 是那个 bug 的**通用签名**:
  //   任何未来的 off-by-one / 取错表 / 错位传参, 只要让爻名和爻五行对不上, 都在这儿炸。
  //
  //   ⚠️ 必须喂**输出的一对字段**, 不能喂 vector:
  //     vector.yaoName 和 vector.yaoWuxing 同源(都出自 yao_axioms 同一个 axiom),
  //     喂它 = 喂一个**结构上永远自洽**的东西 = 守卫永远不响(实测踩到)。
  //
  //   为什么只**警告**不抛:
  //     起卦不能因为一个向量字段矛盾就整个失败 —— 卦象本身(64卦/卦辞/动爻)是对的,
  //     错的是那几个衍生字段。抛掉等于因为五行报错把卦辞也一起丢,
  //     那是用一个错误换一个更大的错误。
  //     所以: 照常返回(答语可用), 但打警告 + **在结果里标出来**, 让它**可见**而不是**静默**。
  let yaoVectorCheck = { ok: true, checked: false };
  try {
    // ⚠️ 第 36 批起必须带 guaId: 守卫的尺子换成了**纳甲地支五行**(真源), 没有卦号取不到。
    // ⚠️ requireWuxing 只在**这一爻装得出纳甲**时开:
    //   纳甲是**按爻**算的 —— 内三爻取下卦纳甲、外三爻取上卦纳甲,
    //   所以只要卦的一半(上或下)有地支, 那一半的三爻就有据可查
    //   (第 41 批补齐八卦地支后实算 384/384, 无缺口)。
    //   万一某个爻位装不出纳甲, 爻五行**本该是空** —
    //   那种空是「诚实的空」, 按「空=越界」去判就是起卦误报;
    //   报多了就没人看了, 守卫也就名存实亡。
    //   「诚实的空」与「下标越界取空」的区别由下面 checkYaoIndexAligned 兜。
    const _najia = require('../64i/bagua_annotations/najia.js');
    const _haveNajia = _najia.getYaoGanzhi(guaId, movingYao).ok;
    const _vc = yaoConsistency.checkVectorConsistency({
      guaId,
      yaoName: yaoNameOut,
      yaoWuxing: yaoWuxingOut,
    }, { requireWuxing: _haveNajia });   // 这一爻有纳甲真源时: 空 = 下标越界取空了
    yaoVectorCheck = {
      ok: _vc.ok !== false,
      checked: true,
      ruler: _vc.ruler || null,
      unverifiable: _vc.unverifiable || null,
      reason: _vc.reason,
      detail: _vc.detail,
    };
    if (!_vc.ok) {
      console.warn('[gua-engine] YAO_VECTOR_CONTRADICTION guaId=' + guaId
        + ' movingYao=' + movingYao + ' ' + JSON.stringify(_vc.detail));
    }
  } catch (e) {
    // 守卫自己出错 ≠ 起卦出错。这里只降级**这一项检查**, 卦象照常出。
    yaoVectorCheck = { ok: true, checked: false, error: String((e && e.message) || e) };
    console.error('[gua-engine] 爻向量守卫调用失败, 本次未检查: ' + yaoVectorCheck.error);
  }
  // 2026-10-22 第 36 批: 爻位对齐守卫 —— **不需要五行**, 64/64 卦都成立。
  //   为什么当初必须补这一道: 补齐之前, 上面那道守卫的尺子(纳甲地支五行)
  //   只覆盖 4/64 卦, 60 个卦上五行是「诚实的空」。可 off-by-one 错位错的是**下标**,
  //   跟五行没关系 —— 只靠五行那道, 等于 60 个卦上错位抓不住, 而那正是它要抓的东西。
  //   ⚠️ 第 41 批纳甲补齐后五行那道也满覆盖了, 但**这一道不许删**:
  //     它不依赖五行, 哪天纳甲再出现缺口, 它仍然 384/384 有效。
  //   这里比「输出爻名(爻辞表)」与「向量爻名(爻位公理表)」: 两张不同的表,
  //   错位一爻必然不一致。而上爻越界那种「静默取空」会落到 vectorYaoName 缺失 ——
  //   跟上面 requireWuxing 的「诚实的空」正好分得开。
  let yaoIndexCheck = { ok: true, checked: false };
  try {
    const _ia = yaoConsistency.checkYaoIndexAligned({
      guaId,
      yaoName: yaoNameOut,
      vectorYaoName: vector ? vector.yaoName : null,
    });
    yaoIndexCheck = {
      ok: _ia.ok !== false,
      checked: true,
      unverifiable: _ia.unverifiable || null,
      reason: _ia.reason,
      detail: _ia.detail,
    };
    if (!_ia.ok) {
      console.warn('[gua-engine] YAO_INDEX_MISALIGNMENT guaId=' + guaId
        + ' movingYao=' + movingYao + ' ' + JSON.stringify(_ia.detail));
    }
  } catch (e) {
    yaoIndexCheck = { ok: true, checked: false, error: String((e && e.message) || e) };
    console.error('[gua-engine] 爻位对齐守卫调用失败, 本次未检查: ' + yaoIndexCheck.error);
  }

  return {
    method,
    question: String(question || '').slice(0, 200),
    numbers: nums.length >= 2 ? nums.slice(0, 3) : undefined,
    cast_at: now.toISOString(),
    lunar: { month: lunar.lunar_month, day: lunar.lunar_day, leap: lunar.lunar_leap, year_ganzhi: lunar.year_ganzhi, year_zhi_num: lunar.year_zhi_num, hour_zhi_num: hourZhi, degraded: lunar.degraded },
    gua_id: guaId,
    gua_name: gua ? gua.name : '?',
    gua_name_full: gua ? _fullName(upperNum, lowerNum, gua.name) : '?',  // 课件全名: 乾为天/雷地豫
    symbol: gua ? gua.symbol : '?',
    binary,
    gua_ci: yaoModels.getGuaCi(guaId) || (gua && gua.gua_ci) || '',
    // 2026-10-23 第 70 批: 大象辞(象曰)进起卦输出。
    //   以前这一层是空的 —— 模型讲卦只有「卦辞 + 爻辞」, 少了「整体取象」,
    //   而大象辞正是《易传》里最接近"这卦在讲什么"的那一句。
    //   取不到给 null(不空串): 调用方要能区分「没取到」和「这卦没大象辞」。
    gua_xiang: yaoModels.getGuaXiang(guaId) || (gua && gua.xiang) || null,
    // 大象辞的**身份**跟着数据走 (与 hexagram_lookup 的 xiang_basis 同一套路)。
    //   为什么起卦输出也要标: gua_xiang 是 tool_result 里的**裸字段** ——
    //   模型在 gua_cast 的返回里看到「天行健，君子以自强不息。」时,
    //   不知道它这一份是三方对账定稿(10 卦有登记异文), 会当成任一本《周易》的
    //   原样引文讲出去。卦象块(gua_block)那一行是带标签的, 但**起卦返回本身**
    //   也得带 —— 两条路模型都会读。
    //   ⚠️ 台账 provenance.js 把 'modules/gua_engine.js:castGua' 登记成渲染点,
    //     出处层守卫 P12 会查「这个函数体里有没有引用标签常量符号」——
    //     本批第一次整链回归就是它报红(台账说了假话: 登记了却没引用)。
    gua_xiang_basis: {
      tag: XIANG_CI_TAG,
      field: 'gua_xiang',
      note: '大象辞(象曰)是《周易》原文。本盘古这一份是三方交叉对账定稿: '
        + '本地《周易》原文切片(上经30卦+咸卦) / npm iching-shifa / github yijing-data '
        + '三源逐条比对, 文字层一致者取共识(54卦), 有异文者按「首句必含本卦名」'
        + '筛掉贴错卦的一源并人工裁决平票(10卦, 异文逐条登记在 provenance 台账)。'
        + '引用时按《周易》大象辞讲即可, 跟爻辞一样属典籍原句。',
    },
    yao_ci_all: yaoCiAll,
    moving_yao: movingYao,
    moving_yao_ci: yaoCiAll[movingYao - 1] || '',
    // 2026-10-22 第 37 批: 动爻的**爻值与动静**(卦筮的原始信息, 此前整条链都丢了)。
    //   老阳 9 / 老阴 6 = 这一爻是**老爻**(会变); 少阳 7 / 少阴 8 = 少爻(不变)。
    //   它跟 `zhi_gua`(变卦)是同一件事的两面: 变卦 = 这一爻的阴阳翻转后的卦。
    //   ⚠️ 爻值**只**说明动/静 + 阴阳, 不说明五行 —— 爻的五行是纳甲地支五行,
    //     跟动没动无关(老板 10-21 原话「爻动阴阳那就太过了」)。
    moving_yao_value: movingYaoValue,
    moving_yao_movement: 'dynamic',
    zhi_gua: zhiGua ? { id: zhiGuaId, name: zhiGua.name, name_full: _fullName(BITS_TO_NUM[changedBinary.slice(3, 6)], BITS_TO_NUM[changedBinary.slice(0, 3)], zhiGua.name), symbol: zhiGua.symbol, gua_ci: zhiGua.gua_ci || '', binary: changedBinary } : null,
    infer: (inferResult && inferResult.ok) ? inferResult : null,
    transition: (transitionRow && transitionRow.ok) ? transitionRow : null,
    hu_gua: huGua ? { ...huGua, name_full: _fullName(BITS_TO_NUM[(binary[2] + binary[3] + binary[4])], BITS_TO_NUM[(binary[1] + binary[2] + binary[3])], huGua.name) } : null,
    zong_gua: zongGua ? { ...zongGua, name_full: _fullName(BITS_TO_NUM[zongGua.binary.slice(3, 6)], BITS_TO_NUM[zongGua.binary.slice(0, 3)], zongGua.name) } : null,
    cuo_gua: cuoGua ? { ...cuoGua, name_full: _fullName(BITS_TO_NUM[cuoGua.binary.slice(3, 6)], BITS_TO_NUM[cuoGua.binary.slice(0, 3)], cuoGua.name) } : null,
    ti_yong: tiYong,
    upper_trigram: TRIGRAM_NAMES[upperNum],
    lower_trigram: TRIGRAM_NAMES[lowerNum],
    upper_num: upperNum, lower_num: lowerNum,
    wuxing: vector ? vector.guaWuxing : '',
    yao_wuxing: vector ? vector.yaoWuxing : '',
    wuxing_rel: vector ? vector.wuxingRel : '',
    liu_qin: vector ? vector.liuQin : '',
    // 2026-10-22 (第 30 批): 六亲的**逐爻**明细 + **口径**。
    //   以前只给动爻那一个六亲标签, 模型要讲整卦六亲就只能自己编;
    //   而且「我」侧的口径没说 —— 2026-10-22 查清六亲原先建在**上卦五行**上,
    //   跟京房宫五行在 32/64 卦上不一致(已切过来, 见 liu_qin.js)。
    //   但「他」侧仍是固定爻位五行表、不是纳甲干支 ⇒ 这套六亲**不是京房六亲**,
    //   口径必须跟着数据一起给, 否则模型会当京房六亲讲出去。
    liu_qin_all: (function () {
      try {
        const lq = require('../64i/bagua_annotations/liu_qin.js');
        const arr = lq.computeLiuQinForGua(guaId);
        if (!arr) return null;
        const NAMES = ['初爻', '二爻', '三爻', '四爻', '五爻', '上爻'];
        return arr.map((x, i) => ({
          pos: i + 1,
          name: NAMES[i],
          liu_qin: x.liuQin,
          yao_wuxing: x.yaoWuxing,
          najia_ganzhi: x.ganzhi,
          reason: x.reason,
        }));
      } catch (e) { return null; }
    })(),
    // 2026-10-22 第 36 批: 「他」侧换成了**真纳甲地支五行**, 所以
    //   「不是京房六亲」这句话**已经过时** —— 这就是京房六亲。
    //   ⚠️ 覆盖是**逐爻**的, 不是按整卦: 纳甲内三爻取下卦、外三爻取上卦,
    //   所以半边有地支的卦也有一半装得出。
    //   第 41 批: 八卦地支 8/8 补齐 ⇒ 实算 384/384, 无缺口。
    //   ⚠️ 曾经两次把缺口**夸大**: 先写成「4/64 卦(乾/泰/否/坤)…」,
    //   把 24 个有据可查的半边卦整个记成「没有」。这是给模型看的口径句,
    //   夸大的缺口会让模型在明明答得出的卦上拒答 —— **口径比数据错更坏**。
    //   若哪天真出现装不出的爻位, 是 null + 原因, **不许模型自己编一个六亲**
    //   (那正是盘古「没给的地方模型自己编」的病根)。口径跟着数据一起给。
    liu_qin_note: '六亲口径(第 36 批起): 我=京房宫五行, 他=该爻的**纳甲地支五行**(真源)。'
      + '⇒ **逐爻**看: 这一爻的纳甲地支有真源 ⇒ 这就是京房六亲, 照实讲; '
      + '装不出 ⇒ 六亲是 null + reason(当前 384/384 全装得出, 走不到; 一旦走到就是真缺口)。'
      // ⚠️ 覆盖率**从表算**, 不写死 —— 写死的数会跟表漂, 而且没人发现
      //   (第 36 批实算过一次: 96/384 爻位, 分布在 28/64 卦上; 但那是当时的数,
      //    真源一补就漂。所以这里取 getCoverageStats() 的实算值。)
      + '全盘覆盖 ' + _najiaCoverage.yao + ' 爻位(' + _najiaCoverage.gua_full + ' 卦六爻齐全 + '
      + _najiaCoverage.gua_partial + ' 卦半边)。'
      + '**没有六亲就是没有, 不许自己编**; '
      + '也别因为「这卦装不出」就把整卦都判成没有 —— 有一半是有据可查的。',
    liu_qin_basis: (function () {
      try {
        const lq = require('../64i/bagua_annotations/liu_qin.js');
        return {
          is_jingfang: lq.LIU_QIN_BASIS.is_jingfang,
          coverage: lq.LIU_QIN_BASIS.coverage,
          other_side: lq.LIU_QIN_BASIS.other_side,
        };
      } catch (e) { return null; }
    })(),
    // 2026-10-22: 京房八宫归属 (宫/宫位/世应) —— 卦层真值。
    //   模型问「这卦属哪一宫、几世、世爻在哪」时, 这里给的是查表结果, 不是回忆。
    //   应爻: 第 35 批起 8/8 行都有值(统一按隔三位), 本宫卦(世在上爻)应三爻 ——
    //   原来那行留 null 的理由("经典另说初爻")在真源里查无出处, 且跟本仓自己的
    //   配对表矛盾, 已撤; 正确性由真纳甲地支×真源六冲表的交叉校验兜住。
    jingfang: jingfangBagong.getJingfang(guaId) || null,
    // 爻名以爻词前缀为准。
    //   (2026-10-22 更正: 这里原注释写「hexagram_vector 的 yaoName 有已知错位 bug:
    //    五爻报成"上九"」—— 实测**已经不成立**: vector.yaoName 是按爻位公理表取的,
    //    384 爻逐个核过, 只有**一处**标签错, 且错在**爻辞表**不在 vector:
    //      鼎卦(50) 初爻, 阴爻却写成「初九」(binary 011101 → idx0=0=阴), 爻辞正文
    //      「鼎颠趾」是初六那条 —— 已改「初六」, 并由 tests/yao-ci-yinyang-align-*.test.js
    //      把「标签阴阳 == 爻位阴阳」钉成不变量, 防止再漂。)
    yao_name: yaoNameOut,
    // 2026-10-22: 爻名/爻五行是否说的是同一爻 —— 矛盾就是错位, 这里标出来给上层看。
    yao_vector_check: yaoVectorCheck,
    // 第 36 批: 爻位对齐(输出爻名 vs 向量爻名) —— 64/64 卦都成立的那一道。
    yao_index_check: yaoIndexCheck,
    position_nature: vector ? vector.positionNature : '',
  };
}

module.exports = { castGua, TRIGRAM_BITS, TRIGRAM_NAMES, TRIGRAM_WUXING, TIYONG_TABLE };
