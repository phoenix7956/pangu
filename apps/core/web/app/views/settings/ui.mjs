// settings/ui.mjs —— 设置 · 界面
//
// 从原版 `apps/desktop/src/views/settings/UI.jsx` (git 110661d^) 搬过来。
// 主题切换是**真的**能用的 (写 localStorage + 换 data-theme);
// 原版里那些「尚未接入」的项这里照旧禁用 —— 摆一个能点但不生效的开关比不摆更糟。

import { el, elHTML, page, toast, flatSection } from '../../lib/util.mjs';
import { toggle, slider, actionBar } from '../../components/settings-widgets.mjs';

const THEMES = [
  // 2026-10-28 第 138 批: 主题卡的角标原来用 emoji (☀️🟡🌙) —— 字形各平台不一样,
  //   也不跟主题色。改成矢量图标 (颜色随 currentColor)。
  // 第 149 批: 换成盘古自己的三种纸。preview/border/fg 是**色卡预览的取色**,
 //   必须跟 themes.css 里的真实值同源 (否则预览跟切完长得不一样)。
 // 2026-11-18 铁灰: 中性灰主题 —— 浅灰画布 + 深灰壳, 跟墨盘是同一套灰的深浅两端。
 // mini 字段: 主题卡里那个 22px 微爻柱 (浅深两档色) 的取色, 同样跟 themes.css 同源。
  { id: 'dark', name: '墨盘', icon: 'moon', desc: '默认 · 冷墨夜盘', preview: '#101110', border: '#282B28', fg: '#56A992', mini: '#E9EBED' },
  { id: 'gold', name: '铜夜', icon: 'sparkles', desc: '盘古专属 · 暖铜', preview: '#14130C', border: '#383528', fg: '#D9BA70', mini: '#ECE7D8' },
  { id: 'light', name: '宣纸', icon: 'sun', desc: '白天 · 冷素纸', preview: '#F1F1ED', border: '#DADBD4', fg: '#2F6F60', mini: '#1A1C1E' },
  { id: 'iron', name: '铁灰', icon: 'halfmoon', desc: '中性灰 · 浅灰底深灰壳', preview: '#E4E6E8', border: '#1D1F22', fg: '#3A3E44', mini: '#1D1F22' },
];

const ACCENTS = [
  { id: 'blue', name: '青蓝', color: '#3B82F6', light: '#2563EB' },
  { id: 'purple', name: '紫', color: '#8B5CF6', light: '#7C3AED' },
  { id: 'green', name: '翠', color: '#34D399', light: '#059669' },
  { id: 'gold', name: '暗金', color: '#c9a84c', light: '#B58E2E' },
  { id: 'red', name: '朱', color: '#F87171', light: '#DC2626' },
];

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { return {}; }
}

/**
 * 主题卡的微爻柱 —— 盘古自己的签名元素 (全站只有 util 这一处画法),
 * 2026-11-18: 色卡上原来摆的是通用图标 (月亮/太阳), 四张卡排开就像四张
 * 系统默认主题卡 —— 陋就陋在这。爻柱换成三画卦 (乾: 三阳, 阴爻断口用
 * 画布色透出), 每张卡一眼就是「盘古的盘」。
 * @param {string} canvas 色卡画布色 (= preview, 阴爻断口透出来的就是它)
 * @param {string} yao    爻柱色 (= mini, 跟 themes.css 同源的 text-strong)
 */
function miniYao(canvas, yao) {
  const box = el('span', { class: 'pg-theme-mini', html: '' });
  const lines = [1, 1, 1]; // 乾: 三阳。阳爻一整条, 阴爻断两截。
  for (const yang of lines) {
    const line = el('span', { class: 'pg-theme-mini-l' + (yang ? '' : ' is-yin') });
    line.appendChild(el('i'));
    if (!yang) line.appendChild(el('i'));
    box.appendChild(line);
  }
  box.style.setProperty('--mini-canvas', canvas);
  box.style.setProperty('--mini-yao', yao);
  return box;
}

