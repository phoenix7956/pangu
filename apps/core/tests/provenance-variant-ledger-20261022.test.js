/**
 * tests/provenance-variant-ledger-20261022.test.js
 * 第 44 批: 异文台账钉子 (出处层 P11)
 *
 * 起因: 第 43 批写文档时, 我在日总结和踩坑日志里写「14 条异文里 **12 条**是本地文件自己的错」。
 * 台账里其实写的是 `kind: 'local'` —— 一数是 **8 条**, 另 6 条是 `variant`(两本通行)。
 * **12 这个数是我转述台账时凭空变出来的**, 从没数过。
 *
 * 这不是笔误的小事: 「12/14 是本地错」和「8/14 是本地错」会导出**相反的结论** ——
 * 前者暗示本地文件整体不太可信, 后者说明本地基本没问题、只有几个录入错。
 * 据此决定「敢不敢继续用本地文件」, 结论是反的。
 *
 * 本批把这个数变成**算出来的**, 并让台账的每条 note 都回到文件里验一遍。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CORE = path.join(__dirname, '..');
const I64 = path.join(CORE, '64i');
const P = require(path.join(I64, 'provenance.js'));

// 工具(负例用的树复制/变异)在 tests/helpers/provenance_mutate.js —— 共用一份。
const { mutateProvenance } = require('./helpers/provenance_mutate');

function mutate(mutator) {
  return mutateProvenance(CORE, 'vl', mutator);
}

// ============================================================
// 一、正例
// ============================================================

test('正例: 台账每条都真的是异文 —— 内核爻辞在本地该卦段里找不到', () => {
  const r = P.checkVariantLedgerAgainstSource();
  assert.ok(r.ok, '异文台账核不过:\n' + r.problems.join('\n'));
  assert.equal(r.total, P.VARIANT_LEDGER.length);
  for (const row of r.rows) {
    assert.ok(row.reallyVariant,
      '卦' + row.gua + ' ' + row.name + ' 爻' + row.pos
      + ' 台账说是异文, 但本地段里能逐字找到内核爻辞');
  }
});

test('正例: kind 分布是算出来的 —— 8 条本地错 + 6 条两本通行 + 3 条异体写法', () => {
  const s = P.provenanceSummary();
  assert.ok(s.ok);
  // ⚠️ 这些数**不许手抄进文档** —— 要写就引用 provenanceSummary() 的输出。
  //
  // ⚠️ 2026-10-23 第 52 批: 异文从 14 变 17, 因为**随卦从"无源"变成"有源"**,
  //   它的 6 条爻辞第一次被比对, 其中 3 条是 係/系 异体写法 ⇒ 新增 kind 'ortho'。
  //   (病根在切片器: 原文缺 `第十七卦：《随卦》` 那行标题, 修好后才浮出来。)
  assert.equal(s.variantLedger, 17);
  assert.equal(s.variantLedgerLocal, 8, '本地文件自身录入错的数量');
  assert.equal(s.variantLedgerBoth, 6, '两本通行(谁也不能说谁错)的数量');
  assert.equal(s.variantLedgerOrtho, 3, '係/系 异体写法的数量(语义同, 不是错)');
  assert.equal(s.variantLedgerLocal + s.variantLedgerBoth + s.variantLedgerOrtho, s.variantLedger,
    '三种 kind 加起来必须等于总数 —— 少算一类就说明台账里有第四种 kind 没被统计');
});

test('正例: 每条 note 说的差异, 本地原文真能在文件里看到', () => {
  const r = P.checkVariantLedgerAgainstSource();
  // 台账 note 形如「本地文件作「噬干子」, 通行本「噬乾胏」」——
  // 那个 X 必须真的出现在本地文件里, 否则 note 就是一句没人验证过的漂亮话。
  for (const row of r.rows) {
    assert.ok(row.local && row.local.length > 0,
      '卦' + row.gua + ' ' + row.name + ' 爻' + row.pos + ' 在本地该卦段里定位不到爻题');
    const m = row.note.match(/本地文件作「([^」]+)」/);
    if (!m) continue;
    const claimed = m[1];
    assert.ok(row.local.replace(/[\s，。、；]/g, '').indexOf(claimed.replace(/[\s，。、；]/g, '')) >= 0,
      '卦' + row.gua + ' ' + row.name + ' 爻' + row.pos
      + ' 的 note 说本地作「' + claimed + '」, 但本地原文是「' + row.local.slice(0, 40) + '」');
  }
});

// ============================================================
// 二、负例
// ============================================================

test('负例(回归): 定位必须用该卦自己的段 —— 尺子取错会让 14 条全假报', () => {
  // 直接 body.indexOf('六二，') 找到的是全文件第一个「六二」= 乾卦的。
  // 于是每一卦都拿自己的爻辞去跟乾卦比 ⇒ 14 条全部报「本地不含内核爻辞」,
  // 看着像「本地文件错得离谱」, 其实是尺子坏了。
  // 这条测试确认真的按卦分段: 14 条里有大量「六二」「九三」这类重名爻题,
  // 只要定位靠错, 它们必然对不上。
  const r = P.checkVariantLedgerAgainstSource();
  const dupTitles = r.rows.filter((x) => ['六二', '九三', '上六', '六五'].includes(
    require(path.join(I64, 'hexagram_vector.js')).getYaoVector(x.gua, x.pos - 1).yaoName));
  assert.ok(dupTitles.length >= 4,
    '台账里重名爻题太少, 证明不了「按卦分段定位」这件事 —— 换个更有区分度的样本');
  assert.ok(r.ok, '按卦分段定位时, 台账应当全过');
});

test('负例: 台账塞一条其实不异文的进去 → P11 必须报红', () => {
  // 拿一条本来逐字一致的爻辞(乾初九)硬塞进台账:
  // 机器独立复核会发现「本地段里能逐字找到」⇒ 它根本不是异文 ⇒ 报红。
  const P2 = mutate((tmp) => {
    const f = path.join(tmp, 'provenance.js');
    const s = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, s.replace(
      "const VARIANT_LEDGER = Object.freeze([",
      "const VARIANT_LEDGER = Object.freeze([\n"
      + "  { gua: 1, name: '乾', pos: 1, kind: 'local', note: '假的, 乾初九本地与内核逐字一致' },"
    ), 'utf8');
  });
  const r = P2.checkVariantLedgerAgainstSource();
  assert.ok(!r.ok, '塞了一条不异文的还全绿 —— 台账成了许愿池');
  assert.ok(r.problems.some((p) => p.includes('说它是异文')),
    '没报「说它是异文」:\n' + r.problems.join('\n'));
  const all = P2.assertProvenance();
  assert.ok(!all.ok, '启动自检也必须跟着炸');
  assert.ok(all.problems.some((p) => p.includes('说它是异文')),
    '启动自检没带上异文台账的问题');
});

test('负例: 台账 note 说的本地读法跟文件里不一样 → 必须报红', () => {
  const P2 = mutate((tmp) => {
    const f = path.join(tmp, 'provenance.js');
    const s = fs.readFileSync(f, 'utf8');
    // 把「噬干子」改成一个文件里根本没有的读法 —— note 变成一句没人验证过的漂亮话
    fs.writeFileSync(f, s.replace(
      "note: '本地文件作「噬干子」, 通行本「噬乾胏」。'",
      "note: '本地文件作「根本没这三个字」, 通行本「噬乾胏」。'"
    ), 'utf8');
  });
  const r = P2.checkVariantLedgerAgainstSource();
  assert.ok(!r.ok, 'note 说的本地读法跟文件里不一样还全绿 —— note 是没被验过的漂亮话');
  assert.ok(r.problems.some((p) => p.includes('note 与文件对不上')),
    '没报「note 与文件对不上」:\n' + r.problems.join('\n'));
  const all = P2.assertProvenance();
  assert.ok(!all.ok, '启动自检也必须跟着炸');
});
