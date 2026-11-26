
// P2-10: license key 用 bcryptjs 替代 SHA-256 (项目已有 bcryptjs 依赖)
const _panguBcrypt = require('bcryptjs');
const useBcryptLicense = true;  // flag: true 用 bcrypt (推荐), false 退回 SHA-256 (兼容老 key)

async function _panguHashLicense(licenseKey) {
  if (useBcryptLicense) {
    return await _panguBcrypt.hash(licenseKey.trim().toUpperCase(), 10);
  }
  // fallback to SHA-256 (兼容)
  return require('crypto').createHash('sha256').update(licenseKey.trim().toUpperCase()).digest('hex');
}

async function _panguVerifyLicense(licenseKey, hash) {
  if (useBcryptLicense) {
    return await _panguBcrypt.compare(licenseKey.trim().toUpperCase(), hash);
  }
  return _panguHashLicense(licenseKey).then(h => h === hash);
}

/**
 * modules/license_manager.js
 * 盘古 Phase 4 占位 - License 激活系统 (未启用)
 *
 * 状态 (§0.18 ): DEPRECATED for 单机版
 * - 单机 Pangu 零收费 (§0.10 + §0.18)
 * - License 只在 iCloud 服务端阶段 (Phase 4) 有意义
 * - 现在不接入主流程 (pangu-single.js 启动不调此模块)
 * - PLAN_PRICE / UPGRADE_PRICE_DIFF / SQLite 全部等 Phase 4 重新启用
 * * 备份: archive/-license/license_cache.deprecated.json
 */

const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const fs = require('fs');

const HOMEDIR = os.homedir();
const PANGU_DIR = path.join(HOMEDIR, '.pangu');
const LICENSE_CACHE = path.join(PANGU_DIR, 'license_cache.json');
const DB_PATH = path.join(process.env.PANGU_HOME || path.resolve(__dirname, '..'), 'data/pangu.db');

// ============================================================
// 计划定价（单位：元）
// ============================================================

const PLAN_PRICE = {
  trial: 0,
  personal: 0,        // 一次性 ¥2,000
  team: 5000,         // 一次性 ¥5,000
  enterprise: 15000,  // 一次性 ¥15,000
};

const PLAN_MAX_TERMINALS = {
  trial: 1,
  personal: 1,
  team: 5,
  enterprise: 99,
};

const UPGRADE_PRICE_DIFF = {
  personal_to_team: 1500,
  personal_to_enterprise: 9500,
  team_to_enterprise: 8000,
};

// ============================================================
// 数据库操作
// ============================================================

let _db = null;

function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
 // 加: 首次启动建表 (Pangu 1.0 bug — 之前 db 在 archive,data 删了后无 schema)
 // 加: schema migration (add max_terminals column if missing)
    const tableInfo = _db.prepare("PRAGMA table_info(licenses)").all();
    const hasMaxTerminals = tableInfo.some(function(c) { return c.name === 'max_terminals'; });
    if (tableInfo.length > 0 && !hasMaxTerminals) {
      console.log('[license-mgr] migrating: add max_terminals column');
      _db.exec('ALTER TABLE licenses ADD COLUMN max_terminals INTEGER DEFAULT 1');
    }
    _db.exec(`
      CREATE TABLE IF NOT EXISTS licenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_hash TEXT NOT NULL,
        plan TEXT NOT NULL,
        max_terminals INTEGER DEFAULT 1,
        node_id TEXT,
        hostname TEXT,
        platform TEXT,
        activated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS license_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        license_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        old_node_id TEXT,
        new_node_id TEXT,
        reason TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (license_id) REFERENCES licenses(id)
      );
      CREATE INDEX IF NOT EXISTS idx_licenses_node ON licenses(node_id);
      CREATE INDEX IF NOT EXISTS idx_licenses_hash ON licenses(key_hash);
    `);
  }
  return _db;
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ============================================================
// License Hash
// ============================================================

function hashKey(licenseKey) {
  return crypto.createHash('sha256').update(licenseKey.trim().toUpperCase()).digest('hex');
}

// ============================================================
// 本地缓存（离线支持）
// ============================================================

function loadCache() {
  try {
    if (fs.existsSync(LICENSE_CACHE)) {
      return JSON.parse(fs.readFileSync(LICENSE_CACHE, 'utf8'));
    }
  } catch {}
  return null;
}

