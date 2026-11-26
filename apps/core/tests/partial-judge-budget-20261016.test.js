// 2026-10-16 PARTIAL_JUDGE 自己吃掉 300s (现场 lt3: 5 步长任务 2190s 的 13.7%)
//
// 日志原文: [j2-native] PARTIAL_JUDGE_LLM_FAIL, fallback 词法: LLM_SOCKET_TIMEOUT_300s
//
// 它干的事: 把一段 task_done 总结对着剩余计划判一下"全做完了没", 吐个 JSON。
// 它花的账: 和真正干活的调用共用一条 300s 的墙 —— 本地 27B 光思考就能吃干这 300s,
// 然后回退词法。**净收益为零**: 300 秒换一个跟一开始直接用词法一样的结果。
//
// 它之所以敢这么烧, 是因为它本来就有词法兜底 (_lex) —— 那就给它自己的小预算。
// 不是砍掉模型判断: 正常几秒就回, 判得比词法准; 只是不再让它有能力把主人的时间
// 花在一个旁枝分类上。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const M = (p) => require(path.join(__dirname, '..', p));
const SRC = () => require('fs').readFileSync(
  path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');

test('E1 这个旁枝分类有自己的小预算, 不再共用 300s 的墙', () => {
  const src = SRC();
  assert.ok(/_JUDGE_BUDGET_MS = 25 \* 1000/.test(src), '必须给 PARTIAL_JUDGE 一个自己的预算');
  assert.ok(/Promise\.race\(\s*\[\s*_call,/.test(src), '预算得是真的在跑, 不是注释里写写');
});

test('E2 预算小到"就算它一直不回也不致命"', () => {
  const src = SRC();
  const m = src.match(/_JUDGE_BUDGET_MS = (\d+) \* 1000/);
  assert.ok(m, '找不到预算常量');
  const ms = Number(m[1]) * 1000;
  assert.ok(ms <= 30000, '旁枝分类预算 ' + ms + 'ms 太大 —— 实测这函数为它烧掉过 300s');
  assert.ok(ms >= 3000, '也不能短到正常调用都跑不完, 那就等于把模型判断关掉了');
});

test('E3 超时必须回词法兜底, 不许把整轮带崩', () => {
  const src = SRC();
  const fn = src.match(/async function _judgeSummaryCompletion[\s\S]*?\n}/);
  assert.ok(fn, '找不到 _judgeSummaryCompletion');
  const body = fn[0];
  assert.ok(/PARTIAL_JUDGE_BUDGET_/.test(body), '超时要认得出是自己超时');
  // 超时分支抛出去的错必须落进 catch, 而 catch 末尾是回词法兜底。
  //
  // 2026-10-23 (第 59 批): 兜底值从裸布尔 `_lex` 换成了**结构化的进度判局**
  //   (summary_completion.lexicalProgressShape) —— 因为判官现在给的是
  //   「六格 cells + 档位 + 判据」, 布尔只是它派生出来的一份。
  //   兜底**行为一个字没变**: 超时仍然回词法, 仍然不把整轮带崩。
  //   所以这条断言跟着改字面量, 断的还是同一件事: 兜底路径没断。
  const tail = body.slice(body.indexOf('PARTIAL_JUDGE_BUDGET_'));
  assert.ok(/return _fallback/.test(tail),
    '兜底路径断了 —— 超时会让整轮抛出去, 那比烧 300s 更糟');
});

test('E4 分类题要"直接答别分析", 本地模型的 thinking 在这题上纯烧墙', () => {
  const src = SRC();
  assert.ok(/这是分类题, 直接给 JSON, 不要分析/.test(src),
    '提示词层预算对本地模型是唯一真能收的杠杆 (reasoning_effort 字段在本地是空转的)');
});

test('E5 摘掉的调用不许把 unhandled rejection 漏出去', () => {
  const src = SRC();
  assert.ok(/_call\.catch\(\(\) => \{\}\)/.test(src),
    '输掉的那次调用没人接的话, 它后来失败会打成 unhandledRejection');
});
