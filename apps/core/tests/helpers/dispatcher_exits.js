'use strict';
/**
 * tests/helpers/dispatcher_exits.js —— dispatcher「交付出口」的统一量法
 *
 * ## 为什么要有这个
 *   2026-10-23 第 65 批把两样东西收成了唯一实现:
 *     · 「综合 → 兜底 → 定稿核验 → 剥伪工具标记」这 5 步 → `_synthesizeAndFinalize`
 *     · 落盘 → `_closeOut`
 *   这 5 步原来在 4 条综合路里**一字不差地各写一遍**。
 *
 *   于是老判据里那一大批「N 处都要带 X」的断言, 量法全部失效 ——
 *   **不是行为坏了, 是「N 处抄本」这个对象不存在了。**
 *   但那些断言的**意图**一个字都没变: 每条交付路径都得带 X。
 *
 * ## 本 helper 回答的问题
 *   「每条交付路径都走到了某个实现没有?」
 *
 *   做法: 数两份数, 让它们对账 ——
 *     · 交付出口数(每条交付路径一个)
 *     · 每个出口在收口**之前**走过哪些实现
 *   对得上 = 每条路径都走到了; 对不上 = 有一条漏了。
 *
 * ## 为什么不能靠数内联调用点
 *   数内联调用点只能证明「某处写了这个」, 证明不了「每条路径都走到了它」。
 *   而后者才是那批老断言真正想守的东西。
 *   (第 65 批实况: 抄本从 5 处收成 1 处, 「数 5 处」当场变 2 —— 数字变了, 行为没变。)
 */

const fs = require('fs');
const path = require('path');
const { parseJs, callSites, functionSource } = require('./js_ast');

const CORE = path.join(__dirname, '..', '..');
const DISPATCHER = path.join(CORE, 'modules', 'j2_dispatcher.js');

/** dispatcher 里所有已知的「交付路径实现」 */
const IMPLEMENTATIONS = [
  '_synthesizeAndFinalize',
  '_finalize',
  '_finalizeAnswerText',
  '_synthesizeStreamText',
  '_reconcileWithLedger',
];

function readDispatcher() {
  return fs.readFileSync(DISPATCHER, 'utf8');
}

function parseDispatcher() {
  return parseJs(readDispatcher());
}

/** 一个节点里(含子树)有没有对 name 的调用 */
function containsCall(node, name) {
  let hit = false;
  (function walk(n) {
    if (hit || !n) return;
    if (n.type === 'call_expression') {
      const callee = n.childForFieldName('function');
      if (callee) {
        if (callee.type === 'identifier' && callee.text === name) {
          hit = true;
          return;
        }
        if (callee.type === 'member_expression') {
          const prop = callee.childForFieldName('property');
          if (prop && prop.text === name) {
            hit = true;
            return;
          }
        }
      }
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i));
  })(node);
  return hit;
}

/** 找到 node 所在的 statement_block 里, node 所属的那一条语句 */
function blockChild(node) {
  let n = node;
  while (n && n.parent && n.parent.type !== 'statement_block') n = n.parent;
  return n && n.parent ? n : null;
}

/**
 * 某个调用点**之前**(同一块里)出现过的实现调用。
 *
 * 为什么只看「之前」: 收口之后才做的事不算这条路径走到过。
 * (比如主路径的 `_reconcileWithLedger` 在收口剥离之后 —— 它是对账, 不是定稿。)
 */
function implementationsBefore(node, names) {
  const child = blockChild(node);
  if (!child) return [];
  const block = child.parent;
  const found = new Set();
  for (let i = 0; i < block.childCount; i++) {
    const st = block.child(i);
    if (st === child) break;
    for (const nm of names) {
      if (containsCall(st, nm)) found.add(nm);
    }
  }
  return [...found];
}

/**
 * 出口**之前**最近的那条「产出最终答复的语句」, 以及它调了哪些实现。
 *
 * 为什么不用「同块里所有之前的语句」: 那样算出来的集合会**过宽** ——
 * 主路径的整段函数体都在块里, 直答路径顺手调过的 `_finalize` 也会被算成
 * 主路径走过。主路径的「产出语句」是 `finalText = await _synthesizeAndFinalize(...)`,
 * 认它才准。
 */
