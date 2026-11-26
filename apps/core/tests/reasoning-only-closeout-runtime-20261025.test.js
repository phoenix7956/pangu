'use strict';
/**
 * 第 88 批补洞 —— 「只回思考不许当答案」的两段收口, **真跑一遍**。
 *
 * ## 为什么要有这个文件
 *
 * 第 88 批把 native 路与 legacy 路的「只回思考」处置接上了, 但配套的守卫
 * (`reasoning-only-not-answer-20261025.test.js` 的 C2/C3/C4) 全是**扫源码**:
 * 「那段代码里 finalText 赋值不许夹带 textContent」。
 *
 * 扫源码只能证明「源码长成那样」, **证明不了它跑起来是那样**。
 * 第 86 批就栽在这个区别上: `const _ft` 又重新赋值, 实机整轮炸掉,
 * 而当时所有单测全绿 (它们测的是策略纯函数, 不是那几行接线)。
 *
 * ⇒ 这里用仓库现成的 AST 抽取法 (`tests/helpers/js_ast`):
 *   把生产源码里那两段 `if (...) { ... }` **原样取出来**, 用 `new Function`
 *   灌进自由变量后**真的调用它**。
 *   跑的是**生产代码本身** (不是抄一份), 所以变异必炸 ⇒ 证明这段真被测到。
 *
 * ## 手法上的三个坑 (都踩过)
 *
 * 1. `continue` / `break` 在块外是非法语法 ⇒ 必须把块放进**循环**里。
 *    而循环正好把「nudge 上限」也真跑出来了 (每轮 `_reasoningOnlyNudges++`,
 *    到上限就落到诚实收口) —— 这比在测试里手写「假装用尽」更真。
 * 2. 抽出来的片段有**自由变量**, 少一个就是 ReferenceError ——
 *    而那不是被测代码坏了, 是装载器没跟上 (踩坑日志 2026-10-24 记过同款)。
 * 3. `round` 必须每轮递增, 否则 `round < maxRounds - 1` 恒真,
 *    nudge 会一直发下去 ⇒ 收口那条分支永远走不到 ⇒ 测试变成空枪。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { parseJs } = require('./helpers/js_ast.js');

const CORE = path.join(__dirname, '..');
const LOOP_PATH = path.join(CORE, 'modules', 'j2_agent_loop.js');
const LOOP_SRC = fs.readFileSync(LOOP_PATH, 'utf8');

// 假想上游给的「思考」长这样 —— 它必须**一个字都不许**出现在交付物里。
const REASONING_TEXT = '<<模型内心戏: 让我先读一下这个文件再说>>';

/**
 * 从生产源码里取出符合条件的 if_statement 原文。
 * @param {object} tree  tree-sitter 的 tree
 * @param {function} match  (conditionText, nodeText) => boolean
 */
