// 2026-10-13 综合答案自相矛盾, 连带把整轮判成 partial (现场 session=pcheck-1791823545)
//
// 现场: 20 个文件任务, 20/20 真写盘成功, checker 结论 PASS。
// done 事件: child_statuses = 7 个全是 completed, child_failures = [], 但 status=partial。
//
// 落盘会话里最后那条 assistant 答复不是综合答案, 是子 agent 原文的拼接, 开头就是:
//   "当前有 15 个文件 f00.txt—f14.txt, 尚未出现 f15.txt—f19.txt。未创建或修改任何文件。"
// —— 而实际 20/20 都在盘上。这句"自认未完成"被 _answerAdmitsIncomplete 抓到 → 整轮 partial。
//
// 为什么综合会信这句: analyzer 是先跑的, 它说"未创建任何文件"在它那个时点是真的;
// 后面的 executor 写完了, 但综合 prompt 只说"基于这些真实数据综合",
// 没有任何一条把**本轮真写盘清单**立为准绳, 于是综合照抄了最早那句。
//
// 账本今天已经修成可靠真源 (ee2bf33 / 4ddc373), 这次把它接到综合阶段。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-synth-'));
process.env.PANGU_HOME = TMP;
// 2026-10-26 第 100 批: 账本目录走唯一真源 (modules/state_paths.js),
// 解析顺序 PANGU_LEDGER_DIR > PANGU_HOME/state/ledger > 生产默认。
// 只设 PANGU_HOME 会被链沙箱里的 PANGU_LEDGER_DIR 抢在前面 ⇒ 账本落到共享沙箱目录,
// 本测试的隔离意图 (自己的 TMP) 就没了。
process.env.PANGU_LEDGER_DIR = path.join(TMP, 'state', 'ledger');

const SRC = fs.readFileSync(require.resolve('../modules/j2_dispatcher.js'), 'utf8');
const disp = require('../modules/j2_dispatcher');
const ledger = require('../modules/task_ledger');

const SID = 'synth-1';

// 真实形态: 三个子 agent, analyzer 先跑说"未创建任何文件", executor 后跑真写了 5 个
function seed() {
  ledger.recordToolResult(SID + '#sub-0-analyzer', 'list_directory',
    { path: '/tmp/x' }, { ok: true, data: { path: '/tmp/x', entries: [] } });
  ledger.recordToolResult(SID + '#sub-1-executor', 'exec_command',
    { command: 'cd /tmp && echo a > /tmp/x/a.txt' }, { ok: true, data: {} });
  ledger.recordToolResult(SID + '#sub-1-executor', 'exec_command',
    { command: 'cd /tmp && echo b > /tmp/x/b.txt' }, { ok: true, data: {} });
  ledger.recordToolResult(SID + '#sub-2-executor', 'exec_command',
    { command: 'cd /tmp && echo c > /tmp/x/c.txt' }, { ok: true, data: {} });
}
seed();

const RESULTS = [
  { agent: 'analyzer', task: '先看现状', result: { summary: '当前没有任何文件。未创建或修改任何文件。', artifacts: [] } },
  { agent: 'executor', task: '写 a b', result: { summary: '已创建 a.txt、b.txt', artifacts: [{ path: '/tmp/x/a.txt' }, { path: '/tmp/x/b.txt' }] } },
  { agent: 'executor', task: '写 c', result: { summary: '已创建 c.txt', artifacts: [{ path: '/tmp/x/c.txt' }] } },
];

test('综合输入必须带一份权威的真写盘清单 (本轮账本, 含子 agent)', () => {
  const inp = disp._buildSynthesisInput(SID, '写几个文件', '', RESULTS, 3000);
  assert.match(inp, /a\.txt/, '综合输入必须含真实写盘路径 a.txt');
  assert.match(inp, /b\.txt/);
  assert.match(inp, /c\.txt/);
  assert.match(inp, /本轮真写盘/, '这段清单要有明确标题');
});

test('综合 prompt 必须明说: 子 agent 自述可能过期, 以真写盘清单为准', () => {
  const msgs = disp._buildSynthesisMessages(SID, '写几个文件', '', RESULTS, 3000);
  const sys = msgs.find(m => m.role === 'system');
  assert.ok(sys, '必须有 system 消息');
  assert.match(sys.content, /以[^。]{0,20}真写盘[^。]{0,30}为准|为准绳/,
    'system prompt 必须把真写盘清单立为准绳: ' + sys.content.slice(0, 200));
  assert.match(sys.content, /可能(已经)?过期|时点|自述/,
    'system prompt 必须提醒子 agent 自述可能过期: ' + sys.content.slice(0, 200));
});

test('子 agent 说"未创建"但清单里有文件时, 输入必须同时呈现两者 (不替模型下结论)', () => {
  const inp = disp._buildSynthesisInput(SID, '写几个文件', '', RESULTS, 3000);
  assert.ok(inp.includes('未创建或修改任何文件'), '子 agent 原话要保留, 不能被悄悄改掉');
  assert.ok(inp.includes('a.txt'), '同时要有真写盘清单');
});

