// settings/self-repair.mjs —— 设置 · 自愈
//
// 从原版 `apps/desktop/src/views/settings/SelfRepair.jsx` (git 110661d^) 搬过来。
// 老板 2026-09-14 拍: 自愈闭环必须主人可见 —— 盘古给自己动的刀, 每一刀都留痕。

import { el, elHTML, page, tiles, flatSection } from '../../lib/util.mjs';
import { iconHTML } from '../../lib/icons.mjs';
import { api } from '../../lib/api.mjs';

// 2026-10-28 第 138 批: 这一页原来通篇 emoji —— 字形各平台不一样, 也不跟三套主题走。
// 统一换成矢量图标; 状态色靠 .pg-ico-ok / .pg-ico-bad / .pg-ico-warn 显式给
// (emoji 本身就是彩色的, 换成描边线以后不会自己变色)。
function ico(name, cls, size) {
  const s = el('span', { class: cls || '' });
  s.appendChild(elHTML('span', {}, iconHTML(name, size || 13)));
  return s;
}

function icoLine(name, text, cls) {
  const s = el('span', { class: 'pg-ico-line ' + (cls || '') });
  s.appendChild(elHTML('span', {}, iconHTML(name, 13)));
  s.appendChild(el('span', {}, text));
  return s;
}

function fmtTs(ts) {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch (e) { return String(ts); }
}

