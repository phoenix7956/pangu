// progress-bar.mjs —— 进度条 + ETA (原版 components/ProgressBar.tsx)

import { el, elHTML, iconHTML } from '../lib/util.mjs';
import { GUA_ROSTER, guaLabel } from '../lib/gua-roster.mjs';

function fmtDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

export function renderProgressBar(data) {
  if (!data) return null;
  const agentCode = data.current_agent || null;
  const info = agentCode ? GUA_ROSTER.find((r) => r.code === agentCode) : null;
  const guaLabelText = info ? `${info.icon} ${guaLabel(info)}` : (data.current_gua || '');
  const percent = data.percent != null ? Math.max(0, Math.min(100, data.percent)) : 0;
  const status = data.status || 'progress';
  const partial = percent >= 100 && (data.remaining || 0) > 0;
  const done = status === 'done' && (data.remaining || 0) === 0;
  const failed = status === 'failed' && data.severity === 'high';
  const softFail = status === 'failed' && data.severity !== 'high';
  const color = failed ? 'var(--red)' : (softFail || partial) ? 'var(--orange)'
    : done ? 'var(--green)' : 'var(--primary)';

  const box = el('div', { class: 'pg-progress' });
  const head = el('div', { class: 'pg-progress-head' });
  // 徽标走矢量图标 (原来 ✅/📊/⚠️ 三个 emoji 混在文字里, 字号基线对不齐)
  const badge = failed ? 'alert-triangle' : done ? 'check-circle' : 'activity';
  let left = 'Progress';
  if (data.current != null && data.total != null) left += ` ${data.current}/${data.total} 步`;
  left += ` (${percent}%`;
  if (partial) left += ` · 剩余 ${data.remaining} 步`;
  left += ')';
  if (data.calls != null && data.current != null && data.calls > data.current) left += ` · 已调 ${data.calls} 次`;
  head.appendChild(elHTML('span', { class: 'pg-ico-line' },
    iconHTML(badge, 12)
    + '<span>' + (guaLabelText && !done ? guaLabelText + ' · ' : '') + left + '</span>'));
  head.appendChild(el('span', { class: 'pg-progress-step' },
    data.current_step || (failed && data.failed_step) || ''));
  box.appendChild(head);

  const bar = el('div', { class: 'pg-progress-bar' });
  const fill = el('i');
  fill.style.width = percent + '%';
  fill.style.background = color;
  bar.appendChild(fill);
  box.appendChild(bar);

  const meta = el('div', { class: 'pg-progress-meta' });
  let leftText = '—';
  if ((failed || softFail) && data.reason) leftText = 'Reason: ' + data.reason;
  else if (done && data.total_duration_ms != null) leftText = 'Total: ' + fmtDuration(data.total_duration_ms);
  else if (data.eta_ms != null) leftText = 'ETA: ' + fmtDuration(data.eta_ms);
  meta.appendChild(el('span', {}, leftText));
  if (data.ts) {
    const d = new Date(data.ts);
    const p = (n) => String(n).padStart(2, '0');
    meta.appendChild(el('span', {}, p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())));
  }
  box.appendChild(meta);
  return box;
}

export default renderProgressBar;

