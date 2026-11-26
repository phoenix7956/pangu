/**
 * Pangu · 64i Layer
 * bagua_annotations/liu_qin.js
 *
 * Pangu 六亲动态推算 - 用 wuxing_axioms 关系矩阵替代静态表
 *
 * ⚠️ **口径演变: 第 30 批「简化取象」→ 第 36 批两侧都成了京房口径**
 *
 * 原注释写「算法 (周易传统京房六亲体系)」—— 当时**过度声称**, 因为两侧都不是京房的:
 *   京房六亲的两侧是「**宫**五行」和「爻的**纳甲地支**五行」,
 *   而当时本模块两侧是「卦五行(上卦口径)」和「爻位**固定**五行表」。
 *   两处都不是京房的东西, 却顶着京房的名头 ——
 *   后果不是报错, 是盘古**照着另一套体系**答, 而且答得像个正经结论。
 *   「注释也会骗人」这条, 2026-10-22 活了两例。
 *
 *   然后两批把两侧都换成了京房的真口径:
 *     第 30 批 「我」侧: 卦五行(上卦口径) → **京房宫五行**  (`jingfang_bagong.js`)
 *     第 36 批 「他」侧: 爻位固定五行表 → **该爻的纳甲地支五行** (`najia.js`, 真源)
 *   ⇒ 现在 `is_jingfang: true`。当覆盖率**不满**时, 「算得出的那部分是真京房六亲」
 *   与「算不出来的那部分」必须**一起**给出去, 不许只给前者 ——
 *   否则模型会在装不出的爻位上**自己编一个**(见 LIU_QIN_BASIS.note)。
 *   第 41 批补齐后覆盖率 384/384, 但这条机制**不许删**: 缺口一旦再现就得靠它。
 *
 *   ⚠️ 第 41 批: 震巽坎离艮兑六卦的六爻地支, `/Users/you/Desktop/course-source` **本地全库**搜不到
 *   (梅花易数给的是**起卦**用的纳支法, 不是装卦纳甲; 三命通会讲的是**六十甲子纳音**),
 *   已从**外部四源交叉验证**取(见 `najia_crosscheck.js`) ⇒ 现在 384/384 全装得出。
 *   缺口一旦再出现, 仍然是显式 null + 原因, 不推算填。
 *
 * 算法 (本模块实际做的):
 *   **京房宫五行 = 我**, 该爻的**纳甲地支五行 = 他**
 *   (第 30 批把「我」从卦五行换成宫五行; 第 36 批把「他」从爻位固定五行表换成纳甲地支)
 *   - 同我者    (self === other)                              → 兄弟
 *   - 对方生我  (getRelation(他, 我) === 'sheng')              → 父母
 *   - 我生对方  (getRelation(我, 他) === 'sheng')              → 子孙
 *   - 我克对方  (getRelation(我, 他) === 'ke')                 → 妻财
 *   - 对方克我  (getRelation(他, 我) === 'ke')                 → 官鬼
 *   这五条正是老板 2026-10-21 给的口径: 生我者/同我者/我生者/我克者/克我者。
 *
 * 关系矩阵来源：wuxing_axioms.js 的 WUXING_RELATION_MATRIX
 *   相生循环: 金→水→木→火→土→金 (5 元素顺生环)
 *   相克循环: 金→木→土→水→火→金 (5 元素顺克环)
 *
 * 5×5 矩阵中 25 格 = 5 tong + 5 正向 sheng + 5 正向 ke + 10 逆向 (matrix 标 'unknown')
 *   → 25 格恰好被 5 个六亲各占 5 格, 无遗漏。
 *
 * 与静态表 LIU_QIN[guaId] 的关系(在 `bagua_annotations/index.js` 里):
 *   原注释说「静态表只存 5 个六亲标签的京房分类位置 … 为向后兼容, 静态表保留在 index.js 中」。
 *   **那张表确实存在**(2026-10-22 差点写成「不存在」—— grep 被 head 截断就下了结论,
 *   差点把一句真话改成假话; 「先怀疑尺子」的又一次)。
 *   但它**不能直接用**, 2026-10-22 实测它的问题:
 *     - 64 卦在这张表里**塌成 5 种形态**(41/7/8/3/5 卦一组), 几乎不携带逐卦信息;
 *     - **key 名和值对不上**: 坤卦是 `{parents:'妻财', siblings:'父母', …}` ——
 *       key 说「父母」值却是「妻财」, 语义整个反了;
 *     - 头注释自称「京房六亲体系」—— 过度声称(同本文件上方那段);
 *     - `getLiuQin(0)` / `getLiuQin(999)` 静默返回乾卦那一行 —— 越界不报错, 给个别的卦的答案。
 *   → 静态表已改为**从本模块的动态计算派生**(单一真源), 详见 index.js。
 */

'use strict';

