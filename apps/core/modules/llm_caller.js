// modules/llm_caller.js — N5 refactor batch B2: 从 pangu-single.js 抽出
// LLM 调用层 + 系统消息构建 + 记忆加载
// 依赖注入：init({ _config, fs, path, os, https, http, PRESETS, PANGU_SYSTEM_PROMPT })
// _config 是 pangu-single.js 的模块级变量，通过 init() 传入引用，保持单一真源

let _config = null;
let fs = null;
let path = null;
let os = null;
let https = null;
let http = null;
let PRESETS = null;
let PANGU_SYSTEM_PROMPT = null;
let _getPromptFacts = null;

const { route: smartRoute } = require('./router/smart_router');
const { recordSpend: recordModelSpend, checkBudget: checkModelBudget } = require('./router/cost_guard');
const { isAutoModelSelectionEnabled, isSilentFailFallbackEnabled } = require('./j2_model_policy');
const {
  enforceToolResultAdjacency: _enforceToolResultAdjacency,
  sanitizeToolPairing: _sanitizeToolPairing,
} = require('./tool_pairing');
// 2026-10-23 (第 64 批): 预算缩放规则收在 timeout_policy (唯一真源)。
const _timeout_policy = require('./timeout_policy');
// R88 老板拍: Pangu runtime 读模型商 context, 不写死 32768
const modelRegistry = require('./model_registry');
// 2026-10-25 (第 98 批): 「这个模型有什么怪癖」的唯一真源。
// 温度锁 / 输出上限 / 超时 / tool_call 原生性 / 推理预算通道 —— 都从能力层读,
// **代码不再按品牌名分支** (换厂商只加一行档案, 不改逻辑)。
const _modelCapability = require('./model_capability');
// R88-generic: 任何 model 接进来都走 model_probe 4 层 (L3/L4 骨架 + L1/L2/L5 优化)
const modelProbe = require('./model_probe');
// 2026-10-25 (第 94 批): LM Studio prompt 缓存守卫的排空闸门。
// 缓存顶满 ⇒ 命中率崩 ⇒ 同一句问在 79.9s 和 274.8s 之间跳。唯一官方重置路径是
// 卸载+重载模型 (实测 3.6 秒), 而重载期间请求会失败。
// 守卫的做法是: 把新请求**挡住排队**, 等重载完再放行 —— 而不是"等世界安静 180 秒"
// (盘古永远有活干 ⇒ 那个条件永远不成立 ⇒ 旧守卫从来没触发过)。
const cacheGuard = require('./lmstudio_cache_guard');

// 租约必须覆盖**整个响应体读完** —— 只覆盖到 headers 到达是不够的:
// 响应体还在流的时候卸载模型, 流会被掐断。
async function _gateEnter() {
  return cacheGuard.enterRequest();
}
function _gateLeave(token) {
  try { cacheGuard.leaveRequest(token); } catch (_) {}
}

// 仓库根, 运行时算, 不硬编码。
//
// 2026-10-17: 「自身源码地图」原来把仓库根写死成 `~/pangu/` —— 但这台机器上
// **~/pangu 根本不存在** (真仓库在 ~/Desktop/pangu)。于是模型照地图给的每一条路径去读,
// 必然失败; 失败后退回 search_files / find 摸路 —— 现场 tl-1792194031729 那次,
// analyzer 为找一份 models.json 花了 10 次纯搜索往返, 根子就是这条错误路径。
//
// 为什么"禁止凭印象"的铁律没兜住: 它只说了"不许猜", 没说"照这张地图读",
// 而这张地图给的还是错路径 —— 于是猜和搜都被这两头夹住, 只会更慢。
// [运行环境 — 路径铁律] 那个块早就是动态算仓库根的, 这里只是没跟上 (同一份真相抄了两遍)。
const _REPO_ROOT = (() => {
  try {
    const _p = require('path');
    const _root = _p.resolve(__dirname, '../../..');
    const _home = require('os').homedir();
    return (_home && _root.startsWith(_home)) ? '~' + _root.slice(_home.length) : _root;
  } catch (_) {
    return '<repo-root>';
  }
})();

// 节点配置路径 —— 速查表/源码地图里给模型的必须是**这台机器真实生效的那份**。
//   2026-10-26 第 108 批: 不再写死 `config/nodes/your-mac.json`
//   (那是某台机器的名字)。由 config/node_config.js 解析:
//   PANGU_NODE_CONFIG > config/nodes/node.json > config/nodes/ 下唯一的候选。
//   解析不到就回落到 <node-config>, **宁可告诉模型「去查」也不给一条假路径**
//   —— 写一条不存在的路径比不写更坏 (会反过来割自己)。
const _NODE_CONFIG_PATH = (() => {
  try {
    const _p = require('path');
    const _abs = require('../config/node_config').resolveNodeConfigPathOrExample();
    const _home = require('os').homedir();
    return (_home && _abs.startsWith(_home)) ? '~' + _abs.slice(_home.length) : _abs;
  } catch (_) {
    return '<node-config>';
  }
})();

function init(deps) {
  _config = deps._config;
  fs = deps.fs;
  path = deps.path;
  os = deps.os;
  https = deps.https;
  http = deps.http;
  PRESETS = deps.PRESETS;
  PANGU_SYSTEM_PROMPT = deps.PANGU_SYSTEM_PROMPT;
  _getPromptFacts = deps.getPromptFacts || null;
  // R88-generic round 2.5: startup hook 强制清掉所有 model.context_length (config 硬编码)
  // 防止 UI 读内存对象绕过 API filter 显示假 32K
  // autodetect 跑成功 → 设 m.context_length; 跑失败 → catch 块清 m.context_length
  // 不管哪种, 内存里永远不会有 your-mac.json 的硬编码值
  try {
    const initModels = (_config && _config.llm && Array.isArray(_config.llm.models)) ? _config.llm.models : [];
    let clearedCount = 0;
    for (const m of initModels) {
      if (m && m.context_length !== undefined) {
        delete m.context_length;
        clearedCount++;
      }
    }
    if (clearedCount > 0) console.log('[ctx-init] cleared', clearedCount, 'hardcoded context_length fields (R88-generic: probe is the only source)');
  } catch (e) { console.warn('[ctx-init] clear failed:', e.message); }

  // 2026-07-26 老板拍: "不是你配，是应该盘古直接读才对" — context_length 自动探测
  setTimeout(_autoDetectContextLengths, 3000).unref();
  // R48 小修 7/27 11:00: 删 5min watchdog — 跟 chat completion 抢 LM Studio server 资源 (凌晨 5min 规律断元凶)
  // setInterval(_autoDetectContextLengths, 5 * 60 * 1000).unref();
}

// 从 lmstudio REST API (/api/v0/models) 读 loaded_context_length, 写到内存 model.context_length
// (不落盘; 配置文件里手写 context_length 的优先, 不覆盖)
const _autoCtxIds = new Set();  // 记录哪些 context_length 是自动写的 (下次刷新可更新, 防 stale)

// 2026-10-16 (现场 v2-032551, "建 2 个文件"的任务跑了 8 分 43 秒):
//   其中 4 分 46 秒全耗在一次**已经死掉**的上游上 —— LM Studio 推理进程 2.7% CPU (= 空闲),
//   TCP 连接还 ESTABLISHED, 一个字节都不发。非流式路径上"死了"和"还在慢慢生成"在协议上
//   一模一样, 只能等 300s 空闲墙; 改成流式之后, "多久没数据算死"就成了唯一能提前判命的信号。
//   这个 90s 之前写死在两处, 既不能调, 也没法在测试里复现这个故障模式。
//   默认值不变 (90s, 对本地 27B 绰绰有余: 实测 headers 0.00s、首字节 ~1s),
//   只是变成可配 (PANGU_STREAM_IDLE_MS), 并且报错名里带上真实秒数。
function _streamIdleMs() {
  const n = parseInt(process.env.PANGU_STREAM_IDLE_MS || '', 10);
  return (Number.isFinite(n) && n > 0) ? n : 90000;
}

// 2026-10-16 (现场 clean-base2-20261016, 3 刀 analyzer 全部没能收口):
//   那个 90s 上面写的依据是「实测 headers 0.00s、首字节 ~1s, 对本地 27B 绰绰有余」。
//   那个 1s 是在**小 prompt** 下量的。真实子 agent 的 prompt 是 13.7k token
//   (tools schema 26KB + 系统块 8383 字), 本地 27B 冷 prefill 实测 45~90s 才吐第一个字,
//   而 LM Studio 是**响应头秒回、数据 90s 后才到**。于是一个健康生成在空闲计时器上
//   被判成死连接:
//
//     STREAM_IDLE_TIMEOUT_90s → destroy → fallback 到 legacy J2 XML path
//       → 同一轮重试撞上 ECONNRESET → _isInfraError 判成「端点不可用」
//         → _pickCheapestModel → 本地只剩一个 27B → 公平切**云端** k3-256k 按量计费
//           → INFRA fast-fail → assistant 空 / 「请检查网络/DNS」(端点其实好好的)
//
//   一次**纯本地**的请求, 被自己的超时判成了端点故障, 然后烧了云端的钱。
//
// 修法: 空闲预算分两段, 因为「还没吐字」和「吐着吐着不说了」是两件性质完全不同的事 ——
//   · 首字节前 (prefill): 默认 300s, 对齐非流式 socket timeout。这段没数据是**正常的**,
//     本地大 prompt prefill 就是要这么久, 不是死。
//   · 首字节后 (streaming): 90s。已经开吐了还长时间静默, 那才是真死。
// 两段的报错名也分开 (STREAM_PREFILL_TIMEOUT / STREAM_IDLE_TIMEOUT), 否则运维看到
// 「idle 90s」会以为上游挂了 90 秒, 去查上游, 方向就错了。
function _prefillMs(useModel) {
  const n = parseInt(process.env.PANGU_PREFILL_MS || '', 10);
  if (Number.isFinite(n) && n > 0) return n;
  // 跟 _buildHttpOptions / _fetchTimeoutMs 的本地默认保持一致, 免得 prefill 预算比
  // 非流式 socket 还短, 变成"流式比非流式更容易超时"这种倒挂。
  // 2026-10-25 第 98 批: 原来这里判 provider==='lmstudio' 才给 300s —— 按**品牌名**分本地/云端,
  // 于是 mlx-serve / vllm / llama.cpp / 任意自建本地端点全都只拿到 120s, 而本地大 prompt
  // 的 prefill 本来就要几百秒 (2026-10-14 已经为 mlx-serve 修过一次同类漏判)。
  // 现在按**端点事实**判 (local_model 真源): 回环 = 本地 = 长超时。
  return _modelCapability.timeoutMs(useModel);
}

// 总时长熔断是"永远不结束"的兜底, 不是延迟指标 —— 它必须比 prefill 预算宽,
// 否则流式路径会先撞总墙再撞 prefill 墙, 两段预算就没意义了。
// 本地 27B 一次 round 实测: prefill 90s + 思考 60s + 正文 60s ≈ 210s+, 300s 总墙太贴。
function _streamTotalMs(useModel) {
  const args = arguments;
  const opts = args[1] || null;
  const n = parseInt(process.env.PANGU_STREAM_TOTAL_MS || '', 10);
  let base;
  if (Number.isFinite(n) && n > 0) base = n;
  else base = Math.max(_prefillMs(useModel) + _streamIdleMs(), 300000);
  // 2026-10-23 (第 64 批): **缩放**而不是另设一个值。
  //   调用方要的是「这一轮的预算收紧一点」(超时续想时用), 不是「把全局预算改成 390s」。
  //   缩放跟 env 覆盖是**相乘**关系: 运维设了 PANGU_STREAM_TOTAL_MS 也照样生效,
  //   而调用方的收紧意图也不会被 env 吃掉。
  const scale = opts && Number.isFinite(opts.streamTotalMsScale) ? opts.streamTotalMsScale : 1;
  return _timeout_policy.scaledStreamTotal(base, scale);
}

// 2026-10-23 (第 64 批): 超时要**带着已产出的东西**走, 不能只带一个错误名。
//
// 现场 (session b63-guagate3, 12:23:48 → 12:30:08): 模型把 reasoning 推了 2980 字,
// 一个工具都没调, 390s 总预算到了 → reject(STREAM_TOTAL_TIMEOUT_390s)。
// 原来 reject 之前 `req.destroy()` 一把, **已经流出来的内容一个字都没留下** ——
// 上层拿到的只是一个错误名, 于是整轮从零重来 (实测重试的 prompt 逐字节同大小:
// msgs 12 / inputTokens 16186), 前面 2980 字思考全作废。
//
// 现在把 partial 挂在 error 上: content / toolCalls / reasonChars。
// 上层据此决定「续想 / 执行工具 / 当作答复收口」(见 j2_agent_loop 的超时分支)。
function _timeoutError(tag, ms, partial) {
  const err = new Error(tag + '_' + Math.round(ms / 1000) + 's');
  err.partial = partial || null;
  err.isTimeout = true;
  return err;
}
async function _autoDetectContextLengths() {
  // R88-generic: 任何 model (现在/未来/本地/fine-tune/小米/腾讯) 都跑 modelProbe
  // L3/L4 trial-and-error 是骨架 (vendor-agnostic, 任何 model 通用)
  // L1/L2/L5 是优化 (vendor-specific, 不知道 Pangu 仍能跑)
  // 不在 Pangu 写死 32K, 任何 model 接入零成本 (给 endpoint + chat-scope key)
  try {
    const models = (_config && _config.llm && Array.isArray(_config.llm.models)) ? _config.llm.models : [];
    for (const m of models) {
      if (!m || m.enabled === false) continue;
      if (!m.endpoint) continue;
      // 2026-09-14 修 (老板拍 #5): 非 chat 模型 (kind=video 等) 跳过聊天上下文探测 —
      // 视频生成模型没有 /chat/completions, 5 层探针全灭是必然, 还误清 context_length 刷屏报错
      if (m.kind && m.kind !== 'chat') continue;
      try {
        const { context_length, source } = await modelProbe.probeContextLength(m);
        if (typeof context_length === 'number' && context_length > 0 && m.context_length !== context_length) {
          m.context_length = context_length;
          _autoCtxIds.add(m.id);
          console.log('[ctx-autodetect]', m.id, '→', context_length, '(' + source + ')');
        }
      } catch (e) {
        // R88-generic round 2.4: probe 失败时清掉 m.context_length (config 硬编码, 跟 registry 同步)
        // 防止 UI 读内存对象绕过 API filter 显示假 32K
        if (m.context_length !== undefined) {
          console.error('[ctx-autodetect]', m.id, '→ FAILED (clearing m.context_length=' + m.context_length + ' from config, not-discoverable):', e.message);
          delete m.context_length;
        } else {
          console.error('[ctx-autodetect]', m.id, '→ FAILED (already cleared):', e.message);
        }
      }
    }
  } catch (e) { console.error('[ctx-autodetect] fatal:', e.message); }
}

// 2026-10-16: soul 基础提示词也按角色分档 (第二刀, 第一刀是 soul 附加块)。
//
// pangu-single.js 里用 <!--pangu:main-only--> ... <!--/pangu:main-only--> 标出
// 只属于主 agent 的段落, worker 渲染时整段去掉。这一块 1290 tk, 两条理由:
//
//   ① **对 worker 是错的, 不只是贵** (和 127 工具清单同一个病):
//      「你有什么(灵魂基础)」写"内部 in-process 工具 __TOOL_COUNT__ 个",
//      「你能做什么」列 gua_cast / situation_check / self_monitor ——
//      而 executor 的 schema 已被 roles 白名单收窄到 17 个, 这些它一个都调不到。
//      模型读到一份调不到的清单 → 幻觉调用 → 撞 DUPLICATE_TOOL_CALL 守门 → 白烧轮次。
//      7b5f088 已经在 soul 附加块里剔过一次同样的错, 基础提示词里这份漏了。
//   ② 它讲的是**盘古怎么面对主人 / 盘古怎么管自己**:
//      permission_grant 与 permission_apply 的主人 UI 横幅流程 (worker 白名单里
//      根本没有 permission_apply), 以及"歧义才问老板 / 拆 ≤3 个 sub-agent /
//      sub-agent 并行" —— 后者正是乾的活, 让子 agent 也去拆就等于八个都掉一样的工具。
//
// main 渲染时只是把标记本身摘掉, 其余一个字节都不动 —— 与改动前逐字相同。
const _MAIN_ONLY_BLOCK = /<!--pangu:main-only-->[\s\S]*?<!--\/pangu:main-only-->/g;
function _renderSystemPrompt(scope) {
  // 2026-10-25 (第 82 批): **planner 档也剔 main-only 段**。
  //   原来只有 worker 剔。planner (拆解轮) 是 dispatcher 派出来的主 agent,
  //   它那一轮只准调 dispatch_subagents 一个工具 —— 「你有什么 / 你能做什么 /
  //   permission_grant / 先做原则 / 上下文不可丢 / 自己调 permission_apply」
  //   这些 main-only 段讲的是**主 agent 怎么面对主人、怎么管自己**,
  //   planner 一个都用不上 (它不调 permission_apply, 不改自己的代码),
  //   而且 "上下文不可丢" 那段在拆解轮里是**反作用** ——
  //   它要求把原始用户指令注入下去, 而 planner 的活恰恰是**把任务切小**,
  //   讲"别切小"会跟 dispatcher 的铁律②(每刀自足)打架。
  const _isWorker = scope === 'worker' || scope === 'planner';
  let p = PANGU_SYSTEM_PROMPT || '';
  // 先按 scope 剔/留, 再无条件摘掉标记本身 (main 档也不能把注释发给模型)
  p = _isWorker ? p.replace(_MAIN_ONLY_BLOCK, '') : p;
  p = p.replace(/<!--\/?pangu:main-only-->\n?/g, '');
  if (!_getPromptFacts) return p;
  try {
    const facts = _getPromptFacts() || {};
    p = p.replace(/__TOOL_COUNT__/g, String(facts.toolCount != null ? facts.toolCount : '?'));
    p = p.replace(/__SKILL_COUNT__/g, String(facts.skillCount != null ? facts.skillCount : '?'));
    p = p.replace(/__SKILL_MANIFEST__/g, facts.skillManifest || '(空)');
    const mcp = facts.mcp || {};
    p = p.replace(/__MCP_TOOL_COUNT__/g, String(mcp.tools != null ? mcp.tools : '?'));
    p = p.replace(/__MCP_SERVER_COUNT__/g, String(mcp.servers != null ? mcp.servers : '?'));
    // 2026-10-09 (老板实测: 模型去读 /root/Desktop 然后答"目录为空")— 治"凭 Linux 惯性猜路径"。
    // 家目录是运行时事实, 每次替换; 模型拿到真实路径就不会再编 /root 或 /home/xxx。
    p = p.replace(/__HOME_DIR__/g, (() => { try { return require('os').homedir(); } catch (_) { return process.env.HOME || ''; } })());
  } catch (e) { /* 占位符留着也比崩好 */ }
  return p;
}

// 从 pangu_helpers 导入 (避免重复)
// 2026-10-26 第 111 批: 热路径用 safe 版 —— registry miss 时退到保守 ctx,
// 而不是抛异常把整轮对话打成 500 (现场事故: 换了新模型 id, registry 没条目 ⇒ 全挂)。
const { getModelContextLength, getModelContextLengthSafe, estimateMessagesTokens, truncateMessagesForContext, getDefaultModel } = require('./pangu_helpers');

