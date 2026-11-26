/**
 * Pangu · ErrorCode Enum + Fallback Hint Registry
 *
 * TL-2 spec: 统一工具结果错误码 (TL-2 §3 接口契约).
 * 每个 tool 出错时返 ToolResult.error.code 必须是这 8 个之一.
 *
 * 添加新 ErrorCode 步骤:
 *   1. 在 ERROR_CODES 里加一行
 *   2. 在 FALLBACK_HINTS 里给个退路提示 (LLM 看到能用)
 *   3. 在 RETRYABLE_CODES 里标记是否可重试
 *   4. 跑 tools_selftest.js 验证 schema 不破
 *
 * 用法:
 *   const { ErrorCode, FallbackHint, isRetryable, isValidErrorCode } = require('./error_codes');
 *   if (!isRetryable(err.code)) throw new Error('Non-retryable');
 */

'use strict';

// 13 个 ErrorCode 枚举 — TL-2 §3 spec 定义 + MCP 四个 (2026-10-24 第 81 批)
const ERROR_CODES = Object.freeze({
  TIMEOUT:            'TIMEOUT',             // 工具超时 (TL-4 sandbox 范围内, 这里先占位)
  PERMISSION_DENIED:  'PERMISSION_DENIED',   // sandbox 拒绝 (§0.13)
  NOT_FOUND:          'NOT_FOUND',           // 资源不存在
  INVALID_ARGS:       'INVALID_ARGS',        // 参数校验失败
  EXEC_FAILED:        'EXEC_FAILED',         // 工具执行抛错
  UNCAUGHT:           'UNCAUGHT',            // 没 catch 的异常 (silent failure 根因)
  CANCELLED:          'CANCELLED',           // 主动取消
  RATE_LIMITED:       'RATE_LIMITED',        // 限流
  HOOK_DENIED:        'HOOK_DENIED',         // PreToolUse hook 拒绝调用 (P0-#21)
  // 2026-10-24 (第 81 批): MCP 的四个码以前**不在枚举里** ——
  //   mcp_adapter 直接返回字符串码, 于是 isValidErrorCode 对任何一条 MCP 失败都判"非法码"。
  //   枚举是 ToolResult 契约的一部分 (§0.13), MCP 也是工具, 契约得一样。
  MCP_TOOL_ERROR:     'MCP_TOOL_ERROR',      // 工具层失败 (result.isError=true, 错误正文在 content)
  MCP_CALL_FAILED:    'MCP_CALL_FAILED',     // MCP 调用抛错 (JSON-RPC 层)
  MCP_SERVER_DOWN:    'MCP_SERVER_DOWN',     // MCP server 不在活跃列表
  MCP_BAD_NAME:       'MCP_BAD_NAME',        // 工具名不是 mcp__<server>__<tool>
});

// 默认可重试码 — TL-2 spec §3 RetryConfig
const RETRYABLE_CODES = new Set([
  ERROR_CODES.TIMEOUT,
  ERROR_CODES.EXEC_FAILED,
  ERROR_CODES.RATE_LIMITED,
]);

// Fallback hint registry — 给 LLM 退路建议
// key 是 ErrorCode, value 是 string hint (给 LLM 看)
const FALLBACK_HINTS = Object.freeze({
  TIMEOUT:           'Try smaller input, or split into multiple tool calls.',
  PERMISSION_DENIED: 'Try requesting approval via permission_apply, or use a different tool.',
  NOT_FOUND:         'Check path / resource name; try file_find or search_files first.',
  INVALID_ARGS:      'Re-read tool schema and adjust params.',
  EXEC_FAILED:       'Try alternative tool, or simplify the request.',
  UNCAUGHT:          'This tool crashed. Try a different approach or contact owner.',
  CANCELLED:         'Resubmit the request, or break into smaller steps.',
  RATE_LIMITED:      'Wait and retry, or use a cached result if available.',
  HOOK_DENIED:       'This call was blocked by a PreToolUse hook. Check the hook config or ask the owner to allow it.',
  MCP_TOOL_ERROR:    'The MCP server refused this call. Read the error text, then change the path/params or use an internal tool instead. Do not retry unchanged.',
  MCP_CALL_FAILED:   'The MCP server call failed. Retry once; if it still fails, use another tool.',
  MCP_SERVER_DOWN:   'That MCP server is not active right now. Use an internal tool instead.',
  MCP_BAD_NAME:      'Unknown MCP tool name. Check the tool list.',
});

// 验证 ErrorCode 是否合法 — 防止外部 tool 返回未定义 code
function isValidErrorCode(code) {
  return Object.values(ERROR_CODES).includes(code);
}

