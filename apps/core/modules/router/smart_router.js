'use strict';

// R42 Smart LLM Router (老板 7/27 00:39 拍 "你直接全接了")
// 输入 task_type + budget + 可选 hint → 输出 (primary, fallback_chain)
// 策略: smart / cost-optimized / fastest / fallback / forced

const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizeSemanticText } = require('../agentdb/embedder');
// 2026-08-22: vision 检测单一真源 — 不再自己写 regex, 直接复用 model_capabilities.detectVision
// (老板实证 15:47: smart_router 标 qwen3.6 vision=true 但 model_capabilities 返 false, 图被 _adaptImagesForModel 吞)
const _modelCapabilities = require('../model_capabilities');
// 2026-10-25 第 99 批: 中文能力 + 推理能力走 model_capability 单一真源。
// 原来这个文件里有两处按品牌名的硬判:
//   ① 中文任务加分写死 provider 名单 ['minimax','kimi','qwen','zhipu','volcengine']
//   ② 推理能力写死一条正则 (/reasoning|thinking|r1|^o1|.../i)
// 两者都是「按品牌名表达能力」—— 换厂商要改代码, 且漏了一堆厂商。
// 现在: 中文偏好 → 能力档案; 推理能力 → 离线规则库 (llm_capabilities_cn, 覆盖 11 个国产厂商)。
const _modelCapability = require('../model_capability');
// 成本/本地判定单一真源 (2026-10-16): 本文件原来有三份各自猜的 `|| 0` / 内联本地判定
const _modelCost = require('./model_cost');

let _cache = null;
let _cacheAt = 0;
let _cachePath = null;
const CACHE_TTL_MS = 60 * 1000;

// 2026-10-28 (第 137 批, 开源): router/models.json 改成**运行时文件, 不入库**。
//   以前仓里那份 models.json 装的是**维护者机器的模型池** (7 个模型的 id + 厂商端点) ——
//   那是从 config/nodes/node.json 同步出来的缓存, 属于机器状态, 不该进开源树。
//   后果: 别人克隆下来会看到 7 个自己根本没有的模型, 而且每次 init 同步都会把
//   仓里那份改脏 (git status 一片红)。
//   现在: 文件不入库, 由 pangu_helpers.syncRouterModelsFromConfig 从用户自己的
//   node.json 生成 —— 干净克隆里第一次 init 就会自动建出来。
//   默认策略放这儿, 是它的唯一真源 (别在别处再抄一份)。
const DEFAULT_ROUTING_POLICY = {
  default_strategy: 'smart',       // smart / cost-optimized / fastest / fallback / forced
  fallback_chain: [],              // 静态兜底链 —— smart_router 实际是动态算 ranked.slice(1,4), 这份只是给人看
  task_classifier: 'keyword',
  auto_sync_from_config: true,
  config_path: 'apps/core/config/nodes/node.json',
};

// 2026-08-23 R16 修: 进程内 LRU 失败黑名单 — L2 文件要 cron 写才生效, 等不及
// 模型本次请求 4xx/5xx/timeout → push 进黑名单, 30 分钟 TTL, 路由时再扣 -1.0
// 跨请求立即生效, 不依赖磁盘; TTL 到自动清, 不持久化
const _RECENT_FAIL_TTL_MS = 30 * 60 * 1000;
const _recentFails = new Map();  // key=modelId, value=[ts1, ts2, ...]
function _recordRecentFail(modelId) {
  if (!modelId) return;
  const now = Date.now();
  const arr = _recentFails.get(modelId) || [];
  arr.push(now);
  while (arr.length && now - arr[0] > _RECENT_FAIL_TTL_MS) arr.shift();
  _recentFails.set(modelId, arr);
}
function _recentFailPenalty(modelId) {
  const arr = _recentFails.get(modelId);
  if (!arr || !arr.length) return 0;
  const now = Date.now();
  const recent = arr.filter(ts => now - ts <= _RECENT_FAIL_TTL_MS);
  if (recent.length === 0) return 0;
  if (recent.length >= 3) return -1.5;
  if (recent.length >= 1) return -1.0;
  return 0;
}
function invalidateRecentFails() { _recentFails.clear(); }

