// W2 (2026-09-04 B 路线): j2 中间件框架 — 把横切关注点从主循环抽出
// 之前: think-strip / silent-fail / checkpoint save / evo metrics / budget 全 inline 在主循环
// 修: 拦截器模式 — 主循环只调 middleware.run(phase, ctx),具体逻辑由 middleware 决定
// W2.1 (爹接棒): 框架 + silent-fail middleware (R80 大杀手, 7/7 测试过)
// W2.2 (爹接棒): think-strip middleware (emitFinalOnce 前剥离 <think>, 已接入主循环)
// W2.3 (爹接棒): checkpoint middleware (框架就绪, 待 W2.5 接入避免双写)
// W2.4 (爹接棒): evo metrics middleware (框架就绪, 待 W2.5 接入避免双写)
'use strict';

class MiddlewareChain {
  constructor() { this._mws = []; }
  use(mw) { this._mws.push(mw); return this; }
  /**
   * 同步顺序跑所有 middleware 的 phase hook
   * @param {string} phase - 钩子名 (post-round / pre-finalize / think-strip / post-finalize / checkpoint / metrics)
   * @param {object} ctx - 共享上下文 (引用传, middleware 可改字段)
   * @returns {object} ctx (同一引用)
   */
  run(phase, ctx) {
    for (const m of this._mws) {
      if (typeof m[phase] === 'function') {
        try { m[phase](ctx); }
        catch (e) { console.warn('[j2-mw] ' + (m.name || '?') + '.' + phase + ' failed:', e.message); }
      }
    }
    return ctx;
  }
}

/**
 * Silent-fail 检测 middleware (W2.1) — 主循环响应仍走旧 inline (W2.6 合并)
 */
function createSilentFailMiddleware() {
  return {
    name: 'silent_fail',
    'post-round': function(ctx) {
      const { finalText, toolsUsed, taskDoneCalled, rounds, maxRounds, looksLikeEmptyPlan } = ctx;
      if (taskDoneCalled) return;
      const realTools = toolsUsed.filter(n => n !== 'task_done');
      const finalLen = (finalText || '').trim().length;
      if (rounds >= maxRounds - 1 && finalLen <= 20 && realTools.length === 0) {
        ctx.silentFail = { reason: 'no_tools_no_text_after_max', rounds, maxRounds };
        return;
      }
      if (toolsUsed.length > 0 && finalLen > 0 && finalLen <= 13 && realTools.length > 0) {
        ctx.silentFail = { reason: 'short_final_after_tools', len: finalLen, tools: realTools.length };
        return;
      }
      if (finalLen > 0 && typeof looksLikeEmptyPlan === 'function' && looksLikeEmptyPlan(finalText) && realTools.length === 0) {
        ctx.silentFail = { reason: 'empty_plan_final' };
      }
    },
  };
}

/**
 * Think-strip middleware (W2.2) — emitFinalOnce 前剥离 <think> 标签 + 整轮 think-only 时用 thinking 内文兜底
 */
function createThinkStripMiddleware() {
  return {
    name: 'think_strip',
    'pre-finalize': function(ctx) {
      if (!ctx.finalText || typeof ctx.finalText !== 'string') return ctx;
      const before = ctx.finalText;
      if (!before.includes('<think>')) return ctx;
      const stripped = before.replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/<think>[\s\S]*$/g, '').trim();
      if (stripped) {
        ctx.finalText = stripped;
        ctx.thinkStripped = true;
      } else if (ctx.allowThinkFallback !== false) {
        // 整轮只有 <think>, 老板标准: 有真内容就给主人看, 用 thinking 内文兜底
        ctx.finalText = before.replace(/<\/?think>/g, '').trim();
        ctx.thinkFallback = true;
        ctx.thinkStripped = true;
      }
      return ctx;
    },
  };
}

/**
 * Checkpoint middleware (W2.3) — 每 round 末保存 (fire-and-forget, 不阻塞主流程)
 * 接入待 W2.5 (避免与现有 _persistSession 双写)
 */
function createCheckpointMiddleware(opts = {}) {
  const saveCheckpoint = opts.saveCheckpoint || require('./checkpoint').saveCheckpoint;
  return {
    name: 'checkpoint',
    'post-round': function(ctx) {
      if (!ctx.sessionId || !Array.isArray(ctx.messages)) return ctx;
      try {
        saveCheckpoint(ctx.sessionId, {
          round: ctx.round || 0,
          messages: ctx.messages,
          lastToolCall: ctx.lastToolCall || null,
          planId: ctx.planId || null,
          planState: ctx.planState || null,
          taskInput: ctx.taskInput || null,
        });
        ctx.checkpointSaved = true;
      } catch (e) {
        console.warn('[j2-mw] checkpoint save failed:', e.message);
        ctx.checkpointError = e.message;
      }
      return ctx;
    },
  };
}

/**
 * Evo metrics middleware (W2.4) — 主循环末尾写 evo record (~/pangu/evolution/YYYY-MM-DD.jsonl)
 * 接入待 W2.5 (避免与现有 inline evo 写入双写)
 */
function createEvoMetricsMiddleware(opts = {}) {
  // 统一复用 L1 writer，避免 middleware 自己 append 造成双写/字段漂移。
  const recordEvolution = opts.recordEvolution || require('./evolution_record')._recordEvolution;
  return {
    name: 'evo_metrics',
    'post-finalize': function(ctx) {
      if (ctx.evoWritten) return ctx;
      const evoRec = {
        ts: new Date().toISOString(),
        endpoint: ctx.endpoint || '/api/pangu/agent/stream',
        mode: ctx.mode || 'j2-legacy',
        input: String(ctx.userInput || '').slice(0, 500),
        provider: String(ctx.model && ctx.model.provider || 'openai'),
        model: String(ctx.model && ctx.model.id),
        tool_calls_total: ctx.toolsUsed ? ctx.toolsUsed.length : 0,
        tool_names: ctx.toolsUsed || [],
        image_count: 0,
        total_chars: ctx.totalChars || (ctx.finalText ? ctx.finalText.length : 0),
        rounds: ctx.rounds || 0,
        success: ctx.evoSuccess === true || (ctx.evoSuccess !== false && ctx.runtimeStatus === 'completed'),
        runtime_status: ctx.runtimeStatus || (ctx.evoSuccess === false ? 'failed' : 'partial'),
        real_tool_calls_total: Array.isArray(ctx.toolsUsed) ? ctx.toolsUsed.filter(n => n !== 'task_done').length : 0,
        tool_args: (ctx.toolHistory || []).slice(0, 10).map(t => ({ name: t.name, args: t.args || {} })),
        duration_ms: ctx.durationMs || 0,
        error: ctx.evoError || null,
        final_text: String(ctx.finalText || '').slice(0, 1000),
      };
      try {
        recordEvolution(evoRec);
        ctx.evoWritten = true;
      } catch (e) {
        console.error('[evo-write-fail]', e.message);
        ctx.evoError = e.message;
      }
      return ctx;
    },
  };
}

module.exports = {
  MiddlewareChain,
  createSilentFailMiddleware,
  createThinkStripMiddleware,
  createCheckpointMiddleware,
  createEvoMetricsMiddleware,
};
