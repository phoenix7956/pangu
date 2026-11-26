// 2026-10-18 老板: 「这8个就应该是乾坎艮震巽离坤兑, 英文一个、中文一个…应该统一」
// 「我现在感觉越来越乱」
//
// 乱的根因不是数量, 是**同一份"8 将灵"被手抄了 6 遍, 而且在"乾是谁"上互相矛盾**:
//   ① apps/core/agents/sub-agent.js ROLES        → 注册了 dispatcher, 没有 synthesizer
//   ② sub-agent.js 里那行注释 (:145)             → "乾·dispatcher"
//   ③ 运行时清单 list_pangu_agents (registry.js) → 第 6 份手抄, 写 dispatcher
//   ④ 实跑日志 subagent-runs.jsonl 3289 次        → dispatcher **0 次**, synthesizer **1 次**
//   ⑤ apps/desktop/src/data/gua-roster.js        → 自称"单一真源", 却把乾绑到 synthesizer
//   ⑥ SubAgentPanel.tsx 的 ROLE_ZH               → 又一份手抄, 同样绑 synthesizer, 还多 3 个死条目
//
// ⚠ 2026-10-26 第 107 批 (桌面端下线): ⑤⑥ 随 apps/desktop 一起没了 ——
//   「前端抄了一份身份」这一整类洞**在结构上消失了**(没有前端可抄)。
//   但那两条断言**不能就这么删掉**: 它们守的是「8 将灵的身份只住一处、
//   已废弃的英文角色名不许复活」。⇒ 把它们**泛化**成 core 全仓的守卫:
//     ① 「synthesizer / dispatcher / bugHunter 这些英文角色名全仓不许复活」;
//     ② 「8 将灵身份表只有一份」(不许在别处再摆一张)。
//   这比原来盯一个前端文件**更强** —— 原来只盯一个文件, 换个文件抄照样过。
//
// 而 **synthesizer 在后端根本不是个角色** (全仓只有 pangu-single.js:158 一句注释提到),
// dispatcher 才是注册在册的。所以老板问"8 个是什么", 不同代码路径给不同答案。
//
// 修法: 身份 (卦 / 拼音 code / 图标 / 中文名 / 职责) 只住在 sub-agent.js 的
// GUA_ROLES 里, 其余各处**派生**。本测试钉住"再抄一遍就会漂"这件事。
//
// 真源那张表是 require 进来的 —— 抄错会当场炸, 不是只看字符串。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const CORE = path.join(__dirname, '..');

const subAgent = require(path.join(CORE, 'agents', 'sub-agent'));
const registry = require(path.join(CORE, 'agents', 'registry'));
const GUA_ROLES = subAgent.GUA_ROLES;
const GUA_BY_CODE = subAgent.GUA_BY_CODE;
const ROLES = subAgent.ROLES;

const REG_SRC = fs.readFileSync(path.join(CORE, 'agents', 'registry.js'), 'utf8');
const SINGLE_SRC = fs.readFileSync(
  path.join(CORE, 'pangu-single', '..', 'pangu-single.js'), 'utf8');

const EIGHT_GUA = ['乾', '坎', '艮', '震', '巽', '离', '坤', '兑'];

test('卦象身份表本身: 8 个, 卦/拼音唯一, 且与 ROLES 完全对齐', () => {
  assert.strictEqual(GUA_ROLES.length, 8, '就是 8 将灵, 不多不少');
  assert.strictEqual(new Set(GUA_ROLES.map(r => r.gua)).size, 8, '卦名不能重');
  assert.strictEqual(new Set(GUA_ROLES.map(r => r.code)).size, 8, '拼音 code 不能重');
  // 身份表与真正的角色表必须一一对应 —— 多一个少一个都说明有人在别处偷偷加/删了角色。
  assert.deepStrictEqual(
    GUA_ROLES.map(r => r.code).sort(),
    Object.keys(ROLES).sort(),
    'GUA_ROLES 的 code 集合必须等于 ROLES 的 key 集合');
  // 八卦八个, 一个都不能少。
  assert.deepStrictEqual(
    GUA_ROLES.map(r => r.gua).sort(),
    EIGHT_GUA.slice().sort(),
    '八卦八个卦名必须齐全');
  // 每条都得有拼音 code + 中文名 + 职责。拼音是唯一身份, 不再有第二列英文名。
  for (const r of GUA_ROLES) {
    assert.ok(/^[a-z_]+$/.test(r.code), r.gua + ' 的拼音 code 不合法: ' + r.code);
    assert.ok(r.zh && r.zh.trim(), r.gua + ' 缺中文名');
    assert.ok(r.role && r.role.trim(), r.gua + ' 缺职责');
  }
});

