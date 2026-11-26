'use strict';
// 六亲口径 (2026-10-22: 第 30 批落「我」侧 / 第 36 批换「他」侧)
//
// 三十批: 「我」侧从**卦五行(上卦口径)** 切到**京房宫五行** —— 两者在 32/64 卦上不一致,
//   且静态 `LIU_QIN[guaId]` 表 64 卦塌成 5 种形态、key 名与值对不上(坤卦 parents:'妻财'),
//   它经 kernel.divinate → li.js 落进模型上下文; `getLiuQin(999)` 还静默拿乾卦顶缸。
//
// 三十六批: 「他」侧从**爻位固定五行表**(初水二木三火四金五土上火) 切到
//         **该爻的纳甲地支五行**(真源)。撤掉那张表的三条理由, 每条都实算过:
//           ① 那张爻位表在 /Users/you/Desktop/course-source 全树**查无出处**;
//           ② 拿真纳甲当**异源尺子**量它, 六爻齐全的 4 卦共 24 个爻位**只对上 4 个**
//              (乾、泰的前两爻, 纯巧合), 坤卦 6 个爻位全错;
//           ③ 固定表使「他」侧不随卦变 ⇒ 同宫 8 卦六亲完全相同,
//              64 卦六亲塌成 5 种形态 —— 真京房六亲必然随卦变(各卦纳甲不同)。
//   ⇒ 切完之后, 对**装得出纳甲的爻位**, 这就是京房六亲(`is_jingfang: true`)。
//
// ⚠️ 这条测试现在钉的是**两半**, 缺一不可:
//   · 装得出纳甲的爻位 → 必须算出合法六亲(96/384)
//   · 装不出纳甲的爻位 → 必须 null + 原因(288/384), **一个都不许编**
// 「没给的地方模型自己编」是盘古反复出现的病根 —— 缺口的**形状**(null + 原因)
// 和**数量**都钉死, 哪天有人「顺手补上」立刻红。
//
// ⚠️ 覆盖率口径更正过一次(第 36 批内): 纳甲是**按爻**算的, 不是按整卦 ——
//   内三爻取下卦纳甲、外三爻取上卦纳甲, 所以半边是乾/坤的卦也有**一半**能装。
//   实算 **96/384 爻位**能装(分布在 28/64 卦上), 不是先前手写的「4/64 卦」。
//   缺口被夸大比缺口本身更危险 —— 会把有据可查的半边也记成「没有」。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CORE = path.join(__dirname, '..');
const LQ = require(path.join(CORE, '64i', 'bagua_annotations', 'liu_qin.js'));
const JF = require(path.join(CORE, '64i', 'bagua_annotations', 'jingfang_bagong.js'));
const WM = require(path.join(CORE, '64i', 'bagua_annotations', 'wuxing_map.js'));
const ANN = require(path.join(CORE, '64i', 'bagua_annotations', 'index.js'));
const YAOX = require(path.join(CORE, '64i', 'bagua_annotations', 'yao_axioms.js'));
const NAJIA = require(path.join(CORE, '64i', 'bagua_annotations', 'najia.js'));

const KEY_OF = { '父母': 'parents', '兄弟': 'siblings', '子孙': 'offspring', '妻财': 'wealth', '官鬼': 'official' };

/** 独立判一遍这个爻位装不装得出纳甲 —— 绕开六亲层, 免得尺子与被测对象同源 */
function _hasNajia(guaId, pos0) {
  return NAJIA.getYaoGanzhi(guaId, pos0 + 1).ok;
}

// ============================================================
// 一、「我」侧 = 京房宫五行, 64/64
// ============================================================

test('六亲的「我」侧是京房宫五行 (64/64)', () => {
  for (let id = 1; id <= 64; id++) {
    const jf = JF.getJingfang(id);
    assert.ok(jf, id + ' 应有京房归属');
    const arr = LQ.computeLiuQinForGua(id);
    assert.ok(arr, id + ' 应算出逐爻数组');
    for (const item of arr) {
      assert.equal(item.gongWuxing, jf.gong_wuxing,
        id + ' 的六亲「我」侧应是宫五行 ' + jf.gong_wuxing);
    }
  }
});

