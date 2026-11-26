/**
 * tests/helpers/gua_gate_load.js
 * 起卦门 / dispatcher 门的**测试装载器** (2026-10-23 第 58 批)
 *
 * 为什么要有这个文件:
 *   2026-10-23 第 58 批把 8 张起卦门词表从 pangu-single.js 搬去了
 *   modules/gua_gate_kws.js (唯一真源)。而**四个老测试是从 pangu-single.js 的
 *   源码文本里切片求值**来拿到这些词表的:
 *
 *     const CONSTS_FROM = SINGLE.indexOf('const _GUA_SUPPRESS_KWS');
 *     const DISP_FROM  = SINGLE.indexOf('function _shouldUseDispatcher');
 *     const SLICE = SINGLE.slice(CONSTS_FROM, DISP_FROM) + DISP_SRC;
 *     const cast = new Function(SLICE + '; return _shouldCastGua;')();
 *
 *   词表一搬, `indexOf('const _GUA_SUPPRESS_KWS')` = -1 ⇒ slice(-1, …) 切出垃圾
 *   ⇒ 整链在第一个失败文件就断 (npm run test:chain 是 && 串联, 后面根本没跑)。
 *   报错是 `_PURE_CHAT_KWS is not defined` —— 看着像搬家搬坏了, 其实是**测试的
 *   取数方式跟文件布局耦合**。
 *
 * 本装载器把那份耦合拆掉:
 *   · 词表 → 从 modules/gua_gate_kws.js 取 (**唯一真源**, 与线上同一份)
 *   · 两个判定函数 → 仍从 pangu-single.js 抽 (它们就该住在那儿, 搬家不归这一批)
 *   · 注入时用 pangu-single.js 里那两个函数真正使用的下划线别名, 行为逐位不变
 *
 * ⚠️ 为什么不再各写一份切片:
 *   盘古 2026-10-21 亲自踩过 —— 「**两份同义文本各改各的, 改一次就漂一次**」。
 *   四个测试各写一份抽取代码 = 四份同义文本, 下一个搬动的人要改四处。
 *   ⇒ 一份装载器, 四个测试都用它 (与 tests/helpers/provenance_mutate.js 同层同风格)。
 *
 * ⚠️ require 基准:
 *   `_shouldUseDispatcher` 体内按相对路径 require('./modules/j2_dispatcher')。
 *   `new Function` 里的相对 require 会按**调用方**解析 ⇒ 必须用
 *   createRequire(pangu-single.js) 当基准; 用本测试文件当基准会解析到 tests/ 下面去,
 *   找不到 → 静默退回旧行为 → 测试全绿而线上照旧坏。基准错了, 这类测试等于没写。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const CORE = path.join(__dirname, '..', '..');
const SINGLE_PATH = path.join(CORE, 'pangu-single.js');
const SINGLE = fs.readFileSync(SINGLE_PATH, 'utf8');

/** 词表唯一真源 (2026-10-23 第 58 批搬过去的) */
const GATE = require(path.join(CORE, 'modules', 'gua_gate_kws.js'));

/**
 * pangu-single.js 里那两个函数用的**下划线别名** → 模块里的导出名。
 * 搬家用的是「同名别名解构」, 所以线上那两个函数体里的名字一个没变;
 * 这里照同一张对照表注入, 保证「测试跑的和线上跑的是同一份词表」。
 */
const ALIAS = Object.freeze({
  _PURE_CHAT_KWS: 'PURE_CHAT_KWS',
  _GUA_DECISION_KWS: 'GUA_DECISION_KWS',
  _GUA_CAST_REQUEST_KWS: 'GUA_CAST_REQUEST_KWS',
  _GUA_FACT_LOOKUP_KWS: 'GUA_FACT_LOOKUP_KWS',
  _GUA_FACT_OVERRIDE_KWS: 'GUA_FACT_OVERRIDE_KWS',
  _GUA_SUPPRESS_KWS: 'GUA_SUPPRESS_KWS',
  _GUA_EXEC_KWS: 'GUA_EXEC_KWS',
});

/** 抽一段括号配平的源码 (从 `startAt` 处的第一个 `{` 起算) */
function sliceBalanced(src, startAt) {
  const open = src.indexOf('{', startAt);
  assert.ok(open > 0, '抽不到函数体');
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(startAt, i + 1);
  }
  throw new Error('括号不配平');
}

