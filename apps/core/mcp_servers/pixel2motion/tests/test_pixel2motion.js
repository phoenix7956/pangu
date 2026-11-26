#!/usr/bin/env node
/**
 * tests/test_pixel2motion.js
 * 简化版 Pixel2Motion MCP server 测试
 *
 * 策略: 启 server.js 进程 → 走 MCP 协议 (initialize → tools/list → tools/call)
 *       覆盖 5 种 motion_type × 5 种 easing × 4 个 duration + 错误路径
 *
 * 用法:  node /Users/you/pangu/apps/core/mcp_servers/pixel2motion/tests/test_pixel2motion.js
 * 退出码: 0 = 全过, 1 = 有失败
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const SERVER_PATH = path.resolve(__dirname, '..', 'server.js');
const SAMPLE_SVG = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40" fill="red"/></svg>';
const SAMPLE_SVG_LARGE = '<svg viewBox="0 0 200 200"><rect x="20" y="20" width="160" height="160" fill="blue" stroke="black"/></svg>';

let passed = 0;
let failed = 0;
const results = [];

function log(msg) {
  console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + msg);
}

function assert(cond, label, detail) {
  if (cond) {
    passed++;
    results.push({ ok: true, label });
    log('  ✅ ' + label);
  } else {
    failed++;
    results.push({ ok: false, label, detail });
    log('  ❌ ' + label + (detail ? ' — ' + detail : ''));
  }
}

// ============================================================
// MCP 客户端 (in-process)
// ============================================================

class MCPClient {
  constructor(serverPath) {
    this.serverPath = serverPath;
    this.proc = null;
    this._reqId = 0;
    this._pending = new Map();
    this._buffer = '';
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn('node', [this.serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc.stderr.on('data', (d) => { /* swallow server logs in tests */ });

      const rl = readline.createInterface({ input: this.proc.stdout });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { return; }
        if (msg.id != null && this._pending.has(msg.id)) {
          const { resolve, reject } = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      });

      this.proc.on('error', reject);
      this.proc.on('exit', (code) => {
        // 拒绝所有 pending
        for (const [, p] of this._pending) p.reject(new Error(`server exited code=${code}`));
        this._pending.clear();
      });

      // 启动即发 initialize
      this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.1' },
      }).then(() => {
        // 通知 server 我们就绪
        this.notify('notifications/initialized', {});
        resolve();
      }).catch(reject);
    });
  }

  request(method, params) {
    const id = ++this._reqId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`request ${method} timeout (10s)`));
        }
      }, 10000);
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async callTool(name, args) {
    const r = await this.request('tools/call', { name, arguments: args });
    return r;
  }

  stop() {
    if (this.proc) {
      try { this.proc.kill(); } catch (_) {}
      this.proc = null;
    }
  }
}

// ============================================================
// 工具函数
// ============================================================

function parseTextContent(result) {
  // MCP tools/call result: { content: [{type:'text', text:'...'}], isError?: bool }
  if (!result || !Array.isArray(result.content) || result.content.length === 0) return null;
  return result.content[0].text;
}

