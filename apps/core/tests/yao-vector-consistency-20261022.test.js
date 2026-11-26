'use strict';
// 爻向量自洽守卫 (2026-10-22, 第二十七批 → 第二十八批重写)
//
// 上一批 (a513130) 修的是**那一个** bug: movingYao 1-based 传给 getYaoVector 0-based,
// 错位一爻, 静默给错答案。
// 这一批把那一类 bug 的**签名**做成守卫:
//     爻名和爻五行说的不是同一爻 → 当场炸。
//
// ⚠️ 第二十八批实测踩到的一件事(比第一版更要紧):
//   第一版守卫喂的是 `hexagram_vector.getYaoVector()` 返回的 **vector**,
//   而 vector.yaoName 与 vector.yaoWuxing **同源** —— 都取自
//   `yao_axioms.getYaoPositionAxiom(pos)` 这**同一个** axiom:
//       yaoName   = axiom.yaoName_yang / yaoName_yin
//       yaoWuxing = axiom.wuxing
//   ⇒ 喂 vector 进去, 守卫**结构上永远自洽**, 在真实链路上**永远不会响**。
//   而第一版的「384 组真实数据全过」正是喂的 vector —— **那条测试是恒真的**
//   (尺子和被测对象同源)。断言报错先怀疑尺子, 这回是尺子本身在骗人。
//
//   真正的矛盾在**输出层**: 输出的 `yao_name` 取自 `yao_ci[...]` 的前缀,
//   输出的 `yao_wuxing` 取自 vector —— **两张表**, 只有下标对齐时才自洽。
//   所以守卫必须吃**输出的一对字段**。本批的头号测试就是验这件事:
//   在**活链路**上把 off-by-one 重新制造出来, 守卫必须当场报矛盾。
//
// 反向约束同样重要: 认不出的爻名/缺字段 一律放过。
//   抓的是「自己跟自己打架」, 不是「说得对不对」—— 误伤比漏检贵。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE = path.join(__dirname, '..');
const G = require(path.join(CORE, 'modules', 'yao_vector_consistency.js'));
const yaoAxioms = require(path.join(CORE, '64i', 'bagua_annotations', 'yao_axioms.js'));
const najia = require(path.join(CORE, '64i', 'bagua_annotations', 'najia.js'));
const hexagrams = require(path.join(CORE, '64i', 'hexagrams.js'));
const hexagramVector = require(path.join(CORE, '64i', 'hexagram_vector.js'));
const { castGua } = require(path.join(CORE, 'modules', 'gua_engine.js'));

// ⚠️ 第 36 批更正(尺子换源, 且**必须跟着输出一起换**):
//   「他」侧从「爻位固定五行表」换成了**该爻的纳甲地支五行**(真源) ——
//   守卫的尺子不跟着换, 尺子与被测对象结论相反, 能装卦的 4 个卦一律乱报
//   (「同源 ⇒ 恒真」的反面是「异源但没换干净 ⇒ 恒假」。断言报错先怀疑尺子, 两头都成立)。
//   而纳甲是**按爻**算的 ⇒ 尺子只覆盖 96/384 爻位, 60 个卦上「验不了」。
//   所以本文件同时验两道守卫:
//     ① checkVectorConsistency —— 爻名 vs **纳甲五行**   (96/384 有尺子)
//     ② checkYaoIndexAligned  —— 输出爻名 vs 向量爻名    (384/384 有尺子, 不需要五行)
//   ② 是 ① 的补充, 不是重复: ① 要五行, 而 off-by-one 错的是**下标**不是五行。

// 真源手写期望值(异源尺子, 不从被测函数自己算):
//   乾: 内甲(子寅辰) 外壬(午申戌) ⇒ 子水 寅木 辰土 午火 申金 戌土
//   泰: 乾下坤上 ⇒ 内三爻甲子甲寅甲辰(土木…), 外三爻癸丑癸亥癸酉 ⇒ 土 水 金
const QIAN_ZHI_WUXING = ['水', '木', '土', '火', '金', '土'];   // 乾: 子寅辰午申戌
const TAI_ZHI_WUXING = ['水', '木', '土', '土', '水', '金'];    // 泰: 子寅辰 + 丑亥酉

