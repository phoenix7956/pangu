// permission-popover.mjs —— 输入框旁的权限档 (ChatGPT 风格)
//
// 从原版 `components/PermissionPopover.jsx` (git 110661d^) 搬过来。
// 4 个选项 → 后端 6 级的映射与原版一致 (与 permission.js PRESET_META 同词汇)。

import { el, elHTML, iconHTML } from '../lib/util.mjs';
import { api } from '../lib/api.mjs';
import { navigate } from '../lib/route.mjs';

const PRESET_MAP = {
  requestApproval: {
    default: 'default', label: '请求批准', icon: 'info',
    desc: '编辑外部文件和使用互联网时始终询问',
  },
  autoApprove: {
    default: 'acceptEdits', label: '替我审批', icon: 'shield',
    desc: '仅对检测到的风险操作请求批准',
  },
  fullAccess: {
    // 第 143 批: 图标原来用的是警告三角 —— "完全访问"是**默认档**, 不是风险提示,
    //   给它一个三角等于天天在报警。换成 key (一把钥匙 = 放开权限)。
    default: 'bypassPermissions', label: '完全访问', icon: 'key',
    desc: '可不受限制地访问互联网和您电脑上的任何文件',
  },
  custom: {
    default: null, label: '自定义 (config.toml)', icon: 'sliders',
    desc: '使用 config.toml 中定义的权限', toSettings: true,
  },
};

function levelToPreset(level) {
  if (!level) return 'autoApprove';
  if (level === 'bypassPermissions' || level === 'dontAsk') return 'fullAccess';
  if (level === 'default' || level === 'plan') return 'requestApproval';
  if (level === 'acceptEdits' || level === 'auto') return 'autoApprove';
  return 'autoApprove';
}

/**
 * @param {{sessionId?:string, onChange?:Function}} opts
 */
