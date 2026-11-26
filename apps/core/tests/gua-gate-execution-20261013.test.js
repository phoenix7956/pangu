'use strict';
// 2026-10-13 现场 (session longwork-1791848550, 40 文件长任务):
//   活儿干得完全正确 —— 探针自核 40/40 存在且非空, 最终答案也写的是
//   「目录存在, f00-f39 共40个文件, 无缺失」。
//   答案开头第一句却是: 「大壮初九"征凶有孚"提示不宜抢进；转恒则要求持续、平稳推进。」
//   答案中间还有一整段「按大壮初九「壮于趾, 征凶有孚」定调」和「**卦断**:…」。
//
//   这直接违反 pangu-single.js 自己写的 system prompt 第 1 条:
//     「回答的第一段必须是已核实的事实/结论」, 第 2 条:
//     「用户消息里没有【盘古起卦】块 = 取数/执行类问题 —— 绝对不要写"卦象定调"」。
//   取证: 该会话 messages[9] 是主人原话, messages[10] 是被注入的 user 消息,
//   开头挂着【盘古起卦 · 大壮 ䷡】, 后面才是主人的原话 —— 卦块确实进了会话。
//
// 根因 (两个独立缺陷, 叠在一起才必然发生):
//   ① pangu_agent_stream.js:85 写的是 `_shouldCastGua || _shouldUseDispatcher`,
//      而 pangu-single 把两张表都接进了 deps → 兜底分支永远不触发 → 实际语义是
//      「只要走 dispatcher 就一定起卦」。紧挨着的注释却写着"起卦不再跟着 dispatcher 走"。
//      注释和代码相反, 说明 2026-10-09 那次没改干净。
//   ② _shouldCastGua 里"执行/操作"类只有 打开/运行/执行/帮我做 4 个词,
//      而 DISPATCHER_KWS 里用来**触发分派**的执行动词 写/创建/生成/改/编辑/跑
//      一个都没进抑制表 —— 同一个词在两张表里给出相反判定, 执行类必然起卦。
//
// 修法: ①兜底改成真兜底(新判定接了就由它说了算); ②起卦判定重排成四段,
// 谋断优先 —— 纯闲聊→不起卦 / 谋断显式→起卦 / 取数或执行→不起卦 / 都不像→起卦。
// 谋断放最前是不砍老板 2026-08-02「卦先于人」的核心场景; 最后一档仍返回 true,
// 因为白名单永远漏词, 漏了要往"起卦"那边倒。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SINGLE = fs.readFileSync(path.join(__dirname, '../pangu-single.js'), 'utf8');
const STREAM = fs.readFileSync(path.join(__dirname, '../modules/pangu_agent_stream.js'), 'utf8');
const stripComments = s => s.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

// 不能 require('../pangu-single') —— 它 main() 里会 listen(18901), 端口在用就 EADDRINUSE
// 退出, 还会在 /tmp/pangu-single.err 里刷崩溃日志(实测踩过)。只抽源码求值。
// 2026-10-23 第 58 批: 词表搬去了 modules/gua_gate_kws.js (唯一真源),
// 原先在这里「从 pangu-single.js 源码文本里切一段求值」取词表的方式已经切不到了
// (indexOf('const _GUA_SUPPRESS_KWS') = -1 ⇒ 整链在第一个失败文件就断)。
// 现在统一走 tests/helpers/gua_gate_load.js: 词表从唯一真源取, 判定函数仍从
// pangu-single.js 抽 —— 与线上跑的是同一份词表。
const { shouldCastGua, shouldUseDispatcher } = require('./helpers/gua_gate_load.js');
function loadShouldCastGua() {
  return shouldCastGua();
}

// 现场原话 (longwork-1791848550 messages[9]), 一个字没改
const PROBE_INPUT = '请在 /tmp/pangu_long/ 目录下创建 40 个文件 f00.txt 到 f39.txt，' +
  '每个文件内容是各自的编号加中文：文件 i 内容为「第 i 号专属文本-」后面接 5 个不同的中文词。' +
  '必须逐个真实写入，不许合并成一条命令一次写完（我需要看到每份单独落盘）。' +
  '全部写完后核对每个文件存在且非空，然后调 task_done 收口。';

test('现场: 纯执行任务(创建 40 个文件)不得起卦', () => {
  assert.equal(loadShouldCastGua()(PROBE_INPUT), false,
    '给纯执行任务起卦 = 把卦象盖在事实结论前面, 直接违反 system prompt 第 1/2 条');
});