// 2026-08-02 修 (老板拍: 盘古不能识别图片): UI 传的 images (dataURL base64) 之前在序列化时被丢弃,
// LLM 请求里根本没图, 模型自然"看不见", 还会幻觉去全盘扫图。统一在此转换:
// vision:true 的模型 → OpenAI 多模态 content blocks; 非 vision 模型 → 留文字说明, 防幻觉声称看到了图。
function _adaptImagesForModel(out, m, useModel) {
  if (m.role !== 'user' || !Array.isArray(m.images) || m.images.length === 0) return out;
  // vision 未标注时自动识别 (model_capabilities), 兜底非 pangu-single 入口的 model 对象
  let _vision = useModel.vision;
  if (_vision === undefined) {
    try { _vision = require('./model_capabilities').detectVision(useModel); } catch (e) { _vision = false; }
  }
  if (_vision) {
    const blocks = [];
    if (typeof out.content === 'string' && out.content.trim()) blocks.push({ type: 'text', text: out.content });
    // 2026-08-02 修 (老板发纯图无文字 → MiniMax 400 'chat content is empty' → 连接中断实案):
    // content 数组必须带非空 text block, 不能只发 image_url
    if (blocks.length === 0) blocks.push({ type: 'text', text: '（主人发了一张图片，未附文字。请直接看图，描述图里是什么。）' });
    for (const img of m.images) {
      let url = typeof img === 'string' ? img : (img && (img.url || img.data_url || img.dataURL));
      // 2026-08-03 (老板拍: 图落盘架构): 落盘路径 → 发模型前才读成 base64
      // data: 开头 = 已是 base64 直接用; 绝对路径/file:// = 读盘转换, 读不到跳过并在日志留痕
      if (url && !url.startsWith('data:')) {
        try {
          const fs = require('fs');
          const fp = url.replace(/^file:\/\//, '');
          const buf = fs.readFileSync(fp);
          const ext = (fp.split('.').pop() || 'png').toLowerCase();
          const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/png';
          url = `data:${mime};base64,${buf.toString('base64')}`;
        } catch (e) { console.warn('[llm] 图片读盘失败, 跳过:', url, e.message); continue; }
      }
      if (url) blocks.push({ type: 'image_url', image_url: { url } });
    }
    if (blocks.length > 0) out.content = blocks;
  } else {
    out.content = (typeof out.content === 'string' ? out.content : '') +
      `\n[系统提示: 用户附了 ${m.images.length} 张图片, 但当前模型 ${useModel.id} 未开启视觉 (config 里 vision:true 缺失), 图片未发送给模型。不要声称看到了图片内容, 如实告诉主人此模型不支持看图。]`;
  }
  return out;
}

function _loadLongTermMemory() {
  try {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const memPath = path.join(os.homedir(), '.pangu', 'memory', 'MEMORY.md');
    if (!fs.existsSync(memPath)) return null;
    const content = fs.readFileSync(memPath, 'utf8');
    // 限制 4000 chars (≈ 1500 tokens),避免爆 context
    if (content.length > 4000) {
      return content.slice(0, 4000) + '\n\n...(MEMORY.md 已截断,主人可查询完整版 ~/.pangu/memory/MEMORY.md)';
    }
    return content;
  } catch (e) {
    return null;
  }
}

function _loadToolSummary(callableTools, soulScope) {
  // P2: 加载 80 工具清单到 system prompt,让 Pangu 知道自己能用什么
  // 从 modules/tools_schema.js 读 TOOLS_SCHEMA,只取 name + description + required params,控 6000 chars
  //
  // 2026-10-24 (第 79 批): **清单必须按"这一轮真能调的集"出, 不许出全量**。
  //
  // 现场 (实跑 probe79-moeduan, LM Studio 日志 + [agent-llm] 行):
  //   这份清单列出**全部 130 个**工具, 而 main 的 API schema 只给 **38** 个
  //   (MAIN_GENERAL_TOOLS_FOR_LLM, 实跑 [agent-llm] tools: 38 逐行对得上)。
  //   ⇒ **92 个工具模型看得见、调不到**。
  //   实测其中 **69 个任何将灵都调不到** (buildRoleToolFilter 逐角色算, 全是空) ——
  //   它们既不在 main 的 38 个里, 也不在 kan/li/dui/xun/kun/zhen/qian/gen 任何一档的白名单里,
  //   连执行表 TOOLS 里都有 (137 个) ⇒ 是**纯死工具**: 清单在教模型去调一堵墙。
  //
  // 为什么这是**正确性 bug**而不只是贵:
  //   模型读到 "web_fetch(url)" 就在清单里, 但 API schema 里没有它 ⇒ 它一调就撞
  //   "tool not found" / 白圈, 白烧一整轮本地推理 (~40s), 再被防重复守门拦。
  //   这跟 worker 档 2026-10-16 修过的病是**同一个** (那边是"子 agent 拿着 127 个的清单,
  //   schema 只有 17 个"), 只是 main 档当时漏了。
  //
  // 为什么贵:
  //   这块本身 12238 字符 ≈ **5563 token**, 而主 agent 整个静态前缀才 ~19.3k token
  //   (system 9570 + 38 个 schema 9680)。而 LM Studio 的 prompt cache 磁盘
  //   **100% 满** (166680/166720 MiB), 生命周期已驱逐 **561 GB**, 命中率只有 58%
  //   ⇒ 首轮 prefill 干等 **62 秒** (实跑 SSE: 0s→62s 才出第一个 token)。
  //   砍掉这 5.5k 幽灵前缀, 是把首轮等待压下来的**最便宜的一刀**。
  //
  // 口径: 清单给的是**这一轮这个角色真能调的**。
  //   ① main 档 ⇒ MAIN_GENERAL_TOOLS_FOR_LLM (38 个, 与 API schema 同一份真源)
  //   ② worker 档 ⇒ 整个块都不进 (见下面 keepForWorker=false, 2026-10-16 已修)
  //   ③ 不许靠"截断"糊弄: 该出的一个都不许少 (名字+必填参数全量, 沿用 2026-10-12 的分层)
  try {
    // M15: 直接 require 模块 — 旧正则解析嵌套 schema 会跨边界误匹配 (description 含单引号即崩)
    const { TOOLS_SCHEMA, MAIN_GENERAL_TOOLS_FOR_LLM } = require('./tools_schema');
    // 这一轮真能调的集 —— 与 j2_agent_loop 的 API schema **同一份真源**。
    // 判据不许另写一份 (两处两个名单 = 迟早漂), 直接取 MAIN_GENERAL_TOOLS_FOR_LLM。
    //
    // 2026-10-24 (第 80 批): `callableTools` 是**更精确**的口径 ——
    //   拆解轮 (dispatcher 的 _planViaMainAgent) 走 role='main' + toolsAllowed=['dispatch_subagents'],
    //   它的 API schema 只有 **2 个**工具 (dispatch_subagents + task_done),
    //   但清单给它的是 main 档的 **38 个** —— 而它一个都调不到。
    //   实测 (probe79-mcp 日志): 拆解轮那一刀 in=16893 token, 其中清单占 6042 字符 ≈ 2115 token,
    //   整刀 **183.7 秒**。
    //   ⇒ 判据是「**这一轮真能调的**」, 而 toolsAllowed 比角色档更准。传了就用传的。
    const _byRole = Array.isArray(MAIN_GENERAL_TOOLS_FOR_LLM) && MAIN_GENERAL_TOOLS_FOR_LLM.length
      ? new Set(MAIN_GENERAL_TOOLS_FOR_LLM)
      : null;
    // 调用方传了「这一轮真能调的集」⇒ 以它为准 (它是 API schema 的同源口径);
    // 没传 ⇒ 退回角色档 (main 38 个 / worker 整块不进, 见下面 keepForWorker=false)。
    //
    // ⚠ **传了但是空数组 ≠ 没传**: 空数组是「这一轮一个工具都调不到」
    //   (summary / alignment-retry / 判官这些收口调用, tools=[]),
    //   此时清单必须**空** —— 给它一份角色档清单 = 教模型去调它调不到的工具。
    //   「没传」(undefined) 才是「不知道, 用角色档兜底」。
    const _callable = Array.isArray(callableTools)
      ? new Set(callableTools)
      : _byRole;
    // 这一轮一个工具都调不到 (收口调用: summary / alignment-retry / 判官, tools=[])
    // ⇒ **整块清单都不出**。出「0 个工具」的壳子没意义, 而「你调不到、但可以派给
    // 别的将灵」那段更不该出 —— 它在教一个不能派活的收口调用去派活。
    if (_callable && _callable.size === 0) return '';
    const _entries = Object.entries(TOOLS_SCHEMA).filter(([name]) => !_callable || _callable.has(name));
    const allNames = _entries.map(([name]) => name);
    const lines = [`# 工具清单 (这一轮你**实际能调**的 ${allNames.length} 个 in-process 工具,可调 sandbox 执行)`];
    lines.push('');
    // 2026-10-12 (实测: 问'查一下英伟达股价'→ 零工具调用): 原来整块硬限 6000 字符,
    // 全量带说明要 9344 字节 → 只塞得下 89 个, **38 个工具模型完全不知道存在**,
    // 其中就有 stock_resolve / stock_quote / tts_speak。能力在, 模型看不见。
    // 拆成两层: ① 全量「名字(必填参数)」一条都不许截断 —— 模型至少知道有哪些工具、
    // 该传哪个参数名 (stock_quote 的必填是 code 不是 symbol, 传错就 BAD_CODE);
    // ② 说明层单独给预算, 截断只截它。全量名字层只要 3137 字节, 放得下。
    lines.push(`## 全部工具 (${allNames.length} 个, 一个都不能少 — 看不到就永远不会去调)`);
    lines.push('');
    for (const [name, schema] of _entries) {
      const fn = schema && schema.function;
      const req = (fn && fn.parameters && Array.isArray(fn.parameters.required) ? fn.parameters.required : []).join(',');
      lines.push(`- ${name}(${req || '无必填'})`);
    }
    lines.push('');
    lines.push('## 工具说明 (按注册顺序, 尾部可能被截断 — 名字与必填参数以上面那份全量清单为准)');
    lines.push('');
    for (const [name, schema] of _entries) {
      const fn = schema && schema.function;
      if (!fn || !fn.description) continue;
      let desc = String(fn.description);
      if (desc.length > 80) desc = desc.slice(0, 80) + '...';
      const req = (fn.parameters && Array.isArray(fn.parameters.required) ? fn.parameters.required : []).join(',');
      lines.push(`- **${name}**(${req || '无必填'}): ${desc}`);
    }
    // 2026-10-24 (第 79 批): **别的将灵能调、但你调不到的那些**, 单独一段并**标明归属**。
    //
    // 为什么不能整段砍掉: 主 agent 的活是**派活** —— 它得知道"查网页该派谁"
    // (web_fetch 只有 li 能调 / weather_check 只有 dui 能调)。砍了这层, 派活就退化成瞎派。
    //
    // 为什么不能留在主清单里: 留在同一段 = 跟"你能调的"混在一起 ⇒ 模型直接去调 ⇒ 撞
    // "tool not found" 白烧一轮本地推理 (~40s), 再被防重复守门拦。
    //
    // 所以: 移出主清单, 但**保留名字 + 标明能调的将灵** ⇒ 想调就派给那个将灵。
    //
    // 判据: 只收「某个将灵的白名单里真有它」的 —— 那 69 个**谁都不能调的死工具**
    // (translate_text / send_wechat / git_commit / screenshot / computer_use_* …)
    // 一并消失, 不再教模型去撞墙。
    //
    // 2026-10-24 (第 80 批): 这段是**派活参考** —— 只在「这一轮能派活」时才有意义。
    //   拆解轮 (toolsAllowed=['dispatch_subagents']) 的可调集里**有** dispatch_subagents,
    //   但它那一轮的任务是「拆 + 派」, 不是「这一轮真去派」——
    //   段里那几十个「→ 派给 kun/li/…」对它纯噪音 (它拆出来的刀由别人去派)。
    //   判据: **可调集被收窄过** (不是角色档的默认 38 个) ⇒ 这一轮是被关进笼子的,
    //   派活参考层不出 —— 笼子里的模型不该被教「你可以派给别的将灵」。
    //   判据落在这里, 不是注释里: 收窄过 ⇒ 不出这一段。
    const _narrowed = Array.isArray(callableTools) && callableTools.length > 0
      && (!MAIN_GENERAL_TOOLS_FOR_LLM || !MAIN_GENERAL_TOOLS_FOR_LLM.every(n => callableTools.includes(n)));
    try {
      const shared = require('./j2_loop_shared');
      const _roleNames = ['kun', 'li', 'dui', 'xun', 'zhen', 'gen'];
      const _owned = [];
      for (const _r of (_narrowed ? [] : _roleNames)) {
        let _s = null;
        try { _s = shared.buildRoleToolFilter(_r, undefined, true); } catch (_) { _s = null; }
        if (!_s || !_s.size) continue;
        for (const _n of _s) {
          if (_callable && _callable.has(_n)) continue;          // 你自己能调的, 上面已列
          if (!TOOLS_SCHEMA[_n]) continue;
          let _hit = _owned.find((x) => x.name === _n);
          if (!_hit) { _hit = { name: _n, roles: [] }; _owned.push(_hit); }
          _hit.roles.push(_r);
        }
      }
      if (_owned.length) {
        lines.push('');
        lines.push(`## 你调不到、但**可以派给别的将灵**的工具 (${_owned.length} 个)`);
        lines.push('');
        lines.push('**这些你直接调会失败** (不在你的 API schema 里) —— 要用就派给对应的将灵。');
        lines.push('');
        for (const _o of _owned) {
          const _sch = TOOLS_SCHEMA[_o.name];
          const _fn = _sch && _sch.function;
          const _req = (_fn && _fn.parameters && Array.isArray(_fn.parameters.required) ? _fn.parameters.required : []).join(',');
          let _d = String((_fn && _fn.description) || '');
          if (_d.length > 60) _d = _d.slice(0, 60) + '...';
          lines.push(`- **${_o.name}**(${_req || '无必填'}) → 派给: ${_o.roles.join('/')}${_d ? ' — ' + _d : ''}`);
        }
      }
    } catch (e) { /* 派活参考层拿不到就不给, 不许拖垮主清单 */ }
    // 2026-07-26 老板拍: MCP 工具段 (跟内部工具分开列, 调用名 mcp__<server>__<tool>)
    //
    // 2026-10-24 (第 80 批): 这段原来**无条件**列出全部 MCP 工具, 而
    //   (a) main 的 API schema 里 **0 个** MCP 工具 (第 79 批定的「MCP 只给 worker」)
    //       ⇒ main 看得见 44 个 MCP 工具名, 一个都调不出来 —— **第 79 批那个病的残留**;
    //   (b) 只读角色按 mcp_tool_exec 的只读名单收窄, 但提示词这里没收窄。
    // 修法: **复用 _mcpSchemasForLLM(role)** —— 它就是 API schema 那一侧用的同一个函数,
    //       提示词跟 schema 用同一份名单, 不会再漂。
    //       worker 档整块本来就不进 (keepForWorker=false), 所以这里只管 main 档。
    try {
      const _role = (soulScope === 'worker') ? 'worker' : 'main';
      const _mcpSchemas = _mcpSchemasForLLM(_role);
      if (_mcpSchemas && _mcpSchemas.length) {
        lines.push('');
        lines.push(`# MCP 工具 (${_mcpSchemas.length} 个 — 外部进程, 调用名格式 mcp__<server>__<tool>)`);
        lines.push('');
        for (const s of _mcpSchemas) {
          let mdesc = String((s.function && s.function.description) || '');
          if (mdesc.length > 60) mdesc = mdesc.slice(0, 60) + '...';
          lines.push(`- **${s.function.name}**: ${mdesc}`);
        }
      }
      // main 档: API schema 里没有 MCP 工具 ⇒ 提示词也不列 (第 79 批定的「只给 worker」)
    } catch (e) {}
    let result = lines.join('\n');
    // 硬限挪到 12000 chars: 名字层 3137 + 说明层 6000 + MCP 段, 仍在 ~3.6k tokens 内,
    // 换来 38 个工具从'完全隐身'变成'有名字有参数'。原来的 6000 会砍掉名字层的一半。
    if (result.length > 12000) {
      result = result.slice(0, 12000) + '\n\n...(已截断,完整版见 modules/tools_schema.js)';
    }
    return result;
  } catch (e) {
    return null;
  }
}

// 2026-10-24 (第 79 批): **MCP 工具必须进 API schema** —— 提示词写着"MCP 工具…跟内部工具
// 一样直接用", 但 native 路径的 toolsSchema 只从 TOOLS_SCHEMA 取, 而 TOOLS_SCHEMA 里
// `mcp__` 开头的工具是 **0 个** ⇒ 模型看得见 44 个 MCP 工具的名字, 一个都调不出来。
// (执行层是通的: pangu-single 的 executeToolCalls 有 `mcp__` 前缀路由 → mcp_adapter。
//  断的是**签名**: 模型没法给一个不在 tools 里的工具签名。)
//
// 为什么**不**把 44 个 MCP 的完整 schema 原样塞进去:
//   实测 (直连 github-mcp / filesystem-mcp 量, /tmp/mcp_full_measure.js):
//   44 个工具的 name+description+parameters = **11527 token**, 其中 parameters 占 7346。
//   而 main 现有的 38 个内部工具 schema 才 9680 token —— 塞进去等于 prefill 从 19.3k
//   涨到 30.8k, **正好是本批要治的病**。
//
// 所以: **parameters 精简成空对象, 参数说明搬进 description**。
//   · 模型照样看得见工具、知道大概干什么、能签出调用 (这是关键 —— 之前根本签不出)
//   · 真实参数由 MCP server 自己校验: 传错 → MCP_CALL_FAILED, 错误信息带回上下文,
//     模型据此改一次即可 (跟内部工具的参数报错同一条回路)
//   · 体积: 44 个 ≈ 2195 token (实测 /api/mcp/tools), 而不是 11527
//
// 参数说明从哪来: MCP server 的原始 inputSchema 里 required + property 名。
// 这些是要紧信息 (owner/path/repo 之类), 丢了模型就得靠猜。
function _mcpSchemasForLLM(role) {
  try {
    const mcpAdapter = require('./mcp_adapter');
    if (!mcpAdapter._collectAllToolSchemas) return [];
    const raw = mcpAdapter._collectAllToolSchemas() || [];
    // 2026-10-25 (第 82 批): **main 档一律不给 MCP 工具**。
    //   原来这里只按 isReadOnlyRole 过滤, 而 isReadOnlyRole('main') 返回 **false**
    //   (NON_GUA_ROLES 里含 'main' —— 主循环不受将灵只读边界约束)。
    //   结果 main 拿到**全部** MCP schema。
    //
    //   而 main 的 API schema 里**一个 MCP 工具都没有**:
    //   j2_agent_loop.js 的 `_roleForThisLoop !== 'main'` 那一行决定
    //   MCP 工具只挂给 worker (第 79 批定的「MCP 只给 worker」)。
    //   提示词这侧却列了 44 个 —— **看得见调不到**, 跟第 79 批修的是同一个病,
    //   只不过漏在了提示词这一侧。
    //
    //   现场证据 (会话 39268686 的主会话落盘): main 档「工具清单」10851 字里,
    //   有一段 "# MCP 工具 (44 个 — 外部进程…)", 而同一轮 [agent-llm] 行的
    //   tools=38 —— **38 个里 0 个是 MCP**。
    //
    //   ⚠ 这条判据必须落在**函数**上, 不能靠调用点自觉 ——
    //   提示词侧和 schema 侧必须用同一个函数 (那是第 80 批定的同源原则),
    //   所以修在这里, 两边一起干净。
    if (role === 'main') return [];
    const schemas = raw.map((s) => {
      const fn = (s && s.function) || {};
      const params = fn.parameters || {};
      const props = params.properties || {};
      const propNames = Object.keys(props);
      const required = Array.isArray(params.required) ? params.required : [];
      let desc = String(fn.description || '');
      const paramHint = [];
      for (const p of propNames) {
        const t = (props[p] && (props[p].type || (props[p].enum ? 'enum' : ''))) || '';
        const req = required.includes(p) ? '必填' : '可选';
        paramHint.push(`${p}(${t || '?'},${req})`);
      }
      if (paramHint.length) {
        desc += ' [参数: ' + paramHint.join('; ') + ']';
      }
      return {
        type: 'function',
        function: {
          name: fn.name,
          description: desc,
          // 刻意给空 parameters: 真参数说明已在 description 里, 体积从 11527 降到 ~2200
          parameters: { type: 'object', properties: {}, additionalProperties: true },
        },
        _mcp: true,
        _mcpServer: s._mcpServer,
        _mcpToolName: s._mcpToolName,
        _timeout: s._timeout,
      };
    });
    // 2026-10-24 (第 79 批): **只读角色只看得见只读的 MCP 工具**。
    //   内部工具靠角色白名单收窄 (buildRoleToolFilter), MCP 不在白名单里 ⇒
    //   只读角色 (analyzer/checker/...) 看得见 write_file / create_or_update_file,
    //   而它连这些工具的**存在**都不该知道 —— 看得见 = 会被叫, 会被叫就可能写盘。
    //   判据在 mcp_tool_exec (名单外的叶子按"会改状态"处理, fail-closed);
    //   执行层还有 action_policy 兜着, 这里是第一层。
    try {
      const _isRO = require('../agents/gua-identity').isReadOnlyRole(role);
      if (_isRO) {
        const { isMcpMutatingTool } = require('./mcp_tool_exec');
        return schemas.filter(s => {
          const _n = s && s.function && s.function.name;
          return !_n || !isMcpMutatingTool(_n);
        });
      }
    } catch (e) { /* 判定不了就按原样给 (执行层还有闸) */ }
    return schemas;
  } catch (e) {
    return [];
  }
}

// 2026-10-15: _loadEvolutionStats 的 5 分钟 TTL 记忆 (见函数内注释)。
// 目的只有一个 —— 让注入 system prompt 的静态前缀在一次对话的若干轮之间保持逐字不变,
// 否则 LM Studio 的 prompt 缓存每一轮都作废, 每轮重算一万多 token。
let _evoCache = null;

function _loadEvolutionStats() {
  // P3: 读 ~/.pangu/evolution/*.jsonl (L1 dogfooding 数据),聚合今日统计
  // 返回 summary + insights,注入 system prompt 第 4 段
  //
  // 2026-10-15: 加 5 分钟 TTL 记忆。原因是它注入在 system prompt 里, 而表头那行
  // "快照 at 2026-10-15 08:36:12 UTC" 是**每次调用现取的当前时间** —— 一轮对话里
  // 每秒都在变, 等于又在 8000 token 静态前缀中间插了一枚会走的书签, 把后面所有内容
  // 的 prompt 缓存全部作废 (和上面「当前时间」那条同一个病, 换个位置犯第二次)。
  // 5 分钟粒度对"今日成功率/平均耗时"这种统计毫无影响, 但前缀稳定了。
  const _now = Date.now();
  if (_evoCache && (_now - _evoCache.at) < 5 * 60 * 1000) return _evoCache.text;
  try {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    // 2026-10-26 第 100 批: 账本目录走唯一真源 (modules/evolution_paths.js)
    const { evolutionDir } = require('./evolution_paths');
    const evoDir = evolutionDir();
    if (!fs.existsSync(evoDir)) return null;
    const today = new Date().toISOString().slice(0, 10);
    const todayFile = path.join(evoDir, today + '.jsonl');
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const yFile = path.join(evoDir, yesterday + '.jsonl');

    let records = [];
    for (const f of [todayFile, yFile]) {
      if (fs.existsSync(f)) {
        const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try { records.push(JSON.parse(line)); } catch (e) { console.warn('[pangu] _loadEvolutionStats JSON.parse error:', e.message); }
        }
      }
    }
    if (records.length === 0) return null;

    // 聚合
    const today_recs = records.filter(r => r.ts && r.ts.startsWith(today));
    const all = today_recs.length > 0 ? today_recs : records;
    const total = all.length;
    const success = all.filter(r => r.success === true).length;
    const successRate = total > 0 ? (success / total * 100).toFixed(0) : '?';
    const durations = all.filter(r => typeof r.duration_ms === 'number').map(r => r.duration_ms);
    const avgMs = durations.length > 0 ? Math.round(durations.reduce((a,b) => a+b, 0) / durations.length) : '?';

    // 工具统计
    const toolCounts = {};
    for (const r of all) {
      const tools = r.tool_names || [];
      for (const t of tools) toolCounts[t] = (toolCounts[t] || 0) + 1;
    }
    const topTools = Object.entries(toolCounts).sort((a,b) => b[1]-a[1]).slice(0, 5)
      .map(([n, c]) => `${n}(${c})`).join(', ') || '无';

    // 错误模式
    const errCounts = {};
    for (const r of all) {
      if (r.error) {
        const key = String(r.error).slice(0, 40);
        errCounts[key] = (errCounts[key] || 0) + 1;
      }
    }
    const topErrors = Object.entries(errCounts).sort((a,b) => b[1]-a[1]).slice(0, 3)
      .map(([e, c]) => `${e}(${c})`).join('; ') || '无';

    // 跨日总览
    const allFiles = fs.readdirSync(evoDir).filter(f => f.endsWith('.jsonl'));
    const allTotal = allFiles.reduce((sum, f) => {
      try {
        const content = fs.readFileSync(path.join(evoDir, f), 'utf8');
        return sum + content.split('\n').filter(Boolean).length;
      } catch (e) { return sum; }
    }, 0);

    // 2026-08-18: 按模型拆分 (老板反馈: 5 次调用 4 次失败全是 qwen3.6,报'20% 成功'会误导他以为是全盘失败)
    const byModel = {};
    records.forEach(r => {
      const m = r.model || 'unknown';
      if (!byModel[m]) byModel[m] = { total: 0, success: 0, ms: 0 };
      byModel[m].total += 1;
      if (r.success) byModel[m].success += 1;
      byModel[m].ms += (r.duration_ms || 0);
    });
    const _byModelLines = Object.entries(byModel).sort((a,b) => b[1].total - a[1].total)
      .map(([m, s]) => {
        const _sr = s.total ? Math.round((s.success / s.total) * 100) : 0;
        const _avg = s.total ? Math.round(s.ms / s.total) : 0;
        return `  - \`${m}\`: ${s.total} 次 / 成功 ${s.success} (${_sr}%) / 平均 ${_avg}ms`;
      }).join('\n');

    const _snapshotAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const _text = `# Pangu 自我进化数据 (L1 dogfooding) — 快照 at ${_snapshotAt}\n\n` +
      `**重要**: 这是 system prompt 注入时的**快照**,不是实时数据。本次请求执行后会产生新的 dogfooding 记录(写入 ${today}.jsonl),但本数据**不包含**本次会话后续工具调用。\n\n` +
      `## 今日 (${today})\n` +
      `- 调用次数: ${total}\n` +
      `- 成功率: ${successRate}%\n` +
      `- 平均延迟: ${avgMs}ms\n` +
      `- Top 工具: ${topTools}\n` +
      `- Top 错误: ${topErrors}\n\n` +
      `## 今日按模型拆分 (避免单模型失败污染整体成功率)\n${_byModelLines}\n\n` +
      `## 累计 (全期 ${allFiles.length} 天)\n` +
      `- 总调用: ${allTotal}\n\n` +
      `---\n\n` +
      `**运用规则**: 1) 主人问你"自我进化 / dogfooding / 失败率"时,自动从这里报数据。2) 但必须**注明**这是快照 + 快照时间点,不要让主人误以为是实时。3) 当主人要"跑个 dogfood 测试",建议用 scripts/dogfood-*.sh (在 ~/.pangu/scripts/) 启动。4) 报成功率时**优先引用按模型拆分**(避免 qwen3.6 之类已弃用模型拉低整体数字)。`;
    _evoCache = { at: _now, text: _text };
    return _text;
  } catch (e) {
    return null;
  }
}


