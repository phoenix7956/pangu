/**
 * modules/streaming_tool_executor.js
 * 盘古 · StreamingToolExecutor (借鉴 #2)
 *
 * 借鉴 Claude Code Leaked §9.2 (StreamingToolExecutor.ts:80-230)
 * 简化版(适配 Pangu agent_loop.js):
 *   - safe 工具并行(Promise.all, 错误隔离)
 *   - unsafe 工具串行(等 safe 全完后, 一只只跑)
 * safe tool 抛错 → 不影响其他 safe siblings (与 Claude Code 不同, 板 "error 单独聚合")
 *   - unsafe tool 抛错 → 记录, 继续跑下一个 unsafe
 *
 * 设计原则:
 *   - 默认 unsafe (conservative)
 *   - 工具通过 fn._concurrency = "safe" | "unsafe" 标记
 *   - executeFn 由 AgentLoop 注入 (闭包, 持有 messages / turn / eventBus)
 *   - runAll 返回按 addTool 顺序排列的结果数组 (LLM messages 顺序保留)
 */

'use strict';

const SAFE = 'safe';
const UNSAFE = 'unsafe';

/**
 * 判定工具是否可并发执行
 * @param {Object} tools - AgentLoop 的 tools 字典 { name: fn, ... }
 * @param {string} name - 工具名
 * @returns {boolean} true = safe (可并发), false = unsafe (需串行)
 */
function isConcurrencySafe(tools, name) {
  if (!tools || !name) return false;
  const fn = tools[name];
  if (!fn) return false;
  if (fn._concurrency === SAFE) return true;
  if (fn._concurrency === UNSAFE) return false;
 // 默认 unsafe (conservative, 板 )
  return false;
}

class TrackedTool {
  constructor(toolCall, isSafe) {
    this.toolCall = toolCall;       // { id, name, arguments }
    this.isSafe = isSafe;
    this.status = 'pending';        // pending | running | completed | error
    this.result = null;             // success output
    this.error = null;              // error message
    this.startedAt = null;
    this.finishedAt = null;
  }
}

class StreamingToolExecutor {
  /**
   * @param {Object} cfg
   * @param {Object} cfg.tools - AgentLoop 的 tools 字典
   * @param {Function} cfg.executeFn - async (toolCall) => result_or_throws
   */
  constructor({ tools, executeFn }) {
    if (!tools) throw new Error('StreamingToolExecutor: tools required');
    if (typeof executeFn !== 'function') throw new Error('StreamingToolExecutor: executeFn must be function');
    this.tools = tools;
    this.executeFn = executeFn;
    this.tracked = [];
  }

  /**
   * 添加工具到批次
   * @param {Object} toolCall - { id, name, arguments }
   * @returns {TrackedTool}
   */
  addTool(toolCall) {
    const safe = isConcurrencySafe(this.tools, toolCall.name);
    const t = new TrackedTool(toolCall, safe);
    this.tracked.push(t);
    return t;
  }

  /**
   * 执行所有已添加工具
   * Phase 1: 所有 safe 工具并行 (Promise.all, 错误隔离)
   * Phase 2: 所有 unsafe 工具串行 (按 addTool 顺序, 一只只跑)
   *
   * @returns {Promise<TrackedTool[]>} 按 addTool 顺序返回
   */
  async runAll() {
    const safeTasks = this.tracked.filter(t => t.isSafe);
    const unsafeTasks = this.tracked.filter(t => !t.isSafe);

    // ── Phase 1: safe 并行 ──
    if (safeTasks.length > 0) {
      await Promise.all(safeTasks.map(t => this._runOne(t, /* isolate */ true)));
    }

    // ── Phase 2: unsafe 串行 (在 safe 全完后开始) ──
    for (const t of unsafeTasks) {
      await this._runOne(t, /* isolate */ false);
    }

    return this.tracked;
  }

  /**
   * 跑单个工具 (内部)
   * @param {TrackedTool} t
   * @param {boolean} isolate - true = safe (错误隔离), false = unsafe (错误透传, 但仍记到 t.error)
   */
  async _runOne(t, isolate) {
    t.status = 'running';
    t.startedAt = Date.now();
    try {
      t.result = await this.executeFn(t.toolCall);
      t.status = 'completed';
    } catch (err) {
      t.error = (err && err.message) || String(err);
      t.status = 'error';
      // safe 工具: 错误隔离, 不影响其他 siblings
      // unsafe 工具: 错误也只记到自己头上, 继续跑下一个 unsafe (保持原串行语义)
      if (!isolate) {
        // unsafe: 仍继续, 不 rethrow
      }
    } finally {
      t.finishedAt = Date.now();
    }
  }

  // ── 诊断 ──
  summary() {
    return this.tracked.map(t => ({
      id: t.toolCall.id,
      name: t.toolCall.name,
      isSafe: t.isSafe,
      status: t.status,
      duration_ms: t.startedAt && t.finishedAt ? t.finishedAt - t.startedAt : null,
      hasError: !!t.error,
    }));
  }

  // 静态便捷方法
  static isConcurrencySafe(tools, name) {
    return isConcurrencySafe(tools, name);
  }
}

module.exports = { StreamingToolExecutor, isConcurrencySafe, SAFE, UNSAFE };
