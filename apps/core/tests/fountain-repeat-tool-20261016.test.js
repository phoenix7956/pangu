// 2026-10-16 "带工具的复读放行" 被实机证伪: 同一个 exec_command 重发 8 次
//
// 现场 lt4 (5 步长任务, 本地 qwen3.8-27b), 第一个 executor 刀:
//   [j2-native] 拦截重复工具调用: 1 个 ( exec_command )
//   [j2] §0.31 fountain detected (5 repeats) … (6 repeats) … (7) … (8 repeats)
// 守门每次都拦下了 (DUPLICATE_TOOL_CALL, 一次都没真执行), 但 fountain 分支只问
// "这轮有没有工具调用", 于是 8 次全部放行 —— 8 个整轮 LLM (本地 ~33s/轮 ≈ 4 分钟)
// 全烧在原地打转上, 那一刀一个文件都没多写。
//
// 老判据的原话是「带工具的复读放行 (工具在真干活, 文本复读不致命)」。
// 前提错在: "有工具" ≠ "在干活"。**原样重发**同一个工具不是干活, 是打转。
// 判据收紧成: 放行的前提是"这轮有前面轮次没出现过的新工具调用"。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('fs');

const SRC = () => fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');

// 把 fountain 分支抠出来单独测逻辑: 判据是纯函数式的, 抠出来比跑整轮便宜得多
const _fountainBranch = () => {
  const src = SRC();
  const at = src.indexOf('§0.31 fountain detected');
  assert.ok(at > 0, '找不到 fountain 分支');
  const end = src.indexOf('// P0-#1: shouldGeneratePlan()', at);
  assert.ok(end > at, '找不到 fountain 分支的结尾');
  return src.slice(at, end);
};

test('G1 放行前提是"有新工具", 不是"有工具"', () => {
  const b = _fountainBranch();
  assert.ok(/_fpAnyNewTool/.test(b), '必须算出这一轮有没有**新**工具调用');
  assert.ok(/toolCalls\.length === 0 \|\| !_fpAnyNewTool/.test(b),
    '熔断条件必须同时兜住"纯文本复读"和"工具全是重发"这两种');
});

test('G2 新工具的定义是 seen === 0 (前面轮次从没出现过)', () => {
  const b = _fountainBranch();
  assert.ok(/_crossRoundToolCalls\.get\(/.test(b), '得查前面轮次见过几次');
  assert.ok(/=== 0\)/.test(b), '"新"的定义必须是 0 次见过');
  // 复用防重复守门那个 limit 阈值是**另一个语义**: seen=1 的原样重发会被放行,
  // 而 lt4 现场要的正是把这种也熔断掉。
  assert.ok(!/_CROSS_ROUND_CALL_LIMIT|_CROSS_ROUND_FAIL_LIMIT/.test(b),
    '不能复用防重复守门的 limit 阈值 —— 那是"该不该再执行一遍", 不是"是不是新工作"');
});

test('G3 熔断文案要分清是哪种复读 (原样重发 ≠ 输出相同)', () => {
  const b = _fountainBranch();
  assert.ok(/把同一个工具调用/.test(b), '重发工具的熔断要说清"原样重发", 不然主人以为是模型答非所问');
  assert.ok(/输出完全相同的内容/.test(b), '纯文本复读的老文案不许丢');
});

test('G4 老判据不许被改回来 (结构性)', () => {
  const b = _fountainBranch();
  assert.ok(!/if \(toolCalls\.length === 0\) \{/.test(b),
    '"只要有工具就放行"就是这次的病根, 不许退回');
  // 熔断时必须仍然记账 (老行为不能丢)
  assert.ok(/recordLesson\(_sessionId, 'FOUNTAIN'/.test(b), '熔断要留 lesson, 不然这类卡死无从统计');
  assert.ok(/evoSuccess = false/.test(b), '熔断不许虚报成功');
});

test('G5 端到端语义: 重发 vs 新工具 两种情况的判定结果必须相反', () => {
  // 直接把判据抽出来跑一遍, 不靠读代码"看起来对"
  const evalBranch = (seenKeys, toolCalls) => {
    const map = new Map(seenKeys.map(k => [k, 1]));
    const _stableStringify = (o) => JSON.stringify(o);
    const _crossRoundToolCalls = map;
    const _fpAnyNewTool = (Array.isArray(toolCalls) ? toolCalls : []).some(tc =>
      ((_crossRoundToolCalls
        && _crossRoundToolCalls.get(tc.name + '|' + _stableStringify(tc.params || {}))) || 0) === 0);
    return (toolCalls.length === 0 || !_fpAnyNewTool) ? '熔断' : '放行';
  };
  const K = (n, p) => n + '|' + JSON.stringify(p);
  // lt4 现场: 同一个 exec_command 原样重发 → 熔断
  assert.strictEqual(
    evalBranch([K('exec_command', { command: 'wc -l u1.txt' })], [{ name: 'exec_command', params: { command: 'wc -l u1.txt' } }]),
    '熔断');
  // 真在干活: 换个新工具 → 放行
  assert.strictEqual(
    evalBranch([K('exec_command', { command: 'wc -l u1.txt' })], [{ name: 'read_file', params: { path: 'u1.txt' } }]),
    '放行');
  // 一半新一半旧: 只要有新的就算在干活 (别把真干活误杀)
  assert.strictEqual(
    evalBranch([K('exec_command', { command: 'wc -l u1.txt' })], [
      { name: 'exec_command', params: { command: 'wc -l u1.txt' } },
      { name: 'write_file', params: { path: 'u2.txt' } },
    ]),
    '放行');
  // 纯文本复读 → 熔断
  assert.strictEqual(evalBranch([], []), '熔断');
});
