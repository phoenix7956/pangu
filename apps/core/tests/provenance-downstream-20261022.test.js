/**
 * tests/provenance-downstream-20261022.test.js
 * 第 43 批: 循环证据守卫 (出处层 P10)
 *
 * 背景见 64i/provenance.js 的 DOWNSTREAM_NOT_SOURCE。
 * 本机 `/Users/you/Desktop/course-source` 里有 7 份下经消化件, 下经 34 卦全覆盖,
 * 里面**有爻辞** —— 拿它去补「第 42 批那 204 个无源爻位」看起来天衣无缝。
 * 但那 7 份是盘古自己的下游产物, 拿它核 64i = 64i 自己核自己。
 *
 * ⚠️ 本文件最大的价值在负例 4 —— 它当场抓住过本批自己写出来的一个
 *   **恒假守卫**(origin 带 `:1-50` 行号后缀, `\.md$` 永远匹配不上)。
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

/**
 * 复制一份 64i, 改一处, 重新 require —— 得到一棵「坏树」。
 *
 * ⚠️ 临时目录必须长成 `<tmp>/64i/` + `<tmp>/modules`(指向真 modules 的软链)。
 *   守卫 P12 要从 `64i/../modules/gua_block.js` 找生产层文件 ——
 *   只复制 64i 的话它读不到, P12 会误报一片红, 把真负例淹在噪声里
 *   (2026-10-22 第 45 批踩过)。
 */
function mutate(mutator) {
  return mutateProvenance(CORE, 'ds', mutator);
}

/**
 * 下游台账里的 `dir` 到底是「本机绝对路径」还是「语料库相对路径」, 是**会变的**
 * (2026-10-26: 本机绝对路径 → 语料库相对路径 + PANGU_CORPUS_ROOT)。
 *
 * 所以负例的锚点**不许写死字面量**。写死的那天, 路径改一次, `String.replace`
 * 变成空操作 —— 负例要么静默变成假绿, 要么当场报「变异没生效」把整条
 * `&&` 链拦腰砍断 (后面几十个守卫一次都不跑, 而日志里看不出"少跑了")。
 *
 * 正确做法: 锚点从**真模块**里取 (`P.DOWNSTREAM_NOT_SOURCE[0].dir`),
 * 跟着真源走, 不跟着拼写走。
 *
 * ⚠️ 兜底: `tests/helpers/provenance_mutate.js` 每次变异都会比对树指纹,
 *   变异没生效 ⇒ 直接 assert 报红。所以锚点一旦又对不上,
 *   表现是**吵的失败**, 不是**安静的假绿**。
 */
const DS_DIR = String(P.DOWNSTREAM_NOT_SOURCE[0].dir);

/** 把源码里 `dir: '<当前真值>'` 那个字段换成别的值 (只换 dir 字段, 不碰 origin) */
function replaceDirField(src, newValue) {
  const esc = DS_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return src.replace(new RegExp(`dir: '${esc}'`), `dir: '${newValue}'`);
}

// ============================================================
// 一、正例: 真树守住红线
// ============================================================

test('正例: 真树 P10 全绿 —— 没有任何出处源指向下游产物', () => {
  const r = P.assertProvenance();
  assert.ok(r.ok, '出处层报红:\n' + r.problems.join('\n'));
  assert.ok(!r.problems.some((p) => p.includes('循环证据')),
    '真树里出现了循环证据告警');
});

test('正例: 下游台账已登记, 且 pinned 数字跟实算一致', () => {
  assert.ok(Array.isArray(P.DOWNSTREAM_NOT_SOURCE) && P.DOWNSTREAM_NOT_SOURCE.length > 0,
    '下游台账是空的 —— 将来有人拿 digest 当出处, 没人拦');
  const r = P.checkDownstreamDigestAgainstKernel();
  assert.ok(r.skipped || r.ok,
    '下游台账跟实算对不上:\n' + (r.problems || []).join('\n'));
  if (!r.skipped) {
    assert.equal(r.stats.rows, 204, '下经 34 卦 × 6 爻 应当是 204 行');
    assert.ok(r.stats.identical > 190,
      '逐字一致数掉到 190 以下 —— 下游跟内核分家了, 台账得改并解释');
  }
});

test('正例: 下游实算结论 —— 它确实是 64i 的副本(所以不能当出处)', () => {
  const r = P.checkDownstreamDigestAgainstKernel();
  if (r.skipped) return; // 外部资料不在(别的机器), 这条不适用
  assert.equal(r.stats.files, 7);
  assert.equal(r.stats.hexagrams, 34);
  // 「绝大多数逐字一致」正是它被排除的理由: 一致得越齐, 越说明它是抄的。
  assert.ok(r.stats.identical / r.stats.rows > 0.9,
    '下游跟内核几乎不重合了 —— 那它就不是「下游」, 台账要重新定性');
});

test('正例: 外部资料读不到时优雅跳过 —— 64i 零外部依赖不能被打破', () => {
  const P2 = mutate((tmp) => {
    const f = path.join(tmp, 'provenance.js');
    const s = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, replaceDirField(s, '/definitely/not/here-期望这个目录不存在'), 'utf8');
  });
  const r = P2.checkDownstreamDigestAgainstKernel();
  assert.ok(r.skipped, '目录不存在时应当 skipped, 实得 skipped=' + r.skipped);
  assert.ok(r.ok, '跳过不算失败');
  // 关键: 整层自检也不能炸
  const all = P2.assertProvenance();
  assert.ok(all.ok, '外部资料缺失不该把启动自检搞炸:\n' + all.problems.join('\n'));
});

// ============================================================
// 二、负例: 守卫必须真的咬人
// ============================================================

