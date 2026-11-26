/**
 * 爻辞异文台账测试 (第 31 批 · 2026-10-22)
 *
 * ⚠️ 本文件里最重要的一段是**负例**那一节。
 *   这批的结论是「180 爻核过, **repo 真错 0 条**」——
 *   一个零错误的结论最容易变成一句没人验证的话。
 *   所以这里钉的**不是**「数据长这样」, 而是
 *   「这套台账一旦脱节/造假, 守卫会当场报出来」。
 *
 * 背景: 唯一独立真源是上经 30 卦 + 咸卦 = 31 卦爻辞;
 *   digest 目录下 34 份「骨架实战」全部自标与 hexagrams.js **同源**, 拿它们核验是恒真守卫。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const YCV = require(path.join(__dirname, '..', '64i', 'bagua_annotations', 'yao_ci_variants.js'));
const { HEXAGRAMS } = require(path.join(__dirname, '..', '64i', 'hexagrams.js'));
// 2026-11-26: 开源导出树 (有 .pangu-open-source 标记) 的 SRC_BROKEN 证据源是本机
//   课程原文, 切片 (public 公版对账结果) 里没有那个串 ⇒ 负例在导出树里语义反转。
//   开源模式下跳过这条负例 (私有树照旧全量校验)。
const IS_OPEN_SOURCE = fs.existsSync(path.resolve(__dirname, '..', '64i', '.pangu-open-source'));

// ============================================================
// 一、正例
// ============================================================

test('全量自检通过 (真代码没脱节)', () => {
  const r = YCV.assertYaoCiVariants();
  assert.equal(r.ok, true);
});

test('口径数字必须跟台账实际条数对上', () => {
  const actualBroken = YCV.YAO_CI_VARIANTS.filter(v => v.kind === 'SRC_BROKEN').length;
  const actualVariant = YCV.YAO_CI_VARIANTS.filter(v => v.kind === 'VERSION').length;
  assert.equal(actualBroken, YCV.YAO_CI_BASIS.src_broken,
    '口径说有几条真源坏了, 台账实际条数对不上');
  assert.equal(actualVariant, YCV.YAO_CI_BASIS.variant_readings,
    '口径说有几条异文, 台账实际条数对不上');
});

test('★ 核验结论是 repo 真错 0 条 —— 台账里不许有 REPO_ERR', () => {
  const errs = YCV.YAO_CI_VARIANTS.filter(v => v.kind === 'REPO_ERR');
  assert.equal(errs.length, 0,
    '台账里冒出了 REPO_ERR: ' + errs.map(v => v.gua + '·' + v.yao).join(', ')
    + ' —— 要么核验漏了, 要么有人把真错改标成 VERSION 蒙过去了');
  assert.equal(YCV.YAO_CI_BASIS.repo_errors, 0);
});

test('判「真源坏了」的每一条都必须有象曰证据', () => {
  for (const v of YCV.YAO_CI_VARIANTS) {
    if (v.kind !== 'SRC_BROKEN') continue;
    assert.ok(v.xiang_quote,
      v.gua + '·' + v.yao + ' 判成 SRC_BROKEN 却没给象曰证据 —— '
      + '「我觉得真源错了」没有凭证, 这条裁定自己塌了');
    assert.ok(v.note && v.note.length > 20, v.gua + '·' + v.yao + ' 裁定没有说清理由');
  }
});

test('台账里记的 repo 读法, 真的还在爻辞表里', () => {
  const CN = { '二': 2, '三': 3, '四': 4, '五': 5 };
  for (const v of YCV.YAO_CI_VARIANTS) {
    const h = HEXAGRAMS.find(x => x.name === v.gua);
    assert.ok(h, '表里没有这个卦: ' + v.gua);
    const idx = v.yao[0] === '初' ? 0 : v.yao[0] === '上' ? 5 : CN[v.yao[1]] - 1;
    const line = String(h.yao_ci[idx] || '');
    assert.ok(line.includes(v.repo),
      v.gua + '·' + v.yao + ' 台账记的读法「' + v.repo + '」在 hexagrams.js 里找不到 —— '
      + '爻辞改过了, 台账没跟上。实为: ' + line);
  }
});

test('34 卦无独立原文可核 —— 显式标 null + 原因, 不拿推算填', () => {
  assert.equal(YCV.UNCOVERED_GUA.length, 34);
  assert.equal(YCV.isYaoCiVerified('未济'), false, '下经没原文可核, 不能报已核');
  assert.equal(YCV.isYaoCiVerified('泰'), true, '上经有原文可核, 应报已核');
  for (const g of YCV.UNCOVERED_GUA) {
    assert.equal(g.verified, null, g.name + ' 的 verified 必须是 null, 不是 true/false');
    assert.ok(g.reason && g.reason.length > 5, g.name + ' 缺口必须带原因');
  }
  // 随卦是**单独一种缺口**: 真源文件自己漏了它的卦头(不是「下经没收录」)
  const sui = YCV.UNCOVERED_GUA.find(g => g.name === '随');
  assert.ok(sui.reason.includes('卦头'), '随卦的缺口原因应当说明是卦头缺失, 与下经不同');
});

test('异体字表只收「归一后逐字相同」的, 不许吞掉真差异', () => {
  for (const g of YCV.VARIANT_GLYPHS) {
    assert.notEqual(g.from, g.to, '这条归一映射是空操作');
    assert.ok(g.note && g.note.length > 5, g.from + '→' + g.to + ' 缺理由');
  }
  // 已/己、祗/祇 刻意**不收**: 它们归一后句子不完全相同, 塞进来会吞掉 L3 真差异
  const pairs = YCV.VARIANT_GLYPHS.map(g => g.from + g.to);
  assert.ok(!pairs.includes('已己'), '「已/己」不该进异体字表(真差异在台账里, 归一会吞掉它)');
  assert.ok(!pairs.includes('祗祇'), '「祗/祇」不该进异体字表');
});

test('异文跟着数据出参 —— 模型看得见, 才不会把一条读法当唯一正解', () => {
  const d = YCV.describeYaoCi('屯', '六二');
  assert.equal(d.variants.length, 1);
  assert.equal(d.variants[0].kind, 'SRC_BROKEN');
  assert.equal(d.basis.repo_errors, 0, '口径要带上 repo_errors, 模型才知道这边没查出错');
  assert.equal(d.basis.source_is_single, true,
    '必须明说只有一个源 —— 模型才不敢宣称「权威版本」');
});

test('digest 那 34 份「骨架实战」被显式列为不可用真源', () => {
  assert.ok(YCV.YAO_CI_BASIS.reject_as_source.length >= 1);
  const s = YCV.YAO_CI_BASIS.reject_as_source[0];
  assert.ok(s.includes('同源'), '必须写明拒绝理由是「与 hexagrams.js 同源」');
});

// ============================================================
// 二、负例: 守卫必须会咬人
//   ⚠️ 全部走**子进程**, 不改共享源文件
//      (2026-10-22 踩过: node --test 多文件并行 + 同文件顶层测试并发,
//       猴补丁会被隔壁文件读到, 一次「单跑绿、全量红」)
// ============================================================

/** 在子进程里改坏台账, 看守卫抓不抓 —— 进程边界隔离 */
function runWithBroken(breakCode) {
  const { spawnSync } = require('child_process');
  const modPath = path.join(__dirname, '..', '64i', 'bagua_annotations', 'yao_ci_variants.js');
  const script = `
    const m = require(${JSON.stringify(modPath)});
    m.assertYaoCiVariants();
    (function () { ${breakCode} })();
    let threw = false;
    try { m.assertYaoCiVariants(); } catch (e) { threw = true; process.stdout.write(String(e.message)); }
    process.exit(threw ? 0 : 3);
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  return { threw: r.status === 0, msg: (r.stdout || '') + (r.stderr || '') };
}

test('负例: 台账的 repo 读法跟爻辞表脱钩 → 报出来', () => {
  const r = runWithBroken("m.YAO_CI_VARIANTS[0].repo = '这一句根本不在爻辞表里';");
  assert.equal(r.threw, true, '台账与爻辞表脱节竟然通过了 —— 守卫没咬人\n' + r.msg);
  assert.ok(r.msg.includes('台账'), '报错要指出是台账问题\n' + r.msg);
});

test('负例: 判真源坏的那条把象曰证据换成源文件里没有的串 → 报出来', () => {
  // 开源导出树里证据源是本机课程原文 (不在仓里), 切片里也没有这个串,
  //   负例的「假串被拒」语义在导出树里不成立 (真串也过不了), 跳过。
  if (IS_OPEN_SOURCE) return;
  const r = runWithBroken(`
    const v = m.YAO_CI_VARIANTS.find(x => x.kind === 'SRC_BROKEN');
    v.xiang_quote = '这句话源文件根本没有';
  `);
  assert.equal(r.threw, true, '假证据竟然通过了\n' + r.msg);
  assert.ok(r.msg.includes('证据') || r.msg.includes('源文件'), r.msg);
});

test('负例: 判真源坏的那条抹掉象曰证据 → 报出来 (无凭证的裁定自己塌)', () => {
  const r = runWithBroken(`
    const v = m.YAO_CI_VARIANTS.find(x => x.kind === 'SRC_BROKEN');
    v.xiang_quote = null;
  `);
  assert.equal(r.threw, true, '「我觉得真源错了」没凭证竟然通过了\n' + r.msg);
  assert.ok(r.msg.includes('凭证'), r.msg);
});

test('负例: 把一条异文改标成 SRC_BROKEN → 口径数字对不上, 报出来', () => {
  const r = runWithBroken(`
    const v = m.YAO_CI_VARIANTS.find(x => x.kind === 'VERSION');
    v.kind = 'SRC_BROKEN';
  `);
  assert.equal(r.threw, true, '口径漂移竟然通过了\n' + r.msg);
  assert.ok(r.msg.includes('口径') || r.msg.includes('凭证'), r.msg);
});

test('负例: 源文件换成不含证据的文本 → 证据查无实据, 报出来', () => {
  const fs = require('fs');
  const os = require('os');
  const f = path.join(os.tmpdir(), 'pangu-ycv-noevidence.txt');
  fs.writeFileSync(f, '这里没有任何爻辞内容\n只是随便一行字\n', 'utf8');
  let threw = false;
  let msg = '';
  try { YCV.assertYaoCiVariants({ sourcePath: f }); }
  catch (e) { threw = true; msg = e.message; }
  fs.unlinkSync(f);
  assert.equal(threw, true, '源里没有证据竟然通过了 —— 这条判据是空壳\n' + msg);
});

test('负例: 源文件是空文件 → 报出来 (判据不能写 if (srcText && ...))', () => {
  // ⚠️ 这个洞是被负例咬出来的: `''` 在 JS 里是 falsy,
  //   写 `if (srcText && !srcText.includes(q))` 会在空文件时**整体短路**,
  //   所有证据检查被跳过, 守卫安静通过 —— 跟「把五行删光也能过」同族。
  const fs = require('fs');
  const os = require('os');
  const f = path.join(os.tmpdir(), 'pangu-ycv-empty.txt');
  fs.writeFileSync(f, '', 'utf8');
  let threw = false;
  let msg = '';
  try { YCV.assertYaoCiVariants({ sourcePath: f }); }
  catch (e) { threw = true; msg = e.message; }
  fs.unlinkSync(f);
  assert.equal(threw, true, '空文件竟然通过了 —— 判据被 falsy 短路吃掉了\n' + msg);
  assert.ok(msg.includes('空文件'), msg);
});

test('源文件不在本机时降级不抛 (守卫不许把起卦带崩)', () => {
  const r = YCV.assertYaoCiVariants({ sourcePath: '/tmp/pangu-绝对不存在-xyz.txt' });
  assert.equal(r.ok, true);
  assert.equal(r.source_available, false, '必须报 source_available=false, 别假装核过了');
});

test('自检要接在启动路径上 (不然只是躺在仓库里的一个文件)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'pangu-single.js'), 'utf8');
  assert.ok(src.includes('assertYaoCiVariants'),
    '爻辞异文台账自检没接进启动链 —— 台账跟爻辞脱节时盘古照样能起来');
});
