/**
 * Pangu · 术数内核聚合层 (shushu_core.js)
 *
 * 2026-10-22 第 38 批立。定位: **术数内核的能力清单 + 单一入口 + 三道守卫**。
 *
 * ═══════════════════════════════════════════════════════════════
 * 它回答老板 10-21 的第一个问题: 「盘古现在分几个部分？能不能完全独立开？」
 * ═══════════════════════════════════════════════════════════════
 * decision.md §二 是**当时的答案**（写在文档里的层表）。但文档里的数字会漂 ——
 * 「64i 7847 行 / modules 47588 行」是 10-21 的快照, 10-22 就已经不准了。
 * 本层把那个答案变成**活的**: 行数实时数, 依赖实时扫, 能力清单实时列。
 *
 * 更要紧的是它顺手立了三道守卫, 都是这个项目反复栽过的同一类病:
 *
 *   守卫 A「64i 零外部依赖」
 *     「64i 可以完全独立抽出来」这个前提, 一直只有**文档里的断言**, 从没机器验过。
 *     哪天有人在 64i 里 require 了一个 npm 包, 64i 立刻不再可抽 —— 而且
 *     **一声不响**。本层扫全部 require, 出现非 node 内置的依赖当场点名。
 *
 *   守卫 B「64i 每个原子模块都能加载」
 *     聚合层是**自动发现**的, 所以「新增原子模块忘了登记」在 64i 侧不可能发生
 *     (登记即发现)。真正会坏的是「模块加载不了」—— 报出来。
 *
 *   守卫 C「术数命名族不许有孤儿」
 *     modules/ 下大部分不是术数, 没法整体自动发现, 所以那一侧是**显式清单**。
 *     显式清单必然漂 —— 于是加一条: 凡文件名以 bazi / gua / chart 开头的
 *     .js (术数命名族), 都**必须**出现在清单里, 出现没登记的就报出来。
 *
 * ═══════════════════════════════════════════════════════════════
 * 边界 (老板定的重构范围, 一条没越)
 * ═══════════════════════════════════════════════════════════════
 *   · 不改 apps/core/kernel/ 下任何文件
 *   · 不改 64 卦推演逻辑本身
 *   · 本层**纯新增**, 不改任何现有模块的行为 (只加一个只读消费方: 启动链一行)
 *   · 本层不做任何推演 —— 算法仍由原子模块负责
 *
 * ⚠️ 已知局限 (写在文件里, 不藏):
 *   modules/ 侧的守卫只认 **bazi/gua/chart 三个命名前缀**。若将来术数模块
 *   用了别的命名 (例如 wuxing_*.js / najia_*.js), 守卫认不出来 ——
 *   那时要改的是**这个前缀集合**, 不是去掉守卫。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CORE_ROOT = path.resolve(__dirname, '..');   // apps/core
const I64_DIR = path.join(CORE_ROOT, '64i');

// 出处层 (2026-10-22 第 42 批) —— 术数内核的「每条公理从哪来」台账 + 守卫 E。
//   64i 内部零外部依赖的前提, 让它住在 64i/provenance.js 而不是 modules/ 里。
const provenance = require('../64i/provenance');

/** node 内置模块 —— 64i 允许依赖这些, 其余一律算「外部依赖」。 */
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http', 'https',
  'module', 'net', 'os', 'path', 'process', 'querystring', 'readline', 'stream',
  'string_decoder', 'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'zlib',
]);

/**
 * modules/ 下的术数服务 (显式清单)。
 *
 * 为什么是显式而不是自动发现: modules/ 一大半是通用基建(llm_caller / j2_agent_loop /
 * mcp_adapter …), 不是术数。自动发现整个目录会把 100+ 个无关模块塞进「术数内核」,
 * 那个清单就没有意义了。
 *
 * 代价 = 清单会漂 ⇒ 守卫 C 补上(见 findOrphanShushuModules)。
 */
const MODULE_SERVICES = [
  // 八字侧
  'bazi_intent',          // 生辰意图识别 → 入口分流(有生辰不起卦)
  'bazi_chart_facts',     // 排盘事实(四柱/十神/藏干…)
  'bazi_strength',        // 六格三态中层(排盘 → 生我/我生/克我/我克/同我/彼)
  // 批命「做题」口径 + 绕路闸门 (第 129 批, 2026-10-28):
  //   课件八条(题目原文照抄)与「出生地周围情况 = 出生地地理环境/调候」的唯一真源,
  //   同时是「不许为这一条派刀去查时代统计」那道闸门。
  'bazi_items',
  // 卦侧
  'gua_engine',           // 梅花真起卦(本卦/互卦/变卦/体用/六亲)
  'gua_block',            // 卦象块前置注入
  'gua_gate_kws',         // 起卦门词表(闲聊/谋断/要卦/查表/取数/执行 六档的唯一真源)
  'gua_answer_gate',      // 卦答门核验(答卦必须有机核验)
  'layer_plan',           // 分层编排(什么时候用哪层: 五行/64卦+6爻/串起来/六格/查表)
  'chart_claim_guard',    // 排盘「已核实」口径守卫
  'chart_verify_guard',   // 排盘核验门
  'chart_fidelity',       // 排盘保真
  'chart_answer_gate',    // 排盘答门
];

