'use strict';
// 2026-10-12 回归: 老板实测反馈「感觉有点问题」(会话 desktop-1791787104119, 根修后第一轮实测)。
// 两个新问题, 每个都是机制级修复:
//
// ④ MiniMax 原生哨兵 token 泄漏 —— analyzer 输出
//      <tool name="web_search">{"q":"...关系]<]minimax[>[</q>]<]minimax[>[</invoke>兆
//    没有 </tool> 收尾, 解析器三种形态都不认 → 工具没执行 + 整段原始标记漏进 summary 上屏。
//    修: extractToolCalls 先剔 <]minimax[> / [</q>] 残片, 再加"无收尾块兜底"
//    (平衡括号扫 JSON; 尾巴被哨兵吃掉的自动补引号补括号救一次);
//    收口文本改走 stripToolMarkup (闭合块/残段/哨兵一起剥)。
//
// ⑤ 十神/五行/刑冲合害是查表题, 但 LLM 在凭记忆算 —— 推出"土印、庚金七杀、印旺生身"三连错
//    (戊=伤官不是印; 庚=正财不是七杀; 原局木=0 不可能印旺)。
//    修: bazi_chart_facts.js — 文本里出现四柱就本地确定性计算事实块注入 userInput,
//    主 loop / 子 agent / 综合 LLM 都拿得到; 64i/bazi/zhis_relations.js 的三刑检测
//    暗死 bug (子卯刑用 pair 字段, 代码只读 trio → TypeError) 一并修。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const sa = require('../agents/sub-agent');
const facts = require('../modules/bazi_chart_facts');
const { _buildHistoryBlock } = require('../modules/j2_dispatcher');

// 2026-10-23 第 61 批: 剥掉注释再给断言扫 ——
//   本文件里我在注释里引用了旧代码原句(`await _factGate(_stripHistoryLeak(...))`),
//   而 SRC 原来直接读全文, 于是「老形状不许回来」那条断言扫到了**注释**。
//   这就是本项目反复踩的坑: **扫源码 ≠ 扫代码**。注释里提到 ≠ 代码里存在。
const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// ④ MiniMax 哨兵泄漏: 实案原文必须解析出 web_search 调用, 收口文本剥干净
// ─────────────────────────────────────────────────────────────────────────────
const _LEAKED = '<tool name="web_search">{"q":"八字 子午冲 子丑合 午未合 未丑冲 关系]<]minimax[>[</q>]<]minimax[>[</invoke>兆';
const _rescued = sa.extractToolCalls(_LEAKED, new Set(['web_search', 'bazi_calc']));
assert.ok(_rescued.length === 1 && _rescued[0].name === 'web_search'
  && typeof _rescued[0].args.q === 'string' && _rescued[0].args.q.includes('子午冲'),
  '④ 哨兵泄漏的实案原文必须救出 web_search 调用 — 救不出 = 工具空转 + 标记上屏');
assert.ok(!_rescued[0].args.q.includes('minimax') && !_rescued[0].args.q.includes('invoke'),
  '④a 救出的参数必须剔掉哨兵残片 — 残片进 query 会污染搜索结果 (实案搜回"国产成人"类垃圾)');

const _stripped = sa.stripToolMarkup(_LEAKED);
assert.ok(!_stripped.includes('<tool') && !_stripped.includes('minimax') && !_stripped.includes('invoke'),
  '④b stripToolMarkup 必须把无收尾残段+哨兵残片剥干净, 一个字都不许漏上屏');

// 既有三形态不许破
const _known = new Set(['bazi_calc']);
assert.strictEqual(sa.extractToolCalls('<tool name="bazi_calc">{"year":1978}</tool>', _known)[0].name, 'bazi_calc', '④c named 形态回归');
assert.strictEqual(sa.extractToolCalls('<tool_call>{"name":"bazi_calc","arguments":{"year":1978}}</tool_call>', _known)[0].name, 'bazi_calc', '④d JSON 信封回归');
assert.strictEqual(sa.extractToolCalls('<bazi_calc>{"year":1978}</bazi_calc>', _known)[0].name, 'bazi_calc', '④e 裸标签形态回归');
// 正常正文里的 HTML 不许被误剥
assert.ok(sa.stripToolMarkup('正文 <b>加粗</b> 保留').includes('<b>加粗</b>'), '④f 正文 HTML 不误伤');

