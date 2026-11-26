// 2026-10-16 planner 的推理预算
//
// 现场 v3-034204, 主人问"建 2 个文本文件", 盘古总共跑了 398 秒:
//   planner 115s / executor 95s / checker 119s / synthesis 68s —— 四刀串行,
//   每刀都是一次大上下文的 27B 推理调用 (单刀 ~58s 是底价)。
//
// planner 那 115s 的构成 (72 个 sub_progress 采样点逐段可查):
//   2.5s 思考 3 字 → 105s 思考 6034 字 → 113s 正文才 416 字
// **113 秒在思考, 8 秒在输出**。而它要吐出来的只是一个 JSON 拆解。
//
// 本地模型的 reasoning_effort 字段是空转的 (llm_caller 的 N=5 实测: 字段原样发出去,
// 模型侧 "No valid custom reasoning fields found"), 盘古早已改走提示词层预算指令。
// 同题实测挂 [推理预算: 中]: 24.2s → 17.0s, 思考 973 → 491 字。
//
// 这几条测的是**三条边界一条都不能松**: 主人的选择 > 云端原样 > 默认档。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');

const M = (p) => require(path.join(__dirname, '..', p));
const dispatcher = M('modules/j2_dispatcher.js');
const { _effortForRole, _ROLE_REASONING_DEFAULT } = dispatcher;
const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const LOCAL = { id: 'qwen3.8-27b-mlx', provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234/v1' };
const CLOUD = { id: 'k3', provider: 'custom', endpoint: 'https://api.example.com/v1' };

test('T1 主人显式指定的档位永远优先, 任何角色任何模型都不许覆盖', () => {
  for (const role of ['kan', 'kun', 'dui']) {
    assert.strictEqual(_effortForRole(role, LOCAL, { reasoning_effort: 'high' }), 'high',
      `主人说了 high, ${role} 就必须是 high`);
    assert.strictEqual(_effortForRole(role, CLOUD, { reasoning_effort: 'off' }), 'off',
      `主人说了 off, ${role} 就必须是 off`);
  }
});

test('T2 本地模型 + 主人没指定 → planner 拿默认档', () => {
  assert.strictEqual(_effortForRole('kan', LOCAL, undefined), 'medium');
  assert.strictEqual(_effortForRole('kan', LOCAL, {}), 'medium');
});

test('T3 云端模型不动 —— 它的 reasoning_effort 是真字段, 各家默认值本来就不是 high', () => {
  // 2026-10-16 修订: 这条断言的前提 ("云端各家默认值本来就不是 high") 是**没验证过的
  // 普遍假设**, 直连实测把它否掉了 —— 但只否掉了 MiniMax 一家, 不是所有家。
  //   MiniMax-M3.1-Flash-Preview, 同一道题 (读一个 125 行文件出报告):
  //     不发字段           29.27s  思考 16847 字符  正文 **0**
  //     reasoning_effort=low  3.92s  思考   418 字符  正文 544
  //     reasoning_effort=medium 4.59s 思考  649 字符  正文 633   ← 正文最多
  //     reasoning_effort=high   5.61s 思考 1236 字符  正文 555
  //   "不发的默认值" 不是不高, 是**非常高** —— 16847 字符思考把 max_tokens 吃干净,
  //   正文一个字没产出。那种"默认就克制"的想当然, 让云端每一刀白烧 29 秒。
  //
  // 但反过来也不能推广成"云端一律塞 low": K3 之类的家默认到底多高, 这里**没有实测**。
  // 所以处置不是断言云端要不要发, 而是:
  //   ① 角色表对云端**不再一律跳过** (跳过等于把未验证的假设当公理);
  //   ② **逐家校准**仍由模型配置说话 —— 配置里分过档的, 压过角色表 (见 T3b)。
  // 谁家默认克制, 主人在配置里写 'off' 或 'high' 即可, 不靠盘古替它猜。
  const cloudNoCfg = _effortForRole('kan', CLOUD, undefined);
  assert.notStrictEqual(cloudNoCfg, undefined,
    '云端配置里没分过档时不该一律跳过 —— 那等于把"各家默认不高"这个没验证的假设当公理');
  assert.ok(cloudNoCfg === 'medium',
    `planner 仍取 medium (拆解质量是命根子), 实际 ${cloudNoCfg}`);
});

test('T3b 逐家校准压过角色表 —— 配置里分过档的照配置走', () => {
  // MiniMax 实测 medium 正文最多 (633) 所以配置就写 medium, 这条让它压过
  // 角色表的 planner=medium / analyzer=low, 而不是被角色表改掉。
  assert.strictEqual(
    _effortForRole('li', { ...CLOUD, reasoning_effort: 'medium' }, {}), 'medium',
    '配置里分过档的模型不许被角色默认表改写 —— 那是逐家校准的成果');
  assert.strictEqual(
    _effortForRole('kan', { ...CLOUD, reasoning_effort: 'high' }, {}), 'high',
    '主人给某个模型调高推理深度, 不许被角色表悄悄压回 medium');
  assert.strictEqual(
    _effortForRole('li', { ...CLOUD, reasoning_effort: 'auto' }, {}), 'low',
    'auto = 没分过档, 该落到角色表');
});

test('T4 checker/analyzer/bug_hunter 一个都不许动 —— 削弱判断角色 = 削弱长任务验收', () => {
  // 2026-10-16 修订 (原断言把 executor 也列进来, 那时它还没默认档):
  // 实测 5 步长任务 (longtask-234507) executor 正文 70 字 / 思考 2434 字 = 34:1,
  // 确定性的小活烧掉整条链的时间 → executor **该**有默认档。
  // 但 checker 依然不许动: 它的价值就是"别相信上一刀的自述", 多想才敢判 PASS/FAIL。
  // 削它 = 拆长任务的验收环节, 那正是 longtask-01-20261012「做对了却报 partial」的根因类别。
  for (const role of ['dui', 'xun', 'zhen', 'gen', 'dispatcher', 'synthesizer']) {
    assert.strictEqual(_effortForRole(role, LOCAL, undefined), undefined,
      `${role} 是判断角色, 不该被默认预算收走推理深度`);
  }
  // 2026-10-16: analyzer 是唯一被从这张名单里放出去的, 因为只有它被实测过。
  //   实测: analyzer 读一个 125 行文件, 不发字段时思考 16847 字符 / 正文 0,
  //   low 时思考 418 / 正文 544 —— 它是纯取证活, 证据在工具结果里, 推演不出新东西。
  //   checker / bug_hunter 这几个**没测过降档后判断质量会不会退化**, 就先不动:
  //   削 checker = 拆验收环节 (longtask-01-20261012「做对了却报 partial」的根因类别),
  //   那个风险已经踩过一次, 不拿没测量的提速去换。
  //   真要动它们, 先测"同一批汇报在 low 与 medium 下判 PASS/FAIL 是否一致"。
  assert.strictEqual(_effortForRole('li', LOCAL, undefined), 'low',
    'analyzer 是唯一实测过过度思考的取证角色, 该有默认档');
  assert.strictEqual(_ROLE_REASONING_DEFAULT.li, 'low');
  // 2026-10-16 再修订 (现场 lt5, 同一道 5 步题): 上一版这里钉死 executor=medium,
// 理由是"low 会把写盘做糙"。那条理由来自 longtask-234507 的一次测量
// (executor 思考 2434 字 / 正文 70 字 = 34:1) —— 按那次的数据, medium 是稳妥的。
  //
  // lt5 把前提换掉了: executor 拿 medium 时单轮 thinking **9694 字**, 流式调用直接
// 顶到 STREAM_TOTAL_TIMEOUT_300s。而它那一刀干的是「往 u1.txt 写 3 行
// alpha/beta/gamma」。日志里 297 条「推理预算: 中」证明指令发到了, 不是没生效。
  //
  // 于是原来的取舍前提没了: medium 的风险不是"写得糙一点", 是**整轮超时、一个字
  // 都不产出**。"糙"还有账本和 checker 兜着, "超时"是直接交白卷 —— 后者严重得多。
  // 所以判据从"不许 low"改成"不许再回到 medium", 依据是 300s 超时这个更大的失败。
  // 真的出现"low 导致写盘做糙", 正确的修法是给输出加硬上限 (截 runaway 思考),
  // 不是把 medium 放回来 —— 那等于把一个已知会超时的配置请回来。
  assert.strictEqual(_effortForRole('kun', LOCAL, undefined), 'low');
  assert.strictEqual(_ROLE_REASONING_DEFAULT.kun, 'low');
  assert.notStrictEqual(_ROLE_REASONING_DEFAULT.kun, 'medium',
    'executor 回 medium = 9694 字 thinking 顶爆 300s 流式墙的老账 (现场 lt5)');
});

test('T5 用 medium 不用 low —— 拆解质量是命根子, 不拿它换速度', () => {
  assert.strictEqual(_ROLE_REASONING_DEFAULT.kan, 'medium');
  assert.notStrictEqual(_ROLE_REASONING_DEFAULT.kan, 'low',
    'low 会把拆解也压成拍脑袋, 这是拿命根子换速度');
});

test('T6 接线: planner 那次调用真的用上了它 (参数存在 ≠ 那条路用了它)', () => {
  const src = SRC('modules/j2_dispatcher.js');
  const plannerCall = src.slice(src.indexOf('plan = await subAgent.run('),
    src.indexOf('plan = await subAgent.run(') + 1600);
  // 2026-10-18 拼音统一: 角色名 planner → kan, 字面量跟着换, 意图不变。
  // 只认规范名 'kan' —— 写成"两个都认"就把断言放松了, 那正是这组测试要防的事。
  assert.ok(/reasoningEffort:\s*_effortForRole\('kan', model, opts\.reqBody\)/.test(plannerCall),
    'planner 调用点必须走 _effortForRole, 否则这个默认档是空转的');
  // 直答那条路的档位不能被顺手改掉
  assert.ok(/reasoningEffort:\s*opts\.reqBody && opts\.reqBody\.reasoning_effort/.test(src),
    '直答/单 agent 路径的档位必须原样保留');
});
