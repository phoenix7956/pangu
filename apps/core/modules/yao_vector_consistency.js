/**
 * 爻向量自洽守卫 —— 抓「爻名和爻五行说的不是同一爻」
 *
 * ⚠️ **调用契约 (先看这条)**: 必须喂**对外输出的一对字段**
 *   `{ guaId, yaoName: 输出的爻名, yaoWuxing: 输出的爻五行 }`。
 *   **不许喂 `hexagram_vector.getYaoVector()` 的返回值** —— 那两个字段**同源**,
 *   喂它 = 喂一个**结构上永远自洽**的东西, 守卫在真实链路上**永远不会响**。
 *   2026-10-22 第一版就是这么写的, 全绿, 等于没装。
 *
 * 起因 (2026-10-22 现场, `a513130` 修的同一个 bug 的**后果**):
 *   `movingYao` 是 1-based, `getYaoVector` 形参是 0-based, 直接传 → 错位一爻。
 *   错位后的输出长这样:
 *     yao_name: 六四    ← 来自 yaoCiAll[movingYao-1], **这条是对的**
 *     yao_wuxing: 土    ← 来自错位的 vector, 是**九五**的五行
 *     liu_qin: 妻财    ← 同上, 九五的六亲
 *
 * 为什么它能一路活到今天:
 *   因为 `yao_name` 是对的, **看起来整条链都对**。错的只有五行/六亲/爻位性质
 *   那几个字段, 而且不抛不警告。上爻更静默: 越界 → vector=null → 四个字段全空,
 *   卦起起来了, 五行和六亲却是空的 —— 不像出错, 像没数据。
 *   修完跑全量 240 个测试文件**零失败** —— 说明这条路径从没被任何测试覆盖过。
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么用「自洽」而不是「对真源」
 * ═══════════════════════════════════════════════════════════════
 *
 * 另一个思路是拿答案/输出对 `64i` 真源逐字段核。那条路有两个问题:
 *   ① **误伤**: 爻名「六四」的合法写法太多(带引号/不带/全角/半角/带爻辞),
 *      而模型还会合法地谈**多个**爻、谈体用五行。逐字段核真源必然误伤,
 *      而项目铁律是「误伤比漏检贵」。
 *   ② **它只能抓一种**: 换了别的错位方向(比如整个取错卦)就不灵了。
 *
 * 本守卫只问一个问题, 且**不需要任何术数知识**:
 *     「你报的爻名, 和你报的爻五行, 说的是不是同一爻?」
 *
 *   六四 是四爻 → 四爻的纳甲地支五行。若你同时报「土」, 那土是别的爻的 ——
 *   **两个字段自相矛盾, 这在定义上就是错的**, 不需要判断哪个对。
 *
 * 误伤防线: 只在「**能解析出爻名**」且「**能定位到该爻**」时才判。
 * 解析不出来(空/怪写法/模型自由行文)一律放过 —— 宁可漏检, 不可误伤。
 * 它抓的不是「说得对不对」, 是「**自己跟自己打架**」。
 *
 * 这条守卫的价值在于它**认的是那一类错, 不是那一个 bug**:
 * 任何未来的 off-by-one / 取错表 / 错位传参, 只要让爻名和爻五行对不上, 都会被抓住。
 *
 * ═══════════════════════════════════════════════════════════════
 * ⚠️ 第 36 批: 尺子换源 + **为什么多出一道 `checkYaoIndexAligned`**
 * ═══════════════════════════════════════════════════════════════
 *
 *   ① **尺子必须跟着输出一起换源, 不能只换一半**。
 *      原来尺子是 `yao_axioms.getYaoPositionAxiom(idx).wuxing`(爻位固定五行表),
 *      输出 `vector.yaoWuxing` 也在同一批里换成了 `najia` 的纳甲地支五行。
 *      只换输出不换尺子 ⇒ 尺子与被测对象**不同源但结论相反** ⇒ 4 个能装卦的卦
 *      一律乱报矛盾(实测 10 条测试当场炸)。这跟「同源 ⇒ 恒真」是同一个病的
 *      另一头: **异源但没换干净 ⇒ 恒假**。断言报错先怀疑尺子, 两头都成立。
 *
 *   ② **新尺子曾经只有 4/64 卦有**(第 41 批补齐八卦地支后已是 384/384 满覆盖) ——
 *      但补齐之前那段日子正好说明问题: 「爻五行」这一半判据在 60 个卦上是**空的**,
 *      而它要抓的 off-by-one 恰恰**跟五行没关系**。
 *      ⚠️ 所以 `checkYaoIndexAligned` **不许因为尺子补齐就删掉** ——
 *        它不依赖五行, 哪天纳甲再出现缺口, 它仍然 384/384 有效。
 *      ⇒ 所以补一道 **`checkYaoIndexAligned`**: 比「输出爻名」与「vector 里的爻名」。
 *        两个爻名来自**两张不同的表**(爻辞表 `hexagrams.yao_ci` vs 爻位公理表
 *        `yao_axioms.yaoName_*`), 错位一爻必然对不上 —— 而它 **64/64 卦都成立**,
 *        一点五行都不需要。尺子哪天退化, 由它兜住。
 *
 *   ③ **「验不了」必须可见**。纳甲装不出的卦, `checkVectorConsistency` 返回
 *      `{ok:true, checked:true, ruler:null, unverifiable:'...'}` ——
 *      ok 是「没有矛盾」, 不是「验过了」。踩坑日志里那条
 *      「『跳过』也是判定路径」就是这个: `unverifiable` 混进 `ok:true` 里
 *      不出声, 三个月后没人知道这道守卫其实在一大半卦上是空的。
 */

