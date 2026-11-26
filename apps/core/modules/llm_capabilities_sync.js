// apps/core/modules/llm_capabilities_sync.js — 2026-08-22
// 老板拍: 自动同步云端模型 capabilities 库, 出新模型不用手动维护
// 数据源: sst/models.dev (sst/opencode 团队维护的开源 LLM 元数据库, 每日更新, 覆盖 30+ 厂商 1000+ 模型)
// 国内访问策略: 优先 jsdelivr CDN (gh/sst/models.dev@<branch>/models.json), 失败 fallback 到 raw.githubusercontent.com
// 离线 fallback: 本地缓存 ~/.pangu/cache/models_dev.json (永远可用, 哪怕完全没网)
// schema (sst/models.dev OpenRouter 风格):
//   { data: [
//       { id: "provider/model_id",
//         architecture: { modality: "text+image->text", input_modalities: ["text","image"] },
//         supported_parameters: ["tools", "reasoning", ...],  // 含 "tools" → tool support
//         context_length: 262144 }
//   ] }
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

const CACHE_DIR = path.join(os.homedir(), '.pangu', 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'models_dev.json');
const META_FILE = path.join(CACHE_DIR, 'models_dev_meta.json');

const SOURCES = [
  // jsdelivr CDN (国内可用率高)
  { name: 'jsdelivr-dev',  url: 'https://cdn.jsdelivr.net/gh/sst/models.dev@dev/models.json',    branch: 'dev',  timeout: 20000 },
  { name: 'jsdelivr-main', url: 'https://cdn.jsdelivr.net/gh/sst/models.dev@main/models.json',   branch: 'main', timeout: 20000 },
  // 官方 raw (海外)
  { name: 'raw-main',      url: 'https://raw.githubusercontent.com/sst/models.dev/main/models.json',  branch: 'main', timeout: 20000 },
  { name: 'raw-dev',       url: 'https://raw.githubusercontent.com/sst/models.dev/dev/models.json',   branch: 'dev',  timeout: 20000 },
];

function _ensureCacheDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}
}

// 把 sst/models.dev 的 modality 字段映射成 vision/reasoning/tool
// modality 例子: "text+image->text" / "text->text" / "text+image+file->text"
function _normalizeCapabilities(entry) {
  const arch = entry.architecture || {};
  const modality = arch.modality || 'text->text';
  const inputModalities = arch.input_modalities || [];
  const params = entry.supported_parameters || [];
  // vision: 输入含 image / file / video / audio 任一
  const vision = inputModalities.some(m => ['image', 'file', 'video', 'audio'].includes(m));
  // reasoning: supported_parameters 含 reasoning 或 include_reasoning
  const reasoning = params.some(p => /^reasoning|include_reasoning/.test(p));
  // tool: supported_parameters 含 tools / tool_choice
  const tool = params.some(p => /^tool/.test(p));
  // ctx
  const ctx = entry.context_length || null;
  return { vision, reasoning, tool, ctx, modality, input_modalities: inputModalities };
}

