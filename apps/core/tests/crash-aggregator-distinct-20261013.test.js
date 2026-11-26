'use strict';
// 2026-10-13 现场: 今天为了定位一个 "model is not defined" 的 ReferenceError 卡了半天,
// 因为 safe-guard 生成的 issue 里**只有第一条** Sample message:
//
//   issues/2026-10-12T16-12-29-019Z-ReferenceError.md
//     - **Count**: 65
//     ## Sample message
//     ReferenceError: Cannot access 'path' before initialization ...
//
// 同一份 crash log 里其实有 **5 种**不同的 ReferenceError 消息(含 model / json /
// pathname / Users), issue 文件里一条都看不到 —— 聚合器只在**首次**出现时写
// sample_message, 之后再遇到同 type 的新消息直接丢弃。
//
// 改完再用真实 crash log 验一次, 立刻浮出一批以前完全不可见的 bug:
//   ReferenceError: Users is not defined        ×24  global_agent_rules.js
//   ReferenceError: json is not defined         ×5   inline_router.js:704
//   ReferenceError: pathname is not defined     ×7   inline_router.js:1555
//   ReferenceError: model is not defined        ×1   message-stream.js:228
//   ReferenceError: model is not defined        ×3   llm_caller.js:1211
// (逐个查过当前代码: 这几处现在都已修好 —— 也就是说这族 bug 早修了, 只是证据被藏了)
//
// 教训: **诊断设施自己丢证据, 等于让 bug 变得无法定位**。
// 排查工具的保真度, 和被排查对象一样重要。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const g = require('../pangu-single/safe-guard/global');

function writeLog(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-crash-'));
  const f = path.join(dir, 'crash.log');
  fs.writeFileSync(f, lines.map(l => `[${l.ts}] [uncaughtException] ${l.msg}`).join('\n'), 'utf8');
  return f;
}

const T = (ts, msg) => ({ ts, msg });

test('同一 type 下的多种不同消息必须全部保留 (今天就栽在这)', () => {
  const f = writeLog([
    T('2026-10-12T16:12:29.011Z', "ReferenceError: Cannot access 'path' before initialization\n    at Object.<anonymous> (/x/a.js:1:1)"),
    T('2026-10-12T16:12:50.436Z', 'ReferenceError: model is not defined\n    at ClientRequest.<anonymous> (/x/llm_caller.js:1211:111)'),
    T('2026-10-12T16:13:00.000Z', 'ReferenceError: Users is not defined\n    at Object.<anonymous> (/x/global_agent_rules.js:135:9)'),
  ]);
  const [p] = g.detectCrashPattern(f, 1);
  assert.equal(p.type, 'ReferenceError');
  assert.equal(p.count, 3);
  const msgs = p.distinct.map(d => d.sample_message.split('\n')[0]);
  assert.equal(msgs.length, 3, '三种不同消息都得在: ' + JSON.stringify(msgs));
  assert.ok(msgs.some(m => m.includes("'path'")), msgs.join(' | '));
  assert.ok(msgs.some(m => m.includes('model is not defined')), msgs.join(' | '));
  assert.ok(msgs.some(m => m.includes('Users is not defined')), msgs.join(' | '));
});

test('同一模板的多个实例(数字/id 不同)归为一条并各自累计', () => {
  const f = writeLog([
    T('2026-10-12T16:12:29.011Z', 'ReferenceError: model is not defined\n    at ClientRequest.<anonymous> (/x/llm.js:1:1)'),
    T('2026-10-12T16:12:30.011Z', 'ReferenceError: model is not defined\n    at ClientRequest.<anonymous> (/x/llm.js:1:1)'),
    T('2026-10-12T16:12:31.011Z', 'ReferenceError: request 12345 failed\n    at foo'),
    T('2026-10-12T16:12:32.011Z', 'ReferenceError: request 67890 failed\n    at foo'),
  ]);
  const [p] = g.detectCrashPattern(f, 1);
  assert.equal(p.count, 4);
  assert.equal(p.distinct.length, 2, '两个模板 = 两条, 不是四条: ' + p.distinct.length);
  assert.deepEqual(p.distinct.map(d => d.count).sort(), [2, 2]);
});

test('first_seen 与 last_seen 都要对', () => {
  const f = writeLog([
    T('2026-08-16T08:00:00.000Z', 'ReferenceError: json is not defined\n    at a'),
    T('2026-10-12T16:12:00.000Z', 'ReferenceError: json is not defined\n    at a'),
  ]);
  const [p] = g.detectCrashPattern(f, 1);
  assert.equal(p.first_seen, '2026-08-16T08:00:00.000Z');
  assert.equal(p.last_seen, '2026-10-12T16:12:00.000Z');
});

