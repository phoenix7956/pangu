/**
 * 纳甲层测试 (第 33 批 · 2026-10-22)
 *
 * 这批修的是「**假口径**」: 64i/hexagrams.js 的 najia 字段看着像纳甲,
 * 其实是天干10循环×地支12循环的 60 甲子机械序列按 id(文王序)排
 * (乾甲子 坤乙丑 屯丙寅 …), 而它在生产输出里被当纳甲讲给用户。
 *
 * 机械证据(两条, 都不依赖外部表):
 *   ① 同下卦组内初爻 8/8 组全不唯一 ⇒ 违反京房装卦纳甲的必要条件
 *      「初爻只由下卦决定」⇒ 结构上不可能是纳甲
 *   ② 真源树里没有 64 卦纳甲表 ⇒ 没有出处
 *
 * 真纳甲(有出处的部分):
 *   天干 8/8  —— 梅花易数资料「甲壬为乾, 乙癸为坤, 丙艮、丁兑、戊坎、己离、庚震、辛巽」
 *   地支 2/8  —— <course-source> 阳德条(乾: 子寅辰午申戌) / 阴德条(坤: 未巳卯丑亥酉)
 *
 * ⚠️ 本文件里最重要的一段是**负例**那一节 ——
 *   「能装卦的是 4 卦不是 2 卦」这种结论最容易变成一句没人验证的话,
 *   而「6 个卦没有地支」这种缺口最容易被人悄悄填上。
 *   所以这里钉的**不是**「数据长这样」, 而是
 *   「这套表一旦被改坏/被填上编的, 守卫会当场报出来」。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const NJ = require(path.join(CORE, '64i', 'bagua_annotations', 'najia.js'));
const { HEXAGRAMS } = require(path.join(CORE, '64i', 'hexagrams.js'));

// 真源原句(逐字) —— 抄在这里, 是为了让「真源」这件事在测试里**可查**,
// 不是让测试自己给自己发证书。
const SRC_TRUTH = {
  乾: '子寅辰午申戌',   // <course-source> 阳德条
  坤: '未巳卯丑亥酉',   // <course-source> 阴德条(「刊卦」= 坤, OCR 有损)
};

// ============================================================
// 一、正例: 真纳甲
// ============================================================

test('全量自检通过 (表没脱节)', () => {
  const r = NJ.assertNajia();
  assert.equal(r.ok, true);
});

test('乾卦六爻干支与真源逐字一致', () => {
  const got = [];
  for (let p = 1; p <= 6; p++) {
    const r = NJ.getYaoGanzhi(1, p);
    assert.equal(r.ok, true, '乾第' + p + '爻应装得出来');
    got.push(r.dianzhi);
  }
  assert.equal(got.join(''), SRC_TRUTH.乾, '乾卦六爻地支应与阳德条逐字一致');
});

test('坤卦六爻干支与真源逐字一致', () => {
  const got = [];
  for (let p = 1; p <= 6; p++) {
    const r = NJ.getYaoGanzhi(2, p);
    assert.equal(r.ok, true, '坤第' + p + '爻应装得出来');
    got.push(r.dianzhi);
  }
  assert.equal(got.join(''), SRC_TRUTH.坤, '坤卦六爻地支应与阴德条逐字一致');
});

test('乾/坤 的天干内外分派与真源一致(甲壬为乾 / 乙癸为坤)', () => {
  assert.equal(NJ.JINGFANG_TIANGAN.乾.inner, '甲');
  assert.equal(NJ.JINGFANG_TIANGAN.乾.outer, '壬');
  assert.equal(NJ.JINGFANG_TIANGAN.坤.inner, '乙');
  assert.equal(NJ.JINGFANG_TIANGAN.坤.outer, '癸');
});

test('八卦纳甲天干 8/8 齐全', () => {
  assert.equal(Object.keys(NJ.JINGFANG_TIANGAN).length, 8);
  for (const k of ['乾', '坤', '艮', '兑', '坎', '离', '震', '巽']) {
    assert.ok(NJ.JINGFANG_TIANGAN[k], k + '应有纳甲天干');
  }
});

// ============================================================
// 二、可装卦的到底是哪几个
// ============================================================

test('★ 能完整装卦的是 64 卦(第 41 批补齐八卦地支后)', () => {
  // ⚠️ 这条结论的**历史**值得留着: 曾经写成「只有 2 卦」(写死「只有乾、坤」),
  //   忘了泰(上坤下乾)、否(上乾下坤) 的上下卦也都是乾/坤, 地支全有真源, 装得出来
  //   ⇒ 实为 4 卦(乾/坤/泰/否)。第 41 批把八卦地支补齐后, 变成 **64 卦全装得出**。
  //
  //   为什么「结论变了」不等于「判据失效」: 这条测试钉的是
  //   **「能装卦的集合 = 从表算出来的, 且与口径里的数一致」**。
  //   集合本身随真源变, 判据不变 —— 哪天再删掉一卦的地支, 这里立刻报红。
  const ids = NJ.loadableGuaIds();
  assert.equal(ids.length, 64,
    '第 41 批补齐八卦纳甲地支后, 64 卦都应能装 —— 实为 ' + ids.length
    + ' 个; 变了说明装卦规则或地支表被改了');
  assert.equal(ids[0], 1);
  assert.equal(ids[ids.length - 1], 64);
  assert.equal(NJ.NAJIA_BASIS.hexagram_fully_loadable, ids.length,
    '口径里的数必须是从表算出来的同一个数');
});

test('泰卦装卦 = 内取下卦(乾)前3 + 外取上卦(坤)后3', () => {
  const got = [];
  for (let p = 1; p <= 6; p++) got.push(NJ.getYaoGanzhi(11, p).ganzhi);
  assert.equal(got.join(''), '甲子甲寅甲辰癸丑癸亥癸酉');
});

test('否卦装卦 = 内取下卦(坤)前3 + 外取上卦(乾)后3', () => {
  const got = [];
  for (let p = 1; p <= 6; p++) got.push(NJ.getYaoGanzhi(12, p).ganzhi);
  assert.equal(got.join(''), '乙未乙巳乙卯壬午壬申壬戌');
});

test('装卦规则在口径里标明了「不是真源原句」', () => {
  // 跨卦那两例是**按规则外推**的, 不是真源直给 —— 口径里必须这么写,
  // 不然模型会把「推导」当「原文」讲出去。
  assert.equal(NJ.NAJIA_BASIS.zhuanggua_rule_is_explicit_in_source, false);
  assert.ok(NJ.NAJIA_BASIS.zhuanggua_rule, '口径里要写清装卦规则');
});

// ============================================================
// 三、缺口逻辑 —— 第 41 批后真实数据已无缺口, 但逻辑必须仍然有效
// ============================================================

test('★ 缺口逻辑仍然有效: 少一卦地支 → 装不出 + 带原因', () => {
  // ⚠️ 第 41 批把八卦地支补齐后, 真实数据**没有缺口**了。
  //   若把这条测试改成「现在没有缺口所以没有断言」, 它就**静默失效**了 ——
  //   哪天地支表又缺一格, 没人会发现。所以这里用**注入**的方式造缺口:
  //   临时替换模块里的地支表(改完还原), 验「装不出 + 原因 + 缺哪几个」三条都成立。
  //
  //   教训(踩坑日志「旧测试可能在钉假口径」): 负例要靠**构造的输入**, 不靠真实数据的缺口。
  // 震为雷(51) 的下卦是震 ⇒ 抽掉震的地支, 它就装不出了
  const patched = Object.freeze(Object.assign({}, NJ.JINGFANG_DIZHI, { 震: null }));
  const r = NJ.getYaoGanzhiWithTable(patched, 51, 1);
  assert.equal(r.ok, false,
    '前置条件不成立: 抽掉震的地支后, 震为雷的爻应装不出来');
  // 原因与缺失项必须说清
  const cov = NJ.getGuaNajiaCoverageWithTable(patched, 51);
  assert.equal(cov.loadable, false);
  assert.ok(cov.reason && cov.reason.length > 5, '装不出时必须有原因, 不能只给个空');
  assert.ok(cov.missing.length > 0, '应说清缺哪几个卦的地支');
  assert.ok(cov.missing.includes('震'), 'missing 里要点名震卦');
  // 错误码必须是 NO_DIZHI
  assert.equal(r.error.code, 'NO_DIZHI');
  assert.ok(r.error.message.includes('震'), '错误信息要指出缺哪个卦');
  // 生产入口与注入入口必须**行为一致**(不是两套实现)
  assert.equal(NJ.getYaoGanzhi(51, 1).ok, true, '生产表里震的地支是有的, 应装得出');
  assert.equal(NJ.getYaoGanzhi(51, 1).ganzhi, NJ.getYaoGanzhiWithTable(NJ.JINGFANG_DIZHI, 51, 1).ganzhi);
});

test('地支装不出来的爻, 错误码必须是 NO_DIZHI', () => {
  for (const h of HEXAGRAMS) {
    if (NJ.getGuaNajiaCoverage(h.id).loadable) continue;
    let sawNoDizhi = false;
    for (let p = 1; p <= 6; p++) {
      const r = NJ.getYaoGanzhi(h.id, p);
      if (r.ok) continue;
      assert.equal(r.error.code, 'NO_DIZHI',
        h.id + '卦第' + p + '爻应报 NO_DIZHI, 实为 ' + r.error.code);
      sawNoDizhi = true;
    }
    assert.ok(sawNoDizhi, h.id + '卦至少有一爻装不出来');
  }
});

test('★ 八卦地支 8/8 齐全, 且每个卦都标了出处', () => {
  // ⚠️ 第 41 批之前这里是「震巽坎离艮兑 必须是 null」——
  //   现在六卦都有了外部四源交叉验证的出处, 那条断言反了。
  //   但「每个卦都要能说出数据哪来的」这条**没变**, 反而更重要了:
  //   术数数据最容易出的事是「填了但说不出哪来的」。
  for (const k of ['乾', '坤', '震', '巽', '坎', '离', '艮', '兑']) {
    const arr = NJ.JINGFANG_DIZHI[k];
    assert.ok(arr && arr.length === 6, k + '卦的六爻地支应齐全(6 支), 实为: ' + JSON.stringify(arr));
    assert.ok(NJ.DIZHI_SOURCE[k] && NJ.DIZHI_SOURCE[k].length > 10,
      k + '卦的地支必须有出处 —— 数据要能说出是哪来的, 不许只写 null');
  }
});

// ============================================================
// 四、旧 najia 字段的审计
// ============================================================

test('★ 旧 najia 字段: 60 甲子机械循环, 且 8/8 组违反京房必要条件', () => {
  const a = NJ.auditLegacyNajia();
  assert.equal(a.is_60_cycle, true, '旧字段应是 60 甲子按 id 机械循环');
  assert.equal(a.lower_groups, 8, '64 卦的下卦应有 8 组');
  assert.equal(a.jingfang_violations.length, 8,
    '同下卦组内初爻 8/8 组都应不唯一 ⇒ 它结构上不可能是纳甲');
  assert.equal(a.jingfang_necessary_property_holds, false);
});

test('旧 najia 字段的判词要说清「不是纳甲表」', () => {
  assert.equal(NJ.NAJIA_BASIS.legacy_field_is_najia, false);
  assert.equal(NJ.NAJIA_BASIS.legacy_field_kind, 'ganzhi_60_cycle_by_gua_order');
  assert.ok(NJ.NAJIA_BASIS.legacy_field_note.includes('不是纳甲表'));
});

// ============================================================
// 五、负例: 守卫必须会咬人
//   ⚠️ 全部走**子进程 + 临时副本**, 不改共享源文件
//      (2026-10-22 踩过: node --test 多文件并行 + 同文件顶层测试并发,
//       猴补丁会被隔壁文件读到, 一次「单跑绿、全量红」)
// ============================================================

/**
 * 把 najia.js 复制到临时目录, 按需改坏副本, 在子进程里跑 assertNajia,
 * 看守卫抓不抓。副本里的相对 require 换成**绝对路径**指回真仓库,
 * 这样副本是「真数据 + 坏表」, 测的正是守卫。
 *
 * ⚠️ 2026-10-22 第 41 批: najia.js 现在 require 同目录的 `najia_crosscheck.js`,
 *   所以**它也必须一起复制**, 它的两个相对 require(`../hexagrams` /
 *   `./jingfang_bagong`)同样要改写成绝对路径 —— 只复制 najia.js 会得到
 *   `Cannot find module`, 那是**测试自己坏了**, 不是守卫报红(假阴性)。
 */