'use strict';

const path = require('path');

const CORE = path.join(__dirname, '..');
const yaoAxioms = require(path.join(CORE, '64i', 'bagua_annotations', 'yao_axioms.js'));
const najia = require(path.join(CORE, '64i', 'bagua_annotations', 'najia.js'));

/**
 * 爻名 → 爻位下标 (0=初爻 … 5=上爻)。
 *
 * 两种命名都要认: 阳爻(初九/九二/…) 与 阴爻(初六/六二/…) ——
 * 「初」和「上」在两端, 中间四位是九/六 + 数位。
 *
 * @param {string} yaoName 形如 六四 / 九二 / 初九 / 上六
 * @returns {number|null} 0..5; 认不出来返回 null (调用方据此放过, 不误伤)
 */
function parseYaoNameIndex(yaoName) {
  if (typeof yaoName !== 'string') return null;
  const s = yaoName.trim();
  if (!s) return null;
  // 上六 / 上九 → idx5
  if (/^上[六九]/.test(s)) return 5;
  // 初六 / 初九 → idx0
  if (/^初[六九]/.test(s)) return 0;
  // 六二/九二 … 六五/九五 → idx = 数位 - 1
  const m = s.match(/^[六九]([二三四五])$/);
  if (m) {
    const n = '二三四五'.indexOf(m[1]) + 2;   // 二→2 … 五→5
    return n - 1;                             // → idx1..4
  }
  // 2026-10-22 (写测试时被抓到, 尺子太严 = 守卫静默放过一切):
  //   上面三条都锚了整串, 于是「六四：月几望」这种**带爻辞**的写法认不出来 →
  //   checkVectorConsistency 直接 return {ok:true} **静默放过**。
  //   而「认不出来就放过」正是这道守卫最危险的失效方式 ——
  //   它会退化成一段没人看的代码, 还显得在尽职。
  //
  //   放宽到「串里含一个爻名就算」: 这里只影响**覆盖率**(多抓矛盾),
  //   不影响**误伤面** —— 判不判仍取决于五行是否与该爻真值冲突,
  //   跟解析宽松无关。而且本函数只吃向量对象里那**单个** yaoName 值,
  //   不是自由行文, 不存在「初九到上九」这种范围表述被误读的问题。
  const loose = s.match(/上[六九]|初[六九]|[六九][二三四五]/);
  if (loose) {
    if (/^上[六九]/.test(loose[0])) return 5;
    if (/^初[六九]/.test(loose[0])) return 0;
    const n2 = '二三四五'.indexOf(loose[0][1]) + 2;
    if (n2 >= 2) return n2 - 1;
  }
  return null;
}

