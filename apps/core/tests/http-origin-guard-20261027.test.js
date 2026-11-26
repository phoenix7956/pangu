'use strict';

// 2026-10-27 (第 118 批): 跨源写请求守卫
//
// 背景: modules/http_server.js 里写好的 CORS + token 加固层**从来没被调用过**
//   (pangu-single.js 直接 http.createServer) ⇒ 等于没有。
//   而且就算调起来, 原来那层只管**响应头**(ACAO) —— 挡得住「读」, 挡不住「写」:
//   简单请求 (Content-Type: text/plain) 不走预检 ⇒ 浏览器照样把请求发出去,
//   服务端照样执行 ⇒ 恶意网页能让盘古跑任意工具 (CSRF)。
//
// 本文件锁四件事:
//   1. 真的 server 走的是 httpServer.createServer (加固层不再是死代码)
//   2. 跨源**写** ⇒ 403; 同源 / 无 Origin ⇒ 放行
//   3. 白名单里显式加的源可以跨源写
//   4. 密钥文件 / 工具输出日志的权限边界不被改回去

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const CORE = path.join(__dirname, '..');
const httpServer = require(path.join(CORE, 'modules', 'http_server.js'));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function req(port, method, reqPath, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('118-1: 真的 server 走 httpServer.createServer (加固层不再是死代码)', () => {
  const src = fs.readFileSync(path.join(CORE, 'pangu-single.js'), 'utf8');
  assert.ok(src.includes('httpServer.createServer('),
    'pangu-single.js 必须用 httpServer.createServer —— 直接 http.createServer 等于把加固层变成死代码');
  assert.ok(!/const server = http\.createServer\(/.test(src),
    'pangu-single.js 里不该再有裸 http.createServer');
  // 静态页出口不能因为换了 server 就掉链子 —— 路由链必须一处定义两处用
  assert.ok(src.includes('routeRequest'), '路由链要提成 routeRequest, init/createServer 共用');
  // 2026-10-28 (第 139 批): 静态页出口合并成一个 —— 根路径 (302 → 工作台)、
  //   /app 工作台、/api 索引页都归 webStatic; 老的 apiIndex 模块已删。
  assert.ok(src.includes('webStatic.handler(req, res)'),
    '路由链里必须有静态页出口 (根路径 + 工作台 + API 索引页)');
  assert.ok(!/apiIndex\.serve/.test(src),
    '路由链里不许再调已删除的 apiIndex 模块');
});

test('118-2: 跨源写请求 403, 同源与无 Origin 放行', async () => {
  const server = httpServer.createServer(async (rq, rs) => {
    rs.writeHead(200, { 'Content-Type': 'application/json' });
    rs.end(JSON.stringify({ ok: true, method: rq.method }));
  });
  const port = await listen(server);
  try {
    // 跨源写 ⇒ 403 (真 CSRF 形态: text/plain 简单请求)
    const cross = await req(port, 'POST', '/api/x', {
      Origin: 'https://evil.example',
      'Content-Type': 'text/plain',
    });
    assert.equal(cross.status, 403, '跨源写请求必须 403, 实际 ' + cross.status);
    assert.ok(/cross-origin write rejected/.test(cross.body), '403 的正文要说清是被跨源写挡的');

    // 同源写 ⇒ 放行
    const same = await req(port, 'POST', '/api/x', {
      Origin: 'http://127.0.0.1:' + port,
      'Content-Type': 'application/json',
    });
    assert.equal(same.status, 200, '同源写请求必须放行, 实际 ' + same.status);

    // 无 Origin (curl / CLI / 本机脚本) ⇒ 放行
    const none = await req(port, 'POST', '/api/x', { 'Content-Type': 'application/json' });
    assert.equal(none.status, 200, '无 Origin 的写请求必须放行, 实际 ' + none.status);

    // 跨源**读** ⇒ 放行 (这条守卫只管写, 读接口不能被误伤)
    const crossGet = await req(port, 'GET', '/api/x', { Origin: 'https://evil.example' });
    assert.equal(crossGet.status, 200, '跨源读请求不该被这条守卫挡住, 实际 ' + crossGet.status);
  } finally {
    server.close();
  }
});

test('118-3: 白名单里显式加的源可以跨源写', async () => {
  // PANGU_ALLOWED_ORIGINS 是给「跨源接入」留的口子 —— 加了的源必须真能写
  const prev = process.env.PANGU_ALLOWED_ORIGINS;
  process.env.PANGU_ALLOWED_ORIGINS = 'https://allowed.example';
  delete require.cache[require.resolve(path.join(CORE, 'modules', 'http_server.js'))];
  const mod = require(path.join(CORE, 'modules', 'http_server.js'));
  const server = mod.createServer(async (rq, rs) => {
    rs.writeHead(200, { 'Content-Type': 'application/json' });
    rs.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(server);
  try {
    const allowed = await req(port, 'POST', '/api/x', {
      Origin: 'https://allowed.example',
      'Content-Type': 'application/json',
    });
    assert.equal(allowed.status, 200, '白名单里的源必须能写, 实际 ' + allowed.status);
  } finally {
    server.close();
    if (prev === undefined) delete process.env.PANGU_ALLOWED_ORIGINS;
    else process.env.PANGU_ALLOWED_ORIGINS = prev;
  }
});

test('118-4: 密钥文件和工具输出日志的权限边界不被改回去', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'tools', 'index.js'), 'utf8');
  assert.ok(src.includes("'.pangu', 'credentials.json'"),
    'read_file/write_file 的 blocked 名单必须含 ~/.pangu/credentials.json (三个真 key 的明文)');
  assert.ok(src.includes('0o600'), '工具输出日志落盘必须是 0600');
  assert.ok(src.includes('0o700'), '工具输出日志目录必须是 0700');
});
