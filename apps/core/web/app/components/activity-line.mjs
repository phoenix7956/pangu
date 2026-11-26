// activity-line.mjs —— 活动行 (一行一事件)
//
// 从原版 `components/ActivityLine.tsx` (git 110661d^) 搬过来。
//
// 为什么是「一行」而不是卡片: 2026-08-11 工具卡片上线, 一屏十几张卡把回答挤下去;
// 2026-10-09 老板说「蓝框能不能不显示」, 于是卡片整个关掉 —— 界面于是像死机
// (老板原话「一直感觉死的」)。两头都不对, 一行一事件是中间态。

import { el, elHTML, iconHTML } from '../lib/util.mjs';

// 工具名 → 一眼能懂的动作词。
const TOOL_VERB = {
  read_file: '读文件',
  write_file: '写文件',
  file_edit: '改文件',
  list_directory: '列目录',
  search_files: '找文件',
  exec_command: '执行命令',
  task_done: '收口',
  system_info: '看系统',
  process_list: '看进程',
  memory_write: '写记忆',
  memory_recall: '读记忆',
  web_search: '搜网络',
  gua_cast: '起卦',
  situation_check: '看局面',
  self_monitor: '自检',
};

const VERB_FALLBACK = '调用';

/**
 * 从参数里挑出**最像人话**的那一个 (路径 / 命令 / 问题 / URL …)。
 * 工具参数动辄几十个字段, 整坨 JSON.stringify 出来没人看。
 */
export function pickDetail(params, fitWidth) {
  if (!params || typeof params !== 'object') return '';
  const PREFERRED = [
    'path', 'file_path', 'file', 'filepath',
    'command', 'cmd',
    'query', 'q',
    'url',
    'pattern',
    'name',
  ];
  let raw = '';
  for (const k of PREFERRED) {
    const v = params[k];
    if (typeof v === 'string' && v.trim()) { raw = v.trim(); break; }
    if (typeof v === 'number') { raw = String(v); break; }
  }
  if (!raw) {
    const first = Object.values(params).find((v) => typeof v === 'string' && v.trim());
    raw = first ? String(first).trim() : '';
  }
  if (!raw) return '';
  // 换行压平: 多行参数会把这一行撑成一大坨, 破坏「一行一事件」
  const flat = raw.replace(/\s*\n+\s*/g, ' ⏎ ');
  return flat.length > fitWidth ? flat.slice(0, Math.max(8, fitWidth - 1)) + '…' : flat;
}

function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

/**
 * 画一行活动。
 * @param {{kind?:string,name?:string,detail?:string,status?:string,durationMs?:number,chars?:number,ts?:number}} props
 */
export function renderActivityLine(props) {
  const p = props || {};
  const kind = p.kind || 'tool';
  const name = p.name || '';
  const detail = p.detail || '';
  const status = p.status == null ? null : p.status;
  const durationMs = p.durationMs == null ? null : p.durationMs;
  const chars = p.chars || 0;
  const ts = p.ts;
  const running = status === 'running';

  // 原来思考是 💭 / 工具是 🔧 两个 emoji —— 换矢量图标。
  // 第 161 批: agent 那一支原来是一个通用的「将」字 —— 八个将灵长得一模一样,
   //   分不清是哪一个在干活。现在塞**它自己的卦象**进去 (见 guaMark 参数)。
  const glyph = kind === 'thinking' ? 'brain' : 'wrench';

  let label;
  if (kind === 'thinking') {
    label = running ? '思考中' : '思考';
  } else if (kind === 'agent') {
    label = name;
  } else {
    label = `${VERB_FALLBACK} ${TOOL_VERB[name] || name}`.trim();
  }

  const detailText = detail || (kind === 'thinking' && running
    ? (chars > 0 ? `${chars.toLocaleString()} 字` : '…')
    : '');

  const dur = fmtDuration(durationMs);
  const stateCls = status === 'ok' ? 'is-ok'
    : (status === 'fail' || status === 'blocked') ? 'is-fail'
      : status === 'running' ? 'is-running' : '';
  const mark = running ? '◌' : status === 'ok' ? '✓'
    : status === 'fail' ? '✗' : status === 'blocked' ? '⊘' : '';

  const row = el('div', {
    class: 'pg-activity ' + stateCls,
    title: detail || name || '',
  });
  const ico = el('span', { class: 'pg-act-ico' });
  if (p.guaMark) {
    // 卦象塞进图标位: 三爻柱微缩版 (14px), 不带卦名 —— 名字在右边那一列。
    ico.appendChild(p.guaMark);
    ico.classList.add('is-gua');
  } else {
    ico.innerHTML = iconHTML(glyph, 14);
  }
  row.appendChild(ico);
  // nameNode (2026-11-04): 将灵名带五行墨色时用节点, 纯文本仍走 label。
  const nameEl = el('span', { class: 'pg-act-name' });
  if (p.nameNode instanceof Node) nameEl.appendChild(p.nameNode);
  else nameEl.textContent = label;
  row.appendChild(nameEl);
  if (detailText) {
    row.appendChild(el('span', { class: 'pg-act-detail' }, detailText));
  } else {
    row.appendChild(el('span', { class: 'pg-act-detail' }));
  }
  if (dur) row.appendChild(el('span', { class: 'pg-act-time' }, dur));
  row.appendChild(el('span', { class: 'pg-act-time pg-act-mark' }, mark));
  if (ts) {
    const d = new Date(ts);
    const p2 = (n) => String(n).padStart(2, '0');
    row.appendChild(el('span', { class: 'pg-act-time' },
      p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())));
  }
  return row;
}

export default renderActivityLine;