// 接线契约: runAgentLoop 的收口必须走 stripToolMarkup
const _saSrc = SRC('agents/sub-agent.js');
assert.ok(_saSrc.includes('cleanText = stripToolMarkup(text)'), '④g 收口必须走 stripToolMarkup — 改回裸正则就漏残段');

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 四柱已知 → 十神/五行/合冲由本地查表注入
// ─────────────────────────────────────────────────────────────────────────────
const _block = facts.buildFactsFromConversation('分析原局; 分析流年大运, 结合刑冲', [
  { role: 'assistant', content: '命局：戊午 / 己未 / 丁丑 / 庚子，丁火日主生未月, 火土已燥旺' },
]);
assert.ok(_block.includes('时干庚=正财'), '⑤ 庚金是正财 — 实案错成"七杀"');
assert.ok(_block.includes('年干戊=伤官') && _block.includes('月干己=食神'), '⑤b 戊己土是食伤 — 实案错成"土印"');
assert.ok(_block.includes('木0'), '⑤c 五行计数木=0 — "印旺生身"直接违反此事实');
assert.ok(_block.includes('午未合') && _block.includes('子丑合') && _block.includes('丑未冲'), '⑤d 地支关系查表结果');
assert.ok(_block.includes('禁止凭记忆另算十神'), '⑤e 事实块必须带"不许凭记忆另算"纪律');

// 显式标注顺序 (戊午年 己未月 丁丑日 庚子时)
const _labeled = facts.extractPillars('戊午年 己未月 丁丑日 庚子时');
assert.deepStrictEqual(_labeled.pillars, ['戊午', '己未', '丁丑', '庚子'], '⑤f 显式标注直取');

// 非八字输入不注入
assert.strictEqual(facts.buildFactsFromConversation('今天天气怎么样', []), '', '⑤g 无四柱不注入, 普通对话不受影响');

// 接线契约: pangu_agent_stream 必须把事实块拼进 userInput (断言 require 调用本身, 注释不算)
const _streamSrc = SRC('modules/pangu_agent_stream.js');
assert.ok(_streamSrc.includes("require('./bazi_chart_facts')") && _streamSrc.includes('buildFactsFromConversation(rawInput'),
  '⑤h 主流水线必须接 bazi_chart_facts — 断了 = 十神又回到凭记忆算');

// ⑤i 读图纪律注入 (e2e-812-gate-002 实案): 带图 + 命盘类问题必须在进门时注入柱序纪律,
// 否则模型无视图中柱名标签按位置猜序 → 四柱颠倒、日主错 (实测庚子·丁丑·己未·戊午/日主己土)。
// 核验门只能验答案内部自洽, 救不了读错盘 — 这道注入是首轮纯图的唯一防线。
assert.ok(_streamSrc.includes('【读图纪律 · 系统强制】') && /images\.length > 0/.test(_streamSrc),
  '⑤i 带图命盘题必须前置注入读图纪律 — 断了 = 首轮纯图柱序又会读反');

// zhis_relations 三刑暗死修复 (子卯 pair 条目不再崩)
const zr = require('../64i/bazi/zhis_relations.js');
const _rel = zr.analyzePillars(['戊子', '己卯', '丁丑', '庚子']);
assert.ok(_rel.san_xing.some(r => (r.pair || []).join('') === '子卯'), '⑤i 子卯刑必须检出 (旧代码直接 TypeError)');

// 历史块措辞必须跟着事实走: 图真透传时不许再说"你拿不到图像"
const _msgs = [{ role: 'user', content: '做题,看图', images: ['data:image/png;base64,AA'] }, { role: 'assistant', content: 'x'.repeat(50) }];
assert.ok(_buildHistoryBlock(_msgs, '追问', true).includes('图已随本任务'), '⑤j 图已透传时历史块必须说"图已随本任务"');
assert.ok(_buildHistoryBlock(_msgs, '追问', false).includes('你拿不到图像本身'), '⑤k 图没透传时保持"拿不到图像"旧措辞 (防找图空转)');

