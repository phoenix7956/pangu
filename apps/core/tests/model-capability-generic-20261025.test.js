'use strict';
// 第 98 批: 模型层通用性守卫
//
// 起因: 老板「不要局限到个别云端或者本地, 应该是通用型的」。
// 审计发现 7 处按**品牌名**硬判的分支 (kimi 温度锁 ×3 份副本 / 两份漂移的
// provider cap 表 / provider==='lmstudio' 超时二分 ×3)。
//
// 本守卫要证明两件事:
//   G1 · 能力层能从**配置**读厂商档案 —— 加厂商不改代码。
//   G2 · 主体代码里**不再有**按品牌名的分支 (协议适配不算 —— 那是协议差异)。
//   G3 · 行为等价: 改判据不改行为 (kimi 温度仍锁 1.0, 本地仍长超时)。
//   G4 · 变异体检: 能力层被绕过 ⇒ 守卫必须报红。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const capability = require(path.join(ROOT, 'modules', 'model_capability'));

// ─────────────────────────────────────────────────────────────
// G1 · 厂商档案能从配置读 —— 加厂商不用改代码
// ─────────────────────────────────────────────────────────────
test('G1a: 配置里的 vendor_profiles 覆盖代码兜底档案', () => {
  capability.setConfigProfiles([
    { provider: 'acme', temperature_locked: 0.7, max_output_tokens: 4096 },
  ]);
  try {
    const m = { provider: 'acme', id: 'acme-1' };
    assert.equal(capability.temperatureFor(m, 0.3), 0.7, '配置里的温度锁必须生效');
    assert.equal(capability.maxOutputTokens(m, 999), 4096, '配置里的输出上限必须生效');
    assert.equal(capability.vendorProfile(m).provider, 'acme');
  } finally {
    capability.setConfigProfiles(null);
  }
});

test('G1b: 配置里没写的厂商走代码兜底档案 (配置缺失不降级)', () => {
  capability.setConfigProfiles([{ provider: 'acme', temperature_locked: 0.7 }]);
  try {
    // kimi 不在配置里 ⇒ 兜底档案仍然生效, 不能因为配置被改过就丢掉已知事实
    assert.equal(capability.temperatureFor({ provider: 'kimi' }, 0.3), 1.0);
  } finally {
    capability.setConfigProfiles(null);
  }
});

test('G1c: init() 从整份配置里取 vendor_profiles', () => {
  capability.init({ _config: { llm: { vendor_profiles: [{ provider: 'zed', max_output_tokens: 111 }] } } });
  try {
    assert.equal(capability.maxOutputTokens({ provider: 'zed' }, 999), 111);
  } finally {
    capability.init({ _config: {} });
  }
});

test('G1d: 模型条目上的显式字段优先于一切档案', () => {
  capability.setConfigProfiles([{ provider: 'kimi', temperature_locked: 1.0 }]);
  try {
    // 用户显式写了 temperature_locked ⇒ 档案不参与
    assert.equal(capability.temperatureFor({ provider: 'kimi', temperature_locked: 0.2 }, 0.3), 0.2);
    // 用户显式写了 max_output_tokens ⇒ 档案不参与
    assert.equal(capability.maxOutputTokens({ provider: 'kimi', max_output_tokens: 99999 }, 1), 99999);
  } finally {
    capability.setConfigProfiles(null);
  }
});

