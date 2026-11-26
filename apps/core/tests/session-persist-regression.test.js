// session-persist-regression.test.js — 桌面聊天主会话必须落盘
// 2026-10-09 P0 (老板报"会话 61554610 排查"): 会话 61554610 跑了 26 分钟子 agent,
// 刷新后整个对话消失。排查结论: 父会话从来没落盘过。
//
// 根因链:
//   1) 子 agent 各自跑 j2_agent_loop, 那条路有 _persistSession → #sub-* 账本都在
//   2) 桌面聊天的父会话走 j2_dispatcher._runPanguDispatcherLoop, 全文 0 次 sessionSave
//   3) j2_agent_loop 的两个落盘点都在循环体内, 纯文本收尾(无工具调用)时不经过
//   4) j2_agent_loop 的 finally 收口块只记日志, 没有兜底落盘
//   5) userAborted 从未声明, 两处引用都套在 catch(_){} 里被静默吞掉
//      (既有 §0.56 状态清理也因此一直没生效)
//
// 防回归: 下面 4 条静态守卫锁住修复后的结构。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULES = path.join(__dirname, '..', 'modules');
const read = (f) => fs.readFileSync(path.join(MODULES, f), 'utf8');
const { parseJs, tryFinalizers, hasSyntaxError, callSites, functionSource } = require('./helpers/js_ast');

const dispatcher = read('j2_dispatcher.js');
const loop = read('j2_agent_loop.js');

test('dispatcher 路径必须落盘父会话(本次事故的直接根因)', () => {
  assert.ok(
    /_persistParent\s*=/.test(dispatcher),
    'j2_dispatcher 必须定义 _persistParent — 桌面聊天父会话全靠它落盘',
  );
  // 2026-10-23(第 65 批): 这条判据的**量法**换了, 意图一个字没变 ——
  //   意图: 「dispatcher 的每条出口都要落盘父会话」。
  //   原来: 数 `_persistParent(` 的直接调用点 ≥4 —— 靠**各处记性**来保证。
  //         而 2026-10-16 现场证明「记性」会漏: 关键词兜底那两条路一处都没落盘,
  //         而 `_persistParent` 的注释还白纸黑字写着「已覆盖关键词兜底」。注释会撒谎。
  //   现在: 落盘收成**唯一出口** `_closeOut`, 「每个出口都落盘」这条断言
  //         搬到 tests/dispatcher-closeout-single-20261023.test.js(那里才是唯一出口契约的正主);
  //         本条只留一件事: **落盘这条路本身还通不通** ——
  //         即唯一出口接上的必须是 `_persistParent` 这个真实现, 不能是个 null。
  const dTree = parseJs(dispatcher);
  const closeOuts = callSites(dTree, 'makeCloseOut');
  assert.strictEqual(closeOuts.length, 1, `唯一出口的构造点必须恰好 1 个, 实际 ${closeOuts.length}`);
  const deps = closeOuts[0].args[0];
  assert.ok(
    deps && /persistParent\s*:\s*_persistParent\b/.test(deps.text),
    '唯一出口必须真的接上 _persistParent —— 否则父会话还是不会落盘',
  );
  assert.ok(
    /require\('\.\/j2_loop_shared'\)/.test(dispatcher) && /_persistSession/.test(dispatcher),
    '_persistParent 应通过 j2_loop_shared 的 _persistSession 落盘(单一真源)',
  );
});

test('dispatcher 落盘必须带上最终答案和 state', () => {
  assert.ok(/final:\s*true/.test(dispatcher), '父会话落盘应标记 final');
  assert.ok(/task_input:\s*userInput/.test(dispatcher), '父会话落盘应带上 task_input, 供续跑用');
  // 2026-10-18 拼音统一: 角色名 dispatcher → qian。断言的意图是"落盘要标出
  // 父会话(dispatcher)这条路径", 名字换了意图没变。
  assert.ok(/mode:\s*'qian'/.test(dispatcher), '父会话落盘应标记 mode=qian (dispatcher)');
});

