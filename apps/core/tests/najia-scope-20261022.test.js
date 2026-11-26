'use strict';
// 纳甲的范围要说清楚 (2026-10-22)
//
// E2E 实测: hexagram_lookup 给了 najia={乙,酉}, 模型接着写
//   「内卦离 → 乙酉; 外卦艮 → 丙辛… 依 64i 真源记录为 天干乙、地支酉」
// 「丙辛」**根本不是干支** —— 模型只能凭记忆补, 补出来就是编的。
//
// ⚠️ 2026-10-22 第 33 批**把这个测试的前提也翻了**:
//   当时以为「64i 本表只存首爻一柱, 所以要讲清范围」——
//   那是**半对的错解**: 那个 najia 字段**压根不是纳甲**, 它是 60 甲子按卦序的
//   机械循环(坤卦打成「乙丑」, 真纳甲是「乙未」)。
//   光说「只有一柱」不够 —— 说得像纳甲, 模型就会拿它当纳甲用。
//   现在: 那个字段**明说不是纳甲表**, 真纳甲走 64i/bagua_annotations/najia.js,
//   装得出就给(4 卦: 乾/泰/否/坤), 装不出给 null + 原因。
//
// 本测试钉住:
//   ① 旧字段的**机械性质**(60 甲子按文王序)仍然钉住 —— 但标注它是「旧字段」,
//      且必须同时满足「8/8 组违反京房必要条件」这条判它不是纳甲的证据
//   ② 工具输出与事实块都**不再**把旧字段当纳甲讲
//   ③ 事实块不出现"内卦/外卦"式的展开引导

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CORE = path.join(__dirname, '..');
const { HEXAGRAMS } = require(path.join(CORE, '64i', 'hexagrams.js'));
const { TOOLS } = require(path.join(CORE, 'modules', 'tools', 'index.js'));
const gate = require(path.join(CORE, 'modules', 'gua_answer_gate.js'));
const NJ = require(path.join(CORE, '64i', 'bagua_annotations', 'najia.js'));

// 六十甲子 —— **程序算**, 不抄一份表(抄的迟早只改其中一份)
const TIANGAN = '甲乙丙丁戊己庚辛壬癸';
const DIANZHI = '子丑寅卯辰巳午未申酉戌亥';
const JIAZI = [];
for (let i = 0; i < 60; i++) {
  JIAZI.push(TIANGAN[i % 10] + DIANZHI[i % 12]);
}

test('旧 najia 字段 = 六十甲子按文王卦序 (机械性质钉死, 但它**不是**纳甲)', () => {
  for (const h of HEXAGRAMS) {
    assert.ok(h.najia, h.name + ' 没有旧 najia 字段');
    const want = JIAZI[(h.id - 1) % 60];
    assert.equal(h.najia.tiangan + h.najia.dianzhi, want,
      h.name + '(卦序 ' + h.id + ') 的旧字段与「六十甲子按文王序」对不上');
  }
  // 「它是什么」钉住了, 还得钉住「它不是什么」——
  // 否则哪天有人把真纳甲灌进去, 口径标记会静默过期。
  const a = NJ.auditLegacyNajia();
  assert.equal(a.jingfang_necessary_property_holds, false,
    '旧字段若满足京房装卦纳甲的必要条件, 说明它已经换成了真纳甲表, 口径要改');
  assert.equal(a.jingfang_violations.length, 8, '8/8 个同下卦组都应违反京房必要条件');
});

test('工具输出: 旧字段明说不是纳甲表, 真纳甲照实给六爻干支', async () => {
  const r = await TOOLS.hexagram_lookup({ params: { query: '22' } });
  assert.equal(r.ok, true);
  // 旧字段本身仍在(改名会砸掉既有调用方), 但**必须带标记**
  assert.equal(r.data.najia._is_najia, false, '数据上要带标记 —— 模型可能只看数据不看注');
  assert.ok(/不是纳甲表/.test(r.data.najia_note), r.data.najia_note);
  assert.ok(!/六十四卦纳甲表/.test(r.data.najia_note), '不能再叫「六十四卦纳甲表」');
  // 卦 22 = 贲(上艮下离)
  // ⚠️ 第 41 批补齐八卦地支后, 贲(离下艮上)**装得出了** ⇒ 这条断言从
  //   「装不出 ⇒ 给 null + 原因」翻转成「装得出 ⇒ 六爻干支照实给」。
  //   「装不出就不许编」这条性质没有消失, 只是真实数据上走不到 ——
  //   它由 liu-qin-gong-basis / najia-layer 两个测试**注入缺口**单独验着。
  assert.equal(r.data.najia.tiangan + r.data.najia.dianzhi, '乙酉');
  assert.equal(r.data.yao_ganzhi.loadable, true, '贲卦(离下艮上)补齐地支后应装得出完整六爻干支');
  assert.equal(r.data.yao_ganzhi.yao.length, 6, '六爻干支应逐爻给全');
  assert.equal(r.data.yao_ganzhi.reason, null, '装得出就不该挂缺口理由');
  assert.deepEqual(r.data.yao_ganzhi.missing, [], '装得出就不该有缺的卦');
  // 干支逐爻对得上纳甲层(内部一致, 不是编的)
  for (const y of r.data.yao_ganzhi.yao) {
    const g = NJ.getYaoGanzhi(22, y.pos);
    assert.equal(g.ok, true);
    assert.equal(y.ganzhi, g.ganzhi, '第' + y.pos + '爻干支应与纳甲层一致');
  }
});

test('事实块: 不再拿旧字段冒充纳甲, 也不引导展开内外卦', () => {
  const fb = gate.buildGuaFactsBlock([{ guaIds: [22], claim: 'x', expect: 'y' }]);
  assert.ok(!/纳甲 乙酉/.test(fb), '事实块不许把旧字段(乙酉)当纳甲给');
  assert.ok(/不是纳甲表/.test(fb), '事实块要说明旧字段不是纳甲表');
  // 第 41 批后是「装得出」, 事实块必须照实说, 且不许还留着旧口径的「装不出」
  assert.ok(/384\/384/.test(fb), '事实块要照实说装卦覆盖(现为 384/384): ' + fb);
  assert.ok(!/装不出|其余 60 卦|只有乾、坤/.test(fb), '事实块不该还留着第 33 批的旧口径');
  // 事实块是**基准** —— 基准里出现"内卦/外卦"的展开引导, 模型就会顺着展开
  assert.ok(!/内卦[^。]*纳甲|外卦[^。]*纳甲/.test(fb), '事实块不许引导展开内外卦纳甲');
});
