// W1.x (2026-09-04 B 路线): Plan Gate State Machine — 集中托管所有 inline guard
// 抽 j2_agent_loop.js 里散落的 EMPTY_PLAN_GUARD / THINK_ONLY / PROMISE_ZERO_TOOLS / FOUNTAIN / UNVERIFIED_CLAIM / REASONING_ONLY
// 之前散在主循环, 每加一个维度就 inline if, 补丁叠补丁 — 这是「反复打补丁」根因之一
// W1.1 = EMPTY_PLAN; W1.2 = THINK_ONLY; W1.3 = PROMISE; W1.4 = FOUNTAIN; W1.5 = UNVERIFIED; W1.6 = REASONING
// W1.1 双轨: SM 接管 + 旧 inline 兜底, 跑稳后 W1.7 合并清理
// emit 由 ctx 传入 (不再绑 factory), SM 是纯函数 + per-request 创建, 避免 res leak + 计数器串扰
// 用法:
//   const gate = createPlanGate({ maxNudges: EMPTY_PLAN_MAX_NUDGES });
//   const decision = gate.check({ textContent, toolsUsed, round, maxRounds, emit, reasoningContent });
//   if (decision.action === 'nudge') { /* 推送 nudge 后 continue */ }
//   if (decision.action === 'break')  { /* break */ }
//   if (decision.action === 'pass')   { /* 继续 */

'use strict';

const RULE_KIND = {
  EMPTY_PLAN: 'empty_plan',
  THINK_ONLY: 'think_only',
  PROMISE: 'promise',
  UNVERIFIED: 'unverified',
  REASONING: 'reasoning',
  FOUNTAIN: 'fountain',
  TOOL_LOCK_CLAIM: 'tool_lock_claim',
};

const PROMISE_RE = /让我|我来|我先|我会|接下来|继续深入|继续读|继续看|继续调|系统性|全部读|读完|全读|搜一下|先调(?:工具|子)?|立即补上|这就去|马上调|下面调|现在调|动手调|先查|先并发|先拉|摸清|探针|再补/;
const UNVERIFIED_RE = /(?:已经|已成功|已修复|已启动|已完成|成功启动|正在运行|已经恢复|已加载|已部署|已配置|已生效)(?:[^\s。，,.;；:：\n]{1,})?/;
const STEP_PATTERN = /第\s*[一二三四五六七八九十0-9]+\s*步|步骤\s*[一二三四五六七八九十0-9]+|Step\s*[0-9]+|^[\s]*[-*]\s+/m;
const TOOL_LOCK_CLAIM_RE = /(?:工具|tool).{0,10}(?:锁(?:了|死)?|被禁|不可用|不能调)|(?:system|系统).{0,16}(?:禁止|不让).{0,16}(?:调|调用).{0,10}(?:工具|tool)/i;

function _isEmptyPlan(text) {
  if (!text || typeof text !== 'string') return false;
  return STEP_PATTERN.test(text) && !text.includes('<tool') && !text.includes('<tool_call>');
}

// W1.2: 整轮只有 <think> 没正文 — 思考烧完预算, 0 字 0 工具
function _isThinkOnly(text) {
  if (!text || typeof text !== 'string') return false;
  if (!text.includes('<think>')) return false;
  const stripped = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/<think>[\s\S]*$/g, '').trim();
  return !stripped;
}

// W1.3: 0 工具承诺轮 — 模型复读"让我/我来/继续..." (老板截图实证)
function _isPromise(text) {
  if (!text || typeof text !== 'string') return false;
  return PROMISE_RE.test(text);
}

// W1.5: 未验证系统状态断言 — 模型说"已启动/已恢复/已修复"但 0 工具调用 (反幻觉)
function _isUnverified(text) {
  if (!text || typeof text !== 'string') return false;
  return UNVERIFIED_RE.test(text);
}

function _isToolLockClaim(text) {
  return typeof text === 'string' && TOOL_LOCK_CLAIM_RE.test(text);
}

// W1.6: reasoning_content 路径 — Anthropic / OpenAI o1 类模型, 推理字段单独存在
// 由 j2_agent_loop 算 _hasReasoningOnly (line 560) 传 boolean — 只看 flag, 不再看 textContent 长度
// (textContent 兜底成 reasoning_content 后已非空, 长度不能区分 reasoning-only vs 真答案)
function _isReasoningOnly(hasReasoningOnly) {
  return hasReasoningOnly === true;
}

