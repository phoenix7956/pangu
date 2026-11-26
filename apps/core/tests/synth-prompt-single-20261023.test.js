'use strict';
/**
 * 第 63 批 —— 综合(synthesis)提示词必须是**唯一真源**。
 *
 * ## 起因
 *
 * `j2_dispatcher.js` 里综合 system prompt 曾经有 **4 份**:
 * `_buildSynthesisMessages` + 3 处内联。量下来不是「措辞略有出入」, 是**互相矛盾**:
 *
 *   3 份内联: 【铁律】…**必须先以卦象定调**, 再展开现实策略
 *   _buildSynthesisMessages: 【铁律·回答顺序】**第一段先给已核实的事实/结论**
 *
 * 而 `global_agent_rules.js` 规则 #19(真被注入)裁定的正是后者,
 * 并且明写 ❌ **禁止拿卦象开篇**(2026-10-21 现场真账:
 * 「第24卦是哪一卦」的答案第一行写的是卦象评语, 事实反而排在后面)。
 * ⇒ 4 条路径里有 3 条正在让模型做主人明令禁止的那件事。
 *
 * ## 为什么它藏了这么久 —— 本项目最贵的一次假绿
 *
 * `gua-fact-lookup-20261021.test.js` 里有一条测试, 名字就叫
 * 「dispatcher 综合提示词: 事实/结论在前, 卦象在后 (不再强制"先以卦象定调")」。
 * 它只调 `_buildSynthesisMessages` —— 也就是 10-21 修过的那**一份**。
 * 另外 3 份一眼没看。**修了 1/4, 测试只验那 1/4, 全绿。**
 *
 * 所以本文件的核心判据不是「某一条路径对不对」, 而是
 * **「所有综合提示词拼装点都来自真源」** —— 把"挨个记得检查"换成机制。
 *
 * ## 读源码的两条纪律 (本项目反复踩)
 *
 * ① 剥注释再判: 判据句本身会出现在解释性注释里, 不剥就会自己把自己判成违规。
 * ② 扫源码只能证「接了线」, 证不了「线上跑的是什么」——
 *    所以每条扫源码的断言都要有一条真调函数的断言配着 (见 T1/T5)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const CORE = path.join(__dirname, '..');
const DISPATCHER_PATH = path.join(CORE, 'modules', 'j2_dispatcher.js');
const SOURCE_PATH = path.join(CORE, 'modules', 'synth_prompt.js');

const { buildSynthesisSystemPrompt, RULES } = require('../modules/synth_prompt');
const DISPATCHER = require('../modules/j2_dispatcher');

function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
}

// 这两句是「综合提示词抄本」的指纹。四份抄本都带它们, 收成真源后应当**只**在真源里出现。
const FINGERPRINTS = [
  '以易经为核心推理的谋断 agent',
  '综合成一份完整、结构化、直接回答主人问题',
];

/**
 * 全库 js 文件 —— 只扫**生产代码**。
 *
 * 跳过 `tests/`: 测试按定义要引用被断言的原文 (断言里写「不许出现 X」就必须写出 X),
 * 变异脚本更是**必须**存着改前的文案才能把它打回去。
 * 把测试算进来会让这条判据恒失败, 而恒失败的断言等于没有断言。
 * 这不是放水: 抄本活在生产代码里才会影响模型, 活在测试里只影响这道断言自己。
 */
function repoJsFiles() {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '.git') continue;
      if (ent.name === 'tests') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, depth + 1);
      else if (ent.name.endsWith('.js')) out.push(p);
    }
  };
  walk(path.join(CORE, '..'), 0);
  return out;
}

// ===========================================================================
// T1 真源本身: 五条规则齐全, 且不再说「卦象定调」 (真调, 不是扫源码)
// ===========================================================================

test('T1 真源: 五条规则齐全, 一条不缺', () => {
  const want = ['LENGTH_RULE', 'ORDER_RULE', 'RECONCILE_RULE', 'NO_TOOL_RULE', 'TIMING_RULE'];
  for (const k of want) {
    assert.ok(typeof RULES[k] === 'string' && RULES[k].length > 10,
      `真源缺规则 ${k} —— 四条路径共用它, 少一条就是四条一起少`);
  }
  const out = buildSynthesisSystemPrompt();
  for (const k of want) {
    assert.ok(out.includes(RULES[k]), `真源产物里没有 ${k}`);
  }
});

test('T2 真源: 不再强制「卦象定调」开篇 (老板 10-21 现场真账)', () => {
  const out = buildSynthesisSystemPrompt();
  assert.ok(!/必须先以卦象定调/.test(out), '真源还在强制"先以卦象定调"');
  assert.ok(!/卦象定调/.test(out), '"卦象定调"这四个字整体不该再出现 —— 实跑过模型把它当答案开篇标签');
});

