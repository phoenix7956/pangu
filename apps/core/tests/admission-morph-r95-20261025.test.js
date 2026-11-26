'use strict';

// ===========================================================================
// 第 95 批 (2026-10-25) —— 收口判据的**第 5 处**形态误伤:
//   「盘古在描述自己的机制」被当成「盘古在承认这一轮没做完」
//
// 现场 (会话 probe93-fixed, 云端跑完, 落盘 ~/.pangu-data/sessions/probe93-fixed.json):
//   答复本体是一份**完整的源码分析报告** (7083 字, 开头「结论: llm_caller.js 是…"模型传输
//   与请求装配层"… j2_agent_loop.js 是…"Agent 决策与推进层"… 两者通过 pangu-single.js
//   完成依赖注入」), 不是子 agent 原文拼接 ⇒ **合成层是交付了的**。
//   但整轮收口判成 partial。
//
// 把那份 7083 字原样喂判据, 剥壳后 4579 字, 命中 3 处:
//   ① 「熔断」  「- 预算不足时尝试压缩续命，压缩无效才熔断」   ← **机制政策**的描述
//   ② 「未通过」「…；尚未通过故障端点做运行时抖动测试。」        ← 答案自己的**范围声明**
//   ③ 「未完成」「- 最后一轮未完成时，可自动续跑，L4364」       ← **条件从句**里的机制描述
//
// ①③ 是误伤 (都在描述盘古自己的机制); ② 是答案自己写下的诚实免责 —— 那一条
//   **保留**: 判 partial 在那里站得住, 本次不动。
//
// 修法 (两道, 都是**形态**判断, 词表一个字都不放宽):
//   R1 「句末」不只看标点 —— markdown 的**结构分界** (空行/标题/下一个列表项/文本结束)
//      也是句末。只作用在「熔断」上 (名/动同形词, 本来就有专门的机制名判定)。
//   R2 自认词后面紧跟**条件/时间状语** (时/的话/时候) ⇒ 它在条件从句里, 描述的是
//      「什么情况下会怎样」, 不是对这一轮交付物的陈述。
//
// 本文件的核心: 现场语料从**落盘会话**读 (不手抄), 形态判据用**内存编译**做变异体检
// (照第 83 批的做法, 一个字节不落盘)。
// ===========================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const CORE = path.join(__dirname, '..');
const DISPATCH_PATH = path.join(CORE, 'modules', 'j2_dispatcher.js');
const { _answerAdmitsIncomplete } = require(DISPATCH_PATH);

// 2026-10-28 (第 134 批): 夹具改读仓内 (原来读生产盘, 生产盘一清就空枪)。
//   要跑真现场语料: PANGU_CORPUS_DIR=$HOME/.pangu-data/sessions
const SESSION_DIR = process.env.PANGU_CORPUS_DIR
  || path.join(__dirname, 'fixtures', 'sessions');
const PROBE = 'probe93-fixed';

function loadProbeAnswer() {
  const f = path.join(SESSION_DIR, PROBE + '.json');
  if (!fs.existsSync(f)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const msgs = d.messages || [];
    return String((msgs[msgs.length - 1] && msgs[msgs.length - 1].content) || '');
  } catch (_) { return null; }
}

// 从落盘会话里抽出**真实的行** (含后面的 markdown 结构) —— 不手抄。
//
// ⚠ 为什么必须连后面几行一起取:
//   「压缩无效才熔断」单独拎出来时, 词后面是**空串** ⇒ `_CLAUSE_TAIL_RE` 的 `$`
//   分支本来就放行 ⇒ 那条用例是**空枪**。真现场里它后面紧跟 "\n\n### 4. …",
//   旧判据正是栽在这个"结构分界"上。
function loadProbeLines() {
  const answer = loadProbeAnswer();
  if (!answer) return null;
  const lines = answer.split('\n');
  const out = {};
  for (const key of ['压缩无效才熔断', '未完成时']) {
    const i = lines.findIndex((l) => l.indexOf(key) >= 0);
    if (i < 0) return null;
    out[key] = lines.slice(i, i + 3).join('\n');   // 本行 + 后面两行 (markdown 结构)
  }
  return out;
}

// 内存编译一个变异体 (不落盘)
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

// ───────────────────────────────────────────────────────────────────────────
// A. 现场语料 —— 从落盘会话读, 不手抄
// ───────────────────────────────────────────────────────────────────────────

