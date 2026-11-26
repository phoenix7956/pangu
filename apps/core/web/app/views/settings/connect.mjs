// settings/connect.mjs —— 设置 · 连接
//
// 从原版 `apps/desktop/src/views/settings/Connect.jsx` (git 110661d^) 搬过来。
// 原版用 alert() 报结果, 这里换成 toast —— 浏览器里 alert 会把整个工作台卡住。

import { el, esc, page, card, field, tiles, readout, flatSection, toast } from '../../lib/util.mjs';
import { api, setEndpoint } from '../../lib/api.mjs';
import { infoRow, dangerRow, actionBar } from '../../components/settings-widgets.mjs';
import { label } from '../../lib/labels.mjs';

const DEFAULT_ENDPOINT = '';

function fmtUptime(s) {
  const n = Number(s) || 0;
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  return h + 'h ' + m + 'm';
}

export async function render(root) {
  let endpoint = DEFAULT_ENDPOINT;
  try { endpoint = localStorage.getItem('pangu.endpoint') || DEFAULT_ENDPOINT; } catch (e) { /* 隐私模式 */ }

  let health = null;
  let nodes = [];
  let busy = false;
  let dirty = false;

  // 第 147 批: 页根 = 设计系统的页面外壳 `.pg-page`。
  //   以前每页自己造一个根 (这里叫 pg-settings-col, 状态页叫别的),
  //   换页时宽度/内缩/留白各不一样 ⇒ 看着像几套产品拼的。
  const host = page();
  host.classList.add('pg-settings-col');
  root.appendChild(host);

  const paint = () => {
    host.innerHTML = '';

    /* ── 后端地址 ──
       第 170 批: 这一块是**表单** ⇒ 全站唯一那个有框的卡片 (`.pg-card`),
       字段走统一的 `.pg-field` (标签在上 / 控件在下), 不再自己拼一个
       「标签 + input + 一行灰字」的三段式。 */
    const addrBody = el('div', {});
    const fw = field('盘古后端 URL', endpoint, {
      placeholder: '留空 = 与本页面同源 (http://127.0.0.1:18901)',
    });
    fw.input.classList.add('mono');
    const inp = fw.input;
    inp.addEventListener('input', () => {
      endpoint = inp.value;
      dirty = true;
      repaintBar();
    });
    addrBody.appendChild(fw);
    addrBody.appendChild(el('div', { class: 'pg-hint' },
      '留空走同源相对路径 —— 浏览器工作台就是这个形态。填绝对地址则所有请求改打那台机器 (跨源需对方放行 CORS)。'));

    const btns = el('div', { class: 'pg-btn-row' });
    const bTest = el('button', { class: 'pg-btn', type: 'button' }, '测试连接');
    const bRefresh = el('button', { class: 'pg-btn', type: 'button' }, '刷新状态');
    btns.appendChild(bTest);
    btns.appendChild(bRefresh);
    addrBody.appendChild(btns);
    host.appendChild(card('后端地址', null, addrBody));

    bTest.addEventListener('click', async () => {
      const t0 = Date.now();
      // 第 141 批: 用户没填服务器地址 ⇒ 走**相对**路径 (同源, 跟着当前基址走);
      //   填了绝对地址 ⇒ 那是另一台机器, 本来就该带斜杠拼。
      const base = endpoint.trim().replace(/\/+$/, '');
      // 填了绝对地址 ⇒ 那是另一台机器 (URL 自己拼); 没填 ⇒ 相对路径, 跟着当前基址走。
      const target = base ? new URL('health', base).href : 'health';
      try {
        const r = await fetch(target, { cache: 'no-store' });
        const j = await r.json().catch(() => ({}));
        const ms = Date.now() - t0;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        toast('通 · ' + ms + 'ms · ' + (j.data && j.data.status || (j.ok ? 'ok' : 'fail')));
      } catch (e) {
        toast('不通: ' + (e.message || e), true);
      }
    });

    bRefresh.addEventListener('click', async () => {
      busy = true;
      await refresh();
      busy = false;
    });

    /* ── 实时状态 ── */
    if (health) {
      const d = health.data || {};
      const mem = d.memory;
      const evt = d.eventLoop;
      const port = d.port;
      const body = el('div', {});
      // 第 170 批: **一条读数条**。
      //   以前这里是两套画法: 上面一排横排磁贴 (连通/模式/授权/端口/内存…),
      //   下面一张竖排键值表 (服务名/套餐/技能加载…) —— 同一件东西
      //   (这台机器现在什么状态) 用两种语言说, 一眼看过去像两个模块。
      //   契约第 6 条: 读数条唯一 `.pg-readout`, 宽了自然换行, 永远不留洞。
      //   「降级」那行删掉 —— 内存格的提示里已经印了同一档位。
      body.appendChild(readout([
        { k: '连通', v: health.ok ? '正常' : '异常', cls: health.ok ? 'is-ok' : 'is-bad' },
        { k: '模式', v: label('MODE', health.mode) || '—' },
        // 第 166 批: 原来这格的提示写的是**套餐**, 下面「完整字段」里又有一行
        //   「套餐」—— 同一页两处都印「个人」, 一眼看过去像说了两遍。
        //   磁贴只留授权本身, 套餐交给下面的完整字段。
        { k: '授权', v: health.license_ok ? '有效' : '失效', cls: health.license_ok ? 'is-ok' : 'is-bad' },
        // 第 166 批: 「18901 监听中」原来挤在一格里, 21px 的值放不下 ⇒ 折成两行,
        //   磁贴高出一截, 一眼看过去像文字溢出。拆成值 + 提示 (跟别的磁贴一样)。
        { k: '端口', v: port && port.listening ? String(port.port || 18901) : '未监听',
          cls: port && port.listening ? 'is-ok' : 'is-bad',
          h: port && port.listening ? '监听中' : '' },
        // 内存: 取 rss_mb (进程占用), 跟状态页同源 —— 原来这里印的是堆用量,
        //   两页都叫「内存」, 数字却对不上。
        { k: '内存', v: mem ? Number(mem.rss_mb || mem.mb).toFixed(1) + ' MB' : '—',
          cls: mem && mem.ok ? 'is-ok' : 'is-bad', h: mem && label('DEGRADATION', mem.level) },
        { k: '事件循环', v: evt ? evt.delayMs + 'ms' : '—',
          cls: evt && evt.ok ? 'is-ok' : 'is-bad', h: evt && evt.blocked ? '阻塞' : '通畅' },
        { k: '崩溃', v: d.crash ? (d.crash.count || 0) : 0,
          cls: !(d.crash && d.crash.crashed) ? 'is-ok' : 'is-bad' },
        { k: '运行时长', v: fmtUptime(d.uptime_s) },
        // ↓ 原来在下面那张竖排表里的几项, 现在接在同一条读数条后面。
        // environment 这个字段后端填的就是 mode 的值 (routes/health.js: environment: 'single_free'),
        // 所以按 MODE 翻译, 不另立一张表。
        // 第 166 批: 「降级」那行跟内存格的提示是同一个值 ⇒ 删掉, 不印两遍。
        { k: '服务名', v: d.service || '—' },
        { k: '套餐', v: label('PLAN', health.plan) || '—' },
        { k: '技能加载', v: d.skills_loaded == null ? '—' : d.skills_loaded },
        { k: '工具加载', v: d.tools_loaded == null ? '—' : d.tools_loaded },
      ]));
      host.appendChild(flatSection('实时状态', null, body));
    }

    /* ── 注册节点 ── */
    const nb = el('div', {});
    if (!nodes.length) {
      nb.appendChild(el('div', { class: 'pg-empty' }, '暂无节点'));
    } else {
      for (const n of nodes) {
        const row = el('div', { class: 'pg-node-row' });
        row.appendChild(el('span', { class: 'pg-node-dot' }));
        const box = el('div', { class: 'pg-node-text' });
        box.appendChild(el('div', { class: 'pg-node-name' },
          n.hostname || n.name || n.id || 'node'));
        box.appendChild(el('div', { class: 'pg-node-addr' },
          n.address || n.url || (n.host && n.port ? n.host + ':' + n.port : '—')));
        row.appendChild(box);
        row.appendChild(el('span', { class: 'pg-badge' }, label('NODE_STATUS', n.status || 'online')));
        nb.appendChild(row);
      }
    }
    host.appendChild(flatSection('注册节点', nodes.length + ' 个', nb));

    /* ── 重启 ── */
    const rb = el('div', {});
    rb.appendChild(dangerRow(
      '一键重启 Pangu 后端进程 (约 2-3 秒后由 launchd 自动拉起)。重启期间当前对话会中断, 磁盘数据不丢失。',
      async () => {
      const r = await api.panguRestart();
      if (r && r.ok) {
        toast('重启指令已发送 · 3 秒后自动重连');
        setTimeout(() => { try { location.reload(); } catch (e) { /* 忽略 */ } }, 3500);
      } else if (r && r.error === 'PANGU_BUSY') {
        toast('当前有任务正在执行, 重启已取消 · 等任务结束再试', true);
      } else {
        toast('重启失败: ' + ((r && r.error) || 'unknown'), true);
      }
      }, '确定要重启 Pangu 吗? 当前对话将中断。', '立即重启盘古'));
    host.appendChild(flatSection('重启盘古', null, rb));

    /* ── 危险操作 ── */
    const db = el('div', {});
    db.appendChild(dangerRow(
      '按系统保留策略删除过期历史、检查点、结果和修复记录。不可撤销。',
      async () => {
      const r = await api.cleanup();
      toast(r && r.ok ? ('已清理 ' + ((r && r.total_removed) || 0) + ' 项过期数据')
        : ('清理失败: ' + ((r && r.error) || '未知错误')), !(r && r.ok));
      }, '将按系统保留策略删除过期历史、检查点、结果和修复记录。此操作不可撤销。继续?', '清理过期数据'));
    host.appendChild(flatSection('危险操作', null, db));

    repaintBar();
  };

  let bar = null;
  const repaintBar = () => {
    if (bar) bar.remove();
    bar = actionBar(async () => {
      try {
        localStorage.setItem('pangu.endpoint', endpoint.trim());
      } catch (e) { /* 隐私模式 */ }
      setEndpoint(endpoint.trim());
      toast('已保存 · 新的请求立即使用该地址');
      dirty = false;
      repaintBar();
    }, false, dirty);
  };

  async function refresh() {
    const [h, n] = await Promise.all([api.health(), api.nodes()]);
    health = h;
    let list = [];
    if (Array.isArray(n)) list = n;
    else if (n && Array.isArray(n.nodes)) list = n.nodes;
    else if (n && Array.isArray(n.sessions)) list = n.sessions;
    else if (n && n.data && Array.isArray(n.data.nodes)) list = n.data.nodes;
    nodes = list;
    paint();
  }

  setEndpoint(endpoint.trim());
  paint();
  await refresh();

  return {};
}

export default render;
