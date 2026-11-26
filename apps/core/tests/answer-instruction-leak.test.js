// 2026-10-13 兜底答案把子 agent 的内部指令当 H1 泄给用户
//
// 现场 (2026-10-13, /Users/you/Desktop/rea/probe_trivial.py, 两个真实会话):
//   问 "你好"          → ### 回应老板问候，并确认可以继续接收任务；保持简洁自然，不作卦象分析
//                         主人在，凌晨 0:34 了（已核系统时间）。任务随时发。
//   问 "回答一个词:就绪" → ### 按真卦确认"恒"之动变与"解"趋势，核实当前执行条件已具备，并仅返回"就绪"
//                         就绪  核验证据: /tmp/pangu_v10/ ...
//
// 链路 (已逐段验证):
//   guardAnswer("回答一个词:就绪", ...) → { blocked: true, text: "我没有拿到与原问题对齐的答案..." }
//   dispatcher 丢掉 guard 的诚实回答, 改返回 _subConclusionFallback(results)
//   _subConclusionFallback = '### ' + r.task 首行(80字) + '\n\n' + summary
//   → 子 agent 的**任务指令**成了给用户看的 H1 标题。
//
// _fallbackSynthesis 同一个毛病: cleanTask 只剥了 "\n\n【重要】" 尾巴,
// "不作卦象分析" / "并仅返回…" 这类指令原样留在标题里。
//
// 注: 2026-09-18 那个"guard 全拦时交付子任务真结论, 不甩'请重试'"的初衷是对的,
// 本测试不否定它 —— 只要求交付的是**结论**, 不是**指令**。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SRC = fs.readFileSync(require.resolve('../modules/j2_dispatcher.js'), 'utf8');
const disp = require('../modules/j2_dispatcher');

test('兜底交付的是子任务结论, 不是子 agent 的任务指令', () => {
  const results = [{
    agent: 'analyzer',
    // 现场原句 (planner 写给子 agent 的指令)
    task: '回应老板问候，并确认可以继续接收任务；保持简洁自然，不作卦象分析',
    result: { summary: '主人在，凌晨 0:34 了。任务随时发。' },
  }];
  const out = disp._subConclusionFallback(results);
  assert.ok(!out.includes('不作卦象分析'), '内部指令不得出现在给用户的答案里: ' + out);
  assert.ok(!out.includes('保持简洁自然'), '内部指令不得出现在给用户的答案里: ' + out);
  assert.ok(out.includes('主人在，凌晨 0:34 了'), '子任务真结论必须仍然交付 (2026-09-18 的初衷不能丢): ' + out);
});

test('现场二: "并仅返回…" 这类指令也不得泄出', () => {
  const results = [{
    agent: 'checker',
    task: '按真卦确认"恒"之动变与"解"趋势，核实当前执行条件已具备，并仅返回"就绪"',
    result: { summary: '核验证据: 三份文件均落盘且格式正确。就绪。' },
  }];
  const out = disp._subConclusionFallback(results);
  assert.ok(!out.includes('并仅返回'), '内部指令不得泄出: ' + out);
  assert.ok(!out.includes('按真卦确认'), '内部指令不得泄出: ' + out);
  assert.ok(out.includes('就绪'), '结论仍要交付: ' + out);
});

test('多个子任务时每段都要有可读标识, 且都不含指令', () => {
  const results = [
    { agent: 'analyzer', task: '核定基础材料与逻辑；不作卦象分析', result: { summary: 'A 结论' } },
    { agent: 'reflector', task: '解释整体卦意，禁止调 task_done', result: { summary: 'B 结论' } },
  ];
  const out = disp._subConclusionFallback(results);
  assert.ok(out.includes('A 结论') && out.includes('B 结论'), '两段结论都要交付: ' + out);
  for (const leak of ['不作卦象分析', '禁止调 task_done']) {
    assert.ok(!out.includes(leak), '内部指令不得泄出 (' + leak + '): ' + out);
  }
  // 每段仍要有标题, 否则读者不知道哪段是哪段
  assert.ok((out.match(/^### /gm) || []).length === 2, '每段仍需保留标题: ' + out);
});

test('没有结论时不产出空壳', () => {
  assert.strictEqual(disp._subConclusionFallback([]), '');
  assert.strictEqual(disp._subConclusionFallback([{ agent: 'a', task: 't', error: 'boom' }]), '');
});

test('_fallbackSynthesis 同一个毛病也已修 (它是闭包, 走源码守卫)', () => {
  const m = SRC.match(/const _fallbackSynthesis = \(e\) => \{[\s\S]*?\n  \};/);
  assert.ok(m, '应能找到 _fallbackSynthesis');
  assert.ok(!/\$\{i \+ 1\}\. \$\{cleanTask\}/.test(m[0]),
    '_fallbackSynthesis 仍在把子 agent 的任务指令当编号标题');
});
