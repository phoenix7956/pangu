const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { _verdictOfChecker } = require('../modules/j2_dispatcher.js');

// ===========================================================================
// 验收闭环的 checker 结论判据双向都错 (2026-10-13, 真实会话 ar2-0007/ar2-0009 取证)
//
// 旧 _CHECKER_FAIL_RE 对 checker 整段文本做子串扫描, 两个方向都错:
//
// 【漏判真FAIL — 更严重】`FAIL[ —:：]` 要求 FAIL 紧跟空格/破折号/冒号, 而 checker
//   实际输出几乎都用 markdown 强调, FAIL 后面跟的是 `*`:
//     "**最终验收结论：FAIL** …"  /  "**结论: FAIL**(复验第2轮)"  → 旧正则判 PASS ❌
//   实测 ar2-0007 的 4 个 checker 里 2 个是这个形态; sub-3 开篇写着"最终验收结论：FAIL"
//   却没被补救循环捕获 —— 等于把**验收失败的轮次当成通过放行**。
//
// 【误判PASS为FAIL — 白烧两轮】裸子串 `未通过` 命中"否定的否定":
//     "PASS: 5 个文件全部存在且内容互异, 无未通过项。"      → 旧正则判 FAIL ❌
//     "结论: PASS。所有核验项均通过, 不通过数为 0。"        → 旧正则判 FAIL ❌
//   本该一轮做完的活被判失败, 触发最多 2 轮补救重做 (ar2-0009 实测白烧 2 轮)。
//
// 修法: checker 输出**有明确结论**, 应该读结论而不是满篇扫失败词。
//   ① 带标签的结论 (结论/判定/验收/核验/复验/结果/verdict + FAIL/PASS/通过…);
//   ② 开头首个结论词 (剥掉 markdown 装饰后取最靠前的);
//   ③ 都没有 → 退回旧正则扫全文 (兜底, 既有能力不放宽)。
//   注意 FAIL 词必须排在 PASS 词前: `不通过` 内含 `通过`, 交替顺序错了会反向误判。
// ===========================================================================

// 真实 checker 文本开头 (取自 ar2-0007 账本 + 现场 SSE)
const REAL_FAIL_MD   = '**最终验收结论：FAIL** 证据（实测，非转述）： - `/tmp/pangu_ar2/summary.txt` **存在且可读** — 13 行、721 字节。目录内**只有这一个文件**。';
const REAL_FAIL_MD2  = '## 卦·方向 恒九三…故这轮只做只读核验。\n\n**结论: FAIL**(复验第 2 轮) 日期对不上。';
const REAL_FAIL_BOLD = '**FAIL — 验证不通过。** 卦·恒九三「不恒其德，或承之羞，贞吝」：贞位不守，羞吝随之。';
const REAL_PASS_NEG  = '**核验结论：PASS** 证据（实跑）：5 个文件全部存在且内容互异，无未通过项。';
const REAL_PASS_ZERO = '结论: PASS。所有核验项均通过，不通过数为 0。';

test('markdown 强调形态的真 FAIL 必须判 fail — 旧正则在这里漏判', () => {
  assert.equal(_verdictOfChecker(REAL_FAIL_MD), 'fail');
  assert.equal(_verdictOfChecker(REAL_FAIL_MD2), 'fail', '结论词前面有卦象铺垫也要能读到');
  assert.equal(_verdictOfChecker(REAL_FAIL_BOLD), 'fail');
});

test('否定式措辞的真 PASS 必须判 pass — 旧正则在这里误判', () => {
  assert.equal(_verdictOfChecker(REAL_PASS_NEG), 'pass', '"无未通过项" 不能被当成失败');
  assert.equal(_verdictOfChecker(REAL_PASS_ZERO), 'pass');
});

test('显式 PASS 结论不得被后文零散失败词推翻', () => {
  assert.equal(_verdictOfChecker('结论: PASS。\n逐项核验: f1-f5 均存在。\n未通过的项: 0 个。'), 'pass');
  assert.equal(_verdictOfChecker('核验通过。逐个 read_file 读回, 5 个文件全部非空, 无未通过的项。'), 'pass');
});

test('无结论标记时退回失败词扫描 (兜底, 既有能力不放宽)', () => {
  assert.equal(_verdictOfChecker('验收未通过, 缺 04/05'), 'fail');
  assert.equal(_verdictOfChecker('⚠️ [盘古 R80 空计划熔断] 模型连续输出计划模板, 我没有真动手。'), 'fail');
  assert.equal(_verdictOfChecker('已写盘 3 个文件并读回确认。'), 'pass');
});

test('空输入/非字符串不炸', () => {
  for (const v of ['', null, undefined, 0, {}]) {
    assert.ok(['pass', 'fail', 'unknown'].includes(_verdictOfChecker(v)), '应返回合法 verdict 而不抛异常');
  }
});

test('判据函数必须真的被补救闭环使用(不是导出就算数)', () => {
  const SRC = fs.readFileSync(require.resolve('../modules/j2_dispatcher.js'), 'utf8');
  const uses = (SRC.match(/_verdictOfChecker/g) || []).length;
  assert.ok(uses >= 2, `判据函数应被 _latestCheckerFail 调用, 实际只出现 ${uses} 次`);
  assert.match(SRC, /_latestCheckerFail[\s\S]{0,600}?_verdictOfChecker\(/,
    '_latestCheckerFail 必须改用新判据, 而不是旧的裸正则');
  assert.doesNotMatch(SRC, /_latestCheckerFail[\s\S]{0,600}?_CHECKER_FAIL_RE\.test/,
    '_latestCheckerFail 不得再直接用旧正则判定');
});

test('不得引入第二套独立的 checker 失败判定 (单一真源)', () => {
  const SRC = fs.readFileSync(require.resolve('../modules/j2_dispatcher.js'), 'utf8');
  const direct = (SRC.match(/_CHECKER_FAIL_RE\.test\(/g) || []).length;
  assert.ok(direct <= 1, `旧正则只应作为 _verdictOfChecker 的兜底用一次, 实际被直接调用 ${direct} 次`);
});
