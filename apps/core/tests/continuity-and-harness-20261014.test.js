// 2026-10-14 连续上下文 + harness 溯源 + token 预算
//
// 这组测试锁的是三件以前**没有测试覆盖、也没有痕迹可查**的事:
//   1) 将灵继承上下文 (旧码 sub-agent.js 是 `const messages = []`, 每个将灵从零开始)
//   2) 工具结果截断可见 (旧码 .slice(0,3000) 静默, 模型从半截数据下结论)
//   3) token 预算当主闸门 (codex 逆向确认: codex 根本没有 max_tool_iterations)
//
// 每条都写成"结构性不变量", 防以后被改回去。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const M = (p) => require(path.join(__dirname, '..', p));

// ===== 1. session 容器: 连续上下文的两个真源 =====

test('S1 appendTurn 去重 + 角色过滤, 连续轮次不会重复注入', () => {
  const { _resetContainer, getContainer } = M('modules/session_container.js');
  _resetContainer();
  const c = getContainer();
  assert.strictEqual(c.appendTurn('s1', 'user', '帮我看下这个盘'), true);
  assert.strictEqual(c.appendTurn('s1', 'user', '帮我看下这个盘'), false, '同内容同角色不该重复记');
  assert.strictEqual(c.appendTurn('s1', 'system', '系统注入的'), false, 'system 不是对话轮次');
  assert.strictEqual(c.appendTurn('s1', 'assistant', '得乾为天'), true);
  const ctx = c.buildSubagentContext('s1');
  assert.strictEqual(ctx.turns.length, 2);
  assert.deepStrictEqual(ctx.turns.map(t => t.role), ['user', 'assistant']);
});

test('S2 appendFinding 同将灵同任务覆盖不堆叠 (纠错复核会重跑同一 task)', () => {
  const { _resetContainer, getContainer } = M('modules/session_container.js');
  _resetContainer();
  const c = getContainer();
  c.appendFinding('s1', { agent: 'checker', task: '验盘', summary: '第一版', tools: ['bazi_calc'] });
  c.appendFinding('s1', { agent: 'checker', task: '验盘', summary: '复核版', tools: ['bazi_calc'], ok: true });
  const st = c.getState('s1');
  assert.strictEqual(st.findings.length, 1, '同 agent+task 应替换');
  assert.strictEqual(st.findings[0].summary, '复核版');
  assert.ok(c.buildSubagentContext('s1').findingsBlock.includes('复核版'));
});

test('S3 buildSubagentContext maxTurns:0 只取 findings (taskText 已带 history 时用)', () => {
  const { _resetContainer, getContainer } = M('modules/session_container.js');
  _resetContainer();
  const c = getContainer();
  c.appendTurn('s1', 'user', '上一轮问了 A');
  c.appendTurn('s1', 'assistant', '答了 A');
  c.appendFinding('s1', { agent: 'executor', task: 'T', summary: '查完了 X' });
  const ctx = c.buildSubagentContext('s1', { maxTurns: 0 });
  assert.strictEqual(ctx.turns.length, 0, 'maxTurns:0 必须生效, 不能被 || 退回默认');
  assert.ok(ctx.findingsBlock.includes('查完了 X'));
});

test('S4 上下文字符封顶生效 (N 将灵共享一条上下文, 不封顶会 N 倍超支)', () => {
  const { _resetContainer, getContainer } = M('modules/session_container.js');
  _resetContainer();
  const c = getContainer();
  for (let i = 0; i < 30; i++) c.appendTurn('s1', i % 2 ? 'assistant' : 'user', '轮' + i + ' ' + 'x'.repeat(3000));
  const ctx = c.buildSubagentContext('s1');
  assert.ok(ctx.turns.length <= 8, '轮次上限生效');
  const total = ctx.turns.reduce((n, t) => n + t.content.length, 0);
  assert.ok(total <= 6000 + 1300, '总字符封顶生效, 实测 ' + total);
});

// ===== 2. run_trace: Codex 式工具结果溯源 =====

