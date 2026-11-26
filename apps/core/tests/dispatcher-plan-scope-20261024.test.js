'use strict';
/**
 * tests/dispatcher-plan-scope-20261024.test.js
 *
 * 第 77 批补的**作用域**契约测试 —— 给「拆解轮的原话」这条链兜底。
 *
 * ## 为什么要单独一条 (实跑抓到的, 单测全绿也没抓到)
 *
 *   实跑 probe76b-decide (第二次):
 *     拆解轮判「指代不明」(日志: 拆解轮结论: B) —— 判据**是对的**;
 *     但这一轮 32 帧 sub_agent_progress、**一个 final 都没有**, 主人又白等一场。
 *   真因: `_planResult` 是 `_planViaMainAgent` 闭包里的 `let`,
 *     分类那一行(在闭包内)读它没事; **B 类分支(在闭包外)读它** ⇒
 *     **ReferenceError: _planResult is not defined** ⇒ 整个 dispatcher 抛出去。
 *
 * ## 为什么老判据没抓到
 *   老判据断言的是**源码文本**: 「B 类分支里写了 toUserFacingClarification(...)」。
 *   文本层面「引用了一个真实存在过的变量」完全合法 ⇒ **假绿**。
 *   缺的是**作用域**那一维: 这个变量在**这段代码**里到底存不存在。
 *
 * ## 这条测试怎么判
 *   用**真语法树**(tree-sitter, 走 tests/helpers/js_ast.js):
 *     ① `_planResult` 的每一次标识符引用, 都必须落在 `_planViaMainAgent` 的区间内;
 *     ② 跨闭包要用的原话, 必须走**外层声明**的 `_planFinalText`;
 *     ③ B 类分支读的是 `_planFinalText`, 不是 `_planResult`。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ast = require('./helpers/js_ast.js');

const DISPATCHER = path.join(__dirname, '..', 'modules', 'j2_dispatcher.js');
const tree = ast.parseJsFile(DISPATCHER);

test('前提: dispatcher 源码没有语法错', () => {
  assert.strictEqual(ast.hasSyntaxError(tree), false, '解析出语法错 —— 下面的判据会假绿');
});

test('① 闭包内的 _planResult 不许在闭包外被引用 (ReferenceError 的根因)', () => {
  const range = ast.functionRange(tree, '_planViaMainAgent');
  assert.ok(range, '找不到 _planViaMainAgent —— 判据锚点没了');

  const refs = ast.identifierRefs(tree, '_planResult');
  assert.ok(refs.length > 0, '_planResult 一个引用都没有 —— 判据锚点没了');

  const outside = refs.filter((r) => r.start < range.start || r.end > range.end);
  assert.deepStrictEqual(
    outside.map((r) => '第 ' + r.line + ' 行'),
    [],
    '这些 _planResult 引用落在 _planViaMainAgent 闭包**之外** ⇒ 运行时 ReferenceError'
  );
});

test('② 跨闭包传值走外层声明的 _planFinalText', () => {
  const range = ast.functionRange(tree, '_planViaMainAgent');
  assert.ok(range, '找不到 _planViaMainAgent —— 判据锚点没了');

  const refs = ast.identifierRefs(tree, '_planFinalText');
  assert.ok(refs.length >= 2, '_planFinalText 引用太少 —— 外层声明/赋值被删了?');

  // 外层声明 + 闭包内赋值 + B 类分支读取 ⇒ 至少有一次引用在闭包**之外**
  const outside = refs.filter((r) => r.start < range.start || r.end > range.end);
  assert.ok(
    outside.length >= 1,
    '_planFinalText 全在闭包内 —— 闭包外那个 B 类分支拿不到原话'
  );
});

test('③ B 类分支读的是 _planFinalText, 不是闭包里的 _planResult', () => {
  const src = fs.readFileSync(DISPATCHER, 'utf8');
  const bAt = src.indexOf("_planVerdict.kind === 'B'");
  const aAt = src.indexOf("_planVerdict.kind === 'A'");
  assert.ok(bAt > 0 && aAt > bAt, '找不到 B/A 两个分支 —— 判据锚点没了');

  const bBlock = src.slice(bAt, aAt);
  assert.ok(
    bBlock.includes('_planFinalText'),
    'B 类分支没读 _planFinalText —— 原话交不回主人'
  );
  assert.ok(
    !bBlock.includes('_planResult'),
    'B 类分支又去读闭包里的 _planResult 了 —— 运行时 ReferenceError'
  );
});

test('④ _planFinalText 的声明必须在闭包**外**(外层 let)', () => {
  const range = ast.functionRange(tree, '_planViaMainAgent');
  assert.ok(range, '找不到 _planViaMainAgent —— 判据锚点没了');

  const decls = ast.declarationsOf(tree, '_planFinalText');
  assert.ok(decls.length > 0, '_planFinalText 一个声明都没有 —— 判据锚点没了');

  const outside = decls.filter((d) => d.start < range.start || d.end > range.end);
  assert.ok(
    outside.length >= 1,
    '_planFinalText 只在闭包里声明 —— 闭包外读它就是 ReferenceError'
  );
});

test('⑤ _planFinalText 必须由 _planResult 的原话赋值(不是空串)', () => {
  const asg = ast.assignmentsTo(tree, '_planFinalText');
  assert.ok(asg.length > 0, '_planFinalText 一个赋值都没有 —— 判据锚点没了');

  const fromPlan = asg.filter((a) => a.right.includes('_planResult'));
  assert.ok(
    fromPlan.length >= 1,
    '_planFinalText 没从 _planResult 拿原话 —— B 类分支拿到的是空串, 主人收到的是兜底话术'
  );
});
