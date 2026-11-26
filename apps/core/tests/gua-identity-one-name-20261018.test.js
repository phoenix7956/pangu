// 2026-10-18 老板: 「那你还是不统一, 不统一不还是出错」
//
// 上一轮只统一了 ROLES / registry / 前端 roster, 就宣布收工。老板当场指出: 仓库里
// **还有一整套英文身份的影子**, 没跟着换。实测确实如此 —— 而且每一个都在静默出错:
//
//   ① tool_role_map.json 键还是英文, 且带一个后端不存在的 'synthesizer'
//      (它 label 写「乾·大脑 (synthesizer)」—— "乾是谁" 最早就是在这里对不上的)
//   ② dispatch_rules.json 键还是英文, 外加一个根本不是角色的 'self_checker'
//      → 「排查」「自查」「体检」命中它 → role:'self_checker' → ROLES[...] 查不到
//      → **空角色**: 子 agent 拿不到将灵提示词, 也拿不到工具白名单 (只读边界失效)
//   ③ pangu_decide.js 的显式指定角色路径: `roleMap[role] && agentRegistry()[role]`
//      两边一个英文一个拼音, **恒为假** → 整条路径是死的
//   ④ ROLE_TIER 键还是英文 → ROLE_TIER['li'] 恒 undefined → `|| {temperature: 0}`
//      把**每一个**将灵都兜成温度 0 (离该 0.2 / 巽该 0.3 / 震 0.3 / 艮 0.2 全被压平)
//   ⑤ agents/ 下 8 个模块文件还叫 analyzer.js / executor.js ... 而 ROLES 的键是拼音
//   ⑥ j2_agent_loop 手抄了**两份**工具→角色映射, 值是英文, 喂给只认拼音的 CODE_TO_GUA
//
// 本文件钉住"所有按角色名索引的表, 键必须是拼音" —— 不再逐个记哪张表,
// 而是对**所有**这类表统一断言。少改一张, 这里的断言就红。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const R = (rel) => path.join(ROOT, rel);
const {GUA_CODES, isGuaRole, resolveRole} = require(R('agents/gua-identity'));

const ENGLISH = /^(analyzer|executor|checker|learner|reflector|bug_hunter|bugHunter|planner|dispatcher|synthesizer)$/;
// 真源自己承认的输入解析表 (模型先验), 不是"表的键"
const LEGACY_INPUT = new Set(GUA_CODES.map(String));

test('T1 所有按角色名索引的配置表, 键必须都是拼音将灵 (除了显式白名单)', () => {
  // 每个键后面写清楚"为什么允许它不是将灵" —— 新增一张表时必须在这里登记,
  // 否则要么过不了这条断言, 要么就是又一张悄悄漂移的表。
  const TABLES = [
    ['agents/agents.json', ['_comment', '_meta_agents', '_worker_agents', 'agents', '_meta']],
    ['config/tool_role_map.json', ['_meta']],
    ['config/dispatch_rules.json', ['_meta', 'self_checker']],
    // agent_cluster.json 里的 dispatch_logic / w7_estimate 是**说明文档**, 不是角色索引
    ['runtime/agent_cluster.json',
      ['_comment', '_meta', 'cluster', 'dispatch_logic', 'w7_estimate']],
  ];
  for (const [rel, allowed] of TABLES) {
    const j = JSON.parse(fs.readFileSync(R(rel), 'utf8'));
    for (const k of Object.keys(j)) {
      assert.ok(!ENGLISH.test(k),
        `${rel} 的键 "${k}" 还是英文 —— 这张表和 ROLES(拼音) 对不上, 按它索引必然落空`);
      assert.ok(allowed.includes(k) || isGuaRole(k),
        `${rel} 的键 "${k}" 既不是将灵也没登记为白名单 —— 加新键必须先想清楚它是不是角色`);
    }
  }
});

test('T2 agents.json 的 8 个键 = ROLES 的 8 个键 = 磁盘上的 8 个模块文件', () => {
  const a = JSON.parse(fs.readFileSync(R('agents/agents.json'), 'utf8'));
  const cfgKeys = Object.keys(a.agents).sort();
  assert.deepStrictEqual(cfgKeys, GUA_CODES.slice().sort(),
    'agents.json 的键必须就是那 8 个拼音 —— 它同时是 /api/agent/run/<name> 的文件表');
  const { ROLES } = require(R('agents/sub-agent'));
  assert.deepStrictEqual(cfgKeys, Object.keys(ROLES).sort(),
    'agents.json 与 ROLES 的键必须一致 —— 不一致就是"8 个是什么"有两个答案');
  // 键 = 文件名: 路由是 path.join(AGENTS_DIR, runName + '.js') 拼出来的
  for (const code of cfgKeys) {
    assert.ok(fs.existsSync(R('agents/' + code + '.js')),
      `agents/${code}.js 不存在 —— 配置里有这个角色, 路由却拼不出它的文件`);
  }
});