test('A1 现场: 那份 7083 字真综合稿里, 两处机制描述不再被判自认', (t) => {
  const answer = loadProbeAnswer();
  if (!answer) return t.skip('现场会话 ' + PROBE + '.json 不在盘上 —— 跳过现场那一节 (不许用手抄文本冒充现场)');
  assert.ok(answer.length > 5000, '现场答复应当是完整长稿, 实际 ' + answer.length + ' 字');
  // 逐字取证: 现场稿里必须真的有这两处形态, 否则这条用例在测一个不存在的东西
  assert.ok(answer.indexOf('压缩无效才熔断') >= 0, '现场语料里没有「压缩无效才熔断」⇒ 取证样本不对');
  assert.ok(answer.indexOf('未完成时') >= 0, '现场语料里没有「未完成时」⇒ 取证样本不对');

  // 把答案自己那句范围声明去掉 ⇒ 剩下的**必须**不再被判自认
  // (去掉之前它是 true, 去掉之后还是 true ⇒ 说明还有别处在误伤)
  const stripped = answer.replace(/尚未通过[^。]*。?/g, '');
  assert.notEqual(stripped, answer, '现场稿里没有「尚未通过…」那句免责 ⇒ 取证样本不对');
  assert.equal(_answerAdmitsIncomplete(stripped), false,
    '去掉答案自己的免责后仍判自认 ⇒ 「熔断」/「未完成时」两处机制描述还在误伤');
});

test('A2 现场: 答案自己写下的范围声明仍然判 partial (诚实免责, 本次不动)', (t) => {
  const answer = loadProbeAnswer();
  if (!answer) return t.skip('现场会话不在盘上');
  assert.equal(_answerAdmitsIncomplete(answer), true,
    '答案自己说了「尚未通过故障端点做运行时抖动测试」却判 complete ⇒ 把诚实免责也放走了');
});

test('A3 现场: 单条机制描述各自判 false', () => {
  // ⚠ 「压缩无效才熔断」单独拎出来时词后面是空串 ⇒ `_CLAUSE_TAIL_RE` 的 `$` 分支
  //   本来就放行 ⇒ 拿它当用例是**空枪**。带 markdown 结构的真实现场行见 A4。
  assert.equal(_answerAdmitsIncomplete('- 最后一轮未完成时，可自动续跑，L4364'), false,
    '「最后一轮未完成时」是条件从句里的机制描述, 不是自认');
});

test('A4 现场: 连着 markdown 结构的真实行各自判 false (旧判据栽的就是这个形态)', (t) => {
  const lines = loadProbeLines();
  if (!lines) return t.skip('现场会话不在盘上');
  assert.equal(_answerAdmitsIncomplete(lines['压缩无效才熔断']), false,
    '真实现场行「压缩无效才熔断」后面跟着 "\n\n### 4. …" ⇒ 仍被判自认');
  assert.equal(_answerAdmitsIncomplete(lines['未完成时']), false,
    '真实现场行「未完成时」仍被判自认');
});

// ───────────────────────────────────────────────────────────────────────────
// B. 真阳性一条不许挂 (10-12 那批 + 旧词表四种措辞)
// ───────────────────────────────────────────────────────────────────────────

test('B1 真阳性一条不许挂', () => {
  const admits = [
    '当前仅成功读取并排序了部分 .js 文件，输出在 memory_helpers.js 处截断，未证明覆盖全部文件；索引文件 /tmp/module_firstline_20261012.md 也未生成。',
    '结论：本次任务未完成，不能报告为全量索引。',
    '当前八字排盘未成功，工具返回 MISSING_DATE，因此没有生成可核验的四柱。',
    '已核实目录存在 .js 文件。但当前工具权限仅允许只读，未能写入 /tmp/x.md，因此索引表尚未生成。',
    '该文件未落地，无法完成后续步骤。',
    '报告未写出，无法交付。',
    '验收未通过',
    '子任务熔断了',
    '请重试',
    '结论不通过',
  ];
  for (const t of admits) {
    assert.equal(_answerAdmitsIncomplete(t), true, `真阳性被放走: ${t.slice(0, 40)}`);
  }
});

test('B2 R1 只作用在「熔断」上 —— 别的词遇到结构分界仍然算自认', () => {
  // 「索引文件未生成」后面跟空行+标题: 这是**真缺口**, 不能因为 R1 放走
  assert.equal(_answerAdmitsIncomplete('索引文件 /tmp/x.md 未生成\n\n### 4. 说明'), true,
    'R1 泄漏到别的词了 ⇒ 真缺口被放走');
  assert.equal(_answerAdmitsIncomplete('报告未写出\n\n### 4. 说明'), true,
    'R1 泄漏到别的词了 ⇒ 真缺口被放走');
});

