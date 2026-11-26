const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { _stripGuaBlockForRouting } = require('../modules/j2_dispatcher');

const RULES_PATH = path.join(__dirname, '..', 'config', 'dispatch_rules.json');
const ROLES_PATH = path.join(__dirname, '..', 'agents', 'sub-agent.js');

// ─────────────────────────────────────────────────────────────────────────────
// 实案 sustained-route2-20261012 (证据取自 /tmp/pangu-single.log 的 [dispatcher-routing]):
//   raw          = "【盘古起卦 · 先于推理 …】…不要复述本块原文。\n逐个读取 …写到 /tmp/x.md…"
//   routingInput = raw                              ← 一模一样, 剥离根本没发生
//   role         = analyzer                         ← 被卦块标题里的"推理"命中
// 然后子 agent 答 "当前 Analyzer 没有生成 /tmp/x.md" —— 它确实没这个工具。
//
// 根因: 旧剥离正则是 /【盘古起卦[\s\S]*?主人问题:\s*/, 依赖 "主人问题: " 标记;
// 而这条路径上流到 dispatcher 的卦块**没有那个标记**, 正则永不匹配, 整块卦象留在
// 路由输入里, 卦象自己的词替主人投票。
// ─────────────────────────────────────────────────────────────────────────────
const QUESTION = '逐个读取 /Users/you/Desktop/pangu/apps/core/modules 目录下每一个 .js 文件的第一行，做成索引表写到 /tmp/x.md。不许抽样或跳过。';

// 2026-10-21 (当场逮住一次真回归): 卦块正文改了措辞 (去掉"卦象定调"这个会被模型
// 搬去开篇的短语, 去掉禁令式"不要复述本块原文"), 而剥离函数把收尾**句子**抄了一份
// 当标记 —— 两份同义文本各改各的, 改一次漂一次: 认不出收尾 → 整块卦象留在路由输入里
// → 卦象里的"推理/分析"替主人投票 → 任务被派给写不了盘的 analyzer。本文件 3 条当场红。
//
// 修法两处: ① 剥离改成按**行首**认 (—— 回答顺序), 不用行尾那句话;
//          ② 本文件的夹具改成**从生产格式化函数现取** —— 以后块正文怎么改, 夹具自动跟着变。
//          (测试夹具抄生产文本 = 给自己埋雷, delivery-truth-20261019 已经吃过一次。)
const { _formatGuaFirstBlock } = require('../modules/pangu_agent_stream');
const REAL_BLOCK = _formatGuaFirstBlock({
  gua_name: '未济', symbol: '䷿', upper_trigram: '离', lower_trigram: '坎',
  gua_ci: '未济，亨。', yao_name: '上九', moving_yao_ci: '上九：有孚于饮酒，无咎',
  wuxing: '水', yao_wuxing: '火', wuxing_rel: '水克火', liu_qin: '官鬼', position_nature: '极终',
});
// 三种实测形状 (都从生产块派生):
//   A = 头 + 收尾行 + 问题 (没有"主人问题:"标记, 也没有反幻觉提示行) ← 实测流到 dispatcher 的形状
//   B = 头 + 收尾行 + 反幻觉提示行 + 问题 (仍无标记)
//   C = 完整块 (带标记) + 问题
const _orderEnd = REAL_BLOCK.indexOf('\n', REAL_BLOCK.indexOf('—— 回答顺序'));
const SHAPE_A = REAL_BLOCK.slice(0, _orderEnd) + '\n' + QUESTION;
const SHAPE_B = REAL_BLOCK.replace(/主人问题:\s*$/, '').trimEnd() + '\n' + QUESTION;
const SHAPE_C = REAL_BLOCK + QUESTION;

function _matchRole(text) {
  const rules = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  const t = String(text || '').toLowerCase();
  let best = null;
  for (const [role, cfg] of Object.entries(rules)) {
    if (role === '_meta') continue;
    if (!cfg.skip_planner) continue;
    let score = 0;
    for (const kw of (cfg.keywords || [])) if (t.includes(kw.toLowerCase())) score += (cfg.weight || 1.0);
    if (score > 0 && (!best || score > best.score)) best = { role, score };
  }
  return best ? best.role : null;
}

