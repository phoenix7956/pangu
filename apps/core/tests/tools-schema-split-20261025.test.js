'use strict';
/**
 * tools-schema-split-20261025.test.js —— 第 97 批: tools_schema.js 拆分后的**零漂移**守卫
 *
 * 背景 (第 97 批):
 *   tools_schema.js 原来 2379 行 —— 其中 1739 行是**一个对象字面量** (98 个工具)
 *   + 后面 32 个 `TOOLS_SCHEMA.xxx = {...}` 事后追加, 共 130 个工具。
 *   现按域拆成 modules/tools_schema/<域>.js 十三个文件, tools_schema.js 只剩 154 行门面。
 *
 * 为什么必须有这条守卫 (拆分最容易出的三处事故):
 *   1. **顺序变了** —— 工具顺序会进 LLM 提示词 ⇒ 顺序就是语义, 换了就变味
 *   2. **内容漂了** —— 改一个 description 就换了模型看到的措辞
 *   3. **合并不对** —— 家族顺序合并错位, 工具顺序整体错
 *   ⇒ 基线是**拆分前**抓的 (130 个工具的顺序 + 每个 schema 的 sha1 + getAllToolSchemas 整体摘要),
 *     存在 tests/fixtures/tools-schema-baseline-20261025.json
 *
 * 口径:
 *   G1 顺序逐个一致
 *   G2 每个工具的 schema 内容逐字一致 (sha1)
 *   G3 getAllToolSchemas() 的整体摘要一致 (含 tier/timeout 注入后的最终形态)
 *   G4 巨石不许长回来 (每个家族文件 ≤ 400 行, 门面 ≤ 300 行)
 *   G5 变异体检两发 —— 证明 G1/G2 会咬, 不是空枪
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const APP = path.join(__dirname, '..');
const MODULES = path.join(APP, 'modules');
const SCHEMA_SRC = path.join(MODULES, 'tools_schema.js');
const SCHEMA_DIR = path.join(MODULES, 'tools_schema');
const BASE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tools-schema-baseline-20261025.json'), 'utf8'));
// 2026-11-26: 开源导出树 (有 .pangu-open-source 标记) 的 schema 描述被脱敏过
//   (「风水」→「风水」等课程名替换), G2/G3 的 hash 基线是私有树抓的,
//   导出树里必然不一致。开源模式下 G1/G4/G5 仍全跑, G2/G3 跳过。
const IS_OPEN_SOURCE = fs.existsSync(path.join(APP, '64i', '.pangu-open-source'));

function sha12(v) {
  return crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12);
}

// ---- G1 / G2 / G3 ---------------------------------------------------------

test('G1: 130 个工具的顺序跟拆分前逐个一致', () => {
  const s = require(SCHEMA_SRC);
  const keys = Object.keys(s.TOOLS_SCHEMA);
  assert.strictEqual(keys.length, BASE.count, `工具数变了: ${keys.length} (基线 ${BASE.count})`);
  for (let i = 0; i < BASE.order.length; i++) {
    assert.strictEqual(
      keys[i], BASE.order[i],
      `第 ${i} 个工具变了: ${keys[i]} ≠ ${BASE.order[i]} —— 顺序会进提示词, 顺序就是语义`,
    );
  }
});

test('G2: 每个工具的 schema 内容跟拆分前逐字一致 (sha1)', () => {
  const s = require(SCHEMA_SRC);
  const bad = [];
  for (const k of BASE.order) {
    const h = sha12(s.TOOLS_SCHEMA[k]);
    if (h !== BASE.hash[k]) bad.push(`${k}(${BASE.hash[k]}→${h})`);
  }
  // 开源导出树里 schema 被脱敏改过 (课程名→公版词), G2 hash 必然不一致, 跳过。
  //   私有树里 schema 必须逐字一致, 一条都不能漂。
  if (IS_OPEN_SOURCE) {
    assert.ok(true); // 开源树跳过
  } else {
    assert.deepStrictEqual(bad, [], 'schema 内容漂了: ' + bad.join(' '));
  }
});

test('G3: getAllToolSchemas() 的最终形态摘要跟拆分前一致', () => {
  const s = require(SCHEMA_SRC);
  const all = s.getAllToolSchemas();
  assert.strictEqual(all.length, BASE.count);
  const h = crypto.createHash('sha1').update(JSON.stringify(all)).digest('hex').slice(0, 16);
  // 同上, 开源树跳过。
  if (!IS_OPEN_SOURCE) {
    assert.strictEqual(h, BASE.digest_all, 'getAllToolSchemas() 整体摘要变了 (tier/timeout 注入后)');
  }
});

// ---- G4: 巨石不许长回来 -----------------------------------------------------

test('G4: 家族文件都 ≤ 400 行, 门面 ≤ 300 行 (巨石不许长回来)', () => {
  const files = fs.readdirSync(SCHEMA_DIR).filter(f => f.endsWith('.js'));
  assert.ok(files.length >= 10, `家族文件只有 ${files.length} 个 —— 拆分没落地?`);
  for (const f of files) {
    const n = fs.readFileSync(path.join(SCHEMA_DIR, f), 'utf8').split('\n').length;
    assert.ok(n <= 400, `${f} 有 ${n} 行 —— 超了 400, 又是巨石`);
  }
  const facade = fs.readFileSync(SCHEMA_SRC, 'utf8').split('\n').length;
  assert.ok(facade <= 300, `门面 tools_schema.js 有 ${facade} 行 —— 它不该再长内容`);
});

// ---- G5: 变异体检 (证明 G1/G2 会咬) -----------------------------------------

function copyApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-schema-mut-'));
  fs.cpSync(MODULES, path.join(root, 'modules'), { recursive: true });
  fs.cpSync(path.join(APP, 'agents'), path.join(root, 'agents'), { recursive: true });
  return root;
}

function loadTemp(root) {
  // 清 require 缓存, 保证读到临时副本
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf(root) === 0) delete require.cache[k];
  }
  return require(path.join(root, 'modules', 'tools_schema.js'));
}

test('G5a: 改一个 schema 的描述 ⇒ G2 的比对必须报出漂移', () => {
  const root = copyApp();
  try {
    const fam = path.join(root, 'modules', 'tools_schema', 'exec_files.js');
    const src = fs.readFileSync(fam, 'utf8');
    const next = src.replace("description: '执行命令", "description: '【变异】执行命令");
    assert.notStrictEqual(next, src, '变异没改到 exec_files.js 的描述 (匹配串写错了)');
    fs.writeFileSync(fam, next, 'utf8');

    const s = loadTemp(root);
    const bad = [];
    for (const k of BASE.order) {
      if (sha12(s.TOOLS_SCHEMA[k]) !== BASE.hash[k]) bad.push(k);
    }
    assert.ok(bad.length > 0, '变异体没被 G2 的比对抓到 ⇒ G2 是空枪');
    assert.ok(bad.includes('exec_command'), `漂移的不是被改的那个工具: ${bad.join(' ')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('G5b: 打乱家族合并顺序 ⇒ G1 的比对必须报出顺序变了', () => {
  const root = copyApp();
  try {
    const facade = path.join(root, 'modules', 'tools_schema.js');
    const src = fs.readFileSync(facade, 'utf8');
    const next = src.replace(
      "  require('./tools_schema/memory_media'),\n  require('./tools_schema/divination'),",
      "  require('./tools_schema/divination'),\n  require('./tools_schema/memory_media'),",
    );
    assert.notStrictEqual(next, src, '变异没改到门面里的家族顺序 (匹配串写错了)');
    fs.writeFileSync(facade, next, 'utf8');

    const s = loadTemp(root);
    const keys = Object.keys(s.TOOLS_SCHEMA);
    const same = keys.length === BASE.order.length && keys.every((k, i) => k === BASE.order[i]);
    assert.ok(!same, '变异体没被 G1 的比对抓到 ⇒ G1 是空枪');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