/**
 * 在**子进程**里注入故障再起卦 —— 故障注入必须隔离。
 *
 * ⚠️ 为什么不能在本进程里猴补丁 (2026-10-22 实测踩到, 坑很深):
 *   `node --test` 里**同一个文件的顶层测试是并发跑的** —— 实测:
 *     A 测试把 global 打上补丁然后 sleep 120ms
 *     B 测试立刻读到了那个补丁
 *   ⇒ 猴补丁会**泄漏到隔壁测试**。当时的现象是: 「活链路必绿」莫名报矛盾,
 *     现场是「初九 配 木」= 隔壁那个 off-by-one 补丁的效果 —— 极像真 bug,
 *     其实是测试自己污染自己。单跑绿、全量红, 差点当成真 bug 去改生产代码。
 *
 *   所以: **故障注入一律进子进程**, 补丁活不过进程边界。
 *   (同 repo 的 prompt-soul-dedup / yao-index-base 也是这个做法)
 */
function castGuaInChild(patchLine, numbers) {
  const script = [
    "const hv = require(" + JSON.stringify(path.join(CORE, '64i', 'hexagram_vector.js')) + ");",
    "const orig = hv.getYaoVector;",
    patchLine,
    "const { castGua } = require(" + JSON.stringify(path.join(CORE, 'modules', 'gua_engine.js')) + ");",
    "const r = castGua('测试起卦', { numbers: " + JSON.stringify(numbers) + " });",
    "console.log(JSON.stringify({",
    "  check: r.yao_vector_check, yao_name: r.yao_name, yao_wuxing: r.yao_wuxing,",
    "  index_check: r.yao_index_check, moving_yao: r.moving_yao, gua_id: r.gua_id,",
    "}));",
  ].join('\n');
  const env = Object.assign({}, process.env);
  delete env.NODE_TEST_CONTEXT;   // 子进程要真产 TAP, 见踩坑日志
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env });
  return JSON.parse(out.trim().split('\n').pop());
}

// ============================================================
// 一、爻名解析 (守卫的地基 —— 认不出来就静默放过一切)
// ============================================================

test('爻名解析: 六爻 × 阴阳两种命名, 共 12 种全部认得', () => {
  for (let i = 0; i < 6; i++) {
    const a = yaoAxioms.getYaoPositionAxiom(i);
    assert.equal(G.parseYaoNameIndex(a.yaoName_yin), i, a.yaoName_yin + ' 解析错');
    assert.equal(G.parseYaoNameIndex(a.yaoName_yang), i, a.yaoName_yang + ' 解析错');
  }
});

test('爻名解析: 带爻辞前缀/尾部空白也要认 (模型常这么写)', () => {
  assert.equal(G.parseYaoNameIndex(' 六四 '), 3);
  assert.equal(G.parseYaoNameIndex('六四：月几望'), 3);
  assert.equal(G.parseYaoNameIndex('初九'), 0);
  assert.equal(G.parseYaoNameIndex('上六'), 5);
});

test('★ 认不出的必须返回 null (守卫据此放过, 不误伤)', () => {
  for (const bad of ['', '  ', '随便什么', '爻位不明', null, undefined, 42, {}]) {
    assert.equal(G.parseYaoNameIndex(bad), null,
      '把「' + JSON.stringify(bad) + '」解析成了下标 —— 会拿错真源去判');
  }
});

// ============================================================
// 二、矛盾必抓
// ============================================================

test('★ 自相矛盾必抓: 六四 却报九五的五行(土)', () => {
  // 乾卦(1): 四爻纳壬午 ⇒ 午火。所以「六四 却报土」是矛盾的。
  // 这正是 a513130 那个 bug 的现场形状(爻名说六四、五行却是别的爻的)。
  const r = G.checkVectorConsistency({ guaId: 1, yaoName: '六四', yaoWuxing: '土' });
  assert.equal(r.ok, false, '矛盾没被抓 —— 守卫是永真的');
  assert.equal(r.reason, 'YAO_NAME_WUXING_CONTRADICTION');
  assert.equal(r.detail.yaoNameIndex, 3);
  assert.equal(r.detail.expectedWuxing, '火', '尺子应是乾四爻纳甲午火');
  assert.equal(r.detail.expectedGanzhi, '壬午', '诊断要带干支 —— 定位得到「该是多少」');
  assert.equal(r.detail.claimedWuxing, '土');
  assert.equal(r.ruler, 'NAJIA', '必须说明尺子是哪一把 —— 换源后不说是「以为验过了」');
});

