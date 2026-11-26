/**
 * tests/yao-ci-source-coverage-20261023.test.js
 * 第 51 批: 爻辞出处**覆盖数**对账 (出处层 P8 新程序 yaoCiSourceCoverage)
 *
 * 起因: 切片头 `64i/sources/zhougui_shangjing.txt` 长期写着
 *   「上经 30 卦(180 爻位)逐字可比, 下经 34 卦本地无原文(204 爻位无源)」
 *   —— 逐句都是错的, 而且**没有任何守卫会报红**:
 *     ① 「30 卦」: 随卦(卦17)在这份文件里没有, 有源的是上经 29 卦 + 咸卦 = 30 卦;
 *     ② 「180 逐字可比」: 180 是**有源**爻位数, 里面只有 166 逐字, 另 14 条是登记异文;
 *     ③ 「12 处录入/白话串字」: 实算 8 local + 6 variant = 14, 12 是拍的。
 *
 * 为什么 ② 能一直躺着: `yaoCiAgainstSource` 只负责把 384 爻位分三档,
 * 而且**异文集合已经 pin 到 VARIANT_LEDGER**(多一条少一条都报红)——
 * 异文台账把 14 条"顺带"盖住了, 于是"180 全部逐字可比"这句话没人反驳。
 *
 * 类别不一样: 这不是数据错, 是**声明错**。数据对了而声明说反了, 更坏 ——
 * 后来人正是拿这句声明判断「本地《周易》能不能信」。
 *
 * 本批把声明纳入对账: 三档相加必须 = 384, 异文条数 ≡ 台账,
 * 无源爻位 ≡ 无源卦 × 6, 且切片头 note 里写的 6 个数必须逐个对上实算。
 * 一个数都不许手写 —— 全从表算。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const I64 = path.join(CORE, '64i');
const P = require(path.join(I64, 'provenance.js'));

// 工具(负例用的树复制/变异)在 tests/helpers/provenance_mutate.js —— 共用一份。
const { copyTree, fingerprint, mutateProvenance } = require('./helpers/provenance_mutate');

// ============================================================
// 一、正例
// ============================================================

test('正例: 三档闭合成 384 —— 一条爻位都不许漏', () => {
  const r = P.checkYaoCiSourceCoverage();
  assert.ok(r.ok, '爻辞覆盖数对账不过:\n' + r.problems.join('\n'));
  const s = r.stats;
  assert.equal(s.totalYao, 384, '64 卦 × 6 爻');
  assert.equal(s.verbatim + s.variant + s.nosource, s.totalYao,
    '逐字 ' + s.verbatim + ' + 异文 ' + s.variant + ' + 无源 ' + s.nosource
    + ' 必须等于 384 —— 分类漏了爻位, 覆盖数全部不可信');
});

test('正例: 有源 ≠ 逐字 —— 这条钉住切片头那句假话的病根', () => {
  const s = P.checkYaoCiSourceCoverage().stats;
  assert.equal(s.sourcedYao, s.verbatim + s.variant,
    '有源爻位 = 逐字 + 异文');
  assert.notEqual(s.sourcedYao, s.verbatim,
    '有源爻位恰好等于逐字 ⇒ 异文一条都没算出来, 比对把异文漏成逐字了');
  assert.ok(s.sourcedYao > s.verbatim,
    '有源(' + s.sourcedYao + ') 必须大于逐字(' + s.verbatim + '), 差额就是登记异文');
});

test('正例: 无源爻位 ≡ 无源卦 × 6 —— 无源是逐爻位记的, 少记就是漏', () => {
  const s = P.checkYaoCiSourceCoverage().stats;
  // ⚠️ 2026-10-23 第 52 批: 34 → 33。随卦(17)原来被记成"本地无原文",
  //   实为原文缺 `第十七卦：《随卦》` 那行标题, 切片器切不出它。
  //   修好切片器后随卦 6 条爻辞全部有源 ⇒ 无源卦只剩下经 33 卦(卦32-64)。
  //   本清单现在**每一卦都是连爻辞都没有**, 性质统一了。
  assert.equal(P.NOSOURCE_GUA.length, 33, '无源卦清单长度');
  assert.equal(s.nosource, P.NOSOURCE_GUA.length * 6,
    '无源爻位 ' + s.nosource + ' 必须等于无源卦 ' + P.NOSOURCE_GUA.length + ' × 6');
});

test('正例: 异文条数 ≡ 异文台账 —— 覆盖数跟着台账一起动', () => {
  const s = P.checkYaoCiSourceCoverage().stats;
  assert.equal(s.variant, P.VARIANT_LEDGER.length,
    '异文实算 ' + s.variant + ' 条, 台账 ' + P.VARIANT_LEDGER.length + ' 条');
});

test('正例: 切片头声明的每个数字 ≡ 实算 —— 声明不是注释, 是要核的', () => {
  const r = P.checkYaoCiSourceCoverage();
  assert.ok(r.ok, r.problems.join('\n'));
  assert.ok(r.note.text, '切片头 note 读不到');
  const d = r.note.declared;
  for (const k of Object.keys(d)) {
    assert.ok(Number.isInteger(d[k]) && d[k] >= 0, k + ' 不是个整数: ' + d[k]);
  }
  assert.equal(r.note.mismatches, 0, '切片头声明与实算不一致');
  // ⚠️ 下面这些是**对照断言**, 真源是 r.stats —— 写出来只为让"实算变了"立刻看得见。
  assert.equal(d['逐字可核'], r.stats.verbatim);
  assert.equal(d['登记异文'], r.stats.variant);
  assert.equal(d['无源爻位'], r.stats.nosource);
});

test('正例: 切片头不再宣称「180 全部逐字可比」', () => {
  const r = P.checkYaoCiSourceCoverage();
  assert.ok(!/180\s*爻位[^,;。]*逐字可比/.test(r.note.text),
    '切片头还在说"180 逐字可比" —— 实算逐字只有 ' + r.stats.verbatim + ', 另 '
    + r.stats.variant + ' 条是登记异文');
});

test('正例: 整个出处守卫仍然全绿, 且新程序真的被调用了', () => {
  const r = P.assertProvenance();
  assert.ok(r.ok, 'assertProvenance 报红:\n' + (r.problems || []).join('\n'));
  assert.ok(r.stats.programs >= 3,
    '程序化比对只跑了 ' + r.stats.programs + ' 次 —— 新守卫没接进 ledger, 会成孤岛');
  // 2026-11-26: 开源导出树课程/消化件切片被剥, 对应 claim 在 provenance.js 里显式跳过
  //   (claimsChecked < claims 是预期行为)。私有树里切片齐全, claimsChecked 必须等于 claims。
  const fs = require('fs');
  const path = require('path');
  const isOpenSource = fs.existsSync(
    path.resolve(__dirname, '..', '64i', '.pangu-open-source'));
  if (!isOpenSource) {
    assert.ok(r.stats.claimsChecked === r.stats.claims,
      '引文核验 ' + r.stats.claimsChecked + '/' + r.stats.claims);
  }
});

// ============================================================
// 二、负例
// ============================================================

test('负例: 把切片头改回「180 逐字可比」→ 必须报红', () => {
  const Q = mutateProvenance(CORE, 'cov-note', (tmp) => {
    const f = path.join(tmp, 'sources', 'zhougui_shangjing.txt');
    const raw = fs.readFileSync(f, 'utf8');
    // 改声明里的"逐字可核"数字 —— 最容易发生的那种漂移:
    // 有人觉得"有源就是逐字", 顺手把 166 改成 180。
    //
    // ⚠️ 只改**数字**, 不改措辞 —— 措辞改了字段名也跟着消失, 触发的是
    //   「找不到声明」而不是「声明与实算不符」, 测的就不是同一件事了。
    //   真实的漂移长这样: 数字被改大, 措辞一个字没动。
    const next = raw.replace(/(\d+)(\s*逐字可核)/, '180$2');
    assert.notEqual(next, raw, '切片头里找不到「N 逐字可核」—— 负例锚点过期了');
    fs.writeFileSync(f, next);
  });
  const r = Q.checkYaoCiSourceCoverage();
  assert.equal(r.ok, false, '把声明改成假话, 守卫居然还绿');
  assert.ok(r.note.mismatches >= 1, '没有报出声明不一致');
  assert.ok(r.problems.some((p) => p.indexOf('切片头 note 说') >= 0),
    '报错没指向切片头声明:\n' + r.problems.join('\n'));
});

test('负例: 删一条异文台账 → 覆盖数对账必须报红', () => {
  const Q = mutateProvenance(CORE, 'cov-ledger', (tmp) => {
    const f = path.join(tmp, 'provenance.js');
    const raw = fs.readFileSync(f, 'utf8');
    const lines = raw.split('\n');
    const i = lines.findIndex((l) => l.indexOf("{ gua: 3, name: '屯', pos: 2,") >= 0);
    assert.ok(i >= 0, '找不到异文台账第一条 —— 负例锚点过期了');
    lines.splice(i, 1);
    fs.writeFileSync(f, lines.join('\n'));
  });
  const r = Q.checkYaoCiSourceCoverage();
  assert.equal(r.ok, false, '台账少了一条, 覆盖数守卫居然还绿');
  assert.ok(r.problems.some((p) => p.indexOf('异文实算') >= 0),
    '报错没指出异文条数对不上:\n' + r.problems.join('\n'));
});

test('负例: 从无源卦清单里删掉下经一卦(32 晋)→ 必须报红', () => {
  const Q = mutateProvenance(CORE, 'cov-nosrc', (tmp) => {
    const f = path.join(tmp, 'provenance.js');
    const raw = fs.readFileSync(f, 'utf8');
    // ⚠️ 2026-10-23 第 52 批改了锚点: 原来删的是随卦(17), 但随卦已被移出清单
    //   (切片器修好 ⇒ 它有源了)。改删下经第一卦 32。
    //   ⚠️ 这正是"负例锚点会过期"的活例子 —— 数据一变, 负例就悄悄失去意义,
    //   所以每条负例都该跟数据一起改, 而不是留着"反正一直是绿的"。
    const next = raw.replace('const NOSOURCE_GUA = Object.freeze([\n  32,',
      'const NOSOURCE_GUA = Object.freeze([\n  33,');
    assert.notEqual(next, raw, '找不到无源卦清单的开头 —— 负例锚点过期了');
    fs.writeFileSync(f, next);
  });
  const r = Q.checkYaoCiSourceCoverage();
  assert.equal(r.ok, false, '无源清单少了一卦, 守卫居然还绿');
  assert.ok(r.problems.some((p) => p.indexOf('无源卦集合') >= 0),
    '报错没指出无源卦集合不一致:\n' + r.problems.join('\n'));
});

test('对照组: 复制一棵树但**不改**任何东西 → 守卫仍然绿', () => {
  // 负例变红是"变异生效", 不是"临时树本身就是坏的"。
  // 没有这一条, 就算变异根本没生效、守卫因为别的原因报红, 负例也是假绿。
  //
  // ⚠️ 这里**不能**用 mutateProvenance: 它内建了「变异必须让树指纹变化」的断言,
  //   而对照组按定义就是不改 —— 会撞上那条断言, 报的还是"变异没生效",
  //   跟本用例要验的东西完全无关。所以直接用 copyTree 建树。
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pangu-prov-cov-ctl-'));
  const tmp = copyTree(path.join(CORE, '64i'), path.join(root, '64i'));
  try {
    fs.symlinkSync(path.join(CORE, 'modules'), path.join(root, 'modules'), 'dir');
  } catch (_) { /* 软链失败只影响 P12, 不影响本守卫 */ }
  const fp = fingerprint(tmp);
  const Q = require(path.join(tmp, 'provenance.js'));
  // 树必须真的没被动过(复制得干净), 否则"对照组"就不是对照组了。
  assert.equal(fingerprint(tmp), fp, '对照组建完树就被改了 —— 复制过程不干净');
  const r = Q.checkYaoCiSourceCoverage();
  assert.ok(r.ok, '对照组红了 —— 说明是临时树/复制过程本身有问题, 不是变异生效:\n'
    + r.problems.join('\n'));
  assert.deepEqual(r.stats, P.checkYaoCiSourceCoverage().stats,
    '对照组跟原树的覆盖数应当完全一致');
});

