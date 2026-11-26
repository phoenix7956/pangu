'use strict';
// 五行阴阳合化层**接线**守卫 (2026-10-21, 第十一批之后 / P2-6 收尾)
//
// `wuxing_yinyang.js` 第十批建好之后有个真缺口: 它是**孤岛** ——
// 全仓库只有它自己和那个单测用它, 六格判据层完全不知道「合则不克」这回事。
// 于是老板问的那句「阳火用阴水可能就克不了」, 盘古算得出来,
// 但**排盘结论里看不到**。
// 本批把它接进 judgeRelation → bazi_strength → 工具输出, 并顺手修掉
// countElements 静默返回全 0 的坑, 以及那个「假自检」的 countsTotal。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const WS = require(path.join(CORE, '64i', 'bagua_annotations', 'wuxing_strength.js'));
const WY = require(path.join(CORE, '64i', 'bagua_annotations', 'wuxing_yinyang.js'));
const BS = require(path.join(CORE, 'modules', 'bazi_strength.js'));

/** 造一份能过 judgeFromChart 的排盘 JSON */
function chartOf(dayMaster, dayMasterWuxing, yy) {
  return {
    pillars: { 年柱: '辛未', 月柱: '己亥', 日柱: dayMaster + '酉', 时柱: '甲辰' },
    day_master: dayMaster,
    day_master_wuxing: dayMasterWuxing,
    day_master_yinyang: yy,
    status: '中和',
    xi_yong: ['火'],
    ji_shell: ['木'],
    month_branch: '亥',
    month_benqi: '己',
    wuxing_count: {},
  };
}

// ============================================================
test('接线: judgeRelation 的 polarity 带上 heGans', () => {
  const r = WS.judgeRelation('火', '水', { counts: { 火: 2, 水: 2 }, selfGan: '丁' });
  assert.ok(Array.isArray(r.polarity.heGans), 'heGans 必须是数组');
  assert.equal(r.polarity.heGans.length, 1, '丁火日主 + 水格 → 只有壬被合住');
  assert.equal(r.polarity.heGans[0].gan, '壬');
  assert.equal(r.polarity.heGans[0].pair, '丁壬');
  assert.equal(r.polarity.heGans[0].hua, '木');
});

test('接线: 换成丙火, 水格就不该有合 (丙癸不是五合)', () => {
  const r = WS.judgeRelation('火', '水', { counts: { 火: 2, 水: 2 }, selfGan: '丙' });
  assert.deepStrictEqual(r.polarity.heGans, [],
    '丙火 + 水格: 壬癸两支都真克, 不该有任何合');
});

test('接线: 同一个「克我者(水)」格, 丁主与丙主的读法必须不同', () => {
  const ding = WS.judgeRelation('火', '水', { counts: { 火: 2, 水: 2 }, selfGan: '丁' });
  const bing = WS.judgeRelation('火', '水', { counts: { 火: 2, 水: 2 }, selfGan: '丙' });
  assert.equal(ding.relation, bing.relation, '五行层关系一样(都是克我)');
  assert.equal(ding.strength, bing.strength, '旺衰层强度一样(分量相同)');
  assert.notDeepStrictEqual(ding.polarity.heGans, bing.polarity.heGans,
    '阴阳层必须给出不同的结论 —— 这正是本批接线的全部意义');
});

test('纯增量: strength / relation 一个取值都没被改', () => {
  // 合不该改旺衰判据, 只该挂出独立信息。所以这里把具体值钉死。
  const r = WS.judgeRelation('火', '水', { counts: { 火: 2, 水: 2 }, selfGan: '丁' });
  assert.equal(r.relation, 'ke', '丁火看水 = 克我者');
  assert.equal(r.strength, 'weak', '水有 2 个 → weak (阈值 3 以上才是 strong)');
});

test('纯增量: 没有日主天干时不硬编 (heGans 干脆不出现)', () => {
  const r = WS.judgeRelation('火', '水', { counts: { 火: 2, 水: 2 } });
  assert.equal(r.polarity, null, '没有 selfGan 就整个 polarity 不该出现');
});