test('T1 超长工具结果必须标 truncated 并把事实说给模型 (旧码 slice 静默截断)', () => {
  const rt = M('modules/run_trace.js');
  rt.setEnabled(false);
  const tr = rt.createTrace({ sessionId: 'tt1', agent: 'executor' });
  const r = tr.toolResult('read_file', { ok: true, result: 'A'.repeat(50000) }, { maxBytes: 3000 });
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.originalBytes, 50000);
  assert.ok(r.keptBytes <= 3000);
  assert.ok(r.content.includes('[TRUNCATED]'), '截断标记必须进给模型的内容里');
  assert.ok(/禁止据缺失部分下结论/.test(r.content), '要明说不能拿缺失部分下结论');
  assert.ok(r.toolResultId, '每个结果要有可追的 id');
  tr.finish('ok');
  rt._resetForTest();
});

test('T2 未超长时不加截断标记 (正常结果不该被污染)', () => {
  const rt = M('modules/run_trace.js');
  rt.setEnabled(false);
  const tr = rt.createTrace({ sessionId: 'tt2', agent: 'executor' });
  const r = tr.toolResult('bazi_calc', { ok: true, result: { 卦: '乾' } });
  assert.strictEqual(r.truncated, false);
  assert.ok(!r.content.includes('[TRUNCATED]'));
  tr.finish('ok');
  rt._resetForTest();
});

test('T3 失败工具结果保留 ERROR 原文 (防"只许引用原文"这条铁律失效)', () => {
  const rt = M('modules/run_trace.js');
  rt.setEnabled(false);
  const tr = rt.createTrace({ sessionId: 'tt3', agent: 'executor' });
  const r = tr.toolResult('exec_command', { ok: false, error: 'sandbox denied: path outside root' });
  assert.ok(r.content.includes('ERROR: sandbox denied: path outside root'));
  assert.strictEqual(tr.counters().tools_failed, 1);
  tr.finish('ok');
  rt._resetForTest();
});

test('T4 守卫记账: 拒答必须留痕 (以前拒答了现场只能靠猜)', () => {
  const rt = M('modules/run_trace.js');
  rt.setEnabled(false);
  const tr = rt.createTrace({ sessionId: 'tt4', agent: 'guard' });
  tr.guard({ guard: 'answer_alignment', action: 'block', reason: 'isAligned=false', userInput: '1+1等于几' });
  const s = tr.finish('blocked');
  assert.strictEqual(s.counters.guards_block, 1);
  rt._resetForTest();
});

test('T5 token 记账用 usage, 没 usage 才估算 (账本不能断)', () => {
  const rt = M('modules/run_trace.js');
  rt.setEnabled(false);
  const tr = rt.createTrace({ sessionId: 'tt5', agent: 'executor' });
  tr.tokens({ prompt_tokens: 1200, completion_tokens: 300 }, 'r0');
  tr.tokens(null, 'r1');
  const l = tr.tokenLedger();
  assert.strictEqual(l.input, 1200);
  assert.strictEqual(l.output, 300);
  assert.ok(l.calls >= 1);
  tr.finish('ok');
  rt._resetForTest();
});

// ===== 3. guardAnswer 拒答 (端到端) =====

test('G1 guardAnswer 拦下跑题答案时答复仍是对齐话术', () => {
  const aa = M('modules/answer_alignment.js');
  const r = aa.guardAnswer('检查路由 bug', '天气不错', '', '');
  assert.strictEqual(r.aligned, false);
  assert.strictEqual(r.blocked, true);
  assert.ok(r.text.includes('没有拿到与原问题对齐的答案'));
});

test('G2 短答案豁免仍然成立 (2026-10-14 修的拒答真凶不能被改回去)', () => {
  const aa = M('modules/answer_alignment.js');
  assert.strictEqual(aa.guardAnswer('1+1等于几？直接回答数字。', '2', '', '').aligned, true);
  assert.strictEqual(aa.guardAnswer('请只回复：收到', '收到', '', '').aligned, true);
});

// ===== 4. 源码结构性不变量 =====

