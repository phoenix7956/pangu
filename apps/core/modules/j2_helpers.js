// modules/j2_helpers.js — N5 refactor batch B3-Phase 2
// J2 模式辅助函数: prompt 构建 + tool_call 探测 + 文本提取
// 依赖: _callLLMForAgent (从 llm_caller 注入), _toolCallSupportCache (内部), TOOLS_SCHEMA (require)
const { isAnthropic } = require('./model_transport');
// 2026-10-25 第 98 批: 模型能力真源 —— tool_call 原生性/稳定性是**能力**, 不是品牌。
const _modelCapability = require('./model_capability');

// ==================== Prompt 构建 ====================

let _cachedJ2Prompt = null;

const PROMPT_AGENT_LEGACY_HEADER = `

---`;

function buildAgentLegacyPrompt(opts = {}) {
  if (_cachedJ2Prompt && !opts.role) return _cachedJ2Prompt;
  const { TOOLS_SCHEMA, MAIN_GENERAL_TOOLS_FOR_LLM } = require('./tools_schema');
  const all = Object.keys(TOOLS_SCHEMA);

  // R15 修 (plan-mode-tool-selection spec 2nd pass): 按角色喂工具, 不再喂全部 110
  // 老板 2026-07-25 12:42 截图: 4 步全 list_directory, R14 fix 装饰 — LLM 看到 priority list 把 list_directory 排第 4
  // 根因: priority list 写死, LLM 按字面 + 顺序选
  // 解: 按角色 (main / executor / analyzer / planner / checker) 喂, 让 TOOL_SELECTION_GUIDE 真生效
  let allowedNames;
  const role = opts.role || 'main';  // 默认 main (主对话)
  // 2026-07-27 修: 直接用 tools_schema.js 真源 14 项, 删死代码 fallback + 删 file_grep/file_find hack
  // 老 hack: ['read_file', 'file_grep', 'file_find'].forEach(...) — 跟 j2_agent_loop R18 'main 集不加 file_grep/file_find' 冲突
  if (role === 'main') {
    allowedNames = new Set(MAIN_GENERAL_TOOLS_FOR_LLM);
  } else {
    // 其他角色: 喂全部 (sub-agent 自己有 role 决定)
    allowedNames = new Set(all);
  }

  const lines = [];
  for (const name of all) {
    if (!allowedNames.has(name)) continue;
    const s = TOOLS_SCHEMA[name]?.function;
    if (!s) continue;
    const params = Object.keys(s.parameters?.properties || {});
    const desc = String(s.description || '').slice(0, 120).replace(/[\r\n]+/g, ' ');
    const sig = params.length ? `(${params.join(', ')})` : '()';
    lines.push(`- ${name}${sig}: ${desc}`);
  }
  const header = opts.role
    ? `\n\n--- ROLE=${role} | TOOLS=${lines.length} (按 §0.53 / R15 按角色过滤) ---\n`
    : PROMPT_AGENT_LEGACY_HEADER + '\n';
  const prompt = header + lines.join('\n');
  if (!opts.role) _cachedJ2Prompt = prompt;
  return prompt;
}

// ==================== Tool call 探测 ====================

const _toolCallSupportCache = {};
const _toolCallSupportStatus = {};

