// 2026-10-16 planner 抓 JSON 用贪婪正则 —— 长任务"拆了刀"的假象
//
// 现场 live-1792145181125: planner 42.7s 就报了 plan, 三刀 (analyzer「分析需求:」
// / executor「执行任务:」/ checker「验证结果」) 同一毫秒并发。看上去"拆刀 + 并行"都对,
// 实际那是 parsePlan 的**硬编码 fallback** —— planner 一次都没拆, 三刀各拿同一份任务全文。
// 而日志里一个字都没提走了 fallback, 所以这个假象在盘古自己的事件流里跟真拆解长得一模一样。
//
// 根因: `text.match(/\{[\s\S]*\}/)` 是贪婪匹配 (第一个 `{` 到最后一个 `}`)。
// 模型只要在 JSON 前后说了任何带花括号的话, 整块就变成 `"{...} 说明: 用 {} 表示占位"`,
// JSON.parse 抛异常 → **静默** fallback。实测 5 种真实输出形状里 3 种中招。
//
// 本文件护住两件事:
//   ① 那些形状现在必须真拆解 (括号配对扫描, 不受前后散文干扰)
//   ② 真的拆不出来时必须**出声** —— 静默 fallback 是这次查了半天的元凶
// 另外把同款贪婪正则的另外两处一起钉住 (partial judge / summary_completion):
// 那两处更阴 —— 抓到**另一段合法 JSON** 时不抛异常, 只是读出 undefined 然后**静默判错**。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');

const sa = require('../agents/sub-agent');
const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const ONE = '{"agent":"li","task":"读 a.js 并给 3 个要点"}';
const GOOD = '{"subTasks":[' + ONE + ']}';

test('T1 JSON 前后有带花括号的散文 —— 必须真拆解, 不能静默 fallback', () => {
  const shapes = {
    '尾部散文含花括号': GOOD + '\n说明: 用 {} 表示占位',
    '头部散文含花括号': '思路 {"k":1} 然后 ' + GOOD,
    '代码围栏': '```json\n' + GOOD + '\n```',
    '字符串字面量里带花括号': '{"subTasks":[{"agent":"li","task":"解析 {\\"x\\"} 这种写法"}]}',
    '真实 planner 输出形状 (前后有换行)': '\n\n' + GOOD + '\n',
  };
  for (const [name, text] of Object.entries(shapes)) {
    const r = sa.parsePlan(text, 'TASK');
    assert.ok(!r.data.fallback,
      `【${name}】应该真拆解, 却静默走了 fallback —— 这正是现场的病`);
    assert.strictEqual(r.subTasks.length, 1);
    assert.strictEqual(r.subTasks[0].agent, 'li');
  }
});

test('T2 真拆不出来时仍走 fallback —— 但必须打日志喊出来', () => {
  const bad = {
    '没有 JSON': '我需要先读文件才能回答这个问题',
    '空 subTasks': '{"subTasks":[]}',
    '被 max_tokens 截断': '{"subTasks":[{"agent":"li","task":"读取并分析 /Users/you/Desktop/pangu/apps/core/modules/j2_loop_sha',
  };
  for (const [name, text] of Object.entries(bad)) {
    const r = sa.parsePlan(text, 'TASK');
    assert.ok(r.data.fallback, `【${name}】确实该退`);
    assert.strictEqual(r.subTasks.length, 3, 'fallback 仍是 3 刀');
  }
  // 报警本身在**真实 stderr** 上验 —— node --test 会给测试文件注入自己的 console,
  // 在本进程里 stub console.warn 根本拦不到另一个模块的写, 等于没测 (踩过)。
  const script = "const sa=require(" + JSON.stringify(path.join(__dirname, '..', 'agents', 'sub-agent.js')) + ");"
    + "sa.parsePlan('我需要先读文件才能回答','TASK');";
  const r = require('node:child_process')
    .spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  const err = String(r.stderr || '');
  assert.ok(/\[planner\]/.test(err) && /退回/.test(err),
    'fallback 必须往 stderr 喊出来 —— 静默是这次查了半天的元凶, 实际 stderr: ' + err.slice(0, 200));
});

test('T3 partial judge 的形状也能扫出来 (它找 completed/remaining, 不是 subTasks)', () => {
  const hits = sa._extractJsonObjects(
    '判定: {"completed": true, "remaining": []}',
    (j) => typeof j.completed === 'boolean' || Array.isArray(j.remaining));
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].completed, true);
});

test('T4 前置一段别的合法 JSON —— 不能被它骗走 (这是原代码最阴的静默判错)', () => {
  const text = '我的中间结论 {"note":"先看了目录"} 最终判定 {"completed": true, "remaining": []}';
  const hits = sa._extractJsonObjects(
    text, (j) => typeof j.completed === 'boolean' || Array.isArray(j.remaining));
  assert.strictEqual(hits.length, 1, '只该认 completed/remaining 那段');
  assert.strictEqual(hits[0].completed, true,
    '原贪婪正则会抓到 note 那段 → completed 为 undefined → 恒判"部分完成"');
});

test('T5 三处抓 JSON 的地方都不许再用贪婪正则', () => {
  const greedy = /match\(\s*\/\{\[\\s\\S\]\*\/\}\s*\)/;
  for (const rel of ['agents/sub-agent.js', 'modules/j2_agent_loop.js', 'modules/summary_completion.js']) {
    assert.ok(!greedy.test(SRC(rel)),
      `${rel} 又出现了贪婪 /\\{[\\s\\S]*\\}/ —— 它会被任何带花括号的散文废掉`);
  }
});