test('C1 sub-agent 支持继承上下文, 隔离与连续性拆成两个参数', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');
  assert.ok(src.includes('contextSeed'), '必须支持继承上下文');
  assert.ok(src.includes('parentSessionId'), '隔离与连续性必须拆成两个参数');
  assert.ok(/const messages = \[\];/.test(src) && src.includes('_seed.turns'), '空数组起点还在, 但必须紧接上下文注入');
});

test('C2 工具结果不许再出现裸 slice(0, 3000) (静默截断是 codex 明确防住的)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');
  assert.ok(!/JSON\.stringify\(tr\.result\)\.slice\(0, 3000\)/.test(src), '不得再有静默 slice');
  assert.ok(src.includes('[TRUNCATED]'), '截断必须可见');
});

test('C3 token 墙必须存在, 且不得对 token 墙续跑 (否则 token 墙形同虚设)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');
  assert.ok(src.includes('_tokenBudget'), '必须有 token 预算闸门');
  assert.ok(/'token'/.test(src), '必须能判出撞的是 token 墙');
  assert.ok(/_budgetKind === 'tool_calls'/.test(src), '只有工具次数墙才续跑');
});

test('C4 dispatcher 两条子 agent 路径 (fixed_flow / DAG) 都必须接上下文', () => {
  // 2026-10-17: 派发实现整体搬进 subagent_runner (主 agent 也要用同一份),
  // 所以「哪条路接了上下文」要**两个文件一起读** —— 只读 dispatcher 会漏掉 DAG 那条,
  // 而漏看恰恰是这条守卫要防的那种回归。分两处统计, 免得一条断言互相遮蔽。
  const disp = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_dispatcher.js'), 'utf8');
  const run = fs.readFileSync(path.join(__dirname, '..', 'modules', 'subagent_runner.js'), 'utf8');
  const src = disp + '\n' + run;
  const n = (src.match(/contextSeed: _ctxForSubagent\(/g) || []).length;
  assert.ok(n >= 5, 'subAgent.run 5 个调用点都要接, 实测 ' + n);
  assert.ok(src.includes('_subCtx'), 'DAG 路径 (_subMessages) 也要接');
  assert.ok(src.includes('appendFinding'), '产出必须回写 session');
  assert.ok(src.includes('appendTurn'), '对话轮次必须记进 session');
});

// ===== 5. 端到端: 子 agent 真的继承了上下文 =====

test('E1 子 agent 的 messages 里真的带上了继承的轮次与将灵产出', async () => {
  const subAgent = M('agents/sub-agent.js');
  const { _resetContainer, getContainer } = M('modules/session_container.js');
  _resetContainer();
  const c = getContainer();
  c.appendTurn('p1', 'user', '帮我查一下 a.txt 的内容');
  c.appendTurn('p1', 'assistant', '上次已经读过, 里面写着 hello');
  c.appendFinding('p1', { agent: 'executor', task: '读 a.txt', summary: 'a.txt 内容 = hello', tools: ['read_file'] });

  let seen = null;
  const fakeLLM = async (messages) => {
    seen = messages;
    return { text: '已确认 hello', nativeCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };
  const r = await subAgent.runAgentLoop({
    taskText: '再确认一遍',
    mode: 'executor',
    model: { id: 'fake' },
    cfg: {},
    configPath: '/nonexistent.json',
    sessionId: 'p1#sub-0',
    parentSessionId: 'p1',
    contextSeed: c.buildSubagentContext('p1'),
    callLLMFn: fakeLLM,
  });
  assert.ok(seen, '必须真的调了模型');
  assert.ok(seen.some(m => m.role === 'assistant' && String(m.content).includes('hello')), '继承了上一轮 assistant 答复');
  assert.ok(seen.some(m => m.role === 'system' && String(m.content).includes('a.txt 内容 = hello')), '继承了兄弟将灵产出');
  assert.ok(r && r.metrics && r.metrics.ctx_turns_inherited >= 2, 'metrics 要报继承了几轮');
  assert.ok(r.metrics.trace_id, '每次运行都要有 trace id');
  assert.ok(seen.some(m => m.role === 'system' && String(m.content).includes('继承纪律')), '必须写明继承纪律');
});

test('E2 撞 token 墙时如实说是 token 墙, 不再谎报"工具调用预算"', async () => {
  const subAgent = M('agents/sub-agent.js');
  const { _resetContainer } = M('modules/session_container.js');
  _resetContainer();
  let calls = 0;
  const fakeLLM = async () => {
    calls++;
    if (calls === 1) return { text: '继续', nativeCalls: [{ name: 'system_info', args: {} }], usage: { prompt_tokens: 800000, completion_tokens: 100 } };
    return { text: '撞墙了, 收尾', nativeCalls: [], usage: { prompt_tokens: 100, completion_tokens: 10 } };
  };
  const r = await subAgent.runAgentLoop({
    taskText: '长任务',
    mode: 'executor',
    model: { id: 'fake' },
    cfg: {},
    configPath: '/nonexistent.json',
    sessionId: 'p2#sub-0',
    parentSessionId: 'p2',
    roleCfg: { token_budget: 400000 },
    callLLMFn: fakeLLM,
  });
  assert.ok(r.metrics.budget_exhausted, '应判定撞预算');
  assert.strictEqual(r.metrics.budget_kind, 'token', '撞的必须是 token 墙');
  assert.ok(r.metrics.tokens_used > 400000);
});

test('E3 未配 token 预算时行为与旧码一致 (不默认开墙, 免得既有配置全变慢)', async () => {
  const subAgent = M('agents/sub-agent.js');
  const { _resetContainer } = M('modules/session_container.js');
  _resetContainer();
  const fakeLLM = async () => ({ text: '直接答', nativeCalls: [], usage: { prompt_tokens: 999999, completion_tokens: 1 } });
  const r = await subAgent.runAgentLoop({
    taskText: '直答', mode: 'executor', model: { id: 'fake' }, cfg: {},
    configPath: '/nonexistent.json', sessionId: 'p3#sub-0', callLLMFn: fakeLLM, directAnswer: true,
  });
  assert.strictEqual(r.metrics.budget_exhausted, false, '没配预算就不该撞墙');
  assert.strictEqual(r.metrics.budget_kind, null);
});


// ===== 6. 主循环连续性 (2026-10-14 现场补) =====
// 现场实测发现: 简单对话**不进 dispatcher**, 走 [j2-path] j2-native —— 主循环自己
// 就是对话。而主循环的 messages 全部来自本次请求体, 前端不重发历史就没有历史。
// 第1轮"代号是青龙七77号"记进 memory_write, 第2轮"它是什么"答了 current_time。
// 所以只修 dispatcher 不够, 主循环入口必须接, 否则绝大多数简单对话仍然断链。

test('C5 主循环入口必须接连续性, 且答复出口必须回写', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  assert.ok(src.includes('j2-continuity'), '主循环必须有连续性接线并打日志 (现场靠这条日志确认是否生效)');
  const emitIdx = src.indexOf('const emitFinalOnce');
  const retIdx = src.indexOf("_sc.appendTurn(_sessionId, 'assistant'", emitIdx);
  assert.ok(emitIdx > 0 && retIdx > emitIdx, '答复回写必须挂在 emitFinalOnce 上 (唯一答复出口)');
});

test('C6 子 agent 由 dispatcher 注入, 主循环不得重复注入 (两处都塞会双倍烧 token)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  assert.ok(/if \(!opts \|\| opts\.continuityInjected !== true\)/.test(src), '必须有防重入开关');
  assert.ok(/!opts\.role/.test(src), '子 agent (有 role) 不得在主循环再注入一次');
});


