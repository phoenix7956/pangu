'use strict';
// 2026-10-25 (第 82 批): **soul 三档** —— main / planner / worker。
//
// ## 为什么多出 planner 这一档
//
// 老板问的是「拆解轮 soul 分档」, 依据是**盘古的真实对话** —— 会话 39268686
// (内部 id desktop-1792839268686)。那份落盘里, 拆解轮 (`#main-plan`) 的 msg0
// 是 18143 字, 而同一轮 [agent-llm] 日志写的是 `tools: 2`。
//
// 也就是说: 拆解轮那一轮**真能调的只有 dispatch_subagents + task_done**,
// 产出上限就是「拆不拆 / 拆几刀 / 每刀干什么」。而它拿的是**完整 main 档 soul**:
//
//   实测块构成 (逐块 token 见 /tmp/pangu-single.log 的 [prompt-profile]):
//     [运行环境 — 路径铁律] 6358   ← 全局铁律 + 自我认知 + 跨会话上下文 + nativeHint + R18
//     基础 soul                3299
//     工具清单                 1875   ← 而它真能调的只有 2 个
//     自我认知                 6964   (在 [运行环境] 那 6358 里)
//     主人长期记忆 / 自我进化 / 源码地图 / 速查 / Harness / 持久目标 …
//   实测那一轮 in=15366 token。
//
// 更糟的是那段「跨会话上下文」: 实测三条**全是兄弟会话**
// (desktop-1792838641545 / #sub-0-li r21 / #sub-0-li r20),
// 那个父 id 在整段里出现 **7 次** —— 那是**别的会话**的兄弟刀 prompt,
// 带着主人全量路径清单。而拆解轮的活恰恰是**把任务切小**:
// 喂它上一刀的原文, 它只会照抄上一轮的切法。
//
// ## 三档的分工
//
//   main    — 主对话, 一字不少 (逐字跟拆分前相同)。
//   planner — 拆解轮。基础 soul + 推理预算 + 当前时间 + 全局铁律 worker 档。
//   worker  — 子 agent, 现状不变。
//
// ⚠ **soulTier 是独立通道, opts.role 一个字都不动** ——
//   role 决定 API schema / 工具白名单 / 只读边界 (gua-identity.isReadOnlyRole);
//   soulTier 只决定「提示词发哪几档」。
//   拆解轮必须继续用 role='main' (否则 enforceToolFilter 不认它, 它能自己动手干活),
//   但提示词不发 main 档。这条分界线是本批的架构要点, 下面有守卫钉它。
//
// ## 现场证据 (会话 39268686, 不是推演)
//
//   拆解轮 msg0 段序实测:
//     [运行环境] 241 → 全局铁律 6988(@241) → 自我认知 6964(@7470)
//     → 跨会话上下文 2390(@14434) → Native Tool Mode 90(@16824) → R18 1229(@16914)
//   planner 的 msg0 里**没有**「你是盘古」「你是 Pangu」身份行 ⇒
//   它的身份来自 dispatcher 自己那条 msg1 (440 字)。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const CORE = path.join(__dirname, '..');
const LC_PATH = path.join(CORE, 'modules', 'llm_caller.js');
const LOOP_PATH = path.join(CORE, 'modules', 'j2_agent_loop.js');
const DISP_PATH = path.join(CORE, 'modules', 'j2_dispatcher.js');
const GAR_PATH = path.join(CORE, 'modules', 'global_agent_rules.js');
const SCHEMA_PATH = path.join(CORE, 'modules', 'dispatch_subagents_schema.js');

const lcSrc = fs.readFileSync(LC_PATH, 'utf8');
const loopSrc = fs.readFileSync(LOOP_PATH, 'utf8');
const dispSrc = fs.readFileSync(DISP_PATH, 'utf8');
const garSrc = fs.readFileSync(GAR_PATH, 'utf8');

const first = (m) => String((m || {}).content || '').trim().split('\n')[0];
const heads = (msgs) => msgs.map(first);
const has = (msgs, re) => msgs.some(m => re.test(first(m)));

