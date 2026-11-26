/**
 * skill_use.js — 内置 skill 读取工具 (2026-08-07)
 *
 * 背景: 4 个 echo 模式 MCP 桥 (pangu-mcp-dev-workflow 等) 干的事就是"把 SKILL.md 文本回给 LLM"。
 * 老板拍: 这是基础设施, 应该内置 — 一个 skill_use 工具顶掉全部 echo MCP 桥。
 *
 * 用法:
 *   { query: "关键词" }      → 列出匹配的 skill (name + description)
 *   { name: "skill-name" }   → 返回该 skill 的 SKILL.md 全文 (截 6000 字符保上下文)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// modules/tools/ 上 4 级 = 仓库根 (跟 tools/index.js REPO_ROOT 同款锚点)
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');

function _skillsDirs() {
  const dirs = [
    path.join(process.env.PANGU_HOME || path.join(os.homedir(), '.pangu'), 'skills'),
    path.join(REPO_ROOT, 'skills'),
  ];
  return [...new Set(dirs)].filter(d => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } });
}

function _parseDescription(skillMd) {
  const m = skillMd.match(/^description:\s*["']?([^"'\n]+)["']?\s*$/m);
  return m ? m[1].trim() : '';
}

// 列出全部 skill: [{name, description, dir}] (后目录覆盖同名, 跟 skill_runtime 一致)
function _listSkills() {
  const byName = new Map();
  for (const dir of _skillsDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const mdPath = path.join(dir, e.name, 'SKILL.md');
      let md = null;
      try { md = fs.readFileSync(mdPath, 'utf8'); } catch (_) { continue; }
      byName.set(e.name, { name: e.name, description: _parseDescription(md), dir: path.join(dir, e.name) });
    }
  }
  return [...byName.values()];
}

async function skillUse(ctx) {
  const { params = {} } = ctx || {};
  const fail = (code, message) => ({ ok: false, data: null, error: { code, message } });

  // 读单个 skill 全文
  if (params.name) {
    const hit = _listSkills().find(s => s.name === params.name);
    if (!hit) {
      const available = _listSkills().map(s => s.name);
      return fail('NOT_FOUND', `skill "${params.name}" 不存在。可用: ${available.join(', ') || '(空)'}`);
    }
    let content;
    try { content = fs.readFileSync(path.join(hit.dir, 'SKILL.md'), 'utf8'); }
    catch (e) { return fail('READ_FAILED', e.message); }
    const CAP = 6000;
    const truncated = content.length > CAP;
    return {
      ok: true,
      data: {
        name: hit.name,
        description: hit.description,
        content: truncated ? content.slice(0, CAP) : content,
        truncated,
        note: truncated ? `SKILL.md 超过 ${CAP} 字符已截断, 完整文件: ${path.join(hit.dir, 'SKILL.md')}` : undefined,
      },
    };
  }

  // 列表/搜索
  const q = (params.query || '').toLowerCase();
  let skills = _listSkills();
  if (q) skills = skills.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  return {
    ok: true,
    data: {
      count: skills.length,
      skills: skills.map(s => ({ name: s.name, description: s.description })),
      note: '用 name 参数读具体 skill 全文。',
    },
  };
}

module.exports = skillUse;
