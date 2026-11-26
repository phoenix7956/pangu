// settings/tools.mjs —— 设置 · 内部工具
//
// 从原版 `apps/desktop/src/views/settings/Tools.jsx` + `_role_matrix.jsx` (git 110661d^) 搬过来。
// 原版 2026-09-13 老板拍: tools / skills 合并 —— 同一份数据的两个视图, 双 tab。

import { el, elHTML, esc, page, segmented, toast, flatSection } from '../../lib/util.mjs';
import { iconHTML } from '../../lib/icons.mjs';
import { api } from '../../lib/api.mjs';
import { GUA_ROSTER, guaLabel } from '../../lib/gua-roster.mjs';

const TIER_GROUP = {
  '谋': '谋', '断': '断', '观': '观', '行': '执行', '革': '变革',
  '记忆': '记忆', '缓存': '缓存', '网络': '网络', '系统': '系统',
};

const GROUP_LABELS = {
  '谋': '谋', '断': '断', '观': '观', '行': '执行', '革': '变革',
  '记忆': '记忆', '缓存': '缓存', '网络': '网络', '系统': '系统', '其他': '其他',
};

// 2026-10-28 第 138 批: 分组标题原来用 emoji (🧠 ⚖️ 👁 ⚡ 🔥 💾 📦 🌐 ⚙️ ❓) ——
//   emoji 字形各平台不一样, 颜色也不跟着主题走, 跟工作台那套青玉+朱砂不搭。
//   换矢量图标: 颜色随 currentColor, 跟三套主题一致。
const GROUP_ICONS = {
  '谋': 'brain', '断': 'sliders', '观': 'eye', '行': 'zap', '革': 'sparkles',
  '记忆': 'database', '缓存': 'package', '网络': 'globe', '系统': 'settings', '其他': 'info',
};

const FALLBACK = [
  { name: 'read_file', group: '文件', desc: '读取文件内容' },
  { name: 'write_file', group: '文件', desc: '写文件' },
  { name: 'web_search', group: '网络', desc: '网络搜索' },
  { name: 'web_fetch', group: '网络', desc: '抓页面' },
  { name: 'system_info', group: '系统', desc: '系统信息' },
];

const ROLE_ORDER = GUA_ROSTER.map((r) => r.code);
const META_ROLE_LABELS = { main: '通用' };