// ---------------------------------------------------------------- 环境注入
//
// 守卫必须能打中「块该在 / 不该在」, 所以块必须**稳定存在**。
// 主人长期记忆和 L3 hint 都依赖本机状态 (MEMORY.md / l2 聚合) ——
// 不注入的话, 换台机器这两个块压根不存在, 守卫就成了恒真的空枪。
//
// 注入方式:
//   · 主人长期记忆 —— os.homedir() 在 POSIX 上优先读 $HOME ⇒ 临时 HOME + 写一份 MEMORY.md
//   · L3 hint       —— 打桩 l2-miner.getL2Hint (llm_caller 每次调用都重新取属性)
//
// ⚠ 为什么用「打桩 + 临时 HOME」而不是「改源文件做变异」:
//   变异测试要能跑, 就得让**坏掉的代码**真被加载。这里用 Module._compile 在内存里
//   编译一份坏掉的副本 (filename 仍指向真路径 ⇒ 相对 require 照常解析),
//   **一个字节都不落盘** —— 不污染 modules/ 目录 (那个目录被 strip-regex-desync
//   全仓扫描), 不跟整链并发打架, 也不可能"改到一半忘了还原"。

let _tmpHome = null;
let _origHome = null;
let _origGetL2Hint = null;
let _l2Miner = null;

function withInjectedEnv(fn) {
  _origHome = process.env.HOME;
  _tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-soultier-'));
  fs.mkdirSync(path.join(_tmpHome, '.pangu', 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(_tmpHome, '.pangu', 'memory', 'MEMORY.md'),
    'SOULTIER_TEST_MEMORY_MARKER — 主人长期记忆注入桩\n', 'utf8');
  process.env.HOME = _tmpHome;
  _l2Miner = require(path.join(CORE, 'scripts', 'l2-miner.js'));
  _origGetL2Hint = _l2Miner.getL2Hint;
  _l2Miner.getL2Hint = () => 'SOULTIER_TEST_L3_MARKER — L2 聚合注入桩';
  try {
    return fn();
  } finally {
    if (_origGetL2Hint) _l2Miner.getL2Hint = _origGetL2Hint;
    if (_origHome === undefined) delete process.env.HOME;
    else process.env.HOME = _origHome;
    try { fs.rmSync(_tmpHome, { recursive: true, force: true }); } catch (_) {}
    _tmpHome = null;
  }
}

function initLlc(mod) {
  mod.init({
    _config: { llm: { models: [{}] }, memory: {} },
    fs: require('fs'), path: require('path'), os: require('os'),
    https: require('https'), http: require('http'),
    PRESETS: {}, PANGU_SYSTEM_PROMPT: 'SOUL_BASE',
    _getPromptFacts: () => ({ toolCount: 127, skillCount: 0, skillManifest: '(空)', mcp: { tools: 0, servers: 0 } }),
  });
  return mod;
}

function loadRealLlc() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/pangu/apps/core/modules/llm_caller.js')) delete require.cache[k];
  }
  return initLlc(require('../modules/llm_caller'));
}

// 内存编译一份「坏掉的」llm_caller —— 不落盘, 不污染 modules/ 目录。
function loadMutantLlc(src) {
  const m = new Module(LC_PATH, null);
  m.filename = LC_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(LC_PATH));
  m._compile(src, LC_PATH);
  return initLlc(m.exports);
}

// ---------------------------------------------------------------- 检查器
//
// 检查器返回**问题列表**而不是直接 assert ——
// 这样同一个检查器能同时用在「真模块」(必须空) 和「变异模块」(必须非空) 上。
// 变异测试要证明的是"守卫真的抓得住", 那就得让守卫本身是可调用的。