function saveCache(data) {
  try {
    fs.mkdirSync(PANGU_DIR, { recursive: true });
    fs.writeFileSync(LICENSE_CACHE, JSON.stringify({
      ...data,
      cached_at: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn('[License] 缓存写入失败:', e.message);
  }
}

function clearCache() {
  try {
    if (fs.existsSync(LICENSE_CACHE)) {
      fs.unlinkSync(LICENSE_CACHE);
    }
  } catch {}
}

// ============================================================
// 激活
// ============================================================

/**
 * POST /license/activate
 * @param {string} license_key
 * @param {string} node_id
 * @param {string} hostname
 * @param {string} platform
 * @param {boolean} online - 是否联网激活（false=离线缓存激活）
 */
function activate({ license_key, node_id, hostname, platform, online = true }) {
  const db = getDb();
  const keyHash = hashKey(license_key);

  // 解析计划（从 key 前缀判断，demo 实现）
  // 格式: TRIAL-XXXX / PERS-XXXX / TEAM-XXXX / ENTP-XXXX
  const keyUpper = license_key.trim().toUpperCase();
  let plan = 'trial';
  let expires_at = null;

  if (keyUpper.startsWith('PERS-')) {
    plan = 'personal';
  } else if (keyUpper.startsWith('TEAM-')) {
    plan = 'team';
  } else if (keyUpper.startsWith('ENTP-')) {
    plan = 'enterprise';
  } else if (keyUpper.startsWith('TEST-')) {
    plan = 'trial';
    expires_at = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(); // 30天试用
  }

  // 检查是否已激活（同一 node_id）
  const existing = db.prepare(
    'SELECT * FROM licenses WHERE key_hash = ? AND revoked_at IS NULL'
  ).get(keyHash);

  if (existing) {
    // 已存在，更新 node_id（迁移场景）
    if (existing.node_id !== node_id) {
      db.prepare(
        'UPDATE licenses SET node_id = ?, hostname = ?, platform = ?, activated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(node_id, hostname, platform, existing.id);

      db.prepare(
        'INSERT INTO license_history (license_id, action, old_node_id, new_node_id, reason) VALUES (?,?,?,?,?)'
      ).run(existing.id, 'migrate', existing.node_id, node_id, 're-activate on new node');
    }
  } else {
    // 新激活
    const maxTerminals = PLAN_MAX_TERMINALS[plan];
    db.prepare(
      `INSERT INTO licenses (node_id, key_hash, plan, max_terminals, expires_at, hostname, platform)
       VALUES (?,?,?,?,?,?,?)`
    ).run(node_id, keyHash, plan, maxTerminals, expires_at, hostname, platform || 'unknown');

    db.prepare(
      'INSERT INTO license_history (license_id, action, new_node_id, reason) VALUES (?,?,?,?)'
    ).run(db.prepare('SELECT last_insert_rowid() as id').get().id, 'activate', node_id, 'new activation');
  }

  // 记录到历史
  const license = db.prepare('SELECT * FROM licenses WHERE key_hash = ? AND revoked_at IS NULL').get(keyHash);

  // 保存离线缓存
  if (online) {
    saveCache({
      key_hash: keyHash,
      plan: license.plan,
      max_terminals: license.max_terminals,
      expires_at: license.expires_at,
      node_id: license.node_id,
    });
  }

  return {
    is_valid: true,
    plan: license.plan,
    max_terminals: license.max_terminals,
    expires_at: license.expires_at,
    node_id: license.node_id,
  };
}

// ============================================================
// 吊销
// ============================================================

/**
 * POST /license/revoke
 * @param {string} license_key
 * @param {string} reason
 */
function revoke({ license_key, reason }) {
  const db = getDb();
  const keyHash = hashKey(license_key);

  const license = db.prepare(
    'SELECT * FROM licenses WHERE key_hash = ? AND revoked_at IS NULL'
  ).get(keyHash);

  if (!license) {
    return { ok: false, error: 'License not found or already revoked' };
  }

  db.prepare(
    'UPDATE licenses SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(license.id);

  db.prepare(
    'INSERT INTO license_history (license_id, action, old_node_id, reason) VALUES (?,?,?,?)'
  ).run(license.id, 'revoke', license.node_id, reason || 'user revoke');

  // 清除缓存
  clearCache();

  return {
    revoked: true,
    license_id: license.id,
    plan: license.plan,
  };
}

// ============================================================
// 状态查询
// ============================================================

/**
 * GET /license/status?node_id=xxx
 */
function status({ node_id }) {
  const db = getDb();

  // 优先查在线数据库
  let license = null;
  if (node_id) {
    license = db.prepare(
      'SELECT * FROM licenses WHERE node_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1'
    ).get(node_id);
  }

  // 如果没查到，尝试离线缓存
  if (!license) {
    const cache = loadCache();
    if (cache && (!node_id || cache.node_id === node_id)) {
      return {
        is_valid: true,
        plan: cache.plan,
        mode: 'offline_cache',
        max_terminals: cache.max_terminals,
        expires_at: cache.expires_at,
        from_cache: true,
      };
    }
    return {
      is_valid: false,
      plan: null,
      mode: 'no_license',
    };
  }

  // 检查是否过期
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return {
      is_valid: false,
      plan: license.plan,
      mode: 'expired',
      expired_at: license.expires_at,
    };
  }

  // 计算已激活终端数
  const activeTerminals = db.prepare(
    'SELECT COUNT(*) as cnt FROM licenses WHERE key_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)'
  ).get(license.key_hash).cnt;

  return {
    is_valid: true,
    plan: license.plan,
    mode: 'active',
    active_terminals: activeTerminals,
    max_terminals: license.max_terminals,
    expires_at: license.expires_at,
    node_id: license.node_id,
  };
}

// ============================================================
// 升级
// ============================================================

/**
 * POST /license/upgrade
 * @param {string} license_key - 当前 License Key
 * @param {string} to_plan - 'team' | 'enterprise'
 * @param {string} payment_proof - 支付凭证（简化：不验证）
 */
function upgrade({ license_key, to_plan, payment_proof }) {
  const db = getDb();
  const keyHash = hashKey(license_key);

  const oldLicense = db.prepare(
    'SELECT * FROM licenses WHERE key_hash = ? AND revoked_at IS NULL'
  ).get(keyHash);

  if (!oldLicense) {
    return { ok: false, error: 'License not found' };
  }

  const fromPlan = oldLicense.plan;
  if (fromPlan === to_plan) {
    return { ok: false, error: 'Same plan, no upgrade needed' };
  }

  // 计算差价
  const diffKey = `${fromPlan}_to_${to_plan}`;
  const priceDiff = UPGRADE_PRICE_DIFF[diffKey];
  if (priceDiff === undefined) {
    return { ok: false, error: `No upgrade path from ${fromPlan} to ${to_plan}` };
  }

  // 签发新 key（格式：UPGD-XXXXXXXX）
  const newKeyHash = crypto.createHash('sha256')
    .update(license_key + to_plan + Date.now())
    .digest('hex').substring(0, 16).toUpperCase();
  const newKey = `UPGD-${newKeyHash}`;
  const newKeyHashDigest = hashKey(newKey);
  const maxTerminals = PLAN_MAX_TERMINALS[to_plan];

  // 旧 License 吊销
  db.prepare('UPDATE licenses SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?').run(oldLicense.id);

  // 新 License 插入
  db.prepare(
    `INSERT INTO licenses (node_id, key_hash, plan, max_terminals, expires_at, hostname, platform)
     VALUES (?,?,?,?,?,?,?)`
  ).run(oldLicense.node_id, newKeyHashDigest, to_plan, maxTerminals, null, oldLicense.hostname, oldLicense.platform);

  const newLicense = db.prepare('SELECT * FROM licenses WHERE key_hash = ? AND revoked_at IS NULL').get(newKeyHashDigest);

  // 历史
  db.prepare(
    'INSERT INTO license_history (license_id, action, old_plan, new_plan, reason) VALUES (?,?,?,?,?)'
  ).run(oldLicense.id, 'upgrade', fromPlan, to_plan, `upgrade: ${fromPlan}→${to_plan}, diff ¥${priceDiff}`);

  db.prepare(
    'INSERT INTO license_history (license_id, action, old_node_id, new_plan) VALUES (?,?,?,?)'
  ).run(newLicense.id, 'activate', oldLicense.node_id, to_plan);

  // 更新离线缓存
  saveCache({
    key_hash: newKeyHashDigest,
    plan: newLicense.plan,
    max_terminals: newLicense.max_terminals,
    expires_at: newLicense.expires_at,
    node_id: newLicense.node_id,
  });

  return {
    ok: true,
    new_license_key: newKey,
    old_license_revoked: true,
    from_plan: fromPlan,
    to_plan: to_plan,
    price_diff: priceDiff,
  };
}

// ============================================================
// 试用版激活（内置，无需真实 key）
// ============================================================

function activateTrial({ node_id, hostname, platform }) {
  return activate({
    license_key: `TEST-${node_id}-${Date.now()}`,
    node_id,
    hostname,
    platform,
    online: true,
  });
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  activate,
  revoke,
  status,
  upgrade,
  activateTrial,
  hashKey,
  loadCache,
  clearCache,
  PLAN_PRICE,
  PLAN_MAX_TERMINALS,
  UPGRADE_PRICE_DIFF,
  getDb,
  closeDb,
};