/**
 * 校验「对外输出的一对字段」是否自洽: 爻名 与 爻五行 说的是不是同一爻。
 *
 * ⚠️ **输入必须是「输出的一对字段」, 不是引擎内部的 vector** —— 这条是本守卫
 *   能不能咬人的关键 (2026-10-22 第二十八批实测踩到):
 *
 *   `hexagram_vector.getYaoVector()` 返回的 `yaoName` 和 `yaoWuxing`
 *   **同源** —— 两者都取自 `yao_axioms.getYaoPositionAxiom(pos)` 这**同一个** axiom:
 *     yaoName   = axiom.yaoName_yang / yaoName_yin
 *     yaoWuxing = axiom.wuxing
 *   所以喂 vector 进去, 它**结构上永远自洽** —— 守卫在真实链路上**永远不会响**,
 *   而测试「384 组真实数据全过」正是喂的 vector, 所以那条测试是**恒真**的
 *   (尺子和被测对象同源 —— 断言报错先怀疑尺子, 这回是尺子本身在骗人)。
 *
 *   真正的矛盾在**输出层**: 输出里 `yao_name` 取自 `yao_ci[movingYao-1]` 的前缀,
 *   而 `yao_wuxing` 取自 vector —— **两者来自不同的表**, 只有下标对齐时才自洽。
 *   原 bug(动爻 1-based 传给 0-based API)正是让这两者错开一爻:
 *     yao_name=六四(来自 yao_ci[3], 对) + yao_wuxing=土(来自 vector 的 idx4, 错)
 *   → 同一个回答里两半在描述**不同的爻**。
 *
 *   所以调用方必须喂**输出的一对字段**:
 *   { guaId, yaoName: 输出的爻名, yaoWuxing: 输出的爻五行 }。
 *
 * @param {object} v {guaId?: number, yaoName: string, yaoWuxing: string}
 *        —— 对外输出的那一对字段。`guaId` **第 36 批起必填**
 *          (尺子要靠它取该爻的纳甲地支五行)。
 * @param {object} [opts]
 *   opts.requireWuxing: 认得出爻名、但爻五行是空 → 判为 YAO_WUXING_MISSING。
 *     为什么需要这一条: 那个 off-by-one 撞到**上爻**时不是错位一爻, 是**越界** ——
 *     getYaoVector(idx=6) 越出 0..5 → 返回 null → 卦起出来了, 爻五行/六亲
 *     **静默全空**。那不是「自相矛盾」, 但同样不是好数据, 同样得让人看见。
 *     (默认不开: 通用的一对字段检查里, 缺字段是「没数据」不是「错」, 判了就误伤。)
 * @returns {{ok: boolean, checked: boolean, reason?: string, detail?: object,
 *            ruler?: string|null, unverifiable?: string, unverifiable_reason?: string}}
 *   ⚠️ `unverifiable` 与 `ok:true` 同时出现 = 「**没验**, 不是验过了」。
 *   调用方若只看 ok, 这道守卫在 60/64 卦上就等于不存在 —— 别这么用。
 *   (踩坑日志:「『跳过』也是判定路径 —— 数据坏了能落进去就必须能自己报警」)
 */
