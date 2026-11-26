'use strict';
// 六十四卦详情页的爻题渲染守卫 (2026-10-22 第 48 批)
//
// 老板 10-22 原话: 「http://127.0.0.1:18901/#/hexagrams 这不就是爻词?
//                   但是我感觉64卦卦序有点问题」
//
// 查下来的结论: **64i 数据层是对的**(文王卦序 1..64 逐条核过、Unicode 卦符
// U+4DC0+id-1 零错位、384 爻的 binary/爻题零不符), 错的是**网页呈现层**,
// 而且错得比想象的厉害 —— 三处, 覆盖 384/384 条爻:
//
//   ① 爻位阴阳判错: 旧代码扫**整条爻辞正文**找「九」字判阴阳
//        {yc.includes('九') ? '九' : '六'}
//      震卦六二「震来厉, 亿丧贝, **跻于九陵**, 勿逐七日得」——
//      正文里有个「九」, 六二爻就被标成「九」。(1/384 处)
//
//   ② 爻题排列规则错: 旧代码按 `位置 + (九|六)` 拼 ⇒ 二爻拼成「二九」
//      但通行爻题是**二至五爻阴阳在前**(九二/六二/…/六五),
//      只有**初爻与上爻**位置在前(初九/初六/上九/上六)。(256/384 处)
//
//   ③ 爻题前缀剥不掉: 旧正则 `^[初九|初六|…][：:]` 里字符类的 `|` 是
//      **字面竖线**不是「或」, 且要求前缀后紧跟冒号;
//      实际数据是「初九：潜龙勿用」两字前缀 ⇒ 一条也剥不掉,
//      详情页显示成「二九九二：见龙在田」。(384/384 处)
//
// 本文件锁死修好的状态: 爻题从**数据**里读(标签与正文永远一致),
// 并把「旧算法错在哪」写成断言 —— 免得有人把老写法搬回来。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const { HEXAGRAMS } = require(path.join(CORE, '64i', 'hexagrams.js'));

// 爻题规则住在 core 的六爻层 (2026-10-26 第 107 批: 桌面端下线 ⇒ 规则从
// apps/desktop/src/lib/yao.js 搬进 64i —— 它是**术数规则**, 不是界面样式)。
const YAO = require(path.join(CORE, '64i', 'yao_title.js'));

const POS = ['初', '二', '三', '四', '五', '上'];

// ============================================================
// 正例
// ============================================================

test('正例: 384 条爻的爻题与 64i 数据逐条一致, 零不符', () => {
  let n = 0;
  for (const g of HEXAGRAMS) {
    for (let i = 0; i < 6; i++) {
      const raw = g.yao_ci[i];
      n++;
      const { label, body } = YAO.yaoEntry(raw, g.binary, i);
      // 标签 = 数据里自带的爻题
      const m = /^(初[九六]|[九六][二三四五]|上[九六])/.exec(raw);
      assert.ok(m, '第 ' + g.id + ' 卦第 ' + i + ' 爻没有爻题: ' + raw);
      assert.equal(label, m[1],
        '第 ' + g.id + ' 卦第 ' + i + ' 爻的爻题对不上: ' + label + ' ≠ ' + m[1]);
      // 正文 = 爻辞原文去掉爻题和冒号
      assert.equal(body, raw.slice(m[1].length + 1),
        '第 ' + g.id + ' 卦第 ' + i + ' 爻的正文切错了: ' + body);
      assert.ok(body.length > 0, '爻辞正文被剥空了');
    }
  }
  assert.equal(n, 384, '应走满 384 爻');
});

test('正例: 爻题遵守通行排法 —— 初/上位置在前, 二~五阴阳在前', () => {
  for (const g of HEXAGRAMS) {
    for (let i = 0; i < 6; i++) {
      const { label } = YAO.yaoEntry(g.yao_ci[i], g.binary, i);
      const pos = POS[i];
      const yy = label.includes('九') ? '九' : '六';
      const expect = (i === 0 || i === 5) ? pos + yy : yy + pos;
      assert.equal(label, expect,
        '第 ' + g.id + ' 卦第 ' + i + ' 爻的爻题排法不对: ' + label + ' ≠ ' + expect);
    }
  }
});