// ===== 7. 将灵 trace 必须开在 j2 主循环 (2026-10-14 现场取证补) =====
//
// 现场日志: `[dispatcher] 将灵上场: executor` + `[j2-role-tools] role=executor ...`
// 说明 planner 拆出的子任务走 j2 主循环 (opts.role=executor), **不经过 sub-agent.js**
// —— 而这是最常见的一条 (实测 analyzer/executor/checker 三个将灵全走它)。
// 后果: 三个将灵真跑了, harness 里一个 subagent trace 都没有, token/工具/上下文
// 继承全部统计不到。trace 跟着 LLM 调用走, 不跟着角色名走。

test('D1 opts.role 存在时必须开将灵级 trace, 并记下继承了几轮', async () => {
  // 隔离到子进程: j2 主循环里有心跳 interval / 续跑 / 压缩分支, 跑完不一定让事件循环退出,
  // 放主进程里会让整个测试文件挂死 (实测 --test-timeout 40s 被 cancel)。
  // 这里只关心"trace 有没有被开出来", 而它在函数入口就写了盘, 所以子进程跑几秒足够。
  const { execFile } = require('child_process');
  const childSrc = `
    const J2 = require(${JSON.stringify(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'))});
    require(${JSON.stringify(path.join(__dirname, '..', 'modules', 'pangu_helpers.js'))}).init({
      _config: { llm: { models: [] } }, CONFIG_PATH: '/tmp/role-trace-test.json',
      PRESETS: [], safeGuard: null, fs: require('fs'),
    });
    const res = { writeHead(){}, setHeader(){}, flushHeaders(){}, write(){return true;}, on(){}, aborted:false, writableEnded:false, end(){} };
    J2.init({
      _detectToolCallSupport: async () => false,
      _callLLMForAgentStream: async function* () { yield '<tool name="task_done">{"summary":"好"}</tool>'; },
      _callLLMForAgent: async () => ({ choices: [{ message: { content: '' } }], usage: { prompt_tokens: 500, completion_tokens: 20 } }),
      _j2ExecuteToolCalls: async () => [], _j2AppendToolResults: () => {},
      _recordSessionToMemory: async () => {}, _sessionRecall: async () => ({ ok: false }),
      safeResWrite: (r, s) => r.write(s), _hasUnclosedToolBlock: () => false,
    });
    J2._runAgentLoopLegacyStream(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: '干活' }],
      { id: 't-model', provider: 'lmstudio', endpoint: 'http://127.0.0.1:9/none', context_length: 8192 },
      { on(){}, aborted:false }, res,
      { userInput: '干活', reqBody: { session_id: 'roletest' }, sessionId: 'roletest',
        role: 'executor', continuityRoot: 'roletest', continuityInfo: { turns: 3, has_findings: true } }
    ).catch(() => {});
    setTimeout(() => process.exit(0), 6000);
  `;
  await new Promise((resolve) => {
    const c = execFile(process.execPath, ['-e', childSrc], { timeout: 20000 }, () => resolve());
    c.on('error', () => resolve());
  });
  const rt = require('../modules/run_trace');
  const fs2 = require('fs');
  const path2 = require('path');
  let hit = null;
  for (const f of fs2.readdirSync(rt.RUNS_DIR()).filter(f => f.endsWith('.jsonl'))) {
    const txt = fs2.readFileSync(path2.join(rt.RUNS_DIR(), f), 'utf8');
    if (txt.includes('"kind":"subagent"') && txt.includes('"turns":3')) { hit = txt; break; }
  }
  assert.ok(hit, 'opts.role=executor 必须产生 kind=subagent 的 trace, 且带 turns:3');
  assert.ok(hit.includes('context_inherited'), '必须记 context_inherited');
});

