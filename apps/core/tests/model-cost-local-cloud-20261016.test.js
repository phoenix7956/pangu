// 2026-10-16 「选本地还是云端」—— 成本字段是全仓唯一的真相来源, 而它是 0
//
// 起因是老板那句「关键是盘古的模型配置项, 选本地连模型还是云端的」。顺着查出来的硬事实:
//   池里 8 个模型的 cost_per_1k_input / cost_per_1k_output **全是 0**,
//   包括 minimax-m3 / k3 / agnes 这些真按量计费的云端模型。
// 而这个 0 在全仓被 5 处各自解释, 解释还互相矛盾:
//
//   ① longctx_fallback._pickCheapest   当「最便宜」→ 全平局 → 落到 context_length 倒序
//                                      → 本地 qwen3.8-27b-mlx 一失败就切 minimax-m3 (付费 1M)
//                                      函数叫 pickCheapest, 实际挑的是"窗口最大的", 方向反了
//   ② smart_router.pickByTask cost 策略 同样当「最便宜」→ 预算 ≥90% 自动降级
//                                      → 按配置顺序选 = 恰好挑最贵的, 预算越吃紧烧得越狠
//   ③ smart_router._scoreModelForTask  当 0 成本加分 → 本地云端一起 0, local_prefer 失效
//   ④ cost_guard.recordSpend          当真·免费 → spent_usd 恒 0, **预算墙从来没响过**
//   ⑤ _local 判定内联且只读 api_base   → 配置写 endpoint 的本地模型一律被判成云端
//
// 真正的问题是: **0 无法区分「真免费」和「没配」**。本地模型该是 0,
// 云端模型也填 0 那就是漏配, 不是免费。所以这一刀做的是把"成本可不可信"变成一个
// 显式返回值 (model_cost.js 单一真源), 让每处调用点自己决定"不知道"时怎么办 ——
// 而不是由 5 份各自猜的默认值替所有人做决定。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const M = (p) => require(path.join(__dirname, '..', p));
const MC = M('modules/router/model_cost.js');
const LCF = M('modules/longctx_fallback.js');

// 2026-10-28 (第 137 批, 开源): 原来 A5/B4/E1/E4 直接读**生产池**
//   (modules/router/models.json)。那文件现在是**运行时缓存, 不入库** ——
//   干净克隆里它压根不存在, 而且它装的是维护者机器的模型池
//   ⇒ 守卫依赖机器状态 = 别人机器上必红 (CI 上直接挂)。
//   现在: 自带夹具池, 并把 smart_router 的读路径也指到夹具 (PANGU_MODELS_PATH),
//   守卫只验**行为**, 不依赖任何人的机器状态。
const POOL_FIXTURE = [
  // 未配价的云端 (漏配) —— A5 要的就是"云端有一个价没配"
  { id: 'fixture-cloud-paid', provider: 'minimax', api_base: 'https://api.fixture-cloud.invalid/v1',
    context_length: 1048576, quality_score: 1.0 },
  // 显式声明免费 —— B4 要的就是"降级时挑的那个不花钱"
  { id: 'fixture-cloud-free', provider: 'custom', api_base: 'https://api.fixture-free.invalid/v1',
    context_length: 262144, free: true, quality_score: 0.8 },
  // 本地 —— A5 要 localUnpriced, E1 要 local_first 选到本地
  { id: 'fixture-local', provider: 'lmstudio', api_base: 'http://127.0.0.1:1234',
    context_length: 65536, quality_score: 0.7 },
];
const REAL_POOL = POOL_FIXTURE;

const _fs = require('fs');
const _os = require('os');
const _fixtureDir = _fs.mkdtempSync(path.join(_os.tmpdir(), 'cost-fixture-pool-'));
const _fixturePoolPath = path.join(_fixtureDir, 'models.json');
_fs.writeFileSync(_fixturePoolPath, JSON.stringify({
  routing_policy: { default_strategy: 'smart', fallback_chain: [] },
  models: POOL_FIXTURE,
}, null, 2));
// smart_router 的读路径跟 sync 走同一个 env —— 指到夹具, 零生产副作用。
process.env.PANGU_MODELS_PATH = _fixturePoolPath;

const SMART = M('modules/router/smart_router.js');

