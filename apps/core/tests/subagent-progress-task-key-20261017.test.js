'use strict';

// 2026-10-17 (现场 lt2-1792170606432, 一次 102s 的三文件长任务):
//
//   服务端发了 49 条 sub_agent_progress, 前端**一条都没显示**。主人看到的是一张
//   静止的"运行中"卡, 100 秒里零变化 —— 老板原话"跟死了一样""有没有用工具完全不知道"。
//
// 根因不在传输层(白名单是通的), 在**键对不上**, 而且是无声的:
//   - 前端认领活性事件的键 = `agent + '::' + task` (ChatRoom.jsx sub_agent_progress),
//     且认不到就**故意不新建**("免得抢跑")。
//   - 服务端构造的 progress 事件**只有 agent, 没有 task** → 键恒为 `analyzer::`。
//   - 卡片键是 `analyzer::"请分别分析这三个文件…"` → 两者永不相等。
//
// 于是"卡还没建出来就不新建"这条守卫, 实际不是竞态守卫, 是**永久性失配**:
// 事件全在发, 全在前端被扔掉, 日志里一个错都没有。上一轮 2026-10-16 补穿透白名单时
// 量到"365 条 progress 带 tools 的 = 0 条"就以为修完了 —— 那是**服务端**修好了,
// 前端这道键闸门当时就摆在那儿, 只是没人把两端对着看。
//
// 本文件把两端钉在一起: 事件键与卡片键必须同源, 且必须有不会歧义的兜底。
// 差分性质: 挖掉 task 串接 → C1/C2 转红; 挖掉前端兜底 → C3 转红;
//           把埋点挪出 _callLLMForAgentRawImpl → D1 转红。
//
// ── 2026-10-26 第 107 批 (桌面端下线) ──
// C3 / C4 原来查的是**前端怎么认领卡片** (同角色几张卡怎么办 / 认领键怎么拼),
// 随 apps/desktop 一起下线, 一起删。
// 但它们守的**服务端那一半**没丢, 由 C1/C2 继续守着:
//   C1 —— sink 必须能拿到 task, 两条 progress 分支都带上它
//   C2 —— 建卡事件 (sub_agent_start) 和 progress 事件必须用**同一个** task 原值
//   也就是说: "事件键与卡片键同源"这件事, 现在由**服务端保证载荷同源**来守。
// F4 原来查的是"前端认不认 replace 位", 现在改成**服务端契约**:
//   产出侧 —— 权威稿必须真的带 replace:true (F3 钉条数, F4 钉字段本身);
//   消费侧 —— 服务端自己的 SSE 收集器必须以 final.text 为准, 不许拿
//   stream_delta.accumulated 反过来盖掉它 (流式常常**更长**)。

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');
// 2026-10-17: sink 和 DAG 调用点一起搬进了 subagent_runner (主 agent 复用同一份派发)。
// 键失配这条 bug 本身一点没变 —— 建卡事件和 progress 事件必须还同源, 所以守卫读
// 两个文件拼起来的那份"派发实现", 而不是只读其中一个 (只读一个就等于对搬家后的
// 真正出事点失明)。
const DISPATCHER = ['modules/j2_dispatcher.js', 'modules/subagent_runner.js']
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
  .join('\n');
const LOOP = fs.readFileSync(path.join(ROOT, 'modules', 'j2_agent_loop.js'), 'utf8');
const CALLER = fs.readFileSync(path.join(ROOT, 'modules', 'llm_caller.js'), 'utf8');
const SUBAGENT = fs.readFileSync(path.join(ROOT, 'agents', 'sub-agent.js'), 'utf8');

const _sinkSeg = () => {
  const i = DISPATCHER.indexOf('function _makeSinkRes(');
  assert.ok(i > 0, '要能找到 _makeSinkRes');
  // 窗口要够宽盖住两条穿透分支: 实测 sub_progress 在偏移 3655,
  // tool_executed 在 5796 —— 截 4000 只会看到一条, 然后误报"漏了一条"。
  return DISPATCHER.slice(i, i + 7000);
};

