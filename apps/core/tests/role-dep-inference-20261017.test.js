const test = require('node:test');
const assert = require('node:assert/strict');

const { _inferDependsOn } = require('../modules/j2_dispatcher');

// ─────────────────────────────────────────────────────────────────────────────
// 实案 tl-1792194596414 (2026-10-17, 老板那道「查清楚盘古现在的模型池」题)
// planner 拆得完全正确 —— 2 刀: 离读配置, 兑验收。但推出的依赖是 0 组:
//   23:49:59.360 start 离
//   23:49:59.371 start 兑     ← 隔 11ms, 同层并发
//   23:51:04.784 done  兑     ← 审了个空 → 判 partial → 触发补救循环
//   23:51:18.695 done  离     ← 它要审的东西 14 秒后才交付
// 补救循环又烧 200 秒重推同一张表, 而正确答案早就出来了。
//
// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-18 架构修正 —— 这份文件为什么整个重写
//
// 旧版靠 `_roleDepsFromText` 修这个现场: 从 task 文字里**扒角色名**
// ("仅依据上游 li 的汇报结论" → 认出 li → 挂过去), 外加两层正则扒中文连接词
// 和步骤编号。四层兜底里只有 depends_on 字段是结构化的, 其余全是
// **从模型的散文里反推模型的意图**。
//
// 那个设计是错的: 执行顺序取决于模型这一轮用了哪个词。
// 模型写 li 还是 analyzer、写「上游」还是「依据」, 都会改变盘古的调度结果。
// 模型用哪种措辞是模型的自由; 调度被措辞决定, 是盘古的 bug。
//
// 换成: **兑·验 按定义就是验已完成的东西 → 依赖全部前置。**
// 一个字都不读 task 文字。措辞随便怎么写, 结果都一样。
//
// 下面第一条测试就是钉这个不变式的。
// ─────────────────────────────────────────────────────────────────────────────

test('【架构】措辞不该改变调度 —— 同一份拆解, task 文字随便写, 依赖必须完全一致', () => {
  const WORDINGS = [
    '仅依据上游 li 的汇报结论验收',
    '仅依据上游 analyzer 的汇报结论验收',
    '把离的报告核对一遍',
    '验收',
    '### executor\n随便写点什么',
    '综合前一个子任务的结果并给出验收结论: PASS 或 FAIL',
  ];
  const results = WORDINGS.map((w) => {
    const t = [{ agent: 'li', task: '读配置 A' }, { agent: 'dui', task: w }];
    _inferDependsOn(t, false);
    return JSON.stringify(t[1].depends_on);
  });
  for (const r of results) {
    assert.strictEqual(r, '[0]',
      '措辞改变了调度结果 —— ' + r
      + ' 这句话的意思就是「盘古靠猜模型想说什么来排队」。'
      + '兑·验 按定义依赖全部前置, 不该读 task 文字。');
  }
});

test('【现场复现】2 刀 (离读 / 兑验) 必须推出依赖, 不能 11ms 并发', () => {
  const t = [
    { agent: 'li', task: '查清模型池: 全部模型/provider/本地云端/默认模型' },
    { agent: 'dui', task: '仅依据上游 li 的汇报结论及其已提供的配置证据进行验收。' },
  ];
  const r = _inferDependsOn(t, false);
  assert.equal(r.inferred, 1, '现场是 0 组依赖 —— 兑和离同层并发, 兑审了个空');
  assert.deepEqual(t[1].depends_on, [0], '兑必须排在离后面');
});

test('兑·乾 默认依赖**全部**前置, 不是只挂最近一刀', () => {
  for (const role of ['dui', 'qian']) {
    const t = [
      { agent: 'li', task: '读配置' },
      { agent: 'kun', task: '跑探测' },
      { agent: 'xun', task: '扫雷' },
      { agent: role, task: '收口' },
    ];
    _inferDependsOn(t, false);
    assert.deepEqual(t[3].depends_on, [0, 1, 2],
      role + ' 只挂了最近一刀 —— 它要核的东西还没交, 又回到审了个空');
  }
});

test('其余五刀不因身份被强加依赖 (离读/坤做/巽扫/震复盘/艮记 天然可并发)', () => {
  const t = [
    { agent: 'li', task: '读 A' },
    { agent: 'kun', task: '做 B' },
    { agent: 'xun', task: '扫 C' },
  ];
  _inferDependsOn(t, false);
  for (let i = 0; i < 3; i++) {
    assert.ok(!t[i].depends_on || t[i].depends_on.length === 0,
      '第 ' + i + ' 刀 (' + t[i].agent + ') 被无理由挂上依赖 —— 并发归零');
  }
});

test('显式 depends_on 依然权威: 模型明说的单点依赖不被覆盖', () => {
  const t = [
    { agent: 'li', task: '读 A' },
    { agent: 'kun', task: '做 B' },
    { agent: 'dui', task: '只核 A', depends_on: [0] },
  ];
  _inferDependsOn(t, false);
  assert.deepEqual(t[2].depends_on, [0], '模型显式声明的单点依赖要照单全收');
});

test('链式伪依赖仍被剥掉 (planner 把每刀都挂 [0,1,2] 的懒惰模式)', () => {
  // 2026-10-16 现场 lt2-1792136693166。单点依赖一律信任, 只剥"依赖前面全部"这一种形状。
  const t = [
    { agent: 'li', task: '读静态配置' },
    { agent: 'li', task: '读运行配置' },
    { agent: 'li', task: '读兜底配置' },
  ];
  for (let i = 0; i < 3; i++) t[i].depends_on = Array.from({ length: i }, (_, k) => k);
  _inferDependsOn(t, false);
  assert.ok(!t[1].depends_on || t[1].depends_on.length === 0,
    '懒惰串行链没被剥掉 —— 三刀本该并发');
});

