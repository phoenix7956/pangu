/**
 * apps/core/tests/shushu-core-20261022.test.js
 *
 * 第 38 批 —— 术数内核聚合层 (modules/shushu_core.js) 的守卫测试。
 *
 * 三道守卫:
 *   A「64i 零外部依赖」   —— 保住「64i 可以完全独立抽出来」这个前提
 *   B「每个原子模块都能加载」 —— 报出坏掉的那个
 *   C「术数命名族不许有孤儿」 —— 兜住 modules/ 侧显式清单的漂移
 *
 * ⚠️ 负例是这一批的重点。**守卫全绿不说明它有用, 咬人才算。**
 *   每条负例都在**临时目录**里造坏, 根目录是注入的 ——
 *   不改生产源文件(踩坑日志: 故障注入必须出进程边界, 磁盘也是共享的),
 *   不猴补丁全局(踩坑日志: node --test 并发会互相污染)。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CORE_ROOT = path.resolve(__dirname, '..');
const SC = require(path.join(CORE_ROOT, 'modules', 'shushu_core.js'));

// ── 临时树工具 ────────────────────────────────────────────────
//
// ⚠️ 每个测试**必须自己调一次** tmpTree() 拿独立的目录。
//   踩过的坑: 共享一个临时树 ⇒ node --test 顶层测试是**并发**的 ⇒
//   上一个测试造的坏文件漏进下一个测试 ⇒ 报出来的错像真 bug, 复现不了。
//   (跟「改生产源文件造负例」同一个病: 故障注入必须出进程边界。)
const _madeDirs = [];
function tmpTree() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-shushu-'));
  _madeDirs.push(d);
  return d;
}
function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}
process.on('exit', () => {
  for (const d of _madeDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 清理失败无所谓 */ }
  }
});

test('真树: 聚合层全部能力加载成功 (守卫 B)', () => {
  const h = SC.health();
  assert.equal(h.ok, true, '有模块加载失败: ' + JSON.stringify(h.failed));
  assert.equal(h.failedCount, 0);
  assert.deepEqual(h.failed, {});
});

test('真树: 能力清单覆盖 64i 磁盘上的每一个原子模块 (自动发现不许漏)', () => {
  const onDisk = SC.discoverI64Modules(path.join(CORE_ROOT, '64i'));
  const caps = SC.capabilities();
  const listed = new Set();
  for (const keys of Object.values(caps)) for (const k of keys) listed.add(k);
  for (const m of onDisk) {
    assert.ok(listed.has(m.key), `64i 原子模块 ${m.rel} 没进能力清单`);
  }
  // 反向: 清单里不该有磁盘上不存在的
  const diskKeys = new Set(onDisk.map(m => m.key));
  for (const [g, keys] of Object.entries(caps)) {
    if (g === 'modules' || g === 'guards') continue;   // 那两组是 modules/ 下的, 另算
    for (const k of keys) {
      assert.ok(diskKeys.has(k), `能力清单里有磁盘上不存在的能力 ${g}:${k}`);
    }
  }
});

test('真树: 64i 零外部依赖 (守卫 A) —— 保住「可完全独立抽出来」这个前提', () => {
  const dep = SC.dependencyReport(path.join(CORE_ROOT, '64i'));
  assert.equal(dep.ok, true,
    '64i 出现外部依赖: ' + JSON.stringify(dep.externalRequires));
  assert.deepEqual(dep.externalRequires, []);
  assert.ok(dep.moduleCount > 0, '64i 一个原子模块都没扫到 —— 扫描本身坏了');
  assert.ok(dep.internalRequires > 0, '64i 一个内部 require 都没扫到 —— 扫描本身坏了');
});

test('真树: 术数命名族没有孤儿 (守卫 C)', () => {
  const orphans = SC.findOrphanShushuModules(CORE_ROOT);
  assert.deepEqual(orphans, [], '有术数模块没登记进聚合层: ' + JSON.stringify(orphans));
});

test('真树: 装时自检不抛', () => {
  const r = SC.assertShushuCoreHealthy();
  assert.ok(r.atoms > 0);
  assert.equal(r.externalRequires, 0);
});

