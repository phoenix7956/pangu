// 2026-10-16 确定性任务拆分 —— planner 被打挂时的兜底
//
// 现场 (本地 qwen3.8-27b): "Planner failed: LLM timeout" 300s。
// 根因是 planner 非流式阻塞 + 本地模型没配 max_tokens → 输出上限兜底 32768,
// 27B 解码 ~20 tok/s 光生成就能跑 27 分钟。planner 死后旧码退回 j2 主循环
// **单线程硬啃整件事** —— 活能干完, 但没人拆、没人并行、没人汇报, 主人看不见进度。
//
// 这组测试锁的是拆分器的判断, 不是它的"聪明":
//   切错比不切更贵 (错 plan 会派错角色去做错的事), 所以每条都钉住"不许切"的那些情形。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');

const M = (p) => require(path.join(__dirname, '..', p));
const ts = M('modules/task_split.js');

// ===== 1. 切句: 顺序边界 =====

test('S1 现场原句拆成三刀, 角色和顺序都对', () => {
  const ask = '在 /tmp/x 目录下创建 3 个文本文件 a.txt、b.txt、c.txt, 每个文件的内容就是它自己的名字(不带扩展名)。'
    + '3 个都建完之后, 读回 b.txt 确认内容确实是 b, 然后列出该目录所有文件并汇报。做完全部步骤再收尾。';
  const r = ts.splitTask(ask);
  assert.ok(r, '现场这句话必须能拆');
  assert.strictEqual(r.source, 'deterministic');
  assert.ok(r.subTasks.length >= 2, '至少两刀, 实测 ' + r.subTasks.length);
  assert.strictEqual(r.subTasks[0].agent, 'kun', '建文件归 executor');
  assert.ok(r.subTasks.some(s => s.agent === 'dui'), '读回/列出归 checker');
  // 顺序: 第一刀不依赖谁, 后面每一刀都串在前一刀后面
  assert.deepStrictEqual(r.subTasks[0].depends_on, []);
  for (let i = 1; i < r.subTasks.length; i++) {
    assert.deepStrictEqual(r.subTasks[i].depends_on, [i - 1],
      '第 ' + (i + 1) + ' 刀必须依赖第 ' + i + ' 刀, 否则读回会跑在建文件前面');
  }
});

test('S2 顿号绝不能切 (a.txt、b.txt 是一个动作的三个宾语)', () => {
  const r = ts.splitTask('创建 a.txt、b.txt、c.txt 这三个文件, 然后读回 b.txt 确认');
  assert.ok(r);
  assert.strictEqual(r.subTasks[0].agent, 'kun');
  for (const s of r.subTasks) {
    assert.ok(!/^创建 c\.txt/.test(s.task) || s.task.includes('a.txt'),
      '"创建 c.txt" 这种切法会丢掉"建目录"这个前提, 后一刀就找不到目录');
  }
  assert.ok(r.subTasks[0].task.includes('a.txt') && r.subTasks[0].task.includes('c.txt'),
    '三个文件必须留在同一刀里, 实测: ' + r.subTasks[0].task);
});

test('S3 完成副词是顺序的明文 (改完…跑测试 = 两刀)', () => {
  const r = ts.splitTask('重构 modules/llm_caller.js 的超时逻辑，改完跑一遍测试');
  assert.ok(r, '"改完"必须能切');
  assert.strictEqual(r.subTasks.length, 2);
  assert.strictEqual(r.subTasks[0].agent, 'kun');
  assert.strictEqual(r.subTasks[1].agent, 'dui');
  assert.deepStrictEqual(r.subTasks[1].depends_on, [0]);
});

test('S4 拆不出 ≥2 刀就返回 null, 不硬造 plan', () => {
  assert.strictEqual(ts.splitTask('把 README 改好'), null, '单刀不拆');
  assert.strictEqual(ts.splitTask('今天天气怎么样'), null, '闲聊不拆');
  assert.strictEqual(ts.splitTask(''), null, '空输入不拆');
  assert.strictEqual(ts.splitTask('   '), null, '空白不拆');
});

// ===== 2. 卦块: 认不出边界就不猜 =====

test('G1 卦块没有收尾标记时, 不得把主人的活一起吃掉', () => {
  // 踩过的坑: 旧写法 `【盘古起卦】[\s\S]*?(?=【|$)` 在没有收尾标记时一路吃到
  // 字符串末尾, 然后拆出 0 刀, 静默退回单线程 —— 比不拆还难查。
  const ask = '【盘古起卦】乾为天 — 先看有没有坑再动手\n帮我创建 report.md, 然后读回确认内容';
  const r = ts.splitTask(ask);
  assert.ok(r, '卦块不该把正事吃掉');
  assert.ok(r.subTasks[0].task.includes('report.md'), '正事必须还在: ' + r.subTasks[0].task);
});

