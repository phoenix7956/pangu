'use strict';
/**
 * tests/helpers/js_ast.js —— 用**真解析器**取 JS 结构, 替掉「往后 N 个字符」的魔数窗口。
 *
 * ## 为什么要有这个
 *
 * 盘古的老判据里到处是这种写法:
 *
 *     src.slice(idx, idx + 4000) 里必须出现某个字符串
 *
 * 三个毛病, 都被真实踩过:
 *
 * 1. **魔数会过期**。2026-10-23 第 64 批在 `j2_agent_loop.js` 的 finally 块里
 *    加了几行收尾, `session-persist-regression.test.js` 那条 4000 字符窗口当场被顶破
 *    (实际只差 103 字符) —— 落盘点**明明还在块内**, 判据却红了。
 *    窗口每被顶破一次, 就得放宽一次(那文件里已经有过 1500 → 4000 一次放宽记录),
 *    放宽不是修法, 是把判据慢慢磨没。
 *
 * 2. **窗口会误判**。块**外面** N 字符内的同名字符串也算命中 ——
 *    真正要验的是「在 finally 块**内**」, 窗口只能验「在 finally 块附近」。
 *
 * 3. **窗口量错对象**。同一个文件里有多个 finally 时, 「从第一个 finally 往后看」
 *    量到的可能是另一个块 —— `session-persist-regression.test.js` 自己的注释里
 *    记着 2026-10-16 那次「取全文件第一个 `} finally {`」的翻车。
 *
 * ## 本 helper 干什么
 *
 * 直接把源码交给 tree-sitter(本项目 `modules/symbol_search.js` 已在用同一个依赖),
 * 按 **AST 节点**取块。代码长一点短一点, 判据的意图一个字都不变。
 *
 * ## 依赖
 *
 * tree-sitter + tree-sitter-javascript 都在 `dependencies` 里, 不是 devDependencies。
 */

const fs = require('fs');

let _Parser = null;
let _JS = null;

function _grammar() {
  if (!_Parser) {
    // 懒加载: 这套原生模块加载不便宜, 而大部分测试文件根本不用它
    _Parser = require('tree-sitter');
    _JS = require('tree-sitter-javascript');
  }
  const parser = new _Parser();
  parser.setLanguage(_JS);
  return parser;
}

/** 解析 JS 源码, 返回 tree-sitter 的 tree */
function parseJs(src) {
  return _grammar().parse(src);
}

/** 读文件 + 解析 */
function parseJsFile(file) {
  return parseJs(fs.readFileSync(file, 'utf8'));
}

/**
 * 找出所有 **带 finalizer 的** try_statement。
 *
 * 注意: tree-sitter 的 javascript grammar 里, `try { } catch { } finally { }`
 * 是一个 try_statement 节点, finalizer 在 `finalizer` 字段上;
 * 没有 finally 的 try 没有这个字段。
 *
 * @returns {{ tree: object, finalizers: Array<{ text: string, line: number, start: number, end: number, node: object }> }}
 */