// 拉一份源, 失败返 null
function _fetch(source) {
  return new Promise((resolve) => {
    const url = source.url;
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'pangu-sync/1.0' } }, (resp) => {
      if (resp.statusCode !== 200) {
        resp.resume();
        return resolve(null);
      }
      const chunks = [];
      let total = 0;
      resp.on('data', c => { chunks.push(c); total += c.length; });
      resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      resp.on('error', () => resolve(null));
    });
    req.setTimeout(source.timeout || 20000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// 同步 (启动时调, 不阻塞)
//   - 依次试所有 source, 第一个成功的就落地
//   - 失败保留本地缓存 (上次成功的) 不动
//   - 成功 → 写入 models_dev.json (扁平表) + models_dev_meta.json (来源/时间)
let _syncing = false;
async function syncModelsDev({ force = false, log = console.log } = {}) {
  if (_syncing && !force) return { ok: false, reason: 'ALREADY_SYNCING' };
  _syncing = true;
  try {
    _ensureCacheDir();
    for (const src of SOURCES) {
      const text = await _fetch(src);
      if (!text) { log('[llm-cap-sync] ' + src.name + ' failed'); continue; }
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { log('[llm-cap-sync] ' + src.name + ' parse err: ' + e.message); continue; }
      if (!parsed.data || !Array.isArray(parsed.data) || parsed.data.length === 0) {
        log('[llm-cap-sync] ' + src.name + ' no data[]');
        continue;
      }
      // 扁平化为 { "<provider>/<id>": { vision, reasoning, tool, ctx, modality } }
      const flat = {};
      for (const e of parsed.data) {
        if (!e.id) continue;
        flat[e.id] = _normalizeCapabilities(e);
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify(flat));
      const meta = {
        source: src.name,
        url: src.url,
        count: Object.keys(flat).length,
        synced_at: new Date().toISOString(),
      };
      fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
      log('[llm-cap-sync] ' + src.name + ' → ' + meta.count + ' 个模型, 缓存 ' + CACHE_FILE);
      return { ok: true, ...meta };
    }
    log('[llm-cap-sync] 所有源都失败, 沿用本地缓存');
    return { ok: false, reason: 'ALL_SOURCES_FAILED', cache: CACHE_FILE };
  } finally {
    _syncing = false;
  }
}

// 启动时同步: 不 await (不阻塞 boot), 失败无所谓
function syncModelsDevBackground(log) {
  syncModelsDev({ log: log || console.log }).catch(e => {
    if (log) log('[llm-cap-sync] bg failed: ' + e.message);
  });
}

let _cachedFlat = null;
function _loadFlat() {
  if (_cachedFlat) return _cachedFlat;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      _cachedFlat = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      return _cachedFlat;
    }
  } catch (_) {}
  _cachedFlat = {};
  return _cachedFlat;
}

function getSyncMeta() {
  try {
    if (fs.existsSync(META_FILE)) return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  } catch (_) {}
  return null;
}

// 给定 provider (openai/anthropic/minimax/kimi/...) + model_id, 查 capability
//
// ── 2026-10-26 第 102 批: 这里原来有个「查错」的坑 ──────────────
//
// 老板问: 「lookupCapabilities 对新厂商是'查不到'还是'查错'?」
// 实测答: **两个都会**。
//   查不到: provider 猜不出 ⇒ 直接 null (连"为什么查不到"都没有)
//   查错:   厂商被**改判** + 跨厂商**模糊命中** ⇒ 把别家的能力安到这个模型上
//
// 改判 (实测, 改前):
//   {provider:'newvendor', id:'k3'}       → moonshotai   ← 新厂商被判成月之暗面
//   {provider:'acme',      id:'kimi-k2'}  → moonshotai   ← 同上
//   {provider:'acme',      id:'qwen3-8b'} → alibaba      ← 同上
// 根因: 厂商猜测规则里的 **id 特征** (id 含 'k3'/'qwen'/'kimi' 就判那家),
//       在「模型条目已经写了 provider」的时候**覆盖了用户写的事实**。
//
// 模糊命中 (查错的另一半):
//   旧 step3 用 `kModelNorm.startsWith(wanted) || wanted.startsWith(kModelNorm)`
//   ⇒ **截断查询**会串到别的模型 (2026-10-26 交叉审用旧代码实测):
//        lookup('moonshotai','kimi')      → moonshotai/kimi-k2.6    (不是它!)
//        lookup('moonshotai','kimi-k2-0') → moonshotai/kimi-k2-0905 (不是它!)
//   ⚠️ 完整模型名 ('kimi-k2-thinking' / 'kimi-k2') 旧代码是**精确命中**的,
//      串台只发生在「名字被截断」时 —— 别拿完整名当举证, 那条复现不出来。
//
// 现在的规矩 (**命中必须精确到模型名**):
//   A. 同命名空间 + 模型名完全一致            → 权威
//   B. 全库模型名完全一致且**唯一**            → 权威
//      (模型身份就是模型身份 —— 谁提供它, 它就是那个模型)
//   C. 全库模型名完全一致但**多家都有**        → 同命名空间优先; 否则**非权威**
//   D. 名字对不上 (前缀/包含都不算)            → 查不到 ⇒ 走自定义兼容模式
//      (见 resolveCapabilities; 不猜、不串到别家)
//
// 「模型名」的写法差异 (MLX/llama.cpp 风格) 由 _modelCandidates 归一:
//   'qwen_qwen3.8-27b' → 'qwen3.8-27b'  (去厂商前缀)
//   'qwen3.8-27b-mlx'  → 'qwen3.8-27b'  (去运行时后缀)
//   'claude-sonnet-4-5' ≡ 'claude-sonnet-4.5' (分隔符归一, 见 _norm)
function _norm(s) {
  return String(s || '').toLowerCase().trim().replace(/[-_.\s\/]+/g, '');
}

