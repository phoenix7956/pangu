// todo-viewer.mjs —— 待办清单 (原版 components/TodoViewer.tsx)

import { el, elHTML, iconHTML } from '../lib/util.mjs';

const STATUS_ORDER = { in_progress: 0, pending: 1, completed: 2 };
const STATUS_LABEL = { in_progress: '进行中', pending: '待办', completed: '完成' };

export function renderTodoViewer(todos, ts) {
  if (!Array.isArray(todos) || todos.length === 0) return null;
  const sorted = todos.slice().sort(
    (a, b) => (STATUS_ORDER[a && a.status] || 9) - (STATUS_ORDER[b && b.status] || 9),
  );
  const box = el('div', { class: 'pg-todo' });
  const head = el('div', { class: 'pg-todo-head' });
  head.appendChild(elHTML('span', { class: 'pg-ico-line' },
    iconHTML('list', 13) + `<span>Todo (${sorted.length})</span>`));
  const nIn = sorted.filter((t) => t && t.status === 'in_progress').length;
  const nPending = sorted.filter((t) => t && t.status === 'pending').length;
  const nDone = sorted.filter((t) => t && t.status === 'completed').length;
  const tally = el('span', { class: 'pg-todo-tally' });
  if (nIn) tally.appendChild(el('span', { class: 'pg-todo-n in' }, `● ${nIn} 进行中`));
  if (nPending) tally.appendChild(el('span', { class: 'pg-todo-n wait' }, `○ ${nPending} 待办`));
  if (nDone) tally.appendChild(el('span', { class: 'pg-todo-n done' }, `✓ ${nDone} 完成`));
  if (ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    tally.appendChild(el('span', { class: 'pg-todo-n' },
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())));
  }
  head.appendChild(tally);
  box.appendChild(head);
  for (const t of sorted) {
    const st = (t && t.status) || 'pending';
    const item = el('div', { class: 'pg-todo-item' + (st === 'completed' ? ' done' : '') });
    item.appendChild(el('span', { class: 'pg-todo-box' + (st === 'completed' ? ' done' : '') }));
    item.appendChild(el('span', { class: 'pg-todo-text' }, (t && t.content) || ''));
    item.appendChild(el('span', { class: 'pg-todo-tag ' + st }, STATUS_LABEL[st] || st));
    box.appendChild(item);
  }
  return box;
}

export default renderTodoViewer;

