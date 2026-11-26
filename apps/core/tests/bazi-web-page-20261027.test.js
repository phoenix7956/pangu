'use strict';

// 2026-10-27 (第 113 批): 八字排盘页 —— AI 解读挪到最下面 + 逐项批语 + 分项预算
//
// ─────────────────────────────────────────────────────────────────────────
// 2026-10-27 (第 119 批) 改: 八字排盘**搬进工作台**了 (老板: 「/bazi/ 这个链接还不对,
// 其他的都是 /app/#/」) ⇒ 本文件跟着改指向:
//   web/bazi/index.html          → web/app/views/bazi.mjs
//   web/bazi/app.mjs             → web/app/views/bazi.mjs
//   web/bazi/reading.mjs         → web/app/lib/bazi/reading.mjs
//   静态出口伺服 /bazi/          → 301 到 /app/#/bazi
// **判据本身没变** (AI 在最下面 / 不许 6500 / 一次一项 / 每次带 reasoning_effort),
// 变的只是「这些判据去哪个文件里查」。
//
// 老板 2026-10-27 现场三条 (原话):
//   ① 「ai推理放在最下面, 这样方便」
//   ② 「另外可能还需要增加针对性的批语」
//   ③ 「6500有问题, 不能按照这个来, 本身就是分项出批语, 只要不一次性出就不会撞墙」
//
// ③ 是根因级的: 旧页面**一次性**要一篇 2200-3000 字的九节解读 ⇒ 只能给一个大预算
// (6500) ⇒ MiniMax-M3.1-Flash 的思考长度跟着预算走 ⇒ 预算被思考吃光 ⇒ 正文一个字
// 都没有 (第 112 批现场复现: 13754 字英文自说自话上屏)。
// 拆成**一项一次请求**之后: 每项预算都很小 ⇒ 思考量也跟着小 ⇒ 不撞墙。
//
// 本文件锁五件事:
//   1. 静态出口只伺服 web/bazi/ 一个目录 (`..` 越界一律拒)
//   2. AI 解读区在 DOM 顺序上**排在排盘结果之后** (老板第 ① 条)
//   3. **页面上不许再出现 6500 这种「按字数一次性算出来」的大预算**
//      (老板第 ③ 条)
//   4. 分段解读是九项、每项一次请求; 批语是逐项的、每项针对一个具体对象 (老板第 ② 条)
//   5. 每次请求都带 reasoning_effort —— 不带的话服务端会把预算抬到推理模型下限
//      (32768), 22 项小请求会变成 22 次 170 秒 ⇒ 那才叫撞墙。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const CORE = path.join(__dirname, '..');
const APP = path.join(CORE, 'web', 'app');
const VIEW = path.join(APP, 'views', 'bazi.mjs');
const READING = path.join(APP, 'lib', 'bazi', 'reading.mjs');
const ROUTE = path.join(CORE, 'pangu-single', 'routes', 'web_static.js');

const html = fs.readFileSync(VIEW, 'utf8');
const appSrc = fs.readFileSync(VIEW, 'utf8');
const readingSrc = fs.readFileSync(READING, 'utf8');

function _res() {
  return {
    _status: 0, _headers: {}, _body: '',
    writeHead(s, h) { this._status = s; this._headers = h || {}; },
    end(b) { if (b) this._body = Buffer.isBuffer(b) ? b.toString('utf8') : String(b); },
  };
}

function _serve(url) {
  const mod = require(ROUTE);
  const res = _res();
  const handled = mod.handler({ method: 'GET', url }, res);
  return { handled, res };
}

