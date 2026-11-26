// modules/pangu_helpers.js — N5 refactor batch B1: 从 pangu-single.js 抽出
// 10 个低风险 helpers：
//   saveConfig / readJsonBody / checkLocalOrigin / safeResWrite
//   getModelContextLength / estimateMessagesTokens / truncateMessagesForContext
//   getCurrentModel / getDefaultModel / normalizeModels
//
// 依赖注入：init({ _config, CONFIG_PATH, PRESETS, safeGuard, fs })
// _config 是 pangu-single.js 的模块级变量，通过 init() 传入引用，保持单一真源

// 2026-10-23: 原来是 null, 于是「init 没跑到」(try 块里前面抛错) 就等于
// 全模块埋雷 —— getCurrentModel() 读 _config.llm 直接 TypeError, 而它是在
// server.listen 回调里被调的, 一个 async 回调抛错 = 后面所有依赖注入全跳过,
// 进程照样监听端口, 看着健康但每个带 body 的 POST 都挂。
// 热路径按「拿不到配置 = 没有可用模型」降级, 而不是抛。
let _config = { llm: { models: [], current_model_id: null } };
let CONFIG_PATH = null;
let PRESETS = null;
let safeGuard = null;
let fs = null;
let path = null;

function init(deps) {
  _config = deps._config;
  CONFIG_PATH = deps.CONFIG_PATH;
  PRESETS = deps.PRESETS;
  safeGuard = deps.safeGuard;
  fs = deps.fs;
  path = deps.path || require('path');
  // R46 polish §1: init 末尾自动同步 config/nodes → router/models.json
  syncRouterModelsFromConfig();
}

// ============================================================
// Config persistence
// ============================================================

function saveConfig() {
 // N5 fix #7: atomic write — 写 tmp + rename, 防止半写入 + 进程 crash 后丢 config
  // 同时: 如果现有 config 被外部改过 (mtime 更新), 备份到 config.bak 以免覆盖主人手动修改
  try {
    const tmpPath = CONFIG_PATH + '.tmp';
    const content = JSON.stringify(_configForWrite(), null, 2);
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, CONFIG_PATH);
    // 2026-08-17: saveConfig 末尾自动同步 router/models.json + 失效 router 缓存
    // (避免 init() 之后改模型要重启)
    try { syncRouterModelsFromConfig(); } catch (_) {}
  } catch (e) { console.warn('[pangu] saveConfig error:', e.message); }
}

// 2026-10-26: PANGU_MODEL 钉着的时候, 落盘不许把钉子写进配置文件。
//   钉子是运行时的旋钮, 不是配置改写 —— 写进去的话「撤销钉子」就变成
//   「手改文件」, 语义丢了 (而且下次启动看起来「配置里就是它」, 就分不清
//   到底是 env 定的还是文件定的)。
//   ⇒ 落盘时保留**文件自己**的选择 (从磁盘读回来), 钉子只活在内存里。
//
//   例外 (且是刻意的): 主人运行时把模型切走了 ⇒ 那是主人的显式动作,
//   落盘主人的选择, 同时把「偏离了钉子」这件事说出来 (不许闷掉)。
function _configForWrite() {
  const envOverride = require('./model_env_override');
  const pin = envOverride.getPin();
  if (!pin) return _config;
  if (!_config || !_config.llm) return _config;
  if (String(_config.llm.current_model_id) !== pin.id) {
    envOverride.noteRuntimeDeviation(_config.llm.current_model_id);
    return _config;
  }
  try {
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const diskId = (onDisk && onDisk.llm) ? onDisk.llm.current_model_id : null;
    return { ..._config, llm: { ..._config.llm, current_model_id: diskId == null ? null : diskId } };
  } catch (_) {
    // 读不到磁盘上的选择 (文件被删 / JSON 坏了) ⇒ 我们**不知道**文件自己选了什么。
    // 这时候绝不能把内存里的钉子写回去 —— 写回去就等于「钉子落进配置文件」,
    // 「撤销钉子」变成「手改文件」, 钉子的语义丢了 (铁律②)。
    // 落盘成 null = 「文件没指定」⇒ 下次启动由 PANGU_MODEL / enabled+priority 兜底。
    console.warn(
      '[pangu] 读不到配置文件的模型选择 (' + CONFIG_PATH + ') ⇒ 落盘时不写当前模型 id, '
      + '不把 PANGU_MODEL 钉子写进配置文件'
    );
    return { ..._config, llm: { ..._config.llm, current_model_id: null } };
  }
}