// 运行时/量化后缀 —— 同一个模型的另一种写法。
const _MODEL_SUFFIX_RE = /[-_]?(mlx|gguf|4bit|5bit|6bit|8bit|q4|q5|q6|q8|int4|int8|awq|gptq)$/i;

// 一个模型 id 的**候选写法** —— 每个候选都必须在库里**精确命中**才算数。
// 候选只是「换个写法再找一次」, **不是**近似匹配。
function _modelCandidates(modelId) {
  const raw = String(modelId || '').trim();
  if (!raw) return [];
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s.length >= 2 && !out.includes(s)) out.push(s);
  };
  push(raw);
  // 带命名空间的写法 ('openai/gpt-4o')
  const slash = raw.indexOf('/');
  if (slash > 0) push(raw.slice(slash + 1));
  // 去运行时/量化后缀 (可叠两层)
  let noSuffix = raw.replace(_MODEL_SUFFIX_RE, '');
  push(noSuffix);
  const noSuffix2 = noSuffix.replace(_MODEL_SUFFIX_RE, '');
  if (noSuffix2 !== noSuffix) push(noSuffix2);
  // 去厂商前缀 (MLX/llama.cpp 风格 '厂商_模型名')
  const us = raw.indexOf('_');
  if (us > 0) {
    const tail = raw.slice(us + 1);
    push(tail);
    push(tail.replace(_MODEL_SUFFIX_RE, ''));
  }
  return out;
}

// 库里一个条目的「模型名」: key 的最后一段。**标签 (:free / :thinking) 保留** ——
// ':thinking' 不是定价变体, 是**另一个模型** (reasoning 版), 合并了就查错。
// ':free' 虽是定价变体, 但能力可能不同, 也不该由我们替他合并。
function _entryModelName(key) {
  const parts = String(key).split('/');
  return parts[parts.length - 1];
}

// 库里一个条目的「命名空间」: key 的第一段。
function _entryNamespace(key) {
  return String(key).split('/')[0];
}

// ── 标签策略 (数据驱动, 不是拍脑袋) ─────────────────────────
//
// 2026-10-26 交叉审实测: 能力库 364 条里, 带标签的只有两种 ——
//   ':free'      25 条 —— OpenRouter 的**定价**变体 (免费额度), 模型本体是同一个
//   ':thinking'   1 条 —— 'qwen/qwen-plus-2025-07-28:thinking', **另一个模型** (reasoning 版)
//
// 所以只有 ':free' 允许跨标签救 (「查 'x' 而库里是 'x:free'」),
// ':thinking' **任何方向都不许合并** —— 合并了 reasoning 能力整个搞反, 那就是查错。
//   'qwen-plus-2025-07-28'  ≠  'qwen-plus-2025-07-28:thinking'
const CAPABILITY_NEUTRAL_TAGS = new Set(['free']);

