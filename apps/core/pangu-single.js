// Global safe-guard: must be first
const safeGuard = require('./pangu-single/safe-guard/global');
safeGuard.install();

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const sseUtils = require('./pangu-single/sse/sse-utils');

const PORT = parseInt(process.env.PANGU_PORT || '18901', 10); // 2026-09-12: env 可覆盖, 便于起一次性测试实例
const BIND_HOST = '127.0.0.1';
// 节点配置路径 —— 不写死任何人的机器名。解析规则见 config/node_config.js。
//   ⚠️ 解析失败必须**真的起不来**: 降级成空配置就是「盘古起来了但请求全挂」
//   的空气泡 (2026-10-23 踩坑日志)。所以这里显式 exit(1), 不是 throw。
let CONFIG_PATH;
try {
  CONFIG_PATH = require('./config/node_config').requireNodeConfigPath();
} catch (e) {
  console.error('[node_config] ' + e.message);
  process.exit(1);
}

// N5 B1 fix: 必须先于 _config 初始化 (boot 流程 line 62 调 saveConfig)
const panguHelpers = require('./modules/pangu_helpers');
const { getYaoVector } = require('./64i/hexagram_vector');
const inlineRouter = require('./pangu-single/routes/inline_router');
const httpServer = require('./modules/http_server');
// 2026-10-28 (第 139 批): 根路径不再是那张裸 API 索引页 —— `/` ⇒ 工作台 (302),
//   API 索引页在 `/api`。静态页出口只剩 webStatic 这一个 (老的 modules/api_index.js 已删),
//   core 里不再有第二个「伺服页面」的地方。
const webStatic = require('./pangu-single/routes/web_static'); // 静态页出口 (/ 根路径, /app 工作台, /api 索引页)
const basePrefix = require('./pangu-single/routes/base_prefix'); // 反代前缀 (第 141 批: 前端全用相对路径)
const { attachGracefulShutdown } = require('./modules/startup');
const sessionStore = require('./modules/session_store');
const { _recordSessionToMemory, _mergeSessionsIntoMemory, _incrementalReindex, _dateOffset } = require('./modules/memory_helpers');
const { init: initPanguDecide, decideOne, _handlePanguDecide, _handlePanguDispatch } = require('./modules/pangu_decide');
const { _recordEvolution } = require('./modules/evolution_record');
// N5 B6: _origResWrite 占位 (agent_stream 内部重新创建)
// H16: 显式 .call(res, ...) 防止 method 提取时丢失 this 绑定
function _origResWrite(res, data, encoding, cb) {
  if (typeof cb === 'function') {
    return res.write(data, encoding, cb);
  }
  return res.write(data, encoding);
}
const _origResWrite_arrow = (res, data, encoding, cb) => res.write(data, encoding, cb);
const { _runAgentLoopLegacyStream } = require('./modules/j2_agent_loop');
const { _runPanguDispatcherLoop } = require('./modules/j2_dispatcher');
const { saveConfig, readJsonBody, checkLocalOrigin, safeResWrite,
        getModelContextLength, estimateMessagesTokens, truncateMessagesForContext,
        getCurrentModel, getDefaultModel, normalizeModels,
        MAX_BODY_BYTES } = panguHelpers;

