'use strict';

// 2026-10-17 现场 (your-mac.json):
//     llm.provider         = 'lmstudio'                     ← 本地
//     llm.current_model_id = 'minimax_m3.1-flash-preview'   ← 云端
// 两行字面矛盾, 而它能一直躺着是因为**没有任何代码读它** (Pangu 自己的默认配置
// 形状 { llm: { models, current_model_id } } 压根没有 provider 这一项;
// 全仓库 grep `llm.provider` = 0 命中)。
//
// 真实代价不是"多一行脏数据", 是盘古自己的 checker 把它当矛盾判 FAIL,
// 触发两轮补救重推同一张表 —— 每轮都在追一个改配置也解决不了的幻影。
//
// 这组断言同时钉住老板关心的那个口径: **盘古现在到底在用本地还是云端**,
// 必须能从配置本身判出来, 不许靠猜。
const test = require('node:test');
const assert = require('node:assert');

const { checkModelConfig } = require('../modules/model_config_guard');

const CLOUD = (id, extra) => Object.assign(
  { id, enabled: true, provider: 'minimax', endpoint: 'https://api.minimaxi.com/v1/chat/completions' },
  extra,
);
const LOCAL = (id, extra) => Object.assign(
  { id, enabled: true, provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234/v1/chat/completions' },
  extra,
);
const load = () => ({
  llm: {
    models: [CLOUD('minimax_m3.1-flash-preview'), LOCAL('qwen3.8-27b-mlx'), CLOUD('k3', { priority: 90 })],
    current_model_id: 'minimax_m3.1-flash-preview',
    fallback_chain: ['k3'],
  },
});
const warned = (r, needle) => r.warnings.some((w) => w.includes(needle));

test('现场那行死字段: 矛盾时删掉并说清当前实际在用谁', () => {
  const cfg = load();
  cfg.llm.provider = 'lmstudio'; // 死字段说"走本地", 实际选的是云端
  const r = checkModelConfig(cfg, { apply: true });
  assert.ok(!('provider' in cfg.llm), '死字段必须删掉 —— 它没有任何代码读它');
  assert.ok(r.fixed.some((f) => f.field === 'llm.provider'), '要记进 fixed, 便于追溯');
  assert.ok(warned(r, 'llm.provider=lmstudio'), '要说清它是什么、为什么删');
  assert.ok(warned(r, '云端端点'), '必须同时报出**实际**走的是云端');
});

test('即使这次恰好说对了也要删 —— 它没有任何东西会跟着更新, 留着注定再次说谎', () => {
  // 承重判断: 修法不是"把值改对", 是删掉。current_model_id 一换, 这个字段
  // 不会跟着动, 于是又变成一句谎话。留着"这次是对的"最危险 —— 看着可信。
  const cfg = load();
  cfg.llm.provider = 'minimax'; // 这次确实对得上
  const r = checkModelConfig(cfg, { apply: true });
  assert.ok(!('provider' in cfg.llm), '对得上也删: 它不是真源, 只是碰巧没过期');
  assert.ok(r.fixed.some((f) => f.field === 'llm.provider'));
});

test('只报不修模式绝不能动配置 (dry-run 语义)', () => {
  const cfg = load();
  cfg.llm.provider = 'lmstudio';
  const r = checkModelConfig(cfg, { apply: false });
  assert.strictEqual(cfg.llm.provider, 'lmstudio', 'apply:false 不得删字段');
  assert.ok(!r.fixed.some((f) => f.field === 'llm.provider'), 'apply:false 不得进 fixed');
  assert.ok(warned(r, '与实际选择矛盾'), '但必须把矛盾报出来');
});

test('没有这个字段时不许瞎报警 (别制造新噪音)', () => {
  const cfg = load();
  const r = checkModelConfig(cfg, { apply: true });
  assert.ok(!warned(r, 'llm.provider'), '干净配置不该被提 provider');
  assert.ok(!r.fixed.some((f) => f.field === 'llm.provider'));
});

// ── 老板真正要的那个答案: 本地还是云端 ───────────────────────────────────────
// 走 `active` 字段而不是 `warnings` —— warnings 的语义是"配置有问题",
// 2026-10-14 的 S4/S5 护栏钉死了「健康配置零误报」。把状态混进 warnings
// 就是新噪音, 正是这个模块要消灭的东西。
test('当前在用云端: active 报出模型/provider/端点类型/取值路径', () => {
  const r = checkModelConfig(load(), { apply: true });
  assert.strictEqual(r.active.id, 'minimax_m3.1-flash-preview');
  assert.strictEqual(r.active.provider, 'minimax');
  assert.strictEqual(r.active.kind, 'cloud', '端点类型必须说死, 不许含糊');
  assert.strictEqual(r.active.via, 'current_model_id', '还要说清是按你指定的选的');
  assert.strictEqual(r.active.as_requested, true);
});

test('健康配置下 active 有值, 但 warnings 必须仍然是空的 (零误报护栏)', () => {
  const r = checkModelConfig(load(), { apply: true });
  assert.strictEqual(r.warnings.length, 0, 'active 是状态不是问题 —— 健康配置不许被念叨');
  assert.ok(r.active, '但状态照样算得出来');
});

test('切到本地模型: 同一个口径必须立刻跟着变', () => {
  const cfg = load();
  cfg.llm.current_model_id = 'qwen3.8-27b-mlx';
  const r = checkModelConfig(cfg, { apply: true });
  assert.strictEqual(r.active.id, 'qwen3.8-27b-mlx');
  assert.strictEqual(r.active.kind, 'local', '127.0.0.1 的端点必须判成本地');
});

test('current_model_id 悬空时: active 标明是兜底, 且没按你指定的选', () => {
  const cfg = load();
  cfg.llm.current_model_id = 'ghost-model'; // 池里没有
  const r = checkModelConfig(cfg, { apply: true });
  // 兜底按 enabled+priority 取 —— k3(priority 90) 赢过 minimax(无 priority)
  assert.strictEqual(r.active.id, 'k3', '兜底要报出实际选中的');
  assert.strictEqual(r.active.via, 'fallback');
  assert.strictEqual(r.active.as_requested, false, '必须明说: 你指定的没被用上');
  assert.strictEqual(r.active.requested_model_id, 'ghost-model');
  assert.ok(warned(r, '指向不存在的模型'), '"没选中"这件事本身仍要报成 warning (第 1 段)');
});

test('current_model_id 指向已停用模型: 同样走兜底并报警', () => {
  const cfg = load();
  cfg.llm.models.push(CLOUD('off-model', { enabled: false }));
  cfg.llm.current_model_id = 'off-model';
  const r = checkModelConfig(cfg, { apply: true });
  assert.strictEqual(r.active.via, 'fallback', '停用的也算"没选中"');
  assert.strictEqual(r.active.as_requested, false);
  assert.ok(r.active.id, '仍要报出实际在用谁');
});

test('池里全停用: 不许硬编一个"当前在用"出来', () => {
  const cfg = { llm: { models: [CLOUD('a', { enabled: false })], current_model_id: 'a' } };
  const r = checkModelConfig(cfg, { apply: true });
  assert.strictEqual(r.active, null, '无可用模型时 active 为 null —— 报了就是假话');
});