function checkVectorConsistency(v, opts = {}) {
  if (!v || typeof v !== 'object') return { ok: true, checked: false };
  const idx = parseYaoNameIndex(v.yaoName);
  if (idx === null) return { ok: true, checked: false, unverifiable: 'YAO_NAME_UNPARSEABLE' };

  // ── 尺子: 该卦该爻的**纳甲地支五行**(第 36 批换源) ──
  //   ⚠️ 尺子必须和输出**一起**换源: 只换输出不换尺子 ⇒ 尺子与被测对象结论相反
  //   ⇒ 能装卦的 4 个卦一律乱报(实测 10 条测试当场炸)。
  //   「同源 ⇒ 恒真」的反面是「异源但没换干净 ⇒ 恒假」。断言报错先怀疑尺子, 两头都成立。
  //   第 41 批: 八卦地支 8/8 补齐 ⇒ 384/384 满覆盖。
  //   但这条「装不出 ⇒ 说验不了」的分支**不许删**(爻位固定五行表已撤,
  //   缺口时**不许拿别的东西顶**) —— 万一纳甲再出现缺口, 它是唯一的诚实出口。
  const guaId = v.guaId;
  let gz = null;
  if (typeof guaId === 'number' && Number.isInteger(guaId)) {
    try { gz = najia.getYaoGanzhi(guaId, idx + 1); } catch (e) { gz = null; }
  }
  if (!gz || !gz.ok) {
    return {
      ok: true,
      checked: true,
      ruler: null,
      unverifiable: gz && gz.error ? gz.error.code : 'NO_GUA_ID',
      unverifiable_reason: gz && gz.error
        ? gz.error.message
        : '没给 guaId, 取不到该爻的纳甲地支五行 ⇒ 五行这一半验不了',
    };
  }
  // 装出了干支却查不到它的五行 ⇒ 那是数据坏了(纳甲层与地支五行表脱节), 不是"没数据"
  if (!gz.wuxing) {
    return {
      ok: false,
      checked: true,
      ruler: 'NAJIA_ZHI_NO_WUXING',
      reason: 'NAJIA_GANZHI_HAS_NO_WUXING',
      detail: {
        yaoName: v.yaoName, yaoNameIndex: idx, guaId, ganzhi: gz.ganzhi,
        hint: '装出了干支却查不到它的五行 —— 纳甲层与地支五行表脱节了',
      },
    };
  }
  const truth = { wuxing: gz.wuxing, ganzhi: gz.ganzhi };

  // 字段缺失不判: 缺字段是「没数据」(可能另有守卫管), 不是「自相矛盾」。
  // 这里只抓**两个字段都在、却互相打架** —— 那才是错位类 bug 的签名。
  if (!v.yaoWuxing) {
    if (!opts.requireWuxing) return { ok: true, checked: true, ruler: 'NAJIA' };
    return {
      ok: false,
      checked: true,
      ruler: 'NAJIA',
      reason: 'YAO_WUXING_MISSING',
      detail: {
        yaoName: v.yaoName,
        yaoNameIndex: idx,
        guaId,
        expectedWuxing: truth.wuxing,
        expectedGanzhi: truth.ganzhi,
        hint: '爻名认得出、爻五行却是空 —— 通常是爻位下标越界(合法 0..5), vector 取空了',
      },
    };
  }
  if (v.yaoWuxing === truth.wuxing) {
    return {
      ok: true, checked: true, ruler: 'NAJIA',
      detail: { yaoNameIndex: idx, expectedGanzhi: truth.ganzhi },
    };
  }

  return {
    ok: false,
    checked: true,
    ruler: 'NAJIA',
    reason: 'YAO_NAME_WUXING_CONTRADICTION',
    detail: {
      yaoName: v.yaoName,
      yaoNameIndex: idx,
      guaId,
      claimedWuxing: v.yaoWuxing,
      expectedWuxing: truth.wuxing,
      expectedGanzhi: truth.ganzhi,
      hint: '爻名与爻五行说的不是同一爻 —— 典型是 1-based/0-based 错位传参',
    },
  };
}