// 判断 ErrorCode 是否可重试
function isRetryable(code) {
  return RETRYABLE_CODES.has(code);
}

// 取 Fallback hint
function getFallbackHint(code) {
  return FALLBACK_HINTS[code] || 'Try a different approach or simplify the request.';
}

// 工具结果 schema 验证 (TL-2 §3 ToolResult)
function isValidToolResult(r) {
  if (!r || typeof r !== 'object') return false;
  if (typeof r.ok !== 'boolean') return false;
  // L3 fix: execution_ms 设为可选 (很多现有工具实现未显式设置; wrapToolResult 会自动注入)
  if (r.execution_ms !== undefined && typeof r.execution_ms !== 'number') return false;
  if (r.ok === true) {
    return 'result' in r;
  }
  // ok === false
  if (!r.error || typeof r.error !== 'object') return false;
  if (!isValidErrorCode(r.error.code)) return false;
  if (typeof r.error.message !== 'string') return false;
  if (typeof r.error.retryable !== 'boolean') return false;
  return true;
}

// 统一 ToolResult 包装器 — 把任意 tool output 包成 ToolResult schema
// 用法: const r = wrapToolResult(() => TOOLS.exec_command({params}))
function wrapToolResult(toolName, fn) {
  const start = Date.now();
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      // async
      return result.then(
        (data) => {
          const execution_ms = Date.now() - start;
          // 如果已经是 ToolResult 格式, 只补 execution_ms
          if (data && typeof data === 'object' && typeof data.ok === 'boolean') {
            return Object.assign({}, data, { execution_ms });
          }
          return { ok: true, result: data, execution_ms };
        },
        (err) => {
          const execution_ms = Date.now() - start;
          return { ok: false, error: buildError(toolName, err), execution_ms };
        }
      );
    }
    // sync
    const execution_ms = Date.now() - start;
    if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
      return Object.assign({}, result, { execution_ms });
    }
    return { ok: true, result, execution_ms };
  } catch (err) {
    const execution_ms = Date.now() - start;
    return { ok: false, error: buildError(toolName, err), execution_ms };
  }
}

// P0-#21: PreToolUse hook 调用点 (tool 调用前改 args 或拒绝)
// 异步 — 调用者必须 await 才有 hook 生效 (j2_agent_loop 已 wrap)
// 如果 hook 设 ctx.deny=true, 返 deny ToolResult (ok=false)
// 为了不破现有 sync 调用点, 提供异步版本 wrapToolResultWithHooks(toolName, params, fn)
async function wrapToolResultWithHooks(toolName, params, fn, hookOpts) {
  const ctx = { tool_name: toolName, params: params || {} };
  // PreToolUse: hook 可改 params / 设 deny
  try {
    const { runHooks } = require('./hooks');
    await runHooks('PreToolUse', ctx);
    if (ctx.deny) {
      const start = Date.now();
      return { ok: false, error: { code: 'HOOK_DENIED', message: ctx.reason || ctx._hookError || 'hook 拒绝调用' }, execution_ms: Date.now() - start, hook_denied: true };
    }
  } catch (e) {
    console.warn('[hook] PreToolUse run error:', e.message);
  }
  // 真调 tool (用可能被 hook 改过的 params)
  const start = Date.now();
  let result;
  try {
    result = await fn(ctx.params);
    if (result && typeof result.then === 'function') {
      result = await result;
    }
  } catch (err) {
    result = { ok: false, error: buildError(toolName, err), execution_ms: Date.now() - start };
  }
  if (!result.execution_ms) result.execution_ms = Date.now() - start;
  // PostToolUse: hook 可改 result
  try {
    const { runHooks } = require('./hooks');
    const postCtx = { tool_name: toolName, params: ctx.params, result: result.result, ok: result.ok, error: result.error, execution_ms: result.execution_ms };
    await runHooks('PostToolUse', postCtx);
    if (postCtx.result !== undefined) result.result = postCtx.result;
    if (postCtx.error !== undefined) result.error = postCtx.error;
    if (postCtx.ok !== undefined) result.ok = postCtx.ok;
  } catch (e) {
    console.warn('[hook] PostToolUse run error:', e.message);
  }
  // 2026-09-13 任务账本 (老板拍板): tool_result 的 ground truth 自动记账 —
  // 跨压缩/跨轮/跨请求存活, 治模型失忆与假路径幻觉。best-effort, 永不阻塞。
  try {
    if (hookOpts && hookOpts.sessionId) {
      require('./task_ledger').recordToolResult(hookOpts.sessionId, toolName, ctx.params, result);
    }
  } catch (_) {}
  return result;
}

