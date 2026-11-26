'use strict';
// 2026-10-12 回归: 老板报「会话 75738498 接不上上文」。
// 三个真 bug, 每个一条断言, 任何一条回退都红。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { resolveTaskInput } = require('../modules/answer_alignment');

const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// ① 判重不能拿本轮跟它自己比
//    桌面端 ChatRoom 发的是 messages = [...历史, 当前这条 user] —— 当前轮已经在 messages 里。
//    旧代码取最后一条 user 当"上一轮", 相似度恒为 1.0 → 每一轮新问题都被判成
//    "同问重发" → 注入【重复提问·已答过】+"禁止从头重新起卦/禁止重读文件" → 接不上上文。
// ─────────────────────────────────────────────────────────────────────────────
const _longAnswer = '根据你的原局,2026丙午年火土燥旺,大运壬午、流年丙午,天干丙火生戊土,地支午火冲子水,'
  + '流年与大运的关系要看是否相冲,相冲则主动荡。'.repeat(3);
const _hist = (prevQ, raw) => [
  { role: 'user', content: prevQ },
  { role: 'assistant', content: _longAnswer },
  { role: 'user', content: raw },
];

assert.ok(
  !resolveTaskInput('不对吧，你是不是流年和大运看岔了？', _hist('1.流年与大运、原局发生冲的关系时通常代表什么？', '不对吧，你是不是流年和大运看岔了？'))
    .includes('【重复提问·已答过】'),
  '① 追问被误判成"同问重发" — 判重拿本轮跟 messages 最后一条(就是本轮自己)比, 相似度恒 1.0'
);

// 真正原样重发仍要识别 (剔本轮后仍能命中上一轮)
assert.ok(
  resolveTaskInput('字幕製作人Zither Harp', _hist('字幕製作人Zither Harp', '字幕製作人Zither Harp'))
    .includes('【重复提问·已答过】'),
  '①b 原样重发必须仍然被识别为重复提问'
);

// 相邻追问不能被前缀相似误伤 (老板连着问 2026/2027 的流年)
assert.ok(
  !resolveTaskInput('那2027年的流年运势如何？', _hist('看一下以下案例2026年的流年运势如何？', '那2027年的流年运势如何？'))
    .includes('【重复提问·已答过】'),
  '①c 共享长前缀的追问被误判成重发 — 阈值应要求"同一句话", 不是前缀相似'
);

// ─────────────────────────────────────────────────────────────────────────────
// ② dispatcher 子 agent 必须拿到上文
//    实测: 追问"你是不是流年和大运看岔了?"时, analyzer 的 task 里只有卦块 + 这一句,
//    子 agent 回"我会先检索是否有出生资料/排盘结果" —— 它不知道上一轮答了什么。
// ─────────────────────────────────────────────────────────────────────────────
const _disp = SRC('modules/j2_dispatcher.js');
assert.ok(_disp.includes('_buildHistoryBlock'), '② dispatcher 缺 _buildHistoryBlock — 子 agent 拿不到任何上文');

assert.ok(_disp.includes('_buildHistoryBlock,') && _disp.includes('module.exports'),
  '②b _buildHistoryBlock 未导出, 无法直接验证');
const { _buildHistoryBlock, _stripHistoryLeak } = require('../modules/j2_dispatcher');
const { parseJs, callSites, functionSource } = require('./helpers/js_ast');

const _block = _buildHistoryBlock(
  [
    { role: 'user', content: '看一下以下案例2026年的流年运势如何？', images: ['/tmp/a.png'] },
    { role: 'assistant', content: _longAnswer },
    { role: 'user', content: '不对吧，你是不是流年和大运看岔了？' },
  ],
  '不对吧，你是不是流年和大运看岔了？'
);
assert.ok(_block.includes('不对吧') === false, '②c 历史块不该重复当前这一轮');
assert.ok(/禁止在答复里复述本段/.test(_block), '②h 历史块没写禁止复述 → 综合环节会把它当标题复读上屏');
assert.ok(_block.includes('看一下以下案例2026年的流年运势如何'), '②d 历史块丢了上一轮主人提问 → 追问无从接起');
assert.ok(_block.includes('流年与大运的关系要看是否相冲'), '②e 历史块丢了上一轮盘古回答 → 子 agent 无法判断"看岔了"指哪');
// 2026-10-12 (会话 80922578): 图类追问踩了坑 —— 早先这里写的是 "[附图 1 张]",
// 子 agent 拿不到图像, 看到这行就去满世界找文件 (实测 list_directory "/" 然后汇报
// "工具结果仅返回根目录清单", 整轮空转)。改成明说拿不到图 + 禁止去找。
assert.ok(/上一轮带图 1 张/.test(_block), '②f 历史块丢了图提示 → 子 agent 不知道这段对话原本有图');
assert.ok(/拿不到图像本身/.test(_block) && /禁止为找图去调/.test(_block),
  '②g 历史块必须明说"你拿不到图像"且"禁止为找图调工具" — 否则子 agent 会去找文件空转一轮');
