'use strict';

// 2026-10-17: 「跟死了一样」的**真机制** —— 角色策略把子 agent 拦在门外,
// 而三道闸门全都按「工具名|参数」分桶, 模型换参数重试就一路畅通。
//
// 现场 (session q-1792192247770#sub-0-analyzer, 老板那道「查清楚模型池」长任务):
//   sub-0-analyzer 跑了 **21 轮 / 80 秒**, checkpoints 一直排到 _r21。
//   任务本身只是「读配置文件取证」, 模型用 grep/sed 找模型池是最自然的做法,
//   但 analyzer 是只读角色 → 被拒 → 它换个命令再试 → 又被拒 → …→
//   **第 14 轮才改用 read_file**。中间它甚至花了好几轮
//   `grep -rn "analyzer"` —— 拿预算调查自己为什么被拦。
//   回灌给模型的原文 (checkpoint r21 消息 [37]):
//     {"ok":false,"blocked":true,"_role_denied":true,"data":{},
//      "error":"ROLE_READ_ONLY: analyzer 是只读角色, 命令会改状态: 内联解释器代码 = 任意写权限"}
//   整份文案只说"你不能做", 从不说"你可以用这个做同样的事" —— 模型只能靠试。
//
// 为什么既有三道闸门一道都没拦住:
//   - self_correct: 2026-10-15 那刀把 blocked 排除在外了 (对的: 本地守门不该罚模型两次)
//   - DUPLICATE_TOOL_CALL: 按 工具名|参数 分桶, 参数每次都换 → 桶永远不同
//   - _CROSS_ROUND_FAIL_LIMIT: 同上, 按 (tool,args) 累加 → 同上
// 三道全都以「工具+参数」为键, 而这一刀的症状恰恰是**换参数重试**。
//
// 修法 (_makeRoleDenyGuard): 按**工具名**记账 (参数这一维正是漏掉的那一维),
// 第一次拦就点名替代方案, 第二次明确叫停。不新造第四套刹车 —— 被拒调用照旧
// blocked:true, 只是把「该怎么换路」讲清楚。
//
// W1/W2 是**动态**的: 真跑这个纯逻辑工厂。
// W3 是**最后一跳**: 用真的 _fitToolResult 把拒用结果序列化一遍, 断言换路提示
//   真进了模型 —— 今天栽过"字段写了但没被用掉" (data 到了、前端存了、面板有代码,
//   断点在第四处的一个条件上), 所以必须验到消息文本本身, 不能只验字段存在。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LOOP_SRC = fs.readFileSync(path.join(ROOT, 'modules', 'j2_agent_loop.js'), 'utf8');
const { _makeRoleDenyGuard } = require(path.join(ROOT, 'modules', 'j2_agent_loop.js'));

test('W1 换参数重试照样计数 —— 这正是三道按参数分桶的闸门漏掉的那一维', () => {
  const g = _makeRoleDenyGuard();
  // 参数每次都换 (现场实况: grep 换了又换), 计数必须照涨
  const a = g.note('analyzer', 'exec_command');
  const b = g.note('analyzer', 'exec_command');
  assert.strictEqual(a.count, 1);
  assert.strictEqual(b.count, 2, '参数换了不该把计数清零 —— 现场就是这么空转 21 轮的');
  assert.strictEqual(g.countOf('exec_command'), 2);

  // 另一个工具单独记账: 不许互相污染
  const c = g.note('analyzer', 'code_execute');
  assert.strictEqual(c.count, 1, '不同工具必须是各自的账');
  assert.strictEqual(g.countOf('exec_command'), 2, '别的工具被拒不许改写 exec_command 的计数');
});

