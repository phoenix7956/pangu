// pangu-single/routes/message-stream.js
// /message/stream SSE 路由
// 主对话流必须走 J2 agent-loop (调工具) 才能"做事",
//   否则 LLM 单次只答空话("主人要测什么?") — 接到 runAgentLoop callback 后默认开
'use strict';

const safeGuard = require('../safe-guard/global');
const sseUtils = require('../sse/sse-utils');
const { guardAnswer, resolveTaskInput } = require('../../modules/answer_alignment');
function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    chars += content.length + 20;
  }
  return Math.ceil(chars * 0.35);
}

// 2026-09-14 (老板拍: 模型不自动选, 只有推理强度可自动): auto → 按任务分档
// 重任务(law/strategy/reasoning/code_debug/long_context)=high, 中任务(code/file_edit)=medium, 轻任务=low
// (老板再拍: 关档不留 — 'off' 及非法值一律落回 auto 分档)
// 优先级: 请求显式档(low/medium/high) > 模型自带 reasoning_effort(设置弹窗按模型配的) > auto 任务分类
function _resolveReasoningEffort(raw, userInput, model) {
  const EFFORTS = ['low', 'medium', 'high'];
  if (raw && EFFORTS.includes(raw)) return raw;
  if (model && EFFORTS.includes(model.reasoning_effort)) return model.reasoning_effort;
  let task = 'chat';
  try { task = require('../../modules/router/smart_router').classifyTask(userInput || '').task; } catch (_) {}
  // 2026-09-16 老板拍: auto 不再默认跳 high — 长上下文(digest/归纳)和纯 reasoning 走 medium,
  // 只有真正的多步策略/law/code_debug 才 high; 默认底档 medium 而非 low(防质量崩)
  if (['law', 'strategy', 'code_debug'].includes(task)) return 'high';
  if (['code', 'file_edit', 'reasoning', 'long_context'].includes(task)) return 'medium';
  return 'medium';
}