// 一个候选名的**等价写法** (同一个模型, 不同拼法 / 不同定价标签)。
// ⚠️ 顺序有意义: **精确写法永远排第一** —— 先试带标签的, 再试等价标签的。
function _tagVariants(candidate) {
  const raw = String(candidate || '').trim();
  if (!raw) return [];
  const out = [];
  const push = (v) => { if (v && !out.includes(v)) out.push(v); };
  const i = raw.indexOf(':');
  if (i > 0) {
    const tag = raw.slice(i + 1).toLowerCase();
    const base = raw.slice(0, i);
    push(raw);                                    // 原样先试 (精确优先)
    if (CAPABILITY_NEUTRAL_TAGS.has(tag)) push(base);  // ':free' ⇒ 无标签版等价
    return out;
  }
  push(raw);                                      // 无标签先试 (精确优先)
  push(raw + ':free');                            // 库里只有 ':free' 版时救回来
  return out;
}

// 索引 (随缓存一起建, 不每次重扫)。
//   byNs    : 命名空间 → 模型名(归一, **带标签**) → key   (同命名空间精确命中)
//   byModel : 模型名(归一, 带标签) → [key...]             (全库模型名命中)
// 标签的处理在**候选名**那一层 (见 _tagVariants) —— 索引只按原样存,
// 这样「同命名空间的精确条目」永远赢过「跨标签救回来的条目」。
let _cachedIndex = null;
function _index() {
  if (_cachedIndex && _cachedIndex.flat === _cachedFlat) return _cachedIndex;
  const flat = _loadFlat();
  const byNs = new Map();
  const byModel = new Map();
  for (const key of Object.keys(flat)) {
    const ns = _norm(_entryNamespace(key));
    const mn = _norm(_entryModelName(key));
    if (!ns || !mn) continue;
    let nsMap = byNs.get(ns);
    if (!nsMap) { nsMap = new Map(); byNs.set(ns, nsMap); }
    if (!nsMap.has(mn)) nsMap.set(mn, key);
    let list = byModel.get(mn);
    if (!list) { list = []; byModel.set(mn, list); }
    if (!list.includes(key)) list.push(key);
  }
  _cachedIndex = { flat, byNs, byModel };
  return _cachedIndex;
}

// 查能力 —— **只给权威命中**。
// ⚠️ 2026-10-26 交叉审改的: 原来这里会把「多家同名」的歧义命中也返回出去
//    (authoritative:false), 任何不检查 authoritative 的调用方都会拿到**查错**的能力。
//    现在歧义一律不返回 (返回就是查错), 需要看歧义候选的走 lookupCapabilitiesDetail。
function lookupCapabilities(provider, modelId) {
  const d = lookupCapabilitiesDetail(provider, modelId);
  return d.status === 'hit' ? d.hit : null;
}

// 同上, 但**说清是哪种结果**: hit (权威命中) / ambiguous (多家同名, 判不了) / miss (查不到)。
function lookupCapabilitiesDetail(provider, modelId) {
  if (!modelId) return { status: 'miss', hit: null, candidates: [] };
  const idx = _index();
  const ns = _norm(provider);
  const cands = _modelCandidates(modelId);
  let ambiguous = null;
  for (const cand of cands) {
    for (const variant of _tagVariants(cand)) {
      const r = _lookupIn(idx, ns, _norm(variant), variant === cand ? 'exact' : 'tag-equivalent');
      if (!r) continue;
      if (r.authoritative) return { status: 'hit', hit: r, candidates: [] };
      if (!ambiguous) ambiguous = r;
    }
  }
  if (ambiguous) return { status: 'ambiguous', hit: null, candidates: ambiguous.candidates || [] };
  return { status: 'miss', hit: null, candidates: [] };
}

// 在索引里找: 先同命名空间, 再全库唯一; 同名多家 ⇒ 非权威 (交给调用方走自定义兼容模式)。
function _lookupIn(idx, ns, mn, tag) {
  if (!mn) return null;
  const nsMap = idx.byNs.get(ns);
  const sameNs = nsMap && nsMap.get(mn);
  if (sameNs) {
    return { ...idx.flat[sameNs], key: sameNs, match: tag, namespace: _entryNamespace(sameNs), authoritative: true };
  }
  const hits = idx.byModel.get(mn) || [];
  if (hits.length === 1) {
    const key = hits[0];
    return { ...idx.flat[key], key, match: 'model-only', namespace: _entryNamespace(key), authoritative: true };
  }
  if (hits.length > 1) {
    // 同名多家 ⇒ 能力可能不同 (同名 ≠ 同模型) ⇒ 不权威, 交给调用方走自定义兼容模式
    return {
      ...idx.flat[hits[0]], key: hits[0], match: 'ambiguous',
      namespace: _entryNamespace(hits[0]), authoritative: false, candidates: hits.slice(),
    };
  }
  return null;
}