test('j2_agent_loop 的 finally 收口必须有兜底落盘(非 dispatcher 路径)', () => {
  // 2026-10-23(第 64 批): 这条判据第三次换实现, 原因记在 tests/helpers/js_ast.js 顶上:
  //   ① 原来取的是**全文件第一个** '} finally {'。j2 主循环里不止一个 finally
  //      (流式重试循环的清理块在前, 落盘收口块在后), 一取第一个就量错了对象。
  //   ② 后来改成"往后 4000 字符窗口里必须有 _persistSession" —— 魔数窗口,
  //      本批在 finally 里加了几行收尾就把窗口顶破了(只差 103 字符),
  //      落盘点**明明还在块内**, 判据却红了; 而放宽窗口是磨判据, 不是修判据。
  //   ③ 现在按 **AST 节点**取块: tree-sitter 解析出带 finalizer 的 try_statement,
  //      直接看 finalizer 那个节点里有没有落盘调用。
  //
  // 意图一个字没变: **至少有一个 finally 收口块内必须有 _persistSession 兜底**。
  // 变的是量法: 从「块附近」变成「块内」—— 顺带更严了一档
  // (块外面 N 字符内的同名字符串, 旧判据会算命中, 新的不算)。
  const { tree, finalizers } = tryFinalizers(loop);
  assert.ok(!hasSyntaxError(tree),
    'j2_agent_loop 必须能被真解析器无错解析 —— 语法坏掉时任何结构判据都是假绿');
  assert.ok(finalizers.length > 0, 'j2_agent_loop 应有 finally 收口块');
  //
  // 2026-10-23(第 67 批): 第四次换量法, 但这次换的是**钉的东西**, 不是量的方法。
  //   起因: 第 67 批把「屏上那段」抽成 helper `_persistFinalAnswer`, finally 收口块里
  //   就只剩 `await _persistFinalAnswer()` —— 落盘点**没删**, 只是从「块内直接调
  //   _persistSession」变成「块内调 helper, helper 里才调 _persistSession」。
  //   旧判据要求块内出现**字面** `_persistSession(_sessionId`, 于是当场红了。
  //
  //   这里要分清两件事:
  //   · 意图(必须保住): 「主循环抛异常/中断时, 这一轮对话仍然落盘」——
  //     少这一句就是 2026-10-09 那个 P0 事故(整轮对话蒸发)。
  //   · 量法(可以换): 「怎么落盘」是实现细节。第 64 批已经把量法从
  //     「字符窗口」换成「AST 节点」; 第 67 批再从「**字面调用**」换成
  //     「**机制链**」: finally 里要么直接调 _persistSession, 要么调一个
  //     helper, 而那个 helper 的函数体里必须真的落到 _persistSession(_sessionId。
  //
  //   为什么不是「放宽成只要有落盘字样就行」: 那会把这条判据磨成空话。
  //   两跳都要查 —— helper 名字对了但函数体里不落盘, 照样判红(见 mutants/M11)。
  const directPersist = finalizers.some((f) => /_persistSession\(\s*_sessionId/.test(f.text));
  const helperSrc = functionSource(tree, '_persistFinalAnswer');
  const helperCallsPersist = !!helperSrc && /_persistSession\(\s*_sessionId/.test(helperSrc);
  const viaHelper = finalizers.some((f) => /_persistFinalAnswer\s*\(/.test(f.text)) && helperCallsPersist;
  assert.ok(directPersist || viaHelper,
    '至少有一个 finally 收口块内必须有落盘兜底(直接 _persistSession(_sessionId, …), '
    + '或经 _persistFinalAnswer 且该 helper 体内真的调 _persistSession(_sessionId, …)) '
    + '— 否则主循环抛异常时这一轮对话整轮丢失');
});

test('userAborted 必须真声明(之前只被引用, ReferenceError 被 catch 吞掉)', () => {
  assert.ok(
    /(let|var|const)\s+userAborted\s*=/.test(loop),
    'userAborted 必须有声明 — 未声明时 §0.56 状态清理和落盘 state 全是静默 no-op',
  );
  assert.ok(
    /userAborted\s*=\s*true/.test(loop),
    'userAborted 必须在客户端中断时被置位, 否则 aborted 状态永远判不出来',
  );
});
