// 2026-10-28 (第 136 批 · P3) —— 「只读 / 禁止写」落到执行层
//
// 这组测试守的是**接线**的刀, 顺便把「只读」这个词钉死在真行为上。
//
// 现场: 设置页早就写着「只读: 只能查文件 / 跑只读命令, 不能写, 不能联网」,
// permission.js 的 default 档也确实写着 allowWrite:false / allowNetwork:false ——
// 但 **`PermissionEngine.can()` 全仓没有任何调用方** (rg `\.can\(` 零命中)。
// ⇒ 切到「只读」只改了一个标签, 工具照样写盘、照样联网。
// 这跟 2026-10-16 那次「只读角色闸门只长在 sub-agent.js 里, j2 主循环根本没接」
// 是同一类病: 规则写在配置/提示词里, 执行层没接线, 而且**不报错**。
//
// 反证已做 (见文末 G13): 把 permission_guard 短路成 {allowed:true} 之后,
// G12 的行为探针立刻失败 —— 文件真被写出来了。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 测试不许碰主人的真实状态目录 (踩坑日志第 15 条: 夹具不许指向生产盘)。
// permission.js 在**模块加载期**把 PANGU_HOME 算死 (_LEVEL_FILE), 之后再改环境变量没用,
// 所以必须在这个文件最顶上设。
const _HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu_permguard_home_'));
process.env.PANGU_HOME = _HOME;

const M = (p) => require(path.join(__dirname, '..', p));
const perm = M('modules/permission.js');
const guard = M('modules/permission_guard.js');

const LOOP_SRC = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
const SUB_SRC = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');
const SINGLE_SRC = fs.readFileSync(path.join(__dirname, '..', 'pangu-single.js'), 'utf8');

// ---------- 一、只读档到底禁了什么 ----------

test('G1 从没设置过档位的机器 = 不限 (兼容 2026-10-28 之前的行为)', () => {
  // 新装 / state 被删的机器, 以前实际上什么都不拦 (default 档从没被执行层读过)。
  // 若把兜底改成「只读」, 开源版主人第一次跑就撞上一个写不了记忆的盘古 ——
  // 那是**新造的**事故。所以兜底 = 不限; 一旦主人在设置页**显式**选「只读」, 那才是真的。
  assert.ok(!fs.existsSync(path.join(_HOME, 'state', 'permission.json')),
    '这个用例要求 state 目录里还没有 permission.json (否则测的不是"从没设置过")');
  assert.strictEqual(perm.getCurrentLevel(), 'bypassPermissions');
  const g = guard.checkToolPermission('write_file', { path: '/tmp/x.md', content: 'x' }, {});
  assert.strictEqual(g.allowed, true,
    '没设置过档位 ⇒ 保持老行为 (不限), 不能新造一个"新装就只读"的坑');
});

test('G2 只读档: 写盘 / 联网必须真被拒 (不是只改标签)', () => {
  perm.setCurrentLevel('default', { scope: 'global' });
  const cases = [
    ['write_file', { path: '/tmp/pangu_guard_should_not_exist.md', content: 'x' }],
    ['file_edit', { path: '/tmp/x.md', content: 'x' }],
    ['file_edit_batch', { edits: [] }],
    ['memory_write', { text: 'x' }],
    ['code_execute', { code: 'open("/tmp/x","w")' }],
    ['exec_command', { command: 'mkdir -p /tmp/pangu_guard_dir' }],
    ['exec_command', { command: "cat > /tmp/pangu_guard_heredoc.md << 'EOF'\nx\nEOF" }],
    ['exec_command', { command: 'rm -rf /tmp/pangu_guard_dir' }],
    ['exec_command', { command: 'git commit -m x' }],
    ['web_search', { q: '天气' }],
    ['web_fetch', { url: 'http://example.com' }],
    ['exec_command', { command: 'curl -sS http://example.com' }],
    ['exec_command', { command: 'wget http://example.com/x' }],
  ];
  for (const [name, args] of cases) {
    const g = guard.checkToolPermission(name, args, {});
    assert.strictEqual(g.allowed, false,
      '只读档必须拦下 ' + name + ' (' + JSON.stringify(args).slice(0, 60) + ')');
    assert.ok(g.reason && g.reason.length > 5,
      name + ' 被拒必须给出人话理由 (模型要知道自己该换什么路)');
  }
});

test('G3 只读档不许把"只读"做成"啥也干不了"', () => {
  perm.setCurrentLevel('default', { scope: 'global' });
  const cases = [
    ['read_file', { path: '/tmp/x' }],
    ['list_directory', { path: '/tmp' }],
    ['bazi_calc', { year: 1975 }],
    ['exec_command', { command: 'ls -la /tmp' }],
    ['exec_command', { command: 'grep -rn foo /tmp' }],
    ['exec_command', { command: 'git status' }],
  ];
  for (const [name, args] of cases) {
    const g = guard.checkToolPermission(name, args, {});
    assert.strictEqual(g.allowed, true,
      '只读档必须放行只读调用 ' + name + ' (' + JSON.stringify(args).slice(0, 60) + ')');
  }
});

