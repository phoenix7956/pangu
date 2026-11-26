'use strict';
// 同异阴阳分正偏官的守卫 (2026-10-22 第 47 批接线, 2026-10-23 第 49 批改措辞)
//
// 老板 10-22 原话: 「如果再加上阴阳呢? 阳火用阴水可能就克不了, 反而会助火」
//
// 第十批接了「合则不克」(第一档), 后两档一直没接:
//   同阴阳(如庚克甲) → 克成立, 归偏官(七杀)那一路
//   异阴阳(如癸克丙) → 克成立, 归正官那一路
// 后果: 丙火日主遇癸水, 六格结论显示「克我者(水): 有力」——
//   与「丙遇壬(同阴阳那一路)」**完全同等对待**。老板那句话, 盘古只能答对一半。
//
// ⚠️ 本批最重要的一课: **「异阴阳照样克」有原文, 「力度减一分」没原文。**
//   《三命通会》3825 只说「辛克甲, 庚克乙…是阴克阳, 阳克阴…故甲见辛为正官,
//   见庚为偏官」—— 异阴阳**照样克**, 只是分**正偏**。这一层有逐字原文 ⇒ sourced。
//   而「力度」「力足」「力度减一分」这五个字在《三命通会》全文**零命中**
//   ⇒ 那道两档刻度是盘古据「正偏/刚柔」翻出来的 ⇒ interpretive。
//   合成一条 sourced = 拿自己的翻译冒充经典原话。⇒ 必须拆成两条登记。
//
// ⚠️ 第 49 批(10-23)的来由: 上面那条 interpretive **从生产文本里撤了**。
//   实跑(丙火 壬子 癸丑 丙寅 乙卯)发现印出来的是
//     「克我者(水): 有力 → 七杀/正官（癸 异阴阳, 克成立但力度减一分; …）」
//   同一行里, 格级分量的「**有力**」和关系层的「**力度减一分**」用同一个
//   「力」字说反话 —— 模型会把两句读打架; 而且这句话在跟本文件对应的
//   sourced 字段**自己的名字**(只分正官/偏官, 不分强弱)对着干。
//   ⇒ 生产文本改说正偏官名(有逐字原文), 力度刻度退回纯内部编码
//     `force: full|weaken`, 台账里那条 interpretive 不再有 production 块。
//   ⇒ 新守卫: **措辞不许回退** —— 生产文本再冒出「力度/力足」, 出处层报红。
//
// 本文件锁四件事:
//   1. 三档判据本身(含 100 组穷举, 与十神正偏表交叉校验)
//   2. 接线: polarity.keYinYang 挂出来了, 结论文本里**说正偏官给模型听**
//   3. 出处层: 一条 sourced + 一条 interpretive, 刻度不许冒充原文
//   4. 负例: 改坏内核 / 台账 / 措辞, 守卫必须**报红** —— 绿灯是结果, 咬人是证据

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE = path.join(__dirname, '..');
const I64 = path.join(CORE, '64i');
const P = require(path.join(I64, 'provenance.js'));
const WY = require(path.join(I64, 'bagua_annotations', 'wuxing_yinyang.js'));
const WS = require(path.join(I64, 'bagua_annotations', 'wuxing_strength.js'));
const TG = require(path.join(I64, 'bazi', 'ten_gods.js'));
const BS = require(path.join(CORE, 'modules', 'bazi_strength.js'));

const { mutateProvenance, copyTree } = require('./helpers/provenance_mutate');

const GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];

/**
 * 造一份能过 judgeFromChart 的排盘 JSON。
 * (跟 wuxing-he-wiring 那个测试同款 —— 同一份东西不抄第二遍的规矩不适用于
 *  测试夹具, 但这里保持形状一致, 免得两份夹具悄悄漂开。)
 */
function chartOf(dayMaster, dayMasterWuxing, yy) {
  return {
    pillars: { 年柱: '辛未', 月柱: '己亥', 日柱: dayMaster + '酉', 时柱: '甲辰' },
    day_master: dayMaster,
    day_master_wuxing: dayMasterWuxing,
    day_master_yinyang: yy,
    status: '中和',
    xi_yong: ['火'],
    ji_shell: ['木'],
    month_branch: '亥',
    month_benqi: '己',
    wuxing_count: {},
  };
}

