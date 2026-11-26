/**
 * modules/license_detector.js
 * 盘古 Phase 4 占位 - 终端识别 + License 检测 (未启用)
 *
 * 状态 (§0.18 ): DEPRECATED for 单机版
 * - 单机 Pangu 零收费 (§0.10 + §0.18)
 * - License 只在 iCloud 服务端阶段 (Phase 4) 有意义
 * - 现在不接入主流程 (pangu-single.js 启动不调此模块)
 * - 代码保留,等 Phase 4 重新启用
 *
 * 历史背景：
 * - 原设计: 已登录 Apple ID 的 Mac → commercial, 需要 License
 * 
 * - 结论: 单机版 license_required 永远 false; license 推到 Phase 4
 *
 * 备份: archive/-license/license_cache.deprecated.json
 * 复活路径: Phase 4 启动时,移除 DEPRECATED 注释,从 cache 恢复
 */

const { execSync, exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOMEDIR = os.homedir();
const PANGU_DIR = path.join(HOMEDIR, '.pangu');

// ============================================================
// 平台检测
// ============================================================

function detectPlatform() {
  const p = process.platform;
  return {
    is_mac: p === 'darwin',
    is_windows: p === 'win32',
    is_linux: p === 'linux',
  };
}

// ============================================================
// Apple ID 检测（Mac only）
// ============================================================

function detectAppleId() {
  // 方法1: security find-internet-password（标准 Keychain）
  try {
    const out = execSync(
      '/usr/bin/security find-internet-password -s "appleid.apple.com" -g 2>/dev/null',
      { timeout: 5000, encoding: 'utf8' }
    );
    const match = out.match(/0x[0-9a-f]+ "acct" <([^>]+)>/);
    const appleId = match ? match[1] : 'detected';
    return { logged_in: true, apple_id: appleId, method: 'keychain' };
  } catch {}

  // 方法2: MobileMeAccounts.plist（有 iCloud 服务即认为已登录）
  try {
    const mobileMePath = path.join(HOMEDIR, 'Library/Preferences/MobileMeAccounts.plist');
    if (fs.existsSync(mobileMePath)) {
      const out = execSync(
        `plutil -convert json -o - "${mobileMePath}" 2>/dev/null`,
        { timeout: 5000, encoding: 'utf8' }
      );
      const plist = JSON.parse(out);
      const accounts = plist?.Accounts || [];
      for (const a of accounts) {
        const accountId = a.AccountID;
        if (accountId) {
          const services = (a.Services || []).map(s => s.Name || s);
          const hasICloud = services.some(s =>
            ['CLOUDDESKTOP', 'KEYCHAIN_SYNC', 'FIND_MY_MAC', 'MOBILE_DOCUMENTS', 'ICLOUD'].includes(s)
          );
          if (hasICloud || services.length > 3) {
            return { logged_in: true, apple_id: accountId, method: 'mobile_me' };
          }
        }
      }
    }
  } catch {}

  return { logged_in: false, apple_id: null, method: null };
}

// ============================================================
// Microsoft Account 检测（Windows only）
// ============================================================

function detectMicrosoftAccount() {
  try {
    // whoami /user 输出 SID；/all 输出包括 Microsoft Account
    const out = execSync('whoami /user 2>/dev/null', { timeout: 5000, encoding: 'utf8' });
    const sidMatch = out.match(/S-1-5-21-\d+-\d+-\d+-\d+/);
    const sid = sidMatch ? sidMatch[0] : null;
    return { has_sid: !!sid, sid };
  } catch {
    return { has_sid: false, sid: null };
  }
}

// ============================================================
// Docker 检测
// ============================================================

function detectDocker() {
  try {
    // 方法1: cgroup
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    if (cgroup.includes('docker') || cgroup.includes('containerd')) {
      return { is_docker: true, method: 'cgroup' };
    }
  } catch {}

  try {
    // 方法2: .dockerenv
    if (fs.existsSync('/.dockerenv')) {
      return { is_docker: true, method: 'dockerenv' };
    }
  } catch {}

  try {
    // 方法3: /run/.containerenv (Podman)
    if (fs.existsSync('/run/.containerenv')) {
      return { is_docker: true, method: 'containerenv' };
    }
  } catch {}

  return { is_docker: false, method: null };
}

// ============================================================
// VM 检测
// ============================================================

function detectVM() {
  const platform = detectPlatform();

  if (platform.is_mac) {
    try {
      const out = execSync(
        'system_profiler SPHardwareDataType 2>/dev/null',
        { timeout: 5000, encoding: 'utf8' }
      );
      const vmware = out.includes('VMware') || out.includes('VirtualBox') || out.includes('Parallels');
      return { is_vm: vmware, type: vmware ? 'virtualbox/vmware/parallels' : 'physical' };
    } catch {
      return { is_vm: false, type: 'unknown' };
    }
  }

  if (platform.is_windows) {
    try {
      const out = execSync('systeminfo 2>/dev/null | findstr /i "vmware virtualbox hyper"', {
        timeout: 8000,
        encoding: 'utf8',
      });
      return { is_vm: out.trim().length > 0, type: 'virtual' };
    } catch {
      return { is_vm: false, type: 'physical' };
    }
  }

  if (platform.is_linux) {
    try {
      const out = execSync('dmidecode -s system-product-name 2>/dev/null', {
        timeout: 5000,
        encoding: 'utf8',
      });
      const product = out.toLowerCase();
      const isVm = product.includes('vmware') || product.includes('virtualbox') ||
        product.includes('kvm') || product.includes('qemu') || product.includes('hyperv');
      return { is_vm: isVm, type: isVm ? product.trim() : 'physical' };
    } catch {
      return { is_vm: false, type: 'unknown' };
    }
  }

  return { is_vm: false, type: 'unknown' };
}

// ============================================================
// Apple ID 状态变更检测
// ============================================================

const APPLE_ID_STATE_FILE = path.join(PANGU_DIR, 'last_apple_id_state.json');

function saveAppleIdState(state) {
  try {
    fs.mkdirSync(PANGU_DIR, { recursive: true });
    fs.writeFileSync(APPLE_ID_STATE_FILE, JSON.stringify({
      ...state,
      ts: Date.now(),
    }, null, 2));
  } catch {}
}

function loadAppleIdState() {
  try {
    if (fs.existsSync(APPLE_ID_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(APPLE_ID_STATE_FILE, 'utf8'));
    }
  } catch {}
  return null;
}

// ============================================================
// 主入口
// ============================================================

function detectEnvironment() {
  const platform = detectPlatform();
  const appleId = platform.is_mac ? detectAppleId() : { logged_in: false, apple_id: null };
  const msAccount = platform.is_windows ? detectMicrosoftAccount() : { has_sid: false, sid: null };
  const docker = detectDocker();
  const vm = detectVM();

  // 综合判断是否需要 License
  let environment_type;
  let license_required;

  if (platform.is_mac && !appleId.logged_in && !docker.is_docker && !vm.is_vm) {
    // 未登录 Apple ID 的 Mac + 非 VM + 非 Docker = 单机免费
    environment_type = 'single_free';
    license_required = false;
  } else {
    // 已登录 Apple ID 的 Mac / Windows / Linux / Docker / VM = 商用
    environment_type = 'commercial';
    license_required = true;
  }

  const result = {
    platform: platform.is_mac ? 'mac' : platform.is_windows ? 'windows' : platform.is_linux ? 'linux' : 'unknown',
    is_mac: platform.is_mac,
    is_windows: platform.is_windows,
    is_linux: platform.is_linux,
    is_docker: docker.is_docker,
    is_vm: vm.is_vm,
    vm_type: vm.type,
    apple_id_logged_in: platform.is_mac ? appleId.logged_in : null,
    apple_id: platform.is_mac ? appleId.apple_id : null,
    microsoft_account: platform.is_windows ? msAccount.has_sid : null,  // 简化：有无 SID 即认为有账号
    license_required,
    environment_type,
    detected_at: new Date().toISOString(),
  };

  // 检测 Apple ID 状态变更（仅 Mac）
  if (platform.is_mac) {
    const prev = loadAppleIdState();
    if (prev) {
      if (prev.logged_in !== appleId.logged_in) {
        result.apple_id_state_changed = true;
        result.apple_id_prev_logged_in = prev.logged_in;
      }
    }
    // 记录当前状态
    saveAppleIdState({ logged_in: appleId.logged_in, apple_id: appleId.apple_id });
  }

  return result;
}

// ============================================================
// 异步版本（用于 HTTP 请求）
// ============================================================

function detectEnvironmentAsync() {
  return new Promise((resolve) => {
    try {
      resolve(detectEnvironment());
    } catch (e) {
      resolve({
        error: e.message,
        license_required: true,  // 出错默认需要 License
        environment_type: 'commercial',
      });
    }
  });
}

module.exports = {
  detectEnvironment,
  detectEnvironmentAsync,
  // 供测试用
  _detectPlatform: detectPlatform,
  _detectAppleId: detectAppleId,
  _detectMicrosoftAccount: detectMicrosoftAccount,
  _detectDocker: detectDocker,
  _detectVM: detectVM,
};