// ─────────────────────────────────────────────────────────────
// G2 · 主体代码里不再有按品牌名的分支
// ─────────────────────────────────────────────────────────────
test('G2a: 主体模块里没有 provider 名硬判 (kimi/minimax/agnes/lmstudio/ollama 等)', () => {
  // 协议适配 (anthropic/ollama 的协议差异) 和媒体生成 (media_gen 的厂商 API 路径)
  // 是**协议差异**, 不是"限定个别云端" —— 不在这次收口范围。
  const EXEMPT = new Set([
    'modules/model_capability.js',       // 档案表本身 (数据, 不是分支)
    'modules/model_capabilities.js',     // 视觉能力识别 (历史模块)
    'modules/local_model.js',            // 本地运行时名单 (这是**端点事实的补充**, 不是厂商怪癖)
    'modules/tools/media_gen.js',        // 媒体生成走各厂商专属 API 路径 (协议差异)
    'modules/lmstudio_cache_guard.js',   // LM Studio 缓存守卫 (只对 LM Studio 有意义, 按**端点**判)
  ]);
  // ⚠️ lmstudio_cache_guard 为什么豁免:
  //   它不是「厂商怪癖」, 是 **LM Studio 特有机制的适配** ——
  //   LM Studio 的 prompt 缓存挂在模型加载寿命上 (lifetime=model_load),
  //   占用率只能从它的服务端日志读, 重置只能靠 lms unload/load。
  //   vLLM / Ollama / mlx 各有各的缓存机制 (而且不共用这个日志格式),
  //   套不上这套逻辑 —— 硬套反而会做错事。
  //   ⇒ 收口的是「厂商怪癖」, 不是「一切跟厂商有关的东西」。
  // 品牌名 → 出现在主体里就说明还有硬判。
  // ⚠️ 判据要覆盖**带括号/带兜底**的写法, 不能只匹配 `provider === 'x'`:
  //   `(useModel.provider || '') === 'lmstudio'` 这种写法很容易漏 (真实漏过一次)。
  // 所以用「provider 取值表达式 + 品牌字面量」两个条件同时出现来判。
  const BRANDS = 'kimi|minimax|agnes|lmstudio|lm-studio|ollama|vllm|llamacpp';
  const BRAND = new RegExp(`provider[^\\n;]{0,40}['"](${BRANDS})['"]`);
  // 协议适配豁免: anthropic / ollama 的**协议差异**是合法的 (两种 API 形状不同),
  // 那不是"限定个别云端"。只有「厂商怪癖」才该收进能力层。
  const isProtocolLine = (t) =>
    /anthropic/.test(t) || (/ollama/.test(t) && /protocol|normalizeEndpoint|api\/chat|11434|messages/i.test(t));
  const files = [
    'modules/llm_caller.js',
    'modules/j2_helpers.js',
    'modules/role_model.js',
    'modules/model_transport.js',
  ];
  const bad = [];
  for (const f of files) {
    if (EXEMPT.has(f)) continue;
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return; // 注释不是代码
      if (isProtocolLine(t)) return;                                            // 协议适配不是厂商怪癖
      if (BRAND.test(t)) bad.push(`${f}:${i + 1}: ${t.slice(0, 90)}`);
    });
  }
  assert.deepEqual(bad, [], '主体里还有按品牌名的分支:\n' + bad.join('\n'));
});

