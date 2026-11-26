/**
 * media_gen.js — 通用多模态生成内置工具 (image/video/music)
 *
 * 2026-08-07 老板拍: "适配所有模型的就不应该是 MCP, 应该是盘古内置"
 * — 从 mcp_servers/pangu-media 内化而来 (去掉 stdio/JSON-RPC 壳, 直接 TOOLS 挂载)。
 *
 * 能力声明在模型配置 (圭室"模型编辑" → config/nodes/your-mac.json):
 *   capabilities: ["chat","reasoning","image","video","music"]
 *   image_endpoint / video_endpoint / music_endpoint + api_key
 *   media_protocol (可选, 最高优先级): minimax | openai_images | comfyui | ...
 * 加新 provider = 模型编辑里加条目, 零代码 (同协议家族内)。
 * 加新协议家族 = PROTOCOLS 加一个条目。加新模态 = 家族里加一个 adapter。
 *
 * 2026-10-26 第 101 批 (通用型收口): 这里原来有两处**品牌硬判** ——
 *   modelApiKey: 写死 `provider === 'minimax'` + MINIMAX_API_KEY
 *   modelProtocol: 写死 `provider === 'minimax'` / `'comfyui'` 两个 if
 * ⇒ 换一个云厂商, key 查不到 (除非它恰好叫 minimax), 协议也判不对。
 * 现在:
 *   key    → 走共享解析链 modules/api_key_resolver (model.api_key > credentials > env)
 *   协议  → 显式 media_protocol > 配置提示表 llm.media_protocol_hints
 *           > 代码内数据兜底表 > 默认 openai_images
 * 加新厂商 = 配置里加一行提示 (或模型条目写 media_protocol), 不改代码。
 *
 * 铁律: base64/字节永远只经 media_sink 落盘, 工具结果只含文件路径。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { sinkBuffers, sinkFromUrl } = require('../media_sink');
const { resolveApiKey } = require('../api_key_resolver');

// modules/tools/ 上两级 = apps/core (跟 j2_dispatcher.js CONFIG_PATH 兜底同款约定)
// PANGU_MEDIA_CONFIG 可覆盖 —— 测试要指向临时配置, 多节点部署也可能分文件。
const NODE_CONFIG = process.env.PANGU_MEDIA_CONFIG
  || require('../../config/node_config').resolveNodeConfigPathOrEmpty();
const REQUEST_TIMEOUT_MS = 180000;
const VIDEO_POLL_INTERVAL_MS = 5000;
const VIDEO_POLL_TIMEOUT_MS = 600000;
const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'];

// ============================================================
// 模型配置解析: 按 modality 找声明了该能力的模型条目
// ============================================================

function loadModels() {
  const cfg = loadConfig();
  const models = Array.isArray(cfg.models) ? cfg.models : [];
  return models.filter(m => m && m.enabled !== false);
}

// 读 llm 配置段 (模型池 + 协议提示表都在这)。
function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(NODE_CONFIG, 'utf8'));
    return (cfg && cfg.llm) || {};
  } catch (e) {
    return {};
  }
}

function resolveMediaModel(modality, modelId) {
  const models = loadModels();
  if (modelId) {
    const m = models.find(x => x.id === modelId);
    if (!m) return { error: 'model_id not found or disabled: ' + modelId };
    return { model: m };
  }
  const m = models.find(x => Array.isArray(x.capabilities) && x.capabilities.includes(modality));
  if (!m) {
    return { error: `no enabled model declares capability "${modality}" — 在圭室模型编辑里给条目加 capabilities + ${modality}_endpoint` };
  }
  return { model: m };
}

function modelApiKey(model) {
  // 2026-10-26 第 101 批: 走**共享解析链** (modules/api_key_resolver),
  // 不再写死 `provider === 'minimax'` + MINIMAX_API_KEY。
  //
  // ⚠️ 优先级语义变了 (要知道才敢用):
  //   旧: provider 是 minimax 且 env 有 key ⇒ 用 env; 否则用 model.api_key
  //   新: model.api_key (非占位符) > credentials.js > 环境变量
  // 也就是说**模型条目里写死的 key 现在优先于环境变量** —— 因为条目是用户
  // 显式指定的, 环境变量是全局兜底。
  //
  // 新厂商接进来: 在模型条目写 api_key, 或配 api_key_env / api_key_credential,
  // 或按 <PROVIDER>_API_KEY 命名约定给环境变量 —— 三条路都通, 不用改代码。
  const key = resolveApiKey(model);
  return key || null;
}

// 协议家族兜底表 —— **数据**, 不是代码分支。
// 加协议家族 = 这里加一行, 或配置里写 media_protocol / media_protocol_hints。
const PROTOCOL_FALLBACK_BY_PROVIDER = {
  minimax: 'minimax',
  comfyui: 'comfyui',
};

// 协议家族判定 (四层, 优先级从高到低):
//   1. 模型条目显式 media_protocol
//   2. 配置提示表 llm.media_protocol_hints (provider → 协议家族) —— 运行时可扩展
//   3. 代码内数据兜底表 PROTOCOL_FALLBACK_BY_PROVIDER
//   4. 默认 openai_images
//
// 2026-10-26 第 101 批: 旧写法是 `provider === 'minimax'` / `'comfyui'` 两个
// if —— 换个厂商就判成 openai_images, 请求体格式直接不对。
function modelProtocol(model) {
  const explicit = String(model.media_protocol || '').trim();
  if (explicit) return explicit;
  const provider = String(model.provider || '').trim().toLowerCase();
  const hints = loadConfig().media_protocol_hints;
  if (hints && typeof hints === 'object') {
    const hinted = hints[provider];
    if (typeof hinted === 'string' && hinted) return hinted;
  }
  const fallback = PROTOCOL_FALLBACK_BY_PROVIDER[provider];
  if (fallback) return fallback;
  return 'openai_images';
}


// 各 protocol + modality 的 provider 侧模型白名单
// LLM 可能传 "flux"/"sdxl"/"dall-e-3" 等其他厂的模型名, MiniMax 会返 2013 unsupported
// 在这里硬约束, 不在白名单直接 FAIL:UNSUPPORTED_MODEL + 列出可用名
const PROVIDER_MODEL_WHITELIST = {
  'minimax': {
    image:  ['image-01', 'image-01-live'],
    video:  ['video-01'],
    music:  ['music-3.0', 'music-1.0'],
  },
  'comfyui': {
    // ComfyUI 模型由本地 workflow 决定, 不做白名单 (handler 走本地免费 SD/Flux checkpoint)
    image: null,
    video: null,
    music: null,
  },
};

function _validateProviderModel(protocolName, modality, requested) {
  // 没指定 model → 用 adapter default, 跳过校验
  if (!requested) return null;
  const wl = PROVIDER_MODEL_WHITELIST[protocolName] || {};
  const list = wl[modality];
  // null = 不限制 (本地 / 自定义 endpoint)
  if (list === null || list === undefined) return null;
  if (list.includes(requested)) return null;
  return {
    code: 'UNSUPPORTED_MODEL',
    message: `provider "${protocolName}" 的 "${modality}" modality 不支持模型 "${requested}". 可用: ${list.join(', ')} (或者不传 model, 用默认 ${list[0]})`
  };
}


const ENDPOINT_DEFAULTS = {
  minimax: { image: '/v1/image_generation', video: '/v1/video_generation', music: '/v1/music_generation' },
  openai_images: { image: '/v1/images/generations' },
  comfyui: { image: '/prompt' },
};

function modelEndpoint(model, modality) {
  const envKey = 'PANGU_MEDIA_' + modality.toUpperCase() + '_ENDPOINT';
  if (process.env[envKey]) return process.env[envKey];
  if (typeof model[modality + '_endpoint'] === 'string' && model[modality + '_endpoint']) return model[modality + '_endpoint'];
  // 从 chat 端点推媒体端点: 砍掉 API 根之后的部分。
  // 2026-10-26 第 101 批修: 旧写法只认 '/v1/' (带斜杠) ⇒ 端点正好是
  // 'https://host/v1' 时砍不掉, 拼出 '.../v1/v1/image_generation' (路径重复一段)。
  // 新写法: 有 '/v1/' 就砍到那儿; 没有就把结尾的 '/v1' 砍掉。
  let host = String(model.endpoint || '');
  const v1Slash = host.indexOf('/v1/');
  if (v1Slash >= 0) host = host.slice(0, v1Slash);
  else host = host.replace(/\/v1\/?$/, '');
  if (!host) return null;
  const defaults = ENDPOINT_DEFAULTS[modelProtocol(model)];
  if (defaults && defaults[modality]) return host + defaults[modality];
  return null;
}

// ============================================================
// HTTP helpers
// ============================================================

function postJson(url, apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const u = new URL(url);
    // 2026-10-26 第 101 批: 按 URL scheme 选 http/https。
    // 旧写法写死 https.request ⇒ 指向 **http://** 端点 (本地自建推理服务、
    // 内网网关) 直接抛 "Protocol 'http:' not supported" —— 新厂商接不上。
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      { hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'Content-Length': body.length },
        timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch (e) {
            return reject(new Error('non-JSON response (HTTP ' + res.statusCode + '): ' + text.slice(0, 300)));
          }
          const br = json && json.base_resp;
          if (res.statusCode !== 200 || (br && br.status_code && br.status_code !== 0)) {
            const detail = (br && (br.status_msg || br.status_code)) || (json && json.error && json.error.message) || '';
            return reject(new Error('HTTP ' + res.statusCode + (br ? ' base_resp ' + br.status_code : '') + (detail ? ': ' + detail : '')));
          }
          resolve(json);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getJson(url, apiKey) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      { hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'GET',
        headers: { Authorization: 'Bearer ' + apiKey }, timeout: REQUEST_TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (e) { reject(new Error('non-JSON GET response (HTTP ' + res.statusCode + ')')); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// 协议家族适配器: PROTOCOLS[家族][模态] = { defaultModel, validate?, execute(endpoint, key, args) }
// execute 返回 [{buffer, ext}] (待落盘) 或 [{savedPath}] (已落盘)。
// ============================================================

const PROTOCOLS = {
  // ---- MiniMax 私有协议 (base_resp / image_base64 / task_id 轮询 / hex 音频) ----
  minimax: {
    image: {
      defaultModel: 'image-01',
      validate(args) {
        const ar = args.aspect_ratio || '1:1';
        if (!ASPECT_RATIOS.includes(ar)) return 'aspect_ratio must be one of ' + ASPECT_RATIOS.join('/');
        return null;
      },
      async execute(endpoint, apiKey, args) {
        const payload = {
          model: args.model || this.defaultModel,
          prompt: args.prompt,
          aspect_ratio: args.aspect_ratio || '1:1',
          response_format: 'base64',
          n: Math.min(Math.max(parseInt(args.n, 10) || 1, 1), 9),
        };
        if (args.subject_reference) payload.subject_reference = [{ type: 'character', image_file: args.subject_reference }];
        if (typeof args.prompt_optimizer === 'boolean') payload.prompt_optimizer = args.prompt_optimizer;
        if (Number.isInteger(args.seed)) payload.seed = args.seed;
        const resp = await postJson(endpoint, apiKey, payload);
        const imgs = (resp.data && resp.data.image_base64) || [];
        if (imgs.length === 0) throw new Error('API returned 0 images');
        return imgs.map(b64 => ({ buffer: Buffer.from(b64, 'base64'), ext: '.jpeg' }));
      },
    },

    video: {
      // MiniMax 异步任务流: POST 拿 task_id → 轮询 query → file_id → retrieve 拿下载 URL
      defaultModel: 'video-01',
      async execute(endpoint, apiKey, args) {
        const payload = { model: args.model || this.defaultModel, prompt: args.prompt };
        if (args.first_frame_image) payload.first_frame_image = args.first_frame_image;
        const created = await postJson(endpoint, apiKey, payload);
        const taskId = created.task_id;
        if (!taskId) throw new Error('no task_id in video_generation response');
        const base = endpoint.split('/v1/')[0];
        const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
        let fileId = null;
        while (Date.now() < deadline) {
          await sleep(VIDEO_POLL_INTERVAL_MS);
          const q = await getJson(base + '/v1/query/video_generation?task_id=' + encodeURIComponent(taskId), apiKey);
          if (q.status === 'Success') { fileId = q.file_id; break; }
          if (q.status === 'Fail') throw new Error('video task failed: ' + JSON.stringify(q).slice(0, 200));
        }
        if (!fileId) throw new Error('video task timeout after ' + VIDEO_POLL_TIMEOUT_MS + 'ms');
        const f = await getJson(base + '/v1/files/retrieve?file_id=' + encodeURIComponent(fileId), apiKey);
        const url = f && f.file && f.file.download_url;
        if (!url) throw new Error('no download_url for file_id ' + fileId);
        const saved = await sinkFromUrl(url, { prefix: args.file_prefix || 'video', ext: '.mp4', outputDir: args.output_dir });
        return [{ savedPath: saved }];
      },
    },

    music: {
      defaultModel: 'music-3.0',
      async execute(endpoint, apiKey, args) {
        const payload = { model: args.model || this.defaultModel, prompt: args.prompt };
        if (args.lyrics) payload.lyrics = args.lyrics;
        if (typeof args.is_instrumental === 'boolean') payload.is_instrumental = args.is_instrumental;
        if (args.audio_setting) payload.audio_setting = args.audio_setting;
        const resp = await postJson(endpoint, apiKey, payload);
        const data = resp.data || {};
        // MiniMax music: audio 字段是 hex 编码的 mp3 (也可能是 url)
        if (typeof data.audio === 'string' && data.audio) {
          const isHex = /^[0-9a-fA-F]+$/.test(data.audio.slice(0, 64));
          const buffer = isHex ? Buffer.from(data.audio, 'hex') : Buffer.from(data.audio, 'base64');
          return [{ buffer, ext: '.mp3' }];
        }
        if (typeof data.audio_url === 'string' && data.audio_url) {
          const saved = await sinkFromUrl(data.audio_url, { prefix: args.file_prefix || 'music', ext: '.mp3', outputDir: args.output_dir });
          return [{ savedPath: saved }];
        }
        throw new Error('music response has no audio (status=' + JSON.stringify(data.status || resp.base_resp || {}).slice(0, 200) + ')');
      },
    },
  },

  // ---- OpenAI images 兼容协议 (/v1/images/generations, 业界最大公约数) ----
  // 适用: OpenAI gpt-image 系, 及兼容此协议的国产厂商 (Doubao seedream 等)
  openai_images: {
    image: {
      defaultModel: 'gpt-image-1',
      validate(args) {
        const ar = args.aspect_ratio || '1:1';
        if (!ASPECT_RATIOS.includes(ar)) return 'aspect_ratio must be one of ' + ASPECT_RATIOS.join('/');
        return null;
      },
      async execute(endpoint, apiKey, args) {
        const SIZE_MAP = { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536', '4:3': '1536x1024', '3:4': '1024x1536', '16:9': '1536x1024', '9:16': '1024x1536' };
        const payload = {
          model: args.model || this.defaultModel,
          prompt: args.prompt,
          size: SIZE_MAP[args.aspect_ratio || '1:1'] || '1024x1024',
          n: Math.min(Math.max(parseInt(args.n, 10) || 1, 1), 10),
        };
        const resp = await postJson(endpoint, apiKey, payload);
        const data = resp.data || [];
        if (data.length === 0) throw new Error('API returned 0 images');
        const items = [];
        for (const d of data) {
          if (d.b64_json) items.push({ buffer: Buffer.from(d.b64_json, 'base64'), ext: '.png' });
          else if (d.url) items.push({ savedPath: await sinkFromUrl(d.url, { prefix: args.file_prefix || 'image', ext: '.png', outputDir: args.output_dir }) });
        }
        if (items.length === 0) throw new Error('response has neither b64_json nor url');
        return items;
      },
    },
  },

  // ---- 本地 ComfyUI (免费无限量, 走 AGENTS.md 钦定的 comfyui_helper.py) ----
  comfyui: {
    image: {
      defaultModel: 'sd_xl_turbo_1.0_fp16',
      validate(args) {
        const ar = args.aspect_ratio || '1:1';
        if (!ASPECT_RATIOS.includes(ar)) return 'aspect_ratio must be one of ' + ASPECT_RATIOS.join('/');
        return null;
      },
      async execute(endpoint, apiKey, args) {
        const SIZE_MAP = {
          '1:1': [1024, 1024], '16:9': [1344, 768], '9:16': [768, 1344], '4:3': [1152, 864],
          '3:4': [864, 1152], '3:2': [1216, 832], '2:3': [832, 1216], '21:9': [1536, 640],
        };
        const [w, h] = SIZE_MAP[args.aspect_ratio || '1:1'];
        const n = Math.min(Math.max(parseInt(args.n, 10) || 1, 1), 4);
        // 2026-09-13: helper 收养进盘古仓库 (原外部路径已废除, 盘古完全自治)
        const HELPER = path.join(__dirname, 'comfyui_helper.py');
        const items = [];
        for (let i = 0; i < n; i++) {
          const cli = ['--model', args.model || this.defaultModel, '--w', String(w), '--h', String(h),
            '--prefix', args.file_prefix || 'comfyui'];
          if (Number.isInteger(args.seed)) cli.push('--seed', String(args.seed + i));
          const saved = await new Promise((resolve, reject) => {
            const p = spawn('python3', [HELPER, args.prompt, ...cli]);
            let out = '';
            p.stdout.on('data', d => { out += d; });
            p.stderr.on('data', () => {}); // helper 进度日志, 按 AGENTS.md 契约忽略
            const killer = setTimeout(() => { p.kill(); reject(new Error('comfyui_helper timeout')); }, 300000);
            p.on('close', (code) => {
              clearTimeout(killer);
              const m = out.match(/file:\/\/(\S+)/);
              if (code === 0 && m) return resolve(m[1]);
              reject(new Error('comfyui_helper exit=' + code));
            });
            p.on('error', (e) => { clearTimeout(killer); reject(e); });
          });
          items.push({ savedPath: saved });
        }
        return items;
      },
    },
  },
};

// ============================================================
// TOOLS 挂载入口 (ctx = {context, params}, 见 tools/index.js 约定)
// ============================================================

async function mediaGenerate(ctx) {
  const { params = {} } = ctx || {};
  const args = params;
  const fail = (code, message) => ({ ok: false, data: null, error: { code, message } });

  const modality = args.modality;
  if (modality === 'video') return fail('VIDEO_DISABLED', '视频生成功能已停用');
  if (!args.prompt || typeof args.prompt !== 'string') return fail('NO_PROMPT', 'prompt is required (string)');

  const { model, error } = resolveMediaModel(modality, args.model_id);
  if (error) return fail('NO_MODEL', error);
  const protocolName = modelProtocol(model);
  const family = PROTOCOLS[protocolName];
  if (!family) return fail('NO_PROTOCOL', 'unknown media_protocol: ' + protocolName + ' (在 PROTOCOLS 加家族)');
  const adapter = family[modality];
  if (!adapter) {
    return fail('NO_ADAPTER', `protocol "${protocolName}" 未实现 modality "${modality}" — 在 PROTOCOLS.${protocolName} 加一个 adapter`);
  }
  if (adapter.validate) {
    const err = adapter.validate(args);
    if (err) return fail('BAD_ARGS', err);
  }
  // 2026-08-22: 校验 provider 侧 model 名 (白名单, 避 LLM 传 flux/sdxl/dall-e-3 触发上游 2013)
  const modelErr = _validateProviderModel(protocolName, modality, args.model);
  if (modelErr) return fail(modelErr.code, modelErr.message);

  const apiKey = modelApiKey(model);
  if (!apiKey) return fail('NO_KEY', 'model ' + model.id + ' has no api_key');
  const endpoint = modelEndpoint(model, modality);
  if (!endpoint) return fail('NO_ENDPOINT', 'model ' + model.id + ' has no ' + modality + '_endpoint');

  const started = Date.now();
  let items;
  try {
    items = await adapter.execute(endpoint, apiKey, args);
  } catch (e) {
    return fail('EXEC_FAILED', e.message);
  }

  // 两种产出: {buffer, ext} 待落盘 / {savedPath} 已落盘 (URL 下载 / 本地 helper 类)
  const files = [];
  const toSink = [];
  for (const it of items) {
    if (it.savedPath) files.push(it.savedPath);
    else toSink.push(it);
  }
  if (toSink.length > 0) {
    files.push(...sinkBuffers(toSink, { outputDir: args.output_dir, prefix: args.file_prefix || modality }));
  }

  return {
    ok: true,
    data: {
      modality,
      protocol: protocolName,
      model_id: model.id,
      files,
      count: files.length,
      elapsed_ms: Date.now() - started,
      note: '媒体已落盘。不要把内容/base64 贴回对话, 直接用文件路径。',
    },
  };
}

module.exports = mediaGenerate;
