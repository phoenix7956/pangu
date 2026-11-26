'use strict';
// 本体表身份字段的守卫 (2026-10-23 第 50 批)
//
// 起因: 盘古这轮查「八卦是不是 000..111」时顺手核对编号口径,
//   逐条对 64/64 发现 `64i/symbol_table.js` 的身份字段跟真源对不上:
//     name         不一致 2 条(33 遯≠遁, 38 睚≠睽 —— 异体字)
//     trigram_name ≠真表上卦 29 条, 其中 37 条等于**下卦**
//                  ⇒ 这个字段根本没有一致的定义
//     symbol       **0 条**是卦符(44 条塞两个八卦符 / 20 条塞卦名)
//                  而 hexagrams.js 的 symbol 是卦符 U+4DC0+id-1
//                  ⇒ 同名字段, 两层两义
//
// 修法: 身份字段(卦名/卦符/上下卦)一律**从 hexagrams.js 真源挂上来**,
//   本表不再手抄 ⇒ 结构上漂不了, 不靠"记得改"。
//
// 本文件锁三件事:
//   1. 64/64 与真源一致(数字从表算, 不手写)
//   2. 本表是**挂**上来的, 不是抄上去的(钉源码结构)
//   3. 负例: 把挂载删掉 ⇒ 守卫必须报红 —— 绿灯是结果, 咬人是证据

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CORE = path.join(__dirname, '..');
const I64 = path.join(CORE, '64i');
const { HEXAGRAMS } = require(path.join(I64, 'hexagrams.js'));
const ST = require(path.join(I64, 'symbol_table.js'));
const { copyTree } = require('./helpers/provenance_mutate');

/**
 * 逐条比对本体表与真源的身份字段。
 *
 * ⚠️ 做成函数而不是只写一条断言: 负例要在**变异过的副本**上重跑同一个检查,
 *   写成函数才能复用 —— 否则负例只能把断言再抄一遍, 两份断言迟早漂开。
 *
 * @param {object} ontology 本体表
 * @returns {string[]} 对不上的条目(id + 字段名), 空数组 = 全对
 */
function identityMismatches(ontology) {
  const byId = new Map(HEXAGRAMS.map((h) => [h.id, h]));
  const bad = [];
  for (const id of Object.keys(ontology).map(Number).sort((a, b) => a - b)) {
    const o = ontology[id];
    const h = byId.get(id);
    if (!h) {
      bad.push(id + ':真表里没有这个 id');
      continue;
    }
    const fields = [
      ['name', h.name],
      ['symbol', h.symbol],
      ['trigram', h.trigrams.upper],
      ['trigram_name', h.trigrams.upper_name],
      ['lower_trigram', h.trigrams.lower],
      ['lower_trigram_name', h.trigrams.lower_name],
    ];
    for (const pair of fields) {
      if (o[pair[0]] !== pair[1]) bad.push(id + ':' + pair[0]);
    }
  }
  return bad;
}

test('★ 正例: 64 条身份字段与 hexagrams.js 真源逐条一致', () => {
  const bad = identityMismatches(ST.HEXAGRAM_ONTOLOGY);
  assert.deepEqual(bad, [], '本体表身份字段对不上真源: ' + bad.join(' '));
  assert.equal(Object.keys(ST.HEXAGRAM_ONTOLOGY).length, 64, '必须是 64 条');
});

test('正例: 本表是**挂**真源的, 不是抄的 —— 钉结构不钉数值', () => {
  // 只钉「有一个真源 require + 一个挂载循环」这个形状。
  // 钉某一条的具体数值没有意义(真源改了它就该跟着改)。
  const src = fs.readFileSync(path.join(I64, 'symbol_table.js'), 'utf8');
  assert.ok(src.indexOf("require('./hexagrams')") >= 0,
    '本体表必须从 hexagrams.js 取身份, 不许手抄');
  assert.ok(src.indexOf('entry.symbol = src.symbol;') >= 0,
    '卦符必须挂上来');
  assert.ok(src.indexOf('entry.trigram_name = src.trigrams.upper_name;') >= 0,
    '上卦名必须挂上来');
  // 手抄的归纳字段保留(那是盘古自己的解读, 台账按 interpretive 记着)
  assert.ok(src.indexOf('essence:') >= 0,
    'essence 等归纳字段不该被这次改动删掉');
});

test('★ 负例: 把挂载删掉(退回手抄) ⇒ 守卫必须报红', () => {
  // 变的是**真拷贝**的 64i 树, 不许改到真树上。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-symtab-'));
  copyTree(I64, path.join(root, '64i'));
  const f = path.join(root, '64i', 'symbol_table.js');
  const before = fs.readFileSync(f, 'utf8');
  const after = before.replace('entry.symbol = src.symbol;', '// 变异: 不再挂真源')
    .replace('entry.trigram_name = src.trigrams.upper_name;', '');
  assert.notEqual(after, before,
    '变异没生效 —— 锚点跟当前源码对不上, 这条负例已经假绿');
  fs.writeFileSync(f, after, 'utf8');
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(root)) delete require.cache[k];
  }
  const mutated = require(path.join(root, '64i', 'symbol_table.js'));
  const bad = identityMismatches(mutated.HEXAGRAM_ONTOLOGY);
  assert.ok(bad.length > 0,
    '把挂载删掉还全绿 ⇒ 守卫是恒真的(它量的是同一份数据自己跟自己比)');
  // 真树是 0 条对不上, 变异树必须明显变差 ⇒ 证明这份检查确实在看「挂没挂」。
  assert.ok(bad.length > identityMismatches(ST.HEXAGRAM_ONTOLOGY).length,
    '变异后对不上的条目数没有比真树多 ⇒ 检查没在测挂载这件事');
});
