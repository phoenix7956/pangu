// history.mjs —— 历史档案 (原版 `views/HistoryView.jsx` + `views/_history_shell.jsx`)
//
// 原版是三栏布局: 主 sidebar (app.mjs 自带) │ 子 nav (本文件) │ 内容。
// 子 nav 里固定一个「累积合成记忆」入口 + N 个 session 日期入口。
// 数据源: /api/local-memory/{list,file} —— MEMORY.md 是合成记忆, memory/sessions/*.md 是当天流水。
//
// 章节解析逻辑原样搬: MEMORY.md 里有 91 个 ## 头, 但大部分是 session 时间戳 / 日期行 /
// 数字编号子段 —— 只有 emoji 标题的才是真章节, 数字子段挂到父章节下当 children。
import {
  el, esc, iconHTML, toast, page, flatSection, readout, list, listRow,
  kv, kvList, footband, catnav,
} from '../lib/util.mjs';
import { api } from '../lib/api.mjs';

const API_LIST = 'api/local-memory/list';
const API_FILE = (path) => 'api/local-memory/file?path=' + encodeURIComponent(path);

async function fetchMemoryTree() {
  const res = await fetch(API_LIST);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function fetchFile(path) {
  const res = await fetch(API_FILE(path));
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

// ─── MEMORY.md 章节解析 (## 切片) ─────────────────────────────
// 老板 §2026-07-14: 章节索引要「可读」不是「穷举」。
function parseMemorySections(md) {
  const lines = md.split('\n');
  const raw = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)/);
    if (m) {
      if (cur) raw.push(cur);
      cur = { title: m[1].trim(), body: '' };
    } else if (cur) {
      cur.body += line + '\n';
    }
  }
  if (cur) raw.push(cur);

  const isTimeStamp = (t) => /^\d{2}:\d{2}:\d{2}\s*·\s*model=/.test(t);
  const isDate = (t) => /^20\d{2}-\d{2}-\d{2}$/.test(t);
  const isSubNum = (t) => /^\d+\.\s+/.test(t);

  const sections = [];
  for (const item of raw) {
    if (isTimeStamp(item.title) || isDate(item.title)) continue; // 滤掉食材 log
    if (isSubNum(item.title) && sections.length > 0) {
      const last = sections[sections.length - 1];
      last.children = last.children || [];
      last.children.push({ title: item.title, body: item.body.trim() });
      continue;
    }
    sections.push({ title: item.title, body: item.body.trim(), children: [] });
  }
  return sections;
}

