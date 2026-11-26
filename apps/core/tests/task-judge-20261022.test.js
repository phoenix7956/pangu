'use strict';
// 六格判局 (2026-10-22)
//
// 老板 10-21 原话:「就拿八字排盘, 其实都是规律结合变化形成的生彼泻克耗,
//   但是这用在项目上, 加强了停顿, 走一步判断一步, 而且挂永远没有100%」
//
// 盘古原来的「生彼泻克耗」只有一条路: bazi_calc 排完盘顺带算六格。
// 于是这套内核**只能用于八字** —— 老板要的「这用在项目上」没有入口。
// 这一批把内核提成通用判局: `64i/bagua_annotations/task_judge.js` + 工具 `wuxing_judge`。
//
// 本测试盯三件事:
//   ① 内核的分档/停点规则守不守得住 (纯函数, 穷举)
//   ② **判据不足时必须拒绝给结论** —— 这是「永远没有100%」的落地
//   ③ 接线在不在: 工具注册了没、研究型角色够得着没 (第八批的教训: 建了没接 = 白建)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..');
const TJ = require(path.join(CORE, '64i', 'bagua_annotations', 'task_judge.js'));

// ============================================================
// 一、内核分档
// ============================================================

test('分档: 0 条=不成立 / 1~2 条=弱 / 3 条以上=强', () => {
  const r = TJ.judgeTask({ subject: 'X', resources: ['a'] });
  assert.equal(r.cells.sheng.state, 'weak');
  const r2 = TJ.judgeTask({ subject: 'X', resources: ['a', 'b'] });
  assert.equal(r2.cells.sheng.state, 'weak', '2 条仍是弱');
  const r3 = TJ.judgeTask({ subject: 'X', resources: ['a', 'b', 'c'] });
  assert.equal(r3.cells.sheng.state, 'strong', '3 条起算强 (课件: 五行过强=3个及以上)');
  const r0 = TJ.judgeTask({ subject: 'X', outputs: ['已产出'] });
  assert.equal(r0.cells.sheng.state, 'not_established', '没列就是不成立, 不是弱');
});

test('六格齐全: 生我者/我生者/克我者/我克者/同我者 + 彼', () => {
  // 至少给一条 —— 全空时内核会拒给结论 (那是下面单独一条测的)
  const r = TJ.judgeTask({ subject: '一件事', resources: ['一条助力'] });
  assert.ok(r.ok);
  for (const k of ['sheng', 'xie', 'ke', 'hao', 'tong']) {
    assert.ok(r.cells[k], '缺格 ' + k);
    assert.ok(r.cells[k].shuxing, '格 ' + k + ' 缺术数名');
    assert.ok(r.cells[k].meaning, '格 ' + k + ' 缺语义');
  }
  assert.equal(r.bi.shuxing, '彼');
  assert.equal(r.subject, '一件事');
});

test('术数名是老板那张表原样 (生/彼/泻/克/耗), 不许改叫', () => {
  // 用集合比, 不比顺序 —— JS 的 sort 按 UTF-16 码位排, 跟拼音顺序没关系
  const names = new Set(TJ.CELLS.map(c => c.shuxing));
  for (const n of ['生我者', '我生者', '克我者', '我克者', '同我者']) {
    assert.ok(names.has(n), '缺术数名 ' + n);
  }
  assert.equal(names.size, 5, '术数名有重名或多出来的');
  const aliases = new Set(TJ.CELLS.map(c => c.alias));
  for (const a of ['生', '泄', '克', '耗', '比']) {
    assert.ok(aliases.has(a), '缺别名 ' + a);
  }
  assert.equal(aliases.size, 5);
});

// ============================================================
// 二、停点规则 (老板「加强了停顿, 走一步判断一步」)
// ============================================================

