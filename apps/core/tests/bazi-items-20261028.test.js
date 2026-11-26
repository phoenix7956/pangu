// bazi-items-20261028.test.js — 第 129 批: 批命「做题」口径 + 绕路闸门 + 头部去重
//
// 事故背景 (2026-10-27 23:40, 会话 15567183):
//   老板发课件《排盘样例》图 +「做题，看清楚题目」。盘古把「分析出生地周围情况」
//   读成了「1975 年四川/成都的社会经济统计」—— 发 web_search + 派子 agent 去查
//   职工平均工资/城镇化率/人口总数, 子 agent 连着 6 次 web_fetch 30 秒超时,
//   整轮 4m49s 还在跑, 实际 10 分钟没结束。
//
// 本测试锁四件事:
//   ① 课件八条题目**原文** (老板课件上的黄底高亮, 一个字都不许改);
//   ② 「出生地周围情况」= 出生地地理环境(调候), 不是出生年代的社会经济统计;
//   ③ 绕路闸门: 现场那三条调用全被拦, 而正当问题**不被拦** (误伤防线同等重要);
//   ④ 注入块挂在路由快照之后 (挂前面会把纯文字命理题拽进 90 秒 dispatcher);
//      + 工作台头部不再重复渲染视图名。

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const CORE = path.join(__dirname, '..');
const M = (p) => require(path.join(CORE, p));
const bi = M('modules/bazi_items.js');

// ------------------------------------------------------------
// ① 课件八条题目原文 (照抄老板 2026-10-27 发的那张课件图)
// ------------------------------------------------------------
test('课件八条题目一个字都不许改', () => {
  assert.deepStrictEqual(
    bi.ITEMS.map((it) => it.title),
    [
      '分析出生地周围情况',
      '判断身强身弱',
      '取喜忌用神',
      '看原局天干<course-source>',
      '看身一体状况',
      '看财运',
      '看婚姻感情',
      '看大运流年',
    ]
  );
  for (const it of bi.ITEMS) {
    assert.ok(it.key && it.ask, '每条都要有 key 与答法口径: ' + it.title);
  }
});

test('「出生地周围情况」的口径 = 出生地地理环境/调候, 不是时代统计', () => {
  const item = bi.ITEMS.find((it) => it.key === 'surrounding');
  assert.ok(item, '第一条必须是「分析出生地周围情况」');
  assert.match(item.ask, /地理环境/);
  assert.match(item.ask, /调候/);
  assert.match(item.forbid, /\*\*不是\*\*出生年代的经济社会统计/);
  assert.match(item.forbid, /GDP/);
  // 注入块里必须把这条口径原样带到模型面前
  const block = bi.renderItemDiscipline();
  assert.match(block, /「分析出生地周围情况」= 出生地的\*\*地理环境\*\*/);
  assert.match(block, /不是\*\*出生年代的经济社会统计/);
  assert.match(block, /不许为它发 web_search/);
  assert.match(block, /不许派子 agent 去查/);
});

// ------------------------------------------------------------
// ② 做题题的判据 (正例 + 反例)
// ------------------------------------------------------------
test('做题题判据: 有图 + 做题 = 批命做题题; 卦味题不算', () => {
  assert.strictEqual(bi.detectItemTask('做题，看清楚题目', { hasImages: true }).matched, true);
  assert.strictEqual(bi.detectItemTask('批命', {}).matched, true);
  // 反例 (拦了就错)
  assert.strictEqual(bi.detectItemTask('起个卦看看', { hasImages: true }).matched, false);
  assert.strictEqual(bi.detectItemTask('算一卦', { hasImages: true }).matched, false);
  assert.strictEqual(bi.detectItemTask('帮我看下这个模块', { hasImages: true }).matched, false);
  assert.strictEqual(bi.detectItemTask('', { hasImages: true }).matched, false);
});

