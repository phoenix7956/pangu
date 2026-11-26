'use strict';
// model_capability.js —— 「这个模型有什么怪癖」的唯一真源
//
// 2026-10-25 第 98 批。起因: 老板问「不要局限到个别云端或者本地, 应该是通用型的」。
// 审计发现 (全仓扫出来的品牌硬判):
//   · llm_caller.js  _resolveTemperature   → kimi 系强判 temperature=1
//   · llm_caller.js  _providerMaxOutputCap → minimax/agnes/lmstudio/ollama/... 各写一个上限
//   · model_transport.js outputTokenCap     → minimax/agnes 又抄了一份 (已经开始漂移)
//   · role_model.js  resolveRoleModel      → kimi 系强判 temperature=1 (第 3 份)
//   · j2_helpers.js  tool_call 探测        → kimi 系全失败时不降级 legacy
//   · llm_caller.js  ×3 超时               → provider==='lmstudio' 给 300s, 其余 120s
//
// 这些分支**各自都在解决真问题** (kimi 编码端点物理上只收 temperature=1;
// minimax max_tokens > 16384 直接 400; 本地大 prompt prefill 就是要几百秒)。
// 问题不在"有没有特判", 在于**特判的判据是品牌名而不是能力**:
//   换一个新厂商 → 要改代码; 三个地方抄三份 → 改一处漏两处;
//   一个模型同时符合两套规则 (本地模型走云端 cap) → 行为不可预测。
//
// 本模块的约定: **代码只读能力, 不认品牌**。
//   能力从哪来? 优先级: 模型配置显式字段 > 本表的已知厂商档案 > 通用默认值。
//   已知厂商档案是**数据**不是代码分支 —— 加一个新厂商只加一行档案, 不改逻辑。
//
// 能力字段 (都可以在模型配置里显式覆盖, 覆盖后本表完全不参与):
//   temperature_locked      number  → 端点物理上只接受这个温度 (kimi 编码端点 = 1.0)
//   max_output_tokens       number  → 单次输出**硬上限** (max_tokens 参数本身, 不是上下文窗口)
//                                   违反就 400 —— 用户的显式值也压不过它 (物理约束)
//   local_output_tokens     number  → 本地运行时的**软默认** (防思考吃光预算)
//                                   用户的显式值可以压过它 (那不是约束, 是默认值)
//   timeout_ms              number  → 单次请求 socket/fetch 超时
//   tool_calls_native       bool    → 明确支持原生 tool_calls (跳过 4 次探测)
//   tool_calls_unstable     bool    → 支持但不稳定 (探测全失败时也不降级 legacy)
//   reasoning_effort_channel 'api'|'prompt'|'none' → 推理预算的表达通道
//   chinese_proficiency     bool    → 中文能力强 (路由给中文任务时的偏好, 纯偏好不是硬约束)
//   reasoning_capable       bool    → 支持推理 (路由给推理类任务的偏好)

const DEFAULT_TIMEOUT_MS = 120000;
const LOCAL_TIMEOUT_MS = 300000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;
const LOCAL_DEFAULT_MAX_OUTPUT_TOKENS = 8192;

// 配置里的厂商档案 (llm.vendor_profiles) —— **运行时可扩展**。
// 上面 VENDOR_PROFILES 是代码内的兜底档案。
// 这样「接入一个新厂商」是**改配置**, 不是改代码 —— 这是"通用型"的落点。
//
// ⚠️ 合并语义 (不是替换): 配置里写了 acme, **不能**因此把 kimi 的已知事实丢掉。
//   配置条目按 provider 覆盖同名兜底档案, 没写到的厂商继续走兜底。
let _configProfiles = null;

function setConfigProfiles(profiles) {
  _configProfiles = Array.isArray(profiles) ? profiles : null;
}

// 合并后的档案池: **配置档案在前**, 代码兜底档案在后。
// 理由: 多个档案都靠 id 特征匹配时 (比如配置里自己加了一条厂商档案),
// 谁赢不能由数组顺序随手决定 —— 配置是用户的最新事实, 压过代码兜底。
// 同 provider 的兜底档案直接被配置条目覆盖 (不重复出现)。
function _profilePool() {
  if (!_configProfiles || !_configProfiles.length) return VENDOR_PROFILES;
  const pool = [];
  for (const p of _configProfiles) {
    if (!p || typeof p !== 'object') continue;
    pool.push(p);
  }
  for (const p of VENDOR_PROFILES) {
    const key = _lower(p.provider);
    // 同 provider 的兜底档案已被配置覆盖 ⇒ 不再重复
    if (key && pool.some(x => _lower(x.provider) === key)) continue;
    pool.push(p);
  }
  return pool;
}