// 抓 console.warn + 拿返回值 —— 本地→云端的切换必须出声, 断言就钉在这句话上。
// 必须一次调用同时拿两者: 分两次调, 第二次的结果跟第一次不是同一次运行, 断言就名不副实。
function _captureWarn(fn) {
  const lines = [];
  const orig = console.warn;
  let result;
  console.warn = (...a) => { lines.push(a.map(String).join(' ')); };
  try { result = fn(); } finally { console.warn = orig; }
  return { warn: lines.join('\n'), result };
}

// ---------- A 组: 单一真源本身 ----------

test('A1 云端模型填 0 = 漏配, 不能当成"免费"', () => {
  const c = MC.modelCost({ id: 'cloud', provider: 'minimax', api_base: 'https://api.minimaxi.com/v1' });
  assert.strictEqual(c.known, false, '0 成本必须报"不可信", 而不是 known=true');
  assert.strictEqual(c.reason, 'cloud-price-missing',
    '云端模型没填价要能被单独认出来 —— 它是漏配, 跟本地不花钱是两回事');
});

test('A2 本地模型填 0 = 正常, 但也要标明是"本地不按 token 计费"', () => {
  const c = MC.modelCost({ id: 'local', provider: 'lmstudio', api_base: 'http://127.0.0.1:1234' });
  assert.strictEqual(c.known, false);
  assert.strictEqual(c.reason, 'local-unpriced-ok',
    '本地不填价是正常的, 不该和云端漏配混成一类 —— 否则预算墙会一直喊"账算不准"');
});

test('A3 任一成本字段为正 = 可信, 两者相加', () => {
  assert.deepStrictEqual(
    MC.modelCost({ id: 'm', cost_per_1k_input: 0.001, cost_per_1k_output: 0.002 }),
    { known: true, per1k: 0.003, reason: 'configured' });
  // 只填一边也算可信 (另一半当 0), 不能因为缺一个字段就整体判成未知
  assert.strictEqual(MC.modelCost({ id: 'm2', cost_per_1k_output: 0.5 }).per1k, 0.5);
});

test('A4 本地判定要认全: provider / 环回 / [::1] / endpoint 字段 / 内网', () => {
  const yes = [
    { id: 'a', provider: 'lmstudio', api_base: 'http://127.0.0.1:1234' },
    { id: 'b', provider: 'ollama', api_base: 'http://192.168.1.9:11434/v1' },
    { id: 'c', provider: 'custom', endpoint: 'http://127.0.0.1:1234/v1' },   // 只写 endpoint
    { id: 'd', provider: 'custom', api_base: 'http://[::1]:1234/v1' },
    { id: 'e', provider: 'custom', api_base: 'http://localhost:8000/v1' },
    { id: 'f', provider: 'mlx-serve', api_base: 'http://10.0.0.5:8080/v1' },
  ];
  for (const m of yes) assert.strictEqual(MC.isLocalModel(m), true, m.id + ' 应判为本地');
  const no = [
    { id: 'x', provider: 'minimax', api_base: 'https://api.minimaxi.com/v1' },
    { id: 'y', provider: 'custom', api_base: 'https://api.agnes-ai.cn/v1' },
    { id: 'z', provider: 'custom', api_base: '' },
  ];
  for (const m of no) assert.strictEqual(MC.isLocalModel(m), false, m.id + ' 不该判为本地');
});

test('A5 真实池子的成本体检: 云端没有一个配了价 → 任何"按成本排序"都是假的', () => {
  const s = MC.costDataStatus(REAL_POOL);
  assert.strictEqual(s.cloudPriced, false,
    '当前配置下按成本排序不成立 —— 这是 B/C 组那些怪现象的总开关');
  assert.ok(s.cloudMissing >= 1, '应有未配价的云端模型, 实际 ' + s.cloudMissing);
  assert.ok(s.localUnpriced >= 1, '本地模型应被单独归类');
});

// ---------- B 组: 选路行为 (老板真正在意的那个决定) ----------