test('口语数词一网打尽: 两/几/三/阿拉伯数字/罗马数字/十 都要认', () => {
  for (const phrase of ['前两个子任务', '前几个子任务', '前三个子任务', '前2个子任务', '前二个子任务', '前十个子任务']) {
    const t = [
      { agent: 'li', task: '读静态配置' },
      { agent: 'xun', task: '扫雷' },
      { agent: 'dui', task: '验收：仅依据' + phrase + '的汇报结论核对' },
    ];
    _inferDependsOn(t, false);
    assert.deepEqual(t[2].depends_on, [0, 1], '漏了「' + phrase + '」—— 验收刀又跑到前面去了');
  }
});

test('依赖永远只指向靠前的下标 (不许成环, 不许指向自己)', () => {
  const t = [
    { agent: 'dui', task: '先看日志' },
    { agent: 'dui', task: '基于上面的结论继续核验下一项' },
  ];
  _inferDependsOn(t, false);
  assert.ok(!t[1].depends_on || !t[1].depends_on.includes(1), '不能指向自己');
  assert.ok(!t[1].depends_on || t[1].depends_on.every((d) => d < 1), '不能指向后面');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-18 第二步: 把剩下两层散文兜底也删了
//
// 上面删掉了 _roleDepsFromText (扒角色名)。这轮删掉另外两层:
//   _refersToAllPrior / _depEvidenceInTask  扒中文连接词 ("前两个子任务"/"综合以上产出")
//   「第N步 / 子任务N / 刀N」正则            扒步骤编号
// 三层加在一起 = 盘古靠猜模型想说什么来排顺序。现在 depends_on 是唯一权威。
// ─────────────────────────────────────────────────────────────────────────────

test('链式依赖用**结构**判真假, 不再读任务文字里的聚合措辞', () => {
  // 旧判据: 读 task 文字找"综合前 3 个…"来分辨真假链。
  // 措辞变了, 调度就变了 —— 同一个错, 换个马甲。
  // 新判据: 兑·乾 本来就是收口刀, 依赖全部前置合情合理;
  //         离·坤·巽 各自独立, 它声明 [0,1,2] 就是懒惰。
  const dup = (role) => {
    const t = [
      { agent: 'li', task: '读 A' },
      { agent: 'kun', task: '做 B' },
      { agent: 'xun', task: '扫 C' },
      { agent: role, task: '随便什么措辞, 不含任何聚合词' },
    ];
    for (let i = 1; i < 4; i++) t[i].depends_on = Array.from({ length: i }, (_, k) => k);
    _inferDependsOn(t, false);
    return t[3].depends_on;
  };
  assert.deepEqual(dup('dui'), [0, 1, 2], '兑声明依赖全部前置 = 收口, 合情合理, 必须留下');
  assert.deepEqual(dup('qian'), [0, 1, 2], '乾同理');
  assert.ok(!dup('li'), '离声明 [0,1,2] = 懒惰串行链, 必须剥掉');
  assert.ok(!dup('kun'), '坤声明 [0,1,2] = 懒惰串行链, 必须剥掉');
});

test('缺 depends_on 声明要**报出来**, 而不是盘古替模型猜一个', () => {
  const t = [
    { agent: 'li', task: '读 A' },
    { agent: 'kun', task: '做 B' },
    { agent: 'li', task: '读 C' },
  ];
  const r = _inferDependsOn(t, false);
  assert.equal(r.undeclared.length, 3, '三刀都没声明依赖, 必须全部报出来');
  assert.deepEqual(r.undeclared.map((d) => d.i), [0, 1, 2]);
  // 且确实没替它们编出依赖 —— 独立就是独立
  for (let i = 0; i < 3; i++) {
    assert.ok(!t[i].depends_on || t[i].depends_on.length === 0,
      '第 ' + i + ' 刀被盘古猜出了依赖 —— 这正是要删的行为');
  }
});

test('兑/乾 缺声明时自动排前置, 但仍记进 undeclared (缺陷可见, 不静默)', () => {
  const t = [
    { agent: 'li', task: '读 A' },
    { agent: 'dui', task: '验收' },
  ];
  const r = _inferDependsOn(t, false);
  assert.deepEqual(t[1].depends_on, [0], '兑必须排在离后面 —— 这是结构事实');
  assert.ok(r.undeclared.some((d) => d.i === 1 && d.agent === 'dui'),
    '但"planner 没写 depends_on"这件事本身要报出来 —— 兑能被兜住不代表拆解是好的');
});

test('显式 depends_on: [] = 我独立, 尊重它, 不强加依赖', () => {
  const t = [
    { agent: 'li', task: '读 A' },
    { agent: 'xun', task: '扫 B', depends_on: [] },
  ];
  _inferDependsOn(t, false);
  assert.deepEqual(t[1].depends_on, [], '显式空数组 = 模型明说自己独立');
});

test('收口刀显式声明无依赖要记一笔 (那是"审了个空"的入口形状)', () => {
  const t = [
    { agent: 'li', task: '读 A' },
    { agent: 'dui', task: '验收', depends_on: [] },
  ];
  const r = _inferDependsOn(t, false);
  assert.deepEqual(t[1].depends_on, [], '显式声明尊重它 (orchestrator 的 pre_check 就是这种)');
  assert.ok(r.undeclared.some((d) => d.why === 'aggregator_declared_empty'),
    '但站在有前置的位置上还声明无依赖, 要留痕 —— 这正是 11ms 并发审空的那个形状');
});
