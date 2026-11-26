/**
 * Pangu · Modules
 * node_registry.js - 多机节点注册表
 *
 * 职责：
 * - 节点注册 / 注销 / 心跳
 * - 节点状态追踪（在线/离线/超时）
 * - 激活码管理（单机/服务器共用）
 * - 数据持久化（nodes.json）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================
// 节点状态定义
// ============================================================

const NODE_STATUS = {
  OFFLINE: 'offline',     // 未注册或已注销
  ONLINE: 'online',       // 在线（心跳正常）
  STALE: 'stale',         // 心跳超时，失去联系
  SUSPENDED: 'suspended', // 被服务器暂停
};

// ============================================================
// 激活码管理 (M8: 已删除模块级 ACTIVATION_CODES Map, 统一用 this.codes)
// ============================================================

// ── 持久化辅助（NodeRegistry 实例方法调用）──────────────────
function _codesFilePath(dataDir) {
  return path.join(dataDir, 'codes.json');
}

function _loadCodesFromFile(dataDir) {
  const fp = _codesFilePath(dataDir);
  if (!fs.existsSync(fp)) return null;
  try {
    const arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const m = new Map();
    for (const item of arr) m.set(item.code, item);
    return m;
  } catch (e) {
    console.warn('[NodeRegistry] 加载激活码失败:', e.message);
    return null;
  }
}

function _saveCodesToFile(dataDir, codesMap) {
  const fp = _codesFilePath(dataDir);
  try {
    fs.writeFileSync(fp, JSON.stringify(Array.from(codesMap.entries()).map(([code, e]) => Object.assign({ code }, e)), null, 2), 'utf8');
  } catch (e) {
    console.warn('[NodeRegistry] 保存激活码失败:', e.message);
  }
}

function generateCode(type = '单机') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'PANGU-';
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function activateCodeEntry(codesMap, code, nodeId) {
  const entry = codesMap.get(code);
  if (!entry) return { ok: false, error: 'INVALID_CODE' };
  if (entry.activated_at && entry.node_id) return { ok: false, error: 'ALREADY_ACTIVATED' };
  entry.activated_at = new Date().toISOString();
  entry.node_id = nodeId;
  return { ok: true, entry };
}

function validateCodeEntry(codesMap, code) {
  const entry = codesMap.get(code);
  if (!entry) return { ok: false, error: 'INVALID_CODE' };
  if (!entry.activated_at) return { ok: true, status: 'UNUSED', entry };
  return { ok: true, status: 'USED', node_id: entry.node_id, entry };
}

// ============================================================
// NodeRegistry 主类
// ============================================================

class NodeRegistry {
  /**
   * @param {object} options
   * @param {string} options.dataDir - 节点数据存储目录
   * @param {number} options.heartbeatInterval - 心跳间隔（ms），默认30000
   * @param {number} options.nodeTimeout - 节点超时判离线（ms），默认120000
   */
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(__dirname, '..', 'data', 'nodes');
    this.heartbeatInterval = options.heartbeatInterval || 30000;
    this.nodeTimeout = options.nodeTimeout || 120000;

    // 内存节点表
    this.nodes = new Map(); // nodeId → { id, name, ip, port, last_heartbeat, status, metadata, registered_at }
    this.serverMode = options.serverMode !== undefined ? options.serverMode : true;

    // 激活码初始化（从文件加载或生成默认码）
    this.codes = _loadCodesFromFile(this.dataDir) || this._defaultCodes();
    this._initCodes = () => {}; // no-op, codes already inited

    // 确保数据目录存在
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });

    // 加载已注册的持久化节点
    this._loadNodes();
    // 保存激活码到文件（如果文件不存在则创建）
    _saveCodesToFile(this.dataDir, this.codes);

    // 启动节点清理定时器
    this._cleanupTimer = null;
    this._startCleanupTimer();
  }

  _defaultCodes() {
    const m = new Map();
    m.set('PANGU-DEMO-0000-0000-0001', { type: '单机', created_at: new Date().toISOString(), activated_at: null, node_id: null });
    m.set('PANGU-DEMO-0000-0000-0002', { type: '服务器', created_at: new Date().toISOString(), activated_at: null, node_id: null });
    m.set('PANGU-FULL-ACCESS-000001', { type: '单机', created_at: new Date().toISOString(), activated_at: null, node_id: null });
    return m;
  }

  _initActivationCodes() {
 // M8: 写入 this.codes 而非模块级 ACTIVATION_CODES
    if (this.codes.size === 0) {
      this.codes.set('PANGU-DEMO-0000-0000-0001', {
        type: '单机', created_at: new Date().toISOString(), activated_at: null, node_id: null
      });
      this.codes.set('PANGU-DEMO-0000-0000-0002', {
        type: '服务器', created_at: new Date().toISOString(), activated_at: null, node_id: null
      });
      this.codes.set('PANGU-FULL-ACCESS-000001', {
        type: '单机', created_at: new Date().toISOString(), activated_at: null, node_id: null
      });
    }
  }

  _nodesFilePath() {
    return path.join(this.dataDir, 'nodes.json');
  }

  _loadNodes() {
    const fp = this._nodesFilePath();
    if (!fs.existsSync(fp)) return;
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      for (const node of (data.nodes || [])) {
        node.last_heartbeat = new Date(node.last_heartbeat);
        this.nodes.set(node.id, node);
      }
    } catch (e) {
      console.warn('[NodeRegistry] 加载节点失败:', e.message);
    }
  }

  _saveNodes() {
    const fp = this._nodesFilePath();
    const data = {
      saved_at: new Date().toISOString(),
      nodes: Array.from(this.nodes.values()),
    };
    try {
      fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.warn('[NodeRegistry] 保存节点失败:', e.message);
    }
  }

  _startCleanupTimer() {
    // 每30秒检查一次节点超时
    this._cleanupTimer = setInterval(() => {
      this._cleanupStaleNodes();
    }, 30000);
  }

  _cleanupStaleNodes() {
    const now = Date.now();
    let changed = false;
    for (const [nodeId, node] of this.nodes.entries()) {
      if (node.status === NODE_STATUS.OFFLINE || node.status === NODE_STATUS.SUSPENDED) continue;
      const elapsed = now - new Date(node.last_heartbeat).getTime();
      if (elapsed > this.nodeTimeout && node.status !== NODE_STATUS.STALE) {
        node.status = NODE_STATUS.STALE;
        changed = true;
        console.log('[NodeRegistry] 节点失联:', nodeId, '已超过' + Math.round(elapsed / 1000) + 's无心跳');
      }
    }
    if (changed) this._saveNodes();
  }

  // ============================================================
  // 节点注册
  // ============================================================

  /**
   * 注册新节点
   * @param {object} nodeInfo
   * @returns {{ ok, node?, error? }}
   */
  register(nodeInfo = {}) {
    const { node_id, name, ip, port, activation_code, metadata = {} } = nodeInfo;

    // 验证激活码
    if (this.serverMode) {
      const actResult = activateCodeEntry(this.codes, activation_code, node_id);
      if (!actResult.ok) return { ok: false, error: actResult.error };
    }

    if (!node_id) return { ok: false, error: 'MISSING_NODE_ID' };

    // 已存在则更新
    if (this.nodes.has(node_id)) {
      const existing = this.nodes.get(node_id);
      existing.last_heartbeat = new Date();
      existing.status = NODE_STATUS.ONLINE;
      if (ip) existing.ip = ip;
      if (name) existing.name = name;
      if (port) existing.port = port;
      this._saveNodes();
      return { ok: true, node: existing, re_register: true };
    }

    // 新节点
    const node = {
      id: node_id,
      name: name || node_id,
      ip: ip || null,
      port: port || 18901,
      status: NODE_STATUS.ONLINE,
      last_heartbeat: new Date(),
      registered_at: new Date().toISOString(),
      activation_code: activation_code || null,
      metadata,
      server_mode: this.serverMode,
    };

    this.nodes.set(node_id, node);
    this._saveNodes();
    console.log('[NodeRegistry] 节点注册:', node_id, '@', ip, '| 总节点数:', this.nodes.size);

    return { ok: true, node };
  }

  // ============================================================
  // 心跳
  // ============================================================

  /**
   * 更新节点心跳
   * @param {string} nodeId
   * @param {object} extra - 额外数据（负载、在线状态等）
   */
  heartbeat(nodeId, extra = {}) {
    const node = this.nodes.get(nodeId);
    if (!node) return { ok: false, error: 'NODE_NOT_FOUND' };

    node.last_heartbeat = new Date();
    node.status = NODE_STATUS.ONLINE;
    if (extra.load !== undefined) node.load = extra.load;
    if (extra.memory !== undefined) node.memory = extra.memory;
    if (extra.skills_count !== undefined) node.skills_count = extra.skills_count;
    if (extra.uptime !== undefined) node.uptime = extra.uptime;

    this._saveNodes();
    return { ok: true, node };
  }

  // ============================================================
  // 查询
  // ============================================================

  /**
   * 获取所有节点
   */
  listNodes() {
    return Array.from(this.nodes.values()).map(n => ({
      ...n,
      age_ms: Date.now() - new Date(n.last_heartbeat).getTime(),
      is_stale: n.status === NODE_STATUS.STALE,
    }));
  }

  /**
   * 获取单个节点
   */
  getNode(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) return null;
    return {
      ...node,
      age_ms: Date.now() - new Date(node.last_heartbeat).getTime(),
      is_stale: node.status === NODE_STATUS.STALE,
    };
  }

  /**
   * 获取在线节点数
   */
  getOnlineCount() {
    let count = 0;
    for (const n of this.nodes.values()) {
      if (n.status === NODE_STATUS.ONLINE) count++;
    }
    return count;
  }

  /**
   * 注销节点
   */
  unregister(nodeId) {
    if (!this.nodes.has(nodeId)) return { ok: false, error: 'NODE_NOT_FOUND' };
    this.nodes.delete(nodeId);
    this._saveNodes();
    return { ok: true };
  }

  // ============================================================
  // 激活码管理（服务器端）
  // ============================================================

  /**
   * 生成激活码
   */
  createActivationCode(type = '单机') {
    const code = generateCode(type);
    this.codes.set(code, { type, created_at: new Date().toISOString(), activated_at: null, node_id: null });
    _saveCodesToFile(this.dataDir, this.codes);
    return { ok: true, code };
  }

  /**
   * 验证激活码
   */
  checkActivationCode(code) {
    return validateCodeEntry(this.codes, code);
  }

  /**
   * 撤销激活码
   */
  revokeActivationCode(code) {
    if (!this.codes.has(code)) return { ok: false };
    this.codes.delete(code);
    _saveCodesToFile(this.dataDir, this.codes);
    return { ok: true };
  }

  /**
   * 列出所有激活码
   */
  listActivationCodes() {
    return Array.from(this.codes.entries()).map(([code, entry]) => ({
      code, ...entry
    }));
  }

  // ============================================================
  // 清理
  // ============================================================

  destroy() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
  }
}

module.exports = {
  NodeRegistry,
  NODE_STATUS,
  generateCode,
};