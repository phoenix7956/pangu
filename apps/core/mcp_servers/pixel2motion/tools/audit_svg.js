#!/usr/bin/env node
/**
 * tools/audit_svg.js
 * audit_svg MCP Tool — SVG 路径审计 (smoothness + complexity)
 *
 * 战略定位: Pixel2Motion 5 步流程第 3 步 (跳过 motion_spec, 由 Pangu 推理替代)
 * 输入:   SVG 字符串 + max_complexity
 * 输出:   { ok, total_paths, total_segments, total_beziers,
 *           complexity_score, smoothness_score, passed, issues, audit_time_ms }
 *
 * 算法:
 *   1. 正则解析 <path>/<circle>/<rect>/<polygon>/<line> 元素
 *   2. 数 M/L/H/V/C/Q/S/T/Z 命令 + 元素总数
 *   3. 平滑度: 检查相邻 L 命令角度突变 + 过小段比例
 *   4. 输出建议: 路径段过多 / 贝塞尔过多 / 重复元素 / 角度突变 / 短段
 *
 * 依赖: 无 (纯 Node.js, 零 npm)
 * 导出:
 *   - auditSvg(args)         → 主入口, 返 { ok, ... } 或 { ok:false, error }
 *   - AUDIT_SVG_TOOL_SCHEMA  → MCP tool schema (for server.js TOOLS array)
 */

'use strict';

// ============================================================
// 常量
// ============================================================

const DEFAULT_MAX_COMPLEXITY = 50;
const ABS_MAX_COMPLEXITY = 10000;     // 防止恶意大值
const MIN_MAX_COMPLEXITY = 1;
const MAX_SVG_SIZE = 2 * 1024 * 1024;  // 2MB, 略大于 animate_logo_svg 的 1MB

// 平滑度调参
const SHARP_ANGLE_DEG = 150;          // 超过这个内角视为尖角 (smoothness 扣分)
const SHORT_SEGMENT_RATIO = 0.3;      // 短段(长度 < 中位 0.3 倍) 占比 > 50% 视为过碎
const SHORT_SEGMENT_RATIO_BAD = 0.5;
const BEZIER_RATIO_BAD = 0.5;         // 贝塞尔占总段 > 50% 建议简化

// ============================================================
// 工具函数
// ============================================================

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * 从 d 属性里数 SVG path 命令数 (大写字母 M/L/C/Q/Z/A/H/V/S/T)
 * 忽略数字和分隔符 (空格/逗号/-/.)
 */
function countPathCommands(d) {
  if (!d) return { segments: 0, beziers: 0, moveto: 0, closepath: 0, raw: '' };
  const raw = d.match(/[MLHVCSQTAZmlhvcsqtaz]/g) || [];
  let segments = 0;     // M/L/H/V (绘图 / 直线) 命令
  let beziers = 0;      // C/Q (贝塞尔) 命令
  let moveto = 0;       // M
  let closepath = 0;    // Z
  for (const c of raw) {
    switch (c.toUpperCase()) {
      case 'M': moveto++; segments++; break;     // moveto 算作 1 段
      case 'L': segments++; break;
      case 'H': segments++; break;
      case 'V': segments++; break;
      case 'C': beziers++; segments++; break;    // 1 个 C 算 1 段 (但同时记 1 贝塞尔)
      case 'Q': beziers++; segments++; break;
      case 'S': segments++; break;                // smooth cubic: 视为非贝塞尔简化
      case 'T': segments++; break;                // smooth quad: 视为非贝塞尔简化
      case 'A': segments++; break;                // arc
      case 'Z': closepath++; break;               // Z 不计入 segments
    }
  }
  return { segments, beziers, moveto, closepath, raw: raw.length };
}

/**
 * 提取 path d 里的所有 (x,y) 坐标点 (粗略解析, 假设 path 数字间用空格/逗号分隔)
 * 用于角度突变检测
 * 简化策略: 不做完整 SVG path 状态机, 只抓 L 命令后的两个数
 */
