// lib/route.mjs —— 工作台路由真源 (单段 · 相对路径)
//
// 2026-10-28 (第 140 批): 路由从 `#/bazi` 改成真路径 `/bazi`。
//   为什么换: `#/bazi` 是「API 服务顺便带个界面」时代的产物 —— 碎片不进服务器,
//   所以当时用它换来了「服务端不用做 SPA 回退」的便宜。代价是地址难看:
//   `http://127.0.0.1:18901/app/#/bazi`。产品级的地址应该是
//   `http://127.0.0.1:18901/bazi` —— 一段路径, 没有前缀, 没有碎片。
//
// 2026-10-28 (第 141 批): 全站地址改成**相对路径** (老板: 「**必须相对路径**」)。
//   开源用户可能把盘古挂在 nginx 的 `/pangu/` 这种**子路径**下。
//   前端只要写死一个前导斜杠 (`/api/xxx`), 挂到子路径下就全废 ——
//   浏览器会去找 `http://host/api/xxx`, 把前缀丢了。
//   ⇒ 所有站内地址一律**相对** (不带前导斜杠), 浏览器按当前文档基址解析;
//   ⇒ 路由**全部单段**: `/bazi` `/settings?tab=agent`。
//     这是硬约束, 不是风格问题 —— 页面在 `/settings/agent` 时, 相对 `themes.css`
//     会被解析成 `/settings/themes.css` ⇒ 样式全丢。单段就没有这个问题。
//
// 三条铁律:
//   1. 路由真源只有这一处 —— 谁要跳转都调 navigate(), 不许自己写 location.hash。
//   2. 视图名清单 (VIEWS) 跟服务端的白名单必须一致 (守卫逐条比对),
//      两边各写一份 = 迟早漂。
//   3. 站内地址一律相对 —— 不许出现前导斜杠 (守卫会扫源码)。

/**
 * 当前路由名 (单段, 不带斜杠): '' = 工作台, 'bazi' = 八字排盘, 'settings' = 设置。
 * 子页 (设置里的十二项、将灵详情) 走**查询参数**, 不走路径 —— 保持单段。
 */
export function currentRoute() {
  const h = location.hash || '';
  if (h.startsWith('#/')) {
    // 老链接 (#/bazi / #/settings/agent): 认, 但顺手把地址换成干净路径
    // (replaceState —— 不重载文档)
    const legacy = h.replace(/^#\/?/, '');
    try { history.replaceState(null, '', resolvePath(_legacyToPath(legacy))); } catch (_) { /* 老浏览器就算了 */ }
    return legacy.split('/')[0] || '';
  }
  const seg = location.pathname.replace(/^\/+|\/+$/g, '');
  return seg.split('/')[0] || '';
}

/** 当前路由的查询参数 (子页用: ?tab=agent / ?code=qian)。 */
export function routeParams() {
  try {
    return new URLSearchParams(location.search || '');
  } catch (_) {
    return new URLSearchParams();
  }
}

/**
 * 把一个**相对**路径解析成「相对当前文档基址」的绝对路径 + 查询串。
 *   resolvePath('bazi')            在 /bazi 上 ⇒ /bazi
 *   resolvePath('settings?tab=x')  在 /bazi 上 ⇒ /settings?tab=x
 *   resolvePath('api/version')     在 /bazi 上 ⇒ /api/version
 * 用 document.baseURI 而不是手拼 —— 前缀(反代挂载)由浏览器算, 我们不猜。
 */
export function resolvePath(path) {
  const p = String(path == null ? './' : path);
  try {
    const u = new URL(p, document.baseURI);
    return u.pathname + u.search;
  } catch (_) {
    return '/' + p.replace(/^\/+/, '');
  }
}

/**
 * 跳到某个路由。路径写法一律相对 ('bazi' / 'settings?tab=agent')。
 * 老写法 ('#/bazi' / '/bazi') 也收 —— 免得漏改的地方直接坏。
 */
export function navigate(path, replace) {
  let p = String(path == null ? './' : path);
  if (p.startsWith('#')) p = _legacyToPath(p.replace(/^#\/?/, ''));
  const target = resolvePath(p);
  if (target === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', target);
  else history.pushState(null, '', target);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

// 老的多段路由 ⇒ 新的单段 + 查询参数。
function _legacyToPath(legacy) {
  const parts = String(legacy || '').split('/').filter(Boolean);
  if (parts[0] === 'settings' && parts[1]) {
    const tab = parts[1];
    return parts[2] ? 'settings?tab=' + tab + '&code=' + parts[2] : 'settings?tab=' + tab;
  }
  return parts[0] || './';
}
