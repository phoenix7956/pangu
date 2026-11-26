// status.mjs —— 状态: 节点 / 模型 / 子 agent / 运行时
//
// 第 147 批: 这一页是**设计系统的样板页** —— 全站页面的骨架照它写:
//   页面根 = .pg-page → 一串 .pg-card (区块) → 区块里只有三种零件
//   (磁贴 .pg-tiles / 表格 .pg-table / 标签 .pg-tag)。
// 别的页面跟它长得不一样, 就是没照着做。
import { el, esc, json, flatSection, page, readout, table, footband, tiles } from '../lib/util.mjs';
import { label, labels } from '../lib/labels.mjs';
import { TRIGRAM_WX } from '../lib/yao.mjs';

export async function render(root) {
  const box = page();
  root.appendChild(box);
  // 第 170 批: 载入态也走零件 (spinbox), 不再手搓区块壳字符串 ——
  //   手搓 = 第三种区块画法, 页面一多就各写各的。
  box.innerHTML = '';
  box.appendChild(el('div', { class: 'spinbox' }, '读状态…'));

  const grab = async (url) => {
    try { return await json(url); } catch (e) { return { __err: String(e.message || e) }; }
  };
  const [health, nodes, models, roles] = await Promise.all([
    grab('health'), grab('api/nodes'), grab('api/models/list'), grab('api/pangu/subagents/roles'),
  ]);

  box.innerHTML = '';

  // 运行时
  const d = health.data || {};
  // 第 142 批: 原来是一行 kv 文字流 (版本 … 模式 … 计划 … 运行 … 十几个挤一行),
  //   像日志不像面板 ⇒ 改成统计磁贴, 一格一项, 标签在上、数在下。
  // 数字磁贴: 标签在上 / 值在中 —— 全站只有这一种磁贴。
  const rt = [
    ['版本', health.version],
    ['模式', label('MODE', health.mode)],
    ['计划', label('PLAN', health.plan)],
    // 第 147 批: 后端 status 有 ok / normal 两种写法, 都译成中文。
    //   原来只有 ok 被处理, 剩下的原样漏出英文 ("normal" 夹在一屏中文里)。
    ['运行', d.status === 'ok' ? '正常' : label('DEGRADATION', d.status) || d.status],
    // 第 150 批: 事件循环 / 崩溃计数平时没人看, 从磁贴降级到收口带 ——
    //   磁贴只留**扫一眼就要知道**的八格。
    ['事件循环', null],
    ['崩溃计数', null],
    ['工具', d.tools_loaded],
    ['技能', d.skills_loaded],
    ['内存', d.memory ? Math.round(d.memory.rss_mb || 0) + ' MB' : null],
  ];
  // 第 160 批: 磁贴 → **读数条**。磁贴是网格, 七项在 5 列里排成「5 + 2」,
  //   第二行两个孤零零挂在那儿, 右边空一大块 —— 一眼「没排满」。
  //   读数条是流式的, 一行读完, 不留洞, 跟首页右栏同一套语言。
  const kv1 = readout(rt
    .filter(([, v]) => v != null)
    .map(([k, v]) => ({ k, v })));
  box.appendChild(flatSection('服务概况', '本机运行状态', kv1));

  // 节点
  const nodeRows = (nodes.nodes || []).map((n) => {
    const st = label('NODE_STATUS', n.status);
    const pill = el('span', {
      class: 'pg-pill ' + (/在线|online|connected/i.test(st) ? 'pg-pill-ok' : 'pg-pill-idle'),
    }, st);
    return [{ v: n.id, cls: 'mono' }, label('NODE_ROLE', n.role), pill];
  });
  const t1 = table(['节点', '角色', '状态'], nodeRows, '没有节点');
  box.appendChild(flatSection('计算节点', (nodes.nodes || []).length + ' 个', t1));

  // 模型池
  const modelRows = (models.models || []).map((m) => {
    // 能力原来是 "chat, reasoning" 一串英文 —— 拆成小标签, 一眼能扫。
    // 第 166 批: 原来这里造的是 `<td>`, 再交给 util.table() → table() 又给它套一层
    //   `<td>` ⇒ 浏览器把内层 td **嵌套**进外层 td (非法结构, 浏览器纠偏后变成
    //   td-in-td), 内外两套 padding (10px × 2) 叠在一行上 ⇒ 行高 66px,
    //   整张表松垮得像没排版。改成 div: table() 把它放进 td 里, 层级就对了。
    const capTd = el('div');
    const caps = labels('CAPABILITY', m.capabilities || []);
    if (caps.length) {
      const tags = el('div', { class: 'pg-tags' });
      for (const c of caps) tags.appendChild(el('span', { class: 'pg-tag' }, c));
      capTd.appendChild(tags);
    } else {
      capTd.appendChild(el('span', { class: 'hint' }, '—'));
    }
    const enTd = el('div');
    enTd.appendChild(el('span', {
      class: 'pg-pill ' + (m.enabled === false ? 'pg-pill-idle' : 'pg-pill-ok'),
    }, m.enabled === false ? '未启用' : '已启用'));
    return [{ v: m.name || m.id, cls: 'mono' }, m.provider || '', label('PROTOCOL', m.protocol), capTd, enTd];
  });
  const mt = table(['模型', '厂商', '协议', '能力', '启用'], modelRows, '没有模型');
  // 第 166 批: 窄屏下这张 5 列表会被视口切掉一整列 (「启用」那格只剩半个药丸) ——
  //   给它挂个标记, 窄屏把「厂商 / 协议」两列收起来 (这俩在模型名下面也能查)。
  mt.classList.add('pg-table-models');
  box.appendChild(flatSection('可用模型', (models.models || []).length + ' 个', mt));

  // 第 150 批: 磁贴降级出来的两项 (事件循环 / 崩溃计数) 住在收口带里 ——
  //   平时读不到, 异常时一眼看见。
  const loopOk = !d.eventLoop || d.eventLoop.ok;
  const footStats = [
    { k: '事件循环', v: loopOk ? '正常' : '阻塞' },
    { k: '崩溃', v: String(d.crash ? d.crash.count : 0) },
    { k: '在线', v: d.uptime_s != null ? Math.round(d.uptime_s / 60) + ' 分钟' : '—' },
  ];

  // 八将灵 —— 第 170 批: 原来是**一排小药丸** (「☵ 坎 · 拆 · 工具 20」),
  //   八个挤在一行, 每个都带三段字, 又扁又碎, 一眼像一排标签而不是八位角色。
  //   现在用全站统一的**磁贴** (.pg-tiles.is-row, 一行八个): 卦符+卦名在上,
  //   本职在中, 工具数在下 —— 与首屏、设置页的磁贴是同一套画法。
  const byCode = roles.by_code || {};
  const rt2 = tiles(Object.keys(byCode).map((code) => {
    const r = byCode[code];
    // 2026-11-04 (颜色对照): 卦名染五行墨色, 跟将灵页卦印同一套语言。
    const kNode = el('span');
    kNode.appendChild(document.createTextNode((r.icon || '') + ' '));
    const wx = TRIGRAM_WX[r.gua];
    if (wx) kNode.appendChild(el('span', { class: 'pg-wxg pg-wxg-' + wx }, r.gua));
    else kNode.appendChild(document.createTextNode(r.gua || r.zh || code));
    return {
      k: kNode,
      v: r.role || r.zh || code,
      h: '工具 ' + ((r.tools || []).length),
    };
  }));
  rt2.classList.add('is-row');
  box.appendChild(flatSection('八将灵', Object.keys(byCode).length + ' 位', rt2));

  const errs = [health, nodes, models, roles].filter((x) => x && x.__err);
  if (errs.length) {
    box.appendChild(el('div', { class: 'errbox' },
      '部分接口读不到: ' + errs.map((e) => e.__err).join(' / ')));
  }

  // 页尾收口带 (第 150 批): 把大段死黑收掉, 顺带把降级指标住进来。
  box.appendChild(footband(footStats, '本机 · ' + (location.host || 'LOCAL')));
}
