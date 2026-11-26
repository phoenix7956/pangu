/**
 * Pangu · 64i Layer
 * hexagram_vector.js - Pangu 8 维向量聚合器 - 2026-06-18 老板拍板完全重构
 *
 * 职责：对任意 (guaId, yaoPosition) 组合, 输出完整 8 维属性向量
 *
 * 8 维向量结构:
 *   1. ID 维         : guaId, yaoPosition
 *   2. 阴阳 + 动静   : yinYang(0/1), movement(static/dynamic), yaoValue(6/7/8/9)
 *   3. 八卦          : upperBagua{ name, symbol, wuxing }, lowerBagua{...}
 *   4. 五行          : guaWuxing, yaoWuxing, wuxingRel(中文标签)
 *   5. 爻位          : yaoName, positionNature
 *   6. 六亲          : liuQin
 *   7. 爻辞          : yaoCi
 *   8. 变卦 (扩展)   : changedGuaId, changedYao (暂留 null)
 *
 * ⚠️ yaoValue / movement **已接起卦数据**(2026-10-22 第 37 批):
 *   - 不传 `opts.yaoValue` ⇒ 用该爻位的**静态阴阳**取默认静值:
 *       阳爻 → 7 (少阳静, movement='static') / 阴爻 → 8 (少阴静, movement='static')
 *   - 传了 `opts.yaoValue`(6/7/8/9) ⇒ yaoValue/movement 按爻值走,
 *       动爻(9 老阳 / 6 老阴) ⇒ movement='dynamic'
 *   - **爻值不许翻转本卦爻位的阴阳**: 爻值的阴阳(6/8=阴, 7/9=阳)必须与该爻位
 *     在本卦中的静态阴阳一致, 否则**返回 null**(拒绝), 不静默改阴阳。
 *     爻变(老阳→老阴)的阴阳翻转发生在**变卦**里, 不在本卦爻位上 ——
 *     这就是老板 10-21 原话「爻动阴阳那就太过了」在数据层的落地。
 */

'use strict';

const yy = require('./yin_yang');
const yaoModels = require('./yao_models');
const baguaAxioms = require('./bagua_annotations/bagua_axioms');
const yaoAxioms = require('./bagua_annotations/yao_axioms');
const wuxingAxioms = require('./bagua_annotations/wuxing_axioms');
const wuxingMap = require('./bagua_annotations/wuxing_map');
const liuQin = require('./bagua_annotations/liu_qin');
// 2026-10-22 第 36 批: 爻五行改用真纳甲地支五行(真源) —— 见维 4 的注释。
const najia = require('./bagua_annotations/najia');

// ============================================================
// 常量定义
// ============================================================

/**
 * 默认静态爻值 —— **只在没传 opts.yaoValue 时**用。
 *   阳爻=7(少阳静)，阴爻=8(少阴静)
 * 传了爻值就按爻值走(动爻 9 老阳 / 6 老阴 ⇒ movement='dynamic')。
 *
 * ⚠️ 2026-10-23 第 56 批: 原来这里是**手打的** `{YANG: 7, YIN: 8}` +
 *   `VALID_YAO_VALUES = [6,7,8,9]` —— 于是同一套爻值约定在仓库里存了**三份**
 *   (本文件 2 份 + `yin_yang.js:YAO_VALUES` 1 份), 三份之间**零交叉校验**。
 *   实测: 把本文件的 7 改成 null, 212 段测试链**一条都不红** —— 没有任何东西
 *   知道它该等于真源。改一处不动另一处 = 静默漂移。
 * ⇒ 改为从 `yin_yang.js:YAO_VALUES`(爻值层唯一真源) 派生, 本文件不再持有副本。
 *   yin_yang.js 零 require, 本文件已在第 30 行 require 它 ⇒ 无循环依赖。
 */
