'use strict';

/**
 * 2026-10-14 — HTTP 状态码守卫
 *
 * issues/ 里两条真实崩溃:
 *   RangeError [ERR_HTTP_INVALID_STATUS_CODE]: Invalid status code: 1
 *     at ServerResponse.writeHead
 *   TypeError [ERR_UNKNOWN_ENCODING]: Unknown encoding: 404
 *     at ServerResponse._write
 *
 * 都发生在写响应头的那一瞬间 → 响应流当场断掉 → 长任务不明不白地死。
 * 本测试把 safeStatus 的边界钉死: 合法值零行为变化, 脏值绝不透传。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { safeStatus } = require('../modules/http_status');

test('合法状态码原样返回 (零行为变化)', () => {
  for (const c of [100, 200, 201, 204, 301, 400, 404, 422, 500, 502, 503, 599]) {
    assert.equal(safeStatus(c, 200), c, `${c} 应原样返回`);
  }
});

test('数字字符串放行 (上游转发常带这种)', () => {
  assert.equal(safeStatus('404', 200), 404);
  assert.equal(safeStatus(' 500 ', 200), 500);
});

test('true 不许变成状态码 1 (线上真崩过 Invalid status code: 1)', () => {
  assert.equal(safeStatus(true, 200), 200);
  assert.equal(safeStatus(false, 500), 500);
});

test('undefined / null 落回 fallback', () => {
  assert.equal(safeStatus(undefined, 200), 200);
  assert.equal(safeStatus(null, 500), 500);
  assert.equal(safeStatus(undefined), 500, '不传 fallback 时默认 500');
});

test('越界 / 非整数 / NaN 落回 fallback', () => {
  for (const c of [0, 1, 99, 600, 1000, -200, 200.5, NaN, Infinity, -Infinity]) {
    assert.equal(safeStatus(c, 200), 200, `${String(c)} 应落回`);
  }
});

test('非数字字符串落回 (ERR_XXX 这类)', () => {
  for (const c of ['ERR_INVALID_ARG_TYPE', 'ok', 'abc', '']) {
    assert.equal(safeStatus(c, 502), 502, `'${c}' 应落回`);
  }
});

test('对象 / 数组落回', () => {
  assert.equal(safeStatus({}, 200), 200);
  assert.equal(safeStatus([], 200), 200);
  assert.equal(safeStatus({ statusCode: 404 }, 200), 200);
});

test('fallback 自己非法时兜到 500 (不能雪上加霜)', () => {
  assert.equal(safeStatus('bad', 'also-bad'), 500);
  assert.equal(safeStatus('bad', 99), 500);
  assert.equal(safeStatus('bad', 600), 500);
  assert.equal(safeStatus('bad', 404), 404, 'fallback 合法时应当用它');
});

test('真实崩溃复现: 脏状态码不再抛 ERR_HTTP_INVALID_STATUS_CODE', () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    // 旧代码: res.writeHead(e.status) 当 e.status 是 true 时 → Invalid status code: 1
    const e = { status: true };
    res.writeHead(safeStatus(e.status, 500), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      http.get({ host: '127.0.0.1', port, path: '/' }, (r) => {
        let body = '';
        r.on('data', (c) => { body += c; });
        r.on('end', () => {
          try {
            assert.equal(r.statusCode, 500, '应落回 500 而不是抛异常断流');
            assert.deepEqual(JSON.parse(body), { ok: false });
            server.close(resolve);
          } catch (err) { server.close(() => reject(err)); }
        });
      }).on('error', (err) => { server.close(() => reject(err)); });
    });
  });
});

test('上游转发: resp.status 是脏值时响应仍能完整结束', () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    const resp = { ok: false, status: 'UPSTREAM_DOWN' };  // 上游给了非数字 status
    res.writeHead(safeStatus(resp.ok ? 200 : resp.status, 502), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      http.get({ host: '127.0.0.1', port, path: '/' }, (r) => {
        r.resume();
        r.on('end', () => {
          try {
            assert.equal(r.statusCode, 502);
            server.close(resolve);
          } catch (err) { server.close(() => reject(err)); }
        });
      }).on('error', (err) => { server.close(() => reject(err)); });
    });
  });
});