test('真树: 层图行数与 wc -l 一致 (不许自说自话)', () => {
  const L = SC.layerMap();
  // 自己数一遍 pangu-single.js 的换行符, 跟层图对账
  const abs = path.join(CORE_ROOT, 'pangu-single.js');
  const wc = (fs.readFileSync(abs, 'utf8').match(/\n/g) || []).length;
  assert.equal(L['pangu-single'].lines, wc,
    '层图说 ' + L['pangu-single'].lines + ' 行, wc -l 说 ' + wc + ' 行 —— 两者必须一致');
  assert.ok(L['64i'].lines > 0);
  assert.ok(L['modules'].lines > L['64i'].lines);
});

// ─────────────────────────────────────────────────────────────
// 负例 —— 守卫必须会咬人
// ─────────────────────────────────────────────────────────────

test('★ 负例: 64i 里出现外部依赖, 守卫 A 必须报出来', () => {
  const root = tmpTree();
  write(root, '64i/evil.js', "const x = require('some-npm-pkg');\nmodule.exports = x;\n");
  const dep = SC.dependencyReport(path.join(root, '64i'));
  assert.equal(dep.ok, false, '有外部依赖却报 ok=true —— 守卫哑火了');
  assert.ok(dep.externalRequires.length > 0, '一个外部依赖都没报出来');
  const hit = dep.externalRequires.find(e => e.target === 'some-npm-pkg');
  assert.ok(hit, '没点名 some-npm-pkg, 实际报的是: ' + JSON.stringify(dep.externalRequires));
  assert.ok(hit.module.includes('evil.js'), '报出来的模块名不对: ' + hit.module);
});

test('★ 负例: 注释里的 require 不算外部依赖 (别把文档示例当真依赖)', () => {
  const root = tmpTree();
  write(root, '64i/withcomments.js',
    "// 文档示例: require('axios') —— 这里是注释, 不该被算进去\n"
    + "/* 块注释里也可能有 require('lodash') */\n"
    + "const p = require('path');\nmodule.exports = p;\n");
  const dep = SC.dependencyReport(path.join(root, '64i'));
  assert.equal(dep.ok, true,
    '注释里的 require 被当成了真依赖: ' + JSON.stringify(dep.externalRequires));
});

test('★ 负例: 术数命名族出现孤儿, 守卫 C 必须报出来', () => {
  const root = tmpTree();
  write(root, 'modules/bazi_orphan.js', 'module.exports = {};\n');
  const orphans = SC.findOrphanShushuModules(root);
  assert.ok(orphans.length > 0, '孤儿没被报出来 —— 守卫 C 哑火了');
  assert.ok(orphans.some(o => o.key === 'bazi_orphan'),
    '报出来的不是 bazi_orphan: ' + JSON.stringify(orphans));
});

test('★ 负例: guard_patterns 不该被当成术数模块 (gua 前缀误撞 guard)', () => {
  const root = tmpTree();
  write(root, 'modules/guard_patterns.js', 'module.exports = {};\n');
  const orphans = SC.findOrphanShushuModules(root);
  assert.equal(orphans.length, 0,
    'guard_patterns 被误判成术数模块: ' + JSON.stringify(orphans));
});

test('★ 负例: 术数模块加载失败, 聚合层必须点名 (守卫 B)', () => {
  const root = tmpTree();
  // 走 64i 的**自动发现**那条路: 64i 侧所有原子模块都会被加载,
  // 所以「加载失败必被点名」在那一侧是**结构上**成立的。
  // (modules/ 侧是显式清单, 只加载登记过的; 那一侧的兜底是守卫 C 的孤儿检查。)
  write(root, '64i/broken.js', 'module.exports = ( => {\n');   // 语法错误
  const reg = SC.buildRegistry(root);
  assert.ok(reg.failed.length > 0, '加载失败没被报出来');
  const hit = reg.failed.find(f => f.key === 'broken');
  assert.ok(hit, '没点名 broken: ' + JSON.stringify(reg.failed));
  assert.ok(hit.error, '报出来了但没说为什么坏');
});

test('★ 负例: 清单指向的文件不存在, 必须报「清单悬空」而不是静默跳过', () => {
  const reg = SC.buildRegistry(tmpTree());
  const dangling = reg.failed.filter(f => /清单悬空/.test(f.error || ''));
  assert.ok(dangling.length > 0,
    '清单指向不存在的文件却没报出来 —— 那是静默跳过, 不是健壮');
});