// 2026-08-23 R17 修: silent failure reliability 维度 (LM Studio 本地模型返 200 + 空 content 真信号)
// _recordRecentFail 只接 STATUS_FOUNTAIN_GUARD (重复输出/状态喷泉), 但 silent fail (finalText len=0 + taskDoneCalled=false)
// 完全没记 → 本地模型哑火后 router 还选它, 反复 silent fail. 老板 8/22 实证 qwen_qwen3.6-35b-a3b 触发.
// 独立 Map 避免污染 _recentFails (两类故障成因不同): _silentFails 30 分钟 TTL, ≥2 次 → -10.0 强制置底
const _silentFails = new Map();
const _SILENT_FAIL_TTL_MS = 30 * 60 * 1000;
function _recordSilentFail(modelId) {
  if (!modelId) return;
  const now = Date.now();
  const arr = _silentFails.get(modelId) || [];
  arr.push(now);
  while (arr.length && now - arr[0] > _SILENT_FAIL_TTL_MS) arr.shift();
  _silentFails.set(modelId, arr);
}
function _silentFailPenalty(modelId) {
  const arr = _silentFails.get(modelId);
  if (!arr || !arr.length) return 0;
  const now = Date.now();
  const recent = arr.filter(ts => now - ts <= _SILENT_FAIL_TTL_MS);
  if (recent.length >= 2) return -10.0;   // 强置底 (与 vision 任务 -10 同档, 路由时直接被刷掉)
  if (recent.length >= 1) return -3.0;    // 1 次降权显著, 触发后下次请求大概率换模型
  return 0;
}
function invalidateSilentFails() { _silentFails.clear(); }

// 2026-08-22: L2 健康度降权 (解决老板实证 qwen3.6 25% 成功率仍被选, L2 hint 注入 system 但 router 不真扣分)
// 读 ~/.pangu/evolution/l2/<today>.json → model_success_rate < 0.7 直接扣分
let _l2HealthCache = null;
let _l2HealthAt = 0;
const L2_HEALTH_TTL_MS = 5 * 60 * 1000;  // 5 分钟缓存 (L2 文件 cron 写, 不频繁变)
function loadL2Health() {
  const now = Date.now();
  if (_l2HealthCache && now - _l2HealthAt < L2_HEALTH_TTL_MS) return _l2HealthCache;
  // 2026-08-23 R16 修: 跨天回退 (今天没生成 → 用昨天的, L2-miner 是 cron 凌晨跑, 当天常空)
  // 最多回退 7 天, 仍空就返 {}
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  // 2026-10-26 第 100 批: L2 目录走唯一真源 (modules/evolution_paths.js)
  const { evolutionL2Dir } = require('../evolution_paths');
  const dir = evolutionL2Dir();
  let merged = { model_success_rate: {}, model_counts: {} };
  let found = false;
  // 先扫今天, 再用更早日期补全缺失字段 (老板 R16 实证: 今天 L2 只覆盖 2 个 model 的成功率,
  // google_gemma/qwen3.8 没出现 → 老逻辑 break 后就空 → 不扣分 → 仍被选 primary)
  // 改法: 7 天都扫, 今天数据先填, 缺失字段从最近一次出现补, count 累加
  for (let off = 0; off < 7; off++) {
    const d = new Date(Date.now() - off * 86400000).toISOString().slice(0, 10);
    const fp = path.join(dir, d + '.json');
    if (!fs.existsSync(fp)) continue;
    try {
      const l2 = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const sr = l2.model_success_rate || {};
      const cn = l2.model_counts || {};
      for (const k of Object.keys(sr)) {
        if (merged.model_success_rate[k] == null) merged.model_success_rate[k] = sr[k];
      }
      for (const k of Object.keys(cn)) {
        merged.model_counts[k] = (merged.model_counts[k] || 0) + cn[k];
      }
      found = true;
    } catch (_) {}
  }
  _l2HealthCache = found ? merged : {};
  _l2HealthAt = now;
  return _l2HealthCache;
}
// 2026-08-23 R16 修 (老板实证: google_gemma 0% 成功但 cnt=2 → 旧阈值 cnt<3 不扣, 仍排第一, Auto 模式哑火 → Silent Failure)
// 修法: (a) 0% 失败无论样本多少都重扣 (-2.0); (b) 样本 ≥1 即按 rate 阶梯扣分, 不再要求 cnt≥3
// (c) 同时叠加进程内 LRU 黑名单(实时失败), 取两者更强的负分
function _l2Penalty(modelId) {
  let diskPen = 0;
  try {
    const h = loadL2Health();
    const cnt = (h.model_counts || {})[modelId] || 0;
    const rate = (h.model_success_rate || {})[modelId];
    if (cnt >= 1 && rate != null) {
      if (rate === 0) diskPen = -2.0;             // 100% 失败 → 重扣(样本不论多少)
      else if (rate < 0.3) diskPen = -1.5;        // 极低 (0-30%)
      else if (rate < 0.5) diskPen = -1.0;        // 低 (30-50%)
      else if (rate < 0.7) diskPen = -0.6;        // 中低 (50-70%)
    }
  } catch (_) {}
  const memPen = _recentFailPenalty(modelId);
  const silentPen = _silentFailPenalty(modelId);  // R17: silent failure reliability 维度
  return Math.min(diskPen, memPen, silentPen);  // 取最强惩罚(最负)
}
function invalidateL2HealthCache() { _l2HealthCache = null; _l2HealthAt = 0; }

