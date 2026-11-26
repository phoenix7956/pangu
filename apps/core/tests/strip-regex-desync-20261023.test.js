/**
 * tests/strip-regex-desync-20261023.test.js
 * 第 53 批: 剥注释/剥字符串的词法器在**含引号的正则字面量**上整体错位
 *
 * 起因(不是假想, 是真的咬到了):
 *   第 53 批加完编号基址表, 整链 EXIT=1, 报的是
 *     「B 类字段进了生产: bagua_positions 的属性 `number` 出现在
 *       modules/yao_layer_boundary.js:1190」
 *   去看那一行 —— 是 `typeof tr.changedIndex !== 'number'`。
 *   **`number` 是个字符串字面量, 跟洛书九宫数那个 `number` 字段毫无关系。**
 *
 * 根因: 剥字符串的 `_stripCommentsAndStrings` 是手写状态机,
 *   早于它自己被发明出来的那个仓库里到处是:
 *     `.replace(/'(?:\\.|[^'\\])*'/g, "''")`   ← yao_layer_boundary.js:609
 *   正则里的 `'` 被当成「字符串开始」, 从此**往后每一行都被当成字符串内容**。
 *   后果是双向的, 而且**静默**(函数照常返回, 不抛不报):
 *     · 假红 —— 真出处的负例被噪声淹掉(上面那次整链红)
 *     · 假绿 —— 真引用若落在错位区**之后**, 守卫再也看不见它
 *   第二种更坏: 那道守卫看起来在跑, 实际已经瞎了。
 *
 * ⚠️ 本文件防的不只是「除号被误判成正则」, 还有「正则没被认出来」——
 *   两个方向都得钉住, 否则修一头烂一头(这个月已经栽过好几次单边修复)。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CORE = path.join(__dirname, '..');
const MODULES = path.join(CORE, 'modules');

// ============================================================
// 零、把被测的剥除器原样抠出来(测真的那个, 不是重写一遍)
// ============================================================
//   重写一遍 = 测的是我抄的那份, 不是仓库里跑的那份。
//   这里从 provenance.js 源码里切出函数体 + 它的常量, 用 new Function 组起来。
function loadStripper() {
  const src = fs.readFileSync(path.join(CORE, '64i', 'provenance.js'), 'utf8');
  const cIdx = src.indexOf('const _RE_REGEX_CONTEXT_BEFORE');
  assert.ok(cIdx > 0, '抠不到 _RE_REGEX_CONTEXT_BEFORE —— 词法器的上下文表没了');
  const cEnd = src.indexOf('\n\n', cIdx);
  const decl = src.slice(cIdx, cEnd);
  const fIdx = src.indexOf('function _stripCommentsAndStrings');
  assert.ok(fIdx > 0, '抠不到 _stripCommentsAndStrings —— 守卫 P13 的地基没了');
  const fEnd = src.indexOf('\n}\n', fIdx) + 3;
  const fn = src.slice(fIdx, fEnd);
  // eslint-disable-next-line no-new-func
  return new Function(decl + '\n' + fn + '; return _stripCommentsAndStrings;')();
}

const strip = loadStripper();

// ============================================================
// 一、正例: 该剥的剥干净
// ============================================================

/**
 * ⚠️ 下面所有用例都用**两行以上**的片段, 不是单行。
 *   原因: 错位是**累积**的 —— 必须先出现一个含引号的正则, 后面的行才会被吞。
 *   拿单行去测, 每条都绿, 而旧版其实一样绿 ⇒ 整份测试是摆设(恒真)。
 *   这个坑本月已经栽过一次(第 51 批的 7 条恒真正例), 所以这里写死这条规矩。
 */
const REGEX_LINE = "src.replace(/'(?:\\\\.|[^'\\\\])*'/g, \"''\")";

test('正例: 注释与字符串字面量被剥掉, 标识符留着', () => {
  assert.equal(
    strip('const a = "hello"; // number here\nlet b = 2;'),
    'const a = ""; \nlet b = 2;'
  );
});

