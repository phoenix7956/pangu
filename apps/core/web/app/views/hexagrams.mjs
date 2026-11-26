// hexagrams.mjs —— 六十四卦 (原版 `views/HexagramsView.jsx`, git 110661d^)
//
// 2026-09-17 原版已改成: 数据源 = /hexagrams API (后端 64i 唯一真源),
// 离线 fallback 已不需要 —— 浏览器版直接打 API。
//
// 卦序口径 (老板 2026-10-20 拍): 卦码 0-63 是二进制序 (index 字段),
// 通行序 1-64 是 id 字段。两个都摆出来, 不搞第二套顺序。
//
// ── 2026-10-28 第 135 批 (视觉升级) ─────────────────────────────────
// 这一页原来是全站最呆板的一块: 64 张一模一样的描边白卡, 卦象是个小 unicode
// 符号 (☰☱), 五行色只染那个符号, 顶部筛选是 6 个各自独立的灰胶囊, 而且——
// **页面自己又渲染了一遍 <h1>六十四卦</h1>**, 而顶栏 (pangu-topbar-title)
// 已经有「六十四卦」了 ⇒ 老板 10-28 圈出来的「头部重复」在这一页还没修
// (app.mjs 的 NO_OUTER_HEADING 把标题交给页面自己管, 但页面没跟上 129 批的口径)。
// 本次改法:
//   ① 去掉重复的 h1 —— 顶栏是标题真源, 页面只留一行副标题;
//   ② 卦象画成**真六爻柱** (阳爻一条实线 / 阴爻断成两段), 不再用字符当主视觉;
//   ③ 五行色改走「色章」: 色块底色 + 块里放实心材质剪影 (见下);
//   ④ 详情改成右侧栏, 不再把整个列表顶走;
//   ⑤ 顶部筛选改成全站统一分段控件 (.seg / .seg-i)。
//
// ── 2026-10-29 (第 147 批): 迁上设计系统 ───────────────────────────────
// 老板 10-29 贴了八张页面截图, 一句话: 「这根本不是一套完整的 ui,
// 这是胡拼乱凑的页面风格」。这一页是「胡拼」最典型的一块: 64 卦格子是
// 自己画的框, 筛选器是自己抄的 .seg/.seg-i, 详情是自己抄的卡, 爻辞是
// 自己抄的表 —— 跟工具集页的表、状态页的表三样并排, 一眼就是拼的。
// 本次改法 (结构全换, 内容留着):
//   · 页面根 = page() (.pg-page);
//   · 工具条 = .pg-toolbar, 五行筛选 = .pg-seg / .pg-seg-i (旧 .seg/.seg-i 已废);
//   · 卦盘 = 卡片里的一张发丝线方图 (格子仍是按钮, 卦画仍是爻柱);
//   · 详情 = 卡片 (card()), 卦名进卡头, 爻辞 = 全站唯一那张 .pg-table;
//   · 关键词 = .pg-tag, 空态 = .pg-empty;
//   · 内容性的类留着: .pg-hex-cell (卦格) / .pg-yao (爻画, 第 149 批上移设计系统) /
//     .pg-hex-seal (五行章) —— 这三个是「卦长什么样」, 不是页面外壳。
//
// ── 2026-10-30 第 168 批 (卦盘 + 读卦, 双栏重做) ────────────────────
// 老板 10-30 指名: 「六十四卦这个页面最丑」。这一页原本是全站视觉最差的一页:
// 64 格**每格一根又粗又白的爻柱** —— 64 × 6 = 384 根白杠糊成一片, 卦名被压成
// 配角, 五行是 64 颗灰药丸 ⇒ 满屏卡片墙, 只有噪声没有主次。
// 本次不是修补, 是把这一页的结构换掉:
//   ① 卦盘: 8×8 格子退成**发丝线方图** (格子无底色无边框), 每格左边一道
//      **刻痕** (爻柱画细到 1.5px、压到 45% 透明 ⇒ 是纹理不是主角),
//      右边两行字 (卦名 / 卦序 + 五行)。64 格同一左沿 ⇒ 卦名成列、卦序成列。
//   ② 五行记号: 3px 原色竖条 + 灰字 (原色一字没改, 只从「药丸」降级成「记号」)。
//   ③ 详情从「盖住卦盘的右侧浮层」改成**常驻右栏** (读卦面板): 点哪一卦换哪一卦,
//      卦盘一屏不被遮, 面板里的爻柱才是真正看得清的那根。
//   ④ 格子压到 68px 高 ⇒ 一屏放下完整六十四卦。
import { el, esc, page, flatSection, table, yaoColumn, card, cardPanel } from '../lib/util.mjs';
import { yaoEntry, TRIGRAM_WX } from '../lib/yao.mjs';

