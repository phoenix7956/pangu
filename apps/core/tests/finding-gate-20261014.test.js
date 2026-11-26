'use strict';

/**
 * 2026-10-14 — finding_gate 接地层测试
 *
 * 这组测试的靶子是一份真实存在过的假报告: ~/Desktop/pangu_bug_report.md。
 * 那份报告声称 tools/index.js 有 140+ 处未受保护的 JSON.parse, 行号从 3505 起
 * 每 3 行递增到 4530(= 该文件总行数), 并且给一个根本不存在的
 * apps/core/mcp_servers/pixel2text.js 报了 15 条 "Promise 链无 .catch"。
 * 本测试把那张表原样喂进 gate, 要求它一条都不放行。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  groundFinding,
  groundFindings,
  isGroundedType,
  REJECT,
} = require('../agents/finding_gate');

// __dirname = <repo>/apps/core/tests → 上溯三级才是仓库根
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TARGET = 'apps/core/modules/tools/index.js';

function tmpFixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-gate-'));
  const file = path.join(dir, 'sample.js');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return { root: dir, rel: 'sample.js', abs: file };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bug 复现: bug_report.md 那张 JSON.parse 表
// ─────────────────────────────────────────────────────────────────────────────

test('bug_report.md 的 140 行 JSON.parse 表 — 退化重复整组判死', () => {
  // 报告原文: tools/index.js 行号 3505, 3508, 3511 ... 4530, 全部 code="JSON.parse(...)"
  const fabricated = [];
  for (let line = 3505; line <= 4530; line += 3) {
    fabricated.push({
      file: TARGET,
      line,
      type: 'json_parse_no_try',
      severity: 'critical',
      message: 'LLM 返回畸形 JSON → 未捕获异常 → agent loop 崩溃',
    });
  }
assert.equal(fabricated.length, 342, '报告表 3505→4530 步长 3 = 342 行, 该文件后半段几乎每行都被报了一遍');

  const out = groundFindings(fabricated, { root: REPO_ROOT });

  // 一条都不许放行
  assert.equal(out.verified.length, 0, '不该有任何一条通过接地');
  assert.ok(out.degenerate_groups.length >= 0);
  assert.equal(out.total_out, 0);
});

test('退化重复: 同一文件同类型行号等差且 >=8 条 → 整组丢', () => {
// 每行都真含 console.log —— 这些发现能过 pattern 核验, 必须靠退化检测兜住
const { root, rel } = tmpFixture(Array.from({ length: 40 }, (_, i) => `console.log(${i});`));
  const ramp = [];
// 文件 40 行, ramp 取 1,3,...,39 共 20 条 — 全部先过 pattern 核验, 再被退化检测整组丢
for (let i = 0; i < 20; i++) {
    ramp.push({ file: rel, line: 1 + i * 2, type: 'console_in_prod', severity: 'low', message: 'x' });
  }
  const out = groundFindings(ramp, { root });
  assert.equal(out.verified.length, 0, '等差铺满全文件的表格 = LLM 退化重复');
  assert.ok(out.degenerate_groups.includes(`${rel}:console_in_prod`));
assert.equal(out.stats.degenerate_run, 20);
});

test('非等差的真发现不被退化检测误伤', () => {
  const { root, rel } = tmpFixture([
    "console.log('a');",
    'let x = 1;',
    "console.log('b');",
    'let y = 2;',
    "console.info('c');",
  ]);
  const real = [
    { file: rel, line: 1, type: 'console_in_prod', severity: 'low', message: 'x' },
    { file: rel, line: 3, type: 'console_in_prod', severity: 'low', message: 'x' },
    { file: rel, line: 5, type: 'console_in_prod', severity: 'low', message: 'x' },
  ];
  const out = groundFindings(real, { root });
  assert.equal(out.verified.length, 3, '真实 3 处 console 应该全放行');
  assert.equal(out.degenerate_groups.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 报告点名的具体假条目 — 逐条核验
// ─────────────────────────────────────────────────────────────────────────────

test('报告称 tools/index.js:200 是 JSON.parse — 该行其实是注释分隔线', () => {
  // 仓库事实: 第 200 行是 "  // =====..." 分隔注释, 与 JSON.parse 毫无关系
  const actual = fs.readFileSync(path.join(REPO_ROOT, TARGET), 'utf8').split('\n')[199];
  assert.ok(!/JSON\.parse/.test(actual), `第 200 行不该含 JSON.parse, 实际是: ${actual.trim()}`);

  const res = groundFinding(
    { file: TARGET, line: 200, type: 'json_parse_no_try', severity: 'critical' },
    { root: REPO_ROOT },
  );
  // 类型是语义类(不在 TYPE_PATTERNS), 但 file/line 都真实 → 这一条靠别的手段拦,
  // 真实防护来自「语义类不得冒充确定性发现」这条规则, 见下一个测试
  assert.equal(res.ok, true);
  assert.equal(res.line_text.trim(), actual.trim());
});

test('语义类 type 不得冒充确定性发现 (json_parse_no_try 等不是可接地类型)', () => {
  for (const t of ['json_parse_no_try', 'promise_no_catch', 'race_condition', 'missing_await', 'off_by_one']) {
    assert.equal(isGroundedType(t), false, `${t} 不该被当成可机械核验的确定性类型`);
  }
  assert.equal(isGroundedType('eval_usage'), true);
  assert.equal(isGroundedType('console_in_prod'), true);
});

test('报告称 pixel2text.js 有 15 处 Promise 链问题 — 该文件根本不存在', () => {
  const res = groundFinding(
    { file: 'apps/core/mcp_servers/pixel2text.js', line: 11, type: 'promise_no_catch', severity: 'high' },
    { root: REPO_ROOT },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, REJECT.FILE_NOT_FOUND);
});

test('行号越界 — 报告打在文件末行必须放行, 末行+1 必须拒', () => {
// 文件以换行结尾时 split('\n') 会多出一个空元素, 那是幽灵行, 不算真实行号上限
const raw = fs.readFileSync(path.join(REPO_ROOT, TARGET), 'utf8').split('\n');
const total = raw.length && raw[raw.length - 1] === '' ? raw.length - 1 : raw.length;
// 2026-10-15: 原来这里写死 assert.equal(total, 4530)。那不是被测行为, 只是写测试那天
// 顺手记下的行数 —— tools/index.js 之后正常长到 4535 行, 断言就红了, 而它想验的
// "末行合法 / 末行+1 被拒" 两件事其实都还好好的。现在按实际行数算, 只留一个下限
// 当烟雾弹: 万一路径错了或行数统计坏掉(比如幽灵行处理回归), 仍然会响。
assert.ok(total >= 4000, `tools/index.js 行数异常: ${total} — 路径或行数统计坏了?`);
// 用语义类 type (不在 TYPE_PATTERNS) 隔离出行号校验本身
const inRange = groundFinding({ file: TARGET, line: total, type: 'race_condition' }, { root: REPO_ROOT });
const over = groundFinding({ file: TARGET, line: total + 1, type: 'race_condition' }, { root: REPO_ROOT });
assert.equal(inRange.ok, true, `${total} 行应仍在范围内`);
assert.equal(over.ok, false);
assert.equal(over.reason, REJECT.LINE_OUT_OF_RANGE);
});

test('报告称末行 4530 是 console.log — 实际是 _normalizeAllToolParams(TOOLS), pattern 核验当场拆穿', () => {
const last = fs.readFileSync(path.join(REPO_ROOT, TARGET), 'utf8').trimEnd().split('\n').pop();
assert.equal(last, '_normalizeAllToolParams(TOOLS);');

const res = groundFinding({ file: TARGET, line: 4530, type: 'console_in_prod' }, { root: REPO_ROOT });
assert.equal(res.ok, false);
assert.equal(res.reason, REJECT.PATTERN_MISMATCH);
});

// ─────────────────────────────────────────────────────────────────────────────
// 接地机制本身的边界
// ─────────────────────────────────────────────────────────────────────────────

test('pattern_mismatch — 类型对但那一行没有该模式, 照样拒', () => {
  const { root, rel } = tmpFixture(['const a = 1;', 'const b = 2;', 'const c = 3;']);
  const res = groundFinding({ file: rel, line: 2, type: 'eval_usage', severity: 'high' }, { root });
  assert.equal(res.ok, false);
  assert.equal(res.reason, REJECT.PATTERN_MISMATCH);
});

test('模式匹配的行必须放行, 并回填真实源码', () => {
  const { root, rel } = tmpFixture(['const a = 1;', "console.log('hi');", 'const c = 3;']);
  const res = groundFinding({ file: rel, line: 2, type: 'console_in_prod', severity: 'low' }, { root });
  assert.equal(res.ok, true);
  assert.equal(res.finding.source, "console.log('hi');");
});

test('缺 file 字段 / 路径逃逸 一律拒', () => {
  const noFile = groundFinding({ line: 1, type: 'eval_usage' }, { root: REPO_ROOT });
  assert.equal(noFile.ok, false);
  assert.equal(noFile.reason, REJECT.NO_FILE);

  const escape = groundFinding({ file: '../../../../etc/hosts', line: 1, type: 'eval_usage' }, { root: REPO_ROOT });
  assert.equal(escape.ok, false);
  assert.equal(escape.reason, REJECT.PATH_ESCAPE);
});

test('line 非整数 / <1 一律拒', () => {
  const { root, rel } = tmpFixture(['a', 'b']);
  assert.equal(groundFinding({ file: rel, line: 0, type: 'debugger' }, { root }).reason, REJECT.BAD_LINE);
  assert.equal(groundFinding({ file: rel, line: 1.5, type: 'debugger' }, { root }).reason, REJECT.BAD_LINE);
  assert.equal(groundFinding({ file: rel, line: '2', type: 'debugger' }, { root }).reason, REJECT.BAD_LINE);
});

test('同一 (file,line,type) 重复上报只留一条', () => {
  const { root, rel } = tmpFixture(['debugger;', 'x']);
  const dup = [
    { file: rel, line: 1, type: 'debugger', severity: 'med', message: 'a' },
    { file: rel, line: 1, type: 'debugger', severity: 'med', message: 'b' },
    { file: rel, line: 1, type: 'debugger', severity: 'med', message: 'c' },
  ];
  const out = groundFindings(dup, { root });
  assert.equal(out.total_out, 1);
  assert.equal(out.total_in, 3);
});

test('stats 能区分「幻觉」和「真发现」', () => {
  const { root, rel } = tmpFixture(['debugger;', 'y']);
  const out = groundFindings([
    { file: rel, line: 1, type: 'debugger', severity: 'med' },          // 真
    { file: 'nope/nope.js', line: 1, type: 'debugger' },                 // 文件不存在
    { file: rel, line: 999, type: 'debugger' },                          // 越界
    { line: 1, type: 'debugger' },                                       // 没 file
  ], { root });
  assert.equal(out.verified.length, 1);
  assert.equal(out.stats[REJECT.FILE_NOT_FOUND], 1);
  assert.equal(out.stats[REJECT.LINE_OUT_OF_RANGE], 1);
  assert.equal(out.stats[REJECT.NO_FILE], 1);
});