function ifStatementSource(tree, match) {
  const found = [];
  (function walk(node) {
    if (node.type === 'if_statement') {
      const cond = node.childForFieldName('condition');
      if (cond && match(cond.text, node.text)) found.push(node.text);
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  })(tree.rootNode);
  assert.ok(found.length === 1,
    `按条件找 if_statement 应恰好命中 1 处, 实际 ${found.length} 处 `
    + '(源码结构变了, 这条测试要跟着改 —— 别放宽成 ">=1")');
  return found[0];
}

/** 假 res: 只收 write, 不往真的流里写。 */
function fakeRes() {
  const written = [];
  return { written, write: (s) => { written.push(String(s)); return true; } };
}

// ===========================================================================
// 一、native 路
// ===========================================================================

/** 取出 native 路的两个块: nudge 块 + 诚实收口块。 */
function nativeBlocks() {
  const tree = parseJs(LOOP_SRC);
  const nudge = ifStatementSource(tree,
    (c) => /_hasReasoningOnly/.test(c) && /_reasoningOnlyNudges\s*<\s*3/.test(c));
  const closeout = ifStatementSource(tree,
    (c) => /^\s*\(\s*_hasReasoningOnly\s*\)\s*$/.test(c));
  return { nudge, closeout };
}

/**
 * 把 native 的两个块装进一个循环里跑。
 * @param {boolean} reasoningOnly  这一轮上游是不是「只回思考」
 */
function runNative(reasoningOnly) {
  const { nudge, closeout } = nativeBlocks();
  const res = fakeRes();
  const factory = new Function('res', 'REASONING_TEXT',
    'let finalText = "";\n'
    + 'let totalChars = 0;\n'
    + 'let evoSuccess = true;\n'
    + 'let _reasoningOnlyNudges = 0;\n'
    + 'const _hasReasoningOnly = ' + (reasoningOnly ? 'true' : 'false') + ';\n'
    + 'const maxRounds = 8;\n'
    + 'const messages = [];\n'
    + 'let textContent = ' + (reasoningOnly ? 'REASONING_TEXT' : '""') + ';\n'
    + 'const _pushReplay = () => {};\n'
    + 'let iterations = 0;\n'
    + 'while (iterations < 12) {\n'
    + '  iterations++;\n'
    + '  const round = iterations - 1;\n'
    + '  ' + nudge + '\n'
    + '  ' + closeout + '\n'
    + '  break;\n'
    + '}\n'
    + 'return { finalText, totalChars, evoSuccess, messages, nudges: _reasoningOnlyNudges, iterations };');
  return factory(res, REASONING_TEXT);
}

test('N1 native 路真跑: 只回思考 ⇒ nudge 上限 3 次 ⇒ 诚实收口, 思考一个字都不许进交付物', () => {
  const r = runNative(true);
  assert.ok(r.nudges === 3,
    `nudge 次数应为 3 (上限), 实际 ${r.nudges} —— 收口分支可能没走到, 或上限没生效`);
  assert.ok(r.finalText, '诚实收口必须给主人一句话 (不能交空)');
  assert.ok(/只回思考/.test(r.finalText),
    '诚实收口必须明说「只回思考」—— 主人有权知道这一轮发生了什么');
  assert.ok(!r.finalText.includes(REASONING_TEXT),
    '★ 交付物里夹带了模型的思考 —— 这正是第 88 批要治的病');
  assert.ok(!r.finalText.includes('内心戏'),
    '交付物里夹带了思考的内容片段');
  assert.strictEqual(r.evoSuccess, false,
    '这一轮必须判失败 (evoSuccess=false), 不能一边交诚实说明一边显示 completed');
  assert.strictEqual(r.totalChars, r.finalText.length,
    'totalChars 必须等于诚实说明的长度');
});

test('N2 native 路真跑: 上游给了正文 ⇒ 收口那段**不许触发** (不许把正常答案换成诚实说明)', () => {
  const r = runNative(false);
  assert.strictEqual(r.finalText, '',
    '上游有正文时, 「只回思考」收口不许改写交付物');
  assert.strictEqual(r.nudges, 0, '上游有正文时一次 nudge 都不该发');
  assert.strictEqual(r.evoSuccess, true, '上游有正文时不该判失败');
});

// ===========================================================================
// 二、legacy 流式路
// ===========================================================================

/** 取出 legacy 路的那个块 (它自带 nudge + 诚实收口)。 */
function legacyBlock() {
  const tree = parseJs(LOOP_SRC);
  return ifStatementSource(tree, (c) => /^\s*\(\s*_streamReasoningOnly\s*\)\s*$/.test(c));
}

/**
 * 把 legacy 那个块装进循环里跑。
 * @param {boolean} reasoningOnly  这一轮上游是不是「整条流零正文」
 */
function runLegacy(reasoningOnly) {
  const block = legacyBlock();
  const res = fakeRes();
  const factory = new Function('res', 'REASONING_TEXT',
    'let finalText = "";\n'
    + 'let totalChars = 0;\n'
    + 'let evoSuccess = true;\n'
    + 'let _reasoningOnlyNudges = 0;\n'
    + 'const _streamReasoningOnly = ' + (reasoningOnly ? 'true' : 'false') + ';\n'
    + 'const _streamReasoningChars = ' + (reasoningOnly ? '168' : '0') + ';\n'
    + 'const maxRounds = 8;\n'
    + 'const messages = [];\n'
    + 'let textContent = ' + (reasoningOnly ? 'REASONING_TEXT' : '"真正的正文"') + ';\n'
    + 'let yieldedLen = 0;\n'
    + 'let iterations = 0;\n'
    + 'while (iterations < 12) {\n'
    + '  iterations++;\n'
    + '  const round = iterations - 1;\n'
    // ⚠ 每轮都要把上游的响应重新装回 textContent ——
    //   真实代码里 textContent 是**每轮**从上游那条流重新取的 (2680 行那处),
    //   不是沿用上一轮的。不重置的话: 第 1 轮把它清空了, 第 2 轮起
    //   `const _thinking = String(textContent || '')` 取到的就是空串 ⇒
    //   harness 跑出来的行为跟生产代码不是一回事 (L3 的变异就是被这个坑挡住的)。
    + '  textContent = ' + (reasoningOnly ? 'REASONING_TEXT' : '"真正的正文"') + ';\n'
    + '  ' + block + '\n'
    + '  break;\n'
    + '}\n'
    + 'return { finalText, totalChars, evoSuccess, messages, textContent, nudges: _reasoningOnlyNudges, iterations };');
  return factory(res, REASONING_TEXT);
}

test('L1 legacy 路真跑: 思考进历史、不进答案; nudge 用尽 ⇒ 诚实收口', () => {
  const r = runLegacy(true);
  assert.ok(r.nudges === 3,
    `nudge 次数应为 3 (上限), 实际 ${r.nudges}`);
  assert.ok(r.finalText, '诚实收口必须给主人一句话');
  assert.ok(/只回思考/.test(r.finalText), '诚实收口必须明说「只回思考」');
  assert.ok(!r.finalText.includes(REASONING_TEXT),
    '★ 交付物里夹带了思考 —— legacy 路原来一点检测都没有, 思考会直接变成 finalText');
  assert.strictEqual(r.evoSuccess, false, '这一轮必须判失败');
  // 思考必须**留在历史里** (模型下一轮看得见自己想过什么) —— 但不进答案。
  const asst = r.messages.filter((m) => m.role === 'assistant');
  assert.ok(asst.length >= 1, '思考必须留在历史里 (assistant 轮)');
  assert.ok(asst.some((m) => String(m.content).includes(REASONING_TEXT)),
    '★ 思考没有留在历史里 —— 兼容契约 (模型下一轮看得见自己想过什么) 被破坏了');
  assert.strictEqual(r.textContent, '',
    '★ 思考没被清空 —— 它会顺着 textContent 流进 finalText');
});

test('L2 legacy 路真跑: 上游给了正文 ⇒ 那段不许触发', () => {
  const r = runLegacy(false);
  assert.strictEqual(r.finalText, '', '上游有正文时, 「只回思考」收口不许改写交付物');
  assert.strictEqual(r.nudges, 0, '上游有正文时一次 nudge 都不该发');
  assert.strictEqual(r.textContent, '真正的正文', '上游有正文时 textContent 不许被清空');
});

test('L3 变异: 把 legacy 收口里的 finalText 换成思考原文 ⇒ L1 必须红 (证明 L1 真能咬住)', () => {
  // 手法: 把生产源码里那一处赋值改掉 (内存里改, 一个字节不落盘),
  // 重跑同一条断言 —— L1 必须失败。
  // 这条是「判据有没有牙」的自证: 守卫本身不会因为改错而绿。
  // ⚠ 变异点必须挑**legacy 那处** (文件里第 2 处), 不是 native 那处:
  //   两处的赋值语句长得一模一样, 而 native 那处没有 `_thinking` 这个变量 ——
  //   改错了会变成 ReferenceError, 那测的就不是「思考混进交付物」这件事了。
  //   锚点用字符码拼出来, 免得 emoji 在不同环境下变形导致锚点静默失效。
  const Q = String.fromCharCode(39);
  const HEAD = 'finalText = ' + Q + '\u26a0\ufe0f [只回思考]';
  const first = LOOP_SRC.indexOf(HEAD);
  const second = LOOP_SRC.indexOf(HEAD, first + 1);
  assert.ok(first > 0 && second > first,
    `生产源码里应该有两处诚实收口赋值 (native 一处 + legacy 一处), 实际 first=${first} second=${second} `
    + '—— 锚点失效, 本条作废 (别放宽成 "找到一处就算")');
  const mutated = LOOP_SRC.slice(0, second)
    + 'finalText = _thinking + ' + Q + '\u26a0\ufe0f [只回思考]'
    + LOOP_SRC.slice(second + HEAD.length);

  const tree = parseJs(mutated);
  let block = null;
  (function walk(n) {
    if (block) return;
    if (n.type === 'if_statement') {
      const c = n.childForFieldName('condition');
      if (c && /^\s*\(\s*_streamReasoningOnly\s*\)\s*$/.test(c.text)) { block = n.text; return; }
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i));
  })(tree.rootNode);
  assert.ok(block, '变异后找不到 legacy 那块 —— 锚点失效');

  const res = fakeRes();
  const factory = new Function('res', 'REASONING_TEXT',
    'let finalText = ""; let totalChars = 0; let evoSuccess = true; let _reasoningOnlyNudges = 0;\n'
    + 'const _streamReasoningOnly = true; const _streamReasoningChars = 168; const maxRounds = 8;\n'
    + 'const messages = []; let textContent = REASONING_TEXT; let yieldedLen = 0; let iterations = 0;\n'
    + 'while (iterations < 12) { iterations++; const round = iterations - 1; textContent = REASONING_TEXT; '
    + block + ' break; }\n'
    + 'return { finalText, totalChars, evoSuccess, messages, textContent, nudges: _reasoningOnlyNudges };');
  const r = factory(res, REASONING_TEXT);
  assert.ok(r.finalText.includes(REASONING_TEXT),
    '★ 变异体居然没把思考混进交付物 —— 说明变异没打上 (锚点失效)');
  // 这就是 L1 会红的原因: 交付物里夹带了模型的思考。
  let threw = null;
  try {
    assert.ok(!r.finalText.includes(REASONING_TEXT),
      '★ 交付物里夹带了模型的思考 —— 这正是第 88 批要治的病');
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'L1 这条断言必须是恒真的假货 —— 变异体必须让它红');
  assert.ok(/夹带了模型的思考/.test(String(threw && threw.message)),
    '变异体必须正好死在「交付物里夹带了模型的思考」这条断言上, 实际: ' + String(threw && threw.message));
});
