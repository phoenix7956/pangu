'use strict';
// 2026-10-13 现场 (/tmp/pangu-single.err 逐条配对统计, SILENT_FAILURE 共 16 次):
//   轮数 0~3, **工具数 16/16 次全是 0**, **16/16 次完全没有 plan**
// 但每一次都原样告诉主人:
//   ① "但进度已落盘"      —— 0 工具 + 无 plan, 什么都没写
//   ② "接在卡住那步上"    —— 没有 plan 就没有步可接
//   ③ "交接卡已写, 新会话秒接上" —— 这条路径压根不写交接卡 (交接卡在 200 轮/80 万 token
//      的另一条分支写), 16/16 次都是假话
// 而且④ "别重发整个任务, 会从头烧" 在零产出时也不成立: 没有产出就没有东西可丢。
//
// 这跟今天已经修过的几个"状态说谎"是同一族 (afac1c6 自认失败仍报 success、
// 219f69c 综合答案照抄过期自述), 但这条是**直接说给主人听的原话**, 不是后台状态位。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const J = require('../modules/j2_agent_loop');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .map(l => l.replace(/\/\/.*$/, '')).join('\n');
}

// 生产现场最常见的那一种: 跑了 2 轮, 什么都没干
const NO_OUTPUT = () => J._buildSilentFailureMsg(2, [], null);

test('零产出时不得声称"进度已落盘"', () => {
  const { msg, hasProgress } = NO_OUTPUT();
  assert.equal(hasProgress, false);
  assert.ok(!msg.includes('进度已落盘'),
    '0 工具 + 无 plan = 什么都没写, 说"已落盘"是骗主人: ' + msg);
});

test('零产出时不得让主人去"接在卡住那步上"', () => {
  const { msg } = NO_OUTPUT();
  assert.ok(!msg.includes('卡住那步上'), '没有 plan 就没有步可接: ' + msg);
});

test('任何情况下都不得说"交接卡已写" (这条路径根本不写交接卡)', () => {
  for (const [label, args] of [
    ['零产出', [2, [], null]],
    ['有工具', [2, ['exec_command'], null]],
    ['有 plan', [2, [], { steps: [{ title: '一', status: 'done' }] }]],
  ]) {
    const { msg } = J._buildSilentFailureMsg(...args);
    assert.ok(!msg.includes('交接卡已写'),
      `${label} 场景说了"交接卡已写" —— 交接卡只在 200 轮/80 万 token 的另一分支写, 这条路径没写过: ${msg}`);
  }
});

test('零产出时不该劝主人"别重发, 会从头烧" (没产出就没有东西可丢)', () => {
  const { msg } = NO_OUTPUT();
  assert.ok(!msg.includes('会从头烧'), '零产出时重发不损失任何进度: ' + msg);
  assert.match(msg, /重发/, '应直接告诉主人重发即可: ' + msg);
});

test('零产出时要说清是"什么都没产出", 而不是"任务做不完"', () => {
  const { msg } = NO_OUTPUT();
  assert.match(msg, /什么都没产出/, '就算 0 轮也要照实说: ' + msg);
  // 现场第 13 例: 0 轮 + 0 工具
  const zero = J._buildSilentFailureMsg(0, [], null);
  assert.equal(zero.hasProgress, false, '0 轮 + 0 工具同样不能说有进展');
  assert.match(zero.msg, /跑了 0 轮/, zero.msg);
  assert.ok(!zero.msg.includes('进度已落盘'), zero.msg);
});

test('有工具产出时保留原语义 (别把诚实修成消极)', () => {
  const { msg, hasProgress } = J._buildSilentFailureMsg(2, ['exec_command', 'read_file'], null);
  assert.equal(hasProgress, true);
  assert.ok(msg.includes('进度已落盘'), '真写了东西就该说落盘: ' + msg);
  assert.ok(msg.includes('接在卡住那步上'), '有产出时续跑建议是有效的: ' + msg);
});

test('有 plan 且已完成至少一步 → 算有进度, 并显示进度行', () => {
  const { msg, hasProgress } = J._buildSilentFailureMsg(3, [],
    { steps: [{ title: '一', status: 'done' }, { title: '二', status: 'pending' }] });
  assert.equal(hasProgress, true, 'plan 已完成一步 = 有进度, 即使本轮没调工具');
  assert.match(msg, /进度: 1\/2 步完成/, msg);
  assert.match(msg, /卡在「二」/, msg);
});

test('有 plan 但一步没完成且本轮 0 工具 → 仍然算零产出', () => {
  const { hasProgress, msg } = J._buildSilentFailureMsg(1, [],
    { steps: [{ title: '一', status: 'pending' }] });
  assert.equal(hasProgress, false, '建了计划但一步没做完不算已落盘: ' + msg);
});

test('接线: 调用点必须走这个纯函数, 原地不能留一份旧文案', () => {
  const src = stripComments(fs.readFileSync(path.join(__dirname, '../modules/j2_agent_loop.js'), 'utf8'));
  assert.match(src, /_buildSilentFailureMsg\(rounds, effectiveRealToolsCalled, _planSnapshot\)/,
    '调用点应接上正确的工具计数 effectiveRealToolsCalled');
  // “但进度已落盘”只应该在裹函数里出现一次 (它是 hasProgress 分支的文案)
  // —— 调用点附近再留一份就是那个本号要清掉的无条件副本。
  const hits = src.split('但进度已落盘').length - 1;
  assert.equal(hits, 1, '这句无条件断言应只剩裹函数里的一份, 现在有 ' + hits + ' 份');
});
