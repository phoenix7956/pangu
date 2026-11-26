'use strict';
// 爻层边界守卫 (2026-10-22)
//
// 老板 10-21 原话:「爻动阴阳那就太过了」
//
// 这条红线原来**只活在 decision.md 里** —— 那是过程文档, 不在代码路径上。
// 任何一次「顺手加个五行判断」都能悄无声息地越过去, 而且它不会报错,
// 只会安静地给出另一套话术(和「传男被当女命」同族: 取值错了不抛异常,
// 只是返回另一个东西)。
//
// 本批把它变成**机制**: `modules/yao_layer_boundary.js` 装时自检, 越界即抛。
//
// ⚠️ 最重要的一课在**负例**那一段:
//   守卫「全绿」本身不说明它有用 —— 把判据写空也能全绿。
//   所以下面每条判据都有对应的**反例**: 造一个假的越界模块喂进去,
//   断言守卫**必须报出来**。绿灯是结果, 咬人是证据。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CORE = path.join(__dirname, '..');
const G = require(path.join(CORE, 'modules', 'yao_layer_boundary.js'));

// ============================================================
// 一、真代码守住红线
// ============================================================

test('全量判据通过 (真代码没越界)', () => {
  const r = G.checkYaoLayerBoundary();
  assert.ok(r.ok, '红线被越过了:\n' + r.violations.join('\n'));
});

test('爻层三模块的 require 闭包里没有五行/纳甲模块', () => {
  const r = G.checkYaoLayerNoWuxing();
  assert.ok(r.ok, r.violations.join('\n'));
  // 闭包大小钉住 —— 免得哪天闭包计算坏了(恒等于空集)也能通过
  const d = r.checks;
  assert.equal(d['爻值层'].closureSize, 0, '爻值层不该依赖任何东西');
  // 2026-11-26: c74940d (11-24) 给 yao_transform.js 加了 hexagrams 依赖 (互/综/错),
  //   closureSize 从 1 变成 3。断言改成「≥1 且不包含五行/纳甲模块」(banned 数组为空)。
  assert.ok(d['爻变层'].closureSize >= 1, '爻变层该有依赖 (至少爻值层)');
  assert.equal(d['爻变层'].banned.length, 0, '爻变层闭包里不该有五行/纳甲模块');
  assert.ok(d['爻辞层'].closureSize >= 1, '爻辞层该有依赖');
});

test('变卦推演的输出里没有五行/纳甲/六亲字段', () => {
  const r = G.checkTransformOutputShape();
  assert.ok(r.ok, r.violations.join('\n'));
});

test('★ 生产爻变路径(之卦)不带五行 —— 这条才护得住生产', () => {
  // 查过: yao_transform.js 在生产里根本没被 require, 真爻变在 gua_engine.js。
  // 只盯 64i 那条死路, 有人越界改 gua_engine 守卫却一声不响。
  const r = G.checkProductionChangePathNoWuxing();
  assert.ok(r.ok, r.violations.join('\n'));
});

test('五行层必须有阴阳 (反向判据: 删光也能过的是坏守卫)', () => {
  const r = G.checkWuxingLayerHasYinyang();
  assert.ok(r.ok, r.violations.join('\n'));
});

// ============================================================
// 一之补、第 39 批: 方向 B 换了守法 —— 守**真载体**, 不是守影子
//
// ⚠️ 这段测试的由来(实跑抓出来的, 不是设计出来的):
//   方向 B 原来只查「wuxing_yinyang.js 有没有导出 judgeKeByYinYang」。
//   实跑两头都验了:
//     ① 删掉 judgeKeByYinYang ⇒ 报红, 而**生产零影响**
//        (生产走十神层「正官/七杀」, 实跑 20 对克关系 force 与正偏零不一致)
//     ② 十神层阴阳维度全坏 ⇒ **照样绿** —— 真正的漏洞它一点都看不见
//   ⇒ 假守卫: 守着影子, 不是真身(同「假纳甲当锚」「C4 恒真」一族)
//   ⇒ 现在改守真载体: 五合判据 + 十神层正偏 + 两套编码交叉校验
// ============================================================

test('方向B 真判据: 五合必须齐、化得出、且与十神层正偏对得上 (真树必须绿)', () => {
  const r = G.checkYinyangJudgeReal();
  // ⚠️ checkYinyangJudgeReal 返回的是 **violations 数组**(不是 {ok,...}) ——
  //   它被 checkWuxingLayerHasYinyang 内部调用, 那边负责拼成 {ok, violations}。
  assert.equal(r.length, 0, '真树上不该有违规:\n' + r.join('\n'));
});

