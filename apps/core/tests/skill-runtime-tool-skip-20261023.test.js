'use strict';
// 工具层清理 (2026-10-23 第 62 批)
//
// 两件事, 都是量出来的:
//
// ① `modules/agent_loop.js`(213 行)**全仓无消费者** ——
//    生产没有 require 它, 测试没有 require 它, 没有动态 require, 也没有任何配置引用。
//    它长得像「工具层的注册表」(也有 registerTool), 于是量的时候先被当成了
//    「两套注册表冲突」。查下去才发现: **两套的调用契约根本不同**
//    (agent_loop 是 toolFn(params, hooks) 两个参数, skill_runtime 是
//    toolFn({context, params, skill, guaId}) 一个参数) —— 所以不是重复实现,
//    其中一套干脆是死的。
//    删之前上了三重保险: grep 全仓 / 临时插探针抛错跑整链+启动+真任务(0 命中)。
//
// ② `skill_runtime` 里「工具没注册就 SKIP」是**静悄悄**的 ——
//    生产建实例时只传了 skillsDir 没传 tools ⇒ this.tools 恒为 {}。
//    实测磁盘上 5 个技能没有一个声明 toolName, 所以这条路径**目前没被触发**
//    (是潜在缺口, 不是活 bug)。但只要有人写第一个带工具的技能就会踩进来,
//    而主人只看到「结果少了一段」。这跟 2026-10-22 那个半死进程同一类病: 降级不留痕。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const SR = require(path.join(CORE, 'modules', 'skill_runtime.js'));

// (1) 死代码不许悄悄回来

test('D1 agent_loop.js 已删除 (它长得像工具层, 实际全仓无消费者)', () => {
  assert.equal(fs.existsSync(path.join(CORE, 'modules', 'agent_loop.js')), false,
    'agent_loop.js 又回来了 —— 要么它真的复活了消费者, 要么当初的删除判断错了。'
    + '复活的话必须同时说清「谁在 require 它」, 不许只把文件放回去。');
});

test('D2 删除没误伤: 真源仍能加载, 工具层的真实现还在', () => {
  // 工具注册表的真实现是 skill_runtime + 各 tool 模块, 不是 agent_loop。
  assert.equal(typeof SR.createSkillRuntime, 'function', 'skill_runtime 必须是活的');
  const rt = SR.createSkillRuntime({ skillsDir: '/__no_such_dir__' });
  assert.ok(rt && typeof rt.registerTool === 'function', 'registerTool 是真实现的入口');
  // 调用契约: skill_runtime 是**一个**参数 —— 与被删的 agent_loop(两个参数)不同。
  // 这条钉住「它们本来就不是同一份东西」, 免得下一个人又把两套合并。
  const src = fs.readFileSync(path.join(CORE, 'modules', 'skill_runtime.js'), 'utf8');
  assert.match(src, /toolFn\(\{ context: toolContext, params: mergedParams, skill, guaId: toolDef\.guaId \}\)/,
    'skill_runtime 的调用契约变了 —— 一个参数 {context, params, skill, guaId}');
});

// (2) 静默 SKIP 必须留痕

test('S1 工具没注册时, 必须 warn 留痕 (不许静悄悄 SKIP)', () => {
  const rt = SR.createSkillRuntime({ skillsDir: '/__no_such_dir__' });
  // 造一个「声明了工具」的技能 —— 这正是生产里目前不存在的形态。
  rt._skills.set('t', {
    name: 't', loaded: true, guaId: 1,
    tools: [{ toolName: 'never_registered_tool', guaId: 1, params: [] }],
    flows: { main: [1] }, jueCi: '',
  });
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  return rt.executeSkill('t', { input: 'x', params: {} }).then((r) => {
    console.warn = orig;
    const skipped = (r.results || []).find((x) => x.status === 'SKIP');
    assert.ok(skipped, '前置: 这个技能应该真的走到 SKIP 分支');
    assert.equal(skipped.reason, 'tool not registered');
    assert.ok(warns.length >= 1, 'SKIP 一次都没有留痕 —— 主人只会看到「结果少了一段」, 查不到哪一步掉的');
    const line = warns.join('\n');
    assert.match(line, /never_registered_tool/, '留痕里要写清是哪个工具');
    assert.match(line, /skill=t/, '留痕里要写清是哪个技能');
    assert.match(line, /注册表条目数=0/, '留痕里要写清注册表是空的 —— 根因在 pangu-single 建实例时没传 tools');
  }, (e) => { console.warn = orig; throw e; });
});

test('S2 工具注册了就不该 warn (留痕不能变成噪声)', () => {
  const rt = SR.createSkillRuntime({ skillsDir: '/__no_such_dir__' });
  rt.registerTool('ok_tool', async () => ({ done: true }));
  rt._skills.set('t2', {
    name: 't2', loaded: true, guaId: 1,
    tools: [{ toolName: 'ok_tool', guaId: 1, params: [] }],
    flows: { main: [1] }, jueCi: '',
  });
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  return rt.executeSkill('t2', { input: 'x', params: {} }).then((r) => {
    console.warn = orig;
    assert.equal(warns.length, 0, '工具注册了还 warn —— 留痕变成了噪声, 真出事时就没人看日志了');
    const ok = (r.results || []).find((x) => x.status === 'OK');
    assert.ok(ok, '工具注册了就该真跑起来');
  }, (e) => { console.warn = orig; throw e; });
});

// 负例: 拆掉修复, 断言必须变红

test('负例: 把 warn 拿掉, S1 必须报出来', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'skill_runtime.js'), 'utf8');
  assert.match(src, /console\.warn\('\[skill_runtime\] 工具未注册/,
    '静默 SKIP 回来了 —— 降级不留痕, 跟 2026-10-22 那个半死进程是同一类病');
});