// ============================================================
test('接线: formatConclusion 把「不参与克我」印出来', () => {
  const text = BS.formatConclusion(BS.judgeFromChart(chartOf('丁', '火', '阴')));
  assert.match(text, /克我者\(水\)/, '水格必须出现');
  assert.match(text, /壬 与日主相合, 不参与克我/,
    '「壬被合住」必须**说给模型听**, 否则它会当成壬癸一起来克');
});

test('接线: 换成丙日主, 同一句话不该出现', () => {
  const text = BS.formatConclusion(BS.judgeFromChart(chartOf('丙', '火', '阳')));
  assert.doesNotMatch(text, /不参与克我/, '丙火 + 水格: 没有合, 不该编出来');
});

test('接线: formatJudgement 也印合(带化合五行)', () => {
  const text = BS.formatJudgement(BS.judgeFromChart(chartOf('丁', '火', '阴')));
  assert.match(text, /丁壬合木/, '要带化合出的五行, 不只是"被合住"');
});

// ============================================================
test('顺手修: countElements 认数组(我写夹具时踩到)', () => {
  const byArr = BS.countElements(['庚午', '丙子', '丁卯', '戊辰']);
  const byObj = BS.countElements({ 年柱: '庚午', 月柱: '丙子', 日柱: '丁卯', 时柱: '戊辰' });
  assert.deepStrictEqual(byArr, byObj, '两种形状必须算出同一个结果');
  assert.equal(Object.values(byArr).reduce((a, b) => a + b, 0), 8);
});

test('顺手修: 认不出的形状**响亮报错**, 不许静默返回全 0', () => {
  // 旧行为: 返回全 0 → 六格全判「不成立」→ 输出一份看起来完全正常的错判断。
  assert.throws(() => BS.countElements(['庚午', '丙子']), /长度应为 4/);
  assert.throws(() => BS.countElements({ foo: 1 }), /认不出 pillars 的形状/);
});

test('顺手修: countsTotal 那个「自检」以前是假的 —— 现在是真的', () => {
  // 文档写着「合计应为 8, 用于自检」, 但以前**从没被检查过**。
  const good = BS.judgeFromChart(chartOf('丁', '火', '阴'));
  assert.equal(good.countsTotal, 8);
  assert.equal(good.countsOk, true);
  assert.doesNotMatch(BS.formatConclusion(good), /⚠️/, '柱齐的时候不该有警告');
});

// ============================================================
test('边界: 没有循环依赖, 依赖方向单一', () => {
  // wuxing_strength → wuxing_yinyang → ten_gods。不许反向。
  const st = fs.readFileSync(
    path.join(CORE, '64i', 'bagua_annotations', 'wuxing_strength.js'), 'utf8');
  assert.match(st, /require\(path\.join\(__dirname, 'wuxing_yinyang\.js'\)\)/);
  const wy = fs.readFileSync(
    path.join(CORE, '64i', 'bagua_annotations', 'wuxing_yinyang.js'), 'utf8');
  // 只看**代码**: 文件头的「分层纪律」注释里就写着 wuxing_strength.js,
  // 那是说明依赖方向的文档, 不是依赖。不剥注释就会自己把自己判成循环依赖
  // (跟 skill_runtime 那条自检踩的是同一个坑)。
  const wyCode = wy.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(wyCode, /wuxing_strength/, '反向了就是循环依赖');
});

test('边界: 五合真源仍然只有一处', () => {
  // getHe 只在 wuxing_yinyang.js 里实现; wuxing_strength 只读它。
  const st = fs.readFileSync(
    path.join(CORE, '64i', 'bagua_annotations', 'wuxing_strength.js'), 'utf8');
  assert.doesNotMatch(st, /['"](甲己|乙庚|丙辛|丁壬|戊癸)['"]\s*:/,
    '五合表又被抄了一份 —— 一份东西抄两遍 = 迟早只改其中一份');
  assert.equal(typeof WY.getHe, 'function');
});
