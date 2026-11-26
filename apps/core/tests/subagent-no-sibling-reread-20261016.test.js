// 2026-10-16 一刀一个文件 —— 下游不许把上游读过的源文件再读一遍
//
// 现场 lt-p2-220303 (云端 minimax-m3.1-flash, 本机 129 工具盘古):
// 主人点三个文件各要一份分析 + 汇总。实测总耗时 250.6s, 时间账是:
//   3×analyzer 并行 128s → checker(兑) 102s → dispatcher(乾) 合成 19s
// 兑那一刀的任务文本是 planner 自己写的:「综合复核三个独立报告**及 compaction.js、
// checkpoint.js、handoff.js**」—— 于是兑真去把三个文件各重读了 4 遍。
// 12 次文件读取里 9 次是纯重复劳动, 102s = 全程的 41%。
// 收口还反手报 `partial / success: false`, 主人看到的是"跑了两分半钟, 失败了"。
//
// 根因不在兑不听话 —— planner 的拆解铁律里只有"上游**产出文件**时下游按路径读",
// 缺了另一半"上游只是**读文件得结论**时下游只许读汇报"。兑照着任务文本执行,
// 任务文本是 planner 给的, planner 没被禁止这么写。
//
// 所以这道护栏钉的是**运行时真正送进模型的 ROLES 提示词** (`sub-agent.js` 的
// `ROLES[mode].system`, run() 第 998/1091 行取的就是它), 不是源文件里的一段注释 ——
// 注释被删了测试要红, 提示词被绕过测试也要红。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');

const { ROLES } = require('../agents/sub-agent');
const { _answerAdmitsIncomplete, _acceptanceOverridesAdmission } = require('../modules/j2_dispatcher');
const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('T1 planner 拆解铁律里有"上游只读文件得结论时, 下游不许重读"', () => {
  const p = ROLES.kan.system;
  assert.match(p, /严禁把上游读过的源文件再读一遍/,
    'planner 必须被禁止把已读过的源文件塞进下游 (验收/综合) 的任务里');
});

test('T2 checker 自己那份提示词也带着同一条 —— 双侧夹住, 不靠单边自觉', () => {
  const c = ROLES.dui.system;
  assert.match(c, /默认不许重读兄弟读过的源文件/,
    'checker 必须知道证据是兄弟的汇报, 不是"把人家的活重做一遍"');
});

test('T3 规则钉死了对象: 证据源必须是汇报契约的四行', () => {
  // 只写"别重读"而不说"拿什么替代", 模型会自己找补 —— 那就等于没约束。
  for (const [name, prompt] of [['planner', ROLES.kan.system], ['checker', ROLES.dui.system]]) {
    assert.match(prompt, /①完成.*②证据.*③未做.*④交接/s,
      `${name} 的提示词必须点名汇报契约四行, 告诉模型"拿什么替代重读"`);
  }
});

test('T4 留了窄口但只有窄口 —— 逐字核对 / 存疑项 仍能重读, 否则守卫会反噬', () => {
  // 规则一刀切掉重读能力会误伤真验收: 主人的逐字规格要字节级核对时必须能读原文。
  assert.match(ROLES.dui.system, /逐字规格.*字节级核对|字节级核对.*逐字规格/s);
  assert.match(ROLES.dui.system, /未做\/存疑|未做.*存疑/s);
});

test('T5 差异性质: 把两条规则从提示词里挖掉, 测试必须转红', () => {
  // 护栏不能反查 git HEAD (会被 rebase / 换基线骗过), 只能拿"去掉规则后的副本"
  // 做差分: 挖掉之后正则必须匹不到 —— 证明这两条测试真的在测这条规则。
  const stripped = ROLES.dui.system
    .replace(/^- \*\*验收兄弟的活时[^\n]*\n/m, '');
  assert.doesNotMatch(stripped, /默认不许重读兄弟读过的源文件/,
    '拔掉 checker 那条规则后不该还能匹配上 —— 否则 T2 是假阳性');

  const strippedPlanner = ROLES.kan.system
    .replace(/^- \*\*上游只是"读文件得结论"[^\n]*\n/m, '');
  assert.doesNotMatch(strippedPlanner, /严禁把上游读过的源文件再读一遍/,
    '拔掉 planner 那条规则后不该还能匹配上 —— 否则 T1 是假阳性');
});