/**
 * 爻位对齐守卫 —— 比「输出爻名」与「vector 里的爻名」是不是同一爻。
 *
 * ★ 为什么它是第 36 批**必须补**的一环(不是锦上添花):
 *   当时 `checkVectorConsistency` 的尺子换成了纳甲地支五行, 而纳甲只覆盖 4/64 卦
 *   ⇒ 五行那一半在 60 个卦上**验不了**。可它要抓的 off-by-one 错位,
 *   **跟五行一点关系都没有** —— 错的是「下标」, 不是「五行」。
 *   只留五行那一半 = 这道守卫从 64/64 掉到 4/64, 而掉的正好是它本来要抓的东西。
 *   ⚠️ 第 41 批纳甲补齐后五行那一半也满了, **但本判据不许因此删除** ——
 *     它与五行解耦, 纳甲一旦再出现缺口, 只有它还能 384/384 继续咬。
 *
 *   本判据不需要五行: 两个爻名分别来自**两张不同的表**
 *     · 输出侧 `hexagrams[guaId].yao_ci[i]` 的前缀(爻辞表)
 *     · 向量侧 `yao_axioms.getYaoPositionAxiom(i).yaoName_*`(爻位公理表)
 *   两者只靠**下标对齐**才自洽 ⇒ 错位一爻立刻不一致, 且 **64/64 卦都成立**。
 *
 * @param {object} v {guaId:number, yaoName:string, vectorYaoName?:string}
 *   `vectorYaoName` = `hexagram_vector.getYaoVector(guaId, idx).yaoName`。
 *   ⚠️ 这是 vector 的**一个字段**, 不是整个 vector: 它与输出爻名来自不同的表,
 *   所以不是「拿尺子量自己」。整个 vector 才是同源的(爻名与爻五行同出一张公理),
 *   喂整个进来这道判据会恒真 —— 与本文件头注释里那条老教训同源。
 * @returns {{ok:boolean, checked:boolean, reason?:string, detail?:object, unverifiable?:string}}
 */
function checkYaoIndexAligned(v) {
  if (!v || typeof v !== 'object') return { ok: true, checked: false };
  const outIdx = parseYaoNameIndex(v.yaoName);
  if (outIdx === null) return { ok: true, checked: false, unverifiable: 'YAO_NAME_UNPARSEABLE' };
  if (!v.vectorYaoName) {
    return {
      ok: true, checked: false, unverifiable: 'NO_VECTOR_YAO_NAME',
      unverifiable_reason: '没给 vectorYaoName ⇒ 验不了向量侧的爻名(别当成「验过了」)',
    };
  }
  const vecIdx = parseYaoNameIndex(v.vectorYaoName);
  if (vecIdx === null) {
    return { ok: true, checked: false, unverifiable: 'VECTOR_YAO_NAME_UNPARSEABLE' };
  }
  if (outIdx === vecIdx) {
    return {
      ok: true, checked: true,
      detail: { yaoIndex: outIdx, yaoName: v.yaoName, vectorYaoName: v.vectorYaoName },
    };
  }
  return {
    ok: false,
    checked: true,
    reason: 'YAO_INDEX_MISALIGNMENT',
    detail: {
      guaId: v.guaId,
      outputYaoName: v.yaoName,
      outputIndex: outIdx,
      vectorYaoName: v.vectorYaoName,
      vectorIndex: vecIdx,
      hint: '输出爻名(爻辞表)与向量爻名(爻位公理表)差 ' + (vecIdx - outIdx)
        + ' 爻 —— 1-based/0-based 错位传参',
    },
  };
}

// ============================================================
// 守卫健康检查 (可喂负例)
// ============================================================

