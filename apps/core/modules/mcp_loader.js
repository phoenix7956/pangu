/**
 * modules/mcp_loader.js
 * 盘古 · MCP Server 配置加载器
 *
 * 加载 config/mcp_servers.json,返回 enabled 的 server 列表。
 * 设计: 纯函数(读文件 + JSON 解析 + 过滤),无副作用,易测试。
 *
 * TL-3 改造 (2026-07-23 11:30):
 * - 加 scanDir(dir) 扫 <dir>/<server>/server.js 或 SKILL.md
 * - 加 loadMcpServers(scanDirs) 向后兼容: 无参数=旧行为(json only)
 * - 死配置告警: json enabled=true 但 command_path 不存在
 * - 目录 server 未在 json → auto_discovered=true enabled=true 加入
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'mcp_servers.json');

/**
 * 加载 MCP server 配置 (TL-3 改造版 — 向后兼容)
 *
 * @param {Array<string>} [scanDirs] - 额外扫描的目录 (TL-3 新增). 无参数 = 旧行为 (json only)
 * @returns {Array<{name, transport, command, args, env, enabled, description, auto_discovered?}>}
 * @throws {Error} 配置文件不存在或解析失败
 */
function loadMcpServers(scanDirs) {
  // 1. 读 json enabled list (旧行为)
  const jsonServers = loadMcpServersFromJson();
  // 2026-08-02 修: dedup 必须含 disabled 条目 — loadMcpServersFromJson 过滤了 enabled:false,
  // 导致 json 里标记禁用的 server 又被 dir scan 自动注册回来 (evomap 等 4 个尸体复活)
  let _allJsonNames = new Set();
  try { for (const s of loadAllMcpServers()) _allJsonNames.add(s.name); } catch (_) {}
  for (const s of jsonServers) _allJsonNames.add(s.name);

  // 2. 死配置告警 (json enabled 但 command_path 不存在)
  for (const s of jsonServers) {
    // 2026-08-02: 裸命令名 (node/npx) 先按 launchd PATH 兜底解析再判死, 避免误报 + spawn ENOENT
    try { s.command = require('./mcp_adapter')._resolveCommand(s.command); } catch (_) {}
    if (s.enabled && s.command && !fs.existsSync(s.command)) {
      console.warn(`[mcp-loader] dead config: ${s.name} enabled but command not found: ${s.command}`);
    }
  }

  // 3. 扫目录 (TL-3 新增) — 必须在 json 加载后, 才能用 jsonServers.find 判重
  if (Array.isArray(scanDirs) && scanDirs.length > 0) {
    for (const dir of scanDirs) {
      const dirServers = scanDir(dir);
      for (const ds of dirServers) {
        if (!_allJsonNames.has(ds.name)) {
          // 自动注册 (auto_discovered=true)
          jsonServers.push(Object.assign({}, ds, { auto_discovered: true }));
          console.log('[mcp-loader] auto-discovered:', ds.name, '@', ds.command);
        }
      }
    }
  }

  return jsonServers;
}

/**
 * 2026-07-24 (真 brief batch1): 解析 ${VAR} 环境变量. PANGU_HOME 默认推 __dirname/.. (Pangu repo 根)
 * mcp_servers.json 配的 "${PANGU_HOME}/mcp_servers/xxx" 借此解析成绝对 path
 */
function resolveEnvVars(p, fallbackRoot) {
  if (typeof p !== 'string') return p;
  return p.replace(/\$\{([^}]+)\}/g, (m, varName) => {
    const v = process.env[varName];
    if (v && v.trim()) return v;
    // Fallback 顺序:
    // 1. PANGU_HOME 推到 Pangu repo 根 (apps/core/../..) — 跟 mcp_servers.json 配对 (server.js 在 ~/pangu/mcp_servers/)
    // 2. 跟 health.js 一致 ~/.pangu
    if (varName === 'PANGU_HOME' && fallbackRoot) return fallbackRoot;
    console.warn('[mcp-loader] env var ' + varName + ' not set, leave as literal');
    return m;  // 保留原样, 让 spawn 失败更明显
  });
}

/**
 * 内部: 从 json 读 enabled servers (解析 ${PANGU_HOME} 等环境变量, 2026-07-24 batch1)
 */