test('★ 自洽必须放行 (输出的一对字段, 64卦×6爻=384 组)', () => {
  // 这一版喂的是**输出层**的一对字段:
  //   爻名 = yao_ci[idx] 的前缀(爻辞表)   爻五行 = 爻位公理表
  // 两张表, 必须对得上 —— 这才是真实链路上的关系。
  // 第 36 批: 爻五行那张表换成了纳甲 ⇒ 尺子当时只有 96/384 爻位有,
  //   其余 288 个必须**明说验不了**(`unverifiable`), 而不是默默 ok ——
  //   「没验」混进 ok:true 里不出声, 这道守卫就会退化成没人看的代码。
  // 第 41 批: 八卦纳甲地支补齐(8/8, 四源交叉验证) ⇒ 尺子覆盖 **384/384**,
  //   验不了的爻位变成 0 个。
  //   ⚠️ 「没尺子」那条路**不能删** —— 它是这道守卫的兜底:
  //     万一哪天又有卦装不出纳甲, 「明说验不了」必须还在。
  //   所以下面用**临时表**造一个装不出的卦来验那条路, 而不是靠真实数据碰巧。
  let n = 0;
  let checked = 0;
  let unverifiable = 0;
  for (let gid = 1; gid <= 64; gid++) {
    const h = hexagrams.getHexagram(gid);
    for (let i = 0; i < 6; i++) {
      const ci = (h.yao_ci || [])[i] || '';
      const name = ci.split('：')[0];
      const gz = najia.getYaoGanzhi(gid, i + 1);
      if (!gz.ok) {
        // 尺子不存在 ⇒ 必须标 unverifiable, 且 ok 必须为 true(没尺子就不该判)
        const r0 = G.checkVectorConsistency({ guaId: gid, yaoName: name, yaoWuxing: '随便什么' });
        assert.equal(r0.ok, true, '没尺子却判了矛盾(误伤): ' + gid + '/' + i);
        assert.ok(r0.unverifiable,
          gid + ' idx' + i + ' 装不出纳甲, 却没标 unverifiable —— 「没验」被读成「验过了」');
        unverifiable++;
        n++;
        continue;
      }
      const r = G.checkVectorConsistency({ guaId: gid, yaoName: name, yaoWuxing: gz.wuxing });
      assert.equal(r.ok, true,
        '误伤: guaId=' + gid + ' idx=' + i + ' ' + name + '/' + gz.wuxing + ' ' + JSON.stringify(r.detail));
      assert.equal(r.unverifiable, undefined, '有尺子却标了 unverifiable');
      checked++;
      n++;
    }
  }
  assert.equal(n, 384, '应覆盖 64×6=384 组, 实为 ' + n);
  assert.equal(checked, 384, '第 41 批补齐八卦纳甲地支后, 有尺子的应是 384 个爻位, 实为 ' + checked);
  assert.equal(unverifiable, 0, '八卦纳甲已全, 不该再有验不了的爻位, 实为 ' + unverifiable);

  // 「没尺子」那条路仍然必须有效 —— 用**不存在的卦号**触发。
  //   为什么不能用真实卦来测: 第 41 批把八卦纳甲补齐后, 真实卦全都装得出,
  //   「没尺子」这条分支在真实数据上**永远不会走到** ——
  //   照着真实卦写的负例, 会在下一批真源补齐时**静默失效**(变成永远绿)。
  //   「旧测试可能在钉假口径 / 旧负例会静默失效」这两条坑, 这里一起避开。
  const noRuler = G.checkVectorConsistency({ guaId: 9999, yaoName: '六四', yaoWuxing: '随便什么' });
  assert.equal(noRuler.ok, true, '没尺子却判了矛盾(误伤)');
  assert.ok(noRuler.unverifiable, '没尺子却没标 unverifiable —— 「没验」被读成「验过了」');
  assert.equal(noRuler.unverifiable, 'NO_GUA');
});

test('★ 爻五行缺失要能报出来 (上爻越界时 vector 取空)', () => {
  // 默认不报(缺字段 = 没数据, 判了误伤); 显式要求时必须报。
  assert.equal(G.checkVectorConsistency({ guaId: 1, yaoName: '上九' }).ok, true,
    '默认不该判 —— 缺字段不是矛盾');
  const r = G.checkVectorConsistency({ guaId: 1, yaoName: '上九', yaoWuxing: '' }, { requireWuxing: true });
  assert.equal(r.ok, false, '要求必须有五行, 却放过空值');
  assert.equal(r.reason, 'YAO_WUXING_MISSING');
  assert.equal(r.detail.expectedGanzhi, '壬戌', '要能说出「本该是哪个干支」');
});