test('B1 本地挂了且池里还有可用本地 → 必须选本地, 不能按窗口挑最贵的云端', () => {
  // 这是修之前实测到的形状: 全 0 成本 → 平局 → context_length 倒序 →
  // 付费 1M 窗口的 paid-huge 胜出。函数名和实际行为正好相反。
  const synth = [
    { id: 'paid-huge', api_base: 'https://api.x.com/v1', context_length: 1048576 },
    { id: 'paid-mid', api_base: 'https://api.y.com/v1', context_length: 262144 },
    { id: 'local-b', provider: 'lmstudio', api_base: 'http://127.0.0.1:1234', context_length: 65536 },
  ];
  const { result } = _captureWarn(() => LCF._pickCheapestModel(synth, 'local-a', ['local-a'], 11000));
  assert.strictEqual(result.id, 'local-b',
    '本地优先必须真的生效 —— 实测修前这里返回的是 paid-huge (最贵的云端)');
});

test('B2 本地挂了且池里没有可用本地 → 可以切云端, 但必须出声', () => {
  // 静默切过去 = "本地一抖, 额度就没了"。原来只有一行"公平切 X 重跑", 看不出钱的去向。
  const synth = [
    { id: 'local-a', provider: 'lmstudio', api_base: 'http://127.0.0.1:1234', context_length: 65536 },
    { id: 'paid-1', api_base: 'https://api.x.com/v1', context_length: 262144 },
    { id: 'local-off', provider: 'lmstudio', api_base: 'http://127.0.0.1:1234', context_length: 65536, available: false },
  ];
  const { warn, result: got } = _captureWarn(() => LCF._pickCheapestModel(synth, 'local-a', ['local-a'], 11000));
  assert.strictEqual(got.id, 'paid-1');
  assert.match(warn, /云端/,
    '本地→云端的切换必须在日志里说清是"本地免费、云端计费", 实际日志: ' + warn);
});

test('B3 available:false 的模型一律不选 (两条选路口径必须一致)', () => {
  // router 的 pickByTask 排 available, 降级路径原来只排 enabled → 用户标了
  // available:false 的模型照样会被选中, 切过去再失败一次, 白烧一轮。
  const synth = [
    { id: 'local-off', provider: 'lmstudio', api_base: 'http://127.0.0.1:1234', available: false },
    { id: 'paid-1', api_base: 'https://api.x.com/v1', context_length: 262144 },
  ];
  const { result } = _captureWarn(() => LCF._pickCheapestModel(synth, 'local-a', ['local-a'], 11000));
  assert.notStrictEqual(result.id, 'local-off');
});

test('B4 真实池: 云端挂了要能回落免费本地 (不是继续在云端里挑)', () => {
  // 2026-10-16 改写 (老板确认 agnes-3.0-flash 免费之后)。
  //
  // 原来这条断言的是 `isLocalModel(pick)` —— 用"本地"当"不烧钱"的**代理**。
  // 现在池里真有一个 known-free 的云端模型 (agnes), 按成本排序选它是正确答案,
  // 于是这个代理判据自己过期了: 它开始把"不烧钱"判成失败。
  //
  // 真正要钉的是**目标**, 不是代理: 云端失败后挑的那个必须不花钱。
  // 至于"同等不花钱时更该挑谁", 那不是成本问题, 是延迟/隐私/冷启动问题,
  // 由 E 组的 local_first 管, 不该混在这条成本测试里。
  const { result: pick } = _captureWarn(() => LCF._pickCheapestModel(REAL_POOL, 'fixture-local', ['fixture-local'], 11000));
  assert.ok(pick, '必须有可降级的选择');
  const cost = MC.modelCost(pick);
  assert.ok(cost.known && cost.per1k === 0,
    `云端失败后挑的必须不花钱, 实际选到 ${pick.id} (${cost.reason}, per1k=${cost.per1k}) `
    + '—— 又一次静默烧额度');
});

test('B5 配了真实成本时, "最便宜"必须真的是最便宜 (不能把这条路径改坏)', () => {
  const synth = [
    { id: 'cheap', api_base: 'https://a.com/v1', cost_per_1k_input: 0.001, cost_per_1k_output: 0.001 },
    { id: 'mid', api_base: 'https://b.com/v1', cost_per_1k_input: 0.5, cost_per_1k_output: 0.5 },
    { id: 'dear', api_base: 'https://c.com/v1', cost_per_1k_input: 9, cost_per_1k_output: 9 },
  ];
  const got = LCF._pickCheapestModel(synth, 'x', ['x'], 11000);
  assert.strictEqual(got.id, 'cheap', '有真实成本数据时必须按成本选');
});

