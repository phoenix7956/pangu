'use strict';
/**
 * tests/reasoning-only-not-answer-20261025.test.js
 * 第 88 批 —— 「只回思考」不许被当成答案交给主人
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 起因 (第 86 批已经把**综合层**那一半修完了: 「只回思考 ⇒ 重试一次 ⇒ 再兜底」)
 *
 * 这一批修的是**另外两半**: 子 agent 循环 (直答轮 / fixed_flow 都走它)。
 *
 * ① 真 bug —— nudge 计数器**从来没声明过**
 *    `j2_agent_loop.js` 里 `_reasoningOnlyNudges` 出现 3 次 (用), 声明 0 次。
 *    兄弟计数器 (_emptyPlanNudges / _promiseNudges / _lipServiceNudges …)
 *    全都在同一处声明, 唯独它漏了。
 *    漏声明的后果不是「计数器不准」, 是**整轮炸掉**:
 *      `if (_hasReasoningOnly && round < maxRounds - 1 && _reasoningOnlyNudges < 3)`
 *      第三个条件要**读**这个变量 —— 读一个未声明的标识符,
 *      无论 sloppy 还是 strict 都是 **ReferenceError**
 *      (sloppy 只允许「赋值」时建隐式全局, 「读」照样抛)。
 *    ⇒ 只要模型在**非最后一轮**只回思考, 整个主循环当场抛异常, 那一轮的产出全丢。
 *    ⇒ 这条「只回思考 ⇒ nudge 再问一次」的守卫**从来没生效过** ——
 *      它每次都是在要读那个变量的那一刻就炸了。
 *
 * ② legacy 流式路**从来没有**「只回思考」检测
 *    native 路有 (`_hasReasoningOnly`), legacy 路一路没有。
 *    而 llm_caller 的流层在「整条流零 content」时会把 reasoning 缓冲**当正文 yield 出来**
 *    (2026-07-28 的 compat: 只回 reasoning_content 的模型不能被打死),
 *    于是 legacy 路的思考直接进了 textContent ⇒ 可以变成最终答复。
 *
 * ③ native 路 nudge 用尽后, 思考仍会变成 finalText
 *    (3433/3458/3471 那几处 `finalText = textContent`)。
 *
 * 修法: **不靠「文本像不像思考」猜** (拿词当判据是 2026-10-25 一整天在治的病),
 *   而是接住 llm_caller 早就有的 `opts.onReasoningOnly(chars)` 契约 (第 86 批加的),
 *   把「这条流没有正文」这个**事实**如实上报; 思考进历史, 但**不进答案**。
 *
 * ⚠ 硬约束:
 *   · 2026-07-28 那批「只回思考」的模型 (qwen3.6 / deepseek-r1) **不能被打死**
 *     —— 流层行为一个字不许改, 思考照旧交出去;
 *   · 「有正文时 reasoning 一律不进流」的老契约不许破;
 *   · 术数支线 apps/core/64i/ 一行不许碰。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');

const M = (p) => require(path.join(__dirname, '..', p));
const llmCaller = M('modules/llm_caller.js');

const CORE = path.join(__dirname, '..');
const LOOP_PATH = path.join(CORE, 'modules', 'j2_agent_loop.js');

llmCaller.init({
  _config: { llm: { models: [], openai_base_url: '', temperature: 0.3 } },
  fs, path, os, https: require('https'), http,
  PRESETS: {}, PANGU_SYSTEM_PROMPT: '你是测试用的最小身份。',
});

const registry = M('modules/model_registry.js');
const _origGetContextLength = registry.getContextLength;
registry.getContextLength = function (id) {
  if (id === 'fake-reason-b88') return 65536;
  return _origGetContextLength.call(this, id);
};

function sseLine(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }
function dContent(c) { return sseLine({ choices: [{ index: 0, delta: { content: c } }] }); }
function dReasoning(r) { return sseLine({ choices: [{ index: 0, delta: { reasoning_content: r } }] }); }

async function startServer(handler) {
  const open = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { open.push(res); handler(req, res); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return {
    url: 'http://127.0.0.1:' + srv.address().port,
    close: () => new Promise(r => { for (const res of open) { try { res.destroy(); } catch (_) {} } srv.close(r); }),
  };
}

function localModel(url) {
  return {
    id: 'fake-reason-b88', name: 'fake-reason-b88', provider: 'lmstudio',
    endpoint: url, protocol: 'openai', context_length: 65536,
  };
}

async function drain(gen) {
  let text = '';
  for await (const d of gen) text += String(d || '');
  return text;
}

function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
}

const LOOP_SRC = fs.readFileSync(LOOP_PATH, 'utf8');
const LOOP_CODE = stripComments(LOOP_SRC);

// ═════════════════════════════════════════════════════════════════════════════
// A. 真调: llm_caller 的契约 (legacy 路接线依赖它)
// ═════════════════════════════════════════════════════════════════════════════

test('A1 整条流零正文 ⇒ onReasoningOnly 上报一次, 且思考仍照旧交出去 (老契约不许破)', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(dReasoning('We need read the files first.'));
    res.write(dReasoning('Then synthesize.'));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const seen = [];
    const text = await drain(llmCaller._callLLMForAgentStream(
      [{ role: 'user', content: '分析一下' }], localModel(s.url), [],
      { onReasoningOnly: (n) => seen.push(n) }));
    assert.equal(seen.length, 1, '零正文必须**恰好**上报一次, 实际 ' + seen.length);
    assert.ok(seen[0] > 0, '上报字数必须 > 0');
    assert.match(text, /We need read the files first/,
      '2026-07-28 那批模型靠这个活着 —— 思考照旧交出去');
  } finally { await s.close(); }
});

test('A2 有正文 ⇒ onReasoningOnly 一次都不许被调', async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(dReasoning('先想 '));
    res.write(dContent('答案 '));
    res.write('data: [DONE]\n\n');
    res.end();
  });
  try {
    const seen = [];
    const text = await drain(llmCaller._callLLMForAgentStream(
      [{ role: 'user', content: '分析一下' }], localModel(s.url), [],
      { onReasoningOnly: (n) => seen.push(n) }));
    assert.equal(seen.length, 0, '有正文却上报「零正文」⇒ 上报条件写错了');
    assert.equal(text, '答案 ', '老契约不许破');
  } finally { await s.close(); }
});

// ═════════════════════════════════════════════════════════════════════════════
// B. 结构守卫: nudge 计数器不许再漏声明
// ═════════════════════════════════════════════════════════════════════════════

test('B1 每一个 nudge 计数器都必须声明 —— 漏声明 = sloppy 模式下的全局泄漏', () => {
  // 用到的计数器标识符 (排除属性访问 obj._xxxNudges)
  const used = new Set();
  const re = /(?<![\w.])_(\w*Nudges)\b/g;
  let m;
  while ((m = re.exec(LOOP_CODE))) used.add('_' + m[1]);
  assert.ok(used.size >= 5, '至少得扫到几个计数器, 实得 ' + used.size);
  const missing = [];
  for (const name of used) {
    const declared = new RegExp('(let|const|var)\\s+' + name + '\\s*=');
    if (!declared.test(LOOP_CODE)) missing.push(name);
  }
  assert.equal(missing.length, 0,
    '这些计数器被用了却没声明 ⇒ sloppy 模式下会变成**全局变量**, 跨会话共享, '
    + '别人的会话用掉额度之后这条守卫对所有人永久失效:\n' + missing.join('\n'));
});

test('B2 _reasoningOnlyNudges 必须声明, 且声明在所有使用点之前', () => {
  const declIdx = LOOP_CODE.search(/(let|const|var)\s+_reasoningOnlyNudges\s*=/);
  assert.ok(declIdx >= 0, '必须声明 —— 原来它被用了 3 次却一次都没声明');
  const uses = [];
  const re = /(?<![\w.])_reasoningOnlyNudges\b/g;
  let m;
  while ((m = re.exec(LOOP_CODE))) uses.push(m.index);
  assert.ok(uses.length >= 3, '至少 3 处使用, 实得 ' + uses.length);
  for (const u of uses) {
    assert.ok(u > declIdx, '使用点必须晚于声明 (TDZ)');
  }
});

test('B3 变异: 把声明删掉, B1 这条守卫必须响 —— 证明它有牙', () => {
  const mutated = LOOP_CODE.replace(/(let|const|var)\s+_reasoningOnlyNudges\s*=\s*0\s*;/, '');
  assert.notEqual(mutated, LOOP_CODE, '变异必须真的改动了源码 (否则这条测试是空转)');
  const used = new Set();
  const re = /(?<![\w.])_(\w*Nudges)\b/g;
  let m;
  while ((m = re.exec(mutated))) used.add('_' + m[1]);
  const missing = [];
  for (const name of used) {
    if (!new RegExp('(let|const|var)\\s+' + name + '\\s*=').test(mutated)) missing.push(name);
  }
  assert.ok(missing.includes('_reasoningOnlyNudges'),
    '删掉声明后守卫必须抓到它 —— 实得 missing=' + JSON.stringify(missing));
});

test('B4 真证: 读一个未声明的标识符 = ReferenceError (这就是这个 bug 的病根)', () => {
  // sloppy 语义下: **赋值**未声明变量会建隐式全局, 但**读**照样抛。
  // 3160 行那个守卫的第三个条件正是「读」⇒ 必炸。
  const ctx = vm.createContext({});
  vm.runInContext('function guard(hasRo, round, maxRounds){ return (hasRo && round < maxRounds - 1 && __probeNudge < 3); }', ctx);

  const shortCircuited = vm.runInContext('guard(false, 0, 6)', ctx);
  assert.equal(shortCircuited, false, '前一个条件为 false ⇒ 短路, 不读那个变量 ⇒ 不炸');

  assert.throws(() => vm.runInContext('guard(true, 0, 6)', ctx), /__probeNudge is not defined/,
    '只回思考 + 非最后一轮 ⇒ 必须炸 —— 这就是原来每次都炸的地方');

  const lastRound = vm.runInContext('guard(true, 5, 6)', ctx);
  assert.equal(lastRound, false, '最后一轮也不读 (round < maxRounds-1 为 false) ⇒ 最后一轮不炸, 但也永远不 nudge');
});

test('B5 声明补上以后, 同一条守卫必须能真跑 (nudge 真的会触发)', () => {
  const ctx = vm.createContext({});
  vm.runInContext(
    'let _reasoningOnlyNudges = 0;\n'
    + 'function guard(hasRo, round, maxRounds){ return (hasRo && round < maxRounds - 1 && _reasoningOnlyNudges < 3); }\n'
    + 'function bump(){ if (guard(true, 0, 6)) { _reasoningOnlyNudges++; return true; } return false; }',
    ctx);
  assert.equal(vm.runInContext('bump()', ctx), true, '声明补上 ⇒ nudge 第一次就该触发');
  assert.equal(vm.runInContext('bump()', ctx), true);
  assert.equal(vm.runInContext('bump()', ctx), true);
  assert.equal(vm.runInContext('bump()', ctx), false, '上限 3 次');
  assert.equal(vm.runInContext('_reasoningOnlyNudges', ctx), 3);
});

// ═════════════════════════════════════════════════════════════════════════════
// C. 结构守卫: 两条路都必须有「只回思考」的处置
// ═════════════════════════════════════════════════════════════════════════════

test('C1 legacy 流式路必须接上 onReasoningOnly (它原来一点检测都没有)', () => {
  const callSites = LOOP_CODE.match(/_callLLMForAgentStream\([\s\S]{0,900}?\)\s*=>\s*\{/g) || [];
  assert.ok(callSites.length >= 1, '找不到流式调用点');
  const withCb = callSites.filter(s => /onReasoningOnly\s*:/.test(s));
  assert.equal(withCb.length, callSites.length,
    '每一个 _callLLMForAgentStream 调用点都得传 onReasoningOnly —— '
    + '不传就接不住「这条流没有正文」这个事实, 思考就会直接变成答案');
});

test('C2 native 路: nudge 用尽 ⇒ 思考不许变成答案', () => {
  assert.ok(/REASONING_ONLY_EXHAUSTED/.test(LOOP_CODE),
    'native 路必须有「nudge 用尽」的诚实收口 —— 原来思考会直接变成 finalText');
  // 那段收口赋的 finalText 必须是**常量**, 不许把 textContent (思考) 拼进去
  const seg = LOOP_CODE.slice(LOOP_CODE.indexOf('REASONING_ONLY_EXHAUSTED'));
  const assign = seg.slice(0, 1400);
  const m = assign.match(/finalText\s*=\s*([\s\S]{0,400}?);\n/);
  assert.ok(m, '收口那处必须给 finalText 赋值');
  assert.ok(!/textContent/.test(m[1]),
    '诚实收口那句话里不许夹带 textContent —— 那是模型的思考, 夹进去就等于交了思考');
});

test('C3 legacy 路: 思考不许变成答案', () => {
  assert.ok(/REASONING_ONLY_ROUND/.test(LOOP_CODE), 'legacy 路必须有只回思考的处置');
  const seg = LOOP_CODE.slice(LOOP_CODE.indexOf('REASONING_ONLY_ROUND'));
  const m = seg.slice(0, 1600).match(/finalText\s*=\s*([\s\S]{0,400}?);\n/);
  assert.ok(m, 'legacy 收口必须给 finalText 赋值');
  assert.ok(!/textContent/.test(m[1]), 'legacy 的诚实收口不许夹带思考原文');
});

test('C4 两条路都要清空 textContent —— 思考不进答案, 但仍留在历史里', () => {
  // ⚠ 两处都叫 REASONING_ONLY_ROUND (native 一处、legacy 一处) ⇒ 必须按前缀定位,
  //   否则 indexOf 会抓到 native 那处, 拿它当 legacy 的收口来判。
  const nativeIdx = LOOP_CODE.indexOf('[j2-native] REASONING_ONLY_EXHAUSTED');
  const legacyIdx = LOOP_CODE.indexOf('[j2-stream] REASONING_ONLY_ROUND');
  assert.ok(nativeIdx > 0 && legacyIdx > 0);
  const nativeSeg = LOOP_CODE.slice(nativeIdx, nativeIdx + 1400);
  const legacySeg = LOOP_CODE.slice(legacyIdx, legacyIdx + 1800);
  const nativeAssign = nativeSeg.match(/finalText\s*=\s*[\s\S]{0,400}?;\n/);
  const legacyAssign = legacySeg.match(/finalText\s*=\s*[\s\S]{0,400}?;\n/);
  assert.ok(nativeAssign && nativeAssign[0].includes('只回思考'),
    'native 收口要明说「只回思考」');
  assert.ok(legacyAssign && legacyAssign[0].includes('只回思考'),
    'legacy 收口要明说「只回思考」');
  assert.ok(/messages\.push\(\{\s*role:\s*'assistant'/.test(legacySeg),
    'legacy: 思考必须留在历史里 (模型下一轮看得见自己想过什么)');
});

test('C5 流层的老契约一个字不许动 (思考照旧交出去, 只回思考的模型不能被打死)', () => {
  const callerSrc = fs.readFileSync(path.join(CORE, 'modules', 'llm_caller.js'), 'utf8');
  assert.ok(/yield _reasoningBuf/.test(callerSrc),
    'llm_caller 仍然要把思考 yield 出去 —— 2026-07-28 那批模型靠这个活着');
  assert.ok(!/只回思考.*不许.*交出去/.test(callerSrc),
    '流层不许自己判断「这思考该不该交」—— 那是上层的判据, 流层只如实上报事实');
});