// ============================================================
// 三、反例: 拆掉守卫的某道断言, 正例必须**跟着红**
// ============================================================

// ⚠️ 为什么上面 7 条正例不够 —— 这是本文件自查出来的真问题(2026-10-23):
//   那 7 条全都只调 `checkYaoCiSourceCoverage()`, 而这个函数**本来就绿**。
//   把它的闭合检查 / 台账一致性 / 切片头对账**任意一道拆成 if(false)**,
//   上面 7 条照样全过 —— 它们测的是"当前数据符合预期", 不是"守卫在工作"。
//   ⇒ 恒真正例: 无论守卫死活都通过。
//   下面这几条反过来: **拆守卫 ⇒ 必须红**。守卫不工作就不许过。

function breakGuard(anchor, replacement) {
  return mutateProvenance(CORE, 'cov-break', (tmp) => {
    const f = path.join(tmp, 'provenance.js');
    const raw = fs.readFileSync(f, 'utf8');
    const next = raw.replace(anchor, replacement);
    assert.notEqual(next, raw, '守卫源码里找不到锚点 —— 反例过期了: ' + anchor);
    fs.writeFileSync(f, next);
  });
}

test('反例: 分类漏掉一卦的 6 个爻位 → 闭合检查必须报红', () => {
  // 这是"三档相加 ≡ 384"真正要防的事: **有爻位根本没被分类**。
  // 把某卦的 forEach 换成 for(空) ⇒ 那卦 6 个爻位一条都不进三档。
  // 只测"当前数据闭合"永远发现不了这种 —— 必须真的制造一次漏。
  const Q = mutateProvenance(CORE, 'cov-miss', (tmp) => {
    const f = path.join(tmp, 'provenance.js');
    const raw = fs.readFileSync(f, 'utf8');
    const next = raw.replace(
      '    (g.yao_ci || []).forEach((ci, i) => {',
      '    ([]).forEach((ci, i) => {');
    assert.notEqual(next, raw, '分类锚点过期了');
    fs.writeFileSync(f, next);
  });
  const r = Q.checkYaoCiSourceCoverage();
  assert.equal(r.ok, false, '三档少了 6 个爻位, 守卫居然还绿');
  assert.ok(r.problems
    .some((p) => p.indexOf('三档相加') >= 0),
    '分类漏掉一卦的 6 个爻位, 闭合检查竟然没报');
});

