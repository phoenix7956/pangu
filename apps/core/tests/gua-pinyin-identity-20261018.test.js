'use strict';

// 2026-10-18 (老板: 「这8个就应该是乾坎艮震巽离坤兑, 英文一个、中文一个」
//                   「应该统一」「还有英文 code 要换成拼音」)
//
// 这条护栏钉住拼音迁移里**三件最容易悄悄回归**的事。它们都不会抛异常,
// 只会让面板空一格、或者让只读角色静默拿到写盘权:
//
//   P1 身份归一必须认**三种**写法 (拼音 / 历史英文 / 中文卦名)。
//      只认一种的后果各不相同: 只认拼音 → 模型吐 analyzer 时 validateTasks
//      判"未知角色" → **一刀都没跑, 整轮直接废掉** (自己造了个新故障);
//      只认英文 → 拼音传进只读守卫恒不相等 → 闸门静默失效。
//
//   P2 ROLES 挂了拼音别名, 但**必须不可枚举**。默认属性可枚举的话,
//      Object.keys(ROLES) 会返回 16 个键 —— 发给 planner 的角色清单里每个
//      将灵出现两次, 老板刚问明白"8 个是什么"就又变成 16 个。
//
//   P3 历史 3545 行**英文**日志必须照样能聚合。索引换成拼音而读取侧没归一,
//      UI 上 8 将灵会齐刷刷显示"今天 0 次运行", 而磁盘上明明有 958 次 executor
//      —— 这是本次迁移里最容易"测试全绿、数据却没了"的一处。
//
// ── 2026-10-26 第 107 批 (桌面端下线) ──
// 原来 P1b 末尾和 P4 整条都在查 `apps/desktop/src/data/gua-roster.js`
// (前端那份手抄的身份表)。桌面端下线后那个文件没了, 两条一起处理:
//   · P1b 的"前端 roster 也不许存 legacy" → 删。前端已不存在, 而**服务端**
//     的身份唯一真源是 agents/gua-identity.js, 本文件其余各条都在守它。
//   · P4 整条 (前端 code 必须是拼音 / 不许长 id 字段 / ID_TO_GUA 不许复活)
//     → 删。同一个风险的**服务端那一半**, 由 P1b (身份表字段集)
//     + P2 (Object.keys(ROLES) 恰好 8 个) + P2b (归一后落到真实角色)
//     + P3c (英文 code 不许被翻译回来) 继续守着, 一条都没松。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {GUA_ROLES, GUA_CODES, resolveRole, isReadOnlyRole} = require(path.join(ROOT, 'agents', 'gua-identity.js'));
const { ROLES } = require(path.join(ROOT, 'agents', 'sub-agent.js'));
const { checkRoleAction } = require(path.join(ROOT, 'modules', 'action_policy.js'));
const { normalizeTasks, validateTasks } = require(path.join(ROOT, 'modules', 'dispatch_subagents_exec.js'));

const PAIYIN = ['qian', 'kan', 'gen', 'zhen', 'xun', 'li', 'kun', 'dui'];
const GUA = ['乾', '坎', '艮', '震', '巽', '离', '坤', '兑'];

test('P1 8 将灵身份齐全, 且拼音/英文/卦名三种写法都能归一', () => {
  assert.strictEqual(GUA_ROLES.length, 8, '8 将灵必须是 8 个 —— 少一个或多一个都不叫统一');
  const byPy = GUA_CODES.slice().sort();
  assert.deepStrictEqual(byPy, [...PAIYIN].sort(), '拼音名单对不上');
  const byGua = GUA_ROLES.map((g) => g.gua).sort();
  assert.deepStrictEqual(byGua, [...GUA].sort(), '卦名名单对不上');
  for (const g of GUA_ROLES) {
    assert.strictEqual(resolveRole(g.code), g.code, '拼音认不出: ' + g.code);
    assert.strictEqual(resolveRole(g.gua), g.code, '卦名认不出: ' + g.gua);
    assert.strictEqual(resolveRole(g.code.toUpperCase()), g.code, '大写拼音认不出: ' + g.code);
  }
  // 认不出来必须返回 null 而不是猜一个 —— 猜错的话一把错刀会以合法身份真跑起来
  assert.strictEqual(resolveRole('bogus'), null);
  assert.strictEqual(resolveRole(''), null);
  assert.strictEqual(resolveRole(null), null);
});

