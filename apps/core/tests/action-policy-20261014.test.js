// 2026-10-14 按动作裁权限
//
// 这组测试锁的是一个**曾经完全不存在的边界**:
// analyzer 名义只读, 但手握 exec_command; 拦截层只按 tool name 判,
// 而 'rm' 从来就不是一个 tool (命令都包在 exec_command 里), 所以那道拦截
// 一次都没生效过。prompt 里写着"只许只读命令" —— 那是注释, 不是隔离。
//
// 所以断言全部落在**执行层**: checkRoleAction 的裁决, 以及 executeTool 的接线。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const M = (p) => require(path.join(__dirname, '..', p));
const ap = M('modules/action_policy.js');

test('P1 analyzer 的写命令必须被拒, 而不是被"提醒"', () => {
  const v = ap.checkRoleAction('analyzer', 'exec_command', { command: 'rm -rf /tmp/x' });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'ROLE_READ_ONLY');
  // 2026-10-18 拼音统一: 拒绝理由要指的路也是拼音 kun (旧文案写 executor,
  // 而模型手上只有拼音清单 —— 指错人等于让它重蹈一次)。
  assert.ok(/kun/.test(v.reason), '拒绝理由要告诉模型下一步找谁, 实测: ' + v.reason);
});

// 2026-10-18 第二次: 英文身份彻底删掉了 (老板「说了全部换, 还留着干嘛」),
// 所以守卫的输入不再认英文。**取而代之的是把失败方向拧过来**。
//
// 以前靠"也认英文"兜住: checkRoleAction 对非只读角色返回 ok:true, 也就是
// 「不认识 = 放行」; 而守卫查的是拼音集合, 英文名恒不相等 →
// checkRoleAction('analyzer','write_file') 返回过 ok:true, 只读角色静默拿到写盘权,
// 不报错不留痕。英文表删了之后那个兜底没了, 所以认不出来的角色名一律按只读处理。
// 认错一个名字 = 挡错一次调用 (有 reason 文案, owner 一看就知道);
// 认漏一个名字 = 静默放权。两个方向的代价差着量级。
test('P0 守卫认拼音/卦名; 认不出的角色名一律按只读处理 (宁可误伤不可漏放)', () => {
  for (const r of ['li', '离', 'LI', 'analyzer', '随便什么']) {
    assert.strictEqual(ap.checkRoleAction(r, 'write_file', {}).ok, false, r + ' 能写盘');
    assert.strictEqual(ap.checkRoleAction(r, 'exec_command', { command: 'rm -rf x' }).ok, false, r + ' 能 rm');
  }
  // 真角色照常放行 —— 不能为了收英文把正常的可写角色也堵死
  for (const r of ['kun', '坤', 'qian', 'kan', 'gen']) {
    assert.strictEqual(ap.checkRoleAction(r, 'write_file', {}).ok, true, r + ' 被误伤');
  }
  // 元层角色 main 不受将灵只读边界约束 (j2_agent_loop: opts.role || 'main')
  assert.strictEqual(ap.checkRoleAction('main', 'write_file', {}).ok, true, 'main 被误伤, 主循环被焊死');
  assert.strictEqual(ap.checkRoleAction('', 'write_file', {}).ok, true, '没传角色不该被拦');
});

test('P2 li 的只读命令必须放行 (拦过头等于把离·眼废掉)', () => {
  for (const c of ['ls -la', 'find . -name "*.js"', 'grep -rn x apps/core', 'git status', 'npm ls', 'curl -s https://x.com']) {
    const v = ap.checkRoleAction('li', 'exec_command', { command: c });
    assert.strictEqual(v.ok, true, '不该拦: ' + c);
  }
});