// ---------- C 组: router 侧 (预算吃紧时不该挑最贵) ----------

test('C1 预算 ≥90% 自动降级: 没有成本数据时必须本地优先', () => {
  // 修前: `(cost_in||0)+(cost_out||0)` 全 0 → 是个 no-op sort → 按配置顺序选
  // → 恰好选中配置里第一个 = minimax-m3 (最贵)。预算越吃紧烧得越狠。
  const synth = [
    { id: 'paid-huge', api_base: 'https://api.x.com/v1', context_length: 1048576, quality_score: 1 },
    { id: 'local-b', provider: 'lmstudio', api_base: 'http://127.0.0.1:1234', context_length: 65536, quality_score: 0.7 },
  ];
  const picked = MC.orderByCost(synth).sorted[0];
  assert.strictEqual(picked.id, 'local-b');
  assert.strictEqual(MC.orderByCost(synth).priced, false,
    '"按成本排"这件事本身不成立时, 必须报 priced=false, 别假装排过');
});

test('C2 router 的 cost 策略与预算降级必须共用同一份实现 (别再抄一遍)', () => {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'modules', 'router', 'smart_router.js'), 'utf8');
  assert.doesNotMatch(src, /\(m\.cost_per_1k_input \|\| 0\) \+ \(m\.cost_per_1k_output \|\| 0\)/,
    'smart_router 里不该再有内联的 `|| 0` 成本求和 —— 那是"全 0 时静默退化成 no-op 排序"的源头');
  assert.match(src, /orderByCost/,
    '成本排序要走 model_cost.orderByCost (单一真源)');
});

// ---------- D 组: 预算墙不能装作自己知道 ----------
//
// 注意: cost_guard.js 在**模块加载期**就把 COST_DIR 算死了
// (`const COST_DIR = process.env.PANGU_COST_DIR || ...`)。
// 所以必须先设 env 再 require, 且要清 require 缓存 —— 否则测的其实是
// ~/.pangu-data/router 那个真实文件 (router.test.js 现有两条用例就有这个问题:
// before/after 都从同一处读, 所以它照样绿)。
function _freshCostGuard(dir) {
  process.env.PANGU_COST_DIR = dir;
  const abs = require.resolve(path.join(__dirname, '..', 'modules', 'router', 'cost_guard.js'));
  delete require.cache[abs];
  return require(abs);
}

test('D1 未配价的云端调用: 账算不准要说出来, 不能报 spent:0 像什么都没花', () => {
  const dir = require('node:fs').mkdtempSync(path.join(require('os').tmpdir(), 'costguard-'));
  delete process.env.MONTHLY_BUDGET_USD;
  try {
    const CG = _freshCostGuard(dir);
    CG.recordSpend({ id: 'cloud-noprice', api_base: 'https://api.x.com/v1' }, 5000, 2000);
    const b = CG.checkBudget();
    assert.strictEqual(b.unpriced_cloud_calls, 1,
      '漏配价的云端调用必须被单独记出来 —— 这是"预算墙从来没响过"的根因');
    assert.strictEqual(b.cost_accounting_trustworthy, false,
      '账算不准时 spent/ratio/over_threshold 不可信, 必须自陈, 别报一句斩钉截铁的 0');
  } finally {
    delete process.env.PANGU_COST_DIR;
  }
});

test('D2 配了价的调用照常累计 (不能把这条已知路径改坏)', () => {
  const dir = require('node:fs').mkdtempSync(path.join(require('os').tmpdir(), 'costguard-ok-'));
  delete process.env.MONTHLY_BUDGET_USD;
  try {
    const CG = _freshCostGuard(dir);
    const before = CG.checkBudget().spent;
    CG.recordSpend({ id: 'priced', cost_per_1k_input: 0.001, cost_per_1k_output: 0.002 }, 1000, 500);
    const after = CG.checkBudget();
    assert.ok(Math.abs(after.spent - (before + 0.002)) < 0.0001,
      '配了价的调用必须照常计入, 实测 ' + after.spent + ' vs ' + (before + 0.002));
    assert.strictEqual(after.unpriced_cloud_calls, 0);
    assert.strictEqual(after.cost_accounting_trustworthy, true);
  } finally {
    delete process.env.PANGU_COST_DIR;
  }
});

