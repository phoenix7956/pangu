// settings/update.mjs —— 设置 · 更新
//
// 从原版 `apps/desktop/src/views/settings/Update.jsx` (git 110661d^) 搬过来。
// 原版从 desktop/package.json 读版本号 —— 桌面端已经不要了, 这里改读 core 的版本端点。

import { el, page, tiles, kvList, flatSection } from '../../lib/util.mjs';
import { api } from '../../lib/api.mjs';
import { infoRow, toggle } from '../../components/settings-widgets.mjs';

export async function render(root) {
  const host = page();
  host.classList.add('pg-settings-col');
  root.appendChild(host);

  let health = null;
  let version = null;

  const paint = () => {
    host.innerHTML = '';

    const b1 = el('div', {});
    b1.appendChild(tiles([
      { k: '工作台', v: version ? 'v' + version : '—' },
      { k: '后端', v: (health && (health.version || (health.data && health.data.service))) || '—' },
      { k: '更新', v: '未接入' },
    ]));
    b1.appendChild(kvList([
      infoRow('App 名', '盘古 · 圭室'),
      infoRow('形态', '浏览器工作台 (core 静态页)', true),
      infoRow('更新服务', '未配置'),
    ]));
    host.appendChild(flatSection('当前版本', null, b1));

    const b2 = el('div', {});
    const row = el('div', { class: 'pg-btn-row' });
    for (const label of ['稳定版', '测试版']) {
      const b = el('button', { class: 'pg-btn', type: 'button', disabled: true }, label);
      b.appendChild(el('span', { class: 'pg-btn-sub' }, '未接入'));
      row.appendChild(b);
    }
    b2.appendChild(row);
    b2.appendChild(toggle(false, () => {}, '自动更新', '更新服务未接入, 自动下载不可用', true));
    host.appendChild(flatSection('更新通道', null, b2));

    const b3 = el('div', {});
    const b = el('button', { class: 'pg-btn pg-btn-primary', type: 'button', disabled: true },
      '更新服务未接入');
    b3.appendChild(b);
    host.appendChild(flatSection('检查更新', null, b3));

    const b4 = el('div', {});
    for (const line of [
      '盘古 · 64 卦 · 384 爻 · 通用 AI Agent',
      '开天辟地，万物皆可为用',
      '本地优先 · 6 位二进制 · 浏览器工作台',
    ]) b4.appendChild(el('div', { class: 'pg-hint' }, line));
    host.appendChild(flatSection('关于', null, b4));
  };

  const [h, v] = await Promise.all([api.health(), api.version()]);
  health = h;
  version = v && (v.version || (v.data && v.data.version));
  paint();
  return {};
}

export default render;