const wuxingMap = require('./wuxing_map');
const wuxingAxioms = require('./wuxing_axioms');
// 2026-10-22 第 36 批: 六亲「他」侧改用**真纳甲地支五行**(真源), 不再用爻位固定五行表。
//   理由(三条, 每条都有实算):
//     ① **出处**: 那张爻位固定五行表(初水二木三火四金五土上火)在 /Users/you/Desktop/course-source
//        全树**查无出处** —— 搜「爻位五行」「初爻…水」「二爻…木」只命中无关文本。
//        术数数据要么程序算(可自校验)要么从真源取, 每条带出处, 不凭印象。
//     ② **冲突**: 拿真纳甲地支(<course-source>阳德/阴德条)当异源尺子量它 ——
//        4 个能装出干支的卦(乾/坤/泰/否)共 24 个爻位, **只对上 4 个**
//        (乾、泰的前两爻, 纯巧合)。坤卦 6 个爻位**全错**。
//     ③ **结构**: 固定爻位表 ⇒ 「他」侧不随卦变 ⇒ 同宫 8 卦六亲**完全相同**,
//        而真京房六亲必然随卦变(各卦纳甲不同) ⇒ 64 卦的六亲塌成 5 种形态。
//        真京房六亲的「他」侧 = **该卦该爻的纳甲地支五行**。
const najia = require('./najia');
// 2026-10-22 (第 30 批): 六亲的「我」侧换成**京房宫五行**。
//   原来用的是「卦五行」= 上卦五行 —— 那跟六爻没关系(上卦是卦层属性),
//   而且跟京房的宫五行在 **32/64** 卦上不一致:
//     蒙卦: 上卦艮→土, 京房离宫→火;  讼卦: 上卦乾→金, 京房离宫→火。
//   京房六亲的「我」= **宫五行**, 这条是定死的, 现在有真源表可查了(上一批落的)。
const jingfangBagong = require('./jingfang_bagong');

// ============================================================
// 5 个六亲标签常量
// ============================================================

const LIU_QIN_LABELS = Object.freeze(['父母', '兄弟', '子孙', '妻财', '官鬼']);
const _VALID_SET = new Set(LIU_QIN_LABELS);

/**
 * ★ 口径声明 —— 会被工具输出带给模型, 让模型**知道自己答的是哪一套**
 *
 * 为什么要有这个常量:
 *   模型看不到这一层, 就会把它当京房六亲/传统六亲讲出去。
 *   第 36 批起两侧都对了(宫五行 + 纳甲地支五行), 所以 `is_jingfang: true` ——
 *   而「能算的那部分是真京房六亲」与「算不出来的那部分」必须**一起**给,
 *   不许只给前者(第 41 批补齐后覆盖率 384/384, 但这条机制不许删)。
 *
 * ⚠️ `coverage` 用 **getter 从表算**, 不写死字符串 ——
 *   写死过一次(「4/64」), 跟实算对不上: 纳甲是**按爻**算的, 一个卦只要
 *   **一半**的上下卦有地支, 那一半三爻就装得出来 —— 所以覆盖率既不是
 *   「整卦数」也不是固定值。手写的数会跟表漂, 而且没人发现(同 najia.js 里
 *   「hexagram_fully_loadable 手写成 2、实为 4」那次; 后来又手写「96/384」,
 *   第 41 批补齐后又变假)。**这一层从头到尾只许用 getter。**
 */
const LIU_QIN_BASIS = Object.freeze({
  self_side: '京房宫五行(64i/bagua_annotations/jingfang_bagong.js 的 gong_wuxing)',
  other_side: '该卦该爻的**纳甲地支五行**(64i/bagua_annotations/najia.js, 真源)',
  is_jingfang: true,
  get coverage() { return najia.getCoverageStats().summary; },
  get coverage_yao() {
    const s = najia.getCoverageStats();
    return s.yao_loadable + '/' + s.yao_total;
  },
  why_not: '第 36 批之前, 「他」侧用的是「爻位固定五行表」(初水二木三火四金五土上火)—— ' +
    '那张表在 /Users/you/Desktop/course-source 全树**查无出处**, 拿真纳甲地支当异源尺子量它: ' +
    '当时(第 36 批)只有 4 个可装卦, 共 24 个爻位**只对上 4 个**(乾、泰的前两爻, 巧合); ' +
    '而且它使「他」侧不随卦变 ⇒ 同宫 8 卦六亲完全相同(真京房六亲必然随卦变), ' +
    '64 卦六亲塌成 5 种形态。⇒ 已撤, 「他」侧改用真纳甲。',
  note: '对**这一爻装得出纳甲**的爻位, 这就是京房六亲, 可以照实讲(覆盖率见 coverage); ' +
    '对装不出的爻位, 六亲是 null + 原因(当前 384/384 全装得出, 走不到; 一旦走到就是真缺口)—— ' +
    '**不许自己编一个六亲出来**(那正是盘古"没给的地方模型自己编"的病)。',
});

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

// ============================================================
// 核心 API
// ============================================================

/**
 * 计算单爻六亲
 * @param {number} guaId - 卦序号 (1-64, 伏羲序)
 * @param {number} yaoPosition - 爻位 (0=初爻, 5=上爻)
 * @returns {string|null} 六亲字符串 ('父母'|'兄弟'|'子孙'|'妻财'|'官鬼');
 *                        参数越界 / 类型错误 / 数据缺失返回 null
 */
