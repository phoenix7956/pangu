#!/usr/bin/env node
/**
 * Pixel2Motion MCP Server - 简化版
 *
 * 战略定位: Pangu 端到端推理验证工具 (老板拍板 B6)
 * 输入: SVG + motion_type + duration + easing
 * 输出: 完整 HTML (含 CSS keyframes)
 *
 * 协议: stdio JSON-RPC 2.0 (line-delimited, 跟 pangu-crawler 一致)
 * 风格: CommonJS, 零外部依赖 (只读 stdin/stdout, 写 process)
 *
 * 用法:
 *   node /Users/you/pangu/apps/core/mcp_servers/pixel2motion/server.js
 *
 * 通信:
 *   stdin  ← JSON-RPC requests from Pangu mcp_adapter
 *   stdout → JSON-RPC responses (one per line)
 *   stderr → 调试日志 (MCP 协议要求 stdout 只能走 JSON-RPC)
 */

'use strict';

const { fitSvg, DETAIL_LEVELS: FIT_DETAIL_LEVELS } = require('./tools/fit_svg');

// ============================================================
// 常量
// ============================================================

const SERVER_NAME = 'pixel2motion';
const SERVER_VERSION = '0.2.0';
const PROTOCOL_VERSION = '2024-11-05';

const MOTION_TYPES = ['fade-in', 'scale-up', 'rotate', 'draw-on', 'bounce'];
const EASINGS = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'];
const OUTPUT_FORMATS = ['html', 'svg-with-css'];
const MIN_DURATION = 500;
const MAX_DURATION = 5000;

// ============================================================
// audit_svg tool (Pixel2Motion 5 步流程第 3 步)
// ============================================================

const { auditSvg, AUDIT_SVG_TOOL_SCHEMA } = require('./tools/audit_svg.js');

// ============================================================
// capture_frames tool (Pixel2Motion 5 步流程第 4 步)
// ============================================================

const { captureFrames, CAPTURE_FRAMES_TOOL_SCHEMA } = require('./tools/capture_frames.js');

// ============================================================
// 5 种动效 CSS 模板
// ============================================================

/**
 * 给定 motion_type + easing，生成 CSS @keyframes + .p2m-anim class
 * 返回: { keyframeName: string, keyframes: string, animation: string }
 */
function buildMotionCss(motionType, durationMs, easing) {
  const kfName = `p2m-${motionType}-${easing}`;  // 每个组合唯一 keyframe 名

  let keyframesBody;
  switch (motionType) {
    case 'fade-in':
      keyframesBody = `  from { opacity: 0; }
  to   { opacity: 1; }`;
      break;
    case 'scale-up':
      keyframesBody = `  from { transform: scale(0.3); opacity: 0; }
  to   { transform: scale(1);   opacity: 1; }`;
      break;
    case 'rotate':
      keyframesBody = `  from { transform: rotate(-180deg); opacity: 0; }
  to   { transform: rotate(0deg);    opacity: 1; }`;
      break;
    case 'draw-on':
      // 通过 stroke-dasharray + stroke-dashoffset 实现描边动画
      // 假设总路径长度 1000, 实际 SVG 可用 getTotalLength() 但简化版用 1000
      keyframesBody = `  from { stroke-dasharray: 1000; stroke-dashoffset: 1000; }
  to   { stroke-dasharray: 1000; stroke-dashoffset: 0;    }`;
      break;
    case 'bounce':
      // 弹跳: 3 段关键帧
      keyframesBody = `  0%   { transform: translateY(0);     }
  50%  { transform: translateY(-30px); }
  100% { transform: translateY(0);     }`;
      break;
    default:
      throw new Error(`unsupported motion_type: ${motionType}`);
  }

  const keyframes = `@keyframes ${kfName} {
${keyframesBody}
}`;

  // draw-on 动画不依赖 transform，需用 forwards 让 stroke-dashoffset 保持终态
  const fillMode = motionType === 'draw-on' ? 'forwards' : 'both';
  const animation = `animation: ${kfName} ${durationMs}ms ${easing} 0s 1 ${fillMode};`;

  return { keyframeName: kfName, keyframes, animation };
}

// ============================================================
// HTML 生成
// ============================================================

/**
 * 给定 SVG + 动效参数，生成完整 HTML
 * output_format:
 *   - 'html'         → 完整 <!DOCTYPE html>...</html>
 *   - 'svg-with-css' → <svg>...</svg> + <style>...</style> (用于嵌入)
 */
function buildHtml(svg, motionType, durationMs, easing, outputFormat) {
  const { keyframeName, keyframes, animation } = buildMotionCss(motionType, durationMs, easing);

  // 给 SVG 套一层 wrapper，让 CSS 动画作用在 wrapper 上 (避免破坏 SVG 内部结构)
  // 但要保留 SVG 自身尺寸: 把 width/height 提到 wrapper
  // 简化策略: 把动画 class 加在 SVG 根元素, 需在 SVG 标签内插入 class=
  // 真正简化: 用 <div class="p2m-anim"> 包住 SVG
  const safeSvg = svg.trim();

  if (outputFormat === 'svg-with-css') {
    return `<style>
${keyframes}

.p2m-anim { ${animation} }
</style>

<div class="p2m-anim">
${safeSvg}
</div>`;
  }

  // 'html' 默认
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Pixel2Motion — ${motionType}</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0b0b0f;
    }