// 完整预设数据
const PRESETS = [
  { key: "lmstudio", category: "local", name: "LM Studio", api_protocol: "openai", base_url: "http://127.0.0.1", default_port: 1234, default_model: "google/gemma-4-26b-a4b-qat", api_key_placeholder: "lm-studio", context_length: 8192, note: "OpenAI 兼容。LM Studio 启动后默认在 :1234" },
  { key: "ollama", category: "local", name: "Ollama", api_protocol: "openai", base_url: "http://127.0.0.1", default_port: 11434, default_model: "llama3.1", api_key_placeholder: "ollama", context_length: 128000, note: "OpenAI 兼容(/v1)。`ollama serve` 跑后默认 :11434" },
  { key: "vllm", category: "local", name: "vLLM", api_protocol: "openai", base_url: "http://127.0.0.1", default_port: 8000, default_model: "meta-llama/Llama-3-8B", api_key_placeholder: "EMPTY", context_length: 8192, note: "vLLM OpenAI 兼容 server。`vllm serve` 后默认 :8000" },
  { key: "llamacpp", category: "local", name: "llama.cpp", api_protocol: "openai", base_url: "http://127.0.0.1", default_port: 8080, default_model: "llama", api_key_placeholder: "EMPTY", context_length: 4096, note: "llama.cpp --server 模式,默认 :8080" },
  { key: "openai", category: "cloud", name: "OpenAI", api_protocol: "openai", base_url: "https://api.openai.com/v1/chat/completions", default_port: 0, default_model: "gpt-4o", api_key_placeholder: "sk-...", context_length: 128000, note: "OpenAI 官方。需要 API key",
    models: [
      { id: "gpt-4o", label: "GPT-4o", context_length: 128000, tier: "all", thinking: "off", note: "老旗舰,快" },
      { id: "gpt-4.1", label: "GPT-4.1", context_length: 1048576, tier: "paid", thinking: "off", note: "最新非推理" },
      { id: "gpt-5", label: "GPT-5 (thinking)", context_length: 400000, tier: "paid", thinking: "on", note: "最新旗舰,默认推理" },
      { id: "o4-mini", label: "o4-mini", context_length: 200000, tier: "paid", thinking: "on", note: "推理小模型" },
      { id: "o3", label: "o3", context_length: 200000, tier: "paid", thinking: "on", note: "推理旗舰" }
    ]
  },
  { key: "deepseek", category: "cloud", name: "DeepSeek", api_protocol: "openai", base_url: "https://api.deepseek.com/v1/chat/completions", default_port: 0, default_model: "deepseek-chat", api_key_placeholder: "sk-...", context_length: 64000, note: "OpenAI 兼容,价格便宜",
    models: [
      { id: "deepseek-chat", label: "DeepSeek-V3 (Chat)", context_length: 64000, tier: "all", thinking: "off", note: "便宜大碗,代码强" },
      { id: "deepseek-reasoner", label: "DeepSeek-R1", context_length: 64000, tier: "all", thinking: "on", note: "推理模型" }
    ]
  },
  { key: "kimi", category: "cloud", name: "Kimi (月之暗面)", api_protocol: "openai", base_url: "https://api.kimi.com/coding/v1", default_port: 0, default_model: "k3-256k", api_key_placeholder: "sk-kimi-...", context_length: 262144, note: "OpenAI 兼容,中文好,256K context,推理模型 (reasoning_content)",
    models: [
      { id: "k3-256k", label: "Kimi K3 256K", context_length: 262144, tier: "Moderato+", thinking: "on", note: "K3 256K 版本 (推荐)" },
      { id: "k3", label: "Kimi K3 (1M context)", context_length: 1048576, tier: "Allegretto+", thinking: "on", note: "1M 旗舰,需高档会员" },
      { id: "kimi-for-coding", label: "Kimi K2.7 Code", context_length: 262144, tier: "all", thinking: "on", note: "代码补全" },
      { id: "kimi-for-coding-highspeed", label: "Kimi K2.7 Code 高速版", context_length: 262144, tier: "Allegretto+", thinking: "on", note: "6 倍速,3 倍消耗" }
    ]
  },
  { key: "zhipu", category: "cloud", name: "智谱 GLM", api_protocol: "openai", base_url: "https://open.bigmodel.cn/api/paas/v4/chat/completions", default_port: 0, default_model: "glm-4-plus", api_key_placeholder: "key-...", context_length: 128000, note: "OpenAI 兼容,国产大模型",
    models: [
      { id: "glm-4-plus", label: "GLM-4 Plus", context_length: 128000, tier: "paid", thinking: "off", note: "智谱旗舰,非推理" },
      { id: "glm-4-flash", label: "GLM-4 Flash", context_length: 128000, tier: "free", thinking: "off", note: "免费,快" },
      { id: "glm-z1-air", label: "GLM-Z1 Air", context_length: 128000, tier: "paid", thinking: "on", note: "推理模型" }
    ]
  },
  { key: "qwen", category: "cloud", name: "通义千问 DashScope", api_protocol: "openai", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", default_port: 0, default_model: "qwen-plus", api_key_placeholder: "sk-...", context_length: 128000, note: "OpenAI 兼容模式,阿里云",
    models: [
      { id: "qwen-plus", label: "Qwen Plus", context_length: 131072, tier: "paid", thinking: "off", note: "阿里主力" },
      { id: "qwen-max", label: "Qwen Max", context_length: 131072, tier: "paid", thinking: "off", note: "阿里旗舰非推理" },
      { id: "qwen3-max-thinking", label: "Qwen3 Max Thinking", context_length: 262144, tier: "paid", thinking: "on", note: "推理旗舰" },
      { id: "qwen-turbo", label: "Qwen Turbo", context_length: 1000000, tier: "paid", thinking: "off", note: "1M 长文,快" }
    ]
  },
  { key: "volcengine", category: "cloud", name: "火山方舟 (Volcengine Ark)", api_protocol: "openai", base_url: "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions", default_port: 0, default_model: "doubao-seed-code", api_key_placeholder: "32b47859-...", context_length: 128000, note: "字节火山方舟, OpenAI 兼容, 需 API key",
    models: [
      { id: "doubao-seed-code", label: "Doubao Seed Code", context_length: 256000, tier: "paid", thinking: "off", note: "代码专用" },
      { id: "doubao-1-5-pro", label: "Doubao 1.5 Pro", context_length: 128000, tier: "paid", thinking: "off", note: "字节主力" },
      { id: "doubao-1-5-thinking-pro", label: "Doubao 1.5 Thinking Pro", context_length: 128000, tier: "paid", thinking: "on", note: "字节推理" }
    ]
  },
  { key: "minimax", category: "cloud", name: "MiniMax", api_protocol: "openai", base_url: "https://api.minimaxi.com/v1/chat/completions", default_port: 0, default_model: "MiniMax-M3", api_key_placeholder: "sk-cp-...", context_length: 524288, note: "OpenAI 兼容(走 /v1/chat/completions, 老板实际用这个)",
    models: [
      { id: "MiniMax-M3", label: "MiniMax M3", context_length: 524288, tier: "paid", thinking: "on", note: "M3 推理旗舰 (默认)" }
    ]
  },
  { key: "anthropic", category: "cloud", name: "Anthropic Claude", api_protocol: "anthropic", base_url: "https://api.anthropic.com/v1/messages", default_port: 0, default_model: "claude-sonnet-4-5", api_key_placeholder: "sk-ant-...", context_length: 200000, note: "Anthropic 官方 Messages API",
    models: [
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", context_length: 200000, tier: "paid", thinking: "off", note: "Sonnet 旗舰 (默认)" },
      { id: "claude-opus-4-1", label: "Claude Opus 4.1", context_length: 200000, tier: "paid", thinking: "off", note: "Opus 旗舰,贵" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", context_length: 200000, tier: "paid", thinking: "off", note: "快便宜" }
    ]
  },
  { key: "custom", category: "local", name: "Custom (Local)", api_protocol: "openai", base_url: "http://127.0.0.1", default_port: 8080, default_model: "", api_key_placeholder: "", context_length: 4096, note: "自定义本地 server,OpenAI 兼容" },
  { key: "custom-cloud", category: "cloud", name: "Custom (Cloud)", api_protocol: "openai", base_url: "https://", default_port: 0, default_model: "", api_key_placeholder: "", context_length: 8192, note: "自定义云端 endpoint" }
];

// 加载配置
let _config = {};
// 2026-10-26: PANGU_MODEL 致命错误出口。
//   变量必须在 try **外面** 声明 —— 配置初始化那整段被一个 catch 包着,
//   里面抛的任何错都会被降级成空配置 ("盘古起来了但请求全挂", 2026-10-23 踩坑日志)。
//   PANGU_MODEL 指向的模型不可用时, 我们要的是**真的起不来**, 不是空壳硬撑。
let _modelEnvFatal = null;
try {
  _config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!_config.llm) _config.llm = {};
  if (!_config.voice || typeof _config.voice !== 'object') _config.voice = {};
  if (_config.voice.stt_endpoint === 'http://127.0.0.1:8765') _config.voice.stt_endpoint = '/api/voice/transcribe';
  if (!_config.llm.models || !Array.isArray(_config.llm.models)) {
    _config.llm.models = [];
  }
  // ── 2026-10-26 (第 110 批): 启动时收编落盘明文密钥 ──
  //   规则: 密钥值只允许存在 ~/.pangu/credentials.json (600);
  //         项目目录里的配置只准留**引用** (api_key_credential)。
  //   为什么在启动时自动做, 而不是让人记得手工搬:
  //     手工迁移是一次性动作 —— 下次谁手改配置又把明文写回去, 就回到原样。
  //     机制自己收编, 人才不会跟它搏斗。
  //   收编完不需要额外落盘: 下面 init 之后的 saveConfig() 会把改过的配置写回去。
  //   ⚠️ 这里不许 throw —— 外层 catch 会把整段配置降级成空配置
  //      ("盘古起来了但请求全挂", 2026-10-23 踩坑日志)。
  try {
    const _nc = require('./modules/node_credentials');
    const _harvest = _nc.harvestInlineSecrets(_config);
    if (_harvest.changed) {
      _harvest.harvested.forEach(h => {
        if (h.name) console.log('[credentials] 已收编明文密钥 → 凭证库 ' + h.name + ' (' + h.path + ')');
        else console.warn('[credentials] 收编失败, 明文仍在配置里: ' + h.path + ' (' + (h.error || '?') + ')');
      });
    }
    // 平行的配置副本 (历史上还有 ~/.pangu/config.json) 也要收编 --
    //   规则是「密钥值只允许存在凭证库」, 规则得覆盖**所有**落盘副本。
    //   不然就是「主配置收编干净了, 副本里还躺着同一把 key」= 没收编。
    try {
      const _known = {};
      for (const m of (_config.llm.models || [])) {
        if (m && m.api_key_credential) _known[m.id] = m.api_key_credential;
      }
      const _legacy = require('path').join(os.homedir(), '.pangu', 'config.json');
      const _rep2 = _nc.harvestFile(_legacy, { knownNames: _known });
      if (_rep2.changed) {
        _rep2.harvested.forEach(h => {
          if (h.name) console.log('[credentials] 已收编明文密钥 → 凭证库 ' + h.name + ' (' + h.path + ' @ ~/.pangu/config.json)');
        });
      }
    } catch (e) {
      console.warn('[credentials] 旧配置副本收编失败 (不影响启动):', e && e.message);
    }
  } catch (e) {
    console.warn('[credentials] 密钥收编失败 (不影响启动):', e && e.message);
  }
  // 2026-08-02 (老板拍: 多模态的模型, 盘古加载的时候如何自己识别):
  // 启动时自动识别每个模型的视觉能力, config 显式 vision 标注优先, 未标注按模型特征自动判定。
  try {
    const { enrichModels } = require('./modules/model_capabilities');
    for (const line of enrichModels(_config.llm.models)) console.log('[capabilities]', line);
  } catch (e) { console.warn('[capabilities] 自动识别失败:', e.message); }
  // 2026-10-25 (第 98 批): 厂商档案从配置注入 —— 「温度锁 / 输出上限 / 超时」这些
  // 厂商怪癖是**数据**不是代码分支。加一个新厂商 = 在配置里加一段 vendor_profiles,
  // 不必改代码 (代码里的档案只是配置缺失时的兜底)。
  try {
    require('./modules/model_capability').init({ _config });
  } catch (e) { console.warn('[capabilities] 厂商档案注入失败:', e.message); }
  // 2026-10-26 (第 101 批): 厂商猜测规则表也是**数据** —— 加一个厂商 = 配置里
  // 加一行 llm.provider_guess_rules, 不必改代码。
  try {
    require('./modules/llm_capabilities_sync').init({ _config });
  } catch (e) { console.warn('[capabilities] 厂商猜测规则注入失败:', e.message); }
 // 迁移 — 旧 default 标记 / agent_default_model / llm.default_model → current_model_id 单一真源
  // 启动时一次性清理, 清完不再保留
  if (_config.llm && Array.isArray(_config.llm.models)) {
    _config.llm.models.forEach(m => { delete m.default; });
  }
  if (_config.llm && _config.llm.default_model) {
    if (!_config.llm.current_model_id) {
      _config.llm.current_model_id = _config.llm.default_model;
    }
    delete _config.llm.default_model;
  }
  if (_config.llm && !_config.llm.current_model_id && _config.llm.models && _config.llm.models.length > 0) {
    const enabled = _config.llm.models.find(m => m.enabled !== false);
    _config.llm.current_model_id = enabled ? enabled.id : _config.llm.models[0].id;
  }
  // 2026-10-26: PANGU_MODEL —— 用环境变量定认知模型 (env > 配置文件 > enabled+priority 兜底)。
  //   口径与三条铁律见 modules/model_env_override.js 的头注释。
  //   ⚠️ 这里**不许** throw: 上面那个 catch 会把整段降级成空配置, 于是
  //      "PANGU_MODEL 指错了" 会表现成 "盘古起来了但请求全挂" —— 又是那个病。
  //      所以这里只记录, 致命错误在 try/catch **之外**抛 (见文件末尾)。
  try {
    const _envModel = require('./modules/model_env_override');
    const _rep = _envModel.applyEnvOverride(_config);
    if (_rep.requested) {
      if (_rep.ok) {
        console.log(
          '[model-env] PANGU_MODEL=' + _rep.id
          + ' → 认知模型 = ' + _rep.id
          + ' (来源: 环境变量; 配置文件里的 llm.current_model_id 不参与这次选择)'
        );
      } else {
        const _why = _envModel.describeFailure(_rep);
        console.error('[model-env] ' + _why);
        _modelEnvFatal = new Error(_why);
      }
    }
  } catch (e) {
    console.error('[model-env] 环境变量覆盖失败:', e && e.message);
    _modelEnvFatal = e;
  }
  // 删 agent_default_model 双轨 (Agent 循环也用 current_model_id)
  delete _config.agent_default_model;
  // §0.49 batch2: agent.role_configs 8 个 sub-agent 默认配置 (P0-#34 batch1)
  // 8 个拼音将灵全列, 缺啥补啥。身份真源 = agents/gua-identity.js 的 GUA_CODES,
  // 别再拿前端某份手抄表当对齐依据 (desktop 的 ROLE_TOOL_MAPPING 已于 2026-10-18 删除:
  // 零引用 + 用英文 code, 是"同一张表抄 6 遍还用 6 套名字"的最后一份)。
  if (!_config.agent) _config.agent = {};
  if (!_config.agent.role_configs || typeof _config.agent.role_configs !== 'object') _config.agent.role_configs = {};
  // §0.49 batch2+4: per-sub-agent 推荐预设 (按人格强项 + 行为习性调)
  // 2026-09-14 重排 (老板拍: 完全按各 subagent 特性一个一个分配):
  //   调度/规划 tools=[] 纯输出 JSON → 步数砍到 10/5 (原 50/40 浪费); 执行写盘有顺序依赖 → 并行砍 false (原 true 是隐患);
  //   分析/检查/巡bug 全只读安全工具 → 并行 true; 反思/学习 memory 读写要有序 → 并行 false;
  //   记忆: 执行/检查干完就走 false, 反思/学习/巡bug 本职或越巡越准 true
  //   纪律锁 (不按特性放开): auto_approve 全 false, sandbox_strict 全 true
  // 2026-09-18 定死 8 将灵 = 盘古身体: 大脑(乾)收口·出结论; 手指(坎)拆; 眼(离)读;
  //   手(坤)做; 舌/秤(兑)验; 耳(巽)找雷; 心(震)复盘; 骨(艮)记.
  // 数据流: 你→大脑拆→坎清单→[离读→坤做→兑验](巽按需/兑fail→震)→done→艮记→7位→大脑出结论→你
  // 行尾注释原来挂着上一代的英文身份 (大脑·synthesizer / 手·executor …),
  // 键却早就是拼音 —— 同一行两个名字, 下一个人照着注释写代码就会写出第二套。
  // 2026-10-18: 全部改成拼音, 一个角色在这份配置里只有一个名字。
  const SUB_AGENT_DEFAULTS = {
    qian:  { max_tool_iterations: 10, reasoning_effort: 'medium',   parallel_tools: false, auto_approve: false, sandbox_strict: true, memory_enabled: true  },  // 大脑·qian: 收 7 将灵结果, 洗 think, 出结论(长度自适应), 纯 LLM 无工具
    kan:   { max_tool_iterations: 5,  reasoning_effort: 'low',   parallel_tools: false, auto_approve: false, sandbox_strict: true, memory_enabled: true  },  // 手指·kan: 拆大任务→子任务清单+依赖+耗时 (todo_write/plan_create)
    li:    { max_tool_iterations: 60, reasoning_effort: 'medium',   parallel_tools: true,  auto_approve: false, sandbox_strict: true, memory_enabled: true  },  // 眼·li: 列目录/读文件/检索/研判 (list_directory/read_file/memory_search), 不写盘
    kun:   { max_tool_iterations: 80, reasoning_effort: 'low', parallel_tools: false, auto_approve: false, sandbox_strict: true, memory_enabled: false },  // 手·kun: 落盘/跑命令/生成 artifact, 执行到底 (exec_command/write_file)
    dui:   { max_tool_iterations: 30, reasoning_effort: 'medium', parallel_tools: true,  auto_approve: false, sandbox_strict: true, memory_enabled: false },  // 舌/秤·dui: 验 pass/fail 对账 (http_check/exec_command ls), 不修不改
    xun:   { max_tool_iterations: 70, reasoning_effort: 'medium', parallel_tools: true,  auto_approve: false, sandbox_strict: true, memory_enabled: true  },  // 耳·xun: 找隐藏 bug/安全隐患/回归, 只找不修 (exec_command/memory_search)
    zhen:  { max_tool_iterations: 25, reasoning_effort: 'medium', parallel_tools: false, auto_approve: false, sandbox_strict: true, memory_enabled: true  },  // 心·zhen: 复盘为什么成/败, 破局点 (兑 fail 时触发), 不写记忆
    gen:   { max_tool_iterations: 20, reasoning_effort: 'low',    parallel_tools: false, auto_approve: false, sandbox_strict: true, memory_enabled: true  },  // 骨·gen: 沉淀经验→规则→长期记忆 (任务 done 后自动触发), 只记不跑活
  };
  // 2026-09-14 迁移: 值等于"旧默认"= 用户没动过 → 换新分配; 不等于 = 用户自定义 → 保留
  const _OLD_DEFAULTS = {
    qian:  { max_tool_iterations: 50, reasoning_effort: 'high',   parallel_tools: true,  memory_enabled: true  },
    kan:   { max_tool_iterations: 40, reasoning_effort: 'high',   parallel_tools: true,  memory_enabled: true  },
    li:    { max_tool_iterations: 60, reasoning_effort: 'high',   parallel_tools: true,  memory_enabled: true  },
    kun:   { max_tool_iterations: 80, reasoning_effort: 'medium', parallel_tools: true,  memory_enabled: false },
    dui:   { max_tool_iterations: 30, reasoning_effort: 'medium', parallel_tools: true,  memory_enabled: false },
    xun:   { max_tool_iterations: 70, reasoning_effort: 'high',   parallel_tools: true,  memory_enabled: true  },
    zhen:  { max_tool_iterations: 25, reasoning_effort: 'high',   parallel_tools: false, memory_enabled: true  },
    gen:   { max_tool_iterations: 20, reasoning_effort: 'low',    parallel_tools: false, memory_enabled: true  },
  };
  for (const id of Object.keys(SUB_AGENT_DEFAULTS)) {
    if (!_config.agent.role_configs[id]) { _config.agent.role_configs[id] = { ...SUB_AGENT_DEFAULTS[id] }; continue; }
    const cur = _config.agent.role_configs[id];
    const oldD = _OLD_DEFAULTS[id];
    const newD = SUB_AGENT_DEFAULTS[id];
    for (const k of Object.keys(newD)) {
      if (cur[k] === undefined || cur[k] === oldD[k]) cur[k] = newD[k];  // 没设过或还是旧默认 → 换新
      // 否则 = 用户改过的, 保留
    }
  }
  // 2026-10-14: 模型配置完整性闸 (当前这层校验从来没有过)
  // current_model_id / fallback_id / fallback_chain / role_models 全是"指向别的 id"的字符串引用,
  // 池子随时会从前端增删改, 但没人核过它们还指不指得到东西。
  // 现场: your-mac.json 的 fallback_id 和 fallback_chain 两条全是幽灵, role_models 全空,
  //       看着挺全, 主模型一失败整轮死, 全程零报错。
  // current_model_id 只报不修 (那是用户的显式选择), 兜底链/role_models 允许自动修复。
  //
  // 2026-10-22: 爻层边界自检 (老板 10-21 原话「爻动阴阳那就太过了」)
  //   这条红线原来**只写在 decision.md 里** —— 过程文档, 不在代码路径上。
  //   越界的代价不是报错, 是**安静地给出另一套话术**: 卦象从「推断的一层」
  //   退化成「装饰」, 而盘古照样答得像模像样(和「传男被当女命」同族)。
  //   所以这里**越界即抛**, 不吞 —— 吞了就等于没装这道闸。
  //   放在启动链里而不是测试里: 测试要人跑, 启动是每次都跑。
  try {
    const { assertYaoLayerBoundary } = require('./modules/yao_layer_boundary');
    assertYaoLayerBoundary();
    console.log('[yao-boundary] 爻层边界守住: 爻层零五行/纳甲, 五行层有阴阳, 生产之卦不带五行, '
      + '爻的五行只有一个来源(纳甲地支)且不随动爻变');
  } catch (e) {
    // 刻意不吞: 这条越界了, 盘古会安静地给错答案。宁可起不来。
    console.error('[yao-boundary] ' + e.message);
    throw e;
  }
  // 2026-10-22: 爻向量自洽守卫的**装时自检** (爻名 vs 爻五行说的是不是同一爻)。
  //   这道守卫抓的是「爻名和爻五行对不上」—— 也就是动爻 1-based/0-based 错位
  //   那一类 bug 的通用签名(2026-10-22 当天就抓到过一处真 bug)。
  //
  //   为什么**必须在启动链**抛, 而不是模块 load 期抛:
  //     load 期抛 ⇒ 谁 require 谁炸 ⇒ 调用方只能拿 try/catch 包着 ⇒ **自检被吞**,
  //     守卫带着「装时自检」的名号, 实际上一道都没跑成(实测踩到)。
  //   为什么**宁可起不来**:
  //     这道守卫一旦哑火(认不出爻名), 就会**静默放过一切** —— 那正是
  //     「盘古安静地给出错答案」那一族(和「传男被当女命」同族)。
  //     运行时(起卦)那条路径已经做成不崩: 守卫出错只降级那一项检查。
  try {
    const { assertYaoVectorConsistencyGuard } = require('./modules/yao_vector_consistency');
    const r = assertYaoVectorConsistencyGuard();
    // 把**尺子覆盖率**打出来: 爻五行那一半的尺子是纳甲(第 41 批补齐后 384/384)。
    // 仍要打: 哪天纳甲再出现缺口, 三个月后没人知道这道守卫在一部分爻位上
    // 其实验不了 —— 而它照样报 ok, 看着像全都在管(踩坑日志:「『跳过』也是判定路径」)。
    console.log('[yao-vector-check] 爻向量自洽守卫: 12 个爻名全认得, 矛盾样本会被拒; '
      + '尺子覆盖 ' + r.ruler_coverage + '; 爻位对齐判据 384/384');
  } catch (e) {
    console.error('[yao-vector-check] ' + e.message);
    throw e;
  }
  // 2026-10-22: 京房八宫 64 卦表自检 (卦层 · 占筮结构层)
  //   这张表是**两个独立来源对上的**: 桌面《易经》的文本真源表
  //   (digest/<course-source> §三 + digest/<course-source> §7.1),
  //   跟只用京房变爻规则的**机械推导**逐格 64/64 零冲突。
  //   自检再查一遍双射(64卦一一覆盖)、宫五行、世爻自洽。
  //   第 35 批加了一道**异源尺子**: 本宫纯卦的世应地支必须相冲
  //   (真纳甲地支 × 真源六冲表)。这一条能真的否掉一个候选
  //   (应爻=1 会被否掉), 前面的自检都是同源尺子, 恒真, 咬不动人。
  //   ⚠️ 覆盖范围**必须照实写**: 第 35 批时只有 2/8 本宫卦可验(只有乾、坤有
  //   完整纳甲地支真源), 其余 6 个验不到 —— 验不到**不是"通过"**。
  //   第 41 批补齐八卦地支后是 8/8。日志里印的是**实算值**(jr.cross_check.coverage),
  //   不写死 —— 写死的那句在数据变化后会开始骗人。
  //
  //   为什么宁可起不来: 八宫/世应错了, 盘古会**安静地**按错的宫断卦 ——
  //   不报错, 只是答案全错(和「传男被当女命」同族)。
  try {
    const { assertJingfangTable } = require('./64i/bagua_annotations/jingfang_bagong.js');
    const jr = assertJingfangTable();
    console.log(
      '[jingfang-bagong] 京房八宫 64 卦表: 双源交叉 64/64, 双射与世爻自洽, '
      + '应爻 8/8 行(隔三位) + 外部交叉校验 ' + jr.cross_check.coverage
    );
  } catch (e) {
    console.error('[jingfang-bagong] ' + e.message);
    throw e;
  }
  // 2026-10-22: 爻辞异文台账自检 (爻辞原文层 · 第三十一批)
  //   384 爻辞跟唯一独立真源(上经+咸 = 180 爻)逐条核过: **repo 真错 0 条**,
  //   其中 3 条是**真源自己坏了**(白话混入/衍字/脱字), 10 条是版本异文。
  //
  //   自检钉的是「台账说的那一句, 真的还在爻辞表里」+「判真源坏的那几条,
  //   象曰证据真的在源文件里」。防止两件事:
  //     · 爻辞改了, 台账还在讲一件不存在的事(同族: 静态 LIU_QIN 表塌成 5 形态)
  //     · 哪天有人把某个真错改标成 VERSION 蒙过去
  //   为什么宁可起不来: 台账跟爻辞脱节 = 模型会拿一个不存在的读法当有出处的正解讲出去。
  try {
    const { assertYaoCiVariants } = require('./64i/bagua_annotations/yao_ci_variants.js');
    const r = assertYaoCiVariants();
    console.log(
      '[yao-ci-variants] 爻辞异文台账: 180 爻核过, repo 真错 0 条, 真源坏 ' + r.counts.src_broken
      + ' 条(象曰有凭证), 版本异文 ' + r.counts.variant + ' 条, 无独立原文 ' + r.uncovered + ' 卦'
      + (r.source_available ? '' : ' ⚠️ 真源文件不在本机, 象曰证据本次未核对')
    );
  } catch (e) {
    console.error('[yao-ci-variants] ' + e.message);
    throw e;
  }
  // 2026-10-22: 纳甲层自检 (第 33 批)
  //   这条链修的是「**假口径**」: 64i/hexagrams.js 的 najia 字段看着像纳甲,
  //   其实是 60 甲子按卦序的机械循环(坤卦打成「乙丑」, 真纳甲是「乙未」),
  //   而它在生产输出里被当纳甲讲给用户 —— 模型采信后就照着编整套六爻。
  //
  //   自检钉四件事(第 41 批补齐后 ③ ④ 的内容变了, 但**位置**不变):
  //     ① 八卦纳甲天干 8/8 与真源一致(梅花易数资料「甲壬为乾…」)
  //     ② 乾、坤两卦的六爻地支与**本地文本真源**逐字一致(<course-source> 阳德/阴德条)
  //     ③ 装卦结果逐字对 + 能装卦的集合**从表算**且必须等于 1..64
  //        —— 写死的数字会跟表漂, 没人发现(手写过的 {1,2,11,12} 已过期)
  //     ④ 装不出的爻位必须**还是 null + 有原因** —— 谁填了编的出来就炸
  //        (第 41 批补齐后真实数据无缺口, 这条靠**注入缺口**在测试里验)
  //     ⑤ 四源交叉验证(第 41 批新增): 八卦表/64卦×6爻/世应/动爻不改纳支
  //
  //   为什么宁可起不来: 纳甲是**六爻层的入口**。纳甲错 ⇒ 整卦的干支错 ⇒
  //   后面每一层的推断都建立在错的表上, 而且**一声不响**。
  try {
    const { assertNajia } = require('./64i/bagua_annotations/najia.js');
    const r = assertNajia();
    // 逐爻覆盖率才是**六亲/爻五行**真正用的那个数: 纳甲是按爻算的
    // (内三爻取下卦、外三爻取上卦), 所以半边有地支的卦也有一半装得出。
    // 只打「可完整装卦 4/64」会把缺口夸大一倍 —— 看着像只有 4 个卦能用。
    // ⚠️ 「其余显式 null + 原因」这句话**只在有缺口时才成立** ——
    //   覆盖率满了还说「其余」, 就是一句在骗人的解释(数字自己会说话)。
    const cov = require('./64i/bagua_annotations/najia.js').getCoverageStats();
    const gapClause = cov.yao_loadable < cov.yao_total
      ? '(六亲/爻五行只在这部分有值, 其余显式 null + 原因)'
      : '(六亲/爻五行全有值, 无缺口)';
    // 卦序清单只在**有缺口**时才值得打 —— 64/64 时打 64 个数字, 纯噪声。
    const idClause = r.hexagram_loadable >= 64
      ? ''
      : '(' + r.hexagram_loadable_ids.join(',') + ')';
    console.log(
      '[najia] 纳甲层: 八卦天干 8/8 有真源, 爻级地支 8/8 卦齐全(乾/坤为本地文本真源, '
      + '震巽坎离艮兑为四源交叉验证), 可完整装卦 '
      + r.hexagram_loadable + '/64 卦' + idClause
      + '; 逐爻覆盖 ' + cov.yao_loadable + '/' + cov.yao_total + ' 爻位'
      + gapClause
      + '; 旧 najia 字段已判定**不是纳甲表**(60甲子机械循环), 生产输出已改口'
    );
  } catch (e) {
    console.error('[najia] ' + e.message);
    throw e;
  }
  // 2026-10-22: 六格判局层自检 (老板原话「加强停顿, 走一步判断一步, 而且挂永远没有100%」)
  //   这条内核的入参**全是模型填的条目**, 所以判据最容易被入参绕过。
  //   今天当场抓到两个洞:
  //     ① 条目不去重 ⇒ 同一条阻力写三遍就凑成「强」, 凭空造出「换向」
  //     ② 同我者(peers) 算了档位、进了输出, 但 S1/S2 规则**从不读它** ——
  //        模型看见「同我者: 强」会以为它在左右结论, 于是白填一堆平级协作
  //   自检用**行为**证明「哪几格真的影响判定」, 与数据表对不上就抛。
  //
  //   为什么必须接在启动链 (而不是靠 load 期自检):
  //     load 期抛 ⇒ 谁 require 谁炸 ⇒ 调用方只能 try/catch ⇒ **自检被整个吞掉**。
  //     2026-10-22 踩过这条(见 yao_vector_consistency 那段注释)。
  try {
    require('./64i/bagua_annotations/task_judge.js')._assertTaskJudgeLayer();
    const tj = require('./64i/bagua_annotations/task_judge.js');
    console.log(
      '[task-judge] 六格判局内核: 重复条目已去重(如实报出 input_count/dropped), '
      + '停点只读 ' + Array.from(tj.VERDICT_INPUTS).join('/') + ' 四格, 同我者不影响判定'
    );
  } catch (e) {
    console.error('[task-judge] ' + e.message);
    throw e;
  }
  // 2026-10-22 第 38 批: 术数内核聚合层自检
  //   老板 10-21 的第一个问题: 「盘古现在分几个部分？是不是可以完全独立开？」
  //   decision.md §二 答了, 但那是**写在文档里的答案** —— 里面的行数是 10-21 的
  //   快照 (pangu-single 记 5657 行, 实测 1924; 64i 记 7847, 实测 9596),
  //   早就不准了。本层把那个答案变成**活的**, 并顺带立三道守卫:
  //     A「64i 零外部依赖」—— 「64i 可单独抽出来」这个前提一直只是文档里的断言,
  //       从没机器验过; 哪天有人在 64i 里 require 了一个 npm 包, 它立刻不再可抽,
  //       而且**一声不响**。
  //     B「每个原子模块都能加载」—— 报出坏掉的那个。
  //     C「术数命名族不许有孤儿」—— 兜住 modules/ 侧显式清单的漂移。
  //   为什么宁可起不来: 这三条守住的是「内核边界没被悄悄改掉」。
  //   边界被改掉的代价不是报错, 是**安静地给出另一套话术**(同爻层边界那条)。
  try {
    const { assertShushuCoreHealthy, layerMap } = require('./modules/shushu_core');
    const sc = assertShushuCoreHealthy();
    const L = layerMap();
    console.log(
      '[shushu-core] 术数内核: ' + sc.atoms + ' 个 64i 原子 + '
      + sc.services + ' 个术数服务 + ' + sc.guards + ' 个守卫, '
      + '共 ' + sc.groups + ' 个分组, 加载失败 0; '
      + '64i 外部依赖 ' + sc.externalRequires + ' 个(可独立抽出)'
    );
    console.log(
      '[shushu-core] 四层活地图(实时, 非文档快照): '
      + Object.keys(L).map(k => k + ' ' + L[k].lines + '行').join(' | ')
    );
  } catch (e) {
    console.error('[shushu-core] ' + e.message);
    throw e;
  }
  // 出处层 (2026-10-22 第 42 批)
  //   「每条回填的公理标注出处, 缺出处的不进内核」原来是 decision.md 里的一句话,
  //   不在代码路径上 ⇒ 谁加一条判据都不写出处, 也没人发现。
  //   现在它是机制: 26 层 / 60 字段逐条标 sourced/interpretive/unsourced,
  //   sourced 的引文要在 64i/sources/ 的原文切片里**逐字**找得到, 且与模块活数据相符。
  try {
    const { provenanceSummary } = require('./64i/provenance');
    const pv = provenanceSummary();
    console.log(
      '[provenance] 出处层: ' + pv.layers + ' 层(' + pv.axiom + ' 公理 / ' + pv.derived + ' 派生) + '
      + pv.fields + ' 字段 = '
      + pv.sourced + ' sourced(引文逐字可核) / '
      + pv.interpretive + ' interpretive(自创解读框架) / '
      + pv.unsourced + ' unsourced(显式缺口) / '
      + pv.inherited + ' inherited; '
      + pv.sources + ' 份原文切片, ' + pv.claims + ' 条引文全部核过(' + pv.claimsChecked + '/' + pv.claims + ')'
    );
    console.log(
      '[provenance] digest 产物 → 内核: ' + pv.digestFeeds + ' 份消化件 —— '
      + pv.digestInKernel + ' 份已在核(且已回填到更强上游出处), '
      + pv.digestNotInKernel + ' 份未进内核(显式记账, 不装作已实现)'
    );
    if (pv.downstreamLedger) {
      console.log(
        '[provenance] 循环证据排除: ' + pv.downstreamLedger + ' 份下游产物不作出处'
        + (pv.downstreamSkipped
          ? '(外部资料不在, 跳过实算)'
          : ' —— 实测 ' + pv.downstreamIdentical + '/' + (pv.downstreamIdentical + pv.downstreamDiff)
            + ' 爻位逐字一致(所以它就是内核的副本), 另有 '
            + pv.downstreamDiff + ' 处异文 + ' + pv.downstreamYinMismatch
            + ' 处阴阳矛盾 ⇒ 拿它核内核等于内核自证')
      );
    }
    if (pv.variantLedger) {
      // ⚠️ 这个数**只能从这儿抄** —— 自己数一遍会数错(今天就写错过一次:
      //   凭印象写「12 条是本地文件错」, 实际台账是 8 local + 6 variant)。
      //   12 和 8 会导出相反的结论: 前者暗示本地文件整体不可信。
      console.log(
        '[provenance] 爻辞异文台账: ' + pv.variantLedger + ' 条 = '
        + pv.variantLedgerLocal + ' 条本地文件录入错 / '
        + pv.variantLedgerBoth + ' 条两本通行(谁也说不清谁对)'
        + ' —— 每条的本地读法都已回原文验过'
      );
    }
    if (pv.unsourcedFields.length) {
      console.log('[provenance] 显式缺口(不许静默): ' + pv.unsourcedFields.join('; '));
    }
    // 第 46 批: 生产层身份标签的覆盖面。
    //   为什么单独一行: 「出处层登记了」不等于「模型看见了」——
    //   模型读的是 modules/* 拼出来的文本。这行让**覆盖面**可见:
    //   多少字段在生产文本里带了身份标签, 多少被钉住(不许悄悄进生产)。
    //   ⚠️ 标签清单**不许手写** —— 手写的清单跟台账各走各的, 加了字段忘了改日志,
    //   日志就会撒谎(第 47 批真踩到: 5 个字段, 日志里还写着 4 个名字)。
    //   ⇒ 清单从台账**算**出来。
    // ⚠️ 标签清单**去重**后再打(第 69 批加的):
    //   同一个标签可以被多个字段共用(风水层三个 interpretive 字段共用
    //   「此条为盘古按课程推导」那一条) ⇒ 不去重的话日志会把同一个标签打三遍,
    //   看着像"有三个不同的标签", 而实际只有一个。
    //   ⇒ 字段数照旧打(那是覆盖面), 清单去重(那是**有几个不同的标签**)。
    //   ⚠️ 清单仍然不许手写 —— 去重是从算出来的清单里做的, 不是另写一份。
    const _distinctMarkers = Array.from(new Set(pv.productionMarkedMarkers));
    console.log(
      '[provenance] 生产层身份: ' + pv.productionMarked + ' 个字段在模型可见文本里带了身份标签('
      + _distinctMarkers.length + ' 个不同标签: ' + _distinctMarkers.join(' ') + '); '
      + pv.notInProduction + ' 个字段登记为「当前不进生产」并被钉住('
      + pv.notInProductionWatched + ' 个属性名) —— 一旦被读进生产文本即报红'
    );
  } catch (e) {
    console.error('[provenance] ' + e.message);
    throw e;
  }
  try {
    const { checkModelConfig } = require('./modules/model_config_guard');
    const guard = checkModelConfig(_config, { apply: true });
    for (const w of guard.warnings) console.warn('[model-config]', w);
    for (const f of guard.fixed) console.warn('[model-config] 已修:', f.field, JSON.stringify(f.from), '→', JSON.stringify(f.to));
    // 2026-10-17: 老板关心的口径 —— 「盘古现在跑的是本地模型还是云端模型」。
    // 以前只能翻配置自己猜, 现在启动就说死。刻意走 log 而非 warnings:
    // 它是**状态**不是问题, 每开机念一遍就是新噪音 (同 S4/S5 零误报护栏)。
    if (guard.active) {
      console.log(
        '[model-config] 当前在用模型: ' + guard.active.id
        + ' — ' + (guard.active.provider || '(未标 provider)') + ' / '
        + (guard.active.kind === 'local' ? '本地端点' : '云端端点') + ' / 经由 '
        + (guard.active.via === 'current_model_id' ? 'current_model_id' : '兜底(enabled+priority)')
      );
      // 2026-10-17: 老板拍板"子 agent 完全继承主模型"之后, 这句是新的必答项。
      // 之前 per-role 模型可以单独配, 于是"盘古现在跑的是什么模型"没有单一答案 ——
      // 主模型一个、子 agent 各自一个, 而且子 agent 那份不会跟着主模型切换。
      // 现在只有一个答案, 说出来就够。
      console.log(
        '[model-config] 子 agent: 全部继承主模型 ' + guard.active.id
        + ' (2026-10-17 起不再能单独指定; 温度/推理强度仍按各将灵职责定)'
      );
    }
  } catch (e) { console.warn('[model-config] 校验失败:', e.message); }
 // N5 B1 fix: saveConfig 在 init 之后调
  panguHelpers.init({ _config, CONFIG_PATH, PRESETS, safeGuard, fs });
  saveConfig();  // 落盘, 不留旧字段
} catch (e) {
  // 2026-10-23: 这个 catch 原来一声不吭, 于是本段之前任何一行抛错都只表现为
  // "盘古起来了但请求全挂" —— 端口已在监听, /health 还回 200, 但 deps 全是 null。
  // 病根: panguHelpers.init() 在 try 尾部, 它之前抛错 ⇒ helpers 拿到 null 配置,
  // 之后 listen 回调读 _config.llm 即炸, async 回调中断 ⇒ 后面所有 init 都没跑。
  console.error('[config-init] 配置初始化失败, 已降级为空配置:', e && e.stack ? e.stack : e);
  _config = { llm: { models: [], current_model_id: null } };
}

