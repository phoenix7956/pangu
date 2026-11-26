/**
 * tests/slice-death-quote-not-dead-20261025.test.js
 * 第 84 批 —— 「刀死了」判据问错了问题: 「汇报里有没有死法词」≠「这一刀死没死」
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 现场 (2026-10-25, 子 agent 分析盘古自己源码的那一轮)
 *
 *   任务: 分析 llm_caller.js 和 j2_agent_loop.js 各自负责什么, 然后综合
 *   刀交卷: 8379 字, 汇报里**引用了** llm_caller.js 里的超时错误名
 *         (`LLM_SOCKET_TIMEOUT` / `STREAM_PREFILL_TIMEOUT` / `STREAM_IDLE_TIMEOUT` /
 *           `STREAM_TOTAL_TIMEOUT` / `LLM_FETCH_TIMEOUT`)
 *   —— 那是**在描述代码怎么处理超时**, 不是**这一刀撞上了超时**。
 *
 *   老判据 (modules/slice_death.js): 拿死法正则**扫全文** ⇒ 命中 ⇒ 这一刀判死:
 *     · 界面发 sub_agent_error (主人看到「这一刀失败」)
 *     · plan step 标 failed (计划卡把它计进没干成的)
 *     · findings.ok = false (记成「不是真交付」)
 *     · 最重的一层: `batchResults.every(_sliceIsDead)` ⇒ **整批判死**
 *       ⇒ 走「降级如实汇报」⇒ 主人收到的是子 agent 原文拼接, 不是综合稿
 *
 * 这跟第 83 批修的那两个守卫是**同一个病**:
 *   守卫拿**自由散文**当判据, 分不清「这件事发生了」和「这件事被提到」。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 判据改成什么 (判据真源: modules/slice_death.js)
 *
 *   证据 (全库 29 条命中样本, ~/.pangu-data/sessions, 现场逐条统计):
 *     真死 (16 条): 长度 102-339,  首次命中偏移 23-31    —— 命中**就在首行**
 *     误伤 (13 条): 长度 1169-8379, 首次命中偏移 853-6279 —— 命中在**正文深处**
 *     真死样本**全部**以 `⚠️ 模型 …` 开头 (机器基础设施报错文案)
 *
 *   ⇒ 死法判定 = **位置** (只认头部第一行) + **形态** (机器报错签名)
 *   ⇒ 死法**词表一个字都不改** (`SLICE_DEAD_RE` 原样)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 本文件钉住四件事:
 *   A. 现场语料: 真死刀必须判死, 散文里**提到**死法词的一律不许误伤
 *   B. 既有契约不许破 (C1/E4/B4 钉死的样本, 一条都不许挂)
 *   C. 结构守卫: 死法判定只有一份, 超时清单只有一处, 叶子模块不许长依赖
 *   D. 变异测试: 把位置判据 / 形态判据改坏, 必须响 (证明这些用例真在测它)
 *
 * ⚠ 硬约束 (一条都不许破):
 *   · `SLICE_DEAD_RE` 死法**词表一个字都不许放宽**
 *   · tests/longtask-dead-acceptance-20261016.test.js C1 的 6 个死法样本不许挂
 *   · tests/slice-death-not-done-20261019.test.js E4 的 8 个死法样本不许挂
 *   · 同文件 B4: 「验收 PASS ✅ 然后收尾时 ECONNRESET」必须判 unknown
 *   · 超时清单只允许存在 modules/timeout_policy.js 一处
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const CORE = path.join(__dirname, '..');
const SLICE_PATH = path.join(CORE, 'modules', 'slice_death.js');
const DISPATCH_PATH = path.join(CORE, 'modules', 'j2_dispatcher.js');

const death = require(SLICE_PATH);

// ─────────────────────────────────────────────────────────────────────────────
// 现场语料 —— 从落盘会话里取, 不手抄
//
// 分标签用**独立于本批判据**的结构特征: `⚠️ 模型 ` 前缀是
// j2_loop_shared._infraFailText / _quotaFailText 生成的机器基础设施报错签名。
// 不能用本批自己的判据给自己贴标签 (那是自证)。
// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-28 (第 134 批): 夹具改读仓内 (原来扫生产盘, 语料随生产数据生死 ⇒ 守卫静默失效)。
//   要跑真现场语料: PANGU_CORPUS_DIR=$HOME/.pangu-data/sessions
const SESSION_DIR = process.env.PANGU_CORPUS_DIR
  || path.join(__dirname, 'fixtures', 'sessions');
const DEAD_WORD_RE = /(STREAM_TOTAL_TIMEOUT|STREAM_IDLE_TIMEOUT|STREAM_PREFILL_TIMEOUT|LLM_SOCKET_TIMEOUT|LLM_FETCH_TIMEOUT|LLM_ROUND_TIMEOUT|额度已耗尽|端点连不上|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up)/;

// 本地独立实现的「首行」—— **不 import 被测模块的 headLine**。
// 贴标签这一步不能靠被测对象自己 (那是自证)。
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

function loadCorpus() {
  if (!fs.existsSync(SESSION_DIR)) return null;
  let files;
  try { files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith('.json')); } catch (_) { return null; }
  const realDead = [];
  const prose = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8')); } catch (_) { continue; }
    for (const m of (j.messages || [])) {
      if (!m || m.role !== 'assistant') continue;
      const s = String(m.content || '');
      if (!s || !DEAD_WORD_RE.test(s)) continue;
      // 标签: **机器生成的文案**都以 `⚠️` 开头 (现场逐条核对:
      //   端点连不上 / 额度已耗尽 / 静默失败收口 / 对账纠正 / 假输出熔断 …),
      //   而**模型的散文汇报**不会。这个标签跟死法词表、跟本批判据都无关。
      if (/^⚠️/.test(firstLine(s))) realDead.push(s);
      else prose.push(s);
    }
  }
  if (!realDead.length && !prose.length) return null;
  return { realDead, prose };
}

// ═════════════════════════════════════════════════════════════════════════════
// A. 现场语料
// ═════════════════════════════════════════════════════════════════════════════

test('A1 现场语料: 真死刀全判死, 散文里提到死法词的一个都不许误伤', () => {
  const corpus = loadCorpus();
  if (!corpus) {
    assert.ok(true, '现场会话目录不存在, 跳过 (A2/A3 用内联最小复现覆盖同一条判据)');
    return;
  }
  assert.ok(corpus.realDead.length >= 5, '现场真死样本太少, 语料没读到 (期望 >= 5, 实际 '
    + corpus.realDead.length + ')');
  assert.ok(corpus.prose.length >= 5, '现场散文样本太少, 语料没读到 (期望 >= 5, 实际 '
    + corpus.prose.length + ')');
  for (const s of corpus.realDead) {
    assert.equal(death.isDeadReport(s), true,
      '真死刀没被判死: ' + JSON.stringify(s.slice(0, 80)));
  }
  for (const s of corpus.prose) {
    assert.equal(death.isDeadReport(s), false,
      '散文里的死法词被当成了真死 (这一刀明明干完了): ' + JSON.stringify(s.slice(0, 80)));
  }
});

test('A2 刀交卷时引用了超时错误名 → 那一刀不许被判死', () => {
  // 最小复现: 现场刀 1 的汇报形态 —— 引用代码里的超时错误名, 但刀**干完了**。
  const report = '① 完成: 完成 llm_caller.js（2644 行）全量只读分析。\n\n'
    + '② 证据: exec_command（wc -l / sed -n 分段）、grep 函数与 require。\n\n'
    + '③ 未做: j2_agent_loop.js 不在本刀范围。\n\n'
    + '**错误处理**：非流式 `_handlePlain` 报错 `LLM_SOCKET_TIMEOUT_Ns`；'
    + '流式两段空闲预算：prefill 报 `STREAM_PREFILL_TIMEOUT`，'
    + '流中报 `STREAM_IDLE_TIMEOUT`，总时长报 `STREAM_TOTAL_TIMEOUT`，'
    + 'fetch 路径报 `LLM_FETCH_TIMEOUT`。';
  assert.equal(death.isDeadReport(report), false,
    '汇报里引用了超时错误名就被判死 ⇒ 这一刀明明交卷了');
  assert.equal(death.stepStatusFor(report, 'completed'), 'done',
    '交卷的刀被标成 failed ⇒ 计划卡会说它没干成');
  assert.equal(death.isRealDelivery(report, 'completed'), true,
    '交卷的刀被记成「不是真交付」');

  // 更狠的一档: 死法词出现在**第一行**。
  //   位置判据只看第一行, 所以这一条守的是**形态**判据 ——
  //   「报告第一行提到超时名」是在**描述**, 不是**发生了**。
  const headMention = '① 完成: llm_caller.js 的超时机制 (STREAM_PREFILL_TIMEOUT) 已核实。';
  assert.equal(death.isDeadReport(headMention), false,
    '报告第一行提到超时错误名就被判死 ⇒ 形态判据没生效');
});

test('A3 报告第一行**以**超时裸名开头 (整行就是错误名) → 仍判死', () => {
  // 反面: 位置判据不能把「整行就是错误名」也放走 (tests/slice-death-not-done E4 钉死)。
  assert.equal(death.isDeadReport('LLM_SOCKET_TIMEOUT'), true);
  assert.equal(death.isDeadReport('STREAM_IDLE_TIMEOUT'), true);
  assert.equal(death.isDeadReport('端点连不上'), true);
});

// ═════════════════════════════════════════════════════════════════════════════
// B. 既有契约不许破
// ═════════════════════════════════════════════════════════════════════════════

test('B1 死法认得全 (C1/E4 钉死的样本, 一条都不许挂)', () => {
  const deads = [
    // tests/longtask-dead-acceptance-20261016.test.js C1
    '⚠️ 模型 x 额度已耗尽 (HTTP 429)。',
    '⚠️ 模型 x 端点连不上: read ECONNRESET',
    '⚠️ 模型 x 端点连不上: connect ECONNREFUSED 127.0.0.1:12345',
    '⚠️ LLM_SOCKET_TIMEOUT_300s',
    '⚠️ STREAM_IDLE_TIMEOUT_90s',
    'socket hang up ETIMEDOUT',
    // tests/slice-death-not-done-20261019.test.js E4
    'read ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
    'LLM_SOCKET_TIMEOUT', 'STREAM_IDLE_TIMEOUT', 'STREAM_PREFILL_TIMEOUT',
    '⚠️ 模型 x 额度已耗尽 (HTTP 429)', '端点连不上',
  ];
  for (const s of deads) {
    assert.equal(death.sliceIsDead(s), true, '漏认了死法: ' + s);
    assert.equal(death.stepStatusFor(s, undefined), 'failed', '漏认了死法: ' + s);
  }
  for (const s of ['5 步全部执行完毕, diff 一致', '已写入 3 行', '验收 PASS']) {
    assert.equal(death.sliceIsDead(s), false, '正常汇报被误判成死: ' + s);
  }
});

test('B2 checker 死在端点报错上 → 裁决必须是 unknown, 不是 pass', () => {
  const { _verdictOfChecker } = require(DISPATCH_PATH);
  assert.equal(_verdictOfChecker('验收 PASS ✅ 然后收尾时 ECONNRESET'), 'unknown',
    '模型在死之前写的 PASS 不是验收结论, 它没机会真的验完');
  assert.equal(_verdictOfChecker('⚠️ 模型 x 端点连不上: read ECONNRESET'), 'unknown');
});

test('B3 checker 在汇报里提到超时错误名 → 裁决按它的结论算, 不许降级成 unknown', () => {
  const { _verdictOfChecker } = require(DISPATCH_PATH);
  // 这就是本批那个病的验收面: 验收刀的任务就是验超时处理, 汇报里必然提到那些名字。
  assert.equal(_verdictOfChecker('**最终验收结论: PASS**\n\n已核对 STREAM_IDLE_TIMEOUT 与 STREAM_TOTAL_TIMEOUT 的处理分支。'), 'pass',
    '验收刀汇报里提到超时错误名就被降级成 unknown ⇒ 一轮好验收被白扔');
});

// ═════════════════════════════════════════════════════════════════════════════
// C. 结构守卫
// ═════════════════════════════════════════════════════════════════════════════

test('C1 死法判定只有一份 (dispatcher 不许自己再扫一遍全文)', () => {
  const src = fs.readFileSync(DISPATCH_PATH, 'utf8');
  assert.ok(/isDeadReport/.test(src),
    'j2_dispatcher 没用 slice_death.isDeadReport ⇒ 判据分叉了');
  // checker 裁决那条不许再直接用裸正则扫全文
  assert.ok(!/_SLICE_DEAD_RE\.test\(raw\)/.test(src),
    'checker 裁决还在用裸正则扫全文 ⇒ 报告里提到错误名就把好验收降级成 unknown');
});

test('C2 slice_death 必须是零依赖叶子 (反向引用会循环)', () => {
  const src = fs.readFileSync(SLICE_PATH, 'utf8');
  const requires = [...src.matchAll(/require\('(\.\/[^']+)'\)/g)].map(m => m[1]);
  for (const r of requires) {
    assert.ok(r === './timeout_policy',
      'slice_death 引了 ' + r + ' —— 它是叶子模块, 只许引 timeout_policy (判定表)');
  }
});

test('C3 超时清单只允许存在 timeout_policy.js 一处', () => {
  // 复刻 tests/timeout-policy-20261023.test.js 那条守卫 (本批的实例形态正则
  // 是**从 TIMEOUT_KINDS 现场拼**的, 不能写字面量)。
  const TP = require(path.join(CORE, 'modules', 'timeout_policy.js'));
  const src = fs.readFileSync(SLICE_PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const kind of TP.TIMEOUT_KINDS) {
    assert.ok(!src.includes(kind),
      'slice_death.js 里出现了超时名字「' + kind + '」的副本 —— 超时清单只允许存在 timeout_policy.js 一处');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// D. 变异测试 —— 证明上面这些用例真的在测这两条判据
//
// 手法 (照第 83 批的做法): Module._compile 在内存里编译一份「坏掉的」副本,
// **一个字节都不落盘**。
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

test('D1 把位置判据拆掉 (回到全文扫) → A1 的散文必须被判死', () => {
  // ⚠ 变异要**两处一起改**才算回到 2026-10-25 之前的「全文扫」:
  //   只把 head 换成全文, 长度上限那一步还会把它挡回去 (散文本来就 >400 字) ——
  //   那样变异走不到判定点, 就是空枪 (本批实测踩到)。
  const broken = compileMutant(SLICE_PATH, (src) => src
    .replace(
      '  const head = headLine(s);',
      '  const head = s; /* MUTANT: 全文扫 */')
    .replace(
      '  if (head.length > _DEAD_HEAD_MAX) return false;',
      '  /* MUTANT: 去掉长度上限 */'));
  const corpus = loadCorpus();
  const prose = corpus ? corpus.prose : [
    '① 完成: 读完 3 个文件。\n\n内部细节: fetch 路径 ECONNRESET 的重试策略是 …',
  ];
  let misjudged = 0;
  for (const s of prose) {
    if (broken.isDeadReport(s)) misjudged++;
  }
  assert.ok(misjudged > 0,
    '变异后散文一个都没被判死 ⇒ A1 没在测位置判据 (空枪)');
});