// 给定 m.id 提取 provider hint (从 endpoint 域名或 id 前缀猜)
//   - endpoint: api.minimaxi.com → minimax, api.kimi.com → kimi, api.openai.com → openai
//   - id: "gpt-4o" → openai, "claude-3-..." → anthropic, "kimi-..." / "k3-..." → moonshot
// 厂商猜测规则表 -- **数据**, 不是代码分支。
//
// 2026-10-26 第 101 批: 原来这里是 16 个硬编 if, 换厂商就得改代码。
// 现在: 规则是数据, 可以在配置里加 (llm.provider_guess_rules) 覆盖/扩展,
// 加一个厂商 = 加一行, 不用改代码。
//
// 每条规则三个可选判据, 命中任一即算命中 (与旧 if 逐字等价):
//   prov -- 模型条目的 provider 字段 (小写精确相等)
//   ep   -- endpoint 的小写全文 (正则或子串)
//   id   -- 模型 id 的小写全文 (正则或子串)
// provider -- 命中后返回的内部 provider 名。
//
// ⚠️ provider 返回值与 prov 触发值**故意**不同:
//   kimi -> moonshotai (Moonshot 的上游 org 名)
//   baidu / tencent / iflytek 同理 (上游 org 名)
// 这些是 models.dev 里的 provider 键, 改了就查不到能力库。
//
// ⚠️ 2026-10-26 交叉审改的: provider 必须是**能力库里真实存在的命名空间**。
//    原来这几条写的是厂商自己的名字, 但库里根本不叫这个 ——
//      zhipu     → 库里叫 'z-ai'           (13 条)
//      alibaba   → 库里叫 'qwen'           (47 条; 'alibaba' 命名空间只有 1 条)
//      bytedance → 库里叫 'bytedance-seed' (4 条; 'bytedance' 只有 1 条)
//      meta      → 库里叫 'meta-llama'     (14 条)
//      mistral   → 库里叫 'mistralai'      (24 条)
//    写错的后果: 那个厂商的模型**永远查不到** ⇒ 全部掉进自定义兼容模式 (能力靠自己声明)。
//    ('alibaba' / 'bytedance' 这两个命名空间库里也各有 1 条, 所以还留了 alt 备用命名空间。)
const DEFAULT_PROVIDER_GUESS_RULES = [
  { provider: 'minimax',    prov: 'minimax',    ep: /minimax|minimaxi|minimaxi\.com/ },
  { provider: 'moonshotai', prov: 'kimi',        ep: /kimi|moonshot/,         id: /kimi|moonshot|k3/ },
  { provider: 'openai',     prov: 'openai',     ep: /openai\.com/ },
  { provider: 'anthropic',  prov: 'anthropic',  ep: /anthropic\.com/,         id: /claude/ },
  { provider: 'google',     prov: 'google',     ep: /googleapis\.com|generativelanguage\.googleapis/, id: /gemini/ },
  { provider: 'deepseek',   prov: 'deepseek',   ep: /deepseek\.com/,          id: /deepseek/ },
  { provider: 'z-ai',       prov: 'zhipu',      ep: /bigmodel\.cn|glm/,       id: /glm/ },
  { provider: 'baidu',      prov: 'baidu',      ep: /qianfan|ernie/,          id: /ernie/ },
  { provider: 'qwen',       prov: 'alibaba',    ep: /dashscope|aliyun/,       id: /qwen/ },
  { provider: 'bytedance-seed', prov: 'bytedance', ep: /ark\.cn|volcengine/,  id: /doubao|seed-/ },
  { provider: 'tencent',    prov: 'tencent',    ep: /tencentcloud|hunyuan/,   id: /hunyuan/ },
  { provider: 'iflytek',    prov: 'iflytek',    ep: /spark/,                  id: /spark/ },
  { provider: 'meta-llama', prov: 'meta',       id: /llama/ },
  { provider: 'mistralai',  prov: 'mistral',    ep: /mistralai/,              id: /mistral|mixtral/ },
  { provider: 'cohere',     prov: 'cohere',     ep: /cohere/,                 id: /command-/ },
  { provider: 'perplexity', prov: 'perplexity', ep: /perplexity/,             id: /pplx-|sonar/ },
];

