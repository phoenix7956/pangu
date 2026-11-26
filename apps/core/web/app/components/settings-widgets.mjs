// components/settings-widgets.mjs —— 设置页通用部件
//
// 从原版 `apps/desktop/src/views/settings/_widgets.jsx` (git 110661d^) 搬过来。
// 原版是 React 组件, 这里翻成返回 DOM 节点的普通函数。
//
// 第 147 批: 这里原来还有第三套磁贴 (状态卡) —— 状态页一套、设置页一套、
// 历史档案又一套, 三页三种画法。现在**磁贴只有设计系统的 `.pg-tile`**,
// 由 `lib/util.mjs` 的 `tiles()` 工厂造, 这个文件不再自己造磁贴。
//
// 2026-10-29: 文件从 `views/settings/_widgets.mjs` 挪到 `components/`。
//   它不是"一个页面", 是一组**零件** —— 跟 components/session-sidebar.mjs、
//   components/permission-popover.mjs 是同一类东西。放在 views/ 底下会被
//   "每个视图模块都得有自己的页面外壳"那条守卫当成一个没有页面的视图,
//   逼着它写一个假的页面根出来。零件就该待在零件该待的地方。

import { el, iconHTML } from '../lib/util.mjs';
import { getPageActionHost } from '../lib/page-actions.mjs';

/** 开关 (原版 Toggle)。 */
export function toggle(checked, onChange, label, desc, disabled) {
  const row = el('div', { class: 'pg-toggle-row' + (disabled ? ' is-disabled' : '') });
  const left = el('div', { class: 'pg-toggle-text' });
  left.appendChild(el('div', { class: 'pg-toggle-label' }, label));
  if (desc) left.appendChild(el('div', { class: 'pg-toggle-desc' }, desc));
  row.appendChild(left);
  const btn = el('button', {
    class: 'pg-switch' + (checked ? ' on' : ''),
    type: 'button',
    role: 'switch',
    'aria-pressed': checked ? 'true' : 'false',
    'aria-label': label + (checked ? '：已开启' : '：已关闭'),
  });
  btn.appendChild(el('span', { class: 'pg-switch-knob' }));
  if (disabled) btn.disabled = true;
  else btn.addEventListener('click', () => onChange(!checked));
  row.appendChild(btn);
  return row;
}

/** 滑块 (原版 Slider)。 */
export function slider(value, onChange, min, max, step, label, unit, desc) {
  const row = el('div', { class: 'pg-slider-row' });
  const top = el('div', { class: 'pg-slider-top' });
  const lt = el('div');
  lt.appendChild(el('div', { class: 'pg-toggle-label' }, label));
  if (desc) lt.appendChild(el('div', { class: 'pg-toggle-desc' }, desc));
  top.appendChild(lt);
  top.appendChild(el('div', { class: 'pg-slider-val' }, String(value) + (unit || '')));
  row.appendChild(top);
  const input = el('input', {
    class: 'pg-range',
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step || 1),
    value: String(value),
  });
  input.addEventListener('input', () => onChange(parseFloat(input.value)));
  row.appendChild(input);
  return row;
}

/** 信息行 (原版 InfoRow) —— 设计系统的字段行 `.pg-kv-row`。 */
export function infoRow(label, value, mono, copyable) {
  const row = el('div', { class: 'pg-kv-row' });
  row.appendChild(el('span', { class: 'pg-kv-k' }, label));
  const v = el('span', { class: 'pg-kv-v' + (mono ? ' mono' : '') });
  v.textContent = value == null ? '—' : String(value);
  if (copyable) {
    const b = el('button', { class: 'pg-icon-btn', type: 'button', title: '复制' });
    b.innerHTML = iconHTML('copy', 13);
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(String(value));
        b.innerHTML = iconHTML('check', 13);
        setTimeout(() => { b.innerHTML = iconHTML('copy', 13); }, 1400);
      } catch (e) { /* 剪贴板不可用就当没这回事 */ }
    });
    v.appendChild(b);
  }
  row.appendChild(v);
  return row;
}

/** 危险按钮 (原版 DangerButton) —— 带二次确认。 */
export function dangerButton(onClick, confirmText, children) {
  // 第 147 批: 原来是 `pg-btn pg-btn-danger pg-btn-block` —— 满宽**实心红块**。
  //   危险操作的视觉重量不该压过整页内容 (设置页「清除缓存」曾是一条通栏红条)。
  //   设计系统铁律 ⑥: danger 永远是**小尺寸描边红字**。
  const b = el('button', { class: 'pg-btn pg-btn-danger pg-btn-sm', type: 'button' }, children);
  b.addEventListener('click', async () => {
    if (confirmText && !window.confirm(confirmText)) return;
    b.disabled = true;
    try { await onClick(b); } finally { b.disabled = false; }
  });
  return b;
}

/**
 * 危险操作行 —— 一句说明 + 一个小尺寸描边红字按钮。
 *
 * 以前这些操作是**一条通栏实心红条** (「清空所有 session」「清理过期数据」
 * 「立即重启盘古」), 一张红条的视觉重量压过整页十行数字 ⇒ 一眼就廉价。
 * 现在走设计系统的 `.pg-danger-row`: 说明在左, 按钮在右, 按钮自己一个小。
 */
export function dangerRow(hintText, onClick, confirmText, label) {
  const row = el('div', { class: 'pg-danger-row' });
  if (hintText) row.appendChild(el('span', { class: 'pg-hint' }, hintText));
  row.appendChild(dangerButton(onClick, confirmText, label));
  return row;
}