test('四段判定语料 (闲聊/谋断/取数/执行 各一组, 兜底仍起卦)', () => {
  const cast = loadShouldCastGua();
  const CASES = [
    // 执行类 → 不起卦
    [PROBE_INPUT, false], ['写一份周报', false], ['删掉 /tmp/x 里所有测试文件', false],
    ['把 40 个文件都重命名为 g00-g39', false], ['运行一下这个脚本', false],
    ['截个图给我', false], ['把这段话翻译成英文写进 notes.md', false],
    // 取数类 → 不起卦 (2026-10-09 老板定的方向, 不得回归)
    ['帮我查一下成交量', false], ['看看桌面有哪些文件', false],
    // 闲聊 → 不起卦 (2026-10-13 新增: 以前"你好"不命中任何抑制词 → 照样起卦)
    ['你好', false], ['在吗', false],
    // 谋断类 → 起卦 (老板 2026-08-02「卦先于人」的核心场景, 不得被削掉)
    ['这个项目该不该继续做', true], ['帮我分析下风险', true], ['该怎么做这个决策', true],
    ['这条路值不值得走', true], ['建议保留还是砍掉', true],
    // 谋断优先于执行: 同一句里既有决策又有落盘
    ['这个项目该不该继续做，做的话帮我写成方案', true],
    // 兜底仍起卦
    ['随便聊聊', true],
    // 空输入
    ['', false],
  ];
  for (const [input, expect] of CASES) {
    assert.equal(cast(input), expect, `起卦判定错了: 「${input}」期望 ${expect}`);
  }
});

test('起卦门和 dispatcher 门必须共用同一份闲聊白名单 (两处各写一份必然漂移)', () => {
  // 2026-10-26 (第 105 批): 闲聊判据从「字面 includes 白名单」升级成**概念判据**,
  //   住在 modules/gua_gate_kws.js 的 isPureChat (唯一真源)。
  //   本条的**意图**没变: 两门必须共用同一份判据, 不许各写一份。
  //   判据升级后「共用」的形态从「共用一张词表」变成「共用一个函数」——
  //   这比原来更强: 词表共用还可能各自加工, 函数共用就是**逐位同一份**。
  const gate = require('../modules/gua_gate_kws.js');
  assert.equal(typeof gate.isPureChat, 'function',
    'modules/gua_gate_kws.js 没导出 isPureChat (唯一真源丢了)');
  // 起卦门里必须调它
  const body = SINGLE.slice(SINGLE.indexOf('function _shouldCastGua'), SINGLE.indexOf('function _shouldUseDispatcher'));
  assert.match(body, /_isPureChat\(/, '起卦门没判闲聊');
  // dispatcher 门里必须调**同一个**函数
  const dispBody = SINGLE.slice(SINGLE.indexOf('function _shouldUseDispatcher'));
  assert.match(dispBody, /_isPureChat\(/, 'dispatcher 门没判闲聊');
  // ⚠ 反向: pangu-single.js 里**不许**再出现本地副本的闲聊判定
  assert.doesNotMatch(stripComments(SINGLE), /const PURE_CHAT = _PURE_CHAT_KWS;/,
    'dispatcher 门又在本地抄了一份闲聊表 (词表共用已被「共用同一个函数」取代)');
  // 行为: 同一句话, 两门对「是不是闲聊」的判断必须一致
  const cast = loadShouldCastGua();
  const dispatch = shouldUseDispatcher();
  for (const s of ['你好', '你到底是谁', '在不在', '说说你自己']) {
    assert.equal(cast(s), false, `起卦门把闲聊判成了起卦: ${s}`);
    assert.equal(dispatch(s), false, `dispatcher 门把闲聊判成了编排: ${s}`);
  }
});

// 这条是 ① 的核心: 注释写着"起卦不再跟着 dispatcher 走", 代码却用 || 跟着走。
// 光断言注释没用 —— 断言**实际取到的函数**: deps 接了新判定时, 决定权必须在新判定手上。
test('兜底必须是真兜底: deps 接了 _shouldCastGua 就由它说了算, 不再 OR 上 dispatcher', () => {
  const m = /const _guaGate = ([\s\S]*?);\n/.exec(STREAM);
  assert.ok(m, '找不到 _guaGate 赋值');
  const expr = m[1];
  assert.doesNotMatch(expr, /^\s*_deps\._shouldCastGua\s*\|\|/,
    '仍是 `||`: 两张表都接进 deps 时兜底永不触发, 等于"走 dispatcher 就起卦"');
  // 行为断言: 构造一份 deps, 看 gate 实际选中谁
  // 注意 _guaGate 拿到的是**函数本身**, 调用发生在后面 `_guaGate(userInput)` ——
  // 所以这里要验"选中了谁", 不能直接当布尔值比。
  const pick = deps => {
    const _deps = deps;
    // eslint-disable-next-line no-eval
    return eval(expr);
  };
  assert.equal(pick({ _shouldCastGua: () => 'NEW', _shouldUseDispatcher: () => 'OLD' })('任意输入'),
    'NEW', 'deps 接了新判定, 决定权必须在新判定手上, 不能 OR 上 dispatcher');
  assert.equal(pick({ _shouldUseDispatcher: () => 'OLD' })('任意输入'),
    'OLD', '老 deps 没接新判定时才回退到 dispatcher');
  assert.equal(pick({ _shouldCastGua: () => true, _shouldUseDispatcher: () => false })('任意输入'),
    true, '新判定说起卦而 dispatcher 不走时, 仍按新判定(起卦) —— 反向也要锁');
});

test('_shouldUseDispatcher 行为未因白名单上提而改变', () => {
  const dispatch = shouldUseDispatcher();
  assert.equal(dispatch('你好'), false, '闲聊仍走 legacy');
  assert.equal(dispatch('帮我查一下成交量'), true, '带 dispatcher 关键词的仍走 dispatcher');
  assert.equal(dispatch('随便说点什么'), true, '未知输入仍保守走 dispatcher');
});
