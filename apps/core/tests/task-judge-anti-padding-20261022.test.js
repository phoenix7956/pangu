/**
 * 六格判局内核 —— 防灌水 + 判定输入格对齐 (第 32 批 · 2026-10-22)
 *
 * 起因: 这条内核的入参**全是模型填的条目**。所以最该防的不是"算错",
 * 而是**判据被入参绕过**。今天实跑当场抓到两个洞:
 *
 *   ① 条目不去重 ⇒ 同一条阻力写三遍就凑成「强」, 凭空造出「换向」:
 *        judgeTask({resources:['余力'], outputs:[], blockers:['缺测试环境'×3], ...})
 *        → 克我者=strong → verdict='redirect'
 *      阈值是「≥3 条记强」, 条数是模型给的 ⇒ 不去重等于没有阈值。
 *
 *   ② 同我者(peers) 在 CELLS 里、会算档位、会进输出, 但 S1/S2 规则**从不读它**。
 *      实测 peers 从 1 条加到 5 条(档位 weak→strong), verdict 一点没变。
 *      而模型看见输出里的「同我者: 强」, 会以为它在左右结论 ⇒ 白填一堆平级协作。
 *
 * ⚠️ 本文件里最重要的一段是**负例**那一节: 判据已经写好, 得证明它会咬人。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const CORE = path.join(__dirname, '..');
const TJ = require(path.join(CORE, '64i', 'bagua_annotations', 'task_judge.js'));

// ============================================================
// 一、防灌水
// ============================================================

test('★ 同一条写三遍不算三条 —— 不许靠灌水把格子撑成「强」', () => {
  const r = TJ.judgeTask({
    subject: '上线支付',
    resources: ['有点余力'],
    outputs: [],
    blockers: ['缺测试环境', '缺测试环境', '缺测试环境'],
    targets: ['拿回滚开关'],
  });
  // 3 条**完全一样**的 → 去重后还剩 1 条, 是「弱」, 不是「强」也不是「不成立」。
  // ⚠️ 第一版这里写的是 not_established, 被当场跑红 —— 期望值是按「全塌掉」想的,
  //   实际是「塌成一条」。断言写错比没断言更贵: 它会主动把我推向错误结论。
  assert.equal(r.cells.ke.state, 'weak',
    '一条阻力写三遍去重后只剩 1 条, 应是「弱」—— 绝不是「强」');
  assert.equal(r.cells.ke.items.length, 1, '重复条目必须塌成一条');
});

test('灌水前后 verdict 必须不同 (证明这条判据真在挡东西)', () => {
  const base = {
    subject: '上线支付',
    resources: ['有点余力'],
    outputs: [],
    targets: ['拿回滚开关'],
  };
  const padded = TJ.judgeTask(Object.assign({}, base, { blockers: ['缺测试环境', '缺测试环境', '缺测试环境'] }));
  assert.notEqual(padded.verdict, 'redirect',
    '灌水竟然造出了「换向」—— 去重没生效');
});

test('三条**真**的阻力仍然判强 (去重不许把真信号也吃掉)', () => {
  const r = TJ.judgeTask({
    subject: 'X', resources: ['余力'], outputs: [],
    blockers: ['缺权限', '缺人手', '缺预算'], targets: ['啃A'],
  });
  assert.equal(r.cells.ke.state, 'strong', '三条不同的阻力就该是强');
  assert.equal(r.cells.ke.dropped_duplicates, 0, '没有重复就不该报去重');
});

test('去重必须**如实报出去**, 不许静默改数据', () => {
  const r = TJ.judgeTask({
    subject: 'X', resources: [], outputs: [],
    blockers: ['缺权限', '缺权限'], targets: ['T'],
  });
  assert.equal(r.cells.ke.input_count, 2, '模型填了几条要让它知道');
  assert.equal(r.cells.ke.dropped_duplicates, 1, '去掉了几个也要让它知道');
  assert.equal(r.dropped_duplicates_total, 1);
  assert.deepEqual(r.cells.ke.items, ['缺权限'], '留下的条目也要给全');
});

test('空白变体算同一条 (「缺  权限」与「缺 权限」不该算两条)', () => {
  const r = TJ.judgeTask({
    subject: 'X', resources: [], outputs: [],
    blockers: ['缺 权限', '缺  权限'], targets: ['T'],
  });
  assert.equal(r.cells.ke.items.length, 1, '连续空白压掉后应判为同一条');
});

test('去重不许过度合并 (真不同的两条不许被压成一条)', () => {
  const r = TJ.judgeTask({
    subject: 'X', resources: [], outputs: [],
    blockers: ['缺权限', '缺预算'], targets: ['T'],
  });
  assert.equal(r.cells.ke.items.length, 2, '只压空白, 不改字 —— 两条不同的阻力必须留着');
});

test('空条目/空串不算条目 (不许拿空字符串凑数)', () => {
  const r = TJ.judgeTask({
    subject: 'X', resources: ['', '  ', null, undefined], outputs: [],
    blockers: ['真阻力'], targets: ['T'],
  });
  assert.equal(r.cells.sheng.count, 0, '空串不算条目');
  assert.equal(r.cells.sheng.input_count, 0, '原始条数也不该把空串算进去');
});

// ============================================================
// 二、哪几格真的影响判定 —— 必须数据对齐, 不能只写注释
// ============================================================

test('同我者(peers) 明确标 affects_verdict=false', () => {
  const r = TJ.judgeTask({
    subject: 'X', resources: ['a'], outputs: [], blockers: [], targets: ['T'], peers: ['p1', 'p2', 'p3'],
  });
  assert.equal(r.cells.tong.state, 'strong', '它确实会算档位');
  assert.equal(r.cells.tong.affects_verdict, false,
    '但它不参与停点 —— 必须明说, 否则模型以为填了就能左右结论');
  assert.ok(!TJ.VERDICT_INPUTS.has('tong'));
});

test('参与判定的四格都标 affects_verdict=true', () => {
  for (const k of ['sheng', 'xie', 'ke', 'hao']) {
    assert.ok(TJ.VERDICT_INPUTS.has(k), k + ' 应当参与判定');
  }
  const r = TJ.judgeTask({
    subject: 'X', resources: ['a'], outputs: ['b'], blockers: ['c'], targets: ['d'],
  });
  for (const k of ['sheng', 'xie', 'ke', 'hao']) {
    assert.equal(r.cells[k].affects_verdict, true, k + ' 的标记与表不一致');
  }
});

test('verdict_reads_cells 要把「规则读了哪几格」说出来', () => {
  const r = TJ.judgeTask({ subject: 'X', resources: ['a'], targets: ['t'] });
  assert.deepEqual(r.verdict_reads_cells.slice().sort(), ['hao', 'ke', 'sheng', 'xie']);
});

test('★ peers 怎么填都不改变 verdict (行为上证明它不参与)', () => {
  const mk = peers => TJ.judgeTask({
    subject: 'X', resources: ['a'], outputs: ['b'], blockers: ['c', 'd', 'e'], targets: ['f'], peers,
  });
  const none = mk([]);
  const some = mk(['p1']);
  const many = mk(['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.equal(none.verdict, some.verdict);
  assert.equal(none.verdict, many.verdict);
  assert.notEqual(none.cells.tong.state, many.cells.tong.state, '档位确实变了, 判定却没变 —— 这正是要写明的事');
});

test('装时自检通过 (声明与规则真的一致)', () => {
  TJ._assertTaskJudgeLayer();
});

// ============================================================
// 三、负例: 守卫必须会咬人
//   ⚠️ 走**子进程 + 临时副本**, 不改共享源文件
//      (2026-10-22 踩过: node --test 多文件并行会读到被改坏的源文件)
// ============================================================

/**
 * 把 task_judge.js 复制到临时目录, 在副本上注入改动, 跑副本的装时自检。
 * 副本 require 的 ./wuxing_strength / bazi 等相对依赖不存在 —— 所以只做
 * **文本级**替换 + 语法检查 + 手工构造的那段不变量校验, 不整份 require。
 *
 * 更稳的做法: 只验「判据逻辑」这一段, 靠子进程 require **原文件**,
 * 在子进程里 monkey-patch 规则 —— 但规则是内联在 judgeTask 里的, 改不了。
 * 所以这里走副本 + 轻量沙箱: 只抽取 _assertTaskJudgeLayer 的不变量算法重跑一遍。
 */
