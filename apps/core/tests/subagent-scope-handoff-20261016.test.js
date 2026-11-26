// 2026-10-16 子 agent 分工上下文 + 汇报契约
//
// 这组测试锁的是老板点名的那个问题: "全量重填肯定是大问题, 就该把任务拆了, 分下去,
// 子 agent 只做自己相关的, 做好汇报"。
//
// 旧行为 (2026-10-14 连续上下文): 把最近 8 轮对话 + 12 条兄弟产出**无条件**发给
// 每一个子 agent。实测一次调用的继承块最坏 11000 字符, 而它真正的作业常常只有
// 一百来字。代价三样: ① 每个兄弟替别人的活付一次 prefill ② 模型读到主人的宽问题
// 就去答整件事而不是自己那一刀 ③ 同一件事在 turns/taskText/findings 各出现一次。
//
// 每条都写成"结构性不变量", 防被改回去 —— 尤其是 D2, 那是接线时真实踩过的坑。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');

const M = (p) => require(path.join(__dirname, '..', p));

// 2026-10-17: 派发实现搬进 subagent_runner (主 agent 复用同一份), 子 agent 的
// 上下文继承/汇报契约一段跟着搬了过去。凡是钉"子 agent 派发路径"的守卫都必须
// 两个文件一起读 —— 只读 dispatcher 会**漏看**搬走的那一半, 而漏看正是这组
// 守卫存在的理由。
const DISPATCH_SRC = ['modules/j2_dispatcher.js', 'modules/subagent_runner.js']
  .map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8'))
  .join('\n');

// ===== 1. 分工上下文: 按作业选, 不全量灌 =====

test('D1 与本次作业无关的轮次不下发 (全量重填就是从这里来的)', () => {
  const { _resetContainer, getContainer } = M('modules/session_container.js');
  _resetContainer();
  const c = getContainer();
  c.appendTurn('s', 'user', '同样模型 codex 都比盘古快');
  c.appendTurn('s', 'assistant', 'prefill 贵');
  c.appendTurn('s', 'user', '顺便排个八字');
  c.appendTurn('s', 'assistant', '乾为天');
  c.appendTurn('s', 'user', '在 /tmp/pangu-aaa 目录建 f1.txt');
  c.appendTurn('s', 'assistant', '建好了');

  const scoped = c.buildScopedContext('s', { taskText: '去 /tmp/pangu-aaa 读回 f1.txt 确认内容' });
  assert.strictEqual(scoped.scope.on, true, '有作业文本就必须走筛选');
  assert.ok(scoped.scope.turns_dropped_irrelevant >= 4,
    '性能讨论和八字那几轮不该下发, 实测砍了 ' + scoped.scope.turns_dropped_irrelevant);
  const joined = scoped.turns.map(t => t.content).join('\n');
  assert.ok(!joined.includes('codex'), '不该把无关话题塞进来');
  assert.ok(!joined.includes('乾为天'), '不该把无关结论塞进来');
  assert.ok(joined.includes('/tmp/pangu-aaa'), '相关的必须留下');
});

test('D2 底线: 最近 2 轮无条件下发 (砍掉就是让人凭空开工, 比慢更糟)', () => {
  const { _resetContainer, getContainer } = M('modules/session_container.js');
  _resetContainer();
  const c = getContainer();
  // 全是无关话题, 作业本身也没有历史可比
  c.appendTurn('s', 'user', 'A 话题');
  c.appendTurn('s', 'assistant', 'B 话题');
  const scoped = c.buildScopedContext('s', { taskText: '把 /tmp/zzz 目录清空' });
  assert.strictEqual(scoped.turns.length, 2, '最近 2 轮是连续性底线, 不许被筛选砍掉');
  assert.strictEqual(scoped.scope.turns_dropped_irrelevant, 0, '底线条不计入"砍掉"');
});

