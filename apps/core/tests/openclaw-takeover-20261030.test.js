'use strict';
/**
 * tests/openclaw-takeover-20261030.test.js
 *
 * 第 173 批守卫 —— 「接收整个 openclaw」
 *
 * 老板 10-30: 「你现在接收整个openclaw」。
 *
 * 查出来的事实 (不是猜):
 *   · openclaw 的 gateway 今天 12:16 才被 SIGTERM 干净停掉, 但它的**知识还在**:
 *     workspace/MEMORY.md 199KB (R195), CRITICAL_STATE.md, ASSETS.md, .learnings/。
 *   · 盘古的 FTS 只索引 ~/.pangu/memory/ 内文件 ⇒ 那 199KB 台账对盘古**完全不可见**。
 *     实测迁移前: chunks 里含 "ACE-Step" = 0 条, 含 "出歌" = 0 条。
 *   · 更糟: chunks_fts 是外部内容表 (content='chunks'), l2-miner 的
 *     `DELETE FROM chunks WHERE path=?` **不会**清掉 FTS 索引里的条目
 *     ⇒ 每次重索引留一批孤儿。实测 2026-10-30: 索引 doc 78679, 孤儿 77223 (98%)。
 *   · 再糟一层: 带连字符的查询 ("ACE-Step") 会让 `MATCH ?` 抛 SQL 语法错,
 *     而旧代码的 LIKE 兜底只在 FTS **返回 0 行**时才走 ⇒ 抛错时根本走不到,
 *     整个 memory_search 直接挂。而 "ACE-Step" 正是出歌知识的标准问法。
 *   · 还有一层: 旧代码 `ctx._memory` 存在时**先查 kv 表** (只放 key-value 条目,
 *     不含正文) ⇒ 真正的 chunks 索引永远排在后面, 搜不到。
 *
 * 这批守卫盯六件事:
 *   ① 迁进来的 openclaw 台账必须在 chunks 里 (且中文能命中)
 *   ② FTS 索引不许有孤儿 (孤儿 = 98% 死条目, 搜索质量已被腐蚀)
 *   ③ 带连字符/引号的查询不许让 memory_search 抛错 (FTS 语法错必须被兜住)
 *   ④ memory_search 必须以 chunks 为主, kv 只能当补充
 *   ⑤ l2-miner 重索引必须走 FTS 的正规删除接口 (不许再留孤儿)
 *   ⑥ 盘古不许再依赖 openclaw 二进制 (老桌面端要彻底退休)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP = path.resolve(__dirname, '..');
const TOOLS = path.join(APP, 'modules', 'tools', 'index.js');
const MINER = path.join(APP, 'scripts', 'l2-miner.js');
const ADAPTER = path.join(APP, 'modules', 'mcp_adapter.js');
const SNAPSHOT = path.join(APP, 'modules', 'memory_snapshot.js');

const toolsSrc = fs.readFileSync(TOOLS, 'utf8');
const minerSrc = fs.readFileSync(MINER, 'utf8');
const adapterSrc = fs.readFileSync(ADAPTER, 'utf8');
const snapshotSrc = fs.existsSync(SNAPSHOT) ? fs.readFileSync(SNAPSHOT, 'utf8') : '';

const MEM_DB = path.join(os.homedir(), '.pangu', 'memory', 'main.sqlite');
const hasDb = fs.existsSync(MEM_DB);

test('173-①: openclaw 台账已迁进 chunks, 中文能命中', { skip: !hasDb && '本机没有 ~/.pangu/memory/main.sqlite' }, () => {
  const sqlite3 = require('better-sqlite3');
  const db = sqlite3(MEM_DB, { readonly: true });
  try {
    const imported = db.prepare(
      "SELECT count(*) AS n FROM files WHERE path LIKE 'imported/openclaw/%'"
    ).get().n;
    assert.ok(imported > 0,
      'openclaw 的台账没进盘古的 files 表 —— 那 199KB (出歌/出图/微信通道真值) 对盘古不可见');

    for (const kw of ['出歌', 'ACE-Step', 'ComfyUI']) {
      const n = db.prepare('SELECT count(*) AS n FROM chunks WHERE text LIKE ?').get('%' + kw + '%').n;
      assert.ok(n > 0,
        `chunks 里没有 "${kw}" —— openclaw 的真值台账没迁进来 (迁移前实测命中 0)`);
    }
  } finally {
    db.close();
  }
});

test('173-②: FTS 索引不许有孤儿条目', { skip: !hasDb && '本机没有 ~/.pangu/memory/main.sqlite' }, () => {
  const sqlite3 = require('better-sqlite3');
  // fts5vocab 虚表需要写权限 (建表), 只读连接建不了 ⇒ 复制一份到 tmp 再查。
  // 顺带避免测试碰生产库。
  const tmp = path.join(os.tmpdir(), `pangu-mem-orphan-${process.pid}.sqlite`);
  fs.copyFileSync(MEM_DB, tmp);
  const db = sqlite3(tmp);
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS v_orphan_check USING fts5vocab(chunks_fts, 'instance')");
    const orphan = db.prepare(
      'SELECT count(DISTINCT i.doc) AS n FROM v_orphan_check i ' +
      'WHERE i.doc NOT IN (SELECT rowid FROM chunks)'
    ).get().n;
    const total = db.prepare('SELECT count(DISTINCT doc) AS n FROM v_orphan_check').get().n;
    assert.strictEqual(orphan, 0,
      `FTS 有 ${orphan} 个孤儿条目 (总 ${total}) —— 外部内容表删除没走正规接口, `
      + '每次重索引都在攒死条目, 搜索结果已被腐蚀');
  } finally {
    db.close();
    try { fs.unlinkSync(tmp); } catch (_) { /* 清不掉就算了, 在 tmp 里 */ }
  }
});