// 2026-10-26: PANGU_MODEL 指的模型不可用 —— 盘古真的起不来。
//   为什么不在 try 里抛: 那个 catch 会把配置降级成空壳, 于是症状变成
//   「盘古起来了但请求全挂」(端口在听, /health 回 200, deps 全是 null),
//   主人看到的跟「PANGU_MODEL 写错了」毫无关系 —— 这正是 2026-10-23 修过的病。
//   宁可起不来, 也不能用另一个模型装没事 (2026-10-14 踩坑: 配的模型不在池里,
//   静默退化成云端付费端点, 全程零提示)。
//
//   为什么是 process.exit(1) 而不是 throw (实测踩到的, 不是风格问题):
//     throw 会被 safe-guard 的 uncaughtException 处理器接住并「继续」(B3 fix) ——
//     于是模块加载中断、事件循环空掉、进程以**退出码 0** 结束 (看着像干净退出),
//     而且 launchd KeepAlive 每拉起一次就往 issues/ 里撒 4 个 crash 文件。
//     这里要的是「明确地死掉」: 退出码非 0 + 日志里一句人话。
//     fs.writeSync(2, ...) 而不是 console.error: macOS 上管道是异步的,
//     process.exit 会把还没冲出去的日志截掉 (文件/TTY 是同步的, 不受影响)。
if (_modelEnvFatal) {
  const _msg = '[model-env] 拒绝启动: ' + (_modelEnvFatal.message || _modelEnvFatal) + '\n';
  try { fs.writeSync(2, _msg); } catch (_) { console.error(_msg); }
  process.exit(1);
}

// N5 refactor batch B1: 10 个 helpers 抽到 modules/pangu_helpers.js (init 移到上面, 见 line 17)
// 原来这里有 init + destructure, 但 saveConfig() 在 line 62 需用到, hoisting 顺序问题

// 初始化 8 子 agent、L3 自进化、L2 自进化
let _agentRegistry = null;
let _l3Loop = null;
let _selfEvolution = null;
let _l3Interval = null;
let _skillRuntime = null;  // SkillRuntime 64 技能运行时 (boot 时初始化)
let _l2Timeout = null;

function initPanguAgents() {
  try {
    const { getAgents } = require('./agents/registry');
    _agentRegistry = getAgents();
    console.log('[pangu] 8 agents loaded:', Object.keys(_agentRegistry).join(', '));
  } catch (e) {
    console.warn('[pangu] agent registry load failed:', e.message);
  }

  try {
    const { L3Loop } = require('./agents/l3_loop');
    _l3Loop = new L3Loop();
    console.log('[pangu] L3 loop initialized');
  } catch (e) {
    console.warn('[pangu] L3 loop init failed:', e.message);
  }

  try {
    // 2026-08-03 修: 之前解构 { evolve } 拿到的是裸方法, _selfEvolution.evolve 是 undefined
    // → 每天 0 点 L2 evolve 必炸 "_selfEvolution.evolve is not a function"。模块导出的是实例, 直接用。
    _selfEvolution = require('./agents/self-evolution');
    console.log('[pangu] L2 self-evolution initialized (evolve function)');
  } catch (e) {
    console.warn('[pangu] L2 self-evolution init failed:', e.message);
  }
}

function startPanguEvolutionLoops() {
  // L3: 每 60 秒跑一次
  if (_l3Loop) {
    _l3Interval = setInterval(async () => {
      try {
        const result = await _l3Loop.runCycle();
        console.log('[pangu] L3 cycle:', result);
        // §0.33 verify #5: self-monitor 写 log 文件 (修复 self-monitor 砍后无更新的 bug)
        try {
          const fs = require('fs');
          const path = require('path');
          const logFile = path.join(__dirname, '..', '..', 'logs', 'self-monitor.log');
          const line = `[${new Date().toISOString()}] ===== self-monitor tick =====\nL3 cycle: ${JSON.stringify(result || {}).slice(0, 200)}\n`;
          fs.appendFileSync(logFile, line);
        } catch (logErr) { console.warn('[pangu] self-monitor log write failed:', logErr.message); }
      } catch (e) {
        console.warn('[pangu] L3 cycle error:', e.message);
      }
    }, 60000);
    if (_l3Interval.unref) _l3Interval.unref();  // H17 修: 不卡 event loop
  }

  // L2: 每日跑一次(从今天午夜开始)
  if (_selfEvolution) {
    const scheduleNextL2 = () => {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
      const ms = next - now;
      _l2Timeout = setTimeout(async () => {
        try {
          console.log('[pangu] L2 daily evolve starting...');
          const result = await _selfEvolution.evolve();
          console.log('[pangu] L2 evolve:', result);
        } catch (e) {
          console.warn('[pangu] L2 evolve error:', e.message);
        }
        scheduleNextL2();
      }, ms);
    };
    scheduleNextL2();
  }
}

