'use strict';
// 2026-10-21 第七批「事实核验再加两把 factual 小刀」的守卫。
//
// 起因是第六批 E2E 实跑里同一份答案里的两处**查表就能定死**的东西, 闸门全放过了:
//   ① "喜用：土、木" 后面又写 "忌：土" —— 同一元素同时在喜用和忌的名单里,
//      这是文本内部自相矛盾, 不需要任何术数判断就能判。
//   ② "土 4（强）/ 水 2 / 木 0" 这种五行数量断言 —— 数字是四柱干支各算一次的可查量,
//      对不上就是硬伤, 而原来**根本没人查**。
//
// 同时本文件锁一条**否定判据**: 刻意不查"喜用某五行"本身对不对。
//   子平常用神恰恰可以是盘里没有的五行 (调候/补缺), 把"喜木"当错来判 =
//   把真结论判死 —— grounding_check 立时就写下的规矩, 这里照抄。
const DET = require('../modules/bazi_chart_facts');
const CF = require('../modules/chart_fidelity');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.log('  ❌ ' + name + '  →  ' + e.message); fail++; }
}
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ', 实得 ' + JSON.stringify(a)); }
function ok(v, msg) { if (!v) throw new Error(msg || '断言失败'); }

// 1990-7-22 14:00 女 → sxtwl 实排 庚午 癸未 戊子 己未
// 计数(天干五行+地支五行, 四柱都算): 庚金 午火 | 癸水 未土 | 戊土 子水 | 己土 未土
//   → 木0 火1 土4 金1 水2
const P = ['庚午', '癸未', '戊子', '己未'];
const count = (text) => DET.findChartContradictions(text, P);

console.log('\n--- 计数基准只有一份 (不许两处各数一遍) ---');
t('事实块里的五行计数 = 查表基准的计数', () => {
  const line = (DET.buildFactsBlock(P).match(/五行计数[^:]*: (.+)/) || [])[1] || '';
  ok(/木0/.test(line), '事实块五行计数: ' + line);
  ok(/土4/.test(line) && /水2/.test(line), '事实块五行计数: ' + line);
  // 基准本身: 拿一个错数字去核, 期望值必须就是事实块里的那个数
  const r = count('土 1 个');
  eq(r.length, 1);
  eq(r[0].expect.indexOf('土实际 4 个') === 0, true, '核验基准与事实块不是同一个数: ' + r[0].expect);
});
t('buildFactsBlock 的标签不再把地支五行说成"支本气" (数字会照抄标签的理解)', () => {
  ok(/五行计数\(天干五行\+地支五行\)/.test(DET.buildFactsBlock(P)), DET.buildFactsBlock(P).split('\n')[3]);
});

console.log('\n--- ⑧ 五行数量断言 ---');
t('计数写错 → 抓到 (土 3 / 水 5)', () => {
  const r = count('五行: 土 3（强）, 水 5（弱）, 火 1, 金 1, 木 0。');
  eq(r.length, 2, JSON.stringify(r));
  ok(r.some(x => /土实际 4 个/.test(x.expect)));
  ok(r.some(x => /水实际 2 个/.test(x.expect)));
});
t('计数写对 → 不报 (E2E 原句的写法)', () => {
  eq(count('土 4（强）— 己、己、未、未，水 2（弱），火 1，金 1，木 0（不成立）。').length, 0);
  eq(count('木0 火1 土4 金1 水2').length, 0);
});
t('大运/流年里的计数不是原局 → 让路', () => {
  eq(count('大运走庚辰, 金 1 个; 流年丙午, 火 1 个。').length, 0);
  eq(count('2026 丙午年, 火 2 个。').length, 0);
});

