const test = require('node:test');
const assert = require('node:assert/strict');

const {
  _ownerScopeBlock,
  _extractOwnerPaths,
  _inferDependsOn,
  _looksSequentialPlan,
} = require('../modules/j2_dispatcher');

// ─────────────────────────────────────────────────────────────────────────────
// 实案 longtask-01-20261012 (2026-10-12): 主人要一个 5 步计划, 结果 3 个 executor
// 并行写同一个报告文件, 后写的覆盖先写的, 盘古最后只能说
//   "5,624B 与 1,802B 两种冲突记录, 不能确认已正确生成"。
// 落盘报告其实是对的 (122 文件/37711 行/前 3 大分析), 但交付状态是 partial。
// 两个根因, 各一组断言:
//   A 跨子任务目标串味 —— 整句主人原话被塞给每个子 agent, 每个都以为要写报告
//   B planner 漏 depends_on —— 依赖只写在文字里, 没落成字段, 于是全并行
// ─────────────────────────────────────────────────────────────────────────────
const LONG_TASK_INPUT = '做一个 5 步计划并逐步执行：1) 列出 /Users/you/Desktop/pangu/apps/core/modules 下所有 .js 文件；'
  + '2) 统计这些文件的总行数；3) 找出其中超过 500 行的文件；4) 读取其中最大的 3 个文件的头 30 行；'
  + '5) 把汇总写成 markdown 报告写到 /tmp/longtask_report_20261012.md。每一步都真实用工具做，最后调 task_done 交付。';

// 现场真实落盘的 5 条 task 文本 (来自 ~/.pangu/subagent-runs.jsonl)
const REAL_TASKS = [
  '使用文件/命令工具递归列出 /Users/you/Desktop/pangu/apps/core/modules 下所有 .js 文件，并保存完整文件清单供后续步骤使用。',
  '基于步骤 1 的完整文件清单，逐个读取并统计行数，计算总行数，同时记录每个文件的行数。',
  '基于步骤 2 的逐文件行数，筛选出行数超过 500 的 .js 文件并列出结果。',
  '基于步骤 2 的逐文件行数确定最大的 3 个 .js 文件，依次读取每个文件的头 30 行，并记录文件路径、总行数和预览内容。',
  '将文件清单、总行数、超过 500 行的文件、最大 3 个文件及其头 30 行汇总为 Markdown，真实写入 /tmp/longtask_report_20261012.md；写入后检查文件存在且内容完整，最后调用 task_done 交付。',
];
const mk = () => REAL_TASKS.map((task) => ({ agent: 'executor', task }));

// ── A. 跨子任务目标串味 ──────────────────────────────────────────────────────
test('多子任务时: 子 agent 拿到的只有路径锚, 拿不到别的步骤的目标', () => {
  const block = _ownerScopeBlock(LONG_TASK_INPUT, 5);
  assert.ok(!block.includes('把汇总写成 markdown 报告'),
    '子 agent 绝不能被告知"写汇总报告" —— 那会让每个 executor 都去抢同一个文件');
  // 2026-10-13 改: 原来是 blanket「禁止调 task_done」, 但 soak-live-1791878818 现场证明
  // blanket 禁令与 j2 原生循环的完成判据 (taskDoneCalled) 直接打架 —— 子 agent 干完了也
  // 调不到那个工具, 烧完 3 次自动续跑退出为 partial (答案: 「无法实际调用 task_done」)。
  // 防串味的**本意**是「不许替别人收口 / 不许没干完就收口」, 那两条现在照样钉着。
  assert.ok(/禁止替别的步骤收口/.test(block), '必须禁止替别的步骤收口 (那是 longtask-01 的真坑)');
  assert.ok(/没干完不许调 task_done/.test(block),
    '必须写清收口纪律: 你这步做完才调, 没干完不许调 —— 调了这轮就结束, 早调等于交白卷');
  assert.ok(block.includes('/Users/you/Desktop/pangu/apps/core/modules'), '路径锚必须在 (这才是注入原话的正当理由)');
  assert.ok(block.includes('/tmp/longtask_report_20261012.md'), '产物路径也要锚住');
});

test('单子任务时: 原话照旧全量注入 (它本身就是任务, 收窄反而丢意图)', () => {
  const block = _ownerScopeBlock(LONG_TASK_INPUT, 1);
  assert.ok(block.includes('做一个 5 步计划并逐步执行'), '单子任务应保留完整原话');
  assert.ok(block.includes('/Users/you/Desktop/pangu/apps/core/modules'), '路径锚同样要在');
});

