'use strict';
const fs = require('fs');
const path = require('path');

const PANGU_SKILLS_DIR = path.join(__dirname || process.cwd(), '..', 'pangu_skills');
// 也支持从 pangu-single.js 注入 BASE_PATH
function setBasePath(bp) { PANGU_SKILLS_DIR_OVERRIDE = path.join(bp, 'pangu_skills'); }
let PANGU_SKILLS_DIR_OVERRIDE = null;

function getPanguSkillsDir() {
  return PANGU_SKILLS_DIR_OVERRIDE || PANGU_SKILLS_DIR;
}

/**
 * 创建 Pangu 自己的 skill (写到 pangu_skills/<name>/SKILL.md + 返回 SKILL 内容)
 * @param {object} spec - {name, description, command, args, transport, env, scripts}
 * @returns {object} {ok, name, path, skillMd}
 */
function createPanguSkill(spec) {
  if (!spec || !spec.name) return { ok: false, error: 'name required' };
  if (!spec.description) return { ok: false, error: 'description required' };
  if (!spec.command) return { ok: false, error: 'command required' };
  
  const dir = path.join(getPanguSkillsDir(), spec.name);
  if (fs.existsSync(dir)) {
    // Idempotent: skill already exists, return existing skill
    const skillFile = path.join(dir, 'SKILL.md');
    const existingContent = fs.existsSync(skillFile) ? fs.readFileSync(skillFile, 'utf8') : '';
    return { ok: true, name: spec.name, path: dir, skillMd: existingContent, existed: true };
  }
  
  fs.mkdirSync(dir, { recursive: true });
  
  // 写 SKILL.md
  const skillMd = formatSkillMd(spec);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd, 'utf8');
  
  // (可选) 写 scripts/
  if (Array.isArray(spec.scripts) && spec.scripts.length > 0) {
    const scriptsDir = path.join(dir, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    for (const s of spec.scripts) {
      if (s.name && s.content) {
        fs.writeFileSync(path.join(scriptsDir, s.name), s.content, 'utf8');
      }
    }
  }
  
  return { ok: true, name: spec.name, path: dir, skillMd };
}

function formatSkillMd(spec) {
  const frontmatter = [
    '---',
    `name: ${spec.name}`,
    `description: ${spec.description}`,
    `command: ${spec.command}`,
    `args: ${JSON.stringify(spec.args || [])}`,
    `transport: ${spec.transport || 'stdio'}`,
    spec.env ? `env: ${JSON.stringify(spec.env || {})}` : null,
    '---',
  ].filter(Boolean).join('\n');
  return frontmatter + '\n\n' + (spec.longDescription || spec.description) + '\n';
}

/**
 * 列出所有 Pangu 自定义 skill (form 创建的)
 * 不含 in-process 74 个 (那些由 panguToolsImpl 提供)
 */
function listPanguSkills() {
  const dir = getPanguSkillsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => {
      const skillFile = path.join(dir, d.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) return null;
      const content = fs.readFileSync(skillFile, 'utf8');
      const meta = parseFrontmatter(content);
      return { name: d.name, path: path.join(dir, d.name), source: 'pangu-form', ...meta };
    })
    .filter(Boolean);
}

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/);
  if (!m) return { description: '', body: md };
  const fm = m[1];
  const body = m[2].trim();
  const meta = {};
  fm.split('\n').forEach(line => {
    const mm = line.match(/^(\w+):\s*(.+)$/);
    if (mm) meta[mm[1]] = mm[2];
  });
  return { ...meta, body };
}

/**
 * 删除 Pangu 自定义 skill
 */
function deletePanguSkill(name) {
  const dir = path.join(getPanguSkillsDir(), name);
  if (!fs.existsSync(dir)) return { ok: false, error: 'not found: ' + name };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, name };
}

module.exports = {
  PANGU_SKILLS_DIR: () => PANGU_SKILLS_DIR_OVERRIDE || PANGU_SKILLS_DIR,
  setBasePath,
  getPanguSkillsDir,
  createPanguSkill,
  listPanguSkills,
  deletePanguSkill,
};