test('反查表跟着真源走 (前端历史上就是按 gua/拼音找角色的)', () => {
  for (const r of GUA_ROLES) {
    assert.strictEqual(GUA_BY_CODE[r.code].gua, r.gua);
    // 拼音和卦名都走 GUA_BY_CODE 一张表 (2026-10-18: GUA_BY_PY / GUA_BY_GUA 已删 ——
    // 那是同一张表拆成三份的同值冗余, 跟 roster 的 id/code 双名同构)。
    assert.strictEqual(GUA_BY_CODE[r.gua].code, r.code);
  }
});

test('运行时清单 (list_pangu_agents 的真源) 必须由 GUA_ROLES 派生, 不许再手抄', () => {
  const cat = registry.getAgentCatalog();
  assert.strictEqual(cat.length, 8);
  // 真跑一遍, 不是看字符串: catalog 的卦象必须和 GUA_ROLES 逐条一致。
  assert.deepStrictEqual(
    cat.map(a => [a.gua, a.code, a.role]),
    GUA_ROLES.map(r => [r.gua, r.code, r.role]),
    'catalog 的卦象身份必须与 GUA_ROLES 一致 —— 不一致就说明有人又抄了一份');
  // 老消费方按 name 取角色, name 必须仍然等于拼音 code。
  assert.deepStrictEqual(
    cat.map(a => a.name),
    GUA_ROLES.map(r => r.code),
    'catalog.name 必须等于拼音 code');
  // 手抄的痕迹: registry.js 不该再有那 8 行 { name: ... } 字面量。
  assert.ok(!/\{ name: '(analyzer|executor|checker)'/.test(REG_SRC),
    'registry.js 里不该再手抄角色字面量 —— 身份只住在 GUA_ROLES');
  // 钉住**机制**而不只是字面量形状: catalog 必须是从 GUA_ROLES map 出来的。
  // (只看字面量形状抓不住"照抄一份一模一样的" —— 那种行为上等价, 只有机制能抓)
  assert.match(REG_SRC, /AGENT_CATALOG = \(\(\) => \{/,
    'AGENT_CATALOG 必须是函数现场构造的');
  assert.match(REG_SRC, /GUA_ROLES\.map\(/,
    'AGENT_CATALOG 必须由 GUA_ROLES.map 派生 —— 出现第二个 AGENT_CATALOG 就是有人又抄了一份');
});

test('全仓不许再出现已废弃的英文角色名 (synthesizer / dispatcher / bugHunter)', () => {
  // 这是本次事故的具体那一条。前端曾把乾绑到 synthesizer, 后端注册的是 dispatcher,
  // 而 synthesizer 全仓只有一句注释 —— 指向一个不存在的角色, 等于指向虚空。
  //
  // ⚠ 2026-10-26 第 107 批: 原来这条盯的是 `apps/desktop/src/data/gua-roster.js`
  //   —— 那个文件随桌面端下线了, 盯它会变成 vacuous(文件不存在 → 守卫自己红,
  //   或者更糟: 被写成「文件不存在就跳过」而**静默失去作用**)。
  //   ⇒ 泛化成**全仓**: 任何文件都不许再把这三个名字当成角色身份用。
  //   这比原来盯一个前端文件**更强** —— 原来只盯一个文件, 换个文件抄照样过。
  //   判据只看**代码**不看注释 —— 注释里留着「当年删的是 synthesizer」是有用的历史记录,
  //   但那三个名字一旦作为**代码**复活就得拦 (与 SHOW_TOOL_CARDS 守卫同一套做法)。
  const GHOSTS = ['synthesizer', 'dispatcher', 'bugHunter'];
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'tests') continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.js')) files.push(f);
    }
  })(CORE);

  const hits = [];
  for (const f of files) {
    const code = fs.readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    for (const g of GHOSTS) {
      // ⚠ 判据要**精确**: 不能拿「全仓出现这个词」判 ——
      //   `dispatcher` 是合法的 API 路径(`/api/pangu/dispatcher`)和类名(`AgentDispatcher`);
      //   `synthesizer` 出现在 j2_dispatcher 的**清理正则**里(那正是修旧名字的地方)。
      //   ⇒ 只判「它被当成**角色 code**」这一种用法。
      if (new RegExp('(code|role_code|roleCode)\\s*:\\s*[\'"]' + g + '[\'"]').test(code)) {
        hits.push(path.relative(CORE, f) + ' → ' + g);
      }
    }
  }
  assert.deepStrictEqual(hits, [],
    '已废弃的英文角色名复活了 (后端根本没这些角色): ' + hits.join(', '));

  // 乾必须绑到 qian (拼音就是唯一身份) —— 真源里逐条钉
  const qian = GUA_ROLES.find((r) => r.gua === '乾');
  assert.ok(qian, 'GUA_ROLES 里没有乾');
  assert.strictEqual(qian.code, 'qian', '乾必须绑到 qian (拼音就是唯一身份)');
  assert.deepStrictEqual(
    GUA_ROLES.map((r) => r.code).sort(),
    Object.keys(ROLES).sort(),
    'GUA_ROLES 的 8 个 code 必须与后端 ROLES 一致');
});

