'use strict';

// 2026-10-19 老板: 「1991被吃了？」
//
// 现场 (会话 18689788, 浏览器实拍): 用户原话
//   「1991、11、23 20时05分 女 江苏盐城，做八字排盘」
// 界面上那两行用户气泡显示成「11. 23 20时05分 …」—— 开头的「1991、」没了。
//
// 先排除「是输入丢了」这个更吓人的可能: 后端 session API 逐字返回
//   1991、11、23 20时05分 女 江苏盐城，做八字排盘   (jq 核过, 存盘完整)
// 而且盘古的答复里「公历 1991年11月23日」也算对了 —— 说明**它收到的就是对的**。
// 所以被改的是**渲染**: 用户自己打的字, 显示回来时少了一截。
//
// 根因 (实测正则, 不是推测):
//   Markdown.jsx 的有序列表分支 /^\s*\d+[.、)]\s*/
//   「1991、11、23 …」开头是 `1991` + `、` → 判定为列表编号 → 整段被 replace 掉。
//
// 这里还有第二个同源受害者, 同一行正则干的:
//   「3.14 是圆周率」→ `\d+`吃「3」`[.]`吃「.」`\s*`允许零空白 → 变成「14 是圆周率」。
//   小数点、日期、省略号后面, 只要在行首, 都会被当编号吃掉开头。
//
// 定修法的账 (实数 ~/.pangu/memory):
//   ASCII 序号 (1. / 2))            2967 条
//   中文序号 (1、内容)                  52 条
// 改严的代价 = 52 条列表退化成普通段落(一个字都不少, 只是不排版);
// 不改的代价 = 用户输入被**静默删除**, 而且是主人亲手打的那句话。
// 这个不对等, 所以往严了改。
//
// 全部静态/纯函数断言, **不发任何真实请求**。
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

let ml = null;
before(async () => {
  // 2026-10-26 第 107 批: 判据从 apps/desktop/src/lib/markdown-list.js 搬进 core
  //   —— **规则比界面活得久**。盘古对外回的本来就是 markdown 文本,
  //   任何客户端渲染它都要这条判据; 规则住在界面目录里 = 「谁做界面谁负责别吃用户的字」,
  //   而吃字是**静默**的, 没人会想到去界面目录里找判据。
  ml = require(path.join(__dirname, '..', 'modules', 'markdown_list.js'));
});

// ---- 行为测试: 判据本体 ------------------------------------------------
test('M1 用户原话一个字都不许少', () => {
  const line = '1991、11、23 20时05分 女 江苏盐城，做八字排盘';
  assert.ok(!ml.isOrderedItem(line),
    '「1991、」被当成了列表编号 —— 用户自己打的字在显示时少了一截');
  assert.strictEqual(ml.stripOrderedMarker(line), line,
    '非列表行必须原样返回, 一个字符都不许动');
});

test('M2 同类句子一律不许吃头 (年份 / 小数 / 编号连写)', () => {
  const mustKeep = [
    '1985、3、7 早上六点 男 北京，做八字',
    '2024、2025 两年对比',
    '11、23 生的，属兔',
    // 这一条专打「CJK 位数封顶」那条约束: 顿号后不是数字时, 守卫 (?!\d) 放行,
    // 全靠「1991 是四位、列表序号不会四位」挡住。第一版测试没列它,
    // 于是把 \d{1,2} 改回 \d+ 测试照样全绿 —— 反向锁当场抓出来的漏网。
    '1991、十月十八 星期六',
    '1985、丙寅年生',
    '3.14 是圆周率',
    '1.5 寸屏幕',
    '2.0 版本发布说明',
  ];
  for (const line of mustKeep) {
    assert.ok(!ml.isOrderedItem(line), `不该当列表: ${line}`);
    assert.strictEqual(ml.stripOrderedMarker(line), line, `不该被改写: ${line}`);
  }
});