test('★ 负例: 装时自检遇到上面三种坏, 必须抛 (不许吞)', () => {
  const root = tmpTree();
  write(root, '64i/evil2.js', "require('another-pkg');\nmodule.exports = 1;\n");
  write(root, 'modules/bazi_orphan2.js', 'module.exports = {};\n');
  assert.throws(
    () => SC.assertShushuCoreHealthy(root),
    (e) => {
      const msg = String(e.message);
      assert.ok(msg.includes('外部依赖'), '抛了但没提外部依赖: ' + msg);
      assert.ok(msg.includes('bazi_orphan2'), '抛了但没提孤儿模块: ' + msg);
      return true;
    },
    '自检遇到外部依赖+孤儿却没抛 —— 守卫在最该炸的地方没炸'
  );
});

test('★ 负例: 自检干净时不许抛 (别造出一堆假警报)', () => {
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-shushu-clean-'));
  fs.mkdirSync(path.join(clean, '64i'), { recursive: true });
  fs.writeFileSync(path.join(clean, '64i', 'a.js'), "module.exports = require('path');\n", 'utf8');
  // 干净树必然有「清单悬空」(modules/ 那批文件不在临时树里) ⇒ 只验「不因外部依赖/孤儿而抛」
  let err = null;
  try {
    SC.assertShushuCoreHealthy(clean);
  } catch (e) {
    err = e;
  }
  if (err) {
    const msg = String(err.message);
    assert.ok(!msg.includes('外部依赖'), '干净树不该报外部依赖: ' + msg);
    assert.ok(!msg.includes('孤儿'), '干净树不该报孤儿: ' + msg);
  }
});

// ============================================================
// 第 39 批补: 守卫 D「判据函数不许有只被守卫引用的孤岛」
//
// ⚠️ 这条守卫的由来是第 39 批在爻层边界守卫方向 B 上实跑抓到的**真洞**:
//   「判据写好了、测试在测、守卫在查, 但生产永远走不到」。
//   方向 B 守的是「某个函数在不在」, 于是:
//     删掉那个函数 ⇒ 报红(而生产零影响)
//     弄坏真判据   ⇒ 照样绿
//   守卫 D 把这个病 generalize: 扫 64i 全部判据型函数, 谁零生产调用就报出来。
// ============================================================

test('守卫 D: 真树没有孤岛判据 (判据都接在生产数据路上)', () => {
  const r = SC.findIsolatedJudges();
  assert.equal(r.checked > 0, true, '一条判据都没数出来 —— 这条守卫没法验');
  assert.equal(
    r.islands.length, 0,
    '真树不该有孤岛判据: ' + r.islands.map(i => i.fn + '(' + i.file + ')').join('; ')
  );
});

test('★ 负例: 造一个零调用的判据 → 必须被报出来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-iso-'));
  fs.mkdirSync(path.join(dir, '64i'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '64i', 'a.js'),
    "'use strict';\nfunction judgeTotallyOrphan(a, b) { return { established: true, force: 'full' }; }\n"
    + "module.exports = { judgeTotallyOrphan };\n",
    'utf8'
  );
  const r = SC.findIsolatedJudges(dir);
  assert.equal(r.islands.length, 1, '孤岛判据没被报出来: ' + JSON.stringify(r.islands));
  assert.equal(r.islands[0].fn, 'judgeTotallyOrphan');
});

test('★ 负例: 判据只被守卫引用(生产零调用)→ 照样算孤岛', () => {
  // 这才是那个洞的形状: 守卫在查它, 生产不用它。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-iso2-'));
  fs.mkdirSync(path.join(dir, '64i'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '64i', 'a.js'),
    "'use strict';\nfunction judgeGuardOnly(x) { return x; }\nmodule.exports = { judgeGuardOnly };\n",
    'utf8'
  );
  // 建一个**守卫层**文件(MODULE_GUARDS 里登记过的名字)引用它
  fs.writeFileSync(
    path.join(dir, 'modules', 'yao_layer_boundary.js'),
    "'use strict';\n// judgeGuardOnly 在这里被查\nmodule.exports = {};\n",
    'utf8'
  );
  const r = SC.findIsolatedJudges(dir);
  assert.equal(r.islands.length, 1, '只被守卫引用的判据没被报出来');
  assert.equal(r.islands[0].fn, 'judgeGuardOnly');
  assert.ok(
    r.islands[0].guardOnly.some(g => g.includes('yao_layer_boundary')),
    '没记录「被哪个守卫引用」: ' + JSON.stringify(r.islands[0])
  );
});