// ============================================================
// 三、误伤防线 (抓矛盾 ≠ 抓一切)
// ============================================================

test('★ 误伤防线: 认不出/缺字段/空数据 一律放过', () => {
  const cases = [
    { yaoName: '六四' },                              // 缺五行 → 缺字段不是矛盾
    { yaoWuxing: '土' },                               // 缺爻名 → 无从判
    { yaoName: '', yaoWuxing: '火' },
    { yaoName: '本卦为水火既济', yaoWuxing: '水' },      // 自由行文
    null,
    undefined,
  ];
  for (const c of cases) {
    const r = G.checkVectorConsistency(c);
    assert.equal(r.ok, true, '误伤了: ' + JSON.stringify(c));
  }
});

// ============================================================
// 四、活链路: 守卫必须**真的会咬人** (本批头号测试)
// ============================================================

test('★ 活链路必绿: 正常起卦, 爻名与爻五行必须自洽', () => {
  // 数字卦三数法: 上=n1%8 下=n2%8 动=n3%6 —— 与时间无关, 可复现
  for (const third of [1, 2, 3, 4, 5, 6]) {
    const r = castGua('测试起卦', { numbers: [7, 9, third] });
    assert.equal(r.yao_vector_check.ok, true,
      '正常起卦被判矛盾: ' + JSON.stringify({
        check: r.yao_vector_check,
        gua_id: r.gua_id,
        gua_name: r.gua_name,
        moving_yao: r.moving_yao,
        yao_name: r.yao_name,
        yao_wuxing: r.yao_wuxing,
        yao_ci_all: r.yao_ci_all,
        binary: r.binary,
      }));
    assert.equal(r.yao_vector_check.checked, true, '守卫压根没跑');
    // 输出层自证: 爻名解析出的下标 == 爻五行所属的下标。
    //   尺子用**纳甲地支**(异源), 手写期望值见文件头 —— 不从被测函数自己算。
    const idx = G.parseYaoNameIndex(r.yao_name);
    assert.ok(idx !== null, '输出的爻名认不出来: ' + r.yao_name);
    const gz = najia.getYaoGanzhi(r.gua_id, idx + 1);
    if (gz.ok) {
      assert.equal(r.yao_wuxing, gz.wuxing,
        '输出里爻名(' + r.yao_name + ')和爻五行(' + r.yao_wuxing + ')说的不是同一爻');
      assert.equal(r.yao_vector_check.ruler, 'NAJIA', '有尺子时必须用纳甲那一把');
      assert.equal(r.yao_vector_check.unverifiable, null);
    } else {
      // 「诚实的空」: 真源缺失, 空的, 但**要说出来**
      assert.equal(r.yao_wuxing, '', '装不出纳甲时五行应为空, 不许拿别的东西顶');
      assert.ok(r.yao_vector_check.unverifiable,
        '装不出纳甲就必须标 unverifiable —— 混进 ok:true 里就退化成空壳守卫');
    }
    // 爻位对齐守卫: 64/64 都成立, 不需要五行
    assert.equal(r.yao_index_check.ok, true, '爻位对齐守卫误伤了正常起卦');
    assert.equal(r.yao_index_check.checked, true, '爻位对齐守卫压根没跑');
    assert.equal(r.yao_index_check.detail.yaoIndex, idx,
      '向量取的爻位应与输出爻名一致');
  }
});

