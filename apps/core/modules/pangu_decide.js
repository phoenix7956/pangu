// modules/pangu_decide.js — N5 refactor batch B5
// _handlePanguDecide + _classifyDispatchTask + _handlePanguDispatch
// 依赖: 通过 init(deps) 注入 + 自己 import 的模块

const fs = require('fs');
const path = require('path');
const os = require('os');

let _deps = null;

// 自己 import 的模块 (不依赖 init)
const { loadConfig, getEnabledModel } = require('../agents/qian');
const { AgentDispatcher, getAgents } = require('../agents/registry');
// 「这个名字能不能当 role 派出去」的唯一判据 (2026-10-18 身份统一)。
// 以前这层是散在各处的一句话比较, 抄了几份就漂了几份 —— dispatch_rules.json 里
// 混进来的 self_checker 正是这么漏到 role 位置上的。判据归到身份真源, 见那里的注释。
const {isGuaRole: _isGuaRole, resolveRole: _parseGuaName} = require('../agents/gua-identity');
const { finalizeStream } = require('../pangu-single/sse/sse-utils');
const {
  endpointOf,
  canonicalModelName,
  isAnthropic,
  normalizeProtocol,
  normalizeEndpoint,
  outputTokenCap,
  authHeaders,
} = require('./model_transport');
const { resolveApiKey } = require('./api_key_resolver');

// 2026-10-15 修 (真 bug, 不是重构遗留的小事):
//   N5 refactor 把 dispatch handler 从 pangu-single.js 抽到本文件时, pangu-single.js 里的
//   模块级 `let _agentRegistry` 没跟着搬过来 —— 本文件从头到尾**没有声明过这个符号**。
//   于是 4 处引用全是 ReferenceError:
//     - 带 target_role 的请求 → 500 "_agentRegistry is not defined" (端点直接死)
//     - LLM 分类命中时 → 被内层 try/catch 吞掉, 静默降级成 keyword 打分
//   也就是说 /api/pangu/dispatch 从来没通过过真 agent, 一直靠 keyword 兜底活着,
//   而 pangu-single.js:221 的 initPanguAgents() 里那句 `_agentRegistry = getAgents()`
//   赋的是**它自己那份**模块变量, 跟这里毫无关系 (注释 line ~550 写得像已经接上了, 是骗人的)。
//
// 修法: 声明它, 并用 getAgents() 懒加载 —— registry 自己有 memo, 重复调用无成本,
//       懒加载顺带躲开 initPanguAgents / initPanguDecide 的先后顺序问题。
let _agentRegistry = null;
function agentRegistry() {
  if (!_agentRegistry) {
    try {
      _agentRegistry = getAgents() || {};
    } catch (e) {
      console.warn('[pangu_decide] agent registry 加载失败, dispatch 降级为只分类不执行:', e.message);
      _agentRegistry = {};
    }
  }
  return _agentRegistry;
}

function init(deps) {
  _deps = deps;
}



// ============================================================================
// Pangu Decide Handler (W4-B 重建, 启发式 8 维向量打分 4 场景)
// L1: 启发式 8 维向量(关键字 + 简单权重, 非真易经 64 卦) / L2: LLM 推理 / L3: 不执行只返决策
// ============================================================================

const PANGU_DECIDE_SCENARIOS = {
  arch: {
    name: '架构决策',
    system: '你是 Pangu · 架构决策顾问。[辅助参考] 基于启发式 8 维向量(关键字 + 简单权重, 非真易经 64 卦)分析架构选择。\n返回严格 JSON: {"recommendation": "方案名", "rationale": "理由", "alternatives": ["备选1", "备选2"], "risks": ["风险1", "风险2"]}',
    decision_key: 'architecture'
  },
  tech: {
    name: '技术选型',
    system: '你是 Pangu · 技术选型顾问。[辅助参考] 基于启发式 8 维向量(关键字 + 简单权重, 非真易经 64 卦)分析技术栈选择。\n返回严格 JSON: {"recommendation": "技术/库/框架", "rationale": "理由", "comparison": "vs 其他方案对比", "risks": ["风险1"]}',
    decision_key: 'technology'
  },
  risk_assessment: {
    name: '风险评估',
    system: '你是 Pangu · 风险评估顾问。[辅助参考] 基于启发式 8 维向量(关键字 + 简单权重, 非真易经 64 卦)分析项目风险。\n返回严格 JSON: {"top_risks": [{"name": "风险名", "severity": "high/medium/low", "mitigation": "缓解方案"}], "overall_risk": "总体风险等级"}',
    decision_key: 'risk'
  },
  refactor: {
    name: '重构路径',
    system: '你是 Pangu · 重构路径顾问。[辅助参考] 基于启发式 8 维向量(关键字 + 简单权重, 非真易经 64 卦)分析重构方案。\n返回严格 JSON: {"phases": [{"phase": 1, "action": "动作", "duration": "估计"}], "strategy": "总体策略", "validation": "验证标准"}',
    decision_key: 'refactor_plan'
  }
};

