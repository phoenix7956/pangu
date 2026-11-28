// app.mjs —— 盘古工作台外壳: 路由 + 主题 + 令符(⌘K) + 连接探针。
//
// 定位: 这是**核心 API 的浏览器客户端**, 不是桌面端复活。
// core 仍然是纯 API (第 108 批的规矩), 这一层只是把手写的静态页摆在浏览器里。
//
// 这一版按原版 UI 重做: 路径、侧栏分组、顶栏、令符、三套主题都跟原版对齐。

import { el, esc, json, icon, iconHTML } from './lib/util.mjs';
import { paintIcons } from './lib/icons.mjs';
import { renderSessionSidebar } from './components/session-sidebar.mjs';
import { startBuildCheck } from './lib/buildcheck.mjs';
import { label } from './lib/labels.mjs';
import { currentRoute, navigate } from './lib/route.mjs';

const $ = (s) => document.querySelector(s);
const main = $('#main');

// ── 路由 ──────────────────────────────────────────────────────────
const VIEWS = {
  chat: () => import('./views/chat.mjs'),
  team: () => import('./views/team.mjs'),
  bazi: () => import('./views/bazi.mjs'),

  hexagrams: () => import('./views/hexagrams.mjs'),
  history: () => import('./views/history.mjs'),
  marketplace: () => import('./views/marketplace.mjs'),
  subagents: () => import('./views/subagents.mjs'),
  evolution: () => import('./views/evolution.mjs'),
  status: () => import('./views/status.mjs'),
  settings: () => import('./views/settings.mjs'),
};

const TITLES = {
  // 第 143 批: 副标题原来全是**开发者口吻** —— 「主 agent 对话 (流式)」「直读 64i 真源」
  //   「起六爻 → 批果 → 复盘」。这是给写代码的人看的, 不是给用盘古的人看的。
  //   现在每一句都改成「这一页能干什么」, 挂在顶栏标题后面 (见 #view-sub)。
  chat: ['工作台', '问一件事，盘古一步步推进'],
  team: ['自动化', '定时任务与后台作业'],
  bazi: ['八字排盘', '四柱、五行喜忌与大运流年'],
  hexagrams: ['六十四卦', '六十四卦全文，可按五行筛选'],
  history: ['历史档案', '按日期归档的会话记录'],
  marketplace: ['工具集', '可安装的技能与工具'],
  subagents: ['将灵', '八位分工的角色与今日战绩'],
  evolution: ['进化', '自进化闭环的逐日账本'],
  status: ['状态', '服务、节点与模型'],
  settings: ['系统设置', '模型、凭证与权限'],
};

// 第 143 批: 应用层不再往正文上方插一行副标题 (它搬进顶栏 #view-sub 了),
//   「哪些页自带标题」这个开关整块删掉 —— 设置/工具集/六十四卦 自带标题,
//   现在只影响它们**页面内部**的排版, 不再影响外层。

// 令符 (⌘K) 的可跳项 —— 原版 CommandPalette 的同一份清单
//   第 141 批: go 一律**相对** ('bazi' / 'settings?tab=model') —— 写死前导斜杠
//   就等于把基址写死了, 盘古挂到 /pangu/ 下时令符就跳飞了。
const COMMANDS = [
  { name: '工作台', hint: '主对话', go: './' },
  { name: '自动化', hint: '起六爻 · 批果 · 复盘', go: 'team' },
  { name: '八字排盘', hint: '四柱 · 大运流年', go: 'bazi' },
  { name: '六十四卦', hint: '六十四卦全文 · 按五行筛', go: 'hexagrams' },
  { name: '历史档案', hint: '按日期归档', go: 'history' },
  { name: '工具集', hint: '技能市场 · 内部工具', go: 'marketplace' },
  { name: '将灵', hint: '八将灵运行态', go: 'subagents' },
  { name: '进化', hint: '自进化账本 · 趋势', go: 'evolution' },
  { name: '状态', hint: '运行时 / 节点 / 模型池', go: 'status' },
  { name: '系统设置', hint: '模型 · 凭证 · MCP · 权限', go: 'settings' },
  { name: '设置 · 连接', hint: '服务器地址 / 节点 / 心跳', go: 'settings?tab=connect' },
  { name: '设置 · 模型', hint: 'Provider / 上游获取 / 模型池', go: 'settings?tab=model' },
  { name: '设置 · 将灵', hint: 'Agent / 兜底链 / 推演强度', go: 'settings?tab=agent' },
  { name: '设置 · 内部工具', hint: '总表 / 开关 / 试跑', go: 'settings?tab=tools' },
  { name: '设置 · MCP', hint: '外部工具服务', go: 'settings?tab=mcp' },
  { name: '设置 · 权限', hint: '工具审批严格度', go: 'settings?tab=permission' },
  { name: '设置 · 界面', hint: '主题 / 字号', go: 'settings?tab=ui' },
  { name: '设置 · 存储', hint: '占用 / 清理', go: 'settings?tab=storage' },
  { name: '设置 · 凭证', hint: 'API key 集中管理', go: 'settings?tab=credentials' },
  { name: '设置 · 自愈', hint: '崩溃事故 / 自修记录', go: 'settings?tab=selfrepair' },
  { name: '设置 · 语音', hint: '识别 / 合成 / 播放', go: 'settings?tab=voice' },
  { name: '设置 · 更新', hint: '版本 / 更新通道', go: 'settings?tab=update' },
  { name: '切换主题', hint: '浅色 / 金色 / 深色', act: 'theme' },
  { name: '刷新连接状态', hint: '重新探活 18901', act: 'health' },
];

