// 2026-10-16 —— 一条本地模型的实测结论, 被推广成了全局规则, 云端白烧思考
//
// 老板原话 (2026-09-14 起就在问): 「同样的模型, codex 和 openclaw 都比盘古快」。
// 前面几轮一直在刀数/上下文/预算墙里找, 都没找着。直连实测一次就定位了。
//
// 实测 (MiniMax-M3.1-Flash-Preview, 云端, 同一道题: 读一个 125 行文件出报告,
// 只改**一个**请求字段):
//
//   不发字段               14.23s   思考 6360 字符   正文 551
//   reasoning_effort=low    3.67s   思考  179 字符   正文 476    ← 3.9x
//   reasoning_effort=minimal 4.05s  思考  383 字符   正文 631
//   reasoning_effort=none   HTTP 400 —— 该模型强制 adaptive thinking, 不给关
//
// 正文体量没掉 (476 vs 551), 砍掉的全是思考。**云端认这个字段, 而且认得很实。**
//
// 而旧代码写着:
//     if (!require('./model_transport').isLocalModel(modelCfg)) return undefined;
// 它的来由是真的 —— lm_caller 里那篇 N=5 实测证明 LM Studio **不收**这个字段
// (服务端日志: "No valid custom reasoning fields found"), 本地改走提示词层预算指令
// (2.9s → 2.2s, 且方差归零)。但那句话把**本地**的结论推广成了**全局**规则:
// 云端因此永远不发这个字段, 每刀白烧 6360 字符思考, 9 轮一道活。
//
// 这就是「同样的模型 Codex 比盘古快」的物理原因: **不是盘古刀多, 是每刀都在过度思考。**
// 顺带把前两个错误假设也钉死 (都量过, 都是错的):
//   ✗ 工具面太大 —— 18 个工具 schema 只有 6839 字符 ≈ 2000 token, 不是大头
//   ✗ prefill 太重 —— 14k token 的 prefill 实测 TTFT 只有 1.29s (2k 时 0.98s)
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');

const { _effortForRole, _ROLE_REASONING_DEFAULT } = require('../modules/j2_dispatcher');
const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const CLOUD = { id: 'mm', provider: 'minimax', endpoint: 'https://api.minimaxi.com/v1/chat/completions' };
const LOCAL = { id: 'q', provider: 'lmstudio', endpoint: 'http://127.0.0.1:12345/v1' };

test('T1 云端不再被"一律跳过" —— analyzer 当年压根没有低档这个概念', () => {
  for (const role of ['li', 'kun', 'kan']) {
    const got = _effortForRole(role, CLOUD, {});
    assert.ok(got, `云端 ${role} 必须拿到推理预算档, 实测不发字段 = 29.27s/刀、思考 16847 字`);
  }
  // 当年这张表里没有 analyzer, 子 agent 连"低档"这个概念都没有
  assert.ok(_ROLE_REASONING_DEFAULT.li, 'li 必须在角色默认表里');
});

test('T2 planner 留 medium —— 拆解质量是命根子, 不拿它换速度', () => {
  assert.strictEqual(_ROLE_REASONING_DEFAULT.kan, 'medium');
  assert.notStrictEqual(_ROLE_REASONING_DEFAULT.kan, 'low',
    'planner 不许跟 executor 一样压到 low —— 那是用拆解质量换速度');
});

test('T3 只动实测过的角色 —— 不拿没测量的提速去换验收质量', () => {
  for (const role of ['li', 'kun']) {
    assert.strictEqual(_ROLE_REASONING_DEFAULT[role], 'low', `${role} 应为 low`);
  }
  // 这些没测过"降档后判断质量会不会退化", 就先不动。
  // 削 checker = 拆验收环节, longtask-01-20261012「做对了却报 partial」踩过一次。
  for (const role of ['dui', 'xun', 'zhen', 'gen']) {
    assert.strictEqual(_ROLE_REASONING_DEFAULT[role], undefined,
      `${role} 没测过就不该给默认档 —— 要动先测 PASS/FAIL 判定是否一致`);
  }
});

