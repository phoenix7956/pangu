const test = require('node:test');
const assert = require('node:assert/strict');
const HELPERS = require('../modules/j2_helpers');

// probe-ctx-final-20261012-1 第 2 轮: 最终答复原文就是 <system_info>{"metric":"all"}
// —— 这是模型写的第四种假工具调用形态, 之前三种 (_stripPseudoToolMarkup 认的
// <tool name> / <tool_call> / 调用工具:) 都不覆盖它。
test('XML 标签裹 JSON 的假工具调用必须剥掉', () => {
  const shapes = [
    '<system_info>{"metric":"all"}',
    '<system_info>{"metric":"all"}</system_info>',
    '好的，这是结果：<read_file>{"path":"a.js"}</read_file> 完成。',
  ];
  for (const s of shapes) {
    const out = HELPERS._stripPseudoToolMarkup(s);
    assert.doesNotMatch(out, /<[a-z_]+>\s*\{/, `未剥掉假工具 JSON: ${s}`);
    assert.doesNotMatch(out, /system_info|read_file/, `残留工具名: ${s}`);
  }
});

test('正常中文 / 裸 JSON / 普通 HTML 不能被这条规则误伤', () => {
  const keep = [
    '主人叫张三，生日1986年3月15日。',
    '{"a":1}',
    '<div>hello</div>',
    '结论：已完成, 详见 <summary> 一节。',
  ];
  for (const s of keep) {
    assert.equal(HELPERS._stripPseudoToolMarkup(s), s, `被误剥: ${s}`);
  }
});

test('剥完的正文仍要能触发收口回落 (不足 10 字时不交付空白)', () => {
  const stripped = HELPERS._stripPseudoToolMarkup('<system_info>{"metric":"all"}');
  assert.ok(stripped.trim().length < 10);
});