test('G2b: 超时判定不再出现 provider===\'lmstudio\' 的本地二分', () => {
  const src = fs.readFileSync(path.join(ROOT, 'modules', 'llm_caller.js'), 'utf8');
  // 只看**代码行** —— 注释里提到品牌名是正常的 (那是在解释历史)。
  const codeLines = src.split('\n').filter(l => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
  assert.doesNotMatch(codeLines, /provider[^\n;]{0,40}['"]lmstudio['"]/,
    '超时仍按品牌名二分本地/云端');
});

test('G2c: kimi 特判只剩一处形态 (能力层), 主体里没有第二份副本', () => {
  for (const f of ['modules/llm_caller.js', 'modules/role_model.js', 'modules/j2_helpers.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      // 覆盖带括号/带兜底的写法 (如 `(model.provider || '') === 'kimi'`)
      assert.doesNotMatch(t, /_isKimi|api\.kimi\.com|\^k3|provider[^\n;]{0,40}['"]kimi['"]/,
        `${f}:${i + 1} 还有 kimi 品牌硬判: ${t.slice(0, 80)}`);
    });
  }
});

// ─────────────────────────────────────────────────────────────
// G3 · 行为等价 (改判据不改行为)
// ─────────────────────────────────────────────────────────────
test('G3a: kimi 编码端点温度仍锁 1.0 (角色温度 0 也压不过)', () => {
  // 2026-10-13 实测: kimi 编码端点传 temperature=0 直接 HTTP 400。
  assert.equal(capability.temperatureFor({ provider: 'kimi' }, 0), 1.0);
  assert.equal(capability.temperatureFor({ provider: 'kimi', id: 'k3' }, 0), 1.0);
  assert.equal(capability.temperatureFor({ provider: 'kimi', name: 'k3-256k' }, 0), 1.0);
  assert.equal(capability.temperatureFor({ provider: 'custom', endpoint: 'https://api.kimi.com/coding/v1' }, 0), 1.0);
});

test('G3a2: 自定义网关转发 kimi 模型时温度照样锁 1.0 (旧代码认的 id/name 特征不能丢)', () => {
  // 这是收编档案时最容易丢的一档: provider 是 custom、端点也不是 api.kimi.com,
  // 但**模型名**是 k3/kimi —— 它仍然是 kimi 编码端点, 温度不锁照样 400。
  // (旧代码靠 `_id.includes('kimi') || /^k3/.test(_id)` 认这一档。)
  assert.equal(capability.temperatureFor({ provider: 'custom', id: 'k3-256k', endpoint: 'https://relay.example/v1' }, 0), 1.0);
  assert.equal(capability.temperatureFor({ provider: 'custom', name: 'kimi-for-coding', endpoint: 'https://relay.example/v1' }, 0), 1.0);
  assert.equal(capability.temperatureFor({ provider: 'custom', api_model: 'kimi-k2', endpoint: 'https://relay.example/v1' }, 0), 1.0);
  // 明显不是 kimi 的模型不该被误伤
  assert.equal(capability.temperatureFor({ provider: 'custom', id: 'qwen-32b', endpoint: 'https://relay.example/v1' }, 0.3), 0.3);
  assert.equal(capability.temperatureFor({ provider: 'custom', id: 'gpt-4o', endpoint: 'https://relay.example/v1' }, 0.3), 0.3);
  assert.equal(capability.temperatureFor({ provider: 'custom', id: 'deepseek-v3', endpoint: 'https://relay.example/v1' }, 0.3), 0.3);
});

test('G3a3: 档案的 match_id 在配置里能用正则字面量表达', () => {
  // match_id 是「没有 provider 精确匹配时」的兜底判据。
  // 这里 provider='x' 有精确档案 ⇒ 直接命中, match_id 根本不参与。
  // 要验 match_id 本身, 得让 provider **没有**精确档案。
  capability.setConfigProfiles([{ provider: 'x', match_id: '/^k3/', temperature_locked: 0.5 }]);
  try {
    assert.equal(capability.temperatureFor({ provider: 'x', id: 'k3-alpha' }, 0.3), 0.5);
    // provider 精确匹配优先 ⇒ match_id 不参与
    assert.equal(capability.temperatureFor({ provider: 'x', id: 'other' }, 0.3), 0.5);
  } finally {
    capability.setConfigProfiles(null);
  }
  // provider 匹配不到 ⇒ 才轮到 match_id
  capability.setConfigProfiles([{ provider: 'zzz', match_id: '/^k3/', temperature_locked: 0.5 }]);
  try {
    assert.equal(capability.temperatureFor({ provider: 'custom', id: 'k3-alpha' }, 0.3), 0.5,
      'provider 匹配不到时, match_id 正则字面量必须生效');
    assert.equal(capability.temperatureFor({ provider: 'custom', id: 'other' }, 0.3), 0.3,
      'match_id 不匹配的模型不该被认');
  } finally {
    capability.setConfigProfiles(null);
  }
});

test('G3a4: provider 精确匹配优先于 id 特征匹配 (自定义档案不能被别的厂商截胡)', () => {
  // 真实踩过: provider='x' 配了自己的档案, 却因为 id 恰好叫 k3-256k,
  // 被 kimi 档案的 /^k3/ 特征匹配抢走 ⇒ 温度锁到 1.0 而不是自己配的 0.5。
  capability.setConfigProfiles([{ provider: 'x', temperature_locked: 0.5 }]);
  try {
    assert.equal(capability.temperatureFor({ provider: 'x', id: 'k3-256k' }, 0.3), 0.5,
      'provider 精确匹配必须压过 id 特征匹配');
  } finally {
    capability.setConfigProfiles(null);
  }
});

test('G3b: 非锁定端点的角色温度意图不被吞掉', () => {
  assert.equal(capability.temperatureFor({ provider: 'openai' }, 0), 0);
  assert.equal(capability.temperatureFor({ provider: 'openai' }, 0.3), 0.3);
});

test('G3c: 输出上限三处口径一致 (llm_caller / model_transport / 能力层)', () => {
  const transport = require(path.join(ROOT, 'modules', 'model_transport'));
  const minimax = { provider: 'minimax', id: 'minimax-m3' };
  // 之前 model_transport 只列了 minimax/agnes, llm_caller 还多列 4 个 —— 两份表会漂移。
  // 2026-10-27 (第 112 批): minimax 的端点上限从 16384 抬到 32768 ——
  // 2026-09-10 那条「>16384 就 400」已过期 (2026-10-27 直连实测 131072 都收 200)。
  assert.equal(capability.maxOutputTokens(minimax, 32768), 32768);
  assert.equal(transport.outputTokenCap(minimax, 32768), 32768, 'model_transport 口径必须一致');
});

test('G3d: 本地/云端超时按端点事实判定, 不按品牌名', () => {
  // 回环端点 = 本地 = 长超时
  assert.equal(capability.timeoutMs({ provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234' }), 300000);
  // 品牌是 lmstudio 但端点在云端 ⇒ 不能给本地超时
  assert.equal(capability.timeoutMs({ provider: 'lmstudio', endpoint: 'https://api.example.com/v1' }), 120000);
  // 品牌不是 lmstudio 但端点在回环 ⇒ 本地 (这正是以前漏判的那类)
  assert.equal(capability.timeoutMs({ provider: 'custom', endpoint: 'http://127.0.0.1:8000' }), 300000);
  assert.equal(capability.timeoutMs({ provider: 'vllm', endpoint: 'http://127.0.0.1:8000' }), 300000);
});

test('G3d2: 内网自建按自建口径 (第 102 批放开内网; 输出与超时仍同口径)', () => {
  // ── 2026-10-26 第 102 批: 这条守卫的判据**整体翻转**了 ──────────
  // 101 批的口径: 超时只看「回环 or 明确本地 provider」, 内网一律按云端
  //              (理由: 内网既可能是自建推理机 (慢), 也可能是网关 (不慢))。
  // 老板 102 批原话: 「内网自建推理服务 (192.168.x.x) 现在不吃本地 8192 软默认 ……
  //   要用得在模型条目显式写 local_output_tokens: 8192 —— 这个你考虑开源的走法」
  //
  // 开源的走法: ollama / vllm / llama.cpp / mlx / sglang / triton 的真实部署形态
  // 就是「一台机器 + 一个 OpenAI 兼容端点」, 那台机器**经常不在本机**
  // (家里的 NAS、机房的 vLLM、公司内网的推理机 ⇒ 192.168.x.x)。
  // ⇒ 「内网端点 = 自建推理服务」是开源生态的默认事实, 默认就该生效。
  //
  // ⚠️ 真正的不变量**不是**「内网算云端还是本地」, 而是:
  //    **输出软默认与超时必须同一个判据** —— 一个按自建一个按云端 = 两口径 = 故障。
  //    (101 批修掉的病就是 model_transport 含内网 / capability 只含回环, 同一模型两个超时。)
  //    所以这条守卫现在钉的是「同口径」, 不是「内网按云端」。
  const lm = require(path.join(ROOT, 'modules', 'local_model'));
  const intranet = { provider: 'custom', endpoint: 'http://192.168.1.50:8000/v1' };
  const intranet10 = { provider: 'custom', endpoint: 'http://10.0.0.5:8000/v1' };
  // 自建口径: 内网 = 长超时 (与回环同)
  assert.equal(capability.timeoutMs(intranet), 300000);
  assert.equal(capability.timeoutMs(intranet10), 300000);
  // 同一个判据: 输出软默认也按自建给 (102 批不用再手写 local_output_tokens)
  assert.equal(capability.softOutputCap(intranet), 8192);
  assert.equal(capability.softOutputCap(intranet10), 8192);
  // ⚠️ 同口径的**反向**证明: 云端自定义网关 (custom + 公网 https 端点) 两边都得是云端口径,
  //    不能因为「放宽到自建」就把它也带下水 (agnes 就是这种)。
  const cloudGateway = { provider: 'custom', endpoint: 'https://api.agnes-ai.cn/v1' };
  assert.equal(capability.timeoutMs(cloudGateway), 120000);
  assert.equal(capability.softOutputCap(cloudGateway), null);
  // 计费口径仍然含内网 (那是另一件事, 不许被这次收口改掉)
  assert.equal(lm.isLocalOrPrivateModel(intranet), true);
});

test('G3e: 显式 timeout_ms 永远压过默认', () => {
  assert.equal(capability.timeoutMs({ provider: 'lmstudio', timeout_ms: 45000 }), 45000);
  assert.equal(capability.timeoutMs({ provider: 'custom', endpoint: 'https://x.example', timeout_ms: 45000 }), 45000);
});

test('G3f: tool_calls 不稳定性是能力, 不认品牌', () => {
  assert.equal(capability.unstableToolCalls({ provider: 'kimi' }), true);
  assert.equal(capability.unstableToolCalls({ provider: 'openai' }), false);
  // 显式声明覆盖档案
  assert.equal(capability.unstableToolCalls({ provider: 'kimi', tool_calls_unstable: false }), false);
});

test('G3g: 调用方给的 cloud/local 兜底口径被尊重 (不同调用方默认值不同)', () => {
  // agents/qian.js 给的是 60s/300s, sub-agent.js 给的是 120s/300s
  assert.equal(capability.timeoutMs({ endpoint: 'https://x.example/v1' }, null, 60000, 300000), 60000);
  assert.equal(capability.timeoutMs({ endpoint: 'https://x.example/v1' }, null, 120000, 300000), 120000);
  assert.equal(capability.timeoutMs({ endpoint: 'http://127.0.0.1:8000' }, null, 60000, 300000), 300000);
  // 显式仍然最高
  assert.equal(capability.timeoutMs({ endpoint: 'https://x.example/v1', timeout_ms: 9999 }, null, 60000, 300000), 9999);
});

test('G3h: llm_caller 与 model_transport 的超时口径一致 (同一模型两个答案 = 故障)', () => {
  const transport = require(path.join(ROOT, 'modules', 'model_transport'));
  const cases = [
    { provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234' },      // 本地
    { provider: 'custom', endpoint: 'http://127.0.0.1:8000' },        // 自建本地 (以前漏判)
    { provider: 'custom', endpoint: 'https://api.example.com/v1' },   // 云端
    { provider: 'lmstudio', endpoint: 'https://api.example.com/v1' },  // 品牌骗人
  ];
  for (const m of cases) {
    const viaTransport = transport.resolveRequestTimeoutMs(m, 120000, 300000);
    const viaCapability = capability.timeoutMs(m, null, 120000, 300000);
    assert.equal(viaCapability, viaTransport,
      `同一模型两条路径超时不一致: ${JSON.stringify(m)} ⇒ transport=${viaTransport} capability=${viaCapability}`);
  }
});

test('G3i: 显式 max_output_tokens 压过厂商档案 (用户的话最大)', () => {
  assert.equal(capability.maxOutputTokens({ provider: 'minimax', max_output_tokens: 65536 }, 32768), 65536);
  assert.equal(capability.maxOutputTokens({ provider: 'minimax', max_tokens: 8192 }, 32768), 8192);
});

// ─────────────────────────────────────────────────────────────
// G4 · 变异体检 —— 能力层被绕过, 守卫必须**真**报红
//
// 注意: 早先一版只做"字符串替换 + 断言替换结果里有品牌名" —— 那验的是
// "我的正则能不能匹配", 不是"守卫会不会红"。守卫没红也是绿, 等于没有守卫。
// 现在真改文件 → 真跑守卫 → 断言红 → 还原。
// ─────────────────────────────────────────────────────────────

const { execFileSync } = require('node:child_process');

// 防递归: G4 会把守卫**自己**再跑一遍 (子进程)。子进程里必须跳过 G4,
// 否则无限递归 (G4a → 子进程 G4a → 子进程 G4a → ...)。
const _IS_MUTATION_CHILD = !!process.env.PANGU_CAPABILITY_MUTATION_CHILD;

// 真改文件跑一遍守卫, 返回失败信息; 守卫全绿则返回 null。
function _runGuardExpectingRed() {
  if (process.env.PANGU_CAPABILITY_DEBUG) {
    console.error('[mut-debug] execPath=', process.execPath,
      'argv=', JSON.stringify(process.argv.slice(0, 3)),
      'cwd=', process.cwd(),
      'NODE_OPTIONS=', process.env.NODE_OPTIONS || '(none)');
  }
  // ⚠️ 必须把 NODE_TEST_CONTEXT 摘掉。
  // Node 的 test runner 给**自己**的子进程设 NODE_TEST_CONTEXT=child-v8,
  // 被继承到孙进程时, 孙进程会认为"我已经在 test runner 里了" ⇒
  // `--test` 参数被忽略 ⇒ 根本不跑测试 ⇒ 静默 exit 0 ⇒
  // 守卫看起来"没报红"。这是假阴性最隐蔽的一种: 失败原因是**没跑**, 不是**没咬**。
  const childEnv = Object.assign({}, process.env, { PANGU_CAPABILITY_MUTATION_CHILD: '1' });
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    execFileSync(process.execPath, ['--test', path.join(__dirname, 'model-capability-generic-20261025.test.js')], {
      cwd: ROOT, stdio: 'pipe', timeout: 60000,
      env: childEnv,
    });
    return null;   // 全绿 = 守卫没咬 = 失败
  } catch (e) {
    if (process.env.PANGU_CAPABILITY_DEBUG) {
      console.error('[mut-debug] status=', e.status, 'signal=', e.signal,
        'stdout_len=', String(e.stdout || '').length,
        'has_not_ok=', /not ok/.test(String(e.stdout || '')),
        'stderr_head=', String(e.stderr || '').slice(0, 300));
    }
    return String(e.stdout || '') + String(e.stderr || '');
  }
}

// 把文件改成品牌硬判形态, 跑守卫, 还原。
function _mutateAndExpectRed(file, from, to) {
  const p = path.join(ROOT, file);
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(src.includes(from), `变异锚点没找到 (${file}) —— 测试自己失效了`);
  const mutated = src.replace(from, to);
  assert.notEqual(mutated, src, '变异没生效 —— 测试自己失效了');
  fs.writeFileSync(p, mutated);
  try {
    const out = _runGuardExpectingRed();
    assert.ok(out !== null, `守卫在「${file} 被改回品牌硬判」时**没有报红** ⇒ 守卫是假的`);
    assert.match(out, /not ok/, '报红必须是真失败, 不是别的错');
  } finally {
    fs.writeFileSync(p, src);   // 还原
  }
}

test('G4a: 把 role_model 换回品牌硬判 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;   // 子进程里不做变异 (防递归)
  _mutateAndExpectRed(
    'modules/role_model.js',
    'const _effectiveTemp = _modelCapability.temperatureFor(model, temp);',
    "const _isKimi = model.provider === 'kimi';\n  const _effectiveTemp = _isKimi ? 1.0 : temp;"
  );
});

test('G4b: 把超时判定换回品牌硬判 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/llm_caller.js',
    'timeout: _modelCapability.timeoutMs(useModel),',
    "timeout: useModel.timeout_ms || ((useModel.provider || '') === 'lmstudio' ? 300000 : 120000),"
  );
});

test('G4c: 把 tool_call 能力判断换回品牌硬判 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/j2_helpers.js',
    'if (_modelCapability.unstableToolCalls(model)) {',
    "if (model.provider === 'kimi') {"
  );
});

test('G4d: 把 model_transport 的输出上限换回第二份硬编码表 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/model_transport.js',
    'const cap = require(\'./model_capability\').maxOutputTokens(model, fallback);',
    "const cap = model.provider === 'minimax' ? 16384 : fallback;"
  );
});