test('G4 规划档: 写只准落在白名单路径, 网络放行', () => {
  perm.setCurrentLevel('plan', { scope: 'global' });
  const ok = guard.checkToolPermission(
    'write_file', { path: path.join(os.tmpdir(), 'pangu_plan_ok.md'), content: 'x' }, {});
  assert.strictEqual(ok.allowed, true, 'tmp 是规划档的白名单路径, 必须放行');
  const bad = guard.checkToolPermission(
    'write_file', { path: path.join(os.homedir(), 'Desktop', 'pangu_plan_bad.md'), content: 'x' }, {});
  assert.strictEqual(bad.allowed, false, '白名单外的路径必须被拒');
  assert.strictEqual(guard.checkToolPermission('web_search', { q: 'x' }, {}).allowed, true,
    '规划档允许联网');
});

test('G5 完全访问 / 接受编辑: 写盘照旧放行 (不能把老板自己焊死)', () => {
  perm.setCurrentLevel('bypassPermissions', { scope: 'global' });
  assert.strictEqual(
    guard.checkToolPermission('write_file', { path: path.join(os.homedir(), 'Desktop', 'x.md'), content: 'x' }, {}).allowed,
    true, '完全访问档必须放行写盘');
  assert.strictEqual(guard.checkToolPermission('web_search', { q: 'x' }, {}).allowed, true);

  perm.setCurrentLevel('acceptEdits', { scope: 'global' });
  assert.strictEqual(
    guard.checkToolPermission('write_file', { path: path.join(os.homedir(), 'Desktop', 'x.md'), content: 'x' }, {}).allowed,
    true, '接受编辑档必须放行写盘');
  assert.strictEqual(guard.checkToolPermission('web_search', { q: 'x' }, {}).allowed, true);
});

test('G6 会话级 override 更严 ⇒ 只那个会话被拒, 别的会话照旧', () => {
  perm.setCurrentLevel('bypassPermissions', { scope: 'global' });
  perm.setCurrentLevel('default', { scope: 'session', sessionId: 'ro-session' });
  assert.strictEqual(
    guard.checkToolPermission('write_file', { path: '/tmp/x' }, { sessionId: 'ro-session' }).allowed,
    false, '被显式调到只读的会话必须禁写');
  assert.strictEqual(
    guard.checkToolPermission('write_file', { path: '/tmp/x' }, { sessionId: 'other-session' }).allowed,
    true, '别的会话不受影响 (全局档是 bypass)');
});

test('G7 将灵 override 只能收紧, 不能放开', () => {
  perm.setCurrentLevel('bypassPermissions', { scope: 'global' });
  const g = guard.checkToolPermission('write_file', { path: '/tmp/x' },
    { sessionId: 's7', agentLevel: 'default' });
  assert.strictEqual(g.allowed, false,
    '将灵把档位收到「只读」时, 它的写盘必须被拒 (收紧方向)');
});

// ---------- 二、接线 (三个执行点都要接上) ----------

