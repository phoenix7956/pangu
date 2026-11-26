'use strict';
// 第 99 批: 模型层通用性守卫 (第二轮)
//
// 起因仍是老板那句「不要局限到个别云端或者本地, 应该是通用型的」。
// 98 批把**厂商怪癖**收进了档案层, 但还有三处「按品牌名表达能力」没动:
//   ① 输出上限的三种含义混在一个字段里 (显式声明 / 请求意图 / 端点硬上限)
//      ⇒ 用户显式配的值会被端点上限吞掉, 或反过来把端点上限顶穿 (HTTP 400)
//   ② router 里写死 provider 名单给中文任务加分 (换厂商要改代码, 且漏一堆)
//   ③ router 里写死一条正则判推理能力 (规则库已覆盖 11 个国产厂商却没人用)
//   ④ API Key 的环境变量名是一张写死的表 (新厂商查不到 key ⇒ 误判"没鉴权")
//
// 本守卫要证明:
//   G5 · 四层语义各管各的 —— 混层就吞用户的话
//   G6 · 档案驱动: 加厂商 = 改配置, 不改代码
//   G7 · 推理能力走规则库 (不按品牌正则)
//   G8 · key 环境变量名有命名约定 (新厂商通常什么都不用改)
//   G9 · 品牌扫描覆盖面扩展到 router / api_key_resolver
//   G10 · 变异体检: 能力层被绕过 ⇒ 守卫必须**真**报红

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const capability = require(path.join(ROOT, 'modules', 'model_capability'));
const caller = require(path.join(ROOT, 'modules', 'llm_caller'));
const transport = require(path.join(ROOT, 'modules', 'model_transport'));

// ─────────────────────────────────────────────────────────────
// G5 · 输出上限的四层语义
// ─────────────────────────────────────────────────────────────
test('G5a: 端点硬上限压过请求意图 (请求再大也不能超物理上限)', () => {
  // 2026-09-10 实测: minimax max_tokens > 16384 直接 HTTP 400。
  // ⚠ 2026-10-27 复测 (第 112 批): 这条上限已经过期 —— 直连实测 16384/32768/
  //   65536/131072 全部 200 ⇒ 端点上限抬到 32768。
  //   不变量没变: **端点物理上限仍然压过请求意图** —— 只是数字变了。
  assert.equal(capability.maxOutputTokens({ provider: 'minimax', max_tokens: 65536 }, 32768), 32768);
  assert.equal(capability.maxOutputTokens({ provider: 'minimax', id: 'minimax-m3', max_tokens: 65536 }, 32768), 32768);
  // 主链路 (llm_caller) 与 transport 两条路径必须同一个答案
  assert.equal(caller._maxTokensCap({ provider: 'minimax', id: 'minimax-m3', max_tokens: 65536 }), 32768);
  assert.equal(transport.outputTokenCap({ provider: 'minimax', id: 'minimax-m3', max_tokens: 65536 }), 32768);
  // 意图比上限小 ⇒ 意图说了算
  assert.equal(capability.maxOutputTokens({ provider: 'minimax', max_tokens: 8192 }, 32768), 8192);
});