test('T3 真源: 事实在前 + 用卦 ≠ 用卦开头 (与规则 #19 逐条对齐)', () => {
  assert.ok(/第一段先给已核实的事实\/结论/.test(RULES.ORDER_RULE),
    'ORDER_RULE 必须写明第一段先给事实/结论 (2026-10-09 老板定)');
  assert.ok(/用卦 ≠ 用卦开头/.test(RULES.ORDER_RULE),
    'ORDER_RULE 必须说清"用卦 ≠ 用卦开头"');
  // 卦块仍然必须在、真卦辞爻辞仍然必须引 —— 这是 10-09 裁定的另一半,
 // 收口时别只留「事实在前」把「用卦」丢了 (那就是另一种回归)。
  assert.ok(/卦块必须在/.test(RULES.ORDER_RULE), '不许把卦块从硬约束降级成可选');
  assert.ok(/真卦辞爻辞必须引/.test(RULES.ORDER_RULE), '不许丢掉「必须引真原文」');
});

test('T4 真源: 与 global_agent_rules.js 规则 #19 不打架 (同一把尺子)', () => {
  const rulesSrc = stripComments(
    fs.readFileSync(path.join(CORE, 'modules', 'global_agent_rules.js'), 'utf8'));
  assert.ok(/第一段先给已核实的事实\/结论/.test(rulesSrc),
    '规则 #19 应写明第一段先给事实 (取不到就是规则文件被挪走了)');
  assert.ok(/用卦 ≠ 用卦开头/.test(rulesSrc), '规则 #19 应说清"用卦 ≠ 用卦开头"');
  // 真源不得引入规则 #19 没有的相反口径。
  assert.ok(!/必须先以卦象定调/.test(rulesSrc + buildSynthesisSystemPrompt()),
    '规则文件与真源合起来出现了"必须先以卦象定调" —— 两边又打架了');
});

test('T5 真源: noRoleLabel 显式传空串时不加输出形态段 (传空是刻意的, 不是漏了)', () => {
  const withLabel = buildSynthesisSystemPrompt({ noRoleLabel: '【输出形态】X' });
  assert.ok(withLabel.includes('【输出形态】X'), '给了 label 就该拼进去');
  assert.ok(!buildSynthesisSystemPrompt().includes('X'), '不给 label 就不该凭空长出 label');
  // L1597/L1848/L2019 原来是把 _SYNTH_NO_ROLE_LABEL **拼进同一条** system 消息,
  // _buildSynthesisMessages 原来它是**第二条** system 消息 ——
  // 收口后前者走 noRoleLabel, 后者靠原生双消息结构, 两种形态都得对。
  assert.ok(buildSynthesisSystemPrompt({ noRoleLabel: '' }) === buildSynthesisSystemPrompt(),
    '空串 label 应与不传等价 (空串是「不要这一段」, 不是「拼个空串进去」)');
});

// ===========================================================================
// T6 覆盖率 —— 本文件最核心的一条: 4 个拼装点全部来自真源
// ===========================================================================