/**
 * 造一棵「坏树」, 返回它的 provenance 模块。
 * ⚠️ 变异必须**真进 modules/** —— P12 要从 `64i/../modules/` 读生产层文件。
 *   helper 默认把 modules 做成**软链** ⇒ 改它等于改真树! 所以这里真拷贝。
 */
function mutateWithModules(mutator) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-prov47-'));
  copyTree(path.join(CORE, '64i'), path.join(root, '64i'));
  copyTree(path.join(CORE, 'modules'), path.join(root, 'modules'));
  mutator(root);
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(root)) delete require.cache[k];
  }
  return require(path.join(root, '64i/provenance.js'));
}

// ============================================================
// 1. 判据本身
// ============================================================

test('正例: 三档判据 —— 合则不克 / 同阴阳归偏官 / 异阴阳归正官', () => {
  // 第一档: 合则不克(乙庚)
  const he = WY.judgeKeByYinYang('乙', '庚');
  assert.equal(he.established, false, '乙庚合 ⇒ 合则不克');
  assert.equal(he.force, null, '合的那档不记同异阴阳');

  // 第二档: 同阴阳 ⇒ 归偏官(七杀)(甲阳/庚阳)
  const full = WY.judgeKeByYinYang('甲', '庚');
  assert.equal(full.established, true);
  assert.equal(full.force, 'full');
  assert.equal(full.sameYinYang, true);

  // 第三档: 异阴阳 ⇒ 归正官(甲阳/辛阴)
  const weaken = WY.judgeKeByYinYang('甲', '辛');
  assert.equal(weaken.established, true);
  assert.equal(weaken.force, 'weaken');
  assert.equal(weaken.sameYinYang, false);

  // 第 49 批: 关系层的 reason 只说「成立 + 阴阳关系」, 不带任何力度刻度。
  //   正偏官名**不由这一层给**(本层没有十神表, 硬写就是第二份会漂的抄本),
  //   由 polarity.sameTenGod/diffTenGod 给, 上层照它渲染。
  assert.equal(full.reason, '庚与甲同阳, 克成立');
  assert.equal(weaken.reason, '辛与甲异阴阳, 克仍然成立');
  for (const r of [full, weaken]) {
    assert.ok(r.reason.indexOf('力度') < 0 && r.reason.indexOf('力足') < 0,
      '关系层不许说力度: ' + r.reason);
  }
});

test('正例: 100 组穷举 —— 与十神正偏表交叉校验, 零不一致', () => {
  // 交叉校验的意思: `judgeKeByYinYang` 用的是「阴阳表 + 生克表」,
  //   `getTenGod` 用的是**另一条路**(十神推导表)。两条路撞到同一个真相
  //   才算数 —— 同一条路自证不成立。
  //
  // 十神的老规矩: 正 = 异性, 偏/七 = 同性。
  //   ⇒ 克边上: 同阴阳 ⇒ 七杀(偏官); 异阴阳 ⇒ 正官。
  //   五合那五对是例外 —— 合则不克优先于正官/七杀。
  let ke = 0, he = 0, nonKe = 0;
  for (const s of GAN) {
    for (const o of GAN) {
      const j = WY.judgeKeByYinYang(s, o);
      if (s === o) {
        assert.equal(j, null, s + '对自己不该有判据');
        continue;
      }
      if (TG.KE[TG.WUXING[o]] !== TG.WUXING[s]) {
        nonKe++;
        assert.equal(j, null, s + '对' + o + '不是克关系, 不该有判据');
        continue;
      }
      const same = TG.YIN_YANG[s] === TG.YIN_YANG[o];
      if (WY.getHe(s, o)) {
        he++;
        assert.equal(j.established, false, s + '与' + o + '相合 ⇒ 合则不克');
        assert.equal(j.force, null);
        continue;
      }
      ke++;
      assert.equal(j.established, true, s + '对' + o + '的克必须成立');
      assert.equal(j.sameYinYang, same);
      assert.equal(j.force, same ? 'full' : 'weaken',
        s + '对' + o + '的同异阴阳档错了');
      const tg = TG.getTenGod(s, o);
      assert.equal(tg, same ? '七杀' : '正官',
        s + '对' + o + '的十神与同异阴阳档对不上(两套编码必须指向同一个真相)');
    }
  }
  assert.ok(ke > 0 && he > 0 && nonKe > 0, '三种情形都要被走到, 否则这条测试是空转');
});

// ============================================================
// 2. 接线
// ============================================================

