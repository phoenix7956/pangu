// hexagram-card.mjs —— 卦象卡片
//
// 从原版 `components/HexagramCard.jsx` (git 110661d^) 搬过来。
// 版面 / 字段 / 文案原样保留; Tailwind 类换成 components.css 里的原生类。

import { el, elHTML, esc, iconHTML } from '../lib/util.mjs';
import { TRIGRAM_WX } from '../lib/yao.mjs';

const HEXAGRAM_SYMBOLS = {
  1: '☰', 2: '☱', 3: '☲', 4: '☳',
  5: '☴', 6: '☵', 7: '☶', 8: '☷',
};

const WUXING_CLASS = {
  '金': 'pg-wx-jin',
  '木': 'pg-wx-mu',
  '水': 'pg-wx-shui',
  '火': 'pg-wx-huo',
  '土': 'pg-wx-tu',
};

/**
 * @param {object} gua 卦象载荷 (guaVector / interpretation_short / moou / duan / risks / confidence)
 * @param {{scenario?:string}} [opts]
 */
export function renderHexagramCard(gua, opts) {
  if (!gua) return null;
  const o = opts || {};
  const v = gua.guaVector || {};
  const upperName = (v.upperBagua && v.upperBagua.name) || '?';
  const lowerName = (v.lowerBagua && v.lowerBagua.name) || '?';
  const upperSym = (v.upperBagua && v.upperBagua.symbol) || '';
  const lowerSym = (v.lowerBagua && v.lowerBagua.symbol) || '';
  const guaWuxing = v.guaWuxing || '';
  const wuxingRel = v.wuxingRel || '';
  const liuQin = v.liuQin || '';
  const yaoName = v.yaoName || '?';
  const positionNature = v.positionNature || '';
  const yaoCi = v.yaoCi || '';
  const interpretation = gua.interpretation_short || '';
  const moou = gua.moou || null;
  const duan = gua.duan || null;
  const risks = Array.isArray(gua.risks) ? gua.risks : [];
  const confidence = gua.confidence;

  const card = el('div', { class: 'pg-gua-card' });

  // 顶部: 卦象 + interpretation_short
  const head = el('div', { class: 'pg-gua-head' });
  const sym = el('div', { class: 'pg-gua-symbol' });
  sym.appendChild(el('div', {}, upperSym));
  sym.appendChild(el('div', {}, lowerSym));
  head.appendChild(sym);
  const headText = el('div', { class: 'pg-gua-headtext' });
  const tags = el('div', { class: 'pg-gua-tags' });
  // 2026-11-04 (颜色对照): 「乾上坤下」的上下卦名各染自己的五行墨色 ——
  //   跟将灵卦印、六十四卦读卦面板同一套语言 (pg-wx-* 是组件库已有的五行字色类)。
  const nameSpan = el('span', { class: 'pg-gua-name' });
  const upWx = TRIGRAM_WX[upperName];
  const loWx = TRIGRAM_WX[lowerName];
  nameSpan.appendChild(upWx
    ? el('span', { class: WUXING_CLASS[upWx] }, upperName)
    : document.createTextNode(upperName));
  nameSpan.appendChild(document.createTextNode('上'));
  nameSpan.appendChild(loWx
    ? el('span', { class: WUXING_CLASS[loWx] }, lowerName)
    : document.createTextNode(lowerName));
  nameSpan.appendChild(document.createTextNode('下'));
  tags.appendChild(nameSpan);
  if (guaWuxing) {
    tags.appendChild(el('span', { class: 'pg-badge ' + (WUXING_CLASS[guaWuxing] || '') }, '五行 ' + guaWuxing));
  }
  tags.appendChild(el('span', { class: 'pg-badge pg-badge-gold' }, '动爻 ' + yaoName));
  if (positionNature) tags.appendChild(el('span', { class: 'pg-badge' }, positionNature));
  headText.appendChild(tags);
  if (interpretation) headText.appendChild(el('p', { class: 'pg-gua-ci' }, interpretation));
  head.appendChild(headText);
  card.appendChild(head);

  // 中部: 三维数据
  const grid = el('div', { class: 'pg-gua-grid' });
  const cell = (label, value) => {
    const c = el('div', { class: 'pg-gua-cell' });
    c.appendChild(el('div', { class: 'pg-gua-cell-k' }, label));
    const v = el('div', { class: 'pg-gua-cell-v' });
    if (value instanceof Node) v.appendChild(value);
    else v.textContent = value || '—';
    c.appendChild(v);
    return c;
  };
  // 「金生水」逐字染五行墨色 (2026-11-04, 跟梅花页五行关系串一个做法)
  const relNode = el('span');
  for (const ch of String(wuxingRel || '')) {
    relNode.appendChild(WUXING_CLASS[ch]
      ? el('span', { class: WUXING_CLASS[ch] }, ch)
      : document.createTextNode(ch));
  }
  grid.appendChild(cell('五行关系', wuxingRel ? relNode : ''));
  grid.appendChild(cell('六亲', liuQin));
  grid.appendChild(cell('置信度', confidence != null ? (confidence * 100).toFixed(0) + '%' : ''));
  card.appendChild(grid);

  // 爻辞
  if (yaoCi) {
    const ci = el('div', { class: 'pg-gua-yao' });
    ci.appendChild(el('span', { class: 'pg-gua-yao-k' }, '爻辞 · '));
    ci.appendChild(el('span', { class: 'pg-gua-yao-v' },
      yaoCi.length > 60 ? yaoCi.slice(0, 60) + '...' : yaoCi));
    card.appendChild(ci);
  }

  // 底部: 建议 / 推理 / 风险
  if ((duan && duan.recommendation) || (moou && moou.reasoning) || risks.length) {
    const body = el('div', { class: 'pg-gua-body' });
    if (duan && duan.recommendation) {
      const r = el('div', { class: 'pg-gua-line' });
      r.appendChild(elHTML('span', { class: 'pg-gua-line-k pg-ico-line' },
        iconHTML('file', 12) + '<span>建议 · </span>'));
      r.appendChild(el('span', {}, duan.recommendation));
      body.appendChild(r);
    }
    if (moou && moou.reasoning) {
      const det = el('details', { class: 'pg-gua-details' });
      det.appendChild(elHTML('summary', { class: 'pg-ico-line' },
        iconHTML('brain', 12) + '<span>推理 (LLM reasoning)</span>'));
      det.appendChild(el('p', { class: 'pg-gua-details-body' },
        moou.reasoning.length > 300 ? moou.reasoning.slice(0, 300) + '...' : moou.reasoning));
      body.appendChild(det);
    }
    if (risks.length) {
      const det = el('details', { class: 'pg-gua-details' });
      det.appendChild(elHTML('summary', { class: 'pg-ico-line' },
        iconHTML('alert-triangle', 12) + '<span>风险 (' + risks.length + ' 项)</span>'));
      const ul = el('ul', { class: 'pg-gua-risks' });
      for (const r of risks.slice(0, 5)) {
        const text = typeof r === 'string' ? r : (r.risk || r.name || JSON.stringify(r).slice(0, 100));
        ul.appendChild(el('li', {}, '· ' + text));
      }
      det.appendChild(ul);
      body.appendChild(det);
    }
    card.appendChild(body);
  }

  // footer: 场景 + 来源
  const foot = el('div', { class: 'pg-gua-foot' });
  foot.appendChild(el('span', {}, '场景: ' + (o.scenario || '—')));
  foot.appendChild(elHTML('span', { class: 'pg-gua-src pg-ico-line' },
    iconHTML('sparkles', 12) + '<span>盘古 8 维推理</span>'));
  card.appendChild(foot);

  return card;
}

export default renderHexagramCard;