test('★ 装得出纳甲的爻位: 六亲必须有合法标签', () => {
  let ok = 0;
  let missing = 0;
  for (let id = 1; id <= 64; id++) {
    for (const item of LQ.computeLiuQinForGua(id)) {
      if (!_hasNajia(id, item.yaoPosition)) { missing++; continue; }
      ok++;
      assert.ok(LQ.LIU_QIN_LABELS.includes(item.liuQin),
        id + ' pos' + item.yaoPosition + ' 有纳甲真源, 六亲却=' + item.liuQin);
      assert.ok(item.yaoWuxing, id + ' pos' + item.yaoPosition + ' 有纳甲, 爻五行却空');
      assert.ok(item.ganzhi, id + ' pos' + item.yaoPosition + ' 有纳甲, 干支却空');
      assert.equal(item.reason, null);
    }
  }
  assert.equal(ok + missing, 384, '应逐爻扫完 384');
  // ⚠️ 期望值**从纳甲层实算**, 不手写。手写过的「96」曾经是真值, 也曾随着
  //   第 41 批八卦地支补齐而变假 —— 手写的数是负债(踩坑日志: 手写的数字是负债)。
  const NJ = require(path.join(CORE, '64i', 'bagua_annotations', 'najia.js'));
  const stats = NJ.getCoverageStats();
  assert.equal(ok, stats.yao_loadable,
    '装得出纳甲的爻位数应与纳甲层实算一致 = ' + stats.yao_loadable + '(实为 ' + ok + ')');
  assert.equal(missing, stats.yao_total - stats.yao_loadable);
});

test('★ 装不出纳甲的爻位: 六亲必须 null + 带原因 (一个都不许编)', () => {
  let n = 0;
  for (let id = 1; id <= 64; id++) {
    for (const item of LQ.computeLiuQinForGua(id)) {
      if (_hasNajia(id, item.yaoPosition)) continue;
      n++;
      assert.equal(item.liuQin, null,
        id + ' pos' + item.yaoPosition + ' 装不出纳甲, 却给出六亲「' + item.liuQin + '」—— 缺口伪装成结论');
      assert.equal(item.yaoWuxing, null, id + ' pos' + item.yaoPosition + ' 装不出纳甲, 却给出爻五行');
      assert.equal(item.ganzhi, null, id + ' pos' + item.yaoPosition + ' 装不出纳甲, 却给出干支');
      assert.ok(item.reason && item.reason.length > 5,
        id + ' pos' + item.yaoPosition + ' 缺口必须带原因 —— 光一个 null, 下一个人分不清是「缺」还是「坏」');
    }
  }
  // 第 41 批后真实数据已无缺口 ⇒ 这条断言现在是 0, 走不到真正的检查。
  //   「没给的地方不许编」这条性质不能因此没人验 —— 下一条用**注入缺口**把它验回来。
  const NJ = require(path.join(CORE, '64i', 'bagua_annotations', 'najia.js'));
  const stats = NJ.getCoverageStats();
  assert.equal(n, stats.yao_total - stats.yao_loadable);
});

test('★ 注入一个缺口: 六亲必须 null + 带原因 (不许编)', () => {
  // ⚠️ 上一条在真实数据上已经走不到(384/384 全装得出) —— 所以这条**自己造缺口**:
  //   注入一张空纳甲表, 看六亲层会不会老老实实说「不知道」。
  //   性质是「没给的地方不许编」, 判据该钉的是**性质**, 不是「恰好现在有几个缺口」。
  const NJ = require(path.join(CORE, '64i', 'bagua_annotations', 'najia.js'));
  const holed = { getYaoGanzhi: (id, pos) => NJ.getYaoGanzhiWithTable({}, id, pos) };
  let n = 0;
  for (let id = 1; id <= 64; id++) {
    for (let pos = 0; pos < 6; pos++) {
      n++;
      assert.equal(LQ.computeLiuQin(id, pos, { najia: holed }), null,
        id + ' pos' + pos + ' 装不出纳甲, 却给出六亲 —— 缺口伪装成结论');
    }
  }
  assert.equal(n, 384, '应逐爻扫完 384');
});

// ============================================================
// 二、口径变更的锚点: 上卦口径 ≠ 宫口径 的卦, 六亲跟着宫走
// ============================================================