test('接线: judgeRelation 的 polarity 带上 keYinYang', () => {
  const r = WS.judgeRelation('火', '水', { counts: { 火: 2, 水: 2 }, selfGan: '丙' });
  assert.ok(Array.isArray(r.polarity.keYinYang), 'keYinYang 必须是数组');
  const byGan = {};
  for (const x of r.polarity.keYinYang) byGan[x.gan] = x;
  assert.ok(byGan['壬'], '壬(丙阳壬阳)应该在列表里');
  assert.equal(byGan['壬'].force, 'full', '丙壬同阴阳 ⇒ 偏官那一路');
  assert.ok(byGan['癸'], '癸(丙阳癸阴)应该在列表里');
  assert.equal(byGan['癸'].force, 'weaken', '丙癸异阴阳 ⇒ 正官那一路');

  // 第 49 批: 正偏官名由十神表挂在 polarity 上, 渲染层照它说话 ——
  //   渲染层自己一个字都不另抄(抄一份就是两份漂)。
  assert.equal(r.polarity.sameTenGod, '七杀', '同阴阳 ⇒ 偏官(七杀)');
  assert.equal(r.polarity.diffTenGod, '正官', '异阴阳 ⇒ 正官');
});

test('接线: 同一个「克我者(水)」格, 丁主与丙主的读法必须不同', () => {
  // 这是本批接线的**全部意义**: 旺衰层分不出来的, 阴阳层要分出来。
  const ding = WS.judgeRelation('火', '水', { counts: { 火: 2, 水: 2 }, selfGan: '丁' });
  const bing = WS.judgeRelation('火', '水', { counts: { 火: 2, 水: 2 }, selfGan: '丙' });
  assert.equal(ding.relation, bing.relation, '五行层关系一样(都是克我)');
  assert.equal(ding.strength, bing.strength, '旺衰层强度一样(分量相同)');
  assert.notDeepStrictEqual(ding.polarity.keYinYang, bing.polarity.keYinYang,
    '阴阳层必须给出不同的结论 —— 否则这层白接');
});

test('接线: 结论文本里要说正偏官, 不许说力度刻度', () => {
  const text = BS.formatConclusion(BS.judgeFromChart(chartOf('丙', '火', '阳')));
  assert.match(text, /异阴阳, 克成立, 为正官/, '异阴阳那一路必须说正官给模型听');
  assert.match(text, /同阴阳, 克成立, 为七杀/, '同阴阳那一路必须说七杀给模型听');
  // ⚠️ 同一个「力」字不许在一行里说反话: 格级「无力/有力」是**分量**,
  //   关系层若还说「力度/力足」, 模型会把两句读打架(第 49 批实跑踩到)。
  assert.ok(text.indexOf('力度') < 0, '结论文本里不该再有「力度」');
  assert.ok(text.indexOf('力足') < 0, '结论文本里不该再有「力足」');
});

test('接线: formatJudgement 说的话与 formatConclusion 一致(共用一个措辞函数)', () => {
  const text = BS.formatJudgement(BS.judgeFromChart(chartOf('丙', '火', '阳')));
  assert.match(text, /异阴阳, 克成立, 为正官/);
  assert.match(text, /同阴阳, 克成立, 为七杀/);
  assert.ok(text.indexOf('力度') < 0 && text.indexOf('力足') < 0,
    '两个渲染点都不该说力度');
});

test('纯增量: strength / relation 一个取值都没被改', () => {
  // 力度分档是**挂在旁边的新信息**, 不许改动旺衰判据本身。
  const r = WS.judgeRelation('火', '水', { counts: { 火: 2, 水: 2 }, selfGan: '丙' });
  assert.equal(r.relation, 'ke', '丙火看水 = 克我者');
  assert.equal(r.strength, 'weak', '水有 2 个 → weak (阈值 3 以上才是 strong)');
});

