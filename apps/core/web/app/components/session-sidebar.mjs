// session-sidebar.mjs —— 主侧栏底部的「最近会话」列表
//
// 从原版 `apps/desktop/src/components/SessionSidebar.jsx` (git 110661d^) 搬过来。
// 原版挂在 App.jsx 的 Sidebar 里, 只在主对话页 (showSessions = pathname === '/') 展开。
//
// 数据: GET /api/pangu/agent/sessions (JSON session, 跟 markdown 历史不是一回事)
// 行为: 默认折叠 · 展开后 15s 轮询 · 点一条派发 `pangu:resume-session` 让对话页续聊
// 2026-10-28 (第 134 批): 漏了 `elHTML` —— paint() 里给删除按钮画图标时用它,
//   没导入 ⇒ ReferenceError ⇒ **整个「最近会话」列表一项都画不出来**
//   (表现: 面板能展开、里面是空的; 控制台只有一条 unhandledrejection, 界面无感)。
//   ⇒ 侧栏一直是死的, 老板那边看到的就是「最近会话」空着。
import { el, elHTML, iconHTML } from '../lib/util.mjs';
import { api } from '../lib/api.mjs';

function formatRelativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' 天前';
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

// 2026-09-03 R80 fix: 后端 2026-08-22 改字段名 session_id/title → id/preview,
// 前端没跟上, 全部 fallback 到字面 'session', 没法点。兼容老 + 新字段。
function deriveTitle(sess) {
  if (sess.title) return sess.title;
  if (sess.preview) return String(sess.preview).slice(0, 40);
  if (sess.plan_id) return 'plan · ' + String(sess.plan_id).slice(0, 12);
  const id = sess.session_id || sess.id;
  if (id) return String(id).slice(0, 16);
  return 'session';
}

export function renderSessionSidebar(root, opts) {
  const o = opts || {};
  const host = el('div', { class: 'pg-sessions' });
  root.appendChild(host);

  let open = false;
  let sessions = [];
  let loading = false;
  let err = null;
  let timer = null;

  const listBox = el('div', { class: 'pg-sessions-list' });

  async function refresh() {
    loading = true;
    err = null;
    try {
      const r = await api.agentSessionList(50);
      const list = (r && r.data && r.data.result && r.data.result.sessions)
        || (r && r.result && r.result.sessions)
        || (r && r.sessions) || [];
      sessions = Array.isArray(list) ? list : [];
    } catch (e) {
      err = (e && e.message) || '加载失败';
      sessions = [];
    } finally {
      loading = false;
      paint();
    }
  }

  async function handleDelete(id) {
    if (!confirm('删 session ' + String(id).slice(0, 16) + '…?\n(不可恢复)')) return;
    try {
      const r = await api.agentSessionDelete(id);
      if (r && (r.ok || (r.result && r.result.deleted))) {
        sessions = sessions.filter((s) => (s.session_id || s.id) !== id);
        paint();
      } else {
        const msg = (r && r.error && (r.error.message || r.error)) || 'unknown';
        alert('删除失败: ' + msg);
      }
    } catch (e) {
      alert('删除异常: ' + (e && e.message));
    }
  }

  function paint() {
    listBox.innerHTML = '';
    if (loading && !sessions.length) {
      listBox.appendChild(el('div', { class: 'pg-sessions-hint' }, '加载中…'));
      return;
    }
    if (err) {
      listBox.appendChild(elHTML('div', { class: 'pg-sessions-err pg-ico-line' },
        iconHTML('alert-triangle', 13) + '<span>' + err + '</span>'));
      return;
    }
    if (!sessions.length) {
      listBox.appendChild(el('div', { class: 'pg-sessions-hint is-empty' }, '暂无活跃 session'));
      return;
    }
    for (const s of sessions) {
      const id = s.session_id || s.id;
      if (!id) continue;
      const active = o.currentSessionId && id === o.currentSessionId;
      const row = el('div', {
        class: 'pg-sessions-item' + (active ? ' is-active' : ''),
        role: 'button',
        tabindex: '0',
        title: '切到 session: ' + id + '\n点击继续对话',
      });
      row.appendChild(el('span', { class: 'pg-sessions-dot' }));
      const body = el('div', { class: 'pg-sessions-body' });
      body.appendChild(el('div', { class: 'pg-sessions-title' }, deriveTitle(s)));
      const meta = (s.message_count || 0) + ' 消息 · ' + formatRelativeTime(s.last_updated);
      body.appendChild(el('div', { class: 'pg-sessions-meta' }, meta));
      row.appendChild(body);
      const del = el('button', {
        class: 'pg-sessions-del',
        type: 'button',
        title: '删除 session',
        'aria-label': '删除 session',
      });
      del.appendChild(elHTML('span', {}, iconHTML('trash', 13)));
      del.addEventListener('click', (e) => { e.stopPropagation(); handleDelete(id); });
      row.appendChild(del);
      row.addEventListener('click', () => {
        if (o.onSelectSession) o.onSelectSession(id);
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (o.onSelectSession) o.onSelectSession(id);
        }
      });
      listBox.appendChild(row);
    }
  }

  const toggle = el('button', {
    class: 'pg-side-item pg-sessions-toggle',
    type: 'button',
    title: '展开 session 列表 (点击续聊)',
  });
  const caret = el('span', { class: 'pg-sessions-caret' });
  caret.innerHTML = iconHTML('chevron-right', 15);
  toggle.appendChild(caret);
  const msgIco = el('span', { class: 'pg-sessions-ico' });
  msgIco.innerHTML = iconHTML('message', 15);
  toggle.appendChild(msgIco);
  toggle.appendChild(el('span', { class: 'pg-sessions-label' }, '最近会话'));
  const count = el('span', { class: 'pg-sessions-count' });
  count.hidden = true; // 0 个会话时不显示这个 pill (空 pill 是侧栏里一个没意义的灰块)
  toggle.appendChild(count);
  toggle.addEventListener('click', async () => {
    open = !open;
    host.classList.toggle('is-open', open);
    caret.innerHTML = iconHTML(open ? 'chevron-down' : 'chevron-right', 15);
    toggle.title = open ? '收起 session 列表' : '展开 session 列表 (点击续聊)';
    if (open) {
      await refresh();
      if (!timer) timer = setInterval(refresh, 15000);
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  });

  host.appendChild(toggle);
  host.appendChild(listBox);

  return {
    // 计数为 0 时整个 pill 藏起来 —— 空 pill 在侧栏里是一个没有意义的灰块
    setCount(n) {
      count.textContent = n ? String(n) : '';
      count.hidden = !n;
    },
    destroy() { if (timer) clearInterval(timer); },
  };
}

export default renderSessionSidebar;