test('反例: 拆掉「异文条数 ≡ 台账」→ 台账与实算脱节必须报红', () => {
  // 台账加一条实算没有的异文 ⇒ 条数对不上。
  const Q = mutateProvenance(CORE, 'cov-ledger2', (tmp) => {
    const f = path.join(tmp, 'provenance.js');
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const i = lines.findIndex((l) => l.indexOf('const VARIANT_LEDGER = Object.freeze([') >= 0);
    assert.ok(i >= 0, '异文台账锚点过期了');
    lines.splice(i + 1, 0,
      "  { gua: 1, name: '乾', pos: 0, kind: 'variant', note: '凭空多出来的一条' },");
    fs.writeFileSync(f, lines.join('\n'));
  });
  assert.ok(Q.checkYaoCiSourceCoverage().problems
    .some((p) => p.indexOf('异文实算') >= 0),
    '台账凭空多一条, 覆盖数守卫竟然没报');
});

test('反例: 拆掉「切片头声明 ≡ 实算」→ 声明造假必须报红', () => {
  // 同一棵树里: 既把声明改成假话, 又拆掉对账 ⇒ 必须**抓不住**。
  // 再拿一棵只改声明、守卫完好的树 ⇒ 必须**抓住**。
  // 两相对照, 才证明"抓住它的正是这道对账"。
  const lie = (tmp) => {
    const f = path.join(tmp, 'sources', 'zhougui_shangjing.txt');
    const raw = fs.readFileSync(f, 'utf8');
    const next = raw.replace(/(\d+)(\s*逐字可核)/, '180$2');
    assert.notEqual(next, raw, '切片头锚点过期了');
    fs.writeFileSync(f, next);
  };
  const intact = mutateProvenance(CORE, 'cov-lie-intact', lie);
  const broken = mutateProvenance(CORE, 'cov-lie-brk', (tmp) => {
    lie(tmp);
    const f = path.join(tmp, 'provenance.js');
    const raw = fs.readFileSync(f, 'utf8');
    const next = raw.replace('    for (const w of want) {', '    for (const w of []) {');
    assert.notEqual(next, raw, '守卫对账锚点过期了');
    fs.writeFileSync(f, next);
  });
  assert.ok(intact.checkYaoCiSourceCoverage().note.mismatches >= 1,
    '守卫完好 + 声明造假, 竟然没报不一致');
  assert.equal(broken.checkYaoCiSourceCoverage().note.mismatches, 0,
    '拆掉对账后, 切片头写「180 逐字可核」仍然被报出来 —— 说明对账没被真正拆掉');
});
