/**
 * tests/numbering-basis-20261023.test.js
 * 第 53 批: 编号体系登记表 (「派生 还是 独立」)
 *
 * 起因: 老板一句提问, 顶掉了我一整段说法。
 *
 *   我此前说盘古有「爻位序 / 二进制序 / 后天序」**三套序并存**, 并警告
 *   「三套在 1..7 上完全重叠, 传错基数不报错, 只会静悄悄返回另一个卦」。
 *
 *   老板给了他的表:
 *     乾=111=7  兑=110=6  离=101=5  震=100=4  巽=011=3  坎=010=2  艮=001=1  坤=000=0
 *   问: 「你这么考虑是不是就不存在你所谓的三套顺序的问题了?」
 *
 *   实测 8/8 全中盘古实表 —— **他说得对, 我错了。**
 *   错在: 我把**派生函数**数成了**并列的另一套**。
 *   真正能判「是不是独立」的不是数法, 是一条判据:
 *       **能不能写成对方的函数。** 能 ⇒ 派生, 不算独立。
 *
 * 本批把这句话落地成机制:
 *   - `modules/yao_layer_boundary.js` 新增 `NUMBERING_BASIS` 表(唯一真源)
 *     + `checkNumberingBasis()`(每条派生关系当场算一遍)
 *     + `checkNumberingBasisDoc()`(头注释那张表 ↔ 数据对账)
 *   - 分类结果: 2 原子 / 3 派生 / 2 独立。
 *     **只有真正独立的两套(后天序 / 文王序)才配得上「换序会静悄悄返回另一个卦」。**
 *
 * ⚠️ 本文件遵守「反例必须能拆守卫」的纪律(第 51 批自查建立):
 *   光有正例的话, 把 verify 全删掉测试照样全绿 —— 恒真。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const G = require(path.join(CORE, 'modules', 'yao_layer_boundary.js'));
const yin = require(path.join(CORE, '64i', 'yin_yang.js'));
const AX = require(path.join(CORE, '64i', 'bagua_annotations', 'bagua_axioms.js'));
const POS = require(path.join(CORE, '64i', 'bagua_annotations', 'bagua_positions.js'));
const HX = require(path.join(CORE, '64i', 'hexagrams.js'));
const LIST = HX.HEXAGRAMS || HX;

const MODS = {
  YAO_VALUES: yin.YAO_VALUES,
  yaoToBinary: yin.yaoToBinary,
  getMovement: yin.getMovement,
  BAGUA_AXIOMS: AX.BAGUA_AXIOMS,
  HOU_TIAN_SEQ: POS.HOU_TIAN_SEQ,
  HEXAGRAMS: LIST,
};

// ============================================================
// 一、正例
// ============================================================

test('正例: 编号体系全部自报家门, 且派生关系当场算得通', () => {
  const r = G.checkNumberingBasis();
  assert.ok(r.ok, '编号体系对账不过:\n' + r.violations.join('\n'));
  // 每个有 verify 的都**真的跑过** —— 不能碰巧没报错
  const ran = r.results.map((x) => x.key).sort();
  const expected = G.NUMBERING_BASIS
    .filter((x) => typeof x.verify === 'function')
    .map((x) => x.key).sort();
  assert.deepEqual(ran, expected, '每套有 verify 的编号都必须真的跑过');
  for (const x of r.results) {
    assert.deepEqual(x.problems, [], x.key + ' 的 verify 报了问题');
  }
});

test('正例: 分类是 2 原子 / 3 派生 / 2 独立(老板那个判据的落点)', () => {
  const by = (k) => G.NUMBERING_BASIS.filter((x) => x.kind === k).map((x) => x.key).sort();
  assert.deepEqual(by('atom'), ['yaoPosition', 'yaoYinYang'], '原子 = 爻画/爻位');
  assert.deepEqual(by('derived'), ['baguaXianTian', 'guaIndex', 'yaoValue'], '派生 = 爻值/先天数/index');
  assert.deepEqual(by('independent'), ['baguaHouTian', 'guaId'], '独立 = 后天序/文王序');
});

test('正例: 爻值 6/7/8/9 = 爻画阴阳 × 动静 **两维**(老板「爻动阴阳那就太过了」)', () => {
  const cells = new Set();
  for (const v of Object.values(yin.YAO_VALUES)) {
    cells.add(yin.yaoToBinary(v) + '/' + yin.getMovement(v));
  }
  assert.equal(cells.size, 4,
    '爻值的阴阳×动静必须铺满 2×2(实际 ' + cells.size + ' 格) —— 少一格就是把两维混成一维了');
  const yv = G.NUMBERING_BASIS.find((x) => x.key === 'yaoValue');
  assert.deepEqual(yv.verify(MODS), []);
});

test('正例: 八卦先天数 ≡ 8−bits, 且按 bits 升序严格递减', () => {
  const x = G.NUMBERING_BASIS.find((r) => r.key === 'baguaXianTian');
  assert.deepEqual(x.verify(MODS), [], '先天数与 bits 的关系必须实算成立');
  const byValue = AX.BAGUA_AXIOMS.slice()
    .sort((a, b) => parseInt(a.bits, 2) - parseInt(b.bits, 2))
    .map((a) => a.trigramIndex);
  assert.equal(byValue.join(','), '8,7,6,5,4,3,2,1', '按 bits 升序, 先天数应严格递减');
});

test('正例: 后天序在 bits 上**非单调** —— 这就是「独立」的实证', () => {
  // 「独立」不能只写「因为它是洛书方位」, 得证明写不成函数。
  const byName = {};
  for (const a of AX.BAGUA_AXIOMS) byName[a.name] = a.bits;
  const v = POS.HOU_TIAN_SEQ.map((s) => parseInt(byName[s.name], 2));
  const monotone = v.every((x, i) => i === 0 || x > v[i - 1]);
  assert.equal(monotone, false,
    '后天数在 bits 上竟单调(' + v.join(',') + ') ⇒ 它本写得出函数, 不该标独立');
  assert.equal(new Set(v).size, 8, '后天序对应的 bits 值必须是 8 个互异值');
});

test('正例: 卦 index ≡ 上卦×8+下卦, 64/64', () => {
  const v = (s) => parseInt(s.join(''), 2);
  let ok = 0;
  for (const g of LIST) {
    const b = g.binary.split('');
    if (v(b.slice(3, 6)) * 8 + v(b.slice(0, 3)) === g.index) ok++;
  }
  assert.equal(ok, 64, 'index 与 binary 的关系必须 64/64 成立');
  const x = G.NUMBERING_BASIS.find((r) => r.key === 'guaIndex');
  assert.deepEqual(x.verify(MODS), []);
});

test('正例: 文王序(id)与 index 排序**不一致** ⇒ 它真是独立的', () => {
  const byIndex = LIST.slice().sort((a, b) => a.index - b.index);
  assert.equal(byIndex.every((g, i) => g.id === i + 1), false,
    '文王序若就等于 index 排序, 它就是派生的, 表里标「独立」是错的');
  // 老板 10-22 点的那个坑: id(1..64) 与 index(0..63) 长得极像, 都叫「第几卦」
  assert.equal(Math.min(...LIST.map((g) => g.id)), 1, 'id 是 1 基');
  assert.equal(Math.min(...LIST.map((g) => g.index)), 0, 'index 是 0 基');
});

test('正例: 头注释的编号表 ↔ NUMBERING_BASIS 数据一致', () => {
  const r = G.checkNumberingBasisDoc();
  assert.ok(r.ok, '注释与数据对不上:\n' + r.violations.join('\n'));
  assert.equal(r.rows.length, G.NUMBERING_BASIS.length, '注释表和数据行数必须一致');
});

test('正例: 渲染函数渲染出的表 == 头注释里的表', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'yao_layer_boundary.js'), 'utf8');
  for (const line of G.renderNumberingBasisRows()) {
    const label = line.split('|')[1].trim();
    assert.ok(src.includes(label), '渲染出的「' + label + '」在头注释里找不到');
  }
});

test('正例: 层表守卫仍然全绿(加编号表没把老的判据弄坏)', () => {
  const all = G.checkYaoLayerBoundary();
  assert.ok(all.ok, all.violations.join('\n'));
  assert.equal(all.report.layerBoundaryDoc.rows, 3, '层表仍是 3 行');
  assert.equal(all.report.numberingBasisDoc.rows, 7, '编号表是 7 行');
  assert.ok(all.report.numberingBasis.ok, '编号派生判据没接进总守卫');
});

// ============================================================
// 二、反例 —— 证明这套守卫会咬人, 不是恒真
// ============================================================

test('反例: derived 项不写 verify ⇒ 必须报红(防空头声明)', () => {
  const basis = G.NUMBERING_BASIS.map((x) =>
    (x.kind === 'derived' ? { ...x, verify: undefined } : x));
  const r = G.checkNumberingBasis({ basis });
  assert.equal(r.ok, false, 'derived 不验也算过 —— 那就回到了「没人核过的漂亮话」');
  assert.ok(r.violations.some((v) => v.indexOf('没有 verify') >= 0),
    '报错没指出「缺 verify」:\n' + r.violations.join('\n'));
});

test('反例: independent 项不写理由 ⇒ 必须报红', () => {
  const basis = G.NUMBERING_BASIS.map((x) =>
    (x.kind === 'independent' ? { ...x, why: '' } : x));
  const r = G.checkNumberingBasis({ basis });
  assert.equal(r.ok, false, 'independent 没理由也算过');
  assert.ok(r.violations.some((v) => v.indexOf('independent 却没写理由') >= 0));
});

test('反例: derived 指向不存在的源头 ⇒ 必须报红', () => {
  const basis = G.NUMBERING_BASIS.map((x) =>
    (x.key === 'guaIndex' ? { ...x, derivesFrom: ['不存在的层'] } : x));
  const r = G.checkNumberingBasis({ basis });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.indexOf('表里没有这一项') >= 0));
});

test('反例: 把「后天序」谎报成单调(独立却写得出函数)⇒ 必须报红', () => {
  // 「独立」这个标签必须**可证伪**: 万一它其实有公式, 表就错了。
  const fake = {
    ...MODS,
    // 谎称后天序单调: 按 bits 升序给 1..8
    HOU_TIAN_SEQ: AX.BAGUA_AXIOMS.slice()
      .sort((a, b) => parseInt(a.bits, 2) - parseInt(b.bits, 2))
      .map((a, i) => ({ name: a.name, position: i + 1 })),
  };
  const x = G.NUMBERING_BASIS.find((r) => r.key === 'baguaHouTian');
  const problems = x.verify(fake);
  assert.ok(problems.length > 0,
    '谎称后天序单调, verify 竟然没报 —— 这道「独立可证伪」的判据是恒真的');
});

test('反例: 把「先天数」改成等于 bits 的值 ⇒ verify 必须报红', () => {
  // 这正是老板那个提问指向的错误: 有人把「先天数」当成 bits 的独立读法。
  //
  // ⚠️ 这里踩过一次, 记下来: 第一版写的是
  //     trigramIndex: parseInt(a.bits, 2)
  // 想着"把先天数换成 bits 的值"。结果对震来说 parseInt('100',2)=4,
  // **恰好等于正确值 8−4=4** —— 反例造了个不存在的错误, verify 正确地没报,
  // 而我却以为"守卫坏了"。
  // 教训: **反例本身也要验** —— 造完先确认它真造出了一个错,
  //   否则你会开始怀疑那个正确的守卫。
  // ⇒ 用真错值: 震 bits='100' 正确先天数是 4, 这里改成 5。
  const brokenAxioms = AX.BAGUA_AXIOMS.map((a) =>
    (a.name === '震' ? { ...a, trigramIndex: 5 } : a));
  const x = G.NUMBERING_BASIS.find((r) => r.key === 'baguaXianTian');
  // 先自证: 确实造出了一个错(「反例要验反例」)
  const real = AX.BAGUA_AXIOMS.find((a) => a.name === '震');
  assert.equal(real.trigramIndex, 8 - parseInt(real.bits, 2), '前提: 震在表里本来是对的');
  const bad = brokenAxioms.find((a) => a.name === '震');
  assert.notEqual(bad.trigramIndex, 8 - parseInt(bad.bits, 2),
    '反例没造出错 —— 这个"反例"是假的, 它永远通不过, 不是守卫的错');
  const problems = x.verify({ ...MODS, BAGUA_AXIOMS: brokenAxioms });
  assert.ok(problems.length > 0, '震的 trigramIndex 改成 5, verify 竟然没报');
  assert.ok(problems.some((p) => p.indexOf('震') >= 0), '报错没指向震:\n' + problems.join('\n'));
});

test('反例: 头注释编号表被改坏一格 ⇒ 文档对账必须报红', () => {
  const p = path.join(CORE, 'modules', 'yao_layer_boundary.js');
  const src = fs.readFileSync(p, 'utf8');
  const broken = src.replace(
    '| 八卦 · baguaHouTian | 坎1 坤2 震3 巽4 乾5 兑6 艮7 离8  | 独立于 yaoYinYang |',
    '| 八卦 · baguaHouTian | 坎1 坤2 震3 巽4 乾5 兑6 艮7 离8  | 派生自 yaoYinYang |');
  assert.notEqual(broken, src, '没找到编号表里那一行 —— 负例锚点过期了');
  const r = G.checkNumberingBasisDoc({ src: broken });
  assert.equal(r.ok, false,
    '注释说后天序是派生的, 对账竟然没报 —— 文档判据是恒真的');
  assert.ok(r.violations.some((v) => v.indexOf('baguaHouTian') >= 0));
});

test('反例: 两张表共用解析器不许互相吞行', () => {
  // 头注释里现在有层表 + 编号表两张三列表。共用一个解析器时,
  // 第一张会把第二张也吞进去(第 53 批当场踩过: 层表检查报「多出 7 层」)。
 const src = fs.readFileSync(path.join(CORE, 'modules', 'yao_layer_boundary.js'), 'utf8');
  assert.equal(G.checkLayerBoundaryDoc({ src }).rows.length, 3, '层表被编号表串行了(应 3 行)');
  assert.equal(G.checkNumberingBasisDoc({ src }).rows.length, 7, '编号表被层表串行了(应 7 行)');
});