test('D2 块外用到的变量不得声明在 if 块内 (真实踩过: ReferenceError 被 catch 吞掉)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  assert.ok(/if \(opts && opts\.role && opts\.role !== 'main'\)/.test(src), '只有带 role 的才算将灵');
  // 真实事故: _roleT0/_roleTtft 被插进 if 块内部 → 块级作用域 → 循环内和 finally 里
  // 引用成 ReferenceError, 而 finally 那处被 catch 吞掉 → trace 有 start 没有 summary,
  // 现场表现为"trace 开了却查不到汇总", 极难定位。这里锁死作用域。
  const ifIdx = src.indexOf("if (opts && opts.role && opts.role !== 'main')");
  const blockEnd = src.indexOf('\n  }\n', ifIdx);
  const declInBlock = src.slice(ifIdx, blockEnd);
  assert.ok(!/const _roleT0\s*=/.test(declInBlock), '_roleT0 在 finally 里被引用, 不能声明在 if 块内');
  assert.ok(!/let _llmTtft\s*=/.test(declInBlock), '_llmTtft 在合流处被引用, 不能声明在 if 块内');
  assert.ok(/const _roleT0 = Date\.now\(\);/.test(src), '_roleT0 必须在函数作用域声明');
});

// ===== 8. harness 必须有读出口 (202-10-14 审计补) =====
//
// 现场统计: run_trace 被 4 个模块写, 但**没有任何地方读它** —— 一堆只写不读的
// jsonl 不算借鉴到位。老板问"刚才那轮为什么慢/是谁拦的/烧了多少 token",
// 只能 ssh 上机翻文件。补三个 GET 端点 + 守卫每日账本。