function tryFinalizers(src) {
  const tree = parseJs(src);
  const finalizers = [];

  (function walk(node) {
    if (node.type === 'try_statement') {
      const fin = node.childForFieldName('finalizer');
      if (fin) {
        finalizers.push({
          node: fin,
          text: fin.text,
          line: fin.startPosition.row + 1,
          start: fin.startIndex,
          end: fin.endIndex,
        });
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  })(tree.rootNode);

  return { tree, finalizers };
}

/**
 * 判断某段源码里有没有语法错(tree-sitter 会在 ERROR 节点上标出来)。
 *
 * 为什么要单独给一条: 判据若在**语法坏掉**的源码上跑, 它会因为「读不出结构」
 * 而假绿 —— 那不是「结构符合预期」, 是「没读出来」。
 */
function hasSyntaxError(tree) {
  return !!tree.rootNode.hasError;
}

/**
 * 找出所有「以 name 为被调用者」的调用点。
 *
 * ## 为什么用 AST 而不是 grep
 *   一句注释 `// 这里以前调用过 resDone(` 或者字符串里有个 "resDone(",
 *   都能让 grep 判据买到假绿 —— 而**本项目栽的正是这一种**:
 *   `_persistParent` 的注释白纸黑字写着「6 处调用覆盖 … 关键词兜底 … 全部路径」,
 *   而代码里关键词兜底一处都没有。注释会撒谎, 语法树不会。
 *
 * ## 认两种写法
 *   name(...)        → callee 是 identifier
 *   obj.name(...)    → callee 是 member_expression, 属性名是 name
 *   (第 65 批要的 `makeCloseOut(` 就是后一种: `require('…').makeCloseOut({…})`)
 *
 * @param {object} tree  parseJs / parseJsFile 的返回值
 * @param {string} name  被调用者名字
 * @returns {Array<{ line:number, args:Array<object>, node:object, text:string }>}
 */
function callSites(tree, name) {
  const out = [];
  if (!tree || !tree.rootNode) return out;

  (function walk(node) {
    if (node.type === 'call_expression') {
      const callee = node.childForFieldName('function');
      let hit = false;
      if (callee && callee.type === 'identifier' && callee.text === name) {
        hit = true;
      } else if (callee && callee.type === 'member_expression') {
        const prop = callee.childForFieldName('property');
        // `obj.name(...)` 的属性名在 tree-sitter 里是 property_identifier,
        // 不是 identifier —— 只认 identifier 会漏掉 `require('…').makeCloseOut(…)` 这种。
        if (
          prop &&
          (prop.type === 'identifier' || prop.type === 'property_identifier') &&
          prop.text === name
        ) {
          hit = true;
        }
      }
      if (hit) {
        const args = [];
        const argsNode = node.childForFieldName('arguments');
        if (argsNode) {
          for (let i = 0; i < argsNode.childCount; i++) {
            const c = argsNode.child(i);
            // arguments 节点的子项里混着括号、逗号和注释 ——
            // 它们不是参数, 留着会让「第 2 个参数是落盘规格」这种判据读到括号上。
            if (c.type === 'comment') continue;
            if (c.type === '(' || c.type === ')' || c.type === ',') continue;
            args.push(c);
          }
        }
        out.push({
          line: node.startPosition.row + 1,
          args,
          node,
          text: node.text,
        });
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  })(tree.rootNode);

  return out;
}

/**
 * 找出某个名字的**全部标识符引用**及其源码区间。
 *
## 为什么要有这个
 *   「这个变量是不是只在某个函数的**作用域**里?」这种问题, grep 答不了:
 *   grep 只知道**字面出现过**, 不知道**在哪个作用域**。
 *   第 77 批就栽在这: B 类分支读了闭包 `_planViaMainAgent` 里的 `let _planResult`,
 *   文本上完全合法(引用了一个真实存在过的变量), 运行起来却是
 *   **ReferenceError: _planResult is not defined** ——
 *   主人这一轮 32 帧进度、**一个 final 都没有**。
 *
 *   语法树知道每个标识符节点的**字符区间**, 于是能判
 *   「这些引用是不是全都落在那个函数的区间内」。
 *
 * @returns {Array<{ line:number, start:number, end:number, text:string }>}
 */
function identifierRefs(tree, name) {
  const out = [];
  if (!tree || !tree.rootNode) return out;

  (function walk(node) {
    if (node.type === 'identifier' && node.text === name) {
      out.push({
        line: node.startPosition.row + 1,
        start: node.startIndex,
        end: node.endIndex,
        text: node.text,
      });
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  })(tree.rootNode);

  return out;
}

/**
 * 找出所有 `name = ...` 的**赋值点**(右值文本 + 源码区间)。
 *
 * ## 为什么要区分「声明」和「赋值」
 *   `let x = 0` 是声明 + 初始化, `x = 1` 是赋值。
 *   作用域契约里两件事要分开查:
 *     ① **声明**在哪 (外层 let 还是闭包里的 let) —— 决定这个变量在哪儿存不存在;
 *     ② **赋值**从哪来 (右值引用了谁) —— 决定这个变量拿到的值对不对。
 *
 * @returns {Array<{ line:number, start:number, end:number, right:string, node:object }>}
 */
function assignmentsTo(tree, name) {
  const out = [];
  if (!tree || !tree.rootNode) return out;

  (function walk(node) {
    if (node.type === 'assignment_expression') {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      if (left && left.type === 'identifier' && left.text === name) {
        out.push({
          line: node.startPosition.row + 1,
          start: node.startIndex,
          end: node.endIndex,
          right: right ? right.text : '',
          node,
        });
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  })(tree.rootNode);

  return out;
}

/**
 * 找出某个名字的**声明点**(`let` / `const` / `var` 的 declarator)。
 *
 * @returns {Array<{ line:number, start:number, end:number, kind:string }>}
 */
function declarationsOf(tree, name) {
  const out = [];
  if (!tree || !tree.rootNode) return out;

  (function walk(node) {
    if (
      node.type === 'lexical_declaration' ||
      node.type === 'variable_declaration'
    ) {
      for (let i = 0; i < node.childCount; i++) {
        const d = node.child(i);
        if (d.type !== 'variable_declarator') continue;
        const id = d.childForFieldName('name');
        if (id && id.type === 'identifier' && id.text === name) {
          out.push({
            line: node.startPosition.row + 1,
            start: node.startIndex,
            end: node.endIndex,
            kind: node.type === 'lexical_declaration' ? 'let/const' : 'var',
          });
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  })(tree.rootNode);

  return out;
}

/**
 * 找出 `const name = (...) => {...}` / `function name(...) {...}` 的**源码区间**。
 *
 * @returns {{ start:number, end:number, line:number }|null} 找不到返回 null
 */
function functionRange(tree, name) {
  let found = null;
  if (!tree || !tree.rootNode) return null;

  (function walk(node) {
    if (found) return;
    if (node.type === 'variable_declarator') {
      const id = node.childForFieldName('name');
      const val = node.childForFieldName('value');
      if (
        id &&
        id.type === 'identifier' &&
        id.text === name &&
        val &&
        (val.type === 'arrow_function' || val.type === 'function')
      ) {
        found = val;
        return;
      }
    }
    if (node.type === 'function_declaration') {
      const id = node.childForFieldName('name');
      if (id && id.text === name) {
        found = node;
        return;
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  })(tree.rootNode);

  if (!found) return null;
  return {
    start: found.startIndex,
    end: found.endIndex,
    line: found.startPosition.row + 1,
  };
}

/**
 * 找出 `const name = (...) => {...}` / `function name(...) {...}` 的源码文本。
 *
 * ## 为什么要按函数取块
 *   「某个函数体里必须带某样东西」这种判据, 用字符窗口量是错的 ——
 *   窗口会把**函数外面**的东西也算进去(第 64 批就栽在 4000 字符窗口上:
 *   落盘点明明还在 finally 块内, 判据却红了, 而放宽窗口是磨判据)。
 *   按 AST 节点取, 量的就是那个函数体本身。
 *
 * @returns {string|null} 找不到返回 null
 */
function functionSource(tree, name) {
  let found = null;
  if (!tree || !tree.rootNode) return null;

  (function walk(node) {
    if (found) return;
    if (node.type === 'variable_declarator') {
      const id = node.childForFieldName('name');
      const val = node.childForFieldName('value');
      if (
        id &&
        id.type === 'identifier' &&
        id.text === name &&
        val &&
        (val.type === 'arrow_function' || val.type === 'function')
      ) {
        found = val.text;
        return;
      }
    }
    if (node.type === 'function_declaration') {
      const id = node.childForFieldName('name');
      if (id && id.text === name) {
        found = node.text;
        return;
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  })(tree.rootNode);

  return found;
}

module.exports = {
  parseJs,
  parseJsFile,
  tryFinalizers,
  hasSyntaxError,
  callSites,
  functionSource,
  identifierRefs,
  functionRange,
  assignmentsTo,
  declarationsOf,
};