console.log('\n--- ⑨ 喜用/忌 自相矛盾 ---');
t('同一个元素既在喜用又在忌 → 抓到 (E2E 实跑原句)', () => {
  const r = count('喜用：土、木。忌：土。');
  eq(r.length, 1, JSON.stringify(r));
  ok(/喜用与忌都列了土/.test(r[0].claim), JSON.stringify(r));
});
t('喜忌不重叠 → 不报', () => {
  eq(count('喜用：木、水。忌：土、金。').length, 0);
  eq(count('喜用: 木、水; 忌神: 土。').length, 0);
  eq(count('只说忌不说喜: 忌：土。').length, 0, '单边陈述不是矛盾');
});
t('大运语境里的喜忌不是本命盘的喜忌 → 让路', () => {
  eq(count('大运走癸丑, 忌：土。喜用：水。').length, 0);
});
t('刻意不查"喜用某五行"本身 (子平常用神可以是盘里没有的五行)', () => {
  // 木=0 是查表真值, 但"喜用木"在子平里完全正常 (补缺/调候) —— 判它错就是判死真结论
  eq(count('喜用：木。忌：土。').length, 0, '不能因为木=0 就说喜木是错的');
  eq(count('喜用：木。忌：木。').length, 1, '但同时列两边仍然是矛盾');
});

console.log('\n--- 拿真实答案量出来的三个坑 (每个都先红过) ---');
t('① sentenceBefore 必须取**最后一个**句边界 (第一版取了第一个)', () => {
  // 第一版用 search() 从最早的句号开始截, 于是"逆排大运，起运4岁11月。"那句的"大运"
  // 留在了下一句的上下文里 → 本命盘的计数断言被当成大运语境放过。
  // 真实实跑原句就是这个形状 (E2E 2026-10-21 第七批):
  const s = '日主 **戊土（阳）**，女命，逆排大运，起运4岁11月。\n\n**五行力量分布**\n土 4.5（强）｜木 1（乙藏于两未，弱）';
  ok(!/大运/.test(DET.sentenceBefore(s, s.indexOf('木 1'))), '这一句的上文不该再带大运: ' + DET.sentenceBefore(s, s.indexOf('木 1')));
  eq(DET.nonNativeContext(s, s.indexOf('土 4.5')), false, '本命盘计数不该被上一句的大运连累');
  eq(count(s).filter(x => /实际/.test(x.expect)).length, 0, 's 这一行是藏干口径, 本来也不该报');
});
t('② 藏干口径的计数让路 ("木 1（乙藏于两未）" 不是事实块那把尺)', () => {
  eq(count('土 4.5（强，得月令未土）｜木 1（乙藏于两未，弱）｜火 1.5（丁火藏于午未，弱）').length, 0);
  eq(count('土 3 个').length, 1, '整数口径照查不误');
});
t('③ 喜/忌标签必须互斥归类 (第一版跑两趟, 忌那趟把喜用的窗口也收了)', () => {
  // 守卫自己造矛盾比不查更坏: 这两种写法都含 "喜用…忌", 但并不矛盾
  eq(count('喜用：木、水。忌：土。').length, 0, JSON.stringify(count('喜用：木、水。忌：土。')));
  eq(count('喜用：木（疏土）。忌：土。').length, 0, '括注里的"疏土"不算喜用土');
  eq(count('喜用：木、水。忌：土、水。').length, 1, '真重叠才报');
});
t('④ markdown 加粗 + "为" 连接词 (E2E 实跑原话)', () => {
  const s = '喜用：**土（扶身）、木（疏土、通官）**；工具另标忌神为**土**（原局已土重）。';
  const r = count(s);
  eq(r.length, 1, '只该报土, 不该报木: ' + JSON.stringify(r));
  ok(/喜用与忌都列了土/.test(r[0].claim));
});
t('⑤ 逗号分隔的同句写法不误报 (E2E 实跑原话)', () => {
  eq(count('宜食神生财路线，喜金水，忌再见土（比劫夺财）。').length, 0);
});
t('⑥ 合婚/双人对比: 两个人的喜忌分处不同块, 不是矛盾', () => {
  const two = [
    '**男方**',
    '- 喜用：木、水。忌：火。',
    '',
    '**女方**',
    '- 喜用：火、金。忌：木。',
  ].join('\n');
  eq(count(two).length, 0, '全局比对会把两个人的名单对撞: ' + JSON.stringify(count(two)));
  const same = ['**取用**', '- 喜用：木。', '- 忌：木。'].join('\n');
  eq(count(same).length, 1, '同一块里还判得出来: ' + JSON.stringify(count(same)));
});

