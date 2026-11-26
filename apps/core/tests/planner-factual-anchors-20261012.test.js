const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// 2026-10-12 现场证据 (probe-art3-2143, SSE 全量 dump + 账本交叉核对):
//   主人: "把今天日期写进 /tmp/pangu_art3.md,只写日期一行,不要加任何其他内容"
//   SSE cast_at = 2026-10-12T13:43:39Z (系统真实时间)
//   planner 拆出的 task: "将今天日期 2026-10-09 单独写入 ..."  ← 凭空编的, 差 3 天
//   executor 忠实执行, 写盘 2026-10-09, 还拿 od -c 字节级证据"证明"自己写对了。
//   危害: 主人问"今天", 盘古给三天前的日期 + 伪造证据自证清白。
//   上一轮 (probe-art2) 补救轮的 checker 恰恰抓到这点 ("日期为 2026-10-12, 不是要求的 2026-10-09")
//   —— 说明 planner 写进 task 的日期成了"权威指令", executor/checker 都拿它当基准。
// 根因: planner 的 system 提示里没有任何事实锚点, 模型凭训练语料脑补日期。
const SRC = fs.readFileSync(require.resolve('../agents/sub-agent.js'), 'utf8');
const ANCHOR = fs.readFileSync(require.resolve('../modules/factual_anchor.js'), 'utf8');

test('planner 必须拿到真实系统时间 —— 不许让模型脑补"今天"', () => {
  assert.match(ANCHOR, /【当前真实时间/,
    '时间锚点模块必须提供可嵌入的锚点文本');
  assert.match(SRC, /runPlanner[\s\S]{0,600}?timeAnchorBlock\(\)/,
    'runPlanner 必须注入真实系统时间锚点');
});

test('planner 提示必须禁止编造事实性常量(日期/时区/路径)', () => {
  // 2026-10-18 拼音统一: 键名 planner/analyzer → kan/li。
  // 原来那个 `indexOf('analyzer:') > 0 ? … : +2000` 的兜底是**假保险** ——
  // 键改名后它静默切出一个跨界的错块, 断言照样"通过", 实际什么都没验到。
  const _plannerStart = SRC.indexOf('kan: {');
  const _plannerEnd = SRC.indexOf('li: {', _plannerStart) > 0 ? SRC.indexOf('li: {', _plannerStart) : _plannerStart + 2000;
  const _plannerBlock = SRC.slice(_plannerStart, _plannerEnd);
  // 只验切片真的落在 kan 这一段 (别让兜底把断言变成空转) —— 内容断言在下面,
  // 针对的是 runPlanner 注入的那段提示, 不是 ROLES 字面量。
  // 2026-10-18: 锚点从 name: 'Planner' 改成 name: 'kan'。ROLES 里的 name 原来是一份
  // 英文手抄 (Planner/Analyzer/Executor/...), 而它直接进子 agent 提示词 —— 8 个将灵
  // 互相传话时说的还是旧英文名, 账本里记的却是拼音, 同一个角色两个名字。
  // 现在字面量是拼音、运行时再从身份真源覆写成中文, 所以锚点跟着改成 name: 'kan'。
  // 这比原来更严: 它同时钉住了"切片落在 kan 段"和"这一段的名字就是拼音 kan"。
  assert.ok(_plannerStart > 0 && _plannerEnd > _plannerStart
    && _plannerBlock.startsWith('kan: {') && _plannerBlock.includes("name: 'kan'"),
    '要真切到 kan 这一段 —— 切不到说明键名又变了, 兜底会让断言空转');
  const _runPlanner = SRC.slice(SRC.indexOf('async function runPlanner'), SRC.indexOf('async function runPlanner') + 1200);
  assert.match(_runPlanner, /编造/,
    'planner 提示必须明令禁止编造日期等事实性常量');
  assert.match(_runPlanner, /唯一真源|factorial|真实时间/,
    'planner 提示必须指明真实时间的唯一真源');
});

test('时间锚点用系统时钟生成, 且带时区', () => {
  // 时间生成必须落在单一真源模块 (不各自 new Date), 且取自系统时钟
  assert.match(ANCHOR, /toISOString|Intl\.DateTimeFormat/,
    '时间锚点必须来自系统时钟 (Date), 不能是硬编码字符串');
  assert.match(ANCHOR, /Asia\/Shanghai|PANGU_TZ/,
    '时间锚点必须带时区 (本机默认 Asia/Shanghai)');
});