/** modules/ 下的术数守卫 (判据层, 与原子模块分开 —— 它们不产生数据, 只判对错)。 */
const MODULE_GUARDS = [
  'yao_layer_boundary',   // 爻层边界(爻动不改阴阳/五行)
  'yao_vector_consistency', // 爻向量自洽
];

/**
 * modules/ 下属于「术数命名族」的文件名模式。
 * 守卫 C 拿它判定「这个文件是不是术数模块」—— 判据是**命名约定**, 写在代码里,
 * 不是注释里(注释 ≠ 隔离)。
 *
 * ⚠️ 必须带词边界(后面只接 `_` 或到头)。踩过的坑: 用裸前缀 `gua` 时,
 * **`guard_patterns.js` 被当成术数模块**(gua 是 "guard" 的头三个字母) ——
 * 守卫当场误报。它是**通用**守卫正则真源(task_done 验收/反幻觉), 不是术数。
 */
const SHUSHU_MODULE_PATTERN = /^(bazi|gua|chart)(_|$)/;

/**
 * **判据交叉校验端** —— 设计上就只被守卫调用, 不走生产数据路。
 *
 * ⚠️ 为什么要有这个白名单:
 *   守卫 D 判「孤岛」的规则是「零生产数据路调用 ⇒ 孤岛」。但有一类函数
 *   **按设计**就不该进生产: 它们的职责是给**另一份独立的判据**当对照,
 *   让两层编码撞一下(不一致就报红)。这正是第 39 批 B3 干的事。
 *   不豁免它们 ⇒ 守卫 D 会把「交叉校验端」误报成孤岛 ⇒ **盘古起不来**
 *   (守卫 D 接在 assertShushuCoreHealthy 上, 报了就抛)。
 *
 * ⚠️ 白名单本身**必须会漂也被抓到** —— 所以守卫 D 额外查:
 *   白名单上的每个函数, 必须**真的**被某个守卫文件引用。
 *   哪天守卫不再调它(交叉校验废了), 白名单就成了遮羞布 ⇒ 报出来。
 *   理由写在 value 里, 谁改的、为什么, 一眼看得见。
 */
const JUDGE_CROSSCHECK_ENDS = Object.freeze({
  judgeKeByYinYang:
    'B3 交叉校验端: 与十神层正偏(七杀/正官)对撞。'
    + '生产走十神那条更老、被真源锁定的路, 这份是**第二编码**, 不接生产。',
  judgeShengByYinYang:
    'B1 交叉校验端: 验证「生边上五合不成立」(五合全是克边) —— '
    + '真源 1753-1766 五对逐对给的都是克边。生边不该有合。',
});

// ═══════════════════════════════════════════════════════════════
// 64i 自动发现
// ═══════════════════════════════════════════════════════════════

/**
 * 递归列出 64i 下的原子模块(跳过 tests/ 与 node_modules/)。
 *
 * ⚠️ 2026-10-22 第 42 批: 实现搬到 `64i/provenance.js` 了, 这里只做**转发**。
 *   原因: 铁律「一份东西抄两遍 = 迟早只改其中一份」——
 *   两份发现逻辑迟早会漂, 漂了以后「磁盘上有哪些层」和「台账登记了哪些层」就对不上,
 *   而那正是出处守卫要守的东西。
 * @returns {Array<{key:string, rel:string, abs:string, group:string}>}
 */
function discoverI64Modules(root = I64_DIR) {
  return provenance.discoverI64Modules(root).map((m) => ({
    key: m.key,
    rel: m.rel,
    abs: m.abs,
    group: m.rel.includes('/') ? m.rel.split('/')[0] : '64i',
  }));
}

/**
 * 加载一个模块。失败**不抛**, 记进 failed —— 聚合层在部分模块损坏时仍可用,
 * 并能通过 health() 把坏的那个点名。
 */