console.log('\n--- 两份真实答案原文重放 (不是夹具, 是盘古真出过门的答案) ---');
t('b6 实跑答案 → 只报土那一条', () => {
  // /tmp/e2e-b6-1b.sse 第六批实跑原文摘录 (一字未改)
  const real = [
    '**五行分布（工具判定）**',
    '- 喜用：土、木',
    '- 忌：土',
    '- 忌过多黏土陶艺类；',
    '- 忌神列土但日主中和，木为首用，取名/择业皆可往木气行业走。',
    '大运（逆排，4岁11月起运）：壬午(4)→辛巳(15)→庚辰(25)。',
  ].join('\n');
  const r = count(real);
  eq(r.length, 1, '只该报土, 多一条都是误伤: ' + JSON.stringify(r));
  ok(/喜用与忌都列了土/.test(r[0].claim));
});
t('b7 实跑答案 → 只报土那一条 (加粗 + "为" 连接词)', () => {
  // /tmp/e2e-b7-1.sse 第七批实跑原文摘录 (一字未改)
  const real = [
    '**五行力量分布**',
    '土 4.5（强，得月令未土）｜木 1（乙藏于两未，弱）｜火 1.5｜金 1｜水 1.5',
    '- 喜用：**土（扶身）、木（疏土、通官）**；工具另标忌神为**土**（原局已土重，再补则壅滞）。',
    '当前行己卯运：卯为乙木正官，疏土有力，喜；2026丙午偏印流年火旺生土，注意火土过燥。',
  ].join('\n');
  const r = count(real);
  eq(r.length, 1, JSON.stringify(r));
  ok(/喜用与忌都列了土/.test(r[0].claim));
});

console.log('\n--- ⑦ 第七批 E2E 真出过门的答案 (带 ⚠️ 尾注那版) ---');
t('流年干支两神写法不误伤 ("2026丙午（偏印、正印）" 两个都是对的)', () => {
  // 实跑原句: 丙=偏印 (流年干对戊日主), 午=正印 (午本气丁)。我的 ⑥ 只认"支（支本气神）",
  // 于是把括号里那个**天干**的十神拿去跟支本气比 → 一次实跑误伤 4 条, 白花一次重修,
  // 还在本来正确的答案尾巴上挂了 ⚠️。
  const real = '**当前流年**：2026丙午（偏印、正印）——火土并旺；2027丁未（正印、劫财）、2029己酉（劫财、伤官）；**2028戊申（比肩）**有夺财倾向。';
  eq(count(real).length, 0, JSON.stringify(count(real)));
});
t('原局支本气该判的仍然判 (不是把 ⑥ 关掉了)', () => {
  eq(count('年支午（正印）, 月支未（劫财）').length, 0);
  eq(count('年支午（偏印）').length, 1, JSON.stringify(count('年支午（偏印）')));
});
t('b7c 实跑答案 (去掉 ⚠️ 尾注) → 零硬伤', () => {
  // /tmp/e2e-b7c-1.sse 原样摘录, 尾注是闸门自己加的, 不属于答案内容
  const real = [
    '## 三、喜用神与忌神',
    '- **喜用：木、水、金**',
    '- **忌神：土**',
    '同一份判断中不把土同时列为喜用与忌神；土已过重，继续增土不利。',
    '- **行运印证**：2014—2024庚辰大运，辰为水土库，仍是土旺之运；2024起入**己卯大运**，卯木正官临运、疏土有力。',
    '- **当前流年**：2026丙午（偏印、正印）——火土并旺，土再增一分，仍偏耗；2027丁未（正印、劫财）、2029己酉（劫财、伤官）亦需留意；**2028戊申（比肩）有夺财倾向**。',
  ].join('\n');
  eq(count(real).length, 0, JSON.stringify(count(real)));
});