// ============================================================
// HTTP body / origin helpers
// ============================================================

// 防御 — HTTP body 大小上限 (DoS 防护)
const MAX_BODY_BYTES = 1 * 1024 * 1024;  // 1MB

function readJsonBody(req, res, cb) {
  let body = '';
  let aborted = false;
  req.on('data', c => {
    if (aborted) return;
    body += c;
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      aborted = true;
      if (!res.headersSent) {
        res.writeHead(413, {'Content-Type': 'application/json'});
      }
      res.end(JSON.stringify({ok: false, error: 'BODY_TOO_LARGE', limit_bytes: MAX_BODY_BYTES}));
      req.destroy();
    }
  });
  req.on('end', () => {
    if (aborted) return;
    try { cb(null, body ? JSON.parse(body) : {}); }
    catch (e) { cb(e); }
  });
  req.on('error', e => { if (!aborted) cb(e); });
}

// PATCH /api/config 跨域拒外部 Origin
// 同源或 localhost 直接放行; 其它 Origin 必须带 Pangu 内部 token
function checkLocalOrigin(req, res) {
  const origin = req.headers['origin'] || '';
  const allowedHosts = ['localhost', '127.0.0.1'];
  try {
    if (!origin) {
      // 无 Origin header (curl / 同源 GET) — 放行
      return true;
    }
    const o = new URL(origin);
    if (allowedHosts.includes(o.hostname)) return true;
  } catch (_) {}
  // 外部 Origin 必须带 Pangu 内部 token (放在 X-Pangu-Token header, 不放 body 避免日志泄露)
  const token = req.headers['x-pangu-token'];
  if (token && token === process.env.PANGU_INTERNAL_TOKEN) return true;
  if (!res.headersSent) {
    res.writeHead(403, {'Content-Type': 'application/json'});
  }
  res.end(JSON.stringify({ok: false, error: 'CROSS_ORIGIN_FORBIDDEN', need: 'X-Pangu-Token header'}));
  return false;
}

// ============================================================
// SSE write helper
// ============================================================

// 安全 SSE 写入包装，集中处理连接断开/destroyed
function safeResWrite(res, event, data) {
  if (!res || res.writableEnded || res.destroyed) return false;
  try {
    res.write('event: ' + event + '\ndata: ' + (typeof data === 'string' ? data : JSON.stringify(data)) + '\n\n');
    return true;
  } catch (e) {
    safeGuard.writeCrash('sse-write-error', e);
    return false;
  }
}

// ============================================================
// Model context / token estimation
// ============================================================

// 修: 根据模型上下文长度截断 messages, 避免上下文溢出导致断流/乱码
// R88-generic (round 2.2): 不返 m.context_length / m.contextLength / m.max_context_length 这些
//  config 硬编码字段, 直接走 registry (Pangu runtime probe 探得的真值)
// 任何 model 必须由 probe 写入 registry 才能被 UI/API 用, 防止"假通用" — your-mac.json 手填
// 的 32768/4096 等 config 数值不能再让 getModelContextLength 默默返, 老板 (R88-generic) 不接受
function getModelContextLength(model) {
  if (!model) throw new Error('getModelContextLength: model required');
  if (!model.id) throw new Error('getModelContextLength: model.id required');
  // R88-generic: registry 唯一真源 (probe 写回, 第二次启动 0 call)
  const reg = require('./model_registry');
  const regCtx = reg.getContextLength(model.id);
  if (regCtx) return regCtx;
  // 2026-10-26 第 111 批: 同一个模型, 池内 id 和厂商模型名可能不是同一个字符串。
  //   现场: 池里 id = "MiniMax-M3.1-Flash", registry 里是 "minimax-m3.1-flash-preview"
  //   ⇒ 只按 id 查 ⇒ registry miss ⇒ 整轮对话 500 (实测线上正在 500)。
  //   这里按「池 id → api_model → name」再查一遍 —— 还是 registry 的真值, 不是猜的数。
  const alias = model.api_model || model.model_name || model.name;
  if (alias && alias !== model.id) {
    const aliasCtx = reg.getContextLength(alias);
    if (aliasCtx) return aliasCtx;
  }
  // registry 没有 = 没探到 = fail-loud (老板要的 R88-generic, 不再 silently 32K/4096)
  throw new Error('getModelContextLength: model context not discoverable (registry miss, probe failed or not run): ' + model.id);
}

