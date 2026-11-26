/**
 * Pangu · 环境探测模块 (env_detect)
 * §0.24 启动时探测环境，存 ~/.pangu/env_cache.json
 *
 * 目的：避免 LLM 调 ComfyUI 试错端口、猜 PIL 状态
 *
 * 探测项：
 * 1. ComfyUI 服务（端口 8000 / 8188）— host, port, status, checkpoints
 * 2. Python 关键库 — PIL / torch / diffusers / ComfyUI deps
 * 3. 关键二进制 — ffmpeg / node / git
 * 4. 路径白名单 — ~/Desktop, ~/Applications
 * 5. LLM 端点 — LM Studio / Ollama / MiniMax / OpenAI
 *
 * 启动调用：modules/boot.js 启动时调一次 runEnvDetect()
 * 失败兜底：探测失败不阻塞启动，存 { errors: [...] } 让 LLM 看到
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const CACHE_PATH = path.join(os.homedir(), '.pangu', 'env_cache.json');
const CACHE_TTL_MS = 60 * 60 * 1000;  // 1 小时过期

// 探测 ComfyUI（多端口）
async function detectComfyUI() {
  // 候选默认只探本机; 局域网 ComfyUI 节点 (如 n5pro) 走 env 注入, 不写死内网 IP
  // (开源后别人的内网拓扑不同, 写死 192.168.x 会探空还泄内网)。
  const candidates = [
    { name: 'comfyui-local-8000', host: '127.0.0.1', port: 8000 },
    { name: 'comfyui-local-8188', host: '127.0.0.1', port: 8188 },
  ];
  const lanHost = process.env.PANGU_COMFYUI_LAN_HOST;
  if (lanHost) candidates.push({ name: 'comfyui-lan', host: lanHost, port: 8188 });
  for (const c of candidates) {
    try {
      const info = await fetchJson(c.host, c.port, '/system_stats', 2000);
      if (info && info.system) {
        return { ...c, status: 'ok', info };
      }
    } catch (_) {}
  }
  return { status: 'unavailable', tried: candidates };
}

// 探测 LLM 端点
// 2026-10-12 全面排查实案: 云端点 (minimax/openai) 无鉴权 GET 根路径 → 返回非 JSON 错误页
// → fetchJson parse fail → 永远报 down → 启动摘要 48 次谎报 "LLM 端点: ❌ 都不可用"
// (实际 minimax 一直在正常服务)。云端点的"可用"语义 = 网络可达 + HTTP 有应答
// (哪怕 401/404), 不要求 JSON 可解析; 本地端点 (lm-studio/ollama) 保持 JSON 要求。
async function detectLLM() {
  const candidates = [
    { name: 'lm-studio-local', host: '127.0.0.1', port: 1234, path: '/v1/models' },
    { name: 'ollama-local', host: '127.0.0.1', port: 11434, path: '/api/tags' },
    { name: 'openai-compat', host: 'api.openai.com', port: 443, https: true, anyStatus: true },
    { name: 'minimax', host: 'api.minimaxi.com', port: 443, https: true, anyStatus: true },
  ];
  const results = [];
  for (const c of candidates) {
    try {
      if (c.anyStatus) {
        const code = await fetchHttpStatus(c.host, c.port, c.path || '/', 2500, c.https);
        results.push({ ...c, status: 'ok', http: code });
      } else {
        const data = await fetchJson(c.host, c.port, c.path, 1500, c.https);
        if (data) results.push({ ...c, status: 'ok' });
        else results.push({ ...c, status: 'down', error: 'empty response' });
      }
    } catch (e) {
      results.push({ ...c, status: 'down', error: e.message });
    }
  }
  return results;
}

// 只拿 HTTP 状态码 (云端点可达性探测用): 有应答 = 可达, 不论状态码与 body
function fetchHttpStatus(host, port, urlPath, timeoutMs = 3000, httpsMode = false) {
  return new Promise((resolve, reject) => {
    const lib = httpsMode ? require('https') : http;
    const req = lib.request({
      host, port, path: urlPath, method: 'GET', timeout: timeoutMs,
      headers: { 'User-Agent': 'pangu-env-detect/1.0' },
    }, (res) => {
      res.resume();  // 丢弃 body, 只要状态码
      resolve(res.statusCode || 0);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

// 探测 Python 库（用 python3 -c "import X"）
function detectPythonLibs() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const libs = ['PIL', 'torch', 'diffusers', 'transformers', 'numpy', 'cv2', 'yaml'];
    const results = {};
    let done = 0;
    if (!process.env.PATH) process.env.PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';
    for (const lib of libs) {
      exec(`python3 -c "import ${lib}; print(getattr(${lib}, '__version__', 'unknown'))"`, { timeout: 5000 }, (err, stdout) => {
        if (err) {
          results[lib] = { available: false };
        } else {
          results[lib] = { available: true, version: (stdout || '').trim() };
        }
        done++;
        if (done === libs.length) resolve(results);
      });
    }
  });
}

// 探测关键二进制
function detectBinaries() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const bins = ['ffmpeg', 'node', 'git', 'python3', 'curl', 'lms', 'ollama'];
    const results = {};
    let done = 0;
    if (!process.env.PATH) process.env.PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';
    for (const b of bins) {
      exec(`which ${b} 2>/dev/null && ${b} --version 2>&1 | head -1`, { timeout: 3000 }, (err, stdout) => {
        if (err) {
          results[b] = { available: false };
        } else {
          const lines = (stdout || '').split('\n');
          results[b] = { available: true, path: lines[0], version: lines[1] || '' };
        }
        done++;
        if (done === bins.length) resolve(results);
      });
    }
  });
}

// HTTP GET JSON
function fetchJson(host, port, urlPath, timeoutMs = 3000, httpsMode = false) {
  return new Promise((resolve, reject) => {
    const lib = httpsMode ? require('https') : http;
    const req = lib.request({
      host, port, path: urlPath, method: 'GET', timeout: timeoutMs,
      headers: { 'User-Agent': 'pangu-env-detect/1.0' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('parse fail: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

// 主函数
async function runEnvDetect(force = false) {
  // 检查缓存
  if (!force && fs.existsSync(CACHE_PATH)) {
    try {
      const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      if (Date.now() - cache.detected_at < CACHE_TTL_MS) {
        return cache;
      }
    } catch (_) {}
  }

  const t0 = Date.now();
  const [comfy, llm, pyLibs, bins] = await Promise.all([
    detectComfyUI().catch((e) => ({ status: 'error', error: e.message })),
    detectLLM().catch((e) => [{ status: 'error', error: e.message }]),
    detectPythonLibs().catch((e) => ({ error: e.message })),
    detectBinaries().catch((e) => ({ error: e.message })),
  ]);

  const result = {
    detected_at: Date.now(),
    elapsed_ms: Date.now() - t0,
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    comfyui: comfy,
    llm: llm,
    python_libs: pyLibs,
    binaries: bins,
  };

  // 写缓存
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(result, null, 2));
  } catch (e) {
    console.warn('[env_detect] cache write failed:', e.message);
  }

  return result;
}

// 简化的"环境摘要" - 给 LLM 看 (≤ 500 字)
function envSummary(env) {
  if (!env) return '环境未探测';
  const lines = [];
  lines.push(`平台: ${env.platform}/${env.arch} node ${env.node}`);
  if (env.comfyui?.status === 'ok') {
    lines.push(`ComfyUI: ✅ ${env.comfyui.host}:${env.comfyui.port} (${env.comfyui.info?.system?.comfyui_version || '?'})`);
  } else {
    lines.push(`ComfyUI: ❌ 未启动 (试了 ${env.comfyui?.tried?.map(c => c.port).join('/') || '?'})`);
  }
  const llmOk = env.llm?.filter(l => l.status === 'ok').map(l => l.name) || [];
  lines.push(`LLM 端点: ${llmOk.length > 0 ? llmOk.join(', ') : '❌ 都不可用'}`);
  const pyOk = Object.entries(env.python_libs || {}).filter(([_, v]) => v.available).map(([k]) => k);
  lines.push(`Python 库: ${pyOk.length > 0 ? pyOk.join(', ') : '❌ 都不可用'}`);
  const binOk = Object.entries(env.binaries || {}).filter(([_, v]) => v.available).map(([k]) => k);
  lines.push(`二进制: ${binOk.length > 0 ? binOk.join(', ') : '❌ 都不可用'}`);
  return lines.join('\n');
}

module.exports = { runEnvDetect, envSummary, CACHE_PATH, detectComfyUI, detectLLM, detectPythonLibs, detectBinaries };

// 直接跑（被 main 进程 import 触发）
if (require.main === module) {
  runEnvDetect(true).then((r) => {
    console.log(JSON.stringify(r, null, 2));
  }).catch((e) => {
    console.error('env_detect failed:', e);
    process.exit(1);
  });
}