function producerBefore(node, names) {
  const child = blockChild(node);
  if (!child) return null;
  const block = child.parent;
  const steps = [];
  for (let i = block.childCount - 1; i >= 0; i--) {
    const st = block.child(i);
    if (st === child) continue;
    if (st.startIndex > node.startIndex) continue;
    // 「产出最终答复」= **一条表达式语句**, 形式是 `finalText = ...`。
    // 必须是表达式语句本身 —— 不能拿 `if (...) { ... }` 这种复合语句的整段文字来判断:
    //   那个 if 块里直答路径有 `finalText = ...`, 但它属于**别的分支**,
    //   算到主路径头上就成了假通过。
    if (!isFinalTextAssign(st)) continue;
    const impls = names.filter((nm) => containsCall(st, nm));
    steps.push({ line: st.startPosition.row + 1, impls, text: st.text });
  }
  steps.reverse();
  // 只认「真的调了实现」的那几步:
  //   主路径里 `finalText = _recon.text` 也是赋值, 但它只是把已定稿的文本搬一下,
  //   真正的产出在上一句 `_synthesizeAndFinalize`。
  const withImpl = steps.filter((s) => s.impls.length);
  const use = withImpl.length ? withImpl : steps;
  const union = [];
  for (const s of use) for (const nm of s.impls) if (!union.includes(nm)) union.push(nm);
  return { steps: use, impls: union };
}

/** 这条语句是不是「给最终答复的变量赋值」 */
function isFinalTextAssign(st) {
  if (!st || st.type !== 'expression_statement') return false;
  const expr = st.namedChild(0);
  if (!expr || expr.type !== 'assignment_expression') return false;
  const left = expr.childForFieldName('left');
  // 这版 tree-sitter-javascript 的 assignment_expression 只暴露 left / right 两个字段,
  // 运算符是匿名子节点 —— `childForFieldName('operator')` 拿不到, 得自己看。
  // 必须是**单等号**: `finalText == x` 是比较, 不是赋值。
  const op = expr.child(1);
  if (!op || op.text !== '=') return false;
  return !!(left && left.type === 'identifier' && ['finalText', '_daText', '_ft'].includes(left.text));
}

/**
 * 交付出口清单。
 *
 * 「交付出口」= 带 status 三元式的 `_closeOut` 调用点 ——
 *   即真正把答复交出去的那几条路(直答 / fixed_flow / 关键词兜底 / 主路径)。
 *   空输入拒收、配额快失败那种带 `status: 'failed'` 字面量的**不是**交付出口。
 *
 * @returns {Array<{ line:number, mode:string|null, text:string, via:string[] }>}
 */
function deliveryExits(tree) {
  return callSites(tree, '_closeOut')
    .filter((s) => /status:\s*[A-Za-z_$][\w$]*\s*\?/.test(s.args[0] ? s.args[0].text : ''))
    .map((s) => ({
      line: s.line,
      mode: (s.args[0].text.match(/mode:\s*'([a-z_]+)'/) || [])[1] || null,
      text: s.args[0].text,
      spec: s.args[1] ? s.args[1].text : null,
      via: implementationsBefore(s.node, IMPLEMENTATIONS),
      producer: producerBefore(s.node, IMPLEMENTATIONS),
    }));
}

/**
 * 一次算齐三份数:
 *   exits   —— 交付出口有几个
 *   via     —— 每个出口走过哪些实现
 *   missing —— 哪些出口没走到某个实现
 */
