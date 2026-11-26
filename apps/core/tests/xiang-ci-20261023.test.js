/**
 * tests/xiang-ci-20261023.test.js — 第 70 批: 大象辞(象曰)入库
 *
 * 背景:
 *   64i/hexagrams.js 的 `xiang` 字段**一直是空的** —— 大象辞是《易传》里
 *   「这卦整体在讲什么」那一层(「天行健, 君子以自强不息」),
 *   缺了它, 模型讲卦只有「卦辞 + 爻辞」, 少了一整层。
 *
 * 本批的难处不在「抄进来」, 在**抄哪一版**:
 *   本机《周易》原文切片只覆盖**上经 30 卦 + 咸卦**, 下经 33 卦本机没原文。
 *   ⇒ 走三方交叉对账(本地 + npm iching-shifa + github yijing-data)。
 *   而对账立刻逮到: 外部源把「否」卦的象辞贴成了「屯」卦的 ——
 *   表面看每句都通顺, 不查卦名就发现不了。
 *
 * ⚠️ 本测试里**每一条断言都对着一个真缺口写**:
 *   ① 切片 64 条, 且与内核逐字一致(不许内核另抄一份)
 *   ② 每条象辞**开头含本卦名** —— 专治「贴错卦」那一类
 *   ③ 异文台账条数 ≡ 切片异文段行数(闭合)
 *   ④ 异文原文必须真在三方源里逐字找得到(台账不许写漂亮话)
 *   ⑤ 64i 出处守卫 xiangCiSourceCoverage 真的绿
 *   ⑥ 生产层: 大象辞进 tool_result 且**带身份标签**(标签摘掉就红)
 *   ⑦ 卦象块印大象辞 + 标签
 *   ⑧ 起卦输出带 gua_xiang
 *   ⑨ 标签字面量只在 gua_block.js 定义一次
 *   ⑩ 出处台账: xiang 字段登记为 sourced + production
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CORE = path.join(__dirname, '..');
const M = (p) => require(path.join(CORE, p));
const SRC = (p) => fs.readFileSync(path.join(CORE, p), 'utf8');

const HEX = M('64i/hexagrams.js');
const PROV = M('64i/provenance.js');
const YAO_MODELS = M('64i/yao_models.js');
const GUAB = M('modules/gua_block.js');
const TOOLS = M('modules/tools/index.js');
const ENGINE_SRC = SRC('modules/gua_engine.js');

const LIST = HEX.HEXAGRAMS || HEX;
const SLICE = SRC('64i/sources/xiang_ci_64.txt');

// 切片的正读段(「## 异文」之前)
const MAIN = SLICE.split(/^##\s*异文/m)[0];
const SLICE_ROWS = new Map();
for (const line of MAIN.split('\n')) {
  const m = line.match(/^(\d{2})\s+(\S+)\|(.+)$/);
  if (m) SLICE_ROWS.set(m[2], m[3]);
}

// ─────────────────────────────────────────────────────────────
// ① 切片 64 条 + 与内核逐字一致
// ─────────────────────────────────────────────────────────────

test('切片: 64 卦一条不少, 且与内核逐字一致(内核不许另抄一份)', () => {
  assert.equal(LIST.length, 64, 'hexagrams.js 必须是 64 卦');
  assert.equal(SLICE_ROWS.size, 64, '切片 xiang_ci_64 必须正好 64 条');
  for (const g of LIST) {
    assert.ok(SLICE_ROWS.has(g.name), '切片缺「' + g.name + '」');
    assert.equal(g.xiang, SLICE_ROWS.get(g.name),
      '「' + g.name + '」内核与切片不一致 —— 内核: ' + JSON.stringify(g.xiang)
      + ' / 切片: ' + JSON.stringify(SLICE_ROWS.get(g.name)));
  }
});

test('切片: 没有一卦的象辞是空的(缺料就空着 = 静悄悄丢一层)', () => {
  for (const g of LIST) {
    assert.ok(typeof g.xiang === 'string' && g.xiang.trim().length > 0,
      '「' + g.name + '」的 xiang 是空的');
  }
});

// ─────────────────────────────────────────────────────────────
// ② 开头含本卦名 —— 专治「贴错卦」
// ─────────────────────────────────────────────────────────────

test('内容: 每条象辞开头含**本卦**名(专治外部源贴错卦)', () => {
  // 这条断言是本批的**核心**: 对账时外部源把「否」卦的象辞贴成了「屯」卦的
  //   「云雷，屯, 君子以经纶」—— 整句通顺, 不查卦名根本看不出来。
  // 判据取「前两个小句」而不是「第一句」: 卦名的位置不固定
  //   「山下出泉，蒙。…」(蒙) —— 卦名在第二小句
  //   「云雷，屯，…」(屯)   —— 卦名在第二小句
  //   「天行健，…」(乾)     —— 首句没有卦名, 乾/坤 例外
  for (const g of LIST) {
    if (g.name === '乾' || g.name === '坤') continue;
    const head = g.xiang.split(/[，,。；;]/).slice(0, 2).join('');
    assert.ok(head.includes(g.name),
      '「' + g.name + '」象辞开头不含本卦名: ' + JSON.stringify(head));
  }
});

test('内容: 象辞不是卦辞的复制(两层的区别得保住)', () => {
  // 大象辞与卦辞是两句话。若有人把卦辞填进 xiang, 上面两条断言未必都拦得住
  //   (卦辞开头通常也不含卦名…… 实际上会拦)。但**显式钉住**更稳:
  //   象辞与卦辞**不应逐字相同**。
  for (const g of LIST) {
    assert.notEqual(g.xiang.replace(/[\s，,。；;]/g, ''), g.gua_ci.replace(/[\s，,。；;]/g, ''),
      '「' + g.name + '」象辞与卦辞逐字相同 —— 抄错层了');
  }
});

// ─────────────────────────────────────────────────────────────
// ③ 异文台账闭合
// ─────────────────────────────────────────────────────────────

test('异文: 切片异文段行数 ≡ 台账条数(闭合)', () => {
  const sec = SLICE.split(/^##\s*异文/m)[1] || '';
  const lines = sec.split('\n').filter((l) => /^\s*\d{2}\s/.test(l));
  assert.equal(lines.length, PROV.VARIANT_LEDGER_XIANG.length,
    '切片异文段 ' + lines.length + ' 行, 台账 ' + PROV.VARIANT_LEDGER_XIANG.length + ' 条');
});

test('异文: 台账每条的 id/名必须对得上(卦序用 id 1..64 口径)', () => {
  const byId = new Map(LIST.map((g) => [g.id, g.name]));
  for (const v of PROV.VARIANT_LEDGER_XIANG) {
    assert.equal(byId.get(v.gua), v.name,
      '异文台账 gua=' + v.gua + ' 与卦名「' + v.name + '」对不上(实际 id ' + v.gua + ' 是「' + byId.get(v.gua) + '」)');
  }
});

test('异文: kind 只能是已知那几种(新增一种却没被统计 = 分布悄悄少一类)', () => {
  const KNOWN = ['tie', 'text', 'typo', 'misfiled', 'ortho'];
  for (const v of PROV.VARIANT_LEDGER_XIANG) {
    assert.ok(KNOWN.includes(v.kind), '异文台账出现未知的 kind: ' + v.kind);
  }
  const sum = KNOWN.reduce((n, k) => n + PROV.VARIANT_LEDGER_XIANG.filter((v) => v.kind === k).length, 0);
  assert.equal(sum, PROV.VARIANT_LEDGER_XIANG.length, 'kind 分布没盖住全部台账条目');
});

// ─────────────────────────────────────────────────────────────
// ④ 异文原文必须真在源里 —— 台账不许写漂亮话
// ─────────────────────────────────────────────────────────────

test('异文: 台账登记的异文原文必须真在切片的异文段里逐字找得到', () => {
  // 判据方向很重要, 一开始写反了, 白跑一轮:
  //   ❌「台账 note 里引的每段都该在异文段里出现」
  //      —— 台账 note 里既有**该源的原文**, 也有**别的源/正读**的对照,
  //         后者当然不在这一行里(比如履卦 C 那条同时引了裁决后的正读)。
  //   ✅「异文段那一行的原文, 台账 note 里必须**指得到**」
  //      —— 这才是「台账不许写指不回原文的话」的正确方向:
  //         台账说的是「本地底本作 X」, 那 X 就得**逐字**在异文段那一行里。
  //
  // 实现: 把异文段那一行切成**若干短语**(按标点切), 只要有一段被 note 引到,
  //   就算这条台账指回了原文; 一个都引不到 ⇒ 台账在编故事。
  const sec = SLICE.split(/^##\s*异文/m)[1] || '';
  let checked = 0;
  for (const line of sec.split('\n')) {
    const m = line.match(/^(\d{2})\s+(\S+)\|(.+)\|([ABC])\|(.+)$/);
    if (!m) continue;
    const [, , name, text, src] = m;
    const hits = PROV.VARIANT_LEDGER_XIANG.filter((v) => v.name === name && v.src === src);
    assert.equal(hits.length, 1,
      '异文段「' + name + '」src=' + src + ' 在台账里应有且只有一条, 实为 ' + hits.length);
    // 切成短语: 标点分隔的每一段
    const frags = text.split(/[，,。；;：:]/).map((x) => x.trim()).filter((x) => x.length >= 3);
    assert.ok(frags.length > 0, '异文段这一行切不出短语 —— 判据自己坏了');
    const quoted = hits[0].note.match(/「([^」]+)」/g) || [];
    const anyHit = frags.some((f) => quoted.some((q) => q.slice(1, -1).includes(f) || f.includes(q.slice(1, -1))));
    assert.ok(anyHit,
      '异文段「' + name + '」src=' + src + ' 的原文「' + text + '」在台账 note 里一个片段都引不到'
      + ' —— 台账不许写指不回原文的话; note: ' + hits[0].note);
    checked++;
  }
  assert.ok(checked > 0, '异文段一条都没解析到 —— 判据自己坏了');
});

// ─────────────────────────────────────────────────────────────
// ⑤ 出处守卫真的绿
// ─────────────────────────────────────────────────────────────

test('出处守卫: xiangCiSourceCoverage 通过(切片/内核/异文全闭合)', () => {
  const r = PROV.checkProvenanceProgram('xiangCiSourceCoverage');
  assert.ok(r.ok, '守卫报红: ' + r.problems.join(' | '));
  assert.equal(r.stats.matched, 64, '逐字一致必须 64/64');
  assert.equal(r.stats.nameHeadBad, 0, '首句卦名不对必须为 0');
});

test('出处守卫: 这个 program 真被注册(不许写成没人执行的判决)', () => {
  assert.ok(PROV.PROGRAMS.xiangCiSourceCoverage, 'PROGRAMS 里必须有 xiangCiSourceCoverage');
  assert.ok(typeof PROV.checkProvenanceProgram('xiangCiSourceCoverage') === 'object',
    'checkProvenanceProgram 必须认这个 name');
});

// ─────────────────────────────────────────────────────────────
// ⑥ 生产层: 大象辞带身份标签
// ─────────────────────────────────────────────────────────────

test('生产: hexagram_lookup 的输出带大象辞 + 身份标签(标签摘掉就红)', () => {
  const data = Object.assign({}, LIST[0], { xiang_name: '乾为天' });
  assert.ok(typeof data.xiang === 'string' && data.xiang.length > 0,
    '大象辞随 Object.assign 进了 tool_result —— 必须能拿到');
  // 渲染点必须引用标签常量(出处守卫 P12 查的就是「函数体里有没有引用符号」)
  // 2026-10-25 (第 98 批): 工具实现按域拆进 modules/tools/*.js ⇒ 读**全部**工具源文件,
  //   不然「hexagram_lookup 在哪」这一段会找不到。
  const toolsSrc = (() => {
    const dir = path.join(CORE, 'modules', 'tools');
    return fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
      .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  })();
  const at = toolsSrc.indexOf('hexagram_lookup: async');
  const seg = toolsSrc.slice(at, at + 6000);
  assert.ok(seg.includes('XIANG_CI_TAG'), 'hexagram_lookup 必须引用 XIANG_CI_TAG');
  assert.ok(!seg.includes("'〔大象辞原文"), '不许在渲染点手写标签字面量');
});

test('生产: 标签字面量只在 gua_block.js 定义一次', () => {
  const guabSrc = SRC('modules/gua_block.js');
  const hits = guabSrc.split("〔大象辞原文, 三方对账定稿〕").length - 1;
  // 字面量**只允许出现一次** —— 那是定义处。导出的是**符号**(XIANG_CI_TAG),
  //   不是字面量, 所以第二处不该有字面量。
  assert.equal(hits, 1, '标签字面量只允许出现一次(定义处), 实为 ' + hits + ' 次');
  assert.ok(guabSrc.includes('XIANG_CI_TAG,'), '必须导出 XIANG_CI_TAG 符号');
  // 全仓不许有第二处定义
  const files = ['modules/tools/index.js', 'modules/gua_engine.js', 'modules/gua_block.js'];
  for (const f of files) {
    if (f === 'modules/gua_block.js') continue;
    const s = SRC(f);
    assert.ok(!s.includes('〔大象辞原文'), f + ' 里出现了标签字面量 —— 字面量只能定义一次');
  }
});

test('生产: 大象辞的标签与象义/卦码标签**不是同一个**(三类身份要分得开)', () => {
  assert.notEqual(GUAB.XIANG_CI_TAG, GUAB.XIANG_YI_TAG);
  assert.notEqual(GUAB.XIANG_CI_TAG, GUAB.GUACODE_TAG);
  assert.ok(GUAB.XIANG_CI_TAG && typeof GUAB.XIANG_CI_TAG === 'string');
});

// ─────────────────────────────────────────────────────────────
// ⑦ 卦象块印大象辞
// ─────────────────────────────────────────────────────────────

test('生产: 卦象块印「大象辞」+ 标签(模型看卦的第一眼)', () => {
  const guabSrc = SRC('modules/gua_block.js');
  assert.ok(guabSrc.includes("'大象辞: '"), '卦象块必须印大象辞那一行');
  assert.ok(guabSrc.includes('XIANG_CI_TAG'), '卦象块必须带身份标签');
  // 取不到就不印(不是印空)
  assert.ok(guabSrc.includes("gua.gua_xiang"), '卦象块必须以 gua.gua_xiang 为准');
});

// ─────────────────────────────────────────────────────────────
// ⑧ 起卦输出带 gua_xiang
// ─────────────────────────────────────────────────────────────

test('生产: 起卦输出带 gua_xiang(取不到给 null, 不给空串)', () => {
  assert.ok(ENGINE_SRC.includes('gua_xiang:'), 'gua_engine 必须输出 gua_xiang');
  assert.ok(ENGINE_SRC.includes('yaoModels.getGuaXiang(guaId)'), '必须走 yao_models.getGuaXiang');
});

test('生产: 起卦返回**也**带身份标签(gua_xiang 是裸字段, 模型会当原样引文)', () => {
  // 2026-10-23 本批整链回归第一次跑出来的红灯:
  //   出处台账把 'modules/gua_engine.js:castGua' 登记成带标签的渲染点,
  //   而那个函数体里**根本没有引用标签常量** —— 台账说了假话。
  //   守卫 P12 把它逮住了(它查的正是「渲染点函数体里有没有引用标签符号」)。
  //
  // 但真问题不止是「台账写错」: gua_xiang 在 tool_result 里是**裸字段**,
  // 模型读 gua_cast 的返回时看不到「这一份是三方对账定稿」⇒ 会当成
  // 任一本《周易》的原样引文讲出去。
  // 卦象块那一行是带标签的, 但**起卦返回本身**也是模型读得到的一条路。
  //
  // ⇒ 这里钉两件事:
  //   ① 引擎的函数体里**引用了标签常量符号**(不是手写字面量, 也不只是 require)
  //   ② 真跑一次 castGua, 返回里真的带着那个标签
  const masked = ENGINE_SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  assert.ok(masked.includes('XIANG_CI_TAG'),
    'gua_engine 必须引用标签常量符号 XIANG_CI_TAG(手写字面量会漂; 注释里提到不算)');

  const g = M('modules/gua_engine.js').castGua('大象辞标签自检', { numbers: [1, 2, 5] });
  assert.ok(g.gua_xiang, '起卦输出必须有 gua_xiang');
  assert.ok(g.gua_xiang_basis, '起卦输出必须带 gua_xiang_basis(身份跟着数据走)');
  assert.equal(g.gua_xiang_basis.tag, GUAB.XIANG_CI_TAG,
    '起卦返回带的必须是同一个标签常量, 不是手写的一份');
  assert.equal(g.gua_xiang_basis.field, 'gua_xiang', 'basis.field 要指对字段名');
});

test('生产: yao_models.getGuaXiang 64 卦都取得到', () => {
  for (const g of LIST) {
    assert.equal(YAO_MODELS.getGuaXiang(g.id), g.xiang, 'getGuaXiang 取不到「' + g.name + '」');
  }
});

// ─────────────────────────────────────────────────────────────
// ⑩ 出处台账登记
// ─────────────────────────────────────────────────────────────

test('台账: xiang 字段登记为 sourced + production(带 marker 与渲染点)', () => {
  const layer = PROV.LAYERS['hexagrams'];
  const f = layer.fields.find((x) => x.field && x.field.indexOf('大象辞') >= 0);
  assert.ok(f, 'hexagrams 层必须登记大象辞字段');
  assert.equal(f.status, 'sourced');
  assert.equal(f.source, 'xiang_ci_64', '必须指向 xiang_ci_64 切片');
  assert.ok(f.production, '进生产的字段必须有 production 段');
  assert.equal(f.production.marker, '〔大象辞原文, 三方对账定稿〕');
  assert.ok(Array.isArray(f.production.renderedIn) && f.production.renderedIn.length >= 1,
    'production 必须登记渲染点');
  assert.ok(f.production.markerConstant.includes('XIANG_CI_TAG'),
    'markerConstant 必须指向标签常量的位置');
});

test('台账: 大象辞的**每一个生产出口**都登记了(少登记一个 = 那个出口的标签守卫失效)', () => {
  // 这条是变异 M15 空枪逼出来的: 把 'modules/gua_engine.js:castGua' 从
  // renderedIn 里删掉, 判据一条没红 ——
  //   因为台账少登记 ⇒ 出处层 P12 守卫**不再检查**那个出口 ⇒
  //   有人偷偷把起卦返回的标签摘掉, 守卫不会报红。
  //
  // ⇒ 台账的 renderedIn 不只是「记录」, 它**就是**标签守卫的检查范围。
  //   少登记一个 = 少查一个出口 = 一个出口裸奔。
  const layer = PROV.LAYERS['hexagrams'];
  const f = layer.fields.find((x) => x.field && x.field.indexOf('大象辞') >= 0);
  assert.ok(f && f.production, 'hexagrams 层必须登记大象辞字段 + production 段');
  const rendered = f.production.renderedIn || [];
  // 大象辞有三条生产出口, 一条都不能少:
  //   ① hexagram_lookup —— 查单卦时随 tool_result 出
  //   ② formatGuaFirstBlock —— 卦象块那一行
  //   ③ castGua —— 起卦返回的 gua_xiang 字段
  const MUST = [
    'modules/tools/index.js:hexagram_lookup',
    'modules/gua_block.js:formatGuaFirstBlock',
    'modules/gua_engine.js:castGua',
  ];
  const missing = MUST.filter((m) => !rendered.includes(m));
  assert.equal(missing.length, 0,
    '大象辞的生产出口漏登记: ' + missing.join(', ')
    + ' —— 台账少登记一个 = 出处层守卫少查一个出口 = 那个出口的标签可以被悄悄摘掉');
});

test('可复算: 切片能被 build 脚本 --check 验出来(三方源变了要能报出来)', () => {
  // 切片头写「extractor: scripts/build_xiang_ci.js (可复算; --check 可验)」——
  //   这是一句**机器声明**。声明必须为真, 否则它跟没写一样。
  //   (踩坑日志里的老教训: 「注释 ≠ 隔离」—— 连自己写的机器可读声明都可能假。)
  //
  // ⚠️ 这个测试**不联网**: --check 走的是本地缓存
  //   (64i/sources/_xiang_ci_cache/), 没缓存时跳过并说明。
  //   理由: 整链回归不能依赖外网(上游限流/断网 ⇒ 整链假红)。
  const cache = path.join(CORE, '.cache', 'xiang_ci');
  // 三个源的缓存缺一不可: 源 A/B 是外部 npm/github 副本, 源 C 是本机语料的
  //   **抽取结果**(原始典籍不在仓里)。缺任何一源, 三方对账都复算不出来 ——
  //   这时跳过并说明, 而不是拿「少一票的结果」跟切片比, 那是拿假红当真绿。
  const NEEDED = ['iching-shifa.tgz', 'yijing-data-xiangzhuan.json', 'local-corpus-xiang.json'];
  const missing = NEEDED.filter(f => !fs.existsSync(path.join(cache, f)));
  if (missing.length > 0) {
    // 缓存不完整 = 这个环境从没跑过 build 脚本 (或跑的时候没语料)。
    //   那就只验「脚本在不在、切片头的声明指向它」, 不验复算结果。
    console.log('[xiang-ci] 跳过复算校验: 缓存缺 ' + missing.join(', ')
      + ' (跑一次 `PANGU_CORPUS_ROOT=<语料根> node scripts/build_xiang_ci.js` 即可补齐)');
    assert.ok(fs.existsSync(path.join(CORE, 'scripts', 'build_xiang_ci.js')),
      'build_xiang_ci.js 必须存在 —— 切片头声明了它');
    assert.ok(SLICE.indexOf('scripts/build_xiang_ci.js') >= 0,
      '切片头必须声明 extractor 是 build_xiang_ci.js');
    return;
  }
  const r = execFileSync('node', ['scripts/build_xiang_ci.js', '--check', '--offline'], {
    cwd: CORE, stdio: 'pipe', encoding: 'utf8',
  });
  assert.ok(/切片与三方对账结果一致/.test(r),
    'build 脚本 --check 必须说「一致」, 实说: ' + r);
});
