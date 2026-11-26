// 2026-10-16 长任务拆刀 —— "盘古不拆任务、子 agent 不分头干活"的两个根因
//
// 现场 lt2-1792136323364 (真端点 /api/pangu/agent/stream, 本地 qwen3.8-27b-mlx):
//
//   根因一 · analyzer 的 skip_planner 劫持
//     主人问"请分别分析这三个文件…", 94ms 内被 fixed_flow 拦下:
//       plan = [{agent:'li', total:1,
//                task:'基于主人提供的事实和已返回的工具证据, 分析风险、趋势或判断依据…'}]
//     一刀, 零信息量的模板话术, 三个文件全压给一个 agent 串行做 → 314.5s。
//     那句"已返回的工具证据"在派发那一刻 (94ms) 根本还不存在。
//
//   根因二 · planner 的链式 depends_on 把并行拆没了
//     摘掉 skip_planner 后 planner 确实拆出了正确的 4 刀 (3 个文件各一 analyzer +
//     1 个 checker 综合), 但它把依赖填成:
//       刀1 []  刀2 [0]  刀3 [0,1]  刀4 [0,1,2]
//     三份互不相干的文件分析被排成串行链, 并发归零 —— 比不拆还慢。
//     动机很朴素: 提示词里给的 depends_on 例子就是 [0,1,2],
//     模型把"综合任务该依赖全部"误推广成了"每刀都依赖前面"。
//     而 _inferDependsOn 对 explicit depends_on 是**无条件照单全收**的。
//
// 两刀都不靠提示词, 靠机制: 模板话术不许配 skip_planner; 链式依赖必须有文字证据。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');

const {
  _inferDependsOn,
  _looksSequentialPlan,
} = require('../modules/j2_dispatcher');

const RULES = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'config', 'dispatch_rules.json'), 'utf8'));

// 现场原题 (lt2-1792136323364 / lt2-1792136693166 用的就是这道)
const THREE_FILES = '请分别分析这三个文件各自解决什么问题, 每个文件给 3 个要点: '
  + '1) /Users/you/Desktop/pangu/apps/core/modules/j2_loop_shared.js '
  + '2) /Users/you/Desktop/pangu/apps/core/modules/router/model_cost.js '
  + '3) /Users/you/Desktop/pangu/apps/core/modules/checkpoint.js';

test('T1 离·li 不再抢拆刀 —— "分析"二字曾让任何任务 94ms 内塌成一个通用 agent', () => {
  assert.notStrictEqual(RULES.li.skip_planner, true,
    '离·li 挂着 skip_planner 时, 任何含"分析"的输入都会被压成 1 刀通用模板');
});

