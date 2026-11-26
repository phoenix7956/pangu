/**
 * Pangu · 64i Layer
 * bagua_annotations/index.js
 *
 * 五行注解层统一入口
 * 聚合：wuxing_map + bagua_positions + liu_qin
 */

'use strict';

const wuxing = require('./wuxing_map');
const positions = require('./bagua_positions');
const yaoPositions = require('./yao_positions');

/**
 * 获取某卦某爻位注解
 * @param {number} guaId
 * @param {number} position 0-5
 */
function getYaoPosition(guaId, position) { return yaoPositions.getYaoPosition(guaId, position); }

/**
 * 获取某卦全部6爻注解
 */
function getYaoPositions(guaId) { return yaoPositions.getYaoPositions(guaId); }

/**
 * 获取某卦完整注解
 * @param {number} guaId - 卦序号（1-64）
 * @returns {{ wuxing: object, xiantian: object|null, houtian: object|null,
 *             liuqin: object|null, liuqin_yao: object[]|null, liuqin_basis: object }}
 */
function getAnnotations(guaId) {
  const lq = require('./liu_qin');
  return {
    wuxing: wuxing.getWuxing(guaId),
    xiantian: positions.getXiantian64 ? positions.getXiantian64(guaId) : positions.getXiantian(guaId),
    houtian: positions.getHoutian64 ? positions.getHoutian64(guaId) : positions.getHoutian(guaId),
    liuqin: getLiuQin(guaId),
    // 2026-10-22 (第 30 批): 逐爻六亲 + **口径**。
    //   以前只给一个 5-key 的袋子, key 名跟值对不上(坤卦 parents:'妻财'),
    //   模型读到会照着错。现在给「每爻的六亲」+ 明说这套六亲的**口径**
    //   (第 36 批起: 我=京房宫五行, 他=**纳甲地支五行** ⇒ 对算得出的爻位
    //   这就是京房六亲; 但覆盖率只有 96/384 爻位, 算不出的**逐爻**给 null + 原因)。
    //   口径不写出来, 模型就会把它当京房六亲讲出去 —— 或者反过来,
    //   在算不出的爻位上**自己编一个**(那正是「没给的地方模型自己编」的病)。
    liuqin_yao: lq.computeLiuQinForGua(guaId),
    liuqin_basis: lq.LIU_QIN_BASIS,
  };
}

/**
 * 获取某卦五行注解
 */
function getWuxing(guaId) { return wuxing.getWuxing(guaId); }

/**
 * 获取某卦先天八卦方位
 */
function getXiantian(guaId) { return positions.getXiantian(guaId); }

/**
 * 获取某卦后天八卦方位
 */
function getHoutian(guaId) { return positions.getHoutian(guaId); }

/**
 * 五行生克关系
 */
function getRelation(w1, w2) { return wuxing.getRelation(w1, w2); }

/**
 * 两卦之间的五行关系
 */
function getRelationBetween(guaId1, guaId2) {
  const w1 = wuxing.getWuxing(guaId1).wuxing;
  const w2 = wuxing.getWuxing(guaId2).wuxing;
  return { gua1: guaId1, gua2: guaId2, wuxing1: w1, wuxing2: w2, relation: wuxing.getRelation(w1, w2) };
}

// 保留原始常量名兼容
const WUXING_MAP = wuxing.WUXING_MAP;
const XIAN_TIAN_BAGUA = positions.XIAN_TIAN_BAGUA;
const XIAN_TIAN_SEQ = positions.XIAN_TIAN_SEQ;
const HOU_TIAN_BAGUA = positions.HOU_TIAN_BAGUA;
const HOU_TIAN_SEQ = positions.HOU_TIAN_SEQ;
const XIAN_TIAN_64 = positions.XIAN_TIAN_64;
const HOU_TIAN_64 = positions.HOU_TIAN_64;

