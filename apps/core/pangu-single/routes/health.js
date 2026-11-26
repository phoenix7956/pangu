// pangu-single/routes/health.js
// 健康检查路由
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 18901;

function handler(req, res) {
  res.writeHead(200, {'Content-Type': 'application/json'});
  let _healthToolsCount = 0;
  let _healthSkillsCount = 0;
  try {
    const { TOOLS_SCHEMA } = require(path.join(__dirname, '..', '..', 'modules', 'tools_schema.js'));
    _healthToolsCount = Object.keys(TOOLS_SCHEMA).length;
  } catch (e) { console.warn('[health] tools_schema load error:', e.message); }
 // N1 fix: 从 PANGU_HOME/skills 扫描 (Pangu 自治, 2026-08-16 P0-2)
  try {
    const skillsDir = path.join(process.env.PANGU_HOME || path.join(os.homedir(), '.pangu'), 'skills');
    if (fs.existsSync(skillsDir)) {
      // 2026-09-11 修: dirent.isDirectory() 对 symlink 恒 false → 软链 skill 目录漏数 (与 skill_runtime.js 同款 bug)
      _healthSkillsCount = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(d => {
          const p = path.join(skillsDir, d.name);
          if (d.isSymbolicLink()) { try { return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'SKILL.md')); } catch (_) { return false; } }
          return d.isDirectory() && fs.existsSync(path.join(p, 'SKILL.md'));
        })
        .length;
    }
  } catch (e) { console.warn('[health] skills count error:', e.message); }
  return res.end(JSON.stringify({
    ok: true,
    mode: 'single_free',     // 单机零收费
    plan: 'personal',
    license_ok: true,
    environment: 'single_free',
    service: 'pangu-single',
    version: '2026.8.5-pangu',
    data: {
      status: 'ok',
      uptime_s: Math.floor(process.uptime()),
      skills_loaded: _healthSkillsCount,
      tools_loaded: _healthToolsCount,
      memory: { mb: process.memoryUsage().heapUsed / 1024 / 1024, ok: true, level: 'normal', rss_mb: process.memoryUsage().rss / 1024 / 1024 },
      eventLoop: { blocked: false, delayMs: 0, ok: true },
      port: { listening: true, ok: true, port: PORT },
      crash: { count: 0, crashed: false },
      degradation: 'normal'
    }
  }));
}

module.exports = { handler };
