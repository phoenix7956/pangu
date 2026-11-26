/**
 * Pangu · 64i Layer
 * bagua_annotations/tiyong_axioms.js
 *
 * 体用生克公理层 —— 2026-10-23 第 55 批从 `modules/gua_engine.js` 搬进来。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么搬 (不是「整理得更整齐」, 是台账逼的)
 * ═══════════════════════════════════════════════════════════════
 *
 * 这张表原来住在 `modules/gua_engine.js`, 于是它**整份不在出处台账里** ——
 * 而 `64i/provenance.js` 的 P1 守卫把 `LAYERS` 双向锁死在 `64i/` 上:
 *   ① 64i 里任何模块没登记 ⇒ 报「未登记出处」
 *   ② LAYERS 里任何 key 在 64i 里找不到 ⇒ 报「登记了不存在的层」
 * `modules/` 不在这两个方向里 ⇒ 生产层的查表**根本没有登记的口子**。
 *
 * 第 43 批已经把这个洞记下来了但没堵: DIGEST_FEED 里梅花那三份写着
 * 「起卦法在 gua_engine.js, 不在 64i 公理层」。洞记下了, 但没人在台账里看见它。
 *
 * 后果不是学术洁癖, 是**模型会把课件量化当典籍讲**:
 *   ① `pct: '90%' / '70%' / '10%'` —— 原文通篇**没有百分比**
 *   ② `level: '大吉/次吉/中吉/小凶/大凶'` —— 原文**没有这套分级**
 *   ③ `verdict: '事必成' / '事不成'` —— 原文是「诸事吉/诸事凶」这类**方向**,
 *      措辞不一样, 而且原文多处是「事虽成但成得迟」这种带限定的说法
 * 而这块 `ti_yong` **真进生产**: 它在 `gua_cast` 的 tool_result 里,
 * 第 56 批起还会印进模型读到的卦块 ⇒ 不标身份, 模型会照着「10% 事不成」
 * 当事实报给主人。
 *
 * ⚠️ 搬进来的**代价**: 表的「方向」有出处, 「分级 + 百分比」没有。
 *   这两半必须**分开登记** —— 混在 sourced 里等于蒙混过关。
 *   详见 `64i/provenance.js` 里 `bagua_annotations:tiyong_axioms` 的两栏。
 *
 * ═══════════════════════════════════════════════════════════════
 * 出处: 《梅花易数》课外阅读资料(白话解释)「体用总决」段
 *   切片 `64i/sources/meihua_tiyong.txt` (原文 190-204 行, 逐字拷贝)
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

// ── 五行的生与克 (只两项够用; 完整公理在 wuxing_axioms.js) ─────────────────
//   注意这里的表跟 wuxing_axioms.js 的 SHENG/KE **同向**, 两处都在用。
//   之所以仍在本层留一份: 体用断法的自洽性要能**在本层内闭环自校**,
//   不依赖别的层 —— 别的层改了, 这层的断言会立刻发现对不上。
const SHENG = { '金': '水', '水': '木', '木': '火', '火': '土', '土': '金' };
const KE = { '金': '木', '木': '土', '土': '水', '水': '火', '火': '金' };

// ── 五个关系: 名字 + **吉凶方向**(有出处的那一半) ─────────────────────────
//
// 原文逐字(切片 meihua_tiyong.txt):
//   「体克用，诸事吉；用克体，诸事凶。体生用，有耗失之患；用生体，有进益之喜。
//     体用比和，则百事顺遂。」
//
// ⇒ 五个关系的**方向**全部可核。这是本层唯一敢标 sourced 的部分。
//
// ⚠️ 方向 ≠ 强弱, 更 ≠ 概率。原文说「体克用诸事吉」, 没说是「大吉」也没给数字。
const TIYONG_RELATIONS = Object.freeze({
  // relation : 吉凶方向(吉/凶) —— 只二值, 因为原文只到这一步
  '用生体': '吉',
  '体克用': '吉',
  '比合': '吉',
  '体生用': '凶',
  '用克体': '凶',
});

// ── 吉凶分级 + 百分比 + 断语措辞 (课件量化, **无出处**) ────────────────────
//
// ⚠️ 这三项一个都没有典籍出处, 台账里登记为 interpretive。
//   保留它们是因为<instructor>课件就是这么教的, 而课件是老板在学的材料 ——
//   删掉等于把老板学到的那张表从盘古里拿掉。**留着但必须标身份。**
//
// pct 是课件给的**量级参考**, 不是概率: 同一卦同一动爻, 换时辰换问事内容就变。
//   所以它只能当「强弱档位」的刻度, 不能当「成事概率」报出去。
const TIYONG_TABLE = Object.freeze({
  '用生体': { level: '大吉', pct: '90%', verdict: '事必成' },
  '比合': { level: '次吉', pct: '70%', verdict: '事易成' },
  '体克用': { level: '中吉', pct: '40-60%', verdict: '事可成' },
  '体生用': { level: '小凶', pct: '30%', verdict: '事难成' },
  '用克体': { level: '大凶', pct: '10%', verdict: '事不成' },
});

/**
 * 从两个卦的五行算出体用关系。
 *
 * @param {string} tiWuxing 体卦五行
 * @param {string} yongWuxing 用卦五行
 * @returns {string|null} 五个关系之一; 传入不认识的值返回 null(不猜)
 */
function getTiYongRelation(tiWuxing, yongWuxing) {
  if (!SHENG[tiWuxing] || !SHENG[yongWuxing]) return null;
  if (SHENG[yongWuxing] === tiWuxing) return '用生体';
  if (SHENG[tiWuxing] === yongWuxing) return '体生用';
  if (KE[yongWuxing] === tiWuxing) return '用克体';
  if (KE[tiWuxing] === yongWuxing) return '体克用';
  return '比合';
}

/**
 * 动爻定主客: 动爻在下卦(1-3) ⇒ 上卦为体、下卦为用; 在上卦(4-6) ⇒ 反之。
 *
 * 出处: 原文「第三爻动, 下卦坤土变艮土…」(疾病占) 与
 *       「第四爻动, 上卦乾金变为巽木…」。第三爻动时**下卦**是变的那一卦(用),
 *       第四爻动时**上卦**是变的那一卦 ⇒ 动爻所在之卦为用, 另一卦为体。
 *
 * @param {number} movingYao 动爻位次 1..6
 * @returns {{ti:'upper'|'lower', yong:'upper'|'lower'}|null}
 */
function tiYongFromMovingYao(movingYao) {
  // 必须查「是不是 1..6 的**整数**」, 不能只查范围 ——
  //   `1.5 >= 1 && 1.5 <= 6` 是真的, 只查范围会让 1.5 走进来当第一爻用,
  //   而爻位没有小数。这条是本批测试当场抓出来的(越界负例里放了 1.5)。
  if (!Number.isInteger(movingYao) || movingYao < 1 || movingYao > 6) return null;
  return movingYao <= 3
    ? { ti: 'upper', yong: 'lower' }
    : { ti: 'lower', yong: 'upper' };
}

module.exports = {
  SHENG,
  KE,
  TIYONG_RELATIONS,
  TIYONG_TABLE,
  getTiYongRelation,
  tiYongFromMovingYao,
};