// 2026-07-26 (老板 12:03 截图 HTTP 400): qwen3.6 jinja 模板要求第一个非 system 消息必须是 user
// UI 静态 greeting ("开天辟地") 和错误气泡 ("✗ HTTP 400...") 都是 assistant 角色排在最前 → 模板炸
// 实验实证: [sys,assistant,user] ❌ / [sys,user,assistant,user] ✅
// 修: 1) 第一个 user 之前的 assistant 全丢  2) ✗ 开头的错误气泡不进历史
function _sanitizeMessages(messages) {
  const filtered = (messages || []).filter(m =>
    !(m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().startsWith('✗')));
  const firstUserIdx = filtered.findIndex(m => m.role === 'user');
  if (firstUserIdx > 0) {
    return filtered.filter((m, i) => m.role === 'system' || i >= firstUserIdx);
  }
  return filtered;
}

// system 块的"身份": 判断两条 system 是不是同一块。
//
// 2026-10-15: 用它折叠重复注入的 soul 块 (见 _injectSoulSysMsgs), 同时也是
// [prompt-profile] 诊断的判据 —— **必须同一个函数**, 否则诊断和去重按两套标准跑,
// 诊断就会报"没有重复"而实际还在叠, 那这道诊断等于没有。
//
// 三个坑都是实测踩出来的:
//   ① 不能用全文: 「当前时间」按分钟取整, 两次构建跨分钟内容就不同,
//      按全文去重抓不到 (实测同一次请求里并存 23:17 与 23:18 两份)。
//   ② 只截前 24 字也不够: 工具清单首行是「# 工具清单 (Pangu 拥有的 127 个 …」,
//      那个计数正好落在第 21 位, 127→129 就换了身份 → 4291 token 照样叠两份
//      (实测 total 只从 26655 降到 20540, 就是漏了它)。
//   ③ 所以**先把数字归一化**再截断: 身份代表"这是哪一块", 不代表"这一块的第几版"。
//      块首都是稳定且互不相同的标题 (# 当前时间 (权威) / # 工具清单 / # 主人长期记忆 …),
//      归一化数字既不会让不同块撞上, 又能让同一块的不同版本认成同一块。
//   ④ 2026-10-24 (第 79 批实测): 只截前 24 字**仍然不够** —— 截的是**措辞**。
//      工具清单首行本来是「# 工具清单 (Pangu 拥有的 127 个 …」, 第 79 批把它改成
//      「# 工具清单 (这一轮你**实际能调**的 38 个 …」, 前 24 字随之变了 ——
//      于是同一块的新旧两份认成两块, 4291 token 的工具清单**照样叠两份**。
//      教训: 身份必须认**标题** (第一个括号之前, 那才是"这块是什么"),
//      括号里的措辞会随版本变 (措辞变了不该等于换了一块)。
//      计数保留但归一化 (127/129/38 → 同一个 #), 这样"计数变了仍是同一块"这条继续成立,
//      数字归一化也仍然是**载荷** (拆掉它 ⇒ 127 与 129 判成两块 ⇒ 叠两份 ⇒ 测试咬人)。
function _sysBlockIdentity(content) {
  if (typeof content !== 'string') return '';   // 多模态数组等没有可比首行, 宁可不参与
  const firstLine = content.trim().split('\n')[0];
  if (!firstLine) return '';
  const _title = firstLine.split('(')[0].trim();
  const _count = (firstLine.match(/\d+/g) || [])[0] || '';
  const _id = (_title || firstLine.slice(0, 24)) + (_count ? ' ' + _count : '');
  return _id.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

// 2026-10-16 (老板: "子 agent 只做自己相关的, 做好汇报, 这个跟你应该是一样的"):
// soul 提示词分两档。worker 档 = 子 agent 实际收到的提示词, 只保留它真正用得上的块。
//
// 实测代价 (一个只跑 `df -h` 的 executor, 画像来自 /tmp/pangu-single.log):
//   0-7:system=9918   ← 整套 soul, 其中:
//       # 工具清单 (Pangu 拥有的 127 个 …)  4291
//       # 主人长期记忆                       1462
//       # 连续改进 / Continual Harness        518
//       # Pangu 自我进化数据                   347
//       # 自身源码地图                         221
//       # 持久目标                             152
//       # L3 自适应提示                        178
//       基础 soul prompt                     3063
//  10:system=242     ← 它自己的角色提示, 只有 242
//
// 也就是说**主 agent 的上下文是角色提示的 40 倍**。而且工具清单那 4291 不只是贵,
// 是**错的**: 子 agent 的 API schema 已经被 roles 白名单收窄到 17 个工具
// (j2_dispatcher toolsAllowed → j2_agent_loop _buildRoleToolFilter),
// 提示词却告诉它有 127 个 —— 这是在主动教模型去调它调不到的工具。
//
// worker 档保留什么 (allowlist, 刻意不是 blocklist):
//   ① 基础 soul prompt —— 工具协议/输出格式, 拿掉风险太高, 先留着
//   ② 推理预算         —— "本轮怎么答"的设定, 才 33 token
//   ③ 当前时间         —— 答"现在几点"要用, 45 token
// 丢掉的是: 工具清单(错的)、主人长期记忆(主人的, 不是 worker 的)、
// 源码地图(盘古自述, worker 不自述)、连续改进/自我进化(主 agent 的反馈闭环)、
// 持久目标、L3 提示。
// GLOBAL_AGENT_RULES(全局铁律, 3880) 走的是另一条注入路径, **不进这里** ——
// 那几条纪律恰恰是 worker 最该有的(失败要明说/必须调工具/未完成禁止说完成)。
//
// 为什么是 allowlist: 新增 soul 块时默认落在 worker 档之外。
// 万一漏配, 最坏是 worker 少拿一块提示; 反过来用 blocklist 的话,
// 每次加块都要记得同步一份黑名单, 忘了就是每个子 agent 每轮白背一遍。
function _buildSystemMessages(useModel, soulScope, callableTools) {
  // 2026-10-25 (第 82 批): **三档** soul 分发。
  //   main    — 主对话。一字不少 (逐字跟拆分前相同)。
  //   planner — 拆解轮 (dispatcher 让主 agent 派活的那一轮)。
  //   worker  — 子 agent。
  //
  // 为什么必须有 planner 这一档 (现场 39268686 实测):
  //   拆解轮拿的是 **main 档** soul —— 主人长期记忆 / 工具清单 / 自我进化 /
  //   源码地图 / 关键路径速查 / Continual Harness / 持久目标 全都下发,
  //   外加 6358 字的全局铁律 + 自我认知 + 跨会话上下文,
  //   实测那一轮 in=15366 token。而它这一轮真能调的只有 **2 个工具**
  //   (dispatch_subagents + task_done), 产出上限是「拆不拆 / 拆几刀」。
  //   工具清单按 callableTools 收窄已经是对的, 但**其余那些块跟拆解无关**,
  //   而且「跨会话上下文」那段实测把**兄弟刀 prompt** (带主人全量路径清单)
  //   整份灌进了拆解轮 —— 拆解轮的任务是**切小**, 喂它上一刀的原文只会
  //   让它照抄上一轮的切法。
  //
  // ⚠ 掩码从布尔 (keepForWorker) 换成三档字符串 —— 布尔表达不了
  //   「main 要、worker 不要、planner 要」这种三选二。
  //   掩码用 'main' / 'worker' / 'planner' 三字母, 缺的字母 = 那一档拿不到。
  //   **main 那一格永远是全集**: main 档是"一个字节都不少"的契约,
  //   任何块缺 'main' 就是事故 (见 tests/soul-scope-worker-20261016.test.js)。
  const _scope = soulScope === 'planner' ? 'planner' : (soulScope === 'worker' ? 'worker' : 'main');
  const _isWorker = _scope === 'worker';
  const _isPlanner = _scope === 'planner';
  const sysMsgs = [];
  const _workerKeep = new Set();
  const _plannerKeep = new Set();
  // _push(msg, mask): mask 是三档字母串, 例如 'main' (只有 main 拿) /
  // 'main worker' (main + worker) / 'main planner worker' (三档全要)。
  // 缺省 = 'main' —— 新加的块漏配时, 最坏结果只是少一档拿到 (跟 worker
  // 当年那个 allowlist 约定同一个方向: 漏配往严了判, 不往松了判)。
  const _push = (msg, mask) => {
    const _m = (mask === undefined || mask === null) ? 'main' : String(mask);
    sysMsgs.push(msg);
    if (_m.indexOf('worker') >= 0) _workerKeep.add(msg);
    if (_m.indexOf('planner') >= 0) _plannerKeep.add(msg);
  };
  const _finish = () => {
    if (_isWorker) return sysMsgs.filter(m => _workerKeep.has(m));
    if (_isPlanner) return sysMsgs.filter(m => _plannerKeep.has(m));
    return sysMsgs;
  };
 // §0.13 dogfooding: PANGU_TEST_MODE=1 跳过持久记忆 / tools summary 注入
 // 让老板测试 Pangu 行为时从干净状态开始, 不被历史污染
  const isTestMode = process.env.PANGU_TEST_MODE === '1';
  if (isTestMode) {
    console.log('[pangu] TEST_MODE=1 detected, skipping long-term memory injection');
    _push({
      role: 'system',
      content: _renderSystemPrompt(soulScope) + '\n\n---\n\n[TEST_MODE] 长期记忆 / tools summary / MEMORY.md 全部不注入, 从干净状态开始测试。',
    }, 'main worker planner');
    // 预算不是"记忆类"注入, TEST_MODE 也要带 ——
    // 老板在测试模式下量的正是这个效果, 不带就量不到。
    const _testBudget = _reasoningBudgetInstruction(useModel);
    if (_testBudget) _push({ role: 'system', content: _testBudget }, 'main worker planner');
    return _finish();
  }
  _push({ role: 'system', content: _renderSystemPrompt(soulScope) }, 'main worker planner');
  // 2026-08-12 §R131-Phase3: L3 自适应 hint (跟 j2_agent_loop 共用 l2-miner.getL2Hint, 按天缓存)
  try {
    const _l2Hint = require('../scripts/l2-miner.js').getL2Hint();
    if (_l2Hint) {
      _push({
        role: 'system',
        content: '# L3 自适应提示 (L2 聚合今日异常)\n\n' + _l2Hint + '\n\n---\n\n**运用规则**: 上述警告来自今日 L1 调用聚合, 反映真实运行状况, 不是推断。',
      }, 'main');   // 主 agent 的今日异常聚合, worker 不需要, planner 也不需要
    }
  } catch (_) { /* L2 不存在或损坏 — 静默跳过 */ }
  // 2026-07-26: 权威时间注入 (治 LLM 用记忆里的旧时间回答"现在几点/今天几号")。
  //
  // 2026-10-15: 这条原本排在 messages[1] —— 每次调用都重算, 秒级变化。
  // 而 prompt 缓存只认**从头开始的公共前缀**, 它一变, 排在它后面的
  // 工具清单(3599tk) + MEMORY(1222tk) + 源码地图 + 自我进化 + 目标 ……
  // 全部当新 token 重算。LM Studio 服务端日志实测:
  //   Prompt cache restore: cached_tokens=10240 uncached_tokens=18425
  //                        lifetime_efficiency=58.99%
  // 一次"只回答两个字"的三轮, 两轮之间各卡 45~47s, 卡的就是这个 ——
  // 心跳一直有 (连接活着), 但 token 在安静地重新 prefill。
  // 配套证据: VLM prompt cache disk usage used_mib=41576.6 / cap_mib=41680.0,
  // 99.75% 满 + lifetime_evicted_mib=13397.3 —— 缓存被反复驱逐, 越抖动越慢。
  //
  // 修: 挪到末尾。内容一字不改, 照样每次新鲜 (该治的"用旧时间回答"没被牺牲),
  // 但它不再插在 12000 token 静态前缀的中间把它打断。缓存只失效末尾几十 token。
  let _nowText = '';
  try {
    // 取整到分钟。不是为了省字符, 是为了**跨轮稳定**: 一次三轮的工具往返要几十秒,
    // 秒级时间戳会让每轮的 [8] 都不一样, 于是排在它后面的整段对话历史也跟着
    // 全部重算。分钟粒度对"回答现在几点/今天几号"完全够用 (主人不会问 16:34:59),
    // 但同一轮对话里它逐字不变, 缓存能一路吃到本轮末尾。
    const _d = new Date();
    _d.setSeconds(0, 0);
    _nowText = _d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  } catch (e) {}
  const mem = _loadLongTermMemory();
  if (mem) {
    _push({
      role: 'system',
      content: `# 主人长期记忆 (自动加载 ~/.pangu/memory/MEMORY.md)\n\n${mem}\n\n---\n\n**运用规则**: 主人提到历史决策 / 铁律 / 项目 / 偏好时,自动从这里取,不要重新问主人。`
    }, 'main');   // 主人的偏好/历史是**主 agent**的上下文, worker 只知道自己那一件事
    // 2026-10-25 (第 82 批): planner 也不拿 —— 拆解轮判的是"这活能不能切、
    //   怎么切", 它不需要知道主人过去偏好什么。给了反而是干扰:
    //   主人长期记忆里有"不啰嗦/直接给方案"这类**答复风格**偏好,
    //   而拆解轮的产出是**结构化的刀**, 不是给主人的答复。
  }
  const tools = _loadToolSummary(callableTools, soulScope);
  if (tools) {
    _push({
      role: 'system',
      content: tools + '\n\n---\n\n**运用规则**: 主人让你做任何事情,你都要**真做** —— 该调工具调工具,该读文件读文件,该跑命令跑命令。不要只动嘴说要做什么,**直接做**,完成后报结果。如果需要 sandbox 检查(路径白名单/危险命令拦截)会自动化,不用主人手动授权。**例外**: 破坏性动作(rm -rf / 系统文件 / sudo)会被 sandbox 拦,你应该改为安全写法或告诉主人手动跑。'
    }, 'main');
    // 2026-10-25 (第 82 批): planner 也不拿。
    //   现场 39268686: 拆解轮那轮 in=15366, 工具清单占 1875 字, 而它
    //   **真能调的只有 2 个** (dispatch_subagents + task_done)。
    //   清单虽然已经按 callableTools 收窄到"这一轮真能调的 2 个"(第 80 批修的),
    //   但对拆解轮仍然是**多余的一层**: 它的 API schema 里只有这两个工具,
    //   schema 本身就是权威清单, 提示词再说一遍是重复。
    // 2026-10-16: 工具清单**不进 worker 档**, 而且这一块对 worker 是**错的**, 不只是贵 ——
    // 子 agent 的 schema 已被 roles 白名单收窄 (实测 executor 只拿到 17 个),
    // 这里却告诉它"Pangu 拥有的 127 个 in-process 工具"。
    // 模型读到的是一份它调不到的清单 → 幻觉调用, 而真幻觉出来的调用还会触发
    // DUPLICATE_TOOL_CALL / 重试守门, 白烧好几轮。
    // 真要让它知道有什么工具, 靠的是 API schema, 不是这段自然语言清单。
  }
  const evo = _loadEvolutionStats();
  if (evo) {
    _push({ role: 'system', content: evo }, 'main');   // 主 agent 的自我进化闭环快照
  }
  // 2026-08-02 老板实证: 盘古凭印象否认自己的 64i 二进制映射层 (真实存在于 apps/core/64i/) — 自身问题必须查证
  _push({
    role: 'system',
    content: '# 自身源码地图 (回答"关于你自己"的问题前必读, 禁止凭印象)\n\n' +
      '- 64卦本体 + 6-bit 二进制映射层: `' + _REPO_ROOT + '/apps/core/64i/` (hexagram_vector.js 二进制↔卦象, symbol_table.js 64卦本体, hexagrams.js 卦表)\n' +
      // 2026-10-12: 原来是硬编码的 117, 与真实清单 (127) 对不上 —— 同一段上下文里
      // 模型会读到三个不同的工具数。改成实时数, 免得再化石化。
      '- 工具实现 (' + (() => { try { return Object.keys(require('./tools_schema').TOOLS_SCHEMA).length; } catch (e) { return '若干'; } })() + ' 个, 权威清单见上面「工具清单」): `' + _REPO_ROOT + '/apps/core/modules/tools/index.js`\n' +
      '- 主循环/调度: `' + _REPO_ROOT + '/apps/core/modules/j2_agent_loop.js`, `j2_dispatcher.js`\n' +
      '- 系统配置: `' + _NODE_CONFIG_PATH + '`\n' +
      '(代码在 apps/core/ 下 — 注意 64i 在 apps/core/64i/, 不是仓库根的 64i/)\n\n' +
      '**铁律 (自身问题)**: 主人问"你自己/你的工具/64卦/架构/源码/能力"时, 必须先用 list_directory / read_file / memory_search 查证再答。' +
      '没查证就直说"我还没查过, 现在查"然后立刻调工具 — **禁止凭印象承认或否认任何自身设计** (你有前科: 否认过真实存在的 64i 二进制映射层)。'
  }, 'main');   // 盘古**自述**用的, worker 不自述盘古是谁
  // 2026-10-17 (现场 tl-1792194031729): 上面那块「自身源码地图」是 keepForWorker=false,
  // **worker 拿不到**。于是子 agent 一接到"查清楚模型池里有哪些模型"就得自己摸路 ——
  // 实测 analyzer 花了 **search_files ×7 + file_grep ×2 + list_directory ×1** 才定位到
  // apps/core/modules/router/models.json, 而它只需要 read_file 一次。
  // 「禁止凭印象」的铁律是对的, 但只给了"不许猜"没给"去哪查", 模型就只能搜。
  // 这一块**主 agent 和 worker 都给** (keepForWorker=true): 路径是静态的, 不影响前缀缓存,
  // 几百字符换掉 10 次搜索往返很划算。只列真正高频的几个, 不是完整目录树。
  _push({
    role: 'system',
    content: '# 关键路径速查 (别用 search_files 摸路, 直接读)\n\n' +
      '- **模型池 / 路由真源**: `' + _REPO_ROOT + '/apps/core/modules/router/models.json`\n' +
      '  (每个模型的 id / provider / api_base / tier / enabled 都在这里; 问"模型池有哪些模型"\n' +
      '   "哪些是本地端点" "默认用哪个" 一律先读它, 别搜)\n' +
      '- **宿主节点配置** (当前这台机器实际生效的那份): `' + _NODE_CONFIG_PATH + '`\n' +
      '- **运行时用户配置**: `~/.pangu/config.json` · 模型登记表 `~/.pangu/models-registry.json`\n' +
      '- **代码根**: `' + _REPO_ROOT + '/apps/core/modules/` (工具实现 `tools/index.js`, 提示词 `llm_caller.js`,\n' +
      '  全局铁律 `global_agent_rules.js`, 角色与工具 `agents/sub-agent.js`)\n\n' +
      '**运用规则**: 上表里有的路径直接 read_file, 不许先 search_files / find 去"找找看"。\n' +
      '真的不在表里才搜, 且搜到之后**不要把这条路径硬背下来当规律** —— 以文件内容为准。'
  }, 'main worker');   // 主 agent + worker 都要: 子 agent 最需要的就是"别摸路"
  //   planner 不拿: 拆解轮**不读文件** —— 它只派活, 活的内容由子 agent 去摸路。
  //   现场 39268686: 拆解轮那轮这块占 230 字, 对"切几刀"这个判断零贡献。
  // 2026-08-16 P0-A: Continual Harness (supplemental, 可被 /refine 改 + snapshot rollback)
  // base prompt 不动, 只追加 harness state (refine.js 写入 ~/.pangu/state/harness/global.json)
  try {
    const refine = require('../agents/refine');
    const _harness = refine.loadHarness();
    if (_harness.entries && _harness.entries.length > 0) {
      const _recent = _harness.entries.slice(-15); // 注入最近 15 条, 避免 context 爆
      const _lines = _recent.map((e, i) => `${i + 1}. [${e.kind}] ${e.content} (${e.source} @ ${e.ts})`);
      _push({
        role: 'system',
        content: '# 连续改进 / Continual Harness (supplemental, /refine 写入)\n\n'
          + '以下是从历史 trajectory 自动提取的经验, **必须** 在未来任务中应用:\n\n'
          + _lines.join('\n')
          + '\n\n---\n\n**运用规则**: 遇到相似场景时, 主动参考以上 lesson/policy/skill_hint.\n'
          + '如果新任务出现以上 lesson 涉及的错误, 立即改正并继续.\n'
          + '如果发现 harness 里某条已过时 (主人反馈 / 跟新约束冲突), 通过 POST /api/pangu/refine 提供 trajectory 来更新.',
      }, 'main');   // 主 agent 的反馈闭环, 不是 worker 的
    }
  } catch (_) { /* refine 模块未加载或 harness 文件不存在 — 静默跳过 */ }
  // 2026-08-16 P0-B: 持久目标 / Persistent Goal (Prime Agent /goal 对位) — 注入 most-recent active goal
  try {
    const goal = require('../modules/goal');
    const _activeGoals = goal.listGoals().filter(g => g.status === 'active');
    if (_activeGoals.length > 0) {
      const _latest = _activeGoals[0];
      const _rendered = goal.renderGoalForSession(_latest.session_id);
      if (_rendered) _push({ role: 'system', content: _rendered }, 'main');
    }
  } catch (_) { /* goal 模块未加载或目录不存在 — 静默跳过 */ }
  // 2026-10-15: 本地模型的 reasoning_effort 字段没人收, 预算改走提示词层。
  // 放最后 —— 它是"本轮怎么答"的设定, 必须离用户消息最近才压得住,
  // 排在 soul / 长期记忆前面会被那 8000 token 冲淡 (见 _reasoningBudgetInstruction 的实测)。
  const _budget = _reasoningBudgetInstruction(useModel);
  if (_budget) _push({ role: 'system', content: _budget }, 'main worker planner');   // "本轮怎么答", 三档都要
  // 权威时间同样放末尾 (挪下来的原因见上面 _nowText 那段):
  // 每轮新鲜 ≠ 每轮必须插在静态前缀中间。它留在 [1] 就是一秒一刀,
  // 砍掉后面所有内容的前缀缓存。
  if (_nowText) {
    _push({
      role: 'system',
      content: `# 当前时间 (权威)\n\n${_nowText} (Asia/Shanghai)\n\n---\n\n**运用规则**: 回答涉及"现在/今天/当前时间/几点"时以此为准, 禁止用记忆或历史对话里的旧时间。`,
    }, 'main worker planner');
  }
  return _finish();
}

// 温度优先级 — 端点锁死 > model.temperature > llm.temperature > 1.0
function _resolveTemperature(model) {
  // 2026-10-25 第 98 批: 原这里是 "kimi 系特判" —— 按品牌名 (provider/id/endpoint 三个条件
  // 各抄一份) 判定哪些端点物理上只收 temperature=1。那个问题是真的, 但**判据不该是品牌**:
  // 任何"只接受固定温度"的端点都该走同一条路, 不该只有 kimi 被写进代码。
  // 现在: 端点锁死的能力从 model_capability 真源读 (配置显式字段 > 厂商档案 > 默认)。
  // 温度意图顺序保持不变: model.temperature > 全局 llm.temperature > 1.0。
  // ⚠️ _config 在 init() 之前是 null —— 旧代码因为 kimi 命中就提前 return, 走不到这里;
  //   去掉品牌特判后必须自己防住空配置 (否则未 init 就调 = TypeError)。
  const _desired = (model && typeof model.temperature === 'number')
    ? model.temperature
    : (_config && _config.llm && typeof _config.llm.temperature === 'number' ? _config.llm.temperature : undefined);
  return _modelCapability.temperatureFor(model, _desired);
}

function _isLocalModel(useModel) {
  // 2026-10-23 第 71 批: 判定收进 local_model 唯一真源。
  // 这份曾经是"同一份旧正则的第三份副本"(IPv6 [::1] 和 127/8 都漏), 后来改成复用
  // api_key_resolver —— 现在连那一层中间件也不用绕了, 直接问真源。
  //
  // 2026-10-26 第 102 批收尾 (交叉审 P3-1): **端点事实优先**。
  // 真源那份 isLocalModel 是 provider 名单**优先于**端点事实 ⇒
  //   {provider:'lmstudio', endpoint:'https://api.example.com/v1'} 会被判成「本地」
  //   ⇒ reasoning_effort='none' 被发给**云端**网关
  //   ('none' 不是 OpenAI 规范里的值, 云端网关常直接 400)。
  // 101 批在别处治好了「provider 名字不许压过端点事实」这个病, 唯独这条推理通道漏了。
  // 现在: 端点能解析就端点说了算 (回环 = 本机服务器); 端点解析不了才退回 provider 名单。
  try {
    const lm = require('./local_model');
    const ep = lm.endpointOf(useModel);
    if (ep && lm.hostOf(ep)) return lm.isLoopbackEndpoint(ep);
    return lm.isLocalModel(useModel);
  } catch (_) { return false; }
}

// 2026-10-26 第 102 批收尾 (交叉审 P1-1): 「提示词层推理预算」这条通道
// 也按**自建**口径放开 (回环 + 内网 + 显式声明)。
//
// 理由: 开源推理服务 (ollama / vllm / llama.cpp / mlx / sglang) 在现实里
// 部署在另一台机器上 (192.168.x.x), 地址是内网 ⇒ 原来落在 _isLocalModel
// 的判据之外 ⇒ 推理预算分档在它身上**从来没生效过** (LM Studio 那份生效,
// 因为它在本机)。同一台 vLLM, 放在本机就生效、搬到内网就失效, 这不是模型差异。
//
// ⚠️ 只放开**提示词层**这一条通道 (纯文本, 不改请求体形状, 不会 400)。
//    wire 上的 reasoning_effort 字段映射 ('off' → 'none') 仍然只认本机/回环 ——
//    'none' 不是 OpenAI 规范里的值, 往内网网关发可能整轮 400, 风险不对等。
function _isSelfHosted(useModel) {
  try { return require('./model_capability').isSelfHostedByEndpoint(useModel); } catch (_) { return false; }
}

function _shouldSendReasoningEffort(useModel) {
  // LM Studio accepts an explicit disabled-mode value; cloud gateways commonly
  // reject disabled-mode values, so omit them there.
  return _isLocalModel(useModel);
}

// OpenAI Responses/Chat 规范的六档, 外加 Pangu 自己的 'off'(= 不思考)。
// UI 的「自动」是 'auto', **不在**这个集合里 —— 见 _wireReasoningEffort。
const _VALID_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'off']);