// 五行 → 色记类名。
//
// 为什么五行色只当「记号」不当字色/底色: 老板 10-27 用 macOS 取色器在课件上逐个
// 采的五行原色是**极高饱和**的 (金 #FFEE00 / 木 #00FF1D), 当文字色用在白底上
// 对比度只有 1.17:1 / 1.33:1 —— 看不见。所以卦盘上五行只留**一根 3px 竖条**
// (原色一字不改), 字走灰; 读卦面板里那枚「印章」是例外 (26px 实心块 + --on-xxx
// 的字, 对比度 ≥4.5:1), 全屏只此一枚。
const WUXING = {
  '金': { cls: 'pg-hex-seal-jin' },
  '木': { cls: 'pg-hex-seal-mu' },
  '水': { cls: 'pg-hex-seal-shui' },
  '火': { cls: 'pg-hex-seal-huo' },
  '土': { cls: 'pg-hex-seal-tu' },
};

// 2026-11-04 (对齐样稿 2.0): 五行 → ink token 名。
// 卦画、大卦名、五行签都走 --xxx-ink (墨色, 为字/笔画设计的对比度)。
const WX_TOKEN = { '金': 'metal', '木': 'wood', '水': 'water', '火': 'fire', '土': 'earth' };
const wxInk = (wx) => WX_TOKEN[wx] ? 'var(--' + WX_TOKEN[wx] + '-ink)' : '';
// 2026-11-18: 格子铺平成五行色底后, 内部字色走 --on-xxx (白字)。
// 给格子同时挂 --hx (五行色底) + --on-xxx (字色), 卦画/卦名/卦序全吃 --on-xxx。
const wxBlock = (wx) => WX_TOKEN[wx] ? 'var(--' + WX_TOKEN[wx] + ')' : '';
const wxOn = (wx) => WX_TOKEN[wx] ? 'var(--on-' + WX_TOKEN[wx] + ')' : '';

/** 五行记号 (卦盘格子里用): 3px 原色竖条 + 灰字。
 *
 * 第 168 批: 原来这里是一颗灰药丸 (竖条 + 同色淡底 + 药丸底), 64 个格子
 * 一字排开就是 64 颗灰药丸 —— 跟爻柱一起把这一页糊死。现在药丸底去掉:
 * 竖条还是那个原色 (一个字不许改), 字走灰 —— 64 个格子排过去是一列记号,
 * 颜色只点一下, 不抢卦名的戏。
 * (金 #FFEE00 纯色在白纸上几乎看不见 —— 竖条给 3px 宽 + 11px 高, 靠字认五行。)
 */
function wxMark(wuxing) {
  const w = WUXING[wuxing];
  const box = el('span', { class: 'pg-hex-wx' + (w ? ' ' + w.cls : '') });
  box.appendChild(el('span', { class: 'pg-hex-seal' }));
  // 2026-11-04 (颜色对照): 五行字从灰字改成五行墨色 (--xxx-ink),
  // 跟八字/梅花页同一套语言 —— 64 格一列排过去, 五行一眼按色分堆。
  box.appendChild(el('span', { class: 'pg-hex-wxt' + (wuxing ? ' pg-hex-wxt-' + wuxing : '') }, wuxing || ''));
  return box;
}

/** 详情页那枚五行签 (样稿 2.0 的 .wx-tag): 墨色字 + 灰底小签。
 * 取代了第 143 批的「原色实心块印章」—— 实心块是铺色, 签是字色,
 * 跟全站「五行只做字色」一条纪律。颜色走面板上的 --hx (选哪卦换哪卦)。 */