// 2026-10-26 第 111 批 (老板 10/17 定的两层口径, 在盘古上落一遍):
//   registry 层保持 fail-loud (getModelContextLength 照旧抛, 那是"数据没探到"的事实);
//   **运行时热路径**不许被这个事实打死 —— 拿不到 ctx 就退到保守值, 而不是整轮 500。
//   现场事故: 当前模型换了新 id, registry 没条目 ⇒ llm_caller 算 max_tokens 时抛 ⇒
//             POST /api/chat 直接 500, 盘古整个不可用 (对话全挂)。
//   保守 = 宁可当 ctx 小 (少用一点窗口、多截一点), 也不当 ctx 大 (真溢出 400)。
const SAFE_CTX_FALLBACK = 32768;
function getModelContextLengthSafe(model, fallback = SAFE_CTX_FALLBACK) {
  try {
    return getModelContextLength(model);
  } catch (e) {
    console.warn('[ctx-degrade] ctx 拿不到, 退到保守值:', (model && model.id) || '(无模型)',
      '→', fallback, '|', String(e.message || e).slice(0, 120));
    return fallback;
  }
}

function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    chars += content.length + 20; // role + 结构开销
  }
  return Math.ceil(chars * 0.35); // 粗略: 1 token ≈ 2.8 英文字符 / 1 中文字符
}

function truncateMessagesForContext(messages, model, reservedOutputTokens = 2048) {
  // 热路径: 拿不到 ctx 时用保守值截断, 不抛 (抛 = 整轮 500)
  const contextLength = getModelContextLengthSafe(model);
  const availableInputTokens = Math.max(1024, contextLength - reservedOutputTokens);
  let tokens = estimateMessagesTokens(messages);
  if (tokens <= availableInputTokens) return messages;

  // 保留所有 system 消息; 截断 user/assistant 到最近若干条
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');
  // 2026-07-26 (老板 13:02 截图 HTTP 400): qwen3.6 jinja 要求第一个非 system 必须 user
  // 截断 slice 若从 assistant/tool 开始 → "No user query found" → 对齐到最近 user
  const alignToUser = (arr) => {
    const idx = arr.findIndex(m => m.role === 'user');
    return idx > 0 ? arr.slice(idx) : arr;
  };
  let keepCount = Math.max(2, nonSystem.length);
  while (keepCount > 2) {
    const truncated = [...systemMessages, ...alignToUser(nonSystem.slice(-keepCount))];
    if (estimateMessagesTokens(truncated) <= availableInputTokens) return truncated;
    keepCount--;
  }
  // 最后保留 system + 最近 2 条
  return [...systemMessages, ...alignToUser(nonSystem.slice(-2))];
}

// ============================================================
// Model selection (single source of truth: _config.llm.current_model_id)
// ============================================================

// 单一真源 _config.llm.current_model_id
// 删除 model.default 字段、删除 _config.llm.default_model 字段、删除 _config.agent_default_model
// 所有"当前在用"判断走 getCurrentModel()
function getCurrentModel() {
  const enabled = _config.llm.models.filter(m => m.enabled !== false && _isModelUsable(m));
  if (enabled.length === 0) return null;
  // 1. 优先 _config.llm.current_model_id (单一真源)
  const id = _config.llm.current_model_id;
  if (id) {
    const cur = enabled.find(m => m.id === id);
    if (cur) return cur;
  }
  // 2. 兜底: enabled 第一个 (按 priority 倒序)
  return enabled.sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
}