test('★ 负例: 十神层阴阳维度坏掉 → 必须报红, 且归因指向十神层', () => {
  // 这是旧守卫**看不见**的那个洞: 真的阴阳判据坏了, 它一声不响。
  const TG = require(path.join(CORE, '64i', 'bazi', 'ten_gods.js'));
  const broken = Object.assign({}, TG, {
    YIN_YANG: (() => {
      const o = {};
      for (const g of TG.TIAN_GAN) o[g] = '阳';   // 全部标成阳 ⇒ 正偏全乱
      return o;
    })(),
  });
  const r = G.checkYinyangJudgeReal({ tenGods: broken });
  assert.equal(r.length > 0, true, '十神层阴阳全坏竟然没报出来');
  // ⚠️ 归因必须准: 报错对象错了 = 跟没报一样有害
  //   (下一个人会去改那个被点名的无辜地方)
  assert.ok(
    r.some(v => v.includes('[十神层]')),
    '没有一条指向十神层: ' + r.join('; ')
  );
  assert.ok(
    !r.some(v => v.includes('多出真源没有的合')),
    '出现了假阳性(把正常的「庚乙」判成多余的合)—— 归一化用了被测层自己的阴阳表: ' + r.join('; ')
  );
});

test('★ 负例: 真源五合被删掉(丁壬合没了) → 必须报红并点名那一对', () => {
  // 老板原话:「阳火用阴水可能就克不了, 反而会助火」
  //   ⇒ 靠的就是丁壬合。合没了, 这条判据整个塌。
  const Y = require(path.join(CORE, '64i', 'bagua_annotations', 'wuxing_yinyang.js'));
  const broken = Object.assign({}, Y, {
    getHe: (a, b) => ((a === '丁' && b === '壬') ? null : Y.getHe(a, b)),
  });
  const r = G.checkYinyangJudgeReal({ yinyang: broken });
  assert.ok(r.length > 0, '丁壬合被删竟然没报出来');
  assert.ok(
    r.some(v => v.includes('丁壬') && v.includes('合则不克')),
    '没点名丁壬合: ' + r.join('; ')
  );
});

test('★ 负例: 凭空多出一对合 → 必须报红(不能只查「有没有」)', () => {
  const Y = require(path.join(CORE, '64i', 'bagua_annotations', 'wuxing_yinyang.js'));
  const broken = Object.assign({}, Y, {
    GAN_HE: Object.assign({}, Y.GAN_HE, {
      '庚乙': { pair: '乙庚', hua: '金', name: '仁义之合' },
      '壬丁': { pair: '丁壬', hua: '木', name: '淫慝之合' },
      '甲子': { pair: '甲子', hua: '水', name: '编出来的合' },
    }),
  });
  const r = G.checkYinyangJudgeReal({ yinyang: broken });
  assert.ok(r.length > 0, '多出假合竟然没报出来');
  assert.ok(
    r.some(v => v.includes('甲子') && v.includes('多出真源没有的合')),
    '没点名多出来的甲子合: ' + r.join('; ')
  );
  // ⚠️ 但真源那五对**不许**被误报(阳干在前的键写法坑)
  assert.ok(
    !r.some(v => v.includes('庚乙') || v.includes('壬丁')),
    '真源五对被误报: ' + r.join('; ')
  );
});

test('★ 负例: 两套编码对不上(judgeKe 的 force 与十神正偏矛盾) → 必须报红', () => {
  // 这是**交叉校验**那一头: 两层判据是独立写的, 一致 = 两条独立路径
  // 撞到同一个真相; 不一致 = 至少有一层错了。
  const Y = require(path.join(CORE, '64i', 'bagua_annotations', 'wuxing_yinyang.js'));
  const broken = Object.assign({}, Y, {
    judgeKeByYinYang: (self, other) => {
      const r = Y.judgeKeByYinYang(self, other);
      if (!r || !r.established) return r;
      return Object.assign({}, r, { force: r.force === 'full' ? 'weaken' : 'full' });  // 全部对调
    },
  });
  const r = G.checkYinyangJudgeReal({ yinyang: broken });
  assert.ok(r.length > 0, '两套编码全反了竟然没报出来');
  assert.ok(
    r.some(v => v.includes('两套编码必须指向同一个真相')),
    '没报交叉校验失败: ' + r.join('; ')
  );
});

test('爻位五行是静态的 —— 动的是爻的阴阳, 不是爻位的水火木金土', () => {
  const r = G.checkYaoPositionWuxingIsStatic();
  assert.ok(r.ok, r.violations.join('\n'));
});