function _wireReasoningEffort(useModel) {
  const effort = useModel && useModel.reasoning_effort;
  if (!effort) return null;
  // 白名单, 不是黑名单: 界面用 'auto' 表示「自动」(ChatRoom 的推理强度选择器),
  // 那是**界面占位符**不是 API 值, 漏到线上就是
  // "Invalid 'reasoning_effort' value: 'auto'" → 整轮 400。
  // 只认 OpenAI 规范里的六个值; 认不出的宁可不下发这个字段 —— 少一个字段
  // 只是回到默认强度, 多一个错值是整轮死掉。
  if (!_VALID_REASONING_EFFORTS.has(effort)) return null;
  // LM Studio/Qwen names the disabled mode `none`; Pangu's UI uses `off`.
  return _isLocalModel(useModel) && effort === 'off' ? 'none' : effort;
}

// 2026-10-15 (老板: "同样的模型, codex 和 openclaw 都比盘古快"):
// reasoning_effort 对本地模型是**空转的**。LM Studio 服务端日志逐条自证:
//   [WARN][qwen3.8-27b-mlx] No valid custom reasoning fields found in model
//   'lmstudio-community/Qwen3.8-27B-MLX-6bit'. Reasoning setting 'medium'
//   cannot be converted to any custom KVs.
// 即字段原样发出去, 模型侧没有任何东西接收它 —— 老板 2026-09-14 拍的分档
// ("模型不自动选, 只有推理强度可自动") 在本地模型上从来没生效过。
//
// N=5 实测 (同一句 "现在几点了？", soul + 32 tools, 直连 LM Studio):
//   无 effort                        中位 2.9s  思考中位 35  5 次 gen [51,40,51,51,51]
//   reasoning_effort=low (API 字段)   中位 3.2s  思考中位 41  ← 无效果, 甚至更慢
//   提示词层推理预算指令              中位 2.2s  思考中位 24  5 次 gen 全是 40
// 快 24%, 而且**方差也消掉了** —— 基线在 40~51 之间抖, 加了指令后 5 次一模一样。
// 那个抖动就是主人感受到的"跟死了一样": 同样一句问, 有时 40s 有时 123s。
//
// 所以本地模型改走提示词层表达预算。分档语义沿用原来的 low/medium/high/off,
// 只是换一个真正收得到的通道 —— 不是新增能力, 是让既有分档从空转变成生效。
function _reasoningBudgetInstruction(useModel) {
  // 2026-10-26 第 102 批收尾: 本机 → 自建 (回环 + 内网)。
  // 内网自建推理服务上的 thinking 模型, 推理预算分档现在才真正收得到。
  if (!_isSelfHosted(useModel)) return null;
  const effort = String(useModel && useModel.reasoning_effort || '').trim();
  if (!effort) return null;
  if (effort === 'off') {
    // 本机走 wire 的 'none' 表达 (见 _wireReasoningEffort), 提示词层不重复说。
    // 内网自建收不到 'none' 这个值 ⇒ 用提示词层表达「不思考, 直接答」。
    if (_isLocalModel(useModel)) return null;
    return '[推理预算: 关] 直接给结论, 不要展开分析、不要自我质疑、不要铺垫。';
  }
  if (effort === 'low') {
    return '[推理预算: 低] 先判断需不需要工具, 需要就直接调, 不需要就一句话答完。'
      + '不要展开分析、不要自我质疑、不要复述问题、不要为简单问题做长篇推演。';
  }
  if (effort === 'medium') {
    return '[推理预算: 中] 需要工具就先调, 需要判断就给一两句关键理由。'
      + '不要把内部推演写进正文, 不要重复已经确认过的事实。';
  }
  if (effort === 'high') {
    return '[推理预算: 高] 复杂判断可以展开, 但结论必须落在具体证据上。'
      + '简单问题仍然直接答, 不要为了显得严谨而拉长。';
  }
  return null;
}

// 2026-07-26 老板拍: "盘古 maxTokens 上限 4096 肯定不对" — reasoning 模型 (qwen3.6) 思考就烧 3-8K,
// 4096 会直接把正文挤没. 推导规则: cap = model.max_tokens (配置覆盖) > registry 窗口 > 4096;
// 再按 provider 输出参数上限 clamp (窗口预算 ≠ 输出参数).
// 实际 maxTokens = clamp(ctx - inputTokens, 1024, cap); 截断预留 = min(cap, ctx/2) 保证 input+output ≤ ctx
//
// 重要：context_length 是输入+输出总窗口，不是单次输出预算。模型没有显式
// max_tokens 时，不能把整个窗口直接当成输出上限；LM Studio 的 262K 模型
// 因而会收到 254K 的 max_tokens，请求看似“卡住”而实际在生成超长 reasoning。
// 通用默认沿用 router 的 32K 输出预算；有显式 max_tokens 或厂商 cap 时仍以
// 用户/厂商约束为准。
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;
function _maxTokensCap(useModel) {
  // 2026-10-25 第 99 批: 输出预算的**合并**全部交给能力层
  // (model_capability.maxOutputTokens), 那里是四层语义的真源:
  //   显式声明 > 请求意图 (被硬上限 clamp) > 硬上限 > 软默认 > 预算 > 兜底。
  //
  // 旧版这里自己算了一遍 (显式值 / registry 窗口 / 厂商 cap 三者取小),
  // model_transport.outputTokenCap 又算了一遍 —— 两份已经开始漂移
  // (transport 那份只认 minimax/agnes, 而且显式值不取 min ⇒ minimax 传
  // max_tokens=32768 直接 HTTP 400)。现在只剩一份口径。
  //
  // 本函数只负责**本调用方特有**的那部分: registry 探到的上下文窗口预算。
  // registry 探到的是"输入窗口预算", 不能直接当 max_tokens 发给 API。
  const explicitCap = Boolean(useModel && typeof useModel.max_tokens === 'number' && useModel.max_tokens > 0);
  let budget = null;
  if (!explicitCap) {
    // R88: registry 优先 (Pangu runtime 读, 不再 silently 32K)
    const reg = useModel && useModel.id ? modelRegistry.getContextLength(useModel.id) : null;
    if (!reg) {
      // 没 registry 没手配时，使用保守的输出预算，而不是拒绝服务。
      console.warn('[max-tokens-cap] no context info for', useModel && useModel.id, '— using default output cap', DEFAULT_MAX_OUTPUT_TOKENS);
    }
    // Registry 只描述总上下文窗口；无显式输出上限时，默认限制为 32K，
    // 但不超过已探得的总窗口。这样本地/中转 OpenAI 兼容模型不会收到
    // 数十万 max_tokens，同时仍支持小上下文模型。
    budget = Math.min(reg || DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS);
  }
  return _modelCapability.maxOutputTokens(useModel, DEFAULT_MAX_OUTPUT_TOKENS, budget);
}
function _truncateReserve(useModel) {
  return Math.min(_maxTokensCap(useModel), Math.floor(getModelContextLengthSafe(useModel) / 2));
}
function _resolveMaxTokens(useModel, inputTokens) {
  return Math.min(_maxTokensCap(useModel), Math.max(1024, getModelContextLengthSafe(useModel) - inputTokens));
}

// API Key 优先级 — model.api_key (非空非***) > credentials.js > 环境变量 > ''
// 解析链提取到 modules/api_key_resolver.js, 与 model_probe 共用同一条链
const { resolveApiKey: _resolveSharedApiKey, _PROVIDER_CRED_KEYS, _credKeyFor, _API_KEY_PLACEHOLDERS } = require('./api_key_resolver');
const modelTransport = require('./model_transport');

function _resolveApiKey(useModel) {
  return _resolveSharedApiKey(useModel);
}

// 用户照抄软件显示的 base URL (http://127.0.0.1:1234), 盘古自动补 OpenAI 兼容路径
// 本地 server (LM Studio/Ollama/vLLM/llama.cpp) 只显示 host:port, 用户不该知道要补 /v1/chat/completions
// 用户照抄软件显示的 base URL, 盘古不拼接路径 (§老板拍 2026-08-17: 拼接 = bug 源)
// 用户必须在添加模型时填完整 endpoint (含 /chat/completions 或 /messages)
// 这里只校验,不做任何拼接
// §老板拍 2026-08-17: 用户填厂家给的简化 URL (e.g. "https://api.openai.com/v1"),
// 盘古自动判断协议 (OpenAI 兼容 / Anthropic 兼容) + 补完整路径
// 判断规则:
//   1. URL 含 anthropic.com → Anthropic 协议 → 补 /v1/messages
//   2. URL 已有 /chat/completions 或 /messages → 用户手动填完整,直用
//   3. URL 含 /v{N} (OpenAI/Kimi/Moonshot/LM Studio) → OpenAI 兼容 → 补 /chat/completions
//   4. URL 没 /v{N} (localhost:1234, api.anthropic.com) → 看域名,anthropic → /v1/messages,否则 → /v1/chat/completions
// §老板拍 2026-08-17: 用户选协议 + 填简化 URL,盘古按协议自动补全
//   openai     → OpenAI 兼容  → /chat/completions 或 /v1/chat/completions
//   anthropic  → Anthropic 兼容 → /messages 或 /v1/messages
//   ollama     → Ollama 本地  → /api/chat
//   custom     → 自定义       → 不补全,直用
//   已有 /chat/completions 或 /messages 结尾 → 用户已填完整,直用
function _normalizeEndpoint(baseUrl, protocol) {
  return modelTransport.normalizeEndpoint(baseUrl, protocol);
}

// ============================================================
// M10: 公共构建块 — callLLM / _callLLMForAgentRaw / _callLLMForAgentStream 三处复用
// (2026-08-23 重构: 消除 model 解析/灵魂注入/消息适配/body 构建/路径补全/超时守护 的三份拷贝)
// ============================================================

// 解析模型 + endpoint + 协议 + 温度 (三入口统一前置)
function _resolveCallContext(modelConfig) {
  const useModel = modelConfig || getDefaultModel();
  if (!useModel) throw new Error('No model available');
  // 不再读 _config.llm.openai_api_key (已废弃, 防止旧 key 残留被复用)
  const apiKey = _resolveApiKey(useModel);
  // 2026-08-18: 接受 api_base (router) 或 endpoint (config) — 之前只有 endpoint → router 出来的 model 全 fallback 到 openai_base_url
  const protocol = modelTransport.normalizeProtocol(useModel);
  const baseUrl = _normalizeEndpoint(modelTransport.endpointOf(useModel, _config.llm.openai_base_url), protocol);
  const isAnthropic = modelTransport.isAnthropic(useModel);
  const temperature = _resolveTemperature(useModel);
  return { useModel, apiKey, baseUrl, protocol, isAnthropic, temperature };
}

// 2026-10-14: 本地端点模型名失配自愈。
// oMLX 只认 "Qwen3.8-27B-4bit", 池里存着 "mlx-community_qwen3.8-27b-4bit" 时
// 端点回 404 并**在错误正文里直接列出可用模型**。之前这句话原样抛上去, 整轮死。
// 现在: 捞出真名 → 换名重试一次 → 顺手把正确的名字写回池, 下次不用再撞。
async function _withModelNameSelfHeal(fn, modelConfig, args) {
  const selfheal = require('./model_name_selfheal');
  try {
    return await fn(...args);
  } catch (e) {
    if (!selfheal.looksLikeModelMissing(e)) throw e;
    const healed = await selfheal.healModelConfig(e, modelConfig, _resolveCallContext);
    if (!healed) throw e;
    _persistHealedModelName(modelConfig, healed);
    return await fn(...args.map((a) => (a === modelConfig ? healed : a)));
  }
}

// 把纠正后的名字写回池 —— 否则每次调用都要先撞一次 404。
function _persistHealedModelName(original, healed) {
  try {
    if (!original || !_config || !_config.llm || !Array.isArray(_config.llm.models)) return;
    const entry = _config.llm.models.find((m) => m && m.id === original.id);
    if (!entry) return;
    if (entry.id === healed.id) return;
    console.warn('[model-name-selfheal] 池内条目改名 ' + entry.id + ' -> ' + healed.id);
    const oldId = entry.id;
    entry.id = healed.id;
    entry.name = healed.name || healed.id;
    entry.api_model = healed.api_model;
    // 改名会留下悬空的 current_model_id: 池里再没有这个 id, getCurrentModel
    // 会静默退到 "enabled 第一个" —— 用户明明选的就是这条模型。
    if (_config.llm.current_model_id === oldId) {
      _config.llm.current_model_id = healed.id;
      console.warn('[model-name-selfheal] current_model_id 跟着改: ' + oldId + ' -> ' + healed.id);
    }
    const save = require('./pangu_helpers').saveConfig;
    if (typeof save === 'function') save();
  } catch (e) {
    console.warn('[model-name-selfheal] 写回池失败(不阻断): ' + (e.message || e));
  }
}