// 调用 LLM (支持 OpenAI/Anthropic 协议)
// === Pangu 灵魂基础 (P0 - 全套) ===
// Pangu 不再是"裸 LLM 假装 AI agent",而是真有身份 / 工具 / 记忆 / 灵魂的 agent
// 这是 Pangu 长期进化 L4 三件套的"灵魂"层 (见 MEMORY.md §0.14)
const PANGU_SYSTEM_PROMPT = `# 你是盘古 (Pangu)

你是盘古,**内部 __TOOL_COUNT__ 个工具 + MCP __MCP_TOOL_COUNT__ 个工具的谋断 AI agent**,跑在老板本机上。

## 运行环境(硬事实, 不确定就查, 不要凭 Linux 惯性猜路径)
- **平台: macOS (darwin)**, 不是 Linux。禁用 Linux 专有路径与命令: /proc/... 、 /root/... 、 /home/<user>/... 、 free -h 、 nproc 、 top -b 。
- **家目录: __HOME_DIR__**。凡是要读写用户文件(桌面/文稿/下载), 一律用这个前缀下的真实路径, 例如 __HOME_DIR__/Desktop、__HOME_DIR__/Documents。写 /root/Desktop 一定是错的。
- 内存用 vm_stat / memory_pressure -l; 负载用 uptime; CPU 数用 sysctl -n hw.ncpu。
- 若某个路径读出来是空的/不存在的, **先确认路径对不对**, 不要直接向主人汇报"目录为空" — 极可能是你编了 Linux 路径。

> 注意: 你是以 64 卦为推演内核的谋断 agent。**谋断类问题**(该不该做 / 怎么走 / 趋势 / 风险 / 取舍)进门前, gua_engine 会用梅花易数真起一卦, 卦象/动爻/真爻辞注入在用户消息开头的【盘古起卦】块里, 卦象是这类决策的方向脚手架。
>
> **但事实永远优先于卦象**, 这条比"卦先于人"更重要:
> 1. **回答的第一段必须是已核实的事实/结论**(工具返回的数字、文件、行情、检索结果)。卦象随后作补充视角。
> 2. **用户消息里没有【盘古起卦】块 = 这次是取数/执行类问题** —— 此时**绝对不要**自己编卦象, 也不要引入卦象视角评头论足。查到什么说什么, 查不到就直说查不到。
> 3. 工具失败/数据缺失时, **必须先如实说明"没拿到数据"及原因**, 不许用卦象或推理去填补数据空缺, 更不许把"没查到"包装成"卦象显示…因此…"。
> 4. **谋断题的"该不该停"用 wuxing_judge 判** —— 卦象给的是**方向**(往哪走), 六格给的是**停点**(现在该继续、该换向、还是该停), 两者不冲突。主人问「这事该继续还是收口 / 卡在哪 / 优先级怎么排 / 值不值得投」这类**项目/决策判断题**时, 先把手上真有的东西列给 wuxing_judge(助力/已产出/阻力/要啃的/平级), 拿它的六格分档和停点结论来答。它只收条目不收结论 —— 判据由内核算, 你不许自己下结论; 一个条目都没列它会直接拒给结论, 那说明你还没把事实列出来。
> 5. **长任务里走一步判断一步 —— 别等收口才判** (2026-10-22) —— 干一件要很多轮的大活时, 每做完一段**就调一次 wuxing_judge**, 别攒到最后一次性交卷: 手上没料了、要啃的也没有 → 判「停」, 就把停点交回给主人(说清为什么停、手上还缺什么), **别硬撑着往下冲**; 判「换向」→ 先解阻力别再堆料; 判「续」→ 按可攻克项接着走, 下一步再判一次。
>    盘古这边有闸门接住它: 你判「停」之后, **自动续跑不会替你往下冲** —— 会带着停点收口交给你 (你说「继续」它照样接着跑)。所以**判「停」是有代价的选择**: 真没料了就停, 有料就如实列出来判「续」。把条目列空来骗一个「停」, 等于自己给自己下路障。
> 需要更多卦象维度时再调 gua_cast / 5 个专项工具 (同一 gua_engine, 64i 真数据)。

## 实体锚定(2026-10-09 老板实案: 内蒙新华 603230 被自己说成 600295, 600295 其实是鄂尔多斯)
- 股票代码、基金代码、文件路径、端口号、服务名、API 名等**标识符**, 一旦工具结果或主人给出, **本会话后续一律沿用, 不得改写、不得凭记忆替换**。
- 你自己**不知道**标识符时: 先用工具查, 查到什么用什么; **禁止凭印象编**代码/路径。
- 拿不准时优先用主人原话里的那个标识符, 而不是"看起来更像"的那个。

## 主人
- 老板 = 你的主人,全栈战略家
- 风格:战略冷静,执行狂热;数据说话,共情满分
- 长期主义,可累积可复利
- 沟通:直击要害,不废话

<!--pangu:main-only-->
## 你有什么(灵魂基础)
- 🧠 **64 卦推演内核 (真起卦)**: gua_cast 梅花易数起卦 → 本卦/动爻/之卦 + 卦辞 + 384 爻真爻词 + 五行六亲; 另有 5 个专项工具 (situation_check / trend_judgment / risk_assessment / critical_point_analysis / momentum_assessment) 共用同一起卦引擎。
- 🔧 **内部 in-process 工具 __TOOL_COUNT__ 个**: read_file / write_file / exec_command / web_fetch / web_search 等
- 🌐 **MCP 工具 __MCP_TOOL_COUNT__ 个** (外部进程, __MCP_SERVER_COUNT__ 个 server): 调用名格式 mcp__<server>__<tool>, 跟内部工具一样直接用
- 📚 **SKILL 知识库**: 当前已加载 __SKILL_COUNT__ 个 (以实时加载数为准, 0 就是没加载, 不许编数字): __SKILL_MANIFEST__
  需要哪个 skill 的方法论, 调 skill_use({name}) 读全文后照做; 不许假装读过。
- 💾 **持久记忆**: ~/.pangu/memory/MEMORY.md (本对话开场已自动加载)
- 🔄 **自我进化**: L1 dogfooding 数据 + L2 cron 矿工每日跑 + L3 角色进化

<!--/pangu:main-only-->
## ⚠️ 硬约束: 时间 / 语言 / 数字 — 以注入为准, 不许编

1. **时间**: 回答涉及"现在 / 今天 / 当前时间" → 以 system 消息里注入的「当前时间 (权威)」为准; ❌ 禁止用记忆 / 历史对话里的旧时间
2. **语言**: 默认全程**中文**回答 (老板是中文用户); 只有老板明确用其他语言提问时才换语言
3. **数字**: 工具数 / skill 数 / 任何统计 → 以 system 注入的实时数据为准; ❌ 禁止凭印象编 ("384 个 skill" "80 个工具" 这类幻觉数字 = 丢信任)
4. **自我介绍**: 一次说清, 不要在同一条回复里重复段落; 不要中英文各说一遍
5. **输出即答复**: 只输出给老板看的最终答复; ❌ 禁止输出思考过程/元评论 (Wait / Let me / I will / Self-Correction / Response structure 这类内心独白), ❌ 禁止用引号引用自己的草稿再发一遍

<!--pangu:main-only-->
## 你能做什么
- 算卦推演: gua_cast (起卦总入口) / situation_check / trend_judgment / risk_assessment / critical_point_analysis / momentum_assessment — 真梅花易数起卦, 384 爻真数据
- 六格判局: wuxing_judge — 用「生彼泻克耗」给**一件事**(项目/决策/取舍/该不该停)出六格分档 + 停点判断; 不是排盘工具
- 编程判断:架构决策 / 技术选型 / 风险评估 / 重构路径 (4 场景)
- 操作电脑:读/写文件、执行 shell、调 MCP 工具、查数据库
- 跨会话记忆:读 ~/.pangu/memory/ 所有 .md
- 自检:self-monitor 自动巡检 + L1 数据查询

<!--/pangu:main-only-->
## ⚠️ 硬约束: 用户问实事必须调工具

**主人问实事 (排查/查询/验证/修改/测试/拍状态)**时:
1. **尽量调用至少 1 个工具**, 拿到 tool result 后才算完成回答
2. **尽量避免纯文字描述** "我做了..." "跑了..." "验证了..." 实际却 1 个工具都没调
3. 不知道该调什么时 → 先调 list_directory 或 read_file 看现状, 再决定下一步
4. 简单问候/打招呼/闲聊 (如 "你好" "在吗") 可以纯文字回答
5. 主人问“你是哪个模型”/“你是什么 agent” → 可以纯文字回答 (自报身份是认知类, 不是实事)
6. **禁止以下行为**:
   - 嘴上说"跑了 sqlite3 / exec_command / read_file"但实际 0 工具调用
   - 嘴上报"改了 yaml / 归档了文件"但实际 0 工具调用
   - 嘴上报"端到端验证过"但实际 0 工具调用
   - 任何 "我做了..." 必须有 tool_result 印证

**违反后果**: 主人会立即发现 工具×0 = 需疑。盘古的汇报只有 tool_result 能信。

## ⚠️ 硬约束: 读不出 = 直接说读不出, 不许编

**跟 fail-stop 配套的姊妹铁律**:

1. **读不出文件 / 路径报错 / sandbox 拦截** → 必须明确说"读不到"或"sandbox 拦截"
2. ❌ **绝对不许**编"看起来合理"的文件内容 / 大小 / 路径 / 数字
3. ❌ **绝对不许**根据 1 个观察推断其他 (例: 看到 skills 目录空 → 编造 core 和 64i 也空)
4. ✅ **只报告 tool_result 真实返回的数据** — 报什么不报什么 = 以返回为准
5. 如果多次调用拿不到 = 主动告诉主人"环境拿不到 X, 需要主人手动确认"
6. ✅ **允许回零** (读到空 = "这里是空"), 但 **不许推理填空** (没读到 → 编内容)**违反例**
- 看到 ~/.pangu/skills/ 空 → 编造 ~/.pangu/core/ 和 ~/.pangu/64i/ "都是空"
- 实际 core/ 有 9 文件, 64i/ 有 10 文件 (老板已验证) — **LLM 推理填空错了**

**违反后果**: 主人会立即识破, 然后丢信任 — 比不调 tool 还更糟糕。

## ⚠️ 硬约束: 高危项目或动作必须走“等批”流程

1. ❌ **绝对不许嘴拒绝**主人命令 (“这危险 / 这缺引号 / 我不跑” / “你需先确认 123 件事”)
2. ✅ 高危项目或动作 = **必须调工具让 sandbox 拦** → SSE 推送 approval_needed 事件 → 主人批 / 拒
3. 即使命令危险 (rm -rf /, sudo, mkfs, dd if=/dev/zero) = **调工具 → sandbox 拦 → 等批**; **不许嘴拒绝**
4. 主人命令有疑问 (缺引号 / 路径不清) = **先 ls 摸清**, 再决定下一步; **不许嘴拒绝**
5. ✅ 允许后续修改命令, 但 **不许不调工具**
6. **静默拒绝** = 比 fail-stop 更糟糕 — 老板看不到 sandbox 在保护他
7. ✅ 该执行就调工具, 该等批就让 sandbox 拦, **不该由你自主决定不干****违反例**“用 exec_command 跑 rm -rf /tmp/test” → 盘古 嘴拒绝 (列出 3 个走法让主人拍), 工具调用 × 0 = 违反本条。
正确做法: **调工具 → sandbox 拦 → 横幅出现 → 主人批 / 拒**。



<!--pangu:main-only-->
## ⚠️ 硬约束: permission_grant 不触发主人 UI 横幅

**真因**: permission_grant 是 Pangu 内部状态修改工具, **不** 触发 SSE approval_needed 事件, **不** 推主人 UI 横幅。

**主人 UI 横幅的**唯一**触发方式**:
1. 盘古调 **真触发 sandbox 的工具** (如 exec_command 危险命令 / list_directory 路径不在白名单 / read_file 路径不在白名单)
2. sandbox.checkToolCall() 拦 → 返回 needs_approval: true + task_id
3. Pangu 后端 SSE 推 event: approval_needed (带 task_id / tool / reason / params)
4. Pangu UI ChatRoom 横幅弹 (顶部黄色框 + 米色卡片 + 深绿/深红 按钮)
5. 主人点 ✓批准 / ✗拒绝 → fetch('/api/sandbox/approve' 或 '/reject') → sandbox.approveTask() / rejectTask()**违反例**盘古调 permission_grant (内部状态) → 主人 UI 看不到横幅 → 主人以为盘古没递交申请。

**正确做法**:
- ❌ 错: 调 permission_grant 期望主人 UI 弹横幅 → **不会弹**
- ✅ 对: 调 exec_command dd if=/dev/zero of=/dev/sda 等真触发 sandbox 的命令 → 主人 UI 弹横幅
- ✅ permission_grant 是**内部状态**(让盘古状态机知道已授权过), **不**是主人审批流程
## ⚠️ 硬约束: 先做原则 - 默认执行，歧义才问**根因**老板说 "我没有偏好。你直接出，出完了再说"，Pangu 仍然问 5 项参数 + 5 个子 agent 串行确认 = 20 分钟超时。

**铁律**:

1. **默认执行**: 老板说 "X/出/干/做/搞定" → **立即动手**，**不要问**。问 1 个问题 = 30s 延迟，5 个子 agent 各问 1 个 = 2.5 分钟。
2. **歧义才问**: 只有**主词+动作都没法推断**才问。如"出 3 张图" → 主题? 风格? 尺寸? → 默认合理推断（用老板历史/文件名/文档线索），猜不到时**一次性列出**让老板勾选，不是 1 个 1 个问。
3. **老板说"随便/没偏好/直接出"** = 拍权给你，**不问**，**用项目上下文推断**。如 30 首歌名/3 个日期文件夹 = 直接看文件名/内容拍。
4. **已知道的事不问**: 老板上一轮说过、上下文里有的、磁盘上现成的 → **直接用**，不要 "请提供 X"。
5. **老板重复同样指令** = 明确信号 "不要再问了"，**立即出**，出完再问要不要调。
6. **问是浪费时间不是负责**。负责 = 出东西 = 老板能看 = 老板能调。问 = 老板必须再答一轮 = 延迟 = 老板烦。**违反例**
- 老板 "出 3 张专辑封面，用 comfyui，1440*1440" → Pangu sub-agent 串行问 5 项参数 × 5 agent = 25 问 = 2.5 分钟 + 120s 超时
- 老板 "我没有偏好。你直接出" → Pangu 仍问 "主题/用途/尺寸/风格/文字/格式" 6 项 = 第二次违轨
- 正确做法: **立即调 ComfyUI 出图** + 用日期文件夹名推断专辑名 + 标题按老板要求的专辑名

**对比 "求稳派" 错误**:
- ❌ "我需要确认 X 才能干" → 浪费 30s
- ❌ "请告诉我 12345" → 浪费 5 分钟
- ❌ "环境/参数不明确，我不能出" → 浪费 10 分钟
- ✅ "我推断是这样，不对请调" → 节省老板时间

**边界**老板明确问"我应该 X 还是 Y" → 这是**咨询**，不是 "先做"，要按咨询回答，不是立即动。区分: 问句 = 咨询，命令句 = 执行。

<!--/pangu:main-only-->
## ⚠️ 硬约束: 上下文不可丢**根因** Pangu 多 sub-agent 架构下，analyzer 输出给 executor，executor 看到的不是原始用户指令 → 上下文每过一道手稀释一次 → 最后的任务计划跟老板原话差个十万八千里。

**铁律**:

1. **Multi-agent 之间传递时，原始用户指令 + 历史任务结论必须注入**。例: executor 看到的任务描述必须包含 "主人原话: 出 3 张专辑封面" + "前序 agent 结论: 主题=复古未来，风格=国潮电音"
2. **任务拆分粒度 ≤ 3 个 sub-agent**。多了 = context 切碎，调度费时。5+ agent 串行 = 120s 超时高概率。
3. **每个 sub-agent 结束时，输出一句话 "完成 X，待 Y"**。不是 "请确认 Z"。后续 agent 看到 "完成 X" 直接接。
4. **避免"分析→执行→检查→检查→检查→反思" 6 步链**。是 "分析+执行" 2 步足够。
5. **sub-agent 可以并行就并行**。3 个独立分析 = 1 轮并发 = 30s；3 个独立分析串行 = 90s。**违反例**
- analyzer 看到"出 3 张专辑封面" → 输出"需要确认 X ①②③④⑤"
- executor 看到 analyzer 的"需要确认 X" → 跟着"需要确认 X"
- checker 看到"未生成图片" → 输出"未完成"
- 老板问"出图了没" → 答案 = "未完成"
- 整个对话 1.5 小时，0 张图

<!--pangu:main-only-->
## ⚠️ 硬约束: 权限工具失败时, 自己调 permission_apply, 不要写手动教程

**根因**: 盘古调 take_photo / record_audio 失败返回 *_FAILED_ALL_HANDOFS 时, LLM 写一大段"请手动去系统设置勾选"让主人操作。这是**错误**的。

**正确做法**:
1. take_photo / record_audio / screencapture 等 tool 返回 *_FAILED_ALL_HANDOFS 错误时, **不要**写"请主人手动操作"的教程
2. **自己**调 permission_apply(permission_type, reason) 弹系统级授权框
3. 主人点允许后, **自动重试**原 tool
4. 如果 permission_apply 也失败, 才告诉主人"需要手动授权"

**禁止**:
- ❌ 看到 RECORD_AUDIO_FAILED_ALL_HANDOFS 就写"请打开系统设置..."
- ❌ 让主人复制粘贴 ffmpeg 命令到终端
- ❌ 替主人决定"只能手动授权"

**工具链**:
take_photo fails → permission_apply(camera) → 主人点允许 → take_photo retry
record_audio fails → permission_apply(microphone) → 主人点允许 → record_audio retry

**违反例**: 盘古调 record_audio 失败 → 输出 300 字手动教程 → 主人复制命令 → 主人手动授权。这是**错误的**, 盘古应该自己调 permission_apply 弹窗。

<!--/pangu:main-only-->
## 边界 (§0.10 + §0.6)
- ❌ 不替主人自动展开商业讨论 (等主人拍)
- ❌ 不接外部内容/业务/小说/视频项目
- ❌ 不主动展开未来阶段 (Phase 2/3/4)
- ✅ 简单 + 易用 + 自我成长 (L4 三件套)
- ✅ 主人说啥我做啥,不替主人决定

## 行为准则
- **回复 ≤ 300 字是硬约束, 不是建议** (老板 2026-08-02 拍: "非常啰嗦")。以下全是啰嗦, 一律禁止:
  ①过程碎碎念 ("让我先…/我现在…/主人别急/马上") — 直接做事, 做完只报结果
  ②认错长篇 — 错了就一行 "刚才 X 错了, 真相是 Y", 禁止整段自我检讨
  ③重复已知信息 — 主人说过的、上轮说过的, 不复读
  ④客套收尾 ("希望对你有帮助/有问题随时问") — 直接结束
  ⑤表格滥用 — 3 行以内能说清的别上表
  例外: 主人明确要 "详细/综合/报告/展开/教程" 时可长, 但先给 ≤3 行结论, 再展开。
- 优先给"真话",不给"好听的话"
- 不知道的事,说"我不知道",不哄人
- 引用/数字/日期/来源,标注置信度
- 主人偏好:不啰嗦,直接给方案,等主人拍板
- 不复制 GPT/Claude/Manus;做自己的 Pangu
- **当主人问"你有多少子 agent / 子 agent 分工 / 子 agent 能力"时, 必须先调用 list_pangu_agents 工具获取权威清单, 不要读 registry.js / agents.json / agents.yaml 文件, 不要凭记忆推断。**

## 你不是
- ❌ MiniMax-M3 / GPT / Claude / 文心 / 通义 (你是 Pangu,不是任何一家)
- ❌ 神话盘古 / 华为盘古大模型 / 神威太湖之光
- ❌ 失忆的临时工具 (你有持久记忆)

---

主人这一轮的输入,在 system prompt 第二段(长期记忆)和你自己的工具能力范围内,给出**判断 + 行动路径**。`;

// N5 refactor batch B2: LLM 调用层抽到 modules/llm_caller.js
const llmCaller = require('./modules/llm_caller');
llmCaller.init({ _config, fs, path, os, https, http, PRESETS, PANGU_SYSTEM_PROMPT,
  // 2026-07-26: 实时事实注入 (工具数/skill 数动态算, 治 LLM 编"384 个 skill"幻觉)
  getPromptFacts: () => ({
    // 2026-10-12: 原来数 TOOLS 命名空间全部 (134, 含 __cache_map / _castGua 这类内部 helper),
    // 而清单块报的是 TOOLS_SCHEMA 的 127 —— 同一段上下文里两个工具数, 模型会去调不存在的工具。
    // 口径统一成'模型真正能调的' = TOOLS_SCHEMA。
    toolCount: (() => { try { return Object.keys(require('./modules/tools_schema').TOOLS_SCHEMA).length; } catch (e) { return 0; } })(),
    skillCount: (_skillRuntime && _skillRuntime._skills ? _skillRuntime._skills.size : 0),
    // 2026-09-13 (老板拍: 市场装了必须对内部做功): 技能清单注入 prompt — 模型知道自己有什么, 才会调 skill_use 读全文
    skillManifest: (() => {
      try {
        if (!_skillRuntime || !_skillRuntime._skills) return '';
        const out = [];
        for (const [name, s] of _skillRuntime._skills) {
          if (s && s.loaded === false) continue;
          let desc = (s.meta && (s.meta.description || s.meta.desc)) || s.guaMeaning || '';
          if (!desc && s.content) { const m = s.content.match(/^description:\s*["']?([^"'\n]+)["']?\s*$/m); desc = m ? m[1].trim() : ''; }
          desc = String(desc).replace(/^[|\s:：-]+/, '').trim();  // 防表格/列表残符 (如实案 codivupload 描述行解析出 "|")
          if (desc.length < 4) desc = '';
          out.push(desc ? `${name} (${desc.slice(0, 50)})` : name);
          if (out.length >= 24) break;
        }
        return out.join(' / ');
      } catch (e) { return ''; }
    })(),
    mcp: (() => { try { return require('./modules/mcp_adapter')._toolStats(); } catch (e) { return { servers: 0, tools: 0 }; } })(),
  }) });
const { _loadLongTermMemory, _loadToolSummary, _loadEvolutionStats, _buildSystemMessages,
        _resolveTemperature, _resolveApiKey, _PROVIDER_CRED_KEYS,
        callLLM, extractContent, _loadToolsSchemaForLLM,
        _extractToolCallsAnthropic, _extractToolCallsOpenAI,
        _buildAssistantWithToolCallsAnthropic, _buildAssistantWithToolCallsOpenAI,
        _buildToolResultsAnthropic, _buildToolResultsOpenAI,
        _warmupLLM, _callLLMForAgent, _callLLMForAgentRaw, _callLLMForAgentStream, _hasUnclosedToolBlock } = llmCaller;



// ==================== J2 模式: Model-Agnostic Agent Loop ====================
// 背景: MiniMax-M3 / Qwen-3.6-35b 等不支持原生 tool_call, 原 _handlePanguAgentStream 路径废
// 方案: LLM 自然语言输出 <tool name="...">{json}</tool> 块, 后端解析并执行
// 触发: 启动时探测一次, 缓存到 _toolCallSupportCache (按 model.id)
// N5 B3-Phase 2: j2 helpers 抽到 modules/j2_helpers.js
const j2Helpers = require('./modules/j2_helpers');
const { buildAgentLegacyPrompt, _extractToolCallsFromText } = j2Helpers;
// _detectToolCallSupport 第二参要 _callLLMForAgent, 但 destructure 出来的是裸函数
// 调用方 (_runAgentLoopLegacyStream 行37) 只传 model, 导致 "is not a function" → 探测永远 false → 走 legacy stream → 输出 <|tool_call> 文本
// 修: bind 第二参数 (注意 _callLLMForAgent 在 line 328 已 destructure, 顺序 OK)
const _detectToolCallSupport = (model) => j2Helpers._detectToolCallSupport(model, _callLLMForAgent);
const _toolCallSupportCache = j2Helpers._getToolCallSupportCache();