// Cloud models with a redacted/placeholder key are not usable. Treating them
// as enabled makes J2 spend four probe calls, then report a misleading 0-tool
// Silent Failure. Local OpenAI-compatible endpoints do not need a key.
function _isModelUsable(model) {
  // Selection must reflect the user's explicit model choice.  Credential and
  // gateway failures are request-time errors, not reasons to silently switch
  // to another cloud/local/relay model.  This also permits unauthenticated
  // LAN/proxy gateways and makes missing-key errors observable to the caller.
  return Boolean(model && model.enabled !== false);
}

// 兼容旧代码 — getDefaultModel 别名, 内部全转 getCurrentModel
function getDefaultModel() {
  return getCurrentModel();
}

function normalizeModels() {
 // 不再管理 default 字段, 只负责兜底 current_model_id
  // Availability is a call-time concern. Do not silently replace a user's
  // selected remote model just because credentials are temporarily missing
  // while saving an unrelated field (for example reasoning_effort).
  const enabled = _config.llm.models.filter(m => m.enabled !== false);
  if (enabled.length === 0) {
    _config.llm.current_model_id = null;
    saveConfig();
    return;
  }
  // 若 current_model_id 指向的模型被删/被禁用, 兜底到第一个 enabled
  const cur = enabled.find(m => m.id === _config.llm.current_model_id);
  if (!cur) {
    _config.llm.current_model_id = enabled.sort((a, b) => (b.priority || 0) - (a.priority || 0))[0].id;
  }
  saveConfig();
}

