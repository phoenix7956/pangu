/**
 * agents/class-compat.js
 * 向后兼容的 class 包装层
 * 测试脚本和 registry.js 仍使用旧的 class API，但底层委托给新的实例实现。
 * agency-agents 解决方案
 */

const { KunAgent: kun } = require('./kun');
const { LiAgent: li } = require('./li');
const { DuiAgent: dui } = require('./dui');
const { KanAgent: kan } = require('./kan');
const { ZhenAgent: zhen } = require('./zhen');
const { GenAgent: gen } = require('./gen');
const { XunAgent } = require('./xun');
const Orchestrator = require('./orchestrator');
const {
  endpointOf,
  canonicalModelName,
  isAnthropic,
  normalizeProtocol,
  normalizeEndpoint,
  outputTokenCap,
  authHeaders,
  resolveRequestTimeoutMs,
} = require('../modules/model_transport');
const { resolveApiKey } = require('../modules/api_key_resolver');

/**
 * 通用包装基类：把新实例的 execute(task, context) 包装成旧 class 的
 * execute(input) 接口。
 */
class KunAgent {
  async execute(input = {}) {
    const task = {
      type: input.task || 'run_command',
      command: input.command || input.task || input.params?.path,
      goal: input.task || input.goal,
      path: input.path || input.params?.path,
      file: input.path || input.params?.path,
      filePath: input.path || input.params?.path,
      content: input.content || input.goal,
      oldText: input.oldText,
      newText: input.newText,
    };
    return kun.execute(task, input.context || {});
  }
}

class LiAgent {
  async execute(input = {}) {
    const task = {
      type: input.type || 'analyze_requirement',
      path: input.path || input.query,
      text: input.query || input.text || input.goal || input.task,
      question: input.query || input.question,
    };
    return li.execute(task, input.context || {});
  }
}

class DuiAgent {
  async execute(input = {}) {
    const task = {
      type: input.type || 'review_code',
      expected: input.expected,
      actual: input.actual,
      testPath: input.testPath || input.path,
      filePath: input.path || input.filePath,
    };
    return dui.execute(task, input.context || {});
  }
}

class KanAgent {
  async execute(input = {}) {
    const task = {
      type: input.type || 'plan',
      goal: input.bigTask || input.goal || input.task,
      subtasks: input.subTasks || input.subtasks,
    };
    return kan.execute(task, input.context || {});
  }
}

class ZhenAgent {
  async execute(input = {}) {
    const task = {
      type: input.type || 'reflect_session',
      sessionId: input.sessionId,
      data: input.data || input.context,
    };
    return zhen.execute(task, input.context || {});
  }
}

class GenAgent {
  constructor() {
    this.knowledgeBase = new Map();
  }

  async execute(input = {}) {
    const task = {
      type: input.type || 'learn',
      experience: input.expData || input.experience || input,
    };
    return gen.execute(task, input.context || {});
  }

  static getLearnData() {
    return { experiences: [], taskPatterns: {}, agentPerformance: {} };
  }
}

class QianAgent {
  async execute(input = {}) {
    const { AgentDispatcher } = require('./qian');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const http = require('http');
    const https = require('https');

    // 节点配置路径 —— 不写死任何人的机器名 (2026-10-26 第 109 批)。
    //   顺序: 调用方显式给 › PANGU_NODE_CONFIG / config/nodes/node.json /
    //   config/nodes/ 下唯一候选 › 旧部署位置 ~/.pangu/config/nodes/*.json。
    const configPath = (input.context && input.context.config_path)
      || require('../config/node_config').resolveNodeConfigPathOrEmpty()
      || path.join(os.homedir(), '.pangu', 'config', 'nodes', 'node.json');

    function loadConfig() {
      try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { return null; }
    }
    function getEnabledModel(cfg) {
      if (!cfg || !cfg.llm || !Array.isArray(cfg.llm.models)) return null;
      const enabled = cfg.llm.models.filter(m => m.enabled !== false);
      // 单一真源: llm.current_model_id (pangu-single 启动时已删 model.default 字段)
      const id = cfg.llm.current_model_id;
      if (id) {
        const cur = enabled.find(m => m.id === id);
        if (cur) return cur;
      }
      if (enabled.length > 0) return enabled.sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
      return null;
    }
    async function callLLM(messages, modelConfig) {
      if (!modelConfig) throw new Error('No model available');
      const apiKey = resolveApiKey(modelConfig);
      const baseUrl = normalizeEndpoint(endpointOf(modelConfig), normalizeProtocol(modelConfig));
      const useAnthropic = isAnthropic(modelConfig);
      return new Promise((resolve, reject) => {
        const url = new URL(baseUrl);
        let body, headers = authHeaders(modelConfig, apiKey);
        const apiModel = canonicalModelName(modelConfig);
        if (useAnthropic) {
          const mergedSystem = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n---\n\n');
          body = JSON.stringify({ model: apiModel, max_tokens: Math.min(4096, outputTokenCap(modelConfig)), system: mergedSystem || undefined, messages: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content })) });
        } else {
          body = JSON.stringify({ model: apiModel, max_tokens: Math.min(4096, outputTokenCap(modelConfig)), messages });
        }
        const req = (url.protocol === 'https:' ? https : http).request({
          hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: (() => { const p = url.pathname + url.search; if (useAnthropic) return p; if (p.includes('/chat/completions')) return p; return (p.endsWith('/') ? p.slice(0, -1) : p) + '/chat/completions'; })(),
          method: 'POST', headers,
          // 2026-10-14: 本地端点给 300s, 云端 60s
          timeout: resolveRequestTimeoutMs(modelConfig, 60000, 300000)
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            try {
              const r = JSON.parse(data);
              if (r.error) return reject(new Error(r.error.message || r.error));
              let content = '';
              if (useAnthropic) {
                content = r.content && r.content.map(c => c.text).join('');
              } else {
                content = r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content || '';
              }
              resolve({ content });
            } catch (e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => reject(new Error('LLM timeout')));
req.setHeader('Content-Length', Buffer.byteLength(body)); // 2026-10-14: mlx-serve 不吃 chunked
        req.write(body);
        req.end();
      });
    }
    const cfg = loadConfig();
    const model = getEnabledModel(cfg);
    const llm = async (prompt, opts) => callLLM([{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: prompt }], model);
    const dispatcher = new AgentDispatcher({ llm, tools: require('../modules/tools').TOOLS, cfg });
    const result = await dispatcher.dispatch({ input: input.task || input.bigTask || 'default' });
    return {
      taskType: result.stage || 'dispatch',
      agents: Object.keys(result).filter(k => k !== 'stage'),
      schedule: result,
    };
  }
}

// 旧测试脚本期望的 PanguOrchestrator = Orchestrator
class PanguOrchestrator extends Orchestrator {}

module.exports = {
  KunAgent,
  LiAgent,
  DuiAgent,
  KanAgent,
  ZhenAgent,
  GenAgent,
  QianAgent,
  XunAgent,
  PanguOrchestrator,
};
