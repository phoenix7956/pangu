// util.mjs —— 几个共用的小工具 (不做依赖, 不引框架)。
//
// 2026-10-27 (第 117 批): 补格式化/小部件, 供整套 UI 各页共用。
import { icon, iconHTML } from './icons.mjs';
import { TRIGRAM_BITS, TRIGRAM_WX } from './yao.mjs';

export { icon, iconHTML };

export function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) for (const k of Object.keys(attrs)) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (k === 'text') e.textContent = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  if (children) for (const c of [].concat(children)) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' || typeof c === 'number'
      ? document.createTextNode(String(c)) : c);
  }
  return e;
}

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 爻柱 (设计系统零件 .pg-yao) —— 阳爻一整条, 阴爻断成两截, **自上爻往下画**。
 *
 * 为什么住在零件工厂里: 爻柱是盘古的签名元素 (第 149 批), 全站只有这一处画法 ——
 * 六十四卦页的大柱/三画柱、详情页的大卦象、首屏焦点面板的微型卦盘都走它。
 * 再各画各的, 就又回到「六十四卦像易经, 别的页像后台」。
 *
 * @param {string} binary 六位 1/0 (1 = 阳), 自初爻起 —— 没数据就整柱按阳画
 * @param {string} [cls]  尺寸规格 (.pg-yao-lg / .pg-yao-tri / .pg-yao-micro)
 * @param {number} [count] 画几爻 (6 = 六爻卦, 3 = 三画卦)。自上爻往下画。
 */
export function yaoColumn(binary, cls, count) {
  const box = el('span', { class: 'pg-yao' + (cls ? ' ' + cls : '') });
  const b = String(binary || '');
  const n = count || 6;
  for (let i = n - 1; i >= 0; i--) {
    const yang = b.length === n ? b[i] === '1' : true;
    const line = el('span', { class: 'pg-yao-l' + (yang ? '' : ' is-yin') });
    line.appendChild(el('i'));
    if (!yang) line.appendChild(el('i'));
    box.appendChild(line);
  }
  return box;
}

/**
 * 卦印 (第 161 批) —— 盘古的身份图形: 三爻柱 (八卦) + 卦名, 一个 26px 的方章。
 *
 * 为什么不用 Unicode 卦符 (☰ ☵ …): 那些是**字体符号**, 各系统字形不同、
 * 放大发虚、不能跟主题走。爻柱走 .pg-yao (全站唯一画法) 才是真的图形。
 * 卦名印在章下 ⇒ 一眼知道「这是哪一卦」, 不用回去查代码。
 *
 * @param {string} gua 卦名 (乾 坎 离 坤 兑 巽 震 艮)
 * @param {boolean} [live] 是否运行中 (点亮)
 */
export function guaSeal(gua, live) {
  const box = el('span', { class: 'pg-gua-seal' + (live ? ' is-live' : '') });
  const bits = TRIGRAM_BITS[gua];
  if (bits) {
    // 三画卦, 自上爻往下画 (跟六十四卦页的 trigramColumn 一个画法)。
    const col = el('span', { class: 'pg-yao' });
    for (let i = 2; i >= 0; i--) {
      const line = el('span', { class: 'pg-yao-l' + (bits[i] === '1' ? '' : ' is-yin') });
      line.appendChild(el('i'));
      if (bits[i] !== '1') line.appendChild(el('i'));
      col.appendChild(line);
    }
    box.appendChild(col);
  }
  // 2026-11-04 (颜色对照): 卦名染**五行墨色** (乾兑金/离火/震巽木/坎水/艮坤土),
  // 跟八字/梅花/六十四卦页同一套语言 —— 将灵八位按五行一眼分堆。
  // 运行中 (is-live) 仍压成主色: 「活着」的信号优先于五行。
  const wx = TRIGRAM_WX[gua];
  box.appendChild(el('b', { class: wx ? 'pg-wxg pg-wxg-' + wx : '' }, gua || ''));
  return box;
}

/**
 * 微型卦象 (第 161 批) —— 只有三爻柱, 没有卦名。
 *
 * 用在**名字已经在旁边**的地方 (聊天活动行: 图标位 + 右边一行「乾 · 调度」)。
 * 这时候再印一遍卦名是重复。
 */
