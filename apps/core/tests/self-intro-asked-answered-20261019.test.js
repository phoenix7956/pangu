'use strict';

// 2026-10-19: 问盘古「用两句话说明你是什么」, 它回
//   「本轮未形成与原问题匹配的可核验答案，请重试。」
//
// 真凶: answer_alignment.js 的两道门一起拦。
//   ① BROAD_SELF_REPORT —— 答案里出现 全面自画像 / 身份与底座 / 工具矩阵 /
//      子 agent 矩阵 / 架构 X 层 / 三层记忆 / 四层进化 / 源码地图 / 行为准则
//      → 判跑题。
//   ② 词法对齐 —— 「用两句话说明你是什么」和「我是盘古, 接入文件命令 MCP 工具」
//      一个共同词都没有, 重叠为 0, 同样判跑题。
//
// 这道守卫本来是拦「主人问 A, 盘古答一整篇自我介绍」的灌水
// (老板 2026-10-18 原话: 「这么大篇幅都在说计划、子agent, 用户会在乎吗」)。
// 方向没错, 但它只认「问题」不认「意图」: 主人**真的**问「你是什么」时,
// 盘古答自我介绍就是答案本身, 结果被自己说的话判成跑题, 整篇清空。
// 拿守卫挡交付 —— 用户看到的是「盘古不肯回答」。
//
// 修法: 单开一条「明确要求自我介绍」的判据, 只在用户真的问过时才生效。
// 守卫对**没问**的场景必须照咬, 否则就是把灌水放回来了。
//
// 2026-10-19 补测: 旧行为下这一问是**掷骰子**。上面三种答案(短的、带工具矩阵的、
// 带全面自画像的)实测**全部**被清空。线上之所以不是每次都失败, 是模型偶尔会
// 复述问题里的词("两句话" / "是什么"), 才侥幸过了 ②。所以老板看到的是时好时坏,
// 不是稳定复现 —— 这也是为什么只盯着触发词守卫会误判成「影响很小」。
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  isAligned,
  isSelfIntroAsk,
} = require(path.join(__dirname, '..', 'modules', 'answer_alignment.js'));

// 盘古真实的自我介绍长相 —— 必然带守卫认得的那些词
const SELF_REPORT = '盘古 (Pangu) 全面自画像\n1. 身份与底座：易经占问 agent\n2. 工具矩阵：文件/命令/网络\n3. 三层记忆：短期/长期/源码地图';

test('明确问「你是什么」→ 自我介绍是答案本身, 不能判跑题', async (t) => {
  assert.equal(isAligned('用两句话说明你是什么', '盘古是一个基于易经的占问 agent，八个将灵分工做事，回答先给结果再说原因。'), true);
  assert.equal(isAligned('你是什么', '盘古是本机的易经占问 agent，接得住取象、纳甲、八卦排盘这类问题。'), true);
  assert.equal(isAligned('介绍一下你自己', '盘古是易经占问 agent，先给结论再讲原因，答不上就直说答不上。'), true);
});

test('问的是自我介绍 → 那篇「全面自画像」也不能被自己的话判跑题', async (t) => {
  // 这是实际线上撞到的那一句。
  assert.equal(isAligned('用两句话说明你是什么', SELF_REPORT), true,
    '问的是自我介绍, 答自我介绍被清空 → 主人只看到「未形成可核验答案」');
  assert.equal(isAligned('介绍一下你自己', SELF_REPORT), true);
  assert.equal(isAligned('你能做什么', SELF_REPORT), true);
});

test('没问 → 灌水式自我介绍照样必须拦(这是守卫存在的全部理由)', async (t) => {
  // 这条锁的是回归: tests/answer-alignment.test.js:60 已经锁了「排盘页」那例,
  // 这里换几个问题再钉一遍, 免得有人为了修误杀把守卫整条删了。
  assert.equal(isAligned('排盘页面为什么没有详情', SELF_REPORT), false);
  assert.equal(isAligned('帮我检查 router 为什么会问非所答', SELF_REPORT), false);
  assert.equal(isAligned('1+1等于几', SELF_REPORT), false);
  assert.equal(isAligned('把 README 里的错别字改掉', SELF_REPORT), false);
});

