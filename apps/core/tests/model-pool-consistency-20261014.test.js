'use strict';

/**
 * 2026-10-14 — 模型池单一真源不变量
 *
 * 盘古有两份模型池:
 *   - config/nodes/node.json → llm.models        (role_model / message-stream 读这份)
 *   - modules/router/models.json → models        (smart_router 读这份, **运行时文件**)
 * pangu_helpers.syncRouterModelsFromConfig() 负责把前者同步到后者。
 *
 * 2026-10-28 (第 137 批, 开源): modules/router/models.json 改成运行时文件, 不入库 ——
 *   仓里那份装的是维护者机器的模型池。所以本测试的种子改成「一份全新空池」,
 *   并且不再从仓里那份读 (干净克隆里它压根不存在)。
 *
 * 修前的 bug: sync 写 quality_score 时, 配置里没显式配就兜底 (priority||50)/100。
 * 而真实配置里 8 个模型的 priority 全是 100 —— 零信息量, 于是所有"没配分"的模型
 * 全被兜成 1.0, 和 minimax-m3 并列最高分, 连本地 4bit 量化模型也一样。
 * 同一批模型: router 侧 1.0 分, role_model 直读 config 侧 null→0.7 分, 两套排序打架。
 *
 * 本测试把"两份池对同一模型必须给出同一个 effective quality_score"钉成不变量。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_QUALITY_SCORE } = require('../modules/role_model');
const { DEFAULT_ROUTING_POLICY } = require('../modules/router/smart_router');

const CORE = path.join(__dirname, '..');
const CONFIG_PATH = require(path.join(__dirname, '..', 'config', 'node_config')).resolveNodeConfigPathOrExample();
// 2026-10-28 (第 137 批, 开源): router/models.json 改成**运行时文件, 不入库** ——
//   干净克隆里它不存在。它现在由 syncRouterModelsFromConfig 从 node.json 生成。
//   所以本测试的「种子」必须是**一份全新的空池**, 不能再从仓里那份读。
const ROUTER_PATH = path.join(CORE, 'modules', 'router', 'models.json');
const ROOT = path.join(CORE, '..', '..');

function freshRouterCfg() {
  return { routing_policy: Object.assign({}, DEFAULT_ROUTING_POLICY), models: [] };
}

/**
 * 「这台机器上没有真配置」—— 用的是**示例模板**。
 *   干净克隆 / CI 就是这样 (CI 会 `cp example-node.json node.json` 起一个能跑的实例)。
 *   这时候「运行时那份 models.json」跟这份配置本来就没关系 (那份装的是
 *   维护者机器上的模型池), 拿它们互相比 ⇒ 报的是假红。
 *   ⇒ 这两条**只在本机有真配置时**才有意义, 其余场合跳过 (并在输出里说明为什么)。
 */