function parseJsonText(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

// ============================================================
// 主测试
// ============================================================

async function main() {
  log('========================================');
  log('Pixel2Motion MCP Server 测试');
  log('========================================');
  log('Server: ' + SERVER_PATH);

  // 0. 文件存在
  assert(fs.existsSync(SERVER_PATH), 'server.js exists');

  const client = new MCPClient(SERVER_PATH);
  try {
    await client.start();
    log('  MCP handshake OK');

    // ===== 1. tools/list =====
    log('--- Test 1: tools/list ---');
    const listRes = await client.request('tools/list', {});
    assert(listRes && Array.isArray(listRes.tools), 'tools/list returns tools array');
    assert(listRes.tools.length === 1, 'exactly 1 tool registered', 'got ' + (listRes.tools && listRes.tools.length));
    const tool = listRes.tools[0];
    assert(tool && tool.name === 'animate_logo_svg', 'tool name === animate_logo_svg');
    assert(tool && typeof tool.description === 'string' && tool.description.length > 0, 'tool has non-empty description');
    assert(tool && tool.inputSchema && tool.inputSchema.type === 'object', 'inputSchema.type === object');
    assert(tool && tool.inputSchema.required.includes('svg'), 'required field: svg');
    assert(tool && tool.inputSchema.required.includes('motion_type'), 'required field: motion_type');
    assert(tool && tool.inputSchema.required.includes('duration_ms'), 'required field: duration_ms');
    assert(tool && tool.inputSchema.required.includes('easing'), 'required field: easing');
    assert(tool && tool.inputSchema.properties.motion_type.enum.length === 5, 'motion_type enum has 5 values');
    assert(tool && tool.inputSchema.properties.easing.enum.length === 5, 'easing enum has 5 values');

    // ===== 2. 5 种 motion_type =====
    log('--- Test 2: 5 种 motion_type 都能生成有效 HTML ---');
    const motionTypes = ['fade-in', 'scale-up', 'rotate', 'draw-on', 'bounce'];
    for (const mt of motionTypes) {
      const r = await client.callTool('animate_logo_svg', {
        svg: SAMPLE_SVG, motion_type: mt, duration_ms: 1000, easing: 'ease',
      });
      assert(!r.isError, `${mt}: no isError`, JSON.stringify(r).slice(0, 200));
      const payload = parseJsonText(parseTextContent(r));
      assert(payload && payload.ok === true, `${mt}: result.ok === true`);
      assert(typeof payload.html === 'string' && payload.html.length > 0, `${mt}: html non-empty`);
      assert(payload.html.includes('<!DOCTYPE html>'), `${mt}: html has DOCTYPE`);
      assert(payload.html.includes('<svg'), `${mt}: html contains <svg>`);
      assert(payload.html.includes('<style>'), `${mt}: html contains <style>`);
      assert(payload.html.includes('@keyframes'), `${mt}: html contains @keyframes`);
      assert(payload.html.includes(`p2m-${mt}-ease`), `${mt}: html contains correct keyframe name`);
      assert(typeof payload.css_keyframes === 'string', `${mt}: css_keyframes is string`);
      assert(payload.css_keyframes === `p2m-${mt}-ease`, `${mt}: css_keyframes value correct`);
      assert(payload.svg_size === SAMPLE_SVG.length, `${mt}: svg_size correct (${SAMPLE_SVG.length})`);
      assert(typeof payload.render_time_ms === 'number' && payload.render_time_ms >= 0, `${mt}: render_time_ms valid`);
    }

    // ===== 3. 5 种 easing 都能正确注入 CSS =====
    log('--- Test 3: 5 种 easing 都能正确注入 CSS ---');
    const easings = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'];
    for (const e of easings) {
      const r = await client.callTool('animate_logo_svg', {
        svg: SAMPLE_SVG, motion_type: 'scale-up', duration_ms: 1000, easing: e,
      });
      const payload = parseJsonText(parseTextContent(r));
      assert(payload && payload.ok === true, `easing=${e}: ok`);
      assert(payload.html.includes(`p2m-scale-up-${e}`), `easing=${e}: keyframe name in HTML`);
      assert(payload.html.includes(` ${e} `) || payload.html.includes(` ${e};`), `easing=${e}: easing value in animation property`);
      assert(payload.css_keyframes === `p2m-scale-up-${e}`, `easing=${e}: css_keyframes value`);
    }

    // ===== 4. duration_ms 边界值 (500/1000/3000/5000) =====
    log('--- Test 4: duration_ms 边界值 ---');
    const durations = [500, 1000, 3000, 5000];
    for (const d of durations) {
      const r = await client.callTool('animate_logo_svg', {
        svg: SAMPLE_SVG, motion_type: 'fade-in', duration_ms: d, easing: 'ease-in',
      });
      const payload = parseJsonText(parseTextContent(r));
      assert(payload && payload.ok === true, `duration=${d}: ok`);
      assert(payload.html.includes(`${d}ms`), `duration=${d}: ms value in animation`);
    }

    // ===== 5. HTML 结构完整 =====
    log('--- Test 5: HTML 结构完整 ---');
    const r5 = await client.callTool('animate_logo_svg', {
      svg: SAMPLE_SVG_LARGE, motion_type: 'bounce', duration_ms: 2000, easing: 'ease-in-out',
    });
    const p5 = parseJsonText(parseTextContent(r5));
    assert(p5.html.startsWith('<!DOCTYPE html>'), 'html starts with DOCTYPE');
    assert(p5.html.includes('<html lang="en">'), 'html has <html> tag');
    assert(p5.html.includes('<head>'), 'html has <head>');
    assert(p5.html.includes('</head>'), 'html has </head>');
    assert(p5.html.includes('<body>'), 'html has <body>');
    assert(p5.html.includes('</body>'), 'html has </body>');
    assert(p5.html.includes('</html>'), 'html has </html>');
    assert(p5.html.includes('<meta charset="UTF-8">'), 'html has UTF-8 meta');
    assert(p5.html.includes('@keyframes p2m-bounce-ease-in-out'), 'html has bounce keyframes');
    assert(p5.html.includes('translateY(-30px)'), 'bounce uses translateY(-30px)');
    assert(p5.html.includes(SAMPLE_SVG_LARGE), 'html embeds original SVG');
    assert(p5.html.includes('.p2m-wrap'), 'html has .p2m-wrap class');

    // ===== 6. 输出 HTML 中包含 CSS keyframe 名 (svg-with-css 模式) =====
    log('--- Test 6: output_format=svg-with-css ---');
    const r6 = await client.callTool('animate_logo_svg', {
      svg: SAMPLE_SVG, motion_type: 'rotate', duration_ms: 1500, easing: 'ease-out',
      output_format: 'svg-with-css',
    });
    const p6 = parseJsonText(parseTextContent(r6));
    assert(p6 && p6.ok === true, 'svg-with-css: ok');
    assert(!p6.html.includes('<!DOCTYPE'), 'svg-with-css: no DOCTYPE (raw fragment)');
    assert(p6.html.includes('<style>'), 'svg-with-css: has <style>');
    assert(p6.html.includes('@keyframes p2m-rotate-ease-out'), 'svg-with-css: correct keyframe name');
    assert(p6.html.includes('rotate(-180deg)'), 'svg-with-css: rotate starts at -180deg');
    assert(p6.html.includes('rotate(0deg)'), 'svg-with-css: rotate ends at 0deg');
    assert(p6.html.includes(SAMPLE_SVG), 'svg-with-css: embeds SVG');

    // ===== 7. 输入校验失败 → 返 ok:false =====
    log('--- Test 7: 输入校验失败 ---');
    // 7a. motion_type 错
    const rErr1 = await client.callTool('animate_logo_svg', {
      svg: SAMPLE_SVG, motion_type: 'invalid-type', duration_ms: 1000, easing: 'ease',
    });
    assert(rErr1.isError === true, 'invalid motion_type → isError=true');
    const pErr1 = parseJsonText(parseTextContent(rErr1));
    assert(pErr1 && pErr1.ok === false, 'invalid motion_type → payload.ok=false');
    assert(typeof pErr1.error === 'string' && pErr1.error.includes('motion_type'), 'invalid motion_type: error message contains "motion_type"');

    // 7b. duration 太短
    const rErr2 = await client.callTool('animate_logo_svg', {
      svg: SAMPLE_SVG, motion_type: 'fade-in', duration_ms: 100, easing: 'ease',
    });
    assert(rErr2.isError === true, 'duration_ms=100 → isError=true');
    const pErr2 = parseJsonText(parseTextContent(rErr2));
    assert(pErr2.error && pErr2.error.includes('duration_ms'), 'duration error mentions duration_ms');

    // 7c. duration 太长
    const rErr3 = await client.callTool('animate_logo_svg', {
      svg: SAMPLE_SVG, motion_type: 'fade-in', duration_ms: 10000, easing: 'ease',
    });
    assert(rErr3.isError === true, 'duration_ms=10000 → isError=true');

    // 7d. easing 错
    const rErr4 = await client.callTool('animate_logo_svg', {
      svg: SAMPLE_SVG, motion_type: 'fade-in', duration_ms: 1000, easing: 'bouncy',
    });
    assert(rErr4.isError === true, 'invalid easing → isError=true');
    const pErr4 = parseJsonText(parseTextContent(rErr4));
    assert(pErr4.error && pErr4.error.includes('easing'), 'easing error mentions "easing"');

    // 7e. svg 缺失
    const rErr5 = await client.callTool('animate_logo_svg', {
      motion_type: 'fade-in', duration_ms: 1000, easing: 'ease',
    });
    assert(rErr5.isError === true, 'missing svg → isError=true');

    // 7f. svg 是空字符串
    const rErr6 = await client.callTool('animate_logo_svg', {
      svg: '', motion_type: 'fade-in', duration_ms: 1000, easing: 'ease',
    });
    assert(rErr6.isError === true, 'empty svg → isError=true');

    // 7g. svg 没有 <svg
    const rErr7 = await client.callTool('animate_logo_svg', {
      svg: 'not an svg at all', motion_type: 'fade-in', duration_ms: 1000, easing: 'ease',
    });
    assert(rErr7.isError === true, 'non-SVG string → isError=true');

    // ===== 8. SVG 字符数正确传递 =====
    log('--- Test 8: SVG 字符数传递 ---');
    const testSvg = '<svg viewBox="0 0 50 50"><rect x="0" y="0" width="50" height="50"/></svg>';
    const r8 = await client.callTool('animate_logo_svg', {
      svg: testSvg, motion_type: 'scale-up', duration_ms: 1000, easing: 'ease',
    });
    const p8 = parseJsonText(parseTextContent(r8));
    assert(p8.svg_size === testSvg.length, `svg_size === ${testSvg.length} (got ${p8.svg_size})`);

    // ===== 9. unknown tool =====
    log('--- Test 9: unknown tool ---');
    const r9 = await client.callTool('unknown_tool_xyz', { foo: 'bar' });
    assert(r9.isError === true, 'unknown tool → isError=true');
    const p9 = parseJsonText(parseTextContent(r9));
    assert(p9.error && p9.error.includes('unknown'), 'unknown tool: error message');

    // ===== 10. initialize ping 兼容 =====
    log('--- Test 10: ping ---');
    const pingRes = await client.request('ping', {});
    assert(pingRes !== null && typeof pingRes === 'object', 'ping returns object');

  } catch (e) {
    log('💥 测试异常: ' + e.message);
    log(e.stack);
    failed++;
  } finally {
    client.stop();
  }

  // ============================================================
  // 报告
  // ============================================================
  log('========================================');
  log(`结果: ${passed} passed, ${failed} failed (总 ${results.length})`);
  log('========================================');

  if (failed > 0) {
    log('失败项:');
    results.filter(r => !r.ok).forEach(r => {
      log('  ❌ ' + r.label + (r.detail ? ' — ' + r.detail : ''));
    });
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => {
  console.error('💥 main error:', e);
  process.exit(1);
});
