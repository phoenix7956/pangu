const test = require('node:test');
const assert = require('node:assert/strict');

const { _finalizeAnswerText, _isChildFailure } = require('../modules/j2_dispatcher');

// ─────────────────────────────────────────────────────────────────────────────
// 实案 diag-empty-20261012 (主人: "我叫什么？直接答,别调工具")
//   子 agent 其实答对了 —— summary='孙七'; 综合那轮只吐了工具草稿, 剥完正文为空。
//   旧守卫写的是 `if (fb.length >= 10) return fb`, 于是 2 字的真答案被判"不可信"丢掉,
//   主人收到的是 `⚠️ [盘古 收口异常]` —— 答对了反而被拦, 比答错更糟。
//   正确判据是"回落内容比剥完的更充实", 不是"回落内容够长"。
// ─────────────────────────────────────────────────────────────────────────────
test('剥空后回落: 子 agent 的 2 字真答案必须交付, 不能被长度守卫杀掉', () => {
  const out = _finalizeAnswerText('   ', '孙七');
  assert.equal(out, '孙七', '剥空后应交付子 agent 结论 "孙七"');
  assert.doesNotMatch(out, /收口异常/, '不该退回拦截提示 —— 答案本来就在手里');
});

test('回落只在"比剥完的更充实"时才生效', () => {
  // 剥剩 1 字, 回落 2 字 → 回落更充实, 用回落
  assert.equal(_finalizeAnswerText('好', '孙七'), '孙七');
  // 剥剩 20 字真正文, 回落 2 字 → 正文更充实, 保留正文
  const real = '你叫孙七，生日是1986年3月15日。';
  assert.equal(_finalizeAnswerText(real, '孙七'), real);
  // 两边都空 → 才允许拦
  assert.match(_finalizeAnswerText('  ', '  '), /收口异常/);
  assert.match(_finalizeAnswerText('', ''), /收口异常/);
});

test('正常长答复原样返回, 不被回落逻辑动过', () => {
  const real = '你叫孙七，生日是1986年3月15日，我记住了。';
  assert.equal(_finalizeAnswerText(real, '别的结论'), real);
  // 恰好 10 字边界仍算有效正文
  assert.equal(_finalizeAnswerText('一二三四五六七八九十', '别的'), '一二三四五六七八九十');
});

// ─────────────────────────────────────────────────────────────────────────────
// 同一实案的第二面: 主人明说"别调工具", analyzer 听话不调工具直接答了 ——
// runtimeStatus 的定义是"有无成功工具", 于是 status='failed', 整轮对外报
// status: failed / child_failures 非空, 自报没干活。实际答案是对的。
// 直答轮拿到实质结论就算成功 (听话 ≠ 没干活)。
// ─────────────────────────────────────────────────────────────────────────────
const _child = (runtimeStatus, summary) => ({ agent: 'analyzer', result: { runtimeStatus, summary } });

test('直答轮: 没调工具但有实质结论 → 不算 child failure', () => {
  const r = _child('failed', '孙七');
  assert.equal(_isChildFailure(r, true), false, '直答轮听话不该被判失败');
});

test('非直答轮: 同样形态仍然是失败 (别把守卫修成万能免死金牌)', () => {
  assert.equal(_isChildFailure(_child('failed', '孙七'), false), true);
});

test('直答轮但没结论 (summary 空/1 字) → 仍然算失败', () => {
  assert.equal(_isChildFailure(_child('failed', ''), true), true);
  assert.equal(_isChildFailure(_child('failed', '  '), true), true);
  assert.equal(_isChildFailure(_child('failed', '孙'), true), true);
});

test('显式 error 永远算失败, 直答轮也不例外', () => {
  assert.equal(_isChildFailure({ agent: 'x', error: 'ECONNRESET' }, true), true);
});

test('验收不通过的文字信号在直答轮照样算失败', () => {
  // 直答轮豁免只针对"因为没调工具所以 failed", 不该放过真验收不通过
  assert.equal(_isChildFailure(_child('completed', '结论未通过核验, 请重试'), true), true);
  assert.equal(_isChildFailure(_child('completed', '工具熔断'), true), true);
});

test('正常完成的子 agent 不算失败', () => {
  assert.equal(_isChildFailure(_child('completed', '共扫描 12 个文件, 4471 行'), false), false);
  assert.equal(_isChildFailure(_child('completed', '共扫描 12 个文件, 4471 行'), true), false);
});
