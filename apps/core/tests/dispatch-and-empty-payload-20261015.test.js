'use strict';

/**
 * 2026-10-15 — 两个今天实测撞出来的真 bug
 *
 * B1: /api/pangu/dispatch 带 target_role 时直接 500 "_agentRegistry is not defined"。
 *     N5 refactor 把 handler 从 pangu-single.js 搬到 modules/pangu_decide.js 时,
 *     pangu-single.js 的模块级 `let _agentRegistry` 没跟着搬, 本文件从没声明过这个符号。
 *     不带 target_role 时能"看起来能用", 是因为 LLM 分类那处引用被内层 try/catch
 *     吞掉、静默降级成 keyword 打分 —— 于是这个端点从来没真正跑过 agent。
 *
 * B2: /message 字段名拼错 (传 message 而不是 messages/input) 时不报错,
 *     拿空对话去调 LLM, 白烧一轮往返, 换 LM Studio 一句 "No user query found in messages"。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const DECIDE = path.join(CORE, 'modules', 'pangu_decide.js');
const ROUTER = path.join(CORE, 'pangu-single', 'routes', 'inline_router.js');

const decideSrc = fs.readFileSync(DECIDE, 'utf8');
const routerSrc = fs.readFileSync(ROUTER, 'utf8');

test('B1 _agentRegistry 必须在本模块声明 (不是靠 pangu-single.js 那份)', () => {
  assert.match(
    decideSrc,
    /^let _agentRegistry = null;$/m,
    'pangu_decide.js 必须自己声明 _agentRegistry',
  );
  assert.match(decideSrc, /function agentRegistry\(\)/, '必须有懒加载入口');
});

test('B1 dispatch 的 5 处引用必须走 agentRegistry(), 不能裸用未声明符号', () => {
  // 先剥注释 —— 这个 bug 的说明注释里就反复提到 _agentRegistry,
  // 朴素正则会把注释里的字面量当成真引用, 报出假失败。
  const code = decideSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const fnStart = code.indexOf('function agentRegistry()');
  const fnEnd = code.indexOf('function init(deps)');
  // 括号是必须的: `.match()` 比 `+` 绑得紧, 少这对括号的话它只作用在右半段,
  // 于是 `outside` 变成 "字符串 + 匹配数组" 的拼接结果 —— 一个几百字符的字符串,
  // `.length` 报出来的数字看着像"还有几百处裸用", 纯属自欺。
  const outside = (code.slice(0, fnStart) + code.slice(fnEnd))
    .match(/(?<![\w.])_agentRegistry(?![\s]*=[^=])/g) || [];
  assert.equal(
    outside.length,
    0,
    `agentRegistry() 之外仍有裸用 _agentRegistry: ${outside.length} 处 —— 会 ReferenceError`,
  );
});

test('B1 getAgents() 必须真被调用, 否则懒加载只是空壳', () => {
  const fnBody = decideSrc.slice(
    decideSrc.indexOf('function agentRegistry()'),
    decideSrc.indexOf('function init(deps)'),
  );
  assert.match(fnBody, /getAgents\(\)/, '懒加载必须调 getAgents()');
  assert.match(fnBody, /catch/, '必须有 catch —— registry 挂了不能让 dispatch 整个 500');
});

test('B1 agentRegistry() 在 getAgents 抛错时退化成空对象而不是抛出', () => {
  // 行为钉住: registry 不可用时 dispatch 降级成"只分类不执行", 不 500
  const src = decideSrc;
  const fnStart = src.indexOf('function agentRegistry()');
  const fnEnd = src.indexOf('function init(deps)');
  const fn = src.slice(fnStart, fnEnd);
  assert.match(fn, /_agentRegistry = \{\}/, '失败分支必须置空对象, 不能留 null 被下游 [x] 命中');
});

test('B2 空 user 消息必须就地 400, 不许拿空对话去调 LLM', () => {
  assert.match(
    routerSrc,
    /error:\s*'USER_MESSAGE_REQUIRED'/,
    'payload 没有 user 消息时必须返回可读的 400',
  );
  // 400 判定必须排在真正构造 messages / 调 LLM 之前
  const guard = routerSrc.indexOf('USER_MESSAGE_REQUIRED');
  const pushUser = routerSrc.indexOf("messages.push({ role: 'user', content: userInput })");
  assert.ok(guard > 0 && pushUser > 0, '两端都要存在');
  assert.ok(guard < pushUser, 'guard 必须排在 messages.push 之前, 否则空对话已经发出去了');
});

test('B2 hint 里承诺的字段必须真的被读 (不许 hint 骗人)', () => {
  // hint 写了 message/input/messages 三者任一, 代码必须三个都认
  assert.match(routerSrc, /req_body\.input/, '必须读 input');
  assert.match(routerSrc, /req_body\.message/, '必须读 message (单数别名)');
  assert.match(routerSrc, /req_body\.messages \|\| \[\]/, '必须读 messages');
});

test('B2 guard 不能误伤正常的 messages-only 请求', () => {
  // 纯 messages 带 user → userInput 应由 _lastUserMsg 兜住, 不触发 400
  assert.match(
    routerSrc,
    /_lastUserMsg \? _lastUserMsg\.content : ''/,
    'messages-only 请求必须靠 _lastUserMsg 取到 userInput',
  );
  assert.match(
    routerSrc,
    /!userInput \|\| !String\(userInput\)\.trim\(\)/,
    "guard 判的是空/纯空白, 不是 userInput 不存在 (否则单字符消息也会被误杀)",
  );
});