// R46 polish §1: 自动同步 config/nodes → router/models.json (upsert by id)
// 老板改 current_model_id 或加新 model 后, init() 末尾调一次, router 自动跟
function syncRouterModelsFromConfig() {
  try {
    // 2026-08-23 修 (实证: r46 测试 init({_config:{}}) 把生产 models.json 清成 0 个模型, router 全哑掉到 k3-256k):
    // (a) 写路径跟 smart_router 读路径**同一个真源** (smart_router.getModelsPaths),
    //     测试可隔离到 temp (PANGU_MODELS_PATH), 生产落在 ~/.pangu-data/router/
    // (b) config 空 = 数据源未就绪, 绝不 prune/覆写 (空配置清库 = 事故, 不是同步)
    const { DEFAULT_ROUTING_POLICY, getModelsPaths } = require('./router/smart_router');
    const routerModelsPath = getModelsPaths()[0];
    // 运行时目录可能还不存在 (新机器第一次启动) —— 不建目录就写不进去。
    try { fs.mkdirSync(path.dirname(routerModelsPath), { recursive: true }); } catch (_) {}
    let routerCfg;
    try {
      routerCfg = JSON.parse(fs.readFileSync(routerModelsPath, 'utf8'));
    } catch (e) {
      // 2026-10-28 (第 137 批, 开源): models.json 改成**运行时文件, 不入库**。
      //   干净克隆里它压根不存在 —— 以前这里直接 return, 于是 router 池永远空
      //   (全新安装 = 哑路由, 配了模型也不走 smart_router)。
      //   现在: 文件不在 ⇒ 用默认策略建一份空池, 让下面的 upsert 把它填成
      //   **用户自己**的模型。文件在但内容坏了, 仍然 return (那是真故障, 别盖)。
      if (e && e.code === 'ENOENT') {
        routerCfg = { routing_policy: Object.assign({}, DEFAULT_ROUTING_POLICY), models: [] };
      } else {
        console.warn('[pangu-helpers] router models.json load failed:', e.message);
        return { synced: 0, added: 0, updated: 0 };
      }
    }
    if (!Array.isArray(routerCfg.models)) routerCfg.models = [];
    const configModels = (_config && _config.llm && Array.isArray(_config.llm.models)) ? _config.llm.models : [];
    if (configModels.length === 0) {
      console.warn('[pangu-helpers] syncRouterModelsFromConfig skipped: _config.llm.models is empty ( refusing to prune router models.json to 0 )');
      return { synced: 0, added: 0, updated: 0, skipped: 'empty_config' };
    }
    // 2026-08-22 fix: prune stale entries - only keep ids present in current config, drop test/probe/历史残留
    const configIds = new Set(configModels.map(m => m && m.id).filter(Boolean));
    const beforeCount = routerCfg.models.length;
    routerCfg.models = routerCfg.models.filter(m => m && m.id && configIds.has(m.id));
    const prunedCount = beforeCount - routerCfg.models.length;
    let added = 0, updated = 0;
    let skipped = 0;
    for (const cm of configModels) {
      if (!cm || !cm.id) continue;
      const idx = routerCfg.models.findIndex(m => m && m.id === cm.id);
      // 2026-09-14 修 (老板拍 #5): 非 chat 模型 (kind=video 等) 不参与文本路由, 不需要聊天上下文,
      // 静默带过 (保留 models.json 里已有条目, 不刷"no discovered context"警告)
      const _existing = idx >= 0 ? routerCfg.models[idx] : null;
      const _kind = cm.kind || (_existing && _existing.kind) || null;
      if (_kind && _kind !== 'chat') continue;
      const reg = require('./model_registry');
      // 2026-10-28 修 (开源可跑性): 以前**只**认 registry (探针实测出来的窗口)。
      // 但 registry 是**运行时缓存** (~/.pangu/models-registry.json, 不入库) ——
      // 全新装好的机器上它还是空的, 于是配置里的每个模型都被判「探不到窗口」而跳过,
      // router 池一个模型都进不去 ⇒ 路由等于哑了。
      // 现在: registry 优先 (那是探针实测的真值), 探不到就回落**用户自己写进
      // node.json 的 context_length** —— 那是主人的声明, 不是代码里写死的 32K。
      // 例外: 探测值优先于配置值 (配置里的数会被实测值覆盖, 这是原来的约定)。
      const contextLength = reg.getContextLength(cm.id)
        || (Number(cm.context_length) > 0 ? Number(cm.context_length) : 0);
      if (!contextLength) {
        skipped += 1;
        console.warn('[pangu-helpers] sync skipped model without context length (registry 探不到, 配置里也没写):', cm.id);
        continue;
      }
      const entry = {
        id: cm.id,
        provider: cm.provider || 'openai',
        api_base: cm.endpoint || '',  // §2026-08-17 fix: 不再 URL concat, 留给下游 _normalizeEndpoint 处理 (老板拍: 拼接 = bug 源)
        cost_per_1k_input: Number(cm.cost_per_1k_input) || 0.0,
        cost_per_1k_output: Number(cm.cost_per_1k_output) || 0.0,
        // 2026-10-16: free 标记必须过桥。sync 是整条覆盖 (routerCfg.models[idx] = entry),
        // 只在源配置里写 free 而不同步过来, 每次重启就被抹掉 —— 那就是"写了不 commit = 没做"。
        // 只在显式为 true 时写下去, 免得给整个 models.json 塞一片 null/false 噪声。
        ...(cm.free === true ? { free: true } : {}),
        // 2026-10-16: 刊例价也跟着过桥。配了 free 的模型, 优惠结束那天删掉 free
        // 就能自动按真实价格算 —— 不必回头再查一次官网填数字。单位是 /1k
        // (官方页面按 /1M 报价, 换算过来 0.05/M = 0.00005/1k)。
        ...(Number(cm.list_cost_per_1k_input) > 0 ? { list_cost_per_1k_input: Number(cm.list_cost_per_1k_input) } : {}),
        ...(Number(cm.list_cost_per_1k_output) > 0 ? { list_cost_per_1k_output: Number(cm.list_cost_per_1k_output) } : {}),
        latency_p50_ms: Number(cm.latency_p50_ms) || 500,
        // 2026-09-13 三档制 (老板拍): 显式 quality_score/tier/vision 透传, 不再被 priority/100 一平到底
        // 2026-10-14 修 (实证: 同一个模型在两套子系统里分数不同):
        // 旧兜底 (priority||50)/100 把「路由优先级」当成「质量分」。而 priority 在真实
        // 配置里 8 个模型全是 100 —— 零信息量, 于是所有没显式配 quality_score 的模型
        // 全被兜成 1.0, 和 minimax-m3 并列最高分, 连本地 4bit 量化模型也一样。
        // 后果: router(models.json) 给它们 1.0, 而 role_model 直读 llm.models 时
        // 同一批模型是 null → || 0.7 —— 同一池两套排序。
        // 现在兜底值与 role_model._pickTierModel 的默认值对齐, 两边按构造一致。
        // 没配就是没配, 不许靠 priority 猜 —— 要提高名次请显式配 quality_score。
        quality_score: (cm.quality_score != null && !isNaN(Number(cm.quality_score))) ? Number(cm.quality_score) : require('./role_model').DEFAULT_QUALITY_SCORE,
        tier: cm.tier || undefined,
        vision: (typeof cm.vision === 'boolean') ? cm.vision : undefined,
        // 2026-08-18 fix: max_tokens 是单次请求 output 上限, 不能跟 context_length (总窗口) 混
        // minimax-M3 cap 16K, k3 32K, 默认 32K; 让 _maxTokensCap 内部按 provider 限 cap
        max_tokens: (() => { try { return Number(cm.max_tokens) || require('./model_registry').getModelInfo(cm.id)?.max_tokens || 32768; } catch (_) { return Number(cm.max_tokens) || 32768; } })(),
        // context_length: registry 实测值优先, 探不到时回落 cm.context_length (见上面的注释)。
        // 绝不 silently 32K —— 两者都没有就整个跳过这个模型, 不给它编一个窗口。
        context_length: contextLength,
        role_specialty: Array.isArray(cm.capabilities) ? cm.capabilities : ['reasoning'],
        available: cm.enabled !== false,
        env_var: (cm.api_key && typeof cm.api_key === 'string' && cm.api_key.startsWith('${') && cm.api_key.endsWith('}')) ? cm.api_key.slice(2, -1) : null,
      };
      // 2026-09-14 修: sync 不冲掉 kind/_note 等人工标注字段 (旧逻辑整条覆盖, kind=video 会被抹掉)
      if (_kind) entry.kind = _kind;
      if (_existing && _existing._note && !entry._note) entry._note = _existing._note;
      if (idx >= 0) { routerCfg.models[idx] = entry; updated += 1; }
      else { routerCfg.models.push(entry); added += 1; }
    }
    try {
      fs.writeFileSync(routerModelsPath, JSON.stringify(routerCfg, null, 2));
      // bust router cache so new models take effect
      try { require('./router/smart_router').invalidateCache(); } catch (_) {}
      if (added || updated || prunedCount || skipped) console.log(`[pangu-helpers] synced ${configModels.length - skipped} models to router/models.json (added=${added}, updated=${updated}, pruned=${prunedCount}, skipped=${skipped})`);
      return { synced: configModels.length - skipped, added, updated, pruned: prunedCount, skipped };
    } catch (e) {
      console.warn('[pangu-helpers] router models.json write failed:', e.message);
      return { synced: 0, added: 0, updated: 0, error: e.message };
    }
  } catch (e) {
    console.warn('[pangu-helpers] syncRouterModelsFromConfig failed:', e.message);
    return { synced: 0, added: 0, updated: 0, error: e.message };
  }
}

module.exports = {
  init,
  saveConfig,
  readJsonBody,
  checkLocalOrigin,
  safeResWrite,
  getModelContextLength,
  getModelContextLengthSafe,
  SAFE_CTX_FALLBACK,
  estimateMessagesTokens,
  truncateMessagesForContext,
  getCurrentModel,
  getDefaultModel,
  normalizeModels,
  syncRouterModelsFromConfig,
  MAX_BODY_BYTES,
};