export function guaMark(gua) {
  const bits = TRIGRAM_BITS[gua];
  const box = el('span', { class: 'pg-yao' });
  if (!bits) return box;
  for (let i = 2; i >= 0; i--) {
    const line = el('span', { class: 'pg-yao-l' + (bits[i] === '1' ? '' : ' is-yin') });
    line.appendChild(el('i'));
    if (bits[i] !== '1') line.appendChild(el('i'));
    box.appendChild(line);
  }
  return box;
}

/** 建一个元素并把一串 HTML 塞进去 (比如 iconHTML 的 <svg>)。 */
export function elHTML(tag, attrs, html) {
  const e = el(tag, attrs);
  e.innerHTML = html == null ? '' : String(html);
  return e;
}

export async function json(url, opts) {
  const res = await fetch(url, opts);
  const j = await res.json().catch(() => ({ ok: false, error: 'HTTP ' + res.status }));
  if (!j || j.ok === false) throw new Error((j && (j.error || j.hint)) || ('HTTP ' + res.status));
  return j;
}

/** 写操作: POST / PUT / DELETE 都走它。ok:false 一样当错抛。 */
export async function send(url, body, method) {
  const res = await fetch(url, {
    method: method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({ ok: false, error: 'HTTP ' + res.status }));
  if (!res.ok || !j || j.ok === false) {
    const e = j && (j.error || j.hint || j.message);
    const msg = e && typeof e === 'object' ? (e.message || JSON.stringify(e)) : e;
    throw new Error(msg || ('HTTP ' + res.status));
  }
  return j;
}

export function card(title, hintText, children) {
  // 第 147 批: card() 只是 section() 的别名 —— 全站**只有一种区块**,
  // 别名保留是为了不改所有调用方 (card/section 二选一即可)。
  return section(title, hintText, children);
}

// ── 设计系统零件 (第 147 批) ──────────────────────────────────────
//
// 「一套完整的 UI」不是靠每个页面各写各的 CSS, 而是**所有页面生成同一种 DOM**。
// 这一段是全站页面的零件工厂: 页面只管往里塞内容, 结构由这里统一。
// 零件清单见 app/design-system.css 的文件头 (守卫会钉住它)。

/** 页面外壳。页面的根节点一律是它 —— 换页不跳宽、不跳内缩。 */
export function page() {
  return el('div', { class: 'pg-page' });
}

/** 页头 (宋体大标题 + 一句说明)。只给「子页面」用 (设置页的某个档)。 */
export function pageHead(title, desc) {
  const h = el('div', { class: 'pg-page-head' });
  h.appendChild(el('h1', {}, title));
  if (desc) h.appendChild(el('p', {}, desc));
  return h;
}

/**
 * 页头 + 右侧动作区 (第 170 批) —— 页面级动作 (保存/刷新/新建) 有一个**家**:
 * 页头右上角。以前每页各找各的 (设置页浮在右下角、自动化塞在区块里)。
 */
export function pageHeadRow(title, desc, actions) {
  const h = el('div', { class: 'pg-page-head is-row' });
  const main = el('div', { class: 'pg-page-head-main' });
  main.appendChild(el('h1', {}, title));
  if (desc) main.appendChild(el('p', {}, desc));
  h.appendChild(main);
  if (actions) {
    const a = el('div', { class: 'pg-page-head-actions' });
    for (const x of [].concat(actions)) if (x) a.appendChild(x);
    h.appendChild(a);
  }
  return h;
}

/**
 * 表单网格 (第 170 批) —— 全站表单只有一种排法:
 * 标签在上、控件在下, 列数自适应。opts.cols = 2 | 3 固定列数。
 */
export function formGrid(children, opts) {
  const o = opts || {};
  const g = el('div', { class: 'pg-form-grid' + (o.cols ? ' is-' + o.cols : '') });
  for (const x of [].concat(children || [])) if (x) g.appendChild(x);
  return g;
}

/**
 * 表单横排行 (第 170 批) —— 左标签 (120px) 右控件。
 * 用于「一栏一行的读数式表单」 (连接地址、路径、开关)。
 */
export function formRow(label, control) {
  const r = el('div', { class: 'pg-form-row' });
  r.appendChild(el('span', { class: 'pg-label' }, label));
  r.appendChild(control);
  return r;
}

/**
 * 分类竖列 (第 170 批) —— 设置页的 12 个分类改成左边一列 (主流 agent 的做法)。
 * items = [{ id, label, icon?, count? }]
 */
export function catnav(items, active, onPick) {
  const nav = el('nav', { class: 'pg-catnav' });
  for (const it of items || []) {
    if (!it) continue;
    const b = el('button', {
      class: 'pg-catnav-item' + (it.hint ? ' is-two' : '') + (it.id === active ? ' on' : ''),
      type: 'button',
    });
    if (it.icon) b.appendChild(elHTML('span', { class: 'pg-catnav-ico' }, it.icon));
    const txt = el('span', { class: 'pg-catnav-text' });
    txt.appendChild(el('span', { class: 'pg-catnav-label' }, it.label));
    if (it.hint) txt.appendChild(el('span', { class: 'pg-catnav-sub' }, it.hint));
    b.appendChild(txt);
    if (it.count != null) b.appendChild(el('span', { class: 'pg-catnav-count' }, String(it.count)));
    if (it.action) b.appendChild(it.action);
    b.addEventListener('click', () => onPick && onPick(it.id));
    nav.appendChild(b);
  }
  return nav;
}

/**
 * 区块 (= 一张卡片)。title 是宋体/无衬线标题, hint 是右侧的弱化计数,
 * actions 是右侧的动作区 (按钮)。三段式, 全站每个区块都是这个结构。
 */
export function section(title, hintText, children, actions) {
  const c = el('div', { class: 'pg-card' });
  if (title) {
    const h = el('div', { class: 'pg-card-header' });
    h.appendChild(el('span', {}, title));
    if (hintText) h.appendChild(el('span', { class: 'hint' }, hintText));
    if (actions) {
      const a = el('div', { class: 'pg-card-actions' });
      for (const x of [].concat(actions)) if (x) a.appendChild(x);
      h.appendChild(a);
    }
    c.appendChild(h);
  }
  // 体**永远存在** —— 页面常常要往里再塞东西 (读卦面板就是这么干的)。
  //   挂在 .body 上, 页面不用自己去 querySelector 找壳的内层。
  const b = el('div', { class: 'pg-card-body' });
  if (children) for (const x of [].concat(children || [])) if (x) b.appendChild(x);
  c.appendChild(b);
  c.body = b;
  return c;
}

/** 无边框的区块体 (表格/清单自己带边, 不需要再套一层内缩)。 */
/**
 * 可重画的卡片 (第 170 批) —— 面板每点一次换一次内容 (六十四卦的读卦面板)。
 *
 * 普通 card() 建出来的壳是一次性的: 换内容只能整个重建, 于是页面开始
 * 自己拼 `pg-card-header` / `pg-card-body` —— 那就是手搓壳了。
 * 这里返回 { root, head, body }: 壳建一次, 换内容时只清 head/body。
 */
export function cardPanel(cls) {
  const root = el('div', { class: 'pg-card' + (cls ? ' ' + cls : '') });
  const head = el('div', { class: 'pg-card-header' });
  const body = el('div', { class: 'pg-card-body' });
  root.appendChild(head);
  root.appendChild(body);
  root.head = head;
  root.body = body;
  return root;
}

export function sectionFlush(title, hintText, children, actions) {
  const c = section(title, hintText, null, actions);
  if (c.body) c.body.remove();
  const b = el('div', { class: 'pg-card-body is-flush' });
  if (children) for (const x of [].concat(children || [])) if (x) b.appendChild(x);
  c.appendChild(b);
  c.body = b;
  return c;
}

/**
 * 扁平分区 (第 160 批) —— 状态 / 将灵 / 工具集 / 自动化 这些页的区块。
 *
 * 跟 section() 的区别只有一条, 但那一条是**整个界面气质**的区别:
 *   section()  = 一张有边框的卡片 (框住的东西: 表单 / 卦格 / 浮层内容)
 *   flatSection() = 一行标题 + 一根发丝线 + 内容 (数据 / 清单)
 *
 * 装的是读数和清单的区块, 不该套一个框 —— 一屏五个框, 界面就成了
 * 后台管理系统; 一屏五根线, 界面才像一台开着的仪器。
 */
/**
 * 区块壳 (HTML **字符串**版) —— 第 170 批。
 *
 * 八字 / 梅花 / 六十四卦这三页的整页是**一段 innerHTML 模板**。
 * 模板里直接写 `<div class="pg-section">…</div>` 等于把区块壳抄了一遍 ——
 * 壳归设计系统, 页面只提供内容。这两个工厂把壳收到 util 里,
 * 页面里就只剩内容 (和工厂的一个参数)。
 *
 * opts: { id, hint (文字), hintHtml (原样 html), bodyClass, cls }
 */
export function sectionHtml(title, bodyHtml, opts) {
  const o = opts || {};
  const idAttr = o.id ? ' id="' + esc(o.id) + '"' : '';
  let head = '';
  if (title || o.hint || o.hintHtml) {
    head = '<div class="pg-section-head">'
      + (title ? '<span class="pg-section-title">' + esc(title) + '</span>' : '')
      + (o.hint ? '<span class="pg-section-hint">' + esc(o.hint) + '</span>' : '')
      + (o.hintHtml || '')
      + '</div>';
  }
  const bodyClass = o.bodyClass ? ' ' + o.bodyClass : '';
  return '<div class="pg-section"' + idAttr + '>' + head
    + '<div class="pg-section-body' + bodyClass + '">' + (bodyHtml || '') + '</div></div>';
}

/** 卡片壳 (HTML 字符串版) —— 同上, 有框的那一种。 */
export function cardHtml(title, bodyHtml, opts) {
  const o = opts || {};
  const idAttr = o.id ? ' id="' + esc(o.id) + '"' : '';
  const cls = 'pg-card' + (o.cls ? ' ' + o.cls : '');
  let head = '';
  if (title || o.hint || o.hintHtml) {
    head = '<div class="pg-card-header"><span>' + esc(title || '') + '</span>'
      + (o.hint ? '<span class="hint">' + esc(o.hint) + '</span>' : '')
      + (o.hintHtml || '')
      + '</div>';
  }
  const bodyClass = o.bodyClass ? ' ' + o.bodyClass : '';
  return '<div class="' + cls + '"' + idAttr + '>' + head
    + '<div class="pg-card-body' + bodyClass + '">' + (bodyHtml || '') + '</div></div>';
}

export function flatSection(title, hintText, children, actions) {
  const s = el('div', { class: 'pg-section' });
  if (title || hintText || actions) {
    const h = el('div', { class: 'pg-section-head' });
    if (title) h.appendChild(el('span', { class: 'pg-section-title' }, title));
    if (hintText) h.appendChild(el('span', { class: 'pg-section-hint' }, hintText));
    if (actions) {
      const a = el('div', { class: 'pg-section-actions' });
      for (const x of [].concat(actions)) if (x) a.appendChild(x);
      h.appendChild(a);
    }
    s.appendChild(h);
  }
  if (children) {
    const b = el('div', { class: 'pg-section-body' });
    for (const x of [].concat(children || [])) if (x) b.appendChild(x);
    s.appendChild(b);
  }
  return s;
}

/**
 * 读数条 (第 160 批) —— 一行「标签在上 / 值在下」的读数, 项间一根竖发丝线。
 *
 * 跟磁贴 (.pg-tiles) 的区别: 磁贴是**网格**, 数量一多就排不满
 * (七项在 5 列里排成 5 + 2, 右边空一块); 读数条是**流式**的,
 * 宽了自然换行, 永远不留洞。
 *
 * items = [{ k, v, cls }]
 */
export function readout(items) {
  const row = el('div', { class: 'pg-readout' });
  for (const it of items || []) {
    if (!it) continue;
    const cell = el('div', { class: 'pg-readout-item' });
    cell.appendChild(el('span', { class: 'pg-readout-k' }, it.k));
    const v = el('span', { class: 'pg-readout-v' + (it.cls ? ' ' + it.cls : '') });
    if (it.v instanceof Node) v.appendChild(it.v);
    else v.textContent = it.v == null || it.v === '' ? '—' : String(it.v);
    cell.appendChild(v);
    row.appendChild(cell);
  }
  return row;
}

/**
 * 页尾收口带 (第 150 批) —— 内容页最后一张卡下面的那条线。
 * stats = [{k, v}], 右边一行等宽微字。没有 stats 就只有右侧时间戳。
 */
export function footband(stats, endText) {
  const f = el('div', { class: 'pg-footband' });
  for (const s of stats || []) {
    if (!s) continue;
    const cell = el('span', { class: 'pg-footband-stat' });
    if (s.k) cell.appendChild(el('b', {}, s.k));
    if (s.v != null && s.v !== '') {
      const v = el('span', {});
      if (s.v instanceof Node) v.appendChild(s.v);
      else v.textContent = String(s.v);
      cell.appendChild(v);
    }
    f.appendChild(cell);
  }
  if (endText) f.appendChild(el('span', { class: 'pg-footband-end' }, endText));
  return f;
}

/**
 * 数字磁贴组。items = [{k: 标签, v: 值, h: 提示, cls: 值的状态类}]
 * 值可以是 Node。**标签在上 / 值在中 / 提示在下** 三行固定。
 */
export function tiles(items) {
  const box = el('div', { class: 'pg-tiles' });
  for (const it of items || []) {
    if (!it) continue;
    const t = el('div', { class: 'pg-tile' + (it.wide ? ' is-wide' : '') });
    if (it.k) {
      // k 也收 Node (2026-11-04: 状态页八将灵磁贴要染卦名五行色)
      const k = el('span', { class: 'pg-tile-k' });
      if (it.k instanceof Node) k.appendChild(it.k);
      else k.textContent = String(it.k);
      t.appendChild(k);
    }
    if (it.v != null && it.v !== '') {
      const v = el('span', { class: 'pg-tile-v' + (it.cls ? ' ' + it.cls : '') });
      if (it.v instanceof Node) v.appendChild(it.v);
      else v.textContent = String(it.v);
      t.appendChild(v);
    }
    if (it.h) {
      const h = el('span', { class: 'pg-tile-h' });
      if (it.h instanceof Node) h.appendChild(it.h);
      else h.textContent = String(it.h);
      t.appendChild(h);
    }
    box.appendChild(t);
  }
  return box;
}

/** 清单行 (工具集/将灵/角色 共用)。 */
export function listRow(opts) {
  const o = opts || {};
  const r = el('div', { class: 'pg-list-row' });
  if (o.icon) {
    const i = el('span', { class: 'pg-list-ico' });
    i.innerHTML = o.icon;
    r.appendChild(i);
  }
  if (o.title != null || o.desc != null) {
    const m = el('div', { class: 'pg-list-main' });
    if (o.title != null) m.appendChild(el('div', { class: 'pg-list-title' }, o.title));
    if (o.desc != null) m.appendChild(el('div', { class: 'pg-list-desc' }, o.desc));
    r.appendChild(m);
  }
  if (o.extra) r.appendChild(o.extra);
  if (o.actions) {
    const a = el('div', { class: 'pg-list-actions' });
    for (const x of [].concat(o.actions)) if (x) a.appendChild(x);
    r.appendChild(a);
  }
  return r;
}

/** 清单容器。 */
export function list(children) {
  const box = el('div', { class: 'pg-list' });
  for (const x of [].concat(children || [])) if (x) box.appendChild(x);
  return box;
}

// ── 格式化 ────────────────────────────────────────────────────────

/** 时间戳 → HH:MM:SS (消息页脚用)。 */
export function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 时间戳 → YYYY-MM-DD HH:MM (历史档案用)。 */
export function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 毫秒 → 「1.2s」/「3m 04s」/「2h 11m」。 */
export function fmtDur(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return Math.round(n) + 'ms';
  if (n < 60000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 's';
  const m = Math.floor(n / 60000);
  const s = Math.floor((n % 60000) / 1000);
  if (m < 60) return m + 'm ' + String(s).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}

/** 字节 → 「15 KB」。 */
export function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1024) return v + ' B';
  if (v < 1048576) return (v / 1024).toFixed(0) + ' KB';
  return (v / 1048576).toFixed(1).replace(/\.0$/, '') + ' MB';
}

