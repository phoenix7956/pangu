/**
 * modules/media_sink.js
 * 盘古 · 多模态输出统一落盘漏斗 (2026-08-07)
 *
 * 铁律: base64 永远不进 agent 上下文 — 所有图片字节只经这一个函数落盘, 返回路径占位符。
 * 来源: chat 原生吐图 (extractParts) / 独立端点工具 (pangu-media MCP) 共用。
 *
 * 设计: 纯函数零依赖, 无副作用除了写文件。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// 输出根默认 = **仓库相对**的 output_files/images —— 不写死任何人的本机绝对路径。
//   env PANGU_OUTPUT_ROOT 仍可覆盖。
const OUTPUT_ROOT = process.env.PANGU_OUTPUT_ROOT
  || require('path').join(__dirname, '..', '..', 'output_files', 'images');

function _safeName(s) {
  return String(s || 'img').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'img';
}

/**
 * 把一组二进制 buffer 落盘 (通用形态, 图片/视频/音频通吃)。
 * @param {Array<{buffer: Buffer, ext?: string}>} items
 * @param {{outputDir?: string, prefix?: string}} [opts]
 * @returns {Array<string>} 落盘后的绝对路径 (顺序与输入一致; 写失败的项被跳过)
 */
function sinkBuffers(items, opts = {}) {
  const now = new Date(); // 本地日期 (与 ComfyUI_Output 分目录约定一致, 不用 UTC)
  const dateDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const outDir = opts.outputDir || path.join(OUTPUT_ROOT, dateDir);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = Date.now();
  const prefix = _safeName(opts.prefix);
  const files = [];
  let idx = 0;
  for (const item of items) {
    if (!item || !Buffer.isBuffer(item.buffer) || item.buffer.length === 0) continue;
    idx += 1;
    const ext = item.ext || '.bin';
    const p = path.join(outDir, `${prefix}_${stamp}_${idx}${ext}`);
    try {
      fs.writeFileSync(p, item.buffer);
      files.push(p);
    } catch (e) {
      console.warn('[media-sink] write failed:', p, e.message);
    }
  }
  return files;
}

/**
 * 把一组 base64 图片落盘 (sinkBuffers 的 base64 特化)。
 * @param {Array<{base64: string, mime?: string}>} items
 * @param {{outputDir?: string, prefix?: string}} [opts]
 * @returns {Array<string>}
 */
function sinkBase64Images(items, opts = {}) {
  return sinkBuffers(
    (items || [])
      .filter(it => it && typeof it.base64 === 'string' && it.base64)
      .map(it => ({
        buffer: Buffer.from(it.base64, 'base64'),
        ext: (it.mime || '').includes('png') ? '.png' : '.jpeg',
      })),
    opts
  );
}

/**
 * 从 URL 下载并落盘 (视频/音频端点常返回 URL 而非 base64)。
 * @param {string} url
 * @param {{outputDir?: string, prefix?: string, ext?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<string>} 落盘后的绝对路径
 */
function sinkFromUrl(url, opts = {}) {
  const ext = opts.ext || (path.extname(new URL(url).pathname) || '.bin');
  const timeoutMs = opts.timeoutMs || 300000;
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(sinkFromUrl(res.headers.location, opts));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('download HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const files = sinkBuffers([{ buffer: Buffer.concat(chunks), ext }], opts);
        if (files.length === 0) return reject(new Error('sink write failed'));
        resolve(files[0]);
      });
    });
    req.on('timeout', () => req.destroy(new Error('download timeout')));
    req.on('error', reject);
  });
}

/**
 * 生成给 LLM 看的路径占位文本。
 * @param {Array<string>} files
 * @returns {string}
 */
function mediaPlaceholder(files) {
  if (!files || files.length === 0) return '';
  return files.map(f => `[图片已存: ${f}]`).join('\n');
}

module.exports = { sinkBuffers, sinkBase64Images, sinkFromUrl, mediaPlaceholder, OUTPUT_ROOT };