export function createPermissionPopover(opts) {
  const o = opts || {};
  let isOpen = false;
  let current = null;
  let currentName = null;
  let preset = null;
  let scopeSession = false;
  let loading = false;
  let err = null;

  const root = el('div', { class: 'pg-permission' });
  const chip = el('button', {
    class: 'pangu-permission-trigger',
    type: 'button',
    title: '切换盘古权限级别 (ChatGPT 风格)',
  });
  root.appendChild(chip);
  let panel = null;

  function paintChip() {
    const ready = preset !== null;
    const cur = PRESET_MAP[preset] || PRESET_MAP.autoApprove;
    chip.textContent = '';
    // 第 135 批: 原来这里塞的是 emoji (✋🛡⚠️⚙) —— 各平台字形不一样,
    //   而且渲染出来是一坨彩色小图, 全页唯一的彩色焦点 = 最扎眼的廉价点。
    //   ⇒ 换成图标集里同一套描边图标 (和导航栏、和按钮同一个视觉语言)。
    if (ready) {
      const ico = el('span', { class: 'pg-permission-ico', 'aria-hidden': 'true' });
      ico.innerHTML = iconHTML(cur.icon, 15);
      chip.appendChild(ico);
    } else {
      chip.appendChild(el('span', { class: 'pg-permission-ico' }, '…'));
    }
    chip.appendChild(el('span', { class: 'pg-permission-label' },
      ready ? cur.label.replace('权限', '').replace(' (config.toml)', '') : '加载中'));
    if (ready) chip.appendChild(el('span', { class: 'pg-permission-caret' }, '▾'));
    chip.setAttribute('aria-label', '操作权限：' + (ready ? cur.label : '读取中'));
    chip.classList.toggle('is-full', preset === 'fullAccess');
    // 真正需要提醒的是「请求批准」那一档 (每步都问) —— 才是受限档。
    chip.classList.toggle('is-restricted', preset === 'requestApproval');
  }

  function load() {
    loading = true;
    err = null;
    const sid = o.sessionId || '';
    return api.permissionGet(sid || undefined).then((r) => {
      if (r && r.ok) {
        current = r.result.current;
        const lvMeta = (r.result.levels || []).find((l) => l.id === current);
        preset = r.result.preset || (lvMeta && lvMeta.preset) || levelToPreset(current);
        if (lvMeta) currentName = lvMeta.name;
      } else {
        preset = levelToPreset('autoApprove');
        if (!(r && r.httpError)) {
          err = (r && r.error && r.error.message) || 'load failed';
        }
      }
    }).catch((e) => {
      err = e && e.message;
      preset = levelToPreset('autoApprove');
    }).finally(() => {
      loading = false;
      paintChip();
      if (isOpen) paintPanel();
    });
  }

  function selectPreset(key) {
    if (loading) return;
    const def = PRESET_MAP[key];
    if (!def) return;
    if (def.toSettings) {
      navigate('settings?tab=permission');
      close();
      return;
    }
    if (!def.default) return;
    loading = true;
    err = null;
    const body = { level: def.default };
    if (scopeSession && o.sessionId) {
      body.scope = 'session';
      body.sessionId = o.sessionId;
    }
    return api.permissionSet(body).then((r) => {
      if (r && r.ok) {
        current = (r.result && r.result.current) || def.default;
        preset = key;
        const lvMeta = ((r.result && r.result.levels) || []).find((l) => l.id === current);
        if (lvMeta) currentName = lvMeta.name;
        if (o.onChange) o.onChange(r.result);
        paintChip();
        if (isOpen) paintPanel();
        setTimeout(close, 800);
      } else {
        err = (r && r.error && r.error.message) || 'set failed';
        if (isOpen) paintPanel();
      }
    }).catch((e) => {
      err = e && e.message;
      if (isOpen) paintPanel();
    }).finally(() => {
      loading = false;
    });
  }

  function paintPanel() {
    if (panel) panel.remove();
    panel = el('div', { class: 'pg-permission-panel' });
    const top = el('div', { class: 'pg-permission-top' });
    top.appendChild(el('div', { class: 'pg-permission-q' }, '应如何批准盘古操作?'));
    const more = el('button', { class: 'pg-permission-more', type: 'button' }, '了解更多');
    more.addEventListener('click', () => {
      navigate('settings?tab=permission');
      close();
    });
    top.appendChild(more);
    panel.appendChild(top);
    if (err) {
      panel.appendChild(elHTML('div', { class: 'pg-permission-err pg-ico-line' },
        iconHTML('alert-triangle', 13) + '<span>' + err + '</span>'));
    }
    if (o.sessionId) {
      const lab = el('label', { class: 'pg-permission-scope' });
      const cb = el('input', { type: 'checkbox' });
      cb.checked = scopeSession;
      cb.addEventListener('change', () => { scopeSession = cb.checked; });
      lab.appendChild(cb);
      lab.appendChild(el('span', {}, '仅本次对话 (24h 临时)'));
      panel.appendChild(lab);
    }
    const list = el('div', { class: 'pg-permission-list' });
    for (const key of Object.keys(PRESET_MAP)) {
      const def = PRESET_MAP[key];
      const selected = preset === key;
      const b = el('button', {
        class: 'pg-permission-item' + (selected ? ' on' : '') + (key === 'fullAccess' ? ' full' : ''),
        type: 'button',
      });
      b.appendChild(el('span', { class: 'pg-permission-ico' }, def.icon));
      const txt = el('div', { class: 'pg-permission-text' });
      const lab2 = el('div', { class: 'pg-permission-label2' });
      lab2.appendChild(document.createTextNode(def.label));
      if (selected) lab2.appendChild(el('span', {}, ' ✓'));
      txt.appendChild(lab2);
      txt.appendChild(el('div', { class: 'pg-permission-desc' }, def.desc));
      b.appendChild(txt);
      b.addEventListener('click', () => selectPreset(key));
      list.appendChild(b);
    }
    panel.appendChild(list);
    const foot = el('div', { class: 'pg-permission-foot' });
    foot.appendChild(document.createTextNode('当前: '));
    foot.appendChild(el('b', {}, currentName || current || '?'));
    if (scopeSession && o.sessionId) foot.appendChild(el('span', {}, '(仅 session)'));
    panel.appendChild(foot);
    root.appendChild(panel);
  }

  function open() {
    isOpen = true;
    paintPanel();
    setTimeout(() => {
      document.addEventListener('mousedown', onDocDown);
      document.addEventListener('keydown', onKey);
    }, 0);
  }

  function close() {
    isOpen = false;
    if (panel) { panel.remove(); panel = null; }
    document.removeEventListener('mousedown', onDocDown);
    document.removeEventListener('keydown', onKey);
  }

  function onDocDown(e) {
    if (panel && !root.contains(e.target)) close();
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  chip.addEventListener('click', () => {
    if (isOpen) close(); else open();
  });

  paintChip();
  load();

  return {
    root,
    destroy() { close(); },
  };
}

export default createPermissionPopover;

