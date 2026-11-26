/**
 * tests/planonly-alignment-skip-20261024.test.js — 第 74 批: 拆解轮被词法对齐门误杀
 *
 * 现场 (真实前端会话, ~/.pangu/alignment-blocked.jsonl 里 20 条 desktop-* 全是它):
 *   desktop-1792407402764#main-plan  "已拆 2 刀并行取证（架构真源 + 运行时状态），执行方接手后综合出完整版介绍。"
 *   desktop-1792418689788#main-plan  "已派 2 刀并行（li 排盘解读 / kun 独立核对节气时柱起运），本轮不执行。"
 *   desktop-1792419356913#main-plan  "已派出 3 刀（大运+取用 / 流年断事 / 独立核验），等执行方回报后综合答复。"
 *   desktop-1792419621494#main-plan  "已拆 2 刀并行派出：li 做命盘结构层…zhen 做卦象层…"
 *   desktop-1792418689788#main-plan  "已派 2 刀（li 解读层 / kun 事实层），执行方接手。"
 * → 全部带 `#main-plan` 后缀 = 拆解轮 (j2_dispatcher 的 planOnlyDispatch)。
 * → 每条都被记 **两笔** (no_summary_fallback + no_summary_fallback_best_spoken_also_blocked)。
 *
 * 为什么拆解轮不该被这道门审 (机制层):
 *   拆解轮的唯一工具是 dispatch_subagents, llm-cost 里 tools=0 ——
 *   那个工具产出的**就是这份拆解本身** ⇒ 拆解轮**结构上不可能有"工具证据"**。
 *   门判它"结论没过证据核验"是审错了对象。
 *   而且它的输出写进 _makeSinkRes sink (j2_dispatcher.js:1812), 主人一个字都看不见 ——
 *   ⇒ 被拦的唯一后果是: 审计账本被污染 + ALIGNMENT_RETRY 白烧两次 LLM 往返。
 *
 * ⚠️ 为什么 2026-10-18 那次修**没修好** (本批从现场挖出来的真原因):
 *   那一版把跳过逻辑放在**终局 guardFinalText 之后**:
 *     5153  finalText = guardFinalText(finalText)   ← 在这里被拦 → finalText = ''
 *     5186  if (_isPlanOnlyTurn && finalAlignmentBlocked) → 只清**标志**, 没还原**文本**
 *     5258  if (realToolsUsed.length > 0 && !finalText) → 甩 ⚠️ 模板
 *   ⇒ 顺序反了: 跳过逻辑执行时 finalText **已经被清空**, 它清的那个标志救不回任何东西。
 *   这就是"代码里明明写了跳过, 现场还是被拦"的真原因 —— **逻辑在, 但够不到**。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-planonly-74-'));
process.env.PANGU_HOME = path.join(TMP, 'home');
process.env.PANGU_PLAN_DIR = path.join(TMP, 'plans');
process.env.PANGU_TASK_DIR = path.join(TMP, 'tasks');
process.env.PANGU_SESSIONS_DIR = path.join(TMP, 'sessions');
process.env.PANGU_AGENTDB_DIR = path.join(TMP, 'agentdb');
fs.mkdirSync(process.env.PANGU_HOME, { recursive: true });

const CORE = path.join(__dirname, '..');
const M = (p) => require(path.join(CORE, p));

const loopSrc = fs.readFileSync(path.join(CORE, 'modules', 'j2_agent_loop.js'), 'utf8');
const dispSrc = fs.readFileSync(path.join(CORE, 'modules', 'j2_dispatcher.js'), 'utf8');

// 现场原文 (一字不改, 从 alignment-blocked.jsonl 里抄的)
const PLAN_TEXTS = [
  '已拆 2 刀并行取证（架构真源 + 运行时状态），执行方接手后综合出完整版介绍。',
  '已派 2 刀并行（li 排盘解读 / kun 独立核对节气时柱起运），本轮不执行。',
  '已派出 3 刀（大运+取用 / 流年断事 / 独立核验），等执行方回报后综合答复。',
];

function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// ══════════════════════════════════════════════════════════════
// ① 前提: 现场那三句确实会被词法门拦 (判据的前提, 不成立就没意义)
// ══════════════════════════════════════════════════════════════

test('前提: 现场那三句拆解文本确实过不了词法对齐门', () => {
  const { guardAnswer, alignmentQuestion } = M('modules/answer_alignment.js');
  const pairs = [
    ['全面介绍一下你自己', PLAN_TEXTS[0]],
    ['如何走出现在困', PLAN_TEXTS[1]],
    ['1991、11', PLAN_TEXTS[2]],
  ];
  for (const [q, a] of pairs) {
    const g = guardAnswer(alignmentQuestion(q), a, '', '');
    assert.equal(g.blocked, true,
      `「${a.slice(0, 20)}…」必须被拦 —— 不成立的话下面的判据测不到真东西`);
  }
});

// ══════════════════════════════════════════════════════════════
// ② 结构层: 跳过逻辑必须在终局 guardFinalText **之前**
// ══════════════════════════════════════════════════════════════

test('跳过逻辑必须落在终局 guardFinalText 之前 (顺序反了 = 够不到)', () => {
  const code = stripComments(loopSrc);
  // 终局那个 else-if 分支的起点
  const termIdx = code.indexOf('} else if (finalText) {');
  assert.ok(termIdx > 0, '要找到终局那个 else-if 分支');
  // 分支内必须有「拆解轮不调 guardFinalText」这个分叉
  const branch = code.slice(termIdx, termIdx + 2600);
  const skipAt = branch.indexOf('if (_isPlanOnlyTurn) {');
  assert.ok(skipAt > 0, '终局分支里必须有拆解轮分叉');
  const guardAt = branch.indexOf('guardFinalText(finalText)');
  assert.ok(guardAt > 0, '终局分支里必须有 guardFinalText 调用');
  assert.ok(skipAt < guardAt,
    '拆解轮分叉必须在 guardFinalText **之前** —— '
    + '放后面就是"逻辑在但够不到" (2026-10-18 那版就死在这儿)');
  // 分叉的两条腿: 拆解轮不调门, 其它轮照调
  assert.match(branch, /if \(_isPlanOnlyTurn\) \{[\s\S]{0,400}?\} else \{[\s\S]{0,200}?guardFinalText\(finalText\)/,
    '必须是 if/else 两条腿 —— 不是"先判后跳", 是"拆解轮压根不调这道门"');
});

test('_isPlanOnlyTurn 必须声明在函数作用域 (块内声明 ⇒ 后面用不到 ⇒ ReferenceError)', () => {
  const code = stripComments(loopSrc);
  const declAt = code.indexOf('const _isPlanOnlyTurn = Boolean(opts && opts.planOnlyDispatch);');
  assert.ok(declAt > 0, '要有这个声明');
  const useAt = code.indexOf('while (!_isPlanOnlyTurn && _alignNudges < 2');
  assert.ok(useAt > 0, 'ALIGNMENT_RETRY 的 while 要用这个判据');
  assert.ok(declAt < useAt, '声明必须在使用之前');
  // 声明不能缩在某个 else-if 块里 —— 那样块外的 while 拿不到 (块作用域 ⇒ ReferenceError)。
  //
  // ⚠️ 这里**不能**用 `.trim()` 比缩进 —— trim 会把缩进洗掉, 缩进断言就永远真 (空枪)。
  // 用**结构**判: 声明必须在终局那个 else-if 块**之前** (在它之前 = 函数作用域)。
  const termIdx = code.indexOf('} else if (finalText) {');
  assert.ok(termIdx > 0, '要找到终局那个 else-if 块');
  assert.ok(declAt < termIdx,
    '声明必须在终局 else-if 块**之前** —— 缩在块里就是块作用域, '
    + 'ALIGNMENT_RETRY 的 while 在块外拿不到 ⇒ 运行时 ReferenceError');
  // 再比一次同级缩进 (与紧挨着的函数级 const 对齐) —— 双保险。
  const declLineStart = code.lastIndexOf('\n', declAt) + 1;
  const declIndent = code.slice(declLineStart, declAt);
  const refIdx = code.indexOf('const _SYS_GUARD_TEXT_RE');
  assert.ok(refIdx > 0, '要找到同级的函数级 const 当参照');
  const refLineStart = code.lastIndexOf('\n', refIdx) + 1;
  const refIndent = code.slice(refLineStart, refIdx);
  assert.equal(declIndent, refIndent,
    '声明要和函数级 const 同一缩进层级 (不能缩进到块里)');
});

// ══════════════════════════════════════════════════════════════
// ③ e2e: 拆解轮不许甩 ⚠️ 模板, 不许进审计账
// ══════════════════════════════════════════════════════════════

function makeScriptedLLM(script, calls) {
  return async (messages, model, toolsSchema, opts) => {
    const idx = calls.n++;
    const step = script[Math.min(idx, script.length - 1)];
    if (opts && typeof opts.onText === 'function' && step.text) opts.onText(step.text);
    return {
      choices: [{
        message: {
          content: step.text || '',
          tool_calls: (step.tools || []).map((t, i) => ({
            id: 'call_' + idx + '_' + i,
            type: 'function',
            function: { name: t.name, arguments: JSON.stringify(t.params || {}) },
          })),
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };
  };
}

function makeRes() {
  const chunks = [];
  return {
    chunks, writableEnded: false,
    write(s) { chunks.push(String(s)); return true; },
    end() { this.writableEnded = true; },
    text() { return chunks.join(''); },
  };
}

// 审计账写到 ~/.pangu/alignment-blocked.jsonl (os.homedir(), 不是 PANGU_HOME)
// ⇒ 测试里把 HOME 指到临时目录, 免得污染真账本。
const FAKE_HOME = path.join(TMP, 'fakehome');
fs.mkdirSync(FAKE_HOME, { recursive: true });
const REAL_HOME = process.env.HOME;
process.env.HOME = FAKE_HOME;

function auditRecords() {
  const f = path.join(FAKE_HOME, '.pangu', 'alignment-blocked.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

async function runPlanTurn(planText, sid) {
  const loop = M('modules/j2_agent_loop.js');
  const MODEL = { id: 'minimax-m3', context_length: 1000000000 };
  const calls = { n: 0 };
  const script = [
    { text: '', tools: [{ name: 'dispatch_subagents', params: { tasks: [] } }] },
    { text: planText, tools: [] },
  ];
  loop.init({
    _callLLMForAgent: makeScriptedLLM(script, calls),
    _callLLMForAgentStream: async function* () { throw new Error('stream not scripted'); },
    _detectToolCallSupport: async () => true,
    getModelContextLength: () => 1000000000,
    getCurrentModel: () => MODEL,
    _recordSessionToMemory: async () => {},
    _sessionRecall: async () => [],
    _recordEvolution: () => {},
    safeResWrite: (res, s) => res.write(s),
    _j2ExecuteToolCalls: async () => [],
    _j2AppendToolResults: () => {},
    _hasUnclosedToolBlock: () => false,
    path,
    MAX_BODY_BYTES: 10 * 1024 * 1024,
  });
  const res = makeRes();
  const req = { on() {}, aborted: false };
  await loop._runAgentLoopLegacyStream(
    [{ role: 'user', content: '全面介绍一下你自己' }],
    MODEL, req, res,
    {
      sessionId: sid,
      userInput: '全面介绍一下你自己',
      reqBody: { session_id: sid },
      role: 'main',
      planOnlyDispatch: true,   // ← 拆解轮的身份标记
    },
  );
  return res;
}

test('e2e: 拆解轮不许甩 ⚠️ 模板 (那是给主人看的, 而拆解轮根本不进主气泡)', async () => {
  const sid = 'plan74-' + Date.now();
  const res = await runPlanTurn(PLAN_TEXTS[0], sid);
  const sse = res.text();
  assert.doesNotMatch(sse, /⚠️\s*已执行相关工具，但最终总结没有通过核验/,
    '拆解轮不许甩「重新执行该任务」模板\n--- SSE ---\n' + sse.slice(-2000));
  assert.doesNotMatch(sse, /⚠️\s*我的结论未通过证据核验/,
    '拆解轮不许甩「我的结论未通过证据核验」模板');
});

test('e2e: 拆解轮不许进审计账 (它不是被拦, 是压根不该被审)', async () => {
  const before = auditRecords().length;
  await runPlanTurn(PLAN_TEXTS[2], 'plan74-audit-' + Date.now());
  const after = auditRecords();
  assert.equal(after.length, before,
    '拆解轮不许写 alignment-blocked.jsonl —— '
    + '那份账本是「答复门误杀了什么」的索引, 混进不该审的对象会让统计翻倍'
    + '\n新增: ' + JSON.stringify(after.slice(before)));
});

// ══════════════════════════════════════════════════════════════
// ④ 反向护栏 + 双重记账
// ══════════════════════════════════════════════════════════════

test('反向护栏: 非拆解轮照审 (别把门放平)', () => {
  const code = stripComments(loopSrc);
  // ALIGNMENT_RETRY 的 while 必须照旧认这些条件
  const wIdx = code.indexOf('while (!_isPlanOnlyTurn && _alignNudges < 2');
  assert.ok(wIdx > 0, 'ALIGNMENT_RETRY 的 while 还在');
  const w = code.slice(wIdx, wIdx + 400);
  for (const cond of ['_alignNudges < 2', 'finalAlignmentBlocked', '!finalText',
    '!taskDoneAccepted', '!_partialDeliveryOk', 'realToolsUsed.length > 0']) {
    assert.ok(w.includes(cond), `原有的放行条件 \`${cond}\` 不许被摘掉`);
  }
  // 判据不能改成 suppressOutcomeRecord (子 agent 也带它, 而子 agent 的产出要进 synthesis)
  assert.ok(!/_isPlanOnlyTurn\s*=\s*[^;]*suppressOutcomeRecord/.test(code),
    '判据只能认 planOnlyDispatch —— 用 suppressOutcomeRecord 会把真正该审的对象一起放行');
});

test('审计账一次执行只记一笔 (原来记两笔 ⇒ 按 reason 统计会翻倍)', () => {
  const code = stripComments(loopSrc);
  // _noSummaryFallback 收 reason 参数
  assert.match(code, /const _noSummaryFallback = \(reason\)/,
    '_noSummaryFallback 必须收 reason 参数');
  assert.match(code, /_auditBlocked\(reason \|\| 'no_summary_fallback'\)/,
    '记账走参数, 不在函数里硬写死 reason');
  // best_spoken 分支: 只能有一处记账, 不许先 audit 再调 fallback (那是两笔)
  const bsIdx = code.indexOf('no_summary_fallback_best_spoken_also_blocked');
  assert.ok(bsIdx > 0, 'best_spoken 的 reason 还在');
  const ctx = code.slice(Math.max(0, bsIdx - 220), bsIdx + 260);
  assert.doesNotMatch(ctx, /_auditBlocked\('no_summary_fallback_best_spoken_also_blocked'\)/,
    'best_spoken 分支不许自己再调 _auditBlocked —— reason 已经走 _noSummaryFallback 的参数了');
  assert.match(ctx, /_noSummaryFallback\('no_summary_fallback_best_spoken_also_blocked'\)/,
    'best_spoken 分支必须把 reason 交给 _noSummaryFallback');
});

test('派发轮的调用点确实带着 planOnlyDispatch (判据要有真来源)', () => {
  const callAt = dispSrc.indexOf('_runAgentLoopLegacyStream(_planMessages');
  assert.ok(callAt > 0, '必须真的派拆解轮');
  const planCall = dispSrc.slice(callAt, callAt + 3000);
  assert.match(planCall, /planOnlyDispatch:\s*true/,
    '派拆解轮时必须显式传 planOnlyDispatch: true —— 否则判据读到 undefined, 又变回审拆解轮');
  assert.match(planCall, /_makeSinkRes\(res, 'kan'/,
    '拆解轮的输出写进 sink, 主人看不到 —— 这是「不该审」的另一半理由');
});

test.after(() => {
  if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME;
});