function loadMcpServersFromJson() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`mcp_servers.json not found at ${CONFIG_PATH}`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse mcp_servers.json: ${e.message}`);
  }
  if (!raw.servers || !Array.isArray(raw.servers)) {
    return [];
  }
  // PANGU_HOME 默认 Pangu repo 根 (mcp_servers/ 在 repo 内). apps/core/modules/../../.. = repo 根
  const panguRoot = process.env.PANGU_HOME || path.resolve(__dirname, '../../..');  // apps/core/modules/../../.. = repo 根
  // 解析每 server 的 ${PANGU_HOME} + cwd/env 里的变量
  return raw.servers.filter(s => s.enabled !== false).map(s => ({
    ...s,
    command: resolveEnvVars(s.command, panguRoot),
    args: Array.isArray(s.args) ? s.args.map(a => resolveEnvVars(a, panguRoot)) : s.args,
    cwd: s.cwd ? resolveEnvVars(s.cwd, panguRoot) : s.cwd,
    env: s.env ? Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, resolveEnvVars(v, panguRoot)])) : s.env,
  }));
}

/**
 * TL-3 改造: 扫 <dir>/<server-name>/ 找 server.js 或 SKILL.md
 * 解析 SKILL.md frontmatter 拿 id/name/description
 *
 * @param {string} dir - MCP server 目录
 * @returns {Array<{name, command, args, env, description, transport: 'stdio'}>}
 */
function scanDir(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return [];
  }
  const results = [];
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const serverDir = path.join(dir, entry);
    if (!fs.statSync(serverDir).isDirectory()) continue;
    // 找入口: server.js 优先, 其次 package.json#main, 其次 SKILL.md (推断)
    const serverJs = path.join(serverDir, 'server.js');
    const pkgJson = path.join(serverDir, 'package.json');
    let command = null;
    if (fs.existsSync(serverJs)) {
      command = serverJs;
    } else if (fs.existsSync(pkgJson)) {
      // 解析 package.json 看 main + bin
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
        if (pkg.main) command = path.join(serverDir, pkg.main);
        else if (pkg.bin) {
          const binName = typeof pkg.bin === 'string' ? pkg.bin : Object.keys(pkg.bin)[0];
          command = path.join(serverDir, pkg.bin[binName] || binName);
        }
      } catch (_) {}
    }
    if (!command) continue;  // 没入口 → 跳过
    // 2026-08-02 修: 入口是 .js 时不能直接 spawn (shebang #!/usr/bin/env node 在 launchd 极简 PATH 下找不到 node)
    // 改用 daemon 自己的 node (process.execPath) 显式带起, EACCES/ENOENT 双治
    let entryArgs = [];
    if (command.endsWith('.js')) { entryArgs = [command]; command = process.execPath; }
    // SKILL.md frontmatter 解析 (简化版: 拿首段 description)
    let description = '';
    const skillMd = path.join(serverDir, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      try {
        const m = fs.readFileSync(skillMd, 'utf8');
        // frontmatter: --- ... --- 拿 description 字段
        const fm = m.match(/^---\n([\s\S]*?)\n---/);
        if (fm) {
          const desc = fm[1].match(/^description:\s*(.+)$/m);
          if (desc) description = desc[1].trim().replace(/^["']|["']$/g, '');
        }
      } catch (_) {}
    }
    results.push({
      name: entry,
      command,
      args: entryArgs,
      env: {},
      description,
      transport: 'stdio',
    });
  }
  return results;
}

// 加: 返所有 (包括 enabled=false) - Pangu UI 加/编 MCP server 配置需要
function loadAllMcpServers(configPath = CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`mcp_servers.json not found at ${configPath}`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse mcp_servers.json: ${e.message}`);
  }
  return raw.servers || [];
}

/**
 * 校验 server 配置的合法性(给调用方决定要不要连接)
 *
 * @param {object} server
 * @returns {{valid: boolean, error?: string}}
 */
function validateServer(server) {
  if (!server.name || typeof server.name !== 'string') {
    return { valid: false, error: 'name missing or invalid' };
  }
  if (!server.transport) {
    return { valid: false, error: 'transport missing' };
  }
  const validTransports = ['stdio', 'http', 'sse', 'streamable-http'];
  if (!validTransports.includes(server.transport)) {
    return { valid: false, error: `transport must be one of ${validTransports.join(',')}` };
  }
  if (server.transport === 'stdio') {
    if (!server.command) {
      return { valid: false, error: 'stdio transport requires command' };
    }
    if (!server.args || !Array.isArray(server.args)) {
      return { valid: false, error: 'stdio transport requires args array' };
    }
  }
  return { valid: true };
}

/**
 * 保存 MCP server 配置(覆盖写)
 * 设计: 保留 _comment / _version 字段,原子写(.tmp + rename)
 *
 * @param {Array} servers - 完整 server 列表(不含 enabled=false 也会保留)
 * @param {string} configPath - 配置文件路径(可选,默认 CONFIG_PATH)
 * @returns {{ok: boolean, path: string, count: number}}
 */
function saveMcpServers(servers, configPath = CONFIG_PATH) {
  // 1. 读现有文件保留 _comment / _version
  let meta = {};
  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (raw._comment) meta._comment = raw._comment;
      if (raw._version) meta._version = raw._version;
    } catch (_) { /* ignore */ }
  }
  // 2. 合并 + 写
  const out = { ...meta, servers };
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, configPath);
  return { ok: true, path: configPath, count: servers.length };
}

module.exports = {
  loadMcpServers,
  saveMcpServers,
  validateServer,
  loadAllMcpServers,
  scanDir,
  loadMcpServersFromJson,
  CONFIG_PATH,
};