function _tryRequire(abs) {
  try {
    return { ok: true, value: require(abs) };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 构建能力表。
 * @param {string} [coreRoot] - apps/core 根(测试时注入临时目录)
 */
function buildRegistry(coreRoot = CORE_ROOT) {
  const i64Root = path.join(coreRoot, '64i');
  const groups = {};
  const failed = [];

  // ── 64i 原子模块 (自动发现) ──
  const discovered = discoverI64Modules(i64Root);
  for (const m of discovered) {
    const r = _tryRequire(m.abs);
    const g = groups[m.group] || (groups[m.group] = { _atoms: {}, _failed: [] });
    if (r.ok) g._atoms[m.key] = r.value;
    else {
      g._failed.push({ key: m.key, path: m.rel, error: r.error });
      failed.push({ group: m.group, key: m.key, path: m.rel, error: r.error });
    }
  }

  // ── modules/ 术数服务 + 守卫 (显式清单) ──
  for (const pair of [['modules', MODULE_SERVICES], ['guards', MODULE_GUARDS]]) {
    const name = pair[0];
    const list = pair[1];
    const g = groups[name] || (groups[name] = { _atoms: {}, _failed: [] });
    for (const key of list) {
      const rel = 'modules/' + key + '.js';
      const abs = path.join(coreRoot, 'modules', key + '.js');
      if (!fs.existsSync(abs)) {
        const err = '文件不存在(改名了? 清单悬空?)';
        g._failed.push({ key, path: rel, error: err });
        failed.push({ group: name, key, path: rel, error: err });
        continue;
      }
      const r = _tryRequire(abs);
      if (r.ok) g._atoms[key] = r.value;
      else {
        g._failed.push({ key, path: rel, error: r.error });
        failed.push({ group: name, key, path: rel, error: r.error });
      }
    }
  }

  return { groups, failed, discoveredCount: discovered.length };
}

// ── 缓存的单例 (生产用) ──────────────────────────────────────
let _registry = null;
function _registry0() {
  if (!_registry) _registry = buildRegistry();
  return _registry;
}

// ═══════════════════════════════════════════════════════════════
// 对外 API
// ═══════════════════════════════════════════════════════════════

/** 能力清单: { 组: [能力键...] } */
function capabilities() {
  const reg = _registry0();
  const out = {};
  for (const [g, mods] of Object.entries(reg.groups)) {
    out[g] = Object.keys(mods._atoms);
  }
  return out;
}

/** 健康: 哪些能力加载失败。空 = 全通。 */
function health() {
  const reg = _registry0();
  const failed = {};
  for (const [g, mods] of Object.entries(reg.groups)) {
    if (mods._failed && mods._failed.length) failed[g] = mods._failed;
  }
  return { ok: reg.failed.length === 0, failedCount: reg.failed.length, failed };
}

// ═══════════════════════════════════════════════════════════════
// 守卫 A: 64i 零外部依赖
// ═══════════════════════════════════════════════════════════════

const _REQUIRE_RE = /require\(\s*(['"])([^'"]+)\1\s*\)/g;

/**
 * 扫 64i 下所有原子模块的 require, 分三类:
 *   内部(相对路径) / node 内置 / **外部(违规)**
 *
 * @param {string} [root] - 64i 目录
 */
function dependencyReport(root = I64_DIR) {
  const mods = discoverI64Modules(root);
  const external = [];
  const builtins = new Set();
  let internal = 0;
  for (const m of mods) {
    let src;
    try {
      src = fs.readFileSync(m.abs, 'utf8');
    } catch (_) {
      continue;
    }
    // 去掉注释里的 require, 免得文档示例被当成真依赖
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    let mm;
    _REQUIRE_RE.lastIndex = 0;
    while ((mm = _REQUIRE_RE.exec(code)) !== null) {
      const target = mm[2];
      if (target.startsWith('./') || target.startsWith('../')) {
        internal++;
      } else if (NODE_BUILTINS.has(target)) {
        builtins.add(target);
      } else {
        external.push({ module: m.rel, target });
      }
    }
  }
  return {
    ok: external.length === 0,
    moduleCount: mods.length,
    internalRequires: internal,
    builtinRequires: Array.from(builtins).sort(),
    externalRequires: external,
  };
}

// ═══════════════════════════════════════════════════════════════
// 守卫 C: 术数命名族不许有孤儿
// ═══════════════════════════════════════════════════════════════

/**
 * modules/ 下凡文件名以 bazi/gua/chart 开头(即术数命名族)的 .js,
 * 都必须出现在 MODULE_SERVICES / MODULE_GUARDS 清单里。
 *
 * 显式清单会漂 —— 这条守卫是清单的**兜底**: 漂了当场报出是谁漂了。
 */
function findOrphanShushuModules(coreRoot = CORE_ROOT) {
  const dir = path.join(coreRoot, 'modules');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const listed = new Set([...MODULE_SERVICES, ...MODULE_GUARDS]);
  const orphans = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.js')) continue;
    if (e.name.startsWith('.')) continue;
    const base = e.name.replace(/\.js$/, '');
    if (!SHUSHU_MODULE_PATTERN.test(base)) continue;
    if (listed.has(base)) continue;
    orphans.push({ file: e.name, key: base });
  }
  return orphans;
}

// ═══════════════════════════════════════════════════════════════
// 守卫 D: 判据函数不许有「只被守卫引用」的孤岛
// ═══════════════════════════════════════════════════════════════

/**
 * 豁免 ①: **装时自检** —— 定义文件里 require 时就直接跑, 不靠别人调。
 *
 * 判据: 该函数名后面**紧跟一次调用**(`fnName();` 形式, 顶层语句),
 * 而不是出现在函数定义/导出清单里。
 *
 * 例: `hexagrams.js` 结尾的 `assertBaseIntegrity();` —— 64 卦基础数据漂了当场炸。
 */
function _isSelfInvokingSelfCheck(coreRoot, relFile, fn) {
  let src;
  try {
    src = fs.readFileSync(path.join(coreRoot, relFile), 'utf8');
  } catch (_) {
    return false;
  }
  // 顶层调用: 行首(可缩进) + fnName() + ;
  const re = new RegExp('^\\s*' + fn + '\\s*\\(\\s*\\)\\s*;', 'm');
  return re.test(src);
}

/**
 * 豁免 ②: **同文件内部被调用**, 且那个调用方**自己也可达生产**。
 *
 * ⚠️ 为什么不能只看「同文件被调用过」(第 39 批实跑撞出来的):
 *   一条**孤岛链**会被整条豁免掉 —— `judgeOuter` 没人调, 它调 `judgeInner`,
 *   于是 `judgeInner` 看着「被调用了」也被放过。两条都是没人执行的判决。
 *   ⇒ 必须是**可达性不动点**: 同文件调用方自己也得 reachable。
 *
 * 例(真树): `wuxing_strength.js` 的 `judgeSixCells` 调 `judgeRelation` ——
 *   生产走 `bazi_strength.js` → `judgeSixCells` → `judgeRelation`,
 *   两环都可达 ⇒ 不是孤岛。
 */
function _buildIntraFileCallEdges(coreRoot, judgeNames) {
  // edges: fn → [同文件里调它的其他判据函数]
  const edges = new Map();
  for (const name of judgeNames) edges.set(name, []);
  const files = _allJsFiles(coreRoot);
  for (const rel of files) {
    let src;
    try {
      src = fs.readFileSync(path.join(coreRoot, rel), 'utf8');
    } catch (_) {
      continue;
    }
    const lines = src.split('\n');
    // 先找本文件里定义了哪些判据函数
    const definedHere = new Set();
    for (const line of lines) {
      const m = /^\s*(?:async\s+)?function\s+((?:judge|check|assert|verify)\w+)\s*\(/.exec(line);
      if (m) definedHere.add(m[1]);
    }
    // 再找调用边 —— ⚠️ 必须跟踪**所在函数**(调用行和定义行常常不在同一行:
    //   `const cross = checkShiYingCrossCheck({ table });` 在 assertJingfangTable
    //   的函数体里, 但那一行只有被调者, 没有调用者 ⇒ 只按行匹配会漏掉这条边)
    let currentFn = null;
    let depth = 0;
    for (const line of lines) {
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      if (!code.trim()) continue;
      // 新的函数定义 ⇒ 切换当前函数上下文
      const defMatch = /^\s*(?:async\s+)?function\s+((?:judge|check|assert|verify)\w+)\s*\(/.exec(code);
      if (defMatch) {
        currentFn = defMatch[1];
        depth = 0;
      }
      // 调用边: 当前函数体内调了谁
      if (currentFn) {
        for (const callee of definedHere) {
          if (callee === currentFn) continue;
          if (!new RegExp('\\b' + callee + '\\s*\\(').test(code)) continue;
          if (new RegExp('function\\s+' + callee + '\\s*\\(').test(code)) continue;
          const arr = edges.get(currentFn) || [];
          if (!arr.includes(callee)) arr.push(callee);
          edges.set(currentFn, arr);
        }
      }
      // 大括号深度(只看本行增减) —— 回到 0 说明函数体结束
      const opens = (code.match(/\{/g) || []).length;
      const closes = (code.match(/\}/g) || []).length;
      depth += opens - closes;
      if (depth <= 0 && currentFn && opens === 0 && closes > 0) currentFn = null;
    }
  }
  return edges;
}

/** 列 coreRoot 下所有 .js(跳过测试/依赖/隐藏目录)。 */
function _allJsFiles(coreRoot) {
  const out = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'tests' || e.name === 'node_modules' || e.name === '__pycache__') continue;
        walk(abs);
        continue;
      }
      if (e.name.endsWith('.js')) out.push(path.relative(coreRoot, abs));
    }
  })(coreRoot);
  return out;
}

/**
 * 可达性不动点: 一个判据函数「可达」= 生产文件调它, 或它调某个可达的判据。
 * @param {Set<string>} productionCalled - 生产文件直接调到的判据名
 * @param {Map<string,string[]>} edges - caller → callee(同文件内)
 * @returns {Set<string>} reachable
 */
function _reachableJudges(productionCalled, edges) {
  const reachable = new Set(productionCalled);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [caller, callees] of edges.entries()) {
      if (!reachable.has(caller)) continue;
      for (const callee of callees) {
        if (!reachable.has(callee)) {
          reachable.add(callee);
          changed = true;
        }
      }
    }
  }
  return reachable;
}

