'use strict';
// gua-answer-gate-20261021.test.js
//
// 卦象答案的出门核验门。立这条的直接起因是第八批那次实跑:
//   主人问"帮我看看第24卦" → 盘古答**贲卦**(真值 24=复, 贲=22)。
// 那个 bug 修完之后我接着收集了一批真实答案, 结果**三份正确答案之外又冒出两个真错**:
//   - "复卦和第24卦是一回事吗" → 写「雷地复」(复是上坤下震, 应称地雷复) + "爻辞七条"(单卦恒六爻)
//   - 第22卦那份 → 卦象名写成「地天雷」(贲是山火贲; 地天雷是泰卦的名) —— 这条当时**抓不到**,
//     记在这里当已知漏检。
//     2026-10-22 第十八批把它补上了 (判据 ②b: 卦象名**从来没有**「象+象+象」这种形状),
//     所以 ANS_22 现在从「正确答案」降级成「带一处真错的答案」—— 见下面 ②b 段。
//
// 判据纪律(和命盘门同款):
//   每一条都是"跟 64i 真源对不上", 不是"我觉得不像"。
//   下面 OK_ 开头的几份是**真实答案原文重放** —— 正确答案必须一条都不报, 报一条就是误伤,
//   守卫把对的判成错的, 就再也没人信它了。

const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ✅ ' + msg); pass++; }
  else { console.log('  ❌ ' + msg); fail++; }
}
function eq(a, b, msg) {
  ok(a === b, msg + ' (期望 ' + JSON.stringify(b) + ', 实得 ' + JSON.stringify(a) + ')');
}

const G = require('../modules/gua_answer_gate');
const find = G.findGuaContradictions;

// ── 真实答案夹具 (2026-10-21 :18901 实跑原文) ────────────────────────────────
// 第22卦=贲 是对的, 但这份里**有一处真错**: 纳甲栏写成「地天雷」(应称「山火贲」)。
// 2026-10-22 起这道门抓得到它, 所以它不再算「零硬伤正确答案」。
const ANS_22 = [
  '第22卦是**贲卦**（䷕）。',
  '',
  '**卦辞**：贲，亨，小利有攸往。',
  '',
  '- 上卦 艮☶（山）· 下卦 离☲（火）',
  '- 卦象：贲饰 —— 文饰、礼仪之美',
  '- 纳甲：地天雷/艮宫（乙酉）',
  '- 爻辞：',
  '  - 初九：贲其趾，舍车而徒',
  '  - 六二：贲其须',
  '  - 九三：贲如濡如，永贞吉',
  '  - 六四：贲如皤如，白马翰如，匪寇婚媾',
  '  - 六五：贲于丘园，束帛戋戋，吝终吉',
  '  - 上九：白贲，无咎',
  '',
  '数据源：64i/hexagrams.js（本地真源，卦序 1..64 文王序）。',
].join('\n');

// 这份是对的 (乾卦), 而且专门测了 0 基索引那个坑: 答案里明说
// "index: 4 是内部 0 基数组下标, 不是卦序" —— 守卫不许把这种句子当成卦序断言
const OK_QIAN = [
  '**乾卦(第1卦)** — 出自 64i 真源(`64i/hexagrams.js`)',
  '',
  '**卦辞**:乾,元亨利贞。',
  '',
  '**卦象**:',
  '- 符号 ䷀,二进制 111111(纯阳,六爻皆阳)',
  '- 上卦 ☰ 乾 / 下卦 ☰ 乾 — 六爻纯阳,刚健之极',
  '- 五行:金;纳甲:甲 子;八卦:乾;性质:刚健',
  '- 关键词:天道、刚健、纯阳、创造、领导',
  '',
  '注意坑:返回里的 index: 4 是内部 0 基数组下标,不是卦序;对外卦序一律 1..64。',
].join('\n');

// 这份有真错 (实跑原文): 卦象名写反了 + 爻数写成七
const BAD_FU = [
  '是同一卦。64i 真源实测:`query="24"` 和 `query="复"` 返回完全同一条记录。',
  '',
  '- 卦序(文王序):**24**',
  '- 卦名:复(䷗)',
  '- 卦辞:「复,亨。出入无疾,朋来无咎。反复其道,七日来复,利有攸往。」',
  '- 上下卦:上坤☷ / 下震☳(雷地复),五行土,八宫归坤,纳甲丁亥',
  '- 爻辞七条:初九「不远复,无祗悔,元吉」/ 六二「休复,吉」/ 六三「频复,厉无咎」',
].join('\n');

// 第八批那份错的 (工具够不着时出的答案), 这次必须能抓住
const BAD_24 = [
  '**周易·第24卦：贲卦 —— 山下有火**',
  '',
  '**卦象**：上艮（山）下离（火），离为明、为文饰。',
  '',
  '**卦辞**：',
  '> 贲，亨。小利有攸往。',
  '',
  '**六爻**：',
  '- 初九：贲其趾，舍车而徒',
  '- 六五：贲于丘园，束帛戋戋，吝，终吉',
].join('\n');