const _YAO_VALUES = yy.YAO_VALUES;
const DEFAULT_YAO_VALUE = Object.freeze({
  YANG: _YAO_VALUES.SHAO_YANG,  // 少阳 静
  YIN:  _YAO_VALUES.SHAO_YIN,   // 少阴 静
});

/** 合法爻值集合(爻值层地基: 老阳9/少阳7/少阴8/老阴6) */
const VALID_YAO_VALUES = Object.freeze([
  _YAO_VALUES.LAO_YIN, _YAO_VALUES.SHAO_YANG,
  _YAO_VALUES.SHAO_YIN, _YAO_VALUES.LAO_YANG,
]);

/** wuxing_axioms.getRelation() 返回值 → 中文标签 */
const RELATION_CN = Object.freeze({
  sheng: '生',
  bei_sheng: '泄',
  ke: '克',
  bei_ke: '耗',
  tong: '同',
});

/** 合法关系集合（用于测试 sanity） */
const VALID_RELATIONS = Object.freeze(['sheng', 'bei_sheng', 'ke', 'bei_ke', 'tong']);

/** 合法六亲标签 */
const VALID_LIU_QIN = Object.freeze(['父母', '兄弟', '子孙', '妻财', '官鬼']);

// ============================================================
// 校验函数
// ============================================================

/**
 * 校验卦序号是否合法 (1-64 整数)
 * @param {*} guaId
 * @returns {boolean}
 */
function _isValidGuaId(guaId) {
  return Number.isInteger(guaId) && guaId >= 1 && guaId <= 64;
}

/**
 * 校验爻位是否合法 (0-5 整数)
 * @param {*} yaoPosition
 * @returns {boolean}
 */
function _isValidYaoPosition(yaoPosition) {
  return Number.isInteger(yaoPosition) && yaoPosition >= 0 && yaoPosition <= 5;
}

/**
 * 把 wuxing_axioms 关系转中文标签，'unknown' / 非法值用 '?'
 * @param {string} relation
 * @returns {string}
 */
function _relLabel(relation) {
  if (typeof relation !== 'string') return '?';
  return RELATION_CN[relation] || '?';
}

// ============================================================
// 爻值解析 —— 「爻动不许改阴阳」的唯一入口
// ============================================================

/**
 * 解析某一爻位上的爻值。
 *
 * 爻值 6/7/8/9 一个数同时表「阴阳」+「动静」:
 *   9=老阳(动) 7=少阳(静) | 8=少阴(静) 6=老阴(动)
 * 而「本卦某一爻位的阴阳」是**卦的 binary 定的**, 静态不变。
 * ⇒ 爻值的阴阳必须与该爻位的静态阴阳一致:
 *     阳爻位 ⇒ 合法爻值 {7 少阳, 9 老阳}
 *     阴爻位 ⇒ 合法爻值 {8 少阴, 6 老阴}
 *   矛盾(比如给阳爻位传 6/8) = 「爻动把阴阳翻了」 ⇒ **拒绝**, 不静默改阴阳。
 *
 * @param {number} guaId - 卦序号 (1-64)
 * @param {number} yaoPosition - 爻位 (0=初爻, 5=上爻)
 * @param {number} yaoValue - 爻值 (6/7/8/9)
 * @returns {{ok:true, yaoValue:number, movement:string, yinYang:number, dynamic:boolean}
 *          |{ok:false, code:string, reason:string}}
 */