/** 注入段: 模块里的名字 (isGuaFactLookup 体内引用它们) + pangu-single 用的下划线别名 */
const PRELUDE = [
  ...Object.values(ALIAS).map((key) => `const ${key} = ${JSON.stringify(GATE[key])};`),
  `const GUA_FACT_LOOKUP_RE = ${GATE.GUA_FACT_LOOKUP_RE.toString()};`,
  ...Object.entries(ALIAS).map(([alias, key]) => `const ${alias} = ${key};`),
  // _isGuaFactLookup 现在住在模块里 (pangu-single.js 用别名接回来)。
  // 取它的源码注入, 而不是另抄一份 —— 抄一份就是盘古 2026-10-21 踩过的那个坑。
  `const _isGuaFactLookup = ${GATE.isGuaFactLookup.toString()};`,
  // 2026-10-24 第 76 批: 同理 —— isConcreteTargetTask 住在模块里,
  // pangu-single.js 的 _shouldCastGua 通过别名调它。装载器不注入的话,
  // 测试里这个别名是 undefined ⇒ 那一档静默不生效 ⇒ 测试成了空枪。
  // ⚠️ **两个名字都要注入**, 不能只注入别名 —— 这是本批真踩的坑:
  //   isConcreteTargetTask 的**源码内部**调用的是模块级的 `isShushuContext(...)`
  //   (不是别名)。只注入 `_isShushuContext` 的话, 注入进来的函数体里
  //   `isShushuContext` 未定义 ⇒ ReferenceError ⇒ 整档在测试里抛异常,
  //   看起来像「断言写错」, 其实是**装载器把函数搬到没有依赖的作用域里**。
  //   线上没这个问题 (两个函数在同一模块里), 只有装载器搬源码时才有。
  //   ⇒ 注入**模块里的真名** + **线上用的别名**, 两者都给出。
  `const isShushuContext = ${GATE.isShushuContext.toString()};`,
  `const _isShushuContext = isShushuContext;`,
  `const isConcreteTargetTask = ${GATE.isConcreteTargetTask.toString()};`,
  `const _isConcreteTargetTask = isConcreteTargetTask;`,
  // 2026-10-26 第 105 批: 纯闲聊的概念判据 isPureChat。
  //   它体内引用四个名字, **一个都不能少**, 少一个就是 ReferenceError:
  //     PURE_CHAT_KWS / PURE_CHAT_CONCEPT_RES  (本模块的词表)
  //     isGuaCastRequest                       (本模块的函数)
  //     isSelfIntroAsk                         (answer_alignment.js 的真源 ——
  //                                            第 104 批刚把它的「插字就漏」修好)
  `const PURE_CHAT_CONCEPT_RES = ${JSON.stringify(GATE.PURE_CHAT_CONCEPT_RES.map((r) => r.source))}.map(s => new RegExp(s));`,
  `const isGuaCastRequest = ${GATE.isGuaCastRequest.toString()};`,
  `const isSelfIntroAsk = require('./modules/answer_alignment').isSelfIntroAsk;`,
  `const isPureChat = ${GATE.isPureChat.toString()};`,
  `const _isPureChat = isPureChat;`,
].join('\n');

/** 从 pangu-single.js 抽一个函数定义 */
function fnSource(name) {
  const at = SINGLE.indexOf('function ' + name + '(');
  assert.ok(at > 0, 'pangu-single.js 里找不到 ' + name);
  return sliceBalanced(SINGLE, at);
}

// 闸门内部按相对路径找模块 ⇒ 基准必须是 pangu-single.js 本身
const coreRequire = require('node:module').createRequire(SINGLE_PATH);

/** 造一个能求值的函数: 注入词表 + 贴上函数体 */
function makeFn(name) {
  const src = PRELUDE + '\n' + fnSource(name) + '\n; return ' + name + ';';
  // eslint-disable-next-line no-new-func
  return new Function('require', src)(coreRequire);
}

let _cast = null;
let _dispatch = null;

/** 起卦门 (_shouldCastGua) */
function shouldCastGua() {
  if (!_cast) _cast = makeFn('_shouldCastGua');
  return _cast;
}

/** dispatcher 门 (_shouldUseDispatcher) */
function shouldUseDispatcher() {
  if (!_dispatch) _dispatch = makeFn('_shouldUseDispatcher');
  return _dispatch;
}

/** 卦资料查询判定 (_isGuaFactLookup) —— 直接用模块里那份 */
function isGuaFactLookup() {
  return GATE.isGuaFactLookup;
}

module.exports = {
  SINGLE,
  SINGLE_PATH,
  GATE,
  ALIAS,
  sliceBalanced,
  shouldCastGua,
  shouldUseDispatcher,
  isGuaFactLookup,
};
