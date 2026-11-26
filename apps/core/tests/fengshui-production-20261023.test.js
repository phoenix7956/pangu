/**
 * tests/fengshui-production-20261023.test.js — 第 69 批: 风水层接进生产
 *
 * 背景:
 *   第 68 批把风水门内核做出来了(1052 行, 29 条判据全绿), 但**模型够不着** ——
 *   没有工具、没进 LAYERS。
 *   ⇒ 「内核里很完整、模型看不见」= 等于没做。
 *   本批把它接到 `fengshui_calc` 上。
 *
 * ⚠️ 本测试里**每一条断言都对着一个真缺口写**, 不是对着实现写:
 *   ① 工具**真的注册**了 —— 且真在 main 集里(不在 li 集: li 已 8987/9000)
 *   ② 真调一次, **输出带身份标签** —— 标签摘掉就红(这是本批最要紧的一条)
 *   ③ 缺料**不编** —— 缺性别不出命卦, 缺坐山不出宅卦, 且 missing 说清缺哪几项
 *   ④ 坐山自由写法认得出: 「坐北向南」「子山午向」「坎」都要能解
 *   ⑤ 探测器窄口径: 风水词命中 → fengshui 路由; **「方位」这种通用词不许命中**
 *   ⑥ 风水路由排在 decision **前面** —— 否则排盘题被"谋断类"抢走去起卦
 *   ⑦ 出处台账: 三个 interpretive 字段都改成 production, 且带 marker
 *   ⑧ P12 守卫: 渲染点函数体**引用**标签常量(不许手写字面量)
 *   ⑨ 孤岛判据: 风水层不许有「没人执行的判决」
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const M = (p) => require(path.join(CORE, p));
const SRC = (p) => fs.readFileSync(path.join(CORE, p), 'utf8');

const TOOLS = M('modules/tools/index.js');
const SCHEMA = M('modules/tools_schema.js');
const LAYER_PLAN = M('modules/layer_plan.js');
const FS_KERNEL = M('64i/fengshui/index.js');
const REPORT = M('modules/fengshui_report.js');

// ─────────────────────────────────────────────────────────────
// ① 工具注册: 真在 main 集里, 且**不在** li 集里
// ─────────────────────────────────────────────────────────────

test('接线: fengshui_calc 真的注册了, 且真在 main 集里', () => {
  assert.ok(SCHEMA.TOOLS_SCHEMA.fengshui_calc, 'schema 里必须有 fengshui_calc');
  assert.equal(SCHEMA.TOOLS_SCHEMA.fengshui_calc.function.name, 'fengshui_calc');
  assert.ok(typeof TOOLS.TOOLS.fengshui_calc === 'function', 'tools/index.js 里必须有实现');
  assert.ok(SCHEMA.MAIN_GENERAL_TOOLS_FOR_LLM.indexOf('fengshui_calc') >= 0,
    'fengshui_calc 必须在 MAIN_GENERAL_TOOLS_FOR_LLM 里 —— 不在里面, 主对话根本调不到');
});

test('接线: fengshui_calc **不许**进 li 的白名单(li 已 8987/9000)', () => {
  // 2026-10-16 实测教训: li 的工具 schema 每刀都要带一遍, 超 9000 字符那条守卫就红。
  // 而 wuxing_judge 第一版描述写了 718 字符, 把 li 从 7962 顶到 9329 —— 当场顶穿。
  const { ROLES, _nativeTools } = M('agents/sub-agent');
  assert.equal(ROLES.li.tools.indexOf('fengshui_calc'), -1,
    'fengshui_calc 不许进 li 白名单 —— 那份 schema 只剩 13 字符余量');
  const len = JSON.stringify(_nativeTools(ROLES.li.tools)).length;
  assert.ok(len < 9000, 'li 实测 ' + len + ' 字符, 超了 9000');
});

test('接线: 工具描述只讲「何时调/怎么填/结果怎么用」, 不讲答案长什么样', () => {
  // 10-21 实跑教训: 提示里出现的词会被模型原样搬去当开篇标签。
  const d = SCHEMA.TOOLS_SCHEMA.fengshui_calc.function.description;
  assert.ok(d.indexOf('【何时调】') >= 0, '要写清什么时候调');
  assert.ok(d.indexOf('【怎么填】') >= 0, '要写清怎么填参数');
  assert.ok(d.indexOf('【结果】') >= 0, '要写清结果怎么用');
  assert.ok(d.length < 700, '描述 ' + d.length + ' 字符 —— 太长会顶工具 schema 预算');
});

// ─────────────────────────────────────────────────────────────
// ② 真调一次: 输出必须带身份标签(本批最要紧的一条)
// ─────────────────────────────────────────────────────────────

test('接线: 真调一次, 输出带身份标签 —— 标签摘掉就红', async () => {
  const r = await TOOLS.TOOLS.fengshui_calc({
    params: { year: 1991, gender: '男', sitting: '子山午向', house_year: 2010 },
  });
  assert.equal(r.ok, true, '真调一次必须成功: ' + JSON.stringify(r.error || {}));
  assert.ok(r.report && r.report.length > 0, '必须有给模型看的 report');
  // 整段身份标签
  assert.ok(r.report.indexOf(FS_KERNEL.FENGSHUI_TAG) >= 0,
    'report 里必须有整段身份标签 —— 风水层是风水查法资料口径, 不是《易经》原文');
  assert.ok(r.tag === FS_KERNEL.FENGSHUI_TAG, 'tag 字段必须与内核常量同一个字面量');
  // 段内解读条目
  assert.ok(r.interpretive_tag === FS_KERNEL.FENGSHUI_INTERPRETIVE_TAG,
    'interpretive_tag 必须与内核常量同一个字面量');
});

test('接线: 标签字面量只在 64i 定义一次, 生产层不许各写一份', () => {
  // 「注释 ≠ 隔离」的第七种形态: 两处各写一份标签, 改一处忘一处就有一半路径裸着。
  const tagLiteral = FS_KERNEL.FENGSHUI_TAG;
  const rep = SRC('modules/fengshui_report.js');
  assert.ok(rep.indexOf(tagLiteral) < 0,
    '生产层不许硬写标签字面量 —— 必须 require + 引用内核常量');
  assert.ok(rep.indexOf('FENGSHUI_TAG') >= 0, '生产层必须引用内核的标签常量符号');
  assert.ok(rep.indexOf('FENGSHUI_INTERPRETIVE_TAG') >= 0,
    '生产层必须引用内核的解读标签常量符号');
});

test('接线: 出处台账的三个 interpretive 字段都进了生产, 且都带 marker', () => {
  const prov = M('64i/provenance.js');
  const keys = ['fengshui:zhai_gua', 'fengshui:dayun_geometry', 'fengshui:jiuyun'];
  let checked = 0;
  for (const k of keys) {
    const layer = prov.LAYERS[k];
    assert.ok(layer, '台账里必须有 ' + k);
    for (const f of layer.fields || []) {
      if (f.status !== 'interpretive') continue;
      checked++;
      assert.equal(f.notInProduction, undefined,
        k + ' 的 interpretive 字段还挂着 notInProduction —— 它现在进生产了');
      assert.ok(f.production, k + ' 的 interpretive 字段必须有 production 块');
      assert.ok(f.production.marker, '必须有 marker');
      assert.ok(f.production.markerConstant, '必须有 markerConstant');
    }
  }
  assert.equal(checked, 3, '风水层应恰好有 3 个 interpretive 字段进生产');
});

// ─────────────────────────────────────────────────────────────
// ③ 缺料不编
// ─────────────────────────────────────────────────────────────

test('接线: 缺料**不编** —— 缺性别就不给命卦, 且 missing 说清缺哪几项', async () => {
  const r = await TOOLS.TOOLS.fengshui_calc({ params: { year: 1991 } });
  assert.equal(r.ok, true, '有 year 就该能出(部分)盘');
  assert.equal(r.data.ming_gua, null, '缺性别 ⇒ 命卦必须空, 不许拿默认值填一个');
  assert.ok(r.missing.some((m) => m.indexOf('性别') >= 0),
    'missing 必须说清缺性别: ' + JSON.stringify(r.missing));
});

test('接线: 什么都不给 ⇒ 显式报缺料, 不排一个空盘', async () => {
  const r = await TOOLS.TOOLS.fengshui_calc({ params: {} });
  assert.equal(r.ok, false, '什么都不给必须报错');
  assert.equal(r.error.code, 'FENGSHUI_NO_INPUT');
});

test('接线: 性别认不出来时**不许**猜(命卦男女加减完全相反, 猜错整盘反)', async () => {
  const r = await TOOLS.TOOLS.fengshui_calc({ params: { year: 1991, gender: '不知道' } });
  assert.equal(r.ok, true);
  assert.equal(r.data.ming_gua, null, '性别认不出 ⇒ 不给命卦');
  assert.ok(r.missing.some((m) => m.indexOf('性别') >= 0), 'missing 必须点出性别');
});

test('内核: mingGua 性别认不出就报错, **不许**默认成男命', () => {
  // 第 69 批挖出来的真 bug:
  //   原来写的是 `gender === 'f' ? 'f' : 'm'` —— 传 undefined / '' / 'x' 都落成男命,
  //   **不报错**。而命卦男女是「11 减」对「4 加」, 方向完全相反:
  //   1991 年男命 = 9离, 女命 = 6乾 —— 猜错整盘反了, 结果看起来却完全正常。
  //
  // ⚠️ 为什么第 68 批的 80 条全量对账没逮到它:
  //   那 80 条全是**显式传** 'm' / 'f' 的 ⇒ 永远碰不到这条分支。
  //   ⇒ 「缺料就编」这个洞, 只有**显式传错值**的判据才逮得到。
  const MING = M('64i/fengshui/ming_gua.js');
  for (const bad of [undefined, null, '', 'x', '男', 'male', 0, 1]) {
    assert.throws(() => MING.mingGua(1991, bad),
      '性别=' + JSON.stringify(bad) + ' 必须报错, 不许默认成男命');
  }
  // 显式的 m/f 照旧能算
  assert.equal(MING.mingGua(1991, 'm').gua, '离');
  assert.equal(MING.mingGua(1991, 'f').gua, '乾');
  assert.notEqual(MING.mingGua(1991, 'm').gua, MING.mingGua(1991, 'f').gua,
    '男女命卦必须不同 —— 不然「猜错整盘反」就无从谈起');
});

test('内核: zhaiGua 与 zhaiGuaByGua 查的**不是同一张表**, 别拿错那把钥匙', () => {
  // 第 69 批挖出来的第二个真 bug:
  //   parseSitting() 把「子山午向」解析成卦「坎」, 再喂给 zhaiGua('坎') ——
  //   而 zhaiGua() 的键是**山名**(壬子癸…) ⇒ 查不到 ⇒ 返回 gua: undefined,
  //   **而且不报错**, 后面照常往下走, 输出一份「undefined宅(undefined)」的盘。
  //   这种错不崩不红, 只是内容是假的 ⇒ 最难查的一类。
  const ZHAI = M('64i/fengshui/zhai_gua.js');
  // 拿卦名喂山名那把钥匙 ⇒ 必须明确失败, 不能给一份 undefined 的盘
  const wrong = ZHAI.zhaiGua('坎');
  assert.equal(wrong.ok, false, '拿卦名喂 zhaiGua() 必须失败');
  assert.ok(!wrong.gua, '失败时不许带一个 gua 字段出去');
  // 拿卦名喂对的那把钥匙 ⇒ 拿到完整的宅卦
  const right = ZHAI.zhaiGuaByGua('坎');
  assert.equal(right.ok, true);
  assert.equal(right.gua, '坎');
  assert.equal(right.group, '东四宅');
  // 山名那把钥匙照旧工作
  assert.equal(ZHAI.zhaiGua('子').gua, '坎');
});

test('接线: 端到端 —— 坐山给对了, 盘里的宅卦/大游年也得跟着对', async () => {
  // ⚠️ 这条是 M2 变异打空枪之后补的:
  //   M2 把 `zhaiGuaByGua(parsed.gua)` 改回 `zhaiGua(parsed.gua)` ——
  //   而 zhaiGua('坎') 返回的是 `{ok:false, reason:'不是二十四向山之一'}`,
  //   **不是 undefined, 也不抛异常** ⇒ 整条路静悄悄降级成「宅卦: 没定下来」,
  //   盘照样出得来, 只是少一项。**不崩不红, 只是内容是假的**。
  //
  //   ⇒ 只测「zhaiGua('坎') 会不会失败」不够, 必须测**端到端出的盘对不对**。
  //   这就是「注释 ≠ 隔离」的第七种形态: 局部都对, 拼起来是错的。
  const r = await TOOLS.TOOLS.fengshui_calc({
    params: { year: 1991, gender: '男', sitting: '子山午向' },
  });
  assert.equal(r.ok, true, '必须调得通');
  assert.equal(r.data.zhai_gua.ok, true,
    '坐山「子山午向」必须定出宅卦 —— 现在是: ' + JSON.stringify(r.data.zhai_gua));
  assert.equal(r.data.zhai_gua.gua, '坎', '子山属坎 ⇒ 坎宅');
  assert.equal(r.data.zhai_gua.group, '东四宅');
  // 大游年盘要按**宅卦**起, 不是按命卦 —— 盘里那一方位表必须对得上坎宅
  assert.ok(r.data.dayun, '必须有方位盘');
  assert.equal(r.data.dayun.gua, '坎', '大游年按宅卦(坎)起盘');
  const song = r.data.dayun.song;
  assert.equal(song, M('64i/fengshui/dayun_geometry.js').DAYUN_SONGS.坎,
    '大游年歌诀必须与坎宅那一行逐字相同');
  // 宅命相配也要算出来(命卦离=东四命, 宅卦坎=东四宅 ⇒ 相配)
  assert.ok(r.data.match, '必须给宅命相配');
  assert.equal(r.data.match.ok, true, '东四命 × 东四宅 ⇒ 相配');
});

test('接线: 端到端 —— 坐山给错了要显式说, 不是静悄悄少一项', async () => {
  const r = await TOOLS.TOOLS.fengshui_calc({
    params: { year: 1991, gender: '男', sitting: '斜着' },
  });
  assert.equal(r.ok, true, '整体仍要出(别的项照出)');
  assert.equal(r.data.zhai_gua.ok, false, '认不出的坐山必须显式失败');
  assert.ok(r.data.zhai_gua.reason, '失败要说清为什么');
  assert.ok(r.data.zhai_gua.need, '失败要说清要什么');
  // 命卦那部分**不受影响** —— 缺一项不能连累别的项
  // ⚠️ 命卦对象**没有** ok 字段(它是"要么算出来要么抛错"的纯函数),
  //   所以这里看它有没有卦名, 别看 .ok。
  assert.ok(r.data.ming_gua && r.data.ming_gua.gua, '命卦照出');
});

test('接线: 端到端 —— 四项阳宅都要在, 且灶那项的位置字段不是 positions', async () => {
  // ⚠️ 这是 M12 变异打空枪之后补的:
  //   灶是「坐凶方、向吉方」, 位置字段是 sit_positions / face_positions,
  //   **没有** positions ⇒ 统一走 item.positions 会 undefined.map 抛异常,
  //   整次工具调用被 catch 兜住 ⇒ 主人看到「工具失败」。
  const r = await TOOLS.TOOLS.fengshui_calc({
    params: { year: 1991, gender: '男', sitting: '子山午向' },
  });
  assert.equal(r.ok, true, '必须调得通: ' + JSON.stringify(r.error || {}));
  const s = r.data.siYao.siYao;
  for (const k of ['门', '主', '灶', '厕']) {
    assert.ok(s[k], '四项都要在, 缺 ' + k);
  }
  assert.ok(s['灶'].sit_positions && s['灶'].sit_positions.length, '灶要有坐方');
  assert.ok(s['灶'].face_positions && s['灶'].face_positions.length, '灶要有向方');
  // 渲染出来的那一段里, 四项都得出现
  for (const k of ['门', '主', '灶', '厕']) {
    assert.ok(r.report.indexOf('阳宅四要·' + k) >= 0,
      'report 里要有 ' + k + ' —— 现在是:\n' + r.report);
  }
});

test('接线: 端到端 —— report 里**每一项都真出现**(不许静悄悄少一行)', async () => {
  // ⚠️ 这条是本批**第二次**踩同一个形状之后补的:
  //   渲染点写的是 `if (profile.ming_gua && profile.ming_gua.ok)`,
  //   而命卦对象**没有 ok 字段**(它是「要么算出来要么抛错」的纯函数)
  //   ⇒ 判假 ⇒ **命卦那一行静悄悄不出现**。
  //   内核算对了、工具返回 ok:true、盘也出得来 —— 只是少一行, 不报错。
  //   实跑时才发现: 报告里第一行是【宅卦】, 【命卦】整个没了。
  //
  //   ⇒ 教训: 「内核对了」不等于「渲染出来对了」。
  //   判据要钉**渲染结果里每一项都在**, 不是钉内核字段存在。
  const r = await TOOLS.TOOLS.fengshui_calc({
    params: { year: 1991, gender: '男', sitting: '坐北向南', house_year: 2010 },
  });
  assert.equal(r.ok, true);
  const want = ['【命卦】', '【宅卦】', '【大游年】', '【阳宅四要·门】', '【阳宅四要·主】',
    '【阳宅四要·灶】', '【阳宅四要·厕】', '【宅命相配】', '【宅运】'];
  for (const w of want) {
    assert.ok(r.report.indexOf(w) >= 0,
      'report 里必须有 ' + w + ' —— 现在是:\n' + r.report);
  }
  // 命卦那行还得带对内容(有卦名有分组)
  const line = r.report.split('\n').find((l) => l.indexOf('【命卦】') >= 0);
  assert.ok(line.indexOf('离卦') >= 0, '命卦那行要带卦名: ' + line);
  assert.ok(line.indexOf('东四命') >= 0, '命卦那行要带分组: ' + line);
});

test('接线: 端到端 —— 缺料的项不许出现在 report 里, 也不许崩', async () => {
  // 「不该有的不许有」也是判据的一半:
  //   只给坐山不给出生年 ⇒ report 里不该有【命卦】和【宅命相配】(它需要命卦)。
  const r = await TOOLS.TOOLS.fengshui_calc({ params: { sitting: '子山午向' } });
  assert.equal(r.ok, true);
  assert.ok(r.report.indexOf('【命卦】') < 0, '没出生年就不该有命卦那行:\n' + r.report);
  assert.ok(r.report.indexOf('【宅命相配】') < 0, '没命卦就不该有宅命相配:\n' + r.report);
  // 但有的那几项必须在
  assert.ok(r.report.indexOf('【宅卦】') >= 0, '宅卦要在:\n' + r.report);
  assert.ok(r.report.indexOf('【大游年】') >= 0, '大游年要在:\n' + r.report);
});

test('内核: 坐山解析的 how 要诚实 —— 「坐北向南」是坐山侧, 不是按朝向反推', () => {
  // 第 69 批挖出来的第三个真 bug:
  //   「坐北向南」的正则抓到「北向」——「北向」不在方位表里, 于是掉到「朝/向」分支,
  //   被当成「朝向北」⇒ how 标成 facing_direction_inverted。
  //   **卦算对了但 how 标错了** —— 更坏: how 是模型判断「这是罗盘读的」
  //   还是「我反推的」的唯一依据, 标错就是在骗模型。
  const ZHAI = M('64i/fengshui/zhai_gua.js');
  assert.equal(ZHAI.parseSitting('坐北向南').how, 'sitting_direction');
  assert.equal(ZHAI.parseSitting('坐南朝北').how, 'sitting_direction');
  assert.equal(ZHAI.parseSitting('坐北向南').gua, '坎');
  assert.equal(ZHAI.parseSitting('坐南朝北').gua, '离');
  // 光给一个方位 ⇒ 盘古替他定的, how 要标出来
  assert.equal(ZHAI.parseSitting('北').how, 'bare_direction_as_sitting');
});
// ─────────────────────────────────────────────────────────────
// ④ 坐山自由写法
// ─────────────────────────────────────────────────────────────

test('接线: 坐山认得自由写法 —— 主人不会拿着罗盘说话', () => {
  const ZHAI = M('64i/fengshui/zhai_gua.js');
  // 坐北向南 ⇒ 坐山在北 ⇒ 坎
  const a = ZHAI.parseSitting('坐北向南');
  assert.equal(a.ok, true, '「坐北向南」要认得');
  assert.equal(a.gua, '坎');
  assert.equal(a.how, 'sitting_direction');
  // 子山午向 ⇒ 坐山=子 ⇒ 坎
  const b = ZHAI.parseSitting('子山午向');
  assert.equal(b.ok, true);
  assert.equal(b.gua, '坎');
  // 卦名
  const c = ZHAI.parseSitting('坎');
  assert.equal(c.ok, true);
  assert.equal(c.gua, '坎');
  // 朝向 ⇒ 坐山取对宫: 朝南 ⇒ 坐北 ⇒ 坎
  const d = ZHAI.parseSitting('朝南');
  assert.equal(d.ok, true);
  assert.equal(d.gua, '坎');
  assert.equal(d.how, 'facing_direction_inverted');
  // 认不出 ⇒ 报缺, 不瞎猜
  const e = ZHAI.parseSitting('斜着');
  assert.equal(e.ok, false, '认不出的必须显式失败');
  assert.ok(e.need, '失败时要说清要什么');
});

test('接线: 坐山解析结果带着「怎么解出来的」(how), 模型才知道不是罗盘读的', () => {
  const ZHAI = M('64i/fengshui/zhai_gua.js');
  for (const input of ['坐北向南', '子山午向', '坎', '朝南', '北']) {
    const r = ZHAI.parseSitting(input);
    assert.equal(r.ok, true, input + ' 要能解');
    assert.ok(r.how, input + ' 必须带 how —— 不带的话模型会把反推当实测');
  }
});

// ─────────────────────────────────────────────────────────────
// ⑤ 探测器窄口径
// ─────────────────────────────────────────────────────────────

test('接线: 风水词命中 ⇒ 走 fengshui 路由', () => {
  for (const t of ['我家坐北朝南, 门该开在哪', '八宅怎么看', '大游年排一下',
    '阳宅四要', '宅命配不配', '九运是哪一年']) {
    const p = LAYER_PLAN.detectLayerPlan(t);
    assert.equal(p.route, 'fengshui', t + ' ⇒ 应走 fengshui, 实际 ' + p.route);
    assert.ok(p.tools.indexOf('fengshui_calc') >= 0, t + ' ⇒ 入口应是 fengshui_calc');
  }
});

test('接线: 探测器不许用通用词误伤 —— 「方位」两个字不进风水词表', () => {
  // 「今年财运方位在哪」是八字题(有生辰), 不是风水题。
  // 命中通用词会把八字题改造成风水题 ⇒ 答出来的是方位表不是盘。
  assert.equal(LAYER_PLAN.FENGSHUI_REQUEST_KWS.indexOf('方位'), -1,
    '「方位」是通用词, 不许进风水词表');
  const p = LAYER_PLAN.detectLayerPlan('1991年生的, 今年财运方位在哪');
  assert.notEqual(p.route, 'fengshui', '有生辰的八字题不该被风水抢走');
});

// ─────────────────────────────────────────────────────────────
// ⑥ 路由优先级: 风水必须在 decision 前面
// ─────────────────────────────────────────────────────────────

test('接线: 风水路由排在 decision 前面 —— 排盘题不许被"谋断类"抢走去起卦', () => {
  // 「门该开在哪」带「该」字, 会命中 decision 类。
  // 若 decision 先判, 一个确定性排盘题就变成起卦题 ⇒ 答出来的是卦不是盘。
  const p = LAYER_PLAN.detectLayerPlan('我家坐北朝南, 门该开在哪个方位');
  assert.equal(p.route, 'fengshui',
    '排盘题被抢去起卦了 —— 优先级错了。实际 route=' + p.route);
});

test('接线: 主人明说「算一卦」时仍然是 gua —— 风水不许压过卦的显式要求', () => {
  const p = LAYER_PLAN.detectLayerPlan('算一卦, 我家风水怎么样');
  assert.equal(p.route, 'gua', '明说要卦时以卦为准(规则 19a)');
});

// ─────────────────────────────────────────────────────────────
// ⑦⑧ 出处台账与 P12 守卫
// ─────────────────────────────────────────────────────────────

test('接线: 出处守卫整体绿(含 P12 生产标签守卫)', () => {
  const prov = M('64i/provenance.js');
  const r = prov.assertProvenance();
  assert.equal(r.ok, true, '出处守卫报红:\n' + r.problems.join('\n'));
});

test('接线: P12 查得到 —— 渲染点函数体真的引用了标签常量符号', () => {
  const prov = M('64i/provenance.js');
  const layer = prov.LAYERS['fengshui:zhai_gua'];
  const field = layer.fields.find((f) => f.status === 'interpretive');
  assert.ok(field.production.renderedIn.includes('modules/fengshui_report.js:renderFengshuiReport'));
  assert.equal(field.production.markerConstant, '64i/fengshui/index.js:FENGSHUI_INTERPRETIVE_TAG');
});

// ─────────────────────────────────────────────────────────────
// ⑨ 孤岛判据
// ─────────────────────────────────────────────────────────────

test('接线: 风水层不许有「没人执行的判决」', () => {
  const prov = M('64i/provenance.js');
  for (const k of ['fengshui:ming_gua', 'fengshui:zhai_gua', 'fengshui:dayun_geometry',
    'fengshui:siyao', 'fengshui:jiuyun']) {
    assert.ok(prov.LAYERS[k], '台账里必须有 ' + k);
  }
  // 那两把刀(对表/歌诀不动点)必须接在装时自检里, 不是只躺在 tests/。
  const r = prov.assertProvenance();
  assert.equal(r.ok, true, '装时自检报红:\n' + r.problems.join('\n'));
});

test('接线: 风水层进了 LAYERS, 且 basisLayers 指向真实存在的出处层', () => {
  const LP = M('64i/bagua_annotations/layer_plan.js');
  const prov = M('64i/provenance.js');
  const L = LP.LAYERS.fengshui;
  assert.ok(L, 'LAYERS 里必须有 fengshui 层');
  assert.deepEqual(L.tools, ['fengshui_calc'], '入口必须是 fengshui_calc');
  for (const b of L.basisLayers) {
    assert.ok(prov.LAYERS[b], 'basisLayers 指向的层必须在台账里存在: ' + b);
  }
});

test('接线: 全局规则 #19 提到了风水层(模型得知道有这条路)', () => {
  const src = SRC('modules/global_agent_rules.js');
  const i = src.indexOf("n: '19'");
  assert.ok(i >= 0, '规则 #19 要在');
  const body = src.slice(i, i + 4000);
  assert.ok(body.indexOf('fengshui_calc') >= 0,
    '规则 #19 必须提 fengshui_calc —— 不提, 模型不知道有这条路');
});