console.log('\n--- 上一批那个"三会洞"是我判错了 (纠记录) ---');
t('巳午未半会火局（年月）—— 与 64i 算法一致, 不该报', () => {
  // zhis_relations.analyzePillars: 巳午未 里只到 午/未 两个 → hits=2 → partial:true, at=[0,1]
  // 答案写 "半会火局（年月）" 跟它**逐字一致**, 我上一批把它当成"盘里没有巳"的错误, 判错了。
  const rel = require('../64i/bazi/zhis_relations');
  const r = rel.analyzePillars(P);
  const hui = r.san_hui.find(x => x.partial);
  ok(hui && hui.trio.join('') === '巳午未' && hui.element === '火' && hui.at.join(',') === '0,1',
    '前提变了: ' + JSON.stringify(hui));
  eq(count('地支关系：午未六合（年月）；子未相害（月日、日时）；巳午未半会火局（年月）。').length, 0);
});

console.log('\n--- 上下文判据只有一份 (不许两处各写一个窗口) ---');
t('chart_fidelity 复用断言模块的 sentenceBefore / 非本命盘词表', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'modules', 'chart_fidelity.js'), 'utf8');
  ok(!/const NON_PILLAR_CTX_RE/.test(src), 'chart_fidelity 又自己抄了一份词表');
  ok(!/SENTENCE_BOUNDARY_RE\s*=/.test(src), 'chart_fidelity 又自己抄了一份边界规则');
  ok(/require\('\.\/bazi_chart_facts'\)/.test(src), '没从断言模块 import 公共底座');
  // 行为等价: 同一句, 两个模块给出同一个"是不是本命盘"的判断
  const s = '大运壬午年 4岁起运, 辛巳年 14岁';
  eq(DET.nativeScopeText(s, s.indexOf('辛巳')).indexOf('大运') >= 0, true);
  eq(CF.check(s, [{ name: 'bazi_calc', ok: true, result: { ok: true, data: { pillars: { pillars: { 年柱: '庚午', 月柱: '癸未', 日柱: '戊子', 时柱: '己未' } } } } }]).mismatches.length, 0);
});

