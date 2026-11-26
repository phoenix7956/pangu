/**
 * tests/child-failure-head-only-20261025.test.js
 * 第 85 批 c —— 「这一刀失败了」的判据问错了问题:
 *   「汇报里有没有失败词」≠「这一刀失败没失败」
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 现场 (2026-10-25, 会话 probe86-fixed, 子 agent 分析盘古自己源码的那一轮)
 *
 *   三刀的 runtimeStatus **全是 completed** —— 三刀都真交卷了。
 *   但三刀交的是**源码分析报告**:
 *     刀0 汇报 8440 字  (在讲 llm_caller.js 怎么处理超时)
 *     刀1 汇报 8042 字  (在讲 j2_agent_loop.js 的「守卫与熔断」)
 *     刀2 汇报 10208 字 (在讲 j2_agent_loop.js 的失败分支)
 *
 *   老判据 (j2_dispatcher._isChildFailure): 拿 `_CHILD_FAIL_TEXT_RE`
 *   (`未通过|未核验|请重试|熔断|无法完成|没有通过核验|不通过`) **扫全文**
 *   ⇒ 命中在第 1513 / 198 / 5686 字 (都在正文深处, 都是在**描述被分析的对象**)
 *   ⇒ 三刀全进 `child_failures`
 *   ⇒ `[dispatcher] resDone: child summaries contain failed/unverified evidence;
 *      refusing completed`
 *   ⇒ 一份结构完整的综合答案被判 **partial**。
 *
 * 这跟第 83/84 批修的守卫是**同一个病**:
 *   守卫拿**自由散文**当判据, 分不清「这件事发生了」和「这件事被提到」。
 *   第 84 批给验收刀 (`_verdictOfChecker`) 换了尺子, 这一批把同一把尺子
 *   搬到「子刀失败判定」上 —— 同一个病, 第五次变形。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 判据改成什么 (判据真源: j2_dispatcher._isChildFailure)
 *
 *   **位置 + 形态** —— 只认**头部**的失败证据:
 *     · 短文本 (≤400 字) 保持全文扫, 能力**不减**
 *       (现场真死样本 102-339 字; 两条钉死的用例
 *        「结论未通过核验, 请重试」13 字 / 「工具熔断」4 字 都在这一侧)
 *     · 长文本 (>400 字) 只扫**头部第一行** (深处的是在描述被分析的对象)
 *
 *   ⚠ 失败**词表一个字都没改** (`_CHILD_FAIL_TEXT_RE` 原样) ——
 *     改的是**在哪扫**, 不是**扫什么**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 本文件钉住四件事:
 *   A. 现场语料: 长汇报深处提到失败词 ⇒ 不许判 child failure
 *   B. 既有契约不许破 (finalize-answer-20261012 钉死的用例, 一条都不许挂)
 *   C. 边界: 400 字分界 / 多行短文本 / markdown 标题头
 *   D. 变异测试: 把位置判据改坏, 必须响 (证明这些用例真在测它)
 *
 * ⚠ 硬约束 (一条都不许破):
 *   · `_CHILD_FAIL_TEXT_RE` 词表一个字不许放宽
 *   · tests/finalize-answer-20261012.test.js 的两条钉死用例不许挂
 *   · 直答轮豁免 (听话 ≠ 没干活) 不许破
 *   · 术数支线 apps/core/64i/ 一行不许碰
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const CORE = path.join(__dirname, '..');
const DISPATCH_PATH = path.join(CORE, 'modules', 'j2_dispatcher.js');

const { _isChildFailure, _childTextFailure } = require(DISPATCH_PATH);

const _child = (runtimeStatus, summary) => ({ agent: 'li', result: { runtimeStatus, summary } });

// ═════════════════════════════════════════════════════════════════════════════
// A. 现场语料
// ═════════════════════════════════════════════════════════════════════════════

// 本地独立实现的「首行」—— **不 import 被测模块的 headLine**。
//   贴标签这一步不能靠被测对象自己 (那是自证)。
function firstLine(s) {
  let t = String(s || '');
  for (let i = 0; i < 2; i++) {
    const m = t.match(/^[ \t]*#{1,6}[ \t]+[^\n]*\n?/);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  t = t.replace(/^[ \t\r\n]+/, '');
  const nl = t.indexOf('\n');
  return nl >= 0 ? t.slice(0, nl) : t;
}

const FAIL_RE = /未通过|未核验|请重试|熔断|无法完成|没有通过核验|不通过/;
// 2026-10-28 (第 134 批): 夹具改读仓内 (原来扫生产盘, 语料随生产数据生死 ⇒ 守卫静默失效)。
//   要跑真现场语料: PANGU_CORPUS_DIR=$HOME/.pangu-data/sessions
const SESSION_DIR = process.env.PANGU_CORPUS_DIR
  || path.join(__dirname, 'fixtures', 'sessions');

// 从落盘会话里捞真实的「长汇报 + 深处命中失败词 + 头部干净」样本。
//   不手抄 —— 手抄的样本会带着「我以为现场长什么样」的偏见。
function loadDeepHitCorpus() {
  if (!fs.existsSync(SESSION_DIR)) return null;
  let files;
  try { files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith('.json')); } catch (_) { return null; }
  const out = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8')); } catch (_) { continue; }
    for (const m of (j.messages || [])) {
      let t = typeof m.content === 'string' ? m.content : '';
      if (!t || t.indexOf('task_done') < 0) continue;
      let o;
      try { o = JSON.parse(t); } catch (_) { continue; }
      const s = o && o.summary;
      if (typeof s !== 'string' || s.length <= 400) continue;
      const head = firstLine(s);
      if (FAIL_RE.test(head)) continue;      // 头部就命中 ⇒ 不是本批要治的那一类
      if (!FAIL_RE.test(s)) continue;         // 全文压根没有 ⇒ 也不是
      out.push({ file: f, summary: s, hit: s.search(FAIL_RE) });
    }
  }
  return out.length ? out : null;
}

test('A1 现场语料: 长汇报深处提到失败词 ⇒ 不许判 child failure', () => {
  const corpus = loadDeepHitCorpus();
  if (!corpus) {
    assert.ok(true, '现场会话目录里没有这类样本, 跳过 (A2 用内联最小复现覆盖同一条判据)');
    return;
  }
  assert.ok(corpus.length >= 2, '现场样本太少, 语料没读到 (期望 >= 2, 实际 ' + corpus.length + ')');
  for (const c of corpus) {
    assert.equal(_isChildFailure(_child('completed', c.summary), false), false,
      '长汇报深处的失败词被当成了「这一刀失败」 (这刀真交卷了): '
      + c.file + ' 命中偏移 ' + c.hit + ' 头部: ' + JSON.stringify(firstLine(c.summary).slice(0, 60)));
  }
});

test('A2 最小复现: 源码分析报告 (深处在讲熔断) 不许判 child failure', () => {
  // 形态照现场 probe86 刀 1: 头部是编号小标题, 正文在**列举**盘古自己的守卫。
  const report = '## 1) 整体职责\n\n'
    + 'j2_agent_loop.js 负责编排多轮推理, 6122 行。\n\n'
    + '### 一轮轮怎么走\n\n'
    + '提示词/记忆注入、多轮对话组织、工具执行与结果回灌、'
    + '**守卫与熔断**、超时/预算/终止、落盘与 trace 结算, '
    + '并通过依赖注入 (dependency injection) 拿到底层 LLM 的调用能力, '
    + '而不是自己去 require 传输层。\n\n'
    + '### 失败分支\n\n'
    + '当工具连续失败时, 主循环会进入**熔断**路径, '
    + '并且在最终答复里注明「未通过核验」的部分。\n\n'
    + '### 依赖关系\n\n'
    + 'llm_caller.js 与 j2_agent_loop.js 之间没有互相 import, '
    + '主连接线是 pangu-single.js 的依赖注入; '
    + '唯一直接耦合点在 j2_agent_loop.js:1693 附近, 那里把调用函数挂到依赖表上。\n\n'
    + '### 结论\n\n'
    + '以上均为只读分析, 未修改任何文件。';
  assert.ok(report.length > 400, '这个样本不该短于 400 字 (否则走的是短文本分支)');
  assert.equal(_isChildFailure(_child('completed', report), false), false,
    '源码分析报告被判成了 child failure ⇒ 这一轮会被降级成 partial');
});

test('A3 长汇报**头部**有失败词 ⇒ 仍判 failure', () => {
  // 反面: 位置判据不能把「开头就自认没干成」也放走。
  const report = '结论未通过核验, 请重试。\n\n'
    + '下面是这一轮的工作说明: ' + 'x'.repeat(600) + '\n'
    + '补充: 中间也提到了熔断和未核验之类的词。';
  assert.ok(report.length > 400, '这个样本不该短于 400 字');
  assert.equal(_isChildFailure(_child('completed', report), false), true,
    '长汇报开头就自认没干成, 却没被判 failure ⇒ 守卫被放松过头了');
});

// ═════════════════════════════════════════════════════════════════════════════
// B. 既有契约不许破
// ═════════════════════════════════════════════════════════════════════════════

test('B1 finalize-answer-20261012 钉死的两条短文本用例, 一条都不许挂', () => {
  // 这两条是**短文本** (13 字 / 4 字) ⇒ 走全文扫 ⇒ 老能力不减。
  assert.equal(_isChildFailure(_child('completed', '结论未通过核验, 请重试'), true), true);
  assert.equal(_isChildFailure(_child('completed', '工具熔断'), true), true);
});

test('B2 status=failed 仍然算失败 (非直答轮)', () => {
  assert.equal(_isChildFailure(_child('failed', '孙七'), false), true);
  assert.equal(_isChildFailure({ agent: 'x', error: 'ECONNRESET' }, true), true);
});

test('B3 直答轮豁免不变 (听话 ≠ 没干活)', () => {
  assert.equal(_isChildFailure(_child('failed', '孙七'), true), false);
  assert.equal(_isChildFailure(_child('failed', ''), true), true);
  assert.equal(_isChildFailure(_child('failed', '孙'), true), true);
});

test('B4 正常完成的子 agent 不算失败', () => {
  assert.equal(_isChildFailure(_child('completed', '共扫描 12 个文件, 4471 行'), false), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// C. 边界
// ═════════════════════════════════════════════════════════════════════════════

test('C1 400 字分界: 短的那侧全文扫, 长的那侧只扫头', () => {
  // 短文本 (≤400) 且失败词在**第二行** ⇒ 全文扫能抓到 ⇒ 判失败。
  const shortMulti = '① 完成: 扫描完成\n结论未通过核验, 请重试';
  assert.ok(shortMulti.length <= 400, '这个样本要落在短文本侧');
  assert.equal(_isChildFailure(_child('completed', shortMulti), false), true,
    '短文本的第二行失败词没被抓到 ⇒ 短文本侧的老能力被削掉了');

  // 同样的形态, 但拉长过 400 字 ⇒ 只扫头 ⇒ 头干净 ⇒ 不判失败。
  const longMulti = '① 完成: 扫描完成\n' + '结论未通过核验, 请重试\n' + 'x'.repeat(500);
  assert.ok(longMulti.length > 400, '这个样本要落在长文本侧');
  assert.equal(_isChildFailure(_child('completed', longMulti), false), false,
    '长报告只该扫头, 头干净就不该判失败');
});

test('C2 长汇报的头是 markdown 标题 ⇒ 标题本身不算失败证据', () => {
  const report = '## 1) 整体职责\n\n'
    + '正文: ' + 'y'.repeat(500) + '\n\n'
    + '### 失败分支\n\n这里讲的是盘古自己的失败处理, 不是这一刀失败。';
  assert.ok(report.length > 400, '这个样本不该短于 400 字');
  assert.equal(_isChildFailure(_child('completed', report), false), false,
    'markdown 标题头没被剥掉 ⇒ 标题里的词被当成了失败证据');
});

// ═════════════════════════════════════════════════════════════════════════════
// A4 / D3 —— 第 85 批 d: 同一个判据在同一个文件里被抄成了两份
//
//   ① `_isChildFailure` (拆解轮 qian 的 child_failures)
//   ② `_ffChildFailed` (fixed_flow 分支的 _ffFailed)
// 两份各自写死一份正则、各自全文扫 ⇒ 85c 只治好了 ①, ② 还带着同一个病:
// fixed_flow 下跑同样的源码分析任务, 照样会被降级成 partial。
// ⇒ 现在两条路径共用 `_childTextFailure`: 一份词表 + 一套位置规则。
// ═════════════════════════════════════════════════════════════════════════════

test('A4 两条路径 (拆解轮 / fixed_flow) 对同一份汇报给出同一个判断', () => {
  const samples = [
    // 长源码分析报告 (深处在讲熔断): 两条路径都必须放走
    '## 1) 整体职责\n\n'
      + 'j2_agent_loop.js 负责编排多轮推理, 6122 行。\n\n'
      + '### 一轮轮怎么走\n\n提示词/记忆注入、工具执行与结果回灌、**守卫与熔断**、超时/预算/终止。\n\n'
      + '### 失败分支\n\n主循环会进入**熔断**路径。\n\n'
      + '### 依赖关系\n\nllm_caller.js 与 j2_agent_loop.js 之间没有互相 import, '
      + '主连接线是 pangu-single.js 的依赖注入。\n\n'
      + '### 工具结果回灌\n\n主循环把 assistant 侧的 tool_calls 与 tool 侧的 tool_results '
      + '按序配对回灌, 本地守门提示一律攒起来, 等本轮结果回灌完再插进上下文, '
      + '避免插在 tool_call 和它的结果中间导致上游直接 400。\n\n'
      + '### 收口\n\n最终答复由综合轮生成, 综合轮拿三刀的汇报做输入; '
      + '若某一刀的汇报里含有未核验的字样, 老判据会把这一刀计入失败。',
    // 短文本真失败: 两条路径都必须判失败
    '结论未通过核验, 请重试',
    // 短文本真熔断
    '工具熔断',
    // 正常完成
    '共扫描 12 个文件, 4471 行',
  ];
  for (const s of samples) {
    // 拆解轮那一侧 (status=completed ⇒ 判据只剩「扫失败词」这一层)
    const viaDecompose = _isChildFailure(_child('completed', s), false);
    // fixed_flow 那一侧
    const viaFixedFlow = _childTextFailure(s);
    assert.equal(viaDecompose, viaFixedFlow,
      '两条路径对同一份汇报给了不同判断 —— 同一份汇报, 换个调度模式就换一套判据: '
      + JSON.stringify(s.slice(0, 60)));
  }
});

test('D3 结构守卫: 「扫失败词」在 j2_dispatcher.js 里只有一份实现', () => {
  const src = fs.readFileSync(DISPATCH_PATH, 'utf8');
  // 手抄的第二份正则在 85 批 d 之前长这样:
  //   /未通过|未核验|请重试|熔断|无法完成|不通过/
  // 它比 `_CHILD_FAIL_TEXT_RE` 少一个 alternative —— 两条路径的词表一旦分家,
  // 同一个词在 fixed_flow 下不触发、在拆解轮下触发, 又变成一个说不清的差异。
  const inlineCopies = src.match(/\/未通过\|未核验\|请重试\|熔断\|无法完成\|不通过\//g) || [];
  assert.equal(inlineCopies.length, 0,
    '又出现了手抄的失败词正则 (第 ' + inlineCopies.length + ' 处) ⇒ 两条路径的判据又分家了');
  // 词表真源只有一处
  const defs = src.match(/const _CHILD_FAIL_TEXT_RE = /g) || [];
  assert.equal(defs.length, 1, '失败词表的定义不止一处 (实际 ' + defs.length + ' 处)');
});

// ═════════════════════════════════════════════════════════════════════════════
// D. 变异测试 —— 证明上面这些用例真的在测「位置判据」
//
// 手法 (照第 83 批 answer-self-report 的做法): Module._compile 在内存里编译一份
// 「坏掉的」副本, **一个字节都不落盘** —— 不污染 modules/ 目录, 不跟整链并发打架。
// ═════════════════════════════════════════════════════════════════════════════

function compileMutant(filePath, mutate) {
  const src = fs.readFileSync(filePath, 'utf8');
  const broken = mutate(src);
  assert.notEqual(broken, src, '变异没生效 —— 替换目标对不上, 这条负例是空枪');
  const m = new Module(filePath, null);
  m.filename = filePath;
  m.paths = Module._nodeModulePaths(path.dirname(filePath));
  m._compile(broken, filePath);
  return m.exports;
}

test('D1 把「长文本只扫头」改回全文扫 ⇒ A1/A2/C1 必须红', () => {
  const broken = compileMutant(DISPATCH_PATH, (src) => src.replace(
    '  if (s.length > _CHILD_FAIL_SCAN_MAX) return _CHILD_FAIL_TEXT_RE.test(_headLine(s));\n'
    + '  return _CHILD_FAIL_TEXT_RE.test(s);',
    '  return _CHILD_FAIL_TEXT_RE.test(s);'));
  const report = '## 1) 整体职责\n\n'
    + 'j2_agent_loop.js 负责编排多轮推理, 6122 行。\n\n'
    + '### 一轮轮怎么走\n\n'
    + '提示词/记忆注入、工具执行与结果回灌、**守卫与熔断**、超时/预算/终止。\n\n'
    + '### 失败分支\n\n主循环会进入**熔断**路径。\n\n'
    + '### 依赖关系\n\nllm_caller.js 与 j2_agent_loop.js 之间没有互相 import, '
    + '主连接线是 pangu-single.js 的依赖注入。\n\n'
    + '### 工具结果回灌\n\n'
    + '主循环把 assistant 侧的 tool_calls 与 tool 侧的 tool_results 按序配对回灌, '
    + '本地守门提示 (重复调用拦截、硬循环守卫、权限校验通过) '
    + '一律攒起来, 等本轮结果回灌完再插进上下文, '
    + '避免插在 tool_call 和它的结果中间导致上游直接 400。\n\n'
    + '### 收口\n\n'
    + '最终答复由综合轮生成, 综合轮拿三刀的汇报做输入; '
    + '若某一刀的汇报里含有未核验的字样, 老判据会把这一刀计入失败。';
  // ⚠ 空枪守卫: 样本必须落在**长文本侧** (>400 字)。
  //   否则变异后的全文扫和原判据走的是同一条分支, 测不出「位置判据」这一层。
  assert.ok(report.length > 400,
    '变异样本短于 400 字 ⇒ 变异后走的还是短文本分支 ⇒ 这条负例是空枪 (实际长度 '
    + report.length + ')');
  assert.ok(!FAIL_RE.test(firstLine(report)),
    '变异样本的头部必须干净, 否则测的是「头部判据」不是「位置判据」');
  // 对称断言: 原实现判 false, 变异后判 true —— 证明这一条**真的在测这层**。
  assert.equal(_isChildFailure(_child('completed', report), false), false,
    '原实现竟判了失败 ⇒ 位置判据没生效, 后面的变异断言全是空枪');
  assert.equal(broken._isChildFailure(_child('completed', report), false), true,
    '变异后长汇报仍判失败 ⇒ 这条用例没在测「位置判据」 (空枪)');
});

test('D2 把长度门槛拉到 0 ⇒ 短文本侧的老能力必须红', () => {
  // ⚠ 这一条守的是**另一层**: 「短文本全文扫」这个能力不许被位置判据吞掉。
  //   变异只测一层, 别的层要么留着、要么明确关掉 —— 不能靠别的层救场。
  const broken = compileMutant(DISPATCH_PATH, (src) => src.replace(
    'const _CHILD_FAIL_SCAN_MAX = 400;',
    'const _CHILD_FAIL_SCAN_MAX = 0;'));
  const shortMulti = '① 完成: 扫描完成\n结论未通过核验, 请重试';
  assert.equal(broken._isChildFailure(_child('completed', shortMulti), false), false,
    '变异后短文本第二行的失败词没被抓到 ⇒ 这条用例没在测「短文本全文扫」 (空枪)');
});
