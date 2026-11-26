#!/usr/bin/env node
'use strict';
// 2026-09-17: 把本地模型 (mlx-server / LM Studio / Ollama) 加进盘古 — 一条命令搞定
// 用法:
//   node apps/core/scripts/add-mlx-model.js <provider> <model-id> [--endpoint http://127.0.0.1:11234] [--ctx 262144]
// provider: mlx | lmstudio | ollama | openai
// 做的事:
//   1. 探活: GET <endpoint>/v1/models 确认真有模型
//   2. 读 ~/.pangu/config.json: 加到 llm.models (自动填 context_length, 探不到用 /v1/models 返回的)
//   3. 写 models-registry.json (R88 单一信源, 下次启动零探测)
//   4. 同步 router/models.json
//
// 2026-10-17: --role 通道下线。子 agent 现在无条件继承主模型, llm.role_models
// 不再被 role_model.js 读取 —— 加这个 flag 只会写一条"配了但不生效"的死数据
// (开机时被 model_config_guard 当死字段删掉)。留着 opt('role') 的解析
// 就等于留一个静默失效的开关, 所以连解析一起去掉, 传了直接报错。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const args = process.argv.slice(2);
const provider = args[0];
const modelId = args[1];
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i > 0 ? args[i + 1] : dflt;
}
const DEFAULT_PORTS = { mlx: '11234', lmstudio: '1234', ollama: '11434', openai: '' };
const endpoint = opt('endpoint', 'http://127.0.0.1:' + DEFAULT_PORTS[provider]);
if (!provider || !modelId) {
  console.error('用法: node add-mlx-model.js <mlx|lmstudio|ollama|openai> <model-id> [--endpoint URL] [--ctx N] [--role r1,r2]');
  process.exit(1);
}

// 1. 探活
function httpGet(url) {
  return new Promise((res, rej) => {
    const r = http.get(url, resp => {
      let b = '';
      resp.on('data', c => b += c);
      resp.on('end', () => res({ status: resp.statusCode, body: b }));
    });
    r.on('error', rej);
    r.setTimeout(5000, () => { r.destroy(); rej(new Error('timeout')); });
  });
}
(async () => {
  const modelsUrl = endpoint.replace(/\/$/, '') + '/v1/models';
  let ctx = Number(opt('ctx', '0')) || 0;
  let realName = modelId;
  try {
    const r = await httpGet(modelsUrl);
    if (r.status === 200) {
      const d = JSON.parse(r.body);
      const list = d.data || [];
      const hit = list.find(m => m && (m.id === modelId || m.id.endsWith(modelId)));
      if (hit) {
        realName = hit.id;
        if (!ctx) ctx = hit.context_length || 0;
        console.log('[探活] ✓ ' + endpoint + ' 在线, 真模型名: ' + realName + (ctx ? ' ctx=' + ctx : ''));
      } else {
        console.warn('[探活] ' + endpoint + ' 在线但没找到 "' + modelId + '" — 现有模型: ' + list.map(m => m.id).join(', ').slice(0, 150));
      }
    } else console.warn('[探活] ' + modelsUrl + ' → HTTP ' + r.status + ', 盲加 (用 --ctx 补上下文)');
  } catch (e) {
    console.warn('[探活] 连不上 ' + endpoint + ' (' + e.message + ') — 继续盲加, 模型名可能错');
  }
  if (!ctx) ctx = 128000; // 兜底
  if (!ctx) throw new Error('context_length 未知 — 用 --ctx N 指定');

  // 2. 加进 config.json
  const configPath = path.join(os.homedir(), '.pangu', 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
  cfg.llm = cfg.llm || {};
  cfg.llm.models = cfg.llm.models || [];
  const entry = {
    id: provider + '-' + realName.replace(/[^a-z0-9.]/gi, '-'),
    name: realName,
    provider: provider === 'mlx' ? 'openai' : provider,  // 盘古 provider: mlx 走 openai 协议
    protocol: 'openai',
    endpoint: endpoint,
    api_key: 'local-' + provider,
    context_length: ctx,
    tier: 'local',
    enabled: true,
    _source: 'add-local-model',
    _note: provider === 'mlx' ? 'MLX Core (mlx-serve) 本地推理' : provider + ' 本地模型',
  };
  if (cfg.llm.models.some(m => m.id === entry.id)) {
    console.log('已存在: ' + entry.id + ' (跳过)');
  } else {
    cfg.llm.models.push(entry);
    console.log('已加入 config.json: ' + entry.id);
  }
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));

  // 3. (原 role_models 指派通道已下线 —— 见文件头注释)
  if (args.includes('--role')) {
    console.error('✗ --role 已下线: 子 agent 现在无条件继承主模型, 不能再单独指定。'
      + ' 要换模型请用 POST /api/llm/use 切主模型 —— 整个盘古(含全部将灵)一起换。');
    process.exit(1);
  }

  // 4. 写 models-registry.json (R88 单一信源)
  const regPath = path.join(os.homedir(), '.pangu', 'models-registry.json');
  let reg = { version: 1, models: {} };
  try { reg = JSON.parse(fs.readFileSync(regPath, 'utf8')); } catch (_) {}
  reg.models[entry.id] = { context_length: ctx, source: 'L5-user-override', ts: Date.now() };
  reg.models[realName] = reg.models[realName] || { context_length: ctx, source: 'L5-user-override', ts: Date.now() };
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
  console.log('registry 已写: ' + entry.id + ' → ' + ctx);

  // 5. 同步 router/models.json (跟 pangu_helpers.syncRouterModelsFromConfig 同逻辑)
  const routerPath = path.join(__dirname, '../../modules/router/models.json');
  try {
    let rm = JSON.parse(fs.readFileSync(routerPath, 'utf8'));
    rm.models = rm.models || [];
    if (!rm.models.find(m => m.id === entry.id)) {
      rm.models.push({
        id: entry.id, provider: entry.provider, api_base: entry.endpoint,
        cost_per_1k_input: 0, cost_per_1k_output: 0,
        latency_p50_ms: 0, quality_score: 0.8, tier: 'local',
        vision: true, max_tokens: 8192, context_length: ctx,
        role_specialty: ['chat', 'reasoning', 'tool_use'],
        available: true, env_var: null,
        _note: entry._note,
      });
      fs.writeFileSync(routerPath, JSON.stringify(rm, null, 2));
      console.log('router/models.json 已同步: ' + entry.id);
    } else {
      console.log('router/models.json 已有 (跳过)');
    }
  } catch (e) {
    console.warn('router 同步失败 (不影响主流程):', e.message);
  }

  console.log('\n=== 完成. model id = ' + entry.id + ' ===');
  console.log('重启盘古生效: launchctl kickstart -k gui/$(id -u)/local.pangu-single');
  if (roles) console.log('子 agent 已指派: ' + roles);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
