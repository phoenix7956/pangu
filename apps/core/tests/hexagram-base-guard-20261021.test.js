'use strict';
// 2026-10-21, 老板原话: 「还有 64卦有一个最大的坑, 不是 1~64 是 0~63」
//
// 这张表里三套编号同时存在, 而 1..64 与 0..63 在 **1..63 上完全重叠**:
//   传错基数不会抛异常, 只会安静地返回**另一卦**。所以下面这些不是格式洁癖,
//   是唯一挡得住"少 1 错一位"的东西。
const H = require('../64i/hexagrams.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.log('  ❌ ' + name + '  →  ' + e.message); fail++; }
}
function eq(a, b, m) { if (a !== b) throw new Error((m || '') + ' 期望 ' + JSON.stringify(b) + ', 实得 ' + JSON.stringify(a)); }
function ok(v, m) { if (!v) throw new Error(m || '断言失败'); }

console.log('\n--- 数据自检 (require 时就该跑完) ---');
t('模块能加载 = 自检通过 (越界/重复/脱钩都会在 require 时抛)', () => {
  ok(Array.isArray(H.HEXAGRAMS), 'HEXAGRAMS 不是数组');
});
t('正好 64 卦', () => eq(H.HEXAGRAMS.length, 64));
t('id 是 1..64 的一个排列 (1 基, 无重复无缺失)', () => {
  const ids = H.HEXAGRAMS.map(h => h.id).sort((a, b) => a - b);
  for (let i = 0; i < 64; i++) eq(ids[i], i + 1, '第 ' + (i + 1) + ' 位');
});
t('★ 锚点卦钉死 (注释和工具描述里都写了这些, 写错了没人会发现)', () => {
  // 我自己在注释里写过「剥=63 复=64」, 被测试当场逮到 —— 剥=23 复=24 既济=63 未济=64。
  // 注释里的编号和代码里的编号一样会错, 所以拿代码钉住。
  const anchors = { 1: '乾', 2: '坤', 3: '屯', 4: '蒙', 23: '剥', 24: '复', 63: '既济', 64: '未济' };
  for (const [id, name] of Object.entries(anchors)) eq(H.getHexagram(Number(id)).name, name, 'id ' + id);
});
t('index 是 0..63 的一个排列 (0 基, 无重复无缺失)', () => {
  const ix = H.HEXAGRAMS.map(h => h.index).sort((a, b) => a - b);
  for (let i = 0; i < 64; i++) eq(ix[i], i, '第 ' + i + ' 位');
});

console.log('\n--- ★ index 与 binary 的真实关系 (上下两半对调) ---');
t('index="上卦‖下卦", binary="下卦‖上卦" —— 64/64 成立', () => {
  for (const h of H.HEXAGRAMS) {
    const ib = h.index.toString(2).padStart(6, '0');
    eq(h.binary, ib.slice(3) + ib.slice(0, 3), h.name);
  }
});
t('★ 写成 parseInt(binary,2) === index 会对 64 卦里的 56 卦报错 (别再写这条)', () => {
  // 第一版断言就是这么写的, 一 require 就炸 —— 因为它压根不成立。
  const bad = H.HEXAGRAMS.filter(h => parseInt(h.binary, 2) !== h.index).length;
  eq(bad, 56, '实测就是 56 条对不上, 数字变了说明数据或这条笔记该更新');
});
t('两端对齐: 乾=index63=全阳, 坤=index0=全阴', () => {
  const qian = H.getHexagram(1), kun = H.getHexagram(2);
  eq(qian.index, 63); eq(qian.binary, '111111');
  eq(kun.index, 0); eq(kun.binary, '000000');
});

console.log('\n--- 卦符 (symbol) ---');
t('symbol 是 Unicode 易经卦符块 U+4DC0+id-1, 排法即文王卦序', () => {
  for (const h of H.HEXAGRAMS) {
    eq(h.symbol, String.fromCharCode(0x4DC0 + h.id - 1), h.name);
  }
});
t('★ symbol 不是上下卦拼 (别拿 ☰☰ 那种去断言它)', () => {
  // 差一步就把 64 个正确值按错的期望值"修"成垃圾 —— 断言写错比没断言更贵。
  const qian = H.getHexagram(1);
  eq(qian.symbol, '䷀');
  ok(qian.symbol !== '☰☰', '乾的 symbol 是单字符卦符, 不是两个三画卦符');
});

