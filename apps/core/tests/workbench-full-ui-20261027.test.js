'use strict';

// 2026-10-27 (第 117 批): 「整套 UI」守卫
//
// ─────────────────────────────────────────────────────────────────────────
// 老板原话: 「我说的整套ui，你弄的是啥」
//
// 第 116 批只搬了原版的**壳** (侧栏 / 顶栏 / 主题 / 令符), 视图是 9 个粗版。
// 老板要的是**整套** —— 原版 7 个主视图 + 15 个设置页 + 关键组件,
// 一个不少地搬进浏览器工作台 (手写 ES module + 原生 CSS, 不复活桌面端)。
//
// 原版真源: git 110661d^ (删桌面端那一批的父提交)
//   git ls-tree -r --name-only 110661d^ -- apps/desktop/src
//
// 本文件锁六件事:
//   1. 原版主视图 7 个 → 工作台里都有对应实现
//   2. 主视图不许是「粗版」: 原版关键结构必须在位
//   3. 原版设置页 → 工作台 settings/ 下都有对应子页
//   4. 原版关键组件 → 都有对应实现
//   5. 端点必须是 core 真路由
//   6. 零依赖零构建 + 危险动作先确认 (不许退化)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const APP = path.join(CORE, 'web', 'app');
// 2026-11-26: 开源导出树剥掉 7 轨 (梅花等) 视图 ⇒ 「7 主视图齐全」是私有不变量。
//   开源模式下从视图断言里剔除 7 轨视图, 公版视图照验。
const IS_OPEN_SOURCE = fs.existsSync(path.join(CORE, '64i', '.pangu-open-source'));
const TRACK_VIEWS = new Set(['meihua', 'qimen', 'bazhai', 'liuren', 'hehun', 'ziwei', 'mianxiang']);

function read(rel) {
  return fs.readFileSync(path.join(APP, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(APP, rel));
}

function allFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  })(dir);
  return out;
}

const ALL = allFiles(APP);

// ── 117-1 原版主视图 7 个 → 工作台实现齐全 ───────────────────────
test('117-1: 原版 7 个主视图都在工作台里有对应实现', () => {
  const _MAP = {
    'ChatRoom.jsx': 'views/chat.mjs',
    'Marketplace.jsx': 'views/marketplace.mjs',
    'HistoryView.jsx': 'views/history.mjs',
    ...((IS_OPEN_SOURCE) ? {} : { 'MeihuaView.jsx': 'views/meihua.mjs' }),
    'TeamFlow.jsx': 'views/team.mjs',
    'HexagramsView.jsx': 'views/hexagrams.mjs',
  };
  const MAP = Object.fromEntries(Object.entries(_MAP).filter(([, tgt]) =>
    !!(IS_OPEN_SOURCE && TRACK_VIEWS.has(tgt.replace('views/','').replace('.mjs',''))) ? false : true));
  for (const [orig, target] of Object.entries(MAP)) {
    assert.ok(exists(target), '原版 ' + orig + ' → 工作台缺 ' + target);
    const src = read(target);
    assert.match(src, /export\s+(async\s+)?function\s+render/, target + ' 必须导出 render');
    assert.match(src, /export\s+default\s+render/, target + ' 必须 default 导出 render');
  }

  // (八字排盘功能页已拆离)
});