test('M3 真的有序列表还得认出来 —— 改严不能把列表也一起废掉', () => {
  const real = [
    ['1. 第一项', '第一项'],
    ['2) 第二项', '第二项'],
    ['3、 第三项', '第三项'],
    ['1、第四项', '第四项'],
    ['10. 第十项', '第十项'],
  ];
  for (const [line, expect] of real) {
    assert.ok(ml.isOrderedItem(line), `真列表没认出来: ${line}`);
    assert.strictEqual(ml.stripOrderedMarker(line), expect, `剥编号剥错了: ${line}`);
  }
});

test('M4 行首缩进的有序列表同样要认 (盘古输出常带两格缩进)', () => {
  assert.ok(ml.isOrderedItem('  1. 缩进的项'));
  assert.strictEqual(ml.stripOrderedMarker('  1. 缩进的项'), '缩进的项');
});

// ---- 接线测试: 判据必须**只有一份**, 且旧正则不许复活 --------------------
// ⚠ 2026-10-26 第 107 批: 原来这两条断言的是 `apps/desktop/src/components/Markdown.jsx`
//   「必须从 lib/markdown-list 引入」+「三处判据同源」。
//   桌面端下线后那个文件不存在了 ⇒ 这两条会**变成 vacuous truth**(文件读不到就直接抛,
//   或者更糟: 被写成「文件不存在就跳过」而**静默失去作用**)。
//   正解不是删掉, 是把它的**覆盖面变大**: 现在扫**整个 core**,
//   要求「有序列表判据只有 modules/markdown_list.js 一个来源」。
const CORE = path.join(__dirname, '..');

function _stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
}

function _walkJs(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) _walkJs(f, out);
    else if (e.name.endsWith('.js')) out.push(f);
  }
  return out;
}

test('M5 旧正则不许复活 (它就是吃「1991、」的那只手)', () => {
  const RULE_FILE = path.join(CORE, 'modules', 'markdown_list.js');
  const files = _walkJs(path.join(CORE, 'modules'), [])
    .concat(_walkJs(path.join(CORE, '64i'), []))
    .concat(_walkJs(path.join(CORE, 'pangu-single'), []));
  const offenders = [];
  for (const f of files) {
    if (f === RULE_FILE) continue;
    const src = _stripComments(fs.readFileSync(f, 'utf8'));
    // 老判据的**确切形状**: 行首 + 数字 + [.)、] + 空白。
    //   ⚠ 不能只查 `\d+[` —— 那太泛: core 里有三处 `\d+[.)、]` 是**识别** markdown
    //   编号列表用的(生成提示词时剥标题编号), 跟「吃用户的话」是两回事, 不能一起禁。
    //   旧判据在源码里长这样: \d+[.、)]  (点、顿号、右括号 —— 这个顺序是它的指纹)
    if (src.includes('\\d+[.、)]') || src.includes('^\\s*\\d+[.、)]')) {
      offenders.push(f);
    }
  }
  assert.equal(offenders.length, 0,
    '旧的有序列表正则复活了: ' + offenders.join(', ') + ' —— 它会把「1991、」当列表编号吃掉');
});

test('M6 有序列表判据必须**只有一份** (不许在别处另写)', () => {
  const RULE_FILE = path.join(CORE, 'modules', 'markdown_list.js');
  const files = _walkJs(path.join(CORE, 'modules'), [])
    .concat(_walkJs(path.join(CORE, '64i'), []))
    .concat(_walkJs(path.join(CORE, 'pangu-single'), []));
  const offenders = [];
  for (const f of files) {
    if (f === RULE_FILE) continue;
    const src = _stripComments(fs.readFileSync(f, 'utf8'));
    // 另写一份判据的痕迹: 自己定义同名函数, 或自己写 ORDERED_ASCII/ORDERED_CJK
    if (/function\s+isOrderedItem\s*\(/.test(src)
      || /function\s+stripOrderedMarker\s*\(/.test(src)
      || /ORDERED_ASCII\s*=/.test(src)
      || /ORDERED_CJK\s*=/.test(src)) {
      offenders.push(f);
    }
  }
  assert.equal(offenders.length, 0,
    '有序列表判据在别处还有一份: ' + offenders.join(', ')
    + ' —— 铁律「一份东西抄两遍 = 迟早只改其中一份」');
  assert.ok(fs.existsSync(RULE_FILE), '判据本体 modules/markdown_list.js 不存在');
});