/** 数字加千分位。 */
export function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return v.toLocaleString('en-US');
}

// ── 小部件 ────────────────────────────────────────────────────────

/**
 * 一行「标签 + 值」 (.pg-kv-row)。cls 落在**行**上, valCls 落在**值**上
 * (值常用 mono —— 路径/编号/哈希这类该用等宽的东西)。
 */
export function kv(label, value, cls, valCls) {
  const w = el('div', { class: 'pg-kv-row' + (cls ? ' ' + cls : '') });
  w.appendChild(el('span', { class: 'pg-kv-k' }, label));
  const v = el('span', { class: 'pg-kv-v' + (valCls ? ' ' + valCls : '') });
  if (value instanceof Node) v.appendChild(value);
  else v.textContent = value == null ? '—' : String(value);
  w.appendChild(v);
  return w;
}

/** 字段行清单 (多个 kv 竖排, 行间一根发丝线)。 */
export function kvList(items) {
  const box = el('div', { class: 'pg-kv-list' });
  for (const x of [].concat(items || [])) if (x) box.appendChild(x);
  return box;
}

/** 徽标。 */
export function badge(text, kind) {
  return el('span', { class: 'pg-badge' + (kind ? ' pg-badge-' + kind : '') }, text);
}

/** 输入框 (带 label 的竖排一组)。 */
export function field(label, value, opts) {
  const o = opts || {};
  const w = el('label', { class: 'pg-field' });
  if (label) w.appendChild(el('span', { class: 'pg-label' }, label));
  const i = el(o.multiline ? 'textarea' : 'input', {
    class: 'pg-input' + (o.multiline ? ' pg-textarea' : ''),
    type: o.type || 'text',
    placeholder: o.placeholder || '',
  });
  if (o.multiline) i.value = value == null ? '' : String(value);
  else i.value = value == null ? '' : String(value);
  if (o.disabled) i.disabled = true;
  w.appendChild(i);
  w.input = i;
  return w;
}