// 由 init() 注入整份配置 (llm.vendor_profiles)。
function init(deps) {
  const cfg = deps && deps._config;
  setConfigProfiles(cfg && cfg.llm && Array.isArray(cfg.llm.vendor_profiles) ? cfg.llm.vendor_profiles : null);
  // 中文偏好档案也是配置驱动的 (llm.cn_profiles) —— 加一个国产厂商 = 加一行配置。
  setCnProfiles(cfg && cfg.llm && Array.isArray(cfg.llm.cn_profiles) ? cfg.llm.cn_profiles : null);
  // 2026-10-26 第 102 批: 自建推理服务的口径 (回环 or 内网 or 显式声明) 也是配置驱动的。
  //   llm.selfhosted_scope     'private' (默认, 开源走法) | 'loopback' (只算本机)
  //   llm.selfhosted_endpoints  额外声明的自建主机 (既不在回环也不在内网的自家机)
  setSelfHostedConfig({
    scope: (cfg && cfg.llm && cfg.llm.selfhosted_scope) || 'private',
    hosts: (cfg && cfg.llm && cfg.llm.selfhosted_endpoints) || [],
  });
}

// 已知厂商档案 —— 这是**数据**, 不是代码分支。
// 每条都必须是实测得来的 (注释里写清实测日期和现象), 不能凭印象加。
// 匹配顺序: 显式模型配置 > provider 精确匹配 > endpoint 主机名匹配 > 通用默认。
//
// ⚠️ 这张表是**兜底**, 不是唯一路径 —— 用户在配置里写了 max_output_tokens /
// timeout_ms / temperature_locked 的模型, 完全不经过这张表。
const VENDOR_PROFILES = [
  {
    // 2026-09-28 + 2026-10-13 实测: kimi 编码端点 (k3/k3-256k/kimi-for-coding)
    // 物理上只接受 temperature=1, 传别的值直接 HTTP 400 "invalid temperature: only 1 is allowed"。
    //
    // ⚠️ 匹配不能只靠 provider === 'kimi': 自定义网关 (provider='custom') 转发
    // kimi 模型时, 端点也不是 api.kimi.com, 但**它仍然是 kimi 编码端点** ⇒
    // 温度不锁照样 400。所以档案要能按 id/name 的特征匹配。
    // (旧代码靠 `_id.includes('kimi') || /^k3/.test(_id)` 认, 收进档案时不能丢掉。)
    // 匹配特征: kimi 出现在**词首** (kimi / kimi-for-coding / kimi-k2 …) 或 k3 开头。
    // 旧代码是 `_id.includes('kimi') || /^k3/.test(_id)` —— includes 会把
    // "not-kimi-at-all" 也认成 kimi (误伤)。这里用词边界收紧, 行为只更准不少认。
    match_id: /(^|[^a-z0-9])kimi|^k3/i,
    provider: 'kimi',
    temperature_locked: 1.0,
    // 2026-10-13 实测: k3 直接 curl 验证 tool_calls 100% 可用, 但在 echo 探测里
    // 间歇性 0/4 (思考后偶发不调工具) ⇒ 探测全失败时**不能**降级 legacy。
    tool_calls_unstable: true,
  },
  {
    // 2026-09-10 实测: MiniMax 窗口 4.2M 字符, 但 max_tokens > 16384 就 400
    // ("does not support max tokens > 524288" — 524288 是 input+output 总和)。
    //
    // ⚠ 2026-10-27 复测 (第 112 批): **这条 16384 已经过期了**。
    // 直连 api.minimaxi.com 实测 (MiniMax-M3.1-Flash, 2026-10-27):
    //   max_tokens=16384  → 200
    //   max_tokens=32768  → 200
    //   max_tokens=65536  → 200
    //   max_tokens=131072 → 200
    // (MiniMax-M3 同档 32768 也 200。)
    // 现在的实际后果: 推理模型 (MiniMax-M3.1-Flash) 的思考要吃掉 2.5 万 token
    // (实测 reasoning_tokens=25300), 输出预算卡在 16384 ⇒ 正文写不完
    // ⇒ 2026-10-26 现场「九节只到第四节就没了」。
    // ⇒ 抬到 32768 (实测能收; 不追着往 131072 跑, 留余量给别的厂商差异)。
    provider: 'minimax',
    max_output_tokens: 32768,
    // 2026-10-25 第 99 批: 旧 llm_caller 的 cap 表除 provider 精确匹配外,
    // 还有一条 **id 子串匹配** (`id.includes(p)`) —— 自定义网关转发 minimax 模型时
    // (provider='custom', id='minimax-m3') 也能吃到 16384 上限。
    // 第 98 批收进档案层时只给 kimi 写了 match_id ⇒ 这一档**丢了** ⇒
    // 网关转发 minimax 会发 max_tokens=32768 → 直接 HTTP 400。
    // ⇒ 档案补上 id 特征, 行为回到旧口径, 但判据是「档案数据」不是「代码分支」。
    match_id: 'minimax',
  },
  {
    // 2026-09-16 实测: agnes-ai.cn 网关 max_tokens 上限 65536, 保守设 32768。
    provider: 'agnes',
    max_output_tokens: 32768,
    // 同上: 旧表 id 子串匹配 (`id.includes('agnes')`) 也认这一档。
    match_id: 'agnes',
  },
];