function resolveYaoValue(guaId, yaoPosition, yaoValue) {
  if (!_isValidGuaId(guaId)) {
    return { ok: false, code: 'BAD_GUA_ID', reason: `卦序号应为 1..64, 实为 ${guaId}` };
  }
  if (!_isValidYaoPosition(yaoPosition)) {
    return { ok: false, code: 'BAD_YAO_POSITION', reason: `爻位应为 0..5, 实为 ${yaoPosition}` };
  }
  if (!VALID_YAO_VALUES.includes(yaoValue)) {
    return {
      ok: false,
      code: 'BAD_YAO_VALUE',
      reason: `爻值应为 6/7/8/9(老阳/少阳/少阴/老阴), 实为 ${yaoValue}`,
    };
  }

  const binary = yaoModels.getBinary(guaId);
  if (typeof binary !== 'string' || binary.length !== 6) {
    return { ok: false, code: 'NO_BINARY', reason: `卦 ${guaId} 取不到 binary` };
  }
  const bit = parseInt(binary[yaoPosition], 10);
  if (bit !== 0 && bit !== 1) {
    return { ok: false, code: 'BAD_BINARY', reason: `卦 ${guaId} 第 ${yaoPosition + 1} 爻的 binary 位不是 0/1` };
  }

  // 本卦该爻位的**静态阴阳**(binary 定, 动爻也不改)
  const staticYinYang = bit;                 // 0=阴 1=阳
  const valueYinYang = yy.yaoToBinary(yaoValue);
  if (valueYinYang !== staticYinYang) {
    return {
      ok: false,
      code: 'YINYANG_CONFLICT',
      reason: `卦 ${guaId} 第 ${yaoPosition + 1} 爻在本卦是`
        + `${staticYinYang === 1 ? '阳' : '阴'}爻, 传进来的爻值 ${yaoValue} 却是`
        + `${valueYinYang === 1 ? '阳' : '阴'}爻 —— `
        + '爻值不许翻转本卦爻位的阴阳(爻变在变卦里发生, 不在爻位上)',
    };
  }

  const movement = yy.getMovement(yaoValue);
  return {
    ok: true,
    yaoValue,
    movement,
    yinYang: staticYinYang,
    dynamic: movement === 'dynamic',
  };
}

/**
 * 暴露用于测试 / 调试 — 关系常量与映射
 */
function _getWuxingMap() {
  return { RELATION_CN, VALID_RELATIONS };
}

// ============================================================
// 八卦组装辅助
// ============================================================

/**
 * 从卦二进制串拆出上/下八卦的公理对象
 * 约定：binary 串索引 0=初爻(LSB), 5=上爻(MSB)
 *   - lower (下卦) = binary[0..2]
 *   - upper (上卦) = binary[3..5]
 * @param {string} binary - 6 位二进制字符串
 * @returns {{ upper: object|null, lower: object|null }}
 */
function _resolveBaguaPair(binary) {
  if (typeof binary !== 'string' || binary.length !== 6) {
    return { upper: null, lower: null };
  }
  const lowerBits = binary.slice(0, 3);
  const upperBits = binary.slice(3, 6);
  return {
    upper: baguaAxioms.getBaguaByBits(upperBits),
    lower: baguaAxioms.getBaguaByBits(lowerBits),
  };
}

// ============================================================
// 核心 API
// ============================================================

/**
 * 获取单爻的 8 维向量
 * @param {number} guaId - 卦序号 (1-64, 伏羲序)
 * @param {number} yaoPosition - 爻位 (0=初爻, 5=上爻)
 * @param {object} [opts]
 * @param {number} [opts.yaoValue] - 爻值 (6/7/8/9)。
 *   不传 ⇒ 按该爻位静态阴阳取默认静值(阳7/阴8)。
 *   传了 ⇒ yaoValue/movement 按爻值走(动爻 9/6 ⇒ movement='dynamic')。
 *   **爻值阴阳与该爻位静态阴阳矛盾 ⇒ 返回 null**(拒绝, 不静默改阴阳)。
 * @param {object} [opts.najia] - 纳甲层可注入(默认用真表)。
 *   ⚠️ 2026-10-22 第 41 批: 八卦纳甲地支补齐后, 「装不出纳甲」这条路径
 *     在**真实数据上走不到**了 ⇒ 依赖它才能验的性质(缺数据时爻五行必须空)
 *     会在补齐的那一刻**静默失效**。留这个口子, 测试才能自己造缺口。
 *     生产调用方**不传**, 行为与从前逐字一致。
 * @returns {object|null} 8 维向量对象；参数非法 / 数据缺失返回 null
 */
