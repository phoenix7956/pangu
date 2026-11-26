'use strict';

/**
 * modules/sse_text_collector.js
 * 把 agent loop 的 **SSE 输出**收成一段文本 —— 给「要 JSON 不要 SSE」的兼容端点用。
 *
 * ── 为什么需要它 (2026-10-26 第 106 批) ────────────────────────
 * 遗留端点 `/message` `/chat` `/api/chat` 的契约是
 *   `{ok:true, choices:[{message:{role:'assistant', content}}]}`
 * 而 agent loop (`j2_agent_loop._runAgentLoopLegacyStream`) 只吐 SSE。
 * 老代码里有一段「把 SSE 伪装成 JSON」的收集器, 但它**从写下那天起就没被执行过**
 * (源码里是 `if (false && runJ2 && …)`), 而且它认的事件名是错的:
 *
 *   老收集器认:  `event: chunk` + `data.delta`
 *   真实契约是:  `event: stream_delta` + `data.delta` / `data.accumulated`
 *                `event: final`      + `data.text`   ← **权威稿**
 *                `event: done`       + `data.result` ← 失败时是错误说明, 不是答案
 *                `event: error`      + `data.error`
 *
 * ⇒ 老收集器就算被打开, 收到的也是**空字符串**。
 *
 * ── 本模块的取值顺序 (权威优先) ────────────────────────────────
 *   1. `final.text`        —— 服务端后处理过的**权威稿** (第 75 批: 处理后可能更短,
 *                             前端有「流式更长就不换」的经验规则, 所以以它为准)
 *   2. `stream_delta.accumulated` —— 流式累积的可见正文 (没有 final 时的兜底)
 *   3. 都没有 ⇒ 空字符串 (由调用方决定怎么办, **本模块不编答案**)
 *
 * ⚠ **错误信号不等于答案**:
 *   - `status` 事件 (`{status:'done'|'failed'|'aborted', reason}`) 是**真实**的收口信号
 *     (j2_agent_loop.js:5985 往前) —— 失败时 `reason` 是错误说明, 只进 `getError()`。
 *     ⚠ **`failed` 不等于「没答上来」**: loop 没调 `task_done` 时 verdict 也是 `failed`
 *       (完成度不足), 但正文可能是好的 ⇒ 状态与错误说明**分两个字段**报,
 *       别拿「failed」推导出「答复不可用」。
 *   - `done` 事件的真实 payload 是 `{rounds, tools_used, total_chars, model_used, …}`
 *     —— **没有** `status`/`result` 字段。但 `done.status==='failed'` + `done.result`
 *     这条形状仍按「错误说明」处理 (防御: 万一上游某个版本带上了)。
 *   - 拿错误说明当答复 = 把错误提示当答案上屏。
 *
 * ── 为什么单独一个模块 ────────────────────────────────────────
 *   「SSE 长什么样」是**契约**, 归它自己; 端点只负责「拿到文本之后怎么办」。
 *   两件事混在一个 handler 里 ⇒ 改契约要翻端点, 测端点要起真服务。
 */

/**
 * 造一个收集器。
 * @returns {{res: object, getText: () => string, getError: () => string, getEvents: () => object}}
 */
function createSseCollector() {
  let buffer = '';
  let finalText = '';      // event: final 的 text (权威稿)
  let deltaText = '';      // event: stream_delta 累积出来的正文
  let lastError = '';      // event: error 的 error, 或 done.status=failed 时的说明
  let finalStatus = '';    // event: status 的 status ('done'|'failed'|'aborted')
  const counts = Object.create(null);   // 各事件名出现次数 (诊断用)

  function _handleFrame(frame) {
    if (!frame) return;
    let ev = 'message';
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (!line || line.charAt(0) === ':') continue;   // 注释行 / 心跳 (`: keepalive`)
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length) return;
    counts[ev] = (counts[ev] || 0) + 1;
    let data;
    try { data = JSON.parse(dataLines.join('\n')); } catch (_) { return; }
    if (!data || typeof data !== 'object') return;
    if (ev === 'final') {
      if (typeof data.text === 'string') finalText = data.text;
      return;
    }
    if (ev === 'stream_delta') {
      if (typeof data.accumulated === 'string') deltaText = data.accumulated;
      else if (typeof data.delta === 'string') deltaText += data.delta;
      return;
    }
    if (ev === 'error') {
      if (typeof data.error === 'string' && data.error) lastError = data.error;
      else if (typeof data.message === 'string' && data.message) lastError = data.message;
      return;
    }
    if (ev === 'done') {
      // ⚠ done.result 是**错误说明**时不能当答案 (见文件头)
      if (data.status === 'failed' && typeof data.result === 'string' && data.result) {
        lastError = lastError || data.result;
      }
      return;
    }
    if (ev === 'status') {
      // 真实收口信号 (j2_agent_loop.js:5985 前的 status 事件):
      //   { status: 'done'|'failed'|'aborted', reason, duration_ms, rounds, … }
      // failed / aborted 时 reason 是错误说明 —— 只进 getError(), 绝不当答案。
      if (typeof data.status === 'string' && data.status) finalStatus = data.status;
      if ((data.status === 'failed' || data.status === 'aborted')) {
        const why = typeof data.reason === 'string' && data.reason
          ? data.reason
          : (typeof data.error === 'string' && data.error ? data.error : '');
        // ⚠ 没有 reason 就**不编**错误说明 (「failed」只说明状态, 不说明出了什么错)
        //   —— 之前这里兜了个 'AGENT_FAILED', 结果「答对了但 loop 没调 task_done」
        //   也被报成错误, 误导客户端。
        lastError = lastError || why;
      }
    }
  }

  const res = {
    // agent loop 读写的两个状态位 (j2_loop_shared._emitStreamDelta / _startPrefillProgress)
    __panguVisibleLen: 0,
    _prefillAccum: null,
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    writeHead(status) { this.statusCode = status || 200; this.headersSent = true; },
    setHeader() { /* 兼容端点自己发头, 这里不发 */ },
    getHeader() { return undefined; },
    removeHeader() { /* noop */ },
    write(chunk) {
      buffer += String(chunk == null ? '' : chunk);
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        _handleFrame(frame);
      }
      return true;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.write(chunk);
      if (buffer) { _handleFrame(buffer); buffer = ''; }
      this.writableEnded = true;
      return this;
    },
    // agent loop 会挂 close/error 监听 (j2_loop_shared._startPrefillProgress) —— 收下就行
    on() { return this; },
    once() { return this; },
    off() { return this; },
    removeListener() { return this; },
    emit() { return false; },
    flushHeaders() { /* noop */ },
  };

  return {
    res,
    getText() { return String(finalText || deltaText || '').trim(); },
    getError() { return String(lastError || '').trim(); },
    getStatus() { return String(finalStatus || '').trim(); },
    getEvents() { return Object.assign({}, counts); },
  };
}

module.exports = { createSseCollector };

