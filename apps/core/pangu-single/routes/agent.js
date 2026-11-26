// pangu-single/routes/agent.js
// Agent 列表 / 运行 / 卦象 / orchestrate 路由
'use strict';

const fs = require('fs');
const path = require('path');
const safeGuard = require('../safe-guard/global');
const { checkLocalOrigin } = require('./route_security');

const AGENTS_JSON = path.join(__dirname, '..', '..', 'agents', 'agents.json');
const AGENTS_DIR = path.join(__dirname, '..', '..', 'agents');
const LEGACY_TASK_TYPES = new Set([
  'plan', 'decompose', 'sequence', 'analyze', 'analyze_code', 'analyze_requirement', 'requirement', 'divination',
  'write_file', 'edit_file', 'run_command', 'create_directory', 'exec', 'verify_output', 'run_tests', 'lint_code',
  'lint', 'review_code', 'review', 'security_scan', 'code', 'check', 'scan', 'reflect_session', 'analyze_failures',
  'generate_insights', 'score', 'learn', 'recall', 'optimize', 'default',
]);

function json(res, obj, status) {
  res.statusCode = status || 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        e.code = 'INVALID_JSON';
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function handler(req, res, pathname) {
  if (pathname === '/api/pangu/orchestrate' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const task = body.task || body.input || body.goal || '默认任务';
      const { PanguOrchestrator } = require(path.join(AGENTS_DIR, 'orchestrator.js'));
      const orchestrator = new PanguOrchestrator();
      const result = await orchestrator.orchestrate(task);
      json(res, { ok: result.ok ?? result.success, ...result });
      return { consumed: true };
    } catch (e) {
      if (e && e.code === 'INVALID_JSON') return json(res, { ok: false, error: 'INVALID_JSON' }, 400);
      safeGuard.writeCrash('orchestrate-error', e);
      json(res, { ok: false, error: e.message }, 500);
      return { consumed: true };
    }
  }

  if (pathname === '/api/agent/list') {
    try {
      const agents = require(AGENTS_JSON);
      json(res, { ok: true, data: agents.agents });
      return { consumed: true };
    } catch (e) {
      safeGuard.writeCrash('agent-list-error', e);
      json(res, { ok: false, error: e.message }, 500);
      return { consumed: true };
    }
  }

  const agentRunMatch = pathname.match(/^\/api\/agent\/run\/([^/]+)$/);
  if (req.method === 'GET' && agentRunMatch) {
    if (!checkLocalOrigin(req, res)) return { consumed: true };
    try {
        // URL 里的 <name> 归一成拼音 (2026-10-18)。模块文件整批从英文改名成拼音
        // (analyzer.js → li.js), 所以老链接 /api/agent/run/analyzer 现在找不到文件了。
        // 这是**输入解析**: 读进来立刻丢掉, 下面一律用拼音 —— 存的/查的都是拼音。
        // 认不出来的名字原样留着, 让下面的 AGENT_NOT_FOUND 如实报, 不猜。
        const _rawRun = agentRunMatch[1];
        // URL 路径段必须先解码 (RFC 3986)。少了这一步, 中文卦名进来还是
        // %E4%B9%BE 这种百分号编码串 —— resolveRole 认得「乾」但认不得
        // 「%E4%B9%BE」, 于是 /api/agent/run/乾 恒 404, 而 resolveRole 里
        // 专门认卦名的那一半永远走不到。解码失败(畸形编码)就当没解码, 交给下面如实报错。
        let _decodedRun = _rawRun;
        try { _decodedRun = decodeURIComponent(_rawRun); } catch (_) {}
        const _canonRun = require('../../agents/gua-identity').resolveRole(_decodedRun);
        const runName = _canonRun || _rawRun;
      const agentModulePath = path.join(AGENTS_DIR, runName + '.js');
      if (!fs.existsSync(agentModulePath)) {
        json(res, { ok: false, error: 'AGENT_NOT_FOUND' }, 404);
        return { consumed: true };
      }

      const agentModule = require(agentModulePath);
      const agentsConfig = require(AGENTS_JSON);
      const agentConfig = agentsConfig.agents[runName];
      if (!agentConfig) {
        json(res, { ok: false, error: 'AGENT_CONFIG_NOT_FOUND' }, 404);
        return { consumed: true };
      }

      const params = Object.fromEntries(new URL(req.url, 'http://127.0.0.1').searchParams.entries());
      let suppliedContext = {};
      try {
        if (params.context) suppliedContext = JSON.parse(params.context);
        if (!suppliedContext || typeof suppliedContext !== 'object' || Array.isArray(suppliedContext)) throw new Error('上下文必须是 JSON 对象');
      } catch (e) {
        json(res, { ok: false, error: 'INVALID_CONTEXT', message: e.message }, 400);
        return { consumed: true };
      }
      const legacyType = LEGACY_TASK_TYPES.has(params.task) ? params.task : '';
      const taskType = params.type || params.task_type || legacyType || (runName === 'kan' ? 'plan' : 'default');
      const goal = params.goal || params.command || params.content || (!legacyType ? params.task : '') || '默认任务';
      const task = { type: taskType === 'exec' ? 'run_command' : taskType, goal, command: goal, content: goal };
      const context = {
        ...suppliedContext,
        user: 'feng',
        sessionId: suppliedContext.sessionId || 'pangu-agent-' + runName,
        params: { ...(suppliedContext.params || {}), task: taskType, goal },
        agent: agentConfig,
      };
      const input = runName === 'xun'
        ? { code: params.code || suppliedContext.code || goal, language: params.language || suppliedContext.language || 'javascript' }
        : task;
      let result;
      if (typeof agentModule.execute === 'function') result = await agentModule.execute(input, context);
      else if (typeof agentModule === 'function') result = await agentModule(task, context);
      else result = { ok: false, error: 'Agent module has no execute function' };
      const ok = result && typeof result === 'object'
        ? (result.ok ?? result.success ?? (result.status ? result.status === 'success' : !result.error))
        : true;
      json(res, { ok, agent: runName, result });
      return { consumed: true };
    } catch (e) {
      safeGuard.writeCrash('agent-run-error', e);
      json(res, { ok: false, error: e.message }, 500);
      return { consumed: true };
    }
  }

  const agentHexMatch = pathname.match(/^\/api\/agent\/hex\/([^/]+)$/);
  if (req.method === 'GET' && agentHexMatch) {
    try {
      const hexName = agentHexMatch[1];
      const agentsConfig = require(AGENTS_JSON);
      const agent = agentsConfig.agents[hexName];
      if (!agent) {
        json(res, { ok: false, error: 'AGENT_NOT_FOUND' }, 404);
        return { consumed: true };
      }
      json(res, { ok: true, data: { name: agent.name, hex_main: agent.hex_main, hex_aux: agent.hex_aux } });
      return { consumed: true };
    } catch (e) {
      safeGuard.writeCrash('agent-hex-error', e);
      json(res, { ok: false, error: e.message }, 500);
      return { consumed: true };
    }
  }

  return { consumed: false };
}

module.exports = { handler };