function shortFile(f) {
  if (!f) return '—';
  return String(f).replace(/^.*apps\/core\//, '');
}

export async function render(root) {
  const host = page();
  host.classList.add('pg-settings-col');
  root.appendChild(host);

  let data = null;
  let loading = true;
  let error = null;

  const paint = () => {
    host.innerHTML = '';
    if (loading) {
      host.appendChild(el('div', { class: 'pg-hint' }, '加载中…'));
      return;
    }
    if (error) {
      host.appendChild(icoLine('alert-triangle', error, 'pg-ico-warn pg-err-line'));
      return;
    }

    const stats = (data && data.stats) || {};
    const repairs = ((data && data.repairs) || []).slice().reverse();
    const incidents = ((data && data.incidents) || []).slice().reverse();
    const ga = (data && data.guard_audit) || null;

    /* 统计 —— 设计系统的磁贴 (`.pg-tiles`), 不是设置页私有的第四套统计卡 */
    const cards = [
      { label: '事故总数', value: stats.incidents_total == null ? 0 : stats.incidents_total, cls: '' },
      { label: '自愈成功', value: stats.repairs_ok == null ? 0 : stats.repairs_ok, cls: 'is-ok' },
      { label: '自愈失败', value: stats.repairs_failed == null ? 0 : stats.repairs_failed, cls: stats.repairs_failed ? 'is-bad' : '' },
      {
        label: '成功率',
        value: stats.repairs_total ? Math.round(100 * stats.repairs_ok / stats.repairs_total) + '%' : '—',
        cls: 'is-accent',
      },
    ];
    host.appendChild(tiles(cards.map((c) => ({
      k: c.label,
      v: String(c.value),
      cls: c.cls === 'is-accent' ? '' : c.cls,
    }))));

    /* 每日守卫审计 */
    const gaWrap = el('div', {});
    gaWrap.appendChild(el('div', { class: 'pg-hint' },
      '每天 05:43 自动跑 45 用例矩阵, 挂了会记事故账'));
    if (!ga) {
      gaWrap.appendChild(icoLine('alert-triangle', '从未跑过 — 定时任务可能没挂上', 'pg-ico-warn pg-warn-box'));
    } else {
      const box = el('div', { class: 'pg-audit-box ' + (ga.fail === 0 ? 'is-ok' : 'is-bad') });
      const line = el('div', { class: 'pg-audit-line' });
      line.appendChild(ico(ga.fail === 0 ? 'check' : 'x', ga.fail === 0 ? 'pg-ico-ok' : 'pg-ico-bad', 15));
      line.appendChild(el('b', {}, ga.pass + ' 过 / ' + ga.fail + ' 挂'));
      line.appendChild(el('span', { class: 'pg-hint' }, '(共 ' + ga.cases + ' 用例)'));
      line.appendChild(el('span', { class: 'pg-hint pg-audit-ts' }, '最近跑: ' + fmtTs(ga.ts)));
      box.appendChild(line);
      if (ga.fail > 0 && (ga.failures || []).length) {
        const fl = el('div', { class: 'pg-audit-fails' });
        for (const f of ga.failures) {
          fl.appendChild(el('div', { class: 'pg-err-line mono' },
            '✗ ' + f.note + ' — 期望' + (f.want ? '杀' : '放') + ' 实际' + String(f.got)));
        }
        box.appendChild(fl);
      }
      gaWrap.appendChild(box);
    }
    host.appendChild(flatSection('每日守卫审计', null, gaWrap));

    /* 修复账 */
    const rw = el('div', {});
    if (!repairs.length) {
      rw.appendChild(el('div', { class: 'pg-empty-box' },
        '还没有自修记录 — 说明没崩过, 或崩了但修不了 (修不了也会记账)'));
    } else {
      for (const r of repairs) {
        const row = el('div', { class: 'pg-fix-row ' + (r.ok ? 'is-ok' : 'is-bad') });
        const top = el('div', { class: 'pg-fix-top' });
        top.appendChild(ico(r.ok ? 'check' : 'x', r.ok ? 'pg-ico-ok' : 'pg-ico-bad', 15));
        top.appendChild(el('span', { class: 'mono' }, r.signature || ''));
        top.appendChild(el('span', { class: 'pg-hint' }, fmtTs(r.ts)));
        row.appendChild(top);
        const meta = el('div', { class: 'pg-fix-meta' });
        meta.appendChild(icoLine('file', shortFile(r.file) + ':' + (r.line == null ? '?' : r.line)));
        if (r.rule) meta.appendChild(icoLine('wrench', r.rule + (r.var ? ' (' + r.var + ')' : '')));
        if (r.model) meta.appendChild(icoLine('bot', r.model));
        if (r.committed !== undefined) {
          meta.appendChild(r.committed
            ? icoLine('package', '已 git 留痕', 'pg-ico-ok')
            : icoLine('alert-triangle', '未提交', 'pg-ico-warn'));
        }
        if (r.reason) meta.appendChild(el('span', { class: 'pg-warn-text' }, '原因: ' + r.reason));
        row.appendChild(meta);
        rw.appendChild(row);
      }
    }
    host.appendChild(flatSection('修复记录 (盘古给自己动的刀)', null, rw));

    /* 事故账 */
    const iw = el('div', {});
    if (!incidents.length) {
      iw.appendChild(el('div', { class: 'pg-empty-box' }, '无事故记录'));
    } else {
      for (const r of incidents.slice(0, 30)) {
        const row = el('div', { class: 'pg-incident-row' });
        row.appendChild(elHTML('span', { class: 'pg-incident-ico' }, iconHTML('alert-triangle', 15)));
        row.appendChild(el('span', { class: 'mono' }, r.signature || r.message || ''));
        row.appendChild(el('span', { class: 'pg-badge' }, r.type || '—'));
        row.appendChild(el('span', { class: 'pg-hint pg-incident-ts' }, fmtTs(r.ts)));
        iw.appendChild(row);
      }
    }
    host.appendChild(flatSection('事故记录 (所有崩溃, 含没修成的)', null, iw));

    /* 纪律 */
    const disc = el('div', {});
    const ul = el('ul', { class: 'pg-note-list' });
    for (const line of [
      '只修 apps/core 内的 .js, 不碰配置/数据/前端',
      '三重验证: 补丁原文唯一匹配 / 语法检查通过 / 失败立即回滚',
      '修成 → git 自动提交留痕 → 5s 后自重启生效 (launchd 拉起)',
      '同一崩溃 24h 只试一次, 全天 5 次封顶 — 修不了诚实记账, 绝不硬改',
    ]) ul.appendChild(el('li', {}, line));
    disc.appendChild(ul);
    const bRe = el('button', { class: 'pg-btn pg-btn-sm', type: 'button' }, '刷新');
    bRe.addEventListener('click', () => load());
    disc.appendChild(bRe);
    host.appendChild(flatSection('纪律', null, disc));
  };

  async function load() {
    loading = true;
    error = null;
    paint();
    try {
      const r = await api.selfRepairGet();
      if (r && r.ok) data = r.result || {};
      else error = (r && r.error && r.error.message) || ((r && r.error) || 'load failed');
    } catch (e) {
      error = e.message || String(e);
    }
    loading = false;
    paint();
  }

  paint();
  await load();
  return {};
}

export default render;