function computeLiuQin(guaId, yaoPosition, opts = {}) {
  if (!_isValidGuaId(guaId) || !_isValidYaoPosition(yaoPosition)) return null;

  const self = _selfOf(guaId);
  if (!self) return null;

  const me = self.gongWuxing;   // 六亲的「我」= 京房宫五行
  // 2026-10-22 第 36 批: 「他」侧 = **该卦该爻的纳甲地支五行**(真源)。
  //   装不出纳甲 ⇒ 返回 null, **不拿别的东西顶**。
  //   ⚠️ 第 41 批: 八卦地支补齐后真实数据已无缺口, 这条「装不出 ⇒ null」的路径
  //     在真数据上走不到 ⇒ 留 `opts.najia` 注入口子, 负例才能自己造缺口来验。
  //     生产调用方不传, 行为与从前逐字一致。
  const _nj = (opts && opts.najia) || najia;
  const gz = _nj.getYaoGanzhi(guaId, yaoPosition + 1);  // 纳甲用 1 基爻位
  if (!gz.ok) return null;
  const other = gz.wuxing;

  // 1. 同我者 → 兄弟
  if (me === other) return '兄弟';

  // 2. 对方生我 → 父母 (他 sheng 我)
  if (wuxingAxioms.getRelation(other, me) === 'sheng') return '父母';

  // 3. 我生对方 → 子孙 (我 sheng 他)
  if (wuxingAxioms.getRelation(me, other) === 'sheng') return '子孙';

  // 4. 我克对方 → 妻财 (我 ke 他)
  if (wuxingAxioms.getRelation(me, other) === 'ke') return '妻财';

  // 5. 对方克我 → 官鬼 (他 ke 我)
  if (wuxingAxioms.getRelation(other, me) === 'ke') return '官鬼';

  // 兜底: 5×5 矩阵中每对非对角格必然触发 #2-#5 之一
  // (正反 sheng + 正反 ke = 20 格 / 4 类, 每类 5 格)
  // 留 null 以排查异常输入
  return null;
}

/**
 * 六亲的「我」侧 —— 宫五行(京房口径)
 *
 * ⚠️ 为什么不是「卦五行」:
 *   卦五行(上卦口径)跟京房宫五行在 **32/64** 卦上不一致。
 *   六爻用的「我」= 卦所属宫的五行, 定死的。
 *   宫五行来自 `jingfang_bagong.js`(双源交叉 64/64), 不是回忆。
 *
 * @returns {{guaWuxing:string, gongWuxing:string, source:string}|null}
 */
function _selfOf(guaId) {
  const guaInfo = wuxingMap.getWuxing(guaId);
  if (!guaInfo) return null;
  const jf = jingfangBagong.getJingfang(guaId);
  return {
    guaWuxing: guaInfo.wuxing,                                  // 卦五行(上卦口径) —— 卦的属性
    gongWuxing: jf ? jf.gong_wuxing : guaInfo.wuxing,           // 宫五行 —— 六亲的「我」用这个
    source: jf ? '京房宫五行(' + jf.gong + '宫)' : '上卦口径(京房表缺, 兜底)',
  };
}

/**
 * 计算某卦全部 6 爻的六亲
 * @param {number} guaId - 卦序号 (1-64, 伏羲序)
 * @returns {Array<{yaoPosition:number, yaoWuxing:string|null, guaWuxing:string,
 *                   gongWuxing:string, liuQin:string|null, ganzhi:string|null,
 *                   reason:string|null}>|null}
 *          6 爻详细数组; guaId 越界返回 null。
 *          ⚠️ 第 36 批: 装不出纳甲的卦, 六亲为 **null + reason**,
 *             不再拿爻位固定五行表顶(那张表查无出处且与真纳甲 20/24 冲突)。
 */
function computeLiuQinForGua(guaId) {
  if (!_isValidGuaId(guaId)) return null;

  const self = _selfOf(guaId);
  if (!self) return null;

  const result = [];
  for (let pos = 0; pos < 6; pos++) {
    const liuQin = computeLiuQin(guaId, pos);
    // 纳甲干支(装不出的为 null) + 原因 —— 缺口要**跟着数据走**, 不只写在文档里
    const gz = najia.getYaoGanzhi(guaId, pos + 1);
    result.push({
      yaoPosition: pos,
      yaoWuxing: gz.ok ? gz.wuxing : null,   // 爻的纳甲地支五行(真源)
      ganzhi: gz.ok ? gz.ganzhi : null,      // 爻的完整干支(真源)
      guaWuxing: self.guaWuxing,     // 卦五行(上卦口径) —— 保留, 它是卦的属性
      gongWuxing: self.gongWuxing,   // 宫五行 —— 六亲实际用的「我」
      selfSource: self.source,
      liuQin,
      reason: gz.ok ? null : gz.error.message,   // 装不出的原因
    });
  }
  return result;
}

module.exports = {
  LIU_QIN_LABELS,
  LIU_QIN_BASIS,
  computeLiuQin,
  computeLiuQinForGua,
};