test('★ 正例: 该五行不在盘里 ⇒ 不印关系层的注(别跟「不成立」打架)', () => {
  // 实跑取证(戊土日主 庚午 癸未 戊子 己未, 盘里一个木都没有):
  //   改之前: 「克我者(木): 不成立 → 七杀/正官(乙 异阴阳, 克成立但力度减一分;
  //            甲 同阴阳, 克成立且力足)」
  //   这一格自己写着「**不成立**」, 括号里却说「**克成立**」—— 自相矛盾,
  //   模型读到会得出「克我者(木)克成立」, 直接跟格级结论打架。
  //
  // 根因: `polarity` 说的是**关系规则**(假如这一格有东西, 它怎么克我),
  //   格级强度说的是**本盘分量**(这一格有没有东西)。两件事。
  const noWood = {
    pillars: { 年柱: '庚午', 月柱: '癸未', 日柱: '戊子', 时柱: '己未' },
    day_master: '戊', day_master_wuxing: '土', day_master_yinyang: '阳',
    status: '中和', xi_yong: ['土', '木'], ji_shell: ['土'],
    month_branch: '未', month_benqi: '己', wuxing_count: {},
  };
  const j = BS.judgeFromChart(noWood);
  assert.equal(j.counts['木'], 0, '这个盘里确实没有木');
  assert.equal(j.cells['木'].strength, 'not_established');

  const text = BS.formatConclusion(j);
  assert.match(text, /克我者\(木\): 不成立/, '木格必须出现');
  // ⚠️ 按**那一行**断, 不按全文断 —— 别的格(比如水格)本来就该有合注,
  //   全文断会把正确的注一起误判掉。
  const woodLine = text.split('\n').find((l) => l.indexOf('克我者(木)') >= 0) || '';
  assert.doesNotMatch(woodLine, /克成立/, '木不在盘里 ⇒ 不该印正偏官那一注(那是假设)');
  assert.doesNotMatch(woodLine, /与日主相合/, '木不在盘里 ⇒ 不该印合注(那是假设)');
  // 别的格照常印(这道门只关「不在盘里」的那格)
  assert.match(text, /癸 与日主相合, 不受我克/, '水在盘里 ⇒ 合注照常印');
});

test('★ 正例: 该五行在盘里 ⇒ 正偏官那一注照常印出来', () => {
  // 丁火日主, 盘里有亥(水) ⇒ 水格在, 正偏官那一注与合注都该印。
  // 这一对是第 49 批最该看的: 壬(阳水)与丁(阴火)异阴阳 ⇒ 归正官,
  //   但它俩正好是五合(丁壬合) ⇒ 合则不克, 所以这一注里只剩癸(同阴阳 ⇒ 七杀)。
  const withWater = {
    pillars: { 年柱: '辛未', 月柱: '己亥', 日柱: '丁酉', 时柱: '甲辰' },
    day_master: '丁', day_master_wuxing: '火', day_master_yinyang: '阴',
    status: '中和', xi_yong: ['火'], ji_shell: ['木'],
    month_branch: '亥', month_benqi: '己', wuxing_count: {},
  };
  const j = BS.judgeFromChart(withWater);
  assert.ok(j.counts['水'] > 0, '这个盘里有水');
  const text = BS.formatConclusion(j);
  assert.match(text, /壬 与日主相合, 不参与克我/, '丁壬合 ⇒ 壬被合住');
  assert.match(text, /癸 同阴阳, 克成立, 为七杀/, '丁癸同阴阳 ⇒ 偏官(七杀)');
  assert.doesNotMatch(text, /克成立, 为正官/, '壬被合住 ⇒ 不该说它「克成立」');
});

test('措辞函数: 已导出、是函数、且**只定义一处**(两个渲染点共用)', () => {
  // 第 49 批把标签常量撤了(生产文本全改成有原文的正偏官说法, 没有身份要标),
  //   换来一个更要紧的东西: 两个渲染点**共用一个措辞函数**。
  //   原来两处各拼各的措辞(一处说「克仍成立但力度减一分」, 一处说「克成立但力度减一分」)
  //   —— 已经是两处漂了, 只是当时没人比过。
  assert.equal(typeof BS.keYinYangNoteText, 'function', 'keYinYangNoteText 必须导出');
  assert.equal(BS.keYinYangNoteText(null), null, '没有 polarity ⇒ 没有那一注');
  assert.equal(BS.keYinYangNoteText({}), null, 'polarity 里没有内容 ⇒ 没有那一注');

  const src = fs.readFileSync(path.join(CORE, 'modules', 'bazi_strength.js'), 'utf8');
  const defs = src.split('function keYinYangNoteText(').length - 1;
  assert.equal(defs, 1, 'keYinYangNoteText 定义了 ' + defs + ' 次, 应该只有 1 次');
  const calls = src.split('keYinYangNoteText(').length - 1;
  // 1 次定义 + 2 个渲染点各 1 次调用 = 3
  assert.equal(calls, 3, 'keYinYangNoteText 出现 ' + calls + ' 次(1 定义 + 2 调用)');
});

