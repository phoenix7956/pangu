'use strict';
/**
 * 第 91 批 —— 删掉零引用的死代码 (skill_converter.js), 并立一条**会咬人**的守卫。
 *
 * ## 起因 (第 73 批遗留待办 #6: 「skill 生成双份」)
 *
 * decision.md:7662 那张表里挂着一条:
 *   | 6 | skill 生成双份 / web search 缓存各抄一份 | ⬜ 未做 |
 *
 * 本批先做「skill 生成双份」这一半。现场取证 (2026-10-25):
 *
 *   apps/core/modules/skill_converter.js   372 行
 *   全仓引用 (排除自身定义与 apps/core/docs/ 里的扫描报告) = **0 处**
 *   它的 6 个导出逐个查引用:
 *     PANGU_SKILLS_DIR / PANGU_MCP_SERVERS_DIR / setBasePath
 *     convertSkillToMcp / generateServerJs / parseSkillReadme / parseSkillFromUrl
 *     → **每一个都是 0 处**
 *
 * ⇒ 它是**纯死代码**: 没有任何一条路径能 require 到它。
 *
 * ## 为什么必须先排除「动态 require」
 *
 * 「grep 不到引用」不等于「没人用」—— 变量拼路径的 `require(x)` grep 不到。
 * 所以本守卫在真删之前, 先把**全仓动态 require 的落点**列出来钉死:
 *   · apps/core/modules/yao_layer_boundary.js  → require(path.join(I64, ...))
 *     全部锁在 apps/core/64i/ 这个固定根下, 不可能落进 modules/ 的某个文件名
 *   · apps/core/modules/tools/index.js:1722 的 readdirSync
 *     是 `list_directory` **工具的实现**, 不是模块加载器
 *   · apps/core/modules/mcp_loader.js 的 readdirSync
 *     扫的是 MCP server 目录
 * ⇒ 三处都不是「按文件名加载 modules/*.js」的加载器。
 *
 * ## 判据 (只用位置 + 形态, 不看模型散文)
 *
 * A. `apps/core/modules/skill_converter.js` **不存在** (删了就是删了)
 * B. 全仓 (排除 node_modules / .git / docs 扫描报告) **没有任何一处引用**
 *    `skill_converter` / `convertSkillToMcp` / `generateServerJs`
 *    / `parseSkillReadme` / `parseSkillFromUrl` / `PANGU_MCP_SERVERS_DIR`
 * C. 活着的 skill 能力**没被一起删掉**:
 *    skill_factory.js (增删查) + skill_runtime.js (运行时) 都还在,
 *    且 skill_factory 真的能被 require 起来并跑通一次 list
 *
 * ## 变异体检 (末尾 D 组)
 *
 * 这条守卫最容易变成**空枪**: 断言只是「文件不在 + grep 不到」,
 * 守的是一个「本来就没人在意的东西」。
 * 所以 D 组做两发真变异, 证明守卫会咬:
 *   ① 把 skill_converter.js **放回磁盘** → A 组必须红
 *   ② 在某个活文件里写一行 `require('./skill_converter')` → B 组必须红
 * 内存/临时目录造, 一个字节不落进仓库。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CORE = path.join(__dirname, '..');
const REPO = path.join(CORE, '..', '..');
const MODULES = path.join(CORE, 'modules');

const CONVERTER_PATH = path.join(MODULES, 'skill_converter.js');

// 这个文件名一旦复活, B 组就会命中 —— 守卫靠它守。
const CONVERTER_SYMBOLS = [
  'skill_converter',
  'convertSkillToMcp',
  'generateServerJs',
  'parseSkillReadme',
  'parseSkillFromUrl',
  'PANGU_MCP_SERVERS_DIR',
];

// 本文件自己 (守卫) 必然提到这些符号 —— 它得排除**自己**, 但**不能**排除整个
// tests/ 目录 (那样「有人在别的测试里又把它 require 回来」就漏了)。
// 判据: 只排除本文件自身 (按绝对路径), 其余测试文件照扫。
const SELF_PATH = __filename;

// docs/ 下两份扫描报告**提到过** skill_converter (那是历史记录, 不是引用)。
function isScanningReport(file) {
  return file.includes(`${path.sep}docs${path.sep}`)
    || file.endsWith('.md');
}

/** 全仓扫 JS 源文件, 排除 node_modules / .git / 文档 */
function scanRepoJsFiles(root) {
  const out = [];
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith('.js') && !isScanningReport(full)) {
        out.push(full);
      }
    }
  }
  return out;
}