test('B3 R2 只认紧跟的条件状语 —— 句中的「时」不算', () => {
  // 「未完成时」= 条件从句 (放走); 「未完成, 此时…」= 后面还有谓语 ⇒ 照咬
  assert.equal(_answerAdmitsIncomplete('最后一轮未完成时自动续跑'), false);
  assert.equal(_answerAdmitsIncomplete('本次任务未完成，此时应当重跑'), true,
    '「未完成, 此时…」不是条件从句 ⇒ 必须照咬');
});

// ───────────────────────────────────────────────────────────────────────────
// C. 词表一个字都不放宽 (逐字钉死)
// ───────────────────────────────────────────────────────────────────────────

test('C1 词表逐字钉死 (不许放宽)', () => {
  const src = fs.readFileSync(DISPATCH_PATH, 'utf8');
  const m = src.match(/const _INCOMPLETE_ADMISSION_RE = (\/.*\/);/);
  assert.ok(m, '找不到词表定义');
  assert.equal(m[1], '/(尚未生成|尚未落盘|尚未写入|尚未产出|还没生成|还没有生成|没有生成|未生成|未能写入|未能生成|未能完成|未能产出|未能落盘|未完成|未产出|未落地|未落盘|未写入|没写入|未创建|没有创建|未执行|没有执行|未能执行|未成功|本次任务未完成|不能报告为|尚不能交付|无法交付|未写出|无法完成|无法写入|无法落盘|无法生成|全部未完成|未能[实真]?(?!.*(?:成功|达到))|本次未能|因此未能|没有实际|未实际|当前环境未提供|不具备.*能力|无法提供)/',
    '词表被改动了 —— 本批的硬约束是「词表一个字都不放宽」');
  const old = src.match(/const _ADMITS_OLD_RE = (\/.*\/);/);
  assert.ok(old, '找不到旧词表定义');
  assert.equal(old[1], '/未通过|未核验|请重试|熔断|不通过/', '旧词表被改动了');
});

// ───────────────────────────────────────────────────────────────────────────
// D. 变异体检 —— 证明 A/B 真的在守
// ───────────────────────────────────────────────────────────────────────────

test('D1 拆掉「条件状语」这条形态判断 → A3 的「未完成时」必须红', () => {
  const broken = compileMutant(DISPATCH_PATH, (src) => src.replace(
    'if (_CONDITIONAL_AFTER_RE.test(after)) continue;',
    'if (false && _CONDITIONAL_AFTER_RE.test(after)) continue;'));
  assert.equal(broken._answerAdmitsIncomplete('- 最后一轮未完成时，可自动续跑，L4364'), true,
    '变异后仍判不完整 ⇒ 「条件状语」这条形态判断没被测到 (空枪)');
});

test('D2 拆掉「结构分界」这条形态判断 → A4 的「熔断」必须红', () => {
  const broken = compileMutant(DISPATCH_PATH, (src) => src.replace(
    'if (!_CLAUSE_TAIL_RE.test(a) && !_STRUCT_BREAK_AFTER_RE.test(a)) return false;',
    'if (!_CLAUSE_TAIL_RE.test(a)) return false;'));
  const lines = loadProbeLines();
  const sample = lines ? lines['压缩无效才熔断']
    : '- 预算不足时尝试压缩续命，压缩无效才熔断\n\n### 4. 本轮消息和工具准备';
  assert.equal(broken._answerAdmitsIncomplete(sample), true,
    '变异后仍判不完整 ⇒ 「结构分界」这条形态判断没被测到 (空枪)');
});

test('D3 把词表放宽 (删掉「未写出」) → B1 必须红 (证明 B1 不是空枪)', () => {
  const broken = compileMutant(DISPATCH_PATH, (src) => src.replace(
    '|未写出|无法完成|', '|无法完成|'));
  assert.equal(broken._answerAdmitsIncomplete('报告未写出，无法交付。'), false,
    '删掉词表里的「未写出」竟仍然判 true ⇒ B1 没在测这条真阳性 (空枪)');
});

test('D4 把「结构分界」推广到所有词 → B2 必须红 (证明 R1 没泄漏)', () => {
  const broken = compileMutant(DISPATCH_PATH, (src) => src.replace(
    'if (m[0] === _MECHANISM_NOUN_WORD && _isMechanismNounUsage(before, after)) continue;',
    'if (_STRUCT_BREAK_AFTER_RE.test(after)) continue;'));
  assert.equal(broken._answerAdmitsIncomplete('索引文件 /tmp/x.md 未生成\n\n### 4. 说明'), false,
    '变异后真缺口被放走 ⇒ B2 没在测 R1 的作用范围 (空枪)');
});