// ------------------------------------------------------------
// ③ 绕路闸门 — 现场那三条调用全被拦
// ------------------------------------------------------------
test('现场: 主 agent 那条 web_search 被拦 (本轮是批命做题题)', () => {
  const v = bi.inspectToolCall(
    'web_search',
    { q: '1975年四川省 国民经济总产值 人口 城镇职工平均工资 统计公报' },
    { itemTask: true }
  );
  assert.strictEqual(v.blocked, true, '必须拦: 这条搜索就是跑偏的那一步');
});

test('现场: 子 agent 的 web_fetch 被拦 (任务本身就是为命理报告查时代统计)', () => {
  const task = '查证「1975年（尤其中四川省/成都）居民家庭周边的实际生活环境」，'
    + '为一份1975年2月8日出生四川者的八字命理报告提供「出生地周围情况」一节的事实底座。'
    + '必须覆盖以下5条：1.气候地理特征 2.城镇人口比例(城镇化率) 3.职工平均工资';
  const v = bi.inspectToolCall('web_fetch', { url: 'https://www.stats.gov.cn/sj/ndsj/2023/indexch.htm' }, { turnText: task, assignment: true });
  assert.strictEqual(v.blocked, true, '必须拦: 子 agent 这 6 次 30 秒超时就是从这儿烧掉的');
});

test('现场: 主 agent 派的那一刀被拦', () => {
  const tasks = [{
    agent: 'li',
    task: '查证「1975年（尤集中四川省/成都）居民家庭周边的实际生活环境」，'
      + '为一份1975年2月8日出生四川者的八字命理报告提供「出生地周围情况」一节的事实底座。'
      + '必须覆盖以下5条：1.气候地理特征 2.城镇人口比例(城镇化率) 3.职工平均工资',
  }];
  const v = bi.inspectDispatchTasks(tasks, {});
  assert.strictEqual(v.blocked, true);
  assert.match(v.why, /口径错/);
});

test('批命做题题里不许派刀 (八条题用 bazi_calc 的盘面就能答)', () => {
  const v = bi.inspectDispatchTasks([{ agent: 'li', task: '整理一下排盘结果' }], { itemTask: true });
  assert.strictEqual(v.blocked, true);
});

// ------------------------------------------------------------
// ③-b 误伤防线: 正当问题一律放行 (同等重要)
// ------------------------------------------------------------
test('正当问题不被拦 (拦了就是误伤)', () => {
  // 纯经济问题: 没有命理语境, 不该拦
  assert.strictEqual(
    bi.inspectToolCall('web_search', { q: '1975年四川省GDP 是多少' }, {}).blocked, false
  );
  // 普通调研
  assert.strictEqual(
    bi.inspectToolCall('web_search', { q: 'node.js 22 release notes' }, {}).blocked, false
  );
  // 派活: 干正事的刀
  assert.strictEqual(
    bi.inspectDispatchTasks([{ agent: 'li', task: '读一下 config/node.json' }], {}).blocked, false
  );
  // exec_command 只是 grep, 不是去外网抓
  assert.strictEqual(
    bi.inspectToolCall('exec_command', { command: 'grep -r 八字 ~/notes.md' }, { itemTask: true }).blocked, false
  );
  // 主人自己的问句里带 GDP + 八字, 不是派下来的活 ⇒ 不许用「调研轮」那条判据拦
  assert.strictEqual(
    bi.inspectToolCall('web_search', { q: '1975年四川 GDP 八字' }, { turnText: '查一下1975年四川的GDP，顺便看看我八字', assignment: false }).blocked, false
  );
});

test('卦象题不吃排盘这套判据 (别把八条塞进卦题)', () => {
  // 现场原话就是「做题，看清楚题目」+ 图 ⇒ 必须是做题题
  assert.strictEqual(bi.detectItemTask('做题', { hasImages: true }).matched, true);
  assert.strictEqual(bi.detectItemTask('这卦怎么解', { hasImages: true }).matched, false);
  assert.strictEqual(bi.detectItemTask('这道卦的爻辞是什么', { hasImages: true }).matched, false);
});

