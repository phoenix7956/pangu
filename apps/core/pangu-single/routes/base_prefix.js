// base_prefix.js —— 反代前缀 (第 141 批: 前端全用相对路径)
//
// 为什么要有这个: 前端改成**相对路径**之后, 它不再知道自己是挂在域名根上还是
//   挂在 `/pangu/` 这种子路径下 —— 浏览器会按当前文档基址自动补前缀。
//   于是前缀这件事就落到服务端: nginx 不剥前缀时, 用
//     proxy_set_header X-Forwarded-Prefix /pangu;
//   告诉盘古「我住在哪个前缀下」, 服务端把前缀摘掉再路由。
//   nginx 剥前缀 (proxy_pass 末尾带 /) 时不用这个头, 也照样能跑。
//
// 边界: 只认 `/` 开头、只含字母数字与 `-._~` 的短前缀; 不认就当没有 (宁可不做,
//   也不让一个畸形头把路由带沟里)。

const MAX_PREFIX_LEN = 120;

function normalize(raw) {
  const s = String(raw || '').trim();
  if (!s || s === '/') return '';
  if (s.length > MAX_PREFIX_LEN) return '';
  if (!/^\/[A-Za-z0-9._~\/-]*$/.test(s)) return '';
  const p = s.replace(/\/+$/, '');
  if (!p || p.includes('//') || p.includes('/../') || p.includes('/./')) return '';
  return p;
}

/**
 * 把 req.url 里的反代前缀摘掉, 并把前缀记在 req 上 (重定向时要用它加回去)。
 * @returns {string} 实际生效的前缀 (没有就是空串)
 */
function strip(req) {
  const prefix = normalize(req && req.headers && req.headers['x-forwarded-prefix']);
  if (!prefix) return '';
  const url = String((req && req.url) || '/');
  const qi = url.indexOf('?');
  const pathname = qi >= 0 ? url.slice(0, qi) : url;
  if (pathname !== prefix && !pathname.startsWith(prefix + '/')) return '';
  const rest = pathname.slice(prefix.length) || '/';
  req.url = rest + (qi >= 0 ? url.slice(qi) : '');
  req._panguPrefix = prefix;
  return prefix;
}

/** 当前请求生效的前缀 (重定向的 Location 要带上它)。 */
function of(req) {
  return (req && req._panguPrefix) || '';
}

module.exports = { strip, of, normalize };