test('G5b: 本地软默认被显式值压过 (8192 是默认值, 不是约束)', () => {
  // 本地 8192 是「防思考吃光预算」的默认值 —— 用户的显式值可以压过它。
  // 旧 llm_caller 的 `if (explicitCap && _isLocalModel) return cap;` 就是这个意思。
  assert.equal(capability.maxOutputTokens({ provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234', max_tokens: 32768 }, 32768), 32768);
  assert.equal(caller._maxTokensCap({ provider: 'lmstudio', id: 'local-qwen', endpoint: 'http://127.0.0.1:1234', max_tokens: 32768 }), 32768);
  // 没有显式值 ⇒ 走软默认
  assert.equal(capability.maxOutputTokens({ provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234' }, 32768), 8192);
});

test('G5c: 模型条目上的显式声明压过厂商档案 (用户的话最大)', () => {
  // max_output_tokens = 用户对**这个端点**的声明 ("我确认它能收这么多")。
  // 98 批 G3i 已钉死这条, 本批不能破。
  assert.equal(capability.maxOutputTokens({ provider: 'minimax', max_output_tokens: 65536 }, 32768), 65536);
  assert.equal(capability.maxOutputTokens({ provider: 'kimi', max_output_tokens: 99999 }, 1), 99999);
});

test('G5d: 档案值压过调用方兜底 (配置里的厂商档案说了算)', () => {
  capability.setConfigProfiles([{ provider: 'acme', max_output_tokens: 4096 }]);
  try {
    assert.equal(capability.maxOutputTokens({ provider: 'acme', id: 'acme-1' }, 999), 4096);
    assert.equal(capability.maxOutputTokens({ provider: 'acme', id: 'acme-1', max_tokens: 2048 }, 999), 2048);
  } finally {
    capability.setConfigProfiles(null);
  }
});

test('G5e: 自定义网关转发某厂商模型仍拿到该厂商的上限 (match_id 生效)', () => {
  // 最容易丢的一档: provider='custom'、端点也是别人的域名, 但**模型名**是 minimax。
  // 丢了 match_id ⇒ 网关转发 minimax 发 max_tokens=32768 ⇒ HTTP 400。
  assert.equal(capability.maxOutputTokens({ provider: 'custom', id: 'minimax-m3', endpoint: 'https://gw.example.com/v1' }, 32768), 32768);
  assert.equal(capability.maxOutputTokens({ provider: 'custom', id: 'agnes-3.0-flash', endpoint: 'https://gw.example.com/v1' }, 32768), 32768);
  assert.equal(caller._maxTokensCap({ provider: 'custom', id: 'minimax-m3', endpoint: 'https://gw.example.com/v1' }), 32768);
});

test('G5f: 本地与否看**端点事实**, 不看 provider 名字 (通用型的关键)', () => {
  // provider 起什么名字都不影响: 回环 = 本地 = 软默认 8192。
  assert.equal(capability.maxOutputTokens({ provider: 'custom', id: 'x', endpoint: 'http://127.0.0.1:8000/v1' }, 32768), 8192);
  assert.equal(capability.maxOutputTokens({ provider: 'brand-new-vendor', id: 'x', endpoint: 'https://api.example.com/v1' }, 32768), 32768);
  // IPv6 回环也算本地 (旧正则漏过这一档)
  assert.equal(capability.maxOutputTokens({ provider: 'custom', id: 'x', endpoint: 'http://[::1]:1234/v1' }, 32768), 8192);
});

// ─────────────────────────────────────────────────────────────
// G6 · 档案驱动: 加厂商 = 改配置
// ─────────────────────────────────────────────────────────────
test('G6a: 中文能力从配置读, 配置能加也能覆盖', () => {
  capability.setCnProfiles([{ provider: 'newvendor', chinese_proficiency: true }]);
  try {
    assert.equal(capability.chineseProficiency({ provider: 'newvendor', id: 'nv-1' }), true,
      '配置里加一个厂商, 中文加分必须立刻生效 —— 不该改代码');
  } finally {
    capability.setCnProfiles(null);
  }
  // 配置撤掉 ⇒ 回到内置档案 (未知厂商没有加分)
  assert.equal(capability.chineseProficiency({ provider: 'newvendor', id: 'nv-1' }), false);
  // 内置档案里的已知厂商
  assert.equal(capability.chineseProficiency({ provider: 'minimax' }), true);
  assert.equal(capability.chineseProficiency({ provider: 'openai' }), false);
});

test('G6b: 中文偏好与物理约束是**两套档案** (违反偏好不会 400)', () => {
  // 中文偏好走 cn_profiles, 不走 vendor_profiles —— 两者语义不同, 不能混。
  assert.equal(capability.vendorProfile({ provider: 'openai' }), null);
  assert.equal(capability.chineseProficiency({ provider: 'openai' }), false);
  // 显式声明压过一切
  assert.equal(capability.chineseProficiency({ provider: 'minimax', chinese_proficiency: false }), false);
  assert.equal(capability.chineseProficiency({ provider: 'openai', chinese_proficiency: true }), true);
});

test('G6c: 网关转发国产模型也认得出中文能力 (match_id 生效)', () => {
  capability.setCnProfiles([{ provider: 'minimax', match_id: 'minimax', chinese_proficiency: true }]);
  try {
    assert.equal(capability.chineseProficiency({ provider: 'custom', id: 'minimax-m3', endpoint: 'https://gw.example.com/v1' }), true);
  } finally {
    capability.setCnProfiles(null);
  }
});

test('G6d: 配置文件里的厂商档案用对了字段 (硬上限别写成软默认)', () => {
  // 配置是**真源** —— 字段用错会把用户显式配的输出上限砍掉。
  //
  // 2026-10-26 第 101 批改口径: 原来这里断言「配置里每个本地 provider
  // (lmstudio/ollama/vllm/llamacpp) 必须有 local_output_tokens 数字」。
  // 那条断言把**品牌名**钉死了 —— 换任何本地运行时都得改代码改配置,
  // 违背通用型目标。现在本地软默认由**端点事实**推导 (端点在本机 => 8192),
  // 配置里**不该**再按品牌写本地档案。
  //
  // 保留的意图: ① 本地运行时别把软默认写成硬上限 (会吞用户显式值)
  //             ② 有硬上限的厂商必须带 match_id (网关转发时上限不能丢)
  //             ③ 中文偏好档案必须存在
  const cfgPath = require(path.join(__dirname, '..', 'config', 'node_config')).resolveNodeConfigPathOrExample();
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const profiles = (cfg.llm && cfg.llm.vendor_profiles) || [];
  for (const p of profiles) {
    if (!p || typeof p.local_output_tokens !== 'number') continue;
    // 本地软默认不再按品牌写: 写了也不该生效 (端点事实说了算)
    assert.equal(p.max_output_tokens, undefined,
      `${p.provider} 写了 local_output_tokens 就不能同时写 max_output_tokens —— 硬上限会吞掉用户显式配的输出上限`);
  }
  // 通用性: 配置里不该再有「本地运行时专属」档案 (换个本地运行时要改配置 = 不通用)
  const LOCAL_BRAND_PROFILES = new Set(['lmstudio', 'ollama', 'vllm', 'llamacpp']);
  for (const p of profiles) {
    if (!p || !LOCAL_BRAND_PROFILES.has(String(p.provider || '').toLowerCase())) continue;
    assert.equal(p.local_output_tokens, undefined,
      `${p.provider} 是本地运行时品牌名 —— 本地软默认应由端点事实推导, 不该按品牌写在配置里 (否则换个本地运行时就得改配置)`);
  }
  // 端点事实口径: 本地端点自动有软默认, 云端端点不吃本地软默认
  assert.equal(capability.softOutputCap({ provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234' }), 8192);
  assert.equal(capability.softOutputCap({ provider: 'lmstudio', endpoint: 'https://api.example.com/v1' }), null);
  assert.equal(capability.softOutputCap({ provider: 'brand-new-runtime', endpoint: 'http://127.0.0.1:9999/v1' }), 8192);
  // 有硬上限的厂商必须带 match_id (否则网关转发时会丢上限 ⇒ HTTP 400)
  for (const p of profiles) {
    if (!p || typeof p.max_output_tokens !== 'number') continue;
    assert.ok(p.match_id, `${p.provider} 有硬上限却没写 match_id ⇒ 网关转发时上限会丢`);
  }
  // 中文偏好档案必须存在 (否则中文加分永远走不到配置)
  assert.ok(Array.isArray(cfg.llm && cfg.llm.cn_profiles), 'llm.cn_profiles 必须是数组');
});

// ─────────────────────────────────────────────────────────────
// G7 · 推理能力走规则库, 不走品牌正则
// ─────────────────────────────────────────────────────────────
test('G7a: 推理能力按规则库判定 (deepseek-r1 是推理模型)', () => {
  // 旧 router 的正则判 deepseek-r1 = true; 规则库原本笼统归成 false ——
  // 换真源会把行为改掉 ⇒ 规则库补回真实能力, 而不是把守卫钉死在旧错值上。
  assert.equal(capability.reasoningCapable({ id: 'deepseek-r1', provider: 'deepseek' }), true);
  assert.equal(capability.reasoningCapable({ id: 'deepseek-reasoner', provider: 'deepseek' }), true);
  assert.equal(capability.reasoningCapable({ id: 'deepseek-chat', provider: 'deepseek' }), false);
  assert.equal(capability.reasoningCapable({ id: 'minimax-m3', provider: 'minimax' }), true);
  assert.equal(capability.reasoningCapable({ id: 'gpt-4o', provider: 'openai' }), false);
});

test('G7b: 显式声明压过规则库', () => {
  assert.equal(capability.reasoningCapable({ id: 'minimax-m3', provider: 'minimax', reasoning: false }), false);
  assert.equal(capability.reasoningCapable({ id: 'gpt-4o', provider: 'openai', reasoning: true }), true);
  assert.equal(capability.reasoningCapable({ id: 'x', capabilities: ['chat', 'reasoning'] }), true);
});

test('G7c: router 的推理判定走能力层 (不再自带品牌正则)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'modules', 'router', 'smart_router.js'), 'utf8');
  const codeLines = src.split('\n').filter(l => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
  assert.doesNotMatch(codeLines, /deepseek-r|\^\^o1|qwen.*reason/i,
    'router 里还有按品牌名判推理能力的正则');
  assert.match(codeLines, /reasoningCapable/, 'router 必须走能力层的 reasoningCapable');
});

// ─────────────────────────────────────────────────────────────
// G8 · API Key 环境变量名: 约定 + 例外 + 显式覆盖
// ─────────────────────────────────────────────────────────────
test('G8a: 未知厂商按命名约定推 key 名 (新厂商通常什么都不用改)', () => {
  const { _credKeyFor } = require(path.join(ROOT, 'modules', 'api_key_resolver'));
  assert.equal(_credKeyFor({ provider: 'minimax' }), 'MINIMAX_API_KEY');
  assert.equal(_credKeyFor({ provider: 'newvendor' }), 'NEWVENDOR_API_KEY');
  assert.equal(_credKeyFor({ provider: 'MoonshotAI' }), 'MOONSHOTAI_API_KEY');
  // 例外 (历史命名不同)
  assert.equal(_credKeyFor({ provider: 'qwen' }), 'DASHSCOPE_API_KEY');
  // 显式声明优先
  assert.equal(_credKeyFor({ provider: 'newvendor', api_key_env: 'CUSTOM_ENV' }), 'CUSTOM_ENV');
  // provider 名字拼不成环境变量名 ⇒ 不瞎猜
  assert.equal(_credKeyFor({ provider: 'my vendor!' }), null);
  assert.equal(_credKeyFor({}), null);
});

test('G8b: 探针走 key 解析真源 (新厂商探针不再误判"没鉴权")', () => {
  const src = fs.readFileSync(path.join(ROOT, 'pangu-single', 'routes', 'inline_router.js'), 'utf8');
  const codeLines = src.split('\n').filter(l => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
  assert.doesNotMatch(codeLines, /_PROVIDER_CRED_KEYS\[/,
    '探针还在直接查厂商 key 表 ⇒ 新厂商查不到 key');
  // 2026-10-26 (第 110 批): 判据从「用了哪个函数」换成**概念** ——
  //   「探针必须走统一解析链」。
  //   原来判「必须出现 _credKeyFor」, 那是**写法**不是概念:
  //   探针后来改走完整解析链 (modules/api_key_resolver.resolveApiKey, 含凭证库),
  //   _credKeyFor 这个名字自然就不出现了 —— 守卫会假红, 而它本来要防的真问题
  //   (探针自己抄半条链 ⇒ 跳过凭证库 ⇒ 密钥搬走后误判「没鉴权」) 反而没人管了。
  assert.match(codeLines, /_resolveApiKey\(/, '探针必须走统一解析链 resolveApiKey');
  assert.doesNotMatch(codeLines, /model\.api_key/,
    '探针不许直接读明文字段 api_key ⇒ 密钥收编进凭证库后会拿到空串, 误判成「没鉴权」');
});

// ─────────────────────────────────────────────────────────────
// G9 · 品牌扫描覆盖面扩展
// ─────────────────────────────────────────────────────────────
test('G9a: router / api_key_resolver 里也没有按品牌名的分支', () => {
  const EXEMPT = new Set([
    'modules/model_capability.js',
    'modules/model_capabilities.js',
    'modules/local_model.js',
    'modules/tools/media_gen.js',
    'modules/lmstudio_cache_guard.js',
    'modules/llm_capabilities_cn.js',   // 离线规则库 (厂商命名规则本身就是数据)
  ]);
  const BRANDS = 'kimi|minimax|agnes|lmstudio|lm-studio|ollama|vllm|llamacpp';
  // ⚠️ 必须**双向**匹配:
  //   正向: provider 在前  —— `if (p.provider === 'x')`
  //   反向: 品牌在前      —— `['minimax','kimi'].includes(m.provider)`
  // 只做正向会漏掉后一种 (真实漏过一次: 变异把中文加分改回名单, 守卫却全绿)。
  const BRAND = new RegExp(`provider[^\\n;]{0,40}['"](${BRANDS})['"]`);
  const BRAND_REV = new RegExp(`['"](${BRANDS})['"][^\\n;]{0,80}\\bprovider\\b`);
  const isProtocolLine = (t) =>
    /anthropic/.test(t) || (/ollama/.test(t) && /protocol|normalizeEndpoint|api\/chat|11434|messages/i.test(t));
  const files = [
    'modules/router/smart_router.js',
    'modules/api_key_resolver.js',
  ];
  const bad = [];
  for (const f of files) {
    if (EXEMPT.has(f)) continue;
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      if (isProtocolLine(t)) return;
      if (BRAND.test(t) || BRAND_REV.test(t)) bad.push(`${f}:${i + 1}: ${t.slice(0, 90)}`);
    });
  }
  assert.deepEqual(bad, [], '还有按品牌名的分支:\n' + bad.join('\n'));
});

test('G9c: router 的中文加分走能力层 (名单写法会被守卫抓住)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'modules', 'router', 'smart_router.js'), 'utf8');
  const codeLines = src.split('\n').filter(l => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
  assert.match(codeLines, /chineseProficiency/, '中文加分必须走能力层');
  // 名单写法 (品牌字面量数组) 一律不允许出现在 router 里
  assert.doesNotMatch(codeLines, /\[[^\]]*['"](minimax|kimi|qwen|zhipu|volcengine)['"]/,
    'router 里还有中文 provider 名单');
});

test('G9b: 厂商 key 表只是**数据**, 不是分支 (数据表不算违规)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'modules', 'api_key_resolver.js'), 'utf8');
  const codeLines = src.split('\n').filter(l => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
  // 表里出现品牌名是允许的 (那是已知厂商的 key 名) —— 前提是**没有**按品牌分支的代码。
  assert.doesNotMatch(codeLines, /if\s*\([^)]*provider[^)]*===/,
    'api_key_resolver 里还有按 provider 取值的分支');
});

// ─────────────────────────────────────────────────────────────
// G10 · 变异体检 —— 能力层被绕过, 守卫必须**真**报红
// ─────────────────────────────────────────────────────────────
const { execFileSync } = require('node:child_process');

const _IS_MUTATION_CHILD = !!process.env.PANGU_CAPABILITY_MUTATION_CHILD;

function _runGuardExpectingRed() {
  // ⚠️ 必须把 NODE_TEST_CONTEXT 摘掉 (见 98 批 G4 的注释):
  // Node 的 test runner 给自己的子进程设 NODE_TEST_CONTEXT=child-v8,
  // 被继承到孙进程时, 孙进程认为"我已经在 test runner 里了" ⇒ --test 被忽略
  // ⇒ 根本不跑测试 ⇒ 静默 exit 0 ⇒ 守卫看起来"没报红"。这是假阴性最隐蔽的一种。
  const childEnv = Object.assign({}, process.env, { PANGU_CAPABILITY_MUTATION_CHILD: '1' });
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    execFileSync(process.execPath, ['--test', path.join(__dirname, 'model-capability-generic-99-20261025.test.js')], {
      cwd: ROOT, stdio: 'pipe', timeout: 60000,
      env: childEnv,
    });
    return null;   // 全绿 = 守卫没咬 = 失败
  } catch (e) {
    return String(e.stdout || '') + String(e.stderr || '');
  }
}

function _mutateAndExpectRed(file, from, to) {
  const p = path.join(ROOT, file);
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(src.includes(from), `变异锚点没找到 (${file}) —— 测试自己失效了`);
  const mutated = src.replace(from, to);
  assert.notEqual(mutated, src, '变异没生效 —— 测试自己失效了');
  fs.writeFileSync(p, mutated);
  try {
    const out = _runGuardExpectingRed();
    assert.ok(out !== null, `守卫在「${file} 被改回品牌硬判/混层」时**没有报红** ⇒ 守卫是假的`);
    assert.match(out, /not ok/, '报红必须是真失败, 不是别的错');
  } finally {
    fs.writeFileSync(p, src);   // 还原
  }
}

test('G10a: 把「请求意图被硬上限压」改回「意图直接返回」⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/model_capability.js',
    'if (asked) return hard ? Math.min(asked, hard) : asked;',
    'if (asked) return asked;'
  );
});

test('G10b: 把「软默认」混成硬上限 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  // 2026-10-26 第 101 批: softOutputCap 的判定顺序改了 (端点事实先于档案),
  // 变异锚点跟着改成新代码的两行 —— 锚点找不到时守卫会自己失效 (假阴性)。
  _mutateAndExpectRed(
    'modules/model_capability.js',
    '  if (fromProfile) return fromProfile;\n  return LOCAL_DEFAULT_MAX_OUTPUT_TOKENS;',
    '  if (fromProfile) return fromProfile;\n  return { max_output_tokens: LOCAL_DEFAULT_MAX_OUTPUT_TOKENS };'
  );
});

test('G10c: 把中文加分改回 provider 名单硬判 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/router/smart_router.js',
    "if (task === 'chinese' && (m._chinese !== undefined ? m._chinese : _modelCapability.chineseProficiency(m))) {\n    s += 0.25;\n  }",
    "if (task === 'chinese' && ['minimax', 'kimi', 'qwen', 'zhipu', 'volcengine'].includes(m.provider)) {\n    s += 0.25;\n  }"
  );
});

test('G10d: 把推理判定改回品牌正则 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/model_capability.js',
    'const hit = cn.lookupCnCapabilities(model);',
    'const hit = null;'
  );
});

test('G10e: 把 key 名约定改回只查表 ⇒ 守卫必须报红', () => {
  if (_IS_MUTATION_CHILD) return;
  _mutateAndExpectRed(
    'modules/api_key_resolver.js',
    'return _conventionalCredKey(provider);',
    'return null;'
  );
});
