'use strict';
// 2026-10-13 soak-live-1791878818 现场 (修完「原文丢失」之后的下一层):
//
// 8 份文件全部逐字 PASS, checker 用真 diff 核对 (不是编的) —— 但整轮收口失败:
//   [j2-auto-resume] compact soak-live-1791878818#sub-0-executor: 14 -> 6 msgs
//       (reason=objective_incomplete, pending=0, checkpoint_task=true, resume #1/3)
//   ... 同一子 agent 把 #2/3 #3/3 全烧完 ...
//   [j2] loop ended, nativeRounds: 9, taskDoneCalled: false
// 盘古最后只能答: 「本轮当前无法实际调用 task_done, 因此不虚报已调用」。
//
// 根因是三条契约互相打架, 现场逐条对上:
//   ① 角色白名单 (sub-agent.js ROLES.tools, 2026-09-16 定的) 里**根本没有 task_done**
//      —— executor 16 个工具 / checker 17 个, 与线上 `[j2-role-tools] toolsAllowed=16` 分毫不差;
//   ② j2 原生循环的完成判据就是 taskDoneCalled (j2_agent_loop `if (taskDoneCalled || userAborted)`);
//   ③ 自动续跑提示还催它: 「继续推进剩余工作 … 全部完成时调 task_done」。
//
// 于是子 agent 想收口也调不到那个工具 —— 只能一遍遍重写/重读同一批文件把 3 次续跑烧完,
// 退出时 taskDoneCalled:false, 整轮被判 partial。这就是「子 agent 一直有问题 / 长工作收不了尾」
// 剩下的那一半: 前半是拿不到规格去编, 后半是干完了收不了口。
//
// task_done 是**收口信号**不是角色职能工具 (sandbox 也把它列在 safe 里), 所以不该指望
// 各角色名单自觉带上 —— 由 j2 循环对所有非 main 角色强制补。
const test = require('node:test');
const assert = require('node:assert/strict');

const shared = require('../modules/j2_loop_shared');
const ROLES = require('../agents/sub-agent').ROLES;

test('角色工具白名单必须带 task_done —— 否则子 agent 永远收不了尾', () => {
  // 2026-10-18 拼音统一: 角色键 executor/checker/analyzer → kun/dui/li。
  for (const role of ['kun', 'dui', 'li']) {
    assert.ok(ROLES[role].tools.length > 0, role + ' 角色本来就有职能白名单 (前提校验)');
    assert.ok(!ROLES[role].tools.includes('task_done'),
      '前提校验: ROLES 名单本来就没有 task_done (现场 toolsAllowed=16/17 就是这么来的)');
    const filter = shared.buildRoleToolFilter(role, ROLES[role].tools);
    assert.ok(filter.has('task_done'),
      role + ' 角色的子 agent 拿不到 task_done → 循环完成判据永远不成立 → 烧完续跑预算退出为 partial');
    assert.ok(filter.size === ROLES[role].tools.length + 1,
      role + ' 只许补 task_done 一个, 不许顺手放宽成全量工具');
    assert.ok(filter.has('exec_command') || filter.has('read_file'),
      role + ' 角色的本职工具不许被这次补齐弄丢');
  }
});

test('白名单为空的角色 (planner 只出 JSON) 走全量工具, 一样拿得到 task_done', () => {
  assert.deepEqual(ROLES.kan.tools, [], '前提校验: planner 白名单本来是空的');
  assert.equal(shared.buildRoleToolFilter('kan', []), null,
    '空名单 = 不做过滤 = 全量工具, 不该硬造一个只含 task_done 的名单');
});

test('没传 toolsAllowed 时 (旧调用路径) 从 ROLES 拉名单, 也一样要带 task_done', () => {
  // 2026-10-18: 这里**故意传英文名** —— roleForLoop 可能来自历史数据/旧 checkpoint。
  // 不归一 → ROLES 查不到 → filter=null → 退化成全量工具, 且不报错。
  const filter = shared.buildRoleToolFilter('kun', null);
  assert.ok(filter && filter.has('task_done'), 'fallback 路径同样漏了就白修');
  assert.ok(filter.size <= ROLES.kun.tools.length + 1,
    '英文名没被归一 → filter 是 null / 全量工具, 白名单静默失效');
  assert.ok(filter.size === ROLES.kun.tools.length + 1,
    '只补 task_done 一个, 不许顺手放宽成全量工具');
});

test('main 角色不受影响 (主循环本来就全量, 有自己的交付语义)', () => {
  assert.equal(shared.buildRoleToolFilter('main', ['read_file']), null,
    'main 走全量工具, 不该被角色过滤逻辑拦');
});

test('接线守卫: j2_agent_loop 必须真的用这个 helper, 而不是自己另算一份', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')            // 剥注释, 别被注释里的字样骗过
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(src, /buildRoleToolFilter\(/,
    '白名单计算必须走 buildRoleToolFilter —— helper 写对了但没接线 = 等于没修');
});

// 派发层的围栏文案: 原来是一句「禁止调 task_done (由调度层统一交付)」, 与 ②③ 直接冲突。
// 2026-10-12 加它是为了防「每个 executor 都以为要交付整轮」(longtask-01), 那个防线的**本意**
// 是「不许替别人收口 / 不许没干完就收口」,  blanket 禁止只是当时最省事的写法。
test('围栏文案: 禁的是「替别人收口 / 没干完就收口」, 不是禁收口本身', () => {
  const d = require('../modules/j2_dispatcher');
  const stepBlock = d._ownerScopeBlock('做一个 5 步计划: 1) 列文件; 2) 统计行数; 3) 汇总成报告', 3,
    '递归列出 modules 下所有 .js 文件并保存清单');
  const specBlock = d._ownerScopeBlock('把 /tmp/a.md 内容写成下面这段: # 标题', 2,
    '必须严格使用主人给出的内容');
  for (const [name, block] of [['步骤型', stepBlock], ['规格型', specBlock]]) {
    assert.ok(!/禁止调 task_done/.test(block),
      name + ' 围栏还在 blanket 禁 task_done —— 与循环完成判据和续跑提示互相打架, '
      + '子 agent 只能烧完 3 次续跑退出为 partial');
    assert.match(block, /task_done/,
      name + ' 围栏必须讲清收口纪律, 不能只把禁令删了不说规矩');
    assert.match(block, /没(?:干完|做完)[^。]*不许调 task_done|不许调 task_done[^。]*没(?:干完|做完)/,
      name + ' 围栏必须明写「没干完不许调 task_done」—— 调了这轮就结束, 早调等于交白卷');
    assert.match(block, /禁止替别的步骤产出文件/, name + ' 串味防线 (2026-10-12) 不许被删');
  }
});
