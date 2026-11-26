#!/usr/bin/env node
/**
 * test_capture_frames.js — capture_frames MCP 工具测试 (≥30 项断言)
 *
 * 测 4 层:
 *  1. 文件存在性 (4 项)
 *  2. Python CLI 直测 (8 项)
 *  3. Node.js wrapper (validateArgs + captureFrames) (10 项)
 *  4. MCP stdio 协议 (server.js 注册) (4 项)
 *  5. 错误处理 (5 项)
 *  6. 端到端 (Pangu + curl) (≥3 项)
 *
 * 用法:
 *   node tests/test_capture_frames.js          # 跑全部 (含 E2E)
 *   node tests/test_capture_frames.js --no-e2e # 跳过 E2E
 *   node tests/test_capture_frames.js --e2e    # 只跑 E2E
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..');
const TOOLS_DIR = path.join(ROOT, 'tools');
const CAPTURE_FRAMES_PY = path.join(TOOLS_DIR, 'capture_frames.py');
const CAPTURE_FRAMES_JS = path.join(TOOLS_DIR, 'capture_frames.js');
const SERVER_JS = path.join(ROOT, 'server.js');
const PANGU_URL = 'http://127.0.0.1:18901';

const ARGS = process.argv.slice(2);
const ONLY_E2E = ARGS.includes('--e2e');
const SKIP_E2E = ARGS.includes('--no-e2e');

// ============================================================
// 测试框架
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

const SIMPLE_HTML = '<!DOCTYPE html><html><head><style>.b{width:80px;height:80px;background:red;animation:f 2s}@keyframes f{0%{opacity:0}100%{opacity:1}}</style></head><body><div class="b"></div></body></html>';
const SPIN_HTML = '<!DOCTYPE html><html><head><style>.b{width:60px;height:60px;background:blue;animation:s 2s linear}@keyframes s{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}</style></head><body><div class="b"></div></body></html>';

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* noop */ }
}

function mkTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runPythonCli(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [CAPTURE_FRAMES_PY, '--json', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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

function runStdioServer(messages, timeoutMs = 60000) {
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
    for (const msg of messages) {
      child.stdin.write(JSON.stringify(msg) + '\n');
    }
    child.stdin.end();
  });
}

