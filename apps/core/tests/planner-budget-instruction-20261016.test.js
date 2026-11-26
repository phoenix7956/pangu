// 2026-10-16 planner 的提示词层推理预算 —— 长任务的头号瓶颈
//
// 现场 longtask-234507 (本地 qwen3.8-27b, 5 步长任务):
//   planner 186s, 其中 160s 在思考 —— **7327 字 thinking 只换来 832 字 JSON 正文**。
//   后面 5 个子任务全在这个 planner 后面排队, 它慢一拍, 整条链就慢一拍。
//
// 根因: 提示词层预算指令**从来没到过 planner**。
//   `llm_caller._reasoningBudgetInstruction` 是本地模型唯一收得到的预算通道
//   (字段 reasoning_effort 在本地是空转的, 见该函数注释里的 N=5 实测), 但它只挂在
//   **主链路**的 soul 块上。planner 走自己的 runPlanner, system prompt 是
//   `ROLES.kan.system + 时间块 + 拆任务铁律` —— 一条预算指令都没有。
//
// 于是形成最坏的组合: `_effortForRole('planner', ...)` 算出了 medium (7a88fc4),
// 但那个 medium 只落在**空转的字段**上 —— "给了预算"和"预算生效"完全两回事。
// 长任务尤其吃亏: 短活能靠快路绕开 planner, 长任务不能。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');