// 六亲 —— 2026-10-22 (第 30 批) 重写
//
// ⚠️ 原先是**手打的 64 行静态表**, 头注释写「京房六亲体系」。实测它有四个问题:
//
//   ① 64 卦在这张表里**塌成 5 种形态**(41/7/8/3/5 卦一组) —— 几乎不携带逐卦信息;
//   ② **key 名和值对不上**: 坤卦是 `{parents:'妻财', siblings:'父母', …}` ——
//      key 说「父母」值却是「妻财」, 语义整个反了, 模型读到会照着错;
//   ③ 头注释自称「京房六亲体系」—— 过度声称(京房六亲的「他」侧是**纳甲地支**五行,
//      爻位固定五行表不是纳甲; 真源无六爻装卦材料, 拿不到真京房六亲);
//   ④ `getLiuQin(0)` / `getLiuQin(999)` **静默返回乾卦那一行** ——
//      越界不报错, 还给得出一个像模像样的别的卦的答案。
//
// 现在: 这张表**从 liu_qin.js 的动态计算派生** —— 单一真源, 不再手打。
// 「我」侧 = 京房宫五行(双源交叉 64/64 的八宫表), 「他」侧 = 真纳甲地支五行(第 36 批)。
// 形状也改了: key 是**六亲名**, value 是**该六亲出现在哪几爻**(1 基, 卦层语义)。
//   原来的 key(parents/siblings/…)跟值对不上, 现在 key 名就是它自己那个六亲。
//
// ⚠️ 第 36 批: 六亲改用**真纳甲地支五行**作「他」侧。纳甲地支真源只覆盖乾、坤两卦,
//   但纳甲是**按爻**算的(内三爻取下卦、外三爻取上卦)⇒ 实算能装出 **96/384 爻位**,
//   分布在 28/64 卦上(4 卦六爻齐全 + 24 卦半边能装), 36 卦一爻都装不出。
//   ⇒ 这张表**不是「全有」也不是「全无」**, 而是**逐爻**有或没有。
//     · `available`: 该卦**至少有**一爻算得出 ⇒ 五个数组里可能有**部分**爻位。
//     · `missing`:   算不出的爻位逐条列出(pos + name + reason), 不藏。
//     · `available:false` + `reason`: 整卦都算不出。
//   为什么必须逐爻标: 五个空数组会被读成「这卦没六亲」, 半满的数组会被读成
//   「这卦只有这几个六亲」—— 两者都是**缺口伪装成结论**,
//   跟"该给真值的地方给了回忆"同一个病。
//
// 坐标一律 **1 基爻位**(1=初爻 … 6=上爻) —— 跟爻辞/世应的口径一致。

const LIU_QIN = (() => {
  const liuQinMod = require('./liu_qin');
  const YAO_NAME_1BASE = ['初爻', '二爻', '三爻', '四爻', '五爻', '上爻'];
  const out = {};
  for (let guaId = 1; guaId <= 64; guaId++) {
    const arr = liuQinMod.computeLiuQinForGua(guaId);
    if (!arr) continue;
    const row = { parents: [], siblings: [], offspring: [], wealth: [], official: [] };
    const KEY_OF = { '父母': 'parents', '兄弟': 'siblings', '子孙': 'offspring', '妻财': 'wealth', '官鬼': 'official' };
    let available = false;
    let reason = null;
    const missing = [];
    for (const item of arr) {
      const key = KEY_OF[item.liuQin];
      if (key) {
        available = true;
        row[key].push({ pos: item.yaoPosition + 1, name: YAO_NAME_1BASE[item.yaoPosition] });
      } else {
        missing.push({
          pos: item.yaoPosition + 1,
          name: YAO_NAME_1BASE[item.yaoPosition],
          reason: item.reason || '纳甲装不出, 原因未记录',
        });
        if (!reason && item.reason) reason = item.reason;
      }
    }
    // available:false ⇒ 整卦都算不出, 附原因(不是"这卦没六亲")
    // available:true  ⇒ 也可能是**半边**能算, 所以 missing 必须逐爻列出来,
    //   否则「数组里只有 3 项」会被读成「这卦只有 3 个六亲」。
    row.available = available;
    row.reason = available ? null : (reason || '纳甲装不出, 原因未记录');
    row.missing = missing;
    row.covered = 6 - missing.length;
    out[guaId] = row;
  }
  return out;
})();

/**
 * 获取某卦六亲信息
 * @param {number} guaId - 卦序号（1-64）
 * @returns {object|null} { parents, siblings, offspring, wealth, official },
 *                        每个 value = [{pos, name}, ...] (1 基爻位);
 *                        外加 available(boolean) + reason(string|null)
 *                        + missing(Array) + covered(number) ——
 *                        available=false ⇒ 整卦六亲算不出来(附原因), 不是"这卦没六亲";
 *                        available=true 也可能 covered<6 —— 缺失爻位在 missing 里逐条列出;
 *                        **越界返回 null** —— 不再静默拿乾卦那一行顶缸
 */
function getLiuQin(guaId) {
  if (!Number.isInteger(guaId) || guaId < 1 || guaId > 64) return null;
  return LIU_QIN[guaId] || null;
}

module.exports = {
  WUXING_MAP,
  XIAN_TIAN_BAGUA,
  XIAN_TIAN_SEQ,
  HOU_TIAN_BAGUA,
  HOU_TIAN_SEQ,
  XIAN_TIAN_64,
  HOU_TIAN_64,
  LIU_QIN,
  YAO_POSITIONS: yaoPositions.YAO_POSITIONS,
  getWuxing,
  getXiantian,
  getHoutian,
  getLiuQin,
  getAnnotations,
  getRelation,
  getRelationBetween,
  getYaoPosition,
  getYaoPositions,
};