test('D2 把形态判据拆掉 → A2 的最小复现必须被判死', () => {
  // 变异: 头行里有死法词就算死 (不管是不是机器报错形态)。
  const broken = compileMutant(SLICE_PATH, (src) => src.replace(
    '  if (_MACHINE_ERROR_HEAD_RE.test(head)) return true;',
    '  return true; /* MUTANT: 不看形态 */'));
  // ⚠ 样本必须**头行里就有死法词**, 否则连 SLICE_DEAD_RE 那一步都过不去,
  //   变异体压根走不到 —— 那是空枪 (踩过一次)。
  const report = '① 完成: llm_caller.js 的超时机制 (STREAM_PREFILL_TIMEOUT) 已核实。';
  assert.equal(broken.isDeadReport(report), true,
    '变异后仍判不死 ⇒ A2 没在测形态判据 (空枪)');
});

test('D3 把头部行长度上限拆掉 → 长报告第一行含死法词就会被误伤', () => {
  const broken = compileMutant(SLICE_PATH, (src) => src.replace(
    '  if (head.length > _DEAD_HEAD_MAX) return false;',
    '  /* MUTANT: 去掉长度上限 */'));
  // 一整段没有换行的长报告, 剥掉标题后「第一行」= 整篇
  const long = '① 完成: ' + 'x'.repeat(500) + ' 内部提到 ECONNRESET 重试。';
  assert.equal(broken.isDeadReport(long), true,
    '变异后长报告没被判死 ⇒ 这条用例没在测长度上限 (空枪)');
});