function createPlanGate(opts = {}) {
  const maxNudges = opts.maxNudges != null ? opts.maxNudges : 2;
  const _counters = new Map();
  // FOUNTAIN 用外部 state 跨 check, 这里不维护

  function _bump(kind) {
    const c = (_counters.get(kind) || 0) + 1;
    _counters.set(kind, c);
    return c;
  }

  function _emitWarning(w, emit) {
    try {
      (emit || (() => {}))('event: warning\ndata: ' + JSON.stringify({ warning: w }) + '\n\n');
    } catch (_) {}
  }

  return {
    check(ctx) {
      const { textContent = '', toolsUsed = [], round = 0, maxRounds = 1, emit, hasReasoningOnly = false, fountainRes = null } = ctx;
      const noRealTools = toolsUsed.filter(n => n !== 'task_done').length === 0;

      // 规则按严重度排序: 反幻觉 / 喷泉 > 承诺 > 推理 > 空计划 > think-only

      // A model may invent that tools are locked after simply failing to emit a
      // tool call. No tool error means this is an unsupported system claim, not
      // a valid blocker.
      if (_isToolLockClaim(textContent) && noRealTools) {
        const count = _counters.get(RULE_KIND.TOOL_LOCK_CLAIM) || 0;
        if (count < 1 && round < maxRounds - 1) {
          const c = _bump(RULE_KIND.TOOL_LOCK_CLAIM);
          _emitWarning('R80-TOOL-LOCK-CLAIM: 0 工具却声称工具被锁，已拒绝该无证据阻塞理由', emit);
          return {
            action: 'nudge',
            rule: RULE_KIND.TOOL_LOCK_CLAIM,
            count: c,
            message: '[SYSTEM WARNING] 本轮没有任何工具调用或工具错误，因此“工具锁了 / system 禁止调工具”是未经证实的说法。工具仍可用。禁止再引用此理由；下一轮直接调用适当工具执行当前任务。',
          };
        }
        return {
          action: 'break',
          rule: RULE_KIND.TOOL_LOCK_CLAIM,
          count,
          message: '模型连续未发起工具调用，任务没有执行；已拒绝把无证据的系统阻塞理由展示给用户。',
        };
      }

      // W1.5 UNVERIFIED: 反幻觉钩子③ — 未验证系统状态断言
      if (_isUnverified(textContent) && noRealTools) {
        const count = _counters.get(RULE_KIND.UNVERIFIED) || 0;
        // 2026-09-18 修: 上限 1→3. 旧逻辑 nudge 1 次后静默跳过 (fall through 到 loop 下一轮),
        // 下一轮 lip-service 接手时 resDone 没闭合 → SSE spinner 永远转 (会话 66155987 卡死实案).
        // 3 次足够逼模型真调工具; 耗尽后 break + 发 final 事件闭合 SSE.
        if (count < 3 && round < maxRounds - 1) {
          const c = _bump(RULE_KIND.UNVERIFIED);
          _emitWarning('R80-UNVERIFIED: 未验证系统状态断言 (0 工具调用), 已要求先验证再说', emit);
          return {
            action: 'nudge',
            rule: RULE_KIND.UNVERIFIED,
            count: c,
            message: '[SYSTEM WARNING] 你刚才断言系统状态 ("已启动/已恢复/已修复" 之类), 但这一轮 0 工具调用 — 你是猜的。禁止基于猜测输出系统状态, 下一轮要么先调工具 (exec_command / read_file) 验证, 要么用 "我推测" 等不确定措辞。',
          };
        } else {
          // 2026-09-18: UNVERIFIED 耗尽 → break + 闭合 SSE (不发 final 前端 spinner 永远转)
          _emitWarning('R80-UNVERIFIED: 3 次 nudge 后模型仍 0 工具调用, 熔断', emit);
          return {
            action: 'break',
            rule: RULE_KIND.UNVERIFIED,
            count,
            message: '[UNVERIFIED 熔断] 3 轮 nudge 后仍 0 工具调用 — 任务没有真执行. 建议: 重发指令或拆成单步 (例: "先 ls <语料库目录>/课程资料").',
          };
        }
      }

      // W1.4 FOUNTAIN: 内容指纹去重 (跨 check, 由外部 _j2DetectFountain 算出 fountainRes 传入)
      if (fountainRes && fountainRes.repeat) {
        _emitWarning('FOUNTAIN: 检测到 ' + fountainRes.count + ' 次内容重复, 已熔断', emit);
        return {
          action: 'break',
          rule: RULE_KIND.FOUNTAIN,
          count: fountainRes.count,
          message: '[SYSTEM_GUARD] 检测到内容喷泉 (重复 ' + fountainRes.count + ' 次, 阈值 ' + (fountainRes.threshold || '?') + ') — 你被自动熔断, 不要复读, 请用不同方法回答或诚实 task_done。',
        };
      }

      // W1.3 PROMISE: 0 工具承诺轮
      if (_isPromise(textContent) && textContent.length < 200 && noRealTools) {
        const count = _counters.get(RULE_KIND.PROMISE) || 0;
        if (count < 2 && round < maxRounds - 1) {
          const c = _bump(RULE_KIND.PROMISE);
          _emitWarning('R80-PROMISE: 0 工具 + 承诺旁白, 已要求直接调工具', emit);
          return {
            action: 'nudge',
            rule: RULE_KIND.PROMISE,
            count: c,
            message: '[SYSTEM WARNING] 你上一轮只说 "让我/我来/继续..." 但一个工具都没调 — 这是光说不做。禁止再输出承诺/计划/旁白, 下一轮必须直接调用工具 (read_file / list_directory / exec_command) 拿真数据, 或者直接给出完整答案。',
          };
        }
      }

      // W1.6 REASONING: reasoning_content 路径 (Anthropic / OpenAI o1) — hasReasoningOnly 由 j2 算出
      if (_isReasoningOnly(hasReasoningOnly) && noRealTools) {
        const count = _counters.get(RULE_KIND.REASONING) || 0;
        if (count < maxNudges && round < maxRounds - 1) {
          const c = _bump(RULE_KIND.REASONING);
          _emitWarning('R80-REASONING: reasoning_content 单独存在, 0 正文 0 工具, 已要求压缩', emit);
          return {
            action: 'nudge',
            rule: RULE_KIND.REASONING,
            count: c,
            message: '[SYSTEM WARNING] 你上一轮推理字段 (reasoning_content) 很长, 但正文/工具都没出来 (推理烧完了输出预算)。下一轮: 推理压到 3 步以内, 直接输出正文答案或调用工具。',
          };
        }
      }

      // W1.1 EMPTY_PLAN
      if (_isEmptyPlan(textContent) && noRealTools) {
        const count = _counters.get(RULE_KIND.EMPTY_PLAN) || 0;
        if (count < maxNudges && round < maxRounds - 1) {
          const c = _bump(RULE_KIND.EMPTY_PLAN);
          _emitWarning('R80: 检测到空计划模板 (0 工具调用), 已要求直接执行.', emit);
          return {
            action: 'nudge',
            rule: RULE_KIND.EMPTY_PLAN,
            count: c,
            message: '[SYSTEM WARNING] 你刚才只输出了计划模板 (第N步...), 一个工具都没调。主人已经拍板让你动手 — 禁止再列步骤, 下一轮必须直接 tool_call 真执行 (read_file / exec_command / write_file 等)。再输出空计划 = 任务失败。',
          };
        }
      }

      // W1.2 THINK_ONLY
      if (_isThinkOnly(textContent) && noRealTools) {
        const count = _counters.get(RULE_KIND.THINK_ONLY) || 0;
        if (count < maxNudges && round < maxRounds - 1) {
          const c = _bump(RULE_KIND.THINK_ONLY);
          _emitWarning('R80-THINK_ONLY: 整轮只有 <think>, 0 正文 0 工具, 已要求压缩思考.', emit);
          return {
            action: 'nudge',
            rule: RULE_KIND.THINK_ONLY,
            count: c,
            message: '[SYSTEM WARNING] 你上一轮的输出只有 <think> 思考, 正文一个字都没有 (思考太长烧完了输出预算)。下一轮: 思考压到 3 行以内, 直接输出正文答案或调用工具。',
          };
        }
      }

      return { action: 'pass' };
    },

    snapshot() {
      return { counters: Object.fromEntries(_counters) };
    },
  };
}

module.exports = { createPlanGate, RULE_KIND, _isEmptyPlan, _isThinkOnly, _isPromise, _isUnverified, _isToolLockClaim, _isReasoningOnly };