test('D3 upToTurns 必须挡住本轮提问 (本轮已经在 taskText 里了)', () => {
  const { _resetContainer, getContainer } = M('modules/session_container.js');
  _resetContainer();
  const c = getContainer();
  c.appendTurn('s', 'user', '先确认目录 /tmp/pangu-aaa 建好了没有');
  c.appendTurn('s', 'assistant', '还没建');
  const before = 2;
  c.appendTurn('s', 'user', '现在把 f1.txt 建起来');   // 本轮
  c.appendTurn('s', 'user', '再补一个 f2.txt');           // 本轮第二条

  const noGuard = c.buildScopedContext('s', { taskText: '建 f1.txt' });
  assert.ok(noGuard.turns.some(t => String(t.content).includes('再补一个 f2')),
    '不传 upToTurns 时本轮确实会漏进来 (所以上游必须传)');

  const guarded = c.buildScopedContext('s', { taskText: '建 f1.txt', upToTurns: before });
  assert.ok(!guarded.turns.some(t => String(t.content).includes('再补一个 f2')),
    '传了 upToTurns 就必须挡住本轮 —— 否则同一句话在 turns 和 taskText 各灌一遍');
});

test('D4 无关的底线产出只留指针, 不整段贴 (200 字指针 ≠ 700 字结论)', () => {
  const { _resetContainer, getContainer } = M('modules/session_container.js');
  _resetContainer();
  const c = getContainer();
  c.appendTurn('s', 'user', '在 /tmp/pangu-aaa 建 f1');
  c.appendTurn('s', 'assistant', '建好了');
  c.appendFinding('s', {
    agent: 'executor', task: '建 f1 到 /tmp/pangu-aaa',
    summary: '目录已建好', tools: ['exec_command'],
  });
  // 最新一条是**别的切片**的活, 与本次作业无关
  c.appendFinding('s', {
    agent: 'analyzer', task: '排八字',
    summary: '乾为天体健用刚, 大吉', tools: ['bazi_calc'],
  });

  const scoped = c.buildScopedContext('s', { taskText: '读回 /tmp/pangu-aaa/f1.txt 确认' });
  assert.ok(scoped.findingsBlock.includes('目录已建好'), '相关的产出结论要留');
  assert.ok(scoped.findingsBlock.includes('刚做完'), '无关的底线产出要留指针');
  assert.ok(!scoped.findingsBlock.includes('体健用刚'),
    '无关产出的正文不该下发 —— 它会诱导子 agent 去答八字而不是读文件');
});

test('D5 taskText 已带结论时不重复贴 (模型把重复当强调)', () => {
  const { _resetContainer, getContainer } = M('modules/session_container.js');
  _resetContainer();
  const c = getContainer();
  c.appendTurn('s', 'user', 'x');
  c.appendTurn('s', 'assistant', 'y');
  c.appendFinding('s', { agent: 'z', task: '查 A', summary: 'A 的结论是已全部核实无误请放心' });
  c.appendFinding('s', { agent: 'w', task: '查 B', summary: 'B 的结论是全部完成没有问题' });

  const probe = 'A 的结论是已全部核实无误请放心';
  const scoped = c.buildScopedContext('s', { taskText: '继续, ' + probe });
  assert.ok(!scoped.findingsBlock.includes(probe), '已经在任务里的结论不重复贴');
  assert.ok(scoped.findingsBlock.includes('不重复贴'), '要留一行指针说明为什么没有正文');
});

test('D6 没有作业文本可比时退回全量, 不假装筛过', () => {
  const { _resetContainer, getContainer } = M('modules/session_container.js');
  _resetContainer();
  const c = getContainer();
  for (let i = 0; i < 10; i++) c.appendTurn('s', i % 2 ? 'assistant' : 'user', '轮' + i);
  const scoped = c.buildScopedContext('s', {});
  assert.strictEqual(scoped.scope.on, false, '空 taskText 必须退回全量');
  assert.strictEqual(scoped.turns.length, 8, '退回全量时用全量配额');
});

test('D7 分工配额必须比全量配额紧 (否则这层代码是装饰)', () => {
  const { SCOPED_LIMITS } = M('modules/session_container.js');
  assert.ok(SCOPED_LIMITS.maxTurns < 8, '分工轮次上限必须小于全量的 8');
  assert.ok(SCOPED_LIMITS.maxChars < 6000, '分工字符上限必须小于全量的 6000');
  assert.ok(SCOPED_LIMITS.findingsMax < 12, '分工产出条数必须小于全量的 12');
  assert.strictEqual(SCOPED_LIMITS.floorTurns, 2, '连续性底线锁 2 轮');
});