test('173-③: 带连字符/引号的查询不许让 memory_search 抛错', () => {
  // FTS5 的 MATCH 语法: "ACE-Step" 会被当成 column::term ⇒ 抛 "no such column: Step"
  assert.ok(/catch\s*\([^)]*\)\s*\{[^}]*FTS/.test(toolsSrc),
    'FTS 查询必须被 try/catch 包住 —— 带连字符的查询 ("ACE-Step") 会让 MATCH 抛语法错');
  // 旧口径: LIKE 兜底只在 rows.length === 0 时触发 ⇒ FTS 抛错时走不到。
  // 新口径: LIKE 必须**无条件**跑, 再按顺序去重合并。
  assert.ok(!/if\s*\(\s*results\.length\s*===\s*0\s*\)\s*\{[^}]*LIKE/i.test(toolsSrc),
    'LIKE 兜底不许再挂在 "FTS 返回 0 行" 的条件里 —— FTS 抛错时那条路走不到, '
    + '整个 memory_search 会挂');
});

test('173-④: memory_search 必须以 chunks 为主, kv 只能当补充', () => {
  const seg = toolsSrc.match(/memory_search:\s*async[\s\S]*?\n  \},/);
  assert.ok(seg, '找不到 memory_search 的实现');
  const body = seg[0];
  const ftsIdx = body.indexOf('chunks_fts');
  const likeIdx = body.indexOf('FROM chunks WHERE text LIKE');
  const kvIdx = body.search(/ctx\._memory\.search/);
  assert.ok(ftsIdx >= 0 && likeIdx >= 0 && kvIdx >= 0,
    'memory_search 必须同时有 chunks FTS / chunks LIKE / kv 三条路');
  assert.ok(ftsIdx < kvIdx,
    'FTS 检索必须排在 kv 检索**前面** —— kv 表只有 key-value 条目, 不含正文, '
    + '先查它等于让真正的记忆库永远搜不到');
});

test('173-⑤: l2-miner 重索引必须走 FTS 的正规删除接口', () => {
  // 2026-10-30 当场踩坑两次, 记在这里:
  //   第一次: 只加 VALUES('delete'), 但把「查残留」放在 DELETE FROM chunks **之后**
  //     ⇒ 外部内容表查的其实是内容表, 查不到任何行 ⇒ 一条都删不掉
  //     ⇒ 沙箱实测重索引 3 个文件后孤儿 +128。
  //   第二次: 改成先删 FTS 再删内容行 (跟 modules/memory_helpers.js 的 R39 教训一致)
  //     ⇒ 合成库实测 orphans 0, 生产库实测 orphans 0。
  //
  // 所以这里不只查源码长什么样, 还要**真跑一遍** ⑤ 的行为版本。
  const ftsDel = minerSrc.indexOf('DELETE FROM chunks_fts');
  const contentDel = minerSrc.indexOf('DELETE FROM chunks WHERE path');
  assert.ok(ftsDel >= 0 && contentDel >= 0,
    'l2-miner 必须显式清 FTS (DELETE FROM chunks_fts ...) 再清内容行 —— '
    + '外部内容表光 DELETE FROM chunks 清不掉索引条目, 每次重索引都攒孤儿');
  assert.ok(ftsDel < contentDel,
    '顺序反了: 必须**先** DELETE FROM chunks_fts 再 DELETE FROM chunks —— '
    + '外部内容表查询读的是内容表, 内容行一删就再也查不到该 path 的 FTS 行, '
    + '清理语句一条都发不出去 (实测孤儿 +128)');
});