${keyframes}

    .p2m-wrap {
      ${animation}
    }
  </style>
</head>
<body>
  <div class="p2m-wrap">
    ${safeSvg}
  </div>
</body>
</html>`;
}

// ============================================================
// 输入校验
// ============================================================

/**
 * 校验并返回 { ok, value, error }
 * value 是归一化后的参数 (默认值填好, 类型转换好)
 */
function validateArgs(args) {
  if (!args || typeof args !== 'object') {
    return { ok: false, error: 'args must be an object' };
  }

  // svg
  if (typeof args.svg !== 'string' || args.svg.length === 0) {
    return { ok: false, error: 'svg must be a non-empty string' };
  }
  if (args.svg.length > 1024 * 1024) {
    return { ok: false, error: 'svg too large (>1MB)' };
  }
  // 简单 SVG 包含检查: 必须有 <svg 或 <?xml
  if (!args.svg.includes('<svg') && !args.svg.includes('<?xml')) {
    return { ok: false, error: 'svg does not look like an SVG (missing <svg or <?xml tag)' };
  }

  // motion_type
  if (typeof args.motion_type !== 'string' || !MOTION_TYPES.includes(args.motion_type)) {
    return { ok: false, error: `motion_type must be one of ${MOTION_TYPES.join('|')}, got: ${JSON.stringify(args.motion_type)}` };
  }

  // duration_ms
  if (typeof args.duration_ms !== 'number' || !Number.isFinite(args.duration_ms)) {
    return { ok: false, error: 'duration_ms must be a finite number' };
  }
  if (args.duration_ms < MIN_DURATION || args.duration_ms > MAX_DURATION) {
    return { ok: false, error: `duration_ms must be in [${MIN_DURATION}, ${MAX_DURATION}], got: ${args.duration_ms}` };
  }

  // easing
  if (typeof args.easing !== 'string' || !EASINGS.includes(args.easing)) {
    return { ok: false, error: `easing must be one of ${EASINGS.join('|')}, got: ${JSON.stringify(args.easing)}` };
  }

  // output_format (optional)
  const outputFormat = args.output_format || 'html';
  if (!OUTPUT_FORMATS.includes(outputFormat)) {
    return { ok: false, error: `output_format must be one of ${OUTPUT_FORMATS.join('|')}, got: ${JSON.stringify(outputFormat)}` };
  }

  return {
    ok: true,
    value: {
      svg: args.svg,
      motion_type: args.motion_type,
      duration_ms: args.duration_ms,
      easing: args.easing,
      output_format: outputFormat,
    },
  };
}

// ============================================================
// Tool: animate_logo_svg
// ============================================================

/**
 * animate_logo_svg 主入口
 * 返回: { ok, html?, svg_size?, css_keyframes?, render_time_ms?, error? }
 */
function animateLogoSvg(args) {
  const start = Date.now();

  // 1. 校验
  const v = validateArgs(args);
  if (!v.ok) {
    return { ok: false, error: v.error };
  }
  const { svg, motion_type, duration_ms, easing, output_format } = v.value;

  // 2. 生成 HTML
  let html;
  try {
    html = buildHtml(svg, motion_type, duration_ms, easing, output_format);
  } catch (e) {
    return { ok: false, error: 'html build failed: ' + e.message };
  }

  // 3. 提取 keyframe 名 (从 css 文本里抓)
  const kfMatch = html.match(/@keyframes\s+([a-zA-Z0-9_\-]+)/);
  const cssKeyframe = kfMatch ? kfMatch[1] : `p2m-${motion_type}-${easing}`;

  return {
    ok: true,
    html,
    svg_size: svg.length,
    css_keyframes: cssKeyframe,
    render_time_ms: Date.now() - start,
  };
}

// ============================================================
// MCP 协议: list_tools / call_tool / initialize
// ============================================================

const TOOLS = [
  AUDIT_SVG_TOOL_SCHEMA,
  CAPTURE_FRAMES_TOOL_SCHEMA,
  {
    name: 'animate_logo_svg',
    description: '把一个 SVG logo 变成带 CSS 动效的 HTML。支持 5 种动效: fade-in / scale-up / rotate / draw-on / bounce。用于 Pangu 端到端推理验证 (B6)。',
    inputSchema: {
      type: 'object',
      properties: {
        svg: {
          type: 'string',
          description: 'SVG 源文件内容 (必填, 最大 1MB, 必须含 <svg 或 <?xml)',
        },
        motion_type: {
          type: 'string',
          enum: MOTION_TYPES,
          description: '动效类型: fade-in | scale-up | rotate | draw-on | bounce',
        },
        duration_ms: {
          type: 'number',
          description: '动效时长 (ms), 范围 [500, 5000]',
        },
        easing: {
          type: 'string',
          enum: EASINGS,
          description: '缓动函数: linear | ease | ease-in | ease-out | ease-in-out',
        },
        output_format: {
          type: 'string',
          enum: OUTPUT_FORMATS,
          default: 'html',
          description: '输出格式: html (默认, 完整文档) | svg-with-css (纯 SVG + style 块)',
        },
      },
      required: ['svg', 'motion_type', 'duration_ms', 'easing'],
    },
  },
  {
    name: 'fit_svg',
    description: '像素 logo (PNG/JPG/WebP/BMP/GIF) → SVG 拟合。检测 3 种基本形状 (圆 / 矩形 / 三角形), 输出 <circle>/<rect>/<polygon> 元素 (不用 <path>)。Pixel2Motion 5 步流程的第 1 步。',
    inputSchema: {
      type: 'object',
      properties: {
        image_path: {
          type: 'string',
          description: '本地图片路径 (PNG/JPG/WebP/BMP/GIF, 必填)',
        },
        max_size: {
          type: 'number',
          default: 200,
          description: '输出 SVG 最大尺寸 (像素), 范围 [16, 4096]。图片会等比缩放到该尺寸内。',
        },
        detail_level: {
          type: 'string',
          enum: FIT_DETAIL_LEVELS,
          default: 'mid',
          description: '拟合精度: low (3 色, 忽略小区域) | mid (6 色, 默认) | high (10 色)',
        },
      },
      required: ['image_path'],
    },
  },
];

function handleInitialize() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
  };
}

function handleListTools() {
  return { tools: TOOLS };
}

async function handleFitSvg(args) {
  // fit_svg 异步路径: spawn Python 并 await
  let result;
  try {
    result = await fitSvg(args || {});
  } catch (e) {
    result = { ok: false, error: 'fit_svg unexpected error: ' + e.message };
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
    isError: !result.ok,
  };
}

async function handleCallTool(name, args) {
  // 返回 MCP 协议标准结构: { content: [...], isError?: bool }
  // async: fit_svg 需要 await Python spawn
  if (name === 'audit_svg') {
    const result = auditSvg(args);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
      isError: !result.ok,
    };
  }

  if (name === 'animate_logo_svg') {
    const result = animateLogoSvg(args);
    if (!result.ok) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: false, error: result.error }, null, 2),
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              html: result.html,
              svg_size: result.svg_size,
              css_keyframes: result.css_keyframes,
              render_time_ms: result.render_time_ms,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (name === 'fit_svg') {
    // async — 需要 await, 走专门的异步路径
    return await handleFitSvg(args);
  }

  if (name === 'capture_frames') {
    // async — Playwright 启动 + 渲染需要时间
    let result;
    try {
      result = await captureFrames(args);
    } catch (e) {
      result = { ok: false, error: 'capture_frames unexpected error: ' + e.message };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
      isError: !result.ok,
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: false, error: `unknown tool: ${name}` }, null, 2),
      },
    ],
    isError: true,
  };
}

// ============================================================
// JSON-RPC 调度
// ============================================================

function writeMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function writeError(id, code, message) {
  writeMessage({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
}

async function dispatch(msg) {
  if (!msg || typeof msg !== 'object') return;

  // Notification (无 id): 不回响应
  if (typeof msg.id === 'undefined' || msg.id === null) {
    if (msg.method === 'notifications/initialized') {
      log('initialized notification received');
    }
    return;
  }

  const { id, method, params } = msg;

  try {
    let result;
    switch (method) {
      case 'initialize':
        result = handleInitialize();
        break;
      case 'tools/list':
        result = handleListTools();
        break;
      case 'tools/call':
        result = await handleCallTool(params?.name, params?.arguments);
        break;
      case 'ping':
        result = {};
        break;
      default:
        writeError(id, -32601, `method not found: ${method}`);
        return;
    }
    writeMessage({ jsonrpc: '2.0', id, result });
  } catch (e) {
    log('dispatch error: ' + e.stack);
    writeError(id, -32603, 'internal error: ' + e.message);
  }
}

// ============================================================
// stdio 循环 (line-delimited JSON)
// ============================================================

function log(msg) {
  process.stderr.write(`[${SERVER_NAME}] ${msg}\n`);
}

let buffer = '';
const pendingDispatches = new Set();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop(); // 最后一个可能不完整,留到下次
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      // 解析失败: 不发响应 (因为没有 id)
      log('JSON parse error: ' + e.message + ' | line: ' + trimmed.slice(0, 100));
      continue;
    }
    // dispatch 是 async (fit_svg 会 spawn Python), 跟踪 in-flight 防止 exit 漏响应
    const p = dispatch(msg).catch((e) => {
      log('unhandled dispatch error: ' + e.stack);
    });
    pendingDispatches.add(p);
    p.finally(() => pendingDispatches.delete(p));
  }
});

process.stdin.on('end', async () => {
  log(`stdin closed, waiting for ${pendingDispatches.size} pending dispatch(es)...`);
  await Promise.allSettled([...pendingDispatches]);
  log('all dispatches done, exit');
  process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

log(`server starting (${SERVER_NAME} v${SERVER_VERSION})`);