// ==== 模型名失配自愈包装 (2026-10-14) ====
// 三个真实实现各自包一层: 撞 404 且错误正文指明"模型没找到"时,
// 问端点要真名, 换名重试一次, 并把正确名字写回池。
async function callLLM(messages, modelConfig) {
  const token = await _gateEnter();
  try {
    return await _withModelNameSelfHeal(_callLLMImpl, modelConfig, [messages, modelConfig]);
  } finally {
    _gateLeave(token);
  }
}

async function _callLLMForAgentRaw(messages, modelConfig, toolsSchema, opts) {
  const token = await _gateEnter();
  try {
    return await _withModelNameSelfHeal(_callLLMForAgentRawImpl, modelConfig, [messages, modelConfig, toolsSchema, opts]);
  } finally {
    _gateLeave(token);
  }
}

// 流式版是 async generator, 错误在迭代时才抛 —— 包装必须包住"迭代"而不是"调用"。
//
// 2026-10-24 (第 80 批): opts 必须接住并传下去 ——
//   原来这个函数的签名只有 3 个参数, 而调用方 (j2_agent_loop 生产主路径) 传了第 4 个
//   ({signal, sessionId}) ⇒ **整个 opts 被静默丢掉**。
//   第 80 批要加的 callableTools (清单跟 schema 对齐) 就住在 opts 里, 丢掉就等于没接。
async function* _callLLMForAgentStream(messages, modelConfig, toolsSchema, opts) {
  const selfheal = require('./model_name_selfheal');
  let healed = false;
  const token = await _gateEnter();
  try {
    for (;;) {
      try {
        yield* _callLLMForAgentStreamImpl(messages, modelConfig, toolsSchema, opts);
        return;
      } catch (e) {
        if (healed || !selfheal.looksLikeModelMissing(e)) throw e;
        const next = await selfheal.healModelConfig(e, modelConfig, _resolveCallContext);
        if (!next) throw e;
        healed = true;
        _persistHealedModelName(modelConfig, next);
        modelConfig = next;
      }
    }
  } finally {
    _gateLeave(token);
  }
}


// Pangu 灵魂注入: P0+P1 — 在最前面插入 system messages (身份 + 长期记忆)
// 老板已经传过的 system 消息保留 (但我们的灵魂在最前,优先级最高)
// 2026-10-15: 登记「会变的 system 块」。它们必须排在所有静态 system 之后,
// 否则每次一刷新, 排在它们后面的全部内容的 prompt 前缀缓存一起作废。
//   ① 「当前时间 (权威)」  — 每分钟变 (原位置 idx 8, 后面压着 4829 token 静态块)
//   ② 「自我进化数据」    — 5 分钟 TTL 刷新 (原位置 idx 3, 后面压着约 11000 token)
// 新增会变的 system 块时, 必须登记到这里, 否则等于又往静态前缀中间插书签。
const _VOLATILE_SYS_RE = /^# 当前时间 \(权威\)|^# Pangu 自我进化数据/;

function _injectSoulSysMsgs(messages, useModel, soulScope, callableTools) {
  const soulSysMsgs = _buildSystemMessages(useModel, soulScope, callableTools);
  //
  // 2026-10-15 (现场, "跟死了一样"的最后一块): 调用方 (pangu_agent_stream.js:139)
  // 已经拼过一遍 soul messages, 这里又拼一遍 —— 而原实现把**所有** system 消息
  // 都当"调用方自己传的"原样留下, 于是上一步刚拼进去的那一份也被留下, 叠成两份。
  //
  // 实测画像: 主人的请求 95 token, 实际送进模型 26,655:
  //   0-7:system=9885   ← 一整份 soul prompt
  //   8:system=5990     [运行环境 — 路径铁律] (j2_agent_loop 传的, 不是 soul 块)
  //   9-16:system=9885  ← 逐字重复
  //   20:user=95
  // 约 10,300 token (39%) 是纯重复。本地 27B prefill ~285 tok/s → 光 prefill ~93 秒,
  // 实测 duration_ms=92554, 一个 token 还没生成就超时了 → 界面表现就是"跟死了一样"。
  //
  // 为什么不能顺手把 pangu_agent_stream.js 那次注入删掉: 那份 soul 消息在那条链路里
  // 是**唯一**副本 (auto-resume / prior-turns / 落盘都从 messages 里读), 删了就是静默
  // 削指令 —— 正是这批 bug 同一族的错法。所以在这里去重: 谁注入的不管, 保证**最终
  // 发给模型的请求里每块只有一份**, 且保留刚构建的那份 (更新鲜)。
  //
  // 判据见模块级 _sysBlockIdentity: 块首 + 数字归一化。按全文去重抓不到跨分钟的
  // 「当前时间」, 只截 24 字又抓不到 127→129 的工具清单 —— 那个计数就在第 21 位。
  const soulIds = new Set(soulSysMsgs.map(m => _sysBlockIdentity(m.content)).filter(Boolean));
  const userPassedSysMsgs = (messages || []).filter(m => {
    if (m.role !== 'system') return false;
    const id = _sysBlockIdentity(m.content);
    if (id && soulIds.has(id)) {
      console.warn('[llm] 折叠重复 soul 块: "' + id + '" —— 调用方已注入过一份, 不再叠第二份 (省 prefill)');
      return false;
    }
    return true;
  });
  const nonSysMsgs = (messages || []).filter(m => m.role !== 'system');
  // 2026-10-15: _buildSystemMessages 把「当前时间」放在**它自己的**最后一条, 看着已经挪到底了 ——
  // 但这里的组装顺序是 [soul][调用方传的 system][对话], 而调用方 (j2_agent_loop native 路径)
  // 传进来的那条 system 前面粘着 _getGlobalRules() (实测 4829 token)。
  // 结果时间落在 idx 8, 那 4829 token 静态块在 idx 9 —— 分钟一跳, 时间变了,
  // 后面这 4829 个 token 的前缀缓存一起作废 (LM Studio: lifetime_efficiency)。
  // 实测画像 (14912 token): 8:system=45 当前时间 | 9:system=4829 运行环境+全局铁律。
  // 修: 时间是唯一分钟级会动的东西, 必须是**整条消息流**里最后一条 system。
  // 提示词缓存只认从头开始的公共前缀 —— 动的必须全部垫在不动之后。
  // 「自我进化数据」同病, 只是周期长 12 倍: 它有 5 分钟 TTL, 排在 idx 3,
  // 一刷新后面约 11000 token 的缓存全废 (实测 LM Studio cached 28160→18432)。
  // 定式: 会变的块一律进易变区, 钉在静态前缀之后。新增易变块必须登记进这个表。
  // 顺带的好处: 越靠近 user 消息, 越压得住 —— 跟「推理预算」挪末尾是同一个道理。
  const _volatile = [];
  const _stable = [];
  for (const m of soulSysMsgs) {
    if (typeof m.content === 'string' && _VOLATILE_SYS_RE.test(m.content)) _volatile.push(m);
    else _stable.push(m);
  }
  return _sanitizeMessages([..._stable, ...userPassedSysMsgs, ..._volatile, ...nonSysMsgs]);
}

// 2026-08-16 P0-B: 自动 compaction — inputTokens > ctx * 0.6 触发 LLM 总结老消息
// 解决"盘古之行任务经常断" — 老 context 爆前主动压缩, 保留结构化 summary
async function _maybeCompactMessages(messages, useModel, sessionId, tag) {
  try {
    const _compaction = require('./compaction');
    if (_compaction.needsCompaction(messages, useModel)) {
      const _sid = sessionId || 'default';
      const _beforeTokens = require('./pangu_helpers').estimateMessagesTokens(messages);
      const _ratio = _beforeTokens / Math.max(1, require('./pangu_helpers').getModelContextLengthSafe(useModel));
      const _cr = await _compaction.compact(messages, { sessionId: _sid, modelId: useModel.id, ratio_before: _ratio });
      if (_cr && _cr.ok) {
        console.log('[compaction] triggered' + (tag ? ' (' + tag + ')' : '') + ', old_count=' + _cr.snapshot.old_count + ', recent_count=' + _cr.snapshot.recent_count + ', ratio_before=' + Math.round(_ratio * 100) + '%, snapshot=' + _cr.snapshot.id);
        return _cr.messages;
      }
    }
  } catch (_) { /* compaction 异常静默跳过, 不阻断 LLM 调用 */ }
  return messages;
}

// R26 ModelAdapter (老板 7/25 拍 '盘古需要适配所有模型才对'): OpenAI Chat Completions 消息适配层
// 真根因: Pangu 把内部结构 (含 tool_calls undefined 字段, role:'tool' 空 content) 原样发, 各模型 API 兼容性不同
// 统一版 = 原 _callLLMForAgentRaw 的 R26b 完整版 (callLLM 旧版缺 '(调用工具:)' 占位, 合并后一并享有)
function _adaptOpenAIMessages(messages, useModel) {
  // 2026-10-25 (第 85 批): 发请求前先把「tool 结果必须**紧跟**它的 assistant」这条
  // 上游契约兜住 —— 盘古自己的本地守门提示 (DUPLICATE-CALL-BLOCKED / [HARD-LOOP] /
  // [SYSTEM WARNING] / TOOL_SPIN_GUARD / [SELF_CORRECT_FAIL]) 会插在
  // assistant(tool_calls) 和它的结果**中间**, 上游直接 400:
  //   "tool call result does not follow tool call (2013)" ⇒ 整轮作废, 那一刀死。
  // 现场取证见 modules/tool_pairing.js 的 enforceToolResultAdjacency 注释。
  //
  // ⚠ 这是**网**, 不是根修: 根修在 j2_agent_loop.js (守门提示推迟到结果回灌之后)。
  //   这层留着, 因为压缩 / 截断 / 伪工具打捞都可能再把序列弄歪 —— 契约该在**边界**兜住。
  const _adj = _enforceToolResultAdjacency(messages);
  if (_adj.moved > 0) {
    console.warn('[llm-caller] tool 配对整形: ' + _adj.moved
      + ' 条消息原先夹在 assistant.tool_calls 与它的结果中间, 已挪到结果之后 '
      + '(不挪的话上游 400「tool call result does not follow tool call」)');
  }
  // 2026-11-25: enforce 只管「结果没紧跟」(挪位), 孤儿形状 (父 assistant 被截断/压缩掉,
  //   tool 结果还在 ⇒ 上游 400「tool result's tool id not found」) 它**原位保留不动**。
  //   发请求前再加一道 sanitize: 孤儿结果 / 无结果 tool_calls 成对剥掉。
  const _clean = _sanitizeToolPairing(_adj.messages);
  const _dropped = _clean.stats ? (_clean.stats.droppedTool || 0) + (_clean.stats.stripped || 0) + (_clean.stats.droppedAssistant || 0) : 0;
  if (_dropped > 0) {
    console.warn('[llm-caller] tool 孤儿清洗: ' + _dropped
      + ' 条配对不全的 tool/assistant 消息已剥 (不剥的话上游 400「tool id not found」)');
  }
  return _clean.messages.map(m => {
    const out = { role: m.role, content: m.content };
    _adaptImagesForModel(out, m, useModel);
    // 2026-08-01 根治 'tool id() not found (2013)': 有效 tool_calls / tool_call_id 必须透传
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some(tc => tc && tc.function && tc.function.name)) {
      out.tool_calls = m.tool_calls;
    }
    if (m.role === 'tool' && m.tool_call_id) {
      out.tool_call_id = m.tool_call_id;
    }
    // 所有 OpenAI 兼容模型: 抹掉 undefined tool_calls 字段 (minimax-m3 / qwen3.6 / gemma / doubao 都不接受)
    if (out.role === 'assistant') {
      if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length === 0) {
        out.tool_calls = undefined;
      }
      if (m.tool_calls && Array.isArray(m.tool_calls)) {
        const _valid = m.tool_calls.filter(tc => tc && tc.function && tc.function.name);
        if (_valid.length === 0) out.tool_calls = undefined;
      }
      // R26b: minimax 拒收空 content + tool_calls (HTTP 400 'tool call and result not match (2013)')
      if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        if (!out.content || out.content === '') {
          const _tcnames = m.tool_calls.filter(tc => tc && tc.function && tc.function.name).map(tc => tc.function.name);
          out.content = '(调用工具: ' + _tcnames.join(', ') + ')';
        }
      }
      // assistant content 空 + 无 tool_calls — minimax 拒 (要 text)
      if ((!out.content || out.content === '') && (!out.tool_calls || out.tool_calls === undefined)) {
        out.content = '(empty)';
      }
    }
    // role: 'tool' 空 content — minimax 拒
    if (out.role === 'tool' && (!out.content || out.content === '')) {
      out.content = '(empty tool result)';
    }
    return out;
  }).filter(m => {
    // 过滤掉空 system + 空 user (minimax 不要空 message)
    if (m.role === 'system' && (!m.content || m.content === '')) return false;
    if (m.role === 'user' && (!m.content || m.content === '')) return false;
    return true;
  });
}

// Anthropic Messages API body: 合并所有 system 消息为单一 system 字段
// J2 模式: tools 为空时省略 tools 字段 — MiniMax-M3 返 404
function _buildAnthropicPayload(useModel, messages, maxTokens, temperature, anthropicTools, stream) {
  const mergedSystem = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n---\n\n');
  const userMessages = messages.filter(m => m.role !== 'system');
  const payload = {
    model: modelTransport.canonicalModelName(useModel),
    max_tokens: maxTokens,
    temperature,
    system: mergedSystem || undefined,
    messages: userMessages.map(m => ({ role: m.role, content: m.content })),
  };
  if (stream) payload.stream = true;
  if (anthropicTools && anthropicTools.length > 0) payload.tools = anthropicTools;
  return payload;
}

// 2026-10-15: 保证请求里至少有一条 user 消息。
//
// 现场 (LM Studio 服务端日志 2026-10-15.log, 15:28:35):
//   Received request ... 9 messages → roles = [system ×9], **一条 user 都没有**
//   ERROR: Error rendering prompt with jinja template: "No user query found in messages."
// 端点不是返回空内容, 是直接 400。而上层把这次失败读成"模型返回空内容",
// 于是 EMPTY_CONTENT_ROUND 计数 +1 → 再补一条 user 消息重试 (15:28:37, 10 条, 成功)
// → 白烧一整轮 + 界面弹一次"模型卡顿"假警报, 而模型其实什么都没做错。
//
// 怎么变成 9 条全 system 的: auto-resume 从 checkpoint 重建 messages 时,
// 历史里那条 user 轮已经不在了, 再叠上 _injectSoulSysMsgs 的 9 条 soul system,
// 就成了一堆 system。Anthropic 系端点同样会拒 (user 缺失), 不是本地模型的特例。
//
// 这里不猜"正确的"用户输入是什么 —— 那得由上层决定。只保证形状合法,
// 让请求能发出去, 并**大声记日志**, 真正的触发源要靠这条日志去查。
function _ensureUserTurn(messages, useModel) {
  const arr = Array.isArray(messages) ? messages : [];
  if (arr.some(m => m && m.role === 'user')) return arr;
  console.warn(
    '[llm] NO_USER_TURN: 请求里一条 user 消息都没有 (roles=' +
    JSON.stringify(arr.map(m => m && m.role)) + ') —— jinja 会直接 400 "No user query found"。' +
    '已补一条占位 user 轮让请求发得出去。触发源不在 llm_caller, 要往上查 (auto-resume / checkpoint 重建)。'
  );
  return [...arr, { role: 'user', content: '[SYSTEM] 上一条上下文缺少用户输入 — 请基于已有上下文直接继续完成当前任务。' }];
}

// OpenAI Chat Completions body
function _buildOpenAIPayload(useModel, adaptedMessages, maxTokens, temperature, toolsSchema, stream) {
  const payload = {
    model: modelTransport.canonicalModelName(useModel),
    max_tokens: maxTokens,
    temperature,
    messages: adaptedMessages,
  };
  if (stream) {
    payload.stream = true;
    payload.stream_options = { include_usage: true };
  }
  // 2026-09-14 (老板拍: 模型不自动选, 只有推理强度可自动): reasoning_effort 透传, off = 不带字段
  const wireEffort = _wireReasoningEffort(useModel);
  if (wireEffort && (wireEffort !== 'off' || _shouldSendReasoningEffort(useModel))) {
    payload.reasoning_effort = wireEffort;
  }
  if (toolsSchema && toolsSchema.length > 0) payload.tools = toolsSchema;
  return payload;
}

// 请求路径补全 (2026-07-28 fix): _normalizeEndpoint 后的 baseUrl 经常是 /v1 缺 /chat/completions 后缀,
// 导致 LM Studio 返 'Unexpected endpoint or method. (POST /v1)'.
// H2 fix: 只认 /chat/completions, 旧版 /v1/completions 不算完整路径
function _resolveRequestPath(url, isAnthropic) {
  const p = url.pathname + url.search;
  if (isAnthropic) return p;
  if (p.includes('/chat/completions')) return p;
  return (p.endsWith('/') ? p.slice(0, -1) : p) + '/chat/completions';
}

// http options: 2026-08-02 本地模型 (lmstudio 35B) 首 token 慢, 60s 必超时;
// 支持 model.timeout_ms 覆盖, 本地默认 300s, 云端默认 120s
function _buildHttpOptions(url, path, headers, useModel) {
  return {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path,
    method: 'POST',
    headers,
    // 2026-10-25 第 98 批: 原来判 provider==='lmstudio' —— 品牌名当本地判据,
    // mlx-serve/vllm/llama.cpp 全被漏判成云端 (只给 120s)。改走能力真源(按端点事实)。
    timeout: _modelCapability.timeoutMs(useModel),
  };
}

// 2026-08-03 修 (老板 8/3 晚 48 分钟挂死实案): options.timeout 只触发 'timeout' 事件,
// Node 不会自动断开 — 没 handler = MiniMax 挂死连接时无限等 (0 日志挂 48 分钟的根因)
function _attachReqGuards(req, options, reject) {
  req.on('timeout', () => {
    try { req.destroy(); } catch (_) {}
    reject(new Error('LLM_SOCKET_TIMEOUT_' + Math.round((options.timeout || 120000) / 1000) + 's (上游挂死连接, 已熔断)'));
  });
  req.on('error', e => reject(e));
}

// 非流式响应解析; debug400=true 时 400 错误 dump 消息结构 (2026-08-01 追 'tool id() not found')
// 2026-10-13 (现场 /tmp/pangu-single.err 8 次 "解析响应失败: Unexpected token 'd',
//   \"data: {\"ty\"... is not valid JSON"): 非流式解析器收到 SSE 响应体时裸 JSON.parse
//   直接抛错, 整轮失败 → 降级 legacy → SILENT_FAILURE。ar2-0009 实测: 子 agent sub-0
//   撞上它 → 该轮 0 工具 → planner 第一轮全废 → 触发 2 轮补救重做, 长任务第一步夭折。
//   未能复现该故障(端点实测均返回标准 JSON, 配置无强制流式), 最可能是 keepAlive 连接
//   复用时上游 SSE 残留字节串进下一个响应 —— 间歇性。故此处只做防御: 能吃下 SSE 体。
//   正常 JSON 路径行为完全不变, 仅在 JSON.parse 失败且体确为 SSE 时兜底。

// 2026-10-13 现场 (诊断埋点第一次上线就抓到唯一一条):
//   body = data: {"type":"error","error":{"type":"server_error",
//                 "message":"unknown error (1000)","http_code":"500"},"request_id":"071c..."}
// 上游把错误**包在 SSE 里**发回来。这种信封没有 choices 字段,
// 会被归并器当噪声跳过 → 归出 0 字 0 工具 → 返回 null
// → 上层拿 JSON.parse 的**语法错**报败: 「解析响应失败: Unexpected token 'd'」
// 真因 (上游 500)被顶掉 —— 运维看到这句会去查解析器, 而真因是上游挂了。
// 这里按上游给的字段拼出真实原因, 并打 __upstreamSSE 标记让上层别再套
// 「解析响应失败」的壳。
function _upstreamSSEError(j) {
  const e = (j && typeof j.error === 'object' && j.error) ? j.error : {};
  const parts = [
    e.type || (j && j.type) || null,
    e.message || null,
    e.http_code ? ('http_code=' + e.http_code) : null,
    (j && j.request_id) ? ('request_id=' + j.request_id) : null,
  ].filter(Boolean);
  const err = new Error('上游 SSE 错误事件: '
    + (parts.length ? parts.join(' ') : JSON.stringify(j || {}).slice(0, 200)));
  err.__upstreamSSE = true;
  return err;
}

// 2026-10-25 (现场 probe92, 本地 LM Studio 127.0.0.1:1234):
//   上游回的是**一整页 HTML** (`<!DOCTYPE html>`) —— 不是 JSON, 也不是 SSE。
//   原来这里把 JSON.parse 的原始语法错抛出去 ⇒ 上层报成
//   「解析响应失败: Unexpected token '<', "<!DOCTYPE "... is not valid JSON」。
//   **这句把人引向了解析器, 真因在上游那一侧** —— 跟 2026-10-13 那次
//   (上游 500 被报成 JSON 语法错) 是同一个病, 只是这次连 SSE 信封都没有。
//   常见三种真因: ① 服务没起来但端口有人应答 (LM Studio / vLLM 没开)
//                 ② 反代/网关返回 502/503/504 的默认错误页
//                 ③ 请求路径不对 (打到了网页端, 前端把 index.html 兜回来了)
// 判据只用**形态 + 状态码**: 是不是一整页 HTML / 是不是非 JSON 的正文。
// 不猜是谁的错 —— 只把「上游此刻返回的不是接口」这个事实如实报出来。
function _upstreamBodyDiagnosis(statusCode, body) {
  const _raw = String(body || '');
  const _head = _raw.slice(0, 400).trim();
  const _code = Number(statusCode) || 0;
  const _codeTxt = _code ? ' (HTTP ' + _code + ')' : '';
  let _e = null;
  if (/<!doctype\s+html|<html[\s>]/i.test(_head)) {
    _e = new Error('UPSTREAM_RETURNED_HTML' + _codeTxt
      + ': 上游返回的是一整页 HTML, 不是 LLM 接口的响应 —— 多半是服务没起来 / '
      + '请求路径不对 (打到网页端了) / 被网关拦了。收到的页面开头: '
      + JSON.stringify(_head.slice(0, 120)));
  } else if (_code >= 400) {
    _e = new Error('UPSTREAM_RETURNED_NON_JSON' + _codeTxt
      + ': 上游返回的不是 JSON (也不是 SSE) —— 原样带回开头: '
      + JSON.stringify(_head.slice(0, 120)));
  }
  if (!_e) return null;
  _e.__upstreamBody = true;
  _e.statusCode = _code;
  return _e;
}