test('★★ 活链路必咬: 把动爻下标重新弄错(off-by-one), 守卫必须当场报矛盾', () => {
  // 在**活链路**上复现 a513130 之前的那个 bug: 0-based API 被传了 1-based 下标。
  //   这条测试是本批存在的理由 —— 第一版守卫喂的是 vector, 结构上永远自洽,
  //   在真实链路上**永远不会响**, 而当时的测试喂的也是 vector ⇒ 恒真。
  // 动爻=4 → 正确应取 idx3; 打补丁后取到 idx4 ⇒ 错位一爻。
  // 数字用 [8,9,10] ⇒ 泰(11, 乾下坤上), 装得出纳甲 ⇒ 五行那一半**有尺子**。
  //   泰外三爻纳坤: 癸丑(土)/癸亥(水)/癸酉(金) ⇒ 正确 idx3=土, 错位 idx4=水。
  const r = castGuaInChild('hv.getYaoVector = (gid, pos) => orig(gid, pos + 1);', [8, 9, 10]);
  assert.equal(r.moving_yao, 4, '前置条件不成立: 动爻应是 4');
  assert.equal(r.gua_id, 11, '前置条件不成立: 应起出泰卦(11)');
  assert.equal(r.check.ok, false,
    '守卫没咬 —— 它在真实链路上根本不会响, 等于没装');
  assert.equal(r.check.reason, 'YAO_NAME_WUXING_CONTRADICTION');
  assert.equal(r.check.detail.yaoNameIndex, 3);
  assert.equal(r.check.detail.expectedWuxing, TAI_ZHI_WUXING[3], '尺子应是泰四爻纳甲丑土');
  assert.equal(r.yao_wuxing, TAI_ZHI_WUXING[4], '错位后应拿到五爻的亥水');
});

test('★★ 活链路必咬: 上爻越界(取空 vector) 必须报缺失, 不能静默全空', () => {
  // 动爻=6(上爻, idx5) → 打补丁后取 idx6 越界 → vector 取空 → 五行静默全空
  // 数字用 [8,9,12] ⇒ 仍是泰(11), 上爻纳癸酉(金) ⇒ 五行那一半有尺子。
  const r = castGuaInChild('hv.getYaoVector = (gid, pos) => orig(gid, pos + 1);', [8, 9, 12]);
  assert.equal(r.moving_yao, 6, '前置条件不成立: 动爻应是 6(上爻)');
  assert.equal(r.gua_id, 11, '前置条件不成立: 应起出泰卦(11)');
  assert.equal(r.yao_wuxing, '', '前置条件不成立: 越界后五行应为空');
  assert.equal(r.check.ok, false, '五行静默全空, 守卫没报 —— 正是那个 bug 的表现');
  assert.equal(r.check.reason, 'YAO_WUXING_MISSING');
});

test('★★★ 爻位对齐守卫在 64/64 卦上都咬 (不靠五行那一半)', () => {
  // ★ 这条是第 36 批补 `checkYaoIndexAligned` 的**理由**, 且**至今仍然成立**:
  //   爻五行那一半的尺子(纳甲)当时只覆盖 96/384 爻位 —— 可 off-by-one 错的是
  //   **下标**, 跟五行无关: 在装不出纳甲的卦上, 五行那一半必然 `unverifiable`, 抓不住。
  //   爻位对齐守卫比的是两张不同表的爻名(爻辞表 vs 爻位公理表), 不需要五行 ⇒ 384/384。
  //
  // ⚠️ 第 41 批起, 这条测试**不再依赖「有卦装不出纳甲」这个缺口** ——
  //   八卦纳甲地支补齐后 64 个卦全都装得出, 拿缺口当前提的测试会**静默失效**。
  //   改成: ① 爻位对齐这一半在**任意卦**上都咬(用子进程注入错位);
  //        ② 爻位对齐这一半在 **64/64 卦**上都成立(全量实算, 不是抽样)。
  const r = castGuaInChild('hv.getYaoVector = (gid, pos) => orig(gid, pos + 1);', [7, 9, 4]);
  // 爻位对齐那一半: 必须咬(错位一爻必须被抓住)
  assert.equal(r.index_check.ok, false,
    '爻位对齐守卫没咬 —— 错位一爻就这么溜过去了');
  assert.equal(r.index_check.reason, 'YAO_INDEX_MISALIGNMENT');
  assert.equal(r.index_check.detail.vectorIndex - r.index_check.detail.outputIndex, 1);

  // ② 全量实算: 爻位对齐这一半在 64 卦 × 6 爻 = 384 组上都成立。
  //   (用**真实**的向量层取法, 不注入错位 —— 这是「不误伤」那一半)
  let n = 0;
  for (let gid = 1; gid <= 64; gid++) {
    const h = hexagrams.getHexagram(gid);
    for (let i = 0; i < 6; i++) {
      const name = ((h.yao_ci || [])[i] || '').split('：')[0];
      const v = hexagramVector.getYaoVector(gid, i);
      const rr = G.checkYaoIndexAligned({ guaId: gid, yaoName: name, vectorYaoName: v ? v.yaoName : null });
      assert.equal(rr.ok, true,
        '误伤: guaId=' + gid + ' idx=' + i + ' ' + name + ' vs ' + (v && v.yaoName)
        + ' ' + JSON.stringify(rr.detail));
      n++;
    }
  }
  assert.equal(n, 384, '应覆盖 64×6=384 组, 实为 ' + n);
});

