// settings/permission.mjs —— 设置 · 权限 (6 级)
//
// 从原版 `apps/desktop/src/views/settings/Permission.jsx` (git 110661d^) 搬过来。
// 后端 PERMISSION_LEVELS: default / plan / acceptEdits / bypassPermissions / dontAsk / auto

import { el, elHTML, esc, page, toast } from '../../lib/util.mjs';
import { iconHTML } from '../../lib/icons.mjs';
import { api } from '../../lib/api.mjs';

const TOOL_FLAG_LABEL = {
  allowExec: '工具',
  allowWrite: '写文件',
  allowNetwork: '网络',
  allowDangerous: '危险操作',
  promptOnDangerous: '弹审批',
  bypass: '绕过',
  dontAsk: '不询问',
  autoAsk: 'AI 判断',
};

/* 每档权限配一个矢量图标。
   以前这里直接印后端给的 emoji (🔒📋✏🤖⚠) —— 六个 emoji 混在一页里,
   字形粗细不一样、颜色不跟主题走, 跟全站其它页的描边图标完全不是一套画法。
   现在按级别 id 换 lucide 描边图标, 一页一个画法。 */
const LEVEL_ICON = {
  default: 'eye',
  plan: 'list',
  acceptEdits: 'pen-tool',
  bypassPermissions: 'shield',
  fullAccess: 'shield',
  dontAsk: 'zap',
  autoAsk: 'bot',
};

/* 权限摘要的值: 后端给的是 true / false / '5 个' 这种原始值。
   直接印出来是「写文件: true」—— 英文布尔值夹在中文界面里, 一眼就粗糙。
   布尔翻成「允许 / 禁止」, 其余原样。 */
function flagValue(v) {
  if (v === true) return '允许';
  if (v === false) return '禁止';
  return String(v);
}

const PRESET_ORDER = ['requestApproval', 'autoApprove', 'fullAccess'];
const FALLBACK_LABEL = { requestApproval: '请求批准', autoApprove: '替我审批', fullAccess: '完全访问' };
const FALLBACK_PRESET = (id) => (
  id === 'bypassPermissions' || id === 'dontAsk' ? 'fullAccess'
    : id === 'default' || id === 'plan' ? 'requestApproval'
      : 'autoApprove'
);