test('T6 铁律在运行时路径上, 不是写在没人读的注释里', () => {
  // run() 取的是 ROLES[mode].system (第 998 行 role, 第 1091 行 _sysRole);
  // parsePlan 的 planner 分支直接拼 ROLES.kan.system (第 1712 行)。
  // 提示词对象改了但这两个取法断了, 规则就等于没上线 —— 所以钉住取法本身。
  const src = SRC('agents/sub-agent.js');
  assert.match(src, /const role = ROLES\[mode\] \|\| ROLES\.kun;/,
    'run() 必须按 mode 取 ROLES 的提示词');
  assert.match(src, /let _sysRole = role\.system;/,
    'run() 必须真的用 role.system 当系统提示词, 不能取了不用');
  assert.match(src, /ROLES\.kan\.system/,
    'planner 分支必须直接用 ROLES.kan.system');
});

// ---------------------------------------------------------------------------
// 收口闸门: 上面那条"只读自己那一个文件"的铁律, 上线当天就把长任务判成了失败。
//
// 现场 lt-after-221121 (改造后第一次跑, 云端 minimax-m3.1-flash):
//   3×离 各读完自己那一个文件并如实汇报 → 兑只读汇报 (38.5s, 改前重读源文件 102s)
//   → 兑判 PASS → 乾合成。250.6s → 220.3s, 刀数没变但每刀都不再重复劳动。
//   收口: `partial / success:false`。
//
// 原因不在兑, 在闸门: 每个离的汇报里都有汇报契约要求的「③ 未做」栏 ——
// "未执行相关测试 / 未读兄弟的文件(按指令不扩展)" —— 而 _INCOMPLETE_ADMISSION_RE
// 认「未执行」「未创建」这些裸子词。**分工范围内没做 ≠ 任务没做完**,
// 分工制下那栏必然非空, 子 agent 干得越规矩越容易被判失败。
// ---------------------------------------------------------------------------

test('T7 前提: 离的「③ 未做」确实会触发自认未完成 —— 这道题不能被"改没了"糊过去', () => {
  // 如果哪天闸门不再认这些词, T8~T10 就变成空转的安全网。这条钉住前提。
  assert.strictEqual(
    _answerAdmitsIncomplete('③ 未做: 未执行 compaction 相关测试验证 (按指令不扩展)'),
    true,
    '前提: 免责从句现在仍会被扫成自认未完成 —— 所以必须在判定层解决, 不能靠把正则改松');
});

test('T8 验收刀 PASS 时, 免责从句无权把整轮判成失败', () => {
  const results = [
    { agent: 'analyzer', result: { runtimeStatus: 'completed' } },
    { agent: 'analyzer', result: { runtimeStatus: 'completed' } },
    { agent: 'analyzer', result: { runtimeStatus: 'completed' } },
    { agent: 'checker', result: { runtimeStatus: 'completed' } },
  ];
  assert.strictEqual(_acceptanceOverridesAdmission(results, false, false), true,
    '四刀全交卷 + 兑 PASS → 口径归兑, 答案里的免责从句不算缺口');
});

test('T9 长任务那道真缺口一步都不许松', () => {
  // 边界比"兑 PASS 就放行"重要: 兑 FAIL、兑没跑出结论、压根没排验收刀 ——
  // 三种情况都必须保持"自认未完成 → partial", 否则这道闸门就成了摆设。
  const cks = [{ agent: 'checker', result: { runtimeStatus: 'completed' } }];
  assert.strictEqual(_acceptanceOverridesAdmission(cks, true, false), false,
    '兑判 FAIL → 免责从句照旧能推翻它');
  assert.strictEqual(_acceptanceOverridesAdmission(cks, false, true), false,
    '兑没给出结论 (unknown) → 不得当成通过');
  assert.strictEqual(_acceptanceOverridesAdmission([{ agent: 'analyzer' }], false, false), false,
    '没排验收刀 → 保持原语义, 自认未完成照样标 partial');
  assert.strictEqual(_acceptanceOverridesAdmission([], false, false), false,
    '空结果不许被当成"有验收刀"');
  assert.strictEqual(_acceptanceOverridesAdmission(null, false, false), false,
    'results 传 null 不许崩, 也不许放行');
});