/**
 * 豁免 ③: 被**生产入口文件**直接调到(如 `pangu-single.js` 的启动链)。
 *
 * 判据: 名字出现在 `pangu-single.js` / `kernel/index.js` 这类**入口**里,
 * 且该行不是注释。
 */
function _isCalledByProductionEntrypoint(coreRoot, fn) {
  const entries = ['pangu-single.js', path.join('kernel', 'index.js')];
  for (const rel of entries) {
    let src;
    try {
      src = fs.readFileSync(path.join(coreRoot, rel), 'utf8');
    } catch (_) {
      continue;
    }
    const lines = src.split('\n');
    for (const line of lines) {
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      if (!code.trim()) continue;
      if (new RegExp('\\b' + fn + '\\b').test(code)) return true;
    }
  }
  return false;
}

/**
 * 找那种「**判据写好了、测试在测、守卫在查，但生产永远走不到**」的函数。
 *
 * ⚠️ 这条守卫的由来是第 39 批实跑抓到的**真洞**, 不是设计出来的:
 *   爻层边界守卫的方向 B 要求 `wuxing_yinyang.js` 必须导出
 *   `judgeKeByYinYang`(理由:「五行层必须有阴阳维度」)。两头都验过:
 *     ① 删掉它 ⇒ 方向 B **报红**, 而**生产零影响**
 *     ② 十神层阴阳维度全坏 ⇒ 方向 B **照样绿**
 *   ⇒ 方向 B 守的是「某个函数在不在」, 不是「阴阳判据在生产里成不成立」。
 *   ⇒ 那个函数是**十神层的第二份编码**(实跑 20 对克关系, force 与正偏零不一致),
 *     生产走十神那条更老、被真源锁定的路。
 *
 * 判据怎么定才不误伤:
 *   - 只看 64i 层导出的**判据型**函数(judge 前缀 / check 前缀 /
 *     assert 前缀 / verify 前缀) ——
 *     工具函数(data getter)零调用是正常的, 不该报。
 *   - 调用方分三类:
 *       ① **生产数据路** —— modules/ 下的服务层 ⇒ 算「接上了」
 *       ② **守卫** —— modules/ 下的守卫层 ⇒ **不算**接上
 *          (守卫查你 ≠ 生产用你 —— 这正是那个洞的形状)
 *       ③ **自身 + 测试** ⇒ 不算
 *   - 只有 ②③、没有 ① ⇒ **孤岛**, 报出来。
 *
 * ⚠️ 为什么判据型函数该被这么严:
 *   判据是「对错的判官」。判官不出庭, 判决没人执行 ——
 *   守卫还green着, 生产已经悄悄给不出阴阳那一层的结论了。
 *
 * @param {string} [coreRoot] - apps/core 根目录(可注入, 负例在临时目录跑)
 * @returns {{ok: boolean, islands: Array<{fn: string, file: string, guardOnly: string[]}>, checked: number}}
 */
