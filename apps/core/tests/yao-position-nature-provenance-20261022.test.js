/**
 * tests/yao-position-nature-provenance-20261022.test.js
 * 第 45 批: 爻位性质的身份标签 (生产口径)
 *
 * 起因: 「爻位性质(根元/身本/动用/变机/德成/极终)」这 6 个词查无典籍出处。
 * 第 42 批在出处层登记对了(unsourced + 理由), 但**生产文本里它没标身份** ——
 * `gua_block` / `teamflow` 直接把「爻位性质: 身本」印进模型读到的卦块,
 * 于是模型会照着当经典讲。这是「出处层说清楚了, 但模型看不见出处层」的空档。
 *
 * ⚠️ 本批的测试防的是**另一件事**: 别以为「出处层登记了」就等于「模型知道了」。
 *   出处层是给人和启动自检看的; 生产文本是给模型看的。**两者是两条路。**
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const gb = require(path.join(CORE, 'modules/gua_block.js'));
const tf = require(path.join(CORE, 'modules/teamflow.js'));
const P = require(path.join(CORE, '64i/provenance.js'));

const GUA = {
  gua_name: '旅', symbol: '䷷', gua_ci: '旅，小亨，旅贞吉。',
  upper_trigram: '离', lower_trigram: '艮',
  moving_yao: 1, yao_name: '初六', moving_yao_ci: '旅琐琐，斯其所取灾',
  wuxing: '火', yao_wuxing: '金', wuxing_rel: '火克金', liu_qin: '父母',
  position_nature: '身本',
};

// ⚠️ 渲染断言必须对**字面量**做, 不能只 `includes(gb.POSITION_NATURE_TAG)` ——
//   标签常量要是被清成 '', `s.includes('')` 恒为真, 两条最关键的测试会**假绿**。
//   (今天真栽过: 把常量清空, 8 条里只有一条变红, 另外两条形同虚设。)
//   所以: 先断言常量非空且等于预期字面量, 再断言渲染结果含它。
const EXPECTED_TAG = '〔盘古自创框架, 非典籍出处〕';

// ============================================================
// 工具: 复制一棵 64i 树到临时目录, 用来跑 P12 的负例
// ============================================================

// 工具(负例用的树复制/变异)在 tests/helpers/provenance_mutate.js —— 共用一份。
const { mutateProvenance } = require('./helpers/provenance_mutate');

/** 造一棵「坏树」, 返回它的 provenance 模块。 */
function mutate(mutator) {
  return mutateProvenance(CORE, 'posnat', mutator);
}

// ============================================================
// 一、生产口径: 模型实际读到的那段文本
// ============================================================

test('正例: gua_block 渲染的卦块里, 爻位性质必须带身份标签', () => {
  assert.equal(gb.POSITION_NATURE_TAG, EXPECTED_TAG,
    '标签常量变了或被清空 —— 渲染断言会跟着假绿, 必须先钉住它');
  const s = gb.formatGuaFirstBlock(GUA);
  assert.ok(s.includes('爻位性质: 身本'), '爻位性质字段没渲染出来');
  assert.ok(s.includes(EXPECTED_TAG),
    '爻位性质后面没有身份标签 —— 模型会把自创框架当经典讲');
});

test('正例: teamflow 的子卦块也一样带标签', () => {
  assert.equal(gb.POSITION_NATURE_TAG, EXPECTED_TAG,
    '标签常量变了或被清空 —— 渲染断言会跟着假绿, 必须先钉住它');
  const s = tf.buildSubtaskPrompt('总目标', '子任务', GUA, null);
  assert.ok(s.includes('爻位性质: 身本'), '子卦块里爻位性质没渲染出来');
  assert.ok(s.includes(EXPECTED_TAG),
    '子卦块漏了身份标签 —— 走 teamflow 那条路就白标了');
});

test('正例: 两处渲染用的是**同一份**标签常量', () => {
  // 两处各写各的标签字面量 ⇒ 改一处忘一处 ⇒ 有一半路径没标签。
  // 所以标签必须是导出的常量, 两处都引用它。
  const srcGb = fs.readFileSync(path.join(CORE, 'modules/gua_block.js'), 'utf8');
  const srcTf = fs.readFileSync(path.join(CORE, 'modules/teamflow.js'), 'utf8');
  assert.ok(/POSITION_NATURE_TAG\s*=\s*'/.test(srcGb),
    '标签应当定义在 gua_block 里并导出');
  assert.ok(srcTf.includes('POSITION_NATURE_TAG'),
    'teamflow 必须引用同一个常量, 不能自己再写一份字面量');
  assert.ok(!/爻位性质[^\n]*〔[^〕]*〕[^\n]*(?<!POSITION_NATURE_TAG)/.test(srcTf.replace(/\$\{POSITION_NATURE_TAG\}/g, '')),
    'teamflow 里疑似有第二份手写的标签字面量');
});

test('正例: 标签本身必须说清「非典籍」, 不能只是含糊的注记', () => {
  const t = gb.POSITION_NATURE_TAG;
  assert.ok(t.length > 0);
  assert.ok(/非典籍|自创/.test(t),
    '标签没说明身份: ' + t + ' —— 模型看不出它是自创还是经典');
});

// ============================================================
// 二、负例: 标签被拿掉 / 被写坏时必须报红
// ============================================================