test('C1 _makeSinkRes 必须收 task, 且两条 progress 分支都带上它', () => {
  assert.match(DISPATCHER, /function _makeSinkRes\(realRes, agent, task\)/,
    'C1: sink 必须能拿到 task —— 前端就是拿它跟卡片做匹配键的');
  const seg = _sinkSeg();
  // 两条穿透分支都要带: 思考/增量 (sub_progress) 与 工具完成 (tool_executed)。
  // 少一条, 界面就只剩"在动"却看不到"在调什么"。
  // 出口字段名是 agent: _canonAgent (归一后的拼音), 不是裸 agent —— 所以这里跟着改,
  // 钉的仍然是"两条分支都必须带 task", 不是"必须叫某个字段名"。
  const subs = seg.match(/agent:\s*_canonAgent,\s*task:\s*task \|\| '',\s*stage:/g) || [];
  assert.ok(subs.length >= 2,
    'C1: sub_progress 和 tool_executed 两条都要带 task, 实际 ' + subs.length + ' 条');
});

test('C2 DAG 调用点必须传 subTask.task 原值 (不能传 _taskTextFinal)', () => {
  const m = DISPATCHER.match(/const _sinkRes = _makeSinkRes\([^;]+;/);
  assert.ok(m, '要能找到 DAG 路径的 _makeSinkRes 调用');
  assert.match(m[0], /_makeSinkRes\(res,\s*subTask\.agent,\s*subTask\.task\)/,
    'C2: 必须传 subTask.task 原值 —— 它跟 sub_agent_start 建卡用的是同一个值; ' +
    '传 _taskTextFinal (加过路径兜底的那份) 会让键再次对不上');
  // 同一次调用里 sub_agent_start 也必须用 subTask.task, 两处同源才算数。
  assert.match(DISPATCHER, /safeResWrite\(res, 'sub_agent_start', \{\s*agent: subTask\.agent, gua: _gua \|\| null, task: subTask\.task/,
    'C2: sub_agent_start 建卡也必须是 subTask.task, 两端同源');
});

test('D1 [llm-cost] 结算埋点必须在 _callLLMForAgentRawImpl 内 (子 agent 走的那条)', () => {
  // 这一条是给**测量本身**上的锁。2026-10-17 第一次埋点时, apply_patch 匹配到了
  // 文件里第一个 `return new Promise((resolve, reject) => {` —— 那是老 callLLM 的
  // 出口, 不是子 agent 真正走的 _callLLMForAgentRawImpl。结果: 改了、服务重启了、
  // 探针跑了 102 秒, `grep -c llm-cost` = 0, 而当时**看不出是埋点没接上**,
  // 只觉得"数据怎么没有"。
  //
  // 所以护栏不只查"代码里有没有 llm-cost", 还要查"它在**对的那个函数**里"。
  const implAt = CALLER.indexOf('async function _callLLMForAgentRawImpl(');
  assert.ok(implAt > 0, '要能找到 _callLLMForAgentRawImpl');
  const nextFn = CALLER.indexOf('\n// 流式版', implAt);
  assert.ok(nextFn > implAt, '要能找到该函数的结尾');
  const seg = CALLER.slice(implAt, nextFn);
  assert.match(seg, /\[llm-cost\]/,
    'D1: [llm-cost] 必须在 _callLLMForAgentRawImpl 里 —— 那是 j2_agent_loop ' +
    '的 _deps._callLLMForAgent 实际落到的函数');
  // 结算必须真的挂在 Promise 的收尾上, 而不是只声明一个没人调的 _perfDone。
  const decls = seg.match(/_perfDone\(/g) || [];
  assert.ok(decls.length >= 2,
    'D1: _perfDone 必须既声明又被调用 (ok + ERR 两条收尾), 实际出现 ' + decls.length + ' 次');
});

test('D2 主干与判官都要带 perfTag, 否则账单分不出用途', () => {
  assert.match(LOOP, /perfTag: 'partial_judge'/,
    'D2: 判官要带标签 —— 现场它一度 22 次撞 25s 预算 (550s), 却完全不在账单上');
  assert.match(LOOP, /perfTag: 'loop:' \+/,
    'D2: 主干每轮要带角色标签, 否则 main 慢和子 agent 慢分不开');
});

test('D3 子 agent 自己的 callLLM 也要结算 (它不走 llm_caller)', () => {
  const i = SUBAGENT.indexOf('async function callLLM(messages, modelConfig, allowedTools, llmOpts = {}) {');
  assert.ok(i > 0, '要能找到 sub-agent.js 自己的 callLLM');
  const seg = SUBAGENT.slice(i, i + 400);
  // 标签由调用方 (runAgentLoop) 带下来, 这里只要求它认 llmOpts.perfTag。
  const body = SUBAGENT.slice(i, SUBAGENT.indexOf('\n}', i));
  assert.match(body, /llmOpts\.perfTag/,
    'D3: sub-agent 的 callLLM 必须认 perfTag —— 它是另一条通路, 不认就永远 untagged');
  assert.match(SUBAGENT, /perfTag: 'sub:' \+/,
    'D3: runAgentLoop 调 LLM 时要带上 sub:<role> 标签');
});

test('E1 批量取证规则必须挂在**运行时**的 ROLES 对象上, 且 planner 不挂', () => {
  // 钉运行时对象而不是源码字符串: 源码里定义一个常量然后忘了接到 ROLES 上,
  // 或者接到一个没被 runAgentLoop 读取的副本上, 源码断言全绿而线上零效果。
  // runAgentLoop 第 1014 行取的正是 ROLES[mode], 所以这里直接 require 运行时对象。
  const { ROLES } = require(path.join(ROOT, 'agents', 'sub-agent.js'));
  const has = (k) => String((ROLES[k] && ROLES[k].system) || '').includes('一轮多发几个工具');
  for (const k of ['li', 'kun', 'dui', 'xun']) {
    assert.ok(has(k), 'E1: ' + k + ' 必须带批量取证规则 (它真的会调工具)');
  }
  assert.ok(!has('kan'),
    'E1: planner 的 tools 是空的, 不该挂这条 —— 纯噪音, 而且 planner 提示词'
    + '每多一行都在主链路 prefill 里乘一次');
});

test('E2 执行层的批量并行能力必须还在 (别把提示词架在空壳上)', () => {
  // E1 的规则只有在执行层真能一轮跑多个时才成立。这里把那个前提也钉住:
  // 批量上限 > 1, 且一批是 Promise.all 真并发, 不是 for 循环串行。
  assert.match(LOOP, /const _j2BatchSize = (\d+)/, 'E2: 要能找到 _j2BatchSize');
  const m = LOOP.match(/const _j2BatchSize = (\d+)/);
  assert.ok(Number(m[1]) > 1,
    'E2: 批量上限必须是 >1 —— 等于 1 就等于没有批量, E1 的规则会变成空承诺');
  assert.match(LOOP, /const _j2BatchResults = await Promise\.all\(/,
    'E2: 同一批必须 Promise.all 真并发, 串行 for 等于白写提示词');
});

test('F1 综合阶段必须真的把正文流出去 (不是只报字数)', () => {
  // 现场 rp-1792175683xxx: _synthesizeStreamText 明明在流式收 delta, 却只每 1.5s
  // 发一个带 content_chars 计数的 sub_progress, 正文直到最后才作为一整块 chunk 写出。
  // 探针实测 stream_delta 帧数 = 0 —— 老板原话"不是流式输出"就是这一段。
  const i = DISPATCHER.indexOf('async function _synthesizeStreamText');
  assert.ok(i > 0, '要能找到 _synthesizeStreamText');
  const seg = DISPATCHER.slice(i, DISPATCHER.indexOf('\n  }', i));
  assert.match(seg, /safeResWrite\(res, 'stream_delta'/,
    'F1: 综合阶段必须发 stream_delta —— 只发字数计数等于没流式');
  assert.match(seg, /safeResWrite\(res, 'sub_agent_progress'/,
    'F1: 原来的 1.5s 活性计数要留着 (它是"还在算"的信号, 不是正文)');
});

test('F2 流出去的正文必须按完整行缓冲, 且过一遍收口同一套剥除规则', () => {
  // 直接推 raw delta 会把还没成形的标记残片刷上屏 —— `## executor` 这种行首匹配的东西
  // 拆成两半发, 前端的行锚正则就抓不到了。所以只发已经写完整的一行。
  const i = DISPATCHER.indexOf('async function _synthesizeStreamText');
  const seg = DISPATCHER.slice(i, DISPATCHER.indexOf('\n  }', i));
  assert.match(seg, /lastIndexOf\('\\n'\)/,
    'F2: 必须按换行切出已完整的部分再发');
  assert.match(seg, /_stripPseudoToolMarkup/,
    'F2: 每一行都要过伪工具标记剥除 (跟 _finalizeAnswerText 同源)');
  assert.match(seg, /_stripSpecialTokens/,
    'F2: 每一行都要过特殊 token 剥除');
  // 将灵代号行首规则: 与 _finalizeAnswerText 里那两行必须一模一样, 否则流出去的和
  // 收口剥出来的不是同一份 (流式和 final 对不上, 又变成"屏上文字自己会变")。
  const fin = DISPATCHER.slice(DISPATCHER.indexOf('function _finalizeAnswerText'));
  const rule = /replace\(\/\^\[ \\t\]\*#\{1,6\}\[ \\t\]\*\\d\+\[\.\)、\]\?\[ \\t\]\*\[ 　\]\*\[a-z_\]\+\[ \\t\]\*\$\/gim, ''\)/;
  assert.match(seg, rule, 'F2: 流式那一侧的将灵代号行首规则必须与收口完全一致');
  assert.ok(fin.includes('replace: true') || fin.includes("safeResWrite(res, 'final'"),
    'F2: _finalizeAnswerText 在场 (规则来源)');
});

test('F3 综合路径的 final 必须声明 replace:true (前端才敢覆盖已流的原文)', () => {
  // 前端有两条"流式更完整就别换"的经验规则, 它们假定流式和 final 是同一份东西的两种长度。
  // 综合阶段不是: 先流原文, 再剥除, 剥完**更短** —— 不声明权威, 剥除结果会被整个丢掉,
  // 伪工具标记留在屏上 (2026-10-16 `### executor` 就是这么漏的)。
  const finals = DISPATCHER.match(/safeResWrite\(res, 'final', \{ text: finalText, replace: true \}\);/g) || [];
  // 2026-10-23(第 65 批): 关键词兜底那两条路共用一个收口 → 综合路从 4 条变 3 条,
  //   「声明权威的 final」也从 4 处变 3 处。
  //   **意图一个字没变**: 每条流过正文的路, 都得声明 replace:true;
  //   不许有"流过了但没声明权威"的路径。
  //   新量法: 「流过正文的路径数」从出口账本算(不再数内联调用点 ——
  //   公共 5 步收成 `_synthesizeAndFinalize` 之后, 内联调用点从 4 处变 1 处,
  //   但流过正文的**路**还是 3 条)。
  const { finalizeCoverage } = require('./helpers/dispatcher_exits');
  const _cov = finalizeCoverage();
  const _streamed = _cov.covered('_synthesizeStreamText');
  assert.strictEqual(_streamed.length, 3,
    'F3: 流过正文的综合路应恰好 3 条(关键词兜底/fixed_flow/主路径), 实际 ' + _streamed.length);
  assert.strictEqual(finals.length, _streamed.length,
    'F3: 流过正文的路径数 (' + _streamed.length + ') 必须等于声明权威的路径数 (' + finals.length + ')');
});

test('F4 服务端必须既声明又消费 replace 位 —— 权威稿无条件盖过流式原文', () => {
  // ── 产出侧 ──────────────────────────────────────────────────────────
  // final 的权威性是一个**位** (opts.replace), 不是"约定"。没有这个位, 消费者
  // (以前是前端, 现在是服务端自己的兼容端点) 只能靠"哪份更长"这种经验规则猜,
  // 而权威稿经过剥除后常常**更短** —— 猜错就是把坏稿留在屏上。
  const SHARED = fs.readFileSync(path.join(ROOT, 'modules', 'j2_loop_shared.js'), 'utf8');
  assert.match(SHARED, /if \(opts && opts\.replace === true\) payload\.replace = true;/,
    'F4: _emitFinal 必须支持显式声明权威 (opts.replace) —— 没有这个位, '
    + '消费侧只能靠"哪份更长"猜, 猜错就把剥除后的坏稿留着');

  // ── 消费侧 ──────────────────────────────────────────────────────────
  // 兼容端点 (/message /chat /api/chat) 用 sse_text_collector 把 SSE 收成一段文本。
  // 它是**服务端自己**对同一份契约的解读, 所以"replace 语义有没有被消费"
  // 现在可以在进程内直接验, 不用再靠前端。
  const { createSseCollector } = require(path.join(ROOT, 'modules', 'sse_text_collector.js'));
  const c = createSseCollector();
  const longer = '很长很长的流式原文, 逐 token 累积出来的东西';
  c.res.write('event: stream_delta\ndata: ' + JSON.stringify({ delta: longer, accumulated: longer }) + '\n\n');
  c.res.write('event: final\ndata: ' + JSON.stringify({ text: '剥除后的短稿', replace: true }) + '\n\n');
  c.res.end();
  assert.strictEqual(c.getText(), '剥除后的短稿',
    'F4: 权威 final 必须无条件盖过流式累积 —— 不许拿"流式更长"当不换的理由');

  // 回归: 没有 final 时才轮到流式累积兜底 (收集器不许自己编答案, 也不许丢答案)。
  const c2 = createSseCollector();
  c2.res.write('event: stream_delta\ndata: ' + JSON.stringify({ delta: '只有流式', accumulated: '只有流式' }) + '\n\n');
  c2.res.end();
  assert.strictEqual(c2.getText(), '只有流式',
    'F4: 没有 final 时必须回落到流式累积 —— 丢答案比选错答案更难查');
});

test('G1 划界词表必须认现场真话 (逐字抄, 不按想象收)', () => {
  // 2026-10-17 现场取证 (lt3-1792175798792 / sp-1792175880739 的 task_done summary)。
  // 抓到的「③ 未做」栏原文, 逐字:
  //   "未分析另两个文件(j2_loop_shared.js / router/model_cost.js)—— 按子任务边界只做被派的 checkpoint.js; 未验证…"
  //   "model_cost.js 与 checkpoint.js 不属本刀, 未读。"
  //   "未做 model_cost.js 与 checkpoint.js 的分析 (本刀只分派 j2_loop_shared.js); 未运行 node -c …"
  //   "未核对调用方(…)是否已实际改用本文件——超出本刀范围。"
  //
  // 旧词表 (按指令不扩展 / 不在本刀 / 本刀不涉及 / 超出本刀 / 兄弟的活 / 受…约束 /
 // 不得读) 一条都对不上"按子任务边界""不属本刀""本刀只分派""只做被派的"。
  // 词表是照着想象写的, 于是**每一把干得规矩的刀都被判 partial**, 白续跑一轮。
  const sc = require(path.join(ROOT, 'modules', 'summary_completion.js'));
  const cases = [
    ['按子任务边界只做被派的 checkpoint.js; 未验证 checkpoint 目录实际文件内容(只读源码)。',
      '按子任务边界'],
    ['model_cost.js 与 checkpoint.js 不属本刀, 未读。', '不属本刀'],
    ['未做 model_cost.js 与 checkpoint.js 的分析 (本刀只分派 j2_loop_shared.js); 未运行 node -c 语法校验(只读角色)。',
      '本刀只分派'],
    ['未核对调用方(longctx_fallback._pickCheapest)是否已实际改用本文件——超出本刀范围。',
      '超出本刀范围'],
  ];
  for (const [field, why] of cases) {
    const summary = `① 完成: 读完文件并给出要点。\n\n② 证据: read_file ok。\n\n③ 未做: ${field}\n`;
    assert.strictEqual(sc.lexicalIsPartial(summary), false,
      `G1: 「③ 未做」写成划界声明(现场原话: ${why}) 不该判 partial —— ` +
      '这是分工边界, 不是真缺口');
  }
});

test('G2 本刀范围内的真缺口仍必须判 partial (G1 不能变成漏斗)', () => {
  // G1 放宽的只是"划界", 真缺口一个都不许放过 —— 而且要带否决信号的那种混写。
  const sc = require(path.join(ROOT, 'modules', 'summary_completion.js'));
  const mustBePartial = [
    ['本刀范围内还有 2 项没做: 没跑测试, 没写文档。', '本刀范围内的缺口'],
    ['未读 sibling.js (按指令不扩展); 但 t2.txt 还没建。', '划界句里混着真缺口'],
    ['还剩 3 个文件没分析。', '还剩'],
  ];
  for (const [field, why] of mustBePartial) {
    const summary = `① 完成: 部分。\n\n③ 未做: ${field}\n`;
    assert.strictEqual(sc.lexicalIsPartial(summary), true,
      `G2: 「${why}」必须判 partial —— G1 是补词表, 不是放宽判据`);
  }
});

test('G3 单字级的假信号必须收掉 (缺价/本轮 不是"还有活没干")', () => {
  // 现场逐字 (lt3-1792175798792 两份自由格式 summary, 都没有「③ 未做」栏):
  //   "…我本轮 system prompt 里那段守则即出自本文件。"   ← 「本轮」= 这一轮我读了它
  //   "…云端全缺价时 cloudPriced=false…"                   ← 「缺」= 这个模块的字段概念
  // 「本轮」「缺」是中文里最普通的字。拿单字当"还有活没干"的信号, 等于把技术语料误伤一遍。
  const sc = require(path.join(ROOT, 'modules', 'summary_completion.js'));
  for (const [body, why] of [
    ['TOOL_SELECTION_GUIDE 也在这里导出, 我本轮 system prompt 里那段守则即出自本文件。',
      '「本轮」= 这一轮读了它'],
    ['云端全缺价时 cloudPriced=false, 缺省配置与缺价配置走不同分支。',
      '「缺价/缺省」= 字段概念'],
  ]) {
    assert.strictEqual(sc.lexicalIsPartial(body), false,
      `G3: ${why} —— 描述事实的用词不是"我还没干完"`);
  }
  // 回归: 真信号一个都不许丢。
  assert.strictEqual(sc.lexicalIsPartial('读完第 1 份, 接着做第 2 份。'), true,
    'G3: "接着做第 2 份"是真的要继续');
  assert.strictEqual(sc.lexicalIsPartial('继续读剩余的三个文件。'), true,
    'G3: "继续读"必须判 partial');
  assert.strictEqual(sc.lexicalIsPartial('本轮未完成的部分还剩 3 项。'), true,
    'G3: 收紧裸「本轮」不能放过「本轮未完成」');
  assert.strictEqual(sc.lexicalIsPartial('这项工作缺少测试覆盖。'), true,
    'G3: 收紧单字「缺」不能放过「缺少」');
  // 诚实的边界: 描述文件自身行为的"接着跑", 词法**判不了**, 也不打算再补词。
  // (10-16 按现场原话补过一次, 10-17 又漏一批, 再补还是漏。)
  // 它的真正防线是 G4 —— 判官每次都跑, 词法只在判官不可用时才兜底。
  // 这里把这条**写下来**, 是为了让下一个想"再补个词"的人先看见前两次为什么没用。
});

test('G4 子 agent 没有 plan 步时, 模型判官也必须被调用 (不能直接退词法)', () => {
  // 这是本次最关键的一条。_judgeSummaryCompletion 开头写的是
  //   `if (!o.callLLM || !o.planSteps || o.planSteps.length === 0) return fallback;`
  // 而分析类子 agent **根本没有 plan 步** —— 于是判官一次都没跑过,
  // 实际做决定的一直是词法。2026-10-16 那次"③ 未做不当认罪书"的修复
  // (改的是判官提示词里的划界规则) 因此**修在了死路上**, 线上纹丝不动。
  //
  // 现场证据: sub-0-analyzer 的 ledger 里 lessons=[] steps=[] —— 判官一条记录都没写。
  //
  // 判官有 划界规则 A/B, 不依赖 plan 步; 剩下的计划为空正是最该问
  // "这一刀该做的做完了没有"的场合。实测判官一次 2.6~5.5s,
  // 而一次白跑的续跑轮是 10~25s —— 花 3s 换掉一个必然误判的词法, 划算。
  const raw = fs.readFileSync(path.join(ROOT, 'modules', 'summary_completion.js'), 'utf8');
  // 只扫**代码**, 不扫注释 —— 修这个 bug 时我在上面写了半页注释解释原来那个短路长什么样,
  // 注释里那句 `o.planSteps.length === 0` 正好被断言的正则命中, 于是"代码明明删了"
  // 却报红。断言扫注释就等于给自己埋雷: 越是把一件事解释清楚, 越容易被自己的说明绊倒。
  //
  // 2026-10-23 (第 59 批): 这里原来只剥 `//` 行注释, **剥不掉块注释**。
  //   第 59 批给判官写的 jsdoc 里正好引用了被删掉的那句旧代码
  //   (`planSteps.length === 0`), 于是"代码明明没有"却报红 ——
  //   就是上面这段警告自己的那种雷。
  //   同项目的 scoped-notdone-not-partial T8 早就有正确的剥法(块+行一起剥), 这里对齐。
  const SRC = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(SRC, /planSteps\.length === 0/,
    'G4: 不能因为没有 plan 步就跳过判官 —— 子 agent 永远没 plan 步, ' +
    '这个短路等于把判官整个废掉, 只剩词法在决定');
  assert.match(SRC, /if \(!o\.callLLM\)/,
    'G4: 短路条件只该挡"没有 LLM 通道", 不该挡"没有 plan 步"');
});

test('G5 j2_agent_loop 那侧也必须认这个判官 (别只修一份拷贝)', () => {
  // summary_completion.js 是模块, j2_agent_loop.js 里还有一份**内联拷贝**的判官
  // (_judgeSummaryCompletion)。两份不同步 = 改了一份另一份照旧判错。
  const code = LOOP.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(code, /_steps\.length === 0/,
    'G5: j2_agent_loop 的内联判官也不能因为"没有 plan 步"就跳过模型判定');
});

test('G6 判官只有一份实现 —— 内联拷贝不许复活 (2026-10-23 第 59 批)', () => {
  // 这条是 G5 的**加强版**: G5 只能保证"两份都没坏", 挡不住"第三份又长出来"。
  // 第 59 批把判官收进了唯一真源 —— 提示词、JSON 解析、判局映射全在
  // modules/summary_completion.js, j2_agent_loop.js 只留传输层
  // (预算 / 超时 / 词法兜底)。
  //
  // 为什么值得钉: 「两份同义文本各改各的」是盘古 2026-10-21 亲自踩过的坑,
  // 而这一对拷贝**已经漂过了** —— 划界规则的信号词表两边不一样
  // (一份有「本刀范围/已交/未修改」, 一份没有; 一份有「验收结论 PASS/FAIL」, 一份没有)。
  // 漂了没人发现, 因为没有一条断言在说"它们应该一样"。
  const loopCode = LOOP.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter(l => !/^\s*\/\//.test(l)).join('\n');
  // 内联拷贝的痕迹: 自己拼提示词 / 自己解 JSON / 自己判 completed。
  assert.doesNotMatch(loopCode, /\[PARTIAL_JUDGE\]/,
    'G6: j2_agent_loop 里又出现了一份内联判官提示词 —— 判官的提示词只有一份真源 '
    + '(modules/summary_completion.js:buildProgressJudgePrompt)');
  assert.doesNotMatch(loopCode, /_extractJsonObjects\(/,
    'G6: j2_agent_loop 里又自己解了一遍判官的 JSON —— 解析只有一份真源 '
    + '(modules/summary_completion.js:parseProgressJudgeText)');
  // 反过来: 传输层该在的还在 (预算/超时/兜底), 不许为了"去重"把护栏一起删了。
  assert.match(loopCode, /_JUDGE_BUDGET_MS/,
    'G6: 判官自己的预算没了 —— 那是它烧掉过 300s 的地方');
  assert.match(loopCode, /PARTIAL_JUDGE_BUDGET_/,
    'G6: 超时标识没了 —— 超时必须认得出是自己超时');
});




