// pangu-single/routes/pangu-meta.js
// /api/pangu/evolution / /api/pangu/tools / /api/tools/toggle / /api/pangu/skills
//
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const safeGuard = require('../safe-guard/global');
const { checkLocalOrigin } = require('./route_security');
// 2026-10-26 第 100 批: 账本目录走唯一真源 (modules/evolution_paths.js)
const { evolutionDir } = require('../../modules/evolution_paths');

function json(res, obj, status) {
  res.statusCode = status || 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
  // 2026-08-02 修: 返回 consumed 标记 — 之前返回 undefined, inline_router 误判未消费
  // → 掉到 404 handler 打 'headers already sent' 警告 (响应本身没坏, 但日志吓人)
  return { consumed: true };
}

async function handler(req, res, pathname) {
  if (pathname === '/api/pangu/evolution' && req.method === 'GET') {
    try {
      const evoDir = evolutionDir();
      if (!fs.existsSync(evoDir)) return json(res, { ok: true, data: { records: [], stats: { total: 0 } } });
      const allFiles = fs.readdirSync(evoDir).filter(f => f.endsWith('.jsonl')).sort();
      let allRecords = [];
      for (const f of allFiles) {
        try {
          const content = fs.readFileSync(path.join(evoDir, f), 'utf8');
          for (const line of content.split('\n').filter(Boolean)) {
            try { allRecords.push(JSON.parse(line)); } catch (e) { console.error('[evo-parse-skip]', e.message, 'line:', line.slice(0, 50)); }
          }
        } catch (e) {}
      }
      const today = new Date().toISOString().slice(0, 10);
      const todayRecords = allRecords.filter(r => r && typeof r.ts === 'string' && r.ts.startsWith(today));
      const total = allRecords.length;
      const success = allRecords.filter(r => {
        return r.effective_success === true || (r.effective_success == null && r.success === true);
      }).length;
      const successRate = total > 0 ? +(success / total * 100).toFixed(1) : 0;
      const durations = allRecords.filter(r => typeof r.duration_ms === 'number').map(r => r.duration_ms);
      const avgMs = durations.length > 0 ? Math.round(durations.reduce((a,b) => a+b, 0) / durations.length) : 0;
      const toolCounts = {}; const errCounts = {};
      for (const r of allRecords) {
        for (const t of r.tool_names || []) toolCounts[t] = (toolCounts[t] || 0) + 1;
        if (r.error) errCounts[String(r.error).slice(0, 60)] = (errCounts[String(r.error).slice(0, 60)] || 0) + 1;
      }
      return json(res, { ok: true, data: {
        days: allFiles.length,
        total,
        today: todayRecords.length,
        success_rate: successRate,
        avg_duration_ms: avgMs,
        top_tools: Object.entries(toolCounts).sort((a,b) => b[1]-a[1]).slice(0, 10),
        top_errors: Object.entries(errCounts).sort((a,b) => b[1]-a[1]).slice(0, 10),
        latest: allRecords.slice(-20).reverse()
      }});
    } catch (e) {
      safeGuard.writeCrash('evolution-error', e);
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  // ── /api/pangu/evolution/series —— 逐日时间序列 (画图用) ────────
  //
  // 为什么要单开一个端点, 不在前一个端点里一起给:
  //   /api/pangu/evolution 给的是**汇总 + 最近 20 条** (给状态页/命令行看);
  //   画趋势图要的是**逐日序列** —— 每天多少任务、成功多少、平均耗时多少。
  //   把序列塞进汇总端点 = 每次刷新都拖着几万行走, 而汇总页并不需要它。
  //
  // 账本目录走唯一真源 (modules/evolution_paths.js) —— 跟写方 (evolution_record.js)
  //   同一个目录, 不会出现「读的是沙箱、写的是生产」那种分裂。
  if (pathname === '/api/pangu/evolution/series' && req.method === 'GET') {
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      // 默认只看最近 60 天 (账本可能攒了一年多, 全量返回没必要);
      // days=0 = 全量 (调试用)。
      const days = Math.max(0, Math.min(Number(q.get('days')) || 60, 3650));
      const evoDir = evolutionDir();
      if (!fs.existsSync(evoDir)) {
        return json(res, { ok: true, data: { days: [], total_days: 0, grand_total: 0 } });
      }
      const allFiles = fs.readdirSync(evoDir)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort()
        .slice(-days || undefined);

      const series = [];
      const modelCount = {};
      let grandTotal = 0;
      for (const f of allFiles) {
        const day = f.replace(/\.jsonl$/, '');
        let recs = [];
        try {
          recs = fs.readFileSync(path.join(evoDir, f), 'utf8')
            .split('\n').filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
            .filter(Boolean);
        } catch (e) { /* 单天文件读坏不该让整张图没了 */ }
        if (!recs.length) continue;

        const success = recs.filter(r =>
          r.effective_success === true || (r.effective_success == null && r.success === true)
        ).length;
        const durs = recs.filter(r => typeof r.duration_ms === 'number').map(r => r.duration_ms);
        const rounds = recs.filter(r => typeof r.rounds === 'number').map(r => r.rounds);
        const toolCalls = recs.reduce((a, r) =>
          a + (typeof r.tool_calls_total === 'number' ? r.tool_calls_total : 0), 0);
        const errors = recs.filter(r => r.error).length;
        for (const r of recs) {
          const m = r.model || r.provider || '';
          if (m) modelCount[m] = (modelCount[m] || 0) + 1;
        }
        grandTotal += recs.length;
        series.push({
          date: day,
          total: recs.length,
          success,
          failed: recs.length - success,
          success_rate: +(success / recs.length * 100).toFixed(1),
          avg_duration_ms: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0,
          max_duration_ms: durs.length ? Math.max.apply(null, durs) : 0,
          avg_rounds: rounds.length ? +(rounds.reduce((a, b) => a + b, 0) / rounds.length).toFixed(1) : 0,
          tool_calls: toolCalls,
          errors,
        });
      }

      return json(res, { ok: true, data: {
        days: series,
        total_days: series.length,
        grand_total: grandTotal,
        models: Object.entries(modelCount).sort((a, b) => b[1] - a[1]).slice(0, 12)
          .map(([model, count]) => ({ model, count })),
      }});
    } catch (e) {
      safeGuard.writeCrash('evolution-series-error', e);
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  if (pathname === '/api/pangu/agents' && req.method === 'GET') {
    try {
      const { getAgentCatalog } = require(path.join(__dirname, '..', '..', 'agents', 'registry'));
      const catalog = getAgentCatalog();
      return json(res, { ok: true, agents: catalog, count: catalog.length });
    } catch (e) {
      safeGuard.writeCrash('agents-catalog-error', e);
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  if (pathname === '/api/pangu/tools' && req.method === 'GET') {
    try {
      // 2026-07-27 修: MAIN_GENERAL_TOOLS 直接 import 真源, 不再硬编码副本
      // 修前: 13 项副本 (缺 session_recall, 跟 tools_schema.js 真源 14 项漂移)
      // 修后: 跟真源同步, R15 修一直说要统一但没真做
      const { getAllToolSchemas, MAIN_GENERAL_TOOLS_FOR_LLM } = require(path.join(__dirname, '..', '..', 'modules', 'tools_schema.js'));
      const tools = getAllToolSchemas();
      const roleMapPath = path.join(__dirname, '..', '..', 'config', 'tool_role_map.json');
      let roleMap = {};
      try { roleMap = JSON.parse(fs.readFileSync(roleMapPath, 'utf8')); } catch (e) { if (process.env.PANGU_DEBUG) console.warn('[pangu] suppressed error:', e.message); }
      const toolRoles = {};
      for (const [role, info] of Object.entries(roleMap)) {
        if (role.startsWith('_') || !info || !Array.isArray(info.tools)) continue;
        for (const toolName of info.tools) {
          if (!toolRoles[toolName]) toolRoles[toolName] = [];
          toolRoles[toolName].push(role);
        }
      }
      // tier 映射: 按角色 + tool name pattern 推断
      const tierByRole = {
        // 键跟 tool_role_map.json 一起换成拼音 (2026-10-18)。之前这里是**又一份
        // 手抄的英文身份表**, 而 toolRoles 是从 tool_role_map.json 的键建出来的 ——
        // 那份 config 一旦不跟着改, `tierByRole[roles[0]]` 就恒为 undefined,
        // 工具页上一片 "unknown", 而且不报错 (undefined || 'unknown' 兜住了)。
        li: '谋',
        kan: '谋',
        xun: '谋',
        zhen: '断',
        kun: '行',
        dui: '观',
        gen: '记忆',
        qian: '断',
      };
      // §0.49 batch3 + R13 修 + R15 集中: 主对话工具集, 直接 import tools_schema.js 真源
      // 真源 14 项 (web_search, read_file, current_time, cache_*, 4 个 64 卦, 3 个 metrics, trend_judgment, session_recall)
      // 老副本只 13 项, 缺 session_recall, 漂移
      const MAIN_GENERAL_TOOLS = new Set(MAIN_GENERAL_TOOLS_FOR_LLM);
      const tierByNamePattern = [
        [/^memory_/, '记忆'],
        [/^cache_/, '缓存'],
        [/^network_|^http_|^web_/, '网络'],
        [/^system_|^process_/, '系统'],
      ];
      const inferTier = (name, roles) => {
        for (const [pat, tier] of tierByNamePattern) {
          if (pat.test(name)) return tier;
        }
        if (roles && roles.length > 0) return tierByRole[roles[0]] || 'unknown';
        return 'unknown';
      };
      let cfgNode = {};
      try {
        // 节点配置走通用名 node.json (本机例: example-node.json 拷成 node.json);
        // 不写死机器名 (开源后别人机器没有 your-mac.json)。
        const cfgPath2 = path.join(os.homedir(), '.pangu', 'config', 'nodes', 'node.json');
        if (fs.existsSync(cfgPath2)) cfgNode = JSON.parse(fs.readFileSync(cfgPath2, 'utf8'));
      } catch (e) { if (process.env.PANGU_DEBUG) console.warn('[pangu] suppressed error:', e.message); }
      const toolsWithRoles = tools.map(t => {
        const name = t.function && t.function.name;
        const roles = toolRoles[name] || [];
        const enabled = !(cfgNode && cfgNode.tools && Array.isArray(cfgNode.tools.disabled) && cfgNode.tools.disabled.includes(name));
        // 推断 tier + implemented
        const tier = inferTier(name, roles);
        const implemented = true; // schema 存在 = 实现了 (handlers 在 tools/index.js)
        const exposed = enabled; // enabled = 暴露给 LLM, disabled = 不暴露
        // §0.49 batch3 大改: per-sub-agent 暴露 (不是全局)
        // 逻辑: 有 role_map 归属 = 只该 sub-agent 调; 主对话通用工具 = 主对话调; 两者都有 = 两个都调
        const isMain = MAIN_GENERAL_TOOLS.has(name);
        const exposedFor = {};
        for (const r of roles) exposedFor[r] = enabled;
        if (isMain) exposedFor['main'] = enabled;
        return Object.assign({}, t, {
          roles,
          meta: Object.assign({}, t.meta || {}, {
            source: 'in-process',
            enabled,
            implemented,
            tier,
            exposed_to_llm: exposed,
            exposed_for: exposedFor,        // per-sub-agent 暴露矩阵
            is_main_general: isMain,         // 是否主对话通用
          }),
        });
      });
      const roleStats = {};
      ['kun', 'li', 'dui', 'xun', 'kan', 'zhen', 'qian', 'gen'].forEach(role => {
        roleStats[role] = (roleMap[role] && roleMap[role].tools || []).length;
      });
      // §0.49 batch3 大改: exposed_by_role — 每个 sub-agent 能调几个
      const exposedByRole = { main: 0 };
      ['kun', 'li', 'dui', 'xun', 'kan', 'zhen', 'qian', 'gen'].forEach(r => exposedByRole[r] = 0);
      for (const t of toolsWithRoles) {
        if (!t.meta.enabled) continue;
        for (const [r, exp] of Object.entries(t.meta.exposed_for)) {
          if (exp) exposedByRole[r] = (exposedByRole[r] || 0) + 1;
        }
      }
      // §0.49 batch3: 整体统计
      const totalExposed = toolsWithRoles.filter(t => t.meta.exposed_to_llm).length;
      const totalImplemented = toolsWithRoles.filter(t => t.meta.implemented).length;
      return json(res, {
        ok: true,
        tools: toolsWithRoles,
        count: toolsWithRoles.length,
        exposed_to_llm: totalExposed,
        implemented_count: totalImplemented,
        role_stats: roleStats,
        exposed_by_role: exposedByRole,    // 新增: 每 sub-agent 可调工具数
        main_general_tools: [...MAIN_GENERAL_TOOLS],
      });
    } catch (e) {
      safeGuard.writeCrash('tools-meta-error', e);
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  if (pathname === '/api/tools/toggle' && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return { consumed: true };
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let req_body;
      try { req_body = JSON.parse(body || '{}'); }
      catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
      try {
        const toolName = req_body.name;
        const enabled = req_body.enabled;
        // 2026-07-28 fix: 原来写死某台机器的节点配置文件名，
        // 但实际 daemon cwd 是 apps/core/，CFG 在 apps/core/config/nodes/ 下。
        // 修：多路径 fallback，按"实际存在的"为准。
        // 2026-10-26 第 108 批: 去掉写死的机器名 —— 节点配置路径统一由
        // config/node_config.js 解析 (PANGU_NODE_CONFIG > node.json > 唯一候选)。
        const host = os.hostname().toLowerCase();
        const candidates = [
          path.join(os.homedir(), '.pangu', 'config', 'nodes', host + '.json'),
          path.join(__dirname, '..', '..', 'config', 'nodes', host + '.json'),
        ];
        try {
          candidates.push(require('../../config/node_config').requireNodeConfigPath());
        } catch (_) { /* 没配置就不加候选, 下面统一报 CFG_NOT_FOUND */ }
        const cfgPath = candidates.find(pp => pp && fs.existsSync(pp)) || candidates[candidates.length - 1];
        if (!fs.existsSync(cfgPath)) return json(res, { ok: false, error: 'CFG_NOT_FOUND', tried: candidates }, 404);
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        cfg.tools = cfg.tools || {};
        cfg.tools.disabled = Array.isArray(cfg.tools.disabled) ? cfg.tools.disabled : [];
        if (enabled) cfg.tools.disabled = cfg.tools.disabled.filter(n => n !== toolName);
        else if (!cfg.tools.disabled.includes(toolName)) cfg.tools.disabled.push(toolName);
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
        return json(res, { ok: true, tool: toolName, enabled, disabled_count: cfg.tools.disabled.length });
      } catch (e) {
        safeGuard.writeCrash('tools-toggle-error', e);
        return json(res, { ok: false, error: e.message }, 500);
      }
    });
    return { consumed: true };
  }

  // ===== /api/tools/test + /api/tools/call — 真调 handler =====
  // ChatRoom historically used /api/tools/call for the read-only metrics
  // refresh, while the settings panel uses /api/tools/test. Keep both names
  // on one implementation so the chat UI does not silently lose metrics.
  if ((pathname === '/api/tools/test' || pathname === '/api/tools/call') && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return { consumed: true };
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let req_body;
      try { req_body = JSON.parse(body || '{}'); }
      catch (_) { return json(res, { ok: false, error: 'INVALID_JSON' }, 400); }
      try {
        const toolName = req_body.name;
        const params = req_body.params || {};
        if (!toolName) return json(res, { ok: false, error: 'name required' }, 400);
        const { TOOLS } = require(path.join(__dirname, '..', '..', 'modules', 'tools', 'index.js'));
        const handler = TOOLS[toolName];
        if (typeof handler !== 'function') return json(res, { ok: false, error: { code: 'NO_HANDLER', message: 'TOOLS.' + toolName + ' 未注册' } }, 404);
        const t0 = Date.now();
        const result = await Promise.race([
          handler({ context: { user: 'pangu_toolsbox_test', action: 'test' }, params }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT_8s')), 8000)),
        ]);
        const elapsed_ms = Date.now() - t0;
        // The legacy chat endpoint expects the tool payload directly under
        // `result`; the settings test endpoint keeps its historical wrapper.
        if (pathname === '/api/tools/call' && result && result.ok && result.result !== undefined) {
          return json(res, { ok: true, tool: toolName, elapsed_ms, result: result.result });
        }
        return json(res, { ok: true, tool: toolName, elapsed_ms, result });
      } catch (e) {
        return json(res, { ok: false, error: { code: 'TEST_FAILED', message: e.message, stack: (e.stack || '').slice(0, 400) } }, 500);
      }
    });
    return { consumed: true };
  }

  // ===== 2026-08-22: /api/tools/schema/:name — 取单个 schema =====
  if (pathname.startsWith('/api/tools/schema/') && req.method === 'GET') {
    try {
      const toolName = decodeURIComponent(pathname.slice('/api/tools/schema/'.length));
      const { getToolSchema } = require(path.join(__dirname, '..', '..', 'modules', 'tools_schema.js'));
      const schema = getToolSchema ? getToolSchema(toolName) : null;
      if (!schema) return json(res, { ok: false, error: { code: 'NO_SCHEMA', message: 'schema 不存在: ' + toolName } }, 404);
      return json(res, { ok: true, tool: toolName, schema });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  if (pathname === '/api/pangu/skills' && req.method === 'GET') {
    try {
      // 2026-09-11: 内部 skills 唯一账本 — 只读 ~/.pangu/skills/ 目录 (symlink 兼容, 读 SKILL.md)。
      // 不再合并 catalog: 市场装的东西也落在本目录, settings/skills 与 marketplace 同源。
      const panguHome = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
      const skillsDir = path.join(panguHome, 'skills');
      const internal = [];
      if (fs.existsSync(skillsDir)) {
        for (const d of fs.readdirSync(skillsDir, { withFileTypes: true })) {
          if (d.name.startsWith('_') || d.name.startsWith('.')) continue;
          const sp = path.join(skillsDir, d.name);
          let isDir = d.isDirectory() && !d.isSymbolicLink();
          if (d.isSymbolicLink()) { try { isDir = fs.statSync(sp).isDirectory(); } catch (_) { isDir = false; } }
          if (!isDir) continue;
          const skillPath = path.join(sp, 'SKILL.md');
          if (!fs.existsSync(skillPath)) continue;
          try {
            const stat = fs.statSync(skillPath);
            const raw = fs.readFileSync(skillPath, 'utf8');
            const lines = raw.split('\n');
            const titleLine = lines.find(l => l.trim().startsWith('# ')) || '';
            const hi = lines.findIndex(l => l.trim().startsWith('# '));
            const descLines = lines.slice(hi + 1).filter(l => l.trim() && !l.startsWith('#')).slice(0, 3);
            // 2026-10-20: 自建 skill 在 frontmatter 里标 source: pangu-form。
            // 原来这里写死 source:'dir', 前端「自建」筛选认的是 'pangu-form' → 永远筛不到,
            // 自建列表永远是空的。改成读 frontmatter 的 source, 没标的仍算 'dir'。
            const fmBlock = raw.match(/^---\n([\s\S]*?)\n---/);
            const fmSource = fmBlock ? ((fmBlock[1].match(/^source:\s*(.+)$/m) || [])[1] || '').trim() : '';
            internal.push({
              name: d.name, path: skillPath,
              title: titleLine.replace(/^#+\s*/, '').trim(),
              description: descLines.join(' ').trim().slice(0, 300),
              size: stat.size, mtime: Math.floor(stat.mtimeMs), source: fmSource || 'dir'
            });
          } catch (e) { if (process.env.PANGU_DEBUG) console.warn('[pangu] skill parse error:', e.message); }
        }
      }
      // User-created/imported skills are persisted in config/pangu_skills.json.
      // Keep them visible alongside installed SKILL.md directories until the
      // storage migration is complete; dedupe by id/name so a catalog entry
      // cannot appear twice.
      const configPath = path.join(panguHome, 'config', 'pangu_skills.json');
      let configured = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        configured = Array.isArray(parsed) ? parsed : [];
      } catch (_) {}
      const merged = [...internal];
      const seen = new Set(internal.map(skill => String(skill.id || skill.name)));
      for (const skill of configured) {
        if (!skill || typeof skill !== 'object') continue;
        const key = String(skill.id || skill.name || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push({ ...skill, source: skill.source || 'config' });
      }
      return json(res, { ok: true, skills: merged, count: merged.length });
    } catch (e) {
      safeGuard.writeCrash('skills-list-error', e);
      return json(res, { ok: false, error: e.message }, 500);
    }
  }
  // P0-#23: plugin marketplace routes (local plugins from ~/.pangu-data/plugins/)
  if (pathname === '/api/plugins/list' && req.method === 'GET') {
    try {
      const { listPlugins } = require(path.join(__dirname, '..', '..', 'modules', 'plugin_loader'));
      const plugins = listPlugins();
      return json(res, { ok: true, plugins, count: plugins.length });
    } catch (e) {
      safeGuard.writeCrash('plugin-list-error', e);
      return json(res, { ok: false, error: e.message }, 500);
    }
  }
  if (pathname === '/api/plugins/search' && req.method === 'GET') {
    try {
      const { searchPlugins } = require(path.join(__dirname, '..', '..', 'modules', 'plugin_loader'));
      const kw = (new URL(req.url, 'http://x').searchParams.get('q') || '').trim();
      const plugins = kw ? searchPlugins(kw) : listPlugins();
      return json(res, { ok: true, plugins, count: plugins.length, keyword: kw });
    } catch (e) {
      safeGuard.writeCrash('plugin-search-error', e);
      return json(res, { ok: false, error: e.message }, 500);
    }
  }
  if (pathname === '/api/plugins/remove' && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return { consumed: true };
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const req_body = JSON.parse(body || '{}');
        const { removePlugin } = require(path.join(__dirname, '..', '..', 'modules', 'plugin_loader'));
        const { TOOLS } = require(path.join(__dirname, '..', '..', 'modules', 'tools', 'index.js'));
        const { TOOLS_SCHEMA } = require(path.join(__dirname, '..', '..', 'modules', 'tools_schema.js'));
        removePlugin(req_body.name, { handlers: TOOLS, schemas: TOOLS_SCHEMA, list: Object.keys(TOOLS) });
        return json(res, { ok: true, removed: req_body.name });
      } catch (e) {
        safeGuard.writeCrash('plugin-remove-error', e);
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return { consumed: true };
  }
  if (pathname === '/api/plugins/install' && req.method === 'POST') {
    if (!checkLocalOrigin(req, res)) return { consumed: true };
    // v1: 本地 install = 创建 plugin 目录 + 写 plugin.json (template-based)
    // v2: 接 marketplace API 拉远程
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const req_body = JSON.parse(body || '{}');
        const name = req_body.name;
        const version = req_body.version || '1.0.0';
        if (!name) return json(res, { ok: false, error: 'plugin name required' }, 400);
        const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '');
        if (safe !== name) return json(res, { ok: false, error: 'plugin name 含非法字符' }, 400);
        const fs2 = require('fs');
        const path2 = require('path');
        const root = path2.join(require('os').homedir(), '.pangu-data', 'plugins');
        const dir = path2.join(root, safe);
        if (fs2.existsSync(dir)) return json(res, { ok: false, error: 'plugin 已存在, 先 remove' }, 400);
        fs2.mkdirSync(path2.join(dir, 'tools'), { recursive: true });
        // template plugin.json
        const pluginJson = {
          name: safe,
          version,
          author: req_body.author || 'feng',
          description: req_body.description || `Plugin ${safe} installed at ${new Date().toISOString()}`,
          tools: [
            {
              name: req_body.tool_name || 'sample_tool',
              description: req_body.tool_description || 'Sample tool, edit handler in tools/',
              schema: {
                type: 'object',
                properties: {
                  input: { type: 'string', description: 'sample input' },
                },
              },
              handler: `./tools/${req_body.tool_name || 'sample_tool'}.js`,
            },
          ],
        };
        fs2.writeFileSync(path2.join(dir, 'plugin.json'), JSON.stringify(pluginJson, null, 2));
        // template handler
        const handlerPath = path2.join(dir, pluginJson.tools[0].handler);
        const handlerCode = `// Sample plugin handler for ${safe}
'use strict';
module.exports = async function handler(params, ctx) {
  return { ok: true, result: { echoed: params, ctx_keys: Object.keys(ctx || {}) } };
};
module.exports.schema = pluginJson.tools[0].schema;  // optional
`;
        // 注: schema 不应该跟 handler 绑在一起 — 走 plugin.json 内嵌更准
        fs2.writeFileSync(handlerPath, `// Sample plugin handler for ${safe}
'use strict';
module.exports = async function handler(params, ctx) {
  return { ok: true, result: { echoed: params, ctx_keys: Object.keys(ctx || {}) } };
};
`);
        return json(res, { ok: true, installed: safe, path: dir, message: '下次 daemon restart 后生效' });
      } catch (e) {
        safeGuard.writeCrash('plugin-install-error', e);
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return { consumed: true };
  }

  // P0-#20: SDK tool routes (local SDK tools from ~/.pangu-data/tools/<name>/)
  if (pathname === '/api/sdk/tools/list' && req.method === 'GET') {
    try {
      const { listSdkTools } = require(path.join(__dirname, '..', '..', 'modules', 'tools_sdk'));
      const tools = listSdkTools();
      return json(res, { ok: true, tools, count: tools.length });
    } catch (e) {
      safeGuard.writeCrash('sdk-tools-list-error', e);
      return json(res, { ok: false, error: e.message }, 500);
    }
  }
  if (pathname === '/api/sdk/tools/add' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { addSdkTool } = require(path.join(__dirname, '..', '..', 'modules', 'tools_sdk'));
        const req_body = JSON.parse(body || '{}');
        const r = addSdkTool(req_body);
        return json(res, Object.assign({ ok: true }, r));
      } catch (e) {
        safeGuard.writeCrash('sdk-tools-add-error', e);
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return { consumed: true };
  }
  if (pathname === '/api/sdk/tools/remove' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { removeSdkTool } = require(path.join(__dirname, '..', '..', 'modules', 'tools_sdk'));
        const { TOOLS } = require(path.join(__dirname, '..', '..', 'modules', 'tools', 'index.js'));
        const { TOOLS_SCHEMA } = require(path.join(__dirname, '..', '..', 'modules', 'tools_schema.js'));
        const req_body = JSON.parse(body || '{}');
        removeSdkTool(req_body.name, { handlers: TOOLS, schemas: TOOLS_SCHEMA, list: Object.keys(TOOLS) });
        return json(res, { ok: true, removed: req_body.name });
      } catch (e) {
        safeGuard.writeCrash('sdk-tools-remove-error', e);
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return { consumed: true };
  }

  // P0-#21: hooks routes (local hooks from ~/.pangu-data/hooks/<name>.js)
  if (pathname === '/api/hooks/list' && req.method === 'GET') {
    try {
      const { listHooks } = require(path.join(__dirname, '..', '..', 'modules', 'hooks'));
      const hooks = listHooks();
      return json(res, { ok: true, hooks, count: hooks.length });
    } catch (e) {
      safeGuard.writeCrash('hook-list-error', e);
      return json(res, { ok: false, error: e.message }, 500);
    }
  }
  if (pathname === '/api/hooks/add' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const req_body = JSON.parse(body || '{}');
        const name = req_body.name;
        if (!name) return json(res, { ok: false, error: 'name required' }, 400);
        const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '');
        if (safe !== name) return json(res, { ok: false, error: 'name 含非法字符' }, 400);
        if (!req_body.code) return json(res, { ok: false, error: 'code (string) required' }, 400);
        const fs2 = require('fs');
        const path2 = require('path');
        const root = path2.join(require('os').homedir(), '.pangu-data', 'hooks');
        if (!fs2.existsSync(root)) fs2.mkdirSync(root, { recursive: true });
        const filePath = path2.join(root, safe + '.js');
        if (fs2.existsSync(filePath)) return json(res, { ok: false, error: 'hook 已存在, 先 remove' }, 400);
        fs2.writeFileSync(filePath, req_body.code);
        return json(res, { ok: true, installed: safe, path: filePath, message: '下次 daemon restart 后生效' });
      } catch (e) {
        safeGuard.writeCrash('hook-add-error', e);
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return { consumed: true };
  }
  if (pathname === '/api/hooks/remove' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const req_body = JSON.parse(body || '{}');
        const safe = String(req_body.name).replace(/[^a-zA-Z0-9_-]/g, '');
        if (safe !== req_body.name) return json(res, { ok: false, error: 'name 含非法字符' }, 400);
        const fs2 = require('fs');
        const path2 = require('path');
        const filePath = path2.join(require('os').homedir(), '.pangu-data', 'hooks', safe + '.js');
        if (!fs2.existsSync(filePath)) return json(res, { ok: false, error: 'hook 不存在' }, 400);
        fs2.unlinkSync(filePath);
        return json(res, { ok: true, removed: req_body.name });
      } catch (e) {
        safeGuard.writeCrash('hook-remove-error', e);
        return json(res, { ok: false, error: e.message }, 400);
      }
    });
    return { consumed: true };
  }

  // P0-#37: metrics live SSE endpoint (推实时 metrics)
  if (pathname === '/api/metrics/live' && req.method === 'GET') {
    // SSE — 推 metrics_query 数据 每 2s (简化版: 一次返全部 + close)
    // 真正 live 需 event emitter, v1 不做 (跟 §0.51 双端战略 一致: Web UI 拉数据)
    try {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const { metricsDashboard } = require(path.join(__dirname, '..', '..', 'modules', 'metrics'));
      const sessionId = (new URL(req.url, 'http://x').searchParams.get('session_id') || 'default');
      const scope = (new URL(req.url, 'http://x').searchParams.get('scope') || 'session');
      const r = await metricsDashboard({ session_id: sessionId });
      const data = r.ok ? r.result : {};
      // 2026-08-04 修 (Bug #1 ERR_HTTP_HEADERS_SENT): 客户端断连后 writeHead 已被发, 再 write 抛错
      try { res.write('event: metrics\ndata: ' + JSON.stringify({ session_id: sessionId, scope, ts: Date.now(), data }) + '\n\n'); } catch (e) { /* 连接已关, 忽略 */ }
      try { res.write('event: end\ndata: {"note":"v1 单次推"}\n\n'); } catch (e) { /* 连接已关, 忽略 */ }
      res.end();
      return { consumed: true };
    } catch (e) {
      console.error('[pangu-meta] /api/metrics/live error:', e && e.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      } else {
        try { res.end(); } catch (closeErr) { /* SSE connection already closed */ }
      }
    }
  }

  // P0-#37: metrics alerts — 检 token 超限 / tool 失败 / cost 超限
  if (pathname === '/api/metrics/alerts' && req.method === 'GET') {
    try {
      const { metricsDashboard } = require(path.join(__dirname, '..', '..', 'modules', 'metrics'));
      const sessionId = (new URL(req.url, 'http://x').searchParams.get('session_id') || 'default');
      const r = await metricsDashboard({ session_id: sessionId });
      const data = r.ok ? r.result : {};
      const alerts = [];
      // Alert 规则 (可配置, v1 写死):
      const TOTAL_LIMIT = parseInt(process.env.PANGU_TOKEN_LIMIT || '100000', 10);
      const FAIL_LIMIT = parseInt(process.env.PANGU_FAIL_LIMIT || '10', 10);
      const total = (data.total_input || 0) + (data.total_output || 0);
      if (total > TOTAL_LIMIT) {
        alerts.push({ level: 'error', code: 'TOKEN_LIMIT_EXCEEDED', message: `总 token ${total} 超过限制 ${TOTAL_LIMIT}`, value: total, threshold: TOTAL_LIMIT });
      } else if (total > TOTAL_LIMIT * 0.8) {
        alerts.push({ level: 'warning', code: 'TOKEN_LIMIT_NEAR', message: `总 token ${total} 接近限制 ${TOTAL_LIMIT} (${(total / TOTAL_LIMIT * 100).toFixed(0)}%)`, value: total, threshold: TOTAL_LIMIT });
      }
      const failRate = data.by_tool ? Object.values(data.by_tool).reduce((s, t) => s + (t.calls || 0), 0) : 0;
      // 简化: 累计调用 ≥ FAIL_LIMIT 就 warn
      if (failRate >= FAIL_LIMIT) {
        alerts.push({ level: 'warning', code: 'TOOL_CALLS_HIGH', message: `本 session 调 tool ${failRate} 次 (阈值 ${FAIL_LIMIT})`, value: failRate, threshold: FAIL_LIMIT });
      }
      return json(res, { ok: true, session_id: sessionId, alerts, count: alerts.length, ts: Date.now() });
    } catch (e) {
      safeGuard.writeCrash('metrics-alerts-error', e);
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  // P0-#37: list sessions (给 dashboard 多 session 切换用)
  if (pathname === '/api/metrics/sessions' && req.method === 'GET') {
    try {
      const fs2 = require('fs');
      const path2 = require('path');
      const root = path2.join(require('os').homedir(), '.pangu-data', 'metrics');
      if (!fs2.existsSync(root)) return json(res, { ok: true, sessions: [], count: 0 });
      const files = fs2.readdirSync(root).filter(f => f.startsWith('session_') && f.endsWith('.json'));
      const sessions = files.map(f => {
        try {
          const j = JSON.parse(fs2.readFileSync(path2.join(root, f), 'utf8'));
          return { session_id: j.session_id || f.replace(/^session_|\.json$/g, ''), record_count: j.record_count || (j.records ? j.records.length : 0), mtime: fs2.statSync(path2.join(root, f)).mtimeMs };
        } catch (_) { return null; }
      }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
      return json(res, { ok: true, sessions, count: sessions.length });
    } catch (e) {
      safeGuard.writeCrash('metrics-sessions-error', e);
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  return { consumed: false };
}

module.exports = { handler };