test('173-⑤b: 真跑一遍 l2-miner 的重索引, 孤儿必须不涨 (行为守卫)', () => {
  const sqlite3 = require('better-sqlite3');
  const Module = require('module');
  const fsx = require('fs');

  const tmpRoot = path.join(os.tmpdir(), `pangu-l2-reindex-${process.pid}`);
  const memRoot = path.join(tmpRoot, 'memory');
  fsx.mkdirSync(memRoot, { recursive: true });
  const lines = [];
  for (let i = 0; i < 120; i++) lines.push(`第 ${i} 行 alpha beta gamma delta ${'x'.repeat(i % 17)}`);
  const notePath = path.join(memRoot, 'notes.md');
  fsx.writeFileSync(notePath, lines.join('\n'), 'utf8');

  const minerPath = path.join(__dirname, '..', 'scripts', 'l2-miner.js');
  const orig = fsx.readFileSync(minerPath, 'utf8');
  const patched = orig
    .replace(
      "const MEM_ROOT = path.join(os.homedir(), '.pangu', 'memory');",
      'const MEM_ROOT = ' + JSON.stringify(memRoot) + ';'
    )
    .replace('if (require.main === module) {', 'module.exports = { reindexFile };\nif (false) {');

  // 编译产物必须放在 apps/core/scripts 里: l2-miner.js 内部有 ../config/node_config
  // 这类相对 require, 换目录就找不到。
  const tmpModule = path.join(__dirname, '..', 'scripts', '.l2-reindex-guard-tmp.js');
  const mod = new Module(tmpModule);
  mod.filename = tmpModule;
  mod.paths = Module._nodeModulePaths(path.join(__dirname, '..'));
  mod._compile(patched, tmpModule);
  try { fsx.unlinkSync(tmpModule); } catch (_) { /* 编完立刻删 */ }

  const reindexFile = mod.exports.reindexFile;
  const dbPath = path.join(memRoot, 'main.sqlite');
  const db = sqlite3(dbPath);
  const orphanCount = () => {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS main.guard_v USING fts5vocab(chunks_fts, 'instance')");
    const n = db.prepare(
      'SELECT count(DISTINCT i.doc) AS n FROM main.guard_v i '
      + 'WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.rowid = i.doc)'
    ).get().n;
    db.exec('DROP TABLE main.guard_v');
    return n;
  };

  try {
    for (let round = 0; round < 3; round++) reindexFile(notePath);
    const orphan = orphanCount();
    assert.strictEqual(orphan, 0,
      `重索引 3 轮后 FTS 攒了 ${orphan} 个孤儿 —— 外部内容表的清理顺序错了 `
      + '(删内容行之后再查 FTS 永远查不到行, 清理语句全部落空)');
  } finally {
    db.close();
    try { fsx.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* tmp 里, 清不掉就算了 */ }
  }
});