function getYaoVector(guaId, yaoPosition, opts = {}) {
  // ---------- 参数校验 ----------
  if (!_isValidGuaId(guaId) || !_isValidYaoPosition(yaoPosition)) return null;

  // ---------- 取底层数据 ----------
  const guaInfo = wuxingMap.getWuxing(guaId);
  if (!guaInfo || guaInfo.bagong === '未知') return null;

  const yaoPosInfo = yaoAxioms.getYaoPositionAxiom(yaoPosition);
  if (!yaoPosInfo) return null;

  const binary = yaoModels.getBinary(guaId);
  if (typeof binary !== 'string' || binary.length !== 6) return null;

  // ---------- 维 2: 阴阳 + 动静 ----------
  const bit = parseInt(binary[yaoPosition], 10);
  if (bit !== 0 && bit !== 1) return null;
  const yinYang = yy.yaoToBinary(bit); // 0=YIN, 1=YANG
  // 2026-10-22 第 37 批: 爻值接进来了。
  //   ⚠️ 爻值**只改 movement**(静/动), 不改 yaoWuxing, 也不改 yinYang ——
  //     爻的五行只有一个来源(纳甲地支五行), 爻的阴阳由卦的 binary 定死。
  //   爻值阴阳跟爻位静态阴阳矛盾时(比如给阳爻位传 6 老阴)⇒ 返回 null:
  //     那正是「爻动把阴阳翻了」, 老板 10-21 原话「爻动阴阳那就太过了」。
  let yaoValue;
  let movement;
  if (opts && opts.yaoValue !== undefined && opts.yaoValue !== null) {
    const resolved = resolveYaoValue(guaId, yaoPosition, opts.yaoValue);
    if (!resolved.ok) return null;   // 矛盾 / 非法 ⇒ 拒绝
    yaoValue = resolved.yaoValue;
    movement = resolved.movement;
  } else {
    yaoValue = yinYang === 1 ? DEFAULT_YAO_VALUE.YANG : DEFAULT_YAO_VALUE.YIN;
    movement = yy.getMovement(yaoValue); // static/dynamic
  }

  // ---------- 维 3: 八卦 ----------
  const { upper, lower } = _resolveBaguaPair(binary);
  if (!upper || !lower) return null;
  const upperBagua = { name: upper.name, symbol: upper.symbol, wuxing: upper.wuxing };
  const lowerBagua = { name: lower.name, symbol: lower.symbol, wuxing: lower.wuxing };

  // ---------- 维 4: 五行 + 关系 ----------
  const guaWuxing = guaInfo.wuxing;
  // 2026-10-22 第 36 批: 爻五行改用**真纳甲地支五行**。
  //   原来取 `yaoPosInfo.wuxing`(= 爻位固定五行表 初水二木三火四金五土上火)——
  //   那张表在真源里查无出处, 且与真纳甲在 4 个可验卦上 20/24 冲突。
  //   更要紧的是**同源一致性**: 维 6 的六亲「第他侧」也用爻的五行,
  //   两边必须取同一个值, 否则同一个向量里「爻五行」和「六亲」会打架。
  //   装不出纳甲的爻位 ⇒ 爻五行/关系为空字符串,
  //   **不拿别的东西顶** —— 那是"没给的地方模型自己编"的病根。
  const _nj = (opts && opts.najia) || najia;
  const _gz = _nj.getYaoGanzhi(guaId, yaoPosition + 1);   // 纳甲用 1 基爻位
  const yaoWuxing = _gz.ok ? _gz.wuxing : '';
  const relation = yaoWuxing ? wuxingAxioms.getRelation(guaWuxing, yaoWuxing) : 'unknown';
  const wuxingRel = yaoWuxing ? `${guaWuxing}${_relLabel(relation)}${yaoWuxing}` : '';

  // ---------- 维 5: 爻位 ----------
  const yaoName = yinYang === 1 ? yaoPosInfo.yaoName_yang : yaoPosInfo.yaoName_yin;
  const positionNature = yaoPosInfo.nature;

  // ---------- 维 6: 六亲 ----------
  //   ⚠️ 六亲必须跟**同一个**纳甲源走(维 4 用的那个), 不能各用各的 ——
  //   否则同一个向量里「爻五行」和「六亲」会打架(爻五行是空的, 六亲却编得出来)。
  //   这正是本文件维 4 注释里那句「两边必须取同一个值」的意思。
  //   第 41 批: 纳甲可注入(负例要自己造缺口), 这里把注入源一并传下去。
  const lq = liuQin.computeLiuQin(guaId, yaoPosition, { najia: _nj });

  // ---------- 维 7: 爻辞 ----------
  // yao_models.getYaoByPosition 用 1-indexed (1=初爻, ..., 6=上爻)
  const yaoCi = yaoModels.getYaoByPosition(guaId, yaoPosition + 1);

  // ---------- 组装返回 ----------
  return {
    // 维 1: ID
    guaId,
    yaoPosition,

    // 维 2: 阴阳 + 动静
    yinYang,
    movement,
    yaoValue,

    // 维 3: 八卦
    upperBagua,
    lowerBagua,

    // 维 4: 五行
    guaWuxing,
    yaoWuxing,
    wuxingRel,

    // 维 5: 爻位
    yaoName,
    positionNature,

    // 维 6: 六亲
    liuQin: lq,

    // 维 7: 爻辞
    yaoCi,

    // 维 8: 变卦（扩展位，暂留 null）
    changedGuaId: null,
    changedYao: null,
  };
}