// 2026-10-16: opts.source 只是给日志用的。现在子 agent 的**流式**路径也复用这个装配器,
// 而下面的告警原来写死"非流式路径收到 SSE" —— 那会把查问题的人引向一个并不存在的
// 非流式调用方。命名/语义不一致时, 读日志推断会骗人 (这条坑记过不止一次)。
function _parseSSEBody(raw, opts = {}) {
  const _src = opts.source === 'streaming' ? '流式路径主动装配' : '非流式路径收到 SSE';
  const text = String(raw || '');
  if (!/(^|\n)\s*data:/.test(text)) {
    // 2026-10-18 (实机 session 80053699, «做个全面体检» 四条 checker 全挂):
    //   body 形如 `event: error\n...` —— **有 event 行, 没有 data 行**。
    //   原来这里一律 `return null`, 于是调用方 `throw _jsonErr`, 最后报成
    //     「解析响应失败: Unexpected token 'e', "event: err"... is not valid JSON」
    //   而上游真正发生的事 (通常是响应被切断 / 连接重置, 与同批 ECONNRESET 同族)
    //   **一个字都没透出来**。运维看到 JSON 语法错会去查解析器, 真因在上游那一侧。
    //
    // 上面 _upstreamSSEError 已经处理了"data 行带着错误载荷"的情况, 唯独漏了
    // "只到 event 行就断了"这一档 —— 恰恰是长请求被切断时最常见的那一档。
    // 这里补上: 认出 event:error 帧, 报上游错误, 不再伪装成解析失败。
    const _ev = /(?:^|\n)\s*event:\s*([a-z_]+)/i.exec(text);
    if (_ev && /^(error|fatal)$/i.test(_ev[1])) {
      const _e = new Error('上游返回了 ' + _ev[1] + ' 事件但错误内容没到 (响应在 event 行之后被切断, '
        + '通常是长请求超时或连接被重置); 收到的原始片段: ' + JSON.stringify(text.slice(0, 200)));
      _e.__upstreamSSE = true;
      throw _e;
    }
    return null;                                    // 不是 SSE, 交回原错误路径
  }
  let content = '', finishReason = null, usage = null;
  const tcMap = new Map();
  let sawChunk = false;
  let chunkCount = 0;
  let upstreamErr = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*data:\s?(.*)$/.exec(line);
    if (!m) continue;
    const payloadStr = m[1].trim();
    if (!payloadStr) continue;
    if (payloadStr === '[DONE]') break;
    let j;
    try { j = JSON.parse(payloadStr); } catch (_) { continue; }
    sawChunk = true;
    chunkCount += 1;
    if (j.usage) usage = j.usage;
    if (!upstreamErr && (j.type === 'error' || (j.error && typeof j.error === 'object'))) upstreamErr = j;
    const ch = j.choices && j.choices[0];
    if (!ch) continue;
    const d = ch.delta || {};
    if (typeof d.content === 'string' && d.content) content += d.content;
    if (typeof d.reasoning_content === 'string' && !content) { /* 思考内容不进 content */ }
    if (ch.finish_reason) finishReason = ch.finish_reason;
    for (const t of (d.tool_calls || [])) {
      const idx = (t && t.index != null) ? t.index : 0;
      const acc = tcMap.get(idx) || { id: undefined, type: 'function', function: { name: '', arguments: '' } };
      if (t.id) acc.id = t.id;
      if (t.type) acc.type = t.type;
      if (t.function) {
        if (t.function.name) acc.function.name += t.function.name;
        if (t.function.arguments) acc.function.arguments += t.function.arguments;
      }
      tcMap.set(idx, acc);
    }
  }
  if (!sawChunk) return null;
  const toolCalls = [...tcMap.values()].filter(t => t.function && t.function.name);
  // 2026-10-13 (现场 3f6fafb 落地后新增 5 次 "[llm-sse-fallback] ... (content=0字, tools=0)"):
  // 归并出 0 字 0 工具时**不能**返回一个空 message —— 那等于把"响亮的失败"换成
  // "静默的空答案": 调用方不再抛错 → 不再走 `fallback to legacy J2 XML path` → 白烧一轮预算。
  // 空归并交回 null, 让原错误路径照旧触发。
  if (!content && !toolCalls.length) {
    // 有内容时不打断 (半截内容好过没有), 只有干净的错误信封才抛
    if (upstreamErr) throw _upstreamSSEError(upstreamErr);
    // 有界诊断: 下次再犯时能直接看出这个 `data: {"ty"...` 到底是什么事件。
    console.warn('[llm-sse-fallback] SSE 体归不出内容也无工具, 交回原错误路径 | chunks='
      + chunkCount + ' | body 前 300 字: ' + text.slice(0, 300).replace(/\s+/g, ' '));
    return null;
  }
  console.warn('[llm-sse] ' + _src + ', 已就地归并 ('
    + 'content=' + content.length + '字, tools=' + toolCalls.length + ')');
  return {
    choices: [{ index: 0, message: { role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : undefined }, finish_reason: finishReason || 'stop' }],
    usage: usage || undefined,
  };
}

function _handlePlainResponse(res, body, resolve, reject, debug400) {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      let result;
      try {
        result = JSON.parse(data);
      } catch (_jsonErr) {
        // 兜底: 上游有时会把 SSE 体送到非流式路径(见 _parseSSEBody 注释)。
        // 以前这里直接抛错, 代价是整轮失败 + 降级 + 轮次预算白烧。
        const _sseResult = _parseSSEBody(data);
        if (!_sseResult) {
          // 2026-10-25 (现场 probe92): 连 SSE 都不是 (上游回了一整页 HTML)。
          //   原来这里把 JSON.parse 的语法错原样抛出去 ⇒ 报成「解析响应失败:
          //   Unexpected token '<'」—— **指向解析器, 真因在上游那一侧**。
          //   ⇒ 如实报「上游此刻返回的是什么」, 别让人去查一个没坏的解析器。
          const _diag = _upstreamBodyDiagnosis(res.statusCode, data);
          if (_diag) throw _diag;
          throw _jsonErr;
        }
        result = _sseResult;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        if (debug400 && res.statusCode === 400) {
          try {
            // 2026-08-02 加强: 全量 dump — role/内容类型/长度/预览
            const _parsed = JSON.parse(body);
            const dbg = (_parsed.messages || []).map((m, i) => ({
              i, role: m.role,
              ctype: Array.isArray(m.content) ? 'arr' + m.content.length : typeof m.content,
              clen: typeof m.content === 'string' ? m.content.length : -1,
              tcid: m.tool_call_id,
              atc: Array.isArray(m.tool_calls) ? m.tool_calls.map(t => t && t.id) : undefined,
              prev: typeof m.content === 'string' ? m.content.slice(0, 60) : JSON.stringify(m.content || '').slice(0, 60)
            }));
            console.log('[llm-400-dbg] err:', ((result && result.error && result.error.message) || data.slice(0, 200)));
            console.log('[llm-400-dbg]', JSON.stringify(dbg).slice(0, 1500));
          } catch (_) {}
        }
        reject(new Error(`HTTP ${res.statusCode}: ${result.error?.message || data.slice(0, 500)}`));
      } else {
        resolve(result);
      }
    } catch (e) {
      // 上游错误事件不是「解析失败」: 别给它套误导性的前缀
      // (现场实证: 上游 500 被报成「解析响应失败: Unexpected token 'd', \"data: {\"ty\"...」)
      if (e && e.__upstreamSSE) { reject(e); return; }
      // 同理: 上游回了一整页 HTML / 非 JSON 的正文, 也不是「解析失败」
      // (现场实证: 本地 LM Studio 回 '<!DOCTYPE html>' 被报成「解析响应失败」)
      if (e && e.__upstreamBody) { reject(e); return; }
      reject(new Error('解析响应失败: ' + e.message));
    }
  });
}

async function _callLLMImpl(messages, modelConfig) {
  // M10: 前置解析走公共块
  const { useModel, apiKey, baseUrl, isAnthropic, temperature } = _resolveCallContext(modelConfig);
  console.log('[callLLM-DEBUG]', useModel.id, 'apiKey_configured=', Boolean(apiKey));
  // 2026-10-14: 本地端点 (LM Studio / oMLX / llama.cpp / vLLM) 本来就不要 api_key,
  // 之前照样打 "no api_key for model" —— 每轮刷一行, 看起来像坏了, 其实是正常的。
  // api_key_resolver 里已经有 isLocalEndpoint, 这里用它把噪音关掉。
  if (!apiKey) {
    const { isLocalEndpoint } = require('./api_key_resolver');
    if (!isLocalEndpoint(baseUrl)) {
      console.warn('[callLLM] no api_key for model', useModel.id, '(configured=', Boolean(useModel.api_key), 'source:', useModel.api_key_source || 'none', ')');
    } else {
      console.log('[callLLM] 本地端点无 api_key (正常):', useModel.id, '@', baseUrl);
    }
  }

  // M10: 灵魂注入走公共块
  messages = _injectSoulSysMsgs(messages, useModel);

  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const headers = modelTransport.authHeaders(useModel, apiKey);
    // 2026-07-26 老板拍: 4096 上限不对 → _resolveMaxTokens 推导 (cap 32768, minimax 8192)
    const maxTokens = _resolveMaxTokens(useModel, estimateMessagesTokens(messages));

    let body;
    if (isAnthropic) {
      // Anthropic Messages API 鉴权: MiniMax 的 anthropic 端点要求 x-api-key, 不能用 Authorization Bearer
      body = JSON.stringify(_buildAnthropicPayload(useModel, messages, maxTokens, temperature, null, false));
    } else {
      body = JSON.stringify(_buildOpenAIPayload(useModel, _adaptOpenAIMessages(messages, useModel), maxTokens, temperature, null, false));
    }

    const options = _buildHttpOptions(url, _resolveRequestPath(url, isAnthropic), headers, useModel);

    const req = (url.protocol === 'https:' ? https : http).request(options, (res) => {
      _handlePlainResponse(res, body, resolve, reject, false);
    });

    _attachReqGuards(req, options, reject);
req.setHeader('Content-Length', Buffer.byteLength(body)); // 2026-10-14: 见流式路径同款注释
    req.write(body);
    req.end();
  });
}

// 2026-09-23: 剥掉模型混进 content 的 thinking 段
// thinking-mode 模型 (GLM/Qwen3/DeepSeek) 有时把推理段直接写进 message.content
// 策略: 先剥  标签块; 再以 markdown # 标题行或第一个汉字开头行作为正文起点
function _stripThinking(raw) {
  if (!raw || raw.length < 80) return raw; // 短文本不做处理
  let t = raw.replace(new RegExp('<' + 'think' + '\\b[\\s\\S]*?<\\/' + 'think' + '>', 'g'), '');
  const lines = t.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s+\S/.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx === -1) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (/^[\u4e00-\u9fff]/.test(line)) { startIdx = i; break; }
    }
  }
  if (startIdx > 0) t = lines.slice(startIdx).join('\n');
  return t.trim();
}

function extractContent(result) {
  // 2026-08-07 多模态输出: extractContent 走 extractParts, 图片部分经 media_sink 落盘,
  // text 尾部附路径占位符 — 所有现存调用方零改动即享"base64 不进上下文"。
  const { text, media } = extractParts(result);
  if (media.length > 0) {
    const { sinkBase64Images, mediaPlaceholder } = require('./media_sink');
    const files = sinkBase64Images(media, { prefix: 'chat' });
    const ph = mediaPlaceholder(files);
    return ph ? (text ? text + '\n' + ph : ph) : text;
  }
  return _stripThinking(text);
}

/**
 * 2026-10-27 第 112 批: 一次拿齐三件**事实**, 不靠「文本像不像思考」去猜。
 *
 *   text          正文 (可能是空)
 *   reasoningOnly 上游只回思考、没回正文 (content 空 + 有 reasoning_content)
 *   truncated     上游自己说没写完 (finish_reason === 'length')
 *
 * 为什么要单独一个出口: extractContent 只回一个字符串, 字符串分不出
 * 「没答上来」「只回思考」「写了一半」这三种完全不同的失败 ——
 * 上层拿到空串只能瞎猜, 于是历史上就长出了「拿思考当答案」这种补丁。
 *
 * 调用方 (端点 / dispatcher) 据这三个事实决定:
 *   reasoningOnly ⇒ 重试或升级 (不许把思考交出去)
 *   truncated     ⇒ 预算不够, 重试或明说没写完 (半截答案不算答案)
 *   都不是 + 有正文 ⇒ 正常交付
 */
function extractAnswer(result) {
  const parts = extractParts(result);
  const text = extractContent(result);
  return {
    text: String(text || ''),
    reasoningOnly: !!parts.reasoningOnly,
    reasoningChars: Number(parts.reasoningChars) || 0,
    truncated: parts.finishReason === 'length',
    finishReason: parts.finishReason || null,
  };
}

/**
 * 2026-08-07: 多模态输出解析 (输入侧 vision 早有, 这是输出侧)。
 * 从各家响应里同时抽出 text 和 image base64, 支持三种协议形态:
 *   - Anthropic: content[] 里 type=text / type=image (source.data)
 *   - OpenAI chat multimodal: message.content 为数组, type=text / type=image_url (data:base64)
 *   - Gemini 原生: candidates[0].content.parts[] 里 text / inlineData
 * @returns {{text: string, media: Array<{base64: string, mime: string}>}}
 */
// 2026-10-27 第 112 批: 上游自己说「没写完」这个**事实**, 以前没人读。
// finish_reason='length' = 输出预算触顶, 正文是**半截**的。
// 以前半截答案跟完整答案长得一模一样 (都只是字符串), 谁都看不出来 ——
// 于是「九节只写三节」的正文被当成完整答案交到主人面前。
// 现在这个事实被抽出来, 交给上层决定 (重试 / 升级 / 明说没写完)。
function _finishReasonOf(result) {
  const c = (result && result.choices && result.choices[0])
    || (result && result.result && result.result.choices && result.result.choices[0]);
  return (c && typeof c.finish_reason === 'string') ? c.finish_reason : null;
}

function extractParts(result) {
  const media = [];
  const _finishReason = _finishReasonOf(result);
  // Gemini 原生格式
  const cand = result.candidates && result.candidates[0];
  if (cand && cand.content && Array.isArray(cand.content.parts)) {
    let text = '';
    for (const p of cand.content.parts) {
      if (typeof p.text === 'string') text += p.text;
      else if (p.inlineData && p.inlineData.data) media.push({ base64: p.inlineData.data, mime: p.inlineData.mimeType || 'image/png' });
    }
    return { text, media, reasoningChars: 0, reasoningOnly: false, finishReason: _finishReason };
  }
  // Anthropic 格式
  if (result.content && Array.isArray(result.content)) {
    let text = '';
    for (const b of result.content) {
      if (b.type === 'text' && typeof b.text === 'string') text += b.text;
      else if (b.type === 'image' && b.source && b.source.data) media.push({ base64: b.source.data, mime: b.source.media_type || 'image/png' });
    }
    return { text, media, reasoningChars: 0, reasoningOnly: false, finishReason: _finishReason };
  }
  // OpenAI 格式
  let m = null;
  if (result.choices && result.choices[0] && result.choices[0].message) m = result.choices[0].message;
  else if (result.result && result.result.choices && result.result.choices[0] && result.result.choices[0].message) m = result.result.choices[0].message;
  if (m) {
    if (Array.isArray(m.content)) {
      // chat 原生吐图: content 是 parts 数组 (Gemini-openai-compat / doubao 等)
      let text = '';
      for (const p of m.content) {
        if (p.type === 'text' && typeof p.text === 'string') text += p.text;
        else if (p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string') {
          const u = p.image_url.url; // data:image/png;base64,xxxx
          const comma = u.indexOf(',');
          if (u.startsWith('data:') && comma > 0) {
            media.push({ base64: u.slice(comma + 1), mime: u.slice(5, u.indexOf(';')) || 'image/png' });
          }
        }
      }
      if (text || media.length > 0) return { text, media, reasoningChars: 0, reasoningOnly: false, finishReason: _finishReason };
    }
    const _content = typeof m.content === 'string' ? m.content : '';
    const _reasoning = typeof m.reasoning_content === 'string' ? m.reasoning_content : '';
    //
    // 2026-10-27 第 112 批: **思考不再冒充正文**。
    //
    // 旧行为 (2026-07-28 加的): content 空 ⇒ fallback 到 reasoning_content 当答案,
    // 注释写的是「确保 /message 看到答案」。现场 (2026-10-26 老板贴的八字排盘 AI 解读):
    // MiniMax-M3.1-Flash 的输出预算被思考吃光 ⇒ content 空 ⇒ 主人收到的正文
    // = 模型的英文自说自话, 九节只剩四个标题, 其余全缺 —— 「看到答案」变成了
    // 「看到答案的残骸 + 一堆思考」。
    //
    // 真相: 思考是**事实**, 不是答案。空正文 + 有思考 = 「这轮没答上来」,
    // 该做的是重试 / 升级 / 明说没答上来, 不是悄悄换个东西顶上去。
    // ⇒ 这里**不再**把 reasoning_content 塞进 text;
    //    reasoningOnly 这个事实随结果一起交出去 (见 extractAnswer)。
    //
    // ⚠ 2026-07-28 那批模型 (qwen3.6 / deepseek-r1) 只回 reasoning_content 时,
    //   正文会变空 —— 这是**故意的**: 空答案会被上层升级阶梯接住
    //   (chat_answer_policy.needsEscalation → agent loop → nudge 再问),
    //   而思考本身永远不该出现在主人面前。
    if (_content) return { text: _content, media, reasoningChars: _reasoning.length, reasoningOnly: false, finishReason: _finishReason };
    if (_reasoning) return { text: '', media, reasoningChars: _reasoning.length, reasoningOnly: true, finishReason: _finishReason };
  }
  return { text: '', media, reasoningChars: 0, reasoningOnly: false, finishReason: _finishReason };
}

// ==================== Pangu Agent Loop ====================
// 闭环: LLM → tool_use → sandbox check → execute → 回灌 → 最终答案 SSE
// 老板原话: "不光需要盘古可以回答问题、分析问题，还需要盘古能给解决方案，并执行这些方案"
// I: 过滤工具为高价值子集 (避免 81 个 schema 超 Gemma-4 上下文)
// Gemma-4-26b QAT 默认 4K 上下文, 本地工具 schema 限制为 10 个核心
const AGENT_TOOL_WHITELIST = new Set([
  'exec_command', 'read_file', 'write_file', 'file_edit',
  'list_directory', 'web_search', 'memory_search', 'memory_read', 'session_recall',
  'task_done', 'goal_set', 'goal_progress', 'goal_complete'
]);

function _loadToolsSchemaForLLM() {
  // 从 modules/tools_schema.js 读 schema,转 OpenAI functions 格式
  // 按 AGENT_TOOL_WHITELIST 过滤 (避免 81 个全送超上下文)
  try {
    const path = require('path');
    const fs = require('fs');
    const schemaPath = path.join(__dirname, 'tools_schema.js');
    if (!fs.existsSync(schemaPath)) return [];
    delete require.cache[require.resolve(schemaPath)];
    const { TOOLS_SCHEMA } = require(schemaPath);
    const internal = Object.values(TOOLS_SCHEMA)
      .filter(s => AGENT_TOOL_WHITELIST.has(s.function.name))
      .map(s => ({
        type: 'function',
        function: {
          name: s.function.name,
          description: s.function.description.slice(0, 200), // 限制描述长度
          parameters: s.function.parameters
        }
      }));
    // 2026-07-26 老板拍 (内部/MCP 分开): MCP 工具也注入 LLM schema — 之前 LLM 根本看不见 MCP
    let mcp = [];
    try {
      const mcpAdapter = require('./mcp_adapter');
      if (mcpAdapter._collectAllToolSchemas) {
        mcp = mcpAdapter._collectAllToolSchemas().map(s => ({
          type: 'function',
          function: {
            name: s.function.name,
            description: String(s.function.description || '').slice(0, 200),
            parameters: s.function.parameters || { type: 'object', properties: {} },
          }
        }));
      }
    } catch (e) { /* MCP 没起来不阻塞内部工具 */ }
    return internal.concat(mcp);
  } catch (e) {
    return [];
  }
}

function _extractToolCallsAnthropic(result) {
  // 返回 [{id, name, params}]
  if (!result.content || !Array.isArray(result.content)) return [];
  return result.content
    .filter(b => b.type === 'tool_use')
    .map(b => ({ id: b.id, name: b.name, params: b.input || {} }));
}

function _extractToolCallsOpenAI(result) {
  // 返回 [{id, name, params}]
  const tc = result.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(tc)) return [];
  return tc.map(t => {
    let params = {};
    try { params = JSON.parse(t.function.arguments || '{}'); } catch (e) { console.warn('[pangu] _extractToolCallsOpenAI JSON.parse error:', e.message); }
    return { id: t.id, name: t.function.name, params };
  });
}