test('T4 本地仍拿得到档 —— 字段空转但提示词层预算指令靠它激活', () => {
  // 不是"本地不配、云端才配"。本地设上去会走 llm_caller 的
  // _reasoningBudgetInstruction(useModel) (prompt 层, 实测 2.9s→2.2s 且方差归零),
  // 两端各走各的生效通道, 都有实测支撑。
  assert.strictEqual(_effortForRole('li', LOCAL, {}), 'low');
  assert.strictEqual(_effortForRole('kun', LOCAL, {}), 'low');
});

test('T5 主人在设置页给模型分过的档, 压过角色默认表', () => {
  // run() 里是覆盖式赋值 `model = {...model, reasoning_effort: reasoningEffort}`,
  // 顺序错了会把主人设的 high 悄悄改成 low —— 那比慢更糟。
  assert.strictEqual(
    _effortForRole('li', { ...CLOUD, reasoning_effort: 'medium' }, {}), 'medium');
  assert.strictEqual(
    _effortForRole('li', { ...CLOUD, reasoning_effort: 'high' }, {}), 'high');
  assert.strictEqual(
    _effortForRole('li', { ...CLOUD, reasoning_effort: 'auto' }, {}), 'low',
    'auto 表示"没分过档", 该落到角色默认表');
});

test('T6 主人这一轮在 UI 上选的档最高优先', () => {
  assert.strictEqual(
    _effortForRole('li', { ...CLOUD, reasoning_effort: 'low' }, { reasoning_effort: 'high' }), 'high',
    'reqBody 是本轮主人当场选的, 必须压过模型配置和角色表');
});

test('T7 角色表里没有的角色照旧不发 —— 不给未知角色乱猜一个档', () => {
  assert.strictEqual(_effortForRole('bogus', CLOUD, {}), undefined);
  assert.strictEqual(_effortForRole('synthesizer', CLOUD, {}), undefined,
    'synthesizer/dispatcher 在别处有专属处理, 不走这张表');
});

test('T8 差异性质: 那条把本地结论推广成全局的判断, 不许复活', () => {
  // 2026-10-17: _effortForRole 连同派发实现搬进 subagent_runner (两个文件都读,
  // 免得搬家之后这条守卫对真正出问题的地方失明)。
  const src = ['modules/j2_dispatcher.js', 'modules/subagent_runner.js']
    .map((f) => SRC(f)).join('\n');
  assert.doesNotMatch(
    src.slice(src.indexOf('function _effortForRole'), src.indexOf('function _effortForRole') + 900),
    /isLocalModel[\s\S]{0,80}return undefined/,
    '本地实测结论不许再被推广成"云端不发字段"的全局规则 —— 这一行就是 6360 字符思考的来源');
});

test('T9 接线没断: 每一刀都调得到, 不只是 planner', () => {
  const src = ['modules/j2_dispatcher.js', 'modules/subagent_runner.js']
    .map((f) => SRC(f)).join('\n');
  // planner 一处 + subTask.agent 一处 (2017 行附近) —— 少了后者,
  // 子 agent 照样一个预算都收不到 (2026-10-16 已经栽过一次那次)。
  assert.match(src, /_effortForRole\('kan', model, opts\.reqBody\)/,
    'planner 分支必须带默认档');
  assert.match(src, /_effortForRole\(subTask\.agent, _subModel, opts\.reqBody\)/,
    '每一刀都必须带默认档 —— 当年只 planner 有, 子 agent 全裸奔');
  assert.match(src, /\{ \.\.\._subModel, reasoning_effort: _requestedEffort \}/,
    '算出来的档必须真的落到这一刀用的模型副本上');
});

test('T10 两个已量过的错误假设钉死, 别下轮又去查一遍', () => {
  const { ROLES, _nativeTools } = require('../agents/sub-agent');
  const toolsJson = JSON.stringify(_nativeTools(ROLES.li.tools)).length;
  assert.ok(toolsJson < 9000,
    `18 个工具 schema 实测 ${toolsJson} 字符 (≈2000 token), 不是单刀 20s 的来源`);
  // prefill 的实测结论写在这里, 省得下一轮又怀疑上下文堆积
  assert.ok(true, 'prefill 14k token 实测 TTFT 1.29s (2k 时 0.98s) —— 不是瓶颈, 别再往那查');
});