// ============================================================
// 五、接线 (建了没接 = 白建)
// ============================================================

test('接线: gua_engine 起卦后必须调这道守卫', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'gua_engine.js'), 'utf8');
  assert.ok(src.includes('yao_vector_consistency'),
    'gua_engine 没接自洽守卫 —— 错位类 bug 照样静默');
  assert.ok(src.includes('YAO_VECTOR_CONTRADICTION'),
    '守卫没接日志 —— 矛盾了也没人看得见, 等于没接');
});

test('★ 接线: 守卫必须吃**输出的一对字段**, 不能吃 vector', () => {
  // 喂 vector = 喂一个结构上永远自洽的东西 = 守卫永远不响(实测踩到)。
  const src = fs.readFileSync(path.join(CORE, 'modules', 'gua_engine.js'), 'utf8');
  const call = src.slice(src.indexOf('checkVectorConsistency'));
  assert.match(call, /yaoName:\s*yaoNameOut/,
    '守卫没吃输出层的爻名 —— 又喂回 vector 了');
  assert.match(call, /yaoWuxing:\s*yaoWuxingOut/,
    '守卫没吃输出层的爻五行 —— 又喂回 vector 了');
});

test('★ 接线: 装时自检必须在**启动链**里, 且模块 load 期不许抛', () => {
  // load 期抛 ⇒ 谁 require 谁炸 ⇒ 调用方只能 try/catch ⇒ 自检被整个吞掉。
  const guardSrc = fs.readFileSync(path.join(CORE, 'modules', 'yao_vector_consistency.js'), 'utf8');
  assert.ok(!/^\s*_assertConsistencyGuard\(\);/m.test(guardSrc),
    '守卫在模块 load 期就抛 —— 调用方只能 try/catch 包着, 自检会被整个吞掉');
  const mainSrc = fs.readFileSync(path.join(CORE, 'pangu-single.js'), 'utf8');
  assert.ok(/assertYaoVectorConsistencyGuard\(\)/.test(mainSrc),
    '启动链没调装时自检 —— 守卫坏了没人知道, 等于没装');
});

test('接线: 守卫不许把起卦带崩 (抛错要降级成「本次未检查」)', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'gua_engine.js'), 'utf8');
  const seg = src.slice(src.indexOf('checkVectorConsistency'));
  assert.match(seg.slice(0, 600), /catch\s*\(/,
    '守卫调用没有 try/catch —— 守卫自己出错会把起卦带崩');
});

test('★ 故障注入必须进子进程 (顶层测试并发, 猴补丁会污染邻居)', () => {
  // `node --test` 同一文件里的顶层测试**并发**跑 —— 猴补丁会漏给隔壁测试。
  //   当时的现场: 「活链路必绿」莫名报「初九 配 木」, 极像真 bug,
  //   其实是隔壁那个 off-by-one 补丁的效果。差点当成生产 bug 去改。
  const src = fs.readFileSync(__filename, 'utf8');
  const inProcess = src.match(/^\s*(hv|hexagrams|yaoAxioms|G|castGua)\.\w+\s*=[^=]/m);
  assert.equal(inProcess, null,
    '本进程里改了共享模块: ' + (inProcess && inProcess[0]) + ' —— 顶层测试并发, 会污染邻居');
});

