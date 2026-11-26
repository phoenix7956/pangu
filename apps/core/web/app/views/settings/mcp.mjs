// settings/mcp.mjs —— 设置 · MCP (Server 列表)
//
// 从原版 `apps/desktop/src/views/settings/MCP.jsx` (git 110661d^) 搬过来。
// 原版 2026-06-21 已把「新建 skill / 从本地导入 / 从 URL 导入」三个按钮迁到 Marketplace,
// 这里也**不搬回来** —— 只管 MCP server 列表。

import { el, elHTML, page, toast, flatSection } from '../../lib/util.mjs';
import { iconHTML } from '../../lib/icons.mjs';
import { api } from '../../lib/api.mjs';
import { tildeHome } from '../../components/settings-widgets.mjs';

const PROTOCOLS = ['stdio', 'sse', 'http', 'websocket'];

// 参考模板 (不是真实 connected, 仅供「填入草稿」时参考)
const TEMPLATES = [
  { name: 'github-mcp', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], desc: 'GitHub 集成' },
  { name: 'filesystem-mcp', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], desc: '文件系统' },
];

export async function render(root) {
  // 第 147 批: 页根 = 设计系统的页面外壳 `.pg-page` (全站页面外壳统一)。
  const host = page();
  host.classList.add('pg-settings-col');
  root.appendChild(host);

  let connected = [];
  let loading = true;
  let error = null;
  let adding = false;
  let draft = { name: '', transport: 'stdio', command: '', args: '' };

  const paint = () => {
    host.innerHTML = '';

    /* 已连接 */
    const c1 = el('div', { class: 'pg-card' });
    const h1 = el('div', { class: 'pg-card-header pg-card-header-split' });
    h1.appendChild(el('span', {}, 'MCP 服务 ('
      + connected.filter((s) => s.enabled).length + '/' + connected.length + ')'
      + (loading ? ' · 加载中…' : '')
      + (error ? ' · ' + error : '')));
    const hr = el('div', { class: 'pg-btn-row' });
    // 第 147 批: 按钮上的符号换成矢量图标 (跟全站一致, 也跟主题走)。
    const bRef = elHTML('button', { class: 'pg-btn pg-btn-ico', type: 'button' },
      iconHTML('refresh', 14) + '<span>刷新</span>');
    bRef.addEventListener('click', () => refresh());
    const bAdd = elHTML('button', { class: 'pg-btn pg-btn-ico', type: 'button' },
      iconHTML('plus', 14) + '<span>添加</span>');
    bAdd.addEventListener('click', () => { adding = !adding; paint(); });
    hr.appendChild(bRef);
    hr.appendChild(bAdd);
    h1.appendChild(hr);
    c1.appendChild(h1);
    const b1 = el('div', { class: 'pg-card-body' });

    if (adding) {
      const box = el('div', { class: 'pg-edit-box' });
      const nameW = el('div', { class: 'pg-field' });
      nameW.appendChild(el('span', { class: 'pg-label' }, '名称'));
      const nameI = el('input', { class: 'pg-input', type: 'text', value: draft.name, placeholder: '名称' });
      nameI.addEventListener('input', () => { draft.name = nameI.value; });
      nameW.appendChild(nameI);
      box.appendChild(nameW);
      const trW = el('div', { class: 'pg-field' });
      trW.appendChild(el('span', { class: 'pg-label' }, '传输协议'));
      const trI = el('select', { class: 'pg-input' });
      for (const p of PROTOCOLS) trI.appendChild(el('option', { value: p }, p));
      trI.value = draft.transport;
      trI.addEventListener('change', () => { draft.transport = trI.value; });
      trW.appendChild(trI);
      box.appendChild(trW);
      const cmdW = el('div', { class: 'pg-field' });
      cmdW.appendChild(el('span', { class: 'pg-label' }, '启动命令'));
      const cmdI = el('input', { class: 'pg-input mono', type: 'text', value: draft.command, placeholder: '例: node / npx' });
      cmdI.addEventListener('input', () => { draft.command = cmdI.value; });
      cmdW.appendChild(cmdI);
      box.appendChild(cmdW);
      const argsW = el('div', { class: 'pg-field' });
      argsW.appendChild(el('span', { class: 'pg-label' }, '参数 (空格分隔)'));
      const argsI = el('input', { class: 'pg-input mono', type: 'text', value: draft.args, placeholder: '参数 (空格分隔)' });
      argsI.addEventListener('input', () => { draft.args = argsI.value; });
      argsW.appendChild(argsI);
      box.appendChild(argsW);
      const brow = el('div', { class: 'pg-btn-row' });
      const bOk = el('button', { class: 'pg-btn pg-btn-primary', type: 'button' }, '添加');
      bOk.addEventListener('click', () => add());
      const bNo = el('button', { class: 'pg-btn', type: 'button' }, '取消');
      bNo.addEventListener('click', () => { adding = false; paint(); });
      brow.appendChild(bOk);
      brow.appendChild(bNo);
      box.appendChild(brow);
      b1.appendChild(box);
    }

    if (!connected.length && !loading && !error) {
      b1.appendChild(el('div', { class: 'pg-empty' }, '暂无已连接的 MCP 服务'));
    }
    for (const s of connected) {
      const row = el('div', { class: 'pg-mcp-row' });
      row.appendChild(elHTML('span', { class: 'pg-mcp-ico' }, iconHTML('puzzle', 17)));
      const box = el('div', { class: 'pg-mcp-text' });
      const nm = el('div', { class: 'pg-mcp-name' });
      nm.appendChild(el('b', {}, s.name));
      nm.appendChild(el('span', { class: 'pg-badge' }, s.transport));
      box.appendChild(nm);
      // 启动命令里带的是**本机**路径 (家目录下的 npx)。盘古要开源 ——
      //   印出来的是某台机器的家目录, 换成 `~` 之后既干净又不泄露本机结构。
      const cmdText = tildeHome(s.command + ' ' + (s.args || []).join(' '));
      const cmdLine = el('div', { class: 'pg-mcp-cmd mono' }, cmdText);
      cmdLine.title = cmdText;              // 整行太长时悬停看全文
      box.appendChild(cmdLine);
      if (s.desc) box.appendChild(el('div', { class: 'pg-mcp-desc' }, s.desc));
      row.appendChild(box);
      const sw = el('button', { class: 'pg-switch' + (s.enabled ? ' on' : ''), type: 'button', role: 'switch' });
      sw.appendChild(el('span', { class: 'pg-switch-knob' }));
      sw.setAttribute('aria-label', s.name + (s.enabled ? '：已开启' : '：已关闭'));
      sw.addEventListener('click', () => toggle(s.name));
      row.appendChild(sw);
      // 删除按钮 = 全站共用的 `.pg-act-del` (平时灰, 悬停才朱砂) ——
      // 满列表的红方块太吵。
      const bDel = elHTML('button', { class: 'pg-act-del', type: 'button' }, iconHTML('x', 14));
      bDel.setAttribute('aria-label', '删除 ' + s.name);
      bDel.addEventListener('click', () => remove(s.name));
      row.appendChild(bDel);
      b1.appendChild(row);
    }
    c1.appendChild(b1);
    host.appendChild(c1);

    /* 模板 */
    const avail = TEMPLATES.filter((t) => !connected.some((c) => c.name === t.name));
    const b2 = el('div', {});
    if (!avail.length) b2.appendChild(el('div', { class: 'pg-empty' }, '模板都已连接'));
    for (const t of avail) {
      const row = el('div', { class: 'pg-mcp-row is-dim' });
      row.appendChild(elHTML('span', { class: 'pg-mcp-ico' }, iconHTML('puzzle', 17)));
      const box = el('div', { class: 'pg-mcp-text' });
      const nm = el('div', { class: 'pg-mcp-name' });
      nm.appendChild(el('b', {}, t.name));
      nm.appendChild(el('span', { class: 'pg-badge' }, t.transport));
      nm.appendChild(el('span', { class: 'pg-hint' }, '未连接'));
      box.appendChild(nm);
      box.appendChild(el('div', { class: 'pg-mcp-cmd mono' }, t.command + ' ' + (t.args || []).join(' ')));
      if (t.desc) box.appendChild(el('div', { class: 'pg-mcp-desc' }, t.desc));
      row.appendChild(box);
      const b = el('button', { class: 'pg-btn', type: 'button' }, '填入草稿');
      b.addEventListener('click', () => {
        draft = { name: t.name, transport: t.transport, command: t.command, args: (t.args || []).join(' ') };
        adding = true;
        paint();
      });
      row.appendChild(b);
      b2.appendChild(row);
    }
    host.appendChild(flatSection('可用 MCP 模板 (参考 · 点「填入草稿」一键填入)', null, b2));

    /* 协议说明 */
    const b3 = el('div', {});
    // 协议说明走真正的列表 —— 以前是四行以「•」开头的文字,
    //   「•」贴着正文, 换行后完全对不齐, 看着像随手敲的。
    const protoList = el('ul', { class: 'pg-note-list' });
    for (const line of [
      'stdio: 启动子进程, JSON-RPC over stdin/stdout',
      'sse: Server-Sent Events, 单向推',
      'http: HTTP 请求-响应',
      'websocket: 全双工长连接',
    ]) protoList.appendChild(el('li', {}, line));
    b3.appendChild(protoList);
    host.appendChild(flatSection('MCP 协议说明', null, b3));
  };

  async function refresh() {
    loading = true;
    paint();
    const r = await api.mcpServers();
    if (r && r.ok) {
      connected = (r.servers || []).map((s) => ({
        name: s.name,
        transport: s.transport,
        command: s.command || '(动态)',
        args: s.args || [],
        enabled: !!s.enabled,
        status: s.enabled ? 'connected' : 'disconnected',
        tool_count: s.tool_count || 0,
        error: s.error || null,
        desc: s.description || (s.enabled ? '已连接' : '未连接') + ' · ' + (s.tool_count || 0) + ' 个工具'
          + (s.error ? ' · ' + s.error : ''),
      }));
      error = null;
    } else {
      connected = [];
      error = (r && r.error) || 'fetch failed';
    }
    loading = false;
    paint();
  }

  async function toggle(name) {
    const s = connected.find((x) => x.name === name);
    if (!s) return;
    const prev = s.enabled;
    connected = connected.map((x) => (x.name === name ? Object.assign({}, x, { enabled: !prev }) : x));
    paint();
    try {
      const r = await api.mcpUpdate(name, { enabled: !prev });
      if (!(r && r.ok)) throw new Error((r && r.error) || 'update failed');
      await refresh();
    } catch (e) {
      connected = connected.map((x) => (x.name === name ? Object.assign({}, x, { enabled: prev }) : x));
      error = '切换 ' + name + ' 失败: ' + (e.message || e);
      paint();
    }
  }

  async function remove(name) {
    if (!window.confirm('删除 MCP server "' + name + '"?')) return;
    try {
      const r = await api.mcpDelete(name);
      if (!(r && r.ok)) throw new Error((r && r.error) || 'delete failed');
      toast('已删除 ' + name);
      await refresh();
    } catch (e) {
      error = '删除 ' + name + ' 失败: ' + (e.message || e);
      paint();
    }
  }

  async function add() {
    if (!draft.name || !draft.command) {
      toast('名称和启动命令都要填', true);
      return;
    }
    const server = {
      name: draft.name.trim(),
      transport: draft.transport,
      command: draft.command.trim(),
      args: draft.args ? draft.args.trim().split(/\s+/).filter(Boolean) : [],
      enabled: true,
    };
    try {
      const r = await api.mcpAdd(server);
      if (!(r && r.ok)) throw new Error((r && r.error) || 'add failed');
      draft = { name: '', transport: 'stdio', command: '', args: '' };
      adding = false;
      toast('已添加 ' + server.name);
      await refresh();
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('ALREADY EXISTS') || msg.includes('already exists')) {
        error = server.name + ' 已在连接列表中, 点「刷新」查看';
      } else {
        error = '添加 ' + server.name + ' 失败: ' + msg;
      }
      paint();
    }
  }

  paint();
  await refresh();
  return {};
}

export default render;