async function _detectToolCallSupport(model, _callLLMForAgent) {
  if (typeof _toolCallSupportCache[model.id] === 'boolean') return _toolCallSupportCache[model.id];
  // 2026-08-03 修 (老板 8/3 晚 48 分钟挂死实案): 探测在轮次计时器之前跑, 是黑盒 — 加日志可见;
  // 且 echo 小探测用 30s 短超时 (靠 llm_caller req.on('timeout') 熔断), 不用模型 120s 全额
  // 2026-10-13 修 (soak-live-1791886392): 探测走最小上下文 (只有 user + tools, 不注入 soul system 9 条),
  // k3-256k 带完整 system 时 4/4 全返文本无 tool_calls → 缓存 false → 子 agent 0 工具调用;
  // 直接 curl 验证 k3 支持 tool_calls, 所以问题在 soul system 淹没探测, 不在 k3 本身。
  // 修法: 用 _callLLMForAgentRaw 的裸发 (跳过 _injectSoulSysMsgs), 带 { skipSoul: true } opts.
  console.log('[j2-detect] probing tool_call support, model:', model.id);
  const echoSchema = [{
    type: 'function',
    function: { name: 'echo', description: 'echo a string', parameters: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] } }
  }];
  let supportedCount = 0;
  let probeFailures = 0;
  let cleanResponsesWithoutTools = 0;
  // R18 修 (Kimi K3 reasoning 模型首轮 thinking 后才 tool_call, 2 次不够; 切模型 cache 清空后第一次探测尤其不稳)
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      // 2026-10-13: 探测专用 opts { skipSoul: true } 绕开 soul system 注入
      const result = await _callLLMForAgent([{ role: 'user', content: 'You MUST call the echo tool. echo test ' + attempt }], { ...model, timeout_ms: 30000 }, echoSchema, { skipSoul: true });
      console.log('[j2-detect-probe]', model.id, 'attempt=' + attempt, 'msgs_in=1', 'result_keys=', result ? Object.keys(result).join(',') : 'NULL', 'finish_reason=', result?.choices?.[0]?.finish_reason, 'tc_count=', Array.isArray(result?.choices?.[0]?.message?.tool_calls) ? result.choices[0].message.tool_calls.length : 0, 'content_len=', (result?.choices?.[0]?.message?.content || '').length);
      const isAnthropicModel = isAnthropic(model);
      let probeOk = false;
      try {
      if (isAnthropicModel) {
          probeOk = Array.isArray(result.content) && result.content.some(b => b.type === 'tool_use');
        } else {
          const tc = result.choices?.[0]?.message?.tool_calls;
          probeOk = Array.isArray(tc) && tc.length > 0;
        }
        console.log('[j2-detect-debug]', model.id, 'attempt=' + attempt, 'probeOk=' + probeOk, 'tc=', result.choices?.[0]?.message?.tool_calls ? JSON.stringify(result.choices[0].message.tool_calls).slice(0,200) : 'NULL', 'finish_reason=', result.choices?.[0]?.finish_reason);
      } catch (e2) {
        console.error('[j2-detect-debug-err]', model.id, 'attempt=' + attempt, 'e2=', e2.message, 'result keys=', result ? Object.keys(result) : 'NULL');
      }
      if (probeOk) supportedCount++;
      else if (result) cleanResponsesWithoutTools++;
      // 2026-10-15: 判定线是 supportedCount >= 1 (一次成功即 native), 所以第 2~4 次改不了结论,
      // 只是白烧本地推理 —— LM Studio 日志实测每次 ~3.5s, 白扔 ~10s/进程。
      // 失败路径仍跑满 4 次: 只有 4 次全干净 / 全失败才能区分"偶发不调工具"和"真 legacy"。
      if (supportedCount >= 1) break;
    } catch (e) {
      probeFailures++;
      console.warn('[j2-detect] attempt', attempt, 'failed:', e.message.slice(0, 100));
    }
  }
 // 修: MiniMax-M3 等模型探测时只要有一次成功即认为支持 tool_call,
  // 避免偶发性未调工具导致误判为 J2 legacy 而走慢路径
  const supported = supportedCount >= 1;
  // transient 全失败 (quota/网络/超时) 时不要缓存 false, 下次重新探测; 
  // 只有模型干净回应但从未调用工具时才缓存 false (真 legacy)
  const allAttemptsFailed = supportedCount === 0 && probeFailures === 4;
  const allCleanNoTools = supportedCount === 0 && probeFailures === 0 && cleanResponsesWithoutTools === 4;
  // 2026-10-13 (soak-live-1791888078/1791889638 现场):
  // k3-256k 等推理模型在 echo 探测里**间歇性** 0/4 全 clean (思考后不调工具),
  // 旧逻辑把 0/4 clean 缓存成 false → 整个进程永远走 legacy → 子 agent 0 工具调用。
  // 修法: clean 0/4 也不缓存 (下次重新探测), 只有全异常 (transient) 才不缓存;
  // 真正 legacy 模型 (不支持 tool_calls 的 OpenAI 兼容模型) 的 clean 回应里会有**文本**,
  // 但 probeFailures 仍为 0 (响应成功), 只是 tool_calls 为空 — 这种也 0/4 clean,
  // 所以不能区分 "偶发不调" 和 "真不支持"。
  // 折中: 缓存 true 永远有效; 缓存 false 只在**连续 2 次**全 clean 时 (进程级重试),
  // 首次 0/4 clean 不缓存, 下次会话重新探测。
  if (supported) {
    _toolCallSupportCache[model.id] = true;
    console.log('[j2-detect] ' + model.id + ' supported=true, caching permanently');
  } else if (allAttemptsFailed) {
    // 2026-10-13 (soak-live-1791891310 现场): kimi 系探测全失败 = 额度 403 / 网络抖动 (transient) —
    // k3 直接 curl 已验证 tool_calls 100% 可用, 降级 legacy 会让子 agent 整轮 0 工具。
    // kimi 系全失败 → 不缓存, 保持 native (return true), 额度恢复后自动恢复; 真 legacy 模型照旧缓存 false。
    // 2026-10-25 第 98 批: 原判据是品牌名 (provider/id/endpoint 三条件) —— 换成能力查询:
    // 「这个模型支持 tool_calls 但不稳定」是**能力**, 不是品牌。
    // 任何"探测会间歇性失败但实际支持"的端点都该走同一条路, 不该只有 kimi 被写进代码。
    if (_modelCapability.unstableToolCalls(model)) {
      delete _toolCallSupportCache[model.id];
      console.warn('[j2-detect] ' + model.id + ' all 4 probes failed (transient/quota) — 保持 native, 不降级 legacy');
      _toolCallSupportStatus[model.id] = { model_id: model.id, provider: model.provider || null, supported: true, successful_attempts: 0, attempts: 4, clean_responses_without_tools: 0, probe_failures: 4, checked_at: new Date().toISOString(), path: 'native-transient' };
      return true;
    }
    console.warn('[j2-detect] all 4 probes failed transiently for ' + model.id + '; not caching, will reprobe next call');
  } else {
    // 2026-10-13: 按 provider 区分 — kimi 系 (k3/k3-256k/kimi-for-coding) 直接 curl 已验证
    // tool_calls 100% 可用, 探测 0/4 是间歇性不稳定 (推理模型思考后偶发不调工具),
    // 不能固化 false, 否则整个进程所有子 agent 永远走 legacy. kimi 系 0/4 → 不缓存, 下次重新探测.
    // 真 legacy 模型 (非 kimi): 缓存 false, 避免每会话重复 4 次探测 (~30s).
    // 2026-10-25 第 98 批: 同上 —— 判据从品牌名换成能力 (tool_calls_unstable)。
    if (_modelCapability.unstableToolCalls(model)) {
      delete _toolCallSupportCache[model.id];
      console.warn('[j2-detect] ' + model.id + ' 0/' + (supportedCount + probeFailures) + ' clean — 间歇性, 不缓存 false, 下次重新探测');
    } else {
      _toolCallSupportCache[model.id] = false;
      console.warn('[j2-detect] ' + model.id + ' 0/' + (supportedCount + probeFailures) + ' clean, caching false (true legacy)');
    }
  }
  _toolCallSupportStatus[model.id] = {
    model_id: model.id,
    provider: model.provider || null,
    supported,
    successful_attempts: supportedCount,
    attempts: 4,
    clean_responses_without_tools: cleanResponsesWithoutTools,
    probe_failures: probeFailures,
    checked_at: new Date().toISOString(),
    path: supported ? 'native' : 'legacy',
  };
  console.log('[j2-detect] model:', model.id, 'supported:', supported, '(', supportedCount, '/4)');
  return supported;
}

