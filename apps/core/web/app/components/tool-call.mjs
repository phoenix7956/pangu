// tool-call.mjs —— 工具调用卡片 (原版 `components/ToolCall.tsx`)
//
// 2026-08-11 上线, 每张卡显示: 工具名 + 参数摘要 + 状态色 + 耗时 + 错误信息。
// 状态: started(蓝) / completed(绿) / failed(红) / blocked(橙)
import { el, elHTML, iconHTML } from '../lib/util.mjs';

const STATUS_LABEL = {
  in_progress: '运行中',
  started: '运行中',
  blocked: '需批准',
  failed: '失败',
  completed: '完成',
};

// 状态色**不再写死十六进制** —— 原来这四档 (蓝 #3b82f6 / 橙 #f59e0b / 红 #ef4444 /
// 绿 #10b981) 是从 Tailwind 抄来的, 深色主题下是四个跟整套配色无关的亮片。
// 现在只给「状态名」, 颜色交给 CSS 的 [data-status] 去取主题 token。
const TOOL_ICONS = {
  file_read: 'file',
  file_write: 'pen-tool',
  file_edit: 'wrench',
  run_command: 'terminal',
  web_search: 'search',
  web_fetch: 'globe',
  todo_write: 'list',
  task_done: 'check-circle',
  git_commit: 'package',
  memory_search: 'brain',
  memory_write: 'database',
};

export function getToolStatus(result, blocked) {
  if (blocked) return 'blocked';
  if (result == null) return 'in_progress';
  if (result.ok === false) return 'failed';
  if (result.ok === true) return 'completed';
  return 'in_progress';
}

function fmtParams(p) {
  if (!p || typeof p !== 'object') return '';
  // 去掉内部字段 (ctx / _depends_on_results / _callCount 等)
  const visible = {};
  for (const k of Object.keys(p)) {
    if (k.startsWith('_')) continue;
    if (k === 'depends_on' || k === 'parallel_group') continue;
    visible[k] = p[k];
  }
  let json;
  try { json = JSON.stringify(visible, null, 2); } catch (_) { return ''; }
  if (json.length > 240) return json.slice(0, 240) + '…';
  return json;
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return '';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
}

export function renderToolCall(props) {
  const p = props || {};
  const status = getToolStatus(p.result, p.blocked);
  const iconName = TOOL_ICONS[p.name] || 'code';
  const paramsStr = fmtParams(p.params);
  const dur = p.endTs && p.ts ? fmtDuration(p.endTs - p.ts) : '';
  const errMsg = p.reason
    || (p.result && p.result.error && (p.result.error.message || p.result.error))
    || (p.result && p.result.error) || '';

  const box = el('div', { class: 'pg-toolcall', 'data-status': status });

  const head = el('div', { class: 'pg-toolcall-head' });
  head.appendChild(elHTML('span', { class: 'pg-toolcall-title' },
    iconHTML(iconName, 13) + '<span>' + (p.name || '未知工具') + '</span>'));
  const right = el('span', { class: 'pg-toolcall-right' });
  if (dur) right.appendChild(el('span', { class: 'pg-toolcall-dur' }, dur));
  const chip = el('span', { class: 'pg-toolcall-chip' }, STATUS_LABEL[status] || status);
  right.appendChild(chip);
  head.appendChild(right);
  box.appendChild(head);

  if (paramsStr) box.appendChild(el('pre', { class: 'pg-toolcall-params' }, paramsStr));

  if ((status === 'failed' || status === 'blocked') && errMsg) {
    const e = elHTML('div', { class: 'pg-toolcall-err pg-ico-line' },
      iconHTML(status === 'blocked' ? 'shield' : 'alert-triangle', 12)
      + '<span>' + (status === 'blocked' ? '需老板批准: ' : '错误: ')
      + String(errMsg).slice(0, 240) + '</span>');
    e.style.color = 'var(--tc-color)';
    box.appendChild(e);
  }
  return box;
}

export default renderToolCall;