function httpPost(urlStr, body, timeoutMs = 60000) {
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
    const t = setTimeout(() => {
      req.destroy(new Error(`HTTP timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    req.on('close', () => clearTimeout(t));
    req.write(data);
    req.end();
  });
}

// ============================================================
// 测试套件
// ============================================================

async function testFileExistence() {
  section('0. 文件存在性');
  assert(fileExists(CAPTURE_FRAMES_PY), 'tools/capture_frames.py 存在');
  assert(fileExists(CAPTURE_FRAMES_JS), 'tools/capture_frames.js 存在');
  assert(fileExists(SERVER_JS), 'server.js 存在');
  // capture_frames 应已注册在 server.js TOOLS
  const srv = fs.readFileSync(SERVER_JS, 'utf8');
  assert(srv.includes('CAPTURE_FRAMES_TOOL_SCHEMA'), 'server.js 引用 CAPTURE_FRAMES_TOOL_SCHEMA');
  assert(srv.includes("require('./tools/capture_frames.js')"), 'server.js require capture_frames.js');
  assert(srv.includes("name === 'capture_frames'"), 'server.js dispatch 处理 capture_frames');
}

async function testPythonCliSimple() {
  section('1. Python CLI — 简单 HTML 3 帧');
  const tmpDir = mkTmpDir('cap_simple_');
  try {
    const r = await runPythonCli([SIMPLE_HTML, '[0, 500, 1500]', tmpDir, '400', '300']);
    assert(r.code === 0, `CLI exit code 0 (got ${r.code})`);
    let j;
    try { j = JSON.parse(r.out.trim()); } catch (e) { j = null; }
    assert(j !== null, 'CLI 输出可解析为 JSON');
    assert(j && j.ok === true, 'CLI 返 ok:true');
    assert(j && Array.isArray(j.frame_paths), 'frame_paths 是数组');
    assert(j && j.frame_paths.length === 3, `frame_paths 长度 = 3 (got ${j && j.frame_paths.length})`);
    // 每条都是绝对路径
    for (const p of (j && j.frame_paths) || []) {
      assert(path.isAbsolute(p), `frame_path 是绝对路径: ${p}`);
      assert(fileExists(p), `frame_path 文件存在: ${path.basename(p)}`);
    }
    assert(j && path.isAbsolute(j.strip_path), 'strip_path 是绝对路径');
    assert(j && fileExists(j.strip_path), 'strip_path 文件存在');
    assert(j && j.total_frames === 3, `total_frames = 3 (got ${j && j.total_frames})`);
    assert(j && j.capture_time_ms > 0, `capture_time_ms > 0 (got ${j && j.capture_time_ms})`);
  } finally {
    rmrf(tmpDir);
  }
}

async function testPythonCliSpin() {
  section('2. Python CLI — 旋转动画 4 帧');
  const tmpDir = mkTmpDir('cap_spin_');
  try {
    const r = await runPythonCli([SPIN_HTML, '[0, 250, 750, 1500]', tmpDir, '320', '240']);
    let j;
    try { j = JSON.parse(r.out.trim()); } catch (e) { j = null; }
    assert(j && j.ok === true, '旋转动画 CLI ok:true');
    assert(j && j.frame_paths.length === 4, '旋转 4 帧全部生成');
    assert(j && fileExists(j.strip_path), '旋转 motion strip 存在');
  } finally {
    rmrf(tmpDir);
  }
}

async function testPythonCliAtFilePath() {
  section('3. Python CLI — @file 模式读取 HTML');
  const tmpDir = mkTmpDir('cap_atfile_');
  const htmlFile = path.join(tmpDir, '_input.html');
  fs.writeFileSync(htmlFile, SIMPLE_HTML);
  const outDir = mkTmpDir('cap_atfile_out_');
  try {
    const r = await runPythonCli([`@${htmlFile}`, '[0, 1000]', outDir, '200', '200']);
    let j;
    try { j = JSON.parse(r.out.trim()); } catch (e) { j = null; }
    assert(j && j.ok === true, '@file 模式 ok:true');
    assert(j && j.frame_paths.length === 2, '@file 模式 2 帧');
  } finally {
    rmrf(tmpDir);
    rmrf(outDir);
  }
}

async function testPythonCliErrors() {
  section('4. Python CLI — 错误处理');
  // 4.1 无效 HTML (空字符串)
  {
    const tmpDir = mkTmpDir('cap_err1_');
    try {
      const r = await runPythonCli(['', '[0, 100]', tmpDir, '200', '200']);
      let j;
      try { j = JSON.parse(r.out.trim()); } catch (e) { j = null; }
      assert(j && j.ok === false, '空 HTML → ok:false');
      assert(j && /html/.test(j.error || ''), `错误信息含 "html" (got: ${j && j.error})`);
    } finally { rmrf(tmpDir); }
  }
  // 4.2 无效 times_ms
  {
    const tmpDir = mkTmpDir('cap_err2_');
    try {
      const r = await runPythonCli([SIMPLE_HTML, '[]', tmpDir, '200', '200']);
      let j;
      try { j = JSON.parse(r.out.trim()); } catch (e) { j = null; }
      assert(j && j.ok === false, '空 times_ms → ok:false');
      assert(j && /times_ms/.test(j.error || ''), `错误信息含 "times_ms" (got: ${j && j.error})`);
    } finally { rmrf(tmpDir); }
  }
  // 4.3 无效 output_dir (无写权限)
  {
    const r = await runPythonCli([SIMPLE_HTML, '[0, 100]', '/this/path/does/not/exist/xyz/blah', '200', '200']);
    let j;
    try { j = JSON.parse(r.out.trim()); } catch (e) { j = null; }
    assert(j && j.ok === false, '无效 output_dir → ok:false');
    // 注意: mkdir(exist_ok=True) 会创建路径, 所以这个测试可能反而成功
    // 只要返回有效 JSON (可能 ok:true) 就算通过
    assert(j !== null, '无效 output_dir 返回可解析 JSON');
  }
  // 4.4 视窗尺寸超界
  {
    const tmpDir = mkTmpDir('cap_err4_');
    try {
      const r = await runPythonCli([SIMPLE_HTML, '[0, 100]', tmpDir, '99999', '200']);
      let j;
      try { j = JSON.parse(r.out.trim()); } catch (e) { j = null; }
      assert(j && j.ok === false, 'width 超出范围 → ok:false');
      assert(j && /width/.test(j.error || ''), `错误信息含 "width" (got: ${j && j.error})`);
    } finally { rmrf(tmpDir); }
  }
  // 4.5 HTML 太大 (>5MB) - 必须用 @file 模式, 否则 argv E2BIG
  {
    const tmpDir = mkTmpDir('cap_err5_');
    const bigFile = path.join(tmpDir, 'big.html');
    try {
      const bigHtml = '<html><body>' + 'x'.repeat(6 * 1024 * 1024) + '</body></html>';
      fs.writeFileSync(bigFile, bigHtml);
      const r = await runPythonCli([`@${bigFile}`, '[0, 100]', tmpDir, '200', '200']);
      let j;
      try { j = JSON.parse(r.out.trim()); } catch (e) { j = null; }
      assert(j && j.ok === false, 'HTML > 5MB → ok:false');
      assert(j && /too large/.test(j.error || ''), `错误信息含 "too large" (got: ${j && j.error})`);
    } finally { rmrf(tmpDir); }
  }
}

async function testNodeWrapper() {
  section('5. Node.js wrapper — validateArgs');
  const { validateArgs, captureFrames } = require(CAPTURE_FRAMES_JS);

  // 5.1 缺参
  const v1 = validateArgs({});
  assert(v1.ok === false, 'validateArgs({}) → ok:false');

  // 5.2 缺 html
  const v2 = validateArgs({ times_ms: [0], output_dir: '/tmp' });
  assert(v2.ok === false && /html/.test(v2.error), '缺 html → ok:false');

  // 5.3 缺 times_ms
  const v3 = validateArgs({ html: SIMPLE_HTML, output_dir: '/tmp' });
  assert(v3.ok === false && /times_ms/.test(v3.error), '缺 times_ms → ok:false');

  // 5.4 缺 output_dir
  const v4 = validateArgs({ html: SIMPLE_HTML, times_ms: [0] });
  assert(v4.ok === false && /output_dir/.test(v4.error), '缺 output_dir → ok:false');

  // 5.5 负 times_ms
  const v5 = validateArgs({ html: SIMPLE_HTML, times_ms: [-100], output_dir: '/tmp' });
  assert(v5.ok === false && /times_ms\[0\]/.test(v5.error), '负 times_ms → ok:false');

  // 5.6 times_ms 过多
  const v6 = validateArgs({
    html: SIMPLE_HTML,
    times_ms: Array.from({ length: 25 }, (_, i) => i * 100),
    output_dir: '/tmp',
  });
  assert(v6.ok === false && /too many/.test(v6.error), 'times_ms 过多 → ok:false');

  // 5.7 width 默认值
  const v7 = validateArgs({ html: SIMPLE_HTML, times_ms: [0], output_dir: '/tmp' });
  assert(v7.ok === true && v7.value.width === 800, 'width 默认为 800');
  assert(v7.value.height === 600, 'height 默认为 600');

  // 5.8 显式 width/height
  const v8 = validateArgs({ html: SIMPLE_HTML, times_ms: [0], output_dir: '/tmp', width: 1024, height: 768 });
  assert(v8.ok === true && v8.value.width === 1024 && v8.value.height === 768, '显式 width/height 通过');

  // 5.9 captureFrames 异步调用
  const outDir = mkTmpDir('cap_wrapper_');
  try {
    const result = await captureFrames({
      html: SIMPLE_HTML,
      times_ms: [0, 1000],
      output_dir: outDir,
      width: 300,
      height: 200,
    });
    assert(result.ok === true, `captureFrames 异步调用 ok:true (got: ${JSON.stringify(result).slice(0, 200)})`);
    assert(Array.isArray(result.frame_paths) && result.frame_paths.length === 2, 'captureFrames 返 2 帧');
    assert(fileExists(result.strip_path), 'captureFrames motion strip 存在');
    assert(typeof result.capture_time_ms === 'number' && result.capture_time_ms > 0, 'capture_time_ms 是正数');
  } finally {
    rmrf(outDir);
  }
}

async function testStdioServer() {
  section('6. MCP stdio 协议');
  // 6.1 initialize
  const initResp = await runStdioServer([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  ]);
  let initLines = initResp.out.trim().split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const init1 = initLines.find(l => l.id === 1);
  assert(init1 && init1.result && init1.result.protocolVersion, 'initialize 返 protocolVersion');
  assert(init1 && init1.result && init1.result.serverInfo && init1.result.serverInfo.name === 'pixel2motion', 'serverInfo.name = pixel2motion');

  // 6.2 tools/list 含 capture_frames
  const listResp = await runStdioServer([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);
  const listLines = listResp.out.trim().split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const list2 = listLines.find(l => l.id === 2);
  const tools = list2 && list2.result && list2.result.tools;
  assert(Array.isArray(tools) && tools.length >= 4, `tools 数组长度 ≥ 4 (got ${tools && tools.length})`);
  const captureTool = tools && tools.find(t => t.name === 'capture_frames');
  assert(captureTool !== undefined, 'tools 含 capture_frames');
  assert(captureTool && captureTool.inputSchema && captureTool.inputSchema.required.includes('html'), 'inputSchema.required 含 html');
  assert(captureTool && captureTool.inputSchema.properties.times_ms !== undefined, 'inputSchema.properties.times_ms 存在');
  assert(captureTool && captureTool.inputSchema.properties.output_dir !== undefined, 'inputSchema.properties.output_dir 存在');

  // 6.3 tools/call capture_frames (有效参数)
  const outDir = mkTmpDir('cap_stdio_');
  try {
    const callResp = await runStdioServer([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'capture_frames',
        arguments: {
          html: SIMPLE_HTML,
          times_ms: [0, 500, 1500],
          output_dir: outDir,
          width: 320,
          height: 240,
        },
      } },
    ], 60000);
    const callLines = callResp.out.trim().split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const call2 = callLines.find(l => l.id === 2);
    assert(call2 && call2.result, 'tools/call 返 result');
    const content = call2 && call2.result && call2.result.content;
    assert(Array.isArray(content) && content.length > 0, 'result.content 是数组');
    let parsed;
    if (content && content[0] && content[0].text) {
      try { parsed = JSON.parse(content[0].text); } catch (e) { parsed = null; }
    }
    assert(parsed !== null, 'result.content[0].text 可解析为 JSON');
    assert(parsed && parsed.ok === true, `stdio 调用 capture_frames ok:true (got: ${JSON.stringify(parsed).slice(0, 200)})`);
    assert(parsed && Array.isArray(parsed.frame_paths) && parsed.frame_paths.length === 3, 'stdio 返 3 帧');
    assert(parsed && fileExists(parsed.strip_path), 'stdio motion strip 文件存在');
    assert(call2 && call2.result && call2.result.isError !== true, 'isError !== true');
  } finally {
    rmrf(outDir);
  }

  // 6.4 tools/call capture_frames (无效参数)
  {
    const callResp = await runStdioServer([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'capture_frames',
        arguments: { html: '', times_ms: [0], output_dir: '/tmp' },
      } },
    ]);
    const callLines = callResp.out.trim().split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    const call2 = callLines.find(l => l.id === 2);
    assert(call2 && call2.result && call2.result.isError === true, 'stdio 无效参数 → isError=true');
    const content = call2 && call2.result && call2.result.content;
    let parsed;
    if (content && content[0] && content[0].text) {
      try { parsed = JSON.parse(content[0].text); } catch (e) { parsed = null; }
    }
    assert(parsed && parsed.ok === false, 'stdio 无效参数 → content.ok=false');
  }
}

async function testEndToEnd() {
  section('7. 端到端 — Pangu :18901 + curl');
  // 7.1 Pangu 是否在 18901 监听
  let panguOk = false;
  try {
    const r = await httpPost(PANGU_URL + '/api/mcp/call', {
      server: 'pixel2motion',
      tool: 'capture_frames',
      args: { html: SIMPLE_HTML, times_ms: [0], output_dir: mkTmpDir('cap_pangu_') },
    }, 5000);
    panguOk = r.status > 0;
  } catch (e) {
    panguOk = false;
  }
  if (!panguOk) {
    assert(false, 'Pangu 18901 不可达 — 跳过 E2E (server 不在运行)');
    return;
  }

  // 7.2 端到端 capture_frames
  const outDir = mkTmpDir('cap_e2e_');
  try {
    const r = await httpPost(PANGU_URL + '/api/mcp/call', {
      server: 'pixel2motion',
      tool: 'capture_frames',
      args: {
        html: SIMPLE_HTML,
        times_ms: [0, 500, 1500],
        output_dir: outDir,
        width: 400,
        height: 300,
      },
    }, 60000);
    assert(r.status === 200, `Pangu HTTP 200 (got ${r.status})`);
    let respBody;
    try { respBody = JSON.parse(r.body); } catch (e) { respBody = null; }
    assert(respBody !== null, 'Pangu 响应可解析为 JSON');

    // Pangu 响应结构: { ok: true, result: { content: [{ type: 'text', text: '<JSON>' }] }, server, tool }
    let result = null;
    if (respBody && respBody.ok && respBody.result && Array.isArray(respBody.result.content)) {
      const c0 = respBody.result.content[0];
      if (c0 && c0.type === 'text' && typeof c0.text === 'string') {
        try { result = JSON.parse(c0.text); } catch (e) { result = null; }
      }
    }
    assert(result && result.ok === true, `E2E capture_frames ok:true (resp: ${r.body.slice(0, 300)})`);
    if (result && result.ok) {
      assert(Array.isArray(result.frame_paths) && result.frame_paths.length === 3, `E2E 返 3 帧 (got ${result.frame_paths && result.frame_paths.length})`);
      assert(fileExists(result.strip_path), `E2E motion strip 存在: ${result.strip_path}`);
      // 验证帧是 PNG
      for (const fp of result.frame_paths || []) {
        assert(fileExists(fp), `E2E 帧存在: ${path.basename(fp)}`);
      }
    }
  } finally {
    rmrf(outDir);
  }
}

async function testPerformance() {
  section('8. 性能 — 5 帧 < 30 秒');
  const tmpDir = mkTmpDir('cap_perf_');
  try {
    const start = Date.now();
    const r = await runPythonCli([SIMPLE_HTML, '[0, 300, 700, 1000, 1500]', tmpDir, '400', '300']);
    const elapsed = Date.now() - start;
    let j;
    try { j = JSON.parse(r.out.trim()); } catch (e) { j = null; }
    assert(j && j.ok === true, '5 帧捕获 ok:true');
    assert(j && j.total_frames === 5, '5 帧全部生成');
    assert(elapsed < 30000, `5 帧捕获总耗时 < 30s (got ${elapsed}ms)`);
    assert(j && j.capture_time_ms < 30000, `Python 报告 capture_time_ms < 30s (got ${j && j.capture_time_ms}ms)`);
  } finally {
    rmrf(tmpDir);
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  const startTime = Date.now();

  if (!ONLY_E2E) {
    await testFileExistence();
    await testPythonCliSimple();
    await testPythonCliSpin();
    await testPythonCliAtFilePath();
    await testPythonCliErrors();
    await testNodeWrapper();
    await testStdioServer();
    await testPerformance();
  }
  if (!SKIP_E2E) {
    await testEndToEnd();
  }

  const elapsed = Date.now() - startTime;
  section('汇总');
  process.stdout.write(`\n通过: ${passed} / ${passed + failed}\n`);
  process.stdout.write(`失败: ${failed}\n`);
  process.stdout.write(`耗时: ${elapsed}ms\n`);
  if (failures.length > 0) {
    process.stdout.write(`\n失败列表:\n`);
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${e.stack || e.message}\n`);
  process.exit(2);
});
