#!/usr/bin/env node
/**
 * test_fit_svg.js — fit_svg MCP 工具测试 (≥30 项断言)
 *
 * 测 3 层:
 *  1. Node.js 单元测试 (tools/fit_svg.js): spawn Python + JSON 解析 + 错误处理
 *  2. MCP 协议测试: 通过 stdio 启动 server.js, 发 JSON-RPC, 验 fit_svg 工具
 *  3. 端到端: 重启 Pangu + curl /api/mcp/call
 *
 * 用法:
 *   node tests/test_fit_svg.js          # 跑全部 (含 E2E)
 *   node tests/test_fit_svg.js --no-e2e # 跳过 E2E
 *   node tests/test_fit_svg.js --e2e    # 只跑 E2E
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..');
const TOOLS_DIR = path.join(ROOT, 'tools');
const FIT_SVG_PY = path.join(TOOLS_DIR, 'fit_svg.py');
const FIT_SVG_JS = path.join(TOOLS_DIR, 'fit_svg.js');
const SERVER_JS = path.join(ROOT, 'server.js');
const FIXTURE = path.join(HERE, 'fixtures', 'test_logo.png');
const SHAPES_FIXTURE = path.join(HERE, 'fixtures', 'test_shapes.png');
const PANGU_URL = 'http://127.0.0.1:18901';

const ARGS = process.argv.slice(2);
const ONLY_E2E = ARGS.includes('--e2e');
const SKIP_E2E = ARGS.includes('--no-e2e');

// ============================================================
// 测试框架 (迷你)
// ============================================================

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passed++;
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    failed++;
    failures.push(msg);
    process.stdout.write(`  ✗ ${msg}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n━━ ${title} ━━\n`);
}

// ============================================================
// Helpers
// ============================================================

function requireModule(modPath) {
  return require(modPath);
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function runPythonCli(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [FIT_SVG_PY, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`python CLI timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

function runStdioServer(messages, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER_JS], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let stdoutBuf = '';
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`stdio server timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdoutBuf += d.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const line of lines) {
        if (line.trim()) out += line + '\n';
      }
    });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
    // Send messages
    for (const msg of messages) {
      child.stdin.write(JSON.stringify(msg) + '\n');
    }
    child.stdin.end();
  });
}

function httpPost(urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ============================================================
// 测试套件
// ============================================================

async function testFileExistence() {
  section('0. 文件存在性');
  assert(fileExists(FIT_SVG_PY), 'tools/fit_svg.py 存在');
  assert(fileExists(FIT_SVG_JS), 'tools/fit_svg.js 存在');
  assert(fileExists(SERVER_JS), 'server.js 存在');
  assert(fileExists(FIXTURE), 'fixtures/test_logo.png 存在');
  assert(fileExists(SHAPES_FIXTURE), 'fixtures/test_shapes.png 存在');
}

async function testPythonCli() {
  section('1. Python CLI 直测');
  const r1 = await runPythonCli([FIXTURE, '100', 'mid', '--json']);
  assert(r1.code === 0, `CLI exit code 0 (got ${r1.code})`);
  let j1;
  try { j1 = JSON.parse(r1.out.trim()); } catch (e) { j1 = null; }
  assert(j1 !== null, 'CLI 输出可解析为 JSON');
  assert(j1 && j1.ok === true, 'CLI 返 ok:true');
  assert(j1 && typeof j1.svg === 'string', 'CLI 返 svg 字符串');
  assert(j1 && j1.svg.includes('<svg'), 'svg 含 <svg 标签');
  assert(j1 && j1.svg.includes('</svg>'), 'svg 含 </svg> 闭合');
  assert(j1 && j1.width === 100, `width=100 (got ${j1 && j1.width})`);
  assert(j1 && j1.height === 100, `height=100 (got ${j1 && j1.height})`);
  assert(j1 && j1.shapes_detected >= 2, `shapes_detected >= 2 (got ${j1 && j1.shapes_detected})`);
  assert(j1 && j1.svg.includes('<rect') || j1.svg.includes('<circle') || j1.svg.includes('<polygon'), 'svg 含 <rect>/<circle>/<polygon>');
}

async function testPythonCliLow() {
  const r = await runPythonCli([FIXTURE, '50', 'low', '--json']);
  const j = JSON.parse(r.out.trim());
  assert(j.ok === true, 'CLI detail_level=low 返 ok:true');
  assert(j.shapes_detected >= 1, 'low 至少检测到 1 形状');
}

async function testPythonCliHigh() {
  const r = await runPythonCli([FIXTURE, '150', 'high', '--json']);
  const j = JSON.parse(r.out.trim());
  assert(j.ok === true, 'CLI detail_level=high 返 ok:true');
  assert(j.shapes_detected >= 1, 'high 至少检测到 1 形状');
}

async function testPythonCliErrors() {
  section('2. Python CLI 错误处理');
  const r1 = await runPythonCli(['/tmp/does_not_exist_xyz.png', '100', 'mid', '--json']);
  assert(r1.code === 1, 'CLI 不存在文件 → exit 1');
  let j1;
  try { j1 = JSON.parse(r1.out.trim()); } catch (e) { j1 = null; }
  assert(j1 && j1.ok === false, 'CLI 不存在文件 → ok:false');
  assert(j1 && /image not found/.test(j1.error || ''), '错误信息含 "image not found"');

  const r2 = await runPythonCli([FIXTURE, '100', 'invalid', '--json']);
  assert(r2.code === 1, 'CLI 非法 detail_level → exit 1');
  let j2;
  try { j2 = JSON.parse(r2.out.trim()); } catch (e) { j2 = null; }
  assert(j2 && j2.ok === false, 'CLI 非法 detail_level → ok:false');
  assert(j2 && /detail_level/.test(j2.error || ''), '错误信息含 "detail_level"');
}

async function testNodeWrapper() {
  section('3. Node.js 包装 (tools/fit_svg.js)');
  const { fitSvg, DETAIL_LEVELS } = requireModule(FIT_SVG_JS);
  assert(typeof fitSvg === 'function', 'fitSvg 是函数');
  assert(Array.isArray(DETAIL_LEVELS), 'DETAIL_LEVELS 是数组');
  assert(DETAIL_LEVELS.includes('low') && DETAIL_LEVELS.includes('mid') && DETAIL_LEVELS.includes('high'), 'DETAIL_LEVELS 含 low/mid/high');

  const r1 = await fitSvg({ image_path: FIXTURE, max_size: 100, detail_level: 'mid' });
  assert(r1.ok === true, 'fitSvg() 返 ok:true');
  assert(typeof r1.svg === 'string', 'fitSvg() 返 svg 字符串');
  assert(r1.shapes_detected >= 2, `shapes_detected >= 2 (got ${r1.shapes_detected})`);
  assert(r1.width === 100, 'fitSvg() width=100');
  assert(r1.height === 100, 'fitSvg() height=100');
  assert(r1.svg.includes('<circle') || r1.svg.includes('<rect'), 'fitSvg() SVG 含 <circle>/<rect>');
  assert(typeof r1.fit_quality === 'number' && r1.fit_quality >= 0 && r1.fit_quality <= 1, 'fit_quality ∈ [0,1]');
  assert(typeof r1.render_time_ms === 'number', 'render_time_ms 是数字');

  const r2 = await fitSvg({ image_path: '/tmp/nope.png' });
  assert(r2.ok === false, '不存在文件 → ok:false');
  assert(/not found|ENOENT/.test(r2.error || ''), '不存在文件错误信息');

  const r3 = await fitSvg({});
  assert(r3.ok === false, '空参数 → ok:false');
  assert(/image_path/.test(r3.error || ''), '空参数错误信息含 image_path');

  const r4 = await fitSvg({ image_path: FIXTURE, max_size: 'large' });
  // 字符串 'large' 不应是合法 number → 用默认值
  assert(r4.ok === true, 'max_size=非数字 → 用默认值 200');

  const r5 = await fitSvg({ image_path: FIXTURE, detail_level: 'wrong' });
  assert(r5.ok === false, '非法 detail_level → ok:false');
  assert(/detail_level/.test(r5.error || ''), '非法 detail_level 错误信息');
}

async function testThreeShapes() {
  section('4. 3 种形状识别');
  const { fitSvg } = requireModule(FIT_SVG_JS);
  const r = await fitSvg({ image_path: SHAPES_FIXTURE, max_size: 200, detail_level: 'mid' });
  assert(r.ok === true, '3 形状图 ok:true');
  assert(r.shapes_detected >= 3, `shapes_detected >= 3 (got ${r.shapes_detected})`);
  // 必须至少含 circle + rect + polygon 各一个
  const hasCircle = /<circle /.test(r.svg);
  const hasRect = /<rect /.test(r.svg);
  const hasPoly = /<polygon /.test(r.svg);
  assert(hasCircle, '检测到 <circle>');
  assert(hasRect, '检测到 <rect>');
  assert(hasPoly, '检测到 <polygon>');
}

async function testMcpServer() {
  section('5. MCP 协议 (server.js stdio)');
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fit_svg', arguments: { image_path: FIXTURE, max_size: 100 } } },
  ];
  const r = await runStdioServer(messages, 20000);
  assert(r.code === 0 || r.code === null, `server exit 正常 (got ${r.code})`);
  const lines = r.out.split('\n').filter(Boolean);
  assert(lines.length >= 3, `收到 ≥3 条响应 (got ${lines.length})`);

  // 解析所有响应
  let initResp, listResp, callResp;
  for (const line of lines) {
    let m;
    try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.id === 1) initResp = m;
    if (m.id === 2) listResp = m;
    if (m.id === 3) callResp = m;
  }
  assert(initResp && initResp.result, 'initialize 响应有 result');
  assert(initResp && initResp.result.protocolVersion, 'initialize 返 protocolVersion');
  assert(listResp && Array.isArray(listResp.result.tools), 'tools/list 返 tools 数组');
  const toolNames = (listResp && listResp.result.tools || []).map(t => t.name);
  assert(toolNames.includes('fit_svg'), 'tools 列表含 fit_svg');
  assert(toolNames.includes('animate_logo_svg'), 'tools 列表含 animate_logo_svg');
  // fit_svg schema
  const fitTool = listResp.result.tools.find(t => t.name === 'fit_svg');
  assert(fitTool && fitTool.inputSchema, 'fit_svg 有 inputSchema');
  assert(fitTool && fitTool.inputSchema.required.includes('image_path'), 'fit_svg 必填 image_path');

  assert(callResp && callResp.result, 'fit_svg 调用响应有 result');
  assert(callResp && callResp.result.isError === false, 'fit_svg 调用成功 (isError=false)');
  assert(callResp && callResp.result.content && callResp.result.content.length >= 1, 'fit_svg 响应有 content');
  const callText = callResp && callResp.result.content[0] && callResp.result.content[0].text;
  let callJson;
  try { callJson = JSON.parse(callText); } catch (e) { callJson = null; }
  assert(callJson && callJson.ok === true, 'fit_svg 调用返 ok:true');
  assert(callJson && typeof callJson.svg === 'string' && callJson.svg.includes('<svg'), 'fit_svg 返 svg 字符串');
  assert(callJson && callJson.shapes_detected >= 2, `fit_svg shapes_detected >= 2 (got ${callJson && callJson.shapes_detected})`);
}

async function testMcpError() {
  section('6. MCP 错误路径');
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fit_svg', arguments: { image_path: '/tmp/nonexistent_xyz.png' } } },
  ];
  const r = await runStdioServer(messages, 20000);
  const lines = r.out.split('\n').filter(Boolean);
  let callResp;
  for (const line of lines) {
    let m;
    try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.id === 2) callResp = m;
  }
  assert(callResp && callResp.result.isError === true, '不存在图片 → isError:true');
  const callText = callResp && callResp.result.content[0] && callResp.result.content[0].text;
  let callJson;
  try { callJson = JSON.parse(callText); } catch (e) { callJson = null; }
  assert(callJson && callJson.ok === false, '不存在图片 → ok:false');
  assert(callJson && /not found/.test(callJson.error || ''), '不存在图片错误信息含 "not found"');
}

async function testE2E() {
  section('7. 端到端 (Pangu HTTP /api/mcp/call)');

  // 检查 Pangu 是否在跑
  let panguUp = false;
  try {
    await new Promise((resolve, reject) => {
      const req = http.get(`${PANGU_URL}/health`, { timeout: 2000 }, (res) => {
        panguUp = res.statusCode < 500;
        resolve();
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  } catch (e) { panguUp = false; }
  if (!panguUp) {
    process.stdout.write('  ⊘ Pangu 未在 18901 跑, 跳过 E2E\n');
    return;
  }

  // 1. 准备测试图片
  const tmpImg = '/tmp/fit_svg_e2e.png';
  const { spawn: spawnSync } = require('child_process');
  await new Promise((resolve, reject) => {
    const p = spawnSync('python3', ['-c', `
from PIL import Image, ImageDraw
img = Image.new('RGB', (100, 100), 'white')
d = ImageDraw.Draw(img)
d.ellipse([10, 10, 50, 50], fill='red')
d.rectangle([55, 30, 90, 80], fill='blue')
img.save('${tmpImg}')
`], { stdio: 'inherit' });
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`gen failed: ${code}`)));
  });
  assert(fileExists(tmpImg), 'E2E 测试图片生成');

  // 2. 调 fit_svg via Pangu HTTP
  const resp = await httpPost(`${PANGU_URL}/api/mcp/call`, {
    server: 'pixel2motion',
    tool: 'fit_svg',
    args: { image_path: tmpImg, max_size: 100 },
  });
  assert(resp.status === 200, `HTTP 200 (got ${resp.status})`);

  // 3. 解析响应
  let respJson;
  try { respJson = JSON.parse(resp.body); } catch (e) { respJson = null; }
  assert(respJson !== null, 'E2E 响应可解析为 JSON');

  // 兼容不同 wrapper 结构 (Pangu 可能包一层)
  // 期望路径: respJson.result.content[0].text → { ok, svg, ... }
  // 或 respJson 直接是 { ok, svg, ... }
  let inner = respJson;
  if (respJson && respJson.result && respJson.result.content) {
    inner = JSON.parse(respJson.result.content[0].text);
  } else if (respJson && respJson.content) {
    inner = JSON.parse(respJson.content[0].text);
  } else if (respJson && respJson.result && typeof respJson.result.svg === 'string') {
    inner = respJson.result;
  }
  assert(inner && inner.ok === true, `E2E ok:true (got: ${inner && inner.ok})`);
  if (inner && inner.svg) {
    assert(inner.svg.includes('<svg'), 'E2E svg 含 <svg');
    assert(/<rect|<circle|<polygon/.test(inner.svg), 'E2E svg 含形状元素');
  }
  if (inner) {
    assert(inner.shapes_detected >= 1, `E2E shapes_detected >= 1 (got ${inner.shapes_detected})`);
    process.stdout.write(`  ℹ E2E svg 截前 200 字符: ${(inner.svg || '').slice(0, 200)}\n`);
  }
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  process.stdout.write('=== fit_svg MCP 工具测试 ===\n');
  process.stdout.write(`ROOT: ${ROOT}\n`);

  if (!ONLY_E2E) {
    await testFileExistence();
    await testPythonCli();
    await testPythonCliLow();
    await testPythonCliHigh();
    await testPythonCliErrors();
    await testNodeWrapper();
    await testThreeShapes();
    await testMcpServer();
    await testMcpError();
  }
  if (!SKIP_E2E) {
    await testE2E();
  }

  process.stdout.write(`\n=== 结果: ${passed} 通过 / ${failed} 失败 ===\n`);
  if (failed > 0) {
    process.stdout.write('\n失败列表:\n');
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`测试异常: ${e.stack || e.message}\n`);
  process.exit(2);
});