function getModelsPath() {
  return getModelsPaths()[0];
}

// 2026-10-28 (第 138 批, 开源): 模型池挪出仓库, 落到运行时目录。
//   以前它在 apps/core/modules/router/models.json —— 仓库里的**代码目录**。
//   它是从 config/nodes/node.json 同步出来的缓存, 属于机器状态, 放在代码目录里
//   有两个坏处: ① clone 下来就带着维护者的模型池; ② 每次同步把工作树改脏。
//   现在住 ~/.pangu-data/router/ —— 跟 cost-log.json (同一个 router 的另一个运行时文件) 同处。
//
//   读路径 (按顺序, 取第一个存在的):
//     1. $PANGU_MODELS_PATH        —— 测试隔离用
//     2. ~/.pangu-data/router/models.json  —— 新位置
//     3. apps/core/modules/router/models.json —— 迁移前的旧位置 (2026-10-28 之前)
//   第 3 条是**一次性迁移**: 新装的盘古启动一次就会在新位置生成, 从此不再读旧位置。
//   保留它是为了让升级中的机器不用手动搬文件, 也让**正在跑的老进程**不炸。
function getModelsPaths() {
  if (process.env.PANGU_MODELS_PATH) return [process.env.PANGU_MODELS_PATH];
  const runtime = path.join(os.homedir(), '.pangu-data', 'router', 'models.json');
  const legacy = path.join(__dirname, 'models.json');
  return [runtime, legacy];
}

function loadModels() {
  const now = Date.now();
  const candidates = getModelsPaths();
  if (_cache && _cachePath === candidates[0] && now - _cacheAt < CACHE_TTL_MS) return _cache;
  let raw = null;
  for (const p of candidates) {
    try {
      raw = fs.readFileSync(p, 'utf8');
      break;
    } catch (_) { /* 试下一个 */ }
  }
  try {
    if (raw === null) throw new Error('models.json 不存在 (找过: ' + candidates.join(', ') + ')');
    const parsed = JSON.parse(raw);
    // 2026-08-17 AUTO_TAG_CAPABILITIES: loadModels 自动补 _local / _reasoning / _vision
    // 这样前端 SSE event: routing 里的 is_local / is_reasoning / is_vision 才有真值
    for (const m of (parsed.models || [])) {
      const id = String(m.id || '');
      // 本地判定统一走 model_cost.isLocalModel (单一真源, 2026-10-16)。
      // 原来这行是内联的 `provider==='lmstudio'||'ollama' || api_base 含 127.0.0.1/localhost`,
      // 漏掉两件事: ① 只读 api_base, 配置写成 endpoint 的模型 (llm_caller 那侧用的就是 endpoint)
      // 一律判成云端; ② 内网地址 (ollama 跑在另一台机器) 也判成云端。
      // 后果不是"显示难看", 是 local_prefer 加分和降级选路都挑错人。
      m._local = _modelCost.isLocalModel(m);
      // 2026-10-25 第 99 批: 推理能力判定收进 model_capability.reasoningCapable
      // (显式 reasoning 字段 > role_specialty/capabilities > 离线规则库 > 保守 false)。
      // 旧的那条正则按品牌名匹配 (k3 / kimi / deepseek-r / qwen.*reason …),
      // 换厂商就得改正则, 而且规则库已经覆盖 11 个国产厂商却没人用。
      m._reasoning = _modelCapability.reasoningCapable(m);
      // 中文能力 (第 99 批): 给中文任务时优先选中文强的模型。
      // 旧版是 provider 名单硬判, provider='custom' 的网关转发国产模型会丢加分。
      m._chinese = _modelCapability.chineseProficiency(m);
      // 2026-08-22: vision 检测走 model_capabilities.detectVision 单一真源
      // (老板实证 15:47: smart_router 自己写的 regex 把 qwen3.6 标 vision, 但 model_capabilities 把它标 text-only, 两套不一致导致图被吞)
      // 顺序: config 显式 vision 字段 > auto detect
      if (m.vision === true) {
        m._vision = true;
      } else if (m.vision === false) {
        m._vision = false;
      } else {
        try {
          m._vision = _modelCapabilities.detectVision(m);
        } catch (_) {
          m._vision = false;  // 未知模型保守默认: 无视觉
        }
      }
      // max_tokens is output budget, never a context-window fallback.
      try { m._context_length = require('../model_registry').getContextLength(id) || null; } catch (_) { m._context_length = null; }
    }
    _cache = parsed;
    _cacheAt = now;
    // 缓存键用**解析结果的主路径**, 不用实际读到哪个文件 ——
    // 否则迁移期读到旧位置的文件时, 缓存永远不命中 (每 60s 重读一次)。
    _cachePath = candidates[0];
    return _cache;
  } catch (error) {
    console.warn('[smart-router] models.json load failed:', error.message);
    _cache = { routing_policy: { default_strategy: 'fallback', fallback_chain: [] }, models: [] };
    _cacheAt = now;
    _cachePath = candidates[0];
    return _cache;
  }
}