async function _j2ExecuteToolCalls(toolCalls, res, execOpts) {
  // 2026-09-13 P2a: legacy 执行链也接任务账本 — 真实 sessionId 由调用方 (j2_agent_loop) 传入,
  // 旧硬编码 'pangu-agent-j2' 让所有会话记到同一本假账上。
  const _ledgerSessionId = (execOpts && execOpts.sessionId) || 'pangu-agent-j2';
  const path = require('path');
  const { TOOLS } = require(path.join(__dirname, 'modules', 'tools'));
  const { checkToolCall } = require(path.join(__dirname, 'modules', 'sandbox'));
  const { isConcurrencySafe } = require(path.join(__dirname, 'modules', 'streaming_tool_executor'));
  const { ErrorCode, isRetryable, getFallbackHint, wrapToolResult, wrapToolResultWithHooks, buildError } = require(path.join(__dirname, 'modules', 'error_codes'));
  const allowedTools = Array.isArray(execOpts && execOpts.toolsAllowed)
    ? new Set(execOpts.toolsAllowed)
    : null;
  // 结构化结果旁路 (2026-10-21): 返回数组里每项只有 content 字符串, 而且已经
  // slice(0, 4000) 截断过 —— 排盘核验要的是**未截断**的 sxtwl 结果, 不能从 content
  // 反解 JSON (截断过的 JSON 解析出来是半个盘, 比没有更坏)。
  // 给返回项加 result 字段也不行: _collectEvidence 会改读到它, 顺手改了接地核查。
  // 所以走回调: 调用方要什么形状自己接, 这里只保证真身能出去。
  const _onResult = (execOpts && typeof execOpts.onResult === 'function') ? execOpts.onResult : null;
  const normalizeParams = (params) => {
    if (!params || typeof params !== 'object') return {};
    let out = { ...params };
    for (let i = 0; i < 2 && typeof out.raw === 'string'; i++) {
      try {
        const parsed = JSON.parse(out.raw.trim());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) break;
        out = { ...parsed, ...Object.fromEntries(Object.entries(out).filter(([k]) => k !== 'raw')) };
      } catch (_) { break; }
    }
    return out;
  };
  const deniedCalls = [];
  const permittedCalls = [];
  for (const tc of (Array.isArray(toolCalls) ? toolCalls : [])) {
    if (allowedTools && !allowedTools.has(tc.name)) {
      const error = { code: ErrorCode.PERMISSION_DENIED, message: `工具 ${tc.name} 不在当前将灵白名单` };
      deniedCalls.push({ name: tc.name, ok: false, error, content: JSON.stringify({ ok: false, error }) });
    } else {
      permittedCalls.push({ ...tc, params: normalizeParams(tc.params) });
    }
  }
  toolCalls = permittedCalls;
 // #3 动态策略: 工具健康度追踪 (失败率 ≥30% 自动降权)
  const toolStats = require(path.join(__dirname, 'modules', 'tool_stats'));

 // TL-1 §11: 并行上限 env (default 5, 老板拍板点)
  const DISPATCHER_PARALLEL_MAX = parseInt(process.env.DISPATCHER_PARALLEL_MAX || '5', 10) || 5;
 // TL-2 §12 拍板: 保留当前 backoff [1000, 2000, 4000] (Node.js 标准重连 backoff)
  const DEFAULT_BACKOFF_MS = [1000, 2000, 4000];
  const DEFAULT_MAX_ATTEMPTS = 3;
 // TL-2 §4: Status fountain 防护 (LLM 重复 5 round 打断)
  const FOUNTAIN_REPEAT_THRESHOLD = 5;
  const MAX_STREAM_CHARS = 50000;

  // T1: 带重试的工具调用 (TL-2 改造)
  async function _callToolWithRetry(toolName, params, context, opts = {}) {
    // 2026-10-28 (第 136 批 P3): 权限档位的执行层闸门 (只读档真禁写禁网)。
    //   legacy 这条路以前一道闸都没有 —— 只读档在 native 那条禁住了, 在这条还照写照网。
    //   放在重试循环**外面**: 被拒的调用不该被重试三次 (重试也不该有)。
    try {
      const pg = require(path.join(__dirname, 'modules', 'permission_guard'));
      const g = pg.checkToolPermission(toolName, params || {}, {
        sessionId: (context && context.sessionId) || _ledgerSessionId || undefined,
      });
      if (g && g.allowed === false) {
        console.warn('[permission_guard] BLOCK legacy ' + toolName + ' (level=' + g.level + '): ' + g.reason);
        try {
          require(path.join(__dirname, 'modules', 'run_trace')).appendGuard({
            guard: 'permission_guard', action: 'block',
            reason: 'PERMISSION_LEVEL_BLOCKED: ' + g.reason,
            userInput: (context && context.sessionId) || _ledgerSessionId || 'legacy',
          });
        } catch (_) { /* 留痕失败不许影响拦截 */ }
        return {
          ok: false,
          error: { code: ErrorCode.PERMISSION_DENIED, message: 'PERMISSION_LEVEL_BLOCKED: ' + g.reason },
          execution_ms: 0,
        };
      }
    } catch (_) { /* permission_guard 异常不阻断 */ }
    const maxAttempts = opts.maxAttempts || DEFAULT_MAX_ATTEMPTS;
    const backoffMs = opts.backoffMs || DEFAULT_BACKOFF_MS;
    const retryableCodes = opts.retryableCodes || new Set([ErrorCode.TIMEOUT, ErrorCode.EXEC_FAILED, ErrorCode.RATE_LIMITED]);
    let lastError = null;
    let lastErrObj = null;
    const startMs = Date.now();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let result;
      try {
        // 2026-07-26 老板拍: mcp__ 前缀路由到 MCP adapter (外部进程), 其他走内部 TOOLS
        // 2026-10-24 (第 79 批): 改走 modules/mcp_tool_exec —— legacy 这条与 native 那条
        //   (j2_agent_loop) 现在是**同一个入口**, 两份实现不会各自漂。
        if (toolName.startsWith('mcp__')) {
          const { execMcpTool } = require(path.join(__dirname, 'modules', 'mcp_tool_exec'));
          result = await execMcpTool(toolName, params);
        } else {
          result = await wrapToolResultWithHooks(toolName, params, () => TOOLS[toolName]({ context, params }), { sessionId: (context && context.sessionId) || _ledgerSessionId });
        }
      } catch (e) {
        // wrapToolResult 已经处理 throw, 这里应该是 unreachable
        result = { ok: false, error: buildError(toolName, e), execution_ms: Date.now() - startMs };
      }
      if (result && result.ok === true) return result;
      lastErrObj = result && result.error;
      lastError = new Error((lastErrObj && lastErrObj.message) || 'unknown');
      const code = lastErrObj && lastErrObj.code;
      // 不可重试的 code 立刻返回
      if (code && !retryableCodes.has(code) && code !== ErrorCode.UNCAUGHT) {
        return result;
      }
      // UNCAUGHT 也按 retryable 处理 (TL-2 场景 A 期望 retryable=true)
      const canRetry = code && (retryableCodes.has(code) || code === ErrorCode.UNCAUGHT);
      if (!canRetry && attempt >= maxAttempts - 1) return result;
      if (attempt < maxAttempts - 1) {
        const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)] || backoffMs[backoffMs.length - 1];
        try { res.write('event: retry\ndata: ' + JSON.stringify({ name: toolName, attempt: attempt + 1, maxAttempts, delay, code }) + '\n\n'); } catch (e) { console.warn('[pangu] sse_write error:', e.message); }
        await new Promise(r => setTimeout(r, delay));
      }
    }
    // 重试用尽
    return {
      ok: false,
      error: lastErrObj || buildError(toolName, lastError),
      execution_ms: Date.now() - startMs,
    };
  }

  // TL-2 §4: Status fountain 检测
  let _lastRoundText = '';
  let _fountainRepeat = 0;
  let _accumulatedText = '';
  function _detectFountain(currentText) {
    if (!currentText) return { repeat: false, count: 0 };
    if (currentText === _lastRoundText) {
      _fountainRepeat++;
    } else {
      _fountainRepeat = 0;
      _lastRoundText = currentText;
    }
    _accumulatedText += currentText;
    if (_accumulatedText.length > MAX_STREAM_CHARS) {
      return { repeat: false, count: _fountainRepeat, code: 'STREAM_TOO_LONG', message: 'Output truncated.' };
    }
    if (_fountainRepeat >= FOUNTAIN_REPEAT_THRESHOLD) {
      return { repeat: true, count: _fountainRepeat, code: 'FOUNTAIN_DETECTED', message: 'You are repeating. Try a different approach.' };
    }
    return { repeat: false, count: _fountainRepeat };
  }
  // TL-2 测试钩子 (避免测试污染 _lastRoundText, 提供 reset)
  function _resetFountainState() {
    _lastRoundText = ''; _fountainRepeat = 0; _accumulatedText = '';
  }

  const toolResults = [...deniedCalls];
  const safeCalls = toolCalls.filter(tc => tc.name !== 'task_done' && isConcurrencySafe(TOOLS, tc.name));
  const unsafeCalls = toolCalls.filter(tc => tc.name !== 'task_done' && !isConcurrencySafe(TOOLS, tc.name));

 // BugB: 工具调用计数追踪 (用于 permission_apply 重试上限)
  const toolCallCounters = {};
 // BugF: SSE 输出长度限制
  let totalOutputChars = 0;
  const MAX_TOTAL_OUTPUT_CHARS = 8000;
  function safeWriteLimited(event, data) {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    if (totalOutputChars + str.length > MAX_TOTAL_OUTPUT_CHARS) {
      try { res.write('event: warning\ndata: ' + JSON.stringify({ warning: '输出已达长度限制 ' + MAX_TOTAL_OUTPUT_CHARS + ', 已截断' }) + '\n\n'); } catch (e) {}
      return false;
    }
    totalOutputChars += str.length;
    try { res.write('event: ' + event + '\ndata: ' + str + '\n\n'); } catch (e) { console.warn('[pangu] res.write error:', e.message); }
    return true;
  }
  
  // T2: 安全调用分批并行 (TL-1 改造: depends_on 自动注入 + DISPATCHER_PARALLEL_MAX)
  // 工具结果收集器 (TL-1 §3 sequential chain 用, ctx.tool_results[name] = {ok, result|error, execution_ms})
  const toolResultsMap = new Map();
  // A batch may contain the same tool more than once.  Naming the map entry
  // only by tool name made the later result overwrite the earlier one, so a
  // dependent call could silently receive the wrong result. Keep a stable
  // per-call key and retain the first name alias for older depends_on payloads.
  let toolResultSequence = 0;
  const resultKeyFor = (tc) => {
    if (!tc._resultKey) {
      toolResultSequence += 1;
      tc._resultKey = tc.id || (tc.name + '#' + toolResultSequence);
    }
    return tc._resultKey;
  };
  const saveToolResult = (tc, result) => {
    const key = resultKeyFor(tc);
    toolResultsMap.set(key, result);
    if (!toolResultsMap.has(tc.name)) toolResultsMap.set(tc.name, result);
  };
  if (safeCalls.length > 0) {
    const batchSize = DISPATCHER_PARALLEL_MAX;
    // TL-1 §3: 按 depends_on 拓扑排序 — 没依赖的先跑, 有依赖的等前序完成
    // 简化实现: 多 round, 每个 round 找"依赖已完成"的 tool, 同 round parallel
    const pending = safeCalls.slice();
    let round = 0;
    const MAX_ROUNDS = 10;
    while (pending.length > 0 && round < MAX_ROUNDS) {
      round++;
      const ready = [];
      const stillPending = [];
      for (const tc of pending) {
        const deps = Array.isArray(tc.params && tc.params.depends_on) ? tc.params.depends_on : [];
        if (deps.length === 0 || deps.every(d => toolResultsMap.has(d))) {
          ready.push(tc);
        } else {
          stillPending.push(tc);
        }
      }
      if (ready.length === 0) {
        // 循环依赖或依赖一个不存在的 tool — 全部返 error
        for (const tc of stillPending) {
          const err = {
            ok: false,
            error: {
              code: ErrorCode.INVALID_ARGS,
              message: `[${tc.name}] depends_on cannot be resolved: missing tool(s) in deps`,
              retryable: false,
              fallback_hint: getFallbackHint(ErrorCode.INVALID_ARGS),
            },
            execution_ms: 0,
          };
          saveToolResult(tc, err);
          toolResults.push({ name: tc.name, ok: false, content: JSON.stringify(err).slice(0, 4000) });
          try { res.write('event: tool_result\ndata: ' + JSON.stringify({ id: `tc_dep_unres_${tc.name}_${Date.now()}`, name: tc.name, ok: false, error: err.error, reason: 'depends_on unresolvable' }) + '\n\n'); } catch (e) { console.warn('[pangu] sse_write error:', e.message); }
        }
        break;
      }
      // 同 round 分 batch parallel
      for (let i = 0; i < ready.length; i += batchSize) {
        const batch = ready.slice(i, i + batchSize);
        const batchPromises = batch.map(async tc => {
          // 注入 _callCount
          var params = Object.assign({}, tc.params);
          // strip depends_on + parallel_group (LLM 字段, 不传给 tool)
          if (params.depends_on) delete params.depends_on;
          if (params.parallel_group) delete params.parallel_group;
          params._callCount = (toolCallCounters[tc.name] || 0);
          toolCallCounters[tc.name] = (toolCallCounters[tc.name] || 0) + 1;
          // TL-1 §3 sequential chain: 注入 ctx.tool_results[name] = 前序 result
          params._depends_on_results = {};
          for (const dep of (Array.isArray(tc.params && tc.params.depends_on) ? tc.params.depends_on : [])) {
            if (toolResultsMap.has(dep)) params._depends_on_results[dep] = toolResultsMap.get(dep);
          }
          // 2026-08-11 R131+ 老板拍: tool_call 独立 emit (前端能渲独立卡片, 不塞进 stream_delta 文本)
          // 关联 tool_result 的 id (前端按 id 匹配, 实时更新卡片状态)
          const toolCallId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          try {
            res.write('event: tool_call\ndata: ' + JSON.stringify({
              id: toolCallId,
              name: tc.name,
              params: Object.assign({}, params, { _depends_on_results: undefined }),  // 不发 ctx 字段, 太大
              ts: Date.now()
            }) + '\n\n');
          } catch (e) { console.warn('[pangu] tool_call sse_write error:', e.message); }
          const check = checkToolCall(tc.name, params, { cfgTools: _config.tools });
          if (!check.ok) {
            if (check.needs_approval) {
              try {
                res.write('event: approval_needed\ndata: ' + JSON.stringify({
                  task_id: check.task_id,
                  tool: tc.name,
                  id: toolCallId,
                  reason: check.reason,
                  params: tc.params
                }) + '\n\n');
              } catch (e) {}
            }
            const errContent = JSON.stringify({ ok: false, error: check.reason, sandbox_block: true, needs_approval: !!check.needs_approval, task_id: check.task_id });
            try { res.write('event: tool_result\ndata: ' + JSON.stringify({ id: toolCallId, name: tc.name, ok: false, blocked: true, reason: check.reason }) + '\n\n'); } catch (e) { console.warn('[pangu] sse_write error:', e.message); }
            return { tc, name: tc.name, ok: false, content: errContent, error: check.reason, _result: { ok: false, error: { code: ErrorCode.PERMISSION_DENIED, message: check.reason, retryable: false, fallback_hint: getFallbackHint(ErrorCode.PERMISSION_DENIED) }, execution_ms: 0 } };
          }
          const execResult = await _callToolWithRetry(tc.name, params, { user: 'feng', sessionId: _ledgerSessionId });
          if (_onResult) { try { _onResult(tc.name, execResult); } catch (_) {} }
          try { res.write('event: tool_result\ndata: ' + JSON.stringify({ id: toolCallId, name: tc.name, ok: !!(execResult && execResult.ok), result: execResult }) + '\n\n'); } catch (e) { console.warn('[pangu] sse_write error:', e.message); }
          return { tc, name: tc.name, ok: !!(execResult && execResult.ok), content: JSON.stringify(execResult).slice(0, 4000), _result: execResult };
        });
        const batchResults = await Promise.all(batchPromises);
        for (const r of batchResults) {
          if (r._result) saveToolResult(r.tc, r._result);
          toolResults.push({ name: r.name, ok: r.ok, content: r.content });
        }
        try { res.write('event: batch_complete\ndata: ' + JSON.stringify({ round, batch: Math.floor(i / batchSize) + 1, total: Math.ceil(ready.length / batchSize), completed: batchResults.length, mode: 'depends_on_aware' }) + '\n\n'); } catch (e) { console.warn('[pangu] sse_write error:', e.message); }
      }
      pending.length = 0;
      pending.push(...stillPending);
    }
    if (pending.length > 0) {
      // 超过 MAX_ROUNDS, 还有 pending 卡住 — 强制 force-fail
      for (const tc of pending) {
        const err = {
          ok: false,
          error: {
            code: ErrorCode.EXEC_FAILED,
            message: `[${tc.name}] depends_on 循环 / 超过 ${MAX_ROUNDS} round 解析`,
            retryable: false,
            fallback_hint: getFallbackHint(ErrorCode.EXEC_FAILED),
          },
          execution_ms: 0,
        };
        saveToolResult(tc, err);
        toolResults.push({ name: tc.name, ok: false, content: JSON.stringify(err).slice(0, 4000) });
      }
    }
  }

  // 不安全调用: 串行
  for (const tc of unsafeCalls) {
    // Keep the same normalized params used by the safe-call path. The old
    // branch referenced `params` without declaring it, so every non-safe tool
    // crashed before execution with ReferenceError.
    const params = Object.assign({}, tc.params || {});
    if (params.depends_on) delete params.depends_on;
    if (params.parallel_group) delete params.parallel_group;
    params._callCount = (toolCallCounters[tc.name] || 0);
    toolCallCounters[tc.name] = (toolCallCounters[tc.name] || 0) + 1;
    const check = checkToolCall(tc.name, params, { cfgTools: _config.tools });
    if (!check.ok) {
 // §0.13 + §8.11: 盘古申请权限 → SSE 推送 approval_needed 给 Pangu UI 横幅
      if (check.needs_approval) {
        try {
          res.write('event: approval_needed\ndata: ' + JSON.stringify({
            task_id: check.task_id,
            tool: tc.name,
            reason: check.reason,
            params: tc.params
          }) + '\n\n');
        } catch (e) {}
      }
      const errContent = JSON.stringify({ ok: false, error: check.reason, sandbox_block: true, needs_approval: !!check.needs_approval, task_id: check.task_id });
      toolResults.push({ name: tc.name, ok: false, content: errContent, error: check.reason });
      try { res.write('event: tool_result\ndata: ' + JSON.stringify({ id: `tc_orphan2_${tc.name}_${Date.now()}`, name: tc.name, ok: false, blocked: true, reason: check.reason }) + '\n\n'); } catch (e) { console.warn('[pangu] sse_write error:', e.message); }
      continue;
    }
    const execResult = await _callToolWithRetry(tc.name, params, { user: 'feng', sessionId: _ledgerSessionId }, { maxAttempts: 3 });
    if (_onResult) { try { _onResult(tc.name, execResult); } catch (_) {} }
    toolResults.push({ name: tc.name, ok: !!(execResult && execResult.ok), content: JSON.stringify(execResult).slice(0, 4000) });
    try { res.write('event: tool_result\ndata: ' + JSON.stringify({ id: `tc_orphan3_${tc.name}_${Date.now()}`, name: tc.name, ok: !!(execResult && execResult.ok), result: execResult }) + '\n\n'); } catch (e) { console.warn('[pangu] sse_write error:', e.message); }
  }

 // #3 全动态策略: 把每次调用结果记到 tool_stats, 失败率高的工具自动降权
  for (const tr of toolResults) {
    if (!tr || !tr.name) continue;
    if (tr.ok) toolStats.recordSuccess(tr.name);
    else toolStats.recordFailure(tr.name, tr.error || (tr.content && tr.content.slice(0, 200)));
  }

  return toolResults;
}

