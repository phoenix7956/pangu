'use strict';
// 2026-10-12 回归: 老板报「会话 78325678 新开会话一开始还正常, 后续就不对劲」。
// 三个真 bug:
//   ① 工具结果被 slice(0, 6000) 静默截断 → bazi_calc 实返 50,874 字符, 模型只看到 11.8%,
//      其中 liunian(流年+流月, 占 94%) 只见到 7%。截断点切在流月数组中间, 模型收到的是
//      **非法 JSON**, 且无任何标记 → 它以为数据就这么多, 于是凭印象补: "1986 辛酉"
//      (真值庚申) / "2026 乙丑" / "2026 甲子" / "2026 庚辰", 三轮自相矛盾。
//
//   2026-10-21 续: 光把额度提到 24,000 治不了根 —— 数据仍然被砍, 模型反而**更积极**
//   去找那半截 (E2E 实跑: bazi_calc 之后 16 次 exec_command 满世界 find/grep)。
//   真正修法是把 82% 的体积从默认返回里拿掉 (流月明细改成要显式要才给):
//   53,423 → 9,467 字符, 默认档**不再触发裁剪**。
//   所以本测试现在分两支: ①A 默认档断言"不裁剪 + 大运完整 + 流年一条不少",
//   ①B 全量档(liunian_months: true)继续断言裁剪机制本身仍然成立。
//   ② 工具空转熔断只管 _PROBE_TOOLS(system_info/process_list…), 域工具漏网 → bazi_calc 被
//      连调 5 次, 每次换一套瞎猜的出生日期, 五轮零文本输出。
//   ③ bazi_calc 在主 agent 工具表里有, 但 8 个子 agent 白名单一个都没有 → 排盘题路由到
//      子 agent 后无工具可用, 模型整张盘编出来。
//
// 注意: 早期版本这个文件在顶层写了 `return promise`, 把后面的 test() 全截断了 —— 断言是死代码,
// 变异测试怎么改都绿。本文件全部包在 test() 里, 结构上杜绝这种"空过"。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULES = path.join(__dirname, '..', 'modules');
const loopSrc = fs.readFileSync(path.join(MODULES, 'j2_agent_loop.js'), 'utf8');

// 从源码里抠出真实实现来跑, 不做静态正则断言 (静态审计对参数名吃过 40 个假正的亏)
function loadFit() {
  const i = loopSrc.indexOf('const TOOL_RESULT_MAX_CHARS');
  const j = loopSrc.indexOf('async function _runAgentLoopLegacyStream');
  assert.ok(i > 0 && j > i, '① _fitToolResult 实现不见了');
  const tmp = path.join(os.tmpdir(), '_pangu_fit_extract.js');
  // 2026-10-21: TOOL_RESULT_MAX_CHARS 这行从"自己 parse 一份 env"改成了
  //   `require('./run_trace')` (额度真源收成一处)。抠出来的片段是从 /tmp require 的,
  //   './run_trace' 相对 /tmp 解析不了 —— 所以把那**一行**换成绝对路径,
  //   其余片段一字不动, 测的仍然是线上那套实现。
  const body = loopSrc.slice(i, j).replace(
    /const TOOL_RESULT_MAX_CHARS = [^\n]*;/,
    "const TOOL_RESULT_MAX_CHARS = require(" + JSON.stringify(path.join(MODULES, 'run_trace.js')) + ").TOOL_RESULT_MAX_CHARS;"
  );
  fs.writeFileSync(tmp, body + '\nmodule.exports={_fitToolResult, TOOL_RESULT_MAX_CHARS};');
  return require(tmp);
}

test('③ 排盘工具必须在子 agent 白名单里', () => {
  const ROLES = require('../agents/sub-agent').ROLES;
  for (const role of ['li', 'dui', 'kun']) {
    assert.ok(ROLES[role] && Array.isArray(ROLES[role].tools), `③ ${role} 没有 tools 白名单`);
    assert.ok(ROLES[role].tools.includes('bazi_calc'),
      `③ ${role} 白名单缺 bazi_calc — 排盘题路由到该角色时无工具可用, 模型只能编整张盘`);
    assert.ok(/八字排盘必须调 bazi_calc/.test(ROLES[role].system),
      `③ ${role} 的 system 没写"排盘必须调 bazi_calc, 不许凭记忆"`);
  }
});