function invalidateCache() { _cache = null; _cacheAt = 0; _cachePath = null; }

// §2026-08-17: 增加 vision / long_context / code-debug / file-edit 任务类型
const TASK_KEYWORDS = {
  code: ['code', 'function', 'class', 'refactor', 'implement', 'bug', 'fix', '写', '代码', '重构', '修复', '改'],
  code_debug: ['traceback', 'exception', 'error', 'stacktrace', '报错', '异常', '崩溃', '挂', '死锁'],
  file_edit: ['edit', 'patch', 'rename', 'modify', '改名', '编辑', '替换', '补丁'],
  summary: ['summarize', 'summary', 'tldr', 'brief', '摘要', '总结', '概括', '归纳'],
  translation: ['translate', 'translation', '翻译', '译'],
  search: ['search', 'find', 'lookup', '查询', '搜', '找'],
  strategy: ['plan', 'strategy', 'decide', '战略', '策略', '规划', '决定'],
  reasoning: ['why', 'how', 'explain', 'analyze', '为什么', '怎么', '解释', '分析', '推理', '证明'],
  // L6 fix: 移除 '的/了/是/我/你' 停用词 (几乎所有中文输入都会误命中),
  // 改用具体中文场景关键词, 未命中的中文输入落到默认 'chat'
  chinese: ['中文', '汉语', '写诗', '文言文', '古文', '对联', '成语', '诗词', '作文', '拼音'],
  law: ['案件', '诉讼', '答辩', '律师', '法院', '判决', '合同', '法条', 'law', 'attorney', 'court', 'contract'],
  vision: ['看图', '截图', '图片', '描述图', 'image', 'screenshot', 'photo', 'vision', '这张图', '看这个'],
  long_context: ['完整', '全部内容', '整段', '全文', '从开头', 'every detail', 'whole'],
};

function classifyTask(input) {
  // R42 polish: 接 R38 embedder normalizeSemanticText (案子→案件 等)
  const text = normalizeSemanticText(String(input || '').toLowerCase());
  const scores = {};
  for (const [task, keywords] of Object.entries(TASK_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw.toLowerCase())) score += kw.length >= 2 ? 1 : 0.3;
    }
    scores[task] = score;
  }
  // §2026-08-17: 默认 task = 'chat' (轻任务,本地快便宜) — 老代码默认 'reasoning' 导致所有未匹配都跑云端推理
  let best = 'chat';
  let bestScore = -1;
  for (const [task, score] of Object.entries(scores)) {
    if (score > bestScore) { best = task; bestScore = score; }
  }
  return { task: bestScore > 0 ? best : 'chat', scores };
}