// M20: 核心决策逻辑抽出 (decide / decide-all 共用)
async function decideOne(scenario, input) {
  scenario = scenario || 'risk_assessment';
  input = input || '';
  const sc = PANGU_DECIDE_SCENARIOS[scenario] || PANGU_DECIDE_SCENARIOS.risk_assessment;

  // L1: 启发式 8 维向量 (关键字 + 简单权重, 非真易经 64 卦) — 同 input 永远同向量(deterministic)
  const hexagramVector = require(path.join(__dirname, '..', '64i', 'hexagram_vector'));
  const hash = require('crypto').createHash('sha256').update(scenario + ':' + input + ':' + Date.now().toString().slice(0, -4)).digest();
  const guaId = (hash.readUInt32BE(0) % 64) + 1;     // 1-64
  const yaoPos = (hash.readUInt32BE(4) % 6);        // 0-5 (hexagram_vector 内部 yao_axioms 是 0-indexed 0-5)
  let vector = hexagramVector.getYaoVector(guaId, yaoPos);
  let usedFallback = false;
  if (!vector) {
    vector = hexagramVector.getYaoVector(guaId, 0);
    usedFallback = true;
  }
  if (!vector) {
    return { ok: false, error: 'guaVector_not_found', guaId, yaoPos };
  }
  vector.guaId = guaId;
  vector.yaoPosition = usedFallback ? 1 : yaoPos + 1;  // 内部 0-5 → 用户 1-6

  // L2: LLM 推理 (看启发式 8 维向量, 非真易经)
  const sysMsg = sc.system;
  const userMsg = `# 场景\n- 决策类型: ${sc.name} (${scenario})\n- 用户问题: ${input}\n\n# 启发式 8 维向量 (关键字 + 简单权重, 非真易经 64 卦)\n${JSON.stringify(vector, null, 2)}\n\n请基于上述 8 维向量 + 用户问题,按 system 要求的 JSON 格式返决策。只返 JSON, 不要 markdown 代码块包裹。`;

  const llmMsgs = [
    { role: 'system', content: sysMsg },
    { role: 'user', content: userMsg }
  ];
  const useModel = _deps.getDefaultModel();
  const t0 = Date.now();
  const llmResult = await _deps.callLLM(llmMsgs, useModel);
  const llmMs = Date.now() - t0;
  const content = _deps.extractContent(llmResult);

  // 解析 LLM JSON (去掉可能的 markdown 包裹)
  let decision = {};
  try {
    const cleaned = content.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
    decision = JSON.parse(cleaned);
  } catch (e) {
    if (process.env.PANGU_DEBUG) console.warn("[pangu] decision parse error:", e.message);
    decision = { raw: content };
  }

  // L3: 返决策, 不执行
  return {
    ok: true,
    scenario,
    scenario_name: sc.name,
    input,
    guaVector: vector,
    decision,
    unified: {
      summary: (decision.recommendation || decision.top_risks?.[0]?.name || decision.phases?.[0]?.action || decision.raw || '').toString().slice(0, 200),
      key: sc.decision_key,
      rationale: decision.rationale || decision.overall_risk || decision.strategy || ''
    },
    meta: {
      llm_ms: llmMs,
      model: useModel?.id || 'unknown',
      provider: useModel?.provider || 'unknown'
    }
  };
}

async function _handlePanguDecide(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      let req_body;
      try { req_body = body ? JSON.parse(body) : {}; }
      catch (_) {
        res.writeHead(400, {'Content-Type': 'application/json; charset=utf-8'});
        return res.end(JSON.stringify({ ok: false, error: 'INVALID_JSON' }));
      }
      const result = await decideOne(req_body.scenario, req_body.input);
      res.writeHead(result.ok ? 200 : 500, {'Content-Type': 'application/json; charset=utf-8'});
      return res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, {'Content-Type': 'application/json; charset=utf-8'});
      return res.end(JSON.stringify({ ok: false, error: e.message, stack: (e.stack || '').slice(0, 500) }));
    }
  });
}