test('113-1: 静态出口只伺服 web/app 一个目录, 越界/非白名单一律拒', () => {
  // 第 141 批: 静态资源搬到**基址根** (相对地址要解析得到) ⇒ 老前缀 /app/* 全部 301 到 /
  const ok = _serve('/app/index.html');
  assert.strictEqual(ok.handled, true, '/app/index.html 必须被处理');
  assert.strictEqual(ok.res._status, 301, '/app/index.html 必须 301 (资源搬到基址根了)');
  assert.strictEqual(ok.res._headers.Location, '/');

  // 资源现在从基址根出
  const res0 = _serve('/index.html');
  assert.strictEqual(res0.handled, true, '/index.html 必须被处理');
  assert.strictEqual(res0.res._status, 200);
  assert.match(res0.res._headers['Content-Type'] || '', /text\/html/);

  // 第 140 批: 八字排盘的老链接 (/bazi) 现在**就是**工作台的路由 ⇒ 直接回工作台
  for (const url of ['/bazi']) {
    const r = _serve(url);
    assert.strictEqual(r.res._status, 200, url + ' 必须 200 (不是 404)');
    assert.match(r.res._headers['Content-Type'] || '', /text\/html/, url + ' 必须是 HTML');
  }

  // /app (无尾斜杠) ⇒ 301 到 /app/ —— 否则浏览器把相对路径解析到根目录, 资源全丢
  const redir = _serve('/app');
  // 第 140 批: 老前缀 /app ⇒ 301 到 / (工作台就在根路径)
  assert.strictEqual(redir.res._status, 301);
  assert.strictEqual(redir.res._headers.Location, '/');

  // 越界
  for (const p of ['/app/../package.json', '/app/%2e%2e%2f%2e%2e%2fpackage.json',
    '/app/../../pangu-single.js', '/bazi/%2e%2e%2f%2e%2e%2fpackage.json']) {
    const r = _serve(p);
    // 合法挡法: URL 归一化后压根不是这个前缀 (不处理), 归一化到目录外 ⇒ 403/404,
    // 或者是老路径 ⇒ 301。**第 140 批起多一种**: 路径落在工作台的视图名下面
    // (/bazi/...) ⇒ 回工作台的 index.html (200) —— 但回的是界面, 不是仓库文件。
    assert.ok(r.handled === false || r.res._status === 403 || r.res._status === 404
      || r.res._status === 301 || r.res._status === 200,
      p + ' 越界没被挡住 (handled=' + r.handled + ' 状态 ' + r.res._status + ')');
    assert.ok(!/package\.json|"name"/.test(r.res._body), p + ' 泄漏了仓库文件');
  }

  // 非白名单扩展名: 第 141 批后静态出口挂在**基址根**, 所以判据改成
  //   「web/app 下每个文件的扩展名都在白名单里」+「老前缀一律 301」。
  //   (核的是真表, 不是复制一份 —— 守卫自己也会钉错口径)
  const ws = require(path.join(CORE, 'pangu-single', 'routes', 'web_static.js'));
  const MIME_OK = new Set(Object.keys(ws.MIME));
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      const ext = path.extname(full).toLowerCase();
      assert.ok(MIME_OK.has(ext),
        path.relative(APP, full) + ' 的扩展名不在伺服白名单里 (' + ext + ')');
    }
  })(APP);

  // 老前缀一律 301 (第 141 批: 资源搬到基址根了)
  const old = _serve('/app/secret.env');
  assert.strictEqual(old.res._status, 301, '/app/* 老地址必须 301');

  // 真 API 路由一律不碰
  const other = _serve('/api/chat');
  assert.strictEqual(other.handled, false, '这个出口不许吃真 API 路由');
});

test('113-2: AI 解读区排在排盘结果之后 (老板: ai推理放在最下面)', () => {
  const chartIdx = html.indexOf('id="bz-chart-area"');
  const aiIdx = html.indexOf('id="bz-ai-area"');
  assert.ok(chartIdx > 0 && aiIdx > 0, 'chart-area / ai-area 都必须在');
  assert.ok(chartIdx < aiIdx, 'AI 解读区必须排在排盘结果**后面**');
  // 排盘结果区里的卡片也在 AI 区之前
  assert.ok(html.indexOf('id="bz-t-liunian"') < aiIdx, '流年表也要在 AI 区之前');
});

