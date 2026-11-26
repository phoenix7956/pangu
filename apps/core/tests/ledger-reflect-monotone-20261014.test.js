// ledger-reflect-monotone-20261014.test.js
// 目标5 "其他问题": 守卫文件不许自我摧毁。
//
// ledger_reflect.js 是 ledger-lessons.test.js 的生成器 (AUTO-GENERATED, 勿手改)。
// 旧码把「运行时账本里当前出现过的 kind」当成要断言的集合 —— 于是账本一空,
// 已经写死的 7 条真实回归守卫 (FAKE_DELIVERY / FAKE_OUTPUT / PLAN_INCOMPLETE ...)
// 会被一起重建成 assert.ok(true): npm test 照样全绿, 直到旧死法真复活没人拦。
// 现场: HEAD 里 7 条守卫, 工作区被重建成 0 条恒绿。
//
// KIND_GUARDS 是签进源码的持久知识, 必须永远被断言; 账本只用来「发现新 kind」。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { renderTestFile, KIND_GUARDS } = require('../modules/ledger_reflect');

const CORE = path.join(__dirname, '..');

// 把渲染出来的守卫文件真的跑一遍 —— CORE 解析到 apps/core, 于是断言打在真源码上。
function execRendered(content) {
  const logs = [];
  const req = (m) => {
    if (m === 'assert' || m === 'fs' || m === 'path') return require(m);
    throw new Error('unexpected require: ' + m);
  };
  const body = new Function('require', '__dirname', 'console', content);
  body(req, __dirname, { log: (s) => logs.push(s) });
  return logs;
}

const REG = Object.keys(KIND_GUARDS);

test('S1 账本为空: 注册表里的守卫一条都不能少 (2026-10-14)', () => {
  const out = renderTestFile({});
  for (const k of REG) {
    const g = KIND_GUARDS[k];
    assert.ok(
      out.includes(JSON.stringify(g.token)),
      `空账本时 kind ${k} 的守卫 token ${g.token} 被抹掉了 —— 守卫集只增不减`,
    );
  }
  assert.doesNotMatch(out, /assert\.ok\(true\);/,
    '空账本不许退化成 assert.ok(true) 恒绿放行 —— 那就是把 7 条真守卫一次性缴械');
});

test('S2 空账本生成的守卫文件, 仍要在真源码上跑真断言 (2026-10-14)', () => {
  // 端到端: 不是数数, 是真执行。任何一条守卫 token 消失都会在这里炸。
  const logs = execRendered(renderTestFile({}));
  assert.equal(logs.length, 1, '守卫文件应当正常跑完并打印一次统计');
  assert.match(logs[0], /OK \((\d+) kinds\)/);
  assert.ok(Number(RegExp.$1) >= REG.length,
    `空账本也要断言至少 ${REG.length} 条守卫, 实际只断言 ${RegExp.$1} 条`);
});

test('S3 账本出现新 kind: 注册表守卫全保留, 新 kind 另出红断言 (2026-10-14)', () => {
  const out = renderTestFile({
    NOVEL_KIND_XYZ: { kind: 'NOVEL_KIND_XYZ', count: 4, sessions: 2, last_note: '新死法' },
  });
  // 并集, 不是替换
  for (const k of REG) {
    assert.ok(out.includes(JSON.stringify(KIND_GUARDS[k].token)),
      `新 kind 出现时把老守卫 ${k} 冲掉了 —— 应当是并集`);
  }
  assert.match(out, /assert\.ok\(false, '新教训 kind "NOVEL_KIND_XYZ" 无守卫/,
    '未知新 kind 必须出一条红断言逼人来登记守卫, 不能默默跳过');
});

test('S4 任意账本输入下守卫集都不缩水 (2026-10-14)', () => {
  const inputs = [
    {},
    { FAKE_OUTPUT: { kind: 'FAKE_OUTPUT', count: 1, sessions: 1, last_note: 'x' } },
    { UNKNOWN_A: { kind: 'UNKNOWN_A', count: 2, sessions: 1, last_note: '' },
      UNKNOWN_B: { kind: 'UNKNOWN_B', count: 3, sessions: 1, last_note: '' } },
  ];
  for (const inp of inputs) {
    const out = renderTestFile(inp);
    const missing = REG.filter((k) => !out.includes(JSON.stringify(KIND_GUARDS[k].token)));
    assert.equal(missing.length, 0, `输入 ${JSON.stringify(Object.keys(inp))} 下守卫丢失: ${missing.join(',')}`);
  }
});

test('S5 生成器不许退回"只渲染账本里出现过的 kind" (2026-10-14)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../modules/ledger_reflect'), 'utf8');
  assert.match(src, /Object\.keys\(KIND_GUARDS\)\.sort\(\)/,
    'renderTestFile 必须拿 KIND_GUARDS 注册表与账本取并集 —— 只渲染 byKind 就是那个自毁 bug');
  assert.doesNotMatch(src, /lines\.push\("assert\.ok\(true\);"\)/,
    '生成器不许再输出裸 assert.ok(true) 恒绿放行');
});
