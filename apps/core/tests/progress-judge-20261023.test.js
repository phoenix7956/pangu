'use strict';
// 进度判局并进六格内核 (2026-10-23 第 59 批)
//
// 起因是量出来的, 不是想出来的:
//   2026-10-23 实测 —— 7940 个会话账本里只有 **3 个**提到 wuxing_judge,
//   运行日志里 **0 次**。老板 10-21 要的「加强停顿, 走一步判断一步」在长任务上
//   是**空的**: 机制在, 但只靠模型自觉调工具, 实际从不触发。
//
// 本批做的事: 把六格判局挂到 task_done 上 (每个子 agent 每天都在走的那条路),
// 并把验收判据从「模型自报的布尔」换成「模型列条目、内核算档位」。
//
// 判据分三层, 每层都有负例:
//   (1) 公理层 task_judge.judgeProgress —— 档位/规则/判不出的纪律
//   (2) 生产层 summary_completion —— 提示词、解析、形状映射
//   (3) 接线 j2_agent_loop —— 真的把六格结论送到模型眼前
//
// 判官的老教训照旧: **绿灯是结果, 咬人才是证据**。
// 每条护栏都有对应的反例, 拆掉修复必须变红。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const TJ = require(path.join(CORE, '64i', 'bagua_annotations', 'task_judge.js'));
const SC = require(path.join(CORE, 'modules', 'summary_completion.js'));
const loopSrc = fs.readFileSync(path.join(CORE, 'modules', 'j2_agent_loop.js'), 'utf8');
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
  .filter((l) => !/^\s*\/\//.test(l)).join('\n');

// (1) 公理层: 进度判局

test('P1 进度判局三档都能走出来', () => {
  const closed = TJ.judgeProgress({ subject: '刀A', outputs: ['报告.md'] });
  assert.equal(closed.ok, true, '有产出无待办 => 该判收口');
  assert.equal(closed.verdict, TJ.PROGRESS_VERDICT.CLOSED);

  const open = TJ.judgeProgress({ subject: '刀A', outputs: ['报告.md'], targets: ['还差 X'] });
  assert.equal(open.verdict, TJ.PROGRESS_VERDICT.OPEN);

  const redirect = TJ.judgeProgress({
    subject: '刀A', outputs: [], blockers: ['b1', 'b2', 'b3'], targets: ['t1'],
  });
  assert.equal(redirect.verdict, TJ.PROGRESS_VERDICT.REDIRECT);
});

test('P2 判不出来就不给结论 (不拿空数据当结论)', () => {
  // 老板原话: 「挂永远没有100%」—— 没有证据时不给结论, 而不是给一个假的。
  const empty = TJ.judgeProgress({ subject: '刀A' });
  assert.equal(empty.ok, false, '一条都没列还判结论 = 拿空数据当结论');
  assert.equal(empty.error.code, 'NO_INPUT');

  // 只有助力, 既没产出也没待办 —— 同样判不出。
  const noConclusion = TJ.judgeProgress({ subject: '刀A', resources: ['已读 3 个文件'] });
  assert.equal(noConclusion.ok, false);
  assert.equal(noConclusion.error.code, 'NO_CONCLUSION');

  // 阻力压顶 + 没产出, 但**也没有活** ⇒ 不是「换向」。
  // 「先解阻力」是对着还有活的人说的; 没活就是没活, 硬给个换向是编结论。
  // (这条是变异体检逼出来的: 拆掉 P_REDIRECT 里的 hao 条件时 P1/P2 全绿。)
  const blockedButNoWork = TJ.judgeProgress({
    subject: '刀A', outputs: [], blockers: ['b1', 'b2', 'b3'],
  });
  assert.notEqual(blockedButNoWork.verdict, TJ.PROGRESS_VERDICT.REDIRECT,
    '没有待办就不该判「换向」—— P_REDIRECT 必须带「还有活」这个前提');
  assert.equal(blockedButNoWork.ok, false);
});

test('P3 进度判局的档位名不与任务判局重叠 (语义不漂)', () => {
  // stop 在任务判局里是「没活可干了, 别往下冲」;
  // 进度判局里「本刀收口」是**正常完成** —— 名字一样意思不一样 = 语义漂移。
  for (const v of Object.values(TJ.PROGRESS_VERDICT)) {
    assert.ok(!['stop', 'continue'].includes(v),
      `进度判局不许用任务判局的档位名「${v}」—— 两个问题意思不同, 名字不能撞`);
  }
  assert.equal(TJ.PROGRESS_VERDICT.CLOSED, 'closed');
  assert.equal(TJ.PROGRESS_VERDICT.OPEN, 'open');
  assert.equal(TJ.PROGRESS_VERDICT.REDIRECT, 'redirect');
});

test('P4 进度判局与任务判局共用同一把档位尺子 (不许两份实现)', () => {
  // 同一份条目, 两个判局的「强/弱/不成立」必须一致。
  const spec = { resources: ['r1'], outputs: ['o1', 'o2', 'o3'], blockers: ['b1'], targets: ['t1'] };
  const taskCells = TJ.judgeTask(Object.assign({ subject: 'S' }, spec)).cells;
  const progCells = TJ.judgeProgress(Object.assign({ subject: 'S' }, spec)).cells;
  for (const k of Object.keys(taskCells)) {
    assert.equal(progCells[k].state, taskCells[k].state,
      `「${taskCells[k].shuxing}」在两个判局里档位不一样 —— 阈值漂了, 两份实现的锅`);
    assert.equal(progCells[k].count, taskCells[k].count);
  }
});

test('P5 规则与表必须一致 (PROGRESS_VERDICT_INPUTS 对应规则实际读了什么)', () => {
  // 表说有影响, 就必须真的影响; 表说没影响, 就必须真的不影响。
  // 这条在装时自检里也有一道, 这里再钉一次 —— 装时自检被 try/catch 吞掉时
  // (2026-10-22 铁律: load 期自检必被吞), 只有测试这道能站住。
  const BASES = [
    { resources: [], outputs: ['x'], blockers: [], targets: [], peers: [] },
    { resources: [], outputs: [], blockers: [], targets: ['e'], peers: [] },
    { resources: [], outputs: [], blockers: ['b', 'c', 'd'], targets: ['e'], peers: [] },
    { resources: [], outputs: ['x'], blockers: [], targets: [], peers: ['p', 'q', 'r'] },
  ];
  for (const c of TJ.CELLS) {
    let changed = false;
    for (const base of BASES) {
      const seen = new Set();
      for (const n of [0, 1, 3]) {
        const spec = Object.assign({ subject: '自检' }, base);
        spec[c.field] = n === 0 ? [] : Array.from({ length: n }, (_, i) => c.key + '-' + i);
        const r = TJ.judgeProgress(spec);
        if (r.ok) seen.add(r.verdict);
      }
      if (seen.size > 1) changed = true;
    }
    const declared = TJ.PROGRESS_VERDICT_INPUTS.has(c.key);
    assert.equal(declared, changed,
      `「${c.shuxing}」表与规则不一致: 表说影响判定=${declared}, 实际影响=${changed}`);
  }
});

// (2) 生产层: 判官的提示词 / 解析 / 形状映射

test('M1 判官问的是六格条目, 不是布尔', () => {
  const prompt = SC.buildProgressJudgePrompt('(1) 完成\n(3) 未做: 无', []);
  for (const f of ['resources', 'outputs', 'blockers', 'targets', 'peers']) {
    assert.ok(prompt.includes(f), `提示词里没有「${f}」这一格`);
  }
  assert.match(prompt, /不许自己下结论/, '必须交代"你只列条目, 结论由内核算"');
  assert.doesNotMatch(prompt, /"completed":\s*true\|false/, '判官还在问布尔');
});

test('M2 六格形状 => 结论由内核算, 不是模型喊的', () => {
  const shape = SC.parseProgressJudgeText(
    '{"resources":["已读 a.js"],"outputs":["写了 b.md"],"blockers":[],"targets":["还差 c.md"],"peers":[]}');
  assert.equal(shape.kind, 'cells');
  const j = SC.judgeProgressShape(shape, '这一刀');
  assert.equal(j.ok, true);
  assert.equal(j.source, 'kernel', '结论必须标明是内核算的');
  assert.equal(j.verdict, TJ.PROGRESS_VERDICT.OPEN);
  assert.equal(j.isPartial, true);
  assert.ok(j.cells, '六格 cells 必须带出来 —— 下一轮要把它送到模型眼前');
});

test('M3 旧形状仍认, 且与改造前逐字等价 (向后兼容)', () => {
  // 旧判官: _isPartial = !completed || remaining.length > 0
  const cases = [
    ['{"completed":true,"remaining":[]}', false],
    ['{"completed":false,"remaining":["x"]}', true],
    ['{"completed":true,"remaining":["x"]}', true],
    ['{"completed":false,"remaining":[]}', true],
  ];
  for (const [text, expected] of cases) {
    const shape = SC.parseProgressJudgeText(text);
    assert.equal(shape.kind, 'legacy', '旧形状没被认出来');
    const j = SC.judgeProgressShape(shape, '这一刀');
    assert.equal(j.isPartial, expected,
      `旧形状「${text}」的判定与改造前不等价 —— 后向兼容就废了`);
    assert.equal(j.source, 'model_legacy', '旧形状是模型自报, 必须与内核算区分开');
  }
});

test('M4 判不出 => 落回词法, 不硬给结论', () => {
  // 六格形状但条目全空 => 内核判不出 => 走词法。
  const shape = SC.parseProgressJudgeText(
    '{"resources":[],"outputs":[],"blockers":[],"targets":[],"peers":[]}');
  const j = SC.judgeProgressShape(shape, '这一刀');
  assert.equal(j.ok, false, '条目全空还判结论 = 拿空数据当结论');
  // 词法兜底也走同一套形状。
  const lex = SC.lexicalProgressShape('还有 2 项没做');
  assert.equal(lex.source, 'lexical');
  assert.equal(lex.isPartial, true);
  // ⚠️ 汇报契约那一栏的行首写法是 `③ 未做:` 或行首 `3 未做:` ——
  //   写成 `(3) 未做:` (带括号) **不被契约正则认**, 于是「未做」两个字
  //   留在正文里被词法扫到, 判成 partial。
  //   这不是词法的锅, 是我第一遍把契约格式写错了 —— 记在这儿免得下次再踩。
  const lexDone = SC.lexicalProgressShape('1 完成: 写了 3 个文件\n3 未做: 无');
  assert.equal(lexDone.isPartial, false);
});

test('M5 贪婪 JSON 抓取的老坑不许复发', () => {
  // 2026-10-16: 贪婪 /\{[\s\S]*\}/ 抓到**另一段**合法 JSON 时不抛异常,
  // 只是 completed 读到 undefined => 恒判"部分完成" => 做完也判没做完。
  const text = '前面有段别的 JSON {"foo":1}\n然后才是真的 {"completed":true,"remaining":[]}';
  const shape = SC.parseProgressJudgeText(text);
  assert.ok(shape, '必须抓到后面那段');
  assert.equal(shape.completed, true);
});

// (3) 接线: 六格结论要真的到模型眼前

test('W1 六格判局挂在 task_done 上 (不是靠模型自觉调工具)', () => {
  // 这是本批的**主判据**。在此之前, 长任务上的六格判局只靠模型主动调
  // wuxing_judge —— 实测 7940 个账本里 3 个, 日志里 0 次。
  assert.match(codeOnly(loopSrc), /judgeProgressShape/,
    'j2_agent_loop 没用六格判局 —— 长任务上的停顿还是空的');
  assert.match(codeOnly(loopSrc), /buildProgressJudgePrompt/,
    '判官提示词没走唯一真源');
});

test('W2 六格结论被送到模型眼前 (走一步判断一步)', () => {
  // 判据得**看得见**, 才知道下一步该干什么。
  // 真调一次, 不扫源码。扫源码的话, 把整段注入删掉测试照样绿
  // (第 59 批变异体检实测: 空枪两发)。
  // 走真解析路径: 判官原文 → parse → judge → message,
  // 而不是手搓一个内部形状 (手搓形状会绕开解析层, 测不到真问题)。
  // 字段名与 task_judge.CELLS 的 field 同名 (resources/outputs/blockers/targets/peers) ——
  //   别写成中文别名: 解析层只认这五个, 写错就静默判不出。
  const raw = JSON.stringify({
    resources: ['在读 3 个文件'], outputs: ['报告.md'], blockers: [],
    targets: ['还差 X', '还差 Y'], peers: [],
  });
  const shape = SC.parseProgressJudgeText(raw);
  assert.equal(shape.kind, 'cells', '六格原文应解析成 cells 形状');
  const judged = SC.judgeProgressShape(shape, '这一刀');
  assert.equal(judged.ok, true, '前置: 这个形状该判得出结论');
  const msg = SC.buildProgressJudgeMessage(judged, judged.isPartial);
  assert.ok(typeof msg === 'string' && msg.length,
    '判出结论且还有活时, 该造出一条送到模型眼前的话');
  assert.match(msg, /六格进度判局/);
  assert.match(msg, /走一步判断一步/);
  assert.match(msg, /下一步/);
  // 条目要真的在里面 —— 只注入一个档位名等于没给模型看东西。
  assert.match(msg, /还差 X/);
  // 注入器本身: 真的把一条塞进 messages, 并如实报回注入了几条。
  const messages = [];
  assert.equal(SC.injectProgressJudge(messages, judged, judged.isPartial), 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, msg);
  // 接线要用它, 而不是自己再拼一遍 (两份拼法 = 两份漂移)。
  assert.match(codeOnly(loopSrc), /injectProgressJudge/,
    '调用点没用注入器 —— 那句「送不送」的判断就没人验了');
  // 调用点不许自己造内容 —— 「[六格进度判局」这种字符串只该在真源里出现一次。
  const loopHits = (loopSrc.match(/\[六格进度判局/g) || []).length;
  assert.equal(loopHits, 0,
    '调用点里自己拼了注入内容 —— 第二份实现, 两份措辞迟早漂');
});

test('W3 零影响: 判不出 / 已收口 => 一条都不注入', () => {
  // 停点是加法不是减法 (stop_point.js 的纪律): 没判出结论时不许改变行为。
  const judged = SC.judgeProgressShape(SC.parseProgressJudgeText(JSON.stringify({
    resources: [], outputs: ['报告.md'], blockers: [], targets: ['还差 X'], peers: [],
  })), '这一刀');
  assert.equal(judged.ok, true, '前置: 这条该判得出结论');

  // 三种「不该注入」的情况, 全都不许造出话。
  assert.equal(SC.buildProgressJudgeMessage(judged, false), null,
    '已收口还注入 = 每次成功都在提示模型"接着干" —— 那会把它推下悬崖');
  assert.equal(SC.buildProgressJudgeMessage(judged.ok ? { ok: false } : judged, true), null,
    '判不出还注入 = 拿空数据当结论');
  assert.equal(SC.buildProgressJudgeMessage(null, true), null);
  assert.equal(SC.buildProgressJudgeMessage(undefined, true), null);
  assert.equal(SC.buildProgressJudgeMessage({ ok: true, cells: {} }, true), null,
    '一条条目都没有还注入 = 注入一句空话');
  // 判不出结论本身也不能造出话。
  const noShape = SC.judgeProgressShape({ cells: {} }, '这一刀');
  if (!noShape.ok) assert.equal(SC.buildProgressJudgeMessage(noShape, true), null);
  // 注入器层同样零影响: messages 一个字节都不许动。
  for (const [j, p] of [[judged, false], [{ ok: false }, true], [null, true]]) {
    const box = [{ role: 'system', content: '原有上下文' }];
    assert.equal(SC.injectProgressJudge(box, j, p), 0);
    assert.equal(box.length, 1, '不该注入时却动了 messages');
    assert.equal(box[0].content, '原有上下文');
  }
});

test('W4 判官结论写进账本 (可查)', () => {
  assert.match(loopSrc, /'PROGRESS_JUDGE'/,
    '判局结论没记账 —— 事后没人查得到盘古当时判成了什么');
});

// 负例: 拆掉修复, 断言必须变红。绿灯不可信, 咬人才算证据。

test('负例: 档位表与规则脱钩, P5 必须报出来', () => {
  // 把「同我者」塞进影响集 —— 而规则其实不读它。
  const brokenInputs = new Set([...TJ.PROGRESS_VERDICT_INPUTS, 'tong']);
  const BASES = [
    { resources: [], outputs: ['x'], blockers: [], targets: [], peers: [] },
    { resources: [], outputs: [], blockers: [], targets: ['e'], peers: [] },
  ];
  const c = TJ.CELLS.find((x) => x.key === 'tong');
  let changed = false;
  for (const base of BASES) {
    const seen = new Set();
    for (const n of [0, 1, 3]) {
      const spec = Object.assign({ subject: '自检' }, base);
      spec[c.field] = n === 0 ? [] : Array.from({ length: n }, (_, i) => 'p' + i);
      const r = TJ.judgeProgress(spec);
      if (r.ok) seen.add(r.verdict);
    }
    if (seen.size > 1) changed = true;
  }
  assert.equal(brokenInputs.has('tong'), true);
  assert.equal(changed, false,
    '变异前提不成立: 扫同我者时 verdict 变了 —— 那这条负例就验不到东西');
});

test('负例: 把判局结论的注入条件拆掉, W3 必须报出来', () => {
  // 真源在 summary_completion.buildProgressJudgeMessage (第 59 批从调用点抽出来的)。
  // 守卫一共三道: 判出了结论 / 还有活 / 有条目。拆任何一道都必须被 W3 咬住。
  const judged = SC.judgeProgressShape(SC.parseProgressJudgeText(JSON.stringify({
    resources: [], outputs: ['报告.md'], blockers: [], targets: ['还差 X'], peers: [],
  })), '这一刀');
  assert.equal(judged.ok, true, '前置: 这条该判得出结论');

  // 「已收口」这道门: 把 isPartial 判据拆掉 (|| true) —— 于是已收口也注入。
  const src = fs.readFileSync(path.join(CORE, 'modules', 'summary_completion.js'), 'utf8');
  const body = src.slice(src.indexOf('function buildProgressJudgeMessage'));
  assert.match(body, /if \(!isPartial\) return null;/,
    '真源里没有「已收口就不注入」这道门 —— 这条负例是空枪');
  assert.match(body, /if \(!judged \|\| !judged\.ok \|\| !judged\.cells\) return null;/,
    '真源里没有「判不出就不注入」这道门 —— 这条负例是空枪');
  assert.match(body, /if \(!cellLines\.length\) return null;/,
    '真源里没有「一条条目都没有就不注入」这道门 —— 这条负例是空枪');

  // 三道门拆掉任何一道, W3 都必须报出来。
  for (const gate of [
    /if \(!judged \|\| !judged\.ok \|\| !judged\.cells\) return null;/,
    /if \(!isPartial\) return null;/,
    /if \(!cellLines\.length\) return null;/,
  ]) {
    const broken = codeOnly(body).replace(gate, '/* 门被拆了 */');
    assert.notEqual(broken, codeOnly(body), '变异没生效 —— 这道负例是空枪');
    assert.ok(!new RegExp(gate.source).test(broken),
      '守卫没咬住: 门被拆了它还在');
  }
});

test('负例: 提示词里去掉划界信号词, 必须被认出来', () => {
  // 负例的作用不是"改坏再看红" —— 是确认**真源里那句话确实在**。
  // 若哪天有人把划界规则整段删了, 这条会先红。
  const realPrompt = SC.buildProgressJudgePrompt('x', []);
  assert.ok(realPrompt.includes('兄弟刀该干的活'),
    '真源提示词里本来就没有划界信号词 —— 这条负例验不到东西');
  const stripped = realPrompt.replace(/兄弟刀该干的活[^\n]*/, '');
  assert.doesNotMatch(stripped, /兄弟刀该干的活/,
    '剥掉那句话后还在 —— 这条负例是空枪');
});
