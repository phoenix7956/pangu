/**
 * tests/lip-service-after-tools-20261023.test.js — 第 73 批: 旁白被当最终答复
 *
 * 实跑现场 (2026-10-23, 会话 b63-guagate, main 角色, 真实用户轮):
 *   主人问「1990年3月15日生男，今天适不适合把手上这个项目的第一步做掉？给个决断。」
 *   模型调完 bazi_calc + risk_assessment 后说:
 *     「主人给了生辰，这是「长期状态 + 此刻时机」两层题。我先把八字盘排出来，再给今天这个动作起一卦定方向。」
 *   下一轮**原样再说一遍**(0 工具调用) → 这一句被当最终答复
 *     → 答复门拦下 → 用户拿 ⚠️ 模板 (拿不到答案)。
 *   账本原文: ~/.pangu/alignment-blocked.jsonl
 *     {"session_id":"b63-guagate","reason":"no_summary_fallback_best_spoken_also_blocked",
 *      "rounds":2,"tools_used":["bazi_calc","risk_assessment"],
 *      "blocked_final":"主人给了生辰，这是「长期状态 + 此刻时机」两层题。我先把八字盘排出来，再给今天这个动作起一卦定方向。"}
 *
 * 为什么既有闸门全漏 (结构层, 不是词表问题):
 *   ① 0 工具的 lip-service 守门要求 toolsUsed.length === 0 —— "调过工具再嘴说"根本没人管
 *   ② R80 LIP_SERVICE_AFTER_TOOLS 那段写在 finalText=textContent; break; **之后**
 *      ⇒ 结构性够不到 (要够到它必须 round===0 且正文 <120 字, 而 round 0 的 toolsUsed 必为空)
 *      ⇒ 而且它调的 _stripSpecialTokensForFinal 全库**没有定义** ⇒ 真复活会 ReferenceError
 *   ③ 复读检测要求 length > 200 —— 这句 51 字, 够不到
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-lip-'));
process.env.PANGU_HOME = path.join(TMP, 'home');
process.env.PANGU_PLAN_DIR = path.join(TMP, 'plans');
process.env.PANGU_TASK_DIR = path.join(TMP, 'tasks');
process.env.PANGU_SESSIONS_DIR = path.join(TMP, 'sessions');
process.env.PANGU_AGENTDB_DIR = path.join(TMP, 'agentdb');
fs.mkdirSync(process.env.PANGU_HOME, { recursive: true });

const CORE = path.join(__dirname, '..');
const M = (p) => require(path.join(CORE, p));

const loop = M('modules/j2_agent_loop.js');
const { isNarrationText, PROMISE_SEQUENCE_RE, LIP_SERVICE_AFTER_TOOLS_RE } = M('modules/guard_patterns.js');
const loopSrc = fs.readFileSync(path.join(CORE, 'modules', 'j2_agent_loop.js'), 'utf8');

// 现场原文 (一字不改, 从 alignment-blocked.jsonl 里抄的)
const B63 = '主人给了生辰，这是「长期状态 + 此刻时机」两层题。我先把八字盘排出来，再给今天这个动作起一卦定方向。';

function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// ══════════════════════════════════════════════════════════════
// ① 判据本身
// ══════════════════════════════════════════════════════════════

test('现场那句旁白必须被认成旁白 (不是结论)', () => {
  assert.equal(isNarrationText(B63), true,
    '现场原文必须命中旁白判据 —— 这是整条链的入口');
  assert.ok(PROMISE_SEQUENCE_RE.test(B63), '「先…再…」两段式要命中');
});

test('_isNarrationAfterTools: 第一遍是 promise, 第二遍是 repeat', () => {
  const first = loop._isNarrationAfterTools(B63, []);
  assert.equal(first, 'promise', '第一次说这句 = 承诺型');
  const second = loop._isNarrationAfterTools(B63, [{ role: 'assistant', content: B63 }]);
  assert.equal(second, 'repeat', '原样再说一遍 = 复读 (卡住, 不是结论)');
});

test('真结论不许被当成旁白 (误伤防护)', () => {
  const real = '决断: 做。今天庚午双忌神, 只做第一步, 做完就收, 不铺前三步。';
  assert.equal(loop._isNarrationAfterTools(real, []), null, '真结论不是旁白');
  assert.equal(isNarrationText(real), false);
  assert.equal(loop._isNarrationAfterTools('收到', []), null, '短句不算旁白');
});

test('归一化后相同才算复读 (差一个空格不算)', () => {
  const msgs = [{ role: 'assistant', content: B63 + '\n\n' }];
  assert.equal(loop._isNarrationAfterTools(B63, msgs), 'repeat');
  const near = [{ role: 'assistant', content: B63 + '另外补一句。' }];
  assert.notEqual(loop._isNarrationAfterTools(B63, near), 'repeat', '内容不同不是复读');
});

// ══════════════════════════════════════════════════════════════
// ② 结构层: 那道闸门原来够不到 / 而且调了个不存在的函数
// ══════════════════════════════════════════════════════════════

test('不许再调那个全库没定义的函数 (R80 那道闸门复活就会 ReferenceError)', () => {
  assert.doesNotMatch(stripComments(loopSrc), /_stripSpecialTokensForFinal\s*\(/,
    '源码里不许调用 _stripSpecialTokensForFinal —— 它全库没有定义, 一旦跑到就是 ReferenceError');
});

test('旁白闸门必须落在「复读熔断把旁白当 finalText」**之前** (落在之后 = 够不到)', () => {
  const code = stripComments(loopSrc);
  const guardIdx = code.indexOf('_isNarrationAfterTools(textContent, messages)');
  assert.ok(guardIdx > 0, 'native 路径必须调这个判据');
  // 锚点是「复读检测」这道熔断 —— 现场就是它把旁白直接 break 成 finalText 的。
  // 不能用全文第一个 `finalText = textContent;` 当锚 (那处在流式分支里, 与本闸门无关),
  // 那样断言就变成"位置对了但测不到真行为"。
  const repeatIdx = code.indexOf('repeat detected');
  assert.ok(repeatIdx > 0, '要找到复读熔断那处');
  assert.ok(guardIdx < repeatIdx,
    '旁白闸门必须在复读熔断**之前** —— 复读熔断会直接 break 并把旁白当 finalText '
    + '(现场就是这么丢答案的)。放在之后就是结构性够不到 (R80 当年就是这么哑的)');
});

test('旁白分支不许把 textContent 直接当答复 (只能出工具结果报告)', () => {
  const code = stripComments(loopSrc);
  const start = code.indexOf('if (_narKind) {');
  assert.ok(start > 0, '旁白分支必须存在');
  // 取旁白分支到下一个同级 if 之前的片段
  const end = code.indexOf('if (isRepeat && round >= 1)', start);
  assert.ok(end > start, '要找到旁白分支的结束位置');
  const branch = code.slice(start, end);
  assert.doesNotMatch(branch, /finalText\s*=\s*textContent/,
    '旁白分支里绝不能把模型那句旁白原样当最终答复 —— 那正是现场的 bug');
});

test('旁白闸门有上限 (不许无限 nudge)', () => {
  const code = stripComments(loopSrc);
  assert.match(code, /_lipAfterToolsNudges < 2/, 'nudge 要有上限, 否则模型能一直蹭');
});

// ══════════════════════════════════════════════════════════════
// ③ native e2e: 旁白不许成为最终答复
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
    chunks, writableEnded: false,
    write(s) { chunks.push(String(s)); return true; },
    end() { this.writableEnded = true; },
    text() { return chunks.join(''); },
  };
}

async function runScripted(script, sid) {
  const MODEL = { id: 'minimax-m3', context_length: 1000000000 };
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
  const messages = [{ role: 'user', content: '1990年3月15日生男，今天适不适合把手上这个项目的第一步做掉？给个决断。' }];
  await loop._runAgentLoopLegacyStream(messages, MODEL, req, res, {
    sessionId: sid, userInput: '1990年3月15日生男，今天适不适合把手上这个项目的第一步做掉？给个决断。',
    reqBody: { session_id: sid },
  });
  return { res, calls };
}

test('native e2e: 调过工具后只输出旁白 → 不许当成最终答复, 要回灌逼它给结论', async () => {
  const sid = 'lip73-' + Date.now();
  const script = [
    { text: B63, tools: [{ name: 'current_time', params: {} }] },   // 有工具 + 旁白
    { text: B63, tools: [] },                                        // 还是旁白, 0 工具
    { text: '决断: 做。只做第一步, 做完就收。', tools: [] },            // 终于给了结论
  ];
  const { res, calls } = await runScripted(script, sid);
  const sse = res.text();
  const injected = calls.seen.flatMap(c => c.msgs)
    .filter(m => m.role === 'system' && /LIP_SERVICE_AFTER_TOOLS/.test(m.content));
  assert.ok(injected.length > 0,
    '旁白必须被回灌拦住 (要有 LIP_SERVICE_AFTER_TOOLS 指令进 messages)\n--- SSE ---\n' + sse.slice(-2500));
  assert.doesNotMatch(sse, /event: final[\s\S]{0,400}主人给了生辰/,
    '那句旁白不许成为最终答复');
});

test('native e2e: 真结论直接收口 (不打扰)', async () => {
  const sid = 'lip73-ok-' + Date.now();
  const script = [
    { text: '决断: 做。今天双忌神, 只做第一步。', tools: [{ name: 'current_time', params: {} }] },
    { text: '决断: 做。今天双忌神, 只做第一步, 做完就收。', tools: [] },
  ];
  const { res, calls } = await runScripted(script, sid);
  const injected = calls.seen.flatMap(c => c.msgs)
    .filter(m => m.role === 'system' && /LIP_SERVICE_AFTER_TOOLS/.test(m.content));
  assert.equal(injected.length, 0, '真结论不许被旁白闸门打扰');
});