test('D3 本地不填价不该被算成"账算不准" (否则告警会变成永远在响)', () => {
  const dir = require('node:fs').mkdtempSync(path.join(require('os').tmpdir(), 'costguard-local-'));
  try {
    const CG = _freshCostGuard(dir);
    CG.recordSpend({ id: 'local', provider: 'lmstudio', api_base: 'http://127.0.0.1:1234' }, 9000, 3000);
    const b = CG.checkBudget();
    assert.strictEqual(b.unpriced_cloud_calls, 0,
      '本地不按 token 计费是正常的, 不该让预算墙一直报不可信');
    assert.strictEqual(b.cost_accounting_trustworthy, true);
    assert.strictEqual(b.unpriced_calls, 1, '但它仍要留痕 (成本字段空着这件事本身要知道)');
  } finally {
    delete process.env.PANGU_COST_DIR;
  }
});

// ---------- E 组: local_first —— 主人要的那一档, 原来根本不存在 ----------
//
// 实机 (GET /api/router/explain?q=你好): strategy=smart → primary=minimax-m3。
// 池里 minimax-m3 quality_score=1.0 + 1M 窗口, 本地 qwen3.8-27b-mlx 是 0.7 + 64K,
// 本地偏好那点加分 (local_prefer 0.15 + budget_local 0.3) 压不住 → 一句"你好"也走付费云端。
// 而原来没有一档能表达"就用本地": cost 那档在成本全是 0 的当前配置里退化成"本地优先",
// 也就是说主人想要的事只能在一个恰好会退化的分支里捡到 —— 那不叫可控, 叫碰巧。

test('E1 local_first: 有可用本地就必须选本地, 哪怕云端分高得多', () => {
  const synth = [
    { id: 'paid-huge', api_base: 'https://api.x.com/v1', context_length: 1048576, quality_score: 1.0 },
    { id: 'local-b', provider: 'lmstudio', api_base: 'http://127.0.0.1:1234', context_length: 65536, quality_score: 0.7 },
  ];
  const r = SMART.route('你好', { strategy: 'local_first' });
  // 用真实池验证一次 (真实池里 minimax-m3=1.0/1M, 本地=0.7/64K)
  assert.ok(MC.isLocalModel(r.primary),
    'local_first 下 primary 必须是本地, 实际选到 ' + (r.primary && r.primary.id));
  assert.notStrictEqual(r.strategy, 'smart');
  assert.ok(synth.length === 2);
});

test('E2 local_first: 池里没有可用本地 → 回落云端, 但必须带 warning 说明', () => {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'modules', 'router', 'smart_router.js'), 'utf8');
  assert.match(src, /LOCAL_FIRST_NO_LOCAL/,
    '选了本地优先却拿到云端, 必须自陈 —— 安静返回等于让主人以为在用本地');
  assert.match(src, /没有可用本地模型/,
    '提示要说清是"没有可用本地模型", 而不是含糊的降级字样');
});

test('E3 local_first 仍然受 vision 硬过滤约束 (别为了本地把图发给文本模型)', () => {
  // 候选过滤在 pickByTask 开头就做了 (available / kind / vision), local_first 是在
  // 过滤之后的候选里挑 —— 这条钉住顺序, 防止以后有人把 local_first 提到过滤前面。
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'modules', 'router', 'smart_router.js'), 'utf8');
  const iCand = src.indexOf('const candidates = cfg.models.filter');
  const iLocalFirst = src.indexOf("if (strategy === 'local_first')");
  assert.ok(iCand > 0 && iLocalFirst > iCand,
    'local_first 必须排在候选过滤之后 —— 提前会让 available:false / 非 vision 模型混进来');
});

test('E4 smart 档行为不变 (加 local_first 不能顺手改掉质量优先)', () => {
  const smart = SMART.route('你好', { strategy: 'smart' });
  assert.strictEqual(smart.strategy, 'smart');
  assert.ok(smart.primary, 'smart 仍要选出一个 primary');
  // smart 是质量优先: 本地 0.7 分压不过 minimax-m3 的 1.0 分, 这是**设计如此**,
  // 主人要本地请显式写 local_first。所以这里只钉"没崩、没变空"。
});