function _buildAssistantWithToolCallsAnthropic(toolCalls, textContent) {
  // 构造 messages 里要存的 assistant 消息
  const content = [];
  if (textContent) content.push({type: 'text', text: textContent});
  for (const tc of toolCalls) {
    content.push({type: 'tool_use', id: tc.id, name: tc.name, input: tc.params});
  }
  return { role: 'assistant', content };
}

function _buildAssistantWithToolCallsOpenAI(toolCalls, textContent) {
  return {
    role: 'assistant',
    content: textContent || null,
    tool_calls: toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.params) }
    }))
  };
}

function _buildToolResultsAnthropic(toolResults) {
  // Anthropic: tool_result 作为 user 消息的内容
  return {
    role: 'user',
    content: toolResults.map(tr => ({
      type: 'tool_result',
      tool_use_id: tr.id,
      content: tr.content,
      is_error: !tr.ok
    }))
  };
}

function _buildToolResultsOpenAI(toolResults) {
  // OpenAI: 每个 tool_result 一条 tool role 消息
  return toolResults.map(tr => ({
    role: 'tool',
    tool_call_id: tr.id,
    content: tr.content
  }));
}

// §0.13 cloud LLM cold start fix: 启动后自动 warmup
// 后台发 1 个 dummy 请求让云端 LLM 完成 GPU 调度 + 模型预热
// 适用所有云端 SaaS 模型, 不依赖具体 provider
async function _warmupLLM() {
  const useModel = getDefaultModel();
  if (!useModel) {
    console.log('[warmup] no model, skip');
    return;
  }
  const start = Date.now();
  console.log('[warmup] starting cloud LLM warmup, model:', useModel.id);
  try {
    // 发个最简单的 dummy chat 让 minimax 完成 cold start
    const r = await _callLLMForAgent(
      [{ role: 'user', content: 'hi' }],
      useModel,
      []
    );
    const elapsed = Date.now() - start;
    console.log(`[warmup] done in ${elapsed}ms, minimax ready`);
  } catch (e) {
    console.warn(`[warmup] failed after ${Date.now() - start}ms:`, e.message);
  }
}

// 2026-10-13 (冷启动重试在常驻服务里只生效一次, 见下方 _callLLMForAgent 注释):
//   "冷启动" 的正确语义是"端点闲置后降温, 首次调用需要预热", 而不是"进程启动后第一次"。
//   所以按距上次成功调用的时间判定, 而不是一次性全局标志 —— 常驻进程跨天/闲置后会自动重新武装。
const COLD_START_WINDOW_MS = parseInt(process.env.PANGU_COLD_START_WINDOW_MS || String(5 * 60 * 1000), 10);
let _lastSuccessCallTs = 0;

function _shouldArmColdStartRetry(nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (!_lastSuccessCallTs) return true;              // 本进程内从未成功调用过 → 冷
  return (now - _lastSuccessCallTs) > COLD_START_WINDOW_MS;
}
function _noteColdStartSuccess(tsMs) {
  _lastSuccessCallTs = typeof tsMs === 'number' ? tsMs : Date.now();
}

async function _callLLMForAgent(messages, modelConfig, toolsSchema, opts) {
  // 跟 callLLM 类似,但加 tools 参数
 // MiniMax 用 Anthropic 协议(已知支持 tool_use),不用 OpenAI tools 格式
 // minimax cold start fix: 加 cold start retry (超时/5xx → retry 1 次)
  const useModel = modelConfig || getDefaultModel();
  if (!useModel) throw new Error('No model available');

  // Cold start retry: 首次请求可能超时/5xx, retry 1 次 (--force 等真实老板操作不卡)
  //
  // 2026-10-13 修: 原来用一个进程级"一次性"环境变量做冷启动开关(已删除) ——
  // 进程内第一次调用武装重试并置 '1', 此后**永不复位**(全文件只有读写两处)。
  // 盘古是 launchd KeepAlive 常驻服务, 连跑几天: 模型端点闲置一段时间会降温,
  // **闲置后的第一次调用恰恰就是冷启动**, 也恰恰是最容易超时/5xx 的那一刻 ——
  // 而那正是最需要重试的时刻, 偏偏重试早被解除武装。
  // 结果: 一次冷启动超时直接穿透成整轮失败 → 降级 legacy → SILENT_FAILURE。
  // 改成按"距上次成功调用的时间"判定: 闲置超过窗口就算冷启动, 重新武装。
  if (_shouldArmColdStartRetry()) {
    const start = Date.now();
    try {
      const r = await _callLLMForAgentRaw(messages, modelConfig, toolsSchema, opts);
      _noteColdStartSuccess();
      if (Date.now() - start > 500) console.log(`[cold-start] cloud LLM call ${Date.now() - start}ms (slow but ok)`);
      return r;
    } catch (e) {
      console.warn(`[cold-start] first call failed (${e.message}), retrying in 1s...`);
      await new Promise(r => setTimeout(r, 1000));
      const r2 = await _callLLMForAgentRaw(messages, modelConfig, toolsSchema, opts);
      _noteColdStartSuccess();
      return r2;
    }
  }

  try {
    const r = await _callLLMForAgentRaw(messages, modelConfig, toolsSchema, opts);
    _noteColdStartSuccess();
    return r;
  } catch (e) {
    // 非冷启动窗口内的失败也照样记一次成功时间戳所依赖的"最近用过"状态:
    // 端点确实响应过(哪怕是业务错误), 就不是冷启动。
    _noteColdStartSuccess();
    throw e;
  }
}

async function _callLLMForAgentRawImpl(messages, modelConfig, toolsSchema, opts) {
  // M10: 前置解析 / 灵魂注入 / compaction / 截断 全部走公共块
  const { useModel, apiKey, baseUrl, isAnthropic, temperature } = _resolveCallContext(modelConfig);
  // 2026-10-13: skipSoul opts — tool_call 探测专用, 不注入 9 条 soul system (129 工具清单淹没 k3 的 echo 探测)
  if (opts && opts.skipSoul) {
    messages = _sanitizeMessages(messages);
  } else {
    // 2026-10-16: soulScope='worker' 由 j2_agent_loop 按角色带下来 (子 agent 才带)。
    // 主 agent 走默认 main 档, 提示词一个字都不少 —— 别为了省 token 削主 agent 的记忆。
    // 2026-10-24 (第 80 批): callableTools = 「这一轮真能调的集」的**最精确**口径。
    //   调用方 (j2_agent_loop) 手里有本轮的 toolsAllowed / 角色白名单 ——
    //   那是 API schema 的同一份真源, 比角色档更准 (拆解轮只有 2 个工具, 角色档却是 38 个)。
    messages = _injectSoulSysMsgs(messages, useModel, opts && opts.soulScope, opts && opts.callableTools);
  }
  messages = await _maybeCompactMessages(messages, useModel, opts && opts.sessionId, null);
  messages = _ensureUserTurn(messages, useModel);

  // Context probing runs asynchronously at boot. Requests can arrive before
  // that warmup finishes; do the same probe on demand instead of failing the
  // whole task before the provider is ever called. This is provider/model
  // agnostic and also repairs stale registry state after a model switch.
  if (!modelRegistry.getContextLength(useModel.id)) {
    try {
      const probed = await modelProbe.probeContextLength(useModel);
      console.log('[ctx-on-demand]', useModel.id, '->', probed.context_length, '(' + probed.source + ')');
    } catch (e) {
      console.warn('[ctx-on-demand] failed for', useModel.id, ':', e.message);
    }
  }

 // 修: 上下文长度感知的截断 + max_tokens 计算 (2026-07-26: 4096 → cap 32768, reasoning 模型友好)
  messages = truncateMessagesForContext(messages, useModel, _truncateReserve(useModel));
  const inputTokens = estimateMessagesTokens(messages);
  const contextLength = getModelContextLengthSafe(useModel);
  const maxTokens = _resolveMaxTokens(useModel, inputTokens);

  console.log('[agent-llm] model:', useModel.id, 'url:', baseUrl, 'isAnthropic:', isAnthropic, 'tools:', toolsSchema.length, 'msgs:', messages.length, 'ctx:', contextLength, 'inputTokens:', inputTokens, 'maxTokens:', maxTokens);

  // 2026-10-15: 本地 27B 每一轮的成本几乎全在 prefill (实测 83s 里 83s 是 prefill,
  // 生成只占 2s), 所以"提示词由什么组成"是唯一值得盯的杠杆。但 [agent-llm] 只打总数,
  // 看不出是哪条 system 在撑大。这里按条目打一份画像, 只在超过 12k 时打, 避免刷屏。
  if (inputTokens > 12000) {
    try {
      let _dup = 0; const _dupIdx = [];
      // 2026-10-15: 原来这里只数 '[运行环境 — 路径铁律]', 于是"整份 soul prompt 被拼两遍"
      // 这种重复完全看不见 (实测 gar_dup=1, 而 39% 的 token 是重复的 soul 块)。
      // 改成按块首身份数**所有** system 重复 —— 这是上面那个 bug 的照妖镜,
      // 也是判断"提示词里到底有什么值得砍"的唯一入口。
      const _seenIds = new Map();
      const _parts = messages.map((m, i) => {
        const _c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
        if (m.role === 'system') {
          const _id = _sysBlockIdentity(_c);
          if (_id) {
            if (_seenIds.has(_id)) { _dup++; _dupIdx.push(i + '(同' + _seenIds.get(_id) + ')'); }
            else _seenIds.set(_id, i);
          }
        }
        const _head = _c.replace(/\s+/g, ' ').slice(0, 28);
        return i + ':' + (m.role || '?') + '=' + Math.ceil((_c.length + 20) * 0.35) + ' ' + _head;
      });
      console.log('[prompt-profile] sid=' + ((opts && opts.sessionId) || '-') + ' total=' + inputTokens + ' gar_dup=' + _dup + ' at[' + _dupIdx.join(',') + '] | ' + _parts.join('\n'));
    } catch (_) { /* 画像是纯诊断, 挂了不能影响发请求 */ }
  }

  // 2026-10-17 (长任务时间账): 以前 llm_caller 只有 [agent-llm] 的**请求侧**画像
  // (模型/tools/msgs/inputTokens), 没有**结果侧**耗时 —— 于是"一次长任务 270s"
  // 永远对不上账: 按单刀实测 ~5s 算, 3 个 analyzer 并行本该 ~30s, 差的 200 多秒
  // 没有任何一处日志能指认它花在哪。只能靠猜, 猜错了就改错地方 (已经栽过)。
  //
  // 这里是**子 agent 走的那条通路** (j2_agent_loop 的 _deps._callLLMForAgent →
  // _callLLMForAgentRaw → 本函数), 也就是长任务里绝大多数秒数所在。
  // 补上唯一的结算埋点: 每次调用打 [llm-cost] <ms> <标签> <模型> tools=<n> in=<tok>。
  // 标签由调用方通过 opts.perfTag 带下来 (partial_judge / loop:<role> / 未标注),
  // 于是"哪一个用途在烧秒"一眼能分, 不再需要事后靠总时长反推。
  // 纯日志, 不改任何控制流 —— 结算失败也绝不能影响发请求。
  const _perfT0 = Date.now();
  const _perfTag = String((opts && opts.perfTag) || 'untagged').slice(0, 40);
  const _perfDone = (kind, extra) => {
    try {
      console.log('[llm-cost] ' + (Date.now() - _perfT0) + 'ms ' + _perfTag + ' ' + kind
        + ' model=' + useModel.id + ' tools=' + toolsSchema.length
        + ' in=' + inputTokens + (extra ? ' ' + extra : ''));
    } catch (_) { /* 结算日志挂了也不能影响主流程 */ }
  };
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    let body, headers = modelTransport.authHeaders(useModel, apiKey);

    if (isAnthropic) {
      // M10: body 走公共构建块 (tools 为空自动省略 tools 字段 — MiniMax-M3 返 404)
      const anthropicTools = toolsSchema.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters
      }));
      body = JSON.stringify(_buildAnthropicPayload(useModel, messages, maxTokens, temperature, anthropicTools, false));
    } else {
      // M10: R26/R26b ModelAdapter 两份拷贝 (tools 空/非空) 合并为公共块 _adaptOpenAIMessages + _buildOpenAIPayload
      body = JSON.stringify(_buildOpenAIPayload(useModel, _adaptOpenAIMessages(messages, useModel), maxTokens, temperature, toolsSchema, false));
    }

    // M10: options + 路径补全走公共块
    // (J2 修复: 不覆盖 endpoint 路径 — anthropic 用完整路径, openai 仅 /v1 时补 /chat/completions; H2: 只认 /chat/completions)
    const options = _buildHttpOptions(url, _resolveRequestPath(url, isAnthropic), headers, useModel);
    // 2026-07-26 老板拍 "不是流式输出": native 路径也走流式 — SSE 逐 token onText,
    // tool_calls 按 index 增量组装, 结束拼回 llmResult 形状 (下游零改动)
    const wantStream = !!(opts && typeof opts.onText === 'function') && !isAnthropic;
    if (wantStream) {
      try { const o = JSON.parse(body); o.stream = true; body = JSON.stringify(o); } catch (_) {}
    }
    const req = (url.protocol === 'https:' ? https : http).request(options, (res) => {
      if (wantStream && res.statusCode >= 200 && res.statusCode < 300) {
        let buf = '', content = '', finishReason = null, usage = null;
        // 2026-08-02 修 (老板: "用deepseek为什么不是流式输出"): doubao-seed / deepseek reasoning 模型
        // 思考走 delta.reasoning_content, 旧代码只转 content → 思考全程 UI 死寂, 答案一次性弹出
        // 修: reasoning_content 包 <think> 转发 (跟 MiniMax 内联 think 格式/UI 约定一致), 不进 content (保持 tool 提取干净)
        let _reasoningOpen = false;
        let _reasonChars = 0;  // 2026-10-15: 思考累计字符 (给前端"还在想"一个能看见的量)
        const tcMap = new Map();
        let idle = null;
        // 2026-07-26 (老板截图: qwen 流式挂 16 分钟): lmstudio 慢慢滴 token 时 idle 永不触发
        // → 加总时长熔断 (默认 5min, PANGU_STREAM_TOTAL_MS 可覆盖)
        const _totalMs = _streamTotalMs(useModel, opts);
        const totalTimer = setTimeout(() => {
          try { req.destroy(); } catch (_) {}
          reject(_timeoutError('STREAM_TOTAL_TIMEOUT', _totalMs, {
            content,
            toolCalls: [...tcMap.values()].filter(t => t && t.function && t.function.name),
            reasonChars: _reasonChars,
          }));
        }, _totalMs);
        // 2026-10-16: 两段空闲预算 (为什么必须分段见文件头 _prefillMs 的注释)。
        // _gotByte=false 是 prefill 阶段, "还没吐字"不等于死; 吐过第一个字节之后
        // 才切回 90s, 那时才真的在判死活。
        let _gotByte = false;
        const resetIdle = () => {
          if (idle) clearTimeout(idle);
          const _ms = _gotByte ? _streamIdleMs() : _prefillMs(useModel);
          const _tag = _gotByte ? 'STREAM_IDLE_TIMEOUT' : 'STREAM_PREFILL_TIMEOUT';
          idle = setTimeout(() => {
            try { req.destroy(); } catch (_) {}
            reject(_timeoutError(_tag, _ms, {
              content,
              toolCalls: [...tcMap.values()].filter(t => t && t.function && t.function.name),
              reasonChars: _reasonChars,
            }));
          }, _ms);
        };
        resetIdle();
        res.on('data', chunk => {
          if (!_gotByte) { _gotByte = true; }
          resetIdle();
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const j = JSON.parse(data);
              if (j.usage) usage = j.usage;
              const choice = j.choices && j.choices[0];
              if (!choice) continue;
              if (choice.finish_reason) finishReason = choice.finish_reason;
              const delta = choice.delta || {};
              if (delta.reasoning_content) {
                try {
                  if (!_reasoningOpen) {
                    opts.onText('<think>'); _reasoningOpen = true;
                    _reasonChars = 0;
                    // 2026-10-15: 思考相位信号。
                    // 现场 (LM Studio 2026-10-15.log): qwen3.8-27b-mlx 把**全部**内容放
                    // reasoning_content, content 恒为 "\n\n"。这些思考会被 _emitStreamDelta
                    // 整段剥掉 (这正是它该做的 —— 思考不该进气泡), 于是本地 27B 思考的那
                    // 30~300 秒里, 前端一个字节都收不到, 老板看到的还是"跟死了一样"。
                    // 忠实复刻实测: 4 次 onText (<think> + 两段 reasoning + </think>)
                    // → 只 emit 1 条 stream_delta, 且是最后的正文。
                    // 光有 stream_delta 治不了"死寂", 必须单独告诉前端"我在思考"。
                    if (typeof opts.onReasoning === 'function') opts.onReasoning(true, 0);
                  }
                  opts.onText(delta.reasoning_content);
                  _reasonChars += delta.reasoning_content.length;
                  if (typeof opts.onReasoning === 'function') {
                    opts.onReasoning(true, _reasonChars);
                  }
                } catch (_) {}
              }
              if (delta.content) {
                if (_reasoningOpen) {
                  try { opts.onText('</think>'); } catch (_) {}
                  _reasoningOpen = false;
                  if (typeof opts.onReasoning === 'function') { try { opts.onReasoning(false, _reasonChars); } catch (_) {} }
                  _reasonChars = 0;
                }
                content += delta.content;
                try { opts.onText(delta.content); } catch (_) {}
              }
              for (const tc of (delta.tool_calls || [])) {
                const idx = tc.index != null ? tc.index : 0;
                const acc = tcMap.get(idx) || { id: undefined, type: 'function', function: { name: '', arguments: '' } };
                if (tc.id) acc.id = tc.id;
                if (tc.type) acc.type = tc.type;
                if (tc.function) {
                  if (tc.function.name) acc.function.name += tc.function.name;
                  if (tc.function.arguments) acc.function.arguments += tc.function.arguments;
                }
                tcMap.set(idx, acc);
              }
            } catch (_) {}
          }
        });
        res.on('end', () => {
          if (idle) clearTimeout(idle);
          clearTimeout(totalTimer);
          const toolCalls = [...tcMap.values()].filter(t => t.function && t.function.name);
          resolve({
            choices: [{ index: 0, message: { role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : undefined }, finish_reason: finishReason }],
            usage: usage || undefined,
          });
        });
        res.on('error', e => { if (idle) clearTimeout(idle); clearTimeout(totalTimer); reject(e); });
        return;
      }
      // M10: 非流式响应解析走公共块 (debug400=true 保留 400 时全量 dump 消息结构)
      _handlePlainResponse(res, body, resolve, reject, true);
    });
    // M10: socket 超时熔断 + error 走公共守护
    // (2026-08-03 48 分钟挂死实案: headers 到达前唯一兜底 — socket timeout 必须真 destroy)
    _attachReqGuards(req, options, reject);
// 2026-10-14: 必须显式带 Content-Length。不带 → Node 自动改用 Transfer-Encoding: chunked,
// 而 mlx-serve 26.9.4 的 HTTP 解析器不处理 chunked 请求体 (读到空 body) → 400
// "Invalid JSON in request body"。云端网关/nginx 都吃 chunked, 所以只有本地 mlx-serve 炸。
req.setHeader('Content-Length', Buffer.byteLength(body));
    req.write(body);
    req.end();
  }).then((_r) => { _perfDone('ok'); return _r; },
         (e) => { _perfDone('ERR', String((e && e.message) || e).slice(0, 80)); throw e; });
}

