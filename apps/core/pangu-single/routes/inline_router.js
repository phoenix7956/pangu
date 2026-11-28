// pangu-single/routes/inline_router.js — N5 refactor batch B4-Phase 1
// 集中所有 inline HTTP route handlers (从 pangu-single.js 抽出)
// 设计: 单一函数 _router(req, res) 处理所有 inline 端点
// 依赖注入: init({ _config, _recordSessionToMemory, _agents, _skillRuntime, _callLLMForAgent, _callLLMForAgentStream, _j2ExecuteToolCalls, _j2AppendToolResults, _detectToolCallSupport, j2AgentLoop, j2Dispatcher, callLLM, extractContent, getCurrentModel, getDefaultModel, normalizeModels, saveConfig, readJsonBody, checkLocalOrigin, safeResWrite, _toolCallSupportCache, _buildSystemMessages, _loadLongTermMemory, _loadToolSummary, _loadEvolutionStats, _PROVIDER_CRED_KEYS, MAX_BODY_BYTES, _resolveApiKey, _resolveTemperature, _hasUnclosedToolBlock, callLLMRouter, j2Helpers, panguHelpers })


// Module-level requires for closure access
const fs = require('fs');
const path = require('path');
const os = require('os');
function _resolveVoiceFfmpeg() {
  const { execFileSync } = require('child_process');
  // ~/.local/bin/ffmpeg is a local ffprobe compatibility shim on this Mac.
  // It exits successfully for `-version`, but cannot decode or encode audio.
  // Prefer real system ffmpeg and validate the banner before returning it.
  const candidates = [process.env.PANGU_FFMPEG, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', path.join(os.homedir(), '.local', 'bin', 'ffmpeg')].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const banner = execFileSync(candidate, ['-version'], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (/\bffmpeg version\b/i.test(String(banner))) return candidate;
    } catch (_) {}
  }
  return '';
}
function _resolveWhisperPython() {
  const { execFileSync } = require('child_process');
  const candidates = [process.env.PANGU_PYTHON, '/usr/bin/python3', path.join(os.homedir(), '.local', 'bin', 'python3'), '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      execFileSync(candidate, ['-c', 'import whisper'], { timeout: 15000, stdio: 'ignore' });
      return candidate;
    } catch (_) {}
  }
  return '';
}
const voiceAudioFiles = new Map();
const panguHelpers = require('../../modules/pangu_helpers');
const j2Helpers = require('../../modules/j2_helpers');
const j2AgentLoop = require('../../modules/j2_agent_loop');
const j2Dispatcher = require('../../modules/j2_dispatcher');
const llmCaller = require('../../modules/llm_caller');
const smartRouter = require('../../modules/router/smart_router');
// 2026-10-26 第 100 批: 账本目录走唯一真源 (modules/evolution_paths.js)
const { evolutionDir } = require('../../modules/evolution_paths');
// 2026-08-22: LM Studio model.yaml 真源 (vision/reasoning/tool/arch/ctx/params) — 读 ~/.lmstudio/hub/models/<owner>/<name>/model.yaml
const { parseYaml } = require('../../modules/mini_yaml');
// 2026-08-22 §auto-sync: 启动自动同步云端模型能力库 (sst/models.dev OpenRouter 风格)
// 数据源: jsdelivr CDN + raw.githubusercontent.com, 失败用本地缓存 ~/.pangu/cache/models_dev.json
const llmCapSync = require('../../modules/llm_capabilities_sync');
const providerCatalog = require('../../modules/llm_provider_catalog');
const modelTransport = require('../../modules/model_transport');
// 2026-08-22: 国产模型规则库 (兜底, 主要靠 self-report)
// 不依赖网络, 离线内置, 加池时同步命中
const llmCapCn = require('../../modules/llm_capabilities_cn');
// 2026-08-22 §self-report: 模型能力自报 (老板拍: 模型能力都应该从模型拿才对)
// 让模型自己回答 vision/reasoning/tool/ctx — 模型永远最新, 不依赖规则库/外部 DB
const llmCapSelf = require('../../modules/llm_capabilities_selfreport');
const memoryHelpers = require('../../modules/memory_helpers');
const { guardAnswer } = require('../../modules/answer_alignment');
const workflowEngine = require('../../modules/workflow_engine');
const persistentGoal = require('../../modules/goal');
// TL-1 改造: 修 inline_router.js:183 死引用 (_handlePanguAgentStream 未 require)
const { _handlePanguAgentStream } = require('../../modules/pangu_agent_stream');
// 兼容端点 (/message /chat /api/chat) 的答复策略 + SSE 收集器 —— 第 106 批。
//   策略模块是**纯函数**: 「答复永不为空」这条不变量能被直接测、能逐条变异验证。
const { needsEscalation, decideChatAnswer, resolveChatSessionId, resolveOutputBudget } = require('../../modules/chat_answer_policy');
const { createSseCollector } = require('../../modules/sse_text_collector');

// 2026-08-22: LM Studio model.yaml 真源路径 (移到顶层避免 handler 函数体内的 TDZ)
const LMSTUDIO_HUB_PATHS = [
  path.join(os.homedir(), '.lmstudio', 'hub', 'models'),
  path.join(os.homedir(), 'Library', 'Application Support', 'LM Studio', 'hub', 'models'),
];

// 2026-08-22 §auto-sync: 启动时异步同步云端能力库 (失败用本地缓存, 不阻塞 boot)
// 老板拍: 出新模型盘古自动判, 不需要用户维护规则
// 数据源: jsdelivr CDN + raw.githubusercontent.com 4 个 fallback, 本地缓存 ~/.pangu/cache/models_dev.json
llmCapSync.syncModelsDevBackground(console.log);

// Re-export needed helpers as local consts for the inline handlers below
const _recordSessionToMemory = memoryHelpers._recordSessionToMemory;
const _mergeSessionsIntoMemory = memoryHelpers._mergeSessionsIntoMemory;
const _dateOffset = memoryHelpers._dateOffset;
const _incrementalReindex = memoryHelpers._incrementalReindex;
const _loadLongTermMemory = llmCaller._loadLongTermMemory;
const _loadToolSummary = llmCaller._loadToolSummary;
const _loadEvolutionStats = llmCaller._loadEvolutionStats;
const _buildSystemMessages = llmCaller._buildSystemMessages;
const _callLLMForAgent = llmCaller._callLLMForAgent;
const _callLLMForAgentStream = llmCaller._callLLMForAgentStream;
const _extractToolCallsFromText = j2Helpers._extractToolCallsFromText;
const _detectToolCallSupport = j2Helpers._detectToolCallSupport;
const _extractToolCallsAnthropic = llmCaller._extractToolCallsAnthropic;
const _extractToolCallsOpenAI = llmCaller._extractToolCallsOpenAI;
const _buildAssistantWithToolCallsAnthropic = llmCaller._buildAssistantWithToolCallsAnthropic;
const _buildAssistantWithToolCallsOpenAI = llmCaller._buildAssistantWithToolCallsOpenAI;
const _buildToolResultsAnthropic = llmCaller._buildToolResultsAnthropic;
const _buildToolResultsOpenAI = llmCaller._buildToolResultsOpenAI;
const _resolveApiKey = llmCaller._resolveApiKey;
const _resolveTemperature = llmCaller._resolveTemperature;
const _hasUnclosedToolBlock = j2Helpers._hasUnclosedToolBlock;
const _PROVIDER_CRED_KEYS = llmCaller._PROVIDER_CRED_KEYS;
const MAX_BODY_BYTES = panguHelpers.MAX_BODY_BYTES;
const getModelContextLength = panguHelpers.getModelContextLength;
const estimateMessagesTokens = panguHelpers.estimateMessagesTokens;
const truncateMessagesForContext = panguHelpers.truncateMessagesForContext;
const getCurrentModel = panguHelpers.getCurrentModel;
const getDefaultModel = panguHelpers.getDefaultModel;
const normalizeModels = panguHelpers.normalizeModels;
const saveConfig = panguHelpers.saveConfig;
const readJsonBody = panguHelpers.readJsonBody;
const checkLocalOrigin = panguHelpers.checkLocalOrigin;
const { validateOutboundUrl } = require('./route_security');

// Public configuration responses must never expose provider credentials.
// Keep the internal config untouched for model calls; only redact at the HTTP
// boundary used by the desktop settings UI.
function _redactApiKey(value) {
  if (typeof value !== 'string' || !value) return value || '';
  return '***';
}
function _publicModel(model) {
  if (!model || typeof model !== 'object') return model;
  const out = { ...model };
  if (Object.prototype.hasOwnProperty.call(out, 'api_key')) out.api_key = _redactApiKey(out.api_key);
  if (Object.prototype.hasOwnProperty.call(out, 'openai_api_key')) out.openai_api_key = _redactApiKey(out.openai_api_key);
  return out;
}
function _publicConfig(config) {
  if (!config || typeof config !== 'object') return config;
  const out = { ...config, llm: config.llm ? { ...config.llm } : config.llm, voice: config.voice ? { ...config.voice } : config.voice };
  if (out.llm) {
    if (Array.isArray(out.llm.models)) out.llm.models = out.llm.models.map(_publicModel);
    if (Object.prototype.hasOwnProperty.call(out.llm, 'openai_api_key')) out.llm.openai_api_key = _redactApiKey(out.llm.openai_api_key);
  }
  if (out.voice && Object.prototype.hasOwnProperty.call(out.voice, 'stt_api_key')) out.voice.stt_api_key = _redactApiKey(out.voice.stt_api_key);
  if (out.voice && Object.prototype.hasOwnProperty.call(out.voice, 'tts_api_key')) out.voice.tts_api_key = _redactApiKey(out.voice.tts_api_key);
  return out;
}

// 2026-10-16 (老板: "关键是盘古的模型配置项, 选本地连模型还是云端的"):
// 模型可达性探针。加模型时和"测试连接"共用**这一条链** ——
// 两处标准不一的代价很具体: 测试按钮说"通", 加进池里却调不通, 而 UI 只弹一句
// "✓ 已加", 用户拿不到任何信号, 只能等任务真路由到它时才炸, 而且报的是
// 一个跟根因无关的通用错误。
//
// 为什么不能只靠前端那个"测试连接"按钮: 它和添加是两个独立动作, 顺序由人决定,
// 没人会为了加模型先去点一次测试 —— 加完弹"已加"就走了。
async function _probeModelReachable(model, opts = {}) {
  const llmCaller = require('../../modules/llm_caller');
  const transport = require('../../modules/model_transport');
  const rawEndpoint = transport.endpointOf(model, '');
  if (!rawEndpoint) return { ok: false, reason: 'MISSING_ENDPOINT', hint: '模型没有 endpoint/base_url/api_base' };
  const protocol = transport.protocolOf(model);
  const endpoint = llmCaller._normalizeEndpoint(rawEndpoint, protocol);
  // 2026-10-26 (第 110 批): 取 key **只走统一解析链** (modules/api_key_resolver)。
  //   原来这里自己抄了半条链 (明文 + 环境变量), **跳过了凭证库** ——
  //   于是密钥搬进 ~/.pangu/credentials.json 之后, 探针会误判成「没鉴权」,
  //   而真实调用是通的 ⇒ 用户看到「连不上」但其实能连。
  //   半条链 = 第二套顺序 = 迟早漂移, 这正是第 99 批要消掉的那个病。
  const apiKey = _resolveApiKey(model) || '';
  const timeoutMs = Math.max(1000, Math.min(20000, Number(opts.timeoutMs) || 10000));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...transport.authHeaders(model, apiKey) },
      body: JSON.stringify({
        model: transport.canonicalModelName(model),
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    // 2026-10-16 (现场取证): LM Studio 只加载一个模型时, 会**忽略**我们发的模型名,
    // 直接拿它加载的那个来答, 还回 HTTP 200。于是"模型名填错"在探针里完全看不出来 ——
    // 老板那边表现就是"自己 server 上模型明明在, 盘古就是不对"。
    // 响应体里的 model 字段是 server 自己认下的那个, 拿它跟我们请求的对一下。
    let servedAs = null;
    try { servedAs = (JSON.parse(text) || {}).model || null; } catch (_) { /* 非 JSON 体, 对不了 */ }
    const asked = String(transport.canonicalModelName(model) || '').trim();
    const mismatch = !!(resp.ok && servedAs && asked && servedAs !== asked);
    return {
      ok: resp.ok,
      status: resp.status,
      endpoint,
      local: transport.isLocalEndpoint(rawEndpoint),
      data: text.slice(0, 300),
      // 200 但带 error 体是本地 server 的常态 (LM Studio 模型没加载就是 400/503 带说明)
      reason: resp.ok ? null : 'http-' + resp.status,
      asked_model: asked || null,
      served_as: servedAs,
      // 端点通 ≠ 调的就是你要的那个模型。这两件事必须分开报。
      model_mismatch: mismatch,
      model_mismatch_hint: mismatch
        ? '端点能连上, 但它回的是 ' + servedAs + ' 而不是你要的 ' + asked
          + ' (本地 server 只加载了别的模型 / 名字填错), 请求会成功但答非所问'
        : null,
    };
  } catch (e) {
    // Node 的 fetch 连不上时只抛一句 "fetch failed", 真因 (ECONNREFUSED / ENOTFOUND /
    // ETIMEDOUT / TLS 错) 藏在 e.cause.code 里。不挖出来的话用户只看到
    // "fetch failed", 完全不知道是端口没开还是域名写错。
    const _cause = (e && e.cause) || {};
    const _why = String(_cause.code || _cause.message || (e && e.message) || e || '');
    return {
      ok: false,
      endpoint,
      local: transport.isLocalEndpoint(rawEndpoint),
      reason: e && e.name === 'AbortError' ? 'timeout' : 'unreachable',
      error: _why,
      error_hint: {
        ECONNREFUSED: '端口没人监听 —— server 没启动, 或端口写错了',
        ENOTFOUND: '域名解析不了 —— 检查 host 拼写',
        ETIMEDOUT: '连接超时 —— 机器不在同一网络, 或被防火墙挡了',
        ECONNRESET: '对方中途断开了 —— server 可能崩了或扛不住这个请求',
        CERT_HAS_EXPIRED: '证书过期 —— https 端点的证书有问题',
        DEPTH_ZERO_SELF_SIGNED_CERT: '自签证书不被信任 —— 本地 https server 常见',
      }[_cause.code] || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// 加模型前的最小校验。返回字符串 = 拒绝原因; null = 通过。
// 存在的理由: 端点为空时 endpointOf() 会回落到全局 llm.openai_base_url,
// 于是"为 A 配的模型静默连到 B"。本地模型池一堆 (LM Studio / oMLX / mlx-serve)
// 端口各不相同, 这种静默串台正是老板报的"mlxserver 自己能用, 盘古调不了"。
function _validateModelForAdd(m) {
  if (!m || typeof m !== 'object') return 'INVALID_BODY';
  const id = String(m.id || '').trim();
  if (!id) return 'MISSING_ID: 模型必须有 id (盘古内部标识, 调用时用它匹配)';
  const endpoint = String(m.endpoint || m.api_base || m.base_url || '').trim();
  if (!endpoint) {
    return 'MISSING_ENDPOINT: 必须填端点 (本地 http://127.0.0.1:端口 或云端 https://…) —— '
      + '留空会让盘古回落到全局默认端点, 静默连到别的服务器';
  }
  let u;
  try { u = new URL(endpoint); } catch (_) {
    return 'INVALID_ENDPOINT: 不是合法 URL —— ' + endpoint;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return 'UNSUPPORTED_SCHEME: 端点只支持 http/https, 收到 ' + u.protocol;
  }
  const apiModel = String(m.api_model || m.model || m.name || '').trim();
  if (!apiModel) {
    return 'MISSING_API_MODEL: 必须填 api_model (发给上游的模型名) —— '
      + '本地 server 按这个名字选模型, 填错就会 "model not found"';
  }
  return null;
}

const safeResWrite = panguHelpers.safeResWrite;
const callLLM = llmCaller.callLLM;
const callLLMRouter = llmCaller.callLLMRouter;  // R45: Smart Router (fallback chain + cost_guard)
const extractContent = llmCaller.extractContent;
// 2026-10-27 (第 112 批): 正文 / 只回思考 / 上游说截断 —— 三个**事实**一次拿齐。
// extractContent 只回一个字符串, 分不出这三种失败 (历史上就长出了
// 「拿思考当答案」的补丁)。
const extractAnswer = llmCaller.extractAnswer;
const _loadToolsSchemaForLLM = llmCaller._loadToolsSchemaForLLM;
const _toolCallSupportCache = j2Helpers._getToolCallSupportCache();

/**
 * 2026-10-27 (第 112 批): 一次回答不合格时, 要不要**用满预算再试一次**。
 *
 * 两种不合格 (都是**事实**, 不是文本形态猜测):
 *   ① 只回思考 (正文空)   → 这轮等于没答
 *   ② 上游说截断了 (finish_reason='length') → 这是**半截**答案
 *
 * 现场 (2026-10-26): MiniMax-M3.1-Flash 的思考长度**跟着预算走** ——
 * 给 6500 它想满 6500, 给 16384 它想满 16384 (正文一个字都没有),
 * 给 32768 它想 25.3K 才肯落笔 (正文 3396 字, 九节全齐)。
 * ⇒ 重试的意义就是「把预算给够, 让它把话说完」。
 *
 * 重试结果**更好**才换 (有正文; 只是更长但仍截断也算更好)。
 * 还是不行 ⇒ 交回上层 (升级阶梯 / 兜底文案) —— 但**绝不许**把思考当答案。
 *
 * @returns {Promise<object|null>} 更好的答案对象, 没有就 null
 */
async function _retryWithFullBudget(p) {
  const o = p || {};
  const ans = o.ans;
  if (!ans || (!ans.reasoningOnly && !ans.truncated)) return null;
  const cap = Number(o.cap) || 0;
  const current = Number((o.model && o.model.max_tokens) || 0);
  if (!cap || cap <= current) return null;
  console.warn('[inline_router] /api/chat 正文空/被截断 (reasoningOnly=' + ans.reasoningOnly
    + ' truncated=' + ans.truncated + '), 用满预算 ' + cap + ' 重试一次');
  try {
    const retry = await o.callLLM(o.messages, { ...(o.model || {}), max_tokens: cap });
    const ans2 = o.extractAnswer(retry);
    const rawLen = String((o.raw) || '').length;
    // ⚠ 2026-10-31 (老板: 「为什么都会有预算?」): **usage 必须跟着最终答案走**。
    //   旧代码把 retry 的 usage 丢了 (只回 ans2) ⇒ 前端只能显示客户端请求的
    //   「预算 2048」, 而这一轮实际是按 32768 跑出来的 —— 假账。
    //   ⇒ 这里回 `{ans, usage}`, 由调用方取「产出最终答案那一次」的 usage。
    if (ans2.text && (!ans2.truncated || ans2.text.length > rawLen)) {
      return { ans: ans2, usage: _usageOf(retry), retried: true };
    }
  } catch (e) {
    console.warn('[inline_router] /api/chat 重试失败: ' + e.message);
  }
  return null;
}

/**
 * 2026-10-31: 把上游返回的 usage 归一成三个数 (prompt / completion / reasoning)。
 *
 * 为什么要有这个函数:
 *   ① 页面脚注原来印的是「预算 2048 token」—— 那是**客户端请求的意图值**,
 *      不是实耗。而服务端会用满预算静默重试 ⇒ 那个数经常是假的。
 *   ② 各家 usage 字段名不一样 (prompt_tokens / input_tokens / promptTokens),
 *      思考量藏在 completion_tokens_details.reasoning_tokens 里。
 *   ③ 前端要能说真话 ⇒ 服务端必须把「这次真花了多少」交出去。
 *
 * @returns {{prompt_tokens:number, completion_tokens:number, reasoning_tokens:number}|null}
 */
function _usageOf(result) {
  try {
    const u = (result && result.usage) || null;
    if (!u) return null;
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    };
    const prompt = num(u.prompt_tokens || u.input_tokens || u.promptTokens);
    const completion = num(u.completion_tokens || u.output_tokens || u.completionTokens);
    const details = u.completion_tokens_details || u.completionTokensDetails || null;
    const reasoning = num(
      (details && details.reasoning_tokens)
      || u.reasoning_tokens || u.reasoningTokens
    );
    if (!prompt && !completion && !reasoning) return null;
    return { prompt_tokens: prompt, completion_tokens: completion, reasoning_tokens: reasoning };
  } catch (_) {
    return null;
  }
}

// PRESETS 从 pangu-single.js 传入 (避免加载预设冲突)
let PRESETS = null;

const sseSlots = require('../../modules/sse_slots');
const { safeStatus } = require('../../modules/http_status');
const _tryAcquireSseSlot = sseSlots.tryAcquire;
const _releaseSseSlot = sseSlots.release;


// _config + agentRegistry + memory stuff 需要 init() 注入
let _config = null;
let _skillRuntime = null;
function json(res, payload, status) {
  try {
    res.writeHead(safeStatus(status, 200), {'Content-Type':'application/json'});
    res.end(JSON.stringify(payload));
  } catch (_) {}
}
function init(deps) {
  _config = deps._config;
  _skillRuntime = deps._skillRuntime;
  PRESETS = deps.PRESETS;
  _deps = deps;  // for _handlePanguDecide / _handlePanguDispatch
}

// 2026-10-26 第 111 批: 切认知模型的**唯一执行口**。
//   两条入口共用它: 用户显式切 (POST /api/llm/use) 和延迟感知路由自动切。
//   差别只在 manual 标记 —— 用户显式切 = 记"手动钉住", 自动切 = 不记。
function _performModelSwitch(id, opts = {}) {
  const m = _config.llm.models.find(x => x.id === id);
  if (!m) return { ok: false, error: 'NOT_FOUND' };
  if (m.enabled === false) return { ok: false, error: 'MODEL_DISABLED' };
  const prev = _config.llm.current_model_id;
  _config.llm.current_model_id = id;

  if (opts.manual) {
    // 用户显式切 ⇒ 记"手动钉住": 延迟感知路由不跟他抢 (除非这个模型连不上)。
    try {
      require('../../modules/model_routing').markManualPin(_config, id);
    } catch (e) { console.warn('[switch-model] 标记手动选择失败:', e.message); }
  }
  // 顺手补 ctx —— registry 没条目时热路径只能退到保守值,
  // 补上之后压缩阈值、max_tokens 都按真窗口算。
  try {
    require('../../modules/model_ctx_ensure').ensureCtx(m, {}).then(r => {
      if (r && r.ok) console.log('[ctx-ensure]', id, '→ ctx', r.ctx, '(' + r.source + ')');
      else console.warn('[ctx-ensure]', id, '没探到 ctx, 热路径退到保守值');
    }).catch(e => console.warn('[ctx-ensure]', id, '失败:', e.message));
  } catch (e) { console.warn('[switch-model] ctx 补齐失败:', e.message); }

  // 2026-08-23 修 (切模型要重启): 切换后清掉所有进程内 cache, 否则旧模型的失败记录 + tool_call 探测结果污染新模型
  const cacheInvalidated = {
    prev,
    next: id,
    tool_call_support: 0,
    recent_fails: 0,
    silent_fails: 0,
    l2_health: false,
    router_cache: false,
  };
  try { if (j2Helpers && j2Helpers.invalidateToolCallSupportCache) { j2Helpers.invalidateToolCallSupportCache(); cacheInvalidated.tool_call_support = Object.keys((j2Helpers._getToolCallSupportCache && j2Helpers._getToolCallSupportCache()) || {}).length; } } catch (e) { console.warn('[switch-model] tool_call cache clear failed:', e.message); }
  try { if (smartRouter && smartRouter.invalidateRecentFails) { smartRouter.invalidateRecentFails(); cacheInvalidated.recent_fails = 'cleared'; } } catch (e) { console.warn('[switch-model] recent_fails clear failed:', e.message); }
  try { if (smartRouter && smartRouter.invalidateSilentFails) { smartRouter.invalidateSilentFails(); cacheInvalidated.silent_fails = 'cleared'; } } catch (e) { console.warn('[switch-model] silent_fails clear failed:', e.message); }
  try { if (smartRouter && smartRouter.invalidateL2HealthCache) { smartRouter.invalidateL2HealthCache(); cacheInvalidated.l2_health = true; } } catch (e) { console.warn('[switch-model] l2_health clear failed:', e.message); }
  try { if (smartRouter && smartRouter.invalidateCache) { smartRouter.invalidateCache(); cacheInvalidated.router_cache = true; } } catch (e) { console.warn('[switch-model] router cache clear failed:', e.message); }
  console.log('[switch-model]', prev, '->', id, 'caches:', JSON.stringify(cacheInvalidated), opts.reason ? ('reason: ' + opts.reason) : '');
  saveConfig();
  return { ok: true, current_model_id: id, model: m, cache_invalidated: cacheInvalidated };
}

// 启动后的延迟感知路由 (后台跑, 不阻塞监听)。
// policy=auto 且当前模型太慢/连不上 ⇒ 换到更快的 (质量档优先)。
async function _applyAutoRouting(opts = {}) {
  try {
    const routing = require('../../modules/model_routing');
    const decision = await routing.applyRouting(_config, opts);
    if (decision && decision.action === 'switch' && decision.to !== decision.from) {
      const sw = _performModelSwitch(decision.to, { manual: false, reason: 'routing:' + decision.reason });
      return { decision, switched: sw };
    }
    return { decision, switched: null };
  } catch (e) {
    console.warn('[routing] 自动路由失败 (不影响主流程):', e.message);
    return { decision: null, switched: null, error: e.message };
  }
}



async function handler(req, res) {
  // CORS/OPTIONS/disconnect-guard 在 modules/http_server.js 已处理

  // 客户端断开保护(防止SSE stream socket堆积)
  let clientClosed = false;
  req.on('close', () => { clientClosed = true; });
  res.on('close', () => { clientClosed = true; });
  
  // 安全sseWrite: 客户端断了不写、未end才写、失败有日志
  const sseWrite = (event, data) => {
    if (clientClosed || res.writableEnded) return false;
    try { res.write('event: ' + event + '\ndata: ' + (typeof data === 'string' ? data : JSON.stringify(data)) + '\n\n'); return true; }
    catch (e) { console.error('[sse-write-fail]', e.message, 'event:', event); return false; }
  };
  
  const pathname = req.url.split('?')[0];

 // ==================== MCP 路由 + Sandbox 路由 ====================
  let sandboxResult = require('./sandbox').handler(req, res, pathname);
  if (sandboxResult && sandboxResult.then) sandboxResult = await sandboxResult;
  if (sandboxResult && sandboxResult.consumed) return;
  
  let mcpResult = require('./mcp').handler(req, res, pathname);
  if (mcpResult && mcpResult.then) mcpResult = await mcpResult;
  if (mcpResult && mcpResult.consumed) return;
  
  let agentResult = require('./agent').handler(req, res, pathname);
  if (agentResult && agentResult.then) agentResult = await agentResult;
  if (agentResult && agentResult.consumed) return;
  
  // 健康检查
  // §0.32 (2026-08-30): 手动压缩端点 — POST {session_id} 强制压缩 + reset budget
  // 用法: curl -X POST http://127.0.0.1:18901/api/pangu/admin/compact -H "Content-Type: application/json" -d '{"session_id":"desktop-XXX"}'
  // 也支持 header 方式: -H "X-Session-Id: desktop-XXX"
  if ((pathname === '/api/pangu/admin/compact' || pathname === '/admin/compact') && req.method === 'POST') {
    return readJsonBody(req, res, (err, _body) => {
      const _bodyObj = _body || {};
      const _sid = _bodyObj.session_id || req.headers['x-session-id'] || '';
      if (!_sid) return json(res, { ok: false, error: 'NO_SESSION_ID', hint: 'pass {session_id} in body or X-Session-Id header' }, 400);
      // 2026-10-15: forceCompactSession 改成了 async (当场压缩 + 落盘, 原来只排队)。
      // 之前这里直接 json(res, _r) —— 一旦它是 Promise, 会被序列化成 "{}",
      // 调用方看到的是"成功但什么字段都没有"。
      Promise.resolve()
        .then(() => j2AgentLoop.forceCompactSession(_sid))
        .then(_r => json(res, _r, _r && _r.ok ? 200 : 409))
        .catch(e => json(res, { ok: false, error: e.message, session_id: _sid }, 500));
      return;
    });
  }
  // §0.32 配套: 看当前手动压缩队列
  if (pathname === '/api/pangu/admin/compact-queue' && req.method === 'GET') {
    try {
      return json(res, { ok: true, queue: j2AgentLoop.listForceCompactQueue() }, 200);
    } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }

  // Diagnostics/state APIs used by the desktop control surfaces.
  //
  // 2026-10-14: harness 读出口。run_trace 落了一堆 jsonl 却没有接口能查, 等于
  // "只写不读" —— 老板问"刚才那轮为什么慢/是谁拦的/烧了多少 token",
  // 只能 ssh 上机翻文件。这里把三件事开成 API:
  //   /api/pangu/harness/runs            最近运行列表 (含耗时/token/守卫/截断计数)
  //   /api/pangu/harness/run?file=...    单次运行的事件明细
  //   /api/pangu/harness/guards?day=...  当日守卫账本 (谁拦的/按什么依据)
  if ((pathname === '/api/pangu/harness/runs' || pathname === '/api/pangu/harness/run'
    || pathname === '/api/pangu/harness/guards' || pathname === '/api/pangu/harness/root')
    && req.method === 'GET') {
    try {
      const rt = require('../../modules/run_trace');
      const q = new URL(req.url, 'http://localhost').searchParams;
      if (pathname === '/api/pangu/harness/guards') {
        const day = q.get('day') || '';
        // 只接受 YYYY-MM-DD, 防路径穿越
        const safeDay = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
        const rows = rt.readGuards(safeDay || undefined);
        return json(res, {
          ok: true, day: safeDay || new Date().toISOString().slice(0, 10), count: rows.length,
          blocked: rows.filter(r => r.action === 'block' || r.action === 'drop').length,
          guards: rows.slice(-Math.max(1, Math.min(Number(q.get('limit')) || 100, 500))),
        }, 200);
      }
      if (pathname === '/api/pangu/harness/run') {
        // file 只取 basename, 防 ../ 穿越
        const raw = String(q.get('file') || '');
        const file = raw.replace(/[^a-zA-Z0-9._-]/g, '');
        if (!file) return json(res, { ok: false, error: 'MISSING_FILE' }, 400);
        const evs = rt.readRun(file);
        if (!evs.length) return json(res, { ok: false, error: 'NOT_FOUND' }, 404);
        return json(res, { ok: true, file, count: evs.length, events: evs.slice(-Math.max(1, Math.min(Number(q.get('limit')) || 500, 5000))) }, 200);
      }
      if (pathname === '/api/pangu/harness/root') {
        const rootId = String(q.get('id') || '');
        if (!rootId) return json(res, { ok: false, error: 'MISSING_ID' }, 400);
        return json(res, { ok: true, ...rt.aggregateRoot(rootId) }, 200);
      }
      const runs = rt.listRuns({ limit: Math.max(1, Math.min(Number(q.get('limit')) || 50, 200)) });
      return json(res, { ok: true, count: runs.length, runs }, 200);
    } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }

  if (pathname === '/api/pangu/agent/outcome' && req.method === 'GET') {
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const sessionId = q.get('sessionId') || q.get('session_id') || '';
      const limit = Math.max(1, Math.min(Number(q.get('limit')) || 50, 200));
      const tracker = require('../../modules/outcome_tracker');
      return json(res, { ok: true, session_id: sessionId, outcomes: tracker.listOutcomes(sessionId, limit) }, 200);
    } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }
  if (pathname === '/api/pangu/agent/outcome/stats' && req.method === 'GET') {
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const tracker = require('../../modules/outcome_tracker');
      return json(res, { ok: true, stats: tracker.globalStats({ sinceTs: Number(q.get('sinceTs')) || 0, untilTs: Number(q.get('untilTs')) || Infinity }) }, 200);
    } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }
  // 断点续跑 checkpoint API — 与 j2_agent_loop/checkpoint.js 共用同一落盘真源。
  // sessionId 只允许与 session_store 相同的安全字符，避免路径/文件名混淆。
  const checkpointPathMatch = pathname === '/api/pangu/agent/checkpoint';
  const checkpointListPathMatch = pathname === '/api/pangu/agent/checkpoint/list';
  if ((checkpointPathMatch || checkpointListPathMatch) && (req.method === 'GET' || req.method === 'DELETE')) {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const sid = q.get('sessionId') || q.get('session_id') || '';
    if (!sid) return json(res, { ok: false, error: 'MISSING_SESSION_ID' }, 400);
    if (!/^[A-Za-z0-9_-]+$/.test(sid)) return json(res, { ok: false, error: 'INVALID_SESSION_ID' }, 400);
    if (req.method === 'DELETE') {
      if (!checkpointPathMatch) return json(res, { ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
      if (!checkLocalOrigin(req, res)) return;
      try {
        const checkpoint = require('../../modules/checkpoint');
        return json(res, { ...checkpoint.clearCheckpoints(sid), session_id: sid }, 200);
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    }
    try {
      const checkpoint = require('../../modules/checkpoint');
      if (checkpointListPathMatch) {
        const limit = Math.max(1, Math.min(Number(q.get('limit')) || 20, 100));
        return json(res, { ok: true, session_id: sid, checkpoints: checkpoint.listCheckpoints(sid, limit) }, 200);
      }
      const result = checkpoint.loadLatestCheckpoint(sid);
      if (!result) return json(res, { ok: false, error: 'NOT_FOUND', session_id: sid }, 404);
      return json(res, { ok: true, session_id: sid, checkpoint: result }, 200);
    } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }
  if (pathname === '/api/pangu/evolution/last' && req.method === 'GET') {
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const limit = Math.max(1, Math.min(Number(q.get('limit')) || 1, 50));
      const dir = evolutionDir();
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse() : [];
      const records = [];
      for (const file of files) {
        for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean).slice(-limit).reverse()) {
          try { records.push(JSON.parse(line)); } catch (_) {}
          if (records.length >= limit) break;
        }
        if (records.length >= limit) break;
      }
      return json(res, { ok: true, records, record: records[0] || null }, 200);
    } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }
  if (pathname === '/api/pangu/evolution/dry-run' && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return;
    return readJsonBody(req, res, async (err) => {
      if (err) return json(res, { ok: false, error: 'INVALID_JSON' }, 400);
      try {
        const report = await require('../../agents/self-evolution').dryRun();
        return json(res, report, report.ok ? 200 : 503);
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    });
  }
  if (pathname === '/api/pangu/evolution/auto-improve' && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return;
    return readJsonBody(req, res, async (err, body = {}) => {
      if (err) return json(res, { ok: false, error: 'INVALID_JSON' }, 400);
      try {
        const options = { sinceMs: Number(body.since_ms || body.sinceMs) || 7 * 86400 * 1000 };
        const report = await require('../../agents/self-evolution').autoImprove(options);
        return json(res, report, report.ok ? 200 : 500);
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    });
  }
  if (pathname === '/api/pangu/housekeeping/stats' && req.method === 'GET') {
    try { return json(res, { ok: true, stats: require('../../modules/housekeeping').stats() }, 200); }
    catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }
  if (pathname === '/api/pangu/housekeeping/run' && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return;
    return readJsonBody(req, res, async (err, body = {}) => {
      if (err) return json(res, { ok: false, error: err.message || 'BAD_BODY' }, 400);
      try { return json(res, await require('../../modules/housekeeping').runAll(body), 200); }
      catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    });
  }
  if (pathname === '/api/pangu/budget/global' && req.method === 'GET') {
    try { return json(res, { ok: true, stats: require('../../modules/budget').globalStats() }, 200); }
    catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }
  if (pathname === '/api/pangu/budget' && req.method === 'GET') {
    try {
      const sid = new URL(req.url, 'http://localhost').searchParams.get('sessionId') || 'default';
      return json(res, { ok: true, budget: require('../../modules/budget').snapshot(sid) }, 200);
    } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }
  if (pathname === '/api/pangu/budget' && req.method === 'DELETE') {
    if (!checkLocalOrigin(req, res)) return;
    const sid = new URL(req.url, 'http://localhost').searchParams.get('sessionId') || '';
    if (!sid) return json(res, { ok: false, error: 'MISSING_SESSION_ID' }, 400);
    try { require('../../modules/budget').clear(sid); return json(res, { ok: true, session_id: sid }, 200); }
    catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }
  if (pathname === '/api/pangu/tiers' && req.method === 'GET') {
    try { return json(res, { ok: true, tiers: require('../../modules/service_tiers').listTiers() }, 200); }
    catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }
  const tierMatch = pathname.match(/^\/api\/pangu\/tiers\/([^/]+)$/);
  if (tierMatch && req.method === 'GET') {
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const tiers = require('../../modules/service_tiers');
      const tier = tiers.getTierConfig(decodeURIComponent(tierMatch[1]), q.get('sessionId') || undefined);
      return json(res, { ok: true, tier }, 200);
    } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }
  if (pathname === '/health' || pathname === '/api/health' || pathname === '/api/pangu/health') {
    return require('./health').handler(req, res);
  }
  // 前端代码版本指纹 —— 前端靠它判断「我是不是在跑旧模块」(SPA module registry 的坑)
  if (pathname === '/api/pangu/webbuild' && req.method === 'GET') {
    return require('./webbuild').handler(req, res);
  }

  // 持久目标 API — CLI /goal 与桌面会话共用 goal.js 真源。
  if (pathname === '/api/pangu/goal/list' && req.method === 'GET') {
    return json(res, { ok: true, goals: persistentGoal.listGoals() }, 200);
  }
  if (pathname === '/api/pangu/goal' && req.method === 'GET') {
    const sid = new URL(req.url, 'http://localhost').searchParams.get('sessionId') || 'default';
    const goal = persistentGoal.getGoal(sid);
    return json(res, goal ? { ok: true, goal } : { ok: false, error: 'NOT_FOUND', session_id: sid }, goal ? 200 : 404);
  }
  if (pathname === '/api/pangu/goal' && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return;
    return readJsonBody(req, res, (err, body) => {
      if (err) return json(res, { ok: false, error: err.message || 'BAD_BODY' }, 400);
      const sid = body && (body.session_id || body.sessionId);
      const result = persistentGoal.setGoal(sid, body && body.text, { priority: body && body.priority });
      return json(res, result, result.ok ? 200 : 400);
    });
  }
  const goalActions = {
    '/api/pangu/goal/clear': (sid) => persistentGoal.clearGoal(sid),
    '/api/pangu/goal/pause': (sid, body) => persistentGoal.pauseGoal(sid, body && body.reason),
    '/api/pangu/goal/complete': (sid, body) => persistentGoal.completeGoal(sid, body && body.summary),
    '/api/pangu/goal/progress': (sid, body) => persistentGoal.addProgress(sid, body && body.note),
  };
  if (goalActions[pathname] && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return;
    return readJsonBody(req, res, (err, body) => {
      if (err) return json(res, { ok: false, error: err.message || 'BAD_BODY' }, 400);
      const sid = body && (body.session_id || body.sessionId);
      const result = goalActions[pathname](sid, body || {});
      return json(res, result, result.ok ? 200 : 404);
    });
  }

  // ==================== 持久长工作流 ====================
  // task_output 仅追踪本进程子任务；此处的 workflow_engine 是可重启恢复的真源。
  if ((pathname === '/api/pangu/workflows' || pathname === '/pangu/workflows') && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return;
    return readJsonBody(req, res, (err, body) => {
      if (err) return json(res, { ok: false, error: err.message || 'BAD_BODY' }, 400);
      const result = workflowEngine.createWorkflow(body || {});
      return json(res, result, result.ok ? 201 : 400);
    });
  }
  if ((pathname === '/api/pangu/workflows' || pathname === '/pangu/workflows') && req.method === 'GET') {
    try {
      const query = new URL(req.url, 'http://localhost').searchParams;
      const limit = Math.max(1, Math.min(Number(query.get('limit')) || 50, 200));
      return json(res, { ok: true, workflows: workflowEngine.listWorkflows(query.get('status') || undefined, limit) });
    } catch (error) { return json(res, { ok: false, error: error.message }, 500); }
  }

  const workflowPath = pathname.match(/^\/(?:api\/)?pangu\/workflows\/([^/]+)(?:\/(review|cancel|events))?$/);
  if (workflowPath) {
    const workflowId = decodeURIComponent(workflowPath[1]);
    const action = workflowPath[2] || '';
    if (!action && req.method === 'GET') {
      try {
        const workflow = workflowEngine.getWorkflow(workflowId);
        return json(res, workflow ? { ok: true, workflow } : { ok: false, error: 'WORKFLOW_NOT_FOUND' }, workflow ? 200 : 404);
      } catch (error) { return json(res, { ok: false, error: error.message }, 500); }
    }
    if (action === 'review' && req.method === 'POST') {
      if (!checkLocalOrigin(req, res)) return;
      return readJsonBody(req, res, (err, body) => {
        if (err) return json(res, { ok: false, error: err.message || 'BAD_BODY' }, 400);
        if (!body || typeof body.approved !== 'boolean') return json(res, { ok: false, error: 'approved boolean required' }, 400);
        const result = workflowEngine.approveReview(workflowId, body.approved, String(body.note || ''));
        return json(res, result, result.ok ? 200 : 409);
      });
    }
    if (action === 'cancel' && req.method === 'POST') {
      if (!checkLocalOrigin(req, res)) return;
      return readJsonBody(req, res, (err, body) => {
        if (err) return json(res, { ok: false, error: err.message || 'BAD_BODY' }, 400);
        const result = workflowEngine.cancelWorkflow(workflowId, String((body && body.note) || ''));
        return json(res, result, result.ok ? 200 : 409);
      });
    }
    if (action === 'events' && req.method === 'GET') {
      const workflow = workflowEngine.getWorkflow(workflowId);
      if (!workflow) return json(res, { ok: false, error: 'WORKFLOW_NOT_FOUND' }, 404);
      if (!_tryAcquireSseSlot(res)) return;
      const query = new URL(req.url, 'http://localhost').searchParams;
      const afterId = Math.max(0, Number(query.get('after')) || Number(req.headers['last-event-id']) || 0);
      let closed = false;
      let heartbeat = null;
      let bootstrapping = true;
      const pendingEvents = [];
      const writeEvent = (event) => {
        if (closed || res.writableEnded) return;
        try {
          if (event.id != null) res.write('id: ' + event.id + '\n');
          res.write('event: workflow_event\n');
          res.write('data: ' + JSON.stringify(event) + '\n\n');
        } catch (_) { cleanup(); }
      };
      const onWorkflowEvent = (event) => {
        if (bootstrapping) pendingEvents.push(event);
        else writeEvent(event);
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        workflowEngine.events.off('event:' + workflowId, onWorkflowEvent);
        _releaseSseSlot();
      };
      res.on('close', cleanup);
      res.on('error', cleanup);
      req.on('close', cleanup);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      workflowEngine.events.on('event:' + workflowId, onWorkflowEvent);
      const historicalEvents = workflowEngine.listEvents(workflowId, afterId);
      const historicalIds = new Set(historicalEvents.map(event => event.id));
      for (const event of historicalEvents) writeEvent(event);
      bootstrapping = false;
      for (const event of pendingEvents) {
        if (!historicalIds.has(event.id)) writeEvent(event);
      }
      heartbeat = setInterval(() => {
        if (!closed && !res.writableEnded) {
          try { res.write(': heartbeat\n\n'); } catch (_) { cleanup(); }
        }
      }, 25000);
      if (heartbeat.unref) heartbeat.unref();
      return;
    }
  }

  // ==================== 图片附件落盘 (2026-08-03 老板拍: 图内部保存) ====================
  // 架构对齐: 图落盘成文件, 消息只存路径, 发模型前才读成 base64
  // POST /api/attachments  {images: ["data:image/png;base64,..."]} → {ok, files:[{path,url,bytes}]}
  // GET  /api/attachments/<name> → 图片字节流 (UI <img src> 用, 经 vite proxy)
  const _ATTACH_DIR = require('path').join(require('os').homedir(), '.pangu-data', 'attachments');
  // vite proxy 会剥 /api 前缀 (非 mcp/pangu/credentials/llm 路径), 两种形态都要接
  if ((pathname === '/attachments' || pathname === '/api/attachments') && req.method === 'POST') {
    const fs = require('fs'), path = require('path'), crypto = require('crypto');
    const bodyChunks = []; let bodyLen = 0; let aborted = false;
    req.on('data', c => {
      if (aborted) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      bodyChunks.push(buf); bodyLen += buf.length;
      if (bodyLen > 30 * 1024 * 1024) { aborted = true; res.writeHead(413, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'BODY_TOO_LARGE'})); try { req.destroy(); } catch (_) {} }
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const body = Buffer.concat(bodyChunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(body || '{}'); }
        catch (_) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'INVALID_JSON'})); }
        const { images = [] } = parsed;
        if (!Array.isArray(images) || images.length === 0) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'NO_IMAGES'})); }
        fs.mkdirSync(_ATTACH_DIR, { recursive: true });
        const files = [];
        for (const img of images.slice(0, 9)) {
          const m = String(img).match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
          if (!m) continue;
          const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
          const buf = Buffer.from(m[2], 'base64');
          const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
          const fp = path.join(_ATTACH_DIR, name);
          fs.writeFileSync(fp, buf);
          files.push({ path: fp, url: `/api/attachments/${name}`, bytes: buf.length });
        }
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true, files }));
      } catch (e) { res.writeHead(500, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    });
    return;
  }
  const _attachGetMatch = pathname.match(/^\/(?:api\/)?attachments\/(.+)$/);
  if (_attachGetMatch && req.method === 'GET') {
    const fs = require('fs'), path = require('path');
    const name = decodeURIComponent(_attachGetMatch[1]);
    // 防路径穿越: 只允许纯文件名
    if (!/^[\w.\-]+$/.test(name)) { res.writeHead(403); return res.end('forbidden'); }
    const fp = path.join(_ATTACH_DIR, name);
    if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('not found'); }
    const ext = (name.split('.').pop() || 'png').toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=86400' });
    fs.createReadStream(fp).pipe(res);
    return;
  }
  // ==================== 节点列表 ====================
  if (pathname === '/nodes' || pathname === '/api/nodes') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ok: true, nodes: [{id: 'your-mac', role: 'primary', status: 'online'}]}));
  }

 // ==================== Pangu 自我进化数据 (P3 - 已移至 pangu-meta.js) ====================
  // 2026-07-28 fix: 原 inline_router.js 重复实现 /api/pangu/evolution (~60 行)；
  // inline_router.js 先 match → pangu-meta.js 同一 handler 永远 dead code。
  // 修复：删除本处实现，下方统一调 pangu-meta.js handler。