test('卦层的锚在**真纳甲**上, 不是那根 60 甲子机械循环', () => {
  // ⚠️ 2026-10-22 第 33/34 批: 这条判据原来数的是 `hexagrams.js` 每卦的
  // `najia` 字段并断言「64 处」—— 而那根字段**压根不是纳甲**(60 甲子按卦序
  // 的机械循环)。拿它当锚 = 用假数据证明真数据在位: 真纳甲层被删了它照样绿。
  const r = G.checkHexagramNajiaAnchored();
  assert.ok(r.ok, r.violations.join('\n'));
  assert.equal(r.count, 8, '八卦纳甲天干应 8/8 齐全(真源: 梅花易数资料)');
  // 可装卦的卦数跟纳甲层**实算**一致 —— 不手写数字
  const NJ = require(path.join(CORE, '64i', 'bagua_annotations', 'najia.js'));
  assert.equal(r.loadable, NJ.loadableGuaIds().length);
});

test('★ 每一层都要写清「不放什么」—— 空的禁项 = 这层职责没写出来', () => {
  // 2026-10-22 第 34 批: 卦层和五行层的 forbid 原本都是空的「—」。
  // 空着看表像「这两层什么都行」, 恰恰是最容易越界的地方。
  assert.ok(Array.isArray(G.LAYER_BOUNDARY), 'LAYER_BOUNDARY 应导出');
  assert.ok(G.LAYER_BOUNDARY.length >= 3, '层表至少三层, 实为 ' + G.LAYER_BOUNDARY.length);
  for (const r of G.LAYER_BOUNDARY) {
    assert.ok(r.forbid && r.forbid.length > 0,
      '「' + r.layer + '」层的禁项是空的 —— 空着等于没写这层的边界');
    for (const item of r.forbid) {
      const by = (r.enforcedBy || {})[item];
      assert.ok(by && by.length > 0,
        '「' + r.layer + '」的禁项「' + item + '」没有 enforcedBy —— 空头愿望不是闸');
      for (const fn of by) {
        assert.ok(G.LAYER_BOUNDARY_CHECKS.includes(fn),
          '「' + r.layer + '」的禁项「' + item + '」指向了不存在的判据 ' + fn + '()');
        assert.equal(typeof G[fn], 'function', fn + '() 应可调用');
      }
    }
  }
});

// ============================================================
// 二、负例: 守卫必须会咬人
// ============================================================

test('负例: 爻层模块源码里出现五行 → 守卫报出来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yao-neg-'));
  const f = path.join(dir, 'bad_yao.js');
  fs.writeFileSync(f, [
    "'use strict';",
    "// 注释里写五行不算 —— 判据要先剥注释",
    "const wuxingAxioms = require('" + path.join(CORE, '64i', 'bagua_annotations', 'wuxing_axioms.js') + "');",
    'function t(yao6) { return { changed: yao6, rel: wuxingAxioms.getRelation("木", "火") }; }',
    'module.exports = { t };',
  ].join('\n'));

  const r = G.checkYaoLayerNoWuxing({ modules: [{ file: f, label: '假爻层' }] });
  assert.equal(r.ok, false, '越界模块竟然通过了 —— 守卫没咬人');
  assert.ok(r.violations.some(v => v.includes('wuxing')), '没报出 wuxing: ' + r.violations.join('; '));
});

test('负例: 只在注释里写五行不算越界 (别把守卫写成噪音)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yao-neg2-'));
  const f = path.join(dir, 'clean_yao.js');
  fs.writeFileSync(f, [
    "'use strict';",
    '// 这层不管五行纳甲, 那是卦层的事',
    '/* 也不管 纳甲 */',
    'function t(yao6) { return { changed: yao6 }; }',
    'module.exports = { t };',
  ].join('\n'));

  const r = G.checkYaoLayerNoWuxing({ modules: [{ file: f, label: '干净爻层' }] });
  assert.ok(r.ok, '注释里的字被当成了违规: ' + r.violations.join('; '));
});

test('负例: 爻层 require 了五行模块 → 闭包检查报出来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yao-neg3-'));
  const f = path.join(dir, 'bad_closure.js');
  // 注意: 变量名故意**不叫** wuxing —— 否则「源码 token 扫描」会先命中,
  // 闭包那条判据就永远轮不到, 白测一场。
  // 目标是: 源码本身干净, 但 require 了五行模块 → 只有闭包检查能抓住。
  fs.writeFileSync(f, [
    "'use strict';",
    "const rel = require('" + path.join(CORE, '64i', 'bagua_annotations', 'wuxing_axioms.js') + "');",
    'module.exports = { wa };',
  ].join('\n'));

  const r = G.checkYaoLayerNoWuxing({ modules: [{ file: f, label: '越层依赖' }] });
  assert.equal(r.ok, false, '越层依赖竟然通过了');
  assert.ok(r.violations.some(v => v.includes('闭包')), '没报出闭包越界: ' + r.violations.join('; '));
});

