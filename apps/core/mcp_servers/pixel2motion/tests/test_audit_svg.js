#!/usr/bin/env node
/**
 * tests/test_audit_svg.js
 * audit_svg MCP Tool 测试
 *
 * 策略: 启 server.js 进程 → 走 MCP 协议 (initialize → tools/list → tools/call)
 *       覆盖各种 SVG 形态 / 复杂度阈值 / 平滑度 / 错误路径
 *
 * 用法:  node /Users/you/pangu/apps/core/mcp_servers/pixel2motion/tests/test_audit_svg.js
 * 退出码: 0 = 全过, 1 = 有失败
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SERVER_PATH = path.resolve(__dirname, '..', 'server.js');

// === 测试用 SVG 样本 ===
const SVG_CIRCLE = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40" fill="red"/></svg>';
const SVG_RECT = '<svg viewBox="0 0 200 200"><rect x="20" y="20" width="160" height="160" fill="blue" stroke="black"/></svg>';
const SVG_TRIANGLE = '<svg viewBox="0 0 100 100"><path d="M 10 10 L 50 50 L 90 10 Z"/></svg>';

// 10 段 path
const buildPath = (n) => {
  const points = Array.from({length: n + 1}, (_, i) => `${i * 10},${i % 2 === 0 ? 0 : 10}`).join(' L ');
  return '<svg><path d="M ' + points + '"/></svg>';
};
const SVG_10_SEG = buildPath(10);  // M + 10 L = 11 segments

// 5 段贝塞尔 (起手 M, 避免 SVG 隐式 M 歧义)
const SVG_5_BEZIER = '<svg><path d="M 0 0 ' + Array.from({length:5}, (_,i)=>
  `C ${i*10+10},${i*10+10} ${i*10+20},${i*10+5} ${i*10+30},${i*10+15}`
).join(' ') + '"/></svg>';

// 100 段 (超复杂度)
const SVG_100_SEG = buildPath(99);  // 100 segments

// 混合
const SVG_MIXED = '<svg viewBox="0 0 200 200">' +
  '<path d="M 0 0 L 100 0 L 100 100 L 0 100 Z"/>' +
  '<circle cx="50" cy="50" r="20"/>' +
  '<rect x="80" y="80" width="40" height="40"/>' +
  '<polygon points="10,10 30,10 20,30"/>' +
  '<line x1="0" y1="0" x2="200" y2="200"/>' +
  '</svg>';

// 尖角 (4 个 90° 角)
const SVG_SHARP = '<svg><path d="M0,0 L10,0 L10,10 L0,10 Z"/></svg>';

// 重复元素 (>= 4 个 rect)
const SVG_DUP = '<svg>' + Array.from({length: 5}, () => '<rect x="0" y="0" width="10" height="10"/>').join('') + '</svg>';

// 多 path
const SVG_MULTI_PATH = '<svg>' + Array.from({length: 6}, (_,i) =>
  `<path d="M ${i*10} 0 L ${i*10+5} 10 L ${i*10+10} 0"/>`
).join('') + '</svg>';

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
      this.proc.stderr.on('data', (d) => { /* swallow server logs */ });

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
        for (const [, p] of this._pending) p.reject(new Error(`server exited code=${code}`));
        this._pending.clear();
      });

      this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-audit', version: '0.1' },
      }).then(() => {
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
    return this.request('tools/call', { name, arguments: args });
  }

  stop() {
    if (this.proc) {
      try { this.proc.kill(); } catch (_) {}
      this.proc = null;
    }
  }
}