// §2026-08-18 SCORE_DIFFERENTIATION: 让 context/priority/capabilities 真正起作用
// 详细评分 (含每一项加成), 用于 /api/router/explain 解释给用户
function _scoreModelForTaskExplain(m, task, opts) {
  const ctx = m._context_length || 0;
  const isReasoning = !!m._reasoning;
  const isVision = !!m._vision;
  const isLocal = !!m._local;
  const q = m.quality_score || 0.7;
  const parts = [];
  let s = q;
  parts.push({ name: 'quality_score', value: +q.toFixed(3), detail: '模型质量分(配置)' });

  if (ctx > 0) {
    const ctxBonus = Math.max(0, Math.min(0.75, Math.log2(ctx / 32768) * 0.15));
    s += ctxBonus;
    parts.push({ name: 'context_bonus', value: +ctxBonus.toFixed(3), detail: '32K=' + ctx + ', log2(ctx/32K)*0.15' });
  }
  if (['code', 'code_debug', 'reasoning', 'law', 'strategy', 'file_edit'].includes(task)) {
    if (isReasoning) { s += 0.35; parts.push({ name: 'reasoning_match', value: +0.35, detail: '重任务+推理模型' }); }
    else { s -= 0.15; parts.push({ name: 'reasoning_mismatch', value: -0.15, detail: '重任务用非推理模型扣分' }); }
  }
  if (['chat', 'summary', 'translation', 'chinese'].includes(task)) {
    if (!isReasoning) { s += 0.2; parts.push({ name: 'light_task', value: +0.2, detail: '轻任务用直答模型更快' }); }
  }
  if (task === 'vision') {
    if (isVision) { s += 0.6; parts.push({ name: 'vision_bonus', value: +0.6, detail: 'vision 任务+视觉模型' }); }
    else { s -= 10.0; parts.push({ name: 'vision_penalty', value: -10.0, detail: 'vision 任务无视觉模型(直接置底)' }); }
  }
  if (task === 'long_context' && ctx >= 200000) { s += 0.5; parts.push({ name: 'long_context_bonus', value: +0.5, detail: '长上下文 ≥ 200K' }); }
  if (ctx >= 500000) { s += 0.2; parts.push({ name: 'megawin_bonus', value: +0.2, detail: '≥ 500K 超大窗口' }); }

  const l2pen = _l2Penalty(m.id);
  s += l2pen;
  if (l2pen !== 0) {
    const h = loadL2Health();
    const rate = (h.model_success_rate || {})[m.id];
    parts.push({ name: 'l2_health_penalty', value: +l2pen.toFixed(3), detail: 'L2 成功率 ' + (rate != null ? (rate*100).toFixed(0)+'%' : 'N/A') });
  }

  // 2026-10-25 第 99 批: 中文能力走能力档案, 不按品牌名硬判。
  if (task === 'chinese' && (m._chinese !== undefined ? m._chinese : _modelCapability.chineseProficiency(m))) {
    s += 0.25; parts.push({ name: 'chinese_proficiency', value: +0.25, detail: '中文能力强 bonus' });
  }
  if (isVision && (task === 'vision' || task === 'file_edit')) {
    s += 0.1; parts.push({ name: 'vision_aux', value: +0.1, detail: 'vision 能力对 vision/file_edit 任务' });
  }
  if (isLocal && task !== 'vision') {
    s += 0.15; parts.push({ name: 'local_prefer', value: +0.15, detail: '本地便宜偏好(非 vision 任务)' });
  }
  if (opts.strategy === 'cost') {
    // 2026-10-16: 原来这里是 `(cost_in||0)+(cost_out||0)` → 成本 0 → cb = (1-0)*0.3 = +0.3,
    // **每个模型都拿满这 0.3**。也就是"成本调整"这一项对全体是个常数: 看着在按成本调,
    // 实际什么都没调。成本不可信时就不给分, 并在明细里说明为什么没有这一项 ——
    // 真正的排序在 pickByTask 的 orderByCost 里, 不在这里。
    const _mc = _modelCost.modelCost(m);
    if (_mc.known) {
      const cb = (1 - _mc.per1k) * 0.3;
      s += cb;
      parts.push({ name: 'cost_adjust', value: +cb.toFixed(3), detail: 'cost-optimized 模式 (已配价 ' + _mc.per1k + '/1k)' });
    } else {
      parts.push({ name: 'cost_adjust', value: 0, detail: '成本字段未配置 → 本项不参与 (判定见 model_cost)' });
    }
  }
  if (opts.budgetRatio !== null && opts.budgetRatio !== undefined && opts.budgetRatio >= 0.7) {
    if (isLocal) { s += 0.3; parts.push({ name: 'budget_local', value: +0.3, detail: '预算 ≥70% 偏本地' }); }
  }
  return { total: +s.toFixed(3), parts };
}