test('D8 路径必须能按段对上 (任务写全路径 / 产出写目录 = 同一个地方)', () => {
  const { _resetContainer, getContainer } = M('modules/session_container.js');
  _resetContainer();
  const c = getContainer();
  c.appendTurn('s', 'user', '在建目录');
  c.appendTurn('s', 'assistant', '还在建');
  // 这条带路径的产出**不在底线位** (下面还有一条更新的), 所以它能不能活下来
  // 只能靠相关性判定 —— 正是在这里踩过"整条路径吞成一个键, 交集为空"的坑。
  c.appendFinding('s', {
    agent: 'executor', task: '在 /tmp/pangu-d8 建目录',
    summary: '目录已建好', tools: ['exec_command'],
  });
  c.appendFinding('s', {
    agent: 'executor', task: '在 /tmp/pangu-d8 建 f1',
    summary: '/tmp/pangu-d8/f1.txt 已写入', tools: ['exec_command'],
  });

  // 任务写的是完整文件路径, 兄弟产出写的是同一个目录 —— 不按段对上就判成无关,
  // 于是刚建好的目录这个关键事实被砍掉, 子 agent 会重跑一遍建目录。
  const scoped = c.buildScopedContext('s', { taskText: '去 /tmp/pangu-d8/f1.txt 读回确认内容' });
  assert.strictEqual(scoped.scope.findings_dropped_irrelevant, 0,
    '同目录的产出不许被当成无关砍掉');
  assert.ok(scoped.findingsBlock.includes('/tmp/pangu-d8/f1.txt 已写入'),
    '同目录的结论要下发');
  assert.ok(scoped.findingsBlock.includes('目录已建好'),
    '非底线位的同目录产出也要活下来 —— 它靠的是路径分段, 不是底线');
});

// ===== 2. 汇报契约: 分工要成立, 光"分下去"不够 =====

test('R1 汇报契约必须锁死"证据"和"未做"两行', () => {
  const { REPORT_CONTRACT } = M('modules/session_container.js');
  for (const must of ['① 完成', '② 证据', '③ 未做', '④ 交接']) {
    assert.ok(REPORT_CONTRACT.includes(must), '契约缺 ' + must);
  }
  assert.ok(/没有就写"无"/.test(REPORT_CONTRACT),
    '必须允许交白 —— "应该完成/已处理"这种不算证据, 逼它写"无"');
});

test('R2 关键词兜底那条综合路径不许丢掉子 agent 的汇报 (只喂原始 toolHistory = 白派一次活)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_dispatcher.js'), 'utf8');
  // 这条路径原来是 parts.length ? parts.join(...) : summary —— 只要子 agent 调过工具,
  // 它写的汇报就被丢掉, 父 agent 拿着同一批 JSON 再推一遍结论。
  assert.ok(!/const evidence = parts\.length \? parts\.join/.test(src),
    '旧写法还在: 工具证据一旦非空, 汇报就被顶掉');
  assert.ok(src.includes('汇报:\\n') || src.includes('汇报:'), '汇报必须进综合 prompt');
  assert.ok(/汇报可疑时才查/.test(src), '工具证据降级成"结论可疑时才翻"的次要通道');
});

test('R3 六条子 agent 调用点都必须带本次作业文本 (不传就退化成全量)', () => {
  const src = DISPATCH_SRC;
  const calls = src.match(/_ctxForSubagent\('[^']*'\s*,\s*[^)]+\)/g) || [];
  assert.ok(calls.length >= 6, '六条路径都要传 taskText, 实测 ' + calls.length);
  const noTask = calls.filter(c => /\(\s*'(task|inline)'\s*\)/.test(c));
  assert.strictEqual(noTask.length, 0, '不许有只传 mode 不传 taskText 的调用点: ' + noTask.join(' | '));
  assert.ok(src.includes('upToTurns: _priorTurnCount'), '必须传 upToTurns 挡住本轮提问');
  assert.ok(src.includes('_priorTurnCount'), 'append 之前必须先记轮数');
});

test('R4 汇报契约只加给模型看的那份, 判定用原始任务文本', () => {
  const src = DISPATCH_SRC;
  // 契约里全是"完成/证据/未做"这种通用词, 混进相关性判定会让任何历史都显得相关。
  //
  // 2026-10-17: 这条原来逐字匹配 `_ctxForSubagent('task', taskText)` —— 调用点多传了
  // 一个兄弟路径参数就被判红, 而判定用的仍然是原始 taskText, 意图一点没变。
  // 逐字匹配整个调用形状 = 把"意图"写成"格式", 改对了也要报红 (今天第二次栽这类护栏)。
  // 改成只钉**意图**: 第二个参数必须是原始 taskText。
  assert.ok(/_ctxForSubagent\(\s*'task'\s*,\s*taskText\s*(?:,|\))/.test(src),
    "DAG 路径的判定必须用原始 taskText (第二个参数), 不许换成挂了契约的 _taskTextFinal");
  // 反向加严: 判定那份不许是挂了汇报契约的文本。两个一起钉, 才不会有人"改绿"这条护栏。
  const _calls = src.match(/_ctxForSubagent\([^)]*\)/g) || [];
  assert.ok(_calls.every(c => !/_taskTextFinal|_subUserMsg|REPORT_CONTRACT/.test(c)),
    '判定用的文本里混进了挂契约的那份: ' + _calls.join(' | '));
  assert.ok(src.includes('_subUserMsg.content = _taskTextFinal + require(\'./session_container\').REPORT_CONTRACT'),
    '契约加在模型看的那份上, 不加在判定用的那份上');
});