function wxTag(wuxing) {
  return el('span', { class: 'pg-hex-wxtag' }, wuxing || '');
}

export async function render(root) {
  // 第 168 批: 页面根一律 .pg-page (换页不跳宽、不跳内缩)。
  const host = page();
  host.classList.add('pg-hex');
  // 2026-11-18: 双栏页 (卦盘 + 常驻读卦面板) —— 设计系统 170 批口径里
  //   双栏页走 is-wide (1320), 但这一页漏挂了, 一直按默认 1040 挤着:
  //   卦盘列只剩 636 宽、右栏 380, 整页左对齐, 右边空一大条。
  //   四套主题全这么显 (跟主题无关, 是布局档挂错)。history.mjs 早就挂了。
  host.classList.add('is-wide');
  root.appendChild(host);
  host.appendChild(card(null, null, [el('div', { class: 'spinbox' }, '读 64i 真源…')]));

  let list = [];
  try {
    const res = await fetch('api/hexagrams');
    const j = await res.json();
    if (!j || !j.ok) throw new Error((j && j.error) || 'HTTP ' + res.status);
    list = j.hexagrams || [];
  } catch (e) {
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'errbox' }, '读 64i 失败: ' + esc((e && e.message) || e)));
    return { destroy() { /* noop */ } };
  }

  let search = '';
  let wuxingFilter = '';
  let selected = null;

  // ── 工具条: 五行分段筛选 + 搜索 ────────────────────────────────
  // 不再放第二个「六十四卦」大标题 —— 顶栏已经是标题真源 (app.mjs 的 TITLES)。
  const toolbar = el('div', { class: 'pg-toolbar' });

  // `pg-hex-filter` 是**契约名** (守卫 tests/workbench-full-ui 会钉它):
  // 「这一页有一个筛选控件」这件事不许因为改版就悄悄改名。
  const seg = el('div', { class: 'pg-seg pg-hex-filter', role: 'group', 'aria-label': '按五行筛选' });
  const segItems = [];
  for (const w of ['', '金', '木', '水', '火', '土']) {
    // 样稿 2.0: 五行筛选项字色 = 五行墨色 (.pg-hex-fx)
    const b = el('button', {
      class: 'pg-seg-i' + (w ? ' pg-hex-fx pg-hex-fx-' + w : '') + (wuxingFilter === w ? ' on' : ''),
      type: 'button',
    }, w || '全');
    b.addEventListener('click', () => {
      wuxingFilter = w;
      for (const x of segItems) x.classList.remove('on');
      b.classList.add('on');
      paintGrid();
    });
    segItems.push(b);
    seg.appendChild(b);
  }
  toolbar.appendChild(seg);
  toolbar.appendChild(el('div', { class: 'pg-toolbar-spacer' }));

  const searchInput = el('input', {
    type: 'text', class: 'pg-input pg-hex-search',
    placeholder: '搜卦名 / 卦辞 / 关键词', 'aria-label': '搜索卦',
  });
  searchInput.addEventListener('input', () => {
    search = searchInput.value;
    paintGrid();
  });
  toolbar.appendChild(searchInput);

  // ── 主体: 左卦盘 + 右读卦面板 (第 168 批: 双栏, 不再是盖住卦盘的浮层) ──
  const work = el('div', { class: 'pg-hex-work' });

  const grid = el('div', { class: 'pg-hex-grid' });
  const count = el('span', { class: 'pg-hex-count' });
  const boardSec = flatSection('卦盘', null, grid, [count]);
  const board = el('div', { class: 'pg-hex-board' });
  board.appendChild(boardSec);

  // 读卦面板: 常驻右栏 (宽 380), 点哪一卦就换哪一卦。
  const read = cardPanel('pg-hex-read');

  work.appendChild(board);
  work.appendChild(read);

  host.innerHTML = '';
  host.appendChild(toolbar);
  host.appendChild(work);

  function filtered() {
    const s = String(search || '').trim();
    return list.filter((g) => {
      if (wuxingFilter && g.elements !== wuxingFilter) return false;
      if (!s) return true;
      const hay = [g.name, g.name_cn, g.gua_ci, g.xiang, g.nature, g.elements, (g.keywords || []).join(' '), (g.yao_ci || []).join(' ')].join(' ');
      return hay.includes(s);
    });
  }

  function paintGrid() {
    grid.innerHTML = '';
    const shown = filtered();
    // 样稿 2.0: 计数后面带一句「卦画颜色 = 卦宫五行」—— 颜色第一次出现的地方,
    // 得有一句告诉人这色是什么意思。
    count.textContent = shown.length + ' / ' + list.length + ' · 卦画颜色 = 卦宫五行';
    for (const g of shown) {
      const it = el('button', {
        class: 'pg-hex-cell' + (selected && selected.id === g.id ? ' is-on' : ''),
        type: 'button',
      });
      // 样稿 2.0: 格子是**竖排居中** —— 卦画在上 (染卦宫五行, --hx 挂格子上),
      // 卦名居中, 底下一行 卦序 + 五行小签。
      // 2026-11-18: 格子铺平成五行色底 —— --pg-wx 给色块底, --on-xxx 给内部白字。
      const block = wxBlock(g.elements);
      const on = wxOn(g.elements);
      if (block) it.style.setProperty('--pg-wx', block);
      if (on) it.style.setProperty('--on-xxx', on);
      // 2026-11-18 老板拍: 卦 (卦画+卦名) 放左边, 序号 + 五行 放右边上下堆叠。
      // 格子从「竖排居中」改成「左右两栏」: 左 .pg-hex-g (卦画+卦名), 右 .pg-hex-m (序号在上 五行在下)。
      const gBox = el('span', { class: 'pg-hex-g' });
      gBox.appendChild(yaoColumn(g.binary, 'pg-hex-etch'));
      gBox.appendChild(el('span', { class: 'pg-hex-nm' }, g.name_cn || g.name));
      const mBox = el('span', { class: 'pg-hex-m' });
      mBox.appendChild(el('span', { class: 'pg-hex-ord' }, String(g.id)));
      mBox.appendChild(wxMark(g.elements));
      it.appendChild(gBox);
      it.appendChild(mBox);
      it.title = (g.nature ? g.nature + ' · ' : '') + '第 ' + g.id + ' 卦 · 卦码 ' + g.index;
      it.addEventListener('click', () => select(g));
      grid.appendChild(it);
    }
    if (!shown.length) grid.appendChild(el('div', { class: 'pg-empty pg-hex-grid-empty' }, '没匹配到 —— 换个词试试'));
  }

  function select(g) {
    selected = g;
    paintGrid();
    paintRead(g);
    // 窄屏时卦盘和读卦面板是上下摆的 —— 选完得把读卦那段带到眼前。
    if (window.matchMedia('(max-width: 1080px)').matches) {
      read.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function paintRead(g) {
    // 第 170 批: 壳建一次, 只清内容 —— 页面不再自己拼卡头卡体。
    read.body.innerHTML = '';
    read.head.innerHTML = '';
    read.head.className = 'pg-card-header pg-hex-r-head';
    if (!g) {
      read.body.appendChild(el('div', { class: 'pg-empty' }, '选一卦，看它的爻辞'));
      return;
    }
    const tr = g.trigrams || {};

    // 样稿 2.0: 整块面板的五行墨色挂在 --hx 上 —— 大卦名 / 大卦画 / 五行签
    // 都吃这一个变量, 选哪一卦就换哪一卦的色。
    const ink = wxInk(g.elements);
    if (ink) read.style.setProperty('--hx', ink);
    else read.style.removeProperty('--hx');

    // ── 头: 卦名 (全页唯一的 26px, 染卦宫五行墨色) + 卦序/卦性/纳甲 + 五行签 ──
    const head = read.head;
    const headMain = el('div', { class: 'pg-hex-r-main' });
    headMain.appendChild(el('div', { class: 'pg-hex-r-nm' }, g.name_cn || g.name));
    const sub = el('div', { class: 'pg-hex-r-sub' });
    sub.appendChild(el('span', {}, '第 ' + g.id + ' 卦'));
    if (g.nature) sub.appendChild(el('span', {}, g.nature));
    if (g.najia && g.najia.tiangan) {
      sub.appendChild(el('span', {}, '纳甲 ' + g.najia.tiangan + g.najia.dianzhi));
    }
    headMain.appendChild(sub);
    head.appendChild(headMain);
    const mark = el('div', { class: 'pg-hex-d-mark' });
    mark.appendChild(wxTag(g.elements));
    head.appendChild(mark);
    // 卦码 (0-63 二进制序) 是内部口径, 印在正文里对用户没意义 ⇒ 挪进 hover 提示,
    // 排障时鼠标一停还能看到, 平时不占版面。
    head.title = '卦码 ' + g.index;

    // ── 大卦象 (真六爻柱, 染卦宫五行墨色) + 上下卦一行注 ──
    // 样稿 2.0: 不再把上卦/本卦/下卦三根柱竖着摞 —— 一根大柱 + 一行小字注,
    // 卦画本身就是主角, 注解退成一行。
    const fig = el('div', { class: 'pg-hex-d-fig' });
    const figMain = el('div', { class: 'pg-hex-d-main' });
    figMain.appendChild(yaoColumn(g.binary, 'pg-yao-lg'));
    fig.appendChild(figMain);
    // 「上卦 乾 · 下卦 坤」—— 卦名各染各的五行墨色 (颜色对照)。
    const cap = el('div', { class: 'pg-hex-d-cap' });
    const triName = (name) => {
      const wx = TRIGRAM_WX[name];
      return wx ? el('span', { class: 'pg-hex-wxt pg-hex-wxt-' + wx }, name || '')
        : document.createTextNode(name || '');
    };
    cap.appendChild(document.createTextNode('上卦 '));
    cap.appendChild(triName(tr.upper_name));
    cap.appendChild(document.createTextNode(' · 下卦 '));
    cap.appendChild(triName(tr.lower_name));
    fig.appendChild(cap);

    const body = read.body;
    body.appendChild(fig);

    // ── 卦辞 (文言, 衬线) / 象辞 / 关键词 ──
    if (g.gua_ci) body.appendChild(el('div', { class: 'pg-hex-ci' }, g.gua_ci));
    if (g.xiang) body.appendChild(el('div', { class: 'pg-hex-xiang' }, g.xiang));
    if ((g.keywords || []).length) {
      const kw = el('div', { class: 'pg-tags pg-hex-kw' });
      for (const k of (g.keywords || [])) kw.appendChild(el('span', { class: 'pg-tag' }, k));
      body.appendChild(kw);
    }

    // ── 爻辞: 走全站唯一那张 .pg-table (爻题 | 爻辞) ──
    if ((g.yao_ci || []).length) {
      const sec = el('div', { class: 'pg-hex-yao-sec' });
      sec.appendChild(el('div', { class: 'pg-subhead' }, '爻辞 (自下而上)'));
      const rows = (g.yao_ci || []).map((yc, i) => {
        // 爻题从数据里读 (爻位阴阳/排列规则全在 lib/yao.mjs, 不在视图里现拼)
        const entry = yaoEntry(yc, g.binary, i);
        return [entry.label, entry.body];
      });
      // 第 156 批: 爻题列不再自己挂 'mono' 类 —— 等宽由 .pg-table th.mono
      // (设计系统) 出, 行数据只带内容, 不做样式。
      sec.appendChild(table(['爻题', '爻辞'], rows, '这一卦没有爻辞'));
      body.appendChild(sec);
    }
  }

  paintGrid();
  // 第 168 批: 面板常驻右栏, **默认就选中第一卦** —— 面板空着不好看,
  // 而且选中不挡卦盘 (第 160 批那个「浮层盖住三列」的毛病自然消失)。
  selected = list[0] || null;
  paintGrid();
  paintRead(selected);

  return { destroy() { /* noop */ } };
}

export default render;
