'use strict';

/**
 * Finding Gate — bug 发现项的确定性接地层 (grounding gate)
 *
 * 2026-10-14 立。起因: ~/Desktop/pangu_bug_report.md 那份 663 行报告里, P0 表格
 * 140+ 行全是编造的 —— 它给 tools/index.js 报了几百处 JSON.parse, 而该文件实际
 * 只有 14 处; 报告点名的 3 个文件在仓库里根本不存在 (其中 pixel2text.js 独占
 * 15 条 "Promise 链无 .catch")。表格行号从 3505 起每 3 行递增到 4530, 正好是
 * 该文件总行数 —— 典型的 LLM 退化重复, 不是扫描结果。
 *
 * 根因不在"扫描不准", 而在于**发现项从头到尾没有任何接地**:
 *   dispatcher._callRole() 直接 `this.llm(prompt, {role:'xun', tools})`,
 *   从不调用 bugHunter.execute(), 于是 bug_hunter.js 里那 235 行确定性正则扫描器
 *   在这条路径上是死代码; LLM 拿到"扫描代码返回 [{line,type,severity}]"的指令 +
 *   read_file 工具, 行号全靠它自己编。而 §0.22 硬约束"必须调至少 1 个工具"只校验
 *   有没有调用过工具, 不校验工具结果和后面那 139 行有没有关系 —— 调过一次 read_file
 *   就"合规"了, 剩下的条目可以完全自由发挥。
 *
 * 踩坑日志铁律 1: **注释 ≠ 隔离**。"不误报"写在 systemPrompt 里是注释, LLM 看不见
 * 也不遵守; 必须是机制。所以本模块就是那个机制: 对每一条发现, 拿真实的文件重新读
 * 一遍, 逐条机械核验 —— 文件在不在、行号在不在范围内、那一行源码里到底有没有它声称
 * 的模式。核不过就丢, 不进结果。
 *
 * 用法:
 *   const { groundFindings } = require('./finding_gate');
 *   const { verified, rejected, stats } = groundFindings(llmFindings, { root });
 *
 * 核验不通过的 finding 不会被"修正", 只会带着 reject_reason 被丢掉 —— 宁可漏报,
 * 不可假报。漏报的代价是多扫一遍; 假报的代价是照着不存在的行号改生产代码。
 */

const fs = require('fs');
const path = require('path');

/**
 * 发现类型 → 该行源码里必须真实匹配到的模式。
 * 模式直接抄自 bug_hunter.js 的规则库, 保证「门」和「扫描器」对同一条规则认识一致。
 * 语义类发现 (LLM 判断类) 不在此表 —— 它们不该被机械核验, 也不该拿到 critical。
 */
