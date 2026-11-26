#!/usr/bin/env node
/**
 * capture_frames.js — Node.js wrapper for capture_frames.py
 *
 * 战略定位: Pixel2Motion 5 步流程第 4 步 (QA 截帧)
 *
 * 用法 (作为 module):
 *   const { captureFrames, CAPTURE_FRAMES_TOOL_SCHEMA } = require('./capture_frames');
 *   const result = await captureFrames({ html, times_ms, output_dir, width, height });
 *
 * 用法 (CLI 自测):
 *   node capture_frames.js --cli '<html>' '<times_json>' '<output_dir>' [width] [height]
 *
 * 协议:
 *   - spawn('python3', [capture_frames.py, '--json', html, times_json, output_dir, width, height])
 *   - 收 stdout 单行 JSON
 *   - 返 { ok, frame_paths?, strip_path?, capture_time_ms?, total_frames?, error? }
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');

const HERE = __dirname;
const PYTHON = process.env.PYTHON || 'python3';
const CAPTURE_FRAMES_PY = path.join(HERE, 'capture_frames.py');
const TIMEOUT_MS = 60_000;  // 截帧可能慢 (Playwright 启动 + 渲染)

// ============================================================
// 常量 (用于 inputSchema)
// ============================================================

const MIN_WIDTH = 16;
const MAX_WIDTH = 4096;
const MIN_HEIGHT = 16;
const MAX_HEIGHT = 4096;
const MAX_FRAMES = 20;
const MAX_HTML_SIZE = 5 * 1024 * 1024;
const MAX_TIME_MS = 30000;

// ============================================================
// MCP Tool Schema (在 server.js TOOLS 数组中复用)
// ============================================================

const CAPTURE_FRAMES_TOOL_SCHEMA = {
  name: 'capture_frames',
  description: 'HTML (含 SVG + CSS 动画) → 截帧 PNG + motion strip 拼接图。Playwright headless chromium 渲染, 在指定时间点截屏。Pixel2Motion 5 步流程第 4 步 (QA 验证)。',
  inputSchema: {
    type: 'object',
    properties: {
      html: {
        type: 'string',
        description: `HTML 字符串 (含 <svg> + CSS @keyframes), 必填, 最大 ${MAX_HTML_SIZE} 字节`,
      },
      times_ms: {
        type: 'array',
        items: { type: 'number', minimum: 0, maximum: MAX_TIME_MS },
        minItems: 1,
        maxItems: MAX_FRAMES,
        description: `截帧时间点 (毫秒, 相对动画起始), 列表长度 [1, ${MAX_FRAMES}], 每个值 [0, ${MAX_TIME_MS}]`,
      },
      output_dir: {
        type: 'string',
        description: '输出目录 (绝对路径, 不存在会自动创建)',
      },
      width: {
        type: 'number',
        minimum: MIN_WIDTH,
        maximum: MAX_WIDTH,
        default: 800,
        description: `视窗宽度 (像素), 默认 800, 范围 [${MIN_WIDTH}, ${MAX_WIDTH}]`,
      },
      height: {
        type: 'number',
        minimum: MIN_HEIGHT,
        maximum: MAX_HEIGHT,
        default: 600,
        description: `视窗高度 (像素), 默认 600, 范围 [${MIN_HEIGHT}, ${MAX_HEIGHT}]`,
      },
    },
    required: ['html', 'times_ms', 'output_dir'],
  },
};

// ============================================================
// 校验
// ============================================================

function validateArgs(args) {
  if (!args || typeof args !== 'object') {
    return { ok: false, error: 'args must be an object' };
  }

  if (typeof args.html !== 'string' || args.html.length === 0) {
    return { ok: false, error: 'html must be a non-empty string' };
  }
  if (args.html.length > MAX_HTML_SIZE) {
    return { ok: false, error: `html too large (>${MAX_HTML_SIZE} bytes)` };
  }

  if (!Array.isArray(args.times_ms) || args.times_ms.length === 0) {
    return { ok: false, error: 'times_ms must be a non-empty array' };
  }
  if (args.times_ms.length > MAX_FRAMES) {
    return { ok: false, error: `times_ms has too many items (${args.times_ms.length} > ${MAX_FRAMES})` };
  }
  for (let i = 0; i < args.times_ms.length; i++) {
    const t = args.times_ms[i];
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      return { ok: false, error: `times_ms[${i}] must be a finite number, got: ${JSON.stringify(t)}` };
    }
    if (t < 0 || t > MAX_TIME_MS) {
      return { ok: false, error: `times_ms[${i}]=${t} out of range [0, ${MAX_TIME_MS}]` };
    }
  }

  if (typeof args.output_dir !== 'string' || args.output_dir.length === 0) {
    return { ok: false, error: 'output_dir must be a non-empty string' };
  }

  const width = (typeof args.width === 'number' && Number.isFinite(args.width)) ? args.width : 800;
  if (width < MIN_WIDTH || width > MAX_WIDTH) {
    return { ok: false, error: `width must be in [${MIN_WIDTH}, ${MAX_WIDTH}], got: ${width}` };
  }
  const height = (typeof args.height === 'number' && Number.isFinite(args.height)) ? args.height : 600;
  if (height < MIN_HEIGHT || height > MAX_HEIGHT) {
    return { ok: false, error: `height must be in [${MIN_HEIGHT}, ${MAX_HEIGHT}], got: ${height}` };
  }

  return {
    ok: true,
    value: {
      html: args.html,
      times_ms: args.times_ms,
      output_dir: args.output_dir,
      width,
      height,
    },
  };
}

// ============================================================
// 主入口: captureFrames(args) → Promise<result>
// ============================================================

function captureFrames(args) {
  return new Promise((resolve) => {
    const start = Date.now();

    // 1. 校验
    const v = validateArgs(args);
    if (!v.ok) {
      return resolve({ ok: false, error: v.error, render_time_ms: 0 });
    }
    const { html, times_ms, output_dir, width, height } = v.value;

    // 2. spawn Python
    const timesJson = JSON.stringify(times_ms);
    const pyArgs = [
      CAPTURE_FRAMES_PY,
      '--json',
      html,
      timesJson,
      output_dir,
      String(width),
      String(height),
    ];

    let child;
    try {
      child = spawn(PYTHON, pyArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, error: `failed to spawn ${PYTHON}: ${e.message}`, render_time_ms: Date.now() - start });
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch (_) { /* noop */ }
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf8'); });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `python spawn error: ${err.message}`, render_time_ms: Date.now() - start });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killed) {
        return resolve({ ok: false, error: `python timeout after ${TIMEOUT_MS}ms`, render_time_ms: Date.now() - start });
      }
      const trimmed = stdoutBuf.trim();
      if (!trimmed) {
        return resolve({
          ok: false,
          error: `python exited with code ${code}, no stdout. stderr: ${stderrBuf.slice(0, 500)}`,
          render_time_ms: Date.now() - start,
        });
      }
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        return resolve({
          ok: false,
          error: `failed to parse python JSON output: ${e.message}. raw: ${trimmed.slice(0, 500)}`,
          render_time_ms: Date.now() - start,
        });
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return resolve({ ok: false, error: 'python returned non-object JSON', render_time_ms: Date.now() - start });
      }
      // python 已有 capture_time_ms, 不覆盖
      // 但确保有 render_time_ms 字段 (兼容 server.js 调用约定)
      if (typeof parsed.render_time_ms !== 'number') {
        parsed.render_time_ms = Date.now() - start;
      }
      resolve(parsed);
    });
  });
}

// ============================================================
// CLI 自测模式
// ============================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--cli') {
    const html = args[1] || '';
    const timesJson = args[2] || '[]';
    const outputDir = args[3] || '/tmp/capture_cli';
    const width = parseInt(args[4] || '800', 10);
    const height = parseInt(args[5] || '600', 10);
    let timesMs;
    try { timesMs = JSON.parse(timesJson); } catch (e) {
      process.stderr.write(`failed to parse timesJson: ${e.message}\n`);
      process.exit(1);
    }
    captureFrames({ html, times_ms: timesMs, output_dir: outputDir, width, height }).then((r) => {
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      process.exit(r.ok ? 0 : 1);
    });
  } else {
    process.stderr.write('usage: node capture_frames.js --cli <html> <times_json> <output_dir> [width] [height]\n');
    process.exit(1);
  }
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  captureFrames,
  validateArgs,
  CAPTURE_FRAMES_TOOL_SCHEMA,
};