let _providerGuessRules = null;

// 字符串模式 -> 匹配器:
//   /re/i 字面量 -> 正则; 其余字符串 -> 小写子串包含。
function _compilePattern(p) {
  if (p instanceof RegExp) return p;
  if (typeof p !== 'string') return null;
  const s = p.trim();
  if (!s) return null;
  const m = /^\/(.*)\/([gimsuy]*)$/.exec(s);
  if (m) {
    try { return new RegExp(m[1], m[2].replace(/g/g, '')); } catch (_) { return null; }
  }
  return s.toLowerCase();
}

function _patternHit(pattern, text) {
  if (pattern instanceof RegExp) return pattern.test(text);
  if (typeof pattern === 'string' && pattern) return text.includes(pattern);
  return false;
}

function _normalizeRules(rules) {
  const out = [];
  for (const r of rules || []) {
    if (!r || typeof r !== 'object') continue;
    const provider = String(r.provider || '').trim().toLowerCase();
    if (!provider) continue;
    out.push({
      provider,
      prov: r.prov ? String(r.prov).trim().toLowerCase() : null,
      ep: _compilePattern(r.ep),
      id: _compilePattern(r.id),
    });
  }
  return out;
}

// 注入配置里的规则 (llm.provider_guess_rules)。传 null 回到内置默认表。
//
// ⚠️ 配置规则是**叠加**在内置表之前的, 不是替换 ——
// 「加一个厂商 = 加一行」不能顺手把其余 16 条内置猜测弄丢。
// 同一个 provider 出现两次时, 配置那条赢 (配置是用户的最新事实)。
function setProviderGuessRules(rules) {
  _providerGuessRules = _normalizeRules(rules);
}

// 由 init() 注入整份配置
function init(deps) {
  const cfg = deps && deps._config;
  setProviderGuessRules(
    cfg && cfg.llm && Array.isArray(cfg.llm.provider_guess_rules) ? cfg.llm.provider_guess_rules : null
  );
}

function _guessRules() {
  if (!_providerGuessRules || !_providerGuessRules.length) return DEFAULT_PROVIDER_GUESS_RULES;
  const pool = _providerGuessRules.slice();
  for (const p of DEFAULT_PROVIDER_GUESS_RULES) {
    if (pool.some(x => x.provider === p.provider)) continue;   // 同 provider: 配置那条赢
    pool.push(p);
  }
  return pool;
}

function guessProvider(model) {
  if (!model) return null;
  const ep = String(model.endpoint || '').toLowerCase();
  const id = String(model.id || '').toLowerCase();
  const prov = String(model.provider || '').toLowerCase();
  for (const rule of _guessRules()) {
    if (rule.prov && prov === rule.prov) return rule.provider;
    if (rule.ep && _patternHit(rule.ep, ep)) return rule.provider;
    if (rule.id && _patternHit(rule.id, id)) return rule.provider;
  }
  return null;
}

// ── 厂商解析: 显式 provider 是事实, 优先于一切猜测 ────────────
//
// 2026-10-26 第 102 批。旧行为 (guessProvider 直接用规则表跑):
//   模型条目写了 provider:'newvendor', 但 id 里带 'k3' ⇒ 规则表的 id 特征命中
//   ⇒ 被改判成 moonshotai ⇒ **查错**。
//
// 现在: 写了 provider 就以它为准。
//   · 规则表认识这个 provider ⇒ 映射到 models.dev 的命名空间 (kimi → moonshotai)
//   · 规则表不认识 ⇒ **新厂商** ⇒ 就用用户写的名字 (custom=true),
//     查不到就走自定义兼容模式, **不改判成别家**。
//
// 泛用 provider (custom / openai-compatible / gateway / 空) 不算事实 ——
// 它们只说明「这是个自建端点」, 厂商要靠端点/模型名去认。
// (自定义网关转发 kimi 是真实场景, 必须认出来。)
const GENERIC_PROVIDERS = new Set([
  '', 'custom', 'openai-compatible', 'openai_compatible', 'gateway', 'self-hosted', 'selfhosted',
]);