test('时间锚点对 plan 里的下游 executor 也可见(不能只给 planner)', () => {
  // executor 才是真正写盘的角色 —— planner 编的错日期会写进 task 传下来,
  // 所以所有子 agent 的 system 都必须带锚点, 不只是 planner
  // 2026-10-14: 窗口从 3000 放宽到 9000 —— 连续上下文接线 (contextSeed/turns/findings
  // 注入 + token 预算闸门) 加在 runAgentLoop 开头, 把 timeAnchorBlock() 顶到 5421 字符外,
  // 旧窗口会误报"锚点没注入"。锚点本身一直在注入, 这里只放宽扫描窗口, 意图不变。
  assert.match(SRC, /runAgentLoop[\s\S]{0,9000}?timeAnchorBlock\(\)/,
    'runAgentLoop 的 system 构造必须注入时间锚点 (executor/analyzer/checker 全覆盖)');
});

// ---------------------------------------------------------------------------
// 2026-10-13 跨天回归: 盘古是常驻服务 (launchd KeepAlive), 进程可能连跑好几天。
// 若时间锚点在模块加载时冻结成 const, 跨天后任何读它的人都会拿到"昨天",
// 而且**没有任何报错** —— 页面正常、提示正常, 只是日期错了, 属最难查的静默错误。
// 下面用假系统时钟证明锚点会跟着走。
// ---------------------------------------------------------------------------
test('时间锚点不是模块加载时冻结的 —— 进程跨天后必须重新计算', () => {
  const path = require.resolve('../modules/factual_anchor.js');
  delete require.cache[path]; // 从干净状态开始
  const RealDate = Date;

  // 真实场景: 进程启动时 require 一次, 然后连跑好几天 (launchd KeepAlive 常驻)。
  // 所以这里**只 require 一次**, 之后只换系统时钟 —— 绝不能清 require.cache,
  // 否则等于每次重新加载模块, 恰好把"加载时冻结"这个被测行为给消掉了。
  function withClock(iso, fn) {
    class FakeDate extends RealDate {
      constructor(...a) { if (a.length === 0) { super(iso); } else { super(...a); } }
      static now() { return new RealDate(iso).getTime(); }
    }
    global.Date = FakeDate;
    try { return fn(); } finally { global.Date = RealDate; }
  }

  const m = require(path);                 // 进程启动, 模块加载一次
  // 测 timeAnchorBlock —— 这是生产两处真正调用的入口 (planner + runAgentLoop)。
  // timeAnchor() 内部直接 _fmt(0) 每次重算, 测它测不到"加载时冻结"。
  const day1 = withClock('2026-10-13T04:00:00Z', () => /今天是 (\d{4}-\d{2}-\d{2})/.exec(m.timeAnchorBlock())[1]);
  const day2 = withClock('2026-10-14T04:00:00Z', () => /今天是 (\d{4}-\d{2}-\d{2})/.exec(m.timeAnchorBlock())[1]);  // 同进程, 次日

  assert.equal(day1, '2026-10-13', `假时钟 10-13 应得 2026-10-13, 实得 ${day1}`);
  assert.equal(day2, '2026-10-14', `进程跨到 10-14 后应得 2026-10-14, 实得 ${day2} (锚点被冻结了)`);
  assert.notEqual(day1, day2, '锚点在模块加载时冻结 —— 常驻服务跨天会返回旧日期');
  delete require.cache[path];
});

test('NOW 导出是惰性 getter, 不是模块加载时的冻结快照', () => {
  const m = require('../modules/factual_anchor.js');
  assert.ok(m.now, '必须导出 now() 供按需重算');
  const a = m.now();
  const b = m.now();
  assert.equal(a.date, b.date, '同一分钟内 now() 应稳定');
  // NOW 是 getter, 每次读都重算 —— 断言它是访问器而不是普通冻结对象字段
  const desc = Object.getOwnPropertyDescriptor(m, 'NOW');
  assert.ok(desc && typeof desc.get === 'function',
    'NOW 必须是 getter (惰性求值), 不能是模块加载时的冻结常量');
});

test('模块源码里不得再有加载时冻结的 const NOW = ...', () => {
  assert.doesNotMatch(ANCHOR, /const\s+NOW\s*=/,
    '不得用 const NOW 在模块加载时冻结时间 (常驻服务跨天会返回旧日期)');
});