// 主评分函数 (性能路径, 不生成 parts)
function _scoreModelForTask(m, task, opts) {
  const ctx = m._context_length || 0;
  const isReasoning = !!m._reasoning;
  const isVision = !!m._vision;
  const isLocal = !!m._local;
  const q = m.quality_score || 0.7;
  let s = q;

  // ① 上下文长度差异化 (32K / 128K / 256K / 1M 应拉开)
  // log 归一化: log2(ctx/32K) * 0.15 → 32K=0, 64K≈0.15, 128K≈0.30, 256K≈0.45, 1M≈0.75
  if (ctx > 0) {
    s += Math.max(0, Math.min(0.75, Math.log2(ctx / 32768) * 0.15));
  }

  // ② 任务 → 能力匹配
  if (['code', 'code_debug', 'reasoning', 'law', 'strategy', 'file_edit'].includes(task)) {
    if (isReasoning) s += 0.35;       // 重任务优先推理模型
    else s -= 0.15;                    // 非推理模型干这事要扣分
  }
  if (['chat', 'summary', 'translation', 'chinese'].includes(task)) {
    if (!isReasoning) s += 0.2;        // 轻任务用直答模型更快便宜
  }
  if (task === 'vision') {
    if (isVision) s += 0.6;
    else s -= 10.0;                    // 2026-08-22: -2.0 不够, qwen3.6 高 quality_score 抵消, 提到 -10 实际置底 (老板实证 16:01)
  }
  if (task === 'long_context' && ctx >= 200000) s += 0.5;  // long_context 强加分
  if (ctx >= 500000) s += 0.2;                             // 1M context 大窗口额外奖

  // 2026-08-22 §R131-L2-降权: 真把 L2 健康度拉到 router, 高失败率模型实际扣分
  s += _l2Penalty(m.id);

  // ③ 中文任务 → 中文能力强的模型 (第 99 批: 走能力档案, 不按 provider 名单硬判)
  if (task === 'chinese' && (m._chinese !== undefined ? m._chinese : _modelCapability.chineseProficiency(m))) {
    s += 0.25;
  }

  // ④ vision 能力对 vision / multimodal 任务 bonus
  if (isVision && (task === 'vision' || task === 'file_edit')) s += 0.1;

  // ⑤ 本地便宜偏好 (除非 task 强制云端)
  if (isLocal && task !== 'vision') s += 0.15;

  // cost-optimized 模式: cost 反向影响
  if (opts.strategy === 'cost') {
    // 同 explain() 那处: 成本不可信就不给这 0.3 (原来每个模型都拿满, 是个常数项)。
    const _mc = _modelCost.modelCost(m);
    if (_mc.known) s += (1 - _mc.per1k) * 0.3;
  }

  // 预算吃紧时 → 偏本地
  if (opts.budgetRatio !== null && opts.budgetRatio !== undefined && opts.budgetRatio >= 0.7) {
    if (isLocal) s += 0.3;
  }

  return s;
}