function runWithBroken(replacements) {
  const { spawnSync } = require('child_process');
  const os = require('os');
  const BAGUA_DIR = path.join(CORE, '64i', 'bagua_annotations');
  // 副本要连同**依赖闭包**一起搬: 只搬入口文件 = 假阴性。
  // 各自把相对 require 钉回真仓库的绝对路径。
  const FILES = [
    ['najia.js', [
      [/path\.join\(__dirname, '\.\.', 'hexagrams\.js'\)/g, path.join(CORE, '64i', 'hexagrams.js')],
      [/path\.join\(__dirname, '\.\.', 'bazi', 'zhis_relations\.js'\)/g, path.join(CORE, '64i', 'bazi', 'zhis_relations.js')],
      [/path\.join\(__dirname, 'najia_crosscheck\.js'\)/g, path.join(BAGUA_DIR, 'najia_crosscheck.js')],
    ]],
    ['najia_crosscheck.js', [
      [/require\('\.\.\/hexagrams'\)/g, JSON.stringify(path.join(CORE, '64i', 'hexagrams.js'))],
      [/require\('\.\/jingfang_bagong'\)/g, JSON.stringify(path.join(BAGUA_DIR, 'jingfang_bagong.js'))],
    ]],
  ];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'najia-neg-'));
  let src = null;
  for (const [fname, rewrites] of FILES) {
    let code = fs.readFileSync(path.join(BAGUA_DIR, fname), 'utf8');
    for (const [re, abs] of rewrites) code = code.replace(re, JSON.stringify(abs));
    if (fname === 'najia.js') {
      for (const [from, to] of replacements) {
        if (!code.includes(from)) {
          throw new Error('负例锚点没命中(源码变了, 负例就空跑了): ' + from);
        }
        code = code.replace(from, to);
      }
      src = code;
    }
    fs.writeFileSync(path.join(tmpDir, fname), code);
  }
  const tmpFile = path.join(tmpDir, 'najia.js');
  const script = `
    const m = require(${JSON.stringify(tmpFile)});
    let threw = false; let msg = '';
    try { m.assertNajia(); } catch (e) { threw = true; msg = String(e.message); }
    process.stdout.write(msg);
    process.exit(threw ? 0 : 3);
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 临时目录, 删不掉也无所谓 */ }
  return { threw: r.status === 0, msg: (r.stdout || '') + (r.stderr || '') };
}

test('负例: 乾卦地支顺序被改坏 → 报出来', () => {
  const r = runWithBroken([
    ["'子', '寅', '辰', '午', '申', '戌'", "'子', '寅', '辰', '申', '午', '戌'"],
  ]);
  assert.equal(r.threw, true, '地支顺序错 = 装卦全错且不报错, 守卫必须咬住: ' + r.msg);
  assert.ok(r.msg.includes('地支'), '报错要说清是地支的问题: ' + r.msg);
});

test('负例: 本该 null 的六卦地支被填上 → 报出来', () => {
  // ⚠️ 第 41 批: 这条负例**意义反转**了 —— 六卦的地支已经补齐(有外部出处),
  //   「被填上」现在是**对的**, 不该报红。
  //   它的真正价值变成: 填了但**与外部来源对不上** ⇒ 必须报红。
  //   这就是"四源交叉验证"这道闸的牙齿: 改八卦表里任一格, 立刻报红。
  const r = runWithBroken([
    ["  震: Object.freeze(['子', '寅', '辰', '午', '申', '戌']),",
      "  震: Object.freeze(['子', '寅', '辰', '午', '申', '巳']),"],
  ]);
  assert.equal(r.threw, true, '改坏八卦地支表, 交叉验证必须咬住: ' + r.msg);
  assert.ok(r.msg.includes('交叉验证'), '报错要指明是四源交叉验证发现的: ' + r.msg);
});

test('负例: 填了地支但没有出处 → 报出来', () => {
  // 「填了但说不出哪来的」是术数数据最常见的病 —— 必须有闸。
  // ⚠️ 锚点必须覆盖**整个多行表达式**(含 `+` 续行): 只替换首行的话,
  //   后面的 `+ '十六字口诀…'` 会变成悬空的加号 ⇒ SyntaxError,
  //   测试红的原因变成「副本语法坏了」而不是「守卫报红」—— 假阴性。
  const r = runWithBroken([
    ["  震: '外部四源交叉验证(第 41 批): 来源A 纳甲图 + 来源B BAGUA_NAZHI + 来源C 64卦装卦 + '\n"
      + "    + '十六字口诀「乾震起子」; 本地文本真源未收录震卦六爻地支',",
    "  震: 'x',"],
  ]);
  assert.equal(r.threw, true, '地支没有出处, 守卫必须咬住: ' + r.msg);
  assert.ok(r.msg.includes('出处'), '报错要说清是缺出处: ' + r.msg);
});

test('负例: 八卦纳甲天干被篡改 → 报出来', () => {
  const r = runWithBroken([
    ["乾: Object.freeze({ inner: '甲', outer: '壬' })",
      "乾: Object.freeze({ inner: '乙', outer: '壬' })"],
  ]);
  assert.equal(r.threw, true, '天干表跟真源不符, 守卫必须咬住: ' + r.msg);
  assert.ok(r.msg.includes('天干'), '报错要说清是天干: ' + r.msg);
});

test('负例: 地支缺口的原因被删掉 → 报出来', () => {
  const r = runWithBroken([
    ["  震: '外部四源交叉验证(第 41 批): 来源A 纳甲图 + 来源B BAGUA_NAZHI + 来源C 64卦装卦 + '\n"
      + "    + '十六字口诀「乾震起子」; 本地文本真源未收录震卦六爻地支',",
    "  震: '',"],
  ]);
  assert.equal(r.threw, true, '地支只写值不写出处, 守卫必须咬住: ' + r.msg);
  assert.ok(r.msg.includes('出处'), '报错要说清缺的是出处: ' + r.msg);
});

test('负例: 旧 najia 字段被换成真纳甲 → 口径标记必须被点名', () => {
  // 反向守卫: 万一哪天有人把真纳甲灌进 hexagrams.js, 口径标记
  // (legacy_field_is_najia: false) 就得跟着改 —— 这条自检就是那个「有人记得」的机制。
  const fake = HEXAGRAMS.map(h => Object.assign({}, h, {
    najia: { tiangan: '甲', dianzhi: '子' },   // 同下卦组内全一样 ⇒ 满足京房必要条件
  }));
  let threw = false; let msg = '';
  try { NJ.assertNajia({ hexagrams: fake }); } catch (e) { threw = true; msg = String(e.message); }
  assert.equal(threw, true, '旧字段一旦满足京房必要条件, 必须报出来要求改口径');
  assert.ok(msg.includes('legacy_field_is_najia'),
    '报错要点名要改的口径字段: ' + msg);
});

// ============================================================
// 六、生产输出: 三处都得说真话
// ============================================================

test('查卦工具: 不再宣称旧 najia 是「六十四卦纳甲表」', async () => {
  const { TOOLS } = require(path.join(CORE, 'modules', 'tools'));
  const r = await TOOLS.hexagram_lookup({ context: {}, params: { query: 2 } });  // 坤
  assert.equal(r.ok, true);
  const d = r.data;
  assert.ok(d.najia_note.includes('不是纳甲表'),
    '口径必须明说旧字段不是纳甲表: ' + d.najia_note);
  assert.ok(!/六十四卦纳甲表/.test(d.najia_note), '不能再叫「六十四卦纳甲表」');
  assert.equal(d.najia._is_najia, false, '数据本身也要带标记 —— 模型可能只看数据不看注');
  assert.equal(d.najia_basis.legacy_field_is_najia, false);
});

test('查卦工具: 坤卦给的是真纳甲六爻(乙未…), 不是机械循环的乙丑', async () => {
  const { TOOLS } = require(path.join(CORE, 'modules', 'tools'));
  const r = await TOOLS.hexagram_lookup({ context: {}, params: { query: 2 } });
  const yao = r.data.yao_ganzhi;
  assert.equal(yao.loadable, true);
  assert.equal(yao.yao[0].ganzhi, '乙未', '坤卦初爻纳甲应是乙未(真源)');
  assert.equal(yao.yao[5].ganzhi, '癸酉');
});

test('查卦工具: 装不出的卦给 null + 原因, 不给编的', async () => {
  // ⚠️ 第 41 批: 八卦纳甲地支补齐后, **64 卦全都装得出** ⇒ 这条断言正过来了。
  //   但「装不出时给 null + 原因, 不给编的」这条性质不能丢 ——
  //   查卦工具的「不给编的」路径由 §三 的注入式负例守着(那才是真牙)。
  //   这里守的是**生产输出**: 64 卦都必须装得出, 且装出的干支要能跟纳甲层对上。
  const { TOOLS } = require(path.join(CORE, 'modules', 'tools'));
  let loadable = 0;
  for (let id = 1; id <= 64; id++) {
    const r = await TOOLS.hexagram_lookup({ context: {}, params: { query: id } });
    const yao = r.data.yao_ganzhi;
    assert.equal(yao.loadable, true,
      id + ' 卦应装得出纳甲(八卦地支已全), 实为 loadable=' + yao.loadable);
    assert.ok(Array.isArray(yao.yao) && yao.yao.length === 6,
      id + ' 卦应给出六爻干支');
    // 抽查: 干支要跟纳甲层一致(不是另一套)
    for (let p = 1; p <= 6; p++) {
      const g = NJ.getYaoGanzhi(id, p);
      assert.equal(yao.yao[p - 1].ganzhi, g.ganzhi,
        id + ' 卦第' + p + '爻: 工具给的与纳甲层不一致');
    }
    loadable++;
  }
  assert.equal(loadable, 64, '应覆盖 64 卦, 实为 ' + loadable);
});

test('事实卡: 坤卦打的是真纳甲乙未, 不是机械循环的乙丑', () => {
  const gate = require(path.join(CORE, 'modules', 'gua_answer_gate.js'));
  const block = gate.buildGuaFactsBlock([{ guaIds: [2] }]);
  assert.ok(block.includes('乙未'), '事实卡应给真纳甲乙未: ' + block.slice(0, 400));
  assert.ok(!block.includes('乙丑'), '事实卡不能还留着机械循环的乙丑');
  assert.ok(block.includes('不是纳甲表'), '事实卡要说明旧字段不是纳甲表');
});

test('skill_runtime: 不再拿 hex.najia 当纳甲', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'skill_runtime.js'), 'utf8');
  assert.ok(!/najia\.tiangan|najia\.dianzhi/.test(src),
    'skill_runtime 不该再从 hex.najia 取天干地支 —— 那是 60 甲子机械循环');
});

test('启动链接了自检 (装时炸, 不是「跑测试才看」)', () => {
  const src = fs.readFileSync(path.join(CORE, 'pangu-single.js'), 'utf8');
  assert.match(src, /assertNajia/,
    'pangu-single.js 启动链里必须有 assertNajia —— 守卫不在启动链上就等于没装');
});