export async function render(root) {
  // 第 147 批: 页根 = 设计系统的页面外壳 `.pg-page` (全站页面外壳统一)。
  const host = page();
  host.classList.add('pg-settings-col');
  root.appendChild(host);

  let tab = 'list';
  let tools = {};        // name → { enabled, group, desc, roles, exposed }
  let rawTools = [];     // /api/pangu/tools 的原始 tools 数组 (角色视角用)
  let exposedByRole = {};
  let search = '';
  let groupFilter = '';
  let selected = null;
  let schema = null;
  let testParams = '{}';
  let testResult = null;
  let testRunning = false;
  let activeRole = 'qian';
  let filter = '';

  function paint() {
    host.innerHTML = '';

    /* 双 tab —— 第 147 批: 分段控件走设计系统的 `.pg-seg`。
       全站原来有三套分段控件 (设置页 .seg-i / 工具集 .pg-mp-tab /
       梅花页 .pg-mh-seg-i), 现在只有这一套。 */
    host.appendChild(segmented(
      [{ id: 'list', name: '工具总表' }, { id: 'roles', name: '角色视角' }],
      tab,
      (id) => { tab = id; paint(); }
    ));

    if (tab === 'roles') { paintRoles(); return; }

    /* 搜索 + 分组 */
    const bar = el('div', { class: 'pg-toolbar' });
    const sI = el('input', { class: 'pg-input', type: 'search', value: search, placeholder: '搜工具名 / 描述' });
    sI.addEventListener('input', () => { search = sI.value; paint(); });
    bar.appendChild(sI);
    const gSel = el('select', { class: 'pg-input' });
    gSel.appendChild(el('option', { value: '' }, '全部分组'));
    const groups = groupMap();
    for (const g of Object.keys(groups)) {
      gSel.appendChild(el('option', { value: g }, (GROUP_LABELS[g] || g) + ' (' + groups[g].length + ')'));
    }
    gSel.value = groupFilter;
    gSel.addEventListener('change', () => { groupFilter = gSel.value; paint(); });
    bar.appendChild(gSel);
    bar.appendChild(el('div', { class: 'pg-toolbar-spacer' }));
    bar.appendChild(el('span', { class: 'pg-hint' },
      Object.keys(tools).length + ' 个工具 · 点一行看参数'));
    host.appendChild(bar);

    /* 左: 工具列表 / 右: 详情 */
    const wrap = el('div', { class: 'pg-tools-wrap' + (selected ? ' has-sel' : '') });
    const left = el('div', { class: 'pg-tools-list' });
    for (const g of Object.keys(groups)) {
      const fl = groups[g].filter(([n, t]) => {
        if (groupFilter && t.group !== groupFilter) return false;
        if (!search) return true;
        const q = search.toLowerCase();
        return n.toLowerCase().includes(q) || (t.desc || '').toLowerCase().includes(q);
      });
      if (!fl.length) continue;
      const gHead = el('div', { class: 'pg-subhead pg-ico-line' });
      gHead.appendChild(elHTML('span', {}, iconHTML(GROUP_ICONS[g] || 'info', 13)));
      gHead.appendChild(el('span', {}, (GROUP_LABELS[g] || g) + ' · ' + fl.length));
      left.appendChild(gHead);
      for (const pair of fl) {
        const n = pair[0];
        const t = pair[1];
        // 第 147 批: 工具行 = 设计系统的 `.pg-list-row`
        //   (工具集/将灵/角色 共用同一种行)。以前这里是 `.pg-tool-row` ——
        //   带边框带底色的一小块, 又是自造的一套画法。
        const row = el('div', {
          class: 'pg-list-row pg-tool-row' + (selected === n ? ' is-sel' : '') + (t.enabled ? '' : ' is-off'),
        });
        const info = el('div', { class: 'pg-list-main' });
        // 第 138 批: 🟢/⚫ 两个 emoji 换成一个 CSS 圆点 (颜色跟主题走)。
        const nameRow = el('div', { class: 'pg-list-title mono pg-ico-line' });
        nameRow.appendChild(el('span', { class: 'pg-tool-dot ' + (t.enabled ? 'on' : 'off') }));
        nameRow.appendChild(el('span', {}, n));
        info.appendChild(nameRow);
        info.appendChild(el('div', { class: 'pg-list-desc' }, t.desc));
        row.appendChild(info);
        // 开关统一走全站那一个 `.pg-switch` —— 以前这里是个 ON/OFF 文字小按钮,
        //   跟设置页其它地方的滑动开关不是同一个东西。
        const sw = el('button', { class: 'pg-switch' + (t.enabled ? ' on' : ''), type: 'button', role: 'switch' });
        sw.appendChild(el('span', { class: 'pg-switch-knob' }));
        sw.setAttribute('aria-label', n + (t.enabled ? '：已启用' : '：已停用'));
        sw.addEventListener('click', (e) => { e.stopPropagation(); toggleTool(n); });
        row.appendChild(sw);
        row.addEventListener('click', () => {
          selected = n;
          paint();
          loadSchema(n);
        });
        left.appendChild(row);
      }
    }
    if (!Object.keys(groups).length) left.appendChild(el('div', { class: 'pg-empty' }, '工具表是空的'));
    wrap.appendChild(left);

    if (selected) wrap.appendChild(paintDetail());
    host.appendChild(wrap);
  }

  function paintDetail() {
    // 第 147 批: 详情面板 = 设计系统的卡片 (`.pg-card` + 头 + 体)。
    const box = el('div', { class: 'pg-card' });
    const head = el('div', { class: 'pg-card-header' });
    head.appendChild(el('span', { class: 'mono' }, selected));
    const bClose = el('button', { class: 'pg-icon-btn', type: 'button' });
    bClose.innerHTML = iconHTML('x', 15);
    bClose.setAttribute('aria-label', '关闭详情');
    bClose.addEventListener('click', () => { selected = null; paint(); });
    head.appendChild(bClose);
    box.appendChild(head);
    const body = el('div', { class: 'pg-card-body' });
    box.appendChild(body);

    if (schema && schema.error) {
      body.appendChild(el('div', { class: 'pg-err-line' }, 'schema 加载失败: ' + schema.error));
      return box;
    }
    if (!schema) {
      body.appendChild(el('div', { class: 'pg-hint' }, '读 schema…'));
      return box;
    }

    const fn = schema.function || schema;
    const props = (fn.parameters && fn.parameters.properties) || {};
    const req = (fn.parameters && fn.parameters.required) || [];

    body.appendChild(el('div', { class: 'pg-schema-desc' }, String(fn.description || '').slice(0, 500)));

    if (Object.keys(props).length) {
      body.appendChild(el('div', { class: 'pg-subhead' }, '参数'));
      const t = el('table', { class: 'pg-table pg-tiny' });
      t.appendChild(el('thead', { html: '<tr><th>字段</th><th>类型</th><th>必填</th><th>说明</th></tr>' }));
      const tb = el('tbody');
      for (const k of Object.keys(props)) {
        const p = props[k] || {};
        const tr = el('tr');
        tr.appendChild(el('td', { class: 'mono' + (req.includes(k) ? ' pg-strong' : '') }, k + (req.includes(k) ? ' *' : '')));
        tr.appendChild(el('td', { class: 'hint' }, (p.type || '?') + (p.enum ? ' (' + p.enum.join('|') + ')' : '')));
        tr.appendChild(el('td', { class: req.includes(k) ? 'pg-warn-text' : 'hint' }, req.includes(k) ? '✓' : ''));
        tr.appendChild(el('td', { class: 'hint' }, String(p.description || '').slice(0, 100)));
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      body.appendChild(t);
    }

    body.appendChild(el('div', { class: 'pg-subhead' }, '测试调用 (JSON params)'));
    const ta = el('textarea', { class: 'pg-textarea mono pg-test-area' });
    ta.value = testParams;
    ta.addEventListener('input', () => { testParams = ta.value; });
    box.appendChild(ta);
    const bRun = el('button', { class: 'pg-btn pg-btn-primary', type: 'button' },
      testRunning ? '运行中…' : '跑一次');
    bRun.disabled = testRunning;
    bRun.addEventListener('click', () => runTest());
    body.appendChild(bRun);

    if (testResult) {
      // 第 138 批: emoji 换成矢量图标 (颜色跟着 .pg-msg-line 的 is-ok / is-bad 走)。
      const resLine = el('div', { class: 'pg-msg-line pg-ico-line ' + (testResult.ok ? 'is-ok' : 'is-bad') });
      resLine.appendChild(elHTML('span', {}, iconHTML(testResult.ok ? 'check' : 'x', 14)));
      resLine.appendChild(el('span', {},
        (testResult.ok ? '成功' : ((testResult.error && testResult.error.code) || '失败'))
        + (testResult.elapsed_ms != null ? ' (' + testResult.elapsed_ms + 'ms)' : '')));
      body.appendChild(resLine);
      const pre = el('pre', { class: 'pg-pre' });
      pre.textContent = JSON.stringify(testResult, null, 2);
      body.appendChild(pre);
    }
    return box;
  }

  function paintRoles() {
    const cb = el('div', {});
    const top = el('div', { class: 'pg-roles-top' });
    const tl = el('div');
    // 第 138 批: emoji (🧠) 换矢量图标。
    const gTitle = el('div', { class: 'pg-list-title pg-ico-line' });
    gTitle.appendChild(elHTML('span', {}, iconHTML('brain', 15)));
    gTitle.appendChild(el('span', {}, '按角色分组'));
    tl.appendChild(gTitle);
    tl.appendChild(el('div', { class: 'pg-hint' },
      '每个将灵只暴露自己范围内的 tool · 乾·调度(盘古出口)不握工具, 纯收口出结论 (不污染 LLM 上下文)'));
    top.appendChild(tl);
    const tr = el('div', { class: 'pg-btn-row' });
    const fi = el('input', { class: 'pg-input pg-input-sm', type: 'search', value: filter, placeholder: '搜索...' });
    fi.addEventListener('input', () => { filter = fi.value; paint(); });
    tr.appendChild(fi);
    const bRe = el('button', { class: 'pg-btn pg-btn-sm', type: 'button' }, '↻ 刷新');
    bRe.addEventListener('click', () => load());
    tr.appendChild(bRe);
    top.appendChild(tr);
    cb.appendChild(top);

    const grid = el('div', { class: 'pg-role-grid' });
    for (const code of ROLE_ORDER) {
      const r = GUA_ROSTER.find((x) => x.code === code);
      const count = exposedByRole[code] || 0;
      const active = activeRole === code;
      const b = el('button', { class: 'pg-role-tab' + (active ? ' on' : ''), type: 'button' });
      b.appendChild(el('span', { class: 'pg-role-tab-ico' }, r.icon));
      b.appendChild(el('span', { class: 'pg-role-tab-count' }, String(count)));
      b.appendChild(el('div', { class: 'pg-role-tab-name' }, guaLabel(r)));
      b.appendChild(el('div', { class: 'pg-role-tab-desc' }, r.role));
      b.addEventListener('click', () => { activeRole = code; paint(); });
      grid.appendChild(b);
    }
    cb.appendChild(grid);
    host.appendChild(flatSection('按角色分组', null, cb));

    const role = GUA_ROSTER.find((x) => x.code === activeRole);
    const lb = el('div', {});
    const list = roleToolsOf(activeRole);
    if (!list.length) {
      lb.appendChild(el('div', { class: 'pg-empty' }, '无匹配 tool'));
    } else {
      const g = el('div', { class: 'pg-role-tool-grid' });
      for (const t of list) {
        const expFor = (t.meta && t.meta.exposed_for) || {};
        const exposedRoles = Object.keys(expFor).filter((r) => expFor[r]);
        const cell = el('div', { class: 'pg-role-tool' });
        const nm = el('div', { class: 'pg-role-tool-nm' });
        nm.appendChild(el('span', { class: 'mono' }, toolName(t)));
        nm.appendChild(el('span', { class: 'pg-badge pg-badge-ok' }, '✓ impl'));
        for (const r of exposedRoles) {
          nm.appendChild(el('span', { class: 'pg-badge mono' },
            META_ROLE_LABELS[r] || r));
        }
        cell.appendChild(nm);
        cell.appendChild(el('div', { class: 'pg-hint' }, toolDesc(t)));
        g.appendChild(cell);
      }
      lb.appendChild(g);
    }
    host.appendChild(flatSection(
      role.icon + ' ' + guaLabel(role) + ' (' + activeRole + ')',
      roleToolsOf(activeRole).length + ' 个可调工具', lb));
  }

  const toolName = (t) => (t.function && t.function.name) || '(unnamed)';
  const toolDesc = (t) => (t.function && t.function.description) || '(无描述)';
  const toolExposedFor = (t, role) => !!(t.meta && t.meta.exposed_for && t.meta.exposed_for[role]);

  function roleToolsOf(role) {
    const q = filter.trim().toLowerCase();
    return rawTools.filter((t) => {
      if (!toolExposedFor(t, role)) return false;
      if (!q) return true;
      return toolName(t).toLowerCase().includes(q) || toolDesc(t).toLowerCase().includes(q);
    });
  }

  function groupMap() {
    const g = {};
    for (const n of Object.keys(tools)) {
      const t = tools[n];
      (g[t.group] = g[t.group] || []).push([n, t]);
    }
    return g;
  }

  async function load() {
    const r = await api.panguTools();
    const list = Array.isArray(r && r.tools) ? r.tools : [];
    rawTools = list;
    exposedByRole = (r && r.exposed_by_role) || {};
    const map = {};
    for (const t of list) {
      const name = toolName(t);
      if (!name) continue;
      const tier = (t.meta && t.meta.tier) || t.tier || '';
      map[name] = {
        enabled: !((t.meta && t.meta.enabled === false) || t.enabled === false),
        group: TIER_GROUP[tier] || '其他',
        desc: String((t.function && t.function.description) || '').slice(0, 120),
        roles: t.roles || [],
        exposed: t.exposed || {},
      };
    }
    if (!Object.keys(map).length) {
      for (const t of FALLBACK) {
        map[t.name] = { enabled: true, group: t.group, desc: t.desc, roles: [], exposed: {} };
      }
    }
    tools = map;
    paint();
  }

  async function toggleTool(n) {
    const next = !tools[n].enabled;
    try {
      const r = await api.toolsToggle(n, next);
      if (r && r.ok === false) { toast('开关失败: ' + ((r && r.error) || 'unknown'), true); return; }
    } catch (e) {
      toast('开关失败: ' + (e.message || e), true);
      return;
    }
    tools = Object.assign({}, tools, { [n]: Object.assign({}, tools[n], { enabled: next }) });
    paint();
  }

  async function loadSchema(name) {
    schema = null;
    testResult = null;
    try {
      const r = await api.toolSchema(name);
      schema = r.schema || { error: 'no schema' };
      const fn = schema.function || schema;
      const props = (fn.parameters && fn.parameters.properties) || {};
      const required = (fn.parameters && fn.parameters.required) || [];
      const example = {};
      for (const k of required) {
        const p = props[k] || {};
        if (p.type === 'string') example[k] = '';
        else if (p.type === 'number') example[k] = 0;
        else if (p.type === 'boolean') example[k] = false;
        else if (p.type === 'array') example[k] = [];
        else if (p.type === 'object') example[k] = {};
      }
      testParams = JSON.stringify(example, null, 2);
    } catch (e) {
      schema = { error: e.message || String(e) };
    }
    paint();
  }

  async function runTest() {
    if (!selected) return;
    let params;
    try {
      params = JSON.parse(testParams);
    } catch (e) {
      testResult = { ok: false, error: { code: 'BAD_JSON', message: 'JSON 解析失败: ' + e.message } };
      paint();
      return;
    }
    testRunning = true;
    testResult = null;
    paint();
    try {
      testResult = await api.toolTest(selected, params);
    } catch (e) {
      testResult = { ok: false, error: { code: 'NETWORK', message: e.message } };
    }
    testRunning = false;
    paint();
  }

  paint();
  await load();
  return {};
}

export default render;
