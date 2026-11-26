'use strict';
// 2026-10-21 第六批「两把刀合一」的守卫。
//
// 改的是什么: chart_answer_gate 原来**从答案自己**里抽四柱当核验基准 ——
// 也就是拿答案验答案。两种翻车都实测过:
//   ① 抽错盘 (全文散着干支时抓到流年/别处的干支当本命柱)
//   ② 抽不出 (首轮纯图题答案没抄全四柱 → 门直接不响, 模型的错没人拦)
// 现在改成: 有 bazi_calc 的 sxtwl 权威盘就用它当基准, 没有才退回旧的抽法。
// 同时把 chart_fidelity 的柱位保真从「只留痕」接进「能改答案」——
// 但只在有权威盘时, 且**多张盘同轮一律不判** (合婚/双人对比: 单盘的尺子量不了两盘答案)。
//
// 本文件锁三件事:
//   ① 形状: 三种工具记录形状都要能读 (换一条路就静默失效, 是最贵的失效)
//   ② 行为: 权威盘能抓到答案里的十神错 + 柱位错; 流年/大运不误报
//   ③ 接线: 每个调用点都真传了证据 (同义接线多份 = 迟早只改其中一处)
//
// 夹具里的十神**是从 ten_gods.js 量出来的**, 不是我脑补的:
//   日主戊土 → 甲七杀 乙正官 丙偏印 丁正印 己劫财 庚食神 辛伤官 壬偏财 癸正财
//   (我第一版写"庚=偏财 己=比肩", 两个都错 —— 夹具带错真值, 测试就会因为错误的原因通过)
const CF = require('../modules/chart_fidelity.js');
const GATE = require('../modules/chart_answer_gate.js');
const fs = require('fs');
// 2026-10-23 第 61 批: 读源码做断言时**剥掉注释** ——
//   我在 dispatcher 的注释里引用了旧代码原句(await _factGate(_stripHistoryLeak(...))),
//   直接读全文的断言会扫到注释, 于是「老形状不许回来」被自己写的注释判红。
//   本项目反复踩的坑: **扫源码 ≠ 扫代码**。注释里提到 ≠ 代码里存在。
const readCode = (abs) => fs.readFileSync(abs, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const path = require('path');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.log('  ❌ ' + name + '  →  ' + e.message); fail++; }
}
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ', 实得 ' + JSON.stringify(a)); }
function ok(v, msg) { if (!v) throw new Error(msg || '断言失败'); }

// 1990-7-22 14:00 女 → sxtwl 实排 庚午 癸未 戊子 己未
const PILLARS = { 年柱: '庚午', 月柱: '癸未', 日柱: '戊子', 时柱: '己未' };
const mkChart = (p) => ({ ok: true, data: { pillars: { pillars: p } } });
const CHART_A = mkChart(PILLARS);
const CHART_B = mkChart({ 年柱: '甲子', 月柱: '乙丑', 日柱: '丙寅', 时柱: '丁卯' });

// 三种形状, 各自的生产者不同 (照抄生产形状, 别在测试里自造一种)
const SHAPE_SUBAGENT = [{ name: 'bazi_calc', ok: true, args: {}, result: CHART_A }];                     // sub-agent.js toolHistory
const SHAPE_LOOP = [{ tc: { name: 'bazi_calc', params: {} }, execResult: CHART_A }];                    // j2_agent_loop toolResults
const SHAPE_EXECUTOR = [{ name: 'bazi_calc', ok: true, content: JSON.stringify(CHART_A).slice(0, 4000) }]; // _j2ExecuteToolCalls 返回 (只有截断字符串)