test('★ 接线: 5 个主卦工具的白名单不许把守卫判定吃掉', () => {
  // 这份数据里 `yao_name` 和 `liu_qin` 都来自那条**曾经会错位**的链 ——
  //   引擎一旦错位, 模型看到的是「爻名说六四、六亲却是九五的妻财」, 两半打架,
  //   而模型**没有理由怀疑**工具给的数。所以判定必须透到工具输出里。
 const { TOOLS } = require(path.join(CORE, 'modules', 'tools'));
  const normal = TOOLS._guaData({
    gua_name: '大畜', yao_name: '初九', liu_qin: '子孙',
    yao_vector_check: { ok: true, checked: true },
  });
  assert.equal('yao_vector_check' in normal, false,
    '正常时多出了字段 —— 输出形状一个字都不许变');
  const bad = TOOLS._guaData({
    gua_name: '大畜', yao_name: '初九', liu_qin: '子孙',
    yao_vector_check: { ok: false, reason: 'YAO_NAME_WUXING_CONTRADICTION' },
  });
  assert.equal('yao_vector_check' in bad, true,
    '矛盾判定被白名单吃掉了 —— 模型看不见, 等于没接');
  assert.equal(bad.yao_vector_check.reason, 'YAO_NAME_WUXING_CONTRADICTION');

  // 第 36 批: 爻位对齐判定也得透出去, 且**覆盖面更大** ——
  //   爻五行那一半要纳甲作尺子, 只有 96/384 爻位有; 爻位对齐 384/384 都有。
  const normal2 = TOOLS._guaData({
    gua_name: '大畜', yao_name: '初九', liu_qin: '子孙',
    yao_index_check: { ok: true, checked: true },
  });
  assert.equal('yao_index_check' in normal2, false, '正常时多出了字段');
  const bad2 = TOOLS._guaData({
    gua_name: '大畜', yao_name: '初九', liu_qin: '子孙',
    yao_index_check: { ok: false, reason: 'YAO_INDEX_MISALIGNMENT' },
  });
  assert.equal('yao_index_check' in bad2, true, '爻位错位判定被白名单吃掉了');
  assert.equal(bad2.yao_index_check.reason, 'YAO_INDEX_MISALIGNMENT');
});

// ============================================================
// 六、负例 (守卫不许是永真)
// ============================================================

test('★ 负例: 健康检查不是恒真的 —— 喂一份坏样本必须报出问题', () => {
  const bad = G.checkGuardHealth([{ name: '六四', index: 3 }, { name: '初九', index: 2 }]);
  assert.equal(bad.ok, false, '坏样本没报问题 —— 健康检查本身是恒真的');
  assert.ok(bad.problems.length >= 1, '报了但没给原因');
});

test('★ 负例: 装时自检在真源上必须**会抛**(否则守卫哑火还没人知道)', () => {
  // 真源健康 → 不抛; 且必须**自报尺子覆盖率** ——
  //   覆盖率从 najia.getCoverageStats() 取, **不手写**(手写过一次「4/64 卦」,
  //   跟实算的 96/384 对不上 —— 纳甲是按爻算的, 不是按整卦)。
  //   第 41 批补齐八卦纳甲地支后实算 384/384。
  //   不报的话, 三个月后没人知道五行那一半到底还剩多少能用。
  let r = null;
  assert.doesNotThrow(() => { r = G.assertYaoVectorConsistencyGuard(); });
  assert.equal(r.ruler_coverage, '384/384 爻位',
    '尺子覆盖率应从表算出来; 第 41 批补齐八卦纳甲地支后应是 384/384, 实为 ' + r.ruler_coverage);
  assert.ok(r.ruler_note.includes('384/384'), '要写明爻位对齐那一半是全覆盖的');
  // 再验一次: 自检用的样本确实来自真源, 不是手抄一份。
  const samples = G.buildGuardHealthSamples();
  assert.equal(samples.length, 12, '样本数不对(6 爻位 × 阴阳两套)');
  for (let i = 0; i < 6; i++) {
    const a = yaoAxioms.getYaoPositionAxiom(i);
    assert.ok(samples.some(s => s.name === a.yaoName_yin && s.index === i),
      '样本里没有真源爻名 ' + a.yaoName_yin + ' —— 手抄的表会与真源漂');
    assert.ok(samples.some(s => s.name === a.yaoName_yang && s.index === i),
      '样本里没有真源爻名 ' + a.yaoName_yang + ' —— 手抄的表会与真源漂');
  }
});

test('★ 负例: 守卫必须**会咬人**(造矛盾必须被拒)', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'yao_vector_consistency.js'), 'utf8');
  assert.match(src, /checkVectorConsistency\(fake\)/, '自检没造矛盾样本 —— 守卫可能是永真的');
  // 真造一次矛盾, 确认被拒
  // 乾卦六爻纳甲 = 子水 寅木 辰土 午火 申金 戌土(真源手写, 不从被测函数算)
  //   四爻(午)报「金」= 五爻(申)的五行 ⇒ 必须判矛盾
  const wrong = QIAN_ZHI_WUXING[4];
  const r = G.checkVectorConsistency({ guaId: 1, yaoName: '六四', yaoWuxing: wrong });
  assert.equal(r.ok, false, '造出的矛盾竟然通过了 —— 守卫是永真的');
});