test('P1b 身份表里不许再有第二个名字 —— 老板:「不要别名, 越多越乱」', () => {
  // 这一条钉死"只有拼音一个名字"。以前身份表里躺着一列 legacy 英文名, 于是
  // GUA_ROLES / CODE_TO_GUA / ROLES / 前端 roster 各抄一份、每份都带或不带那列英文 ——
  // 这正是"8 个是什么"在五个地方给五个答案的根源。名字只能有一个。
  for (const g of GUA_ROLES) {
    assert.ok(!('legacy' in g), g.code + ' 又有 legacy 字段了 —— 第二个名字回来了');
    // 2026-10-18: 上一版写的是 `!('code' in g) || g.code === g.code` —— 它**允许**
    // code 和 pinyin 两个字段同时存在 (只要值一样就算过)。那正是同构 bug:
    // 同一个角色两个字段名, 改一处忘另一处就静默漂移 (roster 的 id/code 就是这么坏的)。
    // 所以现在钉死字段集: 只有 code, 拼音身份只能存在这一个字段里。
    assert.ok(!('pinyin' in g),
      g.code + ' 又有 pinyin 字段了 —— code 和 pinyin 同值双名, 第二个名字回来了');
    assert.ok(!('id' in g), g.code + ' 又有 id 字段了 —— 第二个名字回来了');
  }
});

test('P2 ROLES 的键就是那 8 个拼音, 对外枚举不多不少', () => {
  assert.strictEqual(Object.keys(ROLES).length, 8,
    'Object.keys(ROLES) 必须还是 8 个 —— 多一个别名就会变成 16 个, '
    + '而这份清单直接进 planner/dispatcher 的 prompt 和前端 API');
  const keys = Object.keys(ROLES).sort();
  assert.deepStrictEqual(keys, [...PAIYIN].sort(), 'ROLES 的键必须就是那 8 个拼音');
  for (const c of PAIYIN) {
    assert.ok(ROLES[c], 'ROLES 里没有: ' + c);
  }
});

test('P2b 模型吐任何一种写法, 都能落到同一个角色的工具白名单', () => {
  // 这是迁移真正的目的: 模型写 analyzer / 离 / Analyzer 都跑同一档权限。
  for (const g of GUA_ROLES) {
    for (const written of [g.code, g.gua, g.code.toUpperCase(), ' ' + g.code + ' ']) {
      const t = normalizeTasks({ tasks: [{ agent: written, task: 'x' }] })[0];
      assert.ok(t, 'normalizeTasks 把 ' + JSON.stringify(written) + ' 丢了');
      assert.strictEqual(t.agent, g.code,
        '模型写 ' + JSON.stringify(written) + ' 被归一成 ' + t.agent + ', 应为 ' + g.code);
      // 落到真实角色上 = 白名单真的接上了。查不到会走"未知角色"分支降级成
      // 无白名单全量工具 —— 只读角色到那一步就等于拿到写盘权。
      assert.ok(ROLES[t.agent], '归一后 ROLES 查不到: ' + written);
    }
  }
});

test('P3 只读守卫认三种写法 —— 拼音传进去不能静默放行', () => {
  const RO = GUA_ROLES.filter((g) => isReadOnlyRole(g.code));
  assert.strictEqual(RO.length, 4, '只读角色应该是 4 个 (离巽兑震)');
  for (const g of RO) {
    for (const written of [g.code, g.gua]) {
      const w = checkRoleAction(written, 'write_file', {});
      assert.strictEqual(w.ok, false, written + ' 拿到了 write_file —— 只读边界被穿透');
      assert.strictEqual(w.code, 'ROLE_READ_ONLY', written + ' 的拒绝码不对');
      // shell 写法同样必须挡住 (只测 write_file 的话, exec_command 那条缺口测不出来)
      const sh = checkRoleAction(written, 'exec_command', { command: 'rm -rf /tmp/x' });
      assert.strictEqual(sh.ok, false, written + ' 的 rm -rf 没被拦');
    }
  }
  // 可写角色反过来必须放行 —— 守卫不能为了"保险"把 executor 也焊死
  for (const g of GUA_ROLES.filter((x) => !isReadOnlyRole(x.code))) {
    assert.strictEqual(checkRoleAction(g.code, 'write_file', {}).ok, true,
      g.code + ' 是可写角色, 却被只读守卫误伤');
  }
});

