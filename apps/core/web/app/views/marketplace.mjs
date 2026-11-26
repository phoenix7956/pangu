// marketplace.mjs —— 工具集 (原版 `views/Marketplace.jsx`, git 110661d^, 742 行)
//
// 原版结构: 顶部 tab (工具集 / 内部工具 / MCP) + 工具集页里的
//   搜索 + 类型筛选 + 分类筛选 + 来源筛选 + 卡片网格 + 预览弹窗
//   + 自建 Skill 弹窗 + 本地导入弹窗 + URL 导入弹窗 + 应用内确认框。
// 三块数据:
//   marketplace : /api/marketplace/*  (外部 registry)
//   pangu-form  : /api/pangu/skills   (用户自建)
//   internal    : /api/marketplace/internal (内部工具顺序 = 喂给 LLM 的 tools 顺序)
//
// 2026-10-20 原版注释: 原生 confirm() 会冻住渲染进程 (自动化点不动),
// 浏览器版不冻, 但为了跟原版一致 + 风格统一, 这里统一用**应用内确认框**。
import { el, elHTML, esc, iconHTML, toast, page } from '../lib/util.mjs';
import { ICONS } from '../lib/icons.mjs';
import { api } from '../lib/api.mjs';

const SOURCE_COLORS = {
  Claude: 'pg-src-claude',
  SkillHub: 'pg-src-skillhub',
  ClawHub: 'pg-src-clawhub',
  GitHub: 'pg-src-github',
  Pangu: 'pg-src-pangu',
  社区: 'pg-src-github',
};

const SOURCE_ICONS = {
  Claude: 'sparkles',
  SkillHub: 'package',
  ClawHub: 'package',
  GitHub: 'code',
  Pangu: 'sparkles',
  社区: 'code',
};

function fmtPopularity(n) {
  const v = Number(n) || 0;
  if (v >= 100000) return (v / 1000).toFixed(0) + 'k';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
}

function skillIcon(item, size) {
  const icon = typeof (item && item.icon) === 'string' ? item.icon.trim() : '';
  // 第 143 批: 原来直接把后端给的 **emoji** 印在卡片上 (🎨🧠🛡️…) ——
  //   每个平台的字形都不一样, 还是全页唯一的一堆彩色小图, 一眼就"不专业"。
  //   后端现在直接给图标集里的**名字**, 这里渲染成同一套描边矢量图标;
  //   认不出来的退回来源图标 (SOURCE_ICONS), 绝不把名字当文字印出来。
  if (icon && ICONS[icon]) {
    const s = el('span', { class: 'pg-skill-ico' });
    s.innerHTML = iconHTML(icon, size || 18);
    return s;
  }
  const name = SOURCE_ICONS[(item && item.source) || ''] || 'package';
  const s = el('span', { class: 'pg-skill-ico' });
  s.innerHTML = iconHTML(name, size || 18);
  return s;
}

// 自建 skill → 统一的卡片形状
function mapPanguToCard(s) {
  return {
    id: 'pangu:' + s.name,
    name: s.name,
    description: s.description || '',
    icon: '',
    source: 'Pangu',
    category: '自建',
    popularity: 0,
    _kind: 'pg',
    _raw: s,
  };
}

