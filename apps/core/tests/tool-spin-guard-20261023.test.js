/**
 * tests/tool-spin-guard-20261023.test.js — 第 73 批: 工具空转守门
 *
 * 实跑现场 (2026-10-23 23:30, 会话 request-1792769303516-b1fe3a, main 角色, 真实用户轮):
 *   「1990年3月15日生男，今天适不适合把手上这个项目的第一步做掉？给个决断。」
 *   服务日志:
 *     tool_start: bazi_calc
 *     tool_start: exec_command  ← node -e "require('sxtwl')" → MODULE_NOT_FOUND
 *     tool_start: exec_command  ← find sxtwl → stdout 空
 *     tool_start: exec_command  ← 自己用儒略日手推
 *     tool_start: wuxing_judge
 *   nativeRounds=5 / llm-cost 277760ms —— 用户屏幕上 200 秒没等到 final。
 *
 * 根因 (机制层): 空转检测**只装在 legacy 分支**, native (实测主路) 一行都没有;
 *   而既有三道闸门都按 "工具名|参数" 分桶 ⇒ 模型每次换参数 ⇒ 桶永远不同 ⇒ 永远不触发。
 *
 * 本测试钉住:
 *   ① 守门逻辑本身 (三条规则 + 阈值 + reset)
 *   ② **native 接线** (主路必须有) —— 这条是本批的核心, 变异要能打红
 *   ③ 唯一真源 (j2_agent_loop 里不许再留第二份阈值抄本)
 *   ④ **误伤防护**: 合法读 5 个文件不许被喊停 (native 上"说过话"没有信息量)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ══ 隔离必须先于任何 require (plan_state/task_checkpoint/task_ledger 加载即锁目录) ══
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-spin-'));
process.env.PANGU_HOME = path.join(TMP, 'home');
// 2026-10-26 第 100 批: 账本目录走唯一真源 (modules/state_paths.js),
// 解析顺序 PANGU_LEDGER_DIR > PANGU_HOME/state/ledger > 生产默认。
// 只设 PANGU_HOME 会被链沙箱里的 PANGU_LEDGER_DIR 抢在前面 ⇒ 账本落到共享沙箱目录,
// 本测试的隔离意图 (自己的 TMP) 就没了。
process.env.PANGU_LEDGER_DIR = path.join(TMP, 'home', 'state', 'ledger');
process.env.PANGU_PLAN_DIR = path.join(TMP, 'plans');
process.env.PANGU_TASK_DIR = path.join(TMP, 'tasks');
process.env.PANGU_SESSIONS_DIR = path.join(TMP, 'sessions');
process.env.PANGU_AGENTDB_DIR = path.join(TMP, 'agentdb');
fs.mkdirSync(process.env.PANGU_HOME, { recursive: true });

const CORE = path.join(__dirname, '..');
const M = (p) => require(path.join(CORE, p));

const {
  createToolSpinGuard, isBarrenResult,
  PROBE_TOOLS, PROGRESS_TOOLS,
  TOOL_NAME_SPAM_LIMIT, DOMAIN_TOOL_SPAM_LIMIT, BARREN_SPAM_LIMIT,
} = M('modules/tool_spin_guard.js');

const loopSrc = fs.readFileSync(path.join(CORE, 'modules', 'j2_agent_loop.js'), 'utf8');

// 剥注释再扫 —— 注释里提到模块名/常量名 ≠ 代码里真用它。
// (踩坑日志: 「注释里出现模块名被守卫当成 require」/「注释里写完整路径:函数名会抢走负例的 replace」)
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
const loopCode = stripComments(loopSrc);

// ── 造结果的小工具 ──────────────────────────────────────────────
const okResult = (name, text) => ({ tc: { name }, execResult: { ok: true, data: { stdout: text } } });
const emptyResult = (name) => ({ tc: { name }, execResult: { ok: true, data: { stdout: '', stderr: '' } } });
const failResult = (name) => ({ tc: { name }, execResult: { ok: false, error: { code: 'X', message: 'boom' } } });

// ══════════════════════════════════════════════════════════════
// ① 守门逻辑本身
// ══════════════════════════════════════════════════════════════

test('R1 探测类: 第 4 次才喊停 (前 3 次不响)', () => {
  const g = createToolSpinGuard();
  for (let i = 0; i < 3; i++) {
    g.note([{ name: 'system_info' }], [okResult('system_info', 'ok')]);
    assert.equal(g.check({ saidAnything: false, toolsUsed: ['system_info'] }), null,
      '第 ' + (i + 1) + ' 次不该响');
  }
  g.note([{ name: 'system_info' }], [okResult('system_info', 'ok')]);
  const hit = g.check({ saidAnything: false, toolsUsed: ['system_info'] });
  assert.ok(hit, '第 4 次必须响');
  assert.deepEqual(hit.spammed, ['system_info']);
});

test('R2 同一个工具连吃两个空 → 第 2 次就响 (本批新增, 抓的就是那次实跑)', () => {
  const g = createToolSpinGuard();
  // 实跑原文: 第一次 MODULE_NOT_FOUND (失败), 第二次 find 出来是空的
  g.note([{ name: 'exec_command' }], [failResult('exec_command')]);
  assert.equal(g.check({ saidAnything: false, toolsUsed: ['exec_command'] }), null,
    '只失败一次不该响 —— 换参数再试一次是合法的排查');
  g.note([{ name: 'exec_command' }], [emptyResult('exec_command')]);
  const hit = g.check({ saidAnything: false, toolsUsed: ['exec_command'] });
  assert.ok(hit, '连吃两个空必须响 —— 这条路已经走不通了');
  assert.deepEqual(hit.spammed, ['exec_command']);
});

test('R2 有内容的工具结果不算 barren (不能把正常取数当成空转)', () => {
  const g = createToolSpinGuard();
  g.note([{ name: 'exec_command' }], [okResult('exec_command', '今日干支: 庚午')]);
  assert.equal(g.check({ saidAnything: false, toolsUsed: ['exec_command'] }), null);
  assert.equal(g.barrenOf('exec_command'), 0, '拿到内容 ⇒ barren 计数要断掉');
  assert.equal(g.hasEvidence(), true);
});

test('R2 连续 barren 会被"有内容"打断 (不是累计, 是连续)', () => {
  // domainLimit 调到 99 = 把 R3 关掉, 单独验 R2 的"连续"语义
  const g = createToolSpinGuard({ domainLimit: 99 });
  g.note([{ name: 'exec_command' }], [failResult('exec_command')]);
  g.note([{ name: 'exec_command' }], [okResult('exec_command', '拿到了')]);
  g.note([{ name: 'exec_command' }], [failResult('exec_command')]);
  assert.equal(g.barrenOf('exec_command'), 1, '中间断过一次 ⇒ 连续计数从头来');
  assert.equal(g.check({ saidAnything: false, toolsUsed: ['exec_command'] }), null);
});

test('native 口径: R3 额外要求"手上没证据" (工具轮正文常为空, 说过话没有信息量)', () => {
  // legacy 口径 (domainRuleNeedsEvidence=false): 有证据也照响
  const legacy = createToolSpinGuard();
  for (let i = 0; i < 3; i++) legacy.note([{ name: 'bazi_calc' }], [okResult('bazi_calc', '盘')]);
  assert.ok(legacy.check({ saidAnything: false, toolsUsed: ['bazi_calc'] }),
    'legacy: 零结论 + 3 次 ⇒ 照响');

  // native 口径: 手里有证据(盘都排出来了) ⇒ 不响, 让它继续
  const native = createToolSpinGuard({ domainRuleNeedsEvidence: true });
  for (let i = 0; i < 3; i++) native.note([{ name: 'bazi_calc' }], [okResult('bazi_calc', '盘')]);
  assert.equal(native.check({ saidAnything: false, toolsUsed: ['bazi_calc'] }), null,
    'native: 手里有盘 ⇒ 不许喊停 (否则读 5 个文件读到第 3 个就被打断)');
});

test('isBarrenResult 认得多种形状 (native / legacy / 0 命中 / 空 content)', () => {
  assert.equal(isBarrenResult({ tc: { name: 'x' }, execResult: { ok: false } }), true);
  assert.equal(isBarrenResult({ name: 'x', ok: false }), true, 'legacy 形状');
  assert.equal(isBarrenResult({ tc: { name: 'x' }, execResult: { ok: true, data: { stdout: '', stderr: '' } } }), true);
  assert.equal(isBarrenResult({ tc: { name: 'x' }, execResult: { ok: true, data: { stdout: 'x', stderr: '' } } }), false);
  assert.equal(isBarrenResult({ tc: { name: 'x' }, execResult: { ok: true, data: { content: '' } } }), true);
  assert.equal(isBarrenResult({ tc: { name: 'x' }, execResult: { ok: true, data: { content: '有' } } }), false);
  assert.equal(isBarrenResult({ tc: { name: 'x' }, execResult: { ok: true, data: { matches: [] } } }), true);
  assert.equal(isBarrenResult({ tc: { name: 'x' }, execResult: { ok: true, data: { matches: [1] } } }), false);
});

test('R3 域工具: 第 3 次 + 一句实质话没说 + 没有写盘进展 → 响', () => {
  const g = createToolSpinGuard();
  for (let i = 0; i < 2; i++) {
    g.note([{ name: 'bazi_calc' }], [okResult('bazi_calc', '盘')]);
    assert.equal(g.check({ saidAnything: false, toolsUsed: ['bazi_calc'] }), null);
  }
  g.note([{ name: 'bazi_calc' }], [okResult('bazi_calc', '盘')]);
  assert.ok(g.check({ saidAnything: false, toolsUsed: ['bazi_calc'] }), '第 3 次 + 零结论该响');
});

test('R3 有实质进展 (写盘/编辑/验收) 不响 —— 合法多调用不误伤', () => {
  const g = createToolSpinGuard();
  for (let i = 0; i < 4; i++) {
    g.note([{ name: 'bazi_calc' }], [okResult('bazi_calc', '盘')]);
  }
  assert.equal(g.check({ saidAnything: false, toolsUsed: ['bazi_calc', 'write_file'] }), null,
    '写过盘就不算空转');
});

test('R3 说了实质结论就不响', () => {
  const g = createToolSpinGuard();
  for (let i = 0; i < 4; i++) g.note([{ name: 'bazi_calc' }], [okResult('bazi_calc', '盘')]);
  assert.equal(g.check({ saidAnything: true, toolsUsed: ['bazi_calc'] }), null);
});

test('reset 之后重新计数 (回灌一次就清零, 不该每轮都喊)', () => {
  const g = createToolSpinGuard();
  g.note([{ name: 'exec_command' }], [failResult('exec_command')]);
  g.note([{ name: 'exec_command' }], [emptyResult('exec_command')]);
  const hit = g.check({ saidAnything: false, toolsUsed: ['exec_command'] });
  assert.ok(hit);
  g.reset(hit.spammed);
  assert.equal(g.countOf('exec_command'), 0);
  assert.equal(g.barrenOf('exec_command'), 0);
  assert.equal(g.check({ saidAnything: false, toolsUsed: ['exec_command'] }), null,
    '清零后不该马上又响');
});

test('阈值常量: 探测类 4 / 域工具 3 / barren 2', () => {
  assert.equal(TOOL_NAME_SPAM_LIMIT, 4);
  assert.equal(DOMAIN_TOOL_SPAM_LIMIT, 3);
  assert.equal(BARREN_SPAM_LIMIT, 2);
  assert.ok(PROBE_TOOLS.has('system_info'));
  assert.ok(PROGRESS_TOOLS.has('write_file'));
});

// ══════════════════════════════════════════════════════════════
// ② 唯一真源 + native 接线 (剥注释后扫)
// ══════════════════════════════════════════════════════════════

test('唯一真源: j2_agent_loop 里不再留第二份阈值抄本', () => {
  assert.doesNotMatch(loopCode, /_PROBE_TOOLS\s*=\s*new Set\(/,
    '探测类名单只能在 tool_spin_guard.js 定义一份');
  assert.doesNotMatch(loopCode, /_DOMAIN_TOOL_SPAM_LIMIT\s*=/,
    '域工具阈值只能在 tool_spin_guard.js 定义一份');
  assert.doesNotMatch(loopCode, /_TOOL_NAME_SPAM_LIMIT\s*=/,
    '探测类阈值只能在 tool_spin_guard.js 定义一份');
  assert.doesNotMatch(loopCode, /_sessionToolNameCalls/,
    'session 级工具名计数表已被守门模块取代');
});

test('native 与 legacy 两条路都接了守门 (主路曾经一道都没有)', () => {
  const requireCalls = loopCode.match(/require\('\.\/tool_spin_guard'\)/g) || [];
  assert.equal(requireCalls.length, 1, '守门只 require 一次 (创建实例), 两条路共用');
  const checks = loopCode.match(/_spinGuard\.check\(/g) || [];
  assert.equal(checks.length, 2, 'native 和 legacy 各一次 check —— 少一次就等于那条路没这道闸门');
  const notes = loopCode.match(/_spinGuard\.note\(/g) || [];
  assert.ok(notes.length >= 3, 'native 记调用+结果, legacy 记调用+结果 ⇒ 至少 3 次 note');
});

test('native 那段接线在源码里 (变异要打的就是这里)', () => {
  // 定位 native 路径: 工具执行之后的守门接线
  const nativeIdx = loopCode.indexOf('TOOL_SPIN_GUARD');
  assert.ok(nativeIdx > 0, 'native 路径必须有 TOOL_SPIN_GUARD 日志标记');
  const window = loopCode.slice(Math.max(0, nativeIdx - 2500), nativeIdx + 500);
  assert.match(window, /_spinGuard\.note\(/, 'native 接线必须先记账');
  assert.match(window, /_spinGuard\.check\(/, 'native 接线必须判定');
  assert.match(window, /tool_loop_alarm/, 'native 接线必须发 SSE 报警');
});

// ══════════════════════════════════════════════════════════════
// ③ native e2e: 剧本化假 LLM, 连续空转必须被拦
// ══════════════════════════════════════════════════════════════

function makeScriptedLLM(script, calls) {
  return async (messages, model, toolsSchema, opts) => {
    const idx = calls.n++;
    const step = script[Math.min(idx, script.length - 1)];
    calls.seen.push({ round: idx, msgs: messages.map(m => ({ role: m.role, content: String(m.content || '') })) });
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
    chunks,
    writableEnded: false,
    write(s) { chunks.push(String(s)); return true; },
    end() { this.writableEnded = true; },
    text() { return chunks.join(''); },
  };
}

test('native e2e: 连续拿空结果换参数重试 → 必须出现 tool_loop_alarm + 停止指令', async () => {
  const loop = M('modules/j2_agent_loop.js');
  const MODEL = { id: 'minimax-m3', context_length: 1000000000 };
  const sid = 'spin73-e2e-' + Date.now();
  const missing = (n) => path.join(TMP, 'no-such-file-' + n + '.txt');
  const script = [
    { text: '', tools: [{ name: 'read_file', params: { path: missing(1) } }] },
    { text: '', tools: [{ name: 'read_file', params: { path: missing(2) } }] },
    { text: '', tools: [{ name: 'read_file', params: { path: missing(3) } }] },
    { text: '结论: 这里没有可读的东西。', tools: [] },
  ];
  const calls = { n: 0, seen: [] };
  loop.init({
    _callLLMForAgent: makeScriptedLLM(script, calls),
    _callLLMForAgentStream: async function* () { throw new Error('stream not scripted'); },
    _detectToolCallSupport: async () => true,   // 强制 native 路径
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
  const messages = [{ role: 'user', content: '把这份文件读出来' }];
  await loop._runAgentLoopLegacyStream(messages, MODEL, req, res, {
    sessionId: sid, userInput: '把这份文件读出来', reqBody: { session_id: sid },
  });
  const sse = res.text();
  assert.match(sse, /event: tool_loop_alarm/,
    '连续拿空结果换参数重试必须被守门拦下 (SSE 要有 tool_loop_alarm)\n--- SSE ---\n' + sse.slice(-2500));
  const injected = calls.seen.flatMap(c => c.msgs)
    .filter(m => m.role === 'system' && /工具空转/.test(m.content));
  assert.ok(injected.length > 0,
    '必须回灌一条 [SYSTEM WARNING: 工具空转] 指令 (只看 SSE 不够 —— 指令要真进 messages)');
});

test('误伤防护 e2e: 读 5 个**有内容**的文件不许被喊停', async () => {
  const loop = M('modules/j2_agent_loop.js');
  const MODEL = { id: 'minimax-m3', context_length: 1000000000 };
  const sid = 'spin73-e2e-ok-' + Date.now();
  const dir = path.join(TMP, 'files');
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 1; i <= 5; i++) {
    const p = path.join(dir, 'f' + i + '.txt');
    fs.writeFileSync(p, '第' + i + '个文件的内容, 足够长不会被裁掉。\n'.repeat(3));
    files.push(p);
  }
  const script = files.map((p) => ({ text: '', tools: [{ name: 'read_file', params: { path: p } }] }));
  script.push({ text: '读完了, 5 个文件都读到了。', tools: [] });
  const calls = { n: 0, seen: [] };
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
  const messages = [{ role: 'user', content: '把这 5 个文件读出来' }];
  await loop._runAgentLoopLegacyStream(messages, MODEL, req, res, {
    sessionId: sid, userInput: '把这 5 个文件读出来', reqBody: { session_id: sid },
  });
  const sse = res.text();
  assert.doesNotMatch(sse, /event: tool_loop_alarm/,
    '合法读 5 个文件不许被喊停 (native 上工具轮正文常为空, 拿"说过话"当解禁条件会误伤)\n--- SSE ---\n' + sse.slice(-2000));
});