let current = null;

// ── 侧栏「最近会话」(原版 App.jsx 的 SessionSidebar) ─────────────
// 原版只在主对话页 (pathname === '/') 展开这段, 这里照搬。
let sessionSidebar = null;

function mountSessionSidebar(view) {
  const host = document.getElementById('nav-sessions');
  if (!host) return;
  const on = view === 'chat';
  host.hidden = !on;
  if (!on) {
    if (sessionSidebar && sessionSidebar.destroy) sessionSidebar.destroy();
    sessionSidebar = null;
    host.innerHTML = '';
    return;
  }
  if (sessionSidebar) return;
  host.innerHTML = '';
  sessionSidebar = renderSessionSidebar(host, {
    get currentSessionId() {
      try { return localStorage.getItem('pangu:chat:session:v1') || null; } catch (_) { return null; }
    },
    onSelectSession(id) {
      // 原版: 派发 pangu:resume-session, ChatRoom 监听后加载该 session
      window.dispatchEvent(new CustomEvent('pangu:resume-session', { detail: { id } }));
    },
  });
}

async function route() {
  const raw = currentRoute();
  const name = (raw.split('/')[0] || 'chat');
  const view = VIEWS[name] ? name : 'chat';
  for (const a of document.querySelectorAll('.pangu-nav-item')) {
    a.classList.toggle('is-active', a.dataset.view === view);
  }
  const [title, sub] = TITLES[view] || TITLES.chat;
  $('#view-title').textContent = title;
  $('#kicker').innerHTML = '盘古 <span>/</span> ' + (view === 'chat' ? '工作空间' : title);
  document.title = '盘古 · ' + title;
  // 第 143 批: 副标题挂进顶栏 (标题后面那截), 不再往正文上方插一行孤零零的灰字。
  const subEl = $('#view-sub');
  if (subEl) subEl.textContent = sub || '';

  if (current && current.destroy) {
    try { current.destroy(); } catch (e) { /* 视图清理失败不许挡住切换 */ }
  }
  main.innerHTML = '<div class="spinbox"><span class="spin"></span> 载入中…</div>';
  mountSessionSidebar(view);
  try {
    const mod = await VIEWS[view]();
    main.innerHTML = '';
    current = await mod.render(main) || null;
  } catch (e) {
    // 原版 ErrorBoundary 的等价实现: 这一页炸了, 别的页还能用, 并且能就地重试
    main.innerHTML = '<div class="pg-card"><div class="pg-card-header"><span class="pg-ico-line">'
      + iconHTML('alert-triangle', 15) + '<span>此页未通</span></span></div>'
      + '<div class="pg-card-body"><div class="errbox">视图载入失败: '
      + esc(e && e.message || e) + '</div>'
      + '<div class="pg-actions"><button type="button" class="pg-btn pg-btn-primary" id="view-retry">重试</button>'
      + '<a class="pg-btn" href="./">回工作台</a></div></div></div>';
    const retry = $('#view-retry');
    if (retry) retry.addEventListener('click', () => mount(view));
  }
}