test('T10 差异性质: 收口真的用了这个判定, 不是定义了却没接线', () => {
  const src = SRC('modules/j2_dispatcher.js');
  assert.match(src, /const _notComplete = _acceptanceFailed \|\| _admitsFinal \|\| _unknownAcceptance;/,
    '收口必须用打过折的 _admitsFinal, 而不是原始 _admits');
  assert.doesNotMatch(src, /const _notComplete = _acceptanceFailed \|\| _admits \|\| _unknownAcceptance;/,
    '旧的裸 _admits 判定不许复活 —— 那样这道修正等于没做');
});

// ---------------------------------------------------------------------------
// 上面那条"只读汇报"的铁律, 上线当天造出了第二个反效果: 兑被推成了纯总结。
// 现场 lt-after-221727: 兑交了一份很完整的"三个状态模块统一汇总"(表格 + 风险排序 +
// 卦象视角), 但通篇**没有一句 PASS/FAIL** → _verdictOfChecker 判 unknown →
// _unknownAcceptance 置真 → 收口照样 partial。少写裁决这一句, 前面那个修正白做。
// 兑的活是**两件**: 不重读源文件 + 下明确裁决。只做到前一半等于没验收。
// ---------------------------------------------------------------------------

test('T11 checker 提示词要求"最后一行给裁决"', () => {
  assert.match(ROLES.dui.system, /验收结论/,
    'checker 必须被要求写出明确的 PASS/FAIL 裁决');
  assert.match(ROLES.dui.system, /没下裁决就等于没验收|不给裁决|没给出结论/s,
    '要点明"只汇总不裁决 = 没验收"这个后果, 不然模型会当成可选项');
});

test('T12 planner 排验收刀时必须把裁决写进 task', () => {
  assert.match(ROLES.kan.system, /验收结论/,
    'planner 必须在验收刀的 task 里要求裁决 —— 任务文本才是兑真正收到的东西');
  assert.match(ROLES.kan.system, /不许只让它"汇总"/,
    '"排了 checker 就要它下裁决, 不能只让它汇总"这条铁律必须在场');
});

test('T13 裁决格式与 _verdictOfChecker 真认得的格式对得上', () => {
  // 提示词里写什么格式, 收口就得认什么格式。两边对不上 = 兑白写一句。
  const { _verdictOfChecker } = require('../modules/j2_dispatcher');
  assert.strictEqual(_verdictOfChecker('验收结论: PASS'), 'pass');
  assert.strictEqual(_verdictOfChecker('**验收结论: PASS**'), 'pass',
    '模型爱加 markdown 强调, 收口必须照样认');
  assert.strictEqual(_verdictOfChecker('验收结论：FAIL（依据：离的汇报未覆盖全部文件）'), 'fail',
    '中文冒号 + 依据后缀也要认');
  // 兜底语义钉死: 整段扫不到失败词 → pass; 空摘要 / 死切片 → unknown。
  // 现场查死因时在这两条上绕了很久, 这里固定住, 下次不用重新推。
  assert.strictEqual(_verdictOfChecker('三个文件分析完毕，无异议'), 'pass',
    '兜底③是"扫不到失败词即 pass", 不是 unknown —— 别再猜成 unknown');
  assert.strictEqual(_verdictOfChecker(''), 'unknown', '空摘要必须 unknown');
  assert.strictEqual(_verdictOfChecker('ECONNRESET，这一刀压根没跑起来'), 'unknown',
    '死掉的切片必须 unknown —— "没验"不许当成"验过了"');
});

test('T14 收口判 partial 时必须留下死因, 不能一声不吭', () => {
  // 现场 lt-after-221727: 日志里三条收口标志的 warning 一条都没打, 只见
  // success:false, 死因无从查证 (_unknownAcceptance 当时完全静默)。
  const src = SRC('modules/j2_dispatcher.js');
  assert.match(src, /\[dispatcher\] 收口 partial: acceptance_failed=/,
    '收口标 partial 必须打出三个标志位 + 验收刀原文');
  assert.match(src, /unknown_acceptance=/,
    '必须包含 unknown_acceptance 这个此前完全静默的标志');
});