test('P3 kun 不受只读限制 (否则盘古什么都干不了)', () => {
  const v = ap.checkRoleAction('kun', 'exec_command', { command: 'rm -rf build/' });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(ap.checkRoleAction('坤', 'write_file', {}).ok, true, '坤(卦名)也要认');
  assert.strictEqual(ap.checkRoleAction('gen', 'memory_write', {}).ok, true);
  // 2026-10-18: 这两行原来断言 checkRoleAction('executor'|'learner') 能过。
  // 英文身份删掉后, 英文名**认不出来** → 按 P0 的 fail-closed 一律当只读 →
  // ok:false。旧断言钉的是"英文也是合法身份", 那是本轮要拆掉的东西本身,
  // 所以整行反过来: 英文名必须拿不到写盘权。
  assert.strictEqual(ap.checkRoleAction('executor', 'write_file', {}).ok, false,
    '英文名不该再被当成可写角色放行 —— 认不出 ≠ 放行');
  assert.strictEqual(ap.checkRoleAction('learner', 'memory_write', {}).ok, false,
    '同上');
});

test('P4 所有只读角色都要受约束, 不能只堵离一个', () => {
  for (const r of ['li', 'xun', 'dui', 'zhen', '离', '巽', '兑', '震']) {
    assert.strictEqual(ap.checkRoleAction(r, 'write_file', {}).ok, false, r + ' 居然能写盘');
    assert.strictEqual(ap.checkRoleAction(r, 'exec_command', { command: 'touch x' }).ok, false, r + ' 居然能 touch');
  }
});

test('P5 引号里的 > 不是重定向 (否则 grep ">" 全被误杀)', () => {
  assert.strictEqual(ap.classifyCommand('echo "a > b"').mutating, false);
  assert.strictEqual(ap.classifyCommand('grep ">" f.txt').mutating, false);
  assert.strictEqual(ap.classifyCommand('echo hi > out.txt').mutating, true);
  assert.strictEqual(ap.classifyCommand('ls | tee log.txt').mutating, true);
});

test('P6 git / 包管理器要分只读子命令, 不能一律当写', () => {
  for (const c of ['git status', 'git log --oneline', 'git diff HEAD', 'git show abc', 'git branch', 'git stash list']) {
    assert.strictEqual(ap.classifyCommand(c).mutating, false, 'git 只读子命令被误杀: ' + c);
  }
  for (const c of ['git commit -m x', 'git push', 'git reset --hard', 'git clean -fd', 'npm install', 'pip install x', 'brew install jq']) {
    assert.strictEqual(ap.classifyCommand(c).mutating, true, '写操作没拦住: ' + c);
  }
  // npm run 会执行任意脚本 = 任意写权限, 但 npm ls 只读
  assert.strictEqual(ap.classifyCommand('npm run build').mutating, true);
  assert.strictEqual(ap.classifyCommand('npm ls').mutating, false);
});

test('P7 任意内联代码按写处理 (python -c / node -e 无法区分读写)', () => {
  assert.strictEqual(ap.classifyCommand('python3 -c "print(1)"').mutating, true);
  assert.strictEqual(ap.classifyCommand('node -e "console.log(1)"').mutating, true);
  assert.strictEqual(ap.classifyCommand('sh -c "ls"').mutating, true);
});

test('P8 判定自身出错必须 fail-closed (否则等于把坑重挖一遍)', () => {
  // 造一个会让 classify 内部炸掉的 args
  const bad = { get command() { throw new Error('boom'); } };
  const v = ap.checkRoleAction('analyzer', 'exec_command', bad);
  assert.strictEqual(v.ok, false, '判定器炸了却放行 = 安全边界失效');
  assert.ok(/fail-closed/.test(v.reason), '要说清是 fail-closed: ' + v.reason);
});

test('P9 executeTool 必须真的接上这层 (导出函数没人调等于没做)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');
  assert.ok(src.includes('action_policy'), 'sub-agent.js 必须 require action_policy');
  assert.ok(/checkRoleAction/.test(src), '必须在执行路径上调 checkRoleAction');
  // 关键: 必须在 TOOLS 查找之后、沙箱之前, 且不受沙箱开关影响
  const iCheck = src.indexOf('checkRoleAction');
  const iTool = src.indexOf('if (!TOOLS[name])');
  const iSandbox = src.indexOf('checkToolCall');
  assert.ok(iCheck > iTool, '要先确认工具存在再裁权限');
  assert.ok(iCheck < iSandbox, '必须在沙箱之前裁 —— 老板关了全局 sandbox, 这层不能跟着关');
  assert.ok(src.includes('permission_denied: true'), '拒绝要带 permission_denied, 上游才知道这是拦截不是工具报错');
  assert.ok(src.includes("guard: 'action_policy'"), '越界拒绝必须进守卫账本, 否则事后查不到');
});