function parseSessionTranscript(md) {
  const lines = md.split('\n');
  const turns = [];
  let curTime = null;
  let curModel = null;
  let curRole = null;
  let curBuf = [];
  const flush = () => {
    if (curRole) {
      turns.push({ time: curTime, model: curModel, role: curRole, text: curBuf.join('\n').trim() });
    }
    curRole = null;
    curBuf = [];
  };
  for (const line of lines) {
    const tm = line.match(/^##\s+(\d{2}:\d{2}:\d{2})\s+·\s+model=(\S+)/);
    if (tm) { flush(); curTime = tm[1]; curModel = tm[2]; continue; }
    const rm = line.match(/^\*\*(User|Assistant)\*\*:\s*(.*)/);
    if (rm) { flush(); curRole = rm[1]; curBuf = [rm[2]]; continue; }
    if (curRole) curBuf.push(line);
  }
  flush();
  return turns;
}

function findNode(files, name) {
  for (const f of files || []) {
    if (f.name === name) return f;
    if (f.type === 'dir') {
      const r = findNode(f.children, name);
      if (r) return r;
    }
  }
  return null;
}

export async function render(root) {
  const shell = el('div', { class: 'pangu-subshell pangu-subshell-history' });

  // ── 左: 子 nav ────────────────────────────────────────────────
  // 第 170 批: 左栏原来是**自造的一套** (.pangu-subnav + .pg-hist-item),
  //   跟设置页的子导航、工具集的筛选都不是一个画法。现在统一成
  //   .pg-catnav 分类竖列 —— 全站所有「左边一列、右边内容」都用它。
  const nav = el('div', { class: 'pg-hist-rail' });
  const content = el('div', { class: 'pangu-subshell-body pangu-subshell-body-plain' });
  // 内容区用设计系统的页面外壳 (.pg-page) —— 全站每一页的根都是它,
  // 换页不跳宽、不跳内缩 (以前这页直接往 subshell-body 里塞, 自己一套内缩)。
  const pageBox = page();
  shell.appendChild(nav);
  shell.appendChild(content);
  content.appendChild(pageBox);
  root.appendChild(shell);

  let memoryText = null;
  let sessions = [];
  let activeId = 'memory';
  let expanded = {};

  const memorySections = () => (memoryText ? parseMemorySections(memoryText) : []);
  const totalTurns = () => sessions.reduce((s, x) => s + x.turns.length, 0);
  const memorySizeKb = () => (memoryText ? memoryText.length / 1024 : 0);

  // ── 加载 ──────────────────────────────────────────────────────
  async function load() {
    try {
      const t = await fetchMemoryTree();
      const memFile = findNode(t.files, 'MEMORY.md');
      if (memFile) memoryText = await fetchFile(memFile.path);
      const memDir = findNode(t.files, 'memory');
      const sessDir = memDir ? findNode(memDir.children, 'sessions') : null;
      if (sessDir) {
        const sessFiles = sessDir.children.filter((n) => n.type === 'file' && /\.md$/.test(n.name));
        const loaded = [];
        for (const f of sessFiles) {
          let text = '';
          try { text = await fetchFile(f.path); } catch (_) { continue; }
          loaded.push({
            name: f.name,
            path: f.path,
            size: f.size,
            mtime: f.mtime,
            text,
            turns: parseSessionTranscript(text),
          });
        }
        sessions = loaded;
      }
    } catch (e) {
      console.warn('[history] load memory failed:', e);
    }
    paintNav();
    paintContent();
  }

  // ── 子 nav ────────────────────────────────────────────────────
  function paintNav() {
    nav.innerHTML = '';
    const items = [];
    items.push({
      id: 'memory',
      label: '累积合成记忆',
      hint: memoryText
        ? memorySizeKb().toFixed(1) + ' KB · ' + memorySections().length + ' 章节'
        : '加载中…',
      icon: iconHTML('brain', 16),
    });

    const sorted = sessions.slice().sort((a, b) => b.name.localeCompare(a.name));
    if (sorted.length) {
      for (const s of sorted) {
        const date = s.name.replace(/\.md$/, '');
        const del = el('button', {
          class: 'pg-hist-del',
          type: 'button',
          title: '删 ' + date,
          'aria-label': '删 ' + date,
        });
        del.innerHTML = iconHTML('trash', 14);
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm('删 ' + date + ' 这一天 session?\n(物理删文件 + 清索引)')) return;
          handleDelete(date);
        });
        items.push({
          id: s.name,
          label: date,
          hint: s.turns.length + ' 轮 · ' + (s.size / 1024).toFixed(1) + ' KB',
          icon: iconHTML('file', 16),
          action: del,
        });
      }
    }
    nav.appendChild(catnav(items, activeId, (id) => {
      activeId = id;
      paintNav();
      paintContent();
    }));
    // 第 170 批: 窄屏收成**下拉** (契约 §10「左侧分类列 → 顶部下拉」)。
    //   390 屏上左 rail 占 232px, 右栏只剩 ~150px —— 读数被压成一列,
    //   标题折成两行, 整页读不下去。桌面端这个下拉是隐藏的。
    const catSelect = el('select', { class: 'pg-input pg-hist-cat-select' });
    for (const it of items) {
      const o = el('option', { value: it.id }, it.label + (it.hint ? ' · ' + it.hint : ''));
      if (it.id === activeId) o.selected = true;
      catSelect.appendChild(o);
    }
    catSelect.addEventListener('change', () => {
      activeId = catSelect.value;
      paintNav();
      paintContent();
    });
    nav.appendChild(catSelect);
    const foot = el('div', { class: 'pg-hist-foot' });
    foot.appendChild(el('div', { class: 'mono pg-hist-path' }, '~/.pangu/memory'));
    foot.appendChild(el('div', { class: 'hint' }, '本地存储，无需额外服务'));
    nav.appendChild(foot);
  }

  async function handleDelete(date) {
    // 原版确认在渲染层 (_history_shell.jsx), 搬进单文件后落在这一层 —— 不能丢
    if (!window.confirm('删 ' + date + ' 这一天 session?\n(测试用, 物理删文件 + 清索引)')) return;
    try {
      const res = await api.sessionDelete(date);
      if (res && res.ok) {
        sessions = sessions.filter((s) => s.name !== date + '.md');
        if (activeId === date + '.md') activeId = 'memory';
        paintNav();
        paintContent();
        toast('已删 ' + date);
      } else {
        toast('删失败: ' + ((res && (res.error || res.raw)) || 'unknown'), true);
      }
    } catch (e) {
      toast('删异常: ' + ((e && e.message) || e), true);
    }
  }

  // ── 内容区 ────────────────────────────────────────────────────
  function paintContent() {
    pageBox.innerHTML = '';
    // 第 170 批: 去掉自造的 .pg-hist-wrap (它自己写死 max-width: 900px ——
    //   轴只有一个真源, 在 design-system.css)。这一页是双栏 (左 rail + 右内容),
    //   所以显式声明宽轴。
    pageBox.classList.add('is-wide');
    const wrap = el('div');
    pageBox.appendChild(wrap);

    if (activeId === 'memory') {
      wrap.appendChild(memoryCard());
      // 第 150 批: 页尾收口带 —— 当天会话读数住在这, 大段死黑消掉。
      wrap.appendChild(footband(footStats(), todayLabel()));
      return;
    }
    const s = sessions.find((x) => x.name === activeId);
    if (!s) {
      wrap.appendChild(flatSection('加载中…', null, [el('div', { class: 'hint' }, '加载中…')]));
      return;
    }
    wrap.appendChild(sessionCard(s));
    // 收口带跟页头「09 轮 · 3.3 KB」同一组数, 只是换个地方再扫一眼。
    wrap.appendChild(footband([
      { k: '轮次', v: String(s.turns.length) },
      { k: '体积', v: (s.size / 1024).toFixed(1) + ' KB' },
    ], s.name.replace(/\.md$/, '')));
  }

  /** 收口带读数: 当天会话 + 总轮次 (内存没加载完就只印合成记忆)。 */
  function footStats() {
    return [
      { k: '当天会话', v: sessions.length + ' · ' + totalTurns() + ' 轮' },
      { k: '章节', v: String(memorySections().length) },
    ];
  }

  function todayLabel() {
    try {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    } catch (e) { return ''; }
  }

  /**
   * 字段行 —— 设计系统零件 (.pg-kv-row): 标签列定宽 180px, 值紧跟在后头。
   * 以前这页自己抄了一份 .pg-info-row (设置页也有一份), 两处数值还不一样。
   */
  function infoRow(label, value, mono, copyable) {
    let v = value;
    if (copyable) {
      const wrap = el('span', { class: 'pg-kv-v' });
      wrap.appendChild(el('span', { class: mono ? 'pg-mono' : '' }, String(value)));
      const cp = el('button', { class: 'pg-btn pg-btn-sm', type: 'button', title: '复制' }, '复制');
      cp.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(String(value));
          toast('已复制');
        } catch (_) { toast('复制失败', true); }
      });
      wrap.appendChild(cp);
      v = wrap;
    }
    return kv(label, v, null, mono ? 'mono' : null);
  }

  function memoryCard() {
    const secs = memorySections();
    const b = el('div');
    if (!memoryText) {
      b.appendChild(el('div', { class: 'hint' }, '加载中…'));
      return flatSection('累积合成记忆', '加载中…', [b]);
    }

    // 第 170 批: 摘要从**磁贴**改成**读数条** —— 磁贴是网格, 四项排成
    // 「4 + 0」还行, 但一屏里同时有磁贴和读数两种语言 (状态页用读数条,
    // 这一页用磁贴) —— 全站统一成读数条, 宽了自然换行, 不留洞。
    b.appendChild(readout([
      { k: '文件大小', v: memorySizeKb().toFixed(1) + ' KB' },
      { k: '章节数', v: String(secs.length) },
      { k: '合成策略', v: '30 天滚动' },
      { k: '会话数', v: String(sessions.length) },
    ]));

    // 段 2: 关键事实
    const s2 = el('div', { class: 'pg-mt' });
    s2.appendChild(el('div', { class: 'pg-subhead' }, '关键事实'));
    s2.appendChild(kvList([
      infoRow('真源目录', '~/.pangu/memory', true, true),
      infoRow('MEMORY.md', memorySizeKb().toFixed(1) + ' KB', true),
      infoRow('合成策略', '每 session 每日合并 · 30 天滚动保留'),
      infoRow('修改规则', '改前必先经主人确认语义', true),
      infoRow('合文件策略', secs.length + ' 章节', true),
    ]));
    b.appendChild(s2);

    // 段 3: 章节索引
    const childCount = secs.reduce((s, x) => s + (x.children ? x.children.length : 0), 0);
    const s3 = el('div', { class: 'pg-mt' });
    const idxHead = el('div', { class: 'pg-subhead' },
      '章节索引 · ' + secs.length + (childCount > 0 ? ' + ' + childCount + ' 子段' : ''));
    s3.appendChild(idxHead);

    // 章节索引 = 统一清单行 (.pg-list-row): 序号 + 标题 + 行数 + 展开箭头。
    const tree = list([]);
    secs.forEach((sec, i) => {
      const isOpen = !!expanded[i];
      const bodyLines = sec.body.split('\n').length;
      const kids = sec.children || [];
      const desc = kids.length ? kids.length + ' 子段 · ' + bodyLines + ' 行' : bodyLines + ' 行';
      const row = listRow({
        title: String(i + 1).padStart(2, '0') + '. ' + sec.title,
        desc,
        actions: [el('span', { class: 'pg-mono' }, (isOpen ? '▾' : '▸'))],
      });
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const next = Object.assign({}, expanded);
        next[i] = !next[i];
        expanded = next;
        paintContent();
      });
      tree.appendChild(row);

      if (isOpen) {
        const open = el('div', { class: 'pg-hist-sec-body' });
        if (sec.body) {
          open.appendChild(el('pre', { class: 'pg-pre' },
            sec.body.slice(0, 2800) + (sec.body.length > 2800 ? '\n…(已截断)' : '')));
        }
        kids.forEach((c2, ci) => {
          const d = el('details', { class: 'pg-hist-sub' });
          const sum = el('summary');
          sum.appendChild(el('span', { class: 'pg-hist-sec-idx mono' }, (ci + 1) + '.'));
          sum.appendChild(el('span', {}, c2.title.replace(/^\d+\.\s*/, '')));
          d.appendChild(sum);
          d.appendChild(el('pre', { class: 'pg-pre pg-hist-sub-body' },
            c2.body.slice(0, 1200) + (c2.body.length > 1200 ? '\n…(已截断)' : '')));
          open.appendChild(d);
        });
        row.appendChild(open);
      }
    });
    s3.appendChild(tree);
    b.appendChild(s3);

    return flatSection('累积合成记忆',
      memorySizeKb().toFixed(1) + ' KB · ' + secs.length + ' 章节', [b]);
  }

  function sessionCard(s) {
    const b = el('div', { class: 'pg-hist-turns' });
    if (!s.turns.length) {
      b.appendChild(el('div', { class: 'hint' }, '此文件无对话记录'));
    }
    s.turns.forEach((t) => {
      const isUser = t.role === 'User';
      const box = el('div', { class: 'pg-hist-turn' + (isUser ? ' is-user' : '') });
      const head = el('div', { class: 'pg-hist-turn-head' });
      const who = el('span', { class: 'pg-hist-turn-who' });
      who.innerHTML = iconHTML(isUser ? 'users' : 'bot', 12);
      who.appendChild(el('span', {}, isUser ? ' 用户' : ' 盘古'));
      head.appendChild(who);
      if (t.time) head.appendChild(el('span', { class: 'hint mono' }, t.time));
      if (t.model) head.appendChild(el('span', { class: 'hint mono ml-auto' }, t.model));
      box.appendChild(head);
      const text = el('div', { class: 'pg-hist-turn-text' });
      if (t.text) text.textContent = t.text;
      else text.appendChild(el('span', { class: 'hint italic' }, '(无内容)'));
      box.appendChild(text);
      b.appendChild(box);
    });
    const meta = s.turns.length + ' 轮 · ' + (s.size / 1024).toFixed(1) + ' KB · '
      + new Date(s.mtime).toLocaleDateString('zh-CN');
    return flatSection(s.name.replace(/\.md$/, ''), meta, [b]);
  }

  pageBox.appendChild(el('div', { class: 'spinbox' }, '读记忆库…'));
  await load();

  return { destroy() { /* 无定时器 */ } };
}

export default render;