test('拼音 code 必须等于配置里的 role_configs key (改错 = 整份配置对不上角色)', () => {
  // pinyin 不是装饰: pangu-single.js 的 SUB_AGENT_DEFAULTS 和
  // config.agent.role_configs 都是按 qian/kan/li/kun/dui/xun/zhen/gen 建的键
  // (实测 your-mac.json 的 role_configs key 正是这 8 个)。
  // 身份表里把 dui 写成 duiX, 表本身自洽, 但**配置那 8 项会全部落空** ——
  // 每个将灵都退回默认档位, 而界面上看不出任何异常。所以这条得钉死。
  const defaultsBlock = SINGLE_SRC.slice(
    SINGLE_SRC.indexOf('const SUB_AGENT_DEFAULTS'),
    SINGLE_SRC.indexOf('const SUB_AGENT_DEFAULTS') + 4000);
  const configIds = [...defaultsBlock.matchAll(/^\s{4}([a-z]+):\s*\{/gm)].map(m => m[1]);
  assert.ok(configIds.length >= 8,
    '没从 pangu-single.js 解析出 SUB_AGENT_DEFAULTS 的键 —— 解析方式变了要更新本测试');
  assert.deepStrictEqual(
    GUA_ROLES.map(r => r.code).sort(),
    configIds.slice(0, 8).sort(),
    'GUA_ROLES 的 pinyin 必须等于 SUB_AGENT_DEFAULTS 的键 —— 对不上整份 role_configs 会落空');
});

test('8 将灵身份表只有一份 (不许在别处再摆一张)', () => {
  // ⚠ 2026-10-26 第 107 批: 这条原来盯的是 `SubAgentPanel.tsx` 里的
  //   `ROLE_ZH` / `ROLE_ICONS` 两张手抄表 —— 界面没了, 表也不存在了。
  //   ⇒ 泛化成**全仓**: 8 将灵的身份表只许住在 `agents/gua-identity.js` 一处。
  //   (原意图是「不许有人再抄一份」, 盯一个前端文件只能防住那一个文件。)
  // 历史残留的三个角色: 前后端都不存在。
  // 只看**代码**不看注释 —— 注释里留着"当年删的是哪三个"是有用的历史记录,
  // 但那三个名字一旦作为代码复活就得拦 (与 SHOW_TOOL_CARDS 守卫同一套做法)。
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'tests') continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.js')) files.push(f);
    }
  })(CORE);
  const codeOf = (f) => fs.readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

  for (const ghost of ['scribe', 'scout', 'judge']) {
    for (const f of files) {
      // ⚠ 同上: 精确到「被当成角色 code」。
      //   `judge` 在 `64i/bagua_annotations/layer_plan.js` 里是**术数层名**(judge 层),
      //   跟将灵身份无关 —— 拿「全仓出现这个词」判会误伤。
      assert.ok(!new RegExp('(code|role_code|roleCode)\\s*:\\s*[\'"]' + ghost + '[\'"]').test(codeOf(f)),
        ghost + ' 在前后端都不该存在, 纯历史残留 (' + path.relative(CORE, f) + ')');
    }
  }

  // 「8 将灵身份表」只许有一份: 谁把 8 个 code 摆成一张表, 谁就是第二真源。
  const copies = [];
  for (const f of files) {
    const code = codeOf(f);
    if (f.endsWith(path.join('agents', 'gua-identity.js'))) continue;   // 真源
    const codes = [...code.matchAll(/code:\s*'([a-z]+)'/g)].map(m => m[1]);
    if (EIGHT_GUA.every((g) => code.includes("'" + g + "'")) && codes.length >= 8) {
      copies.push(path.relative(CORE, f));
    }
  }
  assert.deepStrictEqual(copies, [],
    '8 将灵身份表在别处还有一份: ' + copies.join(', ')
    + ' —— 铁律「一份东西抄两遍 = 迟早只改其中一份」');
});