test('没有任何写盘时, 清单段如实写"无", 不报错', () => {
  const empty = [{ agent: 'analyzer', task: '只是聊聊', result: { summary: '你好', artifacts: [] } }];
  const inp = disp._buildSynthesisInput('synth-none', '你好', '', empty, 3000);
  assert.match(inp, /本轮真写盘[^\n]*\n?\s*[-（(]?\s*无/, '无写盘时应如实写"无"');
});

test('接线: 四条综合路径 (dispatcher / fixed_flow / 两个 keyword_fallback) 都带真写盘锚点', () => {
  // 主路径走抽出来的 _buildSynthesisMessages (里面已含锚点)
  assert.match(SRC, /truncateMessagesForContext\(\s*_buildSynthesisMessages\(/,
    'dispatcher 主路径必须走 _buildSynthesisMessages');
  // 三条旁路各自保留自己的证据拼接形状 (不能硬塞进主函数), 但必须都挂上锚点
  // 调用点 (排除函数定义那一处)。
  // 2026-10-23(第 65 批): 关键词兜底那两条路**共用**了一个收口(原来是一字不差的两份抄本),
  //   于是「挂锚点的调用点」从 4 变 3 —— 少的那一处**不是漏了**, 是两条路合成了一条。
  // 第 87 批 (2026-10-25): fixed_flow 并进 `_buildSynthesisMessages` 之后,
  //   fixed_flow 自己那份内联输入块没了 ⇒ 锚点调用点从 3 变 2。
  //   少的那一处**不是漏了**: fixed_flow 现在经 `_buildSynthesisMessages` →
  //   `_buildSynthesisInput` 拿锚点, 跟主路同一条。
  //   但「数字从 3 变 2」**证明不了**四条路都有锚点 —— 数份数的老毛病。
  //   所以下面配一条真调的: 主路/fixed_flow 共用的注入块里必须真的有锚点。
  const anchors = (SRC.match(/(?<!function )_groundTruthBlock\(sessionId\)/g) || []).length;
  assert.equal(anchors, 2,
    '锚点调用点应恰好 2 处 (主路/fixed_flow 共用的 _buildSynthesisInput 一处 + 关键词兜底路一处), 实际 '
    + anchors + ' 个 —— 多出来是抄本, 少了是"只堵了一个洞"');
  // 真调那半: 主派发与 fixed_flow 走的那条, 锚点必须真在注入块里 (不是只数了调用点)
  const inpMain = disp._buildSynthesisInput(SID, '写几个文件', '', RESULTS, 3000);
  assert.match(inpMain, /真写盘[^\n]*为准绳|为准绳/,
    '主路 / fixed_flow 的注入块必须带真写盘锚点');
  // 关键词兜底路不走 `_buildSynthesisInput`, 它自己拼注入块 ⇒ 它自己那处调用点必须还在
  assert.match(SRC, /_groundTruthBlock\(sessionId\)[^\n]*子任务工具执行结果/,
    '关键词兜底路必须自己挂真写盘锚点 (它不经过 _buildSynthesisInput)');
  // 反向钉住: 关键词兜底仍是两条路, 两条都得有锚点(一处调用点替两条路说话)
  assert.equal((SRC.match(/await _keywordFallbackCloseOut\(results\);/g) || []).length, 2,
    '关键词兜底仍是两条路, 两条都得带真写盘锚点');
  //
  // 2026-10-23 第 63 批: 这条断言原来数的是「dispatcher 源码里有几份【对账铁律】」,
  // 期望 4 —— 也就是说它**钉的是抄本份数**。
  // 综合提示词收成唯一真源(`modules/synth_prompt.js`)之后, dispatcher 里一份都不该有,
  // 4 条路径全部从真源拿 —— 本意(「四条路径都有对账铁律」)仍然成立, 但数法必须换。
  //
  // 旧判据的问题跟本批修掉的病灶是同一个: 数「有几份拷贝」永远只能证明
  // 「拷贝还在」, 证明不了「每条路径都拿到了」。抄本清零时它还会误报失败。
  // 新判据钉的是**机制**: 四条路径都走真源, 且真源里有这条规则 ⇒ 逻辑上必然成立。
  //
  // 第 89 批 (2026-10-25): 真源调用点从 3 变 **1** —— 因为综合的 system 消息
  //   收成了唯一拼装点 `_synthesisSystemMessages`, 四条路径全部经由它。
  //   判据同步换成**机制**: 不再数「有几处调用」(那是抄本份数), 而是钉
  //   「真源只调一次 + 这次就在拼装点里 + 四条路径都展开它」。
  //   强度对比: 旧判据允许「3 处各拼各的、只要长得一样就算过」⇒ 挂法可以分叉;
  //   新判据把挂法分叉直接判红 —— 2026-10-25 实跑撞的正是这个分叉
  //   (主路两条独立 system 消息 / 关键词兜底路合并成一条, 每条路单独看都通得过)。
  const calls = (SRC.match(/buildSynthesisSystemPrompt\(/g) || []).length;
  assert.equal(calls, 1,
    '综合提示词在 dispatcher 里只许被调 1 次 (唯一拼装点), 实际 ' + calls + ' 个 —— 有路径自己拼了');
  assert.match(SRC, /function _synthesisSystemMessages\(/,
    '找不到唯一拼装点 _synthesisSystemMessages');
  const spread = (SRC.match(/\.\.\._synthesisSystemMessages\(/g) || []).length;
  assert.ok(spread >= 2,
    '综合路径没有走拼装点 (展开调用 ' + spread + ' 处) —— 主路与关键词兜底路都该展开它');
  const { RULES } = require('../modules/synth_prompt');
  assert.match(RULES.RECONCILE_RULE, /【对账铁律】/,
    '对账铁律必须留在真源里 —— 它是 2026-10-13 那次整轮误判 partial 的根因防线');
  assert.match(RULES.RECONCILE_RULE, /真写盘/,
    '对账铁律必须点名真写盘清单');
});