test('① 工具结果裁剪后仍是合法 JSON, 大运完整, 截断留痕', async () => {
  const { _fitToolResult, TOOL_RESULT_MAX_CHARS } = loadFit();
  assert.ok(TOOL_RESULT_MAX_CHARS > 6000, `①b 额度还停在 6000 (实为 ${TOOL_RESULT_MAX_CHARS}) — bazi_calc 90% 数据仍看不见`);

  const { TOOLS } = require('../modules/tools');
  const args = { year: 1978, month: 7, day: 14, hour: 23, minute: 0, gender: 'male' };

  // ---- ①A 默认档: 现在就该**整份装得下**, 一个字符都不许被裁 -------------
  // 2026-10-21: liunian 的流月明细(占原结果 82%)改成要显式要才给, 默认返回从
  // 53,423 → 9,467 字符, 落在 24,000 预算以内。
  // 结果就是**不再触发裁剪** —— 这是本轮最想要的: 被砍掉的部分会招来一整轮
  // 满世界 find/grep 的"找数据"行动 (E2E 实跑 16 次 exec_command 就是这么来的)。
  // 所以这里从"验证裁剪"改成"验证不裁剪", 裁剪那一支挪到 ①B 单独测。
  const lean = await TOOLS.bazi_calc({ params: args });
  const leanRaw = JSON.stringify(lean);
  assert.ok(leanRaw.length <= TOOL_RESULT_MAX_CHARS,
    `①A-1 默认返回 ${leanRaw.length} 字符 > 预算 ${TOOL_RESULT_MAX_CHARS} — 还是会撞上裁剪, `
    + '模型又会去满世界找它看不见的那半截');
  const leanParsed = JSON.parse(_fitToolResult(lean));
  assert.ok(!leanParsed._truncated, '①A-2 默认档不该被裁剪');
  assert.ok(leanParsed.data && leanParsed.data.pillars && leanParsed.data.pillars.dayun, '①A-3 大运字段丢失');
  assert.strictEqual(leanParsed.data.pillars.dayun.列表[0].干支, '庚申', '①A-4 大运第一条对不上');
  assert.strictEqual(leanParsed.data.pillars.dayun.列表[0].起始年份, 1986, '①A-5 大运起始年份对不上');
  // 省掉的是流月明细, 不是流年本身 —— 90 条流年一个都不能少
  assert.ok(Array.isArray(leanParsed.data.pillars.liunian) && leanParsed.data.pillars.liunian.length >= 90,
    `①A-6 流年只剩 ${(leanParsed.data.pillars.liunian || []).length} 条`);
  assert.ok(!leanParsed.data.pillars.liunian[0].流月, '①A-7 默认档不该带流月明细');
  // 少给的东西必须**说清楚**, 不能静默省 (铁律一: 注释 ≠ 隔离, 机制要显式)
  assert.ok(/liunian_months=true/.test(leanParsed.data.note),
    '①A-8 note 没告诉模型流月怎么补回来 — 模型会改口说"流月数据缺失"');

  // ---- ①B 要全量时(liunian_months: true): 裁剪机制仍必须成立 ----------------
  const r = await TOOLS.bazi_calc({ params: Object.assign({ liunian_months: true }, args) });
  const raw = JSON.stringify(r);
  assert.ok(raw.length > TOOL_RESULT_MAX_CHARS,
    `bazi_calc 全量档返回 ${raw.length} 字符, 应超过预算 ${TOOL_RESULT_MAX_CHARS} —— `
    + '要么流月又被塞回去了, 要么预算被调大了, 两条都要同步复核本测试');

  const fit = _fitToolResult(r);
  assert.ok(fit.length > 6000, '①c 模型可见量没超过旧截断线');
  let parsed = null;
  try { parsed = JSON.parse(fit); }
  catch (e) { assert.fail('①d 裁剪后不是合法 JSON — 模型会读到半截数据: ' + e.message); }

  // 模型把 1986 答成"辛酉", 真值是"庚申" —— 这条必须在可见范围内
  assert.ok(parsed.data && parsed.data.pillars && parsed.data.pillars.dayun, '①e 大运字段丢失');
  assert.strictEqual(parsed.data.pillars.dayun.列表[0].干支, '庚申', '①f 大运第一条被裁掉了');
  assert.strictEqual(parsed.data.pillars.dayun.列表[0].起始年份, 1986, '①g 大运起始年份对不上');

  // 截断必须留痕, 且点名丢了什么 —— 否则模型不知道"没看到" ≠ "不存在"
  assert.ok(parsed._truncated, '①h 裁剪后没有 _truncated 说明, 模型会以为数据是完整的');
  assert.ok(/liunian/.test(parsed._truncated), '①i _truncated 没点名被砍的字段');

  // 小结果不许被加工
  const small = { ok: true, data: { a: 1 } };
  assert.deepStrictEqual(JSON.parse(_fitToolResult(small)), small, '①j 小结果不该被裁剪加工');

  // 非 JSON 的字符串结果也要留痕, 不能静默截
  const outStr = _fitToolResult('x'.repeat(30000));
  assert.ok(outStr.length <= TOOL_RESULT_MAX_CHARS + 300, '①k 字符串结果超预算');
  assert.ok(/已截断/.test(outStr), '①l 字符串结果截断没留标记');

  // 调用点必须真的接上了, 不能还留着静默 slice
  assert.ok(!/JSON\.stringify\(execResult\)\.slice\(0, 6000\)/.test(loopSrc),
    '①m execResult 回灌仍在用 slice(0, 6000) 静默截断 — 换掉了但没真接上');
  assert.ok(!/JSON\.stringify\(verifyResult\)\.slice\(0, 6000\)/.test(loopSrc),
    '①n verifyResult 回灌仍在用 slice(0, 6000) 静默截断');
});