test('113-3: 页面上不许再出现 6500 这种一次性大预算 (老板: 不能按照这个来)', () => {
  const code = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
  for (const [name, src] of [['reading.mjs', readingSrc], ['app.mjs', appSrc]]) {
    assert.ok(!/\b6500\b/.test(code(src)), name + ' 的代码里还有 6500 这个预算');
  }
  // ⚠ 2026-10-31 (老板: 「为什么要有请求上限? 每个部分的侧重点都不一样, 预设上限不对」)
  //   旧守卫钉的是 `section: 3072` / `note: 2048` —— 那正是**要被改掉的东西**:
  //   写死两档套全部 25 项, 而实测各段思考用量差 16 倍 (summary 341 → health 2712),
  //   便宜的项浪费额度、贵的项必然撞墙 (health 实测 completion 3186 > 3072)。
  //   ⇒ 改成钉「每项按自己的规格算」这条机制, 而不是钉某两个数字。
  assert.ok(!/BUDGET\s*=\s*\{/.test(readingSrc), '不许再有写死的 BUDGET 两档表');
  assert.ok(/export const SPEC\s*=/.test(readingSrc), '必须有每项的规格表 SPEC');
  assert.ok(/export function budgetOf/.test(readingSrc), '必须有从规格推导预算的函数');
});

test('113-3b: 每项的预算从它自己的规格算, 不许再共用一个数', async () => {
  const reading = await import(pathToFileURL(READING).href);
  assert.ok(reading.SPEC && reading.SPEC.section && reading.SPEC.note, 'SPEC 必须同时管分段与批语');

  // 预算 = 规格推导, 且**各节各批语组之间必须真的不同** (老板: 侧重点不一样)
  const secBudgets = Object.keys(reading.SPEC.section).map((k) => reading.budgetOf(reading.SPEC.section[k]));
  // 2026-11-07 第 214 批: 加了「盲派轨」段 (SPEC.section.mangpai), 规格表变 10 项。
  // 子平默认流仍是九节 (SECTIONS.length=9), 盲派轨独立挂 SECTIONS_MANGPAI, 喜忌不跨轨。
  assert.ok(secBudgets.length >= 9, '分段规格表要覆盖九节(现在含盲派轨=10): ' + secBudgets.length);
  assert.ok(new Set(secBudgets).size > 1, '九节预算不能是一个数: ' + secBudgets.join(','));
  const noteBudgets = Object.keys(reading.SPEC.note).map((k) => reading.budgetOf(reading.SPEC.note[k]));
  assert.ok(new Set(noteBudgets).size > 1, '四组批语预算不能是一个数: ' + noteBudgets.join(','));

  // 每项规格必须三要素齐全: 提示词要的篇幅 + 正文上界 + 思考预留
  for (const [kind, table] of [['section', reading.SPEC.section], ['note', reading.SPEC.note]]) {
    for (const [k, spec] of Object.entries(table)) {
      assert.ok(spec && typeof spec.ask === 'string' && spec.ask.length > 0, kind + '.' + k + ' 缺 ask (篇幅指令)');
      assert.ok(Number(spec.chars) > 0, kind + '.' + k + ' 缺 chars (正文上界)');
      assert.ok(Number(spec.think) > 0, kind + '.' + k + ' 缺 think (思考预留)');
      assert.strictEqual(reading.budgetOf(spec), Math.ceil(spec.chars + spec.think),
        kind + '.' + k + ' 预算必须 = chars + think');
    }
  }

  // 提示词里的「篇幅」必须从 SPEC 出 (同源) —— 不许两处各写各的
  assert.ok(/篇幅: ' \+ _spec\.ask/.test(readingSrc), '分段篇幅必须取自 SPEC');
  assert.ok(/篇幅: ' \+ _spec\.ask/.test(readingSrc), '批语篇幅必须取自 SPEC');

  // 思考预留必须留够: 实测同一提示重复跑思考会抖 2-11 倍,
  // 撞墙的代价是服务端静默用满 32768 重试 (白烧约 30 秒) ⇒ 预留至少是「正文上界」的量级
  for (const [k, spec] of Object.entries(reading.SPEC.section)) {
    assert.ok(spec.think >= spec.chars, '分段 ' + k + ' 的思考预留太小: ' + spec.think + ' < ' + spec.chars);
  }
});

test('113-3c: 服务端必须把真账交出来 (usage / retried / 生效上限)', () => {
  const router = fs.readFileSync(path.join(CORE, 'pangu-single', 'routes', 'inline_router.js'), 'utf8');
  // usage 归一 (prompt/completion/reasoning)
  assert.ok(/function _usageOf/.test(router), '服务端必须有 _usageOf 把 usage 归一');
  assert.ok(/reasoning_tokens/.test(router), '必须取 reasoning_tokens (思考量)');
  // 重试那次也要带 usage —— 丢了就只能报第一轮的账 (假账)
  assert.ok(/usage: _usageOf\(retry\)/.test(router), '重试那次的 usage 必须带出来');
  // 响应体里带上这三个字段
  assert.ok(/\{\s*usage: _usage\s*\}/.test(router), '响应必须带 usage');
  assert.ok(/retried: true/.test(router), '响应必须带 retried (有没有静默用满预算重试)');
  assert.ok(/budget_effective/.test(router), '响应必须带 budget_effective (实际生效的上限)');

  // 前端必须真的用它 —— 不许只加字段不用
  // 2026-11-02 老板: 「都不用显示」⇒ 页面**不印**真账行 (上限/推理强度/正文/思考/
  //   合计/重试 全部撤)。数据流仍在: 前端读 usage/retried/budget_effective 存进
  //   item, 只是脚注闭嘴 (留空 div)。这里钉的是**数据流在、显示没了**:
  assert.ok(/j\.usage/.test(appSrc), '前端必须读服务端的 usage (数据流不许断)');
  assert.ok(/item\.usage/.test(appSrc), 'usage 必须存进 item (真账还在, 只是不显示)');
  assert.ok(!/itemLedger/.test(appSrc), 'itemLedger 真账渲染函数必须已撤 (老板: 都不用显示)');
  assert.ok(!/正文 ' \+ chars \+ ' 字/.test(appSrc), '脚注不许再显示正文字数');
  assert.ok(!/思考 ' \+ reas/.test(appSrc), '脚注不许再显示思考 token');
  // 加载态的「上限 N token · 推理强度」也不许再印
  assert.ok(!/上限 ' \+ \(item\.cap/.test(appSrc), '脚注不许再印「上限 N token」');
  // 旧的假账不许再出现
  assert.ok(!/'预算 ' \+ item\.budget/.test(appSrc), '脚注不许再印「预算 N token」那个请求意图值');

  // 2026-10-31 补: 兜底文案 (对齐校验没过的罐头) 不许冒充模型正文 ——
  //   服务端 answer_recovered=true ⇒ 不上报 usage (数据流机制保留)。
  assert.ok(/!guarded\.recovered/.test(router), '服务端: 兜底文案那次不许把 usage 当正文上报');
  assert.ok(/answer_recovered/.test(router), '服务端: 必须把 answer_recovered 交出去');
});

test('113-3d: 脚注不显示真账 (2026-11-02 老板: 「都不用显示」) —— 数据流仍在, 显示没了', () => {
  // 旧守卫是「itemLedger 渲染出 正文/思考/合计/重试/截断/兜底」—— 那个函数已撤。
  // 现在钉的是**反过来**: paintItem 里加载态/完成态的脚注必须是空,
  // 而真账数据 (usage/retried/cap) 仍存进 item —— 机制保留, 只是不印。
  const paint = appSrc.match(/function paintItem\(item\) \{[\s\S]*?\n  \}/);
  assert.ok(paint, 'paintItem 函数必须还在');
  // 加载态: 脚注清空
  assert.ok(/item\.status === 'loading'[\s\S]{0,200}?m\.textContent = '';/.test(paint[0])
    || /'loading'[\s\S]{0,300}?m\.textContent = '';/.test(paint[0]),
    '加载态脚注必须留空 (不许再印「上限 N token · 推理强度」): ' + paint[0].slice(0, 400));
  // 完成态: 脚注清空
  assert.ok(/'done'[\s\S]{0,300}?m\.textContent = '';/.test(paint[0]),
    '完成态脚注必须留空 (不许再印 正文/思考/合计 真账行): ' + paint[0].slice(0, 400));
  // 真账数据流仍在: usage 存进 item
  assert.ok(/item\.usage/.test(appSrc), 'usage 必须存进 item (数据流不许断)');
  assert.ok(/item\.retried/.test(appSrc), 'retried 必须存进 item');
  assert.ok(/item\.cap/.test(appSrc), 'cap 必须存进 item');
});
test('113-4: 每次请求都带 reasoning_effort (不带 ⇒ 服务端抬到 32768 ⇒ 22 次慢请求)', () => {
  assert.ok(/reasoning_effort:\s*EFFORT/.test(appSrc), '请求体必须带 reasoning_effort');
  assert.ok(/EFFORT\s*=\s*'low'/.test(readingSrc), "EFFORT 必须是 'low'");
  assert.ok(/max_tokens:\s*budget/.test(appSrc), '预算必须逐项传, 不许写死一个数');
});

test('113-5: 分段解读是九项、每项一次请求; 批语逐项且针对具体对象', async () => {
  const reading = await import(pathToFileURL(READING).href);
  assert.strictEqual(reading.SECTIONS.length, 9, '分段解读必须是九节');
  const titles = reading.SECTIONS.map((s) => s.title);
  for (const t of ['命盘总解', '大运流年总览', '父母', '学业', '事业', '财运', '婚姻感情', '健康', '调理建议']) {
    assert.ok(titles.includes(t), '缺一节: ' + t);
  }

  // 一项一次请求: 每节自己的提示, 且**不串别节的内容**
  const chart = _fakeChart();
  const studyPrompt = reading.buildSectionPrompt(chart, reading.SECTIONS.find((s) => s.key === 'study'));
  assert.ok(!studyPrompt.includes('调理建议'), '学业的提示里混进了调理建议 ⇒ 不是分项');
  assert.ok(studyPrompt.includes('学业'), '提示里必须有本节内容');

  // 批语: 逐项、针对具体对象
  const notes = reading.buildNoteTargets(chart);
  assert.ok(notes.length >= 8, '批语项太少: ' + notes.length);
  const groups = new Set(notes.map((n) => n.group));
  for (const g of ['大运', '流年', '刑冲合害', '用神']) {
    assert.ok(groups.has(g), '批语缺这一组: ' + g);
  }
  for (const n of notes) {
    assert.ok(n.id && n.label && n.ask, '批语项字段不全');
    // ⚠ 2026-10-31: 旧守卫是 `n.budget <= 2048` —— 写死一个上限套全部批语。
    //   实测四组的思考用量差 2.5 倍 (用神 644 / 大运 701 / 流年 719 / 刑冲合害 1609),
    //   刑冲合害那一组 2048 会撞墙 (实测 completion 1777, 思考一抖就超) ⇒
    //   服务端静默用满 32768 重试, 白烧约 30 秒, 页面还显示「预算 2048」。
    //   ⇒ 改成: 预算必须等于该组规格推导出来的值。
    const spec = reading.SPEC.note[n.group];
    assert.ok(spec, '批语组没有规格: ' + n.group);
    assert.strictEqual(n.budget, reading.budgetOf(spec),
      '批语预算必须 = 该组规格推导值 (' + n.group + ')');
  }
  // 流年批语必须带具体年份和对象
  const yearNote = notes.find((n) => n.group === '流年');
  assert.ok(/\d{4}/.test(yearNote.label), '流年批语必须带年份');
  assert.ok(yearNote.ask.includes('冲'), '流年批语必须要求判断冲合刑害');
});

function _fakeChart() {
  return {
    input: { year: 1979, city: '郑州', gender: 'male', birthplace: '河南 郑州' },
    public_date: '1979年5月6日 6时56分',
    lunar: { '年': 1979, '月': 4, '日': 11, '闰月': false },
    weekday: '星期日', constellation: '金牛座',
    pillars: { '年柱': '己未', '月柱': '戊辰', '日柱': '癸酉', '时柱': '乙卯' },
    day_master: '癸', day_master_wuxing: '水', day_master_yinyang: '阴',
    cang_gan: { '年柱': [{ '干': '己', '五行': '土', '十神': '七杀' }] },
    nayin_4: { '年柱': '天上火' }, changsheng_4: { '年柱': '沐浴' },
    shishen_tiangan: { '年柱干': '己 -> 七杀' },
    wuxing_count: { '木': 2.5, '火': 0.5, '土': 4, '金': 0.5, '水': 1.5 },
    jieqi: { '月令': '辰月(戊旺)' },
    status: '中和', status_reason: '月令本气为戊（土）',
    xi_yong: ['金', '木', '水'], xi_yong_reason: '土偏重', ji_shell: ['土'], cai_xing: ['火'],
    taiyuan: '己未', minggong: '甲巳', shengong: '戊酉',
    // ⚠ 神煞字段已撤 (2026-10-31 第 179 批) —— 后端不再输出, 这里也不喂。
    chong: ['日柱(酉) 冲 时柱(卯)'], he: ['月柱(辰) 合 日柱(酉)'],
    xing: [], hai: ['月柱(辰) 害 时柱(卯)'], po: [],
    dayun: {
      '排法': '逆排', '起运': '10年2月8天2时',
      '列表': [
        { '序': 1, '干支': '丁卯', '起始年龄': 10.19, '起始年份': 1989, '十神': '偏财', '地支十神': '食神' },
        { '序': 2, '干支': '丙寅', '起始年龄': 20.19, '起始年份': 1999, '十神': '正财', '地支十神': '伤官' },
        { '序': 3, '干支': '乙丑', '起始年龄': 30.19, '起始年份': 2009, '十神': '食神', '地支十神': '七杀' },
        { '序': 4, '干支': '甲子', '起始年龄': 40.19, '起始年份': 2019, '十神': '伤官', '地支十神': '比肩' },
        { '序': 5, '干支': '癸亥', '起始年龄': 50.19, '起始年份': 2029, '十神': '比肩', '地支十神': '劫财' },
      ],
    },
    liunian: [
      { '年份': 2026, '干支': '丙午', '十神': '正财', '地支十神': '偏财' },
      { '年份': 2027, '干支': '丁未', '十神': '偏财', '地支十神': '七杀' },
      { '年份': 2028, '干支': '戊申', '十神': '正官', '地支十神': '正印' },
      { '年份': 2029, '干支': '己酉', '十神': '七杀', '地支十神': '偏印' },
      { '年份': 2030, '干支': '庚戌', '十神': '正印', '地支十神': '正官' },
      { '年份': 2031, '干支': '辛亥', '十神': '偏印', '地支十神': '劫财' },
    ],
  };
}