function makeHandler({ getDefaultModel, callLLM, callLLMRouter, extractContent, extractAnswer, _recordSessionToMemory, runAgentLoop, _config }) {
  return async function handler(req, res) {
    // R29 修 (老板 7/25 19:59 拍 '你直接修'): 加 body 大小限制 1MB — 防 DoS 攻击
    // 旧代码直接 JSON.parse(body) 无大小限, 任意大小 POST 都能灌进内存
    const MAX_BODY_BYTES = 1 * 1024 * 1024;  // 1MB
    let body = '';
    let bodyAborted = false;
    req.on('data', chunk => {
      if (bodyAborted) return;
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        bodyAborted = true;
        if (!res.headersSent) res.writeHead(413, { 'Content-Type': 'application/json' });
        try { res.end(JSON.stringify({ ok: false, error: 'BODY_TOO_LARGE', limit_bytes: MAX_BODY_BYTES })); } catch (_) {}
        try { req.destroy(); } catch (_) {}
      }
    });
    req.on('end', async () => {
      if (bodyAborted) return;
      let req_body;
      try {
        req_body = JSON.parse(body);
      } catch (_) {
        if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: 'INVALID_JSON' }));
      }
      try {
        const messages = req_body.messages || [];
        const rawUserInput = req_body.input || '';
        const userInput = resolveTaskInput(rawUserInput, messages);
        const images = req_body.images || [];
 // 加: 是否走 J2 agent-loop (主对话流)
 // 默认 true — "主对话流必须接工具 loop, 否则空话"
        //   run_j2: false 时退化到一次 LLM 单次调用 (单次纯文本输出)
        const runJ2 = req_body.run_j2 !== false;

        // 合并 user input 到 messages
        const allMessages = [...messages];
        if (userInput && (!messages.length || messages[messages.length - 1].content !== userInput)) {
          const userMsg = { role: 'user', content: userInput };
          if (images.length > 0) userMsg.images = images;
          allMessages.push(userMsg);
        } else if (images.length > 0 && allMessages.length > 0) {
          const last = allMessages[allMessages.length - 1];
          if (last.role === 'user') {
            last.images = (last.images || []).concat(images);
          }
        }

        // SSE 响应
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });

        // 2026-08-04 修 (Bug #1): 客户端可能已断, 写失败要忽略
        try { res.write(': stream-open\n\n'); } catch (e) { /* 连接已关, 忽略 */ }
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        const sseHeartbeat = sseUtils.setupHeartbeat(res, 5000);
        let streamClosed = false;
        res.on('close', () => { streamClosed = true; clearInterval(sseHeartbeat); });
        res.on('error', (err) => { safeGuard.writeCrash('message-stream-client-error', err); streamClosed = true; clearInterval(sseHeartbeat); });

        // Resolve the model from the request first. The desktop picker sends an
        // explicit id; falling back to getDefaultModel() here would silently
        // route that request through whatever model was globally current.
        const _requestedModelId = typeof req_body.model === 'string' ? req_body.model.trim() : '';
        const _configuredModels = (_config && _config.llm && Array.isArray(_config.llm.models)) ? _config.llm.models : [];
        const _requestedModelKey = _requestedModelId.toLowerCase();
        const _baseModel = _requestedModelId
          ? _configuredModels.find(m => m && [m.id, m.name, m.api_model]
            .some(v => String(v || '').trim().toLowerCase() === _requestedModelKey))
          : getDefaultModel();
        if (_requestedModelId && !_baseModel) {
          sseUtils.finalizeStream(res, 'error', { error: 'MODEL_NOT_FOUND', requested_model: _requestedModelId });
          clearInterval(sseHeartbeat);
          return;
        }
        if (_requestedModelId && _baseModel.enabled === false) {
          sseUtils.finalizeStream(res, 'error', { error: 'MODEL_DISABLED', requested_model: _requestedModelId });
          clearInterval(sseHeartbeat);
          return;
        }
        // 2026-09-14 (老板拍): 推理强度可 auto — 按任务分档后挂到模型副本上, 不动池里的原对象
        const _effort = _resolveReasoningEffort(req_body.reasoning_effort, userInput, _baseModel);
        const model = _baseModel ? { ..._baseModel, reasoning_effort: _effort } : _baseModel;

        // 分流: 走 J2 agent-loop (5 轮 tool-call) 还是单次 LLM
        if (runJ2 && typeof runAgentLoop === 'function') {
          // 2026-10-15 (老板: "盘古没反应"): 没人说话的请求不许进模型。
          // 现场: 前端偶发发空 input + 空 history 的请求 (session id 形如
          // request-<ts>-<rand>，task checkpoint 里 goal='' messages_count=1)。
          // 这类请求会一路走到 llm_caller._ensureUserTurn 补占位 user 轮才发得出去 ——
          // 代价是本地 27B 白跑 1~3 轮完整推理 (实测单轮 60~200s)，换回来一句
          // "本轮无新指令，等你拍"。界面全程只能看着盘古自言自语。
          // 判据只要两条同时成立: 输入空, 且 history 里也没有任何非空 user 轮 ——
          // 带着历史的后续请求、以及 "继续" 这类续跑指令 (resolveTaskInput 会填 userInput)
          // 都不受影响。
          const _hasUserTurn = allMessages.some(m => m && m.role === 'user' && String(m.content || '').trim());
          if (!String(userInput || '').trim() && !_hasUserTurn) {
            console.warn('[message-stream] EMPTY_REQUEST 短路: input 与 history 都没有可回应的用户轮, 不调模型 (session=' + (req_body.session_id || '-') + ')');
            // 只发一次 finalizeStream: 它内部先 sendEvent 再 res.end(),
            // 第二次调用会被 sendEvent 的 writableEnded 挡掉, 客户端就收不到 done 了。
            try { sseUtils.finalizeStream(res, 'done', { model_used: model?.id || 'none', skipped: 'empty_request' }); } catch (_) {}
            clearInterval(sseHeartbeat);
            return;
          }
          // J2 主循环 — 让 LLM 必须调 ≥1 工具, 5 轮上限
          const _startTs = req_body._start_ts || Date.now();
          // resolveTaskInput marks acknowledgements such as "继续" / "ok" as
          // continuations. Only those requests may replace the supplied chat
          // history with a checkpoint from the interrupted prior round.
          const resumeCheckpoint = userInput.includes('【续跑约束】');
          // 2026-09-12: runAgentLoop 没有 try/catch — 任何未捕获异常冒泡成 unhandledRejection
          // (09-09 46 次 "Unknown" crash + 09-12 TDZ "Cannot access before initialization" 都是这类)
          let loopResult;
          try {
          const _sessionId = String(
            req_body.session_id ||
            req_body.sessionId ||
            req.headers?.['x-session-id'] ||
            ('request-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
          );
          loopResult = await runAgentLoop(allMessages, model, req, res, {
              userInput,
              reqBody: req_body,
              sessionId: _sessionId,
              // 2026-10-17: 原来这里是**字面量空数组** —— 全仓唯一的生产注入点,
              // 于是 j2_agent_loop 的 model-chain switch 永远拿不到链, 那段代码 100% 死掉。
              // 配置里的 llm.fallback_chain 从此真的被读到 (没配就是空链, 行为不变)。
              // 链的过滤规则 (悬空引用/已停用/自己/无凭证) 全部收在
              // j2_model_policy.resolveFallbackChain 一个函数里, 别在这里另写一套。
              _modelChain: (function () {
                try {
                  const { resolveFallbackChain } = require('../../modules/j2_model_policy');
                  return resolveFallbackChain(_config, model && model.id);
                } catch (_) {
                  return [];   // 解析失败不许阻断正常请求
                }
              })(),
              resumeCheckpoint,
            });
          } catch (e) {
            // agent loop 崩溃 → 诚实 error 事件, 不让 SSE 连接静默断掉
            console.error('[message-stream] runAgentLoop uncaught:', e.message, e.stack?.split('\n').slice(0, 3).join(' | '));
            try { safeGuard.writeCrash('agent-loop-uncaught', e); } catch (_) {}
            // 2026-09-14 (老板拍: 盘古应该自己解决): 崩溃 → 自愈闭环 (记账→诊断→修复→验证→提交→自重启)
            let _repairHint = null;
            try {
              const _sr = require('../../modules/self_repair');
              const _rr = _sr.handleCrash('agent-loop-uncaught', e, { sessionId: req_body && req_body.session_id, config: _config });
              _repairHint = _rr && _rr.ok ? 'self_repair_applied' : ('no_fix: ' + (_rr && _rr.reason || 'unknown'));
            } catch (_) { /* 自愈绝不阻断错误上报 */ }
            try { sseUtils.finalizeStream(res, 'error', { error: e.message, type: 'agent_loop_crash', model_used: model?.id, provider: model?.provider, self_repair: _repairHint }); } catch (_) {}
            streamClosed = true;
            clearInterval(sseHeartbeat);
            return;
          }
          const _selectedModelId = loopResult && loopResult.modelUsed ? loopResult.modelUsed : model && model.id;
          const _selectedModel = (_selectedModelId && _config && _config.llm && Array.isArray(_config.llm.models))
            ? (_config.llm.models.find(m => m && m.id === _selectedModelId) || model)
            : model;
          // J2 owns its terminal session record. Writing another placeholder
          // here duplicated one user turn in long-term memory.
          // 2026-08-18: J2 主循环也 emit done event (带 model_used = router 选的), 跟 StatusBar chip 对齐
          // 不改 default_model (避免覆盖用户手动选择)
          if (!streamClosed) {
            const _doneModel = _selectedModel || getDefaultModel();
            const _modelUsed = _doneModel ? _doneModel.id : 'unknown';
            const _modelDevice = (_doneModel?.id || '').includes('local') || (_doneModel?.endpoint || '').includes('127.0.0.1') ? 'local' : 'cloud';
            const _contextLength = (() => { try { return require('../../modules/model_registry').getContextLength(_doneModel?.id) || null; } catch (_) { return null; } })();
            sseUtils.finalizeStream(res, 'done', {
              input: 0,
              output: 0,
              model_used: _modelUsed,
              device: _modelDevice,
              provider: _doneModel?.provider || 'unknown',
              mode: 'j2-loop',
              context_used: 0,
              context_limit: _contextLength,
              elapsed_ms: Date.now() - _startTs,
            });
          }
          return;
        }

        // Keep the non-J2 path on the same explicit model. The router's
        // legacy API resolves the global default and would undo the picker.
        const result = await callLLM(allMessages, model);
        // 2026-10-27 (第 112 批): 正文空**不许**变成空气泡。
        // extractContent 现在不再拿 reasoning_content 顶上去 (思考不是答案),
        // 所以「只回思考」到这里就是空 —— 空要有话说, 不能什么都不说。
        const _ans = (typeof extractAnswer === 'function') ? extractAnswer(result) : null;
        const _ansText = _ans ? _ans.text : extractContent(result);
        const guarded = guardAnswer(userInput, _ansText, '当前模型未返回与原问题对齐的答案。');
        const content = guarded.blocked
          ? '本轮未形成与原问题匹配的可核验答案，请重试。'
          : (String(guarded.text || '').trim()
            ? guarded.text
            : ((_ans && _ans.reasoningOnly)
              ? '本轮模型只回思考没有给出正文，请重试或换个模型。'
              : '本轮未形成与原问题匹配的可核验答案，请重试。'));
        console.log(`[message-stream] callLLM result keys=${Object.keys(result||{})} content.len=${(content||'').length} content=${String(content).slice(0,200)}`);

        if (streamClosed) return;

        const chunks = content.match(/[\s\S]{1,15}/g) || [content];
        for (const chunk of chunks) {
          if (streamClosed) break;
          sseUtils.sendEvent(res, 'chunk', { delta: chunk });
          await new Promise(r => setTimeout(r, 30));
        }

        if (streamClosed) return;

        // 2026-08-18: fallback 路径用本次 router 选的 model (之前用 getDefaultModel → 跟 StatusBar chip 不一致)
        const _doneModel = model || getDefaultModel();
        const _modelUsed = _doneModel ? _doneModel.id : 'unknown';
        const _modelDevice = (_doneModel?.id || '').includes('local') || (_doneModel?.endpoint || '').includes('127.0.0.1') ? 'local' : 'cloud';
        const _contextLength = (() => { try { return require('../../modules/model_registry').getContextLength(_doneModel?.id) || null; } catch (_) { return null; } })();
        const _ctxUsed = estimateMessagesTokens(allMessages) + content.length;
        const _startTime = req_body._start_ts || Date.now();
        await _recordSessionToMemory(req_body, content, _modelUsed);

        sseUtils.finalizeStream(res, 'done', {
          input: 0,
          output: 0,
          model_used: _modelUsed,
          device: _modelDevice,
          provider: _doneModel?.provider || 'unknown',
          mode: 'single-call',
          context_used: _ctxUsed,
          context_limit: _contextLength,
          elapsed_ms: Date.now() - _startTime,
        });
      } catch (e) {
        safeGuard.writeCrash('message-stream-error', e);
        const failedModel = req_body && req_body.model
          ? ((_config?.llm?.models || []).find(m => m && String(m.id).toLowerCase() === String(req_body.model).toLowerCase()) || null)
          : null;
        sseUtils.finalizeStream(res, 'error', { error: e.message, model_used: failedModel?.id || req_body?.model, provider: failedModel?.provider });
      }
    });
  };
}

module.exports = { makeHandler };