// ── 主题 (第 149 批: 换名换序换默认) ─────────────────────────────
// 第 149 批把「浅色 / 金色 / 深色」换成盘古自己的三种纸:
//   dark = 墨盘 (默认) / gold = 铜夜 / light = 宣纸。
// 默认从「浅色」挪到「墨盘」—— 暖奶油底 + 宋体大标题正是 AI 默认第一档,
// 而墨盘 (冷墨 + 墨青 + 朱砂 + 铜金) 才跟盘古的爻柱语汇是一套。
// id 一个都不改 (老书签的 localStorage 还得认), 只改名 + 换默认 + 换顺序。
const THEMES = [
  { id: 'dark', name: '墨盘', icon: 'moon' },
  { id: 'gold', name: '铜夜', icon: 'compass' },
  { id: 'light', name: '宣纸', icon: 'sun' },
  { id: 'iron', name: '铁灰', icon: 'halfmoon' },
];

function currentTheme() {
  try {
    const t = localStorage.getItem('pangu.ui.theme');
    return t || 'dark';
  } catch (e) { return 'dark'; }
}

function applyTheme(id) {
  const t = THEMES.find((x) => x.id === id) ? id : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem('pangu.ui.theme', t);
    // 版本号: 主题存档的格式版本。没有它 = 旧时代存档, 迁移到新默认 (墨盘)。
    localStorage.setItem('pangu.ui.theme.ver', '166');
  } catch (e) { /* 隐私模式 */ }
  const btn = $('#theme-btn');
  btn.title = '主题：' + (THEMES.find((x) => x.id === t) || {}).name;
  btn.innerHTML = iconHTML((THEMES.find((x) => x.id === t) || {}).icon, 17);
}

function cycleTheme() {
  const i = THEMES.findIndex((x) => x.id === currentTheme());
  applyTheme(THEMES[(i + 1) % THEMES.length].id);
}

// ── 全局字号倍率 (第 148 批) ─────────────────────────────────────
// 设置页「界面 → 正文基准字号」存的是**正文基准 px** (14 = 默认)。
// 这里在启动时把它换算成倍率写进 `--ui-scale`, 全站字号令牌一起缩放。
// (第 148 批之前这里什么都没做 —— 那个滑块写的是 html{font-size},
//  而全站一个 rem 都没用, 拖了没反应, 是个死控件。)
function applyUiScale() {
  try {
    const raw = localStorage.getItem('pangu.ui');
    const n = Number(JSON.parse(raw || '{}').fontSize) || 14;
    document.documentElement.style.setProperty('--ui-scale', String(n / 14));
  } catch (e) {
    document.documentElement.style.setProperty('--ui-scale', '1');
  }
}

// ── 连接探针 (原版: 静候 / 卦变 / 正在连接) ───────────────────────
async function ping() {
  const box = $('#health');
  const txt = $('#health-text');
  const mode = $('#health-mode');
  box.className = 'pangu-health pangu-health-loading';
  txt.textContent = '正在连接';
  if (mode) mode.textContent = '';
  try {
    const res = await fetch('health', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    box.className = 'pangu-health pangu-health-ready';
    // 2026-10-28 第 138 批: 顶栏这颗 pill 原来直接印后端的 mode 原值
    //   ("single_free"), 一个中文界面上突然冒出一串下划线英文。
    //   统一走 lib/labels.mjs —— 查不到就原样透出, 不吞值。
    // 第 142 批: 原来一句话塞了两件事 ("运行正常 · 单机·免费优先"),
    //   整颗 pill 拉成一长条, 顶栏右侧看着像贴了条便利贴。
    //   现在: 状态是主体 (绿), 模式是配角 (灰), 后面跟一颗分隔点。
    txt.textContent = '运行正常';
    if (mode) mode.textContent = j.mode ? label('MODE', j.mode) : '本地';
  } catch (e) {
    box.className = 'pangu-health pangu-health-offline';
    txt.textContent = '服务离线';
    if (mode) mode.textContent = '';
  }
}

// ── 令符 (⌘K) ────────────────────────────────────────────────────
let paletteItems = [];
let paletteSel = 0;

function openPalette() {
  const p = $('#palette');
  p.hidden = false;
  const inp = $('#palette-input');
  inp.value = '';
  paintPalette('');
  inp.focus();
}

function closePalette() {
  $('#palette').hidden = true;
}

function paintPalette(q) {
  const list = $('#palette-list');
  const s = String(q || '').trim().toLowerCase();
  paletteItems = COMMANDS.filter((c) => !s
    || c.name.toLowerCase().includes(s) || (c.hint || '').toLowerCase().includes(s));
  paletteSel = 0;
  list.innerHTML = '';
  if (!paletteItems.length) {
    list.appendChild(el('div', { class: 'pangu-palette-empty' }, '没匹配到'));
    return;
  }
  paletteItems.forEach((c, i) => {
    const b = el('button', { class: 'pangu-palette-item' + (i === 0 ? ' on' : ''), type: 'button' });
    b.appendChild(el('span', {}, c.name));
    b.appendChild(el('span', { class: 'pg-hint' }, c.hint || ''));
    b.addEventListener('click', () => runCommand(c));
    list.appendChild(b);
  });
}

function runCommand(c) {
  closePalette();
  if (c.act === 'theme') return cycleTheme();
  if (c.act === 'health') return ping();
  if (!c.go) return;
  // 外链交给浏览器; 站内的一律走前端路由 (相对地址 ⇒ 基址由浏览器算)
  if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(c.go)) { location.href = c.go; return; }
  navigate(c.go);
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if ($('#palette').hidden) openPalette(); else closePalette();
    return;
  }
  if (e.key === 'Escape' && !$('#palette').hidden) { closePalette(); return; }
  if (!$('#palette').hidden && e.key === 'ArrowDown') {
    e.preventDefault();
    paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1);
    markPaletteSel();
  } else if (!$('#palette').hidden && e.key === 'ArrowUp') {
    e.preventDefault();
    paletteSel = Math.max(paletteSel - 1, 0);
    markPaletteSel();
  } else if (!$('#palette').hidden && e.key === 'Enter') {
    e.preventDefault();
    if (paletteItems[paletteSel]) runCommand(paletteItems[paletteSel]);
  }
});