test('负例: 变卦输出里塞了五行字段 → 输出形状检查报出来', () => {
  const fake = {
    buildTransformedHexagram: (y) => ({ original: y, changed: y, moving: [0], originalIndex: 0, changedIndex: 1, wuxingRel: '木生火' }),
  };
  const r = G.checkTransformOutputShape({ yinYang: fake, yaoTransform: fake });
  assert.equal(r.ok, false, '越界输出竟然通过了');
  assert.ok(r.violations.some(v => v.includes('wuxingRel')), '没报出 wuxingRel: ' + r.violations.join('; '));
});

test('负例: 变卦输出被掏空 → 也要报 (免得「删光就通过」)', () => {
  const fake = {
    buildTransformedHexagram: () => ({}),
  };
  const r = G.checkTransformOutputShape({ yinYang: fake, yaoTransform: fake });
  assert.equal(r.ok, false, '空壳输出竟然通过了');
  assert.ok(r.violations.some(v => v.includes('掏空') || v.includes('不存在')),
    '没报出掏空: ' + r.violations.join('; '));
});

test('负例: 守卫自己不许崩 —— 缺函数时跳过并给判据, 而不是 TypeError', () => {
  // 守卫崩了 = 判据形同虚设, 而且报错跟"红线被越界"毫不相干,
  // 下一次看到的人只会以为守卫坏了, 直接把它删了。
  const fake = { buildTransformedHexagram: (y) => ({ original: y, changed: y, moving: [0] }) };
  let threw = null;
  let r = null;
  try { r = G.checkTransformOutputShape({ yinYang: fake, yaoTransform: fake }); }
  catch (e) { threw = e; }
  assert.equal(threw, null, '守卫自己崩了: ' + (threw && threw.message));
  assert.ok(r && Array.isArray(r.violations), '没给出判据数组');
});

test('负例: 五行层缺阴阳 → 报出来 (双向判据的另一半)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yao-neg4-'));
  const f = path.join(dir, 'thin_wuxing.js');
  fs.writeFileSync(f, "'use strict'; module.exports = { getHe: () => null };");

  const r = G.checkWuxingLayerHasYinyang({
    required: { file: f, label: '瘦五行层', exports: ['getHe', 'isOppositeYinYang', 'judgeKeByYinYang'] },
  });
  assert.equal(r.ok, false, '缺阴阳的五行层竟然通过了');
  assert.ok(r.violations.some(v => v.includes('isOppositeYinYang')), '没报出缺失的导出: ' + r.violations.join('; '));
});

test('负例: 爻位公理层又长出五行 / 五行随爻值变 → 报出来', () => {
  // 第 36 批后方向 C 换了前提, 所以这里造**两个**不同的坏样本:
  //   ① 那张查无出处的爻位五行表**回来**了(爻位带 wuxing)
  //   ② 而且它还**跟着爻值变**(老阳/老阴换个五行) —— 这才是「爻动叠五行」
  // 两个坏样本分别对应 C1 与 C2; 判据必须**分别**点名, 不能只说一句「有问题」。
  //   ⚠️ 为什么分开: 「报了但报错对象」和「没报」一样有害 ——
  //   下一个人会去改那个被点名的无辜地方。
  const fakeAxioms = {
    YAO_POSITION_AXIOMS: [
      { position: 0, wuxing: '水' }, { position: 1, wuxing: '木' },
      { position: 2, wuxing: '火' }, { position: 3, wuxing: '金' },
      { position: 4, wuxing: '土' }, { position: 5, wuxing: '火' },
    ],
    getYaoPositionAxiom(pos, yaoValue) {
      const ax = this.YAO_POSITION_AXIOMS[pos];
      if (!ax) return null;
      // 越界行为: 动爻(老阳9/老阴6)的爻位五行被换掉
      if (yaoValue === 9 || yaoValue === 6) return { ...ax, wuxing: '火' };
      return ax;
    },
  };
  const r = G.checkYaoPositionWuxingIsStatic({ yaoAxioms: fakeAxioms });
  assert.equal(r.ok, false, '爻位公理层带五行竟然通过了');
  assert.ok(r.violations.some(v => v.includes('又长出了 wuxing')),
    '没点名「爻位公理层不该再有五行」(C1): ' + r.violations.join('; '));
  assert.ok(r.violations.some(v => v.includes('不许随爻值变') || v.includes('不许看爻值')),
    '没点名「爻位公理不许随爻值变」(C2): ' + r.violations.join('; '));
});

