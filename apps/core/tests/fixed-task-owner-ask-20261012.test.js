const test = require('node:test');
const assert = require('node:assert/strict');
const { _fixedTaskPrompt, _fixedFlowGroups } = require('../modules/j2_dispatcher');

test('承载主人诉求的首个子任务必须单独一组先跑 (会话 resume-05 时序竞态)', () => {
// 现场: #0 从 ts ...378111 开始写盘, #2/#3 在 ...377165 就已经在查那个文件 →
// 答复报"文件不存在、终态 0 bytes", 而磁盘上明明有 13 行。
const tasks = TEMPLATES.map((t) => ({ task: t, agent: 'checker' }));
const groups = _fixedFlowGroups(tasks);

assert.equal(groups[0].length, 1, '承载诉求的首个子任务不能跟别人挤在同一组并行');
assert.equal(groups[0][0].i, 0, '首发组必须是第 0 个子任务');
assert.ok(groups.length >= 2, '首发跑完之后, 其余同角色子任务才并行');
const flat = groups.flat().map((x) => x.i).sort((a, b) => a - b);
assert.deepEqual(flat, [0, 1, 2, 3, 4], '分组不能漏任务也不能重复');
});

test('非首发任务仍按"连续同角色"合并并行 (别把并行度削没了)', () => {
const tasks = [
{ task: 't0', agent: 'checker' },
{ task: 't1', agent: 'checker' },
{ task: 't2', agent: 'checker' },
];
const groups = _fixedFlowGroups(tasks);
assert.equal(groups.length, 2, '首发一组 + 其余并行一组');
assert.equal(groups[1].length, 2);
});

// 2026-10-18 老板截图: «5 个子 agent, 全是兑, 那意义在哪?» —— 问出了 self_checker 的第 5 条。
//
// 实机 (session 80004976): 5 条 fixed_task 里有 2 条 ZERO_CONTENT_TIMEOUT_300s
// (633.2s 和 300.0s), 整轮 15 分半。
//
// 根因不是并行 (并行是有意的, 上面那条测试守着), 是**第 5 条本身多余**:
//   self_checker.fixed_tasks 第五条 = "综合输出：状态报告"
// 而父级收口本来就会综合 —— j2_dispatcher.js:1538:
//     safeResWrite(res, 'status', { stage: 'synthesis', message: '盘古正在综合各子 agent 结果...' });
//     finalText = await _synthesizeStreamText(summaryMessages, model, res, 'dispatcher');
// 所以那一条既重复, 又因为同角色被 _fixedFlowGroups 归进并行批次, 在它要综合的
// 那 4 份事实到齐**之前**就开跑。删掉它, 综合统一交给父级。
test('fixed_task 不许跟父级 synthesis 重复 (综合只有父级做)', () => {
  const path = require('node:path');
  const rules = JSON.parse(require('node:fs').readFileSync(
    path.join(__dirname, '..', 'config', 'dispatch_rules.json'), 'utf8'));

  for (const [role, cfg] of Object.entries(rules)) {
    if (role === '_meta' || !cfg || !Array.isArray(cfg.fixed_tasks)) continue;
    for (const t of cfg.fixed_tasks) {
      assert.doesNotMatch(t, /^综合输出|综合汇总|汇总输出/,
        `${role}.fixed_tasks 里不许有"综合输出"这类条目 —— 父级 synthesis 已经做一遍了, ` +
        '子 agent 再做一次是重复劳动, 还会被 _fixedFlowGroups 归进并行批次抢跑');
    }
    // agents 与 tasks 一一对应, 多出来的 agent 会造出空任务 (count 取 min, 但配置会误导人)
    if (Array.isArray(cfg.fixed_agents)) {
      assert.equal(cfg.fixed_agents.length, cfg.fixed_tasks.length,
        `${role}: fixed_agents 与 fixed_tasks 必须一一对应, 不许一边多一边少`);
    }
  }
});

