// settings/credentials.mjs —— 设置 · 凭证 (Proxy 模式)
//
// 从原版 `apps/desktop/src/views/settings/Credentials.jsx` (git 110661d^) 搬过来。
// 铁律: value **只写不读** —— 列表接口只给 hasValue, 页面永远不显示真值。

import { el, page, toast, flatSection } from '../../lib/util.mjs';
import { api } from '../../lib/api.mjs';

export async function render(root) {
  // 第 147 批: 页根 = 设计系统的页面外壳 `.pg-page` (全站页面外壳统一)。
  const host = page();
  host.classList.add('pg-settings-col');
  root.appendChild(host);

  let list = [];
  let file = '';
  let error = null;
  let editing = null;   // { name, value, note, enabled }

  const paint = () => {
    host.innerHTML = '';

    const body = el('div', {});
    body.appendChild(el('div', { class: 'pg-hint' },
      '集中管理用户名 / API key / 密码。Proxy 模式: 凭证仅供 Pangu 工具内部使用 (注入 HTTP 头等), 不返给 LLM。'
      + '下次工具需要某凭证时, 盘古自动从下面这个文件读取, 不再弹窗问用户。'));
    if (file) {
      const f = el('div', { class: 'pg-hint mono' }, file);
      body.appendChild(f);
    }

    if (error) body.appendChild(el('div', { class: 'pg-err-line' }, '错误: ' + error));

    const row = el('div', { class: 'pg-btn-row' });
    const bNew = el('button', { class: 'pg-btn pg-btn-primary', type: 'button' }, '+ 新增凭证');
    bNew.addEventListener('click', () => { editing = { name: '', value: '', note: '', enabled: true }; paint(); });
    const bRe = el('button', { class: 'pg-btn', type: 'button' }, '刷新');
    bRe.addEventListener('click', () => load());
    row.appendChild(bNew);
    row.appendChild(bRe);
    body.appendChild(row);

    if (editing) {
      const box = el('div', { class: 'pg-edit-box' });
      box.appendChild(el('div', { class: 'pg-edit-title' },
        editing.name ? '编辑凭证: ' + editing.name : '新增凭证'));
      const mk = (label, key, type, placeholder) => {
        const w = el('div', { class: 'pg-field' });
        w.appendChild(el('span', { class: 'pg-label' }, label));
        const i = el('input', { class: 'pg-input' + (type === 'password' ? ' mono' : ''), type: type || 'text', placeholder: placeholder || '' });
        i.value = editing[key] || '';
        i.addEventListener('input', () => { editing[key] = i.value; });
        w.appendChild(i);
        return w;
      };
      box.appendChild(mk('凭证名 (e.g. github_pat)', 'name', 'text'));
      box.appendChild(mk('value (key / token / password)', 'value', 'password'));
      box.appendChild(mk('备注', 'note', 'text'));
      const en = el('label', { class: 'pg-check-row' });
      const cb = el('input', { type: 'checkbox' });
      cb.checked = editing.enabled !== false;
      cb.addEventListener('change', () => { editing.enabled = cb.checked; });
      en.appendChild(cb);
      en.appendChild(el('span', {}, '启用 (关闭后 Pangu 工具不会读取)'));
      box.appendChild(en);
      const brow = el('div', { class: 'pg-btn-row' });
      const bSave = el('button', { class: 'pg-btn pg-btn-primary', type: 'button' }, '保存');
      bSave.disabled = !editing.name || !editing.value;
      bSave.addEventListener('click', () => doSave());
      const bCancel = el('button', { class: 'pg-btn', type: 'button' }, '取消');
      bCancel.addEventListener('click', () => { editing = null; paint(); });
      brow.appendChild(bSave);
      brow.appendChild(bCancel);
      box.appendChild(brow);
      body.appendChild(box);
    }

    const t = el('table', { class: 'pg-table' });
    t.appendChild(el('thead', { html: '<tr><th>名字</th><th>状态</th><th>值</th><th>备注</th><th>创建时间</th><th>最近使用</th><th></th></tr>' }));
    const tb = el('tbody');
    if (!list.length) {
      const tr = el('tr');
      tr.appendChild(el('td', { colspan: '7', class: 'hint' }, '尚无凭证'));
      tb.appendChild(tr);
    }
    for (const c of list) {
      const tr = el('tr');
      tr.appendChild(el('td', { class: 'mono' }, c.name));
      tr.appendChild(el('td', {}, c.enabled ? '● 启用' : '○ 禁用'));
      // 真值永远不显示 —— 只显示「有没有值」
      tr.appendChild(el('td', { class: 'hint' }, c.hasValue ? '有值' : '没值'));
      tr.appendChild(el('td', { class: 'hint' }, c.note || '—'));
      tr.appendChild(el('td', { class: 'hint' }, c.createdAt ? new Date(c.createdAt).toLocaleString() : '—'));
      tr.appendChild(el('td', { class: 'hint' }, c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : '—'));
      const td = el('td', { class: 'pg-td-right' });
      const bT = el('button', { class: 'pg-link-btn', type: 'button' }, c.enabled ? '禁用' : '启用');
      bT.addEventListener('click', () => doToggle(c.name, !c.enabled));
      const bD = el('button', { class: 'pg-link-btn is-danger', type: 'button' }, '删除');
      bD.addEventListener('click', () => doRemove(c.name));
      td.appendChild(bT);
      td.appendChild(bD);
      tr.appendChild(td);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    body.appendChild(t);

    body.appendChild(el('div', { class: 'pg-hint' }, '· 凭证文件自动 chmod 600 (owner-only)'));
    body.appendChild(el('div', { class: 'pg-hint' }, '· 环境变量 PANGU_CRED_<NAME> 优先级高于文件'));
    body.appendChild(el('div', { class: 'pg-hint' }, '· 工具调用时自动判断格式: sk-* → Bearer, ghp_* → token, 等'));
    body.appendChild(el('div', { class: 'pg-hint' }, '· value 永不返给 LLM, 仅 Pangu 内部 HTTP 头注入'));

    host.appendChild(flatSection('凭证管理 · Proxy 模式', null, body));
  };

  async function load() {
    error = null;
    try {
      const r = await api.credentialsList();
      if (r && r.ok) {
        // 后端返回的是 {ok, credentials, count} —— 没有 data 字段 (原版 desktop 那份
        // 写的是 r.data, 于是永远空着, 这里跟真实响应对齐)
        list = r.credentials || r.data || [];
        file = r.file || '';
      } else {
        error = (r && r.error) || 'load failed';
      }
    } catch (e) {
      error = e.message || String(e);
    }
    paint();
  }

  async function doSave() {
    error = null;
    try {
      const r = await api.credentialsSet(editing.name, editing.value, editing.note || '', editing.enabled !== false);
      if (r && r.ok) {
        editing = null;
        toast('凭证已保存');
        await load();
      } else {
        error = (r && r.error) || 'set failed';
        paint();
      }
    } catch (e) {
      error = e.message || String(e);
      paint();
    }
  }

  async function doToggle(name, enabled) {
    try {
      await api.credentialsToggle(name, enabled);
      await load();
    } catch (e) {
      error = e.message || String(e);
      paint();
    }
  }

  async function doRemove(name) {
    if (!window.confirm('确认删除凭证 "' + name + '"?')) return;
    try {
      await api.credentialsRemove(name);
      toast('已删除 ' + name);
      await load();
    } catch (e) {
      error = e.message || String(e);
      paint();
    }
  }

  paint();
  await load();
  return {};
}

export default render;