// 2026-10-26 第 101 批: 这里原来有 4 条**本地运行时专属**档案
// (lmstudio / ollama / vllm / llamacpp 各一条 local_output_tokens: 8192)。
// 删掉它们 —— 本地软默认不再由「品牌名」决定, 而是由**端点事实**推导
// (见 softOutputCap + isLocalByEndpoint)。
//
// 为什么必须删 (不是"没必要", 是"有害"):
//   1. 通用性: 换一个本地运行时 (llamafile / sglang / triton / 自己的推理服务),
//      旧写法就得再加一条档案 —— 换厂商/换运行时 = 改代码, 违背通用型目标。
//   2. 正确性: 档案里的软默认**先于**端点事实生效 ⇒ provider='lmstudio'
//      但端点指向云端时, 输出预算按本地 8192 算, 超时却按云端 120s 算
//      ⇒ 同一个模型两个口径。档案层与端点事实层必须同源。
//
// 保留能力不丢: 本地软默认 (8192) 仍在, 只是判据从「provider 名字」
// 换成「端点是不是本机」—— 任何回环端点都自动吃到 8192。

// 中文能力档案 —— 独立于上面的**物理约束**档案。
//
// 为什么分开: 上面那张表是「端点物理上只收这么多」(违反就 400), 是硬约束。
// 这一张是「中文任务上表现更好」—— 是**偏好**, 不是约束。
// 违反偏好不会 400, 只是路由排序低一点。混在一起会让人以为可以随便突破。
//
// 2026-10-25 第 99 批: 原来 router 里硬编码了一个 provider 名单
// (`['minimax','kimi','qwen','zhipu','volcengine']`) 给中文任务加分。
// 那是「按品牌名表达能力」—— 换厂商要改代码, 且漏了 deepseek/glm 等。
// 现在收成档案: 加厂商 = 加一行数据。
const CN_PROFICIENCY_PROFILES = [
  // 2026-10-25 实测: 国产模型在中文长文本/古文/术语上的表现普遍优于同代英文模型。
  // 这里记的是**已知**的, 不做推测 —— 没被实测过的厂商不给加分。
  { provider: 'minimax', chinese_proficiency: true },
  { provider: 'kimi', chinese_proficiency: true },
  { provider: 'moonshotai', chinese_proficiency: true },
  { provider: 'qwen', chinese_proficiency: true },
  { provider: 'zhipu', chinese_proficiency: true },
  { provider: 'volcengine', chinese_proficiency: true },
  { provider: 'doubao', chinese_proficiency: true },
  { provider: 'deepseek', chinese_proficiency: true },
  { provider: 'baichuan', chinese_proficiency: true },
  { provider: 'hunyuan', chinese_proficiency: true },
  { provider: 'ernie', chinese_proficiency: true },
  { provider: 'spark', chinese_proficiency: true },
  { provider: 'pangu', chinese_proficiency: true },
  // 2026-09-16 实测: agnes-ai.cn 是国产聚合网关, 中文任务表现与上游一致。
  { provider: 'agnes', chinese_proficiency: true },
];