console.log('\n--- 换算必须显式, 不许靠猜 ---');
t('idToIndex / indexToId 互为逆运算 (64/64)', () => {
  for (let id = 1; id <= 64; id++) eq(H.indexToId(H.idToIndex(id)), id);
  for (let i = 0; i < 64; i++) eq(H.idToIndex(H.indexToId(i)), i);
});
t('★ 越界要抛错, 且错认两个基数分别是谁', () => {
  // 这才是"最大的坑"要防的那一下: 传 0 进 idToIndex, 静默返回 null 就变成别的卦了。
  let e1 = null; try { H.idToIndex(0); } catch (x) { e1 = x; }
  ok(e1, 'idToIndex(0) 没抛');
  ok(/1\.\.64/.test(e1.message) && /0 基/.test(e1.message), '错认没说明 id 是 1 基: ' + e1.message);
  let e2 = null; try { H.indexToId(64); } catch (x) { e2 = x; }
  ok(e2, 'indexToId(64) 没抛');
  ok(/0\.\.63/.test(e2.message) && /1 基/.test(e2.message), '错认没说明 index 是 0 基: ' + e2.message);
});
t('getHexagramByIndex(0) 是坤(不是"没有第0卦")', () => {
  // 最容易被当成 bug 报上来的一个: index 0 存在的, 只是 id 从 1 起。
  eq(H.getHexagramByIndex(0).name, '坤');
  eq(H.getHexagram(2).name, '坤');
});

console.log('\n--- 生产入口 (64i/index.js 那个便捷接口) ---');
const IDX = require('../64i/index.js');
t('传数字 → 返回卦 (这条一直是对的)', () => {
  eq(IDX.getHexagram(1).name, '乾');
  eq(IDX.getHexagram(64).name, '未济', '末尾是既济(63)/未济(64), 复在 24');
});
t('★ 传数字**字符串**也要返回卦 (老代码只认 number, 这条路生产里是死的)', () => {
  // hexagram_lookup 的 schema 声明 query 是 type:'string', 模型发过来的其实是 "5"。
  // 老代码 typeof==='number' 才走 id 分支 → "5" 落到按卦名找 → 找不到 →
  // 调用方转模糊匹配 → 也匹配不到 → 返回 {ok:true, data:[]}, 还回得像个正常结论。
  eq(IDX.getHexagram('1').name, '乾');
  eq(IDX.getHexagram('5').name, '需');
  eq(IDX.getHexagram(' 64 ').name, '未济', '带空格也算');
});
t('★ 数字越界要抛错, 不能静默 undefined', () => {
  let e1 = null; try { IDX.getHexagram(0); } catch (x) { e1 = x; }
  ok(e1, 'getHexagram(0) 没抛 → undefined 会往下传, 在别处炸');
  ok(/1\.\.64/.test(e1.message), '错认没说明 id 是 1..64: ' + e1.message);
  ok(/0\.\.63/.test(e1.message), '错认没提另一套是 0..63: ' + e1.message);
  let e2 = null; try { IDX.getHexagram('0'); } catch (x) { e2 = x; }
  ok(e2, '数字字符串 "0" 同样不许静默');
});
t('卦名查询不受影响 (纯数字才当 id, 卦名里没有纯数字)', () => {
  eq(IDX.getHexagram('乾').name, '乾');
  eq(IDX.getHexagram('讼').name, '讼');
  eq(IDX.getHexagram('不存在'), undefined, '卦名查不到仍返回 undefined —— 那是另一回事, 不抛');
});
t('换算出口挨着入口放 (用的人才看得见)', () => {
  eq(IDX.idToIndex(1), 63);
  eq(IDX.indexToId(0), 2);
  eq(IDX.getHexagramByIndex(63).name, '乾');
});

console.log('\n--- 工具描述必须把基数写死 (不能指望模型猜) ---');
// 2026-11-26: 第 96/97 批 (d9c5db3) 把 tools_schema.js 拆成家族文件, hexagram_lookup
//   的 schema 搬进了 tools_schema/gua_trend.js; 这条守卫还盯着老文件 ⇒ 私有树也挂。
//   跟家族文件同进退, 盯住 gua_trend.js。
t('hexagram_lookup 的描述里明写 1..64, 且声明不收 0 基索引', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'modules', 'tools_schema', 'gua_trend.js'), 'utf8');
  const i = src.indexOf("name: 'hexagram_lookup'");
  ok(i > 0, 'schema 里找不到 hexagram_lookup');
  const seg = src.slice(i, i + 1200);
  ok(/1\.\.64/.test(seg), '描述里没写死 id 是 1..64');
  ok(/0\.\.63/.test(seg), '描述里没提另一套 0..63, 模型无从分辨');
  ok(/乾=1/.test(seg) && /坤=0/.test(seg), '两个基数的锚点卦没写出来');
});

console.log('\n============================================================');
console.log('测试结果：' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
console.log('============================================================');
if (fail > 0) process.exit(1);
