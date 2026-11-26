/**
 * tests/zhuanggua-basis-20261023.test.js
 * 第 57 批: 装卦口径(纳甲/六亲) + 京房世应/互卦 —— 把「这串数是什么来路」送到模型眼前
 *
 * 起因: 2026-10-23 实测发现, `gua_cast` 的 tool_result 里
 *   **纳甲/六亲/京房/互卦的数据早就全到了模型眼前**(34 个字段 / 2663 字节),
 *   一次都没被搬进卦块。真正缺的不是数据, 是口径:
 *
 *   · `hu_gua` 是互卦, 但没说它是「二三四爻为下互、三四五爻为上互」
 *     ⇒ 模型极可能按自己想当然的算法重算, 算错也察觉不到。
 *   · `jingfang.gong_wuxing` 是**京房宫五行**, 不是卦的上卦五行
 *     ⇒ 实测 **32/64 卦两个五行不同**(蒙: 上卦艮土 vs 离宫火), 混了六亲全错且不报错。
 *   · 纳甲干支**出处分两档**: 乾、坤有本地文本真源(<course-source> 阳德/阴德条);
 *     震巽坎离艮兑本地语料一条都没有, 是第 41 批靠外部四源交叉验证定的
 *     ⇒ 不说清, 模型会把 8 卦的纳甲当成同样有典籍背书地讲出去。
 *
 * 这几项在出处台账里**全是 sourced**, 所以**不需要**身份标签 —— 需要的是口径本身。
 * 标签只留给 interpretive/unsourced 的那些(爻位性质/象义/体用分级/爻值老少动静)。
 *
 * ⚠️ 本文件的第一条测试是被一个**真 bug** 逼出来的:
 *   第一版分档用 `v.indexOf('本地文本真源') >= 0` 判档, 结果 8/8 全被判成本地真源。
 *   原因: 震那一条的原文是「外部四源交叉验证(第 41 批): … ; **本地文本真源未收录**震卦六爻地支」
 *   —— 子串搜命中了**否定句**里的那个词。
 *   与第 56 批「默认」被同句括号里的「默认值」顶替是同一类错:
 *   **关键词断言不做位置锚定, 就会被同一句里别处的同名词替身顶掉。**
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CORE = path.join(__dirname, '..');
const ge = require(path.join(CORE, 'modules', 'gua_engine.js'));
const gb = require(path.join(CORE, 'modules', 'gua_block.js'));
const pv = require(path.join(CORE, '64i', 'provenance.js'));
const nj = require(path.join(CORE, '64i', 'bagua_annotations', 'najia.js'));
const jf = require(path.join(CORE, '64i', 'bagua_annotations', 'jingfang_bagong.js'));
const HX = require(path.join(CORE, '64i', 'hexagrams.js'));

// ============================================================
// 一、装卦口径行
// ============================================================

test('正例: 装卦口径行进块, 装法规则原文来自 NAJIA_BASIS(不手写)', () => {
  const g = ge.castGua('装卦口径', { numbers: [1, 2, 3] });
  const line = gb.buildZhuangGuaLine(g);
  assert.ok(line, '装卦口径行为空');
  assert.ok(line.indexOf(gb.ZHUANG_GUA_HEAD) >= 0, '行首没标出这是装卦口径');
  // 装法规则必须是**真源那句原文**, 不是我们自己复述的
  const rule = nj.NAJIA_BASIS.zhuanggua_rule;
  assert.ok(rule, '真源里没有 zhuanggua_rule');
  assert.ok(line.indexOf(rule) >= 0,
    '行里没有逐字带上真源的装法规则:\n真源: ' + rule + '\n行  : ' + line);
  assert.ok(gb.formatGuaFirstBlock(g).indexOf(line) >= 0, '整块里没有装卦口径行');
});

test('正例: 装法规则**独立**成立: 内三爻只由下卦决定(不靠跟真源比字符串)', () => {
  // ⚠️ 上一条是「行里逐字带上真源那句」—— 它**抓不到真源本身被改**:
  //   真源和行两边一起变, 断言照样绿(同义反复)。
  // ⇒ 这条改成**拿行为验**: 京房装卦纳甲的必要条件是「初爻干支只由下卦决定」。
  //   同下卦的卦, 初爻干支必须完全一样; 若内三爻错取了上卦, 立刻会破。
  const byLower = {};
  const arr = HX.HEXAGRAMS || HX.default || HX;
  let groups = 0;
  for (const x of arr) {
    if (!x || !x.trigrams) continue;
    const lo = x.trigrams.lower_name;
    const gz = nj.getYaoGanzhi ? nj.getYaoGanzhi(x.id, 1) : null;
    if (!gz) continue;
    if (!byLower[lo]) { byLower[lo] = []; groups++; }
    byLower[lo].push(String(gz));
  }
  assert.ok(groups >= 8, '没攒够同下卦组, 前提不成立');
  for (const [lo, list] of Object.entries(byLower)) {
    assert.equal(new Set(list).size, 1,
      '下卦 ' + lo + ' 组内初爻干支不唯一(' + new Set(list).size + ' 种) '
      + '⇒ 内三爻不是「只由下卦决定」, 装法与真源声明的规则不符');
  }
  // 规则文本本身也要含得住这四个关键词(改**实质**会被这条打死;
  // 纯改措辞不会, 那是另一回事, 见下面 M10 等价变异的说明)
  const rule = nj.NAJIA_BASIS.zhuanggua_rule || '';
  for (const kw of ['内三爻', '下卦', '外三爻', '上卦']) {
    assert.ok(rule.indexOf(kw) >= 0, '装法规则里没有「' + kw + '」');
  }

  // ⚠️⚠️ 上一段还**抓不到「规则文本说反」**: 把 zhuanggua_rule 改成
  // 「内三爻取**上**卦纳甲, 外三爻取**下**卦纳甲」(实质完全相反)照样全绿 ——
  // 因为上面那句「逐字带上真源」是拿真源自己当基准(同义反复),
  // 而关键词内三爻/下卦/外三爻/上卦 **反转后一个都不少**。
  // ⇒ 这里**不用规则文本判**, 先**从数据独立判定**内三爻到底跟谁走,
  //    再回头要求规则文本必须说出同一个答案。
  const arr2 = HX.HEXAGRAMS || HX.default || HX;
  const innerOf = (id) => [1, 2, 3].map((p) => {
    const r = nj.getYaoGanzhi(id, p);
    return r && r.dianzhi;
  }).join('');
  const outerOf = (id) => [4, 5, 6].map((p) => {
    const r = nj.getYaoGanzhi(id, p);
    return r && r.dianzhi;
  }).join('');
  // 找一对「同**上**卦、不同**下**卦」的卦: 内三爻若变 ⇒ 它跟下卦走
  let pair = null;
  for (const a of arr2) {
    if (!a || !a.trigrams) continue;
    for (const b of arr2) {
      if (!b || !b.trigrams || b.id <= a.id) continue;
      if (a.trigrams.upper_name === b.trigrams.upper_name
          && a.trigrams.lower_name !== b.trigrams.lower_name) { pair = [a, b]; break; }
    }
    if (pair) break;
  }
  assert.ok(pair, '找不到「同上卦不同下卦」的卦对, 前提不成立, 测试要重写');
  const innerVaries = innerOf(pair[0].id) !== innerOf(pair[1].id);
  const outerVaries = outerOf(pair[0].id) !== outerOf(pair[1].id);
  assert.ok(innerVaries,
    '同上卦不同下卦, 内三爻却不变 ⇒ 内三爻不由下卦决定, 规则文本与实际装法不符');
  assert.ok(!outerVaries,
    '同上卦不同下卦, 外三爻却变了 ⇒ 外三爻不该由上卦独占决定, 规则文本与实际装法不符');
  // 独立判定完了, 才回头要求文本说出同一个答案
  assert.ok(/内三爻[^,，]{0,20}?下卦/.test(rule),
    '独立判定内三爻跟下卦走, 规则文本却没这么说:\n' + rule);
  assert.ok(/外三爻[^,，]{0,20}?上卦/.test(rule),
    '独立判定外三爻跟上卦走, 规则文本却没这么说:\n' + rule);
  assert.ok(!/内三爻[^,，]{0,20}?上卦/.test(rule),
    '规则文本说内三爻跟上卦走, 与独立判定相反:\n' + rule);
  assert.ok(!/外三爻[^,，]{0,20}?下卦/.test(rule),
    '规则文本说外三爻跟下卦走, 与独立判定相反:\n' + rule);
});

test('正例: 纳甲出处分两档, 且**档位判对**(本地文本真源 vs 外部四源交叉验证)', () => {
  // ⚠️ 这条就是被那个真 bug 逼出来的。判据必须**锚前缀**:
  //   震的原文里含「本地文本真源**未收录**震卦六爻地支」——
  //   子串搜「本地文本真源」会命中这句否定, 于是 8/8 全判成本地真源。
  const g = ge.castGua('分档', { numbers: [1, 2, 3] });
  const line = gb.buildZhuangGuaLine(g);
  const seg = line.split('分两档')[1] || '';

  // 剥掉分档句自己的引导词 '—— ' 再比, 否则会把标点当成档名的一部分
  // 剥掉分档句自己的引导词(' —— ' 带前导空格) 再比, 否则会把标点当成档名的一部分
  const localPart = (seg.split(' 本地语料未收录')[0] || '').trim().replace(/^[—\-\s]+/, '').trim();
  const localNames = localPart.split(' 有本地文本真源')[0].trim();
  assert.ok(localNames.length, '没解析出本地真源那一档');
  assert.ok(/^乾\/坤$/.test(localNames),
    '本地文本真源那一档应恰好是「乾/坤」, 实为: ' + localNames);

  const crossNames = (seg.split('有本地文本真源, ')[1] || '').split(' 本地语料未收录')[0].trim();
  assert.ok(/^震\/巽\/坎\/离\/艮\/兑$/.test(crossNames),
    '外部四源交叉验证那一档应恰好是「震/巽/坎/离/艮/兑」, 实为: ' + crossNames);
  // 交叉验证那一档必须**明确说出没本地真源** —— 这正是模型最容易讲过头的地方
  assert.ok(seg.indexOf('外部四源交叉验证') >= 0, '没标明那六卦是外部四源交叉验证');
});

test('正例: 分档判据锚在**前缀**, 不吃同句里的否定句(回归那个真 bug)', () => {
  // 直接拿真源原句当负例跑一遍判据: 震那一条必须落到交叉验证档。
  const ds = nj.DIZHI_SOURCE || {};
  const bad = Object.keys(ds).filter((k) => {
    const v = String(ds[k] || '');
    return v.indexOf('本地文本真源') >= 0 && !/^本地文本真源/.test(v);
  });
  // 这些就是「含『本地文本真源』但开头不是它」的真源条目 —— 全都是否定句提及
  assert.ok(bad.length >= 6,
    '前提不成立: 真源里含否定式提及的条目少于 6 条, 说明真源形状变了, 测试要重写');
  for (const k of bad) {
    assert.ok(/^外部四源交叉验证/.test(ds[k]),
      k + ' 含否定式提及却没落到交叉验证档: ' + String(ds[k]).slice(0, 60));
  }
});

test('正例: 六亲装卦覆盖数从**起卦结果自己数**, 不手写', () => {
  for (const n of [[1, 2, 3], [9, 9, 9], [5, 7, 2]]) {
    const g = ge.castGua('六亲覆盖', { numbers: n });
    const line = gb.buildZhuangGuaLine(g);
    const lq = g.liu_qin_all || [];
    const loaded = lq.filter((x) => x && x.najia_ganzhi).length;
    assert.ok(line.indexOf(loaded + '/' + lq.length + ' 爻') >= 0,
      `覆盖数与起卦结果不符(应 ${loaded}/${lq.length}):\n${line}`);
  }
  // ⚠️ 上一段是**同义反复**: 当前 384/384 全装得出, 所以把 n 硬编成 6 输出完全一样。
  // ⇒ 只能**扰动起卦结果**看行变不变。
  const g2 = ge.castGua('覆盖扰动', { numbers: [1, 2, 3] });
  const before = gb.buildZhuangGuaLine(g2);
  const stub = g2.liu_qin_all.map((x, i) => (i === 0
    ? Object.assign({}, x, { najia_ganzhi: null }) : x));
  const after = gb.buildZhuangGuaLine(Object.assign({}, g2, { liu_qin_all: stub }));
  assert.notEqual(after, before,
    '把一爻的纳甲干支挖空, 口径行纹丝不动 ⇒ 覆盖数是**手打**的, 没跟起卦结果走');
  assert.ok(after.indexOf('5/6 爻') >= 0, '扰动后的覆盖数不对:\n' + after);
  assert.ok(after.indexOf('其余给 null + 原因') >= 0,
    '覆盖不满时没说明其余爻给 null + 原因:\n' + after);
});

// ============================================================
// 二、京房世应 + 互卦
// ============================================================

test('正例: 京房行标了「宫五行 ≠ 上卦五行」, 且带世应爻位', () => {
  const g = ge.castGua('京房', { numbers: [1, 2, 3] });
  const line = gb.buildJingfangLine(g);
  assert.ok(line.indexOf('京房') >= 0, '没有京房宫');
  assert.ok(line.indexOf(g.jingfang.gong + '宫') >= 0, '宫名与起卦结果不符');
  assert.ok(line.indexOf(g.jingfang.gong_wuxing) >= 0, '宫五行与起卦结果不符');
  assert.ok(line.indexOf('世在' + g.jingfang.shi + '爻') >= 0, '世爻位置不符');
  assert.ok(line.indexOf('应在' + g.jingfang.ying + '爻') >= 0, '应爻位置不符');
  // ⚠️ 宫五行与上卦五行在 **32/64 卦**上不同, 这是必须说清的那一句
  assert.ok(line.indexOf('与本卦上卦的五行是两回事') >= 0,
    '没标出宫五行与上卦五行是两回事 —— 模型会把两个五行混着用, 六亲全错且不报错');
});

test('正例: 互卦规则「二三四为下互、三四五为上互」实算 64/64 对账', () => {
  // 这条不是照抄注释, 是**拿真源重算一遍互卦**, 再跟 gua_engine 给的比对。
  // ⚠️ 踩过的坑: `binary` 是**下卦三位‖上卦三位**(自下而上),
  //    而 `index` 才是上卦‖下卦 —— 一开始拿 index 的口径去算, 64/64 全「不符」。
  const arr = HX.HEXAGRAMS || HX.default || HX;
  const byBin = {};
  for (const x of arr) if (x && x.binary) byBin[x.binary] = x.name;
  let checked = 0, bad = 0;
  for (let i = 0; i < 64; i++) {
    const g = ge.castGua('互卦对账', { numbers: [i % 9 + 1, (i * 3) % 9 + 1, (i * 7) % 9 + 1] });
    if (!g.hu_gua) continue;
    const b = g.binary;                    // 下卦‖上卦, 自下而上
    const huBin = (b[1] + b[2] + b[3]) + (b[2] + b[3] + b[4]);   // 下互‖上互
    checked++;
    if (byBin[huBin] !== g.hu_gua.name) bad++;
  }
  assert.equal(checked, 64, '对账样本不足 64');
  assert.equal(bad, 0, '互卦实算与 gua_engine 不符 ' + bad + ' 例 —— 行里那句规则是错的');
});

test('正例: 宫五行与上卦五行确实在 32/64 卦上不同(证明那句警告不是空话)', () => {
  const arr = HX.HEXAGRAMS || HX.default || HX;
  const TRI_WX = { 乾: '金', 兑: '金', 离: '火', 震: '木', 巽: '木', 坎: '水', 艮: '土', 坤: '土' };
  let diff = 0, checked = 0;
  for (const x of arr) {
    if (!x || !x.trigrams) continue;
    const gong = jf.getJingfangGong(x.id);
    const gwx = jf.GONG_WUXING[gong];
    if (!gwx) continue;
    checked++;
    if (TRI_WX[x.trigrams.upper_name] !== gwx) diff++;
  }
  assert.equal(checked, 64, '没能对 64 卦取到京房宫');
  assert.equal(diff, 32,
    '宫五行与上卦五行不同的卦数是 ' + diff + ', 真源记载是 32 —— 数据漂了或判据变了');
});

test('正例: 互卦行进块, 且带卦辞', () => {
  const g = ge.castGua('互卦行', { numbers: [1, 2, 3] });
  const line = gb.buildJingfangLine(g);
  assert.ok(line.indexOf('互卦 ' + g.hu_gua.name) >= 0, '没报出互卦名');
  assert.ok(line.indexOf(g.hu_gua.gua_ci) >= 0, '互卦没带卦辞');
  assert.ok(line.indexOf('二三四爻为下互') >= 0, '没说明互卦怎么取');
  assert.ok(gb.formatGuaFirstBlock(g).indexOf(line) >= 0, '整块里没有京房/互卦行');
});

// ============================================================
// 三、空输入 / 措辞 / 出处链
// ============================================================

test('正例: 京房行取不到数据返回空串; 装卦口径行**该给**——它是卦层通用口径', () => {
  // ⚠️ 这条改过一次断言方向, 记下来免得以后又被改回去:
  //   初版写「`buildZhuangGuaLine({})` 该返回空串」, 红了。
  //   查了实现才明白: **装法口径(内三爻取下卦/外三爻取上卦)与出处分档压根不依赖起卦数据**,
  //   它是纳甲层的**通用口径**, 对每一卦都一样 —— 这正是它该出现在卦块里的理由。
  //   真正随卦变的只有六亲覆盖数, 那半已经单独判空了。
  //   ⇒ 拿「无起卦数据」去要求它返回空串, 等于把通用口径当成随卦数据, 是错的方向。
  for (const bad of [null, undefined]) {
    assert.equal(gb.buildZhuangGuaLine(bad), '', '装卦口径行不该凭空生成');
    assert.equal(gb.buildJingfangLine(bad), '', '京房行不该凭空生成');
  }
  // 京房/互卦确实要起卦数据 ⇒ 空对象就该是空串
  for (const bad of [{}, { jingfang: null }, { hu_gua: null }]) {
    assert.equal(gb.buildJingfangLine(bad), '', '京房行不该凭空生成');
  }
  // 通用口径那半照给, 但**不含**任何随卦内容(不许编六亲覆盖数)
  const zg = gb.buildZhuangGuaLine({});
  assert.ok(zg, '通用装卦口径不该依赖起卦数据');
  assert.ok(zg.indexOf(nj.NAJIA_BASIS.zhuanggua_rule) >= 0, '通用口径里没有装法规则');
  assert.ok(zg.indexOf('爻已装出纳甲干支') < 0, '没有起卦数据却报了六亲覆盖数');
});

test('正例: 本批两行措辞正面式, 不含禁令', () => {
  // 同本文件开头那条教训: 禁令式措辞等于亲手把那个词喂给模型。
  const g = ge.castGua('措辞', { numbers: [1, 2, 3] });
  for (const line of [gb.buildZhuangGuaLine(g), gb.buildJingfangLine(g)]) {
    assert.ok(!/不要|禁止|不许|勿/.test(line), '出现了禁令式措辞: ' + line);
  }
});

test('正例: 本批没把新东西塞进 interpretive(那才需要标签), 出处链仍全绿', () => {
  // 这批补的是**口径**不是**新断语** —— 纳甲/京房/六亲在台账里本来就是 sourced。
  // 若哪天有人把「出处分档」当成 interpretive 塞进来, 这条会拦住(需要标签)。
  const zg = pv.LAYERS['bagua_annotations:najia'];
  const jl = pv.LAYERS['bagua_annotations:jingfang_bagong'];
  const lq = pv.LAYERS['bagua_annotations:liu_qin'];
  for (const L of [zg, jl, lq]) {
    for (const f of L.fields) {
      assert.equal(f.status, 'sourced',
        '纳甲/京房/六亲层里出现了 ' + f.status + ' 的字段「' + f.field + '」'
        + ' —— 若确为整理, 需要身份标签才能进生产');
    }
  }
  const r = pv.assertProvenance();
  assert.deepEqual(r.problems || [], [],
    '出处守卫报了问题:\n  ' + (r.problems || []).join('\n  '));
  assert.equal(r.ok, true);
});