test('T3 磁盘上不许再有英文命名的将灵模块 (它们是上一代身份)', () => {
  const OLD = ['analyzer', 'executor', 'checker', 'bug_hunter', 'planner',
    'learner', 'reflector', 'dispatcher', 'synthesizer'];
  for (const n of OLD) {
    assert.ok(!fs.existsSync(R('agents/' + n + '.js')),
      `agents/${n}.js 又回来了 —— 磁盘上出现第二个身份, 路由和 ROLES 会各认一套`);
  }
});

test('T4 ROLE_TIER 必须能被拼音查到 (它曾经整张是死的, 把所有将灵温度压成 0)', () => {
  // 这条钉的是"键空间和 ROLES 一致", 不是具体温度值 —— 温度以后可以调,
  // 但表不能再因为对不上键而全体失效。查不到 = 兜底值在生效 = 表死了。
  const src = fs.readFileSync(R('modules/role_model.js'), 'utf8');
  const m = /const ROLE_TIER = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(m, '找不到 ROLE_TIER');
  const keys = [...m[1].matchAll(/^\s{2}([a-z_]+)\s*:/gm)].map((x) => x[1]);
  assert.deepStrictEqual(keys.slice().sort(), GUA_CODES.slice().sort(),
    'ROLE_TIER 的键必须正好是 8 个拼音 —— 键对不上时 `|| {temperature:0}` 会把每个将灵都压成 0');
});

test('T5 pangu_decide 的显式指定角色路径不许是死的 (两表必须共用一个键空间)', () => {
  // 那条 `roleMap[role] && agentRegistry()[role]` 是"两边都要认这个名字"。
  // 只要有一边换了名字, 它就恒为假, 整条路径静默失效 —— 用户显式指定了角色,
  // 系统却去跑 LLM 分类, 而且不报错。所以直接验两个键空间相等。
  const roleMap = JSON.parse(fs.readFileSync(R('config/tool_role_map.json'), 'utf8'));
  const mapKeys = Object.keys(roleMap).filter((k) => !k.startsWith('_'));
  const { getRegistry } = require(R('agents/registry'));
  const regKeys = Object.keys(getRegistry());
  const onlyInMap = mapKeys.filter((k) => !regKeys.includes(k));
  const onlyInReg = regKeys.filter((k) => !mapKeys.includes(k));
  assert.deepStrictEqual(onlyInMap, [],
    'tool_role_map 有而 registry 没有的角色 —— 显式指定它时 roleMap 命中而 agentRegistry 落空');
  assert.deepStrictEqual(onlyInReg, [],
    'registry 有而 tool_role_map 没有的角色 —— 显式指定它时反过来落空');
});