// ---------- F 组: 显式"免费"标记 (老板 2026-10-16 "agnes现在3.0-flash免费") ----------
//
// A 组那条原则仍然成立: 云端模型 cost 填 0 是**漏配**, 不能当免费。
// F 组补的是漏配之外的那一种情况 —— 真的不收钱, 但 0 这个数字表达不了这件事。
// 不显式声明的话, 降级路径只能按配置顺序在云端里随便挑一个按量计费的
// (现场就是这么把一次纯本地请求变成了云端账单)。所以需要 free: true 这一行事实。

test('F1 free:true 是"已知免费", 跟"漏配 0"必须是两回事', () => {
  const free = MC.modelCost({ id: 'agnes', provider: 'custom', api_base: 'https://api.agnes-ai.cn/v1', free: true });
  assert.strictEqual(free.known, true, '显式声明免费 = 成本已知, 不能还报 unknown');
  assert.strictEqual(free.per1k, 0);
  assert.strictEqual(free.reason, 'explicit-free', '要能单独认出来, 别和 configured 混成一类');

  const unpriced = MC.modelCost({ id: 'k3', provider: 'kimi', api_base: 'https://api.kimi.com/v1' });
  assert.strictEqual(unpriced.known, false, '没声明免费的云端模型仍然算漏配 —— free 不许变成一张空白支票');
});

test('F2 free 只认显式 true, 不许被 0 / "true" / 1 之类糊弄', () => {
  const bad = [
    { id: 'a', provider: 'kimi', api_base: 'https://api.kimi.com/v1', free: 0 },
    { id: 'b', provider: 'kimi', api_base: 'https://api.kimi.com/v1', free: 'true' },
    { id: 'c', provider: 'kimi', api_base: 'https://api.kimi.com/v1', free: 1 },
    { id: 'd', provider: 'kimi', api_base: 'https://api.kimi.com/v1', free: 'yes' },
  ];
  for (const m of bad) {
    assert.strictEqual(MC.modelCost(m).known, false,
      `free=${JSON.stringify(m.free)} 不该被当成免费 —— 只认布尔 true`);
  }
});

test('F3 配了真实价格时, free 不该反过来把价格盖掉', () => {
  // 涨价那天主人大概会删掉 free 那行。但万一忘了只补价格没删 free,
  // 一个"免费但按量计费"的模型会让排序骗人 —— 这里钉住"价格字段优先"。
  const c = MC.modelCost({ id: 'agnes', provider: 'custom', api_base: 'https://api.agnes-ai.cn/v1', free: true, cost_per_1k_input: 3, cost_per_1k_output: 15 });
  assert.strictEqual(c.known, true);
  assert.strictEqual(c.reason, 'configured', '有正价格就按 configured 走, free 让位');
  assert.strictEqual(c.per1k, 18);
});

test('F4 本地端点一失败, 降级必须挑那个免费的, 不许挑按量计费的', () => {
  // 现场 (2026-10-16 clean-base2-20261016): 本地 qwen3.8-27b-mlx 瞬断 →
  // _pickCheapestModel 在"一个价都没配"状态下退化成按配置顺序挑,
  // 于是挑了按量计费的云端, 一次纯本地请求烧了云端的钱。
  // 声明 agnes 免费之后, 这条路必须挑 agnes。
  const pool = [
    { id: 'minimax-m3', provider: 'minimax', api_base: 'https://api.minimaxi.com/v1', context_length: 1048576, available: true },
    { id: 'agnes-3.0-flash', provider: 'custom', api_base: 'https://api.agnes-ai.cn/v1', free: true, context_length: 524288, available: true },
    { id: 'qwen3.8-27b-mlx', provider: 'lmstudio', api_base: 'http://127.0.0.1:1234', context_length: 65536, available: true },
  ];
  const pick = LCF._pickCheapestModel(pool, 'qwen3.8-27b-mlx', ['qwen3.8-27b-mlx'], 15000);
  assert.ok(pick, '必须有可降级的选择');
  assert.strictEqual(pick.id, 'agnes-3.0-flash',
    `有免费的就该挑免费的, 不该按配置顺序挑按量计费的 (实际挑了 ${pick && pick.id})`);
  assert.strictEqual(MC.modelCost(pick).per1k, 0, '挑中的这个必须真的不花钱');
});

