'use strict';
// 爻辞表阴阳对齐 (2026-10-22, 第二十八批)
//
// 起因: 修「爻向量自洽守卫」时顺手核了 64 卦 × 6 爻的爻名,
//   核出**一处真源数据错**:
//     鼎卦(50) 初爻, 标签写「初九」, 但它是**阴爻** —— 该是「初六」。
//     证据两条, 互相独立:
//       ① binary 011101 → idx0 的位是 0 = 阴 ⇒ 必须是「六」
//       ② 爻辞正文「鼎颠趾, 利出否, 得妾以其子无咎」正是《周易·鼎卦》**初六**那条
//          (初六: 鼎颠趾…; 九二才是「鼎有实」)
//   已改「初九」→「初六」(apps/core/64i/hexagrams.js)。
//
// 为什么单独立一条测试:
//   爻名「九/六」是**阴阳**属性, 爻位「初二三四五上」是**位置**属性, 两轴。
//   上一批那道守卫查的是「位置对不对」(爻名 vs 爻五行) —— 鼎卦这处是**阴阳**错,
//   位置没错(初九和初六都是初爻) ⇒ 守卫**看不见**它。
//   ⇒ 两条不变量, 两道网, 各管各的:
//     ① 位置轴: 爻名位置 vs 爻五行/六亲    → yao-vector-consistency-*.test.js
//     ② 阴阳轴: 爻名阴阳 vs 爻画阴阳        → 本文件
//
// 写死「阴阳/位置两轴都对」的依据是**爻画本身**:
//   `64i/yao_models.getBinary(guaId)` 是 6 位串, 1=阳 0=阴, 索引 0=初爻。
//   爻名必须由「该位的阴阳」+「该位的位置」唯一确定 —— 这不是术数偏好, 是定义。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CORE = path.join(__dirname, '..');
const hexagrams = require(path.join(CORE, '64i', 'hexagrams.js'));
const yaoModels = require(path.join(CORE, '64i', 'yao_models.js'));

// 爻名 → {position: 0..5, yinyang: '阳'|'阴'}
const POSITION_WORDS = ['初', '二', '三', '四', '五', '上'];
const YINYANG_CHAR = { '九': '阳', '六': '阴' };

/**
 * 核一条爻名与爻画是否对齐。
 * @param {string} name 爻名, 如 六四 / 初九 / 上六
 * @param {number} idx 爻位 0..5
 * @param {string} bit 该位爻画 '1'(阳) / '0'(阴)
 * @returns {string[]} 问题清单, 空 = 对齐
 */
function checkYaoNameAlign(name, idx, bit) {
  const problems = [];
  const s = String(name || '').trim();
  if (!s) {
    problems.push('爻名为空');
    return problems;
  }
  // 阴阳字: 初九/初六 → 九六 在末位; 九二/六二 → 九六 在首位
  const yyMatch = s.match(/^([初上])?([九六])([二三四五])?$/);
  if (!yyMatch) {
    problems.push('爻名「' + s + '」认不出结构(应为 初九/九二/六三/…/上六)');
    return problems;
  }
  const [, edge, yyChar, midWord] = yyMatch;
  const yinyang = YINYANG_CHAR[yyChar];
  // 位置: 边缘字(初/上)优先, 否则用中间数位
  let position = null;
  if (edge === '初') position = 0;
  else if (edge === '上') position = 5;
  else if (midWord) position = '二三四五'.indexOf(midWord) + 1;
  if (position === null) {
    problems.push('爻名「' + s + '」没有位置信息');
    return problems;
  }
  if (position !== idx) {
    problems.push('爻名「' + s + '」位置是第 ' + (position + 1) + ' 爻, 应为第 ' + (idx + 1) + ' 爻');
  }
  const expectYin = bit === '1';
  if ((yinyang === '阳') !== expectYin) {
    problems.push('爻名「' + s + '」是' + yinyang + '爻, 但爻画是' + (expectYin ? '阳' : '阴')
      + '(爻画位 ' + bit + ')');
  }
  return problems;
}

