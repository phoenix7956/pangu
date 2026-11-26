'use strict';
/**
 * tests/model-routing-20261026.test.js — 第 111 批守卫
 *
 * 这条守卫守两件事 (都是今天真出事的):
 *
 * A. 延迟感知路由 (modules/model_routing.js)
 *   老板的机器是共享屏主机, 本机 GPU 常年被抢 ⇒ 本地 27B 首字 2.2s~6.5s,
 *   云端 0.5s~1.5s。路由要能自己在「慢」和「不可用」时挪到更快的模型,
 *   但**不许为了快而掉质量档**, 也不许抢用户手动选定的模型。
 *
 * B. ctx 拿不到不许打死对话 (pangu_helpers.getModelContextLengthSafe)
 *   今天实测: 池里换了个新模型 id, registry 里没条目 ⇒ getModelContextLength 抛
 *   ⇒ llm_caller 算 max_tokens 时抛 ⇒ **POST /api/chat 每次 500**。
 *   规矩: registry 层照旧 fail-loud (那是"没探到"的事实),
 *         运行时热路径退到保守值 (宁可少用窗口, 不许整轮死)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CORE = path.join(__dirname, '..');

// 隔离 registry (测试进程不许碰生产 ~/.pangu/models-registry.json)
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-routing-'));
process.env.PANGU_REGISTRY_PATH = path.join(SANDBOX, 'models-registry.json');

const routing = require(path.join(CORE, 'modules', 'model_routing'));
const helpers = require(path.join(CORE, 'modules', 'pangu_helpers'));
const registry = require(path.join(CORE, 'modules', 'model_registry'));

function readSrc(rel) {
  return fs.readFileSync(path.join(CORE, rel), 'utf8');
}

// 注释里写"实测某厂商多少毫秒"是证据留痕, 不是写死;
// 判"有没有把厂商写进代码"只看代码本身。
function stripComments(src) {
  return src.split('\n').filter(l => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
}

const ok = (id, ms) => ({ id, ok: true, ms_first: ms, ms_total: ms, error: '', skipped: false, ts: 0 });
const bad = (id) => ({ id, ok: false, ms_first: null, ms_total: null, error: 'boom', skipped: false, ts: 0 });

// ── A. 路由决策 ──────────────────────────────────────────────

test('A1 质量档优先: 慢的高档模型胜过快的低档模型', () => {
  const cand = routing.pickCandidate(
    [ok('hi', 900), ok('lo', 100)],
    { qualityById: { hi: 1, lo: 0.5 } },
  );
  assert.equal(cand.id, 'hi', '高档优先, 不能因为慢就掉档');
});

test('A2 同档内按速度排', () => {
  const cand = routing.pickCandidate(
    [ok('hi', 900), ok('mid', 120)],
    { qualityById: { hi: 1, mid: 0.99 } },
  );
  assert.equal(cand.id, 'mid', '同一档里挑快的');
});

test('A3 上档全挂才降档', () => {
  const cand = routing.pickCandidate(
    [bad('hi'), ok('mid', 300), ok('lo', 50)],
    { qualityById: { hi: 1, mid: 0.9, lo: 0.4 } },
  );
  assert.equal(cand.id, 'mid', '高档不可用时退到下一档');
});

test('A4 当前模型慢 ⇒ 切; 当前模型快 ⇒ 不切', () => {
  const cfg = { llm: { current_model_id: 'slow', routing: { policy: 'auto', max_first_token_ms: 2500 } } };
  const d1 = routing.decide(cfg, [ok('slow', 6000), ok('fast', 500)], {
    cfg: routing.routingCfg(cfg), qualityById: { slow: 0.5, fast: 0.5 },
  });
  assert.equal(d1.action, 'switch');
  assert.equal(d1.to, 'fast');

  const cfg2 = { llm: { current_model_id: 'fast', routing: { policy: 'auto', max_first_token_ms: 2500 } } };
  const d2 = routing.decide(cfg2, [ok('fast', 500), ok('slow', 6000)], {
    cfg: routing.routingCfg(cfg2), qualityById: { fast: 0.5, slow: 0.5 },
  });
  assert.equal(d2.action, 'keep');
});

test('A5 当前模型连不上 ⇒ 切 (可达性优先于速度)', () => {
  const cfg = { llm: { current_model_id: 'dead', routing: { policy: 'auto' } } };
  const d = routing.decide(cfg, [bad('dead'), ok('alive', 900)], {
    cfg: routing.routingCfg(cfg), qualityById: { dead: 1, alive: 0.5 },
  });
  assert.equal(d.action, 'switch');
  assert.equal(d.to, 'alive');
});

test('A6 用户手动钉住的模型不被自动改', () => {
  const cfg = {
    llm: {
      current_model_id: 'pinned',
      routing: { policy: 'auto', max_first_token_ms: 100, manual_pinned: true, pinned_model_id: 'pinned' },
    },
  };
  const d = routing.decide(cfg, [ok('pinned', 9000), ok('fast', 100)], {
    cfg: routing.routingCfg(cfg), qualityById: { pinned: 0.5, fast: 0.5 },
  });
  assert.equal(d.action, 'keep');
  assert.equal(d.reason, 'manual-pin');
});

test('A7 policy 非法值退回 manual (不擅自接管别人的模型选择)', () => {
  const cfg = routing.routingCfg({ llm: { routing: { policy: 'whatever' } } });
  assert.equal(cfg.policy, 'manual');
  assert.equal(routing.routingCfg({ llm: {} }).policy, 'manual');
  assert.equal(routing.routingCfg({ llm: { routing: { policy: 'auto' } } }).policy, 'auto');
});

test('A8 markManualPin 记下钉住标记', () => {
  const cfg = { llm: {} };
  routing.markManualPin(cfg, 'k3');
  assert.equal(cfg.llm.routing.manual_pinned, true);
  assert.equal(cfg.llm.routing.pinned_model_id, 'k3');
});

// ── B. ctx 降级 ─────────────────────────────────────────────

test('B1 registry 层仍然 fail-loud (没探到就是没探到)', () => {
  assert.throws(
    () => helpers.getModelContextLength({ id: 'never-probed-model-xyz' }),
    /not discoverable/,
  );
});

test('B2 热路径退到保守值, 不抛 (整轮不许死)', () => {
  const ctx = helpers.getModelContextLengthSafe({ id: 'never-probed-model-xyz' });
  assert.equal(ctx, helpers.SAFE_CTX_FALLBACK);
  assert.ok(ctx > 0);
});

test('B3 别名也能查到 ctx (池 id ≠ 厂商模型名)', () => {
  registry.setContextLength('vendor-model-name', 1006925, 'L3-input-probe', { measure: 'v2-tokens' });
  const ctx = helpers.getModelContextLength({ id: 'pool-id', api_model: 'vendor-model-name' });
  assert.equal(ctx, 1006925);
});

test('B4 llm_caller 热路径不许调抛异常的那个 (源码层)', () => {
  const src = readSrc('modules/llm_caller.js');
  assert.ok(
    !/getModelContextLength\(useModel\)/.test(src),
    'llm_caller 热路径还在调会抛的 getModelContextLength — registry miss 会打死整轮对话',
  );
  assert.ok(
    /getModelContextLengthSafe\(useModel\)/.test(src),
    'llm_caller 热路径没用 safe 版',
  );
});

// ── C. 通用性 (老板: 不要局限到个别云端或本地) ───────────────

test('C1 路由模块不写死任何厂商/模型名', () => {
  const src = stripComments(readSrc('modules/model_routing.js'));
  for (const vendor of ['minimax', 'kimi', 'agnes', 'qwen', 'claude', 'gpt-', 'deepseek', 'dashscope']) {
    assert.ok(
      !src.toLowerCase().includes(vendor),
      '路由模块里出现了具体厂商/模型名 "' + vendor + '" — 换厂商就得改代码, 这条路走不通',
    );
  }
});

test('C2 路由模块不直接读明文 api_key (只走统一解析链)', () => {
  const src = readSrc('modules/model_routing.js');
  assert.ok(!/\.api_key\b/.test(src), '路由模块直接读了 api_key 字段 — 绕过了统一解析链');
  assert.ok(src.includes('api_key_resolver'), '路由模块该走 api_key_resolver');
});

test('C3 示例配置把路由讲清楚了 (开源用户照着能配)', () => {
  const example = JSON.parse(readSrc('config/nodes/example-node.json'));
  const routingBlock = example.llm && example.llm.routing;
  assert.ok(routingBlock, 'example-node.json 里没有 llm.routing 说明块');
  assert.ok(routingBlock.policy, 'routing 块没写 policy');
});
