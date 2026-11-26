/**
 * tests/provenance-production-tag-20261022.test.js
 * 第 46 批: 生产层身份标签的覆盖面 (A 类标身份 / B 类钉住)
 *
 * 起因: 第 45 批给「爻位性质」加了身份标签, 顺手发现更大的问题 ——
 *   出处层登记得再对, **模型看不见它**。模型读的是 `modules/*` 拼出来的文本。
 *   当时记了 12 个 interpretive/unsourced 字段「可能是裸的」, 但没查。
 *   本批逐个查到底(查法见 decision.md 第 46 批), 结论分三类:
 *     A 裸的且真进生产 → 标身份(象义 nature/keywords、卦码 binary)
 *     B 裸的但生产零消费者 → 登记「当前不进生产」+ 守卫 P13 钉住
 *     C 进了生产但已有口径文本 → 已有机制够用, 不重复标
 *
 * ⚠️ 本文件防的是**两类空转**:
 *   ① 标签加了但没真进生产文本(贴了个标签常量, 模型看不见的地方)
 *   ② 守卫是**恒真**的(永远绿, 从不咬人) —— 比没守卫更坏
 *      所以每条守负面都配一条「真把它弄坏, 必须报红」的负例。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const gb = require(path.join(CORE, 'modules/gua_block.js'));
const gate = require(path.join(CORE, 'modules/gua_answer_gate.js'));
const P = require(path.join(CORE, '64i/provenance.js'));
const TOOLS = require(path.join(CORE, 'modules/tools/index.js')).TOOLS;

// ⚠️ 渲染断言必须对**字面量**做, 不能只 `includes(gb.XIANG_YI_TAG)` ——
//   标签常量要是被清成 '', `s.includes('')` 恒为真, 断言会**假绿**。
//   (第 45 批真栽过: 把常量清空, 8 条里只有一条变红。)
const EXPECTED_XIANG_TAG = '〔象义整理, 非典籍原文〕';
const EXPECTED_GUACODE_TAG = '〔卦码编次约定, 非典籍原文〕';
const EXPECTED_MEANING_TAG = '〔任务语义对应, 非典籍原文〕';

// ============================================================
// 一、A 类: 象义与卦码的身份标签必须真进生产文本
// ============================================================

test('正例: 象义标签常量非空且是预期字面量(防标签被清空导致假绿)', () => {
  assert.equal(gb.XIANG_YI_TAG, EXPECTED_XIANG_TAG,
    '象义标签变了或被清空 —— 后面所有渲染断言都会跟着假绿');
  assert.equal(gb.GUACODE_TAG, EXPECTED_GUACODE_TAG,
    '卦码标签变了或被清空 —— 后面所有渲染断言都会跟着假绿');
});

test('正例: hexagram_lookup 的单卦分支, 象义与卦码都带身份', async () => {
  const r = await TOOLS.hexagram_lookup({ params: { query: '22' } });
  assert.equal(r.ok, true);
  assert.ok(r.data.nature_basis, '单卦分支没有 nature_basis —— 象义身份没跟着数据走');
  assert.equal(r.data.nature_basis.tag, EXPECTED_XIANG_TAG, '象义标签不对');
  assert.equal(r.data.nature_basis.binary_tag, EXPECTED_GUACODE_TAG, '卦码标签不对');
  // 卦码说明必须点破「两套编号」这个坑(老板 10-22 原话: 64 卦是 0..63 不是 1..64)
  assert.ok(/0\.\.63/.test(r.data.nature_basis.binary_note),
    '卦码说明没提 0..63 索引 —— 模型会把 index 当卦序报出去');
});

test('正例: 列表与模糊匹配分支也带身份(三个分支漏一个就有一条路裸着走)', async () => {
  const l = await TOOLS.hexagram_lookup({ params: { query: 'list' } });
  assert.ok(l.nature_basis, '列表分支漏了 nature_basis');
  assert.equal(l.nature_basis.tag, EXPECTED_XIANG_TAG);
  const f = await TOOLS.hexagram_lookup({ params: { query: '查无此卦' } });
  assert.ok(f.nature_basis, '模糊匹配分支漏了 nature_basis');
  assert.equal(f.nature_basis.tag, EXPECTED_XIANG_TAG);
});

test('正例: 卦义字段本身仍是纯数据(标签不许污染值)', async () => {
  // 既有断言 `r.data.nature === '贲饰'` 依赖这一点。
  // 标签是给模型看的**说明**, 不是数据本身 —— 混进值里会让等值判断失效。
  const r = await TOOLS.hexagram_lookup({ params: { query: '22' } });
  assert.equal(r.data.nature, '贲饰', 'nature 字段被标签污染了 —— 既有断言会撞');
  assert.ok(!String(r.data.nature).includes('〔'), 'nature 字段里混进了标签字面量');
});

test('正例: 事实块里印的卦义带身份标签', () => {
  const fb = gate.buildGuaFactsBlock([{ guaIds: [22], claim: 'x', expect: 'y' }]);
  assert.ok(/卦义 贲饰/.test(fb), '事实块的卦义没渲染出来(既有断言口径)');
  assert.ok(fb.includes(EXPECTED_XIANG_TAG),
    '事实块的卦义没带身份标签 —— 重修稿会照着当经典原文改');
});

test('正例: wuxing_judge 的任务语义对应带身份标签', async () => {
  const r = await TOOLS.wuxing_judge({
    params: {
      subject: '这件事',
      resources: ['余力'], outputs: ['已产出'],
      blockers: ['缺环境'], targets: ['要啃的目标'], peers: [],
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.meaning_tag, EXPECTED_MEANING_TAG,
    'wuxing_judge 漏了任务语义对应的身份标签');
  // 术数名那一侧是 sourced, 不许被一起标掉
  assert.equal(r.data.cells.sheng.shuxing, '生我者', '术数名被改动了');
  assert.ok(r.data.meaning_basis, 'judgeTask 的返回里没有 meaning_basis');
  assert.equal(r.data.meaning_basis.tag, EXPECTED_MEANING_TAG);
});

test('正例: 标签是正面式, 不是禁令式', () => {
  // 本项目立过的规矩: 禁令式措辞等于亲手把那个词喂给模型。
  for (const t of [gb.XIANG_YI_TAG, gb.GUACODE_TAG, EXPECTED_MEANING_TAG]) {
    assert.ok(t.length > 0);
    assert.ok(!/不要|禁止|不许|勿/.test(t),
      '标签里出现了禁令式措辞: ' + t);
  }
});

// ============================================================
// 二、出处层: A 类必须登记 production, B 类必须登记 notInProduction
// ============================================================

test('正例: 象义与卦码在出处层登记了生产渲染点', () => {
  const L = P.LAYERS['hexagrams'];
  const xiang = L.fields.find((f) => String(f.field).indexOf('keywords / nature') >= 0);
  assert.ok(xiang, '出处层没有登记象义字段');
  assert.ok(xiang.production, '象义字段没有登记 production');
  assert.ok(xiang.production.renderedIn && xiang.production.renderedIn.length >= 3,
    '象义的渲染点少于 3 处 —— 实际有: 工具(单卦/列表/模糊) + 事实块 + skill');
  assert.equal(xiang.production.marker, EXPECTED_XIANG_TAG);

  const code = L.fields.find((f) => String(f.field).indexOf('二进制卦码') >= 0);
  assert.ok(code && code.production, '卦码字段没有登记 production');
  assert.equal(code.production.marker, EXPECTED_GUACODE_TAG);
});

test('正例: B 类字段都登记了 notInProduction + watchAttrs + watchScope', () => {
  const b = [];
  for (const key of Object.keys(P.LAYERS)) {
    for (const f of P.LAYERS[key].fields || []) {
      if (f.notInProduction) b.push({ key, f });
    }
  }
  assert.ok(b.length >= 7, 'B 类字段少于 7 个 —— 第 46 批查出来的是 7 个');
  for (const { key, f } of b) {
    assert.ok(f.notInProductionReason && f.notInProductionReason.length > 10,
      key + ' · ' + f.field + ': 必须写清楚为什么现在不进生产');
    assert.ok(Array.isArray(f.watchAttrs) && f.watchAttrs.length,
      key + ' · ' + f.field + ': 必须写 watchAttrs(钉住哪些属性名)');
    assert.ok(Array.isArray(f.watchScope) && f.watchScope.length,
      key + ' · ' + f.field + ': 必须写 watchScope(数据源标识符) —— '
        + '只钉属性名会假红(通用英文词名全仓都是)');
  }
});

test('正例: 任务语义对应在出处层登记为 interpretive(不许混进 sourced)', () => {
  const L = P.LAYERS['bagua_annotations:task_judge'];
  const f = L.fields.find((x) => String(x.field).indexOf('任务语义对应') >= 0);
  assert.ok(f, '出处层没有登记任务语义对应');
  assert.equal(f.status, 'interpretive',
    '任务语义对应(助力/产出/阻力)是老板给的表 + 课程整合, 不该标 sourced');
  assert.ok(f.production, '任务语义对应没登记 production');
  assert.equal(f.production.marker, EXPECTED_MEANING_TAG);
  // 而术数名那一条仍然是 sourced —— 两者必须分开
  const shuxing = L.fields.find((x) => String(x.field).indexOf('经典原文表述') >= 0);
  assert.equal(shuxing.status, 'sourced', '术数名那条必须仍是 sourced');
});

// ============================================================
// 三、守卫 P12 / P13
// ============================================================

test('正例: 出处层在真树上全绿', () => {
  const s = P.provenanceSummary();
  assert.ok(s.ok, '出处层报红:\n' + s.problems.join('\n'));
  const st = P.assertProvenance().stats;
  assert.ok(st.productionMarked >= 4,
    '登记了生产身份标签的字段少于 4 个 (爻位性质/象义/卦码/任务语义对应)');
  assert.ok(st.notInProduction >= 7, 'B 类字段少于 7 个');
  assert.ok(st.notInProductionWatched >= 12, '被钉住的属性名少于 12 个');
});

// 负例用的树复制/变异在 tests/helpers/provenance_mutate.js —— 共用一份。
const { mutateProvenance } = require('./helpers/provenance_mutate');

/**
 * 造一棵「坏树」, 返回它的 provenance 模块。
 * ⚠️ 变异必须**真进 modules/** —— P13 扫的就是 modules/ 下的文件。
 *   而 helper 默认把 modules 做成**软链** ⇒ 改它等于改真树!
 *   所以这里改成**真拷贝**一份 modules 再改。
 */
