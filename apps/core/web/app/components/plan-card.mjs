// plan-card.mjs —— 计划卡 (原版 components/PlanViewer.tsx)
//
// 从原版 `components/PlanViewer.tsx` (git 110661d^) 搬过来。
//
// 原版两条要紧的教训, 一并搬:
//   ① 一行只画「谁干 + 干什么」两样 —— 原来 `tool || text` 让 text 永远不画,
//      五步全渲染成同一个 checker。
//   ② LOW 徽章删掉 —— 实机五步全是 LOW, 五个一模一样的药丸不传递信息。

import { el } from '../lib/util.mjs';

const MARK = {
  done: '✓',
  running: '●',
  error: '✗',
  unknown: '·',
};

const ACCENT = {
  done: 'pg-plan-done',
  running: 'pg-plan-running',
  error: 'pg-plan-error',
  unknown: 'pg-plan-unknown',
};

/**
 * @param {object} plan 归一后的计划 { plan_id, task, steps[], summary, risks }
 * @param {{stepStates?:string[], ts?:number}} [opts]
 */
export function renderPlanCard(plan, opts) {
  if (!plan) return null;
  const o = opts || {};
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const states = steps.map((_, i) => (o.stepStates && o.stepStates[i]) || 'unknown');
  const nDone = states.filter((s) => s === 'done').length;
  const nRun = states.filter((s) => s === 'running').length;
  const nFail = states.filter((s) => s === 'error').length;

  const verdict = nFail > 0 ? `✗ ${nFail} 步失败`
    : nRun > 0 ? `${nDone}/${steps.length} 完成 · ${nRun} 在跑`
      : (nDone === steps.length && steps.length > 0) ? `✓ ${steps.length} 步全部完成`
        : `${nDone}/${steps.length} 完成`;

  const card = el('div', { class: 'pg-plan' });
  const head = el('button', { class: 'pg-plan-head', type: 'button' });
  head.appendChild(el('span', { class: 'pg-plan-caret' }, '▸'));
  head.appendChild(el('span', { class: 'pg-plan-title' }, '计划'));
  if (plan.task) head.appendChild(el('span', { class: 'pg-plan-task' }, plan.task));
  const verdictEl = el('span', {
    class: 'pg-plan-verdict ' + (nFail > 0 ? 'is-fail' : nRun > 0 ? 'is-run' : ''),
  }, verdict);
  if (o.ts) {
    const d = new Date(o.ts);
    const p = (n) => String(n).padStart(2, '0');
    verdictEl.appendChild(el('span', { class: 'pg-plan-ts' },
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())));
  }
  head.appendChild(verdictEl);
  card.appendChild(head);

  const body = el('div', { class: 'pg-plan-body' });
  if (plan.summary) {
    // 第 138 批: 原来这里是 "Summary" / "⚠️ Risks" —— 中文界面里夹英文标签 + emoji。
    body.appendChild(el('div', { class: 'pg-plan-sum-k' }, '概要'));
    body.appendChild(el('div', { class: 'pg-plan-sum' }, plan.summary));
  }
  if (Array.isArray(plan.risks) && plan.risks.length) {
    body.appendChild(el('div', { class: 'pg-plan-sum-k' }, '风险'));
    const rs = el('div', { class: 'pg-plan-risks' });
    for (const r of plan.risks) rs.appendChild(el('span', { class: 'pg-badge pg-badge-red' }, String(r)));
    body.appendChild(rs);
  }
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const st = states[i];
    const hasTool = !!s.tool;
    const hasText = !!s.text && String(s.text).trim() !== String(s.tool || '').trim();
    const row = el('div', { class: 'pg-plan-step ' + (ACCENT[st] || '') });
    row.appendChild(el('span', { class: 'pg-plan-mark' }, MARK[st] || '·'));
    const txt = el('div', { class: 'pg-plan-text' });
    const line = el('div', { class: 'pg-plan-line' });
    if (hasTool) line.appendChild(el('span', { class: 'pg-plan-tool' }, s.tool));
    const risk = s.risk || 'low';
    if (risk !== 'low') {
      line.appendChild(el('span', {
        class: 'pg-badge ' + (risk === 'high' ? 'pg-badge-red' : 'pg-badge-gold'),
      }, risk === 'high' ? '高风险' : '中风险'));
    }
    txt.appendChild(line);
    if (hasText) txt.appendChild(el('div', { class: 'pg-plan-desc' }, String(s.text).trim()));
    row.appendChild(txt);
    body.appendChild(row);
  }
  card.appendChild(body);

  // 默认收起 —— 原版老板批注「显示的太大了, 点击放开详情」
  body.hidden = true;
  head.addEventListener('click', () => {
    body.hidden = !body.hidden;
    head.querySelector('.pg-plan-caret').textContent = body.hidden ? '▸' : '▾';
  });
  return card;
}

export default renderPlanCard;

