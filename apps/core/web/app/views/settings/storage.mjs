// settings/storage.mjs —— 设置 · 存储
//
// 从原版 `apps/desktop/src/views/settings/Storage.jsx` (git 110661d^) 搬过来。

import { el, page, tiles, toast, flatSection } from '../../lib/util.mjs';
import { api } from '../../lib/api.mjs';
import { dangerRow } from '../../components/settings-widgets.mjs';
import { label } from '../../lib/labels.mjs';

export async function render(root) {
  const host = page();
  host.classList.add('pg-settings-col');
  root.appendChild(host);

  let health = null;
  let stats = null;

  const paint = () => {
    host.innerHTML = '';
    const d = (health && health.data) || {};
    const mem = d.memory;

    /* 实时占用 */
    const b1 = el('div', {});
    b1.appendChild(tiles([
      // 后端给的 mb 是原始浮点 (22.659996032714844) —— 直接印出来像 bug。
      // 第 166 批: 改取 rss_mb —— 状态页显示的是进程占用 (RSS), 这里原来印的是
      //   堆用量 (heapUsed), 两个数同名不同义, 老板在两页对不上。
      //   现在三处一律用 RSS。
      { k: '内存', v: mem ? Number(mem.rss_mb || mem.mb).toFixed(1) + ' MB' : '—', cls: mem && mem.ok ? 'is-ok' : 'is-bad',
        // 后端给的是 normal / high / critical —— 直接印出来就是英文夹中文。
        h: mem ? label('DEGRADATION', mem.level) : '' },
      { k: '状态', v: label('DEGRADATION', d.degradation) || '—' },
      { k: '建议', v: ((d.recommendations && d.recommendations.length) || 0) + ' 条' },
    ]));
    host.appendChild(flatSection('实时占用', null, b1));

    /* 数据占用 */
    const b2 = el('div', {});
    const at = (k) => (stats && stats[k] ? stats[k].count : undefined);
    // 五项指标 —— 磁贴默认是 200px 一格, 在设置页这一栏只排得下 4 个,
    // 于是第五个孤零零挂第二行 (参差)。这组用紧凑排 (is-dense), 一行放下。
    const occ = tiles([
      { k: '历史会话', v: at('sessions') },
      { k: '断点检查点', v: at('checkpoints') },
      { k: '结果记录', v: at('outcomes'),
        h: stats && stats.outcomes && stats.outcomes.total_mb != null
          ? stats.outcomes.total_mb + ' MB' : null },
      { k: '归档问题', v: at('issues_archived') },
      { k: '修复队列', v: at('repair_queue') },
    ]);
    occ.classList.add('is-dense');
    b2.appendChild(occ);
    host.appendChild(flatSection('数据占用', null, b2));

    /* 会话清理 */
    const b3 = el('div', {});
    b3.appendChild(dangerRow(
      '删除全部会话历史。无法恢复。',
      async (btn) => {
      btn.textContent = '清理中…';
      const r = await api.sessionClearAll();
      if (r && r.ok) toast('已清空 ' + ((r && r.deleted) || 0) + ' 个会话');
      else toast('失败: ' + ((r && r.error) || '未知'), true);
      await refresh();
      }, '这会删除全部会话历史。无法恢复。继续?', '清空所有会话'));
    host.appendChild(flatSection('会话清理', null, b3));

    /* 危险操作 */
    const b4 = el('div', {});
    b4.appendChild(dangerRow(
      '删除超过 90 天的历史/结果/归档记录、超过 7 天的检查点、超过 30 天的修复记录, '
      + '并把历史会话限制在最近 100 个。不可撤销。',
      async (btn) => {
      btn.textContent = '清理中…';
      const r = await api.cleanup();
      const detail = r && Array.isArray(r.results)
        ? r.results.map((x) => x.name + ': ' + (x.removed || 0)).join('  ')
        : '';
      if (r && r.ok) {
        toast('过期数据清理完成 · 共 ' + ((r && r.total_removed) || 0) + ' 项' + (detail ? ' · ' + detail : ''));
      } else {
        toast('清理失败: ' + ((r && r.error) || '未知错误'), true);
      }
      await refresh();
      }, '将按系统保留策略删除超过 90 天的历史/结果/归档记录、超过 7 天的检查点、超过 30 天的修复记录，并将历史会话限制在最近 100 个。此操作不可撤销。继续?', '清理过期数据'));
    host.appendChild(flatSection('危险操作', null, b4));
  };

  async function refresh() {
    const [h, s] = await Promise.all([api.health(), api.housekeepingStats()]);
    health = h;
    stats = s && s.ok ? s.stats : null;
    paint();
  }

  paint();
  await refresh();
  return {};
}

export default render;