console.log('\n--- 门级: 真实答案走完整闸门 ---');
// 放在最后跑: 这两下会真的走一次重修, 前面的同步断言先出结果, 这里再收尾。
(async () => {
  const { verifyAndRepairChartAnswer } = require('../modules/chart_answer_gate');
  const tools = [{
    name: 'bazi_calc', ok: true,
    result: { ok: true, data: { pillars: { pillars: { 年柱: '庚午', 月柱: '癸未', 日柱: '戊子', 时柱: '己未' } } } },
  }];

  // 2026-10-21 实跑复现: 重修闸原来用**绝对** 40 字下限判"重修失败"。
  // 实测两种现场被它混成一类 —— 草稿本身 30 字时, 模型返回 30 字的**正确**重修
  // (喜用土木→喜用木, 忌土不变, 五项全改对), 却被判 repair failed,
  // 于是真答案被换成"原稿 + ⚠️ 重修失败"。守卫自己把好答案判死。
  console.log('\n--- ⑩ 重修长度闸要相对草稿, 不能是绝对 40 ---');
  const shortBad = '年庚午, 月癸未, 日戊子, 时己未。日主戊土。喜用：土、木。忌：土。';
  const shortGood = '年庚午, 月癸未, 日戊子, 时己未。日主戊土。喜用：木。忌：土。';
  eq(shortBad.length < 40, true, '前提变了: 这份草稿本来就短于旧阈值');
  try {
    let n = 0;
    const rShort = await verifyAndRepairChartAnswer(shortBad, async () => { n++; return shortGood; }, tools);
    eq(rShort.repaired, true, '短草稿的正确短重修不该被判失败 (实测它就是好的)');
    eq(n, 1, '够长就不该多花第二次调用');
    ok(!/重修失败/.test(rShort.text), '不该带 ⚠️ 重修失败出门: ' + rShort.text);
    console.log('  ✅ 30 字草稿 → 30 字正确重修 → 放行 (旧阈值会误杀)');
    pass++;
  } catch (e) {
    console.log('  ❌ 短草稿重修  →  ' + e.message);
    fail++;
  }
  // 反向: 真的只回一句"已修正" → 必须重试一次, 重试还短才判失败带 ⚠️
  try {
    const calls = [];
    const longDraft = '年庚午, 月癸未, 日戊子, 时己未。日主戊土。喜用：土、木。忌：土。这是一份比较长的草稿, 需要超过四十个字符才能通过长度闸, 所以这里再补几句无关的废话把长度撑起来。';
    // 第二次必须真的够长才算修好 —— 不然这道用例量的是"fixture 太短", 不是"闸在重试"。
    const longGood = '年庚午, 月癸未, 日戊子, 时己未。日主戊土。戊土生于未月得令, 地支两未一子, 土气偏旺, 宜克泄耗。喜用：木、水。忌：土。木为官杀疏土为用, 水为财耗土之力为喜, 忌神仍为土, 不可与喜用同时列出。';
    ok(longGood.length >= Math.floor(longDraft.length * 0.4), '前提: 重试稿本身够长');
    const rStub = await verifyAndRepairChartAnswer(
      longDraft,
      async (p) => { calls.push(p); return calls.length === 1 ? '已按事实块修正。' : longGood; }, tools);
    eq(calls.length, 2, '回执式短答必须再给一次机会');
    ok(/上一轮只回了/.test(calls[1]), '第二次要把长度闸摆明');
    eq(rStub.repaired, true, '第二次答上来就该放行');
    eq(rStub.residual, undefined, '改对之后不该有残余: ' + JSON.stringify(rStub.residual));
    console.log('  ✅ 回执式短答 → 硬性重试一次 → 放行');
    pass++;
  } catch (e) {
    console.log('  ❌ 回执式短答  →  ' + e.message);
    fail++;
  }

  const bad = '年庚午, 月癸未, 日戊子, 时己未。日主戊土。喜用：土、木。忌：土。';
  const fixed = '年庚午, 月癸未, 日戊子, 时己未。日主戊土。喜用：木、水。忌：土。补足其余判断内容, 让这段过长度闸。';
  let asked = 0;
  const ask = async () => { asked++; return fixed; };
  try {
    const r = await verifyAndRepairChartAnswer(bad, ask, tools);
    eq(r.checked, true, '应进入核验');
    eq(r.source, 'sxtwl', '基准应来自权威盘');
    eq(asked, 1, '检出硬伤才多花这一次 LLM 调用');
    eq(r.repaired, true);
    eq(r.residual, undefined, '改对之后不该有残余: ' + JSON.stringify(r.residual));
    const r2 = await verifyAndRepairChartAnswer(fixed, ask, tools);
    eq(r2.contradictions.length, 0, '改对后再核不该再报');
    eq(asked, 1, '答对了零开销');
    console.log('  ✅ 真实答案进闸门 → 抓到喜忌矛盾 → 重修一次 → 改对后放行');
    pass++;
  } catch (e) {
    console.log('  ❌ 门级重放  →  ' + e.message);
    fail++;
  }
  console.log('\n============================================================');
  console.log('测试结果：' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
  console.log('============================================================');
  if (fail > 0) process.exit(1);
})();