test('H1 守卫写当日账本, 不是每次拦一个文件 (206 文件里 101 个是 guard)', () => {
  const rt = M('modules/run_trace.js');
  rt.setEnabled(true);
  const before = fs.existsSync(rt.RUNS_DIR()) ? fs.readdirSync(rt.RUNS_DIR()).length : 0;
  for (let i = 0; i < 5; i++) rt.appendGuard({ guard: 'answer_alignment', action: 'block', reason: 'r' + i, userInput: 'q' + i });
  const after = fs.existsSync(rt.RUNS_DIR()) ? fs.readdirSync(rt.RUNS_DIR()).length : 0;
  assert.strictEqual(after, before, '5 次拦截不应该产生 5 个新文件');
  const rows = rt.readGuards();
  assert.ok(rows.length >= 5, '5 条都进了当日账本, 实测 ' + rows.length);
  assert.strictEqual(rows[rows.length - 1].guard, 'answer_alignment');
  assert.ok(rows[rows.length - 1].ts > 0, '账本记录必须带时间戳, 否则事后对不上是哪一轮');
});

test('H2 三个读端点都注册了, 且防路径穿越', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pangu-single', 'routes', 'inline_router.js'), 'utf8');
  assert.ok(src.includes('/api/pangu/harness/runs'), '缺 runs 列表端点');
  assert.ok(src.includes('/api/pangu/harness/run'), '缺单次明细端点');
  assert.ok(src.includes('/api/pangu/harness/guards'), '缺守卫账本端点');
  assert.ok(/replace\(\/\[\^a-zA-Z0-9\._-\]\/g, ''\)/.test(src), 'file 参数必须过白名单, 防 ../ 穿越');
  assert.ok(/YYYY-MM-DD/.test(src), 'day 参数必须校验格式');
});

test('H3 估算用量单列, 不混进 input/output (混进去就分不清真假)', () => {
  const rt = M('modules/run_trace.js');
  rt.setEnabled(false);
  const tr = rt.createTrace({ sessionId: 'h3', agent: 'main' });
  tr.tokens({ prompt_tokens: 100, completion_tokens: 10 }, 'r0');
  tr.estimated(555, 'r1');
  const l = tr.tokenLedger();
  assert.strictEqual(l.input, 100, '真实 usage 只记真实的');
  assert.strictEqual(l.estimated, 555, '估算单列');
  assert.ok(l.estimated_calls === 1);
  // 关键: 估算不能污染 input/output, 否则 summary 看起来有值但其实是估的
  assert.strictEqual(l.output, 10);
  tr.finish('ok');
  rt._resetForTest();
});

test('H4 llm_timing 必须收在两个分支合流处 (只埋非流式分支 = 生产记不到)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  // 生产走流式分支 (直接 _deps._callLLMForAgent + onText), 所以 onText 里必须有 ttft 打点
  assert.ok(/onText: \(d\) => \{[^}]*_llmTtft = Date\.now\(\) - _llmT0/.test(src),
    '流式分支的 onText 必须打首 token 点, 否则生产永远记不到 ttft');
  // 且记账必须在两个分支合流处 (recordTokenUsage 那段), 不能只在某一条分支里
  const convIdx = src.indexOf('const _activeTrace = _roleTrace || _mainTrace;');
  assert.ok(convIdx > 0, '必须在两分支合流处统一收口');
  assert.ok(convIdx > src.indexOf('llmResult = await _deps._callLLMForAgent'), '收口点必须在流式分支之后');
  assert.ok(convIdx > src.indexOf('llmResult = await _callLLMWithTimeout'), '收口点必须在非流式分支之后');
});