function pickByTask(task, strategy, budgetRatio, extra) {
  const cfg = loadModels();
  const _hardVisionFilter = !!(extra && extra.hasImages) || task === 'vision';
  const candidates = cfg.models.filter(m => {
    if (m.available === false) return false;
    // 2026-09-14 修 (老板拍 #5): kind 非 chat 的模型 (视频生成等) 不进文本路由候选 —
    // 之前靠 _note 注释自我约束, 路由根本不读, agnes-video 会被当聊天模型选中
    if (m.kind && m.kind !== 'chat') return false;
    // 2026-08-22: vision 任务 + hasImages 时硬过滤 (老板实证 16:01 qwen3.6 高分排第一但实际无 vision, 图被吞)
    // 仅 hardVisionFilter 开启时执行; 普通 chat/summary 不受影响
    if (_hardVisionFilter && !m._vision) return false;
    return true;
  });

  if (candidates.length === 0) return [];

  if (strategy === 'fastest') {
    return [...candidates].sort((a, b) => (a.latency_p50_ms || 9999) - (b.latency_p50_ms || 9999));
  }

  // R42 回归修: cost 策略与 budgetRatio>=0.9 auto-degrade 必须按成本硬排序 (cost ascending),
  // 不能被 quality_score 综合分盖过 — 此前重构丢了这两个分支, router.test.js 用例 3/10 实证失败
  // 成本排序走 model_cost.orderByCost (单一真源)。原来这里是内联的
  // `(cost_in||0)+(cost_out||0)` 升序: 池里全 0 时它是个 no-op sort →
  // 「预算 ≥90% 自动降级」照按配置顺序选, 挑中的恰好是最贵的 minimax-m3。
  // 预算越吃紧、烧得越狠, 方向是反的。
  if (strategy === 'cost') {
    return _modelCost.orderByCost(candidates).sorted;
  }
  if (budgetRatio !== null && budgetRatio !== undefined && budgetRatio >= 0.9) {
    return _modelCost.orderByCost(candidates).sorted;
  }

  // 综合打分排序
  const opts = { strategy, budgetRatio };
  // 2026-10-16: 加 local_first —— 老板那句「选本地连模型还是云端的」缺的就是这一档。
  //
  // 原来只有 smart (质量优先) / cost / fastest 三档, 没有一档能表达"就用本地":
  //   smart 拿 quality_score 打天下, 池里 minimax-m3 是 1.0 分 + 1M 窗口,
  //   本地 27B 是 0.7 分 + 64K 窗口, 本地偏好那 +0.5 (local_prefer 0.15 + budget 0.3)
  //   根本压不住 → 一句"你好"也要走付费云端。
  //   cost 那档在有成本数据时能用, 但当前配置里成本全是 0 (见 model_cost), 它退化成的
  //   是"本地优先" —— 也就是说主人想要的那件事, 只有在一个恰好会退化的分支里才能得到。
  //
  // local_first 是显式的一档: 有可用本地就本地, 一个都没有才回落云端, 并说清是回落。
  if (strategy === 'local_first') {
    const locals = candidates.filter(m => _modelCost.isLocalModel(m));
    if (locals.length === 0) {
      console.warn('[smart-router] local_first: 池里没有可用本地模型 (候选 '
        + candidates.length + ' 个全是云端) → 回落云端。要真正本地优先, 先挂一个本地模型。');
    }
    const pool = locals.length ? locals : candidates;
    return pool.slice().sort((a, b) => _scoreModelForTask(b, task, opts) - _scoreModelForTask(a, task, opts));
  }
  return [...candidates].sort((a, b) => _scoreModelForTask(b, task, opts) - _scoreModelForTask(a, task, opts));
}

// 公开 explain: 输入 + 选项 → 各模型评分明细 (用于 /api/router/explain 给用户看)
function explain(input, options = {}) {
  const cfg = loadModels();
  const strategy = options.strategy || process.env.PANGU_ROUTER_STRATEGY || cfg.routing_policy.default_strategy || 'smart';
  const budgetRatio = options.budgetRatio;
  const hasImages = options.hasImages === true;
  const classified = classifyTask(input);
  if (hasImages && classified.task !== 'vision') {
    classified.task = 'vision';
  }
  const ranked = pickByTask(classified.task, strategy, budgetRatio, { hasImages });
  const _lfFallback = strategy === 'local_first' && !!ranked[0] && !_modelCost.isLocalModel(ranked[0]);
  return {
    input,
    classified,
    hasImages,
    strategy,
    budget_ratio: budgetRatio,
    primary: ranked[0] ? ranked[0].id : null,
    ...(_lfFallback ? { warning: 'LOCAL_FIRST_NO_LOCAL', note: 'local_first 但没有可用本地模型 → 实际走云端' } : {}),
    ranking: ranked.map(m => {
      const ex = _scoreModelForTaskExplain(m, classified.task, { strategy, budgetRatio });
      return {
        id: m.id, score: ex.total, parts: ex.parts,
        is_vision: m._vision, is_local: m._local, is_reasoning: m._reasoning,
      };
    }),
  };
}