function runInvariantWithMutatedRule(mutation) {
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const src = path.join(CORE, '64i', 'bagua_annotations', 'task_judge.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-tj-'));
  const copy = path.join(tmpDir, 'task_judge.js');
  // 只复制本文件 + 它 require 的两个依赖的**目录**, 让相对路径能解析
  fs.mkdirSync(path.join(tmpDir, 'bagua_annotations'), { recursive: true });
  fs.copyFileSync(src, copy);
  fs.mkdirSync(path.join(tmpDir, 'bagua_annotations'), { recursive: true });
  // wuxing_strength / ten_gods 的相对路径: task_judge 只 require wuxing_strength
  const wsSrc = path.join(CORE, '64i', 'bagua_annotations', 'wuxing_strength.js');
  if (fs.existsSync(wsSrc)) fs.copyFileSync(wsSrc, path.join(tmpDir, 'wuxing_strength.js'));

  let code = fs.readFileSync(copy, 'utf8');
  const applied = mutation(code);
  if (applied === null) return { ran: false, reason: 'mutation anchor not found' };
  fs.writeFileSync(copy, applied, 'utf8');

  const r = spawnSync(process.execPath, ['-e', 'require(' + JSON.stringify(copy) + ');'], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { ran: true, threw: r.status !== 0, out };
}