test('T2 结构约束: 模板话术不许配 skip_planner (防止有人再加回来)', () => {
  // skip_planner 的语义是"这个角色有固定协议, 不用拆"。协议是写死的步骤,
  // 而"基于已返回的工具证据/结合上下文"指代的是**运行时状态** —— 派发那一刻还不存在,
  // 那是模板不是协议, 必须让位给 planner 拆刀。
  const TEMPLATE_TALK = /基于[^。；\n]{0,10}(?:已返回|已有|之前|上面)[^。；\n]{0,8}(?:工具|证据|结果|上下文)|结合(?:已有|上述|前面)/;
  const offenders = [];
  for (const [role, cfg] of Object.entries(RULES)) {
    if (role === '_meta' || !cfg.skip_planner) continue;
    for (const t of cfg.fixed_tasks || []) {
      if (TEMPLATE_TALK.test(String(t))) offenders.push(`${role}: ${String(t).slice(0, 40)}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `这些 skip_planner 规则的 fixed_tasks 是模板话术, 会吞掉拆刀: ${offenders.join(' | ')}`);
});

test('T3 扇出个数由盘古判断 —— 配置里不许有任何人写死的并发名单', () => {
  // 老板原话 (2026-10-18): «那问题就应该盘古判断几个agent并发, 不是人为控制agent并发»。
  //
  // 这条测试原先写的是「self_checker 保留固定流程, 5 刀砍成 4 刀」—— 也就是说,
  // **它自己才是那个「人为控制并发」的现场**: 一个写死在配置里的数字, 加一条它绿,
  // 再加一条它又红, 而盘古一行代码都没变。改掉。
  //
  // 现在它守的是原则, 不是个数。skip_planner 机制没删 (真·写死的协议仍然可以配,
  // 见 pangu-single.js 的逃生舱注释), 但**现在零个角色在用**。
  const offenders = Object.entries(RULES)
    .filter(([role, cfg]) => role !== '_meta' && cfg && cfg.skip_planner === true)
    .map(([role]) => role);
  assert.deepStrictEqual(offenders, [],
    `这些角色在配置里写死了扇出个数 (fixed_agents): ${offenders.join(' | ')}。`
    + '派几个子 agent 是盘古(主 agent / planner)的判断, 不该由配置定死。');

  // 顺带钉住另一半: 没有 skip_planner 就没有 fixed_* —— 那两条字段在
  // skip_planner 摘掉之后**没人读了**, 却还摆在配置里, 读代码的人会以为它还生效。
  const deadCfg = Object.entries(RULES)
    .filter(([role, cfg]) => role !== '_meta' && cfg
      && !cfg.skip_planner && (Array.isArray(cfg.fixed_agents) || Array.isArray(cfg.fixed_tasks)))
    .map(([role]) => role);
  assert.deepStrictEqual(deadCfg, [],
    `这些角色没有 skip_planner, 它的 fixed_agents/fixed_tasks 是死配置: ${deadCfg.join(' | ')}`);
});

test('T4 编号清单不是顺序计划 —— "1) a 2) b 3) c" 是并行的典型形状', () => {
  assert.strictEqual(_looksSequentialPlan(THREE_FILES), false,
    '三个互不相干的文件编号清单被当成了顺序计划, 于是三份独立分析被排成串行链');
});

test('T5 真顺序措辞仍是顺序计划 —— 拆并行不能拆掉真顺序', () => {
  for (const s of ['依次执行这三步', '按顺序来', '先做 A 再做 B', '第 1 步…第 2 步…第 3 步…']) {
    assert.strictEqual(_looksSequentialPlan(s), true, `"${s}" 应当判为顺序计划`);
  }
});

test('T6 现场 plan 复现: 三份独立分析恢复并行, 综合刀依赖保留', () => {
  // planner 在 lt2-1792136693166 的真实产物
  const plan = [
    { agent: 'li', task: '读取并分析 j2_loop_shared.js, 输出 3 个要点', depends_on: [] },
    { agent: 'li', task: '读取并分析 model_cost.js, 输出 3 个要点', depends_on: [0] },
    { agent: 'li', task: '读取并分析 checkpoint.js, 输出 3 个要点', depends_on: [0, 1] },
    { agent: 'dui', task: '综合前 3 个 analyzer 的结论, 生成最终回答', depends_on: [0, 1, 2] },
  ];
  _inferDependsOn(plan, _looksSequentialPlan(THREE_FILES));
  const deps = plan.map(s => (Array.isArray(s.depends_on) ? s.depends_on : []));
  assert.deepStrictEqual(deps[0], [], '刀1 无依赖');
  assert.deepStrictEqual(deps[1], [], '刀2 的 [0] 是模型懒惰填的链, 文字里没有承接措辞, 应剥掉');
  assert.deepStrictEqual(deps[2], [], '刀3 的 [0,1] 同上');
  assert.deepStrictEqual(deps[3], [0, 1, 2],
    '综合刀有"综合前 3 个"的文字证据, 依赖必须保留 —— 否则综合跑到前面空转');
});

test('T7 单点依赖不被误伤 —— 只裁链式, 不猜模型', () => {
  const plan = [
    { agent: 'kun', task: '建 a.txt', depends_on: [] },
    { agent: 'kun', task: '建 b.txt', depends_on: [] },
    { agent: 'kun', task: '建 c.txt', depends_on: [] },
    { agent: 'dui', task: '校验 a.txt b.txt c.txt', depends_on: [2] },
  ];
  _inferDependsOn(plan, false);
  assert.deepStrictEqual(plan[3].depends_on, [2],
    '单点依赖 [2] 不是链式懒惰模式, 必须原样信任');
});

test('T8 有承接措辞的链式依赖保留 —— 别把真顺序拆成并行', () => {
  const plan = [
    { agent: 'li', task: '统计总行数', depends_on: [] },
    { agent: 'li', task: '在前一步统计结果的基础上找出超 500 行的文件', depends_on: [0] },
    { agent: 'dui', task: '综合以上结论出报告', depends_on: [0, 1] },
  ];
  _inferDependsOn(plan, true);
  assert.deepStrictEqual(plan[1].depends_on, [0], '"在前一步…基础上"是承接证据, 依赖保留');
  assert.deepStrictEqual(plan[2].depends_on, [0, 1], '"综合以上结论"是聚合证据, 依赖保留');
});

test('T9 planner 没填 depends_on 时, 盘古**不猜**, 但必须报出来', () => {
  // 现场 lt2-1792138620930 的真实产物: planner 一个 depends_on 都没填,
  // 只在刀2 的 task 文字里写了「基于子任务0的已核实事实」。
  //
  // 旧实现靠正则扒「第N步 / 子任务N」把这条认出来。那是读模型写的散文 ——
  // 措辞变了, 调度就变了。2026-10-18 全删了。
  //
  // 新契约: **depends_on 是唯一权威。**
  //   兑·震·乾 缺声明 → 按定义排全部前置 (结构事实, 不读文字)
  //   其余缺声明   → 独立并发, **并且报进 undeclared**
  //
  // 报出来是有意义的: 这份拆解的刀2 明写着要吃刀1 的事实却没声明,
  // 它大概率是真的需要依赖 —— 而盘古不替它编一个。这条 warn 会进日志,
  // 提示"该让 planner 补 depends_on", 而不是安静地并发跑出一个空跑结果。
  const plan = [
    { agent: 'li', task: '读取并核实以下三个文件的实际内容: j2_loop_shared.js、model_cost.js、checkpoint.js。输出已核实事实' },
    { agent: 'li', task: '基于子任务0的已核实事实，按剥卦六二动爻与蒙卦定调组织分析：先给每个文件恰好3个要点' },
    { agent: 'dui', task: '核验子任务1是否满足：先事实后卦象、每个文件恰好3个要点' },
  ];
  const r = _inferDependsOn(plan, _looksSequentialPlan(THREE_FILES));
  // 兑 按定义排在全部前置之后 —— 这一条不依赖任何文字
  assert.deepStrictEqual(plan[2].depends_on, [0, 1],
    '兑·验 必须排在全部前置之后 (结构事实, 与措辞无关)');
  // 刀2 是 li 且没声明 → 不猜, 不给依赖
  assert.ok(!plan[1].depends_on || plan[1].depends_on.length === 0,
    '盘古不许从 task 文字里反推依赖 —— 那是读散文, 措辞一变调度就变');
  // 但"没声明"这件事必须可见
  assert.ok(r.undeclared.some((d) => d.i === 1 && d.agent === 'li'),
    '刀2 没声明 depends_on 却明写着要吃刀1 的事实 —— 必须报出来, 不能安静并发');
  assert.ok(r.undeclared.length >= 2,
    '三刀都没声明, 缺陷要一条不落地报出来');
});

test('T10 聚合指代 ("前三个…输出" / "综合最终回答") 必须等齐前面所有刀', () => {
  // 现场 lt2-1792139218147 的真实产物 + 真实时间线:
  //   225132ms   三个 analyzer 同时开跑 (并发对了)
  //   949520ms   checker 启动 —— 而第二、三刀 analyzer 分别到 1080608 / 1371998ms 才结束
  //   1384528ms  status=remediation「验收未通过」, checker 原话「什么都没产出 (没调任何工具)」
  // 刀4/刀5 指得出"要用上游", 却指不出"用哪一刀", 依赖推断全落空 → 验收审了个空。
  const plan = [
    { agent: 'li', task: '读取 j2_loop_shared.js, 输出该文件解决什么问题, 并给 3 个要点; 每点必须附可核实证据' },
    { agent: 'li', task: '读取 router/model_cost.js, 输出该文件解决什么问题, 并给 3 个要点; 每点必须附可核实证据' },
    { agent: 'li', task: '读取 checkpoint.js, 输出该文件解决什么问题, 并给 3 个要点; 每点必须附可核实证据' },
    { agent: 'dui', task: '验证前三个 analyzer 输出：逐文件核对是否都给出 3 个要点、每个要点是否有指定路径内的证据支撑、是否存在未核实推断' },
    { agent: 'zhen', task: '基于已验证事实综合最终回答：分别说明三个文件各自解决什么问题，每个文件 3 个要点' },
  ];
  _inferDependsOn(plan, _looksSequentialPlan(THREE_FILES));
  assert.deepStrictEqual(plan[0].depends_on, undefined, '刀1 无上游');
  assert.deepStrictEqual(plan[1].depends_on, undefined, '刀2 与刀1 互不相干, 必须并发');
  assert.deepStrictEqual(plan[2].depends_on, undefined, '刀3 与刀1/刀2 互不相干, 必须并发');
  assert.deepStrictEqual(plan[3].depends_on, [0, 1, 2],
    '"验证前三个 analyzer 输出" 是对前三刀的依赖 —— 不等齐就等于审空气');
  assert.ok((plan[4].depends_on || []).length > 0,
    '"综合最终回答" 的那一刀必须排在同伴之后');
});

