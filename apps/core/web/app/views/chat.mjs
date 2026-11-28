// chat.mjs —— 盘古主对话 (原版 views/ChatRoom.jsx 的完整搬迁)
//
// 从原版 `apps/desktop/src/views/ChatRoom.jsx` (git 110661d^, 2289 行) 搬过来。
// React → 原生 DOM, Tailwind → components.css 里的原生类, **行为一条不改**。
//
// 原版最要紧的三条判断, 全搬:
//   ① 活动行不套气泡 —— 工具/思考/将灵是一行一事件的流水, 套气泡就又变回「空气泡墙」。
//   ② 答复排在活动行**后面** —— appendActivity 把答复泡挪到活动行后 (真实发生顺序),
//      不是「谁先被创建谁在前」。
//   ③ 思考内容**不显示** —— 只显示「想过 N 字」/转圈 (2026-07-26 老板拍)。

import { el, esc, elHTML, iconHTML, json, yaoColumn, guaMark, listRow } from '../lib/util.mjs';
import { api, errorMessage, humanizeStreamError } from '../lib/api.mjs';
import { streamSSE } from '../lib/sse.mjs';
import { renderMarkdown } from '../lib/md.mjs';
import { findGua, guaLabel, GUA_ROSTER } from '../lib/gua-roster.mjs';
import { TRIGRAM_BITS, TRIGRAM_WX } from '../lib/yao.mjs';
import { renderActivityLine, pickDetail } from '../components/activity-line.mjs';
import { renderHexagramCard } from '../components/hexagram-card.mjs';
import { renderPlanCard } from '../components/plan-card.mjs';
import { renderTodoViewer } from '../components/todo-viewer.mjs';
import { renderDiffViewer } from '../components/diff-viewer.mjs';
import { renderProgressBar } from '../components/progress-bar.mjs';
import { renderSubAgentPanel } from '../components/subagent-panel.mjs';
import { createPermissionPopover } from '../components/permission-popover.mjs';
import { navigate } from '../lib/route.mjs';
import { label } from '../lib/labels.mjs';

const STORAGE_KEY = 'pangu:chat:messages:v1';
const SESSION_KEY = 'pangu:chat:session:v1';

// 第 153 批: 开局入口 = **最简单的问题**, 不是功能名。
// 老板: 「最开始的几个, 应该是最简单的问题, 介绍自己, 能干什么,
// 巡检这台机器, 这还差不多」。功能页 (排盘/起卦) 从侧栏进,
// 不用在中间堆 —— 中间只放「问得出口的话」。
// 照搬样稿 2.0 viewHome 的三张功能卡 (老板 11-04)。文案/示例句原样来自 redesign-sample。
const SUGG_CARDS = [
  { ico: '☰', label: '八字排盘', desc: '四柱五行、大运流年、神煞喜忌, 一盘尽览', ph: '例如: 帮我排一下 1991年11月23日 20:23 生于江苏盐城的八字…' },
  { ico: '✦', label: '问一件事', desc: '工作、合作、行止 —— 直接说, 不用选工具', ph: '帮我问一件事: ' },
];

const WELCOME_SUGGESTIONS = [
  { label: '介绍一下你自己', icon: 'bot', desc: '盘古是什么、能替你做什么' },
  { label: '你现在能干什么', icon: 'list', desc: '排盘、起卦、巡检、查资料, 一屏列全' },
  { label: '这台机器怎么样', icon: 'gauge', desc: '节点、模型、工具链, 实时扫一遍' },
];

// ── 工具函数 ──────────────────────────────────────────────────────

function fmtTs(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function fmtTokens(n) {
  if (!n && n !== 0) return '?';
  if (n >= 1048576) return (n / 1048576).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1024) return Math.round(n / 1024) + 'K';
  return String(n);
}

function fmtDuration(ms) {
  if (!ms || ms <= 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return m + 'm ' + String(sec).padStart(2, '0') + 's';
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return h + 'h ' + String(rm).padStart(2, '0') + 'm';
}

function fmtSessionDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(s / 3600) + 'h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm '
    + String(s % 60).padStart(2, '0') + 's';
}

function isActivityMsg(m) {
  return !!m
    && (m.type === 'tool_call' || m.type === 'tool_result' || m.type === 'thinking'
      || m.type === 'agent_line' || m.type === 'notice');
}

/**
 * 活动行追加时, 把本轮的答复泡挪到活动行**后面**。
 * 位置由「谁最后发生」决定 = 真实发生顺序, 不再由「谁先被创建谁在前」。
 */
function appendActivity(prev, rows, assistantTs) {
  if (!Array.isArray(rows) || rows.length === 0) return prev;
  const list = Array.isArray(rows) ? rows : [rows];
  if (!assistantTs) return prev.concat(list);
  const ai = prev.findIndex((m) => m && m.streamId === assistantTs && m.role === 'assistant');
  if (ai < 0) return prev.concat(list);
  const withoutAssistant = prev.filter((_, i) => i !== ai);
  return withoutAssistant.concat(list, [prev[ai]]);
}

// plan 载荷有**两种形状**, 键名不一样, 归一成一种。
function normalizePlan(p) {
  if (!p) return null;
  if (Array.isArray(p.steps) && p.steps.length) return { ...p, steps: p.steps };
  const list = Array.isArray(p.plan) ? p.plan
    : (Array.isArray(p.subTasks) ? p.subTasks : null);
  if (!list || !list.length) return null;
  return {
    ...p,
    plan_id: p.plan_id || 'dispatch',
    task: p.task || p.note || '',
    steps: list.map((t, i) => ({
      step_id: i + 1,
      tool: (t && (t.agent || t.role)) || '',
      text: String((t && (t.text || t.task)) || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      deps: Array.isArray(t && t.depends_on) ? t.depends_on : undefined,
    })),
  };
}

// 每一步的**真实**执行状态 —— 由将灵行反推。对不上的一律 unknown (中性), 不猜。
function stepStatesFor(steps, subAgents, planTs) {
  const key = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const pool = (subAgents || []).filter((a) => !planTs || !a.startTs || a.startTs >= planTs - 1000);
  return (steps || []).map((s) => {
    const want = key(s && (s.text || s.tool)).slice(0, 40);
    if (want.length < 6) return 'unknown';
    for (const a of pool) {
      const got = key(a.task).slice(0, 40);
      if (got.length >= 6 && (got.startsWith(want.slice(0, 24)) || want.startsWith(got.slice(0, 24)))) {
        return a.status || 'unknown';
      }
    }
    return 'unknown';
  });
}

// 将灵一动, 计划卡整个不画 —— 执行期的唯一真相是将灵列表。
function shouldShowPlan(plan, subAgents) {
  const np = normalizePlan(plan);
  if (!np) return false;
  if ((subAgents || []).length > 0) return false;
  return true;
}

// 从盘古回复末尾抽 "A. xxx / B. yyy" → 快速选项 chip
function extractQuickReplies(text) {
  if (!text || typeof text !== 'string') return [];
  const tail = text.slice(-600);
  const matches = tail.match(/^([A-Z])\.\s+(.+?)$/gm);
  if (!matches || matches.length < 2) return [];
  return matches.map((line) => {
    const m = line.match(/^([A-Z])\.\s+(.+)$/);
    return { key: m[1], label: m[2].slice(0, 60).trim() };
  });
}

function isGreetingMsg(m) {
  return m && m.role === 'system' && typeof m.content === 'string' && m.content.includes('问事者，可启口');
}

// 持久化时剥离图片, 免得 localStorage 5MB 爆掉
function stripImages(messages) {
  return messages.map((m) => {
    if (!m.images || m.images.length === 0) return m;
    const rest = { ...m };
    delete rest.images;
    rest._had_images = m.images.length;
    return rest;
  });
}

function loadMessages() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((m) => !isGreetingMsg(m));
    }
  } catch (_) { /* 隐私模式 / 坏数据 */ }
  return [];
}

function loadSessionId() {
  try {
    const stored = localStorage.getItem(SESSION_KEY);
    if (stored) return stored;
  } catch (_) { /* ignore */ }
  return 'web-' + Date.now();
}

