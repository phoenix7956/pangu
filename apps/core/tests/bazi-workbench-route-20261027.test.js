'use strict';

// 2026-10-27 (第 119 批): 八字排盘进工作台 —— 「/bazi/ 这个链接还不对」
//
// 老板原话: 「http://127.0.0.1:18901/bazi/ 这个链接还不对,
//            其他的都是 http://127.0.0.1:18901/app/#/」
//
// 2026-10-28 (第 140 批): 老板再问「**为什么非要带上 app? 或者 #?**」
//   ⇒ 地址里不要 `/app` 前缀, 不要 `#` 碎片: 工作台在 `/`, 页面是真路径 (`/bazi`)。
//   ⇒ 本文件的判据跟着换: 路由是 `/bazi` (不是 #/bazi), 老链接直接就是新地址。
//
// 本文件锁五件事:
//   1. 八字排盘是**工作台的真路由** (/bazi), 不是独立静态页
//   2. 老链接 (/bazi, /bazi/) 直接回工作台 (200), 不再 301 绕 /app/#/bazi
//   3. 独立静态页目录 web/bazi/ 已经没了 (不许两套并存)
//   4. 视图契约: render(root) + default render, DOM 查询不许出 root
//   5. 样式不许重定义工作台的全局变量名 (--card / --bg / --fg 这类)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const APP = path.join(CORE, 'web', 'app');

const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(APP, rel));

// 判据只看代码, 不看注释。理由: 注释里经常正写着「不许 xxx」, 全文匹配会咬自己一口。
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join('\n');