// 流式版 (J2 优化 2 - ): async generator, 实时 yield LLM text delta
async function* _callLLMForAgentStreamImpl(messages, modelConfig, toolsSchema, opts) {
  // M10: 前置解析走公共块 (stream 不用 temperature, 解构里忽略)
  const { useModel, apiKey, baseUrl, isAnthropic } = _resolveCallContext(modelConfig);

  // M10: 灵魂注入走公共块 (R26c: 老板 7/25 拍 '盘古需要适配所有模型才对')
  // 第 80 批: opts 里的 callableTools 一起带下去 (清单跟 API schema 对齐)。
  messages = _injectSoulSysMsgs(messages, useModel, opts && opts.soulScope, opts && opts.callableTools);

 // 2026-08-16 P0-B: 自动 compaction hook (M10: 走公共块; 原 arguments[3] 恒为 undefined, 行为保持 'default')
  messages = await _maybeCompactMessages(messages, useModel, undefined, 'stream');
  messages = _ensureUserTurn(messages, useModel);

 // 修: 上下文长度感知的截断 + max_tokens 计算 (2026-07-26: 4096 → cap 32768, reasoning 模型友好)
  messages = truncateMessagesForContext(messages, useModel, _truncateReserve(useModel));
  const inputTokens = estimateMessagesTokens(messages);
  const contextLength = getModelContextLengthSafe(useModel);
  const maxTokens = _resolveMaxTokens(useModel, inputTokens);

  console.log('[agent-llm-stream] model:', useModel.id, 'url:', baseUrl, 'isAnthropic:', isAnthropic, 'msgs:', messages.length, 'ctx:', contextLength, 'inputTokens:', inputTokens, 'maxTokens:', maxTokens);

  // 构造 body (跟 _callLLMForAgent 一致)
  const url = new URL(baseUrl);
  const headers = modelTransport.authHeaders(useModel, apiKey);
  let body;
  const temperature = _resolveTemperature(useModel);
  if (isAnthropic) {
    const mergedSystem = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n---\n\n');
    const userMessages = messages.filter(m => m.role !== 'system');
    body = JSON.stringify({
      model: modelTransport.canonicalModelName(useModel),
      max_tokens: maxTokens,
      temperature,
      stream: true,
      system: mergedSystem || undefined,
      messages: userMessages.map(m => ({ role: m.role, content: m.content }))
    });
  } else {
    if (toolsSchema.length === 0) {
      // 2026-08-02 修: stream 路径原本原样透传 messages, images 字段要么被上游忽略 (图丢) 要么 400。
      // 统一过 _adaptImagesForModel 转换, 并抹掉多余 images 字段防上游拒收。
      const _streamMessages = messages.map(m => {
        if (!Array.isArray(m.images) || m.images.length === 0) return m;
        const out = _adaptImagesForModel({ ...m }, m, useModel);
        delete out.images;
        return out;
      });
      body = JSON.stringify({
        model: modelTransport.canonicalModelName(useModel),
        max_tokens: maxTokens,
        temperature,
        // 2026-08-02 修 (老板: 不管什么模型都必须流式): 恢复 stream:true —
        // R80 改 stream:false "适配 reasoning 模型" 是误修 (reasoning_content fallback 已在 SSE 解析层处理),
        // 副作用: 上游返单 JSON → 解析 0 delta → 每轮白试 2 次 + fallback 非流式, legacy 路径全哑
        stream: true,
        stream_options: { include_usage: true },
        messages: _streamMessages
      });
      const wireEffort = _wireReasoningEffort(useModel);
      if (wireEffort && (wireEffort !== 'off' || _shouldSendReasoningEffort(useModel))) {
        try { const _b = JSON.parse(body); _b.reasoning_effort = wireEffort; body = JSON.stringify(_b); } catch (_) {}
      }
    } else {
      const _streamMessages = messages.map(m => {
        if (!Array.isArray(m.images) || m.images.length === 0) return m;
        const out = _adaptImagesForModel({ ...m }, m, useModel);
        delete out.images;
        return out;
      });
      body = JSON.stringify({
        model: modelTransport.canonicalModelName(useModel),
        max_tokens: maxTokens,
        temperature,
        stream: true,
        stream_options: { include_usage: true },
        messages: _streamMessages,
        tools: toolsSchema
      });
      const wireEffort = _wireReasoningEffort(useModel);
      if (wireEffort && (wireEffort !== 'off' || _shouldSendReasoningEffort(useModel))) {
        try { const _b = JSON.parse(body); _b.reasoning_effort = wireEffort; body = JSON.stringify(_b); } catch (_) {}
      }
    }
  }

  // M10: 路径补全走公共块
  const fetchUrl = _resolveRequestPath(url, isAnthropic);

  const fullUrl = `${url.protocol}//${url.host}${fetchUrl}`;
  const controller = new AbortController();
  // 2026-10-25 第 98 批: 同 _buildHttpOptions —— 按端点事实判本地, 不按品牌名。
  const _fetchTimeoutMs = _modelCapability.timeoutMs(useModel);
  const timeoutId = setTimeout(() => controller.abort(), _fetchTimeoutMs);
  let res;
  try {
    // L7 fix: 全局 fetch 在 Node < 18 或特殊构建中可能不可用, 兜底 node-fetch
    const _fetch = globalThis.fetch || require('node-fetch');
    res = await _fetch(fullUrl, { method: 'POST', headers, body, signal: controller.signal });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') throw new Error('LLM_FETCH_TIMEOUT_' + Math.round(_fetchTimeoutMs / 1000) + 's');
    throw e;
  }
  clearTimeout(timeoutId);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 500)}`);
  }

 // SSE 解析 (Node 22 ReadableStream) — 修: 支持不完整的 data: 行 + 检测未闭合 tool 块
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let hasUnclosedTool = false;
  let totalYielded = 0;
  let _reasoningBuf = '';   // 2026-10-16: 思考单独缓冲, 不混进正文流 (见下面 2026-10-16 注释)

  // 2026-10-25 (第 86 批): 把「这条流其实**没有正文**, 只有思考」这个**事实**
  // 报给调用方。
  //
  // 现场 (会话 probe87-fixed, 2026-10-25):
  //   合成层 (dispatcher 的 _synthesizeAndFinalize) 这一次调用上游, 上游整条流
  //   **一个 content delta 都没有**, 只回了 307 字 reasoning_content。
  //   老行为 (2026-07-28 起就有, 为了兼容 qwen3.6 / deepseek-r1 这类只回思考的模型):
  //     「整条流一个 content 都没有 ⇒ 把思考交出去 —— 给思考强于给空」
  //   在**主循环**里这是对的 (那类模型根本不会给正文); 但在**合成层**,
  //   这 307 字是模型的**计划口吻**:
  //     "We need synthesize, perhaps need actual files? … Need perhaps call tools
  //      ourselves … Use read_file both … tool calls commentary"
  //   —— 它是**思考**, 不是答案。于是主人收到的是一段英文自说自话,
  //   而不是综合稿 (现场 chunk/final 两个事件都是这 307 字)。
  //
  // 为什么不能靠「看文本像不像思考」来判: 那又是「拿词当判据」——
  //   本仓库 2026-10-25 这一整天治的就是这个病 (第 83/84/85 批)。
  //   事实就在手边 (上游到底给没给 content delta), 不用猜。
  //
  // 契约: opts.onReasoningOnly(reasoningChars) —— 只在「整条流零正文」时调一次。
  //   老调用方不传这个回调 ⇒ 行为**一个字都不变** (思考照旧交出去)。
  const _reportReasoningOnly = (n) => {
    try {
      if (opts && typeof opts.onReasoningOnly === 'function') opts.onReasoningOnly(n);
    } catch (_) { /* 上报失败不许影响主流 */ }
  };
  // 2026-10-16: 必须声明在函数作用域 —— 一开始写在 read 循环里面, 结果循环一结束
  // 下面的收尾就引用不到, 报 "_sawDone is not defined", 整条流式全废。
  let _sawDone = false;
  // 2026-10-16: 与 http.request 路径同一套两段空闲预算 (见文件头 _prefillMs)。
  // 第一个字节到达之前算 prefill —— 本地大 prompt 冷 prefill 45~90s 是正常的,
  // 拿 90s 去判它就是判死, 于是 destroy → legacy → ECONNRESET → 误切云端烧钱。
  let _gotByteFetch = false;
  try {
    while (true) {
      // 2026-07-26 (老板截图: 推演 37 分钟不结束): fetch 有 60s 超时但 SSE 读循环没有 idle 超时
      // lmstudio 卡死 (连接开着但不发数据) → for-await 永远挂起 → UI 永远"推演中"
      // 解: 90s 无数据 = idle 超时, 抛错走 fallback 非流式
      let readResult;
      let _idleGuard = null;
      try {
        readResult = await Promise.race([
          reader.read(),
          new Promise((_, rej) => {
            const _ms = _gotByteFetch ? _streamIdleMs() : _prefillMs(useModel);
            const _tag = _gotByteFetch ? 'STREAM_IDLE_TIMEOUT' : 'STREAM_PREFILL_TIMEOUT';
            _idleGuard = setTimeout(
              () => rej(_timeoutError(_tag, _ms, {
                content: '',
                toolCalls: [],
                reasonChars: _reasoningBuf.length,
                reasoning: _reasoningBuf,
              })),
              _ms);
          }),
        ]);
      } catch (idleErr) {
        try { await reader.cancel(); } catch (_) {}
        throw idleErr;
      } finally {
        // 2026-10-16: 这个 guard 以前**每次 read 都不清**, 一个正常的长流能攒下成百上千个
        // 挂着的 90s 定时器 —— 既吊着事件循环不放, 也是"流早就结束了进程还在"的来源。
        // 竞速赢了之后它就是纯垃圾, 必须清。
        if (_idleGuard) { try { clearTimeout(_idleGuard); } catch (_) {} _idleGuard = null; }
      }
      const { done, value } = readResult;
      if (value) { buf += decoder.decode(value, { stream: true }); _gotByteFetch = true; }
      if (done) break;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        // 2026-10-16: 这里原来写的是 `return` —— 直接从生成器返回。**这个契约不能动**:
        // synthesis-stream-idle-20261016 T3 明确钉死了"上游正常收尾但一个字没给 → 流层
        // 返空串不报错, 防线在收口助手自己身上"。空流报不报错不是这里能改的东西。
        // 但要借这个出口把"整条流只有思考"的兜底补上 —— 原来这里 return, 那条兜底压根
        // 不可达, 等于没有 (纯思考流会交一份空答案, 比 2026-07-28 修之前还差)。
        // 所以: 记标记 → 跳出内层 → 正常走收尾 → 有思考就交思考 → 再按原契约 return。
        if (data === '[DONE]') { _sawDone = true; break; }
        try {
          const j = JSON.parse(data);
          let delta = '';
          if (isAnthropic) {
            if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') delta = j.delta.text || '';
          } else {
            // 2026-10-16 (lt7 实机: 用户第一眼看到的是 500 字英文自我推演, 之后才是中文答复):
            // 原来这里写的是 `content || reasoning_content || ''` —— **思考混进正文流**。
            // 探针实测 qwen3.8-27b-mlx 分得很清 (reasoning 173 字 / content 47 字),
            // 而且**思考先于正文到达**, 于是开头那些 `content:'' + reasoning_content:'...'`
            // 的 delta 全被 `||` 兜底当成正文 yield 出去, 累加进 textContent ——
            // 收口(_synthesizeStreamText)和主循环(textContent += delta)都中招,
            // 表现是"答案前面挂一大段模型自说自话"。
            //
            // 但**不能直接删掉 fallback**: 2026-07-28 那次修的是真问题 —— qwen3.6/deepseek-r1
            // 这类模型整条流可能只回 reasoning_content, 删了它们流式直接全废。
            //
            // 修法: 正文只走 content; reasoning 单独缓冲。**只有整条流一个 content 都没有**
            // 才把 reasoning 放出来 —— 那种情况本来就是"模型没给正文", 给思考强于给空。
            // 有正文时 reasoning 一律不进流, 于是泄漏根除且旧行为不回归。
            const _dl = j.choices?.[0]?.delta || {};
            if (typeof _dl.content === 'string' && _dl.content) delta = _dl.content;
            else if (typeof _dl.reasoning_content === 'string' && _dl.reasoning_content) {
              _reasoningBuf += _dl.reasoning_content;
            }
          }
          if (delta) {
            totalYielded += delta.length;
            hasUnclosedTool = _hasUnclosedToolBlock(delta, hasUnclosedTool);
            yield delta;
          }
        } catch (e) { console.error('[sse-parse-skip]', e.message, 'data:', data.slice(0, 100)); }
      }
      if (_sawDone) break;
    }
    // 上游正常收尾 ([DONE]): 有正文就照常交付; 只有正文没有思考的, 交空串不报错 (既有契约)。
    if (_sawDone) {
      if (totalYielded === 0 && _reasoningBuf) {
        console.warn('[llm-stream] REASONING_ONLY_STREAM: 上游正常收尾但整条流无 content, '
          + _reasoningBuf.length + ' 字思考已交回 (兼容只回 reasoning_content 的模型)');
        _reportReasoningOnly(_reasoningBuf.length);
        totalYielded += _reasoningBuf.length;
        yield _reasoningBuf;
      }
      return;
    }
    // 流正常结束但未闭合 tool 块 → 报错让外层 fallback
    if (hasUnclosedTool || buf.includes('<tool')) {
      throw new Error('STREAM_ENDED_WITH_UNCLOSED_TOOL_BLOCK');
    }
    // 整条流没有正文, 但有思考 —— 只有到这一步才把思考交出去 (见上面 2026-10-16 的注释)。
    // 这种情况模型本来就没给答案, 交思考强于交空; 有正文时这条路永远走不到。
    if (totalYielded === 0 && _reasoningBuf) {
      console.warn('[llm-stream] REASONING_ONLY_STREAM: 整条流无 content, ' + _reasoningBuf.length
        + ' 字思考已交回 (兼容 qwen3.6/deepseek-r1 这类只回 reasoning_content 的模型)');
      _reportReasoningOnly(_reasoningBuf.length);
      totalYielded += _reasoningBuf.length;
      hasUnclosedTool = _hasUnclosedToolBlock(_reasoningBuf, hasUnclosedTool);
      yield _reasoningBuf;
    }
    // 没有任何输出 → 可能是模型空白截断
    if (totalYielded === 0) {
      throw new Error('STREAM_ENDED_WITH_ZERO_CONTENT');
    }
  } finally {
    try { reader.releaseLock(); } catch (e) { /* lock already released */ }
  }
}

// 检测增量文本中是否有未闭合的 <tool> 块
function _hasUnclosedToolBlock(delta, prev) {
  if (prev) return true;
  if (delta.includes('<tool') && !delta.includes('</tool>')) return true;
  return false;
}

async function callLLMRouter(messages, opts = {}) {
  // Automatic routing is opt-in. When disabled, honor the user's selected
  // model and do not silently spend quota on another provider.
  if (!isAutoModelSelectionEnabled()) {
    const selected = getDefaultModel();
    if (!selected) throw new Error('[router] no configured current model');
    const result = await callLLM(messages, selected);
    const _u = result && result.usage ? result.usage : {};
    const _pt = Number(_u.prompt_tokens || _u.input_tokens || _u.promptTokens || 0);
    const _ct = Number(_u.completion_tokens || _u.output_tokens || _u.completionTokens || 0);
    await _recordRouterMetrics(result, selected, opts, _pt, _ct);
    return result;
  }
  const userInput = (opts && opts.userInput) || (Array.isArray(messages) ? (messages.find(m => m && m.role === 'user') || {}).content || '' : '');
  const budget = checkModelBudget();
  const routing = smartRoute(userInput, { budgetRatio: budget.ratio });

  if (routing.warning === 'NO_MODELS_AVAILABLE' || !routing.primary) {
    const err = new Error('[router] no models available in models.json');
    err.code = 'ROUTER_NO_MODELS';
    throw err;
  }

  // 2026-10-17: 与 J2 主循环对齐 —— env 逃生阀 + 主人配的兜底链, 两个条件都是活的。
  // 原来这里是 `isSilentFailFallbackEnabled() ? [primary, ...chain] : [primary]`,
  // 而那个函数硬编码 false → 恒等于 [primary], 配置里的 llm.fallback_chain
  // 对这条路径也 100% 不可达 (与 j2_agent_loop 的双重死锁同源)。
  //
  // 自动选模型仍然没开: primary 还是路由/主人选定的那个, 兜底只在它失败之后才轮到。
  // 没配 fallback_chain → resolveFallbackChain 给空链 → 与改动前逐字节一致。
  let _fallbackChain = [];
  try {
    const { resolveFallbackChain } = require('./j2_model_policy');
    const primaryId = (routing && routing.primary && routing.primary.id) || null;
    _fallbackChain = resolveFallbackChain(_config, primaryId);
  } catch (_) { /* 构造失败退化成"不兜底", 不阻断正常请求 */ }
  const chain = isSilentFailFallbackEnabled() ? [routing.primary, ..._fallbackChain] : [routing.primary];
  const errors = [];

  for (let i = 0; i < chain.length; i += 1) {
    const model = chain[i];
    try {
      const result = await callLLM(messages, _configModelToLegacyFormat(model));
      const usage = (result && result.usage) || {};
      const promptTokens = Number(usage.prompt_tokens || usage.input_tokens || usage.promptTokens || 0);
      const completionTokens = Number(usage.completion_tokens || usage.output_tokens || usage.completionTokens || 0);
      recordModelSpend(model, promptTokens, completionTokens);
      await _recordRouterMetrics(result, model, opts, promptTokens, completionTokens);
      result._routing = {
        strategy: routing.strategy,
        classified: routing.classified,
        chain_index: i,
        chain_length: chain.length,
      };
      return result;
    } catch (error) {
      console.warn(`[callLLMRouter] ${model.id} failed (chain ${i + 1}/${chain.length}): ${error.message && error.message.slice(0, 200)}`);
      errors.push({ model: model.id, error: error.message });
    }
  }

  const err = new Error(`[router] all ${chain.length} models failed: ${errors.map(e => e.model).join(', ')}`);
  err.code = 'ROUTER_ALL_FAILED';
  err.errors = errors;
  throw err;
}

async function _recordRouterMetrics(result, model, opts = {}, inputOverride, outputOverride) {
  try {
    const usage = (result && result.usage) || {};
    const input = Number(inputOverride ?? usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? 0);
    const output = Number(outputOverride ?? usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? 0);
    const { recordTokenUsage } = require('./metrics');
    await recordTokenUsage({ session_id: opts.session_id || 'default', round: Number(opts.round) || 0, tool_name: 'llm_call', model: model.id || 'unknown', input_tokens: input, output_tokens: output, cache_hit_tokens: Number(usage.cache_read_input_tokens || usage.cached_tokens || 0), ts: Date.now() });
  } catch (_) {}
}

function _configModelToLegacyFormat(model) {
  // 2026-08-18 fix: 从 _config.llm.models 找完整 model (endpoint/api_key/context_length/temperature)
  // 否则 router models.json 简化版可能丢字段 → fallback 到 openai_base_url 全走 1234
  const fullModel = (_config && _config.llm && Array.isArray(_config.llm.models))
    ? _config.llm.models.find(m => m && m.id === model.id)
    : null;
  if (fullModel) {
    return {
      id: fullModel.id,
      name: fullModel.name || fullModel.id,
      api_model: fullModel.api_model || fullModel.model_name || fullModel.name || fullModel.id,
      provider: fullModel.provider,
      protocol: modelTransport.normalizeProtocol(fullModel),
      endpoint: fullModel.endpoint,
      api_key: fullModel.api_key,
      // 2026-10-26 (第 110 批): 明文已收编进凭证库, 解析靠的是**引用**。
      //   legacy 格式以前只带 api_key ⇒ 凭证引用丢了 ⇒ 取不到 key。
      api_key_credential: fullModel.api_key_credential,
      api_key_env: fullModel.api_key_env,
      context_length: fullModel.context_length,  // 总上下文窗口 (input + output 上限)
      max_tokens: fullModel.max_tokens || 32768,  // 单次请求 output 上限 (不能跟 context_length 混)
      temperature: fullModel.temperature,
      vision: fullModel.vision,
      capabilities: fullModel.capabilities,
    };
  }
  // fallback: 用 router 字段
  return {
    id: model.id,
    name: model.id,
    api_model: model.api_model || model.model_name || model.name || model.id,
    provider: model.provider,
    protocol: modelTransport.normalizeProtocol(model),
    endpoint: model.api_base,
    api_key: process.env[model.env_var] || '',
    max_tokens: model.max_tokens || 32768,
    temperature: undefined,
  };
}

module.exports = {
  init,
  _injectSoulSysMsgs,
  _parseSSEBody,
  _upstreamSSEError,
  // 2026-10-25 (第 90 批): 导出给 agents/sub-agent.js —— 它有**自己的一套** HTTP 客户端,
//   那条路上同样会把「上游回了一整页 HTML」报成裸的 JSON 语法错。
//   判据只留一份 (形态 + 状态码), 两处不各写一份。
  _upstreamBodyDiagnosis,
  _handlePlainResponse,
  _normalizeEndpoint,
  _adaptImagesForModel,
  // 2026-10-25 (第 85 批): 导出给 tests/tool-result-adjacency-20261025.test.js ——
  // 「tool 结果必须紧跟它的 assistant」这条契约的**边界兜底**在这里, 必须能直接测。
  _adaptOpenAIMessages,
  _loadLongTermMemory,
  _loadToolSummary,
  _mcpSchemasForLLM,
  _loadEvolutionStats,
  _buildSystemMessages,
  _resolveTemperature,
  // 2026-10-16: 导出给 sub-agent.js 的 planner 用 —— 见该文件 runPlanner 的注释。
  // 本地模型的 reasoning_effort **字段**是空转的 (模型侧 "No valid custom reasoning
  // fields found"), 真正收得到的是提示词层这条指令。之前它只挂在主链路的 soul 块上,
  // planner 走自己的 runPlanner → 那条指令从来没到过它眼前, 于是本地 27B 上
  // planner 想 7327 字正文只吐 192 字 (实测 165s 里 160s 在思考)。
  _reasoningBudgetInstruction,
  _maxTokensCap,
  _resolveMaxTokens,
  _wireReasoningEffort,
  _resolveApiKey,
  _PROVIDER_CRED_KEYS,
  _credKeyFor,
  callLLM,
  extractContent,
  extractParts,
  // 2026-10-27 (第 112 批): 正文/思考/截断三个**事实**一次拿齐 ——
  // 上层靠它决定重试/升级, 不用再拿「文本像不像思考」去猜。
  extractAnswer,
  _loadToolsSchemaForLLM,
  _sanitizeMessages,
  _extractToolCallsAnthropic,
  _extractToolCallsOpenAI,
  _buildAssistantWithToolCallsAnthropic,
  _buildAssistantWithToolCallsOpenAI,
  _buildToolResultsAnthropic,
  _buildToolResultsOpenAI,
  // 2026-10-16: 两段空闲预算的判定函数导出给护栏钉死。
  // 「prefill 预算必须显著大于 idle 预算」是这次修复的全部要害, 一旦有人把两者
  // 写回同一个值就等于把 bug 请回来, 所以要在测试里钉成不变量。
  _streamIdleMs,
  _prefillMs,
  _streamTotalMs,
  // 2026-10-23 (第 64 批): 超时错误工厂 —— 导出是为了让「超时必须带 partial」这条
  //   能被**直接**验 (tests/timeout-policy-20261023.test.js)。
  _timeoutError,
  _warmupLLM,
  _callLLMForAgent,
  _callLLMForAgentRaw,
  _callLLMForAgentStream,
  _hasUnclosedToolBlock,
  callLLMRouter,
};
