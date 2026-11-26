// diff-viewer.mjs —— 改动可视化 (原版 components/DiffViewer.tsx)

import { el, elHTML, iconHTML } from '../lib/util.mjs';

const MAX_LINES = 500;

function parseDiff(diffText) {
  if (!diffText) return [];
  const parsed = [];
  for (const line of String(diffText).split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) parsed.push({ type: 'hunk', text: line });
    else if (line.startsWith('@@')) parsed.push({ type: 'hunk', text: line });
    else if (line.startsWith('+')) parsed.push({ type: 'add', text: line });
    else if (line.startsWith('-')) parsed.push({ type: 'del', text: line });
    else if (line.startsWith('diff --git') || line.startsWith('index ')) { /* git 元数据, 跳过 */ }
    else parsed.push({ type: 'ctx', text: line });
  }
  return parsed;
}

export function renderDiffViewer(opts) {
  const o = opts || {};
  const box = el('div', { class: 'pg-diff' });
  const head = el('div', { class: 'pg-diff-head' });
  head.appendChild(elHTML('span', { class: 'pg-ico-line' },
    iconHTML('pen-tool', 12)
    + '<span>' + (o.file || '') + (o.changes != null && o.changes > 0 ? ` (${o.changes} 处)` : '') + '</span>'));
  const tabs = el('span', { class: 'pg-diff-tabs' });
  const body = el('div', { class: 'pg-diff-body' });
  const mk = (id, label) => {
    const b = el('button', { class: 'pg-diff-tab', type: 'button' }, label);
    b.addEventListener('click', () => {
      for (const t of tabs.querySelectorAll('.pg-diff-tab')) t.classList.remove('on');
      b.classList.add('on');
      paint(id);
    });
    return b;
  };
  const paint = (mode) => {
    body.innerHTML = '';
    if (mode === 'before') {
      body.appendChild(el('pre', {}, String(o.before || '').slice(0, 50000)));
      return;
    }
    if (mode === 'after') {
      body.appendChild(el('pre', {}, String(o.after || '').slice(0, 50000)));
      return;
    }
    const parsed = parseDiff(o.diff || '');
    const visible = parsed.length > MAX_LINES ? parsed.slice(0, MAX_LINES) : parsed;
    for (const l of visible) {
      body.appendChild(el('div', { class: 'pg-diff-line ' + l.type }, l.text));
    }
    if (parsed.length > MAX_LINES) {
      body.appendChild(el('div', { class: 'pg-diff-line hunk' },
        `… 截断到 ${MAX_LINES} 行（总共 ${parsed.length} 行）`));
    }
  };
  const t1 = mk('unified', 'Diff');
  t1.classList.add('on');
  tabs.appendChild(t1);
  tabs.appendChild(mk('before', 'Before'));
  tabs.appendChild(mk('after', 'After'));
  head.appendChild(tabs);
  box.appendChild(head);
  paint('unified');
  box.appendChild(body);
  return box;
}

export default renderDiffViewer;