test('H5 每次调用各开一个文件的老做法必须消失 (现场散成 43 个碎片)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  assert.ok(!/kind: 'llm_phase'/.test(src), '不得再有 llm_phase 独立文件');
  assert.ok(src.includes('registerSessionTrace'), '主 trace 必须按会话注册, 供分次调用追加');
  assert.ok(src.includes('unregisterSessionTrace'), '收尾必须注销, 防注册表泄漏');
});

// ===== 9. 半截 trace 修复 (2026-10-14 现场 session=jl-verify-1) =====
//
// 现场: 同一轮里两个 analyzer trace, 第一个 10 行完整, 第二个**只有 1 行 start**,
// 后面 context_inherited / tokens / tool_result 全没了 —— 在 harness 里看跟
// "从没跑过"一模一样。长任务被腰斩后, "它到底继承了什么 / 卡在哪" 查无实据。
// 根因: 事件只进内存, 等 finish() 才落盘; 而 finish() 在 sub-agent.js 的 try 里
// (不是 finally), 中途抛错/被杀就永远等不到。

test('T1 没调 finish() 的 trace 也必须留下证据 (原来只剩 1 行 start)', () => {
  const rt = M('modules/run_trace.js');
  rt.setEnabled(true);
  // 文件名只保留 session id 前 24 字符 (_safeName(...).slice(0,24)), 所以探针 id 要短。
  const sid = 'dur' + String(Date.now()).slice(-9);
  // 故意不调 finish() —— 模拟子 agent 中途被腰斩
  const t = rt.createTrace({ sessionId: sid, agent: 'analyzer', kind: 'subagent' });
  t.event('context_inherited', { turns: 2, has_findings: false, findings_chars: 0 });
  t.tokens({ input: 100, output: 20, total_tokens: 120 }, 'round0');
  t.toolResult('exec_command', { ok: true, bytes: 10 });

  const files = fs.readdirSync(rt.RUNS_DIR()).filter(f => f.includes(sid));
  assert.strictEqual(files.length, 1, '应只生成一个 trace 文件');
  const lines = fs.readFileSync(path.join(rt.RUNS_DIR(), files[0]), 'utf8').trim().split('\n')
    .map(l => JSON.parse(l));
  const types = lines.map(l => l.type);
  assert.ok(types.includes('context_inherited'),
    'context_inherited 必须当场落盘 —— 这是"将灵有没有接上文"的唯一证据, 实测 types=' + JSON.stringify(types));
  assert.ok(types.includes('tokens'), 'tokens 必须当场落盘, 实测 ' + JSON.stringify(types));
  assert.ok(types.includes('tool_result'), 'tool_result 必须当场落盘, 实测 ' + JSON.stringify(types));
  t.finish('incomplete');
});

test('T2 退出兜底必须刷出未结算的 trace, 且只挂 exit 不改崩溃语义', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'run_trace.js'), 'utf8');
  assert.ok(src.includes("process.on('exit'"), '必须有退出兜底刷盘');
  // 挂 uncaughtException 会让 Node 不再按默认崩掉 —— 那是拿服务崩溃语义换日志,
  // 必须只挂 exit (Node 在未捕获异常/unhandledRejection/SIGTERM 后都会走到 exit)。
  assert.ok(!src.includes("process.on('uncaughtException'"),
    '不得挂 uncaughtException: 一挂 Node 就不再默认崩了');
  assert.ok(!src.includes('process.on(\'unhandledRejection\''), '同理不得挂 unhandledRejection');
  assert.ok(src.includes('_live.add(trace)'), '开 trace 时必须登记为 live');
  assert.ok(src.includes('_live.delete(trace)'), '结算后必须摘掉, 否则退出时重复刷');
  assert.ok(src.includes('aborted: true'), '兜底刷出的必须标明是被腰斩, 不是正常完成');
});