// ── 117-2 主视图不许是「粗版」: 原版关键结构必须在位 ─────────────
test('117-2: 主视图带原版的关键结构 (不是粗版)', () => {
  // Marketplace: 三个 tab + 搜索 + 三种筛选 + 卡片网格 + 四种弹窗
  const mp = read('views/marketplace.mjs');
  for (const needle of [
    "id: 'toolbox'", "id: 'internal'", "id: 'mcp'",
    '搜索 Skill 名称或描述',
    "'installed'", "'pg'",
    'categories', 'sources',
    // 第 147 批: 清单容器并进设计系统的 .pg-list (原先是自造的 .pg-mp-grid)。
    'pg-mp-list', 'pg-list-row',
    'marketplaceDetail',
    'createPanguSkillForm',
    'importSkillFromPath',
    'importSkillFromUrl',
    'confirmBox',
    'marketplaceInternal', 'marketplaceInternalLayout',
  ]) {
    assert.ok(mp.includes(needle), 'Marketplace 缺原版结构: ' + needle);
  }

  // History: 三栏壳 + 记忆 + session 流水 + 章节树
  const hi = read('views/history.mjs');
  for (const needle of [
    // 第 170 批: 左栏从自造的 `.pangu-subnav` 改成全站统一的 `.pg-catnav`
    //   分类竖列 (跟设置页同一套画法) —— 判据跟着新语法改。
    'pangu-subshell', 'catnav',
    '累积合成记忆',
    '当天流水',
    'parseMemorySections', 'parseSessionTranscript',
    'api/local-memory/list', 'api/local-memory/file',
    'sessionDelete',
  ]) {
    assert.ok(hi.includes(needle), 'History 缺原版结构: ' + needle);
  }

  // Meihua: 报数/时间双法 + 三卦并排 + 动爻爻词 + 体用吉凶 + 五行六亲
  //   开源导出树剥了 meihua 视图 (7轨), 开源模式下这段 skip; 私有树照验。
  if (!IS_OPEN_SOURCE) {
    const mh = read('views/meihua.mjs');
    for (const needle of [
      '数字起卦', '时间起卦',
      '本卦', '互卦 (过程)', '变卦 (结果)',
      'moving_yao_ci',
      'ti_yong', 'relation', 'level', 'verdict',
      'wuxing', 'liu_qin', 'position_nature',
      'api/meihua/cast',
    ]) {
      assert.ok(mh.includes(needle), 'Meihua 缺原版结构: ' + needle);
    }
  }

  // Hexagrams: 搜索 + 五行筛选 + 网格 + 详情 (爻题从数据里读)
  const hx = read('views/hexagrams.mjs');
  for (const needle of [
    'pg-hex-search', 'pg-hex-filter', 'pg-hex-grid', 'pg-hex-yao',
    'yaoEntry',
    'api/hexagrams',
  ]) {
    assert.ok(hx.includes(needle), 'Hexagrams 缺原版结构: ' + needle);
  }
  assert.ok(exists('lib/yao.mjs'), '爻题规则必须有独立模块 lib/yao.mjs');
  const yao = read('lib/yao.mjs');
  assert.ok(yao.includes('parseYao') && yao.includes('yaoEntry'),
    'lib/yao.mjs 必须有 parseYao + yaoEntry');
  assert.ok(yao.includes('YAO_TITLE_RE = /^(初[九六]|[九六][二三四五]|上[九六])/'),
    '爻题正则必须按原版 (二~五爻阴阳在前)');

  // Team: 定时任务增删
  const tf = read('views/team.mjs');
  for (const needle of ['api/teamflow/tasks', 'schedule_type', 'confirm(']) {
    assert.ok(tf.includes(needle), 'TeamFlow 缺原版结构: ' + needle);
  }

  // Chat: 活动行 / 计划卡 / todo / diff / 进度条 / 将灵面板 / 权限弹窗 / 卦象卡
  const ch = read('views/chat.mjs');
  for (const needle of [
    'renderActivityLine', 'renderPlanCard', 'renderTodoViewer',
    'renderDiffViewer', 'renderProgressBar', 'renderSubAgentPanel',
    'createPermissionPopover', 'renderHexagramCard',
    'pangu:resume-session',
  ]) {
    assert.ok(ch.includes(needle), 'ChatRoom 缺原版组件: ' + needle);
  }
});