// ============================================================================
// Pangu Dispatcher (, )
// §0.7 Dispatcher 职责: 接任务 → 路由到 8 agent 之一 → 返 target_role + tools
// 严格不调用任何 agent 的工具, 只派活 + 调 task_done 终结
// 升级: §0.22 + 思维层 (分类器走 LLM-first, 关键词打分兜底)
// ============================================================================

// 思维层 LLM-first 真正的"判断分什么任务给什么子 agent"
//   - 输入: 主人原话 + dispatch_rules.json 的 8 角色关键词全集
//   - 输出: JSON { targetRole, confidence, reasoning, taskType, perAgentReasoning, estimatedAgents }
//   - 失败 (LLM 不可用 / 输出不可解析 / 选错角色): 返回 null, 走 keyword 兜底
async function _classifyDispatchTask(task, dispatchRules, model, timeoutMs = 8000) {
  if (!task || !model) return null;
  try {
    // 给 LLM 看 8 角色全集 + 关键词全集 + 每个角色一句话 purpose
    const roleOptions = Object.entries(dispatchRules)
      // 只把**将灵**列给模型。self_checker 是关键词分组不是角色, 之前靠英文名
      // 混在 8 个英文名中间看不出来, 换成拼音后它就成了名单里第 9 个"角色" ——
      // 模型选它, 下游 ROLES[role] 查不到 = 空角色。
      .filter(([r]) => !r.startsWith('_') && r !== 'thresholds' && _isGuaRole(r))
      .map(([r, info]) => {
        const kws = Array.isArray(info.keywords) ? info.keywords.slice(0, 20).join('|') : '';
        return `${r} (keywords: ${kws})`;
      })
      .join('\n  ');

    // 2026-10-18 (身份统一): 候选列表 roleOptions 来自 dispatch_rules.json, 那些键
    // 已经换成拼音; 而这一行的模板还在教模型输出英文。两个名字摆在一起, 模型必然
    // 有时抄上面有时抄下面, 而下面那个 allowed 集合只认其中一种 —— 结果就是
    // 「模型明明选对了, 却判成 null 退回关键词兜底」。模板必须跟列表同一个名字。
    const _GUA_SLOTS = require('../agents/gua-identity').GUA_CODES.join('|');
    const prompt = `你是 Pangu v2 Dispatcher 思维层 🎯\n主人输入 (要派活给 8 个子 agent 的某一个): ${JSON.stringify(task)}\n\n候选角色 (含关键词提示, 让你选得到):\n  ${roleOptions}\n\n请判断"这个任务应该派给哪一个角色", 按 JSON 输出 (不要 Markdown code block, 不要前后缀文字):\n{"targetRole": "<${_GUA_SLOTS}>", "confidence": 0.0~1.0, "reasoning": "一句话判断理由", "taskType": "一句话任务分类", "perAgentReasoning": {"<角色>": "一句话为什么叫或不叫这个角色"}, "estimatedAgents": 1~8}`;

    // 直接 HTTP 调 LLM (跟 callLLM 同样的端点逻辑) — 不展开函数以避免重复 impl
    const messages = [
      { role: 'system', content: '你是 Pangu v2 Dispatcher 思维层。你只能输出严格 JSON, 不能有 Markdown code block, 不能有前后缀文字。' },
      { role: 'user', content: prompt },
    ];

    // 复制 callLLM 的核心，但加 timeout
    const apiKey = resolveApiKey(model);
    const baseUrl = normalizeEndpoint(endpointOf(model), normalizeProtocol(model));
    const useAnthropic = isAnthropic(model);
    const url = new URL(baseUrl);
    let body, headers = authHeaders(model, apiKey);
    const apiModel = canonicalModelName(model);
    if (useAnthropic) {
      const userMessages = messages.filter(m => m.role !== 'system');
      const mergedSystem = messages.find(m => m.role === 'system')?.content || '';
      body = JSON.stringify({
        model: apiModel,
        max_tokens: Math.min(800, outputTokenCap(model)),
        system: mergedSystem,
        messages: userMessages,
      });
    } else {
      body = JSON.stringify({
        model: apiModel,
        max_tokens: 800,
        messages,
      });
    }
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: (() => {
        const p = url.pathname + url.search;
        if (useAnthropic) return p;
        if (p.includes('/chat/completions') || p.includes('/completions')) return p;
        return (p.endsWith('/') ? p.slice(0, -1) : p) + '/chat/completions';
      })(),
      method: 'POST',
      headers,
      timeout: timeoutMs,
    };
    const text = await new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? require('https') : require('http')).request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => reject(new Error('classify timeout')));
