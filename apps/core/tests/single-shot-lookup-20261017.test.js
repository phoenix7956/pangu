'use strict';

// 2026-10-17: 单刀直查通道 —— 一件短事实查询不必先买整场编排。
//
// 现场 q-1792180668162 (「北京今天天气怎么样？需要真实数据，不要猜。」) 103.4s:
//   planner **自己**拆成两步:
//     s1 analyzer: 查询北京天气, 取可追溯数据
//     s2 checker:  「依据 analyzer 的汇报进行独立核验, 不重复开展天气搜索」
//   时间账 (llm-cost 行相加): planner 2.1s + analyzer 48.9s + checker 40.3s = 91.3s,
//   占全场 88%。checker 那 40.3s 花在"核验一次公开 API 查询"上 —— 同一个模型对同一份
//   数据的第二意见, 不是独立证据。
//
// 附带一个更刺眼的发现: **weather_check 只在 checker 白名单里**, 取数的 analyzer 没有,
// 于是它用 exec_command curl 了 6 次 wttr.in / open-meteo, 还对同一个输出文件换了
// 4 种 grep 反复扒 (每扒一次 = 一整轮 4~12s 推理)。没有专用工具 → 去 curl。
//
// 判据按**否定优先**设计: 认不准就老实走编排。宁可慢, 不给错答案 ——
// 老板明确要过拆刀能力 ("乾就应该把任务拆了, 分下去, 子agent只做自己相关的")。
// 漏判一个动词只损失速度; 误放行一个真任务会让它没人拆, 那才是事故。

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const { wantsSingleShotLookup, wantsDirectAnswer } = require(path.join(ROOT, 'modules', 'j2_loop_shared'));
// 剥卦块用**生产那一份**, 不在测试里重写一遍 —— 测试自己剥 = 测的是自己那份实现。
// 这个坑是 S1 撞出来的: 【盘古起卦…】的方括号只包第一行, 后面 ~150 字卦辞正文
// 留在外面, 自己拿 /【[^】]*】/ 剥 → 剥不干净 → 带卦块时闸门永远拦掉。
const { _stripGuaBlockForRouting, _singleShotTools } = require(path.join(ROOT, 'modules', 'j2_dispatcher'));
const subAgent = require(path.join(ROOT, 'agents', 'sub-agent.js'));
const DISP_SRC = fs.readFileSync(path.join(ROOT, 'modules', 'j2_dispatcher.js'), 'utf8');

// 2026-10-21: 卦块夹具改成**从生产格式化函数现取** (modules/gua_block.js = 唯一真源)。
// 原来手抄一份 —— 生产那份改了措辞, 手抄这份没跟上, 剥离认不出收尾 → 判据被残留顶爆。
const { formatGuaFirstBlock } = require(path.join(ROOT, 'modules', 'gua_block'));
const GUA = formatGuaFirstBlock({
  gua_name: '明夷', symbol: '䷣', upper_trigram: '坤', lower_trigram: '离',
  gua_ci: '明夷，利艰贞。', yao_name: '九三',
  moving_yao_ci: '九三：明夷于南狩，得其大首，不可疾贞',
  zhi_gua: { name: '复', symbol: '䷗', gua_ci: '复，亨。出入无疾，朋来无咎。反复其道，七日来复，利有攸往。' },
  wuxing: '土', yao_wuxing: '金', wuxing_rel: '土生金', liu_qin: '子孙', position_nature: '变机',
}).replace(/\n\n主人问题: $/, '\n');   // 去掉"主人问题:"标记 (留换行!) → 走"没标记"那条剥路径

test('S1 一件短事实查询命中单刀 —— 省掉 planner + checker 那 42s', () => {
  const cases = [
    ['北京今天天气怎么样？需要真实数据，不要猜。', '现场原题'],
    ['查一下英伟达现在的股价', '2026-10-17 现场同款'],
    ['现在几点'],
    ['今天日期是几号'],
    ['美元兑人民币汇率多少'],
  ];
  for (const [q, why] of cases) {
    assert.equal(wantsSingleShotLookup(q), true, `应命中单刀 (${why}): ${q}`);
    // 卦块拼在前面也一样 —— 长度按剥块后算, 否则 200 字卦块直接把它顶出闸门
    assert.equal(wantsSingleShotLookup(_stripGuaBlockForRouting(GUA + q)), true, `带卦块也应命中: ${q}`);
  }
});