test('口径变更锚点: 上卦口径 ≠ 宫口径 的卦, 六亲跟着宫走', () => {
  // 第 36 批: 只在**装得出纳甲的爻位**上验(有爻五行才谈得上比)。
  // 蒙、蹇这类**一个爻都装不出**的卦已不在锚点里 —— 它们的六亲现在是显式 null,
  // 拿它们当「六亲跟着宫走」的证据, 反而是在给一个已经不存在的行为作证。
  //   同理, 「宫五行」只在纳甲地支里**恰好出现**时才有兄弟爻可验(下金生水木土,
  //   宫金时半个纳甲都碰不到金)—— 所以锚点是从 16 个「上卦口径≠宫口径且有纳甲」
  //   的卦里, 挑**确实有兄弟爻**的那几个(实算共 10 个)。
  const ANCHORS = [
    { id: 6, name: '讼', gong: '离', gongWuxing: '火', upperWuxing: '金' },
    { id: 7, name: '师', gong: '坎', gongWuxing: '水', upperWuxing: '土' },
    { id: 5, name: '需', gong: '坤', gongWuxing: '土', upperWuxing: '水' },
    { id: 15, name: '谦', gong: '兑', gongWuxing: '金', upperWuxing: '土' },
    { id: 43, name: '夬', gong: '坤', gongWuxing: '土', upperWuxing: '金' },
  ];
  for (const a of ANCHORS) {
    const jf = JF.getJingfang(a.id);
    assert.equal(jf.gong, a.gong, a.name + ' 宫');
    assert.equal(jf.gong_wuxing, a.gongWuxing, a.name + ' 宫五行');
    assert.equal(WM.getWuxing(a.id).wuxing, a.upperWuxing, a.name + ' 上卦口径五行');
    assert.notEqual(a.gongWuxing, a.upperWuxing, a.name + ' 两个口径应当不同(否则这锚点没意义)');
    // 六亲必须按**宫五行**算: 兄弟 = 与「我」同五行者
    const arr = LQ.computeLiuQinForGua(a.id);
    const sameWuxingPos = arr.filter(x => x.yaoWuxing === a.gongWuxing);
    assert.ok(sameWuxingPos.length > 0, a.name + ' 应有装得出纳甲的爻位五行 == 宫五行');
    for (const s of sameWuxingPos) {
      assert.equal(s.liuQin, '兄弟', a.name + ' pos' + s.yaoPosition + ' 与宫同五行 → 兄弟');
    }
  }
});

test('上卦口径与宫口径一致的 32 卦, 六亲不变 (口径变更没有溢出)', () => {
  let same = 0;
  for (let id = 1; id <= 64; id++) {
    const upper = WM.getWuxing(id).wuxing;
    const gong = JF.getJingfang(id).gong_wuxing;
    if (upper === gong) same++;
  }
  assert.equal(same, 32, '两套口径应恰好在 32/64 卦上一致');
});

// ============================================================
// 三、静态表: 派生 + key 名与值一致 + 缺口逐爻列出 + 越界不兜底
// ============================================================

test('静态 LIU_QIN 表由动态计算派生, 缺口逐爻列出', () => {
  for (let id = 1; id <= 64; id++) {
    const row = ANN.LIU_QIN[id];
    assert.ok(row, id + ' 应有静态行');
    const arr = LQ.computeLiuQinForGua(id);
    for (const item of arr) {
      const key = KEY_OF[item.liuQin];
      // 装不出纳甲的爻位, 六亲是 null ⇒ KEY_OF[null] 是 undefined ⇒ 不许进静态表
      if (!key) continue;
      const hit = row[key].find(x => x.pos === item.yaoPosition + 1);
      assert.ok(hit, id + ' pos' + item.yaoPosition + ' 的六亲 ' + item.liuQin +
        ' 应出现在静态表的 ' + key + ' 里');
      assert.equal(hit.name, ['初爻', '二爻', '三爻', '四爻', '五爻', '上爻'][item.yaoPosition]);
    }
    // 反向: 静态表里不能有多余项(半满是常态, 但不多不少)
    const totalStatic = ['parents', 'siblings', 'offspring', 'wealth', 'official']
      .reduce((n, k) => n + row[k].length, 0);
    assert.equal(totalStatic, row.covered, id + ' 静态表项数应等于 covered');
    assert.equal(row.missing.length, 6 - row.covered, id + ' missing 应列出所有算不出的爻位');
    for (const m of row.missing) {
      assert.ok(m.reason && m.reason.length > 5, id + ' pos' + m.pos + ' 缺口必须有原因');
      assert.ok(m.pos >= 1 && m.pos <= 6);
    }
    assert.equal(row.available, row.covered > 0, id + ' available 应等价于 covered>0');
    if (row.covered === 0) {
      assert.equal(row.available, false);
      assert.ok(row.reason && row.reason.length > 5, id + ' 整卦装不出时必须有 reason');
    } else {
      assert.equal(row.reason, null, id + ' 只要有一爻能算, 就不该再挂「整卦装不出」的理由');
    }
  }
});