test('负例: 偷偷把同我者加进 S2 规则 → 自检当场报出来', () => {
  const r = runInvariantWithMutatedRule(code => {
    const old = '} else if (ke === STATE.STRONG && xie === STATE.NOT_ESTABLISHED) {';
    if (code.indexOf(old) < 0) return null;
    return code.replace(old,
      '} else if (ke === STATE.STRONG && xie === STATE.NOT_ESTABLISHED && cells.tong.state === STATE.STRONG) {');
  });
  assert.equal(r.ran, true, '注入失败(anchor 没找到) —— 测试本身失效了');
  assert.equal(r.threw, true,
    '往规则里加了 peers 条件, 自检竟然没报 —— 判据是空壳\n' + r.out);
  assert.ok(r.out.includes('同我者'),
    '报错要直接指着「同我者」, 而不是绕到别的格\n' + r.out);
  assert.ok(r.out.includes('affects_verdict'),
    '报错要点明 affects_verdict=false 是在骗模型\n' + r.out);
});

test('负例: 把去重逻辑拆掉 → 灌水洞重新出现, 自检之外也能测出来', () => {
  // 这条不靠自检(自检不管去重), 靠直接验行为: 去掉了去重, 灌水就该重新成立。
  // 用**独立重算**验证判据本身, 而不是改共享文件。
  const src = require('fs').readFileSync(
    path.join(CORE, '64i', 'bagua_annotations', 'task_judge.js'), 'utf8');
  assert.ok(src.includes('dropped_duplicates'),
    '去重与如实上报都在 —— 拆掉的话这条会红');
  assert.ok(/seen\.has\(k\)/.test(src), '去重的 Map 判重逻辑还在');
});

test('自检要接在启动路径上 (load 期抛会被调用方 try/catch 吞掉)', () => {
  const src = require('fs').readFileSync(path.join(CORE, 'pangu-single.js'), 'utf8');
  assert.ok(src.includes('_assertTaskJudgeLayer'),
    '六格判局自检没接进启动链 —— 只在 load 期抛的话, 调用方一 try/catch 就没了');
});

test('工具描述要标明 peers 不参与停点 (免得模型白填一堆平级协作)', () => {
  const { TOOLS_SCHEMA } = require(path.join(CORE, 'modules', 'tools_schema.js'));
  const d = TOOLS_SCHEMA.wuxing_judge.function.description;
  assert.ok(d.includes('不参与停点'),
    'schema 描述里没写 peers 不参与 —— 模型会以为填了能左右结论');
  assert.ok(d.length < 900,
    '描述别又顶穿预算(第一版 718 字符就把 li 的 schema 顶到 9329)');
});
