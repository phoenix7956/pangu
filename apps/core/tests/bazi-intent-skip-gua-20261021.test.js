// bazi-intent-skip-gua-20261021.test.js
// 锁 modules/bazi_intent.js: 生辰八字问题不该起卦 (见 decision.md §P1-4)
//
// 事故背景: pangu_agent_stream.js 对每条非闲聊输入都先起卦, 卦象块占住推理入口,
// 模型顺着卦走不去调 bazi_calc —— 而 bazi_calc 在 MAIN 集里够得着。
// 本测试同时锁正例(该跳过)和反例(不该跳过), 反例同等重要:
// 只看日期就拦会把「查 2015年3月15日的会议记录」也拦掉。

const assert = require('assert');
const path = require('path');

const M = (p) => require(path.join(__dirname, '..', p));
const { detectBaziIntent, shouldSkipGuaCast } = M('modules/bazi_intent.js');

// ------------------------------------------------------------
// 正例: 必须跳过起卦
// ------------------------------------------------------------
const SHOULD_SKIP = [
  '我是1984年3月15日出生的，男',
  '帮我排八字 1990年3月15日 15时30分',
  '1984年3月15日 10:30 男',
  '看一下这个人的命盘，1990年3月15日生',
  '1990年3月15日出生，男，想看流年',
  '农历一九八四年三月十五日',
  '一九八四年三月十五日生的，男',
  '1990年3月15日 卯时',
  '排一下八字',
  '算八字',
  '看八字',
  '八字排盘',
];

// ------------------------------------------------------------
// 反例: 必须照常起卦 (拦了就错)
// ------------------------------------------------------------
const SHOULD_CAST = [
  '帮我看下2015年3月15日的会议记录',
  '2015年3月15日的天气怎么样',
  '把2024年1月1日的文件都归档',
  '这个名字该起卦还是该查资料',
  '重构这个模块，该不该做',
  '这个股票该不该买',
  '',
  null,
  undefined,
  '我要做个计划',
];

// ------------------------------------------------------------
// 第三组: **识别出生辰意图, 但主人明说要卦** → 不跳过起卦
//   2026-10-23 第 58 批: 老板报的真 bug —— 给生辰 + 明说要卦时被跳过了,
//   而规则 #19(a) 写的是「主人明确说算一卦 → 必调」。
//   主人给生辰正是想让卦落到干支上 ⇒ 这类**不许**跳过起卦。
//   注意这里 matched 仍是 true(它**确实是**生辰意图) —— 第 58 批把
//   「识别出生辰意图」与「跳过起卦」这两件事**拆开**了, 别再混成一条。
// ------------------------------------------------------------
const SHOULD_CAST_WITH_BAZI = [
  '1990年3月15日生，男，算一卦看今年财运',
  '1990年3月15日 卯时，起个卦看看',
  '1990年3月15日生，男，起个卦看今年财运',
];

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✅ ' + name);
  } else {
    fail++;
    console.log('  ❌ ' + name + (extra ? '  →  ' + extra : ''));
  }
}

console.log('=== 生辰意图识别 ===\n');

console.log('--- 正例: 该跳过起卦 ---');
for (const s of SHOULD_SKIP) {
  const r = detectBaziIntent(s);
  check(
    '跳过: ' + JSON.stringify(s),
    r.matched === true && shouldSkipGuaCast(s) === true,
    'matched=' + r.matched + ' reason=' + r.reason
  );
}

console.log('\n--- 反例: 不该跳过 ---');
for (const s of SHOULD_CAST) {
  const r = detectBaziIntent(s);
  check(
    '照常起卦: ' + JSON.stringify(s),
    r.matched === false && shouldSkipGuaCast(s) === false,
    'matched=' + r.matched + ' reason=' + r.reason
  );
}

console.log('\n--- 生辰意图 + 明说要卦: 不跳过起卦 ---');
for (const s of SHOULD_CAST_WITH_BAZI) {
  const r = detectBaziIntent(s);
  check(
    '不跳过: ' + JSON.stringify(s),
    r.matched === true && shouldSkipGuaCast(s) === false,
    'matched=' + r.matched + ' skip=' + shouldSkipGuaCast(s) + ' reason=' + r.reason
  );
}

// ------------------------------------------------------------
// 结构断言: 命中时必须带可追溯的 signals, 便于排查
// ------------------------------------------------------------
console.log('\n--- 可追溯性 ---');
const r1 = detectBaziIntent('我是1984年3月15日出生的，男');
check('命中带 signals 数组', Array.isArray(r1.signals) && r1.signals.length > 0);
check('命中带 reason 说明', typeof r1.reason === 'string' && r1.reason.length > 0);
// 注: 这句含「出生」二字, 走的是 keyword 分支 (high), 不是 gender 分支。
// 日期+性别**只有**日期和性别时才是 medium, 见下面 r1b。
check('日期+出生 → confidence=high', r1.confidence === 'high', '实际=' + r1.confidence);

const r1b = detectBaziIntent('1984年3月15日，男');
check('只有日期+性别 → confidence=medium', r1b.confidence === 'medium', '实际=' + r1b.confidence);
check('medium 也 matched=true', r1b.matched === true, '实际=' + r1b.matched);

const r2 = detectBaziIntent('排一下八字');
check('显式排八字 → confidence=high', r2.confidence === 'high');

const r3 = detectBaziIntent('查一下会议记录');
check('无关输入 signals 为空', r3.signals.length === 0);

// ------------------------------------------------------------
// 单个日期不成生辰 (只有年 或 只有年月)
// ------------------------------------------------------------
console.log('\n--- 不完整日期不算生辰 ---');
for (const s of ['1990年的数据', '3月15日开过会', '2015年']) {
  const r = detectBaziIntent(s);
  check('不拦: ' + JSON.stringify(s), r.matched === false, 'reason=' + r.reason);
}

console.log('\n============================================================');
console.log('测试结果：' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败'));
console.log('============================================================');

if (fail > 0) {
  console.error('\n❌ ' + fail + ' 项失败');
  process.exit(1);
}