assert.strictEqual(_buildHistoryBlock([{ role: 'user', content: '帮我看看盘' }], '帮我看看盘'), '',
  '②g 第一轮对话不该注入空上文块');

// 历史块必须真的焊进 4 个装配点
const _taskPoints = (src, re) => (src.match(re) || []).length;
assert.ok(_taskPoints(_disp, /taskText: _historyBlock \+ userInput/g) >= 2,
  '②h planner / keyword fallback 的 taskText 没拼历史块');
// 2026-10-12: fixed_flow 的子任务文本抽成了纯函数 _fixedTaskPrompt(st, idx, total,
// userInput, historyBlock) —— 主人诉求只交给第 1 个子任务 (现场 resume-01: 5 个 checker
// 各干一遍, 产物追加 3 次)。历史块由这个纯函数统一拼, 断言跟着搬家, 行为要求不变。
assert.ok(/function _fixedTaskPrompt\(st, idx, total, userInput, historyBlock\)/.test(_disp)
  && /_fixedTaskPrompt\(st, _fi, fixedTasks\.length, userInput, _historyBlock\)/.test(_disp)
  && /String\(historyBlock \|\| ''\)/.test(_disp),
  '②i fixed_flow 子 agent 任务没拼历史块');
// 2026-10-13: dispatcher 主路径的综合输入抽成了 _buildSynthesisInput (接入本轮真写盘锚点),
// 所以主路径不再内联拼 _historyBlock —— 改成断言"三条旁路仍内联 + 主路径经函数传入"。
// 守卫意图不变: **每一处综合 prompt 都必须带历史块**。
//
// 2026-10-23(第 65 批): 关键词兜底那两条路**共用**了一个收口(原来是两份一字不差的抄本),
// 于是「内联拼 _historyBlock 的地方」从 3 处变 2 处 —— 少的那一处**不是漏了**,
// 是两条路合成了一条。判据跟着搬家, 意图一个字没变, 而且下面还多钉了一条:
// 共用收口那一条自己也得带历史块(它现在替两条路说话)。
//
// 2026-10-25(第 87 批): fixed_flow 那条综合路也并进了 `_buildSynthesisMessages` 真源
// (它原来自己内联了一套: 每刀 slice(0,3000) + 总 slice(0,15000),
//  连 2026-10-22 的排盘断言核验都没走) —— 于是内联拼 _historyBlock 的地方从 2 处变 1 处。
// 少的那一处**不是漏了**, 是那条路现在经共享 builder 说话。
// ⚠ 守卫不许因此变松: 除了数内联处数, 现在**逐个点名**每一条综合路都把 _historyBlock 交进去了 ——
//   「内联 1 处 + 关键词兜底自己拼 + 主路经函数 + fixed_flow 经函数」, 一条都不许少。
const _inlineHistoryPoints = (_disp.match(/主人问题：' \+ userInput \+ '\\n\\n' \+ \(_historyBlock/g) || []).length;
assert.ok(_inlineHistoryPoints === 1
  && /function _buildSynthesisInput\(sessionId, userInput, historyBlock,/.test(_disp)
  && /\$\{historyBlock \|\| ''\}/.test(_disp)
  // 主路: 经 _buildSynthesisMessages 把 _historyBlock 交进去
  && /_buildSynthesisMessages\(sessionId, userInput, _historyBlock,/.test(_disp)
  // fixed_flow: 第 87 批并进真源后, 它也必须把 _historyBlock 交进去 (不许自己另拼一套)
  && /_buildSynthesisMessages\(sessionId, userInput, _historyBlock, results, _ffPerAgent/.test(_disp)
  // 共享 builder 自己也必须把 historyBlock 写进 user 内容
  && /_buildSynthesisInput\(sessionId, userInput, historyBlock, results, perAgentBudget\)/.test(_disp),
  '②j 综合 prompt 有漏拼历史块的 (内联 1 处 + 主路 + fixed_flow 都得经 _historyBlock)');
const _kfbSrc = functionSource(parseJs(_disp), '_keywordFallbackCloseOut');
assert.ok(_kfbSrc && /\(_historyBlock \?/.test(_kfbSrc),
  '②j 关键词兜底的综合 prompt 没拼历史块 — 兜底那一路的追问会接不上上文');

// ─────────────────────────────────────────────────────────────────────────────
// ③ fixed_flow 成功路径必须落盘
//    实测: fixed_flow 成功分支直接 return, 只有 quota/acceptance 失败路径调 _persistParent
//    → 正常答完的对话磁盘上不存在, 刷新即丢。
// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-23(第 65 批): 落盘收成唯一出口 `_closeOut` 之后, 这里问的不再是
// 「成功分支里有没有 `_persistParent(finalText`」, 而是「成功分支是不是走了唯一出口,
// 且带上了落盘规格」。意图一个字没变: **fixed_flow 答完的对话必须落盘**。
// (量法换了 —— 原来那 700 字符窗口量的本来就是「附近」, 不是「块内」。)
const _ffCloseOuts = callSites(parseJs(_disp), '_closeOut').filter((s) =>
  /mode:\s*'fixed_flow'/.test(s.args[0] ? s.args[0].text : '')
  && /result:\s*finalText/.test(s.args[0] ? s.args[0].text : ''));
assert.ok(_ffCloseOuts.length === 1, '③a fixed_flow 成功分支的收口调用点不见了');
const _ffSpec = _ffCloseOuts[0].args[1];
assert.ok(_ffSpec && /persistState/.test(_ffSpec.text),
  '③ fixed_flow 成功分支没给落盘规格 — 正常答完的 fixed_flow 对话刷新/重启即丢');

// ─────────────────────────────────────────────────────────────────────────────
// ④ 注入块不许泄到主人眼前
//    实测: 加了历史块后, 综合 LLM 把 "### 【上文 — …】" 当 Markdown 标题复读出来。
// ─────────────────────────────────────────────────────────────────────────────
const _leaked = '### 【上文 — 本会话此前的对话】(这是同一条对话, 不是第一次问。回答必须接住这段: 主人说的"上一轮/这个/它"都指这里)'
  + '\n\n已核实：2026年为丙午年。上一轮确有表述错误。';
assert.ok(!_stripHistoryLeak(_leaked).includes('上文'), '④ 综合答案把内部【上文】标记复读上屏了');
assert.ok(_stripHistoryLeak(_leaked).includes('上一轮确有表述错误'), '④b 剥除把正文一起吃掉了');
assert.strictEqual(_stripHistoryLeak('上文这个卦怎么解？主人在问流年。'), '上文这个卦怎么解？主人在问流年。',
  '④c 正文里本来就有的"上文"二字不该被剥');
// 2026-10-12: 新增直答单 agent 路径 (modules/j2_dispatcher.js if (_directAnswerTurn)),
// 它同样是"先 _stripHistoryLeak 再过出门核验门", 故合规收口从 4 处变 5 处。
// 2026-10-21 第九批: 门改名 _factGate (卦象门并进来), 断言跟着改名 —— 判据没放松,
// 还是"每处收口都得先剥历史标记" + ">=5 处"。
// 2026-10-23 第 61 批: 流水线收成 final_pipeline.finalizeAnswer 一次调用,
//   那句 `await _factGate(_stripHistoryLeak(...))` 在本文件里从「五处各写一遍」
//   变成了「一个函数的行为」。所以:
//   - 「五处收口都要走」 → 数调用点, 判据没放松;
//   - 「先剥历史标记再过门」→ 改成真跑一遍 final_pipeline 验行为 (见 D1~D3)。
// 2026-10-23(第 65 批): 「五处收口各写一遍 `await _finalize(`」这个量法失效了 ——
//   公共 5 步(综合 → 兜底 → 定稿核验 → 剥伪工具标记)收进了 `_synthesizeAndFinalize`,
//   直答那条仍直接调 `_finalize`。**意图一个字没变**:
//   每条交付路径的收口都要先剥历史标记再过出门核验门。
//
// 新量法是**对账**, 不是数内联调用点:
//   交付出口(直答 / fixed_flow / 关键词兜底 / 主路径)  ==  定稿流水线的入口数
//   (关键词兜底那个点替 2 条路, 所以 4 个出口覆盖 5 条出口)
// 两边对不上 = 有一条交付路径没走流水线(或者多了一个没出口的流水线调用)。
const _dTree = parseJs(_disp);
const _deliveryExits = callSites(_dTree, '_closeOut')
  .filter((s) => /status:\s*[A-Za-z_$][\w$]*\s*\?/.test(s.args[0] ? s.args[0].text : ''));
const _synthSrc = functionSource(_dTree, '_synthesizeAndFinalize');
const _finInsideSynth = (_synthSrc ? (_synthSrc.match(/await _finalize\(/g) || []).length : 0);
const _finTotal = callSites(_dTree, '_finalize').length;
const _pipelineEntrances = callSites(_dTree, '_synthesizeAndFinalize').length + (_finTotal - _finInsideSynth);
assert.ok(_deliveryExits.length >= 4,
  `④d 交付出口找少了 (直答/fixed_flow/关键词兜底/主路径), 实际 ${_deliveryExits.length}`);
assert.strictEqual(_deliveryExits.length, _pipelineEntrances,
  `④d 有交付路径没走定稿流水线: 出口 ${_deliveryExits.length} 个, 流水线入口 ${_pipelineEntrances} 个 `
  + '(收口 = 先剥历史标记再过出门核验门)');
// 2026-10-17 (单刀直查那刀): 分支条件加了第二种触发 _singleShotTurn。
// 原来这条用"从 if 往后 3000 字符内"的窗口找 chartGate —— 那一刀给分支加了注释和
// 工具拼装, 实际距离变成 3166 字, 窗口就失效了。与其把数字调大 (下次还会再失效),
// 改成**按分支边界切片**: 从直答分支起点切到 const skipResult, 断言里面必须有
// 先剥历史标记再过命盘核验门的那一句。窗口魔法数从此不存在。
{
  const _anchor = 'if (_directAnswerTurn || _singleShotTurn)';
  const _bi = _disp.indexOf(_anchor);
  const _be = _disp.indexOf('const skipResult =', _bi);
  assert.ok(_bi > 0 && _be > _bi,
    '④e 找不到直答分支边界 (锚点 ' + _anchor + ' 或其后的 const skipResult =)');
  assert.ok(/await _finalize\(/.test(_disp.slice(_bi, _be)),
    '④e 直答路径的收口必须同样走定稿流水线(先剥历史标记再过出门核验门)');
}

// 第 61 批新增: 「先剥历史标记再过门」从「五处字符串长得一样」变成「一个函数的行为」。
// 真跑一遍, 不扫源码 —— 扫源码的话, 把顺序调反了测试照样绿。
//
// 顺序(与改造前逐字一致, 由内向外): 剥思维链 → 对齐门 → 剥【上文】块 → 核验门
// 注意「对齐门在剥泄漏之前」是**有意保留**的旧顺序: 对齐门比的是语义,
// 泄漏块不影响语义; 而核验门是拿文本里的卦名/四柱查表, 泄漏块混着我们自己注入的
// 旧卦象会让基准串味 —— 所以泄漏必须在门前剥掉, 但不必在对齐门前。
const _t61 = (async () => {
  const _fp = require('../modules/final_pipeline');
  const _gatesPath = require.resolve('../modules/answer_gates.js');
  const _realGates = require(_gatesPath);
  const _leaky = '### 【上文 — 本会话此前的对话】(这段指这里)\n\n第24卦是复卦，地雷复。';
  const _saw = {};
  _saw.gate = null;
  _saw.guard = null;
  require.cache[_gatesPath].exports = {
    runAnswerGates: async (text) => {
      _saw.gate = text;
      return { text, gua: null, chart: null };
    },
  };
  try {
    await _fp.finalizeAnswer({
      finalText: '<think>盘古先盘算了一下</think>' + _leaky,
      userInput: '第24卦是哪一卦',
      model: 'm',
      ask: async () => '',
      guardWithSubFallback: (q, primary) => {
        _saw.guard = primary;
        return primary;
      },
      chartEvidence: [],
      logPrefix: '',
    });
  } finally {
    require.cache[_gatesPath].exports = _realGates;
  }
  assert.ok(!_saw.guard.includes('<think>'),
    '④f 对齐门看到的文本里还有 <think> —— stripThink 必须排在它前面');
  // 对齐门**仍然看得到**【上文】块 —— 这是改造前的顺序, 本批逐字保留, 不趁机改语义。
  // 哪天要把它挪到剥泄漏之后, 那是一次行为变更, 得单独拍。
  assert.ok(_saw.guard.includes('上文'),
    '④f 对齐门不该看到已被剥掉的【上文】块 —— 顺序与改造前不一致(见上方注释)');
  assert.ok(_saw.gate && !_saw.gate.includes('上文'),
    '④f 核验门看到的文本里还有【上文】块 —— 顺序反了, 核验基准会串味');
  assert.ok(_saw.gate && _saw.gate.includes('第24卦'),
    '④f 剥泄漏把正文一起吃掉了');
})();


// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 被纠正时不许无条件改口 (会话 80922578)
// 同一道八字题, 身强身弱连翻 4 次: 偏弱 → 偏旺 → 偏强 → 偏弱, 每轮都被主人说一句就翻面,
// 一轮工具都没调过。纯谄媚, 不是推理。
// ─────────────────────────────────────────────────────────────────────────────
{
  const _A = '丁火生未月, 得午根, 判偏旺, 喜木火。大运甲子, 流年丙午。'.repeat(3);
  const _base = [{ role: 'user', content: '做题，要看清楚图' }, { role: 'assistant', content: _A }];
  const _ask = (q) => resolveTaskInput(q, _base.concat([{ role: 'user', content: q }]));

  // 词表是照主人实际说过的话收的, 不是凭想象列的
  for (const q of [
    '原主什么情况你都没分析，怎么分析流年大运？刑冲合害也都没加进去？',
    '那就重新全部重新来',
    '身强还是身弱？喜用呢？这些不在里面，大运流年不也有问题',
    '为什么偏强？肯定偏弱啊？',
    '所以整道题要重新做，细心点',
    '重新输出完整答案',
    '不对吧，你是不是看岔了？',
  ]) {
    assert.ok(_ask(q).includes('【纠错纪律'), `⑤ 纠正句没注入纠错约束: ${q}`);
  }
  // 普通提问不该被误伤
  for (const q of ['2026年流年运势如何', '大运从哪一年开始', '帮我看看这个盘']) {
    assert.ok(!_ask(q).includes('【纠错纪律'), `⑤c 普通提问被误判成纠错: ${q}`);
  }
  // 约束本身要点破"别只回一句你说得对"
  const _block = _ask('为什么偏强？肯定偏弱啊？');
  assert.ok(/禁止只回一句/.test(_block), '⑤d 纠错约束没点破"只回你说得对就翻面"这种谄媚');
  assert.ok(/依据不足|没有独立依据/.test(_block), '⑤e 纠错约束没给"没有依据时该怎么办"的出路');
  assert.ok(/不要翻第五次|问清楚/.test(_block), '⑤f 纠错约束没拦住"同一题反复改口"');
  // 上文块里的图提示必须让子 agent 别去找文件
  assert.ok(!_block.includes('附图 1 张'), '⑤g 历史块还留着旧的 "[附图 N 张]" 写法');
}

// ④f 是 async(要真跑一遍流水线), 所以「ok」必须等它跑完再打 ——
//   否则会出现「先打 ok, 后打 ❌」, 而 EXIT 仍然是 0 (踩过的坑: 输出骗人)。
_t61.then(() => {
  console.log('context-continuity-20261012 tests: ok (①②③④⑤④f)');
}).catch((e) => {
  console.error('context-continuity-20261012 FAILED: ' + e.message);
  process.exitCode = 1;
});
