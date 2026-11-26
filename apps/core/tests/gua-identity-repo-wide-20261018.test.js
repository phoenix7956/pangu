// 2026-10-18 老板: 「那你还是不统一, 不统一不还是出错」
//
// 上一轮的守卫 (gua-identity-one-name-20261018.test.js) 只扫 apps/core,
// 于是 apps/desktop/src 整个在射程外。实测那正是漏网的地方:
//
//   1. _role_matrix.jsx 手抄第 7 份身份表, 键是英文 —— 而 /api/pangu/tools 的
//      exposed_by_role / exposed_for 早就是拼音了。于是 exposedByRole['planner']
//      恒 undefined -> 8 个 tab 计数全是 0; toolExposedFor(t,'planner') 恒 false
//      -> 工具列表恒空, 永远显示「无匹配 tool」。设置里的角色视角 tab 就是一张
//      空壳, 而日志里一个字都没有。
//
//   2. orchestrator.js 手抄 ROLE_ALIASES = {bug_hunter:'xun', ...}, 键是英文,
//      而且当时只认 bugHunter 一个角色, 其余英文名原样穿过 —— 归一化只对 1/8 生效。
//
// 而且把这两处改回英文再跑上一轮的守卫, 全都转绿 —— 守卫和被守卫错开,
// 等于没有守卫。所以这个文件做两件上一轮没做的事:
//
//   A. 扫描范围扩到 apps/core + apps/desktop/src, 不许再有英文身份的字面量;
//   B. 钉住本轮挖出来的两个活的故障 (L3 闭环崩溃 / roleStats 恒 0),
//      断言走真实调用, 不是看源码字符串。
//
// 去注释用朴素替换 —— 宁可漏报一条, 也不要一条假红把守卫变成摆设。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const REPO = path.join(CORE, '..', '..');

// 上一代的 8 个英文身份 (+ 后端从未注册过的 synthesizer)。
// 大小写不敏感: Planner 和 planner 是同一个名字的两种大小写,
// 而大小写不一致正是「两套身份」最容易藏的地方。
const ENGLISH_ROLES = [
  'analyzer', 'executor', 'checker', 'bug_hunter', 'bugHunter',
  'planner', 'reflector', 'learner', 'dispatcher', 'synthesizer',
];

// 唯一允许出现旧英文名的两类地方 (老板 2026-10-18 第二次拍板后从「身份真源」
// 收窄到「数据迁移」):
// 2026-10-18: 这个白名单**现在是空的**。
// 它原来豁免 modules/subagent_runs.js —— 那儿挂着 LEGACY_RUN_CODE, 理由是
// 「磁盘上 3963 行英文, 不翻译就静默清零」。数据已经用一次性脚本
// scripts/migrate-run-codes-to-pinyin-20261018.js 就地迁成拼音了 (3545 行),
// 于是那张表变成纯冗余, 已删。白名单跟着清空 —— 留着它等于留着一个
// 「这儿可以出现英文名」的口子, 下一个照着抄的人就又抄出第二套身份。
const DATA_MIGRATION_SITES = [];
// scripts/ 排除的理由: 里面是**运维工具**, 不是运行时。一次性迁移脚本
// (migrate-run-codes-to-pinyin-20261018.js) 必须知道旧英文值长什么样,
// 否则它没法改磁盘上的旧数据 —— 那正是它存在的唯一理由。
// 运行时一处都不该 require 它 (下面 T10 有断言钉住), 所以排除不等于放行。
const SKIP_DIRS = new Set(['node_modules', 'dist', 'docs', '.git', 'tests', '.learn', 'coverage', 'scripts']);
// ⚠ 2026-10-26 第 107 批 (桌面端下线): 扫描范围去掉 `apps/desktop/src`。
//   ⇒ 这条守卫的**覆盖面变小了**(原来 8 将灵的前端也在射程内)。
//   这不是「补齐」能解决的 —— 那个目录不存在了。
//   ⇒ 代价要认: 以后**任何**新客户端(网页/APP/命令行)再抄一份身份表, 这条守卫看不见。
//   ⇒ 补法: `gua-identity-single-source-20261018.test.js` 那条已经把「8 将灵身份表
//     只许有一份」泛化成**扫 apps/core 全仓**, 新的客户端目录要自己加进那两条的射程。
//     「删掉一个目录 ⇒ 静默废掉一半守卫」—— 这条本身要记进踩坑日志。
const SCAN_ROOTS = ['apps/core'];