test('W2 第一次就点名替代方案, 第二次明确叫停 —— 只说"不行"等于让模型自己试', () => {
  const g = _makeRoleDenyGuard();
  const first = g.note('analyzer', 'exec_command');
  assert.match(first.message, /read_file/,
    'W2: 第一次拦必须告诉模型"你可以用这个做同样的事" —— 现场文案只有 ROLE_READ_ONLY, 模型只能靠试');
  assert.match(first.message, /file_grep|search_files/,
    'W2: 替代方案要覆盖"搜代码"这个真实诉求, 不只 read_file');
  assert.doesNotMatch(first.message, /不要再调它/,
    'W2: 第一次还不该叫停, 给模型一次换路的机会');
  assert.strictEqual(first.exhausted, false);

  const second = g.note('analyzer', 'exec_command');
  assert.match(second.message, /不要再调它|不要再调/,
    'W2: 第二次必须明确叫停 —— 否则就是现场那个 21 轮空转');
  assert.match(second.message, /task_done/,
    'W2: 叫停时要给出口 (task_done 认输), 不能只堵死');
  assert.strictEqual(second.exhausted, true);
});

test('W3 换路提示真进了模型消息 —— 验到最后一跳, 不只验字段存在', () => {
  // 真的把拒用结果过一遍回灌序列化 (和线上一模一样的函数), 断言模型**看得见**换路提示。
  // 只断言 result.message 存在是不够的: 今天栽过"字段写了没被用掉"。
  const fitIdx = LOOP_SRC.indexOf('function _fitToolResult(');
  assert.ok(fitIdx > 0, '要能找到 _fitToolResult (回灌序列化)');
  const bodyStart = LOOP_SRC.indexOf('{', fitIdx);
  let d = 0, end = -1;
  for (let i = bodyStart; i < LOOP_SRC.length; i++) {
    if (LOOP_SRC[i] === '{') d++;
    else if (LOOP_SRC[i] === '}') { d--; if (d === 0) { end = i + 1; break; } }
  }
  const TOOL_RESULT_MAX_CHARS = 24000;
  // eslint-disable-next-line no-new-func
  const _fitToolResult = new Function('TOOL_RESULT_MAX_CHARS',
    LOOP_SRC.slice(fitIdx, end) + '; return _fitToolResult;')(TOOL_RESULT_MAX_CHARS);

  const g = _makeRoleDenyGuard();
  const deny = g.note('analyzer', 'exec_command');
  const execResult = {
    ok: false, blocked: true, _role_denied: true, data: {},
    error: 'ROLE_READ_ONLY: analyzer 是只读角色, 命令会改状态: 内联解释器代码 = 任意写权限',
    message: deny.message,
    _role_denied_count: deny.count,
  };
  const content = _fitToolResult(execResult);
  assert.ok(content.includes('read_file'),
    'W3: 换路提示必须真的出现在回灌给模型的文本里 —— 现场 21 轮空转就是它没进去');
  assert.ok(content.includes('不要再换命令重试'),
    'W3: "别再重试"这句话也必须到模型眼前');
  assert.ok(content.includes('ROLE_READ_ONLY'),
    'W3: 拒绝原因本身也要保留 (模型需要知道是被策略拒, 不是工具坏了)');
});

test('W4 接线不许断 —— 角色拦截路径必须调用这个守卫并回灌它的文案', () => {
  // 动态部分证明逻辑对, 这里钉住**接线**: 工厂建了、计数调了不算数,
  // 文案得真的 return 出去让 _fitToolResult 拿到。
  assert.match(LOOP_SRC, /const _roleDeny = _makeRoleDenyGuard\(\);/,
    'W4: 循环里必须有一个按 session 建的守卫实例');
  assert.match(LOOP_SRC, /_roleDeny\.note\(_roleForThisLoop, tc\.name\)/,
    'W4: 角色拦截必须走这个守卫计数');
  assert.match(LOOP_SRC, /message: _deny\.message/,
    'W4: 换路文案必须挂在返回结果上 —— 不 return 就等于没写 (今天栽过的坑)');
  // 计数按工具名, 不许偷偷把参数拼进 key
  const guardBody = LOOP_SRC.slice(
    LOOP_SRC.indexOf('function _makeRoleDenyGuard('),
    LOOP_SRC.indexOf('function _fitToolResult('));
  assert.doesNotMatch(guardBody, /params|args|stableStringify/,
    'W4: 守卫的键必须是**工具名**, 一旦掺进参数, 换参数重试就又逃出去了');
});