console.log('--- ⛔ 真实答案重放: 正确答案必须零硬伤 ---');
eq(find(OK_QIAN).length, 0, '乾卦=第1卦 (对的, 且含 0 基索引说明) → 零硬伤');
// 真跑出来的**误伤**实录: 一份完全正确的重修稿, 只因为里面有一句
// 「核实并给出第24卦全套卦爻资料与解读」就被判成「第24卦是解卦」。
// 「解读/对比/恢复/老师/困难/水井/革命/上升」这些词的字都撞单字卦名 —— 这条钉死。
eq(find('核实并给出第24卦全套卦爻资料与解读，另外对比一下恢复、老师、困难、水井、革命、上升的用法。').length,
  0, '单字卦名当普通词用 → 零硬伤 (真实误伤实录, 不许回归)');
eq(find('今天天气不错, 要不要出门?').length, 0, '跟卦无关的闲聊 → 零硬伤 (不许乱抓)');

console.log('\n--- ① 卦序 ↔ 卦名 (第八批那个真 bug) ---');
{
  const r = find(BAD_24);
  eq(r.length, 1, '第24卦=贲卦 → 抓到 1 条');
  ok(/第24卦写成贲卦/.test(r[0].claim), 'claim 指名道姓: ' + r[0].claim);
  ok(/卦序 24 实为 复卦/.test(r[0].expect), 'expect 给的是 64i 真值: ' + r[0].expect);
  eq(find('第24卦是复卦，地雷复，上坤下震。').length, 0, '第24卦=复 (对的) → 不报');
  eq(find('复卦是第22卦。').length, 1, '「复卦说成第22卦」→ 抓 (反向也核)');
  eq(find('第64卦是未济，第1卦是乾，第63卦是既济。').length, 0, '边界卦序 1/63/64 全对 → 不报');
  eq(find('第 0 卦不存在，第 65 卦也不存在。').length, 0, '越界卦序直接跳过, 不当成断言');
  eq(find('他在第24期节目里说过，第3个方案也可以。').length, 0, '「第24期」不是卦序 → 不报');
}

console.log('\n--- ② 卦象名 = 上象+下象+卦名 (实跑真错) ---');
{
  const xiang = find(BAD_FU).filter(x => x.kind === 'xiang');
  eq(xiang.length, 1, '「雷地复」→ 抓到 1 条');
  ok(/应称「地雷复」/.test(xiang[0].expect), 'expect 说明正确成法: ' + xiang[0].expect);
  eq(find('复卦是地雷复，上坤下震。').length, 0, '「地雷复」(对的) → 不报');
  eq(find('泰卦是地天泰，上坤下乾。').length, 0, '「地天泰」(对的) → 不报');
  eq(find('贲卦是山火贲，上艮下离。').length, 0, '「山火贲」(对的) → 不报');
}

console.log('\n--- ②b 卦象名第三字是象名 (2026-10-22 补上挂了两批的漏检) ---');
{
  // 现场原文 (ANS_22 里那一行): 「纳甲：地天雷/艮宫（乙酉）」
  // 贲卦(22) 上艮下离 → 卦象名该是「山火贲」; 艮宫、乙酉 都对, 「地天雷」是编的。
  // ② 抓不到的原因: ② 的形状是「象+象+**卦名**」, 这里第三字「雷」是**象名**不是卦名。
  // ②b 的判据: 卦象名只有两种形状 —— 上象+下象+卦名 (山火贲), 或 纯卦的 卦名+为+象 (震为雷)。
  //            **从来没有**「象+象+象」, 所以这三字组是恒错, 不用猜语气不用猜排版。
  const r = find(ANS_22);
  const x3 = r.filter(x => x.kind === 'xiang3');
  eq(x3.length, 1, '第22卦那份(纳甲:地天雷) → 抓到 1 条 (以前是已知漏检)');
  eq(r.length, 1, '整份只报这一条 (其余部分零误伤)');
  ok(/地天雷/.test(x3[0].claim), 'claim 点名那个三字组: ' + x3[0].claim);
  ok(/泰卦/.test(x3[0].expect), 'expect 指出前两字对应哪一卦: ' + x3[0].expect);
  ok(/震卦/.test(x3[0].expect), 'expect 指出第三字是哪个纯卦的象: ' + x3[0].expect);

  // 正例: 各种正确写法一条都不许报
  eq(find('地雷复，上坤下震。').length, 0, '「地雷复」→ 不报');
  eq(find('山火贲，上艮下离。').length, 0, '「山火贲」→ 不报');
  eq(find('震为雷。').length, 0, '「震为雷」(纯卦写法) → 不报');
  eq(find('乾为天，坤为地。').length, 0, '两个纯卦连着写 → 不报');
  eq(find('天雷无妄。').length, 0, '「天雷无妄」(卦名两字) → 不报');
  eq(find('风天小畜。').length, 0, '「风天小畜」→ 不报');

  // 误伤防线: 八卦列举 (先天八卦序) 是一整串象名, 不是卦象名
  eq(find('八卦的象依次是：天泽火雷风山水地。').length, 0, '先天八卦序连排 → 不报 (八卦列举不是卦象名)');
  eq(find('上卦 乾☰（天）· 下卦 离☲（火）').length, 0, '象名带卦名对照 → 不报');
  eq(find('今天天气不错，要不要出门？').length, 0, '跟卦无关 → 不报');

  // 事实块自己不能是错的: 纯卦的卦象名是「震为雷」, 不是 expectedXiang 拼出来的「雷雷震」。
  // 事实块是重修稿的**基准** —— 基准自己错, 整道门跟着错。
  const fb = G.buildGuaFactsBlock([{ guaIds: [51], claim: 'x', expect: 'y' }]);
  ok(/卦象名 震为雷/.test(fb), '事实块里纯卦写「震为雷」');
  ok(!/雷雷震/.test(fb), '事实块里不许出现「雷雷震」(expectedXiang 对纯卦不成立)');
}