/** 朴素去注释: 只可能让内容变少 (漏报), 不会凭空造出内容 (误报)。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function eachSourceFile(fn) {
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO, root);
    if (!fs.existsSync(abs)) continue;
    (function rec(dir) {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory()) {
          if (!SKIP_DIRS.has(d.name)) rec(path.join(dir, d.name));
          continue;
        }
        if (!/\.(js|jsx|ts|tsx)$/.test(d.name)) continue;
        fn(path.join(dir, d.name), path.relative(REPO, path.join(dir, d.name)));
      }
    })(abs);
  }
}

test('T9 全仓 (含前端) 不许有引号里的英文身份 —— 前端从来没有输入解析的需求', () => {
  const hits = [];
  eachSourceFile((abs, rel) => {
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    code.split('\n').forEach((line, i) => {
      for (const role of ENGLISH_ROLES) {
        // 2026-11-26: 排除**比较/条件表达式**里的字符串字面量
        //   (scope === 'planner' / _scope === 'worker' 等是代码标识符, 不是身份名)。
        //   判定: 引号前面是 === / !== / ? / ( / = 等比较/赋值操作符时跳过。
        const cmpRe = new RegExp('([=!<>?:&(,;])\\s*([\'"`])' + role + '\\2', 'i');
        if (cmpRe.test(line)) continue; // 比较/赋值上下文, 不是身份
        if (new RegExp(`(['"\`])${role}\\1`, 'i').test(line)) {
          hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
        }
      }
    });
  });
  assert.strictEqual(hits.length, 0,
    '这些地方把英文身份写成了字符串字面量, 它们会被当成真身份传下去:\n'
    + hits.join('\n')
    + '\n\n判断标准: 身份只能是拼音 (qian/kan/gen/zhen/xun/li/kun/dui)。'
    + '身份只有拼音。模型吐英文会被判未知角色 —— 这是故意的, 见 T8。');
});

test('T10 旧英文名的映射表一处都不许存在, 谁都不许再手抄一份', () => {
  // 专治 orchestrator.js 那种: 看到 planner 产出 snake_case, 就自己抄一张
  // ROLE_ALIASES 应付一下 —— 结果只认 1/8 个角色, 另外 7 个原样穿过。
  //
  // dispatcher 从这个模式里排除: 派发结果里 `dispatcher: 'pangu-v2 (LLM-first)'`
  // 说的是**用了哪套派发器**, 是个版本字段, 不是将灵身份。真要拿 dispatcher 当
  // 角色用, T9 的引号模式照样咬住。
  const KEYABLE = ENGLISH_ROLES.filter((r) => r !== 'dispatcher');
  const hits = [];
  eachSourceFile((abs, rel) => {
    if (DATA_MIGRATION_SITES.some((f) => rel.endsWith(f))) return;   // 现在是空集, 见上面注释
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    code.split('\n').forEach((line, i) => {
      for (const role of KEYABLE) {
        if (new RegExp(`(^|[{,\\s])${role}\\s*:`, 'i').test(line)) {
          hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
        }
      }
    });
  });
  assert.strictEqual(hits.length, 0,
    '这些地方又把英文名当成了表的键 —— 第 N 次抄身份表, 第 N 次会漂移:\n'
    + hits.join('\n')
    + '\n\n要归一就用 resolveRole(input), 读进来即丢。别自己建映射表 —— '
    + '数据要迁就写一次性脚本改文件, 别在热路径上养常设表。');

  // 反向钉住上面那个 scripts/ 豁免: 运行时**不许** require 那个迁移脚本。
  // scripts/ 目录本身不能整体禁 —— j2_agent_loop.js 一直在 require
  // scripts/l2-miner.js (取 L2 提示), 那是长期存在的正常依赖。
  // 这里只钉住**迁移脚本**: 它必须死在热路径外面, 否则脚本里那张旧英文表
  // 就等于被加回来了, 只是换了个文件名, T10/T15 全都看不见它。
  const scriptLeaks = [];
  eachSourceFile((abs, rel) => {
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    if (/migrate-run-codes-to-pinyin/.test(code)) {
      scriptLeaks.push(rel);
    }
  });
  assert.strictEqual(scriptLeaks.length, 0,
    '运行时 require 了迁移脚本 —— 一次性工具进了热路径, 里面的旧英文表等于加回来了:\n'
    + scriptLeaks.join('\n'));
});

test('T11 L3 学习闭环不许再崩 (上一轮改 require 路径时漏改解构名, 线上每 60 秒 TypeError)', () => {
  // 真跑一遍, 不是看源码字符串。
  // 现场证据: /tmp/pangu-single.err 里连续 11 条
  //   L3 cycle error: Cannot read properties of undefined (reading getLearnData)
  // pangu-single.js 的定时器把异常 catch 成一行 warn, 所以 L3 整个是死的,
  // 而 L3 状态文件时间戳不动, 没有任何东西会主动告诉你学习闭环没了。
  const { L3Loop } = require(path.join(CORE, 'agents', 'l3_loop.js'));
  const loop = new L3Loop();
  // 权重表里不许出现第二套名字 (认不出的键在加载期就被丢了)。
  const {GUA_CODES} = require(path.join(CORE, 'agents', 'gua-identity.js'));
  for (const k of Object.keys(loop.state.weights || {})) {
    assert.ok(GUA_CODES.includes(k),
      `l3_state.json 的权重键 "${k}" 不是拼音 —— 加载期迁移没生效, `
      + '磁盘上仍然留着上一代的英文身份');
  }
  return loop.runCycle().then(
    () => assert.ok(true, 'runCycle 应正常返回'),
    (e) => assert.fail('runCycle 崩了 —— L3 学习闭环整个是死的: ' + e.message)
  );
});

test('T12 dispatch 的 roleStats 必须是 8 个真实计数 (原来用英文键查拼音表, 恒为 0)', () => {
  // pangu_decide.js 原来手写 8 行 roleMap.executor && ..., 而 roleMap 来自
  // tool_role_map.json —— 那张表拼音化之后键全是拼音。于是 roleMap.executor 恒
  // undefined, 8 个计数恒为 0, 而 API 照常返回 role_stats, 不报任何错。
  // 这里不跑 LLM (那要网络), 直接对着真源表验这张统计表的键空间。
  const roleMap = JSON.parse(
    fs.readFileSync(path.join(CORE, 'config', 'tool_role_map.json'), 'utf8'));
  const {GUA_CODES} = require(path.join(CORE, 'agents', 'gua-identity.js'));
  const decide = fs.readFileSync(path.join(CORE, 'modules', 'pangu_decide.js'), 'utf8');

  // 统计表必须从真源派生, 不许再手抄 8 行英文键。
  assert.ok(/roleStats[\s\S]{0,400}GUA_CODES/.test(decide),
    'roleStats 必须从身份真源的 GUA_CODES 派生 —— '
    + '手抄第 8 份身份表 = 第 8 次漂移 (上一版就是手抄 8 行英文键, 恒为 0)');

  // 真源表本身必须真的有工具, 否则「恒为 0」就分不清是键错了还是表本来就空。
  const nonEmpty = GUA_CODES.filter((c) => ((roleMap[c] && roleMap[c].tools) || []).length > 0);
  assert.ok(nonEmpty.length > 0,
    'tool_role_map.json 里一个带工具的拼音将灵都没有 —— 统计恒 0 就不是键的问题了');
});

test('T11b L3 加载期必须真的把英文键迁成拼音 (拿一份英文 state 真跑, 不看当前磁盘)', () => {
  // 为什么要单独一条: T11 只能看**当下**磁盘上那份文件, 而它早就被迁成拼音了。
  // 于是「把加载期的防御整个删掉」这个变异, T11 照样转绿 —— 它测的是巧合不是机制。
  // 这里造一份**全是英文键**的临时 state, 让 L3Loop 自己去读。
  //
  // 2026-10-18 契约变了: 这里**不再**断言"英文被翻译成拼音"(翻译 = 第二套身份,
  // 老板「说了全部换, 还留着干嘛」)。改断言**认不出的键被丢掉**:
  //   英文 state → 8 个键全被丢 → 表空 → 回填成 8 个拼音默认值。
  // 关键是长度仍必须是 8 且全是拼音 —— 少了就是"英文键沉进了权重表",
  // 那样 L3 会给一个不存在的角色记权重, 而 8 将灵里有一个永远学不到东西。
  // 注意这个长度断言正是能咬住"直接 return _loaded, 不做任何过滤"的变异。
  const tmp = path.join(os.tmpdir(), 'pangu-l3-mut-' + process.pid + '-' + Date.now() + '.json');
  fs.writeFileSync(tmp, JSON.stringify({
    weights: {
      planner: 0.5, analyzer: 0.4, executor: 0.6, checker: 0.5,
      bug_hunter: 0.5, learner: 0.5, reflector: 0.5, dispatcher: 0.5,
    },
    taskToAgents: {}, toolSets: {}, lastUpdated: null,
  }));
  const prev = process.env.PANGU_L3_STATE_PATH;
  const modPath = path.join(CORE, 'agents', 'l3_loop.js');
  process.env.PANGU_L3_STATE_PATH = tmp;
  delete require.cache[require.resolve(modPath)];   // 换路径必须重 require, 否则常量早算好了
  try {
    const { L3Loop } = require(modPath);
    const {GUA_CODES} = require(path.join(CORE, 'agents', 'gua-identity.js'));
    const keys = Object.keys(new L3Loop().state.weights || {});
    for (const k of keys) {
      assert.ok(GUA_CODES.includes(k),
        '英文键 "' + k + '" 沉进了权重表 —— 加载期没有把认不出的角色键丢掉。'
        + '留着它 = 给一个不存在的将灵记权重, 8 将灵里有一个永远学不到东西');
    }
    assert.strictEqual(keys.length, 8,
      '期望迁出 8 个拼音键, 实际 ' + keys.length + ': ' + keys.join(','));
  } finally {
    if (prev === undefined) delete process.env.PANGU_L3_STATE_PATH;
    else process.env.PANGU_L3_STATE_PATH = prev;
    delete require.cache[require.resolve(modPath)];
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});

test('T13 提示词里教的角色名必须是拼音 —— 不许出现「卦名·旧英文名」', () => {
  // 专治提示词自相矛盾那类: 同一个 prompt 上面说「只写拼音, 写英文会被判未知」,
  // 下面三行却列一份英文清单。模型看到两套名字, 学的必然是后者。
  // 实测过两处: sub-agent.js 的 planner 角色清单、j2_dispatcher 的日志文案。
  // 模式要求前面必须是 8 个卦名之一 —— 否则 result.dispatcher 这种属性访问会误报。
  const GUA = ['乾', '坎', '艮', '震', '巽', '离', '坤', '兑'];
  const hits = [];
  eachSourceFile((abs, rel) => {
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    code.split('\n').forEach((line, i) => {
      for (const role of ENGLISH_ROLES) {
        const re = new RegExp('[' + GUA.join('') + ']\\s*[·.]\\s*' + role + '\\b', 'i');
        if (re.test(line)) {
          hits.push(rel + ':' + (i + 1) + '  ' + line.trim().slice(0, 100));
        }
      }
    });
  });
  assert.strictEqual(hits.length, 0,
    '这些地方在提示词/文案里把卦名和上一代英文名并排写 —— 模型看到的就是两套身份:\n'
    + hits.join('\n') + '\n\n统一之后, 卦名后面只能跟拼音: 乾·qian / 坎·kan。');
});

test('T14 喂给 LLM 的工具参数描述不许手抄角色清单 (必须从身份真源生成)', () => {
  // tools_schema 的 description 是**进提示词**的, 不是注释。上一版手抄了 8 个英文 code,
  // 于是每次调 plan_create, 都在教模型输出一套运行时永远丢弃的名字。
  const { TOOLS_SCHEMA } = require(path.join(CORE, 'modules', 'tools_schema.js'));
  // 递归收集所有叫 agent 的字段描述, 而不是把 schema 路径写死 ——
  // 上一个版本写死了 properties.agent, 而真实结构在 properties.steps.items.properties.agent,
  // 于是断言读到空串、报「描述不见了」, 看起来像代码坏了, 其实是测试自己找错地方。
  const descs = [];
  (function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(collect); return; }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'agent' && v && typeof v === 'object' && typeof v.description === 'string') {
        descs.push(v.description);
      }
      collect(v);
    }
  })((((TOOLS_SCHEMA || {}).plan_create || {}).function || {}).parameters);
  assert.ok(descs.length > 0, 'plan_create 里找不到 agent 字段的描述 —— schema 结构变了要更新本测试');
  const agentDesc = descs.join('\n');
  const {GUA_CODES} = require(path.join(CORE, 'agents', 'gua-identity.js'));
  for (const code of GUA_CODES) {
    assert.ok(agentDesc.includes(code),
      'plan_create 的 agent 描述里没有拼音 ' + code + ' —— 模型看不见这个角色, 就不会派它');
  }
  for (const role of ENGLISH_ROLES) {
    assert.ok(!new RegExp('\\b' + role + '\\b', 'i').test(agentDesc),
      'plan_create 的 agent 描述里还有英文 ' + role + ' —— '
      + '这是**喂给模型**的字符串, 教的是一套运行时认不出来的名字');
  }
});

test('T15 身份真源 agents/gua-identity.js 必须**零英文** —— 老板:「说了全部换, 还留着干嘛」', () => {
  // 这条是「全部换」的字面形式。上一轮这里还留着一张 LEGACY_INPUT
  // (dispatcher→qian / planner→kan / analyzer→li …), 理由是「模型先验里全是英文,
  // 入口得读得懂」。老板明确不接受。删掉之后这一条必须跟着变红 —— 否则下一个
  // 人再加回来时没有任何阻力, 而"再加回来"正是这个仓库反复出事的那个动作。
  //
  // 注意: 去注释之后再扫, 因为解释"为什么删"的那段注释里必须提到旧名字。
  const rel = path.join('apps', 'core', 'agents', 'gua-identity.js');
  const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const code = stripComments(src);
  for (const role of ENGLISH_ROLES) {
    assert.ok(!new RegExp(`\\b${role}\\b`, 'i').test(code),
      `身份真源里出现了 "${role}" —— 它是叶子模块, 谁都引它; `
      + '英文身份放在这里 = 第二套身份又有了真源级户口');
  }
  // 导出的解析函数只该剩一个, 且不接受英文
  const mod = require(path.join(CORE, 'agents', 'gua-identity.js'));
  assert.ok(!('parseAgentName' in mod) && !('parseAgentToken' in mod)
    && !('LEGACY_INPUT' in mod) && !('AGENT_NAME_TOKENS' in mod),
    '身份真源又导出了英文解析入口 —— parseAgentName / parseAgentToken / '
    + 'LEGACY_INPUT / AGENT_NAME_TOKENS 任何一个回来都算第二套身份');
  assert.strictEqual(mod.resolveRole('analyzer'), null,
    'resolveRole 认出了英文 —— 输入侧也没收干净');
});

test('T16 翻译表已删干净, 且账本数据确实是拼音 (不是被清零)', () => {
  // 2026-10-18 整条翻过来了: 上一版这里断言"subagent_runs.js 必须**有**一张
  // 英文→拼音翻译表, 且必须真能用"(老板:「说了全部换, 还留着干嘛」)。
  //
  // 现在反过来, 钉两件事:
  //   (a) 代码里**一处都不许有**那张表 —— 翻译已经挪进一次性脚本
  //       scripts/migrate-run-codes-to-pinyin-20261018.js;
  //   (b) 磁盘上的账本**必须已经是拼音** —— 这是删表的前提, 也是删表之后
  //       "一个月实跑记录没被清零"的唯一证据。
  //
  // (b) 比上一版更硬: 上一版是"有旧行也能读出来", 现在是"旧行不许存在"。
  // 留着旧行的机器上跑这条会红 —— 那正是该跑迁移脚本的信号, 不是假红。
  const { GUA_CODES } = require(path.join(CORE, 'agents', 'gua-identity.js'));
  const src = stripComments(fs.readFileSync(path.join(CORE, 'modules', 'subagent_runs.js'), 'utf8'));

  for (const role of ENGLISH_ROLES) {
    assert.ok(!new RegExp('\\b' + role + '\\b\\s*:\\s*\'', 'i').test(src),
      'subagent_runs.js 里又有 "' + role + '" 的旧值翻译表 —— '
      + '数据已经迁成拼音了, 这张表现在是纯冗余, 也是第二套身份');
  }
  assert.ok(!/LEGACY_RUN_CODE/.test(src),
    'LEGACY_RUN_CODE 回来了 —— 老板原话「说了全部换, 还留着干嘛」');

  // 账本本身必须只有拼音。
  const runMod = require(path.join(CORE, 'modules', 'subagent_runs.js'));
  const realPath = path.join(os.homedir(), '.pangu', 'subagent-runs.jsonl');
  if (!fs.existsSync(realPath)) return;      // 没有账本的机器上无从验, 跳过而不是假红
  const lines = fs.readFileSync(realPath, 'utf8').split('\n').filter(Boolean);
  const legacy = [];
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch (_) { continue; }
    const k = String(e.code || '').trim().toLowerCase();
    if (!GUA_CODES.includes(k) && k !== 'synthesizer') legacy.push(k);
  }
  assert.strictEqual(legacy.length, 0,
    '账本里还剩 ' + legacy.length + ' 行非拼音 code ('
    + [...new Set(legacy)].slice(0, 5).join(',')
    + ') —— 跑一次 scripts/migrate-run-codes-to-pinyin-20261018.js。'
    + '注意: 这些行现在**读不出来** (翻译表已删), 它们正在静默清零 digest 统计');

  // 迁完不等于数据没了: digest 必须真的聚合得出历史次数, 而不是 8 格全 0。
  const d = runMod.digest();
  const by = d.by_code || {};
  assert.ok(Number(d.totals) > 0,
    'digest 读不出任何事件 —— 账本被清空了。这正是当初要留翻译表时怕的那件事, '
    + '现在用"迁数据 + 删表"取代它, 所以这条必须真的绿');
  for (const code of GUA_CODES) {
    assert.ok(by[code], 'digest 的 by_code 里少了 ' + code);
  }
});

test('T18 运行时提示词里不许有英文身份 —— 直接查模型真正读到的那 8 段 system', () => {
  // 为什么 T13 没抓到: T13 的正则要求卦名和英文名**相邻** (「卦·英文」),
  // 而 8 段自述长的是「你是 Pangu 的 Planner（规划者）」—— 卦名压根不在旁边,
  // 于是 T13/T15 全部绿着, 英文身份就这么一路留在提示词里。
  // 注释在仓库里留着 Planner/Analyzer 是**对的** (历史现场记录, 模型读不到),
  // 所以这里不能扫源码, 要扫**运行时** ROLES[code].system —— 那才是模型读的东西。
  const { ROLES } = require(path.join(CORE, 'agents', 'sub-agent.js'));

  // 大小写都算, 并且认 "Bug Hunter" 这种带空格的历史写法。
  const FORBIDDEN = [
    ...ENGLISH_ROLES,
    'Planner', 'Analyzer', 'Executor', 'Checker', 'Learner',
    'Reflector', 'Dispatcher', 'Bug Hunter', 'bug hunter',
    'Pangu',
  ];
  const hits = [];
  for (const [code, role] of Object.entries(ROLES)) {
    const sys = String(role.system || '');
    for (const w of FORBIDDEN) {
      const re = new RegExp('(?<![A-Za-z_])' + w.replace(/ /g, '\\s+') + '(?![A-Za-z_])', 'i');
      if (re.test(sys)) hits.push(code + ' 的提示词里有英文身份「' + w + '」');
    }
  }
  assert.strictEqual(hits.length, 0,
    '模型读到的提示词里还有英文身份 —— 同一个角色两个名字, 而且藏在第一行里:\n'
    + hits.join('\n')
    + '\n\n自述统一成「你是盘古八将灵中的卦（卦 · 职责）」; 提示词里互相提及时用卦名。');

  // 自述必须真的是卦 —— 只查"没有英文"不够, 空提示词也"没有英文"。
  for (const [code, role] of Object.entries(ROLES)) {
    const first = String(role.system || '').split('\n')[0];
    assert.ok(/盘古八将灵中的[乾坎艮震巽离坤兑]/.test(first),
      code + ' 的自述第一行没有卦名: ' + first.slice(0, 60));
  }
});

test('T19 意象层真砍干净了 —— 数据、界面文案、配置说明三处都不许再有身体部位', () => {
  // 意象 (手指/眼/手/舌秤/耳/心/骨/大脑) 是 2026-10-19 砍掉的第三层。
  // 上一轮砍了 gua-identity 的 `part` 字段和前端的 zhName 就宣布完成, 但实测还剩两处:
  //   AgentList.jsx 的 confirm 文案 —— 主人点"一键恢复预设"弹出来的那段
  //   _role_matrix.jsx 的界面说明 —— 设置页角色视角 tab 上写着
  // 两处都是**主人亲眼读到**的, 砍了数据留着嘴 = 没砍。
  //
  // 为什么必须扫源码而不是只查数据: 意象当初就是"数据一个样、界面另一个样"，
  // 现在反过来 —— 数据干净了、界面没跟上。同一个坑, 两个方向都踩了一遍。
  //
  // 只扫**会被渲染/被读的字符串**: JSX 文本、JS 字符串字面量。
  // 注释里的历史记录留着 (那是 2026-09-18 定死这套映射时的现场证据)。
  const PARTS = ['大脑', '手指', '舌秤', '舌', '眼', '手', '耳', '心', '骨'];
  // 「心」单字太容易撞正常词 (心里/核心/担心), 所以要求紧挨着卦名才算。
  const PART_NEXT_TO_GUA = /(?:大脑|手指|舌秤|舌|眼|手|耳|心|骨)\s*[·、(（]/;
  const GUA_ADJACENT = /[乾坎艮震巽离坤兑]\s*[·、(（]?\s*(?:大脑|手指|舌秤|舌|眼|手|耳|心|骨)\b/;

  const files = [
    path.join(CORE, 'config', 'tool_role_map.json'),
    path.join(CORE, 'config', 'dispatch_rules.json'),
  ];

  const hits = [];
  for (const f of files) {
    if (!fs.existsSync(f)) { hits.push(path.relative(REPO, f) + ' 不存在了 —— 守卫得跟着搬家'); continue; }
    const raw = fs.readFileSync(f, 'utf8');
    // 去行注释和块注释, 只留真正会被渲染/被读的文本
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    for (const part of PARTS) {
      if (!code.includes(part)) continue;
      // 挨着卦名 = 拿身体部位当身份讲 (真问题)。
      // 独立出现且不带卦名 = 大概率是正常中文用法, 不报 (宁可漏报)。
      const near = new RegExp('[乾坎艮震巽离坤兑]\\s*[·、]?\\s*' + part + '\\b').test(code);
      if (near) hits.push(path.relative(REPO, f) + ' 还有「' + part + '」当身份: '
        + (code.match(new RegExp('.{0,24}[乾坎艮震巽离坤兑]\\s*[·、]?\\s*' + part + '\\b.{0,16}')) || [''])[0].trim());
    }
    if (PART_NEXT_TO_GUA.test(code) && !hits.some((h) => h.startsWith(path.relative(REPO, f)))) {
      hits.push(path.relative(REPO, f) + ' 有「卦·身体部位」这种写法: '
        + (code.match(new RegExp('.{0,20}' + PART_NEXT_TO_GUA.source + '.{0,20}')) || [''])[0].trim());
    }
  }
  assert.strictEqual(hits.length, 0,
    '意象层还漏在主人看得见的地方 —— 数据砍了文案没砍, 同一个将灵界面两种说法:\n'
    + hits.join('\n')
    + '\n\n文案统一成「卦 · 职责」(和 SubAgentPanel 早就写着的那条规矩对齐)。');

  // 反向钉住: 身份真源里不该再有 part 字段 —— 否则下一轮又会长回来
  const { GUA_ROLES } = require(path.join(CORE, 'agents', 'gua-identity.js'));
  for (const r of GUA_ROLES) {
    assert.ok(!('part' in r), r.code + ' 的身份条目里又有 part 字段了 —— 意象层在长回来');
    assert.ok(!('zhName' in r), r.code + ' 的身份条目里又有 zhName 字段了 —— 前端第二份身份副本在长回来');
  }
});