export async function render(root) {
  // 第 147 批: 页面根 = 设计系统的页面外壳 (.pg-page)。
  // 以前这一页是**自己一套**: .pg-mp 撑满高度 + 三条自造横条 (页签/工具/筛选)
  //   + 自己滚动 (grid overflow-y) —— 全站只有它这样, 一眼就是「拼进来的」。
  // 现在: 跟别的页一样是**一条流**, 滚动交给 .pangu-content,
  //   页签/工具条用统一的 .pg-toolbar + .pg-seg, 列表用统一的 .pg-list。
  const host = page();
  root.appendChild(host);

  // ── 状态 ─────────────────────────────────────────────────────────
  let tab = 'toolbox';
  let items = [];
  let installed = [];
  let categories = ['全部'];
  let sources = ['全部'];
  let cat = '全部';
  let src = '全部';
  let q = '';
  let loading = true;
  let error = null;
  let busyId = null;
  let previewing = null;
  let sourceFilter = 'all';

  let panguSkills = [];
  let panguLoading = true;
  let panguError = null;

  let showCreate = false;
  let form = { name: '', description: '', command: '', args: '', transport: 'stdio' };
  let busyCreate = false;
  let showImport = false;
  let importPath = '';
  let busyImport = false;
  let importResult = null;
  let showImportUrl = false;
  let importUrl = '';
  let busyImportUrl = false;
  let importUrlResult = null;
  let confirmBox = null;

  // ── 骨架 ─────────────────────────────────────────────────────────
  // 第 147 批: 不吸顶。吸顶看着「高级」, 实测在这一页是**穿帮** ——
  //   内容区有 28px 上内边距, 吸顶的工具条会卡在滚动口往下一点,
  //   上内边距那一条缝里露出正在滚过去的行 (实测截图: 一行字浮在工具条上面)。
  //   而且全站只有这一页有吸顶条 —— 又是一个「只有它这样」。
  const tabBar = el('nav', { class: 'pg-mp-bar', 'aria-label': '工具集分区' });
  const pane = el('div', { class: 'pg-mp-pane' });
  const modalHost = el('div');
  host.appendChild(tabBar);
  host.appendChild(pane);
  host.appendChild(modalHost);

  // ── 数据 ─────────────────────────────────────────────────────────
  async function loadMarketplace() {
    loading = true;
    error = null;
    try {
      const params = {};
      if (cat !== '全部') params.category = cat;
      if (src !== '全部') params.source = src;
      if (q.trim()) params.q = q.trim();
      const listR = await api.marketplaceList(params);
      if (!listR || !listR.ok) throw new Error((listR && listR.error) || 'list failed');
      const instR = await api.marketplaceInstalled();
      if (!instR || !instR.ok) throw new Error((instR && instR.error) || 'installed failed');
      items = (listR.items || []).map((it) => Object.assign({}, it, { _kind: 'mp' }));
      categories = ['全部'].concat((listR.categories || []).filter((v) => v && v !== '全部'));
      sources = ['全部'].concat((listR.sources || []).filter((v) => v && v !== '全部'));
      installed = (instR.installed || []).map((s) => s.name);
    } catch (e) {
      error = String((e && e.message) || e);
    } finally {
      loading = false;
      paint();
    }
  }

  async function loadPangu() {
    panguLoading = true;
    panguError = null;
    try {
      const r = await api.listPanguSkills();
      if (!r || !r.ok) throw new Error((r && r.error) || 'load failed');
      panguSkills = (r.skills || []).filter((s) => s.source === 'pangu-form');
    } catch (e) {
      panguError = String((e && e.message) || e);
    } finally {
      panguLoading = false;
      paint();
    }
  }

  // ── 动作 ─────────────────────────────────────────────────────────
  async function handleInstall(item) {
    busyId = item.id;
    error = null;
    paint();
    try {
      const r = await api.marketplaceInstall(item.id);
      if (!r || !r.ok) throw new Error((r && r.error) || 'install failed');
      const instR = await api.marketplaceInstalled();
      if (instR && instR.ok) installed = (instR.installed || []).map((s) => s.name);
      toast('已装 ' + item.name);
    } catch (e) {
      error = '安装 ' + item.name + ' 失败: ' + ((e && e.message) || e);
    } finally {
      busyId = null;
      paint();
    }
  }

  function handleUninstall(item) {
    confirmBox = {
      title: '卸载 Skill',
      body: '确认卸载 ' + item.name + '?',
      danger: true,
      onOk: async () => {
        busyId = item.id;
        error = null;
        paint();
        try {
          const r = await api.marketplaceUninstall(item.name);
          if (!r || !r.ok) throw new Error((r && r.error) || 'uninstall failed');
          const instR = await api.marketplaceInstalled();
          if (instR && instR.ok) installed = (instR.installed || []).map((s) => s.name);
        } catch (e) {
          error = '卸载 ' + item.name + ' 失败: ' + ((e && e.message) || e);
        } finally {
          busyId = null;
          paint();
        }
      },
    };
    paint();
  }

  async function handlePreview(item) {
    previewing = Object.assign({}, item, { _loading: true });
    paint();
    try {
      const r = await api.marketplaceDetail(item.id);
      if (!r || !r.ok) throw new Error((r && r.error) || 'detail failed');
      previewing = Object.assign({}, r.skill, {
        preview: r.preview,
        _loading: false,
        _kind: 'mp',
      });
    } catch (e) {
      previewing = Object.assign({}, item, {
        preview: '预览失败: ' + ((e && e.message) || e),
        _loading: false,
      });
    }
    paint();
  }

  function isInstalled(item) {
    return installed.indexOf(item.name) >= 0;
  }

  async function submitCreate() {
    busyCreate = true;
    error = null;
    paint();
    try {
      const r = await api.createPanguSkillForm(Object.assign({}, form, {
        args: form.args ? form.args.split(/\s+/).filter(Boolean) : [],
      }));
      if (!r || !r.ok) throw new Error((r && r.error) || 'create failed');
      form = { name: '', description: '', command: '', args: '', transport: 'stdio' };
      showCreate = false;
      await loadPangu();
      toast('自建 Skill 已创建');
    } catch (e) {
      error = '创建失败: ' + ((e && e.message) || e);
    } finally {
      busyCreate = false;
      paint();
    }
  }

  async function doImport() {
    busyImport = true;
    error = null;
    paint();
    try {
      const r = await api.importSkillFromPath(importPath);
      if (!r || !r.ok) throw new Error((r && r.error) || 'import failed');
      importResult = r;
    } catch (e) {
      error = '拆解失败: ' + ((e && e.message) || e);
    } finally {
      busyImport = false;
      paint();
    }
  }

  function applyImportAndEdit() {
    if (!importResult) return;
    form = {
      name: importResult.name || '',
      description: importResult.description || '',
      command: importResult.command || '',
      args: (importResult.args || []).join(' '),
      transport: 'stdio',
    };
    showImport = false;
    showCreate = true;
    importResult = null;
    importPath = '';
    paint();
  }

  async function doImportUrl() {
    busyImportUrl = true;
    error = null;
    paint();
    try {
      const r = await api.importSkillFromUrl(importUrl);
      if (!r || !r.ok) throw new Error((r && r.error) || 'import failed');
      importUrlResult = r;
    } catch (e) {
      error = 'URL 拆解失败: ' + ((e && e.message) || e);
    } finally {
      busyImportUrl = false;
      paint();
    }
  }

  function applyUrlImportAndEdit() {
    if (!importUrlResult) return;
    form = {
      name: importUrlResult.name || '',
      description: importUrlResult.description || '',
      command: importUrlResult.command || '',
      args: (importUrlResult.args || []).join(' '),
      transport: 'stdio',
    };
    showImportUrl = false;
    showCreate = true;
    importUrlResult = null;
    importUrl = '';
    paint();
  }

  function removePangu(name) {
    confirmBox = {
      title: '删除自建 Skill',
      body: '删除 Pangu skill "' + name + '"?',
      body2: '如已转化为 MCP, 会一并移除 MCP server。',
      danger: true,
      onOk: async () => {
        error = null;
        try {
          const r = await api.deletePanguSkill(name);
          if (!r || !r.ok) throw new Error((r && r.error) || 'delete failed');
          await loadPangu();
        } catch (e) {
          error = '删除失败: ' + ((e && e.message) || e);
        }
      },
    };
    paint();
  }

  // ── 渲染: tab 栏 ────────────────────────────────────────────────
  function paintTabs() {
    tabBar.innerHTML = '';
    // 第 147 批: 分段控件用全站统一的 .pg-seg / .pg-seg-i ——
    //   以前这一页自己画了一套 .pg-mp-tab (带下边框的 tab),
    //   设置页画的是 .seg, 梅花页又是 .pg-mh-seg-i —— 三套分段控件三种画法。
    const bar = el('div', { class: 'pg-toolbar' });
    const seg = el('div', { class: 'pg-seg' });
    // 右侧动作槽: 由当前 tab 自己填 (搜索 / 刷新 / 导入 / 保存 …)。
    // 这样「页签 + 搜索 + 动作」永远在**同一根工具条**里 —— 设计系统里
    // .pg-toolbar 的定义就是「左边切换, 右边搜索与动作」。
    const actions = el('div', { class: 'pg-mp-bar-actions' });
    const tabs = [
      // 第 143 批: 第一个 tab 原来也叫「工具集」—— 跟顶栏标题、左侧导航项
      //   一屏三遍同一个词。这里改叫「技能库」, 顶栏/导航保持「工具集」。
      { id: 'toolbox', icon: 'shopping-bag', label: '技能库', hint: '外部安装 + 自建技能' },
      { id: 'internal', icon: 'wrench', label: '内置工具', hint: '盘古自带的工具' },
      { id: 'mcp', icon: 'plug', label: '外部服务', hint: '接进来的外部工具服务' },
    ];
    for (const t of tabs) {
      const b = el('button', {
        class: 'pg-seg-i' + (tab === t.id ? ' on' : ''),
        type: 'button',
        title: t.hint,
      });
      b.appendChild(elHTML('span', { class: 'pg-seg-ico' }, iconHTML(t.icon, 15)));
      b.appendChild(el('span', {}, t.label));
      b.addEventListener('click', () => {
        tab = t.id;
        if (tab === 'internal' && !internalTools.length) loadInternal();
        paint();
      });
      seg.appendChild(b);
    }
    bar.appendChild(seg);
    bar.appendChild(el('div', { class: 'pg-toolbar-spacer' }));
    bar.appendChild(actions);
    tabBar.appendChild(bar);
    tabBar.__actions = actions;
  }

  // ── 渲染: 工具集页 ──────────────────────────────────────────────
  function combined() {
    let mp = items;
    let pg = panguSkills.map(mapPanguToCard);
    if (sourceFilter === 'installed') mp = mp.filter((item) => installed.indexOf(item.name) >= 0);
    if (sourceFilter === 'pg') mp = [];
    if (q.trim()) {
      const qq = q.toLowerCase();
      pg = pg.filter((c) => c.name.toLowerCase().includes(qq)
        || String(c.description || '').toLowerCase().includes(qq));
    }
    return mp.concat(pg);
  }

  function chip(label, on, onClick, withIcon) {
    // 第 147 批: 筛选片用全站统一的 .pg-chip / .pg-chip.on ——
    //   以前这一页是自造的 .pg-mp-chip (同样的圆角、另一套颜色与内距)。
    const b = el('button', {
      class: 'pg-chip' + (on ? ' on' : ''),
      type: 'button',
    });
    if (withIcon) {
      const ic = el('span', { class: 'pg-chip-ico' });
      ic.innerHTML = iconHTML(withIcon, 12);
      b.appendChild(ic);
    }
    b.appendChild(el('span', {}, label));
    b.addEventListener('click', onClick);
    return b;
  }

  function paintToolbox() {
    pane.innerHTML = '';

    // 第 147 批: 原来这里有个 .pangu-page-heading (一个大标题 + 一行灰字)。
    //   顶栏已经写着「工具集 · 可安装的技能与工具」, 内容区再画一次标题
    //   就是同一个标题出现两遍 —— 而且这个标题还是**这一页自己发明的**
    //   (别的页没有这一层)。⇒ 删掉, 只把「几个可安装」这句话降级成工具条里的一行小字。
    const installable = items.filter((i) => i.real).length + panguSkills.length;
    const previewOnly = items.filter((i) => !i.real).length;

    // 搜索 + 动作 → 塞进页签那根工具条的右侧 (同一个 .pg-toolbar)。
    const actions = tabBar.__actions;
    if (actions) actions.innerHTML = '';
    const search = el('input', {
      type: 'text',
      class: 'pg-input pg-mp-search',
      placeholder: '搜索 Skill 名称或描述',
    });
    search.value = q;
    search.addEventListener('input', () => {
      q = search.value;
      paintGrid();
    });
    if (actions) actions.appendChild(search);

    // 第 147 批: 「刷新」是纯图标按钮 (设计系统 .pg-icon-btn) ——
    //   一排文字按钮把工具条塞得满满当当, 看着像后台管理页。
    const bRefresh = el('button', { class: 'pg-icon-btn', type: 'button', title: '刷新' });
    bRefresh.appendChild(elHTML('span', {}, iconHTML('refresh', 15)));
    bRefresh.addEventListener('click', () => { loadMarketplace(); loadPangu(); });
    if (actions) actions.appendChild(bRefresh);

    const bImport = el('button', { class: 'pg-btn pg-btn-ghost pg-btn-sm', type: 'button', title: 'git clone 后拆解' });
    bImport.appendChild(elHTML('span', {}, iconHTML('download', 15)));
    bImport.appendChild(el('span', {}, '从本地导入'));
    bImport.addEventListener('click', () => { showImport = true; paint(); });
    if (actions) actions.appendChild(bImport);

    const bImportUrl = el('button', { class: 'pg-btn pg-btn-ghost pg-btn-sm', type: 'button', title: 'git clone + LLM 拆解' });
    bImportUrl.appendChild(elHTML('span', {}, iconHTML('search', 15)));
    bImportUrl.appendChild(el('span', {}, '从链接导入'));
    bImportUrl.addEventListener('click', () => { showImportUrl = true; paint(); });
    if (actions) actions.appendChild(bImportUrl);

    // 「新建技能」是这一屏唯一的实心主按钮 (设计系统铁律 ⑤: 一屏最多一个 primary)。
    const bCreate = el('button', { class: 'pg-btn pg-btn-primary pg-btn-sm', type: 'button' });
    bCreate.appendChild(elHTML('span', {}, iconHTML('package-plus', 15)));
    bCreate.appendChild(el('span', {}, '新建技能'));
    bCreate.addEventListener('click', () => { showCreate = true; paint(); });
    if (actions) actions.appendChild(bCreate);

    if (error) {
      const eb = el('div', { class: 'pg-mp-err' });
      eb.appendChild(elHTML('span', { class: 'pg-ico-line' },
        iconHTML('alert-triangle', 13) + '<span>' + error + '</span>'));
      const close = el('button', { class: 'pg-link-btn', type: 'button' }, '关闭');
      close.addEventListener('click', () => { error = null; paint(); });
      eb.appendChild(close);
      pane.appendChild(eb);
    }

    // 筛选条 = 设计系统的 .pg-toolbar + .pg-chip (页签那根是工具条, 这根也是工具条,
    //   两根长得一样, 页面才像一套东西)。
    const filters = el('div', { class: 'pg-toolbar pg-mp-bar' });
    filters.appendChild(el('span', { class: 'pg-hint' },
      installable + ' 个可安装 · ' + previewOnly + ' 个仅可查看'
      + (panguError ? ' · 自建加载失败: ' + panguError : '')));
    const typeGroup = el('div', { class: 'pg-mp-filter-group' });
    typeGroup.appendChild(el('span', { class: 'pg-mp-filter-label' }, '类型'));
    for (const s of [
      { id: 'all', label: '全部' },
      { id: 'installed', label: '已安装' },
      { id: 'pg', label: '自建' },
    ]) {
      typeGroup.appendChild(chip(s.label, sourceFilter === s.id, () => { sourceFilter = s.id; paint(); }));
    }
    filters.appendChild(typeGroup);

    // 第 170 批: 「分类」「来源」原来是**一排 chip** —— 分类六七个 + 来源四五个,
    //   跟「类型」三个挤在同一根工具条里, 一行放不下就折成两行, 一屏十几个
    //   圆角小药丸, 看着像后台的筛选墙。
    //   现在: 类型留三个 chip (它是主切换), 分类/来源收成**下拉** ——
    //   选项多的时候, 下拉才是主流 agent 的做法 (Linear / GitHub / Vercel)。
    if (sourceFilter !== 'pg') {
      filters.appendChild(el('div', { class: 'pg-toolbar-sep' }));
      // 第 170 批: 下拉**必须带标签** —— 光一个写着「全部」的下拉,
      //   用户不知道它在筛什么 (分类? 来源? 状态?)。标签跟「类型」同一套
      //   .pg-mp-filter-label, 一眼看懂谁是谁。
      const catGroup = el('div', { class: 'pg-mp-filter-group' });
      catGroup.appendChild(el('span', { class: 'pg-mp-filter-label' }, '分类'));
      const catSel = el('select', { class: 'pg-input pg-mp-filter-select' });
      for (const c of categories) {
        const o = el('option', { value: c }, c);
        if (c === cat) o.selected = true;
        catSel.appendChild(o);
      }
      catSel.addEventListener('change', () => { cat = catSel.value; loadMarketplace(); });
      catGroup.appendChild(catSel);
      filters.appendChild(catGroup);

      const srcGroup = el('div', { class: 'pg-mp-filter-group' });
      srcGroup.appendChild(el('span', { class: 'pg-mp-filter-label' }, '来源'));
      const srcSel = el('select', { class: 'pg-input pg-mp-filter-select' });
      for (const s of sources) {
        const o = el('option', { value: s }, s);
        if (s === src) o.selected = true;
        srcSel.appendChild(o);
      }
      srcSel.addEventListener('change', () => { src = srcSel.value; loadMarketplace(); });
      srcGroup.appendChild(srcSel);
      filters.appendChild(srcGroup);
    }
    pane.appendChild(filters);

    // 列表 = 设计系统的 .pg-list (行与行之间一根发丝线, 没有卡片框)
    const grid = el('div', { class: 'pg-list pg-mp-list' });
    pane.appendChild(grid);
    pane.__grid = grid;

    paintGrid();
  }

  function paintGrid() {
    const grid = pane.__grid;
    if (!grid) return;
    grid.innerHTML = '';
    if (loading || panguLoading) {
      grid.appendChild(elHTML('div', { class: 'pg-empty' },
        iconHTML('refresh', 14) + '<span>加载中…</span>'));
      return;
    }
    const list = combined();
    if (!list.length) {
      const e = el('div', { class: 'pg-empty' });
      e.appendChild(elHTML('div', { class: 'pg-mp-empty-mark' }, iconHTML('package', 28)));
      e.appendChild(el('p', {}, '当前筛选下没有 skill, 试试切换类型或清空搜索'));
      grid.appendChild(e);
      return;
    }
    list.forEach((item) => {
      if (item._kind === 'pg') grid.appendChild(panguCard(item));
      else grid.appendChild(marketCard(item));
    });
  }

  /**
   * 一行 = 设计系统的 .pg-list-row: 图标槽 · 主体 · 动作区。
   * 主体里分两列 (名字+来源 | 描述), 用页面专属的 .pg-mp-row-main 做**摆放**
   * (纯 grid, 不碰零件外观)。
   */
  function rowShell(iconNode, metaNode, descNode, actionNodes) {
    const row = el('div', { class: 'pg-list-row' });
    const ico = el('span', { class: 'pg-list-ico' });
    if (iconNode) ico.appendChild(iconNode);
    row.appendChild(ico);
    const main = el('div', { class: 'pg-list-main pg-mp-row-main' });
    main.appendChild(metaNode);
    main.appendChild(descNode);
    row.appendChild(main);
    const acts = el('div', { class: 'pg-list-actions' });
    for (const x of actionNodes || []) if (x) acts.appendChild(x);
    row.appendChild(acts);
    return row;
  }

  function panguCard(item) {
    const s = item._raw || {};
    // 第 147 批: 自建技能跟开源技能走**同一种行** (.pg-list-row) ——
    //   以前是两套结构 (自建裹一层 head, 开源是四个平级格子),
    //   同一个列表里两种排版 ⇒ 一眼像拼的。
    const ico = skillIcon(item, 18);
    const meta = el('div', { class: 'pg-mp-row-meta' });
    meta.appendChild(el('div', { class: 'pg-list-title' }, item.name));
    const tags = el('div', { class: 'pg-list-desc pg-mp-row-tags' });
    tags.appendChild(el('span', { class: 'pg-tag pg-src-pangu' }, '自建'));
    tags.appendChild(el('span', { class: 'pg-badge' }, s.transport || 'stdio'));
    if (s.converted_to_mcp) {
      tags.appendChild(el('span', { class: 'pg-badge pg-badge-green' }, '已转 MCP'));
    } else {
      tags.appendChild(el('span', { class: 'pg-tag' }, '未转化'));
    }
    meta.appendChild(tags);

    let argsTxt = '';
    try { argsTxt = JSON.parse(s.args || '[]').join(' '); } catch (_) { argsTxt = s.args || ''; }
    const descWrap = el('div', { class: 'pg-mp-row-desc' });
    descWrap.appendChild(el('p', { class: 'pg-hint' }, item.description || '(无描述)'));
    descWrap.appendChild(el('div', { class: 'pg-mono pg-mp-row-cmd' }, (s.command || '') + ' ' + argsTxt));

    const actions = [];
    if (s.converted_to_mcp) {
      // 「已转化」是**状态**, 不是按钮 —— 以前拿 .pg-btn 装了一个假按钮,
      // 页面里凭空多出十几个可点的方块 (点下去什么也不会发生)。
      actions.push(el('span', { class: 'pg-badge pg-badge-green', title: '已注册为 ' + (s.mcp_server || '') }, '已转化'));
    } else {
      actions.push(el('span', {
        class: 'pg-tag',
        title: 'MCP 转化尚未接入真实 server 生成与连接',
      }, 'MCP 转化未接入'));
    }
    // 删除 = 危险操作 ⇒ 设计系统第四档: 小尺寸描边红字 (不是满宽红条, 也不是实心红块)。
    const del = el('button', {
      class: 'pg-btn pg-btn-danger pg-btn-sm pg-mp-del',
      type: 'button',
      'aria-label': '删除 ' + item.name,
      title: '删除自建 Skill',
    });
    del.appendChild(elHTML('span', {}, iconHTML('x', 14)));
    del.addEventListener('click', () => removePangu(s.name));
    actions.push(del);

    return rowShell(ico, meta, descWrap, actions);
  }

  function marketCard(item) {
    const installedFlag = isInstalled(item);
    const busy = busyId === item.id;
    // 第 147 批: 一行 = 设计系统的 .pg-list-row (图标 | 主体 | 动作)。
    //   主体再分两列 (名字+slug+来源 | 描述) —— 每多一列, 眼睛就要多横跨一次。
    const ico = skillIcon(item, 18);
    const meta = el('div', { class: 'pg-mp-row-meta' });
    // 第 144 批: **主标题用中文名**, 英文 slug 降级成副标题。
    //   原来主标题直接印 item.name (academy-guide / brand-guidelines / first-principles),
    //   一屏十九张卡全是连字符小写英文 —— 看着像一墙 npm 包名, 不像一份
    //   给人挑的工具清单。现在: 中文名当标题 (宋体), slug 当等宽小字副标题,
    //   两者并存 —— 中文好认, slug 还能照抄去装。
    const cnName = String(item.name_cn || '').trim();
    meta.appendChild(el('div', { class: 'pg-list-title' }, cnName || item.name));
    const srcTag = el('span', {
      class: 'pg-tag ' + (SOURCE_COLORS[item.source] || SOURCE_COLORS.GitHub),
    });
    srcTag.appendChild(elHTML('span', { class: 'pg-mp-src-ico' }, iconHTML(SOURCE_ICONS[item.source] || 'package', 11)));
    srcTag.appendChild(el('span', {}, item.source));
    const pop = el('span', { class: 'pg-mp-pop' });
    // 第 143 批: 热度为 0 时**整块不画** —— 原来每张开源卡片右上角都挂一颗
    //   "☆ 0", 一个没有意义的数字, 十九张卡就是十九个 0。
    if (Number(item.popularity) > 0) {
      pop.appendChild(elHTML('span', {}, iconHTML('star', 10)));
      pop.appendChild(el('span', {}, fmtPopularity(item.popularity)));
    }
    // 第 144 批: 来源从**独立一列**挪到 slug 旁边当副信息。
    //   十九行里来源全是 "GitHub" —— 单独占一列, 十九个一样的 chip 排成
    //   一竖条, 既占地方又不带信息 (筛选条上已经有来源筛了)。
    //   塞到 slug 后面, 它就退回它该是的身份: 一个安静的旁注。
    const slugRow = el('div', { class: 'pg-list-desc pg-mp-row-tags' });
    if (cnName && item.name) {
      slugRow.appendChild(el('span', { class: 'pg-mono pg-mp-row-slug' }, item.name));
    }
    slugRow.appendChild(srcTag);
    meta.appendChild(slugRow);

    const desc = el('p', { class: 'pg-hint' }, item.description || '');
    // 第 144 批: 热度并进描述列 (原来它自己占一列, 十九行里十九个空的
    //   auto 格子) —— 热度是描述的附注, 该跟在描述后面, 不该单开一列。
    const descWrap = el('div', { class: 'pg-mp-row-desc' });
    descWrap.appendChild(desc);
    if (pop.childNodes.length) descWrap.appendChild(pop);

    const actions = [];
    // 第 144 批: 「查看」从**文字按钮**降级成**纯图标按钮**。
    //   一屏十九张卡 × 两个带文字的按钮 = 三十八个文字块, 视线全是按钮。
    //   真正的主操作是「安装」, 保留文字; 「查看」是次级动作, 收成眼睛图标
    //   (hover 出 tooltip), 画面立刻安静下来 —— 主次出来了。
    // 「查看」= 纯图标按钮 (设计系统 .pg-icon-btn)
    const bPrev = el('button', { class: 'pg-icon-btn', type: 'button' });
    bPrev.appendChild(elHTML('span', {}, iconHTML('eye', 14)));
    bPrev.title = '查看 ' + (item.name || '') + ' 的详情';
    bPrev.setAttribute('aria-label', '查看 ' + (item.name || '') + ' 的详情');
    bPrev.addEventListener('click', () => handlePreview(item));
    actions.push(bPrev);

    if (installedFlag) {
      // 卸载 = 危险操作 ⇒ 描边红字小按钮 (不是实心红块)
      const bUn = el('button', { class: 'pg-btn pg-btn-danger pg-btn-sm', type: 'button' });
      bUn.textContent = busy ? '处理中…' : '卸载';
      bUn.disabled = busy;
      bUn.addEventListener('click', () => handleUninstall(item));
      actions.push(bUn);
    } else if (!item.real) {
      // 2026-09-13 老板拍: mock 空壳禁止安装 —— 装上只有名字零指令, 模型读了白读
      actions.push(el('button', {
        class: 'pg-btn pg-btn-sm',
        type: 'button',
        disabled: true,
        title: '这条还没有接入真实来源，只能查看',
      }));
      actions[actions.length - 1].textContent = '暂不可装';
    } else {
      // 第 142 批: 主操作改「静默态沉底 + 悬停亮绿」——
      //   满屏实心按钮 (绿的或黑的) 都在抢眼, 页面立刻掉价。
      const bIn = el('button', { class: 'pg-btn pg-btn-sm', type: 'button' });
      if (busy) bIn.textContent = '安装中…';
      else {
        bIn.appendChild(elHTML('span', {}, iconHTML('plus', 14)));
        bIn.appendChild(el('span', {}, '安装'));
      }
      bIn.disabled = busy;
      bIn.addEventListener('click', () => handleInstall(item));
      actions.push(bIn);
    }

    return rowShell(ico, meta, descWrap, actions);
  }

  // ── 渲染: 内部工具 tab ──────────────────────────────────────────
  let internalTools = [];
  let internalOrig = [];
  let internalLoading = true;
  let internalMsg = null;
  let internalSaving = false;
  let internalQ = '';

  async function loadInternal() {
    internalLoading = true;
    internalMsg = null;
    paint();
    try {
      const r = await api.marketplaceInternal();
      if (!r || !r.ok) throw new Error((r && r.error) || 'load failed');
      internalTools = r.tools || [];
      internalOrig = r.tools || [];
    } catch (e) {
      internalMsg = '加载失败: ' + ((e && e.message) || e);
    } finally {
      internalLoading = false;
      paint();
    }
  }

  function internalDirty() {
    return JSON.stringify(internalTools.map((t) => t.name))
      !== JSON.stringify(internalOrig.map((t) => t.name));
  }

  function moveTool(name, dir) {
    const i = internalTools.findIndex((t) => t.name === name);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= internalTools.length) return;
    const next = internalTools.slice();
    const tmp = next[i];
    next[i] = next[j];
    next[j] = tmp;
    internalTools = next;
    internalMsg = null;
    paint();
  }

  async function saveInternal() {
    internalSaving = true;
    internalMsg = null;
    paint();
    try {
      const r = await api.marketplaceInternalLayout(internalTools.map((t) => t.name));
      if (r && r.ok) {
        internalMsg = '✓ ' + (r.note || '已保存');
        internalOrig = internalTools.slice();
      } else {
        internalMsg = '✗ ' + ((r && r.error) || '保存失败');
      }
    } catch (e) {
      internalMsg = '✗ ' + ((e && e.message) || e);
    } finally {
      internalSaving = false;
      paint();
    }
  }

  async function resetInternal() {
    if (!confirm('恢复默认顺序? (清空自定义布局)')) return;
    try {
      const r = await api.marketplaceInternalLayout([]);
      if (r && r.ok) {
        internalMsg = '✓ 已恢复默认顺序';
        await loadInternal();
      } else {
        internalMsg = '✗ ' + ((r && r.error) || '失败');
        paint();
      }
    } catch (e) {
      internalMsg = '✗ ' + ((e && e.message) || e);
      paint();
    }
  }

  function paintInternal() {
    pane.innerHTML = '';
    // 第 147 批: 跟技能库页**同一套**工具条 (左: 页签, 右: 搜索 + 动作),
    //   内容区不再有第二套横条, 也不再有自造的大标题块。
    const actions = tabBar.__actions;
    if (actions) actions.innerHTML = '';
    const note = el('span', { class: 'pg-hint' },
      '顺序 = 喂给 LLM 的工具顺序, 越靠前越优先 · 共 ' + internalTools.length + ' 个');
    if (actions) actions.appendChild(note);
    const search = el('input', {
      type: 'text', class: 'pg-input pg-mp-search pg-mp-search-sm', placeholder: '搜工具名/描述',
    });
    search.addEventListener('input', () => { internalQ = search.value; paintInternalList(); });
    if (actions) actions.appendChild(search);
    const bRef = el('button', { class: 'pg-icon-btn', type: 'button', title: '刷新' }, '↻');
    bRef.innerHTML = iconHTML('refresh', 15);
    bRef.addEventListener('click', () => loadInternal());
    if (actions) actions.appendChild(bRef);
    const bReset = el('button', { class: 'pg-btn pg-btn-ghost pg-btn-sm', type: 'button' }, '恢复默认');
    bReset.addEventListener('click', () => resetInternal());
    if (actions) actions.appendChild(bReset);
    const bSave = el('button', { class: 'pg-btn pg-btn-primary pg-btn-sm', type: 'button' });
    bSave.textContent = internalSaving ? '保存中…' : (internalDirty() ? '保存顺序 ●' : '保存顺序');
    bSave.disabled = !internalDirty() || internalSaving;
    bSave.addEventListener('click', () => saveInternal());
    if (actions) actions.appendChild(bSave);

    if (internalMsg) pane.appendChild(el('div', { class: 'pg-mp-msg' }, internalMsg));

    const list = el('div', { class: 'pg-list pg-mp-list' });
    pane.appendChild(list);
    pane.__internal = list;
    paintInternalList();
  }

  function paintInternalList() {
    const list = pane.__internal;
    if (!list) return;
    list.innerHTML = '';
    if (internalLoading) {
      list.appendChild(el('div', { class: 'pg-empty' }, '加载中…'));
      return;
    }
    const s = String(internalQ || '').trim();
    const shown = s
      ? internalTools.filter((t) => t.name.indexOf(s) >= 0 || String(t.description || '').indexOf(s) >= 0)
      : internalTools;
    shown.forEach((t) => {
      const globalIdx = internalTools.findIndex((x) => x.name === t.name);
      // 第 147 批: 内部工具也是一行 = .pg-list-row (图标槽 · 主体 · 动作)
      const row = el('div', { class: 'pg-list-row' });
      const dot = el('span', { class: 'pg-mp-internal-dot' + (t.enabled ? ' is-on' : '') });
      dot.title = t.enabled ? '启用' : '停用';
      const ico = el('span', { class: 'pg-list-ico' });
      ico.appendChild(dot);
      row.appendChild(ico);
      const meta = el('div', { class: 'pg-mp-row-meta' });
      const titleLine = el('div', { class: 'pg-list-title' });
      titleLine.appendChild(el('span', { class: 'pg-mono pg-mp-internal-idx' }, String(globalIdx + 1)));
      titleLine.appendChild(el('span', {}, t.name));
      meta.appendChild(titleLine);
      meta.appendChild(el('div', { class: 'pg-list-desc pg-mp-tool-desc' }, t.description || ''));
      const body = el('div', { class: 'pg-list-main' });
      body.appendChild(meta);
      row.appendChild(body);
      if (!s) {
        const ops = el('div', { class: 'pg-list-actions' });
        const up = el('button', { class: 'pg-btn pg-btn-ghost pg-btn-sm', type: 'button', title: '上移' }, '↑');
        up.disabled = globalIdx === 0;
        up.addEventListener('click', () => moveTool(t.name, -1));
        const down = el('button', { class: 'pg-btn pg-btn-ghost pg-btn-sm', type: 'button', title: '下移' }, '↓');
        down.disabled = globalIdx === internalTools.length - 1;
        down.addEventListener('click', () => moveTool(t.name, 1));
        ops.appendChild(up);
        ops.appendChild(down);
        row.appendChild(ops);
      }
      list.appendChild(row);
    });
    if (s) {
      list.appendChild(el('div', { class: 'pg-mp-hint' }, '搜索模式下不重排, 清空搜索框后调顺序'));
    }
  }

  // ── 渲染: MCP tab ───────────────────────────────────────────────
  function paintMcp() {
    pane.innerHTML = '';
    const wrap = el('div', { class: 'pg-mp-mcp' });
    pane.appendChild(wrap);
    import('./settings/mcp.mjs').then((mod) => {
      wrap.innerHTML = '';
      return mod.render(wrap);
    }).catch((e) => {
      wrap.innerHTML = '';
      wrap.appendChild(el('div', { class: 'errbox' }, 'MCP 面板载入失败: ' + esc((e && e.message) || e)));
    });
  }

  // ── 弹窗 ─────────────────────────────────────────────────────────
  function modalShell(title, bodyChildren, footChildren, opts) {
    const o = opts || {};
    const back = el('div', { class: 'pg-modal-back' });
    const box = el('div', { class: 'pg-modal-box' + (o.wide ? ' pg-modal-wide' : '') });
    if (title) {
      const head = el('div', { class: 'pg-modal-head' });
      head.appendChild(elHTML('span', { class: 'pg-ico-line' }, title));
      const x = elHTML('button', { class: 'pg-btn pg-btn-ghost', type: 'button', title: '关闭' },
        iconHTML('x', 15));
      x.addEventListener('click', o.onClose);
      head.appendChild(x);
      box.appendChild(head);
    }
    const body = el('div', { class: 'pg-modal-body' });
    for (const c of [].concat(bodyChildren || [])) if (c) body.appendChild(c);
    box.appendChild(body);
    // 第 147 批 · 真 bug: 调用方传进来的是**一个元素** (foot), 不是数组。
    //   `footChildren.length` 对 DOM 元素是 undefined ⇒ 整个页脚从来没被渲染过 ——
    //   「新建技能」「拆解」「安装到盘古」这些按钮**根本不存在**,
    //   弹窗打开只能看着, 连关闭都只能点右上角那个 ×。
    //   ⇒ 统一用 [].concat() 收口: 传元素传数组都认。
    const footList = footChildren ? [].concat(footChildren) : [];
    if (footList.length) {
      const foot = el('div', { class: 'pg-modal-foot' });
      for (const c of footList) if (c) foot.appendChild(c);
      box.appendChild(foot);
    }
    back.appendChild(box);
    back.addEventListener('click', (e) => {
      if (e.target === back && !o.busy) o.onClose();
    });
    return back;
  }

  function paintModals() {
    modalHost.innerHTML = '';

    if (previewing) {
      const head = el('div', { class: 'pg-mp-prev-head' });
      // 第 147 批: 这里原来把后端给的图标**名字当文字印出来** (屏幕上出现
      //   一个孤零零的「book」) —— 列表里用的是矢量图标, 弹窗里却是文字,
      //   同一页两种画法。⇒ 走同一个 skillIcon(): 认得就画矢量, 不认退回来源图标。
      const prevIco = skillIcon(previewing, 22);
      prevIco.classList.add('pg-mp-prev-emoji');
      head.appendChild(prevIco);
      const meta = el('div', { class: 'pg-mp-prev-meta' });
      meta.appendChild(el('h3', {}, previewing.name || ''));
      const line = el('p', { class: 'pg-mp-prev-line' });
      line.appendChild(el('span', {}, previewing.source || ''));
      line.appendChild(el('span', {}, '·'));
      line.appendChild(elHTML('span', { class: 'pg-ico-line' },
        iconHTML('star', 11) + '<span>' + fmtPopularity(previewing.popularity) + '</span>'));
      line.appendChild(el('span', {}, '·'));
      line.appendChild(el('span', {}, previewing.category || ''));
      if (previewing.real) {
        line.appendChild(elHTML('span', { class: 'pg-mp-real pg-ico-line' },
          iconHTML('check-circle', 11) + '<span>真实可拉</span>'));
      }
      meta.appendChild(line);
      head.appendChild(meta);

      const body = el('div');
      body.appendChild(el('div', { class: 'pg-mp-prev-desc' }, previewing.description || ''));
      body.appendChild(elHTML('div', { class: 'pg-label pg-mp-prev-label pg-ico-line' },
        iconHTML('file', 12) + '<span>SKILL.md 预览:</span>'));
      body.appendChild(el('pre', { class: 'pg-pre' },
        previewing._loading ? '加载中…' : (previewing.preview || '(无预览)')));

      const foot = el('div', { class: 'pg-mp-prev-foot' });
      if (!previewing.real) {
        // 「暂不可装」是**状态**不是按钮 —— 用小标签 (.pg-tag), 不再装一个假按钮
        foot.appendChild(el('span', {
          class: 'pg-tag',
          title: '这条还没有接入真实来源，只能查看',
        }, '暂不可装'));
      } else if (!isInstalled(previewing)) {
        const b = elHTML('button', { class: 'pg-btn pg-btn-primary pg-btn-sm', type: 'button' },
          iconHTML('download', 14) + '<span>安装到盘古</span>');
        b.addEventListener('click', () => { handleInstall(previewing); previewing = null; paint(); });
        foot.appendChild(b);
      } else {
        const b = el('button', { class: 'pg-btn pg-btn-danger pg-btn-sm', type: 'button' }, '卸载');
        b.addEventListener('click', () => { handleUninstall(previewing); previewing = null; paint(); });
        foot.appendChild(b);
      }
      const close = el('button', { class: 'pg-btn pg-btn-ghost pg-btn-sm', type: 'button' }, '关闭');
      close.addEventListener('click', () => { previewing = null; paint(); });
      foot.appendChild(close);

      modalHost.appendChild(modalShell('', [head, body], foot, {
        wide: true,
        onClose: () => { previewing = null; paint(); },
      }));
    }

    if (showCreate) {
      const body = el('div', { class: 'pg-form' });
      const mk = (label, key, placeholder) => {
        const w = el('div', { class: 'pg-form-row' });
        w.appendChild(el('label', { class: 'pg-label' }, label));
        const i = el('input', { type: 'text', class: 'pg-input', placeholder: placeholder || '' });
        i.value = form[key] || '';
        i.addEventListener('input', () => { form = Object.assign({}, form, { [key]: i.value }); });
        w.appendChild(i);
        body.appendChild(w);
        return i;
      };
      mk('名称 *', 'name', 'my-skill');
      mk('描述', 'description', '一句话说明 skill 干啥');
      const transportRow = el('div', { class: 'pg-form-row' });
      transportRow.appendChild(el('label', { class: 'pg-label' }, 'transport'));
      const sel = el('select', { class: 'pg-input' });
      for (const t of ['stdio', 'sse', 'http']) {
        const o = el('option', { value: t }, t);
        if (form.transport === t) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { form = Object.assign({}, form, { transport: sel.value }); });
      transportRow.appendChild(sel);
      body.appendChild(transportRow);
      mk('启动命令 *', 'command', 'node / python3 / npx');
      mk('参数 (空格分隔)', 'args', '-m my_module arg1 arg2');

      const foot = el('div', { class: 'pg-modal-foot' });
      const cancel = el('button', { class: 'pg-btn', type: 'button' }, '取消');
      cancel.addEventListener('click', () => { showCreate = false; paint(); });
      const ok = elHTML('button', { class: 'pg-btn pg-btn-primary pg-btn-ico', type: 'button' },
        busyCreate ? '创建中…' : (iconHTML('check', 14) + '<span>创建</span>'));
      ok.disabled = busyCreate || !form.name || !form.command;
      ok.addEventListener('click', () => submitCreate());
      foot.appendChild(cancel);
      foot.appendChild(ok);

      modalHost.appendChild(modalShell(iconHTML('package-plus', 15) + '<span>新建 Pangu Skill</span>', [body], foot, {
        wide: true,
        busy: busyCreate,
        onClose: () => { if (!busyCreate) { showCreate = false; paint(); } },
      }));
    }

    if (showImport) {
      const body = el('div');
      const inp = el('input', { type: 'text', class: 'pg-input', placeholder: '/path/to/skill/dir' });
      inp.value = importPath;
      inp.addEventListener('input', () => { importPath = inp.value; });
      body.appendChild(inp);
      const btns = el('div', { class: 'pg-btn-row pg-mp-modal-btns' });
      const go = elHTML('button', { class: 'pg-btn pg-btn-primary pg-btn-ico', type: 'button' },
        busyImport ? '拆解中…' : (iconHTML('search', 14) + '<span>拆解</span>'));
      go.disabled = busyImport || !importPath;
      go.addEventListener('click', () => doImport());
      const cancel = el('button', { class: 'pg-btn', type: 'button' }, '取消');
      cancel.addEventListener('click', () => { showImport = false; paint(); });
      btns.appendChild(go);
      btns.appendChild(cancel);
      body.appendChild(btns);
      if (importResult) {
        const r = el('div', { class: 'pg-note-box' });
        r.appendChild(el('div', {}, 'name: ' + (importResult.name || '')));
        r.appendChild(el('div', {}, 'description: ' + (importResult.description || '')));
        r.appendChild(el('div', {}, 'command: ' + (importResult.command || '')));
        r.appendChild(el('div', {}, 'args: ' + JSON.stringify(importResult.args || [])));
        const use = elHTML('button', { class: 'pg-btn pg-btn-primary pg-mp-mt pg-btn-ico', type: 'button' },
          iconHTML('pen-tool', 14) + '<span>用此结果填入新建表单</span>');
        use.addEventListener('click', () => applyImportAndEdit());
        r.appendChild(use);
        body.appendChild(r);
      }
      modalHost.appendChild(modalShell(iconHTML('folder', 15) + '<span>从本地路径导入 Skill</span>', [body], null, {
        wide: true,
        busy: busyImport,
        onClose: () => { if (!busyImport) { showImport = false; paint(); } },
      }));
    }

    if (showImportUrl) {
      const body = el('div');
      const inp = el('input', {
        type: 'text',
        class: 'pg-input',
        placeholder: 'GitHub URL (例: https://github.com/owner/some-skill)',
      });
      inp.value = importUrl;
      inp.addEventListener('input', () => { importUrl = inp.value; });
      body.appendChild(inp);
      const btns = el('div', { class: 'pg-btn-row pg-mp-modal-btns' });
      const go = elHTML('button', { class: 'pg-btn pg-btn-primary pg-btn-ico', type: 'button' },
        busyImportUrl ? 'clone + 拆解中…' : (iconHTML('globe', 14) + '<span>clone + 拆解</span>'));
      go.disabled = busyImportUrl || !importUrl;
      go.addEventListener('click', () => doImportUrl());
      const cancel = el('button', { class: 'pg-btn', type: 'button' }, '取消');
      cancel.addEventListener('click', () => { showImportUrl = false; paint(); });
      btns.appendChild(go);
      btns.appendChild(cancel);
      body.appendChild(btns);
      if (importUrlResult) {
        const r = el('div', { class: 'pg-note-box' });
        r.appendChild(el('div', {}, 'Clone 路径: ' + (importUrlResult.clonePath || '')));
        r.appendChild(el('div', {}, '候选 scripts: ' + ((importUrlResult.scripts || []).join(', ') || '(无)')));
        r.appendChild(el('div', {}, 'LLM 推断:'));
        r.appendChild(el('div', {}, 'name: ' + (importUrlResult.name || '')));
        r.appendChild(el('div', {}, 'description: ' + (importUrlResult.description || '')));
        r.appendChild(el('div', {}, 'command: ' + (importUrlResult.command || '')));
        r.appendChild(el('div', {}, 'args: ' + JSON.stringify(importUrlResult.args || [])));
        const use = elHTML('button', { class: 'pg-btn pg-btn-primary pg-mp-mt pg-btn-ico', type: 'button' },
          iconHTML('pen-tool', 14) + '<span>用此结果填入新建表单</span>');
        use.addEventListener('click', () => applyUrlImportAndEdit());
        r.appendChild(use);
        body.appendChild(r);
      }
      modalHost.appendChild(modalShell(iconHTML('globe', 15)
        + '<span>从 URL 导入 Skill (git clone + 读 README + LLM 拆解)</span>', [body], null, {
        wide: true,
        busy: busyImportUrl,
        onClose: () => { if (!busyImportUrl) { showImportUrl = false; paint(); } },
      }));
    }

    // 通用确认框 (替掉原生 confirm)
    if (confirmBox) {
      const body = el('div', { class: 'pg-note-box' });
      body.appendChild(el('div', {}, confirmBox.body || ''));
      if (confirmBox.body2) body.appendChild(el('div', {}, confirmBox.body2));
      const foot = el('div', { class: 'pg-modal-foot' });
      const cancel = el('button', { class: 'pg-btn', type: 'button' }, '取消');
      cancel.addEventListener('click', () => { confirmBox = null; paint(); });
      const ok = el('button', {
        class: 'pg-btn ' + (confirmBox.danger ? 'pg-btn-danger' : 'pg-btn-primary'),
        type: 'button',
      }, '✓ 确认');
      ok.addEventListener('click', async () => {
        const fn = confirmBox.onOk;
        confirmBox = null;
        paint();
        if (fn) await fn();
      });
      foot.appendChild(cancel);
      foot.appendChild(ok);
      modalHost.appendChild(modalShell(confirmBox.title, [body], foot, {
        onClose: () => { confirmBox = null; paint(); },
      }));
    }
  }

  // ── 总渲染 ───────────────────────────────────────────────────────
  function paint() {
    paintTabs();
    if (tab === 'toolbox') paintToolbox();
    else if (tab === 'internal') paintInternal();
    else paintMcp();
    paintModals();
  }

  await Promise.all([loadMarketplace(), loadPangu()]);

  return { destroy() { /* 切视图时清 DOM 由框架负责 */ } };
}

export default render;