test('★ 负例: 合法形态不许误伤 (装时自检 / 同文件内部调用 / 生产入口直调)', () => {
  // ⚠️ 守卫误伤 = 白噪声, 下一个人会去改无辜的地方(第 39 批教训)。
  //   第一版就误伤了 3 个: assertBaseIntegrity(装时自检) /
  //   judgeRelation(同文件被 judgeSixCells 调) /
  //   assertJingfangTable(pangu-single.js 启动链直调) ⇒ 三条豁免就是为这个。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-iso3-'));
  fs.mkdirSync(path.join(dir, '64i'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
  // ① 装时自检: 定义文件里顶层直接调
  fs.writeFileSync(
    path.join(dir, '64i', 'a.js'),
    "'use strict';\nfunction assertSelfCheck() { return true; }\nassertSelfCheck();\n"
    + "module.exports = { assertSelfCheck };\n",
    'utf8'
  );
  // ② 同文件内部调用, 且调用方**自己也可达生产** ⇒ 内层被调用方也豁免
  fs.writeFileSync(
    path.join(dir, '64i', 'b.js'),
    "'use strict';\nfunction judgeInner(x) { return x; }\n"
    + "function judgeOuter(x) { return judgeInner(x); }\nmodule.exports = { judgeOuter };\n",
    'utf8'
  );
  // 让 judgeOuter 可达生产
  fs.writeFileSync(
    path.join(dir, 'modules', 'bazi_strength.js'),
    "'use strict';\nconst { judgeOuter } = require('../64i/b.js');\nmodule.exports = { judgeOuter };\n",
    'utf8'
  );
  // ③ 生产入口直调
  fs.writeFileSync(
    path.join(dir, '64i', 'c.js'),
    "'use strict';\nfunction assertFromEntry() { return true; }\nmodule.exports = { assertFromEntry };\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'pangu-single.js'),
    "'use strict';\nconst { assertFromEntry } = require('./64i/c.js');\nassertFromEntry();\n",
    'utf8'
  );
  const r = SC.findIsolatedJudges(dir);
  assert.equal(
    r.islands.length, 0,
    '合法形态被误伤了: ' + r.islands.map(i => i.fn).join('; ')
  );
});

test('★ 负例: 孤岛链不许被整条豁免 (同文件调用方自己也不可达生产)', () => {
  // ⚠️ 第 39 批实跑撞出来的: 只看「同文件被调用过」的话,
  //   judgeOuter(没人调) → judgeInner, 整条链都被放过 ——
  //   两条都是没人执行的判决。豁免必须是**可达性不动点**。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-iso4-'));
  fs.mkdirSync(path.join(dir, '64i'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '64i', 'a.js'),
    "'use strict';\nfunction judgeChainInner(x) { return x; }\n"
    + "function judgeChainOuter(x) { return judgeChainInner(x); }\nmodule.exports = { judgeChainOuter };\n",
    'utf8'
  );
  const r = SC.findIsolatedJudges(dir);
  const names = r.islands.map(i => i.fn).sort();
  assert.ok(
    names.includes('judgeChainOuter'),
    '链头(没人调)必须报出来: ' + names.join('; ')
  );
  assert.ok(
    names.includes('judgeChainInner'),
    '链尾也不许被豁免(调用方自己不可达): ' + names.join('; ')
  );
});

test('★ 负例: 交叉校验端白名单烂掉 → 必须报出来 (豁免不能变遮羞布)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-stale-'));
  fs.mkdirSync(path.join(dir, '64i'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
  // 守卫文件**不引用**白名单里的任何函数 ⇒ 豁免已失效
  fs.writeFileSync(
    path.join(dir, 'modules', 'yao_layer_boundary.js'),
    "'use strict';\nmodule.exports = {};\n",
    'utf8'
  );
  const r = SC.findStaleCrosscheckEnds(dir);
  assert.equal(r.ok, false, '白名单全烂了竟然没报出来');
  assert.ok(r.stale.length > 0);
  assert.ok(
    r.stale.every(s => s.fn && s.why),
    '每条都要带函数名和理由: ' + JSON.stringify(r.stale)
  );
});

test('交叉校验端白名单在真树上必须全部有效', () => {
  const r = SC.findStaleCrosscheckEnds();
  assert.equal(
    r.ok, true,
    '白名单里有函数没有守卫真的调: ' + r.stale.map(s => s.fn).join('; ')
  );
});