test('T6 dispatcher 的综合提示词只拼一次, 四条路径全部走这一个拼装点 (覆盖率判据)', () => {
  const code = stripComments(fs.readFileSync(DISPATCHER_PATH, 'utf8'));
  // 抄本指纹在 dispatcher 里应当 0 次 —— 只要有人把内联文案抄回来就咬住。
  for (const fp of FINGERPRINTS) {
    assert.ok(!code.includes(fp),
      `dispatcher 里还留着综合提示词抄本指纹「${fp}」 —— 内联文案被抄回来了`);
  }
  //
  // 第 89 批 (2026-10-25): 判据从「数调用点」换成「钉唯一拼装点」。
  //
  // 为什么旧判据不够 (这是 10-25 实跑撞出来的, 不是洁癖):
  //   旧判据是「恰好 3 个调用点」—— 它钉的是**抄本份数**, 而「抄本有几份」跟
  //   「每条路径有没有拿到」根本不是一回事。现场就是 3 个调用点全绿,
  //   但禁令有**两种挂法** (主路两条独立 system 消息 / 兜底路合并成一条),
  //   每条路径单独看都通得过, 只有把四条路并排走一遍才发现其中一条会静默少拿一句。
  //   ⇒ 「数份数」的判据天生看不见「挂法分叉」。
  //
  // 新判据钉的是**机制**: 真源在 dispatcher 里只被调 1 次, 且那 1 次就在
  //   唯一拼装点 `_synthesisSystemMessages` 里, 而每条综合路径都经由它取 system 消息。
  //   这比旧判据**更强**: 旧判据允许「3 处各拼各的但长得一样」, 新判据不允许挂法分叉。
  const calls = code.match(/buildSynthesisSystemPrompt\s*\(/g) || [];
  assert.strictEqual(calls.length, 1,
    `dispatcher 里真源只许被调 1 次 (唯一拼装点), 实际 ${calls.length} 次 —— `
    + '有路径自己拼了提示词, 或真源被绕开');
  // 那唯一一次必须**在拼装点里** —— 「整个文件里恰好有一次」还不够。
  const asmIdx = code.indexOf('function _synthesisSystemMessages(');
  assert.ok(asmIdx > 0, '找不到唯一拼装点 _synthesisSystemMessages —— 拼装点被改名或删了');
  const asmEnd = code.indexOf('\nfunction ', asmIdx + 1);
  const asmBody = code.slice(asmIdx, asmEnd > 0 ? asmEnd : code.length);
  assert.ok(/buildSynthesisSystemPrompt\s*\(/.test(asmBody),
    '唯一那一次真源调用不在拼装点里 —— 拼装点是空的, 或者真源调用被搬走了');
  // 拼装点之外, 综合层的 system 消息不许自拼。
  //   这条是为了堵「人数守恒」那个洞: 光数「有几处展开调用」看不见**新加**的路径,
  //   新路径完全可以自己拼一份 (M12 那种变异) 而数量不变。
  const synthSys = code.split('\n').filter((l) => /role:\s*'system'/.test(l)
    && /buildSynthesisSystemPrompt|_SYNTH_NO_ROLE_LABEL/.test(l));
  assert.strictEqual(synthSys.length, 2,
    `综合层的 system 消息只该出现在拼装点里 (2 条: 提示词 + 禁令), 实际 ${synthSys.length} 处 —— `
    + '有路径自己拼了');
  // 四条路径必须**用**这个拼装点 —— 光有拼装点不够, 路径可能各走各的。
  //   (主派发与 fixed_flow 共用 `_buildSynthesisMessages`, 所以按展开调用点核对)
  const users = code.match(/\.\.\._synthesisSystemMessages\s*\(/g) || [];
  assert.ok(users.length >= 2,
    `综合路径没有走拼装点 (展开调用 ${users.length} 处) —— 某条路径自己拼了 system 消息`);
});

test('T7 拼装点产出的两条 system 消息逐字等于真源与禁令常量 (真调 + 结构双钉)', () => {
  const code = stripComments(fs.readFileSync(DISPATCHER_PATH, 'utf8'));
  // 结构那半: 那唯一一次调用必须**就在 system 消息的 content 位**上。
  //   只数调用次数不够: 把它挪进 user 消息、或塞进一个没人用的变量, 次数照样对
  //   (M13 变异专打这个: 调用还在, 但线上已经不是真源了)。
  const re = /\{\s*role:\s*'system',\s*content:\s*buildSynthesisSystemPrompt\s*\(/g;
  const asSystem = (code.match(re) || []).length;
  assert.strictEqual(asSystem, 1,
    `唯一那次真源调用不在 system message 的 content 位 —— 它不是提示词拼装点`);
  // 运行时那半 (真调, 不是扫源码): 拼装点产出什么, 守卫就要求它逐字等于什么。
  const msgs = DISPATCHER._synthesisSystemMessages('第24卦是哪一卦');
  assert.strictEqual(msgs.length, 2, '拼装点应当产出两条 system 消息 (提示词 + 禁令)');
  for (const m of msgs) {
    assert.strictEqual(m.role, 'system', '拼装点产出的必须是 system 消息');
  }
  assert.strictEqual(msgs[0].content, buildSynthesisSystemPrompt(),
    '第一条必须逐字等于真源 (默认档)');
  assert.ok(/禁止把它们.*当标题/.test(msgs[1].content),
    '第二条必须是输出形态禁令 (禁止把将灵代号当标题)');
});

test('T8 全库范围: 综合提示词抄本只允许存在于真源一个文件 (不是只查 dispatcher)', () => {
  // dispatcher 是本批量出来的病灶, 但抄本传统上会长在别处 (runner / 子 agent 兜底)。
  // 只查一个文件就等于重复 10-21 那个「只验修复过的那一份」的错。
  const self = SOURCE_PATH;
  const files = repoJsFiles();
  // 防「扫了 0 个文件还绿」这种空枪 —— 路径写错 / 目录改名都会这样。
  assert.ok(files.length > 50,
    `全库扫到 ${files.length} 个 js 文件, 太少 —— 扫描范围写错了, 这条断言是空枪`);
  assert.ok(files.includes(DISPATCHER_PATH), '连 dispatcher 都没扫到, 扫描范围写错了');
  const offenders = [];
  for (const f of files) {
    if (f === self) continue;
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    const code = stripComments(txt);
    for (const fp of FINGERPRINTS) {
      if (code.includes(fp)) offenders.push(path.relative(CORE, f) + ' :: ' + fp);
    }
  }
  assert.strictEqual(offenders.length, 0,
    '这些文件里还有综合提示词抄本, 收口没收全:\n  ' + offenders.join('\n  '));
});

// ===========================================================================
// T9/T10 真实运行时: dispatcher 导出的那条路径, 拿到的就是真源内容
// ===========================================================================

test('T9 dispatcher 导出的综合消息: system 内容逐字等于真源 (真调, 不是扫源码)', () => {
  const msgs = DISPATCHER._buildSynthesisMessages(
    'nonexistent-session-synth-single-test', '第24卦是哪一卦', '', [], 12000);
  const sys = msgs.filter(m => m.role === 'system').map(m => m.content || '');
  assert.ok(sys.length >= 1, '没拿到 system 消息');
  assert.ok(sys[0] === buildSynthesisSystemPrompt(),
    'dispatcher 交给模型的那条 system 消息与真源不是逐字一致 —— 中间还有加工');
  // 第二条是 _SYNTH_NO_ROLE_LABEL (输出形态禁令), 与真源分开成两条 —— 保留原结构。
  assert.ok(sys.slice(1).some(c => /禁止把它们.*当标题/.test(c)),
    '输出形态禁令段没了 (禁止把 agent: executor 当标题这条是 10-12 实跑加的)');
  // 第 89 批: 再加一条**整体**比对 —— 不是「第一条像真源、第二条像禁令」就算,
  //   而是「这两条**合起来**必须逐字等于唯一拼装点的产物」。
  //   差别: 前者允许拼装点多出一条/少一条而没人发现 (2026-10-25 实跑就是这种分叉),
  //   后者一字节都不许差。
  assert.deepStrictEqual(sys,
    DISPATCHER._synthesisSystemMessages('第24卦是哪一卦').map((m) => m.content),
    '综合路径拿到的 system 消息与唯一拼装点的产物不逐字一致 —— 有路径在挂法上分叉了');
});

test('T10 四条路径都有长度硬约束 —— 由「都走真源」+「真源有该规则」推出', () => {
  // 这条断言**不是**直接去数四条路径各有没有 ≤300 字 —— 那是会漏的写法
  // (新增路径就不在名单里)。真正的原因是结构性的:
  //   T6 保证 4 个拼装点全部来自真源 ⇒ 真源的每条规则对 4 条路径同时生效。
  // 所以「四条路径都有长度约束」= T6 (接线) ∧ 本条 (真源里有)。
  // 少了任一半都不成立: 只做 T6 → 真源把长度规则删了没人发现; 只做本条 → 内联文案照样漏。
  assert.ok(/≤\s*300\s*字/.test(RULES.LENGTH_RULE), '真源里没有长度硬约束 ⇒ 四条路径都没有');
  assert.ok(/300/.test(buildSynthesisSystemPrompt()), '长度硬约束没进最终产物');
  // 10-02 老板拍的是「≤300 字」, 数字不许被悄悄改掉。
  assert.ok(/主人 2026-08-02 拍/.test(RULES.LENGTH_RULE), '长度约束应标明它的来源, 便于日后追溯谁拍的');
});

// ===========================================================================
// T11 负例自检 —— 证明上面那些断言不是恒真
// ===========================================================================

test('T11 负例自检: 本文件的判据真的能咬住东西', () => {
  // 构造一份「回到 10-21 之前」的综合提示词, 逐条断言本文件的判据会失败。
  const bad = '你是 Pangu，以易经为核心推理的谋断 agent。'
    + '综合成一份完整、结构化、直接回答主人问题的最终答案。'
    + '【铁律】主人问题开头若有【盘古起卦】块：最终答案必须先以卦象定调, 再展开现实策略。';

  assert.ok(!/第一段先给已核实的事实\/结论/.test(bad),
    '负例里本该没有「事实在前」—— 有的话这条负例自检无效');
  assert.ok(!/用卦 ≠ 用卦开头/.test(bad), '负例里本该没有「用卦 ≠ 用卦开头」');
  assert.ok(/必须先以卦象定调/.test(bad), '负例该含被禁的措辞, 否则测不出东西');
  for (const fp of FINGERPRINTS) {
    assert.ok(bad.includes(fp), `负例该带指纹「${fp}」, 否则 T6/T8 的扫源码判据是恒真的`);
  }

  // 再验一遍: 把真源换成缺规则的样子, T1 的逐条断言必须失败。
  const broken = {
    ...RULES,
    LENGTH_RULE: '', ORDER_RULE: '', RECONCILE_RULE: '',
    NO_TOOL_RULE: '', TIMING_RULE: '',
  };
  const missing = Object.keys(broken).filter(k => !(broken[k] && broken[k].length > 10));
  assert.strictEqual(missing.length, 5,
    '清空真源后 T1 应该报 5 条缺失 —— 它没报说明 T1 的判据恒真');
});