function resolveProvider(model) {
  if (!model || typeof model !== 'object') {
    return { provider: null, rawProvider: '', origin: 'none', custom: false, altNamespaces: [] };
  }
  const prov = String(model.provider || '').trim().toLowerCase();
  if (prov && !GENERIC_PROVIDERS.has(prov)) {
    for (const rule of _guessRules()) {
      if (rule.prov && rule.prov === prov) {
        return {
          provider: rule.provider, rawProvider: prov, origin: 'explicit', custom: false,
          altNamespaces: _altNamespaces(rule.provider, prov),
        };
      }
    }
    // 规则表不认识 ⇒ 新厂商 ⇒ 用用户写的名字 (不改判), 但也可以直接当命名空间试一次
    return { provider: prov, rawProvider: prov, origin: 'explicit', custom: true, altNamespaces: [] };
  }
  const guessed = guessProvider(model);
  if (guessed) {
    return {
      provider: guessed, rawProvider: prov, origin: 'rule', custom: false,
 altNamespaces: _altNamespaces(guessed, prov),
    };
  }
  return { provider: null, rawProvider: prov, origin: 'none', custom: false, altNamespaces: [] };
}

// 备用命名空间 —— 厂商自己的名字**恰好也是**能力库里的命名空间时, 再试一次。
//
// 例: provider='alibaba' ⇒ 主命名空间 'qwen' (47 条, 主体在 qwen 下),
//     但库里也有 'alibaba' 命名空间 (1 条: alibaba/tongyi-deepresearch-30b-a3b)。
//     主命名空间查不到时再试备用 ⇒ 两种模型都能查到, 不用二选一。
function _altNamespaces(primary, rawProv) {
  const p = String(primary || '').toLowerCase();
  const raw = String(rawProv || '').toLowerCase();
  if (!raw || raw === p) return [];
  try {
    const idx = _index();
    // 命名空间在库里存在 (byNs 里至少有一条) 才算备用命名空间
    const nsMap = idx.byNs.get(_norm(raw));
    return nsMap && nsMap.size ? [raw] : [];
  } catch (_) {
    return [];
  }
}

// ── 自定义兼容模式 ───────────────────────────────────────────
//
// 「查不到」不等于「什么都不给」。
//
// 新厂商 (我们不认它) 或能力库没收录 ⇒ 进入自定义兼容模式:
//   · 能力取**模型条目自己写的** (vision / reasoning / tool / context_length …)
//   · 没写的 = **未知** (不是 false) ⇒ 交给探测, 不猜
//   · 不套任何厂商档案的物理约束
//   · 来源标成 'model-declared' ⇒ UI/日志能看出「这是查不到, 走兼容模式」
//
// 为什么要单独一个模式 (而不是直接返回 null):
//   直接 null ⇒ 调用方分不清「查不到」和「查错」, 也没法告诉用户
//   「这个模型的能力你在模型条目里写一下就行」。
function customCompatibilityCaps(model) {
  const m = model && typeof model === 'object' ? model : {};
  const tri = (v) => (v === true ? true : v === false ? false : undefined);
  const ctx = Number(m.context_length);
  return {
    vision: tri(m.vision),
    reasoning: tri(m.reasoning),
    tool: tri(m.tool),
    ctx: Number.isFinite(ctx) && ctx > 0 ? Math.floor(ctx) : null,
  };
}

