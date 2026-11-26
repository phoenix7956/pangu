'use strict';
// 卦象名(xiang_name) —— 64i 真源, 门与工具共用一份 (2026-10-22)
//
// 起因是 2026-10-22 的 E2E 实测:
//   问「第22卦是哪一卦?给出卦名、卦辞、上下卦、卦象名、纳甲」,
//   模型**确实**调了 hexagram_lookup(路由没问题), 但工具只给了 nature(贲饰),
//   没给卦象名(山火贲) —— 于是模型把「贲饰」填进了「卦象名」栏。
//
// 根因跟「地天雷」是同一个: **该给真值的地方给了回忆, 没给的地方模型自己编**。
// 修法不是加免责声明, 是把真值给到位:
//   ① 64i 出了 xiangNameOf() —— 卦象名的**唯一**推导源
//   ② 工具输出多给一个 xiang_name 字段(和 nature 并列, 不混)
//   ③ 事实块也多一行「卦义」—— 免得模型只记得住一个, 另一个靠编
//
// 本测试钉住:
//   ① 卦象名的形状只有两种, 64 卦全对
//   ② 卦象名与卦义是两样东西, 不会被混成同一个值
//   ③ 门与工具用的是同一份推导(不是各抄一遍)

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CORE = path.join(__dirname, '..');
const { HEXAGRAMS, xiangNameOf } = require(path.join(CORE, '64i', 'hexagrams.js'));
const { BAGUA_AXIOMS } = require(path.join(CORE, '64i', 'bagua_annotations', 'bagua_axioms.js'));
const { TOOLS } = require(path.join(CORE, 'modules', 'tools', 'index.js'));
const gate = require(path.join(CORE, 'modules', 'gua_answer_gate.js'));

// 象名唯一真源: 八卦公理表的 nature (震→雷, 艮→山 …)
const XIANG_OF = {};
for (const b of BAGUA_AXIOMS) XIANG_OF[b.name] = b.nature;

test('卦象名的形状只有两种: 上象+下象+卦名 / 卦名+为+象', () => {
  for (const h of HEXAGRAMS) {
    const n = xiangNameOf(h);
    assert.ok(n, h.name + ' 卦没算出卦象名');
    const up = XIANG_OF[h.trigrams.upper_name];
    const low = XIANG_OF[h.trigrams.lower_name];
    if (h.trigrams.upper_name === h.trigrams.lower_name) {
      assert.equal(n, h.name + '为' + up, h.name + ' 纯卦卦象名应为「' + h.name + '为' + up + '」');
    } else {
      assert.equal(n, up + low + h.name, h.name + ' 卦象名应为「' + up + low + h.name + '」');
    }
  }
});

test('64 个卦象名互不重复 (重复就是推错了)', () => {
  const seen = new Map();
  for (const h of HEXAGRAMS) {
    const n = xiangNameOf(h);
    assert.ok(!seen.has(n), '卦象名「' + n + '」重复了: ' + seen.get(n) + ' 与 ' + h.name);
    seen.set(n, h.name);
  }
  assert.equal(seen.size, 64);
});

test('几个熟卦的卦象名逐个核对', () => {
  const want = {
    22: '山火贲', 24: '地雷复', 11: '地天泰', 3: '水雷屯',
    37: '风火家人', 51: '震为雷', 1: '乾为天', 63: '水火既济', 64: '火水未济',
  };
  for (const [id, name] of Object.entries(want)) {
    const h = HEXAGRAMS.find(x => x.id === Number(id));
    assert.equal(xiangNameOf(h), name, '卦序 ' + id + ' 的卦象名');
  }
});

test('卦象名 ≠ 卦义(nature) —— 两样东西不许混成同一个值', () => {
  const ben = HEXAGRAMS.find(h => h.id === 22);
  assert.equal(xiangNameOf(ben), '山火贲');
  assert.equal(ben.nature, '贲饰');
  // 混了就是 E2E 里那个错: 卦象名栏里写着「贲饰」
  assert.notEqual(xiangNameOf(ben), ben.nature);
});

test('工具 hexagram_lookup 的输出同时给 xiang_name 与 nature', async () => {
  const r = await TOOLS.hexagram_lookup({ params: { query: '22' } });
  assert.equal(r.ok, true);
  assert.equal(r.data.name, '贲');
  assert.equal(r.data.xiang_name, '山火贲', '工具必须给卦象名');
  assert.equal(r.data.nature, '贲饰', '工具必须给卦义');
  // 出处**直接给**: 模型为了引用「数据源」自己去 grep 了 3 次源文件(多花 ~15 秒)。
  // 缺的从来不是纪律, 是出处本身 —— 给了出处, 就不用去 grep。
  assert.ok(r.data.source_ref && /64i\/hexagrams\.js/.test(r.data.source_ref),
    '工具必须给 source_ref (出处), 免得模型去 grep 源文件');
});

test('门与工具是同一份推导 (不是各抄一遍)', () => {
  const fb = gate.buildGuaFactsBlock([{ guaIds: [22], claim: 'x', expect: 'y' }]);
  assert.ok(/卦象名 山火贲/.test(fb), '事实块的卦象名');
  assert.ok(/卦义 贲饰/.test(fb), '事实块的卦义');
  // 门认得「地天雷」是错的 (判据 ②b), 且不误伤「山火贲」
  const bad = gate.findGuaContradictions('纳甲：地天雷/艮宫（乙酉）');
  assert.ok(bad.some(x => x.kind === 'xiang3'), '「地天雷」必须被抓出来');
  assert.equal(gate.findGuaContradictions('卦象名 山火贲').length, 0, '「山火贲」是对的, 不许报');
});

