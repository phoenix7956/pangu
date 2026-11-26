'use strict';
// 2026-10-21 E2E 实跑第 6 轮逼出来的守卫。
//
// 现场那一轮, 工具给的盘是 庚午/癸未/戊子/己未, 模型答成
// 「年 庚午 ｜ 月 辛未 ｜ 日 戊子？ ｜ 时 辛未」—— 月柱时柱双双编错, 无任何拦截。
// 本文件锁两件事:
//   ① 该抓的抓到 (真盘被改写必须报出来)
//   ② 不该抓的不抓 (流年/大运/纳音/普通散文里的干支全是误报高发区)
// 误报比漏报更贵: 守卫一旦撒谎就没人再信它 —— 这是 grounding_check 立时就写下的规矩。
const CF = require('../modules/chart_fidelity.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.log('  ❌ ' + name + '  →  ' + e.message); fail++; }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ', 实得 ' + JSON.stringify(a));
}
function ok(v, msg) { if (!v) throw new Error(msg || '断言失败'); }

// 1990-7-22 14:00 女 → sxtwl 实排 庚午 癸未 戊子 己未
const TOOLS = [{
  name: 'bazi_calc', ok: true,
  result: { ok: true, data: { pillars: { pillars: { 年柱: '庚午', 月柱: '癸未', 日柱: '戊子', 时柱: '己未' } } } },
}];

console.log('\n--- 取权威四柱 ---');
t('从 bazi_calc 结果里抠出四柱', () => {
  const p = CF.extractAuthoritativePillars(TOOLS);
  eq(p.年柱, '庚午'); eq(p.月柱, '癸未'); eq(p.日柱, '戊子'); eq(p.时柱, '己未');
});
t('没有 bazi_calc → 不判 (不拿排盘的尺子量所有问题)', () => {
  eq(CF.extractAuthoritativePillars([{ name: 'exec_command', ok: true, result: {} }]), null);
  eq(CF.extractAuthoritativePillars([]), null);
  eq(CF.extractAuthoritativePillars(undefined), null);
});
t('bazi_calc 失败 / 四柱不全 → 不判 (宁可漏报不要误报)', () => {
  eq(CF.extractAuthoritativePillars([{ name: 'bazi_calc', ok: false, result: {} }]), null);
  eq(CF.extractAuthoritativePillars([{
    name: 'bazi_calc', ok: true,
    result: { data: { pillars: { pillars: { 年柱: '庚午', 月柱: '癸未' } } } },
  }]), null, '只有两柱时');
});

console.log('\n--- 该抓的 ---');
t('★ E2E 实跑那一句原样喂进去, 月柱时柱两处都要报出来', () => {
  const r = CF.check('- 年 庚午 ｜ 月 辛未 ｜ 日 戊子？→ 实为 **戊日** ｜ 时 **辛未**（未时）', TOOLS);
  ok(r.applicable);
  eq(r.mismatches.length, 2, '应报出两处');
  const m = {};
  for (const x of r.mismatches) m[x.position] = x;
  eq(m.月柱.said, '辛未'); eq(m.月柱.expected, '癸未');
  eq(m.时柱.said, '辛未'); eq(m.时柱.expected, '己未');
  eq(r.checked, 4, '四处柱位都该核');
});
t('柱位全部写对 → 零错报', () => {
  const r = CF.check('年柱 庚午、月柱 癸未、日柱 戊子、时柱 己未。日主戊土生于未月。', TOOLS);
  eq(r.mismatches.length, 0, JSON.stringify(r.mismatches));
  ok(r.checked >= 4);
});
t('markdown 表格按列排, 位置词与干支不同格 → 核不了就不核 (不硬猜第几列)', () => {
  // 这不是 bug 是边界: 表格里没有"月柱=癸未"这种位置绑定, 靠列序猜就是在赌。
  // 赌赢了也不算数 —— 判据必须只认**写明了的**绑定。
  const r = CF.check('| 年柱 | 月柱 | 日柱 | 时柱 |\n|---|---|---|---|\n| 庚午 | 癸未 | 戊子 | 己未 |', TOOLS);
  eq(r.mismatches.length, 0, '表格不该被判成错');
});
t('带"柱"字和冒号的写法照样核得到', () => {
  const r = CF.check('月柱：辛亥。', TOOLS);
  eq(r.mismatches.length, 1);
  eq(r.mismatches[0].position, '月柱');
  eq(r.mismatches[0].said, '辛亥');
});

console.log('\n--- 不该抓的 (误报区) ---');
t('★ 流年干支不是本命柱 —— 2026 丙午 不该被判成年柱', () => {
  const r = CF.check('当前流年：2026年 丙午，2027 丁未，2028 戊申。', TOOLS);
  eq(r.mismatches.length, 0, JSON.stringify(r.mismatches));
});
t('流年不带年份前缀但带"流年"二字 —— 放行', () => {
  const r = CF.check('流年 丙午、丁未两年最要注意。', TOOLS);
  eq(r.mismatches.length, 0, JSON.stringify(r.mismatches));
});
t('大运干支不是本命柱', () => {
  const r = CF.check('大运 壬午(4.96)→辛巳(14.96)→庚辰(24.96)→己卯(34.96)。', TOOLS);
  eq(r.mismatches.length, 0, JSON.stringify(r.mismatches));
});
t('流月/太岁/纳音/卦象语境放行', () => {
  const r = CF.check('太岁在甲辰年；纳音覆灯火；卦得乾为天。', TOOLS);
  eq(r.mismatches.length, 0, JSON.stringify(r.mismatches));
});
t('散文里偶然出现的单字不成干支, 不该报', () => {
  const r = CF.check('日主戊土，得月令未土之助，年月时三透庚辛。', TOOLS);
  eq(r.mismatches.length, 0, JSON.stringify(r.mismatches));
});
t('数字紧挨着的月份不算柱位 (3月 辛未 是月份不是月柱)', () => {
  const r = CF.check('生于3月 辛未那天。', TOOLS);
  eq(r.mismatches.length, 0, JSON.stringify(r.mismatches));
});
t('空文本不炸', () => {
  const r = CF.check('', TOOLS);
  eq(r.applicable, true); eq(r.checked, 0); eq(r.mismatches.length, 0);
  eq(CF.check(null, TOOLS).mismatches.length, 0);
});
t('describe 文案: 有错报要指名道姓, 没错报要说清核过几处', () => {
  const good = CF.describe(CF.check('月柱 癸未。', TOOLS));
  ok(/全部与 sxtwl 排盘一致/.test(good), good);
  const bad = CF.describe(CF.check('月柱 辛亥。', TOOLS));
  ok(/月柱 写成 辛亥/.test(bad) && /真值 癸未/.test(bad), bad);
  eq(CF.describe(CF.check('随便什么', [])), '', '没 bazi_calc 时不产出文案');
});

console.log('\n============================================================');
console.log('测试结果：' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
console.log('============================================================');
if (fail > 0) process.exit(1);