// 查能力 —— 一次给全「命中没有 / 从哪来的 / 为什么」。
function resolveCapabilities(model) {
  const empty = { vision: undefined, reasoning: undefined, tool: undefined, ctx: null };
  if (!model || typeof model !== 'object') {
    return {
      status: 'unknown', source: 'none', authoritative: false, provider: null, key: null,
      capabilities: empty, reason: '没有模型条目',
    };
  }
  const rp = resolveProvider(model);
  const declared = customCompatibilityCaps(model);
  if (!rp.provider) {
    return {
      status: 'custom', source: 'model-declared', authoritative: false, provider: null, key: null,
      capabilities: declared,
      reason: '认不出厂商 (端点/模型名都没命中已知规则) ⇒ 自定义兼容模式: 用模型条目自己声明的能力',
    };
  }
  // 主命名空间 + 备用命名空间 (例: provider=alibaba ⇒ qwen 为主, alibaba 为备)
  const namespaces = [rp.provider].concat(rp.altNamespaces || []);
  let detail = null;
  let usedNs = null;
  let ambiguous = null;
  for (const ns of namespaces) {
    const d = lookupCapabilitiesDetail(ns, model.id);
    if (d.status === 'hit') { detail = d; usedNs = ns; break; }
    if (d.status === 'ambiguous' && !ambiguous) ambiguous = d;
  }
  if (detail) {
    const hit = detail.hit;
    let why = '能力库命中 ' + hit.key + ' (' + hit.match + ')';
    if (usedNs && usedNs !== rp.provider) why += ' —— 走的是备用命名空间 ' + usedNs;
    if (hit.namespace && _norm(hit.namespace) !== _norm(rp.provider)) {
      why += ' —— 跨厂商按模型名命中 (库里属于 ' + hit.namespace
        + ', 你写的是 ' + (rp.rawProvider || rp.provider) + ')';
    }
    return {
      status: 'hit', source: 'models-dev', authoritative: true, provider: rp.provider, key: hit.key,
      capabilities: { vision: hit.vision, reasoning: hit.reasoning, tool: hit.tool, ctx: hit.ctx },
      reason: why,
    };
  }
  if (ambiguous) {
    return {
      status: 'custom', source: 'model-declared', authoritative: false, provider: rp.provider, key: null,
      capabilities: declared,
      reason: '能力库里有多家同名模型, 判定不了是哪一个 ⇒ 不猜; 自定义兼容模式 (候选: '
        + (ambiguous.candidates || []).join(', ') + ')',
    };
  }
  return {
    status: 'custom', source: 'model-declared', authoritative: false, provider: rp.provider, key: null,
    capabilities: declared,
    reason: '能力库里没有 ' + rp.provider + '/' + (model.id || '?') + ' ⇒ 自定义兼容模式: 用模型条目自己声明的能力',
  };
}

// 给定一个 model 对象 (config.llm.models[i]), 自动查 provider + capabilities, 返回 hit 或 null
// hit 格式: { provider, key, vision, reasoning, tool, ctx }
function lookupModelCapabilities(model) {
  if (!model) return null;
  const rp = resolveProvider(model);
  if (!rp.provider) return null;
  const namespaces = [rp.provider].concat(rp.altNamespaces || []);
  for (const ns of namespaces) {
    const hit = lookupCapabilities(ns, model.id);
    if (hit) return { provider: rp.provider, ...hit };
  }
  // ⚠️ 歧义命中 (多家同名) **不返回** —— 返回就是「查错」。
  return null;
}

// 清除内存缓存 (sync 成功后调, 让下次查走新数据)
function invalidateCache() { _cachedFlat = null; _cachedIndex = null; }

module.exports = {
  syncModelsDev,
  syncModelsDevBackground,
  lookupCapabilities,
  lookupCapabilitiesDetail,
  lookupModelCapabilities,
  resolveProvider,
  resolveCapabilities,
  customCompatibilityCaps,
  guessProvider,
  init,
  setProviderGuessRules,
  DEFAULT_PROVIDER_GUESS_RULES,
  GENERIC_PROVIDERS,
  invalidateCache,
  getSyncMeta,
  CACHE_DIR,
  CACHE_FILE,
  META_FILE,
};