test('S1 空转: 无助力 且 无可攻克项 → 停', () => {
  const r = TJ.judgeTask({ subject: 'X', peers: ['有人在'] });
  assert.equal(r.verdict, 'stop');
  assert.equal(r.verdict_label, '停');
  assert.match(r.stop_reason, /空转/);
});

test('S1 的边界: 只差一格就不算空转 (助力在 → 续)', () => {
  const r = TJ.judgeTask({ subject: 'X', resources: ['有一条'] });
  assert.notEqual(r.verdict, 'stop', '有助力就不该判空转');
});

test('S2 压顶: 阻力强 且 没产出 → 换向 (先解阻力, 不是死磕)', () => {
  const r = TJ.judgeTask({
    subject: 'X',
    resources: ['a', 'b', 'c'],
    blockers: ['阻力1', '阻力2', '阻力3'],
  });
  assert.equal(r.verdict, 'redirect');
  assert.equal(r.verdict_label, '换向');
  assert.match(r.next_step, /阻力/);
});

test('S2 的边界: 有产出就不判换向', () => {
  const r = TJ.judgeTask({
    subject: 'X',
    resources: ['a', 'b', 'c'],
    blockers: ['阻力1', '阻力2', '阻力3'],
    outputs: ['已落盘的东西'],
  });
  assert.equal(r.verdict, 'continue');
});

test('常态: 有料有产出有可啃的 → 续', () => {
  const r = TJ.judgeTask({
    subject: 'X', resources: ['a', 'b', 'c'], outputs: ['o1'], blockers: ['b1'], targets: ['t1'],
  });
  assert.equal(r.verdict, 'continue');
  assert.match(r.next_step, /走一步判断一步/);
});

// ============================================================
// 三、「永远没有 100%」—— 判据不足必须拒绝给结论
// ============================================================