/**
 * 获取某卦全部 6 爻的 8 维向量
 * @param {number} guaId - 卦序号 (1-64)
 * @param {object} [opts] - 透传给 getYaoVector(如 { yaoValue })
 * @returns {Array|null} 长度为 6 的向量数组；guaId 非法返回 null
 */
function getGuaVector(guaId, opts = {}) {
  if (!_isValidGuaId(guaId)) return null;
  const result = [];
  for (let pos = 0; pos < 6; pos++) {
    const v = getYaoVector(guaId, pos, opts);
    if (!v) return null;
    result.push(v);
  }
  return result;
}

/**
 * 展开 64 卦 × 6 爻 = 384 爻完整向量表（Pangu 核心数据结构）
 * @returns {Array} 长度 === 384 的向量数组
 */
function getAll384YaoVectors() {
  const result = [];
  for (let g = 1; g <= 64; g++) {
    for (let p = 0; p < 6; p++) {
      const v = getYaoVector(g, p);
      if (v) result.push(v);
    }
  }
  return result;
}

/**
 * 批量取若干卦的向量，返回扁平化数组
 * @param {number[]} guaIds - 卦序号数组
 * @returns {Array} 长度 = 有效输入数 × 6 的向量数组
 *                  非数组输入 → 空数组
 *                  非法 guaId 跳过（不抛错）
 */
function getVectorsForGuas(guaIds) {
  if (!Array.isArray(guaIds)) return [];
  const result = [];
  for (const g of guaIds) {
    const vec6 = getGuaVector(g);
    if (vec6) result.push(...vec6);
  }
  return result;
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  // 核心 API
  getYaoVector,
  getGuaVector,
  getAll384YaoVectors,
  getVectorsForGuas,
  // 爻值解析(「爻动不许改阴阳」的唯一入口) —— 守卫/测试用
  resolveYaoValue,

  // 常量 (供外部测试 / 调用方参考)
  DEFAULT_YAO_VALUE,
  VALID_YAO_VALUES,
  RELATION_CN,
  VALID_RELATIONS,
  VALID_LIU_QIN,

  // 测试 / 调试
  _relLabel,
  _getWuxingMap,
};