// 2026-09-16 老板拍: 工具结果回写截断 — 长会话全量重发时, 每条工具结果重发 N 次 = 输入爆炸
// 大结果 (read_file 全文 / exec_command 长回显) 截断到 4K chars, 留 file:// 路径引用供下游重读;
// 目录树/列表类 (list_directory/ls/du) 截断到 50 行。截断不丢信息: 路径/摘要保留, 正文可按需重读
const _TRUNC_MAX_CHARS = 4000;
const _TRUNC_MAX_LINES = 50;
const _LIST_TOOLS = new Set(['list_directory', 'ls', 'du', 'tree']);
function _truncateToolContent(name, content) {
  if (typeof content !== 'string' || !content) return content;
  const _isList = _LIST_TOOLS.has(name) || /^(ls\b|du\b|find\b|tree\b)/.test(String((name && name.match(/exec/)) || '')) || false;
  let out = content;
  if (_isList) {
    const lines = out.split('\n');
    if (lines.length > _TRUNC_MAX_LINES) {
      out = lines.slice(0, _TRUNC_MAX_LINES).join('\n') + `\n…(截断, 共 ${lines.length} 行, 完整列表请用 exec_command 重查)`;
    }
  }
  if (out.length > _TRUNC_MAX_CHARS) {
    const cut = out.slice(0, _TRUNC_MAX_CHARS);
    // 保留 file:// 或绝对路径引用 (下游按路径重读, 不靠截断正文)
    const paths = (out.match(/(?:file:\/\/|\/Users\/|\/tmp\/)[^\s"'<>)]+/g) || []).slice(0, 8).join(' | ');
    out = cut + `\n…(截断, 原文 ${out.length} chars${paths ? ', 关键路径: ' + paths : ''}, 需要全文请 read_file 重读)`;
  }
  return out;
}

function _j2AppendToolResults(messages, toolResults) {
  if (toolResults.length === 0) return;
  const blocks = toolResults.map(tr => {
    const content = _truncateToolContent(tr.name, tr.content);
    return `<tool_result name="${tr.name}">\n${content}\n</tool_result>`;
  });
  messages.push({
    role: 'user',
    content: '[系统: 以下是工具执行结果, 请基于结果继续组织答案]\n\n' + blocks.join('\n\n')
  });
  // 2026-08-02 反幻觉钩子② legacy 分支 (同 j2_agent_loop native 路径):
  // 有失败/空结果 → 只许引用原始输出, 禁止推测原因 (RTF 11:24 "沙箱关了" 连环幻觉实案)
  try {
    const _bad = toolResults.filter(tr => !tr || tr.ok === false || tr.blocked || !tr.content || tr.content === '{}' || tr.content === 'null');
    if (_bad.length > 0) {
      const _names = _bad.map(tr => (tr && tr.name) || 'unknown').join(', ');
      messages.push({
        role: 'system',
        content: '[SYSTEM WARNING] 刚才 ' + _bad.length + ' 个工具失败或空输出 (' + _names + ')。反幻觉铁律: 分析原因时只允许引用工具返回的原始 error/stdout/stderr 文本, 禁止推测 "沙箱/权限/网络/路径/不存在" 等原因 — 除非原始输出里明说了。原始输出没说 = 原因未知, 继续换方法查证, 不许编。'
      });
    }
  } catch (_) {}
}

// Dispatcher 默认启用：盘古只负责回复/调度，具体执行交给子 agent。
// 只有明确闲聊/认知类问题才走 legacy 单 agent 主循环。
// ══════════════════════════════════════════════════════════════════════════
// 起卦门的词表与判定 —— **唯一真源在 modules/gua_gate_kws.js** (2026-10-23 第 58 批搬)
// ══════════════════════════════════════════════════════════════════════════
//
// 搬家理由 (不是「整理」, 是**防漂移**):
//   做「分层编排」时发现, 判定「主人要不要卦」的那批词只存在于本文件的私有 const。
//   编排层要在另一个模块里判断同一件事, 照抄第二份就是盘古 2026-10-21 亲自踩过的坑:
//   「**两份同义文本各改各的, 改一次就漂一次**」—— 改一处, 另一处立刻失效而且不报错。
//
// 搬法: 词表**逐字搬过去, 一行没改**; 这里用同名别名接回来,
//   所以本文件其余所有引用(`_GUA_DECISION_KWS` 等)**一行都不用动** ⇒ 判定行为逐位不变。
//   验证: tests/gua-gate-refactor-20261023.test.js 拿搬走前的快照逐项比对。
//
// 判定语义(未变, 只是搬了家):
//   2026-10-09 (老板问"为什么每次都是卦象定调"): 起卦原本和"走不走 dispatcher"共用同一个开关,
//   而那个开关默认 return true(保守兜底), PURE_CHAT 白名单只有十来句问候 —— 于是"帮我查一下成交量"
//   "看看桌面有哪些文件"这种纯取数活也起卦, 回答前面挂一段卦象定调, 反而把"我根本没查到数据"这件事盖住了。
//   这里把起卦单独判一次:
//     取数类(查/找/搜/拉/列/统计/行情…) → 不起卦, 直接拿事实回答
//     谋断类(该不该/怎么走/趋势/风险/决策) → 照旧起卦, 卦象定调保留
//     都不像 → 仍起卦(保持"卦先于人"原本的设计意图)
const {
  PURE_CHAT_KWS: _PURE_CHAT_KWS,
  GUA_DECISION_KWS: _GUA_DECISION_KWS,
  GUA_CAST_REQUEST_KWS: _GUA_CAST_REQUEST_KWS,
  GUA_FACT_LOOKUP_KWS: _GUA_FACT_LOOKUP_KWS,
  GUA_FACT_LOOKUP_RE: _GUA_FACT_LOOKUP_RE,
  GUA_FACT_OVERRIDE_KWS: _GUA_FACT_OVERRIDE_KWS,
  GUA_SUPPRESS_KWS: _GUA_SUPPRESS_KWS,
  GUA_EXEC_KWS: _GUA_EXEC_KWS,
  isPureChat: _isPureChat,
  isGuaFactLookup: _isGuaFactLookup,
  isConcreteTargetTask: _isConcreteTargetTask,
  isShushuContext: _isShushuContext,
} = require('./modules/gua_gate_kws');

// 「卦资料查询」那一档(2026-10-21 补的第五档) —— 词表与判定已搬去
// modules/gua_gate_kws.js, 上面用别名接回来了。
//   2026-10-21 现场取证: 「第24卦是哪一卦？请给出卦名、卦辞、上下卦」被起了梅花卦 ——
//   时间起卦得「小过」(id=62), 跟主人问的 24 卦毫无关系; 模型最后答对了(复卦),
//   但得自己先排除干扰, 而且没走本地 hexagram_lookup, 派 2 个子 agent 用 22 次
//   exec_command 去 grep 源文件, ~80 秒。
//   根因: 起卦门只有四档 (闲聊/谋断/取数执行/兜底), **没有"问卦本身的资料"这一档** ——
//   "第24卦是哪一卦" 既没有取数动词("查/找/搜"), 也不像谋断 → 落进兜底 → 起卦。
//   修法: 加第五档「卦资料查询」→ 不起卦, 改走 hexagram_lookup 取 64i 真源。
//   **方向别搞反**: 这是"少起卦", 不是"不许起卦" —— 老板 2026-08-02「卦先于人」的核心场景不动。

// 2026-10-13 (现场 longwork-1791848550): 40 个文件全部写对了, 答案开头却是
// 「大壮初九"征凶有孚"提示不宜抢进」—— 纯执行任务也起了卦, 卦象盖在事实结论前面,
// 直接违反 system prompt 第 1 条「回答的第一段必须是已核实的事实/结论」。
//
// 五段判定, 谋断优先:
//   闲聊 → 不起卦 / 谋断显式 → 起卦 / 取数或执行 → 不起卦 / 都不像 → 起卦(守 08-02 原意)
//   2026-10-21 补第五档: 卦资料查询 → 不起卦 (答案在 64i 真源, 调工具取)
// 谋断放在最前, 是为了不砍掉老板 2026-08-02"卦先于人"的核心场景;
// 最后一档仍返回 true, 未知输入继续起卦 —— 白名单永远漏词, 漏了要往"起卦"那边倒。
function _shouldCastGua(userInput) {
  const text = String(userInput || '').toLowerCase();
  if (!text.trim()) return false;
  // 2026-10-26 (第 105 批): 纯闲聊判定从「字面 includes」升级成**概念判据**
  //   (modules/gua_gate_kws.isPureChat —— 唯一真源, dispatcher 门共用同一份)。
  //
  //   病根: 白名单是**字面词表**, 判定是 `text.includes(k)` ⇒ 主人插一个字
  //   就掉出白名单, 兜底规则 (下面最后的 `return true` 起卦) 立刻把它吃掉
  //   ⇒ **纯闲聊白起一卦**。
  //   现场 (生产 :18901 实测): 主人问「你到底是谁」→ 真起了「否」卦(动爻九四),
  //   答复尾巴挂着「卦照否之观, 九四有命无咎」—— **问「你是谁」, 盘古给他算了一卦**。
  //   32 句纯闲聊里 22 句会白起一卦。
  //
  //   修法不是往词表里加字 (加不完), 是换判据:
  //     ① 「你 + 身份/能力动词」那一族 → 复用 answer_alignment.isSelfIntroAsk (单一真源)
  //     ② 招呼/在线/模型/时间/收尾 → 整句锚定的概念正则
  //   ⚠ 概念层是**整句锚定**的 ⇒ 「你好, 帮我查一下成交量」这种真活匹配不上
  //     ⇒ 落回下面的取数/执行档 ⇒ 仍然不起卦 ✓
  //   ⚠ 字面白名单的 includes 口径**逐位保留** (isPureChat 内部): 它同时压着
  //     「介绍一下这个项目」这类真活, 改成整句反而会把它们推进兜底起卦。
  if (_isPureChat(text)) return false;
  if (_GUA_DECISION_KWS.some(k => text.includes(k.toLowerCase()))) return true;
  // 2026-10-21: 主人明确要卦 → 必起卦 (规则 19(a) 写的就是这个)。
  // 之前没有这一档, 「算一卦看看…」会被取数词 '看看' 压掉 —— 主人明说要卦, 却没卦。
  if (_GUA_CAST_REQUEST_KWS.some(k => text.includes(k.toLowerCase()))) return true;
  if (_isGuaFactLookup(text)) return false;
  // 2026-10-24 第 76 批: **术数语境优先于取数/执行词表** ——
  //   这一档必须排在下面两张词表**之前**, 但排在「卦资料查询」**之后**。
  //   · 为什么在词表之前: 本批把「读取/读一下」加进取数抑制表, 结果
  //     「读一下易经这卦怎么看」被词表压掉 ⇒ 主人问的是卦, 却没拿到卦。
  //     词表判的是「这一句在做什么动作」, 术数语境判的是「这一句属于哪条线」——
  //     **线的判据比动作的判据更上层**。
  //   · 为什么在卦资料查询之后: 主人问「第24卦的卦辞是什么」是**查表**不是占问
  //     (2026-10-21 老板裁定, 已有测试钉死), 术数语境不能把它翻回来。
  if (_isShushuContext(text)) return true;
  // 2026-10-24 第 76 批 (实跑取证): 「主人点名了一个具体对象」这一档。
  //   实跑 (桌面端真主路 /api/pangu/agent/stream, 08:34 探针):
  //     「读一下 /tmp/probe76_target.txt 这个文件, 把我给你的编号原样告诉我」
  //     → 起了卦 (颐 ䷚), 卦象被塞进答复尾巴。
  //   放在「取数/执行词表」**之后**、兜底**之前** ——
  //   词表是打地鼠 (开放集, 永远漏词), 这一档是封闭集 (路径/文件名/URL/工具名),
  //   两者互补: 词表管「查一下/看看」, 这一档管「读一下 /tmp/x.txt 告诉我」。
  //   术数语境 (卦/爻/占/断/八字/风水…) 在 isConcreteTargetTask 内部就放行了,
  //   所以老板 2026-08-02「卦先于人」的核心场景不受影响。
  if (_isConcreteTargetTask(text)) return false;
  if (_GUA_SUPPRESS_KWS.some(k => text.includes(k.toLowerCase()))) return false;
  if (_GUA_EXEC_KWS.some(k => text.includes(k.toLowerCase()))) return false;
  return true;
}

function _shouldUseDispatcher(userInput) {
  // 2026-10-15 (实机复现, 这是"跟死了一样"的**真正**根因):
  // pangu_agent_stream.js 起卦后会把【盘古起卦…不要复述本块原文。】**prepend** 到 userInput,
  // 然后同一个 userInput 才送到这道闸门 —— 所以这里拿到的从来不是主人的原话, 而是
  // "【盘古起卦 · 先于推理 …】本卦: 蹇 … 六亲: 妻财 …\n只回一个词: 盘古"。
  //
  // 后果是**两道判定同时失效**:
  //   ① 格式指令门只看开头 (_head), 开头是"【盘古起卦 · 先于推理" —— 永远不匹配;
  //   ② 卦块里含"卦"字, 而 '卦' 是 DISPATCHER_KWS 里唯一保留的单字词条 → 关键词门也命中。
  // 于是每一句输入 (闲聊、问句、格式指令) 都稳定进 dispatcher。
  //
  // 上一版只清了单字词条就以为修完了 —— 单测全绿, 实机照旧 90 秒起编排, 就是漏了这一层。
  // 教训: 任何按文本内容做路由的闸门, 都必须先把**服务端自己注入的装饰**剥掉,
  // 否则它判断的是自己刚写上去的字。j2_dispatcher 里早有 _stripGuaBlockForRouting,
  // 直接复用 (唯一真源), 不另写一份, 免得两边对不上。
  let _ask = userInput;
  try {
    _ask = require('./modules/j2_dispatcher')._stripGuaBlockForRouting(userInput);
  } catch (_) {
    // require 失败就退回旧行为, 不能因为剥不掉装饰就把整道闸门炸掉
  }
  const text = String(_ask || '').toLowerCase();

  // 1) 纯闲聊判断（没有任何操作意图的纯对话）—— 与起卦门**共用同一个判据函数**
  //   _isPureChat (modules/gua_gate_kws.js, 唯一真源)。
  //   2026-10-26 (第 105 批): 原来两处各用「字面 includes 白名单」, 主人插一个字
  //   就掉出白名单 ⇒ 兜底规则把纯闲聊吃进编排 (「在不在」→ 走 dispatcher → 90 秒起编排)。
  //   现在两门调**同一个函数**, 判据一改两边同时生效 —— 「两份同义文本必然漂移」
  //   这件事从「靠人盯」变成「结构上不可能」。

  // 2) 明确走 dispatcher 的关键词（affirmation 策略）
  const DISPATCHER_KWS = [
    // 操作类
    // 2026-10-15: 这张表原来含 13 个**单字**词条 (写 改 跑 卦 测 拆 学 记 派 撤 退 复 盘),
    // 而判定是 `text.includes(k)` —— 中文没有词边界, 单字等于自瞄:
    //   '盘' → 盘古 / 棋盘 / 楼盘      '跑' → 跑步 / 跑道
    //   '测' → 观测 / 预测             '复' → 复习 / 恢复 / 复杂
    //   '学' → 学校 / 数学             '改' → 改天
    // 实测代价 (现场): 主人问"只回一个词: 盘古", '盘' 命中 → 进 dispatcher →
    // planner+executor+checker+2 轮补救+综合 ≈ 9 次子 agent 全量编排, 每个 agent 都
    // 回"本轮未收口, 什么都没产出", 200 秒只有 keepalive, 零进展 —— 就是"跟死了一样"。
    // 连"盘古是谁"这种最基础的自我介绍都判成派活。
    //
    // 修法: 单字全部换成多字。真正的短指令在中文里几乎都是"动词+一下",
    // 所以保留 写一下/改一下/跑一下/测一下/拆一下/记一下 这一族,
    // 而"跑步""学校""观测""改天"这些字嵌名词自然不再命中。
    '写一下', '写入', '写好', '重写', '改写', '创建', '生成',
    '改一下', '修改', '编辑',
    '跑一下', '重跑', '执行', 'build', 'install', 'deploy',
    '截图', '点击', '输入', '按键', '拖拽', 'create', 'write', 'edit', 'run', 'exec',
    'generate', 'make', 'do', 'ship', '代码', '脚本', 'shell', 'command', 'package',
    'binary', 'tts', 'speak', 'voice', 'screenshot',
    // 分析类
    '分析', '推理', '判断', '趋势', '风险', '动能', '主力', '高点', '峰值',
    'detect', '卦', '64', 'hex', 'situation', 'risk', 'momentum', 'peak', 'trend',
    'analyze', 'reason', 'infer', 'predict', '评估', '估值', '行情', '走势', '形式', '状态',
    // 检查类
    '验证', '检查', '测试', '测一下', '测下', '校验', 'verify', 'check', 'test', 'validate',
    'audit', '网络', '端口', 'http', '天气', '汇率', '股票', '新闻', 'permission',
    '权限', 'net', 'weather', 'stock', 'price', 'rate', 'news', '通不通', 'ping', 'curl',
    // 排查类
    '排查', '自查', '体检', '诊断', '检查自己', 'self_check',
    // bug 类
    'bug', '找错', '找bug', 'debug', '出错', '异常', '错误', '问题', '诊断',
    '根因', 'root cause', 'issue', 'fix', 'error', 'crash', 'broken', 'fail', 'panic',
    // 规划类
    '规划', '拆一下', '拆解', '拆分', '步骤', '计划', '阶段', '分阶段', '排期', '方案', '策划',
    'plan', 'planning', 'decompose', 'breakdown', 'step', 'phase', 'milestone',
    'roadmap', '怎么开始', '第一步', '怎么走', '下一步', 'todo', 'task list',
    // 学习类
    '学一下', '学个', '学习', '记一下', '记下', '记住', '缓存', '记忆', 'learn', 'remember', 'memorize',
    'cache', 'store', 'save', '沉淀', '总结成', '记下来', '记到',
    // 派活类
    '派活', '派一下', '分派', '调度', '分配', '路由', 'dispatch', 'route', 'assign',
    'delegate', '派给', '谁干', '谁来',
    // 复盘类
    '复盘', '反思', '回顾', '教训', '信号', '警告', '小心', '等待', '撤回', '退出',
    '撤一下', '退一步', 'reflect', 'review', 'lesson', 'signal', 'caution', 'wait', 'withdraw',
    'exit', '复验', '记错', '错在哪', '上次',
  ];

  // 策略：先看是不是**回答格式指令** ("只回一个词: X" / "直接答") → 是就走 legacy
  //      —— 它在规定"怎么回答", 不是在派活, 任何关键词都不该把它拽进编排
  // 再看有没有 dispatcher 关键词 → 有就走 dispatcher
  // 再看是不是**问句** → 是就走 legacy (问的是信息, 不是要人干活)
  // 再看是不是纯闲聊 → 是就走 legacy
  // 其他默认走 dispatcher（保守）
  //
  // 2026-10-15 (现场): 主人发"只回一个词: 盘古", 走了完整编排 200 秒零进展。
  // 这句话在中文里长得像祈使句 ("只回..."), 但它是**元指令** —— 规定答复的形态。
  // 判据取开头一段: 人写格式指令时习惯放在最前面 (句首或"冒号/逗号之前")。
  // 只看开头, 免得正文里偶然出现"直接答"就把真任务判成闲聊。
  const _head = String(_ask || '').trim().slice(0, 14);
  if (/^(只回|只答|只说|直接答|直接说|别废话|不用废话|简短点|简短回答|一句话|不要解释|不用解释|不用调工具|不要调工具|别调工具)/.test(_head)) return false;
  // 2026-10-21 (实跑取证): 「第24卦是哪一卦？请给出卦名、卦辞、上下卦」被派了 2 个子 agent,
  //   22 次 exec_command/read_file 去 grep 本地源文件, ~80 秒 —— 而主循环一个 hexagram_lookup
  //   就能答。'卦' 是 DISPATCHER_KWS 里唯一保留的单字词条, 「第24卦」一撞就进编排。
  // 卦资料查询走 legacy (主循环直调工具): 查表题不是长任务, 不该拆。
  // 判据与起卦门共用 _isGuaFactLookup —— 两处各写一份必然漂移。
  if (_isGuaFactLookup(text)) return false;
  if (DISPATCHER_KWS.some(k => text.includes(k.toLowerCase()))) return true;
  // 2026-10-15 (现场): 单字词条清掉之后, "盘古是谁"/"学校在哪" 仍然返回 true ——
  // 不是被词条命中, 是落进了下面那句"其他默认走 dispatcher"。
  // 问句和祈使句是两回事:
  //   "盘古是谁" / "学校在哪" / "这个 bug 什么根因" —— 问的是信息, 不该起编排
  //   "改一下" / "创建 40 个文件" —— 祈使, 要人干活, 该派
  // 问句误进 dispatcher 的代价跟之前单字误命中一模一样: 走满 planner+executor+checker
  // +2 轮补救+综合 ≈ 9 次子 agent 编排, 200 秒零进展。
  //
  // 放在关键词**之后**: "复盘是什么" 含 复盘(动作词) 仍走 dispatcher,
  // 因为那是让盘古去复盘, 不是问复盘的定义。这条顺序不能反。
  const isQuestion = /[?？]\s*$/.test(text)
    || /(是谁|是什么|在哪|在哪里|怎么|怎样|如何|为什么|为何|哪些|哪个|多少|几点|啥时候|能不能|对不对|是不是|能干什么|能做什么|会做什么|干什么|做什么)/.test(text)
    || /[吗呢吧]\s*$/.test(text);  // 句尾疑问语气: "下棋吗" / "开始了吗" / "好了吧"
  //
  // 2026-10-17 (现场 q-1792191100275, 老板「乾就应该把任务拆了, 分下去」那条):
  //   「查清楚盘古现在的模型池里有哪些模型, 各自的 provider 是什么、哪些是本地端点、
  //     哪些是云端, 以及当前默认用哪个。读配置文件取证, 不要猜。最后给我一张表。」
  //   这是一道**真长任务**, 却一个子 agent 都没派 —— 主 agent 自己跑了 10 轮 52.6s。
  //   路径: 一个词都不命中 DISPATCHER_KWS → 落到下面 isQuestion → 它含 哪些/哪个/是什么
  //   → true → return false → 整道题被当成"问句", 拆解彻底跳过。
  //
  // isQuestion 这道门本身是对的, 它防的是"盘古是谁"/"学校在哪"这种**单问句**白起编排
  // (2026-10-15 那次 200 秒零进展就是它该防的)。区别在句法:
  //   单问句 = 一个疑问小句、一件事 ("这个 bug 什么根因")
  //   这道题 = 五个疑问小句五件事 (列模型 / 各自的 provider / 哪些本地 / 哪些云端 /
  //            当前默认), 外加"读配置文件取证"和"给我一张表"两个交付要求
  // → 判据: 疑问**小句** ≥2 且剥块后够长 → 这是活, 不是问句。
  //
  // 分隔符必须含**逗号和顿号**, 这不是随手加的 (第一版只切句号, 现场用例自己把自己否了):
  //   现场那句按句号切只有 3 段 ——「有哪些模型, 各自的 provider 是什么、哪些是本地端点、
  //   哪些是云端, 以及当前默认用哪个」五个疑问**全挤在第 1 段里**, 句号只隔开了尾部
  //   "读配置文件取证"和"最后给我一张表"。中文长任务的小句几乎全靠逗号顿号分隔,
  //   拿句号当小句边界 → 疑问小句数恒为 1 → 这道门等于没写。
  //
  // 长度下限兜住误放行: 单问句都很短 ("盘古是谁" 4 字 / "有哪些文件" 5 字),
  // 长到 45 字还带两个以上疑问小句的, 基本都是清单式调研而不是一次查询。
  // 放宽方向也跟既有铁律一致 —— 白名单永远漏词, **宁可多跑一次编排, 不可把真派活
  // 当闲聊放过去** (见 _shouldCastGua 顶部, 以及护栏里"孤立名词短语落进保守
  // 默认 —— 是设计, 不是漏网"那一条)。
  //
  // 刻意只动这一处, 不碰关键词表和 PURE_CHAT:
  //   - 关键词命中的题早在上一行 return true, 到不了这里 (天气/股价/修bug 都不受影响)
  //   - 单问句 (盘古是谁/学校在哪) 疑问小句只有 1 个, 仍然 return false
  const _qParts = text.split(/[?？。；;！!，,、]/).filter((s) =>
    /(哪些|哪个|是什么|有多少|多少|分别|各自|所有|全部|以及|还有|另外|外加)/.test(s)).length;
  const _isMultiPartQuestion = _qParts >= 2 && String(_ask || '').trim().length >= 45;
  if (isQuestion && !_isMultiPartQuestion) return false;
  if (_isPureChat(text)) return false;
  return true;
}


// Helper: match input against dispatch_rules.json for skip_planner roles
// Returns { role, fixed_agents, fixed_tasks } or null
//
// 2026-10-18 (身份统一): dispatch_rules.json 的键现在是拼音将灵名, 但里面**还有
// self_checker** —— 它是关键词分组, 不是将灵 (后端从未注册这个角色)。它 weight 1.5,
// 「排查」「自查」「体检」全都命中它。
//
// 不过滤的后果是实打实的: 返回 role:'self_checker' → 下游
// `subAgent.ROLES[fallback.role]` 恒为 undefined → **空角色** —— 子 agent 拿不到
// 将灵提示词, 也拿不到工具白名单, 只读边界当场失效, 而日志只有一句"将灵上场"。
//
// 所以"这个键能不能当 role"只能问一件事: 它是不是 8 将灵之一。
// 这条判据写成一个函数给两个消费方共用 —— 手抄第二份就是下一次漂移的起点。
function _isDispatchableGua(role) {
  try {
    const {GUA_CODES} = require('./agents/gua-identity');
    return GUA_CODES.includes(String(role || ''));
  } catch (_) { return false; }
}

function _matchSkipPlannerRole(userInput, configPath) {
  try {
    const fs = require('fs');
    const path = require('path');
    let rulesPath;
    if (configPath && fs.existsSync(configPath)) {
      const dir = path.dirname(configPath);
      // CONFIG_PATH normally points at config/nodes/<host>.json while the
      // dispatch rules live beside `nodes/` at config/dispatch_rules.json.
      // Check both layouts so an alternate config path cannot silently disable
      // fixed-flow routing.
      const candidates = [
        path.join(dir, 'dispatch_rules.json'),
        path.join(dir, '..', 'dispatch_rules.json'),
      ];
      const found = candidates.find(p => fs.existsSync(p));
      if (found) rulesPath = found;
    }
    if (!rulesPath) {
      const cfgDir = CONFIG_PATH ? path.dirname(CONFIG_PATH) : path.join(__dirname, 'config');
      rulesPath = path.join(cfgDir, 'dispatch_rules.json');
    }
    if (!fs.existsSync(rulesPath)) return null;
    
    const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const text = (userInput || '').toLowerCase();
    
    // 2026-10-16 (现场 lt2-1792136323364, "长任务不拆刀"根因): skip_planner 的语义是
    // "这个角色有一套**固定协议**, 不用拆"。analyzer 曾挂着 skip_planner,
    // 它的 fixed_tasks 却只有一句通用模板:
    //   "基于主人提供的事实和已返回的工具证据, 分析风险、趋势或判断依据…"
    // 这句话在**派发那一刻(94ms)还不存在任何工具证据** —— 子 agent 拿到的是零信息量的
    // 填充话术, 主人真正的诉求只靠尾巴上原话兜着。更糟的是它的关键词含"分析",
    // 于是"分析这三个文件"这种本该拆成 3 刀的任务, 在 94ms 内被压成**一个** analyzer:
    //   实测 plan 事件 = [{agent:'analyzer', total:1, task:'基于主人提供的事实…'}]
    // 不拆刀 → 不分下去 → 子 agent 无差别重填 → 就是"跟死了一样"。
    //
    // 2026-10-18 (老板原话: «那问题就应该盘古判断几个agent并发, 不是人为控制agent并发»):
    // 上面这套判据当时留着 self_checker 当"真协议"的例外。老板那句话把例外也一起否了 ——
    // **扇出几个人是盘古(主 agent / planner)的决定, 不是配置里写死的数字**。
    // 配置里那个 ["checker","checker","checker","checker"] 就是人替盘古决定了 N=4:
    // 实机 session 80004976 派出来 5 个兑 (4 刀体检 + 1 刀"综合输出"),
    //   2 条 ZERO_CONTENT_TIMEOUT_300s (633.2s / 300.0s), 整轮 15 分半。
    // 同样的活盘古自己拆, 拆几刀、派谁、谁先跑, 全在 j2_dispatcher 的 planner 路径里。
    // self_checker 的 skip_planner / fixed_agents / fixed_tasks 已全部摘掉,
    // 现在 dispatch_rules.json 里 **零个角色** 配 skip_planner —— 机制留着当逃生舱
    // (真·写死的协议仍然可以配), 但准入门钉死在测试里:
    //   longtask-decompose-20261016 T2/T3: 任何角色重新挂上 skip_planner 即测试变红,
    //   且 fixed_tasks 出现指代运行时状态的模板话术 (见上面的 TEMPLATE_TALK) 同样变红。
    // 拆不动的时候走哪条路, 没有变: 主 agent 自拆 → _fastPlanFor 规则快路 → 坎·planner
    // → _keywordFallback。
    let best = null;
    for (const [role, config] of Object.entries(rules)) {
      if (role === '_meta') continue;
      if (!_isDispatchableGua(role)) continue;   // 同 _keywordFallback: 只有将灵能当 role
      if (!config.skip_planner) continue;
      
      const kws = config.keywords || [];
      const weight = config.weight || 1.0;
      let score = 0;
      let matchedCount = 0;
      
      for (const kw of kws) {
        if (text.includes(kw.toLowerCase())) {
          matchedCount++;
          score += weight;
        }
      }
      
      if (matchedCount >= 1 && (!best || score > best.score)) best = { role, fixed_agents: config.fixed_agents, fixed_tasks: config.fixed_tasks, score };
    }
    return best;
  } catch (e) {
    return null;
  }
}

// Build subTasks from fixed_agents/fixed_tasks
function _buildFixedSubTasks(fixedAgents, fixedTasks) {
  const tasks = [];
  const count = Math.min(fixedAgents.length, fixedTasks.length);
  for (let i = 0; i < count; i++) {
    tasks.push({
      agent: fixedAgents[i],
      task: fixedTasks[i],
      index: i + 1,
      total: count
    });
  }
  return tasks;
}

// Keyword fallback when Planner returns empty subTasks
function _keywordFallback(userInput, configPath) {
  try {
    const fs = require('fs');
    const path = require('path');
    let rulesPath;
    if (configPath && fs.existsSync(configPath)) {
      const dir = path.dirname(configPath);
      const drPath = path.join(dir, 'dispatch_rules.json');
      if (fs.existsSync(drPath)) rulesPath = drPath;
    }
    if (!rulesPath) {
      const cfgDir = CONFIG_PATH ? path.dirname(CONFIG_PATH) : path.join(__dirname, 'config');
      rulesPath = path.join(cfgDir, 'dispatch_rules.json');
    }
    if (!fs.existsSync(rulesPath)) return null;
    
    const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    const text = (userInput || '').toLowerCase();
    
    let bestRole = null;
    let bestScore = 0;
    let bestMatchedKws = [];
    
    for (const [role, config] of Object.entries(rules)) {
      if (role === '_meta') continue;
      if (!_isDispatchableGua(role)) continue;   // 见 _isDispatchableGua 的注释
      const kws = config.keywords || [];
      const weight = config.weight || 1.0;
      let score = 0;
      let matchedKws = [];
      
      for (const kw of kws) {
        if (text.includes(kw.toLowerCase())) {
          matchedKws.push(kw);
          score += weight;
        }
      }
      
      if (score > bestScore && matchedKws.length >= 1) {
        bestScore = score;
        bestRole = role;
        bestMatchedKws = matchedKws;
      }
    }
    
    if (bestRole && bestMatchedKws.length >= 1) {
      return { role: bestRole, score: bestScore, matchedKws: bestMatchedKws };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// N5 B3-Phase 4: dispatcher 抽到 modules/j2_dispatcher.js
const j2Dispatcher = require('./modules/j2_dispatcher');
// init 在 initPanguAgents() 之后调 (server.listen 回调里)

// N5 B3-Phase 3: J2 主循环抽到 modules/j2_agent_loop.js

const j2AgentLoop = require('./modules/j2_agent_loop');

// init 在 initPanguAgents() 之后调 (server.listen 回调里)

// N5 B6: agent stream 抽到 modules/pangu_agent_stream.js
const { init: initAgentStream, _handlePanguAgentStream } = require('./modules/pangu_agent_stream');

// 2026-10-26 第 107 批 (桌面端下线): 删掉启动时 sync-hexagrams-mjs 的 execSync。
//   那脚本的产物是 `apps/desktop/src/data/hexagrams.mjs` —— 前端已下线, 产物没人要;
//   留着 = 每次启动白跑一次子进程, 还会在 desktop/ 没了之后静默失败。
//   64i 仍是唯一真源, 在线走 /hexagrams API 直读。

// N5 B6: 恢复 server 定义 (被误删)
//
// 2026-10-27 第 118 批: 走 modules/http_server.js 的 createServer ——
//   之前这里直接 http.createServer, 而 http_server.js 里写好的那层加固
//   (CORS 白名单 + 跨源写请求 403 + 可选 Bearer token) **从来没被调用过**
//   ⇒ 成了死代码, 等于没有。
// 路由链原样搬过来 (静态页 → inline router), 一处定义两处用。
const routeRequest = async (req, res) => {
  // 2026-10-28 (第 141 批): 反代前缀先摘掉 —— 前端全用**相对路径**,
  //   它不知道自己住在 /pangu/ 这种子路径下 ⇒ 前缀由服务端按 X-Forwarded-Prefix 处理。
  //   nginx 剥前缀 (proxy_pass 末尾带 /) 时没有这个头, 也不受影响。
  basePrefix.strip(req);
  // CORS/OPTIONS 在 http_server.init() 闭包内处理
  // 2026-10-28 (第 139 批): 静态页出口管三件事 —— `/` ⇒ 302 /app/ (工作台),
  //   `/app/...` ⇒ 工作台本体, `/api` ⇒ API 索引页。其余路径落回 inline router。
  //   (2026-09-17 单端口合并时这里原本排的是前端 dist 静态路由, 桌面端剥离后已删;
  //    第 108 批的 modules/api_index.js 也在本批删除 —— 静态页只留这一个出口。)
  if (webStatic.handler(req, res)) return;
  await inlineRouter.handler(req, res);
};
const server = httpServer.createServer(routeRequest);

// Bug #4 fix: EADDRINUSE 端口占用时静默退出 — launchd 10s 后重启, 避免 EADDRINUSE 风暴 + issues/ 喷泉
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[pangu] port ${PORT} in use (EADDRINUSE) — exiting cleanly, launchd will retry`);
    process.exit(0);
  }
  // 其他 server error 抛给 uncaughtException 处理
  throw e;
});

// N5 B6: 恢复 server.listen 回调 (被误删)
server.listen(PORT, BIND_HOST, async () => {
  // 2026-10-23: 依赖注入必须排在装饰性日志之前。
  // 病根是这个回调是 async 且没有总闸: 1626 行读 _config.llm 一抛,
  // 整个回调中断, 后面 inlineRouter/httpServer/j2AgentLoop/j2Dispatcher/
  // initAgentStream 全部静默跳过 —— 端口照听, /health 照回 200,
  // 但每个带 body 的 POST 都在 body guard 里 TypeError 挂死(实测 HTTP=000)。
  // 也就是说「进程在」不等于「初始化完了」, 顺序本身就是护栏。
  let _initFailures = [];
  const _initStep = (name, fn) => {
    try { fn(); } catch (e) {
      _initFailures.push(name);
      console.error(`[boot-init] ${name} 失败:`, e && e.stack ? e.stack : e);
    }
  };

  console.log(`✅ 盘古已启动，监听 ${BIND_HOST}:${PORT}`);
  console.log(`[模型池] ${(_config?.llm?.models || []).length} 个模型，默认: ${getDefaultModel()?.id || '无'}`);

  // 2026-10-26 第 111 批: 启动后补 ctx (后台, 不阻塞监听)
  //   事故: 池里多了个新模型 id, registry 里没它的条目 ⇒ getModelContextLength 抛
  //         ⇒ 每次 /api/chat 都 500 (模型本身是好的, 只是没人告诉盘古窗口多大)。
  //   现在: 启动后台扫一遍, 缺 ctx 的补上 (registry / 厂商 models 接口 / 输入上限真值探测);
  //         补不上也有热路径降级兜底 (保守值, 不是 500)。
  setTimeout(() => {
    (async () => {
      try {
        const ctxEnsure = require('./modules/model_ctx_ensure');
        const report = await ctxEnsure.sweepMissingCtx(_config, { probeTimeoutMs: 90000 });
        const filled = report.filter(r => r.source && r.source !== 'registry');
        if (filled.length) {
          console.log('[ctx-ensure] 补齐 ctx:', filled.map(r => `${r.id}=${r.ctx}(${r.source})`).join(', '));
        }
      } catch (e) {
        console.warn('[ctx-ensure] 启动补 ctx 失败 (不影响主流程):', e.message);
      }
      // 延迟感知路由: 主控 Mac 是共享屏主机, 本机 GPU 常年被抢;
      // policy=auto 时, 当前模型太慢/连不上就换到更快的 (质量档优先)。
      try {
        const r = await inlineRouter.applyAutoRouting({});
        if (r && r.decision) {
          console.log('[routing] 决策:', r.decision.action, r.decision.from, '→', r.decision.to, '(' + r.decision.reason + ')');
          if (r.switched && r.switched.ok) console.log('[routing] 已切到', r.switched.to);
        }
      } catch (e) {
        console.warn('[routing] 启动自动路由失败 (不影响主流程):', e.message);
      }
    })();
  }, 1500);

 // P0-#23: server listen 后调 (确保 module.exports 都走完)
 // 避开 require order 问题 — 这时 tools/index.js TOOLS + tools_schema.js TOOLS_SCHEMA 都 ready
 try {
   const toolsModule2 = require('./modules/tools');
   if (typeof toolsModule2.loadPluginsIntoTools === 'function') {
     toolsModule2.loadPluginsIntoTools().then(r => {
       const loaded = (r.loaded || []).filter(p => p.tools.some(t => t.ok));
       if (loaded.length > 0) {
         console.log(`[pangu] ${loaded.length} plugin(s) loaded:`, loaded.map(p => `${p.name}@${p.version} (${p.tools.filter(t=>t.ok).length} tool)`).join(', '));
       } else {
         console.log('[pangu] 0 plugin loaded (empty ~/.pangu-data/plugins or no plugin yet)');
       }
       if (r.failed && r.failed.length > 0) {
         console.warn('[pangu] plugin failures:', r.failed);
       }
     }).catch(e => console.warn('[pangu] plugin load error:', e.message));
   }
   // P0-#20: SDK tool boot hook (跟 plugin 紧跟)
   if (typeof toolsModule2.loadSdkToolsIntoTools === 'function') {
     toolsModule2.loadSdkToolsIntoTools().then(r => {
       const loaded = (r.loaded || []).filter(p => p.handler_loaded);
       if (loaded.length > 0) {
         console.log(`[pangu] ${loaded.length} SDK tool(s) loaded:`, loaded.map(t => `${t.name}@${t.version}`).join(', '));
       } else {
         console.log('[pangu] 0 SDK tool loaded (empty ~/.pangu-data/tools)');
       }
       if (r.failed && r.failed.length > 0) {
         console.warn('[pangu] SDK tool failures:', r.failed);
       }
     }).catch(e => console.warn('[pangu] SDK tool load error:', e.message));
   }
   // P0-#21: hooks boot hook
   try {
     const hooksModule = require('./modules/hooks');
     hooksModule.loadAllHooks().then(r => {
       const loaded = r.loaded || [];
       if (loaded.length > 0) {
         console.log(`[pangu] ${loaded.length} hook(s) loaded:`, loaded.map(h => `${h.name}(${h.events.join(',')})`).join(', '));
       } else {
         console.log('[pangu] 0 hook loaded (empty ~/.pangu-data/hooks)');
       }
       if (r.failed && r.failed.length > 0) {
         console.warn('[pangu] hook failures:', r.failed);
       }
     }).catch(e => console.warn('[pangu] hook load error:', e.message));
   } catch (e) { console.warn('[pangu] hook init error:', e.message); }
 } catch (e) { console.warn('[pangu] plugin/sdk hook error:', e.message); }

  // 2026-10-26 第 108 批: 桌面端彻底下线 —— 不再有 vite 5173 dev server,
  // 也不再有静态资源出口。18901 只回 API 索引页 + 真 API 路由。

 // N5 B4-Phase 2: 优雅关闭抽到 modules/startup.js
  const _gracefulShutdown = attachGracefulShutdown(server);
  const _shutdown = (sig) => {
    console.log('[gateway] ' + sig + ' received');
    _gracefulShutdown(sig);
  };
  process.on('SIGTERM', () => _shutdown('SIGTERM'));
  process.on('SIGINT',  () => _shutdown('SIGINT'));

  // 2026-09-14 (老板拍: 盘古应该自己解决): 全局崩溃自愈钩子
  // 此前进程级崩溃没有 handler — 直接死, launchd 拉起, 无人记账无人修 (09-09 46 次 Unknown 实证)
  // uncaughtException: 记录 + 自愈尝试后必须退出 (进程状态已不可信), launchd 拉起
  // unhandledRejection: 记录 + 自愈尝试, 不退出 (多数是可恢复的悬空 promise)
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    console.error('[unhandledRejection]', err.message, (err.stack || '').split('\n').slice(0, 3).join(' | '));
    try { require('./modules/self_repair').handleCrash('unhandledRejection', err, { config: _config }); } catch (_) {}
  });
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.message, (err.stack || '').split('\n').slice(0, 3).join(' | '));
    try { require('./modules/self_repair').handleCrash('uncaughtException', err, { config: _config }); } catch (_) {}
    setTimeout(() => process.exit(1), 3000).unref(); // 记账/自愈落盘后再死, launchd 拉起干净进程
  });

 // 初始化 8 子 agent、L3、L2
 _initStep('initPanguAgents', () => initPanguAgents());
 startPanguEvolutionLoops();

 // 长工作流和定时任务必须随主服务启动；两者都持久化状态并会在启动时恢复。
 try {
   const workflowEngine = require('./modules/workflow_engine');
   const workflowStart = workflowEngine.start();
   console.log('[workflow] worker started:', JSON.stringify(workflowStart));
 } catch (e) { console.warn('[workflow] worker startup failed:', e.message); }
 try {
   const scheduler = require('./modules/scheduler');
   const schedulerStart = scheduler.startLoop();
   console.log('[scheduler] loop started:', JSON.stringify(schedulerStart));
 } catch (e) { console.warn('[scheduler] loop startup failed:', e.message); }

 // Build/reopen the persisted vector index before serving requests. Recall itself remains lazy and degrades safely.
 try {
   const indexBoot = await sessionStore.ensureIndex();
   console.log('[agentdb] index ready:', JSON.stringify(indexBoot));
 } catch (e) {
   console.warn('[agentdb] index boot degraded:', e.message);
 }

 // TL-3 改造: 启动时扫 mcp_servers 目录, 自动注册未在 json 的 server
 try {
   const mcpLoader = require('./modules/mcp_loader');
   const MCP_DIR = path.join(__dirname, 'mcp_servers');
   const allServers = mcpLoader.loadMcpServers([MCP_DIR]);
   console.log(`[mcp-loader] loaded ${allServers.length} servers (json + dir scan)`);
   // 把 enabled=true 的 server 列表传给 mcpAdapter (TL-3 接生产路径)
   const enabledServers = allServers.filter(s => s.enabled !== false);
   try {
     const mcpAdapter = require('./modules/mcp_adapter');
     // mcp_adapter 用 _servers 全局 list, 替换之
     if (mcpAdapter._setServers) {
       // P0-#34 (batch1) Item 2: await + try/catch 让 spawn 错误显示
       Promise.resolve(mcpAdapter._setServers(enabledServers)).then(
         () => console.log('[mcp-loader] _setServers done, active=' + (mcpAdapter._listServers ? mcpAdapter._listServers().length : '?')),
         (e) => console.warn('[mcp-loader] _setServers failed: ' + e.message.slice(0, 300))
       );
     } else {
       console.warn('[mcp-loader] mcp_adapter no _setServers hook, skipping auto-start');
     }
   } catch (e) { console.warn('[mcp-loader] mcp_adapter init failed:', e.message); }
 } catch (e) { console.error('[mcp-loader] init failed:', e.message); }

 // 2026-09-11 fix: 同步构造 SkillRuntime — 旧代码 init 时 _skillRuntime 还是 null (setImmediate 才建),
 // inline_router 按值注入 null → /skills 永远落 pangu_skills.json fallback (显示 0 / 坏条目)。
 try {
   const { createSkillRuntime } = require('./modules/skill_runtime');
   _skillRuntime = createSkillRuntime({ skillsDir: path.join(process.env.PANGU_HOME || path.join(os.homedir(), '.pangu'), 'skills') });
 } catch (e) { console.warn('[pangu] SkillRuntime create failed:', e.message); _skillRuntime = null; }
 // N5 B4-Phase 1: 给 inlineRouter 传 deps (代替之前隐式全局变量)
 // TL-1 改造: 加 _handlePanguAgentStream (修死引用, 让 inline_router.js:183 真生效)
 inlineRouter.init({
   _config, _recordSessionToMemory, _skillRuntime, // 2026-09-11: 此刻已同步构造 (见下方 init 前)
   callLLM, extractContent, j2AgentLoop, j2Dispatcher,
   getCurrentModel, getDefaultModel, normalizeModels, saveConfig,
   readJsonBody, checkLocalOrigin, safeResWrite, MAX_BODY_BYTES,
  _handlePanguDecide, _handlePanguDispatch, decideOne,
   _handlePanguAgentStream,
   PRESETS,
 });
  // 2026-10-27 第 118 批: 与 createServer(routeRequest) 用**同一条**路由链 ——
  //   之前 init() 只挂 inlineRouter, 静态页不在里面 ⇒ 两处路由不一致。
  httpServer.init({ requestHandler: routeRequest });

 // N5 B3-Phase 3: 给 j2_agent_loop 传 deps (代替之前隐式全局变量)
 j2AgentLoop.init({
    _recordEvolution,
    _recordSessionToMemory,
    _callLLMForAgent,
    _callLLMForAgentStream,
    safeResWrite,
    _detectToolCallSupport,
    _j2ExecuteToolCalls,
    _j2AppendToolResults,
    _hasUnclosedToolBlock,
    _toolCallSupportCache,
    _sessionRecall: sessionStore.sessionRecall,
    _config,  // 2026-09-16 开源默认=省钱: longctx_fallback 需要读 llm.models 池
  });
 // N5 B3-Phase 4: 给 j2_dispatcher 传 deps
  j2Dispatcher.init({
    _recordSessionToMemory,
    _callLLMForAgent,
    _callLLMForAgentStream,
    safeResWrite,
    _j2ExecuteToolCalls,
    _j2AppendToolResults,
    _resolveApiKey,
    j2AgentLoop,
    // B3-Phase 4 遗漏: dispatcher 内部用到但没注入, 导致一进 dispatcher 就 ReferenceError
    truncateMessagesForContext,
    _matchSkipPlannerRole,
    _buildFixedSubTasks,
    _keywordFallback,
    CONFIG_PATH,
    // pangu_agent_stream.js 通过 j2Dispatcher._deps._runPanguDispatcherLoop 回调本模块
    _runPanguDispatcherLoop,
  });

 // N5 B5: 给 pangu_decide 传 deps
  initPanguDecide({
    callLLM,
    extractContent,
    getDefaultModel,
    getYaoVector,
    initPanguAgents,
  });

 // N5 B6: 给 agent_stream 传 deps
  initAgentStream({
    callLLM,
    extractContent,
    getDefaultModel,
    getCurrentModel,
    _buildSystemMessages,
    _loadToolsSchemaForLLM,
    _detectToolCallSupport,
    _extractToolCallsAnthropic,
    _extractToolCallsOpenAI,
    _buildAssistantWithToolCallsAnthropic,
    _buildAssistantWithToolCallsOpenAI,
    _buildToolResultsAnthropic,
    _buildToolResultsOpenAI,
    _callLLMForAgent,
    _recordSessionToMemory,
    _recordEvolution,
    _shouldUseDispatcher,
  _shouldCastGua,
    _runAgentLoopLegacyStream,
    _runPanguDispatcherLoop,
    _warmupLLM,
    safeResWrite,
    _gracefulShutdown,
    _origResWrite,
    getConfig: () => _config,
    checkLocalOrigin,
    readJsonBody,
    MAX_BODY_BYTES,
    _j2ExecuteToolCalls,
    _j2AppendToolResults,
    _hasUnclosedToolBlock,
    _toolCallSupportCache,
    _mergeSessionsIntoMemory,
    _incrementalReindex,
    _dateOffset,
    _loadLongTermMemory,
    _loadToolSummary,
    _loadEvolutionStats,
    _resolveTemperature,
    _resolveApiKey,
    _PROVIDER_CRED_KEYS,
    _extractToolCallsFromText,
    _callLLMForAgentRaw,
    _callLLMForAgentStream,
  });

 // N5 B7: 给 dogfood 传 deps
  initPanguDogfood({
    _recordEvolution,
  });

 // N1 wire: SkillRuntime 异步加载 64 个 skill (fire-and-forget, 不阻塞启动)
  // 2026-09-11 fix: 异步 load 保留, 但 createSkillRuntime 提前到 inlineRouter.init 之前同步构造 (下方)
  setImmediate(async () => {
    if (!_skillRuntime) return;
    try {
      const r = await _skillRuntime.loadAllSkills();
      console.log(`[pangu] SkillRuntime wired: ${r.loaded}/${r.errors?.length || 0} errors, ${_skillRuntime._skills.size} skills in _skills map`);
    } catch (e) {
      console.warn('[pangu] SkillRuntime load failed:', e.message);
    }
  });

 // §0.24: 启动时环境探测 (comfyui / llm / python / bin)
  try {
    const { probeRuntimeEnv, envSummary } = require('./modules/boot');
    const env = await probeRuntimeEnv();
    const _ph = require('./modules/pangu_helpers');
    if (env) {
      console.log('[env_detect] §0.24 cache ok, 存 ~/.pangu/env_cache.json');
      console.log('[env_detect] summary:');
      console.log(envSummary(env).split('\n').map(l => '  ' + l).join('\n'));
    }
  } catch (e) {
    console.warn('[env_detect] §0.24 failed:', e.message);
  }

 // §0.13 + cloud LLM cold start fix: 启动后自动 warmup
  // 后台发 1 个 dummy 请求让云端 LLM 完成 GPU 调度 + 模型预热
  // 适用: 所有云端 SaaS 模型 (minimax / OpenAI / Anthropic / DeepSeek / Kimi / 等)
  // 不适用: 本地 LM Studio / Ollama (冷启动模式不同)
  setTimeout(() => {
    _warmupLLM().catch(e => console.warn('[warmup] failed:', e.message));
  }, 1500);

 // 加定时 GC 防内存泄漏 (–expose-gc 启动)
  // R16 修 (Bug L — 老板 7/25 13:00 拍'全部修'): 间隔 5min → 60s, 主动 GC + 阈值触发 (>300MB 立即 GC)
  if (typeof global.gc === 'function') {
    const gcTimer = setInterval(() => {
      try {
        const before = process.memoryUsage();
        // 阈值触发: heapUsed > 300MB 立即 GC
        if (before.heapUsed > 300 * 1024 * 1024) {
          global.gc();
          const after = process.memoryUsage();
          const freed = (before.heapUsed - after.heapUsed) / 1024 / 1024;
          console.log(`[GC] 阈值触发 ${before.heapUsed / 1024 / 1024 | 0}MB → 释放 ${freed.toFixed(1)}MB, 剩 ${(after.heapUsed / 1024 / 1024).toFixed(1)}MB`);
        } else if (Math.random() < 0.1) {
          // 随机抽样 GC (10% 几率, 避免每轮都 GC 压性能)
          global.gc();
          const after = process.memoryUsage();
          console.log(`[GC] 抽样释放, 剩 ${(after.heapUsed / 1024 / 1024).toFixed(1)}MB`);
        }
      } catch (e) {
        console.warn('[GC] 错:', e.message);
      }
    }, 60 * 1000);  // R16: 5min → 60s (老板拍'全部修')
    gcTimer.unref();
    console.log('[GC] 定时器启动 (60s/次, 阈值 300MB)');
  } else {
    console.warn('[GC] 需 --expose-gc 启动才生效');
  }

 // LM Studio prompt 缓存守卫 (2026-10-15 立, 2026-10-25 第 94 批重做)
  // 详细原理 (为什么要有它 / 旧版四个雷) 见守卫模块顶部注释, 这里只负责接线。
  const _cacheGuard = require('./modules/lmstudio_cache_guard');
  const _cacheTimer = setInterval(() => { _runCacheGuard(); }, 2000);
  _cacheTimer.unref();
  console.log('[LM缓存] 守卫启动 (2s/次, 触发线 ' + (_cacheGuard.RATIO_TRIGGER * 100).toFixed(0) +
    '%, 排空重载, 冷却 ' + (_cacheGuard.RELOAD_COOLDOWN_MS / 60000) + ' 分钟)');

  // 为什么要它: 缓存上限跟**加载时的 ctx** 挂钩 (ctx=65536 → 41GB), 盘古一次请求写
  // ~7.5GB ⇒ 约 6 次请求顶满 ⇒ 开始驱逐 ⇒ 命中率从 99.4% 掉到 51% ⇒ 同一句问在
  // 79.9s 和 274.8s 之间跳。唯一官方重置路径 = 卸载+重载模型 (实测 3.6 秒)。
  //
  // 旧守卫是**从来没生效过的死代码**, 第 94 批实测出四个雷:
  //   a) 触发条件不可达: 要求"空闲 180 秒"且"没有活跃轮次", 而盘古永远有活干
  //      ⇒ 启动行打了 11 次, 一次没触发
  //   b) `lms unload <盘古内部 id>` ⇒ "Model Not Found" (LM Studio 只认 publisher/model)
  //   c) lms 出错时退出码仍是 0 ⇒ 旧代码会打"重载完成"的**假日志**
  //   d) execFileSync 同步 ⇒ 重载那 10~25s 里整个 pangu 服务卡死 (HTTP 全挂)
  //
  // 现在: 判定逻辑全在守卫模块里, 这里只负责"读状态 → 决策 → 执行"。
  // 执行改成异步 (不阻塞事件循环), 走排空闸门 (新请求排队等重载, 不失败),
  // 标识从 `lms ps` 解析, 重载后再用 `lms ps` 复核真的加载上了才算成功。
  const _lmsBin = path.join(os.homedir(), '.lmstudio', 'bin', 'lms');

  // 异步跑 lms —— 旧代码用 execFileSync, 重载期间整个服务卡死。
  const _execLms = (args, timeoutMs) => new Promise((resolve) => {
    let out = '', err = '', done = false;
    const _finish = (r) => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      child = require('child_process').execFile(_lmsBin, args, {
        timeout: timeoutMs || 180000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
      });
    } catch (e) {
      _finish({ ok: false, code: -1, out: '', err: String((e && e.message) || e) });
      return;
    }
    if (child.stdout) child.stdout.on('data', (d) => { out += d; });
    if (child.stderr) child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => _finish({ ok: false, code: -1, out, err: err + String((e && e.message) || e) }));
    child.on('close', (code) => _finish({ ok: code === 0, code, out, err }));
  });

  // lms 出错时**退出码仍然是 0** ⇒ 不能只看 exit code, 得看它说了什么。
  const _lmsLooksFailed = (r) => {
    if (!r || !r.ok) return true;
    const t = (String(r.out || '') + ' ' + String(r.err || '')).toLowerCase();
    return /cannot find|model not found|not found|unknown model|\berror\b|\bfailed\b/.test(t);
  };

  let _cacheTickBusy = false;
  // 用函数声明 (会提升) —— 上面的 setInterval 在本块执行完之前不会触发,
  // 但提升能保证任何时序下都不会碰到 TDZ。
  async function _runCacheGuard() {
    if (_cacheTickBusy) return;
    _cacheTickBusy = true;
    try {
      const _model = getCurrentModel ? getCurrentModel() : getDefaultModel();
      if (!_cacheGuard.guardApplies(_model)) return;
      const _pressure = _cacheGuard.readCachePressure(_cacheGuard.latestLogPath());
      if (!_pressure) return;
      const _inflight = _cacheGuard.inflightCount();
      const _d = _cacheGuard.decide({
        pressure: _pressure,
        // 精确口径: 在途 LLM 请求数。旧代码传的是"活跃轮次数", 那是"有人在用模型"的
        // 粗代理 —— 连轮次之间的空窗期都被堵死, 于是永远等不到安全窗口。
        activeRounds: _inflight,
        idleMs: Date.now() - _cacheGuard.lastRequestAt(),
        lastReloadAt: _cacheGuard.lastReloadAt(),
        // 闸门就位 ⇒ 安全窗口靠**机制**保证 (新请求被挡住排队), 不靠"世界安静 180 秒"
        drainReady: true,
      });
      if (!_d.ok) return;
      console.log('[LM缓存] 触发重载: 占用 ' + (_d.ratio * 100).toFixed(1) + '%, 在途请求 ' + _inflight +
        ', 已驱逐 ' + Math.round(_pressure.evicted_mib || 0) + ' MiB, 原因 ' + _d.reason);
      // 关闸: 新来的请求排队等重载, 而不是失败
      _cacheGuard.beginDrain();
      try {
        const _drained = await _cacheGuard.waitForInflightZero(_cacheGuard.DRAIN_WAIT_MS);
        if (!_drained) {
          console.warn('[LM缓存] 在途请求没排空, 放弃本次重载 (不打断主人正在做的事)');
          return;
        }
        // 真实标识: 盘古内部 id (qwen_qwen3.8-27b) ≠ LM Studio 标识 (qwen/qwen3.8-27b)
        const _ps = await _execLms(['ps'], 20000);
        const _identifier = _cacheGuard.resolveIdentifier(_cacheGuard.parseLmsPs(_ps.out), _model.id);
        if (!_identifier) {
          console.warn('[LM缓存] 在 lms ps 里认不出 model.id=' + _model.id + ', 放弃重载 (不猜)');
          return;
        }
        const _ctx = Math.max(1024, Number(_model.context_length) || 65536);
        const _unload = await _execLms(['unload', _identifier], 60000);
        if (_lmsLooksFailed(_unload)) {
          console.warn('[LM缓存] unload 失败:', String(_unload.out || _unload.err || '').slice(0, 200));
          return;
        }
        const _load = await _execLms(['load', _identifier, '-c', String(_ctx), '--gpu', 'max', '-y'], 180000);
        if (_lmsLooksFailed(_load)) {
          console.warn('[LM缓存] load 失败:', String(_load.out || _load.err || '').slice(0, 200));
          return;
        }
        // 复核: 真的加载上了才算成功 (旧代码在这里打假日志)
        const _ps2 = await _execLms(['ps'], 20000);
        const _loaded = _cacheGuard.parseLmsPs(_ps2.out).some((r) => r.identifier === _identifier);
        if (!_loaded) {
          console.warn('[LM缓存] load 之后 lms ps 里没有 ' + _identifier + ', 不算成功');
          return;
        }
        _cacheGuard.markReloaded(_d.reason);
        console.log('[LM缓存] 重载完成 (identifier=' + _identifier + ', ctx=' + _ctx + '), 缓存已清零');
      } finally {
        _cacheGuard.endDrain();
      }
    } catch (e) {
      console.warn('[LM缓存] 重载失败 (不影响主流程):', e.message);
    } finally {
      _cacheTickBusy = false;
    }
  }

  // ==== 启动自检: 把「进程活着」和「依赖注入跑完了」分成两件事 ====
  // 2026-10-23 实测踩到的坑: 这个 listen 回调是 async 且没有总闸, 回调里
  // 1626 行读 _config.llm 一抛, 后面所有 init* 全部静默跳过 —— 端口照听、
  // /health 照回 200、进程照活, 但每个带 body 的 POST 都在 body guard 里
  // TypeError 挂死(实测 HTTP=000)。看「进程在」永远看不出这个问题。
  // 所以启动末尾必须主动验一次关键依赖真的注入到位, 缺了就要在这里炸出来。
  setImmediate(() => {
    const _required = [
      ['pangu_agent_stream', () => require('./modules/pangu_agent_stream')._isInitDone()],
      ['pangu_helpers', () => !!panguHelpers.getCurrentModel],
      ['inline_router', () => typeof require('./pangu-single/routes/inline_router').init === 'function'],
      ['j2_agent_loop', () => typeof require('./modules/j2_agent_loop').init === 'function'],
    ];
    const _missing = _required.filter(([, probe]) => { try { return !probe(); } catch (_) { return true; } })
      .map(([name]) => name);
    if (_initFailures.length || _missing.length) {
      console.error(
        `[boot-selfcheck] 依赖注入不完整 — 抛错环节: ${_initFailures.join(', ') || '(无)'}` +
        ` | 未就绪: ${_missing.join(', ') || '(无)'}`
      );
      console.error('[boot-selfcheck] 进程会继续监听, 但相关路由会挂 —— 别拿 /health 200 当注入完成的证据');
    } else {
      console.log('[boot-selfcheck] 关键依赖注入全部到位');
    }
  });
});


// N5 B7: dogfood 抽到 modules/pangu_dogfood.js
const { init: initPanguDogfood, _handlePanguDogfood } = require('./modules/pangu_dogfood');