// ============================================================
// 3. 出处层
// ============================================================

test('出处层: 「异阴阳照样克」登记成 sourced, 且引文是逐字的', () => {
  const layer = P.LAYERS['bagua_annotations:wuxing_yinyang'];
  const f = layer.fields.find((x) => x.status === 'sourced' && x.source === 'smt_ke_yinyang_force');
  assert.ok(f, '缺 smt_ke_yinyang_force 这条 sourced 登记');
  assert.ok(Array.isArray(f.claims) && f.claims.length >= 2, '至少两条 claim');
  // 引文必须真在切片里 —— 守卫 P3 自己也会查, 这里再钉一层是防「守卫被改弱了」。
  const body = P.normalize(P.readSourceBody('smt_ke_yinyang_force'));
  for (const c of f.claims) {
    assert.ok(body.indexOf(P.normalize(c.quote)) >= 0,
      '引文不在切片里: ' + c.quote.slice(0, 30));
  }
});

test('★ 出处层: 力度刻度必须登记成 interpretive, 不许冒充 sourced', () => {
  // 这条是本批的核心修正。上一版差点把「三档力度」整体登成 sourced ——
  // 那等于拿盘古自己的翻译当《三命通会》原话, 模型会照着经典讲出去。
  // 第 49 批追加: 它还得**没有 production 块** —— 已经不进生产文本的东西,
  //   标「生产层身份」是给自己加戏。
  const layer = P.LAYERS['bagua_annotations:wuxing_yinyang'];
  const f = layer.fields.find((x) => x.field.indexOf('力度') >= 0);
  assert.ok(f, '缺「力度三档」这条登记');
  assert.equal(f.status, 'interpretive',
    '力度刻度必须 interpretive —— 典籍无「力度」字样');
  assert.ok(f.basis && f.basis.length > 0, 'interpretive 必须写 basis(P4)');
  assert.ok(f.reason && f.reason.length > 0, 'interpretive 必须写 reason(P4)');
  assert.ok(f.reason.indexOf('力度') >= 0,
    'reason 必须明说「力度」这两个字是盘古翻出来的');
  assert.equal(f.source, undefined,
    'interpretive 字段不该挂 source —— 挂了就是拿原文冒充');
  assert.equal(f.production, undefined,
    '力度刻度已经不进生产文本 ⇒ 不该再有 production 块');
});

test('出处层: 「说正偏官 + 不说力度」这条已登记成 sourced claim', () => {
  // 第 49 批: 生产探针挂在**有原文的那条**上(引文「官喜正，不喜偏」)。
  //   措辞不是引文, claim 钉不住措辞 —— 所以这条 claim 的钉法是
  //   `live` 探针去**读渲染出来的那一行**, 钉「为正官/为七杀在, 力度不在」。
  const layer = P.LAYERS['bagua_annotations:wuxing_yinyang'];
  const f = layer.fields.find((x) => x.field.indexOf('正官/偏官') >= 0);
  assert.ok(f, '缺「只分正官/偏官」这条 sourced 登记');
  const c = f.claims.find((x) => x.quote.indexOf('官喜正') >= 0);
  assert.ok(c, '缺「官喜正，不喜偏」这条 claim');
  assert.equal(typeof c.live, 'function', '这条 claim 必须带 live 探针');
  assert.equal(c.live(), true,
    '生产文本没在说正偏官, 或者又开始说力度了');
});

test('出处层: 整棵树自检绿(问题数 0)', () => {
  const s = P.provenanceSummary();
  assert.ok(s.ok, '出处层自检有红:\n' + s.problems.join('\n'));
  // 2026-11-26: 开源导出树 (有 .pangu-open-source 标记) 课程/消化件切片被剥离,
  //   对应的 claim 在 provenance.js 里显式跳过 ⇒ claimsChecked < claims 是预期行为。
  //   私有树里切片齐全, claimsChecked 必须等于 claims, 一条都不能少。
  const isOpenSource = fs.existsSync(
    path.resolve(__dirname, '..', '64i', '.pangu-open-source'));
  if (!isOpenSource) {
    assert.ok(s.claimsChecked === s.claims,
      '有 claim 没被真正核过: ' + s.claimsChecked + '/' + s.claims);
  }
});

