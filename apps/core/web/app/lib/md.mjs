// md.mjs —— 盘古消息的 markdown 渲染 (零依赖手写子集)
//
// 2026-10-27 (第 117 批): 从原版 `components/Markdown.jsx` + `lib/markdown-list.js`
//   (git 110661d^) 搬过来。盘古输出固定是 标题/表格/列表/粗体/行内代码/分隔线 这几样。
//
//   **有序列表的判据必须原样搬** (见 markdown-list.js 的账):
//   旧判据 /^\s*\d+[.、)]\s*/ 会把「1991、11、23 …」的「1991、」当编号吃掉,
//   「3.14 是圆周率」也会丢掉「3.」—— 用户自己打的字, 显示回来少一截, 且静默无报错。
//   改严的代价只是那 52 条排版差一点, 不改的代价是主人亲手打的话被静默删除 ⇒ 往严了改。

const ORDERED_ASCII = /^\s*\d{1,3}[.)](?:\s+|$)/;
const ORDERED_CJK = /^\s*\d{1,2}、(?!\d)\s*/;
const STRIP_ASCII = /^\s*\d{1,3}[.)]\s+/;
const STRIP_CJK = /^\s*\d{1,2}、(?!\d)\s*/;

export function isOrderedItem(line) {
  return ORDERED_ASCII.test(line) || ORDERED_CJK.test(line);
}

export function stripOrderedMarker(line) {
  return String(line).replace(STRIP_ASCII, '').replace(STRIP_CJK, '');
}

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 行内: `code` / **bold** / *italic* (递归, 表格单元格内也能嵌)
function inline(text) {
  const src = String(text == null ? '' : text);
  let out = '';
  let rest = src;
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+(\*[^*\n]*)?\*\*)|(\*\*[^\n]+)|(\*[^*\n]+\*)/;
  let guard = 0;
  while (rest && guard++ < 500) {
    const m = rest.match(re);
    if (!m) { out += esc(rest); break; }
    if (m.index > 0) out += esc(rest.slice(0, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) out += '<code>' + esc(tok.slice(1, -1)) + '</code>';
    else if (tok.startsWith('**')) {
      const inner = tok.endsWith('**') && tok.length > 4 ? tok.slice(2, -2) : tok.slice(2);
      out += '<strong>' + inline(inner) + '</strong>';
    } else out += '<em>' + inline(tok.slice(1, -1)) + '</em>';
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

const TABLE_SEP = /^\s*(-{3,}|\*{3,})\s*$/;

/** 一行是不是 markdown 表格的分隔行 (|---|---|)。 */
function isSeparatorRow(cells) {
  if (!cells || !cells.length) return false;
  return cells.every((c) => /^\s*:?-{2,}:?\s*$/.test(c));
}

function renderTable(lines) {
  const rows = lines
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
    // 第 2 行**不一定**是分隔行 —— 只有长得像 |---|---| 才丢。
    // (旧写法无条件丢第 2 行, 于是「只有表头 + 一行数据」的表整行数据被吃掉。)
    .filter((cells, i) => !(i === 1 && isSeparatorRow(cells)));
  if (!rows.length) return '';
  const [head, ...body] = rows;
  let h = '<table class="md-table"><thead><tr>';
  for (const c of head) h += '<th>' + inline(c) + '</th>';
  h += '</tr></thead><tbody>';
  for (const r of body) {
    h += '<tr>';
    for (const c of r) h += '<td>' + inline(c) + '</td>';
    h += '</tr>';
  }
  return h + '</tbody></table>';
}

/** 段落吸收的终止判据: 下一行是不是「另一种块」的起始。 */
function startsBlock(line) {
  if (line.trim() === '') return true;
  if (/^(#{1,4})\s/.test(line)) return true;
  if (/^\s*[-•]\s+/.test(line)) return true;
  if (line.trim().startsWith('|')) return true;
  if (line.trim().startsWith('```')) return true;
  if (TABLE_SEP.test(line)) return true;
  return isOrderedItem(line);
}

/** markdown → HTML 串 (已转义, 可直接塞 innerHTML)。 */
export function renderMarkdown(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (/^```/.test(line.trim())) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++]);
      i++;
      blocks.push('<pre class="md-pre">' + esc(buf.join('\n')) + '</pre>');
      continue;
    }

    // 表格
    if (line.trim().startsWith('|')) {
      const buf = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) buf.push(lines[i++]);
      blocks.push(renderTable(buf));
      continue;
    }

    // 标题
    const hm = line.match(/^(#{1,4})\s+(.*)$/);
    if (hm) {
      blocks.push('<div class="md-h md-h' + hm[1].length + '">' + inline(hm[2]) + '</div>');
      i++;
      continue;
    }

    // 分隔线
    if (TABLE_SEP.test(line)) {
      blocks.push('<hr class="md-hr">');
      i++;
      continue;
    }

    // 无序列表
    if (/^\s*[-•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-•]\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*[-•]\s+/, ''));
      }
      blocks.push('<ul class="md-ul">' + items.map((t) => '<li>' + inline(t) + '</li>').join('') + '</ul>');
      continue;
    }

    // 有序列表
    if (isOrderedItem(line)) {
      const items = [];
      while (i < lines.length && isOrderedItem(lines[i])) items.push(stripOrderedMarker(lines[i++]));
      blocks.push('<ol class="md-ol">' + items.map((t) => '<li>' + inline(t) + '</li>').join('') + '</ol>');
      continue;
    }

    // 普通段落 (吸收连续非空行, 保留换行)
    if (line.trim() === '') { i++; continue; }
    const buf = [];
    while (i < lines.length && !startsBlock(lines[i])) buf.push(lines[i++]);
    blocks.push('<div class="md-p">' + buf.map((l, j) => (j > 0 ? '<br>' : '') + inline(l)).join('') + '</div>');
  }
  return '<div class="md-root">' + blocks.join('') + '</div>';
}