console.log('\n--- ③ 单卦永远六爻 ---');
{
  const yao = find(BAD_FU).filter(x => x.kind === 'yao');
  eq(yao.length, 1, '「爻辞七条」→ 抓到 1 条');
  ok(/恒为六爻/.test(yao[0].expect), 'expect: ' + yao[0].expect);
  eq(find('爻辞六条：初九…上六。').length, 0, '「爻辞六条」(对的) → 不报');
  eq(find('复卦为六爻卦，共六爻。').length, 0, '「复卦六爻」(对的) → 不报');
  eq(find('六十四卦共三百八十四爻。').length, 0, '384 爻总数说法 → 不报 (那是对的总纲)');
}

console.log('\n--- ④ 引的原文属于**另一卦** (定死型判据) ---');
{
  const bad = '## 复卦\n**卦辞**：「贲，亨，小利有攸往。」\n六爻：初九「不远复，无祗悔，元吉」；六二「贲其须」';
  const r = find(bad);
  eq(r.length, 2, '卦辞 + 爻辞各错一条 → 抓到 2 条');
  ok(r.some(x => /那是 贲卦的卦辞/.test(x.expect)), '卦辞那条说清是谁的');
  ok(r.some(x => /那是 贲卦的爻辞/.test(x.expect)), '爻辞那条说清是谁的');
  eq(find('## 复卦\n**卦辞**：「复，亨。出入无疾，朋来无咎。」').length, 0, '引的是本卦卦辞 → 不报');
  eq(find('## 复卦\n六二「休复，吉」').length, 0, '引的是本卦爻辞 → 不报');
}

console.log('\n--- 事实块要端得出真值 ---');
{
  const fb = G.buildGuaFactsBlock(find(BAD_FU).concat(find(BAD_24)));
  ok(/卦序 24 = 复卦/.test(fb), '事实块里有复卦真值');
  ok(/卦序 22 = 贲卦/.test(fb), '事实块里有贲卦真值');
  ok(/地雷复/.test(fb), '事实块给出正确卦象名');
  // 卦义(nature)与卦象名是**两样东西**, 名字都带「象」—— 事实块必须两个都给,
  // 否则模型只能凭记忆补一个, 「地天雷」那类编造就是这么来的。
  ok(/卦义 贲饰/.test(fb), '事实块里有贲卦卦义(贲饰)');
  ok(/卦义 复归|卦义 回复/.test(fb), '事实块里有复卦卦义');
  ok(/文王序/.test(fb), '事实块写明卦序基数');
  ok(/0\.\.63/.test(fb), '事实块点明 0..63 那套二进制索引, 提醒别混');
  ok(/恒为六爻/.test(fb), '事实块写明单卦六爻');
  ok(/禁止凭记忆另写/.test(fb), '事实块带纪律句(不许凭记忆另写)');
}