test('没问 → 顺带把问题词复述一遍的自我介绍, 只有守卫拦得住(隔离用)', async (t) => {
  // 上一条其实是**冗余**的: 那些答案和问题的词一点不沾, 词法对齐门自己就拦住了,
  // 删掉 BROAD_SELF_REPORT 它照样是红的 —— 也就是说上一条根本没锁住这道守卫。
  //
  // 真实失效形态不是「答一篇跟问题毫无关系的自我介绍」(那种谁都拦得住),
  // 而是**顺带把问题里的词复述一遍**再灌水 —— 这时词法对齐完全通过,
  // 只有 BROAD_SELF_REPORT 能拦。删除这道守卫必须让下面这些变红。
  const echoReport = '排盘页面没有详情，是因为工具矩阵里缺了四柱渲染这一环，'
    + '架构 3 层设计和三层记忆链路都要过一遍。';
  assert.equal(isAligned('排盘页面为什么没有详情', echoReport), false,
    '答案把「排盘页面/详情」都复述了一遍, 词法对齐放行 —— 这时必须靠守卫拦住');

  const echoRouter = 'router 问非所答的根因在答案对齐层: 守卫只有一道，工具矩阵和三层记忆都可能漏。';
  assert.equal(isAligned('router 为什么会问非所答', echoRouter), false);

  // 再钉一遍: 同样的灌水, 但问题**确实**问了自我介绍 → 必须放行。
  // 答案得先真的在讲自己, 只是顺带复述了问题词。
  assert.equal(isAligned(
    '用两句话说明你是什么',
    '盘古是易经占问 agent，八个将灵分工。排盘页面没有详情，是因为工具矩阵里缺四柱渲染这一环。',
  ), true);
});

test('问的是自我介绍, 答的却不是自我介绍 → 仍然拦', async (t) => {
  // 放过归放过, 不能变成「问什么都算数」。
  assert.equal(isAligned('用两句话说明你是什么', '今天北京天气晴，适合出门'), false);
  assert.equal(isAligned('用两句话说明你是什么', '好的'), false);
  assert.equal(isAligned('用两句话说明你是什么', '2'), false);
});

test('「全面分析你自己」仍走源码取证那条路, 不走自我介绍豁免', async (t) => {
  // 全面扫描类问题要的是 file:line 证据, 不是一段自我介绍。
  assert.equal(isSelfIntroAsk('全面分析下你自己'), false);
  // 取自 tests/answer-alignment.test.js:52 的原答案 —— 源码取证要 ≥2 处 file:line。
  // 2026-10-25 (第 97 批): tools_schema.js 拆分后从 2379 行变 154 行 ⇒ 样本里的 :1564
  //   指向的行不再存在 ⇒ 「引用的行必须真实存在」判它 false。判据没动, 行号跟着真源走
  //   (工具数现在在门面的合并行 tools_schema.js:35)。
  assert.equal(isAligned('全面分析下你自己', '当前模型是 minimax-m3。真源：apps/core/config/nodes/example-node.json:12。工具数来自 apps/core/modules/tools_schema.js:35。'), true);
  // 只给一处证据不够 —— 豁免也不能把它放过去
  assert.equal(isAligned('全面分析下你自己', '当前模型是 minimax-m3。真源：apps/core/config/nodes/example-node.json:12。'), false);
  assert.equal(isAligned('全面分析下你自己', '主人说先 B 还是先 C？这是个具体事实题，立即动手。'), false);
});

test('别的问题里带「工具」也不能误判成自我介绍请求', async (t) => {
  assert.equal(isSelfIntroAsk('哪些工具调用失败了'), false);
  assert.equal(isSelfIntroAsk('什么是易经纳甲'), false);
  assert.equal(isSelfIntroAsk('帮我看看磁盘空间够不够'), false);
  assert.equal(isSelfIntroAsk('你说的那些工具是干什么的'), false);
});