function mutateWithModules(mutator) {
  const fsx = require('fs');
  const os = require('os');
  const root = fsx.mkdtempSync(path.join(os.tmpdir(), 'pangu-prov46-'));
  const copyTree = require('./helpers/provenance_mutate').copyTree;
  copyTree(path.join(CORE, '64i'), path.join(root, '64i'));
  copyTree(path.join(CORE, 'modules'), path.join(root, 'modules'));
  mutator(root);
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(root)) delete require.cache[k];
  }
  return require(path.join(root, '64i/provenance.js'));
}

test('负例: 生产层把标签换成手写字面量 → P12 必须报红', () => {
  // 这条防的是「光看文件里有没有这个词」那种**恒真**守卫:
  // require 那一行永远在, 哪怕渲染点早改成手写字面量。
  const P2 = mutateProvenance(CORE, 'b46a', (tmp) => {
    const f = path.join(tmp, 'provenance.js');
    const s2 = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, s2.replace(
      "marker: '〔象义整理, 非典籍原文〕',",
      "marker: '〔根本没这个字面量〕',"
    ), 'utf8');
  });
  const r = P2.provenanceSummary();
  assert.ok(!r.ok, '台账记的字面量跟代码对不上还全绿');
  assert.ok(r.problems.some((p) => p.includes('标签字面量') || p.includes('字面量')),
    '没报「字面量对不上」:\n' + r.problems.join('\n'));
});