console.log('toolmarkup-chartfacts-20261012 tests: ok (④⑤)');

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 首轮定稿核验门 (chart_answer_gate) — 老板拍"你没有修好":
//    首轮纯图做题文字里没四柱, 事实块注不进来, 第一稿十神靠模型记忆 (实测食伤官鲨写反)。
//    修: 答案出门闸 — 从答案抽四柱查表核验, 硬伤 → 强制重修 → 仍有硬伤附诚实标注。
// ⑦ 抽取可信度 (e2e-812-gate-004 血泪实案): 锚点命中"原局**无寅巳申三刑"抓到散布的
// 丙午甲子丙午丙午垃圾盘 → 核验门拿垃圾当真值, 把对的草稿强行修成垃圾。
// 铁律: 宁可抽不出来 (返回 null, 门跳过), 不许拿错盘核验。
const det2 = require('../modules/bazi_chart_facts');
const _g4draft = '| 年柱 | 戊午 |\n| 月柱 | 己未 |\n| 日柱 | 丁丑（日主丁火）|\n| 时柱 | 庚子 |\n\n原局**无寅巳申三刑。流年丙午再来一午，大运甲子，丙午年丙午月，甲午旬。';
const _g4e = det2.extractPillars(_g4draft);
assert.ok(_g4e && _g4e.pillars.join(',') === '戊午,己未,丁丑,庚子', '⑦ 标签在前的表格盘必须抽对 (柱标签路径)');
// 无柱标签 + 干支对散布 >80 字 + 日主对不上 → 必须拒抽 (旧行为: 照抽+加注, 喂垃圾盘给核验门)
const _g4junk = '日主丁火。原局无寅巳申三刑，这点是好事。流年丙午再来一午，水火相战之地。大运甲子正交，甲木印星透出。丙午年丙午月甲午旬，火势炎炎。';
assert.strictEqual(det2.extractPillars(_g4junk), null, '⑦b 散布干支对+日主不符必须拒抽, 宁可null不喂垃圾');
// 无日主声明时, 挤在一起的一组干支仍可抽 (合理盘也可能干支重复)
const _g4c = det2.extractPillars('四柱 戊午 己未 丁丑 庚子');
assert.ok(_g4c && _g4c.pillars.length === 4 && _g4c.dayMaster === '丁', '⑦c 无日主声明的紧凑干支组照常抽取');

// ─────────────────────────────────────────────────────────────────────────────
const gate = require('../modules/chart_answer_gate');

// 实案错文 → 三处硬伤全抓
const _wrong = '原局：戊午、己未、丁丑、庚子，丁火日主。土印、财星很重，庚金七杀透。格局是印旺生身、食伤泄秀。';
const _contra = det2.findChartContradictions(_wrong, ['戊午', '己未', '丁丑', '庚子']);
assert.ok(_contra.some(c => c.claim.startsWith('庚金七杀') && c.expect === '庚=正财'), '⑥ 庚金七杀必须抓 (真值正财)');
assert.ok(_contra.some(c => c.claim === '土印'), '⑥b 土印必须抓 (土是食伤)');
assert.ok(_contra.some(c => c.claim === '印旺'), '⑥c 印旺必须抓 (印计数=0)');

// 表格列序换错也要抓 (e2e-812 T1 实测: 食神/伤官写反)
const _t1 = '四柱 戊午 己未 丁丑 庚子\n| 十神 | 食神 | 伤官 | 丁火 | 偏财 |\n五行实数: 火3';
const _t1c = det2.findChartContradictions(_t1, ['戊午', '己未', '丁丑', '庚子']);
assert.ok(_t1c.some(c => c.claim.includes('年柱') && c.expect.includes('伤官')), '⑥d 表格十神行换错必须抓');

// 正确文本零误伤
const _good = '命局戊午/己未/丁丑/庚子, 丁火日主, 戊=伤官, 己=食神, 庚金正财透, 时支子水七杀, 伤官生财, 身弱喜木火。';
assert.deepStrictEqual(det2.findChartContradictions(_good, ['戊午', '己未', '丁丑', '庚子']), [], '⑥e 正确文本不许报硬伤');

// ⑥x 扩展模式 (e2e-812-gate-003 实测漏检实案, 丁火日主):
// 括号格式 / 大运干(不在四柱里的天干) / 元素+括号 shorthand / 坐X 断言, 全都必须抓
const _g3 = '甲木 = 偏财透出。时干庚（偏财）。丑中癸（正官暗藏）。喜木（财，疏土）、忌土（印过重）。日主坐印。子（正财）是我财。';
const _g3c = det2.findChartContradictions(_g3, ['戊午', '己未', '丁丑', '庚子']);
assert.ok(_g3c.some(c => c.expect === '甲=正印'), '⑥x1 大运干甲木=偏财 必须抓 (真值正印, 甲不在四柱也要验)');
assert.ok(_g3c.some(c => c.expect === '庚=正财'), '⑥x2 庚（偏财）括号格式必须抓');
assert.ok(_g3c.some(c => c.expect === '癸=七杀'), '⑥x3 藏干癸（正官）必须抓');
assert.ok(_g3c.some(c => c.claim === '木财' || c.claim === '土印'), '⑥x4 元素+括号 shorthand 必须抓');
assert.ok(_g3c.some(c => c.claim === '坐印' && c.expect.includes('食神')), '⑥x5 日主坐印必须抓 (丑本气=食神)');
assert.ok(_g3c.some(c => c.expect.includes('子本气=七杀')), '⑥x6 地支括号十神子（正财）必须抓');
// 正确说法的括号格式零误伤
const _g3ok = '甲木 = 正印透出。时干庚（正财）。喜木（印，疏土）。日主坐食神。子（七杀）为忌。';
assert.deepStrictEqual(det2.findChartContradictions(_g3ok, ['戊午', '己未', '丁丑', '庚子']), [], '⑥x7 正确括号格式不许误伤');