test('S2 真任务一个都不许放行 —— 这条通道只能省时间, 不能改任务性质', () => {
  // 这批全部取自仓库里已有的现场用例 (direct-answer / task-split / planner-fast-path 测试),
  // 不是我编的句子。误放行其中任何一条 = 真任务没人拆 = 事故。
  const mustGoPlanner = [
    ['统计 ~/Desktop/pangu/apps/core/modules 下每个 .js 的行数', '多步 + 遍历'],
    ['帮我把这个 bug 修掉', '写类动词'],
    ['把这三个文件的内容读给我看', '文件 + 列举'],
    ['做一个 5 步计划并逐步执行：1) 列出所有 .js 文件；2) 统计行数；3) 找出超过 500 行的文件', '编号清单'],
    ['分别分析这三个文件, 每个文件给 3 个要点: 1) a.js 2) b.js 3) c.js', '并列独立'],
    ['查清楚盘古现在的模型池里有哪些模型, 各自的 provider 是什么、哪些是本地端点、哪些是云端, 以及当前默认用哪个', '长 + 并列'],
    ['北京天气怎么样, 然后顺便把上海和广州的也查一下', '多步 (然后)'],
    ['把 /tmp/out.txt 写进去然后读回来确认', '写 + 路径'],
    ['分析一下 qwen3.8 这个模型为什么慢, 和 numctx 有没有关系', '分析 + 项目自指'],
    ['帮我看看盘古这个项目的架构是怎么组织的', '项目自指'],
    ['在 /tmp/x 目录下创建 2 个文本文件: m.txt 和 n.txt。确保目录存在后再写入, 写完读回确认。', '创建 + 多步'],
  ];
  for (const [q, why] of mustGoPlanner) {
    assert.equal(wantsSingleShotLookup(q), false, `绝不能放行 (${why}): ${q}`);
    assert.equal(wantsSingleShotLookup(_stripGuaBlockForRouting(GUA + q)), false, `带卦块也不能放行 (${why}): ${q}`);
  }
});

test('S3 边界: 空/超长/无查询信号的一律不命中', () => {
  for (const v of ['', null, undefined, 0, {}]) {
    assert.equal(wantsSingleShotLookup(v), false, `空输入不命中: ${JSON.stringify(v)}`);
  }
  assert.equal(wantsSingleShotLookup('好'), false, '一个"好"字不是查询');
  // 剥块后仍要短 —— 卦块本身不算长度, 但主人真写的长句算
  const LONG_Q = '今天天气怎么样？请把过去一周每天的温度、湿度、风力、降水概率都列成一张表，并且和去年同期对比。';
  assert.equal(wantsSingleShotLookup(LONG_Q), false,
    '剥块后 50 字以上一律给 planner (长任务拆解质量值钱)');
});

test('S4 绝不与直答通道抢同一把钥匙 (两者语义相反)', () => {
  // 主人明说"别调工具" → 直答通道优先, 单刀通道必须让位。
  for (const q of ['只回答这两个，不要调用任何工具', '2+2 等于几？直接答。', '别调用工具，直接说结论']) {
    assert.equal(wantsDirectAnswer(q), true, `应是直答: ${q}`);
  }
  // 单刀触发的那一刀绝不能同时被判成直答 (判据里没有否定词, 结构上就不该重叠)
  assert.equal(wantsDirectAnswer('北京今天天气怎么样？需要真实数据，不要猜。'), false,
    '单刀查询不能被误判成直答 —— 那会让它"优先不调工具"变成零工具空答');
});

