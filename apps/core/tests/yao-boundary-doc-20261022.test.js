'use strict';
// 爻层边界: 层表与判据的一致性 (2026-10-22, 第十四批的补丁)
//
// 起因是回答老板「爻动阴阳那就太过了」时**撞到的一个真缺陷**:
//   头注释那张层表写「六爻层 不放 老阴老阳」, 而代码**允许**爻值 6/7/8/9
//   (老阳9/老阴6/少阳7/少阴8 —— 卦筮的地基编码, `64i/yin_yang.js` 整个爻值层就是它)。
//   注释比代码**严**: 下一个人照注释去"补齐禁词", 会把爻值层判成越界, 启动即炸。
//   注释比代码松则是另一头: 以为有守卫, 其实没有。
//   两头都坏, 而且**不报错**。
//
// 这条测试的定位: **尺子对齐**。
//   项目铁律「断言报错先怀疑尺子」的反面是「尺子本身也得有人校」——
//   注释、LAYER_BOUNDARY 数据、强制判据三方必须一致, 少一方就报。
//
// 负例是重点: 守卫全绿不说明它有用, 造一个坏的喂进去, 断言它**必须咬人**。
//   其中第一条负例直接把**事故现场那张旧表**喂进去 —— 它必须被拒绝。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const G = require(path.join(CORE, 'modules', 'yao_layer_boundary.js'));
const SRC_FILE = path.join(CORE, 'modules', 'yao_layer_boundary.js');
const SRC = fs.readFileSync(SRC_FILE, 'utf8');

/** 事故现场那张表(错的) —— 2026-10-22 之前就长这样 */
const OLD_DOC_TABLE = [
  ' *   | 层     | 放什么                                       | 不放什么                  |',
  ' *   |--------|----------------------------------------------|---------------------------|',
  ' *   | 卦层   | 阴阳卦、体用                                 | —                         |',
  ' *   | 五行层 | 五行分阴阳(偏枯/得令之别), 生克强弱在这里判  | —                         |',
  ' *   | 六爻层 | 爻位编号防错(0..63) + 引用爻辞原文           | 老阴老阳/纳甲/爻变生克    |',
].join('\n');

// ============================================================
// 一、真代码: 表 / 数据 / 判据三方一致
// ============================================================

test('层表与代码一致 (当前代码上不报)', () => {
  const r = G.checkLayerBoundaryDoc();
  assert.ok(r.ok, r.violations.join('\n'));
  assert.equal(r.rows.length, 3, '层表应该正好三层, 实为 ' + r.rows.length);
});

test('注释里那张表 == LAYER_BOUNDARY 渲染出来的 (数据是唯一真源)', () => {
  // ⚠️ 不能拿渲染文本去 `SRC.includes(row)` —— 表在注释里是**对齐排版**的
  //   (单元格里补了空格), 逐字匹配必然对不上(本条第一版就栽在这儿)。
  //   断言要比的是**解析后的格子**, 排版不算语义。
  const rows = G.checkLayerBoundaryDoc().rows;
  assert.equal(rows.length, G.LAYER_BOUNDARY.length);
  G.LAYER_BOUNDARY.forEach((layer, i) => {
    assert.equal(rows[i][0], layer.layer);
    assert.equal(rows[i][1], layer.allow);
    assert.equal(rows[i][2], layer.forbid.length ? layer.forbid.join('/') : '—');
  });
  // 渲染函数和数据必须自洽 (渲染给谁看都行, 但只能有一份)
  assert.equal(G.renderLayerBoundaryRows().length, G.LAYER_BOUNDARY.length);
});

test('六爻层的「放什么」显式写出爻值 6/7/8/9', () => {
  const yao = G.LAYER_BOUNDARY.find(r => r.layer === '六爻层');
  assert.ok(yao, '层表少了六爻层');
  assert.ok(yao.allow.includes('6/7/8/9'), '六爻层没写爻值: ' + yao.allow);
  // 老板禁的是「在爻动上再叠一层术数阴阳」, 不是爻值里的阴阳 —— 两句话不能混
  assert.ok(!yao.forbid.join('/').includes('老阴'), '六爻层又变回「禁老阴老阳」了');
});

test('禁词表里没有爻值编码词 (禁了就拆卦筮地基)', () => {
  const tokens = G.FORBIDDEN_IN_YAO_LAYER.map(t => t.token);
  for (const w of G.YAO_VALUE_ENCODING_WORDS) {
    assert.ok(!tokens.some(t => t.includes(w)), '禁词表里不该有「' + w + '」: ' + tokens.join(' '));
  }
});

test('每个禁项都写得出兜住它的判据 (空头愿望不是闸)', () => {
  for (const layer of G.LAYER_BOUNDARY) {
    for (const item of layer.forbid) {
      const by = (layer.enforcedBy || {})[item];
      assert.ok(by && by.length, `「${item}」没有 enforcedBy`);
      for (const fn of by) {
        assert.ok(G.LAYER_BOUNDARY_CHECKS.includes(fn), `「${item}」指向了不存在的判据 ${fn}()`);
        assert.equal(typeof G[fn], 'function', `判据 ${fn}() 没导出`);
      }
    }
  }
});

test('全量判据里包含「层表一致」这一项', () => {
  const r = G.checkYaoLayerBoundary();
  assert.ok(r.ok, r.violations.join('\n'));
  assert.ok(r.report.layerBoundaryDoc, '全量判据里没有 layerBoundaryDoc —— 方向 F 没接上');
  assert.equal(r.report.layerBoundaryDoc.ok, true);
});