// 门流程: 错稿 → 重修 → 用修正稿; 对稿/非命盘文不花 LLM 调用
(async () => {
  let called = 0;
  const r1 = await gate.verifyAndRepairChartAnswer(_wrong, async (prompt) => {
    called++;
    assert.ok(prompt.includes('庚金七杀') && prompt.includes('排盘事实'), '⑥f 重修 prompt 必须带硬伤清单+事实块');
    return '原局：戊午、己未、丁丑、庚子，丁火日主。戊=伤官、己=食神，庚金正财透，时支子水七杀。身弱喜木火。';
  });
  assert.ok(r1.repaired && called === 1 && r1.text.includes('庚金正财'), '⑥g 错稿必须被重修稿顶替');
  const r2 = await gate.verifyAndRepairChartAnswer(_good, async () => { called++; return ''; });
  assert.ok(r2.checked && !r2.repaired && called === 1, '⑥h 对稿零开销, 不许多花 LLM 调用');
  const r3 = await gate.verifyAndRepairChartAnswer('今天天气晴', async () => { called++; return ''; });
  assert.ok(!r3.checked && called === 1, '⑥i 非命盘文本不过门');

  // 接线契约: legacy 主循环 + dispatcher 四处综合定稿都要过门
  const _loopSrc = SRC('modules/j2_agent_loop.js');
  // 2026-10-23 第 60 批: 两道门收进 modules/answer_gates.js 唯一编排,
  //   调用点不再自己 require 门 —— 所以这里从「有没有 require 门」改成
  //   「有没有走编排」。**行为意图一条没放松**: 仍然要求 legacy 主循环过门。
  assert.ok(_loopSrc.includes("require('./answer_gates')"), '⑥j legacy 主循环必须接核验门 — 首轮带图就走这条');
  assert.ok(_loopSrc.includes('runAnswerGates'), '⑥j legacy 主循环没走唯一编排 runAnswerGates');
  assert.ok(!_loopSrc.includes("require('./chart_answer_gate')"),
    '⑥j legacy 主循环又自己 require 门了 —— 第二份编排, 迟早只改其中一处');
  const _dispSrc2 = SRC('modules/j2_dispatcher.js');
  // 2026-10-12: 新增直答单 agent 定稿也要过命盘核验门 → 合规过门处 4 → 5
  // 2026-10-21 第九批: _chartGate 改名 _factGate (卦象门也并进来, 出门只留一道闸)。
  // 2026-10-23 第 61 批: 定稿收口收进 final_pipeline._finalize (剥泄漏+对齐门+门 一条流水线)。
  // 2026-10-23 第 65 批: 「五处各写一遍 `_finalize(`」这个量法彻底失效 ——
  //   公共 5 步收进了 `_synthesizeAndFinalize`, 5 处调用变成 1 处调用 + 5 条出口。
  //   **意图一个字没变**: 五处定稿一处都不能少, 少一处照样红。
  //   新量法钉的是**机制**: 每条交付出口都必须走到定稿流水线(直接或经 _synthesizeAndFinalize)。
  const { finalizeCoverage } = require('./helpers/dispatcher_exits');
  const _cov = finalizeCoverage();
  assert.ok(_cov.count >= 4,
    `⑥k dispatcher 交付出口找少了 (直答/fixed_flow/关键词兜底/主路径), 实际 ${_cov.count}`);
  assert.ok(_cov.all('_finalize'),
    '⑥k 有交付出口没过定稿流水线: '
    + _cov.uncovered('_finalize').map((e) => 'L' + e.line + '/' + (e.mode || '直答')).join(', '));
  assert.ok(!/await _factGate\(/.test(_dispSrc2),
    '⑥k 有调用点绕过定稿流水线直接过门 —— 剥【上文】块和对齐门就被跳过了');
  assert.ok(!/await _chartGate\(/.test(_dispSrc2), '⑥k 旧名 _chartGate 还有残留调用点');
  // 卦象门也得在 legacy 主循环那条路上(首轮带图走的就是它)
  const _gatesSrc = SRC('modules/answer_gates.js');
  assert.ok(_gatesSrc.includes("require('./gua_answer_gate')"), '⑥j 编排里没接卦象核验门');
  assert.ok(_gatesSrc.includes("require('./chart_answer_gate')"), '⑥j 编排里没接命盘核验门');
  console.log('⑥ chart gate tests: ok');
})().catch(e => { console.error(e.message); process.exit(1); });