// ── 117-3 原版设置页 → 工作台子页齐全 ───────────────────────────
test('117-3: 原版设置页在工作台 settings/ 下都有对应子页', () => {
  const PAGES = {
    connect: 'connect.mjs',
    model: 'model.mjs',
    agent: 'agent.mjs',
    tools: 'tools.mjs',
    mcp: 'mcp.mjs',
    permission: 'permission.mjs',
    ui: 'ui.mjs',
    storage: 'storage.mjs',
    credentials: 'credentials.mjs',
    selfrepair: 'self-repair.mjs',
    voice: 'voice.mjs',
    update: 'update.mjs',
  };
  for (const [id, file] of Object.entries(PAGES)) {
    assert.ok(exists('views/settings/' + file), '设置页 ' + id + ' 缺 views/settings/' + file);
    const src = read('views/settings/' + file);
    assert.match(src, /export\s+(async\s+)?function\s+render/, file + ' 必须导出 render');
  }

  // 设置壳: 子导航项从 PAN_LORE.settings 取 (唯一真源)
  const shell = read('views/settings.mjs');
  assert.ok(shell.includes('PAN_LORE.settings'), '设置壳必须从 PAN_LORE.settings 取子导航项');
  // 第 170 批: 设置页 12 个分类从**顶部横排**改成**左侧竖列**
  //   (.pg-catnav, 全站统一零件) —— 不再自造 .pangu-subnav。
  assert.ok(shell.includes('catnav'), '设置壳必须有分类竖列 (catnav)');
  assert.ok(!shell.includes('pg-subtabs'), '设置壳不许再用顶部横排 tab');

  // 原版 15 个设置文件 → 工作台要有等价实现
  const ORIG = [
    'AgentDetail', 'AgentList', 'Connect', 'Credentials', 'InternalToolsPanel',
    'MCP', 'Model', 'Permission', 'SelfRepair', 'Skills', 'Storage', 'Tools',
    'UI', 'Update', 'Voice',
  ];
  const allSettingsSrc = Object.values(PAGES)
    .map((f) => read('views/settings/' + f)).join('\n')
    + read('views/marketplace.mjs');
  const KEY = {
    AgentDetail: 'role_configs',
    AgentList: 'role_configs',
    Connect: 'setEndpoint',
    Credentials: 'credentialsList',
    InternalToolsPanel: 'marketplaceInternalLayout',
    MCP: 'mcpServers',
    Model: 'modelsList',
    Permission: 'permissionSet',
    SelfRepair: 'selfRepairGet',
    Storage: 'housekeepingStats',
    Tools: 'panguTools',
    UI: 'pangu.ui.theme',
    Update: 'api.version',
    Voice: 'voiceDevices',
  };
  for (const name of ORIG) {
    if (name === 'Skills') {
      // 原版 Skills.jsx 是重定向 (老板 2026-09-13 拍: 并入 tools 的角色视角 tab)
      assert.ok(allSettingsSrc.includes('role') || allSettingsSrc.includes('role-matrix'),
        '原版 Skills.jsx 重定向到 tools 的角色视角 tab —— 工作台必须有角色视角');
      continue;
    }
    assert.ok(allSettingsSrc.includes(KEY[name]),
      '原版 ' + name + ' 的等价实现缺失 (找 ' + KEY[name] + ')');
  }

  // 原版三个辅助模块 (_model_pool_compact / _presets / _role_matrix)
  assert.ok(allSettingsSrc.includes('presetsList'), '原版 _presets.jsx 的模型预设必须有');
  assert.ok(allSettingsSrc.includes('role_matrix') || allSettingsSrc.includes('role-matrix'),
    '原版 _role_matrix.jsx 的角色矩阵必须有');
});

