// 2026-10-16 只读闸门接线 + 空转续跑提前收口
//
// 这组测试守的是两刀**接线**的刀, 不是算法的刀。
// 上一刀 (action-policy-20261014) 已经把 checkRoleAction 的裁决测对了,
// 但真实子 agent 根本不走那条路 —— 现场证据 (session request-1792124456972-8cekw6#sub-0-analyzer):
//   j2_agent_loop.js:634 注释自己写着「planner 拆出来的子任务走的是 j2 主循环, 不经过 sub-agent.js」,
//   而 checkRoleAction 只长在 sub-agent.js 的执行器里。
//   结果: analyzer 用 `cat > /tmp/... <<EOF` 真写出了文件, 一次没被拦,
//   而 prompt 里那句「只读角色跑写命令会被直接拒 (ROLE_READ_ONLY), 不弹审批也没有例外」是**假的**。
// 这就是 AGENTS.md 踩坑日志第 1 条「注释 ≠ 隔离」的原样复发: 规则写在 prompt 里, 执行层没接线。
//
// 第二刀: 自动续跑的「无进展就收口」原来只在用满 _autoResumeMax 之后才判,
// 于是前 3 次续跑一律照烧。那轮现场 pending=0、子 agent 已 task_done 交卷,
// 仍然重读同一个内容不变的文件 3 次, 每次一轮 LLM 约 214s, 白烧 10 分钟以上。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const M = (p) => require(path.join(__dirname, '..', p));
const LOOP_SRC = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');

// ---------- 第一刀: 闸门必须接在真实执行点上 ----------