test('P3b 可派角色只有 6 个 —— qian/kan 无工具, 派下去必然白烧一轮', () => {
  for (const bad of ['qian', '乾', 'dispatcher', 'kan', '坎', 'planner']) {
    const errs = validateTasks([{ agent: bad, task: 'x' }]);
    assert.ok(errs.length, bad + ' 不该出现在可派清单里 (tools=[] 的角色派了也跑不动)');
  }
  for (const ok of ['li', 'kun', 'dui', 'xun', 'zhen', 'gen']) {
    assert.strictEqual(validateTasks([{ agent: ok, task: 'x' }]).length, 0, ok + ' 该能派');
  }
});

test('P3c 拼音日志照常聚合, 英文行不再被翻译 (数据已迁, 表已删)', () => {
  // 用临时 HOME 隔离, 不碰老板的真数据。
  //
  // 2026-10-18: 原来这里写的是**英文** code 日志, 断言它们照样聚合成 kun/li,
  // 因为当时 modules/subagent_runs.js 挂着 LEGACY_RUN_CODE 翻译表。
  // 现在: 老板的账本已经用一次性脚本迁成拼音 (实测 4161 行, 英文 0 行),
  // 翻译表删了, 所以这里改成拼音输入; 并**额外**钉住"英文行不再被救回来"。
  const realHome = os.homedir();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gua-pinyin-'));
  const savedHome = process.env.HOME;
  process.env.HOME = tmp;
  let digestFn;
  try {
    fs.mkdirSync(path.join(tmp, '.pangu'), { recursive: true });
    const ts = new Date().toISOString();
    fs.writeFileSync(path.join(tmp, '.pangu', 'subagent-runs.jsonl'),
      [
        { ts, kind: 'start', code: 'kun', gua: '坤', task: 't1' },
        { ts, kind: 'done', code: 'kun', gua: '坤', task: 't1' },
        { ts, kind: 'start', code: 'li', gua: '离', task: 't2' },
      ].map((o) => JSON.stringify(o)).join('\n') + '\n');
    // 清掉模块缓存, 让它重读 RUNS_FILE
    for (const k of Object.keys(require.cache)) {
      if (k.includes(path.join('modules', 'subagent_runs'))) delete require.cache[k];
    }
    digestFn = require(path.join(ROOT, 'modules', 'subagent_runs.js')).digest;
    const d = digestFn(3);
    assert.strictEqual(d.by_code.kun.runs_today, 2,
      'kun 的两条记录没聚合上 —— 索引键空间和写入侧对不上');
    assert.strictEqual(d.by_code.li.runs_today, 1, 'li 没聚合上');
    assert.strictEqual(Object.keys(d.by_code).length, 8, 'digest 必须还是 8 格');

    // 英文行现在**读不出来**。这是有意的: 表删了, 数据也迁了。
    // 留着这条是为了让"谁又把英文表加回来"当场变红 —— 而不是等它悄悄回来。
    fs.writeFileSync(path.join(tmp, '.pangu', 'subagent-runs.jsonl'),
      [
        { ts, kind: 'start', code: 'executor', gua: '坤', task: 't1' },
        { ts, kind: 'done', code: 'executor', gua: '坤', task: 't1' },
      ].map((o) => JSON.stringify(o)).join('\n') + '\n');
    for (const k of Object.keys(require.cache)) {
      if (k.includes(path.join('modules', 'subagent_runs'))) delete require.cache[k];
    }
    const d2 = require(path.join(ROOT, 'modules', 'subagent_runs.js')).digest(3);
    assert.strictEqual(d2.by_code.kun.runs_today, 0,
      '英文 code 又被翻译成 kun 了 —— LEGACY_RUN_CODE 那张表回来了? '
      + '数据已经迁完, 这张表是纯冗余 (老板:「说了全部换, 还留着干嘛」)');
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    for (const k of Object.keys(require.cache)) {
      if (k.includes(path.join('modules', 'subagent_runs'))) delete require.cache[k];
    }
    void realHome;
  }
});

