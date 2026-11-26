'use strict';
// 2026-10-13 现场 (诊断埋点第一次上线就抓到唯一一条实证, /tmp/pangu-single.err):
//   body 前 300 字: data: {"type":"error","error":{"type":"server_error",
//                  "message":"unknown error (1000)","http_code":"500"},
//                  "request_id":"071c41fea190d14a58b01abfc4d58add"}
// 同一时刻的下游整条链:
//   [llm-sse-fallback] ... chunks=1 | body 前 300 字: data: {"type":"error"...}
//   [j2-native] LLM call failed: 解析响应失败: Unexpected token 'd', "data: {"ty"... is not valid JSON
//   [j2-native] fallback to legacy J2 XML path        ← nativeToolCallSupported = false
//   [dispatcher] 验收 FAIL → 自动补救轮 #1
//   [dispatcher] 答复自认未完成 → 收口标 partial
//
// 三个问题:
//   ① 错误信封没有 choices 字段 → 被 `if (!ch) continue` 跳过 → 归并出 0 字 0 工具 → 返回 null
//      → 上层抛 JSON.parse 的**语法错**, 真实原因 (上游 500 server_error) 被顶掉。
//      运维看到 "Unexpected token 'd'" 会去查解析器, 而真因是上游挂了。
//   ② _isInfraError 只认 DNS/连接类和 429 → 认不出上游 5xx → 不切模型、不快速失败。
//   ③ 于是落到 fallback to legacy J2 XML path, 而那条分支带 nativeToolCallSupported = false
//      —— **一次瞬时 500 让本次请求的后续轮次全走 legacy XML 工具调用** (该标志是请求内局部变量,
//      下一个请求会重新探测恢复; 但不会去尝试切模型、不会快速失败。
//
// 顺带否掉交接里的原假设: "keepAlive 连接复用时 SSE 残留字节串进下一响应"。
// 实证是**一个格式良好的 SSE 错误事件** (chunks=1), 不是残留字节串。
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const LC = require('../modules/llm_caller');
const shared = require('../modules/j2_loop_shared');

const ERR_BODY = 'data: {"type":"error","error":{"type":"server_error","message":"unknown error (1000)","http_code":"500"},"request_id":"071c41fea190d14a58b01abfc4d58add"}';

test('上游错误事件必须抛出真实原因, 不能归并成 null', () => {
  assert.throws(() => LC._parseSSEBody(ERR_BODY), (e) => {
    assert.match(e.message, /上游|upstream/i, '得说清是上游报的, 不是本地解析失败: ' + e.message);
    return true;
  }, '归 null = 把上游失败伪装成"归不出内容", 上层只会拿到语法错');
});

test('错误信息必须带上上游给的真实字段 (运维就靠这几个定位)', () => {
  let msg = '';
  try { LC._parseSSEBody(ERR_BODY); } catch (e) { msg = e.message; }
  for (const want of ['server_error', 'unknown error (1000)', '500', '071c41fea190d14a58b01abfc4d58add']) {
    assert.ok(msg.includes(want), `错误信息丢了 "${want}" —— 实际: ${msg}`);
  }
});

test('ping / heartbeat 不是错误事件, 仍归 null (别修过头)', () => {
  const body = ['data: {"type":"ping"}', 'data: {"type":"heartbeat","ts":1}', 'data: [DONE]'].join('\n\n');
  assert.equal(LC._parseSSEBody(body), null);
});

test('已经有正文时, 末尾的错误事件不该打断 (半截内容好过没有)', () => {
  const body = [
    'data: {"choices":[{"delta":{"content":"已完成前半段"}}]}',
    ERR_BODY,
    'data: [DONE]',
  ].join('\n\n');
  const r = LC._parseSSEBody(body);
  assert.ok(r, '有正文就必须照常归并');
  assert.equal(r.choices[0].message.content, '已完成前半段');
});

test('非流式路径不能给上游错误套上"解析响应失败"的前缀', () => {
  const res = new EventEmitter();
  res.statusCode = 200;
  let rejected = null;
  LC._handlePlainResponse(res, null, () => {}, (e) => { rejected = e; });
  res.emit('data', ERR_BODY);
  res.emit('end');
  assert.ok(rejected, '上游错误必须 reject');
  assert.ok(!/解析响应失败/.test(rejected.message),
    '"解析响应失败" 是误导性标签 —— 真因是上游 500, 照着它查解析器会白查: ' + rejected.message);
});

test('_isInfraError 必须认上游 5xx (SSE 错误事件与普通 HTTP 500 两种形状)', () => {
  let msg = '';
  try { LC._parseSSEBody(ERR_BODY); } catch (e) { msg = e.message; }
  assert.equal(shared._isInfraError(msg), true,
    '认不出 → 不切模型不快速失败 → 直接掉进 legacy 降级');
  assert.equal(shared._isInfraError('HTTP 500: unknown error'), true,
    '非 2xx 的普通 500 同样落不进基础设施分类 (原实现只认 429 和网络类)');
  assert.equal(shared._isInfraError('HTTP 400: bad request'), false,
    '4xx 是请求本身有问题, 别混进基础设施错误');
});

test('_infraFailText 对上游 5xx 不能说"检查网络/DNS"', () => {
  const t = shared._infraFailText('上游 SSE 错误事件: server_error unknown error (1000) http_code=500', { id: 'minimax' });
  assert.ok(!/检查网络\/DNS/.test(t),
    '端点明明通了才回的 500, 让用户去查 DNS 是指错方向: ' + t);
  assert.match(t, /500|上游|服务/, '得说清是上游服务端错误: ' + t);
});