test('装满上限后淘汰 last_seen 最旧的 —— 最新出现的 bug 绝不能被挤掉', () => {
  // 这条正是今天踩到的: model is not defined 是**最新**的,
  // 若按"先到先留"会被 8 月的旧货挤没 —— 而看 issue 的人正是来查新 bug 的。
  //
  // 下面的数据特意让 **index 0 不是最旧的**: alpha 早服场但后来又复现过一次,
  // 所以它的 last_seen 被刷新到最后。这样 "淘汰最旧" 与 "无脚拔序淘汰" 才能被区分开。
  const rows = [
    T('2026-08-01T00:00:00.000Z', 'ReferenceError: alpha is not defined\n    at a'),
    T('2026-08-02T00:00:00.000Z', 'ReferenceError: bravo is not defined\n    at b'),
    T('2026-08-03T00:00:00.000Z', 'ReferenceError: charlie is not defined\n    at c'),
    T('2026-08-09T00:00:00.000Z', 'ReferenceError: alpha is not defined\n    at a'),   // 重现 → alpha.last_seen 刷新
    T('2026-08-04T00:00:00.000Z', 'ReferenceError: delta is not defined\n    at d'),
    T('2026-08-05T00:00:00.000Z', 'ReferenceError: echo is not defined\n    at e'),
    T('2026-10-12T16:12:50.000Z', 'ReferenceError: brand_new_bug is not defined\n    at ClientRequest.<anonymous> (/x/llm.js:1211:1)'),
  ];
  const [p] = g.detectCrashPattern(writeLog(rows), 1);
  const joined = p.distinct.map(d => d.sample_message).join(' | ');
  assert.equal(p.distinct.length, 5, '上限就是 5: ' + p.distinct.length);
  assert.ok(joined.includes('brand_new_bug'),
    '最新出现的 bug 必须留在列表里: ' + joined);
  assert.ok(!joined.includes('bravo'),
    '被淘汰的应诩 last_seen 最旧的 bravo(08-02), 而不是 index 0 的 alpha: ' + joined);
  assert.ok(p.distinct_overflow >= 1, '被淘汰的条数要记下来, 让人知道还有别的');
});

test('issue 文件必须把各条 distinct 消息都写进去', () => {
  const f = writeLog([
    T('2026-10-12T16:12:29.011Z', "ReferenceError: Cannot access 'path' before initialization\n    at a"),
    T('2026-10-12T16:12:50.436Z', 'ReferenceError: model is not defined\n    at ClientRequest.<anonymous> (/x/llm.js:1211:1)'),
  ]);
  const [info] = g.detectCrashPattern(f, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-issues-'));
  const r = g.openIssue(info, dir);
  assert.ok(r.ok, JSON.stringify(r));
  const md = fs.readFileSync(r.path, 'utf8');
  assert.ok(md.includes('Distinct messages'), 'issue 里要有 distinct 段落');
  assert.ok(md.includes("Cannot access 'path'"), md);
  assert.ok(md.includes('model is not defined'),
    '这条就是今天定位不到的那个 —— 必须出现在 issue 里: ' + md);
  assert.ok(/×\d+/.test(md), '每条要带次数');
});

test('sample_message 向后兼容 = 第一条 (别把老消费方弄坏)', () => {
  const f = writeLog([
    T('2026-10-12T16:12:29.011Z', 'ReferenceError: first_one is not defined\n    at a'),
    T('2026-10-12T16:12:30.011Z', 'ReferenceError: second_one is not defined\n    at a'),
  ]);
  const [p] = g.detectCrashPattern(f, 1);
  assert.ok(p.sample_message.includes('first_one'), p.sample_message);
});

test('真实 crash log 上跑一遍: ReferenceError 必须浮出多条 distinct', () => {
  // 用真日志当回归夹具 —— 今天就是这么发现的那批被藏起来的 bug
  const pats = g.detectCrashPattern(g.CRASH_LOG_PATH, 3);
  const ref = pats.find(p => p.type === 'ReferenceError');
  assert.ok(ref, '真实 crash log 里应有 ReferenceError');
  assert.ok(ref.distinct.length > 1,
    '真实日志里 ReferenceError 明明有多条不同消息, 只报一条就等于把证据藏了: '
    + JSON.stringify(ref.distinct.map(d => d.sample_message.slice(0, 40))));
});