function route(input, options = {}) {
  const cfg = loadModels();
  const strategy = options.strategy
    || process.env.PANGU_ROUTER_STRATEGY
    || cfg.routing_policy.default_strategy
    || 'smart';
  const budgetRatio = options.budgetRatio;
  const forced = options.forced || process.env.PANGU_DEFAULT_MODEL || null;
  // 2026-08-22: 用户附图时强制 task=vision (避免 router 选非 vision 本地模型)
  const hasImages = options.hasImages === true;

  if (forced) {
    const m = cfg.models.find(x => x.id === forced);
    if (m) {
      const _forcedClassified = classifyTask(input);
      // 2026-08-22: forced 非 vision + 有图 → 警告但仍返 (用户可能就是要这个 model)
      const _visionMismatch = hasImages && !m._vision;
      return {
        primary: m,
        fallback_chain: cfg.models.filter(x => x.id !== m.id && !(x.kind && x.kind !== 'chat') && (hasImages ? x._vision : true)).slice(0, 3),
        strategy: 'forced',
        classified: _forcedClassified,
        ...(_visionMismatch ? { warning: 'FORCED_MODEL_NO_VISION', note: 'forced model ' + m.id + ' 不支持 vision, 图片不会发给模型' } : {}),
      };
    }
  }

  // 2026-08-22: hasImages 时覆盖 classified.task (图片意图是 vision, 不依赖 text 关键词)
  const classified = classifyTask(input);
  if (hasImages && classified.task !== 'vision') {
    classified.task = 'vision';
    classified.scores.vision = (classified.scores.vision || 0) + 5;  // 强制 vision 最高分
  }
  // 2026-08-22: 把 hasImages 透传, 让 pickByTask 硬过滤非 vision 模型
  let ranked = pickByTask(classified.task, strategy, budgetRatio, { hasImages });

  // 2026-08-22: vision task 不再有空 ranked 情况 (当代模型全多模态, _scoreModelForTask('vision') 自然排序)
  // 若仍 ranked.length === 0, 极少见 (models.json 空), 让上层自然处理
  // M1 回滚: 审计误判 — _usedFallback 在下方 return 的 fallback_used 字段被读取,
  // 删除声明会导致 ReferenceError (router.test.js 6 连挂实证)。保留声明。
  const _usedFallback = null;

  // 即使空也要给 _scored = [], 避免前端 r.scored.slice() 报 undefined
  // 2026-08-18: 返回全部 candidates (不再 slice 4), 老板可见 5+ 个模型对比
  const _scored = ranked.map(m => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    is_local: !!m._local,
    is_reasoning: !!m._reasoning,
    is_vision: !!m._vision,
    context_length: m._context_length || null,
    score: +_scoreModelForTask(m, classified.task, { strategy, budgetRatio }).toFixed(3),
  }));
  // 空 ranked 时 (例: vision 任务无 vision 模型), 返回 NO_MODELS 但 scored 仍是 []
  // primary 用 scored[0] (排过序), fallback_chain = 后 3 个 (云端优先 fallback)
  const _primary = _scored[0] && (ranked.find(m => m.id === _scored[0].id) || ranked[0]);
  // 选了本地优先却拿到云端 = 主人要的那件事没成立, 必须说出来而不是安静返回。
  const _localFirstFallback = strategy === 'local_first'
    && !!(_primary || ranked[0]) && !_modelCost.isLocalModel(_primary || ranked[0]);
  return {
    primary: _primary || ranked[0] || null,
    fallback_chain: ranked.slice(1, 4) || [],
    strategy,
    classified,
    scored: _scored || [],
    fallback_used: _usedFallback || null,
    ...(ranked.length === 0 ? { warning: 'NO_MODELS_AVAILABLE' } : {}),
    ...(_localFirstFallback ? {
      warning: 'LOCAL_FIRST_NO_LOCAL',
      note: '策略是 local_first, 但池里没有可用本地模型 → 这次实际走的是云端 ('
        + ((_primary || ranked[0] || {}).id) + ')',
    } : {}),
  };
}

module.exports = {
  loadModels,
  invalidateCache,
  classifyTask,
  route,
  explain,
  pickByTask,
  loadL2Health,
  invalidateL2HealthCache,
  DEFAULT_ROUTING_POLICY,
  getModelsPaths,
  _recordRecentFail,
  _recordSilentFail,
  _silentFailPenalty,
  invalidateRecentFails,
  invalidateSilentFails,
  TASK_KEYWORDS,
};