test('★ 什么都没列 → 拒绝给结论 (不许拿「全空」反推出「停」)', () => {
  const r = TJ.judgeTask({ subject: 'X' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_INPUT');
  assert.equal(r.verdict, undefined, '拒绝给结论时**不许**带 verdict —— 带了就等于还是给了结论');
});

test('★ 没给主体 → 拒绝给结论', () => {
  const r = TJ.judgeTask({ resources: ['a'] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_SUBJECT');
});

test('★ 只有同我者有东西 → 仍然给得出结论 (不是全空)', () => {
  const r = TJ.judgeTask({ subject: 'X', peers: ['平级的一个'] });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'stop', '有平级但没助力没可啃 → 空转');
});

test('输出永远带「永不100%」声明和出处', () => {
  const r = TJ.judgeTask({ subject: 'X', resources: ['a'] });
  assert.match(r.disclaimer, /从不给 100%/);
  assert.ok(r.source && r.source.length > 4);
  assert.ok(!/\.js$/.test(r.source), '出处不能是文件名 —— 模型会满世界 find/grep 这个文件 (10-21 实跑教训)');
});

test('模型不能自己下结论: 传 state/verdict 也不认 (只认条目)', () => {
  const r = TJ.judgeTask({ subject: 'X', resources: ['a'], state: 'strong', verdict: 'stop' });
  assert.equal(r.cells.sheng.state, 'weak', '状态只能由条目数算出来, 不许外部塞');
  assert.equal(r.verdict, 'continue', 'verdict 只能由内核算出来');
});

// ============================================================
// 四、接线 (第八批教训: 建了没接 = 白建)
// ============================================================

test('工具已注册, 且返回结构完整', async () => {
  const { TOOLS } = require(path.join(CORE, 'modules', 'tools', 'index.js'));
  assert.equal(typeof TOOLS.wuxing_judge, 'function', 'wuxing_judge 没注册');
  const r = await TOOLS.wuxing_judge({ params: { subject: '盘古整改', resources: ['a'] } });
  assert.equal(r.ok, true);
  assert.equal(r.data.subject, '盘古整改');
  assert.ok(r.data.cells && r.data.cells.sheng);
  assert.ok(r.data.verdict);
});

test('工具在空输入时**报错**而不是给个假结论', async () => {
  const { TOOLS } = require(path.join(CORE, 'modules', 'tools', 'index.js'));
  const r = await TOOLS.wuxing_judge({ params: { subject: 'X' } });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_INPUT');
});

test('工具在 schema 里, 且主对话够得着', () => {
  const S = require(path.join(CORE, 'modules', 'tools_schema.js'));
  assert.ok(S.TOOLS_SCHEMA.wuxing_judge, 'schema 里没有 wuxing_judge');
  assert.ok(S.MAIN_GENERAL_TOOLS_FOR_LLM.includes('wuxing_judge'),
    '主对话够不着 wuxing_judge —— 跟 bazi_calc/hexagram_lookup 当年同一个坑');
});

test('★ 至少一个研究型角色够得着 (第八批: 工具够不着 = 必错)', () => {
  const SA = require(path.join(CORE, 'agents', 'sub-agent.js'));
  const research = ['li', 'xun'];
  const any = research.some(r => ((SA.ROLES[r] && SA.ROLES[r].tools) || []).includes('wuxing_judge'));
  assert.ok(any, '研究型角色 (li/xun) 都够不着 wuxing_judge');
  // li 的提示里必须写明什么时候调 —— 不写, 模型就不知道有这条路
  const liBlock = SA.ROLES.li.system;
  assert.match(liBlock, /wuxing_judge/, 'li 提示里没提 wuxing_judge');
});

test('只读守卫不拦 wuxing_judge (纯计算, 不写盘)', () => {
  const ap = require(path.join(CORE, 'modules', 'action_policy.js'));
  for (const role of ['li', 'xun']) {
    const v = ap.checkRoleAction(role, 'wuxing_judge', { subject: 'X', resources: ['a'] });
    assert.equal(v.ok, true, role + ' 被只读守卫拦了: ' + JSON.stringify(v));
  }
});

test('★ 主 agent 的提示里必须写明 wuxing_judge 什么时候用 (E2E 实测踩出来的)', () => {
  // 2026-10-22 E2E 实测: 工具注册了、白名单也给了, 但**主 agent 快路径**
  //   (自己拿 exec_command + critical_point_analysis 干完) 压根不调它 ——
  //   问「这项目该继续投还是收口」, 工具在 MAIN 集里, 主提示里却没提过它。
  // 这跟 decision.md §P1-4 记的「bazi_calc 在 MAIN 集里却没被用」是同一个形状。
  // 修法: 主提示里写明「卦象给方向, 六格给停点」, 以及什么时候用。
  const SRC = fs.readFileSync(path.join(CORE, 'pangu-single.js'), 'utf8');
  assert.match(SRC, /wuxing_judge/, '主提示里没提 wuxing_judge —— 工具在 MAIN 集里但没人知道');
  assert.match(SRC, /六格/, '主提示里没提「六格」');
  // 提示里必须把卦象和六格的分工说清, 不然模型不知道该用哪个
  assert.match(SRC, /卦象给的是\*\*方向\*\*[\s\S]{0,40}六格给的是\*\*停点\*\*/,
    '主提示里没写清「卦象给方向、六格给停点」的分工');
});

// ============================================================
// 五、不许跟爻层边界打架
// ============================================================

test('六格判局层没有把术数下沉到爻层 (爻层边界守卫仍全绿)', () => {
  const G = require(path.join(CORE, 'modules', 'yao_layer_boundary.js'));
  const r = G.checkYaoLayerBoundary();
  assert.ok(r.ok, '爻层红线被越过了:\n' + r.violations.join('\n'));
});

test('装时自检: 六格判局层自己齐整', () => {
  // require 即自检 —— 上面能 require 到就说明自检过了; 这里再钉一次格数
  assert.equal(TJ.CELLS.length, 5);
  assert.equal(TJ.STRONG_THRESHOLD, 3);
});