// ===== 3. 端到端: 子 agent 真的只拿到自己那一刀 =====

test('E1 子 agent 的 messages 里只有相关轮次, 无关的不在里面', async () => {
  const subAgent = M('agents/sub-agent.js');
  const { _resetContainer, getContainer } = M('modules/session_container.js');
  _resetContainer();
  const c = getContainer();
  c.appendTurn('p1', 'user', '同样模型 codex 都比盘古快, 为什么');
  c.appendTurn('p1', 'assistant', 'prefill 占大头');
  c.appendTurn('p1', 'user', '在 /tmp/pangu-e2ee 目录建 f1.txt');
  c.appendTurn('p1', 'assistant', '建好了');
  c.appendFinding('p1', { agent: 'executor', task: '建 f1 到 /tmp/pangu-e2ee', summary: '目录建好了' });

  let seen = null;
  const fakeLLM = async (messages) => {
    seen = messages;
    return { text: '已确认 f1 存在', nativeCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
  await subAgent.runAgentLoop({
    taskText: '读回 /tmp/pangu-e2ee/f1.txt 确认内容',
    mode: 'executor',
    model: { id: 'fake' },
    cfg: {},
    configPath: '/nonexistent.json',
    sessionId: 'p1#sub-0',
    parentSessionId: 'p1',
    contextSeed: c.buildScopedContext('p1', { taskText: '读回 /tmp/pangu-e2ee/f1.txt 确认内容' }),
    callLLMFn: fakeLLM,
  });
  assert.ok(seen, '必须真的调了模型');
  const all = JSON.stringify(seen);
  assert.ok(all.includes('/tmp/pangu-e2ee'), '相关轮次要继承');
  assert.ok(!all.includes('prefill 占大头'), '无关轮次不许进 messages —— 那会让 executor 去答性能问题');
});

test('E2 连续性没被分工切断 (底线轮次 + 兄弟产出仍在)', async () => {
  const subAgent = M('agents/sub-agent.js');
  const { _resetContainer, getContainer } = M('modules/session_container.js');
  _resetContainer();
  const c = getContainer();
  c.appendTurn('p2', 'user', '先确认目录 /tmp/pangu-e2ee 建好了没有');
  c.appendTurn('p2', 'assistant', '还没建');
  c.appendFinding('p2', { agent: 'executor', task: '建目录 /tmp/pangu-e2ee', summary: '目录已建好' });

  let seen = null;
  const fakeLLM = async (messages) => {
    seen = messages;
    return { text: '好', nativeCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
  const r = await subAgent.runAgentLoop({
    taskText: '在 /tmp/pangu-e2ee 里写 f1.txt',
    mode: 'executor',
    model: { id: 'fake' },
    cfg: {},
    configPath: '/nonexistent.json',
    sessionId: 'p2#sub-0',
    parentSessionId: 'p2',
    contextSeed: c.buildScopedContext('p2', { taskText: '在 /tmp/pangu-e2ee 里写 f1.txt' }),
    callLLMFn: fakeLLM,
  });
  assert.ok(r && r.metrics && r.metrics.ctx_turns_inherited >= 2,
    '底线轮次必须继承, 实测 ' + (r && r.metrics && r.metrics.ctx_turns_inherited));
  const all = JSON.stringify(seen);
  assert.ok(all.includes('还没建'), '上一手做到哪了要看得见');
  assert.ok(all.includes('目录已建好'), '兄弟产出要继承');
  assert.ok(all.includes('继承纪律'), '继承纪律必须仍在');
});