// ── 117-4 原版关键组件都有对应实现 ─────────────────────────────
test('117-4: 原版关键组件都有对应实现', () => {
  const MAP = {
    'components/SessionSidebar.jsx': 'components/session-sidebar.mjs',
    'components/ToolCall.tsx': 'components/tool-call.mjs',
    'components/ActivityLine.tsx': 'components/activity-line.mjs',
    'components/DiffViewer.tsx': 'components/diff-viewer.mjs',
    'components/PlanViewer.tsx': 'components/plan-card.mjs',
    'components/PermissionPopover.jsx': 'components/permission-popover.mjs',
    'components/ProgressBar.tsx': 'components/progress-bar.mjs',
    'components/SubAgentPanel.tsx': 'components/subagent-panel.mjs',
    'components/TodoViewer.tsx': 'components/todo-viewer.mjs',
    'components/HexagramCard.jsx': 'components/hexagram-card.mjs',
  };
  for (const [orig, target] of Object.entries(MAP)) {
    assert.ok(exists(target), '原版 ' + orig + ' → 工作台缺 ' + target);
    const src = read(target);
    assert.match(src, /export\s/, target + ' 必须有导出');
  }

  // markdown 渲染 (原版 Markdown.jsx)
  assert.ok(exists('lib/md.mjs'), '原版 Markdown.jsx → lib/md.mjs 必须存在');
  assert.ok(read('lib/md.mjs').includes('renderMarkdown'), 'lib/md.mjs 必须导出 renderMarkdown');

  // 侧栏会话列表要真的挂进主侧栏 (原版 App.jsx 的 SessionSidebar)
  const html = read('index.html');
  assert.ok(html.includes('nav-sessions'), 'index.html 必须有侧栏会话列表挂点');
  const appSrc = read('app.mjs');
  assert.ok(appSrc.includes('renderSessionSidebar'), 'app.mjs 必须挂 SessionSidebar');
  assert.ok(appSrc.includes('pangu:resume-session'), 'app.mjs 必须派发 pangu:resume-session');
});

// ── 117-5 端点必须是 core 真路由 ───────────────────────────────
test('117-5: 工作台调用的端点必须存在于 core 路由表', () => {
  const coreSrc = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'web' || e.name === 'tests') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.js$/.test(e.name)) coreSrc.push(fs.readFileSync(p, 'utf8'));
    }
  })(CORE);
  const coreText = coreSrc.join('\n');

  const used = new Set();
  for (const f of ALL) {
    if (!/\.(mjs|js)$/.test(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/['"`](?:\/)?(api\/[a-zA-Z0-9_\-/:.]+)['"`]/g)) {
      used.add('/' + m[1]);
    }
  }

  // 动态路径前缀 (后端用 startsWith / 正则匹配, 静态 grep 找不到)
  const DYNAMIC_OK = [
    '/api/meihua/cast', '/api/sessions', '/api/version', '/api/nodes',
    '/api/hexagrams', '/api/local-memory/', '/api/marketplace/', '/api/mcp/',
    '/api/credentials/', '/api/license/', '/api/voice/', '/api/teamflow/',
    '/api/tools/schema/', '/api/llm/', '/api/pangu/',
  ];

  const unknown = [];
  for (const u of used) {
    const bare = u.split('?')[0];
    if (DYNAMIC_OK.some((ok) => bare === ok || bare.startsWith(ok))) continue;
    if (coreText.includes(bare)) continue;
    unknown.push(u);
  }
  assert.deepStrictEqual(unknown, [],
    '工作台调了 core 里不存在的端点: ' + unknown.join(', '));
});

