'use strict';

/**
 * HTTP 状态码守卫 (2026-10-14)
 *
 * 起因 — issues/ 里两条真实崩溃, 都在响应流上:
 *   RangeError [ERR_HTTP_INVALID_STATUS_CODE]: Invalid status code: 1
 *     at ServerResponse.writeHead
 *   TypeError [ERR_UNKNOWN_ENCODING]: Unknown encoding: 404
 *     at ServerResponse._write
 *
 * 共同根因: writeHead 的状态码参数没有校验。Node 要求 100..599 的整数, 传进去
 * 任何别的 (true → 1、'ERR_XXX' 字符串、undefined 之外的垃圾) 都会在写响应头的
 * 那一瞬间抛异常。而这些 throw 发生在请求处理器里, 响应流当场断掉 ——
 * 对长任务来说就是「任务不明不白地死了」, 前端只看到连接断, 看不到原因。
 *
 * 典型危险点:
 *   res.writeHead(e.status || 500, ...)        // e.status 来自捕获的异常, 未必合法
 *   res.writeHead(resp.ok ? 200 : resp.status) // 来自上游转发
 *   res.writeHead(status || 200, ...)         // status 来自调用方
 *
 * 修法: 状态码一律过 safeStatus()。合法值原样返回(零行为变化), 非法值落回
 * fallback 并记一条日志 —— 响应流不再因为一个脏状态码整个断掉。
 *
 * 踩坑日志铁律 1: 让每个调用点自己小心是注释, 只有这里是机制。
 */

function safeStatus(code, fallback = 500) {
  const fb = (Number.isInteger(fallback) && fallback >= 100 && fallback <= 599) ? fallback : 500;

  // 允许数字字符串 ('404'), 但不允许 'ERR_XXX' / true / NaN / 越界
  let n = typeof code === 'string' && /^\d{3}$/.test(code.trim()) ? Number(code.trim()) : code;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 100 || n > 599) {
    const shown = typeof code === 'string' ? code : (typeof code === 'number' ? String(code) : typeof code);
    console.warn(`[http_status] 非法状态码 ${shown} (${typeof code}), 落回 ${fb}`);
    return fb;
  }
  return n;
}

module.exports = { safeStatus };