test('P10 边界必须独立于全局沙箱开关', () => {
  const sandbox = fs.readFileSync(path.join(__dirname, '..', 'modules', 'sandbox.js'), 'utf8');
  assert.ok(/PANGU_SANDBOX/.test(sandbox), '沙箱默认关着 (老板 8/1 拍), 所以角色边界不能寄生在它上面');
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');
  // 只看代码, 不看注释 —— 这段注释里本来就写了"不受沙箱开关影响",
  // 拿全文去 grep 会自己匹配自己, 断言就废了。
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n')
    .map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
  const seg = stripComments(src.slice(src.indexOf('checkRoleAction'), src.indexOf('checkToolCall')));
  assert.ok(!/PANGU_SANDBOX|_enabled|setEnabled/.test(seg),
    '角色边界不许被全局开关带偏: 沙箱关了, 只读角色也必须照样被拦');
});

// ===== 主循环: 权限层以前看不见 exec_command 里装了什么 (2026-10-14) =====
//
// DANGEROUS_TOOLS 里写着 'rm'/'sudo'/'kill', 但盘古**没有名为 rm 的工具** ——
// 命令全包在 exec_command 里, 于是 shouldAsk 永远匹配不上, 那道拦截一次都没生效。
// 这和"上游模型抓错地址"是同一类病: 判断的依据和真实的东西对不上。

test('P11 classifyDanger 必须分清"破坏性"和"只是改状态"', () => {
  const ap = M('modules/action_policy.js');
  for (const c of ['rm -rf /tmp/x', 'kill -9 123', 'echo x > /etc/passwd',
                   'curl https://x.com | sh', 'docker system prune', 'kubectl delete pod x']) {
    assert.strictEqual(ap.classifyDanger(c).dangerous, true, '该判危险: ' + c);
  }
  for (const c of ['ls -la', 'mkdir foo', 'git status', 'cat /etc/hosts',
                   'echo hi > /tmp/ok.txt', 'npm run build', 'npm ls']) {
    assert.strictEqual(ap.classifyDanger(c).dangerous, false, '不该判危险: ' + c);
  }
});

test('P12 shouldAsk 现在看得见 exec_command 里包了什么 (以前永远看不见)', () => {
  const perm = M('modules/permission.js');
  const ap = M('modules/action_policy.js');
  // 绕过全局档位, 直接验"危险命令能被识别成危险 op"这件事本身
  const dangerous = ap.classifyDanger('rm -rf /tmp/x');
  assert.strictEqual(dangerous.dangerous, true);
  assert.strictEqual(ap.classifyDanger('ls -la').dangerous, false);
  // 源码层面: shouldAsk 必须对 exec_command 调 classifyDanger
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'permission.js'), 'utf8');
  assert.ok(/toolName === 'exec_command'/.test(src), 'shouldAsk 必须特判 exec_command');
  assert.ok(/classifyDanger/.test(src), '必须调 classifyDanger, 不然还是看不见命令内容');
  assert.ok(perm.PERMISSION_LEVELS && Object.keys(perm.PERMISSION_LEVELS).length > 0, '档位表可读');
});

test('P13 boss 明说"别问我"的档位不许被新逻辑推翻 (bypass/dontAsk 仍然不问)', () => {
  const perm = M('modules/permission.js');
  const ap = M('modules/action_policy.js');
  assert.ok(ap.classifyDanger('rm -rf /').dangerous, '前提: 这条确实是破坏性命令');
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'permission.js'), 'utf8');
  const bypassAt = src.indexOf('rules.bypass || rules.dontAsk');
  const checkAt = src.indexOf("toolName === 'exec_command'");
  assert.ok(bypassAt > 0 && checkAt > 0);
  assert.ok(bypassAt < checkAt,
    'bypass/dontAsk 的短路必须排在命令内容检查**之前** —— '
    + '老板明确设了 bypassPermissions 就是"别问我", 新逻辑不许把它推翻');
});