test('self_checker 不再写死扇出个数 —— 体检由盘古自己拆 (2026-10-18 老板拍)', () => {
  // 这条测试原先断言「self_checker 剩 4 项, 首发 1 + 其余 3 并行」。
  // 4 是**人写进配置的**, 老板的原话是 «那问题就应该盘古判断几个agent并发,
  // 不是人为控制agent并发» —— 那条断言就是「人为控制」本身的化石, 必须一起走。
  //
  // 现在守两件事:
  //   ① 配置里不再有任何人写死的扇出名单 (self_checker 只剩关键词 + 权重)
  //   ② _fixedFlowGroups 这套分组机制本身没被写坏 —— 它还在, 只是现在没人配它了
  //      (真·写死的协议仍然可以用, 机制保留当逃生舱)
  const path = require('node:path');
  const rules = JSON.parse(require('node:fs').readFileSync(
    path.join(__dirname, '..', 'config', 'dispatch_rules.json'), 'utf8'));
  const sc = rules.self_checker;
  assert.equal(sc.skip_planner, undefined,
    'self_checker 不该再配 skip_planner —— 体检该由盘古自己拆, 不是配置里写死 4 刀');
  assert.equal(sc.fixed_agents, undefined, 'fixed_agents 是写死的扇出名单, 该删');
  assert.equal(sc.fixed_tasks, undefined, 'fixed_tasks 是写死的刀数, 该删');
  assert.ok(Array.isArray(sc.keywords) && sc.keywords.length,
    'keywords 还在 —— 角色仍然是关键词路由的一等公民, 只是不再自带一套固定流程');

  // 机制本身: 4 个同角色任务 → 首发单独一组 + 其余三个并行。
  // 用构造的列表测机制, 不再用配置里的真名单 (那才是把个数又钉回配置了一次)。
  const groups = _fixedFlowGroups(Array.from({ length: 4 }, (_, i) => ({
    agent: 'checker', task: '检查项' + i,
  })));
  assert.equal(groups.length, 2, '首发一组 + 其余三项并行一组');
  assert.equal(groups[0].length, 1, '承载主人诉求的首发项不能跟别人挤在一组');
  assert.equal(groups[1].length, 3, '其余三项是互相独立的检查, 该并行');
});

test('上游只吐了 event:error 就断了 — 不许报成 JSON 语法错', () => {
  // 2026-10-18 实机 (session 80053699, «做个全面体检» 四条 checker 全挂):
  //   卡片上写的是 `Unexpected token 'e', "event: err"... is not valid JSON`
  //
  // 完整链条: 上游 body 形如 `event: error\n...` (**有 event 行, 没有 data 行**)
  //   → llm_caller 非流式路径 JSON.parse(data) 抛语法错
  //   → 兜底 _parseSSEBody(data) 的守卫是"有没有 data: 行", 没有就 return null
  //   → throw 原始语法错 → 上层套上「解析响应失败: 」
  //   → **上游真正发生的事 (响应被切断 / 连接重置) 一个字都没透出来**
  //
  // 同批还有 ECONNRESET (与前两轮实机撞到的是同一族): 本地 27B 长请求被切断。
  // 所以这不是解析器的错, 是**错误被伪装成了另一个错误** —— 看到 JSON 语法错
  // 会去查解析器, 真因在上游那一侧, 查错方向。
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'modules', 'llm_caller.js'), 'utf8');
  const i = src.indexOf('function _parseSSEBody(');
  assert.ok(i > 0, '要能找到 _parseSSEBody');
  const seg = src.slice(i, i + 1400);
  // 认出 event:error 帧 (含没有 data 行这一档)
  assert.match(seg, /event:\\s/,
    '要解析 event: 行, 不能只盯着 data: 行 —— 只有 event 行正是被切断的那种形态');
  assert.match(seg, /error\|fatal/,
    '只对 error/fatal 事件这样处理 (正常事件没有 data 行不算错)');
  // 报上游错误, 并打 __upstreamSSE 让上层别再套「解析响应失败」的壳
  assert.match(seg, /__upstreamSSE\s*=\s*true/,
    '新造的错误必须打 __upstreamSSE 标记, 否则上层还会套「解析响应失败」前缀');
  assert.match(seg, /响应在 event 行之后被切断|被切断/,
    '错误文案要说清"响应被切断", 让人往上游/超时方向查, 而不是查解析器');
  // 老的 data-行-带错误载荷 那档不能被弄坏
  assert.match(src, /function _upstreamSSEError\(/,
    '_upstreamSSEError (data 行带错误载荷) 那一档必须还在');
});
// 现场证据链 (2026-10-12, 会话 resume-01 / resume-02):
//   resume-01 (判重修之前): 5 个 fixed_flow checker 的 task 开头全是
//     "[上文-仅供你参考...] 问事者: <主人本轮原话>" → 同一份索引被追加 3 次 (39 行 = 13×3)
//   resume-02 (判重修之后): 上文块干净了 (0 命中), 但产物根本不存在 ——
//     fixed_tasks 是模板 (检查环境/架构/运行状态/工具清单/综合), 主人这轮的真实诉求
//     根本不在模板里, 旧代码是靠那条泄漏顺带捎进去的。
// 正解: 主人诉求只交给第 1 个子任务独家执行, 其余子任务明说已有人接。