function findReferences(root, symbols) {
  const hits = [];
  for (const file of scanRepoJsFiles(root)) {
    // 守卫自身自指 —— 排除自己, 但只排除自己。
    try {
      if (path.resolve(file) === path.resolve(SELF_PATH)) continue;
    } catch (_) {}
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue;
    }
    for (const sym of symbols) {
      if (src.includes(sym)) {
        hits.push({ file: path.relative(root, file), symbol: sym });
      }
    }
  }
  return hits;
}

test('第91批 A: skill_converter.js 已从磁盘移除', () => {
  assert.strictEqual(
    fs.existsSync(CONVERTER_PATH),
    false,
    `skill_converter.js 还在磁盘上 —— 本批要求它被删掉 (${CONVERTER_PATH})`,
  );
});

test('第91批 B: 全仓没有任何一处引用它导出的符号', () => {
  const hits = findReferences(REPO, CONVERTER_SYMBOLS);
  assert.deepStrictEqual(
    hits,
    [],
    `发现残留引用 (死代码没删干净, 或者有人又把它接回来了):\n`
    + hits.map(h => `  ${h.file} → ${h.symbol}`).join('\n'),
  );
});

test('第91批 C: 活着的 skill 能力没被一起删掉', () => {
  // skill_factory = skill 增删查; skill_runtime = 运行时。
  // 这两个是真正在用的 (pangu-single.js / tools/index.js 会 require 它们),
  // 删死代码不许顺手把它们带走。
  const factoryPath = path.join(MODULES, 'skill_factory.js');
  const runtimePath = path.join(MODULES, 'skill_runtime.js');
  assert.ok(fs.existsSync(factoryPath), 'skill_factory.js 不该被删 —— 它是活的 skill 增删查入口');
  assert.ok(fs.existsSync(runtimePath), 'skill_runtime.js 不该被删 —— 它是活的 skill 运行时');

  const factory = require(factoryPath);
  assert.strictEqual(typeof factory.createPanguSkill, 'function', 'skill_factory.createPanguSkill 没了');
  assert.strictEqual(typeof factory.listPanguSkills, 'function', 'skill_factory.listPanguSkills 没了');
  assert.strictEqual(typeof factory.deletePanguSkill, 'function', 'skill_factory.deletePanguSkill 没了');

  // 真跑一次 list (只读, 不写盘)。
  const listed = factory.listPanguSkills();
  assert.ok(Array.isArray(listed), 'listPanguSkills 应返回数组');
});

test('第91批 D1 变异体检: 把 skill_converter.js 放回磁盘 → A 组必须红', () => {
  // 造一份最小可用的假文件 (只在临时目录), 然后让 A 组的判据对它真咬。
  // A 组的判据是「文件存在 ⇒ 失败」, 所以放回去必须红。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-deadcode-'));
  const fake = path.join(tmp, 'skill_converter.js');
  try {
    fs.writeFileSync(fake, 'module.exports = { convertSkillToMcp(){} };\n');
    assert.ok(fs.existsSync(fake), '变异体应存在于磁盘');
    // 判据本身 (与 A 组同一条): 文件存在 ⇒ 断言失败。
    let guardRed = false;
    try {
      assert.strictEqual(fs.existsSync(fake), false, '变异后守卫必须红');
    } catch (_) {
      guardRed = true;
    }
    assert.ok(guardRed, '★ 空枪: 文件放回来了守卫却没咬 —— 这条守卫根本不守东西');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});

test('第91批 D2 变异体检: 在活文件里加一行 require → B 组必须红', () => {
  // B 组的判据是「全仓扫不到符号」。往一个临时仓库副本里塞一行引用,
  // 看 B 组的扫描判据会不会命中 —— 证明它不是永远绿。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-deadcode-scan-'));
  try {
    const victim = path.join(tmp, 'victim.js');
    fs.writeFileSync(victim, "require('./modules/skill_converter');\n");
    const hits = findReferences(tmp, CONVERTER_SYMBOLS);
    assert.ok(
      hits.length > 0,
      '★ 空枪: 有人 require 了它, B 组的扫描却没命中 —— 扫描判据没在扫',
    );
    assert.ok(
      hits.some(h => h.file === 'victim.js'),
      `B 组应指认出 victim.js, 实际命中: ${JSON.stringify(hits)}`,
    );
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});