function findIsolatedJudges(coreRoot = CORE_ROOT) {
  const i64Dir = path.join(coreRoot, '64i');
  const modulesDir = path.join(coreRoot, 'modules');

  // ---- 收集 64i 层导出的判据型函数 ----
  const judges = [];   // {fn, file}
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'tests' || e.name === 'node_modules') continue;
        walk(abs);
        continue;
      }
      if (!e.name.endsWith('.js')) continue;
      let src;
      try {
        src = fs.readFileSync(abs, 'utf8');
      } catch (_) {
        continue;
      }
      const rel = path.relative(coreRoot, abs);
      // function judgeXxx(...)  或  const judgeXxx = ...  (导出即可)
      const re = /^(?:async\s+)?function\s+((?:judge|check|assert|verify)\w+)\s*\(/gm;
      let mm;
      while ((mm = re.exec(src)) !== null) {
        judges.push({ fn: mm[1], file: rel });
      }
    }
  })(i64Dir);

  // ---- 收集生产文件清单(按类别) ----
  //   ⚠️ 扫描范围必须覆盖**整个 apps/core**, 不只是 modules/:
  //     启动链在 `pangu-single.js` 里 —— `assertJingfangTable` /
  //     `assertYaoCiVariants` 都是**那儿**调的(装时自检), 不在 modules/ 下。
  //     第一版只扫 modules/ ⇒ 把这两个**误伤**成孤岛(守卫误伤 = 白噪声,
  //     下一个人会去改无辜的地方)。教训同第 39 批: 判据的扫描面要跟
  //     「生产真的在哪儿调用」对齐。
  const guardSet = new Set(MODULE_GUARDS);
  const prodFiles = [];   // 生产数据路
  const guardFiles = [];  // 守卫层
  (function walkProd(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        // 跳过测试与依赖目录 —— 测试引用不算「生产调用」
        if (e.name === 'tests' || e.name === 'node_modules' || e.name === '__pycache__') continue;
        walkProd(abs);
        continue;
      }
      if (!e.name.endsWith('.js')) continue;
      const base = e.name.replace(/\.js$/, '');
      const rel = path.relative(coreRoot, abs);
      if (guardSet.has(base)) guardFiles.push(rel);
      else prodFiles.push(rel);
    }
  })(coreRoot);

  const islands = [];
  // 生产文件直接调到的判据名
  const productionCalled = new Set();
  // 每个判据函数的**定义文件** —— 扫描生产调用方时必须跳过它,
  // 否则「定义那一行」本身会被当成调用(定义文件总是含函数名)⇒
  // 任何判据都「有生产调用方」, 守卫恒绿(又一个恒真守卫)。
  const defFileOf = new Map();
  for (const j of judges) defFileOf.set(j.fn, j.file);
  for (const rel of prodFiles) {
    // 跳过定义文件本身
    if ([...defFileOf.values()].includes(rel)) continue;
    let src;
    try {
      src = fs.readFileSync(path.join(coreRoot, rel), 'utf8');
    } catch (_) {
      continue;
    }
    for (const j of judges) {
      if (productionCalled.has(j.fn)) continue;
      if (defFileOf.get(j.fn) === rel) continue;
      const lines = src.split('\n');
      for (const line of lines) {
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        if (!code.trim()) continue;
        if (new RegExp('\\b' + j.fn + '\\b').test(code)) {
          productionCalled.add(j.fn);
          break;
        }
      }
    }
  }
  // 可达性不动点(豁免②: 同文件调用方自己也得可达生产)
  const judgeNames = judges.map(j => j.fn);
  const edges = _buildIntraFileCallEdges(coreRoot, judgeNames);
  const reachable = _reachableJudges(productionCalled, edges);

  for (const j of judges) {
    // 扫描所有非测试文件, 找谁引用了这个函数名
    const refs = { prod: [], guard: [], self: [] };
    const allFiles = [...prodFiles, ...guardFiles];
    for (const rel of allFiles) {
      let src;
      try {
        src = fs.readFileSync(path.join(coreRoot, rel), 'utf8');
      } catch (_) {
        continue;
      }
      // 词边界匹配函数名出现
      if (!new RegExp('\\b' + j.fn + '\\b').test(src)) continue;
      if (rel === j.file) { refs.self.push(rel); continue; }
      if (guardSet.has(path.basename(rel, '.js'))) refs.guard.push(rel);
      else refs.prod.push(rel);
    }
    // 零生产调用 ⇒ 孤岛, **除非**它有下面三种合法形态之一。
    //
    // ⚠️ 第一版把这三种也报成孤岛了 ⇒ **守卫误伤 = 白噪声**,
    //   下一个人会去改无辜的地方(同第 39 批的教训)。三种合法形态:
    //
    //   ① **装时自检**: 定义文件里 require 时就跑(不靠别人调)
    //      例: `hexagrams.js` 的 assertBaseIntegrity —— 漂了当场炸, 本来就在执行
    //   ② **同文件内部调用**: 判据 A 调判据 B, 外部只调 A
    //      例: `wuxing_strength.js` 的 judgeSixCells 调 judgeRelation
    //      —— 生产走 judgeSixCells, judgeRelation 是它的内层, 不是孤岛
    //   ③ **间接生产路径**: 本文件里的某个**已被生产调用的**函数调它
    if (refs.prod.length > 0) continue;
    if (_isSelfInvokingSelfCheck(coreRoot, j.file, j.fn)) continue;   // ①
    if (reachable.has(j.fn)) continue;                                // ②③
    if (_isCalledByProductionEntrypoint(coreRoot, j.fn)) continue;
    // 豁免: 声明过的**交叉校验端**(按设计只被守卫调)
    if (Object.prototype.hasOwnProperty.call(JUDGE_CROSSCHECK_ENDS, j.fn)) continue;
    if (refs.prod.length === 0) {
      islands.push({
        fn: j.fn,
        file: j.file,
        guardOnly: refs.guard,
      });
    }
  }

  return {
    ok: islands.length === 0,
    islands,
    checked: judges.length,
  };
}