test('S5 接线: 单刀走 li + 补齐 weather_check, 且绝不复用 directAnswer 标志', () => {
  // 2026-10-19: 分支里的 `_singleShotTurn` 已改名 `_oneShotTurn` ——
  // 「单刀直查(查外部事实)」与「单目标阅读(读本地文件)」合流成同一条通道。
  // 两者运行语义完全相同(一个将灵 / 必须真调工具 / 不起 planner/checker/综合),
  // 分开只会让收口、门禁、图标各修一遍。**行为没变**, 只是变量名从一种触发变成两种触发的并集。
  const _oneShot = String.raw`_oneShotTurn`;
  // ① 单刀用 li (有 web_search / stock_*), 不是 kun —— kun 白名单
  //    没有 web_search, 走它就得 curl, 正是现场那 6 次 curl 的病根。
  assert.match(DISP_SRC, new RegExp(`const _daMode = ${_oneShot} \\? 'li' : 'kun';`),
    'S5: 单刀必须派 li (有 web_search/stock 工具), 直答才用 kun');

  // ② 必须补上 analyzer 够不着、只在 checker 白名单里的那几个查询工具
  assert.match(DISP_SRC, /'weather_check', 'news_digest', 'http_check'/,
    'S5: 单刀要补齐 weather_check/news_digest —— 现场 analyzer 够不着 weather_check 才去 curl 了 6 次');

  // ③ 最要害的一条: 不能传 directAnswer:true。
  //    那个标志在 sub-agent.js 注入"优先不调工具", 单刀查询要的恰恰是去取数 ——
  //    走错标志, 天气/股价会退化成 855fa63 修掉的那个"零工具空答"。
  assert.match(DISP_SRC, new RegExp(`directAnswer: !${_oneShot},`),
    'S5: 单刀必须 directAnswer:false (保留"必须调用工具"硬规则), 直答才 true');
  const daSrc = DISP_SRC.slice(DISP_SRC.indexOf('const _daMode ='), DISP_SRC.indexOf('const skipResult ='));
  assert.doesNotMatch(daSrc, /directAnswer:\s*true/,
    'S5: 单刀/直答共用块里不许出现无条件的 directAnswer:true');

  // ④ 两种触发都要真的进分支
  assert.match(DISP_SRC, new RegExp(`if \\(_directAnswerTurn \\|\\| ${_oneShot}\\)`),
    'S5: 单刀与直答并到同一条通道');
  // 2026-10-19: 现在是三条路 (single_shot / single_file / direct_answer)。
  // 现场复现靠这个字段分辨走了哪条 —— 它必须继续能分辨, 只是条数变了。
  assert.match(DISP_SRC, /mode: _singleTargetTurn \? 'single_file' : \(_oneShotTurn \? 'single_shot' : 'direct_answer'\)/,
    'S5: 运行模式要能分辨是哪条路 (现场复现要看这个字段)');

  // ⑤ 调用点必须传**剥过卦块**的 _routingInput, 不是原始 userInput。
  //    传错的话判据在生产里一次都不会命中 (卦块 200 字 > 闸门 50 字) —— 而且
  //    测试全绿, 因为测试传的是剥好的串。判据和调用点必须一起钉。
  assert.match(DISP_SRC, /wantsSingleShotLookup\(_routingInput\)/,
    'S5: 必须传 _routingInput (剥过卦块) —— 传原始 userInput 会因卦块 200 字 > 闸门 50 字而永不命中');
  assert.doesNotMatch(DISP_SRC, /wantsSingleShotLookup\(userInput\)/,
    'S5: 不许直接把带卦块的 userInput 喂给判据');
});

test('S6 长任务能力不许塌 —— 现场那道真任务必须照旧走编排', () => {
  // 2026-10-17 现场实测过的原题 (real_probe 用的就是它):
  const LONG_TASK = '查清楚盘古现在的模型池里有哪些模型, 各自的 provider 是什么、哪些是本地端点、'
    + '哪些是云端, 以及当前默认用哪个。读配置文件取证, 不要猜。最后给我一张表。';
  assert.equal(wantsSingleShotLookup(LONG_TASK), false,
    'S6: 真实长任务必须走 planner —— 这条通道只能给"一件短事实查询"用');
  assert.ok(LONG_TASK.length > 50, 'S6: 这道题本来就超长, 闸门第一道就该拦住');
});

test('S7 单刀白名单必须是**扁平**的工具名数组 —— 一个嵌套数组就把 21 个塌成 4 个', () => {
  const t = _singleShotTools(subAgent);

  // 这一条是被现场日志逼出来的: `[llm-cost] sub:analyzer tools=4` (应该 21)。
  // 根因是 `[ X || [] ]` 多包了一层方括号, new Set 的第一个元素成了数组本身,
  // 匹配不到任何工具名。天气那次是**碰巧**答对的 —— weather_check 恰好在那几个
  // 字符串里; 换成"查一下英伟达股价"就当场翻车, stock_* 全被挤掉。
  // 这种错字面量看着完全合理, 静态文本断言钉不住 → 只能把表达式本身跑起来看结果。
  assert.ok(Array.isArray(t), 'S7: 必须返回数组');
  for (const x of t) {
    assert.equal(typeof x, 'string',
      'S7: 白名单里混进了非字符串 (多半是嵌套数组): ' + JSON.stringify(x));
  }
  assert.strictEqual(new Set(t).size, t.length, 'S7: 不许有重复项');

  // 数量对得上: analyzer 职能白名单 + 补的 3 个
  const analyzerCount = (subAgent.ROLES.li.tools || []).length;
  assert.strictEqual(t.length, analyzerCount + 3,
    `S7: 应为 analyzer(${analyzerCount}) + weather_check/news_digest/http_check = ${analyzerCount + 3}, 实际 ${t.length}`);

  // 关键: 单刀要能查的那几类, 一个都不许缺 (少一个 = 那类问题当场翻车)
  for (const must of ['weather_check', 'news_digest', 'web_search', 'web_fetch',
    'stock_resolve', 'stock_quote', 'crypto_price', 'currency_check']) {
    assert.ok(t.includes(must), 'S7: 单刀白名单缺 ' + must + ' —— 那类查询会退化成"没有专用工具 → 去 curl"');
  }
});