test('切片: --check 必须全绿(切片与原文一致)', () => {
  // ⚠️ 原文在仓库外(/Users/you/Desktop/course-source/…), 不在时**跳过**而不是失败 ——
//   仓库自身零外部依赖是硬约束, 64i 只带切片。
  //   原文路径由 PANGU_CORPUS_ROOT 指向 —— 仓里不写任何人的本机绝对路径。
  const corpusRoot = (process.env.PANGU_CORPUS_ROOT || '').trim();
  const origin = corpusRoot
    ? path.join(corpusRoot, '易经', 'extracted', '三命通会.txt')
    : null;
  const slice = path.join(I64, 'sources', 'smt_ke_yinyang_force.txt');
  assert.ok(fs.existsSync(slice), '切片必须在仓库里');
  if (!origin || !fs.existsSync(origin)) return;   // 原文不在 ⇒ 跳过对账, 切片在位已验过
  process.env.PANGU_CORPUS_ROOT = corpusRoot;
  execFileSync(process.execPath,
    [path.join(CORE, 'scripts', 'extract_provenance_sources.js'), '--check'],
    { cwd: CORE, encoding: 'utf-8' });
});

test('启动自检: 身份标签清单从台账**算**出来, 不许手写', () => {
  // 手写的清单跟台账各走各的: 加了字段忘了改日志, 日志就撒谎。
  // 第 47 批真踩到 —— 5 个字段, 日志里还写着 4 个名字。
  const s = P.provenanceSummary();
  assert.equal(s.productionMarkedMarkers.length, s.productionMarked,
    '标记个数跟字段个数对不上');
  // 第 49 批: 力度刻度撤出生产文本 ⇒ 清单里**不该再有**它(现在 4 个)。
  assert.ok(!s.productionMarkedMarkers.some((m) => m.indexOf('异阴阳力度分档') >= 0),
    '力度刻度已经不进生产文本, 不该还挂在生产层身份清单里');
  // 第 55 批: 体用吉凶分级/百分比(课件量化)新增身份标签 TIYONG_GRADE_TAG ⇒ 4 → 5。
  //   第 56 批: 爻值老少动静(本地典籍无逐字出处)新增身份标签 YAO_VALUE_TAG ⇒ 5 → 6。
  //   第 58 批: 分层编排(「什么时候用哪层」是盘古自己的编排设计, 不是典籍断语)
  //     新增身份标签 LAYER_PLAN_TAG ⇒ 6 → 7。
  //   第 66 批: 纳甲搭桥(「卦接干支」这个组合是盘古的编排设计, 判据本身逐段有源)
  //     新增身份标签 BRIDGE_TAG ⇒ 7 → 8。
  //     ⚠️ 这个标签**真进生产**: 桥块渲染在 modules/najia_bridge.js:renderBridgeBlock,
  //     随 gua_cast 的 tool_result 一起给模型 ⇒ 模型看得见 ⇒ 必须标身份。
  //   第 69 批: 风水层接进生产 —— 三个 interpretive 字段(宅卦=坐山/四吉四凶分组/
//     其余八运的年份)各加一个 production 块 ⇒ 8 → 11;
//     再加「风水整层的身份」那一条 ⇒ 11 → 12。
  //   第 70 批: 大象辞(象曰)首次入库 —— 它是**第三类**身份(是原文, 但三方对账裁决过),
  //     单独一个标签 XIANG_CI_TAG ⇒ 12 → 13。
  //     ⚠️ 注意它跟象义(XIANG_YI_TAG)/卦码(GUACODE_TAG)不是同一类:
  //     那两个是「**不是**原文」, 大象辞是「**是**原文但经裁决」——
  //     混用会让模型把裁决出来的读法当成唯一通行的读法。
  //   这是**按设计**长出来的计数, 不是回归 —— 新增生产层身份标签就该 +1。
  assert.equal(s.productionMarked, 13, '生产层身份字段数变了就改这里(现在是 13 个)');

  const src = fs.readFileSync(path.join(CORE, 'pangu-single.js'), 'utf8');
  // ⚠️ 这里守的是「清单**不许手写**」, 不是「必须用哪个变量名」——
  //   第 69 批把清单改成去重后打(共用标签会被打好几遍), 表达式就变了。
  //   ⇒ 断言改成守**来源**: 必须从台账算出来的那个数组派生, 不许出现字面量清单。
  assert.ok(src.indexOf('pv.productionMarkedMarkers') >= 0,
    '启动日志必须用从台账算出来的清单, 不许手写名字列表');
  // 第 69 批: 同一个标签可以被多个字段共用 ⇒ 日志里的清单要去重,
  //   否则同一个标签打三遍, 看着像三个不同的标签(而实际只有一个)。
  assert.ok(src.indexOf('new Set(pv.productionMarkedMarkers)') >= 0,
    '启动日志的标签清单必须去重 —— 共用标签会被打好几遍, 看着像好几个不同的标签');
});