test('173-⑤c: FTS 重建脚本必须用 rebuild 命令, 且能真报出孤儿数', () => {
  const rawRebuildSrc = fs.readFileSync(
    path.join(__dirname, '..', 'modules', 'pangu-rebuild-fts.js'), 'utf8');
  // 去掉注释再断言 —— 否则「文档里写了这个错写法」本身就会把守卫判红。
  const rebuildSrc = rawRebuildSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // 外部内容表上 "DELETE FROM chunks_fts; + 全量重插" 是错的:
  //   全删只清索引不动内容表, 内容表与索引失配后再操作同一个 vtab
  //   ⇒ SQLITE_CORRUPT_VTAB (合成库实测崩); 生产实测孤儿 2 → 1464。
  assert.ok(/VALUES\s*\(\s*['"]rebuild['"]\s*\)/.test(rebuildSrc),
    "FTS 重建必须用 INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild') —— "
    + '外部内容表不能靠 DELETE + 重插 (会 corrupt)');
  assert.ok(!/DELETE\s+FROM\s+chunks_fts\s*;/.test(rebuildSrc),
    '重建脚本不许再 DELETE FROM chunks_fts; (外部内容表全删会让内容表与索引失配)');
  // 孤儿必须从**索引**里数 (fts5vocab)。直接 COUNT(*) FROM chunks_fts 读的是内容表,
  //   被删的行自然消失 ⇒ 恒为 0 ⇒ 这个修复脚本在生产里从来只报 no-op。
  assert.ok(/fts5vocab/.test(rebuildSrc),
    '重建脚本必须用 fts5vocab 读索引来数孤儿 —— COUNT(*) FROM chunks_fts 读的是内容表, 永远看到 0');
});

test('173-⑥: 盘古不许再依赖 openclaw 二进制', () => {
  // 只查真的调用, 不查注释里提到它 —— 注释里说明"为什么不用 openclaw" 是有意留的。
  const calls = [
    ['tools/index.js', toolsSrc],
    ['scripts/l2-miner.js', minerSrc],
  ];
  for (const [name, src] of calls) {
    const spawnsHost = /exec(File|Sync)?\s*\([^)]*['"]openclaw['"]/.test(src)
      || /spawnSync\s*\([^)]*['"]openclaw['"]/.test(src)
      || /require\([^)]*openclaw/.test(src);
    assert.ok(!spawnsHost,
      name + ' 还在调 openclaw 二进制 —— 老桌面端退休后这条链会直接断');
  }
});

test('173-⑦: snippet 的列号必须是 text 列 (0), 不是 path 列 (2)', () => {
  // chunks_fts 的列序: 0=text, 1=id, 2=path, 3=source, ...
  // snippet(chunks_fts, 2, ...) 取的是 **path 列** ⇒ 搜索结果里只有文件名, 没有内容。
  // 实测 2026-10-30: memory_search 命中 ACE-Step 时 snippet 全是 "imported/openclaw/ASSETS.md"。
  for (const [name, src] of [['tools/index.js', toolsSrc], ['modules/memory_snapshot.js', snapshotSrc]]) {
    assert.ok(!/snippet\(chunks_fts,\s*2\s*,/.test(src),
      name + ' 的 snippet 列号写成了 2 (path 列) —— 取回来的是文件名不是内容');
    assert.ok(/snippet\(chunks_fts,\s*0\s*,/.test(src),
      name + ' 的 snippet 必须用 0 (text 列)');
  }
});

test('173-⑧: MCP adapter 必须把 cwd 传给 spawn', () => {
  // mcp_loader 早就解析出 cwd, 但 adapter 从来不往 spawn 传 ⇒
  // 凡是依赖工作目录的 MCP server (comfy-mcp 要在 ComfyUI 目录里找模型/工作流)
  // 一律起在错误的地方。
  assert.ok(/cwd\s*[:=]/.test(adapterSrc) && /this\.cwd/.test(adapterSrc),
    'MCPAdapter 必须保存 cwd 并传给 spawn');
  assert.ok(/spawnOpts\.cwd\s*=|cwd:\s*this\.cwd/.test(adapterSrc),
    'spawn 必须带上 cwd —— 否则 comfy-mcp 这类依赖工作目录的 server 起不对地方');
});

test('173-⑨: 盘古必须有开局记忆快照 (openclaw 那条链的等价物)', () => {
  assert.ok(fs.existsSync(SNAPSHOT),
    'modules/memory_snapshot.js 不存在 —— 盘古没有开局记忆注入能力');
  assert.ok(/j2_agent_loop/.test(fs.readFileSync(path.join(APP, 'modules', 'j2_agent_loop.js'), 'utf8')),
    'j2_agent_loop.js 不存在');
  const loopSrc = fs.readFileSync(path.join(APP, 'modules', 'j2_agent_loop.js'), 'utf8');
  assert.ok(/_readMemorySnapshot/.test(loopSrc),
    'j2_agent_loop 没接记忆快照 —— 老 openclaw 的 auto-recall 链退役后, 盘古这边没有等价物');
  // worker/planner 不该背这段 (跟自我认知同口径)
  assert.ok(/scope === 'worker' \|\| scope === 'planner'/.test(loopSrc),
    '记忆快照必须只给主 agent —— 子 agent 每轮白背是纯浪费');
});

test('173-⑩: 记忆快照不许抛错 (注入抛错 ⇒ SSE 挂 ⇒ 客户端空回复)', () => {
  const { buildMemorySnapshot } = require(SNAPSHOT);
  let out;
  assert.doesNotThrow(() => { out = buildMemorySnapshot(); });
  assert.strictEqual(typeof out, 'string');
  assert.ok(out.length <= 2000, '记忆快照必须有界 —— 每 token 都是 prefill 代价');
});