// endpoint 主机名匹配 (provider 是 custom 时用) —— 同样是**数据**。
const ENDPOINT_PROFILES = [
  { host: 'agnes-ai.cn', max_output_tokens: 32768 },
  { host: 'api.kimi.com', temperature_locked: 1.0, tool_calls_unstable: true },
];

function _lower(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

function endpointOf(model) {
  if (!model || typeof model !== 'object') return '';
  return String(model.endpoint || model.api_base || model.base_url || '').trim();
}

function hostOf(url) {
  try {
    return new URL(String(url || '')).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch (_) { return ''; }
}

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

// 找出这个模型匹配的厂商档案 (显式配置永远优先, 档案只是兜底)。
function vendorProfile(model) {
  if (!model || typeof model !== 'object') return null;
  // 配置档案优先 (用户自己写的 = 最新的事实), 但**合并**不是替换。
  const pool = _profilePool();
  // 顺序: provider 精确匹配 → endpoint 主机名 → id/name 特征。
  // ⚠️ provider 必须在 id 特征**前面**: 否则一个自定义 provider 配了自己的档案,
  // 会被别的厂商的 id 特征匹配抢走 (真实踩过: provider='x' 的档案被 kimi 的
  // /^k3/ 特征匹配截胡, 温度锁到 1.0 而不是自己配的 0.5)。
  const provider = _lower(model.provider);
  if (provider) {
    const hit = pool.find(p => _lower(p.provider) === provider);
    if (hit) return hit;
  }
  const host = hostOf(endpointOf(model));
  if (host) {
    const hit = ENDPOINT_PROFILES.find(p => host === p.host || host.endsWith('.' + p.host))
      || pool.find(p => p.host && (host === _lower(p.host) || host.endsWith('.' + _lower(p.host))));
    if (hit) return hit;
  }
  // id/name 特征匹配 (自定义网关转发某厂商模型时, provider 和端点都不带厂商名,
  //   但模型名带 —— 旧代码认这个 (_id.includes('kimi') || /^k3/), 收进档案不能丢)。
  const idSig = [model.id, model.name, model.api_model].map(v => String(v || '')).join(' ').trim();
  if (idSig) {
    // ⚠️ 只在**档案自己声明了 match_id** 时才参与 —— 而且必须跟模型的 provider 相容:
    //   档案.provider 是 'kimi' 而模型.provider 是 'x' ⇒ 这不是同一个厂商,
    //   不能拿 kimi 的 id 特征去认它 (真实踩过: provider='x' 配了自己的档案,
    //   却被 kimi 的 /^k3/ 截胡, 温度锁到 1.0)。
    //   相容 = 档案 provider 为空 (通用档案)
    //        或 模型 provider 为空/通用 ('custom' 只说明"自建端点", 不排除任何厂商 ——
    //           自定义网关转发 kimi 模型是最常见的真实场景, 必须认)
    //        或 两者相同。
    const GENERIC_PROVIDERS = new Set(['', 'custom', 'openai-compatible', 'gateway']);
    const byId = pool.find(p => {
      if (!p.match_id) return false;
      const pProv = _lower(p.provider);
      const compatible = !pProv
        || GENERIC_PROVIDERS.has(provider)
        || pProv === provider;
      if (!compatible) return false;
      // 档案里可以是正则 (代码内档案), 也可以是字符串 (配置文件里的 JSON 只能存字符串)。
      if (p.match_id instanceof RegExp) {
        p.match_id.lastIndex = 0;   // 防 g/y 标志的 lastIndex 残留
        return p.match_id.test(idSig);
      }
      const raw = String(p.match_id);
      // 字符串形态两种写法都支持:
      //   "kimi"        → 子串包含 (忽略大小写)
      //   "/kimi|^k3/i" → 正则字面量 (配置里存不了真正则对象, 只能这么写)
      const m = /^\/(.*)\/([gimsuy]*)$/.exec(raw);
      if (m) {
        try { return new RegExp(m[1], m[2].replace(/[gy]/g, '')).test(idSig); } catch (_) { return false; }
      }
      return idSig.toLowerCase().includes(raw.toLowerCase());
    });
    if (byId) return byId;
  }
  return null;
}

// 本地/云端 —— 判定收进 local_model 唯一真源 (端点事实), 不看品牌名。
function isLocal(model) {
  try { return require('./local_model').isLocalModel(model); } catch (_) { return false; }
}

// ── 自建推理服务判定 (输出软默认 + 超时 共用这一个判据) ──────────
//
// 2026-10-26 第 102 批。老板原话:
//   「内网自建推理服务 (192.168.x.x) 现在不吃本地 8192 软默认 ……
//     要用得在模型条目显式写 local_output_tokens: 8192 —— 这个你考虑开源的走法」
//
// 开源的走法是什么: 开源推理服务 (ollama / vllm / llama.cpp / mlx / sglang / triton)
// 在现实里的部署形态就是「一台机器 + 一个 OpenAI 兼容端点」, 而那台机器
// **经常不在本机** —— 家里的 NAS、机房里的 vLLM、公司内网的推理机, 地址都是 192.168.x.x。
// 所以「内网端点 = 自建推理服务」是开源生态的**默认事实**, 默认就该生效,
// 不该要求用户逐个模型手写 local_output_tokens。
//
// ⚠️ **一个判据, 两处用** —— 输出软默认与超时**必须同口径**。
//   101 批把两者都绑在「回环」上, 宁可少给默认值也不制造两口径;
//   102 批把口径**整体**放宽到「自建」(回环 + 内网 + 显式声明), 两者仍然同步放宽。
//   绝不能出现「输出按自建、超时按云端」或反之 —— 那正是 101 批修掉的病。
//
// 口径细则:
//   · 模型条目显式写 selfhosted: true/false ⇒ **最优先** (用户的话最大)
//   · 端点能解析 ⇒ 端点事实说了算 (回环 / 内网 / 显式声明的主机 = 自建)
//   · 端点缺失/不可解析 ⇒ 回退 provider 名单 (保持旧行为)
//   · 云端自定义网关 (custom + 公网端点, 如 agnes) ⇒ 不算自建 (仍按云端口径)
//
// 为什么不用 isLocalModel (provider 名单优先):
//   一个 provider 写着 lmstudio、端点却在云端的模型 (自定义网关挂了个本地 provider 名),
//   按名单判会给 300s, 失败检测被拖慢 5 倍。
//   这正是 local_model 注释里点名 agnes 的那个坑 (custom + 云端端点 却拿到 300s)。
let _selfHostedScope = 'private';
let _selfHostedHosts = [];

function setSelfHostedConfig(cfg) {
  const c = cfg || {};
  const scope = String(c.scope || 'private').trim().toLowerCase();
  _selfHostedScope = (scope === 'loopback') ? 'loopback' : 'private';
  _selfHostedHosts = Array.isArray(c.hosts)
    ? c.hosts.map(h => String(h || '').trim().toLowerCase()).filter(Boolean)
    : [];
}

function isSelfHostedByEndpoint(model) {
  if (!model || typeof model !== 'object') return false;
  // 模型条目显式声明最优先
  if (typeof model.selfhosted === 'boolean') return model.selfhosted;
  let lm;
  try { lm = require('./local_model'); } catch (_) { return false; }
  const ep = endpointOf(model);
  if (ep && lm.hostOf(ep)) {
    return lm.isSelfHostedEndpoint(ep, { scope: _selfHostedScope, hosts: _selfHostedHosts });
  }
  // 端点不可用 ⇒ 回退 provider 名单 (保持旧行为, 不让缺端点的配置退化成云端超时)
  return lm.isLocalProvider(model.provider);
}

// 第 101 批的旧名 —— 保留是为了不打断外部引用, 语义已并入自建口径。
// (旧名里的「本地」指回环; 新口径含内网, 所以这里只做别名, 不再另立一套判据。)
const isLocalByEndpoint = isSelfHostedByEndpoint;

// ===== 能力查询 (代码里**只**调这几个函数, 不再认品牌) =====

// 温度: **端点锁死 > 调用方的温度意图**。
// 调用方 (desired) 是"我想用多少度" —— 主循环是 model.temperature / 全局配置,
// 角色派生是角色自己的温度 (executor/planner 是 0)。两端点物理锁死时 (kimi 编码端点
// 只收 1.0) 用意图值就是 HTTP 400, 所以锁死必须压过一切意图。
//
// ⚠️ 这里**不能**写成 "model.temperature 优先于 desired": 角色派生时 model.temperature
// 是主模型的温度, 而角色的意图 (0) 才是要的 —— 反过来会让角色温度永远不生效。
function temperatureFor(model, desired) {
  const locked = capability(model, 'temperature_locked');
  if (locked != null) return locked;
  if (desired != null && typeof desired === 'number') return desired;
  if (model && typeof model.temperature === 'number') return model.temperature;
  return 1.0;
}

// ===== 输出预算: 四层语义, 一层都不能混 =====
//
// 2026-10-25 第 99 批。混成一个字段的后果已经踩过一次:
// 98 批把「显式值」和「厂商上限」塞进同一个 `explicit` ⇒ 显式值直接盖过
// 厂商物理上限 ⇒ minimax 传 max_tokens=32768 ⇒ HTTP 400
// ("does not support max tokens > 16384")。
// 修法不是"再调一个 if", 是**把语义拆开**, 每层各管各的:
//
//   层1 显式声明  model.max_output_tokens
//       用户在模型条目上写的**上限声明** —— 「这个端点我确认能收这么多」。
//       压过一切档案 (98 批 G1d/G3i 已钉死): 用户说 65536 就是 65536。
//
//   层2 请求意图  model.max_tokens
//       「这次我要多少输出」的**意图** —— 不是端点的事实。
//       被层3 硬上限 clamp (取 min): 意图再大也不能超端点物理上限。
//
//   层3 硬上限    档案的 max_output_tokens
//       端点物理上只收这么多, 违反就 400 ⇒ 是**上限**, 不是默认值。
//
//   层4 软默认    档案的 local_output_tokens (或本地端点的 8192 默认)
//       防思考吃光预算的**默认值** —— 用户的显式值可以压过它。
//
// 另有两个外部输入:
//   预算 budget   调用方给的上下文预算 (llm_caller 用 registry 窗口折算)
//   兜底 fallback 调用方自己的默认值 (不同调用方不同)
//
// 合并规则 (一条一句):
//   层1 有值        → 直接用它 (用户的话最大)
//   层2 有值        → min(层2, 层3)   (意图被物理上限压; 预算不参与 ——
//                                旧语义就是「显式值替换 registry 预算」)
//   层2 无值        → 层3 > 层4 > 预算 > 兜底, 结果再与预算取小

// 硬上限 (层3): 端点物理上只收这么多。
function hardOutputCap(model) {
  const prof = vendorProfile(model);
  if (!prof) return null;
  return _num(prof.max_output_tokens);
}

// 软默认 (层4): 防跑飞的**默认值**, 用户的显式值可以压过它。
//
// 判据是**端点事实**, 不是品牌名: 回环/本地 provider 的端点就是本地运行时
// ⇒ 用本地默认预算。这条让「本地」不再依赖 lmstudio/ollama/vllm 这些名字 ——
// 任何回环端点 (provider='custom' 指向 127.0.0.1) 都一样算本地。
function softOutputCap(model) {
  // 模型条目上的显式声明优先 (用户可以给某个模型单独调)
  const declared = _num(model && model.local_output_tokens);
  if (declared) return declared;
  // 2026-10-26 第 101 批: **端点事实优先于厂商档案**。
  // 旧顺序 (档案 → 端点) 会让 provider='lmstudio' + 云端端点这种组合
  // 吃到本地软默认 8192, 而 timeoutMs 走端点事实给云端口径 ⇒ 同一模型两个口径。
  // 2026-10-26 第 102 批: 判据从「回环」放宽到「自建」(回环 + 内网) ——
  // 内网自建推理服务 (192.168.x.x) 默认就吃到软默认, 不用手写 local_output_tokens。
  // ⚠️ 与 timeoutMs 用的是**同一个** isSelfHostedByEndpoint ⇒ 两个口径仍然同步。
  if (!isSelfHostedByEndpoint(model)) return null;
  const fromProfile = _num((vendorProfile(model) || {}).local_output_tokens);
  if (fromProfile) return fromProfile;
  return LOCAL_DEFAULT_MAX_OUTPUT_TOKENS;
}

// 单次输出参数上限 (max_tokens 参数本身, 不是上下文窗口)。
// fallback: 调用方兜底;  budget: 调用方给的上下文预算 (可为 null)。
function maxOutputTokens(model, fallback, budget) {
  // 层1: 模型条目上的显式声明 —— 压过一切档案。
  const declared = _num(model && model.max_output_tokens);
  if (declared) return declared;

  const hard = hardOutputCap(model);
  const soft = softOutputCap(model);
  const asked = _num(model && model.max_tokens);   // 层2: 请求意图
  const budgetCap = _num(budget);                   // 上下文预算

  // 层2 有值 ⇒ 意图被硬上限压 (层3), 预算不参与 (旧语义: 显式值替换 registry 预算)
  if (asked) return hard ? Math.min(asked, hard) : asked;

  // 没有请求意图 ⇒ 档案说了算: 硬上限 > 软默认 > 预算 > 兜底
  let base;
  if (hard) base = hard;
  else if (soft) base = soft;
  else base = budgetCap || _num(fallback) || DEFAULT_MAX_OUTPUT_TOKENS;
  // 档案定的值也不能超过上下文预算 (预算描述的是模型窗口的物理事实)
  if (budgetCap && (hard || soft)) base = Math.min(base, budgetCap);
  return base;
}

// 单次请求超时。
// cloudMs / localMs: 调用方给的**兜底** (不同调用方口径不同: 有的 60s 有的 120s)。
//   本地/云端的判定用**端点事实** (isSelfHostedByEndpoint), 不看品牌名。
//   ⚠️ 与 softOutputCap **同一个判据** —— 102 批把口径一起放宽到「自建」,
//   绝不能让「输出按自建、超时按云端」(那又是一次两口径)。
function timeoutMs(model, fallback, cloudMs, localMs) {
  const explicit = _num(model && model.timeout_ms);
  if (explicit) return explicit;
  const prof = capability(model, 'timeout_ms');
  if (prof != null) return prof;
  const base = _num(fallback);
  if (base) return base;
  if (isSelfHostedByEndpoint(model)) return _num(localMs) || LOCAL_TIMEOUT_MS;
  return _num(cloudMs) || DEFAULT_TIMEOUT_MS;
}

// 原生 tool_calls 能力 (三态: true / false / null=未知, 要探测)。
function nativeToolCalls(model) {
  if (model && typeof model.tool_calls_native === 'boolean') return model.tool_calls_native;
  const prof = capability(model, 'tool_calls_native');
  if (typeof prof === 'boolean') return prof;
  return null;
}

// 支持但不稳定 —— 探测全失败时也不降级 legacy。
function unstableToolCalls(model) {
  if (model && typeof model.tool_calls_unstable === 'boolean') return model.tool_calls_unstable;
  const prof = capability(model, 'tool_calls_unstable');
  return prof === true;
}

// 推理预算的表达通道: 'api' (发 reasoning_effort 字段) / 'prompt' (提示词层指令) / 'none'。
function reasoningEffortChannel(model) {
  if (model && typeof model.reasoning_effort_channel === 'string') {
    const v = _lower(model.reasoning_effort_channel);
    if (v === 'api' || v === 'prompt' || v === 'none') return v;
  }
  const prof = capability(model, 'reasoning_effort_channel');
  if (prof === 'api' || prof === 'prompt' || prof === 'none') return prof;
  // 默认: 本地走提示词层 (2026-10-15 实测 LM Studio 服务端不认 reasoning_effort 字段),
  // 云端走 API 字段。
  return isLocal(model) ? 'prompt' : 'api';
}

// 通用能力读取: 显式模型字段 > 厂商档案。
function capability(model, name) {
  if (!model || typeof model !== 'object') return undefined;
  if (model[name] !== undefined && model[name] !== null) return model[name];
  const prof = vendorProfile(model);
  if (!prof) return undefined;
  return prof[name];
}

// 中文能力 —— 走**独立的偏好档案** (CN_PROFICIENCY_PROFILES)。
//
// 为什么不复用 vendorProfile(): 那是物理约束档案, 一个模型只命中一条。
// 偏好档案要能叠加 (比如「既是 minimax 又是中文强」), 而且语义不同 (偏好 vs 约束)。
//
// 匹配顺序与物理档案一致: provider 精确 > endpoint 主机名 > id/name 特征。
// id 特征用 match_id —— 这样自定义网关转发国产模型时也认得出来
// (旧 router 的 provider 名单认不出来, provider='custom' 就丢加分)。
function chineseProficiency(model) {
  if (!model || typeof model !== 'object') return false;
  // 显式配置优先 (用户的话最大)
  if (typeof model.chinese_proficiency === 'boolean') return model.chinese_proficiency;
  const provider = _lower(model.provider);
  const pool = _cnPool();
  if (provider) {
    const hit = pool.find(p => _lower(p.provider) === provider);
    if (hit) return hit.chinese_proficiency === true;
  }
  const host = hostOf(endpointOf(model));
  if (host) {
    const hit = pool.find(p => p.host && (host === _lower(p.host) || host.endsWith('.' + _lower(p.host))));
    if (hit) return hit.chinese_proficiency === true;
  }
  const idSig = [model.id, model.name, model.api_model].map(v => String(v || '')).join(' ').trim();
  if (idSig) {
    const GENERIC_PROVIDERS = new Set(['', 'custom', 'openai-compatible', 'gateway']);
    const byId = pool.find(p => {
      if (!p.match_id) return false;
      const pProv = _lower(p.provider);
      const compatible = !pProv || GENERIC_PROVIDERS.has(provider) || pProv === provider;
      if (!compatible) return false;
      if (p.match_id instanceof RegExp) {
        p.match_id.lastIndex = 0;
        return p.match_id.test(idSig);
      }
      const raw = String(p.match_id);
      const m = /^\/(.*)\/([gimsuy]*)$/.exec(raw);
      if (m) {
        try { return new RegExp(m[1], m[2].replace(/[gy]/g, '')).test(idSig); } catch (_) { return false; }
      }
      return idSig.toLowerCase().includes(raw.toLowerCase());
    });
    if (byId) return byId.chinese_proficiency === true;
  }
  return false;
}

// 中文偏好档案池 (配置优先, 压过代码兜底)。
let _cnProfiles = null;
function setCnProfiles(profiles) {
  _cnProfiles = Array.isArray(profiles) ? profiles : null;
}
function _cnPool() {
  if (!_cnProfiles || !_cnProfiles.length) return CN_PROFICIENCY_PROFILES;
  const pool = [];
  for (const p of _cnProfiles) {
    if (p && typeof p === 'object') pool.push(p);
  }
  for (const p of CN_PROFICIENCY_PROFILES) {
    const key = _lower(p.provider);
    if (key && pool.some(x => _lower(x.provider) === key)) continue;
    pool.push(p);
  }
  return pool;
}

// 推理能力 —— 判断依据**不按品牌名**, 按已知的模型家族规则库。
//
// 2026-10-25 第 99 批: 原来 router 里硬编码了一条正则
// (/reasoning|thinking|r1|^o1|^o3|qwen.*reason|k3|kimi.*(?:think|reason)|deepseek-r/i)
// 那是**按品牌名表达能力** —— 换个推理模型的正则就不认了, 而规则库已经覆盖 11 个国产厂商。
// 现在走 llm_capabilities_cn 这个离线规则库 (单一真源, 已实测)。
//
// 优先级: 显式 reasoning 字段 > role_specialty/capabilities 含 reasoning > 规则库 > 保守默认 false。
function reasoningCapable(model) {
  if (!model || typeof model !== 'object') return false;
  if (typeof model.reasoning === 'boolean') return model.reasoning;
  const caps = Array.isArray(model.role_specialty) ? model.role_specialty : (Array.isArray(model.capabilities) ? model.capabilities : null);
  if (caps && caps.some(s => String(s).toLowerCase() === 'reasoning')) return true;
  try {
    const cn = require('./llm_capabilities_cn');
    const hit = cn.lookupCnCapabilities(model);
    if (hit && typeof hit.reasoning === 'boolean') return hit.reasoning;
  } catch (_) { /* 规则库不可用 ⇒ 保守默认 */ }
  return false;
}

module.exports = {
  VENDOR_PROFILES,
  ENDPOINT_PROFILES,
  CN_PROFICIENCY_PROFILES,
  DEFAULT_TIMEOUT_MS,
  LOCAL_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  LOCAL_DEFAULT_MAX_OUTPUT_TOKENS,
  init,
  setConfigProfiles,
  setCnProfiles,
  setSelfHostedConfig,
  vendorProfile,
  capability,
  temperatureFor,
  maxOutputTokens,
  hardOutputCap,
  softOutputCap,
  timeoutMs,
  nativeToolCalls,
  unstableToolCalls,
  reasoningEffortChannel,
  chineseProficiency,
  reasoningCapable,
  isLocal,
  isSelfHostedByEndpoint,
  isLocalByEndpoint,
};
