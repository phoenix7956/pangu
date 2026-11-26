// settings.mjs —— 设置页的**壳**
//
// 第 170 批 · 重写: 12 个分类从**顶部一排横排**改成**左侧竖列**。
//   以前: 顶上 12 个 tab 挤成一行 (窄屏是一条横滚条), 下面才是内容;
//   「保存」按钮浮在右下角的页脚槽里, 离内容很远。
//   现在: 左边一列分类 (主流 agent 的做法: ChatGPT / Linear / Vercel),
//   右边一条内容轴; 页头吸顶, 「保存」进页头右上角。
//   分类项的名字/顺序/说明仍从 PAN_LORE.settings 取 (唯一真源)。
//
// 路由: `/settings?tab=<id>` —— app.mjs 按路径分派到本页, 本页再读查询参数取 id。
//   第 141 批: 子页从**路径**改成**查询参数** (路由必须全部单段,
//   否则 /settings/agent 会把相对 `themes.css` 解析成 /settings/themes.css ⇒ 样式全丢)。
//   参数变了 → app.mjs 重新 route() → 本页重渲染 ⇒ 不用自己监听 popstate。

import { el, esc, iconHTML, catnav, toast } from '../lib/util.mjs';
import { PAN_LORE } from '../lib/lore.mjs';
import { setPageActionHost } from '../lib/page-actions.mjs';
import { routeParams, navigate } from '../lib/route.mjs';

// id → 子页模块文件 (动态 import, 按需加载)
const PAGES = {
  connect: () => import('./settings/connect.mjs'),
  model: () => import('./settings/model.mjs'),
  agent: () => import('./settings/agent.mjs'),
  tools: () => import('./settings/tools.mjs'),
  mcp: () => import('./settings/mcp.mjs'),
  permission: () => import('./settings/permission.mjs'),
  ui: () => import('./settings/ui.mjs'),
  storage: () => import('./settings/storage.mjs'),
  credentials: () => import('./settings/credentials.mjs'),
  weixin: () => import('./settings/weixin.mjs'),
  selfrepair: () => import('./settings/self-repair.mjs'),
  voice: () => import('./settings/voice.mjs'),
  update: () => import('./settings/update.mjs'),
};

function currentId() {
  const id = routeParams().get('tab') || '';
  return PAGES[id] ? id : 'connect';
}

function buildNav(activeId) {
  // 分类竖列 = 设计系统的 `.pg-catnav` (第 170 批新零件)。
  // 一行一条、只留名字 + 图标 —— 十二行都带说明的话, 这一列比内容还长。
  // 说明不丢: 它在右边内容区的页头里 (那才是它该在的地方)。
  return catnav(
    PAN_LORE.settings.map((s) => ({
      id: s.id,
      label: s.name,
      icon: iconHTML(s.icon || 'activity', 15),
    })),
    activeId,
    (id) => navigate('settings?tab=' + id),
  );
}

export async function render(root) {
  const id = currentId();
  const meta = PAN_LORE.settings.find((s) => s.id === id) || { name: '设置', desc: '' };

  // 壳 = 左 (分类竖列) + 右 (内容轴)。
  const shell = el('div', { class: 'pangu-subshell pangu-subshell-settings' });

  const aside = el('aside', { class: 'pg-settings-aside' });
  aside.appendChild(el('div', { class: 'pg-settings-aside-title' }, '设置'));
  aside.appendChild(buildNav(id));
  // 窄屏: 分类竖列放不下 ⇒ 收成一个**下拉** (契约 §10)。
  // 桌面端这个下拉是隐藏的 (CSS display: none), 只有窄屏才出现。
  const catSelect = el('select', { class: 'pg-input pg-settings-cat-select' });
  for (const s of PAN_LORE.settings) {
    const o = el('option', { value: s.id }, s.name);
    if (s.id === id) o.selected = true;
    catSelect.appendChild(o);
  }
  catSelect.addEventListener('change', () => navigate('settings?tab=' + catSelect.value));
  aside.appendChild(catSelect);
  shell.appendChild(aside);

  const main = el('div', { class: 'pangu-subshell-main' });
  const body = el('div', { class: 'pangu-subshell-body' });

  // 页头 = 分类名 + 一句说明 + 右侧动作槽 (保存按钮住这儿, 第 170 批)。
  // 页头**吸顶**: 内容再长, 动作也一直在眼前, 不用滚回去找「保存」。
  // 结构: 页头是通宽的带子 (背景 + 下沿线), 里面的内容走同一条轴 ——
  // 否则内容滚上去会从页头两侧的缝里钻出来。
  const head = el('div', { class: 'pg-page-head' });
  const headInner = el('div', { class: 'pg-settings-head-inner' });
  const headMain = el('div', { class: 'pg-page-head-main' });
  headMain.appendChild(el('h1', {}, meta.name));
  if (meta.desc) headMain.appendChild(el('p', {}, meta.desc));
  headInner.appendChild(headMain);
  const actionHost = el('div', { class: 'pg-page-head-actions' });
  headInner.appendChild(actionHost);
  head.appendChild(headInner);
  body.appendChild(head);

  const slot = el('div', { class: 'pg-settings-slot' });
  body.appendChild(slot);
  main.appendChild(body);
  shell.appendChild(main);
  root.appendChild(shell);

  // 子页把「保存」操作栏放进这个槽 (actionBar 自己找家)。
  setPageActionHost(actionHost);

  let inner = null;
  try {
    const mod = await PAGES[id]();
    slot.innerHTML = '';
    inner = (await mod.render(slot)) || null;
  } catch (e) {
    slot.innerHTML = '';
    slot.appendChild(el('div', { class: 'errbox' },
      '这个设置项还没接上: ' + esc(id) + ' — ' + esc(e && e.message || e)));
    toast('设置项载入失败: ' + (e && e.message || e), true);
  }

  return {
    destroy() {
      setPageActionHost(null);
      if (inner && inner.destroy) {
        try { inner.destroy(); } catch (e) { /* 清理失败不许挡住切换 */ }
      }
    },
  };
}

export default render;