test('正例: 字符串里的 `number` 不许留下裸标识符(这条就是那次假红的原型)', () => {
  const out = strip("if (typeof tr.changedIndex !== 'number' || tr.changedIndex > 63) {");
  assert.ok(!/(^|[^\w$])number(?![\w$])/.test(out),
    '剥完还留着裸 `number`, P13 会把它当成洛书字段的消费 ⇒ 假红:\n' + out);
  assert.ok(out.includes('typeof tr.changedIndex'), '真代码不该被剥掉:\n' + out);
});

test('正例: 含引号的正则字面量整段被吞, 后面那行不许被带偏', () => {
  const src = REGEX_LINE + "\nif (typeof tr.changedIndex !== 'number') { x(); }";
  const out = strip(src);
  assert.equal(out, 'src.replace("", "")\nif (typeof tr.changedIndex !== "") { x(); }',
    '含引号的正则没被认出来 ⇒ 后面整行被吞 ⇒ 实测: ' + JSON.stringify(out));
});

test('正例: 注释里写 `x.number` 不算消费(提到 ≠ 引用)', () => {
  // 守卫的立意: 注释里提到不算数, 否则第一天就假红。
  const out = strip('// 这里读了 bagua_positions.number, 但只是注释\nconst q = 1;');
  assert.ok(!/(^|[^\w$])number(?![\w$])/.test(out),
    '注释里的 number 漏出来了, 守卫会把注释当引用:\n' + out);
});

// ============================================================
// 二、负例(反例): 这才是真在咬人的部分
// ============================================================

test('反例: 真消费 `.number` 剥完必须还看得见(守卫靠它咬人)', () => {
  const out = strip(REGEX_LINE + '\nconst n = bagua_positions.number;');
  assert.ok(/(^|[^\w$])number(?![\w$])/.test(out),
    '真引用被剥掉了 ⇒ P13 永远绿 ⇒ 守卫成了摆设:\n' + out);
});

test('反例: 除号不许被当成正则开头(单边修复最容易栽在这)', () => {
  // 这一行就是 llm_caller.js:1030 的真形。修之前它被吞掉一大段。
  const out = strip(REGEX_LINE
    + "\nconst r = beforeTokens / Math.max(1, require('./h').len(useModel));");
  assert.ok(out.includes('Math.max'), '除号后的代码被吞了:\n' + out);
  assert.ok(!out.includes('./h'),
    'require 的路径字符串没剥干净(说明状态机错位):\n' + out);
  assert.ok(!/(^|[^\w$])number(?![\w$])/.test(out),
    '错位导致后面的 token 漏了出来:\n' + out);
});

test('反例: 关键字后面的 `/` 是正则不是除号(return /x/.test(s))', () => {
  const out = strip(REGEX_LINE + "\nfunction f(s) { return /'\"\\//.test(s) ? 1 : 0; }");
  assert.ok(!out.includes("'") && !out.includes('"') || /return ""\.test/.test(out),
    'return 后面的正则没被认出来 ⇒ 引号漏出 ⇒ 错位:\n' + out);
  assert.ok(/return ""\.test\(s\)/.test(out),
    '正则没被替换成 `""`, 说明 `return` 没被认成正则上下文:\n' + out);
});

