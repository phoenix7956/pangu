// evolution.mjs —— 进化: 自进化闭环的逐日账本
//
// 这一页回答一个问题: **盘古这些天自己变好了没有?**
// 账本 (L1) 每天一个 jsonl, 一行一次任务; 之前这些数字只在命令行里躺着,
// 没人天天去 cat。现在把它画出来: 任务量 / 成功率 / 耗时 / 工具 / 模型。
//
// 图表库: plotly.js (MIT) 的 **basic 离线分包**, 放在 vendor/ 里, 本机伺服。
//   · 不引 CDN —— 盘古可能整个离线跑, 也不能把用户的浏览行为发出去;
//   · 不进 index.html —— 1 MB 的包只有这一页用得上, 按需加载 (见 loadPlotly);
//   · 不用 Dash / plotly.py —— 那是 Python 服务, 会给盘古凭空多一个进程,
//     跟「单进程 Node 内核 + 零构建工作台」的设计相反。
import { el, esc, page, flatSection, tiles, footband, table } from '../lib/util.mjs';
import { api } from '../lib/api.mjs';

// ── 图表库按需加载 ─────────────────────────────────────────────
let plotlyPromise = null;

function loadPlotly() {
  if (window.Plotly) return Promise.resolve(window.Plotly);
  if (plotlyPromise) return plotlyPromise;
  plotlyPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    // 相对地址 ⇒ 跟着基址走 (盘古挂在 /pangu/ 这种子路径下也不丢前缀)
    s.src = 'vendor/plotly-basic.min.js';
    s.async = true;
    s.onload = () => (window.Plotly
      ? resolve(window.Plotly)
      : reject(new Error('plotly 加载了但没挂上 window.Plotly')));
    s.onerror = () => reject(new Error('vendor/plotly-basic.min.js 加载失败'));
    document.head.appendChild(s);
  }).catch((e) => { plotlyPromise = null; throw e; });
  return plotlyPromise;
}

// ── 配色: 跟着盘古的四套纸走 ───────────────────────────────────
function palette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, fb) => (cs.getPropertyValue(n) || '').trim() || fb;
  return {
    bg: v('--card', '#111214'),
    fg: v('--text', '#D6D9DC'),
    dim: v('--text-dim', '#9AA0A6'),
    muted: v('--text-muted', '#6B7178'),
    grid: v('--hairline', 'rgba(255,255,255,.07)'),
    accent: v('--accent', '#F0704F'),
    green: v('--green', '#5DDDB8'),
    gold: v('--text-gold', '#D9B570'),
    primary: v('--primary', '#5DDDB8'),
  };
}

function baseLayout(p) {
  return {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'inherit', size: 12, color: p.dim },
    margin: { l: 44, r: 44, t: 24, b: 34 },
    hoverlabel: {
      bgcolor: p.bg, bordercolor: p.grid, font: { size: 12, color: p.fg },
    },
    xaxis: {
      gridcolor: p.grid, zerolinecolor: p.grid, linecolor: p.grid,
      tickfont: { size: 11, color: p.muted },
      title: { font: { size: 11, color: p.muted } },
    },
    yaxis: {
      gridcolor: p.grid, zerolinecolor: p.grid, linecolor: p.grid,
      tickfont: { size: 11, color: p.muted },
      title: { font: { size: 11, color: p.muted } },
    },
    showlegend: false,
  };
}

// ── 小工具 ────────────────────────────────────────────────────
const fmtDur = (ms) => {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' 秒';
  return (ms / 60000).toFixed(1) + ' 分钟';
};

function chartCard(host, height) {
  const wrap = el('div', { class: 'pg-evo-chart' });
  const plot = el('div', { class: 'pg-evo-plot' });
  if (height) plot.style.height = height + 'px';
  wrap.appendChild(plot);
  host.appendChild(wrap);
  return plot;
}