// ============================================================
// 二、负例: 守卫必须会咬人
// ============================================================

test('★ 负例: 事故现场那张旧表(禁老阴老阳)喂进去 → 必须报出来', () => {
  const r = G.checkLayerBoundaryDoc({ src: OLD_DOC_TABLE });
  assert.equal(r.ok, false, '旧表竟然通过了 —— 注释比代码严的坑还在');
  assert.ok(
    r.violations.some(v => v.includes('放什么') && v.includes('六爻层')),
    '没报出「放什么」不一致: ' + r.violations.join('; ')
  );
  assert.ok(
    r.violations.some(v => v.includes('不放什么') && v.includes('六爻层')),
    '没报出「不放什么」不一致: ' + r.violations.join('; ')
  );
});

test('负例: 注释表多出一层 → 报出来', () => {
  //
  // ⚠️ 2026-10-23 第 53 批改过这里: 原来是 `SRC + '\n *   | 爻变层 | …'` ——
  //   把假行**追加到文件末尾**。那时 `parseLayerBoundaryDoc` 扫全文所有三列行,
  //   追加在哪都能被抓到。
  //   第 53 批头注释里加了**第二张表**(编号表), 于是解析器改成"按表头认领":
  //   见到「层」表头才开、见到「编号」表头就关。追加到末尾的行落在编号表**之后**
  //   ⇒ 层表判据看不见它 ⇒ 这条负例**假绿**了(整链 EXIT=1 才发现)。
  //
  //   真实场景是"有人在层表里插一行", 所以改成**插进层表范围内**(紧跟表头之后)。
  //   ⚠️ 这跟第 53 批那条教训是同一族: 负例本身也会悄悄失去意义。
  //
  // 插在**层表的表头之后**(第一张表的「层 | 放什么 | 不放什么」)。
  //   不能插在文件末尾 —— 末尾属于编号表的地盘, 层表判据不认领那儿(见上)。
  const src = SRC.replace(
    /(\*[ \t]*\|[ \t]*层[ \t]*\|[ \t]*放什么[ \t]*\|[ \t]*不放什么[ \t]*\|[ \t]*\r?\n[ \t]*\*[ \t]*\|[-\s|]+\|[ \t]*\r?\n)/,
    '$1 *   | 爻变层 | 爻变推演 | 五行 |\n'
  );
  assert.notEqual(src, SRC, '没插进去 —— 负例锚点过期了');
  const r = G.checkLayerBoundaryDoc({ src });
  assert.equal(r.ok, false, '多出来的层没人管');
  assert.ok(r.violations.some(v => v.includes('多出一层')), r.violations.join('; '));
});

test('负例: 禁项没写 enforcedBy → 报出来', () => {
  const boundary = G.LAYER_BOUNDARY.map(l => l.layer === '六爻层'
    ? Object.assign({}, l, { enforcedBy: {} })
    : l);
  const r = G.checkLayerBoundaryDoc({ boundary });
  assert.equal(r.ok, false, '空头愿望竟然通过了');
  assert.ok(r.violations.some(v => v.includes('enforcedBy')), r.violations.join('; '));
});

test('负例: enforcedBy 指向不存在的判据 → 报出来', () => {
  const boundary = G.LAYER_BOUNDARY.map(l => l.layer === '六爻层'
    ? Object.assign({}, l, { enforcedBy: { '五行': ['checkSomethingThatDoesNotExist'] } })
    : l);
  const r = G.checkLayerBoundaryDoc({ boundary });
  assert.equal(r.ok, false, '指向空气的判据竟然通过了');
  assert.ok(r.violations.some(v => v.includes('不存在的判据')), r.violations.join('; '));
});

test('负例: 禁词表塞进「老阳」→ 报出来 (那会拆掉卦筮地基)', () => {
  const forbidden = G.FORBIDDEN_IN_YAO_LAYER.concat([{ token: '老阳', why: '试试' }]);
  const r = G.checkLayerBoundaryDoc({ forbidden });
  assert.equal(r.ok, false, '禁掉爻值编码竟然没人拦');
  assert.ok(r.violations.some(v => v.includes('爻值编码词')), r.violations.join('; '));
});

test('负例: 六爻层不写爻值 6/7/8/9 → 报出来 (不许再含糊)', () => {
  const boundary = G.LAYER_BOUNDARY.map(l => l.layer === '六爻层'
    ? Object.assign({}, l, { allow: '爻位编号防错(0..63) + 引用爻辞原文' })
    : l);
  const r = G.checkLayerBoundaryDoc({ boundary });
  assert.equal(r.ok, false, '含糊过去竟然没人拦');
  assert.ok(r.violations.some(v => v.includes('6/7/8/9')), r.violations.join('; '));
});

test('负例: 爻层源码里塞五行 → 方向 A 依然咬人 (老判据没被这批改坏)', () => {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yao-doc-neg-'));
  const fake = path.join(tmp, 'yin_yang.js');
  fs.writeFileSync(fake, 'const x = { wuxing: 1 }; module.exports = { x };\n');
  const r = G.checkYaoLayerNoWuxing({ modules: [{ file: fake, label: '假爻值层' }] });
  assert.equal(r.ok, false, '爻层塞五行竟然通过了');
  assert.ok(r.violations.some(v => v.includes('wuxing')), r.violations.join('; '));
});