test('正例: 爻题阴阳与 binary 逐条一致(binary 第 i 位 = 第 i 爻)', () => {
  for (const g of HEXAGRAMS) {
    for (let i = 0; i < 6; i++) {
      const { label } = YAO.yaoEntry(g.yao_ci[i], g.binary, i);
      const yang = label.includes('九');
      assert.equal(yang, g.binary[i] === '1',
        '第 ' + g.id + ' 卦第 ' + i + ' 爻: 爻题 ' + label + ' 与卦码 ' + g.binary + ' 对不上');
    }
  }
});

test('★ 正例: 震卦六二不再被标成「九」(旧算法的 1/384 处错)', () => {
  // 震卦六二: 「震来厉, 亿丧贝, 跻于九陵, 勿逐七日得」——
  //   正文里有个「九」, 旧代码扫全文就把它标成了「九」。
  const zhen = HEXAGRAMS.find((g) => g.id === 51);
  const { label, body } = YAO.yaoEntry(zhen.yao_ci[1], zhen.binary, 1);
  assert.equal(label, '六二', '震卦六二必须标成「六二」');
  assert.match(body, /跻于九陵/, '正文里的「九陵」要原样留着');
  assert.doesNotMatch(body, /^六二/, '正文不该再带爻题前缀');
});

test('正例: 详情页不再出现「二九九二」这种前缀重复', () => {
  for (const g of HEXAGRAMS) {
    for (let i = 0; i < 6; i++) {
      const { label, body } = YAO.yaoEntry(g.yao_ci[i], g.binary, i);
      assert.doesNotMatch(body, new RegExp('^' + label),
        '第 ' + g.id + ' 卦第 ' + i + ' 爻正文里还带着爻题');
    }
  }
});

test('正例: 数据没带爻题时按 binary 兜底, 排法照样对', () => {
  const g = HEXAGRAMS.find((x) => x.id === 1);   // 乾 全阳
  const { label, body } = YAO.yaoEntry('潜龙勿用', g.binary, 0);
  assert.equal(label, '初九');
  assert.equal(body, '潜龙勿用');
  const { label: l5 } = YAO.yaoEntry('亢龙有悔', g.binary, 5);
  assert.equal(l5, '上九');
  const kun = HEXAGRAMS.find((x) => x.id === 2);  // 坤 全阴
  assert.equal(YAO.yaoEntry('履霜，坚冰至', kun.binary, 0).label, '初六');
  assert.equal(YAO.yaoEntry('直方大，不习无不利', kun.binary, 1).label, '六二');
});

// ============================================================
// 负例 —— 把老写法搬回来必须被发现
// ============================================================

test('★ 负例: 旧的「扫全文找九」算法确实错(证明这次修的是真 bug)', () => {
  // 这条不是为了测新代码, 是为了**把 bug 钉在案卷上**:
  //   将来谁说「旧写法也没差多少」, 让他看看这一条。
  const POS_OLD = ['初', '二', '三', '四', '五', '上'];
  let wrongYinYang = 0;      // 阴阳那个字就判错了
  let wrongOrder = 0;        // 位置与阴阳的**先后**排反了
  let wrongTotal = 0;
  const yinYangWrong = [];
  for (const g of HEXAGRAMS) {
    for (let i = 0; i < 6; i++) {
      const raw = g.yao_ci[i];
      const oldYy = raw.includes('九') ? '九' : '六';
      const old = POS_OLD[i] + oldYy;
      const now = YAO.yaoEntry(raw, g.binary, i).label;
      const nowYy = now.includes('九') ? '九' : '六';
      if (oldYy !== nowYy) {
        wrongYinYang++;
        yinYangWrong.push(g.id + '/' + i);
      }
      // 排法: 旧代码永远把位置放前面; 二至五爻的通行排法是阴阳在前 ⇒ 那四爻全错。
      if (i >= 1 && i <= 4) {
        wrongOrder++;
      }
      if (old !== now) {
        wrongTotal++;
      }
    }
  }
  // 阴阳判错只有一处 —— 震卦六二「跻于九陵」, 正文里的「九」字把它带偏了
  assert.equal(wrongYinYang, 1, '阴阳判错应恰好 1 处(震卦六二), 实为 ' + wrongYinYang);
  assert.deepStrictEqual(yinYangWrong, ['51/1'],
    '阴阳判错的那一处应是震卦六二(第 51 卦第 1 爻)');
  // 位置/阴阳顺序排反的: 二至五爻每卦 4 条 ⇒ 64×4 = 256
  assert.equal(wrongOrder, 64 * 4,
    '爻题排法错的应是 64 卦 × 二至五爻 = 256 处, 实为 ' + wrongOrder);
  assert.ok(wrongTotal > 0, '旧算法一处都没错? 那这次修复就是假的');
});

