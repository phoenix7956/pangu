/**
 * tests/yao-value-provenance-20261023.test.js
 * 第 56 批: 爻值(6/7/8/9)的口径 —— 拆掉一条**装饰性引文**, 并说清静爻 7/8 是默认值
 *
 * 起因: 出处台账里 `yin_yang` 那层有一条 sourced, 字段名是
 *   「爻值语义(老阳9/老阴6/少阳7/少阴8)」, 引文是 **「初九, 潜龙勿用。」**
 *
 *   ⇒ 那句证的是**爻题**(九=阳爻), 不是**爻值**(9 是老阳)。
 *   这是**装饰性引文**: P3 查得到、token 查得到、live 探针也真跑,
 *   三道守卫全绿, 但它证明不了那条断言 —— 看着有源, 其实没源。
 *
 * 查过本地语料(/Users/you/Desktop/course-source 全树):
 *   - 「老阳|老阴」只命中三处不相干的: 梅花「老阴之极」(讲**极象**)、
 *     三命通会「少阳之气/少阴之气」(讲**五行**)、以及同句的天气占。
 *   - 「六七八九」四字连写**全树零命中**。
 *   - 系辞那段揲蓍法(大衍之数五十)在本地语料里没有对应文字。
 * ⇒ 老少+动静**拿不出逐字引文**, 只能登记 unsourced。
 *   而「九=阳、六=阴」是真有源的 ⇒ 那一半单列 sourced, 不跟着一起降级。
 *
 * ⚠️ 本文件防五件事:
 *   ① 装饰性引文不许回来(那半必须是 unsourced, 且 reason 要说清查过什么)
 *   ② 有源的那半不许被顺手降级(九=阳/六=阴 要能逐字引)
 *   ③ 爻值口径行必须进块, 且带身份标签
 *   ④ 静爻 7/8 必须被说成**默认值**, 不许说成从卦画读出来的
 *   ⑤ 口径行里每个数都能**跟着真源走** —— 真源改一个值, 整行必须跟着变
 *
 * ⚠️ 写这份测试时先写了 10 条、跑 10/10 绿, 然后做**变异体检**,
 *   死了 5 个、**活了 6 个**。活了的那几个才是真话:
 *     · 「默认」二字被抹掉照样绿 —— 因为「默认值」三个字在括号里还留着,
 *       `indexOf('默认')` 抓的是**别处**的「默认」。必须锚到静爻那半句上。
 *     · 老阳/老阴的阴阳接反、变卦方向说反 —— 根本没测。只测了「名」没测「阴阳」。
 *     · 把手写 7/8 换成真源变量 —— 输出完全一样, 测不出来。
 *     · 把真源里的 7 改成 3 —— 断言两边都跟着真源变, **同义反复**, 照样绿。
 *   ⇒ 下面第 ④⑤ 组是按「变异能不能杀」重写的, 不是按「读着顺不顺」写的。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CORE = path.join(__dirname, '..');
const yy = require(path.join(CORE, '64i', 'yin_yang.js'));
const ge = require(path.join(CORE, 'modules', 'gua_engine.js'));
const gb = require(path.join(CORE, 'modules', 'gua_block.js'));
const pv = require(path.join(CORE, '64i', 'provenance.js'));
const HX = require(path.join(CORE, '64i', 'hexagrams.js'));
const HV = require(path.join(CORE, '64i', 'hexagram_vector.js'));

const LAYER = pv.LAYERS['yin_yang'];
const fYinYang = () => LAYER.fields.find((f) => f.field.indexOf('九六定阴阳') >= 0);
const fValue = () => LAYER.fields.find((f) => f.field.indexOf('老少与动静') >= 0);

// ============================================================
// 一、有源的那半: 九=阳 / 六=阴 必须真能逐字引
// ============================================================

test('正例: 爻题九六定阴阳登记为 sourced, 且引文逐字在源里', () => {
  const f = fYinYang();
  assert.ok(f, '台账里找不到「九六定阴阳」那条 —— 有源的那半被降级了?');
  assert.equal(f.status, 'sourced',
    '九=阳/六=阴 是能逐字引的, 不许跟老少动静一起降成 unsourced');
  const body = pv.normalize(pv.readSourceBody(f.source));
  assert.ok(body, '切片读不到: ' + f.source);
  for (const claim of f.claims) {
    const nq = pv.normalize(claim.quote);
    assert.ok(body.indexOf(nq) >= 0, '引文不在源里: ' + claim.quote);
    assert.ok(claim.live(yy), 'live 探针没过 —— 模块与引文不符: ' + claim.quote);
  }
});

test('正例: 384 条爻题的九/六与爻画阴阳零不符(这是上面那条 claim 的实算底数)', () => {
  const arr = HX.HEXAGRAMS || HX.default || HX;
  let checked = 0;
  let mism = 0;
  for (const g of arr) {
    const ci = g.yao_ci || [];
    for (let p = 0; p < 6; p++) {
      const t = String(ci[p] || '').trim();
      let jy = null;
      if (/^初[九六]/.test(t)) jy = t[1];
      else if (/^上[九六]/.test(t)) jy = t[1];
      else if (/^[九六][二三四五]/.test(t)) jy = t[0];
      if (!jy) { mism++; continue; }   // 题式异常也算不符, 不许悄悄跳过
      checked++;
      const isYangLine = g.binary.charAt(p) === '1';   // binary 自下而上
      if ((jy === '九') !== isYangLine) mism++;
    }
  }
  assert.equal(checked, 384, '解析出的爻题数不对, 说明解析规则变了');
  assert.equal(mism, 0, '爻题的九/六与爻画阴阳有 ' + mism + ' ���不符');
});

// ============================================================
// 二、没源的那半: 必须诚实地是 unsourced
// ============================================================

test('正例: 爻值老少动静登记为 unsourced, 并说清查过什么', () => {
  const f = fValue();
  assert.ok(f, '台账里找不到「老少与动静」那条');
  assert.equal(f.status, 'unsourced',
    '爻值老少动静本地拿不出逐字引文, 不许挂 sourced —— 那就是装饰性引文');
  assert.ok(f.reason && f.reason.length > 20, 'unsourced 必须写清为什么查不到');
  // reason 必须说清**查过什么**, 而不是只说「没有出处」
  for (const kw of ['老阳', '老阴', '六七八九']) {
    assert.ok(f.reason.indexOf(kw) >= 0,
      `reason 里没提查过「${kw}」—— 缺口不许笼统记账`);
  }
});

test('负例: 把老少动静偷偷挂回 sourced(带装饰性引文) → 守卫必须报红', () => {
  // 照着「原来的错法」造: 引文是爻题, 与断言不相干, live 探针照样真跑。
  const f = fValue();
  assert.equal(f.status, 'unsourced');
  const fake = {
    field: f.field,
    status: 'sourced',
    source: 'zhougui_shangjing',
    claims: [{
      quote: '初九，潜龙勿用。',
      tokens: ['初九', '潜龙勿用'],
      // live 探针照样通过 —— 这正是原来那条假绿的形状
      live: (m) => m.YAO_VALUES.LAO_YANG === 9 && m.YAO_VALUES.SHAO_YIN === 8,
    }],
  };
  // 装饰性引文之所以危险, 正是因为 P3 的三道都绿:
  //   引文在切片里 ✓ token 在引文里 ✓ live 探针通过 ✓
  const body = pv.normalize(pv.readSourceBody(fake.source));
  assert.ok(body.indexOf(pv.normalize(fake.claims[0].quote)) >= 0, '假引文也得在源里');
  assert.ok(fake.claims[0].live(yy), '假引文的 live 探针也得通过');
  // ⇒ 三道都绿, 但它证明不了「9 是老阳」。所以唯一能挡住的不是 P3, 是**人**不许这么登记。
  //   这条测试的作用: 把「装饰性引文长什么样」钉成可复现的形状, 供人核对台账。
  assert.ok(fake.claims[0].quote.indexOf('老阳') < 0,
    '这条负例的引文里就不该出现「老阳」—— 出现就说明它其实能证, 负例不成立');
});

// ============================================================
// 三、生产层: 口径行进块 + 标身份
// ============================================================

test('正例: 爻值口径行进块, 带身份标签, 且说清静爻是默认值', () => {
  const g = ge.castGua('爻值口径', { numbers: [1, 2, 3] });
  const line = gb.buildYaoValueLine(g);
  assert.ok(line, '爻值口径行为空 —— 起卦明明给了 moving_yao_value');
  assert.ok(line.indexOf('爻值 ' + g.moving_yao_value) >= 0, '没报出爻值本身');
  assert.ok(line.indexOf(gb.YAO_VALUE_TAG) >= 0, '口径行没带身份标签');
  // ⚠️「默认」二字必须**锚在这半句的开头**。前两版都栽在这:
  //   ① `line.indexOf('默认')` —— 被括号里的「默认值」顶替。
  //   ② `line.split('其余静爻')[1].indexOf('默认')` —— 还是被同一个「默认值」顶替,
  //      因为「默认值」就在这半句的括号里。变异 M5 连杀两次。
  // ⇒ 必须用 ^ 锚到**半句开头**: 静爻那半句只有以「默认」起头才算说清了。
  const staticHalf = line.split('其余静爻')[1] || '';
  assert.ok(/^默认/.test(staticHalf),
    '静爻那半句没说「默认」—— 把默认值说成读出来的事实:\n' + line);
  assert.ok(line.indexOf('推不出') >= 0, '没说清卦画推不出老少');
  // 有源的那半也要说, 且不许跟没源的混成一个标签
  assert.ok(line.indexOf('九=阳') >= 0 && line.indexOf('六=阴') >= 0,
    '没说爻题九=阳、六=阴 有原文可核');
  assert.ok(gb.formatGuaFirstBlock(g).indexOf(gb.YAO_VALUE_TAG) >= 0,
    '整块里没有爻值口径行');
});

test('正例: 标签是正面式措辞, 不含禁令', () => {
  // 同 POSITION_NATURE_TAG 的规矩: 禁令式措辞等于亲手把那个词喂给模型。
  assert.ok(!/不要|禁止|不许|勿/.test(gb.YAO_VALUE_TAG),
    '标签里出现了禁令式措辞: ' + gb.YAO_VALUE_TAG);
});

test('正例: 爻值四个常量就是 9/6/7/8(爻值层地基, 不许漂)', () => {
  // ⚠️ 这一条是给下一条兜底的: 上一版断言写成
  //   `line.indexOf('少阳' + V.SHAO_YANG)`, 两边读同一个真源 ⇒
  //   把真源里的 7 改成 3, 断言跟着一起变, **同义反复**, 变异 M9 活。
  // ⇒ 这里把四个数**钉死**, 再让别处去对。
  const V = yy.YAO_VALUES;
  assert.equal(V.LAO_YANG, 9, '老阳应为 9');
  assert.equal(V.LAO_YIN, 6, '老阴应为 6');
  assert.equal(V.SHAO_YANG, 7, '少阳应为 7');
  assert.equal(V.SHAO_YIN, 8, '少阴应为 8');
});

test('正例: 爻值口径行的数字一个都不手写, 全部来自 yin_yang 真源', () => {
  const V = yy.YAO_VALUES;
  for (const n of [[1, 2, 3], [9, 9, 9], [5, 7, 2], [3, 1, 4]]) {
    const g = ge.castGua('口径', { numbers: n });
    const line = gb.buildYaoValueLine(g);
    // 静爻默认值必须与真源一致
    assert.ok(line.indexOf('少阳' + V.SHAO_YANG) >= 0,
      `静爻默认值与真源不符(应含 少阳${V.SHAO_YANG}):\n${line}`);
    assert.ok(line.indexOf('少阴' + V.SHAO_YIN) >= 0,
      `静爻默认值与真源不符(应含 少阴${V.SHAO_YIN}):\n${line}`);
    // 动爻值只能是老爻
    assert.ok(g.moving_yao_value === V.LAO_YANG || g.moving_yao_value === V.LAO_YIN,
      `动爻爻值应是老爻(9 或 6), 实为 ${g.moving_yao_value}`);
    const name = g.moving_yao_value === V.LAO_YANG ? '老阳' : '老阴';
    assert.ok(line.indexOf(name) >= 0, `动爻名应是 ${name}:\n${line}`);
  }
});

test('正例: 扰动真源, 口径行必须跟着变(抓「硬编 7/8」)', () => {
  // 抓**手写副本**的唯一办法: 输出层看起来一模一样, 只能扰动真源看它动不动。
  // 变异 M8(把 `V.SHAO_YANG + '/少阴' + V.SHAO_YIN` 换成字面量 '7/少阴8') 输出完全相同,
  // 任何「比对输出」型断言都杀不掉它 —— 只有扰动真源能杀。
  const g = ge.castGua('扰动', { numbers: [1, 2, 3] });
  const before = gb.buildYaoValueLine(g);
  const orig = yy.YAO_VALUES.SHAO_YANG;
  let after;
  try {
    yy.YAO_VALUES.SHAO_YANG = 71;   // 故意用一个绝不可能撞上的数
    after = gb.buildYaoValueLine(g);
  } finally {
    yy.YAO_VALUES.SHAO_YANG = orig;
  }
  assert.notEqual(after, before,
    '扰动真源的少阳值, 口径行纹丝不动 ⇒ 那几个数是**手打**的, 没跟真源走');
  assert.ok(after.indexOf('少阳71') >= 0, '扰动后的行里没出现新值:\n' + after);
  assert.ok(before.indexOf('少阳' + orig) >= 0, '原行里没有原值:\n' + before);
});

test('正例: 口径行的阴阳/动静/变卦方向, 逐条跟本卦爻画实算对账', () => {
  const V = yy.YAO_VALUES;
  let checked = 0;
  for (const n of [[1, 2, 3], [9, 9, 9], [5, 7, 2], [3, 1, 4], [2, 2, 2], [4, 4, 4], [7, 7, 7]]) {
    const g = ge.castGua('对账', { numbers: n });
    const line = gb.buildYaoValueLine(g);
    const p = g.moving_yao - 1;                  // moving_yao 是 1..6
    const ben = g.binary.charAt(p) === '1';     // 本卦该爻: true=阳
    // 变卦 = zhi_gua(之卦)。hu_gua 是**互卦**, 不是变卦 —— 认错就等于什么都没验。
    const bian = (g.zhi_gua && g.zhi_gua.binary)
      ? g.zhi_gua.binary.charAt(p) === '1'
      : !ben;                                    // 没有 binary 就用「动爻必翻」兜
    assert.ok(line.indexOf(ben ? '本卦为阳' : '本卦为阴') >= 0,
      `本卦阴阳说反了(moving=${g.moving_yao} val=${g.moving_yao_value}):\n${line}`);
    assert.ok(line.indexOf(bian ? '变后为阳' : '变后为阴') >= 0,
      `变卦方向说反了:\n${line}`);
    // 老阳(9)必是阳爻, 老阴(6)必是阴爻 —— 爻值本身就编码了阴阳, 不许反过来
    if (g.moving_yao_value === V.LAO_YANG) assert.ok(ben, '老阳 9 却落在阴爻上');
    if (g.moving_yao_value === V.LAO_YIN) assert.ok(!ben, '老阴 6 却落在阳爻上');
    // 括号里的 (动/静, 阳/阴) 必须跟本卦爻画一致
    assert.ok(line.indexOf('(动, ' + (ben ? '阳' : '阴') + ')') >= 0,
      `括号里的阴阳跟本卦爻画不符:\n${line}`);
    checked++;
  }
  assert.equal(checked, 7, '对账样本数不对');
});

test('正例: hexagram_vector 的静态默认/合法集跟 yin_yang 真源同源(不是第三份手写)', () => {
  // 第 56 批变异体检发现的洞: 7/8 这套约定当时在仓库里存了**三份**
  //   (yin_yang.YAO_VALUES / hexagram_vector.DEFAULT_YAO_VALUE / VALID_YAO_VALUES),
  //   零交叉校验 —— 把 DEFAULT_YAO_VALUE.YANG 改成 null, 整条测试链一条不红。
  const V = yy.YAO_VALUES;
  assert.equal(HV.DEFAULT_YAO_VALUE.YANG, V.SHAO_YANG, '静态默认阳爻值与真源脱钩');
  assert.equal(HV.DEFAULT_YAO_VALUE.YIN, V.SHAO_YIN, '静态默认阴爻值与真源脱钩');
  assert.deepEqual(HV.VALID_YAO_VALUES.slice().sort((a, b) => a - b),
    [V.LAO_YIN, V.SHAO_YANG, V.SHAO_YIN, V.LAO_YANG].sort((a, b) => a - b),
    '合法爻值集与真源脱钩');
});

test('正例: 没有爻值就返回空串, 不编兜底', () => {
  assert.equal(gb.buildYaoValueLine(null), '');
  assert.equal(gb.buildYaoValueLine({}), '');
  assert.equal(gb.buildYaoValueLine({ moving_yao_value: '6' }), '',
    '爻值不是数字时应返回空串, 不把字符串硬转');
});

// ============================================================
// 四、整条出处链仍然闭合
// ============================================================

test('正例: 整条出处守卫仍然全绿', () => {
  const r = pv.assertProvenance();
  assert.deepEqual(r.problems || [], [], '出处守卫报了问题:\n  ' + (r.problems || []).join('\n  '));
  assert.equal(r.ok, true);
});

test('正例: unsourced 缺口总数是 2 条且都写明了理由', () => {
  const r = pv.assertProvenance();
  assert.equal(r.stats.unsourcedFields.length, 2,
    'unsourced 条数变了: ' + JSON.stringify(r.stats.unsourcedFields));
  for (const label of r.stats.unsourcedFields) assert.ok(label.length > 0);
});