// ── ④ 子 agent 工具调用解析 + 工具账 ──────────────────────────────────────────
// MiniMax-M3.1-Flash 在子 agent 里会在四种调用形态间摇摆, 原来只认两种, 另外两种
// 被当正文丢掉 → 该轮工具一次不执行, sub-agent 直接把 XML 当 summary 返回。
// toolsUsed 则压根没在返回值里, dispatcher 两处统计恒为 0, 每个 fixed_flow 会话
// 在 outcomes 里都是"0 工具"的假账, runtime verdict 也据此误判 partial。
test('④ 四种工具调用形态都要解析出来, HTML 不能误判', () => {
  const sa = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');
  const i = sa.indexOf('function extractToolCalls');
  const j = sa.indexOf('function normalizeToolArgs');
  const k = sa.indexOf('\n}\n', sa.indexOf('return value;\n}', j)) + 3;
  assert.ok(i > 0 && j > i && k > j, '④ 抠不出 extractToolCalls 实现');
  const tmp = path.join(os.tmpdir(), '_pangu_extract_calls.js');
  fs.writeFileSync(tmp, sa.slice(i, k) + '\nmodule.exports={extractToolCalls};');
  const { extractToolCalls } = require(tmp);
  const known = new Set(['bazi_calc']);
  const zb = '\u200b';

  const forms = {
    'MiniMax 裸标签 <bazi_calc>{...}</bazi_calc>': '<bazi_calc>{"year":1978,"month":7}</bazi_calc>',
    '标准 <tool name=...>...</tool>': '<tool name="bazi_calc">{"year":1978}</tool>',
    'JSON 信封 <tool_call>{...}</tool_call>': '<' + zb + 'tool_call>{"name":"bazi_calc","arguments":{"year":1978}}</' + zb + 'tool_call>',
    'JSON 信封 (无 ZWSP)': '<tool_call>{"name":"bazi_calc","arguments":{"year":1978}}</tool_call>',
    '混合形态(实测踩到的那次)': '<' + zb + 'tool_call>tool name="bazi_calc">{"year":1978} \n</' + zb + 'tool_call>',
  };
  for (const [name, raw] of Object.entries(forms)) {
    const got = extractToolCalls(raw, known);
    assert.strictEqual(got.length, 1, `④ ${name} 没解析出工具调用 (实际 ${got.length} 个)`);
    assert.strictEqual(got[0].name, 'bazi_calc', `④ ${name} 工具名解析错`);
    assert.strictEqual(got[0].args.year, 1978, `④ ${name} 参数没解析出来`);
  }
  // 正文里的 HTML 不能被当工具调用
  assert.strictEqual(extractToolCalls('这是 <div>说明</div> 和 <span>文本</span>', known).length, 0,
    '④b 正文 HTML 被误当成工具调用');
  // 白名单外的工具名不认
  assert.strictEqual(extractToolCalls('<some_random_thing>{"a":1}</some_random_thing>', known).length, 0,
    '④c 白名单外的标签被当成了工具调用');
});