test('★ 负例: 视图里不许再出现那两种错写法', () => {
  // ⚠ 2026-10-26 第 107 批: 这条守卫原来只扫 `apps/desktop/src/views/HexagramsView.jsx`
  //   —— 桌面端下线后那个文件不存在了 ⇒ 守卫**静默失去作用**(它自己却还是绿的)。
  //   正解不是删掉它, 是把它的**覆盖面变大**: 现在扫 core 的整个术数层 + 服务层,
  //   并且要求「爻题规则只有 64i/yao_title.js 一个来源」。
  const fs2 = require('fs');
  const path2 = require('path');
  const RULE_FILE = path2.join(CORE, '64i', 'yao_title.js');

  function _walk(dir, out) {
    for (const e of fs2.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const f = path2.join(dir, e.name);
      if (e.isDirectory()) _walk(f, out);
      else if (e.name.endsWith('.js')) out.push(f);
    }
    return out;
  }
  const files = _walk(path2.join(CORE, '64i'), [])
    .concat(_walk(path2.join(CORE, 'modules'), []));

  const offenders = [];
  let ruleCopies = 0;
  for (const f of files) {
    if (f === RULE_FILE) continue;
    // ⚠ 扫源码前必须**剥注释** —— 注释会骗过文本断言(踩坑日志 2026-10-19)。
    //   本次就栽了一次: 我在 yao_positions.js 的注释里**引用**了旧写法
    //   `yaoCi.includes('九')` 来说明「以前是这么错的」, 结果守卫把**说明**当成了**罪证**。
    const src = fs2.readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
    // ① 拿**爻辞正文**判阴阳 —— 精确判据: 对爻辞用 includes 找「九」或「六」。
    //    ⚠ 不能写成泛泛的 `includes('九')`: 正确写法 `title.includes('九')`(判**爻题**)也长这样,
    //    会被误伤 —— 那就变成「守卫自己把对的当错的」(本次真踩了)。
    //    ⚠ 也不能只写 `yaoCi.includes(...)`: 断言爻辞**内容**(如 includes('潜龙勿用'))是合法的,
    //    会被误伤 —— 本次也真踩了(64i/tests/test_hexagram_vector.js)。
    if (/yaoCi\.includes\(\s*['"][九六]['"]\s*\)/.test(src)
      || /yao_ci\[[^\]]*\]\.includes\(\s*['"][九六]['"]\s*\)/.test(src)) {
      offenders.push([f, '拿爻辞正文判阴阳']);
    }
    // ③ 那个剥不掉的正则(字符类里的 | 是字面竖线)
    if (/\[初九\|初六\|/.test(src)) offenders.push([f, '字符类里的「|」当「或」']);
    // ② 位置在前硬拼
    if (/\['初','二','三','四','五','上'\]\[i\]/.test(src)) offenders.push([f, '按「位置 + 九/六」硬拼']);
    // 单一真源: 爻题判据本身不许有第二份
    if (/YAO_TITLE_RE/.test(src)) ruleCopies++;
  }
  assert.equal(offenders.length, 0,
    '爻题规则被另写了一份: ' + offenders.map(([f, why]) => f + ' → ' + why).join('; '));

  // 并且: 规则本体必须在六爻层的那一个文件里
  assert.ok(fs2.existsSync(RULE_FILE), '爻题规则本体 64i/yao_title.js 不存在');
  assert.match(fs2.readFileSync(RULE_FILE, 'utf8'), /YAO_TITLE_RE/,
    '64i/yao_title.js 里没有爻题判据');
  assert.equal(ruleCopies, 0,
    '爻题判据 YAO_TITLE_RE 在别的文件里也有一份 —— 爻题规则必须只有 64i/yao_title.js 一个来源');
});

test('★ 负例: 爻题识别不许把正文里的字误认成爻题', () => {
  // 钉**行为**而不是钉源码字面量 —— 源码文本断言太脆(改个格式就假红),
  // 而且真出问题时行为断言才指得出「哪条爻辞被认错了」。
  //   ① 正文里出现爻题样的字, 不许被当成爻题
  assert.equal(YAO.parseYao('含章可贞').title, null,
    '「含章」不是爻题');
  assert.equal(YAO.parseYao('六三：六三九四之类').title, '六三',
    '只取**开头**的爻题');
  assert.equal(YAO.parseYao('六三：六三九四之类').body, '六三九四之类',
    '正文里的爻题样字要原样留着');
  //   ② 爻题只吃两字, 后面多出来的不能被吞进正文里
  assert.equal(YAO.parseYao('初九九：潜龙勿用').title, '初九');
  assert.equal(YAO.parseYao('初九九：潜龙勿用').body, '九：潜龙勿用');
  //   ③ 没有爻题的老式爻辞(不带冒号)也别切坏
  assert.equal(YAO.parseYao('潜龙勿用').title, null);
  assert.equal(YAO.parseYao('潜龙勿用').body, '潜龙勿用');
  assert.equal(YAO.parseYao('').title, null);
  assert.equal(YAO.parseYao(undefined).body, '');
});

test('★ core 的 yao_positions 阴阳判定必须与爻题一致 (不许再扫爻辞正文找「九」)', () => {
  // 2026-10-26 第 107 批抓到: `64i/bagua_annotations/yao_positions.js` 自己判阴阳,
  // 判据是 `yaoCi.includes('九')` —— 扫**爻辞正文**。
  // 震卦六二「六二：震来厉，亿丧贝，跻于九陵，勿逐七日得」正文里有个「九」,
  // 于是这条**阴爻被判成阳爻**。
  // 同一个 bug 桌面端在 2026-10-22 第 48 批修过它自己那份, **core 这份原封不动** ——
  // 「修了一处, 另一处还在」正是铁律「一份东西抄两遍 = 迟早只改其中一份」说的。
  const yp = require(path.join(CORE, '64i', 'bagua_annotations', 'yao_positions.js'));
  let wrong = 0;
  const samples = [];
  for (const g of HEXAGRAMS) {
    const ps = yp.getYaoPositions(g.id);
    for (let i = 0; i < 6; i++) {
      const m = /^(初[九六]|[九六][二三四五]|上[九六])/.exec(g.yao_ci[i]);
      assert.ok(m, '第 ' + g.id + ' 卦第 ' + i + ' 爻没有爻题: ' + g.yao_ci[i]);
      const truth = m[1].includes('九');
      if (ps[i].isYang !== truth) {
        wrong++;
        if (samples.length < 3) samples.push(g.name + ' 第' + (i + 1) + '爻');
      }
    }
  }
  assert.equal(wrong, 0,
    'yao_positions 的阴阳判定与爻题对不上 ' + wrong + ' 处: ' + samples.join(', ')
    + ' —— 它不许再扫爻辞正文找「九」');

  // 现场那条: 震六二
  const zhen = HEXAGRAMS.find((h) => h.name === '震');
  const p2 = yp.getYaoPosition(zhen.id, 1);
  assert.equal(p2.polarity, '阴', '震卦六二必须判成阴爻 (正文里的「九陵」不算阴阳)');
  assert.equal(p2.isYang, false, '震卦六二 isYang 必须是 false');

  // 动静不许由爻辞文本瞎判 —— 爻辞里没有动静信息
  assert.equal(p2.isMoving, null,
    'isMoving 不许从爻辞文本猜 (爻辞里没有动静信息); 动静由爻值 6/9 决定');
  assert.ok(p2.movingBasis, 'isMoving 为 null 时必须说清为什么 (movingBasis)');
});