test('F5 free 标记要能从源配置活到 models.json (sync 是整条覆盖, 不同步就等于没写)', () => {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'modules', 'pangu_helpers.js'), 'utf8');
  assert.ok(/cm\.free === true[\s\S]{0,80}free: true/.test(src),
    'pangu_helpers 的 sync 必须把 free 透传进 models.json —— '
    + 'sync 是 routerCfg.models[idx] = entry 整条覆盖, 不同步每次重启就被抹掉');
});

test('F6 warn 文案不许对免费模型喊"按量计费"', () => {
  // 这条 warn 是主人看"钱花哪了"的唯一线索。挑到免费模型还喊按量计费,
  // 报着报着就没人看了 —— 真出事那天也一样没人看。
  const pool = [
    { id: 'agnes-3.0-flash', provider: 'custom', api_base: 'https://api.agnes-ai.cn/v1', free: true, context_length: 524288, available: true },
  ];
  const warns = [];
  const orig = console.warn;
  console.warn = (s) => warns.push(String(s));
  try { LCF._pickCheapestModel(pool, 'local-x', ['local-x'], 1000); }
  finally { console.warn = orig; }
  const line = warns.find(w => w.includes('不可用'));
  assert.ok(!line || !/按量计费/.test(line),
    `挑到免费模型时 warn 不该说"按量计费" (拿到: ${line})`);
});

test('F7 临时的免费必须带着刊例价, 且 warn 要说出来 (不然优惠结束那天没人知道)', () => {
  // 2026-10-16 官方定价页: agnes-3.0-flash 现价全 $0/M, 但刊例价是
  // 输入 $0.05/M、输出 $0.15/M, 且明写「阶段性优惠的结束时间以平台公告
  // 和账户账单为准」—— 没有日期。
  // 只记 free:true 的话, 优惠结束那天盘古会**继续**把它排第一、继续当成免费,
  // 而且没人收到提醒。这条钉住: 刊例价要记下来, 并且要被说出来。
  const promo = {
    id: 'agnes-3.0-flash', provider: 'custom', api_base: 'https://api.agnes-ai.cn/v1',
    free: true, list_cost_per_1k_input: 0.00005, list_cost_per_1k_output: 0.00015,
  };
  const c = MC.modelCost(promo);
  assert.strictEqual(c.per1k, 0, '现在确实免费');
  assert.ok(c.list_per1k > 0, '刊例价必须记下来 —— 优惠结束时才知道要按多少算');
  assert.ok(Math.abs(c.list_per1k - 0.0002) < 1e-12,
    `刊例价应是 0.05/1M + 0.15/1M 换算到 /1k = 0.0002 (拿到 ${c.list_per1k})`);

  // 优惠结束 = 删掉 free。届时必须立刻按刊例价算, 而不是"没有价格信息 → 随便挑"。
  const afterPromo = Object.assign({}, promo);
  delete afterPromo.free;
  const a = MC.modelCost(afterPromo);
  assert.strictEqual(a.known, false,
    '删了 free 又没填真价格 = 回到漏配状态 —— 这是可以接受的, 但必须有 list_ 字段可查');

  const warns = [];
  const orig = console.warn;
  console.warn = (s) => warns.push(String(s));
  try {
    LCF._pickCheapestModel(
      [promo, { id: 'local-x', provider: 'lmstudio', api_base: 'http://127.0.0.1:1', available: true }],
      'local-x', ['local-x'], 1000);
  } finally { console.warn = orig; }
  const line = warns.find(w => w.includes('不可用'));
  assert.ok(!line || !/免费/.test(line) || /优惠结束/.test(line),
    `warn 说了免费就得同时说清这是临时的 (拿到: ${line})`);
});

test('F8 刊例价要从源配置活到 models.json (否则优惠结束那天气价是空的)', () => {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'modules', 'pangu_helpers.js'), 'utf8');
  assert.ok(/cm\.list_cost_per_1k_input/.test(src) && /cm\.list_cost_per_1k_output/.test(src),
    'pangu_helpers 的 sync 必须把 list_cost_per_1k_* 透传进 models.json');
});