test('G8 主循环必须真的调 checkToolPermission', () => {
  assert.match(LOOP_SRC, /checkToolPermission\(/,
    'j2_agent_loop 必须调 permission_guard.checkToolPermission —— '
    + '只把闸门写进 permission_guard.js = 对生产是死代码');
});

test('G9 档位闸必须排在人工审批闸之前', () => {
  const gate = LOOP_SRC.indexOf('checkToolPermission(');
  const ask = LOOP_SRC.indexOf('requirePermission(tc.name', gate);
  assert.ok(gate > 0, '闸门得先存在');
  assert.ok(ask > gate,
    '只读档是**禁止**不是"问一下主人" —— 闸门必须早于审批');
});

test('G10 将灵与 legacy 那条路也必须接上', () => {
  assert.match(SUB_SRC, /checkToolPermission\(/,
    'sub-agent.js 必须接档位闸 —— 主循环禁住了、将灵这边还放行 = 只做了一半');
  assert.match(SINGLE_SRC, /checkToolPermission\(/,
    'pangu-single.js 的 legacy 路径也必须接档位闸');
});

test('G11 被拒必须返回 blocked:true + 独立标记', () => {
  const idx = LOOP_SRC.indexOf('checkToolPermission(');
  const seg = LOOP_SRC.slice(idx, idx + 2200);
  assert.match(seg, /blocked:\s*true/,
    '被拒要带 blocked:true, 否则 self-check 会把它当工具真失败, 逼模型换姿势重试同一刀');
  assert.match(seg, /_permission_denied:\s*true/,
    '要带独立标记, 便于与 ROLE_READ_ONLY / SANDBOX_BLOCKED / 审批拒绝区分');
});

// ---------- 三、行为: 假模型真跑一遍 j2 native 循环 ----------
//
// 上面那些是"档位判得对不对", 这里是"生产路径上真的拦不拦"。
// 必须子进程: j2 主循环有心跳 interval / 自动续跑, 跑完不一定让事件循环退出。
const _PROBE_SRC = `
const path = require('path');
const fs = require('fs');
const os = require('os');
const LEVEL = process.env.PROBE_LEVEL || 'default';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu_permguard_probe_home_'));
process.env.PANGU_HOME = HOME;
fs.mkdirSync(path.join(HOME, 'state'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'state', 'permission.json'), JSON.stringify({
  global: LEVEL, session_overrides: {}, updated_at: new Date().toISOString(),
}));
const CORE = ${JSON.stringify(path.join(__dirname, '..'))};
const J2 = require(path.join(CORE, 'modules', 'j2_agent_loop.js'));
const TARGET = path.join(os.tmpdir(), 'pangu_permguard_probe_' + process.pid + '.md');
try { fs.unlinkSync(TARGET); } catch (_) {}
const sse = [];
const res = { writeHead(){}, setHeader(){}, flushHeaders(){},
  write(c){ sse.push(String(c)); return true; }, on(){}, aborted:false, writableEnded:false, end(){} };
let turn = 0;
J2.init({
  _detectToolCallSupport: async () => true,
  _callLLMForAgent: async () => {
    turn += 1;
    if (turn === 1) {
      return { choices: [{ message: { role:'assistant', content:'我来写文件。', tool_calls: [{
        id:'call_write_1', type:'function', function:{ name:'write_file',
        arguments: JSON.stringify({ path: TARGET, content: '# 被写出的内容' }) } }] } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 } };
    }
    return { choices: [{ message: { role:'assistant', content:'', tool_calls: [{
      id:'call_write_done', type:'function', function:{ name:'task_done',
      arguments: JSON.stringify({ status:'completed',
        summary:'① 完成: 写文件\\n② 证据: write_file\\n③ 未做: 无\\n④ 交接: 无' }) } }] } }],
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
      [{ role:'system', content:'sys' }, { role:'user', content:'写个文件' }],
      { id:'permguard-probe', provider:'lmstudio', endpoint:'http://127.0.0.1:9/none', context_length:8192 },
      { on(){}, aborted:false }, res,
      { userInput:'写个文件', reqBody:{ session_id:'permguard-probe' }, sessionId:'permguard-probe',
        role:'main', toolsAllowed:['write_file','task_done'] });
  } catch (e) { err = e; }
  const all = sse.join('');
  const fileExists = fs.existsSync(TARGET);
  let content = '';
  if (fileExists) { try { content = fs.readFileSync(TARGET, 'utf8'); } catch(_){} }
  if (fileExists) { try { fs.unlinkSync(TARGET); } catch (_) {} }
  process.stdout.write(JSON.stringify({
    level: LEVEL,
    blocked: /PERMISSION_LEVEL_BLOCKED/.test(all),
    fileExists, content, err: err ? String(err.message) : '',
  }));
  process.exit(0);
})();
`;

function _runProbe(level) {
  const { execFileSync } = require('child_process');
  const out = execFileSync(process.execPath, ['-e', _PROBE_SRC], {
    timeout: 30000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: Object.assign({}, process.env, { PROBE_LEVEL: level }),
  });
  return JSON.parse(out.trim().split('\n').filter(Boolean).pop());
}

test('G12 只读档跑生产路径: write_file 必须被拒且文件不落盘', () => {
  const r = _runProbe('default');
  assert.strictEqual(r.err, '', 'j2 主循环不该抛异常: ' + r.err);
  assert.strictEqual(r.blocked, true,
    '只读档下 write_file 必须被档位闸拦下 (SSE 里要能看到 PERMISSION_LEVEL_BLOCKED)');
  assert.strictEqual(r.fileExists, false,
    '被拒的写盘绝不能真落盘 —— 写出的内容: ' + JSON.stringify(r.content));
});

test('G13 探针本身不是摆设: 同一段探针在 bypass 档下必须真把文件写出来', () => {
  // 反证。少了这条, G12 可能因为"探针根本没跑到执行点"而恒绿。
  const r = _runProbe('bypassPermissions');
  assert.strictEqual(r.err, '', 'j2 主循环不该抛异常: ' + r.err);
  assert.strictEqual(r.fileExists, true,
    'bypass 档下同一条 write_file 必须真写出去 —— 写不出说明探针没打到执行点, G12 就是空枪');
});