export async function render(root) {
  // 第 147 批: 页根 = 设计系统的页面外壳 `.pg-page` (全站页面外壳统一)。
  const host = page();
  host.classList.add('pg-settings-col');
  root.appendChild(host);

  const saved = readJson('pangu.ui');
  let theme = 'dark';
  try { theme = localStorage.getItem('pangu.ui.theme') || 'dark'; } catch (e) { /* 隐私模式 */ }
  let fontSize = Number(saved.fontSize) || 14;
  let dirty = false;

  /**
   * 全局字号倍率。
   * 第 148 批: 原来这里写的是 `document.documentElement.style.fontSize = v + 'px'`
   *   —— 而全站**一个 rem 都没用** (字号全是 px 令牌), 那个滑块**拖了没反应**,
   *   是个纯装饰的死控件。现在改成真倍率: `--ui-scale` 乘进每一个字号令牌。
   *   滑块的读数 = 正文基准字号 (14 ⇒ 倍率 1), 全站按同一比例缩放,
   *   层级差 (26/20/17/14/12/11) 保持不变。
   */
  const applyScale = (v) => {
    const n = Number(v) || 14;
    document.documentElement.style.setProperty('--ui-scale', String(n / 14));
  };

  const applyTheme = (id) => {
    theme = id;
    document.documentElement.setAttribute('data-theme', id);
    try {
      localStorage.setItem('pangu.ui.theme', id);
      localStorage.setItem('pangu.ui.theme.ver', '149');
    } catch (e) { /* 隐私模式 */ }
  };

  const paint = () => {
    host.innerHTML = '';

    /* 主题 */
    const b1 = el('div', {});
    b1.appendChild(el('div', { class: 'pg-hint' }, '墨盘是默认 (冷墨夜盘) · 铜夜偏暖 · 宣纸给白天用 · 铁灰是中性的浅灰底 + 深灰壳'));
    const grid = el('div', { class: 'pg-theme-grid' });
    THEMES.forEach((t, i) => {
      const on = theme === t.id;
      const b = el('button', { class: 'pg-theme-card' + (on ? ' on' : ''), type: 'button' });
      // 2026-11-18: 色卡中心从「通用矢量图标」换成「盘古微爻柱」。
      // 爻柱色跟色卡画布色都要显式给 —— 四张卡四套取色, 不能靠 currentColor。
      const sw = el('div', { class: 'pg-theme-swatch' });
      sw.appendChild(miniYao(t.preview, t.mini));
      sw.style.background = t.preview;
      sw.style.borderColor = t.border;
      b.appendChild(sw);
      const nm = el('div', { class: 'pg-theme-name' });
      // ①②③④ 是主题顺序编号 (第 149 批起的约定: 默认主题排第一)
      const rankGlyphs = ['①', '②', '③', '④'];
      nm.appendChild(el('span', { class: 'pg-theme-rank' + (i === 1 ? ' gold' : '') }, rankGlyphs[i] || ''));
      nm.appendChild(el('span', {}, t.name));
      b.appendChild(nm);
      b.appendChild(el('div', { class: 'pg-theme-desc' }, t.desc));
      b.addEventListener('click', () => { applyTheme(t.id); paint(); });
      grid.appendChild(b);
    });
    b1.appendChild(grid);
    const cur = el('div', { class: 'pg-hint' });
    cur.appendChild(document.createTextNode('当前主题: '));
    cur.appendChild(el('b', { class: 'pg-accent-text' }, (THEMES.find((t) => t.id === theme) || {}).name || theme));
    b1.appendChild(cur);
    host.appendChild(flatSection('主题', null, b1));

    /* 强调色 (未接入) */
    const b2 = el('div', {});
    const accents = el('div', { class: 'pg-accent-grid' });
    for (const a of ACCENTS) {
      const cell = el('div', { class: 'pg-accent-cell is-off' });
      const dot = el('div', { class: 'pg-accent-dot' });
      dot.style.background = theme === 'light' ? a.light : a.color;
      cell.appendChild(dot);
      cell.appendChild(el('div', { class: 'pg-accent-name' }, a.name));
      accents.appendChild(cell);
    }
    b2.appendChild(accents);
    b2.appendChild(el('div', { class: 'pg-hint' }, '强调色尚未接入运行时, 已禁用。'));
    host.appendChild(flatSection('强调色', null, b2));

    /* 字体 */
    const b3 = el('div', {});
    b3.appendChild(slider(fontSize, (v) => {
      fontSize = v;
      dirty = true;
      applyScale(v);
      repaintBar();
    }, 11, 20, 1, '正文基准字号', 'px', '全站字号按这个比例一起缩放 (层级差不变)'));
    const famWrap = el('div', { class: 'pg-field' });
    famWrap.appendChild(el('span', { class: 'pg-label' }, '字体族'));
    const sel = el('select', { class: 'pg-input is-disabled' });
    for (const [v, n] of [['system', '系统默认 (SF / 苹方)'], ['pingfang', '苹方'], ['mono', '等宽 (SF Mono)'], ['serif', '宋体 (Serif)']]) {
      const o = el('option', { value: v }, n);
      sel.appendChild(o);
    }
    sel.disabled = true;
    famWrap.appendChild(sel);
    b3.appendChild(famWrap);
    b3.appendChild(el('div', { class: 'pg-hint' }, '字体族尚未接入运行时, 已禁用。'));
    host.appendChild(flatSection('字体', null, b3));

    /* 布局 */
    const b4 = el('div', {});
    b4.appendChild(toggle(!!saved.compact, () => {}, '紧凑模式', '尚未接入, 当前不会改变布局', true));
    b4.appendChild(toggle(saved.showGold !== false, () => {}, '暗金高亮', '尚未接入, 当前不会改变界面颜色', true));
    b4.appendChild(toggle(saved.anim !== false, () => {}, '动画', '尚未接入, 当前不会改变动效', true));
    b4.appendChild(el('div', { class: 'pg-hint' }, '强调色、字体族和布局选项暂未接入运行时, 已禁用, 避免保存后产生误导。'));
    host.appendChild(flatSection('布局', null, b4));

    repaintBar();
  };

  let bar = null;
  const repaintBar = () => {
    if (bar) bar.remove();
    bar = actionBar(async () => {
      const prev = readJson('pangu.ui');
      try {
        localStorage.setItem('pangu.ui', JSON.stringify({ ...prev, fontSize }));
        localStorage.setItem('pangu.ui.theme', theme);
      } catch (e) { /* 隐私模式 */ }
      applyScale(fontSize);
      toast('已保存');
      dirty = false;
      repaintBar();
    }, false, dirty);
  };

  paint();
  return {};
}

export default render;