console.log('\n--- 门级: 检出 → 重修 → 再核 ---');
(async () => {
  const { verifyAndRepairGuaAnswer } = require('../modules/gua_answer_gate');
  let asked = 0;
  const fixed = [
    '是同一卦。',
    '',
    '- 卦序(文王序):**24**',
    '- 卦名:复(䷗)',
    '- 卦辞:「复,亨。出入无疾,朋来无咎。反复其道,七日来复,利有攸往。」',
    '- 上下卦:上坤☷ / 下震☳(地雷复),五行土,八宫归坤,纳甲丁亥',
    '- 爻辞六条:初九「不远复,无祗悔,元吉」/ 六二「休复,吉」/ 六三「频复,厉无咎」',
  ].join('\n');
  const ask = async () => { asked++; return fixed; };
  try {
    const r = await verifyAndRepairGuaAnswer(BAD_FU, ask);
    eq(r.checked, true, '应进入核验');
    eq(asked, 1, '检出硬伤才多花这一次 LLM 调用');
    eq(r.repaired, true, '重修成功');
    eq(r.residual, undefined, '改对之后不该有残余: ' + JSON.stringify(r.residual));
    ok(!/⚠️/.test(r.text), '不该带 ⚠️ 出门');
    const r2 = await verifyAndRepairGuaAnswer(fixed, ask);
    eq(r2.contradictions.length, 0, '改对后再核不该再报');
    eq(asked, 1, '答对了零开销');
    console.log('  ✅ 真实错答案 → 门抓到 → 重修一次 → 改对后放行');
    pass++;
  } catch (e) {
    console.log('  ❌ 门级重放  →  ' + e.message);
    fail++;
  }

  try {
    const r = await verifyAndRepairGuaAnswer(BAD_24, async () => '改好了。');
    eq(r.repaired, false, '回执式短答判重修失败');
    ok(/⚠️/.test(r.text) && /第24卦写成贲卦/.test(r.text), '原稿 + 诚实标注出门');
    console.log('  ✅ 重修失败 → 原稿附 ⚠️ 出门 (不许静默放行)');
    pass++;
  } catch (e) {
    console.log('  ❌ 重修失败路径  →  ' + e.message);
    fail++;
  }

  console.log('\n--- 接线: 两道门在同一个出门闸里 ---');
  try {
    const fs = require('fs');
    // 第 61 批: 剥掉注释再扫 —— 我在 dispatcher 的注释里引用了旧代码原句,
    //   直接读全文会把**自己写的注释**当成「老形状复活」。这个坑本批踩了三次
    //   (toolmarkup / chart-gate-authoritative / 本文件), 所以读法统一改掉。
    const _readCode = (abs) => fs.readFileSync(abs, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const disp = _readCode(path.join(__dirname, '..', 'modules', 'j2_dispatcher.js'));
    const loop = _readCode(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'));
    // 第 61 批: 定稿收口收进 final_pipeline._finalize(剥泄漏+对齐门+门 一条流水线)。
    // 第 65 批: 公共 5 步又收进 `_synthesizeAndFinalize` —— 「五处各写一遍」的份数没了,
    //   但**判据没放松**: 改成钉机制 —— 每条交付出口都得走到定稿流水线, 少一条照样红。
    const { finalizeCoverage } = require('./helpers/dispatcher_exits');
    const _cov = finalizeCoverage();
    ok(_cov.count >= 4, 'dispatcher 交付出口找少了 (直答/fixed_flow/关键词兜底/主路径): ' + _cov.count);
    ok(_cov.all('_finalize'),
      'dispatcher 有交付出口没过定稿流水线: '
      + _cov.uncovered('_finalize').map((e) => 'L' + e.line).join(', '));
    ok(!/await _factGate\(/.test(disp), '有定稿收口绕过流水线直接过门 —— 剥【上文】块和对齐门被跳过');
    ok(!/await _chartGate\(/.test(disp), '旧名 _chartGate 无残留');
    // 2026-10-23 第 60 批: 「两道门都在 / legacy 主循环也接了 / 串成一条链」这三条,
    //   在本文件、toolmarkup-chartfacts、chart-gate-authoritative 里**各存了一份同义断言**,
    //   而且都是扫源码 —— 编排搬家一次就要改三处, 这正是本项目反复踩的
    //   「两份同义文本各改各的」, 只不过这次长在测试层。
    //   现已收成唯一一份: tests/answer-gates-single-impl-20261023.test.js
    //     A1  唯一实现(两道门只有 answer_gates 一个编排方)
    //     A2  dispatcher 五处调用点都走 _factGate, 且它只调一次真源
    //     B1  真跑一遍验顺序: 卦象门先跑、结果喂给命盘门(比扫源码强)
    //     负例 把顺序反过来必须挂
    // 本文件只留「门自己的判定逻辑」那部分 —— 那是它独有的职责。
    ok(/require\('\.\/answer_gates'\)/.test(disp), 'dispatcher 没走唯一编排');
    ok(/runAnswerGates/.test(loop), 'legacy 主循环没走唯一编排');
    console.log('  ✅ 卦象门接进 dispatcher 5 处 + legacy 主循环, 且排在命盘门之前');
    pass++;
  } catch (e) {
    console.log('  ❌ 接线守卫  →  ' + e.message);
    fail++;
  }

  console.log('\n============================================================');
  console.log('测试结果：' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
  console.log('============================================================');
  if (fail > 0) process.exit(1);
})();