test('静态表的 key 名与它装的六亲**一致** (坤卦不许再 parents:妻财)', () => {
  const kun = ANN.LIU_QIN[2];
  assert.ok(kun.parents.every(x => x && x.pos >= 1), 'parents 里装的必须是爻位');
  for (const [label, key] of Object.entries(KEY_OF)) {
    const fromDynamic = LQ.computeLiuQinForGua(2)
      .map((x, i) => ({ x, i }))
      .filter(o => o.x.liuQin === label)
      .map(o => o.i + 1);
    assert.deepEqual(kun[key].map(o => o.pos).sort(), fromDynamic.sort(),
      '坤卦静态表 ' + key + ' 应只装「' + label + '」的爻位');
  }
});

test('getLiuQin 越界返回 null (不再静默拿乾卦那一行顶缸)', () => {
  assert.equal(ANN.getLiuQin(0), null);
  assert.equal(ANN.getLiuQin(65), null);
  assert.equal(ANN.getLiuQin(-1), null);
  assert.equal(ANN.getLiuQin(999), null);
  assert.equal(ANN.getLiuQin('1'), null);
  assert.equal(ANN.getLiuQin(null), null);
  assert.ok(ANN.getLiuQin(1), '合法 id 仍应有结果');
});

// ============================================================
// 四、口径可见: 模型得知道自己答的是哪一套
// ============================================================

test('口径常量: 两侧都写明, 且明说「算得出的就是京房六亲、算不出的不许编」', () => {
  const b = LQ.LIU_QIN_BASIS;
  assert.equal(b.is_jingfang, true, '第 36 批起两侧都是京房口径(宫五行 + 纳甲地支五行)');
  assert.ok(b.self_side.includes('宫五行'), '「我」侧应写明是京房宫五行');
  assert.ok(b.other_side.includes('纳甲'), '「他」侧应写明是纳甲地支五行');
  assert.ok(b.why_not && b.why_not.includes('查无出处'), '要写清为什么撤掉那张爻位固定五行表');
  assert.ok(b.note && b.note.length > 10, '要有给模型看的注意事项');
  assert.ok(b.note.includes('不许自己编'), '必须明写「算不出来就不许编」—— 那是盘古反复出的病');
  // 覆盖率从表算, 且必须自报实算值 —— 数字不许手写死
  //   ⚠️ 这里曾经写死 '96/384' —— 第 41 批补齐八卦地支后真值变成 '384/384',
  //   写死的断言就变成了「必须停在旧口径」。改成跟表算的对账。
  const stats = require(path.join(CORE, '64i', 'bagua_annotations', 'najia.js')).getCoverageStats();
  assert.equal(b.coverage_yao, stats.yao_loadable + '/' + stats.yao_total,
    '覆盖率应从 najia 表算出来, 不是手写的');
  assert.ok(b.coverage.includes(stats.yao_loadable + '/' + stats.yao_total),
    'coverage 文案里要能看到爻位数');
});

