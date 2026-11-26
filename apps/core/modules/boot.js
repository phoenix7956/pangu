/**
 * modules/boot.js
 * 盘古 Phase 4 - 启动模块
 *
 * 职责：
 * - 统一入口初始化逻辑
 * - 终端识别 + License 检查
 * - 根据模式（single_free / commercial）返回启动参数
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { detectEnvironment } = require('./license_detector');
const { status, activateTrial } = require('./license_manager');
const { runEnvDetect, envSummary } = require('./env_detect');  // 启动探测

const PANGU_DIR = path.join(os.homedir(), '.pangu');

// ============================================================
// 启动参数
// ============================================================

function getBootParams() {
  const env = detectEnvironment();
  const PANGU_HOME = process.env.PANGU_HOME || path.dirname(require.main.filename);

  return {
    env,
    PANGU_HOME,
    pid: process.pid,
    started_at: new Date().toISOString(),
  };
}

// ============================================================
// License 检查（启动时调用）
// ============================================================

function checkLicense({ node_id, hostname, platform, skip_trial = false }) {
  const env = detectEnvironment();

 // §0.18 单机零收费, 不管 Apple ID 是否登录, Mac 都走 single_free
  // License 只在 iCloud 服务端阶段 (Phase 4) 才检查
  // Windows / Linux 现在仍跳 commercial (未来可同跳)
  if (env.is_mac && !env.is_docker && !env.is_vm) {
    return {
      mode: 'single_free',
      env: { ...env, license_required: false, environment_type: 'single_free' },
      license_ok: true,
      message: '单机免费版启动',
    };
  }

  // 原商业逻辑保留 (给未来 iCloud 服务端 / Windows 商用版用)
  // 单机免费版：不需要 License
  if (!env.license_required) {
    return {
      mode: 'single_free',
      env,
      license_ok: true,
      message: '单机免费版启动',
    };
  }

  // 商用版：检查 License 状态
  let lic = status({ node_id });

  if (lic.is_valid) {
    return {
      mode: 'commercial',
      env,
      license_ok: true,
      plan: lic.plan,
      expires_at: lic.expires_at,
      message: `商用版已激活 (${lic.plan})`,
    };
  }

  // 无 License，激活试用版
  if (!skip_trial) {
    try {
      const trial = activateTrial({
        node_id: node_id || os.hostname(),
        hostname: hostname || os.hostname(),
        platform: platform || env.platform,
      });
      return {
        mode: 'commercial',
        env,
        license_ok: true,
        plan: 'trial',
        expires_at: trial.expires_at,
        message: '试用版已激活 (30天)',
        is_trial: true,
      };
    } catch (e) {
      return {
        mode: 'commercial',
        env,
        license_ok: false,
        message: 'License 激活失败: ' + e.message,
        error: e.message,
      };
    }
  }

  return {
    mode: 'commercial',
    env,
    license_ok: false,
    message: '需要 License',
  };
}

// ============================================================
// 统一日志输出
// ============================================================

function logBoot(params) {
  const { mode, env, license_ok, message } = params;
  console.log('[boot] mode:', mode, '| environment:', env.environment_type);
  console.log('[boot] platform:', env.platform, '| license_required:', env.license_required);
  if (env.apple_id_logged_in !== null) {
    console.log('[boot] apple_id:', env.apple_id, '| apple_id_logged_in:', env.apple_id_logged_in);
  }
  if (env.is_docker) console.log('[boot] docker detected');
  if (env.is_vm) console.log('[boot] VM detected:', env.vm_type);
  console.log('[boot] license_ok:', license_ok, '| message:', message);
}

// §0.24 启动时环境探测 (comfyui / llm / python / bin)
async function probeRuntimeEnv() {
  try {
    const env = await runEnvDetect(false);  // false = 用缓存 (1h TTL)
    console.log('[boot] env cache hit:', (Date.now() - env.detected_at) < 60 * 60 * 1000);
    console.log('[boot] env summary:');
    console.log(envSummary(env).split('\n').map(l => '  ' + l).join('\n'));
    return env;
  } catch (e) {
    console.warn('[boot] env_detect failed:', e.message);
    return null;
  }
}



// ============================================================
// §0.31 跨会话上下文加载 (2026-08-30 立)
// 新 session 启动时读 ~/.pangu/state/checkpoints/ 最近 1-3 个其他 session 的摘要,
// 注入 system prompt, 解决"盘古新会话完全失忆"问题。
// ============================================================
async function loadPriorSessionContext({ excludeSessionId = null, limit = 3 } = {}) {
  try {
    const { loadRecentSessionContext, buildPriorContextPrompt } = require('./prior_session');
    const items = loadRecentSessionContext({ excludeSessionId, limit });
    if (!items.length) return { ok: true, count: 0, items: [], prompt: '' };
    const prompt = buildPriorContextPrompt(items);
    console.log('[boot] prior session context loaded: ' + items.length + ' items');
    return { ok: true, count: items.length, items, prompt };
  } catch (e) {
    console.warn('[boot] loadPriorSessionContext failed:', e.message);
    return { ok: false, error: e.message, count: 0, items: [], prompt: '' };
  }
}

module.exports = {
  getBootParams,
  checkLicense,
  logBoot,
  probeRuntimeEnv,  // §0.24
  envSummary,
  loadPriorSessionContext,  // §0.31
};