test('⑤ sub-agent 返回值必须带 toolsUsed, 否则 dispatcher 账目恒为 0', () => {
  const sa = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');
  assert.ok(/toolsUsed\s*=\s*realToolResults\.map/.test(sa),
    '⑤ sub-agent 返回值不带 toolsUsed — dispatcher 的 tools_used / real_tool_calls_total 恒为 0');
  // dispatcher 确实在读这个字段, 两处
  const disp = fs.readFileSync(path.join(MODULES, 'j2_dispatcher.js'), 'utf8');
  const reads = (disp.match(/r\.result && r\.result\.toolsUsed|r\.result\.toolsUsed/g) || []).length;
  assert.ok(reads >= 2, `⑤ dispatcher 只读了 ${reads} 处 toolsUsed, 白名单没回传就全是空`);
});

test('② 域工具空转要有熔断, 不能只管 _PROBE_TOOLS', () => {
  // 2026-10-23 (第 73 批): 判定逻辑收成唯一真源 modules/tool_spin_guard.js。
  // 原来这里 pin 的是 j2_agent_loop.js 里的抄本 (_DOMAIN_TOOL_SPAM_LIMIT / const _saidAnything),
  // 抄本被收走后就变成了"实现细节的墓碑" —— 改成对**唯一真源**断言行为。
  const spin = require(path.join(MODULES, 'tool_spin_guard.js'));
  const spinSrc = fs.readFileSync(path.join(MODULES, 'tool_spin_guard.js'), 'utf8');

  assert.ok(Number.isFinite(spin.DOMAIN_TOOL_SPAM_LIMIT) && spin.DOMAIN_TOOL_SPAM_LIMIT > 0,
    '② 缺域工具空转阈值');
  assert.ok(spin.PROBE_TOOLS instanceof Set && spin.PROGRESS_TOOLS instanceof Set,
    '②b 缺名单 (探测类 / 实质进展类)');

  // ②c 熔断不能只统计 _PROBE_TOOLS —— 域工具(bazi_calc/stock_*/web_*)空转也要漏网得住
  //     这里用**行为**验: 同一个域工具连调 N 次(参数每次不同) 必须被判定为空转。
  const g = spin.createToolSpinGuard({});
  for (let i = 0; i < spin.DOMAIN_TOOL_SPAM_LIMIT; i++) {
    g.note([{ name: 'bazi_calc', params: { attempt: i } }],
      [{ name: 'bazi_calc', ok: true, stdout: 'x' }]);
  }
  const hit = g.check({ saidAnything: false, toolsUsed: ['bazi_calc'] });
  assert.ok(hit, '②c 域工具连调超阈值必须被判定为空转 (不能只管 _PROBE_TOOLS)');
  assert.ok(hit.spammed.includes('bazi_calc'),
    '②c 被喊停的工具名要报出来, 域工具必须在其中');

  // ②d 回灌文案要点破"改参数重试 = 试错不是查数据"
  assert.ok(/禁止自己编一个值再去试/.test(spinSrc + loopSrc),
    '②d 回灌文案没点破"改参数重试 = 试错不是查数据"');
});