function exitLedger(tree) {
  const exits = deliveryExits(tree);
  const graph = implementationGraph(tree);
  return {
    exits,
    count: exits.length,
    via: (impl) => exits.filter((e) => e.via.includes(impl)),
    missing: (impl) => exits.filter((e) => !e.via.includes(impl)),
    /**
     * 某个实现**覆盖了哪些交付出口**。
     *
     * 覆盖 = 这个出口的产出实现**直接或间接**调到了它。
     *   例: 收口剥离 `_finalizeAnswerText` 现在住在 `_synthesizeAndFinalize` 里面,
     *   而 3 条综合路的产出实现都是 `_synthesizeAndFinalize` ⇒ 它覆盖 3 条;
     *   直答路径直接调 `_finalizeAnswerText` ⇒ 再覆盖第 4 条。合起来全覆盖。
     *
     * 这就是第 65 批之后, 那批「N 处都要带 X」的老断言该用的量法 ——
     * 它问的仍然是「每条路径都带 X吗」, 只是 X 现在住在实现里, 不再住在每个副本里。
     */
    covers: (impl) => {
      // 方向别搞反: 是「这个出口的产出实现**能调到** impl」,
      // 不是「impl 能调到产出实现」。
      return exits.filter((e) => e.producer.impls.some((p) => p === impl || reachable(graph, p).has(impl)));
    },
    uncovered: (impl) => {
      return exits.filter((e) => !e.producer.impls.some((p) => p === impl || reachable(graph, p).has(impl)));
    },
  };
}

/** 实现之间的**直接**调用关系 */
function implementationGraph(tree) {
  const graph = {};
  for (const name of IMPLEMENTATIONS) {
    const src = functionSource(tree, name);
    graph[name] = src
      ? IMPLEMENTATIONS.filter((other) => other !== name && new RegExp('\\b' + other + '\\s*\\(').test(src))
      : [];
  }
  return graph;
}

/** 传递闭包: 从 impl 出发能到达哪些实现 */
function reachable(graph, impl) {
  const seen = new Set();
  const stack = [impl];
  while (stack.length) {
    const n = stack.pop();
    for (const m of graph[n] || []) {
      if (!seen.has(m)) {
        seen.add(m);
        stack.push(m);
      }
    }
  }
  return seen;
}

/**
 * 「直交付」出口 —— 它自己就是最终答复, 不走综合/流式助手。
 *
 * 有两类:
 *   ① 直答 / 单刀直查 / 单目标阅读 (direct_answer / single_shot / single_file)
 *      —— 一次一个 agent 出结果, 没有「子 agent 汇报」可综合;
 *   ② 澄清 (clarify) —— 主 agent 判「指代不明」, 把反问直接交回主人
 *      (2026-10-24 第 77 批: 原来拆解轮的原话被丢掉, 主人这一轮什么都拿不到)。
 *
 * ## 为什么这个名单放在这里, 而不是每个测试各写一份
 *   2026-10-24 第 77 批加「澄清」这条出口时, 三个「份数/覆盖」类判据同时红了
 *   (fallback-no-scaffold / chart-gate-authoritative / synthesis-stream-idle) ——
 *   三个测试各有一份「哪些出口可以不综合」的名单, 改一处要改三处,
 *   而漏掉的那一处会**静默放过**一条新的绕路出口。
 *   名单收成一份, 三处都从这儿取 —— 跟盘古主体那边「收成唯一实现」同一个道理。
 */
const DIRECT_DELIVERY_RE = /mode:[^,}]*'(direct_answer|single_shot|single_file)'|mode:\s*'clarify'/;

function isDirectDelivery(exit) {
  return DIRECT_DELIVERY_RE.test(String((exit && exit.text) || ''));
}

module.exports = {
  DISPATCHER,
  IMPLEMENTATIONS,
  DIRECT_DELIVERY_RE,
  isDirectDelivery,
  readDispatcher,
  parseDispatcher,
  containsCall,
  implementationsBefore,
  deliveryExits,
  exitLedger,
  finalizeCoverage,
};

/**
 * 一行式覆盖率判据: 「每个交付出口都走到了某个实现吗?」
 *
 * 存在的理由: 第 65 批之后, 十几个老断言都在问「N 处都要带 X」,
 * 而 X 已经住进实现里、不再住在每个副本里。各自写一遍这套算法 = 又一份抄本,
 * 迟早各自漂。所以收在这里, 谁都用同一份。
 */
function finalizeCoverage() {
  const led = exitLedger(parseDispatcher());
  return {
    ledger: led,
    count: led.count,
    /** 每个交付出口都走到了 impl 吗 */
    all: (impl) => led.uncovered(impl).length === 0,
    /** 没走到的出口 */
    uncovered: (impl) => led.uncovered(impl),
    /** 走到了 impl 的出口 */
    covered: (impl) => led.covers(impl),
  };
}