const OWNER = '体检一下 /Users/you/Desktop/rea: 把 .py 索引追加到 /tmp/ck_proof2.md';
const MARK = '把 .py 索引追加到';
const TEMPLATES = [
  '检查系统环境：主机名、CPU、内存、负载、网络',
  '检查 Agent 架构：8 角色列表、工具集、边界规则',
  '检查运行状态：进程监控、关键文件存在性',
  '检查工具清单：exec/file/network/code/memory 各分类',
  '综合输出：状态报告',
];
const build = (n) => TEMPLATES.slice(0, n).map((t, i) => _fixedTaskPrompt({ task: t }, i, n, OWNER, ''));

test('主人诉求只交给一个子任务, 不能每个都塞一份', () => {
  const out = build(5);
  const hits = out.filter((t) => t.includes(MARK));
  assert.equal(hits.length, 1,
    `主人诉求出现在 ${hits.length} 个子任务里 —— 每个都以为该干这活, 产物会重复追加`);
  assert.ok(out[0].includes(MARK), '第一个子任务必须真的拿到诉求');
});

test('其余子任务要明说诉求已有人接, 不许碰', () => {
  const out = build(5);
  for (const t of out.slice(1)) {
    assert.match(t, /独家执行|不要碰/, '非首发子任务必须知道这轮诉求已有人接');
    assert.ok(!t.includes(MARK), '非首发子任务不该拿到诉求正文');
  }
});

test('单子任务流程: 诉求全量注入, 不设"已有人接"那套', () => {
  const out = _fixedTaskPrompt({ task: '检查系统环境' }, 0, 1, OWNER, '');
  assert.ok(out.includes(MARK), '只有一个子任务时诉求当然要全给它');
  assert.doesNotMatch(out, /不要碰/, '单子任务不该被告知"已有人接"');
});

test('真正的上一轮上文照样带 (别被这次改动吃掉)', () => {
  const out = _fixedTaskPrompt({ task: '检查系统环境' }, 1, 3, OWNER, '[上文] 问事者: 我刚才说我叫什么');
  assert.ok(out.includes('我刚才说我叫什么'), '子 agent 接上文的能力不能因为防串味被砍掉');
});

test('不许再往每个子任务里灌"你可能只有一轮工具机会" (2026-10-12 现场)', () => {
  for (const t of build(5)) {
    assert.doesNotMatch(t, /只有一轮工具执行机会/,
      '这话是在开工前就劝模型收尾 —— 长任务被劝退的prompt 层根因');
  }
});


test('带卦块的 userInput: 诉求正文必须真的进到提示里 (会话 resume-04)', () => {
// 现场: 承载子 agent 的 task 变成 "…【本轮主人的真实诉求 — 你负责执行…】【盘古起卦…】…",
// 600 字符全被卦块模板吃掉, 主人诉求落在切片外 → 该子 agent 0 次工具调用。
const GUA = '【盘古起卦 · 先于推理 (梅花易数, 64i 真卦辞爻辞)】 本卦: 旅 ䷷「旅，小亨，旅贞吉。」 | 动爻: 初六「初六：旅琐琐，斯其所取灾」 | 之卦: 离 䝣「离，利贞亨。」 五行: 火 | 六亲: 父母 | 爻位性质: 身本 —— 回答顺序 (2026-10-09 老板定): **先给已核实的事实/结论**(工具返回的数字与证据), 卦象只作补充。\\n不要复述本块原文。\\n主人问题: ';
const out = _fixedTaskPrompt({ task: TEMPLATES[0] }, 0, 5, GUA + OWNER, '');

assert.ok(out.includes(MARK), '主人诉求正文必须真的进到提示里, 不能被卦块挤掉');
const _askAt = out.indexOf(MARK);
assert.ok(_askAt < 200, '诉求正文必须紧跟诉求标记出现, 不能埋在几百字卦块后面');
});