function extractLPoints(d) {
  if (!d) return [];
  // 匹配 (M|L) 后跟数字对 (允许负数 / 小数)
  // 例: M10,10 L20,20 L30,15
  const points = [];
  // 拆 token (空格或逗号), 找 L/M 后的两个连续数字
  // 在 [字母→数字 / 数字→字母] 和逗号 / 空白处插入空格, 然后 split
  const normalized = d
    .replace(/([MLHVCSQTAZmlhvcsqtaz])(?=-?\d)/g, '$1 ')   // M0 → M 0
    .replace(/(\d)(?=[MLHVCSQTAZmlhvcsqtaz])/g, '$1 ');  // 0M → 0 M
  const tokens = normalized.split(/[\s,]+/).filter(t => t.length > 0);
  let expecting = 0;        // 0=无, 1=等x, 2=等y
  let cur = null;
  let prevCmd = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^[MLHVCSQTAZmlhvcsqtaz]$/.test(t)) {
      // 是命令
      prevCmd = t.toUpperCase();
      if (prevCmd === 'M' || prevCmd === 'L') {
        expecting = 2;
        cur = { x: null, y: null };
      } else {
        expecting = 0;
      }
    } else if (/^-?\d/.test(t) && (prevCmd === 'L' || prevCmd === 'M')) {
      // 数字, 配合 L/M
      const num = parseFloat(t);
      if (Number.isFinite(num)) {
        if (expecting === 2) {
          cur.x = num;
          expecting = 1;
        } else if (expecting === 1) {
          cur.y = num;
          if (cur.x !== null && cur.y !== null) {
            points.push({ x: cur.x, y: cur.y });
          }
          // M 命令只取 1 个点, 后续数字当作 L (SVG 规范)
          expecting = prevCmd === 'M' ? 2 : 0;
          cur = { x: null, y: null };
        }
      }
    }
  }
  return points;
}

/**
 * 算两点距离
 */
function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 算 (p0->p1->p2) 在 p1 处的内角 (度)
 * 返回 0-180
 */
function innerAngleDeg(p0, p1, p2) {
  const v1x = p0.x - p1.x, v1y = p0.y - p1.y;
  const v2x = p2.x - p1.x, v2y = p2.y - p1.y;
  const l1 = Math.sqrt(v1x * v1x + v1y * v1y);
  const l2 = Math.sqrt(v2x * v2x + v2y * v2y);
  if (l1 < 1e-9 || l2 < 1e-9) return 180; // 退化
  const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
  const cosA = Math.max(-1, Math.min(1, dot));
  return Math.acos(cosA) * 180 / Math.PI;
}

// ============================================================
// 元素提取 (正则)
// ============================================================

/**
 * 提取所有 <path d="..."> 的 d 属性
 */
