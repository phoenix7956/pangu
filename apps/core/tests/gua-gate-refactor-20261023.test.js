/**
 * tests/gua-gate-refactor-20261023.test.js
 * 第 58 批: 起卦门词表搬家 (pangu-single.js → modules/gua_gate_kws.js) 的**纯重构**证明
 *
 * 背景: 做「分层编排」时发现, 判断「主人要不要卦」的那批词只存在于
 *   pangu-single.js 的私有 const 里。编排层要在另一个模块里判断同一件事,
 *   照抄第二份就是盘古 2026-10-21 亲自踩过的坑:
 *   「**两份同义文本各改各的, 改一次就漂一次**」。
 *
 * 搬法: 词表**逐字**搬过去, pangu-single.js 用同名别名解构接回来 ⇒ 其余引用一行没动。
 * 本测试拿搬走前的原件(快照)逐项比对, 证明:
 *   ① 搬家是**纯重构**: 一个词没少、没多、没重排、没改
 *   ② 搬走之后**有意**补的词, 单独登记在快照的 ADDED 里 —— 漏登记就红
 *   ③ pangu-single.js 里那几份**本地副本真的没了**(搬家若做一半, 两份会各改各的)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const M = (p) => require(path.join(CORE, p));

const GATE = M('modules/gua_gate_kws.js');
const { ORIGINAL, ADDED } = require('./gate_kws_snapshot.js');
const SINGLE_SRC = fs.readFileSync(path.join(CORE, 'pangu-single.js'), 'utf8');

/** 快照里存的是「源码文本」, 求值成数组 */
function originalList(key) {
  const raw = ORIGINAL[key];
  assert.ok(raw, '快照里没有这张表: ' + key);
  if (key.endsWith('_RE')) return eval('(' + raw + ')').source;   // eslint-disable-line no-eval
  return eval('(' + raw + ')');                                    // eslint-disable-line no-eval
}

test('搬家: 每张表现在 == 搬走前的原件 + 登记过的增补 (顺序也不许变)', () => {
  for (const key of Object.keys(ORIGINAL)) {
    const name = key.replace(/^_/, '');
    const cur = GATE[name];
    assert.ok(cur !== undefined, '表没了: ' + name);
    const want = originalList(key);
    if (name.endsWith('_RE')) {
      assert.equal(cur.source, want, '正则变了: ' + name);
      assert.equal((ADDED[name] || []).length, 0, '正则表不许增补');
      continue;
    }
    const added = ADDED[name] || [];
    assert.deepEqual(cur, want.concat(added),
      `表 ${name} 与「原件 + 登记过的增补」不一致 —— `
      + '要么搬走时改了词(搬家就不是纯重构了), 要么增补没登记进快照的 ADDED');
  }
});

test('搬家: 增补登记里不许出现快照里没有的表 (不许凭空多一张)', () => {
  const names = new Set(Object.keys(ORIGINAL).map((k) => k.replace(/^_/, '')));
  for (const k of Object.keys(ADDED)) {
    assert.ok(names.has(k), 'ADDED 里出现了快照没有的表: ' + k);
  }
});

test('搬家: pangu-single.js 里那几份本地副本**真的没了** (搬家做一半 = 两份各改各的)', () => {
  for (const key of Object.keys(ORIGINAL)) {
    assert.ok(SINGLE_SRC.indexOf('const ' + key + ' = [') < 0,
      'pangu-single.js 里还留着本地副本 ' + key
      + ' —— 那就变成两份同义文本各改各的(2026-10-21 踩过的坑)');
  }
  // 反过来: 别名解构必须在, 否则那些引用会变成 undefined
  assert.match(SINGLE_SRC, /PURE_CHAT_KWS: _PURE_CHAT_KWS/);
  assert.match(SINGLE_SRC, /GUA_SUPPRESS_KWS: _GUA_SUPPRESS_KWS/);
});

test('搬家: 别名接回来之后, 那两个判定函数的引用一个字都没改', () => {
  // pangu-single.js 里 _shouldCastGua / _shouldUseDispatcher 仍用下划线别名 ——
  //   搬家若顺手改了函数体里的名字, 行为就可能悄悄变。
  //
  // 2026-10-26 (第 105 批) 例外: **纯闲聊那一处**是**有意**改的 ——
  //   从 `_PURE_CHAT_KWS.some(includes)` 换成 `_isPureChat(text)`。
  //   原因: 字面 includes 白名单会让主人插一个字就掉出白名单 ⇒ 纯闲聊白起一卦
  //   (生产实测: 「你到底是谁」真起了「否」卦)。
  //   改完**仍是同一份真源**, 只是从「共用一张词表」升级成「共用一个函数」——
  //   词表共用还可能各自加工, 函数共用就是逐位同一份 ⇒ 漂移这件事结构上不可能。
  //   本条的其余意图 (搬家是纯重构, 其余别名一字没动) 不变。
  const body = SINGLE_SRC.slice(
    SINGLE_SRC.indexOf('function _shouldCastGua'),
    SINGLE_SRC.indexOf('function _shouldUseDispatcher'));
  for (const alias of ['_GUA_DECISION_KWS', '_GUA_CAST_REQUEST_KWS',
    '_GUA_SUPPRESS_KWS', '_GUA_EXEC_KWS', '_isGuaFactLookup']) {
    assert.ok(body.indexOf(alias) >= 0, '起卦门里这个引用不见了: ' + alias
      + ' —— 搬家若顺手改了函数体里的名字, 行为就可能悄悄变');
  }
  // 纯闲聊那一处: 必须走模块真源的 isPureChat, 不许回退成字面词表
  assert.match(body, /_isPureChat\(/, '起卦门没走模块真源的 isPureChat');
  assert.doesNotMatch(body, /_PURE_CHAT_KWS\.some\(/,
    '起卦门又用回字面 includes 白名单了 (那正是第 105 批要治的病)');
  // 且它必须是从 modules/gua_gate_kws 解构接回来的 (不是本地副本)
  assert.match(SINGLE_SRC, /isPureChat: _isPureChat/,
    '_isPureChat 不是从唯一真源接回来的');
});

test('判定: 主人明说要卦 → 认 (含口语说法)', () => {
  // 这张表的全部意义就是规则 19(a)「主人明确说算一卦 → 必调」。
  for (const s of ['算一卦', '算卦', '算个卦', '起一卦', '起卦', '起个卦',
    '推一卦', '推个卦', '看一卦', '看个卦', '占一卦', '占个卦',
    '摇一卦', '摇卦', '摇个卦', '卜一卦', '卜个卦', '来一卦',
    '给我算一卦', '起个卦看看', '摇个卦看财运']) {
    assert.equal(GATE.isGuaCastRequest(s), true, '明说要卦却没认出来: ' + s);
  }
  assert.equal(GATE.isGuaCastRequest('这个项目该不该继续做'), false);
  assert.equal(GATE.isGuaCastRequest(''), false);
});

test('判定: 卦资料查询 与 明确要卦 分得清', () => {
  assert.equal(GATE.isGuaFactLookup('第24卦是哪一卦'), true);
  assert.equal(GATE.isGuaFactLookup('雷风恒卦的卦辞是什么'), true);
  // 明确要卦时, 资料查询要让位(主人要的是卦, 不是资料)
  assert.equal(GATE.isGuaFactLookup('算一卦'), false);
});

test('判定: 谋断优先 (不该被当成查表题)', () => {
  assert.equal(GATE.isDecisionQuestion('这个项目该不该继续做'), true);
  assert.equal(GATE.isDecisionQuestion('帮我查一下成交量'), false);
});