req.setHeader('Content-Length', Buffer.byteLength(body)); // 2026-10-14: mlx-serve 不吃 chunked
      req.write(body);
      req.end();
    });
    const obj = JSON.parse(text);
    if (obj.error) return null;
    let content = '';
    if (useAnthropic) content = (obj.content && obj.content.map(c => c.text).join('')) || '';
    else content = (obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content) || '';
    content = (content || '').trim();
    // 鲁棒 JSON parse: 提取第一个 {…} 块
    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;
    let parsed;
    try { parsed = JSON.parse(content.slice(firstBrace, lastBrace + 1)); } catch (_) { return null; }
    // 模型可能照旧吐英文名 (它的先验里全是 analyzer/executor), 所以读进来先归一,
    // 判合法性和往下传都用拼音 —— 存的一律拼音 (resolveRole 是输入解析器, 读完即丢)。
    parsed.targetRole = parsed.targetRole ? (_parseGuaName(parsed.targetRole) || null) : null;
    if (!parsed.targetRole || !_isGuaRole(parsed.targetRole)) return null;
    parsed.confidence = Number(parsed.confidence);
    if (!Number.isFinite(parsed.confidence)) parsed.confidence = 0.85;
    parsed.perAgentReasoning = parsed.perAgentReasoning || {};
    parsed.estimatedAgents = Number(parsed.estimatedAgents) || 1;
    return parsed;
  } catch (e) {
    console.warn('[pangu] _classifyDispatchTask failed:', e.message);
    return null;
  }
}