test('W1 j2 主循环必须真的调 checkRoleAction —— 只写在 sub-agent.js 里等于没有', () => {
  // 这条是整组测试的核心。前一刀 (2026-10-14) 加闸门时只改了 sub-agent.js,
  // 而子 agent 全部走 j2_agent_loop, 于是那道闸门在生产上一次都没触发过。
  assert.match(LOOP_SRC, /checkRoleAction\(_roleForThisLoop/,
    'j2_agent_loop 必须用本轮真实角色 (_roleForThisLoop) 调 checkRoleAction; '
    + '只在 sub-agent.js 里调 = 对真实子 agent 是死代码');
});

test('W2 闸门必须放在 sandbox / 审批之前 —— 关掉沙箱不等于授权删文件', () => {
  const gate = LOOP_SRC.indexOf('checkRoleAction(_roleForThisLoop');
  const ask = LOOP_SRC.indexOf('requirePermission(tc.name', gate);
  assert.ok(gate > 0, '闸门得先存在');
  assert.ok(ask > gate,
    '只读边界必须早于人工审批 —— 老板关掉 sandbox / 改成 bypassPermissions, '
    + '都不该让只读角色拿到写权限');
});

test('W3 越界必须返回 blocked:true, 让下游知道这是"被拒"不是"工具坏了"', () => {
  // 不带 blocked 的话, 2681 行的 self-check 会把它当工具真失败,
  // 逼模型换姿势重试同一刀 —— 那是另一种空转。
  const seg = LOOP_SRC.slice(LOOP_SRC.indexOf('checkRoleAction(_roleForThisLoop'), 
    LOOP_SRC.indexOf('checkRoleAction(_roleForThisLoop') + 1600);
  assert.match(seg, /blocked:\s*true/,
    '越界返回要带 blocked:true, 否则 self-check 逼模型重试');
  assert.match(seg, /_role_denied:\s*true/,
    '越界返回要带独立标记 _role_denied, 便于与 SANDBOX_BLOCKED / 审批拒绝区分');
});

test('W4 判定自身抛错时按拒绝处理 (fail-closed)', () => {
  // 内部出错返回 ok:true = 把「注释 ≠ 隔离」这个坑换个地方再挖一遍,
  // 而且这次连日志都不会有。
  const seg = LOOP_SRC.slice(LOOP_SRC.indexOf('checkRoleAction(_roleForThisLoop'),
    LOOP_SRC.indexOf('checkRoleAction(_roleForThisLoop') + 1600);
  assert.match(seg, /catch\s*\(\s*_\w*\s*\)\s*\{[\s\S]*?fail-closed/,
    '判定异常必须 fail-closed 拒绝, 不能放行');
});

test('W5 现场那条 cat > 命令, 在 j2 路径上现在必须被拒', () => {
  // 端到端复刻现场: analyzer 角色 + 那条 heredoc 写盘命令。
  const ap = M('modules/action_policy.js');
  const v = ap.checkRoleAction('analyzer', 'exec_command', {
    command: "cat > /tmp/pangu_gua_test_analysis.md << 'EOF'\n# 分析\nEOF",
  });
  assert.strictEqual(v.ok, false, '现场那条写盘命令必须被拒');
  assert.strictEqual(v.code, 'ROLE_READ_ONLY');
});

// ---------- 第二刀: 无进展就别续跑 ----------

test('W6 无进展检查必须发生在「每次续跑前」, 不能只在用满上限后', () => {
  // 锚在 `if (` 上而不是裸字符串: 上面那段注释里就写了 `_resumes > _autoResumeMax`,
  // 拿裸字符串 indexOf 会抢到注释, 断言就成了永远为假的摆设 (踩坑日志第 2 条)。
  const gateIdx = LOOP_SRC.indexOf('if (_resumes > 1) {');
  const limitIdx = LOOP_SRC.indexOf('if (_resumes > _autoResumeMax) {');
  assert.ok(gateIdx > 0, '缺「每次续跑前」的无进展检查');
  assert.ok(limitIdx > gateIdx,
    '提前检查必须排在上限检查之前 —— 否则前 N 次续跑照样白烧 (现场就是白烧了 3 次)');
});

test('W7 第一次续跑没有可比基线, 必须放行', () => {
  // 基线缺失时猜一个 = 误杀真长任务。宁可多跑一轮, 不可把长任务掐死。
  const start = LOOP_SRC.indexOf('if (_resumes > 1) {');
  const seg = LOOP_SRC.slice(start, start + 1500);
  assert.match(seg, /_doneAtPre >= 0 \|\| _filesAtPre >= 0/,
    '基线缺失 (-1) 要跳过判定放行, 不能默认判成「无进展」');
});

test('W8 提前检查必须复用同一对基线字段, 不新增第二套状态', () => {
  // 今天踩过的坑: 同一判据抄多处 = 迟早只改一处。
  // 提前检查和上限检查必须读写的还是 done_at_last_resume / files_at_last_resume。
  const start = LOOP_SRC.indexOf('if (_resumes > 1) {');
  const seg = LOOP_SRC.slice(start, start + 1500);
  assert.match(seg, /done_at_last_resume/, '必须读同一个 done 基线字段');
  assert.match(seg, /files_at_last_resume/, '必须读同一个 files 基线字段');
});

test('W9 有进展的长任务仍然能续跑 (提前检查不许变成新的掐死)', () => {
  // 收窄谓词把真需求砍掉是今天的第 5 个坑, 自己写的回归用例必须抓住它。
  const start = LOOP_SRC.indexOf('if (_resumes > 1) {');
  const seg = LOOP_SRC.slice(start, start + 1500);
  assert.match(seg, /_planProgressPre = _donePre > _doneAtPre/,
    'plan done 步数增长 = 有进展, 必须放行');
  assert.match(seg, /_fileProgressPre = _filesPre > _filesAtPre/,
    '不同文件数增长 = 有进展, 必须放行');
  assert.match(seg, /if \(!_planProgressPre && !_fileProgressPre\)/,
    '只有两个信号都没动才收口');
});

test('W10 无进展收口时不能把计数加 1 —— 收口不该推进度', () => {
  const start = LOOP_SRC.indexOf('if (_resumes > 1) {');
  const seg = LOOP_SRC.slice(start, start + 1500);
  assert.match(seg, /auto_resumes:\s*_resumes - 1/,
    '判为无进展直接返回 false 时, 计数要写回原值, 否则下一轮又从更高的数起步');
});

test('W11 main 角色不受只读闸门影响 (别把主循环焊死)', () => {
  const ap = M('modules/action_policy.js');
  assert.strictEqual(ap.checkRoleAction('main', 'exec_command', { command: 'cat > /tmp/a.md' }).ok, true);
  // 2026-10-18: 原来这里传的是 'executor'。英文身份删掉之后它不再是角色, 而守卫对
  // 认不出的角色名是 fail-closed —— 于是这条断言测的其实变成"认不出的名字被当只读",
  // 跟标题要说的"可写角色不被误伤"完全不是一回事。改成真角色 kun 才是原来那个意思。
  assert.strictEqual(ap.checkRoleAction('kun', 'exec_command', { command: 'cat > /tmp/a.md' }).ok, true);
});

// ---------- 行为层: 假模型真跑一遍 j2 native 循环 ----------
//
// W1~W4 是结构断言 (源码里有没有接线)。它们挡不住"接线还在、行为已经变了" ——
// 比如判定对象传错、返回形状改了、工具执行点搬了家。所以这里再用假模型把
// j2 主循环的 native 分支真跑一遍, 让它以 analyzer 身份发一条真实的 `cat >`。
//
// 为什么必须子进程: j2 主循环里有心跳 interval / 自动续跑 / 压缩分支, 跑完不一定
// 让事件循环退出, 放主进程会让整个测试文件挂死 (continuity-and-harness-20261014
// 的 D1 已经踩过, 当时是靠 setTimeout + process.exit 才活下来)。
const _PROBE_SRC = `
const path = require('path');
const fs = require('fs');
const os = require('os');
// 2026-10-16: 测试不许碰主人的真实状态目录。
// 原来这个探针用固定 sessionId 且直接落盘到 ~/.pangu/state/ (ledger / tasks / handoff /
// checkpoints / budget), 于是预算和 checkpoint **跨轮累积** —— W12/W13 的行为随"跑过几遍"变。
// 现场量到的: rounds 从 30 一路涨到 33, 假模型一次都没被调用 (llmTurns=0),
// W12 的 fileExists===false 就成了恒真, 反证也跟着失去意义。
// 必须在 require 之前改: budget.js / checkpoint.js 在模块加载期就把路径算死了, 之后再改没用。
process.env.PANGU_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu_gate_probe_home_'));
const CORE = ${JSON.stringify(path.join(__dirname, '..'))};
const J2 = require(path.join(CORE, 'modules', 'j2_agent_loop.js'));
const TARGET = path.join(os.tmpdir(), 'pangu_j2_gate_behavior_target.md');
try { fs.unlinkSync(TARGET); } catch (_) {}
const sse = [];
const res = { writeHead(){}, setHeader(){}, flushHeaders(){},
  write(c){ sse.push(String(c)); return true; }, on(){}, aborted:false, writableEnded:false, end(){} };
let turn = 0;
J2.init({
  _detectToolCallSupport: async () => true,          // 生产走的就是 native 这条
  _callLLMForAgent: async () => {
    turn += 1;
    if (turn === 1) {
      return { choices: [{ message: { role:'assistant', content:'我来写报告。', tool_calls: [{
        id:'call_gate_1', type:'function', function:{ name:'exec_command',
        arguments: JSON.stringify({ command: "cat > " + TARGET + " << 'EOF'\\n# 被越权写出的内容\\nEOF" }) } }] } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 } };
    }
    return { choices: [{ message: { role:'assistant', content:'', tool_calls: [{
      id:'call_gate_done', type:'function', function:{ name:'task_done',
      arguments: JSON.stringify({ status:'completed',
        summary:'① 完成: 分析完毕\\n② 证据: exec_command\\n③ 未做: 无\\n④ 交接: 无' }) } }] } }],
      usage: { prompt_tokens: 120, completion_tokens: 30 } };
  },
  _callLLMForAgentStream: async function*(){ yield ''; },
  _j2ExecuteToolCalls: async () => [], _j2AppendToolResults: () => {},
  _recordSessionToMemory: async () => {}, _sessionRecall: async () => ({ ok:false }),
  safeResWrite: (r, s) => r.write(s), _hasUnclosedToolBlock: () => false,
});
(async () => {
  let err = null;
  try {
    await J2._runAgentLoopLegacyStream(
      [{ role:'system', content:'sys' }, { role:'user', content:'写个报告' }],
      { id:'gate-probe-model', provider:'lmstudio', endpoint:'http://127.0.0.1:9/none', context_length:8192 },
      { on(){}, aborted:false }, res,
      { userInput:'写个报告', reqBody:{ session_id:'j2-gate-behavior' }, sessionId:'j2-gate-behavior',
        role:'analyzer', toolsAllowed:['exec_command','read_file','task_done'] });
  } catch (e) { err = e; }
  const all = sse.join('');
  const fileExists = fs.existsSync(TARGET);
  let content = '';
  if (fileExists) { try { content = fs.readFileSync(TARGET, 'utf8'); } catch(_){} }
  if (fileExists) { try { fs.unlinkSync(TARGET); } catch (_) {} }
  process.stdout.write(JSON.stringify({
    path: (all.match(/"path":"([^"]+)"/) || [])[1] || '',
    blocked: /ROLE_READ_ONLY/.test(all),
    fileExists, content, err: err ? String(err.message) : '',
  }));
  process.exit(0);
})();
`;

function _runGateBehaviorProbe() {
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', _PROBE_SRC], {
    timeout: 30000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split('\n').filter(Boolean).pop());
}

test('W12 j2 native 路径真跑一遍: analyzer 的 cat > 必须被拒且文件不落盘', () => {
  // 这条是整组测试的**行为**证明, 前面 W1~W4 只是结构。
  // 反证已做: 把 checkRoleAction 短路成 {ok:true} 后本测试立刻失败
  // (文件真被写出, 内容 "# 被越权写出的内容") —— 即 8cekw6 事故的完整复现。
  const r = _runGateBehaviorProbe();
  assert.strictEqual(r.path, 'j2-native',
    '探针必须跑在 native 路径上, 否则验的不是生产路径 (实测: ' + r.path + ')');
  assert.strictEqual(r.blocked, true,
    'analyzer 的写盘命令必须被 ROLE_READ_ONLY 拦下');
  assert.strictEqual(r.fileExists, false,
    '被拒的命令绝不能真写盘 —— 越权写出的内容: ' + JSON.stringify(r.content));
});

test('W13 行为探针自身要有效: 不能是恒过的摆设', () => {
  // 上一次踩过的坑: 断言挂在注释里的字面量上 / 条件恒假, 测试全绿而行为是错的。
  // 这里反查探针的三条输出都来自真实循环, 任何一个为空都说明循环没跑到那一步。
  const r = _runGateBehaviorProbe();
  assert.ok(r.path && r.path !== '?', '探针没拿到 execution_path, 循环可能没进 native 分支');
  assert.strictEqual(r.err, '', 'j2 主循环不该抛异常: ' + r.err);
  assert.strictEqual(typeof r.blocked, 'boolean');
  assert.strictEqual(typeof r.fileExists, 'boolean');
});

// ---------- 只读同参数重读: 回放而不是重跑 ----------
//
// 现场 (session request-1792124456972-8cekw6#sub-0-analyzer): 同一 session 里
// read_file 用完全相同的 params 调了两次 (日志 79783 / 79907 行一字不差),
// 中间隔着一轮 ~214s 的 LLM。放行它的是 _READONLY_REPEAT_OK —— 而豁免理由
// ("压缩会触发重读") 只对一半情况成立: 结果还在上下文里时, 重读就是白烧一轮。
//
// 修法不是"拦住"而是"回放": 把上一轮的结果原样发回去。
// 结果还在上下文里 → 白省一轮; 被压缩掉了 → 等于把内容还给模型, 比重读还快。
const _REREAD_PROBE_SRC = `
const path = require('path'); const fs = require('fs'); const os = require('os');
// 同上: 隔离状态目录, 否则预算/checkpoint 跨轮累积, 这条测试已经是第二次因为它 flaky 了。
process.env.PANGU_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu_reread_probe_home_'));
const CORE = ${JSON.stringify(path.join(__dirname, '..'))};
const J2 = require(path.join(CORE, 'modules', 'j2_agent_loop.js'));
// 每次运行用独立路径 —— 固定路径 + 并发 = 竞态, 这条测试已经因此 flaky 过一次
// (单跑 15/15, 混在 test:chain 里就变 0 份)。
const TARGET = path.join(os.tmpdir(), 'pangu_reread_probe_' + process.pid + '.md');
fs.writeFileSync(TARGET, 'first-write\\n');
const sse = [];
const res = { writeHead(){}, setHeader(){}, flushHeaders(){},
  write(c){ sse.push(String(c)); return true; }, on(){}, aborted:false, writableEnded:false, end(){} };
let turn = 0;
const seenMessages = [];
J2.init({
  _detectToolCallSupport: async () => true,
  _callLLMForAgent: async (messages) => {
    turn += 1;
    seenMessages.push(JSON.parse(JSON.stringify(messages || [])));
    // 轮 1: 读文件   轮 2: **同参数**再读一次   轮 3: 交卷
    if (turn <= 2) {
      return { choices: [{ message: { role:'assistant', content:'', tool_calls: [{
        id: 'call_read_'+turn, type:'function', function:{ name:'read_file',
        arguments: JSON.stringify({ path: TARGET }) } }] } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 } };
    }
    return { choices: [{ message: { role:'assistant', content:'', tool_calls: [{
      id:'call_done', type:'function', function:{ name:'task_done',
      arguments: JSON.stringify({ status:'completed',
        summary:'① 完成: 读完\\n② 证据: read_file\\n③ 未做: 无\\n④ 交接: 无' }) } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 10 } };
  },
  _callLLMForAgentStream: async function*(){ yield ''; },
  _j2ExecuteToolCalls: async () => [], _j2AppendToolResults: () => {},
  _recordSessionToMemory: async () => {}, _sessionRecall: async () => ({ ok:false }),
  safeResWrite: (r, s) => r.write(s), _hasUnclosedToolBlock: () => false,
});
(async () => {
  let err = null;
  try {
    await J2._runAgentLoopLegacyStream(
      [{ role:'system', content:'sys' }, { role:'user', content:'读一下' }],
      { id:'reread-probe', provider:'lmstudio', endpoint:'http://127.0.0.1:9/none', context_length:8192 },
      { on(){}, aborted:false }, res,
      { userInput:'读一下', reqBody:{ session_id:'reread-probe' }, sessionId:'reread-probe',
        role:'analyzer', toolsAllowed:['read_file','task_done'] });
  } catch (e) { err = e; }
  const all = sse.join('');
  let content = ''; try { content = fs.readFileSync(TARGET,'utf8'); } catch(_){}
  try { fs.unlinkSync(TARGET); } catch (_) {}
  process.stdout.write(JSON.stringify({
    llmTurns: turn,
    replayed: /"replayed":true/.test(all),
    // 判据不是我们自己发的事件形状 (那会变成"测自己的实现"),
    // 而是**模型第 3 轮实际收到的上下文**里有没有两份带内容的 read_file 结果。
    //
    // 2026-10-17 修 (这条红了很久, 而且因为 test:chain 是 && 串联, 它把后面**所有**
    // 护栏都堵死了 —— 包括当天新加的): 取 seenMessages 的最后一条是量错了对象。
    // 现场探针实测 llmTurns=4, 每轮消息数 [2, 4, 7, 1]:
    //   第 3 轮 (7 条) = 真读 + [READONLY-LOOP] 提示 + 回放 —— 两份 read_file 都在, 功能是好的;
    //   第 4 轮 (1 条) = 收口后的 [PARTIAL_JUDGE] 单轮提问, 上下文里本来就不该有工具结果。
    // 注释写的也是"第 3 轮", 代码却取了最后一条 —— 意图和实现对不上, 一直报假红。
    // 改成"最后一个带工具结果的轮次", 与注释的意图一致。
    toolMsgsInFinalTurn: (function () {
      let last = [];
      for (const turnMsgs of seenMessages) {
        const hasTool = (turnMsgs || []).some(m => m && m.role === 'tool');
        if (hasTool) last = turnMsgs;
      }
      return last.filter(m => m && m.role === 'tool'
        && typeof m.content === 'string'
        && m.content.indexOf('first-write') !== -1).length;
    })(),
    err: err ? String(err.message) : '',
  }));
  process.exit(0);
})();
`;

function _runRereadProbe() {
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', _REREAD_PROBE_SRC], {
    timeout: 30000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split('\n').filter(Boolean).pop());
}

test('W14 同参数 read_file 第二次必须回放, 且结果仍发回模型', () => {
  // W14 + W15 断言的是**同一次运行**, 所以只 spawn 一次探针, 两个判据都读它。
  // 之前拆成两个 test 各 spawn 一次, 固定临时路径 + 并发就撞出 flaky。
  const r = _runRereadProbe();
  assert.strictEqual(r.err, '', 'j2 主循环不该抛异常: ' + r.err);
  assert.strictEqual(r.replayed, true,
    '第二次同参数 read_file 必须回放缓存 (省一整轮 ~214s 的 LLM)');
  // 回放最容易出的错: 拦下了却没把内容发回去 → 模型收到空 tool 消息,
  // 于是再去读第三次。所以判据必须是"模型最后真收到了几份带内容的只读结果",
  // 而不是我们自己 emit 的事件 —— 后者只是在自己测自己。
  assert.strictEqual(r.toolMsgsInFinalTurn, 2,
    '模型最后一轮必须收到两份带内容的 read_file 结果 (真读 + 回放), 实际 '
    + r.toolMsgsInFinalTurn + ' 份');
});