test('起卦输出带逐爻六亲 + 口径注', () => {
  const engine = require(path.join(CORE, 'modules', 'gua_engine.js'));
  const gua = engine.castGua('六亲口径自检', { numbers: [1, 2, 3] });
  assert.ok(Array.isArray(gua.liu_qin_all), '应有逐爻六亲');
  assert.equal(gua.liu_qin_all.length, 6);
  for (const x of gua.liu_qin_all) {
    // 有纳甲的爻位必须有合法六亲; 没有的必须 null + 原因 —— 两种都得自洽
    if (x.najia_ganzhi) {
      assert.ok(LQ.LIU_QIN_LABELS.includes(x.liu_qin),
        'pos' + x.pos + ' 有纳甲(' + x.najia_ganzhi + ')却六亲=' + x.liu_qin);
    } else {
      assert.equal(x.liu_qin, null, 'pos' + x.pos + ' 没纳甲却给出六亲');
      assert.ok(x.reason && x.reason.length > 5, 'pos' + x.pos + ' 缺口要带原因');
    }
    assert.ok(x.pos >= 1 && x.pos <= 6);
  }
  assert.ok(gua.liu_qin_note && gua.liu_qin_note.includes('不许自己编'),
    '口径注必须明说算不出来不许编');
  assert.ok(gua.liu_qin_basis && gua.liu_qin_basis.is_jingfang === true,
    '口径要跟着数据一起出参');
});

test('查卦工具输出带逐爻六亲 + 口径注', async () => {
  const { TOOLS } = require(path.join(CORE, 'modules', 'tools'));
  const r = await TOOLS.hexagram_lookup({ context: {}, params: { query: '蒙' } });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.data.liu_qin_all), '应有逐爻六亲');
  assert.equal(r.data.liu_qin_all.length, 6);
  assert.ok(r.data.liu_qin_note, '应带口径注');
  assert.ok(r.data.liu_qin_basis && r.data.liu_qin_basis.is_jingfang === true);
});

test('注解层 getAnnotations 带逐爻六亲 + 口径', () => {
  const a = ANN.getAnnotations(4);
  assert.ok(Array.isArray(a.liuqin_yao) && a.liuqin_yao.length === 6);
  assert.ok(a.liuqin_basis, '应带口径');
  assert.equal(a.liuqin_basis.is_jingfang, true);
});

// ============================================================
// 五、爻层边界 + 异源手推
// ============================================================

test('爻层边界仍然守住 (爻层零五行/纳甲)', () => {
  const G = require(path.join(CORE, 'modules', 'yao_layer_boundary.js'));
  const r = G.checkYaoLayerBoundary();
  assert.equal(r.ok, true, (r.violations || []).join('\n'));
});

test('★ 爻位公理层不再带五行 (第 36 批已撤那张查无出处的表)', () => {
  for (let pos = 0; pos < 6; pos++) {
    const ax = YAOX.getYaoPositionAxiom(pos);
    assert.ok(ax, '爻位 ' + pos + ' 应有公理');
    assert.equal('wuxing' in ax, false,
      '爻位 ' + pos + ' 又长出了 wuxing —— 假表一回来, 就有了第二个五行来源');
  }
  assert.equal(typeof YAOX.getYaoPositionsByWuxing, 'undefined',
    '按五行反查爻位的接口应随之撤掉(爻位没有五行, 查什么)');
});

test('★ 手工推一遍乾卦六亲: 异源尺子, 不从被测函数自己算', () => {
  // 乾宫属金; 乾纳甲 = 内甲(子寅辰) + 外壬(午申戌)
  //   子水=我生⇒子孙  寅木=我克⇒妻财  辰土=生我⇒父母
  //   午火=克我⇒官鬼  申金=同我⇒兄弟  戌土=生我⇒父母
  // 那五条规则出自老板 2026-10-21 原话(生我者父母/同我者兄弟/我生者子孙/
  // 我克者妻财/克我者官鬼), 不是从本仓代码反推的 —— 所以这是一把异源的尺子。
  const WANT_ZHI = ['子', '寅', '辰', '午', '申', '戌'];
  const WANT = ['子孙', '妻财', '父母', '官鬼', '兄弟', '父母'];
  for (let pos = 0; pos < 6; pos++) {
    const gz = NAJIA.getYaoGanzhi(1, pos + 1);
    assert.equal(gz.dianzhi, WANT_ZHI[pos], '乾卦第' + (pos + 1) + '爻地支');
    assert.equal(LQ.computeLiuQin(1, pos), WANT[pos], '乾卦第' + (pos + 1) + '爻六亲');
  }
});
