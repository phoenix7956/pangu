'use strict';
/**
 * tests/roster-tools-drift-20261026.test.js
 *
 * 八将灵 tools 白名单 vs 后端 TOOLS_SCHEMA —— 漂移守卫 (第 107 批搬家)
 *
 * ── 为什么要有这条 ──
 *   上一轮 self-iterate 清了 j2_agent_loop.js 里 11 个幽灵工具, 角色白名单没同步,
 *   坎·planner 还挂 task_assign、震·reflector 还挂 strategy_rewind ——
 *   agent 真去调会失败, 而且是**运行时才炸**。
 *
 * ── 这条守卫的历史 (也是它必须待在这儿的理由) ──
 *   老版是 scripts/verify_roster_tools.py, 真源读 `apps/desktop/src/data/gua-roster.js`。
 *   2026-10-26 桌面端下线后那个文件没了, 老脚本走 SKIP 分支**静默退出 0** ——
 *   守卫还在, 但什么都不守了。
 *   现在真源全部在 core 内部, 且**真源缺失一律 FAIL**, 不许 SKIP。
 *
 * 守卫覆盖:
 *   1. 8 个角色的 tools 白名单里不许出现 schema 外的工具 (幽灵工具)
 *   2. 8 个角色都必须有 tools 数组 (不许因为改名/删字段而"少一个角色就没人查")
 *   3. tools 真源必须**加载到非空** (不许把"加载失败"当成"没有漂移")
 *   4. 真源文件不许缺失 —— 缺文件 = FAIL, 不是跳过
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');

const verify = require(path.join(CORE, 'scripts', 'verify_roster_tools.js'));

test('八将灵 tools 白名单与 TOOLS_SCHEMA 无漂移 (幽灵工具 = 0)', () => {
  const r = verify.check();
  assert.deepStrictEqual(r.ghosts, [], '幽灵工具 (角色挂了 schema 里没有的工具): ' + r.ghosts.join(', '));
  assert.strictEqual(r.ok, true);
});

test('8 个角色全都有 tools 数组 —— 不许有角色掉出检查范围', () => {
  const roles = verify.roleTools();
  assert.strictEqual(roles.size, 8, '角色数 = ' + roles.size + ' (应为 8)');
  const codes = verify.guaCodes().slice().sort();
  assert.deepStrictEqual(
    Array.from(roles.keys()).sort(),
    codes,
    'roleTools 覆盖的角色 ≠ GUA_CODES —— 有角色掉出检查范围了'
  );
});

test('工具真源加载得到且非空 (不许把加载失败当"无漂移")', () => {
  const known = verify.schemaTools();
  assert.ok(known.size >= 100, 'TOOLS_SCHEMA 只加载到 ' + known.size + ' 个工具 —— 真源没加载上');
  // 抽几个必须存在的关键工具, 确认不是空壳
  for (const t of ['task_done', 'write_file', 'exec_command', 'bazi_calc', 'hexagram_lookup']) {
    assert.ok(known.has(t), 'TOOLS_SCHEMA 里没有 ' + t);
  }
});

test('真源文件都在 (缺文件 = FAIL, 不是 SKIP)', () => {
  const must = [
    path.join(CORE, 'agents', 'gua-identity.js'),
    path.join(CORE, 'agents', 'sub-agent.js'),
    path.join(CORE, 'modules', 'tools_schema.js'),
    path.join(CORE, 'modules', 'tools_schema'),
  ];
  for (const p of must) {
    assert.ok(fs.existsSync(p), '真源缺失: ' + p);
  }
});

test('已下线的 apps/desktop 不再被任何真源引用', () => {
  // 防回潮: 有人再把真源指回前端, 桌面端下线就白做了。
  const src = [
    path.join(CORE, 'scripts', 'verify_roster_tools.js'),
    path.join(CORE, 'agents', 'gua-identity.js'),
    path.join(CORE, 'agents', 'sub-agent.js'),
  ];
  for (const p of src) {
    const txt = stripComments(fs.readFileSync(p, 'utf8'));
    assert.ok(
      !/desktop[\/\\]src/.test(txt),
      path.basename(p) + ' 又指回了 apps/desktop/src'
    );
  }
});

/**
 * 去注释 —— 注释里提到 apps/desktop 是**历史说明**, 不算"引用"。
 * 只看真代码, 才不会让"把旧路径写进注释里讲清楚为什么搬家"这种好习惯误报。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // 块注释
    .replace(/^\s*\/\/.*$/gm, ' ')           // 整行行注释
    .replace(/([^:])\/\/[^\n]*/g, '$1 ');    // 行尾行注释 (前面的 ':' 避开 http://)
}