export async function render(root) {
  const box = page();
  root.appendChild(box);
  box.appendChild(el('div', { class: 'spinbox' }, '读账本…'));

  const [sum, ser] = await Promise.all([
    api.evolution().catch(() => ({ ok: false })),
    api.evolutionSeries().catch(() => ({ ok: false })),
  ]);

  box.innerHTML = '';

  const days = (ser && ser.data && ser.data.days) || [];
  const stats = (sum && sum.data) || {};
  const total = ser.data && ser.data.grand_total ? ser.data.grand_total : (stats.total || 0);
  const rate = stats.success_rate != null ? stats.success_rate : 0;
  const avgMs = stats.avg_duration_ms || 0;

  // ── 概览 ────────────────────────────────────────────────────
  box.appendChild(flatSection('进化概览', '账本覆盖 ' + (stats.days || 0) + ' 天', tiles([
    { k: '累计任务', v: total.toLocaleString('zh-CN') },
    { k: '成功率', v: rate + '%' },
    { k: '平均耗时', v: fmtDur(avgMs) },
    { k: '今日任务', v: String(stats.today != null ? stats.today : 0) },
    { k: '有记录天数', v: String(days.length) },
  ])));

  if (!days.length) {
    box.appendChild(flatSection('逐日账本', '没有数据', el('div', { class: 'hint' },
      '账本还是空的 —— 盘古每跑完一次任务就会在这里记一笔。')));
    return { destroy() { /* 无定时器 */ } };
  }

  const p = palette();
  const labels = days.map((d) => d.date.slice(5));   // 08-12 这种短标
  const charts = [];   // { plot, data, layout } —— 主题切换时重刷配色

  // ── 图一: 任务量 + 成功率 (双轴) ───────────────────────────
  {
    const host = el('div');
    const plot = chartCard(host, 260);
    box.appendChild(flatSection('逐日任务量与成功率', '柱子 = 当天跑了多少任务, 折线 = 其中成功的比例', host));

    const traces = [
      {
        type: 'bar', name: '任务量', x: labels, y: days.map((d) => d.total),
        marker: { color: p.primary, opacity: 0.55, line: { color: p.primary, width: 1 } },
        hovertemplate: '%{x}<br>任务 %{y} 件<extra></extra>',
      },
      {
        type: 'scatter', name: '成功率', x: labels, y: days.map((d) => d.success_rate),
        mode: 'lines+markers', line: { color: p.accent, width: 2 },
        marker: { color: p.accent, size: 5 },
        hovertemplate: '%{x}<br>成功率 %{y:.1f}%<extra></extra>',
        yaxis: 'y2',
      },
    ];
    const layout = baseLayout(p);
    layout.yaxis.title.text = '任务量';
    layout.yaxis2 = {
      title: { text: '成功率 %', font: { size: 11, color: p.muted } },
      overlaying: 'y', side: 'right', range: [0, 100],
      gridcolor: 'rgba(0,0,0,0)', tickfont: { size: 11, color: p.muted },
    };
    layout.legend = { orientation: 'h', y: -0.22, x: 0, font: { size: 11, color: p.dim } };
    layout.showlegend = true;
    layout.barmode = 'overlay';
    charts.push({ plot, data: traces, layout });
  }

  // ── 图二: 平均耗时 ──────────────────────────────────────────
  {
    const host = el('div');
    const plot = chartCard(host, 220);
    box.appendChild(flatSection('逐日平均耗时', '一次任务从发起到落账, 平均用了多久', host));

    const traces = [{
      type: 'scatter', mode: 'lines+markers',
      x: labels, y: days.map((d) => d.avg_duration_ms),
      line: { color: p.gold, width: 2, shape: 'spline', smoothing: 0.4 },
      marker: { color: p.gold, size: 4 },
      fill: 'tozeroy', fillcolor: 'rgba(217,181,112,.12)',
      hovertemplate: '%{x}<br>平均 %{y} ms<extra></extra>',
    }];
    const layout = baseLayout(p);
    layout.yaxis.title.text = '毫秒';
    charts.push({ plot, data: traces, layout });
  }

  // ── 图三: 工具调用 top10 ────────────────────────────────────
  const topTools = (stats.top_tools || []).slice(0, 10);
  if (topTools.length) {
    const host = el('div');
    const plot = chartCard(host, 260);
    box.appendChild(flatSection('最常用的工具', '账本里被调用最多的十项', host));

    const names = topTools.map((t) => t[0]);
    const counts = topTools.map((t) => t[1]);
    const traces = [{
      type: 'bar', orientation: 'h',
      y: names.slice().reverse(), x: counts.slice().reverse(),
      marker: { color: p.primary, opacity: 0.75 },
      hovertemplate: '%{y}<br>调用 %{x} 次<extra></extra>',
    }];
    const layout = baseLayout(p);
    layout.margin.l = 130;
    layout.xaxis.title.text = '调用次数';
    charts.push({ plot, data: traces, layout });
  }

  // ── 图四: 模型分布 ──────────────────────────────────────────
  const models = (ser.data && ser.data.models) || [];
  if (models.length) {
    const host = el('div');
    const plot = chartCard(host, 240);
    box.appendChild(flatSection('模型分布', '这些任务分别是哪个模型跑的', host));

    const traces = [{
      type: 'pie', hole: 0.55,
      labels: models.map((m) => m.model),
      values: models.map((m) => m.count),
      textinfo: 'percent',
      textfont: { size: 11, color: p.fg },
      marker: {
        colors: [p.primary, p.accent, p.gold, '#7C9CF0', '#5FD3C6', '#C58CF0', '#F09A5C'],
        line: { color: p.bg, width: 1 },
      },
      hovertemplate: '%{label}<br>%{value} 件 (%{percent})<extra></extra>',
    }];
    const layout = baseLayout(p);
    layout.legend = { orientation: 'h', y: -0.15, x: 0, font: { size: 11, color: p.dim } };
    layout.showlegend = true;
    charts.push({ plot, data: traces, layout });
  }

  // ── 明细表: 最近十天的账 ───────────────────────────────────
  {
    const rows = days.slice(-10).reverse().map((d) => [
      { v: d.date, cls: 'mono' },
      String(d.total),
      d.success_rate + '%',
      fmtDur(d.avg_duration_ms),
      String(d.tool_calls),
      d.errors ? String(d.errors) : '—',
    ]);
    box.appendChild(flatSection('最近十天的账',
      '一行一天',
      table(['日期', '任务', '成功率', '平均耗时', '工具调用', '出错'], rows, '没有记录')));
  }

  box.appendChild(footband([
    { k: '总任务', v: String(total) },
    { k: '成功率', v: rate + '%' },
  ], '账本 = 本机自进化闭环的每一次执行记录'));

  // ── 画图 (图表库按需加载) ───────────────────────────────────
  let Plotly = null;
  try {
    Plotly = await loadPlotly();
  } catch (e) {
    const warn = el('div', { class: 'pg-evo-nolib' },
      '图表库没加载起来（' + esc(e && e.message || e) + '）—— 下面的表格照旧能用。');
    box.insertBefore(warn, box.children[1] || null);
  }

  if (Plotly) {
    for (const c of charts) {
      try {
        await Plotly.react(c.plot, c.data, c.layout, { displayModeBar: false, responsive: true });
      } catch (e) { /* 单张图画不出来不该整页炸 */ }
    }
  }

  // ── 主题切换: 重刷配色 (plotly 的颜色是画上去的, 不会跟着 CSS 变) ──
  let mo = null;
  if (window.MutationObserver) {
    mo = new MutationObserver(() => {
      if (!Plotly) return;
      const np = palette();
      for (const c of charts) {
        const nl = baseLayout(np);
        // 保留原图各自的轴/图例设置, 只换颜色
        nl.barmode = c.layout.barmode;
        nl.showlegend = c.layout.showlegend;
        nl.legend = c.layout.legend;
        nl.margin = c.layout.margin;
        nl.yaxis.title.text = c.layout.yaxis.title.text;
        nl.xaxis.title.text = c.layout.xaxis.title.text;
        if (c.layout.yaxis2) {
          nl.yaxis2 = {
            title: { text: '成功率 %', font: { size: 11, color: np.muted } },
            overlaying: 'y', side: 'right', range: [0, 100],
            gridcolor: 'rgba(0,0,0,0)', tickfont: { size: 11, color: np.muted },
          };
        }
        try { Plotly.relayout(c.plot, nl); } catch (e) { /* 换主题失败无所谓 */ }
      }
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  return {
    destroy() {
      if (mo) mo.disconnect();
      if (Plotly) {
        for (const c of charts) {
          try { Plotly.purge(c.plot); } catch (e) { /* 清理失败不许挡住切换 */ }
        }
      }
    },
  };
}

