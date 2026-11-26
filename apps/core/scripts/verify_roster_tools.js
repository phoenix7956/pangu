#!/usr/bin/env node
'use strict';
/**
 * scripts/verify_roster_tools.js — 八将灵 tools 白名单 vs 后端 TOOLS_SCHEMA 漂移检查
 *
 * ── 2026-10-26 第 107 批 (桌面端下线): 真源从「已下线的前端文件」搬回 core ──
 *   老版 (verify_roster_tools.py) 的真源是 `apps/desktop/src/data/gua-roster.js`,
 *   前端下线后那个文件没了 ⇒ 老脚本走 `SKIP: 找不到 …` 分支**静默退出 0** ——
 *   守卫还在, 但什么都不守了。这是最阴的一种坏法, 必须堵死。
 *
 * 现在的真源 (全部在 core 内部, 都在):
 *   - 角色名单: agents/gua-identity.js  GUA_CODES (8 个拼音码)
 *   - 角色白名单: agents/sub-agent.js     ROLES[code].tools
 *   - 工具真源: modules/tools_schema.js   TOOLS_SCHEMA (门面, 内部合并 13 个域文件)
 *
 * 用法: node scripts/verify_roster_tools.js
 * 退出码: 0 = 无漂移; 1 = 有幽灵工具 / 缺角色 / 真源缺失
 */

const path = require('path');

const CORE = path.join(__dirname, '..');

/**
 * 拿工具真源。
 *
 * ⚠ 必须 require **门面** modules/tools_schema.js, 不能正则扫源文件:
 *   第 97 批把 TOOLS_SCHEMA 拆成 modules/tools_schema/<域>.js 十三个文件,
 *   正则只扫主文件 ⇒ 拆出去的那 90 个工具全部不可见 ⇒ 幽灵工具会漏检。
 *   (老 python 脚本就是栽在这儿。)
 */
function schemaTools() {
  const mod = require(path.join(CORE, 'modules', 'tools_schema.js'));
  const schema = mod.TOOLS_SCHEMA || {};
  const names = Object.keys(schema);
  if (names.length === 0) throw new Error('TOOLS_SCHEMA 为空 —— 真源没加载上, 不许当"无漂移"');
  return new Set(names);
}

/** 角色名单 (8 个拼音码) */
function guaCodes() {
  const id = require(path.join(CORE, 'agents', 'gua-identity.js'));
  const codes = id.GUA_CODES || [];
  if (codes.length !== 8) {
    throw new Error('GUA_CODES 长度 = ' + codes.length + ' (应为 8) —— 角色表坏了');
  }
  return codes.slice();
}

/** 每个角色的 tools 白名单 */
function roleTools() {
  const sub = require(path.join(CORE, 'agents', 'sub-agent.js'));
  const roles = sub.ROLES || {};
  const out = new Map();
  for (const code of guaCodes()) {
    const r = roles[code];
    if (!r) throw new Error('ROLES 里没有角色 ' + code + ' —— 角色表和 GUA_CODES 对不上');
    if (!Array.isArray(r.tools)) {
      throw new Error('ROLES.' + code + '.tools 不是数组 —— 白名单被删了/改名了');
    }
    out.set(code, r.tools.slice());
  }
  return out;
}

/**
 * 跑检查。
 * @returns {{ok: boolean, ghosts: string[], missing: string[], schemaCount: number, checked: number}}
 */
function check() {
  const known = schemaTools();
  const ghosts = [];
  const missing = [];
  const roles = roleTools();
  let checked = 0;
  for (const [code, tools] of roles) {
    for (const t of tools) {
      checked++;
      if (!known.has(t)) ghosts.push(code + ':' + t);
    }
  }
  // 反向: schema 里的工具也不该有"声明了却没人实现"的幽灵。
  // 这里只报 **角色表引用不到** 的那一侧, 避免噪音。
  return { ok: ghosts.length === 0 && missing.length === 0, ghosts, missing, schemaCount: known.size, checked };
}

if (require.main === module) {
  try {
    const r = check();
    console.log('schema tools = ' + r.schemaCount + ', 检查角色 = 8, 引用次数 = ' + r.checked);
    if (r.ghosts.length) {
      console.log('GHOST: ' + JSON.stringify(r.ghosts));
      console.log('FAIL: 角色白名单引用了 tools_schema 里没有的工具 —— 补后端实现, 或从白名单里删掉');
      process.exit(1);
    }
    console.log('OK: 八将灵 tools 白名单与后端 TOOLS_SCHEMA 一致');
    process.exit(0);
  } catch (e) {
    // 真源缺失/坏了 ⇒ **FAIL**, 绝不 SKIP 静默通过。
    console.error('FAIL: ' + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

module.exports = { check, schemaTools, roleTools, guaCodes };