// ==================== Pangu evolution/tools/skills 元数据路由 ====================
  let metaResult = require('./pangu-meta').handler(req, res, pathname);
  if (metaResult && metaResult.then) metaResult = await metaResult;
  if (metaResult && metaResult.consumed) return;

  // MCP has its own complete route module (GET/POST/PATCH/DELETE/call),
  // but it was never mounted on the single-node server. Delegate before the
  // legacy inline DELETE fallback below so all methods share mcp_loader.
  if (pathname === '/api/mcp/servers' || pathname === '/api/mcp/tools' || pathname === '/api/mcp/call' || pathname === '/api/mcp/restart' || pathname.startsWith('/api/mcp/servers/')) {
    const mcpResult = await require('./mcp').handler(req, res, pathname);
    if (mcpResult && mcpResult.consumed) return;
  }

 // ==================== Pangu Agent 流式执行 ====================
  // 闭环: LLM → tool_use → sandbox check → execute tool → 回灌 → LLM → 最终答案 (SSE)
  if ((pathname === '/api/pangu/agent/stream' || pathname === '/api/pangu/agent') && req.method === 'POST') {
    return _handlePanguAgentStream(req, res);
  }

 // ==================== Pangu Decide (W4-B 重建 , 64卦编程判断 4 场景) ====================
  // §0.7 三层架构: 64卦推理 (deterministic) → LLM 解释 (看 64卦) → 不执行
  if (pathname === '/api/pangu/decide' && req.method === 'POST') {
    return _deps._handlePanguDecide(req, res);
  }
 // 老板反馈: GET /api/pangu/decide 返 404 不友好, 加 GET 返说明
  if (pathname === '/api/pangu/decide' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
    return res.end(JSON.stringify({
      ok: true,
      endpoint: '/api/pangu/decide',
      method_required: 'POST',
      usage: 'curl -X POST http://127.0.0.1:18901/api/pangu/decide -H "Content-Type: application/json" -d \'{"scenario":"risk_assessment","input":"你的问题"}\'',
      scenarios: ['arch', 'tech', 'risk_assessment', 'refactor']
    }));
  }

 // N5 fix #15: /api/pangu/decide-all — UI 批量决策场景 (串行多次 decide)
  if (pathname === '/api/pangu/decide-all' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let req_body;
      try { req_body = JSON.parse(body || '{}'); }
      catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
      try {
        const inputs = Array.isArray(req_body.inputs) ? req_body.inputs : [req_body.input || req_body];
        const scenario = req_body.scenario || 'risk_assessment';
        // M20: 真跑 decideOne (串行), 不再 stub 'queued'
        const results = [];
        for (const inp of inputs) {
          try {
            results.push(await _deps.decideOne(scenario, String(inp)));
          } catch (e) {
            results.push({ ok: false, input: String(inp).slice(0, 200), scenario, error: e.message });
          }
        }
        res.writeHead(200, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ok: true, count: results.length, results}));
      } catch (e) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ok: false, error: e.message}));
      }
    });
    return;
  }

 // ==================== Pangu Dispatcher (, 任务 → 8 角色路由) ====================
  // §0.7 Dispatcher: 接任务 → 关键词打分 → 路由到 8 agent 之一 → 返 target_role + tools
  if ((pathname === '/api/pangu/dispatch' || pathname === '/api/pangu/dispatcher') && req.method === 'POST') {
    return _deps._handlePanguDispatch(req, res);
  }
  if ((pathname === '/api/pangu/dispatch' || pathname === '/api/pangu/dispatcher') && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
    return res.end(JSON.stringify({
      ok: true,
      endpoint: '/api/pangu/dispatch',
      method_required: 'POST',
      usage: 'curl -X POST http://127.0.0.1:18901/api/pangu/dispatch -H "Content-Type: application/json" -d \'{"task":"你的任务描述"}\'',
      example: { task: '写一个 Python 脚本' }
    }));
  }

 // ==================== Pangu Self-Dogfood (, ) ====================
  // §0.7 + §0.13: 让 Pangu 查自己的 bug + 修 + 验证
  // 串联 7 个 agent: Bug Hunter → Reflector → Planner → Executor → Checker → Learner → Dispatcher
  if (pathname === '/api/pangu/dogfood' && req.method === 'POST') {
    return _handlePanguDogfood(req, res);
  }
  if (pathname === '/api/pangu/dogfood' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive'});
    // 2026-08-04 修 (Bug #1): info 事件 + data 行加 try/catch
    try {
      res.write('event: info\n');
      res.write('data: ' + JSON.stringify({
        ok: true,
        endpoint: '/api/pangu/dogfood',
        method_required: 'POST',
        description: 'Pangu self-dogfooding: 7 agent 协同查 bug + 修 + 验证',
        agents: ['xun', 'zhen', 'kan', 'kun', 'dui', 'gen', 'qian'],
        usage: 'curl -N -X POST http://127.0.0.1:18901/api/pangu/dogfood -H "Content-Type: application/json" -d \'{}\''
      }) + '\n\n');
    } catch (e) { /* 连接已关, 忽略 */ }
    return res.end();
  }

  // ==================== 爻阵 TeamFlow (2026-08-05 老板拍: 卦象嵌入工作) ====================
  // POST /api/teamflow/cast {goal, numbers?} → {ok, gua, gate}   起卦+可行性门
  // POST /api/teamflow/run  {goal, override?} (SSE)             动爻稀疏执行+败则改道+验卦
  // GET  /api/teamflow/yan                                     最近验卦记录
  if (pathname === '/api/teamflow/cast' && req.method === 'POST') {
    return require('../../modules/teamflow').handleCast(req, res);
  }
  if (pathname === '/api/teamflow/run' && req.method === 'POST') {
    return require('../../modules/teamflow').handleRun(req, res);
  }
  if (pathname === '/api/teamflow/yan' && req.method === 'GET') {
    return require('../../modules/teamflow').handleYanLog(req, res);
  }
  if (pathname === '/api/teamflow/tasks' && req.method === 'GET') {
    return require('../../modules/teamflow').handleTasks(req, res);
  }
  // 2026-08-30 §team-ui: 用户加/删定时任务
  if (pathname === '/api/teamflow/tasks' && req.method === 'POST') {
    return require('../../modules/teamflow').handleCreateTask(req, res);
  }
  if (pathname.startsWith('/api/teamflow/tasks/') && req.method === 'DELETE') {
    const _label = decodeURIComponent(pathname.slice('/api/teamflow/tasks/'.length));
    return require('../../modules/teamflow').handleDeleteTask(req, res, _label);
  }

  // ==================== 预设接口 ====================
  if (pathname.includes('presets') && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ok: true, presets: PRESETS}));
  }

  // ==================== 测试模型连通性 (后端代理, 避免浏览器 CORS) ====================
 // 前端不再直接 fetch LM Studio, 走盘古后端代理
  if (pathname === '/api/llm/test-connection' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch (_) { res.writeHead(400, {'Content-Type': 'application/json'}); return res.end(JSON.stringify({ ok: false, error: 'INVALID_JSON' })); }
      try {
        const { base_url, api_key, model, protocol, provider } = parsed;
        if (!base_url || !model) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ok: false, error: 'missing base_url or model'}));
        }
        // 2026-10-16: 与 /api/models/add 共用 _probeModelReachable ——
        // 旧码这里自己拼了一套 (Authorization: Bearer + 无 signal + 不按协议补路径),
        // 和真正发请求的那条链不同源, 于是"测试说通、加进去调不通"。
        const probe = await _probeModelReachable({
          id: model, api_model: model, name: model,
          endpoint: base_url, api_key, protocol, provider,
        });
        res.writeHead(safeStatus(probe.ok ? 200 : 502, 502), {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ ok: !!probe.ok, status: probe.status, data: probe.data, probe }));
      } catch (e) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ok: false, error: e.message}));
      }
    });
    return;
  }

  // ==================== 测试 evolution 写 ====================
  if (pathname === '/api/test/evo-write' && req.method === 'GET') {
    // 2026-07-28 fix:
    //   - 写死某台机器的家目录路径, 换成 os.homedir();
    //   - 同步 appendFileSync 阻塞 event loop，换异步 fs.appendFile；
    //   - 目录不存在会抛 ENOENT，加 try/catch 返 500 而不是悬挂；
    try {
      const os = require('os');
      const fs = require('fs');
      const path = require('path');
      const evoDir = evolutionDir();
      if (!fs.existsSync(evoDir)) fs.mkdirSync(evoDir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      const fp = path.join(evoDir, today + '.jsonl');
      const line = JSON.stringify({ ts: new Date().toISOString(), test: 'test-route', pid: process.pid }) + '\n';
      fs.appendFile(fp, line, (err) => {
        if (err) {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, pid: process.pid, path: fp }));
      });
      return;
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // ==================== Vision 探测 (2026-08-22: 老板拍, 用户加模型时怎么判断是不是视觉模型) ====================
  // 三层识别: ① 端点 metadata ② 真发图探测 ③ 正则兜底
  // 端点 metadata 主流 provider 都不暴露 vision 能力, 所以核心是 ② 真发图
  // 探测逻辑: 发 1×1 红色 PNG + 问"图里是什么颜色", 看模型能不能描述
  if ((pathname === '/api/llm/probe-vision' || pathname === '/llm/probe-vision') && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let req_body;
      try { req_body = JSON.parse(body || '{}'); }
      catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
      try {
        const modelId = req_body.id || req_body.model_id;
        const override = req_body.model || null;
        if (!modelId && !override) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ok: false, error: 'MISSING_MODEL_ID'}));
        }
        // 从模型池找, 没找到就要求 override
        const m = override || (_config.llm.models || []).find(x => x.id === modelId);
        if (!m) {
          res.writeHead(404, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ok: false, error: 'MODEL_NOT_IN_POOL', hint: '提供完整 model 对象 (含 endpoint/api_key) 才能探测'}));
        }
        if (!m.endpoint) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ok: false, error: 'MISSING_ENDPOINT'}));
        }
        // 2026-08-22: 用 Python 生成的合法 10x10 红色 PNG (100 chars, IHDR+IDAT+IEND 完整)
        // 之前手编的 1×1 / 10x10 字节顺序错, LM Studio validator 拒 "Invalid image detected"
        const TEST_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC';
        const TEST_PNG_DATA_URL = 'data:image/png;base64,' + TEST_PNG_B64;
        // 2026-09-14 修 (老板拍 #5: agnes-3.0-flash 多模态探测不通过): 手写拼接不认 /v1 结尾 →
        // endpoint=https://api.agnes-ai.cn/v1 被拼成 /v1/v1/chat/completions → 404 → 误判 vision=false。
        // 复用 llm_caller._normalizeEndpoint (hasV 规则: /v1 结尾只补 /chat/completions)。
        const endpoint = llmCaller._normalizeEndpoint(m.endpoint, m.protocol);
        const isAnthropic = m.protocol === 'anthropic' || /anthropic|claude/i.test(endpoint);
        const body_payload = isAnthropic ? {
          model: m.id,
          max_tokens: 200,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TEST_PNG_B64 } },
            { type: 'text', text: '这张图里是什么颜色? 用一个词回答。' }
          ]}],
        } : {
          model: m.id,
          // 2026-08-22: reasoning 模型烧思考要 100+ tokens, 给到 800 保险 (否则 qwen3.6 99 思考 + 0 final 全砍掉, probe 误判 vision=false)
          max_tokens: 800,
          messages: [{ role: 'user', content: [
            { type: 'text', text: '这张图里是什么颜色? 用一个词回答。图是 10x10 红色 PNG。' },
            { type: 'image_url', image_url: { url: TEST_PNG_DATA_URL } }
          ]}],
        };
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 30000);
        const _mKey = _resolveApiKey(m) || '';   // 第 110 批: 走统一解析链
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // 2026-10-26 (第 110 批): 走统一解析链 —— 明文已从配置里收编进凭证库,
            // 直接读 m.api_key 会拿到空串 ⇒ 探针误判成「没鉴权」。
            ...(_mKey ? { 'Authorization': 'Bearer ' + _mKey } : {}),
            ...(isAnthropic ? { 'anthropic-version': '2023-06-01' } : {}),
          },
          body: JSON.stringify(body_payload),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        const status = resp.status;
        const data = await resp.text();
        if (!resp.ok) {
          // 400/422 = 模型明确拒绝图 → vision=false
          res.writeHead(200, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({
            ok: true,
            model_id: m.id,
            vision: false,
            method: 'probe',
            status,
            reason: 'model_rejected_image',
            error_excerpt: data.slice(0, 300),
          }));
        }
        // 成功 → 解析 response 看模型是否描述了图
        let described = false;
        try {
          const j = JSON.parse(data);
          // 2026-08-22: reasoning 模型把回答放在 reasoning_content 而不是 content (qwen3.6 实测), 两个都要检查
          const _msg = j.choices?.[0]?.message || {};
          // §probe-fix: 校验响应模型是否匹配请求模型 (LM Studio 模型名错了也返 200 但用别的模型服务)
          const _respondedModel = j.model || '';
          const _exactMatch = _respondedModel && m.id && _respondedModel === m.id;
          const _looseMatch = _respondedModel && m.id && (_respondedModel.includes(m.id) || m.id.includes(_respondedModel));
          if (_respondedModel && !(_exactMatch || _looseMatch)) {
            res.writeHead(200, {'Content-Type': 'application/json'});
            return res.end(JSON.stringify({
              ok: true,
              model_id: m.id,
              vision: false,
              method: 'probe',
              status,
              reason: 'model_name_mismatch',
              responded_model: _respondedModel,
              note: 'LM Studio 等本地 provider 模型名不匹配时仍返 200 但用错模型, 探测结果不可信, 建议手动设置 vision',
            }));
          }
          const txt = isAnthropic
            ? (j.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ')
            : ((_msg.content || '') + ' ' + (_msg.reasoning_content || '')).trim();
          // 模型真回答了图内容 (颜色词 / 描述词) → vision=true
          if (/红|red|蓝|blue|绿|green|黄|yellow|黑|black|白|white|紫|purple|橙|orange|粉|pink|灰|gray|grey|棕色|brown/i.test(txt)) {
            described = true;
          }
          res.writeHead(200, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({
            ok: true,
            model_id: m.id,
            vision: described,
            method: 'probe',
            status,
            responded_model: _respondedModel,
            response_excerpt: txt.slice(0, 200),
            color_word_found: described,
          }));
        } catch (e) {
          res.writeHead(200, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ok: true, model_id: m.id, vision: false, method: 'probe', status, parse_error: e.message}));
        }
      } catch (e) {
        const isAbort = e.name === 'AbortError';
        res.writeHead(isAbort ? 504 : 500, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ok: false, error: isAbort ? 'PROBE_TIMEOUT' : e.message}));
      }
    });
    return;
  }

  // ==================== 模型池列表 ====================
  if (pathname.includes('/api/llm/models') && req.method === 'GET') {
    normalizeModels();
    const cur = getCurrentModel();
    // R88-generic round 2.3: 不直接返 m.context_length (config 硬编码)
    // 改走 registry 唯一真源: registry 有 → 返真值, 没有 → 删 context_length 字段
    // 防止 k3 / gemma / minimax 这种"没 chat-scope key"的 model 在 UI 显示假 32K
    const modelRegistry = require('../../modules/model_registry');
    // 2026-09-16 老板拍 (参考 Codex++ 模型列表): UI 显示 ctx 来源标签 + 自动压缩阈值 (窗口 × PANGU_COMPACT_TOKEN_RATIO, 默认 0.8)
    const _compactRatio = parseFloat(process.env.PANGU_COMPACT_TOKEN_RATIO || '0.8');
    const _ctxSourceLabel = (src) => ({
      'provider-models-api': '厂商官方', 'L1-models-field': '厂商官方', 'L2-lmstudio': '本地真源',
      'L2-ollama': '本地真源', 'L0-gateway-upper': '网关实测', 'self-report': '模型自报',
      'L3-chat-probe': '估算', 'L4-messages-probe': '估算', 'cache': '缓存',
    })[src] || src || '未知';
    const modelsOut = (_config.llm.models || []).map(m => {
      if (!m) return m;
      const regCtx = modelRegistry.getContextLength(m.id);
      const regInfo = modelRegistry.getModelInfo(m.id) || {};
      if (regCtx) {
        return { ..._publicModel(m), context_length: regCtx, _ctx_source: regInfo.source || 'registry', _ctx_source_label: _ctxSourceLabel(regInfo.source || 'registry'), _auto_compact_at: Math.max(1000, Math.floor(regCtx * _compactRatio)) };
      }
      // registry miss: 删 context_length 字段, 标 _ctx_error 让 UI 显示"未探测"
      const { context_length, _user_override_context_length, ...rest } = m;
      return { ..._publicModel(rest), _ctx_error: 'not-discoverable', _ctx_source: 'none', _ctx_source_label: '未探测' };
    });
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({
      ok: true,
      models: modelsOut,
      default_model: typeof cur === 'object' ? _publicModel(cur) : cur, // 兼容旧前端, never expose credentials
      current_model_id: _config.llm.current_model_id
    }));
  }

  // 云端账号目录：只读该账号实际有权限的模型。能力/上下文仍由 models.dev
  // 补齐，避免把公共目录误当成当前 Token Plan 的可用集合。
  if (pathname === '/api/llm/provider-models/refresh' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
      try {
const { provider, endpoint: bodyEndpoint, api_key: bodyApiKey, protocol: bodyProtocol } = parsed;
// 2026-10-13: 表单里的 base URL 是人明确指定的地址, 优先于"按 provider 名去模型池猜 seed"。
// 老行为只发 provider, 后端捞 seeds[0] —— 本地 MLX 和 agnes 同为 provider='custom' 时,
// 排在前面的是 agnes, 于是点"从上游获取"打的永远是云端, 跟表单里填的 127.0.0.1 无关。
const explicit = !!(bodyEndpoint && String(bodyEndpoint).trim());
const useProvider = provider || 'openai';
let seed;
if (explicit) {
// 沿用同provider 已有条目的 protocol/capabilities 习惯, endpoint 用body 的
const prior = (_config.llm.models || []).find(m => m && m.provider === useProvider) || {};
seed = {
...prior,
id: useProvider,
provider: useProvider,
protocol: bodyProtocol || prior.protocol || 'openai',
endpoint: String(bodyEndpoint).trim(),
api_key: bodyApiKey || '',
};
} else {
const seeds = (_config.llm.models || []).filter(m => m && m.provider === useProvider && providerCatalog.isRemoteOpenAICompatible(m));
if (!provider || seeds.length === 0) {
return json(res, { ok: false, error: 'NO_REMOTE_PROVIDER_CONFIG' }, 400);
}
seed = seeds[0];
}
// allowLocal: 显式指定 endpoint 时localhost 是合法目标 (mlx-serve / LM Studio / Ollama 都有 /v1/models)
const result = await providerCatalog.listAccountModels(seed, _resolveApiKey, { allowLocal: explicit });
        if (!result.ok) return json(res, { ok: false, error: result.error, status: result.status }, 502);
        const normalizeId = (id) => String(id || '').trim().toLowerCase();
const configured = new Set((_config.llm.models || []).filter(m => m.provider === useProvider).map(m => normalizeId(m.id)));
        const registry = require('../../modules/model_registry');
        const models = providerCatalog.extractModelEntries(result.data).map(entry => {
          const id = entry.id;
          // 2026-10-26 第 102 批: 用 resolveCapabilities (能说清「命中/查不到/查错」),
          // 不再用 lookupModelCapabilities (只给 hit 或 null, 分不清查不到和查错)。
          const cap = llmCapSync.resolveCapabilities({ id, provider: useProvider, endpoint: seed.endpoint });
          const capCaps = cap.capabilities || {};
          const providerCtx = Number(entry.context_length) > 0 ? Number(entry.context_length) : null;
if (providerCtx) registry.setContextLength(id, providerCtx, 'provider-models-api', { provider: useProvider });
          return {
            id,
            name: id,
provider: useProvider,
protocol: seed.protocol || 'openai',
            // R88-generic round 2.3: cap?.ctx 是 LLM capability sync 的静态 cache, 不是真 probe
            // 改走 registry 唯一真源
            context_length: providerCtx || registry.getContextLength(id) || null,
            _ctx_source: providerCtx ? 'provider-models-api' : (registry.getModelInfo(id)?.source || null),
            capabilities: ['chat', ...(capCaps.reasoning ? ['reasoning'] : []), ...(capCaps.tool ? ['tool'] : []), ...(capCaps.vision ? ['vision'] : [])],
            // 能力来源: models-dev (库里查到) / custom (库里没有 ⇒ 自定义兼容模式, 能力取模型条目自己的声明)
            capability_source: cap.status === 'hit' ? 'models-dev' : 'custom',
            capability_reason: cap.reason,
            configured: configured.has(normalizeId(id)),
            source: 'provider-account',
          };
        });
return json(res, { ok: true, provider: useProvider, endpoint: result.endpoint, synced_at: new Date().toISOString(), models });
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  if (pathname === '/api/llm/provider-models/add' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
      try {
        // R88-generic round 2.6 (老板 9/9 20:17 拍): 原子 add-model
        // 流程: test 连接 (chat 一发) → L3/L4 probe ctx → 两个都过才加, 失败不写 config
        // 之前: 加 model → 后台异步 probe → 失败半残废; 现在: 一气呵成
        const { provider, id, endpoint: bodyEndpoint, api_key: bodyApiKey } = parsed;
        if (!id) return json(res, { ok: false, error: 'MISSING_ID' }, 400);
        if ((_config.llm.models || []).some(m => String(m.id || '').toLowerCase() === String(id).toLowerCase())) {
          return json(res, { ok: false, error: 'DUPLICATE_ID' }, 409);
        }
        // 决定 endpoint / api_key (body 优先, 没就 fallback 到 seed provider)
        let useEndpoint = bodyEndpoint;
        let useApiKey = bodyApiKey;
        let useProvider = provider;
        let useProtocol = 'openai';
        if (!useEndpoint || !useApiKey) {
          const seed = (_config.llm.models || []).find(m => m && m.provider === provider && providerCatalog.isRemoteOpenAICompatible(m));
          if (!seed) return json(res, { ok: false, error: 'NO_REMOTE_PROVIDER_CONFIG' }, 400);
          useEndpoint = useEndpoint || seed.endpoint;
          useApiKey = useApiKey || _resolveApiKey(seed);
          useProvider = seed.provider || provider;
          useProtocol = modelTransport.protocolOf(seed);
        }
        if (!useEndpoint || !useApiKey) {
          return json(res, { ok: false, error: 'MISSING_ENDPOINT_OR_KEY' }, 400);
        }
        // bearer 提外层变量 (避开 system secret mask "***' +" → "***' ***")
        const probeModel = {
          id,
          name: id,
          api_model: parsed.api_model || parsed.model_name || id,
          provider: useProvider,
          protocol: useProtocol,
          endpoint: useEndpoint,
        };
        // 步 1: test 连接 (chat 一发, 200 = 通了, 401/404/超时 = 不通)
        const t0 = Date.now();
        const probe = require('../../modules/model_probe');
        const endpointParts = probe._endpointParts(useEndpoint);
        if (!endpointParts) return json(res, { ok: false, error: 'INVALID_ENDPOINT' }, 400);
        const useMessages = modelTransport.isAnthropic(probeModel);
        const testResp = await new Promise((resolve) => {
          let u, lib, opts;
          try {
            u = new URL(useMessages ? endpointParts.messages : endpointParts.chat);
            lib = u.protocol === 'https:' ? require('https') : require('http');
            opts = {
              hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
              path: u.pathname, method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              timeout: 30000,
            };
          } catch (e) { return resolve({ status: 0, body: '', error: e.message }); }
          const reqBody = JSON.stringify({
            model: modelTransport.canonicalModelName(probeModel),
            max_tokens: 1,
            messages: [{ role: 'user', content: 'test' }],
          });
          const headers = modelTransport.authHeaders(probeModel, useApiKey);
          headers['Content-Length'] = Buffer.byteLength(reqBody);
          opts.headers = headers;
          const req = lib.request(opts, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
          });
          req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
          req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve({ status: 0, body: '', error: 'timeout' }); });
          req.write(reqBody);
          req.end();
        });
        if (testResp.status !== 200 && testResp.status !== 201) {
          return json(res, { ok: false, error: 'CONNECTION_TEST_FAILED', detail: 'HTTP ' + testResp.status + ': ' + (testResp.body || '').slice(0, 200) }, 400);
        }
        // 步 2: L3 probe 拿 ctx (trial-and-error, vendor-agnostic, 6 次二分)
        // 复用 model_probe.probeContextLength (R88-generic 骨架, 不写死)
        const probeResult = await probe.probeContextLength({ ...probeModel, api_key: useApiKey });
        if (!probeResult || typeof probeResult.context_length !== 'number' || probeResult.context_length <= 0) {
          return json(res, { ok: false, error: 'CONTEXT_PROBE_FAILED', detail: 'L3/L4 trial-and-error 拿不到 ctx, key 可能没 chat scope, 换 key 重试' }, 400);
        }
        // 步 3: test + probe 全过 → 写 model (ctx 来自 probe, 不写死)
        const model = {
          id, name: id, provider: useProvider, protocol: useProtocol, endpoint: useEndpoint,
          api_model: probeModel.api_model, api_key: useApiKey, enabled: true, priority: 100,
          _catalog_source: 'atomic-add', _catalog_synced_at: new Date().toISOString(),
          _probe_source: probeResult.source, _probe_at: new Date().toISOString(),
          _probe_ms: Date.now() - t0,
        };
        // 写 registry (cache 0 call 下次)
        require('../../modules/model_registry').setContextLength(id, probeResult.context_length, probeResult.source);
        // 写 _config.llm.models (不带 context_length 字段, 避免任何硬编码, 让 startup hook + API filter 拿 registry 真值)
        _config.llm.models.push(model);
        saveConfig();
        return json(res, {
          ok: true,
          model,
          context_length: probeResult.context_length,
          source: probeResult.source,
          test_ms: Date.now() - t0,
          msg: 'test+probe 全过, model ' + id + ' 已加, ctx=' + probeResult.context_length + ' (' + probeResult.source + ')'
        });
      } catch (e) {
        return json(res, { ok: false, error: e.message }, 500);
      }
    });
    return;
  }
  // ==================== 延迟感知路由 (第 111 批) ====================
  // GET  /api/llm/routing        → 当前路由决策报告 (不探针)
  // POST /api/llm/routing/refresh → 立刻重探 + 应用 (policy=auto 时可能切模型)
  if (pathname === '/api/llm/routing' && req.method === 'GET') {
    try {
      const routing = require('../../modules/model_routing');
      return json(res, { ok: true, ...routing.report(_config) });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }
  if (pathname === '/api/llm/routing/refresh' && req.method === 'POST') {
    try {
      const routing = require('../../modules/model_routing');
      const decision = await routing.applyRouting(_config, { force: true });
      let switched = null;
      if (decision && decision.action === 'switch' && decision.to !== decision.from) {
        const _sw = _performModelSwitch(decision.to, { manual: false, reason: 'routing:' + decision.reason });
        switched = _sw.ok ? { ok: true, from: decision.from, to: decision.to } : { ok: false, error: _sw.error };
      }
      return json(res, {
        ok: true,
        decision: {
          action: decision.action, from: decision.from, to: decision.to,
          reason: decision.reason, candidate: decision.candidate || null,
        },
        switched,
        results: (decision.results || []).map(r => ({
          id: r.id, ok: r.ok, ms_first: r.ms_first, ms_total: r.ms_total,
          error: r.error || '', skipped: !!r.skipped,
        })),
      });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  // ==================== 设置"在用"模型 — 单一真源切换 ====================
  if (pathname === '/api/llm/use' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
      try {
        const { id } = parsed;
        if (!id) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ok: false, error: 'MISSING_ID'}));
        }
        const m = _config.llm.models.find(x => x.id === id);
        if (!m) {
          res.writeHead(404, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ok: false, error: 'NOT_FOUND'}));
        }
        if (m.enabled === false) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ok: false, error: 'MODEL_DISABLED'}));
        }
        const _sw = _performModelSwitch(id, { manual: true, reason: 'user' });
        if (!_sw.ok) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ok: false, error: _sw.error}));
        }
        return res.end(JSON.stringify(_sw));
      } catch (e) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ok: false, error: e.message}));
      }
    });
    return;
  }

  // ==================== 模型池操作 ====================
  if (pathname.includes('/api/llm/models') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on("end", async () => {
      let req_body;
      try { req_body = JSON.parse(body || '{}'); }
      catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
      try {
        const { action } = req_body;

        if (action === 'add_from_preset') {
          const preset = PRESETS.find(p => p.key === req_body.preset_key);
          if (!preset) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            return res.end(JSON.stringify({ok: false, error: 'PRESET_NOT_FOUND'}));
          }
          const override = req_body.override || {};
          const newModelId = preset.default_model || preset.key;
          const modelRegistry = require('../../modules/model_registry');
          const presetContextLength = Number(preset.context_length) || 0;
          const knownContextLength = modelRegistry.getContextLength(newModelId)
            || (presetContextLength > 0 ? modelRegistry.setContextLength(newModelId, presetContextLength, 'preset')?.context_length : null);
          if (!knownContextLength) throw new Error('inline_router: model context not discoverable: ' + newModelId);
          const newModel = {
            id: newModelId,
            name: preset.name,
            provider: preset.api_protocol === 'anthropic' ? 'anthropic' : 'openai',
            protocol: preset.api_protocol,
            endpoint: preset.base_url + (preset.default_port && preset.default_port > 0 ? ':' + preset.default_port : ''),
            tier: 'large',
            capabilities: ['chat', 'reasoning'],
            // R88: registry 优先 (Pangu runtime 读), fallback 32768
            // R88-generic round 2.2: registry 唯一真源, 不再 || undefined fallback
            context_length: knownContextLength,
            priority: 100,
            enabled: true,
 // 不再写 default 字段, 单一真源 current_model_id
          };
          // 2026-10-26 (第 110 批): 用户当场填的 key ⇒ 存进 ~/.pangu/credentials.json,
          //   配置里只留 api_key_credential 引用。**明文不再落进项目目录**。
          const _presetKey = require('../../modules/node_credentials').applySubmittedKey(newModel, override.api_key || '');
          if (_presetKey.stored) console.log('[credentials] 预设模型的 key 已存进凭证库:', _presetKey.name);
          if (_config.llm.models.some(m => m.id === newModel.id)) {
            res.writeHead(200, {'Content-Type': 'application/json'});
            return res.end(JSON.stringify({ok: false, error: 'DUPLICATE_ID'}));
          }
          _config.llm.models.push(newModel);
 // 加第一个模型自动设为 current
          if (!_config.llm.current_model_id) {
            _config.llm.current_model_id = newModel.id;
          }
          saveConfig();
          res.writeHead(200, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({
            ok: true,
            models: _config.llm.models.map(_publicModel),
            current_model_id: _config.llm.current_model_id
          }));

        } else if (action === 'add') {
          const m = req_body.model;
          if (!m || !m.id) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            return res.end(JSON.stringify({ok: false, error: 'MISSING_ID'}));
          }
          if (_config.llm.models.some(x => x.id === m.id)) {
            res.writeHead(200, {'Content-Type': 'application/json'});
            return res.end(JSON.stringify({ok: false, error: 'DUPLICATE_ID'}));
          }
 // 拒收 default / current_model_id 字段
          const { default: _d, current_model_id: _c, ...safeM } = m;
          // Public model responses redact credentials as `***`. Never persist
          // that marker (or an empty key) as if it were a real replacement.
          // 2026-10-26 (第 110 批): 提交上来的真 key ⇒ 存凭证库, 只留引用。
          //   '***' (前端回显的脱敏值) 和空串都**不是**新 key ⇒ 保持原样。
          // 2026-10-16 (老板: "关键是盘古的模型配置项, 选本地连模型还是云端的"):
          // 这条路径以前只查重, 不看端点、不探活, 加完就回 ok:true —— 前端立刻弹
          // "✓ 已加"。于是用户看到的是"挂载成功了", 实际第一次真被路由到才炸,
          // 而且报的是跟根因无关的通用错误。
          // 最要命的一种: 端点留空。endpointOf() 会回落到全局 llm.openai_base_url,
          // 于是"为 oMLX 配的模型静默连到了 LM Studio" —— 端点通、模型名对不上、
          // 一切看起来正常, 只是答非所问。这正是"mlxserver 自己能用, 盘古调不了"。
          const _addBad = _validateModelForAdd(safeM);
          if (_addBad) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            return res.end(JSON.stringify({ ok: false, error: _addBad }));
          }
          // 收编放在校验**之后**: 校验没过就不该往凭证库里塞一条没人引用的条目。
          //   (探针在下一行, 那时 safeM 已经没有明文了, 走的是凭证库 —— 正好。)
          require('../../modules/node_credentials').applySubmittedKey(safeM, safeM.api_key);
          // 离线 server (还没起) 允许先入池, 但结论必须原样带回前端。
          // 本地端口不通是 ECONNREFUSED 瞬返, 5s 只是防"端口开着但不回话"的死等。
          const _addProbe = await _probeModelReachable(safeM, { timeoutMs: 5000 });
          _config.llm.models.push(safeM);
          let vision_source = null;
          if (!_config.llm.current_model_id) {
            _config.llm.current_model_id = safeM.id;
          }
          saveConfig();
          // 2026-09-16 老板拍 (参考 Codex++ "从上游获取"): 加池时先拉上游 /models 拿官方 context_length.
          // 上游带字段 (Kimi) → 真值直接写 registry; 不带 (MiniMax/agnes) → 落到 L0 网关400真上限 / L3 估算.
          // 通用规则: 远端 OpenAI 兼容端点才拉, 本地 (LM Studio/Ollama) 走 L2 真源, 不拉上游.
          try {
            if (providerCatalog.isRemoteOpenAICompatible({ endpoint: safeM.endpoint, protocol: safeM.protocol })) {
              // 2026-10-26 (第 110 批): 明文已被收编 ⇒ 取 key 要带**引用**,
              //   只传 api_key 的话, 通用 provider (custom) 推不出凭证名 ⇒ 静默拿不到 key。
              const _upKey = _resolveApiKey({
                id: safeM.id, endpoint: safeM.endpoint, protocol: safeM.protocol,
                provider: safeM.provider,
                api_key_credential: safeM.api_key_credential,
                api_key_env: safeM.api_key_env,
              });
              if (_upKey) {
                const _up = await providerCatalog.listAccountModels({ id: safeM.id, endpoint: safeM.endpoint, protocol: safeM.protocol, api_key: _upKey }, (mm) => _upKey);
                if (_up.ok) {
                  const _upEntry = providerCatalog.extractModelEntries(_up.data).find(e => e.id === safeM.id || e.id === safeM.name);
                  if (_upEntry && Number(_upEntry.context_length) > 0) {
                    require('../../modules/model_registry').setContextLength(safeM.id, Number(_upEntry.context_length), 'provider-models-api', { provider: safeM.provider });
                    console.log('[add-model] ' + safeM.id + ' 上游官方 ctx=' + _upEntry.context_length + ' (provider-models-api)');
                  }
                }
              }
            }
          } catch (e) { console.warn('[add-model] 上游 ctx 拉取失败, 走 L0/L3 兜底:', e.message); }
          // 2026-08-22 §self-report: async fire-and-forget (老板拍: 模型能力都应该从模型拿才对)
          // 加池响应立即返回, 后台跑 self-report, 完成后自动写回 config
          if (safeM.endpoint) _asyncSelfReport(safeM.id);
          // 2026-08-22 §cn-rules: 国产模型规则库兜底
          try {
            const _hitCn = llmCapCn.lookupCnCapabilities(safeM);
            if (_hitCn) {
              const idx = _config.llm.models.length - 1;
              _config.llm.models[idx].vision = _hitCn.vision;
              _config.llm.models[idx]._vision_auto = true;
              _config.llm.models[idx]._vision_source = 'cn-rules';
              _config.llm.models[idx]._vision_yaml_key = _hitCn.provider + '/' + _hitCn.key;
              _config.llm.models[idx]._vision_yaml_at = new Date().toISOString();
              if (_hitCn.reasoning) _config.llm.models[idx].reasoning = true;
              if (_hitCn.tool) _config.llm.models[idx].tool = true;
              if (_hitCn.ctx && !_config.llm.models[idx].context_length) {
                _config.llm.models[idx].context_length = _hitCn.ctx;
              }
              saveConfig();
              vision_source = 'cn-rules:' + _hitCn.provider + '/' + _hitCn.key;
              console.log('[cn-rules]', safeM.id, '→ vision=' + _hitCn.vision + ' reason=' + _hitCn.reasoning + ' tool=' + _hitCn.tool + ' ctx=' + _hitCn.ctx);
            }
          } catch (e) {
            console.warn('[cn-rules]', safeM.id, 'lookup failed:', e.message);
          }
          // 2026-08-22 §lmstudio-discover: 加池时同步查 LM Studio 真源, 命中即写 vision/reasoning/tool/arch
          // 比异步 probe 探测快 + 准 + 无副作用 (LM Studio 同时只能加载 1 个模型, 探测别的会失败)
          try {
            const _hit = _lookupLmStudioCapabilities(safeM.id);
            if (_hit) {
              const idx = _config.llm.models.length - 1;
              _config.llm.models[idx].vision = _hit.vision;
              _config.llm.models[idx]._vision_auto = true;
              _config.llm.models[idx]._vision_source = 'lmstudio-yaml';
              _config.llm.models[idx]._vision_yaml_key = _hit.owner + '/' + _hit.name;
              _config.llm.models[idx]._vision_yaml_at = new Date().toISOString();
              if (_hit.reasoning) _config.llm.models[idx].reasoning = true;
              if (_hit.tool) _config.llm.models[idx].tool = true;
              if (_hit.arch && _hit.arch.length) _config.llm.models[idx].arch = _hit.arch;
              if (_hit.ctx && _hit.ctx[0]) _config.llm.models[idx].context_length = _hit.ctx[0];
              saveConfig();
              vision_source = 'lmstudio-yaml:' + _hit.owner + '/' + _hit.name;
              console.log('[lmstudio-discover]', safeM.id, '→ vision=' + _hit.vision + ' arch=' + JSON.stringify(_hit.arch));
            }
          } catch (e) {
            console.warn('[lmstudio-discover]', safeM.id, 'lookup failed:', e.message);
          }
          // 2026-08-22 §auto-sync: LM Studio 没命中 → 查 sst/models.dev 云端库
          if (!vision_source) {
            try {
              // 2026-10-26 第 102 批: status 感知 —— 命中就用库里的能力;
              // 查不到 (新厂商/库里没收录) ⇒ 自定义兼容模式: **不猜、不改判**,
              // 能力以模型条目自己写的为准 (vision/reasoning/tool/context_length)。
              const _cap2 = llmCapSync.resolveCapabilities(safeM);
              if (_cap2.status === 'hit') {
                const _hit2 = _cap2.capabilities;
                const idx = _config.llm.models.length - 1;
                if (_hit2.vision !== undefined) _config.llm.models[idx].vision = _hit2.vision;
                _config.llm.models[idx]._vision_auto = true;
                _config.llm.models[idx]._vision_source = 'models-dev';
                _config.llm.models[idx]._vision_yaml_key = _cap2.key;
                _config.llm.models[idx]._vision_yaml_at = new Date().toISOString();
                if (_hit2.reasoning) _config.llm.models[idx].reasoning = true;
                if (_hit2.tool) _config.llm.models[idx].tool = true;
                if (_hit2.ctx && !_config.llm.models[idx].context_length) {
                  _config.llm.models[idx].context_length = _hit2.ctx;
                }
                saveConfig();
                vision_source = 'models-dev:' + _cap2.key;
                console.log('[llm-cap-sync]', safeM.id, '→ vision=' + _hit2.vision + ' tool=' + _hit2.tool + ' ctx=' + _hit2.ctx);
              } else {
                console.log('[llm-cap-sync]', safeM.id, '→ ' + _cap2.status + ': ' + _cap2.reason);
              }
            } catch (e) {
              console.warn('[llm-cap-sync]', safeM.id, 'lookup failed:', e.message);
            }
          }
          // 2026-08-22: 加池后异步探测 vision (用户加模型时盘古自动判是不是多模态)
          // ① LM Studio 真源 + ② models.dev 云端库 都没命中才走 probe
          if (safeM.endpoint && !vision_source) _asyncProbeVision(safeM.id);
          res.writeHead(200, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({
            ok: true,
            models: _config.llm.models.map(_publicModel),
            current_model_id: _config.llm.current_model_id,
            // 提示前端: vision 来源 (lmstudio-yaml 是真源, 否则 probe pending)
            vision_source,
            vision_probe_pending: !vision_source && !!safeM.endpoint,
            // 2026-10-16: "加进去了" 和 "能用" 是两件事, 分开报。
            // reachable=false  → 池里有它, 但探不通 (server 没起 / 端口写错 / key 无效)
            // model_mismatch    → 端点通, 但 server 端回的不是你要的那个模型
            // 两者以前都只表现为"加成功了", 然后在真正跑任务时才炸。
            reachable: !!_addProbe.ok,
            model_mismatch: !!_addProbe.model_mismatch,
            probe: _addProbe,
            warning: _addProbe.model_mismatch ? _addProbe.model_mismatch_hint
              : (!_addProbe.ok
                ? ('已加进池, 但探不通 (' + (_addProbe.reason || 'unknown') + ')'
                  + (_addProbe.error ? ' — ' + _addProbe.error : '')
                  + '。任务路由到它时会失败, 建议先确认 server 已启动、端口和模型名对得上。')
                : null),
          }));

        } else if (action === 'update') {
          const m = req_body.model;
          if (!m || !m.id) {
            res.writeHead(400, {'Content-Type': 'application/json'});
            return res.end(JSON.stringify({ok: false, error: 'MISSING_ID'}));
          }
          const idx = _config.llm.models.findIndex(x => x.id === m.id);
          if (idx === -1) {
            res.writeHead(404, {'Content-Type': 'application/json'});
            return res.end(JSON.stringify({ok: false, error: 'NOT_FOUND'}));
          }
 // 切"在用"统一走 POST /api/llm/use
          // update 分支不再管 default 字段, 也不接受 current_model_id
          const { default: _drop1, current_model_id: _drop2, ...safeM } = m;
          // The desktop editor submits the redacted public model object when
          // saving unrelated fields. Preserve the stored secret instead of
          // replacing it with `***` or an empty string.
          // 2026-10-26 (第 110 批): 提交上来的真 key ⇒ 存凭证库, 只留引用。
          //   '***' (前端回显的脱敏值) 和空串都**不是**新 key ⇒ 保持原样。
          require('../../modules/node_credentials').applySubmittedKey(safeM, safeM.api_key);
          const _oldEndpoint = _config.llm.models[idx] && _config.llm.models[idx].endpoint;
          _config.llm.models[idx] = { ..._config.llm.models[idx], ...safeM };
          // 合并后如果还带着明文 (老配置里就有的) ⇒ 一并收编, 不让 saveConfig 写回去
          require('../../modules/node_credentials').applySubmittedKey(
            _config.llm.models[idx], _config.llm.models[idx].api_key);
          // 2026-09-14 (老板拍: 温度四档, 自动=继承全局): 前端选"自动"发 temperature:null — null 语义=删掉该键, 落回全局 llm.temperature
          if (safeM.temperature === null) delete _config.llm.models[idx].temperature;
          // 2026-09-14 (老板拍: 设置弹窗与聊天页完全一致=推理强度): reasoning_effort:null 同样删键, 落回请求档/任务分类
          if (safeM.reasoning_effort === null) delete _config.llm.models[idx].reasoning_effort;
          normalizeModels();
          saveConfig();
          // 2026-08-22 §lmstudio-discover: update 也先 discover, 命中就不 probe
          let upd_vision_source = null;
          if (safeM.endpoint && safeM.endpoint !== _oldEndpoint) {
            try {
              const _hit = _lookupLmStudioCapabilities(safeM.id);
              if (_hit) {
                _config.llm.models[idx].vision = _hit.vision;
                _config.llm.models[idx]._vision_auto = true;
                _config.llm.models[idx]._vision_source = 'lmstudio-yaml';
                _config.llm.models[idx]._vision_yaml_key = _hit.owner + '/' + _hit.name;
                if (_hit.arch && _hit.arch.length) _config.llm.models[idx].arch = _hit.arch;
                saveConfig();
                upd_vision_source = 'lmstudio-yaml:' + _hit.owner + '/' + _hit.name;
              } else {
                // 2026-08-22 §auto-sync: LM Studio 没命中 → 试 models.dev
                // 2026-10-26 第 102 批: status 感知 (命中 / 查不到→自定义兼容模式)
                const _cap3 = llmCapSync.resolveCapabilities(_config.llm.models[idx]);
                if (_cap3.status === 'hit') {
                  const _hit3 = _cap3.capabilities;
                  if (_hit3.vision !== undefined) _config.llm.models[idx].vision = _hit3.vision;
                  _config.llm.models[idx]._vision_source = 'models-dev';
                  _config.llm.models[idx]._vision_yaml_key = _cap3.key;
                  if (_hit3.reasoning) _config.llm.models[idx].reasoning = true;
                  if (_hit3.tool) _config.llm.models[idx].tool = true;
                  if (_hit3.ctx && !_config.llm.models[idx].context_length) _config.llm.models[idx].context_length = _hit3.ctx;
                  saveConfig();
                  upd_vision_source = 'models-dev:' + _cap3.key;
                } else {
                  _asyncProbeVision(safeM.id);
                }
              }
            } catch (_) {
              _asyncProbeVision(safeM.id);
            }
          }
          res.writeHead(200, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({
            ok: true,
            models: _config.llm.models.map(_publicModel),
            current_model_id: _config.llm.current_model_id,
            default_model: _publicModel(getCurrentModel())
          }));

        } else if (action === 'delete') {
          const id = req_body.id;
          const before = _config.llm.models.length;
          _config.llm.models = _config.llm.models.filter(x => x.id !== id);
          if (_config.llm.models.length === before) {
            res.writeHead(404, {'Content-Type': 'application/json'});
            return res.end(JSON.stringify({ok: false, error: 'NOT_FOUND'}));
          }
          normalizeModels();
          // Deleting the active model must never leave a dangling selector.
          // Pick the first enabled survivor, or clear the selector when the
          // pool is empty so the caller gets the normal NO_MODELS path.
          if (!_config.llm.models.some(x => x.id === _config.llm.current_model_id && x.enabled !== false)) {
            _config.llm.current_model_id = (_config.llm.models.find(x => x.enabled !== false) || {}).id || null;
          }
          saveConfig();
          res.writeHead(200, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ok: true, models: _config.llm.models.map(_publicModel), current_model_id: _config.llm.current_model_id}));
        }

        res.writeHead(400, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ok: false, error: 'UNKNOWN_ACTION'}));
      } catch (e) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ok: false, error: e.message}));
      }
    });
    return;
  }

  // ==================== 本地记忆 (从 vite dev plugin 搬到 18901, 2026-09-17 单端口收口) ====================
  // 旧: 5173 vite 的 localMemoryPlugin 直读 repo 根 memory/; 现在 18901 直接提供 /api/local-memory/{list,file}
  // HistoryView.jsx fetch 相对路径 /api/local-memory/* → 18901 上有就通, 不用再起 vite
  if (pathname.startsWith('/api/local-memory') && req.method === 'GET') {
    try {
      const fsLm = require('fs');
      const pathLm = require('path');
      const urlLm = new URL(req.url, 'http://x');
      const repoMemoryRoot = pathLm.join(pathLm.resolve(__dirname, '..', '..', '..', '..'), 'memory');
      const memoryCandidates = [
        process.env.PANGU_MEMORY_ROOT,
        pathLm.join(os.homedir(), '.pangu', 'memory'),
        repoMemoryRoot,
      ].filter(Boolean);
      const MEMORY_ROOT_LM = memoryCandidates.find(candidate => fsLm.existsSync(candidate)) || repoMemoryRoot;
      const _lmReadMemory = (rel) => {
        const norm = pathLm.normalize(String(rel || '')).replace(/^\/+/, '');
        const base = MEMORY_ROOT_LM;
        if (norm.split('/').includes('..')) throw new Error('bad path');
        const full = pathLm.join(base, norm);
        if (!full.startsWith(base)) throw new Error('path escape');
        return { base, full };
      };
      const _lmWalk = (base, dir, rel = '') => {
        const out = [];
        for (const name of fsLm.readdirSync(dir)) {
          const full = pathLm.join(dir, name);
          // 2026-10-28: 悬空软链 statSync 会抛 ENOENT ⇒ 整个记忆树接口 500,
          //   界面上只显示一句 "ENOENT: ... stat '/Users/<某人>/...'"。
          //   坏条目跳过, 不让一个坏软链掀翻整棵树。
          let st;
          try { st = fsLm.statSync(full); } catch (_) { continue; }
          const r = rel ? `${rel}/${name}` : name;
          if (st.isDirectory()) out.push({ type: 'dir', name, path: r, children: _lmWalk(base, full, r) });
          else out.push({ type: 'file', name, path: r, size: st.size, mtime: st.mtimeMs });
        }
        return out;
      };
      const _lmSeg = urlLm.pathname.split('/').pop();
      if (_lmSeg === 'list') {
        const { base } = _lmReadMemory('memory');
        // A fresh install may not have a repo-level memory directory yet.
        // History should render an empty state instead of returning HTTP 400.
        const tree = fsLm.existsSync(base) ? _lmWalk(base, base) : [];
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ root: base, files: tree }));
      }
      if (_lmSeg === 'file') {
        const p = urlLm.searchParams.get('path') || '';
        const { full } = _lmReadMemory(p);
        const st = fsLm.statSync(full);
        if (!st.isFile()) throw new Error('not a file');
        const text = fsLm.readFileSync(full, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
        return res.end(text);
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'UNKNOWN_LOCAL_MEMORY_PATH', path: urlLm.pathname }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('local-memory error: ' + e.message);
    }
  }

  // ==================== 模型池归一化 ====================
  if (pathname.includes('/api/llm/normalize') && req.method === 'POST') {
    normalizeModels();
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ok: true, models: _config.llm.models.map(_publicModel), default_model: _publicModel(getDefaultModel())}));
  }

  // ==================== Setup Status ====================
  if (pathname.includes('setup-status') && req.method === 'GET') {
    normalizeModels();
    const def = getDefaultModel();
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({
      ok: true,
      pool_count: _config.llm.models.length,
      default_model: def,
      next_steps: _config.llm.models.length === 0 ? [
        '选预设填表（自动添加）',
        '或手动填 endpoint / api_key / model_name 后点「加到模型池」'
      ] : []
    }));
  }

  // ==================== 配置接口 ====================
  if (pathname.includes('/api/config') && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ok: true, data: _publicConfig(_config)}));
  }

 // 兼容前端旧路径：浏览器 /config 指向 /api/config 同等内容
  if (pathname === '/config' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ok: true, data: _publicConfig(_config)}));
  }
  // GET /api/voice/devices — enumerate local audio/video devices for the desktop voice panel.
  if ((pathname === '/api/voice/devices' || pathname === '/voice/devices') && req.method === 'GET') {
    const devices = { audioinput: [], videoinput: [], audiooutput: [] };
    try {
      const { execFileSync } = require('child_process');
      const profiler = process.platform === 'darwin' ? '/usr/sbin/system_profiler' : 'system_profiler';
      const out = execFileSync(profiler, ['SPCameraDataType', 'SPAudioDataType', '-json'], { encoding: 'utf8', timeout: 8000 });
      const data = JSON.parse(out || '{}');
      for (const cam of (data.SPCameraDataType || [])) {
        const name = cam._name || cam.name || cam.camera_unique_id || '摄像头';
        devices.videoinput.push({ id: name, label: name, source: 'system_profiler' });
      }
      for (const group of (data.SPAudioDataType || [])) {
        const items = group._items || [];
        for (const item of items) {
          const name = item._name || item.name || item.device_name || item.coreaudio_device_name;
          if (!name) continue;
          const input = Number(item.coreaudio_device_input) > 0 || Number(item.input_channels) > 0;
          const output = Number(item.coreaudio_device_output) > 0 || Number(item.output_channels) > 0;
          if (input) devices.audioinput.push({ id: name, label: name, source: 'system_profiler' });
          if (output) devices.audiooutput.push({ id: name, label: name, source: 'system_profiler' });
        }
      }
    } catch (e) { devices.error = e.message; }
    // Browser labels are authoritative once permission is granted; this endpoint is a native fallback.
    const displayOutput = devices.audiooutput.find(d => /pe320|acer/i.test(String(d.label || '')));
    const displayInput = devices.audioinput.find(d => /pe320|acer/i.test(String(d.label || '')));
    devices.diagnostic = {
      display_output: Boolean(displayOutput),
      display_microphone: Boolean(displayInput),
      microphone_ready: devices.audioinput.length > 0,
      warning: displayOutput && !displayInput
        ? '系统当前只暴露了 PE320QXT 扬声器，没有暴露 PE320QXT 麦克风；盘古不会静默改用 MacBook 麦克风。请重新插拔 USB-C 上行线并检查系统设置→声音→输入。'
        : undefined,
    };
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ ok: true, devices }));
  }
  // POST /api/voice/transcribe — reserved local STT boundary. The selected voice model/service owns recognition.
  if ((pathname === '/api/voice/transcribe' || pathname === '/voice/transcribe') && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return;
    const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; if (bytes <= MAX_AUDIO_BYTES) chunks.push(chunk); });
    req.on('end', () => {
      let inputPath = '';
      let wavPath = '';
      try {
        if (bytes > MAX_AUDIO_BYTES) throw Object.assign(new Error('音频文件超过 25MB 限制'), { status: 413 });
        const raw = Buffer.concat(chunks);
        const contentType = String(req.headers['content-type'] || '');
        const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
        if (!boundaryMatch) throw new Error('音频表单格式无效');
        const boundary = Buffer.from('--' + boundaryMatch[1].replace(/^"|"$/g, ''));
        const marker = Buffer.from('\r\n\r\n');
        const start = raw.indexOf(marker);
        if (start < 0) throw new Error('没有收到音频数据');
        const bodyStart = start + marker.length;
        const end = raw.indexOf(Buffer.concat([Buffer.from('\r\n'), boundary]), bodyStart);
        const audio = raw.slice(bodyStart, end >= 0 ? end : raw.length);
        if (!audio.length) throw new Error('没有收到音频数据');
        const temp = path.join(os.tmpdir(), 'pangu-stt-' + Date.now() + '-' + Math.random().toString(16).slice(2));
        inputPath = temp + '.webm';
        wavPath = temp + '.wav';
        fs.writeFileSync(inputPath, audio, { mode: 0o600, flag: 'wx' });
        const { execFileSync } = require('child_process');
        const ffmpeg = _resolveVoiceFfmpeg();
        if (!ffmpeg) throw new Error('找不到 ffmpeg');
        execFileSync(ffmpeg, ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', wavPath], { timeout: 30000, stdio: 'ignore' });
        const python = _resolveWhisperPython();
        if (!python) throw new Error('未找到安装了 openai-whisper 的 Python 3');
        const script = path.join(__dirname, '..', '..', 'bin', 'pangu_transcribe.py');
        const voice = (_config && _config.voice) || {};
        const requestedModel = String(voice.stt_model || 'medium');
        const model = /^(tiny|base|small|medium|large|large-v[123]|large-v3-turbo|turbo)$/.test(requestedModel) ? requestedModel : 'medium';
        const output = execFileSync(python, [script, wavPath], { timeout: 240000, encoding: 'utf8', env: { ...process.env, PANGU_FFMPEG: ffmpeg, PANGU_STT_MODEL: model } });
        const result = JSON.parse(output);
        try { fs.unlinkSync(inputPath); fs.unlinkSync(wavPath); } catch (_) {}
        const status = result.ok ? 200 : (result.error === 'NO_SPEECH' ? 422 : 500);
        res.writeHead(status, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify(result));
      } catch (e) {
        try { if (inputPath) fs.unlinkSync(inputPath); if (wavPath) fs.unlinkSync(wavPath); } catch (_) {}
        res.writeHead(safeStatus(e.status, 500), {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ ok: false, error: 'STT_FAILED', message: e.message }));
      }
    });
    return;
  }
  // POST /api/voice/speak — browser playback bridge for local macOS say TTS.
  if ((pathname === '/api/voice/speak' || pathname === '/voice/speak') && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return;
    return readJsonBody(req, res, (parseError, body = {}) => {
      try {
        if (parseError) throw parseError;
        const text = String(body?.text || '').trim();
        if (!text) { res.writeHead(400, {'Content-Type': 'application/json'}); return res.end(JSON.stringify({ ok: false, error: 'NO_TEXT' })); }
        const out = path.join(os.tmpdir(), `pangu-tts-${Date.now()}-${Math.random().toString(16).slice(2)}.aiff`);
        const { execFileSync } = require('child_process');
        const voice = String(body.voice || 'Tingting');
        const speed = Number(body.speed) || 190;
        execFileSync('/usr/bin/say', ['-v', voice, '-r', String(speed), '-o', out, text], { timeout: 60000, stdio: 'ignore' });
        const token = path.basename(out);
        voiceAudioFiles.set(token, out);
        setTimeout(() => { voiceAudioFiles.delete(token); try { fs.unlinkSync(out); } catch (_) {} }, 10 * 60 * 1000);
        res.writeHead(200, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ ok: true, url: `/api/voice/audio/${encodeURIComponent(token)}`, voice, speed }));
      } catch (e) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ ok: false, error: 'TTS_FAILED', message: e.message }));
      }
    });
  }
  // GET /api/voice/audio/:token — short-lived local audio stream for the browser.
  if (pathname.startsWith('/api/voice/audio/') && req.method === 'GET') {
    const token = decodeURIComponent(pathname.slice('/api/voice/audio/'.length));
    const fp = voiceAudioFiles.get(token);
    if (!fp || !fs.existsSync(fp)) { res.writeHead(404, {'Content-Type': 'application/json'}); return res.end(JSON.stringify({ ok: false, error: 'AUDIO_NOT_FOUND' })); }
    res.writeHead(200, { 'Content-Type': 'audio/aiff', 'Content-Length': String(fs.statSync(fp).size), 'Cache-Control': 'no-store' });
    return fs.createReadStream(fp).pipe(res);
  }
  if ((pathname === '/api/voice/status' || pathname === '/voice/status') && req.method === 'GET') {
    const { execFileSync } = require('child_process');
    const voice = (_config && _config.voice) || {};
    const requestedModel = String(voice.stt_model || 'medium');
    const model = /^(tiny|base|small|medium|large|large-v[123]|large-v3-turbo|turbo)$/.test(requestedModel) ? requestedModel : 'medium';
    let stt = { ok: false, configured: true, engine: 'openai-whisper-local', model, endpoint: '/api/voice/transcribe' };
    try {
      const ffmpeg = _resolveVoiceFfmpeg();
      const python = _resolveWhisperPython();
      if (!ffmpeg) throw new Error('找不到 ffmpeg');
      if (!python) throw new Error('未找到安装了 openai-whisper 的 Python 3');
      if (!fs.existsSync(path.join(os.homedir(), '.cache', 'whisper', `${model}.pt`))) throw new Error(`本地未找到 Whisper ${model} 模型文件`);
      stt.ok = true;
    } catch (e) { stt.message = e.message; }
    let tts = { ok: false, message: 'macOS say 不可用' };
    try {
      const { execFileSync } = require('child_process');
      execFileSync('/usr/bin/say', ['-v', '?'], { encoding: 'utf8', timeout: 5000 });
      tts = { ok: true, engine: 'macos_say', voice: voice.tts_voice || 'Tingting' };
    } catch (e) { tts.message = e.message; }
    let microphone = { ok: false, display: false, message: '未检测到可用麦克风' };
    try {
      const profiler = process.platform === 'darwin' ? '/usr/sbin/system_profiler' : 'system_profiler';
      const out = execFileSync(profiler, ['SPAudioDataType', '-json'], { encoding: 'utf8', timeout: 8000 });
      const items = (((JSON.parse(out || '{}').SPAudioDataType || [])[0] || {})._items || []);
      const inputs = items.filter(item => Number(item.coreaudio_device_input) > 0 || Number(item.input_channels) > 0);
      const display = inputs.find(item => /pe320|acer/i.test(String(item._name || item.name || '')));
      microphone = { ok: inputs.length > 0, display: Boolean(display), input_count: inputs.length, default: inputs.find(item => item.coreaudio_default_audio_input_device === 'spaudio_yes')?._name || null };
      if (!display && items.some(item => /pe320|acer/i.test(String(item._name || item.name || '')) && Number(item.coreaudio_device_output) > 0)) {
        microphone.message = '系统只暴露了 PE320QXT 输出，未暴露其麦克风输入';
      }
    } catch (e) { microphone.message = e.message; }
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ ok: true, stt, tts, microphone, devices: '/api/voice/devices' }));
  }
  // 版本 / license / 节点 / 清理 等旧路径兜底
  if (pathname === '/api/version' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ok: true, version: '2026.8.5-pangu', service: 'pangu-single'}));
  }
  if (pathname === '/license/status' && req.method === 'GET') {
 // §0.18 单机零收费, license 只在 iCloud 服务端阶段 (Phase 4) 才有意义
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ok: true, valid: true, mode: 'single_free', plan: 'personal', phase4_license: 'pending'}));
  }
  if (pathname === '/nodes' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ok: true, nodes: [{id: 'your-mac', role: 'primary', status: 'online'}]}));
  }
  if (pathname === '/modules' && req.method === 'GET') {
    console.log('[modules-handler] hit, pathname=' + pathname + ' req.url=' + req.url);
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ok: true, modules: []}));
  }
  if (pathname === '/skills' && req.method === 'GET') {
 // N1 wire: 返回 SkillRuntime 加载的 skills (没 wire 时回退空数组)
    try {
      if (_skillRuntime && _skillRuntime._skills && _skillRuntime._skills.size > 0) {
        const skills = [];
        for (const [name, skill] of _skillRuntime._skills) {
          skills.push({
            name,
            guaId: skill.guaId || null,
            hexagram: skill.hexagram || null,
            tools: skill.tools || [],
          });
        }
        res.writeHead(200, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ok: true, skills, count: skills.length, source: 'skill_runtime'}));
      }
    } catch (e) { console.error('[inline_router] SkillRuntime source failed (non-fatal, trying file fallback):', e && e.message); }
 // v2 P1-5: 双源 fallback — SkillRuntime 空时读 pangu_skills.json, 让 count 与 /api/pangu/skills 对齐
    try {
      const fs = require('fs');
      const os = require('os');
      const skillsFile = path.join(os.homedir(), '.pangu', 'config', 'pangu_skills.json');
      if (fs.existsSync(skillsFile)) {
        const arr = JSON.parse(fs.readFileSync(skillsFile, 'utf8'));
        const skills = arr.map(s => ({
          name: s.name || s.id || '(unnamed)',
          tools: (s.spec && s.spec.tools) || [],
        }));
        return res.writeHead(200, {'Content-Type': 'application/json'})
          && res.end(JSON.stringify({ok: true, skills, count: skills.length, source: 'pangu_skills.json'}));
      }
    } catch (e) { console.error('[inline_router] pangu_skills.json fallback failed (returning empty):', e && e.message); }
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ok: true, skills: [], count: 0}));
  }
  if (pathname === '/hexagrams' && req.method === 'GET') {
 // N5 fix #15: 从 64i/hexagrams 读真实 64卦 (代替 hardcode 空数组)
    try {
      const hexData = require('../../64i/hexagrams');
      const hexList = hexData.getAllHexagrams ? hexData.getAllHexagrams() : (hexData.HEXAGRAMS || []);
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ok: true, hexagrams: hexList, count: hexList.length, source: '64i/hexagrams'}));
    } catch (e) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ok: false, error: e.message}));
    }
  }
 // N5 fix #15: /hexagram/:id — UI 要查单个卦 (决策面板用)
  if (pathname.startsWith('/hexagram/') && req.method === 'GET') {
    const idStr = pathname.slice('/hexagram/'.length);
    const id = parseInt(idStr, 10);
    if (isNaN(id) || id < 1 || id > 64) {
      res.writeHead(400, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ok: false, error: 'invalid hexagram id (1-64)'}));
    }
    try {
      const hexData = require('../../64i/hexagrams');
      const hex = hexData.getHexagram ? hexData.getHexagram(id) : (hexData.HEXAGRAMS || []).find(h => h.id === id);
      if (!hex) {
        res.writeHead(404, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ok: false, error: 'hexagram not found', id}));
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ok: true, hexagram: hex, source: '64i/hexagrams'}));
    } catch (e) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ok: false, error: e.message}));
    }
  }
  if ((pathname === '/cleanup' || pathname === '/api/cleanup') && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return;
    try {
      const result = await require('../../modules/housekeeping').runAll();
      return json(res, { ...result, cleaned: result.total_removed }, 200);
    } catch (e) {
      return json(res, { ok: false, error: e.message || 'CLEANUP_FAILED' }, 500);
    }
  }

  // 2026-09-07 R-UI-Restart: 一键重启 Pangu 进程 — launchd KeepAlive 自动拉起
  // 设计: 先发 200 (客户端能收到 ack), 600ms 后给自己发 SIGTERM
  // health.js 里 SIGTERM handler 会跑 asyncCleanup 再 exit → 干净退出 → launchd 拉新进程
  if ((pathname === '/api/pangu/restart' || pathname === '/pangu/restart') && req.method === 'POST') {
    const activeStreams = typeof sseSlots.inFlight === 'function' ? sseSlots.inFlight() : 0;
    if (activeStreams > 0) {
      return json(res, {
        ok: false,
        error: 'PANGU_BUSY',
        active_streams: activeStreams,
        msg: '当前有任务正在执行，暂不重启。请等任务结束后再重启。',
      }, 409);
    }
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({
      ok: true,
      status: 'restarting',
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      msg: 'Pangu 即将重启 (launchd KeepAlive 自动拉起, 约 2-3 秒)'
    }));
    setTimeout(() => {
      try { console.log('[pangu-restart] trigger via API, pid=' + process.pid + ' uptime=' + Math.round(process.uptime()) + 's'); } catch (_) {}
      try { process.kill(process.pid, 'SIGTERM'); } catch (e) { try { process.exit(0); } catch (_) {} }
    }, 600);
    return;
  }

  // ===== 2026-08-22: 前端 API 路由别名 (browser mode 兼容 + 部分缺失补齐) =====
  // /api/modules → /modules (legacy alias, inline 复用 handler)
  if (pathname === '/api/modules' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ok: true, modules: []}));
  }

  // /api/license/status → /license/status (legacy alias)
  if (pathname === '/api/license/status' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ok: true, license_ok: true, plan: 'personal', environment: 'single_free', service: 'pangu-single'}));
  }

  // /api/skills → /skills (browser proxy alias; use the same SkillRuntime source)
  if (pathname === '/api/skills' && req.method === 'GET') {
    try {
      if (_skillRuntime && _skillRuntime._skills && _skillRuntime._skills.size > 0) {
        const skills = [];
        for (const [name, skill] of _skillRuntime._skills) {
          skills.push({ name, guaId: skill.guaId || null, hexagram: skill.hexagram || null, tools: skill.tools || [] });
        }
        return json(res, { ok: true, skills, count: skills.length, source: 'skill_runtime' }, 200);
      }
      const skillsFile = path.join(os.homedir(), '.pangu', 'config', 'pangu_skills.json');
      if (fs.existsSync(skillsFile)) {
        const arr = JSON.parse(fs.readFileSync(skillsFile, 'utf8'));
        const skills = arr.map(s => ({ name: s.name || s.id || '(unnamed)', tools: (s.spec && s.spec.tools) || [] }));
        return res.end(JSON.stringify({ok: true, skills, count: skills.length, source: 'pangu_skills.json'}));
      }
    } catch (_) {}
    return res.end(JSON.stringify({ok: true, skills: [], count: 0}));
  }

  // /api/hexagrams → /hexagrams (browser proxy alias; must use the same 64i source)
  if (pathname === '/api/hexagrams' && req.method === 'GET') {
    try {
      const hexData = require('../../64i/hexagrams');
      const hexList = hexData.getAllHexagrams ? hexData.getAllHexagrams() : (hexData.HEXAGRAMS || []);
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ ok: true, hexagrams: hexList, count: hexList.length, source: '64i/hexagrams' }));
    } catch (e) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // /api/hexagram/:id → /hexagram/:id (browser proxy alias; same validation/data)
  if (pathname.startsWith('/api/hexagram/') && req.method === 'GET') {
    const id = parseInt(decodeURIComponent(pathname.slice('/api/hexagram/'.length)), 10);
    if (isNaN(id) || id < 1 || id > 64) {
      res.writeHead(400, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ ok: false, error: 'invalid hexagram id (1-64)' }));
    }
    try {
      const hexData = require('../../64i/hexagrams');
      const hex = hexData.getHexagram ? hexData.getHexagram(id) : (hexData.HEXAGRAMS || []).find(h => h.id === id);
      if (!hex) {
        res.writeHead(404, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ ok: false, error: 'hexagram not found', id }));
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ ok: true, hexagram: hex, source: '64i/hexagrams' }));
    } catch (e) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // /api/models/list → /api/llm/models (frontend 别名)
  if (pathname === '/api/models/list' && req.method === 'GET') {
    try {
      const models = ((_config.llm && _config.llm.models) || []).map(_publicModel);
      return json(res, { ok: true, models, current_model_id: _config.llm && _config.llm.current_model_id });
    } catch (e) { return json(res, { ok: true, models: [], error: e.message }); }
  }

  // /api/models/add → POST /api/llm/models (frontend 别名)
  if (pathname === '/api/models/add' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        let m;
        try { m = JSON.parse(body || '{}'); }
        catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
        // 2026-10-16: 先校验再加。旧码把任意 body 直接塞进模型池还回 ok:true,
        // 端点为空/写错也照收 —— 见 _validateModelForAdd 的注释。
        const bad = _validateModelForAdd(m);
        if (bad) return json(res, { ok: false, error: bad }, 400);
        // 真发一次请求看它到底通不通。离线模型 (server 还没起) 也允许先入池,
        // 但结论必须原样回给前端 —— 不能再是"加进去就当好了"。
        const probe = await _probeModelReachable(m);
        _config.llm = _config.llm || { models: [] };
        _config.llm.models = _config.llm.models || [];
        if (_config.llm.models.some(x => x.id === m.id)) {
          _config.llm.models = _config.llm.models.map(x => x.id === m.id ? { ...x, ...m } : x);
        } else {
          _config.llm.models.push(m);
        }
        // 持久化
        try { saveConfig(); } catch (_) {}
        return json(res, {
          ok: true,
          model: _publicModel(m),
          total: _config.llm.models.length,
          // 加进池了但调不通 —— 前端必须显示出来, 否则用户看到的就是"挂载上了却调不动"
          reachable: !!probe.ok,
          probe,
          // 端点通、但调的模型不是你要的那个 —— 同样必须报, 否则用户以为接好了
          model_mismatch: !!probe.model_mismatch,
          warning: probe.model_mismatch ? probe.model_mismatch_hint
            : (!probe.ok ? ('已加进池, 但探不通: ' + (probe.reason || 'unknown')
              + (probe.error ? ' — ' + probe.error : '')) : null),
        });
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }

  // Browser and Tauri share the same Markdown-history API. Restrict path
  // segments to the date-shaped filenames produced by the session writer.
  const markdownSessionMatch = pathname.match(/^\/(?:api\/)?sessions\/([^/]+)$/);
  if (markdownSessionMatch && (req.method === 'GET' || req.method === 'DELETE')) {
    let date;
    try { date = decodeURIComponent(markdownSessionMatch[1]); }
    catch (_) { return json(res, { ok: false, error: 'INVALID_SESSION_DATE' }, 400); }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, { ok: false, error: 'INVALID_SESSION_DATE' }, 400);
    const sessDir = path.join(os.homedir(), '.pangu', 'memory', 'memory', 'sessions');
    const fp = path.join(sessDir, date + '.md');
    if (req.method === 'DELETE') {
      if (!checkLocalOrigin(req, res)) return;
      try {
        if (!fs.existsSync(fp)) return json(res, { ok: false, error: 'NOT_FOUND', date }, 404);
        fs.unlinkSync(fp);
        return json(res, { ok: true, date, removed: true }, 200);
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    }
    if (fs.existsSync(fp)) {
      try {
        const content = fs.readFileSync(fp, 'utf8');
        const stat = fs.statSync(fp);
        return json(res, { ok: true, date, content, size: stat.size }, 200);
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    }
    return json(res, { ok: false, error: 'NOT_FOUND', date }, 404);
  }
  if (pathname === '/api/sessions' && req.method === 'GET') {
    try {
      const sessDir = path.join(os.homedir(), '.pangu', 'memory', 'memory', 'sessions');
      const sessions = [];
      if (fs.existsSync(sessDir)) {
        for (const file of fs.readdirSync(sessDir).filter(name => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort().reverse()) {
          try {
            const fullPath = path.join(sessDir, file);
            const stat = fs.statSync(fullPath);
            sessions.push({ date: file.slice(0, -3), file, size: stat.size, mtime: stat.mtimeMs, preview: fs.readFileSync(fullPath, 'utf8').slice(0, 400) });
          } catch (_) {}
        }
      }
      return json(res, { ok: true, sessions, count: sessions.length }, 200);
    } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }

  // ===== /api/pangu/agent/sessions (sidebar 续聊/删除用, 2026-08-22 立) =====
  // GET /api/pangu/agent/sessions?limit=20 → 列 JSON 活跃对话 session
  if (pathname === '/api/pangu/agent/sessions' && req.method === 'GET') {
    try {
      const limit = parseInt(new URL(req.url, 'http://x').searchParams.get('limit') || '20', 10);
      const sessDir = process.env.PANGU_SESSIONS_DIR || path.join(os.homedir(), '.pangu-data', 'sessions');
      const sessionMod = require(path.join(__dirname, '..', '..', 'modules', 'session_store'));
      const listed = await sessionMod.sessionList({ limit: Math.max(1, Math.min(limit, 200)) });
      const canonical = listed?.result?.sessions || [];
      const sessions = canonical.map(item => {
        const id = item.session_id;
        const file = id + '.json';
        const fullPath = path.join(sessDir, file);
        let extra = {};
        try {
          const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          extra = {
            size: fs.statSync(fullPath).size,
            preview: data.messages && data.messages.length > 0
              ? String(data.messages[data.messages.length - 1].content || '').slice(0, 80).replace(/\n/g, ' ')
              : '',
          };
        } catch (_) {}
        return { id, file, state: item.state || 'unknown', message_count: item.message_count || 0, last_updated: item.last_updated || 0, ...extra };
      });
      return json(res, { ok: true, sessions, total: listed?.result?.count || sessions.length, count: sessions.length, limit }, 200);
    } catch (e) {
      return json(res, {ok: false, error: e.message}, 500);
    }
  }
  // GET /api/pangu/agent/sessions/:id → 读单条 session
  if (pathname.startsWith('/api/pangu/agent/sessions/') && req.method === 'GET') {
    const sid = decodeURIComponent(pathname.slice('/api/pangu/agent/sessions/'.length));
    try {
      const sessionMod = require(path.join(__dirname, '..', '..', 'modules', 'session_store'));
      const result = await sessionMod.sessionLoad({ session_id: sid });
      if (!result.ok) return json(res, { ok: false, error: result.error?.code || 'NOT_FOUND', id: sid }, result.error?.code === 'INVALID_SESSION_ID' ? 400 : 404);
      return json(res, { ok: true, session: result.result, id: sid, degraded: Boolean(result.degraded) });
    } catch (e) {
      return json(res, {ok: false, error: e.message}, 500);
    }
  }
  // DELETE /api/pangu/agent/sessions/:id → 删除 session
  if (pathname.startsWith('/api/pangu/agent/sessions/') && req.method === 'DELETE') {
    const sid = decodeURIComponent(pathname.slice('/api/pangu/agent/sessions/'.length));
    try {
      const sessionMod = require(path.join(__dirname, '..', '..', 'modules', 'session_store'));
      const result = await sessionMod.sessionDelete({ session_id: sid });
      if (!result.ok) return json(res, { ok: false, error: result.error?.code || 'NOT_FOUND', id: sid }, result.error?.code === 'INVALID_SESSION_ID' ? 400 : 404);
      return json(res, { ok: true, deleted: sid });
    } catch (e) {
      return json(res, {ok: false, error: e.message}, 500);
    }
  }

    // /api/session/clear-all (frontend Storage.jsx 用)
  if (pathname === '/api/session/clear-all' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        let req_body;
        try { req_body = JSON.parse(body || '{}'); }
        catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
        const olderThanDays = req_body.older_than_days || 30;
        const sessionMod = require(path.join(__dirname, '..', '..', 'modules', 'session_store'));
        let list = [];
        if (sessionMod.sessionList) {
          const r = await sessionMod.sessionList({ limit: 200 });
          list = r?.result?.sessions || r?.sessions || [];
        }
        const cutoff = Date.now() - olderThanDays * 86400 * 1000;
        let removed = 0;
        for (const s of list) {
          const ts = s.last_updated || s.updated_at || s.created_at || s.ts || 0;
          if (ts < cutoff) {
            const sid = s.id || s.session_id || s.sessionId;
            try {
              if (sid) {
                const deleted = await sessionMod.sessionDelete({ session_id: sid });
                if (deleted?.ok) removed++;
              }
            } catch (_) {}
          }
        }
        return json(res, { ok: true, removed, total: list.length, olderThanDays });
      } catch (e) { return json(res, { ok: false, error: 'sessionClear 模块未找到: ' + e.message }, 501); }
    });
    return;
  }

  // /api/decide-all → /api/pangu/decide-all (frontend alias)
  if (pathname === '/api/decide-all' && req.method === 'POST') {
    // 透传 body 到 /api/pangu/decide-all
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        let req_body;
        try { req_body = JSON.parse(body || '{}'); }
        catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
        const inputs = Array.isArray(req_body.inputs) ? req_body.inputs : [req_body.input || req_body];
        const scenario = req_body.scenario || 'risk_assessment';
        const results = [];
        for (const inp of inputs) {
          try { results.push(await _deps.decideOne(scenario, String(inp))); }
          catch (e) { results.push({ ok: false, input: String(inp).slice(0, 200), scenario, error: e.message }); }
        }
        return json(res, { ok: true, count: results.length, results });
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }

  // /api/credentials → /api/credentials/list (frontend 别名)
  if (pathname === '/api/credentials' && req.method === 'GET') {
    try {
      const credMod = require(path.join(__dirname, '..', '..', 'modules', 'credentials'));
      // Keep the compatibility alias redacted just like /api/credentials/list.
      // The raw list() includes secret values and must never cross the HTTP boundary.
      const list = credMod.listPublic ? credMod.listPublic() : [];
      return json(res, { ok: true, credentials: list, count: list.length });
    } catch (e) { return json(res, { ok: true, credentials: [], count: 0, note: 'credentials 模块未加载: ' + e.message }); }
  }

  // 2026-09-18 修: 浏览器模式下 panguUrl 剥 /api 前缀 → 发 GET /pangu/permission/level (无 /api).
  // 加裸路径别名路由, 跟 /api/pangu/permission/level 共用同一处理逻辑.
  if (pathname === '/pangu/permission/level' && req.method === 'GET') {
    try {
      const permMod = require(path.join(__dirname, '..', '..', 'modules', 'permission'));
      const _q = new URL(req.url, 'http://localhost').searchParams;
      const sid = _q.get('sessionId') || _q.get('sid') || '';
      const levels = permMod.listLevels(sid || undefined);
      const current = permMod.getCurrentLevel(sid || undefined);
      return json(res, { ok: true, level: current, result: { levels, current, preset: permMod.levelToPreset(current), presets: permMod.PRESET_META, global: permMod.getCurrentLevel(), session_id: sid || null } });
    } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }

  // /api/pangu/permission/level (Permission.jsx + 聊天弹层 PermissionPopover 用)
  // 2026-09-14 修 (老板拍: 两个 UI 对应起来): 旧实现读写 permission_level.json 假状态 + 硬编码第二份词汇表,
  // 运行时真裁决走 permission.js 的 permission.json — UI 切级别运行时根本不看 = 假切换。委托真源:
  if (pathname === '/api/pangu/permission/level' && req.method === 'GET') {
    try {
      const permMod = require(path.join(__dirname, '..', '..', 'modules', 'permission'));
      const _q = new URL(req.url, 'http://localhost').searchParams;
      const sid = _q.get('sessionId') || _q.get('sid') || '';
      const levels = permMod.listLevels(sid || undefined);
      const current = permMod.getCurrentLevel(sid || undefined);
      return json(res, { ok: true, level: current, result: { levels, current, preset: permMod.levelToPreset(current), presets: permMod.PRESET_META, global: permMod.getCurrentLevel(), session_id: sid || null } });
    } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }
  // 2026-09-14 (老板拍: 自愈记录要主人可见): GET /api/pangu/self-repair — 事故账 + 修复账 + 统计
  // 2026-10-30 (第 172 批): 盘古自己的微信通道 —— 设置页「微信」分区要用。
  //   status: 绑定状态 / 最近收发 / 守护进程活没活
  //   send:   发一条测试消息 (证明这条链路此刻真的通)
  if (pathname === '/api/pangu/weixin/status' && req.method === 'GET') {
    try {
      const wx = require(path.join(__dirname, '..', '..', 'modules', 'weixin_channel'));
      const st = wx.status();
      // 守护进程 (常驻长轮询那个) 活没活 —— 靠 launchd 里的 PID 判断
      let daemon = { running: false, pid: null };
      try {
        const { execFileSync } = require('child_process');
        const out = String(execFileSync('/bin/sh', ['-c',
          "launchctl list 2>/dev/null | grep local.pangu-weixin || true"],
          { encoding: 'utf8', timeout: 3000 }) || '');
        const line = out.split('\n').find((l) => l.includes('local.pangu-weixin'));
        if (line) {
          const parts = line.trim().split(/\s+/);
          daemon = { running: true, pid: parts[0] && parts[0] !== '-' ? Number(parts[0]) : null };
        }
      } catch (_) { /* launchctl 查不到不算故障 */ }
      // 最近几条收发 (给界面看"到底通没通")
      let recent = [];
      try {
        const logFile = path.join(wx.configDir(), 'log.jsonl');
        const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
        recent = lines.slice(-12).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
          .filter(Boolean);
      } catch (_) {}
      return json(res, { ok: true, result: { status: st, daemon, recent } });
    } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }
  if (pathname === '/api/pangu/weixin/send' && req.method === 'POST') {
    try {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
      req.on('end', async () => {
        try {
          const body = raw ? JSON.parse(raw) : {};
          const wx = require(path.join(__dirname, '..', '..', 'modules', 'weixin_channel'));
          const sent = await wx.sendText({
            to: body.to && String(body.to).trim() ? String(body.to).trim() : undefined,
            text: String(body.text || ''),
          });
          if (!sent.ok) return json(res, { ok: false, error: sent.error, message: sent.message }, 400);
          return json(res, { ok: true, result: sent });
        } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
      });
    } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    return;
  }
  if (pathname === '/api/pangu/self-repair' && req.method === 'GET') {
    try {
      const sr = require(path.join(__dirname, '..', '..', 'modules', 'self_repair'));
      const incidents = sr.listIncidents(100);
      const repairs = sr.listRepairs(100);
      const okCount = repairs.filter(r => r.ok).length;
      // 2026-09-14 (#10): 每日守卫审计栏 — guard_audit.js 每次跑都落 guard_audit_last.json
      let guard_audit = null;
      try {
        const gaPath = path.join(process.env.PANGU_HOME || path.join(os.homedir(), '.pangu'), 'state', 'self_repair', 'guard_audit_last.json');
        guard_audit = JSON.parse(fs.readFileSync(gaPath, 'utf8'));
      } catch (_) { /* 从未跑过 → null, 前端显示"未跑过" */ }
      return json(res, { ok: true, result: {
        incidents, repairs, guard_audit,
        stats: {
          incidents_total: incidents.length,
          repairs_total: repairs.length,
          repairs_ok: okCount,
          repairs_failed: repairs.length - okCount,
          last_incident: incidents.length ? incidents[incidents.length - 1].ts : null,
          last_repair: repairs.length ? repairs[repairs.length - 1].ts : null,
        },
      } });
    } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }
  // 2026-09-18: PUT 裸路径别名 (浏览器模式剥 /api)
  if (pathname === '/pangu/permission/level' && req.method === 'PUT') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let req_body;
      try { req_body = JSON.parse(body || '{}'); }
      catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
      try {
        const level = req_body.level || req_body.id || 'default';
        const permMod = require(path.join(__dirname, '..', '..', 'modules', 'permission'));
        const r = permMod.setCurrentLevel(level, { scope: req_body.scope, sessionId: req_body.sessionId });
        if (!r.ok) return json(res, { ok: false, error: r.error }, 400);
        const sid = r.scope === 'session' ? r.session_id : '';
        return json(res, { ok: true, level: r.current, result: { current: r.current, scope: r.scope, session_id: r.session_id || null, expires_at: r.expires_at || null, preset: permMod.levelToPreset(r.current), levels: permMod.listLevels(sid || undefined) } });
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }

  if (pathname === '/api/pangu/permission/level' && req.method === 'PUT') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let req_body;
      try { req_body = JSON.parse(body || '{}'); }
      catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
      try {
        const level = req_body.level || req_body.id || 'default';
        // 2026-09-14: scope/sessionId 不再被无视 — 聊天弹层"仅本次对话"真写 session override (24h TTL)
        const permMod = require(path.join(__dirname, '..', '..', 'modules', 'permission'));
        const r = permMod.setCurrentLevel(level, { scope: req_body.scope, sessionId: req_body.sessionId });
        if (!r.ok) return json(res, { ok: false, error: r.error }, 400);
        const sid = r.scope === 'session' ? r.session_id : '';
        return json(res, { ok: true, level: r.current, result: { current: r.current, scope: r.scope, session_id: r.session_id || null, expires_at: r.expires_at || null, preset: permMod.levelToPreset(r.current), levels: permMod.listLevels(sid || undefined) } });
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }

  // /api/pangu/agent/permission/pending + respond (Permission.jsx 用)
  if (pathname === '/api/pangu/agent/permission/pending' && req.method === 'GET') {
    // 读 in-memory queue (permission_apply 推过来)
    try {
      const permMod = require(path.join(__dirname, '..', '..', 'modules', 'permission'));
      const pending = permMod._pendingList ? permMod._pendingList() : [];
      return json(res, { ok: true, pending, count: pending.length });
    } catch (e) { return json(res, { ok: true, pending: [], count: 0, note: 'permission 模块未加载: ' + e.message }); }
  }
  if (pathname === '/api/pangu/agent/permission/respond' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let req_body;
      try { req_body = JSON.parse(body || '{}'); }
      catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
      try {
        const permMod = require(path.join(__dirname, '..', '..', 'modules', 'permission'));
        const r = permMod._respond ? permMod._respond(req_body) : { ok: true, note: 'noop' };
        return json(res, { ok: true, ...r });
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }

  // ===== MCP DELETE /api/mcp/servers/:name (frontend mcpDelete 用) =====
  if (pathname.startsWith('/api/mcp/servers/') && req.method === 'DELETE') {
    const name = decodeURIComponent(pathname.slice('/api/mcp/servers/'.length));
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const cfgPath = path.join(__dirname, '..', '..', 'config', 'mcp_servers.json');
        let cfg = { servers: [] };
        try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) {}
        const before = cfg.servers.length;
        cfg.servers = cfg.servers.filter(s => s.name !== name);
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
        return json(res, { ok: true, removed: before - cfg.servers.length, name });
      } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }

  if (pathname === '/api/credentials/list' && req.method === 'GET') {
    try {
      const credMod = require(path.join(__dirname, '..', '..', 'modules', 'credentials'));
      const list = credMod.listPublic ? credMod.listPublic() : [];
      return res.end(JSON.stringify({ok: true, credentials: list, count: list.length}));
    } catch (e) {
      return res.end(JSON.stringify({ok: true, credentials: [], count: 0, note: 'credentials 模块加载失败: ' + e.message}));
    }
  }

 // §0.22 Pangu Skills (用户自建 skill) — 之前端 7 个 API 都 404, 这里一次性补齐
  // 数据落 config/pangu_skills.json, 失败返回空列表 (跟现有 modules/skills/hexagrams 同风格 stub)
  function _readPanguSkills() {
    try {
      const p = path.join(os.homedir(), '.pangu', 'config', 'pangu_skills.json');
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
      return [];
    } catch (_) { return []; }
  }
  function _writePanguSkills(arr) {
    try {
      const dir = path.join(os.homedir(), '.pangu', 'config');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'pangu_skills.json'), JSON.stringify(arr, null, 2));
      return true;
    } catch (_) { return false; }
  }
  if (pathname === '/api/pangu/models' && req.method === 'GET') {
 // 任务1a: ChatRoom.jsx fetch /api/pangu/models 一直 404, 补这个接口
 // R88: config 里的 context_length 启动时已清掉 (registry 是唯一运行时真源),
 // 这里把 registry 探得的值合并回去, 前端空闲态底栏才能显示 窗口.
    const models = ((_config.llm && _config.llm.models) || []).map(mm => {
      if (mm && mm.id && typeof mm.context_length !== 'number') {
        const v = require('../../modules/model_registry').getContextLength(mm.id);
        if (v) mm = { ...mm, context_length: v };
      }
      return _publicModel(mm);
    });
    return res.writeHead(200, {'Content-Type': 'application/json'})
      && res.end(JSON.stringify({
        ok: true,
        models,
        default_model: _publicModel(getCurrentModel()),     // 兼容旧前端
        current_model_id: _config.llm && _config.llm.current_model_id
      }));
  }
 // N5 fix #15: /sessions — 读 ~/.pangu/memory/memory/sessions/*.md 列表 (UI 要历史会话)
  if (pathname === '/sessions' && req.method === 'GET') {
    try {
      const os = require('os');
      const path = require('path');
      const fs = require('fs');
      const sessDir = path.join(os.homedir(), '.pangu', 'memory', 'memory', 'sessions');
      const list = [];
      if (fs.existsSync(sessDir)) {
        for (const f of fs.readdirSync(sessDir).filter(x => x.endsWith('.md')).sort().reverse()) {
          try {
            const stat = fs.statSync(path.join(sessDir, f));
            const date = f.replace(/\.md$/, '');
            // 读首页预览 (前 400 chars)
            const preview = fs.readFileSync(path.join(sessDir, f), 'utf8').slice(0, 400);
            list.push({ date, file: f, size: stat.size, mtime: stat.mtimeMs, preview });
          } catch (_) {}
        }
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ok: true, sessions: list, count: list.length}));
    } catch (e) {
      res.writeHead(500, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ok: false, error: e.message}));
    }
  }
  if (pathname === '/api/pangu/skills/create-from-form' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let req_body;
      try { req_body = JSON.parse(body || '{}'); }
      catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
      try {
        if (!req_body.name || typeof req_body.name !== 'string' || !req_body.name.trim()) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ok: false, error: 'name is required'}));
        }
        if (!req_body.command || typeof req_body.command !== 'string' || !req_body.command.trim()) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ok: false, error: 'command is required'}));
        }
        // 2026-10-20 修: 原来这里把表单内容整个丢了 —— 前端发的是平铺对象
        // {name, description, transport, command, args}, 后端只读 req_body.spec
        // (永远 undefined → spec:{}), 所以 description/command/args 全丢;
        // 还不落任何 SKILL.md, 只往账本塞一条 {name, spec:{}} 空壳。
        // 结果: 界面「创建成功」, 列表里永远不出现 (前端按 source==='pangu-form' 筛,
        // 而这个接口只会吐 'dir'/'config'), 账本里还留一条界面看不到、也删不掉的幽灵条目。
        // 现在: 落一份真 SKILL.md 到 ~/.pangu/skills/<name>/ —— agent 的 skill_use 扫的就是这个目录,
        // frontmatter 标 source: pangu-form, 「自建」筛选认这个标记。
        const fs = require('fs'), path = require('path'), os = require('os');
        const rawName = String(req_body.name).trim();
        const safeName = rawName.replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();
        if (!safeName) { res.writeHead(400, {'Content-Type': 'application/json'}); return res.end(JSON.stringify({ok: false, error: 'invalid name'})); }
        const dir = path.join(os.homedir(), '.pangu', 'skills', safeName);
        if (fs.existsSync(dir)) { res.writeHead(409, {'Content-Type': 'application/json'}); return res.end(JSON.stringify({ok: false, error: 'ALREADY_EXISTS', name: safeName})); }
        const oneLine = (s) => String(s == null ? '' : s).replace(/\s*\n+\s*/g, ' ').trim();
        const spec = {
          name: oneLine(rawName),
          description: oneLine(req_body.description) || `${oneLine(rawName)} (自建 skill)`,
          command: oneLine(req_body.command),
          args: Array.isArray(req_body.args) ? req_body.args.filter(a => a !== '' && a != null) : (req_body.args ? oneLine(req_body.args).split(/\s+/).filter(Boolean) : []),
          transport: oneLine(req_body.transport) || 'stdio',
          env: (req_body.env && typeof req_body.env === 'object') ? req_body.env : null,
        };
        const frontmatter = [
          '---',
          `name: ${spec.name}`,
          `description: ${spec.description}`,
          `command: ${spec.command}`,
          `args: ${JSON.stringify(spec.args)}`,
          `transport: ${spec.transport}`,
          'source: pangu-form',
          spec.env ? `env: ${JSON.stringify(spec.env)}` : null,
          '---',
        ].filter(Boolean).join('\n');
        const skillMd = frontmatter + '\n\n' + (oneLine(req_body.longDescription) || spec.description) + '\n';
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd, 'utf8');
        const newSkill = { name: safeName, path: dir, source: 'pangu-form' };
        const wrote = true;
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ok: wrote, created: newSkill}));
      } catch (e) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ok: false, error: e.message}));
      }
    });
    return;
  }
  if (pathname === '/api/pangu/skills/import-from-path' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let req_body;
      try { req_body = JSON.parse(body || '{}'); }
      catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
      try {
        const sourcePath = String(req_body.path || '').trim();
        if (!sourcePath) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ok: false, error: 'path is required'}));
        }
        if (!fs.existsSync(sourcePath)) {
          res.writeHead(404, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ok: false, error: 'path does not exist'}));
        }
        const skills = _readPanguSkills();
        const newSkill = {
          id: 'skill_path_' + Date.now(),
          name: require('path').basename(sourcePath),
          source_path: sourcePath,
          created_at: new Date().toISOString(),
        };
        skills.push(newSkill);
        const wrote = _writePanguSkills(skills);
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ok: wrote, imported: newSkill}));
      } catch (e) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ok: false, error: e.message}));
      }
    });
    return;
  }
  if (pathname === '/api/pangu/skills/import-from-url' && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let req_body;
      try { req_body = JSON.parse(body || '{}'); }
      catch (_) { res.writeHead(400, {'Content-Type': 'application/json'}); return res.end(JSON.stringify({ ok: false, error: 'INVALID_JSON' })); }
      try {
        if (!req_body.url || typeof req_body.url !== 'string') {
          res.writeHead(400, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ok: false, error: 'missing url field'}));
        }
        let urlObj;
        try { urlObj = new URL(req_body.url); } catch (e) {
          res.writeHead(400, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ok: false, error: 'invalid url: ' + e.message}));
        }
        if (!['http:', 'https:'].includes(urlObj.protocol)) {
          res.writeHead(400, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ok: false, error: 'only http/https allowed'}));
        }
        const outbound = await validateOutboundUrl(req_body.url);
        if (!outbound.ok) {
          res.writeHead(400, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ ok: false, error: outbound.error }));
        }
        // 拉 URL 内容 (skill spec), 5s timeout
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        let content;
        try {
          const r = await fetch(req_body.url, { redirect: 'error', signal: controller.signal, headers: { 'User-Agent': 'pangu-skill-importer/1.0' } });
          content = await r.text();
        } catch (e) {
          clearTimeout(timer);
          res.writeHead(502, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({ok: false, error: 'fetch failed: ' + e.message}));
        }
        clearTimeout(timer);
        // 解析 spec (假设 JSON)
        let spec;
        try { spec = JSON.parse(content); } catch (_) { spec = { raw: content.slice(0, 5000) }; }
        const skillName = (spec && spec.name) || path.basename(urlObj.pathname) || 'imported_skill';
        const skills = _readPanguSkills();
        const newSkill = {
          id: 'skill_url_' + Date.now(),
          name: skillName,
          source_url: req_body.url,
          spec,
          created_at: new Date().toISOString(),
        };
        skills.push(newSkill);
        _writePanguSkills(skills);
        return res.end(JSON.stringify({ok: true, imported: newSkill, total: skills.length}));
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ok: false, error: e.message}));
      }
    });
    return;
  }
  if ((pathname.startsWith('/api/pangu/skills/') && pathname.endsWith('/convert-to-mcp')) && req.method === 'POST') {
    // This route used to mark a skill as converted without creating or
    // connecting an MCP server. Keep the API explicit until real generation
    // and registration are implemented; never persist a false success state.
    res.writeHead(501, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ ok: false, error: 'MCP_CONVERSION_NOT_IMPLEMENTED', message: 'Pangu skill 转 MCP 尚未接入真实 server 生成与连接' }));
  }
  if (pathname.startsWith('/api/pangu/skills/') && pathname.split('/').length === 5 && req.method === 'DELETE') {
    // DELETE /api/pangu/skills/<id>
    const idOrName = pathname.split('/')[4];
    const skills = _readPanguSkills();
    const before = skills.length;
    const filtered = skills.filter(s => s.id !== idOrName && s.name !== idOrName);
    const deleted = before - filtered.length;
    _writePanguSkills(filtered);
    // 2026-10-20 修: 自建 skill 真正落在 ~/.pangu/skills/<name>/, 删除必须连目录一起删 ——
    // 原来只过滤账本, 磁盘上的 SKILL.md 留着, 界面里还在, agent 也照样能读到。
    let removedDir = null;
    try {
      const fs = require('fs'), path = require('path'), os = require('os');
      const safe = String(idOrName).replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();
      const dir = path.join(os.homedir(), '.pangu', 'skills', safe);
      if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); removedDir = dir; }
    } catch (_) {}
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ok: true, deleted, removedDir, target: idOrName}));
  }

 // /api/credentials/set, toggle, remove — wired to 真 credentials 模块 (2026-08-22)
  if (pathname === '/api/credentials/set' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        let req_body;
        try { req_body = JSON.parse(body || '{}'); }
        catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
        if (!req_body.name || typeof req_body.value !== 'string') {
          return json(res, {ok: false, error: 'missing name or value'}, 400);
        }
        const credMod = require(path.join(__dirname, '..', '..', 'modules', 'credentials'));
        credMod.set(req_body.name, req_body.value, {
          note: req_body.note || '',
          enabled: req_body.enabled !== false
        });
        return res.end(JSON.stringify({ok: true, name: req_body.name, set: true}));
      } catch (e) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ok: false, error: e.message}));
      }
    });
    return;
  }
  if (pathname === '/api/credentials/toggle' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        let req_body;
        try { req_body = JSON.parse(body || '{}'); }
        catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
        const credMod = require(path.join(__dirname, '..', '..', 'modules', 'credentials'));
        const r = credMod.toggle(req_body.name, !!req_body.enabled);
        return res.end(JSON.stringify({ok: true, name: req_body.name, enabled: r ? r.enabled : !!req_body.enabled}));
      } catch (e) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ok: false, error: e.message}));
      }
    });
    return;
  }
  if (pathname === '/api/credentials/remove' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        let req_body;
        try { req_body = JSON.parse(body || '{}'); }
        catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
        const credMod = require(path.join(__dirname, '..', '..', 'modules', 'credentials'));
        const r = credMod.remove(req_body.name);
        return res.end(JSON.stringify({ok: true, removed: req_body.name, existed: !!r}));
      } catch (e) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ok: false, error: e.message}));
      }
    });
    return;
  }

  if (pathname === '/api/pangu/memory/list' && req.method === 'GET') {
    try {
      const os = require('os');
      const path = require('path');
      const fs = require('fs');
      const memRoot = path.join(os.homedir(), '.pangu', 'memory');
      const SKIP_DIRS = new Set(['main.sqlite','main.sqlite-shm','main.sqlite-wal','scripts','registry','tasks','pangu_tasks','workspace','evomap','.learnings','logs','pangu_credentials.json','pangu_evolution','evolution']);
      function walkMd(dir, acc) {
        if (!fs.existsSync(dir)) return acc;
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          if (item.isDirectory()) {
            if (SKIP_DIRS.has(item.name)) continue;
            walkMd(path.join(dir, item.name), acc);
          } else if (item.isFile() && item.name.endsWith('.md')) {
            const fp = path.join(dir, item.name);
            const stat = fs.statSync(fp);
            acc.push({
              path: path.relative(memRoot, fp),
              size: stat.size,
              mtime: Math.floor(stat.mtimeMs),
              modified: stat.mtime.toISOString()
            });
          }
        }
        return acc;
      }
      let files = walkMd(memRoot, []).sort((a, b) => b.mtime - a.mtime);
 // 修: memory/sessions 只显示最近 30 天; MEMORY.md 始终显示
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - 30);
      const cutoffMs = cutoff.getTime();
      files = files.filter(f => {
        if (f.path === 'MEMORY.md') return true;
        if (f.path.startsWith('memory/sessions/') && f.path.endsWith('.md')) {
          const m = f.path.match(/memory\/sessions\/(\d{4}-\d{2}-\d{2})\.md$/);
          if (!m) return true;
          // 按文件名日期过滤，比 mtime 更稳
          const date = new Date(m[1] + 'T00:00:00Z').getTime();
          return date >= cutoffMs;
        }
        return true;
      });
      res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
      return res.end(JSON.stringify({ ok: true, root: memRoot, files }));
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, {'Content-Type': 'application/json'});
      }
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // GET /api/pangu/memory/read?path=xxx → 读 .md 内容
  if (pathname === '/api/pangu/memory/read' && req.method === 'GET') {
    try {
      const os = require('os');
      const path = require('path');
      const fs = require('fs');
      const urlObj = new URL(req.url, 'http://localhost');
      const relPath = urlObj.searchParams.get('path');
      if (!relPath) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ ok: false, error: 'NO_PATH' }));
      }
      // 安全: 只允许 .md, 阻止 path traversal
      if (relPath.includes('..') || !relPath.endsWith('.md')) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ ok: false, error: 'INVALID_PATH' }));
      }
      const memRoot = path.join(os.homedir(), '.pangu', 'memory');
      const fp = path.join(memRoot, relPath);
      if (!fs.existsSync(fp)) {
        res.writeHead(404, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }));
      }
      const content = fs.readFileSync(fp, 'utf8');
      const stat = fs.statSync(fp);
 // 防卡死: 5MB+ 文件后端不返 content (避免 freeze HTTP response)
      const HARD_LIMIT = 5 * 1024 * 1024;
      if (stat.size > HARD_LIMIT) {
        res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
        return res.end(JSON.stringify({
          ok: true,
          path: relPath,
          content: null,         // 故意 null, 让前端知道不返
          size: stat.size,
          mtime: Math.floor(stat.mtimeMs),
          modified: stat.mtime.toISOString(),
          tooLarge: true,
          message: '文件过大 (超过 5MB), 仅返 metadata, 不读内容以防卡死'
        }));
      }
      res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
      return res.end(JSON.stringify({
        ok: true,
        path: relPath,
        content,
        size: stat.size,
        mtime: Math.floor(stat.mtimeMs),
        modified: stat.mtime.toISOString()
      }));
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, {'Content-Type': 'application/json'});
      }
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

 // PATCH /api/config — 同源放行 / 跨域拒 + body limit + 白名单字段
  if ((pathname === '/config' || pathname === '/api/config') && req.method === 'PATCH') {
    if (!checkLocalOrigin(req, res)) return;  // 跨域已写 403
    readJsonBody(req, res, (err, updates) => {
      if (err) {
        if (!res.headersSent) res.writeHead(400, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ok: false, error: err.message || 'BAD_BODY'}));
      }
      // 白名单字段, 防 _config 被任意篡改
      const ALLOWED = ['openai_base_url', 'openai_model', 'temperature', 'searxng_base_url', 'agent_default_model', 'agent', 'voice'];
      const safe = {};
      for (const k of Object.keys(updates || {})) {
        if (ALLOWED.includes(k)) safe[k] = updates[k];
      }
      // llm 字段走 _config.llm, agent 字段走 _config.agent 深合并
      const { agent, voice, ...llmSafe } = safe;
      // Keep the injected config object identity. pangu_helpers/saveConfig and
      // the model router retain this same object reference; replacing it here
      // made a voice save write an old snapshot and roll back model changes.
      _config.llm = _config.llm || {};
      Object.assign(_config.llm, llmSafe);
      if (voice && typeof voice === 'object' && !Array.isArray(voice)) {
        const prevVoice = (_config.voice && typeof _config.voice === 'object') ? _config.voice : {};
        const voiceSafe = { ...voice };
        // Public config responses mask secrets. Saving that mask must preserve
        // the existing secret instead of replacing it with the literal '***'.
        for (const key of ['stt_api_key', 'tts_api_key']) {
          if (voiceSafe[key] === '***') delete voiceSafe[key];
          // 2026-10-26 (第 110 批): 真 key ⇒ 存凭证库 (STT_API_KEY / TTS_API_KEY),
          //   配置里只留 <key>_credential 引用。明文不落项目目录。
          else if (voiceSafe[key]) {
            const _vn = key.toUpperCase();
            try {
              const _scan = require('../../modules/secret_scan');
              if (_scan.looksLikeSecret(voiceSafe[key], key)) {
                const _cr = require('../../modules/credentials').set(_vn, voiceSafe[key]);
                if (_cr && _cr.ok) {
                  voiceSafe[key] = '';
                  voiceSafe[key + '_credential'] = _vn;
                }
              }
            } catch (e) { console.warn('[credentials] voice 密钥收编失败:', e.message); }
          }
        }
        _config.voice = prevVoice;
        Object.assign(_config.voice, voiceSafe);
      }
      // agent.role_configs 深合并 (保 server 默认字段, 只覆 frontend 送来的)
      if (agent && typeof agent === 'object') {
        if (!_config.agent) _config.agent = {};
        if (agent.role_configs && typeof agent.role_configs === 'object') {
          if (!_config.agent.role_configs || typeof _config.agent.role_configs !== 'object') _config.agent.role_configs = {};
          const SUB_AGENT_IDS = ['qian', 'kun', 'zhen', 'xun', 'kan', 'li', 'gen', 'dui'];
          for (const id of SUB_AGENT_IDS) {
            if (agent.role_configs[id] && typeof agent.role_configs[id] === 'object') {
              _config.agent.role_configs[id] = { ...(_config.agent.role_configs[id] || {}), ...agent.role_configs[id] };
              // 2026-10-17: per-role 模型字段是死字段, 保存时必须拒收。
              // 光改 role_model.js 不够 —— 浏览器里可能还缓存着旧版设置页(那个下拉框
              // 直到上次构建才消失), 它照样会往这里 POST model。写进来就是一条
              // "配了但不生效" 的脏数据, 下次开机又被 guard 当死字段删, 主人两头懵。
              delete _config.agent.role_configs[id].model;
            }
          }
        }
        // 其他 agent 顶层字段也浅合并 (future-proof)
        for (const k of Object.keys(agent)) {
          if (k === 'role_configs') continue;
          _config.agent[k] = agent[k];
        }
      }
      saveConfig();
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ok: true, data: _publicConfig(_config), applied: Object.keys(safe)}));
    });
    return;
  }

  // ==================== 聊天流式接口 (SSE) ====================
  if ((pathname === '/message/stream' || pathname === '/api/message/stream') && req.method === 'POST') {
 // SSE 连接数限流 — 满了返 429
    if (!_tryAcquireSseSlot(res)) return;
    let sseSlotReleased = false;
    const releaseSseSlotOnce = () => {
      if (sseSlotReleased) return;
      sseSlotReleased = true;
      _releaseSseSlot();
    };
    res.on('close', releaseSseSlotOnce);
    res.on('error', releaseSseSlotOnce);
 // 主对话流必须接 J2 agent-loop — 派工具调路径（拒绝空话）
 // N5 B3-Phase 3: j2_agent_loop._runAgentLoopLegacyStream 从外部传
    const handler = require('./message-stream').makeHandler({
      getDefaultModel,
      callLLM,
      callLLMRouter,
      extractContent,
      // 2026-10-27 (第 112 批): 正文/只回思考/截断 三个事实 (见 message-stream 里的用法)
      extractAnswer,
      _recordSessionToMemory,
      runAgentLoop: j2AgentLoop._runAgentLoopLegacyStream,
      smartRoute: smartRouter.route,
      _config
    });
    return handler(req, res);
  }

  // ==================== 聊天非流式接口 (/message 兼容) ====================
  if ((pathname === '/message' || pathname === '/chat' || pathname === '/api/chat') && req.method === 'POST') {
    // 2026-07-28 fix: 老路径调 callLLMRouter 失败 "all 4 models failed"
    // (Router 用 modules/router/models.json 配置，跟 _config.llm.models 不是同一源，
    //  Router 模型表里那 4 个 id 都是 daemon _config 里的, endpoint 路径在 router 里是错的)。
    // 修：跟 /api/message/stream 对齐 — body 限 1MB。
    // ⚠ 2026-10-26 (第 106 批) 更正: **默认走单次 callLLM**(不是 run_j2)。
    //   老注释写的「默认 run_j2: true 走 J2 loop(已验证工作)」**从写下那天起就是假的** ——
    //   源码里是 `if (false && runJ2 && …)`, 那条路从未执行过。
    //   现在默认 = 单发快路径; `run_j2: true` 显式要才走 agent loop;
    //   单发拿到工具草稿/空 ⇒ 自动**升级**到 agent loop (见下面「升级阶梯」)。
    //     兼容旧前端：仍返 {ok, choices: [{message: {role, content}}]}。
    const MAX_BODY_BYTES = 1 * 1024 * 1024;
    let body = '';
    let bodyAborted = false;
    req.on('data', chunk => {
      if (bodyAborted) return;
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        bodyAborted = true;
        if (!res.headersSent) res.writeHead(413, { 'Content-Type': 'application/json' });
        try { res.end(JSON.stringify({ ok: false, error: 'BODY_TOO_LARGE' })); } catch (_) {}
        try { req.destroy(); } catch (_) {}
      }
    });
    req.on('end', async () => {
      if (bodyAborted) return;
      try {
        const req_body = JSON.parse(body);
        const messages = req_body.messages || [];
        // input 缺失时(前端 api.chat 只传 messages), 用最后一条 user 消息做 guardAnswer
        // 对齐基准, 否则 userInput='' 让 guard 失效, 英文/工具残留会直接透给用户。
        const _lastUserMsg = [...messages].reverse().find(m => m && m.role === 'user' && typeof m.content === 'string');
        // `message`(单数) 收作别名: 它是最容易顺手写出来的字段名, 与其为之一刀切 400,
        // 不如直接认下来 —— 代价只有一行, 省掉的是"我到底该传哪个 key"的来回。
        const userInput = req_body.input || req_body.message
          || (_lastUserMsg ? _lastUserMsg.content : '');
        // 2026-10-15 修: payload 字段名写错时 (最常见: 传 `message` 而不是 `messages`/`input`),
        // 以前这里 userInput='' 照发 —— 拿一个**空对话**去调 LLM, 白烧一整轮往返,
        // 换来 LM Studio 一句 "No user query found in messages", 排查时完全看不出是自己字段拼错了。
        // 现在就地 400, 并把"我收到了什么"一起说清楚。
        if (!userInput || !String(userInput).trim()) {
          res.writeHead(400, {'Content-Type': 'application/json; charset=utf-8'});
          return res.end(JSON.stringify({
            ok: false,
            error: 'USER_MESSAGE_REQUIRED',
            hint: 'body 需要 messages:[{role:"user",content:"..."}], 或 input:"...", 或 message:"..." (三者任一)',
            received_keys: Object.keys(req_body),
          }));
        }
        if (userInput && (!messages.length || messages[messages.length - 1].content !== userInput)) {
          messages.push({ role: 'user', content: userInput });
        }
        // 2026-07-28 v2 简化：/message 老路径默认退化成单次 callLLM（快速问答），
        //   前端需要 tool 时显式 run_j2: true。
        //
        // 2026-10-26 (第 106 批): run_j2 这条路**从写下那天起就没执行过** ——
        //   源码里是 `if (false && runJ2 && …)`, 而那段收集器认的事件名还是老的
        //   (`event: chunk`), 真实契约是 `event: stream_delta` / `event: final`
        //   ⇒ 就算把它打开, 收到的也只会是空字符串。今天真正接上。
        const runJ2 = req_body.run_j2 === true;
        // 「要 JSON 不要 SSE」的端点需要一个能把 agent loop 的 SSE 收成文本的收集器。
        //   契约归 modules/sse_text_collector.js (事件名/取值顺序是**契约**, 不该埋在 handler 里);
        //   端点只负责「拿到文本之后怎么办」。
        const _runAgentLoopAsText = async () => {
          if (typeof j2AgentLoop._runAgentLoopLegacyStream !== 'function') {
            return { text: '', error: 'AGENT_LOOP_UNAVAILABLE' };
          }
          const collector = createSseCollector();
          const model = getDefaultModel();
          // 给 agent loop 一份 req_body 的**副本**: 它内部会往 reqBody 上挂东西,
          // 而 req_body 后面还要交给 _recordSessionToMemory —— 让它改原对象会污染记忆落盘。
          const _reqBodyCopy = Object.assign({}, req_body);
          // ⚠ **session 隔离** (2026-10-26 第 106 批补, 交叉审抓到的 P1):
          //   agent loop 的 sessionId 兜底是 `'default'` (j2_agent_loop.js:818),
          //   而**同 session 来新请求会把上一个正在跑的 loop 当场 abort**
          //   (j2_agent_loop.js:1047 `activeAbort.abort('user_switched')`),
          //   session state 还是模块级 Map ⇒ 匿名请求之间会互相掐断 + 串味
          //   (planState / fountainRepeat / lastRoundText)。
          //   ⇒ 客户端**显式给了** session_id 就尊重它 (连续性照旧);
          //   **没给**就走一次性 id (每个请求一个) ⇒ 匿名请求互不干扰。
          const _sessionId = resolveChatSessionId({ explicitSessionId: req_body.session_id });
          try {
            await j2AgentLoop._runAgentLoopLegacyStream(messages, model, req, collector.res,
              { userInput, reqBody: _reqBodyCopy, sessionId: _sessionId });
          } catch (e) {
            return {
              text: collector.getText(),
              error: collector.getError() || (e && e.message) || String(e),
              status: collector.getStatus(),
            };
          }
          return { text: collector.getText(), error: collector.getError(), status: collector.getStatus() };
        };

        if (runJ2) {
          const _j2 = await _runAgentLoopAsText();
          const _j2Text = String(_j2.text || '').trim();
          // ⚠ **不要在这里记记忆** (2026-10-26 第 106 批补, 交叉审抓到的 P1):
          //   agent loop 出口**自己**已经记了一遍 (j2_agent_loop.js:6003
          //   `_deps._recordSessionToMemory(opts.reqBody, finalText, model.id)`)。
          //   两处都记 ⇒ 同一个回合在 memory 里落**两条**
          //   (先一条 Pangu 为空、后一条才是真答案) ⇒ 语义召回把主人的话喂回两遍。
          //   ⇒ 一条路径只留**一个**记录者: 走 agent loop 的由 loop 记, 快路径由本端点记。
          // ⚠ 不变量「答复永不为空」**只有一个收口点** (decideChatAnswer) ——
          //   run_j2 分支也走它, 别在这儿自己拼 `|| NO_ANSWER_TEXT` (两处兜底必然漂移)。
          const _j2Decided = decideChatAnswer({
            guardedText: '',
            guardedBlocked: false,
            escalatedText: _j2Text,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            ok: true,
            choices: [{ message: { role: 'assistant', content: _j2Decided.content } }],
            // ⚠ **状态与错误说明分两个字段**: loop 没调 task_done 时 verdict 也是 'failed'
            //   (完成度不足), 但正文可能是好的 —— 报成 agent_error 会误导客户端。
            ...(_j2.status ? { agent_status: _j2.status } : {}),
            // ⚠ agent_error 只在**真失败**时带 (状态喷泉守卫可能先发 error 再跑成功)。
            ...(_j2.error && _j2.status !== 'done'
              ? { agent_error: String(_j2.error).slice(0, 500) } : {}),
          }));
        }
        // 退化路径：callLLM 返回 Promise<OpenAI JSON response> (非 streaming).
        // 修 2026-07-28: 已把 callLLM 内 stream:true 改成 stream:false, 现在能正常 JSON.parse.
        // extractContent 已加 reasoning_content fallback (qwen3.6 reasoning 模型 content 为空, 在 reasoning_content).
        // 2026-09-22 fix: /chat 显式取当前模型, 验证 id 存在再调 callLLM
        // (之前 callLLM 内部 getDefaultModel 取到的对象偶发缺 id → model.id required)
        const _curModel = (typeof getCurrentModel === 'function') ? getCurrentModel() : null;
        if (!_curModel || !_curModel.id) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: '当前模型不可用: ' + JSON.stringify(_curModel ? { name: _curModel.name, provider: _curModel.provider } : 'null') }));
        }
        // 请求级超时/输出上限覆盖: 长解读类请求需要更大 timeout, 但也必须限制
        // max_tokens, 否则模型生成到 provider 上限(16384)才停, 又慢又超长。
        const requestedTimeout = Number(req_body.timeout_ms);
        const requestedMaxTokens = Number(req_body.max_tokens);
        const _chatModel = { ..._curModel };
        if (Number.isFinite(requestedTimeout) && requestedTimeout > 0) {
          _chatModel.timeout_ms = Math.min(Math.max(requestedTimeout, 1000), 300000);
        }
        if (Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0) {
          _chatModel.max_tokens = Math.min(Math.max(requestedMaxTokens, 256), 32000);
        }
        //
        // 2026-10-27 (第 112 批): **请求级推理强度**。
        //
        // 实测 (MiniMax-M3.1-Flash + 九节八字解读提示, 直连):
        //   不带 reasoning_effort → 思考 25300 token, 正文 3594 字, **171 秒**
        //   reasoning_effort=low  → 思考  2472 token, 正文 4222 字, **42 秒**
        // 同一份提示, 思考少 ⇒ 更快 + 正文更长。默认强度对「写一篇长文」这种
        // 任务是**病态**的 (想 2.5 万 token 才落笔)。
        //
        // ⇒ 客户端可以显式说「这轮少想点」。白名单只收 OpenAI 规范里的档位;
        //   'auto' 是界面占位符不是 API 值 (发过去 LM Studio 直接 400);
        //   'none'/'off' 是「关掉思考」, 云端网关常收 ⇒ **不收** (本地模型走
        //   模型条目上的 reasoning_effort, 不走这条通道)。
        const _effortRaw = String(req_body.reasoning_effort || '').trim().toLowerCase();
        const _effort = ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(_effortRaw) ? _effortRaw : null;
        if (_effort) _chatModel.reasoning_effort = _effort;
        //
        // 2026-10-27 (第 112 批): **推理模型的输出预算有下限**。
        //
        // 现场 (2026-10-26 老板贴的八字排盘 AI 解读): 旧前端只给 6500 token,
        // MiniMax-M3.1-Flash 的思考就把这个额度吃干净 ⇒ 正文一个字都没有 ⇒
        // 旧代码 extractContent 拿 reasoning_content 顶上去 ⇒ 主人看到的是
        // 模型的英文自说自话, 九节只剩四个标题。
        // 实测: 6500 → 正文空; 16384 → 正文 3396 字, 九节全齐。
        // ⇒ 客户端的「我只要 3000 字」不能直接当**输出预算**: 推理模型得先
        //    交过路费 (思考), 剩下的才是正文。规则本体在 chat_answer_policy
        //    (纯函数, 有测试), 这里只负责取真源。
        let _hardCap = null;
        try {
          const _mc = require('../../modules/model_capability');
          _hardCap = _mc.hardOutputCap(_curModel);
          const _budget = resolveOutputBudget({
            requested: _chatModel.max_tokens,
            hardCap: _hardCap,
            reasoningCapable: _mc.reasoningCapable(_curModel),
            effortSpecified: !!_effort,
          });
          if (_budget && _budget !== _chatModel.max_tokens) {
            console.log('[inline_router] /api/chat 输出预算抬到 ' + _budget
              + ' (客户端要 ' + _chatModel.max_tokens + ', 推理模型下限)');
            _chatModel.max_tokens = _budget;
          }
        } catch (_) { /* 能力层不可用 ⇒ 沿用调用方给的预算 */ }
        const result = await callLLM(messages, _chatModel);
        const _ans0 = extractAnswer(result);
        // 2026-10-27 (第 112 批): 只回思考 / 被截断 ⇒ 用满预算再试一次
        // (规则与理由见文件头 _retryWithFullBudget)。
        const _retry = await _retryWithFullBudget({
          messages, model: _chatModel, ans: _ans0, raw: _ans0.text, cap: _hardCap, callLLM, extractAnswer,
        });
        let _ans = _retry ? _retry.ans : _ans0;
        // 2026-10-31 (老板: 「为什么都会有预算?」): 真账。
        //   usage 必须取**产出最终答案那一次**的 —— 重试过就取重试那次。
        //   `budget_effective` = 这轮实际生效的 cap: 没重试时是客户端要的那个
        //   (服务端在 effort 显式指定时**不抬**); 重试过就是硬上限 (32768)。
        const _usage = _retry ? _retry.usage : _usageOf(result);
        const _retried = !!(_retry && _retry.retried);
        const _budgetEffective = _retried ? (_hardCap || null) : (Number(_chatModel.max_tokens) || null);
        let _raw = _ans.text || '';
        let _answerTruncated = !!_ans.truncated;
        // 2026-10-19: 这条退化路径 (裸 callLLM, 没走 dispatcher) 原来把模型输出
        // **原样**交给 guardAnswer —— 而 guardAnswer 只判「对不对题」, 不管「是不是草稿」。
        // 于是本地 27B 把工具调用写成正文伪标记时, 主人收到的就是一段 XML:
        //   "<tool_call><function=read_file><parameter=path>/…llm_caller.js</parameter>…"
        // 现场 (2026-10-19 11:47, 「读一下 …/llm_caller.js 里的 _isLocalModel」):
        // 5 秒就返回这段 XML, 文件**根本没读**, 但接口 ok:true —— 看起来答了, 其实啥也没干。
        //
        // 收口跟 dispatcher 直答路径对齐 (j2_dispatcher.js:1354 那一段):
        // 先剥零宽字符 (零宽能让伪标记伪装成正文逃过正则), 再剥伪工具标记,
        // 剥完还剩工具草稿特征 = 模型这轮只吐了草稿没答 → 不许上屏。
        _raw = _raw.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '');
        // 2026-10-27 (第 112 批): 厂商返回里的 U+FFFD 替换字符 (多字节 UTF-8 被切碎)
        // 会直接印到主人脸上 (现场: 「适合��前安排职业与家庭缓冲方案」)。
        // 旧前端有个 sanitizeInterpretation 在剥它, 现在前端没了 ⇒ 这里剥。
        _raw = _raw.replace(/\uFFFD+/g, '');
        try { _raw = j2Helpers._stripPseudoToolMarkup(_raw); } catch (_) {}
        try { _raw = j2Helpers._stripSpecialTokens(_raw); } catch (_) {}
        _raw = _raw.trim();
        let _wasToolDraft = false;
        // ⚠ 判据**收紧** (2026-10-26 第 106 批补, 交叉审抓到的 P3):
        //   老判据是 `|"name"\s*:` —— 任何含 `{"name": "张三"}` 的**正常 JSON 答复**
        //   都会被整段清空。改前后果是「回空气泡」(便宜),
        //   现在升级阶梯接上了 ⇒ 后果变成「**白跑一整轮 agent 编排**」(贵 100 倍)。
        //   ⇒ 只认**工具调用形状**: 标签形态, 或 name+arguments 的 JSON 对。
        const _looksLikeToolDraft = /<tool_result|tool_use_error|<tool_call/i.test(_raw)
          || (/"name"\s*:/i.test(_raw) && /"arguments"\s*:/i.test(_raw));
        if (_looksLikeToolDraft) {
          console.warn('[inline_router] /message 退化路径: 模型只吐了工具调用草稿, 拦截未交付');
          _raw = '';
          _wasToolDraft = true;
        }
        const guarded = guardAnswer(userInput, _raw, '当前模型未返回与原问题对齐的答案。');

        // ── 2026-10-26 (第 106 批): 空答案**不许上屏** ──────────────────────
        // 旧行为: 模型只吐了工具草稿 ⇒ _raw='' ⇒ guardAnswer('') 判「对齐」直接放行
        //   ⇒ content='' ⇒ 接口回 {"ok":true, content:""} —— 主人看到的是**空气泡**。
        //   (根因在 answer_alignment.isAligned: `if (!q || !a || q.length < 6) return true;`
        //    —— 空答案被判「对齐」。⚠ **不在这里改 isAligned 的空答案语义**,
        //    那会波及主路径 (j2_agent_loop.js:1382 / j2_dispatcher.js:171)。)
        //
        // 修法: 端点自己兜住这条不变量, 走**升级阶梯**:
        //   ① 单发拿到**工具草稿** ⇒ 这道题**需要工具** ⇒ 升级到真 agent loop (有工具) 拿真答案
        //   ② 单发拿到**空** ⇒ 同上升级
        //   ③ 升级后仍没有 ⇒ 明确说「没答上来」, **绝不** content:""
        // 默认路径 (简单问答) 一次都不升级 ⇒ **零延迟变化**。
        // 规则本体在 modules/chat_answer_policy.js (纯函数 ⇒ 能直接测, 也能逐条变异验证);
        // 这里只负责「什么时候升级」+「把两段结果喂进去」。
        let _escalated = null;
        if (needsEscalation({ guardedText: guarded.text, guardedBlocked: guarded.blocked, wasToolDraft: _wasToolDraft })) {
          _escalated = await _runAgentLoopAsText();
        }
        const _t = String((_escalated && _escalated.text) || '').trim();
        // agent loop 的产物**不再过一遍 guardAnswer**: 它已经跑过主链自己的对齐/编排守卫,
        //   再套一次会把「有工具证据的正经答复」误杀 (快路径套它是因为那是裸模型输出)。
        const _decided = decideChatAnswer({
          guardedText: guarded.text,
          guardedBlocked: !!guarded.blocked,
          escalatedText: _t,
        });
        const content = _decided.content;
        // ⚠ 升级成功**也不在这里记记忆** —— agent loop 自己记了 (见上面 run_j2 分支的注释)。
        //   只有**快路径** (没跑 agent loop) 才由本端点记。
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true,
          choices: [{ message: { role: 'assistant', content } }],
          // 2026-10-31 (老板: 「为什么都会有预算?」): **真账**。
          //   旧前端脚注印的是「预算 2048 token」—— 那是客户端请求的**意图值**,
          //   而服务端会用满预算静默重试 ⇒ 那个数经常是假的 (实测请求 64 也回 13892 字)。
          //   ⇒ 这里把「这次真花了多少」交出去: 前端就能说真话。
          //   纯加字段, 老前端零改动 (weixin_bridge 只读 choices[0].message.content)。
          //   ⚠ 只有**正文确实是这一轮快路径产出**时才报 usage ——
          //   升级到 agent loop 时 (reason='escalated') 正文来自 loop,
          //   快路径的 usage 描述不了它 ⇒ 不报, 让前端降级显示「上限」,
          //   也不谎报一个不相关的数字。
          //   ⚠ 同理: guarded.recovered = 服务端对齐校验没过, 拿**兜底文案**顶上。
          //   那段字不是模型写的 ⇒ usage 记成「正文花了多少」是拿罐头冒充输出 ⇒ 不报。
          ...(_usage && _decided.reason === 'direct' && !guarded.recovered ? { usage: _usage } : {}),
          //   answer_recovered=true ⇒ 页面知道「这段不是模型的正文」, 别当成正文上账。
          ...(guarded.recovered ? { answer_recovered: true } : {}),
          // retried=true ⇒ 服务端用过满预算重试过 (客户端要的那个数被无视了)。
          ...(_retried ? { retried: true } : {}),
          ...(_budgetEffective ? { budget_effective: _budgetEffective } : {}),
          // 2026-10-27 (第 112 批): 上游说「没写完」(finish_reason='length') 而
          // 我们又没能再补一次 ⇒ 这段正文是**半截**的。老实说清楚, 别让主人
          // 以为这就是完整答案 (2026-10-26 现场: 九节只到第四节就没了)。
          ...(_answerTruncated ? { answer_truncated: true } : {}),
          // 同上: 状态与错误说明分两个字段 (见 run_j2 分支的注释)
          ...(_escalated && _escalated.status ? { agent_status: _escalated.status } : {}),
          // ⚠ agent_error 只在**真失败**时带 (状态喷泉守卫会先发 event:error 再跑成功 ⇒
          //   拿到好答案时也可能残留一个陈旧原因)。status === 'done' 就不带错误说明。
          ...(_escalated && _escalated.error && _escalated.status !== 'done'
            ? { agent_error: String(_escalated.error).slice(0, 500) } : {}),
        }));
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }



  // ==================== 全功能工具箱 (skill marketplace) ====================
  // 2026-09-11: 内部 skills 唯一账本 — 市场装/卸/已装全部走 ~/.pangu/skills (与 settings/skills 同源)
  const _PANGU_SKILLS_DIR = path.join(os.homedir(), '.pangu', 'skills');
  const _PANGU_SKILLS_JSON = path.join(os.homedir(), '.pangu', 'config', 'pangu_skills.json');

  // 2026-08-22: 老板拍 - Pangu 缺 skill 发现/安装流, 对标主流 agent 工具箱
  // 数据源: mock registry (10-20 个 skill), 后续接 skills.sh / GitHub
  // ==================== 全功能工具箱 (2026-08-27 真源化) ====================
  // Helper to fetch anthropics/skills live registry
  const ANTHROPICS_REPO = 'anthropics/skills';
  const ANTHROPICS_BRANCH = 'main';
  const ANTHROPICS_INDEX_TTL_MS = 10 * 60 * 1000; // 10 min cache
  const ANTHROPICS_RAW = `https://raw.githubusercontent.com/${ANTHROPICS_REPO}/${ANTHROPICS_BRANCH}/skills`;
  const ANTHROPICS_API = `https://api.github.com/repos/${ANTHROPICS_REPO}/contents/skills`;

  function _anthropics_index_cache_path() {
    const os = require('os'), path = require('path'), fs = require('fs');
    const dir = path.join(os.homedir(), '.pangu', 'cache');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return path.join(dir, 'anthropics_skills_index.json');
  }

  function _load_anthropics_index() {
    const fs = require('fs');
    const p = _anthropics_index_cache_path();
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const obj = JSON.parse(raw);
      if (obj && obj.fetched_at && (Date.now() - obj.fetched_at) < ANTHROPICS_INDEX_TTL_MS) return obj;
    } catch (_) {}
    return null;
  }

  function _save_anthropics_index(items) {
    const fs = require('fs');
    try {
      fs.writeFileSync(_anthropics_index_cache_path(), JSON.stringify({ fetched_at: Date.now(), items }, null, 2));
    } catch (_) {}
  }

  // 2026-10-20: GitHub 真源拉取从 execSync(curl) 改成 async fetch。
  // 原来同步 execSync 会在请求线程里把整个 daemon 冻住 —— 实测安装一个 skill 期间,
  // 另一个并发请求 /api/marketplace/installed 被拖到 14.09s (平时 2ms), 整个盘古僵住。
  // 而且 curl 单发不重试: 这台机器到 raw.githubusercontent.com 实测 8 次里挂 1~2 次。
  const GH_FETCH_TIMEOUT_MS = 8000;
  const GH_FETCH_ATTEMPTS = 3;
  const GH_RETRY_DELAY_MS = 400;

  async function _gh_fetch(url, asJson, timeoutMs = GH_FETCH_TIMEOUT_MS) {
    for (let attempt = 1; attempt <= GH_FETCH_ATTEMPTS; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url, {
          signal: ctrl.signal,
          redirect: 'follow',
          headers: { 'User-Agent': 'pangu-skill-importer/1.0' },
        });
        if (!r.ok) {
          if (attempt < GH_FETCH_ATTEMPTS) continue;
          return null;
        }
        return asJson ? await r.json() : await r.text();
      } catch (_) {
        if (attempt < GH_FETCH_ATTEMPTS) {
          await new Promise(res => setTimeout(res, GH_RETRY_DELAY_MS * attempt));
          continue;
        }
        return null;
      } finally { clearTimeout(timer); }
    }
    return null;
  }

  // Live fetch from GitHub API with cache + 8s timeout
  async function _fetch_anthropics_index_async() {
    // 1. Try cache
    const cached = _load_anthropics_index();
    if (cached) return cached.items;

    // 2. Fetch from GitHub API (async, 带超时 + 重试, 不再冻结 daemon)
    let apiItems = [];
    const data = await _gh_fetch(ANTHROPICS_API, true, 8000);
    if (Array.isArray(data)) {
      apiItems = data.filter(d => d && d.type === 'dir').map(d => d.name);
    } else {
      console.error('[marketplace] anthropics index fetch failed');
    }

    if (apiItems.length === 0) {
      // Fallback to hardcoded list (last known good)
      apiItems = ['academy-guide','algorithmic-art','brand-guidelines','canvas-design','claude-api','discernment-nudge','doc-coauthoring','docx','frontend-design','internal-comms','mcp-builder','pdf','pptx','skill-creator','slack-gif-creator','theme-factory','web-artifacts-builder','webapp-testing','xlsx'];
    }

    _save_anthropics_index(apiItems);
    return apiItems;
  }

  // Heuristic mapping for icon/category
  // 第 143 批: 图标从 **emoji** 改成界面图标集里的**矢量图标名** ——
  //   emoji 各平台字形不一, 还是满屏彩色小图, 一眼就"不专业"。
  //   顺带给每个开源技能配一句中文说明 (原来全是「开源 skill: <名字>」, 把名字复读一遍)。
  const _ANTHROPICS_CAT = {
    'frontend-design': ['办公学习','sparkles'], 'canvas-design': ['办公学习','layout-grid'],
    'brand-guidelines': ['办公学习','target'], 'skill-creator': ['电脑设置','rotate-cw'],
    'mcp-builder': ['电脑设置','plug'], 'webapp-testing': ['电脑设置','monitor'],
    'theme-factory': ['办公学习','wand'], 'web-artifacts-builder': ['办公学习','globe'],
    'doc-coauthoring': ['办公学习','pen-tool'], 'internal-comms': ['办公学习','message'],
    'algorithmic-art': ['休闲娱乐','sparkles'], 'slack-gif-creator': ['休闲娱乐','camera'],
    'pdf': ['办公学习','file'], 'pptx': ['办公学习','bar-chart'], 'xlsx': ['办公学习','table'], 'docx': ['办公学习','file'],
    'claude-api': ['电脑设置','bot'], 'academy-guide': ['办公学习','book'],
    'discernment-nudge': ['办公学习','search'],
  };
  const _ANTHROPICS_DESC = {
    'frontend-design': '做前端界面：设计稿落地、组件与排版规范',
    'canvas-design': '画海报、封面与视觉稿',
    'brand-guidelines': '整理品牌规范：色板、字体、语气',
    'skill-creator': '把一套做法写成可安装的技能',
    'mcp-builder': '接一个外部工具服务进来',
    'webapp-testing': '自动打开网页、点按钮、截图核对',
    'theme-factory': '生成一整套界面主题',
    'web-artifacts-builder': '做可交互的网页小工具',
    'doc-coauthoring': '一起起草、润色长文档',
    'internal-comms': '写公告、周报与内部通知',
    'algorithmic-art': '按规则生成抽象画',
    'slack-gif-creator': '做聊天动图',
    'pdf': '读 PDF、提取表格与要点',
    'pptx': '读改演示文稿',
    'xlsx': '读改电子表格',
    'docx': '读改 Word 文档',
    'claude-api': '对照 Claude 接口文档写调用代码',
    'academy-guide': '分步骤的教程与练习',
    'discernment-nudge': '在需要判断时给出多角度建议',
  };

  // 第 144 批: **中文名**。原来卡片的标题直接印英文 slug (academy-guide /
  //   brand-guidelines / first-principles …) —— 一屏 19 张卡, 每张标题都是一串
  //   连字符小写英文, 看着像一墙包名, 不像一份给人挑的工具清单。
  //   现在每个技能给一个中文名当**主标题**, 英文 slug 降级成副标题 (灰、等宽),
  //   两者并存: 中文好认, slug 还能复制去装。
  const _ANTHROPICS_CN = {
    'frontend-design': '前端界面设计',
    'canvas-design': '海报与视觉稿',
    'brand-guidelines': '品牌规范',
    'skill-creator': '技能制作器',
    'mcp-builder': '外部工具接入',
    'webapp-testing': '网页自动测试',
    'theme-factory': '界面主题生成',
    'web-artifacts-builder': '网页小工具',
    'doc-coauthoring': '长文档共写',
    'internal-comms': '公告与周报',
    'algorithmic-art': '规则生成抽象画',
    'slack-gif-creator': '聊天动图',
    'pdf': 'PDF 读取',
    'pptx': '演示文稿',
    'xlsx': '电子表格',
    'docx': 'Word 文档',
    'claude-api': 'Claude 接口',
    'academy-guide': '分步教程',
    'discernment-nudge': '多角度参谋',
  };

  function _anthropics_to_entry(name) {
    const [category, icon] = _ANTHROPICS_CAT[name] || ['办公学习','package'];
    return {
      id: `anthropics/${name}`, name, source: 'GitHub',
      source_url: `github.com/${ANTHROPICS_REPO}`, category, icon,
      name_cn: _ANTHROPICS_CN[name] || '',
      description: _ANTHROPICS_DESC[name] || 'Anthropic 开源技能，装好即可调用', popularity: 0,
      real: true,  // ← 标记真实可拉
    };
  }

  // Fetch SKILL.md content from GitHub raw, async + 磁盘缓存 (装过的别反复拉)
  const ANTHROPICS_SKILL_MD_TTL_MS = 30 * 60 * 1000; // 30 min
  function _anthropics_skill_md_cache_path(name) {
    const os = require('os'), path = require('path'), fs = require('fs');
    const dir = path.join(os.homedir(), '.pangu', 'cache', 'marketplace');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return path.join(dir, String(name).replace(/[^a-zA-Z0-9_\-]/g, '_') + '.md');
  }

  async function _fetch_anthropics_skill_md_async(name) {
    const fs = require('fs');
    // 缓存优先
    try {
      const p = _anthropics_skill_md_cache_path(name);
      const st = fs.statSync(p);
      if ((Date.now() - st.mtimeMs) < ANTHROPICS_SKILL_MD_TTL_MS) {
        const cached = fs.readFileSync(p, 'utf8');
        if (cached && cached.length > 100) return cached;
      }
    } catch (_) {}

    const text = await _gh_fetch(`${ANTHROPICS_RAW}/${name}/SKILL.md`, false);
    if (!text || text.length <= 100) return null;
    try { fs.writeFileSync(_anthropics_skill_md_cache_path(name), text, 'utf8'); } catch (_) {}
    return text;
  }

  // Get full registry: community (mock) + anthropics (live)
  async function _get_marketplace_registry_async() {
    const community = _MARKETPLACE_COMMUNITY_REGISTRY.map(e => ({
      ...e, name_cn: _COMMUNITY_CN[e.name] || '', real: false,
    }));
    const anthropics = (await _fetch_anthropics_index_async()).map(_anthropics_to_entry);
    return [...anthropics, ...community];
  }

  // Keep community entries here (was the old _MARKETPLACE_REGISTRY, but now marked real:false)
  const _MARKETPLACE_COMMUNITY_REGISTRY = [
    { id: 'skillhub/baidu-search',      name: 'baidu-search',      source: '社区', source_url: 'github.com', category: '生活日常', icon: 'search', description: '通过百度 AI 搜索接口查最新中文信息', popularity: 25000 },
    { id: 'skillhub/weather-china',     name: 'weather-china',     source: '社区', source_url: 'github.com', category: '生活日常', icon: 'sun', description: '帮你看国内城市天气和出行穿衣建议', popularity: 37000 },
    { id: 'skillhub/business-writing',  name: 'business-writing',  source: '社区',  source_url: 'github.com', category: '办公学习', icon: 'layers', description: '专业的商业写作助手, 帮助撰写商务邮件', popularity: 32000 },
    { id: 'skillhub/baoyu-comic',       name: 'baoyu-comic',       source: 'GitHub',   source_url: 'github.com',  category: '休闲娱乐', icon: 'book', description: '把任意知识内容转化为分镜脚本和多风格漫画', popularity: 34000 },
    { id: 'skillhub/multi-search-engine', name: 'multi-search-engine', source: '社区', source_url: 'github.com', category: '生活日常', icon: 'search', description: '聚合 16 个国内外搜索引擎免费 API 调用', popularity: 62000 },
    { id: 'skillhub/ui-ux-pro-max',     name: 'UI/UX Pro Max',     source: '社区',  source_url: 'github.com', category: '办公学习', icon: 'sparkles', description: '为前端界面提供设计方案组件规范和可访问性', popularity: 61000 },
    { id: 'skillhub/baoyu-xhs-images', name: 'baoyu-xhs-images', source: 'GitHub',  source_url: 'github.com', category: '休闲娱乐', icon: 'pen-tool', description: '把任意内容拆解为 1-10 张小红书风格图', popularity: 26000 },
    { id: 'skillhub/first-principles',  name: 'First Principles Decomposer', source: '社区', source_url: 'github.com', category: '办公学习', icon: 'brain', description: '把复杂问题拆到底层假设再从原点重建推理', popularity: 55000 },
    { id: 'skillhub/baoyu-diagram',     name: 'baoyu-diagram',     source: 'GitHub',   source_url: 'github.com',  category: '办公学习', icon: 'bar-chart', description: '用自然语言描述生成专业级 SVG 架构图', popularity: 31000 },
    { id: 'skillhub/deep-research',     name: 'Deep Research Skill', source: 'GitHub',  source_url: 'github.com',  category: '办公学习', icon: 'cpu', description: '系统化多角度搜集权威信息产出高质量报告', popularity: 45000 },
    { id: 'skillhub/brainstorming',     name: 'brainstorming',     source: 'GitHub',   source_url: 'github.com',  category: '办公学习', icon: 'zap', description: '把简单想法变成清晰方案', popularity: 124000 },
    { id: 'skillhub/humanizer',         name: 'humanizer',         source: '社区', source_url: 'github.com', category: '办公学习', icon: 'pen-tool', description: '把生硬的 AI 文案改得更像人写的', popularity: 72000 },
    { id: 'skillhub/find-skills',       name: 'Find Skills',       source: 'GitHub',   source_url: 'github.com',  category: '电脑设置', icon: 'compass', description: '根据你的需求查遍全网, 用已有的 skill 解决', popularity: 67000 },
    { id: 'skillhub/skill-vetter',      name: 'skill-vetter',      source: '社区', source_url: 'github.com', category: '电脑设置', icon: 'shield', description: '安装前先帮你检查技能来源、权限和风险', popularity: 67000 },
    { id: 'skillhub/ontology',          name: 'ontology',          source: '社区', source_url: 'github.com', category: '办公学习', icon: 'folder', description: '把人物、任务和文档整理成关系图', popularity: 33000 },
    { id: 'skillhub/translator',        name: 'translator',     source: '社区',  source_url: 'github.com', category: '办公学习', icon: 'globe', description: '多语言翻译 (中英日韩法德俄), 支持术语表', popularity: 41000 },
    { id: 'skillhub/code-reviewer',     name: 'code-reviewer',     source: 'GitHub',   source_url: 'github.com',  category: '办公学习', icon: 'code', description: '深度代码审查, 安全漏洞 + 性能 + 可读性', popularity: 39000 },
    { id: 'skillhub/screenshot-to-code', name: 'screenshot-to-code', source: '社区', source_url: 'github.com', category: '办公学习', icon: 'camera', description: '截图转代码 (HTML/CSS/React/Vue)', popularity: 47000 },
  ];
  const _MARKETPLACE_CATEGORIES = ['全部', '办公学习', '电脑设置', '生活日常', '休闲娱乐'];
  const _MARKETPLACE_SOURCES = ['全部', 'Claude', '社区', 'GitHub'];

  // 第 144 批: 社区技能的中文名 (同 _ANTHROPICS_CN 的理由:
  //   卡片主标题印中文, 英文 slug 降级成副标题)。
  const _COMMUNITY_CN = {
    'baidu-search': '百度搜索',
    'weather-china': '国内天气',
    'business-writing': '商务写作',
    'baoyu-comic': '分镜漫画',
    'multi-search-engine': '聚合搜索',
    'UI/UX Pro Max': '界面规范助手',
    'baoyu-xhs-images': '小红书图文',
    'First Principles Decomposer': '第一性原理',
    'baoyu-diagram': '架构图生成',
    'Deep Research Skill': '深度调研',
    'brainstorming': '头脑风暴',
    'humanizer': '口语化改写',
    'Find Skills': '技能检索',
    'skill-vetter': '安装体检',
    'ontology': '知识图谱',
    'translator': '多语翻译',
    'code-reviewer': '代码审查',
    'screenshot-to-code': '截图转代码',
  };

  // ==================== marketplace 对内: 内部工具顺序重组 (2026-09-14 老板拍 #6) ====================
  // 老板定义: marketplace = 外部工具安装 + 对内部工具的顺序重组。
  // 顺序的真效果: j2_agent_loop 喂 LLM 的 toolsSchema 顺序 (tool_layout.orderSchemas)。
  if ((pathname === '/api/marketplace/internal' || pathname === '/marketplace/internal') && req.method === 'GET') {
    try {
      const { getAllToolSchemas } = require('../../modules/tools_schema.js');
      const _tl = require('../../modules/tool_layout.js');
      const schemas = _tl.orderSchemas(getAllToolSchemas());
      const disabled = new Set(((_config.tools || {}).disabled) || []);
      const tools = schemas.map(s => ({
        name: s.function.name,
        description: (s.function.description || '').slice(0, 80),
        enabled: !disabled.has(s.function.name),
      }));
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ ok: true, tools, layout: _tl.loadLayout() }));
    } catch (e) { res.writeHead(500, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:e.message})); }
  }

  if ((pathname === '/api/marketplace/internal/layout' || pathname === '/marketplace/internal/layout') && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        let b;
        try { b = JSON.parse(body || '{}'); }
        catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
        const { TOOLS_SCHEMA } = require('../../modules/tools_schema.js');
        // 只认真实注册的工具名, 垃圾名直接丢 (防布局文件腐烂)
        const valid = (Array.isArray(b.order) ? b.order : []).filter(n => TOOLS_SCHEMA[n]);
        const _tl = require('../../modules/tool_layout.js');
        const r = _tl.saveLayout(valid);
        res.writeHead(200, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ ok: true, saved: r.count, note: valid.length ? '顺序已生效: 下轮对话 LLM 看到的工具顺序即此序' : '已恢复默认顺序' }));
      } catch (e) { res.writeHead(500, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:e.message})); }
    });
    return { consumed: true };
  }

  if ((pathname === '/api/marketplace/list' || pathname === '/marketplace/list') && req.method === 'GET') {
    try {
      const url = require('url').parse(req.url, true);
      const cat = url.query.category;
      const src = url.query.source;
      const q = (url.query.q || '').toLowerCase();
      const onlyReal = url.query.real === '1';
      const registry = await _get_marketplace_registry_async();
      let items = registry.slice();
      if (cat && cat !== '全部') items = items.filter(s => s.category === cat);
      if (src && src !== '全部') items = items.filter(s => s.source === src);
      if (q) items = items.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
      if (onlyReal) items = items.filter(s => s.real === true);
      const realCount = items.filter(s => s.real).length;
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({
        ok: true,
        items,
        total: items.length,
        real_count: realCount,
        categories: _MARKETPLACE_CATEGORIES,
        sources: _MARKETPLACE_SOURCES,
        registry_size: registry.length,
        note: realCount > 0
          ? `${realCount} 个 ✅ 真实可拉 (anthropics/skills), ${items.length - realCount} 个 🟡 预览`
          : '当前 registry, 后续接更多 GitHub 源'
      }));
    } catch (e) { res.writeHead(500, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:e.message})); }
  }

  // 已装 skill 列表 (pangu_skills.json + filesystem scan)
  if ((pathname === '/api/marketplace/installed' || pathname === '/marketplace/installed') && req.method === 'GET') {
    try {
      const fs = require('fs'), path = require('path'), os = require('os');
      const installed = [];
      const broken = [];
      const skillsDir = _PANGU_SKILLS_DIR;
      if (fs.existsSync(skillsDir)) {
        for (const d of fs.readdirSync(skillsDir)) {
          const full = path.join(skillsDir, d);
          // 2026-10-28 修 (界面事故 + 隐私事故):
          //   skills 目录里常驻着指向别处的**软链** (别的机器上装 skill 时留下的)。
          //   目标没了 = 悬空软链 ⇒ 原来这里 statSync 直接抛 ENOENT,
          //   整个接口 500, 界面把
          //   "ENOENT: no such file or directory, stat '/Users/<某人>/.pangu/skills/xxx'"
          //   原样弹给用户 —— 一个坏软链, 整页工具集变成红色报错, 还顺手把
          //   用户家目录路径印在屏幕上 (开源版里这是隐私事故)。
          //   现在: 坏条目**跳过**, 单独记进 broken, 不让一个坏软链掀翻整页;
          //   而且接口的错误里**不再出现文件系统路径**。
          let st;
          try { st = fs.statSync(full); } catch (_) { broken.push({ name: d, reason: 'LINK_BROKEN' }); continue; }
          if (!st.isDirectory()) continue;
          const mdPath = path.join(full, 'SKILL.md');
          if (!fs.existsSync(mdPath)) continue;
          const content = fs.readFileSync(mdPath, 'utf8');
          // 解析 frontmatter
          const fm = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
          const meta = { name: d, installed_at: st.mtime.toISOString() };
          if (fm) {
            const yaml = fm[1];
            const nameMatch = yaml.match(/^name:\s*(.+)$/m);
            const descMatch = yaml.match(/^description:\s*(.+)$/m);
            if (nameMatch) meta.name = nameMatch[1].trim();
            if (descMatch) meta.description = descMatch[1].trim();
          }
          installed.push(meta);
        }
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ ok: true, installed, count: installed.length, broken }));
    } catch (e) {
      // 错误里不许带文件系统路径 (用户家目录不该出现在 HTTP 响应里)
      console.error('[inline_router] marketplace/installed failed:', e && e.message);
      res.writeHead(500, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({ok:false, error:'SKILLS_LIST_FAILED'}));
    }
  }

  // Install skill (拉真源 SKILL.md 落 ~/.pangu/skills + 加 entry 到 pangu_skills.json)
  if ((pathname === '/api/marketplace/install' || pathname === '/marketplace/install') && req.method === 'POST') {
    let body = ''; let instAborted = false;
    req.on('data', c => { if (instAborted) return; body += c; if (body.length > 1024 * 1024) { instAborted = true; res.writeHead(413, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'BODY_TOO_LARGE'})); } });
    req.on('end', async () => {
      if (instAborted) return;
      try {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); }
        catch (_) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'INVALID_JSON'})); }
        const { package: pkg, id } = parsed;
        if (!pkg && !id) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'MISSING_PACKAGE_OR_ID'})); }
        const skillId = id || pkg;
        const entry = (await _get_marketplace_registry_async()).find(s => s.id === skillId || s.name === skillId);
        if (!entry) { res.writeHead(404, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'SKILL_NOT_FOUND_IN_REGISTRY', id: skillId})); }
        // 2026-09-13 老板拍: mock 空壳禁止安装 (装上只有名字零指令, 欺骗模型)
        if (!entry.real) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'MOCK_NOT_INSTALLABLE', message:'演示条目: 尚未接入真源, 禁止安装空壳'})); }

        const fs = require('fs'), path = require('path'), os = require('os');
        const skillsDir = _PANGU_SKILLS_DIR; // 2026-09-11: 装入内部 skills 目录 (唯一账本)
        const safeName = String(entry.name).replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();
        const skillDir = path.join(skillsDir, safeName);
        if (fs.existsSync(skillDir)) { res.writeHead(409, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'ALREADY_INSTALLED', name: safeName, dir: skillDir})); }

        // 2026-08-27 真源安装 — anthropics/* 直接从 GitHub raw 拉真实 SKILL.md
        // 2026-10-20 修: 原来这里拉不到就掉进 mock 分支, 落一个 529 字节的 stub 就算"装好了" ——
        // 2026-09-13 老板拍「mock 空壳禁止安装 (装上只有名字零指令, 欺骗模型)」被网络抖动架空:
        // registry 说 real:true, 用户点安装, 界面报成功, 实际装的是空壳, 模型读到的是一段警告。
        // 现在拉不到就明说失败, 不落任何文件。
        let skillMd;
        let installKind = 'real';
        if (entry.real) {
          const skillName = entry.id.startsWith('anthropics/') ? entry.id.split('/')[1] : null;
          const realMd = skillName ? await _fetch_anthropics_skill_md_async(skillName) : null;
          if (!realMd) {
            res.writeHead(502, {'Content-Type':'application/json'});
            return res.end(JSON.stringify({
              ok: false, error: 'GITHUB_FETCH_FAILED', name: entry.name,
              message: '真源拉取失败, 已阻止安装空壳 (2026-09-13 决定: mock 空壳禁止安装)。请稍后重试或检查到 raw.githubusercontent.com 的连通性。'
            }));
          }
          const meta = `\n\n---\n\n## Pangu 安装信息\n\n- 安装时间: ${new Date().toISOString()}\n- Registry ID: ${entry.id}\n- 来源: github.com/${ANTHROPICS_REPO}\n- 真实字节: ${realMd.length}\n`;
          skillMd = realMd + meta;
        }
        // 2026-10-20: 目录也在真源到手之后才建 —— 拉失败时一个空目录都不留。
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd, 'utf8');

        // 加 entry 到 pangu_skills.json
        const skillsFile = _PANGU_SKILLS_JSON;
        let arr = [];
        try { arr = JSON.parse(fs.readFileSync(skillsFile, 'utf8') || '[]'); } catch (_) { arr = []; }
        const newEntry = { id: 'skill_' + Date.now(), spec: { name: entry.name, source: entry.source, registry_id: entry.id, dir: skillDir }, created_at: new Date().toISOString() };
        arr.push(newEntry);
        fs.writeFileSync(skillsFile, JSON.stringify(arr, null, 2), 'utf8');

        // 触发 cache 失效
        try { require(path.join(__dirname, '..', '..', 'modules', 'pangu_helpers')).invalidateSkillsCache && require(path.join(__dirname, '..', '..', 'modules', 'pangu_helpers')).invalidateSkillsCache(); } catch (_) {}
        try { require(path.join(__dirname, '..', '..', 'modules', 'router', 'smart_router')).invalidateCache(); } catch (_) {}

        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ ok: true, installed: { name: entry.name, dir: skillDir, kind: installKind, bytes: skillMd.length, entry: newEntry } }));
      } catch (e) { res.writeHead(500, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    });
    return;
  }

  // Uninstall skill
  if ((pathname === '/api/marketplace/uninstall' || pathname === '/marketplace/uninstall') && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); }
        catch (_) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'INVALID_JSON'})); }
        const { name } = parsed;
        if (!name) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'MISSING_NAME'})); }
        const fs = require('fs'), path = require('path'), os = require('os');
        const safeName = String(name).replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();
        const skillDir = path.join(_PANGU_SKILLS_DIR, safeName); // 2026-09-11: 从内部 skills 目录删
        if (!fs.existsSync(skillDir)) { res.writeHead(404, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'NOT_INSTALLED', name: safeName})); }
        fs.rmSync(skillDir, { recursive: true, force: true });
        // 从 pangu_skills.json 移除
        const skillsFile = _PANGU_SKILLS_JSON;
        try {
          let arr = JSON.parse(fs.readFileSync(skillsFile, 'utf8') || '[]');
          arr = arr.filter(e => !(e.spec && e.spec.name === name));
          fs.writeFileSync(skillsFile, JSON.stringify(arr, null, 2), 'utf8');
        } catch (_) {}
        try { require(path.join(__dirname, '..', '..', 'modules', 'pangu_helpers')).invalidateSkillsCache && require(path.join(__dirname, '..', '..', 'modules', 'pangu_helpers')).invalidateSkillsCache(); } catch (_) {}
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ ok: true, uninstalled: safeName }));
      } catch (e) { res.writeHead(500, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); }
    });
    return;
  }

  // Skill detail preview (real SKILL.md for real entries, mock for community)
  if ((pathname.startsWith('/api/marketplace/detail/') || pathname.startsWith('/marketplace/detail/')) && req.method === 'GET') {
    const id = decodeURIComponent(pathname.split('/').pop());
    const registry = await _get_marketplace_registry_async();
    const entry = registry.find(s => s.id === id || s.name === id);
    if (!entry) { res.writeHead(404, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false,error:'SKILL_NOT_FOUND'})); }
    let preview = `预览: ${entry.description}\n\n(来源: ${entry.source_url})`;
    if (entry.real && entry.id.startsWith('anthropics/')) {
      const skillName = entry.id.split('/')[1];
      const realMd = await _fetch_anthropics_skill_md_async(skillName);
      if (realMd) {
        const previewText = realMd.length > 4000 ? realMd.slice(0, 4000) + '\n\n...(截断)' : realMd;
        preview = `✅ 真实 SKILL.md (${realMd.length} 字符)\n\n${previewText}`;
      } else {
        preview = `⚠️ GitHub 拉取失败, 显示描述:\n\n${entry.description}`;
      }
    }
    res.writeHead(200, {'Content-Type':'application/json'});
    return res.end(JSON.stringify({ ok: true, skill: entry, preview }));
  }

  // 2026-08-22: 异步 vision 自动探测 (老板拍: 加模型时怎么判断是不是多模态)
  // 加池/更新池时后台触发 probe, 完成自动写回 config (vision 字段), 不阻塞 add 响应
  // 复用 /api/llm/probe-vision 同一套 PNG + 颜色词识别逻辑
  // ==================== LM Studio model.yaml 真源 (2026-08-22) ====================
  // 老板问: 加模型时盘古怎么自动判断是不是全模态 — LM Studio UI 看得见 capabilities 但 /v1/models 不暴露
  // 破解: 直接读 ~/.lmstudio/hub/models/<owner>/<name>/model.yaml 的 metadataOverrides.vision/reasoning/tool/architectures/contextLengths
  // 这是 LM Studio 自己存的真源 (UI 也从这里读), 比正则/探测都权威, 无副作用, 即时返回

  // 扫描所有 model.yaml, 返回 { owner/name: { vision, reasoning, tool, arch[], ctx[], params[], raw } }
  function _scanLmStudioHub() {
    const found = {};
    const fs2 = require('fs');
    for (const base of LMSTUDIO_HUB_PATHS) {
      let dirs = [];
      try { dirs = fs2.readdirSync(base); } catch (_) { continue; }
      for (const owner of dirs) {
        const ownerDir = path.join(base, owner);
        let stat;
        try { stat = fs2.statSync(ownerDir); } catch (_) { continue; }
        if (!stat.isDirectory()) continue;
        let models;
        try { models = fs2.readdirSync(ownerDir); } catch (_) { continue; }
        for (const name of models) {
          const modelDir = path.join(ownerDir, name);
          let ms;
          try { ms = fs2.statSync(modelDir); } catch (_) { continue; }
          if (!ms.isDirectory()) continue;
          const yaml = path.join(modelDir, 'model.yaml');
          let text;
          try { text = fs2.readFileSync(yaml, 'utf8'); } catch (_) { continue; }
          let parsed;
          try { parsed = parseYaml(text); } catch (e) { continue; }
          const mo = parsed.metadataOverrides || {};
          const key = owner + '/' + name;
          found[key] = {
            owner, name, yaml_path: yaml,
            vision: mo.vision === true,
            reasoning: mo.reasoning === true,
            tool: mo.trainedForToolUse === true,
            arch: mo.architectures || [],
            ctx: mo.contextLengths || [],
            params: mo.paramsStrings || [],
            domain: mo.domain || 'llm',
          };
        }
      }
    }
    return found;
  }

  // 给定模型 id (e.g. "qwen/qwen3.8-27b" 或 "qwen3.8-27b-mlx"), 在 LM Studio 真源里查匹配
  // 匹配优先级: 完全 owner/name > name-only > 无 owner 前缀的同名
  function _lookupLmStudioCapabilities(modelId, hub) {
    hub = hub || _scanLmStudioHub();
    if (!modelId) return null;
    const mid = String(modelId).toLowerCase();
    // 1. 完整 owner/name 命中
    if (hub[mid]) return hub[mid];
    // 2. 拆出可能 owner/name (lmstudio-community/qwen3.8-27b-mlx-4bit 这类含变体)
    const slash = mid.lastIndexOf('/');
    if (slash !== -1) {
      const owner = mid.slice(0, slash);
      const name = mid.slice(slash + 1);
      // 找 hub 里 owner 匹配 + name 前缀匹配 (e.g. qwen3.8-27b-mlx 命中 qwen3.8-27b)
      for (const key of Object.keys(hub)) {
        const h = hub[key];
        if (h.owner.toLowerCase() !== owner) continue;
        // model id 含 hub name 或反之 (容错 -mlx/-gguf/-4bit 等变体)
        if (mid.includes(h.name) || h.name.includes(name.replace(/-mlx.*|-gguf.*|-4bit.*|-5bit.*|-6bit.*|-8bit.*/,''))) {
          return h;
        }
      }
    }
    // 3. name-only 模糊匹配 (e.g. "qwen3.8-27b-mlx" → hub 里有 "qwen/qwen3.8-27b")
    const baseName = mid.replace(/-mlx.*|-gguf.*|-4bit.*|-5bit.*|-6bit.*|-8bit.*/,'');
    for (const key of Object.keys(hub)) {
      const h = hub[key];
      if (key.toLowerCase().includes(baseName) || baseName.includes(h.name)) {
        return h;
      }
    }
    return null;
  }

  // 把 discover 命中写回 config (覆盖 vision/reasoning/tool/arch/ctx, 标记 _vision_source)
  // 命中策略: 只在原本没显式 vision 标注时覆盖; 已显式标注的保留用户选择
  function _applyLmStudioCapabilities(modelId, force = false) {
    const m = (_config.llm.models || []).find(x => x.id === modelId);
    if (!m) return { ok: false, reason: 'MODEL_NOT_FOUND' };
    const hub = _scanLmStudioHub();
    const hit = _lookupLmStudioCapabilities(modelId, hub);
    if (!hit) return { ok: false, reason: 'NOT_IN_LMSTUDIO_HUB', model: modelId };
    const hadExplicitVision = m.vision === true || m.vision === false;
    const fields = {};
    if (force || !hadExplicitVision) {
      fields.vision = hit.vision;
      fields._vision_source = 'lmstudio-yaml';
      fields._vision_yaml_key = hit.owner + '/' + hit.name;
      fields._vision_yaml_at = new Date().toISOString();
    }
    if (force || m.reasoning === undefined) {
      fields.reasoning = hit.reasoning;
      fields._reasoning_source = 'lmstudio-yaml';
    }
    if (force || m.tool === undefined) {
      fields.tool = hit.tool;
      fields._tool_source = 'lmstudio-yaml';
    }
    if (force || !m.arch) {
      fields.arch = hit.arch;
      fields._arch_source = 'lmstudio-yaml';
    }
    if (force || !m.context_length) {
      fields.context_length = hit.ctx[0] || m.context_length;
      fields._ctx_source = 'lmstudio-yaml';
    }
    Object.assign(m, fields);
    saveConfig();
    return {
      ok: true,
      model: modelId,
      hit: hit.owner + '/' + hit.name,
      applied: fields,
      had_explicit_vision: hadExplicitVision,
      force
    };
  }

  // 端点: GET /api/llm/lmstudio-discover — 扫所有 model.yaml 返全表
  if ((pathname === '/api/llm/lmstudio-discover' || pathname === '/llm/lmstudio-discover') && req.method === 'GET') {
    const hub = _scanLmStudioHub();
    const models = Object.values(hub);
    // 给当前每个模型匹配一个 hit (供前端显示真源)
    const matches = (_config.llm.models || []).map(m => {
      const hit = _lookupLmStudioCapabilities(m.id, hub);
      return { id: m.id, hit: hit ? (hit.owner + '/' + hit.name) : null,
               vision: m.vision, _vision_source: m._vision_source,
               _vision_auto: m._vision_auto };
    });
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({
      ok: true,
      hub_count: models.length,
      models,
      matches,
      scanned_paths: LMSTUDIO_HUB_PATHS,
    }));
  }

  // 2026-08-22 §self-report: 让模型自己回答能力 (老板拍: 模型能力都应该从模型拿才对)
  // POST /api/llm/self-report  body: { model_id } 或 { model: {...} }
  if ((pathname === '/api/llm/self-report' || pathname === '/llm/self-report') && req.method === 'POST') {
    let body = '';
    let aborted = false;
    req.on('data', c => { if (body.length + c.length > 65536) { aborted = true; req.destroy(); } else body += c; });
    req.on('end', async () => {
      if (aborted) return;
      try {
        const req_body = body ? JSON.parse(body) : {};
        let model;
        if (req_body.model_id) {
          model = (_config.llm.models || []).find(x => x.id === req_body.model_id);
          if (!model) {
            res.writeHead(404, {'Content-Type': 'application/json'});
            return res.end(JSON.stringify({ ok: false, error: 'MODEL_NOT_FOUND' }));
          }
        } else if (req_body.model) {
          model = req_body.model;
        } else {
          res.writeHead(400, {'Content-Type': 'application/json'});
          return res.end(JSON.stringify({ ok: false, error: 'MISSING_MODEL_OR_MODEL_ID' }));
        }
        const result = await llmCapSelf.selfReportCapabilities(model, { promptLang: req_body.lang || 'both' });
        res.writeHead(200, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 2026-08-22 §auto-sync: 手动触发云端能力库同步 (老板拍: 出新模型不要手动维护, 但也给手动按钮兜底)
  if ((pathname === '/api/llm/sync-capabilities' || pathname === '/llm/sync-capabilities') && req.method === 'POST') {
    llmCapSync.syncModelsDev({ force: true, log: console.log })
      .then(r => {
        llmCapSync.invalidateCache();
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ ok: true, ...r, meta: llmCapSync.getSyncMeta() }));
      })
      .catch(e => {
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ ok: false, error: e.message }));
      });
    return;
  }
  if ((pathname === '/api/llm/capabilities-status' || pathname === '/llm/capabilities-status') && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    return res.end(JSON.stringify({ ok: true, meta: llmCapSync.getSyncMeta() }));
  }

  // 端点: POST /api/llm/lmstudio-discover/apply — 把所有匹配写回 config
  if ((pathname === '/api/llm/lmstudio-discover/apply' || pathname === '/llm/lmstudio-discover/apply') && req.method === 'POST') {
    let body = '';
    let aborted = false;
    req.on('data', c => { if (body.length + c.length > 65536) { aborted = true; req.destroy(); } else body += c; });
    req.on('end', () => {
      try {
        if (aborted) return;
        const req_body = body ? JSON.parse(body) : {};
        const force = !!req_body.force;
        const target = req_body.model_id || null;
        const results = [];
        if (target) {
          results.push({ model: target, ..._applyLmStudioCapabilities(target, force) });
        } else {
          for (const m of (_config.llm.models || [])) {
            results.push({ model: m.id, ..._applyLmStudioCapabilities(m.id, force) });
          }
        }
        res.writeHead(200, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ ok: true, results, models: _config.llm.models.map(_publicModel) }));
      } catch (e) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 2026-08-22 §self-report: 异步让模型自报能力 (老板拍: 模型能力都应该从模型拿才对)
  // 加池/更新时后台触发, 完成自动写回 config (vision/reasoning/tool/ctx), 不阻塞响应
  // 重要: 自报结果 vs 用户手动 vision 字段: 不覆盖用户显式配置
  function _asyncSelfReport(modelId) {
    const m = (_config.llm.models || []).find(x => x.id === modelId);
    if (!m || !m.endpoint) return;
    llmCapSelf.selfReportCapabilities(m, { promptLang: 'both' }).then((r) => {
      if (!r.ok || !r.capabilities) {
        console.log('[self-report-async]', modelId, 'failed:', r.error);
        return;
      }
      const idx = (_config.llm.models || []).findIndex(x => x.id === modelId);
      if (idx === -1) return;
      const cap = r.capabilities;
      const userExplicitVision = _config.llm.models[idx].vision === true || _config.llm.models[idx].vision === false;
      const userExplicitReasoning = _config.llm.models[idx].reasoning === true || _config.llm.models[idx].reasoning === false;
      const userExplicitTool = _config.llm.models[idx].tool === true || _config.llm.models[idx].tool === false;
      const fields = {};
      if (!userExplicitVision && cap.vision !== null) fields.vision = cap.vision;
      if (!userExplicitReasoning && cap.reasoning !== null) fields.reasoning = cap.reasoning;
      if (!userExplicitTool && cap.tool !== null) fields.tool = cap.tool;
      // 2026-09-16: 自报 ctx 只在 config 没有窗口值时填 (自报会答错, 不能盖厂商/网关真值; L0 网关400真上限优先级更高)
      if (cap.ctx && !_config.llm.models[idx].context_length) fields.context_length = cap.ctx;
      if (Object.keys(fields).length === 0) {
        console.log('[self-report-async]', modelId, 'ignored (user explicit)');
        return;
      }
      Object.assign(_config.llm.models[idx], fields);
      _config.llm.models[idx]._vision_auto = true;
      _config.llm.models[idx]._vision_source = 'self-report';
      _config.llm.models[idx]._vision_yaml_key = modelId;
      _config.llm.models[idx]._vision_yaml_at = new Date().toISOString();
      _config.llm.models[idx]._self_report = {
        vision: cap.vision, reasoning: cap.reasoning, tool: cap.tool, ctx: cap.ctx,
        raw: r.raw_response, prompt_lang: r.prompt_used, replied_model: r.model_replied_id,
        parsed_json: r.parsed_json, at: new Date().toISOString(),
      };
      saveConfig();
      console.log('[self-report-async]', modelId, '→ v=' + cap.vision + ' r=' + cap.reasoning + ' t=' + cap.tool + ' ctx=' + cap.ctx);
    }).catch((e) => {
      console.warn('[self-report-async]', modelId, 'exception:', e.message);
    });
  }

  function _asyncProbeVision(modelId) {
    const m = (_config.llm.models || []).find(x => x.id === modelId);
    if (!m || !m.endpoint) return;  // 无 endpoint 跳过 (云端模型可能 endpoint 异常, 跳过靠正则兜底)
    const TEST_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC';
    const TEST_PNG_DATA_URL = 'data:image/png;base64,' + TEST_PNG_B64;
    // 2026-09-14 修: 同 probe-vision 端点 — 手写拼接 /v1/v1 bug, 复用共享归一化
    const endpoint = llmCaller._normalizeEndpoint(m.endpoint, m.protocol);
    const isAnthropic = m.protocol === 'anthropic' || /anthropic|claude/i.test(endpoint);
    const body_payload = isAnthropic ? {
      model: m.id, max_tokens: 800,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TEST_PNG_B64 } },
        { type: 'text', text: '这张图里是什么颜色? 用一个词回答。' }
      ]}],
    } : {
      model: m.id, max_tokens: 800,
      messages: [{ role: 'user', content: [
        { type: 'text', text: '这张图里是什么颜色? 用一个词回答。' },
        { type: 'image_url', image_url: { url: TEST_PNG_DATA_URL } }
      ]}],
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const _mKey = _resolveApiKey(m) || '';   // 第 110 批: 走统一解析链
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 2026-10-26 (第 110 批): 同上 —— 走统一解析链, 不直接读明文字段。
        ...(_mKey ? { 'Authorization': 'Bearer ' + _mKey } : {}),
        ...(isAnthropic ? { 'anthropic-version': '2023-06-01' } : {}),
      },
      body: JSON.stringify(body_payload),
      signal: ctrl.signal,
    }).then(async (resp) => {
      clearTimeout(timer);
      if (!resp.ok) return null;
      const data = await resp.text();
      const j = JSON.parse(data);
      const _msg = j.choices?.[0]?.message || {};
      // 2026-08-22 §probe-fix: 校验 response.model 是否匹配请求的 m.id
      // LM Studio (本地) bug: 模型名错了也返 200, 但 response.model 会返回真实加载的模型 (qwen3.6)
      // 如果不匹配, 说明 LM Studio 服务层临时换了模型 (不是用户加的那个), 探测结果不可信 → 不写 config
      const _respondedModel = j.model || '';
      const _exactMatch = _respondedModel && m.id && _respondedModel === m.id;
      const _looseMatch = _respondedModel && m.id && (_respondedModel.includes(m.id) || m.id.includes(_respondedModel));
      if (_respondedModel && !(_exactMatch || _looseMatch)) {
        console.warn('[vision-probe-async]', m.id, 'mismatch: requested=' + m.id + ' responded=' + _respondedModel + ', skipping');
        return 'MISMATCH';
      }
      const txt = isAnthropic
        ? (j.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ')
        : ((_msg.content || '') + ' ' + (_msg.reasoning_content || '')).trim();
      return /红|red|蓝|blue|绿|green|黄|yellow|黑|black|白|white|紫|purple|橙|orange|粉|pink|灰|gray|grey|棕色|brown/i.test(txt);
    }).then((detected) => {
      if (detected === null) return;  // 探测失败 (timeout / 非 200) → 不覆盖
      if (detected === 'MISMATCH') return;  // 模型名不匹配 (LM Studio 临时换了模型) → 不覆盖
      const idx = (_config.llm.models || []).findIndex(x => x.id === modelId);
      if (idx === -1) return;
      _config.llm.models[idx].vision = detected;
      _config.llm.models[idx]._vision_auto = true;
      _config.llm.models[idx]._vision_probe_at = new Date().toISOString();
      saveConfig();
      console.log('[vision-probe-async]', modelId, '→ vision=' + detected);
    }).catch((e) => {
      console.warn('[vision-probe-async]', modelId, 'failed:', e.message);
    });
  }

  // 2026-09-17: 子 agent 工作体现 (设置·将灵页 显示 8 将灵今日跑了多少次/最近任务/是否正在跑)
  if ((pathname === '/api/pangu/subagents/runs' || pathname === '/subagents/runs') && req.method === 'GET') {
    try {
      const runs = require('../../modules/subagent_runs');
      const d = runs.digest(3);
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify(d));
    } catch (e) { res.writeHead(500, {'Content-Type': 'application/json'}); return res.end(JSON.stringify({ok: false, error: e.message})); }
  }

  // 2026-09-28: 8 将灵专属 tool 真源 (修 UI 硬编码工具名漂移)
  // 真源 = apps/core/agents/sub-agent.js ROLES[role].tools (运行时硬约束白名单)
  // 前端 gua-roster.js 的 tools 是静态常量, 已与运行时漂移 (数量对不上/名字对不上)
  if ((pathname === '/api/pangu/subagents/roles' || pathname === '/subagents/roles') && req.method === 'GET') {
    try {
      const ROLES = require('../../agents/sub-agent').ROLES;
      // 2026-10-18: 卦象身份一起吐出来 (单一真源 GUA_ROLES)。前端以前自己硬编一份
      // 中文名表, 于是"乾是谁"在后端和前端对不上 —— 这个端点就是把那份硬编表替掉。
      const GUA_BY_CODE = require('../../agents/sub-agent').GUA_BY_CODE || {};
      const schema = require('../../modules/tools_schema').TOOLS_SCHEMA;
      const allNames = Object.keys(schema || {});
      const byCode = {};
      for (const [code, r] of Object.entries(ROLES || {})) {
        const tools = Array.isArray(r.tools) ? r.tools : [];
        const g = GUA_BY_CODE[code] || {};
        byCode[code] = {
          gua: g.gua || null,
          code: g.code || null,
          icon: g.icon || null,
          zh: g.zh || null,
          role: g.role || null,
          tools,
          count: tools.length,
          // 标注幽灵工具: 声明了但 tools_schema 里不存在的 (运行时永远调不到)
          missing: tools.filter(t => !allNames.includes(t)),
        };
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ ok: true, by_code: byCode, schema_total: allNames.length }));
    } catch (e) { res.writeHead(500, {'Content-Type': 'application/json'}); return res.end(JSON.stringify({ok: false, error: e.message})); }
  }

  // 2026-08-22: 路由评分解释 (老板拍: 盘古自动判断用模型, 用户要能看到为什么选这个)
  if ((pathname === '/api/router/explain' || pathname === '/router/explain') && req.method === 'GET') {
    try {
      const url = require('url').parse(req.url, true);
      const q = url.query.q || url.query.input || '';
      const hasImages = url.query.hasImages === '1' || url.query.hasImages === 'true';
      const strategy = url.query.strategy || undefined;
      if (!q) { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:'MISSING_QUERY', hint:'GET /api/router/explain?q=看图&hasImages=1'})); }
      const result = smartRouter.explain(q, { hasImages, strategy });
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({ ok: true, ...result }));
    } catch (e) { res.writeHead(500, {'Content-Type':'application/json'}); return res.end(JSON.stringify({ok:false, error:e.message})); }
  }

  // 404
  if (!res.headersSent) {
    res.writeHead(404, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ok: false, error: 'NOT_FOUND', path: pathname}));
  } else {
    console.warn('[http] 404 handler called but headers already sent for', pathname);
  }

}

module.exports = {
  init, handler,
// 2026-10-26 第 111 批: 启动后的延迟感知路由 (后台跑, 不阻塞监听)
  applyAutoRouting: _applyAutoRouting,
  // 2026-10-16: 导出给单测 (与 j2_agent_loop 导出 _objectiveWorkRemaining 同一做法)。
  // 这两个函数是"加模型"这条路上唯一会把"不可用"变成"可见"的地方, 必须能被钉住。
  _validateModelForAdd,
  _probeModelReachable,
};