async function main() {
  console.log('\n--- 工具记录的三种形状 ---');
  await t('① sub-agent 形状 / ② j2 loop 形状 都能读出权威盘', () => {
    eq(CF.collectAuthoritativeCharts(SHAPE_SUBAGENT).length, 1, '形状①');
    eq(CF.collectAuthoritativeCharts(SHAPE_LOOP).length, 1, '形状②');
    eq(CF.collectAuthoritativeCharts(SHAPE_SUBAGENT)[0].月柱, '癸未');
    eq(CF.collectAuthoritativeCharts(SHAPE_LOOP)[0].月柱, '癸未');
  });
  await t('③ executor 形状只有截断字符串 → 不判 (从半个 JSON 反解出的盘比没有更坏)', () => {
    eq(CF.collectAuthoritativeCharts(SHAPE_EXECUTOR).length, 0);
  });
  await t('同一盘算两次只算一张 (模型重试不是两张盘)', () => {
    eq(CF.collectAuthoritativeCharts([...SHAPE_SUBAGENT, ...SHAPE_LOOP]).length, 1);
  });
  await t('算出两张不同的盘 → 返回 2, 由调用方决定不判', () => {
    eq(CF.collectAuthoritativeCharts([{ name: 'bazi_calc', ok: true, result: CHART_A }, { name: 'bazi_calc', ok: true, result: CHART_B }]).length, 2);
  });
  await t('bazi_calc 失败 / 缺柱 / 不是排盘工具 → 不算盘', () => {
    eq(CF.collectAuthoritativeCharts([{ name: 'bazi_calc', ok: false, result: CHART_A }]).length, 0);
    eq(CF.collectAuthoritativeCharts([{ name: 'bazi_calc', ok: true, result: mkChart({ 年柱: '庚午', 月柱: '癸未', 日柱: '戊子' }) }]).length, 0);
    eq(CF.collectAuthoritativeCharts([{ name: 'exec_command', ok: true, result: CHART_A }]).length, 0);
  });
  await t('check: 两张盘时退回不判 (单盘的尺子量不了两盘答案)', () => {
    const r = CF.check('甲盘年甲子, 乙盘年丙寅', [{ name: 'bazi_calc', ok: true, result: CHART_A }, { name: 'bazi_calc', ok: true, result: CHART_B }]);
    eq(r.applicable, false);
    eq(r.mismatches.length, 0);
  });

  console.log('\n--- 柱位的两种写法都得认 (E2E 实跑撞出来的) ---');
  // E2E 2026-10-21: 模型写的是后缀写法「庚午年 癸未月 戊子日 己未时」,
  // 只认前缀的核对把它读成"年柱癸未/月柱戊子/日柱己未" —— 一张**完全正确**的盘
  // 被判成三条硬伤, 白花一次重修还在正确答案尾巴上挂了 ⚠️。
  // 误伤比漏检贵: 守卫把对的判成错的, 就再也没人信它了。
  await t('后缀写法 (庚午年 癸未月 戊子日 己未时) → 四柱全对, 不误伤', () => {
    const r = CF.check('**四柱**：庚午年 癸未月 戊子日 己未时  日主戊土。大运逆排：壬午 → 辛巳 → 庚辰。地支关系：午未六合（年月）；子未相害。2026 年流年丙午。', SHAPE_SUBAGENT);
    eq(r.checked, 4, '四处柱位都要核到');
    eq(r.mismatches.length, 0, '误伤: ' + JSON.stringify(r.mismatches));
  });
  await t('后缀写法里真写错 → 照样抓到 (月柱辛未)', () => {
    const r = CF.check('四柱：庚午年 辛未月 戊子日 己未时，日主戊土。', SHAPE_SUBAGENT);
    eq(r.mismatches.length, 1, JSON.stringify(r.mismatches));
    eq(r.mismatches[0].position, '月柱');
    eq(r.mismatches[0].expected, '癸未');
  });
  await t('前缀/后缀混用互不打架 (各读各的, 不重复计)', () => {
    const r = CF.check('年庚午, 月癸未, 戊子日, 己未时', SHAPE_SUBAGENT);
    eq(r.checked, 4);
    eq(r.mismatches.length, 0);
  });
  await t('大运列表里的「壬午年/辛巳年」不是本命年柱', () => {
    eq(CF.check('大运壬午年 4岁起运, 辛巳年 14岁', SHAPE_SUBAGENT).mismatches.length, 0);
    eq(CF.check('大运壬午年 4岁起运。四柱：庚午年 癸未月 戊子日 己未时。', SHAPE_SUBAGENT).mismatches.length, 0,
      '大运那句不许把下一句的本命四柱一起吞掉');
  });
  await t('gate: 后缀写法走一遍完整门 → 零矛盾零 LLM 调用 (E2E 那道题的复现)', async () => {
    let calls = 0;
    const r = await GATE.verifyAndRepairChartAnswer(
      '**四柱**：庚午年 癸未月 戊子日 己未时  日主戊土（阳），生于未月。大运逆排约4岁11月起运：壬午 → 辛巳 → 庚辰 → 己卯。',
      async () => { calls++; return 'x'.repeat(80); },
      SHAPE_SUBAGENT
    );
    eq(r.source, 'sxtwl');
    eq(r.contradictions.length, 0, '这张盘是全对的, 不该有硬伤: ' + JSON.stringify(r.contradictions));
    eq(calls, 0);
  });

  console.log('\n--- 出门核验门吃权威盘 ---');
  // 答案里**不抄四柱**也照样被抓 —— 这正是原来的洞 (首轮纯图题: 门直接不响)
  await t('答案没抄四柱也能抓十神错 (戊土日主, 庚金是食神不是七杀)', async () => {
    const r = await GATE.verifyAndRepairChartAnswer(
      '日主戊土, 年干庚金是七杀, 全局金旺无制, 走七杀路线。',
      async () => '日主戊土, 年干庚金为食神, 食神泄秀不走七杀, 后面补几句保持结构不变的话, 让这段过长度闸。',
      SHAPE_SUBAGENT
    );
    eq(r.source, 'sxtwl', '基准应来自权威盘');
    eq(r.checked, true, '应进入核验');
    eq(r.contradictions.length, 1, '应只抓到这一处: ' + JSON.stringify(r.contradictions));
    eq(r.repaired, true);
    eq(r.residual, undefined, '重修稿已对, 不该有残余');
  });
  await t('答案没问题 → 核验通过, 零 LLM 调用', async () => {
    let calls = 0;
    const r = await GATE.verifyAndRepairChartAnswer(
      '年庚午, 月癸未, 日戊子, 时己未。日主戊土, 年干庚金为食神, 时干己为劫财。2026 年流年丙午, 大运走甲子, 纳音白蜡金。',
      async () => { calls++; return ''; },
      SHAPE_SUBAGENT
    );
    eq(r.source, 'sxtwl');
    eq(r.checked, true);
    eq(r.contradictions.length, 0, '误报: ' + JSON.stringify(r.contradictions));
    eq(calls, 0, '答对了不许多花 LLM 调用');
  });
  await t('柱位被改写 (月柱写成辛未) → 当硬伤进重修', async () => {
    const r = await GATE.verifyAndRepairChartAnswer(
      '年庚午, 月辛未, 日戊子, 时己未。日主戊土, 年干庚金为食神。',
      async () => '年庚午, 月癸未, 日戊子, 时己未。日主戊土, 年干庚金为食神, 补足后续判断。',
      SHAPE_SUBAGENT
    );
    eq(r.contradictions.length, 1, '应只报柱位这一处: ' + JSON.stringify(r.contradictions));
    ok(/月柱/.test(r.contradictions[0].claim), '应报月柱: ' + JSON.stringify(r.contradictions));
    ok(/癸未/.test(r.text), '重修稿应带正确的月柱');
    eq(r.source, 'sxtwl');
  });
  await t('流年/大运/纳音里的干支不误报', async () => {
    let calls = 0;
    const r = await GATE.verifyAndRepairChartAnswer(
      '年庚午, 月癸未, 日戊子, 时己未。日主戊土。2026 年流年丙午, 大运走甲子, 纳音白蜡金。',
      async () => { calls++; return ''; },
      SHAPE_SUBAGENT
    );
    eq(r.contradictions.length, 0, '误报: ' + JSON.stringify(r.contradictions));
    eq(calls, 0);
  });
  await t('重修稿还留错柱 → 附诚实标注出门, 不许带病静默交付', async () => {
    const r = await GATE.verifyAndRepairChartAnswer(
      '年庚午, 月辛未, 日戊子, 时己未。日主戊土, 年干庚金为食神。',
      async () => '年庚午, 月辛未, 日戊子, 时己未。日主戊土, 年干庚金为食神。后面补几句保持结构不变的话, 让这段过长度闸。',
      SHAPE_SUBAGENT
    );
    eq(r.repaired, true, '应判已重修');
    eq(r.residual.length, 1, '残余应只剩错柱那一处: ' + JSON.stringify(r.residual));
    ok(/⚠️/.test(r.text), '应附诚实标注');
  });
  await t('两张盘同轮 → 不走权威盘 (不拿单盘硬量两盘)', async () => {
    const two = [{ name: 'bazi_calc', ok: true, result: CHART_A }, { name: 'bazi_calc', ok: true, result: CHART_B }];
    const r = await GATE.verifyAndRepairChartAnswer(
      '甲盘: 庚午 癸未 戊子 己未; 乙盘: 甲子 乙丑 丙寅 丁卯。日主戊土, 年干庚金为食神。',
      async () => 'x'.repeat(80),
      two
    );
    ok(r.source !== 'sxtwl', '两张盘时不得宣称用权威盘, 实得 ' + r.source);
    eq(r.contradictions.length, 0, '退回旧路也不该凭空报: ' + JSON.stringify(r.contradictions));
  });
  await t('没有工具结果 → 旧行为不变 (追问轮靠答案里的四柱)', async () => {
    const r = await GATE.verifyAndRepairChartAnswer(
      '四柱: 庚午 癸未 戊子 己未, 日主戊土, 年干庚金为七杀。',
      async () => '四柱: 庚午 癸未 戊子 己未, 日主戊土, 年干庚金为食神。后面补几句保持结构不变的话, 让这段过长度闸。',
      undefined
    );
    eq(r.checked, true, '应仍然核验');
    eq(r.contradictions.length, 1, '应抓到硬伤: ' + JSON.stringify(r.contradictions));
    eq(r.source, 'answer');
  });
  await t('没有工具结果 + 答案里没四柱 → 不判 (不误伤)', async () => {
    const r = await GATE.verifyAndRepairChartAnswer('今天天气不错, 要不要出门?', async () => 'x'.repeat(80), []);
    eq(r.checked, false);
    eq(r.source, 'none');
  });
  await t('工具结果形状不对 (不是数组) → 不炸, 不判', async () => {
    const r = await GATE.verifyAndRepairChartAnswer('随便一句话, 没有盘。', async () => 'x', { junk: 1 });
    eq(r.checked, false);
  });

  console.log('\n--- 接线守卫: 每个调用点都得真传证据 ---');
  await t('j2_dispatcher 的 5 个定稿收口都带证据', () => {
    const src = readCode(path.join(__dirname, '..', 'modules', 'j2_dispatcher.js'));
    // 2026-10-23 第 61 批: 定稿收口从 `await _factGate(剥泄漏(对齐门(剥思维链(x))))`
    //   收成了 `await _finalize(x, evidence)` —— 顺序成了 final_pipeline 里一个函数的行为。
    // 2026-10-23 第 65 批: 公共 5 步收进 `_synthesizeAndFinalize` —— 「五处各写一遍
    //   `await _finalize(x, evidence)`」这个份数没了, 但**每条交付路仍都得带证据过门**。
    //   判据没放松: 改成钉机制 —— 每条交付出口都得走到那个统一实现。
    // 2026-10-24 第 77 批: 多了一条「澄清」交付路 (主 agent 判指代不明 ⇒ 把反问交回主人)。
    //   它**没有**排盘证据 —— 那一轮根本没派子 agent, 没有 bazi_calc 就没有权威盘。
    //   所以它必须显式传 `[]` (「没有证据」), 而不是**忘了传** (undefined)。
    //   判据因此不许写成「只要传了就算」: 三条路各传什么, 一条一条点名。
    const calls = src.split('\n').filter(l => l.includes('await _finalize('));
    eq(calls.length, 3, '调用点数量变了(1 处直答 + 1 处统一实现 + 1 处澄清), 重新数一遍: ' + calls.length);
    const _countBy = (re) => calls.filter(c => re.test(c)).length;
    eq(_countBy(/,\s*_daHistory\s*\)/), 1, '直答那条必须传 _daHistory (子 agent 的工具结果)');
    eq(_countBy(/,\s*_chartEvidenceFrom\(results\w*\)\s*\)/), 1, '统一实现那条必须传 _chartEvidenceFrom(results)');
    eq(_countBy(/,\s*\[\]\s*,/), 1, '澄清那条必须**显式**传空证据 [] (本轮没派子 agent, 没有权威盘) —— 不是忘了传');
    const { finalizeCoverage } = require('./helpers/dispatcher_exits');
    const _cov = finalizeCoverage();
    ok(_cov.all('_finalize'),
      '有交付出口没过定稿流水线: ' + _cov.uncovered('_finalize').map((e) => 'L' + e.line).join(', '));
    // 有调用点绕过定稿流水线直接过门 ⇒ 剥【上文】块和对齐门被跳过了。
    ok(!/await _factGate\(/.test(src), '有调用点绕过定稿流水线直接过门 —— 剥泄漏和对齐门被跳过');
  });
  await t('卦象门跟命盘门在**同一道**出门闸里 (第九批)', () => {
    const src = readCode(path.join(__dirname, '..', 'modules', 'j2_dispatcher.js'));
    ok(!/_chartGate/.test(src), '还留着旧名 _chartGate —— 改名没改干净');
    ok(/require\('\.\/answer_gates'\)/.test(src), '_factGate 没走唯一编排 answer_gates');
    // 第 60 批之后, 「两道门在同一道闸 / 串成一条链 / 卦象门独立 try」这三条
    //   在本文件、gua-answer-gate、toolmarkup-chartfacts 里各存了一份扫源码断言。
    //   编排搬家一次要改三处 —— 这就是「两份同义文本各改各的」长在测试层。
    //   现已收成唯一一份: tests/answer-gates-single-impl-20261023.test.js
    //     A1 唯一实现 / A2 dispatcher 五处调用点 / B1 真跑一遍验顺序与入参
    //     C1 一道门炸了另一道照跑且交付不丢 (比「扫到独立 try」强 — 它真的抛一次试试)
    //     负例 顺序反过来 / 日志条件退回 / ask 多传参 / 门异常吞交付, 各一条
    // 本文件只留「门自己的判定逻辑」那部分 —— 那是它独有的职责。
  });
  await t('j2 loop 出门核验门拿的是排盘证据, 不是空数组', () => {
    const src = readCode(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'));
    // 第 60 批: loop 不再自己调门, 改成把证据交给唯一编排。
    ok(/runAnswerGates\(finalText[\s\S]{0,400}?chartEvidence:\s*_chartEvidence\s*[,}]/.test(src),
      'legacy loop 没把 _chartEvidence 传给核验门');
    ok(/_recordChartEvidence\s*=\s*\(name, result\)/.test(src), '排盘证据留存函数不在');
    ok(/onResult: _recordChartEvidence/.test(src), 'executor 没把真结果送出来 (content 是截断字符串, 反解不出盘)');
  });
  await t('executor 的 onResult 回调真被调用 (旁路断了就是白接线)', () => {
    const src = readCode(path.join(__dirname, '..', 'pangu-single.js'));
    const hits = src.split('\n').filter(l => l.includes('_onResult(tc.name, execResult)'));
    eq(hits.length, 2, '并行批处理 + 串行两条真调用路径都要接, 实得 ' + hits.length);
  });

  console.log('\n============================================================');
  console.log('测试结果：' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
  console.log('============================================================');
  if (fail > 0) process.exit(1);
}

main();