// ============================================================
// 4. 负例 —— 绿灯是结果, 咬人是证据
// ============================================================

test('★ 负例: 把内核的 force 判据全部对调 → 出处层必须报红', () => {
  // 改的是**内核**(wuxing_yinyang.js), 不是台账。
  // 守卫的 live 探针直接读内核 ⇒ 内核一坏, 探针立刻对不上。
  // 报红要报在对的地方: 「模块活数据与引文不符」。
  const P2 = mutateProvenance(CORE, '47a', (tmp) => {
    const f = path.join(tmp, 'bagua_annotations', 'wuxing_yinyang.js');
    const s2 = fs.readFileSync(f, 'utf8');
    const out = s2.replace(
      "force: sameYinYang ? 'full' : 'weaken',",
      "force: sameYinYang ? 'weaken' : 'full',"
    );
    assert.notEqual(out, s2, '变异没生效 —— 锚点跟当前源码对不上, 这条负例已经假绿');
    fs.writeFileSync(f, out, 'utf8');
  });
  const r = P2.provenanceSummary();
  assert.ok(!r.ok, '内核的力度判据全反了还全绿 —— 守卫是恒真的');
  assert.ok(r.problems.some((p) => p.includes('模块活数据与引文不符')),
    '没报「模块活数据与引文不符」:\n' + r.problems.join('\n'));
});

test('★ 负例: 出处层把力度刻度改成 sourced(冒充原文) → 必须报红', () => {
  // 把 interpretive 那条改成 sourced: 它没有 claims ⇒ 守卫 P3 会报
  // 「sourced 但没有 claims」。这就是「不许拿自己的翻译当原文」的机制。
  const P2 = mutateProvenance(CORE, '47b', (tmp) => {
    const f = path.join(tmp, 'provenance.js');
    const s2 = fs.readFileSync(f, 'utf8');
    const out = s2.replace(
      "      { field: '克边力度三档(full/weaken)的刻度(仅内部编码, 第 49 批起不进生产文本)',\n        status: 'interpretive',",
      "      { field: '克边力度三档(full/weaken)的刻度(仅内部编码, 第 49 批起不进生产文本)',\n        status: 'sourced',"
    );
    assert.notEqual(out, s2, '变异没生效 —— 锚点跟当前源码对不上, 这条负例已经假绿');
    fs.writeFileSync(f, out, 'utf8');
  });
  const r = P2.provenanceSummary();
  assert.ok(!r.ok, 'interpretive 改成 sourced 还全绿 —— 守卫是恒真的');
  assert.ok(r.problems.some((p) => p.includes('sourced') && p.includes('没有 claims')),
    '没报「sourced 但没有 claims」:\n' + r.problems.join('\n'));
});

test('★ 负例: 生产文本把措辞改回「力度减一分」→ 出处层必须报红', () => {
  // 第 49 批新增的守卫。改的是**真拷贝**的 modules/ 生产层, 不许改到真树上。
  // 这条盯的不是引文(引文钉不住措辞), 是「模型实际读到的那一行」。
  // 探针挂在 sourced 那条 claim 上, 所以生产文本一退回自创刻度就报红。
  const P2 = mutateWithModules((root) => {
    const f = path.join(root, 'modules', 'bazi_strength.js');
    const s2 = fs.readFileSync(f, 'utf8');
    const out = s2
      .split("+ ' 异阴阳, 克成立, 为'")
      .join("+ ' 异阴阳, 克成立但力度减一分, 为'");
    assert.notEqual(out, s2, '变异没生效');
    fs.writeFileSync(f, out, 'utf8');
  });
  const r = P2.provenanceSummary();
  assert.ok(!r.ok, '生产文本退回「力度减一分」还全绿 —— 守卫是恒真的');
  assert.ok(r.problems.some((p) => p.includes('模块活数据与引文不符')),
    '没报「模块活数据与引文不符」:\n' + r.problems.join('\n'));
});