/** 表格: heads 是列名数组, rows 是二维数组 (元素可以是 Node)。 */
export function table(heads, rows, emptyText) {
  // 第 147 批: 统一到设计系统的 `.pg-table` —— 全站只有一种表的画法。
  // 以前这里是 `.t` (styles.css 里另有一套: 表头 12px/500 + 发丝线),
  // 八字页、设置页又各有自己的表 ⇒ 三种表格并排, 一眼就是"拼的"。
  const t = el('table', { class: 'pg-table' });
  const thead = el('thead');
  const tr = el('tr');
  for (const h of heads) {
    const th = el('th', typeof h === 'object' && h && h.width ? { style: 'width:' + h.width } : null, h);
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  t.appendChild(thead);
  const tb = el('tbody');
  for (const row of rows) {
    const r = el('tr');
    for (const c of row) {
      // 单元格可以是 字符串 / Node / {v: 值, cls: 类名}
      const desc = (c && typeof c === 'object' && !(c instanceof Node)) ? c : { v: c };
      const td = el('td', desc.cls ? { class: desc.cls } : null);
      if (desc.v instanceof Node) td.appendChild(desc.v);
      else td.textContent = desc.v == null ? '' : String(desc.v);
      r.appendChild(td);
    }
    tb.appendChild(r);
  }
  if (!rows.length) {
    const r = el('tr');
    r.appendChild(el('td', { colspan: String(heads.length), class: 'hint' }, emptyText || '暂无'));
    tb.appendChild(r);
  }
  t.appendChild(tb);
  return t;
}

/** 轻提示 (右上角飘一条)。 */
let toastHost = null;
export function toast(msg, bad) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-host' });
    document.body.appendChild(toastHost);
  }
  const t = el('div', { class: 'toast' + (bad ? ' toast-bad' : '') }, msg);
  toastHost.appendChild(t);
  setTimeout(() => { t.classList.add('is-out'); }, 2600);
  setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 3100);
}

/** 一段说明文字。 */
export function hint(text) {
  return el('div', { class: 'hint' }, text);
}

/** 分段控件 (设置页的「档」)。 */
export function segmented(items, active, onPick) {
  const box = el('div', { class: 'pg-seg' });
  for (const it of items) {
    const b = el('button', {
      class: 'pg-seg-i' + (it.id === active ? ' on' : ''),
      type: 'button',
      title: it.hint || '',
    }, it.name);
    b.addEventListener('click', () => onPick(it.id));
    box.appendChild(b);
  }
  return box;
}