/**
 * 守卫 D 的第二半: **白名单不许烂掉**。
 *
 * `JUDGE_CROSSCHECK_ENDS` 是「这个函数按设计只被守卫调」的豁免。
 * 一旦守卫不再调它(交叉校验废了), 白名单就成了遮羞布 ——
 * 一个**没人执行的判决**被「已豁免」四个字盖住, 比没守卫更坏。
 *
 * 判据: 白名单上的每个函数, 必须**真的**出现在某个守卫文件的源码里。
 *
 * @param {string} [coreRoot]
 * @returns {{ok: boolean, stale: Array<{fn: string, why: string}>}}
 */
function findStaleCrosscheckEnds(coreRoot = CORE_ROOT) {
  const modulesDir = path.join(coreRoot, 'modules');
  const guardSet = new Set(MODULE_GUARDS);
  const guardSources = [];
  try {
    for (const e of fs.readdirSync(modulesDir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.js')) continue;
      if (!guardSet.has(e.name.replace(/\.js$/, ''))) continue;
      try {
        guardSources.push(fs.readFileSync(path.join(modulesDir, e.name), 'utf8'));
      } catch (_) { /* 读不到就当没有 */ }
    }
  } catch (_) { /* 目录不存在 ⇒ 全部 stale */ }

  const stale = [];
  for (const fn of Object.keys(JUDGE_CROSSCHECK_ENDS)) {
    const used = guardSources.some(src => new RegExp('\\b' + fn + '\\b').test(src));
    if (!used) {
      stale.push({ fn, why: JUDGE_CROSSCHECK_ENDS[fn] });
    }
  }
  return { ok: stale.length === 0, stale };
}

// ═══════════════════════════════════════════════════════════════
// 层的活地图 (老板 Q1: 分几个部分 / 能不能独立开)
// ═══════════════════════════════════════════════════════════════

/** 数一个目录下所有 .js 的总行数(实时, 不写死 —— 写死的数会跟表漂)。 */
function _countLines(dir, { skipTests = true } = {}) {
  let files = 0;
  let lines = 0;
  (function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue;
        if (skipTests && e.name === 'tests') continue;
        walk(abs);
        continue;
      }
      if (!e.name.endsWith('.js')) continue;
      files++;
      try {
        // 用「换行符个数」而不是 split().length —— 后者比 `wc -l` 多 1,
        // 老板随手一比就发现对不上, 以后就不信这个工具了。
        lines += (fs.readFileSync(abs, 'utf8').match(/\n/g) || []).length;
      } catch (_) { /* 读不到就跳过这一份, 不猜 */ }
    }
  })(dir);
  return { files, lines };
}

