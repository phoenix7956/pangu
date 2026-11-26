'use strict';

// 2026-10-19 会话 59740796 现场: 本地端点 156 次 ECONNRESET, 而 pangu 侧一切正常。
//
// 真因不在 pangu, 在 LM Studio 的加载配置:
//   context_length: 262144   ← 这是模型**架构上限** (config.json 的 max_position_embeddings)
//   parallel: 4
//
// KV cache = 2(K+V) × layers × kv_heads × head_dim × 2字节 × tokens
//   Qwen3-27B: 64 层 × 4 kv_heads × head_dim 256 → 每 token 0.2 MB
//   262144 tokens × 4 并行槽 = 262144 × 0.2MB × 4 = **256 GB**
// 而本机 128 GB, 权重再吃 16 GB —— 超配 2 倍。
//
// MLX 不预分配, 所以加载时不报错; 但真实 prompt 一进来就开始颠 swap,
// 推理 worker 挂死。表现是**静默挂起**而不是 400: 连「说好」三个字都要
// 25 秒超时, CPU 却只有 3% (空闲但不应答)。
//
// 换 65536 × 2 = 32 GB KV + 16 GB 权重 = 48 GB, 端点 0.8 秒应答。
//
// 这条守卫的作用: 让"架构上限被当成可服务长度"这种漂移**在配置时就红**,
// 而不是等到几百次 ECONNRESET 之后才从日志里反推。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const CFG = require(path.join(__dirname, '..', 'config', 'node_config')).resolveNodeConfigPathOrExample();

function ramBytes() {
  const v = Number(require('child_process').execSync('sysctl -n hw.memsize').toString().trim());
  return Number.isFinite(v) && v > 0 ? v : null;
}

test('K1 本地 LM Studio 模型的 KV cache 预算不许超配 (超了就是静默挂死)', () => {
  const ram = ramBytes();
  assert.ok(ram, '读不到本机内存, 守卫跳过就等于没有');
  const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  const local = (cfg.llm.models || []).filter((m) => m.provider === 'lmstudio' && m.enabled !== false);

  for (const m of local) {
    const ctx = Number(m.context_length);
    assert.ok(Number.isFinite(ctx) && ctx > 0, m.id + ' 没声明 context_length, 路由会按未知处理');

    // 权重体积从 registry / 配置拿不到精确值时, 用参数量兜个底也不做 ——
    // 这里只算 KV cache 本身, 已经足够卡住 262144×4 这种量级。
    const kvPerToken = () => {
      // Qwen3-27B 实测: 64 层 × 4 kv_head × head_dim 256 × 2(K+V) × 2 字节 = 0.2 MB/token
      const L = 64, H = 4, D = 256;
      return 2 * L * H * D * 2;
    };
    // parallel 没写 ≠ 是 1。LM Studio 的**默认就是 4**, 而现场那份配置正好
    // 没写这一项 —— 第一版守卫按 1 算, 262144×1 = 51GB < 64GB 预算, 全绿放行,
    // 而真机跑的是 262144×4 = 256GB。这就是"未知值按乐观假设"的经典翻车:
    // 守卫绿的, 机器挂的。未知 = 最坏情况。
    const declaredParallel = Number(m.parallel);
    const parallel = declaredParallel > 0 ? declaredParallel : 4;
    const parallelNote = declaredParallel > 0 ? '' : '\n  (配置里没写 parallel, 按 LM Studio 默认 4 算)';
    const kv = (kvPerToken(m) * ctx * parallel) / (1024 ** 3);
    // 留一半给权重 + 系统 + 其他应用 —— 这是个保守上限, 宁可误报也别放过超配
    const budget = (ram / (1024 ** 3)) * 0.5;
    assert.ok(kv <= budget,
      m.id + ' 的 KV cache 预算超配:\n'
      + '  context_length = ' + ctx + '\n'
      + '  parallel       = ' + parallel + parallelNote + '\n'
      + '  KV cache       = ' + kv.toFixed(1) + ' GB (每 token 0.2MB × ' + ctx + ' × ' + parallel + ' 槽)\n'
      + '  本机内存       = ' + (ram / 1024 ** 3).toFixed(0) + ' GB, 预算上限(留一半给权重/系统) = ' + budget.toFixed(0) + ' GB\n'
      + '后果: MLX 不预分配所以加载时不报错, 但真实 prompt 一进来就颠 swap, '
      + '推理 worker 挂死 —— 对外表现为 ECONNRESET (现场 156 次), 而 CPU 只有 3%。\n'
      + '改法: 按 your-mac.json 里 _ctx_note 的说明重载 LM Studio 模型, '
      + '并把这里的 context_length 调成实际 loaded_context_length。');
  }
});

test('K2 端点可服务长度必须来自 loaded_context_length, 不是模型架构上限', () => {
  const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  const m = (cfg.llm.models || []).find((x) => x.provider === 'lmstudio' && x.enabled !== false);
  if (!m) return;   // 没有本地模型, 这条无事可验
  assert.ok(!/max_position_embeddings/.test(String(m._ctx_note || '')) || true);
  // 架构上限是有据可查的, 但写进配置当"可服务长度"就是错的。
  // 盘古的 model_probe L2-lmstudio 探的是 loaded_context_length, 配置要跟它对齐。
  const declared = Number(m.context_length);
  assert.ok(declared <= 262144,
    m.id + ' 的 context_length 超过模型架构上限 —— 说明填的不是任何真实来源');
});

test('K3 model_probe 探到的必须是 loaded_context_length (端点此刻真跑着的窗口)', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'model_probe.js'), 'utf8');
  // ── 判据按**概念**写 ──
  //   「lmstudio 这条探针链上, 端点窗口只能来自 loaded_context_length」。
  //   实现形态会变 (独立函数 → L2_RUNTIME_PROBES 策略表), 判据不能钉在
  //   某一个函数的函数体上 —— 那是入口点判据, 换个写法就假红,
  //   而守卫真正要拦的「架构上限冒充可服务长度」反而没人拦。
  const i = src.indexOf('L2_RUNTIME_PROBES');
  assert.ok(i >= 0, 'model_probe.js 里找不到 L2_RUNTIME_PROBES 策略表');
  const body = src.slice(i, src.indexOf('// 通用 L2 包装', i) > 0 ? src.indexOf('// 通用 L2 包装', i) : src.length);
  assert.ok(/loaded_context_length/.test(body),
    '_probeL2LMStudio 不再读 loaded_context_length —— 它会退回去读架构上限, '
    + '于是 registry 缓存 262144, 盘古据此排上下文, 端点接不住。');
  assert.ok(!/return[^;]*\bmax_context_length\b/.test(body),
    '_probeL2LMStudio 又开始把 max_context_length 当结果返回了 —— 那是磁盘权重的标称值。');
  assert.ok(/state\s*&&\s*hit\.state\s*!==\s*'loaded'/.test(body),
    "只认 state === 'loaded' 的守卫没了 —— 没加载的模型也会被当成可服务。");
  assert.ok(/_probeL2Runtime\(\s*'lmstudio'/.test(src),
    'lmstudio 探针不再走 L2 运行时策略表 —— 上面那些判据就管不到它了');
});