// 从 thrown exception 构造 ErrorCode 兼容的 error 对象
function buildError(toolName, err) {
  const msg = (err && err.message) || String(err);
  // 启发式分类
  let code = ERROR_CODES.EXEC_FAILED;
  const lower = msg.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out')) code = ERROR_CODES.TIMEOUT;
  else if (lower.includes('permission') || lower.includes('denied') || lower.includes('not allowed')) code = ERROR_CODES.PERMISSION_DENIED;
  else if (lower.includes('not found') || lower.includes('enoent')) code = ERROR_CODES.NOT_FOUND;
  else if (lower.includes('invalid') || lower.includes('validation') || lower.includes('bad request')) code = ERROR_CODES.INVALID_ARGS;
  else if (lower.includes('rate') || lower.includes('429')) code = ERROR_CODES.RATE_LIMITED;
  else if (lower.includes('cancel')) code = ERROR_CODES.CANCELLED;
  return {
    code,
    message: `[${toolName}] ${msg}`.slice(0, 500),
    retryable: isRetryable(code),
    fallback_hint: getFallbackHint(code),
  };
}

module.exports = {
  ERROR_CODES,
  RETRYABLE_CODES,
  FALLBACK_HINTS,
  ErrorCode: ERROR_CODES,
  FallbackHint: FALLBACK_HINTS,
  isValidErrorCode,
  wrapToolResultWithHooks,
  isRetryable,
  getFallbackHint,
  isValidToolResult,
  wrapToolResult,
  buildError,
};
// =========================================================================
// §0.64 (爹接棒 W4): Agent-level Error Taxonomy — 主循环错误分级 + 策略表
// 跟上面 tool-level ERROR_CODES 平行, 不冲突
// =========================================================================

// Agent-level 错误码 — 主循环 (LLM 推理 / tool 编排 / session) 错误
const AGENT_ERROR_CODES = Object.freeze({
  LLM_ROUND_TIMEOUT:     'LLM_ROUND_TIMEOUT',     // 单 round 超时 (R18 idle/total)
  LLM_STREAM_TIMEOUT:    'LLM_STREAM_TIMEOUT',    // stream 整轮超时 (R18 total)
  LLM_QUOTA_EXCEEDED:    'LLM_QUOTA_EXCEEDED',    // 配额耗尽 / 429
  LLM_INFRA_ERROR:       'LLM_INFRA_ERROR',       // 5xx / 网络 / DNS
  LLM_INVALID_RESPONSE:  'LLM_INVALID_RESPONSE',  // 解析失败 / 空 content / 错协议
  SILENT_FAILURE:        'SILENT_FAILURE',        // loop 跑完没真东西 (R80)
  FOUNTAIN_DETECTED:     'FOUNTAIN_DETECTED',     // 喷泉检测 (R80 BUG #12)
  CHECKPOINT_LOAD_FAIL:  'CHECKPOINT_LOAD_FAIL',  // 续跑失败
  ABORTED_BY_USER:       'ABORTED_BY_USER',       // §0.57 新问题打断
  PERMISSION_DENIED:     'PERMISSION_DENIED',     // 危险工具拦截
  HOOK_DENIED:           'HOOK_DENIED',           // PreToolUse hook 拒绝
  CONTEXT_EXHAUSTED:     'CONTEXT_EXHAUSTED',     // context window 用完
  MAX_ROUNDS_REACHED:    'MAX_ROUNDS_REACHED',    // 达到 maxRounds 上限
  EMPTY_PLAN_EXHAUSTED:  'EMPTY_PLAN_EXHAUSTED',  // 空计划模板熔断 (R80)
});

