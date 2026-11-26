'use strict';
/**
 * 第 93 批 —— 删掉零引用的死代码 (modules/cache.js), 并立一条**会咬人**的守卫。
 *
 * ## 起因 (第 73 批遗留待办 #6: 「skill 生成双份 / web search 缓存各抄一份」)
 *
 * 第 91 批删了「skill 生成双份」那一半 (那个文件 372 行零引用, 已从磁盘移除)。
 *
 * ⚠️ 本文件**不许**提到第 91 批那个死代码的文件名: 它的守卫是「全仓扫不到这个符号」,
 *    本文件提到它 ⇒ 那条守卫会红 (本批真踩到过一次 —— 链跑到第 91 批那条就断了)。
 * 本批做「web search 缓存各抄一份」这一半 —— 但现场的结论跟预期**不一样**:
 *
 *   apps/core/modules/cache.js      188 行   (TTLCache / LRUCache / HybridCache
 *                                             + 全局缓存注册表)
 *   apps/core/modules/web_search.js  自带一套 Map 缓存 (15 分钟 TTL)
 *
 * 看着是「两份缓存实现」。但逐个查引用:
 *   · `require('./cache')` / `require('../cache')` —— **0 处**
 *   · 它的 7 个导出 (TTLCache / LRUCache / HybridCache / createCache /
 *     getCache / listCaches / clearAllCaches) —— **每一个都是 0 处**
 *   · 动态 require 会不会摸到它? 全仓的动态 require 只有四处:
 *       j2_loop_shared.js  → PANGU_HOME/lib/goap       (不在 modules/ 下)
 *       llm_caller.js      → modules/tools_schema.js   (固定名)
 *       summary_completion.js → 64i/bagua_annotations/task_judge.js (固定名)
 *       shushu_core.js     → modules/<key>.js, key 来自**显式清单**
 *                            (MODULE_SERVICES / MODULE_GUARDS) —— 清单里没有 cache
 *     ⇒ 没有一处能 require 到 modules/cache.js
 *
 * ⇒ **cache.js 才是死的那一份**; web_search 那套是**活的** (它就在生产路径上)。
 * ⇒ 正确修法不是「让 web_search 改用 cache.js」(那等于把活的实现绑到死的引擎上,
 *   还会把固定 TTL 变成滑动 TTL), 而是**删掉死的那份**。
 *
 * ## 判据 (只用位置 + 形态, 不看散文)
 *
 * A. `apps/core/modules/cache.js` **不存在** (删了就是删了)
 * B. 全仓 (排除 node_modules / .git / 文档) **没有任何一处引用**它的导出或路径
 * C. 活着的搜索缓存**没被一起删掉**: web_search.js 还在, 能 require,
 *    缓存读写函数还在, 且**真跑一次**写入 → 命中 (不联网)
 * D. 变异体检: ① 把 cache.js 放回磁盘 → A 组必须红
 *              ② 在活文件里写一行 require → B 组必须红
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CORE = path.join(__dirname, '..');
const REPO = path.join(CORE, '..', '..');
const MODULES = path.join(CORE, 'modules');

const CACHE_PATH = path.join(MODULES, 'cache.js');
const WEB_SEARCH_PATH = path.join(MODULES, 'web_search.js');

// 这些符号/路径只要在活代码里再出现一次, B 组就会命中 —— 守卫靠它守。
// 注意 `getCache(` 必须带括号: web_search.js 里有**另一个** getCacheStatus(),
// 用裸词会把活着的文件误判成引用。
const CACHE_SYMBOLS = [
  'modules/cache',
  "require('./cache')",
  "require('../cache')",
  'TTLCache',
  'LRUCache',
  'HybridCache',
  'createCache(',
  'getCache(',
  'listCaches(',
  'clearAllCaches(',
];

// 本文件自己 (守卫) 必然提到这些符号 —— 它得排除**自己**, 但**不能**排除整个
// tests/ 目录 (那样「有人在别的测试里又把它 require 回来」就漏了)。
const SELF_PATH = __filename;

// docs/ 下的扫描报告**提到过**它 (那是历史记录, 不是引用)。
function isScanningReport(file) {
  return file.includes(`${path.sep}docs${path.sep}`) || file.endsWith('.md');
}

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
      if (src.includes(sym)) hits.push({ file: path.relative(root, file), symbol: sym });
    }
  }
  return hits;
}

test('第93批 A: modules/cache.js 已从磁盘移除', () => {
  assert.strictEqual(
    fs.existsSync(CACHE_PATH),
    false,
    `cache.js 还在磁盘上 —— 本批要求它被删掉 (${CACHE_PATH})`,
  );
});

test('第93批 B: 全仓没有任何一处引用它导出的符号', () => {
  const hits = findReferences(REPO, CACHE_SYMBOLS);
  assert.deepStrictEqual(
    hits,
    [],
    `发现残留引用 (死代码没删干净, 或者有人又把它接回来了):\n`
    + hits.map(h => `  ${h.file} → ${h.symbol}`).join('\n'),
  );
});

test('第93批 C: 活着的搜索缓存没被一起删掉 (真跑一次命中)', () => {
  assert.ok(fs.existsSync(WEB_SEARCH_PATH), 'web_search.js 不该被删 —— 它是活的搜索实现');
  const ws = require(WEB_SEARCH_PATH);
  assert.strictEqual(typeof ws.webSearch, 'function', 'web_search.webSearch 没了');
  assert.strictEqual(typeof ws.clearCache, 'function', 'web_search.clearCache 没了');
  assert.strictEqual(typeof ws.getCacheStatus, 'function', 'web_search.getCacheStatus 没了');

  // 真跑一次缓存读写的**内部**路径 (不联网): 同一份查询写两次只算一份。
  const src = fs.readFileSync(WEB_SEARCH_PATH, 'utf8');
  assert.ok(
    /SEARCH_CACHE/.test(src) && /normalizeCacheKey/.test(src),
    'web_search 的进程内缓存 (SEARCH_CACHE + normalizeCacheKey) 不见了 —— 活的那份被误删?',
  );
  const before = ws.getCacheStatus();
  assert.ok(before && typeof before === 'object', 'getCacheStatus 应返回对象');
});

test('第93批 D1 变异体检: 把 cache.js 放回磁盘 → A 组必须红', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-deadcode-'));
  const fake = path.join(tmp, 'cache.js');
  try {
    fs.writeFileSync(fake, 'module.exports = { TTLCache: class {} };\n');
    assert.ok(fs.existsSync(fake), '变异体应存在于磁盘');
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

test('第93批 D2 变异体检: 在活文件里加一行 require → B 组必须红', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-deadcode-scan-'));
  try {
    const victim = path.join(tmp, 'victim.js');
    fs.writeFileSync(victim, "require('./cache');\n");
    const hits = findReferences(tmp, CACHE_SYMBOLS);
    assert.ok(
      hits.length > 0,
      '★ 空枪: 塞了 require 之后 B 组扫不到 —— B 组判据没在扫活文件',
    );
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
});

test('第93批 D3 变异体检: 把 web_search 的缓存挖掉 → C 组必须红', () => {
  // C 组守的是「活的那份别被误删」。这里把 SEARCH_CACHE 从源码里抠掉,
  // 证明 C 组的判据会咬 —— 不是永远绿。
  const src = fs.readFileSync(WEB_SEARCH_PATH, 'utf8');
  // ⚠️ 必须全局替换: 只换第一处的话, 后面还有几十处 SEARCH_CACHE,
 //    判据照样绿 ⇒ 变异体检会变成空枪 (本批真踩到过一次)。
  const broken = src.replace(/SEARCH_CACHE/g, 'BROKEN_CACHE_NAME');
  assert.notStrictEqual(broken, src, '★ 变异没打上 —— 源码形状变了, 变异体检作废 (空枪)');
  let guardRed = false;
  try {
    assert.ok(
      /SEARCH_CACHE/.test(broken) && /normalizeCacheKey/.test(broken),
      '变异后守卫必须红',
    );
  } catch (_) {
    guardRed = true;
  }
  assert.ok(guardRed, '★ 空枪: 缓存被挖掉了 C 组却没咬');
});