export async function render(root) {
  // 第 147 批: 页根 = 设计系统的页面外壳 `.pg-page` (全站页面外壳统一)。
  const host = page();
  host.classList.add('pg-settings-col');
  root.appendChild(host);

  let levels = [];
  let current = 'default';
  let loading = true;
  let saving = false;
  let error = null;

  const paint = () => {
    host.innerHTML = '';
    if (loading) {
      host.appendChild(el('div', { class: 'pg-hint' }, '加载中…'));
      return;
    }

    if (error) {
      // 第 138 批: emoji 换成矢量图标 (pg-err-line 自带红色, 图标跟着走)。
      const eLine = el('div', { class: 'pg-err-line pg-ico-line' });
      eLine.appendChild(elHTML('span', {}, iconHTML('alert-triangle', 14)));
      eLine.appendChild(el('span', {}, error));
      host.appendChild(eLine);
    }

    const cur = levels.find((l) => l.id === current);
    const banner = el('div', { class: 'pg-cur-banner' });
    banner.appendChild(el('span', { class: 'pg-hint' }, '当前级别: '));
    banner.appendChild(el('b', { class: 'pg-accent-text' }, (cur && cur.name) || current));
    if (cur && cur.preset_label) banner.appendChild(el('span', { class: 'pg-badge' }, cur.preset_label));
    if (saving) banner.appendChild(el('span', { class: 'pg-hint' }, '(切换中…)'));
    host.appendChild(banner);

    const groups = PRESET_ORDER.map((pk) => ({
      key: pk,
      label: FALLBACK_LABEL[pk],
      items: levels.filter((l) => (l.preset || FALLBACK_PRESET(l.id)) === pk),
    })).filter((g) => g.items.length > 0);
    const ungrouped = levels.filter((l) => !PRESET_ORDER.includes(l.preset || FALLBACK_PRESET(l.id)));
    if (ungrouped.length) groups.push({ key: 'other', label: '其他', items: ungrouped });

    for (const g of groups) {
      const sec = el('div', { class: 'pg-perm-group' });
      const h = el('div', { class: 'pg-perm-group-title' });
      h.appendChild(el('span', {}, (g.items[0] && g.items[0].preset_label) || g.label));
      h.appendChild(el('span', { class: 'pg-hint' }, '(' + g.items.length + ')'));
      sec.appendChild(h);
      for (const lv of g.items) {
        const isCurrent = lv.id === current || lv.current;
        const b = el('button', { class: 'pg-perm-card' + (isCurrent ? ' on' : ''), type: 'button' });
        b.disabled = saving;
        const top = el('div', { class: 'pg-perm-top' });
        const ico = el('span', { class: 'pg-perm-ico' });
        ico.innerHTML = iconHTML(LEVEL_ICON[lv.id] || 'sliders', 17);
        top.appendChild(ico);
        const box = el('div', { class: 'pg-perm-text' });
        const nm = el('div', { class: 'pg-perm-name' });
        nm.appendChild(el('b', {}, lv.name || lv.id));
        if (isCurrent) nm.appendChild(el('span', { class: 'pg-accent-text' }, ' ✓'));
        if (lv.id === 'bypassPermissions' && !isCurrent) {
          nm.appendChild(el('span', { class: 'pg-badge pg-badge-danger' }, '高风险'));
        }
        box.appendChild(nm);
        box.appendChild(el('div', { class: 'pg-perm-desc' }, lv.description || ''));
        const flags = el('div', { class: 'pg-perm-flags' });
        const summary = lv.summary || {};
        for (const k of Object.keys(summary)) {
          const v = summary[k];
          if (v === false || v === '0 个' || v === undefined) continue;
          // 第 147 批: 小标记走设计系统的 `.pg-tag` (方角、无底色, 跟正文同层)。
          flags.appendChild(el('span', { class: 'pg-tag' },
            (TOOL_FLAG_LABEL[k] || k) + ': ' + flagValue(v)));
        }
        box.appendChild(flags);
        top.appendChild(box);
        b.appendChild(top);
        b.addEventListener('click', () => selectLevel(lv.id));
        sec.appendChild(b);
      }
      host.appendChild(sec);
    }

    const note = el('div', { class: 'pg-note-box' });
    note.appendChild(el('div', { class: 'pg-note-title' }, '说明'));
    const ul = el('ul', { class: 'pg-note-list' });
    for (const line of [
      '只读: 只能查文件 / 跑只读命令, 不能写, 不能联网 (执行层硬拦, 不是标签)',
      '规划: 基础工具 + Downloads 目录写入 + 网络, 危险操作需确认',
      '接受编辑: 全部工具 + 全部路径, 危险操作弹审批',
      '完全访问: 绕过所有审批, 不受限制 (所有动作审计, 危险 op 限速 10/min)',
      '不询问: 危险操作直接执行, 不弹窗 (适合跑自动化任务)',
      '智能审批: AI 分类器判断是否询问 (默认偏向审)',
    ]) ul.appendChild(el('li', {}, line));
    note.appendChild(ul);
    note.appendChild(el('div', { class: 'pg-hint' },
      '切换会立刻生效 (写到 ~/.pangu/state/permission.json)。危险操作审批通过 SSE 推送给前端, 60s 超时默认拒绝。'));
    host.appendChild(note);
  };

  async function load() {
    loading = true;
    error = null;
    paint();
    try {
      const r = await api.permissionGet();
      if (r && r.ok) {
        const res = r.result || {};
        levels = res.levels || [];
        current = res.current || 'default';
      } else {
        error = (r && r.error && r.error.message) || (r && r.error) || 'load failed';
      }
    } catch (e) {
      error = e.message || String(e);
    }
    loading = false;
    paint();
  }

  async function selectLevel(id) {
    if (id === current || saving) return;
    // 切到「完全访问 / 不询问」= 绕过所有审批 —— 这档要二次确认,
    // 其余档位跟原版一样点一下就切。
    const target = levels.find((l) => l.id === id);
    const preset = (target && target.preset) || FALLBACK_PRESET(id);
    if (preset === 'fullAccess') {
      const nm = (target && target.name) || id;
      if (!window.confirm('切到「' + nm + '」会绕过所有审批, 危险操作不再弹窗。\n\n确定切吗?')) return;
    }
    saving = true;
    error = null;
    paint();
    try {
      const r = await api.permissionSet(id);
      if (r && r.ok) {
        current = id;
        levels = levels.map((l) => Object.assign({}, l, { current: l.id === id }));
        toast('权限级别已切到 ' + ((levels.find((l) => l.id === id) || {}).name || id));
      } else {
        error = (r && r.error && r.error.message) || (r && r.error) || 'set failed';
      }
    } catch (e) {
      error = e.message || String(e);
    }
    saving = false;
    paint();
  }

  await load();
  return {};
}

export default render;