test('负例: 爻位性质为空时也不能留下无标签的裸字段', () => {
  // 诚实空是合法的(position_nature 本来就可能空), 但**标签不能跟着空掉** ——
  // 否则「空 + 无标签」会被读成「没这个概念」, 而不是「这个字段没有值」。
  const s = gb.formatGuaFirstBlock(Object.assign({}, GUA, { position_nature: '' }));
  assert.ok(s.includes(gb.POSITION_NATURE_TAG), '爻位性质为空时标签也空了 —— 两种空被混成一种');
});

test('负例(回归): 标签是「正面式」而不是禁令式', () => {
  // 本文件所在模块立过的规矩: 禁令式措辞等于亲手把那个词喂给模型
  // (「不要复述本块原文」→ 改成「要引就引真卦辞/爻辞原文里的一句」)。
  // 所以标签只能**陈述身份**, 不能出现「不要/禁止/不许」这类指令。
  const t = gb.POSITION_NATURE_TAG;
  assert.ok(!/不要|禁止|不许|勿/.test(t),
    '标签里出现了禁令式措辞: ' + t + ' —— 照本模块的教训, 标身份比下禁令可靠');
});

// ============================================================
// 三、出处层与生产层是两条路, 都要在
// ============================================================

test('正例: 出处层仍把这 6 个词记成「查无出处」', () => {
  const L = P.LAYERS['bagua_annotations:yao_axioms'];
  const f = L.fields.find((x) => String(x.field).indexOf('爻位性质') >= 0);
  assert.ok(f, '出处层没有登记爻位性质');
  assert.ok(['unsourced', 'interpretive'].indexOf(f.status) >= 0,
    '爻位性质不该标 sourced —— 六词查无典籍出处, 实为 ' + f.status);
  assert.ok(f.reason && f.reason.length > 10, '必须写清楚为什么查不到出处');
});

// ============================================================
// 四、守卫 P12: 出处层说「生产层带标签」, 文件里就必须真的有
// ============================================================

test('正例: P12 在真树上全绿', () => {
  const s = P.provenanceSummary();
  assert.ok(s.ok, '出处层报红:\n' + s.problems.join('\n'));
  const st = P.assertProvenance().stats;
  assert.ok(st.productionMarked > 0,
    '没有任何字段登记了生产层身份标签 —— 爻位性质那一处应该登记');
});

test('负例: 生产层把标签换成手写字面量 → P12 必须报红', () => {
  // 这条防的是「光看文件里有没有这个词」那种**恒真**守卫:
  // `const { POSITION_NATURE_TAG } = require('./gua_block')` 那行永远在,
  // 哪怕渲染点早就改成了手写字面量。守卫必须进**函数体**里看。
  const P2 = mutate((tmp) => {
    const f = path.join(tmp, 'provenance.js');
    const s2 = fs.readFileSync(f, 'utf8');
    // 台账里登记的 marker 改成一个代码里没有的字面量
    fs.writeFileSync(f, s2.replace(
      "marker: '〔盘古自创框架, 非典籍出处〕',",
      "marker: '〔根本没这个字面量〕',"
    ), 'utf8');
  });
  const r = P2.provenanceSummary();
  assert.ok(!r.ok, '台账记的字面量跟代码对不上还全绿');
  assert.ok(r.problems.some((p) => p.includes('标签字面量') || p.includes('字面量')),
    '没报「字面量对不上」:\n' + r.problems.join('\n'));
});

test('负例: 台账把渲染点函数名写错 → P12 必须报红', () => {
  // ⚠️ 第 46 批踩过的坑(这个负例当时**假绿**了):
  //   负例靠字符串替换改台账的渲染点名字。若源码里**注释**也写了同一串
  //   「modules/gua_block.js:formatGuaFirstBlock」, replace 改的就是注释 ——
  //   台账纹丝不动 ⇒ 负例「有变异」(指纹变了)但没测到东西 ⇒ 假绿。
  //   栽法: 第 46 批在 P12 守卫的注释里写了完整的「路径:函数名」当例子。
  //   ⇒ 规矩: **注释里不许出现完整的「路径:函数名」**, 负例的 replace 才咬得到台账。
  const P2 = mutate((tmp) => {
    const f = path.join(tmp, 'provenance.js');
    const s2 = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, s2.replace(
      'modules/gua_block.js:formatGuaFirstBlock',
      'modules/gua_block.js:formatGuaFirstBlockX'
    ), 'utf8');
  });
  const r = P2.provenanceSummary();
  assert.ok(!r.ok, '台账指向不存在的函数还全绿');
  assert.ok(r.problems.some((p) => p.includes('定位不到')),
    '没报「定位不到」:\n' + r.problems.join('\n'));
});

test('正例: 六个词确实是自创 —— 这条测试守住「别偷偷把它改成 sourced」', () => {
  const yao = require(path.join(CORE, '64i/bagua_annotations/yao_axioms.js'));
  const six = yao.YAO_POSITION_AXIOMS.map((a) => a.nature);
  assert.equal(six.length, 6);
  for (const w of six) {
    assert.ok(typeof w === 'string' && w.length > 0);
  }
  // 这 6 个词在本地典籍里查不到(第 45 批实测: 四词零命中, 两词撞词)。
  // 所以**不许**在测试里断言它们「来自某典籍」—— 那样写就是给自己造假出处。
  const L = P.LAYERS['bagua_annotations:yao_axioms'];
  const f = L.fields.find((x) => String(x.field).indexOf('爻位性质') >= 0);
  assert.notEqual(f.status, 'sourced', '不许把查无出处的字段标成 sourced');
});