const TYPE_PATTERNS = {
  eval_usage: /\beval\s*\(/,
  xss: /innerHTML\s*=|document\.write/,
  command_injection: /child_process|\bexec\s*\(|\bspawn\s*\(/,
  hardcoded_secret: /(password|api[_-]?key|secret)\s*=\s*['"][^'"]+['"]/i,
  always_true: /if\s*\(\s*(true|false)\s*\)/,
  incomplete: /TODO|FIXME|HACK|XXX/,
  console_in_prod: /console\.(log|debug|info)\s*\(/,
  debugger: /\bdebugger\b/,
  string_concat_in_loop: /\+\s*['"][^'"]*['"]/,
  loose_equality: /\b\w+\s*==\s*\w+\b/,
  bare_except: /except\s*:/,
  json_parse: /JSON\.parse/,
  // unreachable 的判据就是"该行有非空白内容", 放在核验里没有信息量, 故不收
};

/** 语义判断类 —— 机械核验不了, 只能标记, 不能拿它冒充确定性发现 */
const SEMANTIC_TYPES = new Set([
  'race_condition', 'null_pointer', 'resource_leak', 'memory_leak',
  'json_parse_no_try', 'promise_no_catch', 'unbounded_array',
  'missing_await', 'off_by_one',
]);

/** 拒绝原因 —— 全部可计数, 便于上线后看是真发现还是幻觉 */
const REJECT = {
  NO_FILE: 'no_file',
  PATH_ESCAPE: 'path_escape',
  FILE_NOT_FOUND: 'file_not_found',
  FILE_UNREADABLE: 'file_unreadable',
  BAD_LINE: 'bad_line',
  LINE_OUT_OF_RANGE: 'line_out_of_range',
  PATTERN_MISMATCH: 'pattern_mismatch',
};

/** 把 finding.file 解析成 root 之下的绝对路径, 挡住 ../ 逃逸 */
function resolveInside(root, file) {
  const base = path.resolve(root);
  const abs = path.resolve(base, file);
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

/**
 * 核验单条 finding。
 * @param {object} f   { file, line, type, severity, message }
 * @param {object} opts { root, lineCache }
 * @returns {{ok: true, finding: object, line_text: string} | {ok: false, reason: string}}
 */
function groundFinding(f, opts = {}) {
  const root = opts.root || process.cwd();

  if (!f || typeof f !== 'object') return { ok: false, reason: REJECT.NO_FILE };
  if (typeof f.file !== 'string' || !f.file.trim()) return { ok: false, reason: REJECT.NO_FILE };

  const abs = resolveInside(root, f.file);
  if (!abs) return { ok: false, reason: REJECT.PATH_ESCAPE };

  const cache = opts.lineCache || (opts.lineCache = new Map());
  let lines = cache.get(abs);
  if (lines === undefined) {
    if (!fs.existsSync(abs)) return { ok: false, reason: REJECT.FILE_NOT_FOUND };
    try {
      lines = fs.readFileSync(abs, 'utf8').split('\n');
    } catch (_) {
      return { ok: false, reason: REJECT.FILE_UNREADABLE };
    }
    cache.set(abs, lines);
  }

  const line = f.line;
  if (!Number.isInteger(line) || line < 1) return { ok: false, reason: REJECT.BAD_LINE };
// 差一修正: 文件以换行结尾时 split('\n') 会多出一个尾部空元素, 那是幽灵行。
// 不去掉它, 「行号 = 文件总行数 + 1」这种根本不存在的行号就能蒙混过关。
// (2026-10-14: 这个 off-by-one 就是被 finding-gate 测试当场抓出来的)
const realLines = (lines.length && lines[lines.length - 1] === '') ? lines.length - 1 : lines.length;
if (line > realLines) return { ok: false, reason: REJECT.LINE_OUT_OF_RANGE };

  const lineText = lines[line - 1];

  // 确定性类型: 那行源码里必须真的有它声称的模式, 否则就是编的
  const pat = TYPE_PATTERNS[f.type];
  if (pat && !pat.test(lineText)) return { ok: false, reason: REJECT.PATTERN_MISMATCH };

  return { ok: true, finding: { ...f, file: path.relative(root, abs), source: lineText.trim() }, line_text: lineText };
}

/**
 * 批量核验。返回的 verified 是唯一可以直接给人看的集合。
 *
 * 额外做两件机器该做而人容易漏的事:
 *   1. 去重 —— 同一 (file, line, type) 只留一条。规则重叠时很容易重复报同一行。
 *   2. 退化检测 —— 同一文件同一 type 的行号若呈等差数列且密度异常高, 判为
 *      LLM 退化重复生成, 整组丢弃。这正是 bug_report.md 那张表的指纹。
 */
function groundFindings(findings, opts = {}) {
  const verified = [];
  const rejected = [];
  const stats = {};
  const seen = new Set();
  const perGroup = new Map();

  const bump = (r) => { stats[r] = (stats[r] || 0) + 1; };

  for (const f of Array.isArray(findings) ? findings : []) {
    const res = groundFinding(f, opts);
    if (!res.ok) {
      bump(res.reason);
      rejected.push({ finding: f, reject_reason: res.reason });
      continue;
    }
    const key = `${res.finding.file}:${res.finding.line}:${res.finding.type}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const gk = `${res.finding.file}:${res.finding.type}`;
    if (!perGroup.has(gk)) perGroup.set(gk, []);
    perGroup.get(gk).push(res.finding.line);
    verified.push(res.finding);
  }

  // 退化重复检测: 同文件同类型 >=8 条且行号呈严格等差 → 整组判为幻觉
  const degenerate = new Set();
  for (const [gk, lineList] of perGroup) {
    if (lineList.length < 8) continue;
    const sorted = [...lineList].sort((a, b) => a - b);
    const step = sorted[1] - sorted[0];
    if (step <= 0) continue;
    let uniform = true;
    for (let i = 2; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] !== step) { uniform = false; break; }
    }
    if (uniform) degenerate.add(gk);
  }

  let finalVerified = verified;
  if (degenerate.size) {
    const kept = [];
    for (const f of verified) {
      if (degenerate.has(`${f.file}:${f.type}`)) {
        bump('degenerate_run');
        rejected.push({ finding: f, reject_reason: 'degenerate_run' });
      } else {
        kept.push(f);
      }
    }
    finalVerified = kept;
  }

  return {
    verified: finalVerified,
    rejected,
    stats,
    degenerate_groups: [...degenerate],
    total_in: Array.isArray(findings) ? findings.length : 0,
    total_out: finalVerified.length,
  };
}

/** 该类型是否值得被当成「确定性发现」上报 */
function isGroundedType(type) {
  return Object.prototype.hasOwnProperty.call(TYPE_PATTERNS, type);
}

module.exports = {
  groundFinding,
  groundFindings,
  isGroundedType,
  resolveInside,
  TYPE_PATTERNS,
  SEMANTIC_TYPES,
  REJECT,
};