test('剥离必须认"没有 主人问题: 标记"的那种卦块 (实测流到 dispatcher 的形状)', () => {
  const raw = SHAPE_A;
  assert.ok(!raw.includes('主人问题:'), '前提: 这个形状没有那个标记');
  assert.equal(_stripGuaBlockForRouting(raw), QUESTION);
});

test('剥离也必须认带标记 / 带反幻觉提示行的模板原样', () => {
  assert.equal(_stripGuaBlockForRouting(SHAPE_C), QUESTION);
  assert.equal(_stripGuaBlockForRouting(SHAPE_B), QUESTION);
});

test('没有卦块 / 空输入原样返回', () => {
  assert.equal(_stripGuaBlockForRouting(QUESTION), QUESTION);
  assert.equal(_stripGuaBlockForRouting(''), '');
  assert.equal(_stripGuaBlockForRouting(null), '');
});

test('剥完的路由输入里不能再有能替主人投票的卦象词', () => {
  const routed = _stripGuaBlockForRouting(SHAPE_A);
  assert.ok(!routed.includes('推理'), '卦块标题的"推理"不能进路由输入');
  assert.ok(!routed.includes('盘古起卦'), '卦块本体不能进路由输入');
  assert.ok(!routed.includes('分析'), '卦块里的"分析"不能进路由输入');
});

test('剥完必须落到 planner, 而不是写不了盘的 analyzer (真实路由判定)', () => {
  const routed = _stripGuaBlockForRouting(SHAPE_A);
  assert.equal(_matchRole(routed), null, '这个问题不该命中任何固定角色, 该走 planner');
  // 对照 (回归护栏): 不剥的话, 卦块里的"推理/分析"会替主人投票。
  //
  // 2026-10-16: 这条护栏的**对象**变了。原先断言的是"不剥 → 命中 analyzer",
  // 因为 analyzer 挂着 skip_planner, 卦块一个"推理"就能把任务从 planner 抢走。
  // 现在 analyzer 已经摘掉 skip_planner (见 longtask-decompose-20261016.test.js:
  // 那条通用模板任务会把任何"分析"类输入压成 1 刀), 卦块到不了 analyzer
  // 已经改由"它不再是固定流程"负责, 不再由剥离负责。
  //
  // 护栏因此从"点名某个角色"升级成结构断言 —— 它要防的是**这件事本身**:
  // 服务端自己拼上去的装饰, 永远不许改变对主人原话的路由判定。
  const raw = SHAPE_A;
  assert.equal(_matchRole(raw), _matchRole(QUESTION),
    '剥不剥卦块, 固定流程判定必须一致 —— 不一致就说明卦块在替主人投票');
  const hijacked = _matchRole(raw);
  assert.ok(hijacked === null || _matchRole(QUESTION) === hijacked,
    `卦块把路由带去了 ${hijacked}, 而主人原话根本命中不了这个角色`);
});

test('派到 li 就注定完不成 —— li 白名单里没有写盘工具', () => {
  // 2026-10-18 拼音统一: 按源码里 ROLES 字面量的位置切片, 所以键名必须跟着换。
  // 断言内容不变 —— li 仍不许有写盘工具, kun 仍必须有 write_file。
  const src = fs.readFileSync(ROLES_PATH, 'utf8');
  const analyzerBlock = src.slice(src.indexOf('li: {'), src.indexOf('kun: {'));
  assert.ok(!/write_file|file_edit/.test(analyzerBlock),
    'li 有了写盘工具 —— 那 sustained 路由的破坏性就没了, 这条断言要跟着更新');
  const executorBlock = src.slice(src.indexOf('kun: {'), src.indexOf('zhen: {'));
  assert.ok(/write_file/.test(executorBlock), 'kun 必须仍然有 write_file');
});

test('dispatcher 真的用上了这个剥离 (别只导出一个没人调的函数)', () => {
  const src = fs.readFileSync(require.resolve('../modules/j2_dispatcher.js'), 'utf8');
  assert.match(src, /const _routingInput = _stripGuaBlockForRouting\(userInput\);/,
    '路由输入必须走新的剥离函数');
  assert.doesNotMatch(src, /_routingInput = String\(userInput \|\| ''\)\s*\.replace\(\/【盘古起卦/,
    '旧的"依赖 主人问题: 标记"的剥离不能还留在路由路径上');
});