// ── 119-1 八字排盘在工作台里, 且是真路由 ───────────────────────
test('119-1: 八字排盘是工作台路由 /bazi', () => {
  const appSrc = read('app.mjs');
  assert.ok(appSrc.includes("bazi: () => import('./views/bazi.mjs')"),
    'app.mjs 的 VIEWS 必须注册 bazi ⇒ views/bazi.mjs');
  assert.match(appSrc, /bazi:\s*\['八字排盘'/, 'app.mjs 的 TITLES 必须有八字排盘');
  assert.ok(appSrc.includes("go: 'bazi'"),
    '令符里的「八字排盘」必须跳 bazi (第 141 批: 相对地址)');
  assert.ok(!/go: '#\//.test(appSrc),
    '令符里不许再留 # 碎片路由 (第 140 批: 地址就是路径)');

  const html = read('index.html');
  assert.ok(html.includes('data-view="bazi" href="bazi"'),
    '侧栏「八字排盘」必须指向 bazi (第 141 批: 相对地址)');
  assert.ok(!html.includes('href="#/'),
    '侧栏不许再有 # 碎片链接 (第 140 批)');
  // 页面链接不许带 /app 前缀 (第 140 批: 工作台就在 /; 第 141 批: 资源也搬到基址根)
  assert.ok(!/<a[^>]+href="\/app\//.test(html),
    '侧栏不许再带 /app 前缀 (第 140 批: 工作台就在 /)');
  assert.ok(!html.includes('href="/bazi/"'),
    '侧栏不许再指向独立静态页 /bazi/');

  assert.ok(!fs.existsSync(path.join(CORE, 'web', 'bazi')),
    '独立静态页目录 web/bazi/ 必须已删 —— 不许两套并存');
});

// ── 119-2 老链接 301 到新路由 (真跑 handler, 不是看源码) ────────
test('119-2: 老链接 /bazi 直接回工作台; /bazi/ 301 到无斜杠 (第 141 批: 相对解析要求单段)', () => {
  const webStatic = require(path.join(CORE, 'pangu-single', 'routes', 'web_static.js'));
  for (const url of ['/bazi']) {
    const seen = {};
    const res = {
      writeHead(code, headers) { seen.code = code; seen.headers = headers || {}; },
      end(body) { seen.ended = true; seen.body = body ? String(body) : ''; },
    };
    const handled = webStatic.handler({ method: 'GET', url }, res);
    assert.ok(handled, url + ' 必须被 web_static 处理');
    assert.strictEqual(seen.code, 200, url + ' 必须 200 (第 140 批: 老链接就是新地址)');
    assert.match(seen.headers['Content-Type'] || '', /text\/html/, url + ' 必须是 HTML');
  }

  // 第 141 批: 尾斜杠一律 301 到无斜杠 —— 页面在 /bazi/ 时, 相对资源路径
  //   会被浏览器解析成 /bazi/themes.css ⇒ 样式全丢。
  const slash = {};
  const resSlash = {
    writeHead(code, headers) { slash.code = code; slash.headers = headers || {}; },
    end() { slash.ended = true; },
  };
  webStatic.handler({ method: 'GET', url: '/bazi/' }, resSlash);
  assert.strictEqual(slash.code, 301, '/bazi/ 必须 301');
  assert.strictEqual(slash.headers.Location, '/bazi', '/bazi/ 必须指向 /bazi');

  // 老前缀 /app ⇒ 301 到 / (浏览器保留 fragment ⇒ 老书签 #/bazi 照样进)
  const seen = {};
  const res = {
    writeHead(code, headers) { seen.code = code; seen.headers = headers || {}; },
    end() { seen.ended = true; },
  };
  webStatic.handler({ method: 'GET', url: '/app/' }, res);
  assert.strictEqual(seen.code, 301, '/app/ 必须 301 搬家');
  assert.strictEqual(seen.headers.Location, '/', '/app/ 必须指向 /');
});

// ── 119-3 视图契约: render(root) / default render / DOM 不出 root ─
test('119-3: 八字视图守 render(root) 契约', () => {
  assert.ok(exists('views/bazi.mjs'), '缺 views/bazi.mjs');
  const src = read('views/bazi.mjs');
  assert.match(src, /export\s+(async\s+)?function\s+render\s*\(\s*root\s*\)/,
    '必须导出 render(root)');
  assert.match(src, /export\s+default\s+render/, '必须 default 导出同一个 render');
  assert.ok(src.includes("host.querySelector('#' + id)"),
    'DOM 查询必须在 root 内 —— 工作台是单页, 全局 id 会撞');
  assert.ok(!/document\.getElementById/.test(src),
    '不许用 document.getElementById —— 会撞工作台里别的视图');
  assert.ok(!/document\.querySelector/.test(src),
    '不许用 document.querySelector —— 必须限定在 root 内');

  // 事件监听挂在宿主节点上 (视图被替换时整棵树会没)
  assert.ok(src.includes("host.addEventListener('click'"),
    '事件委托必须挂宿主节点 —— 挂在被替换的节点上会漏');

  // API 走 lib/api.mjs, 不许裸 fetch
  assert.ok(src.includes("from '../lib/api.mjs'"), '必须从 lib/api.mjs 引 api');
  assert.ok(src.includes('api.toolTest('), '排盘必须走 api.toolTest');
  assert.ok(src.includes('api.chat('), 'AI 解读必须走 api.chat');
  assert.ok(!/\bfetch\s*\(/.test(src), '不许裸 fetch —— 端点清单不许自己发挥');
});

// ── 119-3b 不许清空 root (工作台的页标题挂在那儿) ────────────────
test('119-3b: 八字视图不许清空 root (会冲掉工作台的页标题)', () => {
  // 判据只看代码, 不看注释 —— 注释里正好写着「不许 root.innerHTML = ...」,
  // 直接全文匹配会**咬自己一口** (踩坑日志: 守卫自己也会钉错口径)。
  const src = stripComments(read('views/bazi.mjs'));
  // 其它视图全是 root.appendChild(host) —— 八字页原来一句 root.innerHTML = SKELETON
  // 把工作台加的 H1 标题 (八字排盘 + 副标题) 冲掉了, 页首一片空。
  assert.ok(!/root\.innerHTML\s*=/.test(src),
    '不许 root.innerHTML = ... —— 工作台的页标题就在 root 里, 会被冲掉');
  assert.ok(/root\.appendChild\(/.test(src),
    '必须 root.appendChild(host) —— 跟其它视图一个写法');
});

// ── 119-3c 起始是空表单 (老板: 进排盘页面应该是空的) ─────────────
test('119-3c: 起始是空表单 —— 不许硬编码别人的生辰, 不许自动排盘', () => {
  const src = read('views/bazi.mjs');
  const skel = src.slice(src.indexOf('const SKELETON'), src.indexOf('// ── 视图入口'));

  // ① 表单不许带默认出生信息 (通用工具 / 开源导出 不该替别人填某一个人的生辰)
  for (const [id, label] of [
    ['bz-f-year', '年'], ['bz-f-month', '月'], ['bz-f-day', '日'],
    ['bz-f-hour', '时'], ['bz-f-minute', '分'],
  ]) {
    const re = new RegExp('id="' + id + '"[^>]*value=');
    assert.ok(!re.test(skel), '出生' + label + '不许有默认值 (老板: 进页面应该是空的)');
  }
  // 判据只看代码 —— 注释里正好写着「原来这里写死了 … 河南/郑州」,
  // 全文匹配会**咬自己一口** (跟 119-3b 一个道理)。
  assert.ok(!/河南|郑州/.test(stripComments(src)), '不许硬编码某一个人的出生地');
  assert.ok(src.includes('请选择省份'), '省必须有一个「请选择省份」的空态');
  assert.ok(src.includes('请选择城市'), '市必须有一个「请选择城市」的空态');

  // ② 不许自动排盘 —— 空表单排不出盘, 自动调只会报错
  const render = src.slice(src.indexOf('export async function render'));
  assert.ok(!/doChart\(\);/.test(render),
    'render() 里不许自动调 doChart() —— 起始是空的, 要等用户填完点「排盘」');

  // ③ 排盘结果 / AI 区默认藏着, 排完才显示
  assert.ok(src.includes('id="bz-chart-area" hidden'),
    '排盘结果区初始应隐藏, 排完再显示');
  assert.ok(src.includes('id="bz-ai-area" hidden'),
    'AI 解读区初始应隐藏, 排完再显示');
});

// ── 119-3d 区县必填 + 直辖市的层级 ─────────────────────────────
// 2026-10-27 (第 120 批) 老板: 「选，不要填」—— 区县改成下拉, 不许自由文本。
test('119-3d: 区县必填 + 必须是下拉, 直辖市的第二层不许当市用', () => {
  const src = stripComments(read('views/bazi.mjs'));
  const regions = read('lib/bazi/regions.mjs');

  // ① 区县必填: 校验必须真的拦人
  assert.ok(/if\s*\(\s*!params\.district\s*\)/.test(src),
    '区县必须必填 —— 不许当选填 (老板: 「还有区县不是选填」)');
  assert.ok(/请选择区\/县/.test(src),
    '区县为空要给出人话提示');
  assert.ok(!/选填/.test(src),
    '区县不许标成「选填」');

  // ② 区县是**下拉**, 不是自由文本框 (老板: 「选，不要填」)
  // 第 148 批: 区县下拉被套上设计系统的 .pg-input 类 (外观归设计系统管),
 //   所以标签里 id 前面可能还有 class —— 只钉「它是 <select>」, 不钉属性顺序。
  assert.ok(/<select[^>]*id="bz-f-district"/.test(src),
    '区县必须是 <select> —— 不许再是 input[type=text]');
  assert.ok(!/id="bz-f-district"[^>]*type="text"/.test(src),
    '区县不许是自由文本框');
  assert.ok(/export const DISTRICTS/.test(regions),
    'regions.mjs 必须导出 DISTRICTS (省→市→区县)');
  assert.ok(/DISTRICTS\[prov\]\[cityName\]/.test(src),
    '区县下拉必须从 DISTRICTS 取选项');

  // ③ 直辖市(京沪津渝)的第二层本来就是区县 —— 下拉里只列它自己,
  //    否则真太阳时拿 city='东城' 查不到经度, 会静默退到东经 120 度。
  assert.ok(/MUNICIPALITIES\.includes\(prov\)\s*\?\s*\[prov\]/.test(src),
    '直辖市的「市」下拉只列它自己 (区县在下一层下拉里选)');
  assert.ok(/export const MUNICIPALITIES/.test(regions),
    'regions.mjs 必须导出 MUNICIPALITIES');
  for (const m of ['北京', '上海', '天津', '重庆']) {
    assert.ok(regions.includes("'" + m + "'"), 'MUNICIPALITIES 里必须有 ' + m);
  }

  // ④ 数据得是真的: 直辖市的区县得列出来, 别只有一个空壳
  assert.ok(/'河南': \[[^\]]*'郑州'/.test(regions),
    'PROVINCES 里河南得有郑州');
  assert.ok(/'河南': \{[\s\S]*?'郑州': \[[^\]]*'金水区'/.test(regions),
    'DISTRICTS 里河南/郑州 得列金水区');
  assert.ok(/'北京': \{[\s\S]*?'北京': \[[^\]]*'东城区'/.test(regions),
    'DISTRICTS 里北京得有它自己的区县');
});

// ── 119-4 AI 解读必须在页面最下面 (老板 2026-10-27 明确) ─────────
test('119-4: AI 解读区排在排盘结果之后 (在最下面)', () => {
  const src = read('views/bazi.mjs');
  const chartAt = src.indexOf('id="bz-chart-area"');
  const aiAt = src.indexOf('id="bz-ai-area"');
  assert.ok(chartAt > 0 && aiAt > 0, '排盘区与 AI 区都得在');
  assert.ok(aiAt > chartAt, 'AI 解读区必须在排盘结果**之后**');

  // 解读分项: 每项一次请求 + 小预算 + reasoning_effort, 不许回到 6500 一次性
  const reading = fs.readFileSync(path.join(APP, 'lib', 'bazi', 'reading.mjs'), 'utf8');
  // 2026-10-31: 写死的两档 BUDGET 表 (section 3072 / note 2048) 已换成
  // **每项按自己规格算上限** (SPEC + budgetOf, 数字来自 147 次生产提示实测)。
  // 119-4 钉的是机制「分项预算 + 不许 6500 一次性」, 不是那个写死表本身。
  assert.ok(/export const SPEC/.test(reading) && /export function budgetOf/.test(reading),
    'reading.mjs 必须有分项预算规格 (SPEC + budgetOf, 取代 2026-10-27 的写死 BUDGET 表)');
  assert.ok(/export const EFFORT/.test(reading), 'reading.mjs 必须有请求级推理强度');
  // 判据只看代码, 不看注释 (注释里可以写「不许再用 6500」这种提醒)
  assert.ok(!/\b6500\b/.test(stripComments(reading)), '不许再出现 6500 那种一次性大预算');
  assert.ok(!/\b6500\b/.test(stripComments(src)), '视图里也不许硬写 6500');
});

// ── 119-5 样式不许污染工作台的全局变量名 ───────────────────────
test('119-5: 八字样式不重定义工作台全局变量', () => {
  const css = fs.readFileSync(path.join(APP, 'views', 'bazi.css'), 'utf8');
  const html = read('index.html');
  assert.ok(html.includes('views/bazi.css'), 'index.html 必须引 bazi.css (第 141 批: 相对路径)');

  // 工作台自己占用的一级变量名 —— 八字样式不许再定义一遍
  const RESERVED = ['--card', '--background', '--foreground', '--border', '--primary',
    '--text', '--input', '--surface', '--muted', '--accent'];
  for (const name of RESERVED) {
    const re = new RegExp('(^|[\\s,{;])' + name + '\\s*:', 'm');
    assert.ok(!re.test(css), 'bazi.css 不许重定义 ' + name + ' —— 会把工作台整片染色');
  }

  // 类名一律带 bz- 前缀 (工作台壳里已经有 .hint / .spin / .seg 等同名类)
  const bare = [...css.matchAll(/(^|\})\s*\.([a-z][a-z0-9-]*)\s*[,{]/g)]
    .map((m) => m[2])
    .filter((c) => !c.startsWith('bz-'));
  assert.deepStrictEqual(bare, [], '八字样式有没带 bz- 前缀的类: ' + bare.join(', '));
});

// ── 119-6 零依赖零构建 (搬进工作台不许把旧毛病带进来) ──────────
test('119-6: 八字视图不许复活桌面端 / 引外部资源', () => {
  const files = [
    path.join(APP, 'views', 'bazi.mjs'),
    path.join(APP, 'lib', 'bazi', 'reading.mjs'),
    path.join(APP, 'lib', 'bazi', 'regions.mjs'),
    path.join(APP, 'lib', 'bazi', 'pillars.mjs'),
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(APP, f);
    assert.ok(!/from\s+['"]react/i.test(src), rel + ' 不许 import react');
    assert.ok(!/node_modules/.test(src), rel + ' 不许出现 node_modules');
    assert.ok(!/\/Users\/feng\//.test(src), rel + ' 不许出现本机绝对路径');
    for (const m of src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      assert.ok(
        spec.startsWith('./') || spec.startsWith('../'),
        rel + ' 出现裸 import: ' + spec
      );
    }
  }
});