/**
 * 操作栏 (原版 ActionBar) —— 有未保存改动才出现。
 *
 * 第 170 批: 动作**自己找家**。以前每个子页写一行
 *   `(getFooterHost() || host).appendChild(bar)` —— 于是「保存」浮在
 *   页脚右下角, 离内容很远, 像后台系统的悬浮条。
 * 现在: 优先进**页头右上角**的槽 (页头吸顶, 动作一直在眼前);
 * 没有槽 (子页被单独预览) 才退回页脚槽。
 */
export function actionBar(onSave, saving, dirty, saveLabel) {
  const bar = el('div', { class: 'pg-actionbar' });
  const left = el('div', { class: 'pg-actionbar-note' });
  if (dirty) left.appendChild(el('span', { class: 'pg-warn-text' }, '有未保存改动'));
  bar.appendChild(left);
  const b = el('button', { class: 'pg-btn pg-btn-primary', type: 'button' }, saving ? '保存中…' : (saveLabel || '保存'));
  b.disabled = !dirty || saving;
  b.addEventListener('click', () => onSave(b));
  bar.appendChild(b);
  const host = getPageActionHost();
  if (host) host.appendChild(bar);
  return bar;
}

/* ── 运行时文本里的本机绝对路径 → 仓库内相对路径 ───────────────────

   盘古要开源。任务描述、错误回执这些是运行时原话, 里面常带着
   「家目录 / 桌面 / 仓库名 / apps / core / …」这样的机器路径 ——
   印在界面上等于把某台机器的家目录贴给所有人看, 换一台机器还对不上号。

   规则 (**只**动机器路径, 不碰 URL 和普通斜杠):
     ① 只认首段是机器根 (家目录 / 系统目录 / 挂载点) 的绝对路径;
        `/api/config` 这种相对路由原样留着, 免得把接口地址改坏。
     ② 砍掉盘符、家目录、用户名, 再砍掉桌面/仓库这类前缀段,
        剩下的是仓库内相对路径 (`apps/core/modules/llm_caller.js`)。
     ③ 一段都砍不动的, 退回最后一段文件名 —— 宁可短, 不可泄露。
*/
const MACHINE_ROOTS = new Set([
  'Users', 'home', 'opt', 'usr', 'local', 'var', 'tmp', 'private',
  'Applications', 'mnt', 'srv', 'Volumes', 'Library', 'System', 'data',
]);

// 家目录 / 桌面 / 仓库根 —— 这些段只说明"装在哪台机器上", 相对路径里没用。
const PREFIX_SEGMENTS = new Set([
  'Users', 'home', 'Desktop', 'Documents', 'Downloads', 'workspace',
  'opt', 'usr', 'local', 'srv', 'mnt', 'Volumes', 'Library', 'private',
  'code', 'dev', 'Projects', 'repos', 'pangu',
  'tmp', 'var', 'Applications', 'System',
]);

function shortenAbsPath(raw) {
  const isWin = /^[A-Za-z]:[\\/]/.test(raw);
  const all = raw.split(/[\\/]+/).filter(Boolean);
  let segs = all.slice();
  if (isWin) segs = segs.slice(1);                     // 砍盘符 C:
  if (segs[0] === 'Users' || segs[0] === 'home') segs = segs.slice(2); // 砍家目录 + 用户名
  while (segs.length > 1 && PREFIX_SEGMENTS.has(segs[0])) segs.shift();
  if (!segs.length) segs = [all[all.length - 1]];      // 整条都砍光了 → 只留文件名
  return segs.join('/');
}

/**
 * 把一段文本里的本机绝对路径改成相对路径。
 * 认不出的路径原样留着 —— 宁可显示得丑, 也不能把路径改成另一个意思。
 */
export function relativizePaths(text) {
  if (text == null) return '';
  let s = String(text);
  // POSIX: 前面不能是字母/冒号/斜杠, 否则会咬到 http://host/path 这种 URL。
  s = s.replace(/(?<![\w.:~/~-])((?:\/[A-Za-z0-9_.~@+-]+){2,})/g, (whole) => {
    const segs = whole.split('/').filter(Boolean);
    if (!MACHINE_ROOTS.has(segs[0])) return whole;     // 不是机器根 → 原样
    return shortenAbsPath(whole);
  });
  // Windows: C:\Users\me\dir\file
  s = s.replace(/(?<![\w])([A-Za-z]:\\[^\s,;)'"]+)/g, (whole) => shortenAbsPath(whole));
  return s;
}

/**
 * 截断长文本 (加省略号)。运行时原话动辄几百字, 清单行里只留个头。
 */
export function clipText(text, max) {
  const s = String(text == null ? '' : text);
  const n = max || 80;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * 家目录 → `~`。
 *
 * 启动命令这类文本里的「家目录/.local/node/bin/npx」换成
 * 「~/.local/node/bin/npx」—— 路径还是那个路径, 但不再带着某个人的用户名,
 * 也不泄露本机结构 (开源版印给别人看时, 家目录名是最不该出现的东西)。
 */
export function tildeHome(text) {
  if (text == null) return '';
  return String(text)
    .replace(/(?<![\w.:~/~-])\/(?:Users|home)\/[^/\s"'`]+/g, '~/');
}

export default {
  toggle, slider, infoRow, dangerButton, dangerRow, actionBar,
  relativizePaths, clipText, tildeHome,
};