const MAIN_ONLY_BLOCKS = [
  [/^# 工具清单/, '工具清单 —— 拆解轮真能调的只有 2 个工具, 这块是教它调调不到的'],
  [/^# 主人长期记忆/, '主人长期记忆 —— 拆解轮判的是"切不切", 不需要主人的答复风格偏好'],
  [/^# L3 自适应提示/, 'L3 自适应提示 —— 主 agent 的今日异常聚合'],
  [/^# Pangu 自我进化数据/, '自我进化快照 —— 主 agent 的闭环'],
  [/^# 自身源码地图/, '自身源码地图 —— 拆解轮不读文件'],
  [/^# 连续改进/, 'Continual Harness —— 主 agent 的反馈闭环'],
  [/^# 持久目标/, '持久目标 —— 主 agent 的跨轮目标'],
];

function checkPlanTier(lc) {
  const problems = [];
  const msgs = lc._buildSystemMessages({}, 'planner', ['dispatch_subagents', 'task_done']);
  const h = heads(msgs);
  // 必须有的
  if (!has(msgs, /^SOUL_BASE/)) {
    problems.push('planner 档丢了基础 soul —— 它定义工具调用协议/输出格式, 拿掉风险太大');
  }
  if (!has(msgs, /^# 当前时间 \(权威\)/)) {
    problems.push('planner 档丢了当前时间 —— 它要判"这活能不能切", 时间是判据之一');
  }
  // 必须没有的
  for (const [re, why] of MAIN_ONLY_BLOCKS) {
    if (has(msgs, re)) problems.push(`planner 档不该带 ${re} —— ${why}`);
  }
  // 白名单: 除上面两样 (+ 本地模型的推理预算) 之外不许有别的块
  const ALLOWED = [/^SOUL_BASE/, /^# 当前时间 \(权威\)/, /^\[推理预算/];
  for (const x of h) {
    if (!ALLOWED.some(re => re.test(x))) {
      problems.push(`planner 档出现了白名单外的块: ${x.slice(0, 50)}`);
    }
  }
  // MCP 工具名一个都不许漏进来 (planner 档根本没有工具清单块)
  for (const m of msgs) {
    if (String(m.content || '').includes('mcp__')) {
      problems.push('planner 档漏进了 MCP 工具名 (mcp__…) —— 拆解轮调不到它们');
    }
  }
  return { msgs, problems };
}

function checkWorkerTier(lc) {
  const problems = [];
  const msgs = lc._buildSystemMessages({}, 'worker', ['read_file']);
  if (!has(msgs, /^SOUL_BASE/)) problems.push('worker 档丢了基础 soul');
  if (!has(msgs, /^# 当前时间 \(权威\)/)) problems.push('worker 档丢了当前时间');
  if (!has(msgs, /^# 关键路径速查/)) {
    problems.push('worker 档丢了关键路径速查 —— 子 agent 最需要的就是"别摸路"');
  }
  for (const [re, why] of MAIN_ONLY_BLOCKS) {
    if (has(msgs, re)) problems.push(`worker 档不该带 ${re} —— ${why}`);
  }
  return { msgs, problems };
}

function checkMainTier(lc) {
  const problems = [];
  const msgs = lc._buildSystemMessages({}, 'main', ['dispatch_subagents', 'task_done']);
  // main 一字不少 —— 下面几块是无条件 push 或有注入保证的, 必须都在
  for (const [re, why] of [
    [/^SOUL_BASE/, '基础 soul'],
    [/^# 工具清单/, '工具清单'],
    [/^# 主人长期记忆/, '主人长期记忆 (靠临时 HOME 注入保证存在)'],
    [/^# 自身源码地图/, '自身源码地图'],
    [/^# 关键路径速查/, '关键路径速查'],
    [/^# 当前时间 \(权威\)/, '当前时间'],
  ]) {
    if (!has(msgs, re)) problems.push(`main 档丢了 ${re} —— ${why}`);
  }
  // 默认档必须 ≡ 显式 main (老调用方靠这个默认值)
  const dflt = lc._buildSystemMessages({}, undefined, ['dispatch_subagents', 'task_done']);
  if (JSON.stringify(dflt.map(m => m.content)) !== JSON.stringify(msgs.map(m => m.content))) {
    problems.push('默认档 ≠ 显式 main —— 老调用方 (探测/摘要/主循环) 会拿到不一样的 soul');
  }
  return { msgs, problems };
}

// ================================================================= 行为守卫

test('planner 档只拿它该拿的: 基础 soul + 当前时间, main-only 块一个都不许进', () => {
  withInjectedEnv(() => {
    const lc = loadRealLlc();
    const { problems, msgs } = checkPlanTier(lc);
    assert.deepEqual(problems, [], 'planner 档分档有问题:\n  ' + problems.join('\n  '));
    // 白名单已经保证块集合, 这里再钉一次具体形状, 免得有人"顺手多加一块"
    assert.deepEqual(heads(msgs), ['SOUL_BASE', '# 当前时间 (权威)'],
      'planner 档的块集合变了 —— 现在是: ' + JSON.stringify(heads(msgs)));
  });
});

test('worker 档保持现状: 基础 soul + 关键路径速查 + 当前时间', () => {
  withInjectedEnv(() => {
    const lc = loadRealLlc();
    const { problems, msgs } = checkWorkerTier(lc);
    assert.deepEqual(problems, [], 'worker 档分档有问题:\n  ' + problems.join('\n  '));
    assert.deepEqual(heads(msgs), ['SOUL_BASE', '# 关键路径速查 (别用 search_files 摸路, 直接读)', '# 当前时间 (权威)'],
      'worker 档的块集合变了 —— 现在是: ' + JSON.stringify(heads(msgs)));
  });
});

test('main 档一个字都不能少 (三档里只有它拿全量)', () => {
  withInjectedEnv(() => {
    const lc = loadRealLlc();
    const { problems } = checkMainTier(lc);
    assert.deepEqual(problems, [], 'main 档缺东西:\n  ' + problems.join('\n  '));
  });
});

test('planner 档比 main 档小一个数量级 (省 token 是这层存在的理由)', () => {
  withInjectedEnv(() => {
    const lc = loadRealLlc();
    const p = lc._buildSystemMessages({}, 'planner', ['dispatch_subagents', 'task_done']);
    const m = lc._buildSystemMessages({}, 'main', ['dispatch_subagents', 'task_done']);
    const tok = (msgs) => msgs.reduce((s, x) => s + Math.ceil((String(x.content || '').length + 20) * 0.35), 0);
    const ratio = tok(p) / Math.max(1, tok(m));
    assert.ok(ratio < 0.25,
      `planner/main = ${ratio.toFixed(2)} —— 预期 <0.25, 说明 main 的块还在漏进 planner`);
  });
});

test('全局铁律: planner 复用 worker 白名单, 且不拿「大体量任务必须自拆」', () => {
  // planner **就是**拆解器 —— 再让它自拆 = 双层调度。
  const GAR = require('../modules/global_agent_rules');
  const planner = GAR.renderGlobalAgentRules('planner');
  const worker = GAR.renderGlobalAgentRules('worker');
  assert.equal(planner, worker, 'planner 档铁律必须与 worker 档一致 (都是"不面对主人也不管自己")');
  assert.ok(!planner.includes('大体量任务必须自拆'),
    'planner 档不许带「大体量任务必须自拆」—— 拆解轮就是拆解器, 让它自拆是双层调度');
  assert.ok(planner.includes('失败要明说'),
    'planner 档必须留诚实纪律 —— 它得如实报"拆不动", 不许假装派了活');
  assert.ok(garSrc.includes("scope === 'worker' || scope === 'planner'"),
    'global_agent_rules 必须显式认 planner 档');
});

test('拆解轮注入: 不挂身份行, 不挂自我认知, 但挂得上 worker 档铁律', () => {
  // 走的是**真实注入函数** (实机主路径就是它), 不是源码正则。
  const LOOP = require('../modules/j2_agent_loop');
  const msgs = [{ role: 'system', content: 'ORIGINAL' }];
  LOOP._injectGlobalRulesOnce(msgs, 0, '', 'TAIL', 'planner', 'main');
  const txt = msgs[0].content;
  assert.ok(txt.includes('ORIGINAL') && txt.includes('TAIL'),
    '注入不能吃掉原内容或 buildTail');
  assert.ok(txt.includes('[运行环境 — 路径铁律]'), 'planner 档没拿到全局铁律');
  assert.ok(txt.includes('失败要明说'), 'planner 档没拿到 worker 档铁律');
  assert.ok(!txt.includes('自我修改授权'),
    'planner 档不该带「自我修改授权」—— 它不面对主人, 也不管自己');
  assert.ok(!txt.includes('你是 Pangu 的子 agent'),
    'planner 档不该被塞子 agent 身份行 —— 它的身份由 dispatcher 那条 system 给');
  assert.ok(!/^你是 Pangu/m.test(txt),
    'planner 档不该补「你是 Pangu」身份行 —— dispatcher 已经给它身份了, 补一句是冲突不是补充');
  assert.ok(!txt.includes('SOULTIER_TEST_L3_MARKER'),
    'planner 档不该带自我认知 (64i/digest/痛觉)');
  // worker 档回归: 身份行必须还在
  const wmsgs = [{ role: 'system', content: 'ORIGINAL' }];
  LOOP._injectGlobalRulesOnce(wmsgs, 0, '', 'TAIL', 'worker', 'executor');
  assert.ok(wmsgs[0].content.includes('你是 Pangu 的子 agent · executor'),
    'worker 身份行被这次改动弄没了 —— 那是 2026-10-16 修好的东西');
});

// ================================================================= 接线守卫

test('soulTier 是独立通道: dispatcher 传 soulTier=planner, 但 role 仍是 main', () => {
  // role 决定 API schema / 工具白名单 / 只读边界; soulTier 只决定提示词档。
  // 拆解轮必须 role='main' (否则 enforceToolFilter 不认它, 它能自己动手干活),
  // 但提示词绝不能是 main 档。这条分界线塌了, 整个三档就白做。
  // 按**大括号配对**取 opts 对象 —— 不按固定字符偏移取窗:
  // 偏移取窗碰上中间多几行注释就取不全 (这次就踩了: enforceToolFilter 在
  // soulTier 下面 1248 字符处, 原来的窗口只够 300)。
  const callIdx = dispSrc.indexOf('_runAgentLoopLegacyStream(_planMessages');
  assert.ok(callIdx > 0, '找不到拆解轮调 _runAgentLoopLegacyStream 的地方');
  const braceAt = dispSrc.indexOf('{', callIdx);
  let depth = 0, end = -1;
  for (let k = braceAt; k < dispSrc.length; k++) {
    if (dispSrc[k] === '{') depth++;
    else if (dispSrc[k] === '}' && --depth === 0) { end = k; break; }
  }
  assert.ok(end > 0, 'opts 对象的括号没配上');
  const win = dispSrc.slice(braceAt, end + 1);
  assert.ok(win.includes("role: 'main'"),
    '拆解轮的 role 必须仍是 main —— 它决定 API schema 和 enforceToolFilter');
  assert.ok(win.includes("soulTier: 'planner'"),
    '拆解轮必须显式声明 soulTier=planner');
  assert.ok(win.includes('enforceToolFilter: true'),
    '拆解轮必须继续 enforceToolFilter —— 它只准派活, 不许自己动手');
  assert.ok(win.includes("sessionId: sessionId + '#main-plan'"),
    "拆解轮的 session id 必须带 '#main-plan' 后缀 (兄弟排除靠它)");
});

test('j2_agent_loop 的 soulScope 全部走 _soulScope (不许再有硬写 main/worker)', () => {
  const n = (loopSrc.match(/soulScope: _soulScope/g) || []).length;
  assert.ok(n >= 8, `soulScope: _soulScope 只有 ${n} 处, 复核一下 (原来硬写的有 8 处)`);
  assert.ok(!/soulScope: _roleForThisLoop/.test(loopSrc),
    '还有硬写的 soulScope: _roleForThisLoop === ... —— 那条路径会把 planner 当成 main');
  assert.ok(/const _soulTier = \(opts && opts\.soulTier\)/.test(loopSrc),
    '_soulTier 必须从 opts.soulTier 取 —— soulTier 是独立通道, 不能从 role 推');
  assert.ok(/const _soulScope = _soulTier;/.test(loopSrc),
    '_soulScope 必须直接等于 _soulTier');
});

test('拆解轮不挂 R18 (TOOL_SELECTION_GUIDE) 和 Native HARD RULE —— 两者跟它直接冲突', () => {
  // R18 教它"按场景在 38 个工具里挑" —— 拆解轮的工具已经定死。
  // Native HARD RULE 要求"必须调 risk_assessment" —— 拆解轮 schema 里根本没这个工具,
  // 模型要么违规试调 (被 enforceToolFilter 拦掉, 白烧一轮), 要么无视这条硬规则。
  // 「不要只用自然语言回答」还跟 dispatcher 铁律⑤「拆不动就直接说拆不动」正面冲突。
  assert.ok(loopSrc.includes('[拆解轮模式]'),
    '拆解轮必须有极简模式提示 —— 否则它会继承 main 的 R18 + HARD RULE');
  // legacy 尾巴
  assert.ok(/const _isPlanTier = \(_soulScope === 'planner'\)/.test(loopSrc),
    'legacy 尾巴必须认 planner 档');
  // native 尾巴
  assert.ok(/const nativeHint = \(_soulScope === 'planner'\)/.test(loopSrc),
    'native 尾巴必须认 planner 档');
  // planner 分支里不许出现 R18 / HARD RULE 的关键词
  const nativeIdx = loopSrc.indexOf('const nativeHint = (_soulScope === \'planner\')');
  const nativeWin = loopSrc.slice(nativeIdx, nativeIdx + 400);
  assert.ok(nativeWin.includes('[拆解轮模式]'),
    'planner 的 native 尾巴必须是极简那一支');
  assert.ok(!nativeWin.slice(0, nativeWin.indexOf(':')).includes('TOOL_SELECTION_GUIDE'),
    'planner 的 native 尾巴不许带 R18');
  const legacyIdx = loopSrc.indexOf('const j2Prompt = _isPlanTier');
  assert.ok(legacyIdx > 0, 'legacy 尾巴必须有 planner 分支');
  const legacyWin = loopSrc.slice(legacyIdx, legacyIdx + 400);
  assert.ok(!legacyWin.slice(0, legacyWin.indexOf(':')).includes('TOOL_SELECTION_GUIDE'),
    'planner 的 legacy 尾巴不许带 R18');
});

test('拆解轮 (#main-plan) 按家族前缀排除兄弟 checkpoint (不只认 #sub-)', () => {
  // 现场 39268686: 拆解轮 msg0 的「跨会话上下文」2390 字, 三条全是兄弟会话 ——
  // desktop-1792838641545 / #sub-0-li r21 / #sub-0-li r20, 父 id 出现 7 次。
  // 那是别的会话的兄弟刀 prompt, 带主人全量路径清单。
  // 判据: 取第一个 '#' 之前那段 ⇒ '#sub-' 和 '#main-plan' 一视同仁。
  assert.ok(/indexOf\('#'\)/.test(loopSrc),
    "必须按 '#' 认出派生会话 —— 只认 '#sub-' 会漏掉拆解轮 (#main-plan)");
  assert.ok(/indexOf\('#'\)[\s\S]{0,200}_familyPrefix = /.test(loopSrc),
    '前缀取的是 # 之前那段父会话 id');
  assert.ok(/excludeSessionPrefix: _familyPrefix/.test(loopSrc),
    '前缀要真的传进 loadRecentSessionContext —— 算出来不传等于没改');
});

test('planner 档整段不拿 priorCtx (跨会话上下文)', () => {
  // 实跑证据 (2026-10-25 02:00, probe82-cannot-split 的 #main-plan 落盘):
  //   msg0 里那段 priorCtx 装的是
  //     [soak-live-1791888078#sub-2-executor] 根据 checker 在 …
  //     [soak-live-1791896265#sub-1-checker] 对 /tmp/pangu_soak_… 下的 8 份文件 …
  //     [probe-1792370454#main-plan] 拆不动。 这是一件事：读 apps/core/modules/pangu_dogfood.js …
  //     cs-5 / cs-4 / cs-3 三条 Prior session
  //   最后那条是**上一轮的拆解轮 prompt** —— 拆解轮的活恰恰是**把任务切小**,
  //   喂它上一轮的切法原文, 它只会照抄。
  //
  //   注意: "家族前缀排除兄弟" 那个修复解决不了这个 ——
  //   priorCtx 装的是**最近 3 个会话**的 checkpoint, 绝大多数属于**别的父会话**,
  //   家族前缀只排得掉同一父会话下的兄弟刀。
  //
  //   为什么 planner 根本不需要这段:
  //     · 主人这一轮的话, dispatcher 已经**原样**送进来了
  //       (_planTask = _historyBlock + userInput, 见 j2_dispatcher.js:1837);
  //     · **当前会话**的历史在 _historyBlock 里, 那是它该看的;
  //     · 跨**会话**的 checkpoint 是别的主人对别的活说的 —— 对"切几刀"零贡献。
  //   跨会话连续性是**主对话**的价值 (老板 2026-09-03 报的"引用上一条 Session"),
  //   那是 main 档的事 —— main 档照旧拿, 一段都不少。
  assert.ok(/const _priorCtx = \(_soulScope === 'planner'\)\s*\n?\s*\? ''/.test(loopSrc),
    "planner 档必须在取值处短路 priorCtx —— 否则它会拿到别的主人的刀 prompt");
  // ⚠ 不许改 _priorCtxCache —— 那是模块级**单槽**缓存, 主会话和拆解轮共用。
  //   拆解轮往里写空值会把主会话已缓存的 priorCtx 冲掉, 下轮主 agent 得重算
  //   (而且算出来的可能已经不是同一段了 —— 那才是真事故)。
  const plannerBranch = loopSrc.slice(
    loopSrc.indexOf("const _priorCtx = (_soulScope === 'planner')"),
    loopSrc.indexOf('const _priorCtx = (_soulScope === \'planner\')') + 1200);
  assert.ok(!/_priorCtxCache\s*=\s*\{/.test(plannerBranch),
    'planner 分支不许写 _priorCtxCache —— 那是主会话的槽, 冲掉它等于主对话的跨会话连续性被拆解轮搞坏');
});

test('行为: planner 档注入的 system 块里不许出现 priorCtx 标记', () => {
  // 源码断言只能证明"代码里写了短路", 证明不了**真的没注入**。
  // 走真实注入函数: 把一段假的 priorCtx 塞进去, 看 planner 档会不会带它进 system。
  const LOOP = require('../modules/j2_agent_loop');
  const FAKE = '# 跨会话上下文 (auto-injected from prior checkpoints)\n[Prior session 1/3] session_id=probe-old\n';
  const mk = () => [{ role: 'system', content: 'ORIGINAL' }];

  // main 档必须带 (跨会话连续性是主对话的价值, 一段都不能少)
  const m = mk();
  LOOP._injectGlobalRulesOnce(m, 0, FAKE, 'TAIL', 'main', 'main');
  assert.ok(m[0].content.includes('probe-old'),
    'main 档丢了 priorCtx —— 老板 2026-09-03 报的"引用上一条 Session"就断在这');

  // planner 档不许带
  const p = mk();
  LOOP._injectGlobalRulesOnce(p, 0, FAKE, 'TAIL', 'planner', 'main');
  assert.ok(!p[0].content.includes('probe-old'),
    'planner 档带上了 priorCtx —— 拆解轮会照抄别的会话的切法');
  assert.ok(!p[0].content.includes('跨会话上下文'),
    'planner 档带上了 priorCtx 标记段');
  assert.ok(p[0].content.includes('ORIGINAL') && p[0].content.includes('TAIL'),
    '注入不能吃掉原内容或 buildTail');
});

test('dispatch_subagents 的角色提示与 enum 同名 (拼音 + 卦名, 不留英文名)', () => {
  // 原来 hint 写英文 (analyzer/executor/…), enum 写拼音 (li/kun/dui/…) ——
  // 两套名字摆在同一个工具描述里: 模型照 hint 写英文 → enum 校验不过 → 整刀失败。
  const { TOOL } = require('../modules/dispatch_subagents_schema');
  const desc = TOOL.function.description;
  const enumList = TOOL.function.parameters.properties.tasks.items.properties.agent.enum;
  assert.deepEqual(enumList, ['li', 'kun', 'dui', 'xun', 'zhen', 'gen'],
    'enum 变了 (它是 ROLES 真源的投影), 复核一遍');
  for (const code of enumList) {
    assert.ok(new RegExp('(^|\\n)' + code + ' ').test(desc),
      `角色提示里必须有 ${code} —— enum 有它而 hint 没有, 模型就只知道一个空壳名字`);
  }
  for (const en of ['analyzer', 'executor', 'checker', 'bug_hunter', 'reflector', 'learner']) {
    assert.ok(!new RegExp('^' + en + ' ', 'm').test(desc),
      `角色提示里不许残留英文名 ${en} —— enum 不认它, 照着写会被校验拦掉`);
  }
  for (const [code, gua] of [['li', '离'], ['kun', '坤'], ['dui', '兑'], ['xun', '巽'], ['zhen', '震'], ['gen', '艮']]) {
    assert.ok(desc.includes(code + ' ' + gua),
      `角色提示必须带卦名 (${code} ${gua}) —— 卦名是盘古自己的身份体系, 不是装饰`);
  }
});

// ================================================================= 变异测试
//
// 目的: 证明上面那些守卫**真的抓得住**, 而不是恒真的空枪。
// 手法: 在内存里编译一份"改坏"的 llm_caller, 然后要求检查器必须报错。
// 一个字节都不落盘 (见 withInjectedEnv 上面的说明)。

test('变异 1: planner 掩码漏掉 planner ⇒ planner 档守卫必须响', () => {
  const broken = lcSrc.replace(
    "_push({ role: 'system', content: _renderSystemPrompt(soulScope) }, 'main worker planner');",
    "_push({ role: 'system', content: _renderSystemPrompt(soulScope) }, 'main worker');");
  assert.notEqual(broken, lcSrc, '变异没打中 —— 源码形态变了, 复核这条变异');
  withInjectedEnv(() => {
    const mutant = loadMutantLlc(broken);
    const { problems } = checkPlanTier(mutant);
    assert.ok(problems.length > 0,
      '守卫没响 —— planner 掩码漏掉 planner 之后, 检查器竟然没发现');
    assert.ok(problems.some(p => p.includes('基础 soul')),
      '响的位置不对: ' + JSON.stringify(problems));
  });
});

test('变异 2: L3 hint 放进 planner ⇒ planner 档守卫必须响', () => {
  const broken = lcSrc.replace(
    "}, 'main');   // 主 agent 的今日异常聚合, worker 不需要, planner 也不需要",
    "}, 'main planner');   // 变异: L3 漏进 planner");
  assert.notEqual(broken, lcSrc, '变异没打中 —— 源码形态变了, 复核这条变异');
  withInjectedEnv(() => {
    const mutant = loadMutantLlc(broken);
    const { problems } = checkPlanTier(mutant);
    assert.ok(problems.length > 0, '守卫没响 —— L3 漏进 planner 竟然没被发现');
    assert.ok(problems.some(p => p.includes('L3 自适应提示')),
      '响的位置不对: ' + JSON.stringify(problems));
  });
});

test('变异 3: MCP 的 main 过滤失效 ⇒ main 档守卫必须响', () => {
  // 第 79 批定了「MCP 只给 worker」, 第 80 批把提示词侧也收窄了。
  // 这次守的是那条 early return —— 删掉它, main 的清单里就会漏出 44 个调不到的 MCP 工具名。
  const broken = lcSrc.replace("    if (role === 'main') return [];\n", '');
  assert.notEqual(broken, lcSrc, '变异没打中 —— 源码形态变了, 复核这条变异');
  withInjectedEnv(() => {
    const mcp = require('../modules/mcp_adapter');
    const orig = mcp._collectAllToolSchemas;
    mcp._collectAllToolSchemas = () => [
      { function: { name: 'mcp__github-mcp__search_repositories', description: '搜仓库', parameters: { properties: { query: { type: 'string' } }, required: ['query'] } }, _mcpServer: 'github-mcp' },
    ];
    try {
      const mutant = loadMutantLlc(broken);
      // 先确认桩生效: 只读角色确实拿得到 MCP 工具 (否则下面又是空枪)
      const asLi = mutant._mcpSchemasForLLM('li');
      assert.ok(asLi.length > 0, '前提: 打桩后只读角色确实拿得到 MCP 工具');
      const summary = mutant._loadToolSummary(undefined, 'main');
      assert.ok(/^# MCP 工具/m.test(summary),
        '变异没生效 —— main 档的清单里没出现 MCP 段, 这条变异测不到东西');
    } finally {
      mcp._collectAllToolSchemas = orig;
    }
  });
});

test('变异 4: 变异机制本身自检 (把真源码原样编译, 检查器必须全绿)', () => {
  // 负例自检: 变异体加载路径本身不该引入假阳性 ——
  // 否则上面三条"守卫生效"就可能是在测一条永远红的死路。
  withInjectedEnv(() => {
    const same = loadMutantLlc(lcSrc);
    const p = checkPlanTier(same);
    assert.deepEqual(p.problems, [],
      '原样编译却报错 —— 变异机制本身有问题:\n  ' + p.problems.join('\n  '));
  });
});

test('变异 5: planner 档又拿到 priorCtx ⇒ 守卫必须响', () => {
  // 把注入函数里的作用域判断去掉 —— planner 就又会拿到别的主人的刀 prompt。
  // 这条变异守的是"机制"那一层 (不是取值处的短路),
  // 因为 _injectGlobalRulesOnce 有 4 个调用点, 少改一个就漏。
  const broken = loopSrc.replace(
    "const _prior = (_scope === 'planner') ? '' : (priorCtx || '');",
    'const _prior = (priorCtx || \'\');');
  assert.notEqual(broken, loopSrc, '变异没打中 —— 源码形态变了, 复核这条变异');
  const m = new Module(LOOP_PATH, null);
  m.filename = LOOP_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(LOOP_PATH));
  m._compile(broken, LOOP_PATH);
  const LOOP = m.exports;
  const FAKE = '# 跨会话上下文 (auto-injected from prior checkpoints)\n[Prior session 1/3] session_id=probe-old\n';
  const p = [{ role: 'system', content: 'ORIGINAL' }];
  LOOP._injectGlobalRulesOnce(p, 0, FAKE, 'TAIL', 'planner', 'main');
  assert.ok(p[0].content.includes('probe-old'),
    '守卫没响 —— planner 档又拿到 priorCtx 了, 检查器竟然没发现');
});

test('变异 6: main 档的 priorCtx 被误伤 ⇒ 守卫必须响', () => {
  // 反向守卫: 不能为了给 planner 减负, 把**主对话**的跨会话连续性也砍了。
  // 老板 2026-09-03 报的就是"没办法引用上一条 Session" ——
  // main 档的 priorCtx 少一段, 那条能力就断了, 而这种回归没有任何报错。
  const broken = loopSrc.replace(
    "const _prior = (_scope === 'planner') ? '' : (priorCtx || '');",
    "const _prior = '';");
  assert.notEqual(broken, loopSrc, '变异没打中 —— 源码形态变了, 复核这条变异');
  const m = new Module(LOOP_PATH, null);
  m.filename = LOOP_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(LOOP_PATH));
  m._compile(broken, LOOP_PATH);
  const LOOP = m.exports;
  const FAKE = '[Prior session 1/3] session_id=probe-old\n';
  const mm = [{ role: 'system', content: 'ORIGINAL' }];
  LOOP._injectGlobalRulesOnce(mm, 0, FAKE, 'TAIL', 'main', 'main');
  assert.ok(!mm[0].content.includes('probe-old'),
    '守卫没响 —— main 档的 priorCtx 被误伤了, 检查器竟然没发现');
});