// ==================== 文本提取 ====================

function _extractToolCallsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const calls = [];
  let m;
  // 2026-08-02 修 (MiniMax-M3 实测): content 混进 ]<]minimax[>[ 特殊段标, 且模型
  // 自由生成 Anthropic 风 <tool_call><invoke name="x"><param>v</param></invoke></tool_call>
  // — 老解析器只认 <tool name="x">{json}</tool>, 整个工具调用被当纯文本收口, 泄漏上屏
  const clean = _stripSpecialTokens(text);
  // 2026-08-11 R131+ 老板拍: 每条 legacy 调用也分配 id (前端 SSE event:tool_call 按 id 匹配 tool_result)
  const _newId = (name) => `tc_legacy_${Date.now()}_${Math.random().toString(36).slice(2,8)}_${name}`;
  // 格式 1: J2 legacy <tool name="x">{json}</tool>
  const re = /<tool\s+name="([a-z_][a-z0-9_]*)">([\s\S]*?)<\/tool>/g;
  while ((m = re.exec(clean)) !== null) {
    let params = {};
    try { params = JSON.parse(m[2]); } catch (e) { continue; }
    calls.push({ id: _newId(m[1]), name: m[1], params });
  }
  // 格式 2: Anthropic 风 <tool_call><invoke name="x"><action>status</action></invoke></tool_call>
  const re2 = /<tool_call>\s*<invoke name="([a-z_][a-z0-9_]*)"\s*>([\s\S]*?)<\/invoke>\s*<\/tool_call>/g;
  while ((m = re2.exec(clean)) !== null) {
    const params = {};
    const pre = /<([a-z_][a-z0-9_]*)>([\s\S]*?)<\/\1>/g;
    let pm;
    while ((pm = pre.exec(m[2])) !== null) {
      const v = pm[2].trim();
      if (v === 'true') params[pm[1]] = true;
      else if (v === 'false') params[pm[1]] = false;
      else if (/^-?\d+(\.\d+)?$/.test(v)) params[pm[1]] = Number(v);
      else params[pm[1]] = v;
    }
    calls.push({ id: _newId(m[1]), name: m[1], params });
  }
  // 2026-09-14 (老板 05:24 实案 "更废了"): MiniMax-M3 伪工具调用两种新变体 —
  //   a) 方括号乱撒: ]</invoke>]</tool_call>] (标准 re2 因 ] 失配)
  //   b) 纯中文伪调用: [调用工具: exec_command][<command>ls</command>]
  // 打捞副本只用于匹配: 把紧贴标签的 ] 剥掉后再跑正则, 原 text 不动
  const tolerant = clean.replace(/\]\s*(?=<)/g, '').replace(/(?<=>)\s*\]/g, '');
  if (tolerant !== clean) {
    const re2t = /<tool_call>\s*<invoke name="([a-z_][a-z0-9_]*)"\s*>([\s\S]*?)<\/invoke>\s*<\/tool_call>/g;
    while ((m = re2t.exec(tolerant)) !== null) {
      const params = {};
      const pre = /<([a-z_][a-z0-9_]*)>([\s\S]*?)<\/\1>/g;
      let pm;
      while ((pm = pre.exec(m[2])) !== null) { params[pm[1]] = pm[2].trim(); }
      calls.push({ id: _newId(m[1]), name: m[1], params, salvaged: true });
    }
  }
  // 格式 3: 中文伪调用 [调用工具: name] + <tag>值</tag> 参数对
  const re3 = /[【\[(（]?\s*调用工具\s*[:：]\s*([a-z_][a-z0-9_]*)\s*[\]】>）)]?([\s\S]*?)(?=[【\[(（]?\s*调用工具\s*[:：]|$)/gi;
  while ((m = re3.exec(tolerant)) !== null) {
    const params = {};
    const pre = /<([a-z_][a-z0-9_]*)>([\s\S]*?)<\/\1>/g;
    let pm;
    while ((pm = pre.exec(m[2])) !== null) { params[pm[1]] = pm[2].trim(); }
    calls.push({ id: _newId(m[1]), name: m[1], params, salvaged: true });
  }
  // 格式 4: 裸 JSON <tool_call>{"name":"x","arguments":{...}}</tool_call> (MiniMax-M3 实测)
  const re4 = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  while ((m = re4.exec(tolerant)) !== null) {
    try {
      const j = JSON.parse(m[1]);
      const name = j.name || (j.function && j.function.name);
      if (!name || !/^[a-z_][a-z0-9_]*$/i.test(name)) continue;
      const params = j.arguments || (j.function && j.function.arguments) || j.params || {};
      calls.push({ id: _newId(name), name, params: typeof params === 'string' ? JSON.parse(params) : params, salvaged: true });
    } catch (_) { /* JSON 没闭合/不合法就跳过, 剥离器负责不让孩子上屏 */ }
  }
  return calls;
}
// 2026-10-12 (probe-ctx-final-20261012-1): 模型还有一种假工具调用形态没被剥 —
// <system_info>{"metric":"all"} 这种 XML 标签裹 JSON 的。只认「小写标签 + JSON 对象
// (+ 可选闭合标签)」这一种窄形状, 正常中文答复里不会出现, 不会误伤。
const _FAKE_TOOL_JSON_TAG_RE = /<([a-z_][a-z0-9_]{1,40})>\s*\{[\s\S]{0,4000}?\}\s*<\/\1>/g;
const _FAKE_TOOL_JSON_TAG_UNCLOSED_RE = /<([a-z_][a-z0-9_]{1,40})>\s*\{[\s\S]{0,4000}?\}\s*$/;
function _stripFakeToolJsonTags(text) {
  let t = String(text || '');
  t = t.replace(_FAKE_TOOL_JSON_TAG_RE, (m, tag) => {
    console.warn('[j2-helpers] 剥掉假工具 JSON 标签: <' + tag + '>{...}</' + tag + '>');
    return ' ';
  });
  t = t.replace(_FAKE_TOOL_JSON_TAG_UNCLOSED_RE, (m, tag) => {
    console.warn('[j2-helpers] 剥掉未闭合假工具 JSON 标签: <' + tag + '>{...}');
    return ' ';
  });
  return t;
}

// 2026-10-13 (现场 session=pcheck-1791823788): 综合答案整段就是一个裸伪工具调用
//   task_done({"summary":"已核对 …20/20 文件均存在且非空…任务完成。"})
// 上面 _stripPseudoToolMarkup 原有六条规则全都要求尖括号 (<tool>/<tool_call>) 或
// "调用工具:" 字样, 裸的 name({...}) 一个都不认 → 140 字原始工具标记原样漏给用户,
// 而 status 还报 completed。
//
// 修法边界 (刻意保守):
//   ① 只处理"整段就是一个 name({JSON})"这一种形状。裸 name(...) 出现在正文中间无法与
//      正常文字区分 ("见 read_file(3)" 这类), 宁可不动。
//   ② 判据是"参数能解析成 JSON 对象" —— 正常散文里几乎不会出现 name({"k":"v"}) 这种形状。
//   ③ 剥出来之后若 JSON 里有 summary/result/text 字符串, 拿它当答复正文 (那是模型本来
//      想说的话); 拿不到就剥成空串, 交回 _finalizeAnswerText 回落子 agent 结论 ——
//      不硬造文本。
const _BARE_PSEUDO_CALL_RE = /^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\(\s*([\s\S]*?)\s*\)\s*;?\s*$/;
function _stripBarePseudoToolCall(text) {
  const t = String(text || '');
  const m = _BARE_PSEUDO_CALL_RE.exec(t);
  if (!m) return t;
  const arg = m[1].trim();
  let j = null;
  try { j = JSON.parse(arg); } catch (_) { return t; }  // 解析不了 → 不确定, 不碰
  if (!j || typeof j !== 'object' || Array.isArray(j)) return t;
  const v = j.summary != null ? j.summary : (j.result != null ? j.result : (j.text != null ? j.text : j.output));
  const out = typeof v === 'string' ? v.trim() : '';
  console.warn('[j2-helpers] 剥掉整段裸伪工具调用 name({...})' + (out ? ', 取其正文作答复' : ', 无可用正文 → 交回收口回落'));
  return out;
}

function _stripPseudoToolMarkup(text) {
  let t = _stripBarePseudoToolCall(text);
  if (!t) return '';
  t = t.replace(/<tool\s+name="[a-z_][a-z0-9_]*">[\s\S]*?<\/tool>/g, '');
  t = t.replace(/\]?\s*<tool_call>[\s\S]*?<\/tool_call>\s*\]?/g, '');
  t = t.replace(/\]?\s*<tool_call>[\s\S]*$/g, ''); // 未闭合的 <tool_call> 尾巴 (模型被截断) — 剥到结尾, 防裸 JSON 漏上屏
  t = t.replace(/[【\[(（]?\s*调用工具\s*[:：][\s\S]{0,2000}?<\/tool_call>\s*\]?/gi, '');
  t = t.replace(/[【\[(（]?\s*调用工具\s*[:：][^\n<]{0,200}/gi, ''); // 无闭合标记的单行伪调用
  t = t.replace(/\]?\s*<\/?(invoke|tool_call|command|path|query|content|url|key|question|action|arguments)(?:\s+name="[^"]*")?\s*>\s*\]?/g, '');
  t = _stripFakeToolJsonTags(t);
  return t.trim();
}

// MiniMax-M3 特殊段标/控制 token 泄漏 (实测: ]<]minimax[>[ 混进 content 上屏)
const _SPECIAL_TOKEN_RE = /\]?<\]?minimax\[?>\[?|<\|[^|]{1,40}\|>/g;
function _stripSpecialTokens(text) {
  return String(text || '').replace(_SPECIAL_TOKEN_RE, '');
}

module.exports = {
  buildAgentLegacyPrompt,
  _detectToolCallSupport,
  _extractToolCallsFromText,
  _stripPseudoToolMarkup,
  _stripFakeToolJsonTags,
  _stripSpecialTokens,
  _getToolCallSupportCache: () => _toolCallSupportCache,
  _getToolCallSupportStatus: () => _toolCallSupportStatus,
  invalidateToolCallSupportCache: () => { for (const k of Object.keys(_toolCallSupportCache)) delete _toolCallSupportCache[k]; },
};