test('路径抽取不能把句号后面的散文一起吞进来', () => {
  const paths = _extractOwnerPaths(LONG_TASK_INPUT);
  assert.ok(paths.includes('/tmp/longtask_report_20261012.md'), '产物路径应被完整抽出');
  for (const p of paths) {
    assert.ok(!p.includes('。'), `路径里混进了句号后的散文: ${p}`);
    assert.ok(!p.includes('每一步'), `路径里混进了散文: ${p}`);
    assert.ok(!/[，。；、]/.test(p), `路径里混进了标点: ${p}`);
  }
});

test('非多步任务不该被加上"只做一个子任务"的围栏 (单问句保持原样)', () => {
  const single = _ownerScopeBlock('帮我查一下贵州茅台今天的股价', 1);
  assert.ok(!single.includes('禁止替别的步骤产出文件'), '单子任务不该套多步围栏');
});

// ── B. 漏填的 depends_on ─────────────────────────────────────────────────────
test('显式顺序计划 + 没声明依赖 = 全串行, 并报出缺陷 (不猜 3/4 并行)', () => {
  // 旧行为: 从 task 文字里扒「基于步骤 N」推出 1 → 2 → {3,4} → 5。
  // 那是读散文 —— 措辞变了, 调度就变了, 而且 {3,4} 并行是猜出来的。
  //
  // 新契约: 顺序计划里, 没声明 depends_on 的刀一律排在全部前置之后 (保守但正确),
  // 并且报进 undeclared。要 {3,4} 并行, planner 得自己写 depends_on —— 那是结构化字段。
  const tasks = mk();
  const r = _inferDependsOn(tasks, _looksSequentialPlan(LONG_TASK_INPUT));
  assert.ok(r.inferred > 0, '顺序计划里没声明的刀应该被排上队');
  assert.equal(tasks[0].depends_on, undefined, '第 1 步无上游');
  for (let i = 1; i < tasks.length; i++) {
    assert.deepEqual(tasks[i].depends_on, Array.from({ length: i }, (_, k) => k),
      '第 ' + (i + 1) + ' 步应排在全部前置之后 (盘古不猜 3/4 能并行)');
  }
  assert.ok(r.undeclared.length > 0,
    '"planner 没声明 depends_on" 必须报出来 —— 要 {3,4} 并行得让它自己写字段');
});

test('补出来的依赖不可能成环 (只认靠前下标)', () => {
  const tasks = mk();
  _inferDependsOn(tasks, _looksSequentialPlan(LONG_TASK_INPUT));
  tasks.forEach((t, i) => {
    for (const d of t.depends_on || []) {
      assert.ok(d >= 0 && d < i, `步骤${i + 1} 依赖了下标 ${d}, 会成环或越界`);
    }
  });
});

test('模型显式给了 depends_on 就原样尊重, 不覆盖', () => {
  const tasks = [
    { task: '第一步' },
    { task: '基于步骤 1 的东西', depends_on: [] },       // 显式空数组 = 声明自己独立
    { task: '基于步骤 2 的东西', depends_on: [99, 0] },  // 含越界项, 只保合法部分
  ];
  _inferDependsOn(tasks, true);
  assert.deepEqual(tasks[1].depends_on, [], '显式空数组是声明, 不能被覆盖');
  assert.deepEqual(tasks[2].depends_on, [0], '越界下标要滤掉, 合法部分保留');
});

test('非顺序的并行计划保持并行 (别把所有计划都串行化)', () => {
  const parallel = [
    '分析 A 模块的架构',
    '分析 B 模块的架构',
    '分析 C 模块的架构',
  ].map((t) => ({ agent: 'li', task: t }));
  const r = _inferDependsOn(parallel, _looksSequentialPlan('分析一下这三个模块'));
  assert.equal(r.inferred, 0, '三个独立分析不该被串起来');
  for (const t of parallel) assert.equal(t.depends_on, undefined);
});

test('顺序意图的识别: 显式顺序信号认, 普通单问句不认', () => {
  const yes = [
    LONG_TASK_INPUT,
    '按顺序做这三件事：1) 读文件 2) 改文件 3) 验证',
    '请依次完成下面几步：1) 备份 2) 升级 3) 验证',
  ];
  for (const s of yes) assert.equal(_looksSequentialPlan(s), true, `应判为顺序计划: ${s.slice(0, 30)}`);
  const no = [
    '帮我查一下贵州茅台今天的股价',
    '统计 modules 目录下每个 .js 的行数',
    '分析一下这三个模块的架构',
    '',
  ];
  for (const s of no) assert.equal(_looksSequentialPlan(s), false, `不应判为顺序计划: ${s.slice(0, 30)}`);
});