test('负例: 渲染点去掉标签引用 → P12 必须报红(证明守卫不是恒真)', () => {
  // 把 tools/index.js 里引用 XIANG_YI_TAG 的那行换成手写字面量。
  // 守卫必须发现「函数体里没有引用标签常量符号」。
  const P2 = mutateWithModules((root) => {
    const f = path.join(root, 'modules/tools/index.js');
    const s2 = fs.readFileSync(f, 'utf8');
    const before = s2;
    fs.writeFileSync(f, s2.replace(
      /require\('\.\.\/gua_block'\)\.XIANG_YI_TAG/g,
      "'〔象义整理, 非典籍原文〕'"
    ), 'utf8');
    assert.notEqual(fs.readFileSync(f, 'utf8'), before, '变异没生效');
  });
  const r = P2.provenanceSummary();
  assert.ok(!r.ok, '渲染点不引用标签常量了还全绿 —— 守卫是恒真的');
  assert.ok(r.problems.some((p) => p.includes('没有引用标签常量符号')),
    '没报「没有引用标签常量符号」:\n' + r.problems.join('\n'));
});

test('守卫取函数体: 参数默认值里的 {} 不能被当成函数体(否则该渲染点永远报红)', () => {
  // 2026-10-23 第 70 批真踩的:
  //   新登记的渲染点是 `modules/gua_engine.js:castGua`, 它的签名是
  //     `function castGua(question, opts = {}) {`
  //   `_functionBodyAt` 原来取「函数名之后第一个 `{`」⇒ 拿到的是**默认参数的空对象**,
  //   切出来的「函数体」只有 36 个字符 ⇒ 里面当然没有标签符号
  //   ⇒ P12 对这个渲染点**永远报红**, 而台账登记它是对的。
  //
  // ⚠️ 这条判据防的是「把判据放宽」那种偷懒修法:
  //   取不到函数体就「不查这个渲染点」⇒ 守卫变恒真 ⇒ 比没守卫更坏。
  //   正解是**把函数体取对**(跳过括号配平的参数列表)。
  const PROV = require(path.join(CORE, '64i/provenance.js'));
  const src = fs.readFileSync(path.join(CORE, 'modules/gua_engine.js'), 'utf8');
  const masked = PROV._maskJsNoise(src);
  const at = masked.indexOf('function castGua(');
  assert.ok(at >= 0, 'gua_engine 里定位不到 castGua —— 签名写法变了?');
  // 参数列表里确实有个 `{`(默认参数), 这是本条判据的前提
  const paren = masked.indexOf('(', at);
  // 参数列表 = 从 `(` 到**括号配平**的那个 `)`; 默认参数的 `{}` 就在里面。
  let depth = 0;
  let closeAt = -1;
  for (let i = paren; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') { depth--; if (depth === 0) { closeAt = i; break; } }
  }
  assert.ok(closeAt > 0, 'castGua 的参数列表没配平 —— 请重写本条判据');
  const params = masked.slice(paren, closeAt + 1);
  assert.ok(params.indexOf('{}') >= 0,
    'castGua 的参数默认值里没有 {} —— 本条判据的前提没了(签名改了?), 请重写');
  // 函数体的 `{` 必须在参数列表**之后** —— 这正是老实现取错的地方。
  const bodyBrace = masked.indexOf('{', closeAt);
  assert.ok(bodyBrace > closeAt,
    'castGua 的函数体 { 不在参数列表之后 —— 请重写本条判据');

  // 真正要验的: **守卫整体**对这个渲染点不再误报。
  //   取不到函数体就「不查」是偷懒; 这条判据不接受那种修法 ——
  //   它要求 P12 对 castGua **查到了**, 并且真引用在里面。
  const r = PROV.provenanceSummary();
  const castProblems = (r.problems || []).filter((p) => p.includes('gua_engine.js:castGua'));
  assert.equal(castProblems.length, 0,
    '守卫对 castGua 报错(取函数体取错了?):\n' + castProblems.join('\n'));

  // 并且: castGua 里那个标签引用必须真的被守卫看见 —— 即取到的函数体够长。
  //   用 P12 的实际取法(而不是我在这儿另写一份)才作数。
  const layer = PROV.LAYERS['hexagrams'];
  const f = layer.fields.find((x) => x.field && x.field.indexOf('大象辞') >= 0);
  assert.ok(f && f.production, '大象辞字段没登记 production');
  const hasCast = (f.production.renderedIn || []).includes('modules/gua_engine.js:castGua');
  assert.ok(hasCast, '大象辞的渲染点里没有 castGua —— 本条判据的前提没了');
});