test('反例: 模板里的 ${...} 要能装下嵌套引号和嵌套模板(scheduler.js:260 那种形状)', () => {
  const src = 'const s = `#head\\n- ${list.map(i => `- ${i.msg || \'na\'}`).join(\'\\n\')}\\n`;\n'
    + 'const n = pos.number;';
  const out = strip(src);
  assert.ok(out.includes('pos.number'),
    '嵌套模板把状态机带偏了 ⇒ 后面的真引用丢了(守卫会瞎):\n' + out);
  assert.ok(!/['`]/.test(out.replace(/_TPL|\(|\)/g, '')),
    '模板没剥干净, 漏了引号或反引号:\n' + out);
});

// ============================================================
// 三、全仓不变量: 剥完之后不可能再有裸引号
// ============================================================
//   这是覆盖面最广的一条。剥除器把每个字符串换成 `""`,
//   所以剥完的文本里**只允许** `""` 这种成对占位符。
//   一旦某处错位, 必有落单的 `'` 或 ` 或者奇数长度的 `"` 串。
test('全仓不变量: modules/ 每个文件剥完后都不许有落单引号', () => {
  const bad = [];
  for (const f of fs.readdirSync(MODULES)) {
    if (!f.endsWith('.js')) continue;
    const out = strip(fs.readFileSync(path.join(MODULES, f), 'utf8'));
    const loneSq = (out.match(/'/g) || []).length;
    const backtick = (out.match(/`/g) || []).length;
    const oddRuns = (out.match(/"+/g) || []).filter((r) => r.length % 2 === 1).length;
    if (loneSq || backtick || oddRuns) {
      bad.push(f + '(单引号 ' + loneSq + ' / 反引号 ' + backtick + ' / 奇数引号串 ' + oddRuns + ')');
    }
  }
  assert.deepEqual(bad, [],
    '这些文件剥除后引号不成对 ⇒ 词法器错位 ⇒ P13 在这些文件上又瞎又吵:\n' + bad.join('\n'));
});

test('全仓不变量: 剥除前后行数必须一致(报错行号才对得上源码)', () => {
  const bad = [];
  for (const f of fs.readdirSync(MODULES)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(MODULES, f), 'utf8');
    const a = src.split('\n').length;
    const b = strip(src).split('\n').length;
    if (a !== b) bad.push(f + '(' + a + '→' + b + ')');
  }
  assert.deepEqual(bad, [],
    '行数变了 ⇒ P13 报的 :行号 会指错地方:\n' + bad.join('\n'));
});

test('全仓不变量: 剥完必须仍是合法 JS(抓错位最狠的一条)', () => {
  // 为什么这条最狠: 词法器一旦错位, 后面整段会被当成字符串内容吞掉 ——
  // 引号还可能凑巧成对、括号也可能凑巧配平(本仓库里两种都发生过),
  // 但**语法**几乎不可能还成立。
  // ⚠️ 模板字面量因此被换成一个函数调用 `_TPL(…)` 而不是 `""`:
  //   `String.raw` + `""` 是两个表达式 juxtapose, 自己就先成了语法错,
  //   那这条不变量就废了(自己先炸的不变量没有价值)。
  // ⚠️ 已知盲区: `if (x) /re/.test(y)` —— 右括号后的 `/` 二义(除号 vs 正则)。
  //   仓库里现在没有这种写法, 真出现时**这条会当场报红**, 那正是它该做的事。
  const bad = [];
  for (const f of fs.readdirSync(MODULES)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(MODULES, f), 'utf8');
    let srcOk = true;
    try { new vm.Script(src); } catch (_) { srcOk = false; }
    if (!srcOk) continue;               // 原文自己就编译不过 ⇒ 不归这条管
    try {
      new vm.Script(strip(src));
    } catch (e) {
      bad.push(f + '(' + e.message + ')');
    }
  }
  assert.deepEqual(bad, [],
    '这些文件剥完不是合法 JS ⇒ 词法器错位 ⇒ P13 在它们身上又瞎又吵:\n' + bad.join('\n'));
});

// ============================================================
// 四、端到端: P13 那道守卫本身还会不会咬人
// ============================================================
//   前面测的都是「剥除器」。可这套东西存在的唯一理由是 P13 这道守卫
//   (「B 类字段不许悄悄进生产」)。剥除器再对, 守卫不咬人也等于没有 ——
//   所以最后必须从**守卫的出口**验一次: 真塞一个 `.number` 消费者进去,
//   `assertProvenance()` 必须报红。
//
//   为什么必须复制 modules/ 而不是软链: `_scanProductionForAttrs` 扫的是
//   `path.join(__dirname, '..', 'modules')` —— 软链到真 modules 的话改不到,
//   变异不生效, 这条负例就是假绿(第 45 批栽过)。

const { copyTree } = require('./helpers/provenance_mutate');

function withMutatedModules(mutator) {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pangu-strip-'));
  copyTree(path.join(CORE, '64i'), path.join(root, '64i'));
  copyTree(MODULES, path.join(root, 'modules'));
  mutator(path.join(root, 'modules'));
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(root)) delete require.cache[k];
  }
  return require(path.join(root, '64i', 'provenance.js'));
}

test('端到端正例: 真代码 P13 全绿(改词法器之后它没变成永远绿)', () => {
  const P = require(path.join(CORE, '64i', 'provenance.js'));
  const r = P.assertProvenance();
  assert.ok(r.ok, '真代码报红:\n' + r.problems.join('\n'));
  assert.ok(r.stats.notInProductionWatched > 0, 'P13 一个字段都没在盯 ⇒ 守卫空转');
});

const CANARY_FILE = 'pangu_p13_canary.js';

/** P13 报到 canary 文件上的那几条(只认这一份文件的报, 见下面的警告)。 */
function p13HitsOnCanary(problems) {
  return problems.filter((p) => p.includes('B 类字段进了生产')
    && p.includes('number') && p.includes(CANARY_FILE));
}

test('端到端反例: 生产代码真读 bagua_positions.number ⇒ P13 必须报红', () => {
  const P2 = withMutatedModules((mods) => {
    fs.writeFileSync(path.join(mods, CANARY_FILE),
      "'use strict';\n"
      + "const _pos = require('../64i/bagua_annotations/bagua_positions.js');\n"
      + "module.exports.read = function () { return _pos.XIAN_TIAN_BAGUA.qian.number; };\n");
  });
  const r = P2.assertProvenance();
  assert.ok(!r.ok, '塞了真消费者 P13 还不报 ⇒ 守卫已经瞎了(比没守卫更坏)');
  assert.ok(p13HitsOnCanary(r.problems).length,
    '报红了但没报到 canary 文件头上, 报的是别的:\n' + r.problems.join('\n'));
});

test('端到端反例: 消费者藏在**含引号的正则之后**也必须被看见(这次的真坑)', () => {
  // 这一条是整批的核心。旧词法器在这里把正则里的 `'` 当成「字符串开始」,
  // 从此**整份文件往后都被当成字符串内容**, canary 那行被整段吞掉 ——
  // 于是真正的 `.number` 消费它一个字都没看见, P13 静悄悄放过。
  //
  // ⚠️ 必须钉住「报的是哪个文件」, 只断言「报红了」是不够的。
  //   实测: 旧守卫**也报红了** —— 但报的是 `yao_layer_boundary.js:1190`
  //   那个**假阳性**(`typeof x !== 'number'` 里的字符串字面量),
  //   真正的 canary 文件它一个字没提。
  //   也就是说旧守卫一边喊错的地方、一边漏掉真的地方, 而台账上看着「有红有绿」,
  //   像是有人在管。这比完全不报还坏。
  const P3 = withMutatedModules((mods) => {
    fs.writeFileSync(path.join(mods, CANARY_FILE),
      "'use strict';\n"
      + "const _pos = require('../64i/bagua_annotations/bagua_positions.js');\n"
      // 含引号的正则 —— 旧词法器从这一行开始错位
      + "function scrub(s) { return s.replace(/'(?:\\\\.|[^'\\\\])*'/g, \"''\"); }\n"
      // 真正的消费者, 落在错位区**之后**
      + "module.exports.read = function () { return _pos.XIAN_TIAN_BAGUA.qian.number; };\n"
      + "module.exports.scrub = scrub;\n");
  });
  const r = P3.assertProvenance();
  assert.ok(p13HitsOnCanary(r.problems).length,
    '正则之后的真消费没被发现 ⇒ 这正是旧词法器的盲区。\n它报的是:\n'
    + r.problems.join('\n'));
});