test('G2 "主人问题:" 之后的才是真活', () => {
  const r = ts.splitTask('【盘古起卦】…卦辞…\n主人问题: 创建 x.md 然后验证内容');
  assert.ok(r);
  assert.ok(r.subTasks[0].task.includes('创建 x.md'));
  assert.ok(!r.subTasks[0].task.includes('卦辞'), '卦辞不该进子任务');
});

// ===== 3. 角色派发: 只派真实存在的角色 =====

test('R1 派出来的角色必须都在 sub-agent ROLES 里 (派不存在的角色 = 静默不干活)', () => {
  const sub = M('agents/sub-agent.js');
  const roles = Object.keys(sub.ROLES || {});
  const asks = [
    '创建 a.md 然后读回确认',
    '分析一下为什么慢，然后对比两者开销',
    '排查内存泄漏，改完再验证',
  ];
  for (const ask of asks) {
    const r = ts.splitTask(ask);
    if (!r) continue;
    for (const s of r.subTasks) {
      assert.ok(roles.includes(s.agent),
        '角色 ' + s.agent + ' 不在 ROLES(' + roles.join(',') + ') 里');
    }
  }
});

test('R2 "汇报"不许单独成刀 (手里没事实的汇报只能靠编)', () => {
  // 注意用**真会拆成多刀**的问法: "创建 a.md 然后汇报" 只有一刀, 拆不出来才是对的
  // (如实交回 null 好过硬造一个 plan)。这里测的是多刀场景下汇报会不会被孤零零切出去。
  const r = ts.splitTask('创建 a.md, 然后读回确认内容, 最后汇报给我');
  assert.ok(r, '这句该拆成多刀');
  assert.ok(r.subTasks.length >= 2);
  for (const s of r.subTasks) {
    assert.ok(!/^(汇报|告诉我|报告)/.test(s.task),
      '汇报是交付动作, 该焊在最后一刀尾巴上, 实测成了独立一刀: ' + s.task);
  }
  // 而且它必须留在**最后一刀**上 —— 派汇报的人得是手里有事实的那个人
  assert.ok(/汇报/.test(r.subTasks[r.subTasks.length - 1].task),
    '汇报要焊在最后一刀, 实测末刀: ' + r.subTasks[r.subTasks.length - 1].task);
  assert.strictEqual(r.subTasks[0].agent, 'kun');
});

// ===== 4. 接线: planner 挂掉不许直接退回单线程 =====

test('W1 planner 失败与 plan 为空两处都要接确定性拆分', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_dispatcher.js'), 'utf8');
  const n = (src.match(/require\('\.\/task_split'\)\.splitTask\(/g) || []).length;
  assert.ok(n >= 2, 'planner 抛错 + planner 交回空 plan, 两处都得接, 实测 ' + n);
  assert.ok(/确定性拆分接管/.test(src), '接管必须留日志 —— 否则线上只能靠猜');
  assert.ok(/_det\.subTasks\.length >= 2/.test(src) && /subTasks\.length >= 2/.test(src),
    '拆不出 ≥2 刀必须老实退回原路, 不许硬造 plan');
});

test('W2 三条综合路径都不许只喂 toolHistory 丢掉汇报', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_dispatcher.js'), 'utf8');
  assert.ok(!/const evidence = parts\.length \? parts\.join/.test(src),
    '"工具证据一旦非空就把汇报顶掉" 的写法不许复活');
  // 2026-10-23(第 65 批): 关键词兜底那两份一字不差的摘要抄本收成了 `_buildFallbackSummaries` 一处,
  //   「汇报优先」那段文案自然也只剩一份 —— **汇报还在, 只是不再抄两遍**。
  //   意图一个字没变: 汇报必须进综合 prompt, 而且两条关键词兜底路都得进。
  const heads = (src.match(/'\\n汇报:\\n'/g) || []).length;
  assert.strictEqual(heads, 1, '汇报优先的摘要只有一份构造, 实测 ' + heads + ' 处');
  // 这一份替**两条**关键词兜底路说话 —— 两条都还走着它
  const callers = (src.match(/await _keywordFallbackCloseOut\(results\);/g) || []).length;
  assert.strictEqual(callers, 2, '关键词兜底仍是两条路, 两条都得拿到那份带汇报的摘要, 实测 ' + callers + ' 条');
});

test('W3 subTasks 必须可重新赋值 (接管时要能替掉空 plan)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_dispatcher.js'), 'utf8');
  assert.ok(/let subTasks = \(plan && plan\.subTasks\)/.test(src),
    '确定性接管要能替换空 plan, const 就做不到');
});

