// pangu-single/sse/sse-utils.js
// SSE 流式响应工具
'use strict';

const safeGuard = require('../safe-guard/global');

const SSE_HEARTBEAT_MS = 5000;

function sendEvent(res, event, data) {
  if (!res || res.writableEnded || res.destroyed) return false;
  try {
    let payload = typeof data === 'string' ? data : JSON.stringify(data);
    payload = payload.replace(/\n/g, '\\n').replace(/\r/g, '');
    res.write(`event: ${event}\ndata: ${payload}\n\n`);
    return true;
  } catch (e) {
    safeGuard.writeCrash('sse-send-error', e);
    return false;
  }
}

function sendComment(res, text) {
  return sendEvent(res, 'comment', `: ${text}`);
}

function setupHeartbeat(res, intervalMs = SSE_HEARTBEAT_MS) {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    sendEvent(res, 'heartbeat', { ts: Date.now() });
  }, intervalMs);

  res.on('close', () => {
    clearInterval(timer);
  });

  res.on('error', (err) => {
    safeGuard.writeCrash('sse-response-error', err);
    clearInterval(timer);
  });

  return timer;
}

function finalizeStream(res, finalEvent = 'done', finalData = {}) {
  try {
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
    }
    sendEvent(res, finalEvent, finalData);
    res.end();
  } catch (e) {
    safeGuard.writeCrash('sse-finalize-error', e);
  }
}

module.exports = {
  sendEvent,
  sendComment,
  setupHeartbeat,
  finalizeStream,
  SSE_HEARTBEAT_MS,
};