// ── 117-6 零依赖零构建 (不许退化) ──────────────────────────────
test('117-6: 工作台仍然零依赖零构建 (不复活桌面端)', () => {
  for (const f of ALL) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(APP, f);
    assert.ok(!/from\s+['"]react/i.test(src), rel + ' 不许 import react');
    assert.ok(!/require\(\s*['"]react/i.test(src), rel + ' 不许 require react');
    assert.ok(!/node_modules/.test(src), rel + ' 不许出现 node_modules');
    assert.ok(!/<script[^>]+src=["']https?:/i.test(src), rel + ' 不许外链 script');
    assert.ok(!/<link[^>]+href=["']https?:/i.test(src), rel + ' 不许外链 css');
    assert.ok(!/\/Users\/feng\//.test(src), rel + ' 不许出现本机绝对路径');
    for (const m of src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      assert.ok(
        spec.startsWith('./') || spec.startsWith('../'),
        rel + ' 出现裸 import: ' + spec
      );
    }
  }
  assert.ok(!fs.existsSync(path.join(APP, 'dist')), '工作台不许带 dist');
  assert.ok(!fs.existsSync(path.join(APP, 'node_modules')), '工作台不许带 node_modules');
});

// ── 117-7 危险动作先确认 ───────────────────────────────────────
test('117-7: 危险动作必须先确认 (应用内确认框或原生 confirm)', () => {
  // needle 必须是「写调用点」本身 —— 用裸路径会命中文档注释里的路径, 误判
  const CASES = [
    ['views/marketplace.mjs', /api\.marketplaceUninstall\(/],
    ['views/marketplace.mjs', /api\.deletePanguSkill\(/],
    ['views/settings/credentials.mjs', /api\.credentialsRemove\(/],
    ['views/settings/permission.mjs', /api\.permissionSet\(/],
    ['views/team.mjs', /send\(\s*'api\/teamflow\/tasks\//],
    ['views/history.mjs', /api\.sessionDelete\(/],
  ];
  for (const [file, re] of CASES) {
    const src = read(file);
    const m = re.exec(src);
    assert.ok(m, file + ' 必须调 ' + re);
    const before = src.slice(Math.max(0, m.index - 1500), m.index);
    assert.ok(/confirm\(/.test(before) || /confirmBox/.test(before),
      file + ' 的 ' + re + ' 写操作前面必须有确认');
  }
});

// ── 117-8 卦序口径: 卦码 0-63 二进制序, 通行序 1-64 ────────────
test('117-8: 卦序口径 = 卦码 0-63 (二进制序) + 通行序 1-64', () => {
  const hx = read('views/hexagrams.mjs');
  assert.ok(hx.includes('g.index'), '六十四卦页必须摆 index (卦码 0-63)');
  assert.ok(hx.includes('g.id'), '六十四卦页必须摆 id (通行序 1-64)');
  assert.match(hx, /卦码[^\n]*?g\.index/, '六十四卦页必须标出「卦码」口径 (index 0-63)');
  assert.match(hx, /第[^\n]*?g\.id[^\n]*?卦/, '六十四卦页必须标出「第 N 卦」通行序 (id 1-64)');
});

// ── 117-9 设置页读的字段名必须跟后端真响应对得上 ──────────────────
test('117-9: 设置页读的字段名跟后端返回的对得上 (别静默读空)', () => {
  // api 方法 → 后端响应里的字段名。取值来自真实 curl, 不是猜的。
  // 踩过的坑: 凭证列表后端回 {ok, credentials}, 页面按 {ok, data} 读 ⇒ 永远显示「尚无凭证」。
  const FIELDS = {
    credentialsList: 'credentials',
    mcpServers: 'servers',
    modelsList: 'models',
    presetsList: 'presets',
    panguTools: 'tools',
    permissionGet: 'result',
    selfRepairGet: 'result',
    housekeepingStats: 'stats',
    voiceDevices: 'devices',
    voiceStatus: 'stt',
    subagentRoles: 'by_code',
    subagentRuns: 'by_code',
    config: 'data',
  };
  const pages = allFiles(path.join(APP, 'views', 'settings'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => [path.relative(APP, f), fs.readFileSync(f, 'utf8')]);
  let checked = 0;
  for (const [file, src] of pages) {
    for (const [method, field] of Object.entries(FIELDS)) {
      if (!src.includes('api.' + method + '(')) continue;
      checked++;
      assert.ok(new RegExp('\\.' + field + '\\b').test(src),
        file + ' 调了 api.' + method + '() 但没读响应里的 ' + field
        + ' 字段 —— 页面会静默显示空');
    }
  }
  assert.ok(checked >= 8, '字段契约只查了 ' + checked + ' 处, 覆盖太少');
});