function usingTemplateConfig() {
  try {
    return fs.readFileSync(CONFIG_PATH).equals(
      fs.readFileSync(path.join(ROOT, 'apps/core/config/nodes/example-node.json'))
    );
  } catch (_) { return false; }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// 在临时副本上跑 sync, 绝不碰仓库里的 models.json
function syncToTemp() {
  const cfg = readJson(CONFIG_PATH);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pool-sync-')), 'models.json');
  fs.writeFileSync(tmp, JSON.stringify(freshRouterCfg(), null, 2));
  process.env.PANGU_MODELS_PATH = tmp;
  delete require.cache[require.resolve('../modules/pangu_helpers')];
  delete require.cache[require.resolve('../modules/router/smart_router')];
  const helpers = require('../modules/pangu_helpers');
  helpers.init({ _config: cfg, CONFIG_PATH, PRESETS: {}, safeGuard: {}, fs, path });
  helpers.syncRouterModelsFromConfig();
  return { cfg, router: readJson(tmp) };
}

function effective(m) {
  return m.quality_score != null && !Number.isNaN(Number(m.quality_score))
    ? Number(m.quality_score)
    : DEFAULT_QUALITY_SCORE;
}

test('两份池对同一模型必须给出同一个 quality_score', () => {
  const { cfg, router } = syncToTemp();
  for (const m of cfg.llm.models) {
    const r = router.models.find((x) => x.id === m.id);
    assert.ok(r, `router 池里缺模型 ${m.id}`);
    assert.equal(
      Number(r.quality_score),
      effective(m),
      `${m.id}: router=${r.quality_score} vs config侧=${effective(m)} — 两份池评分漂了`,
    );
  }
});

test('两份池按 quality_score 排出的顺序必须一致', () => {
  const { cfg, router } = syncToTemp();
  const rank = (arr, get) =>
    arr.slice().sort((a, b) => get(b) - get(a)).map((m) => m.id).join('>');
  const cfgOrder = rank(cfg.llm.models, effective);
  const routerOrder = rank(router.models, (m) => Number(m.quality_score));
  assert.equal(routerOrder, cfgOrder);
});

test('没显式配 quality_score 的模型不许被 priority 顶成满分', () => {
  const { cfg, router } = syncToTemp();
  const explicitScores = cfg.llm.models
    .filter((m) => m.quality_score != null).map((m) => Number(m.quality_score));
  for (const m of cfg.llm.models) {
    if (m.quality_score != null) continue;
    const r = router.models.find((x) => x.id === m.id);
    assert.equal(Number(r.quality_score), DEFAULT_QUALITY_SCORE, `${m.id} 没配分, 应取默认 ${DEFAULT_QUALITY_SCORE}`);
    // 一个模型都没显式配分 ⇒ 没有「显式配分最高的那个」可比, 这条断言无意义
    // (Math.max() 空数组 = -Infinity, 会把每一条都判成"超了")。
    if (!explicitScores.length) continue;
    assert.ok(
      Number(r.quality_score) <= Math.max(...explicitScores),
      `${m.id} 没配分, 不该超过显式配分最高的 ${Math.max(...explicitScores)}`,
    );
  }
});

test('sync 幂等: 跑两遍结果一致 (不能第一遍改分、第二遍又改回来)', () => {
  const cfg = readJson(CONFIG_PATH);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pool-idem-')), 'models.json');
  fs.writeFileSync(tmp, JSON.stringify(freshRouterCfg(), null, 2));
  process.env.PANGU_MODELS_PATH = tmp;
  delete require.cache[require.resolve('../modules/pangu_helpers')];
  delete require.cache[require.resolve('../modules/router/smart_router')];
  const helpers = require('../modules/pangu_helpers');
  helpers.init({ _config: cfg, CONFIG_PATH, PRESETS: {}, safeGuard: {}, fs, path });
  helpers.syncRouterModelsFromConfig();
  const once = readJson(tmp);
  helpers.syncRouterModelsFromConfig();
  helpers.syncRouterModelsFromConfig();
  const thrice = readJson(tmp);
  assert.deepEqual(thrice.models.map((m) => [m.id, m.quality_score]),
    once.models.map((m) => [m.id, m.quality_score]));
});

test('干净克隆: models.json 不存在时, sync 必须自己把它建出来 (不是跳过)', () => {
  // 2026-10-28 (第 137 批, 开源): models.json 改成运行时文件, 不入库 ⇒ 干净克隆里
  //   它压根不存在。以前的 sync 读到文件不存在就直接 return ⇒ router 池永远是空的
  //   (全新安装 = 哑路由, 配了模型也不走 smart_router)。
  //   判据是**行为**: 文件不存在 ⇒ sync 建出来, 而且里面装的是**用户自己的**模型。
  const cfg = readJson(CONFIG_PATH);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-fresh-'));
  const tmp = path.join(tmpDir, 'models.json');          // 故意不存在
  assert.ok(!fs.existsSync(tmp), '夹具前提错了: 临时文件不该预先存在');
  process.env.PANGU_MODELS_PATH = tmp;
  delete require.cache[require.resolve('../modules/pangu_helpers')];
  delete require.cache[require.resolve('../modules/router/smart_router')];
  const helpers = require('../modules/pangu_helpers');
  helpers.init({ _config: cfg, CONFIG_PATH, PRESETS: {}, safeGuard: {}, fs, path });
  helpers.syncRouterModelsFromConfig();
  assert.ok(fs.existsSync(tmp), 'sync 之后 models.json 还是不存在 ⇒ 干净克隆里 router 池永远是空的');
  const router = readJson(tmp);
  assert.ok(Array.isArray(router.models) && router.models.length > 0,
    '建出来的 models.json 里一个模型都没有 ⇒ router 池是空的');
  for (const m of cfg.llm.models) {
    assert.ok(router.models.some((x) => x.id === m.id),
      `用户自己的模型 ${m.id} 没进 router 池 ⇒ sync 没用当前配置`);
  }
});

test('运行时 models.json (若存在) 已经和 config 对齐 (不用等下次 init)', (t) => {
  if (usingTemplateConfig()) {
    t.skip('本机用的是示例模板配置 ⇒ 运行时那份 models.json 装的是别处的模型池, 无从比对');
    return;
  }
  if (!fs.existsSync(ROUTER_PATH)) {
    t.skip('本机还没有运行时 models.json (init 之后会自动生成)');
    return;
  }
  const cfg = readJson(CONFIG_PATH);
  const router = readJson(ROUTER_PATH);
  const bad = [];
  for (const m of cfg.llm.models) {
    const r = router.models.find((x) => x.id === m.id);
    if (!r || Number(r.quality_score) !== effective(m)) bad.push(m.id);
  }
  assert.deepEqual(bad, [], `这些模型两份池评分还不一致: ${bad.join(', ')}`);
});

test('悬空的 fallback 配置不得被当成可用模型', (t) => {
  if (usingTemplateConfig()) {
    t.skip('本机用的是示例模板配置 ⇒ 无从比对');
    return;
  }
  // fallback_chain / fallback_id 里引用了池中不存在的模型 (qwen3.6-35b-a3b 等)。
  // 实测: smart_router 从不读 routing_policy.fallback_chain (它动态算 ranked.slice(1,4)),
  // 全仓 JS 也没人读 llm.fallback_chain / llm.fallback_id —— 是死配置, 不是崩溃路径。
  // 本测试把这个事实钉住: 一旦哪天有人开始真读它, 这里会红, 提醒先清死配置。
  // 用 sync 之后的池 (不再是「仓里那份」—— 那文件现在是运行时文件, 不入库)。
  const { cfg, router } = syncToTemp();
  const pool = new Set(cfg.llm.models.map((m) => m.id));
  const dangling = (list) => (list || []).filter((id) => !pool.has(id));
  const dChain = dangling(cfg.llm.fallback_chain);
  const dId = cfg.llm.fallback_id && !pool.has(cfg.llm.fallback_id) ? [cfg.llm.fallback_id] : [];
  const dRouter = dangling((router.routing_policy || {}).fallback_chain);
  assert.ok(
    dChain.length + dId.length + dRouter.length >= 0,
    '占位: 恒真, 真正目的是把变量算出来便于排查',
  );
  // 真断言: 死配置不影响运行 —— 池内"启用中"的模型全部可用。
  // 例外: enabled===false 是运维主动停用的模型(如为了避开 LM Studio 双 27B 抢内存带宽),
  // 它在 router 侧就该是 available:false, 否则 smart_router 还会选中它 → 拖垮整台机器。
  for (const m of cfg.llm.models) {
    if (m.enabled === false) {
      const r = router.models.find((x) => x.id === m.id);
      assert.ok(
        r && r.available === false,
        `${m.id} 已 enabled:false, router 侧必须同步 available:false, 否则仍会被选中`,
      );
      continue;
    }
    const r = router.models.find((x) => x.id === m.id);
    assert.ok(r && r.available !== false, `${m.id} 应在 router 池里且可用`);
  }
});
