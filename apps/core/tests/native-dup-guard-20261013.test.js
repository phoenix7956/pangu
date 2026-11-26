'use strict';
// 2026-10-13 native 路径没有防重复调用的硬守门 —— 子 agent 锁死在重复循环里收不了尾
//
// 线上现场 (objw-live-1791859404#sub-1-executor, 探针跑了 10 分钟不结束, 被我手动杀掉):
//   - 同一条 `mkdir -p /tmp/pangu_steps/beta && printf 'b1\n' > b1.txt ...` 在日志里
//     **出现 33 次**, 每次 [smoke-hook-Post] ok=true exec_ms≈1567, batch_id 一路到 43
//   - 而盘上其实早就干完了: /tmp/pangu_steps/beta 只有 b1/b2/b3 三个文件, 内容正确
//   - `[j2-auto-resume] 上限到达但有实质进展 (files 92→98)` / `(files 104→110)` ——
//     files_touched_count 被**重复触碰同一个文件**灌水, 于是「有实质进展」永远为真,
//     预算永远重置, 循环永远收不了尾
//
// 根因: 防重复调用的硬守门 (`seen >= _CROSS_ROUND_CALL_LIMIT` → DUPLICATE_TOOL_CALL)
// 在 j2_agent_loop.js:2838, 那是 **legacy 路径** (2311 行之后)。生产跑的是 **native 路径**
// (1030-2310), 那边只有 `_crossRoundToolCalls` 计数和 [HARD-LOOP] 警告 —— 喊完照跑。
const test = require('node:test');
const assert = require('node:assert/strict');

const loop = require('../modules/j2_agent_loop');

const LIMIT = 1;
const cmd = (c) => ({ name: 'exec_command', params: { command: c } });

test('同一工具同一参数重复调用必须被拦 (native 路径原来只警告不拦)', () => {
  const counters = new Map([['exec_command|{"command":"ls"}', 1]]);
  const { fresh, duplicates } = loop._partitionFreshCalls([cmd('ls')], counters, LIMIT);
  assert.equal(fresh.length, 0, '重复的写/执行类调用不得进执行队列');
  assert.equal(duplicates.length, 1, '必须被识别成重复');
  assert.equal(duplicates[0].tc.name, 'exec_command');
});

test('参数不同必须照常放行 (不能误伤正常的探索)', () => {
  const counters = new Map([['exec_command|{"command":"ls"}', 1]]);
  const { fresh, duplicates } = loop._partitionFreshCalls([cmd('ls -la /tmp')], counters, LIMIT);
  assert.equal(fresh.length, 1, '换参数就该放行');
  assert.equal(duplicates.length, 0);
});

test('第一次调用永远放行 (计数为 0)', () => {
  const { fresh, duplicates } = loop._partitionFreshCalls([cmd('ls')], new Map(), LIMIT);
  assert.equal(fresh.length, 1);
  assert.equal(duplicates.length, 0);
});

test('只读类工具重读不拦 (压缩/换 offset 常触发同参数重读, 不是死循环)', () => {
  // 代码里 _isReadonlyLoop 早就认定了这批工具「重读是合法的, 不该被当成强制熔断」;
  // 硬守门必须尊重这个既有判断, 不能把合法的重读一起拦掉。
  const readOnly = ['read_file', 'list_directory', 'file_find', 'file_grep',
    'memory_search', 'session_recall', 'search_files'];
  for (const name of readOnly) {
    const key = name + '|{}';
    const counters = new Map([[key, 5]]);
    const { fresh, duplicates } = loop._partitionFreshCalls([{ name, params: {} }], counters, LIMIT);
    assert.equal(fresh.length, 1, name + ' 重读必须放行');
    assert.equal(duplicates.length, 0, name + ' 重读不得被拦');
  }
});

test('混合批次: 只有重复的写类被拦, 其余原样放行且顺序不乱', () => {
  const counters = new Map([['exec_command|{"command":"a"}', 3]]);
  const calls = [cmd('a'), cmd('b'), cmd('a'), { name: 'write_file', params: { path: '/x' } }];
  const { fresh, duplicates } = loop._partitionFreshCalls(calls, counters, LIMIT);
  assert.deepEqual(fresh.map(c => (c.params && c.params.command) || c.params.path), ['b', '/x']);
  // 批次里 cmd('a') 出现两次, 而计数已是 3 —— 两条都算重复 (legacy 路径同款行为:
  // 判重只看跨轮计数, 不在本批内递增), 所以拦 2 条不是 1 条。
  assert.equal(duplicates.length, 2, '两条 cmd(a) 都该被拦');
  assert.deepEqual(duplicates.map(d => d.tc.params.command), ['a', 'a']);
  // 输入不能被就地改坏
  assert.equal(calls.length, 4, '原数组长度不变');
});

test('_partitionFreshCalls 必须导出 (写完不导出的函数等于没测)', () => {
  assert.equal(typeof loop._partitionFreshCalls, 'function');
});

// 光测纯函数不够: 判重写对了但 native 没接上, 线上照样跑 33 次 (变异 M1/M3 存活)。
// 锁**调用点形态**, 而且锁执行队列的派生来源 —— 函数定义本身满足不了这些断言。
test('native 路径必须真的接上判重 (函数写了不调 = 没修)', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../modules/j2_agent_loop'), 'utf8');
  assert.match(src, /_partitionFreshCalls\(toolCalls,\s*_crossRoundToolCalls,\s*_CROSS_ROUND_CALL_LIMIT\)/,
    'native 路径必须拿跨轮计数做判重');
  assert.match(src, /const _j2Pending = _j2FreshCalls\.slice\(\);/,
    'native 执行队列必须来自判重后的 fresh, 而不是直接用 toolCalls');
  // 被拦的调用必须预置结果: 后面那个循环靠 _j2ExecResults 发 tool 消息,
  // 缺了就变成孤儿 tool_calls, 上游直接 400。
  // 2026-10-17: 这里跟着 tool-result-pairing 那一刀改了形态 —— 落结果统一走
  // _j2SetExecResult(tc, ...), 因为回灌要按 tool_call_id 取 (按 _j2Ukey 推算会撞名,
  // 见 j2_agent_loop 里 _j2ResultByCallId 的注释)。守的是"预置 blocked 结果"这件事,
  // 不是"必须用哪一行 API", 所以跟着改成新形态, 但把意图补严: setter 必须两张表都写。
  assert.match(src, /_j2SetExecResult\(tc,\s*\{\s*ok:\s*false,\s*blocked:\s*true/s,
    '被拦的重复调用必须预置 blocked 结果');
  assert.match(src,
    /const _j2SetExecResult = \(tc, result\) => \{\s*_j2ExecResults\.set\(_j2Ukey\(tc\), result\);\s*if \(tc && tc\.id != null\) _j2ResultByCallId\.set\(tc\.id, result\);/s,
    'setter 必须同时写 _j2ExecResults (跨轮判重用) 和 _j2ResultByCallId (本轮回灌按 id 配对用), 少一张表就会出现孤儿 tool_call');
});
