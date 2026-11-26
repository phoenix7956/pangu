'use strict';
/**
 * 第 64 批 · 超时这一族错误的判据
 *
 * ── 现场 (session b63-guagate3, 2026-10-23 12:23:48 起) ────────────────
 *   native 路径问「1990-03-15 生男, 今天适不适合把手上项目第一步做掉」。
 *   第一轮把 reasoning 推了 2980 字 (字符稳定增长, **一个工具都没调**),
 *   390s 总预算到了 → STREAM_TOTAL_TIMEOUT_390s。
 *
 *   这**不是上游挂死** —— 同一个流还在稳定出字, 是盘古自己的墙把它掐了。
 *   (先前一轮排查把它记成「上游挂死」, 是被错误名带偏的。判据是字符曲线, 不是报错名。)
 *
 * ── 病根 ─────────────────────────────────────────────────────────────
 *   超时在项目里有**两份同义分类, 互不相同**:
 *     · slice_death.js     SLICE_DEAD_RE  认 3 种 (缺 STREAM_TOTAL_TIMEOUT)
 *     · j2_loop_shared.js  _isInfraError  认 **0 种**
 *   于是超时不是「基础设施错误」, 落进 native catch 末尾那句
 *   「fallback to legacy J2 XML path」—— **而那条路根本不存在**
 *   (useNative 是 const, 改 nativeToolCallSupported 没人读, !useNative 守卫恒假)。
 *   ⇒ 烧 390s 什么都不交; 外层续跑再**原样**烧一轮 (msgs 12 / inputTokens 16186
 *     两次逐字节同大小 —— 已想的 2980 字全作废, 而且必然再撞同一堵墙)。
 *
 *   2026-10-13 修过一次同型的 (上游 5xx → 静默降级 legacy), **超时这一半没修**。
 *
 * ── 本文件钉的是机制, 不是现状 ────────────────────────────────────────
 *   判据不写「现在超时会被认成基础设施错误」(那是现状, 明天有人改了就红),
 *   而写「超时必须排在原地重试之前」「续想必须先把已想的留在上下文」
 *   「抢救出来的 partial 必须真的带上」—— 这些是**改对了就一直在**的性质。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const CORE = path.join(__dirname, '..');
const TP = require(path.join(CORE, 'modules', 'timeout_policy.js'));
const SHARED = require(path.join(CORE, 'modules', 'j2_loop_shared.js'));
const SLICE = require(path.join(CORE, 'modules', 'slice_death.js'));
const { parseJs } = require('./helpers/js_ast');

function readCode(rel) {
  return fs.readFileSync(path.join(CORE, rel), 'utf8');
}

// 剥注释, 只留真代码。
// 为什么必须剥: 判据扫的是「代码里有没有 X」, 而我自己的说明注释里
// 天天写着 X —— 不剥就是「判据把自己判成违规」(踩坑日志已记过两次)。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// native 路径那个超时分支的**精确**文本。
// 为什么不能「往后切 6000 字符」: 那样会切进后面的 else 分支里 ——
// 于是「超时分支里不许出现 _preferSameLocalRetry」这条判据, 会被**紧挨着的
// 那个 else 分支**里的同名调用判成违规。判据测错了对象, 比没判据更坏。
function timeoutBranch(code) {
  const start = code.indexOf('if (_isTimeoutError(e.message)) {');
  if (start < 0) return null;
  const elseAt = code.indexOf('} else {', start);
  if (elseAt < 0) return null;
  return code.slice(start, elseAt);
}

// ─────────────────────────────────────────────────────────────────────
// 一、分类: 6 种预算类超时, 一个都不能漏; 跟瞬断必须分得开
// ─────────────────────────────────────────────────────────────────────

test('6 种预算类超时一个都不能漏认 (漏一种 = 那一刀会被当成有产出)', () => {
  const expect = [
    'STREAM_TOTAL_TIMEOUT_390s',
    'STREAM_IDLE_TIMEOUT_90s',
    'STREAM_PREFILL_TIMEOUT_300s',
    'LLM_SOCKET_TIMEOUT_300s (上游挂死连接, 已熔断)',
    'LLM_FETCH_TIMEOUT_120s',
    'LLM_ROUND_TIMEOUT',
  ];
  for (const m of expect) {
    assert.strictEqual(TP.isTimeoutError(m), true,
      '这一种超时没被认出来: ' + m + ' —— 认漏了它, 超时就会落进「静默死路」那条分支。');
  }
  assert.strictEqual(TP.TIMEOUT_KINDS.length, expect.length,
    '超时清单的条数变了 —— 增删只改 modules/timeout_policy.js 一处, 别的地方不许另抄。');
});

test('超时与瞬断必须分得开: 混在一起 = 同 prompt 原样重试 = 再撞同一堵墙', () => {
  // 超时不是瞬断
  assert.strictEqual(TP.isConnectionError('STREAM_TOTAL_TIMEOUT_390s'), false,
    '超时被当成瞬断了 —— 会被拿去「原地重试同一个 prompt」, 必然再撞同一堵墙。');
  // 瞬断不是超时
  for (const m of ['ECONNRESET', 'socket hang up', 'fetch failed', 'ECONNREFUSED', 'ETIMEDOUT']) {
    assert.strictEqual(TP.isTimeoutError(m), false,
      '瞬断被当成超时了 —— 瞬断重试有意义(本地端点, 免费), 超时重试没有。');
    assert.strictEqual(TP.isConnectionError(m), true, '瞬断没被认出来: ' + m);
  }
});

test('基础设施错误分类必须认超时 (这一条就是本批那个洞)', () => {
  for (const kind of TP.TIMEOUT_KINDS) {
    assert.strictEqual(SHARED._isInfraError(kind + '_390s'), true,
      kind + ' 不算基础设施错误 ⇒ 落不进快速失败 ⇒ 掉进那句根本不存在的「legacy 降级」。');
  }
  assert.strictEqual(SHARED._isInfraError('ECONNRESET'), true, '瞬断仍必须算基础设施错误');
});

test('「这刀死了」的判定表必须认全 6 种超时', () => {
  for (const kind of TP.TIMEOUT_KINDS) {
    assert.strictEqual(SLICE.SLICE_DEAD_RE.test(kind + '_390s'), true,
      kind + ' 不在死法表里 ⇒ 那一刀被当成「有产出」, 整轮 slice 不放弃, 接着再撞一次。');
  }
});

test('消费者不许自己抄一份超时清单 (两份同义分类必然漂)', () => {
  // 只查**消费者**: j2_loop_shared (分类/文案) 与 slice_death (死法表)。
  // 生产者 (llm_caller / j2_agent_loop) 造名字, 那里当然有字面量。
  for (const rel of ['modules/j2_loop_shared.js', 'modules/slice_death.js']) {
    const code = stripComments(readCode(rel));
    for (const kind of TP.TIMEOUT_KINDS) {
      assert.ok(!code.includes(kind),
        rel + ' 里出现了超时名字「' + kind + '」的副本 —— 超时清单只允许存在 modules/timeout_policy.js 一处。');
    }
  }
});

// ─────────────────────────────────────────────────────────────────────
// 二、抢救: 已经流出来的东西不许跟着超时一起扔
// ─────────────────────────────────────────────────────────────────────

test('思考与正文必须分得开 (分了才谈得上「把已想的留下来」)', () => {
  const r = TP.splitThinkText('<think>想了 2980 字</think>这是正文');
  assert.strictEqual(r.reasoning, '想了 2980 字');
  assert.strictEqual(r.content, '这是正文');
  // 未闭合的 <think> (超时那一刻正好卡在中间) 也必须算思考, 不能当正文交出去
  const r2 = TP.splitThinkText('<think>想到一半就超时了');
  assert.strictEqual(r2.reasoning, '想到一半就超时了');
  assert.strictEqual(r2.content, '');
  // 没有 think 标记的, 整体算正文
  const r3 = TP.splitThinkText('直接就是正文');
  assert.strictEqual(r3.content, '直接就是正文');
  assert.strictEqual(r3.reasoning, '');
});

test('抢救必须同时拿到两边的信息: 工具调用取自 error, 正文与思考取自 streamedText', () => {
  const err = {
    partial: {
      content: '',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'bazi_calc', arguments: '{"a":1}' } }],
      reasonChars: 7,
    },
  };
  const p = TP.collectPartial(err, '<think>想了 42 字</think>正文在这儿');
  assert.strictEqual(p.content, '正文在这儿');
  assert.strictEqual(p.reasoning, '想了 42 字');
  assert.strictEqual(p.toolCalls.length, 1);
  assert.strictEqual(p.toolCalls[0].function.name, 'bazi_calc');
  assert.strictEqual(p.reasonChars, 7);
  assert.strictEqual(p.hasAnything, true);
  // 什么都没有的时候不许硬说「有产出」
  const empty = TP.collectPartial({}, '');
  assert.strictEqual(empty.hasAnything, false);
});

test('超时错误本身必须带着 partial 走 (不然上层拿到的只有一个错误名)', () => {
  const llm = require(path.join(CORE, 'modules', 'llm_caller.js'));
  assert.strictEqual(typeof llm._timeoutError, 'function',
    'llm_caller 必须导出 _timeoutError —— 否则「超时带 partial」这条没法被直接验。');
  // 第二个参数是**毫秒** (llm_caller 里传的就是 _totalMs) —— 名字里写的是 ms。
  const e = llm._timeoutError('STREAM_TOTAL_TIMEOUT', 390000, { content: 'x', toolCalls: [{ id: 'a' }], reasonChars: 42 });
  assert.strictEqual(e.message, 'STREAM_TOTAL_TIMEOUT_390s');
  assert.strictEqual(e.partial.content, 'x');
  assert.strictEqual(e.partial.toolCalls.length, 1);
  assert.strictEqual(e.partial.reasonChars, 42);
  assert.strictEqual(e.isTimeout, true);
});

test('llm_caller 的每一处超时都必须走 _timeoutError (不许有一处漏挂 partial)', () => {
  const code = stripComments(readCode('modules/llm_caller.js'));
  // 三处超时 reject: 总时长 / 空闲(prefill+idle 共用一个构造点) / fetch 空闲
  const n = (code.match(/_timeoutError\(/g) || []).length;
  assert.ok(n >= 3,
    'llm_caller 里只有 ' + n + ' 处走了 _timeoutError —— 漏一处就漏挂一次 partial。');
  // 老的「手工拼错误名 + 直接 reject」不许再有
  assert.ok(!/reject\(new Error\('STREAM_(TOTAL|IDLE|PREFILL)_TIMEOUT/.test(code),
    '还有手工拼超时错误名的地方 —— 那种 reject 不带 partial。');
});

// ─────────────────────────────────────────────────────────────────────
// 三、处置: 超时必须**先于**原地重试被处理 (顺序是本批的命门)
// ─────────────────────────────────────────────────────────────────────

test('native 路径: 超时分支必须排在「原地重试同 prompt」之前', () => {
  const code = stripComments(readCode('modules/j2_agent_loop.js'));
  const iTimeout = code.indexOf('if (_isTimeoutError(e.message)) {');
  // 2026-10-23: 锚点放宽 —— 原地重试的条件里现在**必须**写着 `!_isTimeoutError(...)`,
  //   所以原来那条一字不差的锚点必然过期。改成「条件里有 _preferSameLocalRetry 就算」,
  //   顺序这条判据要量的东西 (超时分支在前) 一个字没变。
  const iRetry = code.search(/if \(_isInfraError\(e\.message\)[\s\S]{0,120}?_preferSameLocalRetry\(/);
  assert.ok(iTimeout >= 0, 'native 路径没有超时分支 —— 超时只能靠运气。');
  assert.ok(iRetry >= 0, '找不到原地重试分支 —— 锚点过期了, 判据要跟着改。');
  assert.ok(iTimeout < iRetry,
    '超时分支排在原地重试**后面** ⇒ 超时被当瞬断, 同一个 prompt 原样重来 ⇒ 必然再撞同一堵墙。');
});

test('原地重试的门必须**显式**排除超时 (光靠分支顺序不够)', () => {
  // 为什么要在「顺序」之外再加这一条:
  //   上面那条判据钉的是**当前**的分支顺序 —— 谁把超时分支挪到原地重试后面,
  //   它就红。但真正要防的不是「有人挪分支」, 是「顺序没变、行为却变了」。
  //
  //   而且顺序那条判据**本身**有个洞: 它只认 native 路径那一个 `if`。
  //   legacy 流式路径的原地重试 (`_streamRetrySameLocal`) 排不排在前面,
  //   顺序那条判据一个字都管不着。
  //
  //   所以这里改成**行为层**的要求: 每一扇「原地重试的门」, 条件里必须
  //   **写着** `!_isTimeoutError`。写了就永远对, 跟分支在哪儿排没关系。
  //
  // 为什么用 AST 不用字符串扫: 这份文件里 `_preferSameLocalRetry` 既是
  //   import 项, 又是两扇门的条件 —— 字符串扫会连 import 一起算进来。
  //   AST 能分清「声明」与「用在条件里」。
  const src = readCode('modules/j2_agent_loop.js');
  const tree = parseJs(src);
  const gates = [];

  (function walk(node) {
    if (node.type === 'if_statement') {
      const cond = node.childForFieldName('condition');
      if (cond && cond.text.includes('_preferSameLocalRetry')) {
        gates.push({ where: 'if @行' + (cond.startPosition.row + 1), text: cond.text });
      }
    }
    if (node.type === 'variable_declarator') {
      // 只看**右侧的表达式** —— 左侧是名字。
      // (import 那行是解构: 左侧的 object_pattern 里也含 _preferSameLocalRetry,
      //  但那不是「门」。)
      const val = node.childForFieldName('value');
      if (val && val.text.includes('_preferSameLocalRetry')) {
        gates.push({ where: '赋值 @行' + (val.startPosition.row + 1), text: val.text });
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  })(tree.rootNode);

  assert.ok(gates.length >= 2,
    '原地重试的门至少要有两处 (native 路径 + legacy 流式路径), 实测 ' + gates.length
    + ' —— 少一处说明有一扇门没被这条判据看见。');

  for (const g of gates) {
    assert.ok(/!\s*_isTimeoutError\s*\(/.test(g.text),
      '原地重试的门没显式排除超时 [' + g.where + ']: ' + g.text.slice(0, 160)
      + '\n—— 只靠「超时分支排在前面」是不够的: 哪天有人把分支挪下去, '
      + '顺序变了而行为悄悄变了, 没人会发现。');
  }
});

test('超时分支里不许出现「原地重试」', () => {
  const code = stripComments(readCode('modules/j2_agent_loop.js'));
  const branch = timeoutBranch(code);
  assert.ok(branch, '找不到 native 路径的超时分支 —— 锚点过期了, 判据要跟着改。');
  assert.ok(!branch.includes('_preferSameLocalRetry'),
    '超时分支里调了 _preferSameLocalRetry —— 超时会走原地重试, 同一个 prompt 再来一次。');
  assert.ok(!branch.includes('_pickCheapestModel'),
    '超时分支里切了云端模型 —— 云端未必更快, 还按量烧钱。');
});

test('超时续想必须先把已想的留在上下文里 (不然等于从头再来)', () => {
  const code = stripComments(readCode('modules/j2_agent_loop.js'));
  const branch = timeoutBranch(code);
  assert.ok(branch, '找不到 native 路径的超时分支 —— 锚点过期了, 判据要跟着改。');
  // 2026-10-23: 这条判据原来只查「分支里有没有 messages.push」——
  //   但分支里本来就有**两处** push (留已想的 + 催它动一步),
  //   删掉「留已想的」那一处, 判据照样绿 ⇒ **变异会打空枪**。
  //   改成点名查**留 reasoning 的那一处**, 且它必须在催动指令之前。
  const iPushReason = branch.indexOf("messages.push({ role: 'assistant', content: '<think>' + _tp.reasoning");
  const iPushNudge = branch.indexOf("messages.push({ role: 'user'");
  const iContinue = branch.indexOf('continue;');
  assert.ok(iPushReason >= 0,
    '超时续想里没有把已想的(reasoning)留在上下文 —— 模型等于从头再来, '
    + '那 2980 字白想。');
  assert.ok(iPushNudge >= 0, '超时续想里没有催动指令 —— 续想的形状变了, 判据要跟着改。');
  assert.ok(iContinue >= 0, '超时分支里没有 continue —— 续想的形状变了, 判据要跟着改。');
  assert.ok(iPushReason < iPushNudge && iPushNudge < iContinue,
    '续想的顺序不对: 必须先留已想的 → 再催它动一步 → 才 continue。'
    + '(现在: reason=' + iPushReason + ' nudge=' + iPushNudge + ' continue=' + iContinue + ')');
});

test('续想最多一次 (认账收口, 不无限烧)', () => {
  const code = stripComments(readCode('modules/j2_agent_loop.js'));
  const branch = timeoutBranch(code);
  assert.ok(branch, '找不到 native 路径的超时分支 —— 锚点过期了, 判据要跟着改。');
  // 上限是 1: 续想一次仍超时 ⇒ 认账收口。
  // 写死 1 是有意的 —— 续想是「逼它动一步」, 不是「给它无限时间」。
  assert.ok(/_timeoutResumeCount\s*<\s*1\b/.test(branch),
    '超时续想没有上限 1 —— 续想一次仍超时会再续想, 变成无限烧预算。');
  assert.ok(/_timeoutResumeCount\s*\+\+/.test(branch),
    '续想计数器没自增 —— 上限判据会变成恒假的空壳。');
});

test('续想那轮必须收紧预算 (「走一步判断一步」得有点刚性)', () => {
  const code = stripComments(readCode('modules/j2_agent_loop.js'));
  assert.ok(/streamTotalMsScale:\s*_nextRoundStreamScale/.test(code),
    '调用 LLM 时没把本轮预算缩放传下去 —— 续想还是给同样长的时间, 等于没刹车。');
  const branch = timeoutBranch(code);
  assert.ok(branch, '找不到 native 路径的超时分支 —— 锚点过期了, 判据要跟着改。');
  assert.ok(/_nextRoundStreamScale\s*=\s*0\.\d+/.test(branch),
    '超时续想没有收紧预算 —— 该轮还是满预算, 模型可以继续空想。');
  // 缩放规则收在唯一真源 (base 单位是**毫秒**, 与 llm_caller 里的 _totalMs 一致)
  assert.strictEqual(TP.scaledStreamTotal(390000, 0.35), 136500);
  assert.strictEqual(TP.scaledStreamTotal(390000, 1), 390000);
  assert.strictEqual(TP.scaledStreamTotal(390000, 0), 390000, 'scale=0 不许把预算打成 0');
  assert.strictEqual(TP.scaledStreamTotal(390000, 0.01), TP.MIN_SCALED_STREAM_TOTAL_MS,
    '缩放有下限 —— 本地 prefill 就要 45~90s, 缩到比它还短 = 刹车踩成自杀');
  assert.ok(TP.MIN_SCALED_STREAM_TOTAL_MS >= 120000,
    '下限低于 120s —— 本地大 prompt 首字节就要 45~90s, 预算比它还短必然又超时');
});

test('假的「legacy 降级」必须删掉 (useNative 是 const, 那条路根本不存在)', () => {
  const code = stripComments(readCode('modules/j2_agent_loop.js'));
  assert.ok(!code.includes('fallback to legacy J2 XML path'),
    '还在写「fallback to legacy J2 XML path」—— useNative 是 const, 那条路根本不存在; '
    + '注释写着「降级」而代码是「静默死掉」。');
});

test('超时收口的措辞只有一处 (两处同义文案必然漂)', () => {
  const notice = TP.timeoutNoticeText({ kind: '这一轮', seconds: 390 });
  assert.ok(notice.includes('超时收口'), '超时文案必须带正面式标签「超时收口」');
  assert.ok(notice.includes('390'), '文案里要写明预算秒数');
  assert.ok(!notice.includes('失败'), '超时不是失败 —— 措辞不许用失败标签');
  // _infraFailText 的超时分支必须委托到同一处
  const txt = SHARED._infraFailText('STREAM_TOTAL_TIMEOUT_390s', { id: 'qwen3.8-27b' });
  assert.ok(txt.includes('超时收口'),
    '_infraFailText 的超时分支没走 timeout_policy —— 两处同义文案会漂。');
});

test('续想的催动指令必须正面、具体, 且逼它动一步', () => {
  const nudge = TP.continueNudgeText({ attempt: 1, reasonChars: 2980 });
  assert.ok(nudge.includes('2980'), '催动指令要带上已想多少字 —— 模型才知道自己已经想很久了');
  assert.ok(/工具/.test(nudge), '催动指令必须点名工具 —— 这是「走一步」的那一步');
  assert.ok(/结论/.test(nudge), '催动指令必须给出第二个选项 (直接给结论)');
});

// ─────────────────────────────────────────────────────────────────────
// 四、端到端: 流真的挂住时, 已产出的东西真的救得回来
//    (这一条不用 mock —— 真起一个本地 server, 推半截就挂住)
// ─────────────────────────────────────────────────────────────────────

test('真起一个挂住的流: 超时错误必须带着已产出的 tool_calls 与思考字数', async () => {
  const llm = require(path.join(CORE, 'modules', 'llm_caller.js'));
  llm.init({
    _config: { llm: { models: [] } },
    fs: require('fs'), path: require('path'), os: require('os'),
    https: require('https'), http: require('http'),
    PRESETS: {}, PANGU_SYSTEM_PROMPT: '你是盘古。', getPromptFacts: null,
  });
  const prevTotal = process.env.PANGU_STREAM_TOTAL_MS;
  const prevPrefill = process.env.PANGU_PREFILL_MS;
  process.env.PANGU_STREAM_TOTAL_MS = '1200';
  process.env.PANGU_PREFILL_MS = '5000';

  const server = http.createServer((req, res) => {
    const url = req.url || '';
    // 上下文长度探针会先打过来, 得让它回, 否则它自己会挂住
    if (req.method === 'GET' || url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'probe-local', context_length: 8192, object: 'model' }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '想了 42 字' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'bazi_calc', arguments: '{"a":1}' } }] } }],
    }) + '\n\n');
    // **不 end** —— 挂住, 直到盘古的总预算把它掐掉
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  let caught = null;
  try {
    await llm._callLLMForAgentRaw([{ role: 'user', content: 'hi' }], {
      id: 'probe-local', provider: 'lmstudio', endpoint: 'http://127.0.0.1:' + port + '/v1',
    }, [], { onText: () => {} });
  } catch (e) {
    caught = e;
  } finally {
    server.close();
    if (prevTotal === undefined) delete process.env.PANGU_STREAM_TOTAL_MS;
    else process.env.PANGU_STREAM_TOTAL_MS = prevTotal;
    if (prevPrefill === undefined) delete process.env.PANGU_PREFILL_MS;
    else process.env.PANGU_PREFILL_MS = prevPrefill;
  }

  assert.ok(caught, '这条流挂住了, 预算掐掉时必须抛错 —— 没抛错说明根本没超时');
  assert.ok(TP.isTimeoutError(caught.message),
    '错误名不是超时类: ' + caught.message + ' —— 超时没被认出来, 会落进静默死路');
  assert.ok(caught.partial, '超时错误没带 partial —— 已经流出来的内容全扔了');
  assert.strictEqual(caught.partial.toolCalls.length, 1,
    'partial 里没有工具调用 —— 模型已经想成型的工具白想了');
  assert.strictEqual(caught.partial.toolCalls[0].function.name, 'bazi_calc');
  assert.ok(caught.partial.reasonChars > 0,
    'partial 里没有思考字数 —— 模型已经想的那部分白想了');
});
