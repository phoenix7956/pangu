#!/usr/bin/env node
/**
 * fit_svg.js — Node.js wrapper for fit_svg.py
 *
 * 用法 (作为 module):
 *   const fitSvg = require('./fit_svg');
 *   const result = await fitSvg({ image_path, max_size, detail_level });
 *
 * 用法 (CLI 自测):
 *   node fit_svg.js <input.png> [max_size] [detail_level]
 *
 * 协议:
 *   - spawn('python3', [fit_svg.py, '--json', image, max_size, detail])
 *   - 收 stdout 单行 JSON
 *   - 返 { ok, svg?, width?, height?, shapes_detected?, fit_quality?, render_time_ms?, error? }
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');

const HERE = __dirname;
const PYTHON = process.env.PYTHON || 'python3';
const FIT_SVG_PY = path.join(HERE, 'fit_svg.py');
const TIMEOUT_MS = 30_000;

const DETAIL_LEVELS = ['low', 'mid', 'high'];

/**
 * @param {object} args
 * @param {string} args.image_path
 * @param {number} [args.max_size=200]
 * @param {'low'|'mid'|'high'} [args.detail_level='mid']
 * @returns {Promise<object>}
 */
function fitSvg(args) {
  return new Promise((resolve) => {
    const start = Date.now();

    // 基本校验
    if (!args || typeof args !== 'object') {
      return resolve({ ok: false, error: 'args must be an object', render_time_ms: 0 });
    }
    if (typeof args.image_path !== 'string' || args.image_path.length === 0) {
      return resolve({ ok: false, error: 'image_path must be a non-empty string', render_time_ms: 0 });
    }
    const maxSize = (typeof args.max_size === 'number' && Number.isFinite(args.max_size)) ? Math.floor(args.max_size) : 200;
    if (maxSize < 16 || maxSize > 4096) {
      return resolve({ ok: false, error: `max_size must be in [16, 4096], got: ${maxSize}`, render_time_ms: 0 });
    }
    const detailLevel = (typeof args.detail_level === 'string') ? args.detail_level : 'mid';
    if (!DETAIL_LEVELS.includes(detailLevel)) {
      return resolve({ ok: false, error: `detail_level must be one of ${DETAIL_LEVELS.join('|')}, got: ${JSON.stringify(detailLevel)}`, render_time_ms: 0 });
    }

    const pyArgs = [FIT_SVG_PY, '--json', args.image_path, String(maxSize), detailLevel];
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
      // python 已经 ok:true/false, 直接转发
      if (typeof parsed !== 'object' || parsed === null) {
        return resolve({ ok: false, error: 'python returned non-object JSON', render_time_ms: Date.now() - start });
      }
      // 不覆盖 render_time_ms (python 已经给了)
      resolve(parsed);
    });
  });
}

// CLI 自测模式
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    process.stderr.write('usage: fit_svg.js <input.png> [max_size] [detail_level]\n');
    process.exit(1);
  }
  const opts = {
    image_path: args[0],
    max_size: args[1] ? parseInt(args[1], 10) : 200,
    detail_level: args[2] || 'mid',
  };
  fitSvg(opts).then((r) => {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exit(r.ok ? 0 : 1);
  });
}

module.exports = { fitSvg, DETAIL_LEVELS };
