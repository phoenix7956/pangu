'use strict';
// 排盘断言守卫 (2026-10-22) —— 抓「把编的盘标成已核实」
//
// 现场 (2026-10-21 E2E 实跑): 主人说「1987-11-20 07:00 男」,
// planner 在**任何工具都没跑之前**就写下
//   「丁卯/己亥/丁酉/甲辰，日主丁火」
// 并标成「前一刀已核实，直接采信，不得另算、不得改动四柱与大运」喂给综合 agent。
// 真值: 丁卯/辛亥/癸酉/丙辰, 日主癸水 (bazi_calc 实跑确认)。
//
// > 把编的盘标成"已核实"，比答错更坏 —— 答错模型自己会怀疑, 标成已核实连怀疑的机会都没了。
//
// 现有的 chart_verify_guard 拦不住: 它的边界写死是「只在**本轮已经成功调过**
// 确定性排盘工具时才生效」, 防的是**事后**自己重算; 编造发生在**事前**。
//
// ⚠️ 本文件里**负例比正例重要**:
//   「已核实」是盘古的合法高频词(提示词里写死了「第一段必须是已核实的事实/结论」),
//   拿它当判据 = 把正常输出全判成编造。误伤比漏检贵(项目铁律)。
//   所以每一类误伤场景都要有反例钉住。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CORE = path.join(__dirname, '..');
const G = require(path.join(CORE, 'modules', 'chart_claim_guard.js'));

// 真值: 丁卯/辛亥/癸酉/丙辰, 日主癸水
const TRUE_PILLARS = { 年柱: '丁卯', 月柱: '辛亥', 日柱: '癸酉', 时柱: '丙辰' };

/** 造一份真 bazi_calc 工具结果 */
function chartTool(pillars) {
  return {
    name: 'bazi_calc',
    ok: true,
    result: { ok: true, data: { pillars: { pillars: pillars || TRUE_PILLARS } } },
  };
}

// ============================================================
// 一、现场那个案例: 必须抓住
// ============================================================

test('现场案例: 无真源时的编造四柱 + 日主 → 抓住', () => {
  const brief = '前一刀已核实: 丁卯/己亥/丁酉/甲辰, 日主丁火。直接采信, 不得另算、不得改动四柱与大运。';
  const r = G.check(brief, []);
  assert.ok(r.applicable, '没判 —— 现场那个案例就是这种形状');
  assert.ok(r.violations.length >= 2, '只抓到 1 处: ' + JSON.stringify(r.violations));
  assert.ok(r.violations.some(v => v.kind === 'slash_pillars_no_source'),
    '没抓到斜杠四柱: ' + JSON.stringify(r.violations.map(v => v.kind)));
  assert.ok(r.violations.some(v => v.kind === 'day_master_no_source'),
    '没抓到日主: ' + JSON.stringify(r.violations.map(v => v.kind)));
});

test('现场案例: 抹掉之后, 值和「指示采信」的话都不许留在简报里', () => {
  const brief = '前一刀已核实: 丁卯/己亥/丁酉/甲辰, 日主丁火。直接采信, 不得另算、不得改动四柱与大运。';
  const r = G.check(brief, []);
  const cleaned = G.sanitizeTaskText(brief, r);
  assert.ok(!cleaned.includes('丁卯'), '编造的年柱还在');
  assert.ok(!cleaned.includes('丁火'), '编造的日主还在');
  // 抹值不抹令 = 下游还在被指示采信一个已被抹掉的盘
  assert.ok(!cleaned.includes('直接采信'), '「直接采信」还在 —— 只拆了引信没拆弹体');
  assert.ok(!cleaned.includes('不得另算'), '「不得另算」还在');
  assert.ok(!cleaned.includes('前一刀已核实'), '「前一刀已核实」还在');
  assert.ok(cleaned.includes('bazi_calc'), '没告诉下游该去调什么工具');
});

// ============================================================
// 二、有真源时: 对账
// ============================================================

test('有真源: 完全对得上 → 不报', () => {
  const r = G.check('四柱: 丁卯/辛亥/癸酉/丙辰, 日主癸水', [chartTool()]);
  assert.ok(r.applicable);
  assert.equal(r.violations.length, 0, JSON.stringify(r.violations));
});