test('负例: 渲染点只在**注释**里提到标签 → P12 必须报红(注释不算引用)', () => {
  // 第 55 批当场踩到的**恒真守卫**, 补在这里而不是新开文件 ——
  //   P12 原来拿 `_functionBodyAt` 切出来的**含注释原文**做 indexOf,
  //   于是「把真引用换成手写字面量, 再在同一函数体里写句注释提到那个符号」
  //   就能骗过它。我写那句注释时 P12 一直是绿的, 而那个函数体里根本没引用常量。
  // 现在 P12 先过 `_maskJsNoise` 抹掉注释 ⇒ 注释不再算数。
  //
  // ⚠️ 这条负例只认**真引用被换掉**; 若日后有人把渲染点改回 formatGuaFirstBlock,
  //   它仍然引用不到 —— 那条记录的 renderedIn 是 buildTiYongLine, 别混。
  const P2 = mutateWithModules((root) => {
    const f = path.join(root, 'modules/gua_block.js');
    const s2 = fs.readFileSync(f, 'utf8');
    const before = s2;
    // 真引用 → 手写字面量, 并在**同一个函数体**里加一句提到该符号的注释
    const mutated = s2.replace(
      /\n(\s*)\+ TIYONG_GRADE_TAG;/,
      "\n$1+ '〔吉凶分级与百分比为课件量化, 非典籍原文〕'; // TIYONG_GRADE_TAG 提到一下"
    );
    assert.notEqual(mutated, before, '变异没生效 —— buildTiYongLine 的写法变了?');
    fs.writeFileSync(f, mutated, 'utf8');
    // 确认注释真的落在了那个函数体里(否则这条负例会变成假绿)
    //   用**真树**的词法器即可 —— 变异树里的与真树是同一份实现。
    const masked = require(path.join(CORE, '64i/provenance.js'))._maskJsNoise(mutated);
    const at = masked.indexOf('function buildTiYongLine(');
    assert.ok(at >= 0, '变异树里定位不到 buildTiYongLine');
    const rest = masked.slice(at);
    const endRel = rest.slice(1).search(/\n(function |const |module\.exports)/);
    const body = endRel < 0 ? rest : rest.slice(0, endRel + 1);
    assert.ok(body.indexOf('TIYONG_GRADE_TAG') < 0,
      '变异后该函数体里仍**保留**着 TIYONG_GRADE_TAG —— 抹注释没生效, 负例本身是坏的');
  });
  const r = P2.provenanceSummary();
  assert.ok(!r.ok, '渲染点不引用标签常量了(只在注释里提到)还全绿 —— 守卫是恒真的');
  assert.ok(r.problems.some((p) => p.includes('没有引用标签常量符号')),
    '没报「没有引用标签常量符号」:\n' + r.problems.join('\n'));
});

