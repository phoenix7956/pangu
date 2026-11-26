// subagents.mjs —— 将灵: 八将灵角色 / 今日次数 / 最近任务 / 是否正在跑
// 数据: GET /api/pangu/subagents/roles + GET /api/pangu/subagents/runs
import { el, esc, json, flatSection, page, footband, guaSeal } from '../lib/util.mjs';
import { label } from '../lib/labels.mjs';

export async function render(root) {
  const box = page();
  root.appendChild(box);
  // 第 170 批: 载入态走零件, 不再手搓区块壳字符串。
  box.innerHTML = '';
  box.appendChild(el('div', { class: 'spinbox' }, '读将灵…'));

  const grab = async (url) => {
    try { return await json(url); } catch (e) { return { __err: String(e.message || e) }; }
  };
  const [roles, runs] = await Promise.all([
    grab('api/pangu/subagents/roles'),
    grab('api/pangu/subagents/runs'),
  ]);
  box.innerHTML = '';

  const byRole = roles.by_code || {};
  const byRun = runs.by_code || {};
  const codes = Object.keys(byRole);

  // 2026-10-28 第 138 批: 这张表原来**没装进卡片**, 而且最后一列直接顶到窗口右边缘 ——
  //   长任务标题被视口切掉 (不是被单元格省略号切), 右边缘一点留白都没有。
  //   修: table-layout:fixed ⇒ 列宽按 th 定死, 最后一列拿剩余宽度;
  //   再配合 max-width:0 + ellipsis ⇒ 省略号出现在**卡片里**, 不在屏幕边上。
  // 第 147 批: `.t` → 设计系统的 `.pg-table` (全站只有一种表的画法)。
  const t = el('table', { class: 'pg-table is-fixed' });
  t.innerHTML = '<thead><tr><th style="width:170px">将灵</th>'
    + '<th style="width:80px">工具</th><th style="width:80px">今日</th><th style="width:90px">状态</th>'
    + '<th>最近任务</th></tr></thead>';
  const tb = el('tbody');
  for (const code of codes) {
    const r = byRole[code];
    const run = byRun[code] || {};
    const tr = el('tr');
    const c1 = el('td');
    // 第 161 批: 「☵ 坎 · 拆」那种 Unicode 卦符 + 药丸的组合 →
    // **卦印** (真爻柱 + 卦名) + 职责。卦符是字体符号, 各系统字形不同;
    // 卦印是图形, 而且「卦名」已经在印里 ⇒ 原来的「卦」那一列并进来了。
    const sealWrap = el('span', { class: 'pg-agent-cell' });
    sealWrap.appendChild(guaSeal(r.gua || '', !!run.running));
    // 用 `role` (纯职责「拆」) 而不是 `zh` (全称「坎 · 拆」) ——
    // 卦名已经在卦印里, 印两遍就成了「坎 · 坎 · 拆」。
    sealWrap.appendChild(el('span', { class: 'pg-agent-cell-t' }, r.role || code));
    c1.appendChild(sealWrap);
    tr.appendChild(c1);
    tr.appendChild(el('td', {}, String((r.tools || []).length)));
    tr.appendChild(el('td', {}, String(run.runs_today == null ? '—' : run.runs_today)));
    const st = el('td');
    if (run.running) {
      // 第 147 批: 状态一律用**药丸** (.pg-pill) —— 状态页的「在线/已启用」
      //   和这里的「已完成/进行中」是同一种语义, 必须同一种画法。
      st.appendChild(el('span', { class: 'pg-pill pg-pill-ok' }, '进行中'));
    } else if (run.last_kind) {
      // 第 151 批: 「已完成」跟「进行中」不能共用一种绿 —— 绿=活着/能连,
      //   已完成 = 已经停了, 用灰药丸才读得出「现在只有 1 位在跑」。
      const stLabel = label('SUBAGENT_RUN_STATE', run.last_kind);
      // 守卫 G2 只许 label() 出场的枚举: 判断色档走**中文**标签,
      // 源码里不出现裸的 'done' (枚举值只活在 label 表里)。
      st.appendChild(el('span', {
        class: 'pg-pill ' + (stLabel === '已完成' ? 'pg-pill-idle' : 'pg-pill-off'),
      }, stLabel));
    } else {
      st.appendChild(el('span', { class: 'hint' }, '—'));
    }
    tr.appendChild(st);
    // recent_tasks 的元素是对象 {task, at, kind, summary} —— 直接 String() 会渲染成 [object Object]
    const last = (run.recent_tasks || [])[0];
    const lastText = last == null ? '' : (typeof last === 'string' ? last : (last.task || last.summary || ''));
    // 第 144 批: 任务标题里常带**本机绝对路径**
    //   (比如 apps/core/modules/llm_caller.js 这种仓库内路径) ——
    //   这是开发者信息, 不是用户信息, 而且它把整列撑成了一排路径,
    //   一眼看过去像日志。改成: 路径只留最后一段 (文件名), 全路径进 title。
    const cleanText = lastText
      ? lastText.replace(/\s+/g, ' ').replace(/(\/[^\s:：,，)）]*\/)([^\s/]{1,40})/g, '$2')
      : '';
    // 第 166 批: 省略号原来挂在 `<td>` 上 —— `overflow` 对 table-cell **不生效**
    //   (CSS 里 overflow 只对块/弹性/网格容器起作用), 所以这列长任务标题直接
    //   顶到视口右边缘被切掉, 一点留白都没有。改成 td 里套一个 block 的
    //   `.pg-truncate` span: 省略号这才真的出现在**卡片里**。
    const taskTd = el('td', { title: lastText });
    // 截到 120 字时要**自己补省略号** —— 原来直接 slice, 末尾停在半个词上
    //   (「…(415 行), yin」), 一眼看过去像渲染断了, 不知道后面还有内容。
    const shown = !cleanText ? '—'
      : (cleanText.length > 120 ? cleanText.slice(0, 120) + '…' : cleanText);
    taskTd.appendChild(el('span', { class: 'pg-truncate' }, shown));
    tr.appendChild(taskTd);
    tb.appendChild(tr);
  }
  if (!codes.length) tb.appendChild(el('tr', {}, el('td', { colspan: '6' }, '没读到将灵')));
  t.appendChild(tb);

  // 第 170 批: 统计不再单独占一行 (那是第三种区块语言), 收进**区块头的计数位** ——
  //   全站每个区块的头都是「标题 + 计数 + 右侧动作」三段式。
  const todayTotal = codes.reduce((s, c) => s + ((byRun[c] || {}).runs_today || 0), 0);
  box.appendChild(flatSection('今日战绩',
    codes.length + ' 位 · 今日合计 ' + todayTotal + ' 次', [t]));

  const errs = [roles, runs].filter((x) => x && x.__err);
  if (errs.length) {
    box.appendChild(el('div', { class: 'errbox' }, '部分接口读不到: ' + errs.map((e) => e.__err).join(' / ')));
  }
  // 第 150 批: 页尾收口带 —— 把「谁在跑 / 谁在等」扫一眼, 顺手收掉大段死黑。
  const running = codes.filter((c) => (byRun[c] || {}).running).length;
  box.appendChild(footband([
    { k: '将灵', v: String(codes.length) },
    { k: '进行中', v: String(running) },
    { k: '今日', v: codes.reduce((s, c) => s + ((byRun[c] || {}).runs_today || 0), 0) + ' 次' },
  ], '将灵 = 八将灵调度'));
}
