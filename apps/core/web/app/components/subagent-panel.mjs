// subagent-panel.mjs —— 将灵 (子 agent) 工作面板
//
// 从原版 `components/SubAgentPanel.tsx` (git 110661d^) 搬过来。
//
// 原版两条要紧的判断, 一并搬:
//   ① 默认收成**一行** (已派 N 路 · X 在跑 · Y 完成), 点击才展开分工。
//   ② 工具名是**证据**, 跟状态无关 —— 原来整段包在 `status === 'running'` 里,
//      将灵一收工工具名当场消失, 事后回看答不上「它到底用了什么工具」。

import { el, elHTML } from '../lib/util.mjs';
import { iconHTML } from '../lib/icons.mjs';
import { GUA_ROSTER, guaLabel } from '../lib/gua-roster.mjs';

const STATUS_COLOR = { running: '#3b82f6', done: '#10b981', error: '#ef4444' };
const STATUS_LABEL = { running: '运行中', done: '完成', error: '失败' };

const ROLE_ICONS = GUA_ROSTER.reduce((m, r) => {
  m[r.code] = r.icon || '';
  return m;
}, {});

const ROLE_ZH = GUA_ROSTER.reduce((m, r) => {
  m[r.code] = guaLabel(r);
  return m;
}, {});

// 刀文本的结构是「公共要求 (head) —— 只做这一项: <这一刀专属的那个>」,
// 真正区分刀次的是**后半段**。提上来当标题 —— 它是服务端自己拼的标记,
// 等于子 agent 自己的「我这一刀是啥」的口供, 比任何摘要都可信。
function knifeLabel(task) {
  const t = String(task || '');
  const m = t.match(/只做这一项[:：]\s*([^\n]+)/);
  if (!m) return t;
  const item = m[1].trim();
  const head = t.slice(0, m.index).trim().replace(/[，,;；。\s]+$/, '');
  if (head && head.length <= 28) return head + ' · ' + item;
  return '只做这一项 · ' + item;
}

const TOOL_CHIP_MAX = 4;

function renderAgentRow(agent, showModel) {
  const wrap = el('div', { class: 'pg-subagent-rowwrap' });
  const running = agent.status === 'running';
  const failed = agent.status === 'error';
  const dur = agent.startTs && agent.endTs ? Math.max(0, agent.endTs - agent.startTs) : 0;
  const durStr = dur > 1000 ? (dur / 1000).toFixed(1) + 's' : '';
  const tools = agent.tools || [];
  const shown = tools.slice(0, TOOL_CHIP_MAX);
  const restTools = tools.length - shown.length;
  const thinking = agent.thinking || 0;

  const head = el('button', { class: 'pg-subagent-head', type: 'button' });
  head.appendChild(el('span', { class: 'pg-subagent-caret' }, '▸'));
  // 第 138 批: 未知将灵的兜底原来是 emoji (🤖) —— 换成矢量图标 (八将灵本身用 ☰☱☲ 那套卦符, 保留)。
  const guaEl = el('span', { class: 'pg-subagent-gua' });
  const guaSym = ROLE_ICONS[agent.agent];
  if (guaSym) guaEl.appendChild(el('span', {}, guaSym));
  else guaEl.appendChild(elHTML('span', {}, iconHTML('bot', 15)));
  head.appendChild(guaEl);
  head.appendChild(el('span', { class: 'pg-subagent-name' }, ROLE_ZH[agent.agent] || agent.agent));
  const statusEl = el('span', { class: 'pg-subagent-status' });
  if (running) {
    statusEl.style.color = STATUS_COLOR.running;
    statusEl.appendChild(el('i', { class: 'pg-subagent-dot' }));
  } else if (failed) {
    statusEl.style.color = STATUS_COLOR.error;
  }
  statusEl.appendChild(document.createTextNode(STATUS_LABEL[agent.status] || agent.status));
  head.appendChild(statusEl);
  if (running) {
    head.appendChild(el('span', { class: 'pg-subagent-live' },
      thinking > 0 ? `思考 ${thinking} 字` : '组织回答中'));
  }
  if (showModel && agent.model) head.appendChild(el('span', { class: 'pg-subagent-model' }, agent.model));
  if (durStr) head.appendChild(el('span', { class: 'pg-subagent-dur' }, durStr));
  wrap.appendChild(head);

  const body = el('div', { class: 'pg-subagent-detailbox' });
  body.hidden = true;
  body.appendChild(el('div', { class: 'pg-subagent-task', title: agent.task || '' }, knifeLabel(agent.task)));
  if (tools.length) {
    const chips = el('div', { class: 'pg-subagent-tools' });
    for (const t of shown) chips.appendChild(el('span', { class: 'pg-subagent-tool' }, t));
    if (restTools > 0) chips.appendChild(el('span', { class: 'pg-subagent-tool more' }, '+' + restTools));
    body.appendChild(chips);
  }
  if (failed && agent.error) {
    body.appendChild(el('div', { class: 'pg-subagent-error' }, agent.error));
  }
  if (agent.summary || (agent.artifacts && agent.artifacts.length)) {
    const det = el('details', { class: 'pg-subagent-out' });
    det.appendChild(el('summary', {}, '查看产出'));
    if (agent.summary) det.appendChild(el('div', { class: 'pg-subagent-summary' }, agent.summary));
    if (agent.artifacts && agent.artifacts.length) {
      det.appendChild(el('div', { class: 'pg-subagent-art' }, '产出: ' + agent.artifacts.join(', ')));
    }
    body.appendChild(det);
  }
  wrap.appendChild(body);
  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
    head.querySelector('.pg-subagent-caret').textContent = body.hidden ? '▸' : '▾';
  });
  return wrap;
}