test('负例: B 类字段真的进了生产 → P13 必须报红(证明钉子真的在咬)', () => {
  // 在 modules/ 里造一处**真的**消费: 引用 BAGUA_AXIOMS 并读它的 season。
  // 这正是「下次有人加一行 bagua.season 进 prompt」的场景 ⇒ 必须报红。
  const P2 = mutateWithModules((root) => {
    fs.writeFileSync(path.join(root, 'modules/baguaprobe.js'),
      "'use strict';\n"
      + "const { BAGUA_AXIOMS } = require('../64i/bagua_annotations/bagua_axioms');\n"
      + "module.exports = { seasonOf: (i) => BAGUA_AXIOMS[i].season };\n",
      'utf8');
  });
  const r = P2.provenanceSummary();
  assert.ok(!r.ok, 'B 类字段进了生产还全绿 —— P13 是恒真的');
  assert.ok(r.problems.some((p) => p.includes('B 类字段进了生产')),
    '没报「B 类字段进了生产」:\n' + r.problems.join('\n'));
  assert.ok(r.problems.some((p) => p.includes('season') && p.includes('baguaprobe')),
    '报红里没指出是哪个文件哪个属性:\n' + r.problems.join('\n'));
});

test('正例(回归): 同名不同物不该被误报(通用英文词名不是数据源)', () => {
  // `color`/`description`/`season`/`number` 是通用英文词名, 全仓到处都是:
  //   modules/permission.js 的 color = UI 配色
  //   modules/tools_schema.js 的 description = 工具 schema
  //   modules/wuxing.js 的 season = 它**自己抄的**五行描述表(不是 wuxing_axioms)
  // 若 P13 只钉词名, 第一版实测报 22 条**全是假阳性**。
  // ⇒ 守卫必须要求「同一个文件里还出现了该数据源的标识符」。
  const s = P.provenanceSummary();
  assert.ok(s.ok, '真树上不该有假阳性:\n' + s.problems.join('\n'));
  // 并且真的在跑, 不是没跑
  const st = P.assertProvenance().stats;
  assert.ok(st.notInProductionWatched > 0, 'P13 根本没扫');
});

test('正例: P13 扫的是生产层(modules/), 不是内核层(64i/)', () => {
  // 64i/ 里当然有 season/description 这些属性 —— 它是数据源。
  // 扫它等于永远命中, 守卫就没有意义。
  // 所以台账里 B 类字段的 watchScope 必须指向 64i 侧的标识符,
  // 而扫描范围是 modules/。
  const s = P.provenanceSummary();
  assert.ok(s.ok);
  const bField = P.LAYERS['bagua_annotations:bagua_axioms'].fields
    .find((f) => f.notInProduction && (f.watchAttrs || []).indexOf('season') >= 0);
  assert.ok(bField, '八卦季节没有登记成 B 类');
  assert.ok(bField.watchScope.some((x) => /BAGUA_AXIOMS|bagua_axioms/.test(x)),
    'watchScope 必须指向 64i 侧的数据源标识符');
});