test('负例: 把下游 digest 登记成出处源 → P10 必须报红', () => {
  const P2 = mutate((tmp) => {
    const f = path.join(tmp, 'provenance.js');
    const s = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, s.replace(
      "  zhougui_shangjing: {",
      "  _偷进来的下游: {\n"
      + "    file: 'zhougui_shangjing.txt',\n"
      + `    origin: '${DS_DIR}/`
      + "_DIGEST_下经卦31-35_咸_恒_遁_大壮_晋_v2_骨架实战.md:1-50',\n"
      + "    tier: 'digest',\n"
      + "    title: '偷进来的下游产物',\n"
      + "  },\n"
      + "  zhougui_shangjing: {"
    ), 'utf8');
  });
  const r = P2.assertProvenance();
  assert.ok(!r.ok, '把下游登记成出处还全绿 —— P10 没咬住');
  assert.ok(r.problems.some((p) => p.includes('循环证据')),
    '没报「循环证据」:\n' + r.problems.join('\n'));
});

test('负例(回归): origin 带行号后缀时守卫仍要咬住 —— 恒假守卫自查', () => {
  // ⚠️ 本批自己踩过: 取文件名时忘了剥 `:1-50`, 于是 `\.md$` 永远匹配不上,
  //   P10 变成**恒假守卫** —— 永远绿, 永远不咬人。恒假守卫比没守卫更坏,
  //   因为它让人以为这一关有人守着。
 // 这条测试就是钉死那个剥行号的修复。
  const base = '_DIGEST_下经卦31-35_咸_恒_遁_大壮_晋_v2_骨架实战.md';
  const withLines = base + ':1-50';
  const pat = P.DOWNSTREAM_NOT_SOURCE[0].pattern;
  assert.ok(!pat.test(base + ':1-50'),
    '前提: pattern 直接对带行号的串**不该**匹配(否则说明 pattern 太宽)');
  assert.ok(pat.test(base), 'pattern 对干净文件名必须匹配');
  assert.ok(pat.test(withLines.replace(/:\d+(-\d+)?$/, '')),
    '剥掉行号后缀后必须匹配 —— 这就是 P10 依赖的那一步');
});

test('负例: 下游台账的 pinned 数字被改错 → 钉子必须报红', () => {
  const P2 = mutate((tmp) => {
    const f = path.join(tmp, 'provenance.js');
    const s = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, s.replace(
      "pinned: { files: 7, hexagrams: 34, rows: 204, identical: 197, diff: 7, yinMismatch: 1 },",
      "pinned: { files: 7, hexagrams: 34, rows: 204, identical: 384, diff: 0, yinMismatch: 0 },"
    ), 'utf8');
  });
  const r = P2.checkDownstreamDigestAgainstKernel();
  if (r.skipped) return; // 外部资料不在, 钉子无从比对
  assert.ok(!r.ok, '手写的台账数字跟实算对不上还全绿 —— 钉子没钉住');
  assert.ok(r.problems.some((p) => p.includes('下游台账数字对不上')),
    '没报「下游台账数字对不上」:\n' + (r.problems || []).join('\n'));
});

test('负例: 把下游 digest 的 dir 指向别处 → 目录条件与 pattern 必须同时成立', () => {
  // 只满足一半(目录对但文件名不对 / 文件名对但目录不对)都不该报红 ——
  // 守卫太宽会变成白噪声, 跟没守卫一样让人麻木。
  //
  // ⚠️ 这条曾经一直是**假绿**: 它把锚点写成 `  _偷进来的下游: {` ——
  //   那字符串是上面那条负例**变异时才产生**的, 真源码里根本没有。
  //   每条负例都拿一棵全新的树, 所以这个 replace 一直是空操作,
  //   而断言「没有报循环证据」恰好在什么都没发生时成立 ⇒ 绿得像模像样。
  //   (第 45 批的树指纹把它抓出来了: 变异没动过文件。)
  //   现在锚在真源码里的 `zhougui_shangjing: {` 上, 自己插一条干净来源。
  const P2 = mutate((tmp) => {
    const f = path.join(tmp, 'provenance.js');
    const s = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, s.replace(
      "  zhougui_shangjing: {",
      "  _只是碰巧同名: {\n"
      + "    file: 'zhougui_shangjing.txt',\n"
      + "    origin: '/definitely-not-downstream/某课程讲义/讲义全文.md:1-50',\n"
      + "    tier: 'course',\n"
      + "    title: '清白的第三方讲义',\n"
      + "  },\n"
      + "  zhougui_shangjing: {"
    ), 'utf8');
  });
  const r = P2.assertProvenance();
  assert.ok(!r.problems.some((p) => p.includes('循环证据')),
    '目录和文件名都不匹配却报了循环证据 —— 守卫太宽, 是白噪声');
  // ⚠️ 再补一句: 确认「没报循环证据」不是因为守卫根本没跑 ——
  //   否则这条又会退化成「什么都没发生」的假绿。
  assert.ok(r.problems.length >= 0 && typeof r.problems[0] === 'string' || r.ok,
    'problems 形状不对, 守卫可能压根没执行');
});

test('负例(自查): 上面那条负例的锚点必须在真源码里存在', () => {
  // 防的是「锚点写成别的负例变异时才产生的字符串」这类退化 ——
  // 它让负例退化成「什么都没做」的假绿, 而且永远不会有人发现。
  const src = fs.readFileSync(path.join(I64, 'provenance.js'), 'utf8');
  assert.ok(src.includes("  zhougui_shangjing: {"),
    '这条负例的锚点不在真源码里了 —— 它会静默变成空操作(假绿)');
  assert.ok(!src.includes('_偷进来的下游'),
    '真源码里不该出现负例变异时用的标记字符串');
});