// ============================================================
// 一、全量扫 (64 卦 × 6 爻)
// ============================================================

test('★ 384 爻的爻名必须与爻画对齐 (阴阳轴 + 位置轴)', () => {
  const problems = [];
  let n = 0;
  for (let gid = 1; gid <= 64; gid++) {
    const h = hexagrams.getHexagram(gid);
    const binary = yaoModels.getBinary(gid);
    assert.equal(typeof binary, 'string', 'guaId=' + gid + ' 取不到 binary');
    assert.equal(binary.length, 6, 'guaId=' + gid + ' binary 长度不对');
    const ci = h.yao_ci || [];
    assert.equal(ci.length, 6, 'guaId=' + gid + ' 爻辞条数不是 6');
    for (let i = 0; i < 6; i++) {
      const name = (ci[i] || '').split('：')[0];
      const ps = checkYaoNameAlign(name, i, binary[i]);
      for (const p of ps) problems.push('guaId=' + gid + ' ' + (h.name || '') + ' idx=' + i + ': ' + p);
      n++;
    }
  }
  assert.equal(n, 384, '应覆盖 384 爻, 实为 ' + n);
  assert.equal(problems.length, 0,
    '爻名与爻画不对齐:\n  ' + problems.join('\n  '));
});

test('★ 鼎卦(50) 初爻: 阴爻, 爻名必须是「初六」(不是「初九」)', () => {
  // 单独钉住这一处 —— 它是 2026-10-22 实际抓到并修掉的那处真源数据错。
  const h = hexagrams.getHexagram(50);
  assert.equal(yaoModels.getBinary(50)[0], '0', '鼎卦初爻应是阴爻(0)');
  const name = (h.yao_ci[0] || '').split('：')[0];
  assert.equal(name, '初六', '鼎卦初爻爻名是「' + name + '」, 应为「初六」');
  // 爻辞正文不能被改坏
  assert.ok((h.yao_ci[0] || '').includes('鼎颠趾'), '鼎卦初爻爻辞正文被改坏了');
});

// ============================================================
// 二、负例: 校验函数不许是恒真的
// ============================================================

test('★ 负例: 阴阳写反必须被查出 (校验函数不是恒真的)', () => {
  const ps = checkYaoNameAlign('初九', 0, '0');   // 阴爻却写「初九」
  assert.ok(ps.length >= 1, '阴阳写反没报 —— 校验函数是恒真的');
  assert.ok(ps.some(p => p.includes('阴')), '没说出是阴阳不对: ' + JSON.stringify(ps));
});

test('★ 负例: 位置写错必须被查出', () => {
  const ps = checkYaoNameAlign('六四', 2, '0');   // 应是三爻, 却写成四爻
  assert.ok(ps.length >= 1, '位置写错没报 —— 校验函数是恒真的');
  assert.ok(ps.some(p => p.includes('位置')), '没说出是位置不对: ' + JSON.stringify(ps));
});

test('★ 负例: 认不出的爻名必须报出来(而不是默默放过)', () => {
  for (const bad of ['', '随便什么', '九', '六', '初爻', '九二三四五']) {
    const ps = checkYaoNameAlign(bad, 0, '0');
    assert.ok(ps.length >= 1, '「' + bad + '」没报问题 —— 认不出就该说认不出');
  }
});

test('★ 负例: 认得出的正确爻名不许被报(不许误伤)', () => {
  const cases = [
    ['初九', 0, '1'], ['初六', 0, '0'],
    ['九二', 1, '1'], ['六二', 1, '0'],
    ['九三', 2, '1'], ['六三', 2, '0'],
    ['九四', 3, '1'], ['六四', 3, '0'],
    ['九五', 4, '1'], ['六五', 4, '0'],
    ['上九', 5, '1'], ['上六', 5, '0'],
  ];
  for (const [name, idx, bit] of cases) {
    const ps = checkYaoNameAlign(name, idx, bit);
    assert.equal(ps.length, 0, '「' + name + '」被误报: ' + JSON.stringify(ps));
  }
});
