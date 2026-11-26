// modules/startup.js — N5 refactor batch B4-Phase 2
// Server startup + graceful shutdown + init dependencies wiring
// 接收 init(deps) + startup({ server, ... }) 函数
// deps: { server, port, bindHost, initPanguAgents, startPanguEvolutionLoops, env_detect_fn, llm_warmup_fn,
        //  inlineRouter, httpServer, j2AgentLoop, j2Dispatcher, j2Helpers,
        //  gracefulShutdown signal handlers etc. }

function attachGracefulShutdown(server, exitTimeoutMs = 8000) {
  let shuttingDown = false;
  return function (signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, closing server gracefully (max ${exitTimeoutMs/1000}s)...`);
    server.close((err) => {
      if (err) console.error('[shutdown] server.close error:', err.message);
      console.log('[shutdown] all requests done, exiting');
      process.exit(0);
    });
    setTimeout(() => {
      console.warn(`[shutdown] timeout ${exitTimeoutMs/1000}s, force exit`);
      process.exit(0);
    }, exitTimeoutMs).unref();
  };
}

module.exports = { attachGracefulShutdown };