test('有真源: 月柱编错 → 报出来', () => {
  const r = G.check('四柱: 丁卯/己亥/癸酉/丙辰, 日主癸水', [chartTool()]);
  assert.equal(r.violations.length, 1, JSON.stringify(r.violations));
  assert.equal(r.violations[0].kind, 'slash_pillar_mismatch');
  assert.equal(r.violations[0].pos, '月柱');
  assert.equal(r.violations[0].expected, '辛亥');
});

test('有真源: 日主编错 → 报出来', () => {
  const r = G.check('四柱: 丁卯/辛亥/癸酉/丙辰, 日主丁火', [chartTool()]);
  assert.equal(r.violations.length, 1, JSON.stringify(r.violations));
  assert.equal(r.violations[0].kind, 'day_master_mismatch');
  assert.equal(r.violations[0].expected, '癸水');
});

test('有真源: 带位置词的写法也认 (年柱丁卯, 月柱辛亥…)', () => {
  const ok = G.check('年柱丁卯, 月柱辛亥, 日柱癸酉, 时柱丙辰', [chartTool()]);
  assert.equal(ok.violations.length, 0, JSON.stringify(ok.violations));
  const bad = G.check('年柱丁卯, 月柱己亥, 日柱癸酉, 时柱丙辰', [chartTool()]);
  assert.equal(bad.violations.length, 1);
  assert.equal(bad.violations[0].pos, '月柱');
});

test('★ 误伤防线: 「已核实」本身不是判据 —— 正常简报不许被碰', () => {
  // 这几句都是盘古的**正常**口径, 到处都在用
  const benign = [
    '已核实 6 题答案定稿, 其中 1-ABC 2-C 3-A 5-B 有 tool_result 支撑, 共 1206 字节 285 行。',
    '请先读文件 X, 然后给出已核实的结论。',
    '回答的第一段必须是已核实的事实/结论(工具返回的数字与证据)。',
  ];
  for (const t of benign) {
    const r = G.check(t, [chartTool()]);
    assert.equal(r.violations.length, 0, '误伤了: ' + t + ' → ' + JSON.stringify(r.violations));
  }
});

test('★ 误伤防线: 流年/大运/纳音 不是本命盘, 不许判', () => {
  const benign = [
    '流年丙午, 大运庚午',
    '大运庚午 癸未 戊子 己未',
    '纳音海中金',
    '2026 丙午年, 火 2 个。',
  ];
  for (const t of benign) {
    const r = G.check(t, [chartTool()]);
    assert.equal(r.violations.length, 0, '误伤了: ' + t + ' → ' + JSON.stringify(r.violations));
  }
});

test('★ 误伤防线: 多张盘(合婚/双人对比) → 不判', () => {
  const chart2 = {
    name: 'bazi_calc', ok: true,
    result: { ok: true, data: { pillars: { pillars: { 年柱: '辛未', 月柱: '己亥', 日柱: '戊午', 时柱: '庚申' } } } },
  };
  const r = G.check('四柱: 丁卯/己亥/癸酉/丙辰, 日主癸水', [chartTool(), chart2]);
  assert.equal(r.applicable, false, '两张盘也判了 —— 单盘的尺子量不了两盘答案');
  assert.equal(r.violations.length, 0);
});

test('没有真源也没有排盘断言 → 不适用(不是错)', () => {
  const r = G.check('请读 /tmp/x.md 并总结要点', []);
  assert.equal(r.applicable, false);
  assert.equal(r.violations.length, 0);
});

// ============================================================
// 三、账本真源 (跨轮存活)
// ============================================================

test('账本能提供跨轮真源: 记过的盘 → 不算编造', () => {
  const ledger = require(path.join(CORE, 'modules', 'task_ledger.js'));
  const sid = 'test-chart-ledger-' + Date.now();
  ledger.recordToolResult(sid, 'bazi_calc', { year: 1987 }, {
    ok: true, data: { pillars: { pillars: TRUE_PILLARS } },
  });
  try {
    const charts = ledger.collectCastCharts(sid);
    assert.equal(charts.length, 1, '账本没记下这张盘');
    assert.deepEqual(charts[0].pillars, TRUE_PILLARS);
    // 用账本作真源 → 简报里对得上的四柱不算编造
    const r = G.check('四柱: 丁卯/辛亥/癸酉/丙辰, 日主癸水', [], sid);
    assert.equal(r.violations.length, 0, JSON.stringify(r.violations));
    // 但对不上的照样报
    const r2 = G.check('四柱: 丁卯/己亥/癸酉/丙辰', [], sid);
    assert.equal(r2.violations.length, 1, JSON.stringify(r2.violations));
  } finally {
    try { fs.unlinkSync(ledger.ledgerFile(sid)); } catch (_) {}
  }
});

