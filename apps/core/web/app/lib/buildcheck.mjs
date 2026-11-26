// lib/buildcheck.mjs —— 「我这一页是不是在跑旧模块」自检
//
// 背景 (2026-10-27, 今天咬了三次):
//   SPA 改 hash **不重载文档** ⇒ 浏览器 module registry 里留着**旧模块实例**。
//   服务端 `Cache-Control: no-store` 拦得住 HTTP 缓存, **拦不住 module registry**。
//   ⇒ 我改了代码、curl 拿到了新文件、浏览器一测还是老样子 —— 但**老板的标签页也一样老**。
//
// 这条链把「靠人记得手动刷新」变成「页面自己说」:
//   服务端 /api/pangu/webbuild 给前端代码树的内容指纹;
//   前端轮询它, 指纹变了 ⇒ 我在跑旧代码 ⇒ 顶栏挂一条「服务端有更新, 点此刷新」。
//
// 边界:
//   · 接口不存在 (老服务端) ⇒ 静默跳过, 不许把前端打挂;
//   · 轮询不许刷屏 —— 只有「指纹变了」才提示, 变了之后就不再重复提示。

const ENDPOINT = 'api/pangu/webbuild';

let _stamp = null;
let _pageStamp = null;     // 本页加载时的指纹 —— 提示条里的「本页」永远指它
let _notified = false;
let _timer = null;
let _verEl = null;

async function fetchStamp() {
  try {
    const res = await fetch(ENDPOINT, { cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    return (j && typeof j.stamp === 'string' && j.stamp) ? j.stamp : null;
  } catch (_) {
    return null;   // 老服务端没有这个接口 ⇒ 当没这回事
  }
}

/** 把指纹广播出去 —— 页脚之类的地方靠它显示「构建号」。 */
function announce(stamp) {
  try {
    document.documentElement.setAttribute('data-pangu-build', stamp);
    window.dispatchEvent(new CustomEvent('pangu:buildstamp', { detail: { stamp } }));
  } catch (_) { /* 不许因为广播失败影响主流程 */ }
}

function buildBar(newStamp, oldStamp) {
  const bar = document.createElement('div');
  bar.className = 'pg-update-bar';
  bar.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.className = 'pg-update-text';
  text.textContent = '服务端有更新, 这一页跑的是旧代码';
  bar.appendChild(text);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pg-btn pg-btn-primary';
  btn.textContent = '刷新';
  btn.addEventListener('click', () => location.reload());
  bar.appendChild(btn);
  const ver = document.createElement('span');
  ver.className = 'pg-update-ver';
  ver.textContent = '本页 ' + (_pageStamp || oldStamp || '-') + ' → 服务端 ' + newStamp;
  bar.appendChild(ver);
  _verEl = ver;
  return bar;
}

function showBar(newStamp, oldStamp) {
  if (_notified) {
    // 已经挂过了 —— 只把「服务端」那一头更新到最新, 不重复弹条
    if (_verEl) _verEl.textContent = '本页 ' + (_pageStamp || oldStamp || '-') + ' → 服务端 ' + newStamp;
    return;
  }
  _notified = true;
  const bar = buildBar(newStamp, oldStamp);
  document.body.appendChild(bar);
  requestAnimationFrame(() => bar.classList.add('is-in'));
}

/**
 * 起自检。返回 { stop(), stamp() }。
 * onChange(newStamp, oldStamp) 可以在指纹变化时额外做事 (比如记日志)。
 */
export function startBuildCheck(opts) {
  const o = opts || {};
  const intervalMs = o.intervalMs || 20000;
  const onChange = o.onChange || null;

  const tick = async () => {
    const s = await fetchStamp();
    if (!s) return;
    if (_stamp === null) { _stamp = s; _pageStamp = s; announce(s); return; }   // 第一次: 记住基线
    if (s === _stamp) return;
    const old = _stamp;
    _stamp = s;
    announce(s);
    showBar(s, old);
    if (onChange) { try { onChange(s, old); } catch (_) { /* 不许影响主流程 */ } }
  };

  tick();
  _timer = setInterval(tick, intervalMs);

  // 用户切回这个标签页时立刻查一次 —— 「回来一看还是老样子」是最高频的翻车场景
  const onVis = () => { if (document.visibilityState === 'visible') tick(); };
  document.addEventListener('visibilitychange', onVis);

  return {
    stop() {
      if (_timer) { clearInterval(_timer); _timer = null; }
      document.removeEventListener('visibilitychange', onVis);
    },
    stamp: () => _stamp,
  };
}

export function currentStamp() { return _stamp; }