async function _handlePanguDispatch(req, res) {
  let body = '';
  let sse = null;  // 提到函数作用域, 让 catch 块能访问
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      let req_body;
      try { req_body = body ? JSON.parse(body) : {}; }
      catch (_) {
        res.writeHead(400, {'Content-Type': 'application/json; charset=utf-8'});
        return res.end(JSON.stringify({ ok: false, error: 'INVALID_JSON' }));
      }
      const task = (req_body.task || req_body.input || '').toString().trim();
      if (!task) {
        res.writeHead(400, {'Content-Type': 'application/json; charset=utf-8'});
        return res.end(JSON.stringify({ ok: false, error: 'TASK_REQUIRED', hint: '传 { "task": "你的任务描述" }' }));
      }

      const streamMode = req_body.stream === true || req_body.stream === 'true' || req.headers.accept === 'text/event-stream';

      // 1. 加载 dispatch rules + tool role map
      const dispatchRules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'dispatch_rules.json'), 'utf8'));
      const roleMap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tool_role_map.json'), 'utf8'));

 // 思维层 LLM-first 彻底 — 真正的"判断分什么任务给什么子 agent"
      // 1) 用户显式指定 → 不打分
      // 2) LLM 分类 (用真实模型; 失败 → keyword 降级)
 // 3) Keyword 打分兜底 (老板原 keyword 打分语义保留)
      let targetRole = null;
      let confidence = 1.0;
      let reasoning = '用户显式指定 target_role';
      let bestHits = [];
      let bestScore = 0;
      let runnerUp = null;
      const explicitRole = (req_body.target_role || req_body.role || '').toString().trim();
      let scores = {};
      let dispatcherVersion = 'pangu-v1';
      let classification = null; // LLM 分类结果 (含 perAgentReasoning 等)
      let llmAttempted = false;

      // 路径 1: 用户显式指定 → 直接采用
      //
      // 2026-10-18 (身份统一): roleMap 来自 tool_role_map.json, agentRegistry() 来自
      // registry.js —— 两边以前一个英文一个拼音, 这个 `&&` **恒为假**: 没有任何一个名字
      // 能同时命中两边, 于是「用户显式指定角色」这条路径**整条是死的**, 静默退回 LLM
      // 分类。现在两边都是拼音, 同一个名字能同时命中。
      // 用户仍然可以写英文 (那是模型的先验, 也是旧 URL/旧脚本), 读进来归一, 存的拼音。
      const _explicitCanon = explicitRole ? _parseGuaName(explicitRole) : null;
      if (_explicitCanon && roleMap[_explicitCanon] && agentRegistry()[_explicitCanon]) {
        targetRole = _explicitCanon;
      } else {
        // 路径 2: LLM 分类 (pangu-v2 思维层)
        llmAttempted = true;
        try {
          // 懒 require — 不进 dispatcher 流就不付成本
          const { loadConfig: _loadCfg, getEnabledModel: _getModel } = require('../agents/qian');
          const cfg = loadConfig(require('../config/node_config').resolveNodeConfigPathOrEmpty());
          const model = getEnabledModel(cfg);
          if (model) {
            const cls = await _classifyDispatchTask(task, dispatchRules, model);
            if (cls && cls.targetRole && roleMap[cls.targetRole] && agentRegistry()[cls.targetRole]) {
              targetRole = cls.targetRole;
              confidence = cls.confidence || 0.85;
              reasoning = `[pangu-v2 LLM] ${cls.reasoning || '(no reason)'}`;
              classification = cls;
              dispatcherVersion = 'pangu-v2 (LLM-first)';
            }
          }
        } catch (e) {
          console.warn('[pangu] dispatch LLM classify failed, fallback to keyword:', e.message);
        }

        // 路径 3: keyword 打分兜底 (LLM 失败/不可用)
        if (!targetRole) {
          const taskLower = task.toLowerCase();
          scores = {};
          for (const [role, info] of Object.entries(dispatchRules)) {
            if (role.startsWith('_') || role === 'thresholds') continue;
            // 只有将灵能当 role —— self_checker 是关键词分组不是角色 (2026-10-18)。
            // 它 weight 1.5 且关键词极宽 (排查/自查/体检/诊断), 不过滤的话它会
            // 抢走大量本该派给将灵的活, 然后 roleMap[role] / ROLES[role] 双双落空。
            if (!_isGuaRole(role)) continue;
            if (!info || !Array.isArray(info.keywords)) continue;
            let score = 0;
            const hits = [];
            for (const kw of info.keywords) {
              if (taskLower.includes(String(kw).toLowerCase())) {
                score += info.weight || 1.0;
                hits.push(kw);
              }
            }
            if (score > 0) scores[role] = { score, hits };
          }
          for (const [role, info] of Object.entries(scores)) {
            if (info.score > bestScore) {
              runnerUp = { role, score: bestScore };
              bestScore = info.score;
              targetRole = role;
              bestHits = info.hits;
            }
          }
          if (bestScore === 0) {
            targetRole = 'li';
            confidence = 0.2;
            reasoning = '[pangu-v1 兜底] 无关键词命中, fallback 到 离·li (默认推理)';
          } else {
            const totalHits = bestHits.length;
            const runnerUpGap = runnerUp ? (bestScore - runnerUp.score) / bestScore : 1;
            confidence = Math.min(1.0, bestScore / 3.0 * runnerUpGap);
            reasoning = `[pangu-v1 兜底] 关键词命中 [${bestHits.join(', ')}] (总分 ${bestScore.toFixed(2)}, ${totalHits} 处, 与第二名差距 ${(runnerUpGap * 100).toFixed(0)}%)`;
          }
          dispatcherVersion = 'pangu-v1 (keyword fallback)';
        }
      }

      const roleInfo = roleMap[targetRole] || {};
      const tools = roleInfo.tools || [];
      // 2026-10-18 (身份统一): 这 8 行原来写的是英文键 (executor/analyzer/...),
      // 而 roleMap 来自 tool_role_map.json —— 那张表在拼音化之后**键全是拼音**了。
      // 于是 roleMap.executor 恒 undefined → 8 个计数恒为 0, 而且不报错:
      // API 照常返回 role_stats, 只是每个将灵都报"0 个工具"。
      // 手抄第 8 份身份表 = 迟早第 8 次漂移, 所以从真源的 GUA_CODES 派生。
      const roleStats = {
        ...Object.fromEntries(
          require('../agents/gua-identity').GUA_CODES.map((code) => [
            code, ((roleMap[code] && roleMap[code].tools) || []).length,
          ]))
      };

      const basePayload = {
        task,
        dispatcher: dispatcherVersion,
        target_role: targetRole,
        classification: classification ? {
          taskType: classification.taskType || null,
          reasoning: classification.reasoning || null,
          perAgentReasoning: classification.perAgentReasoning || {},
          estimatedAgents: classification.estimatedAgents || null,
        } : null,
        role_name: roleInfo.name || targetRole,
        role_purpose: roleInfo.purpose || '',
        confidence: Math.round(confidence * 100) / 100,
        reasoning,
        hits: bestHits,
        scores: Object.fromEntries(Object.entries(scores || {}).map(([r, s]) => [r, s.score])),
        tools_count: tools.length,
        tools: tools,
        role_stats: roleStats,
 // 思考过程 + 执行过程以表格 row 数据呈现 — 前端拿这数组渲 <table>
        //   trace.steps 数组: 每个 step 是表格一行
        //     step = { phase: 'thinking'|'acting'|'done', order, role, action, detail, took_ms, ok }
        //   trace.summary = 该次 dispatch 的总览 (3 行 顶部 meta: started_at/ms)
        trace: {
          started_at: new Date().toISOString(),
          dispatcher_version: dispatcherVersion,
          llm_first: dispatcherVersion === 'pangu-v2 (LLM-first)',
          keyword_first: dispatcherVersion === 'pangu-v1 (keyword fallback)',
          steps: [
            // Step 1: 思维 (LLM 第一次判断)
            {
              order: 1,
              phase: 'thinking',
              role: 'dispatcher.classifier',
              action: classification ? 'LLM classify 分类任务' : '关键词打分 fallback',
              detail: (classification && classification.reasoning) || reasoning,
              took_ms: classification ? '< 8000 (timeout)' : 'deterministic',
              ok: !!targetRole,
            },
            // Step 2: 路由
            {
              order: 2,
              phase: 'routing',
              role: targetRole,
              action: '路由到 8 角色之一',
              detail: `confidence=${Math.round(confidence * 100) / 100}, hits=${bestHits.join(',') || '(LLM-first, 0 hits)'}, dispatcher=${dispatcherVersion}`,
              took_ms: 0,
              ok: !!targetRole,
            },
            // Step 3: 实际执行 (sse 模式下不是真跑, 后续 buildResult 之后填)
          ],
        },
      };

 // 修: SSE 流式模式避免 dispatcher 真实模式 60s 超时
      if (streamMode) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        res.write(': stream-open\n\n');
        const sseUtils = require('../pangu-single/sse/sse-utils');
        sseUtils.setupHeartbeat(res, 5000);
        const send = (event, data) => sseUtils.sendEvent(res, event, data);
        send('route', { target_role: targetRole, confidence, reasoning, hits: bestHits });
        sse = { res, send, utils: sseUtils };
      } else {
        res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
      }

 // 修: 如果 agent registry 已加载,真正执行目标 agent
      let agentResult = null;
      if (agentRegistry()[targetRole]) {
        try {
          const agentInput = { type: 'default', goal: task, context: reasoning };
          // 把自由文本任务转换为具体 agent 能识别的 task
          if (targetRole === 'li') {
            if (task.toLowerCase().includes('file') || task.toLowerCase().includes('code')) {
              Object.assign(agentInput, { type: 'analyze_code', path: task });
            } else {
              Object.assign(agentInput, { type: 'analyze_requirement', text: task });
            }
          } else if (targetRole === 'kun') {
            if (task.toLowerCase().includes('run') || task.toLowerCase().includes('command')) {
              Object.assign(agentInput, { type: 'run_command', command: task });
            } else if (task.toLowerCase().includes('write') || task.toLowerCase().includes('file')) {
              Object.assign(agentInput, { type: 'write_file', path: '/tmp/pangu_output.txt', content: task });
            } else {
              Object.assign(agentInput, { type: 'write_file', path: '/tmp/pangu_output.txt', content: task });
            }
          } else if (targetRole === 'dui') {
            Object.assign(agentInput, { type: 'security_scan', output: task });
          } else if (targetRole === 'xun') {
            Object.assign(agentInput, { type: 'scan', code: task });
          } else if (targetRole === 'kan') {
            Object.assign(agentInput, { type: 'plan', goal: task });
          } else if (targetRole === 'zhen') {
            Object.assign(agentInput, { type: 'reflect_session', data: task });
          } else if (targetRole === 'gen') {
            Object.assign(agentInput, { type: 'learn', experience: task });
          } else if (targetRole === 'qian') {
            Object.assign(agentInput, { type: 'dispatch', task });
          }

          if (sse && targetRole === 'qian') {
            // dispatcher 流式执行: 通过 onProgress 推送每个阶段
            const { AgentDispatcher, ROLES, loadConfig, getEnabledModel } = require('../agents/qian');
            const cfg = loadConfig(require('../config/node_config').resolveNodeConfigPathOrEmpty());
            const model = getEnabledModel(cfg);
            const sseStart = Date.now();
            const llm = model
              ? async (prompt, opts) => _deps.callLLM([{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: prompt }], model)
              : async (prompt, opts) => ({ content: 'LLM 模拟响应: ' + (opts && opts.role || 'qian') });
            const dispatcher = new AgentDispatcher({
              llm,
              tools: require('./tools').TOOLS,
              cfg,
              onProgress: (ev) => { if (sse) sse.send('progress', { stage: ev.stage, role: ev.role, elapsed_ms: Date.now() - sseStart }); }
            });
            if (sse) sse.send('start', { stage: 'dispatch', agents: Object.keys(ROLES) });
            agentResult = await dispatcher.dispatch({ input: task });
          } else {
            agentResult = await agentRegistry()[targetRole].execute(agentInput);
          }
        } catch (e) {
          console.warn('[pangu] dispatch agent execution failed:', e.message);
          agentResult = { ok: false, error: e.message };
        }
      } else {
        console.log('[debug] agentRegistry missing or targetRole not found:', targetRole, 'registry:', Object.keys(agentRegistry()));
      }

      const finalPayload = {
        ...basePayload,
        agent_executed: !!agentResult,
        agent_result: agentResult,
        next: agentResult ? 'done' : 'agent.' + targetRole + '._deps.execute(task)',
        // trace 步骤 3: 实际执行 — 拼到 basePayload.trace.steps 末尾
        trace: {
          ...basePayload.trace,
          finished_at: new Date().toISOString(),
          steps: [
            ...basePayload.trace.steps,
            {
              order: 3,
              phase: 'acting',
              role: targetRole,
              action: agentResult ? `${(roleInfo.name || targetRole)} 实际执行` : `agent ${targetRole} 未执行`,
              detail: agentResult
                ? (agentResult.summary || (agentResult.error ? 'error: ' + agentResult.error : '执行成功'))
                : 'agent_result 为空',
              took_ms: agentResult && agentResult.data && agentResult.data.took_ms ? agentResult.data.took_ms : null,
              ok: !!agentResult && !agentResult.error,
            },
          ],
        },
      };

      if (sse) {
        if (sse) { sse.send('result', finalPayload); sse.utils.finalizeStream(res, 'done', finalPayload); }
        return;
      }

      return res.end(JSON.stringify({ ok: true, ...finalPayload }));
    } catch (e) {
      if (sse && !res.writableEnded) {
        if (sse) { try { sse.utils.finalizeStream(res, 'error', { ok: false, error: e.message }); } catch (_) {} }
        return;
      }
      res.writeHead(500, {'Content-Type': 'application/json; charset=utf-8'});
      return res.end(JSON.stringify({ ok: false, error: e.message, stack: (e.stack || '').slice(0, 500) }));
    }
  });
}

// ============================================================================
// _agent* 简化函数 已废弃
// 8 个真 agent (executor/analyzer/checker/bug_hunter/planner/reflector/dispatcher/learner)
// 由本文件顶部的 agentRegistry() 懒加载 (getAgents() 自带 memo)。
// 2026-10-15 更正: 旧注释写"已通过 _agentRegistry = getAgents() 在 _deps.initPanguAgents() 装载"
// 是错的 —— 那句赋值在 pangu-single.js 里, 赋的是它自己那份模块变量, 跟本文件无关,
// 于是本文件 4 处引用全在 ReferenceError 上短路。详见顶部 agentRegistry() 的注释。
// /api/pangu/dispatch (line 2935) 和 /api/pangu/dogfood 端点
// 走 _agentRegistry[targetRole].execute(...) 调真 agent。
// 备份: /tmp/pangu-single-bak-20260714-1920.js (含 7 个 _agent* 函数 ~220 行)
// ============================================================================



// --- 串联器 ---

module.exports = {
  init,
  decideOne,
  _handlePanguDecide,
  _classifyDispatchTask,
  _handlePanguDispatch,
};