test('T6 非将灵的键 (self_checker) 不许被当成 role 发出去 (会变空角色)', () => {
  // self_checker 是 dispatch_rules 里的关键词分组, 后端从没注册过这个角色。
  // 它 weight 1.5 且关键词极宽, 不过滤就抢走大量活, 然后 ROLES[...] 查不到。
  assert.ok(!isGuaRole('self_checker'),
    'isGuaRole 竟然认了 self_checker —— 它不是将灵, 认了就能被当 role 派出去');
  assert.strictEqual(resolveRole('self_checker'), null,
    'resolveRole 不该把 self_checker 解析成某个将灵');
  // 消费方两处都装了守卫, 这里钉住守卫真的在
  const single = fs.readFileSync(R('pangu-single.js'), 'utf8');
  assert.match(single, /_isDispatchableGua\s*\(/,
    'pangu-single.js 不见了"只有将灵能当 role"的守卫');
  const decide = fs.readFileSync(R('modules/pangu_decide.js'), 'utf8');
  assert.match(decide, /_isGuaRole\(role\)/,
    'pangu_decide 的关键词打分不许把非将灵的键选成 role');
});

test('T7 工具→将灵的反查不许再手抄, 且结果必须是 CODE_TO_GUA 认得的键', () => {
  // 之前手抄了两份, 值是英文, 喂给只认拼音的 CODE_TO_GUA → 两处指示条全灭。
  const loop = fs.readFileSync(R('modules/j2_agent_loop.js'), 'utf8');
  assert.ok(!/current_time:\s*'(analyzer|executor|checker|dispatcher|planner)'/.test(loop),
    'j2_agent_loop 又出现手抄的英文工具→角色表 —— 反查必须从 ROLES[].tools 来');
  // 真跑一次反查, 验它给出的每个 code 都进得了 CODE_TO_GUA (前端就是拿它对卦的)
  const { CODE_TO_GUA } = require(R('modules/subagent_runs'));
  const { ROLES } = require(R('agents/sub-agent'));
  const derived = {};
  for (const [code, def] of Object.entries(ROLES)) {
    for (const t of def.tools || []) if (!derived[t]) derived[t] = code;
  }
  assert.ok(Object.keys(derived).length > 0, '反查结果是空的');
  for (const [tool, code] of Object.entries(derived)) {
    assert.ok(isGuaRole(code), `工具 ${tool} 反查出 "${code}", 它不是将灵`);
    assert.ok(CODE_TO_GUA[code], `工具 ${tool} 反查出 "${code}", 但 CODE_TO_GUA 里没有它 —— 卦图标会是空的`);
  }
});

test('T8 英文身份一律不认 —— 老板:「说了全部换, 还留着干嘛」', () => {
  // 2026-10-18 第二次翻转。上一版的这条断言是**反过来**的:
  //   "输入解析器认英文, 但身份表不许存英文" —— 理由是「模型先验里全是英文,
  //   入口得读得懂, 否则一刀都没跑、整轮直接废掉」。
  // 老板不接受, 原话是「说了全部换, 还留着干嘛」, 那张表已删。
  //
  // 代价是模型再吐英文角色名会被判未知角色。**这是故意的**: 提示词教的就是拼音
  // (ROLES.kan 明写「只写上面这 6 个拼音」), 模型吐英文说明它没照做 ——
  // 那是一个该被发现的错误, 而不是该被悄悄兜住的细节。
  // 兜住的代价是身份表里永远躺着第二个名字, 而下一个人照着它 grep 又抄第三份。
  //
  // 这条断言现在钉的是"英文一律返回 null", 谁再把 LEGACY_INPUT 加回来就转红。
  for (const en of ['analyzer', 'executor', 'checker', 'bug_hunter', 'planner',
    'reflector', 'dispatcher', 'learner', 'synthesizer', 'bugHunter', 'bughunter']) {
    assert.strictEqual(resolveRole(en), null,
      `resolveRole 竟然认出了英文 "${en}" —— 第二个身份又回来了`);
    assert.strictEqual(isGuaRole(en), false,
      `isGuaRole 竟然认了 "${en}" —— 它可以当 role 派出去, 而下游 ROLES[...] 查不到`);
  }
  // 拼音和卦名必须照常认 —— 不能为了删英文把正常的入口也堵死
  for (const g of require(R('agents/gua-identity')).GUA_ROLES) {
    assert.strictEqual(resolveRole(g.code), g.code, `拼音 ${g.code} 认不出来`);
    assert.strictEqual(resolveRole(g.gua), g.code, `卦名 ${g.gua} 认不出来`);
  }
  // 存储面: 身份表一行只能有拼音
  for (const g of require(R('agents/gua-identity')).GUA_ROLES) {
    assert.ok(!('legacy' in g) && !('name' in g) && !('en' in g),
      g.code + ' 又有第二个名字字段');
  }
  assert.ok(LEGACY_INPUT.size === 8, '拼音名单不该被写坏');
});

test('T8b 只读守卫必须 fail-closed: 认不出的角色名一律按只读处理', () => {
  // 这是删掉英文解析表之后**必须补上的安全缺口**。以前守卫靠"也认英文"兜住:
  // checkRoleAction 对非只读角色返回 ok:true, 也就是「不认识 = 放行」;
  // 而守卫查的是拼音集合, 英文名恒不相等 → checkRoleAction('analyzer','write_file')
  // 返回过 ok:true —— 只读角色静默拿到写盘权, 不报错不留痕。
  // 英文表删了之后那个兜底没了, 所以把失败方向**拧过来**。
  const { isReadOnlyRole } = require(R('agents/gua-identity'));
  const { checkRoleAction } = require(R('modules/action_policy'));
  for (const ro of ['li', '离', 'xun', 'dui', 'zhen']) {
    assert.ok(isReadOnlyRole(ro), `${ro} 是只读角色, 守卫必须认出来`);
  }
  // 旧 checkpoint / 磁盘历史 / 模型乱写: 一律按只读处理
  for (const unknown of ['analyzer', 'executor', '随便什么', '离离', 'BugHunter']) {
    assert.ok(isReadOnlyRole(unknown),
      `认不出的角色名 "${unknown}" 被当成了可写角色 —— 只读边界被静默绕过`);
    const v = checkRoleAction(unknown, 'write_file', {});
    assert.strictEqual(v.ok, false,
      `checkRoleAction('${unknown}','write_file') 返回了 ok:true —— 这就是那个静默绕过`);
  }
  // 但空角色 = 主循环, 不该被误伤 (j2_agent_loop: opts.role || 'main')
  assert.strictEqual(isReadOnlyRole(''), false, '没传角色不该被判只读');
  assert.strictEqual(isReadOnlyRole('main'), false, 'main 是元层角色, 不该受将灵只读边界约束');
});