function _countFile(abs) {
  try {
    return {
      files: 1,
      lines: (fs.readFileSync(abs, 'utf8').match(/\n/g) || []).length,
    };
  } catch (_) {
    return { files: 0, lines: 0 };
  }
}

/**
 * 四层活地图: 每层实时文件数与行数, 以及依赖方向(实测, 不是文档断言)。
 */
function layerMap(coreRoot = CORE_ROOT) {
  const layers = [
    { key: '64i',          dir: path.join(coreRoot, '64i'),             dependsOn: [] },
    { key: 'agents',       dir: path.join(coreRoot, 'agents'),          dependsOn: ['64i'] },
    { key: 'modules',      dir: path.join(coreRoot, 'modules'),         dependsOn: ['64i', 'agents'] },
    { key: 'pangu-single', dir: path.join(coreRoot, 'pangu-single.js'), dependsOn: ['全部'] },
  ];
  const out = {};
  for (const l of layers) {
    const c = l.dir.endsWith('.js') ? _countFile(l.dir) : _countLines(l.dir);
    out[l.key] = { files: c.files, lines: c.lines, dependsOn: l.dependsOn };
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// 启动链用的断言 —— 越界即抛, 不吞
// ═══════════════════════════════════════════════════════════════

/**
 * 装时自检: 三道守卫一起跑, 任一不过就抛。
 * 放在启动链里(每次都跑), 不放在测试里(要人跑)。
 */
function assertShushuCoreHealthy(coreRoot = CORE_ROOT) {
  const reg = coreRoot === CORE_ROOT ? _registry0() : buildRegistry(coreRoot);
  const problems = [];

  // 守卫 B: 全部能力加载成功
  for (const f of reg.failed) {
    problems.push(`[${f.group}] ${f.key} 加载失败 (${f.path}): ${f.error}`);
  }

  // 守卫 B': 发现数 == 磁盘上的原子模块数(自动发现不许漏)
  const onDisk = discoverI64Modules(path.join(coreRoot, '64i')).length;
  if (reg.discoveredCount !== onDisk) {
    problems.push(`[64i] 自动发现数 ${reg.discoveredCount} != 磁盘上的原子模块数 ${onDisk} —— 发现逻辑有洞`);
  }

  // 守卫 A: 64i 零外部依赖
  const dep = dependencyReport(path.join(coreRoot, '64i'));
  for (const e of dep.externalRequires) {
    problems.push(`[64i] ${e.module} require 了外部模块 "${e.target}" —— 64i 一旦有外部依赖, 就不能再单独抽出来了`);
  }

  // 守卫 C: 术数命名族不许有孤儿
  for (const o of findOrphanShushuModules(coreRoot)) {
    problems.push(`[modules] ${o.file} 属术数命名族(bazi/gua/chart), 但没登记进聚合层清单 —— 能力清单会漂`);
  }

  // 守卫 D: 判据函数不许只被守卫引用(孤岛判据)
  //   ⚠️ 判官不出庭: 判据写好了、测试在测、守卫在查, 但生产走不到 ——
  //   守卫还绿着, 生产已经悄悄给不出那一层的结论了。
  //   第 39 批在爻层边界守卫的方向 B 上实跑抓到过一个真洞(见 findIsolatedJudges 头注释)。
  const iso = findIsolatedJudges(coreRoot);
  for (const it of iso.islands) {
    const via = it.guardOnly.length
      ? '只有守卫引用它(' + it.guardOnly.join(', ') + ')'
      : '没有任何模块引用它';
    problems.push(
      `[64i] 判据函数 ${it.fn}(${it.file}) ${via}, 零生产调用 —— `
      + '要么接进生产数据路, 要么它就是一份**没人执行的判决**'
    );
  }

  // 守卫 D': 交叉校验端白名单不许烂掉
  //   豁免是「按设计只被守卫调」—— 哪天守卫不调了, 豁免就成了遮羞布。
  const stale = findStaleCrosscheckEnds(coreRoot);
  for (const s of stale.stale) {
    problems.push(
      `[64i] 交叉校验端 ${s.fn} 声明为「按设计只被守卫调」, 但**没有任何守卫真的调它** —— `
      + '豁免已失效(交叉校验废了), 要么把交叉校验接回去, 要么把它从白名单里删掉。'
      + '原理由: ' + s.why
    );
  }

  // 守卫 E: 出处层(2026-10-22 第 42 批)
  //   「每条回填的公理标注出处, 缺出处的不进内核」—— 这条以前只活在 decision.md 里,
  //   那是过程文档, 不在代码路径上。于是「有出处」只是注释里的一句话,
  //   谁都能加一条判据而不写出处, 没人会发现。
  //   现在它是**机制**: 每一层每一字段都必须标 sourced/interpretive/unsourced,
  //   sourced 的引文要能在 64i/sources/ 的原文切片里**逐字**找到, 且模块活数据与引文相符。
  const prov = provenance.assertProvenance();
  for (const p of prov.problems) {
    problems.push('[出处] ' + p);
  }

  if (problems.length) {
    throw new Error('术数内核聚合层自检不通过:\n  - ' + problems.join('\n  - '));
  }
  return {
    groups: Object.keys(reg.groups).length,
    atoms: reg.discoveredCount,
    services: MODULE_SERVICES.length,
    guards: MODULE_GUARDS.length,
    externalRequires: dep.externalRequires.length,
    provenance: {
      layers: prov.stats.layers,
      sourced: prov.stats.sourced,
      interpretive: prov.stats.interpretive,
      unsourced: prov.stats.unsourced,
      claims: prov.stats.claims,
    },
  };
}

module.exports = {
  VERSION: 'v1',
  // 能力
  capabilities,
  health,
  layerMap,
  // 守卫零件(可单独喂负例)
  discoverI64Modules,
  dependencyReport,
  findOrphanShushuModules,
  findIsolatedJudges,
  findStaleCrosscheckEnds,
  buildRegistry,
  assertShushuCoreHealthy,
  // 常量(测试要能看见口径)
  MODULE_SERVICES,
  MODULE_GUARDS,
  SHUSHU_MODULE_PATTERN,
  JUDGE_CROSSCHECK_ENDS,
  NODE_BUILTINS,
  // 分组导出(按组拿模块)
  GROUPS: () => _registry0().groups,
};