/**
 * 健康检查 —— 这条守卫最危险的失效方式是「**认不出爻名**」:
 * 一旦 parseYaoNameIndex 对真实写法认不出来, 它会**静默放过一切**
 * (为了不误伤), 于是变成一段没人看的代码。所以这里拿爻名逐个验一遍解析 ——
 * 认不出来就算这道守卫坏了。
 *
 * 拆成「返回问题清单」而不是「直接抛」, 是为了**能喂负例**:
 *   拿一份故意坏掉的样本喂它, 必须报出问题 —— 否则「检查通过」这句话本身
 *   就是恒真的, 等于没检查。 (同 `yao_layer_boundary` 的分项导出做法)
 *
 * @param {Array<{name: string, index: number}>} samples 待验的爻名样本
 * @returns {{ok: boolean, problems: string[]}}
 */
function checkGuardHealth(samples) {
  const problems = [];
  for (const s of (samples || [])) {
    const got = parseYaoNameIndex(s.name);
    if (got !== s.index) {
      problems.push('爻名「' + s.name + '」解析成 idx' + got + ', 应为 ' + s.index
        + ' —— 认不出来会**静默放过一切**, 这条守卫必须拆穿');
    }
  }

  // ⚠️ 期望值**手写**, 不从被测函数自己算 ——
  //   「尺子和被测对象同源 = 恒真守卫」。这里手写的是真源原文
  //   「乾六爻自初爻至上面爻之爻辰为『子寅辰午申戌』」+ 地支五行,
  //   跟 getYaoGanzhi 的计算路径无关, 才算一把**异源**的尺子。
  const QIAN_DIZHI_WUXING = ['水', '木', '土', '火', '金', '土'];  // 子寅辰午申戌

  // 守卫必须**会咬人**: 造一个自相矛盾的向量, 必须被拒。
  //   六四 是四爻(idx3, 真纳甲午火); 报「金」= 五爻(申)的五行 ⇒ 必须判矛盾。
  const fake = { guaId: 1, yaoName: '六四', yaoWuxing: QIAN_DIZHI_WUXING[4] };
  const r = checkVectorConsistency(fake);
  if (r.ok) {
    problems.push('造出自相矛盾的向量(六四 却报金)竟然通过了 —— 守卫是永真的');
  }
  // 反向: 不可误伤 —— 自洽的必须放行, 认不出的必须放过
  if (!checkVectorConsistency({ guaId: 1, yaoName: '六四', yaoWuxing: QIAN_DIZHI_WUXING[3] }).ok) {
    problems.push('自洽的向量被误判 —— 会误伤正常输出');
  }
  if (!checkVectorConsistency({ guaId: 1, yaoName: '随便什么', yaoWuxing: '火' }).ok) {
    problems.push('认不出的爻名应放过(不误伤), 却被判 —— 守卫会咬正常文本');
  }
  // 纳甲装不出的卦必须**说验不了**, 而不是报 ok 就完
  //   —— 「验不了」混进 ok:true 里不出声, 这道守卫就会退化成没人看的代码。
  // ⚠️ 第 41 批起这里用**不存在的卦号**(9999) 触发, 不再用震为雷(51):
  //   八卦纳甲地支补齐后, **64 个真实卦全都装得出纳甲**,
  //   拿真实卦当「装不出」的样本, 这条负例会在真源补齐的那一刻**静默失效**
  //   (变成永远绿, 而守卫其实已经不测那条路了)。踩坑日志那条
  //   「旧测试可能在钉假口径」的正解: 负例要用**构造出来的**输入, 不靠真实数据的缺口。
  const noRuler = checkVectorConsistency({ guaId: 9999, yaoName: '六四', yaoWuxing: '随便什么' });
  if (noRuler.ok !== true) {
    problems.push('纳甲装不出的卦被乱判矛盾了 —— 没尺子就不该判(误伤)');
  }
  if (!noRuler.unverifiable) {
    problems.push('纳甲装不出的卦返回了 ok:true 却**没标 unverifiable** —— '
      + '「没验」会被读成「验过了」, 守卫悄悄退化成空壳');
  }

  // 爻位对齐守卫: 咬得住, 且不误伤
  if (checkYaoIndexAligned({ guaId: 1, yaoName: '六四', vectorYaoName: '六五' }).ok) {
    problems.push('爻位对齐守卫对「四爻名 vs 五爻名」竟然放过了 —— 错位一爻抓不住');
  }
  if (!checkYaoIndexAligned({ guaId: 1, yaoName: '六四', vectorYaoName: '九四' }).ok) {
    problems.push('爻位对齐守卫误伤了「六四 vs 九四」—— 阴阳命名不同但**同一爻**, 不该判');
  }
  const noVecName = checkYaoIndexAligned({ guaId: 1, yaoName: '六四' });
  if (noVecName.ok !== true || !noVecName.unverifiable) {
    problems.push('没给 vectorYaoName 时必须 ok + 标 unverifiable, 不能默默当验过了');
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 从真源取 12 个爻名 (6 爻位 × 阴阳两套命名) 作为健康检查样本。
 * **不手抄一份**: 手抄的表会与真源漂, 漂了就等于在验一张废纸。
 */
function buildGuardHealthSamples() {
  const samples = [];
  for (let i = 0; i < 6; i++) {
    const a = yaoAxioms.getYaoPositionAxiom(i);
    if (!a) {
      samples.push({ name: '__MISSING_IDX_' + i + '__', index: -1 });
      continue;
    }
    samples.push({ name: a.yaoName_yin, index: i });
    samples.push({ name: a.yaoName_yang, index: i });
  }
  return samples;
}

/**
 * 装时自检 —— 越界即抛。
 *
 * 放在**启动链**里 (pangu-single.js), 不放在模块 load 期:
 *   load 期抛 ⇒ 谁 require 谁炸 ⇒ 调用方只能拿 try/catch 包着 ⇒ **自检被吞**,
 *   守卫带着「装时自检」的名号, 实际上一道都跑不成 (2026-10-22 实测踩到)。
 *   启动链抛 ⇒ 一次性、可见、且有明确的失败现场。
 */
function assertYaoVectorConsistencyGuard() {
  const r = checkGuardHealth(buildGuardHealthSamples());
  if (!r.ok) {
    throw new Error('[yao-vector-consistency] 装时自检失败 —— 这道守卫不能带病上线:\n  - '
      + r.problems.join('\n  - ')
      + '\n  (认不出的爻名 = 静默放过一切 = 这道守卫形同虚设)');
  }
  // 覆盖率也要**说出来**, 不许只报 ok。
  //   五行那一半的尺子(纳甲地支)是**逐爻**的(内三爻取下卦纳甲、外三爻取上卦纳甲)。
  //   第 41 批补齐八卦地支后实算 384/384; 万一将来又有缺口, 这里会照实报出来,
  //   而不是沉默地在一部分爻位上放行。
  //   启动时把它打进返回值/日志, 下一个人问「六亲为什么这爻没有」时,
  //   至少有据可查, 而不是去猜守卫是不是坏了。
  //   ⚠️ 覆盖率从 najia.getCoverageStats() 取, **不手写** —— 本文件手写过的
  //   「4/64」「96/384」都曾是真值, 也都曾随着真源补齐而变假。
  let stats = null;
  try { stats = najia.getCoverageStats(); } catch (e) { stats = null; }
  return {
    ...r,
    ruler_coverage: stats ? stats.yao_loadable + '/' + stats.yao_total + ' 爻位' : 'unknown',
    ruler_coverage_detail: stats ? stats.summary : null,
    ruler_note: '爻五行判据的尺子=纳甲地支五行, 逐爻覆盖 '
      + (stats ? stats.yao_loadable + '/' + stats.yao_total : '?') + '; '
      + '爻位对齐判据(六四 vs 九四)是 384/384 爻位, 错位一爻在所有卦上都抓得住',
  };
}

module.exports = {
  parseYaoNameIndex,
  checkVectorConsistency,
  checkYaoIndexAligned,
  checkGuardHealth,
  buildGuardHealthSamples,
  assertYaoVectorConsistencyGuard,
};
