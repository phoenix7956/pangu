// modules/sse_slots.js — N5 refactor batch B3-Phase 1
// SSE 并发连接数限制 (防 Pangu 雪崩)
// 依赖：零外部状态 — _sseInFlight 是模块级 var
// 用法: const sse = require('./modules/sse_slots'); if (!sse.tryAcquire(res)) return; res.on('close', sse.release);

const MAX_SSE_CONNECTIONS = 16;
let _sseInFlight = 0;

function tryAcquire(res) {
  if (_sseInFlight >= MAX_SSE_CONNECTIONS) {
    if (res && !res.headersSent) {
      try {
        res.writeHead(503, {'Content-Type': 'application/json'});
      } catch (_) {}
    }
    try {
      res.end(JSON.stringify({ok: false, error: 'SSE_LIMIT_EXCEEDED', in_flight: _sseInFlight, max: MAX_SSE_CONNECTIONS}));
    } catch (_) {}
    return false;
  }
  _sseInFlight++;
  return true;
}

function release() {
  _sseInFlight = Math.max(0, _sseInFlight - 1);
}

function inFlight() {
  return _sseInFlight;
}

module.exports = { tryAcquire, release, inFlight, MAX_SSE_CONNECTIONS };