// ------------------------------------------------------------
// ④ 注入位置 (挂前面会把纯文字命理题拽进 90 秒 dispatcher)
// ------------------------------------------------------------
test('注入块必须挂在路由快照之后 (DISPATCHER_KWS 里有 分析/天气/检查 等词)', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules/pangu_agent_stream.js'), 'utf8');
  // 2026-10-28 第 132 批: 快照契约收紧成「**任何注入之前**的主人原话」
  //   (`_rawUserText`), 不再是「挂行之前的 userInput」——
  //   后者已经带了服务端注入的【排盘事实】/【自查纪律】块, 事实块里的
  //   「禁止凭**记忆**另算十神」会命中 DISPATCHER_KWS 的 '记忆'
  //   ⇒ 第 2 轮起每轮都进 dispatcher (老板现场 5m02s)。
  const snapAt = src.indexOf('const _userInputForRouting = _rawUserText || userInput;');
  const injectAt = src.indexOf("require('./bazi_items')");
  assert.ok(snapAt > 0, '路由快照还在');
  assert.ok(injectAt > 0, '批命纪律注入还在');
  assert.ok(injectAt > snapAt, '纪律块必须挂在路由快照之后');
});

// ------------------------------------------------------------
// ⑤ 对齐门: 做题题改成覆盖检查 (词法门对"做题,看清楚题目"天生用不了)
// ------------------------------------------------------------
test('对齐门: 做题题按覆盖判, 覆盖够 = 对齐; 一个都不点 = 跑题', () => {
  const al = M('modules/answer_alignment.js');
  const good = '1. 分析出生地周围情况: 四川成都属四川盆地, 亚热带湿润气候, 春季多阴雨, 调候偏湿。'
    + '2. 判断身强身弱: 日主乙木, 寅月得令, 中和偏旺。3. 取喜忌用神: 喜木, 忌火土金。'
    + '4. 看原局天干<course-source>: 乙卯/戊寅/乙酉/辛巳, 寅巳刑, 卯酉冲。'
    + '5. 看身一体状况: 用神木得地, 身用相济。6. 看财运: 财星弱。7. 看婚姻感情: 日支酉为夫妻宫。'
    + '8. 看大运流年: 壬申大运, 25、26年流年。';
  assert.strictEqual(al.isAligned('做题，看清楚题目', good), true);
  const bad = '1975年四川的国民经济总产值与职工平均工资情况如下, 城镇化率约 12%。';
  assert.strictEqual(al.isAligned('做题，看清楚题目', bad), false);
});

// ------------------------------------------------------------
// ⑥ 工作台头部不再重复渲染视图名
// ------------------------------------------------------------
test('页面级标题不再重复顶栏的视图名 (老板圈的「头部重复」)', () => {
  const src = fs.readFileSync(path.join(CORE, 'web/app/app.mjs'), 'utf8');
  // 第 143 批: 副标题从**正文上方**搬进了**顶栏** (跟在标题后面) ——
  //   原来它在正文上方孤零零浮着一行灰字, 左沿还跟正文差 20px。
  //   判据跟着机制走: 正文里不再插标题块, 副标题挂在 #view-sub。
  assert.ok(src.indexOf("head.innerHTML = '<p>' + esc(sub) + '</p>';") < 0,
    '正文里不该再插一行孤零零的副标题 —— 它已经搬进顶栏了');
  assert.ok(src.indexOf("head.innerHTML = '<h1>' + esc(title)") < 0, '视图名不许在页面里再渲染一遍');
  assert.ok(!/el\('div',\s*\{\s*class:\s*'pangu-page-heading'\s*\}\)/.test(src),
    '应用层不该再往正文里插标题块');
  // 顶栏仍然是视图名的唯一出处
  assert.ok(src.indexOf("$('#view-title').textContent = title;") > 0, '顶栏照旧渲染视图名');
  assert.ok(src.indexOf("$('#view-sub')") > 0, '副标题必须挂在顶栏的 #view-sub 上');
});