function markPaletteSel() {
  const nodes = document.querySelectorAll('#palette-list .pangu-palette-item');
  nodes.forEach((n, i) => n.classList.toggle('on', i === paletteSel));
  if (nodes[paletteSel]) nodes[paletteSel].scrollIntoView({ block: 'nearest' });
}

// ── 起来 ──────────────────────────────────────────────────────────
$('#palette-btn').addEventListener('click', openPalette);
$('#palette').addEventListener('click', (e) => { if (e.target.id === 'palette') closePalette(); });
$('#palette-input').addEventListener('input', (e) => paintPalette(e.target.value));
$('#theme-btn').addEventListener('click', cycleTheme);
$('#refresh-btn').addEventListener('click', ping);

const sidebar = $('#sidebar');
$('#nav-open').addEventListener('click', () => sidebar.classList.add('is-open'));
$('#nav-close').addEventListener('click', () => sidebar.classList.remove('is-open'));
$('#nav-scrim').addEventListener('click', () => sidebar.classList.remove('is-open'));
// 抽屉开着时点侧栏任一项 ⇒ 顺手收起来 (原版 NavLink 的 onNavigate 就是这个)
for (const a of document.querySelectorAll('.pangu-nav-item')) {
  a.addEventListener('click', () => sidebar.classList.remove('is-open'));
}

// 路由真源在 lib/route.mjs: 新的是路径 (/bazi), 老的是哈希 (#/bazi, 仍认)。
window.addEventListener('hashchange', route);
window.addEventListener('popstate', route);
// 站内链接走前端路由 (不重载文档) —— 只有「不是工作台视图」的链接才让浏览器整页跳。
//   第 141 批: 链接一律相对 ⇒ 用 URL 解析出**同源**地址再判, 不看前导斜杠。
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (!href || href.startsWith('#')) return;      // 锚点: 不管
  if (a.hasAttribute('download')) return;
  if (a.target && a.target !== '_self') return;
  let u;
  try { u = new URL(href, document.baseURI); } catch (_) { return; }
  if (u.origin !== location.origin) return;        // 外链: 整页跳
  const first = u.pathname.replace(/^\/+|\/+$/g, '').split('/')[0];
  if (first && !VIEWS[first]) return;             // 不是工作台的视图 ⇒ 整页跳 (如 /api)
  e.preventDefault();
  navigate(href);
});
paintIcons(document);
applyTheme(currentTheme());
applyUiScale();
route();
ping();
setInterval(ping, 30000);

// 「我是不是在跑旧模块」自检 —— SPA 改 hash 不重载文档, module registry 会留旧实例。
// 指纹变了就顶一条「点此刷新」, 别再让老板对着老页面说「怎么还是不对」。
startBuildCheck({ intervalMs: 20000 });