// 消息里的图三种形态 → 可渲染 src
function imgSrc(u) {
  const s = typeof u === 'string' ? u : (u && (u.url || u.path)) || '';
  if (s.startsWith('data:')) return s;
  // 第 141 批: 服务端给的是**站内路径** ⇒ 去掉前导斜杠变相对,
  //   盘古挂在子路径下时图片才不会丢前缀。
  if (s.startsWith('/')) {
    const rel = s.replace(/^\/+/, '');
    return rel.startsWith('api/') ? rel : 'api/attachments/' + rel.split('/').pop();
  }
  return s;
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

// ── 主视图 ────────────────────────────────────────────────────────

export async function render(root) {
  const state = {
    messages: loadMessages(),
    sessionId: loadSessionId(),
    input: '',
    busy: false,
    busyStartedAt: null,
    pendingImages: [],
    subAgents: [],
    activeAgent: null,
    activeProgress: null,
    prefill: null,
    pulse: null,
    stage: null,
    lastResponseMeta: null,
    pickedModelId: null,
    modelPool: null,
    reasoningEffort: 'auto',
    settingsOpen: false,
    pickerOpen: false,
    chatSettings: {
      autoscroll: true,
      show_thinking: true,
      show_tools: true,
      show_comments: false,
    },
    rawAcc: '',
    abort: null,
    // 输入框历史上溯 (↑/↓ 翻自己发过的问题, 跨会话保留)
    inputHistory: loadInputHistory(),
  };
  let _histIdx = -1;      // 当前停在历史第几条 (-1 = 还没翻)
  let _histSnapshot = ''; // 翻历史前暂存正在打的草稿, 翻完/清空后回填

  function loadInputHistory() {
    try {
      const arr = JSON.parse(localStorage.getItem('pangu:chat:inputhistory:v1') || '[]');
      return Array.isArray(arr) ? arr.slice(0, 50).filter((s) => typeof s === 'string' && s.trim()) : [];
    } catch (_) { return []; }
  }

  for (const k of Object.keys(state.chatSettings)) {
    try {
      const v = localStorage.getItem('pangu:chat:set:' + k);
      if (v != null) state.chatSettings[k] = v === 'true';
    } catch (_) { /* ignore */ }
  }
  try {
    const e = localStorage.getItem('pangu:reasoning_effort');
    if (e && e !== 'off') state.reasoningEffort = e;
  } catch (_) { /* ignore */ }

  // ── 骨架 ────────────────────────────────────────────────────────
  const wrap = el('div', { class: 'chat chat-full' });
  const dropOverlay = el('div', { class: 'pg-drop-overlay' });
  dropOverlay.hidden = true;
  dropOverlay.appendChild(el('div', { class: 'pg-drop-hint' }, '松手投放图片'));
  wrap.appendChild(dropOverlay);

  // 工具栏
  const toolbar = el('div', { class: 'pangu-chat-toolbar' });
  const titleBox = el('div', { class: 'pg-toolbar-title' });
  const titleLine = el('div', { class: 'pg-toolbar-title-main' }, '新对话');
  // 2026-10-28: 原来写「会话 <内部 id 后 8 位>」—— 老板看着直接问「这什么玩意」:
  //   那是 session id 的尾巴 (web-1793124838326 → 24838326), 对人毫无意义,
  //   还会跟探针 id 撞脸 (probe-xxx-1793160831526 → 60831526)。
  //   ⇒ 改成**这段对话的第一句话**; 完整 id 挂 title 属性, 排查时还能查。
  const titleSub = el('div', { class: 'pg-toolbar-title-sub' }, '还没开口');
  titleSub.title = '会话 id: ' + state.sessionId;
  titleBox.appendChild(titleLine);
  titleBox.appendChild(titleSub);
  toolbar.appendChild(titleBox);
  const newBtn = el('button', { class: 'pg-btn pangu-action-btn', type: 'button', title: '开新对话' });
  newBtn.appendChild(elHTML('span', { class: 'pg-ico-line' }, iconHTML('plus', 14)));
  // 第 143 批: 原来按钮也叫「新对话」, 跟左边的标题一模一样 ⇒ 一屏里同一个词
  //   出现两遍。这个按钮的实际动作是**丢掉当前这轮、另起一局**, 换个说法才准。
  newBtn.appendChild(el('span', {}, '换个话题'));
  toolbar.appendChild(newBtn);
  const clearBtn = elHTML('button', {
    // 第 166 批: 原来叫「清空当前对话」, 实际动作是**清掉本地全部会话历史**
    //   (localStorage.removeItem + 确认框都这么说), 名字跟动作对不上,
    //   跟旁边的「换个话题」也像同一件事。改成「清空全部历史」。
    class: 'pg-icon-btn', type: 'button', title: '清空全部历史', 'aria-label': '清空全部历史',
  }, iconHTML('trash', 15));
  toolbar.appendChild(clearBtn);
  const agentBadge = el('span', { class: 'pg-badge' }, '待输入');
  toolbar.appendChild(agentBadge);
  wrap.appendChild(toolbar);

  // 顶部状态区 (只留「正在等」的证据: stage / pulse / prefill / progress)
  const statusArea = el('div', { class: 'pg-chat-status' });
  statusArea.hidden = true;
  wrap.appendChild(statusArea);

  // 消息流
  const list = el('div', { class: 'pangu-chat-messages' });
  wrap.appendChild(list);

  // 状态栏
  const statusbar = el('div', { class: 'pangu-statusbar' });
  wrap.appendChild(statusbar);

  // 输入区
  const composer = el('div', { class: 'pangu-composer' });
  const composerInner = el('div', { class: 'pg-composer-inner' });
  const thumbs = el('div', { class: 'pg-composer-thumbs' });
  thumbs.hidden = true;
  composerInner.appendChild(thumbs);
  const composerRow = el('div', { class: 'pg-composer-row' });
  const perm = createPermissionPopover({
    sessionId: state.sessionId,
    onChange: () => { /* 权限变了不用重画消息 */ },
  });
  composerRow.appendChild(perm.root);
  const ta = el('textarea', {
    class: 'pg-composer-input',
    // 第 166 批: 窄屏用短版提示 —— 原来那句 30 多个字在 390px 屏上折成三行,
    //   而输入框只有 48px 高 ⇒ 框里**自己长出一条滚动条**, 一眼看过去像坏了。
    placeholder: window.matchMedia && window.matchMedia('(max-width: 640px)').matches
      ? '把事交给我 —— 尽管问'
      : '把事交给我 —— 尽管问，或描述要做什么 (支持截图粘贴 / 拖图片)',
    rows: '2',
  });
  composerRow.appendChild(ta);
  // 第 148 批: 发送按钮**默认不是 primary**。
  //   以前它永远是那颗绿药丸 —— 空着输入框它也亮着, 屏幕上唯一的实心绿
   //   抢走了全部注意力, 而它此刻什么也做不了 (doSend 见到空串直接返回)。
  //   现在: 没内容 = 灰着 (disabled), 有内容 = 才变绿。
  //   顺带解决了「一屏只许一个 primary」: 首屏焦点面板的「开始一个会话」
  //   才是空态下唯一的实心绿。
  const sendBtn = el('button', { class: 'pg-btn pg-send', type: 'button' }, '发送');
  composerRow.appendChild(sendBtn);

  /** 发送按钮的可用态: 没内容 / 忙 = 灰着, 有内容 = 才变绿 (primary)。 */
  function paintSendBtn() {
    const can = !!(state.input.trim() || state.pendingImages.length) && !state.busy;
    sendBtn.classList.toggle('pg-btn-primary', can);
    sendBtn.disabled = !can;
  }
  composerInner.appendChild(composerRow);
  composer.appendChild(composerInner);
  wrap.appendChild(composer);

  root.appendChild(wrap);

  // ── 画 ──────────────────────────────────────────────────────────

  function currentModel() {
    const id = state.pickedModelId || (state.modelPool && state.modelPool.current_model_id);
    const list = (state.modelPool && state.modelPool.models) || [];
    return list.find((x) => String(x.id).trim().toLowerCase() === String(id || '').trim().toLowerCase()) || null;
  }

  function paintToolbar() {
    titleLine.textContent = state.messages.length ? '当前对话' : '新对话';
    // 第 144 批: **空会话时工具栏的标题块藏起来**。
    //   它写着「新对话 / 这处开口」, 底下空态的大标题写着「复杂问题, 从这里开始」——
    //   同一屏里两处都在回答"我现在该干嘛", 一个在顶上一个小字, 一个在中间一个大字,
    //   小的那个纯属噪音, 而且把大标题往下挤了 60px (工具栏 + 分隔线)。
    //   有消息之后它才有意义 (显示首句摘要), 那时才显示。
    // 第 166 批: 空会话时标题块**藏起来**是对的 (空态里有大标题, 顶上再来一行
    //   小字是噪音) —— 但不能 `hidden` (display:none), 那一格不占位,
    //   工具栏右侧的「换个话题 / 清空 / 待输入」就贴到左沿去了:
    //   同一个工具栏, 空态在左、有对话在右, 一换页动作按钮就跳位置。
    //   改成 `visibility: hidden` —— 不显示, 但**照样占位**, 按钮永远在右。
    titleBox.classList.toggle('is-blank', !state.messages.length);
    // 11-04 照搬样稿首页: 空态用样稿那个**内联** composer (hero 下方),
    // 吸底的全站 pangu-composer 藏起来 —— 两个输入框不并存。有消息了再放出来。
    composer.style.display = state.messages.length ? '' : 'none';
    // 底部 statusbar (切模型/推理强度那条) 样稿首页也没有, 空态一并藏, 有消息放回。
    statusbar.style.display = state.messages.length ? '' : 'none';
    const _first = (state.messages || []).find(m => m && m.role === 'user'
      && typeof m.content === 'string' && m.content.trim());
    const _topic = _first ? _first.content.replace(/\s+/g, ' ').trim() : '';
    titleSub.textContent = _topic
      ? (_topic.length > 26 ? _topic.slice(0, 26) + '…' : _topic)
      : '还没开口';
    titleSub.title = '会话 id: ' + state.sessionId;
    const running = state.subAgents.filter((a) => a.status === 'running');
    const names = Array.from(new Set(
      (state.activeAgent ? [state.activeAgent.agent] : []).concat(running.map((a) => a.agent)),
    ));
    if (!names.length) {
      // 第 143 批: 「静候」是旧词, 而且那颗药丸原本是红的 (像报错)。
      // 现在空闲说「待输入」, 红色只留给真的失败。
      agentBadge.textContent = '待输入';
      agentBadge.title = '将灵状态 — 当前无活可派';
      agentBadge.style.color = '';
      return;
    }
    const labels = names.map((c) => {
      const r = findGua(c);
      // 第 161 批: 原来拼的是 Unicode 卦符 (☵ 坎) —— 那是**字体符号**,
      // 各系统字形不同, 而且是个孤零零的符号, 读不出是谁。这里改成卦名文字。
      return r ? r.gua : c;
    });
    const okAll = running.every((a) => a.ok !== false);
    // 2026-11-04: 卦名染五行墨色; 有失败时仍退回纯文本 —— 红色告警优先于五行。
    agentBadge.textContent = '';
    if (okAll) {
      names.forEach((c, i) => {
        const r = findGua(c);
        const wx = r && TRIGRAM_WX[r.gua];
        if (i) agentBadge.appendChild(document.createTextNode(' '));
        agentBadge.appendChild(wx
          ? el('span', { class: 'pg-wxg pg-wxg-' + wx }, r.gua)
          : document.createTextNode(labels[i]));
      });
    } else {
      agentBadge.textContent = labels.join(' ');
    }
    // 第 135 批: 原来用 ' ⚠' 字符当"有失败"的标记 —— emoji/符号字形各平台不一样,
    //   颜色也不跟状态体系走。改成 class, 由 CSS 给颜色。
    agentBadge.classList.toggle('is-warn', !okAll);
    agentBadge.title = names.map((c) => {
      const r = findGua(c);
      return r ? guaLabel(r) : c;
    }).join(' · ') + (state.activeAgent ? ' (正在 ' + state.activeAgent.tool + ')' : '');
    agentBadge.style.color = okAll ? '' : 'var(--red)';
  }

  function paintStatusArea() {
    const show = !!(state.activeProgress || state.pulse || state.prefill || state.stage);
    statusArea.hidden = !show;
    if (!show) return;
    statusArea.innerHTML = '';
    if (state.stage && !state.pulse) {
      statusArea.appendChild(renderStageLight(state.stage));
    }
    if (state.pulse) statusArea.appendChild(renderPulseLight(state.pulse));
    if (state.prefill) {
      const row = el('div', {
        class: 'pg-chat-prefill',
        title: '本地模型先把上下文读进显存才开始吐字, 这段时间界面原本完全没动静',
      });
      row.appendChild(el('span', {}, '正在读取上下文'
        + (state.prefill.input_tokens ? ' (' + Number(state.prefill.input_tokens).toLocaleString() + ' token)' : '')));
      row.appendChild(el('span', {}, '已等待'));
      const total = Number.isFinite(state.prefill.total_ms)
        ? state.prefill.total_ms : (state.prefill.elapsed_ms || 0);
      row.appendChild(el('span', { class: 'pg-mono pg-primary' }, Math.round(total / 1000) + 's'));
      row.appendChild(el('span', { class: 'pg-prefill-dots' }, '…'));
      statusArea.appendChild(row);
    }
    if (state.activeProgress) {
      const bar = renderProgressBar(state.activeProgress);
      if (bar) statusArea.appendChild(bar);
    }
  }

  const mdCache = new Map();

  function mdHtml(text) {
    const key = String(text || '');
    if (mdCache.has(key)) return mdCache.get(key);
    let html = '';
    try {
      html = renderMarkdown(key);
    } catch (_) {
      html = '<p>' + esc(key) + '</p>';
    }
    if (mdCache.size > 200) mdCache.clear();
    mdCache.set(key, html);
    return html;
  }

  function visibleMessages() {
    return state.messages.filter((m) => {
      if (!m) return false;
      if (m.type === 'plan') return shouldShowPlan(m.plan, state.subAgents);
      if (m.type) return true;
      if (m.role === 'assistant') {
        const hasContent = String(m.content || '').trim().length > 0;
        const hasPayload = m.toolCall || m.toolResult || m.plan || m.todo || m.progress || m.thinkPhase;
        return hasContent || !!hasPayload;
      }
      return true;
    });
  }

  function renderMessageContent(m, box) {
    const images = Array.isArray(m.images) && m.images.length ? m.images : null;
    if (images) {
      const strip = el('div', { class: 'pg-msg-imgs' });
      for (const u of images) {
        const a = el('a', { href: imgSrc(u), target: '_blank', rel: 'noreferrer' });
        a.appendChild(el('img', { class: 'pg-msg-img', src: imgSrc(u), alt: 'attach' }));
        strip.appendChild(a);
      }
      box.appendChild(strip);
    }
    if (m.content) {
      const md = el('div', { class: 'md-root' });
      md.innerHTML = mdHtml(m.content);
      box.appendChild(md);
    }
    if (m._had_images > 0 && !images) {
      box.appendChild(el('div', { class: 'pg-msg-note' },
        '[含 ' + m._had_images + ' 张图片，已不存本地]'));
    }
  }

  function renderStreamTail(box) {
    const tail = el('span', { class: 'pg-cursor' });
    box.appendChild(tail);
    return tail;
  }

  /** 将灵名节点: 卦名染五行墨色 (2026-11-04 颜色对照, 跟卦印同一套语言)。 */
  function guaNameNode(r, prefix, suffix) {
    const s = el('span');
    if (prefix) s.appendChild(document.createTextNode(prefix));
    const wx = r && TRIGRAM_WX[r.gua];
    s.appendChild(wx
      ? el('span', { class: 'pg-wxg pg-wxg-' + wx }, r.gua)
      : document.createTextNode((r && r.gua) || ''));
    s.appendChild(document.createTextNode(' · ' + ((r && r.role) || '') + (suffix ? ' · ' + suffix : '')));
    return s;
  }

  function renderMessage(m) {
    const activity = isActivityMsg(m);
    const row = el('div', {
      class: 'pangu-chat-message ' + (activity ? 'is-activity' : (m.role === 'user' ? 'is-user' : 'is-assistant')),
    });
    const bubble = el('div', { class: activity ? 'pg-act-wrap' : 'pg-msg-bubble' });

    if (activity) {
      if (m.type === 'tool_call' || m.type === 'tool_result') {
        if (!state.chatSettings.show_tools) return null;
        if (m.toolCall) {
          // 2026-10-28: 子 agent 的工具事件现在也穿透到主气泡 (见 subagent_runner.js
          //   的 sink 穿透白名单)。带 agent 归属时把将灵名挂在工具名前面 ——
          //   否则主 agent 与将灵的工具卡长得一模一样, 分不清谁在干活。
          let _toolName = m.toolCall.name;
          let _guaMark = null;
          let _nameNode = null;
          if (m.toolCall.agent) {
            const _r = findGua(m.toolCall.agent);
            if (_r) {
              // 第 161 批: Unicode 卦符 (☵) 换成**真卦象** —— 名字那一列
              // 已经写着「坎 · 读」, 图标位再放个字符是重复, 放卦象才是身份。
              _guaMark = guaMark(_r.gua);
              _toolName = guaLabel(_r) + ' · ' + _toolName;
              // 2026-11-04: 卦名染五行墨色 (文本内容与 _toolName 完全一致, 只是带色)。
              _nameNode = guaNameNode(_r, '调用 ', m.toolCall.name);
            }
          }
          bubble.appendChild(renderActivityLine({
            kind: 'tool',
            name: _toolName,
            nameNode: _nameNode,
            guaMark: _guaMark,
            detail: pickDetail(m.toolCall.params, 52),
            status: m.toolResult
              ? (m.toolResult.ok === false ? (m.toolResult.blocked ? 'blocked' : 'fail') : 'ok')
              : 'running',
            durationMs: m.toolResult
              ? Math.max(0, (m.toolResult.ts || Date.now()) - (m.toolCall.ts || Date.now()))
              : null,
            ts: m.toolCall.ts || m.ts,
          }));
        }
      } else if (m.type === 'thinking') {
        if (!state.chatSettings.show_thinking) return null;
        bubble.appendChild(renderActivityLine({
          kind: 'thinking',
          status: m.thinkingDone ? 'ok' : 'running',
          chars: m.thinkChars || 0,
          ts: m.ts,
        }));
      } else if (m.type === 'notice') {
        const note = el('div', { class: 'pg-act-notice' });
        const noticeIco = el('span', { class: 'pg-act-notice-ico', 'aria-hidden': 'true' });
        noticeIco.innerHTML = iconHTML(m.noticeFail ? 'alert-triangle' : 'info', 14);
        note.appendChild(noticeIco);
        note.appendChild(el('span', {}, m.noticeText || ''));
        bubble.appendChild(note);
      } else if (m.type === 'agent_line') {
        if (!state.chatSettings.show_tools) return null;
        let name;
        let _guaMark = null;
        let _nameNode = null;
        if (m.agent === 'queue') name = '排队';
        else {
          const r = findGua(m.agent);
          if (r) {
            name = guaLabel(r);
            _guaMark = guaMark(r.gua);
            _nameNode = guaNameNode(r);
          } else name = m.agent;
        }
        bubble.appendChild(renderActivityLine({
          kind: 'agent',
          name,
          nameNode: _nameNode,
          guaMark: _guaMark,
          detail: m.tool,
          status: m.agentOk === false ? 'fail' : 'ok',
          ts: m.ts,
        }));
      }
      row.appendChild(bubble);
      return row;
    }

    renderMessageContent(m, bubble);
    if (m.streaming) renderStreamTail(bubble);

    // 快速选项 chip
    if (!m.streaming && m.role === 'assistant') {
      const replies = extractQuickReplies(m.content || '');
      if (replies.length) {
        const chips = el('div', { class: 'pg-quick' });
        for (const r of replies) {
          const b = el('button', {
            class: 'pg-quick-chip', type: 'button',
            title: '发送 ' + r.key + ' → ' + r.label,
          });
          b.appendChild(el('b', {}, r.key + '.'));
          b.appendChild(el('span', {}, r.label.length > 14 ? r.label.slice(0, 14) + '…' : r.label));
          b.addEventListener('click', () => doSend(r.key + '. ' + r.label));
          chips.appendChild(b);
        }
        bubble.appendChild(chips);
      }
    }

    if (m.gua) {
      const card = renderHexagramCard(m.gua, { scenario: m.scenario });
      if (card) bubble.appendChild(card);
    }
    if (m.diff) {
      bubble.appendChild(renderDiffViewer({
        file: m.diff.file, diff: m.diff.diff,
        before: m.diff.before, after: m.diff.after, changes: m.diff.changes,
      }));
    }
    if (Array.isArray(m.diffs)) {
      for (const d of m.diffs) {
        bubble.appendChild(renderDiffViewer({
          file: d.file, diff: d.diff, before: d.before, after: d.after, changes: d.changes,
        }));
      }
    }
    if (m.plan && shouldShowPlan(m.plan, state.subAgents)) {
      const np = normalizePlan(m.plan);
      if (np) {
        bubble.appendChild(renderPlanCard(np, {
          stepStates: stepStatesFor(np.steps, state.subAgents, m.ts),
          ts: m.ts,
        }));
      }
    }
    if (m.progress) {
      const bar = renderProgressBar(m.progress);
      if (bar) bubble.appendChild(bar);
    }
    if (m.todo) {
      const tv = renderTodoViewer(m.todo.todos || [], m.todo.ts);
      if (tv) bubble.appendChild(tv);
    }

    // 页脚: 时间 · 谁说的
    const foot = el('div', { class: 'pg-msg-foot' });
    foot.appendChild(document.createTextNode(
      fmtTs(m.ts) + ' · ' + (m.role === 'user' ? '问事者' : '盘古')));
    if (m.images && m.images.length) {
      foot.appendChild(elHTML('span', { class: 'pg-ico-line' },
        iconHTML('paperclip', 11) + '<span>' + m.images.length + '</span>'));
    }
    bubble.appendChild(foot);

    row.appendChild(bubble);
    return row;
  }

  /**
   * 工具活动行折叠分组 (2026-11-26 老板: 「这种调用能不能像 codex 一样折叠起来」)。
   *
   * vis = 可见消息序列。连续的活动行 (tool_call / agent_line / thinking / notice)
   * 构成一段; 一段里 **工具动作** (tool_call + agent_line) 超过 5 条才折叠,
   * 零散两三行的不折 (折了反而费点)。
   *
   * 返回 { hidden: Set(vis下标), bars: [{at, groupId, count, running, expanded}] }:
   *   · hidden — 本次渲染要跳过的活动行下标;
   *   · bars   — 在 vis[at] 之前要插的折叠条 (at = 段首下标)。
   * 段状态:
   *   · 完成段 (段后还有消息 ⇒ 不是本轮最新段): 默认收起整段;
   *   · 运行段 (最后一段 且 state.busy): 尾部 2 行保留看活, 前面收起;
   *   · state.toolGroups[groupId] 存用户手动展开/收起的覆盖 (展开后整段全显)。
   */
  function buildToolGroups(vis) {
    const res = { hidden: new Set(), bars: [] };
    if (!Array.isArray(vis) || vis.length < 6) return res;
    state.toolGroups = state.toolGroups || {};
    const isAct = (m) => !!m && (m.type === 'tool_call' || m.type === 'agent_line'
      || m.type === 'thinking' || m.type === 'notice');
    // 一个工具 = tool_call 消息 + tool_result 消息 两条; 计数按 tool_call (一次调用),
    //   tool_result 是结果行, 跟所属段一起隐显, 不单独计数。
    const isActFull = (m) => isAct(m) || m.type === 'tool_result';
    // 工具动作行: 消息**带 toolCall 字段**就算一次动作 —— 工具结果回灌时同一条消息
    //   type 会从 tool_call 翻成 tool_result (见 SSE tool_result 分支), 所以按 type 判会漏。
    //   agent_line (将灵行) 也算动作。
    const isToolLike = (m) => !!m && (!!m.toolCall || m.type === 'agent_line');

    // 切段: 连续活动行
    const segs = [];   // {start, end} (end 不含)
    let i = 0;
    while (i < vis.length) {
      if (!isActFull(vis[i])) { i++; continue; }
      let j = i;
      while (j < vis.length && isActFull(vis[j])) j++;
      segs.push({ start: i, end: j });
      i = j;
    }
    if (!segs.length) return res;

    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s];
      const toolN = [];
      for (let k = seg.start; k < seg.end; k++) if (isToolLike(vis[k])) toolN.push(k);
      if (toolN.length <= 5) continue;   // 段不够长, 不折

      const lastSeg = s === segs.length - 1;
      const running = lastSeg && state.busy;
      const groupId = 'tg_' + (vis[seg.start].ts || seg.start);
      const expanded = !!state.toolGroups[groupId];
      if (expanded) {
        // 用户已展开 ⇒ 整段全显, 但**折叠条还在** (文案切「收起」) —— 得留个收回去的入口
        res.bars.push({ at: seg.start, groupId, count: toolN.length, running, expanded: true });
        continue;
      }

      if (running) {
        // 运行中: 保留最后 2 个工具动作 (活的进度), 段里其余行全收
        const keep = new Set(toolN.slice(-2));
        for (let k = seg.start; k < seg.end; k++) {
          if (!keep.has(k)) res.hidden.add(k);
        }
      } else {
        // 完成段: 整段收起 (非工具行 thinking/notice 也一起收, 省得露半截)
        for (let k = seg.start; k < seg.end; k++) res.hidden.add(k);
      }
      res.bars.push({ at: seg.start, groupId, count: toolN.length, running });
    }
    return res;
  }

  /** 折叠条本身: 一条细行, 点一下展开/收起。样式贴着 .pg-activity 走 (细、淡、可点)。
   *  收起态: 「▸ N 次工具动作 · 点开展」; 展开态: 「▾ N 次工具动作 · 点收起」。 */
  function renderToolGroupBar(bar) {
    const holder = el('div', { class: 'pangu-chat-message is-activity pg-tg-holder' });
    const barEl = el('div', {
      class: 'pg-tg-bar' + (bar.running ? ' is-running' : ''),
      role: 'button', 'aria-expanded': bar.expanded ? 'true' : 'false',
      'data-expanded': bar.expanded ? '1' : '0',
    });
    barEl.appendChild(el('span', { class: 'pg-tg-ico', 'aria-hidden': 'true' }));
    barEl.appendChild(el('span', { class: 'pg-tg-label' },
      bar.expanded
        ? ('' + bar.count + ' 次工具动作 · 点收起')
        : (bar.running ? ('' + bar.count + ' 次工具动作 · 运行中 · 点开展')
                       : ('' + bar.count + ' 次工具动作 · 点开展'))));
    barEl.addEventListener('click', () => {
      state.toolGroups = state.toolGroups || {};
      state.toolGroups[bar.groupId] = !state.toolGroups[bar.groupId];
      paintMessages();
    });
    holder.appendChild(barEl);
    return holder;
  }

  function paintMessages() {
    const vis = visibleMessages();
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.innerHTML = '';
    // 2026-11-26: 工具活动行折叠 (老板: 「这种调用能不能像 codex 一样折叠起来」)。
    //   连续的工具/将灵活动行超过 5 条 ⇒ 收成一条「N 次工具动作」折叠条:
    //   · 已完成的段 (后面有别的消息) ⇒ 默认整段收起, 点条展开;
    //   · 正在跑的段 (本轮 busy) ⇒ 尾部 2 行留着看活爻在动, 前面收起。
    const _groups = buildToolGroups(vis);
    if (!vis.length) {
      list.appendChild(renderEmptyStage((text) => {
        state.input = text;
        ta.value = text;
        ta.focus();
        paintSendBtn();
      }, (text) => {
        // 首页 composer 的 Enter / 发送钮 → 直接发给盘古 (跟底部同一条 doSend 路)
        doSend(text);
      }));
    }
    // 将灵面板按**真实时间**插进流里 (锚点 = 最早开工那条消息)
    let subStartTs = 0;
    for (const a of state.subAgents) {
      if (a.startTs) subStartTs = subStartTs ? Math.min(subStartTs, a.startTs) : a.startTs;
    }
    let panelAt = -1;
    if (subStartTs) {
      panelAt = vis.findIndex((m) => (m.ts || 0) >= subStartTs);
    }
    const _paintSubPanel = () => {
      const panel = renderSubAgentPanel(state.subAgents);
      if (!panel) return;
      const holder = el('div', { class: 'pangu-chat-message is-activity' });
      holder.appendChild(panel);
      list.appendChild(holder);
    };
    vis.forEach((m, i) => {
      if (i === panelAt && state.subAgents.length) {
        _paintSubPanel();
      }
      for (const bar of _groups.bars) {
        if (bar.at === i) list.appendChild(renderToolGroupBar(bar));
      }
      if (_groups.hidden.has(i)) return;
      const node = renderMessage(m);
      if (node) list.appendChild(node);
    });
    // 2026-10-28 (实跑抓原始 SSE 复现): 原来找不到锚点时兜底成 `panelAt = vis.length`,
    //   而下面 forEach 的下标 i 永远取不到 vis.length ⇒ **兜底分支是死代码** ⇒
    //   面板整轮不画。而"找不到锚点"恰恰是常态: 子 agent 开工那一刻, 本轮答案气泡
    //   还不存在, 可见消息的 ts 全都早于开工时间 ⇒ 必落 vis.length ⇒ 面板丢。
    //   老板原话「第一次以后调用子agent…都不显示」的前一半就是这条。
    //   改法: 锚点找不到就把面板画在**最后** —— 子 agent 的活本来就是这一轮最新发生的事。
    if (panelAt < 0 && state.subAgents.length) _paintSubPanel();
    // 第 135 批: 空会话 (只有空态, 一条消息都没有) 也走了 autoscroll
    //   ⇒ scrollTop = scrollHeight ⇒ 容器被滚到底, 空态的标题直接被顶出可视区,
    //   页面看起来"标题不见了"。空态不需要滚动 ⇒ 有消息才滚。
    if (vis.length && state.chatSettings.autoscroll && (atBottom || state.busy)) {
      list.scrollTop = list.scrollHeight;
    }
  }

  /**
   * 首屏 —— 对齐样稿 2.0 viewHome (老板拍板「都按照 2.0」):
   *   ① 居中 hero: 活爻柱 (盘古签名图形, 逐爻呼吸) + 大字「推演从一言始」
   *      + 副题「说一件事 —— 起卦、排盘、问策, 盘古自会寻路」;
   *   ② 入口「交给我干」三行 (最简单的问题), 走全站统一清单行;
   *   ③ 「这台机器」读数条收成主栏下面的一条宽带 (版本/模式/模型/工具/已运行);
   *   ④ 输入框是底部 composer 的主角, 中间不再放第二个。
   * 推演中 (state.busy) 活爻柱切「呼吸」动画 —— 外面看得到机器在跑。
   */
  /** 样稿首页的静态卦画列: bits=[上爻..初爻], 0=阳(实线), 1=阴(断线)。 */
  function hexColumn(bits) {
    const col = el('div', { class: 'pg-open-hexcol' });
    for (const b of bits) {
      const bar = el('i', { class: b === 1 ? 'brk' : '' });
      col.appendChild(bar);
    }
    return col;
  }

  function renderEmptyStage(onPick, onSend) {
    // 纯照搬样稿 2.0 viewHome (老板 11-04): home-hero.v2 + composer + sugg, 原样。
    //   撤掉 62ddc32 那版的活爻柱 / 清单行 / 「这台机器」读数条 —— 样稿首页没有它们。
    const box = el('div', { class: 'pg-empty-stage' });
    const main = el('div', { class: 'pg-open-main' });
    const hexline = (solid) => el('i', { class: solid ? '' : 'brk' });

    // ── home-hero.v2: 左右两枚横排卦背景 (opacity .16) + 大字 + 副题 ──
    const hero = el('div', { class: 'home-hero v2' });
    const heroHex = el('div', { class: 'hero-hex', 'aria-hidden': 'true' });
    const hxL = el('div', { class: 'hx' });
    [1,1,0,1,0,1].forEach((b) => hxL.appendChild(hexline(b)));
    const hxR = el('div', { class: 'hx' });
    [0,1,1,1,1,0].forEach((b) => hxR.appendChild(hexline(b)));
    heroHex.appendChild(hxL);
    heroHex.appendChild(hxR);
    hero.appendChild(heroHex);
    hero.appendChild(el('h1', {}, '推演从一言始'));
    hero.appendChild(el('p', {}, '说一件事 —— 起卦、排盘、问策, 盘古自会寻路'));
    main.appendChild(hero);

    // ── composer: hero 正下方的内联输入框 (样稿画在中间, 不吸底) ──
    //   正式版让这个输入框真能用: 接底部那套发送逻辑 (send = 把内容发给盘古)。
    const composer = el('div', { class: 'composer' });
    const ta = el('textarea', { 'aria-label': '输入消息' });
    ta.placeholder = '例如: 帮我排一下 1991年11月23日 20:23 生于江苏盐城的八字…';
    composer.appendChild(ta);
    const bar = el('div', { class: 'composer-bar' });
    const pill = el('button', { class: 'model-pill', 'aria-label': '选择模型', type: 'button' });
    pill.appendChild(document.createTextNode('自动 · 单机优先 ▾'));
    bar.appendChild(pill);
    bar.appendChild(el('span', { class: 'meta' }, 'Enter 发送 · Shift+Enter 换行'));
    const sp = el('span', {}); sp.style.flex = '1'; bar.appendChild(sp);
    const send = el('button', { class: 'send', 'aria-label': '发送', type: 'button' });
    send.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    bar.appendChild(send);
    composer.appendChild(bar);
    // 回车发送 / Shift+回车换行 —— 接进全局发送流程
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        const v = ta.value.trim();
        if (v) {
          ta.value = '';
          if (onSend) onSend(v);   // 直接发给盘古 (跟底部 composer 同一条 doSend 路)
          else onPick(v);
        }
      }
    });
    send.addEventListener('click', () => {
      const v = ta.value.trim();
      if (v) {
        ta.value = '';
        if (onSend) onSend(v);
        else onPick(v);
      }
    });
    main.appendChild(composer);

    // ── sugg: 入口走全站统一清单行 (.pg-list-row), 一行一条, 不许回 2×2 图标墙 ──
    //   每条 = 图标 · 标题 · 说明, 点它把示例句填进上面输入框 (不造新行为)。
    const sugg = el('div', { class: 'pg-list' });
    for (const card of SUGG_CARDS) {
      const row = listRow({ icon: card.ico, title: card.label, desc: card.desc });
      row.addEventListener('click', () => { ta.value = card.ph; ta.focus(); });
      sugg.appendChild(row);
    }
    main.appendChild(sugg);

    box.appendChild(main);

    // box._* 占位 (paintOpenLive / paintHeroModel 仍会读) —— 样稿没活爻柱/读数, 全 null 兜底
    box._liveHex = null;
    box._openWord = null;
    box._openReadout = null;
    box._modelSlot = null;
    paintOpenLive();

    return box;
  }

  /**
   * 回填焦点面板里的模型名。模型池 / 当前模型是异步拿到的,
   * 首屏画的时候还没有 ⇒ 面板上的读数必须能后补, 不能一次性写死。
   */
  function paintHeroModel() {
    const m = currentModel();
    const id = state.pickedModelId || (state.modelPool && state.modelPool.current_model_id) || '';
    const name = (m && (m.name || m.id)) || id || '未选择模型';
    // 首屏模型读数只在一个地方: 「这台机器」读数条里的模型格。
    const slot = root.querySelector('.pg-open-readout b');
    if (slot) slot.textContent = name;
  }

  /** 第 155 批: 首屏活爻柱的呼吸状态, 跟 state.busy 同步。 */
  function paintOpenLive() {
    const box = root.querySelector('.pg-empty-stage');
    if (!box || !box._liveHex) return;
    const busy = state.busy;
    box._liveHex.classList.toggle('is-busy', busy);
    if (box._openWord) {
      box._openWord.querySelector('span').textContent = busy
        ? ('推演中 · ' + (state.activeProgress || '将灵在跑'))
        : '说一件事 —— 起卦、排盘、问策, 盘古自会寻路';
    }
  }

  function renderStageLight(stage) {
    const box = el('div', { class: 'pg-chat-light', title: '盘古进入主循环之前的阶段信号 (规划 / 拆解)。' });
    box.appendChild(el('span', { class: 'pg-light-dot' }));
    box.appendChild(el('span', { class: 'pg-light-label' }, '● ' + (stage.message || '正在推演')));
    box.appendChild(el('span', { class: 'pg-light-time', 'data-ts': String(stage.ts || Date.now()) }, ''));
    return box;
  }

  function renderPulseLight(pulse) {
    const box = el('div', { class: 'pg-chat-light', title: '盘古进程存活信号 (每 5 秒一次)。数字是本轮已耗时。' });
    box.appendChild(el('span', { class: 'pg-light-dot' }));
    box.appendChild(el('span', { class: 'pg-light-label' }, '● 思考中'));
    box.appendChild(el('span', { class: 'pg-light-time', 'data-ts': String(pulse.ts || Date.now()) }, ''));
    if (typeof pulse.round === 'number' && pulse.round > 0) {
      box.appendChild(el('span', { class: 'pg-light-extra' }, '· 第 ' + (pulse.round + 1) + ' 轮'));
    }
    if (typeof pulse.tool_calls === 'number' && pulse.tool_calls > 0) {
      box.appendChild(el('span', { class: 'pg-light-extra' }, '· 已用 ' + pulse.tool_calls + ' 个工具'));
    }
    return box;
  }

  function paintStatusbar() {
    statusbar.innerHTML = '';
    const id = state.pickedModelId || (state.modelPool && state.modelPool.current_model_id) || '';
    const m = currentModel();
    const modelName = (m && (m.name || m.id)) || id || '未选择模型';
    const modelChip = el('button', {
      class: 'pangu-status-model', type: 'button', title: '点击切换模型',
    });
    modelChip.appendChild(elHTML('span', { class: 'pg-status-caret' }, iconHTML('chevron-down', 12)));
    modelChip.appendChild(el('span', {}, modelName));
    modelChip.addEventListener('click', openModelPicker);
    statusbar.appendChild(modelChip);

    const EFFORT_LABEL = { auto: '自动', low: '低', medium: '中', high: '高' };
    const effortChip = el('button', {
      class: 'pangu-status-effort pangu-effort-' + state.reasoningEffort,
      type: 'button', title: '点击循环: 自动 → 低 → 中 → 高 → 自动',
    });
    const effortIco = el('span', { class: 'pg-effort-ico', 'aria-hidden': 'true' });
    effortIco.innerHTML = iconHTML('brain', 13);
    effortChip.appendChild(effortIco);
    effortChip.appendChild(el('span', {}, EFFORT_LABEL[state.reasoningEffort] || state.reasoningEffort));
    effortChip.addEventListener('click', cycleReasoning);
    statusbar.appendChild(effortChip);

    const used = state.lastResponseMeta && state.lastResponseMeta.contextUsed;
    const limit = state.lastResponseMeta && state.lastResponseMeta.contextLimit;
    const hasData = used > 0 || limit > 0;
    const ratio = hasData && limit > 0 ? Math.min(100, Math.round((used || 0) / limit * 100)) : 0;
    if (hasData) {
      statusbar.appendChild(el('span', { class: 'pangu-status-separator' }));
      const tokenBox = el('span', { class: 'pangu-status-tokens', title: '上下文用量' });
      tokenBox.appendChild(el('span', {}, (used ? fmtTokens(used) : '—') + ' / ' + (limit ? fmtTokens(limit) : '—')));
      const track = el('span', { class: 'pangu-token-track', role: 'meter' });
      track.setAttribute('aria-valuenow', String(ratio));
      const fill = el('i');
      fill.style.width = ratio + '%';
      track.appendChild(fill);
      tokenBox.appendChild(track);
      tokenBox.appendChild(el('span', {}, ratio + '%'));
      statusbar.appendChild(tokenBox);
    }

    const sessionMs = state.busy
      ? (state.busyStartedAt ? Date.now() - state.busyStartedAt : 0)
      : ((state.lastResponseMeta && state.lastResponseMeta.elapsedMs) || 0);
    const elapsed = state.lastResponseMeta && state.lastResponseMeta.elapsedMs;
    // 没数据就不占位 —— 原来无脑渲染「— / —」「时长 —」「响应 —」,
    // 空会话的状态栏像一份没填完的表格, 一眼看过去就是「半成品」。
    if (sessionMs > 0 || elapsed) {
      statusbar.appendChild(el('span', { class: 'pangu-status-separator' }));
      if (sessionMs > 0) {
        statusbar.appendChild(el('span', { class: 'pangu-status-meta', title: '会话时长' },
          '时长 ' + fmtSessionDuration(sessionMs)));
      }
      if (elapsed) {
        statusbar.appendChild(el('span', { class: 'pangu-status-meta', title: '最近一次响应耗时' },
          '响应 ' + fmtDuration(elapsed)));
      }
    }

    const gear = el('button', {
      class: 'pangu-status-settings', type: 'button', title: '聊天设置',
    });
    gear.innerHTML = iconHTML('settings', 16);
    gear.addEventListener('click', () => {
      state.settingsOpen = !state.settingsOpen;
      paintChatSettings();
    });
    statusbar.appendChild(gear);
    if (state.busy) {
      statusbar.appendChild(el('span', { class: 'pg-status-busy' }, '● 推演中'));
    }
    // 焦点面板眉标上的模型名跟状态栏是**同一个**读数 —— 状态栏重画时
    // 顺手把面板也回填 (模型池异步到、用户换模型都要跟着变)。
    paintHeroModel();
    paintOpenLive();
  }

  function paintChatSettings() {
    const old = document.getElementById('pg-chat-settings');
    if (old) old.remove();
    if (!state.settingsOpen) return;
    const overlay = el('div', { class: 'pg-overlay-inline', id: 'pg-chat-settings' });
    overlay.addEventListener('click', () => {
      state.settingsOpen = false;
      paintChatSettings();
    });
    const panel = el('div', { class: 'pg-chat-settings' });
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.appendChild(el('div', { class: 'pg-chat-settings-title' }, '聊天设置'));
    const rows = el('div', { class: 'pg-chat-settings-rows' });
    const defs = [
      ['autoscroll', '自动滚动'],
      ['show_thinking', '显示思考'],
      ['show_tools', '显示工具'],
      ['show_comments', '显示评述'],
    ];
    for (const [k, label] of defs) {
      // 第 166 批: 原来这一行是 `<label>` 包 `<button>` —— label 只能包**可标注**的
      //   表单控件, button 不在其列 (点文字不会触发), 读屏也读不出开关状态。
      //   换成 div + role="switch" + aria-checked。
      const row = el('div', { class: 'pg-toggle-row' });
      row.appendChild(el('span', {}, label));
      const sw = el('button', {
        class: 'pg-switch' + (state.chatSettings[k] ? ' on' : ''), type: 'button',
        role: 'switch', 'aria-checked': state.chatSettings[k] ? 'true' : 'false',
        'aria-label': label,
      });
      // 旋钮走全站唯一那份 .pg-switch-knob —— 原来这里塞的是一颗空的 `<i>`,
      //   而 .pg-switch 的画法里旋钮是绝对定位的 span ⇒ 聊天设置里的开关
      //   **根本没有旋钮**, 开 = 一块实心绿, 关 = 一块灰, 状态只靠颜色。
      sw.appendChild(el('span', { class: 'pg-switch-knob' }));
      sw.addEventListener('click', () => {
        state.chatSettings[k] = !state.chatSettings[k];
        try { localStorage.setItem('pangu:chat:set:' + k, String(state.chatSettings[k])); } catch (_) { /* ignore */ }
        sw.classList.toggle('on', state.chatSettings[k]);
        sw.setAttribute('aria-checked', state.chatSettings[k] ? 'true' : 'false');
        paintMessages();
      });
      row.appendChild(sw);
      rows.appendChild(row);
    }
    panel.appendChild(rows);
    panel.appendChild(el('div', { class: 'pg-chat-settings-note' },
      '推理强度: 点击状态栏的推理强度按钮切换 · 模型: 点击状态栏模型名切换'));
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  // 模型选择弹窗 (原版 ModelPickerModal)
  let pickerEl = null;

  const EFFORT_LABEL = { auto: '自动', low: '低', medium: '中', high: '高' };
  const PROV_LABEL = {
    lmstudio: 'LM Studio (本地)', ollama: 'Ollama (本地)', vllm: 'vLLM (本地)',
    llamacpp: 'llama.cpp (本地)', openai: 'OpenAI', deepseek: 'DeepSeek',
    kimi: 'Kimi (月之暗面)', zhipu: '智谱 GLM', qwen: '通义千问',
    volcengine: '火山方舟', minimax: 'MiniMax', anthropic: 'Anthropic Claude',
    custom: 'Custom', 'custom-cloud': 'Custom (云端)',
  };

  function openModelPicker() {
    if (pickerEl) pickerEl.remove();
    const overlay = el('div', { class: 'pg-overlay' });
    const panel = el('div', { class: 'pg-modal pg-modal-wide' });
    overlay.addEventListener('click', () => { overlay.remove(); pickerEl = null; });
    panel.addEventListener('click', (e) => e.stopPropagation());

    const all = ((state.modelPool && state.modelPool.models) || []).filter((m) => m.enabled !== false);
    const providers = Array.from(new Set(all.map((m) => m.provider || 'other'))).sort();
    let provider = providers[0] || null;
    let modelId = null;
    let effort = 'auto';
    let busy = false;

    const head = el('div', { class: 'pg-modal-head' });
    head.appendChild(el('span', {}, '选择模型'));
    head.appendChild(el('span', { class: 'pg-modal-sub' }, '(模型池 · ' + all.length + ' 个)'));
    const closeBtn = elHTML('button', { class: 'pg-modal-close', type: 'button', 'aria-label': '关闭' },
      iconHTML('x', 15));
    closeBtn.addEventListener('click', () => { overlay.remove(); pickerEl = null; });
    head.appendChild(closeBtn);
    panel.appendChild(head);

    if (!all.length) {
      const empty = el('div', { class: 'pg-modal-body pg-empty-model' });
      empty.appendChild(document.createTextNode('模型池为空 · 去 '));
      empty.appendChild(el('a', { class: 'pg-primary-link', href: 'settings?tab=model' }, '设置 → 模型'));
      empty.appendChild(document.createTextNode(' 加模型'));
      panel.appendChild(empty);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      pickerEl = overlay;
      return;
    }

    const body = el('div', { class: 'pg-modal-body pg-model-body' });
    const left = el('div', { class: 'pg-model-providers' });
    const right = el('div', { class: 'pg-model-list' });
    body.appendChild(left);
    body.appendChild(right);
    panel.appendChild(body);

    const effortRow = el('div', { class: 'pg-model-effort' });
    panel.appendChild(effortRow);

    const foot = el('div', { class: 'pg-modal-foot' });
    const footText = el('div', { class: 'pg-modal-foot-text' }, '未选模型');
    const footErr = el('div', { class: 'pg-modal-err' });
    const cancelBtn = el('button', { class: 'pg-btn', type: 'button' }, '取消');
    const saveBtn = el('button', { class: 'pg-btn pg-btn-primary', type: 'button' }, '保存');
    foot.appendChild(footText);
    foot.appendChild(footErr);
    foot.appendChild(cancelBtn);
    foot.appendChild(saveBtn);
    panel.appendChild(foot);

    function paintEffort() {
      effortRow.innerHTML = '';
      const top = el('div', { class: 'pg-model-effort-top' });
      top.appendChild(el('span', {}, '推理强度 (reasoning_effort)'));
      top.appendChild(el('span', { class: 'pg-primary' }, EFFORT_LABEL[effort] || effort));
      effortRow.appendChild(top);
      const row = el('div', { class: 'pg-seg' });
      for (const o of ['auto', 'low', 'medium', 'high']) {
        const b = el('button', { class: 'pg-seg-i' + (effort === o ? ' on' : ''), type: 'button' },
          EFFORT_LABEL[o]);
        b.addEventListener('click', () => { effort = o; paintEffort(); });
        row.appendChild(b);
      }
      effortRow.appendChild(row);
    }

    function paintList() {
      right.innerHTML = '';
      const models = all.filter((m) => (m.provider || 'other') === provider);
      if (!models.length) {
        right.appendChild(el('div', { class: 'pg-empty-model' }, '该 provider 没有可用模型'));
      }
      for (const mm of models) {
        const isCur = String(modelId || '').trim().toLowerCase() === String(mm.id || '').trim().toLowerCase();
        const b = el('button', {
          class: 'pg-model-item' + (isCur ? ' on' : ''), type: 'button',
        });
        const top = el('div', { class: 'pg-model-item-top' });
        const nameBox = el('div', { class: 'pg-model-item-name' });
        nameBox.appendChild(el('span', { class: 'pg-model-item-title' }, mm.name || mm.id));
        if (isCur) nameBox.appendChild(el('span', { class: 'pg-badge pg-badge-gold' }, '当前'));
        top.appendChild(nameBox);
        const tags = el('div', { class: 'pg-model-item-tags' });
        tags.appendChild(el('span', { class: 'pg-badge' },
          mm.context_length ? Math.round(mm.context_length / 1024) + 'K' : '—'));
        top.appendChild(tags);
        b.appendChild(top);
        if (mm.endpoint) {
          b.appendChild(el('div', { class: 'pg-model-item-endpoint' }, String(mm.endpoint).replace(/\/+$/, '')));
        }
        b.addEventListener('click', () => {
          modelId = mm.id;
          effort = ['low', 'medium', 'high'].includes(mm.reasoning_effort) ? mm.reasoning_effort : 'auto';
          paintList();
          paintEffort();
        });
        right.appendChild(b);
      }
      const cur = models.find((x) => String(x.id || '').trim().toLowerCase() === String(modelId || '').trim().toLowerCase());
      footText.textContent = (cur ? '已选: ' + (cur.name || cur.id) : '未选模型')
        + ' · ' + (PROV_LABEL[provider] || provider);
    }

    function paintProviders() {
      left.innerHTML = '';
      for (const p of providers) {
        const cnt = all.filter((m) => (m.provider || 'other') === p).length;
        const b = el('button', {
          class: 'pg-model-provider' + (provider === p ? ' on' : ''), type: 'button',
        });
        b.appendChild(el('div', {}, PROV_LABEL[p] || p));
        b.appendChild(el('div', { class: 'pg-model-provider-n' }, cnt + ' 个模型'));
        b.addEventListener('click', () => {
          provider = p;
          const first = all.find((m) => (m.provider || 'other') === p);
          modelId = first ? first.id : null;
          effort = first && ['low', 'medium', 'high'].includes(first.reasoning_effort)
            ? first.reasoning_effort : 'auto';
          paintProviders();
          paintList();
          paintEffort();
        });
        left.appendChild(b);
      }
    }

    // 初始选中
    const requested = (state.modelPool && state.modelPool.current_model_id)
      || (state.modelPool && state.modelPool.default_model
        && (state.modelPool.default_model.id || state.modelPool.default_model))
      || null;
    const curModel = all.find((x) => String(x.id).trim().toLowerCase() === String(requested || '').trim().toLowerCase())
      || all[0];
    if (curModel) {
      modelId = curModel.id;
      provider = curModel.provider || 'other';
      effort = ['low', 'medium', 'high'].includes(curModel.reasoning_effort) ? curModel.reasoning_effort : 'auto';
    }

    cancelBtn.addEventListener('click', () => { overlay.remove(); pickerEl = null; });
    saveBtn.addEventListener('click', async () => {
      if (!modelId || busy) return;
      busy = true;
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中…';
      try {
        const r = await api.modelsUse(modelId);
        if (!r || !r.ok) throw new Error((r && r.error) || 'switch failed');
        const cur = all.find((x) => x.id === modelId);
        if (cur) {
          const val = effort === 'auto' ? null : effort;
          if ((cur.reasoning_effort || null) !== val) {
            try { await api.modelsUpdate({ ...cur, reasoning_effort: val }); } catch (_) { /* ignore */ }
          }
        }
        try { localStorage.setItem('pangu:reasoning_effort', effort); } catch (_) { /* ignore */ }
        state.pickedModelId = modelId;
        state.reasoningEffort = effort;
        const fresh = await api.modelsList();
        if (fresh && fresh.ok) {
          state.modelPool = { ...fresh, current_model_id: modelId };
          const fm = (fresh.models || []).find((x) => x.id === modelId);
          state.lastResponseMeta = {
            ...(state.lastResponseMeta || {}),
            modelUsed: modelId,
            modelName: (fm && fm.name) || modelId,
            provider: (fm && fm.provider) || (state.lastResponseMeta && state.lastResponseMeta.provider),
            contextLimit: (fm && fm.context_length) || (state.lastResponseMeta && state.lastResponseMeta.contextLimit),
          };
        }
        paintStatusbar();
        overlay.remove();
        pickerEl = null;
      } catch (e) {
        footErr.textContent = (e && e.message) || '保存失败';
      } finally {
        busy = false;
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
      }
    });

    paintProviders();
    paintList();
    paintEffort();
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    pickerEl = overlay;

    api.modelsList().then((f) => {
      if (f && f.ok) {
        state.modelPool = { ...f, current_model_id: state.pickedModelId || f.current_model_id };
        paintStatusbar();
      }
    }).catch(() => { /* 拉不到就用手上的 */ });
  }

  function cycleReasoning() {
    const order = ['auto', 'low', 'medium', 'high'];
    const i = order.indexOf(state.reasoningEffort);
    const next = order[(i + 1) % order.length];
    state.reasoningEffort = next;
    try { localStorage.setItem('pangu:reasoning_effort', next); } catch (_) { /* ignore */ }
    paintStatusbar();
    persistEffort(next);
  }

  async function persistEffort(next) {
    const m = currentModel();
    if (!m) return;
    const val = next === 'auto' ? null : next;
    if ((m.reasoning_effort || null) === val) return;
    try {
      await api.modelsUpdate({ ...m, reasoning_effort: val });
      if (state.modelPool) {
        state.modelPool = {
          ...state.modelPool,
          models: (state.modelPool.models || []).map((x) => (x.id === m.id ? { ...x, reasoning_effort: val } : x)),
        };
      }
    } catch (_) { /* 写不回去也不该挡住界面 */ }
  }

  function paintAll() {
    paintToolbar();
    paintStatusArea();
    paintMessages();
    paintStatusbar();
    paintSendBtn();
  }

  // ── 状态变更 ────────────────────────────────────────────────────

  function resetTransientState() {
    state.activeProgress = null;
    state.prefill = null;
    state.subAgents = [];
    state.activeAgent = null;
    state.pulse = null;
    state.stage = null;
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stripImages(state.messages)));
    } catch (_) { /* 配额爆了就放弃这一轮持久化 */ }
  }

  function scrollDown() {
    if (state.chatSettings.autoscroll) list.scrollTop = list.scrollHeight;
  }

  // ── 发送 ────────────────────────────────────────────────────────

  const _MONOLOGUE = /^(Wait|Let's|Let me|I will|I'll|One more thing|Response structure:?|\(Self-Correction|Self-Correction|Looking at|The user hasn|The user is|The user just|I need to|I should|I must|Note to self)\b[^\n]*\n?/gm;
  const _clean = (delta) => String(delta || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(_MONOLOGUE, '')
    .replace(/<\|channel\|>[\s\S]*?(?=\n|$)/g, '')
    .replace(/§\d+\.\d+ /g, '')
    .replace(/R\d+ 修 [^\n]+/g, '')
    .replace(/Co-authored-by:[^\n]+/g, '');

  function appendDelta(assistantTs, rawDelta, extra) {
    state.rawAcc += rawDelta;
    const displayAll = _clean(state.rawAcc).replace(/<think>[\s\S]*$/gi, '');
    const thinkPhase = (state.rawAcc.match(/<think>/gi) || []).length
      > (state.rawAcc.match(/<\/think>/gi) || []).length;
    const idx = state.messages.findIndex((m) => m && m.streamId === assistantTs);
    const last = idx >= 0 ? state.messages[idx] : null;
    if (last && last.role === 'assistant') {
      if (displayAll === (last.content || '') && !!last.thinkPhase === thinkPhase) return;
      const copy = state.messages.slice();
      copy[idx] = { ...last, ...(extra || {}), content: displayAll, thinkPhase, streaming: true, ts: Date.now() };
      state.messages = copy;
      paintMessages();
      return;
    }
    if (!displayAll.trim() && !thinkPhase) return;
    state.messages = state.messages.concat([{
      role: 'assistant', content: displayAll, thinkPhase, streaming: true,
      streamId: assistantTs, ts: Date.now(), ...(extra || {}),
    }]);
    paintMessages();
  }

  function handleEvent(ev, assistantTs) {
    const d = (ev && ev.data) || {};
    switch (ev.event) {
      case 'chunk': {
        if (d && d.delta) appendDelta(assistantTs, d.delta);
        break;
      }
      case 'agent_progress': {
        if (d && d.phase === 'prefill') {
          state.prefill = d;
          paintStatusArea();
        }
        break;
      }
      case 'execution_path': {
        if (d && d.model) {
          state.lastResponseMeta = { ...(state.lastResponseMeta || {}), modelUsed: d.model, provider: d.provider };
          paintStatusbar();
        }
        break;
      }
      case 'error': {
        state.prefill = null;
        const raw = errorMessage(d.error || d, 'stream error');
        state.messages = appendActivity(state.messages, [{
          role: 'system', type: 'notice', content: '', ts: Date.now(),
          noticeText: humanizeStreamError(raw), noticeFail: true,
        }], assistantTs);
        paintMessages();
        paintStatusArea();
        break;
      }
      case 'done': {
        state.lastResponseMeta = {
          modelUsed: d.model_used || (state.lastResponseMeta || {}).modelUsed,
          contextUsed: d.context_used || 0,
          contextLimit: d.context_limit || 0,
          elapsedMs: d.elapsed_ms || 0,
        };
        paintStatusbar();
        break;
      }
      case 'status': {
        if (d.status === 'failed' || d.status === 'aborted') {
          const label = d.status === 'aborted' ? '请求已中断' : '任务执行失败';
          const reason = d.reason ? '：' + d.reason : '';
          state.messages = state.messages.map((m) => (m && m.streamId === assistantTs
            ? { ...m, content: (m.content || '') + '\n✗ ' + label + reason, streaming: false, thinkPhase: false }
            : m));
          if (state.activeProgress) {
            state.activeProgress = { ...state.activeProgress, status: d.status, reason: d.reason };
          }
          paintMessages();
          paintStatusArea();
        } else if (d.stage) {
          if (d.stage === 'sub_agent_queue') {
            const row = {
              role: 'system', type: 'agent_line', agent: 'queue',
              tool: d.message || '排队等槽位', ts: Date.now(),
            };
            const qi = state.messages.findIndex((m) => m && m.type === 'agent_line' && m.agent === 'queue');
            if (qi >= 0) {
              const copy = state.messages.slice();
              copy[qi] = { ...copy[qi], ...row };
              state.messages = copy;
            } else {
              state.messages = state.messages.concat([row]);
            }
            paintMessages();
          } else {
            state.stage = { stage: d.stage, message: d.message || '', ts: Date.now() };
            paintStatusArea();
          }
        }
        break;
      }
      case 'diff': {
        state.messages = appendActivity(state.messages,
          { role: 'system', content: '', ts: Date.now(), diff: d, type: 'diff' }, assistantTs);
        paintMessages();
        break;
      }
      case 'diff_batch': {
        state.messages = appendActivity(state.messages,
          { role: 'system', content: '', ts: Date.now(), diffs: d.diffs, type: 'diff_batch' }, assistantTs);
        paintMessages();
        break;
      }
      case 'plan': {
        const sig = (pl) => (pl ? (pl.plan_id || '') + '|' + JSON.stringify(pl.steps || pl.plan || []) : '');
        const idx = state.messages.findIndex((m) => m && m.plan && sig(m.plan) === sig(d));
        if (idx >= 0) {
          const copy = state.messages.slice();
          copy[idx] = { ...copy[idx], plan: { ...copy[idx].plan, ...d } };
          state.messages = copy;
        } else {
          state.messages = appendActivity(state.messages,
            { role: 'system', content: '', ts: Date.now(), plan: d, type: 'plan' }, assistantTs);
        }
        paintMessages();
        break;
      }
      case 'todo': {
        state.messages = appendActivity(state.messages,
          { role: 'system', content: '', ts: Date.now(), todo: d, type: 'todo' }, assistantTs);
        paintMessages();
        break;
      }
      case 'stream_delta': {
        state.prefill = null;
        appendDelta(assistantTs, d.delta, { token_count: d.token_count });
        paintStatusArea();
        break;
      }
      case 'final': {
        const text = String(d.text || '')
          .replace(/<think>[\s\S]*?<\/think>/gi, '')
          .replace(/<think>[\s\S]*$/gi, '');
        if (text.trim()) {
          const idx = state.messages.findIndex((m) => m && m.streamId === assistantTs && m.role === 'assistant');
          if (idx < 0) {
            state.rawAcc = text;
            state.messages = state.messages.concat([{
              role: 'assistant', content: text, streaming: true, streamId: assistantTs, ts: Date.now(),
            }]);
          } else {
            const last = state.messages[idx];
            if (d.replace === true) {
              state.rawAcc = text;
              const copy = state.messages.slice();
              copy[idx] = { ...last, content: text, thinkPhase: false, streaming: true, ts: Date.now() };
              state.messages = copy;
            } else {
              const norm = (t) => String(t || '').replace(/\s+/g, '');
              const sigText = norm(text).slice(0, 15);
              const dup = sigText.length >= 10 && norm(last.content).includes(sigText);
              const shorter = String(last.content || '').trim().length >= text.trim().length;
              if (!dup && !shorter) {
                state.rawAcc = text;
                const copy = state.messages.slice();
                copy[idx] = { ...last, content: text, thinkPhase: false, streaming: true, ts: Date.now() };
                state.messages = copy;
              }
            }
          }
          paintMessages();
        }
        break;
      }
      case 'stream_done': {
        const idx = state.messages.findIndex((m) => m && m.streamId === assistantTs);
        if (idx >= 0) {
          const copy = state.messages.slice();
          copy[idx] = {
            ...copy[idx], streaming: false, thinkPhase: false,
            duration_ms: d.duration_ms, total_tokens: d.total_tokens, ts: d.ts || Date.now(),
          };
          state.messages = copy;
          paintMessages();
        }
        break;
      }
      case 'progress': {
        state.activeProgress = { ...(state.activeProgress || {}), ...d, status: 'progress', ts: d.ts || Date.now() };
        paintStatusArea();
        break;
      }
      case 'progress_done': {
        if (state.activeProgress) {
          state.activeProgress = {
            ...state.activeProgress, percent: 100, status: 'done',
            total_duration_ms: d.total_duration_ms, ts: d.ts || Date.now(),
          };
        }
        paintStatusArea();
        break;
      }
      case 'progress_failed': {
        if (state.activeProgress) {
          state.activeProgress = {
            ...state.activeProgress, status: 'failed',
            failed_step: d.failed_step, reason: d.reason, ts: d.ts || Date.now(),
          };
        }
        paintStatusArea();
        break;
      }
      case 'tool_call': {
        // 后端所有 tool_call 都发 { calls: [{id,name,params}, ...] } —— 收两种形状
        const calls = Array.isArray(d && d.calls) ? d.calls
          : (d && d.id && d.name ? [d] : []);
        if (calls.length) {
          state.messages = appendActivity(state.messages, calls.map((c) => ({
            role: 'system', content: '', ts: (c && c.ts) || d.ts || Date.now(),
            toolCall: {
              ...c,
              id: (c && c.id) || ((c && c.name) + '#' + Math.random().toString(36).slice(2, 8)),
            },
            type: 'tool_call',
          })), assistantTs);
          paintMessages();
        }
        break;
      }
      case 'tool_result': {
        if (d && d.id) {
          state.messages = state.messages.map((m) => (
            m && m.type === 'tool_call' && m.toolCall && m.toolCall.id === d.id
              ? { ...m, toolResult: { ...d, ts: d.ts || Date.now() }, type: 'tool_result' }
              : m
          ));
          paintMessages();
        }
        break;
      }
      case 'active_agent': {
        if (d && d.agent && findGua(d.agent)) {
          state.activeAgent = d;
          const key = d.agent + '::' + (d.tool || '');
          if (!state.messages.some((m) => m && m.type === 'agent_line' && m.agentKey === key)) {
            state.messages = appendActivity(state.messages, {
              role: 'system', type: 'agent_line', content: '', ts: Date.now(),
              agentKey: key, agent: d.agent, tool: d.tool || '', agentOk: d.ok,
            }, assistantTs);
          }
          paintToolbar();
          paintMessages();
        }
        break;
      }
      case 'heartbeat': {
        if (d && d.phase === 'active') {
          state.pulse = d;
          paintStatusArea();
        }
        break;
      }
      case 'thinking': {
        let ti = -1;
        for (let i = state.messages.length - 1; i >= 0; i--) {
          const m = state.messages[i];
          if (m && m.type === 'thinking' && !m.thinkingDone) { ti = i; break; }
        }
        if (d && d.phase === 'on') {
          if (ti >= 0) {
            const copy = state.messages.slice();
            copy[ti] = { ...copy[ti], thinkChars: d.chars || 0 };
            state.messages = copy;
          } else {
            state.messages = appendActivity(state.messages, {
              role: 'system', type: 'thinking', content: '',
              ts: (d && d.ts) || Date.now(), thinkChars: (d && d.chars) || 0, thinkingDone: false,
            }, assistantTs);
          }
        } else if (ti >= 0) {
          const copy = state.messages.slice();
          copy[ti] = { ...copy[ti], thinkChars: (d && d.chars) || copy[ti].thinkChars || 0, thinkingDone: true };
          state.messages = copy;
        }
        paintMessages();
        break;
      }
      case 'warning': {
        const msg = (d && (d.warning || d.message)) || '';
        if (msg) {
          state.messages = appendActivity(state.messages, {
            role: 'system', type: 'notice', content: '',
            ts: Date.now(), noticeText: msg, noticeFail: false,
          }, assistantTs);
          paintMessages();
        }
        break;
      }
      case 'model_switch': {
        if (d && d.from && d.to && d.from !== d.to) {
          state.messages = appendActivity(state.messages, {
            role: 'system', type: 'notice', content: '',
            ts: Date.now(),
            noticeText: '模型已切换: ' + d.from + ' → ' + d.to + (d.reason ? ' (' + d.reason + ')' : ''),
            noticeFail: false,
          }, assistantTs);
          paintMessages();
        }
        break;
      }
      case 'gua': {
        state.messages = appendActivity(state.messages, {
          role: 'system', type: 'notice', content: '',
          ts: Date.now(),
          noticeText: '起卦 · ' + (d.gua_name || d.gua_name_full || ''),
          noticeFail: false,
        }, assistantTs);
        paintMessages();
        break;
      }
      case 'sub_agent_start': {
        if (d && d.agent) {
          const sig = (a) => (a ? a.agent + '::' + (a.task || '') : '');
          const mine = sig(d);
          const card = {
            agent: d.agent, task: d.task || '', status: 'running',
            model: d.model, startTs: d.ts || Date.now(),
          };
          const exists = state.subAgents.some((a) => sig(a) === mine);
          state.subAgents = exists
            ? state.subAgents.map((a) => (sig(a) === mine ? card : a))
            : state.subAgents.concat([card]);
          paintToolbar();
          paintMessages();
        }
        break;
      }
      case 'sub_agent_progress': {
        if (d && d.agent) {
          const sig = (a) => (a ? a.agent + '::' + (a.task || '') : '');
          const mine = sig(d);
          const tools = Array.isArray(d.tools) && d.tools.length ? d.tools : undefined;
          if (!state.subAgents.some((a) => sig(a) === mine)) {
            const sameRole = state.subAgents.filter((a) => a.agent === d.agent);
            if (sameRole.length === 1) {
              state.subAgents = state.subAgents.map((a) => (a !== sameRole[0] ? a : {
                ...a,
                thinking: d.thinking_chars != null ? d.thinking_chars : a.thinking,
                tools: tools || a.tools,
              }));
            } else if (sameRole.length === 0) {
              // planner 阶段只发 progress 不发 start —— 建卡只挂 start 的话这段全丢
              state.subAgents = state.subAgents.concat([{
                agent: d.agent, task: d.task || '', status: 'running',
                model: d.model || null,
                thinking: d.thinking_chars != null ? d.thinking_chars : null,
                tools,
                progressOnly: true,
                stage: d.stage || 'sub_progress',
                startTs: d.ts || Date.now(),
              }]);
            }
            // 同角色多张并行 → 宁可漏, 不把 A 的字数记到 B 卡上
          } else {
            state.subAgents = state.subAgents.map((a) => (sig(a) === mine ? {
              ...a,
              thinking: d.thinking_chars != null ? d.thinking_chars : a.thinking,
              tools: tools || a.tools,
            } : a));
          }
          paintMessages();
        }
        break;
      }
      case 'sub_agent_done': {
        if (d && d.agent) {
          state.subAgents = state.subAgents.map((a) => (
            a.agent === d.agent && (a.task || '') === (d.task || '')
              ? { ...a, status: 'done', summary: d.summary, artifacts: d.artifacts, endTs: d.ts || Date.now() }
              : a
          ));
          paintMessages();
        }
        break;
      }
      case 'sub_agent_error': {
        if (d && d.agent) {
          state.subAgents = state.subAgents.map((a) => (
            a.agent === d.agent && (a.task || '') === (d.task || '')
              ? { ...a, status: 'error', error: d.error, endTs: d.ts || Date.now() }
              : a
          ));
          paintMessages();
        }
        break;
      }
      default:
        break;
    }
  }

  async function doSend(overrideText) {
    const text = (typeof overrideText === 'string' ? overrideText : state.input).trim();
    if ((!text && !state.pendingImages.length) || state.busy) return;
    const ts = Date.now();
    const user = {
      role: 'user',
      content: text,
      images: state.pendingImages.length ? state.pendingImages.map((p) => p.path) : undefined,
      ts,
    };
    // UI 专用卡 (工具/差异/待办) 绝不能回灌成对话历史
    const history = state.messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && !m.type && !m._connLost)
      .map((m) => ({ role: m.role, content: m.content, images: m.images }));
    state.messages = state.messages.concat([user]);
    // 记进输入历史上溯 (↑ 翻): 去重 + 置顶 + 限 50 条, 跨会话存 localStorage
    if (text) {
      state.inputHistory = [text, ...state.inputHistory.filter((s) => s !== text)].slice(0, 50);
      try { localStorage.setItem('pangu:chat:inputhistory:v1', JSON.stringify(state.inputHistory)); } catch (_) { /* 配额爆了放弃 */ }
      _histIdx = -1; _histSnapshot = '';
    }
    state.input = '';
    ta.value = '';
    state.pendingImages = [];
    paintThumbs();
    state.busy = true;
    state.busyStartedAt = Date.now();
    state.rawAcc = '';
    resetTransientState();
    paintAll();
    paintOpenLive();

    const assistantTs = Date.now();
    const ctrl = new AbortController();
    state.abort = ctrl;

    try {
      await streamSSE('api/pangu/agent/stream', {
        input: user.content,
        images: user.images || [],
        session_id: state.sessionId,
        model: state.pickedModelId || undefined,
        reasoning_effort: state.reasoningEffort,
        messages: history.concat([{ role: 'user', content: user.content, images: user.images }]),
      }, (ev) => handleEvent(ev, assistantTs), { signal: ctrl.signal });

      // 流干净地断了却一个正文都没来 → 明说, 不留空气泡
      const idx = state.messages.findIndex((m) => m && m.streamId === assistantTs);
      if (idx < 0) {
        state.messages = appendActivity(state.messages, {
          role: 'system', content: '✗ 本轮没有收到模型正文，连接在收尾前中断，请重试。',
          ts: Date.now(), _connLost: 'empty_stream',
        }, assistantTs);
      } else {
        const target = state.messages[idx];
        if (String(target.content || '').trim()) {
          const copy = state.messages.slice();
          copy[idx] = { ...target, streaming: false };
          state.messages = copy;
        } else {
          state.messages = state.messages.filter((_, i) => i !== idx);
          state.messages = state.messages.concat([{
            role: 'system', content: '✗ 本轮没有收到模型正文，连接在收尾前中断，请重试。',
            ts: Date.now(), _connLost: 'empty_stream',
          }]);
        }
      }
      paintMessages();
    } catch (e) {
      const raw = errorMessage(e);
      let friendly = '连接中断，请重试';
      if (raw.includes('Load failed') || raw.includes('Failed to fetch') || raw.includes('NetworkError')) {
        friendly = '✗ 连接中断（可能是服务器重启）。请点「新对话」重试。';
      } else if (raw.includes('AbortError') || raw.includes('aborted')) {
        friendly = '✗ 请求已取消';
      }
      const withoutBlank = state.messages.filter(
        (m) => !(m && m.streamId === assistantTs && !String(m.content || '').trim()),
      );
      state.messages = withoutBlank.concat([
        { role: 'system', content: friendly, ts: Date.now(), _connLost: raw },
      ]);
      paintMessages();
    } finally {
      state.busy = false;
      state.busyStartedAt = null;
      state.pulse = null;
      state.stage = null;
      paintOpenLive();
      // 收工时收口悬空将灵卡 (否则面板一直写「运行中」)
      state.subAgents = state.subAgents.map((a) => (
        a.status === 'running' ? { ...a, status: 'error', error: '本轮结束未收到收工信号' } : a
      ));
      state.abort = null;
      persist();
      paintAll();
      scrollDown();
    }
  }

  // ── 交互 ────────────────────────────────────────────────────────

  function paintThumbs() {
    thumbs.innerHTML = '';
    thumbs.hidden = !state.pendingImages.length;
    // 贴了图也算「有内容」—— 发送按钮该亮了。
    paintSendBtn();
    state.pendingImages.forEach((p, i) => {
      const box = el('div', { class: 'pg-thumb' });
      box.appendChild(el('img', { class: 'pg-thumb-img', src: p.url, alt: 'pending-' + i }));
      const rm = el('button', { class: 'pg-thumb-rm', type: 'button', title: '移除' }, '✕');
      rm.addEventListener('click', () => {
        state.pendingImages = state.pendingImages.filter((_, j) => j !== i);
        paintThumbs();
      });
      box.appendChild(rm);
      thumbs.appendChild(box);
    });
  }

  sendBtn.addEventListener('click', () => doSend());
  ta.addEventListener('keydown', (e) => {
    // 输入法组字时 Enter 是上候选词, 不是发送
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      doSend();
    }
    // 上箭头 = 翻上一条自己问过的问题; 下箭头 = 翻下一条; 翻到底回填草稿
    else if (e.key === 'ArrowUp' && ta.selectionStart === ta.selectionEnd && ta.selectionStart === 0) {
      e.preventDefault();
      const h = state.inputHistory;
      if (h.length) {
        if (_histIdx === -1) { _histSnapshot = ta.value; _histIdx = h.length - 1; }
        else if (_histIdx > 0) _histIdx--;
        ta.value = h[_histIdx];
        state.input = ta.value;
        ta.selectionStart = ta.selectionEnd = ta.value.length;
        paintSendBtn();
      }
    } else if (e.key === 'ArrowDown' && _histIdx >= 0 && ta.selectionStart === ta.selectionEnd && ta.selectionStart === ta.value.length) {
      e.preventDefault();
      const h = state.inputHistory;
      if (_histIdx < h.length - 1) { _histIdx++; ta.value = h[_histIdx]; }
      else { _histIdx = -1; ta.value = _histSnapshot; _histSnapshot = ''; }
      state.input = ta.value;
      ta.selectionStart = ta.selectionEnd = ta.value.length;
      paintSendBtn();
    }
  });
  ta.addEventListener('input', () => { state.input = ta.value; paintSendBtn(); });

  newBtn.addEventListener('click', () => {
    if (!confirm('开新对话？当前会话会被清空。')) return;
    state.sessionId = 'web-' + Date.now();
    state.messages = [];
    state.pendingImages = [];
    resetTransientState();
    try { localStorage.setItem(SESSION_KEY, state.sessionId); } catch (_) { /* ignore */ }
    paintThumbs();
    paintAll();
  });

  clearBtn.addEventListener('click', () => {
    if (!confirm('清空所有对话历史（不可恢复）？')) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* ignore */ }
    state.messages = [];
    state.pendingImages = [];
    resetTransientState();
    paintThumbs();
    paintAll();
  });

  // 图片: 粘贴 / 拖拽
  async function addFiles(files) {
    const accepted = [];
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      if (f.size > 10 * 1024 * 1024) continue;
      try {
        const dataUrl = await readFileAsDataURL(f);
        let stored = null;
        try {
          const res = await fetch('api/attachments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ images: [dataUrl] }),
          });
          const j = await res.json().catch(() => null);
          if (j && j.ok && j.files && j.files[0]) stored = { path: j.files[0].path, url: j.files[0].url };
        } catch (_) { /* daemon 没起也能发图 */ }
        accepted.push(stored || { path: dataUrl, url: dataUrl });
      } catch (_) { /* 跳过读不出来的 */ }
    }
    if (accepted.length) {
      state.pendingImages = state.pendingImages.concat(accepted);
      paintThumbs();
    }
  }

  function onPaste(e) {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const files = [];
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  }
  window.addEventListener('paste', onPaste);

  function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dropOverlay.hidden = false;
  }
  function onDragLeave(e) {
    if (e.target === wrap) dropOverlay.hidden = true;
  }
  function onDrop(e) {
    e.preventDefault();
    dropOverlay.hidden = true;
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
      .filter((f) => f.type.startsWith('image/'));
    if (files.length) addFiles(files);
  }
  wrap.addEventListener('dragover', onDragOver);
  wrap.addEventListener('dragleave', onDragLeave);
  wrap.addEventListener('drop', onDrop);

  // 恢复上次会话 (服务端真源)
  async function loadSessionById(sid) {
    if (!sid) return false;
    try {
      const r = await api.agentSessionRead(sid);
      if (r && r.ok) {
        // 2026-10-28: 接口返回的是 { ok, session: { messages } } (inline_router.js 的
        //   GET /api/pangu/agent/sessions/:id), 原来前端读的是 r.result.messages
        //   ⇒ 永远 undefined ⇒ **「恢复上次会话」一直是死代码**, 刷新后聊天区永远是空的。
        //   三种形状都认 (session / result / 顶层), 以后端端为准。
        const result = (r.session && r.session.messages) ? r.session
          : (r.result && r.result.messages) ? r.result : r;
        const msgs = result && result.messages;
        if (Array.isArray(msgs)) {
          // 2026-10-28 (现场会话 web-1793124838326): 落盘会话里除了对话, 还存着
          //   **9 条 system 提示词块** (灵魂/工具清单/记忆/源码地图…) 和【子 agent 派发记录】。
          //   原来 loadSessionById 只过滤 assistant, 于是这些块全被灌进聊天区 ——
          //   老板看到的现象就是「头部重复」「全乱了」。
          //   system 是提示词不是对话, 一律不进 UI。
          state.messages = msgs.filter((m) => {
            if (!m) return false;
            if (m.role !== 'user' && m.role !== 'assistant') return false;
            if (m.role === 'assistant') {
              const text = typeof m.content === 'string' ? m.content.trim() : m.content;
              return Boolean(text) || Array.isArray(m.tool_calls) || m.type || m.name;
            }
            // dispatcher 给子 agent 拼的「[上文-仅供你参考…]」脚手架 —— 不是主人说的话, 不进 UI。
            if (typeof m.content === 'string' && /^\[上文-仅供你参考/.test(m.content.trim())) return false;
            return true;
          }).map((m) => {
            // user 消息落盘时 content 是**注入块拼过的版本** (卦块/排盘事实/纪律块),
            //   `raw` 才是主人原话 —— 显示用原话, 不显示注入块。
            if (m.role === 'user' && m.raw) return { ...m, content: m.raw };
            return m;
          });
          resetTransientState();
          state.sessionId = sid;
          try { localStorage.setItem(SESSION_KEY, sid); } catch (_) { /* ignore */ }
          paintAll();
          return true;
        }
      }
    } catch (_) { /* 拉不到就留当前会话 */ }
    return false;
  }

  // 心跳灯 / 阶段灯的秒表自己走
  const ticker = setInterval(() => {
    if (state.pulse || state.stage) paintStatusArea();
    if (state.busy) paintStatusbar();
  }, 1000);

  // 2026-08-17 原版 fix: 侧栏 SessionSidebar 点击派发 `pangu:resume-session`,
  // 之前 dispatch 了没人接 —— 现在接上, 切到那条 session 续聊。
  const onResumeSession = (e) => {
    const sid = e && e.detail && e.detail.id;
    if (sid && sid !== state.sessionId) loadSessionById(sid);
  };
  window.addEventListener('pangu:resume-session', onResumeSession);

  // 模型池
  api.modelsList().then((d) => {
    if (!d || !d.ok) return;
    state.modelPool = d;
    const first = d.models && d.models.find((m) => m.enabled !== false);
    state.pickedModelId = d.current_model_id
      || (d.default_model && (d.default_model.id || d.default_model))
      || (first && first.id)
      || null;
    const cur = currentModel();
    if (cur) {
      const e = ['low', 'medium', 'high'].includes(cur.reasoning_effort) ? cur.reasoning_effort : 'auto';
      state.reasoningEffort = e;
      try { localStorage.setItem('pangu:reasoning_effort', e); } catch (_) { /* ignore */ }
    }
    paintStatusbar();
  }).catch(() => { /* 模型池拉不到 → 状态栏显示「未选择模型」 */ });

  // 恢复上次会话
  loadSessionById(state.sessionId).then((ok) => {
    if (!ok) paintAll();
  });

  paintAll();

  return {
    destroy() {
      if (state.abort) state.abort.abort();
      clearInterval(ticker);
      window.removeEventListener('pangu:resume-session', onResumeSession);
      window.removeEventListener('paste', onPaste);
      wrap.removeEventListener('dragover', onDragOver);
      wrap.removeEventListener('dragleave', onDragLeave);
      wrap.removeEventListener('drop', onDrop);
      perm.destroy();
      if (pickerEl) { pickerEl.remove(); pickerEl = null; }
      const cs = document.getElementById('pg-chat-settings');
      if (cs) cs.remove();
      persist();
    },
  };
}

export default render;





