// 2026-10-13 整段伪工具调用原样漏上屏 (现场 session=pcheck-1791823788)
//
// 现场: 20 个文件任务全部成功, done 事件 status=completed / success=true,
// 但落盘会话里唯一那条 assistant (也就是用户实际收到的答复) 是:
//   task_done({"summary":"已核对 /tmp/pangu_synth_v/f00.txt 至 f19.txt：20/20 文件均存在
//   且非空…无缺失、无不合格文件，任务完成。"})
// —— 140 字原始工具标记, 一个字没剥。
//
// 为什么没拦住: _stripPseudoToolMarkup 现有六条规则全都要求尖括号 (<tool>/<tool_call>)
// 或"调用工具:"字样, 裸的 name({...}) 形状一个都不认。pseudoToolText 那道守卫又要求
// realTools.length === 0, 而这轮 dispatcher 确实调过工具, 于是也不触发。
//
// 修法边界: 只处理"整段就是一个 name({JSON}) 伪调用"这一种形状。
// 裸 name(...) 出现在正文中间无法与正常文字区分 ("见 read_file(3)" 这类), 宁可不碰。
// 判据用"参数是合法 JSON 对象" —— 正常散文里几乎不会出现 name({"k":"v"}) 这种形状。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const H = require('../modules/j2_helpers');
const strip = H._stripPseudoToolMarkup;

const REAL = 'task_done({"summary":"已核对 /tmp/x/f00.txt 至 f19.txt：20/20 文件均存在且非空，编号与文件名逐一对应。无缺失、无不合格文件，任务完成。"})';

test('现场形态: 整段 task_done({...}) 必须剥掉, 并取出其中的 summary 作答复', () => {
  const out = strip(REAL);
  assert.ok(!out.includes('task_done'), '不得把工具名漏给用户: ' + out);
  assert.ok(!out.includes('{"summary"'), '不得把 JSON 原文漏给用户: ' + out);
  assert.match(out, /20\/20 文件均存在且非空/, 'summary 内容要保留: ' + out);
  assert.match(out, /任务完成。$/, '答复应以 summary 结尾');
});

test('没有 summary 字段时剥成空串 (交给 _finalizeAnswerText 回落到子 agent 结论)', () => {
  const out = strip('exec_command({"command":"ls -la /tmp/x"})');
  assert.strictEqual(out, '', '拿不到可用正文就别硬造, 实得: ' + JSON.stringify(out));
});

test('summary 不是字符串时同样剥成空串', () => {
  assert.strictEqual(strip('task_done({"summary":{"nested":1}})'), '');
  assert.strictEqual(strip('write_file({"path":"/tmp/a","content":"x"})'), '');
});

test('尾部有分号/空白仍要认', () => {
  assert.match(strip(REAL + ';'), /20\/20/);
  assert.match(strip('\n\n' + REAL + '\n  '), /20\/20/);
});

test('正常正文里的括号调用不得被误伤', () => {
  const prose = '我在 f00.txt 里写了 5 个词, 然后 read_file(3) 读回来核对, 没问题。';
  assert.strictEqual(strip(prose), prose, '散文里的 name(...) 必须原样保留');
});

test('散文里的 JSON 片段也不该被当成伪调用', () => {
  const prose2 = '配置是这样的 {"timeout": 3000} 这样写, 然后重启服务。';
  assert.strictEqual(strip(prose2), prose2);
});

test('正文后面又跟了别的内容时, 不整段剥 (避免吃掉真话)', () => {
  const mixed = 'check_status({"ok":true}) 另外补充一句说明。';
  assert.strictEqual(strip(mixed), mixed,
    '只处理"整段就是一个伪调用"; 混着别的内容时宁可不动');
});

test('整段是 name(非JSON参数) 时必须原样保留 (不确定就不下手)', () => {
  // 剥不掉的判据是 JSON.parse 本身, 不是"看起来像不像工具名"。
  // name(...) 整段出现但参数不是 JSON 时删掉它就是误伤正常文字。
  assert.strictEqual(strip('foo(bar)'), 'foo(bar)', '参数非 JSON → 原样保留');
  assert.strictEqual(strip('sqrt(2)'), 'sqrt(2)');
  assert.strictEqual(strip('list(a, b)'), 'list(a, b)');
});

test('参数是合法 JSON 但不是对象 (数字/数组/字符串) 时原样保留', () => {
  assert.strictEqual(strip('f(3)'), 'f(3)');
  assert.strictEqual(strip('f([1,2])'), 'f([1,2])');
  assert.strictEqual(strip('f("x")'), 'f("x")');
});

test('已有尖括号规则不受影响', () => {
  assert.doesNotMatch(strip('<tool_call>{"name":"read_file"}</tool_call>'), /tool_call/);
});
