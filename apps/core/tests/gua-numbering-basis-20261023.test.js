/**
 * tests/gua-numbering-basis-20261023.test.js
 * 第 54 批: 卦块里的**编号口径行**
 *
 * 起因(老板 10-22 起连着三次问编号, 根子是同一个):
 *   同一个东西有两套号, 两套在数字上都合法, **用错了不报错、只静悄悄答错**:
 *     ① 64 卦: id(文王序 1..64) vs index(二进制 0..63)
 *     ② 八卦:  先天数(乾1兑2…) vs 后天数(坎1坤2…)
 *   ② 尤其险: 两套**都是 1..8**, 而且**只有艮在两套里都是 7** ——
 *   坎 6/1、坤 8/2、震 4/3、巽 5/4、乾 1/5、兑 2/6、离 3/8 各不相同。
 *   问「震是第几卦」, 答 4 和答 3 都对得住, 取决于用了哪套。
 *
 *   而这块(`formatGuaFirstBlock`)是模型起卦时**真正读到**的东西 ——
 *   口径不在这儿, 模型就永远不知道自己在报哪一套。
 *
 * ⚠️ 本文件防三件事:
 *   ① 口径行里的数字**必须**与真源一致(不许手写、不许漂)
 *   ② 真源取不到时**必须**返回空串(块里少一行), 不许编数字兜底
 *   ③ 与第 53 批 `NUMBERING_BASIS` 是**同一件事**, 不许各说各话
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CORE = path.join(__dirname, '..');
const gb = require(path.join(CORE, 'modules', 'gua_block.js'));
const { castGua } = require(path.join(CORE, 'modules', 'gua_engine.js'));
const bp = require(path.join(CORE, '64i', 'bagua_annotations', 'bagua_positions.js'));

const XIAN = Object.fromEntries(bp.XIAN_TIAN_SEQ.map((s) => [s.name, s.position]));
const HOU = Object.fromEntries(bp.HOU_TIAN_SEQ.map((s) => [s.name, s.position]));

// ============================================================
// 一、正例: 口径行必须真说清两套号
// ============================================================

test('正例: 每个卦都能起出卦, 且口径行同时给出 id 和 index', () => {
  // 覆盖多个卦, 不只一个 —— 口径行不能只对某几个卦成立
  for (const n of [[7, 8, 3], [1, 2, 5], [3, 1, 4], [9, 9, 9], [5, 7, 2]]) {
    const g = castGua('口径测试', { numbers: n });
    const line = gb.buildNumberingBasisLine(g);
    assert.ok(line, '起卦 ' + n.join(',') + ' 没产出口径行');
    assert.ok(line.includes('id=' + g.gua_id),
      '口径行缺 id: ' + line + '\n(卦 ' + n.join(',') + ')');
    assert.ok(line.includes('index=' + parseInt(g.binary, 2)),
      '口径行缺 index: ' + line + '\n(卦 ' + n.join(',') + ')');
  }
});

test('正例: 上下卦的先天/后天数与真源一致(一个数字都不许手写)', () => {
  for (const n of [[7, 8, 3], [1, 2, 5], [3, 1, 4]]) {
    const g = castGua('口径测试', { numbers: n });
    const line = gb.buildNumberingBasisLine(g);
    for (const k of [g.upper_trigram, g.lower_trigram]) {
      assert.ok(XIAN[k] !== undefined && HOU[k] !== undefined, '真源里没有 ' + k);
      assert.ok(line.includes(k + ' 先天' + XIAN[k] + '/后天' + HOU[k]),
        '口径行与真源不一致, 缺「' + k + ' 先天' + XIAN[k] + '/后天' + HOU[k] + '」:\n' + line);
    }
  }
});

test('正例: 口径行进的是真卦块, 不是只存在于一个没人调用的函数里', () => {
  // 防「函数写了但没接上」—— 上一批就栽过这种(加了标签常量但没真进生产文本)
  const g = castGua('口径测试', { numbers: [1, 2, 5] });
  const block = gb.formatGuaFirstBlock(g);
  assert.ok(block.includes(gb.buildNumberingBasisLine(g)),
    '口径行没有出现在 formatGuaFirstBlock 的输出里 —— 模型读不到:\n' + block);
  assert.ok(block.includes('id=' + g.gua_id), '整块里找不到 id:\n' + block);
});

test('正例: 口径行落在事实之后、卦象解读之前(不违反 10-09 老板定的顺序)', () => {
  const g = castGua('顺序测试', { numbers: [1, 2, 5] });
  const block = gb.formatGuaFirstBlock(g);
  const iGua = block.indexOf('本卦:');
  const iNum = block.indexOf(gb.NUMBERING_NOTE_HEAD);
  const iOrder = block.indexOf('回答顺序');
  assert.ok(iGua >= 0 && iNum > iGua, '口径行必须在本卦事实之后');
  assert.ok(iOrder > iNum, '口径行必须排在卦象解读顺序行之前, 否则它会被当成卦象的一部分');
});

// ============================================================
// 二、这条线专门点破的坑: 两套八卦号只在一个卦上相同
// ============================================================

test('正例: 八卦两套号只有艮相同 —— 口径行必须点破这件事', () => {
  const same = Object.keys(XIAN).filter((k) => XIAN[k] === HOU[k]);
  assert.deepEqual(same, ['艮'],
    '真源变了(先天/后天相同的八卦不再只有艮) —— 口径行里那句「只有艮两套相同」就是假话, 得改文案');
  const g = castGua('艮测试', { numbers: [7, 8, 3] });   // 剥 = 艮上坤下
  assert.ok(gb.buildNumberingBasisLine(g).includes('只有艮两套相同'),
    '口径行没点破「只有艮相同」这个最容易混的点');
});

test('正例: 老板那张表(乾=111=7)与口径行对得上', () => {
  // 老板 10-22 原话给的表: 乾=111=7 兑=110=6 … 坤=000=0
  // 先天数 = 8 − parseInt(bits,2), 逐条验
  const { BAGUA_AXIOMS } = require(path.join(CORE, '64i', 'bagua_annotations', 'bagua_axioms.js'));
  const boss = { 乾: '111', 兑: '110', 离: '101', 震: '100', 巽: '011', 坎: '010', 艮: '001', 坤: '000' };
  for (const a of BAGUA_AXIOMS) {
    const bits = boss[a.name];
    assert.equal(bits, a.bits, a.name + ' 的 bits 与老板表不一致');
    assert.equal(8 - parseInt(a.bits, 2), a.trigramIndex, a.name + ' 先天数与 8−bits 不符');
    assert.equal(a.trigramIndex, XIAN[a.name], a.name + ' 先天数与真源 XIAN_TIAN_SEQ 不符');
  }
});

// ============================================================
// 三、负例: 取不到真源不许编数字
// ============================================================

test('反例: 卦名在真源里查不到时, 那一段必须整段不报, 不许编数字兜底', () => {
  // 走**真实代码路径**: 传一个真源里没有的卦名。
  // ⚠️ 不用 mock 打断 require —— bagua_positions 早被本文件顶部的 require 缓存了,
  //   mock `_load` 根本不会被调用, 那条负例会假绿(测了个没发生的事)。
  //   真源读不到的情形由 `_trigramNumbers` 的 try/catch 兜底成 null,
  //   效果跟这里测的「查不到就不报」同源, 所以这条测得住。
  const line = gb.buildNumberingBasisLine({
    gua_name: '测试', gua_id: 5, binary: '000111',
    upper_trigram: '不存在卦', lower_trigram: '也不存在',
  });
  assert.ok(!line.includes('先天'), '查不到的卦名还在报先天数:\n' + line);
  assert.ok(!line.includes('后天'), '查不到的卦名还在报后天数:\n' + line);
  // id/index 是从 gua 自己的字段算的, 跟八卦真源无关, 仍应照报
  assert.ok(line.includes('id=5'), '卦序那段被连累丢了:\n' + line);
});

test('反例: 一上一下只有一个查得到时, 只报查得到的那一个(不许半截编造)', () => {
  const line = gb.buildNumberingBasisLine({
    gua_name: '测试', gua_id: 5, binary: '000111',
    upper_trigram: '乾', lower_trigram: '不存在卦',
  });
  assert.ok(line.includes('乾 先天' + XIAN['乾'] + '/后天' + HOU['乾']),
    '查得到的那个没报:\n' + line);
  assert.ok(!line.includes('不存在卦'), '查不到的卦名出现在口径行里:\n' + line);
});

test('反例: 没有 gua / 没有卦名时口径行必须为空串(不许抛错)', () => {
  assert.equal(gb.buildNumberingBasisLine(null), '');
  assert.equal(gb.buildNumberingBasisLine(undefined), '');
  assert.equal(gb.buildNumberingBasisLine({}), '');
  // 变异体检发现: 「没有 gua_name 就返回空串」这条曾是**死条件** ——
  // 口径行压根没用卦名(卦名在上一行「本卦:」里), 把那个检查删掉也没人红。
  // ⇒ 死条件已删, 这里只钉真正的契约: 没有数据就没有口径行。
  assert.equal(gb.buildNumberingBasisLine({ gua_name: '乾' }), '',
    '只有卦名、没有 id/binary/上下卦时不该凭空拼出口径行');
});

test('反例: binary 不是合法 6-bit 时不许瞎报 index', () => {
  const line = gb.buildNumberingBasisLine({
    gua_name: '测试', gua_id: 5, binary: 'abc', upper_trigram: '乾', lower_trigram: '坤',
  });
  assert.ok(!line.includes('index='),
    'binary 非法还报了 index —— 那是从垃圾字符串 parse 出来的数:\n' + line);
});

// ============================================================
// 四、与第 53 批 NUMBERING_BASIS 对齐(不许两处各说各话)
// ============================================================

test('正例: 八卦两套号在第 53 批编号基址表里也标着「独立/派生」, 两处口径不许打架', () => {
  const ylb = require(path.join(CORE, 'modules', 'yao_layer_boundary.js'));
  const basis = ylb.NUMBERING_BASIS;
  assert.ok(Array.isArray(basis) && basis.length, 'NUMBERING_BASIS 取不到');
  const hou = basis.find((b) => b.key === 'baguaHouTian');
  const xian = basis.find((b) => b.key === 'baguaXianTian');
  assert.ok(hou && xian,
    '编号基址表里找不到 baguaHouTian / baguaXianTian —— 键名变了, 这条要跟着改');
  assert.equal(hou.kind, 'independent', '后天数在编号基址表里应标 independent(非单调, 只能查表)');
  assert.equal(xian.kind, 'derived', '先天数在编号基址表里应标 derived(它是 bits 的函数)');
});

test('全仓不变量: 卦块里不许出现没标明是哪一套的裸八卦号', () => {
  // 防「口径行写了, 但另一条路径又把没标的号塞回块里」。
  // 口径行自己那两个数字后面都带「先天N/后天N」, 所以只查**没跟标签的**。
  const g = castGua('裸号检查', { numbers: [1, 2, 5] });
  const block = gb.formatGuaFirstBlock(g);
  const stripNumbered = block
    .replace(/先天\d+\/后天\d+/g, '')
    .replace(/id=\d+/g, '')
    .replace(/index=\d+/g, '')
    .replace(/0\.\.63|1\.\.64/g, '');
  // 块里剩下的「N上M下」是卦名(乾上兑下), 不是编号 —— 不算裸号。
  assert.ok(!/(第[零一二三四五六七八九\d]+卦|卦序\s*\d+号)/.test(stripNumbered),
    '块里出现了没标明基数的卦序说法:\n' + block);
});