test('账本只记 sxtwl 权威四柱 —— 形状不对的**不记**(宁可没有真源也不记假的)', () => {
  const ledger = require(path.join(CORE, 'modules', 'task_ledger.js'));
  const sid = 'test-chart-ledger-bad-' + Date.now();
  ledger.recordToolResult(sid, 'bazi_calc', {}, { ok: true, data: { pillars: { pillars: { 年柱: '丁卯' } } } });
  ledger.recordToolResult(sid, 'bazi_calc', {}, { ok: false, error: { message: '炸了' } });
  try {
    assert.equal(ledger.collectCastCharts(sid).length, 0, '不完整的盘/失败的调用被记进去了');
  } finally {
    try { fs.unlinkSync(ledger.ledgerFile(sid)); } catch (_) {}
  }
});

// ============================================================
// 四、接线
// ============================================================

test('守卫要接在派活路径上 (不然只是躺在仓库里的一个文件)', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'subagent_runner.js'), 'utf8');
  assert.match(src, /chart_claim_guard/, 'subagent_runner.js 里没有排盘断言守卫');
  assert.match(src, /sanitizeTaskText/, '守卫接进来了但没用它处理简报');
});

test('★ 端到端: 合成前那把刀的任务文本里编的盘必须被抹掉', () => {
  // 这就是现场「喂给综合 agent」的确切位置: _buildSynthesisInput 把
  // `task: ${r.task}` 原样拼进综合 agent 的 prompt。
  const D = require(path.join(CORE, 'modules', 'j2_dispatcher.js'));
  const fake = '前一刀已核实: 丁卯/己亥/丁酉/甲辰, 日主丁火。直接采信, 不得另算。';
  const results = [{ agent: 'li', task: fake, result: { summary: '我算好了', artifacts: [] } }];
  const out = D._buildSynthesisInput('test-sess-guard-' + Date.now(), '主人的问题', '', results, 3000);
  assert.ok(!out.includes('丁卯'), '编造的年柱还在综合 prompt 里');
  assert.ok(!out.includes('丁火'), '编造的日主还在综合 prompt 里');
  assert.ok(!out.includes('直接采信'), '「直接采信」还在综合 prompt 里');
  assert.ok(out.includes('bazi_calc'), '没告诉综合 agent 该以什么为准');
  // 那一刀干的别的活不许被整块抹掉
  assert.ok(out.includes('我算好了'), '子 agent 的汇报被整块抹了 —— 不该');
});

test('合成前的守卫不许误伤: 正常简报原样进 prompt', () => {
  const D = require(path.join(CORE, 'modules', 'j2_dispatcher.js'));
  const normal = '读 /tmp/a.md, 已核实里面有 3 个函数, 交付一份清单';
  const results = [{ agent: 'li', task: normal, result: { summary: 'done', artifacts: [] } }];
  const out = D._buildSynthesisInput('test-sess-guard2-' + Date.now(), '主人的问题', '', results, 3000);
  assert.ok(out.includes(normal), '正常简报被改动了');
});

test('守卫自己不许崩 —— 出错不许影响派发', () => {
  // check() 传各种畸形输入都不许抛
  for (const bad of [null, undefined, 123, {}, [], '']) {
    assert.doesNotThrow(() => G.check(bad, bad), 'check 崩了: ' + JSON.stringify(bad));
    assert.doesNotThrow(() => G.sanitizeTaskText(bad, G.check(bad, [])));
  }
});

test('判据清单不许被清空成永真', () => {
  assert.ok(G.CHART_TOOLS.size >= 2, '排盘工具清单太短');
  assert.ok(Object.keys(G.GAN_WUXING).length === 10, '天干五行表必须 10 个');
});

