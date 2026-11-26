'use strict';
/**
 * tests/synthesis-fidelity-20261025.test.js
 * 第 87 批: 交付保真 —— 别把子 agent 的料砍了头, 别把长度上限的例外当成摆设
 *
 * ## 起因 (现场, 会话 probe89-fixed, 2026-10-25 实跑落盘)
 *
 * 主人原话 (逐字):
 *   「分别分析一下 .../llm_caller.js 和 .../j2_agent_loop.js 各自负责什么,
 *     然后综合说明它们是怎么配合的」
 *
 * 三刀全部 completed, 汇报 8440 / 8042 / 10208 字 (合计 26690)。
 * 主人收到的最终答复: **557 字**, 且下面这些**已经查实**的东西一条都没进去:
 *   · 「5 处职责重叠 + 3 处缝隙」
 *   · 「接口契约三套」
 *   · 「pangu-single.js:823/1822/1839/1880/1910 五处注入点同步断」
 *   · 「置信度: 未确认 Anthropic 分支的 tool_use 生命周期」
 *
 * ## 三条根因 (都是机制层, 不是模型不听话)
 *
 * ① 喂进去的料被**砍头**: `_buildSynthesisInput` 里 `String(summary).slice(0, budget)`,
 *    而 budget = `Math.min(3000, 15000 / n)` —— n ≤ 5 时那个 3000 硬顶说了算,
 *    「均分」根本没发生 (现场 15000 的额度只用了 9000, **6000 字没用上**)。
 *    砍掉的正是尾巴: 汇报契约里「③ 未做」「置信度」都在尾巴上。
 *
 * ② 长度上限的**例外条款从来没被兑现**: 老板 2026-08-02 拍「≤300 字」,
 *    那条规则自带例外「仅当主人明确要『详细/综合/报告』时才可长」——
 *    但例外**由模型自己判断要不要用**, 于是基本没被用过。
 *    ⇒ 改由**机制**判, 判据取**主人原话** (老板自己打的字), 不取模型散文。
 *
 * ③ 同一个 `slice(0, N)` 抄在**三条综合路**上 (主路 / fixed_flow / 兜底),
 *    只修一条 = 「同一个修复只打了一半」—— 这个项目最贵的一类假绿。
 *
 * ## 这个文件的判据纪律
 *
 * · 扫源码的断言**只证"接了线"**, 所以每条扫源码的都有配着的真调断言;
 * · 剥注释再扫 (判据句本身会出现在解释性注释里, 不剥会自己把自己判成违规);
 * · 判据取**主人原话 / 数值 / 形态**, 不取模型的自由散文。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const CORE = path.join(__dirname, '..');
const DISPATCHER_PATH = path.join(CORE, 'modules', 'j2_dispatcher.js');
const PROMPT_PATH = path.join(CORE, 'modules', 'synth_prompt.js');

const D = require('../modules/j2_dispatcher.js');
const { buildSynthesisSystemPrompt, RULES } = require('../modules/synth_prompt.js');

function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
}

// ============================================================
// 一、_trimKeepEnds —— 砍料留两头
// ============================================================

test('正例: 超预算时头尾都留着 (结论在头, 未做/置信度在尾)', () => {
  const head = 'H'.repeat(100);
  const mid = 'M'.repeat(500);
  const tail = 'T'.repeat(100);
  const out = D._trimKeepEnds(head + mid + tail, 120);
  assert.ok(out.startsWith('H'), '头必须留着 —— 结论在头');
  assert.ok(out.endsWith('T'), '尾必须留着 —— 未做/置信度在尾');
  assert.ok(out.includes('中段省略'), '必须明说省了中段多少字 (不许主人以为看全了)');
});

test('正例: 省略的字数要说对, 不许拍', () => {
  const s = 'x'.repeat(1000);
  const out = D._trimKeepEnds(s, 100);
  const m = out.match(/中段省略 (\d+) 字/);
  assert.ok(m, '必须写出省略字数');
  const omitted = Number(m[1]);
  // 头 62% + 尾 38% (实现里的固定比例), 省掉的必须是剩下那一段
  const headLen = Math.floor(100 * 0.62);
  const tailLen = 100 - headLen;
  assert.equal(omitted, 1000 - headLen - tailLen, '省略字数必须等于实际省掉的那一段');
  assert.ok(omitted > 0 && omitted < 1000);
});

test('正例: 不超预算就一个字都不许动', () => {
  const s = 'short';
  assert.equal(D._trimKeepEnds(s, 100), s);
  assert.equal(D._trimKeepEnds(s, 5), s, '等于预算也不动');
});

test('边界: 空 / null / 非数预算不许炸', () => {
  assert.equal(D._trimKeepEnds('', 100), '');
  assert.equal(D._trimKeepEnds(null, 100), '');
  assert.equal(D._trimKeepEnds(undefined, 100), '');
  assert.equal(D._trimKeepEnds('abc', 0), 'abc', '预算 0 = 不限');
  assert.equal(D._trimKeepEnds('abc', NaN), 'abc');
});

// ============================================================
// 二、_breadthDemand —— 判据取主人原话
// ============================================================

test('正例: 主人原话里的覆盖面信号 (现场 probe89 那句逐字)', () => {
  const real = '分别分析一下 /Users/you/Desktop/pangu/apps/core/modules/llm_caller.js 和 '
    + '/Users/you/Desktop/pangu/apps/core/modules/j2_agent_loop.js 各自负责什么, 然后综合说明它们是怎么配合的';
  assert.equal(D._breadthDemand(real), true, '「分别」+「各自」⇒ 覆盖面型');
});

test('正例: 覆盖面型命中', () => {
  for (const q of ['逐条说明', '详细展开讲讲', '全面对比这两个方案', '把所有可能性列出来',
    '每个都讲一下', '完整梳理一遍', '写个报告', '深入剖析这三个文件']) {
    assert.equal(D._breadthDemand(q), true, '应判覆盖面型: ' + q);
  }
});

test('正例: 压缩型不许被覆盖面信号带跑 (否定优先)', () => {
  for (const q of ['一句话总结一下', '简要说说', '给个提纲', '列几个要点', '不要展开',
    '分别用一句话概括这两个文件', '详细但只要三个要点']) {
    assert.equal(D._breadthDemand(q), false, '应判压缩型: ' + q);
  }
});

test('正例: 普通问题就是普通问题 (默认档 ≤300 字不许被乱翻)', () => {
  for (const q of ['解释一下这个函数', '这个报错怎么处理', '帮我看看这段代码有没有问题',
    '今天天气怎么样', '']) {
    assert.equal(D._breadthDemand(q), false, '应判普通: ' + q);
  }
});

test('反例: 判据不许被模型散文污染 —— 只看主人原话, 不看子 agent 说什么', () => {
  // 同一个主人原话, 不因为上下文中出现什么而改变判定
  const q = '分别分析一下 a 和 b';
  assert.equal(D._breadthDemand(q), D._breadthDemand(q));
});

// ============================================================
// 三、_synthesisBudget —— 料量: 均分 + 按模型上下文 + 老板那个数当下限
// ============================================================

test('正例: 探不到模型上下文 ⇒ 退回老板 2026-09-16 那个数 (15000), 不许比它低', () => {
  const b = D._synthesisBudget(null, 3, 0);
  assert.equal(b.total, 15000, '探不到 ⇒ 老板那个数');
  assert.equal(b.per, 5000, '3 个子 agent 均分 15000');
});

test('正例: 均分规则 (老板 2026-09-16 拍的那条, 一个字没改)', () => {
  for (const n of [1, 2, 3, 5, 9, 30]) {
    const b = D._synthesisBudget(null, n, 0);
    assert.equal(b.per, Math.max(1000, Math.floor(15000 / n)), 'n=' + n + ' 均分');
    // 每刀至少 1000 字 (读得下去的下限) —— n > 15 时总量会因此超过 15000,
    //   这是从旧码继承的行为, 不是新引入的: 宁可多给, 也不给一刀一句没头没尾的话。
    assert.ok(b.per >= 1000, 'n=' + n + ' 每刀至少 1000 字');
    assert.ok(b.per <= Math.ceil(15000 / Math.max(1, n)) + 1000, 'n=' + n + ' 不许超发');
  }
});

test('正例: 3000 硬顶不许再出现 (现场: n=3 时它把 15000 的额度架空成 9000)', () => {
  const b = D._synthesisBudget(null, 3, 0);
  assert.ok(b.per > 3000, 'n=3 时每刀预算必须 > 3000, 否则「均分」没发生');
});

test('正例: 模型上下文大 ⇒ 料量跟着涨, 但有上限', () => {
  const big = D._synthesisBudget({ id: 'minimax_m3.1-flash-preview' }, 3, 0);
  assert.ok(big.total >= 15000, '不许比老板那个数低');
  assert.ok(big.total <= 60000, '不许无限涨 (上限 60000)');
  assert.equal(big.per, Math.floor(big.total / 3), '涨了也照样均分');
});

test('正例: 固定块占得多 ⇒ 料量让路 (不许把上下文撑爆)', () => {
  const a = D._synthesisBudget({ id: 'minimax_m3.1-flash-preview' }, 3, 0);
  const b = D._synthesisBudget({ id: 'minimax-m3.1-flash-preview' }, 3, 400000);
  assert.ok(b.total <= a.total, '固定块大了 ⇒ 给料的位置必须变小');
});

// ============================================================
// 四、真源接线: 覆盖面型走 LENGTH_RULE_BREADTH, 默认档一个字没改
// ============================================================

test('正例: 默认档仍然是 ≤300 字 (老板 2026-08-02 拍的那条一个字没改)', () => {
  const p = buildSynthesisSystemPrompt();
  assert.ok(p.includes(RULES.LENGTH_RULE), '默认档必须还带着 ≤300 字那条');
  assert.ok(!p.includes(RULES.LENGTH_RULE_BREADTH), '默认档不许带覆盖面那条');
});

test('正例: 覆盖面档换成长度条款 (是兑现老板自己写的例外, 不是放宽上限)', () => {
  const p = buildSynthesisSystemPrompt({ breadthDemand: true });
  assert.ok(p.includes(RULES.LENGTH_RULE_BREADTH), '覆盖面档必须用 LENGTH_RULE_BREADTH');
  assert.ok(!p.includes(RULES.LENGTH_RULE), '覆盖面档不该再压着 300 字');
  assert.ok(p.includes(RULES.ORDER_RULE), '别的规则一条都不能少');
  assert.ok(p.includes(RULES.RECONCILE_RULE));
  assert.ok(p.includes(RULES.NO_TOOL_RULE));
  assert.ok(p.includes(RULES.TIMING_RULE));
});

test('正例: _buildSynthesisMessages 按主人原话自动切档', () => {
  const msgs = D._buildSynthesisMessages('sess-x', '分别分析 a 和 b 各自负责什么', '', [], 3000);
  const sys = msgs.map(m => m.content).join('\n');
  assert.ok(sys.includes(RULES.LENGTH_RULE_BREADTH), '覆盖面型原话 ⇒ 走覆盖面档');

  const msgs2 = D._buildSynthesisMessages('sess-x', '解释一下这个函数', '', [], 3000);
  const sys2 = msgs2.map(m => m.content).join('\n');
  assert.ok(sys2.includes(RULES.LENGTH_RULE), '普通原话 ⇒ 仍走 ≤300 字默认档');
});

// ============================================================
// 五、真调: 汇报的尾巴必须真的进到综合输入里
// ============================================================

test('真调: 子 agent 汇报的尾巴 (未做/置信度) 必须进综合输入 —— 不是只测函数', () => {
  const summary = 'C'.repeat(4000) + '〔未做: 没跑真实请求〕〔置信度: 未确认 Anthropic 分支〕';
  const results = [{
    agent: 'li',
    task: '分析 a',
    result: { summary, runtimeStatus: 'completed', artifacts: [] },
  }];
  const input = D._buildSynthesisInput('sess-y', '题', '', results, 2000);
  assert.ok(input.includes('未做: 没跑真实请求'), '尾巴必须在');
  assert.ok(input.includes('未确认 Anthropic 分支'), '尾巴必须在');
  assert.ok(input.includes('中段省略'), '中间省略要明说');
});

test('真调: 派发记录里的产出不许再是 [object Object]', () => {
  const rec = D._buildDispatchRecord([{
    agent: 'li',
    task: '干活',
    result: {
      summary: '干完了',
      runtimeStatus: 'completed',
      toolsUsed: ['read_file'],
      artifacts: [{ path: '/tmp/a.txt', bytes: 12, tool: 'write_file' }],
    },
  }]);
  assert.ok(!rec.includes('[object Object]'), '派发记录里不许出现 [object Object]');
  assert.ok(rec.includes('/tmp/a.txt'), '产出的真实路径必须出现');
});

// ============================================================
// 六、结构守卫: 三条综合路都不许再有「砍汇报」的 slice
// ============================================================

test('结构守卫: 源码里不许再出现砍汇报的 slice(0, N) —— 三条路一起管', () => {
  const src = stripComments(fs.readFileSync(DISPATCHER_PATH, 'utf8'));
  // 找「把 summary/finalText 砍成定长」这种写法
  const bad = [];
  const re = /String\(\s*summary[^)]*\)\s*\.\s*slice\(\s*0\s*,\s*\d+\s*\)/g;
  let m;
  while ((m = re.exec(src))) bad.push(m[0]);
  assert.equal(bad.length, 0,
    '还剩这些「砍汇报」的写法, 必须改成 _trimKeepEnds:\n' + bad.join('\n'));
});

test('结构守卫: fixed_flow 那条综合路必须走真源 (不许再自己内联一套)', () => {
  const src = stripComments(fs.readFileSync(DISPATCHER_PATH, 'utf8'));
  const calls = src.match(/_buildSynthesisMessages\s*\(/g) || [];
  // 主路 + fixed_flow 至少两处 (其余是函数定义与导出)
  assert.ok(calls.length >= 3, '两条综合路都该走 _buildSynthesisMessages (定义+两处调用), 实得 ' + calls.length);
  // 兜底路的那份 toolHistorySummaries 是**故意**留着的 (它与主路有意不同: 汇报在前、工具证据在后),
  //   但它不许再自己写死额度 —— 额度走 _synthesisBudget (第 87 批)。
  assert.ok(/toolHistorySummaries\.slice\(0,\s*_fbBudget\.total\)/.test(src),
    '兜底路的总量必须走 _synthesisBudget 算出来的值, 不许再写死 15000');
  assert.ok(!/toolHistorySummaries\.slice\(0,\s*15000\)/.test(src),
    '兜底路不许再写死 15000');
});

test('结构守卫: 综合 system prompt 只许有一份 (真源纪律不许破)', () => {
  const src = stripComments(fs.readFileSync(DISPATCHER_PATH, 'utf8'));
  const calls = src.match(/buildSynthesisSystemPrompt\s*\(/g) || [];
  // 第 89 批: 「只许有一份」现在有一个**更强**的说法 —— 真源在 dispatcher 里
  //   恰好被调 1 次 (唯一拼装点 `_synthesisSystemMessages`)。
  //   旧写法是 `<= 4` (上限): 4 处各拼各的、只要长得一样就照样绿 ——
  //   而 2026-10-25 实跑漏过去的正是「挂法分叉」(主路两条独立 system 消息 /
  //   关键词兜底路合并成一条), 每条路单独看都通得过。上限型断言看不见这个。
  assert.strictEqual(calls.length, 1,
    'dispatcher 里 buildSynthesisSystemPrompt 调用点必须恰好 1 处 (唯一拼装点), 现在 '
    + calls.length + ' 处 —— 有路径自己拼了提示词');
  const spread = src.match(/\.\.\._synthesisSystemMessages\s*\(/g) || [];
  assert.ok(spread.length >= 2,
    '综合路径必须展开唯一拼装点 (主派发/fixed_flow 共用 _buildSynthesisMessages + 关键词兜底路), 现在 '
    + spread.length + ' 处');
  const p = stripComments(fs.readFileSync(PROMPT_PATH, 'utf8'));
  assert.ok(p.includes('LENGTH_RULE_BREADTH'), '覆盖面那条文案得在真源里');
});

test('正例: 唯一拼装点按主人原话切档 (覆盖面型 ⇒ 走 LENGTH_RULE_BREADTH)', () => {
  // 判据链: 主人原话 → _breadthDemand → 拼装点传给真源 → 真源换档。
  //   这里钉的是**最后一环**: 拼装点真把档位传下去了。
  //   (前两环由 _breadthDemand 自己的用例守; 真源换档由真源的用例守。)
  const broad = D._synthesisSystemMessages('分别分析 a 和 b 各自负责什么');
  assert.ok(broad[0].content.includes(RULES.LENGTH_RULE_BREADTH),
    '覆盖面型原话 ⇒ 拼装点产出的第一条必须走覆盖面档');
  assert.ok(!broad[0].content.includes(RULES.LENGTH_RULE),
    '覆盖面档不该再压着 300 字');
  const narrow = D._synthesisSystemMessages('一句话说清楚');
  assert.ok(narrow[0].content.includes(RULES.LENGTH_RULE),
    '压缩型原话 ⇒ 拼装点必须走默认档 (≤300 字)');
});

test('正例: 固定块字数量的是**真源真产物**, 不是从真源外面猜的 (第 89 批)', () => {
  // 2026-10-25 现场: 固定块原来是从真源外面猜长度的 (调真源取 .length 再加禁令的 .length)。
  //   猜错的方向是「算大了」⇒ 给料的位置被悄悄吃掉 ⇒ 主人看到的还是被砍过的答案,
  //   而**全程没有任何报错**。
  const q = '分别分析一下 a 和 b 各自负责什么';
  const fixed = D._synthesisFixedChars('sess-fixed', q, '');
  // 固定块 = 真源真产物 (两条 system 消息) + 真注入块 (空料版)。
  const sysChars = D._synthesisSystemMessages(q)
    .reduce((n, m) => n + String(m.content || '').length, 0);
  const inpChars = D._buildSynthesisInput('sess-fixed', q, '', [], 0).length;
  assert.strictEqual(fixed, sysChars + inpChars,
    '固定块字数必须逐字等于「真源真产物 + 真注入块」的长度 —— '
    + '从真源外面猜长度 = 真源一改这个数字就跟着错');
  // 真源变长了, 这个数字必须跟着变 (不是巧合相等)。
  const longer = D._synthesisFixedChars('sess-fixed', '一句话说清楚', '');
  const sysLong = D._synthesisSystemMessages('一句话说清楚')
    .reduce((n, m) => n + String(m.content || '').length, 0);
  const inpLong = D._buildSynthesisInput('sess-fixed', '一句话说清楚', '', [], 0).length;
  assert.strictEqual(longer, sysLong + inpLong,
    '另一道题上同样必须逐字相等 (默认档与覆盖面档的文案长度不同)');
});