const { _reasoningBudgetInstruction } = require('../modules/llm_caller');
const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const LOCAL = { id: 'qwen3.8-27b-mlx', provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234/v1' };

test('T1 planner 真的挂上了预算指令 (定义在 llm_caller ≠ 用在 planner)', () => {
  const src = SRC('agents/sub-agent.js');
  const planner = src.slice(src.indexOf('async function runPlanner'), src.indexOf('async function run('));
  assert.ok(/_reasoningBudgetInstruction/.test(planner),
    'runPlanner 必须调 _reasoningBudgetInstruction —— 否则预算只活在主链路, planner 永远收不到');
  // 预算块必须真的拼进 system prompt, 算出来却不用等于没做
  // 注意: 源码里是**转义序列** '\n\n' 六个字符, 不是真换行 ——
  // 用模板字符串写真换行会匹配不上 (今天已经被这个坑绊过一次)。
  assert.ok(planner.includes("(_budgetBlock ? '\\n\\n' + _budgetBlock : '')"),
    '算出来的预算块必须拼进 system message —— 算完不用等于没接');
});

test('T2 预算块排在 system 末尾 —— 越靠近 user 越压得住', () => {
  const src = SRC('agents/sub-agent.js');
  const planner = src.slice(src.indexOf('async function runPlanner'), src.indexOf('async function run('));
  const budgetIdx = planner.indexOf("(_budgetBlock ? '\\n\\n' + _budgetBlock : '')");
  const timeIdx = planner.indexOf('_timeBlock');
  const lawIdx = planner.indexOf('【拆任务铁律】');
  assert.ok(budgetIdx > timeIdx, '预算块要在时间锚点之后');
  assert.ok(budgetIdx > lawIdx, '预算块要在拆解铁律之后 (钉在最后, 不被前面的长指令稀释)');
});

test('T3 本地模型按档位给指令, 云端一个字都不加', () => {
  assert.ok(/推理预算: 中/.test(_reasoningBudgetInstruction({ ...LOCAL, reasoning_effort: 'medium' })));
  assert.ok(/推理预算: 低/.test(_reasoningBudgetInstruction({ ...LOCAL, reasoning_effort: 'low' })));
  assert.ok(/推理预算: 高/.test(_reasoningBudgetInstruction({ ...LOCAL, reasoning_effort: 'high' })));
  // 没给档 / 显式 off → 不产指令。注意是 null 不是 '' (调用方统一用 || '' 兜)
  assert.ok(!_reasoningBudgetInstruction({ ...LOCAL, reasoning_effort: '' }), '没给档就不该有指令');
  assert.ok(!_reasoningBudgetInstruction({ ...LOCAL, reasoning_effort: 'off' }), 'off 不该有指令');
  // 云端的 reasoning_effort 是真字段, 塞提示词指令等于告诉模型两遍, 还会稀释真字段
  assert.strictEqual(_reasoningBudgetInstruction({
    id: 'k3', provider: 'custom', endpoint: 'https://api.x.com/v1', reasoning_effort: 'high' }), null);
});

test('T4 用的是打了档的 requestModel, 不能拿没档的原始 model 去算', () => {
  // 档位是 runPlanner 的入参 reasoningEffort 算出来挂到副本上的;
  // 若拿原始 model (没这个字段) 去算, _reasoningBudgetInstruction 会返回 '' ——
  // 看起来"接了", 实际永远接不到值。
  const src = SRC('agents/sub-agent.js');
  const planner = src.slice(src.indexOf('async function runPlanner'), src.indexOf('async function run('));
  const reqIdx = planner.indexOf('const requestModel =');
  const useIdx = planner.indexOf('_reasoningBudgetInstruction(requestModel)');
  assert.ok(reqIdx > 0 && useIdx > reqIdx,
    '必须先算 requestModel 再拿它去取预算指令, 顺序反了就永远拿到空串');
});

test('T5 planner 的默认档仍然是 medium —— 这次修的是通道, 不是拿质量换速度', () => {
  const { _ROLE_REASONING_DEFAULT, _effortForRole } = require('../modules/j2_dispatcher');
  assert.strictEqual(_ROLE_REASONING_DEFAULT.kan, 'medium');
  assert.strictEqual(_effortForRole('kan', LOCAL, undefined), 'medium');
  // 主人显式指定永远优先
  assert.strictEqual(_effortForRole('kan', LOCAL, { reasoning_effort: 'low' }), 'low');
});

test('T6 主派发路径的子 agent 也走 _effortForRole (原来只有 planner 走)', () => {
  // 真源: j2_dispatcher 里子任务派发点。子 agent 走的是 j2_agent_loop 而非 subAgent.run,
  // 它的 soul 块里本来**就有** _reasoningBudgetInstruction —— 但前提是 model.reasoning_effort。
  // 原来这里只取主人的显式指定, 没给默认档 → 预算块是空的 → executor 每轮想 2434 字。
  // 2026-10-17: 子任务派发点连同 _effortForRole 一起搬进了 subagent_runner
  // (主 agent 复用同一份), 所以这条守卫得两个文件一起读。只读 dispatcher
  // 会显得"派发点没了", 但真相是它搬了家 —— 而漏看正是这条守卫要防的事。
  const src = ['modules/j2_dispatcher.js', 'modules/subagent_runner.js']
    .map((f) => SRC(f)).join('\n');
  assert.ok(/_requestedEffort\s*=\s*_effortForRole\(subTask\.agent/.test(src),
    '子任务派发必须走 _effortForRole, 否则 soul 里的预算块永远算不出内容');
  assert.ok(!/const _requestedEffort = opts\.reqBody && opts\.reqBody\.reasoning_effort;/.test(
    src.slice(src.indexOf('const _subModel = _roleModelFor'), src.indexOf('const _subModel = _roleModelFor') + 600)),
  '不能只读主人的显式档 —— 那等于没有默认档');
});

test('T7 executor 拿到档位后预算指令真能算出来 (端到端, 不只是表里有)', () => {
  const { _ROLE_REASONING_DEFAULT } = require('../modules/j2_dispatcher');
  const eff = _ROLE_REASONING_DEFAULT.kun;
  assert.ok(eff, 'executor 必须有默认档');
  const instr = _reasoningBudgetInstruction({ ...LOCAL, reasoning_effort: eff });
  assert.ok(instr && instr.length > 10,
    '默认档必须能翻译成一条真的提示词指令 —— 表里有值但算不出指令等于没接');
});

test('T8 checker 永远拿不到默认档 —— 拆验收比慢更糟', () => {
  const { _ROLE_REASONING_DEFAULT, _effortForRole } = require('../modules/j2_dispatcher');
  assert.strictEqual(_ROLE_REASONING_DEFAULT.checker, undefined,
    'checker 不许有默认档');
  assert.strictEqual(_effortForRole('checker', LOCAL, undefined), undefined);
  // 主人显式指定时仍然生效 (主人想给就给)
  assert.strictEqual(_effortForRole('checker', LOCAL, { reasoning_effort: 'high' }), 'high');
});