test('负例: 六亲被掏空 / 「他」侧不走纳甲 → 报出来 (C6 反向判据)', () => {
  // 「把五行功能全删光也能通过」是守卫最已知的失效方式。
  // 真源缺失**不等于**功能该没有: 乾卦纳甲 6/6 有, 六亲必须六爻都算得出。
  // 期望值手写(乾宫属金 + 乾纳甲子寅辰午申戌), 不从被测函数自己算。
  const WANTS = ['子孙', '妻财', '父母', '官鬼', '兄弟', '父母'];
  const r = G.checkYaoPositionWuxingIsStatic({
    yaoAxioms: {
      YAO_POSITION_AXIOMS: Array.from({ length: 6 }, (_, i) => ({ position: i })),
      getYaoPositionAxiom: (p) => ({ position: p }),
    },
  });
  // 用**真**六亲层跑: 应该全绿, 证明 C6 的期望值是对的(否则 C6 是恒假的)
  assert.equal(r.ok, true, '真数据下方向 C 应全绿, 实报: ' + r.violations.join('; '));
  assert.deepEqual(
    WANTS.map((_, i) => require(path.join(CORE, '64i', 'bagua_annotations', 'liu_qin.js'))
      .computeLiuQin(1, i)),
    WANTS,
    'C6 的期望值本身必须对(否则它在报一个不存在的问题)'
  );
});

test('负例: 真纳甲层被掏空 → 报出来 (锚点的意义)', () => {
  // 掏空的方式跟真实事故同型: 八卦纳甲天干少了几个、装卦接口没了
  const fakeNajia = {
    JINGFANG_TIANGAN: { 乾: { inner: '甲', outer: '壬' } },
    getYaoGanzhi: () => ({ ok: false }),
  };
  const r = G.checkHexagramNajiaAnchored({ najia: fakeNajia });
  assert.equal(r.ok, false, '真纳甲层被掏空竟然通过了');
  assert.ok(r.violations.some(v => v.includes('8')),
    '没报出天干覆盖数不对: ' + r.violations.join('; '));
  assert.ok(r.violations.some(v => v.includes('getGuaNajiaCoverage')),
    '没报出装卦接口没了: ' + r.violations.join('; '));
});

test('负例: 旧 najia 字段被换成真纳甲表 → 点名要改口径标记', () => {
  // 反向守卫: 万一哪天有人把真纳甲灌进 hexagrams.js, 口径标记
  // (legacy_field_is_najia: false) 就得跟着改 —— 这条判据是那个「有人记得」的机制。
  const realNajia = require(path.join(CORE, '64i', 'bagua_annotations', 'najia.js'));
  const fakeNajia = Object.assign({}, realNajia, {
    auditLegacyNajia: () => ({ jingfang_necessary_property_holds: true }),
  });
  const r = G.checkHexagramNajiaAnchored({ najia: fakeNajia });
  assert.equal(r.ok, false, '旧字段变成真纳甲表竟然没报');
  assert.ok(r.violations.some(v => v.includes('legacy_field_is_najia')),
    '报错要点名要改的口径字段: ' + r.violations.join('; '));
});

// ============================================================
// 三、装时自检真的会抛
// ============================================================

test('assertYaoLayerBoundary 在当前代码上不抛 (绿灯的前提是真的没越界)', () => {
  assert.doesNotThrow(() => G.assertYaoLayerBoundary());
});

test('守卫的判据清单不空 —— 免得某天有人把判据清空成永真', () => {
  assert.ok(G.FORBIDDEN_IN_YAO_LAYER.length >= 4, '禁止 token 清单太短');
  assert.ok(G.FORBIDDEN_OUTPUT_KEYS.length >= 5, '禁止字段清单太短');
  assert.equal(G.YAO_LAYER_MODULES.length, 3, '爻层模块数变了 —— 补上新模块的判据');
});

test('自检要接在启动路径上 (不然只是躺在仓库里的一个文件)', () => {
  const src = fs.readFileSync(path.join(CORE, 'pangu-single.js'), 'utf8');
  assert.match(src, /yao_layer_boundary|assertYaoLayerBoundary/,
    'pangu-single.js 里没有爻层边界自检 —— 守卫没接进启动链, 等于没有');
});