function extractPaths(svg) {
  const out = [];
  // 匹配 <path ... d="..."  (允许属性跨多行, 用 [\s\S] 而不是 .)
  const re = /<path\b[^>]*\bd\s*=\s*"([^"]*)"/gi;
  let m;
  while ((m = re.exec(svg)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * 数 <circle> / <rect> / <polygon> / <line> 个数
 */
function countBasicShapes(svg) {
  const counts = {
    circle: (svg.match(/<circle\b/gi) || []).length,
    rect: (svg.match(/<rect\b/gi) || []).length,
    polygon: (svg.match(/<polygon\b/gi) || []).length,
    polyline: (svg.match(/<polyline\b/gi) || []).length,
    line: (svg.match(/<line\b/gi) || []).length,
    ellipse: (svg.match(/<ellipse\b/gi) || []).length,
    use: (svg.match(/<use\b/gi) || []).length,
  };
  return counts;
}

/**
 * 检测重复元素 (按 tag 配 attributes 数量)
 * 简化版: 数每个基本形状标签, 若某种 > 3 个则提示
 */
function findDuplicateShapes(shapeCounts) {
  const issues = [];
  for (const [tag, n] of Object.entries(shapeCounts)) {
    if (tag === 'use') continue;
    if (n >= 3) {
      issues.push(`重复元素 ${tag}×${n}, 考虑用 <use href="#id"> 引用`);
    }
  }
  return issues;
}

// ============================================================
// 主审计函数
// ============================================================

/**
 * 核心审计: 输入 SVG 字符串, 返 { total_paths, total_segments, ... }
 * 任何异常抛给上层
 */
function computeAudit(svg) {
  // 1. 解析
  const paths = extractPaths(svg);
  const shapeCounts = countBasicShapes(svg);

  // 2. 路径统计
  let totalSegments = 0;
  let totalBeziers = 0;
  let totalMoveto = 0;
  let totalClosepath = 0;
  const allPoints = [];      // 用于角度突变检测

  for (const d of paths) {
    const c = countPathCommands(d);
    totalSegments += c.segments;
    totalBeziers += c.beziers;
    totalMoveto += c.moveto;
    totalClosepath += c.closepath;
    const pts = extractLPoints(d);
    for (const p of pts) allPoints.push(p);
  }

  // 3. 元素总数
  const totalElements =
    paths.length +
    shapeCounts.circle +
    shapeCounts.rect +
    shapeCounts.polygon +
    shapeCounts.polyline +
    shapeCounts.line +
    shapeCounts.ellipse;

  // 4. 平滑度
  // 4a. 角度突变数
  let sharpCorners = 0;
  let angleSamples = 0;
  for (let i = 1; i < allPoints.length - 1; i++) {
    const a = innerAngleDeg(allPoints[i - 1], allPoints[i], allPoints[i + 1]);
    angleSamples++;
    if (a < SHARP_ANGLE_DEG) sharpCorners++;
  }
  const angleSharpRatio = angleSamples > 0 ? sharpCorners / angleSamples : 0;

  // 4b. 短段比例 (只对 L 点对)
  const segLengths = [];
  for (let i = 1; i < allPoints.length; i++) {
    const d = dist(allPoints[i - 1], allPoints[i]);
    if (d > 0) segLengths.push(d);
  }
  let shortSegRatio = 0;
  if (segLengths.length >= 3) {
    const sorted = segLengths.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median > 0) {
      const shortCount = segLengths.filter(l => l < median * (1 + SHORT_SEGMENT_RATIO) && l < median).length;
      // 短段定义: < 中位数 * 0.3
      const veryShort = segLengths.filter(l => l < median * SHORT_SEGMENT_RATIO).length;
      shortSegRatio = veryShort / segLengths.length;
    }
  }

  // 5. 平滑度评分 0-1
  //    起点 1.0
  //    角度突变 > 30% → 扣到 0.6
  //    短段过多 (>50%) → 再扣
  //    极小样本 (无 path) → 默认 1.0
  let smoothness = 1.0;
  if (angleSamples >= 2) {
    smoothness -= angleSharpRatio * 0.5;   // 最多扣 0.5
    smoothness -= Math.max(0, shortSegRatio - SHORT_SEGMENT_RATIO_BAD) * 0.5;
  }
  smoothness = Math.max(0, Math.min(1, smoothness));

  // 6. 复杂度评分 0-1 (相对 max_complexity, 默认 50)
  //    0 = 极简, 1 = 超出
  //    用 total_segments / (max_complexity * 2) 映射
  //    注意 passed 是 complexity < max_complexity, 不是 score
  const refScale = DEFAULT_MAX_COMPLEXITY * 2;  // 100 段算 1.0
  const complexityScore = Math.max(0, Math.min(1, totalSegments / refScale));

  // 7. 建议
  const issues = [];
  if (totalSegments > DEFAULT_MAX_COMPLEXITY) {
    issues.push(`路径段数过多 (${totalSegments} 段), 建议合并相近线段或使用 <use> 引用`);
  }
  if (totalBeziers > totalSegments * BEZIER_RATIO_BAD && totalBeziers >= 3) {
    issues.push(`贝塞尔曲线过多 (${totalBeziers}/${totalSegments}), 建议改用直线段以降低渲染负担`);
  }
  if (paths.length > 5) {
    issues.push(`path 元素数量较多 (${paths.length} 个), 考虑合并到一个 path 或用 <g> 分组`);
  }
  issues.push(...findDuplicateShapes(shapeCounts));
  if (angleSharpRatio > 0.3 && angleSamples >= 2) {
    issues.push(`检测到 ${sharpCorners} 处尖角 (内角 < ${SHARP_ANGLE_DEG}°), 建议用贝塞尔曲线平滑过渡`);
  }
  if (shortSegRatio > SHORT_SEGMENT_RATIO_BAD && segLengths.length >= 2) {
    issues.push(`过短线段比例较高 (${(shortSegRatio * 100).toFixed(0)}%), 考虑合并短段以提升渲染效率`);
  }
  if (totalElements === 0) {
    issues.push('SVG 中未发现可审计的图形元素 (path/circle/rect/polygon/line)');
  }

  return {
    total_paths: paths.length,
    total_segments: totalSegments,
    total_beziers: totalBeziers,
    total_moveto: totalMoveto,
    total_closepath: totalClosepath,
    total_elements: totalElements,
    shape_counts: shapeCounts,
    complexity_score: Number(complexityScore.toFixed(3)),
    smoothness_score: Number(smoothness.toFixed(3)),
    sharp_corners: sharpCorners,
    angle_samples: angleSamples,
    short_segment_ratio: Number(shortSegRatio.toFixed(3)),
    issues,
  };
}

// ============================================================
// 输入校验
// ============================================================

function validateArgs(args) {
  if (!args || typeof args !== 'object') {
    return { ok: false, error: 'args must be an object' };
  }

  // svg
  if (!isNonEmptyString(args.svg)) {
    return { ok: false, error: 'svg must be a non-empty string' };
  }
  if (args.svg.length > MAX_SVG_SIZE) {
    return { ok: false, error: `svg too large (>${MAX_SVG_SIZE} bytes)` };
  }
  if (!args.svg.includes('<svg') && !args.svg.includes('<?xml')) {
    return { ok: false, error: 'svg does not look like an SVG (missing <svg or <?xml tag)' };
  }

  // max_complexity (optional, 默认 50)
  let maxComplexity = DEFAULT_MAX_COMPLEXITY;
  if (args.max_complexity !== undefined && args.max_complexity !== null) {
    if (typeof args.max_complexity !== 'number' || !Number.isFinite(args.max_complexity)) {
      return { ok: false, error: 'max_complexity must be a finite number' };
    }
    if (!Number.isInteger(args.max_complexity)) {
      return { ok: false, error: 'max_complexity must be an integer' };
    }
    if (args.max_complexity < MIN_MAX_COMPLEXITY || args.max_complexity > ABS_MAX_COMPLEXITY) {
      return { ok: false, error: `max_complexity must be in [${MIN_MAX_COMPLEXITY}, ${ABS_MAX_COMPLEXITY}], got: ${args.max_complexity}` };
    }
    maxComplexity = args.max_complexity;
  }

  return {
    ok: true,
    value: {
      svg: args.svg,
      max_complexity: maxComplexity,
    },
  };
}

// ============================================================
// 主入口
// ============================================================

/**
 * audit_svg 主入口
 * 输入: { svg: string, max_complexity?: number }
 * 输出: { ok: true, ... } 或 { ok: false, error }
 */
function auditSvg(args) {
  const start = Date.now();

  // 1. 校验
  const v = validateArgs(args);
  if (!v.ok) {
    return { ok: false, error: v.error };
  }
  const { svg, max_complexity } = v.value;

  // 2. 审计
  let result;
  try {
    result = computeAudit(svg);
  } catch (e) {
    return { ok: false, error: 'audit compute failed: ' + e.message };
  }

  // 3. 通过判断
  const passed = result.total_segments < max_complexity;

  return {
    ok: true,
    total_paths: result.total_paths,
    total_segments: result.total_segments,
    total_beziers: result.total_beziers,
    total_elements: result.total_elements,
    total_moveto: result.total_moveto,
    total_closepath: result.total_closepath,
    shape_counts: result.shape_counts,
    complexity_score: result.complexity_score,
    smoothness_score: result.smoothness_score,
    passed,
    max_complexity,
    issues: result.issues,
    sharp_corners: result.sharp_corners,
    angle_samples: result.angle_samples,
    short_segment_ratio: result.short_segment_ratio,
    audit_time_ms: Date.now() - start,
  };
}

// ============================================================
// MCP Tool Schema
// ============================================================

const AUDIT_SVG_TOOL_SCHEMA = {
  name: 'audit_svg',
  description: '审计 SVG 路径复杂度和平滑度, 返回 complexity_score / smoothness_score / passed / issues。用于 Pixel2Motion 5 步流程第 3 步 (跳过 motion_spec, 由 Pangu 推理替代)。',
  inputSchema: {
    type: 'object',
    properties: {
      svg: {
        type: 'string',
        description: 'SVG 源文件内容 (必填, 最大 2MB, 必须含 <svg 或 <?xml)',
      },
      max_complexity: {
        type: 'number',
        description: `最大允许 path 段数 (含 M/L/H/V/C/Q/S/T/A), 默认 ${DEFAULT_MAX_COMPLEXITY}, 整数范围 [${MIN_MAX_COMPLEXITY}, ${ABS_MAX_COMPLEXITY}]`,
        minimum: MIN_MAX_COMPLEXITY,
        maximum: ABS_MAX_COMPLEXITY,
        default: DEFAULT_MAX_COMPLEXITY,
      },
    },
    required: ['svg'],
  },
};

// ============================================================
// 导出 (CommonJS)
// ============================================================

module.exports = {
  auditSvg,
  computeAudit,
  validateArgs,
  countPathCommands,
  extractPaths,
  countBasicShapes,
  extractLPoints,
  innerAngleDeg,
  AUDIT_SVG_TOOL_SCHEMA,
  DEFAULT_MAX_COMPLEXITY,
};