export function renderSubAgentPanel(agents) {
  if (!Array.isArray(agents) || agents.length === 0) return null;
  const tally = new Map();
  for (const a of agents) if (a.model) tally.set(a.model, (tally.get(a.model) || 0) + 1);
  let common = null;
  let best = -1;
  for (const [m, c] of tally) if (c > best) { best = c; common = m; }

  const running = agents.filter((a) => a.status === 'running').length;
  const failed = agents.filter((a) => a.status === 'error').length;
  const done = agents.length - running - failed;
  const scope = agents.length > 1 ? `${agents.length} 路` : '1 路';
  const stateLine = [
    running > 0 ? `${running} 在跑` : '',
    done > 0 ? `${done} 完成` : '',
    failed > 0 ? `${failed} 失败` : '',
  ].filter(Boolean).join(' · ');

  const box = el('div', { class: 'pg-subagents' });
  const head = el('button', { class: 'pg-subagents-head', type: 'button' });
  head.appendChild(el('span', { class: 'pg-subagents-caret' }, '▸'));
  head.appendChild(el('span', { class: 'pg-subagents-title' }, `已派 ${scope}`));
  const state = el('span', { class: 'pg-subagents-state' });
  if (failed) state.style.color = STATUS_COLOR.error;
  else if (running) state.style.color = STATUS_COLOR.running;
  if (running > 0) state.appendChild(el('i', { class: 'pg-subagent-dot' }));
  state.appendChild(document.createTextNode(stateLine));
  head.appendChild(state);
  head.appendChild(el('span', { class: 'pg-subagents-hint' }, '展开分工'));
  box.appendChild(head);

  const list = el('div', { class: 'pg-subagents-list' });
  list.hidden = true;
  agents.forEach((a) => {
    list.appendChild(renderAgentRow(a, !!a.model && a.model !== common));
  });
  box.appendChild(list);
  head.addEventListener('click', () => {
    list.hidden = !list.hidden;
    head.querySelector('.pg-subagents-caret').textContent = list.hidden ? '▸' : '▾';
    head.querySelector('.pg-subagents-hint').textContent = list.hidden ? '展开分工' : '收起分工';
  });
  return box;
}

export default renderSubAgentPanel;