function parseTextContent(result) {
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
  log('audit_svg MCP Tool 测试');
  log('========================================');
  log('Server: ' + SERVER_PATH);

  assert(fs.existsSync(SERVER_PATH), 'server.js exists');

  const client = new MCPClient(SERVER_PATH);
  try {
    await client.start();
    log('  MCP handshake OK');

    // =========================================================
    // 1. tools/list - 验证 audit_svg 已注册
    // =========================================================
    log('--- Test 1: tools/list ---');
    const listRes = await client.request('tools/list', {});
    assert(listRes && Array.isArray(listRes.tools), 'tools/list returns tools array');
    assert(listRes.tools.length >= 2, 'at least 2 tools registered (audit_svg + animate_logo_svg)', 'got ' + (listRes.tools && listRes.tools.length));
    const auditTool = listRes.tools.find(t => t.name === 'audit_svg');
    assert(!!auditTool, 'audit_svg tool is registered');
    assert(auditTool && typeof auditTool.description === 'string' && auditTool.description.length > 0, 'audit_svg: has non-empty description');
    assert(auditTool && auditTool.inputSchema && auditTool.inputSchema.type === 'object', 'audit_svg: inputSchema.type === object');
    assert(auditTool && auditTool.inputSchema.required.includes('svg'), 'audit_svg: required field "svg"');
    assert(auditTool && auditTool.inputSchema.properties.svg.type === 'string', 'audit_svg: svg is string');
    assert(auditTool && auditTool.inputSchema.properties.max_complexity.type === 'number', 'audit_svg: max_complexity is number');
    assert(auditTool && auditTool.inputSchema.properties.max_complexity.default === 50, 'audit_svg: max_complexity default = 50');

    // 验证 animate_logo_svg 仍存在 (没被破坏)
    const animTool = listRes.tools.find(t => t.name === 'animate_logo_svg');
    assert(!!animTool, 'animate_logo_svg still registered (no regression)');

    // =========================================================
    // 2. 基础审计 - 简单 SVG
    // =========================================================
    log('--- Test 2: 简单 SVG (1 个 circle) ---');
    const r2 = await client.callTool('audit_svg', { svg: SVG_CIRCLE, max_complexity: 50 });
    assert(!r2.isError, 'circle: no isError');
    const p2 = parseJsonText(parseTextContent(r2));
    assert(p2 && p2.ok === true, 'circle: result.ok === true');
    assert(p2.total_paths === 0, 'circle: total_paths === 0 (无 path)', 'got ' + p2.total_paths);
    assert(p2.total_segments === 0, 'circle: total_segments === 0');
    assert(p2.total_beziers === 0, 'circle: total_beziers === 0');
    assert(p2.total_elements === 1, 'circle: total_elements === 1');
    assert(p2.passed === true, 'circle: passed === true');
    assert(p2.complexity_score === 0, 'circle: complexity_score === 0');
    assert(p2.smoothness_score === 1, 'circle: smoothness_score === 1 (no path)');
    assert(typeof p2.audit_time_ms === 'number' && p2.audit_time_ms >= 0, 'circle: audit_time_ms is valid');
    assert(Array.isArray(p2.issues), 'circle: issues is array');

    // =========================================================
    // 3. 10 段 path
    // =========================================================
    log('--- Test 3: 10 段 path ---');
    const r3 = await client.callTool('audit_svg', { svg: SVG_10_SEG, max_complexity: 50 });
    const p3 = parseJsonText(parseTextContent(r3));
    assert(p3 && p3.ok === true, '10-seg: ok');
    assert(p3.total_paths === 1, '10-seg: total_paths === 1', 'got ' + p3.total_paths);
    assert(p3.total_segments === 11, '10-seg: total_segments === 11 (M + 10 L)', 'got ' + p3.total_segments);
    assert(p3.total_beziers === 0, '10-seg: total_beziers === 0 (全是直线)');
    assert(p3.passed === true, '10-seg: passed === true (11 < 50)');
    assert(p3.complexity_score > 0 && p3.complexity_score < 0.5, '10-seg: complexity_score in (0, 0.5)', 'got ' + p3.complexity_score);

    // =========================================================
    // 4. 5 段贝塞尔
    // =========================================================
    log('--- Test 4: 5 段 C 命令 ---');
    const r4 = await client.callTool('audit_svg', { svg: SVG_5_BEZIER, max_complexity: 50 });
    const p4 = parseJsonText(parseTextContent(r4));
    assert(p4 && p4.ok === true, '5-bezier: ok');
    assert(p4.total_beziers === 5, '5-bezier: total_beziers === 5', 'got ' + p4.total_beziers);
    assert(p4.total_segments >= 5, '5-bezier: total_segments >= 5', 'got ' + p4.total_segments);
    assert(p4.issues.some(s => s.includes('贝塞尔')), '5-bezier: 触发贝塞尔过多 issue', 'issues=' + JSON.stringify(p4.issues));

    // =========================================================
    // 5. 混合 SVG
    // =========================================================
    log('--- Test 5: 混合 path + circle + rect + polygon + line ---');
    const r5 = await client.callTool('audit_svg', { svg: SVG_MIXED, max_complexity: 50 });
    const p5 = parseJsonText(parseTextContent(r5));
    assert(p5 && p5.ok === true, 'mixed: ok');
    assert(p5.total_paths === 1, 'mixed: total_paths === 1', 'got ' + p5.total_paths);
    assert(p5.total_elements === 5, 'mixed: total_elements === 5 (1 path + 1 circle + 1 rect + 1 polygon + 1 line)', 'got ' + p5.total_elements);
    assert(p5.shape_counts && p5.shape_counts.circle === 1, 'mixed: shape_counts.circle === 1');
    assert(p5.shape_counts.rect === 1, 'mixed: shape_counts.rect === 1');
    assert(p5.shape_counts.polygon === 1, 'mixed: shape_counts.polygon === 1');
    assert(p5.shape_counts.line === 1, 'mixed: shape_counts.line === 1');

    // =========================================================
    // 6. 超复杂度 → passed = false
    // =========================================================
    log('--- Test 6: 超复杂度 100 段 ---');
    const r6 = await client.callTool('audit_svg', { svg: SVG_100_SEG, max_complexity: 50 });
    const p6 = parseJsonText(parseTextContent(r6));
    assert(p6 && p6.ok === true, '100-seg: ok (still audits, just fails threshold)');
    assert(p6.total_segments === 100, '100-seg: total_segments === 100', 'got ' + p6.total_segments);
    assert(p6.passed === false, '100-seg: passed === false (100 >= 50)');
    assert(p6.issues.some(s => s.includes('路径段数过多')), '100-seg: 触发"路径段数过多" issue', 'issues=' + JSON.stringify(p6.issues));
    assert(p6.complexity_score > 0.9, '100-seg: complexity_score > 0.9 (saturated)', 'got ' + p6.complexity_score);

    // =========================================================
    // 7. max_complexity 边界
    // =========================================================
    log('--- Test 7: max_complexity 边界 ---');
    // 7a. 设为 100, 100 段应不通过 (100 < 100 为 false, 严格小于)
    const r7a = await client.callTool('audit_svg', { svg: SVG_100_SEG, max_complexity: 100 });
    const p7a = parseJsonText(parseTextContent(r7a));
    assert(p7a.passed === false, '7a: 100-seg with max=100 → passed=false (strict <)', 'got passed=' + p7a.passed);
    // 7b. 设为 101, 应通过 (100 < 101)
    const r7b = await client.callTool('audit_svg', { svg: SVG_100_SEG, max_complexity: 101 });
    const p7b = parseJsonText(parseTextContent(r7b));
    assert(p7b.passed === true, '7b: 100-seg with max=101 → passed', 'got ' + p7b.passed);
    // 7c. 默认 max_complexity (50)
    const r7c = await client.callTool('audit_svg', { svg: SVG_10_SEG });
    const p7c = parseJsonText(parseTextContent(r7c));
    assert(p7c && p7c.max_complexity === 50, '7c: default max_complexity === 50', 'got ' + p7c.max_complexity);
    assert(p7c.passed === true, '7c: 10-seg default → passed');

    // =========================================================
    // 8. 平滑度 - 尖角检测
    // =========================================================
    log('--- Test 8: 尖角检测 ---');
    const r8 = await client.callTool('audit_svg', { svg: SVG_SHARP, max_complexity: 50 });
    const p8 = parseJsonText(parseTextContent(r8));
    assert(p8.sharp_corners >= 2, 'sharp: 检测到 ≥ 2 尖角 (4 角正方形)', 'got ' + p8.sharp_corners);
    assert(p8.angle_samples >= 2, 'sharp: angle_samples ≥ 2', 'got ' + p8.angle_samples);
    assert(p8.smoothness_score < 1, 'sharp: smoothness_score < 1', 'got ' + p8.smoothness_score);
    assert(p8.issues.some(s => s.includes('尖角')), 'sharp: 触发"尖角" issue', 'issues=' + JSON.stringify(p8.issues));

    // =========================================================
    // 9. 重复元素检测
    // =========================================================
    log('--- Test 9: 重复元素 → 建议用 <use> ---');
    const r9 = await client.callTool('audit_svg', { svg: SVG_DUP, max_complexity: 50 });
    const p9 = parseJsonText(parseTextContent(r9));
    assert(p9.shape_counts.rect === 5, 'dup: shape_counts.rect === 5', 'got ' + p9.shape_counts.rect);
    assert(p9.issues.some(s => s.includes('重复')), 'dup: 触发"重复" issue', 'issues=' + JSON.stringify(p9.issues));

    // =========================================================
    // 10. 多 path
    // =========================================================
    log('--- Test 10: 多个 path 元素 ---');
    const r10 = await client.callTool('audit_svg', { svg: SVG_MULTI_PATH, max_complexity: 50 });
    const p10 = parseJsonText(parseTextContent(r10));
    assert(p10.total_paths === 6, 'multi-path: total_paths === 6', 'got ' + p10.total_paths);
    assert(p10.issues.some(s => s.includes('合并')), 'multi-path: 触发"合并 path" issue', 'issues=' + JSON.stringify(p10.issues));

    // =========================================================
    // 11. 无效输入 - 应返 ok:false
    // =========================================================
    log('--- Test 11: 无效输入 ---');
    // 11a. null args
    const r11a = await client.callTool('audit_svg', null);
    assert(r11a.isError === true, '11a: null args → isError');
    // 11b. 空对象
    const r11b = await client.callTool('audit_svg', {});
    assert(r11b.isError === true, '11b: {} → isError');
    // 11c. 空 svg 字符串
    const r11c = await client.callTool('audit_svg', { svg: '' });
    assert(r11c.isError === true, '11c: empty svg → isError');
    const p11c = parseJsonText(parseTextContent(r11c));
    assert(p11c && p11c.ok === false, '11c: payload.ok === false');
    // 11d. 非 SVG 字符串
    const r11d = await client.callTool('audit_svg', { svg: 'this is not an svg' });
    assert(r11d.isError === true, '11d: not-SVG string → isError');
    const p11d = parseJsonText(parseTextContent(r11d));
    assert(p11d.error.includes('svg'), '11d: error mentions "svg"');
    // 11e. svg 是数字
    const r11e = await client.callTool('audit_svg', { svg: 12345 });
    assert(r11e.isError === true, '11e: numeric svg → isError');
    // 11f. max_complexity = 0
    const r11f = await client.callTool('audit_svg', { svg: SVG_CIRCLE, max_complexity: 0 });
    assert(r11f.isError === true, '11f: max=0 → isError');
    // 11g. max_complexity = 10001
    const r11g = await client.callTool('audit_svg', { svg: SVG_CIRCLE, max_complexity: 10001 });
    assert(r11g.isError === true, '11g: max=10001 → isError');
    // 11h. max_complexity 是字符串
    const r11h = await client.callTool('audit_svg', { svg: SVG_CIRCLE, max_complexity: 'fifty' });
    assert(r11h.isError === true, '11h: max=string → isError');
    // 11i. max_complexity 是小数
    const r11i = await client.callTool('audit_svg', { svg: SVG_CIRCLE, max_complexity: 50.5 });
    assert(r11i.isError === true, '11i: max=50.5 (非整数) → isError');
    // 11j. svg 过大 (略超 2MB)
    const huge = '<svg>' + 'A'.repeat(2 * 1024 * 1024) + '</svg>';
    const r11j = await client.callTool('audit_svg', { svg: huge });
    assert(r11j.isError === true, '11j: 2MB+ svg → isError');

    // =========================================================
    // 12. 输出字段类型
    // =========================================================
    log('--- Test 12: 输出字段类型 ---');
    const r12 = await client.callTool('audit_svg', { svg: SVG_TRIANGLE, max_complexity: 20 });
    const p12 = parseJsonText(parseTextContent(r12));
    assert(typeof p12.ok === 'boolean', 'output: ok is boolean');
    assert(typeof p12.total_paths === 'number', 'output: total_paths is number');
    assert(typeof p12.total_segments === 'number', 'output: total_segments is number');
    assert(typeof p12.total_beziers === 'number', 'output: total_beziers is number');
    assert(typeof p12.complexity_score === 'number', 'output: complexity_score is number');
    assert(typeof p12.smoothness_score === 'number', 'output: smoothness_score is number');
    assert(typeof p12.passed === 'boolean', 'output: passed is boolean');
    assert(Array.isArray(p12.issues), 'output: issues is array');
    assert(typeof p12.audit_time_ms === 'number', 'output: audit_time_ms is number');
    assert(p12.complexity_score >= 0 && p12.complexity_score <= 1, 'output: complexity_score in [0,1]', 'got ' + p12.complexity_score);
    assert(p12.smoothness_score >= 0 && p12.smoothness_score <= 1, 'output: smoothness_score in [0,1]', 'got ' + p12.smoothness_score);

    // =========================================================
    // 13. 三角形 SVG - 全 3 段, 3 角
    // =========================================================
    log('--- Test 13: 三角形 (3 段, 3 角) ---');
    const r13 = await client.callTool('audit_svg', { svg: SVG_TRIANGLE, max_complexity: 20 });
    const p13 = parseJsonText(parseTextContent(r13));
    assert(p13.total_segments === 3, 'triangle: total_segments === 3 (M + 2L + Z → M+L+L)', 'got ' + p13.total_segments);
    // 注: Z 不计入 segments
    assert(p13.total_closepath >= 1, 'triangle: total_closepath >= 1', 'got ' + p13.total_closepath);
    assert(p13.sharp_corners >= 1, 'triangle: 至少 1 尖角', 'got ' + p13.sharp_corners);
    assert(p13.passed === true, 'triangle: passed === true (3 < 20)');

    // =========================================================
    // 14. 性能测试 - 1MB+ SVG < 1 秒
    // =========================================================
    log('--- Test 14: 性能测试 (1MB+ SVG) ---');
    const segs = Array.from({length: 50000}, (_, i) => 'L' + (i % 1000) + ',' + (i % 1000)).join(' ');
    const path = '<path d="' + segs + '"/>';
    let bigSvg = '<svg>';
    for (let i = 0; i < 3; i++) bigSvg += path;  // ~1.3MB
    bigSvg += '</svg>';
    log('  1MB+ SVG size: ' + (bigSvg.length / 1024 / 1024).toFixed(2) + ' MB');

    const perfStart = Date.now();
    const r14 = await client.callTool('audit_svg', { svg: bigSvg, max_complexity: 1000 });
    const perfElapsed = Date.now() - perfStart;
    const p14 = parseJsonText(parseTextContent(r14));
    assert(p14 && p14.ok === true, 'perf: ok');
    assert(perfElapsed < 1000, 'perf: < 1 秒审计 (wall ' + perfElapsed + 'ms)');
    assert(p14.audit_time_ms < 1000, 'perf: audit_time_ms < 1000ms (got ' + p14.audit_time_ms + 'ms)');
    assert(p14.total_paths === 3, 'perf: 3 paths', 'got ' + p14.total_paths);
    assert(p14.total_segments === 150000, 'perf: 150k segments', 'got ' + p14.total_segments);
    assert(p14.passed === false, 'perf: passed === false');

    // =========================================================
    // 15. 复杂多元素 SVG
    // =========================================================
    log('--- Test 15: 复杂多元素 SVG ---');
    const complexSvg = '<svg viewBox="0 0 100 100">' +
      Array.from({length: 3}, () => '<path d="M 0 0 L 50 0 L 50 50 L 0 50 Z"/>').join('') +
      Array.from({length: 3}, () => '<circle cx="50" cy="50" r="5"/>').join('') +
      Array.from({length: 3}, () => '<rect x="0" y="0" width="5" height="5"/>').join('') +
      Array.from({length: 3}, () => '<ellipse cx="50" cy="50" rx="5" ry="5"/>').join('') +
      '</svg>';
    const r15 = await client.callTool('audit_svg', { svg: complexSvg, max_complexity: 50 });
    const p15 = parseJsonText(parseTextContent(r15));
    assert(p15.total_paths === 3, 'complex: 3 paths', 'got ' + p15.total_paths);
    assert(p15.shape_counts.circle === 3, 'complex: 3 circles');
    assert(p15.shape_counts.rect === 3, 'complex: 3 rects');
    assert(p15.shape_counts.ellipse === 3, 'complex: 3 ellipses');
    assert(p15.issues.some(s => s.includes('重复')), 'complex: 重复元素 issue');

    // =========================================================
    // 16. 回归测试 - animate_logo_svg 不受影响
    // =========================================================
    log('--- Test 16: 回归 (animate_logo_svg) ---');
    const r16 = await client.callTool('animate_logo_svg', {
      svg: SVG_CIRCLE, motion_type: 'fade-in', duration_ms: 1000, easing: 'ease',
    });
    assert(!r16.isError, 'regression: animate_logo_svg still works');
    const p16 = parseJsonText(parseTextContent(r16));
    assert(p16 && p16.ok === true, 'regression: animate_logo_svg ok');
    assert(p16.html && p16.html.includes('<!DOCTYPE'), 'regression: animate_logo_svg html valid');

    // =========================================================
    // 17. ping 兼容
    // =========================================================
    log('--- Test 17: ping ---');
    const pingRes = await client.request('ping', {});
    assert(pingRes !== null && typeof pingRes === 'object', 'ping returns object');

    // =========================================================
    // 18. unknown tool
    // =========================================================
    log('--- Test 18: unknown tool ---');
    const r18 = await client.callTool('unknown_tool_xyz', { foo: 'bar' });
    assert(r18.isError === true, 'unknown tool → isError');
    const p18 = parseJsonText(parseTextContent(r18));
    assert(p18.error && p18.error.includes('unknown'), 'unknown tool: error message');

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