// 错误 → 响应策略
// retry: 是否自动重试 (同一模型)
// fallback: 失败时如何处理 (model_chain / abort / graceful / silent)
// maxAttempts: 同错误最大尝试次数 (避免无限循环)
// userMessage: 是否告诉用户 (诚实失败 vs 静默降级)
const AGENT_ERROR_STRATEGY = Object.freeze({
  [AGENT_ERROR_CODES.LLM_ROUND_TIMEOUT]:    { retry: true,  fallback: 'model_chain', maxAttempts: 2, userMessage: true,  hint: '当前模型响应慢, 已尝试切换备选模型' },
  [AGENT_ERROR_CODES.LLM_STREAM_TIMEOUT]:   { retry: true,  fallback: 'model_chain', maxAttempts: 2, userMessage: true,  hint: '当前模型流式输出超时, 已切换' },
  [AGENT_ERROR_CODES.LLM_QUOTA_EXCEEDED]:   { retry: false, fallback: 'model_chain', maxAttempts: 3, userMessage: true,  hint: '当前模型配额耗尽, 切换备选' },
  [AGENT_ERROR_CODES.LLM_INFRA_ERROR]:      { retry: true,  fallback: 'model_chain', maxAttempts: 2, userMessage: false, hint: '上游基础设施临时故障, 已自动重试' },
  [AGENT_ERROR_CODES.LLM_INVALID_RESPONSE]: { retry: true,  fallback: 'model_chain', maxAttempts: 2, userMessage: false, hint: '当前模型响应异常, 切换备选' },
  [AGENT_ERROR_CODES.SILENT_FAILURE]:       { retry: false, fallback: 'graceful',    maxAttempts: 0, userMessage: true,  hint: '模型连续多轮无实质输出, 我没能完成这次任务' },
  [AGENT_ERROR_CODES.FOUNTAIN_DETECTED]:    { retry: false, fallback: 'abort',       maxAttempts: 0, userMessage: true,  hint: '检测到内容喷泉 (重复输出), 已熔断' },
  [AGENT_ERROR_CODES.CHECKPOINT_LOAD_FAIL]: { retry: false, fallback: 'graceful',    maxAttempts: 0, userMessage: false, hint: '会话恢复失败, 从头开始' },
  [AGENT_ERROR_CODES.ABORTED_BY_USER]:      { retry: false, fallback: 'graceful',    maxAttempts: 0, userMessage: false, hint: '新问题已到达, 旧 round 中断' },
  [AGENT_ERROR_CODES.PERMISSION_DENIED]:    { retry: false, fallback: 'silent',      maxAttempts: 0, userMessage: true,  hint: '工具调用被权限检查拒绝' },
  [AGENT_ERROR_CODES.HOOK_DENIED]:          { retry: false, fallback: 'silent',      maxAttempts: 0, userMessage: true,  hint: '工具调用被 PreToolUse hook 拒绝' },
  [AGENT_ERROR_CODES.CONTEXT_EXHAUSTED]:    { retry: false, fallback: 'graceful',    maxAttempts: 0, userMessage: true,  hint: '上下文已满, 建议拆任务' },
  [AGENT_ERROR_CODES.MAX_ROUNDS_REACHED]:   { retry: false, fallback: 'graceful',    maxAttempts: 0, userMessage: true,  hint: '达到最大轮数限制' },
  [AGENT_ERROR_CODES.EMPTY_PLAN_EXHAUSTED]: { retry: false, fallback: 'abort',       maxAttempts: 0, userMessage: true,  hint: '模型反复输出空计划不调工具, 已熔断' },
});

// 取错误策略
function getAgentStrategy(code) {
  return AGENT_ERROR_STRATEGY[code] || { retry: false, fallback: 'silent', maxAttempts: 0, userMessage: false, hint: 'Unknown error' };
}

// 记录 agent 错误 — 用于 stats + 后续 router 降权
function classifyAgentError(err, ctx = {}) {
  if (!err) return null;
  // 字符串 code 直接用
  if (typeof err === 'string' && AGENT_ERROR_STRATEGY[err]) {
    return { code: err, ...getAgentStrategy(err), ctx };
  }
  // Error 对象: 根据 message / status 推
  const msg = String(err.message || err).toLowerCase();
  if (msg.includes('quota') || msg.includes('rate limit') || msg.includes('429')) return { code: AGENT_ERROR_CODES.LLM_QUOTA_EXCEEDED, ...getAgentStrategy(AGENT_ERROR_CODES.LLM_QUOTA_EXCEEDED), ctx, source: err.message };
  if (msg.includes('timeout') || msg.includes('aborted')) return { code: AGENT_ERROR_CODES.LLM_ROUND_TIMEOUT, ...getAgentStrategy(AGENT_ERROR_CODES.LLM_ROUND_TIMEOUT), ctx, source: err.message };
  if (msg.includes('5xx') || msg.includes('econnrefused') || msg.includes('enotfound')) return { code: AGENT_ERROR_CODES.LLM_INFRA_ERROR, ...getAgentStrategy(AGENT_ERROR_CODES.LLM_INFRA_ERROR), ctx, source: err.message };
  return { code: AGENT_ERROR_CODES.LLM_INVALID_RESPONSE, ...getAgentStrategy(AGENT_ERROR_CODES.LLM_INVALID_RESPONSE), ctx, source: err.message };
}

module.exports.AGENT_ERROR_CODES = AGENT_ERROR_CODES;
module.exports.AGENT_ERROR_STRATEGY = AGENT_ERROR_STRATEGY;
module.exports.getAgentStrategy = getAgentStrategy;
module.exports.classifyAgentError = classifyAgentError;
